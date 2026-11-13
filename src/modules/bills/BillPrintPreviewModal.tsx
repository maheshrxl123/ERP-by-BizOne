import {
  IconBrandWhatsapp,
  IconCheck,
  IconCopy,
  IconLink,
  IconPrinter,
  IconShare,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../app/AppProvider';
import {
  buildUpiDeepLink,
  copyToClipboard,
  formatDate,
  formatINR,
} from '../../core/format';
import { amountInWordsINR } from '../../core/money';
import { supabase } from '../../core/supabase';
import type {
  BillLineRecord,
  BillRecord,
  BillShareLinkRecord,
  PrintLayoutType,
} from '../../types/bizone';
import { UpiQrSvg } from './UpiQrSvg';

interface BillPrintPreviewModalProps {
  open: boolean;
  bill: BillRecord;
  lines: BillLineRecord[];
  onClose: () => void;
  onShareLinksChanged?: () => void;
}

export function BillPrintPreviewModal({
  open,
  bill,
  lines,
  onClose,
  onShareLinksChanged,
}: BillPrintPreviewModalProps) {
  const { business, signedUrlCache, getSignedUrl, language, showToast, t } = useApp();

  const [layout, setLayout] = useState<PrintLayoutType>(
    business?.default_print_layout || bill.business_snapshot?.default_print_layout || 'a4'
  );
  const [shareLinks, setShareLinks] = useState<BillShareLinkRecord[]>([]);
  const [expiryHours, setExpiryHours] = useState<string>('168');
  const [creatingLink, setCreatingLink] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const logoFileId =
    bill.business_snapshot?.logo_file_id || business?.logo_file_id || null;
  const qrFileId =
    bill.business_snapshot?.upi_qr_file_id || business?.upi_qr_file_id || null;
  const logoUrl = logoFileId ? signedUrlCache[logoFileId] : undefined;
  const uploadedQrUrl = qrFileId ? signedUrlCache[qrFileId] : undefined;

  const showUpiQr =
    bill.doc_type !== 'credit_note' &&
    bill.status !== 'voided' &&
    (bill.business_snapshot?.show_upi_qr_on_invoice ??
      business?.show_upi_qr_on_invoice ??
      true);
  const upiId = bill.business_snapshot?.upi_id || business?.upi_id || '';
  const qrPayAmount =
    Number(bill.balance_due) > 0 ? Number(bill.balance_due) : Number(bill.grand_total);
  const upiDeepLink = useMemo(
    () =>
      showUpiQr && upiId
        ? buildUpiDeepLink({
            upiId,
            businessName: bill.business_snapshot?.name || business?.name || 'BizOne Store',
            amount: qrPayAmount > 0 ? qrPayAmount : undefined,
            note: bill.bill_number || 'Invoice Payment',
          })
        : '',
    [showUpiQr, upiId, bill.business_snapshot?.name, business?.name, qrPayAmount, bill.bill_number]
  );

  const loadLinks = useCallback(async () => {
    if (bill.status === 'draft') {
      setShareLinks([]);
      return;
    }
    const { data } = await supabase
      .from('bill_share_links')
      .select('*')
      .eq('bill_id', bill.id)
      .order('created_at', { ascending: false });
    setShareLinks((data as BillShareLinkRecord[] | null) ?? []);
  }, [bill.id, bill.status]);

  useEffect(() => {
    if (!open) return;
    setLayout(
      business?.default_print_layout || bill.business_snapshot?.default_print_layout || 'a4'
    );
    void loadLinks();
  }, [
    open,
    bill.id,
    business?.default_print_layout,
    bill.business_snapshot?.default_print_layout,
    loadLinks,
  ]);

  useEffect(() => {
    if (!open) return;
    if (logoFileId && !signedUrlCache[logoFileId]) void getSignedUrl(logoFileId);
    if (qrFileId && !signedUrlCache[qrFileId]) void getSignedUrl(qrFileId);
  }, [open, logoFileId, qrFileId, signedUrlCache, getSignedUrl]);

  // Group GST breakdown by rate for clean Indian GST invoice footer
  const gstSummaryRows = useMemo(() => {
    if (!bill.gst_applied) return [];
    const map = new Map<
      number,
      { rate: number; taxable: number; cgst: number; sgst: number; igst: number }
    >();
    for (const l of lines) {
      const rate = Number(l.gst_rate || 0);
      const cur = map.get(rate) || { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      cur.taxable += Number(l.taxable_amount || 0);
      cur.cgst += Number(l.cgst_amount || 0);
      cur.sgst += Number(l.sgst_amount || 0);
      cur.igst += Number(l.igst_amount || 0);
      map.set(rate, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.rate - b.rate);
  }, [bill.gst_applied, lines]);

  const activeShareLink = useMemo(
    () =>
      shareLinks.find(
        (l) =>
          !l.is_revoked && (!l.expires_at || new Date(l.expires_at).getTime() > Date.now())
      ) ?? null,
    [shareLinks]
  );

  const buildShareUrl = (token: string) =>
    `${window.location.origin}/?share=${encodeURIComponent(token)}`;

  const handleCreateShareLink = async () => {
    setCreatingLink(true);
    try {
      const hours = Number(expiryHours);
      const { data, error } = await supabase.rpc('create_bill_share_link', {
        p_bill_id: bill.id,
        p_expires_in_hours: hours > 0 ? hours : null,
      });
      if (error) throw error;
      const created = data as BillShareLinkRecord;
      const shareUrl = buildShareUrl(created.token);
      const copied = await copyToClipboard(shareUrl);
      if (copied) {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 2000);
        showToast('Share link created & copied.', 'success');
      } else {
        showToast('Share link created. Copy manually below.', 'success');
      }
      await loadLinks();
      onShareLinksChanged?.();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to create share link.',
        'error'
      );
    } finally {
      setCreatingLink(false);
    }
  };

  const handleRevokeLink = async (linkId: string) => {
    setRevokingId(linkId);
    try {
      const { error } = await supabase.rpc('revoke_bill_share_link', {
        p_link_id: linkId,
      });
      if (error) throw error;
      showToast('Share link revoked.', 'success');
      await loadLinks();
      onShareLinksChanged?.();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to revoke share link.',
        'error'
      );
    } finally {
      setRevokingId(null);
    }
  };

  const docHeading =
    bill.doc_type === 'tax_invoice'
      ? 'TAX INVOICE'
      : bill.doc_type === 'bill_of_supply'
        ? 'BILL OF SUPPLY'
        : bill.doc_type === 'quotation'
          ? 'QUOTATION / ESTIMATE'
          : 'CREDIT NOTE (SALES RETURN)';

  const whatsappText = useMemo(() => {
    const sharePart = activeShareLink
      ? `\nView Invoice: ${buildShareUrl(activeShareLink.token)}`
      : '';
    return `${bill.business_snapshot?.name || business?.name || 'BizOne'}\n${docHeading}: ${bill.bill_number || 'DRAFT'}\nParty: ${bill.party_name}\nDate: ${formatDate(bill.bill_date)}\nTotal: ${formatINR(Number(bill.grand_total))}${
      Number(bill.balance_due) > 0
        ? `\nBalance Due: ${formatINR(Number(bill.balance_due))}`
        : ''
    }${sharePart}`;
  }, [bill, business?.name, docHeading, activeShareLink]);

  if (!open) return null;

  const isThermal = layout === 'thermal_80';

  return createPortal(
    <div className="print-modal-root">
      <div
        className="print-modal-overlay fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('bills.printShare')}
          className="print-modal-dialog w-full max-w-4xl max-h-[95vh] rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
        {/* Top Toolbar (no-print) */}
        <div className="no-print px-4 sm:px-5 py-3 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1.5">
            {(
              [
                { id: 'a4' as const, label: 'A4 Invoice' },
                { id: 'a5' as const, label: 'A5 Compact' },
                { id: 'thermal_80' as const, label: '80mm Thermal' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setLayout(opt.id)}
                className={`h-9 px-3 rounded-lg border text-xs font-medium ${
                  layout === opt.id
                    ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                    : 'border-[var(--border)] text-[var(--text-muted)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {bill.status !== 'draft' && (
              <>
                <select
                  aria-label="Share link expiry"
                  value={expiryHours}
                  onChange={(e) => setExpiryHours(e.target.value)}
                  className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                >
                  <option value="168">7 days</option>
                  <option value="720">30 days</option>
                  <option value="0">No expiry</option>
                </select>
                <button
                  type="button"
                  disabled={creatingLink}
                  onClick={handleCreateShareLink}
                  className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5"
                >
                  {copiedUrl ? (
                    <IconCheck size={15} stroke={2.5} className="text-[var(--receive-text)]" />
                  ) : (
                    <IconLink size={15} stroke={2} />
                  )}
                  <span>
                    {creatingLink ? 'Creating...' : t('bills.createShareLink')}
                  </span>
                </button>
              </>
            )}

            <a
              href={`https://wa.me/${(bill.party_phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(
                whatsappText
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              <IconBrandWhatsapp size={15} stroke={2} className="text-[var(--receive-text)]" />
              <span>WhatsApp</span>
            </a>

            <button
              type="button"
              onClick={() => window.print()}
              className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <IconPrinter size={15} stroke={2} />
              <span>{t('parties.printPdf')}</span>
            </button>

            <button
              type="button"
              aria-label={t('common.close')}
              onClick={onClose}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)]"
            >
              <IconX size={18} stroke={2} />
            </button>
          </div>
        </div>

        {/* Printable Document Preview */}
        <div className="print-modal-body flex-1 overflow-y-auto bg-[var(--surface-muted)] p-3 sm:p-6">
          <div
            className={`print-surface bg-white text-neutral-900 mx-auto border border-neutral-300 rounded-xl shadow-xs ${
              isThermal
                ? 'print-layout-thermal_80 max-w-[320px] p-3 text-[11px] font-mono'
                : layout === 'a5'
                  ? 'print-layout-a5 max-w-[560px] p-5 text-xs'
                  : 'print-layout-a4 max-w-[780px] p-6 sm:p-8 text-xs sm:text-sm'
            }`}
          >
            {bill.status === 'voided' && (
              <div className="mb-3 px-3 py-1.5 rounded border border-red-600 text-red-700 text-center font-bold uppercase tracking-wider text-xs">
                VOIDED DOCUMENT · {bill.void_reason}
              </div>
            )}

            {/* Business Header */}
            <div
              className={`border-b border-neutral-300 pb-3 ${
                isThermal ? 'text-center space-y-1' : 'flex items-start justify-between gap-4'
              }`}
            >
              <div className={isThermal ? 'space-y-1' : 'flex items-start gap-3'}>
                {logoUrl && (
                  <img
                    src={logoUrl}
                    alt="Logo"
                    className={`object-contain border border-neutral-200 rounded ${
                      isThermal ? 'w-12 h-12 mx-auto' : 'w-14 h-14 shrink-0'
                    }`}
                  />
                )}
                <div>
                  <h3 className={isThermal ? 'text-sm font-bold' : 'text-lg font-bold'}>
                    {bill.business_snapshot?.name || business?.name || 'BizOne'}
                  </h3>
                  {(bill.business_snapshot?.address || business?.address) && (
                    <p className="text-[11px] text-neutral-600 whitespace-pre-line">
                      {bill.business_snapshot?.address || business?.address}
                    </p>
                  )}
                  <p className="text-[11px] text-neutral-600">
                    {(bill.business_snapshot?.phone || business?.phone) &&
                      `Ph: ${bill.business_snapshot?.phone || business?.phone}`}
                    {(bill.business_snapshot?.gstin || business?.gstin) &&
                      ` · GSTIN: ${bill.business_snapshot?.gstin || business?.gstin}`}
                  </p>
                </div>
              </div>

              <div className={isThermal ? 'pt-1 border-t border-dashed border-neutral-300' : 'text-right shrink-0'}>
                <p className="font-bold tracking-wide text-neutral-900">{docHeading}</p>
                <p className="font-mono font-semibold tabular-nums">
                  {bill.bill_number || 'DRAFT'}
                </p>
                <p className="text-[11px] text-neutral-600 tabular-nums">
                  Date: {formatDate(bill.bill_date)}
                </p>
                {bill.due_date && (
                  <p className="text-[11px] text-neutral-600 tabular-nums">
                    Due: {formatDate(bill.due_date)}
                  </p>
                )}
              </div>
            </div>

            {/* Bill To Block */}
            <div className="py-2.5 border-b border-neutral-300 flex flex-wrap justify-between gap-2 text-[11px]">
              <div>
                <p className="text-neutral-500 uppercase font-semibold">Bill To</p>
                <p className="font-bold text-neutral-900 text-xs">{bill.party_name}</p>
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

            {/* Lines */}
            <table className="w-full text-left border-collapse my-2">
              <thead>
                <tr className="border-b border-neutral-300 text-[10px] uppercase text-neutral-600">
                  <th className="py-1.5 pr-2">#</th>
                  <th className="py-1.5 pr-2">Item</th>
                  {!isThermal && <th className="py-1.5 px-1">HSN</th>}
                  <th className="py-1.5 px-1 text-right">Qty</th>
                  <th className="py-1.5 px-1 text-right">Rate</th>
                  {!isThermal && bill.gst_applied && (
                    <th className="py-1.5 px-1 text-right">GST</th>
                  )}
                  <th className="py-1.5 pl-1 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 text-[11px]">
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-1.5 pr-2 tabular-nums">{line.line_no}</td>
                    <td className="py-1.5 pr-2">
                      <div className="font-medium">{line.item_name}</div>
                      {Number(line.discount_pct) > 0 && (
                        <div className="text-[10px] text-neutral-500">
                          Disc: {line.discount_pct}%
                        </div>
                      )}
                    </td>
                    {!isThermal && (
                      <td className="py-1.5 px-1 font-mono text-[10px]">
                        {line.hsn_code || '—'}
                      </td>
                    )}
                    <td className="py-1.5 px-1 text-right tabular-nums whitespace-nowrap">
                      {line.entered_qty} {line.entered_unit_code}
                    </td>
                    <td className="py-1.5 px-1 text-right tabular-nums whitespace-nowrap">
                      {Number(line.unit_price).toFixed(2)}
                    </td>
                    {!isThermal && bill.gst_applied && (
                      <td className="py-1.5 px-1 text-right tabular-nums whitespace-nowrap">
                        {line.gst_rate}%
                      </td>
                    )}
                    <td className="py-1.5 pl-1 text-right font-semibold tabular-nums whitespace-nowrap">
                      {Number(line.line_total).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals & QR Footer */}
            <div className="pt-3 border-t border-neutral-300 grid grid-cols-1 sm:grid-cols-12 gap-4 items-start">
              <div className={isThermal ? 'order-2 space-y-2' : 'sm:col-span-7 space-y-2.5'}>
                <p className="text-[11px]">
                  <span className="font-semibold">{t('bills.amountInWords')}:</span>{' '}
                  {amountInWordsINR(Number(bill.grand_total))}
                </p>

                {!isThermal && gstSummaryRows.length > 0 && (
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

                {showUpiQr && (uploadedQrUrl || upiDeepLink) && (
                  <div className="pt-1 flex items-center gap-3">
                    {uploadedQrUrl ? (
                      <img
                        src={uploadedQrUrl}
                        alt="UPI Payment QR"
                        className="w-24 h-24 object-contain rounded border border-neutral-200 bg-white p-1"
                      />
                    ) : (
                      <UpiQrSvg value={upiDeepLink} size={96} />
                    )}
                    <div className="text-[11px]">
                      <p className="font-semibold">{t('bills.payViaUpi')}</p>
                      {upiId && <p className="font-mono text-neutral-600">{upiId}</p>}
                      {qrPayAmount > 0 && (
                        <p className="tabular-nums font-medium">
                          Amount: {formatINR(qrPayAmount)}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {bill.terms && (
                  <p className="text-[10px] text-neutral-600 whitespace-pre-line">
                    {bill.terms}
                  </p>
                )}
              </div>

              <div className={isThermal ? 'order-1' : 'sm:col-span-5'}>
                <dl className="space-y-1 text-[11px] tabular-nums">
                  <div className="flex justify-between">
                    <dt className="text-neutral-600">{t('bills.taxableSubtotal')}</dt>
                    <dd>{formatINR(Number(bill.subtotal_taxable))}</dd>
                  </div>
                  {Number(bill.discount_total) > 0 && (
                    <div className="flex justify-between">
                      <dt className="text-neutral-600">{t('bills.discountTotal')}</dt>
                      <dd>-{formatINR(Number(bill.discount_total))}</dd>
                    </div>
                  )}
                  {bill.gst_applied && !bill.is_interstate && (
                    <>
                      <div className="flex justify-between">
                        <dt className="text-neutral-600">CGST</dt>
                        <dd>{formatINR(Number(bill.cgst_total))}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-neutral-600">SGST</dt>
                        <dd>{formatINR(Number(bill.sgst_total))}</dd>
                      </div>
                    </>
                  )}
                  {bill.gst_applied && bill.is_interstate && (
                    <div className="flex justify-between">
                      <dt className="text-neutral-600">IGST</dt>
                      <dd>{formatINR(Number(bill.igst_total))}</dd>
                    </div>
                  )}
                  {Number(bill.extra_charges) > 0 && (
                    <div className="flex justify-between">
                      <dt className="text-neutral-600">{t('bills.extraCharges')}</dt>
                      <dd>{formatINR(Number(bill.extra_charges))}</dd>
                    </div>
                  )}
                  {Number(bill.round_off) !== 0 && (
                    <div className="flex justify-between">
                      <dt className="text-neutral-600">{t('bills.roundOff')}</dt>
                      <dd>
                        {Number(bill.round_off) > 0
                          ? `+${Number(bill.round_off).toFixed(2)}`
                          : Number(bill.round_off).toFixed(2)}
                      </dd>
                    </div>
                  )}
                  <div className="pt-1.5 border-t border-neutral-300 flex justify-between font-bold text-sm">
                    <dt>{t('bills.grandTotal')}</dt>
                    <dd>{formatINR(Number(bill.grand_total))}</dd>
                  </div>
                  {bill.doc_type !== 'quotation' && bill.doc_type !== 'credit_note' && (
                    <>
                      <div className="flex justify-between text-neutral-700">
                        <dt>Paid</dt>
                        <dd>{formatINR(Number(bill.paid_amount))}</dd>
                      </div>
                      {Number(bill.credited_amount) > 0 && (
                        <div className="flex justify-between text-neutral-700">
                          <dt>Credited (Returns)</dt>
                          <dd>{formatINR(Number(bill.credited_amount))}</dd>
                        </div>
                      )}
                      <div className="flex justify-between font-semibold">
                        <dt>{t('bills.balanceDue')}</dt>
                        <dd>{formatINR(Number(bill.balance_due))}</dd>
                      </div>
                    </>
                  )}
                </dl>
              </div>
            </div>
          </div>

          {/* Share Links Manager (no-print) */}
          {shareLinks.length > 0 && (
            <div className="no-print max-w-[780px] mx-auto mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <IconShare size={15} stroke={2} />
                <span>{t('bills.shareLinks')}</span>
              </div>
              <div className="divide-y divide-[var(--border)] text-xs">
                {shareLinks.map((link) => {
                  const fullUrl = buildShareUrl(link.token);
                  const expired = Boolean(
                    link.expires_at && new Date(link.expires_at).getTime() <= Date.now()
                  );
                  return (
                    <div
                      key={link.id}
                      className="py-2 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-mono truncate">{fullUrl}</p>
                        <p className="text-[11px] text-[var(--text-muted)]">
                          {link.is_revoked
                            ? 'Revoked'
                            : expired
                              ? 'Expired'
                              : link.expires_at
                                ? `Expires ${formatDate(link.expires_at)}`
                                : 'No expiry'}{' '}
                          · Views: {link.view_count}
                        </p>
                      </div>
                      {!link.is_revoked && !expired && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = await copyToClipboard(fullUrl);
                              showToast(
                                ok ? 'Link copied.' : 'Clipboard permission denied.',
                                ok ? 'success' : 'error'
                              );
                            }}
                            className="h-8 px-2.5 rounded border border-[var(--border)] inline-flex items-center gap-1 hover:bg-[var(--surface-muted)]"
                          >
                            <IconCopy size={13} stroke={2} />
                            <span>{t('bills.copyLink')}</span>
                          </button>
                          <button
                            type="button"
                            disabled={revokingId === link.id}
                            onClick={() => handleRevokeLink(link.id)}
                            className="h-8 px-2.5 rounded border border-[var(--give)]/40 text-[var(--give)] inline-flex items-center gap-1 hover:bg-[var(--give-soft)] disabled:opacity-50"
                          >
                            <IconTrash size={13} stroke={2} />
                            <span>
                              {revokingId === link.id ? 'Revoking...' : t('bills.revokeLink')}
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </div>,
    document.body
  );
}
