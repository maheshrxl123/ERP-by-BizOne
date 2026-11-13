import { IconCheck, IconKey, IconMail, IconUser } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  ImageUpload,
  type UploadedImageItem,
} from '../../components/upload/ImageUpload';
import { ROLE_LABELS } from '../../core/permissions';
import { supabase } from '../../core/supabase';

export function UserProfileScreen() {
  const {
    profile,
    language,
    setLanguage,
    theme,
    setTheme,
    signedUrlCache,
    refreshWorkspace,
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

  const syncedProfileStampRef = useRef<string | null>(null);

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
    </div>
  );
}
