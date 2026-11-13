-- BizOne ERP - Phase P3: Items & Inventory
-- Single-business architecture: categories, brands, units & conversions,
-- item catalogue with strict purchase-cost masking, ordered multi-image links,
-- immutable insert-only stock ledger, trigger-reconciled stock balances,
-- negative-stock policy, trigram/barcode search indexes, and RBAC/RLS.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 1. Update document numbering series prefix support for stock adjustments
CREATE OR REPLACE FUNCTION public.next_document_number(
  p_series_key text,
  p_doc_date date DEFAULT CURRENT_DATE
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fy_code text;
  v_prefix text;
  v_next integer;
  v_padding integer;
BEGIN
  v_fy_code := public.compute_fy_code(COALESCE(p_doc_date, CURRENT_DATE));
  v_prefix := CASE p_series_key
    WHEN 'payment_receive' THEN 'REC-'
    WHEN 'payment_give' THEN 'PAY-'
    WHEN 'khata_entry' THEN 'KHT-'
    WHEN 'opening_balance' THEN 'OB-'
    WHEN 'stock_adjustment' THEN 'ADJ-'
    ELSE upper(left(p_series_key, 3)) || '-'
  END;

  INSERT INTO public.numbering_series (series_key, fy_code, prefix, next_number, padding)
  VALUES (p_series_key, v_fy_code, v_prefix, 1, 4)
  ON CONFLICT (series_key, fy_code) DO NOTHING;

  SELECT prefix, next_number, padding
  INTO v_prefix, v_next, v_padding
  FROM public.numbering_series
  WHERE series_key = p_series_key AND fy_code = v_fy_code
  FOR UPDATE;

  UPDATE public.numbering_series
  SET next_number = v_next + 1, updated_at = now()
  WHERE series_key = p_series_key AND fy_code = v_fy_code;

  RETURN v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0');
END;
$$;

-- 2. Categories, Brands, and Units
CREATE TABLE IF NOT EXISTS public.item_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) >= 1 AND length(name) <= 100),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_categories_name_unique
  ON public.item_categories (lower(trim(name)));

DROP TRIGGER IF EXISTS trg_item_categories_updated_at ON public.item_categories;
CREATE TRIGGER trg_item_categories_updated_at
  BEFORE UPDATE ON public.item_categories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) >= 1 AND length(name) <= 100),
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_name_unique
  ON public.brands (lower(trim(name)));

DROP TRIGGER IF EXISTS trg_brands_updated_at ON public.brands;
CREATE TRIGGER trg_brands_updated_at
  BEFORE UPDATE ON public.brands
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.item_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (length(trim(code)) >= 1 AND length(code) <= 20),
  name_en text NOT NULL CHECK (length(trim(name_en)) >= 1 AND length(name_en) <= 60),
  name_hi text NOT NULL CHECK (length(trim(name_hi)) >= 1 AND length(name_hi) <= 60),
  allow_decimal boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_units_code_unique
  ON public.item_units (upper(trim(code)));

DROP TRIGGER IF EXISTS trg_item_units_updated_at ON public.item_units;
CREATE TRIGGER trg_item_units_updated_at
  BEFORE UPDATE ON public.item_units
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed common Indian retail/trade units idempotently
INSERT INTO public.item_units (code, name_en, name_hi, allow_decimal, is_system) VALUES
  ('PCS', 'Pieces', 'पीस', false, true),
  ('KG', 'Kilogram', 'किलोग्राम', true, true),
  ('GM', 'Gram', 'ग्राम', true, true),
  ('LTR', 'Litre', 'लीटर', true, true),
  ('ML', 'Millilitre', 'मिलीलीटर', true, true),
  ('BOX', 'Box', 'बॉक्स', false, true),
  ('PKT', 'Packet', 'पैकेट', false, true),
  ('CTN', 'Carton', 'कार्टन', false, true),
  ('DOZ', 'Dozen', 'दर्जन', false, true),
  ('BAG', 'Bag / Sack', 'बोरी', false, true),
  ('BOT', 'Bottle', 'बोतल', false, true),
  ('JAR', 'Jar', 'जार', false, true),
  ('TIN', 'Tin', 'टिन', false, true),
  ('MTR', 'Metre', 'मीटर', true, true),
  ('FT', 'Foot', 'फीट', true, true),
  ('SQFT', 'Sq. Foot', 'वर्ग फुट', true, true),
  ('SQM', 'Sq. Metre', 'वर्ग मीटर', true, true),
  ('COIL', 'Coil', 'कॉइल', false, true),
  ('ROLL', 'Roll', 'रोल', false, true),
  ('STRIP', 'Strip', 'पत्ता (स्ट्रिप)', false, true),
  ('TAB', 'Tablet', 'गोली', false, true),
  ('PAIR', 'Pair', 'जोड़ी', false, true),
  ('SET', 'Set', 'सेट', false, true),
  ('TON', 'Metric Ton', 'टन', true, true),
  ('BND', 'Bundle', 'बंडल', false, true),
  ('JOB', 'Service / Job', 'सेवा / कार्य', true, true)
ON CONFLICT ((upper(trim(code)))) DO NOTHING;

-- 3. Items Master
CREATE TABLE IF NOT EXISTS public.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) >= 1 AND length(name) <= 180),
  sku text,
  barcode text,
  category_id uuid REFERENCES public.item_categories(id) ON DELETE SET NULL,
  brand_id uuid REFERENCES public.brands(id) ON DELETE SET NULL,
  base_unit_id uuid NOT NULL REFERENCES public.item_units(id) ON DELETE RESTRICT,
  selling_price numeric(15,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  mrp numeric(15,2) CHECK (mrp IS NULL OR mrp >= 0),
  purchase_price numeric(15,2) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  gst_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (gst_rate >= 0 AND gst_rate <= 100),
  hsn_code text,
  tax_inclusive boolean NOT NULL DEFAULT false,
  low_stock_alert numeric(15,3) NOT NULL DEFAULT 0 CHECK (low_stock_alert >= 0),
  allow_negative_stock boolean NOT NULL DEFAULT false,
  primary_image_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  pack_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_sku_unique
  ON public.items (upper(trim(sku)))
  WHERE sku IS NOT NULL AND length(trim(sku)) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode_unique
  ON public.items (upper(trim(barcode)))
  WHERE barcode IS NOT NULL AND length(trim(barcode)) > 0;

CREATE INDEX IF NOT EXISTS idx_items_name_trgm
  ON public.items USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_items_sku_trgm
  ON public.items USING gin (sku gin_trgm_ops)
  WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_items_barcode_lookup
  ON public.items (barcode)
  WHERE barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_items_active_category_brand
  ON public.items (is_active, category_id, brand_id, name);

DROP TRIGGER IF EXISTS trg_items_updated_at ON public.items;
CREATE TRIGGER trg_items_updated_at
  BEFORE UPDATE ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. Unit Conversions (1 alternate_unit = conversion_factor * base_unit)
CREATE TABLE IF NOT EXISTS public.unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  alternate_unit_id uuid NOT NULL REFERENCES public.item_units(id) ON DELETE RESTRICT,
  conversion_factor numeric(18,6) NOT NULL CHECK (conversion_factor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, alternate_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_conversions_item
  ON public.unit_conversions (item_id);

DROP TRIGGER IF EXISTS trg_unit_conversions_updated_at ON public.unit_conversions;
CREATE TRIGGER trg_unit_conversions_updated_at
  BEFORE UPDATE ON public.unit_conversions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 5. Ordered Multi-Image Gallery Links for Items
CREATE TABLE IF NOT EXISTS public.item_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_item_images_item_order
  ON public.item_images (item_id, sort_order, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_images_one_primary
  ON public.item_images (item_id)
  WHERE is_primary = true;

-- Keep items.primary_image_file_id synced if an image file row is deleted directly
CREATE OR REPLACE FUNCTION public.reconcile_primary_image_on_item_image_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_file uuid;
BEGIN
  IF OLD.is_primary THEN
    SELECT file_id INTO v_next_file
    FROM public.item_images
    WHERE item_id = OLD.item_id AND id <> OLD.id
    ORDER BY sort_order ASC, created_at ASC
    LIMIT 1;

    IF v_next_file IS NOT NULL THEN
      UPDATE public.item_images
      SET is_primary = true
      WHERE item_id = OLD.item_id AND file_id = v_next_file;
    END IF;

    UPDATE public.items
    SET primary_image_file_id = v_next_file
    WHERE id = OLD.item_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_item_images_after_delete ON public.item_images;
CREATE TRIGGER trg_item_images_after_delete
  AFTER DELETE ON public.item_images
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_primary_image_on_item_image_delete();

-- 6. Immutable Stock Ledger & Cached Stock Balances
CREATE TABLE IF NOT EXISTS public.stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  movement_type text NOT NULL CHECK (movement_type IN (
    'opening_stock',
    'adjustment_in',
    'adjustment_out',
    'sale',
    'sale_return',
    'purchase',
    'purchase_return',
    'transfer_in',
    'transfer_out'
  )),
  movement_date date NOT NULL DEFAULT CURRENT_DATE,
  entered_qty numeric(15,3) NOT NULL CHECK (entered_qty > 0),
  entered_unit_id uuid NOT NULL REFERENCES public.item_units(id) ON DELETE RESTRICT,
  conversion_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  signed_base_qty numeric(15,3) NOT NULL CHECK (signed_base_qty <> 0),
  unit_cost numeric(15,2),
  reason text,
  reference_no text,
  source_table text,
  source_id uuid,
  idempotency_key text UNIQUE,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_item_date
  ON public.stock_ledger (item_id, movement_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_source
  ON public.stock_ledger (source_table, source_id);

CREATE TABLE IF NOT EXISTS public.stock_balances (
  item_id uuid PRIMARY KEY REFERENCES public.items(id) ON DELETE RESTRICT,
  qty_on_hand numeric(15,3) NOT NULL DEFAULT 0,
  last_movement_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Guard triggers: stock_ledger is strictly immutable (insert-only)
CREATE OR REPLACE FUNCTION public.guard_immutable_stock_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Stock ledger entries are immutable and cannot be modified or deleted.';
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_ledger_immutable ON public.stock_ledger;
CREATE TRIGGER trg_stock_ledger_immutable
  BEFORE UPDATE OR DELETE ON public.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_stock_ledger();

-- Trigger: maintain stock_balances & enforce negative-stock policy atomically on insert
CREATE OR REPLACE FUNCTION public.apply_stock_ledger_to_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_name text;
  v_allow_neg boolean := false;
  v_current numeric(15,3) := 0;
  v_next numeric(15,3);
BEGIN
  SELECT name, allow_negative_stock
  INTO v_item_name, v_allow_neg
  FROM public.items
  WHERE id = NEW.item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found for stock movement.';
  END IF;

  INSERT INTO public.stock_balances (item_id, qty_on_hand, last_movement_at, updated_at)
  VALUES (NEW.item_id, 0, NULL, now())
  ON CONFLICT (item_id) DO NOTHING;

  SELECT qty_on_hand INTO v_current
  FROM public.stock_balances
  WHERE item_id = NEW.item_id
  FOR UPDATE;

  v_next := round(COALESCE(v_current, 0) + NEW.signed_base_qty, 3);

  IF v_next < 0 AND NOT COALESCE(v_allow_neg, false) THEN
    RAISE EXCEPTION 'Insufficient stock for "%". Available: %, requested reduction: %.',
      v_item_name, v_current, abs(NEW.signed_base_qty);
  END IF;

  UPDATE public.stock_balances
  SET
    qty_on_hand = v_next,
    last_movement_at = GREATEST(COALESCE(last_movement_at, NEW.created_at), NEW.created_at),
    updated_at = now()
  WHERE item_id = NEW.item_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_ledger_apply_balance ON public.stock_ledger;
CREATE TRIGGER trg_stock_ledger_apply_balance
  AFTER INSERT ON public.stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.apply_stock_ledger_to_balance();

-- 7. Unit Conversion Helper
CREATE OR REPLACE FUNCTION public.convert_item_qty(
  p_item_id uuid,
  p_qty numeric,
  p_unit_id uuid
)
RETURNS TABLE (
  base_qty numeric(15,3),
  conversion_factor numeric(18,6),
  base_unit_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_unit_id uuid;
  v_allow_decimal boolean := true;
  v_factor numeric(18,6) := 1;
  v_result numeric(15,3);
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero.';
  END IF;

  SELECT i.base_unit_id, u.allow_decimal
  INTO v_base_unit_id, v_allow_decimal
  FROM public.items i
  JOIN public.item_units u ON u.id = i.base_unit_id
  WHERE i.id = p_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found.';
  END IF;

  IF p_unit_id IS NULL OR p_unit_id = v_base_unit_id THEN
    v_factor := 1;
  ELSE
    SELECT uc.conversion_factor
    INTO v_factor
    FROM public.unit_conversions uc
    WHERE uc.item_id = p_item_id AND uc.alternate_unit_id = p_unit_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected unit does not have a conversion configured for this item.';
    END IF;
  END IF;

  v_result := round((p_qty * v_factor)::numeric, 3);
  IF v_result <= 0 THEN
    RAISE EXCEPTION 'Converted base quantity is too small (rounds to zero).';
  END IF;

  IF NOT v_allow_decimal AND v_result <> trunc(v_result) THEN
    RAISE EXCEPTION 'Base unit does not allow fractional quantities (computed: %).', v_result;
  END IF;

  RETURN QUERY SELECT v_result, v_factor, v_base_unit_id;
END;
$$;

-- 8. Views with Purchase-Cost Masking & Role Enforcement
-- Note: Base tables `items(purchase_price)` and `stock_ledger(unit_cost)` revoke direct column SELECT
-- from `authenticated`. These views run as view owner (security_invoker = false) while explicitly enforcing
-- `is_module_enabled('inventory')` and `has_any_role(...)` plus masking cost columns to NULL for non-profit roles.
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
  (i.is_active AND COALESCE(sb.qty_on_hand, 0) <= 0) AS is_out_of_stock,
  (i.is_active AND i.low_stock_alert > 0 AND COALESCE(sb.qty_on_hand, 0) <= i.low_stock_alert) AS is_low_stock,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
      THEN round((COALESCE(sb.qty_on_hand, 0) * COALESCE(i.purchase_price, 0))::numeric, 2)
    ELSE NULL
  END AS stock_value,
  (SELECT count(*)::integer FROM public.item_images ii WHERE ii.item_id = i.id) AS image_count,
  (SELECT count(*)::integer FROM public.unit_conversions uc WHERE uc.item_id = i.id) AS conversions_count
FROM public.items i
LEFT JOIN public.item_categories c ON c.id = i.category_id
LEFT JOIN public.brands b ON b.id = i.brand_id
JOIN public.item_units u ON u.id = i.base_unit_id
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_catalog_view SET (security_invoker = false);

CREATE OR REPLACE VIEW public.inventory_summary_view AS
SELECT
  count(*) FILTER (WHERE i.is_active = true)::integer AS active_items_count,
  count(*) FILTER (WHERE i.is_active = false)::integer AS archived_items_count,
  count(*) FILTER (
    WHERE i.is_active = true
      AND i.low_stock_alert > 0
      AND COALESCE(sb.qty_on_hand, 0) <= i.low_stock_alert
  )::integer AS low_stock_count,
  count(*) FILTER (
    WHERE i.is_active = true
      AND COALESCE(sb.qty_on_hand, 0) <= 0
  )::integer AS out_of_stock_count,
  COALESCE(sum(GREATEST(COALESCE(sb.qty_on_hand, 0), 0)) FILTER (WHERE i.is_active = true), 0)::numeric(15,3) AS total_stock_units,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
      THEN COALESCE(
        round(sum(GREATEST(COALESCE(sb.qty_on_hand, 0), 0) * COALESCE(i.purchase_price, 0)) FILTER (WHERE i.is_active = true)::numeric, 2),
        0
      )
    ELSE NULL
  END AS total_stock_value
FROM public.items i
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
HAVING public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.inventory_summary_view SET (security_invoker = false);

CREATE OR REPLACE VIEW public.stock_ledger_view AS
SELECT
  sl.id,
  sl.item_id,
  sl.movement_type,
  sl.movement_date,
  sl.entered_qty,
  sl.entered_unit_id,
  u.code AS entered_unit_code,
  u.name_en AS entered_unit_name_en,
  u.name_hi AS entered_unit_name_hi,
  sl.conversion_factor,
  sl.signed_base_qty,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN sl.unit_cost
    ELSE NULL
  END AS unit_cost,
  sl.reason,
  sl.reference_no,
  sl.source_table,
  sl.source_id,
  sl.idempotency_key,
  sl.created_by,
  p.full_name AS created_by_name,
  sl.created_at
FROM public.stock_ledger sl
JOIN public.item_units u ON u.id = sl.entered_unit_id
LEFT JOIN public.profiles p ON p.id = sl.created_by
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.stock_ledger_view SET (security_invoker = false);

-- 9. Transactional RPCs for Phase 3

-- Categories CRUD
CREATE OR REPLACE FUNCTION public.save_item_category(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT '',
  p_description text DEFAULT NULL
)
RETURNS public.item_categories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_clean text;
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

  IF p_id IS NULL THEN
    INSERT INTO public.item_categories (name, description, created_by)
    VALUES (v_clean, NULLIF(trim(COALESCE(p_description, '')), ''), auth.uid())
    ON CONFLICT ((lower(trim(name)))) DO UPDATE
      SET is_active = true,
          description = COALESCE(EXCLUDED.description, public.item_categories.description)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.item_categories
    SET name = v_clean,
        description = NULLIF(trim(COALESCE(p_description, '')), '')
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
    'item_category', v_row.id::text, jsonb_build_object('name', v_row.name)
  );

  RETURN v_row;
END;
$$;

-- Brands CRUD
CREATE OR REPLACE FUNCTION public.save_brand(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT ''
)
RETURNS public.brands
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_clean text;
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

  IF p_id IS NULL THEN
    INSERT INTO public.brands (name, created_by)
    VALUES (v_clean, auth.uid())
    ON CONFLICT ((lower(trim(name)))) DO UPDATE
      SET is_active = true
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.brands
    SET name = v_clean
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
    'brand', v_row.id::text, jsonb_build_object('name', v_row.name)
  );

  RETURN v_row;
END;
$$;

-- Units CRUD
CREATE OR REPLACE FUNCTION public.save_item_unit(
  p_id uuid DEFAULT NULL,
  p_code text DEFAULT '',
  p_name_en text DEFAULT '',
  p_name_hi text DEFAULT '',
  p_allow_decimal boolean DEFAULT false
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

  IF p_id IS NULL THEN
    INSERT INTO public.item_units (code, name_en, name_hi, allow_decimal, is_system)
    VALUES (v_code, v_name_en, v_name_hi, COALESCE(p_allow_decimal, false), false)
    ON CONFLICT ((upper(trim(code)))) DO UPDATE
      SET name_en = EXCLUDED.name_en,
          name_hi = EXCLUDED.name_hi,
          allow_decimal = EXCLUDED.allow_decimal,
          is_active = true
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.item_units
    SET code = v_code,
        name_en = v_name_en,
        name_hi = v_name_hi,
        allow_decimal = COALESCE(p_allow_decimal, false)
    WHERE id = p_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit not found.';
    END IF;
  END IF;

  RETURN v_row;
END;
$$;

-- Sync ordered multi-image gallery for an item
CREATE OR REPLACE FUNCTION public.sync_item_images(
  p_item_id uuid,
  p_images jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_arr jsonb := COALESCE(p_images, '[]'::jsonb);
  v_count integer;
  v_has_primary boolean := false;
  v_primary_file uuid := NULL;
  v_removed_files uuid[] := ARRAY[]::uuid[];
  v_idx integer := 0;
  v_elem jsonb;
  v_fid uuid;
  v_is_prim boolean;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can manage item images.';
  END IF;

  IF jsonb_typeof(v_arr) <> 'array' THEN
    RAISE EXCEPTION 'Images payload must be a JSON array.';
  END IF;

  PERFORM 1 FROM public.items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found.';
  END IF;

  v_count := jsonb_array_length(v_arr);
  IF v_count > 10 THEN
    RAISE EXCEPTION 'An item can have at most 10 images.';
  END IF;

  -- Capture removed file IDs so caller / server can clean up orphaned storage objects
  SELECT COALESCE(array_agg(existing.file_id), ARRAY[]::uuid[])
  INTO v_removed_files
  FROM public.item_images existing
  WHERE existing.item_id = p_item_id
    AND existing.file_id NOT IN (
      SELECT (e->>'file_id')::uuid
      FROM jsonb_array_elements(v_arr) e
      WHERE (e->>'file_id') IS NOT NULL
    );

  DELETE FROM public.item_images WHERE item_id = p_item_id;
  DELETE FROM public.file_links WHERE entity_type = 'item' AND entity_id = p_item_id::text;

  IF v_count > 0 THEN
    -- Determine whether payload specified a primary image
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_arr) e
      WHERE COALESCE((e->>'is_primary')::boolean, false) = true
    ) INTO v_has_primary;

    FOR v_elem IN SELECT value FROM jsonb_array_elements(v_arr)
    LOOP
      v_fid := (v_elem->>'file_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.files WHERE id = v_fid) THEN
        RAISE EXCEPTION 'Referenced image file % does not exist.', v_fid;
      END IF;

      v_is_prim := CASE
        WHEN v_primary_file IS NOT NULL THEN false
        WHEN v_has_primary THEN COALESCE((v_elem->>'is_primary')::boolean, false)
        ELSE (v_idx = 0)
      END;

      IF v_is_prim THEN
        v_primary_file := v_fid;
      END IF;

      INSERT INTO public.item_images (item_id, file_id, sort_order, is_primary)
      VALUES (p_item_id, v_fid, v_idx, v_is_prim)
      ON CONFLICT (item_id, file_id) DO UPDATE
        SET sort_order = EXCLUDED.sort_order,
            is_primary = EXCLUDED.is_primary;

      INSERT INTO public.file_links (file_id, entity_type, entity_id, sort_order, is_primary)
      VALUES (v_fid, 'item', p_item_id::text, v_idx, v_is_prim)
      ON CONFLICT (file_id, entity_type, entity_id) DO UPDATE
        SET sort_order = EXCLUDED.sort_order,
            is_primary = EXCLUDED.is_primary;

      v_idx := v_idx + 1;
    END LOOP;
  END IF;

  UPDATE public.items
  SET primary_image_file_id = v_primary_file
  WHERE id = p_item_id;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    'item.images_synced',
    'item',
    p_item_id::text,
    jsonb_build_object('image_count', v_count, 'primary_file_id', v_primary_file)
  );

  RETURN jsonb_build_object(
    'item_id', p_item_id,
    'primary_image_file_id', v_primary_file,
    'image_count', v_count,
    'removed_file_ids', to_jsonb(v_removed_files)
  );
END;
$$;

-- Create or Update Item with Conversions, Opening Stock, and Images
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
  p_expected_version integer DEFAULT NULL
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

  v_clean_sku := NULLIF(upper(trim(COALESCE(p_sku, ''))), '');
  v_clean_barcode := NULLIF(upper(trim(COALESCE(p_barcode, ''))), '');
  v_clean_hsn := NULLIF(trim(COALESCE(p_hsn_code, '')), '');

  IF p_id IS NULL THEN
    v_eff_purchase := CASE WHEN v_can_edit_cost THEN COALESCE(p_purchase_price, 0) ELSE 0 END;

    INSERT INTO public.items (
      name, sku, barcode, category_id, brand_id, base_unit_id,
      selling_price, mrp, purchase_price, gst_rate, hsn_code,
      tax_inclusive, low_stock_alert, allow_negative_stock,
      pack_metadata, notes, created_by
    )
    VALUES (
      v_clean_name, v_clean_sku, v_clean_barcode, p_category_id, p_brand_id, p_base_unit_id,
      round(COALESCE(p_selling_price, 0)::numeric, 2),
      CASE WHEN p_mrp IS NOT NULL THEN round(p_mrp::numeric, 2) ELSE NULL END,
      round(v_eff_purchase::numeric, 2),
      COALESCE(p_gst_rate, 0),
      v_clean_hsn,
      COALESCE(p_tax_inclusive, false),
      round(COALESCE(p_low_stock_alert, 0)::numeric, 3),
      COALESCE(p_allow_negative_stock, false),
      COALESCE(p_pack_metadata, '{}'::jsonb),
      NULLIF(trim(COALESCE(p_notes, '')), ''),
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

    -- Preserve hidden purchase_price when edited by Storekeeper (who cannot view/edit purchase cost)
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
      low_stock_alert = round(COALESCE(p_low_stock_alert, 0)::numeric, 3),
      allow_negative_stock = COALESCE(p_allow_negative_stock, false),
      pack_metadata = COALESCE(p_pack_metadata, '{}'::jsonb),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      version = v_existing.version + 1
    WHERE id = p_id
    RETURNING * INTO v_item;
  END IF;

  -- Upsert unit conversions
  IF p_conversions IS NOT NULL THEN
    IF jsonb_typeof(p_conversions) <> 'array' THEN
      RAISE EXCEPTION 'Unit conversions must be a JSON array.';
    END IF;

    DELETE FROM public.unit_conversions WHERE item_id = v_item.id;

    FOR v_conv IN SELECT value FROM jsonb_array_elements(p_conversions)
    LOOP
      v_alt_unit := NULLIF(v_conv->>'alternate_unit_id', '')::uuid;
      v_factor := (v_conv->>'conversion_factor')::numeric(18,6);

      IF v_alt_unit IS NOT NULL THEN
        IF v_alt_unit = v_item.base_unit_id THEN
          RAISE EXCEPTION 'Alternate unit cannot be the same as the base unit.';
        END IF;
        IF v_factor IS NULL OR v_factor <= 0 THEN
          RAISE EXCEPTION 'Conversion factor must be greater than zero.';
        END IF;

        INSERT INTO public.unit_conversions (item_id, alternate_unit_id, conversion_factor)
        VALUES (v_item.id, v_alt_unit, v_factor);
      END IF;
    END LOOP;
  END IF;

  -- Post opening stock ONLY on item creation
  IF p_id IS NULL THEN
    v_open_qty := COALESCE(p_opening_stock, 0)::numeric(15,3);
    IF v_open_qty < 0 THEN
      RAISE EXCEPTION 'Opening stock cannot be negative.';
    END IF;
    IF v_open_qty > 0 THEN
      v_open_unit := COALESCE(p_opening_unit_id, v_item.base_unit_id);
      SELECT base_qty, conversion_factor
      INTO v_open_base, v_open_factor
      FROM public.convert_item_qty(v_item.id, v_open_qty, v_open_unit);

      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        v_item.id,
        'opening_stock',
        CURRENT_DATE,
        v_open_qty,
        v_open_unit,
        v_open_factor,
        v_open_base,
        CASE WHEN v_eff_purchase > 0 THEN v_eff_purchase ELSE NULL END,
        'Opening Stock',
        public.next_document_number('stock_adjustment', CURRENT_DATE),
        'items',
        v_item.id,
        auth.uid()
      );
    END IF;
  END IF;

  -- Sync multi-image gallery if provided
  IF p_images IS NOT NULL THEN
    v_img_res := public.sync_item_images(v_item.id, p_images);
    v_removed_files := COALESCE(v_img_res->'removed_file_ids', '[]'::jsonb);
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    CASE WHEN p_id IS NULL THEN 'item.created' ELSE 'item.updated' END,
    'item',
    v_item.id::text,
    jsonb_build_object(
      'name', v_item.name,
      'sku', v_item.sku,
      'selling_price', v_item.selling_price
    )
  );

  RETURN jsonb_build_object(
    'id', v_item.id,
    'version', v_item.version,
    'primary_image_file_id', COALESCE((v_img_res->>'primary_image_file_id')::uuid, v_item.primary_image_file_id),
    'removed_file_ids', v_removed_files
  );
END;
$$;

-- Archive / Restore Item
CREATE OR REPLACE FUNCTION public.archive_item(
  p_item_id uuid,
  p_is_active boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_item public.items;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can archive or restore items.';
  END IF;

  UPDATE public.items
  SET is_active = COALESCE(p_is_active, false),
      version = version + 1
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found.';
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    CASE WHEN v_item.is_active THEN 'item.restored' ELSE 'item.archived' END,
    'item',
    v_item.id::text,
    jsonb_build_object('name', v_item.name, 'is_active', v_item.is_active)
  );

  RETURN jsonb_build_object('id', v_item.id, 'is_active', v_item.is_active);
END;
$$;

-- Transactional Stock Adjustment with Reason, Unit Conversion, & Idempotency
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_item_id uuid,
  p_direction text,
  p_qty numeric,
  p_unit_id uuid DEFAULT NULL,
  p_reason text DEFAULT '',
  p_movement_date date DEFAULT CURRENT_DATE,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_clean_reason text;
  v_idemp text;
  v_existing public.stock_ledger;
  v_item public.items;
  v_unit_id uuid;
  v_base_qty numeric(15,3);
  v_factor numeric(18,6);
  v_signed numeric(15,3);
  v_mov_type text;
  v_ref_no text;
  v_ledger public.stock_ledger;
  v_new_balance numeric(15,3);
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can adjust stock.';
  END IF;

  IF p_direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'Stock adjustment direction must be in or out.';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter an adjustment reason (minimum 3 characters).';
  END IF;

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.stock_ledger
    WHERE idempotency_key = v_idemp;
    IF FOUND THEN
      SELECT qty_on_hand INTO v_new_balance
      FROM public.stock_balances
      WHERE item_id = v_existing.item_id;
      RETURN jsonb_build_object(
        'ledger_id', v_existing.id,
        'reference_no', v_existing.reference_no,
        'signed_base_qty', v_existing.signed_base_qty,
        'qty_on_hand', COALESCE(v_new_balance, 0),
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT * INTO v_item FROM public.items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found.';
  END IF;

  v_unit_id := COALESCE(p_unit_id, v_item.base_unit_id);
  SELECT base_qty, conversion_factor
  INTO v_base_qty, v_factor
  FROM public.convert_item_qty(p_item_id, p_qty, v_unit_id);

  v_mov_type := CASE WHEN p_direction = 'in' THEN 'adjustment_in' ELSE 'adjustment_out' END;
  v_signed := CASE WHEN p_direction = 'in' THEN v_base_qty ELSE -v_base_qty END;
  v_ref_no := public.next_document_number('stock_adjustment', COALESCE(p_movement_date, CURRENT_DATE));

  INSERT INTO public.stock_ledger (
    item_id, movement_type, movement_date, entered_qty, entered_unit_id,
    conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
    source_table, idempotency_key, created_by
  )
  VALUES (
    p_item_id,
    v_mov_type,
    COALESCE(p_movement_date, CURRENT_DATE),
    round(p_qty::numeric, 3),
    v_unit_id,
    v_factor,
    v_signed,
    CASE WHEN v_item.purchase_price > 0 THEN v_item.purchase_price ELSE NULL END,
    v_clean_reason,
    v_ref_no,
    'stock_adjustment',
    v_idemp,
    auth.uid()
  )
  RETURNING * INTO v_ledger;

  SELECT qty_on_hand INTO v_new_balance
  FROM public.stock_balances
  WHERE item_id = p_item_id;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    'stock.adjusted',
    'item',
    p_item_id::text,
    jsonb_build_object(
      'reference_no', v_ref_no,
      'movement_type', v_mov_type,
      'entered_qty', p_qty,
      'conversion_factor', v_factor,
      'signed_base_qty', v_signed,
      'qty_on_hand', COALESCE(v_new_balance, 0),
      'reason', v_clean_reason
    )
  );

  RETURN jsonb_build_object(
    'ledger_id', v_ledger.id,
    'reference_no', v_ref_no,
    'signed_base_qty', v_signed,
    'qty_on_hand', COALESCE(v_new_balance, 0),
    'idempotent_replay', false
  );
END;
$$;

-- 10. Row-Level Security & Strict Column-Level Purchase-Cost Privileges
ALTER TABLE public.item_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unit_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_balances ENABLE ROW LEVEL SECURITY;

-- Revoke direct writes on items, conversions, images, stock_ledger, and stock_balances;
-- AND explicitly exclude purchase_price / unit_cost from authenticated column SELECT!
REVOKE ALL ON public.items FROM anon, authenticated;
GRANT SELECT (
  id, name, sku, barcode, category_id, brand_id, base_unit_id,
  selling_price, mrp, gst_rate, hsn_code, tax_inclusive,
  low_stock_alert, allow_negative_stock, primary_image_file_id,
  pack_metadata, notes, is_active, is_demo, version,
  created_by, created_at, updated_at
) ON public.items TO authenticated;

REVOKE ALL ON public.stock_ledger FROM anon, authenticated;
GRANT SELECT (
  id, item_id, movement_type, movement_date, entered_qty, entered_unit_id,
  conversion_factor, signed_base_qty, reason, reference_no,
  source_table, source_id, idempotency_key, is_demo, created_by, created_at
) ON public.stock_ledger TO authenticated;

REVOKE ALL ON public.stock_balances FROM anon, authenticated;
GRANT SELECT ON public.stock_balances TO authenticated;

REVOKE ALL ON public.unit_conversions FROM anon, authenticated;
GRANT SELECT ON public.unit_conversions TO authenticated;

REVOKE ALL ON public.item_images FROM anon, authenticated;
GRANT SELECT ON public.item_images TO authenticated;

GRANT SELECT ON public.item_categories TO authenticated;
GRANT SELECT ON public.brands TO authenticated;
GRANT SELECT ON public.item_units TO authenticated;

GRANT SELECT ON public.item_catalog_view TO authenticated;
GRANT SELECT ON public.inventory_summary_view TO authenticated;
GRANT SELECT ON public.stock_ledger_view TO authenticated;

-- RLS policies: Inventory read = Owner, Manager, Storekeeper, Cashier, Accountant (Viewer excluded)
DROP POLICY IF EXISTS "Inventory roles read categories" ON public.item_categories;
CREATE POLICY "Inventory roles read categories" ON public.item_categories
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Inventory roles read brands" ON public.brands;
CREATE POLICY "Inventory roles read brands" ON public.brands
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Inventory roles read units" ON public.item_units;
CREATE POLICY "Inventory roles read units" ON public.item_units
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Inventory roles read items" ON public.items;
CREATE POLICY "Inventory roles read items" ON public.items
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Inventory roles read conversions" ON public.unit_conversions;
CREATE POLICY "Inventory roles read conversions" ON public.unit_conversions
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Inventory roles read item_images" ON public.item_images;
CREATE POLICY "Inventory roles read item_images" ON public.item_images
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Inventory roles read stock_ledger" ON public.stock_ledger;
CREATE POLICY "Inventory roles read stock_ledger" ON public.stock_ledger
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Inventory roles read stock_balances" ON public.stock_balances;
CREATE POLICY "Inventory roles read stock_balances" ON public.stock_balances
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

-- Harden Phase 1 file_links policies so Cashier/Viewer cannot attach/mutate item or business file links directly
DROP POLICY IF EXISTS "Staff can manage file_links" ON public.file_links;
DROP POLICY IF EXISTS "Authorized staff manage file_links" ON public.file_links;
CREATE POLICY "Authorized staff manage file_links" ON public.file_links
  FOR ALL TO authenticated
  USING (
    CASE
      WHEN entity_type = 'business' THEN public.is_owner()
      WHEN entity_type = 'item' THEN public.is_module_enabled('inventory') AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper'])
      WHEN entity_type = 'profile' THEN entity_id = auth.uid()::text OR public.is_owner()
      ELSE public.has_any_role(ARRAY['owner', 'manager'])
    END
  )
  WITH CHECK (
    CASE
      WHEN entity_type = 'business' THEN public.is_owner()
      WHEN entity_type = 'item' THEN public.is_module_enabled('inventory') AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper'])
      WHEN entity_type = 'profile' THEN entity_id = auth.uid()::text OR public.is_owner()
      ELSE public.has_any_role(ARRAY['owner', 'manager'])
    END
  );
