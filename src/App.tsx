/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { IconAlertCircle, IconCheck, IconLoader2, IconX } from '@tabler/icons-react';
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
    session,
    authLoading,
    checkingSetup,
    needsSetup,
    passwordRecoveryMode,
    profile,
    signOut,
  } = useApp();

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
