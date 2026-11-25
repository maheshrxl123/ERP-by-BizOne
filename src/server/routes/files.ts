import type { Express, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { STORAGE_BUCKET } from '../config.ts';
import {
  isModuleEnabledServer,
  requireActiveStaff,
  UUID_SCHEMA,
  writeAudit,
  type AuthenticatedRequest,
} from '../middleware.ts';
import { validateUploadDescriptor } from '../rateLimit.ts';

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
    'store_banner',
  ]),
  entityType: z
    .enum([
      'profile',
      'business',
      'item',
      'attachment',
      'purchase_bill',
      'expense',
      'bill',
      'party',
      'store_banner',
    ])
    .optional(),
  entityId: z.string().trim().max(128).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isPrimary: z.boolean().optional(),
});

export function registerFileRoutes(app: Express): void {
  // Universal validated upload to private Supabase Storage
  app.post(
    '/api/files/upload',
    requireActiveStaff,
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
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

        const validation = validateUploadDescriptor({
          fileName: input.fileName,
          mimeType: input.mimeType,
          buffer,
          maxBytes: 5 * 1024 * 1024,
        });
        if (!validation.ok) {
          res.status(400).json({ error: validation.error });
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

        if (input.entityType === 'business' && input.entityId && input.entityId !== '1') {
          res.status(400).json({ error: 'Invalid business asset identifier.' });
          return;
        }

        if (input.purpose === 'avatar' && input.entityType && input.entityType !== 'profile') {
          res.status(400).json({ error: 'Avatar uploads may only link to a user profile.' });
          return;
        }

        if (input.entityType === 'profile') {
          if (input.entityId) {
            const parsedProfId = UUID_SCHEMA.safeParse(input.entityId);
            if (!parsedProfId.success) {
              res.status(400).json({ error: 'Invalid profile identifier.' });
              return;
            }
            if (parsedProfId.data !== req.staffUser!.id && role !== 'owner') {
              res.status(403).json({ error: 'You can only upload files for your own profile.' });
              return;
            }
          }
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

        if (input.purpose === 'store_banner' || input.entityType === 'store_banner') {
          if (input.mimeType === 'application/pdf') {
            res.status(400).json({ error: 'Storefront banners support JPEG, PNG, and WebP images only.' });
            return;
          }
          const storeEnabled = await isModuleEnabledServer('online_store');
          if (!storeEnabled) {
            res.status(403).json({ error: 'Online Store module is disabled.' });
            return;
          }
          if (!['owner', 'manager', 'storekeeper'].includes(role)) {
            res.status(403).json({ error: 'Only Owner, Manager, or Storekeeper can upload store banners.' });
            return;
          }
        }

        const extMap: Record<string, string> = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'application/pdf': 'pdf',
        };
        const ext = extMap[input.mimeType] || 'bin';
        const safeName = validation.sanitizedFileName;
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
            const shouldPrimary =
              !hasPrimary && (input.isPrimary ?? (existingImgs?.length ?? 0) === 0);

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
  app.all(
    '/api/files/signed-url',
    requireActiveStaff,
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const rawFileId = req.body?.fileId ?? req.query?.fileId;
        const parsedId = UUID_SCHEMA.safeParse(rawFileId);
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
        } else if (fileRow.purpose === 'attachment') {
          const isLinkedPurchase = (fileLinks ?? []).some(
            (l) => l.entity_type === 'purchase_bill'
          );
          const isLinkedExpense = (fileLinks ?? []).some(
            (l) => l.entity_type === 'expense'
          );
          if (isLinkedPurchase) {
            if (!['owner', 'manager', 'storekeeper', 'accountant'].includes(role)) {
              res.status(403).json({
                error: 'You do not have permission to access this purchase attachment.',
              });
              return;
            }
          } else if (isLinkedExpense) {
            const allowedExpenseViewer =
              ['owner', 'manager', 'accountant'].includes(role) ||
              (role === 'cashier' && fileRow.uploaded_by === req.staffUser!.id);
            if (!allowedExpenseViewer) {
              res.status(403).json({
                error: 'You do not have permission to access this expense receipt.',
              });
              return;
            }
          } else if (
            !['owner', 'manager', 'accountant', 'storekeeper'].includes(role) &&
            fileRow.uploaded_by !== req.staffUser!.id
          ) {
            res.status(403).json({
              error: 'You do not have permission to access this attachment.',
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
      const supabaseAdmin = req.supabaseAdmin!;
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
      const supabaseAdmin = req.supabaseAdmin!;
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
        } else if (fileRow.purpose === 'store_banner') {
          const storeEnabled = await isModuleEnabledServer('online_store');
          if (!storeEnabled || !['owner', 'manager', 'storekeeper'].includes(role)) {
            res.status(403).json({ error: 'Only Owner, Manager, or Storekeeper can delete store banners.' });
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
}
