import type { Express, Response } from 'express';
import crypto from 'node:crypto';
import { STORAGE_BUCKET } from '../config.ts';
import {
  requireActiveStaff,
  requireModuleEnabled,
  requireOwner,
  verifyMagicBytes,
  type AuthenticatedRequest,
} from '../middleware.ts';
import { sanitizeStorageRelativePath } from '../rateLimit.ts';

const ALLOWED_BACKUP_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export function registerBackupRoutes(app: Express): void {
  app.post(
    '/api/backup/export-bundle',
    requireActiveStaff,
    requireModuleEnabled('backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'accountant'].includes(req.staffUser?.role ?? '')) {
        res.status(403).json({
          error: 'Only Owner, Manager, or Accountant can export attachment bundles.',
        });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const { data: files, error: filesErr } = await supabaseAdmin
          .from('files')
          .select('id, bucket, storage_path, file_name, mime_type, size_bytes, checksum, purpose')
          .order('created_at', { ascending: true });
        if (filesErr) {
          res.status(400).json({ error: filesErr.message });
          return;
        }

        const attachments: Array<Record<string, unknown>> = [];
        let omittedCount = 0;
        let totalBytes = 0;
        const MAX_BUNDLE_BYTES = 24 * 1024 * 1024;

        for (const f of files || []) {
          if (
            Number(f.size_bytes || 0) > 6 * 1024 * 1024 ||
            totalBytes + Number(f.size_bytes || 0) > MAX_BUNDLE_BYTES
          ) {
            omittedCount += 1;
            continue;
          }
          const { data: blob, error: dlErr } = await supabaseAdmin.storage
            .from(f.bucket || STORAGE_BUCKET)
            .download(f.storage_path);
          if (dlErr || !blob) {
            omittedCount += 1;
            continue;
          }
          const buf = Buffer.from(await blob.arrayBuffer());
          totalBytes += buf.length;
          attachments.push({
            id: f.id,
            bucket: f.bucket || STORAGE_BUCKET,
            storage_path: f.storage_path,
            file_name: f.file_name,
            mime_type: f.mime_type,
            size_bytes: buf.length,
            checksum: f.checksum || crypto.createHash('sha256').update(buf).digest('hex'),
            purpose: f.purpose,
            base64: buf.toString('base64'),
          });
        }

        res.json({ attachments, omittedCount, totalBytes });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unable to package attachment files.';
        res.status(500).json({ error: message });
      }
    }
  );

  app.post(
    '/api/backup/restore-bundle',
    requireActiveStaff,
    requireOwner,
    requireModuleEnabled('backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const attachments = Array.isArray(req.body?.attachments)
          ? (req.body.attachments as Array<Record<string, unknown>>)
          : [];
        let restoredCount = 0;
        let failedCount = 0;

        for (const item of attachments) {
          try {
            const safePath = sanitizeStorageRelativePath(String(item.storage_path || ''));
            const bucket = String(item.bucket || STORAGE_BUCKET).trim();
            const mimeType = String(item.mime_type || '').trim();
            const b64 = String(item.base64 || '');

            if (!safePath || !b64 || bucket !== STORAGE_BUCKET || !ALLOWED_BACKUP_MIME_TYPES.has(mimeType)) {
              failedCount += 1;
              continue;
            }

            const cleanB64 = b64.includes(',') ? b64.split(',')[1] || '' : b64;
            const buf = Buffer.from(cleanB64, 'base64');
            if (buf.length < 12 || buf.length > 6 * 1024 * 1024 || !verifyMagicBytes(buf, mimeType)) {
              failedCount += 1;
              continue;
            }

            const { error: upErr } = await supabaseAdmin.storage
              .from(STORAGE_BUCKET)
              .upload(safePath, buf, {
                contentType: mimeType,
                upsert: true,
              });
            if (upErr) {
              failedCount += 1;
              continue;
            }
            restoredCount += 1;
          } catch {
            failedCount += 1;
          }
        }

        res.json({ restoredCount, failedCount });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unable to restore attachment files.';
        res.status(500).json({ error: message });
      }
    }
  );
}
