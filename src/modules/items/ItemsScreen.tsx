import {
  IconAdjustments,
  IconAlertTriangle,
  IconBarcode,
  IconCategory,
  IconChevronRight,
  IconPackage,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import {
  PRODUCT_LINES,
  filterTaxonomyByProductLine,
  getProductLineLabel,
  type ProductLineKey,
} from '../../core/productLines';
import {
  formatItemSpecSummary,
  formatServiceSpecSummary,
  getLineFilterDefinitions,
  matchesLineSpecFilters,
} from '../../core/productSpecs';
import { supabase } from '../../core/supabase';
import { formatStockQty } from '../../core/units';
import type {
  BrandRecord,
  InventorySummary,
  ItemCatalogRecord,
  ItemCategoryRecord,
  ItemUnitRecord,
  UnitConversionRecord,
} from '../../types/decorbiz';
import { BarcodeLabelModal } from './BarcodeLabelModal';
import { InventoryTaxonomyModal } from './InventoryTaxonomyModal';
import { ItemDetailView } from './ItemDetailView';
import { ItemFormModal } from './ItemFormModal';
import { StockAdjustmentModal } from './StockAdjustmentModal';

export type ItemFilterTab = 'all' | 'low_stock' | 'out_of_stock' | 'archived';

interface ItemsScreenProps {
  initialItemId?: string | null;
  initialFilter?: ItemFilterTab | null;
  initialAction?: 'add-item' | null;
  onActionConsumed?: () => void;
}

export function ItemsScreen({
  initialItemId,
  initialFilter,
  initialAction,
  onActionConsumed,
}: ItemsScreenProps) {
  const { profile, signedUrlCache, getSignedUrl, language, showToast, t } = useApp();

  const canEdit = hasCapability(profile?.role, 'items');
  const canAdjust = hasCapability(profile?.role, 'stock_adjustment');
  const canViewCost = hasCapability(profile?.role, 'view_profit');

  const [selectedItemId, setSelectedItemId] = useState<string | null>(
    initialItemId ?? null
  );
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [items, setItems] = useState<ItemCatalogRecord[]>([]);
  const [categories, setCategories] = useState<ItemCategoryRecord[]>([]);
  const [brands, setBrands] = useState<BrandRecord[]>([]);
  const [units, setUnits] = useState<ItemUnitRecord[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filterTab, setFilterTab] = useState<ItemFilterTab>(
    initialFilter ?? 'all'
  );
  const [productLineFilter, setProductLineFilter] = useState<ProductLineKey | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [specFilters, setSpecFilters] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [taxonomyOpen, setTaxonomyOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);

  const [quickAdjustItem, setQuickAdjustItem] =
    useState<ItemCatalogRecord | null>(null);
  const [quickAdjustConvs, setQuickAdjustConvs] = useState<
    UnitConversionRecord[]
  >([]);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sumRes, itemsRes, catRes, brandRes, unitRes] = await Promise.all([
        supabase.from('inventory_summary_view').select('*').maybeSingle(),
        supabase.from('item_catalog_view').select('*').order('name', {
          ascending: true,
        }),
        supabase
          .from('item_categories')
          .select('*')
          .eq('is_active', true)
          .order('name'),
        supabase.from('brands').select('*').eq('is_active', true).order('name'),
        supabase
          .from('item_units')
          .select('*')
          .eq('is_active', true)
          .order('is_system', { ascending: false })
          .order('code'),
      ]);

      if (sumRes.error) throw sumRes.error;
      if (itemsRes.error) throw itemsRes.error;
      if (catRes.error) throw catRes.error;
      if (brandRes.error) throw brandRes.error;
      if (unitRes.error) throw unitRes.error;

      const list = (itemsRes.data as ItemCatalogRecord[] | null) ?? [];
      setSummary((sumRes.data as InventorySummary | null) ?? null);
      setItems(list);
      setCategories((catRes.data as ItemCategoryRecord[] | null) ?? []);
      setBrands((brandRes.data as BrandRecord[] | null) ?? []);
      setUnits((unitRes.data as ItemUnitRecord[] | null) ?? []);

      // Hydrate primary image thumbnails lazily (AppProvider ref short-circuits cached IDs)
      for (const item of list.slice(0, 40)) {
        if (item.primary_image_file_id) {
          void getSignedUrl(item.primary_image_file_id);
        }
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load inventory.'
      );
    } finally {
      setLoading(false);
    }
  }, [getSignedUrl]);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  useEffect(() => {
    if (initialItemId) {
      setSelectedItemId(initialItemId);
      onActionConsumed?.();
    }
  }, [initialItemId, onActionConsumed]);

  useEffect(() => {
    if (initialFilter) {
      setFilterTab(initialFilter);
      onActionConsumed?.();
    }
  }, [initialFilter, onActionConsumed]);

  useEffect(() => {
    if (initialAction === 'add-item' && canEdit) {
      setSelectedItemId(null);
      setAddModalOpen(true);
      onActionConsumed?.();
    }
  }, [initialAction, canEdit, onActionConsumed]);

  const openQuickAdjust = async (item: ItemCatalogRecord) => {
    try {
      const { data, error } = await supabase
        .from('unit_conversions')
        .select('*, item_units(*)')
        .eq('item_id', item.id);
      if (error) throw error;
      setQuickAdjustConvs((data as UnitConversionRecord[] | null) ?? []);
      setQuickAdjustItem(item);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to load item units.',
        'error'
      );
    }
  };

  const visibleCategories = useMemo(
    () => filterTaxonomyByProductLine(categories, productLineFilter),
    [categories, productLineFilter]
  );

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (filterTab === 'archived') {
        if (item.is_active) return false;
      } else {
        if (!item.is_active) return false;
        if (filterTab === 'low_stock' && !item.is_low_stock) return false;
        if (filterTab === 'out_of_stock' && !item.is_out_of_stock) return false;
      }

      if (productLineFilter !== 'all') {
        const line = item.product_line || 'other_general';
        if (line !== productLineFilter) return false;
        if (!matchesLineSpecFilters(item, productLineFilter, specFilters)) return false;
      }

      if (categoryFilter && item.category_id !== categoryFilter) {
        return false;
      }

      if (!q) return true;
      const specSummary = formatItemSpecSummary(item.product_line, item.specs).toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        (item.sku ?? '').toLowerCase().includes(q) ||
        (item.barcode ?? '').toLowerCase().includes(q) ||
        (item.category_name ?? '').toLowerCase().includes(q) ||
        (item.brand_name ?? '').toLowerCase().includes(q) ||
        (item.supplier_name ?? '').toLowerCase().includes(q) ||
        specSummary.includes(q)
      );
    });
  }, [items, filterTab, productLineFilter, specFilters, categoryFilter, searchQuery]);

  if (selectedItemId) {
    return (
      <ItemDetailView
        itemId={selectedItemId}
        categories={categories}
        brands={brands}
        units={units}
        onBack={() => {
          setSelectedItemId(null);
          void loadInventory();
        }}
        onUpdated={loadInventory}
        onTaxonomyUpdated={loadInventory}
      />
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconPackage size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>{t('items.title')}</span>
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {t('items.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTaxonomyOpen(true)}
            className="h-11 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
          >
            <IconCategory size={17} stroke={2} />
            <span>{t('items.manageTaxonomy')}</span>
          </button>
          <button
            type="button"
            onClick={() => setLabelsOpen(true)}
            className="h-11 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
          >
            <IconBarcode size={17} stroke={2} />
            <span>{t('items.barcodeLabels')}</span>
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={() => setAddModalOpen(true)}
              className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
            >
              <IconPlus size={18} stroke={2.5} />
              <span>{t('items.addItem')}</span>
            </button>
          )}
        </div>
      </div>

      {/* KPI Strip (Stock Value hidden unless view_profit capability) */}
      <section
        className={`grid gap-3 sm:gap-4 ${
          canViewCost ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'
        }`}
      >
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('items.activeItems')}
          </p>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums">
            {summary?.active_items_count ?? 0}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setFilterTab('low_stock')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:bg-[var(--surface-muted)] transition-colors"
        >
          <div className="flex items-center gap-1 text-xs font-medium text-amber-600">
            <IconAlertTriangle size={15} stroke={2} />
            <span>{t('items.lowStockItems')}</span>
          </div>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums text-amber-600">
            {summary?.low_stock_count ?? 0}
          </p>
        </button>

        <button
          type="button"
          onClick={() => setFilterTab('out_of_stock')}
          className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:bg-[var(--surface-muted)] transition-colors ${
            canViewCost ? '' : 'col-span-2 sm:col-span-1'
          }`}
        >
          <p className="text-xs font-medium text-[var(--give)]">
            {t('items.outOfStockItems')}
          </p>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--give)]">
            {summary?.out_of_stock_count ?? 0}
          </p>
        </button>

        {canViewCost && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs font-medium text-[var(--text-muted)]">
              {t('items.stockValue')}
            </p>
            <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums">
              {formatINR(Number(summary?.total_stock_value ?? 0))}
            </p>
          </div>
        )}
      </section>

      {loadError && (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] flex items-center justify-between gap-3 text-sm text-[var(--give)]">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadInventory()}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--give)]/40 bg-[var(--surface)] text-xs font-medium text-[var(--text)]"
          >
            <IconRefresh size={14} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      )}

      {/* Product Line Strip (5 Locked Product Lines) */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => {
            setProductLineFilter('all');
            setCategoryFilter('');
            setSpecFilters({});
          }}
          className={`h-9 px-3 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors ${
            productLineFilter === 'all'
              ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
              : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
          }`}
        >
          {t('items.allLines')}
        </button>
        {PRODUCT_LINES.map((pl) => (
          <button
            key={pl.key}
            type="button"
            onClick={() => {
              setProductLineFilter(pl.key);
              setCategoryFilter('');
              setSpecFilters({});
            }}
            className={`h-9 px-3 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors ${
              productLineFilter === pl.key
                ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            {language === 'hi' ? pl.shortLabelHi : pl.shortLabelEn}
          </button>
        ))}
      </div>

      {/* Per-Line Specification Filters */}
      {productLineFilter !== 'all' && (() => {
        const lineFilters = getLineFilterDefinitions(productLineFilter);
        const hasActive = Object.values(specFilters).some((v) => v.trim() !== '');
        if (lineFilters.length === 0) return null;
        return (
          <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {lineFilters.map((def) => {
              const label = language === 'hi' ? def.labelHi : def.labelEn;
              const val = specFilters[def.key] || '';
              if (def.options) {
                return (
                  <select
                    key={def.key}
                    value={val}
                    aria-label={label}
                    onChange={(e) =>
                      setSpecFilters((prev) => ({ ...prev, [def.key]: e.target.value }))
                    }
                    className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs min-w-32"
                  >
                    <option value="">All {label}</option>
                    {def.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                );
              }
              return (
                <input
                  key={def.key}
                  type="text"
                  value={val}
                  aria-label={label}
                  onChange={(e) =>
                    setSpecFilters((prev) => ({ ...prev, [def.key]: e.target.value }))
                  }
                  placeholder={`${label}${def.placeholder ? ` (${def.placeholder})` : ''}`}
                  className="h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs w-36"
                />
              );
            })}
            {hasActive && (
              <button
                type="button"
                onClick={() => setSpecFilters({})}
                className="h-9 px-2.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] ml-auto"
              >
                {t('items.clearFilters')}
              </button>
            )}
          </div>
        );
      })()}

      {/* Search + Filter Bar */}
      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <IconSearch
            size={17}
            stroke={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('items.searchPlaceholder')}
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
          />
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by category"
          className="h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm md:w-48"
        >
          <option value="">All Categories</option>
          {visibleCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
          {(
            [
              ['all', t('items.all')],
              ['low_stock', t('items.lowStock')],
              ['out_of_stock', t('items.outOfStock')],
              ['archived', t('items.archived')],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilterTab(key)}
              className={`h-11 px-3.5 rounded-lg border text-xs sm:text-sm font-medium whitespace-nowrap transition-colors ${
                filterTab === key
                  ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Item Catalogue List */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        {loading ? (
          <div className="divide-y divide-[var(--border)]">
            {[1, 2, 3, 4].map((idx) => (
              <div key={idx} className="p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-lg bg-[var(--surface-muted)] animate-pulse" />
                  <div className="space-y-1.5">
                    <div className="h-4 w-44 rounded bg-[var(--surface-muted)] animate-pulse" />
                    <div className="h-3 w-28 rounded bg-[var(--surface-muted)] animate-pulse" />
                  </div>
                </div>
                <div className="h-5 w-20 rounded bg-[var(--surface-muted)] animate-pulse" />
              </div>
            ))}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <div className="w-12 h-12 rounded-xl bg-[var(--surface-muted)] text-[var(--text-muted)] flex items-center justify-center mx-auto">
              <IconPackage size={24} stroke={1.8} />
            </div>
            <div>
              <h3 className="text-base font-semibold">{t('items.emptyTitle')}</h3>
              <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-1 max-w-md mx-auto">
                {t('items.emptyDesc')}
              </p>
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={() => setAddModalOpen(true)}
                className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5"
              >
                <IconPlus size={16} stroke={2.5} />
                <span>{t('items.addItem')}</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--surface-muted)] text-[var(--text-muted)] text-xs">
                  <tr>
                    <th className="px-4 py-3 font-medium">Item</th>
                    <th className="px-4 py-3 font-medium">Category · Brand</th>
                    <th className="px-4 py-3 font-medium text-right">
                      Selling Price
                    </th>
                    {canViewCost && (
                      <th className="px-4 py-3 font-medium text-right">
                        Cost Price
                      </th>
                    )}
                    <th className="px-4 py-3 font-medium text-right">Stock</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredItems.map((item) => {
                    const thumbUrl = item.primary_image_file_id
                      ? signedUrlCache[item.primary_image_file_id]
                      : undefined;
                    return (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedItemId(item.id)}
                        className="cursor-pointer hover:bg-[var(--surface-muted)]/50 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] overflow-hidden flex items-center justify-center shrink-0">
                              {thumbUrl ? (
                                <img
                                  src={thumbUrl}
                                  alt={item.name}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <IconPhoto
                                  size={18}
                                  stroke={1.8}
                                  className="text-[var(--text-muted)]"
                                />
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-[var(--text)] truncate">
                                {item.name}
                              </p>
                              <p className="text-xs text-[var(--text-muted)] truncate">
                                {(item.item_type === 'service'
                                  ? formatServiceSpecSummary(item.pack_metadata)
                                  : formatItemSpecSummary(item.product_line, item.specs)) ||
                                  (item.sku ? `SKU ${item.sku}` : 'No SKU')}
                                {item.sku &&
                                (item.item_type === 'service'
                                  ? formatServiceSpecSummary(item.pack_metadata)
                                  : formatItemSpecSummary(item.product_line, item.specs))
                                  ? ` · ${item.sku}`
                                  : ''}
                                {item.barcode ? ` · ${item.barcode}` : ''}
                                {item.image_count > 1
                                  ? ` · ${item.image_count} photos`
                                  : ''}
                                {item.is_published_online ? ' · Online Store' : ''}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                          <span className="font-medium text-[var(--text)] block">
                            {item.item_type === 'service'
                              ? language === 'hi'
                                ? 'सेवा (गैर-स्टॉक)'
                                : 'Service (Non-Stock)'
                              : getProductLineLabel(item.product_line, language)}
                          </span>
                          <span>
                            {item.category_name || '—'}
                            {item.brand_name ? ` · ${item.brand_name}` : ''}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">
                          {formatINR(Number(item.selling_price))}
                          <span className="block text-[11px] font-normal text-[var(--text-muted)]">
                            GST {item.gst_rate}%
                          </span>
                        </td>
                        {canViewCost && (
                          <td className="px-4 py-3 text-right text-xs tabular-nums text-[var(--text-muted)]">
                            {item.purchase_price !== null
                              ? formatINR(Number(item.purchase_price))
                              : '—'}
                          </td>
                        )}
                        <td className="px-4 py-3 text-right tabular-nums">
                          {item.item_type === 'service' ? (
                            <span className="text-xs font-medium text-[var(--text-muted)]">
                              Non-Stock
                            </span>
                          ) : (
                            <>
                              <span
                                className={`font-semibold ${
                                  item.is_out_of_stock
                                    ? 'text-[var(--give)]'
                                    : item.is_low_stock
                                      ? 'text-amber-600'
                                      : 'text-[var(--text)]'
                                }`}
                              >
                                {formatStockQty(item.qty_on_hand, item.base_unit_code)}
                              </span>
                              {item.is_low_stock && !item.is_out_of_stock && (
                                <span className="block text-[11px] text-amber-600">
                                  Low stock
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td
                          className="px-4 py-3 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="inline-flex items-center gap-1.5">
                            {canAdjust && (
                              <button
                                type="button"
                                onClick={() => void openQuickAdjust(item)}
                                className="h-8 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium hover:bg-[var(--surface-muted)] inline-flex items-center gap-1"
                              >
                                <IconAdjustments size={14} stroke={2} />
                                <span>Adjust</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setSelectedItemId(item.id)}
                              aria-label={`Open ${item.name}`}
                              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                            >
                              <IconChevronRight size={16} stroke={2} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile List */}
            <div className="md:hidden divide-y divide-[var(--border)]">
              {filteredItems.map((item) => {
                const thumbUrl = item.primary_image_file_id
                  ? signedUrlCache[item.primary_image_file_id]
                  : undefined;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedItemId(item.id)}
                    className="w-full p-4 flex items-center justify-between gap-3 text-left hover:bg-[var(--surface-muted)]/50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] overflow-hidden flex items-center justify-center shrink-0">
                        {thumbUrl ? (
                          <img
                            src={thumbUrl}
                            alt={item.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <IconPhoto
                            size={18}
                            stroke={1.8}
                            className="text-[var(--text-muted)]"
                          />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{item.name}</p>
                        <p className="text-xs text-[var(--text-muted)] truncate">
                          {item.item_type === 'service'
                            ? language === 'hi'
                              ? 'सेवा (गैर-स्टॉक)'
                              : 'Service (Non-Stock)'
                            : item.category_name || 'Uncategorized'}
                          {item.sku ? ` · ${item.sku}` : ''}
                          {item.is_published_online ? ' · Online' : ''}
                        </p>
                      </div>
                    </div>

                    <div className="text-right shrink-0 tabular-nums">
                      <p className="text-sm font-semibold">
                        {formatINR(Number(item.selling_price))}
                      </p>
                      <p
                        className={`text-xs font-medium ${
                          item.item_type === 'service'
                            ? 'text-[var(--text-muted)]'
                            : item.is_out_of_stock
                              ? 'text-[var(--give)]'
                              : item.is_low_stock
                                ? 'text-amber-600'
                                : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {item.item_type === 'service'
                          ? 'Non-Stock'
                          : formatStockQty(item.qty_on_hand, item.base_unit_code)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>

      <ItemFormModal
        open={addModalOpen}
        initialProductLine={productLineFilter === 'all' ? 'tiles_slabs' : productLineFilter}
        categories={categories}
        brands={brands}
        units={units}
        onClose={() => setAddModalOpen(false)}
        onSaved={async () => {
          await loadInventory();
        }}
        onTaxonomyUpdated={loadInventory}
      />

      <InventoryTaxonomyModal
        open={taxonomyOpen}
        initialProductLine={productLineFilter}
        categories={categories}
        brands={brands}
        units={units}
        onClose={() => setTaxonomyOpen(false)}
        onUpdated={loadInventory}
      />

      <BarcodeLabelModal
        open={labelsOpen}
        items={items}
        onClose={() => setLabelsOpen(false)}
      />

      <StockAdjustmentModal
        open={Boolean(quickAdjustItem)}
        item={quickAdjustItem}
        units={units}
        conversions={quickAdjustConvs}
        onClose={() => setQuickAdjustItem(null)}
        onAdjusted={loadInventory}
      />
    </div>
  );
}
