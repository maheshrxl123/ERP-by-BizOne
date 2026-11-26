import {
  IconAlertCircle,
  IconBuildingStore,
  IconCheck,
  IconKey,
  IconLanguage,
  IconLock,
  IconLogout,
  IconMoon,
  IconShieldCheck,
  IconSun,
} from '@tabler/icons-react';
import { useState } from 'react';
import { DECORBIZ_PACK } from '../../../config/app.config';
import { useApp } from '../../app/AppProvider';
import { isValidGstin } from '../../core/format';
import { supabase, supabaseConfigMismatch } from '../../core/supabase';

function formatAuthError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : fallback;
  if (supabaseConfigMismatch || /invalid api key/i.test(raw)) {
    if (supabaseConfigMismatch) {
      return `Invalid API key: VITE_SUPABASE_ANON_KEY in this build belongs to project "${supabaseConfigMismatch.keyRef}", while VITE_SUPABASE_URL points to "${supabaseConfigMismatch.urlRef}". Update VITE_SUPABASE_ANON_KEY in your deployment environment variables and redeploy without build cache.`;
    }
    return 'Invalid API key: VITE_SUPABASE_ANON_KEY in this frontend build does not match VITE_SUPABASE_URL. Update VITE_SUPABASE_ANON_KEY in your deployment settings and redeploy.';
  }
  return raw;
}

export function AuthScreens() {
  const {
    session,
    needsSetup,
    passwordRecoveryMode,
    clearPasswordRecovery,
    totpRequired,
    totpVerified,
    verifyTotpToken,
    refreshTotpStatus,
    signOut,
    language,
    setLanguage,
    theme,
    setTheme,
    t,
    showToast,
    refreshSetupStatus,
    refreshWorkspace,
  } = useApp();

  // Login & Reset state
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  // First-time setup state
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [gstRegistered, setGstRegistered] = useState(false);
  const [gstin, setGstin] = useState('');
  const [fyStartMonth, setFyStartMonth] = useState(4);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) throw signInErr;
      try {
        await supabase.rpc('log_audit_event', {
          p_action: 'auth.login',
          p_entity_type: 'profile',
          p_details: { method: 'password' },
        });
      } catch {
        // Non-blocking audit log on login
      }
      await refreshTotpStatus();
      await refreshWorkspace();
    } catch (err) {
      setError(formatAuthError(err, 'Sign in failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!totpCode.trim()) {
      setError('Enter your 6-digit authenticator code or 8-character recovery code.');
      return;
    }
    setSubmitting(true);
    try {
      await verifyTotpToken(totpCode.trim());
      setTotpCode('');
      await refreshWorkspace();
      showToast('Two-factor authentication verified.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResetSent(false);
    setSubmitting(true);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        {
          redirectTo: window.location.origin,
        }
      );
      if (resetErr) throw resetErr;
      setResetSent(true);
      showToast(t('auth.resetSent'), 'success');
    } catch (err) {
      setError(formatAuthError(err, 'Reset request failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCompleteRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) throw updErr;
      clearPasswordRecovery();
      await refreshWorkspace();
      showToast('Password updated. You are now signed in.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (gstRegistered && gstin.trim() && !isValidGstin(gstin)) {
      setError('GSTIN must be a valid 15-character format.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/erp/setup/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: businessName.trim(),
          ownerName: ownerName.trim(),
          email: email.trim(),
          password,
          pack: DECORBIZ_PACK.key,
          gstRegistered,
          gstin: gstRegistered ? gstin.trim().toUpperCase() : null,
          fyStartMonth,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Workspace setup failed.');
      }

      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) throw signInErr;

      await refreshSetupStatus();
      await refreshWorkspace();
      showToast('Business workspace initialized.', 'success');
    } catch (err) {
      setError(formatAuthError(err, 'Setup failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex flex-col">
      <header className="px-4 sm:px-6 h-14 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] flex items-center justify-center">
            <IconBuildingStore size={18} stroke={2} />
          </div>
          <span className="font-semibold text-base tracking-tight">
            {t('app.name')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]"
          >
            <IconLanguage size={16} stroke={2} />
            <span>{language === 'en' ? 'हिन्दी' : 'English'}</span>
          </button>
          <button
            type="button"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            aria-label="Toggle theme"
            className="p-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]"
          >
            {theme === 'light' ? (
              <IconMoon size={16} stroke={2} />
            ) : (
              <IconSun size={16} stroke={2} />
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        {passwordRecoveryMode ? (
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--primary-soft)] text-[var(--primary-dark)] flex items-center justify-center shrink-0">
                <IconKey size={20} stroke={2} />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  Set New Password
                </h1>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Choose a strong new password for your DecorBiz account.
                </p>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-[var(--give-soft)] border border-[var(--give)]/30 text-xs text-[var(--give)] flex items-start gap-2"
              >
                <IconAlertCircle size={16} stroke={2} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleCompleteRecovery} className="space-y-4">
              <div>
                <label
                  htmlFor="recovery-pass"
                  className="block text-sm font-medium mb-1.5"
                >
                  {t('profile.newPassword')}
                </label>
                <input
                  id="recovery-pass"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>
              <div>
                <label
                  htmlFor="recovery-confirm"
                  className="block text-sm font-medium mb-1.5"
                >
                  {t('profile.confirmPassword')}
                </label>
                <input
                  id="recovery-confirm"
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full h-12 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold text-sm hover:opacity-95 disabled:opacity-50"
              >
                {submitting ? 'Updating...' : t('profile.updatePassword')}
              </button>
            </form>
          </div>
        ) : needsSetup ? (
          <div className="w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--primary-soft)] text-[var(--primary-dark)] flex items-center justify-center shrink-0">
                <IconBuildingStore size={20} stroke={2} />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  {t('setup.title')}
                </h1>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  {t('setup.subtitle')}
                </p>
              </div>
            </div>

            {error && (
              <div
                id="setup-error"
                role="alert"
                className="p-3 rounded-lg bg-[var(--give-soft)] border border-[var(--give)]/30 text-xs text-[var(--give)] flex items-start gap-2"
              >
                <IconAlertCircle size={16} stroke={2} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSetup} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="setup-biz-name"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t('setup.businessName')}
                  </label>
                  <input
                    id="setup-biz-name"
                    type="text"
                    required
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    placeholder="e.g. Sharma Hardware & Tiles"
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="setup-owner-name"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t('setup.ownerName')}
                  </label>
                  <input
                    id="setup-owner-name"
                    type="text"
                    required
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="e.g. Mahesh Sharma"
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="setup-email"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t('setup.email')}
                  </label>
                  <input
                    id="setup-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="owner@shop.in"
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="setup-password"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t('setup.password')}
                  </label>
                  <input
                    id="setup-password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
              </div>

              <div className="p-3.5 rounded-lg border border-[var(--primary-dark)]/40 bg-[var(--primary-soft)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {language === 'hi' ? DECORBIZ_PACK.labelHi : DECORBIZ_PACK.labelEn}
                  </span>
                  <IconCheck
                    size={16}
                    stroke={2.5}
                    className="text-[var(--primary-dark)] shrink-0"
                  />
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {language === 'hi' ? DECORBIZ_PACK.descriptionHi : DECORBIZ_PACK.descriptionEn}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start pt-1">
                <div className="space-y-3">
                  <label className="flex items-center gap-2.5 cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={gstRegistered}
                      onChange={(e) => setGstRegistered(e.target.checked)}
                      className="w-4 h-4 accent-[var(--primary-dark)]"
                    />
                    <span className="text-sm font-medium">
                      {t('setup.gstRegistered')}
                    </span>
                  </label>
                  {gstRegistered && (
                    <div>
                      <label
                        htmlFor="setup-gstin"
                        className="block text-xs font-medium text-[var(--text-muted)] mb-1"
                      >
                        {t('setup.gstin')}
                      </label>
                      <input
                        id="setup-gstin"
                        type="text"
                        maxLength={15}
                        value={gstin}
                        onChange={(e) => setGstin(e.target.value.toUpperCase())}
                        placeholder="27ABCDE1234F1Z5"
                        aria-describedby={error ? 'setup-error' : undefined}
                        className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="setup-fy"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t('setup.fyStart')}
                  </label>
                  <select
                    id="setup-fy"
                    value={fyStartMonth}
                    onChange={(e) => setFyStartMonth(Number(e.target.value))}
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  >
                    <option value={4}>April (India Standard FY)</option>
                    <option value={1}>January (Calendar Year)</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full h-12 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold text-sm hover:opacity-95 transition-opacity disabled:opacity-50"
              >
                {submitting
                  ? t('setup.creating')
                  : t('setup.createWorkspace')}
              </button>
            </form>
          </div>
        ) : session && totpRequired && !totpVerified ? (
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--primary-soft)] text-[var(--primary-dark)] flex items-center justify-center shrink-0">
                <IconShieldCheck size={20} stroke={2} />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  {language === 'hi' ? 'दो-चरणीय सत्यापन (2FA)' : 'Two-Factor Verification'}
                </h1>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {session.user.email} · Enter 6-digit authenticator code or recovery code
                </p>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-[var(--give-soft)] border border-[var(--give)]/30 text-xs text-[var(--give)] flex items-start gap-2"
              >
                <IconAlertCircle size={16} stroke={2} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleTotpSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="totp-challenge-input"
                  className="block text-sm font-medium mb-1.5"
                >
                  Authenticator or Recovery Code
                </label>
                <input
                  id="totp-challenge-input"
                  type="text"
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.toUpperCase())}
                  placeholder="123456 or A1B2C3D4"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tracking-widest uppercase focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full h-12 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold text-sm hover:opacity-95 disabled:opacity-50"
              >
                {submitting ? 'Verifying...' : 'Verify & Open ERP'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setError(null);
                  void signOut();
                }}
                className="w-full h-11 rounded-lg border border-[var(--border)] text-sm font-medium inline-flex items-center justify-center gap-2 hover:bg-[var(--surface-muted)]"
              >
                <IconLogout size={16} stroke={2} />
                <span>Sign Out & Switch Account</span>
              </button>
            </form>
          </div>
        ) : (
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--primary-soft)] text-[var(--primary-dark)] flex items-center justify-center shrink-0">
                <IconLock size={20} stroke={2} />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  {mode === 'login'
                    ? t('auth.loginTitle')
                    : t('auth.resetTitle')}
                </h1>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {mode === 'login'
                    ? t('auth.loginSubtitle')
                    : t('auth.resetSubtitle')}
                </p>
              </div>
            </div>

            {(error || supabaseConfigMismatch) && (
              <div
                id="auth-error"
                role="alert"
                className="p-3 rounded-lg bg-[var(--give-soft)] border border-[var(--give)]/30 text-xs text-[var(--give)] flex items-start gap-2"
              >
                <IconAlertCircle size={16} stroke={2} className="shrink-0 mt-0.5" />
                <span>
                  {error ??
                    `Configuration mismatch: VITE_SUPABASE_ANON_KEY in this build belongs to project "${supabaseConfigMismatch?.keyRef}", while VITE_SUPABASE_URL points to "${supabaseConfigMismatch?.urlRef}". Update VITE_SUPABASE_ANON_KEY and redeploy.`}
                </span>
              </div>
            )}

            {resetSent && (
              <div className="p-3 rounded-lg bg-[var(--receive-soft)] border border-[var(--receive)]/30 text-xs text-[var(--receive-text)] flex items-start gap-2">
                <IconCheck size={16} stroke={2} className="shrink-0 mt-0.5" />
                <span>{t('auth.resetSent')}</span>
              </div>
            )}

            {mode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label
                    htmlFor="login-email"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t('auth.email')}
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    autoComplete="email"
                    aria-describedby={error ? 'auth-error' : undefined}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor="login-password"
                      className="block text-sm font-medium"
                    >
                      {t('auth.password')}
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('forgot');
                        setError(null);
                      }}
                      className="text-xs font-medium text-[var(--primary-dark)] hover:underline"
                    >
                      {t('auth.forgotPassword')}
                    </button>
                  </div>
                  <input
                    id="login-password"
                    type="password"
                    required
                    autoComplete="current-password"
                    aria-describedby={error ? 'auth-error' : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-12 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold text-sm hover:opacity-95 transition-opacity disabled:opacity-50"
                >
                  {submitting ? t('auth.signingIn') : t('auth.signIn')}
                </button>
              </form>
            ) : (
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <label
                    htmlFor="reset-email"
                    className="block text-sm font-medium mb-1.5"
                  >
                    {t('auth.email')}
                  </label>
                  <input
                    id="reset-email"
                    type="email"
                    required
                    aria-describedby={error ? 'auth-error' : undefined}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-12 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold text-sm hover:opacity-95 transition-opacity disabled:opacity-50"
                >
                  {submitting ? 'Sending...' : t('auth.sendResetLink')}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                    setResetSent(false);
                  }}
                  className="w-full h-11 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)]"
                >
                  {t('auth.backToLogin')}
                </button>
              </form>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
