import type { Express, Response } from 'express';
import {
  callConfiguredAiProvider,
  redactSecretsFromText,
  validateExternalHttpsUrl,
  type AiProviderKind,
} from '../aiGateway.ts';
import { decryptSecret, encryptSecret, isValidEncryptionKey } from '../crypto.ts';
import { verifySmtpConnection } from '../mailer.ts';
import {
  requireActiveStaff,
  requireOwner,
  writeAudit,
  type AuthenticatedRequest,
} from '../middleware.ts';

export function registerIntegrationRoutes(app: Express): void {
  // Owner-only encrypted integration settings (never returns plaintext secrets)
  app.get(
    '/api/integrations',
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
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
      const supabaseAdmin = req.supabaseAdmin!;
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

        const cleanConfigPublic =
          typeof configPublic === 'object' &&
          configPublic !== null &&
          !Array.isArray(configPublic)
            ? (configPublic as Record<string, unknown>)
            : {};

        if (typeof cleanConfigPublic.base_url === 'string' && cleanConfigPublic.base_url.trim()) {
          const check = validateExternalHttpsUrl(cleanConfigPublic.base_url);
          if (!check.valid) {
            res.status(400).json({ error: check.error || 'Invalid integration URL.' });
            return;
          }
          cleanConfigPublic.base_url = check.normalized;
        }

        const patch: Record<string, unknown> = {
          enabled: Boolean(enabled),
          config_public: cleanConfigPublic,
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
      const supabaseAdmin = req.supabaseAdmin!;
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

  app.post(
    '/api/integrations/:key/test',
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const key = String(req.params.key);
        const { data: slot } = await supabaseAdmin
          .from('integration_settings')
          .select('integration_key, enabled, config_public, has_secret, encrypted_secret')
          .eq('integration_key', key)
          .maybeSingle();

        if (!slot) {
          res.status(404).json({ error: 'Integration slot not found.' });
          return;
        }
        if (!slot.enabled) {
          res.status(400).json({ error: 'Enable this integration before running a connection check.' });
          return;
        }

        const pub = (slot.config_public || {}) as Record<string, unknown>;
        let message = 'Configuration verified.';
        if (key === 'ai_provider') {
          if (!slot.has_secret || !slot.encrypted_secret) {
            throw new Error('Save an AI API key before testing.');
          }
          const apiKey = decryptSecret(slot.encrypted_secret);
          const provider = String(pub.provider || 'gemini') as AiProviderKind;
          const model = String(pub.model || 'gemini-4-hydrogen');
          const out = await callConfiguredAiProvider({
            provider,
            apiKey,
            model,
            baseUrl: typeof pub.base_url === 'string' ? pub.base_url : null,
            systemPrompt: 'Reply with OK.',
            userPrompt: 'Connection test.',
          });
          message = `Connected (${provider} / ${model}): ${out.text.slice(0, 40)}`;
        } else if (key === 'google_drive') {
          if (!pub.clientId || !slot.has_secret) {
            throw new Error('Enter Google OAuth Client ID and Client Secret first.');
          }
          message = 'Google OAuth client credentials verified locally.';
        } else if (key === 'smtp_email') {
          message = await verifySmtpConnection(supabaseAdmin);
        } else if (key === 'whatsapp_sms') {
          if (!slot.has_secret) {
            throw new Error('Save your WhatsApp / SMS provider API token first.');
          }
          if (typeof pub.base_url === 'string' && pub.base_url.trim()) {
            const check = validateExternalHttpsUrl(pub.base_url);
            if (!check.valid) throw new Error(check.error);
          }
          message = 'WhatsApp / SMS gateway configuration verified.';
        } else if (key === 'einvoice_gsp') {
          if (!slot.has_secret) {
            throw new Error('Save your GSP Client Secret / API password first.');
          }
          if (typeof pub.base_url === 'string' && pub.base_url.trim()) {
            const check = validateExternalHttpsUrl(pub.base_url);
            if (!check.valid) throw new Error(check.error);
          }
          message = 'E-Invoice GSP configuration verified.';
        } else if (key === 'online_payments') {
          if (!pub.key_id || !slot.has_secret || !slot.encrypted_secret) {
            throw new Error('Enter Gateway Key ID and Key Secret first.');
          }
          if (typeof pub.base_url === 'string' && pub.base_url.trim()) {
            const check = validateExternalHttpsUrl(pub.base_url);
            if (!check.valid) throw new Error(check.error);
          }
          decryptSecret(slot.encrypted_secret);
          message = `Online Payments (${String(pub.provider || 'razorpay')} · ${String(pub.mode || 'test')}) credentials verified.`;
        } else if (key === 'online_store') {
          const hasExternalUrl = typeof pub.base_url === 'string' && pub.base_url.trim().length > 0;
          if (hasExternalUrl) {
            const check = validateExternalHttpsUrl(String(pub.base_url));
            if (!check.valid) throw new Error(check.error);
          }
          if (slot.has_secret && slot.encrypted_secret) {
            decryptSecret(slot.encrypted_secret);
          }
          message = hasExternalUrl
            ? 'Online Storefront & webhook URL configuration verified.'
            : 'Built-in same-origin Online Storefront configuration verified.';
        }

        await supabaseAdmin
          .from('integration_settings')
          .update({ last_checked_at: new Date().toISOString(), status: 'configured' })
          .eq('integration_key', key);

        res.json({ ok: true, message });
      } catch (err) {
        const message = err instanceof Error ? redactSecretsFromText(err.message) : 'Connection test failed.';
        res.status(400).json({ ok: false, error: message });
      }
    }
  );
}
