import {
  IconArrowBackUp,
  IconArrowDownLeft,
  IconArrowUpRight,
  IconPlus,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { supabase } from '../../core/supabase';
import type {
  KhataTotalsSummary,
  PaymentDirection,
  PaymentMode,
  PaymentRecord,
} from '../../types/bizone';
import { PaymentModal } from '../parties/PaymentModal';

interface PaymentsScreenProps {
  initialAction?: 'receive-payment' | 'give-payment' | null;
  onActionConsumed?: () => void;
  onOpenParty?: (partyId: string) => void;
}

export function PaymentsScreen({
  initialAction,
  onActionConsumed,
  onOpenParty,
}: PaymentsScreenProps) {
  const { profile, language, showToast, t } = useApp();

  const [summary, setSummary] = useState<KhataTotalsSummary | null>(null);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dirFilter, setDirFilter] = useState<'all' | PaymentDirection>('all');
  const [modeFilter, setModeFilter] = useState<'all' | PaymentMode>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'posted' | 'reversed'>(
    'all'
  );
  const [searchQuery, setSearchQuery] = useState('');

  const [modalDir, setModalDir] = useState<PaymentDirection | null>(null);
  const [reversingPayment, setReversingPayment] = useState<PaymentRecord | null>(
    null
  );
  const [reversalReason, setReversalReason] = useState('');
  const [reversing, setReversing] = useState(false);

  const canReverse =
    profile?.role === 'owner' || profile?.role === 'manager';

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sumRes, payRes] = await Promise.all([
        supabase.from('khata_totals_summary').select('*').maybeSingle(),
        supabase
          .from('payments')
          .select('*, parties(name, party_type, phone), payment_allocations(*)')
          .order('payment_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      if (sumRes.error) throw sumRes.error;
      if (payRes.error) throw payRes.error;

      setSummary((sumRes.data as KhataTotalsSummary | null) ?? null);
      setPayments((payRes.data as PaymentRecord[] | null) ?? []);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load payments.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  useEffect(() => {
    if (initialAction === 'receive-payment') {
      setModalDir('receive');
      onActionConsumed?.();
    } else if (initialAction === 'give-payment') {
      setModalDir('give');
      onActionConsumed?.();
    }
  }, [initialAction, onActionConsumed]);

  const filteredPayments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return payments.filter((pay) => {
      if (dirFilter !== 'all' && pay.direction !== dirFilter) return false;
      if (modeFilter !== 'all' && pay.mode !== modeFilter) return false;
      if (statusFilter !== 'all' && pay.status !== statusFilter) return false;
      if (!q) return true;
      return (
        pay.payment_number.toLowerCase().includes(q) ||
        (pay.parties?.name ?? '').toLowerCase().includes(q) ||
        (pay.reference_no ?? '').toLowerCase().includes(q)
      );
    });
  }, [payments, dirFilter, modeFilter, statusFilter, searchQuery]);

  const handleReverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversingPayment) return;
    if (reversalReason.trim().length < 3) {
      showToast(
        language === 'hi'
          ? 'कम से कम 3 अक्षरों का कारण दर्ज करें।'
          : 'Please enter a reason (minimum 3 characters).',
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
      await loadPayments();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to reverse payment.',
        'error'
      );
    } finally {
      setReversing(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            {t('payments.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {t('payments.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setModalDir('give')}
            className="h-11 px-4 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-[var(--give)] text-sm font-semibold inline-flex items-center gap-1.5"
          >
            <IconArrowUpRight size={18} stroke={2} />
            <span>{t('payments.givePayment')}</span>
          </button>
          <button
            type="button"
            onClick={() => setModalDir('receive')}
            className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5"
          >
            <IconPlus size={18} stroke={2.5} />
            <span>{t('payments.receivePayment')}</span>
          </button>
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--receive-text)]">
            <IconArrowDownLeft size={15} stroke={2} />
            <span>{t('payments.receivedToday')}</span>
          </div>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--receive-text)]">
            {formatINR(Number(summary?.today_received ?? 0))}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--give)]">
            <IconArrowUpRight size={15} stroke={2} />
            <span>{t('payments.givenToday')}</span>
          </div>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--give)]">
            {formatINR(Number(summary?.today_given ?? 0))}
          </p>
        </div>

        <div className="col-span-2 sm:col-span-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {language === 'hi' ? 'कुल दर्ज रसीदें' : 'Posted Entries'}
          </p>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums">
            {payments.filter((p) => p.status === 'posted').length}
          </p>
        </div>
      </section>

      {loadError && (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] flex items-center justify-between gap-4 text-xs sm:text-sm text-[var(--give)]">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadPayments()}
            className="h-9 px-3 rounded-lg border border-[var(--give)]/40 bg-[var(--surface)] text-xs font-medium text-[var(--text)] inline-flex items-center gap-1.5"
          >
            <IconRefresh size={14} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <IconSearch
            size={17}
            stroke={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              language === 'hi'
                ? 'रसीद संख्या, पार्टी या संदर्भ नं. खोजें...'
                : 'Search receipt #, party name, or UTR...'
            }
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { id: 'all', label: t('parties.all') },
              { id: 'receive', label: t('payments.receivePayment') },
              { id: 'give', label: t('payments.givePayment') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setDirFilter(tab.id)}
              className={`h-9 px-3 rounded-lg border text-xs font-medium ${
                dirFilter === tab.id
                  ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
              }`}
            >
              {tab.label}
            </button>
          ))}

          <select
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value as 'all' | PaymentMode)}
            className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium"
          >
            <option value="all">{t('payments.mode')}: All</option>
            <option value="cash">{t('payments.modes.cash')}</option>
            <option value="upi">{t('payments.modes.upi')}</option>
            <option value="card">{t('payments.modes.card')}</option>
            <option value="bank_transfer">{t('payments.modes.bank_transfer')}</option>
            <option value="cheque">{t('payments.modes.cheque')}</option>
            <option value="other">{t('payments.modes.other')}</option>
          </select>

          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'all' | 'posted' | 'reversed')
            }
            className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium"
          >
            <option value="all">Status: All</option>
            <option value="posted">{t('payments.posted')}</option>
            <option value="reversed">{t('payments.reversed')}</option>
          </select>
        </div>
      </div>

      {/* Register Table / Mobile List */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        {loading && payments.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--text-muted)]">
            {t('common.loading')}
          </div>
        ) : filteredPayments.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <p className="text-sm font-semibold">
              {language === 'hi'
                ? 'कोई भुगतान प्रविष्टि नहीं मिली'
                : 'No payment records found'}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {language === 'hi'
                ? 'नया भुगतान या रसीद जोड़ने के लिए ऊपर दिए बटन का उपयोग करें।'
                : 'Record a received or given payment to track cash/bank receipts and due allocations.'}
            </p>
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    <th className="py-2.5 px-4 font-medium">Receipt # &amp; Date</th>
                    <th className="py-2.5 px-4 font-medium">{t('payments.party')}</th>
                    <th className="py-2.5 px-4 font-medium">{t('payments.mode')}</th>
                    <th className="py-2.5 px-4 font-medium">
                      {t('payments.allocationTitle')}
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">
                      {t('payments.amount')}
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredPayments.map((pay) => {
                    const isRec = pay.direction === 'receive';
                    return (
                      <tr
                        key={pay.id}
                        className={pay.status === 'reversed' ? 'opacity-60' : ''}
                      >
                        <td className="py-3 px-4 whitespace-nowrap tabular-nums">
                          <div className="font-semibold text-xs">
                            {pay.payment_number}
                          </div>
                          <div className="text-xs text-[var(--text-muted)]">
                            {formatDate(pay.payment_date)}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          {onOpenParty ? (
                            <button
                              type="button"
                              onClick={() => onOpenParty(pay.party_id)}
                              className="font-semibold text-sm text-[var(--primary-dark)] hover:underline text-left"
                            >
                              {pay.parties?.name || 'Party'}
                            </button>
                          ) : (
                            <span className="font-semibold text-sm">
                              {pay.parties?.name || 'Party'}
                            </span>
                          )}
                          <div className="text-xs text-[var(--text-muted)]">
                            {isRec
                              ? t('payments.receivePayment')
                              : t('payments.givePayment')}
                            {pay.status === 'reversed'
                              ? ` · ${t('payments.reversed')}${
                                  pay.reversal_reason
                                    ? ` (${pay.reversal_reason})`
                                    : ''
                                }`
                              : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <div className="font-medium">
                            {t(`payments.modes.${pay.mode}`)}
                          </div>
                          {pay.reference_no && (
                            <div className="text-[var(--text-muted)] font-mono text-[11px]">
                              {pay.reference_no}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-[var(--text-muted)] tabular-nums">
                          <div>
                            {t('payments.allocated')}:{' '}
                            {formatINR(Number(pay.allocated_amount))}
                          </div>
                          {Number(pay.advance_amount) > 0 && (
                            <div>
                              {t('payments.advanceOnAccount')}:{' '}
                              {formatINR(Number(pay.advance_amount))}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums whitespace-nowrap">
                          <span
                            className={`font-semibold ${
                              isRec
                                ? 'text-[var(--receive-text)]'
                                : 'text-[var(--give)]'
                            }`}
                          >
                            {isRec ? '+' : '-'}
                            {formatINR(Number(pay.amount))}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {canReverse && pay.status === 'posted' ? (
                            <button
                              type="button"
                              onClick={() => {
                                setReversingPayment(pay);
                                setReversalReason('');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--give)]/30 text-xs font-medium text-[var(--give)] hover:bg-[var(--give-soft)]"
                            >
                              <IconArrowBackUp size={14} stroke={2} />
                              <span>{t('payments.reversePayment')}</span>
                            </button>
                          ) : (
                            <span className="text-xs text-[var(--text-muted)]">
                              {pay.status === 'reversed'
                                ? t('payments.reversed')
                                : '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-[var(--border)]">
              {filteredPayments.map((pay) => {
                const isRec = pay.direction === 'receive';
                return (
                  <div
                    key={pay.id}
                    className={`p-4 space-y-1.5 ${
                      pay.status === 'reversed' ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {onOpenParty ? (
                          <button
                            type="button"
                            onClick={() => onOpenParty(pay.party_id)}
                            className="text-sm font-semibold text-[var(--primary-dark)] hover:underline truncate block text-left"
                          >
                            {pay.parties?.name || 'Party'}
                          </button>
                        ) : (
                          <p className="text-sm font-semibold truncate">
                            {pay.parties?.name || 'Party'}
                          </p>
                        )}
                        <p className="text-xs text-[var(--text-muted)] tabular-nums">
                          {pay.payment_number} · {formatDate(pay.payment_date)} ·{' '}
                          {t(`payments.modes.${pay.mode}`)}
                          {pay.status === 'reversed' ? ` · ${t('payments.reversed')}` : ''}
                        </p>
                      </div>
                      <p
                        className={`text-sm font-semibold tabular-nums shrink-0 ${
                          isRec
                            ? 'text-[var(--receive-text)]'
                            : 'text-[var(--give)]'
                        }`}
                      >
                        {isRec ? '+' : '-'}
                        {formatINR(Number(pay.amount))}
                      </p>
                    </div>
                    {canReverse && pay.status === 'posted' && (
                      <button
                        type="button"
                        onClick={() => {
                          setReversingPayment(pay);
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

      <PaymentModal
        open={modalDir !== null}
        initialDirection={modalDir ?? 'receive'}
        onClose={() => setModalDir(null)}
        onSaved={() => void loadPayments()}
      />

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
                ? `${formatINR(Number(reversingPayment.amount))} का भुगतान रिवर्स करने पर खाता बही में विपरीत प्रविष्टि दर्ज होगी।`
                : `Reversing ${formatINR(Number(reversingPayment.amount))} posts an offsetting reversal entry in the party khata and restores open dues.`}
            </p>
            <form onSubmit={handleReverse} className="space-y-4">
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
