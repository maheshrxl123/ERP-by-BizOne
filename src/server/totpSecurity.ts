import crypto from 'node:crypto';

const FALLBACK_TOTP_PROOF_KEY = crypto.randomBytes(32).toString('hex');

function getTotpProofSecret(): string {
  const configured = process.env.APP_ENCRYPTION_KEY?.trim() || '';
  return configured.length >= 16 ? configured : FALLBACK_TOTP_PROOF_KEY;
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  const digest = crypto.createHash('sha256').update(normalized).digest('hex');
  return `sha256:${digest}`;
}

export function verifyRecoveryCode(inputCode: string, storedCode: string): boolean {
  const normalizedInput = inputCode.trim().toUpperCase();
  if (!normalizedInput || !storedCode) return false;
  if (storedCode.startsWith('sha256:')) {
    const candidate = hashRecoveryCode(normalizedInput);
    const a = Buffer.from(candidate);
    const b = Buffer.from(storedCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const a = Buffer.from(normalizedInput);
  const b = Buffer.from(storedCode.trim().toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createTotpProofToken(userId: string, ttlSeconds = 12 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto
    .createHmac('sha256', getTotpProofSecret())
    .update(`totp-proof:${userId}:${exp}`)
    .digest('hex');
  return `${exp}.${sig}`;
}

export function verifyTotpProofToken(userId: string, token?: string | null): boolean {
  if (!userId || !token) return false;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  const sigHex = parts[1];
  if (!Number.isInteger(exp) || exp <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expectedHex = crypto
    .createHmac('sha256', getTotpProofSecret())
    .update(`totp-proof:${userId}:${exp}`)
    .digest('hex');
  const a = Buffer.from(sigHex, 'utf8');
  const b = Buffer.from(expectedHex, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
