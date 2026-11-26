import './src/server/config.ts';
import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupabaseAdmin, PORT } from './src/server/config.ts';
import { requireIpAllowlist } from './src/server/ipAllowlist.ts';
import {
  createCorsOptions,
  DEFAULT_JSON_LIMIT,
  isModuleEnabledServer,
} from './src/server/middleware.ts';
import { registerAllApiRoutes } from './src/server/registerRoutes.ts';
import { VITE_CLIENT_STUB } from './src/server/viteClientStub.ts';

const STATIC_ASSET_EXT_RE = /\.(?:js|mjs|css|map|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot|webmanifest|json|txt|xml|mp4|webm)$/i;

export function isStorefrontPageRequest(reqPath: string): boolean {
  const clean = (reqPath || '/').split('?')[0];
  const lower = clean.toLowerCase();
  if (
    lower.startsWith('/api') ||
    lower === '/erp' ||
    lower.startsWith('/erp/') ||
    lower.startsWith('/@vite') ||
    lower.startsWith('/@fs') ||
    lower.startsWith('/src/') ||
    lower.startsWith('/node_modules/')
  ) {
    return false;
  }
  if (clean !== '/' && STATIC_ASSET_EXT_RE.test(lower)) {
    return false;
  }
  return true;
}

function sendStorefrontDisabled404(res: Response): void {
  res
    .status(404)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — Not Found</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#faf9f6;color:#1c1917;display:grid;place-items:center;min-height:100vh;padding:24px}main{max-width:460px;text-align:center}code{font-size:12px;letter-spacing:.18em;color:#78716c}h1{margin:10px 0 8px;font-size:28px}p{margin:0;font-size:14px;line-height:1.6;color:#57534e}</style></head><body><main><code>404</code><h1>Storefront Not Found</h1><p>The public online store is currently turned off.</p></main></body></html>`
    );
}

async function gateDisabledStorefront(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  if (!isStorefrontPageRequest(req.path)) {
    next();
    return;
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    next();
    return;
  }
  try {
    const enabled = await isModuleEnabledServer('online_store');
    if (!enabled) {
      sendStorefrontDisabled404(res);
      return;
    }
  } catch {
    // Allow fallback on transient error
  }
  next();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

function registerApiRoutes() {
  app.use(
    helmet({
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
    next();
  });
  app.use(cors(createCorsOptions()));
  app.use(requireIpAllowlist);

  // Support /api/erp/* aliases while preserving IP allowlist enforcement & originalUrl
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (
      req.url.startsWith('/api/erp/') &&
      !req.url.startsWith('/api/erp/auth/') &&
      !req.url.startsWith('/api/erp/security/')
    ) {
      req.url = `/api/${req.url.slice('/api/erp/'.length)}`;
    }
    next();
  });

  const uploadJsonParser = express.json({ limit: '10mb' });
  const backupRestoreJsonParser = express.json({ limit: '30mb' });
  app.post(['/api/files/upload', '/api/erp/files/upload'], uploadJsonParser);
  app.post(['/api/ai/scan-purchase-bill', '/api/erp/ai/scan-purchase-bill'], uploadJsonParser);
  app.post(['/api/ai/suggest-item', '/api/erp/ai/suggest-item'], uploadJsonParser);
  app.post(['/api/backup/restore-bundle', '/api/erp/backup/restore-bundle'], backupRestoreJsonParser);

  app.use(express.json({ limit: DEFAULT_JSON_LIMIT }));

  registerAllApiRoutes(app);

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const errObj = err as { type?: string; status?: number; statusCode?: number };
    if (errObj?.type === 'entity.too.large' || errObj?.status === 413 || errObj?.statusCode === 413) {
      res.status(413).json({ error: 'Request payload exceeds the 2 MB size limit.' });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON request body.' });
      return;
    }
    res.status(500).json({ error: 'Internal server error.' });
  });
}

registerApiRoutes();

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(__dirname, 'dist');
    const erpDistDir = path.join(distDir, 'ERP');
    app.use(
      '/ERP',
      requireIpAllowlist,
      (_req: Request, res: Response, next: NextFunction) => {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        next();
      },
      express.static(erpDistDir)
    );
    app.use(gateDisabledStorefront);
    app.use(express.static(distDir, { index: false }));

    app.get(['/ERP', '/ERP/*'], requireIpAllowlist, (_req: Request, res: Response) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(erpDistDir, 'erp.html'));
    });

    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    app.get('/@vite/client', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(VITE_CLIENT_STUB);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: 'mpa',
    });

    app.get(['/ERP', '/ERP/*'], requireIpAllowlist, async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        const rawHtml = await fs.promises.readFile(path.join(__dirname, 'erp.html'), 'utf8');
        const html = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
      } catch (err) {
        next(err);
      }
    });

    app.use(gateDisabledStorefront);
    app.use(vite.middlewares);

    app.get('*', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawHtml = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
        const html = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DecorBiz server listening on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL && process.env.DECORBIZ_NO_LISTEN !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start DecorBiz server:', err);
    process.exit(1);
  });
}

export default app;
