import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildSignedBackupBlob,
  sha256Hex,
  verifyBackupEnvelope,
} from '../src/core/backup.ts';
import { escapeCsvCell } from '../src/core/export.ts';
import { todayLocalIso } from '../src/core/format.ts';
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
const hasLiveSupabase =
  Boolean(SUPABASE_URL?.startsWith('https://')) &&
  !SUPABASE_URL?.includes('YOUR_PROJECT_REF') &&
  (SUPABASE_ANON_KEY?.length ?? 0) > 20 &&
  (SERVICE_ROLE_KEY?.length ?? 0) > 20 &&
  Boolean(ACCESS_TOKEN && PROJECT_REF);

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

test('Phase P5 unit checks: CSV formula safety, SHA-256 backup verification, role permissions & EN/HI parity', async () => {
  // 1. CSV escaping & formula injection neutralization
  assert.equal(escapeCsvCell('Normal Text'), 'Normal Text');
  assert.equal(escapeCsvCell('=SUM(A1:A5)'), "'=SUM(A1:A5)");
  assert.equal(escapeCsvCell('+1234'), "'+1234");
  assert.equal(escapeCsvCell('-500'), "'-500");
  assert.equal(escapeCsvCell('@evil'), "'@evil");
  assert.equal(escapeCsvCell('A, "B"'), '"A, ""B"""');
  assert.equal(escapeCsvCell(null), '');

  // 2. Backup packaging, SHA-256 signing & tamper detection
  const sampleSnapshot = {
    app: 'DecorBiz',
    schema_version: 'p5-v1',
    exported_at: '2026-11-13T12:00:00Z',
    exported_by: 'owner@example.com',
    record_counts: { parties: 2, items: 3 },
    data: {
      business: { id: 1, name: 'Test Mart' },
      parties: [{ id: 'p1', name: 'Rao Traders' }],
    },
  };
  const { jsonText, checksum, sizeBytes } = await buildSignedBackupBlob(sampleSnapshot);
  assert.equal(checksum.length, 64);
  assert.ok(sizeBytes > 50);

  const verified = await verifyBackupEnvelope(jsonText);
  assert.equal(verified.checksum, checksum);
  assert.equal(verified.checksumVerified, true);
  assert.equal(verified.envelope.schema_version, 'p5-v1');

  // Tamper one character -> must throw checksum mismatch
  const tampered = jsonText.replace('Rao Traders', 'Rao Hackers');
  await assert.rejects(
    () => verifyBackupEnvelope(tampered),
    /checksum mismatch/i
  );

  // Wrong schema version rejected
  const badVer = JSON.stringify({ ...sampleSnapshot, schema_version: 'p4-v1' });
  await assert.rejects(
    () => verifyBackupEnvelope(badVer),
    /Unsupported backup schema version/i
  );

  // 3. Role matrix checks for P5 capabilities
  assert.equal(hasCapability('owner', 'purchases'), true);
  assert.equal(hasCapability('owner', 'expenses'), true);
  assert.equal(hasCapability('owner', 'backup'), true);
  assert.equal(hasCapability('owner', 'export_data'), true);

  assert.equal(hasCapability('storekeeper', 'purchases'), true);
  assert.equal(hasCapability('storekeeper', 'expenses'), false);
  assert.equal(hasCapability('storekeeper', 'view_profit'), false);

  assert.equal(hasCapability('cashier', 'expenses'), true);
  assert.equal(hasCapability('cashier', 'purchases'), false);
  assert.equal(hasCapability('cashier', 'view_profit'), false);
  assert.equal(hasCapability('cashier', 'export_data'), false);

  assert.equal(hasCapability('accountant', 'purchases'), true);
  assert.equal(hasCapability('accountant', 'expenses'), true);
  assert.equal(hasCapability('accountant', 'view_profit'), true);
  assert.equal(hasCapability('accountant', 'export_data'), true);
  assert.equal(hasCapability('accountant', 'backup'), true);

  assert.equal(hasCapability('viewer', 'reports'), true);
  assert.equal(hasCapability('viewer', 'export_data'), false);

  // 4. EN / HI translation key parity for purchases, expenses, reports, settings.tabs.backup
  const en = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/en.json'), 'utf8')
  );
  const hi = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/hi.json'), 'utf8')
  );

  for (const section of ['purchases', 'expenses', 'reports']) {
    const enLeaf = new Map(collectLeafPaths(en[section], section));
    const hiLeaf = new Map(collectLeafPaths(hi[section], section));
    assert.equal(
      enLeaf.size,
      hiLeaf.size,
      `${section} EN/HI leaf count must match`
    );
    for (const [k] of enLeaf) {
      assert.ok(hiLeaf.has(k), `Missing Hindi key ${k}`);
      assert.ok(hiLeaf.get(k).trim().length > 0, `Empty Hindi value ${k}`);
    }
  }
  assert.ok(en.settings?.tabs?.backup && hi.settings?.tabs?.backup);
  assert.ok(en.common?.print && hi.common?.print);
  assert.ok(en.common?.exportCsv && hi.common?.exportCsv);
  assert.equal(typeof sha256Hex, 'function');
});

test(
  'Phase P5 E2E: purchase stock & cost sync, supplier balance, purchase returns, expenses & cashier isolation, day/cash/bank books, GST & profit reports, and backup/restore recovery',
  { skip: hasLiveSupabase ? false : 'Live Supabase credentials are not configured in environment' },
  async () => {
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
  const password = 'DecorBizP5!2026';
  const today = todayLocalIso();
  const createdUserIds = [];
  const createdItemIds = [];
  const createdPartyIds = [];
  const createdBillIds = [];
  const createdPurchaseIds = [];
  const createdExpenseIds = [];
  const createdFileIds = [];
  const uploadedStoragePaths = [];
  let createdWorkspaceTemp = false;
  let origBusinessSnapshot = null;
  let origNumberingSeries = [];
  let origModuleStates = [];

  const createTempUser = async (role, tag) => {
    const email = `p5.${tag}.${stamp}@example.com`;
    const { data: authData, error: authErr } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: `P5 ${tag}` },
      });
    assert.ifError(authErr);
    createdUserIds.push(authData.user.id);

    const { error: profErr } = await supabaseAdmin.from('profiles').insert({
      id: authData.user.id,
      full_name: `P5 ${tag}`,
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
    const { data: existingBiz } = await supabaseAdmin
      .from('business')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (!existingBiz) {
      await supabaseAdmin.from('business').insert({
        id: 1,
        name: 'P5 Temp Business',
        pack: 'decorbiz',
        gst_registered: true,
        gstin: '27AAPFU0939F1ZV',
        state_code: '27',
      });
      createdWorkspaceTemp = true;
    } else {
      origBusinessSnapshot = existingBiz;
      const [{ data: seriesRows }, { data: modRows }] = await Promise.all([
        supabaseAdmin.from('numbering_series').select('*'),
        supabaseAdmin.from('modules_state').select('*'),
      ]);
      origNumberingSeries = seriesRows ?? [];
      origModuleStates = modRows ?? [];

      await supabaseAdmin.from('modules_state').upsert([
        { module_key: 'billing', enabled: true },
        { module_key: 'parties', enabled: true },
        { module_key: 'payments', enabled: true },
        { module_key: 'inventory', enabled: true },
        { module_key: 'purchases', enabled: true },
        { module_key: 'expenses', enabled: true },
        { module_key: 'reports', enabled: true },
        { module_key: 'tax', enabled: true },
        { module_key: 'backup', enabled: true },
      ]);

      await supabaseAdmin
        .from('business')
        .update({ gst_registered: true, state_code: '27' })
        .eq('id', 1);
    }

    const [owner, manager, cashier, storekeeper, accountant] = await Promise.all([
      createTempUser('owner', 'owner'),
      createTempUser('manager', 'mgr'),
      createTempUser('cashier', 'cash'),
      createTempUser('storekeeper', 'store'),
      createTempUser('accountant', 'acct'),
    ]);

    // Take baseline snapshot right before mutating so restore test never drops pre-existing data!
    const { data: preTestSnapshot, error: preSnapErr } = await owner.client.rpc(
      'export_workspace_backup',
      { p_backup_type: 'manual' }
    );
    assert.ifError(preSnapErr);
    const { checksum: preTestChecksum } = await buildSignedBackupBlob(preTestSnapshot);

    // 1. Setup units, item (BOX=12 PCS), supplier & customer
    const { data: units } = await owner.client.from('item_units').select('id, code');
    const pcsUnit = units.find((u) => u.code === 'PCS');
    const boxUnit = units.find((u) => u.code === 'BOX');
    assert.ok(pcsUnit && boxUnit);

    const { data: item, error: itemErr } = await owner.client.rpc('save_item', {
      p_name: `P5 Tea Tin ${stamp}`,
      p_sku: `P5-TEA-${stamp}`,
      p_base_unit_id: pcsUnit.id,
      p_selling_price: 150,
      p_purchase_price: 100,
      p_gst_rate: 18,
      p_tax_inclusive: false,
      p_hsn_code: '0902',
      p_allow_negative_stock: false,
      p_opening_stock: 10,
      p_opening_unit_id: pcsUnit.id,
      p_conversions: [{ alternate_unit_id: boxUnit.id, conversion_factor: 12 }],
    });
    assert.ifError(itemErr);
    createdItemIds.push(item.id);

    const { data: supplier, error: supErr } = await owner.client.rpc('save_party', {
      p_party_id: null,
      p_name: `P5 Supplier ${stamp}`,
      p_party_type: 'supplier',
      p_gstin: '27AABCU9603R1ZM',
      p_credit_days: 30,
      p_addresses: [
        {
          label: 'Warehouse',
          address_line1: 'Market Yard',
          city: 'Pune',
          state: 'Maharashtra',
          state_code: '27',
          is_default: true,
        },
      ],
    });
    assert.ifError(supErr);
    createdPartyIds.push(supplier.id);

    const { data: customer, error: custErr } = await owner.client.rpc('save_party', {
      p_party_id: null,
      p_name: `P5 Customer ${stamp}`,
      p_party_type: 'customer',
      p_gstin: '27AABCU9603R1ZN',
      p_addresses: [
        {
          label: 'Shop',
          address_line1: 'FC Road',
          city: 'Pune',
          state: 'Maharashtra',
          state_code: '27',
          is_default: true,
        },
      ],
    });
    assert.ifError(custErr);
    createdPartyIds.push(customer.id);

    // 2. Storekeeper restriction: cannot record paid_amount > 0 on purchase, CAN post credit purchase
    const { error: storePayErr } = await storekeeper.client.rpc('issue_purchase', {
      p_party_id: supplier.id,
      p_bill_date: today,
      p_lines: [
        {
          item_id: item.id,
          entered_qty: 1,
          entered_unit_id: pcsUnit.id,
          unit_cost: 110,
          discount_pct: 0,
          tax_inclusive: false,
        },
      ],
      p_paid_amount: 50,
      p_payment_mode: 'cash',
    });
    assert.ok(storePayErr, 'Storekeeper must be blocked from recording cash payout on purchase');

    // Upload supplier bill attachment and issue purchase bill: 2 BOX (24 PCS) @ ₹1200/BOX + 18% GST = ₹2832, paid ₹1000 via bank_transfer
    const upSupRes = await fetch(`${BASE_URL}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.accessToken}`,
      },
      body: JSON.stringify({
        fileName: 'supplier-bill.png',
        mimeType: 'image/png',
        base64: VALID_PNG_BASE64,
        purpose: 'attachment',
        entityType: 'purchase_bill',
        entityId: String(stamp),
      }),
    });
    assert.equal(upSupRes.status, 201);
    const upSupJson = await upSupRes.json();
    createdFileIds.push(upSupJson.file.id);
    uploadedStoragePaths.push(upSupJson.file.storage_path);

    // Cashier cannot fetch purchase_bill attachment signed URL
    const cashierSupAttRes = await fetch(
      `${BASE_URL}/api/files/signed-url?fileId=${upSupJson.file.id}`,
      { headers: { Authorization: `Bearer ${cashier.accessToken}` } }
    );
    assert.equal(cashierSupAttRes.status, 403);

    const { data: pur1, error: pur1Err } = await owner.client.rpc('issue_purchase', {
      p_party_id: supplier.id,
      p_supplier_invoice_no: `SUP-${stamp}`,
      p_bill_date: today,
      p_gst_applied: true,
      p_freight_charges: 0,
      p_auto_round_off: true,
      p_update_item_cost: true,
      p_attachment_file_id: upSupJson.file.id,
      p_lines: [
        {
          item_id: item.id,
          entered_qty: 2,
          entered_unit_id: boxUnit.id,
          unit_cost: 1200,
          discount_pct: 0,
          tax_inclusive: false,
        },
      ],
      p_paid_amount: 1000,
      p_payment_mode: 'bank_transfer',
      p_payment_reference: 'NEFT-P5-01',
    });
    assert.ifError(pur1Err);
    createdPurchaseIds.push(pur1.id);
    assert.equal(Number(pur1.grand_total), 2832);
    assert.equal(Number(pur1.paid_amount), 1000);
    assert.equal(Number(pur1.balance_due), 1832);
    assert.equal(pur1.payment_status, 'partial');

    // Verify stock increased: 10 + 24 = 34 PCS, and purchase_price updated to 1200/12 = 100
    const { data: itemAfterPur } = await owner.client
      .from('item_catalog_view')
      .select('qty_on_hand, purchase_price')
      .eq('id', item.id)
      .single();
    assert.equal(Number(itemAfterPur.qty_on_hand), 34);
    assert.equal(Number(itemAfterPur.purchase_price), 100);

    // Verify supplier balance = -1832 (we owe ₹1832)
    const { data: supBal1 } = await owner.client
      .from('party_balances')
      .select('net_balance')
      .eq('party_id', supplier.id)
      .single();
    assert.equal(Number(supBal1.net_balance), -1832);

    // 3. Purchase Return (Debit Note): return 1 BOX (12 PCS -> ₹1416), credited to supplier Khata
    const { data: pur1Lines } = await owner.client
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', pur1.id);
    assert.equal(pur1Lines.length, 1);

    const { data: pret1, error: pretErr } = await owner.client.rpc(
      'create_purchase_return',
      {
        p_source_purchase_id: pur1.id,
        p_return_date: today,
        p_lines: [{ source_purchase_line_id: pur1Lines[0].id, entered_qty: 1 }],
        p_refund_amount: 0,
        p_reason: '1 box damaged outer seal',
      }
    );
    assert.ifError(pretErr);
    createdPurchaseIds.push(pret1.id);
    assert.equal(pret1.doc_type, 'purchase_return');
    assert.equal(Number(pret1.grand_total), 1416);

    // Stock deducted: 34 - 12 = 22 PCS
    const { data: balAfterPret } = await owner.client
      .from('stock_balances')
      .select('qty_on_hand')
      .eq('item_id', item.id)
      .single();
    assert.equal(Number(balAfterPret.qty_on_hand), 22);

    // Source purchase credited_amount = 1416, balance_due = 2832 - 1000 - 1416 = 416
    const { data: pur1Updated } = await owner.client
      .from('purchase_bills')
      .select('credited_amount, balance_due, payment_status')
      .eq('id', pur1.id)
      .single();
    assert.equal(Number(pur1Updated.credited_amount), 1416);
    assert.equal(Number(pur1Updated.balance_due), 416);
    assert.equal(pur1Updated.payment_status, 'partial');

    // Pay remaining ₹416 via Khata post_payment -> purchase flips to paid!
    const { data: supObls } = await owner.client
      .from('party_open_obligations')
      .select('ledger_entry_id, remaining_amount')
      .eq('party_id', supplier.id);
    assert.equal(supObls.length, 1);
    assert.equal(Number(supObls[0].remaining_amount), 416);

    const { error: settleSupErr } = await owner.client.rpc('post_payment', {
      p_party_id: supplier.id,
      p_direction: 'give',
      p_amount: 416,
      p_mode: 'cash',
      p_payment_date: today,
      p_allocations: [{ ledger_entry_id: supObls[0].ledger_entry_id, amount: 416 }],
      p_auto_allocate: false,
    });
    assert.ifError(settleSupErr);

    const { data: pur1Settled } = await owner.client
      .from('purchase_bills')
      .select('paid_amount, balance_due, payment_status')
      .eq('id', pur1.id)
      .single();
    assert.equal(Number(pur1Settled.paid_amount), 1416);
    assert.equal(Number(pur1Settled.balance_due), 0);
    assert.equal(pur1Settled.payment_status, 'paid');

    // Unpaid draft & void purchase check
    const { data: purVoidTarget, error: pvErr } = await storekeeper.client.rpc(
      'issue_purchase',
      {
        p_party_id: supplier.id,
        p_bill_date: today,
        p_lines: [
          {
            item_id: item.id,
            entered_qty: 5,
            entered_unit_id: pcsUnit.id,
            unit_cost: 100,
            discount_pct: 0,
          },
        ],
        p_paid_amount: 0,
      }
    );
    assert.ifError(pvErr);
    createdPurchaseIds.push(purVoidTarget.id);

    const { error: voidPurErr } = await manager.client.rpc('void_purchase', {
      p_purchase_id: purVoidTarget.id,
      p_reason: 'Duplicate entry P5 test',
    });
    assert.ifError(voidPurErr);

    // 4. Sales Bill to test Day Book reconciliation, GST Output vs Input, & Profit Estimate
    // Sell 2 PCS @ ₹150 + 18% GST = ₹354 (paid ₹200 cash to party) + Walk-in 1 PCS @ ₹150 + 18% GST = ₹177 UPI
    const { data: salePartyBill, error: spbErr } = await owner.client.rpc('issue_bill', {
      p_doc_type: 'tax_invoice',
      p_party_id: customer.id,
      p_bill_date: today,
      p_lines: [
        {
          item_id: item.id,
          entered_qty: 2,
          entered_unit_id: pcsUnit.id,
          unit_price: 150,
          discount_pct: 0,
          tax_inclusive: false,
        },
      ],
      p_paid_amount: 200,
      p_payment_mode: 'cash',
    });
    assert.ifError(spbErr);
    createdBillIds.push(salePartyBill.id);

    const { data: walkinBill, error: wbErr } = await cashier.client.rpc('issue_bill', {
      p_doc_type: 'tax_invoice',
      p_party_id: null,
      p_bill_date: today,
      p_lines: [
        {
          item_id: item.id,
          entered_qty: 1,
          entered_unit_id: pcsUnit.id,
          unit_price: 150,
          discount_pct: 0,
          tax_inclusive: false,
        },
      ],
      p_paid_amount: 177,
      p_payment_mode: 'upi',
    });
    assert.ifError(wbErr);
    createdBillIds.push(walkinBill.id);

    // 5. Expenses & Cashier own-only isolation
    const { data: expCats } = await owner.client
      .from('expense_categories')
      .select('id, code');
    const rentCat = expCats.find((c) => c.code === 'RENT');
    const teaCat = expCats.find((c) => c.code === 'TEA_SNACKS') || expCats[0];
    assert.ok(rentCat && teaCat);

    const { data: ownerExp, error: oeErr } = await owner.client.rpc('save_expense', {
      p_category_id: rentCat.id,
      p_expense_date: today,
      p_amount: 500,
      p_payment_mode: 'bank_transfer',
      p_paid_to: 'Landlord',
      p_notes: 'P5 shop rent',
    });
    assert.ifError(oeErr);
    createdExpenseIds.push(ownerExp.id);

    const { data: cashierExp, error: ceErr } = await cashier.client.rpc('save_expense', {
      p_category_id: teaCat.id,
      p_expense_date: today,
      p_amount: 60,
      p_payment_mode: 'cash',
      p_paid_to: 'Tea Stall',
      p_notes: 'P5 counter tea',
    });
    assert.ifError(ceErr);
    createdExpenseIds.push(cashierExp.id);

    // Cashier must see ONLY cashierExp (not ownerExp)
    const { data: cashierVisibleExps } = await cashier.client
      .from('expense_list_view')
      .select('id')
      .in('id', [ownerExp.id, cashierExp.id]);
    assert.equal(cashierVisibleExps.length, 1);
    assert.equal(cashierVisibleExps[0].id, cashierExp.id);

    // Cashier cannot void expense; Accountant CAN void expense
    const { error: cashierVoidExpErr } = await cashier.client.rpc('void_expense', {
      p_expense_id: cashierExp.id,
      p_reason: 'Should fail',
    });
    assert.ok(cashierVoidExpErr);

    // 6. Day / Cash / Bank Book Reconciliation (no double counting!)
    const { data: dayBook, error: dbErr } = await owner.client.rpc('get_day_book', {
      p_from_date: today,
      p_to_date: today,
      p_book: 'day',
    });
    assert.ifError(dbErr);

    const { data: cashBook } = await owner.client.rpc('get_day_book', {
      p_from_date: today,
      p_to_date: today,
      p_book: 'cash',
    });
    const { data: bankBook } = await owner.client.rpc('get_day_book', {
      p_from_date: today,
      p_to_date: today,
      p_book: 'bank',
    });

    // Day Book = Cash Book + Bank Book!
    assert.equal(
      Number(dayBook.total_in),
      Number((Number(cashBook.total_in) + Number(bankBook.total_in)).toFixed(2))
    );
    assert.equal(
      Number(dayBook.total_out),
      Number((Number(cashBook.total_out) + Number(bankBook.total_out)).toFixed(2))
    );

    // Cash In should contain ₹200 party cash receipt (only ONCE, not duplicated with bill) + ₹177 walk-in UPI = ₹377 total
    const p5CashInEntries = dayBook.rows.filter(
      (r) =>
        (r.party_or_particular.includes(customer.name) && Number(r.cash_in) === 200) ||
        (r.voucher_no === walkinBill.bill_number && Number(r.cash_in) === 177)
    );
    assert.equal(p5CashInEntries.length, 2, 'Party receipt + walk-in bill must appear once each without double-counting');

    // 7. GST Summary & Profit Estimate + Role restrictions
    const { data: gstSum, error: gstErr } = await accountant.client.rpc('get_gst_summary', {
      p_from_date: today,
      p_to_date: today,
    });
    assert.ifError(gstErr);
    assert.equal(
      Number(gstSum.net_payable.total_tax),
      Number((Number(gstSum.output.total_tax) - Number(gstSum.input.total_tax)).toFixed(2))
    );

    const { data: profitEst, error: profReportErr } = await accountant.client.rpc(
      'get_profit_estimate',
      { p_from_date: today, p_to_date: today }
    );
    assert.ifError(profReportErr);
    assert.ok(Number(profitEst.net_sales_ex_tax) >= 450);
    assert.ok(Number(profitEst.operating_expenses) >= 560);

    // Cashier blocked from Profit Estimate and GST Summary
    const { error: cashierProfitErr } = await cashier.client.rpc('get_profit_estimate', {
      p_from_date: today,
      p_to_date: today,
    });
    assert.ok(cashierProfitErr);

    const { error: cashierGstErr } = await cashier.client.rpc('get_gst_summary', {
      p_from_date: today,
      p_to_date: today,
    });
    assert.ok(cashierGstErr);

    // 8. Dashboard & Notifications & Storage Summary
    const { data: dash, error: dashErr } = await owner.client.rpc('get_dashboard_metrics');
    assert.ifError(dashErr);
    assert.equal(dash.daily_trend.length, 7);

    const { data: notifRes, error: notifErr } = await owner.client.rpc('sync_system_notifications');
    assert.ifError(notifErr);
    assert.ok(Array.isArray(notifRes.notifications));

    const { data: storageRes, error: storageErr } = await accountant.client.rpc('get_storage_usage_summary');
    assert.ifError(storageErr);
    assert.ok(storageRes.table_counts);

    // 9. Backup Export -> Restore Recovery Path (restoring preTestSnapshot cleanly!)
    // Non-owner (Manager/Accountant) cannot call restore_workspace_backup
    const { error: mgrRestoreErr } = await manager.client.rpc('restore_workspace_backup', {
      p_snapshot: preTestSnapshot,
      p_checksum: preTestChecksum,
    });
    assert.ok(mgrRestoreErr);
    assert.match(mgrRestoreErr.message, /Owner/i);

    // Take a backup WITH all P5 test records -> verify counts -> restore back to preTestSnapshot -> verify P5 test items removed cleanly, then restore P5? Or keep preTestSnapshot restored so DB is pristine!
    const { data: fullP5Snap, error: fpErr } = await owner.client.rpc(
      'export_workspace_backup',
      { p_backup_type: 'manual' }
    );
    assert.ifError(fpErr);
    assert.ok(fullP5Snap.record_counts.purchase_bills >= 2);
    assert.ok(fullP5Snap.record_counts.expenses >= 2);

    const { data: restoreOut, error: restoreErr } = await owner.client.rpc(
      'restore_workspace_backup',
      {
        p_snapshot: preTestSnapshot,
        p_checksum: preTestChecksum,
      }
    );
    assert.ifError(restoreErr);
    assert.equal(restoreOut.restored, true);

    // Confirm test item is gone after restoring preTestSnapshot!
    const { data: goneItem } = await owner.client
      .from('items')
      .select('id')
      .eq('id', item.id)
      .maybeSingle();
    assert.equal(goneItem, null);

    // Confirm last_backup_at & audit_logs recorded backup.restored
    const { data: restoreAudit } = await owner.client
      .from('audit_logs')
      .select('action')
      .eq('action', 'backup.restored')
      .limit(1);
    assert.equal(restoreAudit.length, 1);
  } finally {
    // Cleanup temporary test files, notifications/backup_records created during test, and temp users
    if (origBusinessSnapshot) {
      await runAdminSql(
        `UPDATE public.business SET
          gst_registered = ${sqlLiteral(origBusinessSnapshot.gst_registered)},
          state_code = ${sqlLiteral(origBusinessSnapshot.state_code)},
          last_backup_at = ${sqlLiteral(origBusinessSnapshot.last_backup_at)}
        WHERE id = 1;`
      ).catch(() => undefined);

      if (origModuleStates.length > 0) {
        await supabaseAdmin.from('modules_state').upsert(origModuleStates);
      }
      for (const row of origNumberingSeries) {
        await runAdminSql(
          `UPDATE public.numbering_series SET
            prefix = ${sqlLiteral(row.prefix)},
            next_number = ${sqlLiteral(row.next_number)},
            padding = ${sqlLiteral(row.padding)}
          WHERE series_key = ${sqlLiteral(row.series_key)} AND fy_code = ${sqlLiteral(row.fy_code)};`
        ).catch(() => undefined);
      }
    }

    if (uploadedStoragePaths.length > 0) {
      await supabaseAdmin.storage
        .from('decorbiz-private')
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
        .from('backup_records')
        .delete()
        .in('created_by', createdUserIds);
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
