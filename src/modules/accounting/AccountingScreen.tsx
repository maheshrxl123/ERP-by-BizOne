import {
  IconBook,
  IconBuildingBank,
  IconCheck,
  IconPlus,
  IconRefresh,
  IconScale,
  IconTrash,
  IconWand,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR, todayLocalIso } from '../../core/format';
import { supabase } from '../../core/supabase';
import type {
  AccountGroupRecord,
  BankReconciliationRow,
  FinancialStatementsResult,
  LedgerAccountRecord,
  VoucherRecord,
} from '../../types/bizone';

type AccountingTab = 'vouchers' | 'ledgers' | 'statements' | 'reconciliation' | 'migration';

interface VoucherLineDraft {
  ledger_id: string;
  entry_side: 'debit' | 'credit';
  amount: string;
  line_narration: string;
}

export function AccountingScreen() {
  const { profile, language, showToast } = useApp();
  const canEdit = ['owner', 'manager', 'accountant'].includes(profile?.role ?? '');
  const canVoidOrMigrate = ['owner', 'accountant'].includes(profile?.role ?? '');

  const [tab, setTab] = useState<AccountingTab>('vouchers');
  const [groups, setGroups] = useState<AccountGroupRecord[]>([]);
  const [ledgers, setLedgers] = useState<LedgerAccountRecord[]>([]);
  const [vouchers, setVouchers] = useState<VoucherRecord[]>([]);
  const [bankRows, setBankRows] = useState<BankReconciliationRow[]>([]);
  const [statements, setStatements] = useState<FinancialStatementsResult | null>(null);
  const [migrationPreview, setMigrationPreview] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);

  const [fromDate, setFromDate] = useState(() => `${todayLocalIso().slice(0, 7)}-01`);
  const [toDate, setToDate] = useState(() => todayLocalIso());

  // New Voucher state
  const [voucherType, setVoucherType] = useState<'journal' | 'contra' | 'receipt' | 'payment'>('journal');
  const [voucherDate, setVoucherDate] = useState(() => todayLocalIso());
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<VoucherLineDraft[]>([
    { ledger_id: '', entry_side: 'debit', amount: '', line_narration: '' },
    { ledger_id: '', entry_side: 'credit', amount: '', line_narration: '' },
  ]);
  const [postingVoucher, setPostingVoucher] = useState(false);

  // New Ledger state
  const [newLedgerCode, setNewLedgerCode] = useState('');
  const [newLedgerName, setNewLedgerName] = useState('');
  const [newLedgerGroupId, setNewLedgerGroupId] = useState('');
  const [newLedgerOpBal, setNewLedgerOpBal] = useState('0');
  const [newLedgerSide, setNewLedgerSide] = useState<'debit' | 'credit'>('debit');
  const [newLedgerIsBank, setNewLedgerIsBank] = useState(false);

  // New Bank Statement row
  const [bankLedgerId, setBankLedgerId] = useState('');
  const [stmtDate, setStmtDate] = useState(() => todayLocalIso());
  const [stmtDesc, setStmtDesc] = useState('');
  const [stmtRef, setStmtRef] = useState('');
  const [stmtSide, setStmtSide] = useState<'debit' | 'credit'>('credit');
  const [stmtAmount, setStmtAmount] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [grpRes, ledRes, vchRes, bankRes, stmtRes] = await Promise.all([
        supabase.from('account_groups').select('*').order('code'),
        supabase.from('ledgers').select('*').order('code'),
        supabase.from('vouchers').select('*').order('voucher_date', { ascending: false }).limit(50),
        supabase.from('bank_reconciliations').select('*').order('statement_date', { ascending: false }).limit(50),
        supabase.rpc('get_financial_statements', {
          p_from_date: fromDate,
          p_to_date: toDate,
        }),
      ]);

      const grpRows = (grpRes.data as AccountGroupRecord[] | null) ?? [];
      const ledRows = (ledRes.data as LedgerAccountRecord[] | null) ?? [];
      setGroups(grpRows);
      setLedgers(ledRows);
      setVouchers((vchRes.data as VoucherRecord[] | null) ?? []);
      setBankRows((bankRes.data as BankReconciliationRow[] | null) ?? []);
      if (!stmtRes.error && stmtRes.data) {
        setStatements(stmtRes.data as FinancialStatementsResult);
      }
      if (grpRows.length > 0) {
        setNewLedgerGroupId((prev) => prev || grpRows[0].id);
      }
      const firstBank = ledRows.find((l) => l.is_bank);
      if (firstBank) {
        setBankLedgerId((prev) => prev || firstBank.id);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to load accounting books.', 'error');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, showToast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const drTotal = lines
    .filter((l) => l.entry_side === 'debit')
    .reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
  const crTotal = lines
    .filter((l) => l.entry_side === 'credit')
    .reduce((acc, l) => acc + (Number(l.amount) || 0), 0);
  const isBalanced = drTotal > 0 && Math.abs(drTotal - crTotal) < 0.01;

  const handlePostVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    if (!isBalanced) {
      showToast('Debit total must equal Credit total before posting.', 'error');
      return;
    }
    const cleanEntries = lines
      .filter((l) => l.ledger_id && Number(l.amount) > 0)
      .map((l) => ({
        ledger_id: l.ledger_id,
        entry_side: l.entry_side,
        amount: Number(l.amount),
        line_narration: l.line_narration.trim() || null,
      }));
    if (cleanEntries.length < 2) {
      showToast('Select ledgers and amounts for at least two lines.', 'error');
      return;
    }
    setPostingVoucher(true);
    try {
      const { error } = await supabase.rpc('create_accounting_voucher', {
        p_voucher_type: voucherType,
        p_voucher_date: voucherDate,
        p_narration: narration.trim() || null,
        p_entries: cleanEntries,
        p_cost_centre_id: null,
      });
      if (error) throw error;
      showToast('Balanced voucher posted.', 'success');
      setNarration('');
      setLines([
        { ledger_id: '', entry_side: 'debit', amount: '', line_narration: '' },
        { ledger_id: '', entry_side: 'credit', amount: '', line_narration: '' },
      ]);
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to post voucher.', 'error');
    } finally {
      setPostingVoucher(false);
    }
  };

  const handleVoidVoucher = async (id: string) => {
    if (!canVoidOrMigrate) return;
    const { error } = await supabase.rpc('void_accounting_voucher', {
      p_voucher_id: id,
      p_reason: 'Reversed by Accountant/Owner',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast('Voucher voided.', 'info');
    await loadAll();
  };

  const handleCreateLedger = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !newLedgerName.trim() || !newLedgerCode.trim() || !newLedgerGroupId) return;
    const { error } = await supabase.from('ledgers').insert({
      code: newLedgerCode.trim().toUpperCase(),
      name: newLedgerName.trim(),
      group_id: newLedgerGroupId,
      opening_balance: Number(newLedgerOpBal || 0),
      opening_side: newLedgerSide,
      is_bank: newLedgerIsBank,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast('Ledger account created.', 'success');
    setNewLedgerCode('');
    setNewLedgerName('');
    setNewLedgerOpBal('0');
    await loadAll();
  };

  const handleAddBankRow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !bankLedgerId || !stmtDesc.trim() || Number(stmtAmount) <= 0) return;
    const { error } = await supabase.from('bank_reconciliations').insert({
      ledger_id: bankLedgerId,
      statement_date: stmtDate,
      bank_reference: stmtRef.trim() || null,
      description: stmtDesc.trim(),
      entry_side: stmtSide,
      amount: Number(stmtAmount),
      status: 'unmatched',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setStmtDesc('');
    setStmtRef('');
    setStmtAmount('');
    await loadAll();
  };

  const handleMarkReconciled = async (rowId: string, voucherId: string | null) => {
    if (!canEdit) return;
    const { error } = await supabase
      .from('bank_reconciliations')
      .update({
        matched_voucher_id: voucherId,
        status: voucherId ? 'reconciled' : 'unmatched',
      })
      .eq('id', rowId);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  const handlePreviewMigration = async () => {
    const { data, error } = await supabase.rpc('preview_accounting_migration');
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setMigrationPreview(data as Record<string, number>);
  };

  const handleRunMigration = async () => {
    if (!canVoidOrMigrate) return;
    const { data, error } = await supabase.rpc('initialize_accounting_from_existing', {
      p_as_of_date: todayLocalIso(),
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    const res = data as { initialized?: boolean; voucher_number?: string; message?: string };
    showToast(
      res.initialized
        ? `Opening balance voucher ${res.voucher_number} created.`
        : res.message || 'No non-zero opening balances found.',
      res.initialized ? 'success' : 'info'
    );
    await loadAll();
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconBook size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>
              {language === 'hi' ? 'डबल-एंट्री अकाउंटिंग (टैली शैली)' : 'Double-Entry Accounting'}
            </span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Chart of accounts, balanced Dr=Cr vouchers, Trial Balance, P&L, Balance Sheet & bank reconciliation.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            aria-label="From date"
            className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            aria-label="To date"
            className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
          />
          <button
            type="button"
            onClick={() => void loadAll()}
            className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1"
          >
            <IconRefresh size={14} stroke={2} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-[var(--border)] pb-2">
        {(
          [
            { key: 'vouchers', label: 'Vouchers', icon: IconBook },
            { key: 'ledgers', label: 'Ledgers & Groups', icon: IconScale },
            { key: 'statements', label: 'Trial Balance & Statements', icon: IconScale },
            { key: 'reconciliation', label: 'Bank Reconciliation', icon: IconBuildingBank },
            { key: 'migration', label: 'Opening Migration', icon: IconWand },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`h-10 px-4 rounded-lg text-sm font-medium inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
                tab === item.key
                  ? 'bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
              }`}
            >
              <Icon size={16} stroke={2} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Vouchers */}
      {tab === 'vouchers' && (
        <div className="space-y-6">
          {canEdit && (
            <form
              onSubmit={handlePostVoucher}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Post Double-Entry Voucher</h2>
                <span
                  className={`text-xs font-mono tabular-nums ${
                    isBalanced ? 'text-[var(--receive-text)]' : 'text-[var(--give)]'
                  }`}
                >
                  Dr {formatINR(drTotal)} · Cr {formatINR(crTotal)} ·{' '}
                  {isBalanced ? 'Balanced' : 'Out of balance'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    Voucher Type
                  </label>
                  <select
                    value={voucherType}
                    onChange={(e) =>
                      setVoucherType(e.target.value as 'journal' | 'contra' | 'receipt' | 'payment')
                    }
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  >
                    <option value="journal">Journal</option>
                    <option value="contra">Contra (Cash / Bank)</option>
                    <option value="receipt">Receipt</option>
                    <option value="payment">Payment</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    Date
                  </label>
                  <input
                    type="date"
                    value={voucherDate}
                    onChange={(e) => setVoucherDate(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    Narration
                  </label>
                  <input
                    type="text"
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    placeholder="e.g. Cash deposited in bank"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                </div>
              </div>

              <div className="space-y-2">
                {lines.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                    <select
                      value={line.entry_side}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((x, i) =>
                            i === idx
                              ? { ...x, entry_side: e.target.value as 'debit' | 'credit' }
                              : x
                          )
                        )
                      }
                      className="sm:col-span-2 h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    >
                      <option value="debit">Dr (Debit)</option>
                      <option value="credit">Cr (Credit)</option>
                    </select>
                    <select
                      value={line.ledger_id}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, ledger_id: e.target.value } : x))
                        )
                      }
                      className="sm:col-span-5 h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    >
                      <option value="">Select Ledger...</option>
                      {ledgers.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.code} — {l.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.amount}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x))
                        )
                      }
                      placeholder="Amount"
                      className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                    />
                    <input
                      type="text"
                      value={line.line_narration}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, line_narration: e.target.value } : x
                          )
                        )
                      }
                      placeholder="Line note"
                      className="sm:col-span-2 h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    />
                    <button
                      type="button"
                      disabled={lines.length <= 2}
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                      aria-label="Remove line"
                      className="sm:col-span-1 h-10 rounded-lg border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] disabled:opacity-40"
                    >
                      <IconTrash size={15} stroke={2} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  onClick={() =>
                    setLines((prev) => [
                      ...prev,
                      { ledger_id: '', entry_side: 'debit', amount: '', line_narration: '' },
                    ])
                  }
                  className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1"
                >
                  <IconPlus size={14} stroke={2} />
                  <span>Add Line</span>
                </button>
                <button
                  type="submit"
                  disabled={postingVoucher || !isBalanced}
                  className="h-10 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold disabled:opacity-50"
                >
                  {postingVoucher ? 'Posting...' : 'Post Voucher'}
                </button>
              </div>
            </form>
          )}

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between">
              <h2 className="text-sm font-semibold">Voucher Register</h2>
              <span className="text-xs text-[var(--text-muted)] tabular-nums">
                {vouchers.length} voucher(s)
              </span>
            </div>
            {loading ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">Loading vouchers...</div>
            ) : vouchers.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">
                No vouchers posted yet. Post a voucher above or run Opening Migration.
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {vouchers.map((v) => (
                  <div
                    key={v.id}
                    className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-sm"
                  >
                    <div>
                      <div className="font-semibold">
                        {v.voucher_number}{' '}
                        <span className="text-xs font-normal uppercase text-[var(--text-muted)]">
                          · {v.voucher_type} · {v.status}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {formatDate(v.voucher_date)}
                        {v.narration ? ` · ${v.narration}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right tabular-nums font-semibold">
                        {formatINR(Number(v.total_debit))}
                      </div>
                      {v.status === 'posted' && canVoidOrMigrate && (
                        <button
                          type="button"
                          onClick={() => void handleVoidVoucher(v.id)}
                          className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs text-[var(--give)] hover:bg-[var(--give-soft)]"
                        >
                          Void
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Ledgers Tab */}
      {tab === 'ledgers' && (
        <div className="space-y-6">
          {canEdit && (
            <form
              onSubmit={handleCreateLedger}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
            >
              <h2 className="text-base font-semibold">Create Custom Ledger Account</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <input
                  type="text"
                  required
                  value={newLedgerCode}
                  onChange={(e) => setNewLedgerCode(e.target.value)}
                  placeholder="Code (e.g. HDFC_OD)"
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                />
                <input
                  type="text"
                  required
                  value={newLedgerName}
                  onChange={(e) => setNewLedgerName(e.target.value)}
                  placeholder="Ledger Name"
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
                <select
                  value={newLedgerGroupId}
                  onChange={(e) => setNewLedgerGroupId(e.target.value)}
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.nature})
                    </option>
                  ))}
                </select>
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={newLedgerOpBal}
                    onChange={(e) => setNewLedgerOpBal(e.target.value)}
                    placeholder="Opening"
                    className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                  <select
                    value={newLedgerSide}
                    onChange={(e) => setNewLedgerSide(e.target.value as 'debit' | 'credit')}
                    className="h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    <option value="debit">Dr</option>
                    <option value="credit">Cr</option>
                  </select>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={newLedgerIsBank}
                      onChange={(e) => setNewLedgerIsBank(e.target.checked)}
                      className="w-4 h-4 accent-[var(--primary-dark)]"
                    />
                    <span>Bank</span>
                  </label>
                  <button
                    type="submit"
                    className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold whitespace-nowrap shrink-0"
                  >
                    Add Ledger
                  </button>
                </div>
              </div>
            </form>
          )}

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-left text-xs text-[var(--text-muted)]">
                  <th className="py-2.5 px-4">Code</th>
                  <th className="py-2.5 px-4">Ledger Name</th>
                  <th className="py-2.5 px-4">Group</th>
                  <th className="py-2.5 px-4 text-right">Opening Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {ledgers.map((l) => {
                  const grp = groups.find((g) => g.id === l.group_id);
                  return (
                    <tr key={l.id}>
                      <td className="py-2.5 px-4 font-mono text-xs">{l.code}</td>
                      <td className="py-2.5 px-4 font-medium">
                        {l.name}
                        {l.is_bank ? ' · Bank' : ''}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-[var(--text-muted)]">
                        {grp ? `${grp.name} (${grp.nature})` : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {formatINR(Number(l.opening_balance || 0))}{' '}
                        {l.opening_side === 'debit' ? 'Dr' : 'Cr'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {/* Trial Balance & Financial Statements */}
      {tab === 'statements' && statements && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="text-xs text-[var(--text-muted)]">Trial Balance Check</div>
              <div className="text-lg font-semibold tabular-nums mt-1">
                Dr {formatINR(statements.trial_balance.total_debit)}
              </div>
              <div
                className={`text-xs mt-0.5 tabular-nums ${
                  statements.trial_balance.is_balanced
                    ? 'text-[var(--receive-text)]'
                    : 'text-[var(--give)]'
                }`}
              >
                Cr {formatINR(statements.trial_balance.total_credit)} ·{' '}
                {statements.trial_balance.is_balanced ? 'Balanced' : 'Mismatch'}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="text-xs text-[var(--text-muted)]">Profit & Loss (Period)</div>
              <div className="text-lg font-semibold tabular-nums mt-1">
                {formatINR(statements.profit_and_loss.net_profit)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                Income {formatINR(statements.profit_and_loss.total_income)} · Expense{' '}
                {formatINR(statements.profit_and_loss.total_expense)}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="text-xs text-[var(--text-muted)]">Balance Sheet Position</div>
              <div className="text-lg font-semibold tabular-nums mt-1">
                Assets {formatINR(statements.balance_sheet.total_assets)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                Liabilities + Equity{' '}
                {formatINR(
                  statements.balance_sheet.total_liabilities +
                    statements.balance_sheet.total_equity_with_profit
                )}{' '}
                (Diff {formatINR(statements.balance_sheet.difference)})
              </div>
            </div>
          </div>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-left text-xs text-[var(--text-muted)]">
                  <th className="py-2.5 px-4">Ledger</th>
                  <th className="py-2.5 px-4">Group / Nature</th>
                  <th className="py-2.5 px-4 text-right">Closing Dr</th>
                  <th className="py-2.5 px-4 text-right">Closing Cr</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {statements.trial_balance.rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 px-4 text-center text-[var(--text-muted)]">
                      No non-zero ledger balances in this period.
                    </td>
                  </tr>
                ) : (
                  statements.trial_balance.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2.5 px-4 font-medium">
                        <span className="font-mono text-xs text-[var(--text-muted)] mr-2">
                          {r.code}
                        </span>
                        {r.name}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-[var(--text-muted)]">
                        {r.group_name} ({r.nature})
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {r.closing_dr > 0 ? formatINR(r.closing_dr) : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {r.closing_cr > 0 ? formatINR(r.closing_cr) : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {/* Bank Reconciliation */}
      {tab === 'reconciliation' && (
        <div className="space-y-6">
          {canEdit && (
            <form
              onSubmit={handleAddBankRow}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
            >
              <h2 className="text-base font-semibold">Add Bank Statement Entry</h2>
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5">
                <select
                  value={bankLedgerId}
                  onChange={(e) => setBankLedgerId(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {ledgers
                    .filter((l) => l.is_bank)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
                <input
                  type="date"
                  value={stmtDate}
                  onChange={(e) => setStmtDate(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
                <input
                  type="text"
                  required
                  value={stmtDesc}
                  onChange={(e) => setStmtDesc(e.target.value)}
                  placeholder="Bank narration"
                  className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
                <input
                  type="text"
                  value={stmtRef}
                  onChange={(e) => setStmtRef(e.target.value)}
                  placeholder="UTR / Ref #"
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                />
                <div className="flex gap-1.5">
                  <select
                    value={stmtSide}
                    onChange={(e) => setStmtSide(e.target.value as 'debit' | 'credit')}
                    className="h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    <option value="credit">Deposit</option>
                    <option value="debit">Withdrawal</option>
                  </select>
                  <input
                    type="number"
                    min={0.01}
                    step="0.01"
                    required
                    value={stmtAmount}
                    onChange={(e) => setStmtAmount(e.target.value)}
                    placeholder="Amt"
                    className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
                >
                  Add Statement Entry
                </button>
              </div>
            </form>
          )}

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {bankRows.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">
                No bank statement lines recorded yet.
              </div>
            ) : (
              bankRows.map((row) => (
                <div
                  key={row.id}
                  className="p-4 flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <div>
                    <div className="font-medium">{row.description}</div>
                    <div className="text-xs text-[var(--text-muted)] tabular-nums">
                      {formatDate(row.statement_date)}
                      {row.bank_reference ? ` · Ref ${row.bank_reference}` : ''} ·{' '}
                      {row.entry_side === 'credit' ? 'Deposit' : 'Withdrawal'}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold tabular-nums">
                      {formatINR(Number(row.amount))}
                    </span>
                    <select
                      value={row.matched_voucher_id || ''}
                      disabled={!canEdit}
                      onChange={(e) =>
                        void handleMarkReconciled(row.id, e.target.value || null)
                      }
                      className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      <option value="">Unmatched</option>
                      {vouchers
                        .filter((v) => v.status === 'posted')
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.voucher_number} ({formatINR(Number(v.total_debit))})
                          </option>
                        ))}
                    </select>
                    {row.status === 'reconciled' && (
                      <IconCheck size={16} stroke={2.5} className="text-[var(--receive-text)]" />
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      {/* Guided Opening Balance Migration */}
      {tab === 'migration' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Guided Opening Balance Migration</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Computes live receivables, payables, stock valuation, cash, and bank balances from your operational BizOne books and prepares a balanced opening Journal Voucher.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handlePreviewMigration()}
              className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-semibold hover:bg-[var(--surface-muted)]"
            >
              Preview Balances
            </button>
            {canVoidOrMigrate && (
              <button
                type="button"
                onClick={() => void handleRunMigration()}
                className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Post Opening Journal Voucher
              </button>
            )}
          </div>

          {migrationPreview && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-3 border-t border-[var(--border)]">
              {[
                { label: 'Receivables', value: formatINR(Number(migrationPreview.receivables || 0)) },
                { label: 'Payables', value: formatINR(Number(migrationPreview.payables || 0)) },
                { label: 'Inventory', value: formatINR(Number(migrationPreview.inventory_value || 0)) },
                { label: 'Cash', value: formatINR(Number(migrationPreview.cash_balance || 0)) },
                { label: 'Bank', value: formatINR(Number(migrationPreview.bank_balance || 0)) },
              ].map((card) => (
                <div
                  key={card.label}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3"
                >
                  <div className="text-xs text-[var(--text-muted)]">{card.label}</div>
                  <div className="text-sm font-semibold tabular-nums mt-0.5">{card.value}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
