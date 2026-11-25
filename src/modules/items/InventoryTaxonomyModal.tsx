import {
  IconCheck,
  IconEdit,
  IconLoader2,
  IconLock,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { hasCapability } from '../../core/permissions';
import {
  PRODUCT_LINES,
  filterTaxonomyByProductLine,
  getProductLineLabel,
  type ProductLineKey,
  type TaxonomyScopeKey,
} from '../../core/productLines';
import { supabase } from '../../core/supabase';
import type {
  BrandRecord,
  ItemCategoryRecord,
  ItemUnitRecord,
} from '../../types/decorbiz';

type TaxonomyTab = 'categories' | 'brands' | 'units';

interface InventoryTaxonomyModalProps {
  open: boolean;
  initialTab?: TaxonomyTab;
  initialProductLine?: ProductLineKey | 'all';
  categories: ItemCategoryRecord[];
  brands: BrandRecord[];
  units: ItemUnitRecord[];
  onClose: () => void;
  onUpdated: () => Promise<void> | void;
}

export function InventoryTaxonomyModal({
  open,
  initialTab = 'categories',
  initialProductLine = 'all',
  categories,
  brands,
  units,
  onClose,
  onUpdated,
}: InventoryTaxonomyModalProps) {
  const { profile, language, showToast, t } = useApp();
  const [tab, setTab] = useState<TaxonomyTab>(initialTab);
  const [lineFilter, setLineFilter] = useState<ProductLineKey | 'all'>(initialProductLine);
  const [saving, setSaving] = useState(false);

  // Category state
  const [catEditId, setCatEditId] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catDesc, setCatDesc] = useState('');
  const [catLine, setCatLine] = useState<TaxonomyScopeKey>(initialProductLine);

  // Brand state
  const [brandEditId, setBrandEditId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState('');
  const [brandLine, setBrandLine] = useState<TaxonomyScopeKey>(initialProductLine);

  // Unit state
  const [unitEditId, setUnitEditId] = useState<string | null>(null);
  const [unitCode, setUnitCode] = useState('');
  const [unitNameEn, setUnitNameEn] = useState('');
  const [unitNameHi, setUnitNameHi] = useState('');
  const [unitDecimal, setUnitDecimal] = useState(false);
  const [unitLine, setUnitLine] = useState<TaxonomyScopeKey>(initialProductLine);

  const canManage = hasCapability(profile?.role, 'items');

  const visibleCategories = useMemo(
    () => filterTaxonomyByProductLine(categories, lineFilter),
    [categories, lineFilter]
  );
  const visibleBrands = useMemo(
    () => filterTaxonomyByProductLine(brands, lineFilter),
    [brands, lineFilter]
  );
  const visibleUnits = useMemo(
    () => filterTaxonomyByProductLine(units, lineFilter),
    [units, lineFilter]
  );

  if (!open) return null;

  const scopeLabel = (scope?: TaxonomyScopeKey | string | null) => {
    if (!scope || scope === 'all') {
      return language === 'hi' ? 'सभी लाइनें' : 'All Lines';
    }
    return getProductLineLabel(scope, language);
  };

  const handleFilterChange = (next: ProductLineKey | 'all') => {
    setLineFilter(next);
    if (!catEditId) setCatLine(next);
    if (!brandEditId) setBrandLine(next);
    if (!unitEditId) setUnitLine(next);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || !catName.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('save_item_category', {
        p_id: catEditId,
        p_name: catName.trim(),
        p_description: catDesc.trim() || null,
        p_product_line: catLine,
      });
      if (error) throw error;
      setCatEditId(null);
      setCatName('');
      setCatDesc('');
      showToast(
        language === 'hi' ? 'श्रेणी सहेजी गई।' : 'Category saved.',
        'success'
      );
      await onUpdated();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save category.',
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBrand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || !brandName.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('save_brand', {
        p_id: brandEditId,
        p_name: brandName.trim(),
        p_product_line: brandLine,
      });
      if (error) throw error;
      setBrandEditId(null);
      setBrandName('');
      showToast(
        language === 'hi' ? 'ब्रांड सहेजा गया।' : 'Brand saved.',
        'success'
      );
      await onUpdated();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save brand.',
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleSaveUnit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || !unitCode.trim() || !unitNameEn.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('save_item_unit', {
        p_id: unitEditId,
        p_code: unitCode.trim().toUpperCase(),
        p_name_en: unitNameEn.trim(),
        p_name_hi: unitNameHi.trim() || unitNameEn.trim(),
        p_allow_decimal: unitDecimal,
        p_product_line: unitLine,
      });
      if (error) throw error;
      setUnitEditId(null);
      setUnitCode('');
      setUnitNameEn('');
      setUnitNameHi('');
      setUnitDecimal(false);
      showToast(
        language === 'hi' ? 'इकाई सहेजी गई।' : 'Unit saved.',
        'success'
      );
      await onUpdated();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to save unit.',
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  const renderLineOptions = () => (
    <>
      <option value="all">{language === 'hi' ? 'सभी प्रोडक्ट लाइनें (साझा)' : 'All Lines (Shared)'}</option>
      {PRODUCT_LINES.map((pl) => (
        <option key={pl.key} value={pl.key}>
          {language === 'hi' ? pl.labelHi : pl.labelEn}
        </option>
      ))}
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center p-0 md:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('items.manageTaxonomy')}
        className="w-full md:max-w-3xl max-h-[90vh] rounded-t-2xl md:rounded-2xl bg-[var(--surface)] border border-[var(--border)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('items.manageTaxonomy')}</h2>
            <p className="text-[11px] text-[var(--text-muted)] inline-flex items-center gap-1 mt-0.5">
              <IconLock size={12} stroke={2} />
              <span>
                {language === 'hi'
                  ? '5 मुख्य प्रोडक्ट लाइनें लॉक हैं; आप किसी भी लाइन के अंदर श्रेणी, ब्रांड और इकाइयाँ जोड़ सकते हैं।'
                  : 'The 5 product lines are fixed; create categories, brands & units inside any line.'}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        {/* Product Line Scope Filter */}
        <div className="px-5 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)]/50 flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => handleFilterChange('all')}
            className={`h-8 px-3 rounded-lg border text-xs font-medium whitespace-nowrap ${
              lineFilter === 'all'
                ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
            }`}
          >
            {t('items.allLines')}
          </button>
          {PRODUCT_LINES.map((pl) => (
            <button
              key={pl.key}
              type="button"
              onClick={() => handleFilterChange(pl.key)}
              className={`h-8 px-3 rounded-lg border text-xs font-medium whitespace-nowrap ${
                lineFilter === pl.key
                  ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
              }`}
            >
              {language === 'hi' ? pl.shortLabelHi : pl.shortLabelEn}
            </button>
          ))}
        </div>

        {/* Tabs */}
        <div className="px-5 pt-2 border-b border-[var(--border)] flex gap-2">
          {(
            [
              ['categories', t('items.categories'), visibleCategories.length],
              ['brands', t('items.brands'), visibleBrands.length],
              ['units', t('items.units'), visibleUnits.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-3 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? 'border-[var(--primary)] text-[var(--primary-dark)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {label} · <span className="tabular-nums">{count}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {tab === 'categories' && (
            <>
              {canManage && (
                <form
                  onSubmit={handleSaveCategory}
                  className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end"
                >
                  <div className="sm:col-span-4">
                    <label className="block text-xs font-medium mb-1">
                      Category Name
                    </label>
                    <input
                      type="text"
                      value={catName}
                      onChange={(e) => setCatName(e.target.value)}
                      placeholder="e.g., GVT Vitrified, Wall Hung WC"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      required
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-xs font-medium mb-1">
                      {t('items.productLine')}
                    </label>
                    <select
                      value={catLine}
                      onChange={(e) => setCatLine(e.target.value as TaxonomyScopeKey)}
                      className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      {renderLineOptions()}
                    </select>
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-xs font-medium mb-1">
                      Description (optional)
                    </label>
                    <input
                      type="text"
                      value={catDesc}
                      onChange={(e) => setCatDesc(e.target.value)}
                      placeholder="Notes"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                    />
                  </div>
                  <div className="sm:col-span-2 flex items-center gap-1.5">
                    <button
                      type="submit"
                      disabled={saving}
                      className="flex-1 h-10 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center justify-center gap-1"
                    >
                      {saving ? (
                        <IconLoader2 size={15} className="animate-spin" />
                      ) : catEditId ? (
                        <IconCheck size={15} stroke={2.5} />
                      ) : (
                        <IconPlus size={15} stroke={2.5} />
                      )}
                      <span>{catEditId ? 'Save' : 'Add'}</span>
                    </button>
                    {catEditId && (
                      <button
                        type="button"
                        onClick={() => {
                          setCatEditId(null);
                          setCatName('');
                          setCatDesc('');
                          setCatLine(lineFilter);
                        }}
                        className="h-10 px-2 rounded-lg border border-[var(--border)] text-xs"
                      >
                        <IconX size={14} />
                      </button>
                    )}
                  </div>
                </form>
              )}

              <div className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl overflow-hidden">
                {visibleCategories.length === 0 ? (
                  <p className="p-4 text-sm text-[var(--text-muted)]">
                    No categories in this product line yet.
                  </p>
                ) : (
                  visibleCategories.map((c) => (
                    <div
                      key={c.id}
                      className="px-4 py-3 flex items-center justify-between gap-3 bg-[var(--surface)]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{c.name}</p>
                          <span className="text-[11px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1.5 py-0.5 shrink-0">
                            {scopeLabel(c.product_line)}
                          </span>
                        </div>
                        {c.description && (
                          <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                            {c.description}
                          </p>
                        )}
                      </div>
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => {
                            setCatEditId(c.id);
                            setCatName(c.name);
                            setCatDesc(c.description || '');
                            setCatLine(c.product_line || 'all');
                          }}
                          className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                          aria-label={`Edit ${c.name}`}
                        >
                          <IconEdit size={16} stroke={2} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {tab === 'brands' && (
            <>
              {canManage && (
                <form
                  onSubmit={handleSaveBrand}
                  className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end"
                >
                  <div className="sm:col-span-5">
                    <label className="block text-xs font-medium mb-1">
                      Brand Name
                    </label>
                    <input
                      type="text"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      placeholder="e.g., Kajaria, Jaquar, Hindware, Roff"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      required
                    />
                  </div>
                  <div className="sm:col-span-4">
                    <label className="block text-xs font-medium mb-1">
                      {t('items.productLine')}
                    </label>
                    <select
                      value={brandLine}
                      onChange={(e) => setBrandLine(e.target.value as TaxonomyScopeKey)}
                      className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      {renderLineOptions()}
                    </select>
                  </div>
                  <div className="sm:col-span-3 flex items-center gap-1.5">
                    <button
                      type="submit"
                      disabled={saving}
                      className="flex-1 h-10 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center justify-center gap-1"
                    >
                      {saving ? (
                        <IconLoader2 size={15} className="animate-spin" />
                      ) : brandEditId ? (
                        <IconCheck size={15} stroke={2.5} />
                      ) : (
                        <IconPlus size={15} stroke={2.5} />
                      )}
                      <span>{brandEditId ? 'Update' : 'Add Brand'}</span>
                    </button>
                    {brandEditId && (
                      <button
                        type="button"
                        onClick={() => {
                          setBrandEditId(null);
                          setBrandName('');
                          setBrandLine(lineFilter);
                        }}
                        className="h-10 px-2 rounded-lg border border-[var(--border)] text-xs"
                      >
                        <IconX size={14} />
                      </button>
                    )}
                  </div>
                </form>
              )}

              <div className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl overflow-hidden">
                {visibleBrands.length === 0 ? (
                  <p className="p-4 text-sm text-[var(--text-muted)]">
                    No brands in this product line yet.
                  </p>
                ) : (
                  visibleBrands.map((b) => (
                    <div
                      key={b.id}
                      className="px-4 py-3 flex items-center justify-between gap-3 bg-[var(--surface)]"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{b.name}</span>
                        <span className="text-[11px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1.5 py-0.5 shrink-0">
                          {scopeLabel(b.product_line)}
                        </span>
                      </div>
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => {
                            setBrandEditId(b.id);
                            setBrandName(b.name);
                            setBrandLine(b.product_line || 'all');
                          }}
                          className="p-2 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
                          aria-label={`Edit ${b.name}`}
                        >
                          <IconEdit size={16} stroke={2} />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {tab === 'units' && (
            <>
              {canManage && (
                <form
                  onSubmit={handleSaveUnit}
                  className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] space-y-3"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Short Code
                      </label>
                      <input
                        type="text"
                        value={unitCode}
                        onChange={(e) => setUnitCode(e.target.value.toUpperCase())}
                        placeholder="e.g., PALLET, SLAB"
                        maxLength={12}
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        English Name
                      </label>
                      <input
                        type="text"
                        value={unitNameEn}
                        onChange={(e) => setUnitNameEn(e.target.value)}
                        placeholder="e.g., Pallet"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Hindi Name
                      </label>
                      <input
                        type="text"
                        value={unitNameHi}
                        onChange={(e) => setUnitNameHi(e.target.value)}
                        placeholder="जैसे: पैलेट"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        {t('items.productLine')}
                      </label>
                      <select
                        value={unitLine}
                        onChange={(e) => setUnitLine(e.target.value as TaxonomyScopeKey)}
                        className="w-full h-10 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      >
                        {renderLineOptions()}
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="inline-flex items-center gap-2 text-xs font-medium">
                      <input
                        type="checkbox"
                        checked={unitDecimal}
                        onChange={(e) => setUnitDecimal(e.target.checked)}
                        className="rounded border-[var(--border)]"
                      />
                      <span>Allow decimal quantities (e.g., 1.250 sq.m)</span>
                    </label>
                    <div className="flex items-center gap-2">
                      {unitEditId && (
                        <button
                          type="button"
                          onClick={() => {
                            setUnitEditId(null);
                            setUnitCode('');
                            setUnitNameEn('');
                            setUnitNameHi('');
                            setUnitDecimal(false);
                            setUnitLine(lineFilter);
                          }}
                          className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs"
                        >
                          {t('common.cancel')}
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={saving}
                        className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1"
                      >
                        {saving ? (
                          <IconLoader2 size={15} className="animate-spin" />
                        ) : (
                          <IconPlus size={15} stroke={2.5} />
                        )}
                        <span>{unitEditId ? 'Update Unit' : 'Add Unit'}</span>
                      </button>
                    </div>
                  </div>
                </form>
              )}

              <div className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl overflow-hidden">
                {visibleUnits.map((u) => (
                  <div
                    key={u.id}
                    className="px-4 py-2.5 flex items-center justify-between gap-3 bg-[var(--surface)] text-sm"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[var(--surface-muted)] border border-[var(--border)]">
                        {u.code}
                      </span>
                      <span className="truncate">
                        {u.name_en} · {u.name_hi}
                      </span>
                      <span className="text-[11px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1.5 py-0.5 shrink-0">
                        {scopeLabel(u.product_line)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs text-[var(--text-muted)]">
                      <span>{u.allow_decimal ? 'Decimal' : 'Whole'}</span>
                      {canManage && !u.is_system && (
                        <button
                          type="button"
                          onClick={() => {
                            setUnitEditId(u.id);
                            setUnitCode(u.code);
                            setUnitNameEn(u.name_en);
                            setUnitNameHi(u.name_hi);
                            setUnitDecimal(u.allow_decimal);
                            setUnitLine(u.product_line || 'all');
                          }}
                          className="p-1.5 rounded hover:bg-[var(--surface-muted)]"
                          aria-label={`Edit ${u.code}`}
                        >
                          <IconEdit size={15} stroke={2} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
