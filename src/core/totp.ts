import crypto from 'node:crypto';

// Base32 decoding
function base32Decode(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32.replace(/=+$/, '').toUpperCase();
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
  return Buffer.from(output.buffer, output.byteOffset, index);
}

export function generateTotpSecret(): string {
  const buffer = crypto.randomBytes(20);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let bits = 0;
  let value = 0;

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

export function verifyTotpCode(secret: string, token: string, window = 1): boolean {
  if (!secret || !token || token.length !== 6) return false;
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const step = 30;

  for (let i = -window; i <= window; i++) {
    const counter = Math.floor(epoch / step) + i;
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

    const otp = String(binary % 1000000).padStart(6, '0');
    if (crypto.timingSafeEqual(Buffer.from(otp), Buffer.from(token.trim()))) {
      return true;
    }
  }
  return false;
}
