import { useEffect, useRef } from 'react';

export function playScanBeep(success = true): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(success ? 1320 : 420, ctx.currentTime);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (success ? 0.09 : 0.16));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (success ? 0.09 : 0.16));
    setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 220);
  } catch {
    // Ignore Web Audio restrictions cleanly
  }
}

interface UseBarcodeWedgeOptions {
  enabled: boolean;
  onScan: (code: string) => void;
  minLength?: number;
}

/**
 * Listens globally for USB/Bluetooth HID keyboard-wedge barcode scanners.
 * Hardware scanners type characters rapidly (< 55ms apart) and terminate with Enter.
 * Safely avoids hijacking manual typing inside normal form inputs.
 */
export function useBarcodeWedge({
  enabled,
  onScan,
  minLength = 3,
}: UseBarcodeWedgeOptions): void {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    let buffer = '';
    let firstTs = 0;
    let lastTs = 0;

    const reset = () => {
      buffer = '';
      firstTs = 0;
      lastTs = 0;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const isBarcodeField = target?.dataset?.barcodeInput === 'true';
      const isTextControl =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);

      // Dedicated barcode inputs handle their own Enter key cleanly
      if (isBarcodeField) {
        reset();
        return;
      }

      const now = Date.now();
      if (lastTs > 0 && now - lastTs > 90) {
        reset();
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        if (buffer.length >= minLength) {
          const totalDuration = now - firstTs;
          const avgInterval = totalDuration / Math.max(1, buffer.length);
          // When cursor is inside a regular text input, only intercept obvious hardware-speed bursts
          if (!isTextControl || avgInterval < 45) {
            e.preventDefault();
            e.stopPropagation();
            const scannedCode = buffer.trim();
            reset();
            if (scannedCode) {
              onScanRef.current(scannedCode);
            }
            return;
          }
        }
        reset();
        return;
      }

      if (e.key.length === 1) {
        if (buffer.length === 0) {
          firstTs = now;
        }
        lastTs = now;
        buffer += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [enabled, minLength]);
}
