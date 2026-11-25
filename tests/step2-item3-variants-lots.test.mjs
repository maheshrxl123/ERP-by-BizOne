import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MODULE_REGISTRY } from '../config/modules.config.ts';
import { detectMixedLotsOnBill } from '../src/core/lotTracking.ts';
import { SQFT_PER_SQM } from '../src/core/productSpecs.ts';

test('Step 2 Item 3: detectMixedLotsOnBill flags mixed shade or batch lot on tile items', () => {
  const cleanLines = [
    { item_id: 'item-1', item_name: 'Marble Tile', product_line: 'tiles_slabs', shade: 'A1', batch_lot: 'LOT-100' },
    { item_id: 'item-1', item_name: 'Marble Tile', product_line: 'tiles_slabs', shade: 'A1', batch_lot: 'LOT-100' },
  ];
  assert.equal(detectMixedLotsOnBill(cleanLines).length, 0);

  const mixedShadeLines = [
    { item_id: 'item-1', item_name: 'Marble Tile', product_line: 'tiles_slabs', shade: 'A1', batch_lot: 'LOT-100' },
    { item_id: 'item-1', item_name: 'Marble Tile', product_line: 'tiles_slabs', shade: 'A2', batch_lot: 'LOT-100' },
  ];
  const warnings1 = detectMixedLotsOnBill(mixedShadeLines);
  assert.equal(warnings1.length, 1);
  assert.equal(warnings1[0].itemId, 'item-1');

  const mixedLotLines = [
    { item_id: 'item-2', item_name: 'Wood Tile', product_line: 'tiles_slabs', shade: 'B1', batch_lot: 'LOT-X' },
    { item_id: 'item-2', item_name: 'Wood Tile', product_line: 'tiles_slabs', shade: 'B1', batch_lot: 'LOT-Y' },
  ];
  const warnings2 = detectMixedLotsOnBill(mixedLotLines);
  assert.equal(warnings2.length, 1);

  // Non-tile items should not trigger lot warning
  const otherLines = [
    { item_id: 'item-3', item_name: 'Basin Mixer', product_line: 'faucets_cp', shade: '', batch_lot: '' },
    { item_id: 'item-3', item_name: 'Basin Mixer', product_line: 'faucets_cp', shade: 'Gold', batch_lot: 'L2' },
  ];
  assert.equal(detectMixedLotsOnBill(otherLines).length, 0);
});

test('Step 2 Modules & Tile Conversions: 7 optional modules registered, legacy calculators removed, and 0024 schema complete', () => {
  const keys = new Set(MODULE_REGISTRY.map((m) => m.key));
  for (const reqKey of [
    'estimator',
    'breakage_returns',
    'samples',
    'contractor_rate_cards',
    'commissions',
    'supplier_price_lists',
    'delivery_trips',
  ]) {
    assert.ok(keys.has(reqKey), `MODULE_REGISTRY must include ${reqKey}`);
  }

  const registrySrc = fs.readFileSync(path.resolve('src/packs/registry.ts'), 'utf8');
  assert.doesNotMatch(registrySrc, /id:\s*['"](?:paint|wire)['"]/);

  const sql0024 = fs.readFileSync(
    path.resolve('supabase/migrations/0024_decorbiz_step2_modules_and_security.sql'),
    'utf8'
  );
  for (const tbl of [
    'breakage_returns',
    'sample_issues',
    'contractor_rate_cards',
    'commission_entries',
    'supplier_price_lists',
    'erp_delivery_trips',
  ]) {
    assert.match(sql0024, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tbl}`));
  }
  assert.match(sql0024, /REVOKE ALL ON public\.staff_totp FROM anon, authenticated/);
  assert.match(sql0024, /'store_banner'/);

  const itemFormSrc = fs.readFileSync(path.resolve('src/modules/items/ItemFormModal.tsx'), 'utf8');
  assert.match(itemFormSrc, /SQFT_PER_SQM/);
  assert.ok(Math.abs(SQFT_PER_SQM - 10.7639104) < 0.0001);
});
