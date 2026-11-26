import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createEmptyServiceSpecs,
  formatServiceSpecSummary,
  normalizeServiceSpecsFromMetadata,
  validateServiceSpecs,
} from '../src/core/productSpecs.ts';
import { AI_TOOL_ALLOWLIST, isToolAllowedForContext } from '../src/server/aiGateway.ts';

test('Step 6 (1): Service (Non-Stock) specs are decoupled from physical product lines and validate cleanly', () => {
  const empty = createEmptyServiceSpecs({ sacCode: '995461' });
  const invalid = validateServiceSpecs(empty);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.service_category);

  const populated = {
    ...empty,
    service_category: 'Tile / Marble Laying',
    billing_basis: 'Per Sq.Ft',
    est_duration: '2 Days',
    service_area: 'Jaipur City',
    scope_deliverables: 'Floor leveling, adhesive laying, epoxy grouting',
  };
  const valid = validateServiceSpecs(populated);
  assert.equal(valid.valid, true);
  assert.equal(valid.cleaned.sac_code, '995461');

  const normalized = normalizeServiceSpecsFromMetadata({ service_specs: valid.cleaned });
  assert.equal(normalized.service_category, 'Tile / Marble Laying');
  assert.match(formatServiceSpecSummary({ service_specs: valid.cleaned }), /Tile \/ Marble Laying/);

  // ItemFormModal branches cleanly for services without physical product-line selector or physical specs
  const itemFormSrc = fs.readFileSync(path.resolve('src/modules/items/ItemFormModal.tsx'), 'utf8');
  assert.match(itemFormSrc, /itemType === 'goods'/);
  assert.match(itemFormSrc, /<ServiceSpecFields/);
  assert.match(itemFormSrc, /validateServiceSpecs/);
});

test('Step 6 (2): Online Store publishing controls exist in BOTH ItemFormModal and OnlineStoreAdminScreen via /api/erp/*', () => {
  const itemFormSrc = fs.readFileSync(path.resolve('src/modules/items/ItemFormModal.tsx'), 'utf8');
  assert.match(itemFormSrc, /publishOnline/);
  assert.match(itemFormSrc, /onlinePrice/);
  assert.match(itemFormSrc, /onlineSlug/);
  assert.match(itemFormSrc, /onlineDescription/);
  assert.match(itemFormSrc, /\/api\/erp\/store-admin\/items\//);

  const storeAdminScreen = fs.readFileSync(path.resolve('src/modules/store/OnlineStoreAdminScreen.tsx'), 'utf8');
  assert.match(storeAdminScreen, /Add Online Item/);
  assert.match(storeAdminScreen, /POST/);
  assert.match(storeAdminScreen, /\/api\/erp\/store-admin\/items/);
  assert.match(storeAdminScreen, /\/api\/erp\/ai\/store-assist/);

  // Ensure no unprefixed staff calls slipped into store admin or item modal
  assert.doesNotMatch(storeAdminScreen, /['"`]\/api\/store-admin\//);
  assert.doesNotMatch(storeAdminScreen, /['"`]\/api\/ai\//);
  assert.doesNotMatch(itemFormSrc, /['"`]\/api\/store-admin\//);
  assert.doesNotMatch(itemFormSrc, /['"`]\/api\/ai\//);

  const storeAdminRoute = fs.readFileSync(path.resolve('src/server/routes/storeAdmin.ts'), 'utf8');
  assert.match(storeAdminRoute, /app\.post\('\/api\/store-admin\/items'/);
  assert.match(storeAdminRoute, /item_type/);
});

test('Step 6 (3): Root / returns HTTP 404 when online_store toggle is disabled and storefront stays isolated from /ERP', async () => {
  process.env.DECORBIZ_NO_LISTEN = '1';
  const { isStorefrontPageRequest } = await import('../server.ts');
  const serverSrc = fs.readFileSync(path.resolve('server.ts'), 'utf8');
  assert.match(serverSrc, /gateDisabledStorefront/);
  assert.match(serverSrc, /index:\s*false/);
  assert.match(serverSrc, /sendStorefrontDisabled404/);

  assert.equal(isStorefrontPageRequest('/'), true);
  assert.equal(isStorefrontPageRequest('/catalogue'), true);
  assert.equal(isStorefrontPageRequest('/product/italian-marble'), true);
  assert.equal(isStorefrontPageRequest('/ERP'), false);
  assert.equal(isStorefrontPageRequest('/ERP/items'), false);
  assert.equal(isStorefrontPageRequest('/api/erp/items'), false);
  assert.equal(isStorefrontPageRequest('/api/store/config'), false);
  assert.equal(isStorefrontPageRequest('/assets/index-123.js'), false);

  for (const rel of [
    'src/StorefrontApp.tsx',
    'src/modules/storefront/StoreAiAssistant.tsx',
    'src/modules/storefront/storeTypes.ts',
  ]) {
    const content = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.doesNotMatch(content, /\/erp/i, `${rel} must never reference /ERP`);
  }
});

test('Step 6 (4): DecorBiz AI Agent extends cleanly to both ERP Online Store Copilot and Storefront Customer AI Assistant', () => {
  for (const key of [
    'get_store_catalogue_summary',
    'get_store_orders_summary',
    'get_store_content_summary',
    'propose_store_item_listing',
    'propose_store_banner',
    'propose_store_page',
    'propose_store_coupon',
  ]) {
    assert.ok(AI_TOOL_ALLOWLIST[key], `Expected AI tool ${key} in allowlist`);
  }

  const allMods = new Set(['online_store', 'inventory', 'ai', 'billing']);
  assert.equal(isToolAllowedForContext('propose_store_banner', 'owner', allMods).allowed, true);
  assert.equal(isToolAllowedForContext('propose_store_banner', 'manager', allMods).allowed, true);
  assert.equal(isToolAllowedForContext('propose_store_banner', 'cashier', allMods).allowed, false);
  assert.equal(
    isToolAllowedForContext('get_store_catalogue_summary', 'owner', new Set(['inventory'])).allowed,
    false
  );

  const aiRouteSrc = fs.readFileSync(path.resolve('src/server/routes/ai.ts'), 'utf8');
  assert.match(aiRouteSrc, /\/api\/ai\/store-assist/);

  const storefrontRouteSrc = fs.readFileSync(path.resolve('src/server/routes/storefront.ts'), 'utf8');
  assert.match(storefrontRouteSrc, /\/api\/store\/ai\/chat/);
  assert.match(storefrontRouteSrc, /aiAssistantEnabled/);
  assert.match(storefrontRouteSrc, /published_store_items_view/);

  const storefrontAppSrc = fs.readFileSync(path.resolve('src/StorefrontApp.tsx'), 'utf8');
  assert.match(storefrontAppSrc, /<StoreAiAssistant/);
});

test('Step 6 (5): All ERP screen <h1> headings include SVG icons cleanly', () => {
  const erpScreensWithHeadingIcons = [
    'src/modules/items/ItemsScreen.tsx',
    'src/modules/items/ItemDetailView.tsx',
    'src/modules/parties/PartiesScreen.tsx',
    'src/modules/parties/PartyDetailView.tsx',
    'src/modules/payments/PaymentsScreen.tsx',
    'src/modules/purchases/PurchasesScreen.tsx',
    'src/modules/purchases/NewPurchaseScreen.tsx',
    'src/modules/bills/BillsScreen.tsx',
    'src/modules/bills/NewBillScreen.tsx',
    'src/modules/bills/BillDetailView.tsx',
    'src/modules/bills/PublicBillShareView.tsx',
    'src/modules/expenses/ExpensesScreen.tsx',
    'src/modules/dashboard/HomeScreen.tsx',
    'src/modules/profile/UserProfileScreen.tsx',
    'src/modules/help/HelpScreen.tsx',
    'src/modules/auth/AuthScreens.tsx',
  ];

  for (const rel of erpScreensWithHeadingIcons) {
    const src = fs.readFileSync(path.resolve(rel), 'utf8');
    // Match <h1> block (up to 400 chars preceding or inside <h1>) containing <Icon
    const hasHeadingIcon =
      /<h1[^>]*>[\s\S]{0,220}<Icon[A-Z]/.test(src) ||
      /<Icon[A-Z][^>]*>[\s\S]{0,220}<h1/.test(src);
    assert.equal(hasHeadingIcon, true, `Expected Tabler <Icon...> SVG near/before <h1> in ${rel}`);
  }
});
