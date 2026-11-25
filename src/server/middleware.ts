import type { SupabaseClient } from '@supabase/supabase-js';
import type { CorsOptionsDelegate } from 'cors';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { verifyTotpProofToken } from './totpSecurity.ts';
import { getSupabaseAdmin, PORT } from './config.ts';
import { createModuleGate } from './moduleGate.ts';

export const DEFAULT_JSON_LIMIT = '2mb';

export const UUID_SCHEMA = z.string().uuid('Invalid identifier format.');
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export interface AuthenticatedRequest extends Request {
  supabaseAdmin?: SupabaseClient;
  staffUser?: {
    id: string;
    email: string;
    role: string;
    is_active: boolean;
  };
}

export async function requireActiveStaff(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(503).json({
      error: 'Supabase environment variables are not configured on the server.',
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return;
  }

  if (
    userData.user.app_metadata?.user_type === 'customer' ||
    userData.user.user_metadata?.user_type === 'customer' ||
    userData.user.user_metadata?.role === 'customer'
  ) {
    res.status(403).json({ error: 'Customer tokens are not permitted on ERP endpoints.' });
    return;
  }

  const { data: profile, error: profErr } = await admin
    .from('profiles')
    .select('id, email, role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profErr || !profile || !profile.is_active) {
    res.status(403).json({ error: 'Active staff account required.' });
    return;
  }

  const reqPath = (req.originalUrl || req.url || '').split('?')[0].toLowerCase();
  const isTotpChallengeEndpoint =
    reqPath === '/api/erp/auth/totp-status' ||
    reqPath === '/api/erp/auth/totp-validate' ||
    reqPath === '/api/erp/auth/totp-verify';

  if (!isTotpChallengeEndpoint) {
    const { data: totpRow } = await admin
      .from('staff_totp')
      .select('enabled')
      .eq('user_id', profile.id)
      .maybeSingle();

    if (totpRow?.enabled) {
      const proofToken =
        typeof req.headers['x-erp-totp-token'] === 'string'
          ? req.headers['x-erp-totp-token']
          : '';
      if (!verifyTotpProofToken(profile.id, proofToken)) {
        res.status(403).json({
          error: 'Two-factor authentication verification required.',
          code: 'TOTP_REQUIRED',
        });
        return;
      }
    }
  }

  req.supabaseAdmin = admin;
  req.staffUser = profile;
  next();
}

export function requireOwner(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.staffUser || req.staffUser.role !== 'owner') {
    res.status(403).json({ error: 'Owner permission required.' });
    return;
  }
  next();
}

export function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4) return false;
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.length >= 12 &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 4).toString('ascii') === '%PDF';
  }
  return false;
}

export async function writeAudit(
  actorId: string | null,
  actorEmail: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) return;
  await admin.from('audit_logs').insert({
    actor_id: actorId,
    actor_email: actorEmail,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details,
  });
}

export async function isModuleEnabledServer(moduleKey: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;
  const { data } = await admin
    .from('modules_state')
    .select('enabled')
    .eq('module_key', moduleKey)
    .maybeSingle();
  return Boolean(data?.enabled);
}

export async function getEnabledModulesSet(admin: SupabaseClient): Promise<Set<string>> {
  const { data } = await admin
    .from('modules_state')
    .select('module_key, enabled')
    .eq('enabled', true);
  return new Set((data || []).map((r) => String(r.module_key)));
}

export const requireModuleEnabled = createModuleGate((moduleKey) =>
  isModuleEnabledServer(moduleKey)
);

export function resolveRequestOrigin(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = String(
    req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`
  )
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function getConfiguredCorsAllowlist(): Set<string> {
  const allowlist = new Set<string>([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  const raw = process.env.ALLOWED_ORIGINS?.trim() || '';
  if (raw) {
    for (const part of raw.split(',')) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      try {
        allowlist.add(new URL(cleaned).origin);
      } catch {
        allowlist.add(cleaned.replace(/\/+$/, ''));
      }
    }
  }
  return allowlist;
}

export function createCorsOptions(): CorsOptionsDelegate<Request> {
  const staticAllowlist = getConfiguredCorsAllowlist();
  return (req, callback) => {
    const requestOrigin = req.headers.origin;
    if (!requestOrigin) {
      callback(null, { origin: false });
      return;
    }
    const selfOrigin = resolveRequestOrigin(req);
    const allowed = staticAllowlist.has(requestOrigin) || requestOrigin === selfOrigin;
    callback(null, {
      origin: allowed,
      credentials: allowed,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-ERP-TOTP-Token', 'X-Break-Glass-Token'],
      maxAge: 600,
    });
  };
}
