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
import type {
  BrandRecord,
  ItemCatalogRecord,
  ItemCategoryRecord,
  ItemImageRecord,
  ItemUnitRecord,
  UnitConversionRecord,
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

  useEffect(() => {
    if (!open) return;
    uploadedDuringSessionRef.current = new Set();
    setError(null);
    setInlineAddType(null);
    setInlineAddName('');

    if (item) {
      setName(item.name);
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

      setConversions(
        initialConversions.map((c) => ({
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
      setConversions([]);
      setImages([]);
      setShowAdvanced(false);
    }
  }, [
    open,
    item,
    defaultPcsId,
    business?.tax_mode,
    initialConversions,
    initialImages,
    signedUrlCache,
  ]);

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
      { alternate_unit_id: available.id, conversion_factor: '10' },
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

    const cleanImages = images.map((img, idx) => ({
      file_id: img.fileId,
      sort_order: idx,
      is_primary: img.isPrimary ?? idx === 0,
    }));

    const cleanPackMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(packMeta)) {
      if (v.trim()) cleanPackMeta[k] = v.trim();
    }

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
        p_low_stock_alert: alertQty,
        p_allow_negative_stock: allowNegativeStock,
        p_opening_stock: item ? 0 : Math.max(0, openQty),
        p_opening_unit_id: item ? null : openingUnitId || baseUnitId,
        p_pack_metadata: cleanPackMeta,
        p_notes: notes.trim() || null,
        p_conversions: cleanConvs,
        p_images: cleanImages,
        p_expected_version: item?.version ?? null,
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

          {/* Core Identity */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium mb-1">
                {t('items.name')} *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Fortune Mustard Oil 1L"
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
                  {t('items.hsnCode')}
                </label>
                <input
                  type="text"
                  value={hsnCode}
                  onChange={(e) => setHsnCode(e.target.value)}
                  placeholder="e.g., 1514"
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
                    if (!openingUnitId || openingUnitId === baseUnitId) {
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

              {!item && (
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
                  {conversions.map((conv, idx) => (
                    <div
                      key={idx}
                      className="flex flex-wrap items-center gap-2 text-xs"
                    >
                      <span className="text-[var(--text-muted)]">1</span>
                      <select
                        value={conv.alternate_unit_id}
                        onChange={(e) =>
                          setConversions((prev) =>
                            prev.map((row, i) =>
                              i === idx
                                ? { ...row, alternate_unit_id: e.target.value }
                                : row
                            )
                          )
                        }
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
                            prev.map((row, i) =>
                              i === idx
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
                        onClick={() =>
                          setConversions((prev) =>
                            prev.filter((_, i) => i !== idx)
                          )
                        }
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
                <label className="inline-flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={allowNegativeStock}
                    onChange={(e) => setAllowNegativeStock(e.target.checked)}
                  />
                  <span>{t('items.allowNegativeStock')}</span>
                </label>

                {business?.pack === 'medical' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                      </select>
                    </div>
                  </div>
                )}

                {business?.pack === 'hardware' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Coverage / Dimension (e.g. Sq Ft per Box)
                      </label>
                      <input
                        type="text"
                        value={packMeta.coverage || ''}
                        onChange={(e) =>
                          setPackMeta((p) => ({ ...p, coverage: e.target.value }))
                        }
                        placeholder="e.g., 14 sq ft"
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
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
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
