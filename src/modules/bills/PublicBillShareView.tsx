import { IconAlertCircle, IconCheck, IconLoader2, IconPrinter } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { buildUpiDeepLink, formatDate, formatINR } from '../../core/format';
import { amountInWordsINR } from '../../core/money';
import type { PublicSharedBillPayload } from '../../types/decorbiz';
import { UpiQrSvg } from './UpiQrSvg';

interface PublicBillShareViewProps {
  shareToken: string;
}

export function PublicBillShareView({ shareToken }: PublicBillShareViewProps) {
  const [payload, setPayload] = useState<PublicSharedBillPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErrorMsg(null);
    fetch(`/api/share/bill/${encodeURIComponent(shareToken)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || 'This invoice link is no longer valid.');
        }
        return data as PublicSharedBillPayload;
      })
      .then((data) => {
        if (active) setPayload(data);
      })
      .catch((err) => {
        if (active) {
          setErrorMsg(
            err instanceof Error ? err.message : 'Unable to load shared invoice.'
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [shareToken]);

  const gstSummaryRows = useMemo(() => {
    if (!payload?.bill.gst_applied) return [];
    const map = new Map<
      number,
      { rate: number; taxable: number; cgst: number; sgst: number; igst: number }
    >();
    for (const l of payload.lines) {
      const rate = Number(l.gst_rate || 0);
      const cur = map.get(rate) || { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      cur.taxable += Number(l.taxable_amount || 0);
      cur.cgst += Number(l.cgst_amount || 0);
      cur.sgst += Number(l.sgst_amount || 0);
      cur.igst += Number(l.igst_amount || 0);
      map.set(rate, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.rate - b.rate);
  }, [payload]);

  const isPayable = Boolean(
    payload &&
      payload.bill.doc_type !== 'credit_note' &&
      payload.bill.status !== 'voided' &&
      (payload.bill.doc_type === 'quotation' || Number(payload.bill.balance_due) > 0)
  );
  const isPaidInvoice = Boolean(
    payload &&
      payload.bill.doc_type !== 'quotation' &&
      payload.bill.doc_type !== 'credit_note' &&
      payload.bill.status === 'issued' &&
      Number(payload.bill.balance_due) <= 0
  );

  const upiDeepLink = useMemo(() => {
    if (!isPayable || !payload?.assets.showUpiQr || !payload.assets.upiId) return '';
    const amount =
      payload.bill.doc_type === 'quotation'
        ? Number(payload.bill.grand_total)
        : Number(payload.bill.balance_due);
    return buildUpiDeepLink({
      upiId: payload.assets.upiId,
      businessName: payload.bill.business_snapshot?.name || 'DecorBiz Store',
      amount: amount > 0 ? amount : undefined,
      note: payload.bill.bill_number || 'Invoice Payment',
    });
  }, [isPayable, payload]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <div className="flex items-center gap-2.5 text-sm text-[var(--text-muted)]">
          <IconLoader2 size={20} stroke={2} className="animate-spin text-[var(--primary-dark)]" />
          <span>Loading invoice document...</span>
        </div>
      </div>
    );
  }

  if (errorMsg || !payload) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center space-y-3">
          <IconAlertCircle size={32} stroke={2} className="text-[var(--give)] mx-auto" />
          <h1 className="text-lg font-semibold">Invoice Link Unavailable</h1>
          <p className="text-sm text-[var(--text-muted)]">
            {errorMsg || 'This shared invoice link has expired or been revoked.'}
          </p>
        </div>
      </div>
    );
  }

  const { bill, lines, assets } = payload;
  const docHeading =
    bill.doc_type === 'tax_invoice'
      ? 'TAX INVOICE'
      : bill.doc_type === 'bill_of_supply'
        ? 'BILL OF SUPPLY'
        : bill.doc_type === 'quotation'
          ? 'QUOTATION'
          : 'CREDIT NOTE';

  return (
    <div className="min-h-screen bg-[var(--surface-muted)] py-6 px-3 sm:px-6 text-neutral-900">
      <div className="no-print max-w-[780px] mx-auto mb-3 flex items-center justify-between gap-3">
        <span className="text-xs text-[var(--text-muted)]">
          View-only shared document
        </span>
        <button
          type="button"
          onClick={() => window.print()}
          className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
        >
          <IconPrinter size={16} stroke={2} />
          <span>Print / Save PDF</span>
        </button>
      </div>

      <div className="print-surface max-w-[780px] mx-auto bg-white border border-neutral-300 rounded-xl p-6 sm:p-8 text-xs sm:text-sm space-y-4">
        {bill.status === 'voided' && (
          <div className="px-3 py-1.5 rounded border border-red-600 text-red-700 text-center font-bold uppercase text-xs">
            VOIDED DOCUMENT{bill.void_reason ? ` · ${bill.void_reason}` : ''}
          </div>
        )}

        <div className="border-b border-neutral-300 pb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {assets.logoUrl && (
              <img
                src={assets.logoUrl}
                alt="Logo"
                className="w-14 h-14 object-contain rounded border border-neutral-200 shrink-0"
              />
            )}
            <div>
              <h1 className="text-lg font-bold">
                {bill.business_snapshot?.name || 'Business'}
              </h1>
              {bill.business_snapshot?.address && (
                <p className="text-xs text-neutral-600 whitespace-pre-line">
                  {bill.business_snapshot.address}
                </p>
              )}
              <p className="text-xs text-neutral-600">
                {bill.business_snapshot?.phone && `Ph: ${bill.business_snapshot.phone}`}
                {bill.business_snapshot?.gstin && ` · GSTIN: ${bill.business_snapshot.gstin}`}
              </p>
            </div>
          </div>

          <div className="text-right">
            <p className="font-bold">{docHeading}</p>
            <p className="font-mono font-semibold">{bill.bill_number}</p>
            <p className="text-xs text-neutral-600 tabular-nums">
              Date: {formatDate(bill.bill_date)}
            </p>
            {bill.due_date && (
              <p className="text-xs text-neutral-600 tabular-nums">
                Due: {formatDate(bill.due_date)}
              </p>
            )}
            {bill.valid_until && bill.doc_type === 'quotation' && (
              <p className="text-xs text-neutral-600 tabular-nums">
                Valid Until: {formatDate(bill.valid_until)}
              </p>
            )}
          </div>
        </div>

        <div className="border-b border-neutral-300 pb-3 flex flex-wrap justify-between gap-2 text-xs">
          <div>
            <p className="text-neutral-500 uppercase font-semibold">Bill To</p>
            <p className="font-bold text-sm">{bill.party_name}</p>
            {bill.party_phone && <p>Ph: {bill.party_phone}</p>}
            {bill.party_gstin && <p className="font-mono">GSTIN: {bill.party_gstin}</p>}
            {bill.party_address && <p className="text-neutral-600">{bill.party_address}</p>}
          </div>
          {bill.gst_applied && bill.place_of_supply_state_code && (
            <div className="text-right">
              <p className="text-neutral-500">Place of Supply</p>
              <p className="font-mono font-semibold">
                State {bill.place_of_supply_state_code} ({bill.is_interstate ? 'IGST' : 'CGST+SGST'})
              </p>
            </div>
          )}
        </div>

        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-neutral-300 text-[10px] uppercase text-neutral-600">
              <th className="py-2 pr-2">#</th>
              <th className="py-2 pr-2">Item</th>
              <th className="py-2 px-1">HSN</th>
              <th className="py-2 px-1 text-right">Qty</th>
              <th className="py-2 px-1 text-right">Rate</th>
              {bill.gst_applied && <th className="py-2 px-1 text-right">GST</th>}
              <th className="py-2 pl-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {lines.map((line) => (
              <tr key={line.id}>
                <td className="py-2 pr-2 tabular-nums">{line.line_no}</td>
                <td className="py-2 pr-2">
                  <div className="font-medium">{line.item_name}</div>
                  {Number(line.discount_pct) > 0 && (
                    <div className="text-[10px] text-neutral-500">
                      Disc: {line.discount_pct}%
                    </div>
                  )}
                </td>
                <td className="py-2 px-1 font-mono text-[10px]">{line.hsn_code || '—'}</td>
                <td className="py-2 px-1 text-right tabular-nums whitespace-nowrap">
                  {line.entered_qty} {line.entered_unit_code}
                </td>
                <td className="py-2 px-1 text-right tabular-nums">
                  {Number(line.unit_price).toFixed(2)}
                </td>
                {bill.gst_applied && (
                  <td className="py-2 px-1 text-right tabular-nums">{line.gst_rate}%</td>
                )}
                <td className="py-2 pl-1 text-right font-semibold tabular-nums">
                  {Number(line.line_total).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="pt-3 border-t border-neutral-300 grid grid-cols-1 sm:grid-cols-12 gap-4 items-start">
          <div className="sm:col-span-7 space-y-2.5 text-xs">
            <p>
              <strong>Amount in Words:</strong> {amountInWordsINR(Number(bill.grand_total))}
            </p>
            {gstSummaryRows.length > 0 && (
              <table className="w-full border border-neutral-200 text-[10px] tabular-nums">
                <thead>
                  <tr className="bg-neutral-50 border-b border-neutral-200">
                    <th className="py-1 px-1.5 text-left">GST %</th>
                    <th className="py-1 px-1.5 text-right">Taxable</th>
                    {bill.is_interstate ? (
                      <th className="py-1 px-1.5 text-right">IGST</th>
                    ) : (
                      <>
                        <th className="py-1 px-1.5 text-right">CGST</th>
                        <th className="py-1 px-1.5 text-right">SGST</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {gstSummaryRows.map((r) => (
                    <tr key={r.rate} className="border-b border-neutral-100">
                      <td className="py-1 px-1.5">{r.rate}%</td>
                      <td className="py-1 px-1.5 text-right">{r.taxable.toFixed(2)}</td>
                      {bill.is_interstate ? (
                        <td className="py-1 px-1.5 text-right">{r.igst.toFixed(2)}</td>
                      ) : (
                        <>
                          <td className="py-1 px-1.5 text-right">{r.cgst.toFixed(2)}</td>
                          <td className="py-1 px-1.5 text-right">{r.sgst.toFixed(2)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {isPayable &&
            assets.showUpiQr &&
            (assets.upiQrUrl || upiDeepLink) ? (
              <div className="flex items-center gap-3 pt-1">
                {assets.upiQrUrl ? (
                  <img
                    src={assets.upiQrUrl}
                    alt="UPI Payment QR"
                    className="w-24 h-24 object-contain rounded border border-neutral-200 bg-white p-1"
                  />
                ) : (
                  <UpiQrSvg value={upiDeepLink} size={96} />
                )}
                <div>
                  <p className="font-semibold">Scan & Pay via UPI</p>
                  {assets.upiId && <p className="font-mono text-neutral-600">{assets.upiId}</p>}
                  <p className="tabular-nums font-medium">
                    Amount:{' '}
                    {formatINR(
                      bill.doc_type === 'quotation'
                        ? Number(bill.grand_total)
                        : Number(bill.balance_due)
                    )}
                  </p>
                </div>
              </div>
            ) : (
              isPaidInvoice && (
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-emerald-600/30 bg-emerald-50 text-emerald-800 text-[11px] font-semibold">
                  <IconCheck size={14} stroke={2.5} />
                  <span>Paid in Full</span>
                </div>
              )
            )}
            {(() => {
              const snap = bill.business_snapshot;
              const ps = (snap?.pack_settings || {}) as Record<string, unknown>;
              const showBank =
                snap?.show_bank_on_invoice ??
                (typeof ps.show_bank_on_invoice === 'boolean' ? ps.show_bank_on_invoice : true);
              const bName =
                snap?.bank_name || (typeof ps.bank_name === 'string' ? ps.bank_name : '');
              const bHolder =
                snap?.bank_account_holder ||
                (typeof ps.bank_account_holder === 'string' ? ps.bank_account_holder : '');
              const bAc =
                snap?.bank_account_no ||
                (typeof ps.bank_account_no === 'string' ? ps.bank_account_no : '');
              const bIfsc =
                snap?.bank_ifsc || (typeof ps.bank_ifsc === 'string' ? ps.bank_ifsc : '');
              const bBranch =
                snap?.bank_branch ||
                (typeof ps.bank_branch === 'string' ? ps.bank_branch : '');
              const bType =
                snap?.bank_account_type ||
                (typeof ps.bank_account_type === 'string' ? ps.bank_account_type : '');
              if (!showBank || (!bName && !bAc && !bIfsc)) return null;
              return (
                <div className="pt-1.5 text-[11px] text-neutral-700 space-y-0.5">
                  <p className="font-semibold text-neutral-900">Bank Account Details</p>
                  {bName && (
                    <p>
                      Bank: <span className="font-medium">{bName}</span>
                      {bBranch ? ` (${bBranch})` : ''}
                      {bType ? ` · ${bType}` : ''}
                    </p>
                  )}
                  {bHolder && <p>A/c Holder: {bHolder}</p>}
                  {(bAc || bIfsc) && (
                    <p className="font-mono">
                      {bAc && `A/c No: ${bAc}`}
                      {bAc && bIfsc && ' · '}
                      {bIfsc && `IFSC: ${bIfsc}`}
                    </p>
                  )}
                </div>
              );
            })()}
            {bill.terms && <p className="text-[11px] text-neutral-600 whitespace-pre-line">{bill.terms}</p>}
          </div>

          <div className="sm:col-span-5 text-xs tabular-nums space-y-1">
            <div className="flex justify-between">
              <span className="text-neutral-600">Taxable Value</span>
              <span>{formatINR(Number(bill.subtotal_taxable))}</span>
            </div>
            {Number(bill.discount_total) > 0 && (
              <div className="flex justify-between">
                <span className="text-neutral-600">Total Discount</span>
                <span>-{formatINR(Number(bill.discount_total))}</span>
              </div>
            )}
            {bill.gst_applied && !bill.is_interstate && (
              <>
                <div className="flex justify-between">
                  <span className="text-neutral-600">CGST</span>
                  <span>{formatINR(Number(bill.cgst_total))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-600">SGST</span>
                  <span>{formatINR(Number(bill.sgst_total))}</span>
                </div>
              </>
            )}
            {bill.gst_applied && bill.is_interstate && (
              <div className="flex justify-between">
                <span className="text-neutral-600">IGST</span>
                <span>{formatINR(Number(bill.igst_total))}</span>
              </div>
            )}
            {Number(bill.extra_charges) > 0 && (
              <div className="flex justify-between">
                <span className="text-neutral-600">Extra Charges</span>
                <span>{formatINR(Number(bill.extra_charges))}</span>
              </div>
            )}
            {Number(bill.round_off) !== 0 && (
              <div className="flex justify-between">
                <span className="text-neutral-600">Round-off</span>
                <span>
                  {Number(bill.round_off) > 0
                    ? `+${Number(bill.round_off).toFixed(2)}`
                    : Number(bill.round_off).toFixed(2)}
                </span>
              </div>
            )}
            <div className="pt-1.5 border-t border-neutral-300 flex justify-between font-bold text-sm">
              <span>Grand Total</span>
              <span>{formatINR(Number(bill.grand_total))}</span>
            </div>
            {bill.doc_type !== 'quotation' && bill.doc_type !== 'credit_note' && (
              <>
                <div className="flex justify-between text-neutral-700">
                  <span>Paid</span>
                  <span>{formatINR(Number(bill.paid_amount))}</span>
                </div>
                {Number(bill.credited_amount) > 0 && (
                  <div className="flex justify-between text-neutral-700">
                    <span>Credited (Returns)</span>
                    <span>{formatINR(Number(bill.credited_amount))}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold">
                  <span>Balance Due</span>
                  <span>{formatINR(Number(bill.balance_due))}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
