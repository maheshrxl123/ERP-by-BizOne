import {
  IconArrowDownLeft,
  IconArrowUpRight,
  IconLoader2,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { todayLocalIso } from '../../core/format';
import { supabase } from '../../core/supabase';
import { convertToBaseQty, formatStockQty } from '../../core/units';
import type {
  ItemCatalogRecord,
  ItemUnitRecord,
  ItemVariantRecord,
  UnitConversionRecord,
} from '../../types/decorbiz';

interface StockAdjustmentModalProps {
  open: boolean;
  item: ItemCatalogRecord | null;
  units: ItemUnitRecord[];
  conversions: UnitConversionRecord[];
  onClose: () => void;
  onAdjusted: () => Promise<void> | void;
}

export function StockAdjustmentModal({
  open,
  item,
  units,
  conversions,
  onClose,
  onAdjusted,
}: StockAdjustmentModalProps) {
  const { language, showToast, t } = useApp();
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [qtyStr, setQtyStr] = useState('1');
  const [unitId, setUnitId] = useState('');
  const [reason, setReason] = useState('');
  const [movementDate, setMovementDate] = useState(() => todayLocalIso());
  const [idempKey, setIdempKey] = useState(() => crypto.randomUUID());
  const [variants, setVariants] = useState<ItemVariantRecord[]>([]);
  const [variantId, setVariantId] = useState('');
  const [shade, setShade] = useState('');
  const [batchLot, setBatchLot] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !item) return;
    setDirection('in');
    setQtyStr('1');
    setUnitId(item.base_unit_id);
    setReason('');
    setMovementDate(todayLocalIso());
    setIdempKey(crypto.randomUUID());
    setVariantId('');
    setShade('');
    setBatchLot('');
    setError(null);

    let active = true;
    supabase
      .from('item_variants_view')
      .select('*')
      .eq('item_id', item.id)
      .eq('is_active', true)
      .order('variant_name')
      .then(({ data }) => {
        if (active) setVariants((data as ItemVariantRecord[] | null) ?? []);
      });
    return () => {
      active = false;
    };
  }, [open, item]);

  const selectableUnits = useMemo(() => {
    if (!item) return [];
    const baseUnit = units.find((u) => u.id === item.base_unit_id);
    const altIds = new Set(conversions.map((c) => c.alternate_unit_id));
    const alts = units.filter((u) => altIds.has(u.id) && u.id !== item.base_unit_id);
    return baseUnit ? [baseUnit, ...alts] : alts;
  }, [item, units, conversions]);

  const preview = useMemo(() => {
    if (!item) return null;
    const qty = Number(qtyStr);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    try {
      const conv = convertToBaseQty({
        qty,
        unitId: unitId || item.base_unit_id,
        baseUnitId: item.base_unit_id,
        baseAllowDecimal: item.base_unit_allow_decimal,
        conversions,
      });
      const signed = direction === 'in' ? conv.baseQty : -conv.baseQty;
      const resulting = Number(item.qty_on_hand || 0) + signed;
      return {
        ...conv,
        signed,
        resulting,
        negativeBlocked: resulting < 0 && !item.allow_negative_stock,
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Invalid quantity',
      };
    }
  }, [item, qtyStr, unitId, conversions, direction]);

  if (!open || !item) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(qtyStr);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be greater than zero.');
      return;
    }
    if (reason.trim().length < 3) {
      setError('Please enter a reason (minimum 3 characters).');
      return;
    }
    if (preview && 'negativeBlocked' in preview && preview.negativeBlocked) {
      setError(
        `Insufficient stock. Available: ${formatStockQty(
          item.qty_on_hand,
          item.base_unit_code
        )}. Negative stock is disabled for this item.`
      );
      return;
    }

    setSaving(true);
    try {
      const { error: rpcErr } = await supabase.rpc('adjust_stock', {
        p_item_id: item.id,
        p_direction: direction,
        p_qty: qty,
        p_unit_id: unitId || item.base_unit_id,
        p_reason: reason.trim(),
        p_movement_date: movementDate,
        p_idempotency_key: idempKey,
        p_variant_id: variantId || null,
        p_shade: shade.trim() || null,
        p_batch_lot: batchLot.trim() || null,
      });
      if (rpcErr) throw rpcErr;

      showToast(
        language === 'hi'
          ? 'स्टॉक समायोजन दर्ज हो गया।'
          : 'Stock adjustment posted.',
        'success'
      );
      await onAdjusted();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unable to adjust stock.';
      setError(msg);
      showToast(msg, 'error');
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
        aria-label={t('items.adjustStock')}
        className="w-full md:max-w-lg rounded-t-2xl md:rounded-2xl bg-[var(--surface)] border border-[var(--border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t('items.adjustStock')}</h2>
            <p className="text-xs text-[var(--text-muted)] truncate">
              {item.name} · {t('items.stockOnHand')}:{' '}
              <span className="font-medium tabular-nums">
                {formatStockQty(item.qty_on_hand, item.base_unit_code)}
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

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs text-[var(--give)]">
              {error}
            </div>
          )}

          {/* Direction toggle */}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setDirection('in')}
              className={`h-11 px-3 rounded-xl border text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-1.5 ${
                direction === 'in'
                  ? 'border-[var(--receive)] bg-[var(--receive-soft)] text-[var(--receive-text)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
              }`}
            >
              <IconArrowDownLeft size={16} stroke={2} />
              <span>{t('items.addStock')}</span>
            </button>
            <button
              type="button"
              onClick={() => setDirection('out')}
              className={`h-11 px-3 rounded-xl border text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-1.5 ${
                direction === 'out'
                  ? 'border-[var(--give)] bg-[var(--give-soft)] text-[var(--give)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
              }`}
            >
              <IconArrowUpRight size={16} stroke={2} />
              <span>{t('items.reduceStock')}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">
                {t('items.quantity')}
              </label>
              <input
                type="number"
                step="any"
                min="0.001"
                inputMode="decimal"
                value={qtyStr}
                onChange={(e) => setQtyStr(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {t('items.unit')}
              </label>
              <select
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {selectableUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code} · {language === 'hi' ? u.name_hi : u.name_en}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {preview && (
            <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs space-y-1">
              {'error' in preview ? (
                <p className="text-[var(--give)]">{preview.error}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-muted)]">
                      {t('items.convertedBaseQty')} (×{preview.factor})
                    </span>
                    <span className="font-semibold tabular-nums">
                      {preview.signed > 0 ? '+' : ''}
                      {formatStockQty(preview.signed, item.base_unit_code)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--text-muted)]">
                      Resulting Balance
                    </span>
                    <span
                      className={`font-semibold tabular-nums ${
                        preview.negativeBlocked ? 'text-[var(--give)]' : ''
                      }`}
                    >
                      {formatStockQty(preview.resulting, item.base_unit_code)}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Optional Variant, Shade & Batch Lot Tracking */}
          {(variants.length > 0 || item.product_line === 'tiles_slabs') && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50">
              {variants.length > 0 && (
                <div className="sm:col-span-3">
                  <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                    Variant (Optional)
                  </label>
                  <select
                    value={variantId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setVariantId(nextId);
                      const v = variants.find((x) => x.id === nextId);
                      if (v) {
                        if (v.shade) setShade(v.shade);
                        if (v.batch_lot) setBatchLot(v.batch_lot);
                      }
                    }}
                    className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    <option value="">Base Item (No Variant)</option>
                    {variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.variant_name} ({formatStockQty(v.qty_on_hand, item.base_unit_code)})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className={variants.length > 0 ? 'sm:col-span-1' : 'sm:col-span-1'}>
                <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                  Shade / Tone
                </label>
                <input
                  type="text"
                  value={shade}
                  onChange={(e) => setShade(e.target.value)}
                  placeholder="e.g. A12 / Ivory"
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                  Batch / Lot No.
                </label>
                <input
                  type="text"
                  value={batchLot}
                  onChange={(e) => setBatchLot(e.target.value)}
                  placeholder="e.g. LOT-2026-03"
                  className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-mono"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">
                {t('items.date')}
              </label>
              <input
                type="date"
                value={movementDate}
                onChange={(e) => setMovementDate(e.target.value)}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {t('items.reason')}
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('items.reasonPlaceholder')}
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
                required
                minLength={3}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
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
              <span>{t('items.saveAdjustment')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
