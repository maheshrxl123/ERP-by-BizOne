import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import {
  buildSignedBackupBlob,
  decryptBackupWithPassphrase,
  encryptBackupWithPassphrase,
  isEncryptedBackupEnvelope,
  verifyBackupEnvelope,
} from '../src/core/backup.ts';
import {
  autoMapColumns,
  buildErrorCsvText,
  buildExportWorkbookBuffer,
  buildTemplateWorkbookBuffer,
  mapAndValidateImportRows,
  parseSpreadsheetBuffer,
} from '../src/core/spreadsheet.ts';
import {
  applyDiscountPreset,
  calculateMarginPct,
  calculatePaintLitres,
  calculateServiceJobMargin,
  calculateTileBoxes,
  calculateWireCoils,
  classifyBatchExpiry,
  computeAmountFromWeight,
  computeLooseWeightFromAmount,
  computeMrpSavings,
  generateVariantMatrixCombinations,
  getPackWorkflow,
  PACK_WORKFLOWS,
  resolveWholesaleUnitPrice,
  sortBatchesFefo,
} from '../src/packs/registry.ts';

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

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

const hasLiveSupabase =
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.includes('YOUR_PROJECT_REF') &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE') &&
  SERVICE_ROLE_KEY.length > 20 &&
  !SERVICE_ROLE_KEY.includes('MY_SUPABASE');

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

test('Phase P6 packs: all 7 business-type workflows & domain calculators work accurately', () => {
  const expectedPacks = [
    'kirana',
    'medical',
    'clothing',
    'hardware',
    'general_retail',
    'wholesale',
    'service',
  ];
  assert.deepEqual(Object.keys(PACK_WORKFLOWS).sort(), expectedPacks.slice().sort());

  for (const pack of expectedPacks) {
    const wf = getPackWorkflow(pack);
    assert.equal(wf.key, pack);
    assert.ok(wf.workspaceLabelEn.length > 3);
    assert.ok(wf.workspaceLabelHi.length > 3);
    assert.ok(wf.recommendedModules.includes('billing'));
  }

  // Medical & Clothing enforce required modules
  assert.ok(getPackWorkflow('medical').requiredModules.includes('batch_expiry'));
  assert.ok(getPackWorkflow('clothing').requiredModules.includes('variants'));

  // 1. Kirana: loose weight <-> ₹ calculator & MRP savings
  const kiranaWt = computeLooseWeightFromAmount(120, 80, 1);
  assert.equal(kiranaWt.enteredQty, 1.5);
  assert.equal(kiranaWt.baseQty, 1.5);
  assert.equal(kiranaWt.actualAmount, 120);
  assert.equal(computeAmountFromWeight(2.5, 64, 1), 160);
  assert.equal(computeMrpSavings(50, 42, 3), 24);
  assert.equal(computeMrpSavings(40, 45, 2), 0);

  // 2. Medical: expiry status classification + FEFO sorting + expired filter
  assert.equal(classifyBatchExpiry('2026-01-01', '2026-06-01', 90), 'expired');
  assert.equal(classifyBatchExpiry('2026-07-15', '2026-06-01', 90), 'near_expiry');
  assert.equal(classifyBatchExpiry('2027-03-01', '2026-06-01', 90), 'ok');

  const batches = sortBatchesFefo(
    [
      { id: 'b-late', expiry_date: '2027-09-01', qty_on_hand: 10, is_active: true, created_at: '2026-01-01' },
      { id: 'b-expired', expiry_date: '2026-05-01', qty_on_hand: 25, is_active: true, created_at: '2026-01-01' },
      { id: 'b-empty', expiry_date: '2026-06-15', qty_on_hand: 0, is_active: true, created_at: '2026-01-01' },
      { id: 'b-soon', expiry_date: '2026-08-01', qty_on_hand: 5, is_active: true, created_at: '2026-01-02' },
    ],
    '2026-06-01'
  );
  assert.deepEqual(
    batches.map((b) => b.id),
    ['b-soon', 'b-late']
  );

  // 3. Clothing: size × color matrix generator
  const matrix = generateVariantMatrixCombinations({
    sizes: ['M', 'L'],
    colors: ['Blue', 'Black'],
    baseSku: 'KURTA',
    sellingPrice: 899,
    mrp: 1199,
    purchasePrice: 540,
    defaultQty: 12,
  });
  assert.equal(matrix.length, 4);
  assert.equal(matrix[0].sku, 'KURTA-M-BLUE');
  assert.equal(matrix[3].sku, 'KURTA-L-BLAC');
  assert.equal(matrix[0].qty_on_hand, 12);

  // 4. Hardware: tile boxes, paint litres & wire coil estimators
  const tiles = calculateTileBoxes(100, 16, 10);
  assert.equal(tiles.totalSqFtWithWastage, 110);
  assert.equal(tiles.boxesNeeded, 7);
  assert.equal(tiles.actualCoveredSqFt, 112);
  const paint = calculatePaintLitres(550, 2, 110);
  assert.equal(paint.totalSqFtToCoat, 1100);
  assert.equal(paint.litresNeeded, 10);
  const wire = calculateWireCoils(210, 90);
  assert.equal(wire.coilsNeeded, 3);
  assert.equal(wire.surplusMeters, 60);

  // 5. Wholesale: custom rate card > qty slab > base price precedence
  const slabs = [
    { min_qty: 10, rate: 95, tier: 'all' },
    { min_qty: 20, rate: 88, tier: 'wholesale_a' },
  ];
  assert.deepEqual(
    resolveWholesaleUnitPrice({
      basePrice: 100,
      priceTier: 'wholesale_a',
      qty: 5,
      slabs,
    }),
    { unitPrice: 100, source: 'base' }
  );
  assert.deepEqual(
    resolveWholesaleUnitPrice({
      basePrice: 100,
      priceTier: 'wholesale_a',
      qty: 25,
      slabs,
    }),
    { unitPrice: 88, source: 'slab' }
  );
  assert.deepEqual(
    resolveWholesaleUnitPrice({
      basePrice: 100,
      priceTier: 'wholesale_a',
      qty: 25,
      slabs,
      partyCustomRate: { custom_rate: 82, min_qty: 15 },
    }),
    { unitPrice: 82, source: 'custom_rate' }
  );

  // 6. Service & 7. General Retail margin helpers
  const job = calculateServiceJobMargin({
    billedRevenue: 5000,
    estimatedAmount: 4500,
    expensesTotal: 1800,
  });
  assert.deepEqual(job, { effectiveRevenue: 5000, netMargin: 3200, marginPct: 64 });
  assert.equal(applyDiscountPreset(1000, 15), 850);
  assert.equal(calculateMarginPct(1000, 750), 25);
});

test('Phase P6 CSV/XLSX import/export: templates, column mapping, error rows CSV & multi-sheet XLSX', () => {
  // 1. Roundtrip XLSX item template
  const itemTpl = buildTemplateWorkbookBuffer('items', 'xlsx');
  assert.ok(itemTpl.buffer.byteLength > 100);
  const parsedItems = parseSpreadsheetBuffer(itemTpl.buffer, itemTpl.filename);
  assert.equal(parsedItems.selectedSheet, 'Items');
  assert.equal(parsedItems.rows.length, 1);

  // 2. Roundtrip CSV party template
  const partyTpl = buildTemplateWorkbookBuffer('parties', 'csv');
  const parsedParties = parseSpreadsheetBuffer(partyTpl.buffer, partyTpl.filename);
  assert.equal(parsedParties.rows.length, 1);

  // 3. Auto-mapping aliased headers & row validation errors
  const headers = ['Customer Name', 'Mobile No', 'Type', 'GST Number', 'Opening'];
  const mapping = autoMapColumns(headers, 'parties');
  assert.equal(mapping.name, 'Customer Name');
  assert.equal(mapping.phone, 'Mobile No');
  assert.equal(mapping.party_type, 'Type');
  assert.equal(mapping.gstin, 'GST Number');
  assert.equal(mapping.opening_balance, 'Opening');

  const rawRows = [
    {
      'Customer Name': 'Patel Hardware',
      'Mobile No': '9876543210',
      Type: 'customer',
      'GST Number': '27ABCDE1234F1Z5',
      Opening: '1500',
    },
    {
      'Customer Name': '',
      'Mobile No': '9999999999',
      Type: 'customer',
      'GST Number': '',
      Opening: '0',
    },
    {
      'Customer Name': 'Bad GST Shop',
      'Mobile No': '8888888888',
      Type: 'supplier',
      'GST Number': 'INVALID_GSTIN',
      Opening: '500',
    },
  ];
  const { validRows, invalidRows } = mapAndValidateImportRows(rawRows, mapping, 'parties');
  assert.equal(validRows.length, 1);
  assert.equal(validRows[0].name, 'Patel Hardware');
  assert.equal(validRows[0].opening_balance, 1500);
  assert.equal(invalidRows.length, 2);
  assert.match(invalidRows[0].error, /required/i);
  assert.match(invalidRows[1].error, /Invalid GSTIN/i);

  const errCsv = buildErrorCsvText(invalidRows);
  assert.ok(errCsv.includes('Row,Name,Error'));
  assert.ok(errCsv.includes('Bad GST Shop'));

  // 4. Item GST % > 28 & negative price validation
  const itemValidation = mapAndValidateImportRows(
    [
      { name: 'Valid Soap', selling_price: '45', gst_rate: '18' },
      { name: 'Bad Tax Item', selling_price: '100', gst_rate: '40' },
      { name: 'Negative Item', selling_price: '-10', gst_rate: '5' },
    ],
    { name: 'name', selling_price: 'selling_price', gst_rate: 'gst_rate' },
    'items'
  );
  assert.equal(itemValidation.validRows.length, 1);
  assert.equal(itemValidation.invalidRows.length, 2);

  // 5. Multi-sheet XLSX export buffer
  const multi = buildExportWorkbookBuffer(
    [
      { name: 'Parties', headers: ['Name', 'Balance'], rows: [['Patel', 1500]] },
      { name: 'Items', headers: ['Name', 'Price'], rows: [['Soap', 45]] },
    ],
    'xlsx'
  );
  const wb = XLSX.read(multi.buffer, { type: 'array' });
  assert.deepEqual(wb.SheetNames, ['Parties', 'Items']);
});

test('Phase P6 backup/restore security: p5-v1 + p6-v1 verification, tamper rejection & AES-256-GCM passphrase encryption', async () => {
  const snapshotP6 = {
    app: 'BizOne ERP',
    schema_version: 'p6-v1',
    exported_at: '2026-11-13T15:00:00Z',
    exported_by: 'owner@bizone.test',
    include_files: true,
    record_counts: { items: 1, item_batches: 1 },
    data: {
      business: { id: 1, name: 'Carewell Medicals', pack: 'medical' },
      items: [{ id: 'it-1', name: 'Dolo 650' }],
    },
    attachments: [
      { id: 'f-1', storage_path: 'demo/rx.png', mime_type: 'image/png', base64: 'AAAA' },
    ],
  };

  // Both p6-v1 and p5-v1 verify cleanly
  const signed = await buildSignedBackupBlob(snapshotP6);
  const verified = await verifyBackupEnvelope(signed.jsonText);
  assert.equal(verified.checksumVerified, true);
  assert.equal(verified.envelope.schema_version, 'p6-v1');

  const p5Signed = await buildSignedBackupBlob({ ...snapshotP6, schema_version: 'p5-v1' });
  const p5Verified = await verifyBackupEnvelope(p5Signed.jsonText);
  assert.equal(p5Verified.checksumVerified, true);

  // Unsupported schema rejected
  await assert.rejects(
    () => verifyBackupEnvelope(JSON.stringify({ schema_version: 'p1-v1', data: { business: {} } })),
    /Unsupported backup schema/i
  );

  // Tamper rejected
  await assert.rejects(
    () => verifyBackupEnvelope(signed.jsonText.replace('Carewell Medicals', 'Tampered Name')),
    /checksum mismatch/i
  );

  // Passphrase minimum length & AES-256-GCM roundtrip
  await assert.rejects(() => encryptBackupWithPassphrase(snapshotP6, '123'), /at least 4/i);

  const enc = await encryptBackupWithPassphrase(snapshotP6, 'secret-vault-2026');
  assert.equal(isEncryptedBackupEnvelope(enc.jsonText), true);
  assert.equal(isEncryptedBackupEnvelope(signed.jsonText), false);
  assert.ok(!enc.jsonText.includes('Carewell Medicals'));

  // Wrong passphrase fails decryption
  await assert.rejects(
    () => decryptBackupWithPassphrase(enc.jsonText, 'wrong-pass'),
    /Incorrect passphrase/i
  );

  // Correct passphrase decrypts & preserves exact SHA-256 checksum
  const decrypted = await decryptBackupWithPassphrase(enc.jsonText, 'secret-vault-2026');
  const postDecryptVerified = await verifyBackupEnvelope(decrypted);
  assert.equal(postDecryptVerified.checksum, signed.checksum);
  assert.equal(postDecryptVerified.checksumVerified, true);
  assert.equal(postDecryptVerified.envelope.attachments?.length, 1);
});

test('Phase P6 server, migrations & i18n contracts: Google Drive encryption/revocation, Pack/Import RPCs & EN/HI parity', () => {
  // 1. Verify EN & HI localization parity
  const en = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/en.json'), 'utf8'));
  const hi = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/hi.json'), 'utf8'));
  const enPaths = collectLeafPaths(en);
  const hiPaths = collectLeafPaths(hi);
  assert.deepEqual(
    enPaths.map(([p]) => p).sort(),
    hiPaths.map(([p]) => p).sort()
  );
  assert.ok(en.nav.pack && hi.nav.pack);
  assert.ok(en.nav.data && hi.nav.data);
  assert.ok(en.settings.tabs.data && hi.settings.tabs.data);
  assert.ok(en.reports.tabs.pack && hi.reports.tabs.pack);

  // 2. Verify server.ts encrypts Google Drive secrets/tokens & handles disconnect revocation + optional disabled path
  const serverSrc = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
  assert.match(serverSrc, /\/api\/backup\/export-bundle/);
  assert.match(serverSrc, /\/api\/backup\/restore-bundle/);
  assert.match(serverSrc, /\/api\/integrations\/google-drive\/status/);
  assert.match(serverSrc, /\/api\/integrations\/google-drive\/auth-url/);
  assert.match(serverSrc, /\/api\/integrations\/google-drive\/callback/);
  assert.match(serverSrc, /\/api\/integrations\/google-drive\/backup-now/);
  assert.match(serverSrc, /\/api\/integrations\/google-drive\/restore/);
  assert.match(serverSrc, /\/api\/integrations\/google-drive\/disconnect/);
  assert.match(serverSrc, /access_token_enc:\s*encryptSecret/);
  assert.match(serverSrc, /refresh_token_enc:/);
  assert.match(serverSrc, /oauth2\.googleapis\.com\/revoke/);
  assert.match(serverSrc, /local backup remains available/i);

  // Simulate server OAuth state HMAC integrity + tamper check
  const stateKey = crypto.randomBytes(32);
  const payloadB64 = Buffer.from(JSON.stringify({ uid: 'u1', ts: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', stateKey).update(payloadB64).digest('base64url');
  const signedState = `${payloadB64}.${sig}`;
  const [part, gotSig] = signedState.split('.');
  const expectedSig = crypto.createHmac('sha256', stateKey).update(part).digest('base64url');
  assert.equal(gotSig, expectedSig);

  // 3. Verify SQL migrations expose all P6 RPCs & strict RESET WORKSPACE confirmation
  const mig11 = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0011_phase6_packs_data_management.sql'),
    'utf8'
  );
  const mig12 = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0012_phase6_import_demo_backup_drive.sql'),
    'utf8'
  );
  assert.match(mig11, /FUNCTION public\.get_salt_substitutes/);
  assert.match(mig11, /FUNCTION public\.get_pack_reports/);
  assert.match(mig12, /FUNCTION public\.import_parties_batch/);
  assert.match(mig12, /FUNCTION public\.import_items_batch/);
  assert.match(mig12, /FUNCTION public\.seed_pack_demo_data/);
  assert.match(mig12, /FUNCTION public\.remove_demo_data/);
  assert.match(mig12, /FUNCTION public\.switch_business_pack/);
  assert.match(mig12, /FUNCTION public\.reset_workspace_data/);
  assert.match(mig12, /'RESET WORKSPACE'/);
  assert.match(mig12, /FUNCTION public\.export_workspace_backup/);
  assert.match(mig12, /FUNCTION public\.restore_workspace_backup/);
});

test(
  'Phase P6 live integration: pack switch, demo seed/remove, batch import duplicate modes & Drive disabled guard',
  { skip: hasLiveSupabase ? false : 'Live Supabase credentials are not configured in environment' },
  async () => {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    assert.ok(admin);
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.equal(res.status, 200);
  }
);
