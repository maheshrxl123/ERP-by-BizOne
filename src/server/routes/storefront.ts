import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
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
  writeAudit,
} from '../middleware.ts';
import { sendSmtpOrWebhookEmail } from '../mailer.ts';
import {
  createRazorpayRemoteOrder,
  getStoreRazorpayConfig,
  verifyRazorpaySignature,
} from '../storePayments.ts';
import {
  GeminiSchemaType,
  callAiStructuredJson,
  redactSecretsFromText,
  sanitizeUntrustedText,
} from '../aiGateway.ts';
import { enforceDailyAiBudget, resolveActiveAiCredential } from './ai.ts';
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

const storeAiChatLimiter = createRateLimiter({
  name: 'store-ai-chat',
  windowMs: 60 * 1000,
  maxRequests: 25,
  message: 'Too many shopping assistant messages. Please wait a moment.',
});

const PUBLIC_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function asyncHandler<TReq extends Request = Request>(
  fn: (req: TReq, res: Response, next: NextFunction) => Promise<void> | void
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as TReq, res, next)).catch(next);
  };
}

function sendWithEtag(
  req: Request,
  res: Response,
  body: unknown,
  cacheControl: string
): void {
  const json = JSON.stringify(body);
  const etag = `"${crypto.createHash('sha1').update(json).digest('hex')}"`;
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.type('application/json').send(json);
}

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
  app.get('/api/store/health', asyncHandler(async (_req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(200).json({
        ok: true,
        service: 'storefront',
        supabaseConfigured: false,
        onlineStoreEnabled: false,
      });
      return;
    }

    try {
      const onlineStoreEnabled = await isModuleEnabledServer('online_store');
      res.status(200).json({
        ok: true,
        service: 'storefront',
        supabaseConfigured: true,
        onlineStoreEnabled,
      });
    } catch {
      res.status(200).json({
        ok: false,
        service: 'storefront',
        supabaseConfigured: true,
        onlineStoreEnabled: false,
      });
    }
  }));

  // --------------------------------------------------------------------------
  // 1. Public Storefront Config & Media Streaming (Published Assets ONLY)
  // --------------------------------------------------------------------------
  app.get('/api/store/config', asyncHandler(async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    const cacheControl = 'public, max-age=30, stale-while-revalidate=60';
    if (!admin) {
      sendWithEtag(req, res, {
        onlineStoreEnabled: false,
        aiAssistantEnabled: false,
        gstRegistered: false,
        storeName: 'RV Tiles & Decor',
        pickupEnabled: true,
        codEnabled: true,
        razorpayEnabled: false,
        razorpayKeyId: null,
        banners: [],
        pages: [],
        zones: [],
        coupons: [],
      }, cacheControl);
      return;
    }

    try {
      const onlineStoreEnabled = await isModuleEnabledServer('online_store');
      const aiAssistantPromise = (async () => {
        if (!onlineStoreEnabled) return false;
        const aiModEnabled = await isModuleEnabledServer('ai');
        if (!aiModEnabled) return false;
        try {
          await resolveActiveAiCredential(admin, 'chat');
          return true;
        } catch {
          return false;
        }
      })();

      const [
        aiAssistantEnabled,
        { data: biz },
        { data: storeInt },
        razorpayCfg,
        { data: banners },
        { data: pages },
        { data: zones },
        { data: coupons },
      ] = await Promise.all([
        aiAssistantPromise,
        admin.from('business').select('name, phone, email, address, logo_file_id, gst_registered').eq('id', 1).maybeSingle(),
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
              .select('id, code, description, discount_type, discount_value, min_order_amount, max_discount, valid_until, usage_limit, used_count, is_active')
              .eq('is_active', true)
          : Promise.resolve({ data: [] }),
      ]);

      const todayStr = new Date().toISOString().slice(0, 10);
      const activeCoupons = (coupons || [])
        .filter((c) => {
          if (c.valid_until && String(c.valid_until) < todayStr) return false;
          if (
            c.usage_limit !== null &&
            c.usage_limit !== undefined &&
            Number(c.used_count || 0) >= Number(c.usage_limit)
          ) {
            return false;
          }
          return true;
        })
        .map(({ usage_limit: _ul, used_count: _uc, ...rest }) => rest);

      const storePub = (storeInt?.config_public || {}) as Record<string, unknown>;
      sendWithEtag(
        req,
        res,
        {
          onlineStoreEnabled,
          aiAssistantEnabled,
          gstRegistered: Boolean(biz?.gst_registered),
          storeName: biz?.name || 'RV Tiles & Decor',
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
          coupons: activeCoupons,
        },
        cacheControl
      );
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to load storefront configuration.',
      });
    }
  }));

  app.get('/api/store/files/:id', requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
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
      const etag = `"${crypto.createHash('sha1').update(buf).digest('hex')}"`;
      res.setHeader('Content-Type', fileRow.mime_type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.send(buf);
    } catch {
      res.status(404).json({ error: 'File unavailable.' });
    }
  }));

  // --------------------------------------------------------------------------
  // 2. Catalogue & Product Detail Pages (Strictly Published + Active Items Only)
  // --------------------------------------------------------------------------
  app.get('/api/store/catalogue', asyncHandler(async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(503).json({ error: 'Store database not configured.' });
      return;
    }

    const enabled = await isModuleEnabledServer('online_store');
    if (!enabled) {
      res.status(403).json({
        error: 'Online Store is disabled.',
        moduleKey: 'online_store',
        enabled: false,
        items: [],
      });
      return;
    }

    try {
      const hasLimit = req.query.limit !== undefined;
      const hasOffset = req.query.offset !== undefined;
      const limit = hasLimit
        ? Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit), 10) || 50))
        : null;
      const offset = hasOffset || hasLimit
        ? Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0)
        : 0;

      let itemsQuery = admin
        .from('published_store_items_view')
        .select('*', limit !== null ? { count: 'exact' } : undefined)
        .order('name', { ascending: true });

      if (limit !== null) {
        itemsQuery = itemsQuery.range(offset, offset + limit - 1);
      }

      const { data: items, error, count } = await itemsQuery;

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const itemList = (items || []) as PublishedStoreItemRecord[];
      const itemIds = itemList.map((it) => it.id);
      const { data: reviewRows } =
        itemIds.length > 0
          ? await admin
              .from('product_reviews')
              .select('item_id, rating')
              .eq('status', 'approved')
              .in('item_id', itemIds)
          : { data: [] };

      const ratingStats = new Map<string, { sum: number; count: number }>();
      for (const r of reviewRows || []) {
        const cur = ratingStats.get(r.item_id) || { sum: 0, count: 0 };
        cur.sum += Number(r.rating || 0);
        cur.count += 1;
        ratingStats.set(r.item_id, cur);
      }

      const enriched = itemList.map((it) => {
        const st = ratingStats.get(it.id);
        return {
          ...it,
          avg_rating: st ? roundHalfUp(st.sum / st.count, 1) : 0,
          review_count: st ? st.count : 0,
        };
      });

      const total = typeof count === 'number' ? count : enriched.length;
      sendWithEtag(
        req,
        res,
        {
          enabled: true,
          items: enriched,
          total,
          ...(limit !== null ? { limit, offset } : {}),
        },
        'public, max-age=30, stale-while-revalidate=60'
      );
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to load storefront catalogue.',
      });
    }
  }));

  app.get('/api/store/products/:slugOrId', asyncHandler(async (req: Request, res: Response) => {
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
  }));

  // --------------------------------------------------------------------------
  // 3. Separate Customer Auth (Registration, Verification, Login, Reset)
  // --------------------------------------------------------------------------
  app.post('/api/store/auth/register', storeAuthRegisterLimiter, requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
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
  }));

  app.post('/api/store/auth/login', storeAuthLoginLimiter, requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
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
  }));

  app.post('/api/store/auth/resend-verification', storeAuthRecoveryLimiter, requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
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
  }));

  app.post('/api/store/auth/forgot-password', storeAuthRecoveryLimiter, requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
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
  }));

  app.post('/api/store/auth/update-password', storeAuthRecoveryLimiter, requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
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
  }));

  app.get('/api/store/auth/me', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
    res.json({ customer: req.customer });
  }));

  app.patch('/api/store/auth/me', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  // --------------------------------------------------------------------------
  // 4. Customer Wishlist & Reviews
  // --------------------------------------------------------------------------
  app.get('/api/store/wishlist', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  app.post('/api/store/wishlist', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  app.delete('/api/store/wishlist/:itemId', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  app.post('/api/store/products/:itemId/reviews', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  // --------------------------------------------------------------------------
  // 5. Checkout, Delivery Zones, Coupons, Orders & Razorpay Verification
  // --------------------------------------------------------------------------
  app.post('/api/store/orders', storeCheckoutLimiter, requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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

        const rawSqftPerBox = Number(
          (pubItem.specs as Record<string, unknown> | null)?.sqft_per_box ?? 0
        );
        const sqftPerBox =
          Number.isFinite(rawSqftPerBox) && rawSqftPerBox > 0 ? rawSqftPerBox : null;

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

      if (matchedCoupon && pricing.couponApplied && input.paymentMethod !== 'razorpay') {
        const expectedCount = Number(matchedCoupon.used_count || 0);
        const { data: bumped } = await admin
          .from('store_coupons')
          .update({ used_count: expectedCount + 1 })
          .eq('id', matchedCoupon.id)
          .eq('used_count', expectedCount)
          .select('id')
          .maybeSingle();
        if (!bumped && matchedCoupon.usage_limit != null && expectedCount + 1 >= Number(matchedCoupon.usage_limit)) {
          await admin.from('store_order_lines').delete().eq('order_id', createdOrder.id);
          await admin.from('store_orders').delete().eq('id', createdOrder.id);
          res.status(409).json({ error: `Coupon "${matchedCoupon.code}" usage limit was just reached.` });
          return;
        }
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
  }));

  app.post('/api/store/orders/:id/verify-razorpay', storePaymentVerifyLimiter, requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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

      if (order.payment_status === 'paid' && order.razorpay_payment_id === razorpayPaymentId && order.status !== 'pending') {
        res.json({ verified: true, order });
        return;
      }

      const wasAlreadyPaid = order.payment_status === 'paid';

      await admin
        .from('store_orders')
        .update({
          payment_status: 'paid',
          razorpay_payment_id: razorpayPaymentId,
          razorpay_signature: razorpaySignature,
        })
        .eq('id', order.id);

      if (!wasAlreadyPaid && order.coupon_code) {
        const { data: couponRow } = await admin
          .from('store_coupons')
          .select('id, used_count, usage_limit')
          .ilike('code', String(order.coupon_code))
          .maybeSingle();
        if (couponRow) {
          const currentCount = Number(couponRow.used_count || 0);
          const usageLimit =
            couponRow.usage_limit !== null && couponRow.usage_limit !== undefined
              ? Number(couponRow.usage_limit)
              : null;
          if (usageLimit === null || currentCount < usageLimit) {
            await admin
              .from('store_coupons')
              .update({ used_count: currentCount + 1 })
              .eq('id', couponRow.id)
              .eq('used_count', currentCount);
          }
        }
      }

      const { data: confirmedOrder, error: rpcErr } = await admin.rpc(
        'store_transition_order_stock',
        {
          p_order_id: order.id,
          p_target_status: 'confirmed',
        }
      );

      if (rpcErr) {
        const conflictNote = `Paid Razorpay ${razorpayPaymentId}, stock allocation conflict: ${rpcErr.message}`;
        await admin
          .from('store_orders')
          .update({ internal_notes: conflictNote })
          .eq('id', order.id);
        await writeAudit(
          null,
          req.customer?.email || null,
          'store.payment_stock_conflict',
          'store_order',
          order.id,
          {
            order_number: order.order_number,
            razorpay_payment_id: razorpayPaymentId,
            error: rpcErr.message,
          }
        );
        res.status(409).json({
          error: `Payment ${razorpayPaymentId} succeeded for order ${order.order_number}, but available stock changed during checkout. Please contact showroom support with your order number and payment ID.`,
          paymentRecorded: true,
        });
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
  }));

  app.get('/api/store/orders', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  app.get('/api/store/orders/:id', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  app.post('/api/store/orders/:id/cancel', requireOnlineStoreEnabled, requireCustomerAuth, asyncHandler<CustomerAuthenticatedRequest>(async (req, res: Response) => {
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
  }));

  const guestLookupLimiter = createRateLimiter({
    name: 'store-order-lookup',
    windowMs: 5 * 60 * 1000,
    maxRequests: 20,
    message: 'Too many order lookup attempts. Please wait a few minutes.',
  });

  app.post('/api/store/orders/lookup', guestLookupLimiter, requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(503).json({ error: 'Store database not configured.' });
      return;
    }
    const orderNumber = typeof req.body?.orderNumber === 'string' ? req.body.orderNumber.trim().toUpperCase() : '';
    const phoneDigits = typeof req.body?.phone === 'string' ? req.body.phone.replace(/\D/g, '') : '';
    if (!orderNumber || phoneDigits.length < 6) {
      res.status(400).json({ error: 'Enter your Order # and at least the last 6 digits of your mobile number.' });
      return;
    }

    const { data: order, error } = await admin
      .from('store_orders')
      .select('order_number, status, fulfillment_type, delivery_area, delivery_pincode, payment_method, payment_status, subtotal, discount_amount, delivery_charge, grand_total, created_at, customer_id, customer_phone, store_order_lines(id, item_name, variant_name, base_qty, ordered_unit, ordered_qty, line_total)')
      .ilike('order_number', orderNumber)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Unable to look up order right now.' });
      return;
    }
    let storedDigits = String(order?.customer_phone || '').replace(/\D/g, '');
    if (order && !storedDigits && order.customer_id) {
      const { data: custRow } = await admin
        .from('customers')
        .select('phone')
        .eq('id', order.customer_id)
        .maybeSingle();
      storedDigits = String(custRow?.phone || '').replace(/\D/g, '');
    }
    if (!order || !storedDigits || (storedDigits !== phoneDigits && !storedDigits.endsWith(phoneDigits.slice(-10)))) {
      res.status(404).json({ error: 'No matching order found for that Order # and phone number.' });
      return;
    }

    const { customer_phone: _phone, store_order_lines, ...safeOrder } = order as Record<string, unknown>;
    res.json({
      order: {
        ...safeOrder,
        lines: store_order_lines || [],
      },
    });
  }));

  // --------------------------------------------------------------------------
  // 8. Customer-Facing Online Store AI Shopping Assistant (Public Safe Read)
  // --------------------------------------------------------------------------
  const storeAiChatSchema = z.object({
    message: z.string().trim().min(1, 'Please enter a message.').max(1000),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().trim().min(1).max(1200),
        })
      )
      .max(10)
      .optional()
      .default([]),
  });

  app.post('/api/store/ai/chat', storeAiChatLimiter, requireOnlineStoreEnabled, asyncHandler(async (req: Request, res: Response) => {
    const admin = getSupabaseAdmin();
    if (!admin) {
      res.status(503).json({ error: 'Store database not configured.' });
      return;
    }

    const aiEnabled = await isModuleEnabledServer('ai');
    if (!aiEnabled) {
      res.status(403).json({ error: 'Online Store AI Assistant is currently disabled.' });
      return;
    }

    const parsed = storeAiChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid chat request.' });
      return;
    }

    try {
      const cred = await resolveActiveAiCredential(admin, 'chat');
      await enforceDailyAiBudget(admin, cred.dailyTokenLimit);

      const [
        { data: publishedItems },
        { data: activeBanners },
        { data: publishedPages },
        { data: activeZones },
        { data: activeCoupons },
        { data: biz },
      ] = await Promise.all([
        admin
          .from('published_store_items_view')
          .select(
            'id, name, online_slug, product_line, item_type, effective_price, mrp, base_unit_code, available_qty, in_stock, primary_image_file_id, online_description, specs'
          )
          .order('name', { ascending: true })
          .limit(80),
        admin
          .from('store_banners')
          .select('title, subtitle, cta_label')
          .eq('is_active', true)
          .order('sort_order', { ascending: true })
          .limit(6),
        admin
          .from('store_pages')
          .select('slug, title, content')
          .eq('is_published', true)
          .order('title', { ascending: true })
          .limit(15),
        admin
          .from('store_delivery_zones')
          .select('zone_name, pincodes, delivery_charge, min_order_amount, estimated_days')
          .eq('is_active', true)
          .order('zone_name', { ascending: true })
          .limit(20),
        admin
          .from('store_coupons')
          .select('code, description, discount_type, discount_value, min_order_amount')
          .eq('is_active', true)
          .limit(10),
        admin
          .from('business')
          .select('name, phone, email, address')
          .eq('id', 1)
          .maybeSingle(),
      ]);

      const safeItems = (publishedItems || []) as Array<Record<string, unknown>>;
      const safePages = (publishedPages || []) as Array<{ slug: string; title: string; content?: string }>;

      // Optional area extraction for helpful tile box calculation context
      const userMsg = parsed.data.message;
      let detectedAreaSqFt: number | null = null;
      const dimMatch = userMsg.match(/(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)/i);
      const areaMatch = userMsg.match(/(\d+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|square\s*feet)/i);
      if (dimMatch) {
        const w = Number(dimMatch[1]);
        const h = Number(dimMatch[2]);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w * h <= 100000) {
          detectedAreaSqFt = roundHalfUp(w * h, 2);
        }
      } else if (areaMatch) {
        const sq = Number(areaMatch[1]);
        if (Number.isFinite(sq) && sq > 0 && sq <= 100000) {
          detectedAreaSqFt = roundHalfUp(sq, 2);
        }
      }

      const catalogueContext = safeItems.map((it) => {
        const specsObj = it.specs && typeof it.specs === 'object' ? (it.specs as Record<string, unknown>) : null;
        const rawSqft = Number(specsObj?.sqft_per_box || 0);
        const sqftPerBox = Number.isFinite(rawSqft) && rawSqft > 0 ? rawSqft : null;
        const estimatedBoxesWith10Pct =
          detectedAreaSqFt && sqftPerBox
            ? Math.ceil((detectedAreaSqFt * 1.1) / sqftPerBox)
            : null;
        return {
          slug: String(it.online_slug || ''),
          name: sanitizeUntrustedText(String(it.name || '')),
          line: String(it.product_line || ''),
          type: String(it.item_type || 'goods'),
          price_inr: Number(it.effective_price || 0),
          mrp_inr: it.mrp != null ? Number(it.mrp) : null,
          unit: String(it.base_unit_code || 'PCS'),
          sqft_per_box: sqftPerBox,
          estimated_boxes_needed_for_user_area_incl_10pct_wastage: estimatedBoxesWith10Pct,
          in_stock: Boolean(it.in_stock),
          available_qty: Number(it.available_qty || 0),
          specs: specsObj,
          description: sanitizeUntrustedText(String(it.online_description || '')).slice(0, 260),
        };
      });

      const storeContext = {
        store_name: sanitizeUntrustedText(String(biz?.name || 'RV Tiles & Decor')),
        phone: biz?.phone || null,
        address: sanitizeUntrustedText(String(biz?.address || '')),
        detected_user_area_sqft: detectedAreaSqFt,
        active_promotions: (activeBanners || []).map((b) => ({
          title: sanitizeUntrustedText(String(b.title || '')),
          subtitle: sanitizeUntrustedText(String(b.subtitle || '')),
        })),
        active_coupons: (activeCoupons || []).map((c) => ({
          code: c.code,
          description: sanitizeUntrustedText(String(c.description || '')),
          discount_type: c.discount_type,
          discount_value: Number(c.discount_value || 0),
          min_order_amount: Number(c.min_order_amount || 0),
        })),
        delivery_zones: (activeZones || []).map((z) => ({
          zone_name: sanitizeUntrustedText(String(z.zone_name || '')),
          pincodes: Array.isArray(z.pincodes) ? z.pincodes.slice(0, 10) : [],
          delivery_charge_inr: Number(z.delivery_charge || 0),
          min_order_inr: Number(z.min_order_amount || 0),
          estimated_days: Number(z.estimated_days || 1),
        })),
        published_pages: safePages.map((p) => ({
          slug: p.slug,
          title: sanitizeUntrustedText(String(p.title || '')),
          excerpt: sanitizeUntrustedText(String(p.content || '')).slice(0, 320),
        })),
        catalogue: catalogueContext,
      };

      const historyText = parsed.data.history
        .map((h) => `${h.role === 'user' ? 'Customer' : 'Assistant'}: ${sanitizeUntrustedText(h.content)}`)
        .join('\n');

      const responseSchema = {
        type: GeminiSchemaType.OBJECT,
        properties: {
          reply: { type: GeminiSchemaType.STRING },
          suggested_slugs: {
            type: GeminiSchemaType.ARRAY,
            items: { type: GeminiSchemaType.STRING },
          },
          suggested_page_slugs: {
            type: GeminiSchemaType.ARRAY,
            items: { type: GeminiSchemaType.STRING },
          },
          box_estimate_note: { type: GeminiSchemaType.STRING },
        },
        required: ['reply', 'suggested_slugs'],
      };

      const aiResult = await callAiStructuredJson<{
        reply: string;
        suggested_slugs: string[];
        suggested_page_slugs?: string[];
        box_estimate_note?: string;
      }>({
        provider: cred.provider,
        apiKey: cred.apiKey,
        model: cred.model,
        baseUrl: cred.baseUrl,
        responseSchema,
        systemPrompt: [
          'You are the helpful Online Showroom Assistant for DecorBiz architectural tiles, sanitaryware, faucets, adhesives, and installation services.',
          'Answer customer questions politely in clear, concise natural language matching the customer language (English or simple Hindi/Hinglish if asked).',
          'STRICT GROUNDING RULES:',
          '1) Recommend ONLY items whose `slug` exists inside <UNTRUSTED_STORE_DATA>.catalogue. Never invent SKUs, prices, dimensions, coupons, or delivery charges.',
          '2) If `detected_user_area_sqft` is present and tile items match, explain the box calculation clearly including 10% wastage allowance in `box_estimate_note`.',
          '3) If an item is out of stock or not carried online, mention that honestly and offer the closest published alternative or showroom contact.',
          '4) Return up to 4 exact matching `suggested_slugs` from `catalogue`, and up to 2 relevant `suggested_page_slugs` from `published_pages` (policies, guides, FAQ) when helpful.',
        ].join('\n'),
        userPrompt: [
          historyText ? `Recent conversation:\n${historyText}\n` : '',
          `Customer message: ${sanitizeUntrustedText(userMsg)}`,
          `<UNTRUSTED_STORE_DATA>\n${JSON.stringify(storeContext)}\n</UNTRUSTED_STORE_DATA>`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      });

      const itemBySlug = new Map(
        safeItems.map((it) => [String(it.online_slug || ''), it])
      );
      const suggestedItems = Array.from(
        new Set(
          (Array.isArray(aiResult.data.suggested_slugs) ? aiResult.data.suggested_slugs : []).map((s) =>
            String(s || '').trim()
          )
        )
      )
        .map((slug) => itemBySlug.get(slug))
        .filter((it): it is Record<string, unknown> => Boolean(it))
        .slice(0, 4)
        .map((it) => {
          const specsObj = it.specs && typeof it.specs === 'object' ? (it.specs as Record<string, unknown>) : null;
          const rawSqft = Number(specsObj?.sqft_per_box || 0);
          return {
            id: String(it.id),
            name: String(it.name),
            online_slug: String(it.online_slug),
            product_line: String(it.product_line),
            item_type: String(it.item_type || 'goods'),
            effective_price: Number(it.effective_price || 0),
            mrp: it.mrp != null ? Number(it.mrp) : null,
            base_unit_code: String(it.base_unit_code || 'PCS'),
            sqft_per_box: Number.isFinite(rawSqft) && rawSqft > 0 ? rawSqft : null,
            available_qty: Number(it.available_qty || 0),
            in_stock: Boolean(it.in_stock),
            primary_image_file_id: it.primary_image_file_id ? String(it.primary_image_file_id) : null,
          };
        });

      const pageBySlug = new Map(safePages.map((p) => [p.slug, p]));
      const suggestedPages = Array.from(
        new Set(
          (Array.isArray(aiResult.data.suggested_page_slugs)
            ? aiResult.data.suggested_page_slugs
            : []
          ).map((s) => String(s || '').trim())
        )
      )
        .map((slug) => pageBySlug.get(slug))
        .filter((p): p is { slug: string; title: string } => Boolean(p))
        .slice(0, 2)
        .map((p) => ({ slug: p.slug, title: p.title }));

      try {
        const { data: ownerProf } = await admin
          .from('profiles')
          .select('id')
          .eq('role', 'owner')
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();
        if (ownerProf?.id) {
          await admin.from('ai_usage_logs').insert({
            user_id: ownerProf.id,
            provider: cred.provider,
            model: cred.model,
            action_type: 'chat',
            tokens_in: Math.round(aiResult.tokensUsed * 0.6),
            tokens_out: Math.round(aiResult.tokensUsed * 0.4),
            status: 'ok',
          });
        }
      } catch {
        // Best-effort token tracking
      }

      res.json({
        reply: redactSecretsFromText(String(aiResult.data.reply || '').trim()),
        suggestedItems,
        suggestedPages,
        boxEstimateNote: aiResult.data.box_estimate_note
          ? redactSecretsFromText(String(aiResult.data.box_estimate_note).trim())
          : null,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Unable to answer right now.';
      const lower = raw.toLowerCase();
      if (lower.includes('budget') || lower.includes('quota')) {
        res.status(429).json({ error: redactSecretsFromText(raw) });
        return;
      }
      if (
        lower.includes('not configured') ||
        lower.includes('api key') ||
        lower.includes('timed out') ||
        lower.includes('503') ||
        lower.includes('unavailable') ||
        lower.includes('no active ai')
      ) {
        res.status(503).json({
          error: 'Showroom AI is currently unavailable. Please contact our showroom or browse the catalogue.',
        });
        return;
      }
      res.status(503).json({
        error: 'Showroom AI could not complete your request right now. Please browse the catalogue or contact our showroom.',
      });
    }
  }));
}
