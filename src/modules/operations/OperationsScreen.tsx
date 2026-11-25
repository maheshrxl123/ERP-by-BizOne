import {
  IconAlertTriangle,
  IconArrowsLeftRight,
  IconBuildingWarehouse,
  IconCheck,
  IconClipboardCheck,
  IconFileInvoice,
  IconNote,
  IconPalette,
  IconPercentage,
  IconRefresh,
  IconRepeat,
  IconTag,
  IconTrash,
  IconTruckDelivery,
  IconUsers,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR, todayLocalIso } from '../../core/format';
import { supabase } from '../../core/supabase';
import type {
  BreakageReturnRecord,
  CommissionEntryRecord,
  ContractorRateCardRecord,
  ErpDeliveryTripRecord,
  ItemCatalogRecord,
  LocationRecord,
  PartyBalanceRecord,
  SampleIssueRecord,
  StockTransferRecord,
  SupplierPriceListRecord,
} from '../../types/decorbiz';

type OpsTab =
  | 'locations'
  | 'counts'
  | 'orders'
  | 'crm_ops'
  | 'breakage_returns'
  | 'samples'
  | 'contractor_rate_cards'
  | 'commissions'
  | 'supplier_price_lists'
  | 'delivery_trips';

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
  const stockCountsEnabled = isModuleEnabled('stock_counts');
  const ordersEnabled = isModuleEnabled('orders');
  const crmEnabled = isModuleEnabled('crm_leads') || isModuleEnabled('cheque_register') || isModuleEnabled('recurring');
  const breakageEnabled = isModuleEnabled('breakage_returns');
  const samplesEnabled = isModuleEnabled('samples');
  const rateCardsEnabled = isModuleEnabled('contractor_rate_cards');
  const commissionsEnabled = isModuleEnabled('commissions');
  const supplierListsEnabled = isModuleEnabled('supplier_price_lists');
  const deliveryTripsEnabled = isModuleEnabled('delivery_trips');

  const availableTabs = useMemo(() => {
    const list: Array<{ key: OpsTab; label: string; icon: typeof IconBuildingWarehouse }> = [];
    if (locationsEnabled) list.push({ key: 'locations', label: 'Godowns & Transfers', icon: IconArrowsLeftRight });
    if (stockCountsEnabled) list.push({ key: 'counts', label: 'Physical Stock Count', icon: IconClipboardCheck });
    if (ordersEnabled) list.push({ key: 'orders', label: 'Orders & Challans', icon: IconNote });
    if (crmEnabled) list.push({ key: 'crm_ops', label: 'Leads, Cheques & Recurring', icon: IconUsers });
    if (breakageEnabled) list.push({ key: 'breakage_returns', label: 'Breakage Returns', icon: IconAlertTriangle });
    if (samplesEnabled) list.push({ key: 'samples', label: 'Samples Tracking', icon: IconPalette });
    if (rateCardsEnabled) list.push({ key: 'contractor_rate_cards', label: 'Contractor Rate Cards', icon: IconTag });
    if (commissionsEnabled) list.push({ key: 'commissions', label: 'Commissions', icon: IconPercentage });
    if (supplierListsEnabled) list.push({ key: 'supplier_price_lists', label: 'Supplier Price Lists', icon: IconFileInvoice });
    if (deliveryTripsEnabled) list.push({ key: 'delivery_trips', label: 'Delivery Trips', icon: IconTruckDelivery });
    if (list.length === 0) {
      list.push({ key: 'counts', label: 'Physical Stock Count', icon: IconClipboardCheck });
    }
    return list;
  }, [
    locationsEnabled,
    stockCountsEnabled,
    ordersEnabled,
    crmEnabled,
    breakageEnabled,
    samplesEnabled,
    rateCardsEnabled,
    commissionsEnabled,
    supplierListsEnabled,
    deliveryTripsEnabled,
  ]);

  const [tab, setTab] = useState<OpsTab>(availableTabs[0]?.key || 'counts');
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [items, setItems] = useState<ItemCatalogRecord[]>([]);
  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [transfers, setTransfers] = useState<StockTransferRecord[]>([]);
  const [counts, setCounts] = useState<StockCountRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [cheques, setCheques] = useState<ChequeRow[]>([]);
  const [recurring, setRecurring] = useState<RecurringRow[]>([]);

  // Step 2 Optional Modules Data
  const [breakages, setBreakages] = useState<BreakageReturnRecord[]>([]);
  const [samples, setSamples] = useState<SampleIssueRecord[]>([]);
  const [rateCards, setRateCards] = useState<ContractorRateCardRecord[]>([]);
  const [commissions, setCommissions] = useState<CommissionEntryRecord[]>([]);
  const [supplierPrices, setSupplierPrices] = useState<SupplierPriceListRecord[]>([]);
  const [deliveryTrips, setDeliveryTrips] = useState<ErpDeliveryTripRecord[]>([]);

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

  // Breakage Return form state
  const [brkItemId, setBrkItemId] = useState('');
  const [brkQty, setBrkQty] = useState('1');
  const [brkDisposition, setBrkDisposition] = useState<'replace' | 'credit' | 'write_off'>('write_off');
  const [brkReason, setBrkReason] = useState('');
  const [brkCreditAmt, setBrkCreditAmt] = useState('0');
  const [brkPartyId, setBrkPartyId] = useState('');

  // Samples Tracking form state
  const [smpPartyId, setSmpPartyId] = useState('');
  const [smpPartyName, setSmpPartyName] = useState('');
  const [smpItemId, setSmpItemId] = useState('');
  const [smpShade, setSmpShade] = useState('');
  const [smpQty, setSmpQty] = useState('1');
  const [smpExpectedReturn, setSmpExpectedReturn] = useState('');

  // Contractor Rate Card form state
  const [crcPartyId, setCrcPartyId] = useState('');
  const [crcItemId, setCrcItemId] = useState('');
  const [crcRate, setCrcRate] = useState('');
  const [crcDiscPct, setCrcDiscPct] = useState('0');
  const [crcMinQty, setCrcMinQty] = useState('1');
  const [crcValidUntil, setCrcValidUntil] = useState('');

  // Commission form state
  const [commPartyId, setCommPartyId] = useState('');
  const [commPartyName, setCommPartyName] = useState('');
  const [commBillNo, setCommBillNo] = useState('');
  const [commBaseAmt, setCommBaseAmt] = useState('');
  const [commPct, setCommPct] = useState('2');

  // Supplier Price List form state
  const [splPartyId, setSplPartyId] = useState('');
  const [splItemId, setSplItemId] = useState('');
  const [splSku, setSplSku] = useState('');
  const [splRate, setSplRate] = useState('');
  const [splMoq, setSplMoq] = useState('1');
  const [splLeadDays, setSplLeadDays] = useState('3');

  // ERP Delivery Trip form state
  const [tripDate, setTripDate] = useState(todayLocalIso());
  const [tripPartyId, setTripPartyId] = useState('');
  const [tripPartyName, setTripPartyName] = useState('');
  const [tripDriverName, setTripDriverName] = useState('');
  const [tripDriverPhone, setTripDriverPhone] = useState('');
  const [tripVehicleNo, setTripVehicleNo] = useState('');
  const [tripNotes, setTripNotes] = useState('');

  const loadAll = useCallback(async () => {
    const [
      locRes,
      itRes,
      partyRes,
      trRes,
      cntRes,
      ordRes,
      ldRes,
      cqRes,
      recRes,
      brkRes,
      smpRes,
      crcRes,
      commRes,
      splRes,
      tripRes,
    ] = await Promise.all([
      locationsEnabled
        ? supabase.from('locations').select('*').order('code')
        : Promise.resolve({ data: [], error: null }),
      supabase.from('item_catalog_view').select('*').eq('is_active', true).order('name').limit(200),
      isModuleEnabled('parties')
        ? supabase.from('party_balances').select('*').eq('is_active', true).order('name').limit(200)
        : Promise.resolve({ data: [], error: null }),
      locationsEnabled
        ? supabase.from('stock_transfers').select('*').order('created_at', { ascending: false }).limit(30)
        : Promise.resolve({ data: [], error: null }),
      stockCountsEnabled
        ? supabase.from('physical_stock_counts').select('*').order('created_at', { ascending: false }).limit(30)
        : Promise.resolve({ data: [], error: null }),
      ordersEnabled
        ? supabase.from('sales_orders').select('*').order('created_at', { ascending: false }).limit(40)
        : Promise.resolve({ data: [], error: null }),
      crmEnabled
        ? supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(30)
        : Promise.resolve({ data: [], error: null }),
      crmEnabled
        ? supabase.from('cheque_register').select('*').order('cheque_date', { ascending: false }).limit(30)
        : Promise.resolve({ data: [], error: null }),
      crmEnabled
        ? supabase.from('recurring_rules').select('*').order('next_run_date').limit(30)
        : Promise.resolve({ data: [], error: null }),
      breakageEnabled
        ? supabase.from('breakage_returns').select('*').order('created_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [], error: null }),
      samplesEnabled
        ? supabase.from('sample_issues').select('*').order('created_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [], error: null }),
      rateCardsEnabled
        ? supabase.from('contractor_rate_cards').select('*').order('created_at', { ascending: false }).limit(80)
        : Promise.resolve({ data: [], error: null }),
      commissionsEnabled
        ? supabase.from('commission_entries').select('*').order('created_at', { ascending: false }).limit(80)
        : Promise.resolve({ data: [], error: null }),
      supplierListsEnabled
        ? supabase.from('supplier_price_lists').select('*').order('created_at', { ascending: false }).limit(80)
        : Promise.resolve({ data: [], error: null }),
      deliveryTripsEnabled
        ? supabase.from('erp_delivery_trips').select('*').order('trip_date', { ascending: false }).limit(60)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const locs = (locRes.data as LocationRecord[] | null) ?? [];
    const itms = (itRes.data as ItemCatalogRecord[] | null) ?? [];
    const pts = (partyRes.data as PartyBalanceRecord[] | null) ?? [];
    setLocations(locs);
    setItems(itms);
    setParties(pts);
    setTransfers((trRes.data as StockTransferRecord[] | null) ?? []);
    setCounts((cntRes.data as StockCountRow[] | null) ?? []);
    setOrders((ordRes.data as OrderRow[] | null) ?? []);
    setLeads((ldRes.data as LeadRow[] | null) ?? []);
    setCheques((cqRes.data as ChequeRow[] | null) ?? []);
    setRecurring((recRes.data as RecurringRow[] | null) ?? []);
    setBreakages((brkRes.data as BreakageReturnRecord[] | null) ?? []);
    setSamples((smpRes.data as SampleIssueRecord[] | null) ?? []);
    setRateCards((crcRes.data as ContractorRateCardRecord[] | null) ?? []);
    setCommissions((commRes.data as CommissionEntryRecord[] | null) ?? []);
    setSupplierPrices((splRes.data as SupplierPriceListRecord[] | null) ?? []);
    setDeliveryTrips((tripRes.data as ErpDeliveryTripRecord[] | null) ?? []);

    if (locs.length > 0) setFromLocId((prev) => prev || locs[0].id);
    if (locs.length > 1) setToLocId((prev) => prev || locs[1].id);
    if (itms.length > 0) {
      setXferItemId((prev) => prev || itms[0].id);
      setCountItemId((prev) => prev || itms[0].id);
      setBrkItemId((prev) => prev || itms[0].id);
      setSmpItemId((prev) => prev || itms[0].id);
      setCrcItemId((prev) => prev || itms[0].id);
      setSplItemId((prev) => prev || itms[0].id);
    }
    if (pts.length > 0) {
      setCrcPartyId((prev) => prev || pts[0].party_id);
      const firstSupplier = pts.find((p) => p.party_type === 'supplier' || p.party_type === 'both') || pts[0];
      if (firstSupplier) setSplPartyId((prev) => prev || firstSupplier.party_id);
    }
  }, [
    locationsEnabled,
    stockCountsEnabled,
    ordersEnabled,
    crmEnabled,
    breakageEnabled,
    samplesEnabled,
    rateCardsEnabled,
    commissionsEnabled,
    supplierListsEnabled,
    deliveryTripsEnabled,
    isModuleEnabled,
  ]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!availableTabs.some((t) => t.key === tab) && availableTabs[0]) {
      setTab(availableTabs[0].key);
    }
  }, [availableTabs, tab]);

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

  const handleRecordBreakage = async (e: React.FormEvent) => {
    e.preventDefault();
    const it = items.find((x) => x.id === brkItemId);
    if (!it || Number(brkQty) <= 0 || !brkReason.trim()) return;
    const { error } = await supabase.rpc('record_breakage_return', {
      p_item_id: it.id,
      p_qty: Number(brkQty),
      p_unit_id: it.base_unit_id,
      p_reason: brkReason.trim(),
      p_disposition: brkDisposition,
      p_credit_amount: brkDisposition === 'credit' ? Math.max(0, Number(brkCreditAmt || 0)) : 0,
      p_party_id: brkPartyId || null,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setBrkReason('');
    setBrkQty('1');
    setBrkCreditAmt('0');
    showToast('Breakage return recorded.', 'success');
    await loadAll();
  };

  const handleIssueSample = async (e: React.FormEvent) => {
    e.preventDefault();
    const it = items.find((x) => x.id === smpItemId);
    const pName = smpPartyName.trim() || parties.find((p) => p.party_id === smpPartyId)?.name || '';
    if (!it || !pName || Number(smpQty) <= 0) return;
    const { error } = await supabase.from('sample_issues').insert({
      sample_number: `SMP-${Date.now().toString().slice(-6)}`,
      party_id: smpPartyId || null,
      party_name: pName,
      item_id: it.id,
      shade: smpShade.trim() || null,
      qty: Number(smpQty),
      unit_id: it.base_unit_id,
      issued_date: todayLocalIso(),
      expected_return_date: smpExpectedReturn || null,
      status: 'issued',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setSmpPartyName('');
    setSmpShade('');
    setSmpQty('1');
    showToast('Sample issued and tracked.', 'success');
    await loadAll();
  };

  const handleSampleStatus = async (id: string, status: 'returned' | 'kept' | 'cancelled') => {
    const { error } = await supabase
      .from('sample_issues')
      .update({
        status,
        returned_date: status === 'returned' ? todayLocalIso() : null,
      })
      .eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  const handleSaveRateCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!crcPartyId || !crcItemId || Number(crcRate) < 0) return;
    const payload = {
      party_id: crcPartyId,
      item_id: crcItemId,
      variant_id: null,
      agreed_rate: Number(crcRate),
      discount_pct: Math.min(100, Math.max(0, Number(crcDiscPct || 0))),
      min_qty: Math.max(0, Number(crcMinQty || 1)),
      valid_until: crcValidUntil || null,
      is_active: true,
    };
    const { data: existing, error: selErr } = await supabase
      .from('contractor_rate_cards')
      .select('id')
      .eq('party_id', crcPartyId)
      .eq('item_id', crcItemId)
      .is('variant_id', null)
      .maybeSingle();
    if (selErr) {
      showToast(selErr.message, 'error');
      return;
    }
    const { error } = existing
      ? await supabase
          .from('contractor_rate_cards')
          .update(payload)
          .eq('id', existing.id)
      : await supabase.from('contractor_rate_cards').insert(payload);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setCrcRate('');
    showToast('Contractor rate card saved.', 'success');
    await loadAll();
  };

  const handleToggleRateCard = async (row: ContractorRateCardRecord) => {
    const { error } = await supabase
      .from('contractor_rate_cards')
      .update({ is_active: !row.is_active })
      .eq('id', row.id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  const handleDeleteRateCard = async (id: string) => {
    const { error } = await supabase.from('contractor_rate_cards').delete().eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  const handleAddCommission = async (e: React.FormEvent) => {
    e.preventDefault();
    const pName = commPartyName.trim() || parties.find((p) => p.party_id === commPartyId)?.name || '';
    const baseAmt = Math.max(0, Number(commBaseAmt || 0));
    const pct = Math.min(100, Math.max(0, Number(commPct || 0)));
    if (!pName || baseAmt <= 0) return;
    const { error } = await supabase.from('commission_entries').insert({
      party_id: commPartyId || null,
      party_name: pName,
      bill_number: commBillNo.trim() || null,
      bill_date: todayLocalIso(),
      base_amount: baseAmt,
      commission_pct: pct,
      commission_amount: Math.round((baseAmt * pct) / 100 * 100) / 100,
      status: 'pending',
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setCommPartyName('');
    setCommBillNo('');
    setCommBaseAmt('');
    showToast('Commission entry recorded.', 'success');
    await loadAll();
  };

  const handleCommissionStatus = async (id: string, status: 'approved' | 'paid' | 'cancelled') => {
    const { error } = await supabase
      .from('commission_entries')
      .update({
        status,
        paid_date: status === 'paid' ? todayLocalIso() : null,
      })
      .eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  const handleSaveSupplierPrice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!splPartyId || !splItemId || Number(splRate) < 0) return;
    const { error } = await supabase.from('supplier_price_lists').upsert(
      {
        party_id: splPartyId,
        item_id: splItemId,
        supplier_sku: splSku.trim() || null,
        supplier_rate: Number(splRate),
        moq: Math.max(0.001, Number(splMoq || 1)),
        lead_time_days: Math.max(0, Number(splLeadDays || 0)),
        is_active: true,
      },
      { onConflict: 'party_id,item_id' }
    );
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setSplSku('');
    setSplRate('');
    showToast('Supplier price list updated.', 'success');
    await loadAll();
  };

  const handleDeleteSupplierPrice = async (id: string) => {
    const { error } = await supabase.from('supplier_price_lists').delete().eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  const handleCreateDeliveryTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    const pName = tripPartyName.trim() || parties.find((p) => p.party_id === tripPartyId)?.name || '';
    if (!pName || !tripDriverName.trim()) return;
    const { error } = await supabase.from('erp_delivery_trips').insert({
      trip_number: `TRP-${Date.now().toString().slice(-6)}`,
      trip_date: tripDate || todayLocalIso(),
      party_id: tripPartyId || null,
      party_name: pName,
      driver_name: tripDriverName.trim(),
      driver_phone: tripDriverPhone.trim() || null,
      vehicle_no: tripVehicleNo.trim().toUpperCase() || null,
      status: 'planned',
      notes: tripNotes.trim() || null,
    });
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setTripPartyName('');
    setTripDriverName('');
    setTripDriverPhone('');
    setTripVehicleNo('');
    setTripNotes('');
    showToast('Delivery trip scheduled.', 'success');
    await loadAll();
  };

  const handleTripStatus = async (id: string, status: 'dispatched' | 'delivered' | 'cancelled') => {
    const { error } = await supabase
      .from('erp_delivery_trips')
      .update({ status })
      .eq('id', id);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    await loadAll();
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconBuildingWarehouse size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>Operations, Godowns & Showroom Dispatch</span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Godown transfers, stock counts, orders, breakage returns, samples, contractor rates, commissions, supplier price lists, and delivery trips.
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
        {availableTabs.map((item) => {
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

      {/* Breakage Returns */}
      {tab === 'breakage_returns' && breakageEnabled && (
        <div className="space-y-4">
          <form
            onSubmit={handleRecordBreakage}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
          >
            <h2 className="text-base font-semibold">Record Tile / Sanitaryware Breakage Return</h2>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
              <select
                value={brkItemId}
                onChange={(e) => setBrkItemId(e.target.value)}
                className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.base_unit_code})
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0.01}
                step="0.01"
                required
                value={brkQty}
                onChange={(e) => setBrkQty(e.target.value)}
                placeholder="Qty"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
              <select
                value={brkDisposition}
                onChange={(e) =>
                  setBrkDisposition(e.target.value as 'replace' | 'credit' | 'write_off')
                }
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="write_off">Write-Off Stock</option>
                <option value="replace">Replace (Stock Out)</option>
                <option value="credit">Customer Credit</option>
              </select>
              <select
                value={brkPartyId}
                onChange={(e) => setBrkPartyId(e.target.value)}
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="">Party (Optional)</option>
                {parties.map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <input
                type="text"
                required
                value={brkReason}
                onChange={(e) => setBrkReason(e.target.value)}
                placeholder="Breakage reason (e.g. Transit crack, Site corner chip)"
                className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              {brkDisposition === 'credit' && (
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={brkCreditAmt}
                  onChange={(e) => setBrkCreditAmt(e.target.value)}
                  placeholder="Credit ₹"
                  className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
              )}
            </div>
            <button
              type="submit"
              className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
            >
              Record Breakage
            </button>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {breakages.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No breakage returns logged yet.</div>
            ) : (
              breakages.map((b) => {
                const it = items.find((i) => i.id === b.item_id);
                return (
                  <div key={b.id} className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-semibold">
                        <span className="font-mono text-xs">{b.return_number}</span> · {it?.name || 'Item'}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {b.reason} · Disposition: {b.disposition.replace('_', ' ')} · {formatDate(b.created_at)}
                      </div>
                    </div>
                    <div className="text-right tabular-nums font-semibold">
                      Qty {b.qty}
                      {Number(b.credit_amount) > 0 && (
                        <div className="text-xs text-[var(--give)]">Credit {formatINR(Number(b.credit_amount))}</div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}

      {/* Samples Tracking */}
      {tab === 'samples' && samplesEnabled && (
        <div className="space-y-4">
          <form
            onSubmit={handleIssueSample}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
          >
            <h2 className="text-base font-semibold">Issue Tile / Showroom Sample</h2>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
              <select
                value={smpPartyId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSmpPartyId(id);
                  const p = parties.find((x) => x.party_id === id);
                  if (p) setSmpPartyName(p.name);
                }}
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="">Walk-in / Architect</option>
                {parties.map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required={!smpPartyId}
                value={smpPartyName}
                onChange={(e) => setSmpPartyName(e.target.value)}
                placeholder="Customer / Architect Name"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <select
                value={smpItemId}
                onChange={(e) => setSmpItemId(e.target.value)}
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={smpShade}
                onChange={(e) => setSmpShade(e.target.value)}
                placeholder="Shade (Optional)"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <input
                type="number"
                min={0.01}
                step="0.01"
                required
                value={smpQty}
                onChange={(e) => setSmpQty(e.target.value)}
                placeholder="Qty"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="date"
                value={smpExpectedReturn}
                onChange={(e) => setSmpExpectedReturn(e.target.value)}
                className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Issue Sample
              </button>
            </div>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {samples.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No samples issued yet.</div>
            ) : (
              samples.map((s) => {
                const it = items.find((i) => i.id === s.item_id);
                return (
                  <div key={s.id} className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-semibold">
                        <span className="font-mono text-xs">{s.sample_number}</span> · {s.party_name} · {it?.name || 'Item'}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        Qty {s.qty}{s.shade ? ` · Shade ${s.shade}` : ''} · Issued {formatDate(s.issued_date)} · Status: {s.status}
                      </div>
                    </div>
                    {s.status === 'issued' && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSampleStatus(s.id, 'returned')}
                          className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
                        >
                          Returned
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSampleStatus(s.id, 'kept')}
                          className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
                        >
                          Kept by Party
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}

      {/* Contractor Rate Cards */}
      {tab === 'contractor_rate_cards' && rateCardsEnabled && (
        <div className="space-y-4">
          <form
            onSubmit={handleSaveRateCard}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
          >
            <h2 className="text-base font-semibold">Add / Update Contractor Rate Card</h2>
            <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5">
              <select
                required
                value={crcPartyId}
                onChange={(e) => setCrcPartyId(e.target.value)}
                className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {parties.map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                required
                value={crcItemId}
                onChange={(e) => setCrcItemId(e.target.value)}
                className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} (MRP/Sell {formatINR(Number(it.selling_price))})
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                step="0.01"
                required
                value={crcRate}
                onChange={(e) => setCrcRate(e.target.value)}
                placeholder="Agreed Rate ₹"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={crcDiscPct}
                onChange={(e) => setCrcDiscPct(e.target.value)}
                placeholder="Disc %"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                type="number"
                min={0}
                step="0.01"
                value={crcMinQty}
                onChange={(e) => setCrcMinQty(e.target.value)}
                placeholder="Min Qty"
                className="w-28 h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
              />
              <input
                type="date"
                value={crcValidUntil}
                onChange={(e) => setCrcValidUntil(e.target.value)}
                className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Save Rate Card
              </button>
            </div>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {rateCards.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No contractor rate cards configured yet.</div>
            ) : (
              rateCards.map((rc) => {
                const p = parties.find((x) => x.party_id === rc.party_id);
                const it = items.find((i) => i.id === rc.item_id);
                return (
                  <div key={rc.id} className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-semibold">
                        {p?.name || 'Party'} → {it?.name || 'Item'}
                      </div>
                      <div className="text-xs text-[var(--text-muted)] tabular-nums">
                        Agreed: {formatINR(Number(rc.agreed_rate))} · Disc {rc.discount_pct}% · Min Qty {rc.min_qty}
                        {rc.valid_until ? ` · Valid until ${formatDate(rc.valid_until)}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleToggleRateCard(rc)}
                        className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium"
                      >
                        {rc.is_active ? 'Active' : 'Inactive'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteRateCard(rc.id)}
                        aria-label="Delete rate card"
                        className="p-1.5 rounded text-[var(--give)] hover:bg-[var(--give-soft)]"
                      >
                        <IconTrash size={15} stroke={2} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}

      {/* Commissions */}
      {tab === 'commissions' && commissionsEnabled && (
        <div className="space-y-4">
          <form
            onSubmit={handleAddCommission}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 grid grid-cols-1 sm:grid-cols-6 gap-2.5 items-end"
          >
            <select
              value={commPartyId}
              onChange={(e) => {
                const id = e.target.value;
                setCommPartyId(id);
                const p = parties.find((x) => x.party_id === id);
                if (p) setCommPartyName(p.name);
              }}
              className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
            >
              <option value="">Select Party</option>
              {parties.map((p) => (
                <option key={p.party_id} value={p.party_id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              required={!commPartyId}
              value={commPartyName}
              onChange={(e) => setCommPartyName(e.target.value)}
              placeholder="Partner / Mason Name"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
            <input
              type="text"
              value={commBillNo}
              onChange={(e) => setCommBillNo(e.target.value)}
              placeholder="Bill # (Optional)"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
            />
            <input
              type="number"
              min={1}
              step="0.01"
              required
              value={commBaseAmt}
              onChange={(e) => setCommBaseAmt(e.target.value)}
              placeholder="Base Bill ₹"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
            />
            <input
              type="number"
              min={0}
              max={100}
              step="0.25"
              required
              value={commPct}
              onChange={(e) => setCommPct(e.target.value)}
              placeholder="Comm %"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
            />
            <button
              type="submit"
              className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
            >
              Add Commission
            </button>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {commissions.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No commission entries yet.</div>
            ) : (
              commissions.map((c) => (
                <div key={c.id} className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div>
                    <div className="font-semibold">
                      {c.party_name} {c.bill_number ? `· ${c.bill_number}` : ''}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] tabular-nums">
                      Base {formatINR(Number(c.base_amount))} @ {c.commission_pct}% · {formatDate(c.bill_date)} · {c.status}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold tabular-nums">
                      {formatINR(Number(c.commission_amount))}
                    </span>
                    {c.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => void handleCommissionStatus(c.id, 'approved')}
                        className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium"
                      >
                        Approve
                      </button>
                    )}
                    {(c.status === 'pending' || c.status === 'approved') && (
                      <button
                        type="button"
                        onClick={() => void handleCommissionStatus(c.id, 'paid')}
                        className="h-8 px-2.5 rounded-lg bg-[var(--receive)] text-white text-xs font-semibold"
                      >
                        Mark Paid
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      {/* Supplier Price Lists */}
      {tab === 'supplier_price_lists' && supplierListsEnabled && (
        <div className="space-y-4">
          <form
            onSubmit={handleSaveSupplierPrice}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 grid grid-cols-1 sm:grid-cols-6 gap-2.5 items-end"
          >
            <select
              required
              value={splPartyId}
              onChange={(e) => setSplPartyId(e.target.value)}
              className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            >
              {parties
                .filter((p) => p.party_type === 'supplier' || p.party_type === 'both')
                .map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              required
              value={splItemId}
              onChange={(e) => setSplItemId(e.target.value)}
              className="sm:col-span-2 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
            >
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={splSku}
              onChange={(e) => setSplSku(e.target.value)}
              placeholder="Supplier SKU"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
            />
            <input
              type="number"
              min={0}
              step="0.01"
              required
              value={splRate}
              onChange={(e) => setSplRate(e.target.value)}
              placeholder="Rate ₹"
              className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
            />
            <input
              type="number"
              min={1}
              step="0.01"
              value={splMoq}
              onChange={(e) => setSplMoq(e.target.value)}
              placeholder="MOQ"
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
            />
            <input
              type="number"
              min={0}
              step="1"
              value={splLeadDays}
              onChange={(e) => setSplLeadDays(e.target.value)}
              placeholder="Lead Days"
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
            />
            <button
              type="submit"
              className="sm:col-span-2 h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
            >
              Save Supplier Rate
            </button>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {supplierPrices.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No supplier price lists saved yet.</div>
            ) : (
              supplierPrices.map((sp) => {
                const p = parties.find((x) => x.party_id === sp.party_id);
                const it = items.find((i) => i.id === sp.item_id);
                return (
                  <div key={sp.id} className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-semibold">
                        {p?.name || 'Supplier'} · {it?.name || 'Item'}
                      </div>
                      <div className="text-xs text-[var(--text-muted)] tabular-nums">
                        Rate: {formatINR(Number(sp.supplier_rate))} · MOQ {sp.moq} · {sp.lead_time_days}d lead
                        {sp.supplier_sku ? ` · SKU ${sp.supplier_sku}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteSupplierPrice(sp.id)}
                      aria-label="Delete supplier rate"
                      className="p-1.5 rounded text-[var(--give)] hover:bg-[var(--give-soft)]"
                    >
                      <IconTrash size={15} stroke={2} />
                    </button>
                  </div>
                );
              })
            )}
          </section>
        </div>
      )}

      {/* ERP Showroom / Contractor Delivery Trips */}
      {tab === 'delivery_trips' && deliveryTripsEnabled && (
        <div className="space-y-4">
          <form
            onSubmit={handleCreateDeliveryTrip}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
          >
            <h2 className="text-base font-semibold">Schedule Showroom / Site Delivery Trip</h2>
            <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5">
              <input
                type="date"
                required
                value={tripDate}
                onChange={(e) => setTripDate(e.target.value)}
                className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
              />
              <select
                value={tripPartyId}
                onChange={(e) => {
                  const id = e.target.value;
                  setTripPartyId(id);
                  const p = parties.find((x) => x.party_id === id);
                  if (p) setTripPartyName(p.name);
                }}
                className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              >
                <option value="">Party (Optional)</option>
                {parties.map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required={!tripPartyId}
                value={tripPartyName}
                onChange={(e) => setTripPartyName(e.target.value)}
                placeholder="Customer / Site Name"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <input
                type="text"
                required
                value={tripDriverName}
                onChange={(e) => setTripDriverName(e.target.value)}
                placeholder="Driver Name"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <input
                type="text"
                value={tripDriverPhone}
                onChange={(e) => setTripDriverPhone(e.target.value)}
                placeholder="Driver Phone"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
              <input
                type="text"
                value={tripVehicleNo}
                onChange={(e) => setTripVehicleNo(e.target.value)}
                placeholder="Vehicle #"
                className="h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                type="text"
                value={tripNotes}
                onChange={(e) => setTripNotes(e.target.value)}
                placeholder="Dispatch / unloading notes"
                className="flex-1 min-w-[200px] h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              />
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                Create Trip
              </button>
            </div>
          </form>

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
            {deliveryTrips.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">No delivery trips scheduled yet.</div>
            ) : (
              deliveryTrips.map((tr) => (
                <div key={tr.id} className="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div>
                    <div className="font-semibold">
                      <span className="font-mono text-xs">{tr.trip_number}</span> · {tr.party_name}
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {formatDate(tr.trip_date)} · Driver: {tr.driver_name}
                      {tr.driver_phone ? ` (${tr.driver_phone})` : ''}
                      {tr.vehicle_no ? ` · ${tr.vehicle_no}` : ''} · {tr.status}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {tr.status === 'planned' && (
                      <button
                        type="button"
                        onClick={() => void handleTripStatus(tr.id, 'dispatched')}
                        className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium"
                      >
                        Dispatch
                      </button>
                    )}
                    {(tr.status === 'planned' || tr.status === 'dispatched') && (
                      <button
                        type="button"
                        onClick={() => void handleTripStatus(tr.id, 'delivered')}
                        className="h-8 px-2.5 rounded-lg bg-[var(--receive)] text-white text-xs font-semibold"
                      >
                        Delivered
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
