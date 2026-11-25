import {
  IconBan,
  IconEdit,
  IconPaperclip,
  IconPlus,
  IconReceipt2,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { erpFetch } from '../../core/erpFetch';
import { supabase } from '../../core/supabase';
import type {
  ExpenseCategoryRecord,
  ExpenseRecord,
  ExpenseSummary,
} from '../../types/decorbiz';
import { ExpenseFormModal } from './ExpenseFormModal';

interface ExpensesScreenProps {
  initialAction?: 'add-expense' | null;
  onActionConsumed?: () => void;
}

export function ExpensesScreen({
  initialAction,
  onActionConsumed,
}: ExpensesScreenProps) {
  const { profile, session, language, showToast, t } = useApp();

  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [categories, setCategories] = useState<ExpenseCategoryRecord[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'all' | 'posted' | 'voided'>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseRecord | null>(null);
  const [voidTarget, setVoidTarget] = useState<ExpenseRecord | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  const canVoid = ['owner', 'manager', 'accountant'].includes(profile?.role ?? '');

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sumRes, catRes, listRes] = await Promise.all([
        supabase.from('expense_summary_view').select('*').maybeSingle(),
        supabase.from('expense_categories').select('*').eq('is_active', true).order('name_en'),
        supabase
          .from('expense_list_view')
          .select('*')
          .order('expense_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      if (sumRes.error) throw sumRes.error;
      if (catRes.error) throw catRes.error;
      if (listRes.error) throw listRes.error;

      setSummary((sumRes.data as ExpenseSummary | null) ?? null);
      setCategories((catRes.data as ExpenseCategoryRecord[] | null) ?? []);
      setExpenses((listRes.data as ExpenseRecord[] | null) ?? []);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load expenses.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (initialAction === 'add-expense') {
      setEditingExpense(null);
      setShowModal(true);
      onActionConsumed?.();
    }
  }, [initialAction, onActionConsumed]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return expenses.filter((ex) => {
      if (statusFilter !== 'all' && ex.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && ex.category_id !== categoryFilter) return false;
      if (!q) return true;
      return (
        ex.expense_number.toLowerCase().includes(q) ||
        ex.category_name_en.toLowerCase().includes(q) ||
        ex.category_name_hi.toLowerCase().includes(q) ||
        (ex.paid_to ?? '').toLowerCase().includes(q) ||
        (ex.notes ?? '').toLowerCase().includes(q)
      );
    });
  }, [expenses, statusFilter, categoryFilter, searchQuery]);

  const handleOpenAttachment = async (fileId: string) => {
    if (!session?.access_token) return;
    try {
      const res = await erpFetch('/api/erp/files/signed-url', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      });
      const json = await res.json();
      if (!res.ok || !json.signedUrl) {
        throw new Error(json?.error || 'Unable to load receipt.');
      }
      const a = document.createElement('a');
      a.href = json.signedUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Cannot open attachment.', 'error');
    }
  };

  const handleConfirmVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidTarget) return;
    if (voidReason.trim().length < 3) {
      showToast('Enter a void reason (min 3 characters).', 'error');
      return;
    }
    setVoiding(true);
    try {
      const { error } = await supabase.rpc('void_expense', {
        p_expense_id: voidTarget.id,
        p_reason: voidReason.trim(),
      });
      if (error) throw error;
      showToast(`Expense ${voidTarget.expense_number} voided.`, 'success');
      setVoidTarget(null);
      setVoidReason('');
      void loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Void failed.', 'error');
    } finally {
      setVoiding(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            {t('expenses.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {t('expenses.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData()}
            aria-label="Refresh expenses"
            className="h-10 w-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <IconRefresh size={17} stroke={2} />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingExpense(null);
              setShowModal(true);
            }}
            className="h-10 px-4 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-slate-950 font-semibold text-sm inline-flex items-center gap-1.5"
          >
            <IconPlus size={17} stroke={2.5} />
            <span>{t('expenses.addExpense')}</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="text-xs text-[var(--text-muted)]">{t('expenses.todayExpenses')}</div>
          <div className="text-xl font-bold mt-1 tabular-nums text-[var(--give)]">
            {formatINR(summary?.today_expenses ?? 0)}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="text-xs text-[var(--text-muted)]">{t('expenses.monthExpenses')}</div>
          <div className="text-xl font-bold mt-1 tabular-nums">
            {formatINR(summary?.month_expenses ?? 0)}
          </div>
        </div>
        <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="text-xs text-[var(--text-muted)]">{t('expenses.cashToday')}</div>
          <div className="text-xl font-bold mt-1 tabular-nums">
            {formatINR(summary?.today_cash_expenses ?? 0)}
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'posted', 'voided'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`h-9 px-3 rounded-lg text-xs font-medium border ${
                statusFilter === st
                  ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
              }`}
            >
              {t(`expenses.${st}`)}
            </button>
          ))}

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
          >
            <option value="all">All Categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {language === 'hi' ? c.name_hi : c.name_en}
              </option>
            ))}
          </select>
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
            placeholder={t('expenses.searchPlaceholder')}
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
          <IconReceipt2 size={36} stroke={1.6} className="mx-auto text-[var(--text-muted)]" />
          <h3 className="text-base font-semibold">{t('expenses.emptyTitle')}</h3>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] max-w-md mx-auto">
            {t('expenses.emptyDesc')}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
          <table className="w-full text-xs sm:text-sm border-collapse min-w-[680px]">
            <thead>
              <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                <th className="text-left px-4 py-2.5 font-medium">Voucher #</th>
                <th className="text-left px-4 py-2.5 font-medium">Date</th>
                <th className="text-left px-4 py-2.5 font-medium">Category</th>
                <th className="text-left px-4 py-2.5 font-medium">Paid To / Notes</th>
                <th className="text-left px-4 py-2.5 font-medium">Mode</th>
                <th className="text-right px-4 py-2.5 font-medium">Amount</th>
                <th className="text-right px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ex) => (
                <tr
                  key={ex.id}
                  className={`border-b border-[var(--border)] last:border-b-0 ${
                    ex.status === 'voided' ? 'opacity-60' : 'hover:bg-[var(--surface-muted)]/40'
                  }`}
                >
                  <td className="px-4 py-3 font-medium">
                    <span className={ex.status === 'voided' ? 'line-through' : ''}>
                      {ex.expense_number}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-[var(--text-muted)]">
                    {formatDate(ex.expense_date)}
                  </td>
                  <td className="px-4 py-3">
                    {language === 'hi' ? ex.category_name_hi : ex.category_name_en}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{ex.paid_to || '—'}</div>
                    {ex.notes && (
                      <div className="text-xs text-[var(--text-muted)] truncate max-w-xs">
                        {ex.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs uppercase text-[var(--text-muted)]">
                    {ex.payment_mode}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-[var(--give)]">
                    {formatINR(ex.amount)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      {ex.attachment_file_id && (
                        <button
                          type="button"
                          onClick={() => void handleOpenAttachment(ex.attachment_file_id!)}
                          title="View Receipt"
                          className="p-1.5 rounded-lg text-[var(--primary-dark)] hover:bg-[var(--surface-muted)]"
                        >
                          <IconPaperclip size={15} stroke={2} />
                        </button>
                      )}
                      {ex.status === 'posted' && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingExpense(ex);
                              setShowModal(true);
                            }}
                            title="Edit Expense"
                            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                          >
                            <IconEdit size={15} stroke={2} />
                          </button>
                          {canVoid && (
                            <button
                              type="button"
                              onClick={() => {
                                setVoidTarget(ex);
                                setVoidReason('');
                              }}
                              title="Void Expense"
                              className="p-1.5 rounded-lg text-[var(--give)] hover:bg-[var(--give-soft)]"
                            >
                              <IconBan size={15} stroke={2} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {voidTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center p-4"
          onClick={() => setVoidTarget(null)}
        >
          <form
            onSubmit={handleConfirmVoid}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
          >
            <h3 className="text-base font-semibold">
              {t('expenses.voidExpense')} · {voidTarget.expense_number}
            </h3>
            <p className="text-xs text-[var(--text-muted)]">
              Amount: {formatINR(voidTarget.amount)}. Voided expenses are excluded from Day Book, Cash Book, and Profit totals.
            </p>
            <input
              type="text"
              required
              minLength={3}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Reason for voiding..."
              className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setVoidTarget(null)}
                className="h-9 px-3.5 rounded-lg border border-[var(--border)] text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={voiding}
                className="h-9 px-4 rounded-lg bg-[var(--give)] text-white text-xs font-semibold"
              >
                {voiding ? 'Voiding...' : t('expenses.voidExpense')}
              </button>
            </div>
          </form>
        </div>
      )}

      <ExpenseFormModal
        open={showModal}
        editingExpense={editingExpense}
        categories={categories}
        onClose={() => {
          setShowModal(false);
          setEditingExpense(null);
        }}
        onSaved={() => void loadData()}
      />
    </div>
  );
}
