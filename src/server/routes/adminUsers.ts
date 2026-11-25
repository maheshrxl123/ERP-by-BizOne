import type { Express, Response } from 'express';
import { z } from 'zod';
import {
  requireActiveStaff,
  requireOwner,
  UUID_SCHEMA,
  writeAudit,
  type AuthenticatedRequest,
} from '../middleware.ts';
import { createRateLimiter } from '../rateLimit.ts';

const adminCreateStaffLimiter = createRateLimiter({
  name: 'admin-create-staff',
  windowMs: 15 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many staff account creation requests. Please wait before trying again.',
});

const createStaffSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email(),
  phone: z.string().trim().max(24).optional().nullable(),
  password: z.string().min(8).max(128),
  role: z.enum(['manager', 'cashier', 'storekeeper', 'accountant', 'viewer']),
});

const updateStaffSchema = z
  .object({
    role: z
      .enum(['owner', 'manager', 'cashier', 'storekeeper', 'accountant', 'viewer'])
      .optional(),
    is_active: z.boolean().optional(),
  })
  .refine((val) => val.role !== undefined || val.is_active !== undefined, {
    message: 'No valid fields to update.',
  });

export function registerAdminUserRoutes(app: Express): void {
  // Owner-only: create staff user
  app.post(
    '/api/admin/users',
    adminCreateStaffLimiter,
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const parsed = createStaffSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error:
              parsed.error.issues[0]?.message || 'Invalid staff details provided.',
          });
          return;
        }
        const input = parsed.data;

        const { data: createdAuth, error: authErr } =
          await supabaseAdmin.auth.admin.createUser({
            email: input.email,
            password: input.password,
            email_confirm: true,
            user_metadata: { full_name: input.fullName },
          });

        if (authErr || !createdAuth.user) {
          res.status(400).json({
            error: authErr?.message || 'Unable to create staff account.',
          });
          return;
        }

        const { data: profile, error: profErr } = await supabaseAdmin
          .from('profiles')
          .insert({
            id: createdAuth.user.id,
            full_name: input.fullName,
            phone: input.phone || null,
            email: input.email,
            role: input.role,
            is_active: true,
          })
          .select('*')
          .single();

        if (profErr) {
          await supabaseAdmin.auth.admin.deleteUser(createdAuth.user.id);
          res.status(500).json({ error: profErr.message });
          return;
        }

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'staff.created',
          'profile',
          createdAuth.user.id,
          { email: input.email, role: input.role }
        );

        res.status(201).json({ profile });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to add staff member.';
        res.status(500).json({ error: message });
      }
    }
  );

  // Owner-only: update staff role or activation
  app.patch(
    '/api/admin/users/:id',
    requireActiveStaff,
    requireOwner,
    async (req: AuthenticatedRequest, res: Response) => {
      const supabaseAdmin = req.supabaseAdmin!;
      try {
        const targetIdParsed = UUID_SCHEMA.safeParse(req.params.id);
        if (!targetIdParsed.success) {
          res.status(400).json({ error: 'Invalid user ID format.' });
          return;
        }
        const targetId = targetIdParsed.data;

        const parsedPatch = updateStaffSchema.safeParse(req.body ?? {});
        if (!parsedPatch.success) {
          res.status(400).json({
            error:
              parsedPatch.error.issues[0]?.message || 'No valid fields to update.',
          });
          return;
        }
        const updatePatch = parsedPatch.data;

        const { data: existingProfile } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('id', targetId)
          .maybeSingle();

        if (!existingProfile) {
          res.status(404).json({ error: 'Staff member not found.' });
          return;
        }

        const { data: updated, error } = await supabaseAdmin
          .from('profiles')
          .update(updatePatch)
          .eq('id', targetId)
          .select('*')
          .single();

        if (error) {
          res.status(400).json({ error: error.message });
          return;
        }

        await writeAudit(
          req.staffUser!.id,
          req.staffUser!.email,
          'staff.updated',
          'profile',
          targetId,
          updatePatch
        );

        res.json({ profile: updated });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update staff user.';
        res.status(500).json({ error: message });
      }
    }
  );
}
