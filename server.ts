import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config();
const envFilePath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFilePath)) {
  const parsedEnv = dotenv.parse(fs.readFileSync(envFilePath, 'utf8'));
  for (const [key, val] of Object.entries(parsedEnv)) {
    const existing = process.env[key]?.trim() ?? '';
    if (existing.length < 2 && val) {
      process.env[key] = val;
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL?.trim() || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
const ENCRYPTION_KEY_HEX = process.env.APP_ENCRYPTION_KEY?.trim() || '';
const STORAGE_BUCKET = 'bizone-private';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.warn(
    '[server] Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.'
  );
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

interface AuthenticatedRequest extends Request {
  staffUser?: {
    id: string;
    email: string;
    role: string;
    is_active: boolean;
  };
}

async function requireActiveStaff(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(
    token
  );
  if (userErr || !userData.user) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return;
  }

  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('id, email, role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profErr || !profile || !profile.is_active) {
    res.status(403).json({ error: 'Active staff account required.' });
    return;
  }

  req.staffUser = profile;
  next();
}

function requireOwner(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.staffUser || req.staffUser.role !== 'owner') {
    res.status(403).json({ error: 'Owner permission required.' });
    return;
  }
  next();
}

function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
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

const UUID_SCHEMA = z.string().uuid('Invalid identifier format.');
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function isValidEncryptionKey(): boolean {
  return /^[0-9a-fA-F]{64,}$/.test(ENCRYPTION_KEY_HEX);
}

function encryptSecret(plaintext: string): string {
  if (!isValidEncryptionKey()) {
    throw new Error(
      'APP_ENCRYPTION_KEY (at least 64 hex chars) must be configured before storing integration secrets.'
    );
  }
  const key = Buffer.from(ENCRYPTION_KEY_HEX.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

async function writeAudit(
  actorId: string | null,
  actorEmail: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {}
) {
  await supabaseAdmin.from('audit_logs').insert({
    actor_id: actorId,
    actor_email: actorEmail,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details,
  });
}

const setupSchema = z
  .object({
    businessName: z.string().trim().min(2).max(120),
    ownerName: z.string().trim().min(2).max(100),
    email: z.string().trim().email(),
    password: z.string().min(8).max(128),
    pack: z.enum([
      'kirana',
      'medical',
      'clothing',
      'hardware',
      'general_retail',
      'wholesale',
      'service',
    ]),
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

const createStaffSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email(),
  phone: z.string().trim().max(24).optional().nullable(),
  password: z.string().min(8).max(128),
  role: z.enum(['manager', 'cashier', 'storekeeper', 'accountant', 'viewer']),
});

const updateStaffSchema = z
  .object({
    role: z
      .enum(['owner', 'manager', 'cashier', 'storekeeper', 'accountant', 'viewer'])
      .optional(),
    is_active: z.boolean().optional(),
  })
  .refine((val) => val.role !== undefined || val.is_active !== undefined, {
    message: 'No valid fields to update.',
  });

const uploadFileSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  base64: z.string().min(4),
  purpose: z.enum([
    'avatar',
    'business_logo',
    'upi_qr',
    'item_image',
    'attachment',
  ]),
  entityType: z.string().trim().max(64).optional(),
  entityId: z.string().trim().max(128).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isPrimary: z.boolean().optional(),
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      const { error } = await supabaseAdmin
        .from('modules_state')
        .select('module_key')
        .limit(1);
      res.json({
        ok: !error,
        supabaseConfigured: Boolean(SUPABASE_URL && SERVICE_ROLE_KEY),
        encryptionConfigured: isValidEncryptionKey(),
      });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  app.get('/api/setup/status', async (_req: Request, res: Response) => {
    try {
      const [{ data: biz }, { data: owners }] = await Promise.all([
        supabaseAdmin.from('business').select('id, name, pack').maybeSingle(),
        supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('role', 'owner')
          .eq('is_active', true)
          .limit(1),
      ]);

      res.json({
        needsSetup: !biz || !owners || owners.length === 0,
        businessName: biz?.name ?? null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to check setup status.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/setup/initialize', async (req: Request, res: Response) => {
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
          error: 'BizOne workspace is already initialized. Please sign in.',
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

      // Enable pack-required modules automatically
      if (input.pack === 'medical') {
        await supabaseAdmin
          .from('modules_state')
          .upsert({ module_key: 'batch_expiry', enabled: true, updated_by: ownerId });
      } else if (input.pack === 'clothing') {
        await supabaseAdmin
          .from('modules_state')
          .upsert({ module_key: 'variants', enabled: true, updated_by: ownerId });
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

  // Owner-only: create staff user
  app.post(
    '/api/admin/users',
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createStaffSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error:
              parsed.error.issues[0]?.message || 'Invalid staff details provided.',
          });
          return;
        }
        const input = parsed.data;

        const { data: createdAuth, error: authErr } =
          await supabaseAdmin.auth.admin.createUser({
            email: input.email,
            password: input.password,
            email_confirm: true,
            user_metadata: { full_name: input.fullName },
          });

        if (authErr || !createdAuth.user) {
          res.status(400).json({
            error: authErr?.message || 'Unable to create staff account.',
          });
          return;
        }

        const { data: profile, error: profErr } = await supabaseAdmin
          .from('profiles')
          .insert({
            id: createdAuth.user.id,
            full_name: input.fullName,
            phone: input.phone || null,
            email: input.email,
            role: input.role,
            is_active: true,
          })
          .select('*')
          .single();

        if (profErr) {
          await supabaseAdmin.auth.admin.deleteUser(createdAuth.user.id);
          res.status(500).json({ error: profErr.message });
          return;
        }

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'staff.created',
          'profile',
          createdAuth.user.id,
          { email: input.email, role: input.role }
        );

        res.status(201).json({ profile });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to add staff member.';
        res.status(500).json({ error: message });
      }
    }
  );

  // Owner-only: update staff role or activation
  app.patch(
    '/api/admin/users/:id',
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const targetIdParsed = UUID_SCHEMA.safeParse(req.params.id);
        if (!targetIdParsed.success) {
          res.status(400).json({ error: 'Invalid user ID format.' });
          return;
        }
        const targetId = targetIdParsed.data;

        const parsedPatch = updateStaffSchema.safeParse(req.body ?? {});
        if (!parsedPatch.success) {
          res.status(400).json({
            error:
              parsedPatch.error.issues[0]?.message || 'No valid fields to update.',
          });
          return;
        }
        const updatePatch = parsedPatch.data;

        const { data: existingProfile } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('id', targetId)
          .maybeSingle();

        if (!existingProfile) {
          res.status(404).json({ error: 'Staff member not found.' });
          return;
        }

        const { data: updated, error } = await supabaseAdmin
          .from('profiles')
          .update(updatePatch)
          .eq('id', targetId)
          .select('*')
          .single();

        if (error) {
          res.status(400).json({ error: error.message });
          return;
        }

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'staff.updated',
          'profile',
          targetId,
          updatePatch
        );

        res.json({ profile: updated });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update staff user.';
        res.status(500).json({ error: message });
      }
    }
  );

  async function isModuleEnabledServer(moduleKey: string): Promise<boolean> {
    const { data } = await supabaseAdmin
      .from('modules_state')
      .select('enabled')
      .eq('module_key', moduleKey)
      .maybeSingle();
    return Boolean(data?.enabled);
  }

  // Universal validated upload to private Supabase Storage
  app.post(
    '/api/files/upload',
    requireActiveStaff,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = uploadFileSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error:
              parsed.error.issues[0]?.message || 'Invalid upload payload.',
          });
          return;
        }

        const input = parsed.data;
        const cleanBase64 = input.base64.includes(',')
          ? input.base64.split(',')[1]
          : input.base64;
        const buffer = Buffer.from(cleanBase64, 'base64');

        if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
          res.status(400).json({
            error: 'File must be non-empty and at most 5 MB.',
          });
          return;
        }

        if (!verifyMagicBytes(buffer, input.mimeType)) {
          res.status(400).json({
            error:
              'File content does not match declared MIME type or is unsupported.',
          });
          return;
        }

        const role = req.staffUser!.role;
        const isBusinessAsset =
          input.entityType === 'business' ||
          input.purpose === 'business_logo' ||
          input.purpose === 'upi_qr';

        if (isBusinessAsset && role !== 'owner') {
          res
            .status(403)
            .json({ error: 'Only an Owner can upload business assets.' });
          return;
        }

        const isItemAsset =
          input.entityType === 'item' || input.purpose === 'item_image';
        if (isItemAsset) {
          if (input.mimeType === 'application/pdf') {
            res.status(400).json({
              error: 'Item gallery supports JPEG, PNG, and WebP images only.',
            });
            return;
          }
          const invEnabled = await isModuleEnabledServer('inventory');
          if (!invEnabled) {
            res.status(403).json({ error: 'Items & Stock module is disabled.' });
            return;
          }
          if (!['owner', 'manager', 'storekeeper'].includes(role)) {
            res.status(403).json({
              error: 'Only Owner, Manager, or Storekeeper can upload item images.',
            });
            return;
          }
          if (input.entityType === 'item' && input.entityId) {
            const parsedItemId = UUID_SCHEMA.safeParse(input.entityId);
            if (!parsedItemId.success) {
              res.status(400).json({ error: 'Invalid item identifier.' });
              return;
            }
            const { data: itemExists } = await supabaseAdmin
              .from('items')
              .select('id')
              .eq('id', parsedItemId.data)
              .maybeSingle();
            if (!itemExists) {
              res.status(404).json({ error: 'Linked item not found.' });
              return;
            }
          }
        }

        const extMap: Record<string, string> = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'application/pdf': 'pdf',
        };
        const ext = extMap[input.mimeType] || 'bin';
        const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `${input.purpose}/${req.staffUser!.id}/${Date.now()}_${crypto
          .randomBytes(6)
          .toString('hex')}.${ext}`;
        const checksum = crypto
          .createHash('sha256')
          .update(buffer)
          .digest('hex');

        const { error: uploadErr } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, buffer, {
            contentType: input.mimeType,
            upsert: false,
          });

        if (uploadErr) {
          res.status(500).json({ error: uploadErr.message });
          return;
        }

        const { data: fileRow, error: dbErr } = await supabaseAdmin
          .from('files')
          .insert({
            bucket: STORAGE_BUCKET,
            storage_path: storagePath,
            file_name: safeName,
            mime_type: input.mimeType,
            size_bytes: buffer.length,
            checksum,
            purpose: input.purpose,
            uploaded_by: req.staffUser!.id,
          })
          .select('*')
          .single();

        if (dbErr || !fileRow) {
          await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]);
          res.status(500).json({ error: dbErr?.message || 'Metadata write failed.' });
          return;
        }

        if (input.entityType && input.entityId) {
          const { error: linkErr } = await supabaseAdmin.from('file_links').insert({
            file_id: fileRow.id,
            entity_type: input.entityType,
            entity_id: input.entityId,
            sort_order: input.sortOrder ?? 0,
            is_primary: input.isPrimary ?? false,
          });
          if (linkErr) {
            await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]);
            await supabaseAdmin.from('files').delete().eq('id', fileRow.id);
            res.status(400).json({ error: linkErr.message });
            return;
          }

          if (input.entityType === 'item') {
            const { data: existingImgs } = await supabaseAdmin
              .from('item_images')
              .select('id, is_primary')
              .eq('item_id', input.entityId);
            const hasPrimary = (existingImgs ?? []).some((x) => x.is_primary);
            const shouldPrimary = !hasPrimary && (input.isPrimary ?? (existingImgs?.length ?? 0) === 0);

            const { error: itemImgErr } = await supabaseAdmin
              .from('item_images')
              .insert({
                item_id: input.entityId,
                file_id: fileRow.id,
                sort_order: input.sortOrder ?? (existingImgs?.length ?? 0),
                is_primary: shouldPrimary,
              });
            if (itemImgErr) {
              await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]);
              await supabaseAdmin.from('files').delete().eq('id', fileRow.id);
              res.status(400).json({ error: itemImgErr.message });
              return;
            }
            if (shouldPrimary) {
              await supabaseAdmin
                .from('items')
                .update({ primary_image_file_id: fileRow.id })
                .eq('id', input.entityId);
            }
          }
        }

        const { data: signed } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .createSignedUrl(storagePath, 600);

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'file.uploaded',
          'file',
          fileRow.id,
          {
            purpose: input.purpose,
            size_bytes: buffer.length,
            entity_type: input.entityType ?? null,
            entity_id: input.entityId ?? null,
          }
        );

        res.status(201).json({
          file: {
            ...fileRow,
            signedUrl: signed?.signedUrl ?? null,
          },
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'File upload failed.';
        res.status(500).json({ error: message });
      }
    }
  );

  // Short-lived signed URL for private storage assets with linked-record authorization
  app.post(
    '/api/files/signed-url',
    requireActiveStaff,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsedId = UUID_SCHEMA.safeParse(req.body?.fileId);
        if (!parsedId.success) {
          res.status(400).json({ error: 'Valid fileId UUID is required.' });
          return;
        }
        const fileId = parsedId.data;

        const { data: fileRow, error } = await supabaseAdmin
          .from('files')
          .select('id, bucket, storage_path, file_name, mime_type, purpose, uploaded_by')
          .eq('id', fileId)
          .maybeSingle();

        if (error || !fileRow) {
          res.status(404).json({ error: 'File not found.' });
          return;
        }

        const [{ data: fileLinks }, { data: itemImgs }] = await Promise.all([
          supabaseAdmin
            .from('file_links')
            .select('entity_type, entity_id')
            .eq('file_id', fileId),
          supabaseAdmin
            .from('item_images')
            .select('item_id')
            .eq('file_id', fileId),
        ]);

        const role = req.staffUser!.role;
        const linkedToItem =
          fileRow.purpose === 'item_image' ||
          (itemImgs && itemImgs.length > 0) ||
          (fileLinks ?? []).some((l) => l.entity_type === 'item');

        if (linkedToItem) {
          const invEnabled = await isModuleEnabledServer('inventory');
          if (
            !invEnabled ||
            !['owner', 'manager', 'storekeeper', 'cashier', 'accountant'].includes(role)
          ) {
            res.status(403).json({
              error: 'You do not have permission to access this item image.',
            });
            return;
          }
        }

        const { data: signed, error: signErr } = await supabaseAdmin.storage
          .from(fileRow.bucket)
          .createSignedUrl(fileRow.storage_path, 600);

        if (signErr || !signed) {
          res.status(500).json({ error: signErr?.message || 'Unable to sign URL.' });
          return;
        }

        res.json({ signedUrl: signed.signedUrl, file: fileRow });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Signed URL generation failed.';
        res.status(500).json({ error: message });
      }
    }
  );

  // Clean up orphaned unlinked temporary uploads (e.g., cancelled item form uploads)
  app.post(
    '/api/files/cleanup-orphans',
    requireActiveStaff,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const role = req.staffUser!.role;
        const invEnabled = await isModuleEnabledServer('inventory');
        if (!invEnabled || !['owner', 'manager', 'storekeeper'].includes(role)) {
          res.status(403).json({
            error: 'Only Owner, Manager, or Storekeeper can clean up orphan files.',
          });
          return;
        }

        const rawIds: unknown = req.body?.fileIds;
        let candidateIds: string[] = [];

        if (Array.isArray(rawIds) && rawIds.length > 0) {
          for (const id of rawIds.slice(0, 25)) {
            const p = UUID_SCHEMA.safeParse(id);
            if (p.success) candidateIds.push(p.data);
          }
        } else {
          const cutoffIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const { data: oldDrafts } = await supabaseAdmin
            .from('files')
            .select('id')
            .eq('purpose', 'item_image')
            .eq('uploaded_by', req.staffUser!.id)
            .lt('created_at', cutoffIso)
            .limit(50);
          candidateIds = (oldDrafts ?? []).map((r) => r.id);
        }

        const deletedFileIds: string[] = [];
        for (const fid of candidateIds) {
          const [
            { data: fileRow },
            { data: imgLinks },
            { data: links },
            { data: primaryRef },
          ] = await Promise.all([
            supabaseAdmin
              .from('files')
              .select('id, bucket, storage_path, purpose, uploaded_by')
              .eq('id', fid)
              .maybeSingle(),
            supabaseAdmin
              .from('item_images')
              .select('id')
              .eq('file_id', fid)
              .limit(1),
            supabaseAdmin
              .from('file_links')
              .select('id')
              .eq('file_id', fid)
              .limit(1),
            supabaseAdmin
              .from('items')
              .select('id')
              .eq('primary_image_file_id', fid)
              .limit(1),
          ]);

          if (!fileRow || fileRow.purpose !== 'item_image') continue;
          if (role !== 'owner' && fileRow.uploaded_by !== req.staffUser!.id) continue;
          if ((imgLinks?.length ?? 0) > 0 || (links?.length ?? 0) > 0 || (primaryRef?.length ?? 0) > 0) {
            continue;
          }

          await supabaseAdmin.storage
            .from(fileRow.bucket)
            .remove([fileRow.storage_path]);
          await supabaseAdmin.from('files').delete().eq('id', fid);
          deletedFileIds.push(fid);
        }

        if (deletedFileIds.length > 0) {
          await writeAudit(
            req.staffUser!.id,
            req.staffUser!.email,
            'file.orphans_cleaned',
            'file',
            null,
            { count: deletedFileIds.length, file_ids: deletedFileIds }
          );
        }

        res.json({ deletedFileIds });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Orphan file cleanup failed.';
        res.status(500).json({ error: message });
      }
    }
  );

  // Delete file & storage object cleanly with linked-record authorization
  app.delete(
    '/api/files/:id',
    requireActiveStaff,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsedId = UUID_SCHEMA.safeParse(req.params.id);
        if (!parsedId.success) {
          res.status(400).json({ error: 'Valid file ID UUID is required.' });
          return;
        }
        const fileId = parsedId.data;
        const { data: fileRow, error: fetchErr } = await supabaseAdmin
          .from('files')
          .select('*')
          .eq('id', fileId)
          .maybeSingle();

        if (fetchErr || !fileRow) {
          res.status(404).json({ error: 'File not found.' });
          return;
        }

        const [{ data: links }, { data: itemImgs }] = await Promise.all([
          supabaseAdmin
            .from('file_links')
            .select('entity_type, entity_id')
            .eq('file_id', fileId),
          supabaseAdmin
            .from('item_images')
            .select('item_id')
            .eq('file_id', fileId),
        ]);

        const role = req.staffUser!.role;
        const isBusinessLinked =
          ['business_logo', 'upi_qr'].includes(fileRow.purpose) ||
          (links ?? []).some((l) => l.entity_type === 'business');
        const isItemLinked =
          fileRow.purpose === 'item_image' ||
          (itemImgs && itemImgs.length > 0) ||
          (links ?? []).some((l) => l.entity_type === 'item');

        if (isBusinessLinked) {
          if (role !== 'owner') {
            res.status(403).json({ error: 'Only an Owner can delete business assets.' });
            return;
          }
        } else if (isItemLinked) {
          const invEnabled = await isModuleEnabledServer('inventory');
          if (!invEnabled || !['owner', 'manager', 'storekeeper'].includes(role)) {
            res.status(403).json({
              error: 'Only Owner, Manager, or Storekeeper can delete item images.',
            });
            return;
          }
        } else if (role !== 'owner' && fileRow.uploaded_by !== req.staffUser!.id) {
          res.status(403).json({ error: 'You cannot delete this file.' });
          return;
        }

        const { error: storageErr } = await supabaseAdmin.storage
          .from(fileRow.bucket)
          .remove([fileRow.storage_path]);
        if (storageErr) {
          res.status(500).json({ error: storageErr.message });
          return;
        }

        // Deleting files row cascades item_images (promoting next primary via trigger) & file_links
        const { error: delDbErr } = await supabaseAdmin
          .from('files')
          .delete()
          .eq('id', fileId);
        if (delDbErr) {
          res.status(500).json({ error: delDbErr.message });
          return;
        }

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'file.deleted',
          'file',
          fileId,
          { purpose: fileRow.purpose }
        );

        res.json({ ok: true });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to delete file.';
        res.status(500).json({ error: message });
      }
    }
  );

  // Owner-only encrypted integration settings (never returns plaintext secrets)
  app.get(
    '/api/integrations',
    requireActiveStaff,
    requireOwner,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const { data, error } = await supabaseAdmin
          .from('integration_settings')
          .select(
            'integration_key, enabled, display_name, config_public, has_secret, last_checked_at, status, updated_at'
          )
          .order('integration_key');

        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }
        res.json({ integrations: data ?? [] });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load integrations.';
        res.status(500).json({ error: message });
      }
    }
  );

  app.post(
    '/api/integrations/:key',
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const key = String(req.params.key);
        const { enabled, configPublic, secret } = req.body ?? {};

        const { data: existingInt } = await supabaseAdmin
          .from('integration_settings')
          .select('integration_key, has_secret')
          .eq('integration_key', key)
          .maybeSingle();

        if (!existingInt) {
          res.status(404).json({ error: 'Integration slot not found.' });
          return;
        }

        const hasNewSecret = typeof secret === 'string' && secret.trim().length > 0;
        const effectiveHasSecret = existingInt.has_secret || hasNewSecret;

        if ((hasNewSecret || Boolean(enabled)) && !isValidEncryptionKey()) {
          res.status(400).json({
            error:
              'APP_ENCRYPTION_KEY (64+ hex chars) must be configured before enabling or saving integration secrets.',
          });
          return;
        }

        const patch: Record<string, unknown> = {
          enabled: Boolean(enabled),
          config_public:
            typeof configPublic === 'object' &&
            configPublic !== null &&
            !Array.isArray(configPublic)
              ? configPublic
              : {},
          last_checked_at: new Date().toISOString(),
        };

        if (hasNewSecret) {
          patch.encrypted_secret = encryptSecret(secret.trim());
          patch.has_secret = true;
        }

        patch.status = Boolean(enabled)
          ? effectiveHasSecret
            ? 'configured'
            : 'not_configured'
          : 'disabled';

        const { data, error } = await supabaseAdmin
          .from('integration_settings')
          .update(patch)
          .eq('integration_key', key)
          .select(
            'integration_key, enabled, display_name, config_public, has_secret, last_checked_at, status, updated_at'
          )
          .single();

        if (error) {
          res.status(400).json({ error: error.message });
          return;
        }

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'integration.updated',
          'integration',
          key,
          { enabled: Boolean(enabled), secretUpdated: hasNewSecret }
        );

        res.json({ integration: data });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to save integration.';
        res.status(500).json({ error: message });
      }
    }
  );

  app.delete(
    '/api/integrations/:key',
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const key = String(req.params.key);
        const { data: existingInt } = await supabaseAdmin
          .from('integration_settings')
          .select('integration_key')
          .eq('integration_key', key)
          .maybeSingle();

        if (!existingInt) {
          res.status(404).json({ error: 'Integration slot not found.' });
          return;
        }

        const { data, error } = await supabaseAdmin
          .from('integration_settings')
          .update({
            enabled: false,
            encrypted_secret: null,
            has_secret: false,
            status: 'not_configured',
          })
          .eq('integration_key', key)
          .select(
            'integration_key, enabled, display_name, config_public, has_secret, last_checked_at, status, updated_at'
          )
          .single();

        if (error) {
          res.status(400).json({ error: error.message });
          return;
        }

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'integration.removed',
          'integration',
          key,
          {}
        );

        res.json({ integration: data });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to clear integration.';
        res.status(500).json({ error: message });
      }
    }
  );

  // Public minimal view-only shared bill endpoint (no staff session required; rate limited per IP)
  const shareRateBuckets = new Map<string, number[]>();
  app.get('/api/share/bill/:token', async (req: Request, res: Response) => {
    try {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      const clientIp = forwarded || req.ip || 'unknown';
      const nowMs = Date.now();
      const windowMs = 60_000;
      const limit = Number(process.env.SHARE_RATE_LIMIT_MAX || 60);
      const timestamps = (shareRateBuckets.get(clientIp) || []).filter(
        (ts) => nowMs - ts < windowMs
      );
      if (timestamps.length >= limit) {
        res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
        return;
      }
      timestamps.push(nowMs);
      shareRateBuckets.set(clientIp, timestamps);
      if (shareRateBuckets.size > 2000) {
        for (const [ip, list] of shareRateBuckets.entries()) {
          if (list.every((ts) => nowMs - ts >= windowMs)) {
            shareRateBuckets.delete(ip);
          }
        }
      }

      const token = String(req.params.token || '').trim();
      if (!/^[a-zA-Z0-9_-]{24,128}$/.test(token)) {
        res.status(400).json({ error: 'Invalid share token format.' });
        return;
      }

      const { data: link, error: linkErr } = await supabaseAdmin
        .from('bill_share_links')
        .select('id, bill_id, expires_at, is_revoked, view_count')
        .eq('token', token)
        .maybeSingle();

      if (linkErr || !link) {
        res.status(404).json({ error: 'Shared invoice link not found.' });
        return;
      }

      if (link.is_revoked) {
        res.status(410).json({ error: 'This invoice share link has been revoked.' });
        return;
      }

      if (link.expires_at && new Date(link.expires_at).getTime() <= nowMs) {
        res.status(410).json({ error: 'This invoice share link has expired.' });
        return;
      }

      const [{ data: bill, error: billErr }, { data: lines }, { data: liveBiz }] =
        await Promise.all([
          supabaseAdmin
            .from('bills')
            .select(
              'id, bill_number, doc_type, status, payment_status, source_bill_id, party_name, party_phone, party_gstin, party_address, place_of_supply_state_code, is_interstate, bill_date, due_date, valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total, tax_total, extra_charges, round_off, grand_total, paid_amount, credited_amount, balance_due, void_reason, notes, terms, business_snapshot, issued_at'
            )
            .eq('id', link.bill_id)
            .maybeSingle(),
          supabaseAdmin
            .from('bill_lines')
            .select(
              'id, line_no, item_name, sku, hsn_code, entered_qty, entered_unit_code, unit_price, discount_pct, tax_inclusive, gst_rate, gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, tax_amount, line_total'
            )
            .eq('bill_id', link.bill_id)
            .order('line_no', { ascending: true }),
          supabaseAdmin
            .from('business')
            .select('logo_file_id, upi_qr_file_id, upi_id, show_upi_qr_on_invoice, default_print_layout')
            .eq('id', 1)
            .maybeSingle(),
        ]);

      if (billErr || !bill || bill.status === 'draft') {
        res.status(404).json({ error: 'Invoice document is unavailable.' });
        return;
      }

      const snap = (bill.business_snapshot || {}) as Record<string, unknown>;
      const logoFileId =
        (typeof snap.logo_file_id === 'string' && snap.logo_file_id) ||
        liveBiz?.logo_file_id ||
        null;
      const rawShowQr =
        typeof snap.show_upi_qr_on_invoice === 'boolean'
          ? snap.show_upi_qr_on_invoice
          : liveBiz?.show_upi_qr_on_invoice ?? true;
      const showQr =
        rawShowQr &&
        bill.doc_type !== 'credit_note' &&
        bill.status !== 'voided';
      const qrFileId = showQr
        ? (typeof snap.upi_qr_file_id === 'string' && snap.upi_qr_file_id) ||
          liveBiz?.upi_qr_file_id ||
          null
        : null;

      let logoUrl: string | null = null;
      let upiQrUrl: string | null = null;

      const fileIdsToSign = [logoFileId, qrFileId].filter(
        (id): id is string => Boolean(id)
      );
      if (fileIdsToSign.length > 0) {
        const { data: fileRows } = await supabaseAdmin
          .from('files')
          .select('id, bucket, storage_path')
          .in('id', fileIdsToSign);
        for (const f of fileRows || []) {
          const { data: signed } = await supabaseAdmin.storage
            .from(f.bucket)
            .createSignedUrl(f.storage_path, 600);
          if (f.id === logoFileId) logoUrl = signed?.signedUrl ?? null;
          if (f.id === qrFileId) upiQrUrl = signed?.signedUrl ?? null;
        }
      }

      await supabaseAdmin
        .from('bill_share_links')
        .update({
          view_count: Number(link.view_count || 0) + 1,
          last_viewed_at: new Date().toISOString(),
        })
        .eq('id', link.id);

      res.json({
        bill,
        lines: lines ?? [],
        assets: {
          logoUrl,
          upiQrUrl,
          showUpiQr: showQr,
          defaultPrintLayout:
            (typeof snap.default_print_layout === 'string' &&
              snap.default_print_layout) ||
            liveBiz?.default_print_layout ||
            'a4',
          upiId: showQr
            ? (typeof snap.upi_id === 'string' && snap.upi_id) ||
              liveBiz?.upi_id ||
              null
            : null,
        },
        expiresAt: link.expires_at,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to load shared invoice.';
      res.status(500).json({ error: message });
    }
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON request body.' });
      return;
    }
    res.status(500).json({ error: 'Internal server error.' });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BizOne ERP server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start BizOne server:', err);
  process.exit(1);
});
