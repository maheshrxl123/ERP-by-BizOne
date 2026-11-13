import { IconBarcode, IconPrinter, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../app/AppProvider';
import { formatINR } from '../../core/format';
import type { ItemCatalogRecord } from '../../types/bizone';

interface BarcodeLabelModalProps {
  open: boolean;
  items: ItemCatalogRecord[];
  initialItemId?: string | null;
  onClose: () => void;
}

export function BarcodeLabelModal({
  open,
  items,
  initialItemId,
  onClose,
}: BarcodeLabelModalProps) {
  const { business, t } = useApp();
  const [labelSize, setLabelSize] = useState<'50x25' | '38x25'>('50x25');
  const [selectedId, setSelectedId] = useState<string>(
    initialItemId || items.find((i) => i.is_active)?.id || ''
  );
  const [copies, setCopies] = useState(6);

  useEffect(() => {
    if (!open) return;
    if (initialItemId && items.some((i) => i.id === initialItemId)) {
      setSelectedId(initialItemId);
      return;
    }
    setSelectedId((prev) => {
      if (prev && items.some((i) => i.id === prev)) return prev;
      return items.find((i) => i.is_active)?.id || items[0]?.id || '';
    });
  }, [open, initialItemId, items]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedId) || items[0] || null,
    [items, selectedId]
  );

  if (!open) return null;

  const activeItems = items.filter((i) => i.is_active);
  const codeValue =
    selectedItem?.barcode ||
    selectedItem?.sku ||
    (selectedItem ? selectedItem.id.slice(0, 10).toUpperCase() : '00000000');

  return createPortal(
    <div className="print-modal-root">
      <div
        className="print-modal-overlay fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center p-0 md:p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('items.barcodeLabels')}
          className="print-modal-dialog w-full md:max-w-2xl max-h-[90vh] rounded-t-2xl md:rounded-2xl bg-[var(--surface)] border border-[var(--border)] flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
        <div className="no-print px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconBarcode size={20} stroke={2} />
            <h2 className="text-base font-semibold">{t('items.barcodeLabels')}</h2>
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

        <div className="print-modal-body flex-1 overflow-y-auto p-5 space-y-4">
          <div className="no-print grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label className="block text-xs font-medium mb-1">Item</label>
              <select
                value={selectedItem?.id || ''}
                onChange={(e) => setSelectedId(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                {activeItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Label Size
              </label>
              <select
                value={labelSize}
                onChange={(e) =>
                  setLabelSize(e.target.value as '50x25' | '38x25')
                }
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
              >
                <option value="50x25">50 × 25 mm</option>
                <option value="38x25">38 × 25 mm</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Copies</label>
              <input
                type="number"
                min={1}
                max={48}
                value={copies}
                onChange={(e) =>
                  setCopies(Math.max(1, Math.min(48, Number(e.target.value) || 1)))
                }
                className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums"
              />
            </div>
          </div>

          {!selectedItem ? (
            <p className="text-sm text-[var(--text-muted)] py-6 text-center">
              Add an item first to preview printable barcode labels.
            </p>
          ) : (
            <div className="print-surface p-4 rounded-xl border border-[var(--border)] bg-white text-black">
              <div
                className={`grid gap-3 ${
                  labelSize === '50x25' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-4'
                }`}
              >
                {Array.from({ length: copies }).map((_, idx) => (
                  <div
                    key={idx}
                    className="border border-neutral-300 rounded p-2.5 flex flex-col justify-between gap-1 text-center"
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-600 truncate">
                      {business?.name || 'BizOne Store'}
                    </p>
                    <p className="text-xs font-semibold truncate text-neutral-900">
                      {selectedItem.name}
                    </p>
                    <div
                      aria-hidden="true"
                      className="h-7 w-full mx-auto flex items-stretch justify-center gap-[1.5px] py-1"
                    >
                      {codeValue.split('').map((ch, cIdx) => {
                        const wMod = ch.charCodeAt(0) % 3;
                        const wClass =
                          wMod === 0 ? 'w-[1px]' : wMod === 1 ? 'w-[2px]' : 'w-[3px]';
                        return (
                          <span
                            key={cIdx}
                            className={`bg-black inline-block ${wClass}`}
                          />
                        );
                      })}
                    </div>
                    <p className="font-mono text-[10px] tracking-widest text-neutral-800">
                      {codeValue}
                    </p>
                    <div className="flex items-center justify-center gap-2 text-[11px] font-semibold tabular-nums">
                      <span>{formatINR(Number(selectedItem.selling_price))}</span>
                      {selectedItem.mrp &&
                        Number(selectedItem.mrp) > Number(selectedItem.selling_price) && (
                          <span className="text-[10px] font-normal text-neutral-500 line-through">
                            MRP {formatINR(Number(selectedItem.mrp))}
                          </span>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="no-print px-5 py-4 border-t border-[var(--border)] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-lg border border-[var(--border)] text-sm font-medium"
          >
            {t('common.close')}
          </button>
          <button
            type="button"
            disabled={!selectedItem}
            onClick={() => window.print()}
            className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <IconPrinter size={16} stroke={2} />
            <span>Print Labels</span>
          </button>
        </div>
      </div>
    </div>
    </div>,
    document.body
  );
}
