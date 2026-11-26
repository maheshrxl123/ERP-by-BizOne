import { IconLock, IconMail, IconUserCheck, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { StoreCustomerSession } from './storeTypes';

interface StoreAuthModalProps {
  open: boolean;
  onClose: () => void;
  onAuthenticated: (session: StoreCustomerSession) => void;
  recoveryToken?: string | null;
  onRecoveryComplete?: () => void;
}

export function StoreAuthModal({
  open,
  onClose,
  onAuthenticated,
  recoveryToken,
  onRecoveryComplete,
}: StoreAuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(
    recoveryToken ? 'reset' : 'login'
  );
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [pendingVerifyEmail, setPendingVerifyEmail] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialogEl = dialogRef.current;
    const getFocusable = () =>
      dialogEl
        ? Array.from(
            dialogEl.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : [];
    const focusables = getFocusable();
    if (focusables.length > 0) focusables[0].focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = getFocusable();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (recoveryToken) {
      setMode('reset');
      setPassword('');
      setConfirmPassword('');
      setError(null);
      setInfoMsg('Enter a new password (min 8 characters) to complete recovery.');
    }
  }, [recoveryToken]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMsg(null);
    setLoading(true);

    try {
      if (mode === 'reset') {
        if (!recoveryToken) {
          throw new Error('Recovery link is missing or expired. Please request a new reset email.');
        }
        if (password.length < 8) {
          throw new Error('New password must be at least 8 characters.');
        }
        if (password !== confirmPassword) {
          throw new Error('Passwords do not match.');
        }
        const res = await fetch('/api/store/auth/update-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${recoveryToken}`,
          },
          body: JSON.stringify({ password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Could not update password.');
        setPassword('');
        setConfirmPassword('');
        setMode('login');
        setInfoMsg(data.message || 'Password updated successfully. Please sign in.');
        onRecoveryComplete?.();
      } else if (mode === 'login') {
        const res = await fetch('/api/store/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Sign in failed.');
        onAuthenticated({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          customer: data.customer,
        });
        onClose();
      } else if (mode === 'register') {
        const res = await fetch('/api/store/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullName, email, password, phone }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Registration failed.');

        if (data.session && data.customer) {
          onAuthenticated({
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            customer: data.customer,
          });
          onClose();
        } else {
          setPendingVerifyEmail(email.trim().toLowerCase());
          setInfoMsg(
            data.message ||
              'Account created. Please check your inbox and verify your email before signing in.'
          );
          setMode('login');
        }
      } else {
        const res = await fetch('/api/store/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Could not send reset email.');
        setInfoMsg(data.message || 'Password reset email sent.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!pendingVerifyEmail) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/store/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pendingVerifyEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to resend verification email.');
      setInfoMsg(data.message || 'Verification email sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resend verification.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/60 backdrop-blur-xs p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-auth-title"
        className="w-full max-w-md rounded-2xl bg-white border border-stone-200 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-700 text-white flex items-center justify-center">
              <IconUserCheck size={17} />
            </div>
            <div>
              <h2 id="store-auth-title" className="text-base font-semibold text-stone-900">
                {mode === 'login'
                  ? 'Customer Sign In'
                  : mode === 'register'
                    ? 'Create Customer Account'
                    : mode === 'reset'
                      ? 'Set New Password'
                      : 'Reset Password'}
              </h2>
              <p className="text-xs text-stone-500">Order tracking, saved wishlists & fast checkout</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close customer sign in modal"
            className="p-1.5 rounded-lg text-stone-500 hover:text-stone-800 hover:bg-stone-200/60"
          >
            <IconX size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {mode !== 'reset' && (
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-stone-100 text-xs font-medium">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
                className={`h-9 rounded-lg transition-colors ${
                  mode === 'login' ? 'bg-white text-stone-900 shadow-xs' : 'text-stone-600'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                }}
                className={`h-9 rounded-lg transition-colors ${
                  mode === 'register' ? 'bg-white text-stone-900 shadow-xs' : 'text-stone-600'
                }`}
              >
                Register
              </button>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
              {error}
            </div>
          )}

          {infoMsg && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-800 space-y-2">
              <p>{infoMsg}</p>
              {pendingVerifyEmail && (
                <button
                  type="button"
                  onClick={() => void handleResendVerification()}
                  className="text-emerald-900 underline font-medium"
                >
                  Resend verification email
                </button>
              )}
            </div>
          )}

          {mode === 'register' && (
            <>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Aarav Sharma"
                  className="w-full h-10 px-3 rounded-lg border border-stone-300 bg-white text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Mobile Phone</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98XXXXXXXX"
                  className="w-full h-10 px-3 rounded-lg border border-stone-300 bg-white text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
                />
              </div>
            </>
          )}

          {mode !== 'reset' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">Email Address</label>
              <div className="relative">
                <IconMail size={16} className="absolute left-3 top-3 text-stone-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-stone-300 bg-white text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
                />
              </div>
            </div>
          )}

          {mode !== 'forgot' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">
                {mode === 'reset' ? 'New Password' : 'Password'}
              </label>
              <div className="relative">
                <IconLock size={16} className="absolute left-3 top-3 text-stone-400" />
                <input
                  type="password"
                  required
                  minLength={mode === 'register' || mode === 'reset' ? 8 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'register' || mode === 'reset' ? 'Minimum 8 characters' : 'Your password'}
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-stone-300 bg-white text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
                />
              </div>
            </div>
          )}

          {mode === 'reset' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">Confirm New Password</label>
              <div className="relative">
                <IconLock size={16} className="absolute left-3 top-3 text-stone-400" />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-stone-300 bg-white text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-sky-600"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {loading
              ? 'Please wait...'
              : mode === 'login'
                ? 'Sign In'
                : mode === 'register'
                  ? 'Create Account'
                  : mode === 'reset'
                    ? 'Update Password'
                    : 'Send Reset Link'}
          </button>

          <div className="flex items-center justify-between text-xs text-stone-500 pt-1">
            {mode !== 'forgot' && mode !== 'reset' ? (
              <button
                type="button"
                onClick={() => {
                  setMode('forgot');
                  setError(null);
                  setInfoMsg(null);
                }}
                className="hover:text-stone-900 underline"
              >
                Forgot password?
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                  setInfoMsg(null);
                }}
                className="hover:text-stone-900 underline"
              >
                Back to Sign In
              </button>
            )}
            <span>Separate retail customer login</span>
          </div>
        </form>
      </div>
    </div>
  );
}
