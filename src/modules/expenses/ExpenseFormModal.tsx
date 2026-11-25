import { IconAlertCircle, IconReceipt2, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { FileUpload, type UploadedFileItem } from '../../components/upload/FileUpload';
import { todayLocalIso } from '../../core/format';
import { erpFetch } from '../../core/erpFetch';
import { roundHalfUp } from '../../core/money';
import { supabase } from '../../core/supabase';
import type {
  ExpenseCategoryRecord,
  ExpenseRecord,
  PaymentMode,
} from '../../types/decorbiz';

interface ExpenseFormModalProps {
  open: boolean;
  editingExpense?: ExpenseRecord | null;
  categories: ExpenseCategoryRecord[];
  onClose: () => void;
  onSaved: () => void;
}

const PAYMENT_MODES: PaymentMode[] = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
];

export function ExpenseFormModal({
  open,
  editingExpense,
  categories,
  onClose,
  onSaved,
}: ExpenseFormModalProps) {
  const { session, language, showToast, t } = useApp();

  const [categoryId, setCategoryId] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayLocalIso());
  const [amount, setAmount] = useState('');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [paidTo, setPaidTo] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [attachment, setAttachment] = useState<UploadedFileItem | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setIdempotencyKey(`exp_${crypto.randomUUID()}`);

    if (editingExpense) {
      setCategoryId(editingExpense.category_id);
      setExpenseDate(editingExpense.expense_date);
      setAmount(String(editingExpense.amount));
      setPaymentMode(editingExpense.payment_mode);
      setPaidTo(editingExpense.paid_to || '');
      setReferenceNo(editingExpense.reference_no || '');
      setNotes(editingExpense.notes || '');

      if (editingExpense.attachment_file_id && session?.access_token) {
        erpFetch('/api/erp/files/signed-url', session.access_token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: editingExpense.attachment_file_id }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res?.file) {
              setAttachment({
                fileId: res.file.id,
                fileName: res.file.file_name,
                mimeType: res.file.mime_type,
                sizeBytes: res.file.size_bytes ?? 0,
                signedUrl: res.signedUrl,
              });
            }
          })
          .catch(() => setAttachment(null));
      } else {
        setAttachment(null);
      }
    } else {
      setCategoryId(categories[0]?.id ?? '');
      setExpenseDate(todayLocalIso());
      setAmount('');
      setPaymentMode('cash');
      setPaidTo('');
      setReferenceNo('');
      setNotes('');
      setAttachment(null);
    }
  }, [open, editingExpense, categories, session?.access_token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const numAmount = roundHalfUp(Number(amount || 0), 2);
    if (!categoryId) {
      setErrorMsg('Please select an expense category.');
      return;
    }
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      setErrorMsg('Expense amount must be greater than zero.');
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.rpc('save_expense', {
        p_id: editingExpense?.id ?? null,
        p_category_id: categoryId,
        p_expense_date: expenseDate || todayLocalIso(),
        p_amount: numAmount,
        p_payment_mode: paymentMode,
        p_reference_no: referenceNo.trim() || null,
        p_paid_to: paidTo.trim() || null,
        p_notes: notes.trim() || null,
        p_attachment_file_id: attachment?.fileId ?? null,
        p_idempotency_key: editingExpense ? null : idempotencyKey,
      });
      if (error) throw error;
      showToast(
        editingExpense
          ? language === 'hi'
            ? 'खर्च अपडेट किया गया।'
            : 'Expense updated.'
          : language === 'hi'
            ? 'खर्च दर्ज किया गया।'
            : 'Expense recorded.',
        'success'
      );
      onSaved();
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to save expense.');
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
        aria-label={editingExpense ? t('expenses.editExpense') : t('expenses.addExpense')}
        className="w-full sm:max-w-lg max-h-[92vh] rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <IconReceipt2 size={19} stroke={2} className="text-[var(--primary-dark)]" />
            <h2 className="text-base font-semibold">
              {editingExpense ? t('expenses.editExpense') : t('expenses.addExpense')}
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('expenses.category')} *
              </label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                required
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {language === 'hi' ? c.name_hi : c.name_en}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('expenses.date')} *
              </label>
              <input
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                required
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('expenses.amount')} *
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-right font-semibold tabular-nums"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('expenses.mode')}
              </label>
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`payments.modes.${m}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('expenses.paidTo')}
              </label>
              <input
                type="text"
                value={paidTo}
                onChange={(e) => setPaidTo(e.target.value)}
                placeholder="Landlord, MSEB, Courier..."
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('expenses.referenceNo')}
              </label>
              <input
                type="text"
                value={referenceNo}
                onChange={(e) => setReferenceNo(e.target.value)}
                placeholder="Bill # / UPI Ref"
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              {t('expenses.notes')}
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional description..."
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
          </div>

          <FileUpload
            label={t('expenses.receipt')}
            value={attachment}
            onChange={setAttachment}
            helperText="Attach photo or PDF of receipt/voucher (max 5 MB)."
          />

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
              disabled={submitting}
              className="h-10 px-5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-slate-950 font-semibold text-sm disabled:opacity-50"
            >
              {submitting ? t('common.loading') : t('expenses.saveExpense')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
