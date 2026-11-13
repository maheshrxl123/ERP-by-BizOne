import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import QRCode from 'qrcode';
import {
  amountInWordsINR,
  calculateBillPreview,
  roundHalfUp,
} from '../src/core/money.ts';
import {
  addDaysLocalIso,
  buildUpiDeepLink,
  todayLocalIso,
} from '../src/core/format.ts';
import { hasCapability } from '../src/core/permissions.ts';

dotenv.config();
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    const cur = process.env[k]?.trim() ?? '';
    if (cur.length < 2 && v) {
      process.env[k] = v;
    }
  }
}

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

const VALID_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]).toString('base64');

async function runAdminSql(query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  );
  if (!res.ok) {
    throw new Error(`Admin SQL failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

function collectLeafPaths(obj, prefix = '') {
  const paths = [];
  for (const [key, val] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      paths.push(...collectLeafPaths(val, next));
    } else {
      paths.push([next, String(val)]);
    }
  }
  return paths;
}

function sqlLiteral(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

test('Phase P4 unit checks: rounding, GST inclusive/exclusive, IGST/CGST/SGST, Bill of Supply, words, QR code, print CSS, permissions & Hindi parity', async () => {
  // 1. Half-away-from-zero decimal rounding matching PostgreSQL round(numeric, 2)
  assert.equal(roundHalfUp(0.005, 2), 0.01);
  assert.equal(roundHalfUp(1.005, 2), 1.01);
  assert.equal(roundHalfUp(242.245, 2), 242.25);
  assert.equal(roundHalfUp(-0, 2), 0);

  // 2. GST exclusive intrastate (CGST + SGST split with odd paise handling)
  const intraExcl = calculateBillPreview({
    gstRegistered: true,
    taxModuleEnabled: true,
    docType: 'tax_invoice',
    businessStateCode: '27',
    placeOfSupplyStateCode: '27',
    extraCharges: 10,
    autoRoundOff: true,
    lines: [
      {
        enteredQty: 1,
        unitPrice: 1,
        discountPct: 0,
        gstRate: 5,
        taxInclusive: false,
      },
    ],
  });
  assert.equal(intraExcl.gstApplied, true);
  assert.equal(intraExcl.isInterstate, false);
  assert.equal(intraExcl.lines[0].taxAmount, 0.05);
  assert.equal(intraExcl.lines[0].cgstAmount, 0.03);
  assert.equal(intraExcl.lines[0].sgstAmount, 0.02);
  assert.equal(intraExcl.lines[0].igstAmount, 0);
  assert.equal(intraExcl.taxTotal, 0.05);
  // preRound = 1 + 0.05 + 10 = 11.05 -> round(11.05, 0) = 11 -> roundOff = -0.05
  assert.equal(intraExcl.roundOff, -0.05);
  assert.equal(intraExcl.grandTotal, 11);

  // 3. GST inclusive back-calculation
  const incl = calculateBillPreview({
    gstRegistered: true,
    taxModuleEnabled: true,
    docType: 'tax_invoice',
    businessStateCode: '27',
    placeOfSupplyStateCode: '29',
    extraCharges: 0,
    autoRoundOff: false,
    lines: [
      {
        enteredQty: 2,
        unitPrice: 118,
        discountPct: 0,
        gstRate: 18,
        taxInclusive: true,
      },
    ],
  });
  assert.equal(incl.isInterstate, true);
  assert.equal(incl.subtotalTaxable, 200);
  assert.equal(incl.igstTotal, 36);
  assert.equal(incl.cgstTotal, 0);
  assert.equal(incl.sgstTotal, 0);
  assert.equal(incl.grandTotal, 236);

  // 4. Bill of Supply suppresses GST even if GST registered
  const bos = calculateBillPreview({
    gstRegistered: true,
    taxModuleEnabled: true,
    docType: 'bill_of_supply',
    businessStateCode: '27',
    placeOfSupplyStateCode: '29',
    extraCharges: 0,
    autoRoundOff: true,
    lines: [
      {
        enteredQty: 3,
        unitPrice: 100,
        discountPct: 10,
        gstRate: 18,
        taxInclusive: false,
      },
    ],
  });
  assert.equal(bos.gstApplied, false);
  assert.equal(bos.discountTotal, 30);
  assert.equal(bos.subtotalTaxable, 270);
  assert.equal(bos.taxTotal, 0);
  assert.equal(bos.grandTotal, 270);

  // 5. Indian currency in words
  assert.equal(amountInWordsINR(0), 'Zero Rupees Only');
  assert.equal(amountInWordsINR(1), 'One Rupee Only');
  assert.equal(
    amountInWordsINR(1500.5),
    'One Thousand Five Hundred Rupees and Fifty Paise Only'
  );
  assert.equal(
    amountInWordsINR(12500000),
    'One Crore Twenty Five Lakh Rupees Only'
  );

  // 6. UPI deep link + QR code PNG generation
  const deepLink = buildUpiDeepLink({
    upiId: 'sharma@okicici',
    businessName: 'Sharma Groceries',
    amount: 245.5,
    note: 'INV-2627-0001',
  });
  assert.ok(deepLink.startsWith('upi://pay?'));
  const qrDataUrl = await QRCode.toDataURL(deepLink, { width: 160, margin: 1 });
  assert.ok(qrDataUrl.startsWith('data:image/png;base64,'));

  // 7. Print layout CSS rules presence
  const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  assert.match(css, /@media\s+print/);
  assert.match(css, /\.print-surface/);
  assert.match(css, /\.print-layout-a5/);
  assert.match(css, /\.print-layout-thermal_80/);

  // 8. Role capability alignment
  assert.equal(hasCapability('owner', 'void_bill'), true);
  assert.equal(hasCapability('manager', 'override_price_discount'), true);
  assert.equal(hasCapability('cashier', 'override_price_discount'), false);
  assert.equal(hasCapability('cashier', 'sales_return'), true);
  assert.equal(hasCapability('cashier', 'void_bill'), false);
  assert.equal(hasCapability('storekeeper', 'create_bills'), false);

  // 9. EN / HI translation key parity for bills.* & glossary terms
  const en = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/en.json'), 'utf8')
  );
  const hi = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/hi.json'), 'utf8')
  );
  const enBills = new Map(collectLeafPaths(en.bills, 'bills'));
  const hiBills = new Map(collectLeafPaths(hi.bills, 'bills'));
  assert.equal(enBills.size, hiBills.size, 'bills EN/HI leaf key count must match');
  for (const [k] of enBills) {
    assert.ok(hiBills.has(k), `Missing Hindi key ${k}`);
    assert.ok(hiBills.get(k).trim().length > 0, `Empty Hindi key ${k}`);
  }
  assert.equal(hi.bills.newBill, 'नया बिल');
  assert.equal(hi.bills.quotation, 'कोटेशन');
  assert.equal(hi.bills.creditNote, 'क्रेडिट नोट');

  // 10. Audit regression: local date arithmetic across month/year boundaries & localized bill statuses
  assert.match(todayLocalIso(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(addDaysLocalIso('2026-03-31', 15), '2026-04-15');
  assert.equal(addDaysLocalIso('2026-12-30', 5), '2027-01-04');
  assert.equal(addDaysLocalIso('2026-02-28', 1), '2026-03-01');
  assert.equal(addDaysLocalIso('2024-02-28', 1), '2024-02-29');
  for (const st of [
    'draft',
    'issued',
    'converted',
    'voided',
    'paid',
    'partial',
    'unpaid',
    'credited',
  ]) {
    assert.ok(en.bills.statuses?.[st], `Missing EN status ${st}`);
    assert.ok(hi.bills.statuses?.[st], `Missing HI status ${st}`);
  }
  assert.ok(en.bills.partyPayModuleOff && hi.bills.partyPayModuleOff);
});

test('Phase P4 E2E: SQL/client parity, drafts, stock & Khata sync, immutability, quotations, returns, void, overrides, idempotency, UPI QR & share links', async () => {
  assert.ok(
    SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY,
    'Supabase environment variables must be configured'
  );
  assert.ok(
    ACCESS_TOKEN && PROJECT_REF,
    'SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF required'
  );

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stamp = Date.now();
  const password = 'BizOneP4!2026';
  const createdUserIds = [];
  const createdItemIds = [];
  const createdPartyIds = [];
  const createdBillIds = [];
  const createdFileIds = [];
  const uploadedStoragePaths = [];
  let createdWorkspaceTemp = false;
  let origBusinessSnapshot = null;
  let origNumberingSeries = [];
  let origModuleStates = [];

  const createTempUser = async (role, tag) => {
    const email = `p4.${tag}.${stamp}@example.com`;
    const { data: authData, error: authErr } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: `P4 ${tag}` },
      });
    assert.ifError(authErr);
    createdUserIds.push(authData.user.id);

    const { error: profErr } = await supabaseAdmin.from('profiles').insert({
      id: authData.user.id,
      full_name: `P4 ${tag}`,
      email,
      role,
      is_active: true,
    });
    assert.ifError(profErr);

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signData, error: signErr } =
      await client.auth.signInWithPassword({ email, password });
    assert.ifError(signErr);
    return {
      id: authData.user.id,
      email,
      client,
      accessToken: signData.session.access_token,
    };
  };

  try {
    // Preserve any existing real workspace ("Sharma Groceries") & counters cleanly
    const { data: existingBiz } = await supabaseAdmin
      .from('business')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (!existingBiz) {
      await supabaseAdmin.from('business').insert({
        id: 1,
        name: 'P4 Temp Test Business',
        pack: 'kirana',
        gst_registered: true,
        gstin: '27AAPFU0939F1ZV',
        state_code: '27',
        upi_id: 'p4temp@okicici',
      });
      createdWorkspaceTemp = true;
    } else {
      origBusinessSnapshot = existingBiz;
      const { data: seriesRows } = await supabaseAdmin
        .from('numbering_series')
        .select('*');
      origNumberingSeries = seriesRows ?? [];

      const { data: modRows } = await supabaseAdmin
        .from('modules_state')
        .select('*');
      origModuleStates = modRows ?? [];

      // Ensure GST + billing/parties/payments/inventory/tax modules active during test
      await supabaseAdmin
        .from('modules_state')
        .upsert([
          { module_key: 'billing', enabled: true },
          { module_key: 'parties', enabled: true },
          { module_key: 'payments', enabled: true },
          { module_key: 'inventory', enabled: true },
          { module_key: 'tax', enabled: true },
        ]);

      await supabaseAdmin
        .from('business')
        .update({
          gst_registered: true,
          state_code: '27',
          cashier_max_discount_pct: 10,
          allow_cashier_price_override: false,
        })
        .eq('id', 1);
    }

    const [owner, manager, cashier, storekeeper, viewer] = await Promise.all([
      createTempUser('owner', 'owner'),
      createTempUser('manager', 'mgr'),
      createTempUser('cashier', 'cash'),
      createTempUser('storekeeper', 'store'),
      createTempUser('viewer', 'view'),
    ]);

    // 1. SQL vs Client Parity across 4 modes (excl intra, incl intra, interstate, BOS)
    const parityCases = [
      {
        label: 'exclusive intrastate + discount + extra charges + rounding',
        gstRegistered: true,
        docType: 'tax_invoice',
        businessState: '27',
        posState: '27',
        extraCharges: 15.25,
        autoRoundOff: true,
        lines: [
          {
            enteredQty: 2,
            unitPrice: 123.45,
            discountPct: 5,
            gstRate: 18,
            taxInclusive: false,
          },
          {
            enteredQty: 3,
            unitPrice: 41.33,
            discountPct: 0,
            gstRate: 5,
            taxInclusive: false,
          },
        ],
      },
      {
        label: 'inclusive interstate IGST',
        gstRegistered: true,
        docType: 'tax_invoice',
        businessState: '27',
        posState: '29',
        extraCharges: 0,
        autoRoundOff: false,
        lines: [
          {
            enteredQty: 1.5,
            unitPrice: 118,
            discountPct: 10,
            gstRate: 18,
            taxInclusive: true,
          },
        ],
      },
      {
        label: 'bill of supply suppresses GST',
        gstRegistered: true,
        docType: 'bill_of_supply',
        businessState: '27',
        posState: '29',
        extraCharges: 0,
        autoRoundOff: true,
        lines: [
          {
            enteredQty: 4,
            unitPrice: 55.25,
            discountPct: 2.5,
            gstRate: 18,
            taxInclusive: false,
          },
        ],
      },
    ];

    for (const c of parityCases) {
      const clientRes = calculateBillPreview({
        gstRegistered: c.gstRegistered,
        taxModuleEnabled: true,
        docType: c.docType,
        businessStateCode: c.businessState,
        placeOfSupplyStateCode: c.posState,
        extraCharges: c.extraCharges,
        autoRoundOff: c.autoRoundOff,
        lines: c.lines,
      });
      const { data: sqlRes, error: sqlErr } = await owner.client.rpc(
        'compute_bill_amounts',
        {
          p_gst_registered: c.gstRegistered,
          p_doc_type: c.docType,
          p_is_interstate: c.businessState !== c.posState,
          p_extra_charges: c.extraCharges,
          p_auto_round_off: c.autoRoundOff,
          p_lines: c.lines.map((l) => ({
            entered_qty: l.enteredQty,
            unit_price: l.unitPrice,
            discount_pct: l.discountPct,
            gst_rate: l.gstRate,
            tax_inclusive: l.taxInclusive,
          })),
        }
      );
      assert.ifError(sqlErr);
      assert.equal(Number(sqlRes.subtotal_taxable), clientRes.subtotalTaxable, c.label);
      assert.equal(Number(sqlRes.discount_total), clientRes.discountTotal, c.label);
      assert.equal(Number(sqlRes.cgst_total), clientRes.cgstTotal, c.label);
      assert.equal(Number(sqlRes.sgst_total), clientRes.sgstTotal, c.label);
      assert.equal(Number(sqlRes.igst_total), clientRes.igstTotal, c.label);
      assert.equal(Number(sqlRes.tax_total), clientRes.taxTotal, c.label);
      assert.equal(Number(sqlRes.round_off), clientRes.roundOff, c.label);
      assert.equal(Number(sqlRes.grand_total), clientRes.grandTotal, c.label);
    }

    // 2. Setup units, items (with BOX=12 conversion + exclusive & inclusive items) & parties
    const { data: units } = await owner.client
      .from('item_units')
      .select('id, code');
    const pcsUnit = units.find((u) => u.code === 'PCS');
    const boxUnit = units.find((u) => u.code === 'BOX');
    assert.ok(pcsUnit && boxUnit);

    const { data: item1, error: item1Err } = await owner.client.rpc('save_item', {
      p_name: `P4 Masala Pack ${stamp}`,
      p_sku: `P4-MAS-${stamp}`,
      p_base_unit_id: pcsUnit.id,
      p_selling_price: 50,
      p_purchase_price: 35,
      p_gst_rate: 18,
      p_tax_inclusive: false,
      p_hsn_code: '0910',
      p_allow_negative_stock: false,
      p_opening_stock: 60,
      p_opening_unit_id: pcsUnit.id,
      p_conversions: [{ alternate_unit_id: boxUnit.id, conversion_factor: 12 }],
    });
    assert.ifError(item1Err);
    createdItemIds.push(item1.id);

    const { data: item2, error: item2Err } = await owner.client.rpc('save_item', {
      p_name: `P4 Biscuit Jar ${stamp}`,
      p_sku: `P4-BIS-${stamp}`,
      p_base_unit_id: pcsUnit.id,
      p_selling_price: 105,
      p_purchase_price: 80,
      p_gst_rate: 5,
      p_tax_inclusive: true,
      p_hsn_code: '1905',
      p_allow_negative_stock: false,
      p_opening_stock: 20,
      p_opening_unit_id: pcsUnit.id,
    });
    assert.ifError(item2Err);
    createdItemIds.push(item2.id);

    const { data: intraCust, error: p1Err } = await owner.client.rpc(
      'save_party',
      {
        p_party_id: null,
        p_name: `P4 Intra Customer ${stamp}`,
        p_party_type: 'customer',
        p_phone: '9876543210',
        p_gstin: '27AABCU9603R1ZM',
        p_credit_days: 15,
        p_addresses: [
          {
            label: 'Shop',
            address_line1: 'MG Road',
            city: 'Pune',
            state: 'Maharashtra',
            state_code: '27',
            is_default: true,
          },
        ],
      }
    );
    assert.ifError(p1Err);
    createdPartyIds.push(intraCust.id);

    const { data: interCust, error: p2Err } = await owner.client.rpc(
      'save_party',
      {
        p_party_id: null,
        p_name: `P4 Inter Customer ${stamp}`,
        p_party_type: 'customer',
        p_gstin: '29AABCU9603R1Z1',
        p_addresses: [
          {
            label: 'Branch',
            address_line1: 'Brigade Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            state_code: '29',
            is_default: true,
          },
        ],
      }
    );
    assert.ifError(p2Err);
    createdPartyIds.push(interCust.id);

    // 3. Draft lifecycle: save -> update -> delete, plus promote draft to issued
    const { data: draft1, error: dr1Err } = await cashier.client.rpc(
      'save_bill_draft',
      {
        p_doc_type: 'tax_invoice',
        p_party_id: intraCust.id,
        p_lines: [
          {
            item_id: item1.id,
            entered_qty: 2,
            entered_unit_id: pcsUnit.id,
            unit_price: 50,
            discount_pct: 0,
            tax_inclusive: false,
          },
        ],
      }
    );
    assert.ifError(dr1Err);
    assert.equal(draft1.status, 'draft');
    assert.equal(draft1.bill_number, null);

    const { data: deletedDraft } = await cashier.client.rpc(
      'delete_bill_draft',
      { p_bill_id: draft1.id }
    );
    assert.equal(deletedDraft, true);

    const { data: draft2 } = await cashier.client.rpc('save_bill_draft', {
      p_doc_type: 'tax_invoice',
      p_party_id: intraCust.id,
      p_lines: [
        {
          item_id: item1.id,
          entered_qty: 2,
          entered_unit_id: boxUnit.id,
          unit_price: 600,
          discount_pct: 0,
          tax_inclusive: false,
        },
      ],
    });
    createdBillIds.push(draft2.id);

    // 4. Issue invoice promoting draft2: 2 BOX = 24 PCS of item1 (@ ₹600/BOX + 18% GST = ₹1416), partial ₹500 cash
    const idempKey = `p4-bill-${stamp}`;
    const { data: inv1, error: inv1Err } = await cashier.client.rpc(
      'issue_bill',
      {
        p_draft_id: draft2.id,
        p_doc_type: 'tax_invoice',
        p_party_id: intraCust.id,
        p_auto_round_off: true,
        p_lines: [
          {
            item_id: item1.id,
            entered_qty: 2,
            entered_unit_id: boxUnit.id,
            unit_price: 600,
            discount_pct: 0,
            tax_inclusive: false,
          },
        ],
        p_paid_amount: 500,
        p_payment_mode: 'cash',
        p_idempotency_key: idempKey,
      }
    );
    assert.ifError(inv1Err);
    assert.equal(inv1.id, draft2.id);
    assert.equal(inv1.status, 'issued');
    assert.ok(inv1.bill_number && inv1.bill_number.length >= 6);
    assert.equal(Number(inv1.grand_total), 1416);
    assert.equal(Number(inv1.paid_amount), 500);
    assert.equal(Number(inv1.balance_due), 916);
    assert.equal(inv1.payment_status, 'partial');
    assert.equal(inv1.is_interstate, false);
    assert.equal(Number(inv1.cgst_total), 108);
    assert.equal(Number(inv1.sgst_total), 108);

    // Verify duplicate submit idempotency returns exact same bill and does NOT double deduct stock
    const { data: inv1Dup, error: dupErr } = await cashier.client.rpc(
      'issue_bill',
      {
        p_doc_type: 'tax_invoice',
        p_party_id: intraCust.id,
        p_lines: [
          {
            item_id: item1.id,
            entered_qty: 2,
            entered_unit_id: boxUnit.id,
            unit_price: 600,
            discount_pct: 0,
            tax_inclusive: false,
          },
        ],
        p_paid_amount: 500,
        p_payment_mode: 'cash',
        p_idempotency_key: idempKey,
      }
    );
    assert.ifError(dupErr);
    assert.equal(inv1Dup.id, inv1.id);
    assert.equal(inv1Dup.bill_number, inv1.bill_number);

    // Check stock deducted accurately: 60 - 24 = 36 PCS
    const { data: bal1 } = await owner.client
      .from('stock_balances')
      .select('qty_on_hand')
      .eq('item_id', item1.id)
      .single();
    assert.equal(Number(bal1.qty_on_hand), 36);

    // Negative stock rejection when selling 4 BOX (48 PCS > 36 PCS on hand)
    const { error: negStockErr } = await owner.client.rpc('issue_bill', {
      p_doc_type: 'tax_invoice',
      p_party_id: intraCust.id,
      p_lines: [
        {
          item_id: item1.id,
          entered_qty: 4,
          entered_unit_id: boxUnit.id,
          unit_price: 600,
          discount_pct: 0,
        },
      ],
      p_paid_amount: 0,
    });
    assert.ok(negStockErr, 'Selling beyond stock when negative stock disallowed must fail');

    // Check Khata & Open Obligations sync
    const { data: partyBal1, error: partyBalErr } = await owner.client
      .from('party_balances')
      .select('net_balance')
      .eq('party_id', intraCust.id)
      .single();
    assert.ifError(partyBalErr);
    assert.equal(Number(partyBal1.net_balance), 916);

    const { data: openObls } = await owner.client
      .from('party_open_obligations')
      .select('ledger_entry_id, remaining_amount')
      .eq('party_id', intraCust.id);
    assert.equal(openObls.length, 1);
    assert.equal(Number(openObls[0].remaining_amount), 916);

    // 5. Khata payment allocation sync & reversal against inv1
    const { data: extraPay, error: payErr } = await owner.client.rpc(
      'post_payment',
      {
        p_party_id: intraCust.id,
        p_direction: 'receive',
        p_amount: 916,
        p_mode: 'upi',
        p_allocations: [
          { ledger_entry_id: openObls[0].ledger_entry_id, amount: 916 },
        ],
        p_auto_allocate: false,
      }
    );
    assert.ifError(payErr);

    const { data: inv1Paid } = await owner.client
      .from('bills')
      .select('paid_amount, balance_due, payment_status')
      .eq('id', inv1.id)
      .single();
    assert.equal(Number(inv1Paid.paid_amount), 1416);
    assert.equal(Number(inv1Paid.balance_due), 0);
    assert.equal(inv1Paid.payment_status, 'paid');

    // Reverse that ₹916 Khata payment -> bill flips back cleanly to ₹500 paid, ₹916 due!
    const { error: revPayErr } = await owner.client.rpc('reverse_payment', {
      p_payment_id: extraPay.id,
      p_reason: 'UPI cheque bounced P4 test',
    });
    assert.ifError(revPayErr);

    const { data: inv1AfterRev } = await owner.client
      .from('bills')
      .select('paid_amount, balance_due, payment_status')
      .eq('id', inv1.id)
      .single();
    assert.equal(Number(inv1AfterRev.paid_amount), 500);
    assert.equal(Number(inv1AfterRev.balance_due), 916);
    assert.equal(inv1AfterRev.payment_status, 'partial');

    // 6. Immutability of issued bills & bill_lines
    const { error: mutBillErr } = await supabaseAdmin
      .from('bills')
      .update({ grand_total: 1 })
      .eq('id', inv1.id);
    assert.ok(mutBillErr, 'Direct SQL update to issued bill must fail');
    assert.match(mutBillErr.message, /immutable/i);

    const { data: inv1Lines } = await owner.client
      .from('bill_lines')
      .select('*')
      .eq('bill_id', inv1.id);
    assert.equal(inv1Lines.length, 1);

    const { error: mutLineErr } = await supabaseAdmin
      .from('bill_lines')
      .update({ unit_price: 1 })
      .eq('id', inv1Lines[0].id);
    assert.ok(mutLineErr, 'Direct SQL update to issued bill line must fail');

    // 7. Sales Return / Credit Note (return 1 BOX = 12 PCS -> ₹708 credit note)
    const { data: cn1, error: cnErr } = await cashier.client.rpc(
      'create_sales_return',
      {
        p_source_bill_id: inv1.id,
        p_lines: [{ source_bill_line_id: inv1Lines[0].id, entered_qty: 1 }],
        p_refund_amount: 0,
        p_reason: 'Customer returned 1 sealed box',
      }
    );
    assert.ifError(cnErr);
    createdBillIds.push(cn1.id);
    assert.equal(cn1.doc_type, 'credit_note');
    assert.equal(Number(cn1.grand_total), 708);

    // Stock restored +12 PCS (36 + 12 = 48 PCS)
    const { data: balAfterRet } = await owner.client
      .from('stock_balances')
      .select('qty_on_hand')
      .eq('item_id', item1.id)
      .single();
    assert.equal(Number(balAfterRet.qty_on_hand), 48);

    // Source invoice credited_amount = 708, balance_due = 1416 - 500 - 708 = 208
    const { data: inv1Credited } = await owner.client
      .from('bills')
      .select('credited_amount, balance_due')
      .eq('id', inv1.id)
      .single();
    assert.equal(Number(inv1Credited.credited_amount), 708);
    assert.equal(Number(inv1Credited.balance_due), 208);

    const { data: obAfterRet } = await owner.client
      .from('party_open_obligations')
      .select('remaining_amount')
      .eq('party_id', intraCust.id)
      .single();
    assert.equal(Number(obAfterRet.remaining_amount), 208);

    // Over-return (> remaining 1 BOX) rejected
    const { error: overRetErr } = await cashier.client.rpc(
      'create_sales_return',
      {
        p_source_bill_id: inv1.id,
        p_lines: [{ source_bill_line_id: inv1Lines[0].id, entered_qty: 1.5 }],
        p_reason: 'Over return attempt',
      }
    );
    assert.ok(overRetErr);
    assert.match(overRetErr.message, /exceeds returnable/i);

    // Voiding invoice with active credit notes or allocated payments rejected
    const { error: voidCnErr } = await owner.client.rpc('void_bill', {
      p_bill_id: inv1.id,
      p_reason: 'Should fail due to CN & payment',
    });
    assert.ok(voidCnErr);

    // 8. Quotation (zero stock/Khata side effects) & Conversion to Interstate Invoice
    const { data: quote1, error: qErr } = await cashier.client.rpc(
      'issue_bill',
      {
        p_doc_type: 'quotation',
        p_party_id: interCust.id,
        p_lines: [
          {
            item_id: item2.id,
            entered_qty: 2,
            entered_unit_id: pcsUnit.id,
            unit_price: 105,
            discount_pct: 0,
            tax_inclusive: true,
          },
        ],
      }
    );
    assert.ifError(qErr);
    createdBillIds.push(quote1.id);
    assert.equal(quote1.doc_type, 'quotation');
    assert.equal(quote1.status, 'issued');
    assert.equal(quote1.is_interstate, true);
    assert.equal(Number(quote1.igst_total), 10);
    assert.equal(Number(quote1.subtotal_taxable), 200);
    assert.equal(Number(quote1.grand_total), 210);

    // Stock of item2 unchanged at 20
    const { data: item2BalBefore } = await owner.client
      .from('stock_balances')
      .select('qty_on_hand')
      .eq('item_id', item2.id)
      .single();
    assert.equal(Number(item2BalBefore.qty_on_hand), 20);

    // Convert quotation -> invoice
    const { data: invFromQuote, error: convErr } = await cashier.client.rpc(
      'convert_quotation_to_bill',
      {
        p_quotation_id: quote1.id,
        p_paid_amount: 0,
      }
    );
    assert.ifError(convErr);
    createdBillIds.push(invFromQuote.id);
    assert.equal(invFromQuote.status, 'issued');
    assert.equal(invFromQuote.converted_from_quotation_id, quote1.id);

    const { data: quoteAfter } = await owner.client
      .from('bills')
      .select('status, converted_to_bill_id')
      .eq('id', quote1.id)
      .single();
    assert.equal(quoteAfter.status, 'converted');
    assert.equal(quoteAfter.converted_to_bill_id, invFromQuote.id);

    const { data: item2BalAfter } = await owner.client
      .from('stock_balances')
      .select('qty_on_hand')
      .eq('item_id', item2.id)
      .single();
    assert.equal(Number(item2BalAfter.qty_on_hand), 18);

    // 9. Voiding unpaid invoice restores stock + reverses Khata ledger; Cashier cannot void
    const { error: cashierVoidErr } = await cashier.client.rpc('void_bill', {
      p_bill_id: invFromQuote.id,
      p_reason: 'Cashier should not void',
    });
    assert.ok(cashierVoidErr);
    assert.match(cashierVoidErr.message, /Owner or Manager/i);

    const { data: voidedBill, error: mgrVoidErr } = await manager.client.rpc(
      'void_bill',
      {
        p_bill_id: invFromQuote.id,
        p_reason: 'Customer cancelled interstate order',
      }
    );
    assert.ifError(mgrVoidErr);
    assert.equal(voidedBill.status, 'voided');
    assert.equal(Number(voidedBill.balance_due), 0);

    const { data: item2BalRestored } = await owner.client
      .from('stock_balances')
      .select('qty_on_hand')
      .eq('item_id', item2.id)
      .single();
    assert.equal(Number(item2BalRestored.qty_on_hand), 20);

    // 10. Price & discount override limits (Cashier blocked, Manager succeeds)
    const { error: cashierPriceErr } = await cashier.client.rpc('issue_bill', {
      p_doc_type: 'tax_invoice',
      p_lines: [
        {
          item_id: item2.id,
          entered_qty: 1,
          entered_unit_id: pcsUnit.id,
          unit_price: 80,
          discount_pct: 0,
        },
      ],
      p_paid_amount: 80,
    });
    assert.ok(cashierPriceErr);
    assert.match(cashierPriceErr.message, /Owner or Manager/i);

    const { error: cashierDiscErr } = await cashier.client.rpc('issue_bill', {
      p_doc_type: 'tax_invoice',
      p_lines: [
        {
          item_id: item2.id,
          entered_qty: 1,
          entered_unit_id: pcsUnit.id,
          unit_price: 105,
          discount_pct: 25,
        },
      ],
      p_paid_amount: 79,
    });
    assert.ok(cashierDiscErr);
    assert.match(cashierDiscErr.message, /exceeds role limit/i);

    const { data: mgrOverrideBill, error: mgrOverErr } =
      await manager.client.rpc('issue_bill', {
        p_doc_type: 'bill_of_supply',
        p_lines: [
          {
            item_id: item2.id,
            entered_qty: 1,
            entered_unit_id: pcsUnit.id,
            unit_price: 90,
            discount_pct: 25,
          },
        ],
        p_paid_amount: 68,
      });
    assert.ifError(mgrOverErr);
    createdBillIds.push(mgrOverrideBill.id);
    assert.equal(Number(mgrOverrideBill.grand_total), 68);

    // Storekeeper / Viewer cannot read bill_list_view
    const { data: storeBills } = await storekeeper.client
      .from('bill_list_view')
      .select('id')
      .eq('id', inv1.id);
    assert.equal(storeBills.length, 0);

    const { data: viewerBills } = await viewer.client
      .from('bill_list_view')
      .select('id')
      .eq('id', inv1.id);
    assert.equal(viewerBills.length, 0);

    // 11. Upload UPI QR image + Share link API verification (sanitization, QR image signed URL, expiry, revocation, rate limit)
    const upRes = await fetch(`${BASE_URL}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.accessToken}`,
      },
      body: JSON.stringify({
        fileName: 'p4-test-upi-qr.png',
        mimeType: 'image/png',
        base64: VALID_PNG_BASE64,
        purpose: 'upi_qr',
        entityType: 'business',
        entityId: '1',
      }),
    });
    assert.equal(upRes.status, 201);
    const upPayload = await upRes.json();
    createdFileIds.push(upPayload.file.id);
    uploadedStoragePaths.push(upPayload.file.storage_path);

    // Attach UPI QR file to business & issue a fresh invoice whose snapshot captures it
    await supabaseAdmin
      .from('business')
      .update({
        upi_qr_file_id: upPayload.file.id,
        upi_id: 'p4share@okicici',
        show_upi_qr_on_invoice: true,
      })
      .eq('id', 1);

    const { data: qrBill, error: qrBillErr } = await owner.client.rpc(
      'issue_bill',
      {
        p_doc_type: 'tax_invoice',
        p_lines: [
          {
            item_id: item2.id,
            entered_qty: 1,
            entered_unit_id: pcsUnit.id,
            unit_price: 105,
            discount_pct: 0,
            tax_inclusive: true,
          },
        ],
        p_paid_amount: 105,
      }
    );
    assert.ifError(qrBillErr);
    createdBillIds.push(qrBill.id);

    const { data: shareLink, error: linkErr } = await owner.client.rpc(
      'create_bill_share_link',
      { p_bill_id: qrBill.id, p_expires_in_hours: 24 }
    );
    assert.ifError(linkErr);
    assert.ok(shareLink.token.length >= 24);

    // Public share link HTTP fetch (no auth header)
    const shareHttpRes = await fetch(
      `${BASE_URL}/api/share/bill/${shareLink.token}`,
      { headers: { 'x-forwarded-for': '203.0.113.10' } }
    );
    assert.equal(shareHttpRes.status, 200);
    const shareData = await shareHttpRes.json();
    assert.equal(shareData.bill.bill_number, qrBill.bill_number);
    assert.equal(shareData.lines.length, 1);
    assert.equal(shareData.assets.showUpiQr, true);
    assert.equal(shareData.assets.upiId, 'p4share@okicici');
    assert.ok(
      typeof shareData.assets.upiQrUrl === 'string' &&
        shareData.assets.upiQrUrl.startsWith('http')
    );
    // Security sanitization: internal cost & staff IDs omitted
    assert.equal(shareData.lines[0].purchase_price, undefined);
    assert.equal(shareData.lines[0].catalog_unit_price, undefined);
    assert.equal(shareData.bill.created_by, undefined);
    assert.equal(shareData.bill.issued_by, undefined);

    // Fetch the signed QR URL to verify storage asset resolves cleanly
    const qrAssetFetch = await fetch(shareData.assets.upiQrUrl);
    assert.equal(qrAssetFetch.status, 200);

    // View count incremented
    const { data: linkAfterView } = await owner.client
      .from('bill_share_links')
      .select('view_count')
      .eq('id', shareLink.id)
      .single();
    assert.equal(Number(linkAfterView.view_count), 1);

    // Invalid & non-existent tokens
    const badTokenRes = await fetch(`${BASE_URL}/api/share/bill/short`);
    assert.equal(badTokenRes.status, 400);
    const missingTokenRes = await fetch(
      `${BASE_URL}/api/share/bill/${'a'.repeat(48)}`
    );
    assert.equal(missingTokenRes.status, 404);

    // Expired share link returns 410
    await supabaseAdmin
      .from('bill_share_links')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', shareLink.id);
    const expRes = await fetch(
      `${BASE_URL}/api/share/bill/${shareLink.token}`,
      { headers: { 'x-forwarded-for': '203.0.113.11' } }
    );
    assert.equal(expRes.status, 410);

    // Fresh link + revocation -> returns 410
    const { data: shareLink2 } = await owner.client.rpc(
      'create_bill_share_link',
      { p_bill_id: qrBill.id, p_expires_in_hours: 24 }
    );
    const { error: revLinkErr } = await owner.client.rpc(
      'revoke_bill_share_link',
      { p_link_id: shareLink2.id }
    );
    assert.ifError(revLinkErr);
    const revRes = await fetch(
      `${BASE_URL}/api/share/bill/${shareLink2.token}`,
      { headers: { 'x-forwarded-for': '203.0.113.12' } }
    );
    assert.equal(revRes.status, 410);

    // Rate limit enforcement on public share endpoint (isolated synthetic client IP)
    const { data: shareLink3 } = await owner.client.rpc(
      'create_bill_share_link',
      { p_bill_id: qrBill.id, p_expires_in_hours: 24 }
    );
    let hit429 = false;
    for (let i = 0; i < 65; i += 1) {
      const rlRes = await fetch(
        `${BASE_URL}/api/share/bill/${shareLink3.token}`,
        { headers: { 'x-forwarded-for': '203.0.113.77' } }
      );
      if (rlRes.status === 429) {
        hit429 = true;
        break;
      }
    }
    assert.ok(hit429, 'Public share endpoint must rate-limit excessive requests (429)');

    // 12. Audit regression: convert_quotation_to_bill idempotent retry returns existing converted invoice
    const quoteConvIdemp = `p4-qconv-${stamp}`;
    const { data: quoteIdemp, error: qIdempErr } = await cashier.client.rpc(
      'issue_bill',
      {
        p_doc_type: 'quotation',
        p_party_id: intraCust.id,
        p_lines: [
          {
            item_id: item2.id,
            entered_qty: 1,
            entered_unit_id: pcsUnit.id,
            unit_price: 105,
            discount_pct: 0,
            tax_inclusive: true,
          },
        ],
      }
    );
    assert.ifError(qIdempErr);
    createdBillIds.push(quoteIdemp.id);

    const { data: convInv1, error: conv1Err } = await cashier.client.rpc(
      'convert_quotation_to_bill',
      {
        p_quotation_id: quoteIdemp.id,
        p_paid_amount: 0,
        p_idempotency_key: quoteConvIdemp,
      }
    );
    assert.ifError(conv1Err);
    createdBillIds.push(convInv1.id);

    const { data: convInv2, error: conv2Err } = await cashier.client.rpc(
      'convert_quotation_to_bill',
      {
        p_quotation_id: quoteIdemp.id,
        p_paid_amount: 0,
        p_idempotency_key: quoteConvIdemp,
      }
    );
    assert.ifError(conv2Err);
    assert.equal(convInv2.id, convInv1.id);
    assert.equal(convInv2.bill_number, convInv1.bill_number);

    // 13. Audit regression: sales return with partial cash refund reconciles bill, obligation & Khata balance
    const { data: partyBalBeforeRet } = await owner.client
      .from('party_balances')
      .select('net_balance')
      .eq('party_id', intraCust.id)
      .single();

    const { data: retInv, error: retInvErr } = await owner.client.rpc(
      'issue_bill',
      {
        p_doc_type: 'tax_invoice',
        p_party_id: intraCust.id,
        p_lines: [
          {
            item_id: item2.id,
            entered_qty: 2,
            entered_unit_id: pcsUnit.id,
            unit_price: 105,
            discount_pct: 0,
            tax_inclusive: true,
          },
        ],
        p_paid_amount: 0,
      }
    );
    assert.ifError(retInvErr);
    createdBillIds.push(retInv.id);
    assert.equal(Number(retInv.grand_total), 210);
    assert.equal(Number(retInv.balance_due), 210);

    const { data: retInvLines } = await owner.client
      .from('bill_lines')
      .select('id')
      .eq('bill_id', retInv.id);

    const { data: cnRefund, error: cnRefundErr } = await owner.client.rpc(
      'create_sales_return',
      {
        p_source_bill_id: retInv.id,
        p_lines: [{ source_bill_line_id: retInvLines[0].id, entered_qty: 2 }],
        p_refund_amount: 100,
        p_refund_mode: 'cash',
        p_reason: 'Full return with ₹100 cash refund + ₹110 Khata credit',
      }
    );
    assert.ifError(cnRefundErr);
    createdBillIds.push(cnRefund.id);
    assert.equal(Number(cnRefund.grand_total), 210);
    assert.equal(Number(cnRefund.paid_amount), 100);

    const { data: retInvAfter } = await owner.client
      .from('bills')
      .select('credited_amount, balance_due, payment_status')
      .eq('id', retInv.id)
      .single();
    assert.equal(Number(retInvAfter.credited_amount), 110);
    assert.equal(Number(retInvAfter.balance_due), 100);
    assert.equal(retInvAfter.payment_status, 'partial');

    const { data: retObAfter } = await owner.client
      .from('party_open_obligations')
      .select('remaining_amount')
      .eq('party_id', intraCust.id)
      .eq('reference_no', retInv.bill_number)
      .single();
    assert.equal(Number(retObAfter.remaining_amount), 100);

    const { data: partyBalAfterRet } = await owner.client
      .from('party_balances')
      .select('net_balance')
      .eq('party_id', intraCust.id)
      .single();
    assert.equal(
      Number(partyBalAfterRet.net_balance),
      Number(partyBalBeforeRet.net_balance) + 100
    );

    // 14. Audit regression: voided invoice & credit_note share links suppress UPI QR & expose void_reason / breakdown
    const { data: voidShareBill, error: vsbErr } = await owner.client.rpc(
      'issue_bill',
      {
        p_doc_type: 'tax_invoice',
        p_party_id: intraCust.id,
        p_lines: [
          {
            item_id: item2.id,
            entered_qty: 1,
            entered_unit_id: pcsUnit.id,
            unit_price: 105,
            discount_pct: 0,
            tax_inclusive: true,
          },
        ],
        p_paid_amount: 0,
      }
    );
    assert.ifError(vsbErr);
    createdBillIds.push(voidShareBill.id);

    const { error: voidReasonErr } = await owner.client.rpc('void_bill', {
      p_bill_id: voidShareBill.id,
      p_reason: 'Duplicate bill audit check',
    });
    assert.ifError(voidReasonErr);

    const { data: voidShareLink, error: vslErr } = await owner.client.rpc(
      'create_bill_share_link',
      { p_bill_id: voidShareBill.id, p_expires_in_hours: 24 }
    );
    assert.ifError(vslErr);

    const voidShareRes = await fetch(
      `${BASE_URL}/api/share/bill/${voidShareLink.token}`,
      { headers: { 'x-forwarded-for': '203.0.113.21' } }
    );
    assert.equal(voidShareRes.status, 200);
    const voidShareJson = await voidShareRes.json();
    assert.equal(voidShareJson.bill.status, 'voided');
    assert.equal(
      voidShareJson.bill.void_reason,
      'Duplicate bill audit check'
    );
    assert.ok(voidShareJson.bill.paid_amount !== undefined);
    assert.ok(voidShareJson.bill.credited_amount !== undefined);
    assert.ok(voidShareJson.bill.discount_total !== undefined);
    assert.equal(voidShareJson.assets.showUpiQr, false);
    assert.equal(voidShareJson.assets.upiQrUrl, null);
    assert.equal(voidShareJson.assets.upiId, null);

    const { data: cnShareLink, error: cslErr } = await owner.client.rpc(
      'create_bill_share_link',
      { p_bill_id: cn1.id, p_expires_in_hours: 24 }
    );
    assert.ifError(cslErr);

    const cnShareRes = await fetch(
      `${BASE_URL}/api/share/bill/${cnShareLink.token}`,
      { headers: { 'x-forwarded-for': '203.0.113.22' } }
    );
    assert.equal(cnShareRes.status, 200);
    const cnShareJson = await cnShareRes.json();
    assert.equal(cnShareJson.bill.doc_type, 'credit_note');
    assert.equal(cnShareJson.assets.showUpiQr, false);
    assert.equal(cnShareJson.assets.upiQrUrl, null);

    // 15. Audit regression: issue_bill blocks party payment when payments module is disabled
    try {
      await supabaseAdmin
        .from('modules_state')
        .upsert([{ module_key: 'payments', enabled: false }]);

      const { error: payOffErr } = await owner.client.rpc('issue_bill', {
        p_doc_type: 'tax_invoice',
        p_party_id: intraCust.id,
        p_lines: [
          {
            item_id: item2.id,
            entered_qty: 1,
            entered_unit_id: pcsUnit.id,
            unit_price: 105,
            discount_pct: 0,
            tax_inclusive: true,
          },
        ],
        p_paid_amount: 50,
        p_payment_mode: 'cash',
      });
      assert.ok(payOffErr, 'Party bill with paid > 0 must fail when payments disabled');
      assert.match(payOffErr.message, /payments module must be enabled/i);

      const { data: creditOnlyBill, error: coErr } = await owner.client.rpc(
        'issue_bill',
        {
          p_doc_type: 'tax_invoice',
          p_party_id: intraCust.id,
          p_lines: [
            {
              item_id: item2.id,
              entered_qty: 1,
              entered_unit_id: pcsUnit.id,
              unit_price: 105,
              discount_pct: 0,
              tax_inclusive: true,
            },
          ],
          p_paid_amount: 0,
        }
      );
      assert.ifError(coErr);
      createdBillIds.push(creditOnlyBill.id);
      assert.equal(Number(creditOnlyBill.balance_due), 105);
    } finally {
      await supabaseAdmin
        .from('modules_state')
        .upsert([{ module_key: 'payments', enabled: true }]);
    }
  } finally {
    // Thorough cleanup preserving pre-existing "Sharma Groceries" workspace & counters
    if (createdBillIds.length > 0) {
      const billIdList = createdBillIds.map((id) => `'${id}'`).join(',');
      await runAdminSql(
        `ALTER TABLE public.bills DISABLE TRIGGER trg_guard_bills_immutable;
         ALTER TABLE public.bill_lines DISABLE TRIGGER trg_guard_bill_lines_immutable;
         ALTER TABLE public.party_ledger_entries DISABLE TRIGGER trg_guard_ledger_immutable;
         ALTER TABLE public.payment_allocations DISABLE TRIGGER trg_guard_payment_alloc_immutable;
         ALTER TABLE public.payments DISABLE TRIGGER trg_guard_payment_immutable;
         ALTER TABLE public.stock_ledger DISABLE TRIGGER trg_stock_ledger_immutable;

         DELETE FROM public.bill_share_links WHERE bill_id IN (${billIdList});
         DELETE FROM public.payment_allocations WHERE ledger_entry_id IN (
           SELECT id FROM public.party_ledger_entries WHERE source_table = 'bills' AND source_id IN (${billIdList})
         );
         DELETE FROM public.party_ledger_entries WHERE source_table = 'bills' AND source_id IN (${billIdList});
         DELETE FROM public.stock_ledger WHERE source_table = 'bills' AND source_id IN (${billIdList});
         DELETE FROM public.bill_lines WHERE bill_id IN (${billIdList});
         UPDATE public.bills SET source_bill_id = NULL, converted_from_quotation_id = NULL, converted_to_bill_id = NULL WHERE id IN (${billIdList});
         DELETE FROM public.bills WHERE id IN (${billIdList});

         ALTER TABLE public.bills ENABLE TRIGGER trg_guard_bills_immutable;
         ALTER TABLE public.bill_lines ENABLE TRIGGER trg_guard_bill_lines_immutable;
         ALTER TABLE public.party_ledger_entries ENABLE TRIGGER trg_guard_ledger_immutable;
         ALTER TABLE public.payment_allocations ENABLE TRIGGER trg_guard_payment_alloc_immutable;
         ALTER TABLE public.payments ENABLE TRIGGER trg_guard_payment_immutable;
         ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_stock_ledger_immutable;`
      ).catch((err) => console.error('[P4 bill cleanup error]', err));
    }

    if (createdPartyIds.length > 0) {
      const pIdList = createdPartyIds.map((id) => `'${id}'`).join(',');
      await runAdminSql(
        `ALTER TABLE public.party_ledger_entries DISABLE TRIGGER trg_guard_ledger_immutable;
         ALTER TABLE public.payment_allocations DISABLE TRIGGER trg_guard_payment_alloc_immutable;
         ALTER TABLE public.payments DISABLE TRIGGER trg_guard_payment_immutable;

         DELETE FROM public.payment_allocations WHERE party_id IN (${pIdList});
         DELETE FROM public.party_ledger_entries WHERE party_id IN (${pIdList});
         DELETE FROM public.payments WHERE party_id IN (${pIdList});
         DELETE FROM public.party_addresses WHERE party_id IN (${pIdList});
         DELETE FROM public.parties WHERE id IN (${pIdList});

         ALTER TABLE public.party_ledger_entries ENABLE TRIGGER trg_guard_ledger_immutable;
         ALTER TABLE public.payment_allocations ENABLE TRIGGER trg_guard_payment_alloc_immutable;
         ALTER TABLE public.payments ENABLE TRIGGER trg_guard_payment_immutable;`
      ).catch((err) => console.error('[P4 party cleanup error]', err));
    }

    if (createdItemIds.length > 0) {
      const iIdList = createdItemIds.map((id) => `'${id}'`).join(',');
      await runAdminSql(
        `ALTER TABLE public.stock_ledger DISABLE TRIGGER trg_stock_ledger_immutable;
         DELETE FROM public.stock_ledger WHERE item_id IN (${iIdList});
         ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_stock_ledger_immutable;
         DELETE FROM public.stock_balances WHERE item_id IN (${iIdList});
         DELETE FROM public.unit_conversions WHERE item_id IN (${iIdList});
         DELETE FROM public.items WHERE id IN (${iIdList});`
      ).catch(() => undefined);
    }

    if (origBusinessSnapshot) {
      await runAdminSql(
        `UPDATE public.business SET
          gst_registered = ${sqlLiteral(origBusinessSnapshot.gst_registered)},
          state_code = ${sqlLiteral(origBusinessSnapshot.state_code)},
          upi_id = ${sqlLiteral(origBusinessSnapshot.upi_id)},
          upi_qr_file_id = ${sqlLiteral(origBusinessSnapshot.upi_qr_file_id)},
          show_upi_qr_on_invoice = ${sqlLiteral(origBusinessSnapshot.show_upi_qr_on_invoice)},
          invoice_next_number = ${sqlLiteral(origBusinessSnapshot.invoice_next_number)},
          quotation_next_number = ${sqlLiteral(origBusinessSnapshot.quotation_next_number)},
          credit_note_next_number = ${sqlLiteral(origBusinessSnapshot.credit_note_next_number)},
          cashier_max_discount_pct = ${sqlLiteral(origBusinessSnapshot.cashier_max_discount_pct)},
          allow_cashier_price_override = ${sqlLiteral(origBusinessSnapshot.allow_cashier_price_override)}
        WHERE id = 1;`
      ).catch(() => undefined);

      // Restore numbering_series counters & remove any test-only series rows added during test
      const origKeys = new Set(
        origNumberingSeries.map((r) => `${r.series_key}::${r.fy_code}`)
      );
      for (const row of origNumberingSeries) {
        await runAdminSql(
          `UPDATE public.numbering_series SET
            prefix = ${sqlLiteral(row.prefix)},
            next_number = ${sqlLiteral(row.next_number)},
            padding = ${sqlLiteral(row.padding)}
          WHERE series_key = ${sqlLiteral(row.series_key)} AND fy_code = ${sqlLiteral(row.fy_code)};`
        ).catch(() => undefined);
      }
      const currentSeries = await runAdminSql(
        `SELECT series_key, fy_code FROM public.numbering_series;`
      ).catch(() => []);
      for (const cur of currentSeries) {
        if (!origKeys.has(`${cur.series_key}::${cur.fy_code}`)) {
          await runAdminSql(
            `DELETE FROM public.numbering_series WHERE series_key = ${sqlLiteral(cur.series_key)} AND fy_code = ${sqlLiteral(cur.fy_code)};`
          ).catch(() => undefined);
        }
      }

      if (origModuleStates.length > 0) {
        await supabaseAdmin.from('modules_state').upsert(origModuleStates);
      }
    }

    if (uploadedStoragePaths.length > 0) {
      await supabaseAdmin.storage
        .from('bizone-private')
        .remove(uploadedStoragePaths)
        .catch(() => undefined);
    }
    if (createdFileIds.length > 0) {
      await runAdminSql(
        `DELETE FROM public.file_links WHERE file_id IN (${createdFileIds.map((id) => `'${id}'`).join(',')});
         DELETE FROM public.files WHERE id IN (${createdFileIds.map((id) => `'${id}'`).join(',')});`
      ).catch(() => undefined);
    }
    if (createdUserIds.length > 0) {
      await supabaseAdmin
        .from('audit_logs')
        .delete()
        .in('actor_id', createdUserIds);
      for (const uid of createdUserIds) {
        await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => undefined);
      }
    }
    if (createdWorkspaceTemp) {
      await supabaseAdmin.from('business').delete().eq('id', 1);
    }
  }
});
