import {
  IconAlertCircle,
  IconArrowLeft,
  IconArrowsExchange,
  IconCamera,
  IconCheck,
  IconDeviceFloppy,
  IconFileText,
  IconMinus,
  IconPlus,
  IconShoppingBag,
  IconSparkles,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { BarcodeScanBar } from '../../components/barcode/BarcodeScanBar';
import { playScanBeep, useBarcodeWedge } from '../../components/barcode/useBarcodeWedge';
import { FileUpload, type UploadedFileItem } from '../../components/upload/FileUpload';
import { addDaysLocalIso, formatINR, todayLocalIso } from '../../core/format';
import { erpFetch } from '../../core/erpFetch';
import { calculateBillPreview, convertRateTaxMode, roundHalfUp } from '../../core/money';
import { supabase } from '../../core/supabase';
import type {
  ItemCatalogRecord,
  ItemUnitRecord,
  ItemVariantRecord,
  PartyBalanceRecord,
  PaymentMode,
  PurchaseBillRecord,
  PurchaseLineRecord,
  SupplierPriceListRecord,
  UnitConversionRecord,
} from '../../types/decorbiz';

export interface NewPurchaseScreenProps {
  editingDraft?: PurchaseBillRecord | null;
  defaultPartyId?: string | null;
  onCancel: () => void;
  onSaved: (purchase: PurchaseBillRecord, mode: 'draft' | 'posted') => void;
}

interface DraftPurchaseLine {
  localId: string;
  item: ItemCatalogRecord;
  variantId?: string;
  shade?: string;
  batchLot?: string;
  supplierPriceHint?: string;
  enteredQty: string;
  enteredUnitId: string;
  unitOptions: Array<{ unitId: string; code: string; factor: number }>;
  unitCost: string;
  discountPct: string;
  taxInclusive: boolean;
  gstRate: string;
  mrp: string;
}

interface ScannedLineReview {
  localId: string;
  raw_name: string;
  matched_item_id: string;
  match_confidence: number;
  hsn_code: string | null;
  qty: number;
  unit_code: string | null;
  unit_cost: number;
  discount_pct: number;
  gst_rate: number;
  tax_inclusive: boolean;
  mrp: number | null;
}

interface ScannedInvoiceReview {
  supplier_name?: string | null;
  supplier_gstin?: string | null;
  supplier_invoice_no?: string | null;
  supplier_invoice_date?: string | null;
  due_date?: string | null;
  place_of_supply_state_code?: string | null;
  tax_mode: 'exclusive' | 'inclusive';
  freight_charges: number;
  notes?: string | null;
  matched_supplier_id: string;
  lines: ScannedLineReview[];
}

const PAYMENT_MODES: PaymentMode[] = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      resolve(res.includes(',') ? res.split(',')[1] || '' : res);
    };
    reader.onerror = () => reject(new Error('Failed to read selected file.'));
    reader.readAsDataURL(file);
  });
}

export function NewPurchaseScreen({
  editingDraft,
  defaultPartyId,
  onCancel,
  onSaved,
}: NewPurchaseScreenProps) {
  const { business, profile, session, isModuleEnabled, language, showToast, t } = useApp();

  const taxModuleEnabled = isModuleEnabled('tax');
  const partiesEnabled = isModuleEnabled('parties');
  const paymentsEnabled = isModuleEnabled('payments');
  const supplierPriceListsEnabled = isModuleEnabled('supplier_price_lists');
  const isStorekeeper = profile?.role === 'storekeeper';

  const [partyId, setPartyId] = useState<string>('');
  const [supplierInvNo, setSupplierInvNo] = useState('');
  const [supplierInvDate, setSupplierInvDate] = useState('');
  const [billDate, setBillDate] = useState(todayLocalIso());
  const [dueDate, setDueDate] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [gstApplied, setGstApplied] = useState(Boolean(business?.gst_registered) && taxModuleEnabled);
  const [defaultCostTaxInclusive, setDefaultCostTaxInclusive] = useState(false);
  const [freightCharges, setFreightCharges] = useState('0');
  const [autoRoundOff, setAutoRoundOff] = useState(true);
  const [updateItemCost, setUpdateItemCost] = useState(true);
  const [notes, setNotes] = useState('');
  const [attachment, setAttachment] = useState<UploadedFileItem | null>(null);

  const [lines, setLines] = useState<DraftPurchaseLine[]>([]);
  const [lastHighlightedId, setLastHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  const [paidAmount, setPaidAmount] = useState('0');
  const [paidTouched, setPaidTouched] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [paymentReference, setPaymentReference] = useState('');

  const [suppliers, setSuppliers] = useState<PartyBalanceRecord[]>([]);
  const [catalogItems, setCatalogItems] = useState<ItemCatalogRecord[]>([]);
  const [variantsByItem, setVariantsByItem] = useState<Record<string, ItemVariantRecord[]>>({});
  const [supplierPriceLists, setSupplierPriceLists] = useState<SupplierPriceListRecord[]>([]);
  const [conversionsByItem, setConversionsByItem] = useState<
    Record<string, Array<{ unitId: string; code: string; factor: number }>>
  >({});
  const [partyAddressesById, setPartyAddressesById] = useState<Record<string, string>>({});

  // AI Purchase Invoice Scanner state
  const scanFileInputRef = useRef<HTMLInputElement | null>(null);
  const scanCameraInputRef = useRef<HTMLInputElement | null>(null);
  const [scanningInvoice, setScanningInvoice] = useState(false);
  const [scanReview, setScanReview] = useState<ScannedInvoiceReview | null>(null);

  // AI Order Text state
  const [aiTextOpen, setAiTextOpen] = useState(false);
  const [aiOrderText, setAiOrderText] = useState('');
  const [aiParsing, setAiParsing] = useState(false);

  const [itemSearch, setItemSearch] = useState('');
  const [loadingMaster, setLoadingMaster] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const flashHighlight = useCallback((id: string) => {
    setLastHighlightedId(id);
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setLastHighlightedId(null);
    }, 1100);
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const loadMasterData = useCallback(async () => {
    setLoadingMaster(true);
    try {
      const [itemsRes, convRes, unitsRes, varRes, splRes, partyRes, addrRes] = await Promise.all([
        supabase
          .from('item_catalog_view')
          .select('*')
          .eq('is_active', true)
          .order('name')
          .limit(400),
        supabase
          .from('unit_conversions')
          .select('item_id, alternate_unit_id, conversion_factor'),
        supabase.from('item_units').select('id, code'),
        supabase
          .from('item_variants_view')
          .select('*')
          .eq('is_active', true)
          .order('variant_name')
          .limit(600),
        supplierPriceListsEnabled
          ? supabase.from('supplier_price_lists').select('*').eq('is_active', true)
          : Promise.resolve({ data: [], error: null }),
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
      ]);

      if (itemsRes.error) throw itemsRes.error;
      if (convRes.error) throw convRes.error;
      if (unitsRes.error) throw unitsRes.error;
      if (varRes.error) throw varRes.error;
      if (splRes.error) throw splRes.error;
      if (partyRes.error) throw partyRes.error;
      if (addrRes.error) throw addrRes.error;

      const unitCodeById: Record<string, string> = {};
      for (const u of (unitsRes.data as ItemUnitRecord[] | null) ?? []) {
        unitCodeById[u.id] = u.code;
      }

      const varMap: Record<string, ItemVariantRecord[]> = {};
      for (const v of (varRes.data as ItemVariantRecord[] | null) ?? []) {
        if (!varMap[v.item_id]) varMap[v.item_id] = [];
        varMap[v.item_id].push(v);
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

      setCatalogItems(itemsList);
      setConversionsByItem(convMap);
      setVariantsByItem(varMap);
      setSupplierPriceLists((splRes.data as SupplierPriceListRecord[] | null) ?? []);
      setSuppliers((partyRes.data as PartyBalanceRecord[] | null) ?? []);
      setPartyAddressesById(addrStateMap);
      return {
        itemsList,
        convMap,
        partyList: (partyRes.data as PartyBalanceRecord[] | null) ?? [],
        addrStateMap,
      };
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to load items and suppliers.'
      );
      return null;
    } finally {
      setLoadingMaster(false);
    }
  }, [partiesEnabled, supplierPriceListsEnabled]);

  useEffect(() => {
    setErrorMsg(null);
    setItemSearch('');
    setPaymentMode('cash');
    setPaymentReference('');
    setScanReview(null);
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
          erpFetch('/api/erp/files/signed-url', session.access_token, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
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
            variantId: dl.variant_id || undefined,
            shade: dl.shade || undefined,
            batchLot: dl.batch_lot || undefined,
            enteredQty: String(dl.entered_qty),
            enteredUnitId: dl.entered_unit_id,
            unitOptions: opts,
            unitCost: String(dl.unit_cost),
            discountPct: String(dl.discount_pct),
            taxInclusive: Boolean(dl.tax_inclusive),
            gstRate: String(dl.gst_rate ?? item.gst_rate ?? 0),
            mrp: dl.mrp != null ? String(dl.mrp) : '',
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
        setDefaultCostTaxInclusive(false);
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
  }, [
    editingDraft,
    defaultPartyId,
    business?.gst_registered,
    business?.state_code,
    taxModuleEnabled,
    loadMasterData,
    session?.access_token,
  ]);

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
    if (!q) return catalogItems.slice(0, 10);
    return catalogItems
      .filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          (it.sku ?? '').toLowerCase().includes(q) ||
          (it.barcode ?? '').toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [catalogItems, itemSearch]);

  // Notice: items.purchase_price in Postgres is stored TAX EXCLUSIVE.
  // So initializing unitCost from item.purchase_price uses exclusive cost directly;
  // only convert to tax-inclusive if user toggled defaultCostTaxInclusive === true!
  const addItemLine = useCallback(
    (
      item: ItemCatalogRecord,
      opts?: {
        qtyOverride?: number;
        unitCodeOverride?: string | null;
        costOverride?: number | null;
        discountPctOverride?: number | null;
        gstRateOverride?: number | null;
        taxInclusiveOverride?: boolean;
        mrp?: number | null;
      }
    ) => {
      const targetUnitOpt = opts?.unitCodeOverride
        ? (conversionsByItem[item.id] ?? []).find(
            (u) => u.code.toLowerCase() === opts.unitCodeOverride!.toLowerCase()
          )
        : undefined;
      const targetUnitId = targetUnitOpt?.unitId || item.base_unit_id;
      const factor = targetUnitOpt?.factor ?? 1;
      const gstNum = Number(opts?.gstRateOverride ?? item.gst_rate ?? 0);
      const useInclusive =
        opts?.taxInclusiveOverride !== undefined
          ? opts.taxInclusiveOverride
          : defaultCostTaxInclusive;

      const activeDay = billDate || todayLocalIso();
      const matchedSpl =
        supplierPriceListsEnabled && partyId && opts?.costOverride == null
          ? supplierPriceLists.find(
              (r) =>
                r.party_id === partyId &&
                r.item_id === item.id &&
                r.is_active &&
                (!r.valid_until || r.valid_until >= activeDay)
            ) || null
          : null;

      const exclusiveBaseCost =
        (matchedSpl ? Number(matchedSpl.supplier_rate) : Number(item.purchase_price ?? 0)) * factor;
      const derivedCost =
        opts?.costOverride != null
          ? roundHalfUp(Number(opts.costOverride), 2)
          : useInclusive && gstApplied && taxModuleEnabled && gstNum > 0
            ? convertRateTaxMode(exclusiveBaseCost, gstNum, false, true)
            : roundHalfUp(exclusiveBaseCost, 2);

      const hint = matchedSpl
        ? `Supplier Rate · MOQ ${matchedSpl.moq} · ${matchedSpl.lead_time_days}d lead${matchedSpl.supplier_sku ? ` · ${matchedSpl.supplier_sku}` : ''}`
        : undefined;

      const newId = `${item.id}_${Date.now()}_${Math.random()}`;
      setLines((prev) => {
        if (
          opts?.costOverride == null &&
          prev.some((l) => l.item.id === item.id && l.enteredUnitId === targetUnitId && !l.variantId)
        ) {
          const existing = prev.find(
            (l) => l.item.id === item.id && l.enteredUnitId === targetUnitId && !l.variantId
          )!;
          flashHighlight(existing.localId);
          return prev.map((l) =>
            l.localId === existing.localId
              ? {
                  ...l,
                  enteredQty: String(roundHalfUp(Number(l.enteredQty || 0) + (opts?.qtyOverride ?? 1), 3)),
                }
              : l
          );
        }
        const unitOptions = conversionsByItem[item.id] ?? [
          { unitId: item.base_unit_id, code: item.base_unit_code, factor: 1 },
        ];
        flashHighlight(newId);
        return [
          ...prev,
          {
            localId: newId,
            item,
            supplierPriceHint: hint,
            enteredQty: String(opts?.qtyOverride ?? 1),
            enteredUnitId: targetUnitId,
            unitOptions,
            unitCost: String(derivedCost),
            discountPct: String(opts?.discountPctOverride ?? 0),
            taxInclusive: useInclusive,
            gstRate: String(gstNum),
            mrp: opts?.mrp != null ? String(opts.mrp) : item.mrp != null ? String(item.mrp) : '',
          },
        ];
      });
      setItemSearch('');
    },
    [
      billDate,
      conversionsByItem,
      defaultCostTaxInclusive,
      flashHighlight,
      gstApplied,
      partyId,
      supplierPriceLists,
      supplierPriceListsEnabled,
      taxModuleEnabled,
    ]
  );

  const handleBarcodeMatch = useCallback(
    (rawCode: string, allowSingleFuzzy = false): boolean => {
      const q = rawCode.trim().toLowerCase();
      if (!q) return false;

      const exactItem = catalogItems.find(
        (it) =>
          (it.barcode && it.barcode.toLowerCase() === q) ||
          (it.sku && it.sku.toLowerCase() === q)
      );
      if (exactItem) {
        addItemLine(exactItem);
        return true;
      }

      if (allowSingleFuzzy) {
        const matches = catalogItems.filter(
          (it) =>
            it.name.toLowerCase().includes(q) ||
            (it.sku && it.sku.toLowerCase().includes(q)) ||
            (it.barcode && it.barcode.toLowerCase().includes(q))
        );
        if (matches.length === 1) {
          addItemLine(matches[0]);
          return true;
        }
      }

      showToast(
        language === 'hi'
          ? `बारकोड "${rawCode}" कैटलॉग में नहीं मिला।`
          : `Barcode "${rawCode}" not found in active catalog.`,
        'error'
      );
      return false;
    },
    [addItemLine, catalogItems, language, showToast]
  );

  useBarcodeWedge({
    enabled: catalogItems.length > 0 && !aiTextOpen,
    onScan: (code) => {
      const ok = handleBarcodeMatch(code, false);
      playScanBeep(ok);
    },
  });

  const handleScanPurchaseFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !session?.access_token) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast('Invoice scan must be under 5 MB.', 'error');
      return;
    }

    setScanningInvoice(true);
    setErrorMsg(null);
    try {
      const base64 = await fileToBase64(file);

      // Parallel: run AI extraction AND persist attachment to private workspace storage cleanly
      const [scanRes, uploadRes] = await Promise.all([
        erpFetch('/api/erp/ai/scan-purchase-bill', session.access_token, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            base64,
            mimeType: file.type || 'image/jpeg',
          }),
        }),
        erpFetch('/api/erp/files/upload', session.access_token, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || 'image/jpeg',
            base64,
            purpose: 'attachment',
            entityType: 'purchase',
          }),
        }),
      ]);

      const scanJson = await scanRes.json();
      if (!scanRes.ok) {
        throw new Error(scanJson?.error || 'Could not extract data from invoice.');
      }

      if (uploadRes.ok) {
        const upJson = await uploadRes.json();
        if (upJson?.file?.id) {
          setAttachment({
            fileId: upJson.file.id,
            fileName: upJson.file.file_name,
            mimeType: upJson.file.mime_type,
            sizeBytes: upJson.file.size_bytes ?? file.size,
            signedUrl: upJson.signedUrl,
          });
        }
      }

      const ext = scanJson.extracted as {
        supplier_name?: string | null;
        supplier_gstin?: string | null;
        supplier_invoice_no?: string | null;
        supplier_invoice_date?: string | null;
        due_date?: string | null;
        place_of_supply_state_code?: string | null;
        tax_mode?: 'exclusive' | 'inclusive';
        freight_charges?: number;
        notes?: string | null;
        matched_supplier_id?: string | null;
        lines?: Array<{
          raw_name: string;
          matched_item_id: string | null;
          match_confidence: number;
          hsn_code: string | null;
          qty: number;
          unit_code: string | null;
          unit_cost: number;
          discount_pct: number;
          gst_rate: number;
          tax_inclusive: boolean;
          mrp: number | null;
        }>;
      };

      setScanReview({
        supplier_name: ext.supplier_name || null,
        supplier_gstin: ext.supplier_gstin || null,
        supplier_invoice_no: ext.supplier_invoice_no || null,
        supplier_invoice_date: ext.supplier_invoice_date || null,
        due_date: ext.due_date || null,
        place_of_supply_state_code: ext.place_of_supply_state_code || null,
        tax_mode: ext.tax_mode === 'inclusive' ? 'inclusive' : 'exclusive',
        freight_charges: Number(ext.freight_charges || 0),
        notes: ext.notes || null,
        matched_supplier_id: ext.matched_supplier_id || '',
        lines: (ext.lines || []).map((ln) => ({
          localId: crypto.randomUUID(),
          raw_name: ln.raw_name,
          matched_item_id: ln.matched_item_id || '',
          match_confidence: ln.match_confidence || 0,
          hsn_code: ln.hsn_code || null,
          qty: Number(ln.qty || 1),
          unit_code: ln.unit_code || null,
          unit_cost: Number(ln.unit_cost || 0),
          discount_pct: Number(ln.discount_pct || 0),
          gst_rate: Number(ln.gst_rate || 0),
          tax_inclusive: Boolean(ln.tax_inclusive),
          mrp: ln.mrp != null ? Number(ln.mrp) : null,
        })),
      });

      showToast(
        language === 'hi'
          ? `बिल स्कैन हुआ (${ext.lines?.length ?? 0} आइटम मिले)। समीक्षा करके लागू करें।`
          : `Invoice scanned (${ext.lines?.length ?? 0} line(s) extracted). Review & apply below.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to scan purchase invoice.',
        'error'
      );
    } finally {
      setScanningInvoice(false);
    }
  };

  const applyScannedInvoice = () => {
    if (!scanReview) return;
    if (scanReview.matched_supplier_id) {
      handlePartyChange(scanReview.matched_supplier_id);
    }
    if (scanReview.supplier_invoice_no) {
      setSupplierInvNo(scanReview.supplier_invoice_no);
    }
    if (scanReview.supplier_invoice_date && /^\d{4}-\d{2}-\d{2}$/.test(scanReview.supplier_invoice_date)) {
      setSupplierInvDate(scanReview.supplier_invoice_date);
    }
    if (scanReview.due_date && /^\d{4}-\d{2}-\d{2}$/.test(scanReview.due_date)) {
      setDueDate(scanReview.due_date);
    }
    if (scanReview.place_of_supply_state_code) {
      setPlaceOfSupply(scanReview.place_of_supply_state_code.slice(0, 2).toUpperCase());
    }
    if (scanReview.freight_charges > 0) {
      setFreightCharges(String(roundHalfUp(scanReview.freight_charges, 2)));
    }
    if (scanReview.notes && !notes.trim()) {
      setNotes(scanReview.notes);
    }
    setDefaultCostTaxInclusive(scanReview.tax_mode === 'inclusive');

    let added = 0;
    for (const sl of scanReview.lines) {
      if (!sl.matched_item_id) continue;
      const item = catalogItems.find((c) => c.id === sl.matched_item_id);
      if (!item) continue;
      addItemLine(item, {
        qtyOverride: sl.qty,
        unitCodeOverride: sl.unit_code,
        costOverride: sl.unit_cost,
        discountPctOverride: sl.discount_pct,
        gstRateOverride: sl.gst_rate,
        taxInclusiveOverride: sl.tax_inclusive,
        mrp: sl.mrp,
      });
      added += 1;
    }

    if (added === 0) {
      showToast('Select catalog items for the extracted lines before applying.', 'error');
      return;
    }

    showToast(`Applied ${added} line(s) from scanned invoice.`, 'success');
    setScanReview(null);
  };

  const handleAiParseOrder = async () => {
    if (!session?.access_token || !aiOrderText.trim()) return;
    setAiParsing(true);
    try {
      const res = await erpFetch('/api/erp/ai/parse-order-text', session.access_token, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: aiOrderText.trim(), mode: 'purchase' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Unable to parse purchase text.');
      const parsed = json.parsed as {
        matched_party_id?: string | null;
        notes?: string | null;
        lines?: Array<{
          raw_name: string;
          matched_item_id: string | null;
          qty: number;
          unit_code?: string | null;
          rate_override?: number | null;
          discount_pct?: number | null;
        }>;
      };
      if (parsed.matched_party_id && !partyId) {
        handlePartyChange(parsed.matched_party_id);
      }
      if (parsed.notes && !notes.trim()) setNotes(parsed.notes);

      let added = 0;
      for (const ln of parsed.lines || []) {
        const it = ln.matched_item_id
          ? catalogItems.find((c) => c.id === ln.matched_item_id)
          : undefined;
        if (!it) continue;
        addItemLine(it, {
          qtyOverride: Math.max(0.001, Number(ln.qty || 1)),
          unitCodeOverride: ln.unit_code || null,
          costOverride: ln.rate_override ?? null,
          discountPctOverride: ln.discount_pct ?? 0,
        });
        added += 1;
      }
      if (added > 0) {
        showToast(`Added ${added} item(s) to purchase bill.`, 'success');
        setAiOrderText('');
        setAiTextOpen(false);
      } else {
        showToast('No catalog items matched from the pasted text.', 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to parse purchase text.', 'error');
    } finally {
      setAiParsing(false);
    }
  };

  const handleUnitChange = (localId: string, nextUnitId: string) => {
    setLines((prev) =>
      prev.map((row) => {
        if (row.localId !== localId) return row;
        const nextOpt = row.unitOptions.find((u) => u.unitId === nextUnitId);
        const factor = nextOpt?.factor ?? 1;
        const exclusiveBaseCost = Number(row.item.purchase_price ?? 0) * factor;
        const gst = Number(row.gstRate || 0);
        const nextCost =
          row.taxInclusive && gstApplied && taxModuleEnabled && gst > 0
            ? convertRateTaxMode(exclusiveBaseCost, gst, false, true)
            : roundHalfUp(exclusiveBaseCost, 2);
        return {
          ...row,
          enteredUnitId: nextUnitId,
          unitCost: String(nextCost),
        };
      })
    );
  };

  const applyHeaderTaxMode = (incl: boolean) => {
    setDefaultCostTaxInclusive(incl);
    setLines((prev) =>
      prev.map((row) => ({
        ...row,
        taxInclusive: incl,
      }))
    );
  };

  const toggleLineTaxMode = (localId: string, convertRate: boolean) => {
    setLines((prev) =>
      prev.map((row) => {
        if (row.localId !== localId) return row;
        const nextIncl = !row.taxInclusive;
        const gst = Number(row.gstRate || 0);
        const curCost = Number(row.unitCost || 0);
        const nextCost =
          convertRate && gstApplied && taxModuleEnabled && gst > 0
            ? convertRateTaxMode(curCost, gst, row.taxInclusive, nextIncl)
            : curCost;
        return {
          ...row,
          taxInclusive: nextIncl,
          unitCost: String(nextCost),
        };
      })
    );
  };

  const buildRpcLines = () =>
    lines.map((l) => ({
      item_id: l.item.id,
      variant_id: l.variantId || null,
      shade: l.shade?.trim() || null,
      batch_lot: l.batchLot?.trim() || null,
      entered_qty: Math.max(0, Number(l.enteredQty || 0)),
      entered_unit_id: l.enteredUnitId,
      unit_cost: Math.max(0, roundHalfUp(Number(l.unitCost || 0), 2)),
      discount_pct: Math.min(100, Math.max(0, roundHalfUp(Number(l.discountPct || 0), 2))),
      tax_inclusive: l.taxInclusive,
      gst_rate: Number(l.gstRate || 0),
      mrp: l.mrp ? roundHalfUp(Number(l.mrp), 2) : null,
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
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to save or post purchase.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const selectedSupplier = useMemo(
    () => suppliers.find((s) => s.party_id === partyId) ?? null,
    [suppliers, partyId]
  );

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Top Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-4 border-b border-[var(--border)]">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <IconArrowLeft size={16} stroke={2} />
            <span>{t('purchases.title')}</span>
          </button>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconShoppingBag size={24} stroke={2} className="text-[var(--primary-dark)] shrink-0" />
            <span>
              {editingDraft
                ? language === 'hi'
                  ? 'खरीद ड्राफ्ट संपादित करें'
                  : 'Edit Purchase Draft'
                : t('purchases.newPurchase')}
            </span>
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={submitting || lines.length === 0}
            onClick={() => void handleSubmit('draft')}
            className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <IconDeviceFloppy size={16} stroke={2} />
            <span>{t('purchases.saveDraft')}</span>
          </button>
          <button
            type="button"
            disabled={submitting || lines.length === 0}
            onClick={() => void handleSubmit('posted')}
            className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95 disabled:opacity-50"
          >
            <IconCheck size={16} stroke={2.5} />
            <span>{submitting ? t('common.loading') : t('purchases.postPurchase')}</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs sm:text-sm text-[var(--give)] flex items-start gap-2">
          <IconAlertCircle size={18} stroke={2} className="shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* AI Supplier Invoice Scanner Card */}
      {isModuleEnabled('ai') && (
      <section className="rounded-xl border border-[var(--primary)]/45 bg-[var(--surface)] p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <IconFileText size={20} stroke={2} className="text-[var(--primary-dark)] shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <span>{t('purchases.aiScanTitle')}</span>
                <span className="text-[11px] font-medium text-[var(--primary-dark)]">Gemini Vision</span>
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                {t('purchases.aiScanDesc')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <input
              ref={scanFileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={handleScanPurchaseFile}
              className="hidden"
            />
            <input
              ref={scanCameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleScanPurchaseFile}
              className="hidden"
            />
            <button
              type="button"
              disabled={scanningInvoice}
              onClick={() => scanFileInputRef.current?.click()}
              className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <IconUpload size={15} stroke={2} />
              <span>{scanningInvoice ? t('purchases.aiScanning') : t('purchases.uploadInvoiceScan')}</span>
            </button>
            <button
              type="button"
              disabled={scanningInvoice}
              onClick={() => scanCameraInputRef.current?.click()}
              className="h-10 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <IconCamera size={15} stroke={2} />
              <span>{t('purchases.snapInvoicePhoto')}</span>
            </button>
          </div>
        </div>

        {/* Review Drawer once AI has extracted lines */}
        {scanReview && (
          <div className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <p className="font-semibold text-sm">
                  Extracted Invoice Preview ({scanReview.lines.length} line(s))
                </p>
                <p className="text-[var(--text-muted)]">
                  Detected Supplier: <strong>{scanReview.supplier_name || 'Unknown'}</strong>
                  {scanReview.supplier_gstin ? ` · GSTIN ${scanReview.supplier_gstin}` : ''}
                  {scanReview.supplier_invoice_no ? ` · Inv #${scanReview.supplier_invoice_no}` : ''}
                  {scanReview.supplier_invoice_date ? ` · ${scanReview.supplier_invoice_date}` : ''}
                  {` · Rates ${scanReview.tax_mode === 'inclusive' ? 'Incl. GST' : 'Excl. GST'}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScanReview(null)}
                  className="h-8 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium"
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  onClick={applyScannedInvoice}
                  className="h-8 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1"
                >
                  <IconCheck size={14} stroke={2.5} />
                  <span>{t('purchases.applyScanned')}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                  Map Supplier
                </label>
                <select
                  value={scanReview.matched_supplier_id}
                  onChange={(e) =>
                    setScanReview((prev) =>
                      prev ? { ...prev, matched_supplier_id: e.target.value } : prev
                    )
                  }
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                >
                  <option value="">Cash / Select Supplier later</option>
                  {suppliers.map((s) => (
                    <option key={s.party_id} value={s.party_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                  Invoice Rate Mode
                </label>
                <div className="flex items-center gap-1.5">
                  {(['exclusive', 'inclusive'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() =>
                        setScanReview((prev) =>
                          prev
                            ? {
                                ...prev,
                                tax_mode: mode,
                                lines: prev.lines.map((ln) => ({
                                  ...ln,
                                  tax_inclusive: mode === 'inclusive',
                                })),
                              }
                            : prev
                        )
                      }
                      className={`h-9 px-3 rounded-lg border text-xs font-medium ${
                        scanReview.tax_mode === mode
                          ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                      }`}
                    >
                      {mode === 'exclusive' ? 'Exclusive (+ GST)' : 'Inclusive (MRP/Final)'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] text-[var(--text-muted)]">
                    <th className="py-2 px-2.5">Invoice Text</th>
                    <th className="py-2 px-2.5">Map to Catalog Item</th>
                    <th className="py-2 px-2 text-right">Qty</th>
                    <th className="py-2 px-2 text-right">Cost</th>
                    <th className="py-2 px-2 text-right">GST %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {scanReview.lines.map((sl) => (
                    <tr key={sl.localId}>
                      <td className="py-2 px-2.5">
                        <div className="font-medium">{sl.raw_name}</div>
                        <div className="text-[10px] text-[var(--text-muted)]">
                          {sl.hsn_code ? `HSN ${sl.hsn_code}` : ''}
                          {sl.unit_code ? ` · ${sl.unit_code}` : ''}
                        </div>
                      </td>
                      <td className="py-2 px-2.5 min-w-[200px]">
                        <select
                          value={sl.matched_item_id}
                          onChange={(e) =>
                            setScanReview((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    lines: prev.lines.map((x) =>
                                      x.localId === sl.localId
                                        ? { ...x, matched_item_id: e.target.value }
                                        : x
                                    ),
                                  }
                                : prev
                            )
                          }
                          className={`w-full h-8 px-2 rounded border text-xs ${
                            sl.matched_item_id
                              ? 'border-[var(--border)] bg-[var(--surface)]'
                              : 'border-amber-500/60 bg-amber-500/10'
                          }`}
                        >
                          <option value="">— Skip / Pick Catalog Item —</option>
                          {catalogItems.map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.name} ({it.base_unit_code})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums">{sl.qty}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{formatINR(sl.unit_cost)}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{sl.gst_rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      )}

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-8 space-y-5">
          {/* Supplier & Invoice Header */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-4">
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

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('purchases.supplierInvNo')}
                </label>
                <input
                  type="text"
                  value={supplierInvNo}
                  onChange={(e) => setSupplierInvNo(e.target.value)}
                  placeholder="SUP-409"
                  className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('purchases.supplierInvDate')}
                </label>
                <input
                  type="date"
                  value={supplierInvDate}
                  onChange={(e) => setSupplierInvDate(e.target.value)}
                  className="w-full h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm tabular-nums"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('purchases.billDate')}
                </label>
                <input
                  type="date"
                  value={billDate}
                  onChange={(e) => setBillDate(e.target.value)}
                  className="w-full h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm tabular-nums"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('purchases.dueDate')}
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={!partyId}
                  className="w-full h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm tabular-nums disabled:opacity-50"
                />
              </div>
            </div>

            {/* Tax & Cost Mode Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--border)] text-xs">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-2 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={gstApplied}
                    disabled={!taxModuleEnabled}
                    onChange={(e) => setGstApplied(e.target.checked)}
                    className="w-4 h-4 accent-[var(--primary-dark)]"
                  />
                  <span>{t('purchases.applyGst')}</span>
                </label>

                {gstApplied && taxModuleEnabled && (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[var(--text-muted)]">State:</span>
                      <input
                        type="text"
                        maxLength={2}
                        value={placeOfSupply}
                        onChange={(e) => setPlaceOfSupply(e.target.value.toUpperCase())}
                        placeholder="MH"
                        className="w-14 h-8 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-xs uppercase text-center font-mono"
                      />
                      <span className="font-medium text-[var(--primary-dark)]">
                        {isInterstate ? t('bills.interstate') : t('bills.intrastate')}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      <span className="text-[var(--text-muted)]">{t('purchases.rateTaxBasis')}:</span>
                      <button
                        type="button"
                        onClick={() => applyHeaderTaxMode(false)}
                        className={`px-2 py-1 rounded border font-medium ${
                          !defaultCostTaxInclusive
                            ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                            : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                        }`}
                      >
                        Excl. (+GST)
                      </button>
                      <button
                        type="button"
                        onClick={() => applyHeaderTaxMode(true)}
                        className={`px-2 py-1 rounded border font-medium ${
                          defaultCostTaxInclusive
                            ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                            : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                        }`}
                      >
                        Incl. GST
                      </button>
                    </div>
                  </>
                )}
              </div>

              <label className="inline-flex items-center gap-2 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={updateItemCost}
                  onChange={(e) => setUpdateItemCost(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>{t('purchases.updateItemCost')}</span>
              </label>
            </div>
          </section>

          {/* Fast Scan, Search & AI Text Add */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {t('bills.fastAddTitle')}
              </span>
              {isModuleEnabled('ai') && (
                <button
                  type="button"
                  onClick={() => setAiTextOpen((v) => !v)}
                  className={`h-8 px-2.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 ${
                    aiTextOpen
                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  <IconSparkles size={14} stroke={2} className="text-[var(--primary-dark)]" />
                  <span>{t('bills.aiSmartOrder')}</span>
                </button>
              )}
            </div>

            {isModuleEnabled('ai') && aiTextOpen && (
              <div className="p-3 rounded-lg border border-[var(--primary)]/40 bg-[var(--surface-muted)] space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  Paste supplier quote / WhatsApp list (e.g., &quot;Gupta Traders 10 box oil @ 1120, 50 kg atta @ 32&quot;):
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={aiOrderText}
                    onChange={(e) => setAiOrderText(e.target.value)}
                    placeholder="Supplier + items..."
                    className="flex-1 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                  <button
                    type="button"
                    disabled={aiParsing || !aiOrderText.trim()}
                    onClick={() => void handleAiParseOrder()}
                    className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <IconSparkles size={14} stroke={2} />
                    <span>{aiParsing ? 'Parsing...' : 'Add Lines'}</span>
                  </button>
                </div>
              </div>
            )}

            <BarcodeScanBar
              searchQuery={itemSearch}
              onSearchChange={setItemSearch}
              onScanSubmit={(code) => handleBarcodeMatch(code, true)}
              placeholder={t('bills.addItemLine')}
              scanButtonLabel={t('bills.scanCamera')}
              scannerTitle={t('bills.scanCameraTitle')}
              continuousCameraDefault
            />

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
                    <IconPlus size={13} stroke={2.5} className="text-[var(--primary-dark)]" />
                    <span className="font-medium">{it.name}</span>
                    <span className="text-[var(--text-muted)] tabular-nums">
                      ({formatINR(it.purchase_price ?? 0)})
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Line Items Table */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface-muted)]/60">
              <h2 className="text-sm font-semibold">
                {t('bills.lineItemsTitle')} ({lines.length})
              </h2>
              {gstApplied && taxModuleEnabled && (
                <span className="text-[11px] text-[var(--text-muted)]">
                  Saved cost is auto-normalized to Tax Exclusive for inventory valuation
                </span>
              )}
            </div>

            {lines.length === 0 ? (
              <div className="p-10 text-center text-xs sm:text-sm text-[var(--text-muted)]">
                {language === 'hi'
                  ? 'सप्लायर बिल स्कैन करें, बारकोड स्कैन करें या ऊपर से सामान चुनें।'
                  : 'Scan a supplier invoice above, scan an item barcode, or click an item chip to begin.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm border-collapse min-w-[760px]">
                  <thead>
                    <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)] text-[11px] uppercase">
                      <th className="text-left px-3 py-2 font-medium">#</th>
                      <th className="text-left px-3 py-2 font-medium">Item</th>
                      <th className="text-center px-2 py-2 font-medium">{t('bills.qty')}</th>
                      <th className="text-left px-2 py-2 font-medium w-24">{t('bills.unit')}</th>
                      <th className="text-right px-2 py-2 font-medium w-36">Cost (₹)</th>
                      <th className="text-right px-2 py-2 font-medium w-16">{t('bills.discPct')}</th>
                      {gstApplied && taxModuleEnabled && (
                        <th className="text-right px-2 py-2 font-medium w-24">GST %</th>
                      )}
                      <th className="text-right px-3 py-2 font-medium w-28">{t('bills.amount')}</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((row, idx) => {
                      const lineCalc = calc.lines[idx];
                      const currentQty = Number(row.enteredQty || 0);
                      const isHighlighted = lastHighlightedId === row.localId;
                      return (
                        <tr
                          key={row.localId}
                          className={`border-b border-[var(--border)] last:border-b-0 ${
                            isHighlighted ? 'bg-[var(--primary-soft)]/50' : ''
                          }`}
                        >
                          <td className="px-3 py-2.5 text-[var(--text-muted)] tabular-nums align-top">
                            {idx + 1}
                          </td>
                          <td className="px-3 py-2.5 min-w-[220px] align-top space-y-1.5">
                            <div>
                              <div className="font-medium">{row.item.name}</div>
                              <div className="text-[11px] text-[var(--text-muted)]">
                                Stock: {row.item.qty_on_hand} {row.item.base_unit_code}
                                {row.item.hsn_code ? ` · HSN ${row.item.hsn_code}` : ''}
                              </div>
                              {row.supplierPriceHint && (
                                <div className="text-[10px] text-[var(--primary-dark)]">
                                  {row.supplierPriceHint}
                                </div>
                              )}
                            </div>
                            {((variantsByItem[row.item.id] ?? []).length > 0 ||
                              row.item.product_line === 'tiles_slabs') && (
                              <div className="space-y-1">
                                {(variantsByItem[row.item.id] ?? []).length > 0 && (
                                  <select
                                    value={row.variantId || ''}
                                    onChange={(e) => {
                                      const vId = e.target.value || undefined;
                                      const picked = (variantsByItem[row.item.id] ?? []).find(
                                        (v) => v.id === vId
                                      );
                                      setLines((prev) =>
                                        prev.map((x) => {
                                          if (x.localId !== row.localId) return x;
                                          const opt = x.unitOptions.find(
                                            (u) => u.unitId === x.enteredUnitId
                                          );
                                          const factor = opt?.factor ?? 1;
                                          const nextCost =
                                            picked?.purchase_price != null
                                              ? roundHalfUp(Number(picked.purchase_price) * factor, 2)
                                              : Number(x.unitCost || 0);
                                          return {
                                            ...x,
                                            variantId: vId,
                                            shade: picked?.shade || x.shade,
                                            batchLot: picked?.batch_lot || x.batchLot,
                                            unitCost: String(nextCost),
                                          };
                                        })
                                      );
                                    }}
                                    className="w-full h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px]"
                                  >
                                    <option value="">Standard / Base Item</option>
                                    {(variantsByItem[row.item.id] ?? []).map((v) => (
                                      <option key={v.id} value={v.id}>
                                        {v.variant_name}
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <div className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    value={row.shade || ''}
                                    onChange={(e) =>
                                      setLines((prev) =>
                                        prev.map((x) =>
                                          x.localId === row.localId
                                            ? { ...x, shade: e.target.value }
                                            : x
                                        )
                                      )
                                    }
                                    placeholder="Shade"
                                    className="w-1/2 h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px]"
                                  />
                                  <input
                                    type="text"
                                    value={row.batchLot || ''}
                                    onChange={(e) =>
                                      setLines((prev) =>
                                        prev.map((x) =>
                                          x.localId === row.localId
                                            ? { ...x, batchLot: e.target.value }
                                            : x
                                        )
                                      )
                                    }
                                    placeholder="Batch / Lot"
                                    className="w-1/2 h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] font-mono"
                                  />
                                </div>
                              </div>
                            )}
                          </td>

                          <td className="px-2 py-2.5 align-top">
                            <div className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                              <button
                                type="button"
                                aria-label="Decrease quantity"
                                onClick={() => {
                                  const next = Math.max(1, roundHalfUp(currentQty - 1, 3));
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId ? { ...x, enteredQty: String(next) } : x
                                    )
                                  );
                                }}
                                className="w-7 h-9 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                              >
                                <IconMinus size={12} stroke={2.5} />
                              </button>
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
                                className="w-14 h-9 px-1 bg-transparent text-center text-xs font-semibold tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-dark)]"
                              />
                              <button
                                type="button"
                                aria-label="Increase quantity"
                                onClick={() => {
                                  const next = roundHalfUp(currentQty + 1, 3);
                                  setLines((prev) =>
                                    prev.map((x) =>
                                      x.localId === row.localId ? { ...x, enteredQty: String(next) } : x
                                    )
                                  );
                                }}
                                className="w-7 h-9 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                              >
                                <IconPlus size={12} stroke={2.5} />
                              </button>
                            </div>
                          </td>

                          <td className="px-2 py-2.5 align-top">
                            <select
                              value={row.enteredUnitId}
                              onChange={(e) => handleUnitChange(row.localId, e.target.value)}
                              className="w-full h-9 px-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                            >
                              {row.unitOptions.map((u) => (
                                <option key={u.unitId} value={u.unitId}>
                                  {u.code}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td className="px-2 py-2.5 align-top space-y-1">
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
                              className="w-28 h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums text-xs font-medium"
                            />
                            {gstApplied && taxModuleEnabled && (
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => toggleLineTaxMode(row.localId, false)}
                                  className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                                    row.taxInclusive
                                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                                  }`}
                                >
                                  {row.taxInclusive ? t('bills.taxInclBadge') : t('bills.taxExclBadge')}
                                </button>
                                {Number(row.gstRate || 0) > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => toggleLineTaxMode(row.localId, true)}
                                    title="Switch tax mode & convert rate cleanly"
                                    className="p-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--primary-dark)]"
                                  >
                                    <IconArrowsExchange size={12} stroke={2} />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>

                          <td className="px-2 py-2.5 align-top">
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
                              className="w-16 h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums text-xs"
                            />
                          </td>

                          {gstApplied && taxModuleEnabled && (
                            <td className="px-2 py-2.5 align-top space-y-1">
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
                                className="w-20 h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-right tabular-nums text-xs"
                              />
                              <div className="text-[10px] text-right text-[var(--text-muted)] tabular-nums">
                                Base {formatINR(lineCalc?.taxableAmount ?? 0)}
                              </div>
                            </td>
                          )}

                          <td className="px-3 py-2.5 text-right font-semibold tabular-nums align-top">
                            <div>{formatINR(lineCalc?.lineTotal ?? 0)}</div>
                            {gstApplied && taxModuleEnabled && (
                              <div className="text-[10px] font-normal text-[var(--text-muted)]">
                                +{formatINR(lineCalc?.taxAmount ?? 0)} ITC
                              </div>
                            )}
                          </td>

                          <td className="px-2 py-2.5 text-center align-top">
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
          </section>

          {/* Attachment & Notes */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
            <FileUpload
              label={t('purchases.attachment')}
              value={attachment}
              onChange={setAttachment}
              helperText="Attached supplier invoice PDF/image (auto-populated if scanned above)."
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
          </section>
        </div>

        {/* Right Sticky Summary & Payment Rail */}
        <aside className="lg:col-span-4 lg:sticky lg:top-6 space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <div>
                <p className="text-xs text-[var(--text-muted)]">Purchase Summary</p>
                <p className="text-sm font-semibold truncate max-w-[220px]">
                  {selectedSupplier ? selectedSupplier.name : t('purchases.cashSupplier')}
                </p>
              </div>
              {gstApplied && taxModuleEnabled && (
                <span className="text-[11px] font-semibold text-[var(--primary-dark)]">
                  {calc.isInterstate ? 'IGST ITC' : 'CGST+SGST ITC'}
                </span>
              )}
            </div>

            <div className="space-y-2 text-xs sm:text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">{t('bills.taxableSubtotal')}</span>
                <span className="tabular-nums font-medium">{formatINR(calc.subtotalTaxable)}</span>
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
                    className="w-3.5 h-3.5 accent-[var(--primary-dark)]"
                  />
                  <span>{t('bills.roundOff')}</span>
                </label>
                <span className="tabular-nums">{calc.roundOff.toFixed(2)}</span>
              </div>
            </div>

            <div className="pt-2.5 border-t border-[var(--border)] flex items-baseline justify-between text-lg font-bold">
              <span>{t('bills.grandTotal')}</span>
              <span className="tabular-nums">{formatINR(calc.grandTotal)}</span>
            </div>

            {/* Settlement */}
            <div className="pt-3 border-t border-[var(--border)] space-y-2.5">
              {!partyId ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Cash supplier purchases settle in full ({formatINR(calc.grandTotal)}).
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
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-right tabular-nums font-semibold"
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

            <div className="pt-2 space-y-2">
              <button
                type="button"
                disabled={submitting || lines.length === 0}
                onClick={() => void handleSubmit('posted')}
                className="w-full h-11 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center justify-center gap-2 hover:opacity-95 disabled:opacity-50"
              >
                <IconCheck size={17} stroke={2.5} />
                <span>
                  {submitting
                    ? t('common.loading')
                    : `${t('purchases.postPurchase')} (${formatINR(calc.grandTotal)})`}
                </span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={submitting || lines.length === 0}
                  onClick={() => void handleSubmit('draft')}
                  className="h-10 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center justify-center gap-1.5 hover:bg-[var(--surface-muted)] disabled:opacity-50"
                >
                  <IconDeviceFloppy size={15} stroke={2} />
                  <span>{t('purchases.saveDraft')}</span>
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  className="h-10 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
