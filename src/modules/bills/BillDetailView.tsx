import {
  IconArrowDownLeft,
  IconArrowLeft,
  IconArrowRight,
  IconBan,
  IconCopy,
  IconEdit,
  IconLink,
  IconPrinter,
  IconRefresh,
  IconRotate2,
  IconTrash,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { copyToClipboard, formatDate, formatINR } from '../../core/format';
import { amountInWordsINR } from '../../core/money';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  BillLineRecord,
  BillRecord,
  BillShareLinkRecord,
  PartyBalanceRecord,
} from '../../types/bizone';
import { PaymentModal } from '../parties/PaymentModal';
import { BillFormModal } from './BillFormModal';
import { BillPrintPreviewModal } from './BillPrintPreviewModal';
import { SalesReturnModal } from './SalesReturnModal';

interface BillDetailViewProps {
  billId: string;
  onBack: () => void;
  onOpenBill: (billId: string) => void;
  onOpenParty?: (partyId: string) => void;
  onUpdated?: () => void;
}

export function BillDetailView({
  billId,
  onBack,
  onOpenBill,
  onOpenParty,
  onUpdated,
}: BillDetailViewProps) {
  const { profile, isModuleEnabled, language, showToast, t } = useApp();

  const [bill, setBill] = useState<BillRecord | null>(null);
  const [lines, setLines] = useState<BillLineRecord[]>([]);
  const [relatedCreditNotes, setRelatedCreditNotes] = useState<BillRecord[]>([]);
  const [shareLinks, setShareLinks] = useState<BillShareLinkRecord[]>([]);
  const [linkedParty, setLinkedParty] = useState<PartyBalanceRecord | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editDraftOpen, setEditDraftOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [converting, setConverting] = useState(false);
  const [deletingDraft, setDeletingDraft] = useState(false);

  const canVoid = hasCapability(profile?.role, 'void_bill');
  const canReturn = hasCapability(profile?.role, 'sales_return');
  const paymentsEnabled =
    isModuleEnabled('payments') && hasCapability(profile?.role, 'payments');

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [billRes, linesRes, cnRes, linkRes] = await Promise.all([
        supabase
          .from('bill_list_view')
          .select('*')
          .eq('id', billId)
          .maybeSingle(),
        supabase
          .from('bill_lines')
          .select('*')
          .eq('bill_id', billId)
          .order('line_no', { ascending: true }),
        supabase
          .from('bills')
          .select('*')
          .eq('source_bill_id', billId)
          .eq('doc_type', 'credit_note')
          .order('created_at', { ascending: false }),
        supabase
          .from('bill_share_links')
          .select('*')
          .eq('bill_id', billId)
          .order('created_at', { ascending: false }),
      ]);

      if (billRes.error) throw billRes.error;
      if (linesRes.error) throw linesRes.error;
      if (cnRes.error) throw cnRes.error;
      if (linkRes.error) throw linkRes.error;

      if (!billRes.data) {
        // Fallback to raw bills in case bill was created just now or metadata needed
        const { data: rawBill, error: rawErr } = await supabase
          .from('bills')
          .select('*')
          .eq('id', billId)
          .maybeSingle();
        if (rawErr || !rawBill) throw new Error('Bill not found or access denied.');
        setBill(rawBill as BillRecord);
      } else {
        const { data: fullBill, error: fullErr } = await supabase
          .from('bills')
          .select('*')
          .eq('id', billId)
          .single();
        if (fullErr) throw fullErr;
        setBill({
          ...(fullBill as BillRecord),
          source_bill_number: (billRes.data as BillRecord).source_bill_number,
          converted_to_bill_number: (billRes.data as BillRecord).converted_to_bill_number,
        });
      }

      setLines((linesRes.data as BillLineRecord[] | null) ?? []);
      setRelatedCreditNotes((cnRes.data as BillRecord[] | null) ?? []);
      setShareLinks((linkRes.data as BillShareLinkRecord[] | null) ?? []);

      const pid = (billRes.data as BillRecord | null)?.party_id;
      if (pid && isModuleEnabled('parties')) {
        const { data: partyBal, error: partyErr } = await supabase
          .from('party_balances')
          .select('*')
          .eq('party_id', pid)
          .maybeSingle();
        if (partyErr) throw partyErr;
        setLinkedParty((partyBal as PartyBalanceRecord | null) ?? null);
      } else {
        setLinkedParty(null);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to load bill.');
    } finally {
      setLoading(false);
    }
  }, [billId, isModuleEnabled]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleConvertQuotation = async () => {
    if (!bill) return;
    setConverting(true);
    try {
      const { data, error } = await supabase.rpc('convert_quotation_to_bill', {
        p_quotation_id: bill.id,
        p_idempotency_key: `conv_${bill.id}_${crypto.randomUUID()}`,
      });
      if (error) throw error;
      const converted = data as BillRecord;
      showToast(
        language === 'hi'
          ? `कोटेशन ${converted.bill_number} में बदला गया।`
          : `Converted to invoice ${converted.bill_number}.`,
        'success'
      );
      onUpdated?.();
      onOpenBill(converted.id);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to convert quotation.',
        'error'
      );
    } finally {
      setConverting(false);
    }
  };

  const handleVoidSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bill) return;
    if (voidReason.trim().length < 3) {
      showToast('Please enter a reason (min 3 chars).', 'error');
      return;
    }
    setVoiding(true);
    try {
      const { error } = await supabase.rpc('void_bill', {
        p_bill_id: bill.id,
        p_reason: voidReason.trim(),
      });
      if (error) throw error;
      showToast(
        language === 'hi'
          ? `${bill.bill_number} रद्द (Void) किया गया।`
          : `${bill.bill_number} voided.`,
        'success'
      );
      setVoidModalOpen(false);
      setVoidReason('');
      await loadDetail();
      onUpdated?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to void bill.', 'error');
    } finally {
      setVoiding(false);
    }
  };

  const handleDeleteDraft = async () => {
    if (!bill) return;
    setDeletingDraft(true);
    try {
      const { error } = await supabase.rpc('delete_bill_draft', {
        p_bill_id: bill.id,
      });
      if (error) throw error;
      showToast('Draft deleted.', 'success');
      onUpdated?.();
      onBack();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to delete draft.',
        'error'
      );
    } finally {
      setDeletingDraft(false);
    }
  };

  if (loading && !bill) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)]"
        >
          <IconArrowLeft size={18} stroke={2} />
          <span>{t('bills.title')}</span>
        </button>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
          {t('common.loading')}
        </div>
      </div>
    );
  }

  if (loadError || !bill) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)]"
        >
          <IconArrowLeft size={18} stroke={2} />
          <span>{t('bills.title')}</span>
        </button>
        <div className="rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] p-5 flex items-center justify-between gap-4 text-sm text-[var(--give)]">
          <span>{loadError || 'Document not found.'}</span>
          <button
            type="button"
            onClick={() => void loadDetail()}
            className="h-9 px-3 rounded-lg border border-[var(--give)]/40 bg-[var(--surface)] text-xs font-medium text-[var(--text)] inline-flex items-center gap-1.5"
          >
            <IconRefresh size={14} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      </div>
    );
  }

  const docTypeLabel =
    bill.doc_type === 'tax_invoice'
      ? t('bills.taxInvoice')
      : bill.doc_type === 'bill_of_supply'
        ? t('bills.billOfSupply')
        : bill.doc_type === 'quotation'
          ? t('bills.quotation')
          : t('bills.creditNote');

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <IconArrowLeft size={16} stroke={2} />
            <span>{t('bills.title')}</span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight font-mono">
              {bill.bill_number || 'DRAFT'}
            </h1>
            <span className="text-xs font-medium text-[var(--text-muted)]">
              · {docTypeLabel} ·{' '}
              <span
                className={
                  bill.status === 'voided'
                    ? 'text-[var(--give)] font-semibold'
                    : bill.payment_status === 'paid' || bill.status === 'converted'
                      ? 'text-[var(--receive-text)] font-semibold'
                      : 'text-[var(--text)] font-semibold'
                }
              >
                {t(`bills.statuses.${bill.payment_status}`)}
              </span>
            </span>
          </div>

          <p className="text-xs sm:text-sm text-[var(--text-muted)] flex flex-wrap items-center gap-x-2">
            {bill.party_id && onOpenParty ? (
              <button
                type="button"
                onClick={() => onOpenParty(bill.party_id!)}
                className="font-medium text-[var(--primary-dark)] hover:underline"
              >
                {bill.party_name}
              </button>
            ) : (
              <span className="font-medium text-[var(--text)]">{bill.party_name}</span>
            )}
            <span>·</span>
            <span className="tabular-nums">{formatDate(bill.bill_date)}</span>
            {bill.due_date && (
              <>
                <span>·</span>
                <span className="tabular-nums">Due {formatDate(bill.due_date)}</span>
              </>
            )}
          </p>
        </div>

        {/* Action Strip */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {bill.status === 'draft' ? (
            <>
              <button
                type="button"
                onClick={() => setEditDraftOpen(true)}
                className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
              >
                <IconEdit size={16} stroke={2} />
                <span>Edit & Issue Draft</span>
              </button>
              <button
                type="button"
                disabled={deletingDraft}
                onClick={handleDeleteDraft}
                className="h-10 px-3.5 rounded-lg border border-[var(--give)]/40 text-[var(--give)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5"
              >
                <IconTrash size={16} stroke={2} />
                <span>Delete Draft</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPrintOpen(true)}
                className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
              >
                <IconPrinter size={16} stroke={2} />
                <span>{t('bills.printShare')}</span>
              </button>

              {bill.doc_type === 'quotation' && bill.status === 'issued' && (
                <button
                  type="button"
                  disabled={converting}
                  onClick={handleConvertQuotation}
                  className="h-10 px-3.5 rounded-lg border border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
                >
                  <IconArrowRight size={16} stroke={2} />
                  <span>{converting ? 'Converting...' : t('bills.convertToBill')}</span>
                </button>
              )}

              {bill.status === 'issued' &&
                (bill.doc_type === 'tax_invoice' || bill.doc_type === 'bill_of_supply') &&
                Number(bill.balance_due) > 0 &&
                paymentsEnabled &&
                linkedParty && (
                  <button
                    type="button"
                    onClick={() => setPaymentOpen(true)}
                    className="h-10 px-3.5 rounded-lg bg-[var(--receive)] text-white text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
                  >
                    <IconArrowDownLeft size={16} stroke={2} />
                    <span>{t('payments.receivePayment')}</span>
                  </button>
                )}

              {canReturn &&
                bill.status === 'issued' &&
                (bill.doc_type === 'tax_invoice' || bill.doc_type === 'bill_of_supply') && (
                  <button
                    type="button"
                    onClick={() => setReturnOpen(true)}
                    className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
                  >
                    <IconRotate2 size={16} stroke={2} />
                    <span>{t('bills.salesReturn')}</span>
                  </button>
                )}

              {canVoid && bill.status === 'issued' && bill.doc_type !== 'credit_note' && (
                <button
                  type="button"
                  onClick={() => {
                    setVoidReason('');
                    setVoidModalOpen(true);
                  }}
                  className="h-10 px-3.5 rounded-lg border border-[var(--give)]/40 text-[var(--give)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--give-soft)]"
                >
                  <IconBan size={16} stroke={2} />
                  <span>{t('bills.voidBill')}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Status Banners */}
      {bill.status === 'voided' && (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs sm:text-sm text-[var(--give)]">
          <strong>Voided:</strong> {bill.void_reason}
          {bill.voided_at ? ` · ${formatDate(bill.voided_at)}` : ''}
        </div>
      )}

      {bill.status === 'converted' && bill.converted_to_bill_id && (
        <div className="p-4 rounded-xl border border-[var(--receive)]/40 bg-[var(--receive-soft)] flex items-center justify-between gap-3 text-xs sm:text-sm text-[var(--receive-text)]">
          <span>
            Converted to invoice{' '}
            <strong className="font-mono">{bill.converted_to_bill_number || ''}</strong>
          </span>
          <button
            type="button"
            onClick={() => onOpenBill(bill.converted_to_bill_id!)}
            className="underline font-semibold"
          >
            Open Invoice
          </button>
        </div>
      )}

      {bill.source_bill_id && (
        <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] flex items-center justify-between text-xs sm:text-sm">
          <span>
            Credit Note against invoice{' '}
            <strong className="font-mono">{bill.source_bill_number || bill.source_bill_id}</strong>
          </span>
          <button
            type="button"
            onClick={() => onOpenBill(bill.source_bill_id!)}
            className="text-[var(--primary-dark)] font-semibold hover:underline"
          >
            View Original Invoice
          </button>
        </div>
      )}

      {/* Summary Numbers */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t('bills.grandTotal')}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            {formatINR(Number(bill.grand_total))}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Tax + Discount</p>
          <p className="mt-1 text-sm font-medium tabular-nums">
            Tax: {formatINR(Number(bill.tax_total))}
            {Number(bill.discount_total) > 0
              ? ` · Disc: -${formatINR(Number(bill.discount_total))}`
              : ''}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Paid / Credited</p>
          <p className="mt-1 text-sm font-medium tabular-nums text-[var(--receive-text)]">
            {formatINR(Number(bill.paid_amount))}
            {Number(bill.credited_amount) > 0
              ? ` (+ ${formatINR(Number(bill.credited_amount))} CN)`
              : ''}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">{t('bills.balanceDue')}</p>
          <p
            className={`mt-1 text-xl font-semibold tabular-nums ${
              Number(bill.balance_due) > 0 ? 'text-[var(--give)]' : 'text-[var(--receive-text)]'
            }`}
          >
            {formatINR(Number(bill.balance_due))}
          </p>
        </div>
      </section>

      {/* Immutable Lines Table */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-sm font-semibold">Line Items ({lines.length})</h2>
          <span className="text-xs text-[var(--text-muted)]">
            {bill.gst_applied
              ? bill.is_interstate
                ? t('bills.interstate')
                : t('bills.intrastate')
              : 'Non-GST / 0% Tax'}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase text-[var(--text-muted)]">
                <th className="py-2.5 px-4">#</th>
                <th className="py-2.5 px-4">Item</th>
                <th className="py-2.5 px-3 text-right">Qty</th>
                <th className="py-2.5 px-3 text-right">Rate</th>
                <th className="py-2.5 px-3 text-right">Disc</th>
                <th className="py-2.5 px-3 text-right">GST</th>
                <th className="py-2.5 px-4 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-3 px-4 tabular-nums text-[var(--text-muted)]">
                    {line.line_no}
                  </td>
                  <td className="py-3 px-4">
                    <p className="font-medium">{line.item_name}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {line.sku ? `SKU ${line.sku}` : ''}
                      {line.hsn_code ? ` · HSN ${line.hsn_code}` : ''}
                      {line.conversion_factor !== 1
                        ? ` · ${line.base_qty} base units`
                        : ''}
                    </p>
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">
                    {line.entered_qty} {line.entered_unit_code}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">
                    {formatINR(Number(line.unit_price))}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">
                    {Number(line.discount_pct) > 0
                      ? `${line.discount_pct}% (-${formatINR(Number(line.discount_amount))})`
                      : '—'}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap">
                    {bill.gst_applied
                      ? `${line.gst_rate}% (${formatINR(Number(line.tax_amount))})`
                      : '—'}
                  </td>
                  <td className="py-3 px-4 text-right font-semibold tabular-nums whitespace-nowrap">
                    {formatINR(Number(line.line_total))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-[var(--border)] bg-[var(--surface-muted)] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <span className="text-[var(--text-muted)]">
            {t('bills.amountInWords')}: <strong className="text-[var(--text)]">{amountInWordsINR(Number(bill.grand_total))}</strong>
          </span>
          {bill.notes && (
            <span className="text-[var(--text-muted)]">Note: {bill.notes}</span>
          )}
        </div>
      </section>

      {/* Related Credit Notes */}
      {relatedCreditNotes.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <h2 className="text-sm font-semibold">
              Sales Returns / Credit Notes ({relatedCreditNotes.length})
            </h2>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {relatedCreditNotes.map((cn) => (
              <button
                key={cn.id}
                type="button"
                onClick={() => onOpenBill(cn.id)}
                className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-[var(--surface-muted)] text-xs sm:text-sm"
              >
                <div>
                  <span className="font-mono font-semibold">{cn.bill_number}</span>
                  <span className="text-[var(--text-muted)]">
                    {' '}
                    · {formatDate(cn.bill_date)}
                    {cn.return_reason ? ` · ${cn.return_reason}` : ''}
                  </span>
                </div>
                <span className="font-semibold tabular-nums text-[var(--give)]">
                  -{formatINR(Number(cn.grand_total))}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Share Links summary */}
      {shareLinks.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold inline-flex items-center gap-1.5">
              <IconLink size={15} stroke={2} />
              <span>{t('bills.shareLinks')}</span>
            </span>
            <button
              type="button"
              onClick={() => setPrintOpen(true)}
              className="text-[var(--primary-dark)] font-medium hover:underline"
            >
              Manage Links
            </button>
          </div>
          {shareLinks.slice(0, 3).map((link) => {
            const url = `${window.location.origin}/?share=${encodeURIComponent(link.token)}`;
            return (
              <div key={link.id} className="flex items-center justify-between gap-2">
                <span className="font-mono truncate text-[var(--text-muted)]">{url}</span>
                {!link.is_revoked && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyToClipboard(url);
                      showToast(
                        ok ? 'Copied link.' : 'Clipboard permission denied.',
                        ok ? 'success' : 'error'
                      );
                    }}
                    className="inline-flex items-center gap-1 text-[var(--primary-dark)] font-medium shrink-0"
                  >
                    <IconCopy size={13} stroke={2} />
                    <span>{t('bills.copyLink')}</span>
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* Modals */}
      <BillFormModal
        open={editDraftOpen}
        editingDraft={bill}
        onClose={() => setEditDraftOpen(false)}
        onSaved={(saved) => {
          onUpdated?.();
          if (saved.id === bill.id) {
            void loadDetail();
          } else {
            onOpenBill(saved.id);
          }
        }}
      />

      <BillPrintPreviewModal
        open={printOpen}
        bill={bill}
        lines={lines}
        onClose={() => setPrintOpen(false)}
        onShareLinksChanged={() => void loadDetail()}
      />

      <SalesReturnModal
        open={returnOpen}
        sourceBill={bill}
        sourceLines={lines}
        onClose={() => setReturnOpen(false)}
        onCreated={() => {
          void loadDetail();
          onUpdated?.();
        }}
      />

      {linkedParty && (
        <PaymentModal
          open={paymentOpen}
          lockedParty={linkedParty}
          initialDirection="receive"
          onClose={() => setPaymentOpen(false)}
          onSaved={() => {
            void loadDetail();
            onUpdated?.();
          }}
        />
      )}

      {voidModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setVoidModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold">
              {t('bills.voidBill')} · {bill.bill_number}
            </h2>
            <p className="text-xs sm:text-sm text-[var(--text-muted)]">
              {language === 'hi'
                ? 'रद्द करने पर स्टॉक बहाल हो जाएगा और खाता प्रविष्टि समायोजित होगी। यदि भुगतान जुड़ा है तो पहले भुगतान रिवर्स करें।'
                : 'Voiding restores deducted stock and reverses the Khata bill entry. Bills with allocated payments must have those payments reversed first.'}
            </p>
            <form onSubmit={handleVoidSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('bills.voidReason')} *
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Wrong customer, cancelled order..."
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setVoidModalOpen(false)}
                  className="h-10 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={voiding}
                  className="h-10 px-4 rounded-lg bg-[var(--give)] text-white text-sm font-semibold disabled:opacity-50"
                >
                  {voiding ? 'Voiding...' : t('bills.voidBill')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
