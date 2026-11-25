import {
  IconDownload,
  IconPrinter,
  IconRefresh,
  IconReportAnalytics,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { downloadCsvFile, printReportHtml } from '../../core/export';
import { formatDate, formatINR, todayLocalIso } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  AuditLogRecord,
  DayBookResult,
  GstSummaryResult,
  HsnSummaryRow,
  PartyDuesAgeingRow,
  ProfitEstimateResult,
} from '../../types/decorbiz';

type ReportTab =
  | 'dayBook'
  | 'profit'
  | 'gst'
  | 'sales'
  | 'purchases'
  | 'stock'
  | 'ageing'
  | 'audit';

function monthStartIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export function ReportsScreen() {
  const { business, profile, isModuleEnabled, t } = useApp();
  const role = profile?.role;

  const canExport = hasCapability(role, 'export_data');
  const canProfit = hasCapability(role, 'view_profit');
  const isOwner = role === 'owner';
  const isStorekeeper = role === 'storekeeper';
  const isCashier = role === 'cashier';

  const availableTabs = useMemo<Array<{ key: ReportTab; label: string }>>(() => {
    const list: Array<{ key: ReportTab; label: string }> = [];
    if (!isStorekeeper) {
      list.push({ key: 'dayBook', label: t('reports.tabs.dayBook') });
    }
    if (canProfit) {
      list.push({ key: 'profit', label: t('reports.tabs.profit') });
    }
    if (!isStorekeeper && !isCashier && isModuleEnabled('tax')) {
      list.push({ key: 'gst', label: t('reports.tabs.gst') });
    }
    if (!isStorekeeper && isModuleEnabled('billing')) {
      list.push({ key: 'sales', label: t('reports.tabs.sales') });
    }
    if (!isCashier && isModuleEnabled('purchases')) {
      list.push({ key: 'purchases', label: t('reports.tabs.purchases') });
    }
    if (isModuleEnabled('inventory')) {
      list.push({ key: 'stock', label: t('reports.tabs.stock') });
    }
    if (!isStorekeeper && !isCashier && isModuleEnabled('parties')) {
      list.push({ key: 'ageing', label: t('reports.tabs.ageing') });
    }
    if (isOwner) {
      list.push({ key: 'audit', label: t('reports.tabs.audit') });
    }
    return list;
  }, [isStorekeeper, isCashier, canProfit, isOwner, isModuleEnabled, t]);

  const [activeTab, setActiveTab] = useState<ReportTab>(
    () => availableTabs[0]?.key ?? 'stock'
  );
  const [fromDate, setFromDate] = useState(monthStartIso());
  const [toDate, setToDate] = useState(todayLocalIso());

  const [bookMode, setBookMode] = useState<'day' | 'cash' | 'bank'>('day');
  const [hsnScope, setHsnScope] = useState<'sales' | 'purchases'>('sales');
  const [salesGroup, setSalesGroup] = useState<'register' | 'item' | 'party' | 'user' | 'returns' | 'quotations'>('register');
  const [purchaseGroup, setPurchaseGroup] = useState<'register' | 'supplier' | 'item'>('register');
  const [stockView, setStockView] = useState<'summary' | 'low_stock' | 'ledger'>('summary');

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [dayBook, setDayBook] = useState<DayBookResult | null>(null);
  const [profitData, setProfitData] = useState<ProfitEstimateResult | null>(null);
  const [gstData, setGstData] = useState<GstSummaryResult | null>(null);
  const [hsnRows, setHsnRows] = useState<HsnSummaryRow[]>([]);
  const [salesRows, setSalesRows] = useState<Array<Record<string, unknown>>>([]);
  const [purchaseRows, setPurchaseRows] = useState<Array<Record<string, unknown>>>([]);
  const [stockResult, setStockResult] = useState<{
    can_view_cost: boolean;
    total_valuation: number | null;
    rows: Array<Record<string, unknown>>;
  } | null>(null);
  const [ageingRows, setAgeingRows] = useState<PartyDuesAgeingRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRecord[]>([]);

  useEffect(() => {
    if (!availableTabs.some((tb) => tb.key === activeTab) && availableTabs.length > 0) {
      setActiveTab(availableTabs[0].key);
    }
  }, [availableTabs, activeTab]);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      if (activeTab === 'dayBook') {
        const { data, error } = await supabase.rpc('get_day_book', {
          p_from_date: fromDate,
          p_to_date: toDate,
          p_book: bookMode,
        });
        if (error) throw error;
        setDayBook(data as DayBookResult);
      } else if (activeTab === 'profit') {
        const { data, error } = await supabase.rpc('get_profit_estimate', {
          p_from_date: fromDate,
          p_to_date: toDate,
        });
        if (error) throw error;
        setProfitData(data as ProfitEstimateResult);
      } else if (activeTab === 'gst') {
        const [gRes, hRes] = await Promise.all([
          supabase.rpc('get_gst_summary', {
            p_from_date: fromDate,
            p_to_date: toDate,
          }),
          supabase.rpc('get_hsn_summary', {
            p_from_date: fromDate,
            p_to_date: toDate,
            p_scope: hsnScope,
          }),
        ]);
        if (gRes.error) throw gRes.error;
        if (hRes.error) throw hRes.error;
        setGstData(gRes.data as GstSummaryResult);
        setHsnRows(((hRes.data as { rows?: HsnSummaryRow[] })?.rows) ?? []);
      } else if (activeTab === 'sales') {
        const { data, error } = await supabase.rpc('get_sales_reports', {
          p_from_date: fromDate,
          p_to_date: toDate,
          p_group_by: salesGroup,
        });
        if (error) throw error;
        setSalesRows(((data as { rows?: Array<Record<string, unknown>> })?.rows) ?? []);
      } else if (activeTab === 'purchases') {
        const { data, error } = await supabase.rpc('get_purchase_reports', {
          p_from_date: fromDate,
          p_to_date: toDate,
          p_group_by: purchaseGroup,
        });
        if (error) throw error;
        setPurchaseRows(((data as { rows?: Array<Record<string, unknown>> })?.rows) ?? []);
      } else if (activeTab === 'stock') {
        const { data, error } = await supabase.rpc('get_stock_reports', {
          p_from_date: fromDate,
          p_to_date: toDate,
          p_view: stockView,
        });
        if (error) throw error;
        setStockResult(
          data as {
            can_view_cost: boolean;
            total_valuation: number | null;
            rows: Array<Record<string, unknown>>;
          }
        );
      } else if (activeTab === 'ageing') {
        const { data, error } = await supabase.rpc('get_party_dues_ageing');
        if (error) throw error;
        setAgeingRows(((data as { rows?: PartyDuesAgeingRow[] })?.rows) ?? []);
      } else if (activeTab === 'audit') {
        const { data, error } = await supabase
          .from('audit_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(150);
        if (error) throw error;
        setAuditRows((data as AuditLogRecord[] | null) ?? []);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to load report.');
    } finally {
      setLoading(false);
    }
  }, [activeTab, fromDate, toDate, bookMode, hsnScope, salesGroup, purchaseGroup, stockView]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const buildExportTable = (): { title: string; headers: string[]; rows: Array<Array<string | number>> } | null => {
    if (activeTab === 'dayBook' && dayBook) {
      return {
        title: `${bookMode.toUpperCase()} Book (${fromDate} to ${toDate})`,
        headers: ['Date', 'Voucher #', 'Type', 'Particulars', 'Mode', 'Inflow (₹)', 'Outflow (₹)'],
        rows: dayBook.rows.map((r) => [
          r.entry_date,
          r.voucher_no,
          r.source_type,
          r.party_or_particular,
          r.payment_mode,
          r.cash_in,
          r.cash_out,
        ]),
      };
    }
    if (activeTab === 'profit' && profitData) {
      return {
        title: `Profit Estimate (${fromDate} to ${toDate})`,
        headers: ['Metric', 'Amount (₹)'],
        rows: [
          ['Gross Sales (ex-tax)', profitData.gross_sales_ex_tax],
          ['Sales Returns (ex-tax)', -profitData.sales_returns_ex_tax],
          ['Net Sales (ex-tax)', profitData.net_sales_ex_tax],
          ['Extra Charges Income', profitData.extra_charges_income],
          ['Estimated COGS', profitData.cogs_estimate],
          ['Gross Profit', profitData.gross_profit],
          ['Operating Expenses', profitData.operating_expenses],
          ['Estimated Net Profit', profitData.estimated_net_profit],
        ],
      };
    }
    if (activeTab === 'gst' && gstData) {
      return {
        title: `GST & HSN Summary (${fromDate} to ${toDate})`,
        headers: ['HSN', 'UQC', 'Rate %', 'Qty', 'Taxable (₹)', 'CGST (₹)', 'SGST (₹)', 'IGST (₹)', 'Total (₹)'],
        rows: hsnRows.map((h) => [
          h.hsn_code,
          h.uqc,
          h.gst_rate,
          h.total_qty,
          h.taxable_value,
          h.cgst_amount,
          h.sgst_amount,
          h.igst_amount,
          h.total_value,
        ]),
      };
    }
    if (activeTab === 'sales' && salesRows.length > 0) {
      const headers = Object.keys(salesRows[0]);
      return {
        title: `Sales Report - ${salesGroup} (${fromDate} to ${toDate})`,
        headers,
        rows: salesRows.map((r) => headers.map((k) => String(r[k] ?? ''))),
      };
    }
    if (activeTab === 'purchases' && purchaseRows.length > 0) {
      const headers = Object.keys(purchaseRows[0]);
      return {
        title: `Purchase Report - ${purchaseGroup} (${fromDate} to ${toDate})`,
        headers,
        rows: purchaseRows.map((r) => headers.map((k) => String(r[k] ?? ''))),
      };
    }
    if (activeTab === 'stock' && stockResult && stockResult.rows.length > 0) {
      const headers = Object.keys(stockResult.rows[0]);
      return {
        title: `Stock Report - ${stockView}`,
        headers,
        rows: stockResult.rows.map((r) => headers.map((k) => String(r[k] ?? ''))),
      };
    }
    if (activeTab === 'ageing') {
      return {
        title: `Party Dues Ageing as of ${todayLocalIso()}`,
        headers: ['Party', 'Direction', '0-30d', '31-60d', '61-90d', '90+d', 'Total Outstanding'],
        rows: ageingRows.map((a) => [
          a.party_name,
          a.direction_needed,
          a.bucket_0_30,
          a.bucket_31_60,
          a.bucket_61_90,
          a.bucket_90_plus,
          a.total_outstanding,
        ]),
      };
    }
    return null;
  };

  const handleExportCsv = () => {
    const tbl = buildExportTable();
    if (!tbl) return;
    downloadCsvFile(tbl.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), tbl.headers, tbl.rows);
  };

  const handlePrint = () => {
    const tbl = buildExportTable();
    if (!tbl) return;
    printReportHtml(tbl.title, `${fromDate} to ${toDate}`, tbl.headers, tbl.rows, business?.name);
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <IconReportAnalytics size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>{t('reports.title')}</span>
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {t('reports.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadReport()}
            aria-label="Refresh report"
            className="h-9 w-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center text-[var(--text-muted)]"
          >
            <IconRefresh size={16} stroke={2} />
          </button>
          {canExport && (
            <>
              <button
                type="button"
                onClick={handleExportCsv}
                className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
              >
                <IconDownload size={15} stroke={2} />
                <span>{t('common.exportCsv')}</span>
              </button>
              <button
                type="button"
                onClick={handlePrint}
                className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
              >
                <IconPrinter size={15} stroke={2} />
                <span>{t('common.print')}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Report Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-[var(--border)]">
        {availableTabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setActiveTab(tb.key)}
            className={`px-3 py-2 text-xs sm:text-sm font-medium rounded-t-lg whitespace-nowrap border-b-2 transition ${
              activeTab === tb.key
                ? 'border-[var(--primary-dark)] text-[var(--primary-dark)] bg-[var(--primary-soft)]/50'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Date Range Controls */}
      {activeTab !== 'ageing' && activeTab !== 'audit' && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                const today = todayLocalIso();
                setFromDate(today);
                setToDate(today);
              }}
              className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs hover:bg-[var(--surface-muted)]"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => {
                setFromDate(monthStartIso());
                setToDate(todayLocalIso());
              }}
              className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs hover:bg-[var(--surface-muted)]"
            >
              This Month
            </button>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-8 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
            />
            <span className="text-xs text-[var(--text-muted)]">to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-8 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
            />
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] text-sm text-[var(--give)]">
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-sm text-[var(--text-muted)]">
          {t('common.loading')}
        </div>
      ) : activeTab === 'dayBook' && dayBook ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            {(['day', 'cash', 'bank'] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBookMode(b)}
                className={`h-8 px-3 rounded-lg text-xs font-medium border ${
                  bookMode === b
                    ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                {b === 'day' ? 'Day Book (All)' : b === 'cash' ? 'Cash Book' : 'Bank / UPI Book'}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Opening Balance</div>
              <div className="text-lg font-bold mt-0.5 tabular-nums">{formatINR(dayBook.opening_balance)}</div>
            </div>
            <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Total Inflow (+)</div>
              <div className="text-lg font-bold mt-0.5 tabular-nums text-[var(--receive-text)]">
                {formatINR(dayBook.total_in)}
              </div>
            </div>
            <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Total Outflow (-)</div>
              <div className="text-lg font-bold mt-0.5 tabular-nums text-[var(--give)]">
                {formatINR(dayBook.total_out)}
              </div>
            </div>
            <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Closing Balance</div>
              <div className="text-lg font-bold mt-0.5 tabular-nums">{formatINR(dayBook.closing_balance)}</div>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <table className="w-full text-xs sm:text-sm border-collapse min-w-[680px]">
              <thead>
                <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                  <th className="text-left px-3 py-2.5 font-medium">Date</th>
                  <th className="text-left px-3 py-2.5 font-medium">Voucher #</th>
                  <th className="text-left px-3 py-2.5 font-medium">Particulars</th>
                  <th className="text-left px-3 py-2.5 font-medium">Mode</th>
                  <th className="text-right px-3 py-2.5 font-medium">Inflow</th>
                  <th className="text-right px-3 py-2.5 font-medium">Outflow</th>
                </tr>
              </thead>
              <tbody>
                {dayBook.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-[var(--text-muted)]">
                      No cash or bank transactions in this date range.
                    </td>
                  </tr>
                ) : (
                  dayBook.rows.map((r) => (
                    <tr key={`${r.source_type}-${r.entry_id}`} className="border-b border-[var(--border)] last:border-b-0">
                      <td className="px-3 py-2.5 tabular-nums text-[var(--text-muted)]">{formatDate(r.entry_date)}</td>
                      <td className="px-3 py-2.5 font-medium">{r.voucher_no}</td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{r.party_or_particular}</div>
                        {r.notes && <div className="text-[11px] text-[var(--text-muted)]">{r.notes}</div>}
                      </td>
                      <td className="px-3 py-2.5 uppercase text-xs text-[var(--text-muted)]">{r.payment_mode}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--receive-text)] font-medium">
                        {r.cash_in > 0 ? formatINR(r.cash_in) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--give)] font-medium">
                        {r.cash_out > 0 ? formatINR(r.cash_out) : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : activeTab === 'profit' && profitData ? (
        <div className="space-y-4">
          {profitData.missing_cost_entries > 0 && (
            <div className="p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
              Estimate note: {profitData.missing_cost_entries} stock movement(s) lacked purchase cost and used ₹0 cost. Set purchase prices on items or post supplier bills for higher accuracy.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Net Sales (Ex-Tax)</div>
              <div className="text-xl font-bold mt-1 tabular-nums">{formatINR(profitData.net_sales_ex_tax)}</div>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Estimated Cost of Goods</div>
              <div className="text-xl font-bold mt-1 tabular-nums">{formatINR(profitData.cogs_estimate)}</div>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Operating Expenses</div>
              <div className="text-xl font-bold mt-1 tabular-nums text-[var(--give)]">
                {formatINR(profitData.operating_expenses)}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="text-xs text-[var(--text-muted)]">Estimated Net Profit</div>
              <div
                className={`text-xl font-bold mt-1 tabular-nums ${
                  profitData.estimated_net_profit >= 0 ? 'text-[var(--receive-text)]' : 'text-[var(--give)]'
                }`}
              >
                {formatINR(profitData.estimated_net_profit)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-2 text-xs sm:text-sm">
              <h3 className="font-semibold mb-2">Trading & Profit Estimate Breakdown</h3>
              <div className="flex justify-between">
                <span>Gross Sales (Ex-Tax)</span>
                <span className="tabular-nums font-medium">{formatINR(profitData.gross_sales_ex_tax)}</span>
              </div>
              <div className="flex justify-between text-[var(--give)]">
                <span>Less: Sales Returns (Ex-Tax)</span>
                <span className="tabular-nums">-{formatINR(profitData.sales_returns_ex_tax)}</span>
              </div>
              <div className="flex justify-between">
                <span>Less: Estimated COGS</span>
                <span className="tabular-nums">-{formatINR(profitData.cogs_estimate)}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-[var(--border)] font-semibold">
                <span>Gross Profit Estimate</span>
                <span className="tabular-nums">{formatINR(profitData.gross_profit)}</span>
              </div>
              <div className="flex justify-between">
                <span>Add: Extra / Delivery Charges</span>
                <span className="tabular-nums">{formatINR(profitData.extra_charges_income)}</span>
              </div>
              <div className="flex justify-between text-[var(--give)]">
                <span>Less: Operating Expenses</span>
                <span className="tabular-nums">-{formatINR(profitData.operating_expenses)}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-[var(--border)] text-base font-bold">
                <span>Estimated Net Profit</span>
                <span className="tabular-nums">{formatINR(profitData.estimated_net_profit)}</span>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-2 text-xs sm:text-sm">
              <h3 className="font-semibold mb-2">Expense Category Breakdown</h3>
              {profitData.expense_breakdown.length === 0 ? (
                <p className="text-[var(--text-muted)]">No posted expenses in this period.</p>
              ) : (
                profitData.expense_breakdown.map((eb) => (
                  <div key={eb.code} className="flex justify-between">
                    <span>{eb.name_en}</span>
                    <span className="tabular-nums font-medium">{formatINR(eb.total_amount)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : activeTab === 'gst' && gstData ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-1">
              <div className="text-xs text-[var(--text-muted)]">Output GST (Sales - Returns)</div>
              <div className="text-xl font-bold tabular-nums">{formatINR(gstData.output.total_tax)}</div>
              <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                CGST {formatINR(gstData.output.cgst)} · SGST {formatINR(gstData.output.sgst)} · IGST {formatINR(gstData.output.igst)}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-1">
              <div className="text-xs text-[var(--text-muted)]">Input GST Credit (Purchases)</div>
              <div className="text-xl font-bold tabular-nums text-[var(--receive-text)]">{formatINR(gstData.input.total_tax)}</div>
              <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                CGST {formatINR(gstData.input.cgst)} · SGST {formatINR(gstData.input.sgst)} · IGST {formatINR(gstData.input.igst)}
              </div>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-1">
              <div className="text-xs text-[var(--text-muted)]">Net GST Liability (Output - Input)</div>
              <div className="text-xl font-bold tabular-nums">{formatINR(gstData.net_payable.total_tax)}</div>
              <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                Taxable Sales {formatINR(gstData.output.taxable)} · Purchases {formatINR(gstData.input.taxable)}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">HSN / SAC Summary</h3>
              <div className="flex gap-1.5">
                {(['sales', 'purchases'] as const).map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    onClick={() => setHsnScope(sc)}
                    className={`h-8 px-3 rounded-lg text-xs font-medium border capitalize ${
                      hsnScope === sc
                        ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {sc}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
              <table className="w-full text-xs sm:text-sm border-collapse min-w-[680px]">
                <thead>
                  <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="text-left px-3 py-2 font-medium">HSN</th>
                    <th className="text-left px-3 py-2 font-medium">UQC</th>
                    <th className="text-right px-3 py-2 font-medium">Rate %</th>
                    <th className="text-right px-3 py-2 font-medium">Qty</th>
                    <th className="text-right px-3 py-2 font-medium">Taxable</th>
                    <th className="text-right px-3 py-2 font-medium">CGST</th>
                    <th className="text-right px-3 py-2 font-medium">SGST</th>
                    <th className="text-right px-3 py-2 font-medium">IGST</th>
                    <th className="text-right px-3 py-2 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {hsnRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-6 text-center text-[var(--text-muted)]">
                        No HSN records in this period.
                      </td>
                    </tr>
                  ) : (
                    hsnRows.map((h, i) => (
                      <tr key={`${h.hsn_code}-${h.uqc}-${h.gst_rate}-${i}`} className="border-b border-[var(--border)] last:border-b-0">
                        <td className="px-3 py-2 font-medium">{h.hsn_code}</td>
                        <td className="px-3 py-2">{h.uqc}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.gst_rate}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.total_qty}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatINR(h.taxable_value)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatINR(h.cgst_amount)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatINR(h.sgst_amount)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatINR(h.igst_amount)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{formatINR(h.total_value)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : activeTab === 'sales' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(['register', 'item', 'party', 'user', 'returns', 'quotations'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setSalesGroup(g)}
                className={`h-8 px-3 rounded-lg text-xs font-medium border capitalize ${
                  salesGroup === g
                    ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                {g === 'register' ? 'Sales Register' : g === 'user' ? 'User-wise' : `${g}-wise`}
              </button>
            ))}
          </div>
          <DynamicReportTable rows={salesRows} emptyText="No sales records in this period." />
        </div>
      ) : activeTab === 'purchases' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(['register', 'supplier', 'item'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setPurchaseGroup(g)}
                className={`h-8 px-3 rounded-lg text-xs font-medium border capitalize ${
                  purchaseGroup === g
                    ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                {g === 'register' ? 'Purchase Register' : `${g}-wise`}
              </button>
            ))}
          </div>
          <DynamicReportTable rows={purchaseRows} emptyText="No purchase records in this period." />
        </div>
      ) : activeTab === 'stock' && stockResult ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1.5">
              {(['summary', 'low_stock', 'ledger'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setStockView(v)}
                  className={`h-8 px-3 rounded-lg text-xs font-medium border ${
                    stockView === v
                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                  }`}
                >
                  {v === 'summary' ? 'Stock Summary' : v === 'low_stock' ? 'Low Stock' : 'Stock Ledger'}
                </button>
              ))}
            </div>
            {stockResult.can_view_cost && stockResult.total_valuation !== null && (
              <div className="text-xs sm:text-sm font-semibold">
                Total Stock Valuation:{' '}
                <span className="tabular-nums text-[var(--primary-dark)]">
                  {formatINR(stockResult.total_valuation)}
                </span>
              </div>
            )}
          </div>
          <DynamicReportTable rows={stockResult.rows} emptyText="No stock records matching this filter." />
        </div>
      ) : activeTab === 'ageing' ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
          <table className="w-full text-xs sm:text-sm border-collapse min-w-[680px]">
            <thead>
              <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                <th className="text-left px-3 py-2.5 font-medium">Party</th>
                <th className="text-left px-3 py-2.5 font-medium">Type</th>
                <th className="text-right px-3 py-2.5 font-medium">0–30d</th>
                <th className="text-right px-3 py-2.5 font-medium">31–60d</th>
                <th className="text-right px-3 py-2.5 font-medium">61–90d</th>
                <th className="text-right px-3 py-2.5 font-medium">90+d</th>
                <th className="text-right px-3 py-2.5 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {ageingRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No open party dues.
                  </td>
                </tr>
              ) : (
                ageingRows.map((a) => (
                  <tr key={`${a.party_id}-${a.direction_needed}`} className="border-b border-[var(--border)] last:border-b-0">
                    <td className="px-3 py-2.5 font-medium">{a.party_name}</td>
                    <td className="px-3 py-2.5 capitalize text-xs">
                      {a.direction_needed === 'receive' ? 'Receivable' : 'Payable'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatINR(a.bucket_0_30)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatINR(a.bucket_31_60)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatINR(a.bucket_61_90)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[var(--give)]">{formatINR(a.bucket_90_plus)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{formatINR(a.total_outstanding)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : activeTab === 'audit' ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
          <table className="w-full text-xs sm:text-sm border-collapse min-w-[680px]">
            <thead>
              <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                <th className="text-left px-3 py-2.5 font-medium">Time</th>
                <th className="text-left px-3 py-2.5 font-medium">Actor</th>
                <th className="text-left px-3 py-2.5 font-medium">Action</th>
                <th className="text-left px-3 py-2.5 font-medium">Entity</th>
                <th className="text-left px-3 py-2.5 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((al) => (
                <tr key={al.id} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="px-3 py-2.5 text-xs text-[var(--text-muted)] whitespace-nowrap">
                    {new Date(al.created_at).toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2.5 text-xs">{al.actor_email || 'System'}</td>
                  <td className="px-3 py-2.5 font-medium text-xs">{al.action}</td>
                  <td className="px-3 py-2.5 text-xs">{al.entity_type}</td>
                  <td className="px-3 py-2.5 text-[11px] text-[var(--text-muted)] max-w-sm truncate">
                    {JSON.stringify(al.details)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function DynamicReportTable({
  rows,
  emptyText,
}: {
  rows: Array<Record<string, unknown>>;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-8 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-center text-sm text-[var(--text-muted)]">
        {emptyText}
      </div>
    );
  }

  const cols = Object.keys(rows[0]).filter((k) => k !== 'id' && k !== 'item_id' && k !== 'party_id' && k !== 'created_by' && k !== 'created_at');

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
      <table className="w-full text-xs sm:text-sm border-collapse min-w-[680px]">
        <thead>
          <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
            {cols.map((c) => (
              <th key={c} className="text-left px-3 py-2.5 font-medium capitalize whitespace-nowrap">
                {c.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={String(row.id ?? idx)} className="border-b border-[var(--border)] last:border-b-0">
              {cols.map((c) => {
                const v = row[c];
                const isMoney =
                  typeof v === 'number' &&
                  /(amount|total|sales|purchases|paid|due|balance|price|cost|value|tax|refund)/i.test(c);
                return (
                  <td key={c} className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                    {v === null || v === undefined
                      ? '—'
                      : isMoney
                        ? formatINR(Number(v))
                        : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
