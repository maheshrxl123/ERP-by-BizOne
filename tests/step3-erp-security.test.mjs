import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotpCode,
} from '../src/core/totp.ts';
import {
  createTotpProofToken,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotpProofToken,
} from '../src/server/totpSecurity.ts';
import { evaluateIpAccess, requireIpAllowlist } from '../src/server/ipAllowlist.ts';
import { VITE_CLIENT_STUB } from '../src/server/viteClientStub.ts';

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

test('Step 3: TOTP 2FA secret generation, code verification, hashed recovery codes, and proof tokens work correctly', () => {
  const secret = generateTotpSecret();
  assert.ok(secret, 'TOTP secret generated');
  assert.equal(typeof secret, 'string');

  const recoveryCodes = generateRecoveryCodes(8);
  assert.equal(recoveryCodes.length, 8);

  const hashed = hashRecoveryCode(recoveryCodes[0]);
  assert.match(hashed, /^sha256:[a-f0-9]{64}$/);
  assert.equal(verifyRecoveryCode(recoveryCodes[0].toLowerCase(), hashed), true);
  assert.equal(verifyRecoveryCode('WRONGCODE', hashed), false);

  const validCode = computeValidTotp(secret);
  assert.equal(verifyTotpCode(secret, validCode), true, 'Valid TOTP code must verify');

  const wrongCode = validCode === '000000' ? '111111' : '000000';
  assert.equal(verifyTotpCode(secret, wrongCode), false, 'Wrong TOTP code must fail');

  const proof = createTotpProofToken('user-123', 60);
  assert.equal(verifyTotpProofToken('user-123', proof), true);
  assert.equal(verifyTotpProofToken('user-456', proof), false);
  assert.equal(verifyTotpProofToken('user-123', `${proof}tampered`), false);
});

test('Step 3: robots.txt exists and disallows /ERP', () => {
  const robotsPath = path.resolve(process.cwd(), 'public/robots.txt');
  assert.ok(fs.existsSync(robotsPath), 'public/robots.txt must exist');
  const content = fs.readFileSync(robotsPath, 'utf8');
  assert.match(content, /Disallow:\s*\/ERP/);
});

test('Step 3: vercel.json & dual Vite configs isolate /ERP/ base path from storefront PWA', () => {
  const vercelPath = path.resolve(process.cwd(), 'vercel.json');
  assert.ok(fs.existsSync(vercelPath));
  const vercel = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
  const hasErpRewrite = (vercel.rewrites || []).some(
    (r) => r.source && r.source.includes('ERP') && r.destination === '/ERP/erp.html'
  );
  assert.ok(hasErpRewrite, 'vercel.json must rewrite /ERP to /ERP/erp.html');

  const erpVite = fs.readFileSync(path.resolve(process.cwd(), 'vite.erp.config.ts'), 'utf8');
  assert.match(erpVite, /base:\s*['"]\/ERP\/['"]/);
  assert.match(erpVite, /outDir:\s*['"]dist\/ERP['"]/);

  const storeVite = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
  assert.match(storeVite, /navigateFallbackDenylist:.*ERP/);
});

test('Step 3: Vite dev client stub provides full hot context (including prune) and CSS injectors', async () => {
  const encoded = `data:text/javascript;base64,${Buffer.from(VITE_CLIENT_STUB, 'utf8').toString('base64')}`;
  const mod = await import(encoded);
  assert.equal(typeof mod.updateStyle, 'function');
  assert.equal(typeof mod.removeStyle, 'function');
  assert.equal(typeof mod.createHotContext, 'function');
  const hot = mod.createHotContext('/src/index.css');
  for (const method of ['accept', 'acceptExports', 'dispose', 'prune', 'decline', 'invalidate', 'on', 'off', 'send']) {
    assert.equal(typeof hot[method], 'function', `hot.${method} must be a function`);
  }
  assert.doesNotThrow(() => hot.prune(() => {}));
});

test('Step 3: IP allowlist allows loopback/storefront paths and returns 403 for blocked IPs on /ERP & /api/erp/*', async () => {
  const blockedErp = evaluateIpAccess({
    path: '/ERP',
    clientIp: '198.51.100.20',
    allowedIps: ['203.0.113.5'],
  });
  assert.equal(blockedErp.allowed, false);
  assert.equal(blockedErp.reason, 'blocked');

  const blockedApi = evaluateIpAccess({
    path: '/api/erp/bills',
    clientIp: '198.51.100.20',
    allowedIps: ['203.0.113.5'],
  });
  assert.equal(blockedApi.allowed, false);

  const testApp = express();
  testApp.use(requireIpAllowlist);
  testApp.get('/', (_req, res) => res.json({ page: 'storefront' }));
  testApp.get('/ERP', (_req, res) => res.json({ page: 'erp' }));

  const server = await new Promise((resolve) => {
    const s = testApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const storeRes = await fetch(`${baseUrl}/`);
    assert.equal(storeRes.status, 200);
    const erpRes = await fetch(`${baseUrl}/ERP`);
    assert.equal(erpRes.status, 200);
    assert.equal(erpRes.headers.get('x-robots-tag'), 'noindex, nofollow');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Step 3: middleware enforces customer token rejection & TOTP proof token, and ERP UI wires Security + 2FA', () => {
  const middlewareSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/server/middleware.ts'), 'utf8');
  assert.match(middlewareSrc, /Customer tokens are not permitted on ERP endpoints/);
  assert.match(middlewareSrc, /verifyTotpProofToken\(/);
  assert.match(middlewareSrc, /code:\s*'TOTP_REQUIRED'/);

  const settingsSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/settings/SettingsScreen.tsx'), 'utf8');
  assert.match(settingsSrc, /allowed_ips|update_ip_allowlist/);
  assert.match(settingsSrc, /\/api\/erp\/auth\/totp-reset/);

  const authSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/auth/AuthScreens.tsx'), 'utf8');
  assert.match(authSrc, /verifyTotpToken/);

  const profileSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/profile/UserProfileScreen.tsx'), 'utf8');
  assert.match(profileSrc, /\/api\/erp\/auth\/totp-setup/);
  assert.match(profileSrc, /\/api\/erp\/auth\/totp-verify/);
});
