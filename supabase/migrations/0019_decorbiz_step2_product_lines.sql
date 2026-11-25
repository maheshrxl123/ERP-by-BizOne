-- DecorBiz - Step 2 Item 1 Migration:
--   1. Add locked product_line column on items (5 fixed lines only).
--   2. Add common item fields: supplier_id, country_of_origin, warranty_months, video_url, description.
--   3. Scope item_categories, brands, and item_units by product_line ('all' or one of the 5 lines).
--   4. Update save_item_category, save_brand, save_item_unit, save_item, and item_catalog_view.

-- ============================================================================
-- 1. Product Line & Common Fields on public.items
-- ============================================================================
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS product_line text NOT NULL DEFAULT 'other_general',
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS country_of_origin text,
  ADD COLUMN IF NOT EXISTS warranty_months integer,
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.items
  DROP CONSTRAINT IF EXISTS items_product_line_check;
ALTER TABLE public.items
  ADD CONSTRAINT items_product_line_check
  CHECK (product_line IN ('tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general'));

ALTER TABLE public.items
  DROP CONSTRAINT IF EXISTS items_warranty_months_check;
ALTER TABLE public.items
  ADD CONSTRAINT items_warranty_months_check
  CHECK (warranty_months IS NULL OR warranty_months >= 0);

CREATE INDEX IF NOT EXISTS idx_items_product_line
  ON public.items (product_line, is_active, name);

-- Backfill any seeded demo items accurately
UPDATE public.items
SET product_line = 'tiles_slabs'
WHERE product_line = 'other_general'
  AND (pack_metadata->>'category_type' = 'tiles' OR sku = 'DB-TILE-2X2');

UPDATE public.items
SET product_line = 'faucets_cp'
WHERE product_line = 'other_general'
  AND (pack_metadata->>'category_type' = 'faucets' OR sku = 'DB-CP-01');

-- ============================================================================
-- 2. Line-Scoped Categories, Brands & Units (Owners cannot create/rename/delete lines)
-- ============================================================================
ALTER TABLE public.item_categories
  ADD COLUMN IF NOT EXISTS product_line text NOT NULL DEFAULT 'all';
ALTER TABLE public.item_categories
  DROP CONSTRAINT IF EXISTS item_categories_product_line_check;
ALTER TABLE public.item_categories
  ADD CONSTRAINT item_categories_product_line_check
  CHECK (product_line IN ('all', 'tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general'));

DROP INDEX IF EXISTS public.idx_item_categories_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_categories_line_name_unique
  ON public.item_categories (product_line, lower(trim(name)));

ALTER TABLE public.brands
  ADD COLUMN IF NOT EXISTS product_line text NOT NULL DEFAULT 'all';
ALTER TABLE public.brands
  DROP CONSTRAINT IF EXISTS brands_product_line_check;
ALTER TABLE public.brands
  ADD CONSTRAINT brands_product_line_check
  CHECK (product_line IN ('all', 'tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general'));

DROP INDEX IF EXISTS public.idx_brands_name_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_line_name_unique
  ON public.brands (product_line, lower(trim(name)));

ALTER TABLE public.item_units
  ADD COLUMN IF NOT EXISTS product_line text NOT NULL DEFAULT 'all';
ALTER TABLE public.item_units
  DROP CONSTRAINT IF EXISTS item_units_product_line_check;
ALTER TABLE public.item_units
  ADD CONSTRAINT item_units_product_line_check
  CHECK (product_line IN ('all', 'tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general'));

-- ============================================================================
-- 3. Update Taxonomy RPCs with p_product_line
-- ============================================================================
DROP FUNCTION IF EXISTS public.save_item_category(uuid, text, text);
CREATE OR REPLACE FUNCTION public.save_item_category(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT '',
  p_description text DEFAULT NULL,
  p_product_line text DEFAULT 'all'
)
RETURNS public.item_categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_clean text;
  v_line text;
  v_row public.item_categories;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can manage categories.';
  END IF;

  v_clean := trim(COALESCE(p_name, ''));
  IF length(v_clean) < 1 THEN
    RAISE EXCEPTION 'Category name is required.';
  END IF;

  v_line := lower(trim(COALESCE(NULLIF(p_product_line, ''), 'all')));
  IF v_line NOT IN ('all', 'tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general') THEN
    RAISE EXCEPTION 'Invalid product line "%".', v_line;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.item_categories (name, description, product_line, created_by)
    VALUES (v_clean, NULLIF(trim(COALESCE(p_description, '')), ''), v_line, auth.uid())
    ON CONFLICT (product_line, (lower(trim(name)))) DO UPDATE
      SET is_active = true,
          description = COALESCE(EXCLUDED.description, public.item_categories.description)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.item_categories
    SET name = v_clean,
        description = NULLIF(trim(COALESCE(p_description, '')), ''),
        product_line = v_line
    WHERE id = p_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Category not found.';
    END IF;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NULL THEN 'category.saved' ELSE 'category.updated' END,
    'item_category', v_row.id::text, jsonb_build_object('name', v_row.name, 'product_line', v_row.product_line)
  );

  RETURN v_row;
END;
$$;

DROP FUNCTION IF EXISTS public.save_brand(uuid, text);
CREATE OR REPLACE FUNCTION public.save_brand(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT '',
  p_product_line text DEFAULT 'all'
)
RETURNS public.brands
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_clean text;
  v_line text;
  v_row public.brands;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can manage brands.';
  END IF;

  v_clean := trim(COALESCE(p_name, ''));
  IF length(v_clean) < 1 THEN
    RAISE EXCEPTION 'Brand name is required.';
  END IF;

  v_line := lower(trim(COALESCE(NULLIF(p_product_line, ''), 'all')));
  IF v_line NOT IN ('all', 'tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general') THEN
    RAISE EXCEPTION 'Invalid product line "%".', v_line;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.brands (name, product_line, created_by)
    VALUES (v_clean, v_line, auth.uid())
    ON CONFLICT (product_line, (lower(trim(name)))) DO UPDATE
      SET is_active = true
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.brands
    SET name = v_clean,
        product_line = v_line
    WHERE id = p_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Brand not found.';
    END IF;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NULL THEN 'brand.saved' ELSE 'brand.updated' END,
    'brand', v_row.id::text, jsonb_build_object('name', v_row.name, 'product_line', v_row.product_line)
  );

  RETURN v_row;
END;
$$;

DROP FUNCTION IF EXISTS public.save_item_unit(uuid, text, text, text, boolean);
CREATE OR REPLACE FUNCTION public.save_item_unit(
  p_id uuid DEFAULT NULL,
  p_code text DEFAULT '',
  p_name_en text DEFAULT '',
  p_name_hi text DEFAULT '',
  p_allow_decimal boolean DEFAULT false,
  p_product_line text DEFAULT 'all'
)
RETURNS public.item_units
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_code text;
  v_name_en text;
  v_name_hi text;
  v_line text;
  v_row public.item_units;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can manage units.';
  END IF;

  v_code := upper(trim(COALESCE(p_code, '')));
  v_name_en := trim(COALESCE(p_name_en, ''));
  v_name_hi := COALESCE(NULLIF(trim(COALESCE(p_name_hi, '')), ''), v_name_en);

  IF length(v_code) < 1 OR length(v_name_en) < 1 THEN
    RAISE EXCEPTION 'Unit code and English name are required.';
  END IF;

  v_line := lower(trim(COALESCE(NULLIF(p_product_line, ''), 'all')));
  IF v_line NOT IN ('all', 'tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general') THEN
    RAISE EXCEPTION 'Invalid product line "%".', v_line;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.item_units (code, name_en, name_hi, allow_decimal, is_system, product_line)
    VALUES (v_code, v_name_en, v_name_hi, COALESCE(p_allow_decimal, false), false, v_line)
    ON CONFLICT ((upper(trim(code)))) DO UPDATE
      SET name_en = EXCLUDED.name_en,
          name_hi = EXCLUDED.name_hi,
          allow_decimal = EXCLUDED.allow_decimal,
          product_line = EXCLUDED.product_line,
          is_active = true
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.item_units
    SET code = v_code,
        name_en = v_name_en,
        name_hi = v_name_hi,
        allow_decimal = COALESCE(p_allow_decimal, false),
        product_line = v_line
    WHERE id = p_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit not found.';
    END IF;
  END IF;

  RETURN v_row;
END;
$$;

-- ============================================================================
-- 4. Update item_catalog_view (append new columns at the end cleanly)
-- ============================================================================
CREATE OR REPLACE VIEW public.item_catalog_view AS
SELECT
  i.id,
  i.name,
  i.sku,
  i.barcode,
  i.category_id,
  c.name AS category_name,
  i.brand_id,
  b.name AS brand_name,
  i.base_unit_id,
  u.code AS base_unit_code,
  u.name_en AS base_unit_name_en,
  u.name_hi AS base_unit_name_hi,
  u.allow_decimal AS base_unit_allow_decimal,
  i.selling_price,
  i.mrp,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN i.purchase_price
    ELSE NULL
  END AS purchase_price,
  i.gst_rate,
  i.hsn_code,
  i.tax_inclusive,
  i.low_stock_alert,
  i.allow_negative_stock,
  i.primary_image_file_id,
  i.pack_metadata,
  i.notes,
  i.is_active,
  i.is_demo,
  i.version,
  i.created_at,
  i.updated_at,
  COALESCE(sb.qty_on_hand, 0)::numeric(15,3) AS qty_on_hand,
  sb.last_movement_at,
  (i.item_type = 'goods' AND i.is_active AND COALESCE(sb.qty_on_hand, 0) <= 0) AS is_out_of_stock,
  (i.item_type = 'goods' AND i.is_active AND i.low_stock_alert > 0 AND COALESCE(sb.qty_on_hand, 0) <= i.low_stock_alert) AS is_low_stock,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) AND i.item_type = 'goods'
      THEN round((COALESCE(sb.qty_on_hand, 0) * COALESCE(i.purchase_price, 0))::numeric, 2)
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
      THEN 0::numeric(15,2)
    ELSE NULL
  END AS stock_value,
  (SELECT count(*)::integer FROM public.item_images ii WHERE ii.item_id = i.id) AS image_count,
  (SELECT count(*)::integer FROM public.unit_conversions uc WHERE uc.item_id = i.id) AS conversions_count,
  i.item_type,
  i.product_line,
  i.supplier_id,
  sp.name AS supplier_name,
  i.country_of_origin,
  i.warranty_months,
  i.video_url,
  i.description
FROM public.items i
LEFT JOIN public.item_categories c ON c.id = i.category_id
LEFT JOIN public.brands b ON b.id = i.brand_id
LEFT JOIN public.parties sp ON sp.id = i.supplier_id
JOIN public.item_units u ON u.id = i.base_unit_id
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_catalog_view SET (security_invoker = false);
GRANT SELECT ON public.item_catalog_view TO authenticated;

-- ============================================================================
-- 5. Update save_item RPC with product_line & common item fields
-- ============================================================================
DROP FUNCTION IF EXISTS public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer, text
);

CREATE OR REPLACE FUNCTION public.save_item(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT '',
  p_sku text DEFAULT NULL,
  p_barcode text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_brand_id uuid DEFAULT NULL,
  p_base_unit_id uuid DEFAULT NULL,
  p_selling_price numeric DEFAULT 0,
  p_mrp numeric DEFAULT NULL,
  p_purchase_price numeric DEFAULT NULL,
  p_gst_rate numeric DEFAULT 0,
  p_hsn_code text DEFAULT NULL,
  p_tax_inclusive boolean DEFAULT false,
  p_low_stock_alert numeric DEFAULT 0,
  p_allow_negative_stock boolean DEFAULT false,
  p_opening_stock numeric DEFAULT 0,
  p_opening_unit_id uuid DEFAULT NULL,
  p_pack_metadata jsonb DEFAULT '{}'::jsonb,
  p_notes text DEFAULT NULL,
  p_conversions jsonb DEFAULT '[]'::jsonb,
  p_images jsonb DEFAULT NULL,
  p_expected_version integer DEFAULT NULL,
  p_item_type text DEFAULT 'goods',
  p_product_line text DEFAULT 'other_general',
  p_supplier_id uuid DEFAULT NULL,
  p_country_of_origin text DEFAULT NULL,
  p_warranty_months integer DEFAULT NULL,
  p_video_url text DEFAULT NULL,
  p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_can_edit_cost boolean;
  v_actor_email text;
  v_clean_name text;
  v_clean_sku text;
  v_clean_barcode text;
  v_clean_hsn text;
  v_item_type text;
  v_product_line text;
  v_item public.items;
  v_existing public.items;
  v_eff_purchase numeric(15,2);
  v_conv jsonb;
  v_alt_unit uuid;
  v_factor numeric(18,6);
  v_open_qty numeric(15,3);
  v_open_unit uuid;
  v_open_base numeric(15,3);
  v_open_factor numeric(18,6);
  v_img_res jsonb := '{}'::jsonb;
  v_removed_files jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can add or edit items.';
  END IF;

  v_can_edit_cost := v_role IN ('owner', 'manager', 'accountant');
  v_item_type := CASE WHEN COALESCE(p_item_type, 'goods') = 'service' THEN 'service' ELSE 'goods' END;
  v_product_line := lower(trim(COALESCE(NULLIF(p_product_line, ''), 'other_general')));
  IF v_product_line NOT IN ('tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general') THEN
    RAISE EXCEPTION 'Invalid product line "%". Must be one of tiles_slabs, sanitaryware, faucets_cp, tile_adhesive, other_general.', v_product_line;
  END IF;

  v_clean_name := trim(COALESCE(p_name, ''));
  IF length(v_clean_name) < 1 THEN
    RAISE EXCEPTION 'Item name is required.';
  END IF;

  IF p_base_unit_id IS NULL THEN
    RAISE EXCEPTION 'Base unit is required.';
  END IF;

  IF COALESCE(p_selling_price, 0) < 0 THEN
    RAISE EXCEPTION 'Selling price cannot be negative.';
  END IF;
  IF p_mrp IS NOT NULL AND p_mrp < 0 THEN
    RAISE EXCEPTION 'MRP cannot be negative.';
  END IF;
  IF COALESCE(p_purchase_price, 0) < 0 THEN
    RAISE EXCEPTION 'Purchase price cannot be negative.';
  END IF;
  IF COALESCE(p_low_stock_alert, 0) < 0 THEN
    RAISE EXCEPTION 'Low stock alert cannot be negative.';
  END IF;
  IF p_warranty_months IS NOT NULL AND p_warranty_months < 0 THEN
    RAISE EXCEPTION 'Warranty months cannot be negative.';
  END IF;

  v_clean_sku := NULLIF(upper(trim(COALESCE(p_sku, ''))), '');
  v_clean_barcode := NULLIF(upper(trim(COALESCE(p_barcode, ''))), '');
  v_clean_hsn := NULLIF(trim(COALESCE(p_hsn_code, '')), '');

  IF p_id IS NULL THEN
    v_eff_purchase := CASE WHEN v_can_edit_cost THEN COALESCE(p_purchase_price, 0) ELSE 0 END;

    INSERT INTO public.items (
      name, sku, barcode, category_id, brand_id, base_unit_id,
      selling_price, mrp, purchase_price, gst_rate, hsn_code,
      tax_inclusive, low_stock_alert, allow_negative_stock,
      pack_metadata, notes, item_type, product_line,
      supplier_id, country_of_origin, warranty_months, video_url, description,
      created_by
    )
    VALUES (
      v_clean_name, v_clean_sku, v_clean_barcode, p_category_id, p_brand_id, p_base_unit_id,
      round(COALESCE(p_selling_price, 0)::numeric, 2),
      CASE WHEN p_mrp IS NOT NULL THEN round(p_mrp::numeric, 2) ELSE NULL END,
      round(v_eff_purchase::numeric, 2),
      COALESCE(p_gst_rate, 0),
      v_clean_hsn,
      COALESCE(p_tax_inclusive, false),
      CASE WHEN v_item_type = 'service' THEN 0 ELSE round(COALESCE(p_low_stock_alert, 0)::numeric, 3) END,
      CASE WHEN v_item_type = 'service' THEN true ELSE COALESCE(p_allow_negative_stock, false) END,
      COALESCE(p_pack_metadata, '{}'::jsonb),
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      v_item_type,
      v_product_line,
      p_supplier_id,
      NULLIF(trim(COALESCE(p_country_of_origin, '')), ''),
      p_warranty_months,
      NULLIF(trim(COALESCE(p_video_url, '')), ''),
      NULLIF(trim(COALESCE(p_description, '')), ''),
      auth.uid()
    )
    RETURNING * INTO v_item;

    INSERT INTO public.stock_balances (item_id, qty_on_hand)
    VALUES (v_item.id, 0)
    ON CONFLICT (item_id) DO NOTHING;
  ELSE
    SELECT * INTO v_existing FROM public.items WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item not found.';
    END IF;

    IF p_expected_version IS NOT NULL AND v_existing.version <> p_expected_version THEN
      RAISE EXCEPTION 'This item was modified by another user. Please refresh and try again.';
    END IF;

    v_eff_purchase := CASE
      WHEN v_can_edit_cost AND p_purchase_price IS NOT NULL THEN round(p_purchase_price::numeric, 2)
      ELSE v_existing.purchase_price
    END;

    UPDATE public.items
    SET
      name = v_clean_name,
      sku = v_clean_sku,
      barcode = v_clean_barcode,
      category_id = p_category_id,
      brand_id = p_brand_id,
      base_unit_id = p_base_unit_id,
      selling_price = round(COALESCE(p_selling_price, 0)::numeric, 2),
      mrp = CASE WHEN p_mrp IS NOT NULL THEN round(p_mrp::numeric, 2) ELSE NULL END,
      purchase_price = v_eff_purchase,
      gst_rate = COALESCE(p_gst_rate, 0),
      hsn_code = v_clean_hsn,
      tax_inclusive = COALESCE(p_tax_inclusive, false),
      low_stock_alert = CASE WHEN v_item_type = 'service' THEN 0 ELSE round(COALESCE(p_low_stock_alert, 0)::numeric, 3) END,
      allow_negative_stock = CASE WHEN v_item_type = 'service' THEN true ELSE COALESCE(p_allow_negative_stock, false) END,
      pack_metadata = COALESCE(p_pack_metadata, '{}'::jsonb),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      item_type = v_item_type,
      product_line = v_product_line,
      supplier_id = p_supplier_id,
      country_of_origin = NULLIF(trim(COALESCE(p_country_of_origin, '')), ''),
      warranty_months = p_warranty_months,
      video_url = NULLIF(trim(COALESCE(p_video_url, '')), ''),
      description = NULLIF(trim(COALESCE(p_description, '')), ''),
      version = v_existing.version + 1
    WHERE id = p_id
    RETURNING * INTO v_item;
  END IF;

  DELETE FROM public.unit_conversions WHERE item_id = v_item.id;
  IF p_conversions IS NOT NULL AND jsonb_typeof(p_conversions) = 'array' THEN
    FOR v_conv IN SELECT value FROM jsonb_array_elements(p_conversions)
    LOOP
      v_alt_unit := NULLIF(trim(COALESCE(v_conv->>'alternate_unit_id', '')), '')::uuid;
      v_factor := COALESCE((v_conv->>'conversion_factor')::numeric, 0);
      IF v_alt_unit IS NOT NULL AND v_alt_unit <> p_base_unit_id AND v_factor > 0 THEN
        INSERT INTO public.unit_conversions (item_id, alternate_unit_id, conversion_factor)
        VALUES (v_item.id, v_alt_unit, v_factor)
        ON CONFLICT (item_id, alternate_unit_id) DO UPDATE SET conversion_factor = EXCLUDED.conversion_factor;
      END IF;
    END LOOP;
  END IF;

  IF p_id IS NULL AND v_item_type = 'goods' THEN
    v_open_qty := round(COALESCE(p_opening_stock, 0)::numeric, 3);
    IF v_open_qty > 0 THEN
      v_open_unit := COALESCE(p_opening_unit_id, p_base_unit_id);
      SELECT base_qty, conversion_factor INTO v_open_base, v_open_factor
      FROM public.convert_item_qty(v_item.id, v_open_qty, v_open_unit);

      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        v_item.id, 'opening_stock', CURRENT_DATE, v_open_qty, v_open_unit,
        v_open_factor, v_open_base, v_eff_purchase, 'Opening stock balance',
        NULL, 'items', v_item.id, auth.uid()
      );
    END IF;
  END IF;

  IF p_images IS NOT NULL AND jsonb_typeof(p_images) = 'array' THEN
    v_img_res := public.sync_item_images(v_item.id, p_images);
    v_removed_files := COALESCE(v_img_res->'removed_file_ids', '[]'::jsonb);
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NULL THEN 'item.created' ELSE 'item.updated' END,
    'item', v_item.id::text,
    jsonb_build_object(
      'name', v_item.name,
      'item_type', v_item.item_type,
      'product_line', v_item.product_line,
      'selling_price', v_item.selling_price
    )
  );

  SELECT * INTO v_item FROM public.items WHERE id = v_item.id;
  RETURN jsonb_build_object(
    'id', v_item.id,
    'version', v_item.version,
    'primary_image_file_id', v_item.primary_image_file_id,
    'item', to_jsonb(v_item),
    'removed_file_ids', v_removed_files
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_item_category(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_brand(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_item_unit(uuid, text, text, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer, text,
  text, uuid, text, integer, text, text
) TO authenticated;
