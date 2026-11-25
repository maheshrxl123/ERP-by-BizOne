import {
  IconCheck,
  IconCopy,
  IconKey,
  IconMail,
  IconShieldCheck,
  IconUser,
} from '@tabler/icons-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  ImageUpload,
  type UploadedImageItem,
} from '../../components/upload/ImageUpload';
import { erpFetch } from '../../core/erpFetch';
import { ROLE_LABELS } from '../../core/permissions';
import { supabase } from '../../core/supabase';

export function UserProfileScreen() {
  const {
    session,
    profile,
    language,
    setLanguage,
    theme,
    setTheme,
    signedUrlCache,
    refreshWorkspace,
    markTotpEnrolled,
    showToast,
    t,
  } = useApp();

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [avatarImages, setAvatarImages] = useState<UploadedImageItem[]>([]);
  const [savingProfile, setSavingProfile] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Two-Factor Authentication (TOTP) state
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [loadingTotpStatus, setLoadingTotpStatus] = useState(false);
  const [settingUpTotp, setSettingUpTotp] = useState(false);
  const [verifyingTotp, setVerifyingTotp] = useState(false);
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [setupQrDataUrl, setSetupQrDataUrl] = useState<string | null>(null);
  const [setupRecoveryCodes, setSetupRecoveryCodes] = useState<string[]>([]);
  const [verifyTotpCode, setVerifyTotpCode] = useState('');

  const syncedProfileStampRef = useRef<string | null>(null);

  const loadTotpStatus = useCallback(async () => {
    if (!session?.access_token) return;
    setLoadingTotpStatus(true);
    try {
      const res = await erpFetch('/api/erp/auth/totp-status', session.access_token);
      if (res.ok) {
        const data = await res.json();
        setTotpEnabled(Boolean(data?.enabled));
      }
    } catch {
      // Non-blocking
    } finally {
      setLoadingTotpStatus(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    void loadTotpStatus();
  }, [loadTotpStatus]);

  const handleStartTotpSetup = async () => {
    if (!session?.access_token) return;
    setSettingUpTotp(true);
    try {
      const res = await erpFetch('/api/erp/auth/totp-setup', session.access_token, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Unable to start 2FA setup.');
      setSetupSecret(String(data.secret || ''));
      setSetupRecoveryCodes(Array.isArray(data.recoveryCodes) ? data.recoveryCodes : []);
      if (typeof data.otpauthUrl === 'string') {
        const qrUrl = await QRCode.toDataURL(data.otpauthUrl, { width: 220, margin: 1 });
        setSetupQrDataUrl(qrUrl);
      } else {
        setSetupQrDataUrl(null);
      }
      setVerifyTotpCode('');
      setTotpEnabled(false);
      showToast('Scan QR code and verify with a 6-digit code to activate 2FA.', 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to initialize 2FA.', 'error');
    } finally {
      setSettingUpTotp(false);
    }
  };

  const handleVerifyTotpSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token || !verifyTotpCode.trim()) return;
    setVerifyingTotp(true);
    try {
      const res = await erpFetch('/api/erp/auth/totp-verify', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verifyTotpCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Verification failed.');
      markTotpEnrolled(typeof data?.totpProof === 'string' ? data.totpProof : null);
      setTotpEnabled(true);
      setVerifyTotpCode('');
      showToast(data?.message || 'Two-factor authentication enabled.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Invalid authenticator code.', 'error');
    } finally {
      setVerifyingTotp(false);
    }
  };

  // Sync text inputs only when profile record actually changes on the server
  useEffect(() => {
    if (!profile) {
      syncedProfileStampRef.current = null;
      return;
    }
    const stamp = `${profile.id}:${profile.updated_at}:${profile.email}`;
    if (syncedProfileStampRef.current !== stamp) {
      syncedProfileStampRef.current = stamp;
      setFullName(profile.full_name || '');
      setPhone(profile.phone || '');
      setNewEmail(profile.email || '');
      setAvatarImages(
        profile.avatar_file_id
          ? [
              {
                fileId: profile.avatar_file_id,
                url: signedUrlCache[profile.avatar_file_id] || '',
                fileName: 'profile-photo',
                isPrimary: true,
              },
            ]
          : []
      );
    }
  }, [profile, signedUrlCache]);

  // Hydrate avatar signed URL without overwriting unsaved text fields
  useEffect(() => {
    const avatarId = profile?.avatar_file_id;
    const cachedUrl = avatarId ? signedUrlCache[avatarId] : undefined;
    if (!avatarId || !cachedUrl) return;
    setAvatarImages((prev) => {
      if (prev.length === 1 && prev[0].fileId === avatarId && !prev[0].url) {
        return [{ ...prev[0], url: cachedUrl }];
      }
      return prev;
    });
  }, [profile?.avatar_file_id, signedUrlCache]);

  const persistProfilePatch = async (avatarId: string | null) => {
    const targetName = fullName.trim() || profile?.full_name?.trim() || '';
    if (!targetName) {
      throw new Error('Full name is required.');
    }
    const { error } = await supabase.rpc('update_own_profile', {
      p_full_name: targetName,
      p_phone: phone.trim() || null,
      p_avatar_file_id: avatarId,
      p_preferred_language: language,
      p_preferred_theme: theme,
    });
    if (error) throw error;
    await refreshWorkspace();
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      showToast('Full name is required.', 'error');
      return;
    }

    setSavingProfile(true);
    try {
      const { error } = await supabase.rpc('update_own_profile', {
        p_full_name: fullName.trim(),
        p_phone: phone.trim() || null,
        p_avatar_file_id: avatarImages[0]?.fileId ?? null,
        p_preferred_language: language,
        p_preferred_theme: theme,
      });
      if (error) throw error;
      await refreshWorkspace();
      showToast(t('profile.saved'), 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save profile.',
        'error'
      );
    } finally {
      setSavingProfile(false);
    }
  };

  const handleUpdateEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEmail = newEmail.trim();
    if (!targetEmail || targetEmail === profile?.email) return;

    setSavingEmail(true);
    try {
      const { error } = await supabase.auth.updateUser(
        { email: targetEmail },
        { emailRedirectTo: window.location.origin }
      );
      if (error) throw error;
      setPendingVerificationEmail(targetEmail);
      showToast(
        'Verification link sent to your new email address.',
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to request email change.',
        'error'
      );
    } finally {
      setSavingEmail(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      showToast('Password must be at least 8 characters.', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast('Passwords do not match.', 'error');
      return;
    }

    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (error) throw error;
      setNewPassword('');
      setConfirmPassword('');
      showToast('Password updated securely.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to change password.',
        'error'
      );
    } finally {
      setSavingPassword(false);
    }
  };

  if (!profile) return null;

  const roleInfo = ROLE_LABELS[profile.role];

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
          {t('profile.title')}
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          {t('profile.subtitle')}
        </p>
      </div>

      {/* Personal Details + Photo */}
      <form
        onSubmit={handleSaveProfile}
        className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-5"
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <IconUser size={18} stroke={2} className="text-[var(--primary-dark)]" />
          <span>Personal Details</span>
        </div>

        <ImageUpload
          label={t('profile.photo')}
          purpose="avatar"
          multiple={false}
          value={avatarImages}
          onChange={setAvatarImages}
          onUploaded={async (items) => {
            await persistProfilePatch(items[0]?.fileId ?? null);
          }}
          onRemoved={async () => {
            await persistProfilePatch(null);
          }}
          entityType="profile"
          entityId={profile.id}
          helperText="Stored in private Supabase Storage; accessible via short-lived signed URLs."
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="profile-name"
              className="block text-sm font-medium mb-1.5"
            >
              {t('profile.displayName')}
            </label>
            <input
              id="profile-name"
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>

          <div>
            <label
              htmlFor="profile-phone"
              className="block text-sm font-medium mb-1.5"
            >
              {t('profile.phone')}
            </label>
            <input
              id="profile-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>
        </div>

        {/* Read-only role & status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)]">
          <div>
            <span className="text-xs text-[var(--text-muted)]">
              {t('profile.role')}
            </span>
            <p className="text-sm font-semibold mt-0.5">
              {language === 'hi' ? roleInfo.hi : roleInfo.en}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {roleInfo.summaryEn}
            </p>
          </div>
          <div>
            <span className="text-xs text-[var(--text-muted)]">
              {t('profile.status')}
            </span>
            <p className="text-sm font-semibold mt-0.5 text-[var(--receive-text)] inline-flex items-center gap-1.5">
              <IconCheck size={16} stroke={2.5} />
              <span>
                {profile.is_active
                  ? t('profile.active')
                  : t('profile.inactive')}
              </span>
            </p>
          </div>
        </div>

        {/* Personal Preferences */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <span className="block text-sm font-medium mb-1.5">Language</span>
            <div className="flex gap-2">
              {(['en', 'hi'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setLanguage(lang)}
                  className={`flex-1 h-11 rounded-lg border text-sm font-medium ${
                    language === lang
                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--text)]'
                      : 'border-[var(--border)] hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  {lang === 'en' ? t('common.english') : t('common.hindi')}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="block text-sm font-medium mb-1.5">Theme</span>
            <div className="flex gap-2">
              {(['light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTheme(mode)}
                  className={`flex-1 h-11 rounded-lg border text-sm font-medium ${
                    theme === mode
                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--text)]'
                      : 'border-[var(--border)] hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  {mode === 'light'
                    ? t('common.lightMode')
                    : t('common.darkMode')}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={savingProfile}
            className="w-full sm:w-auto h-11 px-6 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold hover:opacity-95 disabled:opacity-50"
          >
            {savingProfile ? t('profile.saving') : t('profile.saveProfile')}
          </button>
        </div>
      </form>

      {/* Verified Email Change */}
      <form
        onSubmit={handleUpdateEmail}
        className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <IconMail size={18} stroke={2} className="text-[var(--primary-dark)]" />
          <span>{t('profile.emailTitle')}</span>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {t('profile.emailHelp')}
        </p>
        {pendingVerificationEmail && (
          <div className="p-3 rounded-lg bg-[var(--primary-soft)] text-xs text-[var(--primary-dark)]">
            Confirmation pending for <strong>{pendingVerificationEmail}</strong>. Click the verification link sent to complete the change.
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            required
            aria-label={t('profile.emailTitle')}
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="flex-1 h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
          />
          <button
            type="submit"
            disabled={savingEmail || newEmail.trim() === profile.email}
            className="h-11 px-5 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)] disabled:opacity-50"
          >
            {savingEmail ? 'Sending...' : t('profile.updateEmail')}
          </button>
        </div>
      </form>

      {/* Password Change */}
      <form
        onSubmit={handleUpdatePassword}
        className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <IconKey size={18} stroke={2} className="text-[var(--primary-dark)]" />
          <span>{t('profile.passwordTitle')}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="new-password"
              className="block text-sm font-medium mb-1.5"
            >
              {t('profile.newPassword')}
            </label>
            <input
              id="new-password"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>
          <div>
            <label
              htmlFor="confirm-password"
              className="block text-sm font-medium mb-1.5"
            >
              {t('profile.confirmPassword')}
            </label>
            <input
              id="confirm-password"
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={savingPassword}
            className="w-full sm:w-auto h-11 px-5 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)] disabled:opacity-50"
          >
            {savingPassword ? 'Updating...' : t('profile.updatePassword')}
          </button>
        </div>
      </form>

      {/* Two-Factor Authentication (TOTP 2FA) */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-base font-semibold">
            <IconShieldCheck size={18} stroke={2} className="text-[var(--primary-dark)]" />
            <span>Two-Factor Authentication (2FA)</span>
          </div>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-md border ${
              totpEnabled
                ? 'border-[var(--receive)] text-[var(--receive-text)] bg-[var(--receive-soft)]'
                : 'border-[var(--border)] text-[var(--text-muted)] bg-[var(--surface-muted)]'
            }`}
          >
            {loadingTotpStatus ? 'Checking...' : totpEnabled ? 'Enabled' : 'Not Enabled'}
          </span>
        </div>

        <p className="text-xs text-[var(--text-muted)]">
          Protect ERP access with an authenticator app (Google Authenticator, Authy, 1Password). One-time recovery codes are shown once during enrollment. If locked out, the Business Owner can reset 2FA from Settings → Users.
        </p>

        {!setupSecret && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={settingUpTotp}
              onClick={() => void handleStartTotpSetup()}
              className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold hover:opacity-95 disabled:opacity-50"
            >
              {settingUpTotp
                ? 'Generating Secret...'
                : totpEnabled
                  ? 'Re-enroll / Rotate 2FA Secret'
                  : 'Enable 2FA Authenticator'}
            </button>
          </div>
        )}

        {setupSecret && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-4 sm:p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
              <div className="space-y-3">
                <p className="text-xs font-semibold">
                  1. Scan QR Code in your Authenticator App
                </p>
                {setupQrDataUrl && (
                  <img
                    src={setupQrDataUrl}
                    alt="DecorBiz 2FA QR Code"
                    className="w-44 h-44 rounded-lg border border-[var(--border)] bg-white p-2"
                  />
                )}
                <div className="space-y-1">
                  <div className="text-[11px] text-[var(--text-muted)]">
                    Manual Base32 Secret Key:
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="px-2.5 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] text-xs font-mono break-all">
                      {setupSecret}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(setupSecret);
                        showToast('2FA secret copied.', 'success');
                      }}
                      className="h-8 px-2.5 rounded border border-[var(--border)] bg-[var(--surface)] text-xs inline-flex items-center gap-1"
                    >
                      <IconCopy size={13} stroke={2} />
                      <span>Copy</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold">
                    2. Save One-Time Recovery Codes
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(setupRecoveryCodes.join('\n'));
                      showToast('Recovery codes copied.', 'success');
                    }}
                    className="text-xs font-medium text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline"
                  >
                    <IconCopy size={13} stroke={2} />
                    <span>Copy All</span>
                  </button>
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Store these codes offline safely. They are hashed server-side and cannot be retrieved again after closing this panel.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {setupRecoveryCodes.map((code) => (
                    <code
                      key={code}
                      className="px-2.5 py-1.5 rounded bg-[var(--surface)] border border-[var(--border)] text-xs font-mono text-center tracking-wider"
                    >
                      {code}
                    </code>
                  ))}
                </div>
              </div>
            </div>

            {!totpEnabled ? (
              <form
                onSubmit={handleVerifyTotpSetup}
                className="pt-4 border-t border-[var(--border)] flex flex-col sm:flex-row gap-3 sm:items-end"
              >
                <div className="flex-1">
                  <label
                    htmlFor="profile-totp-code"
                    className="block text-xs font-medium mb-1"
                  >
                    3. Enter 6-digit code from Authenticator App to activate
                  </label>
                  <input
                    id="profile-totp-code"
                    type="text"
                    required
                    maxLength={6}
                    value={verifyTotpCode}
                    onChange={(e) => setVerifyTotpCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={verifyingTotp || verifyTotpCode.length !== 6}
                    className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold disabled:opacity-50"
                  >
                    {verifyingTotp ? 'Verifying...' : 'Verify & Enable 2FA'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSetupSecret(null);
                      setSetupQrDataUrl(null);
                      setSetupRecoveryCodes([]);
                      setVerifyTotpCode('');
                    }}
                    className="h-11 px-4 rounded-lg border border-[var(--border)] text-xs font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="pt-3 border-t border-[var(--border)] flex items-center justify-between gap-3 text-xs text-[var(--receive-text)]">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <IconCheck size={15} stroke={2.5} />
                  2FA is now active on your account. Make sure you have saved the recovery codes above before closing.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSetupSecret(null);
                    setSetupQrDataUrl(null);
                    setSetupRecoveryCodes([]);
                  }}
                  className="h-9 px-3 rounded-lg border border-[var(--border)] text-[var(--text)] font-medium shrink-0"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
