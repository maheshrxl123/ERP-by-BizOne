import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { getSupabaseAdmin, STORAGE_BUCKET } from '../config.ts';
import { isValidEncryptionKey } from '../crypto.ts';
import { GSTIN_REGEX, writeAudit } from '../middleware.ts';
import { createRateLimiter } from '../rateLimit.ts';

const setupRateLimiter = createRateLimiter({
  name: 'setup-initialize',
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many workspace setup attempts. Please wait 15 minutes.',
});

const setupSchema = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    ownerName: z.string().trim().min(2).max(100),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
    pack: z.literal('decorbiz').default('decorbiz'),
    gstRegistered: z.boolean(),
    gstin: z.string().trim().max(15).optional().nullable(),
    fyStartMonth: z.number().int().min(1).max(12).default(4),
  })
  .superRefine((val, ctx) => {
    const clean = val.gstin?.trim().toUpperCase() || '';
    if (val.gstRegistered && clean && !GSTIN_REGEX.test(clean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gstin'],
        message: 'GSTIN must be a valid 15-character format.',
      });
    }
  });

export function registerSetupRoutes(app: Express): void {
  app.get('/api/health', async (_req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.json({
        ok: false,
        supabaseConfigured: false,
        encryptionConfigured: isValidEncryptionKey(),
      });
      return;
    }

    try {
      const { error } = await admin
        .from('modules_state')
        .select('module_key')
        .limit(1);
      res.json({
        ok: !error,
        supabaseConfigured: true,
        encryptionConfigured: isValidEncryptionKey(),
      });
    } catch {
      res.status(500).json({ ok: false, supabaseConfigured: true });
    }
  });

  app.get('/api/setup/status', async (_req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.json({
        configured: false,
        needsSetup: false,
        businessName: null,
      });
      return;
    }

    try {
      const [{ data: biz }, { data: owners }] = await Promise.all([
        admin.from('business').select('id, name, pack').maybeSingle(),
        admin
          .from('profiles')
          .select('id')
          .eq('role', 'owner')
          .eq('is_active', true)
          .limit(1),
      ]);

      res.json({
        configured: true,
        needsSetup: !biz || !owners || owners.length === 0,
        businessName: biz?.name ?? null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to check setup status.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/setup/initialize', setupRateLimiter, async (req: Request, res: Response) => {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) {
      res.status(503).json({
        error: 'Supabase environment variables are not configured on the server.',
      });
      return;
    }

    try {
      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error:
            parsed.error.issues[0]?.message || 'Invalid setup fields provided.',
        });
        return;
      }

      const { data: existingBiz } = await supabaseAdmin
        .from('business')
        .select('id')
        .maybeSingle();
      const { data: existingOwners } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('role', 'owner')
        .limit(1);

      if (existingBiz && existingOwners && existingOwners.length > 0) {
        res.status(409).json({
          error: 'DecorBiz workspace is already initialized. Please sign in.',
        });
        return;
      }

      const input = parsed.data;
      const { data: createdAuth, error: authErr } =
        await supabaseAdmin.auth.admin.createUser({
          email: input.email,
          password: input.password,
          email_confirm: true,
          user_metadata: { full_name: input.ownerName },
        });

      if (authErr || !createdAuth.user) {
        res.status(400).json({
          error: authErr?.message || 'Unable to create Owner auth user.',
        });
        return;
      }

      const ownerId = createdAuth.user.id;

      const { error: profErr } = await supabaseAdmin.from('profiles').insert({
        id: ownerId,
        full_name: input.ownerName,
        email: input.email,
        role: 'owner',
        is_active: true,
      });

      if (profErr) {
        await supabaseAdmin.auth.admin.deleteUser(ownerId);
        res.status(500).json({ error: profErr.message });
        return;
      }

      const { error: bizErr } = await supabaseAdmin.from('business').upsert({
        id: 1,
        name: input.businessName,
        pack: input.pack,
        gst_registered: input.gstRegistered,
        gstin: input.gstRegistered && input.gstin ? input.gstin.toUpperCase() : null,
        fy_start_month: input.fyStartMonth,
        onboarding_steps: {
          logo: false,
          address: false,
          gst: input.gstRegistered,
          profile: true,
          modules: false,
        },
      });

      if (bizErr) {
        await supabaseAdmin.auth.admin.deleteUser(ownerId).catch(() => undefined);
        res.status(500).json({ error: bizErr.message });
        return;
      }

      const { error: bucketErr } = await supabaseAdmin.storage.createBucket(STORAGE_BUCKET, {
        public: false,
        fileSizeLimit: 10 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      });
      if (bucketErr && !/already\s*exists|duplicate/i.test(bucketErr.message)) {
        throw new Error(`Storage bucket initialization failed: ${bucketErr.message}`);
      }

      await writeAudit(ownerId, input.email, 'workspace.initialized', 'business', '1', {
        pack: input.pack,
        business_name: input.businessName,
      });

      res.status(201).json({ ok: true, ownerId });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Workspace initialization failed.';
      res.status(500).json({ error: message });
    }
  });
}
