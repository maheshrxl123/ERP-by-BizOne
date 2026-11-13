import {
  IconArrowDownLeft,
  IconArrowUpRight,
  IconCheck,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR, todayLocalIso } from '../../core/format';
import { supabase } from '../../core/supabase';
import type {
  OpenObligationRecord,
  PartyBalanceRecord,
  PaymentDirection,
  PaymentMode,
  PaymentRecord,
} from '../../types/bizone';

interface PaymentModalProps {
  open: boolean;
  lockedParty?: PartyBalanceRecord | null;
  initialDirection?: PaymentDirection;
  onClose: () => void;
  onSaved: (payment: PaymentRecord) => void;
}

const PAYMENT_MODES: PaymentMode[] = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
];

export function PaymentModal({
  open,
  lockedParty,
  initialDirection = 'receive',
  onClose,
  onSaved,
}: PaymentModalProps) {
  const { language, showToast, t } = useApp();

  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [selectedPartyId, setSelectedPartyId] = useState('');
  const [direction, setDirection] = useState<PaymentDirection>(initialDirection);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [paymentDate, setPaymentDate] = useState(todayLocalIso());
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');

  const [openObligations, setOpenObligations] = useState<OpenObligationRecord[]>([]);
  const [loadingObligations, setLoadingObligations] = useState(false);
  const [autoAllocate, setAutoAllocate] = useState(true);
  const [manualAmounts, setManualAmounts] = useState<Record<string, string>>({});
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setErrorMsg(null);
    setDirection(initialDirection);
    setMode('cash');
    setPaymentDate(todayLocalIso());
    setReferenceNo('');
    setNotes('');
    setAutoAllocate(true);
    setManualAmounts({});
    setIdempotencyKey(`pay_${crypto.randomUUID()}`);

    if (lockedParty) {
      setSelectedPartyId(lockedParty.party_id);
      const suggested =
        initialDirection === 'receive' && lockedParty.to_receive > 0
          ? String(lockedParty.to_receive)
          : initialDirection === 'give' && lockedParty.to_give > 0
            ? String(lockedParty.to_give)
            : '';
      setAmount(suggested);
    } else {
      setSelectedPartyId('');
      setAmount('');
      supabase
        .from('party_balances')
        .select('*')
        .eq('is_active', true)
        .order('name')
        .then(({ data, error }) => {
          if (!active) return;
          if (error) {
            setErrorMsg(error.message);
            return;
          }
          setParties((data as PartyBalanceRecord[] | null) ?? []);
        });
    }
    return () => {
      active = false;
    };
  }, [open, lockedParty, initialDirection]);

  const activeParty = useMemo(() => {
    if (lockedParty) return lockedParty;
    return parties.find((p) => p.party_id === selectedPartyId) ?? null;
  }, [lockedParty, parties, selectedPartyId]);

  useEffect(() => {
    if (!open || !selectedPartyId) {
      setOpenObligations([]);
      return;
    }
    let active = true;
    setLoadingObligations(true);
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('party_open_obligations')
          .select('*')
          .eq('party_id', selectedPartyId)
          .eq('direction_needed', direction)
          .order('entry_date', { ascending: true })
          .order('created_at', { ascending: true });
        if (!active) return;
        if (error) {
          setErrorMsg(error.message);
          return;
        }
        setOpenObligations((data as OpenObligationRecord[] | null) ?? []);
        setManualAmounts({});
      } finally {
        if (active) setLoadingObligations(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, selectedPartyId, direction]);

  const numericAmount = useMemo(() => {
    const n = Number(amount || 0);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
  }, [amount]);

  const allocationPreview = useMemo(() => {
    if (numericAmount <= 0) {
      return { items: [] as Array<{ label: string; applied: number }>, allocated: 0, advance: 0 };
    }
    if (autoAllocate) {
      let left = numericAmount;
      const items: Array<{ label: string; applied: number }> = [];
      let allocated = 0;
      for (const ob of openObligations) {
        if (left <= 0) break;
        const apply = Math.min(left, Number(ob.remaining_amount));
        if (apply > 0) {
          items.push({ label: ob.reference_no, applied: Math.round(apply * 100) / 100 });
          allocated += apply;
          left = Math.round((left - apply) * 100) / 100;
        }
      }
      allocated = Math.round(allocated * 100) / 100;
      const advance = Math.max(Math.round((numericAmount - allocated) * 100) / 100, 0);
      return { items, allocated, advance };
    }

    let allocated = 0;
    const items: Array<{ label: string; applied: number }> = [];
    for (const ob of openObligations) {
      const val = Math.round(Number(manualAmounts[ob.ledger_entry_id] || 0) * 100) / 100;
      if (val > 0) {
        items.push({ label: ob.reference_no, applied: val });
        allocated += val;
      }
    }
    allocated = Math.round(allocated * 100) / 100;
    const advance = Math.round((numericAmount - allocated) * 100) / 100;
    return { items, allocated, advance };
  }, [numericAmount, autoAllocate, openObligations, manualAmounts]);

  if (!open) return null;

  const handleSelectParty = (partyId: string) => {
    setSelectedPartyId(partyId);
    const chosen = parties.find((p) => p.party_id === partyId);
    if (chosen) {
      const nextDir: PaymentDirection =
        chosen.to_give > 0 && chosen.to_receive === 0 ? 'give' : direction;
      setDirection(nextDir);
      if (!amount) {
        if (nextDir === 'receive' && chosen.to_receive > 0) {
          setAmount(String(chosen.to_receive));
        } else if (nextDir === 'give' && chosen.to_give > 0) {
          setAmount(String(chosen.to_give));
        }
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!selectedPartyId) {
      setErrorMsg(
        language === 'hi' ? 'कृपया एक पार्टी चुनें।' : 'Please select a party.'
      );
      return;
    }

    if (numericAmount <= 0) {
      setErrorMsg(
        language === 'hi'
          ? 'भुगतान राशि 0 से अधिक होनी चाहिए।'
          : 'Payment amount must be greater than zero.'
      );
      return;
    }

    let manualPayload: Array<{ ledger_entry_id: string; amount: number }> | null = null;
    if (!autoAllocate) {
      manualPayload = [];
      let sum = 0;
      for (const ob of openObligations) {
        const val = Math.round(Number(manualAmounts[ob.ledger_entry_id] || 0) * 100) / 100;
        if (val < 0) {
          setErrorMsg('Allocation amounts cannot be negative.');
          return;
        }
        if (val > Number(ob.remaining_amount)) {
          setErrorMsg(
            language === 'hi'
              ? `${ob.reference_no} के लिए दर्ज राशि शेष बकाया से अधिक है।`
              : `Allocation for ${ob.reference_no} exceeds remaining due.`
          );
          return;
        }
        if (val > 0) {
          sum += val;
          manualPayload.push({ ledger_entry_id: ob.ledger_entry_id, amount: val });
        }
      }
      if (Math.round(sum * 100) > Math.round(numericAmount * 100)) {
        setErrorMsg(
          language === 'hi'
            ? 'कुल समायोजित राशि भुगतान राशि से अधिक नहीं हो सकती।'
            : 'Total allocated amount cannot exceed payment amount.'
        );
        return;
      }
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('post_payment', {
        p_party_id: selectedPartyId,
        p_direction: direction,
        p_amount: numericAmount,
        p_mode: mode,
        p_payment_date: paymentDate || todayLocalIso(),
        p_reference_no: referenceNo.trim() || null,
        p_notes: notes.trim() || null,
        p_allocations: manualPayload,
        p_auto_allocate: autoAllocate,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;

      const posted = data as PaymentRecord;
      showToast(
        language === 'hi'
          ? `भुगतान ${posted.payment_number} दर्ज किया गया।`
          : `Payment ${posted.payment_number} posted.`,
        'success'
      );
      onSaved(posted);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : language === 'hi'
            ? 'भुगतान दर्ज करने में त्रुटि हुई।'
            : 'Unable to record payment.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('payments.recordPayment')}
        className="w-full sm:max-w-xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 px-5 py-4 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('payments.recordPayment')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs sm:text-sm text-[var(--give)]">
              {errorMsg}
            </div>
          )}

          {/* Party Picker or Locked Party Info */}
          {lockedParty ? (
            <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{lockedParty.name}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {t(`parties.${lockedParty.party_type}`)}
                  {lockedParty.phone ? ` · ${lockedParty.phone}` : ''}
                </p>
              </div>
              <div className="text-right shrink-0">
                {lockedParty.to_receive > 0 ? (
                  <p className="text-sm font-semibold tabular-nums text-[var(--receive-text)]">
                    {t('parties.youllGet')} {formatINR(lockedParty.to_receive)}
                  </p>
                ) : lockedParty.to_give > 0 ? (
                  <p className="text-sm font-semibold tabular-nums text-[var(--give)]">
                    {t('parties.youllGive')} {formatINR(lockedParty.to_give)}
                  </p>
                ) : (
                  <p className="text-xs font-medium text-[var(--text-muted)]">
                    {t('parties.settled')}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('payments.party')} *
              </label>
              <select
                required
                value={selectedPartyId}
                onChange={(e) => handleSelectParty(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              >
                <option value="">{t('payments.selectParty')}</option>
                {parties.map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}{' '}
                    {p.to_receive > 0
                      ? `(${t('parties.youllGet')} ${formatINR(p.to_receive)})`
                      : p.to_give > 0
                        ? `(${t('parties.youllGive')} ${formatINR(p.to_give)})`
                        : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Direction */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">
              {t('payments.direction')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDirection('receive')}
                className={`min-h-[44px] px-3 rounded-lg border text-sm font-semibold inline-flex items-center justify-center gap-1.5 ${
                  direction === 'receive'
                    ? 'border-[var(--receive)] bg-[var(--receive-soft)] text-[var(--receive-text)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                <IconArrowDownLeft size={17} stroke={2} />
                <span>{t('payments.receivePayment')}</span>
              </button>
              <button
                type="button"
                onClick={() => setDirection('give')}
                className={`min-h-[44px] px-3 rounded-lg border text-sm font-semibold inline-flex items-center justify-center gap-1.5 ${
                  direction === 'give'
                    ? 'border-[var(--give)] bg-[var(--give-soft)] text-[var(--give)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                <IconArrowUpRight size={17} stroke={2} />
                <span>{t('payments.givePayment')}</span>
              </button>
            </div>
          </div>

          {/* Amount & Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('payments.amount')} *
              </label>
              <input
                type="number"
                inputMode="decimal"
                required
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-base font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('payments.date')}
              </label>
              <input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
          </div>

          {/* Payment Mode */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">
              {t('payments.mode')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {PAYMENT_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`min-h-[40px] px-2 rounded-lg border text-xs sm:text-sm font-medium ${
                    mode === m
                      ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {t(`payments.modes.${m}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Reference & Notes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('payments.referenceNo')}
              </label>
              <input
                type="text"
                value={referenceNo}
                onChange={(e) => setReferenceNo(e.target.value)}
                placeholder="UTR / Cheque / Slip #"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('payments.notes')}
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={
                  language === 'hi' ? 'वैकल्पिक टिप्पणी' : 'Optional note'
                }
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
          </div>

          {/* Allocation section */}
          {activeParty && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-[var(--text)]">
                  {t('payments.allocationTitle')}
                </p>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAutoAllocate(true)}
                    className={`px-2.5 py-1 rounded-md border text-xs font-medium ${
                      autoAllocate
                        ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {t('payments.autoAllocate')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAutoAllocate(false)}
                    className={`px-2.5 py-1 rounded-md border text-xs font-medium ${
                      !autoAllocate
                        ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {t('payments.manualAllocate')}
                  </button>
                </div>
              </div>

              {loadingObligations ? (
                <p className="text-xs text-[var(--text-muted)]">
                  {t('common.loading')}
                </p>
              ) : openObligations.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  {language === 'hi'
                    ? 'कोई खुला बकाया नहीं मिला — यह राशि अग्रिम (on account) के रूप में दर्ज होगी।'
                    : 'No open dues in this direction — full amount will be recorded as on-account advance.'}
                </p>
              ) : !autoAllocate ? (
                <div className="space-y-2 max-h-44 overflow-y-auto">
                  {openObligations.map((ob) => (
                    <div
                      key={ob.ledger_entry_id}
                      className="p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">
                          {ob.reference_no}
                        </p>
                        <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
                          {formatDate(ob.entry_date)} ·{' '}
                          {language === 'hi' ? 'शेष' : 'Due'}{' '}
                          {formatINR(ob.remaining_amount)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            setManualAmounts((prev) => ({
                              ...prev,
                              [ob.ledger_entry_id]: String(ob.remaining_amount),
                            }))
                          }
                          className="px-2 py-1 rounded border border-[var(--border)] text-[11px] font-medium hover:bg-[var(--surface-muted)]"
                        >
                          {language === 'hi' ? 'पूरा' : 'Full'}
                        </button>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          max={ob.remaining_amount}
                          step="0.01"
                          value={manualAmounts[ob.ledger_entry_id] ?? ''}
                          onChange={(e) =>
                            setManualAmounts((prev) => ({
                              ...prev,
                              [ob.ledger_entry_id]: e.target.value,
                            }))
                          }
                          placeholder="0.00"
                          className="w-24 h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs font-semibold tabular-nums text-right"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1 text-xs">
                  {allocationPreview.items.map((item, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between text-[var(--text-muted)]"
                    >
                      <span className="inline-flex items-center gap-1">
                        <IconCheck size={13} stroke={2.5} className="text-[var(--receive-text)]" />
                        <span>{item.label}</span>
                      </span>
                      <span className="tabular-nums font-medium text-[var(--text)]">
                        {formatINR(item.applied)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {numericAmount > 0 && (
                <div className="pt-2 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-muted)]">
                    {t('payments.allocated')}:{' '}
                    <strong className="text-[var(--text)] tabular-nums">
                      {formatINR(allocationPreview.allocated)}
                    </strong>
                  </span>
                  <span className="text-[var(--text-muted)]">
                    {t('payments.advanceOnAccount')}:{' '}
                    <strong
                      className={`tabular-nums ${
                        allocationPreview.advance < 0
                          ? 'text-[var(--give)]'
                          : 'text-[var(--text)]'
                      }`}
                    >
                      {formatINR(allocationPreview.advance)}
                    </strong>
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold disabled:opacity-60"
            >
              {saving ? t('profile.saving') : t('payments.recordPayment')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
