import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextFunction, Request, Response } from 'express';
import { getSupabaseAdmin } from './config.ts';
import { isModuleEnabledServer } from './middleware.ts';
import type { CustomerRecord } from '../types/decorbiz.ts';

export interface CustomerAuthenticatedRequest extends Request {
  supabaseAdmin?: SupabaseClient;
  customer?: CustomerRecord;
}

export async function requireOnlineStoreEnabled(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const enabled = await isModuleEnabledServer('online_store');
  if (!enabled) {
    res.status(403).json({ error: 'Online storefront is currently disabled.' });
    return;
  }
  next();
}

export async function requireCustomerAuth(
  req: CustomerAuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(503).json({
      error: 'Supabase environment variables are not configured on the server.',
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Customer sign-in required.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) {
    res.status(401).json({ error: 'Invalid or expired customer session.' });
    return;
  }

  // Explicitly ensure this user belongs to the retail customers table and is active
  const { data: customer, error: custErr } = await admin
    .from('customers')
    .select('*')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();

  if (custErr || !customer || !customer.is_active) {
    res.status(403).json({ error: 'Active customer account required.' });
    return;
  }

  // Sync email_verified status if confirmed in auth
  if (userData.user.email_confirmed_at && !customer.email_verified) {
    await admin
      .from('customers')
      .update({ email_verified: true })
      .eq('id', customer.id);
    customer.email_verified = true;
  }

  if (!customer.email_verified) {
    res.status(403).json({
      error: 'Please verify your email address before continuing.',
      code: 'EMAIL_NOT_VERIFIED',
    });
    return;
  }

  req.supabaseAdmin = admin;
  req.customer = customer as CustomerRecord;
  next();
}
