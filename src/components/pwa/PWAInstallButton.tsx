import { IconDownload, IconShare, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { usePWAInstall } from './usePWAInstall';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const { t } = useApp();
  const [showIosGuide, setShowIosGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-muted)] transition-colors whitespace-nowrap shrink-0"
      >
        <IconDownload size={16} stroke={2} />
        <span>{t('app.installApp')}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIosGuide(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-muted)] transition-colors whitespace-nowrap shrink-0"
        >
          <IconShare size={16} stroke={2} />
          <span>{t('app.installIos')}</span>
        </button>

        {showIosGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-sm rounded-xl bg-[var(--surface)] border border-[var(--border)] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-[var(--text)]">
                  {t('app.installIos')}
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIosGuide(false)}
                  aria-label={t('common.close')}
                  className="p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  <IconX size={18} stroke={2} />
                </button>
              </div>
              <p className="text-sm text-[var(--text-muted)] leading-relaxed">
                1. Tap the <strong>Share</strong> button in Safari.
                <br />
                2. Tap <strong>Add to Home Screen</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIosGuide(false)}
                className="w-full py-2.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-medium"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}
