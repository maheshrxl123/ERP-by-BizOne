import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

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

function roundQtyClient(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function convertToBaseQtyMirror({
  qty,
  unitId,
  baseUnitId,
  baseAllowDecimal = true,
  conversions = [],
}) {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Quantity must be greater than zero.');
  }
  let factor = 1;
  if (unitId && unitId !== baseUnitId) {
    const found = conversions.find((c) => c.alternate_unit_id === unitId);
    if (!found || Number(found.conversion_factor) <= 0) {
      throw new Error('Selected unit has no valid conversion for this item.');
    }
    factor = Number(found.conversion_factor);
  }
  const baseQty = roundQtyClient(qty * factor);
  if (baseQty <= 0) {
    throw new Error('Converted base quantity is too small.');
  }
  if (!baseAllowDecimal && Math.abs(baseQty - Math.trunc(baseQty)) > 1e-6) {
    throw new Error('Base unit does not allow fractional quantities.');
  }
  return { baseQty, factor };
}

test('Phase P3 unit checks: unit conversion edge cases and Hindi i18n parity', () => {
  // Conversion checks
  const res1 = convertToBaseQtyMirror({
    qty: 2.5,
    unitId: 'box',
    baseUnitId: 'pcs',
    baseAllowDecimal: false,
    conversions: [{ alternate_unit_id: 'box', conversion_factor: 12 }],
  });
  assert.equal(res1.baseQty, 30);
  assert.equal(res1.factor, 12);

  // Fractional weight (Kg -> Gram or Box -> Kg)
  const res2 = convertToBaseQtyMirror({
    qty: 0.375,
    unitId: 'kg',
    baseUnitId: 'kg',
    baseAllowDecimal: true,
    conversions: [],
  });
  assert.equal(res2.baseQty, 0.375);

  // Whole-unit violation should throw
  assert.throws(
    () =>
      convertToBaseQtyMirror({
        qty: 0.5,
        unitId: 'box',
        baseUnitId: 'pcs',
        baseAllowDecimal: false,
        conversions: [{ alternate_unit_id: 'box', conversion_factor: 5 }],
      }),
    /fractional/i
  );

  // Missing conversion should throw
  assert.throws(
    () =>
      convertToBaseQtyMirror({
        qty: 1,
        unitId: 'ctn',
        baseUnitId: 'pcs',
        baseAllowDecimal: false,
        conversions: [{ alternate_unit_id: 'box', conversion_factor: 12 }],
      }),
    /conversion/i
  );

  // Zero/negative should throw
  assert.throws(
    () =>
      convertToBaseQtyMirror({
        qty: 0,
        unitId: 'pcs',
        baseUnitId: 'pcs',
      }),
    /greater than zero/i
  );

  // i18n parity & PRD Section 25 glossary
  const en = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/en.json'), 'utf8')
  );
  const hi = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/hi.json'), 'utf8')
  );
  const enLeaves = new Map(collectLeafPaths(en.items, 'items'));
  const hiLeaves = new Map(collectLeafPaths(hi.items, 'items'));
  assert.equal(enLeaves.size, hiLeaves.size, 'items EN/HI key counts must match');
  for (const [k] of enLeaves) {
    assert.ok(hiLeaves.has(k), `Missing Hindi key ${k}`);
    assert.ok(hiLeaves.get(k).trim().length > 0, `Empty Hindi key ${k}`);
  }
  assert.equal(hi.nav.items, 'सामान');
  assert.equal(hi.items.lowStock, 'कम स्टॉक');
  assert.equal(hi.items.unit, 'इकाई');
  assert.ok(hi.items.stockOnHand.includes('स्टॉक'));
});

test('Phase P3 E2E: Catalogue, unit conversions, ledger reconciliation, negative-stock policy, multi-image gallery & orphan cleanup, purchase-cost RBAC, and indexed search', async () => {
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
  const password = 'BizOneP3!2026';
  const createdUserIds = [];
  const createdItemIds = [];
  const createdCategoryIds = [];
  const createdBrandIds = [];
  const createdFileIds = [];
  const uploadedStoragePaths = [];
  let createdWorkspaceTemp = false;

  const createTempUser = async (role, tag) => {
    const email = `p3.${tag}.${stamp}@example.com`;
    const { data: authData, error: authErr } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: `P3 ${tag}` },
      });
    assert.ifError(authErr);
    createdUserIds.push(authData.user.id);

    const { error: profErr } = await supabaseAdmin.from('profiles').insert({
      id: authData.user.id,
      full_name: `P3 ${tag}`,
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
    // Ensure workspace exists without mutating an existing real business
    const { data: existingBiz } = await supabaseAdmin
      .from('business')
      .select('id')
      .eq('id', 1)
      .maybeSingle();

    if (!existingBiz) {
      await supabaseAdmin.from('business').insert({
        id: 1,
        name: 'Temp P3 Store',
        pack: 'kirana',
        gst_registered: false,
      });
      createdWorkspaceTemp = true;
    }

    const owner = await createTempUser('owner', 'owner');
    const storekeeper = await createTempUser('storekeeper', 'store');
    const cashier = await createTempUser('cashier', 'cashier');
    const accountant = await createTempUser('accountant', 'acct');
    const viewer = await createTempUser('viewer', 'viewer');

    // Fetch seeded units (PCS, BOX, KG, GM)
    const { data: unitRows, error: unitsErr } = await owner.client
      .from('item_units')
      .select('id, code, allow_decimal');
    assert.ifError(unitsErr);
    const byCode = new Map(unitRows.map((u) => [u.code, u]));
    const pcsUnit = byCode.get('PCS');
    const boxUnit = byCode.get('BOX');
    const kgUnit = byCode.get('KG');
    const gmUnit = byCode.get('GM');
    assert.ok(pcsUnit && boxUnit && kgUnit && gmUnit, 'Seeded units must exist');

    // 1. Category & Brand creation
    const { data: catRow, error: catErr } = await storekeeper.client.rpc(
      'save_item_category',
      {
        p_name: `P3 Beverages ${stamp}`,
        p_description: 'Test category',
      }
    );
    assert.ifError(catErr);
    createdCategoryIds.push(catRow.id);

    const { data: brandRow, error: brandErr } = await storekeeper.client.rpc(
      'save_brand',
      {
        p_name: `P3 Brand ${stamp}`,
      }
    );
    assert.ifError(brandErr);
    createdBrandIds.push(brandRow.id);

    // 2. Upload 3 item images via Express API + test orphan draft cleanup
    const uploadItemImg = async (token, fileName) => {
      const res = await fetch(`${BASE_URL}/api/files/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName,
          mimeType: 'image/png',
          base64: `data:image/png;base64,${VALID_PNG_BASE64}`,
          purpose: 'item_image',
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, `Upload failed: ${body?.error}`);
      createdFileIds.push(body.file.id);
      uploadedStoragePaths.push(body.file.storage_path);
      return body.file;
    };

    const img1 = await uploadItemImg(owner.accessToken, 'tea_front.png');
    const img2 = await uploadItemImg(owner.accessToken, 'tea_back.png');
    const orphanImg = await uploadItemImg(owner.accessToken, 'orphan_draft.png');

    // Cashier must be blocked from uploading item_image
    const cashierUploadRes = await fetch(`${BASE_URL}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cashier.accessToken}`,
      },
      body: JSON.stringify({
        fileName: 'blocked.png',
        mimeType: 'image/png',
        base64: `data:image/png;base64,${VALID_PNG_BASE64}`,
        purpose: 'item_image',
      }),
    });
    assert.equal(cashierUploadRes.status, 403);

    // 3. Create Item with 2 images (img2 as primary!), conversion (1 BOX = 12 PCS), opening stock = 2 BOX (24 PCS), purchase cost = 85.50
    const { data: createdItem, error: itemErr } = await owner.client.rpc(
      'save_item',
      {
        p_name: `Assam Gold Tea ${stamp}`,
        p_sku: `TEA-${stamp}`,
        p_barcode: `890${String(stamp).slice(-10)}`,
        p_category_id: catRow.id,
        p_brand_id: brandRow.id,
        p_base_unit_id: pcsUnit.id,
        p_selling_price: 120,
        p_mrp: 130,
        p_purchase_price: 85.5,
        p_gst_rate: 5,
        p_hsn_code: '0902',
        p_low_stock_alert: 30,
        p_allow_negative_stock: false,
        p_opening_stock: 2,
        p_opening_unit_id: boxUnit.id,
        p_conversions: [
          { alternate_unit_id: boxUnit.id, conversion_factor: 12 },
        ],
        p_images: [
          { file_id: img1.id, is_primary: false },
          { file_id: img2.id, is_primary: true },
        ],
      }
    );
    assert.ifError(itemErr);
    createdItemIds.push(createdItem.id);
    assert.equal(createdItem.primary_image_file_id, img2.id);

    // 4. Orphan cleanup test: cleaning up [orphanImg.id, img1.id] MUST delete orphanImg from DB & storage, but NEVER touch attached img1!
    const cleanupRes = await fetch(`${BASE_URL}/api/files/cleanup-orphans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.accessToken}`,
      },
      body: JSON.stringify({ fileIds: [orphanImg.id, img1.id] }),
    });
    assert.equal(cleanupRes.status, 200);
    const cleanupJson = await cleanupRes.json();
    assert.deepEqual(cleanupJson.deletedFileIds, [orphanImg.id]);

    const { data: orphanDb } = await supabaseAdmin
      .from('files')
      .select('id')
      .eq('id', orphanImg.id)
      .maybeSingle();
    assert.equal(orphanDb, null, 'Orphan file DB row should be deleted');

    const { data: storageCheck } = await supabaseAdmin.storage
      .from('bizone-private')
      .createSignedUrl(orphanImg.storage_path, 60);
    assert.equal(storageCheck, null, 'Orphan storage object should be removed');

    // 5. Stock adjustment + Unit conversion + Ledger reconciliation + Audit log
    const idempKey = `adj-p3-${stamp}`;
    const { data: adj1, error: adjErr1 } = await storekeeper.client.rpc(
      'adjust_stock',
      {
        p_item_id: createdItem.id,
        p_direction: 'in',
        p_qty: 1,
        p_unit_id: boxUnit.id, // +12 PCS -> 36 PCS
        p_reason: 'Stock recount bonus box',
        p_idempotency_key: idempKey,
      }
    );
    assert.ifError(adjErr1);
    assert.equal(Number(adj1.signed_base_qty), 12);
    assert.equal(Number(adj1.qty_on_hand), 36);
    assert.ok(String(adj1.reference_no).startsWith('ADJ-'));

    // Idempotent replay should not double count
    const { data: adjReplay, error: adjReplayErr } =
      await storekeeper.client.rpc('adjust_stock', {
        p_item_id: createdItem.id,
        p_direction: 'in',
        p_qty: 1,
        p_unit_id: boxUnit.id,
        p_reason: 'Stock recount bonus box',
        p_idempotency_key: idempKey,
      });
    assert.ifError(adjReplayErr);
    assert.equal(adjReplay.idempotent_replay, true);
    assert.equal(Number(adjReplay.qty_on_hand), 36);

    // Reduce 10 PCS -> 26 PCS (now <= low_stock_alert 30 -> is_low_stock = true)
    const { data: adj2, error: adjErr2 } = await storekeeper.client.rpc(
      'adjust_stock',
      {
        p_item_id: createdItem.id,
        p_direction: 'out',
        p_qty: 10,
        p_unit_id: pcsUnit.id,
        p_reason: 'Damaged packet write-off',
      }
    );
    assert.ifError(adjErr2);
    assert.equal(Number(adj2.signed_base_qty), -10);
    assert.equal(Number(adj2.qty_on_hand), 26);

    // Reconcile stock_ledger sum against stock_balances
    const { data: ledgerRows } = await supabaseAdmin
      .from('stock_ledger')
      .select('signed_base_qty')
      .eq('item_id', createdItem.id);
    const ledgerSum = ledgerRows.reduce(
      (acc, r) => acc + Number(r.signed_base_qty),
      0
    );
    const { data: balanceRow } = await supabaseAdmin
      .from('stock_balances')
      .select('qty_on_hand')
      .eq('item_id', createdItem.id)
      .single();
    assert.equal(ledgerSum, 26);
    assert.equal(Number(balanceRow.qty_on_hand), ledgerSum);

    // Audit log recorded for stock adjustment
    const { data: adjAudits } = await supabaseAdmin
      .from('audit_logs')
      .select('action, details')
      .eq('entity_type', 'item')
      .eq('entity_id', createdItem.id)
      .eq('action', 'stock.adjusted');
    assert.ok(adjAudits.length >= 2);
    assert.equal(adjAudits[0].details.reason, 'Stock recount bonus box');

    // 6. Negative stock policy test & immutable ledger test
    const { error: negBlockedErr } = await storekeeper.client.rpc(
      'adjust_stock',
      {
        p_item_id: createdItem.id,
        p_direction: 'out',
        p_qty: 30, // > 26 available
        p_unit_id: pcsUnit.id,
        p_reason: 'Excess reduction test',
      }
    );
    assert.ok(negBlockedErr, 'Negative stock reduction must be blocked when disallowed');
    assert.match(negBlockedErr.message, /Insufficient stock/i);

    // Storekeeper edits item (without purchase_price access!) and turns on allow_negative_stock
    const { data: currentItemForStorekeeper } = await storekeeper.client
      .from('item_catalog_view')
      .select('*')
      .eq('id', createdItem.id)
      .single();
    assert.equal(
      currentItemForStorekeeper.purchase_price,
      null,
      'Storekeeper must see NULL purchase_price'
    );
    assert.equal(
      currentItemForStorekeeper.stock_value,
      null,
      'Storekeeper must see NULL stock_value'
    );
    assert.equal(currentItemForStorekeeper.is_low_stock, true);

    const { error: storeEditErr } = await storekeeper.client.rpc('save_item', {
      p_id: createdItem.id,
      p_name: `Assam Gold Tea ${stamp}`,
      p_sku: `TEA-${stamp}`,
      p_barcode: `890${String(stamp).slice(-10)}`,
      p_category_id: catRow.id,
      p_brand_id: brandRow.id,
      p_base_unit_id: pcsUnit.id,
      p_selling_price: 125,
      p_mrp: 130,
      p_purchase_price: null,
      p_gst_rate: 5,
      p_hsn_code: '0902',
      p_low_stock_alert: 30,
      p_allow_negative_stock: true,
      p_conversions: [
        { alternate_unit_id: boxUnit.id, conversion_factor: 12 },
      ],
      p_expected_version: currentItemForStorekeeper.version,
    });
    assert.ifError(storeEditErr);

    // Verify Storekeeper edit preserved owner's hidden purchase_price = 85.50!
    const { data: ownerViewAfterEdit } = await owner.client
      .from('item_catalog_view')
      .select('purchase_price, stock_value')
      .eq('id', createdItem.id)
      .single();
    assert.equal(Number(ownerViewAfterEdit.purchase_price), 85.5);
    assert.equal(Number(ownerViewAfterEdit.stock_value), 26 * 85.5);

    // Accountant also sees purchase_price & unit_cost
    const { data: acctView } = await accountant.client
      .from('item_catalog_view')
      .select('purchase_price, stock_value')
      .eq('id', createdItem.id)
      .single();
    assert.equal(Number(acctView.purchase_price), 85.5);

    // Now negative stock is allowed -> reducing 30 PCS from 26 -> -4 PCS succeeds
    const { data: negAllowedRes, error: negAllowedErr } =
      await owner.client.rpc('adjust_stock', {
        p_item_id: createdItem.id,
        p_direction: 'out',
        p_qty: 30,
        p_unit_id: pcsUnit.id,
        p_reason: 'Backorder dispatch allowed',
      });
    assert.ifError(negAllowedErr);
    assert.equal(Number(negAllowedRes.qty_on_hand), -4);

    // Immutable stock_ledger check (even admin trigger rejects UPDATE/DELETE)
    const { data: oneLedger } = await supabaseAdmin
      .from('stock_ledger')
      .select('id')
      .eq('item_id', createdItem.id)
      .limit(1)
      .single();
    const { error: delLedgerErr } = await supabaseAdmin
      .from('stock_ledger')
      .delete()
      .eq('id', oneLedger.id);
    assert.ok(delLedgerErr, 'Deleting from stock_ledger must fail');
    assert.match(delLedgerErr.message, /immutable/i);

    // 7. Image gallery reorder, primary switch & delete promoting next primary
    // Reorder: [img2, img1] and switch primary to img1
    const { data: reorderRes, error: reorderErr } = await owner.client.rpc(
      'sync_item_images',
      {
        p_item_id: createdItem.id,
        p_images: [
          { file_id: img2.id, is_primary: false },
          { file_id: img1.id, is_primary: true },
        ],
      }
    );
    assert.ifError(reorderErr);
    assert.equal(reorderRes.primary_image_file_id, img1.id);

    // Cashier MUST NOT delete item image
    const cashierDelImgRes = await fetch(`${BASE_URL}/api/files/${img1.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cashier.accessToken}` },
    });
    assert.equal(cashierDelImgRes.status, 403);

    // Owner deletes primary image img1 -> trigger promotes img2 cleanly to primary!
    const ownerDelImgRes = await fetch(`${BASE_URL}/api/files/${img1.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    assert.equal(ownerDelImgRes.status, 200);

    const { data: itemAfterImgDel } = await owner.client
      .from('item_catalog_view')
      .select('primary_image_file_id, image_count')
      .eq('id', createdItem.id)
      .single();
    assert.equal(itemAfterImgDel.primary_image_file_id, img2.id);
    assert.equal(itemAfterImgDel.image_count, 1);

    // 8. Role & Security checks
    // Cashier sees selling_price, gets NULL purchase_price & unit_cost, and direct column select fails
    const { data: cashierItem } = await cashier.client
      .from('item_catalog_view')
      .select('selling_price, purchase_price, stock_value')
      .eq('id', createdItem.id)
      .single();
    assert.equal(Number(cashierItem.selling_price), 125);
    assert.equal(cashierItem.purchase_price, null);
    assert.equal(cashierItem.stock_value, null);

    const { error: directCostErr } = await cashier.client
      .from('items')
      .select('purchase_price')
      .eq('id', createdItem.id);
    assert.ok(directCostErr, 'Cashier direct column select on purchase_price must fail');

    const { data: cashierLedger } = await cashier.client
      .from('stock_ledger_view')
      .select('unit_cost, signed_base_qty')
      .eq('item_id', createdItem.id)
      .limit(1)
      .single();
    assert.equal(cashierLedger.unit_cost, null);

    // Cashier cannot call save_item or adjust_stock
    const { error: cashierSaveErr } = await cashier.client.rpc('save_item', {
      p_name: 'Illegal Cashier Item',
      p_base_unit_id: pcsUnit.id,
      p_selling_price: 10,
    });
    assert.ok(cashierSaveErr);

    const { error: cashierAdjErr } = await cashier.client.rpc('adjust_stock', {
      p_item_id: createdItem.id,
      p_direction: 'in',
      p_qty: 1,
      p_reason: 'Illegal adjustment',
    });
    assert.ok(cashierAdjErr);

    // Viewer cannot read items or request signed URL for item image
    const { data: viewerItems } = await viewer.client
      .from('item_catalog_view')
      .select('id')
      .eq('id', createdItem.id);
    assert.equal(viewerItems.length, 0);

    const viewerSignedRes = await fetch(`${BASE_URL}/api/files/signed-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${viewer.accessToken}`,
      },
      body: JSON.stringify({ fileId: img2.id }),
    });
    assert.equal(viewerSignedRes.status, 403);

    // 9. Indexed trigram / barcode search performance check
    const bulkRows = Array.from({ length: 40 }).map((_, idx) => ({
      name: `P3 Benchmark Item ${stamp} #${idx}`,
      sku: `BMK-${stamp}-${idx}`,
      barcode: `891${String(stamp).slice(-8)}${String(idx).padStart(2, '0')}`,
      base_unit_id: kgUnit.id,
      selling_price: 50 + idx,
      purchase_price: 40 + idx,
      gst_rate: 5,
    }));
    const { data: insertedBulk, error: bulkErr } = await supabaseAdmin
      .from('items')
      .insert(bulkRows)
      .select('id');
    assert.ifError(bulkErr);
    for (const row of insertedBulk) createdItemIds.push(row.id);

    const t0 = performance.now();
    const { data: searchHits, error: searchErr } = await owner.client
      .from('item_catalog_view')
      .select('id, name, sku, barcode')
      .or(
        `name.ilike.%Benchmark Item ${stamp} #39%,barcode.eq.891${String(
          stamp
        ).slice(-8)}39`
      );
    const elapsedMs = performance.now() - t0;
    assert.ifError(searchErr);
    assert.equal(searchHits.length, 1);
    assert.ok(
      elapsedMs < 1500,
      `Indexed search round-trip took ${elapsedMs.toFixed(1)}ms`
    );

    const explain = await runAdminSql(
      `EXPLAIN SELECT id, name FROM public.items WHERE name ILIKE '%Benchmark Item ${stamp}%' LIMIT 10;`
    );
    assert.ok(Array.isArray(explain) && explain.length > 0);
  } finally {
    // Thorough cleanup preserving pre-existing workspace ("Sharma Groceries")
    if (createdItemIds.length > 0) {
      const idListSql = createdItemIds.map((id) => `'${id}'`).join(',');
      await runAdminSql(
        `ALTER TABLE public.stock_ledger DISABLE TRIGGER trg_stock_ledger_immutable;
         DELETE FROM public.stock_ledger WHERE item_id IN (${idListSql});
         ALTER TABLE public.stock_ledger ENABLE TRIGGER trg_stock_ledger_immutable;
         DELETE FROM public.stock_balances WHERE item_id IN (${idListSql});
         DELETE FROM public.item_images WHERE item_id IN (${idListSql});
         DELETE FROM public.file_links WHERE entity_type = 'item' AND entity_id IN (${idListSql});
         DELETE FROM public.unit_conversions WHERE item_id IN (${idListSql});
         DELETE FROM public.items WHERE id IN (${idListSql});`
      ).catch(() => undefined);
    }

    if (createdCategoryIds.length > 0) {
      await supabaseAdmin
        .from('item_categories')
        .delete()
        .in('id', createdCategoryIds);
    }
    if (createdBrandIds.length > 0) {
      await supabaseAdmin.from('brands').delete().in('id', createdBrandIds);
    }
    if (uploadedStoragePaths.length > 0) {
      await supabaseAdmin.storage
        .from('bizone-private')
        .remove(uploadedStoragePaths)
        .catch(() => undefined);
    }
    if (createdFileIds.length > 0) {
      await supabaseAdmin.from('files').delete().in('id', createdFileIds);
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
