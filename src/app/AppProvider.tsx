import type { Session } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  clearTotpProof,
  erpFetch,
  onIpBlocked,
  onTotpRequired,
  setActiveStaffUserId,
  setTotpProof,
} from '../core/erpFetch';
import { isSupabaseConfigured, supabase } from '../core/supabase';
import enDict from '../i18n/en.json';
import hiDict from '../i18n/hi.json';
import type {
  AuditLogRecord,
  BusinessRecord,
  ModuleStateRecord,
  ProfileRecord,
} from '../types/decorbiz';

type Language = 'en' | 'hi';
type ThemeMode = 'light' | 'dark';

export interface ToastItem {
  id: string;
  message: string;
  tone: 'success' | 'error' | 'info';
}

interface SignedUrlEntry {
  url: string;
  expiresAt: number;
}

const SIGNED_URL_TTL_MS = 500 * 1000;

interface AppContextValue {
  supabaseConfigured: boolean;
  session: Session | null;
  authLoading: boolean;
  passwordRecoveryMode: boolean;
  clearPasswordRecovery: () => void;
  needsSetup: boolean;
  checkingSetup: boolean;
  totpChecking: boolean;
  totpRequired: boolean;
  totpVerified: boolean;
  totpCheckError: string | null;
  ipBlockedError: string | null;
  verifyTotpToken: (token: string) => Promise<void>;
  markTotpEnrolled: (totpProof?: string | null) => void;
  refreshTotpStatus: () => Promise<void>;
  business: BusinessRecord | null;
  profile: ProfileRecord | null;
  staff: ProfileRecord[];
  modules: ModuleStateRecord[];
  auditLogs: AuditLogRecord[];
  workspaceError: string | null;
  language: Language;
  theme: ThemeMode;
  toasts: ToastItem[];
  signedUrlCache: Record<string, string>;
  setLanguage: (lang: Language) => void;
  setTheme: (mode: ThemeMode) => void;
  t: (path: string) => string;
  showToast: (message: string, tone?: 'success' | 'error' | 'info') => void;
  dismissToast: (id: string) => void;
  refreshWorkspace: () => Promise<void>;
  refreshSetupStatus: () => Promise<void>;
  getSignedUrl: (fileId: string | null | undefined) => Promise<string | null>;
  isModuleEnabled: (key: string) => boolean;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function resolveNestedKey(obj: Record<string, unknown>, path: string): string {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current === 'object' && current !== null && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return path;
    }
  }
  return typeof current === 'string' ? current : path;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [passwordRecoveryMode, setPasswordRecoveryMode] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [totpChecking, setTotpChecking] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpVerified, setTotpVerified] = useState(true);
  const [totpCheckError, setTotpCheckError] = useState<string | null>(null);
  const [ipBlockedError, setIpBlockedError] = useState<string | null>(null);

  const [business, setBusiness] = useState<BusinessRecord | null>(null);
  const [profile, setProfile] = useState<ProfileRecord | null>(null);
  const [staff, setStaff] = useState<ProfileRecord[]>([]);
  const [modules, setModules] = useState<ModuleStateRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [signedUrlEntries, setSignedUrlEntries] = useState<
    Record<string, SignedUrlEntry>
  >({});
  const signedUrlEntriesRef = useRef<Record<string, SignedUrlEntry>>({});
  const prefsHydratedForUserRef = useRef<string | null>(null);

  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('decorbiz_lang');
    return saved === 'hi' ? 'hi' : 'en';
  });
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('decorbiz_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    signedUrlEntriesRef.current = signedUrlEntries;
  }, [signedUrlEntries]);

  const signedUrlCache = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [key, entry] of Object.entries(signedUrlEntries)) {
      map[key] = entry.url;
    }
    return map;
  }, [signedUrlEntries]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('decorbiz_theme', theme);
  }, [theme]);

  const hindiEnabled = useMemo(() => {
    if (modules.length === 0) return true;
    const found = modules.find((m) => m.module_key === 'hindi');
    return found ? found.enabled : true;
  }, [modules]);

  const effectiveLanguage: Language = hindiEnabled ? language : 'en';

  useEffect(() => {
    localStorage.setItem('decorbiz_lang', language);
    document.documentElement.lang = effectiveLanguage === 'hi' ? 'hi' : 'en';
  }, [language, effectiveLanguage]);

  const showToast = useCallback(
    (message: string, tone: 'success' | 'error' | 'info' = 'info') => {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, message, tone }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, 4000);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearPasswordRecovery = useCallback(() => {
    setPasswordRecoveryMode(false);
  }, []);

  const refreshSetupStatus = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setNeedsSetup(false);
      setCheckingSetup(false);
      return;
    }
    setCheckingSetup(true);
    try {
      const res = await fetch('/api/erp/setup/status');
      const data = await res.json();
      setNeedsSetup(Boolean(data?.needsSetup));
    } catch {
      setNeedsSetup(false);
    } finally {
      setCheckingSetup(false);
    }
  }, []);

  const accessToken = session?.access_token;
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;

  useEffect(() => {
    setActiveStaffUserId(userId ?? null);
  }, [userId]);

  useEffect(() => {
    return onTotpRequired(() => {
      setTotpCheckError(null);
      setTotpRequired(true);
      setTotpVerified(false);
    });
  }, []);

  useEffect(() => {
    return onIpBlocked((message) => {
      setIpBlockedError(message);
    });
  }, []);

  const refreshTotpStatus = useCallback(async () => {
    if (!isSupabaseConfigured || !userId || !accessToken) {
      setTotpCheckError(null);
      setIpBlockedError(null);
      setTotpRequired(false);
      setTotpVerified(true);
      setTotpChecking(false);
      return;
    }
    setTotpChecking(true);
    try {
      const res = await erpFetch('/api/erp/auth/totp-status', accessToken);
      if (res.ok) {
        const data = await res.json();
        const enabled = Boolean(data?.enabled);
        setTotpCheckError(null);
        setIpBlockedError(null);
        setTotpRequired(enabled);
        setTotpVerified(!enabled || Boolean(data?.verified));
      } else {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
          clientIp?: string;
        };
        if (res.status === 403 && (errBody.clientIp || String(errBody.error || '').toLowerCase().includes('not allowed in settings'))) {
          setIpBlockedError(errBody.error || 'Access denied from this IP address.');
          setTotpCheckError(null);
        } else {
          setTotpCheckError(
            errBody.error || 'Unable to verify two-factor authentication status. Please retry.'
          );
        }
        setTotpRequired(true);
        setTotpVerified(false);
      }
    } catch {
      setTotpCheckError('Unable to reach workspace authentication server. Please retry.');
      setTotpRequired(true);
      setTotpVerified(false);
    } finally {
      setTotpChecking(false);
    }
  }, [userId, accessToken]);

  useEffect(() => {
    void refreshTotpStatus();
  }, [refreshTotpStatus]);

  const verifyTotpToken = useCallback(
    async (token: string) => {
      if (!accessToken || !userId) {
        throw new Error('Staff session not active.');
      }
      const res = await erpFetch('/api/erp/auth/totp-validate', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Invalid verification code.');
      }
      if (typeof data?.totpProof === 'string' && data.totpProof) {
        setTotpProof(userId, data.totpProof);
      }
      setTotpRequired(Boolean(data?.enabled ?? true));
      setTotpVerified(true);
    },
    [accessToken, userId]
  );

  const markTotpEnrolled = useCallback(
    (totpProof?: string | null) => {
      if (userId && totpProof) {
        setTotpProof(userId, totpProof);
      }
      setTotpRequired(true);
      setTotpVerified(true);
    },
    [userId]
  );

  const getSignedUrl = useCallback(
    async (fileId: string | null | undefined): Promise<string | null> => {
      if (!fileId || !accessToken) return null;
      const cached = signedUrlEntriesRef.current[fileId];
      if (cached && cached.expiresAt > Date.now()) {
        return cached.url;
      }

      try {
        const res = await erpFetch('/api/erp/files/signed-url', accessToken, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fileId }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (typeof data?.signedUrl === 'string') {
          setSignedUrlEntries((prev) => ({
            ...prev,
            [fileId]: {
              url: data.signedUrl,
              expiresAt: Date.now() + SIGNED_URL_TTL_MS,
            },
          }));
          return data.signedUrl;
        }
        return null;
      } catch {
        return null;
      }
    },
    [accessToken]
  );

  const refreshWorkspace = useCallback(async () => {
    if (!isSupabaseConfigured || !userId || (totpRequired && !totpVerified)) {
      if (!userId) {
        prefsHydratedForUserRef.current = null;
        setBusiness(null);
        setProfile(null);
        setStaff([]);
        setModules([]);
        setAuditLogs([]);
      }
      setWorkspaceError(null);
      return;
    }

    try {
      setWorkspaceError(null);
      const [bizRes, profRes, staffRes, modRes] = await Promise.all([
        supabase.from('business').select('*').eq('id', 1).maybeSingle(),
        supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle(),
        supabase
          .from('profiles')
          .select('*')
          .order('created_at', { ascending: true }),
        supabase.from('modules_state').select('*').order('module_key'),
      ]);

      if (bizRes.error) throw bizRes.error;
      if (profRes.error) throw profRes.error;

      setBusiness((bizRes.data as BusinessRecord | null) ?? null);

      if (profRes.data) {
        let p = profRes.data as ProfileRecord;

        // Sync verified email change from auth.users -> public.profiles
        if (userEmail && p.email !== userEmail) {
          const { data: syncedEmail } = await supabase.rpc('sync_own_email');
          if (typeof syncedEmail === 'string') {
            p = { ...p, email: syncedEmail };
          }
        }

        setProfile(p);

        // Apply saved DB language/theme only once per signed-in user session
        // so background refreshes never override a user's live toggle.
        if (prefsHydratedForUserRef.current !== userId) {
          prefsHydratedForUserRef.current = userId;
          if (p.preferred_language === 'en' || p.preferred_language === 'hi') {
            setLanguageState(p.preferred_language);
          }
          if (p.preferred_theme === 'light' || p.preferred_theme === 'dark') {
            setThemeState(p.preferred_theme);
          }
        }
      } else {
        setProfile(null);
      }

      setStaff((staffRes.data as ProfileRecord[] | null) ?? []);
      setModules((modRes.data as ModuleStateRecord[] | null) ?? []);

      if ((profRes.data as ProfileRecord | null)?.role === 'owner') {
        const { data: logs } = await supabase
          .from('audit_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(20);
        setAuditLogs((logs as AuditLogRecord[] | null) ?? []);
      } else {
        setAuditLogs([]);
      }
    } catch (err) {
      setWorkspaceError(
        err instanceof Error ? err.message : 'Unable to load workspace data.'
      );
    }
  }, [userId, userEmail, totpRequired, totpVerified]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setCheckingSetup(false);
      setAuthLoading(false);
      return;
    }

    refreshSetupStatus();

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setTotpChecking(true);
      }
      setSession(data.session ?? null);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        if (event === 'PASSWORD_RECOVERY') {
          setPasswordRecoveryMode(true);
        } else if (event === 'SIGNED_OUT') {
          setPasswordRecoveryMode(false);
          clearTotpProof();
          setTotpRequired(false);
          setTotpVerified(true);
        } else if (nextSession) {
          setTotpChecking(true);
        }
        setSession(nextSession ?? null);
        setAuthLoading(false);
      }
    );

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [refreshSetupStatus]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  // Preload avatar, logo & UPI QR signed URLs
  useEffect(() => {
    if (profile?.avatar_file_id) {
      void getSignedUrl(profile.avatar_file_id);
    }
    if (business?.logo_file_id) {
      void getSignedUrl(business.logo_file_id);
    }
    if (business?.upi_qr_file_id) {
      void getSignedUrl(business.upi_qr_file_id);
    }
  }, [
    profile?.avatar_file_id,
    business?.logo_file_id,
    business?.upi_qr_file_id,
    getSignedUrl,
  ]);

  const setLanguage = useCallback(
    (lang: Language) => {
      if (!hindiEnabled && lang === 'hi') {
        setLanguageState('en');
        return;
      }
      setLanguageState(lang);
      if (userId && profile?.is_active) {
        void supabase
          .from('profiles')
          .update({ preferred_language: lang })
          .eq('id', userId);
      }
    },
    [hindiEnabled, userId, profile?.is_active]
  );

  const setTheme = useCallback(
    (mode: ThemeMode) => {
      setThemeState(mode);
      if (userId && profile?.is_active) {
        void supabase
          .from('profiles')
          .update({ preferred_theme: mode })
          .eq('id', userId);
      }
    },
    [userId, profile?.is_active]
  );

  const dict = useMemo(
    () => (effectiveLanguage === 'hi' ? hiDict : enDict) as Record<string, unknown>,
    [effectiveLanguage]
  );

  const t = useCallback(
    (path: string) => resolveNestedKey(dict, path),
    [dict]
  );

  const isModuleEnabled = useCallback(
    (key: string) => {
      const found = modules.find((m) => m.module_key === key);
      return found ? found.enabled : false;
    },
    [modules]
  );

  const signOut = useCallback(async () => {
    clearTotpProof(userId);
    await supabase.auth.signOut();
    setSignedUrlEntries({});
    prefsHydratedForUserRef.current = null;
    setPasswordRecoveryMode(false);
    setTotpRequired(false);
    setTotpVerified(true);
    setTotpCheckError(null);
    setIpBlockedError(null);
  }, [userId]);

  return (
    <AppContext.Provider
      value={{
        supabaseConfigured: isSupabaseConfigured,
        session,
        authLoading,
        passwordRecoveryMode,
        clearPasswordRecovery,
        needsSetup,
        checkingSetup,
        totpChecking,
        totpRequired,
        totpVerified,
        totpCheckError,
        ipBlockedError,
        verifyTotpToken,
        markTotpEnrolled,
        refreshTotpStatus,
        business,
        profile,
        staff,
        modules,
        auditLogs,
        workspaceError,
        language: effectiveLanguage,
        theme,
        toasts,
        signedUrlCache,
        setLanguage,
        setTheme,
        t,
        showToast,
        dismissToast,
        refreshWorkspace,
        refreshSetupStatus,
        getSignedUrl,
        isModuleEnabled,
        signOut,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider.');
  return ctx;
}
