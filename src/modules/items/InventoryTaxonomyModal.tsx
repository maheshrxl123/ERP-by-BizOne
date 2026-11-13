import {
  IconCheck,
  IconEdit,
  IconLoader2,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  BrandRecord,
  ItemCategoryRecord,
  ItemUnitRecord,
} from '../../types/bizone';

type TaxonomyTab = 'categories' | 'brands' | 'units';

interface InventoryTaxonomyModalProps {
  open: boolean;
  initialTab?: TaxonomyTab;
  categories: ItemCategoryRecord[];
  brands: BrandRecord[];
  units: ItemUnitRecord[];
  onClose: () => void;
  onUpdated: () => Promise<void> | void;
}

export function InventoryTaxonomyModal({
  open,
  initialTab = 'categories',
  categories,
  brands,
  units,
  onClose,
  onUpdated,
}: InventoryTaxonomyModalProps) {
  const { profile, language, showToast, t } = useApp();
  const [tab, setTab] = useState<TaxonomyTab>(initialTab);
  const [saving, setSaving] = useState(false);

  // Category state
  const [catEditId, setCatEditId] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catDesc, setCatDesc] = useState('');

  // Brand state
  const [brandEditId, setBrandEditId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState('');

  // Unit state
  const [unitEditId, setUnitEditId] = useState<string | null>(null);
  const [unitCode, setUnitCode] = useState('');
  const [unitNameEn, setUnitNameEn] = useState('');
  const [unitNameHi, setUnitNameHi] = useState('');
  const [unitDecimal, setUnitDecimal] = useState(false);

  const canManage = hasCapability(profile?.role, 'items');

  if (!open) return null;

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || !catName.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('save_item_category', {
        p_id: catEditId,
        p_name: catName.trim(),
        p_description: catDesc.trim() || null,
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

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center p-0 md:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('items.manageTaxonomy')}
        className="w-full md:max-w-2xl max-h-[90vh] rounded-t-2xl md:rounded-2xl bg-[var(--surface)] border border-[var(--border)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('items.manageTaxonomy')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 border-b border-[var(--border)] flex gap-2">
          {(
            [
              ['categories', t('items.categories'), categories.length],
              ['brands', t('items.brands'), brands.length],
              ['units', t('items.units'), units.length],
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
                  className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] grid grid-cols-1 sm:grid-cols-3 gap-2.5 items-end"
                >
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      Category Name
                    </label>
                    <input
                      type="text"
                      value={catName}
                      onChange={(e) => setCatName(e.target.value)}
                      placeholder="e.g., Dairy & Oils"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      required
                    />
                  </div>
                  <div>
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
                  <div className="flex items-center gap-2">
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
                      <span>{catEditId ? 'Update' : 'Add Category'}</span>
                    </button>
                    {catEditId && (
                      <button
                        type="button"
                        onClick={() => {
                          setCatEditId(null);
                          setCatName('');
                          setCatDesc('');
                        }}
                        className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                </form>
              )}

              <div className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl overflow-hidden">
                {categories.length === 0 ? (
                  <p className="p-4 text-sm text-[var(--text-muted)]">
                    No categories yet.
                  </p>
                ) : (
                  categories.map((c) => (
                    <div
                      key={c.id}
                      className="px-4 py-3 flex items-center justify-between gap-3 bg-[var(--surface)]"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{c.name}</p>
                        {c.description && (
                          <p className="text-xs text-[var(--text-muted)] truncate">
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
                  className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-end"
                >
                  <div className="flex-1">
                    <label className="block text-xs font-medium mb-1">
                      Brand Name
                    </label>
                    <input
                      type="text"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      placeholder="e.g., Tata, Amul, Cipla"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      required
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={saving}
                      className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center justify-center gap-1"
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
                        }}
                        className="h-10 px-3 rounded-lg border border-[var(--border)] text-xs"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                </form>
              )}

              <div className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-xl overflow-hidden">
                {brands.length === 0 ? (
                  <p className="p-4 text-sm text-[var(--text-muted)]">
                    No brands yet.
                  </p>
                ) : (
                  brands.map((b) => (
                    <div
                      key={b.id}
                      className="px-4 py-3 flex items-center justify-between gap-3 bg-[var(--surface)]"
                    >
                      <span className="text-sm font-medium">{b.name}</span>
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => {
                            setBrandEditId(b.id);
                            setBrandName(b.name);
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
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-xs font-medium mb-1">
                        Short Code
                      </label>
                      <input
                        type="text"
                        value={unitCode}
                        onChange={(e) => setUnitCode(e.target.value.toUpperCase())}
                        placeholder="e.g., CASE"
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
                        placeholder="e.g., Case"
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
                        placeholder="जैसे: केस"
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                      />
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
                      <span>Allow decimal quantities (e.g., 1.250 kg)</span>
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
                {units.map((u) => (
                  <div
                    key={u.id}
                    className="px-4 py-2.5 flex items-center justify-between gap-3 bg-[var(--surface)] text-sm"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[var(--surface-muted)] border border-[var(--border)]">
                        {u.code}
                      </span>
                      <span className="truncate">
                        {u.name_en} · {u.name_hi}
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
