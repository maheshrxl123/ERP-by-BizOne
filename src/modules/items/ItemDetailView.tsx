import {
  IconAdjustments,
  IconArchive,
  IconArrowLeft,
  IconBarcode,
  IconEdit,
  IconPhoto,
  IconPlus,
  IconRestore,
  IconStarFilled,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import { formatStockQty } from '../../core/units';
import { classifyBatchExpiry, daysUntilExpiry } from '../../packs/registry';
import type {
  BrandRecord,
  ItemBatchRecord,
  ItemCatalogRecord,
  ItemCategoryRecord,
  ItemImageRecord,
  ItemUnitRecord,
  ItemVariantRecord,
  SaltSubstituteRow,
  StockLedgerEntryRecord,
  UnitConversionRecord,
} from '../../types/bizone';
import { BarcodeLabelModal } from './BarcodeLabelModal';
import { ItemFormModal } from './ItemFormModal';
import { StockAdjustmentModal } from './StockAdjustmentModal';

interface ItemDetailViewProps {
  itemId: string;
  categories: ItemCategoryRecord[];
  brands: BrandRecord[];
  units: ItemUnitRecord[];
  onBack: () => void;
  onUpdated: () => Promise<void> | void;
  onTaxonomyUpdated: () => Promise<void> | void;
}

export function ItemDetailView({
  itemId,
  categories,
  brands,
  units,
  onBack,
  onUpdated,
  onTaxonomyUpdated,
}: ItemDetailViewProps) {
  const { business, profile, isModuleEnabled, signedUrlCache, getSignedUrl, language, showToast, t } =
    useApp();

  const canEdit = hasCapability(profile?.role, 'items');
  const canAdjust = hasCapability(profile?.role, 'stock_adjustment');
  const canViewCost = hasCapability(profile?.role, 'view_profit');

  const [item, setItem] = useState<ItemCatalogRecord | null>(null);
  const [conversions, setConversions] = useState<UnitConversionRecord[]>([]);
  const [images, setImages] = useState<ItemImageRecord[]>([]);
  const [ledger, setLedger] = useState<StockLedgerEntryRecord[]>([]);
  const [batches, setBatches] = useState<ItemBatchRecord[]>([]);
  const [substitutes, setSubstitutes] = useState<SaltSubstituteRow[]>([]);
  const [variants, setVariants] = useState<ItemVariantRecord[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [batchAddOpen, setBatchAddOpen] = useState(false);
  const [newBatchNo, setNewBatchNo] = useState('');
  const [newBatchExp, setNewBatchExp] = useState('');
  const [newBatchMrp, setNewBatchMrp] = useState('');
  const [newBatchQty, setNewBatchQty] = useState('10');
  const [savingBatch, setSavingBatch] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const showBatches = business?.pack === 'medical' || isModuleEnabled('batch_expiry');
  const showVariants = business?.pack === 'clothing' || isModuleEnabled('variants');

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const [itemRes, convRes, imgRes, ledgerRes, batchesRes, subRes, varRes] = await Promise.all([
        supabase
          .from('item_catalog_view')
          .select('*')
          .eq('id', itemId)
          .maybeSingle(),
        supabase
          .from('unit_conversions')
          .select('*, item_units(*)')
          .eq('item_id', itemId)
          .order('conversion_factor', { ascending: true }),
        supabase
          .from('item_images')
          .select('*, files(id, file_name, mime_type, size_bytes)')
          .eq('item_id', itemId)
          .order('sort_order', { ascending: true }),
        supabase
          .from('stock_ledger_view')
          .select('*')
          .eq('item_id', itemId)
          .order('movement_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(100),
        showBatches
          ? supabase
              .from('item_batches')
              .select('*')
              .eq('item_id', itemId)
              .order('expiry_date', { ascending: true })
          : Promise.resolve({ data: [], error: null }),
        business?.pack === 'medical'
          ? supabase.rpc('get_salt_substitutes', { p_item_id: itemId })
          : Promise.resolve({ data: [], error: null }),
        showVariants
          ? supabase
              .from('item_variants')
              .select('*')
              .eq('item_id', itemId)
              .order('size', { ascending: true })
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (itemRes.error) throw itemRes.error;
      if (convRes.error) throw convRes.error;
      if (imgRes.error) throw imgRes.error;
      if (ledgerRes.error) throw ledgerRes.error;
      const loadedItem = (itemRes.data as ItemCatalogRecord | null) ?? null;
      const loadedImages = (imgRes.data as ItemImageRecord[] | null) ?? [];

      setItem(loadedItem);
      setConversions((convRes.data as UnitConversionRecord[] | null) ?? []);
      setImages(loadedImages);
      setLedger((ledgerRes.data as StockLedgerEntryRecord[] | null) ?? []);
      setBatches((batchesRes.data as ItemBatchRecord[] | null) ?? []);
      setSubstitutes((subRes.data as SaltSubstituteRow[] | null) ?? []);
      setVariants((varRes.data as ItemVariantRecord[] | null) ?? []);

      const primary =
        loadedImages.find((i) => i.is_primary)?.file_id ||
        loadedImages[0]?.file_id ||
        loadedItem?.primary_image_file_id ||
        null;
      setActiveFileId(primary);

      for (const img of loadedImages) {
        void getSignedUrl(img.file_id);
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to load item details.',
        'error'
      );
    } finally {
      setLoading(false);
    }
  }, [itemId, getSignedUrl, showToast, showBatches, showVariants, business?.pack]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleAddBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item || !newBatchNo.trim() || !newBatchExp) return;
    setSavingBatch(true);
    try {
      const { error } = await supabase.rpc('save_item_batch', {
        p_item_id: item.id,
        p_batch_no: newBatchNo.trim(),
        p_expiry_date: newBatchExp,
        p_mfg_date: null,
        p_mrp: newBatchMrp ? Number(newBatchMrp) : item.mrp ?? null,
        p_purchase_rate: null,
        p_selling_rate: newBatchMrp ? Number(newBatchMrp) : item.selling_price,
        p_qty_delta: Number(newBatchQty || 0),
        p_batch_id: null,
        p_is_active: true,
      });
      if (error) throw error;
      showToast('Batch added.', 'success');
      setBatchAddOpen(false);
      setNewBatchNo('');
      await loadDetail();
      await onUpdated();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save batch.', 'error');
    } finally {
      setSavingBatch(false);
    }
  };

  const handleToggleArchive = async () => {
    if (!item || !canEdit || archiving) return;
    setArchiving(true);
    try {
      const { error } = await supabase.rpc('archive_item', {
        p_item_id: item.id,
        p_is_active: !item.is_active,
      });
      if (error) throw error;
      showToast(
        item.is_active ? 'Item archived.' : 'Item restored.',
        'success'
      );
      await loadDetail();
      await onUpdated();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to update item status.',
        'error'
      );
    } finally {
      setArchiving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
        <div className="h-9 w-36 rounded-lg bg-[var(--surface-muted)] animate-pulse" />
        <div className="h-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] animate-pulse" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--primary-dark)]"
        >
          <IconArrowLeft size={16} stroke={2} />
          <span>Back to Items</span>
        </button>
        <div className="p-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--text-muted)]">
          Item not found.
        </div>
      </div>
    );
  }

  const activeUrl = activeFileId ? signedUrlCache[activeFileId] : undefined;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to Items"
            className="w-10 h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] flex items-center justify-center shrink-0 hover:bg-[var(--surface-muted)]"
          >
            <IconArrowLeft size={18} stroke={2} />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">
              {item.name}
            </h1>
            <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5 truncate">
              {item.category_name || 'Uncategorized'}
              {item.brand_name ? ` · ${item.brand_name}` : ''}
              {item.sku ? ` · SKU ${item.sku}` : ''}
              {item.barcode ? ` · ${item.barcode}` : ''}
              {!item.is_active ? ' · Archived' : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {canAdjust && (
            <button
              type="button"
              onClick={() => setAdjustOpen(true)}
              className="h-10 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
            >
              <IconAdjustments size={16} stroke={2} />
              <span>{t('items.adjustStock')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setLabelOpen(true)}
            className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
          >
            <IconBarcode size={16} stroke={2} />
            <span>{t('items.barcodeLabels')}</span>
          </button>
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
              >
                <IconEdit size={16} stroke={2} />
                <span>Edit</span>
              </button>
              <button
                type="button"
                disabled={archiving}
                onClick={handleToggleArchive}
                className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)] disabled:opacity-50"
              >
                {item.is_active ? (
                  <>
                    <IconArchive size={16} stroke={2} />
                    <span>{t('items.archiveItem')}</span>
                  </>
                ) : (
                  <>
                    <IconRestore size={16} stroke={2} />
                    <span>{t('items.restoreItem')}</span>
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Gallery + Key Pricing & Stock Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Multi-Image Gallery Viewer */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
          <div className="aspect-square rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] overflow-hidden flex items-center justify-center">
            {activeUrl ? (
              <img
                src={activeUrl}
                alt={item.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-[var(--text-muted)]">
                <IconPhoto size={36} stroke={1.5} />
                <span className="text-xs">No photos added</span>
              </div>
            )}
          </div>

          {images.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {images.map((img) => {
                const thumbUrl = signedUrlCache[img.file_id];
                const isSelected = img.file_id === activeFileId;
                return (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => setActiveFileId(img.file_id)}
                    className={`relative h-16 rounded-lg overflow-hidden border bg-[var(--surface-muted)] ${
                      isSelected
                        ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/30'
                        : 'border-[var(--border)]'
                    }`}
                  >
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt={img.files?.file_name || item.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[var(--text-muted)]">
                        <IconPhoto size={16} stroke={2} />
                      </div>
                    )}
                    {img.is_primary && (
                      <span
                        title="Primary photo"
                        className="absolute top-1 right-1 text-[var(--primary)] drop-shadow"
                      >
                        <IconStarFilled size={12} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Pricing, Stock, GST & Conversions */}
        <section className="lg:col-span-2 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-xs text-[var(--text-muted)]">
                {t('items.stockOnHand')}
              </p>
              <p
                className={`mt-1.5 text-xl font-semibold tabular-nums ${
                  item.is_out_of_stock
                    ? 'text-[var(--give)]'
                    : item.is_low_stock
                      ? 'text-amber-600'
                      : 'text-[var(--text)]'
                }`}
              >
                {formatStockQty(item.qty_on_hand, item.base_unit_code)}
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-1 tabular-nums">
                Alert ≤ {formatStockQty(item.low_stock_alert, item.base_unit_code)}
              </p>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-xs text-[var(--text-muted)]">
                {t('items.sellingPrice')}
              </p>
              <p className="mt-1.5 text-xl font-semibold tabular-nums">
                {formatINR(Number(item.selling_price))}
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-1 tabular-nums">
                {item.mrp ? `MRP ${formatINR(Number(item.mrp))}` : 'No MRP'} · GST{' '}
                {item.gst_rate}%
              </p>
            </div>

            {canViewCost && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 col-span-2 sm:col-span-1">
                <p className="text-xs text-[var(--text-muted)]">
                  {t('items.stockValue')}
                </p>
                <p className="mt-1.5 text-xl font-semibold tabular-nums">
                  {formatINR(Number(item.stock_value ?? 0))}
                </p>
                <p className="text-[11px] text-[var(--text-muted)] mt-1 tabular-nums">
                  Cost: {formatINR(Number(item.purchase_price ?? 0))} /{' '}
                  {item.base_unit_code}
                </p>
              </div>
            )}
          </div>

          {/* Item Specification & Conversions */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <h2 className="text-sm font-semibold">Item Details & Units</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <dt className="text-[var(--text-muted)]">{t('items.baseUnit')}</dt>
                <dd className="font-medium mt-0.5">
                  {item.base_unit_code} (
                  {language === 'hi'
                    ? item.base_unit_name_hi
                    : item.base_unit_name_en}
                  )
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">{t('items.hsnCode')}</dt>
                <dd className="font-mono font-medium mt-0.5">
                  {item.hsn_code || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Tax Mode</dt>
                <dd className="font-medium mt-0.5">
                  {item.tax_inclusive ? 'Inclusive' : 'Exclusive'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Negative Stock</dt>
                <dd className="font-medium mt-0.5">
                  {item.allow_negative_stock ? 'Allowed' : 'Blocked'}
                </dd>
              </div>
            </dl>

            {conversions.length > 0 && (
              <div className="pt-2 border-t border-[var(--border)]">
                <p className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
                  {t('items.alternateUnits')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {conversions.map((c) => (
                    <span
                      key={c.id || c.alternate_unit_id}
                      className="px-2.5 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs tabular-nums"
                    >
                      1 {c.item_units?.code || 'UNIT'} = {c.conversion_factor}{' '}
                      {item.base_unit_code}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(item.wholesale_slabs) && item.wholesale_slabs.length > 0 && (
              <div className="pt-2 border-t border-[var(--border)]">
                <p className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
                  Wholesale Rate Slabs
                </p>
                <div className="flex flex-wrap gap-2">
                  {item.wholesale_slabs.map((slab, idx) => (
                    <span
                      key={idx}
                      className="px-2.5 py-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs tabular-nums"
                    >
                      {slab.min_qty}+ · {slab.tier} → {formatINR(Number(slab.rate))}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {item.notes && (
              <p className="pt-2 border-t border-[var(--border)] text-xs text-[var(--text-muted)]">
                {item.notes}
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Pack-Specific Details: Batches & Expiry */}
      {showBatches && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Batches &amp; Expiry (FEFO)</h2>
              {item.pack_metadata?.salt && (
                <p className="text-xs text-[var(--text-muted)]">
                  Salt: {String(item.pack_metadata.salt)}
                  {item.pack_metadata?.schedule ? ` · Schedule ${String(item.pack_metadata.schedule)}` : ''}
                </p>
              )}
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={() => setBatchAddOpen((v) => !v)}
                className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
              >
                <IconPlus size={15} stroke={2} />
                <span>Add Batch</span>
              </button>
            )}
          </div>

          {batchAddOpen && canEdit && (
            <form
              onSubmit={handleAddBatch}
              className="p-4 border-b border-[var(--border)] bg-[var(--surface-muted)] grid grid-cols-2 sm:grid-cols-5 gap-3 items-end"
            >
              <div>
                <label className="block text-xs font-medium mb-1">Batch No *</label>
                <input
                  required
                  value={newBatchNo}
                  onChange={(e) => setNewBatchNo(e.target.value)}
                  placeholder="B-2601"
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs uppercase"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Expiry Date *</label>
                <input
                  required
                  type="date"
                  value={newBatchExp}
                  onChange={(e) => setNewBatchExp(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Batch MRP</label>
                <input
                  type="number"
                  step="0.01"
                  value={newBatchMrp}
                  onChange={(e) => setNewBatchMrp(e.target.value)}
                  placeholder={String(item.mrp ?? item.selling_price)}
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Qty</label>
                <input
                  type="number"
                  step="any"
                  value={newBatchQty}
                  onChange={(e) => setNewBatchQty(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                />
              </div>
              <button
                type="submit"
                disabled={savingBatch}
                className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
              >
                {savingBatch ? 'Saving...' : 'Save Batch'}
              </button>
            </form>
          )}

          {batches.length === 0 ? (
            <div className="p-5 text-xs text-[var(--text-muted)]">No batches recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[var(--surface-muted)] text-[var(--text-muted)]">
                  <tr>
                    <th className="py-2.5 px-4 text-left">Batch No</th>
                    <th className="py-2.5 px-4 text-left">Expiry</th>
                    <th className="py-2.5 px-4 text-left">Status</th>
                    <th className="py-2.5 px-4 text-right">MRP</th>
                    <th className="py-2.5 px-4 text-right">Selling</th>
                    <th className="py-2.5 px-4 text-right">Stock</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {batches.map((b) => {
                    const cls = classifyBatchExpiry(b.expiry_date);
                    const days = daysUntilExpiry(b.expiry_date);
                    return (
                      <tr key={b.id}>
                        <td className="py-2.5 px-4 font-mono font-medium">{b.batch_no}</td>
                        <td className="py-2.5 px-4 tabular-nums">{formatDate(b.expiry_date)}</td>
                        <td
                          className={`py-2.5 px-4 font-medium ${
                            cls === 'expired'
                              ? 'text-[var(--give)]'
                              : days <= 60
                                ? 'text-amber-600'
                                : 'text-[var(--receive-text)]'
                          }`}
                        >
                          {cls === 'expired'
                            ? 'Expired (Blocked)'
                            : days <= 30
                              ? 'Expiring ≤ 30d'
                              : days <= 60
                                ? 'Expiring ≤ 60d'
                                : days <= 90
                                  ? 'Expiring ≤ 90d'
                                  : 'Healthy'}
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums">
                          {b.mrp != null ? formatINR(Number(b.mrp)) : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums">
                          {b.selling_rate != null ? formatINR(Number(b.selling_rate)) : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right tabular-nums font-semibold">
                          {formatStockQty(b.qty_on_hand, item.base_unit_code)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {substitutes.length > 0 && (
            <div className="p-4 border-t border-[var(--border)] bg-[var(--surface-muted)]/50 space-y-2">
              <p className="text-xs font-semibold">Same-Salt Substitutes</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {substitutes.map((s) => (
                  <div
                    key={s.id}
                    className="p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] flex items-center justify-between text-xs"
                  >
                    <div>
                      <p className="font-medium">{s.name}</p>
                      <p className="text-[var(--text-muted)]">Stock: {s.qty_on_hand}</p>
                    </div>
                    <span className="font-semibold tabular-nums">{formatINR(Number(s.selling_price))}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Clothing Variants Matrix Table */}
      {showVariants && variants.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="text-base font-semibold">Size &amp; Colour Variants</h2>
            <span className="text-xs text-[var(--text-muted)] tabular-nums">{variants.length} SKUs</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-muted)] text-[var(--text-muted)]">
                <tr>
                  <th className="py-2.5 px-4 text-left">Size</th>
                  <th className="py-2.5 px-4 text-left">Colour</th>
                  <th className="py-2.5 px-4 text-left">SKU</th>
                  <th className="py-2.5 px-4 text-right">Selling</th>
                  <th className="py-2.5 px-4 text-right">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {variants.map((v) => (
                  <tr key={v.id}>
                    <td className="py-2.5 px-4 font-semibold">{v.size || '—'}</td>
                    <td className="py-2.5 px-4">{v.color || '—'}</td>
                    <td className="py-2.5 px-4 font-mono">{v.sku || '—'}</td>
                    <td className="py-2.5 px-4 text-right tabular-nums">
                      {formatINR(Number(v.selling_price ?? item.selling_price))}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums font-semibold">
                      {v.qty_on_hand} {item.base_unit_code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Immutable Stock Ledger */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('items.stockLedger')}</h2>
          <span className="text-xs text-[var(--text-muted)] tabular-nums">
            {ledger.length} entries
          </span>
        </div>

        {ledger.length === 0 ? (
          <div className="p-6 text-sm text-[var(--text-muted)]">
            {t('items.noStockMovements')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-[var(--surface-muted)] text-[var(--text-muted)] text-xs">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Type & Reference</th>
                  <th className="px-4 py-3 font-medium">Entered</th>
                  <th className="px-4 py-3 font-medium text-right">
                    Base Change
                  </th>
                  <th className="px-4 py-3 font-medium">Reason / User</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {ledger.map((row) => {
                  const isIn = Number(row.signed_base_qty) > 0;
                  return (
                    <tr key={row.id} className="hover:bg-[var(--surface-muted)]/40">
                      <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                        {formatDate(row.movement_date)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium capitalize">
                          {row.movement_type.replace('_', ' ')}
                        </p>
                        {row.reference_no && (
                          <p className="text-xs font-mono text-[var(--text-muted)]">
                            {row.reference_no}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                        {row.entered_qty} {row.entered_unit_code}
                        {Number(row.conversion_factor) !== 1 && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            {' '}
                            (×{row.conversion_factor})
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-semibold tabular-nums whitespace-nowrap ${
                          isIn ? 'text-[var(--receive-text)]' : 'text-[var(--give)]'
                        }`}
                      >
                        {isIn ? '+' : ''}
                        {formatStockQty(row.signed_base_qty, item.base_unit_code)}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                        <p className="text-[var(--text)]">
                          {row.reason || '—'}
                        </p>
                        {row.created_by_name && <p>by {row.created_by_name}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ItemFormModal
        open={editOpen}
        item={item}
        categories={categories}
        brands={brands}
        units={units}
        initialConversions={conversions}
        initialImages={images}
        onClose={() => setEditOpen(false)}
        onSaved={async () => {
          await loadDetail();
          await onUpdated();
        }}
        onTaxonomyUpdated={onTaxonomyUpdated}
      />

      <StockAdjustmentModal
        open={adjustOpen}
        item={item}
        units={units}
        conversions={conversions}
        onClose={() => setAdjustOpen(false)}
        onAdjusted={async () => {
          await loadDetail();
          await onUpdated();
        }}
      />

      <BarcodeLabelModal
        open={labelOpen}
        items={[item]}
        initialItemId={item.id}
        onClose={() => setLabelOpen(false)}
      />
    </div>
  );
}
