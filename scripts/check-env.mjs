import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

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

const requiredClientVars = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];
const forbiddenVitePatterns = ['SERVICE_ROLE', 'SECRET', 'PASSWORD', 'ENCRYPTION_KEY', 'ACCESS_TOKEN'];

let failed = false;

for (const key of requiredClientVars) {
  const val = process.env[key];
  if (!val || val.includes('YOUR_') || val.includes('MY_')) {
    console.error(`[check-env] Missing or placeholder required variable: ${key}`);
    failed = true;
  }
}

for (const key of Object.keys(process.env)) {
  if (key.startsWith('VITE_')) {
    for (const pattern of forbiddenVitePatterns) {
      if (key.toUpperCase().includes(pattern)) {
        console.error(`[check-env] SECURITY VIOLATION: Secret-like key exposed in VITE_ variable: ${key}`);
        failed = true;
      }
    }
  }
}

function extractUrlRef(url) {
  const m = String(url || '').trim().match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co(?:\/|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function extractJwtRef(token) {
  const clean = String(token || '').trim().replace(/^["']+|["']+$/g, '');
  const parts = clean.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof decoded.ref === 'string' ? decoded.ref.toLowerCase() : null;
  } catch {
    return null;
  }
}

const urlRef = extractUrlRef(process.env.VITE_SUPABASE_URL);
const anonRef = extractJwtRef(process.env.VITE_SUPABASE_ANON_KEY);
const serviceRef = extractJwtRef(process.env.SUPABASE_SERVICE_ROLE_KEY);

if (urlRef && anonRef && urlRef !== anonRef) {
  console.error(
    `[check-env] MISMATCH: VITE_SUPABASE_ANON_KEY belongs to project "${anonRef}", but VITE_SUPABASE_URL points to "${urlRef}".`
  );
  failed = true;
}

if (urlRef && serviceRef && urlRef !== serviceRef) {
  console.error(
    `[check-env] MISMATCH: SUPABASE_SERVICE_ROLE_KEY belongs to project "${serviceRef}", but VITE_SUPABASE_URL points to "${urlRef}".`
  );
  failed = true;
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[check-env] Warning: SUPABASE_SERVICE_ROLE_KEY not set (trusted admin routes will be unavailable).');
}

const encKey = process.env.APP_ENCRYPTION_KEY?.trim() ?? '';
if (!encKey) {
  console.warn('[check-env] Warning: APP_ENCRYPTION_KEY not set (encrypted integration secrets disabled).');
} else if (!/^[0-9a-fA-F]{64,}$/.test(encKey)) {
  console.error('[check-env] Invalid APP_ENCRYPTION_KEY: must be at least 64 hexadecimal characters.');
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('[check-env] Environment configuration verified cleanly.');
