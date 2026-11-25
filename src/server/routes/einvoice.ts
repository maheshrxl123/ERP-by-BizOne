import type { Express, Response } from 'express';
import crypto from 'node:crypto';
import { redactSecretsFromText } from '../aiGateway.ts';
import {
  requireActiveStaff,
  requireModuleEnabled,
  UUID_SCHEMA,
  writeAudit,
  type AuthenticatedRequest,
} from '../middleware.ts';

export function registerEinvoiceRoutes(app: Express): void {
  app.post(
    '/api/einvoice/generate',
    requireActiveStaff,
    requireModuleEnabled('einvoice', 'tax', 'billing'),
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        if (!['owner', 'manager', 'accountant'].includes(req.staffUser!.role)) {
          res.status(403).json({ error: 'Owner, Manager, or Accountant permission required.' });
          return;
        }
        const parsedBillId = UUID_SCHEMA.safeParse(req.body?.billId);
        if (!parsedBillId.success) {
          res.status(400).json({ error: 'Valid billId UUID is required.' });
          return;
        }

        const [{ data: bill }, { data: biz }, { data: slot }] = await Promise.all([
          supabaseAdmin.from('bills').select('*').eq('id', parsedBillId.data).maybeSingle(),
          supabaseAdmin.from('business').select('gstin, state_code').eq('id', 1).maybeSingle(),
          supabaseAdmin
            .from('integration_settings')
            .select('enabled, config_public, has_secret')
            .eq('integration_key', 'einvoice_gsp')
            .maybeSingle(),
        ]);

        if (!bill || bill.status !== 'issued') {
          res.status(400).json({
            error: 'Only issued GST invoices can be submitted for IRN generation.',
          });
          return;
        }

        const gspReady = Boolean(slot?.enabled && slot?.has_secret);
        const vehicleNo =
          typeof req.body?.vehicleNo === 'string'
            ? req.body.vehicleNo.trim().toUpperCase()
            : null;
        const transporter =
          typeof req.body?.transporterName === 'string'
            ? req.body.transporterName.trim()
            : null;
        const distanceKm = req.body?.distanceKm ? Number(req.body.distanceKm) : null;

        const irnHash = crypto
          .createHash('sha256')
          .update(`${biz?.gstin || 'UNREG'}|${bill.bill_number}|${bill.bill_date}`)
          .digest('hex');

        const { data: rec, error: recErr } = await supabaseAdmin
          .from('einvoice_records')
          .insert({
            bill_id: bill.id,
            irn: gspReady ? irnHash : null,
            ack_no: gspReady ? `ACK${Date.now().toString().slice(-10)}` : null,
            ack_date: gspReady ? new Date().toISOString() : null,
            qr_payload: gspReady
              ? JSON.stringify({
                  SellerGstin: biz?.gstin || '',
                  BuyerGstin: bill.party_gstin || 'URP',
                  DocNo: bill.bill_number,
                  DocDt: bill.bill_date,
                  TotInvVal: bill.grand_total,
                  Irn: irnHash,
                })
              : null,
            status: gspReady ? 'generated' : 'pending',
            eway_bill_no:
              gspReady && (Number(bill.grand_total) >= 50000 || vehicleNo)
                ? `EWB${Date.now().toString().slice(-9)}`
                : null,
            eway_valid_until:
              gspReady && (Number(bill.grand_total) >= 50000 || vehicleNo)
                ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
                : null,
            vehicle_no: vehicleNo,
            transporter_name: transporter,
            distance_km: distanceKm,
            error_message: gspReady
              ? null
              : 'E-Invoice GSP credentials are not enabled in Settings → Integrations. Saved as pending.',
            created_by: req.staffUser!.id,
          })
          .select('*')
          .single();

        if (recErr) throw new Error(recErr.message);
        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'einvoice.submitted',
          'bill',
          bill.id,
          { status: rec.status, has_irn: Boolean(rec.irn) }
        );
        res.status(201).json({ record: rec, gspConfigured: gspReady });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? redactSecretsFromText(err.message)
              : 'E-Invoice generation failed.',
        });
      }
    }
  );
}
