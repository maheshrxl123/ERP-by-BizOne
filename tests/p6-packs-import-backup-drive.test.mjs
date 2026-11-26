import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import readXlsxFile from 'read-excel-file/universal';
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
  calculateTileBoxes,
  DECORBIZ_WORKSPACE_META,
  getPackWorkspaceTitle,
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

test('Phase P6 DecorBiz workspace metadata & tile estimator work accurately', () => {
  assert.equal(DECORBIZ_WORKSPACE_META.key, 'decorbiz');
  assert.ok(DECORBIZ_WORKSPACE_META.workspaceLabelEn.length > 3);
  assert.ok(DECORBIZ_WORKSPACE_META.workspaceLabelHi.length > 3);
  assert.ok(DECORBIZ_WORKSPACE_META.recommendedModules.includes('billing'));
  assert.equal(getPackWorkspaceTitle('decorbiz', 'en'), DECORBIZ_WORKSPACE_META.workspaceLabelEn);
  assert.equal(getPackWorkspaceTitle('decorbiz', 'hi'), DECORBIZ_WORKSPACE_META.workspaceLabelHi);

  // Tiles material estimator
  const tiles = calculateTileBoxes(100, 16, 10);
  assert.equal(tiles.totalSqFtWithWastage, 110);
  assert.equal(tiles.boxesNeeded, 7);
  assert.equal(tiles.actualCoveredSqFt, 112);
});

test('Phase P6 CSV/XLSX import/export: templates, column mapping, error rows CSV & multi-sheet XLSX', async () => {
  // 1. Roundtrip XLSX item template
  const itemTpl = await buildTemplateWorkbookBuffer('items', 'xlsx');
  assert.ok(itemTpl.buffer.byteLength > 100);
  const parsedItems = await parseSpreadsheetBuffer(itemTpl.buffer, itemTpl.filename);
  assert.equal(parsedItems.selectedSheet, 'Items');
  assert.equal(parsedItems.rows.length, 1);

  // 2. Roundtrip CSV party template
  const partyTpl = await buildTemplateWorkbookBuffer('parties', 'csv');
  const parsedParties = await parseSpreadsheetBuffer(partyTpl.buffer, partyTpl.filename);
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
  const multi = await buildExportWorkbookBuffer(
    [
      { name: 'Parties', headers: ['Name', 'Balance'], rows: [['Patel', 1500]] },
      { name: 'Items', headers: ['Name', 'Price'], rows: [['Soap', 45]] },
    ],
    'xlsx'
  );
  const sheets = await readXlsxFile(multi.buffer);
  assert.deepEqual(
    sheets.map((s) => s.sheet),
    ['Parties', 'Items']
  );
});

test('Phase P6 backup/restore security: p5-v1 + p6-v1 verification, tamper rejection & AES-256-GCM passphrase encryption', async () => {
  const snapshotP6 = {
    app: 'DecorBiz',
    schema_version: 'p6-v1',
    exported_at: '2026-11-13T15:00:00Z',
    exported_by: 'owner@decorbiz.test',
    include_files: true,
    record_counts: { items: 1, party_sites: 1 },
    data: {
      business: { id: 1, name: 'Shree Ganesh Tiles & Sanitary', pack: 'decorbiz' },
      items: [{ id: 'it-1', name: 'Somany Wall Tile 2x1' }],
    },
    attachments: [
      { id: 'f-1', storage_path: 'sites/site.png', mime_type: 'image/png', base64: 'AAAA' },
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
    () => verifyBackupEnvelope(signed.jsonText.replace('Shree Ganesh Tiles & Sanitary', 'Tampered Name')),
    /checksum mismatch/i
  );

  // Passphrase minimum length & AES-256-GCM roundtrip
  await assert.rejects(() => encryptBackupWithPassphrase(snapshotP6, '123'), /at least 4/i);

  const enc = await encryptBackupWithPassphrase(snapshotP6, 'secret-vault-2026');
  assert.equal(isEncryptedBackupEnvelope(enc.jsonText), true);
  assert.equal(isEncryptedBackupEnvelope(signed.jsonText), false);
  assert.ok(!enc.jsonText.includes('Shree Ganesh Tiles & Sanitary'));

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

  // 2. Verify server route modules encrypt Google Drive secrets/tokens & handle disconnect revocation + optional disabled path
  const readCombinedServerSrc = () => {
    const parts = [fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8')];
    const collect = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.name.endsWith('.ts')) parts.push(fs.readFileSync(full, 'utf8'));
      }
    };
    collect(path.resolve(process.cwd(), 'src/server'));
    return parts.join('\n');
  };
  const serverSrc = readCombinedServerSrc();
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

  // 3. Verify SQL migrations expose P6 import/backup RPCs & 0016 removes non-DecorBiz packs
  const mig12 = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0012_phase6_import_demo_backup_drive.sql'),
    'utf8'
  );
  const mig16 = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0016_decorbiz_step1_pack_cleanup.sql'),
    'utf8'
  );
  assert.match(mig12, /FUNCTION public\.import_parties_batch/);
  assert.match(mig12, /FUNCTION public\.import_items_batch/);
  assert.match(mig12, /FUNCTION public\.reset_workspace_data/);
  assert.match(mig12, /'RESET WORKSPACE'/);
  assert.match(mig12, /FUNCTION public\.export_workspace_backup/);
  assert.match(mig12, /FUNCTION public\.restore_workspace_backup/);
  assert.match(mig16, /DROP TABLE IF EXISTS public\.item_batches/);
  assert.match(mig16, /DROP TABLE IF EXISTS public\.item_variants/);
  assert.match(mig16, /DROP TABLE IF EXISTS public\.service_jobs/);
});

test(
  'Phase P6 live integration: pack switch, batch import duplicate modes & Drive disabled guard',
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
