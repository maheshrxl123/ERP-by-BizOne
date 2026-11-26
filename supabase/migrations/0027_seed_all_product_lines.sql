-- DecorBiz - Migration 0027:
--   Update seed_demo_data() to seed 1 demo item in each of the 5 fixed product lines
--   ('tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general')
--   along with valid typed specification rows in item_specs_*.

CREATE OR REPLACE FUNCTION public.seed_demo_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_pcs_id uuid;
  v_box_id uuid;
  v_cat_id uuid;
  v_party1 uuid;
  v_party2 uuid;
  v_site1 uuid;
  v_tile_id uuid;
  v_san_id uuid;
  v_cp_id uuid;
  v_adh_id uuid;
  v_gen_id uuid;
BEGIN
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Only Owner or Manager can load demo data.';
  END IF;

  IF public.is_owner() THEN
    PERFORM public.remove_demo_data();
  END IF;

  SELECT id INTO v_pcs_id FROM public.item_units WHERE lower(code) IN ('pcs', 'pc', 'nos') ORDER BY is_system DESC LIMIT 1;
  IF v_pcs_id IS NULL THEN SELECT id INTO v_pcs_id FROM public.item_units LIMIT 1; END IF;
  SELECT id INTO v_box_id FROM public.item_units WHERE lower(code) = 'box' LIMIT 1;
  v_box_id := COALESCE(v_box_id, v_pcs_id);

  INSERT INTO public.item_categories (name, description, is_active)
  VALUES ('Tiles & Sanitaryware (Demo)', 'Sample DecorBiz showroom catalogue', true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_cat_id FROM public.item_categories ORDER BY created_at DESC LIMIT 1;

  INSERT INTO public.parties (name, party_type, phone, credit_days, is_demo, notes, created_by)
  VALUES ('Verma Constructions (Demo)', 'customer', '9876500101', 15, true, 'Sample contractor customer', auth.uid())
  RETURNING id INTO v_party1;

  INSERT INTO public.parties (name, party_type, phone, credit_days, is_demo, notes, created_by)
  VALUES ('Morbi Ceramic Depot (Demo)', 'supplier', '9876500202', 30, true, 'Sample tiles supplier', auth.uid())
  RETURNING id INTO v_party2;

  INSERT INTO public.party_sites (party_id, site_name, contact_name, contact_phone, address, is_demo)
  VALUES (v_party1, 'Greenwood Villa Site #4', 'Suresh Mistri', '9876500909', 'Plot 4, Sector 14', true)
  RETURNING id INTO v_site1;

  -- 1. Tiles & Slabs
  INSERT INTO public.items (
    name, sku, category_id, base_unit_id, product_line,
    selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert,
    pack_metadata, is_demo, created_by
  )
  VALUES (
    'Kajaria Vitrified Tile 2x2 Box', 'DB-TILE-2X2', v_cat_id, v_box_id, 'tiles_slabs',
    680, 750, 510, 18, '6907', 20,
    '{"sqft_per_box":15.5,"category_type":"tiles"}'::jsonb, true, auth.uid()
  )
  RETURNING id INTO v_tile_id;

  INSERT INTO public.item_specs_tiles_slabs (
    item_id, size_length_mm, size_width_mm, thickness_mm, material, finish, use_area,
    pieces_per_box, sqft_per_box, sqm_per_box, weight_per_box_kg,
    shade, batch_lot, series, design_name
  )
  VALUES (
    v_tile_id, 600, 600, 9, 'vitrified', 'glossy', 'floor',
    4, 15.50, 1.44, 26.5,
    'Ivory', 'LOT-2026-A1', 'Eternity', 'Statuario Classic'
  );

  -- 2. Sanitaryware
  INSERT INTO public.items (
    name, sku, category_id, base_unit_id, product_line,
    selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert,
    pack_metadata, is_demo, created_by
  )
  VALUES (
    'Hindware Wall-Hung WC Rimless', 'DB-SAN-WC01', v_cat_id, v_pcs_id, 'sanitaryware',
    8950, 10500, 6800, 18, '6910', 5,
    '{"category_type":"sanitaryware"}'::jsonb, true, auth.uid()
  )
  RETURNING id INTO v_san_id;

  INSERT INTO public.item_specs_sanitaryware (
    item_id, product_type, mounting, trap_type, colour, material,
    flush_type_and_litres, seat_cover_included, set_contents, dimensions, warranty
  )
  VALUES (
    v_san_id, 'WC', 'wall-hung', 'P', 'Starwhite', 'Vitreous China',
    'Dual Flush 3/6L', true, 'Bowl, Soft-Close Seat Cover, Fixing Kit', '540 x 360 x 355 mm', '10 Years'
  );

  -- 3. Faucets & CP
  INSERT INTO public.items (
    name, sku, category_id, base_unit_id, product_line,
    selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert,
    pack_metadata, is_demo, created_by
  )
  VALUES (
    'Jaquar Basin Mixer Chrome', 'DB-CP-01', v_cat_id, v_pcs_id, 'faucets_cp',
    3450, 3990, 2650, 18, '8481', 5,
    '{"category_type":"faucets"}'::jsonb, true, auth.uid()
  )
  RETURNING id INTO v_cp_id;

  INSERT INTO public.item_specs_faucets_cp (
    item_id, product_type, finish, body_material, size_and_connection,
    operation, cartridge_type, flow_rate, warranty
  )
  VALUES (
    v_cp_id, 'mixer', 'chrome', 'brass', '15mm (1/2" BSP)',
    'single-lever', '35mm Ceramic Disc', '11.5 LPM @ 3 Bar', '10 Years'
  );

  -- 4. Tile Adhesive
  INSERT INTO public.items (
    name, sku, category_id, base_unit_id, product_line,
    selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert,
    pack_metadata, is_demo, created_by
  )
  VALUES (
    'Roff T01 Tile Adhesive 20kg', 'DB-ADH-20KG', v_cat_id, v_pcs_id, 'tile_adhesive',
    420, 490, 310, 18, '3824', 15,
    '{"category_type":"adhesive"}'::jsonb, true, auth.uid()
  )
  RETURNING id INTO v_adh_id;

  INSERT INTO public.item_specs_tile_adhesive (
    item_id, adhesive_type, grade, pack_size_and_unit, coverage_per_pack,
    pot_life, shelf_life, colour, suitable_for
  )
  VALUES (
    v_adh_id, 'cement-based', 'C1T', '20 kg Bag', '45-55 sq.ft @ 3mm',
    '3 Hours', '12 Months', 'Grey', 'floor'
  );

  -- 5. Other / General
  INSERT INTO public.items (
    name, sku, category_id, base_unit_id, product_line,
    selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert,
    pack_metadata, is_demo, created_by
  )
  VALUES (
    'SS Tile Spacer 2mm (Pack of 100)', 'DB-GEN-SP2', v_cat_id, v_pcs_id, 'other_general',
    120, 150, 80, 18, '3926', 25,
    '{"category_type":"other_general"}'::jsonb, true, auth.uid()
  )
  RETURNING id INTO v_gen_id;

  INSERT INTO public.item_specs_other_general (
    item_id, item_label, unit_label, size_or_description, colour, material
  )
  VALUES (
    v_gen_id, 'Tile Leveling Spacer', 'Pack of 100 Pcs', '2mm Uniform Joint Spacer', 'White', 'PP Plastic'
  );

  INSERT INTO public.stock_balances (item_id, qty_on_hand)
  SELECT id, 0 FROM public.items WHERE is_demo = true ON CONFLICT (item_id) DO NOTHING;

  INSERT INTO public.stock_ledger (
    item_id, movement_type, movement_date, entered_qty, entered_unit_id,
    conversion_factor, signed_base_qty, unit_cost, reason, source_table, source_id, is_demo, created_by
  )
  SELECT
    i.id, 'opening_stock', CURRENT_DATE, 30, i.base_unit_id, 1, 30,
    i.purchase_price, 'Demo opening stock', 'items', i.id, true, auth.uid()
  FROM public.items i
  WHERE i.is_demo = true AND i.item_type = 'goods'
    AND NOT EXISTS (SELECT 1 FROM public.stock_ledger sl WHERE sl.item_id = i.id);

  RETURN jsonb_build_object('pack', 'decorbiz', 'demo_items_seeded', 5, 'party_ids', jsonb_build_array(v_party1, v_party2));
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_demo_data() TO authenticated;
