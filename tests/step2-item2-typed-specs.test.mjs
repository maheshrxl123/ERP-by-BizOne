import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createEmptySpecs,
  formatItemSpecSummary,
  getLineFilterDefinitions,
  matchesLineSpecFilters,
  validateProductSpecs,
} from '../src/core/productSpecs.ts';

test('Step 2 Item 2: empty required fields fail validation for every product line', () => {
  // 1. tiles_slabs
  const emptyTile = createEmptySpecs('tiles_slabs');
  const tileRes = validateProductSpecs('tiles_slabs', emptyTile);
  assert.equal(tileRes.valid, false);
  for (const field of [
    'size_length_mm',
    'size_width_mm',
    'thickness_mm',
    'pieces_per_box',
    'sqft_per_box',
    'sqm_per_box',
    'weight_per_box_kg',
    'shade',
    'batch_lot',
    'series',
    'design_name',
  ]) {
    assert.ok(tileRes.errors[field], `Expected validation error for empty ${field}`);
  }

  // 2. sanitaryware
  const emptySan = createEmptySpecs('sanitaryware');
  const sanRes = validateProductSpecs('sanitaryware', emptySan);
  assert.equal(sanRes.valid, false);
  for (const field of ['colour', 'flush_type_and_litres', 'set_contents', 'dimensions', 'warranty']) {
    assert.ok(sanRes.errors[field], `Expected validation error for empty ${field}`);
  }

  // 3. faucets_cp
  const emptyFaucet = createEmptySpecs('faucets_cp');
  const faucetRes = validateProductSpecs('faucets_cp', emptyFaucet);
  assert.equal(faucetRes.valid, false);
  for (const field of ['size_and_connection', 'cartridge_type', 'flow_rate', 'warranty']) {
    assert.ok(faucetRes.errors[field], `Expected validation error for empty ${field}`);
  }

  // 4. tile_adhesive
  const emptyAdh = createEmptySpecs('tile_adhesive');
  const adhRes = validateProductSpecs('tile_adhesive', emptyAdh);
  assert.equal(adhRes.valid, false);
  for (const field of [
    'grade',
    'pack_size_and_unit',
    'coverage_per_pack',
    'pot_life',
    'shelf_life',
    'colour',
  ]) {
    assert.ok(adhRes.errors[field], `Expected validation error for empty ${field}`);
  }

  // 5. other_general
  const emptyGen = createEmptySpecs('other_general');
  const genRes = validateProductSpecs('other_general', emptyGen);
  assert.equal(genRes.valid, false);
  for (const field of ['item_label', 'size_or_description', 'colour', 'material']) {
    assert.ok(genRes.errors[field], `Expected validation error for empty ${field}`);
  }
});

test('Step 2 Item 2: valid specifications pass for all 5 product lines and support list filtering', () => {
  const validTile = {
    size_length_mm: 600,
    size_width_mm: 1200,
    thickness_mm: 9,
    material: 'vitrified',
    finish: 'glossy',
    use_area: 'floor',
    pieces_per_box: 2,
    sqft_per_box: 15.5,
    sqm_per_box: 1.44,
    weight_per_box_kg: 29,
    shade: 'A1',
    batch_lot: 'LOT-901',
    series: 'Royal Stone',
    design_name: 'Statuario Pearl',
    anti_skid: false,
    anti_bacterial: true,
  };
  const tileCheck = validateProductSpecs('tiles_slabs', validTile);
  assert.equal(tileCheck.valid, true);
  assert.equal(tileCheck.cleaned.size_length_mm, 600);
  assert.equal(tileCheck.cleaned.pieces_per_box, 2);

  const validSan = {
    product_type: 'WC',
    mounting: 'wall-hung',
    trap_type: 'P',
    colour: 'Alpine White',
    material: 'Ceramic',
    flush_type_and_litres: 'Dual Flush 3/6L',
    seat_cover_included: true,
    set_contents: 'Pan + Seat Cover + Fixing Kit',
    dimensions: '540x365x380 mm',
    warranty: '10 Years',
  };
  assert.equal(validateProductSpecs('sanitaryware', validSan).valid, true);

  const validFaucet = {
    product_type: 'mixer',
    finish: 'chrome',
    body_material: 'brass',
    size_and_connection: '1/2 BSP',
    operation: 'single-lever',
    cartridge_type: '35mm Ceramic Disc',
    flow_rate: '6.5 LPM',
    warranty: '7 Years',
  };
  assert.equal(validateProductSpecs('faucets_cp', validFaucet).valid, true);

  const validAdh = {
    adhesive_type: 'cement-based',
    grade: 'C2TE',
    pack_size_and_unit: '20 kg bag',
    coverage_per_pack: '60 sq.ft',
    pot_life: '3 Hours',
    shelf_life: '12 Months',
    colour: 'Grey',
    suitable_for: 'floor',
  };
  assert.equal(validateProductSpecs('tile_adhesive', validAdh).valid, true);

  const validGen = {
    item_label: 'SS Cockroach Trap',
    unit_label: 'PCS',
    size_or_description: '125x125 mm',
    colour: 'Brushed Steel',
    material: 'SS 304',
    attributes: { grade: 'AISI 304', thickness: '1.2mm' },
  };
  const genCheck = validateProductSpecs('other_general', validGen);
  assert.equal(genCheck.valid, true);
  assert.deepEqual(genCheck.cleaned.attributes, { grade: 'AISI 304', thickness: '1.2mm' });

  // Line list filters
  assert.ok(getLineFilterDefinitions('tiles_slabs').some((d) => d.key === 'finish'));
  assert.ok(
    matchesLineSpecFilters(
      { product_line: 'tiles_slabs', specs: tileCheck.cleaned },
      'tiles_slabs',
      { finish: 'glossy', shade: 'a1' }
    )
  );
  assert.equal(
    matchesLineSpecFilters(
      { product_line: 'tiles_slabs', specs: tileCheck.cleaned },
      'tiles_slabs',
      { finish: 'matte' }
    ),
    false
  );
  assert.ok(formatItemSpecSummary('tiles_slabs', tileCheck.cleaned).includes('600×1200 mm'));
});

test('Step 2 Item 2: migration 0020 creates all 5 typed spec tables with constraints and updates save_item', () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0020_decorbiz_step2_item_specs.sql'),
    'utf8'
  );
  for (const tbl of [
    'item_specs_tiles_slabs',
    'item_specs_sanitaryware',
    'item_specs_faucets_cp',
    'item_specs_tile_adhesive',
    'item_specs_other_general',
  ]) {
    assert.ok(
      sql.includes(`CREATE TABLE IF NOT EXISTS public.${tbl}`),
      `Missing table public.${tbl} in migration 0020`
    );
  }
  assert.ok(sql.includes('CREATE OR REPLACE VIEW public.item_catalog_view'));
  assert.ok(sql.includes('p_specs jsonb DEFAULT NULL'));
});
