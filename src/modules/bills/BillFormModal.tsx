import {
  IconAlertCircle,
  IconArrowsExchange,
  IconBarcode,
  IconCheck,
  IconDeviceFloppy,
  IconPlus,
  IconReceipt,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { FileUpload, type UploadedFileItem } from '../../components/upload/FileUpload';
import { addDaysLocalIso, formatDate, formatINR, todayLocalIso } from '../../core/format';
import {
  amountInWordsINR,
  calculateBillPreview,
  roundHalfUp,
  type BillDocumentType,
} from '../../core/money';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import {
  classifyBatchExpiry,
  computeLooseWeightFromAmount,
  computeMrpSavings,
  resolveWholesaleUnitPrice,
  sortBatchesFefo,
} from '../../packs/registry';
import type {
  BillLineRecord,
  BillRecord,
  ItemBatchRecord,
  ItemCatalogRecord,
  ItemUnitRecord,
  ItemVariantRecord,
  PartyBalanceRecord,
  PartyItemRateRecord,
  PartySiteRecord,
  PaymentMode,
  SaltSubstituteRow,
  ServiceJobRecord,
  UnitConversionRecord,
} from '../../types/bizone';

interface BillFormModalProps {
  open: boolean;
  editingDraft?: BillRecord | null;
  defaultDocType?: 'tax_invoice' | 'bill_of_supply' | 'quotation';
  defaultPartyId?: string | null;
  onClose: () => void;
  onSaved: (bill: BillRecord, mode: 'draft' | 'issued') => void;
}

interface DraftLineRow {
  localId: string;
  item: ItemCatalogRecord;
  enteredQty: string;
  enteredUnitId: string;
  unitOptions: Array<{ unitId: string; code: string; factor: number }>;
  unitPrice: string;
  discountPct: string;
  taxInclusive: boolean;
  batchId: string;
  variantId: string;
  serialNo: string;
  looseRsInput: string;
  priceSource?: 'custom_rate' | 'slab' | 'base';
}

const PAYMENT_MODES: PaymentMode[] = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'cheque',
  'other',
];

export function BillFormModal({
  open,
  editingDraft,
  defaultDocType,
  defaultPartyId,
  onClose,
  onSaved,
}: BillFormModalProps) {
  const { business, profile, isModuleEnabled, language, showToast, t } = useApp();

  const taxModuleEnabled = isModuleEnabled('tax');
  const partiesEnabled = isModuleEnabled('parties');
  const paymentsEnabled = isModuleEnabled('payments');
  const pack = business?.pack || 'general_retail';
  const batchExpiryEnabled = isModuleEnabled('batch_expiry') || pack === 'medical';
  const variantsEnabled = isModuleEnabled('variants') || pack === 'clothing';
  const gstActiveForBiz = Boolean(business?.gst_registered) && taxModuleEnabled;

  const [docType, setDocType] = useState<'tax_invoice' | 'bill_of_supply' | 'quotation'>(
    'tax_invoice'
  );
  const [partyId, setPartyId] = useState<string>('');
  const [siteId, setSiteId] = useState<string>('');
  const [jobId, setJobId] = useState<string>('');
  const [billDate, setBillDate] = useState(todayLocalIso());
  const [dueDate, setDueDate] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [extraCharges, setExtraCharges] = useState('0');
  const [autoRoundOff, setAutoRoundOff] = useState(true);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');

  // Medical Prescription & Substitutes
  const [rxPatientName, setRxPatientName] = useState('');
  const [rxPatientAge, setRxPatientAge] = useState('');
  const [rxPatientPhone, setRxPatientPhone] = useState('');
  const [rxDoctorName, setRxDoctorName] = useState('');
  const [rxDoctorRegNo, setRxDoctorRegNo] = useState('');
  const [rxNotes, setRxNotes] = useState('');
  const [rxAttachment, setRxAttachment] = useState<UploadedFileItem | null>(null);
  const [subTargetLineId, setSubTargetLineId] = useState<string | null>(null);
  const [substitutes, setSubstitutes] = useState<SaltSubstituteRow[]>([]);
  const [loadingSubstitutes, setLoadingSubstitutes] = useState(false);

  const [lines, setLines] = useState<DraftLineRow[]>([]);
  const [paidAmount, setPaidAmount] = useState('');
  const [paidTouched, setPaidTouched] = useState(false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [paymentReference, setPaymentReference] = useState('');

  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [partySites, setPartySites] = useState<PartySiteRecord[]>([]);
  const [partyRatesByItem, setPartyRatesByItem] = useState<Record<string, PartyItemRateRecord>>({});
  const [serviceJobs, setServiceJobs] = useState<ServiceJobRecord[]>([]);
  const [catalogItems, setCatalogItems] = useState<ItemCatalogRecord[]>([]);
  const [batchesByItem, setBatchesByItem] = useState<Record<string, ItemBatchRecord[]>>({});
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

  const canOverrideUnrestricted = hasCapability(profile?.role, 'override_price_discount');
  const cashierMaxDiscount = Number(business?.cashier_max_discount_pct ?? 10);
  const allowCashierPriceReduction = Boolean(business?.allow_cashier_price_override);

  const loadPartyPackDetails = useCallback(
    async (pid: string) => {
      if (!pid || !partiesEnabled) {
        setPartySites([]);
        setPartyRatesByItem({});
        return;
      }
      const [sitesRes, ratesRes] = await Promise.all([
        pack === 'hardware'
          ? supabase
              .from('party_sites')
              .select('*')
              .eq('party_id', pid)
              .eq('is_active', true)
              .order('site_name')
          : Promise.resolve({ data: [], error: null }),
        pack === 'wholesale'
          ? supabase
              .from('party_item_rates')
              .select('*')
              .eq('party_id', pid)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (!sitesRes.error) {
        setPartySites((sitesRes.data as PartySiteRecord[] | null) ?? []);
      }
      if (!ratesRes.error) {
        const rateMap: Record<string, PartyItemRateRecord> = {};
        for (const r of (ratesRes.data as PartyItemRateRecord[] | null) ?? []) {
          rateMap[r.item_id] = r;
        }
        setPartyRatesByItem(rateMap);
      }
    },
    [pack, partiesEnabled]
  );

  const loadMasterData = useCallback(async () => {
    setLoadingMaster(true);
    try {
      const [itemsRes, convRes, unitsRes, partyRes, addrRes, batchRes, varRes, jobRes] =
        await Promise.all([
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
                .order('name')
                .limit(300)
            : Promise.resolve({ data: [], error: null }),
          partiesEnabled
            ? supabase
                .from('party_addresses')
                .select('party_id, state_code, is_default')
                .order('is_default', { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          batchExpiryEnabled
            ? supabase
                .from('item_batches')
                .select('*')
                .eq('is_active', true)
                .gt('qty_on_hand', 0)
                .order('expiry_date', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
          variantsEnabled
            ? supabase
                .from('item_variants')
                .select('*')
                .eq('is_active', true)
                .order('size')
            : Promise.resolve({ data: [], error: null }),
          pack === 'service'
            ? supabase
                .from('service_jobs')
                .select('*')
                .in('status', ['open', 'in_progress', 'completed'])
                .order('created_at', { ascending: false })
                .limit(100)
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

      const bMap: Record<string, ItemBatchRecord[]> = {};
      for (const b of (batchRes.data as ItemBatchRecord[] | null) ?? []) {
        if (!bMap[b.item_id]) bMap[b.item_id] = [];
        bMap[b.item_id].push(b);
      }

      const vMap: Record<string, ItemVariantRecord[]> = {};
      for (const v of (varRes.data as ItemVariantRecord[] | null) ?? []) {
        if (!vMap[v.item_id]) vMap[v.item_id] = [];
        vMap[v.item_id].push(v);
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
      setBatchesByItem(bMap);
      setVariantsByItem(vMap);
      setServiceJobs((jobRes.data as ServiceJobRecord[] | null) ?? []);
      setParties((partyRes.data as PartyBalanceRecord[] | null) ?? []);
      setPartyAddressesById(addrStateMap);
      return {
        itemsList,
        convMap,
        bMap,
        vMap,
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
  }, [partiesEnabled, batchExpiryEnabled, variantsEnabled, pack]);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setItemSearch('');
    setPaymentMode('cash');
    setPaymentReference('');
    setRxPatientName('');
    setRxPatientAge('');
    setRxPatientPhone('');
    setRxDoctorName('');
    setRxDoctorRegNo('');
    setRxNotes('');
    setRxAttachment(null);
    setSubTargetLineId(null);
    setSubstitutes([]);
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
        setJobId(editingDraft.job_id || '');
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
            enteredQty: String(dl.entered_qty),
            enteredUnitId: dl.entered_unit_id,
            unitOptions,
            unitPrice: String(dl.unit_price),
            discountPct: String(dl.discount_pct),
            taxInclusive: Boolean(dl.tax_inclusive),
            batchId: dl.batch_id || '',
            variantId: dl.variant_id || '',
            serialNo: String((dl.line_meta as Record<string, unknown> | undefined)?.serial_no || ''),
            looseRsInput: '',
            priceSource: 'base',
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
        setJobId('');
        if (initPartyId) {
          void loadPartyPackDetails(initPartyId);
        } else {
          setPartySites([]);
          setPartyRatesByItem({});
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
    open,
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
      setDueDate(
        addDaysLocalIso(billDate || todayLocalIso(), found.credit_days)
      );
    }
  };

  const selectedPartyObj = useMemo(
    () => parties.find((p) => p.party_id === partyId) ?? null,
    [parties, partyId]
  );

  const resolvePriceForLine = useCallback(
    (item: ItemCatalogRecord, qty: number, factor: number) => {
      if (pack !== 'wholesale') {
        return {
          unitPrice: roundHalfUp(Number(item.selling_price) * factor, 2),
          source: 'base' as const,
        };
      }
      return resolveWholesaleUnitPrice({
        basePrice: Number(item.selling_price),
        priceTier: selectedPartyObj?.price_tier || 'standard',
        qty,
        slabs: item.wholesale_slabs,
        partyCustomRate: partyRatesByItem[item.id] ?? null,
        conversionFactor: factor,
      });
    },
    [pack, selectedPartyObj?.price_tier, partyRatesByItem]
  );

  const addItemToBill = (item: ItemCatalogRecord) => {
    setLines((prev) => {
      const canMerge =
        pack !== 'clothing' && pack !== 'medical' && pack !== 'hardware';
      const existingIdx = canMerge
        ? prev.findIndex(
            (l) => l.item.id === item.id && l.enteredUnitId === item.base_unit_id
          )
        : -1;
      if (existingIdx >= 0) {
        return prev.map((row, idx) => {
          if (idx !== existingIdx) return row;
          const nextQty = roundHalfUp(Number(row.enteredQty || 0) + 1, 3);
          const resolved = resolvePriceForLine(row.item, nextQty, 1);
          return {
            ...row,
            enteredQty: String(nextQty),
            unitPrice: pack === 'wholesale' ? String(resolved.unitPrice) : row.unitPrice,
            priceSource: resolved.source,
          };
        });
      }
      const unitOptions = conversionsByItem[item.id] ?? [
        { unitId: item.base_unit_id, code: item.base_unit_code, factor: 1 },
      ];
      const fefoBatch = batchExpiryEnabled
        ? sortBatchesFefo(batchesByItem[item.id] ?? [], billDate || todayLocalIso())[0]
        : undefined;
      const defaultVar = variantsEnabled
        ? (variantsByItem[item.id] ?? []).find((v) => v.qty_on_hand > 0) ??
          (variantsByItem[item.id] ?? [])[0]
        : undefined;
      const baseResolved = resolvePriceForLine(item, 1, 1);
      const initialPrice =
        fefoBatch?.selling_rate != null
          ? roundHalfUp(Number(fefoBatch.selling_rate), 2)
          : defaultVar?.selling_price != null
            ? roundHalfUp(Number(defaultVar.selling_price), 2)
            : baseResolved.unitPrice;
      return [
        ...prev,
        {
          localId: crypto.randomUUID(),
          item,
          enteredQty: '1',
          enteredUnitId: item.base_unit_id,
          unitOptions,
          unitPrice: String(initialPrice),
          discountPct: '0',
          taxInclusive: Boolean(item.tax_inclusive),
          batchId: fefoBatch?.id || '',
          variantId: defaultVar?.id || '',
          serialNo: '',
          looseRsInput: '',
          priceSource: baseResolved.source,
        },
      ];
    });
    setItemSearch('');
  };

  const handleOpenSubstitutes = async (lineId: string, itemId: string) => {
    setSubTargetLineId(lineId);
    setLoadingSubstitutes(true);
    setSubstitutes([]);
    const { data, error } = await supabase.rpc('get_salt_substitutes', {
      p_item_id: itemId,
    });
    setLoadingSubstitutes(false);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    setSubstitutes((data as SaltSubstituteRow[] | null) ?? []);
  };

  const handleSwapSubstitute = (sub: SaltSubstituteRow) => {
    if (!subTargetLineId) return;
    const found = catalogItems.find((it) => it.id === sub.id);
    if (!found) {
      showToast('Substitute item not in active catalog.', 'error');
      return;
    }
    const unitOptions = conversionsByItem[found.id] ?? [
      { unitId: found.base_unit_id, code: found.base_unit_code, factor: 1 },
    ];
    const fefo = sortBatchesFefo(batchesByItem[found.id] ?? [], billDate || todayLocalIso())[0];
    setLines((prev) =>
      prev.map((row) =>
        row.localId === subTargetLineId
          ? {
              ...row,
              item: found,
              enteredUnitId: found.base_unit_id,
              unitOptions,
              batchId: fefo?.id || '',
              variantId: '',
              unitPrice: String(
                roundHalfUp(Number(fefo?.selling_rate ?? found.selling_price), 2)
              ),
            }
          : row
      )
    );
    setSubTargetLineId(null);
    setSubstitutes([]);
  };

  const filteredCatalog = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return catalogItems.slice(0, 8);
    return catalogItems
      .filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          (it.sku && it.sku.toLowerCase().includes(q)) ||
          (it.barcode && it.barcode.toLowerCase().includes(q))
      )
      .slice(0, 10);
  }, [catalogItems, itemSearch]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const q = itemSearch.trim().toLowerCase();
    if (!q) return;
    const exactMatch = catalogItems.find(
      (it) =>
        (it.barcode && it.barcode.toLowerCase() === q) ||
        (it.sku && it.sku.toLowerCase() === q)
    );
    if (exactMatch) {
      e.preventDefault();
      addItemToBill(exactMatch);
    } else if (filteredCatalog.length === 1) {
      e.preventDefault();
      addItemToBill(filteredCatalog[0]);
    }
  };

  const updateLine = (localId: string, patch: Partial<DraftLineRow>) => {
    setLines((prev) =>
      prev.map((row) => {
        if (row.localId !== localId) return row;
        const nextRow = { ...row, ...patch };
        if (patch.enteredUnitId && patch.enteredUnitId !== row.enteredUnitId) {
          const opt = row.unitOptions.find((u) => u.unitId === patch.enteredUnitId);
          const factor = opt?.factor ?? 1;
          const resolved = resolvePriceForLine(
            row.item,
            Number(nextRow.enteredQty || 1),
            factor
          );
          return {
            ...nextRow,
            unitPrice: String(resolved.unitPrice),
            priceSource: resolved.source,
          };
        }
        if (patch.enteredQty !== undefined && pack === 'wholesale') {
          const opt = row.unitOptions.find((u) => u.unitId === nextRow.enteredUnitId);
          const factor = opt?.factor ?? 1;
          const resolved = resolvePriceForLine(
            row.item,
            Number(patch.enteredQty || 0),
            factor
          );
          return {
            ...nextRow,
            unitPrice: String(resolved.unitPrice),
            priceSource: resolved.source,
          };
        }
        if (patch.batchId !== undefined && patch.batchId !== row.batchId) {
          const batch = (batchesByItem[row.item.id] ?? []).find(
            (b) => b.id === patch.batchId
          );
          if (batch?.selling_rate != null) {
            return {
              ...nextRow,
              unitPrice: String(roundHalfUp(Number(batch.selling_rate), 2)),
            };
          }
        }
        if (patch.variantId !== undefined && patch.variantId !== row.variantId) {
          const vr = (variantsByItem[row.item.id] ?? []).find(
            (v) => v.id === patch.variantId
          );
          if (vr?.selling_price != null) {
            return {
              ...nextRow,
              unitPrice: String(roundHalfUp(Number(vr.selling_price), 2)),
            };
          }
        }
        return nextRow;
      })
    );
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

  // For Walk-in Customer cash bills default paidAmount automatically to grandTotal unless user has selected a party
  const effectivePaidNumber = useMemo(() => {
    if (docType === 'quotation') return 0;
    if (!partyId) return calc.grandTotal;
    if (!paymentsEnabled) return 0;
    if (!paidTouched) return calc.grandTotal;
    return Math.min(calc.grandTotal, Math.max(0, roundHalfUp(Number(paidAmount || 0), 2)));
  }, [docType, partyId, paymentsEnabled, paidTouched, paidAmount, calc.grandTotal]);

  // Role violation preview so cashier immediately sees clear message before submit
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

  const requiresPrescription = useMemo(() => {
    if (pack !== 'medical' || docType === 'quotation') return false;
    return lines.some((l) =>
      ['H', 'H1', 'X', 'NRX'].includes(
        String(l.item.pack_metadata?.schedule || '').toUpperCase()
      )
    );
  }, [pack, docType, lines]);

  const totalMrpSavings = useMemo(
    () =>
      lines.reduce((acc, row) => {
        const opt = row.unitOptions.find((u) => u.unitId === row.enteredUnitId);
        const factor = opt?.factor ?? 1;
        const unitMrp = row.item.mrp ? Number(row.item.mrp) * factor : null;
        return (
          acc +
          computeMrpSavings(unitMrp, Number(row.unitPrice || 0), Number(row.enteredQty || 0))
        );
      }, 0),
    [lines]
  );

  const buildRpcLines = () =>
    lines.map((l) => ({
      item_id: l.item.id,
      entered_qty: roundHalfUp(Number(l.enteredQty || 0), 3),
      entered_unit_id: l.enteredUnitId,
      unit_price: roundHalfUp(Number(l.unitPrice || 0), 2),
      discount_pct: roundHalfUp(Number(l.discountPct || 0), 2),
      tax_inclusive: l.taxInclusive,
      batch_id: l.batchId || null,
      variant_id: l.variantId || null,
      line_meta: l.serialNo.trim() ? { serial_no: l.serialNo.trim() } : {},
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
    if (
      actionMode === 'issued' &&
      requiresPrescription &&
      (!rxPatientName.trim() || !rxDoctorName.trim())
    ) {
      setErrorMsg(
        'Schedule H/H1/X medicines require Patient Name and Prescribing Doctor Name.'
      );
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
          p_job_id: jobId || null,
        });
        if (error) throw error;
        showToast(
          language === 'hi' ? 'ड्राफ्ट सहेजा गया।' : 'Bill draft saved.',
          'success'
        );
        onSaved(data as BillRecord, 'draft');
        onClose();
      } else {
        const paid =
          docType === 'quotation'
            ? 0
            : partyId
              ? effectivePaidNumber
              : calc.grandTotal;
        const rxPayload =
          rxPatientName.trim() || rxDoctorName.trim() || rxAttachment
            ? {
                patient_name: rxPatientName.trim(),
                patient_age: rxPatientAge.trim() || null,
                patient_phone: rxPatientPhone.trim() || null,
                doctor_name: rxDoctorName.trim(),
                doctor_reg_no: rxDoctorRegNo.trim() || null,
                notes: rxNotes.trim() || null,
                attachment_file_id: rxAttachment?.fileId ?? null,
              }
            : null;
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
          p_job_id: jobId || null,
          p_prescription: rxPayload,
        });
        if (error) throw error;
        const issued = data as BillRecord;
        showToast(
          language === 'hi'
            ? `${issued.bill_number} जारी किया गया।`
            : `${issued.bill_number} issued successfully.`,
          'success'
        );
        onSaved(issued, 'issued');
        onClose();
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to save or issue document.'
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
        aria-label={docType === 'quotation' ? t('bills.newQuotation') : t('bills.newBill')}
        className="w-full sm:max-w-5xl max-h-[95vh] rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <IconReceipt size={20} stroke={2} className="text-[var(--primary-dark)]" />
            <h2 className="text-base sm:text-lg font-semibold">
              {editingDraft
                ? `${language === 'hi' ? 'ड्राफ्ट संपादित करें' : 'Edit Draft'} · ${t(`bills.${docType === 'tax_invoice' ? 'taxInvoice' : docType === 'bill_of_supply' ? 'billOfSupply' : 'quotation'}`)}`
                : docType === 'quotation'
                  ? t('bills.newQuotation')
                  : t('bills.newBill')}
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

        {/* Scrollable Composer Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs sm:text-sm text-[var(--give)] flex items-start gap-2">
              <IconAlertCircle size={16} stroke={2} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Document Type & Customer Row */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-4">
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                Document Type
              </label>
              <div className="grid grid-cols-3 gap-1.5">
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
                    className={`h-10 px-2 rounded-lg border text-xs font-medium truncate disabled:opacity-40 ${
                      docType === opt.id
                        ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="md:col-span-4">
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('bills.partyLabel')}
              </label>
              <select
                value={partyId}
                onChange={(e) => handlePartyChange(e.target.value)}
                disabled={!partiesEnabled}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="">
                  {t('bills.walkInCustomer')} (Cash)
                </option>
                {parties.map((p) => (
                  <option key={p.party_id} value={p.party_id}>
                    {p.name}
                    {p.phone ? ` (${p.phone})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
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

            <div className="md:col-span-2">
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
                className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>
          </div>

          {((pack === 'hardware' && partyId && partySites.length > 0) ||
            (pack === 'service' && serviceJobs.length > 0) ||
            (pack === 'wholesale' && selectedPartyObj)) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs">
              {pack === 'hardware' && partyId && partySites.length > 0 && (
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
              )}

              {pack === 'service' && serviceJobs.length > 0 && (
                <div>
                  <label className="block font-medium text-[var(--text-muted)] mb-1">
                    Link Service Job / Work Order
                  </label>
                  <select
                    value={jobId}
                    onChange={(e) => setJobId(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    <option value="">Standalone bill (no job)</option>
                    {serviceJobs.map((jb) => (
                      <option key={jb.id} value={jb.id}>
                        {jb.job_number} — {jb.title} ({jb.status})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {pack === 'wholesale' && selectedPartyObj && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--text-muted)]">B2B Price Tier:</span>
                  <span className="font-semibold uppercase text-[var(--primary-dark)]">
                    {(selectedPartyObj.price_tier || 'standard').replace(/_/g, ' ')}
                  </span>
                </div>
              )}
            </div>
          )}

          {gstActiveForBiz && docType !== 'bill_of_supply' && (
            <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs">
              <div className="flex items-center gap-2">
                <label htmlFor="pos-state" className="font-medium text-[var(--text-muted)]">
                  {t('bills.placeOfSupply')}:
                </label>
                <input
                  id="pos-state"
                  type="text"
                  maxLength={4}
                  value={placeOfSupply}
                  onChange={(e) => setPlaceOfSupply(e.target.value.toUpperCase())}
                  placeholder={business?.state_code || '27'}
                  className="w-20 h-8 px-2 rounded border border-[var(--border)] bg-[var(--surface)] font-mono text-xs uppercase"
                />
              </div>
              <span className="font-semibold text-[var(--primary-dark)]">
                {calc.isInterstate ? t('bills.interstate') : t('bills.intrastate')}
              </span>
            </div>
          )}

          {/* Fast Item / Barcode Quick Adder */}
          <div className="space-y-2">
            <div className="relative">
              <IconBarcode
                size={18}
                stroke={2}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--primary-dark)]"
              />
              <input
                type="text"
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('bills.addItemLine')}
                className="w-full h-11 pl-10 pr-10 rounded-lg border border-[var(--primary)]/50 bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
              <IconSearch
                size={16}
                stroke={2}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
              />
            </div>

            {loadingMaster ? (
              <p className="text-xs text-[var(--text-muted)]">{t('common.loading')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {filteredCatalog.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => addItemToBill(it)}
                    className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs flex items-center gap-2"
                  >
                    <IconPlus size={14} stroke={2} className="text-[var(--primary-dark)]" />
                    <span className="font-medium truncate max-w-[160px]">{it.name}</span>
                    <span className="text-[var(--text-muted)] tabular-nums">
                      {formatINR(Number(it.selling_price))} · {it.qty_on_hand} {it.base_unit_code}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Bill Line Items */}
          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            {lines.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-[var(--text-muted)]">
                {language === 'hi'
                  ? 'ऊपर से सामान चुनें या बारकोड स्कैन करके Enter दबाएं।'
                  : 'Click an item above or scan a barcode and press Enter to add it to this bill.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th className="py-2.5 px-3 font-medium">Item</th>
                      <th className="py-2.5 px-2 font-medium w-24">{t('bills.qty')}</th>
                      <th className="py-2.5 px-2 font-medium w-24">{t('bills.unit')}</th>
                      <th className="py-2.5 px-2 font-medium w-28">{t('bills.rate')}</th>
                      <th className="py-2.5 px-2 font-medium w-20">{t('bills.discPct')}</th>
                      <th className="py-2.5 px-2 font-medium text-right">{t('bills.gst')}</th>
                      <th className="py-2.5 px-3 font-medium text-right">{t('bills.amount')}</th>
                      <th className="py-2.5 px-2 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {lines.map((row, idx) => {
                      const lineCalc = calc.lines[idx];
                      const itemBatches = batchesByItem[row.item.id] ?? [];
                      const itemVariants = variantsByItem[row.item.id] ?? [];
                      const hasWarranty =
                        pack === 'hardware' &&
                        Number(row.item.pack_metadata?.warranty_months || 0) > 0;
                      const saltName = row.item.pack_metadata?.salt
                        ? String(row.item.pack_metadata.salt)
                        : '';
                      const scheduleClass = row.item.pack_metadata?.schedule
                        ? String(row.item.pack_metadata.schedule).toUpperCase()
                        : '';
                      const selectedUnitOpt = row.unitOptions.find(
                        (u) => u.unitId === row.enteredUnitId
                      );
                      const mrpSav = computeMrpSavings(
                        row.item.mrp
                          ? Number(row.item.mrp) * (selectedUnitOpt?.factor ?? 1)
                          : null,
                        Number(row.unitPrice || 0),
                        Number(row.enteredQty || 0)
                      );
                      return (
                        <tr key={row.localId}>
                          <td className="py-2.5 px-3 min-w-[200px]">
                            <p className="font-medium">{row.item.name}</p>
                            <p className="text-[11px] text-[var(--text-muted)] tabular-nums">
                              Stock: {row.item.qty_on_hand} {row.item.base_unit_code}
                              {row.item.hsn_code ? ` · HSN ${row.item.hsn_code}` : ''}
                              {row.taxInclusive && calc.gstApplied ? ' · Tax Incl.' : ''}
                              {scheduleClass ? ` · Sch ${scheduleClass}` : ''}
                              {row.priceSource === 'custom_rate'
                                ? ' · Rate Card'
                                : row.priceSource === 'slab'
                                  ? ' · Qty Slab'
                                  : ''}
                            </p>
                            {pack === 'kirana' && mrpSav > 0 && (
                              <p className="text-[11px] text-[var(--receive-text)] tabular-nums">
                                Save {formatINR(mrpSav)} off MRP
                              </p>
                            )}
                            {pack === 'kirana' && row.item.base_unit_allow_decimal && (
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <span className="text-[10px] text-[var(--text-muted)]">₹→Wt:</span>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="1"
                                  value={row.looseRsInput}
                                  placeholder="₹ amt"
                                  onChange={(e) => {
                                    const rsVal = e.target.value;
                                    const num = Number(rsVal);
                                    const computed = computeLooseWeightFromAmount(
                                      num,
                                      Number(row.unitPrice || row.item.selling_price),
                                      1
                                    );
                                    updateLine(row.localId, {
                                      looseRsInput: rsVal,
                                      enteredQty:
                                        computed.enteredQty > 0
                                          ? String(computed.enteredQty)
                                          : row.enteredQty,
                                    });
                                  }}
                                  className="w-20 h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] tabular-nums"
                                />
                              </div>
                            )}
                            {batchExpiryEnabled && itemBatches.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                <select
                                  aria-label={`Batch for ${row.item.name}`}
                                  value={row.batchId}
                                  onChange={(e) =>
                                    updateLine(row.localId, { batchId: e.target.value })
                                  }
                                  className="h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] tabular-nums"
                                >
                                  <option value="">Auto FEFO Batch</option>
                                  {itemBatches.map((b) => {
                                    const expStatus = classifyBatchExpiry(
                                      b.expiry_date,
                                      billDate || todayLocalIso()
                                    );
                                    return (
                                      <option
                                        key={b.id}
                                        value={b.id}
                                        disabled={expStatus === 'expired'}
                                      >
                                        {b.batch_no} · Exp {formatDate(b.expiry_date)} · Qty{' '}
                                        {b.qty_on_hand}
                                        {expStatus === 'expired' ? ' (EXPIRED)' : ''}
                                      </option>
                                    );
                                  })}
                                </select>
                                {pack === 'medical' && saltName && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleOpenSubstitutes(row.localId, row.item.id)
                                    }
                                    className="h-7 px-2 rounded border border-[var(--border)] text-[11px] text-[var(--primary-dark)] inline-flex items-center gap-1 hover:bg-[var(--surface-muted)]"
                                  >
                                    <IconArrowsExchange size={12} stroke={2} />
                                    <span>Substitutes</span>
                                  </button>
                                )}
                              </div>
                            )}
                            {variantsEnabled && itemVariants.length > 0 && (
                              <div className="mt-1.5">
                                <select
                                  aria-label={`Variant for ${row.item.name}`}
                                  value={row.variantId}
                                  onChange={(e) =>
                                    updateLine(row.localId, { variantId: e.target.value })
                                  }
                                  className="h-7 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px]"
                                >
                                  <option value="">Select Size / Colour</option>
                                  {itemVariants.map((v) => (
                                    <option key={v.id} value={v.id}>
                                      {v.size} / {v.color} · Qty {v.qty_on_hand}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {hasWarranty && (
                              <div className="mt-1.5">
                                <input
                                  type="text"
                                  value={row.serialNo}
                                  onChange={(e) =>
                                    updateLine(row.localId, { serialNo: e.target.value })
                                  }
                                  placeholder={`Serial # (${row.item.pack_metadata?.warranty_months}m warranty)`}
                                  className="w-44 h-7 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] font-mono"
                                />
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-2">
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0.001"
                              step={row.item.base_unit_allow_decimal ? '0.001' : '1'}
                              value={row.enteredQty}
                              onChange={(e) =>
                                updateLine(row.localId, { enteredQty: e.target.value })
                              }
                              className="w-20 h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs font-medium tabular-nums"
                            />
                          </td>
                          <td className="py-2 px-2">
                            <select
                              value={row.enteredUnitId}
                              onChange={(e) =>
                                updateLine(row.localId, { enteredUnitId: e.target.value })
                              }
                              className="w-20 h-9 px-1.5 rounded border border-[var(--border)] bg-[var(--surface)] text-xs"
                            >
                              {row.unitOptions.map((u) => (
                                <option key={u.unitId} value={u.unitId}>
                                  {u.code}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2">
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="0.01"
                              value={row.unitPrice}
                              onChange={(e) =>
                                updateLine(row.localId, { unitPrice: e.target.value })
                              }
                              className="w-24 h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs font-medium tabular-nums"
                            />
                          </td>
                          <td className="py-2 px-2">
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
                              className="w-16 h-9 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                            />
                          </td>
                          <td className="py-2.5 px-2 text-right tabular-nums text-xs text-[var(--text-muted)] whitespace-nowrap">
                            {calc.gstApplied ? (
                              <>
                                <div>{lineCalc?.effectiveGstRate ?? 0}%</div>
                                <div className="text-[11px]">
                                  {formatINR(lineCalc?.taxAmount ?? 0)}
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-semibold tabular-nums whitespace-nowrap">
                            {formatINR(lineCalc?.lineTotal ?? 0)}
                          </td>
                          <td className="py-2 px-2 text-right">
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
          </div>

          {subTargetLineId && (
            <div className="p-3.5 rounded-xl border border-[var(--primary-dark)]/40 bg-[var(--surface-muted)] space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Same-Salt Substitutes</span>
                <button
                  type="button"
                  onClick={() => {
                    setSubTargetLineId(null);
                    setSubstitutes([]);
                  }}
                  className="text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  Close
                </button>
              </div>
              {loadingSubstitutes ? (
                <p className="text-[var(--text-muted)]">Searching substitutes...</p>
              ) : substitutes.length === 0 ? (
                <p className="text-[var(--text-muted)]">No active in-stock substitutes found for this salt.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {substitutes.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => handleSwapSubstitute(sub)}
                      className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--primary-dark)] text-left"
                    >
                      <div className="font-medium">{sub.name}</div>
                      <div className="text-[11px] text-[var(--text-muted)] tabular-nums">
                        {formatINR(Number(sub.selling_price))} · Stock {sub.qty_on_hand} {sub.base_unit_code}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {requiresPrescription && (
            <div className="p-4 rounded-xl border border-amber-500/40 bg-amber-500/10 space-y-3">
              <p className="text-xs sm:text-sm font-semibold text-amber-800 dark:text-amber-300">
                Schedule H / H1 / X Medicine Prescription Required
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                <input
                  type="text"
                  value={rxPatientName}
                  onChange={(e) => setRxPatientName(e.target.value)}
                  placeholder="Patient Full Name *"
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                />
                <input
                  type="text"
                  value={rxPatientAge}
                  onChange={(e) => setRxPatientAge(e.target.value)}
                  placeholder="Age / Gender (optional)"
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                />
                <input
                  type="tel"
                  value={rxPatientPhone}
                  onChange={(e) => setRxPatientPhone(e.target.value)}
                  placeholder="Patient Phone (optional)"
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                />
                <input
                  type="text"
                  value={rxDoctorName}
                  onChange={(e) => setRxDoctorName(e.target.value)}
                  placeholder="Prescribing Doctor Name *"
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                />
                <input
                  type="text"
                  value={rxDoctorRegNo}
                  onChange={(e) => setRxDoctorRegNo(e.target.value)}
                  placeholder="Doctor Reg. No. (optional)"
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                />
                <input
                  type="text"
                  value={rxNotes}
                  onChange={(e) => setRxNotes(e.target.value)}
                  placeholder="Rx Notes (optional)"
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                />
              </div>
              <FileUpload
                label="Upload Prescription Image / PDF (optional)"
                purpose="prescription"
                value={rxAttachment}
                onChange={setRxAttachment}
              />
            </div>
          )}

          {linePolicyViolations.length > 0 && (
            <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300 space-y-1">
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

          {/* Totals, Charges, Notes & Instant Payment */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 space-y-3">
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
            </div>

            <div className="lg:col-span-5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 space-y-3">
              <dl className="space-y-1.5 text-xs sm:text-sm">
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
                <div className="pt-2 border-t border-[var(--border)] flex justify-between text-base font-semibold">
                  <dt>{t('bills.grandTotal')}</dt>
                  <dd className="tabular-nums">{formatINR(calc.grandTotal)}</dd>
                </div>
              </dl>

              {pack === 'kirana' && totalMrpSavings > 0 && (
                <p className="text-xs font-medium text-[var(--receive-text)] tabular-nums">
                  Customer MRP Savings: {formatINR(totalMrpSavings)}
                </p>
              )}

              <p className="text-[11px] text-[var(--text-muted)] leading-snug">
                {amountInWordsINR(calc.grandTotal)}
              </p>

              {/* Payment Split for Invoices */}
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
                          className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] font-medium"
                        >
                          Full Cash/UPI
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPaidTouched(true);
                            setPaidAmount('0');
                          }}
                          className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[11px] font-medium"
                        >
                          Full Credit (Khata)
                        </button>
                      </div>
                    )}
                  </div>

                  {!partyId ? (
                    <p className="text-xs text-[var(--text-muted)]">
                      {language === 'hi'
                        ? 'वॉक-इन नकद बिल के लिए पूरी राशि अभी प्राप्त मानी जाएगी।'
                        : 'Walk-in cash bill settles the full amount immediately. Select a Party for partial/credit Khata.'}
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
                        className="h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-semibold tabular-nums"
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
                    <div className="flex justify-between text-xs font-medium">
                      <span className="text-[var(--text-muted)]">{t('bills.balanceDue')}</span>
                      <span className="tabular-nums text-[var(--receive-text)]">
                        {formatINR(Math.max(0, roundHalfUp(calc.grandTotal - effectivePaidNumber, 2)))}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-[var(--border)] bg-[var(--surface)] flex flex-wrap items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => handleSubmit('draft')}
            className="h-11 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <IconDeviceFloppy size={17} stroke={2} />
            <span>{t('bills.saveDraft')}</span>
          </button>
          <button
            type="button"
            disabled={submitting || linePolicyViolations.length > 0}
            onClick={() => handleSubmit('issued')}
            className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95 disabled:opacity-50"
          >
            <IconCheck size={17} stroke={2.5} />
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
    </div>
  );
}
