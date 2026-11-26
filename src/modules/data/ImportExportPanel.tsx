import {
  IconAlertCircle,
  IconCheck,
  IconDownload,
  IconFileSpreadsheet,
  IconLoader2,
  IconUpload,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDateTime } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import {
  autoMapColumns,
  buildErrorCsvText,
  downloadImportTemplate,
  exportSheetsToBrowser,
  IMPORT_FIELD_SPECS,
  mapAndValidateImportRows,
  parseSpreadsheetBuffer,
  triggerBrowserDownload,
  type ImportEntityType,
} from '../../core/spreadsheet';
import { supabase } from '../../core/supabase';
import type { ImportJobResult } from '../../types/decorbiz';

interface ImportJobHistoryRow {
  id: string;
  import_type: string;
  file_name: string;
  duplicate_mode: string;
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  created_at: string;
}

export function ImportExportPanel({ onImported }: { onImported?: () => void }) {
  const { profile, language, showToast } = useApp();
  const canImportParties =
    profile?.role === 'owner' || profile?.role === 'manager' || profile?.role === 'accountant';
  const canImportItems =
    profile?.role === 'owner' || profile?.role === 'manager' || profile?.role === 'storekeeper';
  const canExport = hasCapability(profile?.role, 'reports') || profile?.role === 'owner';

  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [entityType, setEntityType] = useState<ImportEntityType>('items');
  const [duplicateMode, setDuplicateMode] = useState<'skip' | 'update' | 'error'>('skip');
  const [fileName, setFileName] = useState('');
  const [rawBuffer, setRawBuffer] = useState<ArrayBuffer | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportJobResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportJobHistoryRow[]>([]);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadHistory = async () => {
    const { data } = await supabase
      .from('import_jobs')
      .select('id, import_type, file_name, duplicate_mode, total_rows, inserted_count, updated_count, skipped_count, error_count, created_at')
      .order('created_at', { ascending: false })
      .limit(12);
    setHistory((data as ImportJobHistoryRow[]) || []);
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  const handleFileSelect = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    setImportResult(null);
    try {
      const buf = await file.arrayBuffer();
      const parsed = await parseSpreadsheetBuffer(buf, file.name);
      setRawBuffer(buf);
      setFileName(file.name);
      setSheetNames(parsed.sheetNames);
      setSelectedSheet(parsed.selectedSheet);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setMapping(autoMapColumns(parsed.headers, entityType));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Unable to read spreadsheet.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSheetChange = async (nextSheet: string) => {
    if (!rawBuffer) return;
    try {
      const parsed = await parseSpreadsheetBuffer(rawBuffer, fileName, nextSheet);
      setSelectedSheet(parsed.selectedSheet);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setMapping(autoMapColumns(parsed.headers, entityType));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Unable to switch sheet.');
    }
  };

  const validation = useMemo(() => {
    if (rows.length === 0) return { validRows: [], invalidRows: [] };
    return mapAndValidateImportRows(rows, mapping, entityType);
  }, [rows, mapping, entityType]);

  const canRunImport =
    (entityType === 'parties' ? canImportParties : canImportItems) &&
    validation.validRows.length > 0 &&
    !importing;

  const handleExecuteImport = async () => {
    if (!canRunImport) return;
    setImporting(true);
    try {
      const rpcName = entityType === 'parties' ? 'import_parties_batch' : 'import_items_batch';
      const { data, error } = await supabase.rpc(rpcName, {
        p_rows: validation.validRows,
        p_duplicate_mode: duplicateMode,
        p_file_name: fileName || `${entityType}.xlsx`,
      });
      if (error) throw error;
      const res = data as ImportJobResult;
      setImportResult(res);
      showToast(
        `Imported: ${res.inserted_count} added · ${res.updated_count} updated · ${res.skipped_count} skipped`,
        res.error_count > 0 ? 'info' : 'success'
      );
      await loadHistory();
      onImported?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Import failed.', 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleExportEntity = async (
    target: 'full_workbook' | 'parties' | 'items' | 'bills' | 'purchases' | 'expenses',
    format: 'xlsx' | 'csv'
  ) => {
    setExporting(true);
    try {
      const sheets: Array<{ name: string; headers: string[]; rows: Array<Array<unknown>> }> = [];

      if (target === 'full_workbook' || target === 'parties') {
        const { data } = await supabase.from('party_balances').select('*').order('name');
        sheets.push({
          name: 'Parties',
          headers: ['Name', 'Type', 'Phone', 'Email', 'GSTIN', 'Net Balance', 'To Receive', 'To Give', 'Credit Limit', 'Credit Days'],
          rows: (data || []).map((p) => [
            p.name, p.party_type, p.phone || '', p.email || '',
            p.gstin || '', p.net_balance, p.to_receive, p.to_give, p.credit_limit, p.credit_days,
          ]),
        });
      }

      if (target === 'full_workbook' || target === 'items') {
        const { data } = await supabase.from('item_catalog_view').select('*').order('name');
        sheets.push({
          name: 'Items',
          headers: ['Name', 'Type', 'SKU', 'Barcode', 'Category', 'Brand', 'Unit', 'Selling Price', 'MRP', 'Purchase Cost', 'GST %', 'HSN', 'Stock Qty', 'Low Alert'],
          rows: (data || []).map((i) => [
            i.name, i.item_type || 'goods', i.sku || '', i.barcode || '', i.category_name || '',
            i.brand_name || '', i.base_unit_code, i.selling_price, i.mrp ?? '',
            i.purchase_price ?? '', i.gst_rate, i.hsn_code || '', i.qty_on_hand, i.low_stock_alert,
          ]),
        });
      }

      if (target === 'full_workbook' || target === 'bills') {
        const { data } = await supabase.from('bill_list_view').select('*').order('bill_date', { ascending: false }).limit(1000);
        sheets.push({
          name: 'Sales Bills',
          headers: ['Bill No', 'Doc Type', 'Status', 'Payment Status', 'Date', 'Party', 'Site', 'Taxable', 'Tax', 'Grand Total', 'Paid', 'Balance'],
          rows: (data || []).map((b) => [
            b.bill_number || 'DRAFT', b.doc_type, b.status, b.payment_status, b.bill_date,
            b.party_name, b.site_name || '', b.subtotal_taxable, b.tax_total, b.grand_total,
            b.paid_amount, b.balance_due,
          ]),
        });
      }

      if (target === 'full_workbook' || target === 'purchases') {
        const { data } = await supabase.from('purchase_list_view').select('*').order('bill_date', { ascending: false }).limit(1000);
        sheets.push({
          name: 'Purchases',
          headers: ['Purchase No', 'Supplier Inv No', 'Date', 'Supplier', 'Status', 'Taxable', 'Tax', 'Grand Total', 'Paid', 'Balance'],
          rows: (data || []).map((p) => [
            p.purchase_number || 'DRAFT', p.supplier_invoice_no || '', p.bill_date,
            p.party_name, p.status, p.subtotal_taxable, p.tax_total, p.grand_total, p.paid_amount, p.balance_due,
          ]),
        });
      }

      if (target === 'full_workbook' || target === 'expenses') {
        const { data } = await supabase.from('expense_list_view').select('*').order('expense_date', { ascending: false }).limit(1000);
        sheets.push({
          name: 'Expenses',
          headers: ['Expense No', 'Date', 'Category', 'Paid To', 'Mode', 'Amount', 'Status', 'Notes'],
          rows: (data || []).map((ex) => [
            ex.expense_number, ex.expense_date, ex.category_name_en, ex.paid_to || '',
            ex.payment_mode, ex.amount, ex.status, ex.notes || '',
          ]),
        });
      }

      await exportSheetsToBrowser(
        `decorbiz-${target}-${new Date().toISOString().slice(0, 10)}`,
        sheets,
        target === 'full_workbook' ? 'xlsx' : format
      );
      showToast('Spreadsheet exported.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <IconFileSpreadsheet size={20} stroke={2} className="text-[var(--primary-dark)]" />
            <span>{language === 'hi' ? 'डेटा आयात / निर्यात (CSV & XLSX)' : 'CSV & XLSX Import / Export'}</span>
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Download templates, map columns, validate duplicates before importing, or export ledgers to Excel.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab('import')}
            className={`h-9 px-3.5 rounded-lg border text-xs font-medium ${
              tab === 'import'
                ? 'bg-[var(--primary)] text-[var(--on-primary)] border-[var(--primary)]'
                : 'bg-[var(--surface)] border-[var(--border)]'
            }`}
          >
            Import CSV / XLSX
          </button>
          <button
            type="button"
            onClick={() => setTab('export')}
            className={`h-9 px-3.5 rounded-lg border text-xs font-medium ${
              tab === 'export'
                ? 'bg-[var(--primary)] text-[var(--on-primary)] border-[var(--primary)]'
                : 'bg-[var(--surface)] border-[var(--border)]'
            }`}
          >
            Export Business Data
          </button>
        </div>
      </div>

      {tab === 'import' && (
        <div className="space-y-5">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-xs font-medium mb-1">1. Target Data Type</label>
                <select
                  value={entityType}
                  onChange={(e) => {
                    const nextType = e.target.value as ImportEntityType;
                    setEntityType(nextType);
                    if (headers.length > 0) setMapping(autoMapColumns(headers, nextType));
                  }}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  <option value="items">Items & Opening Stock</option>
                  <option value="parties">Parties (Customers & Suppliers)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">2. Duplicate Handling</label>
                <select
                  value={duplicateMode}
                  onChange={(e) => setDuplicateMode(e.target.value as typeof duplicateMode)}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  <option value="skip">Skip existing matching records</option>
                  <option value="update">Update existing prices / details</option>
                  <option value="error">Mark duplicates as errors</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void downloadImportTemplate(entityType, 'xlsx')}
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <IconDownload size={14} stroke={2} />
                  <span>Template .XLSX</span>
                </button>
                <button
                  type="button"
                  onClick={() => void downloadImportTemplate(entityType, 'csv')}
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5"
                >
                  <IconDownload size={14} stroke={2} />
                  <span>Template .CSV</span>
                </button>
              </div>
            </div>

            <div className="pt-3 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => void handleFileSelect(e.target.files?.[0])}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="h-10 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-2"
                >
                  <IconUpload size={15} stroke={2} />
                  <span>{fileName ? `Replace File (${fileName})` : 'Choose CSV or Excel File'}</span>
                </button>

                {sheetNames.length > 1 && (
                  <select
                    value={selectedSheet}
                    onChange={(e) => void handleSheetChange(e.target.value)}
                    className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    {sheetNames.map((s) => (
                      <option key={s} value={s}>Sheet: {s}</option>
                    ))}
                  </select>
                )}
              </div>

              {rows.length > 0 && (
                <p className="text-xs text-[var(--text-muted)] tabular-nums">
                  {rows.length} rows detected · {validation.validRows.length} valid ·{' '}
                  <span className={validation.invalidRows.length > 0 ? 'text-[var(--give)] font-semibold' : ''}>
                    {validation.invalidRows.length} invalid
                  </span>
                </p>
              )}
            </div>

            {parseError && (
              <p className="text-xs font-medium text-[var(--give)] flex items-center gap-1.5">
                <IconAlertCircle size={15} stroke={2} />
                <span>{parseError}</span>
              </p>
            )}
          </section>

          {headers.length > 0 && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Column Mapping & Preview</h3>
                <div className="flex flex-wrap gap-2">
                  {validation.invalidRows.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        triggerBrowserDownload(
                          buildErrorCsvText(validation.invalidRows),
                          `import-validation-errors-${entityType}.csv`,
                          'text/csv;charset=utf-8;'
                        )
                      }
                      className="h-9 px-3 rounded-lg border border-[var(--give)] text-[var(--give)] text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <IconDownload size={14} stroke={2} />
                      <span>Download {validation.invalidRows.length} Error Row(s)</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!canRunImport}
                    onClick={() => void handleExecuteImport()}
                    className="h-9 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-[var(--on-primary)] text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {importing ? (
                      <IconLoader2 size={14} stroke={2} className="animate-spin" />
                    ) : (
                      <IconCheck size={14} stroke={2} />
                    )}
                    <span>
                      {importing ? 'Importing...' : `Import ${validation.validRows.length} Valid Row(s)`}
                    </span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {IMPORT_FIELD_SPECS[entityType].map((spec) => (
                  <div key={spec.key} className="space-y-1">
                    <label className="block text-xs font-medium">
                      {language === 'hi' ? spec.labelHi : spec.labelEn}
                    </label>
                    <select
                      value={mapping[spec.key] || ''}
                      onChange={(e) =>
                        setMapping((prev) => ({ ...prev, [spec.key]: e.target.value }))
                      }
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      <option value="">— Ignore / Default —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {validation.invalidRows.length > 0 && (
                <div className="rounded-lg border border-[var(--give)] bg-[var(--give-soft)] p-3 text-xs space-y-1">
                  <p className="font-semibold text-[var(--give)]">Validation Issues Found:</p>
                  {validation.invalidRows.slice(0, 8).map((errRow) => (
                    <p key={`${errRow.row}-${errRow.name}`} className="tabular-nums">
                      Row {errRow.row} ({errRow.name}): {errRow.error}
                    </p>
                  ))}
                </div>
              )}

              {importResult && (
                <div className="rounded-lg border border-[var(--receive)] bg-[var(--receive-soft)] p-4 text-xs space-y-2">
                  <p className="font-semibold text-sm text-[var(--receive-text)]">
                    Import Complete · Total {importResult.total_rows} rows
                  </p>
                  <p className="tabular-nums">
                    Inserted: {importResult.inserted_count} · Updated: {importResult.updated_count} · Skipped: {importResult.skipped_count} · Server Errors: {importResult.error_count}
                  </p>
                  {importResult.errors.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        triggerBrowserDownload(
                          buildErrorCsvText(importResult.errors),
                          `server-import-errors-${entityType}.csv`,
                          'text/csv;charset=utf-8;'
                        )
                      }
                      className="h-8 px-3 rounded border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1"
                    >
                      <IconDownload size={14} stroke={2} />
                      <span>Download Server Errors CSV</span>
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

          {history.length > 0 && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  Recent Imports
                </h3>
              </div>
              <div className="divide-y divide-[var(--border)]">
                {history.map((h) => (
                  <div key={h.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div>
                      <span className="font-semibold uppercase">{h.import_type}</span>{' '}
                      <span className="text-[var(--text-muted)]">· {h.file_name} ({h.duplicate_mode})</span>
                    </div>
                    <div className="tabular-nums text-[var(--text-muted)]">
                      +{h.inserted_count} ins · {h.updated_count} upd · {h.skipped_count} skip · {h.error_count} err · {formatDateTime(h.created_at)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {tab === 'export' && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          {!canExport ? (
            <p className="text-xs text-[var(--text-muted)]">
              Only Owner, Manager, or Accountant roles can export full business spreadsheets.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl border border-[var(--border)] space-y-3">
                <h3 className="text-sm font-semibold">Full Business Workbook (.XLSX)</h3>
                <p className="text-xs text-[var(--text-muted)]">
                  Exports Parties, Items, Sales Bills, Purchases & Expenses as a multi-sheet Excel file.
                </p>
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => void handleExportEntity('full_workbook', 'xlsx')}
                  className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <IconDownload size={14} stroke={2} />
                  <span>Download Full .XLSX</span>
                </button>
              </div>

              {(
                [
                  { id: 'parties', title: 'Parties & Khata Balances' },
                  { id: 'items', title: 'Items & Stock Catalog' },
                  { id: 'bills', title: 'Sales Invoices & Quotations' },
                  { id: 'purchases', title: 'Supplier Purchase Bills' },
                  { id: 'expenses', title: 'Shop Expenses Log' },
                ] as const
              ).map((entry) => (
                <div key={entry.id} className="p-4 rounded-xl border border-[var(--border)] space-y-3">
                  <h3 className="text-sm font-semibold">{entry.title}</h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={exporting}
                      onClick={() => void handleExportEntity(entry.id, 'xlsx')}
                      className="h-8 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium"
                    >
                      .XLSX
                    </button>
                    <button
                      type="button"
                      disabled={exporting}
                      onClick={() => void handleExportEntity(entry.id, 'csv')}
                      className="h-8 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium"
                    >
                      .CSV
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
