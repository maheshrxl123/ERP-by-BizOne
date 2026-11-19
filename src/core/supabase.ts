import { createClient } from '@supabase/supabase-js';

function cleanEnvValue(value: string | undefined): string {
  const trimmed = value?.trim() || '';
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const viteEnv = ((import.meta as { env?: Record<string, string | undefined> }).env) ?? {};
const rawSupabaseUrl = cleanEnvValue(viteEnv.VITE_SUPABASE_URL);
const rawSupabaseAnonKey = cleanEnvValue(viteEnv.VITE_SUPABASE_ANON_KEY);

function extractUrlProjectRef(url: string): string | null {
  const match = url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co(?:\/|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function extractJwtProjectRef(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as { ref?: unknown };
    return typeof decoded.ref === 'string' ? decoded.ref.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const supabaseConfigMismatch: {
  urlRef: string;
  keyRef: string;
} | null = (() => {
  const urlRef = extractUrlProjectRef(rawSupabaseUrl);
  const keyRef = extractJwtProjectRef(rawSupabaseAnonKey);
  if (urlRef && keyRef && urlRef !== keyRef) {
    return { urlRef, keyRef };
  }
  return null;
})();

export const isSupabaseConfigured =
  Boolean(rawSupabaseUrl) &&
  /^https?:\/\//i.test(rawSupabaseUrl) &&
  !rawSupabaseUrl.includes('YOUR_') &&
  !rawSupabaseUrl.includes('MY_') &&
  Boolean(rawSupabaseAnonKey) &&
  !rawSupabaseAnonKey.includes('YOUR_') &&
  !rawSupabaseAnonKey.includes('MY_');

export const supabase = createClient(
  isSupabaseConfigured ? rawSupabaseUrl : 'https://placeholder.invalid',
  isSupabaseConfigured ? rawSupabaseAnonKey : 'placeholder-anon-key',
  {
    auth: {
      persistSession: isSupabaseConfigured,
      autoRefreshToken: isSupabaseConfigured,
      detectSessionInUrl: isSupabaseConfigured,
    },
  }
);

function ensureErrorInstance(res: unknown): unknown {
  if (res && typeof res === 'object' && 'error' in res) {
    const r = res as { error: unknown };
    if (r.error && typeof r.error === 'object' && !(r.error instanceof Error)) {
      const raw = r.error as {
        message?: string;
        details?: string;
        hint?: string;
        code?: string;
      };
      const err = new Error(raw.message || 'Database request failed.');
      Object.assign(err, raw);
      r.error = err;
    }
  }
  return res;
}

const sampleBuilder = supabase.rpc('current_user_role');
const builderProto = Object.getPrototypeOf(sampleBuilder);
if (builderProto && typeof builderProto.then === 'function' && !builderProto.__errorNormalized) {
  const origThen = builderProto.then;
  builderProto.then = function (
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null
  ) {
    return origThen.call(
      this,
      (res: unknown) => {
        ensureErrorInstance(res);
        return typeof onfulfilled === 'function' ? onfulfilled(res) : res;
      },
      onrejected
    );
  };
  Object.defineProperty(builderProto, '__errorNormalized', {
    value: true,
    enumerable: false,
  });
}

