import type { Express, Response } from 'express';
import { redactSecretsFromText, validateExternalHttpsUrl } from '../aiGateway.ts';
import { decryptSecret } from '../crypto.ts';
import { sendSmtpOrWebhookEmail } from '../mailer.ts';
import {
  isModuleEnabledServer,
  requireActiveStaff,
  requireModuleEnabled,
  type AuthenticatedRequest,
} from '../middleware.ts';

export function registerMessagingRoutes(app: Express): void {
  app.post(
    '/api/messaging/send',
    requireActiveStaff,
    requireModuleEnabled('messaging'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        if (!['owner', 'manager', 'cashier', 'accountant'].includes(req.staffUser!.role)) {
          res.status(403).json({ error: 'Insufficient permissions to send messages.' });
          return;
        }
        const channel = ['whatsapp', 'sms', 'email'].includes(String(req.body?.channel))
          ? String(req.body.channel)
          : 'whatsapp';
        if (channel === 'email' && !(await isModuleEnabledServer('email_notifications'))) {
          res.status(403).json({
            error:
              'Feature "email_notifications" is currently turned off in Settings -> Modules.',
            moduleKey: 'email_notifications',
          });
          return;
        }
        const recipient = String(req.body?.recipient || '').trim();
        const body = String(req.body?.body || '').trim();
        const templateKey =
          typeof req.body?.templateKey === 'string' ? req.body.templateKey : null;
        if (!recipient || !body) {
          res.status(400).json({ error: 'Recipient and message body are required.' });
          return;
        }

        let status: 'sent' | 'queued' | 'failed' = 'queued';
        let errMsg: string | null = null;

        if (channel === 'email') {
          const subject =
            typeof req.body?.subject === 'string' && req.body.subject.trim()
              ? req.body.subject.trim()
              : 'DecorBiz Notification';
          const mailResult = await sendSmtpOrWebhookEmail(supabaseAdmin, {
            to: recipient,
            subject,
            text: body,
            entityType: typeof req.body?.entityType === 'string' ? req.body.entityType : undefined,
            entityId: typeof req.body?.entityId === 'string' ? req.body.entityId : undefined,
          });
          status = mailResult.status;
          errMsg = mailResult.errorMessage;
        } else {
          const { data: slot } = await supabaseAdmin
            .from('integration_settings')
            .select('enabled, config_public, has_secret, encrypted_secret')
            .eq('integration_key', 'whatsapp_sms')
            .maybeSingle();

          if (!slot?.enabled || !slot.has_secret) {
            errMsg = 'WhatsApp/SMS provider is not configured in Settings → Integrations. Logged locally as queued draft.';
          } else {
            const pub = (slot.config_public || {}) as Record<string, unknown>;
            const webhookUrl = typeof pub.base_url === 'string' ? pub.base_url.trim() : '';
            if (webhookUrl) {
              const check = validateExternalHttpsUrl(webhookUrl);
              if (!check.valid || !check.normalized) {
                throw new Error(check.error || 'Invalid messaging gateway URL.');
              }
              const secretToken = decryptSecret(slot.encrypted_secret!);
              const gwRes = await fetch(check.normalized, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${secretToken}`,
                },
                body: JSON.stringify({ channel, recipient, body }),
              });
              status = gwRes.ok ? 'sent' : 'failed';
              if (!gwRes.ok) errMsg = `Provider responded with HTTP ${gwRes.status}`;
            } else {
              status = 'sent';
            }
          }
        }

        const { data: logRow, error: logErr } = await supabaseAdmin
          .from('message_logs')
          .insert({
            channel,
            recipient,
            template_key: templateKey,
            rendered_body: body,
            status,
            error_message: errMsg,
            entity_type: typeof req.body?.entityType === 'string' ? req.body.entityType : null,
            entity_id: typeof req.body?.entityId === 'string' ? req.body.entityId : null,
            sent_by: req.staffUser!.id,
          })
          .select('*')
          .single();

        if (logErr) throw new Error(logErr.message);
        res.json({ log: logRow, warning: errMsg });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error ? redactSecretsFromText(err.message) : 'Unable to send message.',
        });
      }
    }
  );
}
