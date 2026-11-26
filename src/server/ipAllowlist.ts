import type { Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin } from './config.ts';
import { extractRequestIp } from './rateLimit.ts';

const STAFF_API_PREFIXES = [
  '/api/erp',
  '/api/admin',
  '/api/store-admin',
  '/api/integrations',
  '/api/files',
  '/api/backup',
  '/api/ai',
  '/api/messaging',
  '/api/einvoice',
  '/api/setup',
  '/api/locations',
  '/api/accounting',
  '/api/gst-returns',
  '/api/pos',
  '/api/online-payments',
  '/api/email-notifications',
  '/api/online-store',
  '/api/language',
];

export function isErpRequestPath(rawPath: string): boolean {
  const pathOnly = String(rawPath || '').split('?')[0].toLowerCase();
  if (pathOnly === '/api/integrations/google-drive/callback') {
    return false;
  }
  if (pathOnly === '/erp' || pathOnly.startsWith('/erp/') || pathOnly === '/erp.html') {
    return true;
  }
  return STAFF_API_PREFIXES.some(
    (prefix) => pathOnly === prefix || pathOnly.startsWith(`${prefix}/`)
  );
}

export interface IpAccessEvaluationInput {
  path: string;
  clientIp: string;
  allowedIps: string[];
  bypassEnv?: string;
  breakGlassTokenEnv?: string;
  breakGlassTokenHeader?: string;
  breakGlassIpEnv?: string;
}

export interface IpAccessEvaluationResult {
  allowed: boolean;
  isErpRequest: boolean;
  clientIp: string;
  reason: 'public_path' | 'env_bypass' | 'break_glass_token' | 'loopback' | 'break_glass_ip' | 'allowlist_empty' | 'allowlist_match' | 'blocked';
}

export function evaluateIpAccess(input: IpAccessEvaluationInput): IpAccessEvaluationResult {
  const isErpRequest = isErpRequestPath(input.path);
  const clientIp = input.clientIp.trim() || '127.0.0.1';

  if (!isErpRequest) {
    return { allowed: true, isErpRequest: false, clientIp, reason: 'public_path' };
  }

  if (input.bypassEnv === 'true') {
    return { allowed: true, isErpRequest: true, clientIp, reason: 'env_bypass' };
  }

  if (
    input.breakGlassTokenEnv &&
    input.breakGlassTokenHeader &&
    input.breakGlassTokenHeader.trim() === input.breakGlassTokenEnv.trim()
  ) {
    return { allowed: true, isErpRequest: true, clientIp, reason: 'break_glass_token' };
  }

  if (['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(clientIp)) {
    return { allowed: true, isErpRequest: true, clientIp, reason: 'loopback' };
  }

  if (input.breakGlassIpEnv && clientIp === input.breakGlassIpEnv.trim()) {
    return { allowed: true, isErpRequest: true, clientIp, reason: 'break_glass_ip' };
  }

  const normalizedList = Array.isArray(input.allowedIps)
    ? input.allowedIps.map((ip) => String(ip).trim()).filter(Boolean)
    : [];

  if (normalizedList.length === 0) {
    return { allowed: true, isErpRequest: true, clientIp, reason: 'allowlist_empty' };
  }

  if (normalizedList.includes(clientIp)) {
    return { allowed: true, isErpRequest: true, clientIp, reason: 'allowlist_match' };
  }

  return { allowed: false, isErpRequest: true, clientIp, reason: 'blocked' };
}

export async function requireIpAllowlist(req: Request, res: Response, next: NextFunction): Promise<void> {
  const path = req.originalUrl || req.path || req.url;
  if (!isErpRequestPath(path)) {
    next();
    return;
  }

  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const clientIp = extractRequestIp(req);
  const preCheck = evaluateIpAccess({
    path,
    clientIp,
    allowedIps: [],
    bypassEnv: process.env.BYPASS_IP_ALLOWLIST,
    breakGlassTokenEnv: process.env.DECORBIZ_BREAKGLASS_TOKEN,
    breakGlassTokenHeader:
      typeof req.headers['x-break-glass-token'] === 'string'
        ? req.headers['x-break-glass-token']
        : undefined,
    breakGlassIpEnv: process.env.DECORBIZ_BREAKGLASS_IP,
  });

  if (
    preCheck.reason === 'env_bypass' ||
    preCheck.reason === 'break_glass_token' ||
    preCheck.reason === 'loopback' ||
    preCheck.reason === 'break_glass_ip'
  ) {
    next();
    return;
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    next();
    return;
  }

  try {
    const { data: biz, error: bizErr } = await admin
      .from('business')
      .select('allowed_ips')
      .eq('id', 1)
      .maybeSingle();

    if (bizErr) {
      res.status(503).json({
        error: 'Unable to verify IP allowlist policy. Please retry shortly or use break-glass recovery.',
      });
      return;
    }

    const allowedIps: string[] = Array.isArray(biz?.allowed_ips) ? biz.allowed_ips : [];
    const evaluation = evaluateIpAccess({
      path,
      clientIp,
      allowedIps,
      bypassEnv: process.env.BYPASS_IP_ALLOWLIST,
      breakGlassTokenEnv: process.env.DECORBIZ_BREAKGLASS_TOKEN,
      breakGlassTokenHeader:
        typeof req.headers['x-break-glass-token'] === 'string'
          ? req.headers['x-break-glass-token']
          : undefined,
      breakGlassIpEnv: process.env.DECORBIZ_BREAKGLASS_IP,
    });

    if (evaluation.allowed) {
      next();
      return;
    }

    res.status(403).json({
      error: `Access denied. IP address "${clientIp}" is not allowed in Settings > Security.`,
      clientIp,
    });
  } catch {
    res.status(503).json({
      error: 'Unable to verify IP allowlist policy. Please retry shortly or use break-glass recovery.',
    });
  }
}
