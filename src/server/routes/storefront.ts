import { createClient } from '@supabase/supabase-js';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { computeTileOrderQty, computeStoreOrderTotals, matchDeliveryZone } from '../../core/storeCatalog.ts';
import { roundHalfUp } from '../../core/money.ts';
import type {
  PublishedStoreItemRecord,
  StoreCouponRecord,
  StoreDeliveryZoneRecord,
  StoreOrderStatus,
} from '../../types/decorbiz.ts';
import { getSupabaseAdmin } from '../config.ts';
import {
  requireCustomerAuth,
  requireOnlineStoreEnabled,
  type CustomerAuthenticatedRequest,
} from '../customerAuth.ts';
import {
  isModuleEnabledServer,
  resolveRequestOrigin,
  UUID_SCHEMA,
} from '../middleware.ts';
import { sendSmtpOrWebhookEmail } from '../mailer.ts';
import {
  createRazorpayRemoteOrder,
  getStoreRazorpayConfig,
  verifyRazorpaySignature,
} from '../storePayments.ts';
import { createRateLimiter, extractRequestIp } from '../rateLimit.ts';

const storeAuthLoginLimiter = createRateLimiter({
  name: 'store-auth-login',
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  keyFn: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return `${extractRequestIp(req)}:${email || 'anon'}`;
  },
  message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
});

const storeAuthRegisterLimiter = createRateLimiter({
  name: 'store-auth-register',
  windowMs: 15 * 60 * 1000,
  maxRequests: 8,
  message: 'Too many registration attempts from this IP. Please try again later.',
});

const storeAuthRecoveryLimiter = createRateLimiter({
  name: 'store-auth-recovery',
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  keyFn: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return `${extractRequestIp(req)}:${email || 'anon'}`;
  },
  message: 'Too many verification or password reset requests. Please wait 15 minutes.',
});

const storeCheckoutLimiter = createRateLimiter({
  name: 'store-checkout',
  windowMs: 10 * 60 * 1000,
  maxRequests: 15,
  message: 'Too many checkout requests submitted too quickly. Please wait a moment.',
});

const storePaymentVerifyLimiter = createRateLimiter({
  name: 'store-payment-verify',
  windowMs: 10 * 60 * 1000,
  maxRequests: 20,
  message: 'Too many payment verification attempts. Please wait a moment.',
});

const PUBLIC_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function getAnonSupabase() {
  const url = process.env.VITE_SUPABASE_URL?.trim() || '';
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY?.trim() || '';
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function queueCustomerOrderEmailIfEnabled(
  admin: ReturnType<typeof getSupabaseAdmin>,
  customerEmail: string,
  orderNumber: string,
  status: StoreOrderStatus,
  grandTotal: number
): Promise<void> {
  if (!admin) return;
  const emailEnabled = await isModuleEnabledServer('email_notifications');
  if (!emailEnabled) return;

  const subjectMap: Partial<Record<StoreOrderStatus, string>> = {
    pending: `Order ${orderNumber} Received`,
    confirmed: `Order ${orderNumber} Confirmed`,
    packing: `Order ${orderNumber} is Being Packed`,
    out_for_delivery: `Order ${orderNumber} is Out for Delivery`,
    ready_for_pickup: `Order ${orderNumber} is Ready for Shop Pickup`,
    delivered: `Order ${orderNumber} Delivered`,
    picked_up: `Order ${orderNumber} Picked Up`,
    cancelled: `Order ${orderNumber} Cancelled`,
  };

  const title = subjectMap[status];
  if (!title) return;

  const text = `${title} — Total Rs ${grandTotal.toFixed(2)}. Thank you for shopping with us.`;
  const mailResult = await sendSmtpOrWebhookEmail(admin, {
    to: customerEmail,
    subject: title,
    text,
    entityType: 'store_order',
    entityId: orderNumber,
  });

  await admin.from('message_logs').insert({
    channel: 'email',
    recipient: customerEmail,
    template_key: `store_order_${status}`,
    rendered_body: text,
    status: mailResult.status,
    error_message: mailResult.errorMessage,
    entity_type: 'store_order',
    entity_id: orderNumber,
  });
}

function generateStoreOrderNumber(): string {
  const now = new Date();
  const y = String(now.getUTCFullYear()).slice(-2);
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `WEB-${y}${m}${d}-${rand}`;
}

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  password: z.string().min(8).max(128),
  phone: z.string().trim().max(30).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const orderLineInputSchema = z.object({
  itemId: UUID_SCHEMA,
  variantId: UUID_SCHEMA.nullable().optional(),
  mode: z.enum(['boxes', 'sqft', 'base']).default('base'),
  qty: z.number().positive(),
  wastagePct: z.number().min(0).max(50).optional(),
});

const checkoutSchema = z.object({
  fulfillmentType: z.enum(['delivery', 'pickup']),
  paymentMethod: z.enum(['cod', 'pay_on_pickup', 'razorpay']),
  deliveryAddress: z.string().trim().max(500).optional(),
  deliveryPincode: z.string().trim().max(16).optional(),
  deliveryArea: z.string().trim().max(120).optional(),
  couponCode: z.string().trim().max(40).optional(),
  customerNotes: z.string().trim().max(400).optional(),
  lines: z.array(orderLineInputSchema).min(1).max(60),
});

export function registerStorefrontRoutes(app: Express): void {
  // --------------------------------------------------------------------------
  // 1. Public Storefront Config & Media Streaming (Published Assets ONLY)
  // --------------------------------------------------------------------------
  app.get('/api/store/config', async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.json({
        onlineStoreEnabled: false,
        storeName: 'DecorBiz Showroom',
        pickupEnabled: true,
        codEnabled: true,
        razorpayEnabled: false,
        razorpayKeyId: null,
        banners: [],
        pages: [],
        zones: [],
        coupons: [],
      });
      return;
    }

    try {
      const onlineStoreEnabled = await isModuleEnabledServer('online_store');
      const [
        { data: biz },
        { data: storeInt },
        razorpayCfg,
        { data: banners },
        { data: pages },
        { data: zones },
        { data: coupons },
      ] = await Promise.all([
        admin.from('business').select('name, phone, email, address, logo_file_id').eq('id', 1).maybeSingle(),
        admin.from('integration_settings').select('enabled, config_public').eq('integration_key', 'online_store').maybeSingle(),
        getStoreRazorpayConfig(admin),
        onlineStoreEnabled
          ? admin.from('store_banners').select('*').eq('is_active', true).order('sort_order', { ascending: true })
          : Promise.resolve({ data: [] }),
        onlineStoreEnabled
          ? admin.from('store_pages').select('id, slug, title, content, is_published').eq('is_published', true).order('title')
          : Promise.resolve({ data: [] }),
        onlineStoreEnabled
          ? admin.from('store_delivery_zones').select('*').eq('is_active', true).order('zone_name')
          : Promise.resolve({ data: [] }),
        onlineStoreEnabled
          ? admin
              .from('store_coupons')
              .select('id, code, description, discount_type, discount_value, min_order_amount, max_discount, valid_until')
              .eq('is_active', true)
          : Promise.resolve({ data: [] }),
      ]);

      const storePub = (storeInt?.config_public || {}) as Record<string, unknown>;
      res.json({
        onlineStoreEnabled,
        storeName: biz?.name || 'DecorBiz Showroom',
        phone: biz?.phone || null,
        email: biz?.email || null,
        address: biz?.address || null,
        logoUrl: biz?.logo_file_id ? `/api/store/files/${biz.logo_file_id}` : null,
        pickupEnabled: storePub.pickup_enabled !== false && storePub.pickup_enabled !== 'false',
        codEnabled: storePub.cod_enabled !== false && storePub.cod_enabled !== 'false',
        razorpayEnabled: onlineStoreEnabled && razorpayCfg.enabled,
        razorpayKeyId: onlineStoreEnabled && razorpayCfg.enabled ? razorpayCfg.keyId : null,
        banners: banners || [],
        pages: pages || [],
        zones: zones || [],
        coupons: coupons || [],
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to load storefront configuration.',
      });
    }
  });

  app.get('/api/store/files/:id', async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(503).json({ error: 'Storage unavailable.' });
      return;
    }
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Invalid file id.' });
      return;
    }
    const fileId = parsedId.data;

    try {
      // Strictly verify the file is linked to a published store asset (never expose private ERP files)
      const [{ data: bizLogo }, { data: bannerMatch }, { data: pubPrimary }, { data: pubGallery }] =
        await Promise.all([
          admin.from('business').select('id').eq('id', 1).eq('logo_file_id', fileId).maybeSingle(),
          admin.from('store_banners').select('id').eq('image_file_id', fileId).eq('is_active', true).limit(1).maybeSingle(),
          admin
            .from('items')
            .select('id')
            .eq('primary_image_file_id', fileId)
            .eq('is_published_online', true)
            .eq('is_active', true)
            .limit(1)
            .maybeSingle(),
          admin
            .from('item_images')
            .select('item_id, items!inner(is_published_online, is_active)')
            .eq('file_id', fileId)
            .eq('items.is_published_online', true)
            .eq('items.is_active', true)
            .limit(1)
            .maybeSingle(),
        ]);

      if (!bizLogo && !bannerMatch && !pubPrimary && !pubGallery) {
        res.status(404).json({ error: 'Public storefront file not found.' });
        return;
      }

      const { data: fileRow } = await admin
        .from('files')
        .select('bucket, storage_path, mime_type, file_name')
        .eq('id', fileId)
        .maybeSingle();

      if (!fileRow) {
        res.status(404).json({ error: 'File metadata not found.' });
        return;
      }

      if (!PUBLIC_IMAGE_MIMES.has(fileRow.mime_type || '')) {
        res.status(403).json({ error: 'Unsupported public image asset type.' });
        return;
      }

      const { data: blobData, error: dlErr } = await admin.storage
        .from(fileRow.bucket)
        .download(fileRow.storage_path);
      if (dlErr || !blobData) {
        res.status(404).json({ error: 'File blob unavailable.' });
        return;
      }

      const buf = Buffer.from(await blobData.arrayBuffer());
      res.setHeader('Content-Type', fileRow.mime_type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(buf);
    } catch {
      res.status(404).json({ error: 'File unavailable.' });
    }
  });

  // --------------------------------------------------------------------------
  // 2. Catalogue & Product Detail Pages (Strictly Published + Active Items Only)
  // --------------------------------------------------------------------------
  app.get('/api/store/catalogue', async (_req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(503).json({ error: 'Store database not configured.' });
      return;
    }

    const enabled = await isModuleEnabledServer('online_store');
    if (!enabled) {
      res.json({ enabled: false, items: [] });
      return;
    }

    try {
      const [{ data: items, error }, { data: reviewRows }] = await Promise.all([
        admin.from('published_store_items_view').select('*').order('name', { ascending: true }),
        admin.from('product_reviews').select('item_id, rating').eq('status', 'approved'),
      ]);

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const ratingStats = new Map<string, { sum: number; count: number }>();
      for (const r of reviewRows || []) {
        const cur = ratingStats.get(r.item_id) || { sum: 0, count: 0 };
        cur.sum += Number(r.rating || 0);
        cur.count += 1;
        ratingStats.set(r.item_id, cur);
      }

      const enriched = ((items || []) as PublishedStoreItemRecord[]).map((it) => {
        const st = ratingStats.get(it.id);
        return {
          ...it,
          avg_rating: st ? roundHalfUp(st.sum / st.count, 1) : 0,
          review_count: st ? st.count : 0,
        };
      });

      res.json({ enabled: true, items: enriched });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to load storefront catalogue.',
      });
    }
  });

  app.get('/api/store/products/:slugOrId', async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(503).json({ error: 'Store database not configured.' });
      return;
    }
    const enabled = await isModuleEnabledServer('online_store');
    if (!enabled) {
      res.status(403).json({ error: 'Online Store is disabled.' });
      return;
    }

    const slugOrId = String(req.params.slugOrId || '').trim();
    if (!slugOrId) {
      res.status(400).json({ error: 'Product slug or ID required.' });
      return;
    }

    try {
      const isUuid = UUID_SCHEMA.safeParse(slugOrId).success;
      const query = admin.from('published_store_items_view').select('*');
      const { data: item } = isUuid
        ? await query.eq('id', slugOrId).maybeSingle()
        : await query.eq('online_slug', slugOrId).maybeSingle();

      if (!item) {
        res.status(404).json({ error: 'Product not found or not published online.' });
        return;
      }

      const { data: reviews } = await admin
        .from('product_reviews')
        .select('id, item_id, customer_id, customer_name, rating, title, comment, status, created_at')
        .eq('item_id', item.id)
        .eq('status', 'approved')
        .order('created_at', { ascending: false });

      res.json({ item, reviews: reviews || [] });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to load product.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 3. Separate Customer Auth (Registration, Verification, Login, Reset)
  // --------------------------------------------------------------------------
  app.post('/api/store/auth/register', storeAuthRegisterLimiter, requireOnlineStoreEnabled, async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    const anon = getAnonSupabase();
    if (!admin || !anon) {
      res.status(503).json({ error: 'Authentication service is not configured.' });
      return;
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration fields.' });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const { data: staffCheck } = await admin
      .from('profiles')
      .select('id')
      .ilike('email', email)
      .maybeSingle();
    if (staffCheck) {
      res.status(400).json({
        error: 'This email belongs to a staff ERP account. Please use a customer email address.',
      });
      return;
    }

    const origin = resolveRequestOrigin(req);
    const { data: signUpData, error: signUpErr } = await anon.auth.signUp({
      email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: origin,
        data: {
          full_name: parsed.data.fullName,
          user_type: 'customer',
          role: 'customer',
        },
      },
    });

    if (signUpErr || !signUpData.user) {
      res.status(400).json({ error: signUpErr?.message || 'Unable to register customer account.' });
      return;
    }

    // Stamp app_metadata.user_type = 'customer' server-side so ERP middleware can unconditionally reject customer JWTs
    await admin.auth.admin.updateUserById(signUpData.user.id, {
      app_metadata: { user_type: 'customer' },
      user_metadata: {
        full_name: parsed.data.fullName,
        user_type: 'customer',
        role: 'customer',
      },
    });

    const { data: customer, error: custErr } = await admin
      .from('customers')
      .upsert(
        {
          auth_user_id: signUpData.user.id,
          full_name: parsed.data.fullName,
          email,
          phone: parsed.data.phone || null,
          email_verified: Boolean(signUpData.user.email_confirmed_at),
          is_active: true,
        },
        { onConflict: 'auth_user_id' }
      )
      .select('*')
      .single();

    if (custErr) {
      res.status(400).json({ error: custErr.message });
      return;
    }

    res.status(201).json({
      requiresEmailVerification: !signUpData.session,
      session: signUpData.session || null,
      customer,
      message: signUpData.session
        ? 'Account created and signed in.'
        : 'Account created. Please check your email to verify your address before signing in.',
    });
  });

  app.post('/api/store/auth/login', storeAuthLoginLimiter, requireOnlineStoreEnabled, async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    const anon = getAnonSupabase();
    if (!admin || !anon) {
      res.status(503).json({ error: 'Authentication service is not configured.' });
      return;
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid email and password are required.' });
      return;
    }

    const { data: authData, error: authErr } = await anon.auth.signInWithPassword({
      email: parsed.data.email.toLowerCase(),
      password: parsed.data.password,
    });

    if (authErr || !authData.user || !authData.session) {
      res.status(401).json({ error: authErr?.message || 'Invalid email or password.' });
      return;
    }

    const { data: staffCheck } = await admin
      .from('profiles')
      .select('id')
      .eq('id', authData.user.id)
      .maybeSingle();
    if (staffCheck) {
      res.status(403).json({ error: 'Staff accounts cannot sign in to customer checkout.' });
      return;
    }

    let { data: customer } = await admin
      .from('customers')
      .select('*')
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();

    if (!customer) {
      const fullName =
        typeof authData.user.user_metadata?.full_name === 'string' && authData.user.user_metadata.full_name.trim()
          ? authData.user.user_metadata.full_name.trim()
          : (authData.user.email || 'Customer').split('@')[0];
      const { data: created } = await admin
        .from('customers')
        .insert({
          auth_user_id: authData.user.id,
          full_name: fullName,
          email: (authData.user.email || parsed.data.email).toLowerCase(),
          email_verified: Boolean(authData.user.email_confirmed_at),
        })
        .select('*')
        .single();
      customer = created;
    }

    if (!customer || !customer.is_active) {
      res.status(403).json({ error: 'Customer account is inactive.' });
      return;
    }

    if (authData.user.email_confirmed_at && !customer.email_verified) {
      await admin.from('customers').update({ email_verified: true }).eq('id', customer.id);
      customer.email_verified = true;
    }

    if (!customer.email_verified) {
      res.status(403).json({
        error: 'Please verify your email address before signing in.',
        requiresEmailVerification: true,
      });
      return;
    }

    res.json({ session: authData.session, customer });
  });

  app.post('/api/store/auth/resend-verification', storeAuthRecoveryLimiter, requireOnlineStoreEnabled, async (req: Request, res: Response) => {
    const anon = getAnonSupabase();
    if (!anon) {
      res.status(503).json({ error: 'Authentication service is not configured.' });
      return;
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }
    await anon.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: resolveRequestOrigin(req) },
    });
    res.json({ ok: true, message: 'Verification email sent if an unverified account exists.' });
  });

  app.post('/api/store/auth/forgot-password', storeAuthRecoveryLimiter, requireOnlineStoreEnabled, async (req: Request, res: Response) => {
    const anon = getAnonSupabase();
    if (!anon) {
      res.status(503).json({ error: 'Authentication service is not configured.' });
      return;
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) {
      res.status(400).json({ error: 'Email is required.' });
      return;
    }
    await anon.auth.resetPasswordForEmail(email, {
      redirectTo: resolveRequestOrigin(req),
    });
    res.json({
      ok: true,
      message: 'If a matching customer account exists, a password reset link has been emailed.',
    });
  });

  app.post('/api/store/auth/update-password', storeAuthRecoveryLimiter, requireOnlineStoreEnabled, async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(503).json({ error: 'Authentication service is not configured.' });
      return;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Valid recovery session token required.' });
      return;
    }
    const token = authHeader.slice('Bearer '.length).trim();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < 8 || password.length > 128) {
      res.status(400).json({ error: 'New password must be between 8 and 128 characters.' });
      return;
    }

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData.user) {
      res.status(401).json({ error: 'Password recovery link has expired. Please request a new reset email.' });
      return;
    }

    const { data: staffProfile } = await admin
      .from('profiles')
      .select('id')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (staffProfile) {
      res.status(403).json({ error: 'Staff passwords cannot be changed through the storefront portal.' });
      return;
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(userData.user.id, { password });
    if (updErr) {
      res.status(400).json({ error: updErr.message });
      return;
    }
    res.json({ ok: true, message: 'Password updated successfully. You can now sign in.' });
  });

  app.get('/api/store/auth/me', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    res.json({ customer: req.customer });
  });

  app.patch('/api/store/auth/me', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const admin = req.supabaseAdmin!;
    const fullName = typeof req.body?.full_name === 'string' ? req.body.full_name.trim() : req.customer!.full_name;
    if (!fullName) {
      res.status(400).json({ error: 'Full name cannot be empty.' });
      return;
    }
    const { data, error } = await admin
      .from('customers')
      .update({
        full_name: fullName,
        phone: typeof req.body?.phone === 'string' ? req.body.phone.trim() || null : req.customer!.phone,
        default_address:
          typeof req.body?.default_address === 'string'
            ? req.body.default_address.trim() || null
            : req.customer!.default_address,
        default_pincode:
          typeof req.body?.default_pincode === 'string'
            ? req.body.default_pincode.trim() || null
            : req.customer!.default_pincode,
      })
      .eq('id', req.customer!.id)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ customer: data });
  });

  // --------------------------------------------------------------------------
  // 4. Customer Wishlist & Reviews
  // --------------------------------------------------------------------------
  app.get('/api/store/wishlist', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const { data, error } = await req.supabaseAdmin!
      .from('customer_wishlists')
      .select('id, item_id, created_at')
      .eq('customer_id', req.customer!.id)
      .order('created_at', { ascending: false });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ wishlist: data || [] });
  });

  app.post('/api/store/wishlist', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.body?.itemId);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid itemId required.' });
      return;
    }
    const admin = req.supabaseAdmin!;
    const { data: pubItem } = await admin
      .from('published_store_items_view')
      .select('id')
      .eq('id', parsedId.data)
      .maybeSingle();
    if (!pubItem) {
      res.status(404).json({ error: 'Published product not found.' });
      return;
    }
    const { error } = await admin.from('customer_wishlists').upsert(
      { customer_id: req.customer!.id, item_id: parsedId.data },
      { onConflict: 'customer_id,item_id' }
    );
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ ok: true });
  });

  app.delete('/api/store/wishlist/:itemId', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.itemId);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid itemId required.' });
      return;
    }
    await req.supabaseAdmin!
      .from('customer_wishlists')
      .delete()
      .eq('customer_id', req.customer!.id)
      .eq('item_id', parsedId.data);
    res.json({ ok: true });
  });

  app.post('/api/store/products/:itemId/reviews', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.itemId);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid itemId required.' });
      return;
    }
    const rating = Number(req.body?.rating);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() || null : null;
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
      return;
    }
    if (comment.length < 3 || comment.length > 1000) {
      res.status(400).json({ error: 'Review comment must be between 3 and 1000 characters.' });
      return;
    }

    const admin = req.supabaseAdmin!;
    const { data: pubItem } = await admin
      .from('published_store_items_view')
      .select('id')
      .eq('id', parsedId.data)
      .maybeSingle();
    if (!pubItem) {
      res.status(404).json({ error: 'Published product not found.' });
      return;
    }

    const { data: review, error } = await admin
      .from('product_reviews')
      .upsert(
        {
          item_id: parsedId.data,
          customer_id: req.customer!.id,
          customer_name: req.customer!.full_name,
          rating,
          title,
          comment,
          status: 'pending',
        },
        { onConflict: 'item_id,customer_id' }
      )
      .select('*')
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({
      review,
      message: 'Review submitted for store moderation.',
    });
  });

  // --------------------------------------------------------------------------
  // 5. Checkout, Delivery Zones, Coupons, Orders & Razorpay Verification
  // --------------------------------------------------------------------------
  app.post('/api/store/orders', storeCheckoutLimiter, requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid checkout payload.' });
      return;
    }
    const input = parsed.data;
    const admin = req.supabaseAdmin!;

    try {
      const [{ data: storeInt }, razorpayCfg, { data: zones }] = await Promise.all([
        admin.from('integration_settings').select('config_public').eq('integration_key', 'online_store').maybeSingle(),
        getStoreRazorpayConfig(admin),
        admin.from('store_delivery_zones').select('*').eq('is_active', true),
      ]);

      const storePub = (storeInt?.config_public || {}) as Record<string, unknown>;
      const pickupEnabled = storePub.pickup_enabled !== false && storePub.pickup_enabled !== 'false';
      const codEnabled = storePub.cod_enabled !== false && storePub.cod_enabled !== 'false';

      if (input.paymentMethod === 'cod') {
        if (!codEnabled) {
          res.status(403).json({ error: 'Cash on Delivery is currently disabled.' });
          return;
        }
        if (input.fulfillmentType !== 'delivery') {
          res.status(400).json({ error: 'Cash on Delivery requires local delivery fulfillment.' });
          return;
        }
      }
      if (input.paymentMethod === 'pay_on_pickup') {
        if (!pickupEnabled) {
          res.status(403).json({ error: 'Shop pickup is currently disabled.' });
          return;
        }
        if (input.fulfillmentType !== 'pickup') {
          res.status(400).json({ error: 'Pay on Pickup requires Shop Pickup fulfillment.' });
          return;
        }
      }
      if (input.paymentMethod === 'razorpay' && !razorpayCfg.enabled) {
        res.status(403).json({ error: 'Razorpay online payments are not enabled or configured.' });
        return;
      }

      if (input.fulfillmentType === 'delivery' && (!input.deliveryAddress || input.deliveryAddress.length < 6)) {
        res.status(400).json({ error: 'Complete delivery street address is required.' });
        return;
      }

      const itemIds = Array.from(new Set(input.lines.map((l) => l.itemId)));
      const { data: pubItems, error: itemsErr } = await admin
        .from('published_store_items_view')
        .select('*')
        .in('id', itemIds);
      if (itemsErr) throw itemsErr;

      const pubMap = new Map<string, PublishedStoreItemRecord>(
        ((pubItems || []) as PublishedStoreItemRecord[]).map((p) => [p.id, p])
      );

      const resolvedLines: Array<{
        item_id: string;
        variant_id: string | null;
        item_name: string;
        variant_name: string | null;
        sku: string | null;
        ordered_unit: string;
        ordered_qty: number;
        base_qty: number;
        unit_price: number;
        line_total: number;
        wastage_pct: number;
      }> = [];

      for (const l of input.lines) {
        const pubItem = pubMap.get(l.itemId);
        if (!pubItem) {
          res.status(404).json({ error: 'One or more cart items are unpublished or unavailable.' });
          return;
        }

        const variant = l.variantId
          ? (pubItem.variants || []).find((v) => v.id === l.variantId) || null
          : null;
        if (l.variantId && !variant) {
          res.status(400).json({ error: `Selected option for "${pubItem.name}" is unavailable.` });
          return;
        }

        const sqftPerBox =
          pubItem.specs && typeof (pubItem.specs as Record<string, unknown>).sqft_per_box === 'number'
            ? Number((pubItem.specs as Record<string, unknown>).sqft_per_box)
            : null;

        const qtyCalc = computeTileOrderQty({
          mode: l.mode,
          inputQty: l.qty,
          sqftPerBox,
          wastagePct: l.wastagePct,
        });

        const available = variant ? Number(variant.available_qty) : Number(pubItem.available_qty);
        if (pubItem.item_type === 'goods' && !pubItem.allow_negative_stock && available < qtyCalc.baseQty) {
          res.status(400).json({
            error: `Insufficient available stock for "${pubItem.name}". Available: ${available}, Requested: ${qtyCalc.baseQty}.`,
          });
          return;
        }

        const unitPrice = roundHalfUp(
          Number(variant ? variant.selling_price : pubItem.effective_price),
          2
        );
        const lineTotal = roundHalfUp(unitPrice * qtyCalc.baseQty, 2);

        resolvedLines.push({
          item_id: pubItem.id,
          variant_id: variant ? variant.id : null,
          item_name: pubItem.name,
          variant_name: variant ? variant.variant_name : null,
          sku: (variant && variant.sku) || pubItem.sku || null,
          ordered_unit: qtyCalc.orderedUnit,
          ordered_qty: qtyCalc.orderedQty,
          base_qty: qtyCalc.baseQty,
          unit_price: unitPrice,
          line_total: lineTotal,
          wastage_pct: Number(l.wastagePct || 0),
        });
      }

      const matchedZone =
        input.fulfillmentType === 'delivery'
          ? matchDeliveryZone((zones || []) as StoreDeliveryZoneRecord[], {
              pincode: input.deliveryPincode,
              area: input.deliveryArea || input.deliveryAddress,
            })
          : null;

      let matchedCoupon: StoreCouponRecord | null = null;
      if (input.couponCode && input.couponCode.trim()) {
        const { data: couponRow } = await admin
          .from('store_coupons')
          .select('*')
          .ilike('code', input.couponCode.trim())
          .maybeSingle();
        if (!couponRow) {
          res.status(400).json({ error: `Coupon "${input.couponCode.trim()}" was not found.` });
          return;
        }
        matchedCoupon = couponRow as StoreCouponRecord;
      }

      const pricing = computeStoreOrderTotals({
        lines: resolvedLines.map((rl) => ({ unitPrice: rl.unit_price, baseQty: rl.base_qty })),
        fulfillmentType: input.fulfillmentType,
        zone: matchedZone,
        coupon: matchedCoupon,
      });

      if (pricing.errors.length > 0) {
        res.status(400).json({ error: pricing.errors[0] });
        return;
      }

      const orderNumber = generateStoreOrderNumber();
      let razorpayOrderPayload: { id: string; amount: number; currency: string; keyId: string } | null = null;

      if (input.paymentMethod === 'razorpay') {
        const rpOrder = await createRazorpayRemoteOrder({
          keyId: razorpayCfg.keyId!,
          keySecret: razorpayCfg.keySecret!,
          amountPaise: Math.round(pricing.grandTotal * 100),
          receipt: orderNumber,
          notes: {
            customer_id: req.customer!.id,
            customer_email: req.customer!.email,
          },
        });
        razorpayOrderPayload = {
          id: rpOrder.id,
          amount: rpOrder.amount,
          currency: rpOrder.currency,
          keyId: razorpayCfg.keyId!,
        };
      }

      const { data: createdOrder, error: orderErr } = await admin
        .from('store_orders')
        .insert({
          order_number: orderNumber,
          customer_id: req.customer!.id,
          customer_name: req.customer!.full_name,
          customer_email: req.customer!.email,
          customer_phone: req.customer!.phone,
          status: 'pending',
          fulfillment_type: input.fulfillmentType,
          zone_id: matchedZone?.id || null,
          delivery_address: input.fulfillmentType === 'delivery' ? input.deliveryAddress || null : null,
          delivery_pincode: input.fulfillmentType === 'delivery' ? input.deliveryPincode || null : null,
          delivery_area: input.fulfillmentType === 'delivery' ? input.deliveryArea || null : null,
          coupon_code: pricing.couponApplied,
          subtotal: pricing.subtotal,
          discount_amount: pricing.discountAmount,
          delivery_charge: pricing.deliveryCharge,
          grand_total: pricing.grandTotal,
          payment_method: input.paymentMethod,
          payment_status: input.paymentMethod === 'razorpay' ? 'pending' : 'unpaid',
          razorpay_order_id: razorpayOrderPayload?.id || null,
          stock_state: 'none',
          customer_notes: input.customerNotes || null,
        })
        .select('*')
        .single();

      if (orderErr || !createdOrder) {
        throw new Error(orderErr?.message || 'Unable to save order.');
      }

      const { error: lineErr } = await admin.from('store_order_lines').insert(
        resolvedLines.map((rl) => ({
          order_id: createdOrder.id,
          ...rl,
        }))
      );
      if (lineErr) {
        await admin.from('store_orders').delete().eq('id', createdOrder.id);
        throw new Error(lineErr.message);
      }

      if (matchedCoupon && pricing.couponApplied) {
        await admin
          .from('store_coupons')
          .update({ used_count: Number(matchedCoupon.used_count || 0) + 1 })
          .eq('id', matchedCoupon.id);
      }

      await queueCustomerOrderEmailIfEnabled(
        admin,
        req.customer!.email,
        createdOrder.order_number,
        'pending',
        pricing.grandTotal
      );

      res.status(201).json({
        order: { ...createdOrder, lines: resolvedLines },
        razorpay: razorpayOrderPayload,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to place order.',
      });
    }
  });

  app.post('/api/store/orders/:id/verify-razorpay', storePaymentVerifyLimiter, requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid order ID is required.' });
      return;
    }

    const razorpayOrderId = String(req.body?.razorpay_order_id || '').trim();
    const razorpayPaymentId = String(req.body?.razorpay_payment_id || '').trim();
    const razorpaySignature = String(req.body?.razorpay_signature || '').trim();

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      res.status(400).json({ error: 'Missing Razorpay payment verification parameters.' });
      return;
    }

    const admin = req.supabaseAdmin!;
    try {
      // Customer isolation check: order MUST belong to req.customer.id
      const { data: order } = await admin
        .from('store_orders')
        .select('*')
        .eq('id', parsedId.data)
        .eq('customer_id', req.customer!.id)
        .maybeSingle();

      if (!order) {
        res.status(404).json({ error: 'Order not found.' });
        return;
      }

      if (order.payment_method !== 'razorpay') {
        res.status(400).json({ error: 'Order does not use Razorpay payment.' });
        return;
      }

      if (!order.razorpay_order_id || order.razorpay_order_id !== razorpayOrderId) {
        res.status(400).json({ error: 'Razorpay order ID mismatch.' });
        return;
      }

      const razorpayCfg = await getStoreRazorpayConfig(admin);
      if (!razorpayCfg.enabled || !razorpayCfg.keySecret) {
        res.status(403).json({ error: 'Razorpay gateway is not active.' });
        return;
      }

      const signatureOk = verifyRazorpaySignature({
        orderId: order.razorpay_order_id,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature,
        keySecret: razorpayCfg.keySecret,
      });

      if (!signatureOk) {
        await admin
          .from('store_orders')
          .update({ payment_status: 'failed' })
          .eq('id', order.id);
        res.status(400).json({ error: 'Razorpay signature verification failed.' });
        return;
      }

      await admin
        .from('store_orders')
        .update({
          payment_status: 'paid',
          razorpay_payment_id: razorpayPaymentId,
          razorpay_signature: razorpaySignature,
        })
        .eq('id', order.id);

      const { data: confirmedOrder, error: rpcErr } = await admin.rpc(
        'store_transition_order_stock',
        {
          p_order_id: order.id,
          p_target_status: 'confirmed',
        }
      );

      if (rpcErr) {
        res.status(400).json({ error: rpcErr.message });
        return;
      }

      await queueCustomerOrderEmailIfEnabled(
        admin,
        req.customer!.email,
        order.order_number,
        'confirmed',
        Number(order.grand_total)
      );

      res.json({ verified: true, order: confirmedOrder });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Payment verification failed.',
      });
    }
  });

  app.get('/api/store/orders', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const admin = req.supabaseAdmin!;
    const { data: orders, error } = await admin
      .from('store_orders')
      .select('*, store_order_lines(*)')
      .eq('customer_id', req.customer!.id)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const mapped = (orders || []).map((o) => {
      const { store_order_lines, ...rest } = o as Record<string, unknown>;
      return { ...rest, lines: store_order_lines || [] };
    });

    res.json({ orders: mapped });
  });

  app.get('/api/store/orders/:id', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid order ID required.' });
      return;
    }

    const { data: order } = await req.supabaseAdmin!
      .from('store_orders')
      .select('*, store_order_lines(*)')
      .eq('id', parsedId.data)
      .eq('customer_id', req.customer!.id)
      .maybeSingle();

    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    const { store_order_lines, ...rest } = order as Record<string, unknown>;
    res.json({ order: { ...rest, lines: store_order_lines || [] } });
  });

  app.post('/api/store/orders/:id/cancel', requireOnlineStoreEnabled, requireCustomerAuth, async (req: CustomerAuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid order ID required.' });
      return;
    }

    const admin = req.supabaseAdmin!;
    const { data: order } = await admin
      .from('store_orders')
      .select('*')
      .eq('id', parsedId.data)
      .eq('customer_id', req.customer!.id)
      .maybeSingle();

    if (!order) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }

    if (!['pending', 'confirmed'].includes(order.status)) {
      res.status(400).json({ error: 'Only pending or confirmed orders can be cancelled.' });
      return;
    }

    const { data: updated, error: rpcErr } = await admin.rpc('store_transition_order_stock', {
      p_order_id: order.id,
      p_target_status: 'cancelled',
    });

    if (rpcErr) {
      res.status(400).json({ error: rpcErr.message });
      return;
    }

    await queueCustomerOrderEmailIfEnabled(
      admin,
      req.customer!.email,
      order.order_number,
      'cancelled',
      Number(order.grand_total)
    );

    res.json({ order: updated });
  });
}
