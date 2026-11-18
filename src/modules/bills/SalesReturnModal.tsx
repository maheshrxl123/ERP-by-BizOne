import { IconAlertCircle, IconCheck, IconRotate2, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatINR, todayLocalIso } from '../../core/format';
import { calculateBillPreview, roundHalfUp } from '../../core/money';
import { supabase } from '../../core/supabase';
import type { BillLineRecord, BillRecord, PaymentMode } from '../../types/bizone';

interface SalesReturnModalProps {
  open: boolean;
  sourceBill: BillRecord;
  sourceLines: BillLineRecord[];
  onClose: () => void;
  onCreated: (creditNote: BillRecord) => void;
}

export function SalesReturnModal({
  open,
  sourceBill,
  sourceLines,
  onClose,
  onCreated,
}: SalesReturnModalProps) {
  const { business, isModuleEnabled, language, showToast, t } = useApp();

  const [alreadyReturnedByLine, setAlreadyReturnedByLine] = useState<
    Record<string, number>
  >({});
  const [returnQtyByLine, setReturnQtyByLine] = useState<Record<string, string>>({});
  const [returnDate, setReturnDate] = useState(todayLocalIso());
  const [reason, setReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('0');
  const [refundMode, setRefundMode] = useState<PaymentMode>('cash');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setReason('');
    setRefundAmount('0');
    setRefundMode('cash');
    setReturnDate(todayLocalIso());
    setIdempotencyKey(`ret_${crypto.randomUUID()}`);

    const loadReturned = async () => {
      setLoadingPrev(true);
      try {
        const { data: cnBills, error: cnBillsErr } = await supabase
          .from('bills')
          .select('id')
          .eq('source_bill_id', sourceBill.id)
          .eq('doc_type', 'credit_note')
          .neq('status', 'voided');
        if (cnBillsErr) throw cnBillsErr;

        const cnIds = ((cnBills as Array<{ id: string }> | null) ?? []).map((b) => b.id);
        const map: Record<string, number> = {};
        if (cnIds.length > 0) {
          const { data: cnLines, error: cnLinesErr } = await supabase
            .from('bill_lines')
            .select('source_bill_line_id, entered_qty')
            .in('bill_id', cnIds);
          if (cnLinesErr) throw cnLinesErr;
          for (const row of (cnLines as Array<{
            source_bill_line_id: string | null;
            entered_qty: number;
          }> | null) ?? []) {
            if (!row.source_bill_line_id) continue;
            map[row.source_bill_line_id] =
              (map[row.source_bill_line_id] || 0) + Number(row.entered_qty || 0);
          }
        }
        setAlreadyReturnedByLine(map);
        const initialQtys: Record<string, string> = {};
        for (const sl of sourceLines) {
          initialQtys[sl.id] = '';
        }
        setReturnQtyByLine(initialQtys);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Unable to load prior return history.'
        );
      } finally {
        setLoadingPrev(false);
      }
    };

    void loadReturned();
  }, [open, sourceBill.id, sourceLines]);

  const selectedReturnLines = useMemo(() => {
    return sourceLines
      .map((sl) => {
        const returnedAlready = alreadyReturnedByLine[sl.id] || 0;
        const returnable = Math.max(0, roundHalfUp(Number(sl.entered_qty) - returnedAlready, 3));
        const reqQty = Math.max(0, roundHalfUp(Number(returnQtyByLine[sl.id] || 0), 3));
        return { sl, returnedAlready, returnable, reqQty };
      })
      .filter((x) => x.reqQty > 0);
  }, [sourceLines, alreadyReturnedByLine, returnQtyByLine]);

  const previewCalc = useMemo(
    () =>
      calculateBillPreview({
        gstRegistered: Boolean(sourceBill.gst_applied),
        taxModuleEnabled: Boolean(sourceBill.gst_applied),
        docType:
          sourceBill.doc_type === 'bill_of_supply' ? 'bill_of_supply' : 'credit_note',
        businessStateCode: business?.state_code || 'XX',
        placeOfSupplyStateCode: sourceBill.is_interstate ? 'YY' : business?.state_code || 'XX',
        extraCharges: 0,
        autoRoundOff: sourceBill.auto_round_off,
        lines: selectedReturnLines.map(({ sl, reqQty }) => ({
          enteredQty: reqQty,
          unitPrice: Number(sl.unit_price),
          discountPct: Number(sl.discount_pct),
          gstRate: Number(sl.gst_rate),
          taxInclusive: Boolean(sl.tax_inclusive),
        })),
      }),
    [sourceBill, business?.state_code, selectedReturnLines]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (selectedReturnLines.length === 0) {
      setErrorMsg(
        language === 'hi'
          ? 'कम से कम एक आइटम की वापसी मात्रा दर्ज करें।'
          : 'Enter a return quantity for at least one item.'
      );
      return;
    }

    for (const item of selectedReturnLines) {
      if (item.reqQty > item.returnable) {
        setErrorMsg(
          `Return qty for "${item.sl.item_name}" exceeds returnable balance (${item.returnable} ${item.sl.entered_unit_code}).`
        );
        return;
      }
    }

    if (reason.trim().length < 3) {
      setErrorMsg(
        language === 'hi'
          ? 'कम से कम 3 अक्षरों का कारण लिखें।'
          : 'Please enter a return reason (at least 3 characters).'
      );
      return;
    }

    const refundVal = roundHalfUp(Number(refundAmount || 0), 2);
    if (refundVal < 0 || refundVal > previewCalc.grandTotal) {
      setErrorMsg(
        `Refund amount must be between ₹0 and ${formatINR(previewCalc.grandTotal)}.`
      );
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('create_sales_return', {
        p_source_bill_id: sourceBill.id,
        p_lines: selectedReturnLines.map((x) => ({
          source_bill_line_id: x.sl.id,
          entered_qty: x.reqQty,
        })),
        p_return_date: returnDate || todayLocalIso(),
        p_refund_amount: refundVal,
        p_refund_mode: refundMode,
        p_reason: reason.trim(),
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      const cn = data as BillRecord;
      showToast(
        language === 'hi'
          ? `क्रेडिट नोट ${cn.bill_number} बनाया गया।`
          : `Credit Note ${cn.bill_number} issued.`,
        'success'
      );
      onCreated(cn);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to record sales return.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('bills.salesReturn')}
        className="w-full sm:max-w-2xl max-h-[92vh] rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconRotate2 size={20} stroke={2} className="text-[var(--primary-dark)]" />
            <h2 className="text-base font-semibold">
              {t('bills.salesReturn')} · {sourceBill.bill_number}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 text-[var(--text-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs text-[var(--give)] flex items-center gap-2">
              <IconAlertCircle size={16} stroke={2} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {loadingPrev ? (
            <p className="text-xs text-[var(--text-muted)]">{t('common.loading')}</p>
          ) : (
            <div className="rounded-xl border border-[var(--border)] overflow-hidden">
              <table className="w-full text-left border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase text-[var(--text-muted)]">
                    <th className="py-2 px-3">Item</th>
                    <th className="py-2 px-2 text-right">Billed</th>
                    <th className="py-2 px-2 text-right">Returnable</th>
                    <th className="py-2 px-3 text-right">Return Qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {sourceLines.map((sl) => {
                    const ret = alreadyReturnedByLine[sl.id] || 0;
                    const rem = Math.max(
                      0,
                      roundHalfUp(Number(sl.entered_qty) - ret, 3)
                    );
                    return (
                      <tr key={sl.id}>
                        <td className="py-2.5 px-3">
                          <p className="font-medium">{sl.item_name}</p>
                          <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
                            {formatINR(Number(sl.unit_price))} / {sl.entered_unit_code}
                          </p>
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums">
                          {sl.entered_qty} {sl.entered_unit_code}
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums font-medium">
                          {rem} {sl.entered_unit_code}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            max={rem}
                            step="0.001"
                            disabled={rem <= 0}
                            value={returnQtyByLine[sl.id] ?? ''}
                            onChange={(e) =>
                              setReturnQtyByLine((prev) => ({
                                ...prev,
                                [sl.id]: e.target.value,
                              }))
                            }
                            placeholder="0"
                            className="w-24 h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs text-right tabular-nums"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

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
                {t('bills.returnReason')} *
              </label>
              <input
                type="text"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Damaged, size mismatch, customer return..."
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </div>
          </div>

          {(!sourceBill.party_id || isModuleEnabled('payments')) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('bills.refundNow')} (Optional, max {formatINR(previewCalc.grandTotal)})
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max={previewCalc.grandTotal}
                  step="0.01"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('payments.mode')}
                </label>
                <select
                  value={refundMode}
                  onChange={(e) => setRefundMode(e.target.value as PaymentMode)}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {(['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other'] as const).map(
                    (m) => (
                      <option key={m} value={m}>
                        {t(`payments.modes.${m}`)}
                      </option>
                    )
                  )}
                </select>
              </div>
            </div>
          )}

          <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between">
            <span className="text-xs sm:text-sm font-medium">
              Credit Note Total (restores stock + adjusts Khata):
            </span>
            <span className="text-base sm:text-lg font-semibold tabular-nums">
              {formatINR(previewCalc.grandTotal)}
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting || selectedReturnLines.length === 0}
              className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <IconCheck size={17} stroke={2.5} />
              <span>{submitting ? t('profile.saving') : t('bills.creditNote')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
