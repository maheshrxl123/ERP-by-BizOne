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
import { isSupabaseConfigured, supabase } from '../core/supabase';
import enDict from '../i18n/en.json';
import hiDict from '../i18n/hi.json';
import type {
  AuditLogRecord,
  BusinessRecord,
  ModuleStateRecord,
  ProfileRecord,
} from '../types/bizone';

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
    const saved = localStorage.getItem('bizone_lang');
    return saved === 'hi' ? 'hi' : 'en';
  });
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('bizone_theme');
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
    localStorage.setItem('bizone_theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('bizone_lang', language);
    document.documentElement.lang = language === 'hi' ? 'hi' : 'en';
  }, [language]);

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
      const res = await fetch('/api/setup/status');
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

  const getSignedUrl = useCallback(
    async (fileId: string | null | undefined): Promise<string | null> => {
      if (!fileId || !accessToken) return null;
      const cached = signedUrlEntriesRef.current[fileId];
      if (cached && cached.expiresAt > Date.now()) {
        return cached.url;
      }

      try {
        const res = await fetch('/api/files/signed-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
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
    if (!isSupabaseConfigured || !userId) {
      prefsHydratedForUserRef.current = null;
      setBusiness(null);
      setProfile(null);
      setStaff([]);
      setModules([]);
      setAuditLogs([]);
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
  }, [userId, userEmail]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setCheckingSetup(false);
      setAuthLoading(false);
      return;
    }

    refreshSetupStatus();

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        if (event === 'PASSWORD_RECOVERY') {
          setPasswordRecoveryMode(true);
        } else if (event === 'SIGNED_OUT') {
          setPasswordRecoveryMode(false);
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
      setLanguageState(lang);
      if (userId && profile?.is_active) {
        void supabase
          .from('profiles')
          .update({ preferred_language: lang })
          .eq('id', userId);
      }
    },
    [userId, profile?.is_active]
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
    () => (language === 'hi' ? hiDict : enDict) as Record<string, unknown>,
    [language]
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
    await supabase.auth.signOut();
    setSignedUrlEntries({});
    prefsHydratedForUserRef.current = null;
    setPasswordRecoveryMode(false);
  }, []);

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
        business,
        profile,
        staff,
        modules,
        auditLogs,
        workspaceError,
        language,
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
