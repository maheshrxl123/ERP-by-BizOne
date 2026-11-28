import { IconRefresh, IconWifiOff, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { useNetworkStatus } from '../../core/useNetworkStatus';

export function OfflineIndicator() {
  const { t } = useApp();
  const { isOnline, checking, recheck } = useNetworkStatus();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isOnline) {
      setDismissed(false);
    }
  }, [isOnline]);

  if (isOnline || dismissed) return null;

  return (
    <div
      role="status"
      className="bg-[var(--warning-soft)] border-b border-[var(--warning)] px-4 py-2 text-xs font-medium text-[var(--warning-text)] flex flex-wrap items-center justify-center gap-2.5"
    >
      <span className="inline-flex items-center gap-2">
        <IconWifiOff size={16} stroke={2} className="shrink-0" />
        <span>{t('app.offlineBanner')}</span>
      </span>
      <div className="inline-flex items-center gap-1.5">
        <button
          type="button"
          disabled={checking}
          onClick={() => void recheck()}
          className="h-7 px-2.5 rounded border border-[var(--warning)]/60 bg-white/70 hover:bg-white text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-60"
        >
          <IconRefresh size={12} stroke={2} className={checking ? 'animate-spin' : ''} />
          <span>{checking ? 'Checking...' : 'Retry'}</span>
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss offline banner"
          className="h-7 w-7 rounded inline-flex items-center justify-center hover:bg-black/5"
        >
          <IconX size={13} stroke={2} />
        </button>
      </div>
    </div>
  );
}
