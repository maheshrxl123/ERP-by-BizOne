import type { SupabaseClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { redactSecretsFromText, validateExternalHttpsUrl } from './aiGateway.ts';
import { decryptSecret } from './crypto.ts';

export interface EmailSendResult {
  status: 'sent' | 'queued' | 'failed';
  errorMessage: string | null;
}

interface SmtpSlotRow {
  enabled: boolean;
  config_public: Record<string, unknown> | null;
  has_secret: boolean;
  encrypted_secret: string | null;
}

function resolveSenderEmail(pub: Record<string, unknown>): string {
  const candidates = [pub.sender_email, pub.from_email, pub.username];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function buildSmtpTransport(pub: Record<string, unknown>, password: string) {
  const host = typeof pub.host === 'string' ? pub.host.trim() : '';
  const portRaw = Number(pub.port || 587);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 587;
  const secure =
    pub.secure === true || pub.secure === 'true' || port === 465;
  const senderEmail = resolveSenderEmail(pub);
  const username =
    typeof pub.username === 'string' && pub.username.trim()
      ? pub.username.trim()
      : senderEmail;

  if (!host || !senderEmail) {
    throw new Error('SMTP host and sender email must be configured in Settings -> Integrations.');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: username,
      pass: password,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });

  return { transporter, senderEmail };
}

export async function verifySmtpConnection(admin: SupabaseClient): Promise<string> {
  const { data: slot } = await admin
    .from('integration_settings')
    .select('enabled, config_public, has_secret, encrypted_secret')
    .eq('integration_key', 'smtp_email')
    .maybeSingle();

  const typed = slot as SmtpSlotRow | null;
  if (!typed || !typed.enabled) {
    throw new Error('Enable SMTP Email before testing.');
  }
  if (!typed.has_secret || !typed.encrypted_secret) {
    throw new Error('Enter and save the SMTP password / API token before testing.');
  }

  const pub = (typed.config_public || {}) as Record<string, unknown>;
  const secretValue = decryptSecret(typed.encrypted_secret);

  const webhookUrl = typeof pub.base_url === 'string' ? pub.base_url.trim() : '';
  if (webhookUrl) {
    const urlCheck = validateExternalHttpsUrl(webhookUrl);
    if (!urlCheck.valid || !urlCheck.normalized) {
      throw new Error(urlCheck.error || 'Invalid SMTP relay HTTPS URL.');
    }
    return `SMTP HTTP relay verified (${new URL(urlCheck.normalized).hostname}).`;
  }

  const { transporter } = buildSmtpTransport(pub, secretValue);
  await transporter.verify();
  return `SMTP connection verified (${String(pub.host)}:${String(pub.port || 587)}).`;
}

export async function sendSmtpOrWebhookEmail(
  admin: SupabaseClient,
  payload: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    entityType?: string;
    entityId?: string;
  }
): Promise<EmailSendResult> {
  try {
    const { data: slot } = await admin
      .from('integration_settings')
      .select('enabled, config_public, has_secret, encrypted_secret')
      .eq('integration_key', 'smtp_email')
      .maybeSingle();

    const typed = slot as SmtpSlotRow | null;
    if (!typed?.enabled || !typed.has_secret || !typed.encrypted_secret) {
      return {
        status: 'queued',
        errorMessage:
          'SMTP Email provider is not configured in Settings -> Integrations. Logged locally as queued.',
      };
    }

    const pub = (typed.config_public || {}) as Record<string, unknown>;
    const secretValue = decryptSecret(typed.encrypted_secret);

    const webhookUrl = typeof pub.base_url === 'string' ? pub.base_url.trim() : '';
    if (webhookUrl) {
      const check = validateExternalHttpsUrl(webhookUrl);
      if (!check.valid || !check.normalized) {
        return {
          status: 'failed',
          errorMessage: check.error || 'Invalid SMTP webhook URL.',
        };
      }
      const gwRes = await fetch(check.normalized, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretValue}`,
        },
        body: JSON.stringify({
          channel: 'email',
          recipient: payload.to,
          subject: payload.subject,
          body: payload.text,
          html: payload.html,
          entityType: payload.entityType || null,
          entityId: payload.entityId || null,
        }),
      });
      if (!gwRes.ok) {
        return {
          status: 'failed',
          errorMessage: `Email webhook responded with HTTP ${gwRes.status}`,
        };
      }
      return { status: 'sent', errorMessage: null };
    }

    const { transporter, senderEmail } = buildSmtpTransport(pub, secretValue);
    await transporter.sendMail({
      from: senderEmail,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
    return { status: 'sent', errorMessage: null };
  } catch (err) {
    return {
      status: 'failed',
      errorMessage:
        err instanceof Error
          ? redactSecretsFromText(err.message)
          : 'Failed to dispatch email via SMTP.',
    };
  }
}
