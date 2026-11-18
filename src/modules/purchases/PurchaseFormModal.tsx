import {
  IconAlertCircle,
  IconCheck,
  IconDeviceFloppy,
  IconPlus,
  IconSearch,
  IconShoppingBag,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { FileUpload, type UploadedFileItem } from '../../components/upload/FileUpload';
import { addDaysLocalIso, formatINR, todayLocalIso } from '../../core/format';
import { calculateBillPreview, roundHalfUp } from '../../core/money';
import { supabase } from '../../core/supabase';
import type {
  ItemCatalogRecord,
  ItemUnitRecord,
  ItemVariantRecord,
  PartyBalanceRecord,
  PaymentMode,
  PurchaseBillRecord,
  PurchaseLineRecord,
  UnitConversionRecord,
} from '../../types/bizone';

interface PurchaseFormModalProps {
  open: boolean;
  editingDraft?: PurchaseBillRecord | null;
  defaultPartyId?: string | null;
  onClose: () => void;
  onSaved: (purchase: PurchaseBillRecord, mode: 'draft' | 'posted') => void;
}

interface DraftPurchaseLine {
  localId: string;
  item: ItemCatalogRecord;
  enteredQty: string;
  enteredUnitId: string;
  unitOptions: Array<{ unitId: string; code: string; factor: number }>;
  unitCost: string;
  discountPct: string;
  taxInclusive: boolean;
  gstRate: string;
  batchNo: string;
  expiryDate: string;
  mrp: string;
  sellingRate: string;
  variantId: string;
}

const PAYMENT_MODES: PaymentMode[] = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
];

export function PurchaseFormModal({
  open,
  editingDraft,
  defaultPartyId,
  onClose,
  onSaved,
}: PurchaseFormModalProps) {
  const { business, profile, session, isModuleEnabled, language, showToast, t } = useApp();

  const taxModuleEnabled = isModuleEnabled('tax');
  const partiesEnabled = isModuleEnabled('parties');
  const paymentsEnabled = isModuleEnabled('payments');
  const pack = business?.pack || 'general_retail';
  const batchExpiryEnabled = isModuleEnabled('batch_expiry') || pack === 'medical';
  const variantsEnabled = isModuleEnabled('variants') || pack === 'clothing';
  const isStorekeeper = profile?.role === 'storekeeper';

  const [partyId, setPartyId] = useState<string>('');
  const [supplierInvNo, setSupplierInvNo] = useState('');
  const [supplierInvDate, setSupplierInvDate] = useState('');
  const [billDate, setBillDate] = useState(todayLocalIso());
  const [dueDate, setDueDate] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [gstApplied, setGstApplied] = useState(Boolean(business?.gst_registered) && taxModuleEnabled);
  const [freightCharges, setFreightCharges] = useState('0');
  const [autoRoundOff, setAutoRoundOff] = useState(true);
  const [updateItemCost, setUpdateItemCost] = useState(true);
  const [notes, setNotes] = useState('');
  const [attachment, setAttachment] = useState<UploadedFileItem | null>(null);

  const [lines, setLines] = useState<DraftPurchaseLine[]>([]);
  const [paidAmount, setPaidAmount] = useState('0');
  const [paidTouched, setPaidTouched] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [paymentReference, setPaymentReference] = useState('');

  const [suppliers, setSuppliers] = useState<PartyBalanceRecord[]>([]);
  const [catalogItems, setCatalogItems] = useState<ItemCatalogRecord[]>([]);
  const [variantsByItem, setVariantsByItem] = useState<Record<string, ItemVariantRecord[]>>({});
  const [conversionsByItem, setConversionsByItem] = useState<
    Record<string, Array<{ unitId: string; code: string; factor: number }>>
  >({});
  const [partyAddressesById, setPartyAddressesById] = useState<Record<string, string>>({});

  const [itemSearch, setItemSearch] = useState('');
  const [loadingMaster, setLoadingMaster] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const loadMasterData = useCallback(async () => {
    setLoadingMaster(true);
    try {
      const [itemsRes, convRes, unitsRes, partyRes, addrRes, varRes] = await Promise.all([
        supabase
          .from('item_catalog_view')
          .select('*')
          .eq('is_active', true)
          .order('name')
          .limit(300),
        supabase
          .from('unit_conversions')
          .select('item_id, alternate_unit_id, conversion_factor'),
        supabase.from('item_units').select('id, code'),
        partiesEnabled
          ? supabase
              .from('party_balances')
              .select('*')
              .eq('is_active', true)
              .in('party_type', ['supplier', 'both'])
              .order('name')
              .limit(300)
          : Promise.resolve({ data: [], error: null }),
        partiesEnabled
          ? supabase
              .from('party_addresses')
              .select('party_id, state_code, is_default')
              .order('is_default', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        variantsEnabled
          ? supabase.from('item_variants').select('*').eq('is_active', true).order('size')
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (itemsRes.error) throw itemsRes.error;
      if (convRes.error) throw convRes.error;
      if (unitsRes.error) throw unitsRes.error;
      if (partyRes.error) throw partyRes.error;
      if (addrRes.error) throw addrRes.error;

      const unitCodeById: Record<string, string> = {};
      for (const u of (unitsRes.data as ItemUnitRecord[] | null) ?? []) {
        unitCodeById[u.id] = u.code;
      }

      const itemsList = (itemsRes.data as ItemCatalogRecord[] | null) ?? [];
      const convMap: Record<
        string,
        Array<{ unitId: string; code: string; factor: number }>
      > = {};
      for (const it of itemsList) {
        convMap[it.id] = [
          { unitId: it.base_unit_id, code: it.base_unit_code, factor: 1 },
        ];
      }
      for (const c of (convRes.data as UnitConversionRecord[] | null) ?? []) {
        if (!c.item_id) continue;
        const code = unitCodeById[c.alternate_unit_id];
        if (!code || !convMap[c.item_id]) continue;
        if (!convMap[c.item_id].some((x) => x.unitId === c.alternate_unit_id)) {
          convMap[c.item_id].push({
            unitId: c.alternate_unit_id,
            code,
            factor: Number(c.conversion_factor),
          });
        }
      }

      const addrStateMap: Record<string, string> = {};
      for (const a of (addrRes.data as Array<{
        party_id: string;
        state_code: string | null;
      }> | null) ?? []) {
        if (a.party_id && a.state_code && !addrStateMap[a.party_id]) {
          addrStateMap[a.party_id] = a.state_code.toUpperCase();
        }
      }

      const vMap: Record<string, ItemVariantRecord[]> = {};
      for (const v of (varRes.data as ItemVariantRecord[] | null) ?? []) {
        if (!vMap[v.item_id]) vMap[v.item_id] = [];
        vMap[v.item_id].push(v);
      }

      setCatalogItems(itemsList);
      setConversionsByItem(convMap);
      setVariantsByItem(vMap);
      setSuppliers((partyRes.data as PartyBalanceRecord[] | null) ?? []);
      setPartyAddressesById(addrStateMap);
      return { itemsList, convMap, partyList: (partyRes.data as PartyBalanceRecord[] | null) ?? [], addrStateMap };
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to load items and suppliers.'
      );
      return null;
    } finally {
      setLoadingMaster(false);
    }
  }, [partiesEnabled, variantsEnabled]);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setItemSearch('');
    setPaymentMode('cash');
    setPaymentReference('');
    setIdempotencyKey(`pur_${crypto.randomUUID()}`);

    const init = async () => {
      const master = await loadMasterData();
      if (!master) return;

      if (editingDraft) {
        setPartyId(editingDraft.party_id || '');
        setSupplierInvNo(editingDraft.supplier_invoice_no || '');
        setSupplierInvDate(editingDraft.supplier_invoice_date || '');
        setBillDate(editingDraft.bill_date || todayLocalIso());
        setDueDate(editingDraft.due_date || '');
        setPlaceOfSupply(editingDraft.place_of_supply_state_code || business?.state_code || '');
        setGstApplied(Boolean(editingDraft.gst_applied) && taxModuleEnabled);
        setFreightCharges(String(editingDraft.freight_charges ?? 0));
        setAutoRoundOff(editingDraft.auto_round_off ?? true);
        setUpdateItemCost(Boolean(editingDraft.update_item_cost));
        setNotes(editingDraft.notes || '');
        setPaidTouched(false);
        setPaidAmount('0');

        if (editingDraft.attachment_file_id && session?.access_token) {
          fetch('/api/files/signed-url', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ fileId: editingDraft.attachment_file_id }),
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

        const { data: draftLines, error: dlErr } = await supabase
          .from('purchase_lines')
          .select('*')
          .eq('purchase_id', editingDraft.id)
          .order('line_no', { ascending: true });
        if (dlErr) {
          setErrorMsg(dlErr.message);
          return;
        }

        const hydrated: DraftPurchaseLine[] = [];
        for (const dl of (draftLines as PurchaseLineRecord[] | null) ?? []) {
          const item = master.itemsList.find((x) => x.id === dl.item_id);
          if (!item) continue;
          const opts = master.convMap[item.id] ?? [
            { unitId: item.base_unit_id, code: item.base_unit_code, factor: 1 },
          ];
          hydrated.push({
            localId: dl.id,
            item,
            enteredQty: String(dl.entered_qty),
            enteredUnitId: dl.entered_unit_id,
            unitOptions: opts,
            unitCost: String(dl.unit_cost),
            discountPct: String(dl.discount_pct),
            taxInclusive: Boolean(dl.tax_inclusive),
            gstRate: String(dl.gst_rate ?? item.gst_rate ?? 0),
            batchNo: dl.batch_no || '',
            expiryDate: dl.expiry_date || '',
            mrp: dl.mrp != null ? String(dl.mrp) : '',
            sellingRate: dl.selling_rate != null ? String(dl.selling_rate) : '',
            variantId: dl.variant_id || '',
          });
        }
        setLines(hydrated);
      } else {
        const initParty = defaultPartyId || '';
        setPartyId(initParty);
        setSupplierInvNo('');
        setSupplierInvDate('');
        setBillDate(todayLocalIso());
        const partyObj = master.partyList.find((p) => p.party_id === initParty);
        setDueDate(
          partyObj && partyObj.credit_days > 0
            ? addDaysLocalIso(todayLocalIso(), partyObj.credit_days)
            : ''
        );
        setPlaceOfSupply(
          (initParty && master.addrStateMap[initParty]) || business?.state_code || ''
        );
        setGstApplied(Boolean(business?.gst_registered) && taxModuleEnabled);
        setFreightCharges('0');
        setAutoRoundOff(true);
        setUpdateItemCost(true);
        setNotes('');
        setAttachment(null);
        setLines([]);
        setPaidTouched(false);
        setPaidAmount('0');
      }
    };

    void init();
  }, [open, editingDraft, defaultPartyId, business?.gst_registered, business?.state_code, taxModuleEnabled, loadMasterData, session?.access_token]);

  const handlePartyChange = (nextPartyId: string) => {
    setPartyId(nextPartyId);
    setPaidTouched(false);
    if (!nextPartyId) {
      setDueDate('');
      setPlaceOfSupply(business?.state_code || '');
      return;
    }
    const p = suppliers.find((x) => x.party_id === nextPartyId);
    if (p && p.credit_days > 0) {
      setDueDate(addDaysLocalIso(billDate || todayLocalIso(), p.credit_days));
    } else {
      setDueDate('');
    }
    const pos = partyAddressesById[nextPartyId] || business?.state_code || '';
    setPlaceOfSupply(pos);
  };

  const isInterstate = useMemo(() => {
    if (!gstApplied || !taxModuleEnabled) return false;
    const bizState = (business?.state_code || '').trim().toUpperCase();
    const pos = placeOfSupply.trim().toUpperCase();
    return Boolean(bizState && pos && bizState !== pos);
  }, [gstApplied, taxModuleEnabled, business?.state_code, placeOfSupply]);

  const calc = useMemo(() => {
    return calculateBillPreview({
      gstRegistered: gstApplied && taxModuleEnabled,
      docType: gstApplied && taxModuleEnabled ? 'tax_invoice' : 'bill_of_supply',
      isInterstate,
      extraCharges: Math.max(0, Number(freightCharges || 0)),
      autoRoundOff,
      lines: lines.map((l) => ({
        enteredQty: Math.max(0, Number(l.enteredQty || 0)),
        unitPrice: Math.max(0, Number(l.unitCost || 0)),
        discountPct: Math.min(100, Math.max(0, Number(l.discountPct || 0))),
        taxInclusive: l.taxInclusive,
        gstRate: Number(l.gstRate || 0),
      })),
    });
  }, [gstApplied, taxModuleEnabled, isInterstate, freightCharges, autoRoundOff, lines]);

  const effectivePaidNumber = useMemo(() => {
    if (!partyId) return calc.grandTotal;
    if (!paymentsEnabled || isStorekeeper) return 0;
    const raw = paidTouched ? Number(paidAmount || 0) : 0;
    return Math.min(calc.grandTotal, Math.max(0, roundHalfUp(raw, 2)));
  }, [partyId, paymentsEnabled, isStorekeeper, paidTouched, paidAmount, calc.grandTotal]);

  const matchingCatalogItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return catalogItems.slice(0, 8);
    return catalogItems
      .filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          (it.sku ?? '').toLowerCase().includes(q) ||
          (it.barcode ?? '').toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [catalogItems, itemSearch]);

  const addItemLine = (item: ItemCatalogRecord) => {
    const unitOptions = conversionsByItem[item.id] ?? [
      { unitId: item.base_unit_id, code: item.base_unit_code, factor: 1 },
    ];
    const cost = Number(item.purchase_price ?? 0);
    setLines((prev) => [
      ...prev,
      {
        localId: `${item.id}_${Date.now()}_${Math.random()}`,
        item,
        enteredQty: '1',
        enteredUnitId: item.base_unit_id,
        unitOptions,
        unitCost: String(cost),
        discountPct: '0',
        taxInclusive: Boolean(item.tax_inclusive),
        gstRate: String(Number(item.gst_rate ?? 0)),
        batchNo: '',
        expiryDate: '',
        mrp: item.mrp != null ? String(item.mrp) : '',
        sellingRate: String(item.selling_price ?? ''),
        variantId: '',
      },
    ]);
    setItemSearch('');
  };

  const handleUnitChange = (localId: string, nextUnitId: string) => {
    setLines((prev) =>
      prev.map((row) => {
        if (row.localId !== localId) return row;
        const nextOpt = row.unitOptions.find((u) => u.unitId === nextUnitId);
        const factor = nextOpt?.factor ?? 1;
        const baseCost = Number(row.item.purchase_price ?? 0);
        return {
          ...row,
          enteredUnitId: nextUnitId,
          unitCost: String(roundHalfUp(baseCost * factor, 2)),
        };
      })
    );
  };

  const buildRpcLines = () =>
    lines.map((l) => ({
      item_id: l.item.id,
      entered_qty: Math.max(0, Number(l.enteredQty || 0)),
      entered_unit_id: l.enteredUnitId,
      unit_cost: Math.max(0, roundHalfUp(Number(l.unitCost || 0), 2)),
      discount_pct: Math.min(100, Math.max(0, roundHalfUp(Number(l.discountPct || 0), 2))),
      tax_inclusive: l.taxInclusive,
      gst_rate: Number(l.gstRate || 0),
      batch_no: l.batchNo.trim() || null,
      expiry_date: l.expiryDate || null,
      mrp: l.mrp ? roundHalfUp(Number(l.mrp), 2) : null,
      selling_rate: l.sellingRate ? roundHalfUp(Number(l.sellingRate), 2) : null,
      variant_id: l.variantId || null,
    }));

  const handleSubmit = async (actionMode: 'draft' | 'posted') => {
    setErrorMsg(null);
    if (lines.length === 0) {
      setErrorMsg(
        language === 'hi'
          ? 'कृपया कम से कम एक सामान जोड़ें।'
          : 'Please add at least one item line.'
      );
      return;
    }
    if (lines.some((l) => !Number.isFinite(Number(l.enteredQty)) || Number(l.enteredQty) <= 0)) {
      setErrorMsg(
        language === 'hi'
          ? 'सभी सामान की मात्रा 0 से अधिक होनी चाहिए।'
          : 'Every item quantity must be greater than zero.'
      );
      return;
    }

    setSubmitting(true);
    try {
      const rpcLines = buildRpcLines();
      if (actionMode === 'draft') {
        const { data, error } = await supabase.rpc('save_purchase_draft', {
          p_id: editingDraft?.id ?? null,
          p_party_id: partyId || null,
          p_supplier_invoice_no: supplierInvNo.trim() || null,
          p_supplier_invoice_date: supplierInvDate || null,
          p_bill_date: billDate || todayLocalIso(),
          p_due_date: dueDate || null,
          p_place_of_supply: placeOfSupply.trim() || null,
          p_gst_applied: gstApplied && taxModuleEnabled,
          p_freight_charges: Math.max(0, roundHalfUp(Number(freightCharges || 0), 2)),
          p_auto_round_off: autoRoundOff,
          p_update_item_cost: updateItemCost,
          p_notes: notes.trim() || null,
          p_attachment_file_id: attachment?.fileId ?? null,
          p_lines: rpcLines,
        });
        if (error) throw error;
        showToast(
          language === 'hi' ? 'खरीद ड्राफ्ट सहेजा गया।' : 'Purchase draft saved.',
          'success'
        );
        onSaved(data as PurchaseBillRecord, 'draft');
        onClose();
      } else {
        const { data, error } = await supabase.rpc('issue_purchase', {
          p_draft_id: editingDraft?.id ?? null,
          p_party_id: partyId || null,
          p_supplier_invoice_no: supplierInvNo.trim() || null,
          p_supplier_invoice_date: supplierInvDate || null,
          p_bill_date: billDate || todayLocalIso(),
          p_due_date: dueDate || null,
          p_place_of_supply: placeOfSupply.trim() || null,
          p_gst_applied: gstApplied && taxModuleEnabled,
          p_freight_charges: Math.max(0, roundHalfUp(Number(freightCharges || 0), 2)),
          p_auto_round_off: autoRoundOff,
          p_update_item_cost: updateItemCost,
          p_notes: notes.trim() || null,
          p_attachment_file_id: attachment?.fileId ?? null,
          p_lines: rpcLines,
          p_paid_amount: effectivePaidNumber,
          p_payment_mode: paymentMode,
          p_payment_reference: paymentReference.trim() || null,
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        const posted = data as PurchaseBillRecord;
        showToast(
          language === 'hi'
            ? `${posted.purchase_number} दर्ज किया गया।`
            : `${posted.purchase_number} posted & stock updated.`,
          'success'
        );
        onSaved(posted, 'posted');
        onClose();
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to save or post purchase.'
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
        aria-label={t('purchases.newPurchase')}
        className="w-full sm:max-w-5xl max-h-[95vh] rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <IconShoppingBag size={20} stroke={2} className="text-[var(--primary-dark)]" />
            <h2 className="text-base sm:text-lg font-semibold">
              {editingDraft
                ? `${language === 'hi' ? 'ड्राफ्ट संपादित करें' : 'Edit Purchase Draft'}`
                : t('purchases.newPurchase')}
            </h2>
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs sm:text-sm text-[var(--give)] flex items-start gap-2">
              <IconAlertCircle size={16} stroke={2} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Supplier & Dates */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-4">
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('purchases.supplierLabel')}
              </label>
              <select
                value={partyId}
                onChange={(e) => handlePartyChange(e.target.value)}
                disabled={!partiesEnabled}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="">{t('purchases.cashSupplier')}</option>
                {suppliers.map((s) => (
                  <option key={s.party_id} value={s.party_id}>
                    {s.name}
                    {s.phone ? ` (${s.phone})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('purchases.supplierInvNo')}
              </label>
              <input
                type="text"
                value={supplierInvNo}
                onChange={(e) => setSupplierInvNo(e.target.value)}
                placeholder="e.g. SUP-409"
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('purchases.supplierInvDate')}
              </label>
              <input
                type="date"
                value={supplierInvDate}
                onChange={(e) => setSupplierInvDate(e.target.value)}
                className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('purchases.billDate')}
              </label>
              <input
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('purchases.dueDate')}
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={!partyId}
                className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums disabled:opacity-50"
              />
            </div>
          </div>

          {/* Tax & Cost Toggles */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={gstApplied}
                  disabled={!taxModuleEnabled}
                  onChange={(e) => setGstApplied(e.target.checked)}
                />
                <span>{t('purchases.applyGst')}</span>
              </label>

              {gstApplied && taxModuleEnabled && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-muted)]">State Code:</span>
                  <input
                    type="text"
                    maxLength={2}
                    value={placeOfSupply}
                    onChange={(e) => setPlaceOfSupply(e.target.value.toUpperCase())}
                    placeholder="MH"
                    className="w-16 h-8 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs uppercase text-center"
                  />
                  <span className="text-xs font-medium text-[var(--text-muted)]">
                    {isInterstate ? t('bills.interstate') : t('bills.intrastate')}
                  </span>
                </div>
              )}
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={updateItemCost}
                onChange={(e) => setUpdateItemCost(e.target.checked)}
              />
              <span>{t('purchases.updateItemCost')}</span>
            </label>
          </div>

          {/* Item Search Picker */}
          <div className="space-y-2">
            <div className="relative">
              <IconSearch
                size={16}
                stroke={2}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
              />
              <input
                type="text"
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
                placeholder={t('bills.addItemLine')}
                className="w-full h-11 pl-9 pr-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm"
              />
            </div>

            {loadingMaster ? (
              <p className="text-xs text-[var(--text-muted)]">{t('common.loading')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {matchingCatalogItems.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => addItemLine(it)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] hover:border-[var(--primary-dark)] text-xs"
                  >
                    <IconPlus size={13} stroke={2.5} />
                    <span className="font-medium">{it.name}</span>
                    <span className="text-[var(--text-muted)] tabular-nums">
                      ({formatINR(it.purchase_price ?? 0)})
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Line Items Table */}
          {lines.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
              <table className="w-full text-xs sm:text-sm border-collapse min-w-[720px]">
                <thead>
                  <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="text-left px-3 py-2 font-medium">#</th>
                    <th className="text-left px-3 py-2 font-medium">Item</th>
                    <th className="text-right px-2 py-2 font-medium w-20">{t('bills.qty')}</th>
                    <th className="text-left px-2 py-2 font-medium w-24">{t('bills.unit')}</th>
                    <th className="text-right px-2 py-2 font-medium w-28">Cost (₹)</th>
                    <th className="text-right px-2 py-2 font-medium w-20">{t('bills.discPct')}</th>
                    {gstApplied && taxModuleEnabled && (
                      <>
                        <th className="text-right px-2 py-2 font-medium w-20">GST %</th>
                        <th className="text-center px-2 py-2 font-medium w-16">Incl.</th>
                      </>
                    )}
                    <th className="text-right px-3 py-2 font-medium w-28">{t('bills.amount')}</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((row, idx) => {
                    const lineCalc = calc.lines[idx];
                    return (
                      <tr key={row.localId} className="border-b border-[var(--border)] last:border-b-0">
                        <td className="px-3 py-2 text-[var(--text-muted)] tabular-nums">{idx + 1}</td>
                        <td className="px-3 py-2 min-w-[210px]">
                          <div className="font-medium">{row.item.name}</div>
                          <div className="text-[11px] text-[var(--text-muted)]">
                            Stock: {row.item.qty_on_hand} {row.item.base_unit_code}
                            {row.item.hsn_code ? ` · HSN ${row.item.hsn_code}` : ''}
                          </div>
                          {batchExpiryEnabled && (
                            <div className="mt-1.5 grid grid-cols-3 gap-1">
                              <input
                                type="text"
                                value={row.batchNo}
                                placeholder="Batch #"
                                onChange={(e) =>
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId ? { ...x, batchNo: e.target.value } : x
                                    )
                                  )
                                }
                                className="h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] font-mono"
                              />
                              <input
                                type="date"
                                value={row.expiryDate}
                                title="Expiry date"
                                onChange={(e) =>
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId ? { ...x, expiryDate: e.target.value } : x
                                    )
                                  )
                                }
                                className="h-7 px-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] tabular-nums"
                              />
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={row.mrp}
                                placeholder="MRP"
                                onChange={(e) =>
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId ? { ...x, mrp: e.target.value } : x
                                    )
                                  )
                                }
                                className="h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] tabular-nums"
                              />
                            </div>
                          )}
                          {variantsEnabled && (variantsByItem[row.item.id] ?? []).length > 0 && (
                            <div className="mt-1.5">
                              <select
                                value={row.variantId}
                                onChange={(e) =>
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId ? { ...x, variantId: e.target.value } : x
                                    )
                                  )
                                }
                                className="h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px]"
                              >
                                <option value="">Select Variant</option>
                                {(variantsByItem[row.item.id] ?? []).map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.size} / {v.color} ({v.qty_on_hand})
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            step="any"
                            min="0.001"
                            value={row.enteredQty}
                            onChange={(e) =>
                              setLines((prev) =>
                                prev.map((x) =>
                                  x.localId === row.localId ? { ...x, enteredQty: e.target.value } : x
                                )
                              )
                            }
                            className="w-full h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <select
                            value={row.enteredUnitId}
                            onChange={(e) => handleUnitChange(row.localId, e.target.value)}
                            className="w-full h-9 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-xs"
                          >
                            {row.unitOptions.map((u) => (
                              <option key={u.unitId} value={u.unitId}>
                                {u.code}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={row.unitCost}
                            onChange={(e) =>
                              setLines((prev) =>
                                prev.map((x) =>
                                  x.localId === row.localId ? { ...x, unitCost: e.target.value } : x
                                )
                              )
                            }
                            className="w-full h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            value={row.discountPct}
                            onChange={(e) =>
                              setLines((prev) =>
                                prev.map((x) =>
                                  x.localId === row.localId ? { ...x, discountPct: e.target.value } : x
                                )
                              )
                            }
                            className="w-full h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums"
                          />
                        </td>
                        {gstApplied && taxModuleEnabled && (
                          <>
                            <td className="px-2 py-2">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                max="100"
                                value={row.gstRate}
                                onChange={(e) =>
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId ? { ...x, gstRate: e.target.value } : x
                                    )
                                  )
                                }
                                className="w-full h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums"
                              />
                            </td>
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={row.taxInclusive}
                                onChange={(e) =>
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId
                                        ? { ...x, taxInclusive: e.target.checked }
                                        : x
                                    )
                                  )
                                }
                              />
                            </td>
                          </>
                        )}
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">
                          {formatINR(lineCalc?.lineTotal ?? 0)}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setLines((prev) => prev.filter((x) => x.localId !== row.localId))
                            }
                            aria-label="Remove line"
                            className="p-1.5 text-[var(--give)] hover:bg-[var(--give-soft)] rounded"
                          >
                            <IconTrash size={15} stroke={2} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Totals, Attachment & Payment Settlement */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7 space-y-4">
              <FileUpload
                label={t('purchases.attachment')}
                value={attachment}
                onChange={setAttachment}
                helperText="Optional scan or PDF of the supplier's tax invoice (max 5 MB)."
              />
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('parties.notes')}
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional remarks, lorry/LR number, or batch notes..."
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
              </div>
            </div>

            <div className="lg:col-span-5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 space-y-3">
              <div className="space-y-1.5 text-xs sm:text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">{t('bills.taxableSubtotal')}</span>
                  <span className="tabular-nums">{formatINR(calc.subtotalTaxable)}</span>
                </div>
                {calc.discountTotal > 0 && (
                  <div className="flex justify-between text-[var(--receive-text)]">
                    <span>{t('bills.discountTotal')}</span>
                    <span className="tabular-nums">-{formatINR(calc.discountTotal)}</span>
                  </div>
                )}
                {gstApplied && taxModuleEnabled && (
                  <>
                    {calc.isInterstate ? (
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">IGST Input</span>
                        <span className="tabular-nums">{formatINR(calc.igstTotal)}</span>
                      </div>
                    ) : (
                      <>
                        <div className="flex justify-between">
                          <span className="text-[var(--text-muted)]">CGST Input</span>
                          <span className="tabular-nums">{formatINR(calc.cgstTotal)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[var(--text-muted)]">SGST Input</span>
                          <span className="tabular-nums">{formatINR(calc.sgstTotal)}</span>
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-muted)]">{t('purchases.freightCharges')}</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={freightCharges}
                    onChange={(e) => setFreightCharges(e.target.value)}
                    className="w-28 h-8 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-right text-xs tabular-nums"
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <label className="inline-flex items-center gap-1.5 text-[var(--text-muted)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRoundOff}
                      onChange={(e) => setAutoRoundOff(e.target.checked)}
                    />
                    <span>{t('bills.roundOff')}</span>
                  </label>
                  <span className="tabular-nums">{calc.roundOff.toFixed(2)}</span>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--border)] flex items-center justify-between text-base font-bold">
                <span>{t('bills.grandTotal')}</span>
                <span className="tabular-nums">{formatINR(calc.grandTotal)}</span>
              </div>

              {/* Settlement */}
              <div className="pt-2 border-t border-[var(--border)] space-y-2.5">
                {!partyId ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    Cash supplier purchases are settled in full ({formatINR(calc.grandTotal)}).
                  </p>
                ) : !paymentsEnabled || isStorekeeper ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    {isStorekeeper
                      ? 'Storekeeper posts to Supplier Khata (₹0 paid now). Accounts/Manager can settle payment.'
                      : 'Payments module disabled — full total posts to Supplier Khata.'}
                  </p>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-[var(--text-muted)]">
                        {t('bills.paidNow')}
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setPaidTouched(true);
                          setPaidAmount(String(calc.grandTotal));
                        }}
                        className="text-xs font-medium text-[var(--primary-dark)] hover:underline"
                      >
                        Pay Full
                      </button>
                    </div>
                    <input
                      type="number"
                      min="0"
                      max={calc.grandTotal}
                      step="0.01"
                      value={paidTouched ? paidAmount : '0'}
                      onChange={(e) => {
                        setPaidTouched(true);
                        setPaidAmount(e.target.value);
                      }}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-right tabular-nums"
                    />
                    <div className="mt-1 flex justify-between text-xs text-[var(--text-muted)]">
                      <span>Balance Payable (Khata)</span>
                      <span className="tabular-nums font-medium">
                        {formatINR(Math.max(0, roundHalfUp(calc.grandTotal - effectivePaidNumber, 2)))}
                      </span>
                    </div>
                  </div>
                )}

                {(!partyId || effectivePaidNumber > 0) && calc.grandTotal > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                        {t('payments.mode')}
                      </label>
                      <select
                        value={paymentMode}
                        onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
                        className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      >
                        {PAYMENT_MODES.map((m) => (
                          <option key={m} value={m}>
                            {t(`payments.modes.${m}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                        {t('payments.referenceNo')}
                      </label>
                      <input
                        type="text"
                        value={paymentReference}
                        onChange={(e) => setPaymentReference(e.target.value)}
                        placeholder="UTR / Cheque #"
                        className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-[var(--border)] bg-[var(--surface)] flex flex-wrap items-center justify-end gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-10 px-4 rounded-xl border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit('draft')}
            disabled={submitting || lines.length === 0}
            className="h-10 px-4 rounded-xl border border-[var(--border)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)] disabled:opacity-50"
          >
            <IconDeviceFloppy size={16} stroke={2} />
            <span>{t('purchases.saveDraft')}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit('posted')}
            disabled={submitting || lines.length === 0}
            className="h-10 px-5 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-slate-950 font-semibold text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <IconCheck size={17} stroke={2.5} />
            <span>{submitting ? t('common.loading') : t('purchases.postPurchase')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
