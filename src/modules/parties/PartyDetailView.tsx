import {
  IconArchive,
  IconArrowBackUp,
  IconArrowDownLeft,
  IconArrowLeft,
  IconArrowUpRight,
  IconBrandWhatsapp,
  IconCheck,
  IconClock,
  IconEdit,
  IconFileText,
  IconMapPin,
  IconPhone,
  IconPlus,
  IconReceipt,
  IconRefresh,
  IconRestore,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR, todayLocalIso } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  BalanceDirection,
  OpenObligationRecord,
  PartyAddressRecord,
  PartyBalanceRecord,
  PartyItemRateRecord,
  PartyLedgerEntryRecord,
  PartySiteRecord,
  PaymentDirection,
  PaymentRecord,
} from '../../types/bizone';
import { PartyFormModal } from './PartyFormModal';
import { PaymentModal } from './PaymentModal';
import { ReminderModal } from './ReminderModal';
import { StatementPreviewModal } from './StatementPreviewModal';

interface PartyDetailViewProps {
  partyId: string;
  onBack: () => void;
  onUpdated?: () => void;
  onNewBill?: (partyId: string) => void;
  onOpenBill?: (billId: string) => void;
}

type LedgerFilter = 'all' | 'dues' | 'payments' | 'reversals';

export function PartyDetailView({
  partyId,
  onBack,
  onUpdated,
  onNewBill,
  onOpenBill,
}: PartyDetailViewProps) {
  const { business, profile, isModuleEnabled, language, showToast, t } = useApp();

  const [party, setParty] = useState<PartyBalanceRecord | null>(null);
  const [addresses, setAddresses] = useState<PartyAddressRecord[]>([]);
  const [obligations, setObligations] = useState<OpenObligationRecord[]>([]);
  const [ledgerRows, setLedgerRows] = useState<PartyLedgerEntryRecord[]>([]);
  const [paymentsById, setPaymentsById] = useState<Record<string, PaymentRecord>>({});
  const [sites, setSites] = useState<PartySiteRecord[]>([]);
  const [rateCards, setRateCards] = useState<PartyItemRateRecord[]>([]);
  const [newSiteOpen, setNewSiteOpen] = useState(false);
  const [siteName, setSiteName] = useState('');
  const [sitePhone, setSitePhone] = useState('');
  const [siteAddr, setSiteAddr] = useState('');
  const [savingSite, setSavingSite] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ledgerFilter, setLedgerFilter] = useState<LedgerFilter>('all');

  const [editOpen, setEditOpen] = useState(false);
  const [paymentModalDir, setPaymentModalDir] = useState<PaymentDirection | null>(
    null
  );
  const [reminderOpen, setReminderOpen] = useState(false);
  const [statementOpen, setStatementOpen] = useState(false);

  // Add Due Entry modal state
  const [dueOpen, setDueOpen] = useState(false);
  const [dueDir, setDueDir] = useState<BalanceDirection>('to_receive');
  const [dueAmount, setDueAmount] = useState('');
  const [dueDate, setDueDate] = useState(todayLocalIso());
  const [duePayByDate, setDuePayByDate] = useState('');
  const [dueNote, setDueNote] = useState('');
  const [dueIdempKey, setDueIdempKey] = useState('');
  const [dueSaving, setDueSaving] = useState(false);

  // Archive / Restore modal state
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // Reverse Payment modal state
  const [reversingPayment, setReversingPayment] = useState<PaymentRecord | null>(
    null
  );
  const [reversalReason, setReversalReason] = useState('');
  const [reversing, setReversing] = useState(false);

  const billingEnabled =
    isModuleEnabled('billing') && hasCapability(profile?.role, 'create_bills');
  const paymentsEnabled = isModuleEnabled('payments');
  const canReverse =
    paymentsEnabled &&
    (profile?.role === 'owner' || profile?.role === 'manager');
  const canArchive =
    profile?.role === 'owner' ||
    profile?.role === 'manager' ||
    profile?.role === 'accountant';

  const loadPartyDetail = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [balRes, addrRes, obRes, ledRes, payRes, sitesRes, ratesRes] = await Promise.all([
        supabase
          .from('party_balances')
          .select('*')
          .eq('party_id', partyId)
          .maybeSingle(),
        supabase
          .from('party_addresses')
          .select('*')
          .eq('party_id', partyId)
          .order('is_default', { ascending: false })
          .order('created_at', { ascending: true }),
        supabase
          .from('party_open_obligations')
          .select('*')
          .eq('party_id', partyId)
          .order('entry_date', { ascending: true })
          .order('created_at', { ascending: true }),
        supabase
          .from('party_ledger_entries')
          .select('*')
          .eq('party_id', partyId)
          .order('entry_date', { ascending: true })
          .order('created_at', { ascending: true })
          .order('id', { ascending: true }),
        paymentsEnabled
          ? supabase
              .from('payments')
              .select('*')
              .eq('party_id', partyId)
          : Promise.resolve({ data: [], error: null }),
        business?.pack === 'hardware'
          ? supabase
              .from('party_sites')
              .select('*')
              .eq('party_id', partyId)
              .order('site_name', { ascending: true })
          : Promise.resolve({ data: [], error: null }),
        business?.pack === 'wholesale'
          ? supabase
              .from('party_item_rates')
              .select('*')
              .eq('party_id', partyId)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (balRes.error) throw balRes.error;
      if (!balRes.data) throw new Error('Party not found or access denied.');
      if (addrRes.error) throw addrRes.error;
      if (obRes.error) throw obRes.error;
      if (ledRes.error) throw ledRes.error;
      if (payRes.error) throw payRes.error;

      setParty(balRes.data as PartyBalanceRecord);
      setAddresses((addrRes.data as PartyAddressRecord[] | null) ?? []);
      setObligations((obRes.data as OpenObligationRecord[] | null) ?? []);
      setSites((sitesRes.data as PartySiteRecord[] | null) ?? []);
      setRateCards((ratesRes.data as PartyItemRateRecord[] | null) ?? []);

      // Compute exact chronological running balance
      const rawEntries = (ledRes.data as PartyLedgerEntryRecord[] | null) ?? [];
      let running = 0;
      const withRunning = rawEntries.map((row) => {
        running = Math.round((running + Number(row.signed_amount)) * 100) / 100;
        return { ...row, running_balance: running };
      });
      setLedgerRows(withRunning.reverse());

      const payMap: Record<string, PaymentRecord> = {};
      for (const p of (payRes.data as PaymentRecord[] | null) ?? []) {
        payMap[p.id] = p;
      }
      setPaymentsById(payMap);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load party khata.'
      );
    } finally {
      setLoading(false);
    }
  }, [partyId, paymentsEnabled, business?.pack]);

  useEffect(() => {
    void loadPartyDetail();
  }, [loadPartyDetail]);

  const filteredLedger = useMemo(() => {
    if (ledgerFilter === 'all') return ledgerRows;
    if (ledgerFilter === 'dues') {
      return ledgerRows.filter((r) =>
        ['opening_balance', 'khata_due', 'bill', 'purchase', 'adjustment'].includes(
          r.entry_type
        )
      );
    }
    if (ledgerFilter === 'payments') {
      return ledgerRows.filter((r) =>
        ['payment_receive', 'payment_give'].includes(r.entry_type)
      );
    }
    return ledgerRows.filter(
      (r) => r.entry_type === 'payment_reversal' || r.is_reversed
    );
  }, [ledgerRows, ledgerFilter]);

  const defaultAddress = useMemo(
    () => addresses.find((a) => a.is_default) ?? addresses[0] ?? null,
    [addresses]
  );

  const openAddDueModal = () => {
    setDueDir(party?.party_type === 'supplier' ? 'to_give' : 'to_receive');
    setDueAmount('');
    setDueDate(todayLocalIso());
    setDuePayByDate('');
    setDueNote('');
    setDueIdempKey(`due_${crypto.randomUUID()}`);
    setDueOpen(true);
  };

  const handleSaveSite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!siteName.trim()) return;
    setSavingSite(true);
    try {
      const { error } = await supabase.rpc('save_party_site', {
        p_party_id: partyId,
        p_site_name: siteName.trim(),
        p_contact_name: null,
        p_contact_phone: sitePhone.trim() || null,
        p_address: siteAddr.trim() || null,
        p_site_id: null,
        p_is_active: true,
      });
      if (error) throw error;
      showToast('Contractor site added.', 'success');
      setSiteName('');
      setSitePhone('');
      setSiteAddr('');
      setNewSiteOpen(false);
      await loadPartyDetail();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to add site.', 'error');
    } finally {
      setSavingSite(false);
    }
  };

  const handleSaveDue = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Math.round(Number(dueAmount || 0) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) {
      showToast(
        language === 'hi'
          ? 'कृपया 0 से अधिक राशि दर्ज करें।'
          : 'Please enter an amount greater than zero.',
        'error'
      );
      return;
    }

    setDueSaving(true);
    try {
      const { error } = await supabase.rpc('post_khata_due', {
        p_party_id: partyId,
        p_direction: dueDir,
        p_amount: amt,
        p_entry_date: dueDate || todayLocalIso(),
        p_due_date: duePayByDate || null,
        p_note: dueNote.trim() || null,
        p_idempotency_key: dueIdempKey,
      });
      if (error) throw error;
      showToast(
        language === 'hi' ? 'खाता बकाया दर्ज किया गया।' : 'Khata due recorded.',
        'success'
      );
      setDueOpen(false);
      await loadPartyDetail();
      onUpdated?.();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save due entry.',
        'error'
      );
    } finally {
      setDueSaving(false);
    }
  };

  const handleArchiveToggle = async () => {
    if (!party) return;
    setArchiving(true);
    try {
      const nextActive = !party.is_active;
      const { error } = await supabase.rpc('archive_party', {
        p_party_id: party.party_id,
        p_is_active: nextActive,
      });
      if (error) throw error;
      showToast(
        nextActive
          ? language === 'hi'
            ? 'पार्टी पुनर्स्थापित की गई।'
            : 'Party restored.'
          : language === 'hi'
            ? 'पार्टी संग्रहीत की गई।'
            : 'Party archived.',
        'success'
      );
      setArchiveConfirmOpen(false);
      await loadPartyDetail();
      onUpdated?.();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to update party status.',
        'error'
      );
    } finally {
      setArchiving(false);
    }
  };

  const handleReversePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversingPayment) return;
    if (reversalReason.trim().length < 3) {
      showToast(
        language === 'hi'
          ? 'कम से कम 3 अक्षरों का कारण दर्ज करें।'
          : 'Please enter a reason (at least 3 characters).',
        'error'
      );
      return;
    }

    setReversing(true);
    try {
      const { error } = await supabase.rpc('reverse_payment', {
        p_payment_id: reversingPayment.id,
        p_reason: reversalReason.trim(),
      });
      if (error) throw error;
      showToast(
        language === 'hi'
          ? `भुगतान ${reversingPayment.payment_number} रिवर्स किया गया।`
          : `Payment ${reversingPayment.payment_number} reversed.`,
        'success'
      );
      setReversingPayment(null);
      setReversalReason('');
      await loadPartyDetail();
      onUpdated?.();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to reverse payment.',
        'error'
      );
    } finally {
      setReversing(false);
    }
  };

  if (loading && !party) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <IconArrowLeft size={18} stroke={2} />
          <span>{t('parties.title')}</span>
        </button>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
          {t('common.loading')}
        </div>
      </div>
    );
  }

  if (loadError || !party) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <IconArrowLeft size={18} stroke={2} />
          <span>{t('parties.title')}</span>
        </button>
        <div className="rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] p-5 flex items-center justify-between gap-4 text-sm text-[var(--give)]">
          <span>{loadError || 'Party not found.'}</span>
          <button
            type="button"
            onClick={() => void loadPartyDetail()}
            className="h-9 px-3 rounded-lg border border-[var(--give)]/40 bg-[var(--surface)] text-xs font-medium text-[var(--text)] inline-flex items-center gap-1.5"
          >
            <IconRefresh size={14} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      </div>
    );
  }

  const net = Number(party.net_balance || 0);
  const creditExceeded =
    party.credit_limit > 0 && Number(party.to_receive) > Number(party.credit_limit);

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <IconArrowLeft size={16} stroke={2} />
            <span>{t('parties.title')}</span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
              {party.name}
            </h1>
            {!party.is_active && (
              <span className="text-xs font-medium text-[var(--warning-text)]">
                · {t('parties.archived')}
              </span>
            )}
          </div>

          <p className="text-xs sm:text-sm text-[var(--text-muted)] flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{t(`parties.${party.party_type}`)}</span>
            {party.phone && (
              <>
                <span>·</span>
                <a
                  href={`tel:${party.phone}`}
                  className="inline-flex items-center gap-1 text-[var(--primary-dark)] hover:underline tabular-nums"
                >
                  <IconPhone size={14} stroke={2} />
                  <span>{party.phone}</span>
                </a>
              </>
            )}
            {party.gstin && (
              <>
                <span>·</span>
                <span className="font-mono text-xs">GSTIN {party.gstin}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
          >
            <IconEdit size={16} stroke={2} />
            <span>{t('parties.editParty')}</span>
          </button>

          {canArchive && (
            <button
              type="button"
              onClick={() => setArchiveConfirmOpen(true)}
              className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              {party.is_active ? (
                <>
                  <IconArchive size={16} stroke={2} />
                  <span>{t('parties.archiveParty')}</span>
                </>
              ) : (
                <>
                  <IconRestore size={16} stroke={2} />
                  <span>{t('parties.restoreParty')}</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Balance & Credit Summary Card */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {net > 0
              ? t('parties.youllGet')
              : net < 0
                ? t('parties.youllGive')
                : t('parties.settled')}
          </p>
          <p
            className={`mt-1 text-2xl sm:text-3xl font-semibold tabular-nums ${
              net > 0
                ? 'text-[var(--receive-text)]'
                : net < 0
                  ? 'text-[var(--give)]'
                  : 'text-[var(--text)]'
            }`}
          >
            {formatINR(Math.abs(net))}
          </p>
          {party.is_overdue && (
            <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[var(--give)]">
              <IconClock size={14} stroke={2} />
              <span>
                {t('parties.overdue')}:{' '}
                {formatINR(
                  net > 0
                    ? Number(party.overdue_receivable)
                    : Number(party.overdue_payable)
                )}
              </span>
            </p>
          )}
        </div>

        <div className="text-xs sm:text-sm space-y-1.5">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('parties.creditTerms')}
          </p>
          <p className="tabular-nums">
            {party.credit_limit > 0
              ? `${t('parties.creditLimit')}: ${formatINR(party.credit_limit)}`
              : language === 'hi'
                ? 'कोई उधार सीमा तय नहीं'
                : 'No credit limit set'}
            {party.credit_days > 0 ? ` · ${party.credit_days}d` : ''}
          </p>
          {creditExceeded && (
            <p className="text-xs font-medium text-[var(--give)]">
              {language === 'hi'
                ? 'उधार सीमा से अधिक बकाया'
                : 'Outstanding exceeds credit limit'}
            </p>
          )}
        </div>

        <div className="text-xs sm:text-sm space-y-1">
          <p className="inline-flex items-center gap-1 text-xs font-medium text-[var(--text-muted)]">
            <IconMapPin size={14} stroke={2} />
            <span>{t('parties.addresses')}</span>
          </p>
          {defaultAddress ? (
            <p className="text-xs text-[var(--text)] leading-relaxed">
              {[
                defaultAddress.address_line1,
                defaultAddress.city,
                defaultAddress.state,
                defaultAddress.pincode,
              ]
                .filter(Boolean)
                .join(', ')}
              {addresses.length > 1 ? ` (+${addresses.length - 1})` : ''}
            </p>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              {language === 'hi' ? 'कोई पता दर्ज नहीं' : 'No address saved'}
            </p>
          )}
        </div>
      </section>

      {/* Primary Action Strip */}
      <div className="flex flex-wrap items-center gap-2">
        {paymentsEnabled && party.is_active && (
          <>
            <button
              type="button"
              onClick={() => setPaymentModalDir('receive')}
              className="h-11 px-4 rounded-lg bg-[var(--receive)] text-white text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
            >
              <IconArrowDownLeft size={18} stroke={2} />
              <span>{t('payments.receivePayment')}</span>
            </button>

            <button
              type="button"
              onClick={() => setPaymentModalDir('give')}
              className="h-11 px-4 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-[var(--give)] text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
            >
              <IconArrowUpRight size={18} stroke={2} />
              <span>{t('payments.givePayment')}</span>
            </button>
          </>
        )}

        {billingEnabled && party.is_active && onNewBill && (
          <button
            type="button"
            onClick={() => onNewBill(party.party_id)}
            className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
          >
            <IconReceipt size={18} stroke={2} />
            <span>{t('bills.newBill')}</span>
          </button>
        )}

        {party.is_active && (
          <button
            type="button"
            onClick={openAddDueModal}
            className="h-11 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
          >
            <IconPlus size={17} stroke={2} />
            <span>{t('parties.addDue')}</span>
          </button>
        )}

        {Number(party.to_receive) > 0 && (
          <button
            type="button"
            onClick={() => setReminderOpen(true)}
            className="h-11 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
          >
            <IconBrandWhatsapp size={18} stroke={2} className="text-[var(--receive-text)]" />
            <span>{t('parties.sendReminder')}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setStatementOpen(true)}
          className="h-11 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
        >
          <IconFileText size={17} stroke={2} />
          <span>{t('parties.statement')}</span>
        </button>
      </div>

      {/* Open Dues Summary Strip */}
      {obligations.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="text-xs sm:text-sm font-semibold">
              {language === 'hi'
                ? `खुले बकाया बिल / प्रविष्टियाँ (${obligations.length})`
                : `Open Dues & Pending Entries (${obligations.length})`}
            </h2>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {obligations.slice(0, 6).map((ob) => (
              <div
                key={ob.ledger_entry_id}
                className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs sm:text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {ob.reference_no}
                    {ob.note ? ` · ${ob.note}` : ''}
                  </p>
                  <p className="text-xs text-[var(--text-muted)] tabular-nums">
                    {formatDate(ob.entry_date)}
                    {ob.due_date
                      ? ` · ${language === 'hi' ? 'देय' : 'Due'} ${formatDate(ob.due_date)}`
                      : ''}
                    {ob.is_overdue ? ` · ${t('parties.overdue')}` : ''}
                  </p>
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <p
                    className={`font-semibold ${
                      ob.direction_needed === 'receive'
                        ? 'text-[var(--receive-text)]'
                        : 'text-[var(--give)]'
                    }`}
                  >
                    {formatINR(ob.remaining_amount)}
                  </p>
                  {ob.settled_amount > 0 && (
                    <p className="text-[11px] text-[var(--text-muted)]">
                      of {formatINR(ob.original_amount)}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Khata Ledger Section */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm sm:text-base font-semibold">
            {t('parties.khataLedger')}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'all', label: t('parties.allEntries') },
                { id: 'dues', label: t('parties.duesOnly') },
                { id: 'payments', label: t('parties.paymentsOnly') },
                { id: 'reversals', label: t('parties.reversalsOnly') },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setLedgerFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${
                  ledgerFilter === tab.id
                    ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredLedger.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--text-muted)]">
            {t('parties.noLedgerEntries')}
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    <th className="py-2.5 px-4 font-medium">Date</th>
                    <th className="py-2.5 px-4 font-medium">Particulars</th>
                    <th className="py-2.5 px-4 font-medium text-right">
                      {t('parties.debitLabel')}
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">
                      {t('parties.creditLabel')}
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">
                      {t('parties.runningBalance')}
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredLedger.map((entry) => {
                    const rb = Number(entry.running_balance ?? 0);
                    const linkedPayment =
                      entry.source_table === 'payments' &&
                      entry.source_id &&
                      entry.entry_type !== 'payment_reversal'
                        ? paymentsById[entry.source_id]
                        : undefined;
                    const showReverse =
                      canReverse &&
                      linkedPayment &&
                      linkedPayment.status === 'posted';

                    const typeLabel =
                      entry.entry_type === 'payment_receive'
                        ? t('payments.receivePayment')
                        : entry.entry_type === 'payment_give'
                          ? t('payments.givePayment')
                          : entry.entry_type === 'bill'
                            ? `Sales Bill (${t('parties.youllGet')})`
                            : entry.entry_type === 'purchase'
                              ? `Purchase Bill (${t('parties.youllGive')})`
                              : entry.entry_type === 'opening_balance'
                                ? `${t('parties.openingBalance')} (${Number(entry.signed_amount) >= 0 ? t('parties.youllGet') : t('parties.youllGive')})`
                                : entry.entry_type === 'khata_due'
                                  ? `Due (${Number(entry.signed_amount) >= 0 ? t('parties.youllGet') : t('parties.youllGive')})`
                                  : entry.entry_type.replace(/_/g, ' ');

                    return (
                      <tr
                        key={entry.id}
                        className={entry.is_reversed ? 'opacity-60' : ''}
                      >
                        <td className="py-3 px-4 whitespace-nowrap tabular-nums text-xs text-[var(--text-muted)]">
                          {formatDate(entry.entry_date)}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-sm">
                            {billingEnabled &&
                            entry.source_table === 'bills' &&
                            entry.source_id &&
                            onOpenBill ? (
                              <button
                                type="button"
                                onClick={() => onOpenBill(entry.source_id!)}
                                className="text-[var(--primary-dark)] hover:underline text-left"
                              >
                                {entry.reference_no || entry.entry_type}
                              </button>
                            ) : (
                              <span>{entry.reference_no || entry.entry_type}</span>
                            )}
                            <span className="text-xs text-[var(--text-muted)] font-normal">
                              {` · ${typeLabel}`}
                            </span>
                            {entry.is_reversed
                              ? ` · ${t('payments.reversed')}`
                              : ''}
                          </div>
                          {entry.note && (
                            <div className="text-xs text-[var(--text-muted)]">
                              {entry.note}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums text-[var(--receive-text)] font-medium">
                          {Number(entry.debit_amount) > 0
                            ? formatINR(Number(entry.debit_amount))
                            : '—'}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums text-[var(--give)] font-medium">
                          {Number(entry.credit_amount) > 0
                            ? formatINR(Number(entry.credit_amount))
                            : '—'}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums font-semibold whitespace-nowrap">
                          {rb > 0 ? (
                            <span className="text-[var(--receive-text)]">
                              {formatINR(rb)} ({t('parties.youllGet')})
                            </span>
                          ) : rb < 0 ? (
                            <span className="text-[var(--give)]">
                              {formatINR(Math.abs(rb))} ({t('parties.youllGive')})
                            </span>
                          ) : (
                            <span className="text-[var(--text-muted)]">
                              {formatINR(0)} ({t('parties.settled')})
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {showReverse ? (
                            <button
                              type="button"
                              onClick={() => {
                                setReversingPayment(linkedPayment);
                                setReversalReason('');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--give)]/30 text-xs font-medium text-[var(--give)] hover:bg-[var(--give-soft)]"
                            >
                              <IconArrowBackUp size={14} stroke={2} />
                              <span>{t('payments.reversePayment')}</span>
                            </button>
                          ) : (
                            <span className="text-xs text-[var(--text-muted)]">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile List */}
            <div className="md:hidden divide-y divide-[var(--border)]">
              {filteredLedger.map((entry) => {
                const rb = Number(entry.running_balance ?? 0);
                const linkedPayment =
                  entry.source_table === 'payments' &&
                  entry.source_id &&
                  entry.entry_type !== 'payment_reversal'
                    ? paymentsById[entry.source_id]
                    : undefined;
                const showReverse =
                  canReverse && linkedPayment && linkedPayment.status === 'posted';

                const typeLabel =
                  entry.entry_type === 'payment_receive'
                    ? t('payments.receivePayment')
                    : entry.entry_type === 'payment_give'
                      ? t('payments.givePayment')
                      : entry.entry_type === 'bill'
                        ? `Sales Bill (${t('parties.youllGet')})`
                        : entry.entry_type === 'purchase'
                          ? `Purchase Bill (${t('parties.youllGive')})`
                          : entry.entry_type === 'opening_balance'
                            ? `${t('parties.openingBalance')} (${Number(entry.signed_amount) >= 0 ? t('parties.youllGet') : t('parties.youllGive')})`
                            : entry.entry_type === 'khata_due'
                              ? `Due (${Number(entry.signed_amount) >= 0 ? t('parties.youllGet') : t('parties.youllGive')})`
                              : entry.entry_type.replace(/_/g, ' ');

                return (
                  <div
                    key={entry.id}
                    className={`p-4 space-y-1.5 ${
                      entry.is_reversed ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {billingEnabled &&
                        entry.source_table === 'bills' &&
                        entry.source_id &&
                        onOpenBill ? (
                          <button
                            type="button"
                            onClick={() => onOpenBill(entry.source_id!)}
                            className="text-sm font-semibold truncate text-[var(--primary-dark)] hover:underline text-left block"
                          >
                            {entry.reference_no || entry.entry_type}
                          </button>
                        ) : (
                          <p className="text-sm font-semibold truncate">
                            {entry.reference_no || entry.entry_type}
                          </p>
                        )}
                        <p className="text-xs text-[var(--text-muted)] tabular-nums">
                          {formatDate(entry.entry_date)} · {typeLabel}
                          {entry.is_reversed ? ` · ${t('payments.reversed')}` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0 tabular-nums">
                        {Number(entry.debit_amount) > 0 ? (
                          <p className="text-sm font-semibold text-[var(--receive-text)]">
                            +{formatINR(Number(entry.debit_amount))}
                          </p>
                        ) : (
                          <p className="text-sm font-semibold text-[var(--give)]">
                            -{formatINR(Number(entry.credit_amount))}
                          </p>
                        )}
                        <p className="text-[11px] text-[var(--text-muted)]">
                          {rb > 0
                            ? `${formatINR(rb)} (${t('parties.youllGet')})`
                            : rb < 0
                              ? `${formatINR(Math.abs(rb))} (${t('parties.youllGive')})`
                              : `${formatINR(0)} (${t('parties.settled')})`}
                        </p>
                      </div>
                    </div>
                    {entry.note && (
                      <p className="text-xs text-[var(--text-muted)]">{entry.note}</p>
                    )}
                    {showReverse && (
                      <button
                        type="button"
                        onClick={() => {
                          setReversingPayment(linkedPayment);
                          setReversalReason('');
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--give)]/30 text-xs font-medium text-[var(--give)]"
                      >
                        <IconArrowBackUp size={14} stroke={2} />
                        <span>{t('payments.reversePayment')}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* Hardware Contractor Sites */}
      {business?.pack === 'hardware' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Contractor Project Sites ({sites.length})
            </h2>
            <button
              type="button"
              onClick={() => setNewSiteOpen((v) => !v)}
              className="h-8 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1"
            >
              <IconPlus size={14} stroke={2} />
              <span>Add Site</span>
            </button>
          </div>
          {newSiteOpen && (
            <form
              onSubmit={handleSaveSite}
              className="p-4 border-b border-[var(--border)] bg-[var(--surface-muted)] grid grid-cols-1 sm:grid-cols-4 gap-2.5 items-end"
            >
              <input
                required
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder="Site Name *"
                className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <input
                value={sitePhone}
                onChange={(e) => setSitePhone(e.target.value)}
                placeholder="Supervisor Phone"
                className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <input
                value={siteAddr}
                onChange={(e) => setSiteAddr(e.target.value)}
                placeholder="Site Location / Address"
                className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <button
                type="submit"
                disabled={savingSite}
                className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                {savingSite ? 'Saving...' : 'Save Site'}
              </button>
            </form>
          )}
          {sites.length === 0 ? (
            <p className="p-4 text-xs text-[var(--text-muted)]">
              No contractor sites added for this party.
            </p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {sites.map((s) => (
                <div key={s.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
                  <div>
                    <p className="font-semibold">{s.site_name}</p>
                    <p className="text-[var(--text-muted)]">
                      {[s.address, s.contact_phone].filter(Boolean).join(' · ') || 'Active site'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Wholesale Price Tier & Negotiated Rate Cards */}
      {business?.pack === 'wholesale' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              Wholesale Tier ({party.price_tier || 'standard'}) &amp; Rate Cards
            </h2>
            <span className="text-xs text-[var(--text-muted)] tabular-nums">
              {rateCards.length} custom rate(s)
            </span>
          </div>
          {rateCards.length === 0 ? (
            <p className="p-4 text-xs text-[var(--text-muted)]">
              No item-specific negotiated rate cards yet. Configure in Wholesale Workspace.
            </p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {rateCards.map((rc) => (
                <div key={rc.id} className="px-4 py-2.5 flex items-center justify-between text-xs">
                  <span className="font-mono">{rc.item_id.slice(0, 8)}</span>
                  <span className="tabular-nums font-semibold">
                    {formatINR(Number(rc.custom_rate))} (min {rc.min_qty})
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Modals */}
      <PartyFormModal
        open={editOpen}
        editingParty={party}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          void loadPartyDetail();
          onUpdated?.();
        }}
      />

      <PaymentModal
        open={paymentModalDir !== null}
        lockedParty={party}
        initialDirection={paymentModalDir ?? 'receive'}
        onClose={() => setPaymentModalDir(null)}
        onSaved={() => {
          void loadPartyDetail();
          onUpdated?.();
        }}
      />

      <ReminderModal
        open={reminderOpen}
        party={party}
        onClose={() => setReminderOpen(false)}
      />

      <StatementPreviewModal
        open={statementOpen}
        partyId={party.party_id}
        partyPhone={party.phone}
        partyGstin={party.gstin}
        defaultAddress={defaultAddress}
        onClose={() => setStatementOpen(false)}
      />

      {/* Add Khata Due Modal */}
      {dueOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setDueOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('parties.addDue')}
            className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('parties.addDue')}</h2>
              <button
                type="button"
                onClick={() => setDueOpen(false)}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)]"
              >
                <IconX size={18} stroke={2} />
              </button>
            </div>
            <form onSubmit={handleSaveDue} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDueDir('to_receive')}
                  className={`h-11 px-3 rounded-lg border text-xs sm:text-sm font-semibold ${
                    dueDir === 'to_receive'
                      ? 'border-[var(--receive)] bg-[var(--receive-soft)] text-[var(--receive-text)]'
                      : 'border-[var(--border)] text-[var(--text-muted)]'
                  }`}
                >
                  {t('parties.youllGet')} (+)
                </button>
                <button
                  type="button"
                  onClick={() => setDueDir('to_give')}
                  className={`h-11 px-3 rounded-lg border text-xs sm:text-sm font-semibold ${
                    dueDir === 'to_give'
                      ? 'border-[var(--give)] bg-[var(--give-soft)] text-[var(--give)]'
                      : 'border-[var(--border)] text-[var(--text-muted)]'
                  }`}
                >
                  {t('parties.youllGive')} (-)
                </button>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('payments.amount')} *
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  required
                  min="0.01"
                  step="0.01"
                  value={dueAmount}
                  onChange={(e) => setDueAmount(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-base font-semibold tabular-nums"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    {language === 'hi' ? 'प्रविष्टि तिथि' : 'Entry Date'}
                  </label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    {language === 'hi' ? 'देय तिथि (वैकल्पिक)' : 'Due Date (Optional)'}
                  </label>
                  <input
                    type="date"
                    value={duePayByDate}
                    onChange={(e) => setDuePayByDate(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('parties.notes')}
                </label>
                <input
                  type="text"
                  value={dueNote}
                  onChange={(e) => setDueNote(e.target.value)}
                  placeholder={
                    language === 'hi'
                      ? 'उदा. पुराना उधार सामान'
                      : 'e.g. Manual khata credit slip'
                  }
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDueOpen(false)}
                  className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={dueSaving}
                  className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold disabled:opacity-60"
                >
                  {dueSaving ? t('profile.saving') : t('parties.addDue')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Archive / Restore Confirmation Modal */}
      {archiveConfirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setArchiveConfirmOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold">
              {party.is_active
                ? t('parties.archiveParty')
                : t('parties.restoreParty')}
            </h2>
            <p className="text-sm text-[var(--text-muted)]">
              {party.is_active
                ? net !== 0
                  ? language === 'hi'
                    ? `इस पार्टी का बकाया (${formatINR(Math.abs(net))}) अभी शून्य नहीं है। कृपया संग्रहीत करने से पहले हिसाब बराबर करें।`
                    : `This party still has a net balance of ${formatINR(Math.abs(net))}. Please settle the balance to ₹0.00 before archiving.`
                  : language === 'hi'
                    ? `क्या आप "${party.name}" को संग्रहीत करना चाहते हैं?`
                    : `Archive "${party.name}"? Their khata history stays preserved and can be restored anytime.`
                : language === 'hi'
                  ? `क्या आप "${party.name}" को सक्रिय करना चाहते हैं?`
                  : `Restore "${party.name}" to active parties?`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setArchiveConfirmOpen(false)}
                className="h-10 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={archiving || (party.is_active && net !== 0)}
                onClick={handleArchiveToggle}
                className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <IconCheck size={16} stroke={2} />
                <span>
                  {party.is_active
                    ? t('parties.archiveParty')
                    : t('parties.restoreParty')}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reversal Modal */}
      {reversingPayment && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setReversingPayment(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold">
              {t('payments.reversePayment')} · {reversingPayment.payment_number}
            </h2>
            <p className="text-xs sm:text-sm text-[var(--text-muted)]">
              {language === 'hi'
                ? `${formatINR(Number(reversingPayment.amount))} का भुगतान रिवर्स करने पर खाता बही में विपरीत प्रविष्टि दर्ज होगी और जुड़े बकाया पुनः खुल जाएंगे।`
                : `Reversing ${formatINR(Number(reversingPayment.amount))} posts an offsetting reversal entry in the ledger and re-opens allocated dues.`}
            </p>
            <form onSubmit={handleReversePayment} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('payments.reversalReason')} *
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                  placeholder={
                    language === 'hi'
                      ? 'उदा. गलत राशि / चेक बाउंस'
                      : 'e.g. Cheque bounced / wrong entry'
                  }
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReversingPayment(null)}
                  className="h-10 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={reversing}
                  className="h-10 px-4 rounded-lg bg-[var(--give)] text-white text-sm font-semibold disabled:opacity-60"
                >
                  {reversing ? t('profile.saving') : t('payments.reversePayment')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
