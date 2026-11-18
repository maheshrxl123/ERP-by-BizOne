import {
  IconAlertTriangle,
  IconBriefcase,
  IconCalculator,
  IconCheck,
  IconDownload,
  IconExchange,
  IconFileSpreadsheet,
  IconLoader2,
  IconMapPin,
  IconMedicineSyrup,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconShirt,
  IconTag,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { exportSheetsToBrowser } from '../../core/spreadsheet';
import { supabase } from '../../core/supabase';
import {
  applyDiscountPreset,
  calculateMarginPct,
  calculatePaintLitres,
  calculateServiceJobMargin,
  calculateTileBoxes,
  calculateWireCoils,
  computeAmountFromWeight,
  computeLooseWeightFromAmount,
  computeMrpSavings,
  generateVariantMatrixCombinations,
  getPackWorkflow,
  type VariantMatrixDraftRow,
} from '../../packs/registry';
import type {
  HardwareEstimateRecord,
  ItemCatalogRecord,
  ItemVariantRecord,
  NearExpiryBatchRow,
  PartyBalanceRecord,
  PartyItemRateRecord,
  PartySiteRecord,
  SaltSubstituteRow,
  ScheduleRegisterRecord,
  ServiceJobRecord,
  WarrantyRecord,
} from '../../types/bizone';
import type { AppDestination, NavigationAction } from '../dashboard/HomeScreen';

interface PackWorkspaceScreenProps {
  onNavigate: (
    next: AppDestination,
    settingsTab?: string,
    opts?: {
      partyId?: string | null;
      itemId?: string | null;
      billId?: string | null;
      action?: NavigationAction | null;
    }
  ) => void;
}

export function PackWorkspaceScreen({ onNavigate }: PackWorkspaceScreenProps) {
  const { business, profile, language, showToast, isModuleEnabled } = useApp();
  const pack = business?.pack || 'general_retail';
  const workflow = getPackWorkflow(pack);
  const canManageItems = hasCapability(profile?.role, 'items');
  const canCreateBills = hasCapability(profile?.role, 'create_bills');
  const canViewReports = hasCapability(profile?.role, 'reports');
  const isOwner = profile?.role === 'owner';

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ItemCatalogRecord[]>([]);
  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);

  // Medical states
  const [medicalTab, setMedicalTab] = useState<'expiry' | 'substitutes' | 'schedule'>('expiry');
  const [expiryDays, setExpiryDays] = useState<30 | 60 | 90>(90);
  const [nearExpiryRows, setNearExpiryRows] = useState<NearExpiryBatchRow[]>([]);
  const [subItemId, setSubItemId] = useState('');
  const [substitutes, setSubstitutes] = useState<SaltSubstituteRow[]>([]);
  const [schedFrom, setSchedFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [schedTo, setSchedTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [scheduleRows, setScheduleRows] = useState<ScheduleRegisterRecord[]>([]);
  const [batchFormOpen, setBatchFormOpen] = useState(false);
  const [batchItemId, setBatchItemId] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [batchMfg, setBatchMfg] = useState('');
  const [batchExp, setBatchExp] = useState('');
  const [batchMrp, setBatchMrp] = useState('');
  const [batchSell, setBatchSell] = useState('');
  const [batchQty, setBatchQty] = useState('10');
  const [savingBatch, setSavingBatch] = useState(false);

  // Kirana states
  const [kiranaItemId, setKiranaItemId] = useState('');
  const [kiranaMode, setKiranaMode] = useState<'amount_to_qty' | 'qty_to_amount'>('amount_to_qty');
  const [kiranaInput, setKiranaInput] = useState('100');

  // Clothing states
  const [variantItemId, setVariantItemId] = useState('');
  const [sizesInput, setSizesInput] = useState('S, M, L, XL');
  const [colorsInput, setColorsInput] = useState('Black, Navy, White');
  const [variantRows, setVariantRows] = useState<VariantMatrixDraftRow[]>([]);
  const [allVariants, setAllVariants] = useState<ItemVariantRecord[]>([]);
  const [savingVariants, setSavingVariants] = useState(false);

  // Hardware states
  const [hardwareTab, setHardwareTab] = useState<'estimator' | 'sites' | 'warranties'>('estimator');
  const [calcType, setCalcType] = useState<'tiles' | 'paint' | 'wire'>('tiles');
  const [calcDim1, setCalcDim1] = useState('240'); // area / length
  const [calcDim2, setCalcDim2] = useState('16'); // sqftPerBox / coverage / metersPerCoil
  const [calcExtra, setCalcExtra] = useState('10'); // wastage% / coats
  const [estItemId, setEstItemId] = useState('');
  const [estPartyId, setEstPartyId] = useState('');
  const [estSiteId, setEstSiteId] = useState('');
  const [estTitle, setEstTitle] = useState('');
  const [estimates, setEstimates] = useState<HardwareEstimateRecord[]>([]);
  const [sites, setSites] = useState<PartySiteRecord[]>([]);
  const [sitePartyId, setSitePartyId] = useState('');
  const [siteName, setSiteName] = useState('');
  const [siteContact, setSiteContact] = useState('');
  const [sitePhone, setSitePhone] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [warranties, setWarranties] = useState<WarrantyRecord[]>([]);
  const [savingHw, setSavingHw] = useState(false);

  // Wholesale states
  const [wholesaleTab, setWholesaleTab] = useState<'prices' | 'rates'>('prices');
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [savingPrices, setSavingPrices] = useState(false);
  const [rateCards, setRateCards] = useState<PartyItemRateRecord[]>([]);
  const [rcPartyId, setRcPartyId] = useState('');
  const [rcItemId, setRcItemId] = useState('');
  const [rcPrice, setRcPrice] = useState('');
  const [rcMinQty, setRcMinQty] = useState('1');

  // Service states
  const [jobs, setJobs] = useState<ServiceJobRecord[]>([]);
  const [jobRevenueMap, setJobRevenueMap] = useState<Record<string, { billed: number; expenses: number }>>({});
  const [jobTitle, setJobTitle] = useState('');
  const [jobPartyId, setJobPartyId] = useState('');
  const [jobDueDate, setJobDueDate] = useState('');
  const [jobEstAmt, setJobEstAmt] = useState('');
  const [jobStatus, setJobStatus] = useState<ServiceJobRecord['status']>('open');
  const [jobNotes, setJobNotes] = useState('');
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [savingJob, setSavingJob] = useState(false);

  // General Retail margin preset state
  const [retailDiscountPct, setRetailDiscountPct] = useState('10');

  const loadWorkspaceData = useCallback(async () => {
    setLoading(true);
    try {
      const [itemsRes, partiesRes] = await Promise.all([
        supabase
          .from('item_catalog_view')
          .select('*')
          .eq('is_active', true)
          .order('name', { ascending: true })
          .limit(300),
        isModuleEnabled('parties')
          ? supabase
              .from('party_balances')
              .select('*')
              .eq('is_active', true)
              .order('name', { ascending: true })
              .limit(300)
          : Promise.resolve({ data: [], error: null }),
      ]);

      const loadedItems = (itemsRes.data as ItemCatalogRecord[]) || [];
      const loadedParties = (partiesRes.data as PartyBalanceRecord[]) || [];
      setItems(loadedItems);
      setParties(loadedParties);

      if (loadedItems.length > 0) {
        setKiranaItemId((prev) => prev || loadedItems[0].id);
        setBatchItemId((prev) => prev || loadedItems[0].id);
        setSubItemId((prev) => prev || loadedItems[0].id);
        setVariantItemId((prev) => prev || loadedItems[0].id);
        setEstItemId((prev) => prev || loadedItems[0].id);
        setRcItemId((prev) => prev || loadedItems[0].id);
      }
      if (loadedParties.length > 0) {
        setEstPartyId((prev) => prev || loadedParties[0].party_id);
        setSitePartyId((prev) => prev || loadedParties[0].party_id);
        setRcPartyId((prev) => prev || loadedParties[0].party_id);
        setJobPartyId((prev) => prev || loadedParties[0].party_id);
      }

      if (pack === 'medical') {
        const [expRes, schedRes] = await Promise.all([
          supabase.rpc('get_near_expiry_batches', { p_days: expiryDays }),
          supabase.rpc('get_schedule_register', { p_from: schedFrom, p_to: schedTo }),
        ]);
        if (!expRes.error) setNearExpiryRows((expRes.data as NearExpiryBatchRow[]) || []);
        if (!schedRes.error) setScheduleRows((schedRes.data as ScheduleRegisterRecord[]) || []);
      } else if (pack === 'clothing') {
        const { data: varData } = await supabase
          .from('item_variants')
          .select('*')
          .order('size', { ascending: true })
          .limit(400);
        setAllVariants((varData as ItemVariantRecord[]) || []);
      } else if (pack === 'hardware') {
        const [estRes, sitesRes, warRes] = await Promise.all([
          supabase.from('hardware_estimates').select('*').order('created_at', { ascending: false }).limit(50),
          supabase.from('party_sites').select('*').order('site_name', { ascending: true }).limit(200),
          supabase.from('warranty_records').select('*').order('created_at', { ascending: false }).limit(100),
        ]);
        setEstimates((estRes.data as HardwareEstimateRecord[]) || []);
        setSites((sitesRes.data as PartySiteRecord[]) || []);
        setWarranties((warRes.data as WarrantyRecord[]) || []);
      } else if (pack === 'wholesale') {
        const { data: rcData } = await supabase
          .from('party_item_rates')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        setRateCards((rcData as PartyItemRateRecord[]) || []);
      } else if (pack === 'service') {
        const [jobsRes, billsRes, expRes] = await Promise.all([
          supabase.from('service_jobs').select('*').order('created_at', { ascending: false }).limit(100),
          supabase.from('bills').select('job_id, grand_total, status, doc_type').not('job_id', 'is', null),
          supabase.from('expenses').select('job_id, amount, status').not('job_id', 'is', null),
        ]);
        setJobs((jobsRes.data as ServiceJobRecord[]) || []);
        const map: Record<string, { billed: number; expenses: number }> = {};
        for (const b of billsRes.data || []) {
          if (b.job_id && b.status === 'issued' && (b.doc_type === 'tax_invoice' || b.doc_type === 'bill_of_supply')) {
            if (!map[b.job_id]) map[b.job_id] = { billed: 0, expenses: 0 };
            map[b.job_id].billed += Number(b.grand_total || 0);
          }
        }
        for (const e of expRes.data || []) {
          if (e.job_id && e.status === 'posted') {
            if (!map[e.job_id]) map[e.job_id] = { billed: 0, expenses: 0 };
            map[e.job_id].expenses += Number(e.amount || 0);
          }
        }
        setJobRevenueMap(map);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to load pack workspace.', 'error');
    } finally {
      setLoading(false);
    }
  }, [pack, expiryDays, schedFrom, schedTo, isModuleEnabled, showToast]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData]);

  // Load salt substitutes when selected medical item changes
  useEffect(() => {
    if (pack !== 'medical' || !subItemId) return;
    supabase.rpc('get_salt_substitutes', { p_item_id: subItemId }).then(({ data }) => {
      setSubstitutes((data as SaltSubstituteRow[]) || []);
    });
  }, [pack, subItemId]);

  // Sync Clothing draft rows when selected item changes
  useEffect(() => {
    if (pack !== 'clothing' || !variantItemId) return;
    const existing = allVariants.filter((v) => v.item_id === variantItemId);
    if (existing.length > 0) {
      setVariantRows(
        existing.map((v) => ({
          size: v.size,
          color: v.color,
          sku: v.sku || '',
          barcode: v.barcode || '',
          selling_price: Number(v.selling_price ?? 0),
          mrp: v.mrp != null ? Number(v.mrp) : null,
          purchase_price: v.purchase_price != null ? Number(v.purchase_price) : null,
          qty_on_hand: Number(v.qty_on_hand || 0),
          is_active: v.is_active,
        }))
      );
    } else {
      setVariantRows([]);
    }
  }, [pack, variantItemId, allVariants]);

  const selectedKiranaItem = useMemo(
    () => items.find((i) => i.id === kiranaItemId) || null,
    [items, kiranaItemId]
  );

  const kiranaCalc = useMemo(() => {
    if (!selectedKiranaItem) return null;
    const val = Number(kiranaInput || 0);
    if (kiranaMode === 'amount_to_qty') {
      const res = computeLooseWeightFromAmount(val, selectedKiranaItem.selling_price, 1);
      const savings = computeMrpSavings(selectedKiranaItem.mrp, selectedKiranaItem.selling_price, res.enteredQty);
      return { ...res, savings };
    }
    const actualAmount = computeAmountFromWeight(val, selectedKiranaItem.selling_price, 1);
    const savings = computeMrpSavings(selectedKiranaItem.mrp, selectedKiranaItem.selling_price, val);
    return { enteredQty: val, baseQty: val, actualAmount, savings };
  }, [selectedKiranaItem, kiranaMode, kiranaInput]);

  const hardwarePreview = useMemo(() => {
    const d1 = Number(calcDim1 || 0);
    const d2 = Number(calcDim2 || 0);
    const ex = Number(calcExtra || 0);
    if (calcType === 'tiles') {
      const r = calculateTileBoxes(d1, d2, ex);
      return {
        qtyNeeded: r.boxesNeeded,
        unitLabel: 'Boxes',
        detail: `${r.totalSqFtWithWastage} sq.ft incl. ${ex}% wastage · covers ${r.actualCoveredSqFt} sq.ft`,
      };
    }
    if (calcType === 'paint') {
      const r = calculatePaintLitres(d1, ex || 2, d2 || 110);
      return {
        qtyNeeded: r.litresNeeded,
        unitLabel: 'Litres',
        detail: `${r.totalSqFtToCoat} sq.ft total coat area`,
      };
    }
    const r = calculateWireCoils(d1, d2 || 90);
    return {
      qtyNeeded: r.coilsNeeded,
      unitLabel: 'Coils',
      detail: `${r.surplusMeters} m spare wire after cut`,
    };
  }, [calcType, calcDim1, calcDim2, calcExtra]);

  // Handlers
  const handleSaveBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchItemId || !batchNo.trim() || !batchExp) return;
    setSavingBatch(true);
    try {
      const { error } = await supabase.rpc('save_item_batch', {
        p_item_id: batchItemId,
        p_batch_no: batchNo.trim(),
        p_expiry_date: batchExp,
        p_mfg_date: batchMfg || null,
        p_mrp: batchMrp ? Number(batchMrp) : null,
        p_purchase_rate: null,
        p_selling_rate: batchSell ? Number(batchSell) : null,
        p_qty_delta: Number(batchQty || 0),
        p_batch_id: null,
        p_is_active: true,
      });
      if (error) throw error;
      showToast('Batch stock saved.', 'success');
      setBatchFormOpen(false);
      setBatchNo('');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save batch.', 'error');
    } finally {
      setSavingBatch(false);
    }
  };

  const handleGenerateVariantMatrix = () => {
    const item = items.find((i) => i.id === variantItemId);
    if (!item) return;
    const generated = generateVariantMatrixCombinations({
      sizes: sizesInput.split(','),
      colors: colorsInput.split(','),
      baseSku: item.sku || item.name.slice(0, 6),
      sellingPrice: Number(item.selling_price || 0),
      mrp: item.mrp ?? null,
      purchasePrice: item.purchase_price ?? null,
      defaultQty: 5,
    });
    setVariantRows(generated);
  };

  const handleSaveVariants = async () => {
    if (!variantItemId || variantRows.length === 0) return;
    setSavingVariants(true);
    try {
      const { error } = await supabase.rpc('save_variant_matrix', {
        p_item_id: variantItemId,
        p_variants: variantRows,
      });
      if (error) throw error;
      showToast(`Saved ${variantRows.length} variants.`, 'success');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save variants.', 'error');
    } finally {
      setSavingVariants(false);
    }
  };

  const handleSaveEstimate = async () => {
    const item = items.find((i) => i.id === estItemId);
    if (!item) {
      showToast('Select a material item for the estimate.', 'error');
      return;
    }
    const qty = Math.max(1, hardwarePreview.qtyNeeded);
    const estTotal = Number((qty * item.selling_price).toFixed(2));
    setSavingHw(true);
    try {
      const { error } = await supabase.rpc('save_hardware_estimate', {
        p_title: estTitle.trim() || `${calcType.toUpperCase()} Estimate · ${item.name}`,
        p_party_id: estPartyId || null,
        p_site_id: estSiteId || null,
        p_calc_inputs: {
          calcType,
          dim1: Number(calcDim1 || 0),
          dim2: Number(calcDim2 || 0),
          extra: Number(calcExtra || 0),
          result: hardwarePreview,
        },
        p_lines: [
          {
            item_id: item.id,
            entered_qty: qty,
            entered_unit_id: item.base_unit_id,
            unit_price: item.selling_price,
            discount_pct: 0,
            tax_inclusive: item.tax_inclusive,
          },
        ],
        p_estimated_total: estTotal,
        p_notes: hardwarePreview.detail,
        p_id: null,
      });
      if (error) throw error;
      showToast('Estimate saved.', 'success');
      setEstTitle('');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save estimate.', 'error');
    } finally {
      setSavingHw(false);
    }
  };

  const handleConvertEstimate = async (estId: string) => {
    setSavingHw(true);
    try {
      const { data, error } = await supabase.rpc('convert_estimate_to_quotation', {
        p_estimate_id: estId,
      });
      if (error) throw error;
      showToast('Converted to quotation.', 'success');
      await loadWorkspaceData();
      if (data?.id) {
        onNavigate('bills', undefined, { billId: data.id });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Conversion failed.', 'error');
    } finally {
      setSavingHw(false);
    }
  };

  const handleSaveSite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sitePartyId || !siteName.trim()) return;
    setSavingHw(true);
    try {
      const { error } = await supabase.rpc('save_party_site', {
        p_party_id: sitePartyId,
        p_site_name: siteName.trim(),
        p_contact_name: siteContact.trim() || null,
        p_contact_phone: sitePhone.trim() || null,
        p_address: siteAddress.trim() || null,
        p_site_id: null,
        p_is_active: true,
      });
      if (error) throw error;
      showToast('Contractor site added.', 'success');
      setSiteName('');
      setSiteContact('');
      setSitePhone('');
      setSiteAddress('');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to add site.', 'error');
    } finally {
      setSavingHw(false);
    }
  };

  const handleClaimWarranty = async (w: WarrantyRecord) => {
    try {
      const { error } = await supabase.rpc('update_warranty_claim', {
        p_warranty_id: w.id,
        p_status: w.status === 'active' ? 'claimed' : 'replaced',
        p_claim_notes: `Updated via Pack Workspace on ${new Date().toISOString().slice(0, 10)}`,
      });
      if (error) throw error;
      showToast('Warranty status updated.', 'success');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to update warranty.', 'error');
    }
  };

  const handleSaveBulkPrices = async () => {
    const updates = Object.entries(priceEdits)
      .filter(([, val]) => val !== '' && Number.isFinite(Number(val)) && Number(val) >= 0)
      .map(([item_id, val]) => ({
        item_id,
        selling_price: Number(val),
      }));
    if (updates.length === 0) {
      showToast('Edit at least one price before saving.', 'info');
      return;
    }
    setSavingPrices(true);
    try {
      const { data, error } = await supabase.rpc('bulk_update_item_prices', {
        p_updates: updates,
      });
      if (error) throw error;
      showToast(`Updated ${data} item price(s).`, 'success');
      setPriceEdits({});
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Bulk update failed.', 'error');
    } finally {
      setSavingPrices(false);
    }
  };

  const handleSaveRateCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rcPartyId || !rcItemId || !rcPrice) return;
    try {
      const { error } = await supabase.rpc('save_party_item_rate', {
        p_party_id: rcPartyId,
        p_item_id: rcItemId,
        p_custom_rate: Number(rcPrice),
        p_min_qty: Number(rcMinQty || 1),
      });
      if (error) throw error;
      showToast('Negotiated rate card saved.', 'success');
      setRcPrice('');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save rate card.', 'error');
    }
  };

  const handleSaveJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jobTitle.trim()) return;
    setSavingJob(true);
    try {
      const { error } = await supabase.rpc('save_service_job', {
        p_title: jobTitle.trim(),
        p_party_id: jobPartyId || null,
        p_description: null,
        p_status: jobStatus,
        p_start_date: new Date().toISOString().slice(0, 10),
        p_due_date: jobDueDate || null,
        p_estimated_amount: Number(jobEstAmt || 0),
        p_notes: jobNotes.trim() || null,
        p_id: editingJobId,
      });
      if (error) throw error;
      showToast(editingJobId ? 'Job updated.' : 'Service job created.', 'success');
      setJobTitle('');
      setJobEstAmt('');
      setJobNotes('');
      setEditingJobId(null);
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save job.', 'error');
    } finally {
      setSavingJob(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[var(--border)]">
        <div>
          <p className="text-xs font-medium text-[var(--primary-dark)] uppercase tracking-wider">
            {business?.pack?.replace('_', ' ')} pack
          </p>
          <h1 className="text-xl sm:text-2xl font-bold mt-0.5">
            {language === 'hi' ? workflow.workspaceLabelHi : workflow.workspaceLabelEn}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-1">
            {language === 'hi' ? workflow.summaryHi : workflow.summaryEn}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadWorkspaceData()}
            className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <IconRefresh size={15} stroke={2} />
            <span>{language === 'hi' ? 'रीफ्रेश' : 'Refresh'}</span>
          </button>
          {canViewReports && isModuleEnabled('reports') && (
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium whitespace-nowrap shrink-0"
            >
              {language === 'hi' ? 'पैक रिपोर्ट्स' : 'Pack Reports'}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              onClick={() => onNavigate('settings', 'business')}
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <IconExchange size={15} stroke={2} />
              <span>{language === 'hi' ? 'पैक बदलें / डेमो' : 'Switch Pack / Demo'}</span>
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-12 flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
          <IconLoader2 size={18} stroke={2} className="animate-spin" />
          <span>Loading pack workspace...</span>
        </div>
      ) : (
        <>
          {/* 1. KIRANA WORKSPACE */}
          {pack === 'kirana' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <section className="lg:col-span-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <IconCalculator size={18} stroke={2} className="text-[var(--primary-dark)]" />
                  <h2 className="text-sm font-semibold">
                    {language === 'hi' ? 'खुला वजन (₹ <-> वजन) कैलकुलेटर' : 'Loose Weight (₹ <-> Qty) Counter'}
                  </h2>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">Select Item</label>
                    <select
                      value={kiranaItemId}
                      onChange={(e) => setKiranaItemId(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    >
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name} ({formatINR(it.selling_price)}/{it.base_unit_code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setKiranaMode('amount_to_qty')}
                      className={`h-9 rounded-lg border text-xs font-medium ${
                        kiranaMode === 'amount_to_qty'
                          ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                          : 'bg-[var(--surface)] border-[var(--border)]'
                      }`}
                    >
                      Customer pays ₹ → Weight
                    </button>
                    <button
                      type="button"
                      onClick={() => setKiranaMode('qty_to_amount')}
                      className={`h-9 rounded-lg border text-xs font-medium ${
                        kiranaMode === 'qty_to_amount'
                          ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                          : 'bg-[var(--surface)] border-[var(--border)]'
                      }`}
                    >
                      Weight → Amount ₹
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {kiranaMode === 'amount_to_qty'
                        ? 'Customer Budget Amount (₹)'
                        : `Weight / Quantity (${selectedKiranaItem?.base_unit_code || 'kg'})`}
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      value={kiranaInput}
                      onChange={(e) => setKiranaInput(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                    />
                  </div>
                  {kiranaCalc && selectedKiranaItem && (
                    <div className="p-4 rounded-lg bg-[var(--surface-muted)] space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Quantity to Weigh</span>
                        <span className="font-bold text-sm tabular-nums">
                          {kiranaCalc.enteredQty} {selectedKiranaItem.base_unit_code}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Billable Amount</span>
                        <span className="font-bold text-sm tabular-nums text-[var(--primary-dark)]">
                          {formatINR(kiranaCalc.actualAmount)}
                        </span>
                      </div>
                      {kiranaCalc.savings > 0 && (
                        <div className="flex justify-between text-[var(--receive-text)]">
                          <span>Customer MRP Savings</span>
                          <span className="font-semibold tabular-nums">{formatINR(kiranaCalc.savings)} saved</span>
                        </div>
                      )}
                    </div>
                  )}
                  {canCreateBills && (
                    <button
                      type="button"
                      onClick={() => onNavigate('bills', undefined, { action: 'new-bill' })}
                      className="w-full h-10 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-white text-xs font-semibold"
                    >
                      Open Counter Billing
                    </button>
                  )}
                </div>
              </section>

              <section className="lg:col-span-7 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Kirana Margin & Loose-Weight Catalog</h2>
                  <span className="text-xs text-[var(--text-muted)] tabular-nums">{items.length} items</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                        <th className="py-2.5 px-4">Item</th>
                        <th className="py-2.5 px-4 text-right">MRP</th>
                        <th className="py-2.5 px-4 text-right">Selling</th>
                        <th className="py-2.5 px-4 text-right">Savings</th>
                        <th className="py-2.5 px-4 text-right">Stock</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {items.slice(0, 25).map((it) => {
                        const mrpSave = it.mrp && it.mrp > it.selling_price ? it.mrp - it.selling_price : 0;
                        return (
                          <tr key={it.id}>
                            <td className="py-2.5 px-4 font-medium">
                              {it.name}
                              {it.pack_metadata?.shelf && (
                                <span className="text-[var(--text-muted)] font-normal"> · {String(it.pack_metadata.shelf)}</span>
                              )}
                            </td>
                            <td className="py-2.5 px-4 text-right tabular-nums text-[var(--text-muted)]">
                              {it.mrp ? formatINR(it.mrp) : '—'}
                            </td>
                            <td className="py-2.5 px-4 text-right tabular-nums font-medium">
                              {formatINR(it.selling_price)}/{it.base_unit_code}
                            </td>
                            <td className="py-2.5 px-4 text-right tabular-nums text-[var(--receive-text)]">
                              {mrpSave > 0 ? formatINR(mrpSave) : '—'}
                            </td>
                            <td className="py-2.5 px-4 text-right tabular-nums">
                              {it.qty_on_hand} {it.base_unit_code}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {/* 2. MEDICAL STORE WORKSPACE */}
          {pack === 'medical' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  {[
                    { key: 'expiry', label: 'Batches & Near-Expiry' },
                    { key: 'substitutes', label: 'Salt Substitutes' },
                    { key: 'schedule', label: 'Schedule H / H1 Register' },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setMedicalTab(tab.key as typeof medicalTab)}
                      className={`h-9 px-3.5 rounded-lg border text-xs font-medium whitespace-nowrap shrink-0 ${
                        medicalTab === tab.key
                          ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                          : 'bg-[var(--surface)] border-[var(--border)] hover:bg-[var(--surface-muted)]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                {canManageItems && (
                  <button
                    type="button"
                    onClick={() => setBatchFormOpen((v) => !v)}
                    className="h-9 px-3.5 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-white text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    <IconPlus size={15} stroke={2} />
                    <span>Add / Update Batch</span>
                  </button>
                )}
              </div>

              {batchFormOpen && canManageItems && (
                <form
                  onSubmit={handleSaveBatch}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-7 gap-3 items-end"
                >
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium mb-1">Medicine</label>
                    <select
                      value={batchItemId}
                      onChange={(e) => setBatchItemId(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>{it.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Batch No *</label>
                    <input
                      required
                      value={batchNo}
                      onChange={(e) => setBatchNo(e.target.value)}
                      placeholder="B-2601"
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs uppercase"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Expiry Date *</label>
                    <input
                      required
                      type="date"
                      value={batchExp}
                      onChange={(e) => setBatchExp(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">MRP / Rate</label>
                    <input
                      type="number"
                      step="0.01"
                      value={batchMrp}
                      onChange={(e) => {
                        setBatchMrp(e.target.value);
                        if (!batchSell) setBatchSell(e.target.value);
                      }}
                      placeholder="MRP ₹"
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Qty Delta</label>
                    <input
                      type="number"
                      step="0.001"
                      value={batchQty}
                      onChange={(e) => setBatchQty(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={savingBatch}
                    className="h-9 px-4 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {savingBatch ? 'Saving...' : 'Save Batch'}
                  </button>
                </form>
              )}

              {medicalTab === 'expiry' && (
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)] flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <IconAlertTriangle size={16} stroke={2} className="text-amber-600" />
                      <h2 className="text-sm font-semibold">Expired & Near-Expiry Batches</h2>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {([30, 60, 90] as const).map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setExpiryDays(d)}
                          className={`h-7 px-2.5 rounded border text-xs font-medium tabular-nums ${
                            expiryDays === d
                              ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                              : 'bg-[var(--surface)] border-[var(--border)]'
                          }`}
                        >
                          ≤ {d} days
                        </button>
                      ))}
                    </div>
                  </div>
                  {nearExpiryRows.length === 0 ? (
                    <div className="p-6 text-xs text-[var(--text-muted)]">
                      No expired or near-expiry batches within {expiryDays} days.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                            <th className="py-2.5 px-4">Medicine & Salt</th>
                            <th className="py-2.5 px-4">Batch</th>
                            <th className="py-2.5 px-4">Expiry</th>
                            <th className="py-2.5 px-4 text-right">Days Left</th>
                            <th className="py-2.5 px-4 text-right">Stock</th>
                            <th className="py-2.5 px-4 text-right">Cost Value</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border)]">
                          {nearExpiryRows.map((row) => (
                            <tr key={row.id}>
                              <td className="py-2.5 px-4">
                                <div className="font-medium">{row.item_name}</div>
                                <div className="text-[var(--text-muted)]">
                                  {row.salt_name || 'No salt mapped'}
                                  {row.schedule_class ? ` · Sch ${row.schedule_class}` : ''}
                                </div>
                              </td>
                              <td className="py-2.5 px-4 font-mono">{row.batch_no}</td>
                              <td className="py-2.5 px-4 tabular-nums">{formatDate(row.expiry_date)}</td>
                              <td
                                className={`py-2.5 px-4 text-right tabular-nums font-semibold ${
                                  row.is_expired ? 'text-[var(--give)]' : 'text-amber-600'
                                }`}
                              >
                                {row.is_expired ? `Expired (${row.days_to_expiry}d)` : `${row.days_to_expiry}d`}
                              </td>
                              <td className="py-2.5 px-4 text-right tabular-nums">{row.qty_on_hand}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums">{formatINR(row.stock_cost_value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}

              {medicalTab === 'substitutes' && (
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <IconMedicineSyrup size={18} stroke={2} className="text-[var(--primary-dark)]" />
                    <h2 className="text-sm font-semibold">Same-Salt Substitute Lookup</h2>
                  </div>
                  <select
                    value={subItemId}
                    onChange={(e) => setSubItemId(e.target.value)}
                    className="w-full sm:max-w-md h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  >
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} {it.pack_metadata?.salt ? `(${String(it.pack_metadata.salt)})` : ''}
                      </option>
                    ))}
                  </select>
                  {substitutes.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">
                      No alternate medicines sharing the exact same Salt composition found in active inventory.
                    </p>
                  ) : (
                    <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                      {substitutes.map((s) => (
                        <div key={s.id} className="p-3 flex items-center justify-between text-xs">
                          <div>
                            <p className="font-semibold text-sm">{s.name}</p>
                            <p className="text-[var(--text-muted)]">
                              {s.salt_name} {s.manufacturer ? `· ${s.manufacturer}` : ''}
                            </p>
                          </div>
                          <div className="text-right tabular-nums">
                            <p className="font-semibold">{formatINR(s.selling_price)}</p>
                            <p className="text-[var(--text-muted)]">
                              Stock: {s.qty_on_hand} {s.base_unit_code}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {medicalTab === 'schedule' && (
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)] flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">Schedule H / H1 Compliance Register</h2>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="date"
                        value={schedFrom}
                        onChange={(e) => setSchedFrom(e.target.value)}
                        className="h-8 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs"
                      />
                      <input
                        type="date"
                        value={schedTo}
                        onChange={(e) => setSchedTo(e.target.value)}
                        className="h-8 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          exportSheetsToBrowser(
                            `schedule-register-${schedFrom}-to-${schedTo}`,
                            [
                              {
                                name: 'Schedule Register',
                                headers: ['Sale Date', 'Bill No', 'Medicine', 'Salt', 'Schedule', 'Batch', 'Qty', 'Patient', 'Doctor', 'Doctor Reg No'],
                                rows: scheduleRows.map((r) => [
                                  r.sale_date,
                                  r.bill_number || '',
                                  r.item_name,
                                  r.salt_name || '',
                                  r.schedule_class,
                                  r.batch_no || '',
                                  `${r.qty} ${r.unit_code}`,
                                  r.patient_name || '',
                                  r.doctor_name || '',
                                  r.doctor_reg_no || '',
                                ]),
                              },
                            ],
                            'xlsx'
                          )
                        }
                        className="h-8 px-3 rounded border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1"
                      >
                        <IconDownload size={14} stroke={2} />
                        <span>XLSX</span>
                      </button>
                    </div>
                  </div>
                  {scheduleRows.length === 0 ? (
                    <div className="p-6 text-xs text-[var(--text-muted)]">
                      No Schedule H / H1 sales recorded in this date range.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                            <th className="py-2.5 px-4">Date & Bill</th>
                            <th className="py-2.5 px-4">Medicine (Sch)</th>
                            <th className="py-2.5 px-4">Batch / Qty</th>
                            <th className="py-2.5 px-4">Patient</th>
                            <th className="py-2.5 px-4">Prescribing Doctor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border)]">
                          {scheduleRows.map((r) => (
                            <tr key={r.id}>
                              <td className="py-2.5 px-4 tabular-nums">
                                <div className="font-medium">{r.bill_number}</div>
                                <div className="text-[var(--text-muted)]">{formatDate(r.sale_date)}</div>
                              </td>
                              <td className="py-2.5 px-4">
                                <div className="font-medium">{r.item_name} · Sch {r.schedule_class}</div>
                                <div className="text-[var(--text-muted)]">{r.salt_name || '—'}</div>
                              </td>
                              <td className="py-2.5 px-4 tabular-nums">
                                {r.batch_no || '—'} · {r.qty} {r.unit_code}
                              </td>
                              <td className="py-2.5 px-4">{r.patient_name || '—'}</td>
                              <td className="py-2.5 px-4">
                                {r.doctor_name || '—'}
                                {r.doctor_reg_no ? ` (${r.doctor_reg_no})` : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {/* 3. CLOTHING WORKSPACE */}
          {pack === 'clothing' && (
            <div className="space-y-5">
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <IconShirt size={18} stroke={2} className="text-[var(--primary-dark)]" />
                  <h2 className="text-sm font-semibold">Size × Colour Variant Matrix Generator</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium mb-1">Apparel Item</label>
                    <select
                      value={variantItemId}
                      onChange={(e) => setVariantItemId(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    >
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>{it.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Sizes (comma separated)</label>
                    <input
                      value={sizesInput}
                      onChange={(e) => setSizesInput(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Colours (comma separated)</label>
                    <input
                      value={colorsInput}
                      onChange={(e) => setColorsInput(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canManageItems && (
                    <button
                      type="button"
                      onClick={handleGenerateVariantMatrix}
                      className="h-9 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold"
                    >
                      Generate Size × Colour Grid
                    </button>
                  )}
                  {canManageItems && variantRows.length > 0 && (
                    <button
                      type="button"
                      disabled={savingVariants}
                      onClick={() => void handleSaveVariants()}
                      className="h-9 px-4 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-white text-xs font-semibold disabled:opacity-50"
                    >
                      {savingVariants ? 'Saving Matrix...' : `Save ${variantRows.length} Variants`}
                    </button>
                  )}
                </div>

                {variantRows.length > 0 && (
                  <div className="overflow-x-auto border border-[var(--border)] rounded-lg">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-left text-[var(--text-muted)]">
                          <th className="py-2 px-3">Size</th>
                          <th className="py-2 px-3">Colour</th>
                          <th className="py-2 px-3">Variant SKU</th>
                          <th className="py-2 px-3">Selling Price</th>
                          <th className="py-2 px-3">MRP</th>
                          <th className="py-2 px-3">Qty on Hand</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {variantRows.map((row, idx) => (
                          <tr key={`${row.size}-${row.color}-${idx}`}>
                            <td className="py-2 px-3 font-medium">{row.size}</td>
                            <td className="py-2 px-3">{row.color}</td>
                            <td className="py-2 px-3">
                              <input
                                value={row.sku}
                                onChange={(e) =>
                                  setVariantRows((prev) =>
                                    prev.map((r, i) => (i === idx ? { ...r, sku: e.target.value } : r))
                                  )
                                }
                                className="h-8 px-2 w-40 rounded border border-[var(--border)] bg-[var(--surface)] font-mono text-xs"
                              />
                            </td>
                            <td className="py-2 px-3">
                              <input
                                type="number"
                                step="0.01"
                                value={row.selling_price}
                                onChange={(e) =>
                                  setVariantRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, selling_price: Number(e.target.value || 0) } : r
                                    )
                                  )
                                }
                                className="h-8 px-2 w-24 rounded border border-[var(--border)] bg-[var(--surface)] tabular-nums text-xs"
                              />
                            </td>
                            <td className="py-2 px-3">
                              <input
                                type="number"
                                step="0.01"
                                value={row.mrp ?? ''}
                                onChange={(e) =>
                                  setVariantRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, mrp: e.target.value ? Number(e.target.value) : null } : r
                                    )
                                  )
                                }
                                className="h-8 px-2 w-24 rounded border border-[var(--border)] bg-[var(--surface)] tabular-nums text-xs"
                              />
                            </td>
                            <td className="py-2 px-3">
                              <input
                                type="number"
                                step="1"
                                value={row.qty_on_hand}
                                onChange={(e) =>
                                  setVariantRows((prev) =>
                                    prev.map((r, i) =>
                                      i === idx ? { ...r, qty_on_hand: Number(e.target.value || 0) } : r
                                    )
                                  )
                                }
                                className="h-8 px-2 w-20 rounded border border-[var(--border)] bg-[var(--surface)] tabular-nums text-xs"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* 4. HARDWARE WORKSPACE */}
          {pack === 'hardware' && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {[
                  { key: 'estimator', label: 'Tile / Paint / Wire Estimator', icon: IconCalculator },
                  { key: 'sites', label: `Contractor Sites (${sites.length})`, icon: IconMapPin },
                  { key: 'warranties', label: `Warranties (${warranties.length})`, icon: IconShieldCheck },
                ].map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setHardwareTab(tab.key as typeof hardwareTab)}
                      className={`h-9 px-3.5 rounded-lg border text-xs font-medium inline-flex items-center gap-1.5 ${
                        hardwareTab === tab.key
                          ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                          : 'bg-[var(--surface)] border-[var(--border)] hover:bg-[var(--surface-muted)]'
                      }`}
                    >
                      <Icon size={15} stroke={2} />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {hardwareTab === 'estimator' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  <section className="lg:col-span-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                    <h2 className="text-sm font-semibold">Material Requirement Calculator</h2>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { k: 'tiles', label: 'Tiles (Boxes)' },
                        { k: 'paint', label: 'Paint (Litres)' },
                        { k: 'wire', label: 'Wire (Coils)' },
                      ].map((m) => (
                        <button
                          key={m.k}
                          type="button"
                          onClick={() => {
                            setCalcType(m.k as typeof calcType);
                            if (m.k === 'tiles') {
                              setCalcDim1('240');
                              setCalcDim2('16');
                              setCalcExtra('10');
                            } else if (m.k === 'paint') {
                              setCalcDim1('800');
                              setCalcDim2('110');
                              setCalcExtra('2');
                            } else {
                              setCalcDim1('250');
                              setCalcDim2('90');
                              setCalcExtra('0');
                            }
                          }}
                          className={`h-9 rounded-lg border text-xs font-medium ${
                            calcType === m.k
                              ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                              : 'bg-[var(--surface)] border-[var(--border)]'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-xs font-medium mb-1">
                          {calcType === 'wire' ? 'Length (m)' : 'Area (sq.ft)'}
                        </label>
                        <input
                          type="number"
                          value={calcDim1}
                          onChange={(e) => setCalcDim1(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">
                          {calcType === 'tiles'
                            ? 'Sq.ft / Box'
                            : calcType === 'paint'
                              ? 'Sq.ft / Litre'
                              : 'Metres / Coil'}
                        </label>
                        <input
                          type="number"
                          value={calcDim2}
                          onChange={(e) => setCalcDim2(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                        />
                      </div>
                      {calcType !== 'wire' && (
                        <div>
                          <label className="block text-xs font-medium mb-1">
                            {calcType === 'tiles' ? 'Wastage %' : 'Coats'}
                          </label>
                          <input
                            type="number"
                            value={calcExtra}
                            onChange={(e) => setCalcExtra(e.target.value)}
                            className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                          />
                        </div>
                      )}
                    </div>
                    <div className="p-3.5 rounded-lg bg-[var(--surface-muted)] space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Required Quantity</span>
                        <span className="font-bold text-sm tabular-nums text-[var(--primary-dark)]">
                          {hardwarePreview.qtyNeeded} {hardwarePreview.unitLabel}
                        </span>
                      </div>
                      <p className="text-[var(--text-muted)]">{hardwarePreview.detail}</p>
                    </div>
                    <div className="space-y-2.5 pt-2 border-t border-[var(--border)]">
                      <input
                        value={estTitle}
                        onChange={(e) => setEstTitle(e.target.value)}
                        placeholder="Estimate Title (e.g. Living Room Flooring)"
                        className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      />
                      <select
                        value={estItemId}
                        onChange={(e) => setEstItemId(e.target.value)}
                        className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      >
                        {items.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name} ({formatINR(it.selling_price)}/{it.base_unit_code})
                          </option>
                        ))}
                      </select>
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={estPartyId}
                          onChange={(e) => setEstPartyId(e.target.value)}
                          className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                        >
                          <option value="">Walk-in Customer</option>
                          {parties.map((p) => (
                            <option key={p.party_id} value={p.party_id}>{p.name}</option>
                          ))}
                        </select>
                        <select
                          value={estSiteId}
                          onChange={(e) => setEstSiteId(e.target.value)}
                          className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                        >
                          <option value="">No Site</option>
                          {sites
                            .filter((s) => !estPartyId || s.party_id === estPartyId)
                            .map((s) => (
                              <option key={s.id} value={s.id}>{s.site_name}</option>
                            ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        disabled={savingHw}
                        onClick={() => void handleSaveEstimate()}
                        className="w-full h-9 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-white text-xs font-semibold disabled:opacity-50"
                      >
                        {savingHw ? 'Saving...' : 'Save Material Estimate'}
                      </button>
                    </div>
                  </section>

                  <section className="lg:col-span-7 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                      <h2 className="text-sm font-semibold">Saved Project Estimates</h2>
                    </div>
                    {estimates.length === 0 ? (
                      <div className="p-6 text-xs text-[var(--text-muted)]">No saved material estimates yet.</div>
                    ) : (
                      <div className="divide-y divide-[var(--border)]">
                        {estimates.map((est) => (
                          <div key={est.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                            <div>
                              <p className="font-semibold text-sm">{est.title}</p>
                              <p className="text-[var(--text-muted)]">
                                {est.estimate_number} · {est.party_name}
                                {est.site_name ? ` · Site: ${est.site_name}` : ''}
                              </p>
                              {est.notes && <p className="text-[var(--text-muted)] mt-0.5">{est.notes}</p>}
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-bold text-sm tabular-nums">{formatINR(est.estimated_total)}</span>
                              {est.status === 'open' && canCreateBills ? (
                                <button
                                  type="button"
                                  disabled={savingHw}
                                  onClick={() => void handleConvertEstimate(est.id)}
                                  className="h-8 px-3 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold"
                                >
                                  Convert → Quotation
                                </button>
                              ) : (
                                <span className="text-[var(--receive-text)] font-medium uppercase">{est.status}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              )}

              {hardwareTab === 'sites' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  <form
                    onSubmit={handleSaveSite}
                    className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
                  >
                    <h2 className="text-sm font-semibold">Add Contractor / Delivery Site</h2>
                    <select
                      required
                      value={sitePartyId}
                      onChange={(e) => setSitePartyId(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      {parties.map((p) => (
                        <option key={p.party_id} value={p.party_id}>{p.name}</option>
                      ))}
                    </select>
                    <input
                      required
                      value={siteName}
                      onChange={(e) => setSiteName(e.target.value)}
                      placeholder="Site Name *"
                      className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    />
                    <input
                      value={siteContact}
                      onChange={(e) => setSiteContact(e.target.value)}
                      placeholder="Site Supervisor Name"
                      className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    />
                    <input
                      value={sitePhone}
                      onChange={(e) => setSitePhone(e.target.value)}
                      placeholder="Site Phone"
                      className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    />
                    <input
                      value={siteAddress}
                      onChange={(e) => setSiteAddress(e.target.value)}
                      placeholder="Site Location / Plot Address"
                      className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    />
                    <button
                      type="submit"
                      disabled={savingHw}
                      className="w-full h-9 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold"
                    >
                      Add Site
                    </button>
                  </form>

                  <section className="lg:col-span-8 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                      <h2 className="text-sm font-semibold">Active Contractor Sites</h2>
                    </div>
                    <div className="divide-y divide-[var(--border)]">
                      {sites.length === 0 ? (
                        <p className="p-5 text-xs text-[var(--text-muted)]">No sites recorded yet.</p>
                      ) : (
                        sites.map((s) => {
                          const pName = parties.find((p) => p.party_id === s.party_id)?.name || 'Party';
                          return (
                            <div key={s.id} className="p-4 flex justify-between text-xs">
                              <div>
                                <p className="font-semibold text-sm">{s.site_name}</p>
                                <p className="text-[var(--text-muted)]">
                                  {pName} {s.contact_name ? `· ${s.contact_name}` : ''} {s.contact_phone ? `· ${s.contact_phone}` : ''}
                                </p>
                                {s.address && <p className="text-[var(--text-muted)] mt-0.5">{s.address}</p>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </section>
                </div>
              )}

              {hardwareTab === 'warranties' && (
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                    <h2 className="text-sm font-semibold">Serial Number Warranty Register</h2>
                  </div>
                  {warranties.length === 0 ? (
                    <div className="p-6 text-xs text-[var(--text-muted)]">
                      Enter serial numbers when issuing bills for hardware items with Warranty Months configured.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                            <th className="py-2.5 px-4">Item & Serial</th>
                            <th className="py-2.5 px-4">Customer</th>
                            <th className="py-2.5 px-4">Valid Until</th>
                            <th className="py-2.5 px-4">Status</th>
                            <th className="py-2.5 px-4 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border)]">
                          {warranties.map((w) => (
                            <tr key={w.id}>
                              <td className="py-2.5 px-4">
                                <div className="font-medium">{w.item_name}</div>
                                <div className="font-mono text-[var(--text-muted)]">SN: {w.serial_no}</div>
                              </td>
                              <td className="py-2.5 px-4">{w.party_name || 'Walk-in'}</td>
                              <td className="py-2.5 px-4 tabular-nums">
                                {formatDate(w.warranty_end_date)} ({w.warranty_months}m)
                              </td>
                              <td className="py-2.5 px-4 uppercase font-medium">{w.status}</td>
                              <td className="py-2.5 px-4 text-right">
                                {(w.status === 'active' || w.status === 'claimed') && (
                                  <button
                                    type="button"
                                    onClick={() => void handleClaimWarranty(w)}
                                    className="h-7 px-2.5 rounded border border-[var(--border)] hover:bg-[var(--surface-muted)] text-xs font-medium"
                                  >
                                    {w.status === 'active' ? 'Mark Claimed' : 'Mark Replaced'}
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {/* 5. WHOLESALE WORKSPACE */}
          {pack === 'wholesale' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setWholesaleTab('prices')}
                  className={`h-9 px-3.5 rounded-lg border text-xs font-medium ${
                    wholesaleTab === 'prices'
                      ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                      : 'bg-[var(--surface)] border-[var(--border)]'
                  }`}
                >
                  Catalog Rates & Slabs
                </button>
                <button
                  type="button"
                  onClick={() => setWholesaleTab('rates')}
                  className={`h-9 px-3.5 rounded-lg border text-xs font-medium ${
                    wholesaleTab === 'rates'
                      ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                      : 'bg-[var(--surface)] border-[var(--border)]'
                  }`}
                >
                  Party Negotiated Rate Cards ({rateCards.length})
                </button>
              </div>

              {wholesaleTab === 'prices' && (
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">Bulk Selling Rate & Slab Viewer</h2>
                    {canManageItems && (
                      <button
                        type="button"
                        disabled={savingPrices}
                        onClick={() => void handleSaveBulkPrices()}
                        className="h-8 px-3.5 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold inline-flex items-center gap-1"
                      >
                        <IconCheck size={14} stroke={2} />
                        <span>{savingPrices ? 'Saving...' : 'Save Rate Changes'}</span>
                      </button>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                          <th className="py-2.5 px-4">Item</th>
                          <th className="py-2.5 px-4">Wholesale Quantity Slabs</th>
                          <th className="py-2.5 px-4 text-right">Base Rate (₹)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {items.slice(0, 40).map((it) => (
                          <tr key={it.id}>
                            <td className="py-2.5 px-4 font-medium">{it.name}</td>
                            <td className="py-2.5 px-4 text-[var(--text-muted)]">
                              {(it.wholesale_slabs || []).length === 0
                                ? 'No slabs (configure inside Item Form)'
                                : (it.wholesale_slabs || [])
                                    .map((s) => `${s.min_qty}+ @ ₹${s.rate} (${s.tier || 'all'})`)
                                    .join(' · ')}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <input
                                type="number"
                                step="0.01"
                                disabled={!canManageItems}
                                value={priceEdits[it.id] ?? String(it.selling_price)}
                                onChange={(e) =>
                                  setPriceEdits((prev) => ({ ...prev, [it.id]: e.target.value }))
                                }
                                className="h-8 w-28 px-2 text-right rounded border border-[var(--border)] bg-[var(--surface)] tabular-nums text-xs"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {wholesaleTab === 'rates' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  <form
                    onSubmit={handleSaveRateCard}
                    className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
                  >
                    <h2 className="text-sm font-semibold">Set Party Negotiated Rate</h2>
                    <select
                      value={rcPartyId}
                      onChange={(e) => setRcPartyId(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      {parties.map((p) => (
                        <option key={p.party_id} value={p.party_id}>
                          {p.name} ({p.price_tier || 'standard'})
                        </option>
                      ))}
                    </select>
                    <select
                      value={rcItemId}
                      onChange={(e) => setRcItemId(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name} (Std ₹{it.selling_price})
                        </option>
                      ))}
                    </select>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium mb-1">Custom Rate ₹ *</label>
                        <input
                          required
                          type="number"
                          step="0.01"
                          value={rcPrice}
                          onChange={(e) => setRcPrice(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">Min Qty</label>
                        <input
                          type="number"
                          step="0.01"
                          value={rcMinQty}
                          onChange={(e) => setRcMinQty(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="w-full h-9 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold"
                    >
                      Save Negotiated Rate
                    </button>
                  </form>

                  <section className="lg:col-span-8 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                      <h2 className="text-sm font-semibold">Active Party Rate Cards</h2>
                    </div>
                    <div className="divide-y divide-[var(--border)]">
                      {rateCards.length === 0 ? (
                        <p className="p-5 text-xs text-[var(--text-muted)]">No negotiated party rate cards yet.</p>
                      ) : (
                        rateCards.map((rc) => {
                          const pName = parties.find((p) => p.party_id === rc.party_id)?.name || 'Party';
                          const iName = items.find((i) => i.id === rc.item_id)?.name || 'Item';
                          return (
                            <div key={rc.id} className="p-3.5 flex justify-between items-center text-xs">
                              <div>
                                <p className="font-semibold">{pName}</p>
                                <p className="text-[var(--text-muted)]">{iName} · Min Qty {rc.min_qty}</p>
                              </div>
                              <span className="font-bold text-sm tabular-nums">{formatINR(rc.custom_rate)}</span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </section>
                </div>
              )}
            </div>
          )}

          {/* 6. SERVICE BUSINESS WORKSPACE */}
          {pack === 'service' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <form
                onSubmit={handleSaveJob}
                className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <IconBriefcase size={18} stroke={2} className="text-[var(--primary-dark)]" />
                  <h2 className="text-sm font-semibold">
                    {editingJobId ? 'Update Work Order' : 'New Service Job / Work Order'}
                  </h2>
                </div>
                <input
                  required
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  placeholder="Job Title (e.g. Q3 Server Maintenance) *"
                  className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                />
                <select
                  value={jobPartyId}
                  onChange={(e) => setJobPartyId(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                >
                  <option value="">Walk-in Client</option>
                  {parties.map((p) => (
                    <option key={p.party_id} value={p.party_id}>{p.name}</option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={jobStatus}
                    onChange={(e) => setJobStatus(e.target.value as ServiceJobRecord['status'])}
                    className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    <option value="open">Open</option>
                    <option value="in_progress">In Progress</option>
                    <option value="completed">Completed</option>
                    <option value="billed">Billed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <input
                    type="date"
                    value={jobDueDate}
                    onChange={(e) => setJobDueDate(e.target.value)}
                    className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  />
                </div>
                <input
                  type="number"
                  step="0.01"
                  value={jobEstAmt}
                  onChange={(e) => setJobEstAmt(e.target.value)}
                  placeholder="Estimated Job Value (₹)"
                  className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
                <textarea
                  rows={2}
                  value={jobNotes}
                  onChange={(e) => setJobNotes(e.target.value)}
                  placeholder="Scope / technician notes..."
                  className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={savingJob}
                    className="flex-1 h-9 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold"
                  >
                    {savingJob ? 'Saving...' : editingJobId ? 'Update Job' : 'Create Service Job'}
                  </button>
                  {editingJobId && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingJobId(null);
                        setJobTitle('');
                      }}
                      className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>

              <section className="lg:col-span-8 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Service Jobs & Margin Tracker</h2>
                  <span className="text-xs text-[var(--text-muted)] tabular-nums">{jobs.length} jobs</span>
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {jobs.length === 0 ? (
                    <p className="p-5 text-xs text-[var(--text-muted)]">No service jobs created yet.</p>
                  ) : (
                    jobs.map((j) => {
                      const stats = jobRevenueMap[j.id] || { billed: 0, expenses: 0 };
                      const margin = calculateServiceJobMargin({
                        billedRevenue: stats.billed,
                        estimatedAmount: j.estimated_amount,
                        expensesTotal: stats.expenses,
                      });
                      return (
                        <div key={j.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                          <div>
                            <p className="font-semibold text-sm">
                              {j.job_number} · {j.title}
                            </p>
                            <p className="text-[var(--text-muted)]">
                              {j.party_name} · Status: <span className="uppercase font-medium">{j.status.replace('_', ' ')}</span>
                              {j.due_date ? ` · Due ${formatDate(j.due_date)}` : ''}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="text-right tabular-nums">
                              <p className="font-semibold">
                                Billed {formatINR(stats.billed)} / Est {formatINR(j.estimated_amount)}
                              </p>
                              <p className={margin.netMargin >= 0 ? 'text-[var(--receive-text)]' : 'text-[var(--give)]'}>
                                Exp {formatINR(stats.expenses)} · Net {formatINR(margin.netMargin)} ({margin.marginPct}%)
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingJobId(j.id);
                                setJobTitle(j.title);
                                setJobPartyId(j.party_id || '');
                                setJobStatus(j.status);
                                setJobDueDate(j.due_date || '');
                                setJobEstAmt(String(j.estimated_amount));
                                setJobNotes(j.notes || '');
                              }}
                              className="h-8 px-2.5 rounded border border-[var(--border)] hover:bg-[var(--surface-muted)]"
                            >
                              Edit
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </div>
          )}

          {/* 7. GENERAL RETAIL WORKSPACE */}
          {pack === 'general_retail' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <section className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <IconTag size={18} stroke={2} className="text-[var(--primary-dark)]" />
                  <h2 className="text-sm font-semibold">Retail Discount Preset & Margin</h2>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Offer Discount Preset (%)</label>
                  <div className="flex gap-2">
                    {['5', '10', '15', '20'].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => setRetailDiscountPct(pct)}
                        className={`flex-1 h-8 rounded border text-xs font-medium tabular-nums ${
                          retailDiscountPct === pct
                            ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                            : 'border-[var(--border)] bg-[var(--surface)]'
                        }`}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pt-2 border-t border-[var(--border)] space-y-2">
                  <button
                    type="button"
                    onClick={() => onNavigate('data')}
                    className="w-full h-9 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                  >
                    <IconFileSpreadsheet size={15} stroke={2} />
                    <span>Import / Export CSV & XLSX</span>
                  </button>
                  {canCreateBills && (
                    <button
                      type="button"
                      onClick={() => onNavigate('bills', undefined, { action: 'new-bill' })}
                      className="w-full h-9 rounded-lg bg-[var(--primary)] text-white text-xs font-semibold"
                    >
                      New Retail Bill
                    </button>
                  )}
                </div>
              </section>

              <section className="lg:col-span-8 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                <div className="px-5 py-3.5 border-b border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Margin Preview ({retailDiscountPct}% Promo)</h2>
                  <span className="text-xs text-[var(--text-muted)]">{items.length} active SKUs</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                        <th className="py-2.5 px-4">Item</th>
                        <th className="py-2.5 px-4 text-right">Selling</th>
                        <th className="py-2.5 px-4 text-right">After {retailDiscountPct}% Off</th>
                        <th className="py-2.5 px-4 text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {items.slice(0, 20).map((it) => {
                        const discounted = applyDiscountPreset(it.selling_price, Number(retailDiscountPct));
                        const margin = calculateMarginPct(discounted, it.purchase_price);
                        return (
                          <tr key={it.id}>
                            <td className="py-2.5 px-4 font-medium">{it.name}</td>
                            <td className="py-2.5 px-4 text-right tabular-nums">{formatINR(it.selling_price)}</td>
                            <td className="py-2.5 px-4 text-right tabular-nums font-semibold">{formatINR(discounted)}</td>
                            <td className="py-2.5 px-4 text-right tabular-nums text-[var(--text-muted)]">
                              {it.purchase_price ? `${margin}%` : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
