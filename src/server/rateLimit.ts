import type { NextFunction, Request, Response } from 'express';
import { verifyMagicBytes } from './middleware.ts';

interface RateBucketEntry {
  count: number;
  resetAt: number;
}

const stores = new Map<string, Map<string, RateBucketEntry>>();
const MAX_KEYS_PER_STORE = 10_000;

export function clearRateLimitStore(name?: string): void {
  if (name) {
    stores.get(name)?.clear();
    return;
  }
  for (const bucketMap of stores.values()) {
    bucketMap.clear();
  }
}

export function extractRequestIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === 'string'
      ? forwarded
      : req.socket?.remoteAddress || req.ip || '127.0.0.1';
  return String(raw).split(',')[0].trim() || '127.0.0.1';
}

export interface RateLimiterOptions {
  name: string;
  windowMs: number;
  maxRequests: number;
  message?: string;
  keyFn?: (req: Request) => string;
}

export function createRateLimiter(options: RateLimiterOptions) {
  let store = stores.get(options.name);
  if (!store) {
    store = new Map<string, RateBucketEntry>();
    stores.set(options.name, store);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const clientIp = extractRequestIp(req);
    const keySuffix = options.keyFn ? options.keyFn(req) : clientIp;
    const bucketKey = keySuffix || clientIp;

    if (store!.size >= MAX_KEYS_PER_STORE) {
      for (const [k, v] of store!.entries()) {
        if (v.resetAt <= now) {
          store!.delete(k);
        }
      }
      if (store!.size >= MAX_KEYS_PER_STORE) {
        const oldestKey = store!.keys().next().value;
        if (oldestKey !== undefined) {
          store!.delete(oldestKey);
        }
      }
    }

    const existing = store!.get(bucketKey);
    const active =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + options.windowMs };

    active.count += 1;
    store!.set(bucketKey, active);

    const remaining = Math.max(0, options.maxRequests - active.count);
    const resetSeconds = Math.max(1, Math.ceil((active.resetAt - now) / 1000));

    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetSeconds));

    if (active.count > options.maxRequests) {
      res.setHeader('Retry-After', String(resetSeconds));
      res.status(429).json({
        error:
          options.message ||
          `Too many requests. Please wait ${resetSeconds}s before trying again.`,
        retryAfterSeconds: resetSeconds,
      });
      return;
    }

    next();
  };
}

const DANGEROUS_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.svgz',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.php',
  '.phtml',
  '.asp',
  '.aspx',
  '.jsp',
  '.sh',
  '.bash',
  '.bat',
  '.cmd',
  '.ps1',
  '.exe',
  '.dll',
  '.vbs',
  '.jar',
  '.py',
  '.rb',
]);

const MIME_EXTENSION_ALLOWLIST: Record<string, Set<string>> = {
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/png': new Set(['.png']),
  'image/webp': new Set(['.webp']),
  'application/pdf': new Set(['.pdf']),
};

export interface UploadValidationInput {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  allowedMimeTypes?: string[];
  minBytes?: number;
  maxBytes?: number;
}

export function validateUploadDescriptor(
  input: UploadValidationInput
): { ok: true; sanitizedFileName: string } | { ok: false; error: string } {
  const rawName = String(input.fileName || '').trim();
  if (!rawName || rawName.length > 180) {
    return { ok: false, error: 'File name is required and must be at most 180 characters.' };
  }

  if (/[\x00-\x1f\x7f]/.test(rawName) || rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
    return { ok: false, error: 'File name contains invalid path characters.' };
  }

  const allowedMimes = input.allowedMimeTypes ?? [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
  ];
  if (!allowedMimes.includes(input.mimeType)) {
    return { ok: false, error: 'Unsupported file MIME type.' };
  }

  const lower = rawName.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx !== -1) {
    const ext = lower.slice(dotIdx);
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      return { ok: false, error: `Executable or active content extension "${ext}" is blocked.` };
    }
    const expectedExts = MIME_EXTENSION_ALLOWLIST[input.mimeType];
    if (expectedExts && !expectedExts.has(ext)) {
      return {
        ok: false,
        error: `File extension "${ext}" does not match declared MIME type "${input.mimeType}".`,
      };
    }
  }

  const minBytes = input.minBytes ?? 12;
  const maxBytes = input.maxBytes ?? 5 * 1024 * 1024;
  if (input.buffer.length < minBytes || input.buffer.length > maxBytes) {
    return {
      ok: false,
      error: `File size must be between ${minBytes} bytes and ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    };
  }

  if (!verifyMagicBytes(input.buffer, input.mimeType)) {
    return {
      ok: false,
      error: 'File content does not match declared MIME type or is corrupted.',
    };
  }

  return {
    ok: true,
    sanitizedFileName: rawName.replace(/[^a-zA-Z0-9._-]/g, '_'),
  };
}

export function sanitizeStorageRelativePath(rawPath: string): string | null {
  const cleaned = String(rawPath || '').trim();
  if (!cleaned || cleaned.length > 300) return null;
  if (
    cleaned.startsWith('/') ||
    cleaned.startsWith('\\') ||
    cleaned.includes('\\') ||
    cleaned.includes('..') ||
    /[\x00-\x1f\x7f]/.test(cleaned)
  ) {
    return null;
  }
  const segments = cleaned.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) {
    return null;
  }
  if (!/^[a-zA-Z0-9._\/-]+$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}
