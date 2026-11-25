import type { Express, Response } from 'express';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotpCode,
} from '../../core/totp.ts';
import {
  createTotpProofToken,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyTotpProofToken,
} from '../totpSecurity.ts';
import { requireActiveStaff, requireOwner, type AuthenticatedRequest } from '../middleware.ts';
import { createRateLimiter, extractRequestIp } from '../rateLimit.ts';

const totpRateLimiter = createRateLimiter({
  name: 'erp-totp-verify',
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyFn: (req) => `${extractRequestIp(req)}:totp`,
  message: 'Too many 2FA verification attempts. Please wait 15 minutes before retrying.',
});

export function registerTotpRoutes(app: Express) {
  // Current staff user 2FA status (+ enabled staff list for Owner Settings > Users)
  app.get('/api/erp/auth/totp-status', requireActiveStaff, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const admin = req.supabaseAdmin!;
      const userId = req.staffUser!.id;
      const { data: ownRow } = await admin
        .from('staff_totp')
        .select('enabled, updated_at')
        .eq('user_id', userId)
        .maybeSingle();

      const enabled = Boolean(ownRow?.enabled);
      const headerToken =
        typeof req.headers['x-erp-totp-token'] === 'string'
          ? req.headers['x-erp-totp-token']
          : '';
      const verified = !enabled || verifyTotpProofToken(userId, headerToken);

      let enabledUserIds: string[] | undefined;
      if (req.staffUser!.role === 'owner' && verified) {
        const { data: rows } = await admin
          .from('staff_totp')
          .select('user_id')
          .eq('enabled', true);
        enabledUserIds = (rows || []).map((r) => String(r.user_id));
      }

      res.json({
        enabled,
        verified,
        updatedAt: ownRow?.updated_at || null,
        enabledUserIds,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to check 2FA status.' });
    }
  });

  // Expose detected client IP for Settings > Security quick-add button
  app.get('/api/erp/security/ip-info', requireActiveStaff, (req: AuthenticatedRequest, res: Response) => {
    res.json({ clientIp: extractRequestIp(req) });
  });

  // Setup 2FA (generate secret + hashed recovery codes stored, plaintext returned once)
  app.post('/api/erp/auth/totp-setup', totpRateLimiter, requireActiveStaff, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const admin = req.supabaseAdmin;
      if (!admin || !req.staffUser) {
        res.status(501).json({ error: 'Server not configured.' });
        return;
      }

      const secret = generateTotpSecret();
      const recoveryCodes = generateRecoveryCodes(8);
      const hashedRecoveryCodes = recoveryCodes.map((code) => hashRecoveryCode(code));

      // Upsert into staff_totp (disabled until verified)
      const { error } = await admin.from('staff_totp').upsert({
        user_id: req.staffUser.id,
        secret,
        recovery_codes: hashedRecoveryCodes,
        enabled: false,
        updated_at: new Date().toISOString(),
      });

      if (error) throw error;

      res.json({
        secret,
        recoveryCodes,
        otpauthUrl: `otpauth://totp/DecorBiz:${encodeURIComponent(req.staffUser.email)}?secret=${secret}&issuer=DecorBiz`,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to setup 2FA.' });
    }
  });

  // Verify and enable 2FA
  app.post('/api/erp/auth/totp-verify', totpRateLimiter, requireActiveStaff, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const admin = req.supabaseAdmin;
      const { token } = req.body as { token?: string };
      if (!admin || !req.staffUser || !token) {
        res.status(400).json({ error: 'Verification code required.' });
        return;
      }

      const { data: record, error: fetchErr } = await admin
        .from('staff_totp')
        .select('*')
        .eq('user_id', req.staffUser.id)
        .maybeSingle();

      if (fetchErr || !record) {
        res.status(404).json({ error: '2FA setup not initiated. Please setup 2FA first.' });
        return;
      }

      const isValid = verifyTotpCode(record.secret, token);
      if (!isValid) {
        res.status(400).json({ error: 'Invalid verification code.' });
        return;
      }

      await admin
        .from('staff_totp')
        .update({
          enabled: true,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', req.staffUser.id);

      const totpProof = createTotpProofToken(req.staffUser.id);
      res.json({
        success: true,
        totpProof,
        message: 'Two-factor authentication successfully enabled.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to verify 2FA.' });
    }
  });

  // Validate TOTP or recovery code during login
  app.post('/api/erp/auth/totp-validate', totpRateLimiter, requireActiveStaff, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const admin = req.supabaseAdmin;
      const { token } = req.body as { token?: string };
      if (!admin || !req.staffUser || !token) {
        res.status(400).json({ error: 'TOTP token required.' });
        return;
      }

      const { data: record } = await admin
        .from('staff_totp')
        .select('*')
        .eq('user_id', req.staffUser.id)
        .maybeSingle();

      if (!record || !record.enabled) {
        res.json({ valid: true, enabled: false });
        return;
      }

      const cleanToken = token.trim().toUpperCase();
      let isValid = verifyTotpCode(record.secret, cleanToken);

      if (!isValid && Array.isArray(record.recovery_codes)) {
        const index = record.recovery_codes.findIndex((stored: string) =>
          verifyRecoveryCode(cleanToken, String(stored))
        );
        if (index !== -1) {
          isValid = true;
          const updatedCodes = [...record.recovery_codes];
          updatedCodes.splice(index, 1);
          await admin
            .from('staff_totp')
            .update({ recovery_codes: updatedCodes, updated_at: new Date().toISOString() })
            .eq('user_id', req.staffUser.id);
        }
      }

      if (!isValid) {
        res.status(400).json({ error: 'Invalid authenticator code or recovery code.' });
        return;
      }

      const totpProof = createTotpProofToken(req.staffUser.id);
      res.json({ valid: true, enabled: true, totpProof });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Validation failed.' });
    }
  });

  // Owner reset staff 2FA
  app.post('/api/erp/auth/totp-reset', requireActiveStaff, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const admin = req.supabaseAdmin;
      const { userId } = req.body as { userId?: string };
      if (!admin || !userId) {
        res.status(400).json({ error: 'User ID required.' });
        return;
      }

      await admin.from('staff_totp').delete().eq('user_id', userId);
      res.json({ success: true, message: 'Staff two-factor authentication has been reset by Owner.' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unable to reset 2FA.' });
    }
  });
}
