import type { Express, Response } from 'express';
import { redactSecretsFromText } from '../aiGateway.ts';
import { sendSmtpOrWebhookEmail } from '../mailer.ts';
import {
  requireActiveStaff,
  requireModuleEnabled,
  resolveRequestOrigin,
  UUID_SCHEMA,
  writeAudit,
  type AuthenticatedRequest,
} from '../middleware.ts';

export function registerFeatureModuleRoutes(app: Express): void {
  app.get(
    '/api/locations/summary',
    requireActiveStaff,
    requireModuleEnabled('locations', 'inventory'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ count: locCount }, { count: transferCount }] = await Promise.all([
          supabaseAdmin
            .from('locations')
            .select('id', { count: 'exact', head: true })
            .eq('is_active', true),
          supabaseAdmin.from('stock_transfers').select('id', { count: 'exact', head: true }),
        ]);
        res.json({
          enabled: true,
          activeLocations: locCount || 0,
          stockTransfers: transferCount || 0,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Unable to load locations summary.',
        });
      }
    }
  );

  app.get(
    '/api/accounting/summary',
    requireActiveStaff,
    requireModuleEnabled('accounting', 'billing'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'accountant', 'viewer'].includes(req.staffUser!.role)) {
        res.status(403).json({ error: 'Accounting permission required.' });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ count: ledgerCount }, { count: voucherCount }] = await Promise.all([
          supabaseAdmin.from('ledgers').select('id', { count: 'exact', head: true }),
          supabaseAdmin.from('vouchers').select('id', { count: 'exact', head: true }),
        ]);
        res.json({
          enabled: true,
          ledgerCount: ledgerCount || 0,
          voucherCount: voucherCount || 0,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Unable to load accounting summary.',
        });
      }
    }
  );

  app.get(
    '/api/gst-returns/summary',
    requireActiveStaff,
    requireModuleEnabled('gst_returns', 'tax'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'accountant', 'viewer'].includes(req.staffUser!.role)) {
        res.status(403).json({ error: 'GST Reports permission required.' });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ count: invoiceCount }, { count: gstr2bCount }] = await Promise.all([
          supabaseAdmin
            .from('bills')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'issued'),
          supabaseAdmin.from('gstr2b_entries').select('id', { count: 'exact', head: true }),
        ]);
        res.json({
          enabled: true,
          issuedBills: invoiceCount || 0,
          gstr2bRows: gstr2bCount || 0,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Unable to load GST returns summary.',
        });
      }
    }
  );

  app.get(
    '/api/pos/status',
    requireActiveStaff,
    requireModuleEnabled('pos', 'billing'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ count: itemCount }, { count: openRegisters }] = await Promise.all([
          supabaseAdmin
            .from('item_catalog_view')
            .select('id', { count: 'exact', head: true })
            .eq('is_active', true),
          supabaseAdmin
            .from('pos_cash_registers')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'open'),
        ]);
        res.json({
          enabled: true,
          activeCounterItems: itemCount || 0,
          openRegisters: openRegisters || 0,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Unable to load POS status.',
        });
      }
    }
  );

  app.get(
    '/api/online-payments/config',
    requireActiveStaff,
    requireModuleEnabled('online_payments'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const { data: slot } = await supabaseAdmin
          .from('integration_settings')
          .select('enabled, config_public, has_secret, status')
          .eq('integration_key', 'online_payments')
          .maybeSingle();
        const pub = (slot?.config_public || {}) as Record<string, unknown>;
        res.json({
          enabled: true,
          integrationConfigured: Boolean(slot?.enabled && slot?.has_secret),
          provider: typeof pub.provider === 'string' ? pub.provider : 'razorpay',
          mode: typeof pub.mode === 'string' ? pub.mode : 'test',
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Unable to load online payments status.',
        });
      }
    }
  );

  app.post(
    '/api/online-payments/create-link',
    requireActiveStaff,
    requireModuleEnabled('online_payments'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'cashier', 'accountant'].includes(req.staffUser!.role)) {
        res.status(403).json({
          error: 'Insufficient permissions to create payment links.',
        });
        return;
      }
      const parsedBillId = UUID_SCHEMA.safeParse(req.body?.billId);
      if (!parsedBillId.success) {
        res.status(400).json({ error: 'Valid billId UUID is required.' });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ data: bill }, { data: slot }] = await Promise.all([
          supabaseAdmin
            .from('bills')
            .select('id, bill_number, status, balance_due, party_name')
            .eq('id', parsedBillId.data)
            .maybeSingle(),
          supabaseAdmin
            .from('integration_settings')
            .select('enabled, config_public, has_secret')
            .eq('integration_key', 'online_payments')
            .maybeSingle(),
        ]);

        if (!bill || bill.status !== 'issued') {
          res.status(400).json({
            error: 'Only issued bills can generate an online payment link.',
          });
          return;
        }

        const amountDue = Number(req.body?.amount ?? bill.balance_due ?? 0);
        if (!Number.isFinite(amountDue) || amountDue <= 0) {
          res.status(400).json({ error: 'Bill has zero balance due.' });
          return;
        }

        const pub = (slot?.config_public || {}) as Record<string, unknown>;
        const configured = Boolean(slot?.enabled && slot?.has_secret);
        const provider = typeof pub.provider === 'string' ? pub.provider : 'razorpay';
        const origin = resolveRequestOrigin(req);
        const paymentUrl = `${origin}/pay/${bill.id}?ref=${encodeURIComponent(bill.bill_number || bill.id)}&amount=${amountDue.toFixed(2)}`;

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'online_payment.link_created',
          'bill',
          bill.id,
          { provider, configured, amount: amountDue }
        );

        res.json({
          paymentUrl,
          provider,
          configured,
          warning: configured
            ? null
            : 'Online payment gateway credentials are not yet enabled in Settings -> Integrations; created local reference link.',
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? redactSecretsFromText(err.message)
              : 'Unable to create online payment link.',
        });
      }
    }
  );

  app.get(
    '/api/email-notifications/status',
    requireActiveStaff,
    requireModuleEnabled('email_notifications'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const { data: slot } = await supabaseAdmin
          .from('integration_settings')
          .select('enabled, has_secret, status')
          .eq('integration_key', 'smtp_email')
          .maybeSingle();
        res.json({
          enabled: true,
          smtpConfigured: Boolean(slot?.enabled && slot?.has_secret),
          status: slot?.status || 'not_configured',
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'Unable to load email notification status.',
        });
      }
    }
  );

  app.post(
    '/api/email-notifications/send-digest',
    requireActiveStaff,
    requireModuleEnabled('email_notifications'),
    async (req: AuthenticatedRequest, res: Response) => {
      if (!['owner', 'manager', 'accountant'].includes(req.staffUser!.role)) {
        res.status(403).json({
          error: 'Only Owner, Manager, or Accountant can send email digests.',
        });
        return;
      }
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ data: biz }, { data: slot }] = await Promise.all([
          supabaseAdmin.from('business').select('name, email').eq('id', 1).maybeSingle(),
          supabaseAdmin
            .from('integration_settings')
            .select('enabled, config_public, has_secret')
            .eq('integration_key', 'smtp_email')
            .maybeSingle(),
        ]);
        const pub = (slot?.config_public || {}) as Record<string, unknown>;
        const recipient =
          (typeof pub.sender_email === 'string' && pub.sender_email.trim()) ||
          (typeof pub.from_email === 'string' && pub.from_email.trim()) ||
          biz?.email ||
          req.staffUser!.email;
        const unreadCount = Math.max(0, Number(req.body?.unreadCount || 0));
        const warningCount = Math.max(0, Number(req.body?.warningCount || 0));
        const body = `DecorBiz Daily Alert Digest for ${biz?.name || 'Business'}: ${unreadCount} unread alert(s), ${warningCount} action-required warning(s).`;

        const mailResult = await sendSmtpOrWebhookEmail(supabaseAdmin, {
          to: recipient,
          subject: `DecorBiz Daily Alert Digest — ${biz?.name || 'Business'}`,
          text: body,
          entityType: 'business',
          entityId: '1',
        });

        await supabaseAdmin.from('message_logs').insert({
          channel: 'email',
          recipient,
          template_key: 'alert_digest',
          rendered_body: body,
          status: mailResult.status,
          error_message: mailResult.errorMessage,
          entity_type: 'business',
          entity_id: '1',
          sent_by: req.staffUser!.id,
        });

        res.json({
          ok: mailResult.status !== 'failed',
          message: mailResult.status === 'sent' ? `Email digest sent to ${recipient}.` : undefined,
          warning: mailResult.errorMessage ?? undefined,
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? redactSecretsFromText(err.message)
              : 'Unable to send email digest.',
        });
      }
    }
  );

  app.get(
    '/api/online-store/config',
    requireActiveStaff,
    requireModuleEnabled('online_store', 'inventory'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const [{ data: biz }, { data: slot }] = await Promise.all([
          supabaseAdmin.from('business').select('name').eq('id', 1).maybeSingle(),
          supabaseAdmin
            .from('integration_settings')
            .select('enabled, config_public, has_secret')
            .eq('integration_key', 'online_store')
            .maybeSingle(),
        ]);
        const pub = (slot?.config_public || {}) as Record<string, unknown>;
        res.json({
          enabled: true,
          storeName: biz?.name || 'DecorBiz Store',
          integrationConfigured: Boolean(
            slot?.enabled && (slot?.has_secret || Boolean(pub.base_url))
          ),
          publicUrl: typeof pub.base_url === 'string' ? pub.base_url : '',
          pickupEnabled: pub.pickup_enabled !== false && pub.pickup_enabled !== 'false',
          codEnabled: pub.cod_enabled !== false && pub.cod_enabled !== 'false',
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Unable to load Online Store configuration.',
        });
      }
    }
  );

  app.get(
    '/api/language/hindi-pack',
    requireActiveStaff,
    requireModuleEnabled('hindi'),
    async (_req: AuthenticatedRequest, res: Response) => {
      res.json({ enabled: true, language: 'hi' });
    }
  );
}
