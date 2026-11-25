import type { SupabaseClient } from '@supabase/supabase-js';
import type { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import { redactSecretsFromText } from '../aiGateway.ts';
import { createUserScopedClient, getSupabaseAdmin, STORAGE_BUCKET } from '../config.ts';
import {
  decryptSecret,
  encryptSecret,
  signOAuthState,
  verifyOAuthState,
} from '../crypto.ts';
import {
  isModuleEnabledServer,
  requireActiveStaff,
  requireModuleEnabled,
  requireOwner,
  resolveRequestOrigin,
  writeAudit,
  type AuthenticatedRequest,
} from '../middleware.ts';

async function getGoogleDriveOAuthConfig(admin: SupabaseClient) {
  const { data, error } = await admin
    .from('integration_settings')
    .select('enabled, config_public, encrypted_secret, has_secret')
    .eq('integration_key', 'google_drive')
    .maybeSingle();

  if (error || !data) {
    throw new Error('Google Drive integration slot not found.');
  }
  if (!data.enabled) {
    throw new Error(
      'Google Drive integration is currently disabled. Enable it in Settings → Integrations (local backup remains available).'
    );
  }
  const pub = (data.config_public || {}) as Record<string, unknown>;
  const clientId = typeof pub.clientId === 'string' ? pub.clientId.trim() : '';
  if (!clientId || !data.has_secret || !data.encrypted_secret) {
    throw new Error(
      'Enter Google OAuth Client ID and Client Secret in Settings → Integrations → Google Drive first.'
    );
  }
  const clientSecret = decryptSecret(data.encrypted_secret);
  return { clientId, clientSecret };
}

async function ensureValidDriveAccessToken(admin: SupabaseClient): Promise<{
  accessToken: string;
  folderId: string | null;
  folderName: string;
  retentionCount: number;
}> {
  const { data: conn, error } = await admin
    .from('drive_connections')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error || !conn || !conn.refresh_token_enc || conn.last_sync_status === 'disconnected') {
    throw new Error('Google Drive is not connected yet. Connect your Google account first.');
  }

  const expiresAtMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (conn.access_token_enc && expiresAtMs > Date.now() + 60_000) {
    return {
      accessToken: decryptSecret(conn.access_token_enc),
      folderId: conn.folder_id || null,
      folderName: conn.folder_name || 'DecorBiz Backups',
      retentionCount: Number(conn.retention_count || 10),
    };
  }

  const { clientId, clientSecret } = await getGoogleDriveOAuthConfig(admin);
  const refreshToken = decryptSecret(conn.refresh_token_enc);
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tokenJson = (await tokenRes.json()) as Record<string, unknown>;
  if (!tokenRes.ok || typeof tokenJson.access_token !== 'string') {
    const msg = String(tokenJson.error_description || tokenJson.error || 'Token refresh failed.');
    await admin
      .from('drive_connections')
      .update({ last_sync_status: 'error', last_error: msg })
      .eq('id', 1);
    throw new Error(`Google Drive token refresh failed: ${msg}`);
  }

  const newAccess = tokenJson.access_token;
  const expiresIn = Number(tokenJson.expires_in || 3600);
  await admin
    .from('drive_connections')
    .update({
      access_token_enc: encryptSecret(newAccess),
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      last_error: null,
    })
    .eq('id', 1);

  return {
    accessToken: newAccess,
    folderId: conn.folder_id || null,
    folderName: conn.folder_name || 'DecorBiz Backups',
    retentionCount: Number(conn.retention_count || 10),
  };
}

async function ensureDriveBackupFolder(
  accessToken: string,
  folderName: string,
  existingFolderId: string | null,
  admin: SupabaseClient
): Promise<string> {
  if (existingFolderId) {
    const checkRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existingFolderId)}?fields=id,trashed`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (checkRes.ok) {
      const meta = (await checkRes.json()) as { id?: string; trashed?: boolean };
      if (meta.id && !meta.trashed) return meta.id;
    }
  }

  const q = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (searchRes.ok) {
    const searchJson = (await searchRes.json()) as { files?: Array<{ id: string }> };
    if (searchJson.files && searchJson.files.length > 0) {
      const foundId = searchJson.files[0].id;
      await admin.from('drive_connections').update({ folder_id: foundId }).eq('id', 1);
      return foundId;
    }
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const created = (await createRes.json()) as { id?: string; error?: { message?: string } };
  if (!createRes.ok || !created.id) {
    throw new Error(
      created.error?.message || 'Unable to create DecorBiz backup folder in Google Drive.'
    );
  }
  await admin.from('drive_connections').update({ folder_id: created.id }).eq('id', 1);
  return created.id;
}

export function registerGoogleDriveRoutes(app: Express): void {
  app.get(
    '/api/integrations/google-drive/status',
    requireActiveStaff,
    requireModuleEnabled('google_drive_backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'accountant'].includes(req.staffUser?.role ?? '')) {
        res.status(403).json({ error: 'Insufficient permissions.' });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ data: intRow }, { data: connRow }] = await Promise.all([
          supabaseAdmin
            .from('integration_settings')
            .select('enabled, config_public, has_secret, status')
            .eq('integration_key', 'google_drive')
            .maybeSingle(),
          supabaseAdmin
            .from('drive_connections')
            .select(
              'id, connected_email, folder_id, folder_name, schedule_enabled, schedule_frequency, retention_count, last_sync_at, last_sync_status, last_error, updated_at, refresh_token_enc'
            )
            .eq('id', 1)
            .maybeSingle(),
        ]);

        const pub = (intRow?.config_public || {}) as Record<string, unknown>;
        const clientId = typeof pub.clientId === 'string' ? pub.clientId.trim() : '';
        const oauthConfigured = Boolean(intRow?.enabled && clientId && intRow?.has_secret);
        const redirectUri = `${resolveRequestOrigin(req)}/api/integrations/google-drive/callback`;

        res.json({
          oauthConfigured,
          integrationEnabled: Boolean(intRow?.enabled),
          hasClientId: Boolean(clientId),
          hasClientSecret: Boolean(intRow?.has_secret),
          redirectUri,
          connected: Boolean(
            connRow?.refresh_token_enc && connRow?.last_sync_status !== 'disconnected'
          ),
          connectedEmail: connRow?.connected_email || null,
          folderId: connRow?.folder_id || null,
          folderName: connRow?.folder_name || 'DecorBiz Backups',
          scheduleEnabled: Boolean(connRow?.schedule_enabled),
          scheduleFrequency: connRow?.schedule_frequency || 'daily',
          retentionCount: Number(connRow?.retention_count || 10),
          lastSyncAt: connRow?.last_sync_at || null,
          lastSyncStatus: connRow?.last_sync_status || 'never',
          lastError: connRow?.last_error || null,
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Unable to check Google Drive status.',
        });
      }
    }
  );

  app.post(
    '/api/integrations/google-drive/auth-url',
    requireActiveStaff,
    requireOwner,
    requireModuleEnabled('google_drive_backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const { clientId } = await getGoogleDriveOAuthConfig(supabaseAdmin);
        const origin = resolveRequestOrigin(req);
        const redirectUri = `${origin}/api/integrations/google-drive/callback`;
        const state = signOAuthState({
          uid: req.staffUser!.id,
          email: req.staffUser!.email,
          origin,
          ts: Date.now(),
        });

        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set(
          'scope',
          'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email'
        );
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('state', state);

        res.json({ url: url.toString(), redirectUri });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to start Google OAuth.';
        res.status(400).json({ error: message });
      }
    }
  );

  app.get('/api/integrations/google-drive/callback', async (req: Request, res: Response) => {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) {
      res.status(503).send('Supabase is not configured on the server.');
      return;
    }
    if (!(await isModuleEnabledServer('google_drive_backup'))) {
      res.status(403).send('Google Drive Backup module is currently turned off.');
      return;
    }

    const sendPopupCloseHtml = (ok: boolean, message: string) => {
      const safeMsg = JSON.stringify(message);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px;background:#0f172a;color:#f8fafc;">
        <h2 style="margin:0 0 8px;">${ok ? 'Google Drive Connected' : 'Google Drive Authorization Failed'}</h2>
        <p style="opacity:0.85;">${message.replace(/</g, '&lt;')}</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'decorbiz-drive-oauth', ok: ${ok}, message: ${safeMsg} }, window.location.origin);
            setTimeout(() => window.close(), 700);
          } else {
            setTimeout(() => window.location.replace('/?drive=${ok ? 'connected' : 'error'}'), 900);
          }
        </script>
      </body></html>`);
    };

    try {
      if (req.query.error) {
        sendPopupCloseHtml(false, `Google denied access: ${String(req.query.error)}`);
        return;
      }
      const code = String(req.query.code || '').trim();
      const stateRaw = String(req.query.state || '').trim();
      const verified = verifyOAuthState(stateRaw);
      if (!code || !verified || typeof verified.uid !== 'string') {
        sendPopupCloseHtml(false, 'Invalid or expired OAuth state parameter.');
        return;
      }
      if (Date.now() - Number(verified.ts || 0) > 15 * 60 * 1000) {
        sendPopupCloseHtml(false, 'OAuth session expired. Please retry connecting.');
        return;
      }

      const { clientId, clientSecret } = await getGoogleDriveOAuthConfig(supabaseAdmin);
      const origin =
        typeof verified.origin === 'string' ? verified.origin : resolveRequestOrigin(req);
      const redirectUri = `${origin}/api/integrations/google-drive/callback`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenJson = (await tokenRes.json()) as Record<string, unknown>;
      if (!tokenRes.ok || typeof tokenJson.access_token !== 'string') {
        sendPopupCloseHtml(
          false,
          String(tokenJson.error_description || tokenJson.error || 'OAuth code exchange failed.')
        );
        return;
      }

      const accessToken = tokenJson.access_token;
      const refreshToken =
        typeof tokenJson.refresh_token === 'string' ? tokenJson.refresh_token : null;
      const expiresIn = Number(tokenJson.expires_in || 3600);

      let connectedEmail: string | null = null;
      try {
        const uRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (uRes.ok) {
          const uJson = (await uRes.json()) as { email?: string };
          connectedEmail = uJson.email || null;
        }
      } catch {
        // Non-fatal
      }

      const { data: existingConn } = await supabaseAdmin
        .from('drive_connections')
        .select('refresh_token_enc, folder_name')
        .eq('id', 1)
        .maybeSingle();

      const folderName = existingConn?.folder_name || 'DecorBiz Backups';
      const folderId = await ensureDriveBackupFolder(
        accessToken,
        folderName,
        null,
        supabaseAdmin
      );

      await supabaseAdmin.from('drive_connections').upsert({
        id: 1,
        connected_email: connectedEmail,
        access_token_enc: encryptSecret(accessToken),
        refresh_token_enc: refreshToken
          ? encryptSecret(refreshToken)
          : existingConn?.refresh_token_enc || null,
        token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        folder_id: folderId,
        folder_name: folderName,
        last_sync_status: 'never',
        last_error: null,
        connected_by: verified.uid,
      });

      await writeAudit(
        verified.uid,
        typeof verified.email === 'string' ? verified.email : null,
        'drive.connected',
        'integration',
        'google_drive',
        { connectedEmail, folderName }
      );

      sendPopupCloseHtml(
        true,
        `Connected${connectedEmail ? ` (${connectedEmail})` : ''}. You can now return to Settings.`
      );
    } catch (err) {
      sendPopupCloseHtml(
        false,
        err instanceof Error ? err.message : 'Unable to complete Google Drive OAuth.'
      );
    }
  });

  app.post(
    '/api/integrations/google-drive/schedule',
    requireActiveStaff,
    requireOwner,
    requireModuleEnabled('google_drive_backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const scheduleEnabled = Boolean(req.body?.scheduleEnabled);
        const scheduleFrequency =
          req.body?.scheduleFrequency === 'weekly' ? 'weekly' : 'daily';
        const retentionCount = Math.min(50, Math.max(3, Number(req.body?.retentionCount || 10)));
        const folderName =
          String(req.body?.folderName || 'DecorBiz Backups').trim() || 'DecorBiz Backups';

        const { error } = await supabaseAdmin
          .from('drive_connections')
          .update({
            schedule_enabled: scheduleEnabled,
            schedule_frequency: scheduleFrequency,
            retention_count: retentionCount,
            folder_name: folderName,
          })
          .eq('id', 1);

        if (error) {
          res.status(400).json({ error: error.message });
          return;
        }
        res.json({ ok: true, scheduleEnabled, scheduleFrequency, retentionCount, folderName });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to update schedule.',
        });
      }
    }
  );

  app.post(
    '/api/integrations/google-drive/backup-now',
    requireActiveStaff,
    requireModuleEnabled('google_drive_backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'accountant'].includes(req.staffUser?.role ?? '')) {
        res.status(403).json({
          error: 'Only Owner, Manager, or Accountant can upload Drive backups.',
        });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      const userClient = createUserScopedClient(req.headers.authorization!);
      try {
        const includeFiles = Boolean(req.body?.includeFiles);
        const {
          accessToken,
          folderId: curFolderId,
          folderName,
          retentionCount,
        } = await ensureValidDriveAccessToken(supabaseAdmin);
        const folderId = await ensureDriveBackupFolder(
          accessToken,
          folderName,
          curFolderId,
          supabaseAdmin
        );

        const { data: snapshot, error: expErr } = await userClient.rpc(
          'export_workspace_backup',
          {
            p_backup_type: 'drive',
            p_include_files: includeFiles,
            p_destination: 'google_drive',
            p_drive_file_id: null,
          }
        );
        if (expErr || !snapshot) {
          throw new Error(expErr?.message || 'Failed to generate workspace snapshot.');
        }

        const payload = snapshot as Record<string, unknown>;
        if (includeFiles) {
          const { data: files } = await supabaseAdmin
            .from('files')
            .select('id, bucket, storage_path, file_name, mime_type, size_bytes, checksum, purpose');
          const attachments: Array<Record<string, unknown>> = [];
          let totalBytes = 0;
          for (const f of files || []) {
            if (Number(f.size_bytes || 0) > 5 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024)
              continue;
            const { data: blob } = await supabaseAdmin.storage
              .from(f.bucket || STORAGE_BUCKET)
              .download(f.storage_path);
            if (!blob) continue;
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
          payload.attachments = attachments;
        }

        const canonical = JSON.stringify(payload);
        const checksum = crypto.createHash('sha256').update(canonical).digest('hex');
        const finalPayload = JSON.stringify({ ...payload, checksum_sha256: checksum }, null, 2);
        const fileName = `decorbiz-backup-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, '-')}.json`;

        const boundary = `decorbiz_${crypto.randomBytes(12).toString('hex')}`;
        const metadataPart = JSON.stringify({
          name: fileName,
          parents: [folderId],
          mimeType: 'application/json',
        });
        const multipartBody = [
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n`,
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n${finalPayload}\r\n`,
          `--${boundary}--`,
        ].join('');

        const uploadRes = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body: multipartBody,
          }
        );
        const uploaded = (await uploadRes.json()) as {
          id?: string;
          name?: string;
          size?: string;
          createdTime?: string;
          error?: { message?: string };
        };
        if (!uploadRes.ok || !uploaded.id) {
          throw new Error(uploaded.error?.message || 'Google Drive upload failed.');
        }

        let prunedCount = 0;
        const listRes = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
            `'${folderId}' in parents and trashed=false`
          )}&orderBy=createdTime desc&fields=files(id,name,createdTime)&pageSize=100`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (listRes.ok) {
          const listJson = (await listRes.json()) as { files?: Array<{ id: string }> };
          const excess = (listJson.files || []).slice(retentionCount);
          for (const old of excess) {
            const delRes = await fetch(
              `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(old.id)}`,
              { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (delRes.ok) prunedCount += 1;
          }
        }

        const syncedAt = new Date().toISOString();
        await supabaseAdmin
          .from('drive_connections')
          .update({
            last_sync_at: syncedAt,
            last_sync_status: 'ok',
            last_error: null,
          })
          .eq('id', 1);

        res.json({
          fileId: uploaded.id,
          fileName: uploaded.name || fileName,
          checksum,
          syncedAt,
          prunedCount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Google Drive backup failed.';
        await supabaseAdmin
          .from('drive_connections')
          .update({ last_sync_status: 'error', last_error: message })
          .eq('id', 1);
        res.status(400).json({ error: message });
      }
    }
  );

  app.get(
    '/api/integrations/google-drive/backups',
    requireActiveStaff,
    requireModuleEnabled('google_drive_backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'accountant'].includes(req.staffUser?.role ?? '')) {
        res.status(403).json({ error: 'Insufficient permissions.' });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const {
          accessToken,
          folderId: curFolderId,
          folderName,
        } = await ensureValidDriveAccessToken(supabaseAdmin);
        const folderId = await ensureDriveBackupFolder(
          accessToken,
          folderName,
          curFolderId,
          supabaseAdmin
        );

        const listRes = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
            `'${folderId}' in parents and trashed=false and mimeType='application/json'`
          )}&orderBy=createdTime desc&fields=files(id,name,size,createdTime,modifiedTime)&pageSize=50`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const listJson = (await listRes.json()) as {
          files?: Array<{ id: string; name: string; size?: string; createdTime?: string }>;
          error?: { message?: string };
        };
        if (!listRes.ok) {
          throw new Error(listJson.error?.message || 'Unable to list Drive backups.');
        }

        res.json({ files: listJson.files || [] });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Unable to list Drive backups.',
        });
      }
    }
  );

  app.post(
    '/api/integrations/google-drive/restore',
    requireActiveStaff,
    requireOwner,
    requireModuleEnabled('google_drive_backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      const userClient = createUserScopedClient(req.headers.authorization!);
      try {
        const fileId = String(req.body?.fileId || '').trim();
        if (!fileId) {
          res.status(400).json({ error: 'Select a Google Drive backup file to restore.' });
          return;
        }

        const { accessToken } = await ensureValidDriveAccessToken(supabaseAdmin);
        const dlRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!dlRes.ok) {
          throw new Error('Unable to download backup file from Google Drive.');
        }

        const rawText = await dlRes.text();
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        const embeddedChecksum =
          typeof parsed.checksum_sha256 === 'string' ? parsed.checksum_sha256 : null;

        if (embeddedChecksum) {
          const copy = { ...parsed };
          delete copy.checksum_sha256;
          const computed = crypto
            .createHash('sha256')
            .update(JSON.stringify(copy))
            .digest('hex');
          if (computed !== embeddedChecksum) {
            throw new Error('Drive backup checksum mismatch. Restore aborted for safety.');
          }
        }

        const { data: restoreRes, error: restErr } = await userClient.rpc(
          'restore_workspace_backup',
          {
            p_snapshot: parsed,
            p_checksum: embeddedChecksum,
            p_destination: 'google_drive',
            p_drive_file_id: fileId,
          }
        );
        if (restErr) {
          throw new Error(restErr.message);
        }

        let filesRestored = 0;
        if (Array.isArray(parsed.attachments)) {
          for (const item of parsed.attachments as Array<Record<string, unknown>>) {
            const storagePath = String(item.storage_path || '').trim();
            const bucket = String(item.bucket || STORAGE_BUCKET).trim();
            const mimeType = String(item.mime_type || 'application/octet-stream');
            const b64 = String(item.base64 || '');
            if (!storagePath || !b64) continue;
            const buf = Buffer.from(b64, 'base64');
            const { error: upErr } = await supabaseAdmin.storage
              .from(bucket)
              .upload(storagePath, buf, { contentType: mimeType, upsert: true });
            if (!upErr) filesRestored += 1;
          }
        }

        res.json({ ...(restoreRes as Record<string, unknown>), filesRestored });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Google Drive restore failed.',
        });
      }
    }
  );

  app.post(
    '/api/integrations/google-drive/disconnect',
    requireActiveStaff,
    requireOwner,
    requireModuleEnabled('google_drive_backup'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const { data: conn } = await supabaseAdmin
          .from('drive_connections')
          .select('refresh_token_enc, access_token_enc')
          .eq('id', 1)
          .maybeSingle();

        const tokenToRevoke = conn?.refresh_token_enc
          ? decryptSecret(conn.refresh_token_enc)
          : conn?.access_token_enc
            ? decryptSecret(conn.access_token_enc)
            : null;

        if (tokenToRevoke) {
          try {
            await fetch(
              `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`,
              { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );
          } catch {
            // Token may already be expired/revoked remotely
          }
        }

        await supabaseAdmin
          .from('drive_connections')
          .update({
            connected_email: null,
            access_token_enc: null,
            refresh_token_enc: null,
            token_expires_at: null,
            schedule_enabled: false,
            last_sync_status: 'disconnected',
            last_error: null,
          })
          .eq('id', 1);

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'drive.disconnected',
          'integration',
          'google_drive',
          {}
        );

        res.json({ disconnected: true });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? redactSecretsFromText(err.message)
              : 'Unable to disconnect Google Drive.',
        });
      }
    }
  );
}
