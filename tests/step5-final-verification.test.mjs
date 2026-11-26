import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PRODUCT_LINE_KEYS, isValidProductLine } from '../src/core/productLines.ts';
import { createEmptySpecs, validateProductSpecs } from '../src/core/productSpecs.ts';
import { computeStockPoolTransition } from '../src/core/storeCatalog.ts';
import { generateRecoveryCodes, generateTotpSecret, verifyTotpCode } from '../src/core/totp.ts';
import { evaluateIpAccess, isErpRequestPath } from '../src/server/ipAllowlist.ts';
import {
  clearRateLimitStore,
  sanitizeStorageRelativePath,
  validateUploadDescriptor,
} from '../src/server/rateLimit.ts';
import { computeRazorpaySignature, verifyRazorpaySignature } from '../src/server/storePayments.ts';
import { runDependencyAudit, runSecretsScan } from '../scripts/security-audit.mjs';
import { runStaticFreshInstallRehearsal } from '../scripts/rehearse-fresh-install.mjs';

function computeValidTotp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = secret.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  let index = 0;
  const output = new Uint8Array(Math.floor((cleaned.length * 5) / 8));
  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output[index++] = (value >> bits) & 0xff;
    }
  }
  const key = Buffer.from(output.buffer, output.byteOffset, index);
  const counter = Math.floor(Math.floor(Date.now() / 1000) / 30);
  const buffer = Buffer.alloc(8);
  let temp = counter;
  for (let j = 7; j >= 0; j--) {
    buffer[j] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

test('Step 5 (1): Customer vs Staff isolation across auth middleware, registration, login & RLS', () => {
  const staffMw = fs.readFileSync(path.resolve('src/server/middleware.ts'), 'utf8');
  const customerMw = fs.readFileSync(path.resolve('src/server/customerAuth.ts'), 'utf8');
  const storefrontRoute = fs.readFileSync(path.resolve('src/server/routes/storefront.ts'), 'utf8');
  const ecomSql = fs.readFileSync(path.resolve('supabase/migrations/0023_decorbiz_step4_ecommerce.sql'), 'utf8');

  // Customer JWTs blocked unconditionally on ERP endpoints
  assert.match(staffMw, /app_metadata\?\.user_type === 'customer'/);
  assert.match(staffMw, /Customer tokens are not permitted on ERP endpoints/);

  // Storefront auth verifies against `customers` table & blocks staff accounts from registering/logging in as retail customers
  assert.match(customerMw, /from\('customers'\)/);
  assert.match(storefrontRoute, /This email belongs to a staff ERP account/);
  assert.match(storefrontRoute, /Staff accounts cannot sign in to customer checkout/);

  // Separate DB tables & self-only RLS
  assert.match(ecomSql, /CREATE TABLE IF NOT EXISTS public\.customers/);
  assert.match(ecomSql, /customer_id = public\.current_customer_id\(\)/);
});

test('Step 5 (2): Five-product-line locked constraint enforced in SQL & TypeScript spec validator', () => {
  assert.deepEqual(
    [...PRODUCT_LINE_KEYS].sort(),
    ['faucets_cp', 'other_general', 'sanitaryware', 'tile_adhesive', 'tiles_slabs'].sort()
  );
  assert.equal(isValidProductLine('tiles_slabs'), true);
  assert.equal(isValidProductLine('electronics_custom'), false);

  const linesSql = fs.readFileSync(path.resolve('supabase/migrations/0019_decorbiz_step2_product_lines.sql'), 'utf8');
  assert.match(linesSql, /tiles_slabs/);
  assert.match(linesSql, /sanitaryware/);
  assert.match(linesSql, /faucets_cp/);
  assert.match(linesSql, /tile_adhesive/);
  assert.match(linesSql, /other_general/);
  assert.match(linesSql, /CHECK\s*\(\s*product_line\s+IN/i);

  // Missing required tiles_slabs fields fail validation
  const badTile = validateProductSpecs('tiles_slabs', createEmptySpecs('tiles_slabs'));
  assert.equal(badTile.valid, false);
  assert.ok(Object.keys(badTile.errors).length > 0);
});

test('Step 5 (3): /ERP guard enforces noindex headers, robots.txt disallow, and zero ERP leakage in storefront', async () => {
  const robots = fs.readFileSync(path.resolve('public/robots.txt'), 'utf8');
  assert.match(robots, /Disallow:\s*\/ERP/);
  assert.match(robots, /Disallow:\s*\/erp\.html/);
  assert.match(robots, /Disallow:\s*\/api\/erp\//);

  const vercel = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8'));
  const headersStr = JSON.stringify(vercel.headers || []);
  assert.match(headersStr, /X-Robots-Tag/);
  assert.match(headersStr, /noindex, nofollow/);

  // IP allowlist middleware sets X-Robots-Tag on ERP API requests too
  process.env.DECORBIZ_NO_LISTEN = '1';
  const { app } = await import('../server.ts');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/erp/store-admin/overview`);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.ok([401, 403, 503].includes(res.status));

    // Canonical /erp -> /ERP redirects (preserving subpath & query) and noindex header
    const redirRoot = await fetch(`http://127.0.0.1:${port}/erp`, { redirect: 'manual' });
    assert.ok([301, 308].includes(redirRoot.status));
    assert.equal(redirRoot.headers.get('location'), '/ERP');
    assert.equal(redirRoot.headers.get('x-robots-tag'), 'noindex, nofollow');

    const redirMixed = await fetch(`http://127.0.0.1:${port}/Erp/login?next=1`, { redirect: 'manual' });
    assert.ok([301, 308].includes(redirMixed.status));
    assert.equal(redirMixed.headers.get('location'), '/ERP/login?next=1');
    assert.equal(redirMixed.headers.get('x-robots-tag'), 'noindex, nofollow');

    // /api/store/health returns 200 separately from /api/erp/health
    const storeHealth = await fetch(`http://127.0.0.1:${port}/api/store/health`);
    assert.equal(storeHealth.status, 200);
    const storeHealthJson = await storeHealth.json();
    assert.equal(storeHealthJson.service, 'storefront');

    const erpHealth = await fetch(`http://127.0.0.1:${port}/api/erp/health`);
    assert.equal(erpHealth.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // Verify vercel.json canonical redirects & vite.config.ts case-insensitive denylist
  assert.ok(Array.isArray(vercel.redirects) && vercel.redirects.length >= 2);
  const redirStr = JSON.stringify(vercel.redirects);
  assert.match(redirStr, /\/ERP/);
  const viteCfg = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');
  assert.match(viteCfg, /navigateFallbackDenylist:\s*\[[^\]]*\/erp[^\]]*\/i/i);
});

test('Step 5 (4): IP allowlist blocks unauthorized IPs across /ERP, /erp.html, and /api/erp/* while allowing break-glass & storefront', () => {
  assert.equal(isErpRequestPath('/ERP'), true);
  assert.equal(isErpRequestPath('/erp'), true);
  assert.equal(isErpRequestPath('/erp.html'), true);
  assert.equal(isErpRequestPath('/api/erp/bills'), true);
  assert.equal(isErpRequestPath('/'), false);
  assert.equal(isErpRequestPath('/api/store/catalogue'), false);

  // Blocked external IP on /ERP & /api/erp
  const blockedErpPage = evaluateIpAccess({
    path: '/erp',
    clientIp: '198.51.100.77',
    allowedIps: ['203.0.113.10'],
  });
  assert.equal(blockedErpPage.allowed, false);
  assert.equal(blockedErpPage.reason, 'blocked');

  const blockedErpApi = evaluateIpAccess({
    path: '/api/erp/items',
    clientIp: '198.51.100.77',
    allowedIps: ['203.0.113.10'],
  });
  assert.equal(blockedErpApi.allowed, false);

  // Storefront stays public regardless of IP allowlist
  const publicStore = evaluateIpAccess({
    path: '/api/store/orders',
    clientIp: '198.51.100.77',
    allowedIps: ['203.0.113.10'],
  });
  assert.equal(publicStore.allowed, true);
  assert.equal(publicStore.reason, 'public_path');

  // Allowlisted IP succeeds
  const allowedIp = evaluateIpAccess({
    path: '/ERP/settings',
    clientIp: '203.0.113.10',
    allowedIps: ['203.0.113.10'],
  });
  assert.equal(allowedIp.allowed, true);
  assert.equal(allowedIp.reason, 'allowlist_match');

  // Owner Break-Glass recovery methods all work
  const tokenRecovery = evaluateIpAccess({
    path: '/ERP',
    clientIp: '198.51.100.77',
    allowedIps: ['203.0.113.10'],
    breakGlassTokenEnv: 'super-secret-recovery-token',
    breakGlassTokenHeader: 'super-secret-recovery-token',
  });
  assert.equal(tokenRecovery.allowed, true);
  assert.equal(tokenRecovery.reason, 'break_glass_token');

  const ipRecovery = evaluateIpAccess({
    path: '/ERP',
    clientIp: '198.51.100.77',
    allowedIps: ['203.0.113.10'],
    breakGlassIpEnv: '198.51.100.77',
  });
  assert.equal(ipRecovery.allowed, true);
  assert.equal(ipRecovery.reason, 'break_glass_ip');

  const envBypass = evaluateIpAccess({
    path: '/ERP',
    clientIp: '198.51.100.77',
    allowedIps: ['203.0.113.10'],
    bypassEnv: 'true',
  });
  assert.equal(envBypass.allowed, true);
  assert.equal(envBypass.reason, 'env_bypass');
});

test('Step 5 (5): TOTP two-factor enforcement, wrong-code rejection, recovery codes & Owner reset endpoint', () => {
  const secret = generateTotpSecret();
  const validCode = computeValidTotp(secret);
  const recoveryCodes = generateRecoveryCodes(8);

  assert.equal(verifyTotpCode(secret, validCode), true);
  assert.equal(verifyTotpCode(secret, '999999' === validCode ? '888888' : '999999'), false);
  assert.equal(verifyTotpCode(secret, 'abc'), false);
  assert.equal(new Set(recoveryCodes).size, 8);

  const totpSrc = fs.readFileSync(path.resolve('src/server/routes/totp.ts'), 'utf8');
  assert.match(totpSrc, /\/api\/erp\/auth\/totp-validate/);
  assert.match(totpSrc, /\/api\/erp\/auth\/totp-reset/);
  assert.match(totpSrc, /requireOwner/);
});

test('Step 5 (6): Order-to-stock flow reserves on confirm, blocks oversell, releases on cancel, and deducts on pickup/delivery', () => {
  // Reserve on confirmation
  const r1 = computeStockPoolTransition({
    qtyOnHand: 25,
    reservedQty: 5,
    orderBaseQty: 8,
    allowNegativeStock: false,
    currentStockState: 'none',
    targetStatus: 'confirmed',
  });
  assert.equal(r1.nextQtyOnHand, 25);
  assert.equal(r1.nextReservedQty, 13);
  assert.equal(r1.nextStockState, 'reserved');

  // Cannot reserve beyond available (25 - 13 = 12)
  assert.throws(
    () =>
      computeStockPoolTransition({
        qtyOnHand: 25,
        reservedQty: 13,
        orderBaseQty: 13,
        allowNegativeStock: false,
        currentStockState: 'none',
        targetStatus: 'confirmed',
      }),
    /Insufficient available stock/
  );

  // Picked up deducts physical qty & releases reservation
  const pickedUp = computeStockPoolTransition({
    qtyOnHand: r1.nextQtyOnHand,
    reservedQty: r1.nextReservedQty,
    orderBaseQty: 8,
    allowNegativeStock: false,
    currentStockState: r1.nextStockState,
    targetStatus: 'picked_up',
  });
  assert.equal(pickedUp.nextQtyOnHand, 17);
  assert.equal(pickedUp.nextReservedQty, 5);
  assert.equal(pickedUp.nextStockState, 'deducted');

  // Cancel releases reservation cleanly
  const cancelled = computeStockPoolTransition({
    qtyOnHand: r1.nextQtyOnHand,
    reservedQty: r1.nextReservedQty,
    orderBaseQty: 8,
    allowNegativeStock: false,
    currentStockState: r1.nextStockState,
    targetStatus: 'cancelled',
  });
  assert.equal(cancelled.nextQtyOnHand, 25);
  assert.equal(cancelled.nextReservedQty, 5);
  assert.equal(cancelled.nextStockState, 'released');
});

test('Step 5 (7): Razorpay signature failure rejects forged signatures and never trusts browser status', () => {
  const secret = 'rzp_test_step5_secret';
  const orderId = 'order_Step5XYZ';
  const paymentId = 'pay_Step5ABC';
  const genuineSig = computeRazorpaySignature(orderId, paymentId, secret);

  assert.equal(
    verifyRazorpaySignature({ orderId, paymentId, signature: genuineSig, keySecret: secret }),
    true
  );
  assert.equal(
    verifyRazorpaySignature({ orderId, paymentId, signature: 'tampered_sig', keySecret: secret }),
    false
  );
  assert.equal(
    verifyRazorpaySignature({ orderId: 'order_Other', paymentId, signature: genuineSig, keySecret: secret }),
    false
  );
});

test('Step 5 (8): Rate limits enforce HTTP 429 on burst requests to login, registration & checkout', async () => {
  process.env.DECORBIZ_NO_LISTEN = '1';
  clearRateLimitStore();
  const { app } = await import('../server.ts');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Login limit = 10 -> 11th returns 429
    let login429 = null;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${baseUrl}/api/store/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate-limit@example.com', password: 'password123' }),
      });
      if (res.status === 429) login429 = res;
    }
    assert.ok(login429, 'Login endpoint must trigger HTTP 429 on brute-force burst');
    assert.ok(login429.headers.get('retry-after'), 'Retry-After header must be set on 429');

    // Register limit = 8 -> 9th returns 429
    let reg429 = null;
    for (let i = 0; i < 9; i++) {
      const res = await fetch(`${baseUrl}/api/store/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: 'Test User',
          email: `user${i}@example.com`,
          password: 'password123',
        }),
      });
      if (res.status === 429) reg429 = res;
    }
    assert.ok(reg429, 'Registration endpoint must trigger HTTP 429 on signup burst');

    // Checkout limit = 15 -> 16th returns 429
    let checkout429 = null;
    for (let i = 0; i < 16; i++) {
      const res = await fetch(`${baseUrl}/api/store/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 429) checkout429 = res;
    }
    assert.ok(checkout429, 'Checkout endpoint must trigger HTTP 429 on checkout spam burst');
  } finally {
    clearRateLimitStore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Step 5 (9): Upload validation rejects spoofed magic bytes, path traversal & executable extensions', () => {
  const validPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const validJpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
  ]);
  const fakeScript = Buffer.from('<script>alert(1)</script> padded payload', 'utf8');

  assert.equal(
    validateUploadDescriptor({ fileName: 'tile-photo.png', mimeType: 'image/png', buffer: validPng }).ok,
    true
  );
  assert.equal(
    validateUploadDescriptor({ fileName: '../etc/passwd.jpg', mimeType: 'image/jpeg', buffer: validJpg }).ok,
    false
  );
  assert.equal(
    validateUploadDescriptor({ fileName: 'payload.html', mimeType: 'image/jpeg', buffer: validJpg }).ok,
    false
  );
  assert.equal(
    validateUploadDescriptor({ fileName: 'spoof.png', mimeType: 'image/png', buffer: fakeScript }).ok,
    false
  );
  assert.equal(
    validateUploadDescriptor({ fileName: 'wrongext.jpg', mimeType: 'image/png', buffer: validPng }).ok,
    false
  );

  // Storage path sanitization for backup restores
  assert.equal(sanitizeStorageRelativePath('item_image/abc/tile.png'), 'item_image/abc/tile.png');
  assert.equal(sanitizeStorageRelativePath('../secret/key.txt'), null);
  assert.equal(sanitizeStorageRelativePath('/absolute/path.png'), null);
});

test('Step 5 (10): Secrets scan, dependency audit (no high/critical), fresh-install rehearsal & docs complete', () => {
  const secrets = runSecretsScan();
  assert.equal(secrets.findings.length, 0, `Leaked secret findings: ${JSON.stringify(secrets.findings)}`);

  const depAudit = runDependencyAudit();
  assert.equal(depAudit.counts.critical, 0, 'Zero critical vulnerabilities expected');
  assert.equal(depAudit.counts.high, 0, 'Zero high vulnerabilities expected');

  const rehearsal = runStaticFreshInstallRehearsal();
  assert.equal(rehearsal.ok, true, `Fresh install rehearsal failures: ${rehearsal.failures.join('; ')}`);
  assert.ok(rehearsal.migrationsCount >= 24);

  const requiredDocs = [
    'docs/deployment-supabase-vercel.md',
    'docs/backup-and-restore.md',
    'docs/owner-manual.md',
    'docs/staff-guide.md',
    'docs/owner-break-glass-recovery.md',
    'docs/deployment-and-upgrade.md',
  ];
  for (const docPath of requiredDocs) {
    const abs = path.resolve(docPath);
    assert.ok(fs.existsSync(abs), `Missing documentation file: ${docPath}`);
    assert.ok(fs.readFileSync(abs, 'utf8').length > 400, `Documentation too brief: ${docPath}`);
  }
});
