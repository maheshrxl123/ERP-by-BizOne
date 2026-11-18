import type { OfflineBillQueueItem, OfflineSyncResultItem } from '../types/bizone';
import { supabase } from './supabase';

const STORAGE_KEY = 'bizone_pos_offline_queue_v1';

export function generateOfflineIdempotencyKey(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `pos-offline-${rand}`;
}

export function loadOfflineQueue(): OfflineBillQueueItem[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OfflineBillQueueItem[]) : [];
  } catch {
    return [];
  }
}

export function saveOfflineQueue(items: OfflineBillQueueItem[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function enqueueOfflineBill(
  item: Omit<OfflineBillQueueItem, 'local_id' | 'idempotency_key' | 'created_at' | 'sync_status' | 'sync_error'> & {
    idempotency_key?: string;
  }
): OfflineBillQueueItem[] {
  const current = loadOfflineQueue();
  const idempotencyKey = item.idempotency_key || generateOfflineIdempotencyKey();
  // Prevent client-side duplicate queuing of same idempotency key
  if (current.some((x) => x.idempotency_key === idempotencyKey)) {
    return current;
  }
  const entry: OfflineBillQueueItem = {
    ...item,
    local_id: `LOC-${Date.now().toString().slice(-6)}`,
    idempotency_key: idempotencyKey,
    created_at: new Date().toISOString(),
    sync_status: 'queued',
    sync_error: null,
  };
  const next = [entry, ...current];
  saveOfflineQueue(next);
  return next;
}

export function removeOfflineBill(localId: string): OfflineBillQueueItem[] {
  const next = loadOfflineQueue().filter((x) => x.local_id !== localId);
  saveOfflineQueue(next);
  return next;
}

export async function syncOfflineQueue(): Promise<{
  synced: number;
  deduplicated: number;
  failed: number;
  remaining: OfflineBillQueueItem[];
  results: OfflineSyncResultItem[];
}> {
  const queue = loadOfflineQueue();
  const pending = queue.filter(
    (q) => q.sync_status === 'queued' || q.sync_status === 'error'
  );
  if (pending.length === 0) {
    return { synced: 0, deduplicated: 0, failed: 0, remaining: queue, results: [] };
  }

  const { data, error } = await supabase.rpc('sync_offline_bill_queue', {
    p_offline_items: pending,
  });

  if (error) {
    const updated = queue.map((q) => ({
      ...q,
      sync_status: 'error' as const,
      sync_error: error.message,
    }));
    saveOfflineQueue(updated);
    throw error;
  }

  const results = (((data as { results?: OfflineSyncResultItem[] } | null)?.results) ??
    []) as OfflineSyncResultItem[];

  let synced = 0;
  let deduplicated = 0;
  let failed = 0;

  const remaining: OfflineBillQueueItem[] = [];
  for (const q of queue) {
    const r = results.find(
      (res) => res.local_id === q.local_id || res.idempotency_key === q.idempotency_key
    );
    if (!r) {
      remaining.push(q);
      continue;
    }
    if (r.status === 'synced') {
      synced += 1;
    } else if (r.status === 'deduplicated') {
      deduplicated += 1;
    } else {
      failed += 1;
      remaining.push({
        ...q,
        sync_status: 'error',
        sync_error: r.error || 'Sync rejected by server.',
      });
    }
  }

  saveOfflineQueue(remaining);
  return { synced, deduplicated, failed, remaining, results };
}
