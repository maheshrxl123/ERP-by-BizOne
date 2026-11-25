import crypto from 'node:crypto';

const OAUTH_STATE_FALLBACK_KEY = crypto.randomBytes(32);

export function getConfiguredEncryptionKeyHex(): string {
  return process.env.APP_ENCRYPTION_KEY?.trim() || '';
}

export function isValidEncryptionKey(keyHex = getConfiguredEncryptionKeyHex()): boolean {
  return /^[0-9a-fA-F]{64,}$/.test(keyHex);
}

export function encryptSecret(plaintext: string, keyHex = getConfiguredEncryptionKeyHex()): string {
  if (!isValidEncryptionKey(keyHex)) {
    throw new Error(
      'APP_ENCRYPTION_KEY (at least 64 hex chars) must be configured before storing integration secrets.'
    );
  }
  const key = Buffer.from(keyHex.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string, keyHex = getConfiguredEncryptionKeyHex()): string {
  if (!isValidEncryptionKey(keyHex)) {
    throw new Error(
      'APP_ENCRYPTION_KEY (at least 64 hex chars) must be configured before reading integration secrets.'
    );
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret payload.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = Buffer.from(keyHex.slice(0, 64), 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function getOAuthStateKey(): Buffer {
  const keyHex = getConfiguredEncryptionKeyHex();
  if (isValidEncryptionKey(keyHex)) {
    return Buffer.from(keyHex.slice(0, 64), 'hex');
  }
  return OAUTH_STATE_FALLBACK_KEY;
}

export function signOAuthState(payload: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getOAuthStateKey())
    .update(json)
    .digest('base64url');
  return `${json}.${sig}`;
}

export function verifyOAuthState(state: string): Record<string, unknown> | null {
  const [json, sig] = state.split('.');
  if (!json || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', getOAuthStateKey())
    .update(json)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    return null;
  }
  try {
    return JSON.parse(
      Buffer.from(json, 'base64url').toString('utf8')
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}
