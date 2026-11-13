import { IconWifiOff } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';

export function OfflineIndicator() {
  const { t } = useApp();
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="bg-[var(--warning-soft)] border-b border-[var(--warning)] px-4 py-2 text-xs font-medium text-[var(--warning-text)] flex items-center justify-center gap-2"
    >
      <IconWifiOff size={16} stroke={2} />
      <span>{t('app.offlineBanner')}</span>
    </div>
  );
}
