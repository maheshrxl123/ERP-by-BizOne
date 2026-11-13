import {
  IconCheck,
  IconKey,
  IconLock,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUserPlus,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BUSINESS_PACKS } from '../../../config/app.config';
import { MODULE_REGISTRY } from '../../../config/modules.config';
import { useApp } from '../../app/AppProvider';
import { RequireRole } from '../../app/guards';
import {
  ImageUpload,
  type UploadedImageItem,
} from '../../components/upload/ImageUpload';
import { isValidGstin } from '../../core/format';
import { ROLE_LABELS, type UserRole } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type { IntegrationSettingRecord, ProfileRecord } from '../../types/bizone';

export type SettingsTabKey =
  | 'business'
  | 'invoice'
  | 'modules'
  | 'users'
  | 'appearance'
  | 'integrations';

interface SettingsScreenProps {
  initialTab?: SettingsTabKey;
}

export function SettingsScreen({ initialTab = 'business' }: SettingsScreenProps) {
  const {
    session,
    business,
    profile,
    staff,
    modules,
    language,
    setLanguage,
    theme,
    setTheme,
    signedUrlCache,
    refreshWorkspace,
    showToast,
    t,
  } = useApp();

  const isOwner = profile?.role === 'owner';
  const [activeTab, setActiveTab] = useState<SettingsTabKey>(() =>
    !isOwner && initialTab === 'business' ? 'appearance' : initialTab
  );

  useEffect(() => {
    setActiveTab(!isOwner && initialTab === 'business' ? 'appearance' : initialTab);
  }, [initialTab, isOwner]);

  // S2 Business & S3 Invoice state
  const [bizName, setBizName] = useState('');
  const [gstRegistered, setGstRegistered] = useState(false);
  const [gstin, setGstin] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [upiId, setUpiId] = useState('');
  const [fyStartMonth, setFyStartMonth] = useState(4);
  const [logoImages, setLogoImages] = useState<UploadedImageItem[]>([]);
  const [upiQrImages, setUpiQrImages] = useState<UploadedImageItem[]>([]);
  const [invoicePrefix, setInvoicePrefix] = useState('INV-');
  const [invoiceNext, setInvoiceNext] = useState(1);
  const [invoiceTerms, setInvoiceTerms] = useState('');
  const [taxMode, setTaxMode] = useState<'inclusive' | 'exclusive'>('exclusive');
  const [savingBiz, setSavingBiz] = useState(false);

  // S4 Modules state
  const [moduleSearch, setModuleSearch] = useState('');
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  // S5 Users modal state
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPhone, setNewUserPhone] = useState('');
  const [newUserPass, setNewUserPass] = useState('');
  const [newUserRole, setNewUserRole] = useState<Exclude<UserRole, 'owner'>>('cashier');
  const [addingUser, setAddingUser] = useState(false);
  const [confirmDeactivateUser, setConfirmDeactivateUser] = useState<ProfileRecord | null>(null);
  const [updatingStaffId, setUpdatingStaffId] = useState<string | null>(null);

  // Integrations state
  const [integrations, setIntegrations] = useState<IntegrationSettingRecord[]>([]);
  const [editingIntegration, setEditingIntegration] = useState<string | null>(null);
  const [intSecret, setIntSecret] = useState('');
  const [intEnabled, setIntEnabled] = useState(false);
  const [intConfigJson, setIntConfigJson] = useState<Record<string, string>>({});
  const [savingInt, setSavingInt] = useState(false);

  const syncedBizStampRef = useRef<string | null>(null);

  // Sync text inputs only when the persisted business record updates on the server
  useEffect(() => {
    if (!business) {
      syncedBizStampRef.current = null;
      return;
    }
    const stamp = `${business.id}:${business.updated_at}`;
    if (syncedBizStampRef.current !== stamp) {
      syncedBizStampRef.current = stamp;
      setBizName(business.name || '');
      setGstRegistered(Boolean(business.gst_registered));
      setGstin(business.gstin || '');
      setPhone(business.phone || '');
      setEmail(business.email || '');
      setAddress(business.address || '');
      setStateCode(business.state_code || '');
      setUpiId(business.upi_id || '');
      setFyStartMonth(business.fy_start_month || 4);
      setInvoicePrefix(business.invoice_prefix || 'INV-');
      setInvoiceNext(business.invoice_next_number || 1);
      setInvoiceTerms(business.invoice_terms || '');
      setTaxMode(business.tax_mode || 'exclusive');

      setLogoImages(
        business.logo_file_id
          ? [
              {
                fileId: business.logo_file_id,
                url: signedUrlCache[business.logo_file_id] || '',
                fileName: 'business-logo',
                isPrimary: true,
              },
            ]
          : []
      );
      setUpiQrImages(
        business.upi_qr_file_id
          ? [
              {
                fileId: business.upi_qr_file_id,
                url: signedUrlCache[business.upi_qr_file_id] || '',
                fileName: 'upi-qr',
                isPrimary: true,
              },
            ]
          : []
      );
    }
  }, [business, signedUrlCache]);

  // Hydrate signed URLs for logo/QR without resetting unsaved text fields
  useEffect(() => {
    const logoId = business?.logo_file_id;
    const logoUrl = logoId ? signedUrlCache[logoId] : undefined;
    if (logoId && logoUrl) {
      setLogoImages((prev) =>
        prev.length === 1 && prev[0].fileId === logoId && !prev[0].url
          ? [{ ...prev[0], url: logoUrl }]
          : prev
      );
    }

    const qrId = business?.upi_qr_file_id;
    const qrUrl = qrId ? signedUrlCache[qrId] : undefined;
    if (qrId && qrUrl) {
      setUpiQrImages((prev) =>
        prev.length === 1 && prev[0].fileId === qrId && !prev[0].url
          ? [{ ...prev[0], url: qrUrl }]
          : prev
      );
    }
  }, [business?.logo_file_id, business?.upi_qr_file_id, signedUrlCache]);

  const persistBusinessMedia = async (
    nextLogoId: string | null,
    nextQrId: string | null
  ) => {
    const { error } = await supabase.rpc('update_business_media', {
      p_logo_file_id: nextLogoId,
      p_upi_qr_file_id: nextQrId,
    });
    if (error) throw error;
    await refreshWorkspace();
  };

  const loadIntegrations = async () => {
    if (!isOwner || !session?.access_token) return;
    try {
      const res = await fetch('/api/integrations', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.integrations)) {
        setIntegrations(data.integrations);
      }
    } catch {
      // Optional integrations panel remains non-blocking
    }
  };

  useEffect(() => {
    if (activeTab === 'integrations') {
      void loadIntegrations();
    }
  }, [activeTab, isOwner, session?.access_token]);

  const handleSaveBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwner) return;

    if (gstRegistered && gstin.trim() && !isValidGstin(gstin)) {
      showToast('Invalid 15-character GSTIN format.', 'error');
      return;
    }

    setSavingBiz(true);
    try {
      const { error } = await supabase.rpc('update_business_profile', {
        p_name: bizName.trim(),
        p_gst_registered: gstRegistered,
        p_gstin: gstRegistered ? gstin.trim().toUpperCase() || null : null,
        p_phone: phone.trim() || null,
        p_email: email.trim() || null,
        p_address: address.trim() || null,
        p_state_code: stateCode.trim() || null,
        p_upi_id: upiId.trim() || null,
        p_fy_start_month: fyStartMonth,
        p_logo_file_id: logoImages[0]?.fileId ?? null,
        p_upi_qr_file_id: upiQrImages[0]?.fileId ?? null,
        p_invoice_prefix: invoicePrefix.trim() || 'INV-',
        p_invoice_next_number: Math.max(1, Number(invoiceNext) || 1),
        p_invoice_terms: invoiceTerms,
        p_tax_mode: taxMode,
      });
      if (error) throw error;
      await refreshWorkspace();
      showToast(t('settings.businessSaved'), 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save business settings.',
        'error'
      );
    } finally {
      setSavingBiz(false);
    }
  };

  const handleToggleModule = async (key: string, nextEnabled: boolean) => {
    if (!isOwner) return;
    setTogglingKey(key);
    try {
      const { error } = await supabase.rpc('toggle_module', {
        p_key: key,
        p_enabled: nextEnabled,
      });
      if (error) throw error;
      await refreshWorkspace();
      showToast(`Module ${nextEnabled ? 'enabled' : 'disabled'}.`, 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Module update blocked.',
        'error'
      );
    } finally {
      setTogglingKey(null);
    }
  };

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token) return;
    setAddingUser(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          fullName: newUserName.trim(),
          email: newUserEmail.trim(),
          phone: newUserPhone.trim() || null,
          password: newUserPass,
          role: newUserRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to add user.');

      setShowAddUser(false);
      setNewUserName('');
      setNewUserEmail('');
      setNewUserPhone('');
      setNewUserPass('');
      await refreshWorkspace();
      showToast('Staff member added.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to create staff account.',
        'error'
      );
    } finally {
      setAddingUser(false);
    }
  };

  const handleUpdateStaff = async (
    userId: string,
    patch: { role?: UserRole; is_active?: boolean }
  ) => {
    if (!session?.access_token) return;
    setUpdatingStaffId(userId);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Update failed.');
      setConfirmDeactivateUser(null);
      await refreshWorkspace();
      showToast('Staff access updated.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to update staff.',
        'error'
      );
    } finally {
      setUpdatingStaffId(null);
    }
  };

  const handleSaveIntegration = async (key: string) => {
    if (!session?.access_token) return;
    setSavingInt(true);
    try {
      const res = await fetch(`/api/integrations/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          enabled: intEnabled,
          configPublic: intConfigJson,
          secret: intSecret.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Save failed.');
      setEditingIntegration(null);
      setIntSecret('');
      await loadIntegrations();
      showToast('Integration configuration encrypted and saved.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save integration.',
        'error'
      );
    } finally {
      setSavingInt(false);
    }
  };

  const handleRemoveIntegrationSecret = async (key: string) => {
    if (!session?.access_token) return;
    try {
      const res = await fetch(`/api/integrations/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Removal failed.');
      await loadIntegrations();
      showToast('Integration credentials removed.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to remove credentials.',
        'error'
      );
    }
  };

  const filteredModules = useMemo(() => {
    const q = moduleSearch.trim().toLowerCase();
    return MODULE_REGISTRY.filter((m) => {
      if (!q) return true;
      return (
        m.nameEn.toLowerCase().includes(q) ||
        m.nameHi.toLowerCase().includes(q) ||
        m.descriptionEn.toLowerCase().includes(q)
      );
    });
  }, [moduleSearch]);

  const tabs: Array<{ key: SettingsTabKey; label: string; ownerOnly?: boolean }> = [
    { key: 'business', label: t('settings.tabs.business'), ownerOnly: true },
    { key: 'invoice', label: t('settings.tabs.invoice'), ownerOnly: true },
    { key: 'modules', label: t('settings.tabs.modules'), ownerOnly: true },
    { key: 'users', label: t('settings.tabs.users'), ownerOnly: true },
    { key: 'appearance', label: t('settings.tabs.appearance') },
    { key: 'integrations', label: t('settings.tabs.integrations'), ownerOnly: true },
  ];

  const visibleTabs = tabs.filter((tab) => !tab.ownerOnly || isOwner);
  const currentPack = BUSINESS_PACKS.find((p) => p.key === business?.pack);

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
          {t('settings.title')}
        </h1>
      </div>

      {/* Horizontal in-page tabs (PRD Section 7.2: no second sidebar) */}
      <div className="border-b border-[var(--border)] overflow-x-auto">
        <div className="flex items-center gap-6 min-w-max">
          {visibleTabs.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`relative py-3 text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                  active
                    ? 'text-[var(--primary-dark)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {tab.label}
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--primary-dark)]"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* S2 Business Profile */}
      {activeTab === 'business' && (
        <RequireRole roles={['owner']}>
        <form
          onSubmit={handleSaveBusiness}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-5"
        >
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-[var(--border)]">
            <div>
              <h2 className="text-base font-semibold">
                {t('settings.tabs.business')}
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Pack: {language === 'hi' ? currentPack?.labelHi : currentPack?.labelEn} (code-configured)
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <ImageUpload
              label="Business Logo"
              purpose="business_logo"
              multiple={false}
              value={logoImages}
              onChange={setLogoImages}
              onUploaded={async (items) => {
                await persistBusinessMedia(
                  items[0]?.fileId ?? null,
                  upiQrImages[0]?.fileId ?? business?.upi_qr_file_id ?? null
                );
              }}
              onRemoved={async () => {
                await persistBusinessMedia(
                  null,
                  upiQrImages[0]?.fileId ?? business?.upi_qr_file_id ?? null
                );
              }}
              entityType="business"
              entityId="1"
              helperText="Shown on A4, A5, and thermal invoice headers."
            />
            <ImageUpload
              label="UPI QR Code Image"
              purpose="upi_qr"
              multiple={false}
              value={upiQrImages}
              onChange={setUpiQrImages}
              onUploaded={async (items) => {
                await persistBusinessMedia(
                  logoImages[0]?.fileId ?? business?.logo_file_id ?? null,
                  items[0]?.fileId ?? null
                );
              }}
              onRemoved={async () => {
                await persistBusinessMedia(
                  logoImages[0]?.fileId ?? business?.logo_file_id ?? null,
                  null
                );
              }}
              entityType="business"
              entityId="1"
              helperText="Optional QR image printed on customer invoices."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="biz-name" className="block text-sm font-medium mb-1.5">
                Business Name
              </label>
              <input
                id="biz-name"
                type="text"
                required
                value={bizName}
                onChange={(e) => setBizName(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="biz-phone" className="block text-sm font-medium mb-1.5">
                Business Phone
              </label>
              <input
                id="biz-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="biz-email" className="block text-sm font-medium mb-1.5">
                Business Email
              </label>
              <input
                id="biz-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="biz-upi" className="block text-sm font-medium mb-1.5">
                UPI ID (VPA)
              </label>
              <input
                id="biz-upi"
                type="text"
                value={upiId}
                onChange={(e) => setUpiId(e.target.value)}
                placeholder="shopname@upi"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="biz-address" className="block text-sm font-medium mb-1.5">
              Shop / Office Address
            </label>
            <textarea
              id="biz-address"
              rows={2}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            <label className="flex items-center gap-2.5 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                checked={gstRegistered}
                onChange={(e) => setGstRegistered(e.target.checked)}
                className="w-4 h-4 accent-[var(--primary-dark)]"
              />
              <span className="text-sm font-medium">GST Registered</span>
            </label>

            <div>
              <label htmlFor="biz-gstin" className="block text-sm font-medium mb-1.5">
                GSTIN
              </label>
              <input
                id="biz-gstin"
                type="text"
                maxLength={15}
                disabled={!gstRegistered}
                value={gstin}
                onChange={(e) => setGstin(e.target.value.toUpperCase())}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>

            <div>
              <label htmlFor="biz-state" className="block text-sm font-medium mb-1.5">
                State Code (GST)
              </label>
              <input
                id="biz-state"
                type="text"
                maxLength={4}
                value={stateCode}
                onChange={(e) => setStateCode(e.target.value)}
                placeholder="e.g. 27"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={savingBiz}
              className="w-full sm:w-auto h-11 px-6 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold hover:opacity-95 disabled:opacity-50"
            >
              {savingBiz ? 'Saving...' : t('settings.saveChanges')}
            </button>
          </div>
        </form>
        </RequireRole>
      )}

      {/* S3 Invoice Basics */}
      {activeTab === 'invoice' && (
        <RequireRole roles={['owner']}>
        <form
          onSubmit={handleSaveBusiness}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-5"
        >
          <h2 className="text-base font-semibold">
            {t('settings.tabs.invoice')}
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="inv-prefix" className="block text-sm font-medium mb-1.5">
                Invoice Prefix
              </label>
              <input
                id="inv-prefix"
                type="text"
                required
                value={invoicePrefix}
                onChange={(e) => setInvoicePrefix(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="inv-next" className="block text-sm font-medium mb-1.5">
                Next Number
              </label>
              <input
                id="inv-next"
                type="number"
                min={1}
                value={invoiceNext}
                onChange={(e) => setInvoiceNext(Number(e.target.value))}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="inv-tax-mode" className="block text-sm font-medium mb-1.5">
                Tax Pricing Mode
              </label>
              <select
                id="inv-tax-mode"
                value={taxMode}
                onChange={(e) =>
                  setTaxMode(e.target.value === 'inclusive' ? 'inclusive' : 'exclusive')
                }
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              >
                <option value="exclusive">Tax Exclusive (Rate + GST)</option>
                <option value="inclusive">Tax Inclusive (MRP / Final Rate)</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="inv-terms" className="block text-sm font-medium mb-1.5">
              Default Invoice Terms & Footer Note
            </label>
            <textarea
              id="inv-terms"
              rows={3}
              value={invoiceTerms}
              onChange={(e) => setInvoiceTerms(e.target.value)}
              className="w-full p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingBiz}
              className="w-full sm:w-auto h-11 px-6 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold hover:opacity-95 disabled:opacity-50"
            >
              {savingBiz ? 'Saving...' : t('settings.saveChanges')}
            </button>
          </div>
        </form>
        </RequireRole>
      )}

      {/* S4 Modules & Features */}
      {activeTab === 'modules' && (
        <RequireRole roles={['owner']}>
        <div className="space-y-4">
          <div className="relative">
            <IconSearch
              size={18}
              stroke={2}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            />
            <input
              type="text"
              value={moduleSearch}
              onChange={(e) => setModuleSearch(e.target.value)}
              placeholder="Search modules and features..."
              className="w-full h-11 pl-10 pr-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>

          {(['basic', 'advanced'] as const).map((level) => {
            const list = filteredModules.filter((m) => m.level === level);
            if (list.length === 0) return null;
            return (
              <section
                key={level}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
              >
                <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {level === 'basic'
                      ? 'Basic Modules (Default On)'
                      : 'Advanced Modules (Optional)'}
                  </h2>
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {list.map((mod) => {
                    const state = modules.find((m) => m.module_key === mod.key);
                    const enabled = Boolean(state?.enabled);
                    const requiredByPack = Boolean(
                      currentPack?.requiredModules.includes(mod.key)
                    );
                    const busy = togglingKey === mod.key;

                    return (
                      <div
                        key={mod.key}
                        className="px-5 py-4 flex items-center justify-between gap-4"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">
                              {language === 'hi' ? mod.nameHi : mod.nameEn}
                            </span>
                            <span className="text-xs text-[var(--text-muted)]">
                              · {mod.phase}
                            </span>
                          </div>
                          <p className="text-xs text-[var(--text-muted)] mt-0.5">
                            {language === 'hi'
                              ? mod.descriptionHi
                              : mod.descriptionEn}
                          </p>
                          {(mod.dependsOn.length > 0 || requiredByPack) && (
                            <p className="text-xs text-[var(--primary-dark)] mt-1">
                              {requiredByPack
                                ? `Required by ${currentPack?.labelEn} pack`
                                : `Needs: ${mod.dependsOn.join(', ')}`}
                            </p>
                          )}
                        </div>

                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          disabled={busy || (requiredByPack && enabled)}
                          onClick={() => handleToggleModule(mod.key, !enabled)}
                          className={`min-w-[64px] h-9 px-3 rounded-lg text-xs font-semibold border transition-colors shrink-0 disabled:opacity-50 ${
                            enabled
                              ? 'bg-[var(--primary)] text-[var(--on-primary)] border-[var(--primary)]'
                              : 'bg-[var(--surface-muted)] text-[var(--text-muted)] border-[var(--border)]'
                          }`}
                        >
                          {busy ? '...' : enabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        </RequireRole>
      )}

      {/* S5 Users & Roles */}
      {activeTab === 'users' && (
        <RequireRole roles={['owner']}>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-[var(--text-muted)]">
              Create staff accounts and assign fixed permissions. No self-signup is allowed.
            </p>
            <button
              type="button"
              onClick={() => setShowAddUser(true)}
              className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <IconUserPlus size={18} stroke={2} />
              <span>{t('settings.addUser')}</span>
            </button>
          </div>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-xs font-medium text-[var(--text-muted)]">
                    <th className="py-3 px-4">Staff Member</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Access</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)] text-sm">
                  {staff.map((member) => {
                    const activeOwnersCount = staff.filter(
                      (s) => s.role === 'owner' && s.is_active
                    ).length;
                    const isSelf = member.id === profile?.id;
                    const isLastActiveOwner =
                      member.role === 'owner' &&
                      member.is_active &&
                      activeOwnersCount <= 1;

                    return (
                    <tr key={member.id} className="min-h-[56px]">
                      <td className="py-3 px-4">
                        <div className="font-medium">
                          {member.full_name}
                          {isSelf && (
                            <span className="ml-1.5 text-xs font-normal text-[var(--primary-dark)]">
                              (You)
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-[var(--text-muted)]">
                          {member.email}
                          {member.phone ? ` · ${member.phone}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <select
                          aria-label={`Role for ${member.full_name}`}
                          disabled={isLastActiveOwner || updatingStaffId === member.id}
                          title={
                            isLastActiveOwner
                              ? 'The last active Owner role cannot be changed.'
                              : undefined
                          }
                          value={member.role}
                          onChange={(e) =>
                            handleUpdateStaff(member.id, {
                              role: e.target.value as UserRole,
                            })
                          }
                          className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                        >
                          {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
                            <option key={r} value={r}>
                              {language === 'hi'
                                ? ROLE_LABELS[r].hi
                                : ROLE_LABELS[r].en}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`text-xs font-medium ${
                            member.is_active
                              ? 'text-[var(--receive-text)]'
                              : 'text-[var(--give)]'
                          }`}
                        >
                          {member.is_active ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          disabled={updatingStaffId === member.id || isLastActiveOwner}
                          title={
                            isLastActiveOwner
                              ? 'The last active Owner cannot be deactivated.'
                              : undefined
                          }
                          onClick={() => {
                            if (member.is_active) {
                              setConfirmDeactivateUser(member);
                            } else {
                              void handleUpdateStaff(member.id, { is_active: true });
                            }
                          }}
                          className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)] disabled:opacity-50"
                        >
                          {member.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {showAddUser && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-staff-title"
                className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
              >
                <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
                  <h3 id="add-staff-title" className="text-base font-semibold">
                    {t('settings.addUser')}
                  </h3>
                  <button
                    type="button"
                    aria-label="Close modal"
                    onClick={() => setShowAddUser(false)}
                    className="p-1 text-[var(--text-muted)]"
                  >
                    <IconX size={18} stroke={2} />
                  </button>
                </div>
                <form onSubmit={handleAddStaff} className="p-5 space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      required
                      value={newUserName}
                      onChange={(e) => setNewUserName(e.target.value)}
                      className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Email
                    </label>
                    <input
                      type="email"
                      required
                      value={newUserEmail}
                      onChange={(e) => setNewUserEmail(e.target.value)}
                      className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Phone
                      </label>
                      <input
                        type="tel"
                        value={newUserPhone}
                        onChange={(e) => setNewUserPhone(e.target.value)}
                        className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Role
                      </label>
                      <select
                        value={newUserRole}
                        onChange={(e) =>
                          setNewUserRole(
                            e.target.value as Exclude<UserRole, 'owner'>
                          )
                        }
                        className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                      >
                        {(['manager', 'cashier', 'storekeeper', 'accountant', 'viewer'] as const).map(
                          (r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r].en}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Temporary Password (min 8 chars)
                    </label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={newUserPass}
                      onChange={(e) => setNewUserPass(e.target.value)}
                      className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAddUser(false)}
                      className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={addingUser}
                      className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold disabled:opacity-50"
                    >
                      {addingUser ? 'Creating...' : 'Create Staff'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
          {confirmDeactivateUser && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="deactivate-staff-title"
                className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
              >
                <div className="px-5 py-4 border-b border-[var(--border)]">
                  <h3 id="deactivate-staff-title" className="text-base font-semibold">
                    Deactivate Staff Access?
                  </h3>
                </div>
                <div className="p-5 space-y-4">
                  <p className="text-sm text-[var(--text-muted)]">
                    <span className="font-medium text-[var(--text)]">
                      {confirmDeactivateUser.full_name}
                    </span>{' '}
                    ({confirmDeactivateUser.email}) will immediately lose access to this workspace. Existing audit logs and invoices remain preserved.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmDeactivateUser(null)}
                      className="h-10 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      disabled={updatingStaffId === confirmDeactivateUser.id}
                      onClick={() =>
                        void handleUpdateStaff(confirmDeactivateUser.id, {
                          is_active: false,
                        })
                      }
                      className="h-10 px-4 rounded-lg bg-[var(--give)] text-white text-sm font-semibold disabled:opacity-50"
                    >
                      {updatingStaffId === confirmDeactivateUser.id
                        ? 'Deactivating...'
                        : 'Deactivate'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        </RequireRole>
      )}

      {/* S6 Appearance & Language */}
      {activeTab === 'appearance' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-6">
          <div>
            <h2 className="text-base font-semibold">Appearance</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Choose Light or Dark theme across mobile and desktop.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 max-w-sm">
              {(['light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTheme(mode)}
                  className={`h-11 px-4 rounded-lg border text-sm font-medium ${
                    theme === mode
                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)]'
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

          <div className="pt-4 border-t border-[var(--border)]">
            <h2 className="text-base font-semibold">Language</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Switch interface labels between English and Hindi.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 max-w-sm">
              {(['en', 'hi'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setLanguage(lang)}
                  className={`h-11 px-4 rounded-lg border text-sm font-medium ${
                    language === lang
                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)]'
                      : 'border-[var(--border)] hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  {lang === 'en' ? t('common.english') : t('common.hindi')}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Optional Integrations (PRD Section 17.1) */}
      {activeTab === 'integrations' && (
        <RequireRole roles={['owner']}>
        <div className="space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-xs sm:text-sm text-[var(--text-muted)] flex items-start gap-2.5">
            <IconLock size={18} stroke={2} className="text-[var(--primary-dark)] shrink-0 mt-0.5" />
            <span>
              Optional provider credentials are encrypted server-side using{' '}
              <code className="font-mono">APP_ENCRYPTION_KEY</code>, masked after saving, and never required for setup or core billing.
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {integrations.map((item) => {
              const isEditing = editingIntegration === item.integration_key;
              return (
                <section
                  key={item.integration_key}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold">
                        {item.display_name}
                      </h3>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        {item.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                        {item.has_secret ? 'Secret stored (masked)' : 'No secret configured'}
                      </p>
                    </div>
                    <span
                      className={`text-xs font-medium inline-flex items-center gap-1 ${
                        item.enabled
                          ? 'text-[var(--receive-text)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {item.enabled && <IconCheck size={14} stroke={2.5} />}
                      <span>{item.status.replace(/_/g, ' ')}</span>
                    </span>
                  </div>

                  {item.integration_key === 'google_drive' && (
                    <div className="p-3 rounded-lg bg-[var(--surface-muted)] text-xs text-[var(--text-muted)]">
                      OAuth Callback URL:{' '}
                      <code className="font-mono text-[var(--text)] break-all">
                        {window.location.origin}/api/integrations/google-drive/callback
                      </code>
                    </div>
                  )}

                  {isEditing ? (
                    <div className="space-y-3 pt-2 border-t border-[var(--border)]">
                      <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                        <input
                          type="checkbox"
                          checked={intEnabled}
                          onChange={(e) => setIntEnabled(e.target.checked)}
                          className="w-4 h-4 accent-[var(--primary-dark)]"
                        />
                        <span>Enable this integration</span>
                      </label>

                      <div>
                        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                          API Key / Client Secret (leave blank to keep existing)
                        </label>
                        <input
                          type="password"
                          value={intSecret}
                          onChange={(e) => setIntSecret(e.target.value)}
                          placeholder={item.has_secret ? '••••••••••••••••' : 'Enter credential'}
                          className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                        />
                      </div>

                      {item.integration_key === 'ai_provider' && (
                        <div>
                          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                            Model ID
                          </label>
                          <input
                            type="text"
                            value={intConfigJson.model || ''}
                            onChange={(e) =>
                              setIntConfigJson((p) => ({
                                ...p,
                                model: e.target.value,
                              }))
                            }
                            placeholder="gemini-2.5-flash"
                            className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                          />
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={savingInt}
                          onClick={() => handleSaveIntegration(item.integration_key)}
                          className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
                        >
                          {savingInt ? 'Encrypting...' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingIntegration(null);
                            setIntSecret('');
                          }}
                          className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingIntegration(item.integration_key);
                          setIntEnabled(item.enabled);
                          setIntConfigJson(
                            Object.fromEntries(
                              Object.entries(item.config_public || {}).map(
                                ([k, v]) => [k, String(v)]
                              )
                            )
                          );
                        }}
                        className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
                      >
                        <IconKey size={15} stroke={2} />
                        <span>Configure</span>
                      </button>
                      {item.has_secret && (
                        <button
                          type="button"
                          onClick={() =>
                            handleRemoveIntegrationSecret(item.integration_key)
                          }
                          className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--give)] inline-flex items-center gap-1.5 hover:bg-[var(--give-soft)]"
                        >
                          <IconTrash size={15} stroke={2} />
                          <span>Remove Key</span>
                        </button>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
        </RequireRole>
      )}
    </div>
  );
}
