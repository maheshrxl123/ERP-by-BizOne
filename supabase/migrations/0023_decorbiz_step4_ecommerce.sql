-- DecorBiz - Step 4 Migration: Retail Storefront & E-Commerce Fulfillment
--   1. Separate customer accounts table (public.customers) isolated from staff (public.profiles).
--   2. Storefront publication fields on items + reserved_qty on stock_balances & item_variants.
--   3. Safe published_store_items_view + updated apply_stock_ledger_to_balance reservation guard.
--   4. E-commerce tables: store_delivery_zones, store_coupons, store_banners, store_pages,
--      store_delivery_trips, store_orders, store_order_lines, customer_wishlists, product_reviews.
--   5. Transactional stock reservation / deduction / release RPC (store_transition_order_stock).

-- ============================================================================
-- 1. Customers Table (Separate from Staff Profiles) + Auth Helpers
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL CHECK (length(trim(full_name)) >= 1),
  email text NOT NULL,
  phone text,
  default_address text,
  default_pincode text,
  email_verified boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_unique
  ON public.customers (lower(trim(email)));

DROP TRIGGER IF EXISTS trg_customers_updated_at ON public.customers;
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.current_customer_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.customers
  WHERE auth_user_id = auth.uid()
    AND is_active = true
  LIMIT 1;
$$;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_self_select ON public.customers;
CREATE POLICY customers_self_select ON public.customers
  FOR SELECT TO authenticated
  USING (
    auth_user_id = auth.uid()
    OR public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'storekeeper', 'accountant'])
  );

DROP POLICY IF EXISTS customers_self_update ON public.customers;
CREATE POLICY customers_self_update ON public.customers
  FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

GRANT SELECT, UPDATE ON public.customers TO authenticated;

-- ============================================================================
-- 2. Items Storefront Fields & Unified Stock Pool Reservations
-- ============================================================================
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS is_published_online boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS online_price numeric(15,2) CHECK (online_price IS NULL OR online_price >= 0),
  ADD COLUMN IF NOT EXISTS online_slug text,
  ADD COLUMN IF NOT EXISTS online_description text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_online_slug_unique
  ON public.items (lower(trim(online_slug)))
  WHERE online_slug IS NOT NULL AND trim(online_slug) <> '';

CREATE INDEX IF NOT EXISTS idx_items_published_online
  ON public.items (is_published_online, is_active, product_line);

ALTER TABLE public.stock_balances
  ADD COLUMN IF NOT EXISTS reserved_qty numeric(15,3) NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0);

ALTER TABLE public.item_variants
  ADD COLUMN IF NOT EXISTS reserved_qty numeric(15,3) NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0);

-- Enforce unreserved pool protection on ERP deductions alongside online reservations
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
  v_reserved numeric(15,3) := 0;
  v_next numeric(15,3);
  v_var_current numeric(15,3) := 0;
  v_var_reserved numeric(15,3) := 0;
  v_var_next numeric(15,3);
BEGIN
  SELECT name, allow_negative_stock
  INTO v_item_name, v_allow_neg
  FROM public.items
  WHERE id = NEW.item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found for stock movement.';
  END IF;

  INSERT INTO public.stock_balances (item_id, qty_on_hand, reserved_qty, last_movement_at, updated_at)
  VALUES (NEW.item_id, 0, 0, NULL, now())
  ON CONFLICT (item_id) DO NOTHING;

  SELECT qty_on_hand, COALESCE(reserved_qty, 0)
  INTO v_current, v_reserved
  FROM public.stock_balances
  WHERE item_id = NEW.item_id
  FOR UPDATE;

  v_next := round(COALESCE(v_current, 0) + NEW.signed_base_qty, 3);

  IF NEW.signed_base_qty < 0 AND NOT COALESCE(v_allow_neg, false) THEN
    IF COALESCE(NEW.source_table, '') <> 'store_orders'
       AND round(COALESCE(v_current, 0) - v_reserved + NEW.signed_base_qty, 3) < 0 THEN
      RAISE EXCEPTION 'Insufficient unreserved stock for "%". Available: %, Reserved: %, Requested reduction: %.',
        v_item_name, GREATEST(0, v_current - v_reserved), v_reserved, abs(NEW.signed_base_qty);
    END IF;
    IF v_next < 0 THEN
      RAISE EXCEPTION 'Insufficient stock for "%". Available: %, requested reduction: %.',
        v_item_name, v_current, abs(NEW.signed_base_qty);
    END IF;
  END IF;

  UPDATE public.stock_balances
  SET
    qty_on_hand = v_next,
    last_movement_at = GREATEST(COALESCE(last_movement_at, NEW.created_at), NEW.created_at),
    updated_at = now()
  WHERE item_id = NEW.item_id;

  IF NEW.variant_id IS NOT NULL THEN
    SELECT qty_on_hand, COALESCE(reserved_qty, 0)
    INTO v_var_current, v_var_reserved
    FROM public.item_variants
    WHERE id = NEW.variant_id
    FOR UPDATE;

    IF FOUND THEN
      v_var_next := round(COALESCE(v_var_current, 0) + NEW.signed_base_qty, 3);
      IF NEW.signed_base_qty < 0 AND NOT COALESCE(v_allow_neg, false) THEN
        IF COALESCE(NEW.source_table, '') <> 'store_orders'
           AND round(COALESCE(v_var_current, 0) - v_var_reserved + NEW.signed_base_qty, 3) < 0 THEN
          RAISE EXCEPTION 'Insufficient unreserved variant stock. Available: %, Reserved: %, Requested reduction: %.',
            GREATEST(0, v_var_current - v_var_reserved), v_var_reserved, abs(NEW.signed_base_qty);
        END IF;
        IF v_var_next < 0 THEN
          RAISE EXCEPTION 'Insufficient variant stock. Available: %, requested reduction: %.',
            v_var_current, abs(NEW.signed_base_qty);
        END IF;
      END IF;

      UPDATE public.item_variants
      SET qty_on_hand = v_var_next, updated_at = now()
      WHERE id = NEW.variant_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Append Step 4 columns cleanly at the end of item_catalog_view and item_variants_view
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
  i.description,
  CASE i.product_line
    WHEN 'tiles_slabs' THEN to_jsonb(st) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'sanitaryware' THEN to_jsonb(ss) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'faucets_cp' THEN to_jsonb(sf) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'tile_adhesive' THEN to_jsonb(sa) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'other_general' THEN to_jsonb(so) - 'item_id' - 'created_at' - 'updated_at'
    ELSE NULL
  END AS specs,
  COALESCE(sb.reserved_qty, 0)::numeric(15,3) AS reserved_qty,
  GREATEST(0, COALESCE(sb.qty_on_hand, 0) - COALESCE(sb.reserved_qty, 0))::numeric(15,3) AS available_qty,
  i.is_published_online,
  i.online_price,
  i.online_slug,
  i.online_description
FROM public.items i
LEFT JOIN public.item_categories c ON c.id = i.category_id
LEFT JOIN public.brands b ON b.id = i.brand_id
LEFT JOIN public.parties sp ON sp.id = i.supplier_id
JOIN public.item_units u ON u.id = i.base_unit_id
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
LEFT JOIN public.item_specs_tiles_slabs st ON st.item_id = i.id
LEFT JOIN public.item_specs_sanitaryware ss ON ss.item_id = i.id
LEFT JOIN public.item_specs_faucets_cp sf ON sf.item_id = i.id
LEFT JOIN public.item_specs_tile_adhesive sa ON sa.item_id = i.id
LEFT JOIN public.item_specs_other_general so ON so.item_id = i.id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_catalog_view SET (security_invoker = false);
GRANT SELECT ON public.item_catalog_view TO authenticated;

CREATE OR REPLACE VIEW public.item_variants_view AS
SELECT
  iv.id,
  iv.item_id,
  i.name AS item_name,
  u.code AS base_unit_code,
  iv.variant_name,
  iv.size_label,
  iv.finish,
  iv.shade,
  iv.batch_lot,
  iv.sku,
  iv.barcode,
  iv.selling_price,
  iv.mrp,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN iv.purchase_price
    ELSE NULL
  END AS purchase_price,
  iv.qty_on_hand,
  iv.is_active,
  iv.created_at,
  iv.updated_at,
  COALESCE(iv.reserved_qty, 0)::numeric(15,3) AS reserved_qty,
  GREATEST(0, COALESCE(iv.qty_on_hand, 0) - COALESCE(iv.reserved_qty, 0))::numeric(15,3) AS available_qty
FROM public.item_variants iv
JOIN public.items i ON i.id = iv.item_id
JOIN public.item_units u ON u.id = i.base_unit_id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_variants_view SET (security_invoker = false);

-- Safe Public Storefront View (strictly only active + published items, zero cost/internal notes)
CREATE OR REPLACE VIEW public.published_store_items_view AS
SELECT
  i.id,
  i.name,
  i.sku,
  i.item_type,
  i.product_line,
  i.category_id,
  c.name AS category_name,
  i.brand_id,
  b.name AS brand_name,
  u.code AS base_unit_code,
  u.name_en AS base_unit_name_en,
  i.selling_price,
  i.online_price,
  COALESCE(i.online_price, i.selling_price)::numeric(15,2) AS effective_price,
  i.mrp,
  i.gst_rate,
  i.tax_inclusive,
  i.allow_negative_stock,
  i.primary_image_file_id,
  i.warranty_months,
  i.video_url,
  i.description,
  i.online_description,
  COALESCE(NULLIF(trim(i.online_slug), ''), i.id::text) AS online_slug,
  CASE i.product_line
    WHEN 'tiles_slabs' THEN to_jsonb(st) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'sanitaryware' THEN to_jsonb(ss) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'faucets_cp' THEN to_jsonb(sf) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'tile_adhesive' THEN to_jsonb(sa) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'other_general' THEN to_jsonb(so) - 'item_id' - 'created_at' - 'updated_at'
    ELSE NULL
  END AS specs,
  COALESCE(sb.qty_on_hand, 0)::numeric(15,3) AS qty_on_hand,
  COALESCE(sb.reserved_qty, 0)::numeric(15,3) AS reserved_qty,
  GREATEST(0, COALESCE(sb.qty_on_hand, 0) - COALESCE(sb.reserved_qty, 0))::numeric(15,3) AS available_qty,
  (
    i.item_type = 'service'
    OR i.allow_negative_stock
    OR GREATEST(0, COALESCE(sb.qty_on_hand, 0) - COALESCE(sb.reserved_qty, 0)) > 0
  ) AS in_stock,
  COALESCE(
    (
      SELECT jsonb_agg(ii.file_id ORDER BY ii.is_primary DESC, ii.sort_order ASC)
      FROM public.item_images ii
      WHERE ii.item_id = i.id
    ),
    '[]'::jsonb
  ) AS image_file_ids,
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', iv.id,
          'variant_name', iv.variant_name,
          'size_label', iv.size_label,
          'finish', iv.finish,
          'shade', iv.shade,
          'sku', iv.sku,
          'selling_price', iv.selling_price,
          'mrp', iv.mrp,
          'available_qty', GREATEST(0, COALESCE(iv.qty_on_hand, 0) - COALESCE(iv.reserved_qty, 0))
        )
        ORDER BY iv.variant_name ASC
      )
      FROM public.item_variants iv
      WHERE iv.item_id = i.id AND iv.is_active = true
    ),
    '[]'::jsonb
  ) AS variants,
  i.created_at,
  i.updated_at
FROM public.items i
LEFT JOIN public.item_categories c ON c.id = i.category_id
LEFT JOIN public.brands b ON b.id = i.brand_id
JOIN public.item_units u ON u.id = i.base_unit_id
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
LEFT JOIN public.item_specs_tiles_slabs st ON st.item_id = i.id
LEFT JOIN public.item_specs_sanitaryware ss ON ss.item_id = i.id
LEFT JOIN public.item_specs_faucets_cp sf ON sf.item_id = i.id
LEFT JOIN public.item_specs_tile_adhesive sa ON sa.item_id = i.id
LEFT JOIN public.item_specs_other_general so ON so.item_id = i.id
WHERE i.is_active = true
  AND i.is_published_online = true
  AND public.is_module_enabled('online_store');

ALTER VIEW public.published_store_items_view SET (security_invoker = false);
GRANT SELECT ON public.published_store_items_view TO anon, authenticated;

-- ============================================================================
-- 3. Storefront Delivery Zones, Coupons, Banners, Pages & Trips
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.store_delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_name text NOT NULL CHECK (length(trim(zone_name)) >= 1),
  pincodes text[] NOT NULL DEFAULT '{}'::text[],
  area_keywords text[] NOT NULL DEFAULT '{}'::text[],
  delivery_charge numeric(15,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  min_order_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  estimated_days integer NOT NULL DEFAULT 2 CHECK (estimated_days >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_store_delivery_zones_updated_at ON public.store_delivery_zones;
CREATE TRIGGER trg_store_delivery_zones_updated_at
  BEFORE UPDATE ON public.store_delivery_zones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.store_delivery_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_delivery_zones_select ON public.store_delivery_zones;
CREATE POLICY store_delivery_zones_select ON public.store_delivery_zones
  FOR SELECT TO anon, authenticated
  USING (
    (is_active = true AND public.is_module_enabled('online_store'))
    OR public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier'])
  );

DROP POLICY IF EXISTS store_delivery_zones_manage ON public.store_delivery_zones;
CREATE POLICY store_delivery_zones_manage ON public.store_delivery_zones
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']));

GRANT SELECT ON public.store_delivery_zones TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.store_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL CHECK (length(trim(code)) >= 2),
  description text,
  discount_type text NOT NULL CHECK (discount_type IN ('pct', 'flat')),
  discount_value numeric(15,2) NOT NULL CHECK (discount_value > 0),
  min_order_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  max_discount numeric(15,2) CHECK (max_discount IS NULL OR max_discount >= 0),
  valid_until date,
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_store_coupons_updated_at ON public.store_coupons;
CREATE TRIGGER trg_store_coupons_updated_at
  BEFORE UPDATE ON public.store_coupons
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.store_coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_coupons_select ON public.store_coupons;
CREATE POLICY store_coupons_select ON public.store_coupons
  FOR SELECT TO anon, authenticated
  USING (
    (is_active = true AND (valid_until IS NULL OR valid_until >= CURRENT_DATE) AND public.is_module_enabled('online_store'))
    OR public.has_any_role(ARRAY['owner', 'manager'])
  );

DROP POLICY IF EXISTS store_coupons_manage ON public.store_coupons;
CREATE POLICY store_coupons_manage ON public.store_coupons
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager']));

GRANT SELECT ON public.store_coupons TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.store_banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(trim(title)) >= 1),
  subtitle text,
  cta_label text,
  cta_link text,
  image_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_store_banners_updated_at ON public.store_banners;
CREATE TRIGGER trg_store_banners_updated_at
  BEFORE UPDATE ON public.store_banners
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.store_banners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_banners_select ON public.store_banners;
CREATE POLICY store_banners_select ON public.store_banners
  FOR SELECT TO anon, authenticated
  USING (
    (is_active = true AND public.is_module_enabled('online_store'))
    OR public.has_any_role(ARRAY['owner', 'manager', 'storekeeper'])
  );

DROP POLICY IF EXISTS store_banners_manage ON public.store_banners;
CREATE POLICY store_banners_manage ON public.store_banners
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']));

GRANT SELECT ON public.store_banners TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.store_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL CHECK (length(trim(slug)) >= 1),
  title text NOT NULL CHECK (length(trim(title)) >= 1),
  content text NOT NULL DEFAULT '',
  is_published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_store_pages_updated_at ON public.store_pages;
CREATE TRIGGER trg_store_pages_updated_at
  BEFORE UPDATE ON public.store_pages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.store_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_pages_select ON public.store_pages;
CREATE POLICY store_pages_select ON public.store_pages
  FOR SELECT TO anon, authenticated
  USING (
    (is_published = true AND public.is_module_enabled('online_store'))
    OR public.has_any_role(ARRAY['owner', 'manager'])
  );

DROP POLICY IF EXISTS store_pages_manage ON public.store_pages;
CREATE POLICY store_pages_manage ON public.store_pages
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager']));

GRANT SELECT ON public.store_pages TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.store_delivery_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_number text UNIQUE NOT NULL,
  trip_date date NOT NULL DEFAULT CURRENT_DATE,
  driver_name text NOT NULL CHECK (length(trim(driver_name)) >= 1),
  driver_phone text,
  vehicle_no text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'dispatched', 'completed', 'cancelled')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_store_delivery_trips_updated_at ON public.store_delivery_trips;
CREATE TRIGGER trg_store_delivery_trips_updated_at
  BEFORE UPDATE ON public.store_delivery_trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.store_delivery_trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_delivery_trips_staff ON public.store_delivery_trips;
CREATE POLICY store_delivery_trips_staff ON public.store_delivery_trips
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']));

-- ============================================================================
-- 4. Store Orders, Lines, Wishlists & Reviews (Strict Customer Isolation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.store_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text UNIQUE NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending', 'confirmed', 'packing', 'out_for_delivery',
      'ready_for_pickup', 'delivered', 'picked_up', 'cancelled'
    )
  ),
  fulfillment_type text NOT NULL CHECK (fulfillment_type IN ('delivery', 'pickup')),
  zone_id uuid REFERENCES public.store_delivery_zones(id) ON DELETE SET NULL,
  delivery_address text,
  delivery_pincode text,
  delivery_area text,
  coupon_code text,
  subtotal numeric(15,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  delivery_charge numeric(15,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  grand_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cod', 'pay_on_pickup', 'razorpay')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
  razorpay_order_id text,
  razorpay_payment_id text,
  razorpay_signature text,
  delivery_trip_id uuid REFERENCES public.store_delivery_trips(id) ON DELETE SET NULL,
  stock_state text NOT NULL DEFAULT 'none' CHECK (stock_state IN ('none', 'reserved', 'deducted', 'released')),
  customer_notes text,
  internal_notes text,
  confirmed_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_orders_customer ON public.store_orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_orders_status ON public.store_orders (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_store_orders_updated_at ON public.store_orders;
CREATE TRIGGER trg_store_orders_updated_at
  BEFORE UPDATE ON public.store_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_orders_customer_select ON public.store_orders;
CREATE POLICY store_orders_customer_select ON public.store_orders
  FOR SELECT TO authenticated
  USING (
    customer_id = public.current_customer_id()
    OR public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS store_orders_staff_update ON public.store_orders;
CREATE POLICY store_orders_staff_update ON public.store_orders
  FOR UPDATE TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier']));

GRANT SELECT ON public.store_orders TO authenticated;

CREATE TABLE IF NOT EXISTS public.store_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.store_orders(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES public.item_variants(id) ON DELETE SET NULL,
  item_name text NOT NULL,
  variant_name text,
  sku text,
  ordered_unit text NOT NULL DEFAULT 'base',
  ordered_qty numeric(15,3) NOT NULL CHECK (ordered_qty > 0),
  base_qty numeric(15,3) NOT NULL CHECK (base_qty > 0),
  unit_price numeric(15,2) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(15,2) NOT NULL CHECK (line_total >= 0),
  wastage_pct numeric(5,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_order_lines_order ON public.store_order_lines (order_id);

ALTER TABLE public.store_order_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_order_lines_select ON public.store_order_lines;
CREATE POLICY store_order_lines_select ON public.store_order_lines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.store_orders so
      WHERE so.id = store_order_lines.order_id
        AND (
          so.customer_id = public.current_customer_id()
          OR public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
        )
    )
  );

GRANT SELECT ON public.store_order_lines TO authenticated;

CREATE TABLE IF NOT EXISTS public.customer_wishlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, item_id)
);

ALTER TABLE public.customer_wishlists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_wishlists_self ON public.customer_wishlists;
CREATE POLICY customer_wishlists_self ON public.customer_wishlists
  FOR ALL TO authenticated
  USING (customer_id = public.current_customer_id())
  WITH CHECK (customer_id = public.current_customer_id());

GRANT SELECT, INSERT, DELETE ON public.customer_wishlists TO authenticated;

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title text,
  comment text NOT NULL CHECK (length(trim(comment)) >= 3),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_item_status
  ON public.product_reviews (item_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_product_reviews_updated_at ON public.product_reviews;
CREATE TRIGGER trg_product_reviews_updated_at
  BEFORE UPDATE ON public.product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_reviews_select ON public.product_reviews;
CREATE POLICY product_reviews_select ON public.product_reviews
  FOR SELECT TO anon, authenticated
  USING (
    status = 'approved'
    OR customer_id = public.current_customer_id()
    OR public.has_any_role(ARRAY['owner', 'manager'])
  );

DROP POLICY IF EXISTS product_reviews_customer_insert ON public.product_reviews;
CREATE POLICY product_reviews_customer_insert ON public.product_reviews
  FOR INSERT TO authenticated
  WITH CHECK (customer_id = public.current_customer_id());

DROP POLICY IF EXISTS product_reviews_staff_update ON public.product_reviews;
CREATE POLICY product_reviews_staff_update ON public.product_reviews
  FOR UPDATE TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager']));

GRANT SELECT, INSERT ON public.product_reviews TO authenticated;
GRANT SELECT ON public.product_reviews TO anon;

-- ============================================================================
-- 5. Transactional Order Stock Reservation / Deduction / Release RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.store_transition_order_stock(
  p_order_id uuid,
  p_target_status text
)
RETURNS public.store_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.store_orders;
  v_line record;
  v_item public.items;
  v_sb public.stock_balances;
  v_var public.item_variants;
  v_available numeric(15,3);
  v_next_stock_state text;
BEGIN
  IF p_target_status NOT IN (
    'pending', 'confirmed', 'packing', 'out_for_delivery',
    'ready_for_pickup', 'delivered', 'picked_up', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Invalid target store order status: %.', p_target_status;
  END IF;

  SELECT * INTO v_order
  FROM public.store_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Store order not found.';
  END IF;

  v_next_stock_state := v_order.stock_state;

  -- A. Moving to active reservation state (confirmed / packing / dispatch / ready)
  IF p_target_status IN ('confirmed', 'packing', 'out_for_delivery', 'ready_for_pickup') THEN
    IF v_order.stock_state IN ('none', 'released') THEN
      FOR v_line IN SELECT * FROM public.store_order_lines WHERE order_id = v_order.id
      LOOP
        SELECT * INTO v_item FROM public.items WHERE id = v_line.item_id FOR UPDATE;
        IF COALESCE(v_item.item_type, 'goods') <> 'goods' THEN
          CONTINUE;
        END IF;

        INSERT INTO public.stock_balances (item_id, qty_on_hand, reserved_qty)
        VALUES (v_line.item_id, 0, 0)
        ON CONFLICT (item_id) DO NOTHING;

        SELECT * INTO v_sb FROM public.stock_balances WHERE item_id = v_line.item_id FOR UPDATE;
        v_available := round(COALESCE(v_sb.qty_on_hand, 0) - COALESCE(v_sb.reserved_qty, 0), 3);
        IF NOT COALESCE(v_item.allow_negative_stock, false) AND v_available < v_line.base_qty THEN
          RAISE EXCEPTION 'Insufficient available stock to reserve "%". Available: %, Needed: %.',
            v_item.name, v_available, v_line.base_qty;
        END IF;

        UPDATE public.stock_balances
        SET reserved_qty = round(COALESCE(reserved_qty, 0) + v_line.base_qty, 3), updated_at = now()
        WHERE item_id = v_line.item_id;

        IF v_line.variant_id IS NOT NULL THEN
          SELECT * INTO v_var FROM public.item_variants WHERE id = v_line.variant_id FOR UPDATE;
          IF FOUND THEN
            v_available := round(COALESCE(v_var.qty_on_hand, 0) - COALESCE(v_var.reserved_qty, 0), 3);
            IF NOT COALESCE(v_item.allow_negative_stock, false) AND v_available < v_line.base_qty THEN
              RAISE EXCEPTION 'Insufficient available variant stock to reserve "%". Available: %, Needed: %.',
                v_var.variant_name, v_available, v_line.base_qty;
            END IF;
            UPDATE public.item_variants
            SET reserved_qty = round(COALESCE(reserved_qty, 0) + v_line.base_qty, 3), updated_at = now()
            WHERE id = v_line.variant_id;
          END IF;
        END IF;
      END LOOP;
      v_next_stock_state := 'reserved';
    END IF;

  -- B. Moving to final delivery / pickup -> release reservation & deduct physical stock via ledger
  ELSIF p_target_status IN ('delivered', 'picked_up') THEN
    IF v_order.stock_state <> 'deducted' THEN
      FOR v_line IN SELECT * FROM public.store_order_lines WHERE order_id = v_order.id
      LOOP
        SELECT * INTO v_item FROM public.items WHERE id = v_line.item_id FOR UPDATE;
        IF COALESCE(v_item.item_type, 'goods') <> 'goods' THEN
          CONTINUE;
        END IF;

        INSERT INTO public.stock_balances (item_id, qty_on_hand, reserved_qty)
        VALUES (v_line.item_id, 0, 0)
        ON CONFLICT (item_id) DO NOTHING;

        SELECT * INTO v_sb FROM public.stock_balances WHERE item_id = v_line.item_id FOR UPDATE;
        IF v_order.stock_state IN ('none', 'released') THEN
          v_available := round(COALESCE(v_sb.qty_on_hand, 0) - COALESCE(v_sb.reserved_qty, 0), 3);
          IF NOT COALESCE(v_item.allow_negative_stock, false) AND v_available < v_line.base_qty THEN
            RAISE EXCEPTION 'Insufficient unreserved stock to fulfill "%". Available: %, Needed: %.',
              v_item.name, v_available, v_line.base_qty;
          END IF;
        ELSE
          -- Release existing reservation before writing physical deduction
          UPDATE public.stock_balances
          SET reserved_qty = GREATEST(0, round(COALESCE(reserved_qty, 0) - v_line.base_qty, 3)), updated_at = now()
          WHERE item_id = v_line.item_id;

          IF v_line.variant_id IS NOT NULL THEN
            UPDATE public.item_variants
            SET reserved_qty = GREATEST(0, round(COALESCE(reserved_qty, 0) - v_line.base_qty, 3)), updated_at = now()
            WHERE id = v_line.variant_id;
          END IF;
        END IF;

        INSERT INTO public.stock_ledger (
          item_id, variant_id, movement_type, movement_date,
          entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
          unit_cost, reason, reference_no, source_table, source_id, created_by
        )
        VALUES (
          v_line.item_id, v_line.variant_id, 'sale', CURRENT_DATE,
          v_line.base_qty, v_item.base_unit_id, 1, -v_line.base_qty,
          v_item.purchase_price,
          'Online Store Order ' || v_order.order_number,
          v_order.order_number,
          'store_orders',
          v_order.id,
          auth.uid()
        );
      END LOOP;
      v_next_stock_state := 'deducted';
    END IF;

  -- C. Cancelled -> release reservation (or reverse physical deduction if already deducted)
  ELSIF p_target_status = 'cancelled' THEN
    IF v_order.stock_state = 'reserved' THEN
      FOR v_line IN SELECT * FROM public.store_order_lines WHERE order_id = v_order.id
      LOOP
        UPDATE public.stock_balances
        SET reserved_qty = GREATEST(0, round(COALESCE(reserved_qty, 0) - v_line.base_qty, 3)), updated_at = now()
        WHERE item_id = v_line.item_id;

        IF v_line.variant_id IS NOT NULL THEN
          UPDATE public.item_variants
          SET reserved_qty = GREATEST(0, round(COALESCE(reserved_qty, 0) - v_line.base_qty, 3)), updated_at = now()
          WHERE id = v_line.variant_id;
        END IF;
      END LOOP;
      v_next_stock_state := 'released';
    ELSIF v_order.stock_state = 'deducted' THEN
      FOR v_line IN SELECT * FROM public.store_order_lines WHERE order_id = v_order.id
      LOOP
        SELECT * INTO v_item FROM public.items WHERE id = v_line.item_id FOR UPDATE;
        IF COALESCE(v_item.item_type, 'goods') <> 'goods' THEN
          CONTINUE;
        END IF;
        INSERT INTO public.stock_ledger (
          item_id, variant_id, movement_type, movement_date,
          entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
          unit_cost, reason, reference_no, source_table, source_id, created_by
        )
        VALUES (
          v_line.item_id, v_line.variant_id, 'sale_return', CURRENT_DATE,
          v_line.base_qty, v_item.base_unit_id, 1, v_line.base_qty,
          v_item.purchase_price,
          'Cancelled Store Order ' || v_order.order_number,
          v_order.order_number,
          'store_orders',
          v_order.id,
          auth.uid()
        );
      END LOOP;
      v_next_stock_state := 'released';
    END IF;
  END IF;

  UPDATE public.store_orders
  SET
    status = p_target_status,
    stock_state = v_next_stock_state,
    confirmed_at = CASE WHEN p_target_status = 'confirmed' AND confirmed_at IS NULL THEN now() ELSE confirmed_at END,
    delivered_at = CASE WHEN p_target_status IN ('delivered', 'picked_up') AND delivered_at IS NULL THEN now() ELSE delivered_at END,
    cancelled_at = CASE WHEN p_target_status = 'cancelled' AND cancelled_at IS NULL THEN now() ELSE cancelled_at END,
    updated_at = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;

-- Seed default delivery zone & helpful starter static page if none exist
INSERT INTO public.store_pages (slug, title, content, is_published)
VALUES
  (
    'shipping-and-pickup',
    'Local Delivery & Showroom Pickup',
    'We deliver across our service zones using our own showroom transport vehicles. For smaller quantities or urgent orders, free showroom pickup is available during business hours.',
    true
  )
ON CONFLICT (slug) DO NOTHING;
