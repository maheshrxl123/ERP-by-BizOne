import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();
const envFilePath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFilePath)) {
  const parsedEnv = dotenv.parse(fs.readFileSync(envFilePath, 'utf8'));
  for (const [key, val] of Object.entries(parsedEnv)) {
    const existing = process.env[key]?.trim() ?? '';
    if (existing.length < 2 && val) {
      process.env[key] = val;
    }
  }
}

export const PORT = Number(process.env.PORT) || 3000;
export const SUPABASE_URL = (
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
).trim();
export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
const rawBucket = (process.env.SUPABASE_STORAGE_BUCKET || '').trim();
export const STORAGE_BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}$/.test(rawBucket)
  ? rawBucket
  : 'decorbiz-private';

function isConfiguredUrl(val: string): boolean {
  return (
    Boolean(val) &&
    /^https?:\/\//i.test(val) &&
    !val.includes('YOUR_') &&
    !val.includes('MY_')
  );
}

function isConfiguredKey(val: string): boolean {
  return Boolean(val) && !val.includes('YOUR_') && !val.includes('MY_');
}

export const SUPABASE_CONFIGURED =
  isConfiguredUrl(SUPABASE_URL) && isConfiguredKey(SERVICE_ROLE_KEY);

if (!SUPABASE_CONFIGURED) {
  console.warn(
    '[server] Supabase environment variables are missing or placeholders; workspace API routes will return 503 until .env is configured.'
  );
}

let cachedSupabaseAdmin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!SUPABASE_CONFIGURED) return null;
  if (!cachedSupabaseAdmin) {
    cachedSupabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return cachedSupabaseAdmin;
}

export function createUserScopedClient(authHeader: string): SupabaseClient {
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY?.trim() || SERVICE_ROLE_KEY;
  return createClient(SUPABASE_URL, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
