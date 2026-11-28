import { IconAlertCircle, IconArrowBackUp, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatINR, todayLocalIso } from '../../core/format';
import { calculateBillPreview, roundHalfUp } from '../../core/money';
import { supabase } from '../../core/supabase';
import type {
  PaymentMode,
  PurchaseBillRecord,
  PurchaseLineRecord,
} from '../../types/decorbiz';

interface PurchaseReturnModalProps {
  open: boolean;
  sourcePurchase: PurchaseBillRecord | null;
  sourceLines: PurchaseLineRecord[];
  onClose: () => void;
  onReturned: (retDoc: PurchaseBillRecord) => void;
}

export function PurchaseReturnModal({
  open,
  sourcePurchase,
  sourceLines,
  onClose,
  onReturned,
}: PurchaseReturnModalProps) {
  const { profile, isModuleEnabled, language, showToast, t } = useApp();
  const paymentsEnabled = isModuleEnabled('payments');
  const isStorekeeper = profile?.role === 'storekeeper';

  const [returnDate, setReturnDate] = useState(todayLocalIso());
  const [reason, setReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('0');
  const [refundMode, setRefundMode] = useState<PaymentMode>('cash');
  const [qtyByLineId, setQtyByLineId] = useState<Record<string, string>>({});
  const [alreadyReturnedByLineId, setAlreadyReturnedByLineId] = useState<Record<string, number>>({});
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sourcePurchase) return;
    submittingRef.current = false;
    setReturnDate(todayLocalIso());
    setReason('');
    setRefundAmount('0');
    setRefundMode('cash');
    setErrorMsg(null);
    setIdempotencyKey(`pr_${crypto.randomUUID()}`);

    const loadPriorReturns = async () => {
      const { data: priorRets } = await supabase
        .from('purchase_bills')
        .select('id')
        .eq('source_purchase_id', sourcePurchase.id)
        .eq('doc_type', 'purchase_return')
        .neq('status', 'voided');

      const retIds = ((priorRets as Array<{ id: string }> | null) ?? []).map((r) => r.id);
      const returnedMap: Record<string, number> = {};
      if (retIds.length > 0) {
        const { data: retLines } = await supabase
          .from('purchase_lines')
          .select('source_purchase_line_id, entered_qty')
          .in('purchase_id', retIds);
        for (const rl of (retLines as Array<{ source_purchase_line_id: string | null; entered_qty: number }> | null) ?? []) {
          if (rl.source_purchase_line_id) {
            returnedMap[rl.source_purchase_line_id] =
              (returnedMap[rl.source_purchase_line_id] ?? 0) + Number(rl.entered_qty);
          }
        }
      }
      setAlreadyReturnedByLineId(returnedMap);

      const initialQty: Record<string, string> = {};
      for (const l of sourceLines) {
        const rem = Math.max(0, roundHalfUp(Number(l.entered_qty) - (returnedMap[l.id] ?? 0), 3));
        initialQty[l.id] = rem > 0 ? String(rem) : '0';
      }
      setQtyByLineId(initialQty);
    };

    void loadPriorReturns();
  }, [open, sourcePurchase, sourceLines]);

  const preview = useMemo(() => {
    if (!sourcePurchase) return null;
    const selectedLines = sourceLines
      .map((l) => {
        const qty = Math.max(0, Number(qtyByLineId[l.id] || 0));
        return { l, qty };
      })
      .filter((x) => x.qty > 0);

    if (selectedLines.length === 0) return null;

    return calculateBillPreview({
      gstRegistered: sourcePurchase.gst_applied,
      docType: sourcePurchase.gst_applied ? 'tax_invoice' : 'bill_of_supply',
      isInterstate: sourcePurchase.is_interstate,
      extraCharges: 0,
      autoRoundOff: sourcePurchase.auto_round_off ?? true,
      lines: selectedLines.map(({ l, qty }) => ({
        enteredQty: qty,
        unitPrice: Number(l.unit_cost),
        discountPct: Number(l.discount_pct),
        taxInclusive: Boolean(l.tax_inclusive),
        gstRate: Number(l.gst_rate),
      })),
    });
  }, [sourcePurchase, sourceLines, qtyByLineId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || !sourcePurchase || !preview) return;
    setErrorMsg(null);

    if (reason.trim().length < 3) {
      setErrorMsg('Please enter a return reason (minimum 3 characters).');
      return;
    }

    const reqLines = sourceLines
      .map((l) => ({
        source_purchase_line_id: l.id,
        entered_qty: Math.max(0, Number(qtyByLineId[l.id] || 0)),
      }))
      .filter((x) => x.entered_qty > 0);

    if (reqLines.length === 0) {
      setErrorMsg('Enter a positive return quantity for at least one line.');
      return;
    }

    const numericRefund =
      sourcePurchase.party_id && (!paymentsEnabled || isStorekeeper)
        ? 0
        : Math.min(preview.grandTotal, Math.max(0, roundHalfUp(Number(refundAmount || 0), 2)));

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('create_purchase_return', {
        p_source_purchase_id: sourcePurchase.id,
        p_lines: reqLines,
        p_return_date: returnDate || todayLocalIso(),
        p_refund_amount: numericRefund,
        p_refund_mode: refundMode,
        p_reason: reason.trim(),
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      const doc = data as PurchaseBillRecord;
      showToast(
        language === 'hi'
          ? `खरीद वापसी ${doc.purchase_number} दर्ज की गई।`
          : `Purchase Return ${doc.purchase_number} posted.`,
        'success'
      );
      onReturned(doc);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to post purchase return.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (!open || !sourcePurchase) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('purchases.purchaseReturn')}
        className="w-full sm:max-w-2xl max-h-[92vh] rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconArrowBackUp size={19} stroke={2} className="text-[var(--primary-dark)]" />
            <h2 className="text-base font-semibold">
              {t('purchases.purchaseReturn')} · {sourcePurchase.purchase_number}
            </h2>
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

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs text-[var(--give)] flex items-start gap-2">
              <IconAlertCircle size={16} stroke={2} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-xs sm:text-sm border-collapse">
              <thead>
                <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                  <th className="text-left px-3 py-2 font-medium">Item</th>
                  <th className="text-right px-3 py-2 font-medium">Max Returnable</th>
                  <th className="text-right px-3 py-2 font-medium w-28">Return Qty</th>
                </tr>
              </thead>
              <tbody>
                {sourceLines.map((l) => {
                  const maxRem = Math.max(
                    0,
                    roundHalfUp(Number(l.entered_qty) - (alreadyReturnedByLineId[l.id] ?? 0), 3)
                  );
                  return (
                    <tr key={l.id} className="border-b border-[var(--border)] last:border-b-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.item_name}</div>
                        <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                          {formatINR(l.unit_cost)} / {l.entered_unit_code}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">
                        {maxRem} {l.entered_unit_code}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          max={maxRem}
                          disabled={maxRem <= 0}
                          value={qtyByLineId[l.id] ?? '0'}
                          onChange={(e) =>
                            setQtyByLineId((prev) => ({ ...prev, [l.id]: e.target.value }))
                          }
                          className="w-full h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Return Date
              </label>
              <input
                type="date"
                value={returnDate}
                onChange={(e) => setReturnDate(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Return Total
              </label>
              <div className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-end font-semibold text-sm tabular-nums">
                {formatINR(preview?.grandTotal ?? 0)}
              </div>
            </div>
          </div>

          {sourcePurchase.party_id && paymentsEnabled && !isStorekeeper ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  Supplier Cash/UPI Refund Received (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  max={preview?.grandTotal ?? 0}
                  step="0.01"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-right tabular-nums"
                />
                <p className="text-[11px] text-[var(--text-muted)] mt-1">
                  Leave ₹0 to reduce your payable balance in Supplier Khata.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  Refund Mode
                </label>
                <select
                  value={refundMode}
                  onChange={(e) => setRefundMode(e.target.value as PaymentMode)}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {(['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'] as PaymentMode[]).map((m) => (
                    <option key={m} value={m}>
                      {t(`payments.modes.${m}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              {t('bills.returnReason')} *
            </label>
            <input
              type="text"
              required
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Damaged cartons, wrong item supplied, expired stock..."
              className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-xl border border-[var(--border)] text-sm font-medium"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting || !preview}
              className="h-10 px-5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-slate-950 font-semibold text-sm disabled:opacity-50"
            >
              {submitting ? t('common.loading') : t('purchases.purchaseReturn')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
