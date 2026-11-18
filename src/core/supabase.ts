import { createClient } from '@supabase/supabase-js';

const viteEnv = ((import.meta as { env?: Record<string, string | undefined> }).env) ?? {};
const rawSupabaseUrl = viteEnv.VITE_SUPABASE_URL?.trim() || '';
const rawSupabaseAnonKey = viteEnv.VITE_SUPABASE_ANON_KEY?.trim() || '';

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

