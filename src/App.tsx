/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IconAlertCircle,
  IconCheck,
  IconDatabaseOff,
  IconLanguage,
  IconLoader2,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { AppProvider, useApp } from './app/AppProvider';
import { AppShell } from './app/AppShell';
import { OfflineIndicator } from './components/pwa/OfflineIndicator';
import { AuthScreens } from './modules/auth/AuthScreens';
import { PublicBillShareView } from './modules/bills/PublicBillShareView';

function ToastStack() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-20 md:bottom-5 right-4 z-50 space-y-2 max-w-sm w-[calc(100%-2rem)]">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`px-4 py-3 rounded-xl border text-xs sm:text-sm font-medium flex items-center justify-between gap-3 bg-[var(--surface)] ${
            toast.tone === 'error'
              ? 'border-[var(--give)] text-[var(--give)]'
              : toast.tone === 'success'
                ? 'border-[var(--receive)] text-[var(--receive-text)]'
                : 'border-[var(--border)] text-[var(--text)]'
          }`}
        >
          <span className="inline-flex items-center gap-2 min-w-0">
            {toast.tone === 'error' ? (
              <IconAlertCircle size={16} stroke={2} className="shrink-0" />
            ) : (
              <IconCheck size={16} stroke={2.5} className="shrink-0" />
            )}
            <span className="truncate">{toast.message}</span>
          </span>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss"
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text)] shrink-0"
          >
            <IconX size={15} stroke={2} />
          </button>
        </div>
      ))}
    </div>
  );
}

function RootRouter() {
  const {
    supabaseConfigured,
    session,
    authLoading,
    checkingSetup,
    needsSetup,
    passwordRecoveryMode,
    profile,
    language,
    setLanguage,
    signOut,
  } = useApp();

  if (!supabaseConfigured) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-lg w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-[var(--primary-soft)] text-[var(--primary-dark)] flex items-center justify-center shrink-0">
                <IconDatabaseOff size={22} stroke={2} />
              </div>
              <div>
                <h1 className="text-lg font-semibold">
                  {language === 'hi'
                    ? 'सुपाबेस कनेक्शन कॉन्फ़िगर नहीं है'
                    : 'Workspace Backend Not Configured'}
                </h1>
                <p className="text-xs text-[var(--text-muted)]">
                  BizOne ERP
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')}
              className="h-9 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1 hover:bg-[var(--surface-muted)]"
            >
              <IconLanguage size={15} stroke={2} />
              <span>{language === 'en' ? 'हिन्दी' : 'EN'}</span>
            </button>
          </div>

          <p className="text-sm text-[var(--text-muted)] leading-relaxed">
            {language === 'hi'
              ? 'ऐप शुरू हो चुका है, लेकिन आपका सुपाबेस प्रोजेक्ट अभी जुड़ा नहीं है। अपने प्रोजेक्ट रूट में .env फ़ाइल सेट करें और सर्वर रीस्टार्ट करें।'
              : 'The BizOne server is running, but your Supabase project credentials are not set yet. Configure the environment file at your project root and restart the server.'}
          </p>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 space-y-2 text-xs">
            <p className="font-semibold text-[var(--text)]">
              {language === 'hi' ? 'आवश्यक एनवायरनमेंट वेरिएबल्स (.env):' : 'Required .env variables:'}
            </p>
            <ul className="font-mono text-[var(--text-muted)] space-y-1">
              <li>VITE_SUPABASE_URL</li>
              <li>VITE_SUPABASE_ANON_KEY</li>
              <li>SUPABASE_SERVICE_ROLE_KEY</li>
              <li>APP_ENCRYPTION_KEY</li>
            </ul>
            <p className="text-[var(--text-muted)] pt-1">
              {language === 'hi' ? 'सेटअप स्क्रिप्ट चलाएं:' : 'Run provisioning & env check:'}{' '}
              <code className="font-mono text-[var(--text)]">npm run setup</code>
            </p>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5"
            >
              <IconRefresh size={16} stroke={2} />
              <span>{language === 'hi' ? 'पुनः जांचें' : 'Check Again'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (authLoading || checkingSetup) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <div className="flex items-center gap-2.5 text-sm font-medium text-[var(--text-muted)]">
          <IconLoader2 size={20} stroke={2} className="animate-spin text-[var(--primary-dark)]" />
          <span>Loading BizOne workspace...</span>
        </div>
      </div>
    );
  }

  if (needsSetup || !session || passwordRecoveryMode) {
    return <AuthScreens />;
  }

  if (profile && !profile.is_active) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center space-y-4">
          <IconAlertCircle size={32} stroke={2} className="text-[var(--give)] mx-auto" />
          <h1 className="text-lg font-semibold">Account deactivated</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Your staff account has been deactivated by the Business Owner.
          </p>
          <button
            type="button"
            onClick={() => signOut()}
            className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return <AppShell />;
}

export default function App() {
  const shareToken =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('share')?.trim() || ''
      : '';

  if (shareToken) {
    return <PublicBillShareView shareToken={shareToken} />;
  }

  return (
    <AppProvider>
      <OfflineIndicator />
      <RootRouter />
      <ToastStack />
    </AppProvider>
  );
}
