import {
  IconChevronRight,
  IconFileInvoice,
  IconPlus,
  IconReceipt,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { supabase } from '../../core/supabase';
import type { BillRecord, BillingSummary } from '../../types/bizone';
import { BillDetailView } from './BillDetailView';
import { BillFormModal } from './BillFormModal';

export type BillFilterTab =
  | 'all'
  | 'invoices'
  | 'quotations'
  | 'credit_notes'
  | 'drafts'
  | 'unpaid'
  | 'voided';

interface BillsScreenProps {
  initialBillId?: string | null;
  initialPartyId?: string | null;
  initialAction?: 'new-bill' | 'new-quotation' | null;
  onActionConsumed?: () => void;
  onOpenParty?: (partyId: string) => void;
}

export function BillsScreen({
  initialBillId,
  initialPartyId,
  initialAction,
  onActionConsumed,
  onOpenParty,
}: BillsScreenProps) {
  const { business, showToast, t } = useApp();

  const [bills, setBills] = useState<BillRecord[]>([]);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filterTab, setFilterTab] = useState<BillFilterTab>('all');
  const [selectedBillId, setSelectedBillId] = useState<string | null>(
    initialBillId ?? null
  );

  const [formOpen, setFormOpen] = useState(false);
  const [formDocType, setFormDocType] = useState<
    'tax_invoice' | 'bill_of_supply' | 'quotation'
  >('tax_invoice');
  const [formPartyId, setFormPartyId] = useState<string | null>(null);

  useEffect(() => {
    if (initialBillId) setSelectedBillId(initialBillId);
  }, [initialBillId]);

  useEffect(() => {
    if (!initialAction) return;
    setSelectedBillId(null);
    if (initialAction === 'new-quotation') {
      setFormDocType('quotation');
    } else {
      setFormDocType(business?.gst_registered ? 'tax_invoice' : 'bill_of_supply');
    }
    setFormPartyId(initialPartyId ?? null);
    setFormOpen(true);
    onActionConsumed?.();
  }, [initialAction, initialPartyId, business?.gst_registered, onActionConsumed]);

  const loadBills = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [listRes, sumRes] = await Promise.all([
        supabase
          .from('bill_list_view')
          .select('*')
          .order('bill_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(300),
        supabase.from('billing_summary_view').select('*').maybeSingle(),
      ]);

      if (listRes.error) throw listRes.error;
      setBills((listRes.data as BillRecord[] | null) ?? []);
      if (sumRes.data) {
        setSummary(sumRes.data as BillingSummary);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to load bills.';
      setErrorMsg(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadBills();
  }, [loadBills]);

  const filteredBills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bills.filter((b) => {
      if (filterTab === 'invoices') {
        if (!['tax_invoice', 'bill_of_supply'].includes(b.doc_type)) return false;
      } else if (filterTab === 'quotations') {
        if (b.doc_type !== 'quotation') return false;
      } else if (filterTab === 'credit_notes') {
        if (b.doc_type !== 'credit_note') return false;
      } else if (filterTab === 'drafts') {
        if (b.status !== 'draft') return false;
      } else if (filterTab === 'unpaid') {
        if (
          b.status !== 'issued' ||
          !['tax_invoice', 'bill_of_supply'].includes(b.doc_type) ||
          Number(b.balance_due) <= 0
        ) {
          return false;
        }
      } else if (filterTab === 'voided') {
        if (b.status !== 'voided') return false;
      }

      if (!q) return true;
      return (
        (b.bill_number && b.bill_number.toLowerCase().includes(q)) ||
        b.party_name.toLowerCase().includes(q) ||
        (b.party_phone && b.party_phone.toLowerCase().includes(q))
      );
    });
  }, [bills, filterTab, search]);

  if (selectedBillId) {
    return (
      <BillDetailView
        billId={selectedBillId}
        onBack={() => setSelectedBillId(null)}
        onOpenBill={(id) => setSelectedBillId(id)}
        onOpenParty={onOpenParty}
        onUpdated={() => void loadBills()}
      />
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            {t('bills.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {t('bills.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setFormDocType('quotation');
              setFormPartyId(null);
              setFormOpen(true);
            }}
            className="h-11 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
          >
            <IconFileInvoice size={18} stroke={2} />
            <span>{t('bills.newQuotation')}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setFormDocType(business?.gst_registered ? 'tax_invoice' : 'bill_of_supply');
              setFormPartyId(null);
              setFormOpen(true);
            }}
            className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
          >
            <IconPlus size={18} stroke={2.5} />
            <span>{t('bills.newBill')}</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('bills.todaySales')}
          </p>
          <p className="mt-1.5 text-lg sm:text-2xl font-semibold tabular-nums">
            {formatINR(Number(summary?.today_sales ?? 0))}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('bills.todayNetSales')}
          </p>
          <p className="mt-1.5 text-lg sm:text-2xl font-semibold tabular-nums text-[var(--receive-text)]">
            {formatINR(Number(summary?.today_net_sales ?? 0))}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('bills.unpaidBills')} ({summary?.unpaid_bills_count ?? 0})
          </p>
          <p className="mt-1.5 text-lg sm:text-2xl font-semibold tabular-nums text-[var(--give)]">
            {formatINR(Number(summary?.total_unpaid_amount ?? 0))}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('bills.openQuotations')}
          </p>
          <p className="mt-1.5 text-lg sm:text-2xl font-semibold tabular-nums">
            {summary?.open_quotations_count ?? 0}
          </p>
        </div>
      </section>

      {errorMsg && (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] flex items-center justify-between gap-4 text-xs sm:text-sm text-[var(--give)]">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => void loadBills()}
            className="h-9 px-3 rounded-lg border border-[var(--give)]/40 bg-[var(--surface)] text-xs font-medium text-[var(--text)] inline-flex items-center gap-1"
          >
            <IconRefresh size={14} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      )}

      {/* Search & Filter Tabs */}
      <div className="space-y-3">
        <div className="relative">
          <IconSearch
            size={18}
            stroke={2}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('bills.searchPlaceholder')}
            className="w-full h-11 pl-10 pr-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'all', label: t('bills.all') },
              { id: 'invoices', label: t('bills.invoices') },
              { id: 'quotations', label: t('bills.quotations') },
              { id: 'credit_notes', label: t('bills.creditNotes') },
              { id: 'unpaid', label: t('bills.unpaid') },
              { id: 'drafts', label: t('bills.drafts') },
              { id: 'voided', label: t('bills.voided') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterTab(tab.id)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${
                filterTab === tab.id
                  ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Document List */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        {loading && bills.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--text-muted)]">
            {t('common.loading')}
          </div>
        ) : filteredBills.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <IconReceipt
              size={32}
              stroke={1.6}
              className="mx-auto text-[var(--text-muted)]"
            />
            <p className="text-base font-semibold">{t('bills.emptyTitle')}</p>
            <p className="text-xs sm:text-sm text-[var(--text-muted)] max-w-md mx-auto">
              {t('bills.emptyDesc')}
            </p>
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    <th className="py-3 px-4 font-medium">Number / Type</th>
                    <th className="py-3 px-4 font-medium">Party</th>
                    <th className="py-3 px-4 font-medium">Date</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Total</th>
                    <th className="py-3 px-4 font-medium text-right">Due</th>
                    <th className="py-3 px-3 w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredBills.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => setSelectedBillId(b.id)}
                      className="cursor-pointer hover:bg-[var(--surface-muted)] transition-colors"
                    >
                      <td className="py-3 px-4">
                        <p className="font-mono font-semibold text-sm">
                          {b.bill_number || 'DRAFT'}
                        </p>
                        <p className="text-xs text-[var(--text-muted)]">
                          {b.doc_type === 'tax_invoice'
                            ? t('bills.taxInvoice')
                            : b.doc_type === 'bill_of_supply'
                              ? t('bills.billOfSupply')
                              : b.doc_type === 'quotation'
                                ? t('bills.quotation')
                                : t('bills.creditNote')}
                          {b.line_count ? ` · ${b.line_count} items` : ''}
                        </p>
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-medium">{b.party_name}</p>
                        {b.party_phone && (
                          <p className="text-xs text-[var(--text-muted)] tabular-nums">
                            {b.party_phone}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap tabular-nums text-xs text-[var(--text-muted)]">
                        {formatDate(b.bill_date)}
                      </td>
                      <td className="py-3 px-4 text-xs font-semibold">
                        <span
                          className={
                            b.status === 'voided'
                              ? 'text-[var(--give)]'
                              : b.payment_status === 'paid' || b.status === 'converted'
                                ? 'text-[var(--receive-text)]'
                                : 'text-[var(--text-muted)]'
                          }
                        >
                          {t(`bills.statuses.${b.payment_status}`)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-semibold tabular-nums whitespace-nowrap">
                        {formatINR(Number(b.grand_total))}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums whitespace-nowrap">
                        {Number(b.balance_due) > 0 ? (
                          <span className="font-semibold text-[var(--give)]">
                            {formatINR(Number(b.balance_due))}
                          </span>
                        ) : (
                          <span className="text-[var(--text-muted)]">—</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right text-[var(--text-muted)]">
                        <IconChevronRight size={17} stroke={2} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-[var(--border)]">
              {filteredBills.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelectedBillId(b.id)}
                  className="w-full p-4 flex items-center justify-between gap-3 text-left hover:bg-[var(--surface-muted)]"
                >
                  <div className="min-w-0">
                    <p className="font-mono font-semibold text-sm truncate">
                      {b.bill_number || 'DRAFT'} ·{' '}
                      <span className="font-sans font-normal text-[var(--text-muted)]">
                        {b.party_name}
                      </span>
                    </p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                      {formatDate(b.bill_date)} · {t(`bills.statuses.${b.payment_status}`)}
                    </p>
                  </div>
                  <div className="text-right shrink-0 tabular-nums">
                    <p className="text-sm font-semibold">
                      {formatINR(Number(b.grand_total))}
                    </p>
                    {Number(b.balance_due) > 0 && (
                      <p className="text-[11px] font-medium text-[var(--give)]">
                        Due: {formatINR(Number(b.balance_due))}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <BillFormModal
        open={formOpen}
        defaultDocType={formDocType}
        defaultPartyId={formPartyId}
        onClose={() => setFormOpen(false)}
        onSaved={(saved) => {
          void loadBills();
          setSelectedBillId(saved.id);
        }}
      />
    </div>
  );
}
