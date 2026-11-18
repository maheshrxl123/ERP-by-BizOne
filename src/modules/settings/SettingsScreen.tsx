import {
  IconAlertTriangle,
  IconBriefcase,
  IconCheck,
  IconCloud,
  IconCloudUpload,
  IconCopy,
  IconDatabase,
  IconDownload,
  IconExternalLink,
  IconFileSpreadsheet,
  IconHistory,
  IconKey,
  IconLock,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconTrash,
  IconUpload,
  IconUserPlus,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUSINESS_PACKS, type BusinessPackKey } from '../../../config/app.config';
import { MODULE_REGISTRY } from '../../../config/modules.config';
import { useApp } from '../../app/AppProvider';
import { RequireRole } from '../../app/guards';
import {
  ImageUpload,
  type UploadedImageItem,
} from '../../components/upload/ImageUpload';
import {
  buildSignedBackupBlob,
  decryptBackupWithPassphrase,
  downloadJsonFile,
  encryptBackupWithPassphrase,
  isEncryptedBackupEnvelope,
  verifyBackupEnvelope,
  type WorkspaceBackupEnvelope,
} from '../../core/backup';
import {
  formatDateTime,
  isValidGstin,
  todayLocalIso,
} from '../../core/format';
import { hasCapability, ROLE_LABELS, type UserRole } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  BackupHistoryRecord,
  DriveBackupFile,
  DriveConnectionStatus,
  IntegrationSettingRecord,
  ProfileRecord,
  StorageUsageSummary,
} from '../../types/bizone';
import { ImportExportPanel } from '../data/ImportExportPanel';

export type SettingsTabKey =
  | 'business'
  | 'invoice'
  | 'modules'
  | 'users'
  | 'appearance'
  | 'data'
  | 'backup'
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
    isModuleEnabled,
    refreshWorkspace,
    showToast,
    t,
  } = useApp();

  const isOwner = profile?.role === 'owner';
  const canAccessBackup =
    hasCapability(profile?.role, 'backup') &&
    (isOwner || isModuleEnabled('backup'));
  const canAccessData = ['owner', 'manager', 'storekeeper', 'accountant'].includes(
    profile?.role ?? ''
  );

  const resolveAllowedTab = useCallback(
    (tabKey: SettingsTabKey): SettingsTabKey => {
      if (isOwner) return tabKey;
      if (tabKey === 'backup' && canAccessBackup) return 'backup';
      if (tabKey === 'data' && canAccessData) return 'data';
      return 'appearance';
    },
    [isOwner, canAccessBackup, canAccessData]
  );

  const [activeTab, setActiveTab] = useState<SettingsTabKey>(() =>
    resolveAllowedTab(initialTab)
  );

  useEffect(() => {
    setActiveTab(resolveAllowedTab(initialTab));
  }, [initialTab, resolveAllowedTab]);

  // S2 Business & S3 Invoice state
  const [bizName, setBizName] = useState('');
  const [gstRegistered, setGstRegistered] = useState(false);
  const [gstin, setGstin] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [upiId, setUpiId] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountHolder, setBankAccountHolder] = useState('');
  const [bankAccountNo, setBankAccountNo] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');
  const [bankBranch, setBankBranch] = useState('');
  const [bankAccountType, setBankAccountType] = useState('Current');
  const [showBankOnInvoice, setShowBankOnInvoice] = useState(true);
  const [fyStartMonth, setFyStartMonth] = useState(4);
  const [logoImages, setLogoImages] = useState<UploadedImageItem[]>([]);
  const [upiQrImages, setUpiQrImages] = useState<UploadedImageItem[]>([]);
  const [invoicePrefix, setInvoicePrefix] = useState('INV-');
  const [invoiceNext, setInvoiceNext] = useState(1);
  const [quotationPrefix, setQuotationPrefix] = useState('QTN-');
  const [quotationNext, setQuotationNext] = useState(1);
  const [creditNotePrefix, setCreditNotePrefix] = useState('CN-');
  const [creditNoteNext, setCreditNoteNext] = useState(1);
  const [purchasePrefix, setPurchasePrefix] = useState('PUR-');
  const [purchaseNext, setPurchaseNext] = useState(1);
  const [purchaseReturnPrefix, setPurchaseReturnPrefix] = useState('PR-');
  const [purchaseReturnNext, setPurchaseReturnNext] = useState(1);
  const [expensePrefix, setExpensePrefix] = useState('EXP-');
  const [expenseNext, setExpenseNext] = useState(1);
  const [invoiceTerms, setInvoiceTerms] = useState('');
  const [taxMode, setTaxMode] = useState<'inclusive' | 'exclusive'>('exclusive');
  const [defaultPrintLayout, setDefaultPrintLayout] = useState<'a4' | 'a5' | 'thermal_80'>('a4');
  const [showUpiQrOnInvoice, setShowUpiQrOnInvoice] = useState(true);
  const [showCashierOnInvoice, setShowCashierOnInvoice] = useState(true);
  const [defaultCashierName, setDefaultCashierName] = useState('');
  const [showSignatoryOnInvoice, setShowSignatoryOnInvoice] = useState(true);
  const [signatoryLabel, setSignatoryLabel] = useState('Authorized Signatory');
  const [showHsnOnInvoice, setShowHsnOnInvoice] = useState(true);
  const [showMrpSavingsOnInvoice, setShowMrpSavingsOnInvoice] = useState(true);
  const [showCustomerDetailsOnInvoice, setShowCustomerDetailsOnInvoice] = useState(true);
  const [invoiceGreeting, setInvoiceGreeting] = useState('Thank you! Visit Again');
  const [cashierMaxDiscountPct, setCashierMaxDiscountPct] = useState('10');
  const [allowCashierPriceOverride, setAllowCashierPriceOverride] = useState(false);
  const [drugLicenceNo, setDrugLicenceNo] = useState('');
  const [savingBiz, setSavingBiz] = useState(false);

  // S10 Pack Switcher, Demo Data & Workspace Reset state
  const [targetPack, setTargetPack] = useState<BusinessPackKey>('general_retail');
  const [enablePackModules, setEnablePackModules] = useState(true);
  const [loadDemoOnSwitch, setLoadDemoOnSwitch] = useState(false);
  const [switchingPack, setSwitchingPack] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [resetPhrase, setResetPhrase] = useState('');
  const [resettingWorkspace, setResettingWorkspace] = useState(false);

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

  // Backup & Storage state
  const [storageSummary, setStorageSummary] = useState<StorageUsageSummary | null>(null);
  const [backupHistory, setBackupHistory] = useState<BackupHistoryRecord[]>([]);
  const [loadingBackup, setLoadingBackup] = useState(false);
  const [exportingBackup, setExportingBackup] = useState(false);
  const [includeFiles, setIncludeFiles] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [encryptedRestoreRaw, setEncryptedRestoreRaw] = useState<{
    fileName: string;
    rawText: string;
  } | null>(null);
  const [decryptPassphrase, setDecryptPassphrase] = useState('');
  const [decryptingBackup, setDecryptingBackup] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{
    fileName: string;
    envelope: WorkspaceBackupEnvelope;
    checksum: string;
    checksumVerified: boolean;
  } | null>(null);
  const [restoreParseError, setRestoreParseError] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [lastRestoredCounts, setLastRestoredCounts] = useState<Record<string, number> | null>(null);

  // Google Drive Cloud Backup state
  const [driveStatus, setDriveStatus] = useState<DriveConnectionStatus | null>(null);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [driveAuthUrl, setDriveAuthUrl] = useState<string | null>(null);
  const [driveBackups, setDriveBackups] = useState<DriveBackupFile[]>([]);
  const [syncingDrive, setSyncingDrive] = useState(false);
  const [restoringDriveId, setRestoringDriveId] = useState<string | null>(null);
  const [driveScheduleEnabled, setDriveScheduleEnabled] = useState(false);
  const [driveScheduleFreq, setDriveScheduleFreq] = useState<'daily' | 'weekly'>('daily');
  const [driveRetention, setDriveRetention] = useState(10);
  const [driveFolderName, setDriveFolderName] = useState('BizOne ERP Backups');
  const [savingDriveSchedule, setSavingDriveSchedule] = useState(false);

  // Integrations state
  const [integrations, setIntegrations] = useState<IntegrationSettingRecord[]>([]);
  const [editingIntegration, setEditingIntegration] = useState<string | null>(null);
  const [intSecret, setIntSecret] = useState('');
  const [intEnabled, setIntEnabled] = useState(false);
  const [intConfigJson, setIntConfigJson] = useState<Record<string, string>>({});
  const [savingInt, setSavingInt] = useState(false);
  const [testingIntKey, setTestingIntKey] = useState<string | null>(null);

  // Business Snapshot & Recent Activity state (moved from HomeScreen)
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [recentAuditLogs, setRecentAuditLogs] = useState<
    Array<{
      id: string;
      action: string;
      entity_type: string;
      actor_email: string | null;
      created_at: string;
    }>
  >([]);

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
      const ps = (business.pack_settings || {}) as Record<string, unknown>;
      setBankName(typeof ps.bank_name === 'string' ? ps.bank_name : '');
      setBankAccountHolder(
        typeof ps.bank_account_holder === 'string' ? ps.bank_account_holder : ''
      );
      setBankAccountNo(typeof ps.bank_account_no === 'string' ? ps.bank_account_no : '');
      setBankIfsc(typeof ps.bank_ifsc === 'string' ? ps.bank_ifsc : '');
      setBankBranch(typeof ps.bank_branch === 'string' ? ps.bank_branch : '');
      setBankAccountType(
        typeof ps.bank_account_type === 'string' && ps.bank_account_type
          ? ps.bank_account_type
          : 'Current'
      );
      setShowBankOnInvoice(ps.show_bank_on_invoice !== false);
      setShowCashierOnInvoice(ps.show_cashier_on_invoice !== false);
      setDefaultCashierName(
        typeof ps.default_cashier_name === 'string' ? ps.default_cashier_name : ''
      );
      setShowSignatoryOnInvoice(ps.show_signatory_on_invoice !== false);
      setSignatoryLabel(
        typeof ps.signatory_label === 'string' && ps.signatory_label
          ? ps.signatory_label
          : 'Authorized Signatory'
      );
      setShowHsnOnInvoice(ps.show_hsn_on_invoice !== false);
      setShowMrpSavingsOnInvoice(ps.show_mrp_savings_on_invoice !== false);
      setShowCustomerDetailsOnInvoice(ps.show_customer_details_on_invoice !== false);
      setInvoiceGreeting(
        typeof ps.invoice_greeting === 'string'
          ? ps.invoice_greeting
          : 'Thank you! Visit Again'
      );
      setFyStartMonth(business.fy_start_month || 4);
      setInvoicePrefix(business.invoice_prefix || 'INV-');
      setInvoiceNext(business.invoice_next_number || 1);
      setQuotationPrefix(business.quotation_prefix || 'QTN-');
      setQuotationNext(business.quotation_next_number || 1);
      setCreditNotePrefix(business.credit_note_prefix || 'CN-');
      setCreditNoteNext(business.credit_note_next_number || 1);
      setPurchasePrefix(business.purchase_prefix || 'PUR-');
      setPurchaseNext(business.purchase_next_number || 1);
      setPurchaseReturnPrefix(business.purchase_return_prefix || 'PR-');
      setPurchaseReturnNext(business.purchase_return_next_number || 1);
      setExpensePrefix(business.expense_prefix || 'EXP-');
      setExpenseNext(business.expense_next_number || 1);
      setInvoiceTerms(business.invoice_terms || '');
      setTaxMode(business.tax_mode || 'exclusive');
      setDefaultPrintLayout(business.default_print_layout || 'a4');
      setShowUpiQrOnInvoice(business.show_upi_qr_on_invoice ?? true);
      setCashierMaxDiscountPct(String(business.cashier_max_discount_pct ?? 10));
      setAllowCashierPriceOverride(Boolean(business.allow_cashier_price_override));
      setDrugLicenceNo(business.drug_licence_no || '');
      setTargetPack(business.pack);

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
      const intRes = await fetch('/api/integrations', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await intRes.json();
      if (intRes.ok && Array.isArray(data.integrations)) {
        setIntegrations(data.integrations);
      }
    } catch {
      // Optional integrations panel remains non-blocking
    }
  };

  const loadBackupInfo = useCallback(async () => {
    if (!canAccessBackup) return;
    setLoadingBackup(true);
    try {
      const [storageRes, histRes] = await Promise.all([
        supabase.rpc('get_storage_usage_summary'),
        supabase
          .from('backup_records')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(15),
      ]);
      if (!storageRes.error && storageRes.data) {
        setStorageSummary(storageRes.data as StorageUsageSummary);
      }
      if (!histRes.error && Array.isArray(histRes.data)) {
        setBackupHistory(histRes.data as BackupHistoryRecord[]);
      }
    } catch {
      // Non-blocking fallback
    } finally {
      setLoadingBackup(false);
    }
  }, [canAccessBackup]);

  const loadDriveStatus = useCallback(async () => {
    if (!canAccessBackup || !session?.access_token) return;
    setLoadingDrive(true);
    try {
      const res = await fetch('/api/integrations/google-drive/status', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (res.ok) {
        const st = data as DriveConnectionStatus;
        setDriveStatus(st);
        setDriveScheduleEnabled(st.scheduleEnabled);
        setDriveScheduleFreq(st.scheduleFrequency === 'weekly' ? 'weekly' : 'daily');
        setDriveRetention(st.retentionCount || 10);
        setDriveFolderName(st.folderName || 'BizOne ERP Backups');
      }
    } catch {
      // Optional Drive integration remains non-blocking
    } finally {
      setLoadingDrive(false);
    }
  }, [canAccessBackup, session?.access_token]);

  const loadSnapshotAndActivity = useCallback(async () => {
    if (!isOwner) return;
    try {
      const [metricsRes, logsRes] = await Promise.all([
        supabase.rpc('get_dashboard_metrics'),
        supabase
          .from('audit_logs')
          .select('id, action, entity_type, actor_email, created_at')
          .order('created_at', { ascending: false })
          .limit(8),
      ]);
      if (!metricsRes.error && metricsRes.data && typeof metricsRes.data === 'object') {
        const d = metricsRes.data as Record<string, unknown>;
        setLastBackupAt(
          typeof d.last_backup_at === 'string' ? d.last_backup_at : null
        );
      }
      if (!logsRes.error && Array.isArray(logsRes.data)) {
        setRecentAuditLogs(
          logsRes.data as Array<{
            id: string;
            action: string;
            entity_type: string;
            actor_email: string | null;
            created_at: string;
          }>
        );
      }
    } catch {
      // Non-blocking fallback
    }
  }, [isOwner]);

  useEffect(() => {
    if (activeTab === 'business' || activeTab === 'users') {
      void loadSnapshotAndActivity();
    }
    if (activeTab === 'integrations') {
      void loadIntegrations();
    }
    if (activeTab === 'backup') {
      void loadBackupInfo();
      void loadDriveStatus();
    }
  }, [
    activeTab,
    isOwner,
    session?.access_token,
    loadSnapshotAndActivity,
    loadBackupInfo,
    loadDriveStatus,
  ]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const msg = ev.data as { type?: string; ok?: boolean; message?: string } | null;
      if (msg?.type === 'bizone-drive-oauth') {
        setDriveAuthUrl(null);
        showToast(
          msg.message || (msg.ok ? 'Google Drive connected.' : 'Google Drive connection failed.'),
          msg.ok ? 'success' : 'error'
        );
        void loadDriveStatus();
      }
    };
    window.addEventListener('message', onMessage);
    const params = new URLSearchParams(window.location.search);
    if (params.get('drive') === 'connected') {
      showToast('Google Drive connected successfully.', 'success');
      void loadDriveStatus();
    } else if (params.get('drive') === 'error') {
      showToast('Google Drive authorization failed.', 'error');
    }
    return () => window.removeEventListener('message', onMessage);
  }, [loadDriveStatus, showToast]);

  const handleDownloadBackup = async () => {
    if (!isModuleEnabled('backup')) {
      showToast('Backup module is disabled.', 'error');
      return;
    }
    const cleanPass = exportPassphrase.trim();
    if (cleanPass.length > 0 && cleanPass.length < 4) {
      showToast('Encryption passphrase must be at least 4 characters long.', 'error');
      return;
    }
    setExportingBackup(true);
    try {
      const { data, error } = await supabase.rpc('export_workspace_backup', {
        p_backup_type: 'manual',
        p_include_files: includeFiles,
        p_destination: 'local',
        p_drive_file_id: null,
      });
      if (error) throw error;
      const envelope = data as WorkspaceBackupEnvelope;
      let omittedCount = 0;

      if (includeFiles && session?.access_token) {
        const res = await fetch('/api/backup/export-bundle', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const bundle = await res.json();
        if (!res.ok) throw new Error(bundle?.error || 'Failed to bundle attachments.');
        envelope.attachments = Array.isArray(bundle.attachments) ? bundle.attachments : [];
        omittedCount = Number(bundle.omittedCount || 0);
      }

      const blob = cleanPass
        ? await encryptBackupWithPassphrase(envelope, cleanPass)
        : await buildSignedBackupBlob(envelope);

      downloadJsonFile(
        `bizone-backup-${todayLocalIso()}${cleanPass ? '-enc' : ''}.json`,
        blob.jsonText
      );
      await refreshWorkspace();
      await loadBackupInfo();
      const extraNote =
        omittedCount > 0 ? ` (${omittedCount} oversized files omitted)` : '';
      showToast(
        language === 'hi'
          ? `बैकअप डाउनलोड हो गया (SHA-256: ${blob.checksum.slice(0, 10)}...)${extraNote}`
          : `${cleanPass ? 'Encrypted backup' : 'Backup'} downloaded & verified (SHA-256: ${blob.checksum.slice(0, 10)}...)${extraNote}`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to export backup.',
        'error'
      );
    } finally {
      setExportingBackup(false);
    }
  };

  const handleBackupFilePick = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setRestoreParseError(null);
    setRestoreTarget(null);
    setEncryptedRestoreRaw(null);
    setDecryptPassphrase('');
    setRestorePassword('');
    if (!file) return;
    try {
      const text = await file.text();
      if (isEncryptedBackupEnvelope(text)) {
        setEncryptedRestoreRaw({ fileName: file.name, rawText: text });
        return;
      }
      const verified = await verifyBackupEnvelope(text);
      setRestoreTarget({
        fileName: file.name,
        envelope: verified.envelope,
        checksum: verified.checksum,
        checksumVerified: verified.checksumVerified,
      });
    } catch (err) {
      setRestoreParseError(
        err instanceof Error ? err.message : 'Invalid backup file.'
      );
    }
  };

  const handleDecryptRestoreFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!encryptedRestoreRaw) return;
    setRestoreParseError(null);
    setDecryptingBackup(true);
    try {
      const plainJson = await decryptBackupWithPassphrase(
        encryptedRestoreRaw.rawText,
        decryptPassphrase
      );
      const verified = await verifyBackupEnvelope(plainJson);
      setRestoreTarget({
        fileName: encryptedRestoreRaw.fileName,
        envelope: verified.envelope,
        checksum: verified.checksum,
        checksumVerified: verified.checksumVerified,
      });
      setEncryptedRestoreRaw(null);
      setDecryptPassphrase('');
    } catch (err) {
      setRestoreParseError(
        err instanceof Error ? err.message : 'Unable to decrypt backup file.'
      );
    } finally {
      setDecryptingBackup(false);
    }
  };

  const handleConfirmRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwner || !profile?.email || !restoreTarget) return;
    if (!restorePassword.trim()) {
      showToast('Enter your Owner password to confirm restore.', 'error');
      return;
    }

    setRestoring(true);
    try {
      // 1. Re-authenticate Owner before destructive replace
      const { error: authErr } = await supabase.auth.signInWithPassword({
        email: profile.email,
        password: restorePassword,
      });
      if (authErr) {
        throw new Error('Incorrect password. Owner re-authentication failed.');
      }

      // 2. Mandatory automatic pre-restore backup download
      const { data: preSnap, error: preErr } = await supabase.rpc(
        'export_workspace_backup',
        {
          p_backup_type: 'pre_restore',
          p_include_files: false,
          p_destination: 'local',
          p_drive_file_id: null,
        }
      );
      if (preErr) throw preErr;
      const { jsonText } = await buildSignedBackupBlob(
        preSnap as WorkspaceBackupEnvelope
      );
      downloadJsonFile(`bizone-pre-restore-${todayLocalIso()}.json`, jsonText);

      // 3. Atomic restore RPC
      const { data: resData, error: resErr } = await supabase.rpc(
        'restore_workspace_backup',
        {
          p_snapshot: restoreTarget.envelope,
          p_checksum: restoreTarget.checksum,
          p_destination: 'local',
          p_drive_file_id: null,
        }
      );
      if (resErr) throw resErr;

      // 4. Restore embedded attachment files if present
      let filesRestoredMsg = '';
      if (
        Array.isArray(restoreTarget.envelope.attachments) &&
        restoreTarget.envelope.attachments.length > 0 &&
        session?.access_token
      ) {
        const bundleRes = await fetch('/api/backup/restore-bundle', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            attachments: restoreTarget.envelope.attachments,
          }),
        });
        const bundleJson = await bundleRes.json();
        if (bundleRes.ok) {
          filesRestoredMsg = ` (${Number(bundleJson.restoredCount || 0)} attachment files restored)`;
        }
      }

      const counts = (resData as { counts?: Record<string, number> } | null)?.counts ?? null;
      setLastRestoredCounts(counts);
      setRestoreTarget(null);
      setRestorePassword('');
      syncedBizStampRef.current = null;
      await refreshWorkspace();
      await loadBackupInfo();
      showToast(
        language === 'hi'
          ? `बैकअप सफलतापूर्वक रीस्टोर हो गया। पहले का प्री-रीस्टोर बैकअप डाउनलोड कर लिया गया है।${filesRestoredMsg}`
          : `Workspace restored from backup${filesRestoredMsg}. A pre-restore safety backup was also downloaded.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Backup restore failed.',
        'error'
      );
    } finally {
      setRestoring(false);
    }
  };

  const handleGenerateDriveAuthUrl = async () => {
    if (!session?.access_token) return;
    try {
      const res = await fetch('/api/integrations/google-drive/auth-url', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok || !data?.url) {
        throw new Error(data?.error || 'Unable to generate Google authorization link.');
      }
      setDriveAuthUrl(String(data.url));
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Google Drive auth link failed.',
        'error'
      );
    }
  };

  const handleDriveBackupNow = async () => {
    if (!session?.access_token) return;
    setSyncingDrive(true);
    try {
      const res = await fetch('/api/integrations/google-drive/backup-now', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ includeFiles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Drive upload failed.');
      await loadDriveStatus();
      await loadBackupInfo();
      showToast(
        `Backed up to Google Drive (${String(data.fileName || 'snapshot')}).`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Google Drive backup failed.',
        'error'
      );
      void loadDriveStatus();
    } finally {
      setSyncingDrive(false);
    }
  };

  const handleListDriveBackups = async () => {
    if (!session?.access_token) return;
    setLoadingDrive(true);
    try {
      const res = await fetch('/api/integrations/google-drive/backups', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Unable to list Drive backups.');
      setDriveBackups(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to list Drive backups.',
        'error'
      );
    } finally {
      setLoadingDrive(false);
    }
  };

  const handleSaveDriveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token || !isOwner) return;
    setSavingDriveSchedule(true);
    try {
      const res = await fetch('/api/integrations/google-drive/schedule', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          scheduleEnabled: driveScheduleEnabled,
          scheduleFrequency: driveScheduleFreq,
          retentionCount: driveRetention,
          folderName: driveFolderName.trim() || 'BizOne ERP Backups',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to save schedule.');
      await loadDriveStatus();
      showToast('Google Drive backup schedule updated.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save schedule.',
        'error'
      );
    } finally {
      setSavingDriveSchedule(false);
    }
  };

  const handleRestoreFromDrive = async (fileId: string, fileName: string) => {
    if (!session?.access_token || !isOwner) return;
    setRestoringDriveId(fileId);
    try {
      // Download pre-restore local safety snapshot before overwriting
      const { data: preSnap, error: preErr } = await supabase.rpc(
        'export_workspace_backup',
        {
          p_backup_type: 'pre_restore',
          p_include_files: false,
          p_destination: 'local',
          p_drive_file_id: null,
        }
      );
      if (!preErr && preSnap) {
        const { jsonText } = await buildSignedBackupBlob(
          preSnap as WorkspaceBackupEnvelope
        );
        downloadJsonFile(`bizone-pre-restore-${todayLocalIso()}.json`, jsonText);
      }

      const res = await fetch('/api/integrations/google-drive/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ fileId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Drive restore failed.');

      syncedBizStampRef.current = null;
      await refreshWorkspace();
      await loadBackupInfo();
      showToast(
        `Restored workspace from Drive file "${fileName}" (${Number(data.filesRestored || 0)} files).`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to restore from Google Drive.',
        'error'
      );
    } finally {
      setRestoringDriveId(null);
    }
  };

  const handleDisconnectDrive = async () => {
    if (!session?.access_token || !isOwner) return;
    try {
      const res = await fetch('/api/integrations/google-drive/disconnect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Disconnect failed.');
      setDriveBackups([]);
      setDriveAuthUrl(null);
      await loadDriveStatus();
      showToast('Google Drive disconnected and OAuth tokens revoked.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to disconnect Google Drive.',
        'error'
      );
    }
  };

  const handleSwitchBusinessPack = async () => {
    if (!isOwner) return;
    setSwitchingPack(true);
    try {
      const { error } = await supabase.rpc('switch_business_pack', {
        p_pack: targetPack,
        p_enable_recommended_modules: enablePackModules,
        p_load_demo: loadDemoOnSwitch,
      });
      if (error) throw error;
      syncedBizStampRef.current = null;
      await refreshWorkspace();
      showToast(`Business pack switched to ${targetPack.replace('_', ' ')}.`, 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to switch business pack.',
        'error'
      );
    } finally {
      setSwitchingPack(false);
    }
  };

  const handleLoadDemoData = async () => {
    if (!isOwner) return;
    setDemoLoading(true);
    try {
      const { error } = await supabase.rpc('seed_pack_demo_data', {
        p_pack: targetPack,
      });
      if (error) throw error;
      await refreshWorkspace();
      showToast('Sample demo records loaded for the active pack.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to load demo data.',
        'error'
      );
    } finally {
      setDemoLoading(false);
    }
  };

  const handleRemoveDemoData = async () => {
    if (!isOwner) return;
    setDemoLoading(true);
    try {
      const { error } = await supabase.rpc('remove_demo_data');
      if (error) throw error;
      await refreshWorkspace();
      showToast('Sample demo records removed.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to remove demo data.',
        'error'
      );
    } finally {
      setDemoLoading(false);
    }
  };

  const handleResetWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwner || resetPhrase.trim() !== 'RESET WORKSPACE') return;
    setResettingWorkspace(true);
    try {
      const { error } = await supabase.rpc('reset_workspace_data', {
        p_confirm_phrase: resetPhrase.trim(),
      });
      if (error) throw error;
      setResetPhrase('');
      syncedBizStampRef.current = null;
      await refreshWorkspace();
      showToast('Workspace transactions and master records cleared.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Workspace reset failed.',
        'error'
      );
    } finally {
      setResettingWorkspace(false);
    }
  };

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
        p_default_print_layout: defaultPrintLayout,
        p_show_upi_qr_on_invoice: showUpiQrOnInvoice,
        p_quotation_prefix: quotationPrefix.trim() || 'QTN-',
        p_quotation_next_number: Math.max(1, Number(quotationNext) || 1),
        p_credit_note_prefix: creditNotePrefix.trim() || 'CN-',
        p_credit_note_next_number: Math.max(1, Number(creditNoteNext) || 1),
        p_cashier_max_discount_pct: Math.min(100, Math.max(0, Number(cashierMaxDiscountPct || 0))),
        p_allow_cashier_price_override: allowCashierPriceOverride,
        p_purchase_prefix: purchasePrefix.trim() || 'PUR-',
        p_purchase_next_number: Math.max(1, Number(purchaseNext) || 1),
        p_purchase_return_prefix: purchaseReturnPrefix.trim() || 'PR-',
        p_purchase_return_next_number: Math.max(1, Number(purchaseReturnNext) || 1),
        p_expense_prefix: expensePrefix.trim() || 'EXP-',
        p_expense_next_number: Math.max(1, Number(expenseNext) || 1),
        p_drug_licence_no: drugLicenceNo.trim() || null,
        p_pack_settings: {
          ...(business?.pack_settings || {}),
          bank_name: bankName.trim() || null,
          bank_account_holder: bankAccountHolder.trim() || null,
          bank_account_no: bankAccountNo.trim() || null,
          bank_ifsc: bankIfsc.trim().toUpperCase() || null,
          bank_branch: bankBranch.trim() || null,
          bank_account_type: bankAccountType.trim() || 'Current',
          show_bank_on_invoice: showBankOnInvoice,
          show_cashier_on_invoice: showCashierOnInvoice,
          default_cashier_name: defaultCashierName.trim() || null,
          show_signatory_on_invoice: showSignatoryOnInvoice,
          signatory_label: signatoryLabel.trim() || 'Authorized Signatory',
          show_hsn_on_invoice: showHsnOnInvoice,
          show_mrp_savings_on_invoice: showMrpSavingsOnInvoice,
          show_customer_details_on_invoice: showCustomerDetailsOnInvoice,
          invoice_greeting: invoiceGreeting.trim() || null,
        },
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

  const handleTestIntegration = async (key: string) => {
    if (!session?.access_token) return;
    setTestingIntKey(key);
    try {
      const res = await fetch(`/api/integrations/${encodeURIComponent(key)}/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || 'Connection check failed.');
      await loadIntegrations();
      showToast(data.message || 'Connection verified.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Connection test failed.', 'error');
    } finally {
      setTestingIntKey(null);
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

  const tabs: Array<{ key: SettingsTabKey; label: string; visible: boolean }> = [
    { key: 'business', label: t('settings.tabs.business'), visible: isOwner },
    { key: 'invoice', label: t('settings.tabs.invoice'), visible: isOwner },
    { key: 'modules', label: t('settings.tabs.modules'), visible: isOwner },
    { key: 'users', label: t('settings.tabs.users'), visible: isOwner },
    { key: 'appearance', label: t('settings.tabs.appearance'), visible: true },
    { key: 'data', label: t('settings.tabs.data'), visible: canAccessData },
    { key: 'backup', label: t('settings.tabs.backup'), visible: canAccessBackup },
    { key: 'integrations', label: t('settings.tabs.integrations'), visible: isOwner },
  ];

  const visibleTabs = tabs.filter((tab) => tab.visible);
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
        {/* Business Snapshot Summary Card */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
            <div>
              <h2 className="text-base font-semibold">
                {t('home.workspaceSummary')}
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {language === 'hi'
                  ? 'सक्रिय व्यापार पैक, जीएसटी मोड, स्टाफ, मॉड्यूल और बैकअप सारांश।'
                  : 'Overview of active business pack, tax mode, staff, enabled modules, and backup status.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('modules')}
                className="h-8 px-3 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
              >
                {t('settings.tabs.modules')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('users')}
                className="h-8 px-3 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
              >
                {t('settings.tabs.users')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('backup')}
                className="h-8 px-3 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
              >
                {t('settings.tabs.backup')}
              </button>
            </div>
          </div>

          <dl className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
            <div className="p-3 rounded-lg bg-[var(--surface-muted)]/60 border border-[var(--border)]">
              <dt className="text-xs text-[var(--text-muted)]">
                {t('home.activePack')}
              </dt>
              <dd className="mt-1 font-semibold truncate">
                {language === 'hi' ? currentPack?.labelHi : currentPack?.labelEn}
              </dd>
            </div>

            <div className="p-3 rounded-lg bg-[var(--surface-muted)]/60 border border-[var(--border)]">
              <dt className="text-xs text-[var(--text-muted)]">
                {t('home.taxMode')}
              </dt>
              <dd className="mt-1 font-semibold capitalize">
                {business?.gst_registered
                  ? `GST (${business.tax_mode})`
                  : 'Non-GST'}
              </dd>
            </div>

            <div className="p-3 rounded-lg bg-[var(--surface-muted)]/60 border border-[var(--border)]">
              <dt className="text-xs text-[var(--text-muted)]">
                {t('home.teamMembers')}
              </dt>
              <dd className="mt-1 font-semibold font-mono tabular-nums">
                {staff.filter((s) => s.is_active).length} active
              </dd>
            </div>

            <div className="p-3 rounded-lg bg-[var(--surface-muted)]/60 border border-[var(--border)]">
              <dt className="text-xs text-[var(--text-muted)]">
                {t('home.enabledModules')}
              </dt>
              <dd className="mt-1 font-semibold font-mono tabular-nums">
                {modules.filter((m) => m.enabled).length} / {modules.length}
              </dd>
            </div>

            <div className="p-3 rounded-lg bg-[var(--surface-muted)]/60 border border-[var(--border)] col-span-2 sm:col-span-1">
              <dt className="text-xs text-[var(--text-muted)]">
                {language === 'hi' ? 'अंतिम बैकअप' : 'Last Backup'}
              </dt>
              <dd
                className={`mt-1 text-xs font-semibold ${
                  lastBackupAt ? 'text-[var(--receive-text)]' : 'text-[var(--give)]'
                }`}
              >
                {lastBackupAt
                  ? formatDateTime(lastBackupAt)
                  : language === 'hi'
                    ? 'अभी तक नहीं'
                    : 'Never'}
              </dd>
            </div>
          </dl>
        </section>

        <form
          onSubmit={handleSaveBusiness}
          className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-5"
        >
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-[var(--border)]">
            <div>
              <h2 className="text-base font-semibold">
                {t('settings.tabs.business')}
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Pack: {language === 'hi' ? currentPack?.labelHi : currentPack?.labelEn}
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

          {/* Bank Account & Settlement Details alongside UPI */}
          <div className="pt-4 border-t border-[var(--border)] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">
                  {language === 'hi'
                    ? 'बैंक खाता और भुगतान विवरण (UPI के साथ)'
                    : 'Bank Account & Payment Details (with UPI)'}
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                  {language === 'hi'
                    ? 'चालान, कोटेशन और पार्टी स्टेटमेंट पर NEFT/RTGS/IMPS भुगतान के लिए बैंक विवरण जोड़ें।'
                    : 'Add your business bank account details for NEFT/RTGS/IMPS payments alongside UPI on invoices and statements.'}
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs sm:text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={showBankOnInvoice}
                  onChange={(e) => setShowBankOnInvoice(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>
                  {language === 'hi'
                    ? 'बिल पर बैंक विवरण दिखाएं'
                    : 'Print Bank Details on Invoices'}
                </span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label htmlFor="biz-bank-name" className="block text-sm font-medium mb-1.5">
                  Bank Name
                </label>
                <input
                  id="biz-bank-name"
                  type="text"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="e.g. State Bank of India"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <div>
                <label htmlFor="biz-bank-holder" className="block text-sm font-medium mb-1.5">
                  Account Holder Name
                </label>
                <input
                  id="biz-bank-holder"
                  type="text"
                  value={bankAccountHolder}
                  onChange={(e) => setBankAccountHolder(e.target.value)}
                  placeholder={bizName || 'Account Holder Name'}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <div>
                <label htmlFor="biz-bank-ac" className="block text-sm font-medium mb-1.5">
                  Bank Account No. (A/c No.)
                </label>
                <input
                  id="biz-bank-ac"
                  type="text"
                  value={bankAccountNo}
                  onChange={(e) => setBankAccountNo(e.target.value)}
                  placeholder="e.g. 309812345678"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <div>
                <label htmlFor="biz-bank-ifsc" className="block text-sm font-medium mb-1.5">
                  IFSC Code
                </label>
                <input
                  id="biz-bank-ifsc"
                  type="text"
                  maxLength={11}
                  value={bankIfsc}
                  onChange={(e) => setBankIfsc(e.target.value.toUpperCase())}
                  placeholder="e.g. SBIN0001234"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <div>
                <label htmlFor="biz-bank-branch" className="block text-sm font-medium mb-1.5">
                  Branch Name
                </label>
                <input
                  id="biz-bank-branch"
                  type="text"
                  value={bankBranch}
                  onChange={(e) => setBankBranch(e.target.value)}
                  placeholder="e.g. Fraser Road, Patna"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <div>
                <label htmlFor="biz-bank-type" className="block text-sm font-medium mb-1.5">
                  Account Type
                </label>
                <select
                  id="biz-bank-type"
                  value={bankAccountType}
                  onChange={(e) => setBankAccountType(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                >
                  <option value="Current">Current Account</option>
                  <option value="Savings">Savings Account</option>
                  <option value="OD / CC">OD / CC Account</option>
                </select>
              </div>
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="biz-dl-no" className="block text-sm font-medium mb-1.5">
                Drug Licence No. (Medical / Pharmacy)
              </label>
              <input
                id="biz-dl-no"
                type="text"
                value={drugLicenceNo}
                onChange={(e) => setDrugLicenceNo(e.target.value)}
                placeholder="e.g. DL-MH-20B/21B-10482"
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

        {/* S10 Business Pack Switcher, Demo Data & Workspace Reset */}
        <div className="mt-6 space-y-6">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] pb-3">
              <div>
                <h2 className="text-base font-semibold inline-flex items-center gap-2">
                  <IconBriefcase size={18} stroke={2} className="text-[var(--primary-dark)]" />
                  <span>Business Pack & Sample Demo Data</span>
                </h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Switch business-type workflows (Kirana, Medical, Clothing, Hardware, Retail, Wholesale, Service) or load/remove sample demo data.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div className="md:col-span-2">
                <label htmlFor="pack-switcher" className="block text-sm font-medium mb-1.5">
                  Target Business Pack
                </label>
                <select
                  id="pack-switcher"
                  value={targetPack}
                  onChange={(e) => setTargetPack(e.target.value as BusinessPackKey)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                >
                  {BUSINESS_PACKS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {language === 'hi' ? p.labelHi : p.labelEn} — {language === 'hi' ? p.descriptionHi : p.descriptionEn}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={switchingPack}
                onClick={() => void handleSwitchBusinessPack()}
                className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold whitespace-nowrap shrink-0 hover:opacity-95 disabled:opacity-50"
              >
                {switchingPack ? 'Switching...' : 'Switch Business Pack'}
              </button>
            </div>

            <div className="flex flex-wrap gap-5 text-xs sm:text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enablePackModules}
                  onChange={(e) => setEnablePackModules(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Enable recommended modules for selected pack</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={loadDemoOnSwitch}
                  onChange={(e) => setLoadDemoOnSwitch(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Also load sample demo data after switching</span>
              </label>
            </div>

            <div className="pt-3 border-t border-[var(--border)] flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={demoLoading}
                onClick={() => void handleLoadDemoData()}
                className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-semibold hover:bg-[var(--surface-muted)] disabled:opacity-50"
              >
                {demoLoading ? 'Working...' : 'Load Demo Data for Pack'}
              </button>
              <button
                type="button"
                disabled={demoLoading}
                onClick={() => void handleRemoveDemoData()}
                className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--give)] hover:bg-[var(--give-soft)] disabled:opacity-50"
              >
                Remove Demo Data
              </button>
            </div>
          </section>

          {/* Danger Zone: Reset Workspace */}
          <section className="rounded-xl border border-[var(--give)]/35 bg-[var(--surface)] p-5 sm:p-6 space-y-4">
            <div className="flex items-start gap-2.5">
              <IconAlertTriangle size={20} stroke={2} className="text-[var(--give)] shrink-0 mt-0.5" />
              <div>
                <h2 className="text-base font-semibold text-[var(--give)]">
                  Reset Workspace Data (Owner Only)
                </h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Deletes all bills, purchases, expenses, payments, parties, items, batches, variants, and job cards while preserving business settings and staff accounts. Recommended: download a backup first.
                </p>
              </div>
            </div>

            <form onSubmit={handleResetWorkspace} className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
              <div className="flex-1">
                <label htmlFor="reset-confirm-phrase" className="block text-xs font-medium mb-1">
                  Type <span className="font-mono font-semibold text-[var(--give)]">RESET WORKSPACE</span> to confirm
                </label>
                <input
                  id="reset-confirm-phrase"
                  type="text"
                  value={resetPhrase}
                  onChange={(e) => setResetPhrase(e.target.value)}
                  placeholder="RESET WORKSPACE"
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--give)]"
                />
              </div>
              <button
                type="submit"
                disabled={resettingWorkspace || resetPhrase.trim() !== 'RESET WORKSPACE'}
                className="h-10 px-5 rounded-lg bg-[var(--give)] text-white text-xs font-semibold whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                {resettingWorkspace ? 'Resetting...' : 'Reset Workspace'}
              </button>
            </form>
          </section>
        </div>
        </RequireRole>
      )}

      {/* S3 Invoice Basics */}
      {activeTab === 'invoice' && (
        <RequireRole roles={['owner']}>
        <form
          onSubmit={handleSaveBusiness}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-6"
        >
          <div className="border-b border-[var(--border)] pb-3">
            <h2 className="text-base font-semibold">
              {t('settings.tabs.invoice')}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {language === 'hi'
                ? 'इनवॉइस, कोटेशन, क्रेडिट नोट नंबरिंग, प्रिंट लेआउट, यूपीआई क्यूआर और कैशियर छूट नियम सेट करें।'
                : 'Configure FY numbering series, default print layout, UPI QR display, and cashier discount/rate limits.'}
            </p>
          </div>

          {/* Series Prefixes & Next Numbers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                Invoice Next No.
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

            <div>
              <label htmlFor="qtn-prefix" className="block text-sm font-medium mb-1.5">
                Quotation Prefix
              </label>
              <input
                id="qtn-prefix"
                type="text"
                required
                value={quotationPrefix}
                onChange={(e) => setQuotationPrefix(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="qtn-next" className="block text-sm font-medium mb-1.5">
                Quotation Next No.
              </label>
              <input
                id="qtn-next"
                type="number"
                min={1}
                value={quotationNext}
                onChange={(e) => setQuotationNext(Number(e.target.value))}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="inv-print-layout" className="block text-sm font-medium mb-1.5">
                Default Print Layout
              </label>
              <select
                id="inv-print-layout"
                value={defaultPrintLayout}
                onChange={(e) =>
                  setDefaultPrintLayout(e.target.value as 'a4' | 'a5' | 'thermal_80')
                }
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              >
                <option value="a4">A4 Standard Tax Invoice</option>
                <option value="a5">A5 Half-Page Compact</option>
                <option value="thermal_80">80mm Thermal POS Receipt</option>
              </select>
            </div>

            <div>
              <label htmlFor="cn-prefix" className="block text-sm font-medium mb-1.5">
                Credit Note Prefix
              </label>
              <input
                id="cn-prefix"
                type="text"
                required
                value={creditNotePrefix}
                onChange={(e) => setCreditNotePrefix(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="cn-next" className="block text-sm font-medium mb-1.5">
                Credit Note Next No.
              </label>
              <input
                id="cn-next"
                type="number"
                min={1}
                value={creditNoteNext}
                onChange={(e) => setCreditNoteNext(Number(e.target.value))}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="inv-upi-id" className="block text-sm font-medium mb-1.5">
                UPI ID (for Dynamic QR & Links)
              </label>
              <input
                id="inv-upi-id"
                type="text"
                value={upiId}
                onChange={(e) => setUpiId(e.target.value)}
                placeholder="shopname@upi"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>

            <div>
              <label htmlFor="pur-prefix" className="block text-sm font-medium mb-1.5">
                Purchase Bill Prefix
              </label>
              <input
                id="pur-prefix"
                type="text"
                required
                value={purchasePrefix}
                onChange={(e) => setPurchasePrefix(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="pur-next" className="block text-sm font-medium mb-1.5">
                Purchase Next No.
              </label>
              <input
                id="pur-next"
                type="number"
                min={1}
                value={purchaseNext}
                onChange={(e) => setPurchaseNext(Number(e.target.value))}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="pr-prefix" className="block text-sm font-medium mb-1.5">
                Purchase Return Prefix
              </label>
              <input
                id="pr-prefix"
                type="text"
                required
                value={purchaseReturnPrefix}
                onChange={(e) => setPurchaseReturnPrefix(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="pr-next" className="block text-sm font-medium mb-1.5">
                Purchase Return Next No.
              </label>
              <input
                id="pr-next"
                type="number"
                min={1}
                value={purchaseReturnNext}
                onChange={(e) => setPurchaseReturnNext(Number(e.target.value))}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="exp-prefix" className="block text-sm font-medium mb-1.5">
                Expense Prefix
              </label>
              <input
                id="exp-prefix"
                type="text"
                required
                value={expensePrefix}
                onChange={(e) => setExpensePrefix(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label htmlFor="exp-next" className="block text-sm font-medium mb-1.5">
                Expense Next No.
              </label>
              <input
                id="exp-next"
                type="number"
                min={1}
                value={expenseNext}
                onChange={(e) => setExpenseNext(Number(e.target.value))}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
          </div>

          {/* UPI QR & Bank Details on Invoices */}
          <div className="pt-4 border-t border-[var(--border)] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">
                  {language === 'hi'
                    ? 'इनवॉइस पर UPI QR और बैंक विवरण'
                    : 'UPI QR & Bank Details on Invoices'}
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                  {language === 'hi'
                    ? 'प्रिंट और शेयर किए गए चालानों पर UPI QR कोड और बैंक खाता विवरण दिखाएं।'
                    : 'Control whether UPI QR codes and business bank account details appear on printed and shared invoices.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showUpiQrOnInvoice}
                    onChange={(e) => setShowUpiQrOnInvoice(e.target.checked)}
                    className="w-4 h-4 accent-[var(--primary-dark)]"
                  />
                  <span>Show UPI QR on Invoices</span>
                </label>
                <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showBankOnInvoice}
                    onChange={(e) => setShowBankOnInvoice(e.target.checked)}
                    className="w-4 h-4 accent-[var(--primary-dark)]"
                  />
                  <span>Print Bank Details on Invoices</span>
                </label>
              </div>
            </div>

            <ImageUpload
              label="Uploaded UPI QR Image (Optional)"
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
              helperText="If no static image is uploaded, BizOne renders a scannable dynamic UPI QR from your UPI ID above."
            />
          </div>

          {/* Invoice Content, Cashier Name, Signatory & Print Options */}
          <div className="pt-4 border-t border-[var(--border)] space-y-4">
            <div>
              <h3 className="text-sm font-semibold">
                {language === 'hi'
                  ? 'कैशियर नाम, हस्ताक्षर और इनवॉइस प्रिंट विकल्प'
                  : 'Cashier Name, Signatory & Invoice Print Options'}
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                {language === 'hi'
                  ? 'बिल पर कैशियर/बिलकर्ता का नाम, अधिकृत हस्ताक्षरकर्ता, HSN कॉलम, MRP बचत और ग्राहक विवरण नियंत्रित करें।'
                  : 'Configure Cashier / Billed By name, Authorized Signatory block, HSN/SAC column, MRP savings badge, and footer greeting on invoices.'}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/40 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCashierOnInvoice}
                  onChange={(e) => setShowCashierOnInvoice(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Show Cashier / Billed By Name</span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/40 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={showSignatoryOnInvoice}
                  onChange={(e) => setShowSignatoryOnInvoice(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Show Authorized Signatory</span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/40 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={showHsnOnInvoice}
                  onChange={(e) => setShowHsnOnInvoice(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Show HSN / SAC Code Column</span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/40 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={showMrpSavingsOnInvoice}
                  onChange={(e) => setShowMrpSavingsOnInvoice(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Show MRP & Total Savings</span>
              </label>

              <label className="flex items-center gap-2.5 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/40 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCustomerDetailsOnInvoice}
                  onChange={(e) => setShowCustomerDetailsOnInvoice(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Show Customer Phone & Address</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
              <div>
                <label htmlFor="inv-cashier-name" className="block text-sm font-medium mb-1.5">
                  Cashier / Billed By Name (Optional)
                </label>
                <input
                  id="inv-cashier-name"
                  type="text"
                  value={defaultCashierName}
                  onChange={(e) => setDefaultCashierName(e.target.value)}
                  placeholder={profile?.full_name || 'Auto (Logged-in Staff Name)'}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
                <p className="text-[11px] text-[var(--text-muted)] mt-1">
                  Leave blank to automatically print the billing staff member&apos;s name.
                </p>
              </div>

              <div>
                <label htmlFor="inv-signatory" className="block text-sm font-medium mb-1.5">
                  Authorized Signatory Label
                </label>
                <input
                  id="inv-signatory"
                  type="text"
                  value={signatoryLabel}
                  onChange={(e) => setSignatoryLabel(e.target.value)}
                  placeholder="Authorized Signatory"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <div>
                <label htmlFor="inv-greeting" className="block text-sm font-medium mb-1.5">
                  Invoice Footer Greeting
                </label>
                <input
                  id="inv-greeting"
                  type="text"
                  value={invoiceGreeting}
                  onChange={(e) => setInvoiceGreeting(e.target.value)}
                  placeholder="Thank you! Visit Again"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>
            </div>
          </div>

          {/* Counter Override Controls */}
          <div className="pt-4 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div>
              <label htmlFor="cashier-max-disc" className="block text-sm font-medium mb-1.5">
                Cashier / Accountant Max Line Discount (%)
              </label>
              <input
                id="cashier-max-disc"
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="0.01"
                value={cashierMaxDiscountPct}
                onChange={(e) => setCashierMaxDiscountPct(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <label className="flex items-center gap-2.5 min-h-[44px] cursor-pointer pt-5">
              <input
                type="checkbox"
                checked={allowCashierPriceOverride}
                onChange={(e) => setAllowCashierPriceOverride(e.target.checked)}
                className="w-4 h-4 accent-[var(--primary-dark)]"
              />
              <span className="text-sm font-medium">
                Allow Cashiers to lower item price below catalog rate
              </span>
            </label>
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

          {/* Recent Activity (Audit Log) */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <IconHistory
                  size={18}
                  stroke={2}
                  className="text-[var(--primary-dark)]"
                />
                <h3 className="text-base font-semibold">
                  {language === 'hi' ? 'हाल की गतिविधि (ऑडिट लॉग)' : 'Recent Activity (Audit Log)'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => void loadSnapshotAndActivity()}
                className="h-8 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
              >
                <IconRefresh size={14} stroke={2} />
                <span>{language === 'hi' ? 'रिफ्रेश' : 'Refresh'}</span>
              </button>
            </div>

            {recentAuditLogs.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)] py-3">
                {language === 'hi'
                  ? 'अभी तक कोई गतिविधि दर्ज नहीं हुई।'
                  : 'No audit events recorded yet.'}
              </p>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {recentAuditLogs.map((log) => (
                  <div
                    key={log.id}
                    className="py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-mono font-semibold text-[var(--primary-dark)]">
                        {log.action}
                      </span>{' '}
                      <span className="text-[var(--text-muted)]">
                        ({log.entity_type})
                      </span>
                      {log.actor_email && (
                        <span className="text-[var(--text-muted)]">
                          {' '}
                          • {log.actor_email}
                        </span>
                      )}
                    </div>
                    <span className="text-[var(--text-muted)] shrink-0 font-mono tabular-nums">
                      {formatDateTime(log.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
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

      {/* S8 Data Import & Export */}
      {activeTab === 'data' && (
        <RequireRole roles={['owner', 'manager', 'storekeeper', 'accountant']}>
          <ImportExportPanel onImported={() => void refreshWorkspace()} />
        </RequireRole>
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
                    <div className="p-3 rounded-lg bg-[var(--surface-muted)] text-xs text-[var(--text-muted)] space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[var(--text)]">
                          Authorized Redirect URI
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(
                              `${window.location.origin}/api/integrations/google-drive/callback`
                            );
                            showToast('Redirect URI copied.', 'success');
                          }}
                          className="inline-flex items-center gap-1 text-[var(--primary-dark)] font-medium hover:underline"
                        >
                          <IconCopy size={13} stroke={2} />
                          <span>Copy</span>
                        </button>
                      </div>
                      <code className="block font-mono text-[var(--text)] break-all">
                        {window.location.origin}/api/integrations/google-drive/callback
                      </code>
                      <p>
                        Enter your Google Cloud OAuth 2.0 Web Client ID and Client Secret below. Secrets are encrypted with APP_ENCRYPTION_KEY on the server.
                      </p>
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

                      {item.integration_key === 'google_drive' && (
                        <div>
                          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                            Google OAuth Client ID
                          </label>
                          <input
                            type="text"
                            value={intConfigJson.clientId || ''}
                            onChange={(e) =>
                              setIntConfigJson((p) => ({
                                ...p,
                                clientId: e.target.value,
                              }))
                            }
                            placeholder="1234567890-xxxx.apps.googleusercontent.com"
                            className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                          />
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                          {item.integration_key === 'google_drive'
                            ? 'Google OAuth Client Secret (leave blank to keep existing)'
                            : 'API Key / Client Secret (leave blank to keep existing)'}
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
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <div>
                            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                              Provider
                            </label>
                            <select
                              value={intConfigJson.provider || 'gemini'}
                              onChange={(e) =>
                                setIntConfigJson((p) => ({
                                  ...p,
                                  provider: e.target.value,
                                }))
                              }
                              className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                            >
                              <option value="gemini">Google Gemini</option>
                              <option value="openai">OpenAI</option>
                              <option value="anthropic">Anthropic Claude</option>
                              <option value="openrouter">OpenRouter</option>
                              <option value="grok">xAI Grok</option>
                              <option value="custom">Custom HTTPS OpenAI-compatible</option>
                            </select>
                          </div>
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
                          <div className="sm:col-span-2">
                            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                              Custom Endpoint Base URL (HTTPS optional)
                            </label>
                            <input
                              type="url"
                              value={intConfigJson.base_url || ''}
                              onChange={(e) =>
                                setIntConfigJson((p) => ({
                                  ...p,
                                  base_url: e.target.value,
                                }))
                              }
                              placeholder="https://api.example.com/v1"
                              className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                            />
                          </div>
                        </div>
                      )}

                      {item.integration_key === 'smtp_email' && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <input
                            type="text"
                            value={intConfigJson.host || ''}
                            onChange={(e) => setIntConfigJson((p) => ({ ...p, host: e.target.value }))}
                            placeholder="SMTP Host (smtp.example.com)"
                            className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                          />
                          <input
                            type="text"
                            value={intConfigJson.port || '587'}
                            onChange={(e) => setIntConfigJson((p) => ({ ...p, port: e.target.value }))}
                            placeholder="Port (587)"
                            className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                          />
                          <input
                            type="email"
                            value={intConfigJson.sender_email || ''}
                            onChange={(e) => setIntConfigJson((p) => ({ ...p, sender_email: e.target.value }))}
                            placeholder="Sender Email"
                            className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                          />
                          <input
                            type="url"
                            value={intConfigJson.base_url || ''}
                            onChange={(e) => setIntConfigJson((p) => ({ ...p, base_url: e.target.value }))}
                            placeholder="HTTPS Email Relay URL (optional)"
                            className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                          />
                        </div>
                      )}

                      {(item.integration_key === 'whatsapp_sms' || item.integration_key === 'einvoice_gsp') && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <input
                            type="text"
                            value={intConfigJson.provider || ''}
                            onChange={(e) => setIntConfigJson((p) => ({ ...p, provider: e.target.value }))}
                            placeholder={item.integration_key === 'einvoice_gsp' ? 'GSP Provider (ClearTax/MasterGST)' : 'Provider (Meta Cloud / Gupshup / MSG91)'}
                            className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                          />
                          <input
                            type="url"
                            value={intConfigJson.base_url || ''}
                            onChange={(e) => setIntConfigJson((p) => ({ ...p, base_url: e.target.value }))}
                            placeholder="HTTPS Gateway URL"
                            className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
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
                    <div className="flex flex-wrap items-center gap-2">
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
                        <>
                          <button
                            type="button"
                            disabled={testingIntKey === item.integration_key}
                            onClick={() => void handleTestIntegration(item.integration_key)}
                            className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
                          >
                            <IconPlayerPlay size={14} stroke={2} />
                            <span>
                              {testingIntKey === item.integration_key ? 'Testing...' : 'Test'}
                            </span>
                          </button>
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
                        </>
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

      {/* Backup & Storage */}
      {activeTab === 'backup' && (
        <RequireRole roles={['owner', 'manager', 'accountant']}>
          <div className="space-y-6">
            {!isModuleEnabled('backup') && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
                Local Backup & Restore module is currently disabled under Settings → Modules & Features. Enable it to export or restore snapshots.
              </div>
            )}

            {/* Export & Last Backup Banner */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold inline-flex items-center gap-2">
                    <IconShieldCheck size={18} stroke={2} className="text-[var(--primary-dark)]" />
                    <span>
                      {language === 'hi'
                        ? 'लोकल JSON बैकअप डाउनलोड करें'
                        : 'Download Local JSON Backup'}
                    </span>
                  </h2>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    {business?.last_backup_at
                      ? `Last backup: ${formatDateTime(business.last_backup_at)}`
                      : 'No local backup has been downloaded yet.'}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void loadBackupInfo();
                      void loadDriveStatus();
                    }}
                    disabled={loadingBackup}
                    className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
                  >
                    <IconRefresh size={15} stroke={2} />
                    <span>Refresh</span>
                  </button>
                  <button
                    type="button"
                    disabled={exportingBackup || !isModuleEnabled('backup')}
                    onClick={() => void handleDownloadBackup()}
                    className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 hover:opacity-95 disabled:opacity-50"
                  >
                    <IconDownload size={18} stroke={2} />
                    <span>
                      {exportingBackup
                        ? 'Preparing...'
                        : language === 'hi'
                          ? 'बैकअप डाउनलोड करें'
                          : 'Download Backup (.json)'}
                    </span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-[var(--border)] items-end">
                <label className="flex items-center gap-2.5 min-h-[40px] cursor-pointer text-xs sm:text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={includeFiles}
                    onChange={(e) => setIncludeFiles(e.target.checked)}
                    className="w-4 h-4 accent-[var(--primary-dark)]"
                  />
                  <span>Include uploaded attachment files (receipts, scans, prescriptions)</span>
                </label>

                <div>
                  <label htmlFor="backup-enc-pass" className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    Optional Passphrase Encryption (AES-256-GCM, min 4 chars)
                  </label>
                  <input
                    id="backup-enc-pass"
                    type="password"
                    value={exportPassphrase}
                    onChange={(e) => setExportPassphrase(e.target.value)}
                    placeholder="Leave blank for standard JSON backup"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
              </div>

              <p className="text-xs text-[var(--text-muted)]">
                Includes business configuration, pack extensions (batches, variants, rate cards, sites, job cards), accounting vouchers, GST reconciliation data, locations, numbering series, parties, items, stock ledger, sales bills, purchases, expenses, payments, and file metadata signed with SHA-256.
              </p>
            </section>

            {/* Google Drive Cloud Backup & Sync (Optional) */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-[var(--border)] pb-3">
                <div>
                  <h2 className="text-base font-semibold inline-flex items-center gap-2">
                    <IconCloud size={18} stroke={2} className="text-[var(--primary-dark)]" />
                    <span>Google Drive Cloud Backup & Sync (Optional)</span>
                  </h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    {driveStatus?.connected
                      ? `Connected as ${driveStatus.connectedEmail || 'Google account'} · Folder "${driveStatus.folderName}"`
                      : 'Optional cloud backup to your own Google Drive folder. Local backup above always works without credentials.'}
                  </p>
                </div>
                {driveStatus?.lastSyncAt && (
                  <span className="text-xs text-[var(--text-muted)] tabular-nums">
                    Last sync: {formatDateTime(driveStatus.lastSyncAt)} ({driveStatus.lastSyncStatus})
                  </span>
                )}
              </div>

              {loadingDrive && !driveStatus ? (
                <p className="text-xs text-[var(--text-muted)]">Checking Google Drive status...</p>
              ) : !driveStatus?.oauthConfigured ? (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg bg-[var(--surface-muted)] p-4 text-xs">
                  <p className="text-[var(--text-muted)]">
                    Google Drive OAuth credentials are not enabled yet. Owner can enter Client ID & Secret in{' '}
                    <span className="font-semibold text-[var(--text)]">Settings → Integrations → Google Drive</span>.
                  </p>
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('integrations')}
                      className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-medium whitespace-nowrap shrink-0 hover:bg-[var(--surface-muted)]"
                    >
                      Open Integrations
                    </button>
                  )}
                </div>
              ) : !driveStatus.connected ? (
                <div className="flex flex-wrap items-center gap-3">
                  {isOwner ? (
                    <>
                      {!driveAuthUrl ? (
                        <button
                          type="button"
                          onClick={() => void handleGenerateDriveAuthUrl()}
                          className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
                        >
                          <IconCloud size={16} stroke={2} />
                          <span>Connect Google Drive</span>
                        </button>
                      ) : (
                        <a
                          href={driveAuthUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
                        >
                          <IconExternalLink size={15} stroke={2} />
                          <span>Continue to Google Authorization</span>
                        </a>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-[var(--text-muted)]">
                      Ask the Business Owner to authorize Google Drive first.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {driveStatus.lastError && (
                    <p className="text-xs text-[var(--give)] font-medium">
                      Last sync warning: {driveStatus.lastError}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={syncingDrive}
                      onClick={() => void handleDriveBackupNow()}
                      className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <IconCloudUpload size={16} stroke={2} />
                      <span>{syncingDrive ? 'Uploading to Drive...' : 'Backup to Drive Now'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={loadingDrive}
                      onClick={() => void handleListDriveBackups()}
                      className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
                    >
                      <IconRefresh size={15} stroke={2} />
                      <span>Load Drive Backups</span>
                    </button>
                    {isOwner && (
                      <button
                        type="button"
                        onClick={() => void handleDisconnectDrive()}
                        className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--give)] hover:bg-[var(--give-soft)]"
                      >
                        Disconnect Drive
                      </button>
                    )}
                  </div>

                  {isOwner && (
                    <form
                      onSubmit={handleSaveDriveSchedule}
                      className="pt-3 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
                    >
                      <label className="flex items-center gap-2 h-10 text-xs font-medium cursor-pointer">
                        <input
                          type="checkbox"
                          checked={driveScheduleEnabled}
                          onChange={(e) => setDriveScheduleEnabled(e.target.checked)}
                          className="w-4 h-4 accent-[var(--primary-dark)]"
                        />
                        <span>Scheduled backup metadata</span>
                      </label>
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          Frequency
                        </label>
                        <select
                          value={driveScheduleFreq}
                          onChange={(e) =>
                            setDriveScheduleFreq(e.target.value === 'weekly' ? 'weekly' : 'daily')
                          }
                          className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                        >
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          Keep Latest (3–50)
                        </label>
                        <input
                          type="number"
                          min={3}
                          max={50}
                          value={driveRetention}
                          onChange={(e) => setDriveRetention(Number(e.target.value || 10))}
                          className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={savingDriveSchedule}
                        className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-semibold hover:bg-[var(--surface-muted)]"
                      >
                        {savingDriveSchedule ? 'Saving...' : 'Save Schedule'}
                      </button>
                    </form>
                  )}

                  {driveBackups.length > 0 && (
                    <div className="pt-2 border-t border-[var(--border)] divide-y divide-[var(--border)]">
                      {driveBackups.map((df) => (
                        <div
                          key={df.id}
                          className="py-2.5 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-mono font-medium truncate">{df.name}</div>
                            <div className="text-[var(--text-muted)] tabular-nums">
                              {df.size ? `${(Number(df.size) / 1024).toFixed(1)} KB` : 'JSON'}
                              {df.createdTime ? ` · ${formatDateTime(df.createdTime)}` : ''}
                            </div>
                          </div>
                          {isOwner && (
                            <button
                              type="button"
                              disabled={restoringDriveId === df.id}
                              onClick={() => void handleRestoreFromDrive(df.id, df.name)}
                              className="h-9 px-3 rounded-lg border border-[var(--give)]/40 text-[var(--give)] font-semibold whitespace-nowrap shrink-0 hover:bg-[var(--give-soft)] disabled:opacity-50"
                            >
                              {restoringDriveId === df.id ? 'Restoring...' : 'Restore'}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Storage Usage Summary */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold inline-flex items-center gap-2">
                  <IconDatabase size={18} stroke={2} className="text-[var(--primary-dark)]" />
                  <span>
                    {language === 'hi' ? 'स्टोरेज और रिकॉर्ड उपयोग' : 'Storage & Record Usage'}
                  </span>
                </h2>
                {storageSummary && (
                  <span className="text-xs font-mono tabular-nums text-[var(--text-muted)]">
                    {(storageSummary.total_bytes / (1024 * 1024)).toFixed(2)} MB /{' '}
                    {(storageSummary.quota_bytes / (1024 * 1024)).toFixed(0)} MB (
                    {storageSummary.usage_pct}%) · {storageSummary.file_count} files
                  </span>
                )}
              </div>

              {storageSummary ? (
                <>
                  <div className="h-2.5 w-full rounded-full bg-[var(--surface-muted)] overflow-hidden">
                    <svg
                      className="w-full h-full block"
                      preserveAspectRatio="none"
                      viewBox="0 0 100 10"
                      aria-hidden="true"
                    >
                      <rect
                        x="0"
                        y="0"
                        height="10"
                        width={Math.min(100, Math.max(0, Number(storageSummary.usage_pct || 0)))}
                        className="fill-[var(--primary)]"
                      />
                    </svg>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-1">
                    {Object.entries(storageSummary.table_counts || {}).map(([tbl, cnt]) => (
                      <div
                        key={tbl}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3"
                      >
                        <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                          {tbl}
                        </div>
                        <div className="text-lg font-semibold tabular-nums mt-0.5">
                          {cnt}
                        </div>
                      </div>
                    ))}
                  </div>

                  {storageSummary.by_purpose?.length > 0 && (
                    <div className="pt-2 border-t border-[var(--border)] flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
                      {storageSummary.by_purpose.map((p) => (
                        <span
                          key={p.purpose}
                          className="px-2.5 py-1 rounded-md bg-[var(--surface-muted)] border border-[var(--border)] font-mono"
                        >
                          {p.purpose}: {p.file_count} ({(p.total_bytes / 1024).toFixed(1)} KB)
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">
                  {loadingBackup ? 'Loading storage metrics...' : 'Storage usage unavailable.'}
                </p>
              )}
            </section>

            {/* Owner-only Restore Workspace from Backup */}
            {isOwner && (
              <section className="rounded-xl border border-[var(--give)]/35 bg-[var(--surface)] p-5 sm:p-6 space-y-4">
                <div className="flex items-start gap-3">
                  <IconAlertTriangle size={20} stroke={2} className="text-[var(--give)] shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-base font-semibold text-[var(--give)]">
                      {language === 'hi'
                        ? 'बैकअप से रीस्टोर करें (केवल ओनर)'
                        : 'Restore Workspace from Backup (Owner Only)'}
                    </h2>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                      Restoring replaces current business ledgers, items, parties, bills, purchases, and expenses with the selected snapshot. Before replacing data, BizOne automatically downloads a fresh pre-restore safety backup.
                    </p>
                  </div>
                </div>

                {lastRestoredCounts && (
                  <div className="rounded-lg border border-[var(--receive)]/40 bg-[var(--receive-soft)] p-3 text-xs text-[var(--receive-text)]">
                    Last restore completed:{' '}
                    {Object.entries(lastRestoredCounts)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <label className="h-10 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold inline-flex items-center gap-2 cursor-pointer hover:bg-[var(--surface)]">
                    <IconUpload size={16} stroke={2} />
                    <span>Select Backup JSON (.json)</span>
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={handleBackupFilePick}
                      disabled={!isModuleEnabled('backup') || restoring}
                      className="sr-only"
                    />
                  </label>
                </div>

                {restoreParseError && (
                  <p className="text-xs font-medium text-[var(--give)]">
                    {restoreParseError}
                  </p>
                )}

                {encryptedRestoreRaw && (
                  <form
                    onSubmit={handleDecryptRestoreFile}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 p-4 space-y-3"
                  >
                    <div className="text-sm font-semibold">
                      Encrypted Backup Detected: {encryptedRestoreRaw.fileName}
                    </div>
                    <p className="text-xs text-[var(--text-muted)]">
                      Enter the AES-256-GCM passphrase used when exporting this file to decrypt and verify its SHA-256 checksum.
                    </p>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <input
                        type="password"
                        required
                        value={decryptPassphrase}
                        onChange={(e) => setDecryptPassphrase(e.target.value)}
                        placeholder="Enter backup passphrase"
                        className="flex-1 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                      />
                      <button
                        type="submit"
                        disabled={decryptingBackup}
                        className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold whitespace-nowrap shrink-0"
                      >
                        {decryptingBackup ? 'Decrypting...' : 'Decrypt Backup'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEncryptedRestoreRaw(null);
                          setDecryptPassphrase('');
                        }}
                        className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {restoreTarget && (
                  <form
                    onSubmit={handleConfirmRestore}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 p-4 space-y-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{restoreTarget.fileName}</p>
                        <p className="text-xs text-[var(--text-muted)]">
                          Exported: {formatDateTime(restoreTarget.envelope.exported_at)}
                          {restoreTarget.envelope.exported_by
                            ? ` by ${restoreTarget.envelope.exported_by}`
                            : ''}
                        </p>
                      </div>
                      <span
                        className={`text-xs font-mono px-2.5 py-1 rounded-md border ${
                          restoreTarget.checksumVerified
                            ? 'border-[var(--receive)] text-[var(--receive-text)] bg-[var(--receive-soft)]'
                            : 'border-amber-500 text-amber-700 bg-amber-500/10'
                        }`}
                      >
                        {restoreTarget.checksumVerified
                          ? `SHA-256 Verified (${restoreTarget.checksum.slice(0, 10)})`
                          : `Computed SHA-256 (${restoreTarget.checksum.slice(0, 10)})`}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-2 text-xs">
                      {Object.entries(restoreTarget.envelope.record_counts || {}).map(
                        ([key, val]) => (
                          <span
                            key={key}
                            className="px-2.5 py-1 rounded-md bg-[var(--surface)] border border-[var(--border)] tabular-nums"
                          >
                            {key}: {val}
                          </span>
                        )
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                      <div className="sm:col-span-2">
                        <label
                          htmlFor="restore-owner-pw"
                          className="block text-xs font-medium mb-1"
                        >
                          Confirm Owner Password ({profile?.email})
                        </label>
                        <input
                          id="restore-owner-pw"
                          type="password"
                          required
                          value={restorePassword}
                          onChange={(e) => setRestorePassword(e.target.value)}
                          placeholder="Enter your login password to verify"
                          className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--give)]"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setRestoreTarget(null);
                            setRestorePassword('');
                          }}
                          className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={restoring}
                          className="h-10 px-4 rounded-lg bg-[var(--give)] text-white text-xs font-semibold disabled:opacity-50"
                        >
                          {restoring ? 'Restoring...' : 'Download Safety Copy & Restore'}
                        </button>
                      </div>
                    </div>
                  </form>
                )}
              </section>
            )}

            {/* Backup History */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                <h2 className="text-sm font-semibold">Backup & Restore History</h2>
              </div>
              {backupHistory.length === 0 ? (
                <div className="p-5 text-xs text-[var(--text-muted)]">
                  No backup or restore events recorded yet.
                </div>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {backupHistory.map((rec) => (
                    <div
                      key={rec.id}
                      className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <span className="font-semibold uppercase">
                          {rec.backup_type.replace('_', ' ')}
                        </span>{' '}
                        <span className="text-[var(--text-muted)] font-mono">
                          ({rec.schema_version})
                        </span>
                        <div className="text-[var(--text-muted)] mt-0.5">
                          {Object.entries(rec.record_counts || {})
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(' · ')}
                        </div>
                      </div>
                      <div className="text-right tabular-nums text-[var(--text-muted)]">
                        <div>{(rec.size_bytes / 1024).toFixed(1)} KB</div>
                        <div>{formatDateTime(rec.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </RequireRole>
      )}
    </div>
  );
}
