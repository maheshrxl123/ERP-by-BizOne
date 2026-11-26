import type { Express, Response } from 'express';
import { z } from 'zod';
import { createUserScopedClient } from '../config.ts';
import { sendSmtpOrWebhookEmail } from '../mailer.ts';
import {
  isModuleEnabledServer,
  requireActiveStaff,
  requireModuleEnabled,
  UUID_SCHEMA,
  writeAudit,
  type AuthenticatedRequest,
} from '../middleware.ts';
import {
  createEmptyServiceSpecs,
  validateServiceSpecs,
} from '../../core/productSpecs.ts';
import { isValidProductLine, type ProductLineKey } from '../../core/productLines.ts';
import type { StoreOrderStatus } from '../../types/decorbiz.ts';

function slugifyText(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function generateTripNumber(): string {
  const now = new Date();
  const y = String(now.getUTCFullYear()).slice(-2);
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const rand = Math.floor(100 + Math.random() * 900);
  return `TRP-${y}${m}${d}-${rand}`;
}

async function notifyCustomerOnOrderStatus(
  req: AuthenticatedRequest,
  order: {
    order_number: string;
    customer_email: string;
    grand_total: number;
  },
  status: StoreOrderStatus
): Promise<void> {
  const emailEnabled = await isModuleEnabledServer('email_notifications');
  if (!emailEnabled || !order.customer_email) return;

  const admin = req.supabaseAdmin!;
  const labelMap: Record<StoreOrderStatus, string> = {
    pending: 'Received',
    confirmed: 'Confirmed & Stock Reserved',
    packing: 'Being Packed',
    out_for_delivery: 'Out for Delivery',
    ready_for_pickup: 'Ready for Showroom Pickup',
    delivered: 'Delivered',
    picked_up: 'Picked Up',
    cancelled: 'Cancelled',
  };

  const subject = `Order ${order.order_number}: ${labelMap[status]}`;
  const text = `Order ${order.order_number}: ${labelMap[status]} (Total Rs ${Number(order.grand_total).toFixed(2)}).`;
  const mailResult = await sendSmtpOrWebhookEmail(admin, {
    to: order.customer_email,
    subject,
    text,
    entityType: 'store_order',
    entityId: order.order_number,
  });

  await admin.from('message_logs').insert({
    channel: 'email',
    recipient: order.customer_email,
    template_key: `store_order_${status}`,
    rendered_body: text,
    status: mailResult.status,
    error_message: mailResult.errorMessage,
    entity_type: 'store_order',
    entity_id: order.order_number,
    sent_by: req.staffUser!.id,
  });
}

const zoneSchema = z.object({
  zone_name: z.string().trim().min(1).max(120),
  pincodes: z.array(z.string().trim().min(3).max(16)).default([]),
  area_keywords: z.array(z.string().trim().min(1).max(80)).default([]),
  delivery_charge: z.number().min(0),
  min_order_amount: z.number().min(0).default(0),
  estimated_days: z.number().int().min(0).max(60).default(2),
  is_active: z.boolean().default(true),
});

const couponSchema = z.object({
  code: z.string().trim().min(2).max(40),
  description: z.string().trim().max(200).nullable().optional(),
  discount_type: z.enum(['pct', 'flat']),
  discount_value: z.number().positive(),
  min_order_amount: z.number().min(0).default(0),
  max_discount: z.number().min(0).nullable().optional(),
  valid_until: z.string().trim().nullable().optional(),
  usage_limit: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().default(true),
});

const bannerSchema = z.object({
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(300).nullable().optional(),
  cta_label: z.string().trim().max(60).nullable().optional(),
  cta_link: z.string().trim().max(240).nullable().optional(),
  image_file_id: UUID_SCHEMA.nullable().optional(),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
});

const pageSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(180),
  content: z.string().max(40000).default(''),
  is_published: z.boolean().default(false),
});

const tripSchema = z.object({
  trip_date: z.string().trim().min(8).max(20),
  driver_name: z.string().trim().min(1).max(120),
  driver_phone: z.string().trim().max(30).nullable().optional(),
  vehicle_no: z.string().trim().max(40).nullable().optional(),
  status: z.enum(['planned', 'dispatched', 'completed', 'cancelled']).default('planned'),
  notes: z.string().trim().max(500).nullable().optional(),
});

export function registerStoreAdminRoutes(app: Express): void {
  const guard = [requireActiveStaff, requireModuleEnabled('online_store', 'inventory')] as const;

  app.get('/api/store-admin/overview', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const admin = req.supabaseAdmin!;
    try {
      const [
        { data: items, error: itemsErr },
        { data: orders, error: ordersErr },
        { data: trips },
        { data: zones },
        { data: coupons },
        { data: banners },
        { data: pages },
        { data: reviews },
        { data: categories },
        { data: brands },
        { data: units },
        razorpaySlot,
      ] = await Promise.all([
        admin.from('item_catalog_view').select('*').eq('is_active', true).order('name'),
        admin.from('store_orders').select('*, store_order_lines(*)').order('created_at', { ascending: false }).limit(200),
        admin.from('store_delivery_trips').select('*').order('trip_date', { ascending: false }).limit(100),
        admin.from('store_delivery_zones').select('*').order('zone_name'),
        admin.from('store_coupons').select('*').order('created_at', { ascending: false }),
        admin.from('store_banners').select('*').order('sort_order', { ascending: true }),
        admin.from('store_pages').select('*').order('title'),
        admin.from('product_reviews').select('*').order('created_at', { ascending: false }).limit(200),
        admin.from('item_categories').select('*').eq('is_active', true).order('name'),
        admin.from('brands').select('*').eq('is_active', true).order('name'),
        admin.from('item_units').select('*').eq('is_active', true).order('is_system', { ascending: false }).order('code'),
        admin
          .from('integration_settings')
          .select('enabled, config_public, has_secret')
          .eq('integration_key', 'online_payments')
          .maybeSingle(),
      ]);

      if (itemsErr) throw itemsErr;
      if (ordersErr) throw ordersErr;

      const tripMap = new Map((trips || []).map((t) => [t.id, t]));
      const itemNameMap = new Map((items || []).map((i) => [i.id, i.name]));

      const mappedOrders = (orders || []).map((o) => {
        const rec = o as Record<string, unknown>;
        const { store_order_lines, ...rest } = rec;
        return {
          ...rest,
          lines: store_order_lines || [],
          delivery_trip: rest.delivery_trip_id ? tripMap.get(String(rest.delivery_trip_id)) || null : null,
        };
      });

      const mappedReviews = (reviews || []).map((r) => ({
        ...r,
        item_name: itemNameMap.get(r.item_id) || 'Product',
      }));

      res.json({
        items: items || [],
        orders: mappedOrders,
        trips: trips || [],
        zones: zones || [],
        coupons: coupons || [],
        banners: banners || [],
        pages: pages || [],
        reviews: mappedReviews,
        categories: categories || [],
        brands: brands || [],
        units: units || [],
        razorpayConfigured: Boolean(razorpaySlot.data?.enabled && razorpaySlot.data?.has_secret),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to load store admin overview.',
      });
    }
  });

  // Create new Goods or Service item directly from Store Admin & publish online
  app.post('/api/store-admin/items', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    if (!['owner', 'manager', 'storekeeper'].includes(req.staffUser!.role)) {
      res.status(403).json({ error: 'Only Owner, Manager, or Storekeeper can add online items.' });
      return;
    }

    const createOnlineItemSchema = z.object({
      name: z.string().trim().min(1).max(160),
      item_type: z.enum(['goods', 'service']).default('goods'),
      product_line: z.string().trim().optional().default('tiles_slabs'),
      category_id: UUID_SCHEMA.nullable().optional(),
      brand_id: UUID_SCHEMA.nullable().optional(),
      base_unit_id: UUID_SCHEMA,
      sku: z.string().trim().max(64).nullable().optional(),
      selling_price: z.number().min(0),
      mrp: z.number().min(0).nullable().optional(),
      gst_rate: z.number().min(0).max(28).default(18),
      hsn_code: z.string().trim().max(32).nullable().optional(),
      tax_inclusive: z.boolean().default(true),
      opening_stock: z.number().min(0).default(0),
      image_file_ids: z.array(UUID_SCHEMA).max(8).default([]),
      video_url: z.string().trim().max(500).nullable().optional(),
      description: z.string().trim().max(4000).nullable().optional(),
      service_specs: z
        .object({
          service_category: z.string().trim().default('Other Service'),
          billing_basis: z.string().trim().default('Per Job / Visit'),
          est_duration: z.string().trim().default(''),
          service_area: z.string().trim().default(''),
          scope_deliverables: z.string().trim().default(''),
          sac_code: z.string().trim().default(''),
          service_terms: z.string().trim().default(''),
        })
        .optional(),
      sqft_per_box: z.number().positive().nullable().optional(),
      is_published_online: z.boolean().default(true),
      online_price: z.number().min(0).nullable().optional(),
      online_slug: z.string().trim().max(120).nullable().optional(),
      online_description: z.string().trim().max(4000).nullable().optional(),
    });

    const parsed = createOnlineItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid online item payload.' });
      return;
    }

    const input = parsed.data;
    const isService = input.item_type === 'service';
    const effectiveLine: ProductLineKey = isService
      ? 'other_general'
      : isValidProductLine(input.product_line)
        ? input.product_line
        : 'other_general';

    const packMeta: Record<string, unknown> = {};
    let effectiveHsn = input.hsn_code || null;

    if (isService) {
      const mergedSrv = {
        ...createEmptyServiceSpecs({ sacCode: input.hsn_code || '' }),
        ...(input.service_specs || {}),
      };
      const checkSrv = validateServiceSpecs(mergedSrv);
      if (!checkSrv.valid) {
        res.status(400).json({ error: Object.values(checkSrv.errors)[0] || 'Invalid service specs.' });
        return;
      }
      packMeta.service_specs = checkSrv.cleaned;
      if (checkSrv.cleaned.sac_code) {
        packMeta.sac_code = checkSrv.cleaned.sac_code;
        if (!effectiveHsn) effectiveHsn = checkSrv.cleaned.sac_code;
      }
    } else if (input.sqft_per_box) {
      packMeta.sqft_per_box = String(input.sqft_per_box);
    }

    try {
      const userClient = createUserScopedClient(req.headers.authorization!);
      const { data: rpcData, error: rpcErr } = await userClient.rpc('save_item', {
        p_id: null,
        p_name: input.name,
        p_sku: input.sku || null,
        p_barcode: null,
        p_category_id: input.category_id || null,
        p_brand_id: input.brand_id || null,
        p_base_unit_id: input.base_unit_id,
        p_selling_price: input.selling_price,
        p_mrp: input.mrp ?? null,
        p_purchase_price: null,
        p_gst_rate: input.gst_rate,
        p_hsn_code: effectiveHsn,
        p_tax_inclusive: input.tax_inclusive,
        p_low_stock_alert: 0,
        p_allow_negative_stock: isService,
        p_opening_stock: isService ? 0 : input.opening_stock,
        p_opening_unit_id: isService ? null : input.base_unit_id,
        p_pack_metadata: packMeta,
        p_notes: null,
        p_conversions: [],
        p_images: input.image_file_ids.map((fid, idx) => ({
          file_id: fid,
          sort_order: idx,
          is_primary: idx === 0,
        })),
        p_expected_version: null,
        p_item_type: input.item_type,
        p_product_line: effectiveLine,
        p_supplier_id: null,
        p_country_of_origin: isService ? null : 'India',
        p_warranty_months: null,
        p_video_url: input.video_url || null,
        p_description: input.description || input.online_description || null,
        p_specs: null,
      });

      if (rpcErr || !rpcData?.id) {
        res.status(400).json({ error: rpcErr?.message || 'Unable to create item.' });
        return;
      }

      const itemId = String(rpcData.id);
      const slug = input.online_slug?.trim()
        ? slugifyText(input.online_slug)
        : input.is_published_online
          ? `${slugifyText(input.name)}-${itemId.slice(0, 6)}`
          : null;

      const admin = req.supabaseAdmin!;
      const { data: updated, error: updErr } = await admin
        .from('items')
        .update({
          is_published_online: input.is_published_online,
          online_price: input.online_price ?? null,
          online_slug: slug,
          online_description: input.online_description || input.description || null,
        })
        .eq('id', itemId)
        .select('id, name, is_published_online, online_price, online_slug, online_description')
        .single();

      if (updErr) {
        res.status(400).json({ error: updErr.message });
        return;
      }

      await writeAudit(req.staffUser!.id, req.staffUser!.email, 'store.item_created', 'item', itemId, {
        name: input.name,
        item_type: input.item_type,
        is_published_online: input.is_published_online,
      });

      res.status(201).json({ item: updated });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to create online store item.',
      });
    }
  });

  // Publish / Unpublish Item + Online Price, Slug, Description
  app.patch('/api/store-admin/items/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    if (!['owner', 'manager', 'storekeeper'].includes(req.staffUser!.role)) {
      res.status(403).json({ error: 'Only Owner, Manager, or Storekeeper can update online listings.' });
      return;
    }
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid item ID required.' });
      return;
    }

    const isPublished = Boolean(req.body?.is_published_online);
    const rawPrice = req.body?.online_price;
    const onlinePrice =
      rawPrice === null || rawPrice === '' || rawPrice === undefined ? null : Number(rawPrice);
    if (onlinePrice !== null && (!Number.isFinite(onlinePrice) || onlinePrice < 0)) {
      res.status(400).json({ error: 'Online price must be a non-negative number.' });
      return;
    }

    const admin = req.supabaseAdmin!;
    const { data: existingItem } = await admin
      .from('items')
      .select('id, name')
      .eq('id', parsedId.data)
      .maybeSingle();
    if (!existingItem) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const rawSlug = typeof req.body?.online_slug === 'string' ? req.body.online_slug.trim() : '';
    const onlineSlug = rawSlug
      ? slugifyText(rawSlug)
      : isPublished
        ? `${slugifyText(existingItem.name)}-${parsedId.data.slice(0, 6)}`
        : null;
    const onlineDescription =
      typeof req.body?.online_description === 'string'
        ? req.body.online_description.trim() || null
        : null;

    const { data, error } = await admin
      .from('items')
      .update({
        is_published_online: isPublished,
        online_price: onlinePrice,
        online_slug: onlineSlug,
        online_description: onlineDescription,
      })
      .eq('id', parsedId.data)
      .select('id, is_published_online, online_price, online_slug, online_description')
      .single();

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    await writeAudit(req.staffUser!.id, req.staffUser!.email, 'store.item_updated', 'item', parsedId.data, {
      is_published_online: isPublished,
      online_price: onlinePrice,
      online_slug: onlineSlug,
    });

    res.json({ item: data });
  });

  // Order Status Update (reserves on confirm, deducts on delivery/pickup, releases on cancel) & Trip Assignment
  app.patch('/api/store-admin/orders/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    if (!['owner', 'manager', 'storekeeper', 'cashier'].includes(req.staffUser!.role)) {
      res.status(403).json({ error: 'Insufficient permission to update store orders.' });
      return;
    }
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid order ID required.' });
      return;
    }

    const admin = req.supabaseAdmin!;
    try {
      const targetStatus = req.body?.status as StoreOrderStatus | undefined;
      const deliveryTripId =
        req.body?.delivery_trip_id === null || req.body?.delivery_trip_id === ''
          ? null
          : req.body?.delivery_trip_id;
      const internalNotes =
        typeof req.body?.internal_notes === 'string' ? req.body.internal_notes.trim() || null : undefined;

      if (deliveryTripId !== undefined && deliveryTripId !== null && !UUID_SCHEMA.safeParse(deliveryTripId).success) {
        res.status(400).json({ error: 'Invalid delivery trip ID.' });
        return;
      }

      let orderRow: Record<string, unknown> | null = null;
      if (targetStatus) {
        const { data: transitioned, error: rpcErr } = await admin.rpc('store_transition_order_stock', {
          p_order_id: parsedId.data,
          p_target_status: targetStatus,
        });
        if (rpcErr) {
          res.status(400).json({ error: rpcErr.message });
          return;
        }
        orderRow = transitioned as Record<string, unknown>;
      }

      const patch: Record<string, unknown> = {};
      if (deliveryTripId !== undefined) patch.delivery_trip_id = deliveryTripId;
      if (internalNotes !== undefined) patch.internal_notes = internalNotes;
      if (typeof req.body?.payment_status === 'string' && ['unpaid', 'pending', 'paid', 'failed', 'refunded'].includes(req.body.payment_status)) {
        patch.payment_status = req.body.payment_status;
      }

      if (Object.keys(patch).length > 0) {
        const { data: patched, error: patchErr } = await admin
          .from('store_orders')
          .update(patch)
          .eq('id', parsedId.data)
          .select('*')
          .single();
        if (patchErr) {
          res.status(400).json({ error: patchErr.message });
          return;
        }
        orderRow = patched as Record<string, unknown>;
      }

      if (!orderRow) {
        const { data: fetched } = await admin.from('store_orders').select('*').eq('id', parsedId.data).maybeSingle();
        orderRow = fetched as Record<string, unknown> | null;
      }

      if (targetStatus && orderRow) {
        await notifyCustomerOnOrderStatus(
          req,
          {
            order_number: String(orderRow.order_number),
            customer_email: String(orderRow.customer_email || ''),
            grand_total: Number(orderRow.grand_total || 0),
          },
          targetStatus
        );
      }

      await writeAudit(req.staffUser!.id, req.staffUser!.email, 'store.order_updated', 'store_order', parsedId.data, {
        status: targetStatus || null,
        delivery_trip_id: deliveryTripId ?? null,
      });

      res.json({ order: orderRow });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Order update failed.' });
    }
  });

  // Delivery Trips CRUD
  app.post('/api/store-admin/trips', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = tripSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid trip payload.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_delivery_trips')
      .insert({
        trip_number: generateTripNumber(),
        ...parsed.data,
        created_by: req.staffUser!.id,
      })
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ trip: data });
  });

  app.patch('/api/store-admin/trips/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid trip ID required.' });
      return;
    }
    const status = String(req.body?.status || '');
    if (!['planned', 'dispatched', 'completed', 'cancelled'].includes(status)) {
      res.status(400).json({ error: 'Invalid trip status.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_delivery_trips')
      .update({ status })
      .eq('id', parsedId.data)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ trip: data });
  });

  // Delivery Zones CRUD
  app.post('/api/store-admin/zones', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = zoneSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid zone data.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_delivery_zones')
      .insert(parsed.data)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ zone: data });
  });

  app.patch('/api/store-admin/zones/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    const parsed = zoneSchema.partial().safeParse(req.body);
    if (!parsedId.success || !parsed.success) {
      res.status(400).json({ error: 'Invalid zone update payload.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_delivery_zones')
      .update(parsed.data)
      .eq('id', parsedId.data)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ zone: data });
  });

  app.delete('/api/store-admin/zones/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid zone ID required.' });
      return;
    }
    await req.supabaseAdmin!.from('store_delivery_zones').delete().eq('id', parsedId.data);
    res.json({ ok: true });
  });

  // Coupons CRUD
  app.post('/api/store-admin/coupons', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = couponSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid coupon data.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_coupons')
      .insert({ ...parsed.data, code: parsed.data.code.toUpperCase() })
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ coupon: data });
  });

  app.patch('/api/store-admin/coupons/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    const parsed = couponSchema.partial().safeParse(req.body);
    if (!parsedId.success || !parsed.success) {
      res.status(400).json({ error: 'Valid coupon ID and update payload required.' });
      return;
    }
    const patch = {
      ...parsed.data,
      ...(parsed.data.code ? { code: parsed.data.code.toUpperCase() } : {}),
    };
    const { data, error } = await req.supabaseAdmin!
      .from('store_coupons')
      .update(patch)
      .eq('id', parsedId.data)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ coupon: data });
  });

  app.delete('/api/store-admin/coupons/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid coupon ID required.' });
      return;
    }
    await req.supabaseAdmin!.from('store_coupons').delete().eq('id', parsedId.data);
    res.json({ ok: true });
  });

  // Banners CRUD
  app.post('/api/store-admin/banners', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = bannerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid banner data.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_banners')
      .insert(parsed.data)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ banner: data });
  });

  app.patch('/api/store-admin/banners/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    const parsed = bannerSchema.partial().safeParse(req.body);
    if (!parsedId.success || !parsed.success) {
      res.status(400).json({ error: 'Valid banner ID and update payload required.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_banners')
      .update(parsed.data)
      .eq('id', parsedId.data)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ banner: data });
  });

  app.delete('/api/store-admin/banners/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid banner ID required.' });
      return;
    }
    await req.supabaseAdmin!.from('store_banners').delete().eq('id', parsedId.data);
    res.json({ ok: true });
  });

  // Static Pages CRUD
  app.post('/api/store-admin/pages', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = pageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid page data.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('store_pages')
      .upsert(
        {
          slug: slugifyText(parsed.data.slug),
          title: parsed.data.title,
          content: parsed.data.content,
          is_published: parsed.data.is_published,
        },
        { onConflict: 'slug' }
      )
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ page: data });
  });

  app.delete('/api/store-admin/pages/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(400).json({ error: 'Valid page ID required.' });
      return;
    }
    await req.supabaseAdmin!.from('store_pages').delete().eq('id', parsedId.data);
    res.json({ ok: true });
  });

  // Review Moderation
  app.patch('/api/store-admin/reviews/:id', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    if (!['owner', 'manager'].includes(req.staffUser!.role)) {
      res.status(403).json({ error: 'Only Owner or Manager can moderate product reviews.' });
      return;
    }
    const parsedId = UUID_SCHEMA.safeParse(req.params.id);
    const status = String(req.body?.status || '');
    if (!parsedId.success || !['approved', 'rejected', 'pending'].includes(status)) {
      res.status(400).json({ error: 'Valid review ID and moderation status required.' });
      return;
    }
    const { data, error } = await req.supabaseAdmin!
      .from('product_reviews')
      .update({ status })
      .eq('id', parsedId.data)
      .select('*')
      .single();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ review: data });
  });
}
