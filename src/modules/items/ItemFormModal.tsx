import {
  IconChevronDown,
  IconChevronUp,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconWand,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import {
  ImageUpload,
  type UploadedImageItem,
} from '../../components/upload/ImageUpload';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import { convertToBaseQty } from '../../core/units';
import type {
  BrandRecord,
  ItemCatalogRecord,
  ItemCategoryRecord,
  ItemImageRecord,
  ItemType,
  ItemUnitRecord,
  PriceTier,
  UnitConversionRecord,
  WholesaleSlab,
} from '../../types/bizone';

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

interface ItemFormModalProps {
  open: boolean;
  item?: ItemCatalogRecord | null;
  categories: ItemCategoryRecord[];
  brands: BrandRecord[];
  units: ItemUnitRecord[];
  initialConversions?: UnitConversionRecord[];
  initialImages?: ItemImageRecord[];
  onClose: () => void;
  onSaved: (itemId: string) => Promise<void> | void;
  onTaxonomyUpdated: () => Promise<void> | void;
}

interface ConversionDraft {
  localId: string;
  alternate_unit_id: string;
  conversion_factor: string;
}

export function ItemFormModal({
  open,
  item,
  categories,
  brands,
  units,
  initialConversions = [],
  initialImages = [],
  onClose,
  onSaved,
  onTaxonomyUpdated,
}: ItemFormModalProps) {
  const { business, profile, session, signedUrlCache, language, showToast, t } =
    useApp();

  const canViewCost = hasCapability(profile?.role, 'view_profit');
  const uploadedDuringSessionRef = useRef<Set<string>>(new Set());

  const [name, setName] = useState('');
  const [itemType, setItemType] = useState<ItemType>('goods');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [baseUnitId, setBaseUnitId] = useState('');

  const [sellingPrice, setSellingPrice] = useState('');
  const [mrp, setMrp] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [gstRate, setGstRate] = useState('0');
  const [hsnCode, setHsnCode] = useState('');
  const [taxInclusive, setTaxInclusive] = useState(false);

  const [openingStock, setOpeningStock] = useState('0');
  const [openingUnitId, setOpeningUnitId] = useState('');
  const [lowStockAlert, setLowStockAlert] = useState('0');
  const [allowNegativeStock, setAllowNegativeStock] = useState(false);
  const [notes, setNotes] = useState('');
  const [packMeta, setPackMeta] = useState<Record<string, string>>({});
  const [wholesaleSlabs, setWholesaleSlabs] = useState<
    Array<{ localId: string; min_qty: string; tier: PriceTier; rate: string }>
  >([]);

  const [conversions, setConversions] = useState<ConversionDraft[]>([]);
  const [images, setImages] = useState<UploadedImageItem[]>([]);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inlineAddType, setInlineAddType] = useState<'category' | 'brand' | null>(
    null
  );
  const [inlineAddName, setInlineAddName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultPcsId = useMemo(
    () => units.find((u) => u.code === 'PCS')?.id || units[0]?.id || '',
    [units]
  );

  const initStampRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initStampRef.current = null;
      return;
    }

    const nextStamp = `${item?.id ?? 'new'}:${item?.version ?? 0}`;
    if (initStampRef.current === nextStamp) return;
    initStampRef.current = nextStamp;

    uploadedDuringSessionRef.current = new Set();
    setError(null);
    setInlineAddType(null);
    setInlineAddName('');

    if (item) {
      setName(item.name);
      setItemType(item.item_type === 'service' ? 'service' : 'goods');
      setSku(item.sku || '');
      setBarcode(item.barcode || '');
      setCategoryId(item.category_id || '');
      setBrandId(item.brand_id || '');
      setBaseUnitId(item.base_unit_id || defaultPcsId);
      setSellingPrice(String(item.selling_price ?? 0));
      setMrp(item.mrp !== null && item.mrp !== undefined ? String(item.mrp) : '');
      setPurchasePrice(
        item.purchase_price !== null && item.purchase_price !== undefined
          ? String(item.purchase_price)
          : ''
      );
      setGstRate(String(item.gst_rate ?? 0));
      setHsnCode(item.hsn_code || '');
      setTaxInclusive(Boolean(item.tax_inclusive));
      setOpeningStock('0');
      setOpeningUnitId(item.base_unit_id || defaultPcsId);
      setLowStockAlert(String(item.low_stock_alert ?? 0));
      setAllowNegativeStock(Boolean(item.allow_negative_stock));
      setNotes(item.notes || '');

      const pm: Record<string, string> = {};
      if (item.pack_metadata && typeof item.pack_metadata === 'object') {
        for (const [k, v] of Object.entries(item.pack_metadata)) {
          if (v !== null && v !== undefined) pm[k] = String(v);
        }
      }
      setPackMeta(pm);

      const slabsRaw = Array.isArray(item.wholesale_slabs) ? item.wholesale_slabs : [];
      setWholesaleSlabs(
        slabsRaw.map((s) => ({
          localId: crypto.randomUUID(),
          min_qty: String(s.min_qty ?? 1),
          tier: (s.tier || 'standard') as PriceTier,
          rate: String(s.rate ?? 0),
        }))
      );

      setConversions(
        initialConversions.map((c) => ({
          localId: c.id || crypto.randomUUID(),
          alternate_unit_id: c.alternate_unit_id,
          conversion_factor: String(c.conversion_factor),
        }))
      );
      setImages(
        [...initialImages]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((img) => ({
            fileId: img.file_id,
            url: signedUrlCache[img.file_id] || '',
            fileName: img.files?.file_name || 'item-image',
            isPrimary: img.is_primary,
          }))
      );
      setShowAdvanced(Boolean(item.allow_negative_stock || item.notes || Object.keys(pm).length > 0));
    } else {
      setName('');
      setItemType(business?.pack === 'service' ? 'service' : 'goods');
      setSku('');
      setBarcode('');
      setCategoryId('');
      setBrandId('');
      setBaseUnitId(defaultPcsId);
      setSellingPrice('');
      setMrp('');
      setPurchasePrice('');
      setGstRate('0');
      setHsnCode('');
      setTaxInclusive(business?.tax_mode === 'inclusive');
      setOpeningStock('0');
      setOpeningUnitId(defaultPcsId);
      setLowStockAlert('0');
      setAllowNegativeStock(false);
      setNotes('');
      setPackMeta({});
      setWholesaleSlabs([]);
      setConversions([]);
      setImages([]);
      setShowAdvanced(
        Boolean(
          business?.pack &&
            ['medical', 'hardware', 'kirana', 'clothing', 'service'].includes(
              business.pack
            )
        )
      );
    }
  }, [
    open,
    item,
    defaultPcsId,
    business?.tax_mode,
    business?.pack,
    initialConversions,
    initialImages,
    signedUrlCache,
  ]);

  useEffect(() => {
    if (!open) return;
    setImages((prev) => {
      let changed = false;
      const next = prev.map((img) => {
        if (!img.url && signedUrlCache[img.fileId]) {
          changed = true;
          return { ...img, url: signedUrlCache[img.fileId] };
        }
        return img;
      });
      return changed ? next : prev;
    });
  }, [open, signedUrlCache]);

  if (!open) return null;

  const handleCancel = async () => {
    const drafts = Array.from(uploadedDuringSessionRef.current);
    if (drafts.length > 0 && session?.access_token) {
      await fetch('/api/files/cleanup-orphans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ fileIds: drafts }),
      }).catch(() => undefined);
    }
    onClose();
  };

  const handleGenerateBarcode = () => {
    const base = `${Date.now()}`.slice(-10);
    setBarcode(`890${base}`);
    if (!sku.trim()) {
      setSku(`SKU-${base.slice(-6)}`);
    }
  };

  const handleInlineCreateTaxonomy = async () => {
    const clean = inlineAddName.trim();
    if (!clean || !inlineAddType) return;
    try {
      if (inlineAddType === 'category') {
        const { data, error: rpcErr } = await supabase.rpc('save_item_category', {
          p_name: clean,
        });
        if (rpcErr) throw rpcErr;
        if (data?.id) setCategoryId(data.id);
      } else {
        const { data, error: rpcErr } = await supabase.rpc('save_brand', {
          p_name: clean,
        });
        if (rpcErr) throw rpcErr;
        if (data?.id) setBrandId(data.id);
      }
      setInlineAddName('');
      setInlineAddType(null);
      await onTaxonomyUpdated();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to add entry.',
        'error'
      );
    }
  };

  const handleAddConversion = () => {
    const available = units.find(
      (u) =>
        u.id !== baseUnitId &&
        !conversions.some((c) => c.alternate_unit_id === u.id)
    );
    if (!available) return;
    setConversions((prev) => [
      ...prev,
      {
        localId: crypto.randomUUID(),
        alternate_unit_id: available.id,
        conversion_factor: '10',
      },
    ]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Item name is required.');
      return;
    }
    if (!baseUnitId) {
      setError('Base unit is required.');
      return;
    }

    const sp = Number(sellingPrice || 0);
    const mrpVal = mrp.trim() ? Number(mrp) : null;
    const pp = purchasePrice.trim() ? Number(purchasePrice) : 0;
    const alertQty = Number(lowStockAlert || 0);
    const openQty = Number(openingStock || 0);

    if (!Number.isFinite(sp) || sp < 0) {
      setError('Selling price must be 0 or greater.');
      return;
    }
    if (mrpVal !== null && (!Number.isFinite(mrpVal) || mrpVal < 0)) {
      setError('MRP cannot be negative.');
      return;
    }
    if (canViewCost && (!Number.isFinite(pp) || pp < 0)) {
      setError('Purchase cost cannot be negative.');
      return;
    }
    if (!Number.isFinite(alertQty) || alertQty < 0) {
      setError('Low stock alert level cannot be negative.');
      return;
    }
    if (!item && (!Number.isFinite(openQty) || openQty < 0)) {
      setError('Opening stock cannot be negative.');
      return;
    }

    const cleanConvs: Array<{
      alternate_unit_id: string;
      conversion_factor: number;
    }> = [];
    for (const c of conversions) {
      if (!c.alternate_unit_id) continue;
      if (c.alternate_unit_id === baseUnitId) {
        setError('Alternate unit cannot be identical to base unit.');
        return;
      }
      if (cleanConvs.some((x) => x.alternate_unit_id === c.alternate_unit_id)) {
        setError('Duplicate alternate unit conversion.');
        return;
      }
      const factor = Number(c.conversion_factor);
      if (!Number.isFinite(factor) || factor <= 0) {
        setError('Conversion factor must be greater than zero.');
        return;
      }
      cleanConvs.push({
        alternate_unit_id: c.alternate_unit_id,
        conversion_factor: factor,
      });
    }

    if (!item && openQty > 0) {
      const selectedBase = units.find((u) => u.id === baseUnitId);
      try {
        convertToBaseQty({
          qty: openQty,
          unitId: openingUnitId || baseUnitId,
          baseUnitId,
          baseAllowDecimal: selectedBase?.allow_decimal ?? true,
          conversions: cleanConvs,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid opening stock quantity.');
        return;
      }
    }

    const cleanImages = images.map((img, idx) => ({
      file_id: img.fileId,
      sort_order: idx,
      is_primary: img.isPrimary ?? idx === 0,
    }));

    const cleanPackMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(packMeta)) {
      if (v.trim()) cleanPackMeta[k] = v.trim();
    }

    const cleanSlabs: WholesaleSlab[] = [];
    for (const s of wholesaleSlabs) {
      const mq = Number(s.min_qty);
      const rt = Number(s.rate);
      if (!Number.isFinite(mq) || mq <= 0 || !Number.isFinite(rt) || rt < 0) {
        setError('Wholesale slab min qty must be > 0 and rate >= 0.');
        return;
      }
      cleanSlabs.push({ min_qty: mq, tier: s.tier, rate: rt });
    }

    const isService = itemType === 'service';

    setSaving(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('save_item', {
        p_id: item?.id ?? null,
        p_name: name.trim(),
        p_sku: sku.trim() || null,
        p_barcode: barcode.trim() || null,
        p_category_id: categoryId || null,
        p_brand_id: brandId || null,
        p_base_unit_id: baseUnitId,
        p_selling_price: sp,
        p_mrp: mrpVal,
        p_purchase_price: canViewCost ? pp : null,
        p_gst_rate: Number(gstRate || 0),
        p_hsn_code: hsnCode.trim() || null,
        p_tax_inclusive: taxInclusive,
        p_low_stock_alert: isService ? 0 : alertQty,
        p_allow_negative_stock: isService ? true : allowNegativeStock,
        p_opening_stock: item || isService ? 0 : Math.max(0, openQty),
        p_opening_unit_id: item || isService ? null : openingUnitId || baseUnitId,
        p_pack_metadata: cleanPackMeta,
        p_notes: notes.trim() || null,
        p_conversions: cleanConvs,
        p_images: cleanImages,
        p_expected_version: item?.version ?? null,
        p_item_type: itemType,
        p_wholesale_slabs: cleanSlabs,
      });

      if (rpcErr) throw rpcErr;

      // Clean up any replaced/removed images cleanly
      const removedIds: string[] = Array.isArray(data?.removed_file_ids)
        ? data.removed_file_ids
        : [];
      const abandonedDrafts = Array.from(uploadedDuringSessionRef.current).filter(
        (fid) => !cleanImages.some((ci) => ci.file_id === fid)
      );
      const toDelete = Array.from(new Set([...removedIds, ...abandonedDrafts]));

      if (toDelete.length > 0 && session?.access_token) {
        await Promise.all(
          toDelete.map((fid) =>
            fetch(`/api/files/${encodeURIComponent(fid)}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${session.access_token}` },
            }).catch(() => undefined)
          )
        );
      }

      uploadedDuringSessionRef.current.clear();
      showToast(
        item
          ? language === 'hi'
            ? 'सामान अपडेट हो गया।'
            : 'Item updated.'
          : language === 'hi'
            ? 'सामान जोड़ा गया।'
            : 'Item created.',
        'success'
      );
      await onSaved(data.id);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save item.';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const baseUnitObj = units.find((u) => u.id === baseUnitId);
  const openingSelectableUnits = [
    ...(baseUnitObj ? [baseUnitObj] : []),
    ...conversions
      .map((c) => units.find((u) => u.id === c.alternate_unit_id))
      .filter((u): u is ItemUnitRecord => Boolean(u)),
  ];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center p-0 md:p-4"
      onClick={() => void handleCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={item ? t('items.editItem') : t('items.addItem')}
        className="w-full md:max-w-3xl max-h-[92vh] rounded-t-2xl md:rounded-2xl bg-[var(--surface)] border border-[var(--border)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">
            {item ? t('items.editItem') : t('items.addItem')}
          </h2>
          <button
            type="button"
            onClick={() => void handleCancel()}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs text-[var(--give)]">
              {error}
            </div>
          )}

          {/* Item Type & Core Identity */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 pb-1">
              <div className="inline-flex rounded-lg border border-[var(--border)] overflow-hidden">
                {(
                  [
                    { id: 'goods', label: language === 'hi' ? 'सामान (Goods / Stock)' : 'Goods (Tracked Stock)' },
                    { id: 'service', label: language === 'hi' ? 'सेवा (Service / No Stock)' : 'Service (Non-Stock)' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setItemType(opt.id)}
                    className={`h-9 px-3 text-xs font-medium ${
                      itemType === opt.id
                        ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                        : 'bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {itemType === 'service' && (
                <span className="text-[11px] text-[var(--text-muted)]">
                  Stock deduction skipped automatically on bills
                </span>
              )}
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium mb-1">
                {t('items.name')} *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={itemType === 'service' ? 'e.g., AC Servicing & Gas Refill' : 'e.g., Fortune Mustard Oil 1L'}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                required
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium">{t('items.category')}</label>
                <button
                  type="button"
                  onClick={() =>
                    setInlineAddType(inlineAddType === 'category' ? null : 'category')
                  }
                  className="text-[11px] font-medium text-[var(--primary-dark)] inline-flex items-center gap-0.5"
                >
                  <IconPlus size={12} stroke={2.5} />
                  <span>New</span>
                </button>
              </div>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium">{t('items.brand')}</label>
                <button
                  type="button"
                  onClick={() =>
                    setInlineAddType(inlineAddType === 'brand' ? null : 'brand')
                  }
                  className="text-[11px] font-medium text-[var(--primary-dark)] inline-flex items-center gap-0.5"
                >
                  <IconPlus size={12} stroke={2.5} />
                  <span>New</span>
                </button>
              </div>
              <select
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="">No Brand</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            {inlineAddType && (
              <div className="sm:col-span-2 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] flex items-center gap-2">
                <input
                  type="text"
                  value={inlineAddName}
                  onChange={(e) => setInlineAddName(e.target.value)}
                  placeholder={
                    inlineAddType === 'category'
                      ? 'New category name...'
                      : 'New brand name...'
                  }
                  className="flex-1 h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
                <button
                  type="button"
                  onClick={handleInlineCreateTaxonomy}
                  className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setInlineAddType(null)}
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] text-xs"
                >
                  {t('common.cancel')}
                </button>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium mb-1">
                {t('items.sku')}
              </label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value.toUpperCase())}
                placeholder="e.g., OIL-001"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium">{t('items.barcode')}</label>
                <button
                  type="button"
                  onClick={handleGenerateBarcode}
                  className="text-[11px] font-medium text-[var(--primary-dark)] inline-flex items-center gap-1"
                >
                  <IconWand size={12} stroke={2} />
                  <span>{t('items.generateCode')}</span>
                </button>
              </div>
              <input
                type="text"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value.toUpperCase())}
                placeholder="Scan or enter barcode"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
              />
            </div>
          </div>

          {/* Pricing & GST */}
          <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/60 space-y-3.5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">
                  {t('items.sellingPrice')} *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={sellingPrice}
                  onChange={(e) => setSellingPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">
                  {t('items.mrp')}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={mrp}
                  onChange={(e) => setMrp(e.target.value)}
                  placeholder="Optional"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                />
              </div>

              {canViewCost && (
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('items.purchasePrice')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={purchasePrice}
                    onChange={(e) => setPurchasePrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium mb-1">
                  {t('items.gstRate')}
                </label>
                <select
                  value={gstRate}
                  onChange={(e) => setGstRate(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                >
                  {GST_RATES.map((r) => (
                    <option key={r} value={r}>
                      {r}%
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
              <div>
                <label className="block text-xs font-medium mb-1">
                  {itemType === 'service' ? 'SAC / HSN Code' : t('items.hsnCode')}
                </label>
                <input
                  type="text"
                  value={hsnCode}
                  onChange={(e) => setHsnCode(e.target.value)}
                  placeholder={itemType === 'service' ? 'e.g., 998714' : 'e.g., 1514'}
                  className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                />
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-medium pt-4">
                <input
                  type="checkbox"
                  checked={taxInclusive}
                  onChange={(e) => setTaxInclusive(e.target.checked)}
                />
                <span>{t('items.taxInclusive')}</span>
              </label>
            </div>

            {(business?.pack === 'wholesale' || wholesaleSlabs.length > 0) && (
              <div className="pt-3 border-t border-[var(--border)] space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold">
                    Wholesale Tier &amp; Bulk Qty Slabs
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setWholesaleSlabs((prev) => [
                        ...prev,
                        {
                          localId: crypto.randomUUID(),
                          min_qty: '10',
                          tier: 'standard',
                          rate: sellingPrice || '0',
                        },
                      ])
                    }
                    className="text-xs font-medium text-[var(--primary-dark)] inline-flex items-center gap-1"
                  >
                    <IconPlus size={14} stroke={2.5} />
                    <span>Add Price Slab</span>
                  </button>
                </div>
                {wholesaleSlabs.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Define min-qty or party-tier rates (Standard / Wholesale A / Wholesale B / VIP).
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {wholesaleSlabs.map((slab) => (
                      <div key={slab.localId} className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-3">
                          <input
                            type="number"
                            min="1"
                            step="any"
                            value={slab.min_qty}
                            onChange={(e) =>
                              setWholesaleSlabs((prev) =>
                                prev.map((r) =>
                                  r.localId === slab.localId ? { ...r, min_qty: e.target.value } : r
                                )
                              )
                            }
                            placeholder="Min Qty"
                            className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                          />
                        </div>
                        <div className="col-span-4">
                          <select
                            value={slab.tier}
                            onChange={(e) =>
                              setWholesaleSlabs((prev) =>
                                prev.map((r) =>
                                  r.localId === slab.localId
                                    ? { ...r, tier: e.target.value as PriceTier }
                                    : r
                                )
                              )
                            }
                            className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                          >
                            <option value="standard">All / Standard</option>
                            <option value="wholesale_a">Wholesale A</option>
                            <option value="wholesale_b">Wholesale B</option>
                            <option value="vip">VIP</option>
                          </select>
                        </div>
                        <div className="col-span-4">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={slab.rate}
                            onChange={(e) =>
                              setWholesaleSlabs((prev) =>
                                prev.map((r) =>
                                  r.localId === slab.localId ? { ...r, rate: e.target.value } : r
                                )
                              )
                            }
                            placeholder="Rate ₹"
                            className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                          />
                        </div>
                        <div className="col-span-1 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setWholesaleSlabs((prev) =>
                                prev.filter((r) => r.localId !== slab.localId)
                              )
                            }
                            aria-label="Remove slab"
                            className="p-1.5 rounded text-[var(--give)] hover:bg-[var(--give-soft)]"
                          >
                            <IconTrash size={14} stroke={2} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Units, Conversions & Stock */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">
                  {t('items.baseUnit')} *
                </label>
                <select
                  value={baseUnitId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setBaseUnitId(nextId);
                    setConversions((prev) =>
                      prev.filter((row) => row.alternate_unit_id !== nextId)
                    );
                    if (
                      !openingUnitId ||
                      openingUnitId === baseUnitId ||
                      openingUnitId === nextId
                    ) {
                      setOpeningUnitId(nextId);
                    }
                  }}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  required
                >
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code} · {language === 'hi' ? u.name_hi : u.name_en}
                    </option>
                  ))}
                </select>
              </div>

              {!item && itemType === 'goods' && (
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('items.openingStock')}
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      step="any"
                      min="0"
                      inputMode="decimal"
                      value={openingStock}
                      onChange={(e) => setOpeningStock(e.target.value)}
                      className="flex-1 min-w-0 h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                    />
                    <select
                      value={openingUnitId || baseUnitId}
                      onChange={(e) => setOpeningUnitId(e.target.value)}
                      className="w-24 h-11 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium"
                    >
                      {openingSelectableUnits.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.code}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {itemType === 'goods' && (
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('items.lowStockAlert')}
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    value={lowStockAlert}
                    onChange={(e) => setLowStockAlert(e.target.value)}
                    className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
              )}
            </div>

            {/* Alternate unit conversions */}
            <div className="p-3.5 rounded-xl border border-[var(--border)] space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {t('items.alternateUnits')}
                </span>
                <button
                  type="button"
                  onClick={handleAddConversion}
                  className="text-xs font-medium text-[var(--primary-dark)] inline-flex items-center gap-1"
                >
                  <IconPlus size={14} stroke={2.5} />
                  <span>{t('items.addConversion')}</span>
                </button>
              </div>

              {conversions.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Optional: Define bulk packs such as 1 Box = 12{' '}
                  {baseUnitObj?.code || 'PCS'}.
                </p>
              ) : (
                <div className="space-y-2">
                  {conversions.map((conv) => (
                    <div
                      key={conv.localId}
                      className="flex flex-wrap items-center gap-2 text-xs"
                    >
                      <span className="text-[var(--text-muted)]">1</span>
                      <select
                        value={conv.alternate_unit_id}
                        onChange={(e) => {
                          const nextAltId = e.target.value;
                          setConversions((prev) =>
                            prev.map((row) =>
                              row.localId === conv.localId
                                ? { ...row, alternate_unit_id: nextAltId }
                                : row
                            )
                          );
                          if (openingUnitId === conv.alternate_unit_id) {
                            setOpeningUnitId(nextAltId || baseUnitId);
                          }
                        }}
                        className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      >
                        {units
                          .filter((u) => u.id !== baseUnitId)
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.code} · {language === 'hi' ? u.name_hi : u.name_en}
                            </option>
                          ))}
                      </select>
                      <span className="text-[var(--text-muted)]">=</span>
                      <input
                        type="number"
                        step="any"
                        min="0.0001"
                        inputMode="decimal"
                        value={conv.conversion_factor}
                        onChange={(e) =>
                          setConversions((prev) =>
                            prev.map((row) =>
                              row.localId === conv.localId
                                ? { ...row, conversion_factor: e.target.value }
                                : row
                            )
                          )
                        }
                        className="w-24 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                      />
                      <span className="font-mono font-medium">
                        {baseUnitObj?.code || 'BASE'}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setConversions((prev) =>
                            prev.filter((row) => row.localId !== conv.localId)
                          );
                          if (openingUnitId === conv.alternate_unit_id) {
                            setOpeningUnitId(baseUnitId);
                          }
                        }}
                        aria-label="Remove conversion"
                        className="p-1.5 rounded text-[var(--give)] hover:bg-[var(--give-soft)] ml-auto"
                      >
                        <IconTrash size={14} stroke={2} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Multi-Image Gallery Manager */}
          <ImageUpload
            label={t('items.photos')}
            purpose="item_image"
            multiple={true}
            deferDelete={true}
            maxFiles={8}
            value={images}
            onChange={setImages}
            onUploaded={(nextList) => {
              for (const entry of nextList) {
                if (!initialImages.some((orig) => orig.file_id === entry.fileId)) {
                  uploadedDuringSessionRef.current.add(entry.fileId);
                }
              }
            }}
            helperText={t('items.photosHelp')}
          />

          {/* Collapsible Advanced / Pack-Specific Options */}
          <div className="border border-[var(--border)] rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full px-4 py-3 bg-[var(--surface-muted)]/60 flex items-center justify-between text-xs font-semibold"
            >
              <span>Stock Policy, Pack Details & Notes</span>
              {showAdvanced ? (
                <IconChevronUp size={16} stroke={2} />
              ) : (
                <IconChevronDown size={16} stroke={2} />
              )}
            </button>
            {showAdvanced && (
              <div className="p-4 space-y-3.5 border-t border-[var(--border)]">
                {itemType === 'goods' && (
                  <label className="inline-flex items-center gap-2 text-xs font-medium">
                    <input
                      type="checkbox"
                      checked={allowNegativeStock}
                      onChange={(e) => setAllowNegativeStock(e.target.checked)}
                    />
                    <span>{t('items.allowNegativeStock')}</span>
                  </label>
                )}

                {business?.pack === 'kirana' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Shelf / Rack Location
                      </label>
                      <input
                        type="text"
                        value={packMeta.shelf || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, shelf: e.target.value }))
                        }
                        placeholder="e.g., Rack A-2"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs font-medium pt-4">
                      <input
                        type="checkbox"
                        checked={packMeta.loose_weight === 'true'}
                        onChange={(e) =>
                          setPackMeta((p) => ({
                            ...p,
                            loose_weight: e.target.checked ? 'true' : '',
                          }))
                        }
                      />
                      <span>Enable Loose Weight (₹ ↔ Qty) Billing</span>
                    </label>
                  </div>
                )}

                {business?.pack === 'medical' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Salt / Generic Composition
                      </label>
                      <input
                        type="text"
                        value={packMeta.salt || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, salt: e.target.value }))
                        }
                        placeholder="e.g., Paracetamol 500mg"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Schedule Classification
                      </label>
                      <select
                        value={packMeta.schedule || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, schedule: e.target.value }))
                        }
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      >
                        <option value="">OTC / Normal</option>
                        <option value="H">Schedule H</option>
                        <option value="H1">Schedule H1</option>
                        <option value="X">Schedule X</option>
                        <option value="NRX">NRx</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Manufacturer / Lab
                      </label>
                      <input
                        type="text"
                        value={packMeta.manufacturer || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, manufacturer: e.target.value }))
                        }
                        placeholder="e.g., Cipla / Sun Pharma"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                  </div>
                )}

                {business?.pack === 'clothing' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Fabric / Material
                      </label>
                      <input
                        type="text"
                        value={packMeta.fabric || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, fabric: e.target.value }))
                        }
                        placeholder="e.g., 100% Cotton"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Collection / Season
                      </label>
                      <input
                        type="text"
                        value={packMeta.season || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, season: e.target.value }))
                        }
                        placeholder="e.g., Summer / Festive"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                  </div>
                )}

                {business?.pack === 'hardware' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Sq.Ft per Box / Coverage
                      </label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={packMeta.sqft_per_box || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, sqft_per_box: e.target.value }))
                        }
                        placeholder="e.g., 16"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Coverage Note
                      </label>
                      <input
                        type="text"
                        value={packMeta.coverage || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, coverage: e.target.value }))
                        }
                        placeholder="e.g., 110 sq.ft / L"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Warranty Months
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={packMeta.warranty_months || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({
                            ...p,
                            warranty_months: e.target.value,
                          }))
                        }
                        placeholder="e.g., 12"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                      />
                    </div>
                  </div>
                )}

                {(business?.pack === 'service' || itemType === 'service') && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        SAC Code
                      </label>
                      <input
                        type="text"
                        value={packMeta.sac_code || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, sac_code: e.target.value }))
                        }
                        placeholder="e.g., 998714"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Est. Duration (Minutes)
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={packMeta.duration_mins || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({
                            ...p,
                            duration_mins: e.target.value,
                          }))
                        }
                        placeholder="e.g., 60"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('items.notes')}
                  </label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional shelf location, supplier note, or description"
                    className="w-full p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={() => void handleCancel()}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5"
            >
              {saving && <IconLoader2 size={16} className="animate-spin" />}
              <span>{t('items.saveItem')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
