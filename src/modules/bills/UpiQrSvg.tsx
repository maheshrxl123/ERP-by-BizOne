import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

interface UpiQrSvgProps {
  value: string;
  size?: number;
  alt?: string;
  className?: string;
}

export function UpiQrSvg({
  value,
  size = 112,
  alt = 'UPI QR Code',
  className = '',
}: UpiQrSvgProps) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    let active = true;
    if (!value.trim()) {
      setDataUrl('');
      return;
    }
    QRCode.toDataURL(value, {
      width: size * 2,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
    })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active) setDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [value, size]);

  if (!dataUrl) return null;

  return (
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      className={`rounded-lg border border-[var(--border)] bg-white p-1 ${className}`}
    />
  );
}
