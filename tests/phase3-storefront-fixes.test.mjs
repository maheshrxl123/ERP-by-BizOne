import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  computeStoreOrderTotals,
  computeTileOrderQty,
  filterStoreProducts,
  mergeStoreCartItems,
  resolveItemSqftPerBox,
  updateStoreCartItemQty,
} from '../src/core/storeCatalog.ts';

function makeTileItem(overrides = {}) {
  return {
    id: 'tile-1',
    name: 'Kajaria Statuario Vitra Slab',
    sku: 'KAJ-6012',
    item_type: 'goods',
    product_line: 'tiles_slabs',
    category_id: null,
    category_name: 'Floor Tiles',
    brand_id: null,
    brand_name: 'Kajaria',
    base_unit_code: 'BOX',
    base_unit_name_en: 'Box',
    selling_price: 1600,
    online_price: 1450,
    effective_price: 1450,
    mrp: 1850,
    gst_rate: 18,
    tax_inclusive: true,
    allow_negative_stock: false,
    primary_image_file_id: null,
    warranty_months: null,
    video_url: null,
    description: null,
    online_description: null,
    online_slug: 'kajaria-statuario-vitra',
    specs: { size_length_mm: 600, size_width_mm: 1200, sqft_per_box: '15.5', finish: 'Matte', shade: 'White' },
    qty_on_hand: 40,
    reserved_qty: 0,
    available_qty: 40,
    in_stock: true,
    image_file_ids: [],
    variants: [],
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

test('Phase 3 (BUG-MAJ-05): Bag merges boxes/sq.ft and recalculates sqftCovered immediately (including string sqft_per_box)', () => {
  const tile = makeTileItem();
  assert.equal(resolveItemSqftPerBox(tile.specs), 15.5);

  const calc = computeTileOrderQty({
    mode: 'sqft',
    inputQty: 100,
    sqftPerBox: 15.5,
    wastagePct: 10,
  });
  assert.equal(calc.baseQty, 8); // ceil(110 / 15.5) = 8 boxes
  assert.equal(calc.sqftCovered, 124); // 8 * 15.5

  // Initial add in sq.ft mode (8 boxes -> 124 sq.ft)
  let cart = mergeStoreCartItems([], {
    key: `${tile.id}:default`,
    item: tile,
    variantId: null,
    variantName: null,
    unitPrice: 1450,
    mode: 'sqft',
    qty: 100,
    baseQty: calc.baseQty,
    wastagePct: 10,
    sqftCovered: calc.sqftCovered,
  });
  assert.equal(cart.length, 1);
  assert.equal(cart[0].sqftCovered, 124);

  // Add 3 more boxes from product page or AI assistant (even with :base suffix key)
  cart = mergeStoreCartItems(cart, {
    key: `${tile.id}:default:base`,
    item: tile,
    variantId: null,
    variantName: null,
    unitPrice: 1450,
    mode: 'base',
    qty: 3,
    baseQty: 3,
    wastagePct: 0,
    sqftCovered: 46.5,
  });
  assert.equal(cart.length, 1);
  assert.equal(cart[0].baseQty, 11);
  assert.equal(cart[0].qty, 11);
  assert.equal(cart[0].mode, 'boxes');
  assert.equal(cart[0].sqftCovered, 170.5); // 11 * 15.5

  // Increment/decrement qty inside Bag drawer recalculates sqftCovered
  cart = updateStoreCartItemQty(cart, cart[0].key, 5);
  assert.equal(cart[0].baseQty, 5);
  assert.equal(cart[0].sqftCovered, 77.5); // 5 * 15.5

  const pdpSrc = fs.readFileSync(path.resolve('src/modules/storefront/StoreProductDetail.tsx'), 'utf8');
  assert.match(pdpSrc, /resolveItemSqftPerBox/);

  const storefrontRoute = fs.readFileSync(path.resolve('src/server/routes/storefront.ts'), 'utf8');
  assert.match(storefrontRoute, /rawSqftPerBox\s*=\s*Number\([\s\S]{0,120}sqft_per_box/);
});

test('Phase 3 (Hydration Flash & Skeletons): index.html & storefront components use RV Tiles & Decor branding and StoreImage skeletons', () => {
  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf8');
  assert.match(indexHtml, /RV Tiles &amp; Decor/);
  assert.doesNotMatch(indexHtml, /DecorBiz/);

  const storefrontApp = fs.readFileSync(path.resolve('src/StorefrontApp.tsx'), 'utf8');
  assert.match(storefrontApp, /STORE_BRANDING_CACHE_KEY/);
  assert.match(storefrontApp, /Loading collections/);
  assert.match(storefrontApp, /Loading products/);
  assert.match(storefrontApp, /<StoreImage/);
  assert.doesNotMatch(storefrontApp, /DecorBiz Showroom|DecorBiz Architectural Showroom/);

  const storeImageSrc = fs.readFileSync(path.resolve('src/modules/storefront/StoreImage.tsx'), 'utf8');
  assert.match(storeImageSrc, /animate-pulse/);
  assert.match(storeImageSrc, /imgRef\.current\?\.complete/);

  for (const rel of [
    'src/modules/storefront/StoreProductDetail.tsx',
    'src/modules/storefront/StoreCheckoutDrawer.tsx',
    'src/modules/storefront/StoreAccountViews.tsx',
  ]) {
    const src = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.match(src, /StoreImage/, `${rel} should render StoreImage skeletons`);
  }
});

test('Phase 3 (BUG-MIN-03 & BUG-MIN-04): Bathware nav filter, Catalogue reset, and 1-click Search all collections CTA', () => {
  const items = [
    makeTileItem({ id: 't1', name: 'Italian Floor Tile', product_line: 'tiles_slabs' }),
    makeTileItem({ id: 's1', name: 'Rimless Wall Basin', product_line: 'sanitaryware', specs: {} }),
    makeTileItem({ id: 'f1', name: 'Brushed Brass Mixer', product_line: 'faucets_cp', specs: {} }),
  ];

  // Composite bathware filter includes both sanitaryware & faucets_cp
  const bathware = filterStoreProducts(items, { productLine: 'bathware' });
  assert.deepEqual(
    bathware.map((i) => i.id),
    ['s1', 'f1']
  );

  const storefrontApp = fs.readFileSync(path.resolve('src/StorefrontApp.tsx'), 'utf8');
  assert.match(storefrontApp, /setLineFilter\('bathware'\)/);
  assert.match(storefrontApp, /setLineFilter\('all'\);\s*navigate\('\/catalogue'\)/);
  assert.match(storefrontApp, /Search all collections/);
});

test('Phase 3 (Tax/GST Summary & Guest Order Tracking): Bag renders explicit GST line (₹0.00 Non-GST) and /orders supports guest lookup', () => {
  // Non-GST business reports taxAmount === 0 cleanly
  const nonGstTotals = computeStoreOrderTotals({
    lines: [{ unitPrice: 1450, baseQty: 2, gstRate: 18, taxInclusive: true }],
    fulfillmentType: 'pickup',
    gstRegistered: false,
  });
  assert.equal(nonGstTotals.subtotal, 2900);
  assert.equal(nonGstTotals.taxAmount, 0);
  assert.equal(nonGstTotals.grandTotal, 2900);

  // GST-registered business computes included GST portion accurately
  const gstTotals = computeStoreOrderTotals({
    lines: [{ unitPrice: 1180, baseQty: 1, gstRate: 18, taxInclusive: true }],
    fulfillmentType: 'pickup',
    gstRegistered: true,
  });
  assert.equal(gstTotals.subtotal, 1180);
  assert.equal(gstTotals.taxAmount, 180);
  assert.equal(gstTotals.grandTotal, 1180);

  const drawerSrc = fs.readFileSync(path.resolve('src/modules/storefront/StoreCheckoutDrawer.tsx'), 'utf8');
  assert.match(drawerSrc, /Tax \/ GST \(Non-GST\)/);
  assert.match(drawerSrc, /minimumFractionDigits:\s*2/);

  const accountViewsSrc = fs.readFileSync(path.resolve('src/modules/storefront/StoreAccountViews.tsx'), 'utf8');
  assert.match(accountViewsSrc, /Track Order or Sign In/);
  assert.match(accountViewsSrc, /Guest Order Tracking \(Order ID \+ Phone\)/);
  assert.match(accountViewsSrc, /Account Sign-In Required for Checkout &amp; Cancellation/);

  const storefrontRoute = fs.readFileSync(path.resolve('src/server/routes/storefront.ts'), 'utf8');
  assert.match(storefrontRoute, /gstRegistered:\s*Boolean\(biz\?\.gst_registered\)/);
  assert.match(storefrontRoute, /customer_id.*customers.*phone/s);
});
