import { IconBarcode, IconCamera, IconSearch } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { BarcodeScannerModal } from './BarcodeScannerModal';
import { playScanBeep } from './useBarcodeWedge';

interface BarcodeScanBarProps {
  searchQuery: string;
  onSearchChange: (val: string) => void;
  onScanSubmit: (code: string) => boolean;
  placeholder?: string;
  scanButtonLabel?: string;
  continuousCameraDefault?: boolean;
  scannerTitle?: string;
}

export function BarcodeScanBar({
  searchQuery,
  onSearchChange,
  onScanSubmit,
  placeholder = 'Scan barcode or search item name / SKU...',
  scanButtonLabel = 'Camera Scan',
  continuousCameraDefault = true,
  scannerTitle = 'Scan Item Barcode',
}: BarcodeScanBarProps) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const raw = searchQuery.trim();
    if (!raw) return;
    e.preventDefault();
    const matched = onScanSubmit(raw);
    playScanBeep(matched);
    if (matched) {
      onSearchChange('');
      inputRef.current?.focus();
    }
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="relative flex-1">
          <IconBarcode
            size={18}
            stroke={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--primary-dark)]"
          />
          <input
            ref={inputRef}
            data-barcode-input="true"
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full h-11 pl-10 pr-9 rounded-lg border border-[var(--primary)]/50 bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
          />
          <IconSearch
            size={15}
            stroke={2}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden lg:inline-flex items-center gap-1.5 h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-[11px] font-medium text-[var(--text-muted)]">
            <span className="w-2 h-2 rounded-full bg-[var(--receive)]" />
            <span>Scanner Ready</span>
          </span>
          <button
            type="button"
            onClick={() => setCameraOpen(true)}
            className="h-11 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs sm:text-sm font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <IconCamera size={17} stroke={2} className="text-[var(--primary-dark)]" />
            <span>{scanButtonLabel}</span>
          </button>
        </div>
      </div>

      <BarcodeScannerModal
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        continuousDefault={continuousCameraDefault}
        title={scannerTitle}
        onDetected={(code) => {
          onScanSubmit(code);
        }}
      />
    </>
  );
}
