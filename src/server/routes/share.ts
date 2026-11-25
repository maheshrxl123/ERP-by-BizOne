import type { Express, Request, Response } from 'express';
import { getSupabaseAdmin } from '../config.ts';

export function registerShareRoutes(app: Express): void {
  // Public minimal view-only shared bill endpoint (no staff session required; rate limited per IP)
  const shareRateBuckets = new Map<string, number[]>();

  app.get('/api/share/bill/:token', async (req: Request, res: Response) => {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) {
      res.status(503).json({
        error: 'Supabase environment variables are not configured on the server.',
      });
      return;
    }

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
              'id, bill_number, doc_type, status, payment_status, source_bill_id, party_name, party_phone, party_gstin, party_address, place_of_supply_state_code, is_interstate, bill_date, due_date, valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total, tax_total, extra_charges, round_off, grand_total, paid_amount, credited_amount, balance_due, void_reason, notes, terms, business_snapshot, site_name, issued_at'
            )
            .eq('id', link.bill_id)
            .maybeSingle(),
          supabaseAdmin
            .from('bill_lines')
            .select(
              'id, line_no, item_name, sku, hsn_code, entered_qty, entered_unit_code, unit_price, discount_pct, tax_inclusive, gst_rate, gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, tax_amount, line_total, mrp'
            )
            .eq('bill_id', link.bill_id)
            .order('line_no', { ascending: true }),
          supabaseAdmin
            .from('business')
            .select(
              'logo_file_id, upi_qr_file_id, upi_id, show_upi_qr_on_invoice, default_print_layout'
            )
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
        rawShowQr && bill.doc_type !== 'credit_note' && bill.status !== 'voided';
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
}
