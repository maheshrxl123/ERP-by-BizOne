import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { buildSignedBackupBlob, verifyBackupEnvelope } from '../src/core/backup.ts';
import { escapeCsvCell } from '../src/core/format.ts';
import { buildErrorCsvText, buildExportWorkbookBuffer, parseSpreadsheetBuffer } from '../src/core/spreadsheet.ts';
import { isSupabaseConfigured, supabase } from '../src/core/supabase.ts';
import { IndiaGstTaxEngine } from '../src/core/taxEngine.ts';

function walkDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDir(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test('Audit Fix: verifyBackupEnvelope accepts p5-v1, p6-v1, and p7-v1 and rejects invalid schemas or tampered data', async () => {
  for (const version of ['p5-v1', 'p6-v1', 'p7-v1']) {
    const blob = await buildSignedBackupBlob({
      app: 'DecorBiz',
      schema_version: version,
      exported_at: new Date().toISOString(),
      record_counts: { parties: 1 },
      data: {
        business: { id: 'biz-1', name: 'Test Store' },
        parties: [{ id: 'p-1', name: 'Cash' }],
      },
    });
    const verified = await verifyBackupEnvelope(blob.jsonText);
    assert.equal(verified.checksumVerified, true);
    assert.equal(verified.envelope.schema_version, version);
  }

  const badVersionBlob = await buildSignedBackupBlob({
    app: 'DecorBiz',
    schema_version: 'p99-v1',
    exported_at: new Date().toISOString(),
    record_counts: {},
    data: { business: { id: 'biz-1' } },
  });
  await assert.rejects(
    () => verifyBackupEnvelope(badVersionBlob.jsonText),
    /Unsupported backup schema version/
  );

  const p7Blob = await buildSignedBackupBlob({
    app: 'DecorBiz',
    schema_version: 'p7-v1',
    exported_at: new Date().toISOString(),
    record_counts: {},
    data: { business: { id: 'biz-1', name: 'Original' } },
  });
  const tampered = p7Blob.jsonText.replace('Original', 'Tampered');
  await assert.rejects(
    () => verifyBackupEnvelope(tampered),
    /checksum mismatch/i
  );
});

test('Audit Fix: escapeCsvCell and spreadsheet CSV exporters neutralize formula injection payloads', async () => {
  assert.equal(escapeCsvCell('=CMD|"/C calc"!A0'), '"\'=CMD|""/C calc""!A0"');
  assert.equal(escapeCsvCell('+SUM(A1:A2)'), "'+SUM(A1:A2)");
  assert.equal(escapeCsvCell('-1+1'), "'-1+1");
  assert.equal(escapeCsvCell('@SUM(1,2)'), '"\'@SUM(1,2)"');
  assert.equal(escapeCsvCell('Normal Item'), 'Normal Item');

  const csvExport = await buildExportWorkbookBuffer(
    [
      {
        name: 'Parties',
        headers: ['Name', 'Balance'],
        rows: [
          ['=HYPERLINK("http://evil.example","Click")', 100],
          ['+2+3', 50],
        ],
      },
    ],
    'csv'
  );
  const csvStr = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvExport.buffer);
  assert.ok(csvStr.startsWith('\uFEFF'), 'CSV export includes UTF-8 BOM');
  assert.ok(csvStr.includes("'=HYPERLINK"), 'CSV export neutralizes leading =');
  assert.ok(csvStr.includes("'+2+3"), 'CSV export neutralizes leading +');

  const errCsv = buildErrorCsvText([
    { row: 2, name: '@EvilParty', error: '=1+1' },
  ]);
  assert.ok(errCsv.includes("'@EvilParty"));
  assert.ok(errCsv.includes("'=1+1"));

  // XLSX keeps raw string values (no spurious quote prefix in workbook sheet objects)
  const xlsxExport = await buildExportWorkbookBuffer(
    [{ name: 'Sheet1', headers: ['Col'], rows: [['+91 9876543210']] }],
    'xlsx'
  );
  const parsed = await parseSpreadsheetBuffer(xlsxExport.buffer, 'export.xlsx');
  assert.equal(parsed.rows[0].Col, '+91 9876543210');
});

test('Audit Fix: IndiaGstTaxEngine uses decimal-safe roundHalfUp without 1.005 IEEE-754 drift', () => {
  const engine = new IndiaGstTaxEngine();
  const res = engine.computeLineTax({
    itemName: 'Precision Item',
    hsnCode: '1001',
    qty: 1,
    unitPrice: 1.005,
    discountPct: 0,
    gstRate: 0,
    taxInclusive: false,
    isInterstate: false,
    gstRegistered: true,
  });
  assert.equal(res.grossAmount, 1.01);
  assert.equal(res.lineTotal, 1.01);
});

test('Audit Fix: src/core/supabase.ts imports safely in Node without import.meta.env crash', () => {
  assert.equal(typeof isSupabaseConfigured, 'boolean');
  assert.ok(supabase && typeof supabase.from === 'function');
});

test('Audit Fix: all .rpc() and .from() calls in src/ and server.ts exist in SQL migrations', () => {
  const sqlFiles = walkDir(path.resolve(process.cwd(), 'supabase/migrations')).filter((f) =>
    f.endsWith('.sql')
  );
  const sqlFns = new Set();
  const sqlRelations = new Set();

  for (const file of sqlFiles) {
    const sql = fs.readFileSync(file, 'utf8');
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-zA-Z0-9_]+)/g)) {
      sqlFns.add(m[1]);
    }
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.([a-zA-Z0-9_]+)/g)) {
      sqlRelations.add(m[1]);
    }
    for (const m of sql.matchAll(/CREATE(?: OR REPLACE)? VIEW public\.([a-zA-Z0-9_]+)/g)) {
      sqlRelations.add(m[1]);
    }
  }

  const codeFiles = [
    ...walkDir(path.resolve(process.cwd(), 'src')),
    path.resolve(process.cwd(), 'server.ts'),
  ].filter((f) => /\.(ts|tsx)$/.test(f));

  const missingRpcs = [];
  const missingRelations = [];

  for (const file of codeFiles) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(/\.rpc\(\s*'([a-zA-Z0-9_]+)'/g)) {
        if (!sqlFns.has(m[1])) {
          missingRpcs.push(`${path.relative(process.cwd(), file)}:${idx + 1} -> ${m[1]}`);
        }
      }
      for (const m of line.matchAll(/\.from\(\s*'([a-zA-Z0-9_]+)'/g)) {
        if (!sqlRelations.has(m[1])) {
          missingRelations.push(`${path.relative(process.cwd(), file)}:${idx + 1} -> ${m[1]}`);
        }
      }
    });
  }

  assert.deepEqual(missingRpcs, []);
  assert.deepEqual(missingRelations, []);
});

test('Audit Fix: node server.ts boots in production mode and serves /api/health cleanly', async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const deadline = Date.now() + 8000;
    let health = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server.ts exited prematurely (${child.exitCode}): ${stderr}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          health = await res.json();
          break;
        }
      } catch {
        // retry until listening
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(health, `Expected /api/health response within 8s. stderr=${stderr}`);
    assert.equal(typeof health.ok, 'boolean');
    assert.equal('supabaseConfigured' in health, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => {
      child.once('exit', r);
      setTimeout(r, 1000);
    });
  }
});
