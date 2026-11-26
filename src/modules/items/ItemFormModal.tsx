import {
  IconArrowsExchange,
  IconBuildingStore,
  IconCamera,
  IconChevronDown,
  IconChevronUp,
  IconLoader2,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconWand,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { BarcodeScannerModal } from '../../components/barcode/BarcodeScannerModal';
import {
  ImageUpload,
  type UploadedImageItem,
} from '../../components/upload/ImageUpload';
import { formatINR } from '../../core/format';
import { convertRateTaxMode, roundHalfUp } from '../../core/money';
import { hasCapability } from '../../core/permissions';
import {
  PRODUCT_LINES,
  filterTaxonomyByProductLine,
  getProductLineMeta,
  isValidProductLine,
  type ProductLineKey,
} from '../../core/productLines';
import {
  createEmptyServiceSpecs,
  createEmptySpecs,
  formatItemSpecSummary,
  formatServiceSpecSummary,
  normalizeServiceSpecsFromMetadata,
  normalizeSpecsFromRecord,
  SQFT_PER_SQM,
  validateProductSpecs,
  validateServiceSpecs,
  type AnySpecsMap,
  type ServiceSpecs,
} from '../../core/productSpecs';
import { erpFetch } from '../../core/erpFetch';
import { supabase } from '../../core/supabase';
import { convertToBaseQty } from '../../core/units';
import type {
  BrandRecord,
  ItemCatalogRecord,
  ItemCategoryRecord,
  ItemImageRecord,
  ItemType,
  ItemUnitRecord,
  UnitConversionRecord,
} from '../../types/decorbiz';
import { ProductSpecFields, ServiceSpecFields } from './ProductSpecFields';

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

interface ItemFormModalProps {
  open: boolean;
  item?: ItemCatalogRecord | null;
  initialProductLine?: ProductLineKey;
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
  initialProductLine = 'tiles_slabs',
  categories,
  brands,
  units,
  initialConversions = [],
  initialImages = [],
  onClose,
  onSaved,
  onTaxonomyUpdated,
}: ItemFormModalProps) {
  const { business, profile, session, signedUrlCache, isModuleEnabled, language, showToast, t } =
    useApp();

  const canViewCost = hasCapability(profile?.role, 'view_profit');
  const partiesEnabled = isModuleEnabled('parties');
  const onlineStoreEnabled = isModuleEnabled('online_store');
  const aiEnabled = isModuleEnabled('ai');
  const uploadedDuringSessionRef = useRef<Set<string>>(new Set());

  const [name, setName] = useState('');
  const [itemType, setItemType] = useState<ItemType>('goods');
  const [productLine, setProductLine] = useState<ProductLineKey>(initialProductLine);
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [baseUnitId, setBaseUnitId] = useState('');

  const [supplierId, setSupplierId] = useState('');
  const [suppliersList, setSuppliersList] = useState<Array<{ id: string; name: string }>>([]);
  const [countryOfOrigin, setCountryOfOrigin] = useState('');
  const [warrantyMonths, setWarrantyMonths] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [description, setDescription] = useState('');

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
  const [specs, setSpecs] = useState<AnySpecsMap>(() => createEmptySpecs(initialProductLine));
  const [specErrors, setSpecErrors] = useState<Record<string, string>>({});
  const [serviceSpecs, setServiceSpecs] = useState<ServiceSpecs>(() => createEmptyServiceSpecs());
  const [serviceSpecErrors, setServiceSpecErrors] = useState<Record<string, string>>({});

  // Online Store / E-Commerce Publishing
  const [publishOnline, setPublishOnline] = useState(false);
  const [onlinePrice, setOnlinePrice] = useState('');
  const [onlineSlug, setOnlineSlug] = useState('');
  const [onlineDescription, setOnlineDescription] = useState('');
  const [aiStoreDrafting, setAiStoreDrafting] = useState(false);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inlineAddType, setInlineAddType] = useState<'category' | 'brand' | null>(
    null
  );
  const [inlineAddName, setInlineAddName] = useState('');
  const [barcodeScannerOpen, setBarcodeScannerOpen] = useState(false);
  const [aiFilling, setAiFilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultPcsId = useMemo(
    () => units.find((u) => u.code === 'PCS')?.id || units[0]?.id || '',
    [units]
  );

  const scopedCategories = useMemo(() => {
    if (itemType === 'service') return categories;
    const filtered = filterTaxonomyByProductLine(categories, productLine);
    if (categoryId && !filtered.some((c) => c.id === categoryId)) {
      const curr = categories.find((c) => c.id === categoryId);
      if (curr) return [curr, ...filtered];
    }
    return filtered;
  }, [categories, productLine, categoryId, itemType]);

  const scopedBrands = useMemo(() => {
    if (itemType === 'service') return brands;
    const filtered = filterTaxonomyByProductLine(brands, productLine);
    if (brandId && !filtered.some((b) => b.id === brandId)) {
      const curr = brands.find((b) => b.id === brandId);
      if (curr) return [curr, ...filtered];
    }
    return filtered;
  }, [brands, productLine, brandId, itemType]);

  const scopedUnits = useMemo(() => {
    if (itemType === 'service') {
      const preferredCodes = new Set(['NOS', 'PCS', 'HRS', 'DAY', 'SQFT', 'SQM', 'JOB', 'SET']);
      const serviceUnits = units.filter((u) => preferredCodes.has(u.code.toUpperCase()));
      const list = serviceUnits.length > 0 ? serviceUnits : units;
      if (baseUnitId && !list.some((u) => u.id === baseUnitId)) {
        const curr = units.find((u) => u.id === baseUnitId);
        if (curr) return [curr, ...list];
      }
      return list;
    }
    const filtered = filterTaxonomyByProductLine(units, productLine);
    if (baseUnitId && !filtered.some((u) => u.id === baseUnitId)) {
      const curr = units.find((u) => u.id === baseUnitId);
      if (curr) return [curr, ...filtered];
    }
    return filtered;
  }, [units, productLine, baseUnitId, itemType]);

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
      const resolvedLine = isValidProductLine(item.product_line)
        ? item.product_line
        : 'other_general';
      setName(item.name);
      setItemType(item.item_type === 'service' ? 'service' : 'goods');
      setProductLine(resolvedLine);
      setSku(item.sku || '');
      setBarcode(item.barcode || '');
      setCategoryId(item.category_id || '');
      setBrandId(item.brand_id || '');
      setBaseUnitId(item.base_unit_id || defaultPcsId);
      setSupplierId(item.supplier_id || '');
      setCountryOfOrigin(item.country_of_origin || '');
      setWarrantyMonths(
        item.warranty_months !== null && item.warranty_months !== undefined
          ? String(item.warranty_months)
          : ''
      );
      setVideoUrl(item.video_url || '');
      setDescription(item.description || '');
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
          if (k === 'service_specs' || (typeof v === 'object' && v !== null)) continue;
          if (v !== null && v !== undefined) pm[k] = String(v);
        }
      }
      setPackMeta(pm);
      setSpecs(
        normalizeSpecsFromRecord(resolvedLine, item.specs, {
          itemName: item.name,
          unitCode: item.base_unit_code,
        })
      );
      setSpecErrors({});
      setServiceSpecs(normalizeServiceSpecsFromMetadata(item.pack_metadata, item.hsn_code));
      setServiceSpecErrors({});

      setPublishOnline(Boolean(item.is_published_online));
      setOnlinePrice(
        item.online_price !== null && item.online_price !== undefined ? String(item.online_price) : ''
      );
      setOnlineSlug(item.online_slug || '');
      setOnlineDescription(item.online_description || '');

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
      setShowAdvanced(
        Boolean(
          item.allow_negative_stock ||
            item.notes ||
            item.supplier_id ||
            item.country_of_origin ||
            item.warranty_months !== null ||
            item.video_url ||
            item.description ||
            Object.keys(pm).length > 0
        )
      );
    } else {
      const lineMeta = getProductLineMeta(initialProductLine);
      const suggestedUnitObj =
        units.find((u) => u.code === lineMeta.defaultUnitCode) || units.find((u) => u.id === defaultPcsId);
      const suggestedUnitId = suggestedUnitObj?.id || defaultPcsId;
      setName('');
      setItemType('goods');
      setProductLine(lineMeta.key);
      setSku('');
      setBarcode('');
      setCategoryId('');
      setBrandId('');
      setBaseUnitId(suggestedUnitId);
      setSupplierId('');
      setCountryOfOrigin('India');
      setWarrantyMonths('');
      setVideoUrl('');
      setDescription('');
      setSellingPrice('');
      setMrp('');
      setPurchasePrice('');
      setGstRate(String(lineMeta.defaultGst));
      setHsnCode(lineMeta.defaultHsn);
      setTaxInclusive(business?.tax_mode === 'inclusive');
      setOpeningStock('0');
      setOpeningUnitId(suggestedUnitId);
      setLowStockAlert('0');
      setAllowNegativeStock(false);
      setNotes('');
      setPackMeta({});
      setSpecs(
        createEmptySpecs(lineMeta.key, {
          itemName: '',
          unitCode: suggestedUnitObj?.code || lineMeta.defaultUnitCode,
        })
      );
      setSpecErrors({});
      setServiceSpecs(createEmptyServiceSpecs());
      setServiceSpecErrors({});
      setPublishOnline(false);
      setOnlinePrice('');
      setOnlineSlug('');
      setOnlineDescription('');
      setConversions([]);
      setImages([]);
      setShowAdvanced(true);
    }
  }, [
    open,
    item,
    initialProductLine,
    units,
    defaultPcsId,
    business?.tax_mode,
    initialConversions,
    initialImages,
    signedUrlCache,
  ]);

  useEffect(() => {
    if (!open || !partiesEnabled) return;
    let active = true;
    supabase
      .from('parties')
      .select('id, name, party_type')
      .eq('is_active', true)
      .in('party_type', ['supplier', 'both'])
      .order('name')
      .then(({ data }) => {
        if (!active || !data) return;
        setSuppliersList(data.map((r) => ({ id: r.id, name: r.name })));
      });
    return () => {
      active = false;
    };
  }, [open, partiesEnabled]);

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
      await erpFetch('/api/erp/files/cleanup-orphans', session.access_token, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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

  const handleAiAutoFill = async () => {
    if (!session?.access_token) return;
    let base64 = '';
    let mimeType = 'image/jpeg';

    if (!name.trim() && images.length > 0 && images[0]?.url) {
      try {
        const imgRes = await fetch(images[0].url);
        if (imgRes.ok) {
          const blob = await imgRes.blob();
          mimeType = blob.type || 'image/jpeg';
          base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => resolve('');
            reader.readAsDataURL(blob);
          });
        }
      } catch {
        // Ignore signed URL fetch errors cleanly
      }
    }

    if (!name.trim() && !base64) {
      showToast('Enter an item name or upload a product photo first.', 'error');
      return;
    }

    setAiFilling(true);
    try {
      const res = await erpFetch('/api/erp/ai/suggest-item', session.access_token, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: name.trim(),
          base64: base64 || undefined,
          mimeType: base64 ? mimeType : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'AI auto-fill failed.');

      const s = json.suggestion as {
        suggested_name?: string;
        category_name?: string;
        brand_name?: string | null;
        hsn_code?: string;
        gst_rate?: number;
        base_unit_code?: string;
        tax_inclusive?: boolean;
        mrp_hint?: number | null;
        selling_price_hint?: number | null;
        notes?: string | null;
      };

      if (!name.trim() && s.suggested_name) {
        setName(s.suggested_name);
      }
      if (s.hsn_code) {
        setHsnCode(String(s.hsn_code));
      }
      if (typeof s.gst_rate === 'number' && GST_RATES.includes(s.gst_rate)) {
        setGstRate(String(s.gst_rate));
      }
      if (typeof s.tax_inclusive === 'boolean') {
        setTaxInclusive(s.tax_inclusive);
      }
      if (s.base_unit_code) {
        const unitMatch = units.find(
          (u) => u.code.toUpperCase() === String(s.base_unit_code).trim().toUpperCase()
        );
        if (unitMatch) setBaseUnitId(unitMatch.id);
      }
      if (!mrp.trim() && typeof s.mrp_hint === 'number' && s.mrp_hint > 0) {
        setMrp(String(s.mrp_hint));
      }
      if (
        !sellingPrice.trim() &&
        typeof s.selling_price_hint === 'number' &&
        s.selling_price_hint > 0
      ) {
        setSellingPrice(String(s.selling_price_hint));
      }
      if (!notes.trim() && s.notes) {
        setNotes(s.notes);
      }

      let taxonomyChanged = false;
      if (s.category_name?.trim()) {
        const existingCat = categories.find(
          (c) =>
            c.name.trim().toLowerCase() === s.category_name!.trim().toLowerCase() &&
            (!c.product_line || c.product_line === 'all' || c.product_line === productLine)
        );
        if (existingCat) {
          setCategoryId(existingCat.id);
        } else {
          const { data: catData } = await supabase.rpc('save_item_category', {
            p_name: s.category_name.trim(),
            p_product_line: productLine,
          });
          if (catData?.id) {
            setCategoryId(catData.id);
            taxonomyChanged = true;
          }
        }
      }
      if (s.brand_name?.trim()) {
        const existingBrand = brands.find(
          (b) =>
            b.name.trim().toLowerCase() === s.brand_name!.trim().toLowerCase() &&
            (!b.product_line || b.product_line === 'all' || b.product_line === productLine)
        );
        if (existingBrand) {
          setBrandId(existingBrand.id);
        } else {
          const { data: brandData } = await supabase.rpc('save_brand', {
            p_name: s.brand_name.trim(),
            p_product_line: productLine,
          });
          if (brandData?.id) {
            setBrandId(brandData.id);
            taxonomyChanged = true;
          }
        }
      }
      if (taxonomyChanged) {
        await onTaxonomyUpdated();
      }
      showToast('AI filled HSN, GST slab, category, unit & tax mode.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI auto-fill failed.', 'error');
    } finally {
      setAiFilling(false);
    }
  };

  const handleProductLineChange = (nextLine: ProductLineKey) => {
    setProductLine(nextLine);
    let nextUnitCode = units.find((u) => u.id === baseUnitId)?.code || 'PCS';
    if (!item) {
      const meta = getProductLineMeta(nextLine);
      const nextUnitObj = units.find((u) => u.code === meta.defaultUnitCode);
      if (nextUnitObj) {
        setBaseUnitId(nextUnitObj.id);
        setOpeningUnitId(nextUnitObj.id);
        nextUnitCode = nextUnitObj.code;
      }
      setHsnCode(meta.defaultHsn);
      setGstRate(String(meta.defaultGst));
    }
    setCategoryId('');
    setBrandId('');
    setSpecs(createEmptySpecs(nextLine, { itemName: name, unitCode: nextUnitCode }));
    setSpecErrors({});
  };

  const handleItemTypeChange = (nextType: ItemType) => {
    setItemType(nextType);
    if (!item && nextType === 'service') {
      const preferredServiceUnit =
        units.find((u) => u.code === 'NOS') ||
        units.find((u) => u.code === 'PCS') ||
        units[0];
      if (preferredServiceUnit) {
        setBaseUnitId(preferredServiceUnit.id);
        setOpeningUnitId(preferredServiceUnit.id);
      }
      if (!hsnCode.trim() || ['6907', '6910', '8481', '3214', '6908'].includes(hsnCode.trim())) {
        setHsnCode('9954');
      }
      setGstRate('18');
      setServiceSpecErrors({});
    } else if (!item && nextType === 'goods') {
      const meta = getProductLineMeta(productLine);
      const nextUnitObj = units.find((u) => u.code === meta.defaultUnitCode);
      if (nextUnitObj) {
        setBaseUnitId(nextUnitObj.id);
        setOpeningUnitId(nextUnitObj.id);
      }
      setHsnCode(meta.defaultHsn);
      setGstRate(String(meta.defaultGst));
      setSpecErrors({});
    }
  };

  const handleAiDraftOnlineListing = async () => {
    if (!session?.access_token) return;
    if (!name.trim()) {
      showToast('Enter an item or service name first.', 'error');
      return;
    }
    setAiStoreDrafting(true);
    try {
      const categoryName = categories.find((c) => c.id === categoryId)?.name || '';
      const brandName = brands.find((b) => b.id === brandId)?.name || '';
      const specsSummary =
        itemType === 'service'
          ? formatServiceSpecSummary({ service_specs: serviceSpecs })
          : formatItemSpecSummary(productLine, specs);

      const res = await erpFetch('/api/erp/ai/store-assist', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'item_listing',
          itemName: name.trim(),
          categoryName,
          brandName,
          itemType,
          productLine: itemType === 'service' ? 'service' : productLine,
          sellingPrice: sellingPrice ? Number(sellingPrice) : undefined,
          specsSummary,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'AI Store draft failed.');
      if (data.draft?.online_slug) setOnlineSlug(String(data.draft.online_slug));
      if (data.draft?.online_description) setOnlineDescription(String(data.draft.online_description));
      showToast('AI drafted storefront URL slug and description.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI Store draft failed.', 'error');
    } finally {
      setAiStoreDrafting(false);
    }
  };

  const handleInlineCreateTaxonomy = async () => {
    const clean = inlineAddName.trim();
    if (!clean || !inlineAddType) return;
    try {
      if (inlineAddType === 'category') {
        const { data, error: rpcErr } = await supabase.rpc('save_item_category', {
          p_name: clean,
          p_product_line: productLine,
        });
        if (rpcErr) throw rpcErr;
        if (data?.id) setCategoryId(data.id);
      } else {
        const { data, error: rpcErr } = await supabase.rpc('save_brand', {
          p_name: clean,
          p_product_line: productLine,
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

  const buildTileAutoConversions = (
    targetBaseUnitId: string,
    specSource: AnySpecsMap
  ): ConversionDraft[] => {
    if (productLine !== 'tiles_slabs') return [];
    const baseU = units.find((u) => u.id === targetBaseUnitId);
    const baseCode = baseU?.code.toUpperCase();
    if (!baseCode || !['BOX', 'PCS', 'SQFT', 'SQM'].includes(baseCode)) return [];

    const pcsPerBox = Number(specSource.pieces_per_box || 0);
    const sqftPerBox = Number(specSource.sqft_per_box || 0);
    const sqmRaw = Number(specSource.sqm_per_box || 0);
    const sqmPerBox =
      sqmRaw > 0
        ? sqmRaw
        : sqftPerBox > 0
          ? Number((sqftPerBox / SQFT_PER_SQM).toFixed(4))
          : 0;

    const perBox: Record<string, number> = { BOX: 1 };
    if (Number.isFinite(pcsPerBox) && pcsPerBox > 0) perBox.PCS = pcsPerBox;
    if (Number.isFinite(sqftPerBox) && sqftPerBox > 0) perBox.SQFT = sqftPerBox;
    if (Number.isFinite(sqmPerBox) && sqmPerBox > 0) perBox.SQM = sqmPerBox;

    const basePerBox = perBox[baseCode];
    if (!basePerBox || basePerBox <= 0) return [];

    const result: ConversionDraft[] = [];
    for (const code of ['BOX', 'PCS', 'SQFT', 'SQM']) {
      if (code === baseCode) continue;
      const altUnit = units.find((u) => u.code.toUpperCase() === code);
      const altPerBox = perBox[code];
      if (!altUnit || !altPerBox || altPerBox <= 0) continue;
      const factor = Math.round((basePerBox / altPerBox) * 1000000) / 1000000;
      if (factor <= 0) continue;
      result.push({
        localId: crypto.randomUUID(),
        alternate_unit_id: altUnit.id,
        conversion_factor: String(factor),
      });
    }
    return result;
  };

  const handleAutoFillTileConversions = () => {
    const computed = buildTileAutoConversions(baseUnitId, specs);
    if (computed.length === 0) {
      showToast(
        'Enter Pieces/Box and Sq.Ft/Box in Tile specs first to auto-compute conversions.',
        'info'
      );
      return;
    }
    setConversions(computed);
    showToast('Auto-filled tile BOX / PCS / SQFT / SQM conversions.', 'success');
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

    const isService = itemType === 'service';
    const effectiveProductLine: ProductLineKey = isService ? 'other_general' : productLine;

    let cleanedSpecs: AnySpecsMap | null = null;
    let cleanedServiceSpecs: ServiceSpecs | null = null;

    if (isService) {
      const srvCheck = validateServiceSpecs(serviceSpecs);
      if (!srvCheck.valid) {
        setServiceSpecErrors(srvCheck.errors);
        const firstErr = Object.values(srvCheck.errors)[0] || 'Required service fields are missing.';
        setError(firstErr);
        return;
      }
      setServiceSpecErrors({});
      cleanedServiceSpecs = srvCheck.cleaned;
    } else {
      const specCheck = validateProductSpecs(productLine, specs);
      if (!specCheck.valid) {
        setSpecErrors(specCheck.errors);
        const firstErr = Object.values(specCheck.errors)[0] || t('items.requiredSpecsMissing');
        setError(firstErr);
        return;
      }
      setSpecErrors({});
      cleanedSpecs = specCheck.cleaned;
    }

    const sourceConversions =
      !isService && conversions.length === 0 && productLine === 'tiles_slabs' && cleanedSpecs
        ? buildTileAutoConversions(baseUnitId, cleanedSpecs)
        : conversions;

    const cleanConvs: Array<{
      alternate_unit_id: string;
      conversion_factor: number;
    }> = [];
    for (const c of sourceConversions) {
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

    if (!item && !isService && openQty > 0) {
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

    const cleanPackMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(packMeta)) {
      if (v.trim()) cleanPackMeta[k] = v.trim();
    }

    const warrantyVal = warrantyMonths.trim() ? Number(warrantyMonths) : null;
    if (warrantyVal !== null && (!Number.isInteger(warrantyVal) || warrantyVal < 0)) {
      setError('Warranty months must be a whole number 0 or greater.');
      return;
    }

    if (!isService && productLine === 'tiles_slabs' && cleanedSpecs?.sqft_per_box) {
      cleanPackMeta.sqft_per_box = String(cleanedSpecs.sqft_per_box);
    }

    let effectiveHsn = hsnCode.trim() || null;
    if (isService && cleanedServiceSpecs) {
      cleanPackMeta.service_specs = cleanedServiceSpecs;
      if (cleanedServiceSpecs.sac_code) {
        cleanPackMeta.sac_code = cleanedServiceSpecs.sac_code;
        if (!effectiveHsn) effectiveHsn = cleanedServiceSpecs.sac_code;
      }
      if (cleanedServiceSpecs.est_duration) {
        cleanPackMeta.est_duration = cleanedServiceSpecs.est_duration;
      }
    }

    if (onlineStoreEnabled && onlinePrice.trim()) {
      const op = Number(onlinePrice);
      if (!Number.isFinite(op) || op < 0) {
        setError('Online price must be 0 or greater.');
        return;
      }
    }

    setSaving(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('save_item', {
        p_id: item?.id ?? null,
        p_name: name.trim(),
        p_sku: sku.trim() || null,
        p_barcode: isService ? null : barcode.trim() || null,
        p_category_id: categoryId || null,
        p_brand_id: brandId || null,
        p_base_unit_id: baseUnitId,
        p_selling_price: sp,
        p_mrp: mrpVal,
        p_purchase_price: canViewCost ? pp : null,
        p_gst_rate: Number(gstRate || 0),
        p_hsn_code: effectiveHsn,
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
        p_product_line: effectiveProductLine,
        p_supplier_id: supplierId || null,
        p_country_of_origin: isService ? null : countryOfOrigin.trim() || null,
        p_warranty_months: warrantyVal,
        p_video_url: videoUrl.trim() || null,
        p_description: description.trim() || null,
        p_specs: cleanedSpecs,
      });

      if (rpcErr) throw rpcErr;

      const shouldSyncOnline =
        onlineStoreEnabled &&
        session?.access_token &&
        (publishOnline ||
          onlinePrice.trim() !== '' ||
          onlineSlug.trim() !== '' ||
          onlineDescription.trim() !== '' ||
          Boolean(item?.is_published_online) ||
          item?.online_price != null ||
          Boolean(item?.online_slug) ||
          Boolean(item?.online_description));

      if (shouldSyncOnline && data?.id) {
        const storeRes = await erpFetch(`/api/erp/store-admin/items/${data.id}`, session!.access_token, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            is_published_online: publishOnline,
            online_price: onlinePrice.trim() ? Number(onlinePrice) : null,
            online_slug: onlineSlug.trim() || null,
            online_description: onlineDescription.trim() || null,
          }),
        });
        if (!storeRes.ok) {
          const storeJson = await storeRes.json().catch(() => ({}));
          throw new Error(storeJson?.error || 'Item saved, but online listing sync failed.');
        }
      }

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
            erpFetch(`/api/erp/files/${encodeURIComponent(fid)}`, session.access_token, {
              method: 'DELETE',
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
                    onClick={() => handleItemTypeChange(opt.id)}
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
                  Non-stock service — separate details & SAC specifications (no physical Product Line stock tracking)
                </span>
              )}
            </div>

            {/* Product Line (Fixed 5 Physical Lines — Goods Only) */}
            {itemType === 'goods' && (
              <div className="sm:col-span-2">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="text-xs font-semibold">
                    {t('items.productLine')} *
                  </label>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    Fixed product line (cannot add or rename lines)
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                  {PRODUCT_LINES.map((pl) => (
                    <button
                      key={pl.key}
                      type="button"
                      onClick={() => handleProductLineChange(pl.key)}
                      className={`px-2.5 py-2 rounded-lg border text-xs font-medium text-left transition-colors ${
                        productLine === pl.key
                          ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      {language === 'hi' ? pl.shortLabelHi : pl.shortLabelEn}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="sm:col-span-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="block text-xs font-medium">
                  {t('items.name')} *
                </label>
                {isModuleEnabled('ai') && (
                  <button
                    type="button"
                    disabled={aiFilling}
                    onClick={() => void handleAiAutoFill()}
                    className="text-[11px] font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline disabled:opacity-50"
                    title="Auto-fill HSN code, GST slab, category, brand & tax mode with AI"
                  >
                    {aiFilling ? (
                      <IconLoader2 size={12} className="animate-spin" />
                    ) : (
                      <IconSparkles size={12} stroke={2} />
                    )}
                    <span>{aiFilling ? 'Filling...' : 'AI Auto-Fill HSN & GST'}</span>
                  </button>
                )}
              </div>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  itemType === 'service'
                    ? 'e.g., Tile Installation Service'
                    : 'e.g., Kajaria Glossy GVT 600x1200mm Ivory'
                }
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
                {scopedCategories.map((c) => (
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
                {scopedBrands.map((b) => (
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
                {itemType === 'service' ? 'Service Code / SKU' : t('items.sku')}
              </label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value.toUpperCase())}
                placeholder={itemType === 'service' ? 'e.g., SRV-TILE-01' : 'e.g., TILE-6012'}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
              />
            </div>

            {itemType === 'goods' && (
              <div>
                <div className="flex items-center justify-between mb-1 gap-2">
                  <label className="text-xs font-medium">{t('items.barcode')}</label>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setBarcodeScannerOpen(true)}
                      className="text-[11px] font-medium text-[var(--primary-dark)] inline-flex items-center gap-1"
                      title="Scan barcode via camera"
                    >
                      <IconCamera size={12} stroke={2} />
                      <span>Scan</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleGenerateBarcode}
                      className="text-[11px] font-medium text-[var(--primary-dark)] inline-flex items-center gap-1"
                    >
                      <IconWand size={12} stroke={2} />
                      <span>{t('items.generateCode')}</span>
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value.toUpperCase())}
                  placeholder="Scan or enter barcode"
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
                />
              </div>
            )}
          </div>

          {/* Line-Specific Typed Specifications (Goods) OR Dedicated Service Specifications */}
          <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold">
                {itemType === 'service'
                  ? 'Service Details & Specifications'
                  : t('items.technicalSpecs')}
              </h3>
              <span className="text-[11px] text-[var(--text-muted)]">
                {itemType === 'service'
                  ? 'Non-stock service scope, billing basis & SAC'
                  : 'Required * fields depend on product line'}
              </span>
            </div>
            {itemType === 'service' ? (
              <ServiceSpecFields
                specs={serviceSpecs}
                errors={serviceSpecErrors}
                onChange={(nextSrv) => {
                  setServiceSpecs(nextSrv);
                  if (Object.keys(serviceSpecErrors).length > 0) {
                    setServiceSpecErrors({});
                  }
                }}
              />
            ) : (
              <ProductSpecFields
                productLine={productLine}
                specs={specs}
                errors={specErrors}
                onChange={(nextSpecs) => {
                  setSpecs(nextSpecs);
                  if (Object.keys(specErrors).length > 0) {
                    setSpecErrors({});
                  }
                }}
              />
            )}
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

            {(() => {
              const spNum = Math.max(0, Number(sellingPrice || 0));
              const gstNum = Math.max(0, Number(gstRate || 0));
              if (spNum <= 0 || gstNum <= 0) return null;
              const exclRate = taxInclusive
                ? convertRateTaxMode(spNum, gstNum, true, false)
                : roundHalfUp(spNum, 2);
              const inclRate = taxInclusive
                ? roundHalfUp(spNum, 2)
                : convertRateTaxMode(spNum, gstNum, false, true);
              const gstAmt = roundHalfUp(inclRate - exclRate, 2);
              return (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-muted)] tabular-nums">
                    Base <strong className="text-[var(--text)]">{formatINR(exclRate)}</strong> + GST ({gstNum}% = {formatINR(gstAmt)}) = Final Price <strong className="text-[var(--primary-dark)]">{formatINR(inclRate)}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const nextIncl = !taxInclusive;
                      setSellingPrice(
                        String(convertRateTaxMode(spNum, gstNum, taxInclusive, nextIncl))
                      );
                      setTaxInclusive(nextIncl);
                    }}
                    className="h-7 px-2.5 rounded border border-[var(--border)] bg-[var(--surface-muted)] hover:bg-[var(--primary-soft)] text-[11px] font-semibold inline-flex items-center gap-1"
                  >
                    <IconArrowsExchange size={13} stroke={2} />
                    <span>{taxInclusive ? 'Convert to Excl. Rate' : 'Convert to Incl. MRP'}</span>
                  </button>
                </div>
              );
            })()}

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
                  {scopedUnits.map((u) => (
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {t('items.alternateUnits')}
                </span>
                <div className="flex items-center gap-3">
                  {itemType === 'goods' && productLine === 'tiles_slabs' && (
                    <button
                      type="button"
                      onClick={handleAutoFillTileConversions}
                      className="text-xs font-medium text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline"
                    >
                      <IconWand size={13} stroke={2} />
                      <span>Auto-fill BOX / PCS / SQFT / SQM</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleAddConversion}
                    className="text-xs font-medium text-[var(--primary-dark)] inline-flex items-center gap-1"
                  >
                    <IconPlus size={14} stroke={2.5} />
                    <span>{t('items.addConversion')}</span>
                  </button>
                </div>
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

          {/* Online Store / E-Commerce Listing (when Online Store module is enabled) */}
          {onlineStoreEnabled && (
            <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <IconBuildingStore size={16} stroke={2} className="text-[var(--primary-dark)]" />
                  <h3 className="text-xs font-semibold">Online Store / E-Commerce</h3>
                </div>
                <div className="flex items-center gap-3">
                  {aiEnabled && (
                    <button
                      type="button"
                      disabled={aiStoreDrafting}
                      onClick={() => void handleAiDraftOnlineListing()}
                      className="text-[11px] font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline disabled:opacity-50"
                    >
                      {aiStoreDrafting ? (
                        <IconLoader2 size={12} className="animate-spin" />
                      ) : (
                        <IconSparkles size={12} stroke={2} />
                      )}
                      <span>{aiStoreDrafting ? 'Drafting...' : 'AI Draft Slug & Copy'}</span>
                    </button>
                  )}
                  <label className="inline-flex items-center gap-2 text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={publishOnline}
                      onChange={(e) => setPublishOnline(e.target.checked)}
                    />
                    <span>Publish to Online Store (/)</span>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    Online Store Price (₹)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={onlinePrice}
                    onChange={(e) => setOnlinePrice(e.target.value)}
                    placeholder={sellingPrice ? `Defaults to ₹${sellingPrice}` : 'Optional override price'}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    SEO URL Slug
                  </label>
                  <input
                    type="text"
                    value={onlineSlug}
                    onChange={(e) => setOnlineSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))}
                    placeholder="auto-generated-from-name"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">
                  Online Store Description
                </label>
                <textarea
                  rows={2}
                  value={onlineDescription}
                  onChange={(e) => setOnlineDescription(e.target.value)}
                  placeholder="Highlights shown to online customers (usage, finish care, delivery/installation note)"
                  className="w-full p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
              </div>
            </div>
          )}

          {/* Collapsible Advanced / Pack-Specific Options */}
          <div className="border border-[var(--border)] rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full px-4 py-3 bg-[var(--surface-muted)]/60 flex items-center justify-between text-xs font-semibold"
            >
              <span>
                {itemType === 'service'
                  ? 'Additional Service Options, Media & Notes'
                  : 'Stock Policy, Pack Details & Notes'}
              </span>
              {showAdvanced ? (
                <IconChevronUp size={16} stroke={2} />
              ) : (
                <IconChevronDown size={16} stroke={2} />
              )}
            </button>
            {showAdvanced && (
              <div className="p-4 space-y-3.5 border-t border-[var(--border)]">
                {itemType === 'goods' && (
                  <>
                    <label className="inline-flex items-center gap-2 text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={allowNegativeStock}
                        onChange={(e) => setAllowNegativeStock(e.target.checked)}
                      />
                      <span>{t('items.allowNegativeStock')}</span>
                    </label>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    </div>
                  </>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {partiesEnabled && (
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {itemType === 'service' ? 'Partner / Subcontractor' : t('items.supplier')}
                      </label>
                      <select
                        value={supplierId}
                        onChange={(e) => setSupplierId(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      >
                        <option value="">— Any / Optional —</option>
                        {suppliersList.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {itemType === 'goods' && (
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t('items.countryOfOrigin')}
                      </label>
                      <input
                        type="text"
                        value={countryOfOrigin}
                        onChange={(e) => setCountryOfOrigin(e.target.value)}
                        placeholder="e.g., India, Italy, Spain"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {t('items.warrantyMonths')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={warrantyMonths}
                      onChange={(e) => setWarrantyMonths(e.target.value)}
                      placeholder="e.g., 12, 60, 120"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('items.videoUrl')}
                  </label>
                  <input
                    type="url"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('items.description')}
                  </label>
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Customer-facing product summary and showroom notes"
                    className="w-full p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t('items.notes')}
                  </label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={
                      itemType === 'service'
                        ? 'Internal technician / site checklist note'
                        : 'Internal rack location or handling note'
                    }
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

      <BarcodeScannerModal
        open={barcodeScannerOpen}
        onClose={() => setBarcodeScannerOpen(false)}
        onDetected={(code) => {
          setBarcode(code.toUpperCase());
          if (!sku.trim()) {
            setSku(code.toUpperCase().slice(0, 16));
          }
        }}
        title="Scan Item Barcode"
        continuousDefault={false}
      />
    </div>
  );
}
