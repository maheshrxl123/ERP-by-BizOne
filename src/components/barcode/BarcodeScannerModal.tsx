import {
  IconBarcode,
  IconCamera,
  IconCheck,
  IconSwitchHorizontal,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { useCallback, useEffect, useRef, useState } from 'react';
import { playScanBeep } from './useBarcodeWedge';

interface BarcodeScannerModalProps {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
  title?: string;
  continuousDefault?: boolean;
}

interface NativeBarcodeDetector {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
}

export function BarcodeScannerModal({
  open,
  onClose,
  onDetected,
  title = 'Scan Barcode / QR',
  continuousDefault = false,
}: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [continuous, setContinuous] = useState<boolean>(continuousDefault);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [scannedList, setScannedList] = useState<string[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');

  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (controlsRef.current) {
      try {
        controlsRef.current.stop();
      } catch {
        // ignore
      }
      controlsRef.current = null;
    }
    if (streamRef.current) {
      for (const tr of streamRef.current.getTracks()) {
        try {
          tr.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const handleDecoded = useCallback(
    (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;
      const now = Date.now();
      if (
        lastCodeRef.current.code === code &&
        now - lastCodeRef.current.at < (continuousRef.current ? 1400 : 800)
      ) {
        return;
      }
      lastCodeRef.current = { code, at: now };
      if (soundRef.current) {
        playScanBeep(true);
      }
      setScannedList((prev) => [code, ...prev.slice(0, 7)]);
      onDetectedRef.current(code);
      if (!continuousRef.current) {
        stopCamera();
        onClose();
      }
    },
    [onClose, stopCamera]
  );

  useEffect(() => {
    if (!open) {
      stopCamera();
      return;
    }

    setCameraError(null);
    setScannedList([]);
    lastCodeRef.current = { code: '', at: 0 };

    let cancelled = false;

    const start = async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setCameraError(
          'Camera API is unavailable in this browser/context. Use USB/Bluetooth scanner or manual barcode entry below.'
        );
        return;
      }

      try {
        // Discover cameras cleanly
        const allDevices = await BrowserMultiFormatReader.listVideoInputDevices().catch(
          () => [] as MediaDeviceInfo[]
        );
        if (cancelled) return;
        setDevices(allDevices);

        let targetId = selectedDeviceId;
        if (!targetId && allDevices.length > 0) {
          const rear = allDevices.find((d) =>
            /back|rear|environment/i.test(d.label || '')
          );
          targetId = rear?.deviceId || allDevices[0].deviceId;
          setSelectedDeviceId(targetId);
        }

        const nativeDetectorCtor = (
          window as unknown as {
            BarcodeDetector?: new (opts?: { formats?: string[] }) => NativeBarcodeDetector;
          }
        ).BarcodeDetector;

        if (nativeDetectorCtor) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: targetId
              ? { deviceId: { exact: targetId } }
              : { facingMode: { ideal: 'environment' } },
            audio: false,
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          const videoEl = videoRef.current;
          if (!videoEl) return;
          videoEl.srcObject = stream;
          await videoEl.play().catch(() => {});

          const detector = new nativeDetectorCtor({
            formats: [
              'ean_13',
              'ean_8',
              'upc_a',
              'upc_e',
              'code_128',
              'code_39',
              'code_93',
              'codabar',
              'itf',
              'qr_code',
              'data_matrix',
            ],
          });

          let lastCheck = 0;
          const tick = async (ts: number) => {
            if (cancelled) return;
            if (videoEl.readyState >= 2 && ts - lastCheck > 140) {
              lastCheck = ts;
              try {
                const hits = await detector.detect(videoEl);
                if (hits.length > 0 && hits[0]?.rawValue) {
                  handleDecoded(hits[0].rawValue);
                }
              } catch {
                // Ignore frame decode error
              }
            }
            if (!cancelled) {
              rafRef.current = requestAnimationFrame((t) => void tick(t));
            }
          };
          rafRef.current = requestAnimationFrame((t) => void tick(t));
          return;
        }

        // Cross-browser ZXing fallback (Safari/Firefox/iOS)
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.ITF,
          BarcodeFormat.QR_CODE,
        ]);
        const reader = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 160,
        });
        if (!videoRef.current) return;
        const controls = await reader.decodeFromVideoDevice(
          targetId || undefined,
          videoRef.current,
          (result) => {
            if (cancelled) return;
            if (result) {
              handleDecoded(result.getText());
            }
          }
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (err) {
        if (cancelled) return;
        setCameraError(
          err instanceof Error
            ? `Camera permission or device unavailable: ${err.message}`
            : 'Unable to access camera. Check browser camera permission.'
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open, selectedDeviceId, handleDecoded, stopCamera]);

  if (!open) return null;

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = manualCode.trim();
    if (!trimmed) return;
    handleDecoded(trimmed);
    setManualCode('');
  };

  const handleSwitchCamera = () => {
    if (devices.length < 2) return;
    const idx = devices.findIndex((d) => d.deviceId === selectedDeviceId);
    const next = devices[(idx + 1) % devices.length];
    if (next) setSelectedDeviceId(next.deviceId);
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-3 sm:p-4"
      onClick={() => {
        stopCamera();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <IconCamera size={18} stroke={2} className="text-[var(--primary-dark)]" />
            <h2 className="text-sm sm:text-base font-semibold">{title}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            {devices.length > 1 && (
              <button
                type="button"
                onClick={handleSwitchCamera}
                title="Switch camera"
                className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1 hover:bg-[var(--surface-muted)]"
              >
                <IconSwitchHorizontal size={14} stroke={2} />
                <span className="hidden sm:inline">Flip</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setSoundEnabled((s) => !s)}
              aria-label={soundEnabled ? 'Mute scan beep' : 'Enable scan beep'}
              className="h-8 w-8 rounded-lg border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            >
              {soundEnabled ? <IconVolume size={15} stroke={2} /> : <IconVolumeOff size={15} stroke={2} />}
            </button>
            <button
              type="button"
              aria-label="Close scanner"
              onClick={() => {
                stopCamera();
                onClose();
              }}
              className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            >
              <IconX size={18} stroke={2} />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <div className="relative aspect-[4/3] w-full rounded-xl overflow-hidden bg-slate-950 border border-[var(--border)] flex items-center justify-center">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="w-full h-full object-cover"
            />
            {!cameraError && (
              <div className="pointer-events-none absolute inset-6 border-2 border-amber-400/75 rounded-lg">
                <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 h-0.5 bg-amber-400/90" />
              </div>
            )}
            {cameraError && (
              <div className="absolute inset-0 bg-slate-950/92 p-5 flex flex-col items-center justify-center text-center text-xs text-slate-200 gap-2">
                <IconBarcode size={28} stroke={1.8} className="text-amber-400" />
                <p className="max-w-xs leading-relaxed">{cameraError}</p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <label className="inline-flex items-center gap-2 font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={continuous}
                onChange={(e) => setContinuous(e.target.checked)}
                className="w-4 h-4 accent-[var(--primary-dark)]"
              />
              <span>Continuous multi-item scan</span>
            </label>
            <span className="text-[var(--text-muted)] tabular-nums">
              {scannedList.length > 0 ? `Scanned: ${scannedList.length}` : 'Point camera at EAN / UPC / Code-128 / QR'}
            </span>
          </div>

          {scannedList.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {scannedList.map((code, idx) => (
                <span
                  key={`${code}-${idx}`}
                  className="px-2 py-1 rounded border border-[var(--receive)]/40 bg-[var(--receive-soft)] text-[11px] font-mono text-[var(--receive-text)]"
                >
                  {code}
                </span>
              ))}
            </div>
          )}

          <form onSubmit={handleManualSubmit} className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="Or type / paste barcode number..."
              className="flex-1 h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
            />
            <button
              type="submit"
              disabled={!manualCode.trim()}
              className="h-10 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-50"
            >
              <IconCheck size={15} stroke={2.5} />
              <span>Use Code</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
