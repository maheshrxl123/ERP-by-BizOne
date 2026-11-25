import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  computeStockPoolTransition,
  computeStoreOrderTotals,
  computeTileOrderQty,
  filterStoreProducts,
  matchDeliveryZone,
} from '../src/core/storeCatalog.ts';
import {
  computeRazorpaySignature,
  verifyRazorpaySignature,
} from '../src/server/storePayments.ts';

test('Step 4: Migration 0023 enforces customer isolation, unpublished item filtering & stock reservations', () => {
  const sql = fs.readFileSync(
    path.resolve('supabase/migrations/0023_decorbiz_step4_ecommerce.sql'),
    'utf8'
  );

  // Customer table separate from profiles with self-only RLS
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.customers/);
  assert.match(sql, /customer_id = public\.current_customer_id\(\)/);

  // Published view excludes unpublished / inactive items and excludes cost fields
  assert.match(sql, /CREATE OR REPLACE VIEW public\.published_store_items_view/);
  assert.match(sql, /i\.is_active = true\s+AND i\.is_published_online = true/);
  const viewStart = sql.indexOf('CREATE OR REPLACE VIEW public.published_store_items_view');
  const viewEnd = sql.indexOf('GRANT SELECT ON public.published_store_items_view');
  assert.ok(viewStart !== -1 && viewEnd > viewStart, 'published_store_items_view DDL bounds found');
  assert.doesNotMatch(
    sql.slice(viewStart, viewEnd),
    /purchase_price/
  );

  // Stock reservation column & transactional RPC exist
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reserved_qty numeric\(15,3\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.store_transition_order_stock/);
});

test('Step 4: Storefront bundle & source never link or expose /ERP', () => {
  const storefrontFiles = [
    'src/StorefrontApp.tsx',
    'src/modules/storefront/storeTypes.ts',
    'src/modules/storefront/StoreAuthModal.tsx',
    'src/modules/storefront/StoreProductDetail.tsx',
    'src/modules/storefront/StoreCheckoutDrawer.tsx',
    'src/modules/storefront/StoreAccountViews.tsx',
  ];

  for (const rel of storefrontFiles) {
    const src = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.doesNotMatch(src, /\/ERP/i, `${rel} must not contain links to /ERP`);
    assert.doesNotMatch(src, /item_catalog_view|issue_bill|save_item/, `${rel} must not use ERP RPCs`);
  }
});

test('Step 4: Unpublished item isolation & customer order isolation enforced in server routes', () => {
  const storefrontRoute = fs.readFileSync(path.resolve('src/server/routes/storefront.ts'), 'utf8');

  // Product detail & catalogue only read from published_store_items_view
  assert.match(storefrontRoute, /from\('published_store_items_view'\)/);
  // Media proxy verifies is_published_online = true before serving file bytes
  assert.match(storefrontRoute, /eq\('is_published_online',\s*true\)/);
  // Orders strictly filter by customer_id = req.customer.id
  assert.match(storefrontRoute, /eq\('customer_id',\s*req\.customer!\.id\)/);
});

test('Step 4: Stock pool lifecycle reserves on confirm, blocks oversell, releases on cancel, and deducts on dispatch', () => {
  // Start with 10 boxes on hand, 2 already reserved -> 8 available
  const confirmed = computeStockPoolTransition({
    qtyOnHand: 10,
    reservedQty: 2,
    orderBaseQty: 5,
    allowNegativeStock: false,
    currentStockState: 'none',
    targetStatus: 'confirmed',
  });
  assert.equal(confirmed.nextQtyOnHand, 10);
  assert.equal(confirmed.nextReservedQty, 7);
  assert.equal(confirmed.nextStockState, 'reserved');

  // Overselling available pool throws cleanly
  assert.throws(
    () =>
      computeStockPoolTransition({
        qtyOnHand: 10,
        reservedQty: 7,
        orderBaseQty: 4,
        allowNegativeStock: false,
        currentStockState: 'none',
        targetStatus: 'confirmed',
      }),
    /Insufficient available stock to reserve/
  );

  // Cancellation releases reservation without touching physical qty_on_hand
  const cancelled = computeStockPoolTransition({
    qtyOnHand: confirmed.nextQtyOnHand,
    reservedQty: confirmed.nextReservedQty,
    orderBaseQty: 5,
    allowNegativeStock: false,
    currentStockState: confirmed.nextStockState,
    targetStatus: 'cancelled',
  });
  assert.equal(cancelled.nextQtyOnHand, 10);
  assert.equal(cancelled.nextReservedQty, 2);
  assert.equal(cancelled.nextStockState, 'released');

  // Delivery deducts physical stock and releases that order's reservation
  const delivered = computeStockPoolTransition({
    qtyOnHand: confirmed.nextQtyOnHand,
    reservedQty: confirmed.nextReservedQty,
    orderBaseQty: 5,
    allowNegativeStock: false,
    currentStockState: confirmed.nextStockState,
    targetStatus: 'delivered',
  });
  assert.equal(delivered.nextQtyOnHand, 5);
  assert.equal(delivered.nextReservedQty, 2);
  assert.equal(delivered.nextStockState, 'deducted');
});

test('Step 4: Tile sq.ft <-> box converter, filter engine, delivery zone & coupon calculations', () => {
  // 100 sq.ft at 16 sq.ft/box + 10% wastage = 110 sq.ft -> ceil(110 / 16) = 7 boxes
  const calc = computeTileOrderQty({
    mode: 'sqft',
    inputQty: 100,
    sqftPerBox: 16,
    wastagePct: 10,
  });
  assert.equal(calc.orderedUnit, 'sqft');
  assert.equal(calc.baseQty, 7);
  assert.equal(calc.sqftCovered, 112);

  const zones = [
    {
      id: 'z-1',
      zone_name: 'City Zone A',
      pincodes: ['302001', '302002'],
      area_keywords: ['malviya nagar'],
      delivery_charge: 450,
      min_order_amount: 1000,
      estimated_days: 1,
      is_active: true,
      created_at: '',
      updated_at: '',
    },
  ];
  const matched = matchDeliveryZone(zones, { pincode: '302001' });
  assert.equal(matched?.id, 'z-1');

  const pricing = computeStoreOrderTotals({
    lines: [{ unitPrice: 1200, baseQty: 2 }], // Rs 2400 subtotal
    fulfillmentType: 'delivery',
    zone: matched,
    coupon: {
      id: 'c-1',
      code: 'SAVE10',
      description: '10% off',
      discount_type: 'pct',
      discount_value: 10,
      min_order_amount: 1000,
      max_discount: 200,
      valid_until: '2099-12-31',
      usage_limit: 100,
      used_count: 0,
      is_active: true,
      created_at: '',
      updated_at: '',
    },
  });
  assert.equal(pricing.subtotal, 2400);
  assert.equal(pricing.discountAmount, 200); // capped at 200
  assert.equal(pricing.deliveryCharge, 450);
  assert.equal(pricing.grandTotal, 2650);
  assert.deepEqual(pricing.errors, []);

  // Pickup waives delivery charge even without a matched zone
  const pickupPricing = computeStoreOrderTotals({
    lines: [{ unitPrice: 1200, baseQty: 2 }],
    fulfillmentType: 'pickup',
    zone: null,
    coupon: null,
  });
  assert.equal(pickupPricing.deliveryCharge, 0);
  assert.equal(pickupPricing.grandTotal, 2400);
  assert.deepEqual(pickupPricing.errors, []);

  // Filter test
  const sampleItems = [
    {
      id: 'i-1',
      name: 'Statuario Matte Slab',
      sku: 'TILE-1',
      item_type: 'goods',
      product_line: 'tiles_slabs',
      category_id: null,
      category_name: 'Floor Tiles',
      brand_id: null,
      brand_name: 'Kajaria',
      base_unit_code: 'BOX',
      base_unit_name_en: 'Box',
      selling_price: 1500,
      online_price: 1400,
      effective_price: 1400,
      mrp: 1800,
      gst_rate: 18,
      tax_inclusive: true,
      allow_negative_stock: false,
      primary_image_file_id: null,
      warranty_months: null,
      video_url: null,
      description: null,
      online_description: null,
      online_slug: 'statuario-matte',
      specs: { size_length_mm: 600, size_width_mm: 1200, finish: 'matte', shade: 'White' },
      qty_on_hand: 20,
      reserved_qty: 0,
      available_qty: 20,
      in_stock: true,
      image_file_ids: [],
      variants: [],
      created_at: '',
      updated_at: '',
    },
  ];
  assert.equal(
    filterStoreProducts(sampleItems, { finish: 'matte', shade: 'white', inStockOnly: true }).length,
    1
  );
  assert.equal(filterStoreProducts(sampleItems, { finish: 'glossy' }).length, 0);
});

test('Step 4: Razorpay server-side HMAC-SHA256 signature verification rejects tampered payloads & disabled toggle', () => {
  const orderId = 'order_Test123456';
  const paymentId = 'pay_Valid987654';
  const secret = 'rzp_test_super_secret_key';

  const validSig = computeRazorpaySignature(orderId, paymentId, secret);
  assert.equal(
    verifyRazorpaySignature({ orderId, paymentId, signature: validSig, keySecret: secret }),
    true
  );

  // Tampered payment ID fails
  assert.equal(
    verifyRazorpaySignature({
      orderId,
      paymentId: 'pay_Tampered000',
      signature: validSig,
      keySecret: secret,
    }),
    false
  );

  // Forged signature fails
  assert.equal(
    verifyRazorpaySignature({
      orderId,
      paymentId,
      signature: '0'.repeat(validSig.length),
      keySecret: secret,
    }),
    false
  );

  // Wrong secret fails
  assert.equal(
    verifyRazorpaySignature({
      orderId,
      paymentId,
      signature: validSig,
      keySecret: 'wrong_secret',
    }),
    false
  );

  // Empty inputs fail
  assert.equal(
    verifyRazorpaySignature({ orderId, paymentId, signature: '', keySecret: secret }),
    false
  );

  // Verify storefront route checks razorpayCfg.enabled & never trusts client paid state
  const storefrontRoute = fs.readFileSync(path.resolve('src/server/routes/storefront.ts'), 'utf8');
  assert.match(storefrontRoute, /verifyRazorpaySignature\(/);
  assert.match(storefrontRoute, /payment_status:\s*'failed'/);
  assert.match(storefrontRoute, /if\s*\(input\.paymentMethod === 'razorpay' && !razorpayCfg\.enabled\)/);
});

test('Step 4: Express app isolates /api/store/* and /api/erp/store-admin/* without unauthenticated access', async () => {
  process.env.DECORBIZ_NO_LISTEN = '1';
  const { app } = await import('../server.ts');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Store orders endpoint must reject unauthenticated callers
    const orderRes = await fetch(`${baseUrl}/api/store/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    assert.ok(
      [401, 403, 503].includes(orderRes.status),
      `POST /api/store/orders must not allow unauthenticated order creation (got ${orderRes.status})`
    );

    // ERP Store Admin endpoint must reject unauthenticated callers
    const adminRes = await fetch(`${baseUrl}/api/erp/store-admin/overview`);
    assert.ok(
      [401, 403, 503].includes(adminRes.status),
      `GET /api/erp/store-admin/overview must reject unauthenticated access (got ${adminRes.status})`
    );

    // Public catalogue & config endpoints respond gracefully (never 500)
    const cfgRes = await fetch(`${baseUrl}/api/store/config`);
    assert.equal(cfgRes.status, 200);
    const catRes = await fetch(`${baseUrl}/api/store/catalogue`);
    assert.ok([200, 503].includes(catRes.status));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Step 4 Completion: Password reset recovery, strict email verification, safe video player, real SMTP relay & /api/erp/* hygiene', () => {
  const storeAppSrc = fs.readFileSync(path.resolve('src/StorefrontApp.tsx'), 'utf8');
  assert.match(storeAppSrc, /type.*recovery|recoveryToken/);
  assert.match(storeAppSrc, /document\.title\s*=/);

  const storeAuthSrc = fs.readFileSync(path.resolve('src/modules/storefront/StoreAuthModal.tsx'), 'utf8');
  assert.match(storeAuthSrc, /\/api\/store\/auth\/update-password/);

  const custAuthSrc = fs.readFileSync(path.resolve('src/server/customerAuth.ts'), 'utf8');
  assert.match(custAuthSrc, /EMAIL_NOT_VERIFIED/);

  const pdpSrc = fs.readFileSync(path.resolve('src/modules/storefront/StoreProductDetail.tsx'), 'utf8');
  assert.match(pdpSrc, /resolveSafeVideoPlayer/);
  assert.match(pdpSrc, /youtube-nocookie\.com\/embed/);

  const storefrontRoute = fs.readFileSync(path.resolve('src/server/routes/storefront.ts'), 'utf8');
  const storeAdminRoute = fs.readFileSync(path.resolve('src/server/routes/storeAdmin.ts'), 'utf8');
  assert.match(storefrontRoute, /sendSmtpOrWebhookEmail/);
  assert.match(storeAdminRoute, /sendSmtpOrWebhookEmail/);

  const storeAdminScreen = fs.readFileSync(path.resolve('src/modules/store/OnlineStoreAdminScreen.tsx'), 'utf8');
  assert.match(storeAdminScreen, /purpose="store_banner"/);
  assert.match(storeAdminScreen, /\/api\/erp\/store-admin\//);
  assert.doesNotMatch(storeAdminScreen, /['"]\/api\/store-admin\//);
});
