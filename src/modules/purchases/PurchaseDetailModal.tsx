import {
  IconArrowBackUp,
  IconBan,
  IconDownload,
  IconEdit,
  IconFileText,
  IconPrinter,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { printReportHtml } from '../../core/export';
import { formatDate, formatINR } from '../../core/format';
import { supabase } from '../../core/supabase';
import type { PurchaseBillRecord, PurchaseLineRecord } from '../../types/bizone';
import { PurchaseReturnModal } from './PurchaseReturnModal';

interface PurchaseDetailModalProps {
  purchase: PurchaseBillRecord | null;
  onClose: () => void;
  onEditDraft: (draft: PurchaseBillRecord) => void;
  onChanged: () => void;
}

export function PurchaseDetailModal({
  purchase,
  onClose,
  onEditDraft,
  onChanged,
}: PurchaseDetailModalProps) {
  const { business, profile, session, language, showToast, t } = useApp();
  const [lines, setLines] = useState<PurchaseLineRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [attachmentName, setAttachmentName] = useState<string | null>(null);
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [showVoidBox, setShowVoidBox] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy] = useState(false);

  const canVoid = profile?.role === 'owner' || profile?.role === 'manager';

  const loadDetails = useCallback(async () => {
    if (!purchase) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('purchase_lines')
        .select('*')
        .eq('purchase_id', purchase.id)
        .order('line_no', { ascending: true });
      if (error) throw error;
      setLines((data as PurchaseLineRecord[] | null) ?? []);

      if (purchase.attachment_file_id && session?.access_token) {
        const res = await fetch('/api/files/signed-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ fileId: purchase.attachment_file_id }),
        });
        const json = await res.json();
        if (res.ok && json.signedUrl) {
          setAttachmentUrl(json.signedUrl);
          setAttachmentName(json.file?.file_name || 'supplier-bill');
        } else {
          setAttachmentUrl(null);
        }
      } else {
        setAttachmentUrl(null);
        setAttachmentName(null);
      }
    } catch {
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [purchase, session?.access_token]);

  useEffect(() => {
    setShowVoidBox(false);
    setVoidReason('');
    void loadDetails();
  }, [loadDetails]);

  if (!purchase) return null;

  const handleDeleteDraft = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc('delete_purchase_draft', {
        p_id: purchase.id,
      });
      if (error) throw error;
      showToast('Purchase draft deleted.', 'success');
      onChanged();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (voidReason.trim().length < 3) {
      showToast('Enter a void reason (min 3 characters).', 'error');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc('void_purchase', {
        p_purchase_id: purchase.id,
        p_reason: voidReason.trim(),
      });
      if (error) throw error;
      showToast(`${purchase.purchase_number} voided.`, 'success');
      onChanged();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to void purchase.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePrint = () => {
    printReportHtml(
      `${purchase.doc_type === 'purchase_return' ? 'Purchase Return' : 'Purchase Bill'} · ${purchase.purchase_number || 'DRAFT'}`,
      `Supplier: ${purchase.party_name} · Date: ${formatDate(purchase.bill_date)} · Total: ${formatINR(purchase.grand_total)}`,
      ['#', 'Item', 'Qty', 'Unit', 'Cost', 'Tax', 'Total'],
      lines.map((l, idx) => [
        idx + 1,
        l.item_name,
        l.entered_qty,
        l.entered_unit_code,
        formatINR(l.unit_cost),
        formatINR(l.tax_amount),
        formatINR(l.line_total),
      ]),
      business?.name
    );
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          className="w-full sm:max-w-3xl max-h-[92vh] rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base sm:text-lg font-semibold">
                {purchase.purchase_number || (language === 'hi' ? 'खरीद ड्राफ्ट' : 'Purchase Draft')}
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                {purchase.party_name} · {formatDate(purchase.bill_date)}
                {purchase.supplier_invoice_no ? ` · Inv #${purchase.supplier_invoice_no}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            >
              <IconX size={18} stroke={2} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                <div className="text-[var(--text-muted)]">Status</div>
                <div className="font-semibold mt-0.5 capitalize">{purchase.payment_status}</div>
              </div>
              <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                <div className="text-[var(--text-muted)]">Grand Total</div>
                <div className="font-semibold mt-0.5 tabular-nums">{formatINR(purchase.grand_total)}</div>
              </div>
              <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                <div className="text-[var(--text-muted)]">Paid / Credited</div>
                <div className="font-semibold mt-0.5 tabular-nums text-[var(--receive-text)]">
                  {formatINR(purchase.paid_amount + purchase.credited_amount)}
                </div>
              </div>
              <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                <div className="text-[var(--text-muted)]">Balance Payable</div>
                <div className="font-semibold mt-0.5 tabular-nums text-[var(--give)]">
                  {formatINR(purchase.balance_due)}
                </div>
              </div>
            </div>

            {attachmentUrl && (
              <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-medium truncate">
                  <IconFileText size={16} stroke={2} className="text-[var(--primary-dark)] shrink-0" />
                  <span className="truncate">{attachmentName}</span>
                </div>
                <a
                  href={attachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium hover:bg-[var(--surface-muted)] shrink-0"
                >
                  <IconDownload size={14} stroke={2} />
                  <span>View Attachment</span>
                </a>
              </div>
            )}

            <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
              <table className="w-full text-xs sm:text-sm border-collapse">
                <thead>
                  <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="text-left px-3 py-2 font-medium">Item</th>
                    <th className="text-right px-3 py-2 font-medium">Qty</th>
                    <th className="text-right px-3 py-2 font-medium">Cost</th>
                    <th className="text-right px-3 py-2 font-medium">GST</th>
                    <th className="text-right px-3 py-2 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-[var(--text-muted)]">
                        {t('common.loading')}
                      </td>
                    </tr>
                  ) : (
                    lines.map((l) => (
                      <tr key={l.id} className="border-b border-[var(--border)] last:border-b-0">
                        <td className="px-3 py-2">
                          <div className="font-medium">{l.item_name}</div>
                          {l.hsn_code && (
                            <div className="text-[11px] text-[var(--text-muted)]">HSN {l.hsn_code}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {l.entered_qty} {l.entered_unit_code}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.unit_cost)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatINR(l.tax_amount)} ({l.gst_rate}%)
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">
                          {formatINR(l.line_total)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {purchase.notes && (
              <p className="text-xs text-[var(--text-muted)]">
                <strong>Notes:</strong> {purchase.notes}
              </p>
            )}

            {showVoidBox && (
              <form onSubmit={handleVoid} className="p-3 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] space-y-2.5">
                <label className="block text-xs font-semibold text-[var(--give)]">
                  Void Purchase Bill (Reverses stock & supplier Khata)
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="Enter reason for voiding..."
                  className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowVoidBox(false)}
                    className="h-8 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="h-8 px-3 rounded-lg bg-[var(--give)] text-white text-xs font-semibold"
                  >
                    {busy ? 'Voiding...' : 'Confirm Void'}
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="px-5 py-3.5 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {purchase.status === 'draft' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onEditDraft(purchase);
                      onClose();
                    }}
                    className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-slate-950 font-semibold text-xs inline-flex items-center gap-1.5"
                  >
                    <IconEdit size={15} stroke={2} />
                    <span>Edit Draft</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDeleteDraft()}
                    className="h-9 px-3.5 rounded-lg border border-[var(--give)]/40 text-[var(--give)] text-xs font-medium inline-flex items-center gap-1.5"
                  >
                    <IconTrash size={15} stroke={2} />
                    <span>Delete Draft</span>
                  </button>
                </>
              )}

              {purchase.status === 'posted' && purchase.doc_type === 'purchase_bill' && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowReturnModal(true)}
                    className="h-9 px-3.5 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
                  >
                    <IconArrowBackUp size={15} stroke={2} />
                    <span>{t('purchases.purchaseReturn')}</span>
                  </button>
                  {canVoid && (
                    <button
                      type="button"
                      onClick={() => setShowVoidBox(true)}
                      className="h-9 px-3.5 rounded-lg border border-[var(--give)]/40 text-[var(--give)] text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <IconBan size={15} stroke={2} />
                      <span>{t('purchases.voidPurchase')}</span>
                    </button>
                  )}
                </>
              )}
            </div>

            <button
              type="button"
              onClick={handlePrint}
              className="h-9 px-3.5 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              <IconPrinter size={15} stroke={2} />
              <span>{t('common.print')}</span>
            </button>
          </div>
        </div>
      </div>

      <PurchaseReturnModal
        open={showReturnModal}
        sourcePurchase={purchase}
        sourceLines={lines}
        onClose={() => setShowReturnModal(false)}
        onReturned={() => {
          onChanged();
          onClose();
        }}
      />
    </>
  );
}
