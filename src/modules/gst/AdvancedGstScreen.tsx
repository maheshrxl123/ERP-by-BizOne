import {
  IconDownload,
  IconFileSpreadsheet,
  IconPlus,
  IconReceipt,
  IconRefresh,
  IconScale,
  IconShieldCheck,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { downloadCsvFile } from '../../core/export';
import { formatDate, formatINR, todayLocalIso } from '../../core/format';
import { roundHalfUp } from '../../core/money';
import { supabase } from '../../core/supabase';
import type {
  BillRecord,
  EinvoiceRecord,
  GstSummaryResult,
  HsnSummaryRow,
  TdsEntryRecord,
} from '../../types/bizone';

type GstTab = 'gstr1' | 'gstr3b' | 'gstr2b' | 'einvoice' | 'tds';

interface Gstr2bDbRow {
  id: string;
  period_month: string;
  supplier_gstin: string;
  supplier_name: string | null;
  invoice_no: string;
  invoice_date: string;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  match_status: 'matched' | 'mismatch' | 'missing_in_books' | 'unmatched';
  variance_amount: number;
}

interface Gstr1Data {
  b2b: Array<Record<string, unknown>>;
  b2c_summary: Array<Record<string, unknown>>;
  credit_notes: Array<Record<string, unknown>>;
}

export function AdvancedGstScreen() {
  const { session, isModuleEnabled, showToast } = useApp();
  const einvoiceEnabled = isModuleEnabled('einvoice');

  const [tab, setTab] = useState<GstTab>('gstr1');
  const [fromDate, setFromDate] = useState(() => `${todayLocalIso().slice(0, 7)}-01`);
  const [toDate, setToDate] = useState(() => todayLocalIso());
  const [periodMonth, setPeriodMonth] = useState(() => todayLocalIso().slice(0, 7));

  const [gstr1, setGstr1] = useState<Gstr1Data | null>(null);
  const [gstSummary, setGstSummary] = useState<GstSummaryResult | null>(null);
  const [hsnRows, setHsnRows] = useState<HsnSummaryRow[]>([]);
  const [gstr2bRows, setGstr2bRows] = useState<Gstr2bDbRow[]>([]);
  const [bills, setBills] = useState<BillRecord[]>([]);
  const [einvoices, setEinvoices] = useState<EinvoiceRecord[]>([]);
  const [tdsRows, setTdsRows] = useState<TdsEntryRecord[]>([]);

  // Add GSTR-2B row state
  const [supGstin, setSupGstin] = useState('');
  const [supName, setSupName] = useState('');
  const [invNo, setInvNo] = useState('');
  const [invDate, setInvDate] = useState(() => todayLocalIso());
  const [taxableVal, setTaxableVal] = useState('');
  const [cgstAmt, setCgstAmt] = useState('0');
  const [sgstAmt, setSgstAmt] = useState('0');
  const [igstAmt, setIgstAmt] = useState('0');

  // E-Invoice generate state
  const [selectedBillId, setSelectedBillId] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [transporter, setTransporter] = useState('');
  const [distanceKm, setDistanceKm] = useState('');
  const [generatingIrn, setGeneratingIrn] = useState(false);

  // TDS state
  const [tdsType, setTdsType] = useState<'TDS' | 'TCS'>('TDS');
  const [tdsSection, setTdsSection] = useState('194C');
  const [tdsPartyName, setTdsPartyName] = useState('');
  const [tdsPan, setTdsPan] = useState('');
  const [tdsBase, setTdsBase] = useState('');
  const [tdsRate, setTdsRate] = useState('1');

  const loadData = useCallback(async () => {
    try {
      const [g1Res, g3Res, hsnRes, g2bRes, billRes, einvRes, tdsRes] = await Promise.all([
        supabase.rpc('get_gstr1_data', { p_from_date: fromDate, p_to_date: toDate }),
        supabase.rpc('get_gst_summary', { p_from_date: fromDate, p_to_date: toDate }),
        supabase.rpc('get_hsn_summary', { p_from_date: fromDate, p_to_date: toDate, p_scope: 'sales' }),
        supabase
          .from('gstr2b_entries')
          .select('*')
          .eq('period_month', periodMonth)
          .order('invoice_date', { ascending: false }),
        supabase
          .from('bill_list_view')
          .select('*')
          .eq('status', 'issued')
          .order('bill_date', { ascending: false })
          .limit(30),
        supabase
          .from('einvoice_records')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('tds_entries')
          .select('*')
          .order('entry_date', { ascending: false })
          .limit(40),
      ]);

      if (g1Res.error) throw g1Res.error;
      if (g3Res.error) throw g3Res.error;
      if (hsnRes.error) throw hsnRes.error;

      if (g1Res.data) setGstr1(g1Res.data as Gstr1Data);
      if (g3Res.data) setGstSummary(g3Res.data as GstSummaryResult);
      const hsnPayload = hsnRes.data as { rows?: HsnSummaryRow[] } | HsnSummaryRow[] | null;
      if (Array.isArray(hsnPayload)) {
        setHsnRows(hsnPayload);
      } else {
        setHsnRows(hsnPayload?.rows ?? []);
      }
      setGstr2bRows((g2bRes.data as Gstr2bDbRow[] | null) ?? []);
      const bList = (billRes.data as BillRecord[] | null) ?? [];
      setBills(bList);
      if (bList.length > 0) setSelectedBillId((prev) => prev || bList[0].id);
      setEinvoices((einvRes.data as EinvoiceRecord[] | null) ?? []);
      setTdsRows((tdsRes.data as TdsEntryRecord[] | null) ?? []);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to load GST data.', 'error');
    }
  }, [fromDate, toDate, periodMonth, showToast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleExportGstr1Csv = () => {
    if (!gstr1) return;
    const headers = [
      'Section',
      'Bill / Ref #',
      'Date / POS',
      'Party / Type',
      'GSTIN',
      'Taxable',
      'CGST',
      'SGST',
      'IGST',
      'Total',
    ];
    const rows: Array<Array<unknown>> = [];
    for (const r of gstr1.b2b) {
      rows.push([
        'B2B',
        r.bill_number ?? '',
        r.bill_date ?? '',
        r.party_name ?? '',
        r.party_gstin ?? '',
        r.taxable_value ?? 0,
        r.cgst ?? 0,
        r.sgst ?? 0,
        r.igst ?? 0,
        r.grand_total ?? 0,
      ]);
    }
    for (const b2c of gstr1.b2c_summary) {
      rows.push([
        'B2C',
        `${Number(b2c.invoice_count ?? 0)} invoices`,
        b2c.place_of_supply ?? '',
        b2c.is_interstate ? 'Interstate' : 'Intrastate',
        '',
        b2c.taxable_value ?? 0,
        b2c.cgst ?? 0,
        b2c.sgst ?? 0,
        b2c.igst ?? 0,
        b2c.grand_total ?? 0,
      ]);
    }
    for (const cn of gstr1.credit_notes) {
      rows.push([
        'Credit Note',
        cn.bill_number ?? '',
        cn.bill_date ?? '',
        cn.party_name ?? '',
        cn.party_gstin ?? '',
        cn.taxable_value ?? 0,
        cn.cgst ?? 0,
        cn.sgst ?? 0,
        cn.igst ?? 0,
        cn.grand_total ?? 0,
      ]);
    }
    downloadCsvFile(`bizone-gstr1-${fromDate}-to-${toDate}.csv`, headers, rows);
  };

  const handleAddGstr2b = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supGstin.trim() || !invNo.trim()) return;
    const { error } = await supabase.from('gstr2b_entries').insert({
      period_month: periodMonth,
      supplier_gstin: supGstin.trim().toUpperCase(),
      supplier_name: supName.trim() || null,
      invoice_no: invNo.trim(),
      invoice_date: invDate,
      taxable_value: Number(taxableVal || 0),
      cgst: Number(cgstAmt || 0),
      sgst: Number(sgstAmt || 0),
      igst: Number(igstAmt || 0),
      match_status: 'unmatched',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setSupGstin('');
    setSupName('');
    setInvNo('');
    setTaxableVal('');
    await loadData();
  };

  const handleRunReconcile2B = async () => {
    const { data, error } = await supabase.rpc('reconcile_gstr2b_itc', {
      p_period_month: periodMonth,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    const res = data as { matched?: number; mismatch?: number; missing_in_books?: number };
    showToast(
      `Reconciled: ${res.matched || 0} matched · ${res.mismatch || 0} mismatch · ${res.missing_in_books || 0} missing in books.`,
      'info'
    );
    await loadData();
  };

  const handleGenerateEinvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token || !selectedBillId) return;
    setGeneratingIrn(true);
    try {
      const res = await fetch('/api/einvoice/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          billId: selectedBillId,
          vehicleNo: vehicleNo.trim() || undefined,
          transporterName: transporter.trim() || undefined,
          distanceKm: distanceKm ? Number(distanceKm) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'E-Invoice submission failed.');
      showToast(
        data.gspConfigured
          ? `IRN generated: ${data.record?.irn || 'OK'}`
          : 'Saved as pending draft (configure GSP credentials in Settings → Integrations for live NIC IRN).',
        data.gspConfigured ? 'success' : 'info'
      );
      await loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'E-Invoice failed.', 'error');
    } finally {
      setGeneratingIrn(false);
    }
  };

  const handleAddTds = async (e: React.FormEvent) => {
    e.preventDefault();
    const base = Number(tdsBase || 0);
    const rate = Number(tdsRate || 0);
    if (!tdsPartyName.trim() || base <= 0) return;
    const taxAmt = roundHalfUp((base * rate) / 100, 2);
    const { error } = await supabase.from('tds_entries').insert({
      tax_type: tdsType,
      section_code: tdsSection.trim(),
      party_name: tdsPartyName.trim(),
      pan_no: tdsPan.trim().toUpperCase() || null,
      entry_date: todayLocalIso(),
      base_amount: base,
      rate_pct: rate,
      tax_amount: taxAmt,
      status: 'pending',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setTdsPartyName('');
    setTdsPan('');
    setTdsBase('');
    await loadData();
  };

  const handleMarkTdsDeposited = async (id: string) => {
    const { error } = await supabase
      .from('tds_entries')
      .update({ status: 'deposited' })
      .eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadData();
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconFileSpreadsheet size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>GST Filing, ITC 2B & E-Invoice</span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            GSTR-1 (B2B/B2C/CDNR), GSTR-3B & HSN summary, GSTR-2B ITC matching, E-Invoice / E-Way Bill, and TDS/TCS registers.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
          />
          <button
            type="button"
            onClick={() => void loadData()}
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
            { key: 'gstr1', label: 'GSTR-1', icon: IconFileSpreadsheet },
            { key: 'gstr3b', label: 'GSTR-3B & HSN', icon: IconScale },
            { key: 'gstr2b', label: 'GSTR-2B ITC Match', icon: IconShieldCheck },
            { key: 'einvoice', label: 'E-Invoice / E-Way', icon: IconReceipt },
            { key: 'tds', label: 'TDS / TCS', icon: IconPlus },
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

      {/* GSTR-1 */}
      {tab === 'gstr1' && gstr1 && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleExportGstr1Csv}
              className="h-9 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1.5"
            >
              <IconDownload size={14} stroke={2} />
              <span>Export GSTR-1 CSV</span>
            </button>
          </div>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)] text-sm font-semibold">
              B2B Invoices (Registered GSTIN Buyers · {gstr1.b2b.length})
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                  <th className="py-2.5 px-4">Invoice #</th>
                  <th className="py-2.5 px-4">Date</th>
                  <th className="py-2.5 px-4">Buyer / GSTIN</th>
                  <th className="py-2.5 px-4 text-right">Taxable</th>
                  <th className="py-2.5 px-4 text-right">Tax</th>
                  <th className="py-2.5 px-4 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {gstr1.b2b.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 px-4 text-center text-[var(--text-muted)]">
                      No B2B invoices with 15-character buyer GSTIN in this range.
                    </td>
                  </tr>
                ) : (
                  gstr1.b2b.map((r, i) => (
                    <tr key={i}>
                      <td className="py-2.5 px-4 font-mono text-xs">{String(r.bill_number)}</td>
                      <td className="py-2.5 px-4 tabular-nums">{formatDate(String(r.bill_date))}</td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium">{String(r.party_name)}</div>
                        <div className="text-xs font-mono text-[var(--text-muted)]">
                          {String(r.party_gstin)}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {formatINR(Number(r.taxable_value || 0))}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums">
                        {formatINR(Number(r.cgst || 0) + Number(r.sgst || 0) + Number(r.igst || 0))}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums font-semibold">
                        {formatINR(Number(r.grand_total || 0))}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)] text-sm font-semibold">
              B2C State Summary & Credit Notes ({gstr1.credit_notes.length})
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
              {gstr1.b2c_summary.map((b2c, i) => (
                <div key={i} className="rounded-lg border border-[var(--border)] p-3 text-xs">
                  <div className="font-semibold">
                    POS: {String(b2c.place_of_supply)} · {b2c.is_interstate ? 'Interstate' : 'Intrastate'}
                  </div>
                  <div className="text-[var(--text-muted)] mt-1 tabular-nums">
                    {Number(b2c.invoice_count)} invoice(s) · Taxable{' '}
                    {formatINR(Number(b2c.taxable_value || 0))}
                  </div>
                  <div className="font-semibold mt-0.5 tabular-nums">
                    Total {formatINR(Number(b2c.grand_total || 0))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* GSTR-3B & HSN */}
      {tab === 'gstr3b' && gstSummary && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="text-xs text-[var(--text-muted)]">3.1 Output GST Liability</div>
              <div className="text-lg font-semibold tabular-nums mt-1">
                {formatINR(gstSummary.output.total_tax)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                CGST {formatINR(gstSummary.output.cgst)} · SGST {formatINR(gstSummary.output.sgst)} · IGST {formatINR(gstSummary.output.igst)}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="text-xs text-[var(--text-muted)]">4. Eligible Input Tax Credit (ITC)</div>
              <div className="text-lg font-semibold tabular-nums mt-1 text-[var(--receive-text)]">
                {formatINR(gstSummary.input.total_tax)}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                Taxable purchases {formatINR(gstSummary.input.taxable)}
              </div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="text-xs text-[var(--text-muted)]">Net GST Payable</div>
              <div className="text-lg font-semibold tabular-nums mt-1">
                {formatINR(gstSummary.net_payable.total_tax)}
              </div>
            </div>
          </div>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <div className="px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)] text-sm font-semibold">
              HSN Summary ({hsnRows.length})
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                  <th className="py-2.5 px-4">HSN / SAC</th>
                  <th className="py-2.5 px-4 text-right">Qty</th>
                  <th className="py-2.5 px-4 text-right">GST %</th>
                  <th className="py-2.5 px-4 text-right">Taxable</th>
                  <th className="py-2.5 px-4 text-right">Total Tax</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {hsnRows.map((h, i) => (
                  <tr key={i}>
                    <td className="py-2.5 px-4 font-mono text-xs">{h.hsn_code} ({h.uqc})</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{h.total_qty}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">{h.gst_rate}%</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">
                      {formatINR(Number(h.taxable_value))}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums font-semibold">
                      {formatINR(Number(h.total_tax))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {/* GSTR-2B ITC Reconciliation */}
      {tab === 'gstr2b' && (
        <div className="space-y-4">
          <form
            onSubmit={handleAddGstr2b}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Add GSTR-2B Portal Entry & Match</h2>
              <div className="flex items-center gap-2">
                <input
                  type="month"
                  value={periodMonth}
                  onChange={(e) => setPeriodMonth(e.target.value)}
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => void handleRunReconcile2B()}
                  className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
                >
                  Run Auto-Match
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
              <input
                type="text"
                required
                value={supGstin}
                onChange={(e) => setSupGstin(e.target.value)}
                placeholder="Supplier GSTIN"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
              />
              <input
                type="text"
                value={supName}
                onChange={(e) => setSupName(e.target.value)}
                placeholder="Supplier Name"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <input
                type="text"
                required
                value={invNo}
                onChange={(e) => setInvNo(e.target.value)}
                placeholder="Supplier Invoice #"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <input
                type="date"
                value={invDate}
                onChange={(e) => setInvDate(e.target.value)}
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={taxableVal}
                onChange={(e) => setTaxableVal(e.target.value)}
                placeholder="Taxable"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={cgstAmt}
                onChange={(e) => setCgstAmt(e.target.value)}
                placeholder="CGST"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={sgstAmt}
                onChange={(e) => setSgstAmt(e.target.value)}
                placeholder="SGST"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={igstAmt}
                onChange={(e) => setIgstAmt(e.target.value)}
                placeholder="IGST"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="h-9 px-4 rounded-lg border border-[var(--border)] text-xs font-semibold hover:bg-[var(--surface-muted)]"
              >
                Add Portal Row
              </button>
            </div>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {gstr2bRows.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">
                No GSTR-2B rows imported for {periodMonth}.
              </div>
            ) : (
              gstr2bRows.map((row) => (
                <div
                  key={row.id}
                  className="p-4 flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <div>
                    <div className="font-semibold">
                      {row.invoice_no} · <span className="font-mono text-xs">{row.supplier_gstin}</span>
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {row.supplier_name || 'Supplier'} · {formatDate(row.invoice_date)}
                    </div>
                  </div>
                  <div className="text-right tabular-nums">
                    <div className="font-semibold">
                      Portal Tax {formatINR(Number(row.cgst) + Number(row.sgst) + Number(row.igst))}
                    </div>
                    <div
                      className={`text-xs font-medium ${
                        row.match_status === 'matched'
                          ? 'text-[var(--receive-text)]'
                          : 'text-[var(--give)]'
                      }`}
                    >
                      {row.match_status.replace(/_/g, ' ')} (Var {formatINR(Number(row.variance_amount))})
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      {/* E-Invoice & E-Way Bill */}
      {tab === 'einvoice' && (
        <div className="space-y-4">
          {!einvoiceEnabled ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-muted)]">
              E-Invoice & E-Way Bill module is disabled. Enable <code className="font-mono">einvoice</code> in Settings → Modules & Features to activate GSP submissions.
            </div>
          ) : (
            <>
              <form
                onSubmit={handleGenerateEinvoice}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
              >
                <h2 className="text-base font-semibold">Generate IRN / E-Way Bill</h2>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <select
                    value={selectedBillId}
                    onChange={(e) => setSelectedBillId(e.target.value)}
                    className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  >
                    {bills.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bill_number} · {b.party_name} · {formatINR(Number(b.grand_total))}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={vehicleNo}
                    onChange={(e) => setVehicleNo(e.target.value)}
                    placeholder="Vehicle # (optional)"
                    className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm uppercase"
                  />
                  <input
                    type="number"
                    min={0}
                    value={distanceKm}
                    onChange={(e) => setDistanceKm(e.target.value)}
                    placeholder="Distance km"
                    className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <input
                    type="text"
                    value={transporter}
                    onChange={(e) => setTransporter(e.target.value)}
                    placeholder="Transporter name (optional)"
                    className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm w-full sm:w-64"
                  />
                  <button
                    type="submit"
                    disabled={generatingIrn || !selectedBillId}
                    className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold disabled:opacity-50"
                  >
                    {generatingIrn ? 'Submitting...' : 'Submit E-Invoice / EWB'}
                  </button>
                </div>
              </form>

              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
                {einvoices.length === 0 ? (
                  <div className="p-6 text-sm text-[var(--text-muted)]">
                    No E-Invoice records yet.
                  </div>
                ) : (
                  einvoices.map((ev) => (
                    <div key={ev.id} className="p-4 flex flex-wrap justify-between gap-3 text-sm">
                      <div>
                        <div className="font-mono text-xs font-semibold">
                          {ev.irn ? `IRN: ${ev.irn}` : 'Pending GSP Submission'}
                        </div>
                        <div className="text-xs text-[var(--text-muted)]">
                          Status: {ev.status}
                          {ev.eway_bill_no ? ` · EWB ${ev.eway_bill_no}` : ''}
                          {ev.error_message ? ` · ${ev.error_message}` : ''}
                        </div>
                      </div>
                      <span className="text-xs text-[var(--text-muted)] tabular-nums">
                        {formatDate(ev.created_at)}
                      </span>
                    </div>
                  ))
                )}
              </section>
            </>
          )}
        </div>
      )}

      {/* TDS / TCS */}
      {tab === 'tds' && (
        <div className="space-y-4">
          <form
            onSubmit={handleAddTds}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
          >
            <h2 className="text-base font-semibold">Record TDS / TCS Deduction</h2>
            <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5">
              <select
                value={tdsType}
                onChange={(e) => setTdsType(e.target.value as 'TDS' | 'TCS')}
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="TDS">TDS</option>
                <option value="TCS">TCS</option>
              </select>
              <input
                type="text"
                required
                value={tdsSection}
                onChange={(e) => setTdsSection(e.target.value)}
                placeholder="Section (194C)"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
              />
              <input
                type="text"
                required
                value={tdsPartyName}
                onChange={(e) => setTdsPartyName(e.target.value)}
                placeholder="Party Name"
                className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <input
                type="text"
                value={tdsPan}
                onChange={(e) => setTdsPan(e.target.value)}
                placeholder="PAN"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
              />
              <div className="flex gap-1.5">
                <input
                  type="number"
                  min={1}
                  step="0.01"
                  required
                  value={tdsBase}
                  onChange={(e) => setTdsBase(e.target.value)}
                  placeholder="Base ₹"
                  className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  required
                  value={tdsRate}
                  onChange={(e) => setTdsRate(e.target.value)}
                  placeholder="%"
                  className="w-20 h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Add Entry
              </button>
            </div>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {tdsRows.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No TDS / TCS entries yet.</div>
            ) : (
              tdsRows.map((row) => (
                <div key={row.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <div>
                    <div className="font-semibold">
                      {row.tax_type} · Sec {row.section_code} · {row.party_name}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] tabular-nums">
                      {formatDate(row.entry_date)} · Base {formatINR(Number(row.base_amount))} @ {row.rate_pct}%
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold tabular-nums">{formatINR(Number(row.tax_amount))}</span>
                    {row.status === 'pending' ? (
                      <button
                        type="button"
                        onClick={() => void handleMarkTdsDeposited(row.id)}
                        className="h-8 px-3 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
                      >
                        Mark Deposited
                      </button>
                    ) : (
                      <span className="text-xs font-semibold text-[var(--receive-text)]">Deposited</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
