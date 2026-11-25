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
  IconTags,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { getProductLineLabel } from '../../core/productLines';
import { supabase } from '../../core/supabase';
import { formatStockQty } from '../../core/units';
import type {
  BrandRecord,
  ItemCatalogRecord,
  ItemCategoryRecord,
  ItemImageRecord,
  ItemLotBalanceRecord,
  ItemUnitRecord,
  ItemVariantRecord,
  StockLedgerEntryRecord,
  UnitConversionRecord,
} from '../../types/decorbiz';
import { BarcodeLabelModal } from './BarcodeLabelModal';
import { ItemFormModal } from './ItemFormModal';
import { ProductSpecDetailGrid } from './ProductSpecFields';
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
  const { profile, signedUrlCache, getSignedUrl, language, showToast, t } =
    useApp();

  const canEdit = hasCapability(profile?.role, 'items');
  const canAdjust = hasCapability(profile?.role, 'stock_adjustment');
  const canViewCost = hasCapability(profile?.role, 'view_profit');

  const [item, setItem] = useState<ItemCatalogRecord | null>(null);
  const [conversions, setConversions] = useState<UnitConversionRecord[]>([]);
  const [images, setImages] = useState<ItemImageRecord[]>([]);
  const [variants, setVariants] = useState<ItemVariantRecord[]>([]);
  const [lotBalances, setLotBalances] = useState<ItemLotBalanceRecord[]>([]);
  const [ledger, setLedger] = useState<StockLedgerEntryRecord[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editOpen, setEditOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState<ItemVariantRecord | null>(null);
  const [varName, setVarName] = useState('');
  const [varSize, setVarSize] = useState('');
  const [varFinish, setVarFinish] = useState('');
  const [varShade, setVarShade] = useState('');
  const [varBatchLot, setVarBatchLot] = useState('');
  const [varSku, setVarSku] = useState('');
  const [varBarcode, setVarBarcode] = useState('');
  const [varSellingPrice, setVarSellingPrice] = useState('');
  const [varMrp, setVarMrp] = useState('');
  const [varPurchasePrice, setVarPurchasePrice] = useState('');
  const [varOpeningStock, setVarOpeningStock] = useState('0');
  const [savingVariant, setSavingVariant] = useState(false);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const [itemRes, convRes, imgRes, varRes, lotRes, ledgerRes] = await Promise.all([
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
          .from('item_variants_view')
          .select('*')
          .eq('item_id', itemId)
          .order('variant_name', { ascending: true }),
        supabase
          .from('item_lot_balances')
          .select('*')
          .eq('item_id', itemId)
          .order('qty_on_hand', { ascending: false }),
        supabase
          .from('stock_ledger_view')
          .select('*')
          .eq('item_id', itemId)
          .order('movement_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(100),
      ]);

      if (itemRes.error) throw itemRes.error;
      if (convRes.error) throw convRes.error;
      if (imgRes.error) throw imgRes.error;
      if (varRes.error) throw varRes.error;
      if (lotRes.error) throw lotRes.error;
      if (ledgerRes.error) throw ledgerRes.error;
      const loadedItem = (itemRes.data as ItemCatalogRecord | null) ?? null;
      const loadedImages = (imgRes.data as ItemImageRecord[] | null) ?? [];

      setItem(loadedItem);
      setConversions((convRes.data as UnitConversionRecord[] | null) ?? []);
      setImages(loadedImages);
      setVariants((varRes.data as ItemVariantRecord[] | null) ?? []);
      setLotBalances((lotRes.data as ItemLotBalanceRecord[] | null) ?? []);
      setLedger((ledgerRes.data as StockLedgerEntryRecord[] | null) ?? []);

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
  }, [itemId, getSignedUrl, showToast]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

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

  const openVariantForm = (existing?: ItemVariantRecord | null) => {
    setEditingVariant(existing ?? null);
    setVarName(existing?.variant_name || '');
    setVarSize(existing?.size_label || '');
    setVarFinish(existing?.finish || '');
    setVarShade(existing?.shade || '');
    setVarBatchLot(existing?.batch_lot || '');
    setVarSku(existing?.sku || '');
    setVarBarcode(existing?.barcode || '');
    setVarSellingPrice(
      existing ? String(existing.selling_price ?? 0) : String(item?.selling_price ?? 0)
    );
    setVarMrp(
      existing?.mrp != null ? String(existing.mrp) : item?.mrp != null ? String(item.mrp) : ''
    );
    setVarPurchasePrice(
      existing?.purchase_price != null
        ? String(existing.purchase_price)
        : item?.purchase_price != null
          ? String(item.purchase_price)
          : ''
    );
    setVarOpeningStock('0');
    setVariantModalOpen(true);
  };

  const handleSaveVariant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item || !varName.trim()) return;
    setSavingVariant(true);
    try {
      const { error } = await supabase.rpc('save_item_variant', {
        p_id: editingVariant?.id ?? null,
        p_item_id: editingVariant ? null : item.id,
        p_variant_name: varName.trim(),
        p_size_label: varSize.trim() || null,
        p_finish: varFinish.trim() || null,
        p_shade: varShade.trim() || null,
        p_batch_lot: varBatchLot.trim() || null,
        p_sku: varSku.trim() || null,
        p_barcode: varBarcode.trim() || null,
        p_selling_price: Math.max(0, Number(varSellingPrice || 0)),
        p_mrp: varMrp.trim() ? Math.max(0, Number(varMrp)) : null,
        p_purchase_price: canViewCost && varPurchasePrice.trim() ? Math.max(0, Number(varPurchasePrice)) : 0,
        p_opening_stock: editingVariant ? 0 : Math.max(0, Number(varOpeningStock || 0)),
      });
      if (error) throw error;
      showToast(editingVariant ? 'Variant updated.' : 'Variant created.', 'success');
      setVariantModalOpen(false);
      await loadDetail();
      await onUpdated();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save variant.', 'error');
    } finally {
      setSavingVariant(false);
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
              {getProductLineLabel(item.product_line, language)}
              {' · '}
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
                <dt className="text-[var(--text-muted)]">{t('items.productLine')}</dt>
                <dd className="font-medium mt-0.5">
                  {getProductLineLabel(item.product_line, language)}
                </dd>
              </div>
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
              {item.supplier_name && (
                <div>
                  <dt className="text-[var(--text-muted)]">{t('items.supplier')}</dt>
                  <dd className="font-medium mt-0.5">{item.supplier_name}</dd>
                </div>
              )}
              {item.country_of_origin && (
                <div>
                  <dt className="text-[var(--text-muted)]">{t('items.countryOfOrigin')}</dt>
                  <dd className="font-medium mt-0.5">{item.country_of_origin}</dd>
                </div>
              )}
              {item.warranty_months !== null && item.warranty_months !== undefined && (
                <div>
                  <dt className="text-[var(--text-muted)]">{t('items.warrantyMonths')}</dt>
                  <dd className="font-medium mt-0.5 tabular-nums">
                    {item.warranty_months} months
                  </dd>
                </div>
              )}
              {item.video_url && /^https?:\/\//i.test(item.video_url) && (
                <div>
                  <dt className="text-[var(--text-muted)]">{t('items.videoUrl')}</dt>
                  <dd className="font-medium mt-0.5">
                    <a
                      href={item.video_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--primary-dark)] hover:underline"
                    >
                      Watch Video
                    </a>
                  </dd>
                </div>
              )}
            </dl>

            {item.description && (
              <p className="pt-2 border-t border-[var(--border)] text-xs text-[var(--text)]">
                {item.description}
              </p>
            )}

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

            {item.notes && (
              <p className="pt-2 border-t border-[var(--border)] text-xs text-[var(--text-muted)]">
                {item.notes}
              </p>
            )}
          </div>

          {/* Typed Line Specifications */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t('items.technicalSpecs')}</h2>
              <span className="text-xs text-[var(--text-muted)]">
                {getProductLineLabel(item.product_line, language)}
              </span>
            </div>
            <ProductSpecDetailGrid productLine={item.product_line} specs={item.specs} />
          </div>
        </section>
      </div>

      {/* Item Variants */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconTags size={18} stroke={2} className="text-[var(--primary-dark)]" />
            <h2 className="text-base font-semibold">Variants (Size / Finish / Shade)</h2>
            <span className="text-xs text-[var(--text-muted)] tabular-nums">
              ({variants.length})
            </span>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => openVariantForm(null)}
              className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1"
            >
              <IconPlus size={14} stroke={2.5} />
              <span>Add Variant</span>
            </button>
          )}
        </div>

        {variants.length === 0 ? (
          <div className="p-5 text-xs sm:text-sm text-[var(--text-muted)]">
            No variants defined. Add variants to track separate sizes, finishes, shades, SKUs, and per-variant stock balances.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-[var(--surface-muted)] text-[var(--text-muted)] text-xs">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Variant</th>
                  <th className="px-4 py-2.5 font-medium">Size / Finish</th>
                  <th className="px-4 py-2.5 font-medium">Shade / Batch Lot</th>
                  <th className="px-4 py-2.5 font-medium">SKU / Barcode</th>
                  <th className="px-4 py-2.5 font-medium text-right">Price</th>
                  <th className="px-4 py-2.5 font-medium text-right">Stock</th>
                  {canEdit && <th className="px-4 py-2.5 text-right font-medium">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {variants.map((v) => (
                  <tr key={v.id} className="hover:bg-[var(--surface-muted)]/40">
                    <td className="px-4 py-3 font-medium">{v.variant_name}</td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                      {[v.size_label, v.finish].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {[v.shade ? `Shade: ${v.shade}` : null, v.batch_lot ? `Lot: ${v.batch_lot}` : null]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-[var(--text-muted)]">
                      {[v.sku, v.barcode].filter(Boolean).join(' / ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      {formatINR(Number(v.selling_price))}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold">
                      {formatStockQty(v.qty_on_hand, item.base_unit_code)}
                    </td>
                    {canEdit && (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openVariantForm(v)}
                          className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
                        >
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Shade & Batch Lot Stock Balances */}
      {lotBalances.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Shade & Batch Lot Balances</h2>
            <span className="text-xs text-[var(--text-muted)] tabular-nums">
              {lotBalances.length} lot(s)
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-[var(--surface-muted)] text-[var(--text-muted)] text-xs">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Variant</th>
                  <th className="px-4 py-2.5 font-medium">Shade</th>
                  <th className="px-4 py-2.5 font-medium">Batch / Lot</th>
                  <th className="px-4 py-2.5 font-medium text-right">On Hand</th>
                  <th className="px-4 py-2.5 font-medium text-right">Last Movement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {lotBalances.map((lb, idx) => (
                  <tr key={`${lb.variant_id || 'std'}_${lb.shade}_${lb.batch_lot}_${idx}`}>
                    <td className="px-4 py-2.5 font-medium">{lb.variant_name}</td>
                    <td className="px-4 py-2.5">{lb.shade}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{lb.batch_lot}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                      {formatStockQty(lb.qty_on_hand, item.base_unit_code)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-[var(--text-muted)] tabular-nums">
                      {lb.last_movement_at ? formatDate(lb.last_movement_at) : '—'}
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
                        {(row.variant_name || row.shade || row.batch_lot) && (
                          <p className="text-[11px] text-[var(--primary-dark)]">
                            {[row.variant_name, row.shade ? `Shade ${row.shade}` : null, row.batch_lot ? `Lot ${row.batch_lot}` : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        )}
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

      {variantModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setVariantModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {editingVariant ? 'Edit Variant' : 'Add Variant'} · {item.name}
              </h2>
              <button
                type="button"
                onClick={() => setVariantModalOpen(false)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              >
                <IconX size={18} stroke={2} />
              </button>
            </div>
            <form onSubmit={handleSaveVariant} className="p-5 space-y-3.5 text-sm">
              <div>
                <label className="block text-xs font-medium mb-1">Variant Name *</label>
                <input
                  type="text"
                  required
                  value={varName}
                  onChange={(e) => setVarName(e.target.value)}
                  placeholder="e.g., Glossy Ivory 600x1200 Shade A2"
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Size Label</label>
                  <input
                    type="text"
                    value={varSize}
                    onChange={(e) => setVarSize(e.target.value)}
                    placeholder="e.g., 600x1200 mm"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Finish</label>
                  <input
                    type="text"
                    value={varFinish}
                    onChange={(e) => setVarFinish(e.target.value)}
                    placeholder="e.g., Glossy, Matt, Satin"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Shade</label>
                  <input
                    type="text"
                    value={varShade}
                    onChange={(e) => setVarShade(e.target.value)}
                    placeholder="e.g., Ivory / S1"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Default Batch / Lot</label>
                  <input
                    type="text"
                    value={varBatchLot}
                    onChange={(e) => setVarBatchLot(e.target.value)}
                    placeholder="e.g., LOT-2026-01"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Variant SKU</label>
                  <input
                    type="text"
                    value={varSku}
                    onChange={(e) => setVarSku(e.target.value.toUpperCase())}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Variant Barcode</label>
                  <input
                    type="text"
                    value={varBarcode}
                    onChange={(e) => setVarBarcode(e.target.value.toUpperCase())}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Selling Price *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={varSellingPrice}
                    onChange={(e) => setVarSellingPrice(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">MRP</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={varMrp}
                    onChange={(e) => setVarMrp(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
                {canViewCost && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Purchase Cost</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={varPurchasePrice}
                      onChange={(e) => setVarPurchasePrice(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                    />
                  </div>
                )}
                {!editingVariant && item.item_type !== 'service' && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Opening Stock ({item.base_unit_code})</label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={varOpeningStock}
                      onChange={(e) => setVarOpeningStock(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                    />
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
                <button
                  type="button"
                  onClick={() => setVariantModalOpen(false)}
                  className="h-10 px-4 rounded-lg border border-[var(--border)] text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingVariant}
                  className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold disabled:opacity-50"
                >
                  {savingVariant ? 'Saving...' : 'Save Variant'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
