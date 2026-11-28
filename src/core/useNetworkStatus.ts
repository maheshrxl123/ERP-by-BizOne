import { useCallback, useEffect, useState } from 'react';

async function probeServerReachable(timeoutMs = 2500): Promise<boolean> {
  if (typeof fetch === 'undefined') return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/health', {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function useNetworkStatus(): {
  isOnline: boolean;
  checking: boolean;
  recheck: () => Promise<boolean>;
} {
  // Start optimistic on cold load to avoid false-positive offline banners in sandboxed/iframe environments
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [checking, setChecking] = useState<boolean>(false);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const reachable = await probeServerReachable(2500);
      setIsOnline(reachable);
      return reachable;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const sync = async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        if (active) setIsOnline(true);
        return;
      }
      const reachable = await probeServerReachable(2500);
      if (active) setIsOnline(reachable);
    };

    void sync();

    const handleOnline = () => {
      void recheck();
    };
    const handleOffline = () => {
      void sync();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void sync();
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [recheck]);

  return { isOnline, checking, recheck };
}
