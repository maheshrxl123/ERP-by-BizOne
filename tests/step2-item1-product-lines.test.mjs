import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  PRODUCT_LINES,
  PRODUCT_LINE_KEYS,
  filterTaxonomyByProductLine,
  getProductLineLabel,
  getProductLineMeta,
  isValidProductLine,
  isValidTaxonomyScope,
} from '../src/core/productLines.ts';

test('Step 2 Item 1: PRODUCT_LINES is frozen and strictly contains the 5 allowed product lines', () => {
  assert.deepEqual(PRODUCT_LINE_KEYS, [
    'tiles_slabs',
    'sanitaryware',
    'faucets_cp',
    'tile_adhesive',
    'other_general',
  ]);
  assert.equal(PRODUCT_LINES.length, 5);
  assert.equal(Object.isFrozen(PRODUCT_LINES), true);

  for (const line of PRODUCT_LINES) {
    assert.equal(Object.isFrozen(line), true);
    assert.ok(line.labelEn.length > 0 && line.labelHi.length > 0);
    assert.equal(isValidProductLine(line.key), true);
    assert.equal(isValidTaxonomyScope(line.key), true);
  }

  assert.equal(isValidProductLine('kirana'), false);
  assert.equal(isValidProductLine('medical'), false);
  assert.equal(isValidProductLine('all'), false);
  assert.equal(isValidTaxonomyScope('all'), true);
  assert.equal(getProductLineMeta('unknown').key, 'other_general');
  assert.equal(getProductLineLabel('tiles_slabs', 'en'), 'Tiles & Slabs');
});

test('Step 2 Item 1: filterTaxonomyByProductLine filters categories, brands, and units per product line', () => {
  const rows = [
    { id: '1', name: 'Global', product_line: 'all' },
    { id: '2', name: 'GVT Tiles', product_line: 'tiles_slabs' },
    { id: '3', name: 'Wall Hung WC', product_line: 'sanitaryware' },
    { id: '4', name: 'Epoxy Grout', product_line: 'tile_adhesive' },
  ];

  assert.equal(filterTaxonomyByProductLine(rows, 'all').length, 4);
  assert.deepEqual(
    filterTaxonomyByProductLine(rows, 'tiles_slabs').map((r) => r.id),
    ['1', '2']
  );
  assert.deepEqual(
    filterTaxonomyByProductLine(rows, 'sanitaryware').map((r) => r.id),
    ['1', '3']
  );
});

test('Step 2 Item 1: SQL migration 0019 enforces 5-line CHECK constraint and no line-creation RPCs exist', () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0019_decorbiz_step2_product_lines.sql'),
    'utf8'
  );

  assert.ok(
    sql.includes("CHECK (product_line IN ('tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general'))"),
    'items table must constrain product_line to the 5 fixed lines'
  );
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS supplier_id'));
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS country_of_origin'));
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS warranty_months'));
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS video_url'));
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS description'));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.save_item_category('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.save_brand('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.save_item_unit('));
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.save_item('));
  assert.equal(sql.includes('save_product_line'), false, 'No RPC may allow creating/renaming product lines');
});
