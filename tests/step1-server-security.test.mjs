import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

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

test('Step 1 Item 5: package.json removes xlsx and includes helmet, cors, read-excel-file, write-excel-file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  const deps = pkg.dependencies || {};
  assert.equal('xlsx' in deps, false, 'Legacy xlsx dependency must be removed');
  assert.ok(deps.helmet, 'helmet dependency missing');
  assert.ok(deps.cors, 'cors dependency missing');
  assert.ok(deps['read-excel-file'], 'read-excel-file dependency missing');
  assert.ok(deps['write-excel-file'], 'write-excel-file dependency missing');
});

test('Step 1 Item 5: server.ts is split into modular route files and applies helmet, cors, and 2mb JSON limit', () => {
  const serverSrc = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
  const lineCount = serverSrc.split('\n').length;
  assert.ok(lineCount < 220, `Expected slim server.ts after route split, got ${lineCount} lines`);
  assert.match(serverSrc, /import helmet from 'helmet'/);
  assert.match(serverSrc, /import cors from 'cors'/);
  assert.match(serverSrc, /DEFAULT_JSON_LIMIT/);

  const middlewareSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/server/middleware.ts'),
    'utf8'
  );
  assert.ok(middlewareSrc.includes("DEFAULT_JSON_LIMIT = '2mb'"));

  const routesDir = path.resolve(process.cwd(), 'src/server/routes');
  const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
  assert.ok(routeFiles.length >= 8, 'Expected modular route files under src/server/routes');
});

test('Step 1 Item 5: live HTTP checks verify helmet headers, CORS allowlist, and 2 MB JSON limit (413)', async () => {
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
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server.ts exited early (${child.exitCode}): ${stderr}`);
      }
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) {
          ready = true;
          // 1. Helmet headers present and preview-friendly
          assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
          assert.equal(res.headers.get('x-powered-by'), null);
          assert.equal(res.headers.get('x-frame-options'), null);
          assert.equal(
            res.headers.get('referrer-policy'),
            'strict-origin-when-cross-origin'
          );
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, `Server did not become ready within 8s. stderr=${stderr}`);

    // 2. CORS allows same-host origin and blocks unknown third-party origin
    const allowedOrigin = `http://127.0.0.1:${port}`;
    const sameOriginRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: allowedOrigin },
    });
    assert.equal(sameOriginRes.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.equal(sameOriginRes.headers.get('access-control-allow-credentials'), 'true');

    const foreignOriginRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(foreignOriginRes.headers.get('access-control-allow-origin'), null);

    // 3. Default 2 MB JSON payload limit returns 413 on oversized request
    const oversizedPayload = JSON.stringify({ data: 'x'.repeat(2_300_000) });
    const tooLargeRes = await fetch(`${baseUrl}/api/setup/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    });
    assert.equal(tooLargeRes.status, 413);
    const tooLargeBody = await tooLargeRes.json();
    assert.match(tooLargeBody.error || '', /size limit/i);

    // 4. Malformed JSON returns 400 clean JSON error
    const badJsonRes = await fetch(`${baseUrl}/api/setup/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"badJson":',
    });
    assert.equal(badJsonRes.status, 400);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => {
      child.once('exit', r);
      setTimeout(r, 1000);
    });
  }
});
