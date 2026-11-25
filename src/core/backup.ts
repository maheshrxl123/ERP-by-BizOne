/**
 * Local JSON Backup Packaging, SHA-256 Checksum & File Download Helpers
 */

export interface WorkspaceBackupEnvelope {
  app: string;
  schema_version: string;
  exported_at: string;
  exported_by?: string | null;
  include_files?: boolean;
  checksum?: string;
  record_counts: Record<string, number>;
  data: Record<string, unknown>;
  attachments?: Array<Record<string, unknown>>;
}

export interface EncryptedBackupEnvelope {
  app: string;
  encrypted: true;
  format: 'DECORBIZ_ENC_V1';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  cipher: 'AES-256-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
  exported_at: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function deriveAesKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: KeyUsage[]
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const saltCopy = new Uint8Array(salt);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltCopy,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usage
  );
}

export function isEncryptedBackupEnvelope(rawText: string): boolean {
  try {
    const parsed = JSON.parse(rawText) as Partial<EncryptedBackupEnvelope>;
    return Boolean(
      parsed &&
        typeof parsed === 'object' &&
        parsed.encrypted === true &&
        parsed.format === 'DECORBIZ_ENC_V1' &&
        typeof parsed.ciphertext === 'string'
    );
  } catch {
    return false;
  }
}

export async function encryptBackupWithPassphrase(
  snapshot: WorkspaceBackupEnvelope,
  passphrase: string
): Promise<{ jsonText: string; checksum: string; sizeBytes: number }> {
  const cleanPass = passphrase.trim();
  if (cleanPass.length < 4) {
    throw new Error('Passphrase must be at least 4 characters long.');
  }

  const signed = await buildSignedBackupBlob(snapshot);
  const iterations = 120_000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKeyFromPassphrase(cleanPass, salt, iterations, ['encrypt']);
  const plainBytes = new TextEncoder().encode(signed.jsonText);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    plainBytes
  );

  const encryptedEnvelope: EncryptedBackupEnvelope = {
    app: 'DecorBiz',
    encrypted: true,
    format: 'DECORBIZ_ENC_V1',
    kdf: 'PBKDF2-SHA256',
    iterations,
    cipher: 'AES-256-GCM',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipherBuffer)),
    exported_at: snapshot.exported_at || new Date().toISOString(),
  };

  const jsonText = JSON.stringify(encryptedEnvelope, null, 2);
  return {
    jsonText,
    checksum: signed.checksum,
    sizeBytes: new Blob([jsonText]).size,
  };
}

export async function decryptBackupWithPassphrase(
  rawText: string,
  passphrase: string
): Promise<string> {
  const parsed = JSON.parse(rawText) as Partial<EncryptedBackupEnvelope>;
  if (
    !parsed ||
    parsed.encrypted !== true ||
    parsed.format !== 'DECORBIZ_ENC_V1' ||
    !parsed.salt ||
    !parsed.iv ||
    !parsed.ciphertext
  ) {
    throw new Error('File is not a valid encrypted DecorBiz backup.');
  }
  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(parsed.iv);
  const cipherBytes = base64ToBytes(parsed.ciphertext);
  const iterations = Number(parsed.iterations || 120_000);

  const key = await deriveAesKeyFromPassphrase(passphrase.trim(), salt, iterations, ['decrypt']);
  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(cipherBytes)
    );
    return new TextDecoder().decode(decryptedBuffer);
  } catch {
    throw new Error('Incorrect passphrase or corrupted encrypted backup file.');
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(hashBuffer));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildSignedBackupBlob(
  snapshot: WorkspaceBackupEnvelope
): Promise<{ jsonText: string; checksum: string; sizeBytes: number }> {
  const canonicalData = JSON.stringify(snapshot.data);
  const checksum = await sha256Hex(canonicalData);
  const packaged: WorkspaceBackupEnvelope = {
    ...snapshot,
    checksum,
  };
  const jsonText = JSON.stringify(packaged, null, 2);
  return {
    jsonText,
    checksum,
    sizeBytes: new Blob([jsonText]).size,
  };
}

export function downloadJsonFile(filename: string, jsonText: string): void {
  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function verifyBackupEnvelope(
  rawText: string
): Promise<{ envelope: WorkspaceBackupEnvelope; checksum: string; checksumVerified: boolean }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Selected file is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid backup structure.');
  }

  const env = parsed as Partial<WorkspaceBackupEnvelope>;
  if (
    env.schema_version !== 'p5-v1' &&
    env.schema_version !== 'p6-v1' &&
    env.schema_version !== 'p7-v1'
  ) {
    throw new Error(
      `Unsupported backup schema version (${String(env.schema_version ?? 'unknown')}). Expected p5-v1, p6-v1, or p7-v1.`
    );
  }
  if (!env.data || typeof env.data !== 'object') {
    throw new Error('Backup data payload is missing.');
  }
  const dataObj = env.data as Record<string, unknown>;
  if (!dataObj.business || typeof dataObj.business !== 'object') {
    throw new Error('Backup is missing business configuration.');
  }

  const computedChecksum = await sha256Hex(JSON.stringify(env.data));
  if (env.checksum && env.checksum !== computedChecksum) {
    throw new Error(
      'Backup checksum mismatch! The file may be corrupted or modified.'
    );
  }

  return {
    envelope: env as WorkspaceBackupEnvelope,
    checksum: computedChecksum,
    checksumVerified: Boolean(env.checksum && env.checksum === computedChecksum),
  };
}
