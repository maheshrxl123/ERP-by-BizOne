import {
  IconArrowsLeftRight,
  IconBuildingWarehouse,
  IconCheck,
  IconClipboardCheck,
  IconNote,
  IconRefresh,
  IconRepeat,
  IconUsers,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR, todayLocalIso } from '../../core/format';
import { supabase } from '../../core/supabase';
import type {
  ItemCatalogRecord,
  LocationRecord,
  StockTransferRecord,
} from '../../types/bizone';

type OpsTab = 'locations' | 'counts' | 'orders' | 'crm_ops';

interface StockCountRow {
  id: string;
  count_number: string;
  item_id: string;
  count_date: string;
  system_qty: number;
  counted_qty: number;
  variance_qty: number;
  notes: string | null;
}

interface OrderRow {
  id: string;
  order_number: string;
  doc_kind: 'sales_order' | 'delivery_challan' | 'purchase_order';
  party_name: string;
  order_date: string;
  total_amount: number;
  status: 'open' | 'partial' | 'fulfilled' | 'cancelled';
  notes: string | null;
}

interface LeadRow {
  id: string;
  name: string;
  phone: string | null;
  stage: 'new' | 'contacted' | 'quoted' | 'won' | 'lost';
  expected_value: number;
  next_follow_up: string | null;
}

interface ChequeRow {
  id: string;
  direction: 'received' | 'issued';
  party_name: string;
  cheque_no: string;
  bank_name: string;
  cheque_date: string;
  amount: number;
  status: 'pending' | 'cleared' | 'bounced' | 'cancelled';
}

interface RecurringRow {
  id: string;
  rule_type: 'invoice' | 'expense';
  title: string;
  frequency: 'weekly' | 'monthly' | 'quarterly';
  next_run_date: string;
  amount: number;
  is_active: boolean;
}

export function OperationsScreen() {
  const { isModuleEnabled, showToast } = useApp();
  const locationsEnabled = isModuleEnabled('locations');

  const [tab, setTab] = useState<OpsTab>(locationsEnabled ? 'locations' : 'counts');
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [items, setItems] = useState<ItemCatalogRecord[]>([]);
  const [transfers, setTransfers] = useState<StockTransferRecord[]>([]);
  const [counts, setCounts] = useState<StockCountRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [cheques, setCheques] = useState<ChequeRow[]>([]);
  const [recurring, setRecurring] = useState<RecurringRow[]>([]);

  // Location / transfer state
  const [locCode, setLocCode] = useState('');
  const [locName, setLocName] = useState('');
  const [locType, setLocType] = useState<'godown' | 'branch' | 'shop'>('godown');
  const [fromLocId, setFromLocId] = useState('');
  const [toLocId, setToLocId] = useState('');
  const [xferItemId, setXferItemId] = useState('');
  const [xferQty, setXferQty] = useState('');

  // Physical stock count state
  const [countItemId, setCountItemId] = useState('');
  const [countedQty, setCountedQty] = useState('');
  const [countNotes, setCountNotes] = useState('');

  // Order state
  const [orderKind, setOrderKind] = useState<'sales_order' | 'delivery_challan' | 'purchase_order'>('sales_order');
  const [orderParty, setOrderParty] = useState('');
  const [orderAmount, setOrderAmount] = useState('');

  // Lead / Cheque / Recurring state
  const [leadName, setLeadName] = useState('');
  const [leadPhone, setLeadPhone] = useState('');
  const [leadVal, setLeadVal] = useState('');
  const [chequeParty, setChequeParty] = useState('');
  const [chequeNo, setChequeNo] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [chequeAmt, setChequeAmt] = useState('');
  const [recTitle, setRecTitle] = useState('');
  const [recAmt, setRecAmt] = useState('');

  const loadAll = useCallback(async () => {
    const [locRes, itRes, trRes, cntRes, ordRes, ldRes, cqRes, recRes] = await Promise.all([
      supabase.from('locations').select('*').order('code'),
      supabase.from('item_catalog_view').select('*').eq('is_active', true).order('name').limit(150),
      supabase.from('stock_transfers').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('physical_stock_counts').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('sales_orders').select('*').order('created_at', { ascending: false }).limit(40),
      supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('cheque_register').select('*').order('cheque_date', { ascending: false }).limit(30),
      supabase.from('recurring_rules').select('*').order('next_run_date').limit(30),
    ]);

    const locs = (locRes.data as LocationRecord[] | null) ?? [];
    const itms = (itRes.data as ItemCatalogRecord[] | null) ?? [];
    setLocations(locs);
    setItems(itms);
    setTransfers((trRes.data as StockTransferRecord[] | null) ?? []);
    setCounts((cntRes.data as StockCountRow[] | null) ?? []);
    setOrders((ordRes.data as OrderRow[] | null) ?? []);
    setLeads((ldRes.data as LeadRow[] | null) ?? []);
    setCheques((cqRes.data as ChequeRow[] | null) ?? []);
    setRecurring((recRes.data as RecurringRow[] | null) ?? []);

    if (locs.length > 0) setFromLocId((prev) => prev || locs[0].id);
    if (locs.length > 1) setToLocId((prev) => prev || locs[1].id);
    if (itms.length > 0) {
      setXferItemId((prev) => prev || itms[0].id);
      setCountItemId((prev) => prev || itms[0].id);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!locationsEnabled && tab === 'locations') {
      setTab('counts');
    }
  }, [locationsEnabled, tab]);

  const handleCreateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!locCode.trim() || !locName.trim()) return;
    const { error } = await supabase.from('locations').insert({
      code: locCode.trim().toUpperCase(),
      name: locName.trim(),
      location_type: locType,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setLocCode('');
    setLocName('');
    showToast('Location / godown added.', 'success');
    await loadAll();
  };

  const handleTransferStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromLocId || !toLocId || !xferItemId || Number(xferQty) <= 0) return;
    if (fromLocId === toLocId) {
      showToast('Source and destination locations must be different.', 'error');
      return;
    }
    const { error } = await supabase.rpc('transfer_location_stock', {
      p_from_location_id: fromLocId,
      p_to_location_id: toLocId,
      p_item_id: xferItemId,
      p_qty: Number(xferQty),
      p_notes: 'Inter-location stock transfer',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setXferQty('');
    showToast('Stock transferred cleanly.', 'success');
    await loadAll();
  };

  const handleRecordCount = async (e: React.FormEvent) => {
    e.preventDefault();
    const item = items.find((i) => i.id === countItemId);
    if (!item || countedQty === '') return;
    const counted = Math.max(0, Number(countedQty));
    const sysQty = Number(item.qty_on_hand || 0);
    const { error } = await supabase.from('physical_stock_counts').insert({
      count_number: `CNT-${Date.now().toString().slice(-6)}`,
      location_id: locations[0]?.id || null,
      item_id: item.id,
      count_date: todayLocalIso(),
      system_qty: sysQty,
      counted_qty: counted,
      variance_qty: counted - sysQty,
      notes: countNotes.trim() || null,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setCountedQty('');
    setCountNotes('');
    showToast('Physical stock count recorded.', 'success');
    await loadAll();
  };

  const handleAddOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderParty.trim()) return;
    const prefix =
      orderKind === 'purchase_order' ? 'PO' : orderKind === 'delivery_challan' ? 'DC' : 'SO';
    const { error } = await supabase.from('sales_orders').insert({
      order_number: `${prefix}-${Date.now().toString().slice(-6)}`,
      doc_kind: orderKind,
      party_name: orderParty.trim(),
      order_date: todayLocalIso(),
      total_amount: Number(orderAmount || 0),
      status: 'open',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setOrderParty('');
    setOrderAmount('');
    showToast('Order document created.', 'success');
    await loadAll();
  };

  const handleMarkOrderFulfilled = async (id: string) => {
    const { error } = await supabase
      .from('sales_orders')
      .update({ status: 'fulfilled' })
      .eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  const handleAddLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadName.trim()) return;
    const { error } = await supabase.from('leads').insert({
      name: leadName.trim(),
      phone: leadPhone.trim() || null,
      expected_value: Number(leadVal || 0),
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setLeadName('');
    setLeadPhone('');
    setLeadVal('');
    await loadAll();
  };

  const handleAddCheque = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chequeParty.trim() || !chequeNo.trim() || !chequeBank.trim() || Number(chequeAmt) <= 0)
      return;
    const { error } = await supabase.from('cheque_register').insert({
      direction: 'received',
      party_name: chequeParty.trim(),
      cheque_no: chequeNo.trim(),
      bank_name: chequeBank.trim(),
      cheque_date: todayLocalIso(),
      amount: Number(chequeAmt),
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setChequeParty('');
    setChequeNo('');
    setChequeBank('');
    setChequeAmt('');
    await loadAll();
  };

  const handleAddRecurring = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recTitle.trim() || Number(recAmt) <= 0) return;
    const { error } = await supabase.from('recurring_rules').insert({
      rule_type: 'expense',
      title: recTitle.trim(),
      frequency: 'monthly',
      next_run_date: todayLocalIso(),
      amount: Number(recAmt),
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setRecTitle('');
    setRecAmt('');
    await loadAll();
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconBuildingWarehouse size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>Operations, Godowns & Orders</span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Multi-godown transfers, physical stock counts, Sales/Purchase orders, delivery challans, leads, cheque register, and recurring schedules.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAll()}
          className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1 self-start"
        >
          <IconRefresh size={14} stroke={2} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-[var(--border)] pb-2">
        {locationsEnabled && (
          <button
            type="button"
            onClick={() => setTab('locations')}
            className={`h-10 px-4 rounded-lg text-sm font-medium inline-flex items-center gap-2 whitespace-nowrap shrink-0 ${
              tab === 'locations'
                ? 'bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--surface-muted)]'
            }`}
          >
            <IconArrowsLeftRight size={16} stroke={2} />
            <span>Godowns & Transfers</span>
          </button>
        )}
        {(
          [
            { key: 'counts', label: 'Physical Stock Count', icon: IconClipboardCheck },
            { key: 'orders', label: 'Orders & Challans', icon: IconNote },
            { key: 'crm_ops', label: 'Leads, Cheques & Recurring', icon: IconUsers },
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

      {/* Multi-Location Transfers */}
      {tab === 'locations' && locationsEnabled && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <form
              onSubmit={handleCreateLocation}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
            >
              <h2 className="text-base font-semibold">Add Godown / Location</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="text"
                  required
                  value={locCode}
                  onChange={(e) => setLocCode(e.target.value)}
                  placeholder="Code (GDN1)"
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
                />
                <input
                  type="text"
                  required
                  value={locName}
                  onChange={(e) => setLocName(e.target.value)}
                  placeholder="Location Name"
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
                <select
                  value={locType}
                  onChange={(e) => setLocType(e.target.value as 'godown' | 'branch' | 'shop')}
                  className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  <option value="godown">Godown</option>
                  <option value="branch">Branch</option>
                  <option value="shop">Shop Floor</option>
                </select>
              </div>
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Save Location
              </button>
            </form>

            <form
              onSubmit={handleTransferStock}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
            >
              <h2 className="text-base font-semibold">Transfer Stock Between Locations</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select
                  value={fromLocId}
                  onChange={(e) => setFromLocId(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      From: {l.name}
                    </option>
                  ))}
                </select>
                <select
                  value={toLocId}
                  onChange={(e) => setToLocId(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      To: {l.name}
                    </option>
                  ))}
                </select>
                <select
                  value={xferItemId}
                  onChange={(e) => setXferItemId(e.target.value)}
                  className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name} ({it.qty_on_hand} {it.base_unit_code})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0.01}
                  step="0.01"
                  required
                  value={xferQty}
                  onChange={(e) => setXferQty(e.target.value)}
                  placeholder="Transfer Qty"
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
              </div>
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Transfer Stock
              </button>
            </form>
          </div>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            <div className="px-5 py-3 bg-[var(--surface-muted)] text-sm font-semibold">
              Recent Transfers ({transfers.length})
            </div>
            {transfers.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No stock transfers yet.</div>
            ) : (
              transfers.map((tr) => {
                const it = items.find((i) => i.id === tr.item_id);
                return (
                  <div key={tr.id} className="px-5 py-3 flex justify-between text-sm">
                    <div>
                      <span className="font-mono text-xs font-semibold">{tr.transfer_number}</span>{' '}
                      · {it?.name || 'Item'}
                    </div>
                    <div className="tabular-nums font-semibold">
                      Qty {tr.qty} · {formatDate(tr.transfer_date)}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}

      {/* Physical Stock Counts */}
      {tab === 'counts' && (
        <div className="space-y-4">
          <form
            onSubmit={handleRecordCount}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
          >
            <h2 className="text-base font-semibold">Record Physical Stock Count</h2>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
              <select
                value={countItemId}
                onChange={(e) => setCountItemId(e.target.value)}
                className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} (System: {it.qty_on_hand} {it.base_unit_code})
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                step="0.01"
                required
                value={countedQty}
                onChange={(e) => setCountedQty(e.target.value)}
                placeholder="Counted Qty"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
              <input
                type="text"
                value={countNotes}
                onChange={(e) => setCountNotes(e.target.value)}
                placeholder="Notes"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </div>
            <button
              type="submit"
              className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
            >
              Save Count
            </button>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {counts.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No stock counts yet.</div>
            ) : (
              counts.map((c) => {
                const it = items.find((i) => i.id === c.item_id);
                return (
                  <div key={c.id} className="p-4 flex justify-between text-sm">
                    <div>
                      <div className="font-semibold">
                        {c.count_number} · {it?.name || 'Item'}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">{formatDate(c.count_date)}</div>
                    </div>
                    <div className="text-right tabular-nums">
                      <div>
                        System {c.system_qty} · Counted {c.counted_qty}
                      </div>
                      <div
                        className={`text-xs font-semibold ${
                          c.variance_qty === 0 ? 'text-[var(--receive-text)]' : 'text-[var(--give)]'
                        }`}
                      >
                        Variance {c.variance_qty > 0 ? `+${c.variance_qty}` : c.variance_qty}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}

      {/* Sales / Purchase Orders & Delivery Challans */}
      {tab === 'orders' && (
        <div className="space-y-4">
          <form
            onSubmit={handleAddOrder}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
          >
            <select
              value={orderKind}
              onChange={(e) =>
                setOrderKind(e.target.value as 'sales_order' | 'delivery_challan' | 'purchase_order')
              }
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            >
              <option value="sales_order">Sales Order</option>
              <option value="delivery_challan">Delivery Challan</option>
              <option value="purchase_order">Purchase Order</option>
            </select>
            <input
              type="text"
              required
              value={orderParty}
              onChange={(e) => setOrderParty(e.target.value)}
              placeholder="Party / Supplier Name"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={orderAmount}
              onChange={(e) => setOrderAmount(e.target.value)}
              placeholder="Estimated Amount ₹"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
            />
            <button
              type="submit"
              className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
            >
              Create Document
            </button>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {orders.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">
                No sales orders, challans, or purchase orders yet.
              </div>
            ) : (
              orders.map((o) => (
                <div key={o.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <div>
                    <div className="font-semibold">
                      {o.order_number} · {o.party_name}
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {o.doc_kind.replace(/_/g, ' ')} · {formatDate(o.order_date)} · {o.status}
                      {o.notes ? ` · ${o.notes}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold tabular-nums">{formatINR(Number(o.total_amount))}</span>
                    {o.status === 'open' && (
                      <button
                        type="button"
                        onClick={() => void handleMarkOrderFulfilled(o.id)}
                        className="h-8 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1 hover:bg-[var(--surface-muted)]"
                      >
                        <IconCheck size={13} stroke={2} />
                        <span>Mark Fulfilled</span>
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      {/* Leads, Cheques & Recurring */}
      {tab === 'crm_ops' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Leads */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              <IconUsers size={16} stroke={2} className="text-[var(--primary-dark)]" />
              <span>Leads ({leads.length})</span>
            </h2>
            <form onSubmit={handleAddLead} className="space-y-2">
              <input
                type="text"
                required
                value={leadName}
                onChange={(e) => setLeadName(e.target.value)}
                placeholder="Lead name"
                className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={leadPhone}
                  onChange={(e) => setLeadPhone(e.target.value)}
                  placeholder="Phone"
                  className="flex-1 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                />
                <input
                  type="number"
                  value={leadVal}
                  onChange={(e) => setLeadVal(e.target.value)}
                  placeholder="Value ₹"
                  className="w-24 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
              </div>
              <button
                type="submit"
                className="w-full h-9 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Add Lead
              </button>
            </form>
            <div className="divide-y divide-[var(--border)] text-xs">
              {leads.map((l) => (
                <div key={l.id} className="py-2 flex justify-between">
                  <div>
                    <div className="font-medium">{l.name}</div>
                    <div className="text-[var(--text-muted)]">{l.phone || l.stage}</div>
                  </div>
                  <div className="tabular-nums font-semibold">{formatINR(Number(l.expected_value))}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Cheque Register */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              <IconNote size={16} stroke={2} className="text-[var(--primary-dark)]" />
              <span>Cheque Register ({cheques.length})</span>
            </h2>
            <form onSubmit={handleAddCheque} className="space-y-2">
              <input
                type="text"
                required
                value={chequeParty}
                onChange={(e) => setChequeParty(e.target.value)}
                placeholder="Party name"
                className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <div className="grid grid-cols-3 gap-1.5">
                <input
                  type="text"
                  required
                  value={chequeNo}
                  onChange={(e) => setChequeNo(e.target.value)}
                  placeholder="Cheque #"
                  className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-mono"
                />
                <input
                  type="text"
                  required
                  value={chequeBank}
                  onChange={(e) => setChequeBank(e.target.value)}
                  placeholder="Bank"
                  className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                />
                <input
                  type="number"
                  required
                  min={1}
                  value={chequeAmt}
                  onChange={(e) => setChequeAmt(e.target.value)}
                  placeholder="Amount"
                  className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
              </div>
              <button
                type="submit"
                className="w-full h-9 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Add Cheque
              </button>
            </form>
            <div className="divide-y divide-[var(--border)] text-xs">
              {cheques.map((c) => (
                <div key={c.id} className="py-2 flex justify-between">
                  <div>
                    <div className="font-medium">
                      #{c.cheque_no} · {c.party_name}
                    </div>
                    <div className="text-[var(--text-muted)]">
                      {c.bank_name} · {c.status}
                    </div>
                  </div>
                  <div className="tabular-nums font-semibold">{formatINR(Number(c.amount))}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Recurring Rules */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              <IconRepeat size={16} stroke={2} className="text-[var(--primary-dark)]" />
              <span>Recurring Rules ({recurring.length})</span>
            </h2>
            <form onSubmit={handleAddRecurring} className="space-y-2">
              <input
                type="text"
                required
                value={recTitle}
                onChange={(e) => setRecTitle(e.target.value)}
                placeholder="Rule title (e.g. Monthly Shop Rent)"
                className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <div className="flex gap-1.5">
                <input
                  type="number"
                  required
                  min={1}
                  value={recAmt}
                  onChange={(e) => setRecAmt(e.target.value)}
                  placeholder="Amount ₹"
                  className="flex-1 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
                <button
                  type="submit"
                  className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
                >
                  Save Rule
                </button>
              </div>
            </form>
            <div className="divide-y divide-[var(--border)] text-xs">
              {recurring.map((r) => (
                <div key={r.id} className="py-2 flex justify-between">
                  <div>
                    <div className="font-medium">{r.title}</div>
                    <div className="text-[var(--text-muted)]">
                      {r.frequency} · Next {formatDate(r.next_run_date)}
                    </div>
                  </div>
                  <div className="tabular-nums font-semibold">{formatINR(Number(r.amount))}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
