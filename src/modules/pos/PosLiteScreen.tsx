import {
  IconBuildingBank,
  IconCheck,
  IconClock,
  IconPlus,
  IconReceipt,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconWifi,
  IconWifiOff,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDateTime, formatINR, todayLocalIso } from '../../core/format';
import { roundHalfUp } from '../../core/money';
import { roundQty } from '../../core/units';
import {
  enqueueOfflineBill,
  generateOfflineIdempotencyKey,
  loadOfflineQueue,
  removeOfflineBill,
  syncOfflineQueue,
} from '../../core/offlineQueue';
import { supabase } from '../../core/supabase';
import { defaultTaxEngine } from '../../core/taxEngine';
import type {
  ItemCatalogRecord,
  OfflineBillQueueItem,
  PartyBalanceRecord,
  PaymentMode,
  PosCashRegisterRecord,
} from '../../types/bizone';

interface CartLine {
  item: ItemCatalogRecord;
  qty: number;
  unitPrice: number;
  discountPct: number;
}

interface HeldBillRow {
  id: string;
  hold_label: string;
  payload: {
    partyId: string | null;
    partyName: string;
    lines: Array<{ itemId: string; qty: number; unitPrice: number; discountPct: number }>;
    mode: PaymentMode;
    splitNote: string;
  };
  created_at: string;
}

export function PosLiteScreen() {
  const { business, profile, isModuleEnabled, showToast } = useApp();
  const taxEnabled = isModuleEnabled('tax') && Boolean(business?.gst_registered);

  const [items, setItems] = useState<ItemCatalogRecord[]>([]);
  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [heldBills, setHeldBills] = useState<HeldBillRow[]>([]);
  const [registers, setRegisters] = useState<PosCashRegisterRecord[]>([]);
  const [offlineQueue, setOfflineQueue] = useState<OfflineBillQueueItem[]>(() =>
    loadOfflineQueue()
  );

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [queueOfflineMode, setQueueOfflineMode] = useState(false);

  const [search, setSearch] = useState('');
  const [partyId, setPartyId] = useState<string>('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [splitCash, setSplitCash] = useState('');
  const [splitUpi, setSplitUpi] = useState('');
  const [holdLabel, setHoldLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Register state
  const [openingCashInput, setOpeningCashInput] = useState('0');
  const [countedCashInput, setCountedCashInput] = useState('0');
  const [registerBusy, setRegisterBusy] = useState(false);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [itRes, ptRes, holdRes, regRes] = await Promise.all([
        supabase
          .from('item_catalog_view')
          .select('*')
          .eq('is_active', true)
          .order('name')
          .limit(250),
        supabase
          .from('party_balances')
          .select('*')
          .eq('is_active', true)
          .order('name')
          .limit(150),
        supabase
          .from('pos_held_bills')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('pos_cash_registers')
          .select('*')
          .order('opened_at', { ascending: false })
          .limit(10),
      ]);
      if (!itRes.error && itRes.data) setItems(itRes.data as ItemCatalogRecord[]);
      if (!ptRes.error && ptRes.data) setParties(ptRes.data as PartyBalanceRecord[]);
      if (!holdRes.error && holdRes.data) setHeldBills(holdRes.data as HeldBillRow[]);
      if (!regRes.error && regRes.data) setRegisters(regRes.data as PosCashRegisterRecord[]);
    } catch {
      // Offline mode safely uses already-loaded items
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items.slice(0, 12);
    return items
      .filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          (it.sku && it.sku.toLowerCase().includes(q)) ||
          (it.barcode && it.barcode.toLowerCase().includes(q))
      )
      .slice(0, 12);
  }, [items, search]);

  const addItem = (it: ItemCatalogRecord) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.item.id === it.id);
      if (existing) {
        return prev.map((c) => (c.item.id === it.id ? { ...c, qty: c.qty + 1 } : c));
      }
      return [
        ...prev,
        {
          item: it,
          qty: 1,
          unitPrice: Number(it.selling_price || 0),
          discountPct: 0,
        },
      ];
    });
  };

  const totals = useMemo(() => {
    let taxable = 0;
    let tax = 0;
    let rawTotal = 0;
    for (const c of cart) {
      const res = defaultTaxEngine.computeLineTax({
        itemId: c.item.id,
        itemName: c.item.name,
        hsnCode: c.item.hsn_code,
        qty: c.qty,
        unitPrice: c.unitPrice,
        discountPct: c.discountPct,
        gstRate: Number(c.item.gst_rate || 0),
        taxInclusive: Boolean(c.item.tax_inclusive),
        isInterstate: false,
        gstRegistered: taxEnabled,
      });
      taxable = roundHalfUp(taxable + res.taxableAmount, 2);
      tax = roundHalfUp(tax + res.taxAmount, 2);
      rawTotal = roundHalfUp(rawTotal + res.lineTotal, 2);
    }
    const grandTotal = roundHalfUp(rawTotal, 0);
    return { taxable, tax, grandTotal };
  }, [cart, taxEnabled]);

  const selectedParty = parties.find((p) => p.party_id === partyId) || null;
  const openRegister = registers.find((r) => r.status === 'open') || null;

  const handleParkBill = async () => {
    if (cart.length === 0) return;
    const label = holdLabel.trim() || `Counter Hold (${cart.length} items)`;
    const { error } = await supabase.from('pos_held_bills').insert({
      hold_label: label,
      payload: {
        partyId: partyId || null,
        partyName: selectedParty?.name || 'Walk-in Customer',
        lines: cart.map((c) => ({
          itemId: c.item.id,
          qty: c.qty,
          unitPrice: c.unitPrice,
          discountPct: c.discountPct,
        })),
        mode: paymentMode,
        splitNote:
          splitCash || splitUpi ? `Split Cash ₹${splitCash || 0} + UPI ₹${splitUpi || 0}` : '',
      },
      created_by: profile?.id,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setCart([]);
    setHoldLabel('');
    showToast(`Parked bill "${label}".`, 'info');
    await loadData();
  };

  const handleResumeHeld = async (held: HeldBillRow) => {
    const restored: CartLine[] = [];
    for (const ln of held.payload.lines || []) {
      const it = items.find((i) => i.id === ln.itemId);
      if (it) {
        restored.push({
          item: it,
          qty: ln.qty,
          unitPrice: ln.unitPrice,
          discountPct: ln.discountPct,
        });
      }
    }
    if (restored.length === 0) {
      showToast('Items from this held bill could not be matched.', 'error');
      return;
    }
    setCart(restored);
    setPartyId(held.payload.partyId || '');
    setPaymentMode(held.payload.mode || 'cash');
    await supabase.from('pos_held_bills').delete().eq('id', held.id);
    await loadData();
  };

  const handleCompleteSale = async () => {
    if (cart.length === 0) {
      showToast('Add at least one item to bill.', 'error');
      return;
    }

    const cashVal = Number(splitCash || 0);
    const upiVal = Number(splitUpi || 0);
    if (!Number.isFinite(cashVal) || !Number.isFinite(upiVal) || cashVal < 0 || upiVal < 0) {
      showToast('Split payment amounts must be valid non-negative numbers.', 'error');
      return;
    }
    const hasSplit = splitCash.trim() !== '' || splitUpi.trim() !== '';
    if (hasSplit && roundHalfUp(cashVal + upiVal, 2) !== roundHalfUp(totals.grandTotal, 2)) {
      showToast(
        `Split payment total (${formatINR(roundHalfUp(cashVal + upiVal, 2))}) must equal bill total (${formatINR(totals.grandTotal)}).`,
        'error'
      );
      return;
    }

    const docType = taxEnabled ? 'tax_invoice' : 'bill_of_supply';
    const splitNote = hasSplit
      ? `Split Payment: Cash ₹${cashVal.toFixed(2)}, UPI/Bank ₹${upiVal.toFixed(2)}`
      : null;
    const rpcLines = cart.map((c) => ({
      item_id: c.item.id,
      entered_qty: c.qty,
      entered_unit_id: c.item.base_unit_id,
      unit_price: c.unitPrice,
      discount_pct: c.discountPct,
    }));

    if (!isOnline || queueOfflineMode) {
      const next = enqueueOfflineBill({
        doc_type: docType,
        party_id: partyId || null,
        party_name: selectedParty?.name || 'Walk-in Customer',
        bill_date: todayLocalIso(),
        lines: cart.map((c) => ({
          item_id: c.item.id,
          item_name: c.item.name,
          entered_qty: c.qty,
          entered_unit_id: c.item.base_unit_id,
          unit_price: c.unitPrice,
          discount_pct: c.discountPct,
        })),
        paid_amount: totals.grandTotal,
        payment_mode: paymentMode,
        payment_reference: splitNote,
        grand_total_estimate: totals.grandTotal,
        notes: 'Queued offline via POS-Lite',
      });
      setOfflineQueue(next);
      setCart([]);
      setSplitCash('');
      setSplitUpi('');
      showToast('Bill saved to offline queue with unique idempotency key.', 'info');
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('issue_bill', {
        p_draft_id: null,
        p_doc_type: docType,
        p_party_id: partyId || null,
        p_bill_date: todayLocalIso(),
        p_due_date: null,
        p_valid_until: null,
        p_place_of_supply: business?.state_code || null,
        p_extra_charges: 0,
        p_auto_round_off: true,
        p_notes: splitNote || 'POS-Lite counter sale',
        p_terms: null,
        p_lines: rpcLines,
        p_paid_amount: totals.grandTotal,
        p_payment_mode: paymentMode,
        p_payment_reference: splitNote,
        p_idempotency_key: generateOfflineIdempotencyKey(),
        p_site_id: null,
        p_job_id: null,
        p_prescription: null,
      });
      if (error) throw error;
      const issued = data as { bill_number?: string };
      setCart([]);
      setSplitCash('');
      setSplitUpi('');
      showToast(`Issued POS Bill ${issued?.bill_number || ''}.`, 'success');
      await loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to issue POS bill.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyncOffline = async () => {
    setSyncing(true);
    try {
      const res = await syncOfflineQueue();
      setOfflineQueue(res.remaining);
      showToast(
        `Sync complete: ${res.synced} synced, ${res.deduplicated} deduplicated, ${res.failed} failed.`,
        res.failed > 0 ? 'error' : 'success'
      );
      await loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Offline sync failed.', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleOpenRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id) return;
    setRegisterBusy(true);
    const opening = Math.max(0, Number(openingCashInput || 0));
    const { error } = await supabase.from('pos_cash_registers').insert({
      register_date: todayLocalIso(),
      opened_by: profile.id,
      opening_cash: opening,
      expected_cash: opening,
      status: 'open',
    });
    setRegisterBusy(false);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast('Cash register shift opened.', 'success');
    await loadData();
  };

  const handleCloseRegister = async (reg: PosCashRegisterRecord) => {
    if (!profile?.id) return;
    setRegisterBusy(true);
    const counted = Math.max(0, Number(countedCashInput || 0));
    const variance = counted - Number(reg.expected_cash || 0);
    const { error } = await supabase
      .from('pos_cash_registers')
      .update({
        counted_cash: counted,
        variance,
        status: 'closed',
        closed_by: profile.id,
        closed_at: new Date().toISOString(),
      })
      .eq('id', reg.id);
    setRegisterBusy(false);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast(`Shift closed (variance ${formatINR(variance)}).`, 'info');
    await loadData();
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconReceipt size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>POS-Lite & Offline Counter</span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Fast counter billing, hold/park bills, split cash+UPI tender, register shift reconciliation, and idempotent offline queue.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`text-xs font-medium inline-flex items-center gap-1.5 ${
              isOnline ? 'text-[var(--receive-text)]' : 'text-[var(--give)]'
            }`}
          >
            {isOnline ? <IconWifi size={15} stroke={2} /> : <IconWifiOff size={15} stroke={2} />}
            <span>{isOnline ? 'Online' : 'Offline'}</span>
          </span>
          <label className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={queueOfflineMode}
              onChange={(e) => setQueueOfflineMode(e.target.checked)}
              className="w-3.5 h-3.5 accent-[var(--primary-dark)]"
            />
            <span>Queue Offline Mode</span>
          </label>
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

      {/* Main POS Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Item Picker */}
        <section className="lg:col-span-7 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
          <div className="relative">
            <IconSearch
              size={16}
              stroke={2}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Scan barcode or search item name / SKU..."
              className="w-full h-11 pl-9 pr-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {filteredItems.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => addItem(it)}
                className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-left flex flex-col justify-between gap-1.5 min-h-[82px]"
              >
                <div className="text-sm font-medium line-clamp-2">{it.name}</div>
                <div className="flex items-center justify-between text-xs tabular-nums">
                  <span className="font-semibold text-[var(--primary-dark)]">
                    {formatINR(Number(it.selling_price))}
                  </span>
                  <span className="text-[var(--text-muted)]">
                    {it.qty_on_hand} {it.base_unit_code}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Right: Active Cart & Payment */}
        <section className="lg:col-span-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <select
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              aria-label="Select Customer"
              className="flex-1 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            >
              <option value="">Walk-in Customer</option>
              {parties
                .filter((p) => p.party_type !== 'supplier')
                .map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}
                  </option>
                ))}
            </select>
            {cart.length > 0 && (
              <button
                type="button"
                onClick={() => setCart([])}
                className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs text-[var(--give)]"
              >
                Clear
              </button>
            )}
          </div>

          <div className="divide-y divide-[var(--border)] max-h-[240px] overflow-y-auto">
            {cart.length === 0 ? (
              <p className="py-8 text-center text-xs text-[var(--text-muted)]">
                Tap items on the left to start billing.
              </p>
            ) : (
              cart.map((c) => (
                <div key={c.item.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{c.item.name}</div>
                    <div className="text-xs text-[var(--text-muted)] tabular-nums">
                      {formatINR(c.unitPrice)} × {c.qty}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={c.item.base_unit_allow_decimal ? 0.001 : 1}
                      step={c.item.base_unit_allow_decimal ? 'any' : '1'}
                      value={c.qty}
                      onChange={(e) => {
                        const rawVal = Number(e.target.value);
                        const nextQty = c.item.base_unit_allow_decimal
                          ? Math.max(0.001, roundQty(rawVal || 0.001))
                          : Math.max(1, Math.round(rawVal || 1));
                        setCart((prev) =>
                          prev.map((x) =>
                            x.item.id === c.item.id ? { ...x, qty: nextQty } : x
                          )
                        );
                      }}
                      className="w-16 h-8 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs text-right tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setCart((prev) => prev.filter((x) => x.item.id !== c.item.id))
                      }
                      aria-label="Remove item"
                      className="p-1 text-[var(--text-muted)] hover:text-[var(--give)]"
                    >
                      <IconTrash size={14} stroke={2} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="pt-3 border-t border-[var(--border)] space-y-2 text-sm">
            <div className="flex justify-between text-xs text-[var(--text-muted)] tabular-nums">
              <span>Taxable + GST</span>
              <span>
                {formatINR(totals.taxable)} + {formatINR(totals.tax)}
              </span>
            </div>
            <div className="flex justify-between text-base font-semibold tabular-nums">
              <span>Grand Total</span>
              <span>{formatINR(totals.grandTotal)}</span>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1">
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
                aria-label="Primary Payment Mode"
                className="h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank</option>
              </select>
              <input
                type="number"
                min={0}
                value={splitCash}
                onChange={(e) => setSplitCash(e.target.value)}
                placeholder="Split Cash ₹"
                className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
              />
              <input
                type="number"
                min={0}
                value={splitUpi}
                onChange={(e) => setSplitUpi(e.target.value)}
                placeholder="Split UPI ₹"
                className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
              />
            </div>

            <div className="flex items-center gap-2 pt-2">
              <input
                type="text"
                value={holdLabel}
                onChange={(e) => setHoldLabel(e.target.value)}
                placeholder="Hold note (e.g. Table 2)"
                className="flex-1 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <button
                type="button"
                disabled={cart.length === 0 || !isOnline}
                onClick={() => void handleParkBill()}
                className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1 disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <IconClock size={14} stroke={2} />
                <span>Park / Hold</span>
              </button>
            </div>

            <button
              type="button"
              disabled={submitting || cart.length === 0}
              onClick={() => void handleCompleteSale()}
              className="w-full h-11 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <IconCheck size={17} stroke={2.5} />
              <span>
                {!isOnline || queueOfflineMode
                  ? 'Save to Offline Queue'
                  : submitting
                    ? 'Issuing...'
                    : `Complete Bill (${formatINR(totals.grandTotal)})`}
              </span>
            </button>
          </div>
        </section>
      </div>

      {/* Bottom Operational Row: Held Bills, Offline Sync Queue, Cash Register Shift */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Held Bills */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
          <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
            <IconClock size={16} stroke={2} className="text-[var(--primary-dark)]" />
            <span>Parked / Held Bills ({heldBills.length})</span>
          </h2>
          {heldBills.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">No bills parked right now.</p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {heldBills.map((h) => (
                <div key={h.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                  <div>
                    <div className="font-semibold">{h.hold_label}</div>
                    <div className="text-[var(--text-muted)]">
                      {h.payload.partyName} · {h.payload.lines?.length || 0} line(s)
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleResumeHeld(h)}
                    className="h-8 px-2.5 rounded-lg border border-[var(--border)] font-medium hover:bg-[var(--surface-muted)]"
                  >
                    Resume
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Offline Queue */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              <IconWifiOff size={16} stroke={2} className="text-[var(--primary-dark)]" />
              <span>Offline Queue ({offlineQueue.length})</span>
            </h2>
            {offlineQueue.length > 0 && (
              <button
                type="button"
                disabled={syncing || !isOnline}
                onClick={() => void handleSyncOffline()}
                className="h-8 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold disabled:opacity-50"
              >
                {syncing ? 'Syncing...' : 'Sync Now'}
              </button>
            )}
          </div>
          {offlineQueue.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">All bills synced with zero duplicates.</p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {offlineQueue.map((q) => (
                <div key={q.local_id} className="py-2 flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">
                      {q.party_name} · {formatINR(q.grand_total_estimate)}
                    </div>
                    <div className="text-[var(--text-muted)] font-mono truncate">
                      {q.sync_status}
                      {q.sync_error ? ` · ${q.sync_error}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOfflineQueue(removeOfflineBill(q.local_id))}
                    aria-label="Discard queued bill"
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--give)]"
                  >
                    <IconTrash size={14} stroke={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Cash Register Shift */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
          <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
            <IconBuildingBank size={16} stroke={2} className="text-[var(--primary-dark)]" />
            <span>Cash Register Shift</span>
          </h2>
          {openRegister ? (
            <div className="space-y-2.5 text-xs">
              <div className="rounded-lg bg-[var(--surface-muted)] p-3 space-y-1 tabular-nums">
                <div>Opened: {formatDateTime(openRegister.opened_at)}</div>
                <div>Opening Cash: {formatINR(Number(openRegister.opening_cash))}</div>
                <div>Expected Cash: {formatINR(Number(openRegister.expected_cash))}</div>
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  value={countedCashInput}
                  onChange={(e) => setCountedCashInput(e.target.value)}
                  placeholder="Counted cash ₹"
                  className="flex-1 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
                <button
                  type="button"
                  disabled={registerBusy}
                  onClick={() => void handleCloseRegister(openRegister)}
                  className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
                >
                  Close Shift
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleOpenRegister} className="space-y-2 text-xs">
              <p className="text-[var(--text-muted)]">No open shift. Enter opening drawer cash.</p>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  value={openingCashInput}
                  onChange={(e) => setOpeningCashInput(e.target.value)}
                  placeholder="Opening cash ₹"
                  className="flex-1 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
                <button
                  type="submit"
                  disabled={registerBusy}
                  className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1"
                >
                  <IconPlus size={13} stroke={2} />
                  <span>Open Shift</span>
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
