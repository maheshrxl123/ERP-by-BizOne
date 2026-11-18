-- BizOne ERP - Phase P6 (Part 2): Batch CSV/XLSX Import, Pack Switching, Demo Data Lifecycle & Enhanced Backup/Restore (p6-v1 + p5-v1)

-- ============================================================================
-- 1. CSV/XLSX Batch Import RPCs
-- ============================================================================
CREATE OR REPLACE FUNCTION public.import_parties_batch(
  p_rows jsonb,
  p_duplicate_mode text DEFAULT 'skip',
  p_file_name text DEFAULT 'parties_import.csv'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_mode text := CASE WHEN p_duplicate_mode IN ('skip', 'update', 'error') THEN p_duplicate_mode ELSE 'skip' END;
  v_row jsonb;
  v_idx integer := 0;
  v_name text;
  v_ptype text;
  v_phone text;
  v_email text;
  v_gstin text;
  v_tier text;
  v_ob numeric(15,2);
  v_ob_type text;
  v_credit_limit numeric(15,2);
  v_credit_days integer;
  v_addr1 text;
  v_city text;
  v_state text;
  v_pincode text;
  v_existing_id uuid;
  v_new_party_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_error_count integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_job_id uuid;
  v_actor_email text;
  v_ob_ref text;
BEGIN
  PERFORM public.require_module('parties');
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can import parties.';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Import rows array is required.';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    v_idx := v_idx + 1;
    BEGIN
      v_name := trim(COALESCE(v_row->>'name', ''));
      IF length(v_name) < 1 THEN
        RAISE EXCEPTION 'Party name is required.';
      END IF;

      v_ptype := lower(trim(COALESCE(NULLIF(v_row->>'party_type', ''), 'customer')));
      IF v_ptype NOT IN ('customer', 'supplier', 'both') THEN
        v_ptype := 'customer';
      END IF;

      v_phone := NULLIF(trim(COALESCE(v_row->>'phone', '')), '');
      v_email := NULLIF(trim(COALESCE(v_row->>'email', '')), '');
      v_gstin := NULLIF(upper(trim(COALESCE(v_row->>'gstin', ''))), '');
      IF v_gstin IS NOT NULL AND v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$' THEN
        RAISE EXCEPTION 'Invalid GSTIN "%".', v_gstin;
      END IF;

      v_tier := lower(trim(COALESCE(NULLIF(v_row->>'price_tier', ''), 'standard')));
      IF v_tier NOT IN ('standard', 'wholesale_a', 'wholesale_b', 'vip') THEN
        v_tier := 'standard';
      END IF;

      v_ob := GREATEST(0, round(COALESCE(NULLIF(v_row->>'opening_balance', '')::numeric, 0), 2));
      v_ob_type := lower(trim(COALESCE(NULLIF(v_row->>'opening_balance_type', ''), 'to_receive')));
      IF v_ob_type NOT IN ('to_receive', 'to_give') THEN v_ob_type := 'to_receive'; END IF;
      v_credit_limit := GREATEST(0, round(COALESCE(NULLIF(v_row->>'credit_limit', '')::numeric, 0), 2));
      v_credit_days := GREATEST(0, COALESCE(NULLIF(v_row->>'credit_days', '')::integer, 0));

      v_existing_id := NULL;
      IF v_gstin IS NOT NULL THEN
        SELECT id INTO v_existing_id FROM public.parties WHERE upper(gstin) = v_gstin LIMIT 1;
      END IF;
      IF v_existing_id IS NULL AND v_phone IS NOT NULL THEN
        SELECT id INTO v_existing_id FROM public.parties WHERE phone = v_phone LIMIT 1;
      END IF;
      IF v_existing_id IS NULL THEN
        SELECT id INTO v_existing_id FROM public.parties WHERE lower(name) = lower(v_name) LIMIT 1;
      END IF;

      IF v_existing_id IS NOT NULL THEN
        IF v_mode = 'error' THEN
          RAISE EXCEPTION 'Duplicate party "%" already exists.', v_name;
        ELSIF v_mode = 'skip' THEN
          v_skipped := v_skipped + 1;
          CONTINUE;
        ELSE
          UPDATE public.parties
          SET party_type = v_ptype,
              phone = COALESCE(v_phone, phone),
              email = COALESCE(v_email, email),
              gstin = COALESCE(v_gstin, gstin),
              credit_limit = v_credit_limit,
              credit_days = v_credit_days,
              price_tier = v_tier,
              notes = COALESCE(NULLIF(trim(COALESCE(v_row->>'notes', '')), ''), notes),
              version = version + 1
          WHERE id = v_existing_id;
          v_updated := v_updated + 1;
          CONTINUE;
        END IF;
      END IF;

      INSERT INTO public.parties (
        name, party_type, phone, email, gstin, opening_balance, opening_balance_type,
        opening_balance_date, credit_limit, credit_days, notes, price_tier, created_by
      )
      VALUES (
        v_name, v_ptype, v_phone, v_email, v_gstin, v_ob, v_ob_type, CURRENT_DATE,
        v_credit_limit, v_credit_days, NULLIF(trim(COALESCE(v_row->>'notes', '')), ''),
        v_tier, auth.uid()
      )
      RETURNING id INTO v_new_party_id;

      v_addr1 := NULLIF(trim(COALESCE(v_row->>'address', v_row->>'address_line1', '')), '');
      v_city := NULLIF(trim(COALESCE(v_row->>'city', '')), '');
      v_state := NULLIF(trim(COALESCE(v_row->>'state', '')), '');
      v_pincode := NULLIF(trim(COALESCE(v_row->>'pincode', '')), '');
      IF v_addr1 IS NOT NULL OR v_city IS NOT NULL THEN
        INSERT INTO public.party_addresses (party_id, label, address_line1, city, state, pincode, is_default)
        VALUES (v_new_party_id, 'Primary', COALESCE(v_addr1, v_city), v_city, v_state, v_pincode, true);
      END IF;

      IF v_ob > 0 THEN
        v_ob_ref := public.next_document_number('opening_balance', CURRENT_DATE);
        INSERT INTO public.party_ledger_entries (
          party_id, entry_type, entry_date, due_date, reference_no, source_table, source_id, signed_amount, note, created_by
        )
        VALUES (
          v_new_party_id, 'opening_balance', CURRENT_DATE,
          CASE WHEN v_credit_days > 0 THEN CURRENT_DATE + v_credit_days ELSE CURRENT_DATE END,
          v_ob_ref, 'parties', v_new_party_id,
          CASE WHEN v_ob_type = 'to_receive' THEN v_ob ELSE -v_ob END,
          'Imported opening balance', auth.uid()
        );
      END IF;

      v_inserted := v_inserted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_error_count := v_error_count + 1;
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'row', v_idx,
        'name', COALESCE(v_row->>'name', ''),
        'error', SQLERRM
      ));
    END;
  END LOOP;

  INSERT INTO public.import_jobs (
    import_type, file_name, duplicate_mode, total_rows, inserted_count, updated_count, skipped_count, error_count, errors, created_by
  )
  VALUES ('parties', COALESCE(NULLIF(p_file_name, ''), 'parties_import.csv'), v_mode, v_idx, v_inserted, v_updated, v_skipped, v_error_count, v_errors, auth.uid())
  RETURNING id INTO v_job_id;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'import.parties', 'import_job', v_job_id::text,
    jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped, 'errors', v_error_count)
  );

  RETURN jsonb_build_object(
    'job_id', v_job_id, 'total_rows', v_idx,
    'inserted_count', v_inserted, 'updated_count', v_updated,
    'skipped_count', v_skipped, 'error_count', v_error_count, 'errors', v_errors
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.import_items_batch(
  p_rows jsonb,
  p_duplicate_mode text DEFAULT 'skip',
  p_file_name text DEFAULT 'items_import.csv'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_mode text := CASE WHEN p_duplicate_mode IN ('skip', 'update', 'error') THEN p_duplicate_mode ELSE 'skip' END;
  v_row jsonb;
  v_idx integer := 0;
  v_name text;
  v_sku text;
  v_barcode text;
  v_cat_name text;
  v_brand_name text;
  v_cat_id uuid;
  v_brand_id uuid;
  v_unit_code text;
  v_unit_id uuid;
  v_item_type text;
  v_sell numeric(15,2);
  v_mrp numeric(15,2);
  v_cost numeric(15,2);
  v_gst numeric(5,2);
  v_hsn text;
  v_open_stock numeric(15,3);
  v_low_alert numeric(15,3);
  v_pack_meta jsonb;
  v_existing_id uuid;
  v_new_item_id uuid;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_error_count integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_job_id uuid;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can import items.';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Import rows array is required.';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    v_idx := v_idx + 1;
    BEGIN
      v_name := trim(COALESCE(v_row->>'name', ''));
      IF length(v_name) < 1 THEN RAISE EXCEPTION 'Item name is required.'; END IF;

      v_sku := NULLIF(upper(trim(COALESCE(v_row->>'sku', ''))), '');
      v_barcode := NULLIF(upper(trim(COALESCE(v_row->>'barcode', ''))), '');
      v_item_type := CASE WHEN lower(trim(COALESCE(v_row->>'item_type', 'goods'))) = 'service' THEN 'service' ELSE 'goods' END;
      v_sell := GREATEST(0, round(COALESCE(NULLIF(v_row->>'selling_price', '')::numeric, 0), 2));
      v_mrp := CASE WHEN NULLIF(trim(COALESCE(v_row->>'mrp', '')), '') IS NOT NULL THEN GREATEST(0, round((v_row->>'mrp')::numeric, 2)) ELSE NULL END;
      v_cost := CASE WHEN v_role IN ('owner', 'manager') AND NULLIF(trim(COALESCE(v_row->>'purchase_price', '')), '') IS NOT NULL
        THEN GREATEST(0, round((v_row->>'purchase_price')::numeric, 2)) ELSE 0 END;
      v_gst := GREATEST(0, LEAST(28, round(COALESCE(NULLIF(v_row->>'gst_rate', '')::numeric, 0), 2)));
      v_hsn := NULLIF(trim(COALESCE(v_row->>'hsn_code', '')), '');
      v_open_stock := GREATEST(0, round(COALESCE(NULLIF(v_row->>'opening_stock', '')::numeric, 0), 3));
      v_low_alert := GREATEST(0, round(COALESCE(NULLIF(v_row->>'low_stock_alert', '')::numeric, 0), 3));

      v_cat_id := NULL;
      v_cat_name := NULLIF(trim(COALESCE(v_row->>'category', '')), '');
      IF v_cat_name IS NOT NULL THEN
        SELECT id INTO v_cat_id FROM public.item_categories WHERE lower(name) = lower(v_cat_name) LIMIT 1;
        IF v_cat_id IS NULL THEN
          INSERT INTO public.item_categories (name, is_active) VALUES (v_cat_name, true) RETURNING id INTO v_cat_id;
        END IF;
      END IF;

      v_brand_id := NULL;
      v_brand_name := NULLIF(trim(COALESCE(v_row->>'brand', '')), '');
      IF v_brand_name IS NOT NULL THEN
        SELECT id INTO v_brand_id FROM public.brands WHERE lower(name) = lower(v_brand_name) LIMIT 1;
        IF v_brand_id IS NULL THEN
          INSERT INTO public.brands (name, is_active) VALUES (v_brand_name, true) RETURNING id INTO v_brand_id;
        END IF;
      END IF;

      v_unit_code := lower(trim(COALESCE(NULLIF(v_row->>'unit', ''), 'pcs')));
      SELECT id INTO v_unit_id FROM public.item_units WHERE lower(code) = v_unit_code AND is_active = true LIMIT 1;
      IF v_unit_id IS NULL THEN
        SELECT id INTO v_unit_id FROM public.item_units WHERE is_active = true ORDER BY is_system DESC, code ASC LIMIT 1;
      END IF;

      v_pack_meta := '{}'::jsonb;
      IF NULLIF(v_row->>'salt', '') IS NOT NULL THEN v_pack_meta := v_pack_meta || jsonb_build_object('salt', v_row->>'salt'); END IF;
      IF NULLIF(v_row->>'schedule', '') IS NOT NULL THEN v_pack_meta := v_pack_meta || jsonb_build_object('schedule', upper(v_row->>'schedule')); END IF;
      IF NULLIF(v_row->>'warranty_months', '') IS NOT NULL THEN v_pack_meta := v_pack_meta || jsonb_build_object('warranty_months', (v_row->>'warranty_months')::integer); END IF;
      IF NULLIF(v_row->>'sac_code', '') IS NOT NULL THEN v_pack_meta := v_pack_meta || jsonb_build_object('sac_code', v_row->>'sac_code'); END IF;

      v_existing_id := NULL;
      IF v_sku IS NOT NULL THEN SELECT id INTO v_existing_id FROM public.items WHERE upper(sku) = v_sku LIMIT 1; END IF;
      IF v_existing_id IS NULL AND v_barcode IS NOT NULL THEN SELECT id INTO v_existing_id FROM public.items WHERE upper(barcode) = v_barcode LIMIT 1; END IF;
      IF v_existing_id IS NULL THEN SELECT id INTO v_existing_id FROM public.items WHERE lower(name) = lower(v_name) LIMIT 1; END IF;

      IF v_existing_id IS NOT NULL THEN
        IF v_mode = 'error' THEN
          RAISE EXCEPTION 'Duplicate item "%" already exists.', v_name;
        ELSIF v_mode = 'skip' THEN
          v_skipped := v_skipped + 1;
          CONTINUE;
        ELSE
          UPDATE public.items
          SET selling_price = v_sell,
              mrp = COALESCE(v_mrp, mrp),
              purchase_price = CASE WHEN v_role IN ('owner', 'manager') AND v_cost > 0 THEN v_cost ELSE purchase_price END,
              gst_rate = v_gst,
              hsn_code = COALESCE(v_hsn, hsn_code),
              category_id = COALESCE(v_cat_id, category_id),
              brand_id = COALESCE(v_brand_id, brand_id),
              low_stock_alert = v_low_alert,
              item_type = v_item_type,
              pack_metadata = pack_metadata || v_pack_meta,
              version = version + 1
          WHERE id = v_existing_id;
          v_updated := v_updated + 1;
          CONTINUE;
        END IF;
      END IF;

      INSERT INTO public.items (
        name, sku, barcode, category_id, brand_id, base_unit_id,
        selling_price, mrp, purchase_price, gst_rate, hsn_code,
        tax_inclusive, low_stock_alert, allow_negative_stock, item_type, pack_metadata, created_by
      )
      VALUES (
        v_name, v_sku, v_barcode, v_cat_id, v_brand_id, v_unit_id,
        v_sell, v_mrp, v_cost, v_gst, v_hsn,
        COALESCE((v_row->>'tax_inclusive')::boolean, false),
        CASE WHEN v_item_type = 'service' THEN 0 ELSE v_low_alert END,
        CASE WHEN v_item_type = 'service' THEN true ELSE COALESCE((v_row->>'allow_negative_stock')::boolean, false) END,
        v_item_type, v_pack_meta, auth.uid()
      )
      RETURNING id INTO v_new_item_id;

      INSERT INTO public.stock_balances (item_id, qty_on_hand) VALUES (v_new_item_id, 0) ON CONFLICT (item_id) DO NOTHING;

      IF v_item_type = 'goods' AND v_open_stock > 0 THEN
        INSERT INTO public.stock_ledger (
          item_id, movement_type, movement_date, entered_qty, entered_unit_id,
          conversion_factor, signed_base_qty, unit_cost, reason, source_table, source_id, created_by
        )
        VALUES (
          v_new_item_id, 'opening_stock', CURRENT_DATE, v_open_stock, v_unit_id, 1, v_open_stock,
          v_cost, 'Imported opening stock', 'items', v_new_item_id, auth.uid()
        );
      END IF;

      v_inserted := v_inserted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_error_count := v_error_count + 1;
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'row', v_idx,
        'name', COALESCE(v_row->>'name', ''),
        'error', SQLERRM
      ));
    END;
  END LOOP;

  INSERT INTO public.import_jobs (
    import_type, file_name, duplicate_mode, total_rows, inserted_count, updated_count, skipped_count, error_count, errors, created_by
  )
  VALUES ('items', COALESCE(NULLIF(p_file_name, ''), 'items_import.csv'), v_mode, v_idx, v_inserted, v_updated, v_skipped, v_error_count, v_errors, auth.uid())
  RETURNING id INTO v_job_id;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'import.items', 'import_job', v_job_id::text,
    jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped, 'errors', v_error_count)
  );

  RETURN jsonb_build_object(
    'job_id', v_job_id, 'total_rows', v_idx,
    'inserted_count', v_inserted, 'updated_count', v_updated,
    'skipped_count', v_skipped, 'error_count', v_error_count, 'errors', v_errors
  );
END;
$$;

-- ============================================================================
-- 2. Business Pack Switch, Demo Data Seed / Remove Only, & Workspace Reset
-- ============================================================================
CREATE OR REPLACE FUNCTION public.seed_pack_demo_data(p_pack text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_pack text;
  v_pcs_id uuid;
  v_kg_id uuid;
  v_g_id uuid;
  v_box_id uuid;
  v_hrs_id uuid;
  v_cat_id uuid;
  v_party1 uuid;
  v_party2 uuid;
  v_item1 uuid;
  v_item2 uuid;
  v_site1 uuid;
  v_job1 uuid;
  v_cnt integer := 0;
BEGIN
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Only Owner or Manager can load demo data.';
  END IF;

  SELECT COALESCE(NULLIF(trim(p_pack), ''), pack) INTO v_pack FROM public.business WHERE id = 1;

  -- Clean prior demo records first so demo stays crisp & non-duplicating
  IF public.is_owner() THEN
    PERFORM public.remove_demo_data();
  END IF;

  SELECT id INTO v_pcs_id FROM public.item_units WHERE lower(code) IN ('pcs', 'pc', 'nos') ORDER BY is_system DESC LIMIT 1;
  IF v_pcs_id IS NULL THEN SELECT id INTO v_pcs_id FROM public.item_units LIMIT 1; END IF;
  SELECT id INTO v_kg_id FROM public.item_units WHERE lower(code) = 'kg' LIMIT 1;
  SELECT id INTO v_g_id FROM public.item_units WHERE lower(code) = 'g' LIMIT 1;
  SELECT id INTO v_box_id FROM public.item_units WHERE lower(code) = 'box' LIMIT 1;
  SELECT id INTO v_hrs_id FROM public.item_units WHERE lower(code) IN ('hr', 'hrs', 'srv') LIMIT 1;
  v_kg_id := COALESCE(v_kg_id, v_pcs_id);
  v_box_id := COALESCE(v_box_id, v_pcs_id);
  v_hrs_id := COALESCE(v_hrs_id, v_pcs_id);

  INSERT INTO public.item_categories (name, description, is_active)
  VALUES (initcap(replace(v_pack, '_', ' ')) || ' Essentials', 'Demo pack category', true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_cat_id FROM public.item_categories ORDER BY created_at DESC LIMIT 1;

  -- Seed two realistic demo parties
  INSERT INTO public.parties (name, party_type, phone, credit_days, price_tier, is_demo, notes, created_by)
  VALUES
    (CASE v_pack
      WHEN 'medical' THEN 'Sharma Clinic & Health'
      WHEN 'hardware' THEN 'Verma Constructions'
      WHEN 'wholesale' THEN 'SuperMart Traders (Tier A)'
      WHEN 'service' THEN 'Horizon Tech Park'
      ELSE 'Ramesh Kumar (Demo)'
    END, 'customer', '9876500101', 15, CASE WHEN v_pack = 'wholesale' THEN 'wholesale_a' ELSE 'standard' END, true, 'Sample customer', auth.uid())
  RETURNING id INTO v_party1;

  INSERT INTO public.parties (name, party_type, phone, credit_days, price_tier, is_demo, notes, created_by)
  VALUES
    (CASE v_pack
      WHEN 'medical' THEN 'Cipla Medico Distributors'
      WHEN 'clothing' THEN 'Surat Textile Looms'
      ELSE 'National Distributors (Demo)'
    END, 'supplier', '9876500202', 30, 'standard', true, 'Sample supplier', auth.uid())
  RETURNING id INTO v_party2;

  IF v_pack = 'kirana' THEN
    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, low_stock_alert, pack_metadata, is_demo, created_by)
    VALUES
      ('Basmati Rice Loose', 'KIR-RICE-01', v_cat_id, v_kg_id, 110, 125, 88, 0, 10, '{"loose_weight":true,"shelf":"Rack A1"}'::jsonb, true, auth.uid()),
      ('Amul Gold Milk 500ml', 'KIR-MILK-01', v_cat_id, v_pcs_id, 34, 34, 31, 0, 12, '{"perishable":true,"shelf":"Chiller 1"}'::jsonb, true, auth.uid());
    IF v_g_id IS NOT NULL AND v_g_id <> v_kg_id THEN
      INSERT INTO public.unit_conversions (item_id, alternate_unit_id, conversion_factor)
      SELECT id, v_g_id, 0.001 FROM public.items WHERE sku = 'KIR-RICE-01' AND is_demo = true ON CONFLICT DO NOTHING;
    END IF;
    v_cnt := 2;

  ELSIF v_pack = 'medical' THEN
    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert, pack_metadata, is_demo, created_by)
    VALUES ('Dolo 650mg Strip (15 Tabs)', 'MED-DOLO-650', v_cat_id, v_pcs_id, 33, 35, 22, 12, '3004', 10, '{"salt":"Paracetamol 650mg","schedule":"OTC","manufacturer":"Micro Labs"}'::jsonb, true, auth.uid())
    RETURNING id INTO v_item1;
    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert, pack_metadata, is_demo, created_by)
    VALUES ('Azithral 500mg Tablet', 'MED-AZI-500', v_cat_id, v_pcs_id, 118, 126, 82, 12, '3004', 8, '{"salt":"Azithromycin 500mg","schedule":"H","manufacturer":"Alembic"}'::jsonb, true, auth.uid())
    RETURNING id INTO v_item2;

    INSERT INTO public.item_batches (item_id, batch_no, expiry_date, mrp, purchase_rate, selling_rate, qty_on_hand, is_demo)
    VALUES
      (v_item1, 'DL-26A', CURRENT_DATE + 240, 35, 22, 33, 40, true),
      (v_item2, 'AZ-25N', CURRENT_DATE + 45, 126, 82, 118, 15, true);
    v_cnt := 2;

  ELSIF v_pack = 'clothing' THEN
    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert, pack_metadata, is_demo, created_by)
    VALUES ('Cotton Printed Kurti', 'CLO-KUR-01', v_cat_id, v_pcs_id, 799, 999, 460, 5, '6204', 5, '{"fabric":"Pure Cotton","season":"Summer 26"}'::jsonb, true, auth.uid())
    RETURNING id INTO v_item1;

    INSERT INTO public.item_variants (item_id, size, color, sku, selling_price, mrp, purchase_price, qty_on_hand, is_demo)
    VALUES
      (v_item1, 'M', 'Indigo', 'CLO-KUR-01-M-IND', 799, 999, 460, 12, true),
      (v_item1, 'L', 'Indigo', 'CLO-KUR-01-L-IND', 799, 999, 460, 10, true),
      (v_item1, 'XL', 'Maroon', 'CLO-KUR-01-XL-MAR', 849, 1049, 480, 8, true);
    v_cnt := 3;

  ELSIF v_pack = 'hardware' THEN
    INSERT INTO public.party_sites (party_id, site_name, contact_name, contact_phone, address, is_demo)
    VALUES (v_party1, 'Greenwood Villa Site #4', 'Suresh Mistri', '9876500909', 'Plot 4, Sector 14', true)
    RETURNING id INTO v_site1;

    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert, pack_metadata, is_demo, created_by)
    VALUES
      ('Kajaria Vitrified Tile 2x2 Box', 'HW-TILE-01', v_cat_id, v_box_id, 680, 750, 510, 18, '6907', 20, '{"sqft_per_box":16,"category_type":"tiles"}'::jsonb, true, auth.uid()),
      ('Bosch Hammer Drill 650W', 'HW-DRILL-650', v_cat_id, v_pcs_id, 4250, 4990, 3300, 18, '8467', 3, '{"warranty_months":12,"brand":"Bosch"}'::jsonb, true, auth.uid());
    v_cnt := 2;

  ELSIF v_pack = 'wholesale' THEN
    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, low_stock_alert, wholesale_slabs, is_demo, created_by)
    VALUES (
      'Cooking Oil 15L Tin', 'WH-OIL-15L', v_cat_id, v_pcs_id, 2150, 2350, 1890, 5, 10,
      '[{"min_qty":5,"rate":2080,"tier":"all"},{"min_qty":20,"rate":2010,"tier":"wholesale_a"}]'::jsonb,
      true, auth.uid()
    )
    RETURNING id INTO v_item1;
    v_cnt := 1;

  ELSIF v_pack = 'service' THEN
    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, gst_rate, hsn_code, item_type, allow_negative_stock, pack_metadata, is_demo, created_by)
    VALUES
      ('Annual AC Preventive Maintenance', 'SRV-AC-AMC', v_cat_id, v_hrs_id, 1800, 18, '998719', 'service', true, '{"sac_code":"998719","duration_mins":90}'::jsonb, true, auth.uid()),
      ('On-Site IT Network Diagnostics', 'SRV-IT-DIAG', v_cat_id, v_hrs_id, 1200, 18, '998313', 'service', true, '{"sac_code":"998313","duration_mins":60}'::jsonb, true, auth.uid());

    INSERT INTO public.service_jobs (job_number, party_id, party_name, title, status, start_date, due_date, estimated_amount, is_demo, created_by)
    VALUES ('JOB-DEMO-01', v_party1, 'Horizon Tech Park', 'Q2 Office AC Servicing & Filter Cleaning', 'in_progress', CURRENT_DATE, CURRENT_DATE + 5, 7200, true, auth.uid())
    RETURNING id INTO v_job1;
    v_cnt := 2;

  ELSE
    -- general_retail
    INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, low_stock_alert, is_demo, created_by)
    VALUES
      ('Stainless Steel Flask 1L', 'RET-FLK-01', v_cat_id, v_pcs_id, 549, 699, 340, 18, 5, true, auth.uid()),
      ('LED Desk Lamp Rechargeable', 'RET-LAMP-02', v_cat_id, v_pcs_id, 799, 999, 490, 18, 5, true, auth.uid());
    v_cnt := 2;
  END IF;

  -- Seed initial opening stock_ledger for demo goods items
  INSERT INTO public.stock_balances (item_id, qty_on_hand)
  SELECT id, 0 FROM public.items WHERE is_demo = true ON CONFLICT (item_id) DO NOTHING;

  INSERT INTO public.stock_ledger (
    item_id, movement_type, movement_date, entered_qty, entered_unit_id,
    conversion_factor, signed_base_qty, unit_cost, reason, source_table, source_id, is_demo, created_by
  )
  SELECT
    i.id, 'opening_stock', CURRENT_DATE,
    CASE WHEN v_pack = 'medical' THEN 25 ELSE 30 END,
    i.base_unit_id, 1,
    CASE WHEN v_pack = 'medical' THEN 25 ELSE 30 END,
    i.purchase_price, 'Demo pack opening stock', 'items', i.id, true, auth.uid()
  FROM public.items i
  WHERE i.is_demo = true AND i.item_type = 'goods'
    AND NOT EXISTS (SELECT 1 FROM public.stock_ledger sl WHERE sl.item_id = i.id);

  RETURN jsonb_build_object('pack', v_pack, 'demo_items_seeded', v_cnt, 'party_ids', jsonb_build_array(v_party1, v_party2));
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_demo_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
  v_n integer := 0;
  v_actor_email text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the business Owner can remove demo data.';
  END IF;

  PERFORM set_config('app.restore_context', txid_current()::text, true);

  DELETE FROM public.schedule_register WHERE is_demo = true OR bill_id IN (SELECT id FROM public.bills WHERE is_demo = true);
  DELETE FROM public.prescriptions WHERE is_demo = true OR bill_id IN (SELECT id FROM public.bills WHERE is_demo = true);
  DELETE FROM public.warranty_records WHERE is_demo = true OR bill_id IN (SELECT id FROM public.bills WHERE is_demo = true);
  DELETE FROM public.hardware_estimates WHERE is_demo = true;
  DELETE FROM public.service_jobs WHERE is_demo = true;
  DELETE FROM public.party_item_rates WHERE is_demo = true OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true) OR item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.bill_lines WHERE bill_id IN (SELECT id FROM public.bills WHERE is_demo = true);
  DELETE FROM public.purchase_lines WHERE purchase_id IN (SELECT id FROM public.purchase_bills WHERE is_demo = true);
  DELETE FROM public.payment_allocations WHERE payment_id IN (SELECT id FROM public.payments WHERE is_demo = true);
  DELETE FROM public.party_ledger_entries WHERE is_demo = true OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true);
  DELETE FROM public.payments WHERE is_demo = true;
  DELETE FROM public.stock_ledger WHERE is_demo = true OR item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.bills WHERE is_demo = true; GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  DELETE FROM public.purchase_bills WHERE is_demo = true;
  DELETE FROM public.expenses WHERE is_demo = true;
  DELETE FROM public.item_batches WHERE is_demo = true OR item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.item_variants WHERE is_demo = true OR item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.unit_conversions WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.item_images WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.stock_balances WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.items WHERE is_demo = true; GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  DELETE FROM public.party_sites WHERE is_demo = true OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true);
  DELETE FROM public.party_addresses WHERE party_id IN (SELECT id FROM public.parties WHERE is_demo = true);
  DELETE FROM public.parties WHERE is_demo = true; GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;

  PERFORM set_config('app.restore_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_actor_email, 'workspace.demo_removed', 'workspace', '1', jsonb_build_object('removed_records', v_deleted));

  RETURN jsonb_build_object('removed_records', v_deleted);
END;
$$;

CREATE OR REPLACE FUNCTION public.switch_business_pack(
  p_pack text,
  p_enable_recommended_modules boolean DEFAULT true,
  p_load_demo boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_pack text := lower(trim(COALESCE(p_pack, '')));
  v_demo_res jsonb := NULL;
  v_actor_email text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the business Owner can switch the active business pack.';
  END IF;
  IF v_clean_pack NOT IN ('kirana', 'medical', 'clothing', 'hardware', 'general_retail', 'wholesale', 'service') THEN
    RAISE EXCEPTION 'Unsupported business pack: %', p_pack;
  END IF;

  UPDATE public.business SET pack = v_clean_pack WHERE id = 1;

  -- Enforce required modules cleanly
  IF v_clean_pack = 'medical' THEN
    UPDATE public.modules_state SET enabled = true WHERE module_key IN ('inventory', 'batch_expiry');
  ELSIF v_clean_pack = 'clothing' THEN
    UPDATE public.modules_state SET enabled = true WHERE module_key IN ('inventory', 'variants');
  END IF;

  IF COALESCE(p_enable_recommended_modules, true) THEN
    UPDATE public.modules_state SET enabled = true
    WHERE module_key IN ('parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup');
    IF v_clean_pack = 'kirana' THEN
      UPDATE public.modules_state SET enabled = true WHERE module_key = 'barcode';
    ELSIF v_clean_pack = 'clothing' THEN
      UPDATE public.modules_state SET enabled = true WHERE module_key IN ('variants', 'barcode');
    ELSIF v_clean_pack = 'medical' THEN
      UPDATE public.modules_state SET enabled = true WHERE module_key IN ('batch_expiry', 'barcode');
    ELSIF v_clean_pack = 'wholesale' THEN
      UPDATE public.modules_state SET enabled = true WHERE module_key = 'tax';
    END IF;
  END IF;

  IF COALESCE(p_load_demo, false) THEN
    v_demo_res := public.seed_pack_demo_data(v_clean_pack);
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'business.pack_switched', 'business', '1',
    jsonb_build_object('pack', v_clean_pack, 'load_demo', COALESCE(p_load_demo, false))
  );

  RETURN jsonb_build_object('pack', v_clean_pack, 'demo', v_demo_res);
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_workspace_data(p_confirm_phrase text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the business Owner can reset the workspace.';
  END IF;
  IF trim(COALESCE(p_confirm_phrase, '')) <> 'RESET WORKSPACE' THEN
    RAISE EXCEPTION 'Type exact confirmation phrase "RESET WORKSPACE" to proceed.';
  END IF;

  PERFORM set_config('app.restore_context', txid_current()::text, true);

  DELETE FROM public.file_links;
  DELETE FROM public.bill_share_links;
  DELETE FROM public.schedule_register;
  DELETE FROM public.prescriptions;
  DELETE FROM public.warranty_records;
  DELETE FROM public.hardware_estimates;
  DELETE FROM public.service_jobs;
  DELETE FROM public.party_item_rates;
  DELETE FROM public.bill_lines;
  DELETE FROM public.purchase_lines;
  DELETE FROM public.payment_allocations;
  DELETE FROM public.party_ledger_entries;
  DELETE FROM public.payments;
  DELETE FROM public.stock_ledger;
  DELETE FROM public.stock_balances;
  DELETE FROM public.bills;
  DELETE FROM public.purchase_bills;
  DELETE FROM public.expenses;
  DELETE FROM public.item_batches;
  DELETE FROM public.item_variants;
  DELETE FROM public.item_images;
  DELETE FROM public.unit_conversions;
  DELETE FROM public.items;
  DELETE FROM public.item_categories;
  DELETE FROM public.brands;
  DELETE FROM public.party_sites;
  DELETE FROM public.party_addresses;
  DELETE FROM public.parties;
  DELETE FROM public.numbering_series;
  DELETE FROM public.notifications;

  PERFORM set_config('app.restore_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_actor_email, 'workspace.reset', 'workspace', '1', jsonb_build_object('reset_at', now()));

  RETURN jsonb_build_object('reset', true);
END;
$$;

-- ============================================================================
-- 3. Enhanced Workspace Backup & Backward-Compatible Restore (p6-v1 & p5-v1)
-- ============================================================================
DROP FUNCTION IF EXISTS public.export_workspace_backup(text);

CREATE OR REPLACE FUNCTION public.export_workspace_backup(
  p_backup_type text DEFAULT 'manual',
  p_include_files boolean DEFAULT false,
  p_destination text DEFAULT 'local',
  p_drive_file_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_type text := CASE WHEN p_backup_type IN ('manual', 'scheduled', 'drive', 'pre_restore') THEN p_backup_type ELSE 'manual' END;
  v_dest text := CASE WHEN p_destination = 'google_drive' THEN 'google_drive' ELSE 'local' END;
  v_data jsonb;
  v_counts jsonb;
  v_snapshot jsonb;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('backup');
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can export workspace backups.';
  END IF;

  v_data := jsonb_build_object(
    'business', COALESCE((SELECT to_jsonb(b) FROM public.business b WHERE b.id = 1), '{}'::jsonb),
    'modules_state', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.module_key) FROM public.modules_state m), '[]'::jsonb),
    'numbering_series', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.series_key, n.fy_code) FROM public.numbering_series n), '[]'::jsonb),
    'files', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at) FROM public.files f), '[]'::jsonb),
    'file_links', COALESCE((SELECT jsonb_agg(to_jsonb(fl) ORDER BY fl.created_at) FROM public.file_links fl), '[]'::jsonb),
    'parties', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at) FROM public.parties p), '[]'::jsonb),
    'party_addresses', COALESCE((SELECT jsonb_agg(to_jsonb(pa) ORDER BY pa.created_at) FROM public.party_addresses pa), '[]'::jsonb),
    'party_sites', COALESCE((SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.created_at) FROM public.party_sites ps), '[]'::jsonb),
    'item_categories', COALESCE((SELECT jsonb_agg(to_jsonb(ic) ORDER BY ic.name) FROM public.item_categories ic), '[]'::jsonb),
    'brands', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.name) FROM public.brands br), '[]'::jsonb),
    'item_units', COALESCE((SELECT jsonb_agg(to_jsonb(iu) ORDER BY iu.code) FROM public.item_units iu), '[]'::jsonb),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(it) ORDER BY it.created_at) FROM public.items it), '[]'::jsonb),
    'unit_conversions', COALESCE((SELECT jsonb_agg(to_jsonb(uc) ORDER BY uc.created_at) FROM public.unit_conversions uc), '[]'::jsonb),
    'item_images', COALESCE((SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.created_at) FROM public.item_images ii), '[]'::jsonb),
    'item_batches', COALESCE((SELECT jsonb_agg(to_jsonb(ib) ORDER BY ib.created_at) FROM public.item_batches ib), '[]'::jsonb),
    'item_variants', COALESCE((SELECT jsonb_agg(to_jsonb(iv) ORDER BY iv.created_at) FROM public.item_variants iv), '[]'::jsonb),
    'party_item_rates', COALESCE((SELECT jsonb_agg(to_jsonb(pir) ORDER BY pir.created_at) FROM public.party_item_rates pir), '[]'::jsonb),
    'service_jobs', COALESCE((SELECT jsonb_agg(to_jsonb(sj) ORDER BY sj.created_at) FROM public.service_jobs sj), '[]'::jsonb),
    'prescriptions', COALESCE((SELECT jsonb_agg(to_jsonb(rx) ORDER BY rx.created_at) FROM public.prescriptions rx), '[]'::jsonb),
    'stock_ledger', COALESCE((SELECT jsonb_agg(to_jsonb(sl) ORDER BY sl.created_at) FROM public.stock_ledger sl), '[]'::jsonb),
    'bills', COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.created_at) FROM public.bills bl), '[]'::jsonb),
    'bill_lines', COALESCE((SELECT jsonb_agg(to_jsonb(bll) ORDER BY bll.bill_id, bll.line_no) FROM public.bill_lines bll), '[]'::jsonb),
    'schedule_register', COALESCE((SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.created_at) FROM public.schedule_register sr), '[]'::jsonb),
    'warranty_records', COALESCE((SELECT jsonb_agg(to_jsonb(wr) ORDER BY wr.created_at) FROM public.warranty_records wr), '[]'::jsonb),
    'hardware_estimates', COALESCE((SELECT jsonb_agg(to_jsonb(he) ORDER BY he.created_at) FROM public.hardware_estimates he), '[]'::jsonb),
    'purchase_bills', COALESCE((SELECT jsonb_agg(to_jsonb(pb) ORDER BY pb.created_at) FROM public.purchase_bills pb), '[]'::jsonb),
    'purchase_lines', COALESCE((SELECT jsonb_agg(to_jsonb(pl) ORDER BY pl.purchase_id, pl.line_no) FROM public.purchase_lines pl), '[]'::jsonb),
    'expense_categories', COALESCE((SELECT jsonb_agg(to_jsonb(ec) ORDER BY ec.code) FROM public.expense_categories ec), '[]'::jsonb),
    'expenses', COALESCE((SELECT jsonb_agg(to_jsonb(ex) ORDER BY ex.created_at) FROM public.expenses ex), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(pm) ORDER BY pm.created_at) FROM public.payments pm), '[]'::jsonb),
    'party_ledger_entries', COALESCE((SELECT jsonb_agg(to_jsonb(le) ORDER BY le.created_at) FROM public.party_ledger_entries le), '[]'::jsonb),
    'payment_allocations', COALESCE((SELECT jsonb_agg(to_jsonb(al) ORDER BY al.created_at) FROM public.payment_allocations al), '[]'::jsonb)
  );

  v_counts := jsonb_build_object(
    'parties', jsonb_array_length(v_data->'parties'),
    'items', jsonb_array_length(v_data->'items'),
    'bills', jsonb_array_length(v_data->'bills'),
    'purchase_bills', jsonb_array_length(v_data->'purchase_bills'),
    'expenses', jsonb_array_length(v_data->'expenses'),
    'payments', jsonb_array_length(v_data->'payments'),
    'item_batches', jsonb_array_length(v_data->'item_batches'),
    'item_variants', jsonb_array_length(v_data->'item_variants'),
    'service_jobs', jsonb_array_length(v_data->'service_jobs')
  );

  UPDATE public.business SET last_backup_at = now() WHERE id = 1;
  UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:backup_overdue';

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.backup_records (
    backup_type, schema_version, size_bytes, record_counts, destination, drive_file_id, include_files, created_by
  )
  VALUES (
    v_type, 'p6-v1', length(v_data::text)::bigint, v_counts, v_dest, p_drive_file_id, COALESCE(p_include_files, false), auth.uid()
  );

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'backup.exported', 'backup', v_dest,
    jsonb_build_object('schema_version', 'p6-v1', 'include_files', COALESCE(p_include_files, false), 'counts', v_counts)
  );

  v_snapshot := jsonb_build_object(
    'app', 'BizOne ERP',
    'schema_version', 'p6-v1',
    'exported_at', now(),
    'exported_by', v_actor_email,
    'include_files', COALESCE(p_include_files, false),
    'record_counts', v_counts,
    'data', v_data
  );

  RETURN v_snapshot;
END;
$$;

DROP FUNCTION IF EXISTS public.restore_workspace_backup(jsonb, text);

CREATE OR REPLACE FUNCTION public.restore_workspace_backup(
  p_snapshot jsonb,
  p_checksum text DEFAULT NULL,
  p_destination text DEFAULT 'local',
  p_drive_file_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_schema text;
  v_data jsonb;
  v_biz jsonb;
  v_counts jsonb;
  v_actor_email text;
  v_rec jsonb;
  v_dest text := CASE WHEN p_destination = 'google_drive' THEN 'google_drive' ELSE 'local' END;
BEGIN
  PERFORM public.require_module('backup');
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the business Owner can restore a backup.';
  END IF;

  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'Invalid backup file: root JSON object is missing.';
  END IF;

  v_schema := COALESCE(p_snapshot->>'schema_version', '');
  IF v_schema NOT IN ('p5-v1', 'p6-v1') THEN
    RAISE EXCEPTION 'Unsupported backup schema version (%). Expected p5-v1 or p6-v1.', COALESCE(NULLIF(v_schema, ''), 'none');
  END IF;

  v_data := p_snapshot->'data';
  IF v_data IS NULL OR jsonb_typeof(v_data) <> 'object' OR v_data->'business' IS NULL THEN
    RAISE EXCEPTION 'Invalid backup file: data payload or business settings is missing.';
  END IF;

  PERFORM set_config('app.restore_context', txid_current()::text, true);

  DELETE FROM public.file_links;
  DELETE FROM public.bill_share_links;
  DELETE FROM public.schedule_register;
  DELETE FROM public.prescriptions;
  DELETE FROM public.warranty_records;
  DELETE FROM public.hardware_estimates;
  DELETE FROM public.service_jobs;
  DELETE FROM public.party_item_rates;
  DELETE FROM public.bill_lines;
  DELETE FROM public.purchase_lines;
  DELETE FROM public.payment_allocations;
  DELETE FROM public.party_ledger_entries;
  DELETE FROM public.payments;
  DELETE FROM public.stock_ledger;
  DELETE FROM public.stock_balances;
  DELETE FROM public.bills;
  DELETE FROM public.purchase_bills;
  DELETE FROM public.expenses;
  DELETE FROM public.item_batches;
  DELETE FROM public.item_variants;
  DELETE FROM public.item_images;
  DELETE FROM public.unit_conversions;
  DELETE FROM public.items;
  DELETE FROM public.item_categories;
  DELETE FROM public.brands;
  DELETE FROM public.party_sites;
  DELETE FROM public.party_addresses;
  DELETE FROM public.parties;
  DELETE FROM public.numbering_series;

  IF jsonb_typeof(v_data->'files') = 'array' AND jsonb_array_length(v_data->'files') > 0 THEN
    INSERT INTO public.files (id, bucket, storage_path, file_name, mime_type, size_bytes, checksum, purpose, uploaded_by, created_at)
    SELECT r.id, r.bucket, r.storage_path, r.file_name, r.mime_type, r.size_bytes, r.checksum, r.purpose,
      CASE WHEN EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.uploaded_by) THEN r.uploaded_by ELSE auth.uid() END, r.created_at
    FROM jsonb_populate_recordset(NULL::public.files, v_data->'files') r
    ON CONFLICT (id) DO NOTHING;
  END IF;

  v_biz := v_data->'business';
  UPDATE public.business
  SET
    name = COALESCE(NULLIF(v_biz->>'name', ''), name),
    pack = COALESCE(NULLIF(v_biz->>'pack', ''), pack),
    gst_registered = COALESCE((v_biz->>'gst_registered')::boolean, gst_registered),
    gstin = NULLIF(v_biz->>'gstin', ''),
    drug_licence_no = NULLIF(v_biz->>'drug_licence_no', ''),
    pack_settings = COALESCE(v_biz->'pack_settings', pack_settings),
    phone = NULLIF(v_biz->>'phone', ''),
    email = NULLIF(v_biz->>'email', ''),
    address = NULLIF(v_biz->>'address', ''),
    state_code = NULLIF(v_biz->>'state_code', ''),
    upi_id = NULLIF(v_biz->>'upi_id', ''),
    fy_start_month = COALESCE((v_biz->>'fy_start_month')::integer, 4),
    logo_file_id = CASE WHEN NULLIF(v_biz->>'logo_file_id', '') IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = (v_biz->>'logo_file_id')::uuid) THEN (v_biz->>'logo_file_id')::uuid ELSE NULL END,
    upi_qr_file_id = CASE WHEN NULLIF(v_biz->>'upi_qr_file_id', '') IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = (v_biz->>'upi_qr_file_id')::uuid) THEN (v_biz->>'upi_qr_file_id')::uuid ELSE NULL END,
    invoice_prefix = COALESCE(NULLIF(v_biz->>'invoice_prefix', ''), 'INV-'),
    invoice_next_number = GREATEST(1, COALESCE((v_biz->>'invoice_next_number')::integer, 1)),
    invoice_terms = COALESCE(v_biz->>'invoice_terms', ''),
    tax_mode = COALESCE(NULLIF(v_biz->>'tax_mode', ''), 'exclusive'),
    default_print_layout = COALESCE(NULLIF(v_biz->>'default_print_layout', ''), 'a4'),
    show_upi_qr_on_invoice = COALESCE((v_biz->>'show_upi_qr_on_invoice')::boolean, true),
    quotation_prefix = COALESCE(NULLIF(v_biz->>'quotation_prefix', ''), 'QTN-'),
    quotation_next_number = GREATEST(1, COALESCE((v_biz->>'quotation_next_number')::integer, 1)),
    credit_note_prefix = COALESCE(NULLIF(v_biz->>'credit_note_prefix', ''), 'CN-'),
    credit_note_next_number = GREATEST(1, COALESCE((v_biz->>'credit_note_next_number')::integer, 1)),
    cashier_max_discount_pct = COALESCE((v_biz->>'cashier_max_discount_pct')::numeric, 10.00),
    allow_cashier_price_override = COALESCE((v_biz->>'allow_cashier_price_override')::boolean, false),
    purchase_prefix = COALESCE(NULLIF(v_biz->>'purchase_prefix', ''), 'PUR-'),
    purchase_next_number = GREATEST(1, COALESCE((v_biz->>'purchase_next_number')::integer, 1)),
    purchase_return_prefix = COALESCE(NULLIF(v_biz->>'purchase_return_prefix', ''), 'PR-'),
    purchase_return_next_number = GREATEST(1, COALESCE((v_biz->>'purchase_return_next_number')::integer, 1)),
    expense_prefix = COALESCE(NULLIF(v_biz->>'expense_prefix', ''), 'EXP-'),
    expense_next_number = GREATEST(1, COALESCE((v_biz->>'expense_next_number')::integer, 1)),
    last_backup_at = now()
  WHERE id = 1;

  IF jsonb_typeof(v_data->'modules_state') = 'array' THEN
    FOR v_rec IN SELECT value FROM jsonb_array_elements(v_data->'modules_state') LOOP
      INSERT INTO public.modules_state (module_key, enabled)
      VALUES (v_rec->>'module_key', COALESCE((v_rec->>'enabled')::boolean, false))
      ON CONFLICT (module_key) DO UPDATE SET enabled = EXCLUDED.enabled;
    END LOOP;
  END IF;

  IF jsonb_typeof(v_data->'numbering_series') = 'array' AND jsonb_array_length(v_data->'numbering_series') > 0 THEN
    INSERT INTO public.numbering_series (series_key, fy_code, prefix, next_number, padding, updated_at)
    SELECT r.series_key, r.fy_code, r.prefix, r.next_number, r.padding, COALESCE(r.updated_at, now())
    FROM jsonb_populate_recordset(NULL::public.numbering_series, v_data->'numbering_series') r;
  END IF;

  IF jsonb_typeof(v_data->'item_units') = 'array' AND jsonb_array_length(v_data->'item_units') > 0 THEN
    INSERT INTO public.item_units (id, code, name_en, name_hi, allow_decimal, is_system, is_active, created_at)
    SELECT r.id, r.code, r.name_en, r.name_hi, r.allow_decimal, r.is_system, r.is_active, r.created_at
    FROM jsonb_populate_recordset(NULL::public.item_units, v_data->'item_units') r ON CONFLICT (id) DO NOTHING;
  END IF;

  IF jsonb_typeof(v_data->'item_categories') = 'array' AND jsonb_array_length(v_data->'item_categories') > 0 THEN
    INSERT INTO public.item_categories (id, name, description, is_active, created_at, updated_at)
    SELECT r.id, r.name, r.description, r.is_active, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.item_categories, v_data->'item_categories') r;
  END IF;

  IF jsonb_typeof(v_data->'brands') = 'array' AND jsonb_array_length(v_data->'brands') > 0 THEN
    INSERT INTO public.brands (id, name, is_active, created_at, updated_at)
    SELECT r.id, r.name, r.is_active, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.brands, v_data->'brands') r;
  END IF;

  IF jsonb_typeof(v_data->'parties') = 'array' AND jsonb_array_length(v_data->'parties') > 0 THEN
    INSERT INTO public.parties (id, name, party_type, phone, email, gstin, opening_balance, opening_balance_type, opening_balance_date, credit_limit, credit_days, notes, is_active, is_demo, version, price_tier, created_by, created_at, updated_at)
    SELECT r.id, r.name, r.party_type, r.phone, r.email, r.gstin, r.opening_balance, r.opening_balance_type, r.opening_balance_date, r.credit_limit, r.credit_days, r.notes, r.is_active, r.is_demo, r.version, COALESCE(r.price_tier, 'standard'), auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.parties, v_data->'parties') r;
  END IF;

  IF jsonb_typeof(v_data->'party_addresses') = 'array' AND jsonb_array_length(v_data->'party_addresses') > 0 THEN
    INSERT INTO public.party_addresses (id, party_id, label, address_line1, address_line2, city, state, state_code, pincode, is_default, created_at, updated_at)
    SELECT r.id, r.party_id, r.label, r.address_line1, r.address_line2, r.city, r.state, r.state_code, r.pincode, r.is_default, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.party_addresses, v_data->'party_addresses') r;
  END IF;

  IF jsonb_typeof(v_data->'party_sites') = 'array' AND jsonb_array_length(v_data->'party_sites') > 0 THEN
    INSERT INTO public.party_sites (id, party_id, site_name, contact_name, contact_phone, address, is_active, is_demo, created_at, updated_at)
    SELECT r.id, r.party_id, r.site_name, r.contact_name, r.contact_phone, r.address, r.is_active, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.party_sites, v_data->'party_sites') r;
  END IF;

  IF jsonb_typeof(v_data->'items') = 'array' AND jsonb_array_length(v_data->'items') > 0 THEN
    INSERT INTO public.items (id, name, sku, barcode, category_id, brand_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, tax_inclusive, low_stock_alert, allow_negative_stock, primary_image_file_id, pack_metadata, notes, is_active, is_demo, version, item_type, wholesale_slabs, created_by, created_at, updated_at)
    SELECT r.id, r.name, r.sku, r.barcode, r.category_id, r.brand_id, r.base_unit_id, r.selling_price, r.mrp, r.purchase_price, r.gst_rate, r.hsn_code, r.tax_inclusive, r.low_stock_alert, r.allow_negative_stock,
      CASE WHEN r.primary_image_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.primary_image_file_id) THEN r.primary_image_file_id ELSE NULL END,
      r.pack_metadata, r.notes, r.is_active, r.is_demo, r.version, COALESCE(r.item_type, 'goods'), COALESCE(r.wholesale_slabs, '[]'::jsonb), auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.items, v_data->'items') r;
  END IF;

  IF jsonb_typeof(v_data->'unit_conversions') = 'array' AND jsonb_array_length(v_data->'unit_conversions') > 0 THEN
    INSERT INTO public.unit_conversions (id, item_id, alternate_unit_id, conversion_factor, created_at, updated_at)
    SELECT r.id, r.item_id, r.alternate_unit_id, r.conversion_factor, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.unit_conversions, v_data->'unit_conversions') r;
  END IF;

  IF jsonb_typeof(v_data->'item_images') = 'array' AND jsonb_array_length(v_data->'item_images') > 0 THEN
    INSERT INTO public.item_images (id, item_id, file_id, sort_order, is_primary, created_at)
    SELECT r.id, r.item_id, r.file_id, r.sort_order, r.is_primary, r.created_at
    FROM jsonb_populate_recordset(NULL::public.item_images, v_data->'item_images') r
    WHERE EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.file_id);
  END IF;

  IF jsonb_typeof(v_data->'item_variants') = 'array' AND jsonb_array_length(v_data->'item_variants') > 0 THEN
    INSERT INTO public.item_variants (id, item_id, size, color, sku, barcode, selling_price, mrp, purchase_price, qty_on_hand, is_active, is_demo, created_at, updated_at)
    SELECT r.id, r.item_id, r.size, r.color, r.sku, r.barcode, r.selling_price, r.mrp, r.purchase_price, r.qty_on_hand, r.is_active, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.item_variants, v_data->'item_variants') r;
  END IF;

  IF jsonb_typeof(v_data->'party_item_rates') = 'array' AND jsonb_array_length(v_data->'party_item_rates') > 0 THEN
    INSERT INTO public.party_item_rates (id, party_id, item_id, custom_rate, min_qty, is_demo, created_at, updated_at)
    SELECT r.id, r.party_id, r.item_id, r.custom_rate, r.min_qty, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.party_item_rates, v_data->'party_item_rates') r;
  END IF;

  IF jsonb_typeof(v_data->'expense_categories') = 'array' AND jsonb_array_length(v_data->'expense_categories') > 0 THEN
    INSERT INTO public.expense_categories (id, code, name_en, name_hi, is_system, is_active, created_at)
    SELECT r.id, r.code, r.name_en, r.name_hi, r.is_system, r.is_active, r.created_at
    FROM jsonb_populate_recordset(NULL::public.expense_categories, v_data->'expense_categories') r ON CONFLICT (id) DO NOTHING;
  END IF;

  IF jsonb_typeof(v_data->'service_jobs') = 'array' AND jsonb_array_length(v_data->'service_jobs') > 0 THEN
    INSERT INTO public.service_jobs (id, job_number, party_id, party_name, title, description, status, start_date, due_date, completed_date, estimated_amount, linked_bill_id, notes, is_demo, created_by, created_at, updated_at)
    SELECT r.id, r.job_number, r.party_id, r.party_name, r.title, r.description, r.status, r.start_date, r.due_date, r.completed_date, r.estimated_amount, NULL, r.notes, r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.service_jobs, v_data->'service_jobs') r;
  END IF;

  IF jsonb_typeof(v_data->'purchase_bills') = 'array' AND jsonb_array_length(v_data->'purchase_bills') > 0 THEN
    INSERT INTO public.purchase_bills (
      id, purchase_number, doc_type, status, source_purchase_id, party_id, party_name, party_phone,
      party_gstin, party_address, supplier_invoice_no, supplier_invoice_date, bill_date, due_date,
      place_of_supply_state_code, is_interstate, gst_applied, subtotal_taxable, discount_total,
      cgst_total, sgst_total, igst_total, tax_total, freight_charges, auto_round_off, round_off,
      grand_total, paid_amount, credited_amount, balance_due, payment_mode, payment_reference,
      attachment_file_id, update_item_cost, notes, return_reason, void_reason, voided_at, voided_by,
      idempotency_key, posted_at, posted_by, is_demo, created_by, created_at, updated_at
    )
    SELECT
      r.id, r.purchase_number, r.doc_type, r.status, r.source_purchase_id, r.party_id, r.party_name, r.party_phone,
      r.party_gstin, r.party_address, r.supplier_invoice_no, r.supplier_invoice_date, r.bill_date, r.due_date,
      r.place_of_supply_state_code, r.is_interstate, r.gst_applied, r.subtotal_taxable, r.discount_total,
      r.cgst_total, r.sgst_total, r.igst_total, r.tax_total, r.freight_charges, r.auto_round_off, r.round_off,
      r.grand_total, r.paid_amount, r.credited_amount, r.balance_due, r.payment_mode, r.payment_reference,
      CASE WHEN r.attachment_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.attachment_file_id) THEN r.attachment_file_id ELSE NULL END,
      r.update_item_cost, r.notes, r.return_reason, r.void_reason, r.voided_at, auth.uid(),
      r.idempotency_key, r.posted_at, auth.uid(), r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.purchase_bills, v_data->'purchase_bills') r
    ORDER BY (r.source_purchase_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'item_batches') = 'array' AND jsonb_array_length(v_data->'item_batches') > 0 THEN
    INSERT INTO public.item_batches (id, item_id, batch_no, mfg_date, expiry_date, mrp, purchase_rate, selling_rate, qty_on_hand, source_purchase_id, is_active, is_demo, created_at, updated_at)
    SELECT r.id, r.item_id, r.batch_no, r.mfg_date, r.expiry_date, r.mrp, r.purchase_rate, r.selling_rate, r.qty_on_hand, r.source_purchase_id, r.is_active, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.item_batches, v_data->'item_batches') r;
  END IF;

  IF jsonb_typeof(v_data->'bills') = 'array' AND jsonb_array_length(v_data->'bills') > 0 THEN
    INSERT INTO public.bills (
      id, bill_number, doc_type, status, source_bill_id, converted_from_quotation_id, converted_to_bill_id,
      party_id, party_name, party_phone, party_gstin, party_address, place_of_supply_state_code, is_interstate,
      bill_date, due_date, valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total, paid_amount, credited_amount,
      balance_due, notes, terms, business_snapshot, void_reason, voided_at, voided_by, return_reason,
      idempotency_key, issued_at, issued_by, is_demo, created_by, created_at, updated_at, payment_mode, payment_reference,
      site_id, site_name, job_id, prescription_id
    )
    SELECT
      r.id, r.bill_number, r.doc_type, r.status, r.source_bill_id, NULL, NULL,
      r.party_id, r.party_name, r.party_phone, r.party_gstin, r.party_address, r.place_of_supply_state_code, r.is_interstate,
      r.bill_date, r.due_date, r.valid_until, r.gst_applied, r.subtotal_taxable, r.discount_total, r.cgst_total, r.sgst_total,
      r.igst_total, r.tax_total, r.extra_charges, r.auto_round_off, r.round_off, r.grand_total, r.paid_amount, r.credited_amount,
      r.balance_due, r.notes, r.terms, r.business_snapshot, r.void_reason, r.voided_at, auth.uid(), r.return_reason,
      r.idempotency_key, r.issued_at, auth.uid(), r.is_demo, auth.uid(), r.created_at, r.updated_at, COALESCE(r.payment_mode, 'cash'), r.payment_reference,
      r.site_id, r.site_name, r.job_id, NULL
    FROM jsonb_populate_recordset(NULL::public.bills, v_data->'bills') r
    ORDER BY (r.source_bill_id IS NOT NULL) ASC, r.created_at ASC;

    UPDATE public.bills b
    SET converted_from_quotation_id = src.converted_from_quotation_id,
        converted_to_bill_id = src.converted_to_bill_id
    FROM jsonb_populate_recordset(NULL::public.bills, v_data->'bills') src
    WHERE b.id = src.id AND (src.converted_from_quotation_id IS NOT NULL OR src.converted_to_bill_id IS NOT NULL);

    UPDATE public.service_jobs sj
    SET linked_bill_id = src.linked_bill_id
    FROM jsonb_populate_recordset(NULL::public.service_jobs, COALESCE(v_data->'service_jobs', '[]'::jsonb)) src
    WHERE sj.id = src.id AND src.linked_bill_id IS NOT NULL;
  END IF;

  IF jsonb_typeof(v_data->'prescriptions') = 'array' AND jsonb_array_length(v_data->'prescriptions') > 0 THEN
    INSERT INTO public.prescriptions (id, bill_id, patient_name, patient_age, patient_phone, doctor_name, doctor_reg_no, notes, attachment_file_id, is_demo, created_by, created_at)
    SELECT r.id, r.bill_id, r.patient_name, r.patient_age, r.patient_phone, r.doctor_name, r.doctor_reg_no, r.notes,
      CASE WHEN r.attachment_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.attachment_file_id) THEN r.attachment_file_id ELSE NULL END,
      r.is_demo, auth.uid(), r.created_at
    FROM jsonb_populate_recordset(NULL::public.prescriptions, v_data->'prescriptions') r;

    UPDATE public.bills b SET prescription_id = rx.id FROM public.prescriptions rx WHERE rx.bill_id = b.id;
  END IF;

  IF jsonb_typeof(v_data->'bill_lines') = 'array' AND jsonb_array_length(v_data->'bill_lines') > 0 THEN
    INSERT INTO public.bill_lines (
      id, bill_id, line_no, item_id, source_bill_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, batch_id, batch_no, expiry_date, mrp, variant_id, variant_label, line_meta, created_at
    )
    SELECT
      r.id, r.bill_id, r.line_no, r.item_id, r.source_bill_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.catalog_unit_price, r.unit_price, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.batch_id, r.batch_no, r.expiry_date, r.mrp, r.variant_id, r.variant_label, COALESCE(r.line_meta, '{}'::jsonb), r.created_at
    FROM jsonb_populate_recordset(NULL::public.bill_lines, v_data->'bill_lines') r
    ORDER BY (r.source_bill_line_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'purchase_lines') = 'array' AND jsonb_array_length(v_data->'purchase_lines') > 0 THEN
    INSERT INTO public.purchase_lines (
      id, purchase_id, line_no, item_id, source_purchase_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, batch_id, batch_no, mfg_date, expiry_date, mrp, selling_rate, variant_id, variant_label, line_meta, created_at
    )
    SELECT
      r.id, r.purchase_id, r.line_no, r.item_id, r.source_purchase_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.unit_cost, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.batch_id, r.batch_no, r.mfg_date, r.expiry_date, r.mrp, r.selling_rate, r.variant_id, r.variant_label, COALESCE(r.line_meta, '{}'::jsonb), r.created_at
    FROM jsonb_populate_recordset(NULL::public.purchase_lines, v_data->'purchase_lines') r
    ORDER BY (r.source_purchase_line_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'schedule_register') = 'array' AND jsonb_array_length(v_data->'schedule_register') > 0 THEN
    INSERT INTO public.schedule_register (id, bill_id, bill_line_id, prescription_id, item_id, item_name, salt_name, schedule_class, batch_no, expiry_date, qty, unit_code, patient_name, doctor_name, doctor_reg_no, sale_date, is_demo, created_at)
    SELECT r.id, r.bill_id, r.bill_line_id, r.prescription_id, r.item_id, r.item_name, r.salt_name, r.schedule_class, r.batch_no, r.expiry_date, r.qty, r.unit_code, r.patient_name, r.doctor_name, r.doctor_reg_no, r.sale_date, r.is_demo, r.created_at
    FROM jsonb_populate_recordset(NULL::public.schedule_register, v_data->'schedule_register') r;
  END IF;

  IF jsonb_typeof(v_data->'warranty_records') = 'array' AND jsonb_array_length(v_data->'warranty_records') > 0 THEN
    INSERT INTO public.warranty_records (id, item_id, bill_id, bill_line_id, party_id, party_name, item_name, serial_no, warranty_months, purchase_date, warranty_end_date, status, claim_notes, is_demo, created_at, updated_at)
    SELECT r.id, r.item_id, r.bill_id, r.bill_line_id, r.party_id, r.party_name, r.item_name, r.serial_no, r.warranty_months, r.purchase_date, r.warranty_end_date, r.status, r.claim_notes, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.warranty_records, v_data->'warranty_records') r;
  END IF;

  IF jsonb_typeof(v_data->'hardware_estimates') = 'array' AND jsonb_array_length(v_data->'hardware_estimates') > 0 THEN
    INSERT INTO public.hardware_estimates (id, estimate_number, party_id, party_name, site_id, site_name, title, calc_inputs, lines, estimated_total, status, converted_bill_id, notes, is_demo, created_by, created_at, updated_at)
    SELECT r.id, r.estimate_number, r.party_id, r.party_name, r.site_id, r.site_name, r.title, r.calc_inputs, r.lines, r.estimated_total, r.status, r.converted_bill_id, r.notes, r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.hardware_estimates, v_data->'hardware_estimates') r;
  END IF;

  IF jsonb_typeof(v_data->'expenses') = 'array' AND jsonb_array_length(v_data->'expenses') > 0 THEN
    INSERT INTO public.expenses (id, expense_number, category_id, expense_date, amount, payment_mode, reference_no, paid_to, notes, attachment_file_id, job_id, status, void_reason, voided_at, voided_by, idempotency_key, is_demo, created_by, created_at, updated_at)
    SELECT r.id, r.expense_number, r.category_id, r.expense_date, r.amount, r.payment_mode, r.reference_no, r.paid_to, r.notes,
      CASE WHEN r.attachment_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.attachment_file_id) THEN r.attachment_file_id ELSE NULL END,
      r.job_id, r.status, r.void_reason, r.voided_at, auth.uid(), r.idempotency_key, r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.expenses, v_data->'expenses') r;
  END IF;

  IF jsonb_typeof(v_data->'payments') = 'array' AND jsonb_array_length(v_data->'payments') > 0 THEN
    INSERT INTO public.payments (id, payment_number, party_id, direction, amount, allocated_amount, advance_amount, mode, payment_date, reference_no, notes, status, idempotency_key, reversed_at, reversed_by, reversal_reason, is_demo, created_by, created_at, updated_at)
    SELECT r.id, r.payment_number, r.party_id, r.direction, r.amount, r.allocated_amount, r.advance_amount, r.mode, r.payment_date, r.reference_no, r.notes, r.status, r.idempotency_key, r.reversed_at, auth.uid(), r.reversal_reason, r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.payments, v_data->'payments') r;
  END IF;

  IF jsonb_typeof(v_data->'party_ledger_entries') = 'array' AND jsonb_array_length(v_data->'party_ledger_entries') > 0 THEN
    INSERT INTO public.party_ledger_entries (id, party_id, entry_type, entry_date, due_date, reference_no, source_table, source_id, signed_amount, note, idempotency_key, is_reversed, reversed_by_entry_id, is_demo, created_by, created_at)
    SELECT r.id, r.party_id, r.entry_type, r.entry_date, r.due_date, r.reference_no, r.source_table, r.source_id, r.signed_amount, r.note, r.idempotency_key, r.is_reversed, NULL, r.is_demo, auth.uid(), r.created_at
    FROM jsonb_populate_recordset(NULL::public.party_ledger_entries, v_data->'party_ledger_entries') r;

    UPDATE public.party_ledger_entries le
    SET reversed_by_entry_id = src.reversed_by_entry_id
    FROM jsonb_populate_recordset(NULL::public.party_ledger_entries, v_data->'party_ledger_entries') src
    WHERE le.id = src.id AND src.reversed_by_entry_id IS NOT NULL;
  END IF;

  IF jsonb_typeof(v_data->'payment_allocations') = 'array' AND jsonb_array_length(v_data->'payment_allocations') > 0 THEN
    INSERT INTO public.payment_allocations (id, payment_id, party_id, target_type, ledger_entry_id, target_label, allocated_amount, is_reversed, created_at)
    SELECT r.id, r.payment_id, r.party_id, r.target_type, r.ledger_entry_id, r.target_label, r.allocated_amount, r.is_reversed, r.created_at
    FROM jsonb_populate_recordset(NULL::public.payment_allocations, v_data->'payment_allocations') r;
  END IF;

  IF jsonb_typeof(v_data->'stock_ledger') = 'array' AND jsonb_array_length(v_data->'stock_ledger') > 0 THEN
    INSERT INTO public.stock_ledger (id, item_id, movement_type, movement_date, entered_qty, entered_unit_id, conversion_factor, signed_base_qty, unit_cost, reason, reference_no, source_table, source_id, idempotency_key, batch_id, variant_id, pack_meta, is_demo, created_by, created_at)
    SELECT r.id, r.item_id, r.movement_type, r.movement_date, r.entered_qty, r.entered_unit_id, r.conversion_factor, r.signed_base_qty, r.unit_cost, r.reason, r.reference_no, r.source_table, r.source_id, r.idempotency_key, r.batch_id, r.variant_id, r.pack_meta, r.is_demo, auth.uid(), r.created_at
    FROM jsonb_populate_recordset(NULL::public.stock_ledger, v_data->'stock_ledger') r
    ORDER BY r.movement_date ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'file_links') = 'array' AND jsonb_array_length(v_data->'file_links') > 0 THEN
    INSERT INTO public.file_links (id, file_id, entity_type, entity_id, sort_order, is_primary, created_at)
    SELECT r.id, r.file_id, r.entity_type, r.entity_id, r.sort_order, r.is_primary, r.created_at
    FROM jsonb_populate_recordset(NULL::public.file_links, v_data->'file_links') r
    WHERE EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.file_id);
  END IF;

  PERFORM set_config('app.restore_context', '', true);

  v_counts := jsonb_build_object(
    'parties', (SELECT count(*)::integer FROM public.parties),
    'items', (SELECT count(*)::integer FROM public.items),
    'bills', (SELECT count(*)::integer FROM public.bills),
    'purchase_bills', (SELECT count(*)::integer FROM public.purchase_bills),
    'expenses', (SELECT count(*)::integer FROM public.expenses),
    'payments', (SELECT count(*)::integer FROM public.payments),
    'item_batches', (SELECT count(*)::integer FROM public.item_batches),
    'item_variants', (SELECT count(*)::integer FROM public.item_variants),
    'service_jobs', (SELECT count(*)::integer FROM public.service_jobs)
  );

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.backup_records (
    backup_type, schema_version, checksum, size_bytes, record_counts, destination, drive_file_id, created_by
  )
  VALUES (
    CASE WHEN v_dest = 'google_drive' THEN 'drive_restore' ELSE 'restore' END,
    v_schema, p_checksum, length(p_snapshot::text)::bigint, v_counts, v_dest, p_drive_file_id, auth.uid()
  );

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'backup.restored', 'backup', v_dest,
    jsonb_build_object('schema_version', v_schema, 'checksum', p_checksum, 'counts', v_counts)
  );

  RETURN jsonb_build_object('restored', true, 'schema_version', v_schema, 'counts', v_counts);
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_parties_batch(jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_items_batch(jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_pack_demo_data(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_demo_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.switch_business_pack(text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_workspace_data(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.export_workspace_backup(text, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_workspace_backup(jsonb, text, text, text) TO authenticated;
