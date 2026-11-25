import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { decryptSecret } from './crypto.ts';
import { isModuleEnabledServer } from './middleware.ts';

export interface RazorpaySignatureInput {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}

export function computeRazorpaySignature(
  orderId: string,
  paymentId: string,
  keySecret: string
): string {
  return crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

export function verifyRazorpaySignature(input: RazorpaySignatureInput): boolean {
  const orderId = (input.orderId || '').trim();
  const paymentId = (input.paymentId || '').trim();
  const signature = (input.signature || '').trim().toLowerCase();
  const keySecret = (input.keySecret || '').trim();

  if (!orderId || !paymentId || !signature || !keySecret) {
    return false;
  }

  const expected = computeRazorpaySignature(orderId, paymentId, keySecret);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export interface StoreRazorpayConfig {
  enabled: boolean;
  provider: string;
  mode: string;
  keyId: string | null;
  keySecret: string | null;
}

export async function getStoreRazorpayConfig(
  admin: SupabaseClient
): Promise<StoreRazorpayConfig> {
  const modEnabled = await isModuleEnabledServer('online_payments');
  if (!modEnabled) {
    return {
      enabled: false,
      provider: 'razorpay',
      mode: 'test',
      keyId: null,
      keySecret: null,
    };
  }

  const { data: slot } = await admin
    .from('integration_settings')
    .select('enabled, config_public, has_secret, encrypted_secret')
    .eq('integration_key', 'online_payments')
    .maybeSingle();

  const pub = (slot?.config_public || {}) as Record<string, unknown>;
  const provider = typeof pub.provider === 'string' ? pub.provider : 'razorpay';
  const mode = typeof pub.mode === 'string' ? pub.mode : 'test';
  const keyId = typeof pub.key_id === 'string' ? pub.key_id.trim() : '';

  if (
    !slot?.enabled ||
    provider !== 'razorpay' ||
    !keyId ||
    !slot.has_secret ||
    !slot.encrypted_secret
  ) {
    return {
      enabled: false,
      provider,
      mode,
      keyId: null,
      keySecret: null,
    };
  }

  let keySecret = '';
  try {
    keySecret = decryptSecret(slot.encrypted_secret).trim();
  } catch {
    return {
      enabled: false,
      provider,
      mode,
      keyId: null,
      keySecret: null,
    };
  }

  if (!keySecret) {
    return {
      enabled: false,
      provider,
      mode,
      keyId: null,
      keySecret: null,
    };
  }

  return {
    enabled: true,
    provider,
    mode,
    keyId,
    keySecret,
  };
}

export async function createRazorpayRemoteOrder(params: {
  keyId: string;
  keySecret: string;
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<{ id: string; amount: number; currency: string; status: string }> {
  const auth = Buffer.from(`${params.keyId}:${params.keySecret}`).toString('base64');
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: Math.max(100, Math.round(params.amountPaise)),
      currency: 'INR',
      receipt: params.receipt.slice(0, 40),
      notes: params.notes || {},
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    amount?: number;
    currency?: string;
    status?: string;
    error?: { description?: string };
  };

  if (!response.ok || !payload.id) {
    throw new Error(
      payload?.error?.description || 'Failed to initialize Razorpay payment order.'
    );
  }

  return {
    id: payload.id,
    amount: Number(payload.amount || params.amountPaise),
    currency: String(payload.currency || 'INR'),
    status: String(payload.status || 'created'),
  };
}
