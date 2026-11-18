import {
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShoppingBag,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { supabase } from '../../core/supabase';
import type { PurchaseBillRecord, PurchaseSummary } from '../../types/bizone';
import { PurchaseDetailModal } from './PurchaseDetailModal';
import { PurchaseFormModal } from './PurchaseFormModal';

interface PurchasesScreenProps {
  initialAction?: 'new-purchase' | null;
  onActionConsumed?: () => void;
}

type PurchaseFilterTab = 'all' | 'bills' | 'returns' | 'drafts' | 'unpaid' | 'voided';

export function PurchasesScreen({
  initialAction,
  onActionConsumed,
}: PurchasesScreenProps) {
  const { language, t } = useApp();

  const [summary, setSummary] = useState<PurchaseSummary | null>(null);
  const [purchases, setPurchases] = useState<PurchaseBillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filterTab, setFilterTab] = useState<PurchaseFilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [showFormModal, setShowFormModal] = useState(false);
  const [editingDraft, setEditingDraft] = useState<PurchaseBillRecord | null>(null);
  const [selectedPurchase, setSelectedPurchase] = useState<PurchaseBillRecord | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sumRes, listRes] = await Promise.all([
        supabase.from('purchase_summary_view').select('*').maybeSingle(),
        supabase
          .from('purchase_list_view')
          .select('*')
          .order('bill_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      if (sumRes.error) throw sumRes.error;
      if (listRes.error) throw listRes.error;

      setSummary((sumRes.data as PurchaseSummary | null) ?? null);
      setPurchases((listRes.data as PurchaseBillRecord[] | null) ?? []);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load purchases.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (initialAction === 'new-purchase') {
      setEditingDraft(null);
      setShowFormModal(true);
      onActionConsumed?.();
    }
  }, [initialAction, onActionConsumed]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return purchases.filter((pb) => {
      if (filterTab === 'bills' && (pb.doc_type !== 'purchase_bill' || pb.status !== 'posted')) {
        return false;
      }
      if (filterTab === 'returns' && pb.doc_type !== 'purchase_return') return false;
      if (filterTab === 'drafts' && pb.status !== 'draft') return false;
      if (filterTab === 'unpaid' && (pb.status !== 'posted' || pb.balance_due <= 0)) {
        return false;
      }
      if (filterTab === 'voided' && pb.status !== 'voided') return false;

      if (!q) return true;
      return (
        (pb.purchase_number ?? '').toLowerCase().includes(q) ||
        (pb.supplier_invoice_no ?? '').toLowerCase().includes(q) ||
        pb.party_name.toLowerCase().includes(q) ||
        (pb.party_phone ?? '').toLowerCase().includes(q)
      );
    });
  }, [purchases, filterTab, searchQuery]);

  const statusBadge = (pb: PurchaseBillRecord) => {
    if (pb.status === 'voided') {
      return 'bg-[var(--surface-muted)] text-[var(--text-muted)] line-through';
    }
    if (pb.status === 'draft') {
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    }
    if (pb.doc_type === 'purchase_return') {
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-300';
    }
    if (pb.payment_status === 'paid') {
      return 'bg-[var(--receive-soft)] text-[var(--receive-text)]';
    }
    return 'bg-[var(--give-soft)] text-[var(--give)]';
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            {t('purchases.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {t('purchases.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData()}
            aria-label="Refresh purchases"
            className="h-10 w-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <IconRefresh size={17} stroke={2} />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingDraft(null);
              setShowFormModal(true);
            }}
            className="h-10 px-4 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-slate-950 font-semibold text-sm inline-flex items-center gap-1.5"
          >
            <IconPlus size={17} stroke={2.5} />
            <span>{t('purchases.newPurchase')}</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="text-xs text-[var(--text-muted)]">{t('purchases.todayPurchases')}</div>
          <div className="text-xl font-bold mt-1 tabular-nums">
            {formatINR(summary?.today_purchases ?? 0)}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="text-xs text-[var(--text-muted)]">{t('purchases.monthPurchases')}</div>
          <div className="text-xl font-bold mt-1 tabular-nums">
            {formatINR(summary?.month_purchases ?? 0)}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="text-xs text-[var(--text-muted)]">{t('purchases.unpaidPayables')}</div>
          <div className="text-xl font-bold mt-1 tabular-nums text-[var(--give)]">
            {formatINR(summary?.total_unpaid_payables ?? 0)}
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {(
            [
              ['all', t('purchases.all')],
              ['bills', t('purchases.bills')],
              ['returns', t('purchases.returns')],
              ['unpaid', t('purchases.unpaid')],
              ['drafts', t('purchases.drafts')],
              ['voided', t('purchases.voided')],
            ] as Array<[PurchaseFilterTab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilterTab(key)}
              className={`h-9 px-3 rounded-lg text-xs font-medium whitespace-nowrap border ${
                filterTab === key
                  ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <IconSearch
            size={15}
            stroke={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('purchases.searchPlaceholder')}
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm"
          />
        </div>
      </div>

      {loadError ? (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] text-sm text-[var(--give)]">
          {loadError}
        </div>
      ) : loading ? (
        <div className="p-10 text-center text-sm text-[var(--text-muted)]">
          {t('common.loading')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-center space-y-2">
          <IconShoppingBag size={36} stroke={1.6} className="mx-auto text-[var(--text-muted)]" />
          <h3 className="text-base font-semibold">{t('purchases.emptyTitle')}</h3>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] max-w-md mx-auto">
            {t('purchases.emptyDesc')}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
          <table className="w-full text-xs sm:text-sm border-collapse min-w-[680px]">
            <thead>
              <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                <th className="text-left px-4 py-2.5 font-medium">Purchase #</th>
                <th className="text-left px-4 py-2.5 font-medium">Date</th>
                <th className="text-left px-4 py-2.5 font-medium">Supplier</th>
                <th className="text-left px-4 py-2.5 font-medium">Supplier Inv #</th>
                <th className="text-right px-4 py-2.5 font-medium">Total</th>
                <th className="text-right px-4 py-2.5 font-medium">Balance Due</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((pb) => (
                <tr
                  key={pb.id}
                  onClick={() => setSelectedPurchase(pb)}
                  className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--surface-muted)]/60 cursor-pointer"
                >
                  <td className="px-4 py-3 font-medium">
                    {pb.purchase_number || (language === 'hi' ? 'ड्राफ्ट' : 'Draft')}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-[var(--text-muted)]">
                    {formatDate(pb.bill_date)}
                  </td>
                  <td className="px-4 py-3 font-medium">{pb.party_name}</td>
                  <td className="px-4 py-3 text-[var(--text-muted)]">
                    {pb.supplier_invoice_no || '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {formatINR(pb.grand_total)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--give)]">
                    {pb.balance_due > 0 ? formatINR(pb.balance_due) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium capitalize ${statusBadge(pb)}`}>
                      {pb.doc_type === 'purchase_return' ? 'Return' : pb.payment_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PurchaseFormModal
        open={showFormModal}
        editingDraft={editingDraft}
        onClose={() => {
          setShowFormModal(false);
          setEditingDraft(null);
        }}
        onSaved={() => void loadData()}
      />

      <PurchaseDetailModal
        purchase={selectedPurchase}
        onClose={() => setSelectedPurchase(null)}
        onEditDraft={(draft) => {
          setEditingDraft(draft);
          setShowFormModal(true);
        }}
        onChanged={() => void loadData()}
      />
    </div>
  );
}
