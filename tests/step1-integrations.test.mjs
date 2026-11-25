import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  decryptSecret,
  encryptSecret,
  isValidEncryptionKey,
  signOAuthState,
  verifyOAuthState,
} from '../src/server/crypto.ts';
import { validateExternalHttpsUrl } from '../src/server/aiGateway.ts';

const TEST_HEX_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('Step 1 Item 4: AES-256-GCM encryptSecret / decryptSecret round-trip and tamper rejection', () => {
  assert.equal(isValidEncryptionKey(TEST_HEX_KEY), true);
  assert.equal(isValidEncryptionKey('too-short'), false);

  const secret = 'rzp_live_secret_token_987654';
  const encrypted = encryptSecret(secret, TEST_HEX_KEY);
  const parts = encrypted.split(':');
  assert.equal(parts.length, 3, 'Expected iv:authTag:ciphertext format');
  assert.notEqual(encrypted.includes(secret), true);

  const decrypted = decryptSecret(encrypted, TEST_HEX_KEY);
  assert.equal(decrypted, secret);

  // Tamper with ciphertext / auth tag -> must throw
  const tampered = `${parts[0]}:${parts[1]}:${parts[2].slice(0, -2)}ff`;
  assert.throws(() => decryptSecret(tampered, TEST_HEX_KEY));

  // Missing/invalid encryption key -> must throw
  assert.throws(() => encryptSecret(secret, ''), /APP_ENCRYPTION_KEY/);
});

test('Step 1 Item 4: signOAuthState and verifyOAuthState reject forged payloads', () => {
  const token = signOAuthState({ uid: 'user-1', ts: 123456 });
  const parsed = verifyOAuthState(token);
  assert.deepEqual(parsed, { uid: 'user-1', ts: 123456 });

  const forged = `${token.split('.')[0]}.forgedsignature`;
  assert.equal(verifyOAuthState(forged), null);
});

test('Step 1 Item 4: validateExternalHttpsUrl rejects non-HTTPS and private/internal endpoints', () => {
  assert.equal(validateExternalHttpsUrl('https://api.razorpay.com/v1').valid, true);
  assert.equal(validateExternalHttpsUrl('http://api.razorpay.com/v1').valid, false);
  assert.equal(validateExternalHttpsUrl('https://127.0.0.1/webhook').valid, false);
  assert.equal(validateExternalHttpsUrl('https://localhost:8080/hook').valid, false);
  assert.equal(validateExternalHttpsUrl('https://169.254.169.254/latest').valid, false);
  assert.equal(validateExternalHttpsUrl('https://192.168.1.50/api').valid, false);
});

test('Step 1 Item 4: migration 0018 and Settings > Integrations cover all credentialed slots cleanly', () => {
  const mig18 = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0018_decorbiz_step1_integrations.sql'),
    'utf8'
  );
  assert.ok(mig18.includes("'online_payments'"));
  assert.ok(mig18.includes("'online_store'"));
  assert.ok(mig18.includes('DecorBiz AI Provider'));

  const settingsSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/modules/settings/SettingsScreen.tsx'),
    'utf8'
  );
  for (const slot of [
    'ai_provider',
    'whatsapp_sms',
    'google_drive',
    'smtp_email',
    'einvoice_gsp',
    'online_payments',
    'online_store',
  ]) {
    assert.ok(settingsSrc.includes(slot), `SettingsScreen missing integration slot ${slot}`);
  }
});
