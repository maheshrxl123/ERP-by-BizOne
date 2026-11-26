import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowsExchange,
  IconCheck,
  IconDeviceFloppy,
  IconMinus,
  IconPlus,
  IconReceipt,
  IconSparkles,
  IconTrash,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { BarcodeScanBar } from '../../components/barcode/BarcodeScanBar';
import { playScanBeep, useBarcodeWedge } from '../../components/barcode/useBarcodeWedge';
import { erpFetch } from '../../core/erpFetch';
import { addDaysLocalIso, formatINR, todayLocalIso } from '../../core/format';
import { detectMixedLotsOnBill } from '../../core/lotTracking';
import {
  amountInWordsINR,
  calculateBillPreview,
  convertRateTaxMode,
  roundHalfUp,
  type BillDocumentType,
} from '../../core/money';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  BillLineRecord,
  BillRecord,
  ContractorRateCardRecord,
  ItemCatalogRecord,
  ItemLotBalanceRecord,
  ItemUnitRecord,
  ItemVariantRecord,
  PartyBalanceRecord,
  PartySiteRecord,
  PaymentMode,
  UnitConversionRecord,
} from '../../types/decorbiz';

export interface NewBillScreenProps {
  editingDraft?: BillRecord | null;
  defaultDocType?: 'tax_invoice' | 'bill_of_supply' | 'quotation';
  defaultPartyId?: string | null;
  onCancel: () => void;
  onSaved: (bill: BillRecord, mode: 'draft' | 'issued') => void;
}

interface DraftLineRow {
  localId: string;
  item: ItemCatalogRecord;
  variantId?: string;
  shade?: string;
  batchLot?: string;
  contractorRateApplied?: boolean;
  enteredQty: string;
  enteredUnitId: string;
  unitOptions: Array<{ unitId: string; code: string; factor: number }>;
  unitPrice: string;
  discountPct: string;
  taxInclusive: boolean;
}

const PAYMENT_MODES: PaymentMode[] = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
];

export function NewBillScreen({
  editingDraft,
  defaultDocType,
  defaultPartyId,
  onCancel,
  onSaved,
}: NewBillScreenProps) {
  const { business, profile, session, isModuleEnabled, language, showToast, t } = useApp();

  const taxModuleEnabled = isModuleEnabled('tax');
  const partiesEnabled = isModuleEnabled('parties');
  const paymentsEnabled = isModuleEnabled('payments');
  const rateCardsEnabled = isModuleEnabled('contractor_rate_cards');
  const commissionsEnabled = isModuleEnabled('commissions');
  const gstActiveForBiz = Boolean(business?.gst_registered) && taxModuleEnabled;

  const [docType, setDocType] = useState<'tax_invoice' | 'bill_of_supply' | 'quotation'>(
    'tax_invoice'
  );
  const [partyId, setPartyId] = useState<string>('');
  const [siteId, setSiteId] = useState<string>('');
  const [billDate, setBillDate] = useState(todayLocalIso());
  const [dueDate, setDueDate] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [extraCharges, setExtraCharges] = useState('0');
  const [autoRoundOff, setAutoRoundOff] = useState(true);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');

  const [lines, setLines] = useState<DraftLineRow[]>([]);
  const [lastHighlightedId, setLastHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  const [paidAmount, setPaidAmount] = useState('');
  const [paidTouched, setPaidTouched] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [paymentReference, setPaymentReference] = useState('');

  const [commissionPartnerId, setCommissionPartnerId] = useState('');
  const [commissionPartnerName, setCommissionPartnerName] = useState('');
  const [commissionPct, setCommissionPct] = useState('');

  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [partySites, setPartySites] = useState<PartySiteRecord[]>([]);
  const [catalogItems, setCatalogItems] = useState<ItemCatalogRecord[]>([]);
  const [variantsByItem, setVariantsByItem] = useState<Record<string, ItemVariantRecord[]>>({});
  const [lotBalancesByItem, setLotBalancesByItem] = useState<
    Record<string, ItemLotBalanceRecord[]>
  >({});
  const [contractorRates, setContractorRates] = useState<ContractorRateCardRecord[]>([]);
  const [conversionsByItem, setConversionsByItem] = useState<
    Record<string, Array<{ unitId: string; code: string; factor: number }>>
  >({});
  const [partyAddressesById, setPartyAddressesById] = useState<Record<string, string>>({});

  const [itemSearch, setItemSearch] = useState('');
  const [aiOrderOpen, setAiOrderOpen] = useState(false);
  const [aiOrderText, setAiOrderText] = useState('');
  const [aiParsing, setAiParsing] = useState(false);
  const [loadingMaster, setLoadingMaster] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const canOverrideUnrestricted = hasCapability(profile?.role, 'override_price_discount');
  const cashierMaxDiscount = Number(business?.cashier_max_discount_pct ?? 10);
  const allowCashierPriceReduction = Boolean(business?.allow_cashier_price_override);

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

  const loadPartyPackDetails = useCallback(
    async (pid: string) => {
      if (!pid || !partiesEnabled) {
        setPartySites([]);
        return;
      }
      const sitesRes = await supabase
        .from('party_sites')
        .select('*')
        .eq('party_id', pid)
        .eq('is_active', true)
        .order('site_name');
      if (!sitesRes.error) {
        setPartySites((sitesRes.data as PartySiteRecord[] | null) ?? []);
      }
    },
    [partiesEnabled]
  );

  const loadMasterData = useCallback(async () => {
    setLoadingMaster(true);
    try {
      const [itemsRes, convRes, unitsRes, varRes, lotRes, rateCardRes, partyRes, addrRes] = await Promise.all([
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
        supabase.from('item_lot_balances').select('*').limit(800),
        rateCardsEnabled
          ? supabase.from('contractor_rate_cards').select('*').eq('is_active', true)
          : Promise.resolve({ data: [], error: null }),
        partiesEnabled
          ? supabase
              .from('party_balances')
              .select('*')
              .eq('is_active', true)
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
      if (rateCardRes.error) throw rateCardRes.error;
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

      const lotMap: Record<string, ItemLotBalanceRecord[]> = {};
      for (const lb of (lotRes.data as ItemLotBalanceRecord[] | null) ?? []) {
        if (!lotMap[lb.item_id]) lotMap[lb.item_id] = [];
        lotMap[lb.item_id].push(lb);
      }

      const itemsList = (itemsRes.data as ItemCatalogRecord[] | null) ?? [];
      const convMap: Record<
        string,
        Array<{ unitId: string; code: string; factor: number }>
      > = {};
      for (const it of itemsList) {
        convMap[it.id] = [
          {
            unitId: it.base_unit_id,
            code: it.base_unit_code,
            factor: 1,
          },
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
      setLotBalancesByItem(lotMap);
      setContractorRates((rateCardRes.data as ContractorRateCardRecord[] | null) ?? []);
      setParties((partyRes.data as PartyBalanceRecord[] | null) ?? []);
      setPartyAddressesById(addrStateMap);
      return {
        itemsList,
        convMap,
        unitCodeById,
        partyList: (partyRes.data as PartyBalanceRecord[] | null) ?? [],
        addrStateMap,
      };
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to load items and parties.'
      );
      return null;
    } finally {
      setLoadingMaster(false);
    }
  }, [partiesEnabled, rateCardsEnabled]);

  useEffect(() => {
    setErrorMsg(null);
    setItemSearch('');
    setPaymentMode('cash');
    setPaymentReference('');
    setIdempotencyKey(`bill_${crypto.randomUUID()}`);

    const init = async () => {
      const master = await loadMasterData();
      if (!master) return;

      if (editingDraft) {
        const draftType =
          editingDraft.doc_type === 'credit_note'
            ? 'tax_invoice'
            : editingDraft.doc_type;
        setDocType(draftType);
        setPartyId(editingDraft.party_id || '');
        setSiteId(editingDraft.site_id || '');
        if (editingDraft.party_id) {
          void loadPartyPackDetails(editingDraft.party_id);
        }
        setBillDate(editingDraft.bill_date || todayLocalIso());
        setDueDate(editingDraft.due_date || '');
        setValidUntil(editingDraft.valid_until || '');
        setPlaceOfSupply(
          editingDraft.place_of_supply_state_code || business?.state_code || ''
        );
        setExtraCharges(String(editingDraft.extra_charges ?? 0));
        setAutoRoundOff(editingDraft.auto_round_off ?? true);
        setNotes(editingDraft.notes || '');
        setTerms(editingDraft.terms ?? business?.invoice_terms ?? '');
        setPaidTouched(false);
        setPaidAmount('');

        const { data: draftLines, error: dlErr } = await supabase
          .from('bill_lines')
          .select('*')
          .eq('bill_id', editingDraft.id)
          .order('line_no', { ascending: true });
        if (dlErr) {
          setErrorMsg(dlErr.message);
          return;
        }

        const dlRows = (draftLines as BillLineRecord[] | null) ?? [];
        const itemsById = new Map<string, ItemCatalogRecord>(
          master.itemsList.map((x) => [x.id, x])
        );
        const convByItem = { ...master.convMap };

        const missingIds = Array.from(
          new Set(
            dlRows
              .map((dl) => dl.item_id)
              .filter((id): id is string => Boolean(id) && !itemsById.has(id))
          )
        );
        if (missingIds.length > 0) {
          const { data: extraItems, error: extraErr } = await supabase
            .from('item_catalog_view')
            .select('*')
            .in('id', missingIds);
          if (extraErr) {
            setErrorMsg(extraErr.message);
            return;
          }
          for (const it of (extraItems as ItemCatalogRecord[] | null) ?? []) {
            itemsById.set(it.id, it);
            convByItem[it.id] = [
              { unitId: it.base_unit_id, code: it.base_unit_code, factor: 1 },
            ];
          }
          const { data: extraConvs } = await supabase
            .from('unit_conversions')
            .select('item_id, alternate_unit_id, conversion_factor')
            .in('item_id', missingIds);
          for (const c of (extraConvs as UnitConversionRecord[] | null) ?? []) {
            if (!c.item_id || !convByItem[c.item_id]) continue;
            const code = master.unitCodeById[c.alternate_unit_id];
            if (!code) continue;
            if (!convByItem[c.item_id].some((x) => x.unitId === c.alternate_unit_id)) {
              convByItem[c.item_id].push({
                unitId: c.alternate_unit_id,
                code,
                factor: Number(c.conversion_factor),
              });
            }
          }
        }

        const mapped: DraftLineRow[] = [];
        for (const dl of dlRows) {
          const fallbackItem: ItemCatalogRecord = {
            id: dl.item_id || dl.id,
            name: dl.item_name,
            sku: dl.sku,
            barcode: null,
            category_id: null,
            category_name: null,
            brand_id: null,
            brand_name: null,
            base_unit_id: dl.entered_unit_id,
            base_unit_code: dl.entered_unit_code,
            base_unit_name_en: dl.entered_unit_code,
            base_unit_name_hi: dl.entered_unit_code,
            base_unit_allow_decimal: true,
            selling_price: Number(dl.catalog_unit_price ?? dl.unit_price),
            mrp: null,
            purchase_price: null,
            gst_rate: Number(dl.gst_rate ?? 0),
            hsn_code: dl.hsn_code,
            tax_inclusive: Boolean(dl.tax_inclusive),
            low_stock_alert: 0,
            allow_negative_stock: true,
            primary_image_file_id: null,
            pack_metadata: {},
            notes: null,
            is_active: false,
            is_demo: false,
            version: 1,
            created_at: editingDraft.created_at,
            updated_at: editingDraft.updated_at,
            qty_on_hand: 0,
            last_movement_at: null,
            is_out_of_stock: false,
            is_low_stock: false,
            stock_value: null,
            image_count: 0,
            conversions_count: 0,
          };
          const item = (dl.item_id && itemsById.get(dl.item_id)) || fallbackItem;
          const baseOptions = convByItem[item.id] ?? [
            { unitId: item.base_unit_id, code: item.base_unit_code, factor: 1 },
          ];
          const unitOptions = baseOptions.some((u) => u.unitId === dl.entered_unit_id)
            ? baseOptions
            : [
                ...baseOptions,
                {
                  unitId: dl.entered_unit_id,
                  code: dl.entered_unit_code,
                  factor: Number(dl.conversion_factor || 1),
                },
              ];
          mapped.push({
            localId: dl.id,
            item,
            variantId: dl.variant_id || undefined,
            shade: dl.shade || undefined,
            batchLot: dl.batch_lot || undefined,
            enteredQty: String(dl.entered_qty),
            enteredUnitId: dl.entered_unit_id,
            unitOptions,
            unitPrice: String(dl.unit_price),
            discountPct: String(dl.discount_pct),
            taxInclusive: Boolean(dl.tax_inclusive),
          });
        }
        setLines(mapped);
      } else {
        const initType =
          defaultDocType ?? (gstActiveForBiz ? 'tax_invoice' : 'bill_of_supply');
        setDocType(initType);
        const initPartyId = defaultPartyId || '';
        setPartyId(initPartyId);
        setSiteId('');
        if (initPartyId) {
          void loadPartyPackDetails(initPartyId);
        } else {
          setPartySites([]);
        }
        setBillDate(todayLocalIso());
        setDueDate('');
        setValidUntil('');

        const selectedP = master.partyList.find((p) => p.party_id === initPartyId);
        const derivedPos =
          (initPartyId && master.addrStateMap[initPartyId]) ||
          (selectedP?.gstin ? selectedP.gstin.slice(0, 2).toUpperCase() : '') ||
          (business?.state_code || '');
        setPlaceOfSupply(derivedPos);

        setExtraCharges('0');
        setAutoRoundOff(true);
        setNotes('');
        setTerms(business?.invoice_terms || '');
        setLines([]);
        setPaidTouched(false);
        setPaidAmount('');
      }
    };

    void init();
  }, [
    editingDraft,
    defaultDocType,
    defaultPartyId,
    gstActiveForBiz,
    business?.state_code,
    business?.invoice_terms,
    loadMasterData,
    loadPartyPackDetails,
  ]);

  const handlePartyChange = (nextPartyId: string) => {
    setPartyId(nextPartyId);
    setSiteId('');
    void loadPartyPackDetails(nextPartyId);
    if (!nextPartyId) {
      setPlaceOfSupply((business?.state_code || '').toUpperCase());
      setDueDate('');
      setPaidTouched(false);
      return;
    }
    const found = parties.find((p) => p.party_id === nextPartyId);
    const nextPos =
      partyAddressesById[nextPartyId] ||
      (found?.gstin ? found.gstin.slice(0, 2).toUpperCase() : '') ||
      (business?.state_code || '').toUpperCase();
    setPlaceOfSupply(nextPos);
    if (found && found.credit_days > 0) {
      setDueDate(addDaysLocalIso(billDate || todayLocalIso(), found.credit_days));
    }
  };

  const selectedPartyObj = useMemo(
    () => parties.find((p) => p.party_id === partyId) ?? null,
    [parties, partyId]
  );

  const findContractorRate = useCallback(
    (itemId: string, variantId: string | undefined, qty: number): ContractorRateCardRecord | null => {
      if (!rateCardsEnabled || !partyId) return null;
      const activeDay = billDate || todayLocalIso();
      const matches = contractorRates.filter(
        (r) =>
          r.party_id === partyId &&
          r.item_id === itemId &&
          r.is_active &&
          (!r.valid_until || r.valid_until >= activeDay) &&
          qty >= Number(r.min_qty || 0)
      );
      return (
        matches.find((r) => variantId && r.variant_id === variantId) ||
        matches.find((r) => !r.variant_id) ||
        null
      );
    },
    [billDate, contractorRates, partyId, rateCardsEnabled]
  );

  const addItemToBill = useCallback(
    (
      item: ItemCatalogRecord,
      opts?: {
        qtyOverride?: number;
        unitCodeOverride?: string | null;
        rateOverride?: number | null;
        discountPctOverride?: number | null;
      }
    ) => {
      const targetUnitOpt = opts?.unitCodeOverride
        ? (conversionsByItem[item.id] ?? []).find(
            (u) => u.code.toLowerCase() === opts.unitCodeOverride!.toLowerCase()
          )
        : undefined;
      const targetUnitId = targetUnitOpt?.unitId || item.base_unit_id;
      const targetFactor = targetUnitOpt?.factor ?? 1;
      const addQty = opts?.qtyOverride && opts.qtyOverride > 0 ? opts.qtyOverride : 1;

      const matchedRate = opts?.rateOverride == null ? findContractorRate(item.id, undefined, addQty) : null;

      let touchedLineId = '';

      setLines((prev) => {
        const matchIdx = prev.findIndex(
          (l) => l.item.id === item.id && l.enteredUnitId === targetUnitId && !l.variantId
        );
        if (matchIdx >= 0 && opts?.rateOverride == null) {
          touchedLineId = prev[matchIdx].localId;
          return prev.map((row, idx) => {
            if (idx !== matchIdx) return row;
            const nextQty = roundHalfUp(Number(row.enteredQty || 0) + addQty, 3);
            return {
              ...row,
              enteredQty: String(nextQty),
            };
          });
        }

        const unitOptions = conversionsByItem[item.id] ?? [
          { unitId: item.base_unit_id, code: item.base_unit_code, factor: 1 },
        ];
        const baseSelling = matchedRate ? Number(matchedRate.agreed_rate) : Number(item.selling_price);
        const initialPrice =
          opts?.rateOverride != null
            ? roundHalfUp(Number(opts.rateOverride), 2)
            : roundHalfUp(baseSelling * targetFactor, 2);
        const initialDisc =
          opts?.discountPctOverride != null
            ? opts.discountPctOverride
            : matchedRate
              ? Number(matchedRate.discount_pct || 0)
              : 0;
        const newId = crypto.randomUUID();
        touchedLineId = newId;
        return [
          ...prev,
          {
            localId: newId,
            item,
            contractorRateApplied: Boolean(matchedRate),
            enteredQty: String(addQty),
            enteredUnitId: targetUnitId,
            unitOptions,
            unitPrice: String(initialPrice),
            discountPct: String(initialDisc),
            taxInclusive: Boolean(item.tax_inclusive),
          },
        ];
      });

      if (touchedLineId) flashHighlight(touchedLineId);
      setItemSearch('');
    },
    [conversionsByItem, findContractorRate, flashHighlight]
  );

  const filteredCatalog = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return catalogItems.slice(0, 10);
    return catalogItems
      .filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          (it.sku && it.sku.toLowerCase().includes(q)) ||
          (it.barcode && it.barcode.toLowerCase().includes(q))
      )
      .slice(0, 12);
  }, [catalogItems, itemSearch]);

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
        addItemToBill(exactItem);
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
          addItemToBill(matches[0]);
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
    [addItemToBill, catalogItems, language, showToast]
  );

  // Global hardware USB/Bluetooth keyboard-wedge scanner listener
  useBarcodeWedge({
    enabled: catalogItems.length > 0 && !aiOrderOpen,
    onScan: (code) => {
      const ok = handleBarcodeMatch(code, false);
      playScanBeep(ok);
    },
  });

  const handleAiParseOrder = async () => {
    if (!session?.access_token || !aiOrderText.trim()) return;
    setAiParsing(true);
    try {
      const res = await erpFetch('/api/erp/ai/parse-order-text', session.access_token, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: aiOrderText.trim(), mode: 'sale' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Unable to parse order text.');
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
      if (parsed.notes && !notes.trim()) {
        setNotes(parsed.notes);
      }

      let addedCount = 0;
      const unmatched: string[] = [];
      for (const ln of parsed.lines || []) {
        const it = ln.matched_item_id
          ? catalogItems.find((c) => c.id === ln.matched_item_id)
          : undefined;
        if (it) {
          addItemToBill(it, {
            qtyOverride: Math.max(0.001, Number(ln.qty || 1)),
            unitCodeOverride: ln.unit_code || null,
            rateOverride: ln.rate_override ?? null,
            discountPctOverride: ln.discount_pct ?? 0,
          });
          addedCount += 1;
        } else {
          unmatched.push(ln.raw_name);
        }
      }

      if (addedCount > 0) {
        showToast(
          unmatched.length > 0
            ? `Added ${addedCount} item(s). Could not match: ${unmatched.join(', ')}`
            : `Added ${addedCount} item(s) from text.`,
          'success'
        );
        setAiOrderText('');
        if (unmatched.length === 0) setAiOrderOpen(false);
      } else {
        showToast(
          `No catalog items matched (${unmatched.join(', ') || 'try fuller names'}).`,
          'error'
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI order parsing failed.', 'error');
    } finally {
      setAiParsing(false);
    }
  };

  const updateLine = (localId: string, patch: Partial<DraftLineRow>) => {
    setLines((prev) =>
      prev.map((row) => {
        if (row.localId !== localId) return row;
        const nextRow = { ...row, ...patch };
        if (patch.variantId !== undefined && patch.variantId !== row.variantId) {
          const itemVars = variantsByItem[row.item.id] ?? [];
          const pickedVar = itemVars.find((v) => v.id === patch.variantId) || null;
          const opt = row.unitOptions.find((u) => u.unitId === nextRow.enteredUnitId);
          const factor = opt?.factor ?? 1;
          const card = findContractorRate(
            row.item.id,
            patch.variantId || undefined,
            Number(nextRow.enteredQty || 1)
          );
          const baseRate = card
            ? Number(card.agreed_rate)
            : pickedVar
              ? Number(pickedVar.selling_price)
              : Number(row.item.selling_price);
          return {
            ...nextRow,
            shade: pickedVar?.shade || nextRow.shade || '',
            batchLot: pickedVar?.batch_lot || nextRow.batchLot || '',
            contractorRateApplied: Boolean(card),
            unitPrice: String(roundHalfUp(baseRate * factor, 2)),
            discountPct: card ? String(card.discount_pct || 0) : nextRow.discountPct,
          };
        }
        if (patch.enteredUnitId && patch.enteredUnitId !== row.enteredUnitId) {
          const opt = row.unitOptions.find((u) => u.unitId === patch.enteredUnitId);
          const factor = opt?.factor ?? 1;
          const itemVars = variantsByItem[row.item.id] ?? [];
          const pickedVar = row.variantId ? itemVars.find((v) => v.id === row.variantId) : null;
          const card = findContractorRate(
            row.item.id,
            row.variantId || undefined,
            Number(nextRow.enteredQty || 1)
          );
          const baseRate = card
            ? Number(card.agreed_rate)
            : pickedVar
              ? Number(pickedVar.selling_price)
              : Number(row.item.selling_price);
          return {
            ...nextRow,
            contractorRateApplied: Boolean(card),
            unitPrice: String(roundHalfUp(baseRate * factor, 2)),
          };
        }
        return nextRow;
      })
    );
  };

  const setAllLinesTaxInclusive = (incl: boolean, convertRates = false) => {
    setLines((prev) =>
      prev.map((row) => {
        if (row.taxInclusive === incl) return row;
        const gst = Number(row.item.gst_rate || 0);
        const currentPrice = Number(row.unitPrice || 0);
        const nextPrice =
          convertRates && gstActiveForBiz && docType !== 'bill_of_supply' && gst > 0
            ? convertRateTaxMode(currentPrice, gst, row.taxInclusive, incl)
            : currentPrice;
        return {
          ...row,
          taxInclusive: incl,
          unitPrice: String(nextPrice),
        };
      })
    );
  };

  const toggleLineTaxModeAndOptionallyConvert = (row: DraftLineRow, convertRate: boolean) => {
    const nextIncl = !row.taxInclusive;
    const gst = Number(row.item.gst_rate || 0);
    const currentPrice = Number(row.unitPrice || 0);
    const nextPrice =
      convertRate && gstActiveForBiz && docType !== 'bill_of_supply' && gst > 0
        ? convertRateTaxMode(currentPrice, gst, row.taxInclusive, nextIncl)
        : currentPrice;
    updateLine(row.localId, {
      taxInclusive: nextIncl,
      unitPrice: String(nextPrice),
    });
  };

  const calc = useMemo(
    () =>
      calculateBillPreview({
        gstRegistered: Boolean(business?.gst_registered),
        taxModuleEnabled,
        docType: docType as BillDocumentType,
        businessStateCode: business?.state_code,
        placeOfSupplyStateCode: placeOfSupply,
        extraCharges: Math.max(0, Number(extraCharges || 0)),
        autoRoundOff,
        lines: lines.map((l) => ({
          enteredQty: Math.max(0, Number(l.enteredQty || 0)),
          unitPrice: Math.max(0, Number(l.unitPrice || 0)),
          discountPct: Math.min(100, Math.max(0, Number(l.discountPct || 0))),
          gstRate: Number(l.item.gst_rate || 0),
          taxInclusive: l.taxInclusive,
        })),
      }),
    [
      business?.gst_registered,
      business?.state_code,
      taxModuleEnabled,
      docType,
      placeOfSupply,
      extraCharges,
      autoRoundOff,
      lines,
    ]
  );

  const effectivePaidNumber = useMemo(() => {
    if (docType === 'quotation') return 0;
    if (!partyId) return calc.grandTotal;
    if (!paymentsEnabled) return 0;
    if (!paidTouched) return calc.grandTotal;
    return Math.min(calc.grandTotal, Math.max(0, roundHalfUp(Number(paidAmount || 0), 2)));
  }, [docType, partyId, paymentsEnabled, paidTouched, paidAmount, calc.grandTotal]);

  const linePolicyViolations = useMemo(() => {
    if (canOverrideUnrestricted) return [];
    const warnings: string[] = [];
    for (const l of lines) {
      const opt = l.unitOptions.find((u) => u.unitId === l.enteredUnitId);
      const factor = opt?.factor ?? 1;
      const catalogUnitPrice = roundHalfUp(Number(l.item.selling_price) * factor, 2);
      const enteredPrice = roundHalfUp(Number(l.unitPrice || 0), 2);
      const enteredDisc = roundHalfUp(Number(l.discountPct || 0), 2);
      if (!allowCashierPriceReduction && enteredPrice < catalogUnitPrice) {
        warnings.push(
          `${l.item.name}: Rate ₹${enteredPrice} is below catalog price ₹${catalogUnitPrice}.`
        );
      }
      if (enteredDisc > cashierMaxDiscount) {
        warnings.push(
          `${l.item.name}: Discount ${enteredDisc}% exceeds cashier limit (${cashierMaxDiscount}%).`
        );
      }
    }
    return warnings;
  }, [canOverrideUnrestricted, lines, allowCashierPriceReduction, cashierMaxDiscount]);

  const mixedLotWarnings = useMemo(
    () =>
      detectMixedLotsOnBill(
        lines.map((l) => ({
          item_id: l.item.id,
          item_name: l.item.name,
          product_line: l.item.product_line,
          shade: l.shade,
          batch_lot: l.batchLot,
        }))
      ),
    [lines]
  );

  const buildRpcLines = () =>
    lines.map((l) => ({
      item_id: l.item.id,
      variant_id: l.variantId || null,
      shade: l.shade?.trim() || null,
      batch_lot: l.batchLot?.trim() || null,
      entered_qty: roundHalfUp(Number(l.enteredQty || 0), 3),
      entered_unit_id: l.enteredUnitId,
      unit_price: roundHalfUp(Number(l.unitPrice || 0), 2),
      discount_pct: roundHalfUp(Number(l.discountPct || 0), 2),
      tax_inclusive: l.taxInclusive,
    }));

  const handleSubmit = async (actionMode: 'draft' | 'issued') => {
    setErrorMsg(null);
    if (lines.length === 0) {
      setErrorMsg(
        language === 'hi'
          ? 'कृपया कम से कम एक सामान जोड़ें।'
          : 'Please add at least one item to the bill.'
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
    if (linePolicyViolations.length > 0) {
      setErrorMsg(linePolicyViolations[0]);
      return;
    }

    setSubmitting(true);
    try {
      const rpcLines = buildRpcLines();
      if (actionMode === 'draft') {
        const { data, error } = await supabase.rpc('save_bill_draft', {
          p_id: editingDraft?.id ?? null,
          p_doc_type: docType,
          p_party_id: partyId || null,
          p_bill_date: billDate || todayLocalIso(),
          p_due_date: docType === 'quotation' ? null : dueDate || null,
          p_valid_until: docType === 'quotation' ? validUntil || null : null,
          p_place_of_supply: placeOfSupply.trim() || null,
          p_extra_charges: Math.max(0, roundHalfUp(Number(extraCharges || 0), 2)),
          p_auto_round_off: autoRoundOff,
          p_notes: notes.trim() || null,
          p_terms: terms.trim() || null,
          p_lines: rpcLines,
          p_site_id: siteId || null,
        });
        if (error) throw error;
        showToast(
          language === 'hi' ? 'ड्राफ्ट सहेजा गया।' : 'Bill draft saved.',
          'success'
        );
        onSaved(data as BillRecord, 'draft');
      } else {
        const paid =
          docType === 'quotation'
            ? 0
            : partyId
              ? effectivePaidNumber
              : calc.grandTotal;
        const { data, error } = await supabase.rpc('issue_bill', {
          p_draft_id: editingDraft?.id ?? null,
          p_doc_type: docType,
          p_party_id: partyId || null,
          p_bill_date: billDate || todayLocalIso(),
          p_due_date: docType === 'quotation' ? null : dueDate || null,
          p_valid_until: docType === 'quotation' ? validUntil || null : null,
          p_place_of_supply: placeOfSupply.trim() || null,
          p_extra_charges: Math.max(0, roundHalfUp(Number(extraCharges || 0), 2)),
          p_auto_round_off: autoRoundOff,
          p_notes: notes.trim() || null,
          p_terms: terms.trim() || null,
          p_lines: rpcLines,
          p_paid_amount: paid,
          p_payment_mode: paymentMode,
          p_payment_reference: paymentReference.trim() || null,
          p_idempotency_key: idempotencyKey,
          p_site_id: siteId || null,
        });
        if (error) throw error;
        const issued = data as BillRecord;
        if (
          commissionsEnabled &&
          docType !== 'quotation' &&
          commissionPartnerName.trim() &&
          Number(commissionPct) > 0
        ) {
          const pct = Math.min(100, Math.max(0, Number(commissionPct)));
          const commAmt = roundHalfUp((Number(issued.grand_total) * pct) / 100, 2);
          await supabase.from('commission_entries').insert({
            party_id: commissionPartnerId || null,
            party_name: commissionPartnerName.trim(),
            bill_id: issued.id,
            bill_number: issued.bill_number,
            bill_date: issued.bill_date,
            base_amount: Number(issued.grand_total),
            commission_pct: pct,
            commission_amount: commAmt,
            status: 'pending',
          });
        }
        showToast(
          language === 'hi'
            ? `${issued.bill_number} जारी किया गया।`
            : `${issued.bill_number} issued successfully.`,
          'success'
        );
        onSaved(issued, 'issued');
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to save or issue document.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const allInclusive = lines.length > 0 && lines.every((l) => l.taxInclusive);
  const allExclusive = lines.length > 0 && lines.every((l) => !l.taxInclusive);

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Top Workspace Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-4 border-b border-[var(--border)]">
        <div className="space-y-1">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <IconArrowLeft size={16} stroke={2} />
            <span>{t('bills.title')}</span>
          </button>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconReceipt size={24} stroke={2} className="text-[var(--primary-dark)] shrink-0" />
            <span>
              {editingDraft
                ? `${language === 'hi' ? 'ड्राफ्ट संपादित करें' : 'Edit Draft'} · ${t(`bills.${docType === 'tax_invoice' ? 'taxInvoice' : docType === 'bill_of_supply' ? 'billOfSupply' : 'quotation'}`)}`
                : docType === 'quotation'
                  ? t('bills.newQuotation')
                  : t('bills.newBill')}
            </span>
          </h1>
        </div>

        {/* Document Type Switch + Top Quick Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
            {(
              [
                {
                  id: 'tax_invoice' as const,
                  label: t('bills.taxInvoice'),
                  disabled: !gstActiveForBiz,
                },
                {
                  id: 'bill_of_supply' as const,
                  label: t('bills.billOfSupply'),
                  disabled: false,
                },
                {
                  id: 'quotation' as const,
                  label: t('bills.quotation'),
                  disabled: false,
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                disabled={opt.disabled}
                onClick={() => setDocType(opt.id)}
                className={`h-9 px-3 rounded-md text-xs font-medium whitespace-nowrap disabled:opacity-40 ${
                  docType === opt.id
                    ? 'bg-[var(--primary)] text-[var(--on-primary)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleSubmit('draft')}
            className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <IconDeviceFloppy size={16} stroke={2} />
            <span>{t('bills.saveDraft')}</span>
          </button>

          <button
            type="button"
            disabled={submitting || linePolicyViolations.length > 0}
            onClick={() => void handleSubmit('issued')}
            className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95 disabled:opacity-50"
          >
            <IconCheck size={16} stroke={2.5} />
            <span>
              {submitting
                ? t('profile.saving')
                : docType === 'quotation'
                  ? t('bills.issueQuotation')
                  : t('bills.issueBill')}
            </span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs sm:text-sm text-[var(--give)] flex items-start gap-2">
          <IconAlertCircle size={18} stroke={2} className="shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Main Area */}
        <div className="lg:col-span-8 space-y-5">
          {/* Customer & Dates Card */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-5">
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('bills.partyLabel')}
                </label>
                <select
                  value={partyId}
                  onChange={(e) => handlePartyChange(e.target.value)}
                  disabled={!partiesEnabled}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                >
                  <option value="">{t('bills.walkInCustomer')} (Cash)</option>
                  {parties.map((p) => (
                    <option key={p.party_id} value={p.party_id}>
                      {p.name}
                      {p.phone ? ` (${p.phone})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('bills.billDate')}
                </label>
                <input
                  type="date"
                  value={billDate}
                  onChange={(e) => setBillDate(e.target.value)}
                  className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {docType === 'quotation' ? t('bills.validUntil') : t('bills.dueDate')}
                </label>
                <input
                  type="date"
                  value={docType === 'quotation' ? validUntil : dueDate}
                  onChange={(e) =>
                    docType === 'quotation'
                      ? setValidUntil(e.target.value)
                      : setDueDate(e.target.value)
                  }
                  className="w-full h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm tabular-nums"
                />
              </div>

              {gstActiveForBiz && docType !== 'bill_of_supply' && (
                <div className="sm:col-span-2">
                  <label
                    htmlFor="pos-state"
                    className="block text-xs font-medium text-[var(--text-muted)] mb-1"
                  >
                    State ({calc.isInterstate ? 'IGST' : 'C+SGST'})
                  </label>
                  <input
                    id="pos-state"
                    type="text"
                    maxLength={4}
                    value={placeOfSupply}
                    onChange={(e) => setPlaceOfSupply(e.target.value.toUpperCase())}
                    placeholder={business?.state_code || '27'}
                    className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono text-sm uppercase text-center"
                  />
                </div>
              )}
            </div>

            {partyId && partySites.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-[var(--border)] text-xs">
                <div>
                  <label className="block font-medium text-[var(--text-muted)] mb-1">
                    Contractor Delivery Site
                  </label>
                  <select
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    <option value="">Default party address</option>
                    {partySites.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.site_name}
                        {st.contact_phone ? ` (${st.contact_phone})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </section>

          {/* Fast Scan, Search & AI Order Input */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {t('bills.fastAddTitle')}
              </span>
              {isModuleEnabled('ai') && (
                <button
                  type="button"
                  onClick={() => setAiOrderOpen((v) => !v)}
                  className={`h-8 px-2.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 ${
                    aiOrderOpen
                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  <IconSparkles size={14} stroke={2} className="text-[var(--primary-dark)]" />
                  <span>{t('bills.aiSmartOrder')}</span>
                </button>
              )}
            </div>

            {isModuleEnabled('ai') && aiOrderOpen && (
              <div className="p-3 rounded-lg border border-[var(--primary)]/40 bg-[var(--surface-muted)] space-y-2">
                <p className="text-xs text-[var(--text-muted)]">
                  {language === 'hi'
                    ? 'व्हाट्सएप या नोट्स से ऑर्डर टेक्स्ट पेस्ट करें (जैसे: "रमेश 5 किलो चीनी, 2 बॉक्स तेल @ 1200")'
                    : 'Paste customer order text in English, Hindi, or Hinglish (e.g., "Ramesh 5 kg sugar, 2 box oil @ 1200, 5% disc"):'}
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={aiOrderText}
                    onChange={(e) => setAiOrderText(e.target.value)}
                    placeholder="e.g., 5 kg sugar, 2 ltr mustard oil..."
                    className="flex-1 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                  <button
                    type="button"
                    disabled={aiParsing || !aiOrderText.trim()}
                    onClick={() => void handleAiParseOrder()}
                    className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
                  >
                    <IconSparkles size={14} stroke={2} />
                    <span>{aiParsing ? 'Parsing...' : 'Add Items'}</span>
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
                {filteredCatalog.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => addItemToBill(it)}
                    className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]/60 hover:border-[var(--primary-dark)] hover:bg-[var(--surface-muted)] text-xs flex items-center gap-2"
                  >
                    <IconPlus size={14} stroke={2} className="text-[var(--primary-dark)]" />
                    <span className="font-medium truncate max-w-[170px]">{it.name}</span>
                    <span className="text-[var(--text-muted)] tabular-nums">
                      {formatINR(Number(it.selling_price))}
                      {it.tax_inclusive ? ' (Incl.)' : ''} · {it.qty_on_hand} {it.base_unit_code}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Line Items Card */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-2 bg-[var(--surface-muted)]/60">
              <h2 className="text-sm font-semibold">
                {t('bills.lineItemsTitle')} ({lines.length})
              </h2>

              {gstActiveForBiz && docType !== 'bill_of_supply' && lines.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-[var(--text-muted)]">{t('bills.ratesTaxMode')}:</span>
                  <button
                    type="button"
                    onClick={() => setAllLinesTaxInclusive(true, false)}
                    className={`px-2 py-1 rounded border font-medium ${
                      allInclusive
                        ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {t('bills.allInclusive')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAllLinesTaxInclusive(false, false)}
                    className={`px-2 py-1 rounded border font-medium ${
                      allExclusive
                        ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {t('bills.allExclusive')}
                  </button>
                </div>
              )}
            </div>

            {lines.length === 0 ? (
              <div className="p-10 text-center text-xs sm:text-sm text-[var(--text-muted)]">
                {language === 'hi'
                  ? 'ऊपर से सामान चुनें, कैमरा खोलें या हार्डवेयर बारकोड स्कैनर से सीधे स्कैन करें।'
                  : 'Click an item chip, tap Camera Scan, or scan with your USB/Bluetooth barcode scanner to add lines instantly.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th className="py-2.5 px-3 font-medium">Item</th>
                      <th className="py-2.5 px-2 font-medium text-center">{t('bills.qty')}</th>
                      <th className="py-2.5 px-2 font-medium w-24">{t('bills.unit')}</th>
                      <th className="py-2.5 px-2 font-medium w-36">{t('bills.rate')}</th>
                      <th className="py-2.5 px-2 font-medium w-16">{t('bills.discPct')}</th>
                      <th className="py-2.5 px-2 font-medium text-right">{t('bills.gst')}</th>
                      <th className="py-2.5 px-3 font-medium text-right">{t('bills.amount')}</th>
                      <th className="py-2.5 px-2 w-9" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {lines.map((row, idx) => {
                      const lineCalc = calc.lines[idx];
                      const stepQty = row.item.base_unit_allow_decimal ? 0.5 : 1;
                      const currentQty = Number(row.enteredQty || 0);
                      const isHighlighted = lastHighlightedId === row.localId;

                      return (
                        <tr
                          key={row.localId}
                          className={
                            isHighlighted
                              ? 'bg-[var(--primary-soft)]/55 transition-colors'
                              : 'hover:bg-[var(--surface-muted)]/35 transition-colors'
                          }
                        >
                          <td className="py-2.5 px-3 min-w-[220px] align-top space-y-1.5">
                            <div>
                              <p className="font-medium leading-snug">{row.item.name}</p>
                              <p className="text-[11px] text-[var(--text-muted)] tabular-nums mt-0.5">
                                Stock: {row.item.qty_on_hand} {row.item.base_unit_code}
                                {row.item.hsn_code ? ` · HSN ${row.item.hsn_code}` : ''}
                                {row.contractorRateApplied ? ' · Contractor Rate' : ''}
                              </p>
                            </div>
                            {((variantsByItem[row.item.id] ?? []).length > 0 ||
                              row.item.product_line === 'tiles_slabs') && (
                              <div className="space-y-1">
                                {(variantsByItem[row.item.id] ?? []).length > 0 && (
                                  <select
                                    value={row.variantId || ''}
                                    onChange={(e) =>
                                      updateLine(row.localId, { variantId: e.target.value || undefined })
                                    }
                                    className="w-full h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px]"
                                  >
                                    <option value="">Standard / Base Item</option>
                                    {(variantsByItem[row.item.id] ?? []).map((v) => (
                                      <option key={v.id} value={v.id}>
                                        {v.variant_name} ({v.qty_on_hand} {row.item.base_unit_code})
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <div className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    list={`bill-shades-${row.localId}`}
                                    value={row.shade || ''}
                                    onChange={(e) =>
                                      updateLine(row.localId, { shade: e.target.value })
                                    }
                                    placeholder="Shade"
                                    className="w-1/2 h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px]"
                                  />
                                  <input
                                    type="text"
                                    list={`bill-lots-${row.localId}`}
                                    value={row.batchLot || ''}
                                    onChange={(e) =>
                                      updateLine(row.localId, { batchLot: e.target.value })
                                    }
                                    placeholder="Batch / Lot"
                                    className="w-1/2 h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] font-mono"
                                  />
                                  <datalist id={`bill-shades-${row.localId}`}>
                                    {Array.from(
                                      new Set(
                                        (lotBalancesByItem[row.item.id] ?? [])
                                          .map((lb) => lb.shade)
                                          .filter((s) => s && s !== 'Default')
                                      )
                                    ).map((s) => (
                                      <option key={s} value={s} />
                                    ))}
                                  </datalist>
                                  <datalist id={`bill-lots-${row.localId}`}>
                                    {Array.from(
                                      new Set(
                                        (lotBalancesByItem[row.item.id] ?? [])
                                          .map((lb) => lb.batch_lot)
                                          .filter((b) => b && b !== 'Default')
                                      )
                                    ).map((b) => (
                                      <option key={b} value={b} />
                                    ))}
                                  </datalist>
                                </div>
                              </div>
                            )}
                          </td>

                          {/* Qty Stepper */}
                          <td className="py-2.5 px-2 align-top">
                            <div className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                              <button
                                type="button"
                                aria-label="Decrease quantity"
                                onClick={() => {
                                  const next = Math.max(
                                    row.item.base_unit_allow_decimal ? 0.001 : 1,
                                    roundHalfUp(currentQty - stepQty, 3)
                                  );
                                  updateLine(row.localId, { enteredQty: String(next) });
                                }}
                                className="w-7 h-9 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                              >
                                <IconMinus size={13} stroke={2.5} />
                              </button>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0.001"
                                step={row.item.base_unit_allow_decimal ? '0.001' : '1'}
                                value={row.enteredQty}
                                onChange={(e) =>
                                  updateLine(row.localId, { enteredQty: e.target.value })
                                }
                                className="w-14 h-9 px-1 bg-transparent text-center text-xs font-semibold tabular-nums focus:outline-none"
                              />
                              <button
                                type="button"
                                aria-label="Increase quantity"
                                onClick={() => {
                                  const next = roundHalfUp(currentQty + stepQty, 3);
                                  updateLine(row.localId, { enteredQty: String(next) });
                                }}
                                className="w-7 h-9 flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                              >
                                <IconPlus size={13} stroke={2.5} />
                              </button>
                            </div>
                          </td>

                          <td className="py-2.5 px-2 align-top">
                            <select
                              value={row.enteredUnitId}
                              onChange={(e) =>
                                updateLine(row.localId, { enteredUnitId: e.target.value })
                              }
                              className="w-20 h-9 px-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                            >
                              {row.unitOptions.map((u) => (
                                <option key={u.unitId} value={u.unitId}>
                                  {u.code}
                                </option>
                              ))}
                            </select>
                          </td>

                          {/* Rate + Explicit Tax Incl./Excl. Switch & Convert */}
                          <td className="py-2.5 px-2 align-top space-y-1">
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="0.01"
                              value={row.unitPrice}
                              onChange={(e) =>
                                updateLine(row.localId, { unitPrice: e.target.value })
                              }
                              className="w-28 h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium tabular-nums text-right"
                            />
                            {gstActiveForBiz && docType !== 'bill_of_supply' && (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => toggleLineTaxModeAndOptionallyConvert(row, false)}
                                  title="Toggle whether entered rate includes GST"
                                  className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                                    row.taxInclusive
                                      ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                                  }`}
                                >
                                  {row.taxInclusive ? t('bills.taxInclBadge') : t('bills.taxExclBadge')}
                                </button>
                                {Number(row.item.gst_rate || 0) > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => toggleLineTaxModeAndOptionallyConvert(row, true)}
                                    title="Switch tax mode AND recalculate rate cleanly"
                                    className="p-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--primary-dark)]"
                                  >
                                    <IconArrowsExchange size={12} stroke={2} />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>

                          <td className="py-2.5 px-2 align-top">
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              max="100"
                              step="0.01"
                              value={row.discountPct}
                              onChange={(e) =>
                                updateLine(row.localId, { discountPct: e.target.value })
                              }
                              className="w-16 h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums text-right"
                            />
                          </td>

                          <td className="py-2.5 px-2 text-right tabular-nums text-xs text-[var(--text-muted)] whitespace-nowrap align-top">
                            {calc.gstApplied ? (
                              <>
                                <div className="font-medium text-[var(--text)]">
                                  {lineCalc?.effectiveGstRate ?? 0}% ({formatINR(lineCalc?.taxAmount ?? 0)})
                                </div>
                                <div className="text-[10px]">
                                  Base {formatINR(lineCalc?.taxableAmount ?? 0)}
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>

                          <td className="py-2.5 px-3 text-right font-semibold tabular-nums whitespace-nowrap align-top">
                            {formatINR(lineCalc?.lineTotal ?? 0)}
                          </td>

                          <td className="py-2.5 px-2 text-right align-top">
                            <button
                              type="button"
                              aria-label="Remove line"
                              onClick={() =>
                                setLines((prev) =>
                                  prev.filter((x) => x.localId !== row.localId)
                                )
                              }
                              className="p-1.5 rounded hover:bg-[var(--give-soft)] text-[var(--give)]"
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

          {mixedLotWarnings.length > 0 && (
            <div className="p-3.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <div className="font-semibold inline-flex items-center gap-1.5">
                <IconAlertTriangle size={15} stroke={2} />
                <span>
                  {language === 'hi'
                    ? 'टाइल शेड / बैच लॉट चेतावनी'
                    : 'Tile Shade / Batch Lot Warning'}
                </span>
              </div>
              {mixedLotWarnings.map((w) => (
                <p key={w.itemId}>• {language === 'hi' ? w.messageHi : w.messageEn}</p>
              ))}
            </div>
          )}

          {linePolicyViolations.length > 0 && (
            <div className="p-3.5 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <p className="font-semibold">
                {language === 'hi'
                  ? 'भूमिका सीमा (Owner या Manager अनुमति आवश्यक):'
                  : 'Override Policy Check (Owner / Manager approval needed):'}
              </p>
              {linePolicyViolations.map((w, i) => (
                <p key={i}>• {w}</p>
              ))}
            </div>
          )}

          {/* Extra Charges & Notes */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('bills.extraCharges')} (₹)
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={extraCharges}
                  onChange={(e) => setExtraCharges(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
              </div>
              <label className="flex items-center gap-2 pt-5 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRoundOff}
                  onChange={(e) => setAutoRoundOff(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary-dark)]"
                />
                <span>Auto Round-Off</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('parties.notes')}
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Order or delivery note..."
                  className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  Invoice Terms
                </label>
                <textarea
                  rows={2}
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm"
                />
              </div>
            </div>

            {commissionsEnabled && docType !== 'quotation' && (
              <div className="pt-3 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    Referral / Mason Partner (Optional)
                  </label>
                  <select
                    value={commissionPartnerId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setCommissionPartnerId(id);
                      const p = parties.find((x) => x.party_id === id);
                      if (p) setCommissionPartnerName(p.name);
                    }}
                    className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    <option value="">— Enter Partner Name —</option>
                    {parties.map((p) => (
                      <option key={p.party_id} value={p.party_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    Partner Name
                  </label>
                  <input
                    type="text"
                    value={commissionPartnerName}
                    onChange={(e) => setCommissionPartnerName(e.target.value)}
                    placeholder="Architect / Contractor / Mason"
                    className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    Commission (%)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.25"
                    value={commissionPct}
                    onChange={(e) => setCommissionPct(e.target.value)}
                    placeholder="0"
                    className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Right Sticky Checkout Rail */}
        <aside className="lg:col-span-4 lg:sticky lg:top-6 space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <div>
                <p className="text-xs text-[var(--text-muted)]">Billing Summary</p>
                <p className="text-sm font-semibold truncate max-w-[220px]">
                  {selectedPartyObj ? selectedPartyObj.name : `${t('bills.walkInCustomer')} (Cash)`}
                </p>
              </div>
              {gstActiveForBiz && docType !== 'bill_of_supply' && (
                <span className="text-[11px] font-semibold text-[var(--primary-dark)]">
                  {calc.isInterstate ? 'IGST' : 'CGST+SGST'}
                </span>
              )}
            </div>

            <dl className="space-y-2 text-xs sm:text-sm">
              <div className="flex justify-between">
                <dt className="text-[var(--text-muted)]">{t('bills.taxableSubtotal')}</dt>
                <dd className="font-medium tabular-nums">
                  {formatINR(calc.subtotalTaxable)}
                </dd>
              </div>
              {calc.discountTotal > 0 && (
                <div className="flex justify-between text-[var(--receive-text)]">
                  <dt>{t('bills.discountTotal')}</dt>
                  <dd className="tabular-nums">-{formatINR(calc.discountTotal)}</dd>
                </div>
              )}
              {calc.gstApplied && !calc.isInterstate && (
                <>
                  <div className="flex justify-between text-[var(--text-muted)]">
                    <dt>CGST</dt>
                    <dd className="tabular-nums">{formatINR(calc.cgstTotal)}</dd>
                  </div>
                  <div className="flex justify-between text-[var(--text-muted)]">
                    <dt>SGST</dt>
                    <dd className="tabular-nums">{formatINR(calc.sgstTotal)}</dd>
                  </div>
                </>
              )}
              {calc.gstApplied && calc.isInterstate && (
                <div className="flex justify-between text-[var(--text-muted)]">
                  <dt>IGST</dt>
                  <dd className="tabular-nums">{formatINR(calc.igstTotal)}</dd>
                </div>
              )}
              {calc.extraCharges > 0 && (
                <div className="flex justify-between text-[var(--text-muted)]">
                  <dt>{t('bills.extraCharges')}</dt>
                  <dd className="tabular-nums">{formatINR(calc.extraCharges)}</dd>
                </div>
              )}
              {calc.roundOff !== 0 && (
                <div className="flex justify-between text-[var(--text-muted)]">
                  <dt>{t('bills.roundOff')}</dt>
                  <dd className="tabular-nums">
                    {calc.roundOff > 0 ? `+${calc.roundOff.toFixed(2)}` : calc.roundOff.toFixed(2)}
                  </dd>
                </div>
              )}
              <div className="pt-2.5 border-t border-[var(--border)] flex justify-between items-baseline text-lg font-bold">
                <dt>{t('bills.grandTotal')}</dt>
                <dd className="tabular-nums">{formatINR(calc.grandTotal)}</dd>
              </div>
            </dl>

            <p className="text-[11px] text-[var(--text-muted)] leading-snug">
              {amountInWordsINR(calc.grandTotal)}
            </p>

            {/* Payment Collection */}
            {docType !== 'quotation' && (
              <div className="pt-3 border-t border-[var(--border)] space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{t('bills.paidNow')}</span>
                  {partyId && paymentsEnabled && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setPaidTouched(true);
                          setPaidAmount(String(calc.grandTotal));
                        }}
                        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-muted)] text-[11px] font-medium"
                      >
                        Full Paid
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPaidTouched(true);
                          setPaidAmount('0');
                        }}
                        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-muted)] text-[11px] font-medium"
                      >
                        Credit (Khata)
                      </button>
                    </div>
                  )}
                </div>

                {!partyId ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    {language === 'hi'
                      ? 'वॉक-इन नकद बिल के लिए पूरी राशि अभी प्राप्त मानी जाएगी।'
                      : 'Walk-in cash bill settles full amount immediately. Choose a Party for partial/credit Khata.'}
                  </p>
                ) : !paymentsEnabled ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    {t('bills.partyPayModuleOff')}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max={calc.grandTotal}
                      step="0.01"
                      value={paidTouched ? paidAmount : String(calc.grandTotal)}
                      onChange={(e) => {
                        setPaidTouched(true);
                        setPaidAmount(e.target.value);
                      }}
                      className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-semibold tabular-nums text-right"
                    />
                    <select
                      value={paymentMode}
                      onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
                      className="h-10 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium"
                    >
                      {PAYMENT_MODES.map((m) => (
                        <option key={m} value={m}>
                          {t(`payments.modes.${m}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {effectivePaidNumber > 0 && (
                  <input
                    type="text"
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    placeholder={t('payments.referenceNo')}
                    className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  />
                )}

                {partyId && (
                  <div className="flex justify-between text-xs font-medium pt-0.5">
                    <span className="text-[var(--text-muted)]">{t('bills.balanceDue')}</span>
                    <span className="tabular-nums text-[var(--receive-text)]">
                      {formatINR(Math.max(0, roundHalfUp(calc.grandTotal - effectivePaidNumber, 2)))}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="pt-2 space-y-2">
              <button
                type="button"
                disabled={submitting || linePolicyViolations.length > 0}
                onClick={() => void handleSubmit('issued')}
                className="w-full h-11 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center justify-center gap-2 hover:opacity-95 disabled:opacity-50"
              >
                <IconCheck size={17} stroke={2.5} />
                <span>
                  {submitting
                    ? t('profile.saving')
                    : docType === 'quotation'
                      ? t('bills.issueQuotation')
                      : `${t('bills.issueBill')} (${formatINR(calc.grandTotal)})`}
                </span>
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleSubmit('draft')}
                  className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <IconDeviceFloppy size={15} stroke={2} />
                  <span>{t('bills.saveDraft')}</span>
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
