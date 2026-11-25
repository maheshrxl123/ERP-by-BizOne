const STORAGE_PREFIX = 'decorbiz_totp_proof_';

let activeUserId: string | null = null;
const memoryProofs = new Map<string, string>();
const totpRequiredListeners = new Set<() => void>();

export function setActiveStaffUserId(userId: string | null) {
  activeUserId = userId;
}

export function setTotpProof(userId: string, token: string) {
  if (!userId || !token) return;
  memoryProofs.set(userId, token);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(`${STORAGE_PREFIX}${userId}`, token);
    } catch {
      // Ignore storage quota / private mode issues
    }
  }
}

export function getTotpProof(userId?: string | null): string | null {
  const targetId = userId ?? activeUserId;
  if (!targetId) return null;
  const mem = memoryProofs.get(targetId);
  if (mem) return mem;
  if (typeof window !== 'undefined') {
    try {
      const stored = window.sessionStorage.getItem(`${STORAGE_PREFIX}${targetId}`);
      if (stored) {
        memoryProofs.set(targetId, stored);
        return stored;
      }
    } catch {
      // Ignore storage issues
    }
  }
  return null;
}

export function clearTotpProof(userId?: string | null) {
  if (userId) {
    memoryProofs.delete(userId);
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(`${STORAGE_PREFIX}${userId}`);
      } catch {
        // Ignore
      }
    }
    return;
  }

  memoryProofs.clear();
  if (typeof window !== 'undefined') {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        window.sessionStorage.removeItem(k);
      }
    } catch {
      // Ignore
    }
  }
}

export function onTotpRequired(listener: () => void): () => void {
  totpRequiredListeners.add(listener);
  return () => {
    totpRequiredListeners.delete(listener);
  };
}

export function toErpApiUrl(input: string): string {
  if (
    input.startsWith('/api/erp/') ||
    input.startsWith('/api/store/') ||
    input.startsWith('/api/share/')
  ) {
    return input;
  }
  if (input.startsWith('/api/')) {
    return `/api/erp/${input.slice('/api/'.length)}`;
  }
  return input;
}

export function getErpAuthHeaders(
  accessToken?: string | null,
  extraHeaders?: HeadersInit,
  userId?: string | null
): Headers {
  const headers = new Headers(extraHeaders);
  if (accessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const proof = getTotpProof(userId);
  if (proof && !headers.has('X-ERP-TOTP-Token')) {
    headers.set('X-ERP-TOTP-Token', proof);
  }
  return headers;
}

export async function erpFetch(
  input: string,
  accessToken?: string | null,
  init: RequestInit = {}
): Promise<Response> {
  const url = toErpApiUrl(input);
  const headers = getErpAuthHeaders(accessToken, init.headers);
  const response = await fetch(url, { ...init, headers });

  if (response.status === 403) {
    try {
      const cloned = response.clone();
      const body = (await cloned.json()) as { code?: string };
      if (body?.code === 'TOTP_REQUIRED') {
        clearTotpProof(activeUserId);
        for (const listener of totpRequiredListeners) {
          listener();
        }
      }
    } catch {
      // Non-JSON 403 (e.g. IP allowlist HTML/JSON); leave untouched
    }
  }

  return response;
}
