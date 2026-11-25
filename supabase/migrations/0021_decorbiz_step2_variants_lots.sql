-- DecorBiz - Step 2 Item 3 Migration:
--   1. item_variants table (size, finish, shade, batch_lot, sku, barcode, price, qty_on_hand) + item_variants_view & item_lot_balances.
--   2. variant_id, shade, batch_lot columns on stock_ledger, bill_lines, and purchase_lines.
--   3. Trigger support updating item_variants.qty_on_hand alongside item stock balances.
--   4. RPCs updated for variant & lot tracking (adjust_stock, issue_bill, issue_purchase, sales/purchase returns, etc.).

-- ============================================================================
-- 1. Item Variants Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.item_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  variant_name text NOT NULL CHECK (length(trim(variant_name)) >= 1),
  size_label text,
  finish text,
  shade text,
  batch_lot text,
  sku text,
  barcode text,
  selling_price numeric(15,2) NOT NULL CHECK (selling_price >= 0),
  mrp numeric(15,2) CHECK (mrp IS NULL OR mrp >= 0),
  purchase_price numeric(15,2) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  qty_on_hand numeric(15,3) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_variants_sku_unique
  ON public.item_variants (upper(trim(sku))) WHERE sku IS NOT NULL AND trim(sku) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_variants_barcode_unique
  ON public.item_variants (upper(trim(barcode))) WHERE barcode IS NOT NULL AND trim(barcode) <> '';

CREATE INDEX IF NOT EXISTS idx_item_variants_item_id
  ON public.item_variants (item_id, is_active);

DROP TRIGGER IF EXISTS trg_item_variants_updated_at ON public.item_variants;
CREATE TRIGGER trg_item_variants_updated_at
  BEFORE UPDATE ON public.item_variants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.item_variants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS item_variants_select ON public.item_variants;
CREATE POLICY item_variants_select ON public.item_variants
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

-- Variant View with role-based cost masking
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
  iv.updated_at
FROM public.item_variants iv
JOIN public.items i ON i.id = iv.item_id
JOIN public.item_units u ON u.id = i.base_unit_id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_variants_view SET (security_invoker = false);
GRANT SELECT ON public.item_variants_view TO authenticated;

-- ============================================================================
-- 2. Alter Stock Ledger, Bill Lines & Purchase Lines
-- ============================================================================
ALTER TABLE public.stock_ledger
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.item_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shade text,
  ADD COLUMN IF NOT EXISTS batch_lot text;

ALTER TABLE public.bill_lines
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.item_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shade text,
  ADD COLUMN IF NOT EXISTS batch_lot text;

ALTER TABLE public.purchase_lines
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.item_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shade text,
  ADD COLUMN IF NOT EXISTS batch_lot text;

CREATE INDEX IF NOT EXISTS idx_stock_ledger_variant
  ON public.stock_ledger (variant_id, movement_date DESC);

-- Item Lot Balances View (aggregating lot / shade stock movements)
CREATE OR REPLACE VIEW public.item_lot_balances AS
SELECT
  sl.item_id,
  sl.variant_id,
  COALESCE(iv.variant_name, 'Standard') AS variant_name,
  COALESCE(NULLIF(trim(sl.shade), ''), 'Default') AS shade,
  COALESCE(NULLIF(trim(sl.batch_lot), ''), 'Default') AS batch_lot,
  round(sum(sl.signed_base_qty), 3) AS qty_on_hand,
  max(sl.movement_date) AS last_movement_at
FROM public.stock_ledger sl
LEFT JOIN public.item_variants iv ON iv.id = sl.variant_id
GROUP BY sl.item_id, sl.variant_id, iv.variant_name, COALESCE(NULLIF(trim(sl.shade), ''), 'Default'), COALESCE(NULLIF(trim(sl.batch_lot), ''), 'Default')
HAVING round(sum(sl.signed_base_qty), 3) <> 0;

ALTER VIEW public.item_lot_balances SET (security_invoker = false);

-- Update stock balance trigger to also maintain item_variants.qty_on_hand when variant_id is present
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
  v_var_current numeric(15,3) := 0;
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

  IF NEW.variant_id IS NOT NULL THEN
    SELECT qty_on_hand INTO v_var_current
    FROM public.item_variants
    WHERE id = NEW.variant_id
    FOR UPDATE;

    IF FOUND THEN
      v_var_next := round(COALESCE(v_var_current, 0) + NEW.signed_base_qty, 3);
      IF v_var_next < 0 AND NOT COALESCE(v_allow_neg, false) THEN
        RAISE EXCEPTION 'Insufficient variant stock. Available: %, requested reduction: %.',
          v_var_current, abs(NEW.signed_base_qty);
      END IF;

      UPDATE public.item_variants
      SET qty_on_hand = v_var_next, updated_at = now()
      WHERE id = NEW.variant_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Update stock_ledger_view to expose variant & lot columns (appended cleanly at end)
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
  sl.created_at,
  sl.variant_id,
  iv.variant_name,
  sl.shade,
  sl.batch_lot
FROM public.stock_ledger sl
JOIN public.item_units u ON u.id = sl.entered_unit_id
LEFT JOIN public.item_variants iv ON iv.id = sl.variant_id
LEFT JOIN public.profiles p ON p.id = sl.created_by
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.stock_ledger_view SET (security_invoker = false);
GRANT SELECT ON public.stock_ledger_view TO authenticated;

-- ============================================================================
-- 3. Save Item Variant RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_item_variant(
  p_id uuid DEFAULT NULL,
  p_item_id uuid DEFAULT NULL,
  p_variant_name text DEFAULT '',
  p_size_label text DEFAULT NULL,
  p_finish text DEFAULT NULL,
  p_shade text DEFAULT NULL,
  p_batch_lot text DEFAULT NULL,
  p_sku text DEFAULT NULL,
  p_barcode text DEFAULT NULL,
  p_selling_price numeric DEFAULT 0,
  p_mrp numeric DEFAULT NULL,
  p_purchase_price numeric DEFAULT 0,
  p_opening_stock numeric DEFAULT 0
)
RETURNS public.item_variants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_name text := trim(COALESCE(p_variant_name, ''));
  v_row public.item_variants;
  v_item public.items;
  v_sku text := NULLIF(upper(trim(COALESCE(p_sku, ''))), '');
  v_bc text := NULLIF(upper(trim(COALESCE(p_barcode, ''))), '');
  v_sell numeric(15,2) := GREATEST(0, round(COALESCE(p_selling_price, 0), 2));
  v_mrp numeric(15,2) := CASE WHEN p_mrp IS NOT NULL THEN GREATEST(0, round(p_mrp, 2)) ELSE NULL END;
  v_cost numeric(15,2) := CASE WHEN v_role IN ('owner', 'manager', 'accountant') THEN GREATEST(0, round(COALESCE(p_purchase_price, 0), 2)) ELSE 0 END;
  v_open numeric(15,3) := GREATEST(0, round(COALESCE(p_opening_stock, 0), 3));
  v_actor_email text;
BEGIN
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can manage item variants.';
  END IF;
  IF length(v_name) < 1 THEN
    RAISE EXCEPTION 'Variant name is required.';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.item_variants WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Variant not found.'; END IF;
    UPDATE public.item_variants
    SET variant_name = v_name,
        size_label = NULLIF(trim(COALESCE(p_size_label, '')), ''),
        finish = NULLIF(trim(COALESCE(p_finish, '')), ''),
        shade = NULLIF(trim(COALESCE(p_shade, '')), ''),
        batch_lot = NULLIF(trim(COALESCE(p_batch_lot, '')), ''),
        sku = v_sku,
        barcode = v_bc,
        selling_price = v_sell,
        mrp = v_mrp,
        purchase_price = CASE WHEN v_role IN ('owner', 'manager', 'accountant') THEN v_cost ELSE purchase_price END,
        updated_at = now()
    WHERE id = p_id
    RETURNING * INTO v_row;
  ELSE
    IF p_item_id IS NULL THEN RAISE EXCEPTION 'Item ID is required for a new variant.'; END IF;
    SELECT * INTO v_item FROM public.items WHERE id = p_item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item not found.'; END IF;

    INSERT INTO public.item_variants (
      item_id, variant_name, size_label, finish, shade, batch_lot,
      sku, barcode, selling_price, mrp, purchase_price, created_by
    )
    VALUES (
      p_item_id, v_name, NULLIF(trim(COALESCE(p_size_label, '')), ''),
      NULLIF(trim(COALESCE(p_finish, '')), ''), NULLIF(trim(COALESCE(p_shade, '')), ''),
      NULLIF(trim(COALESCE(p_batch_lot, '')), ''), v_sku, v_bc,
      v_sell, v_mrp, v_cost, auth.uid()
    )
    RETURNING * INTO v_row;

    IF v_open > 0 THEN
      INSERT INTO public.stock_ledger (
        item_id, variant_id, shade, batch_lot, movement_type, movement_date,
        entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
        unit_cost, reason, reference_no, source_table, source_id, created_by
      )
      VALUES (
        p_item_id, v_row.id, v_row.shade, v_row.batch_lot, 'opening_stock', CURRENT_DATE,
        v_open, v_item.base_unit_id, 1, v_open, v_cost,
        'Variant Opening Stock', public.next_document_number('stock_adjustment', CURRENT_DATE),
        'item_variants', v_row.id, auth.uid()
      );
      SELECT * INTO v_row FROM public.item_variants WHERE id = v_row.id;
    END IF;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NULL THEN 'item_variant.created' ELSE 'item_variant.updated' END,
    'item_variant', v_row.id::text,
    jsonb_build_object('variant_name', v_row.variant_name, 'item_id', v_row.item_id)
  );

  RETURN v_row;
END;
$$;

-- ============================================================================
-- 4. Update adjust_stock with Variant & Lot Support
-- ============================================================================
DROP FUNCTION IF EXISTS public.adjust_stock(uuid, text, numeric, uuid, text, date, text);

CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_item_id uuid,
  p_direction text,
  p_qty numeric,
  p_unit_id uuid DEFAULT NULL,
  p_reason text DEFAULT '',
  p_movement_date date DEFAULT CURRENT_DATE,
  p_idempotency_key text DEFAULT NULL,
  p_variant_id uuid DEFAULT NULL,
  p_shade text DEFAULT NULL,
  p_batch_lot text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_actor_email text;
  v_clean_reason text := trim(COALESCE(p_reason, ''));
  v_idemp text := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
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
  v_var_balance numeric(15,3);
BEGIN
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can adjust stock.';
  END IF;
  IF p_direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'Stock adjustment direction must be in or out.';
  END IF;
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter an adjustment reason (minimum 3 characters).';
  END IF;

  IF v_idemp IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.stock_ledger WHERE idempotency_key = v_idemp;
    IF FOUND THEN
      SELECT qty_on_hand INTO v_new_balance FROM public.stock_balances WHERE item_id = v_existing.item_id;
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found.'; END IF;

  IF p_variant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.item_variants WHERE id = p_variant_id AND item_id = p_item_id) THEN
    RAISE EXCEPTION 'Selected variant does not belong to this item.';
  END IF;

  v_unit_id := COALESCE(p_unit_id, v_item.base_unit_id);
  SELECT base_qty, conversion_factor INTO v_base_qty, v_factor
  FROM public.convert_item_qty(p_item_id, p_qty, v_unit_id);

  v_mov_type := CASE WHEN p_direction = 'in' THEN 'adjustment_in' ELSE 'adjustment_out' END;
  v_signed := CASE WHEN p_direction = 'in' THEN v_base_qty ELSE -v_base_qty END;
  v_ref_no := public.next_document_number('stock_adjustment', COALESCE(p_movement_date, CURRENT_DATE));

  INSERT INTO public.stock_ledger (
    item_id, variant_id, shade, batch_lot, movement_type, movement_date,
    entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
    unit_cost, reason, reference_no, source_table, idempotency_key, created_by
  )
  VALUES (
    p_item_id, p_variant_id, NULLIF(trim(COALESCE(p_shade, '')), ''), NULLIF(trim(COALESCE(p_batch_lot, '')), ''),
    v_mov_type, COALESCE(p_movement_date, CURRENT_DATE), round(p_qty::numeric, 3), v_unit_id,
    v_factor, v_signed, CASE WHEN v_item.purchase_price > 0 THEN v_item.purchase_price ELSE NULL END,
    v_clean_reason, v_ref_no, 'stock_adjustment', v_idemp, auth.uid()
  )
  RETURNING * INTO v_ledger;

  SELECT qty_on_hand INTO v_new_balance FROM public.stock_balances WHERE item_id = p_item_id;
  IF p_variant_id IS NOT NULL THEN
    SELECT qty_on_hand INTO v_var_balance FROM public.item_variants WHERE id = p_variant_id;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'stock.adjusted', 'item', p_item_id::text,
    jsonb_build_object(
      'reference_no', v_ref_no, 'movement_type', v_mov_type, 'entered_qty', p_qty,
      'signed_base_qty', v_signed, 'qty_on_hand', COALESCE(v_new_balance, 0),
      'variant_id', p_variant_id, 'shade', p_shade, 'batch_lot', p_batch_lot, 'reason', v_clean_reason
    )
  );

  RETURN jsonb_build_object(
    'ledger_id', v_ledger.id, 'reference_no', v_ref_no, 'signed_base_qty', v_signed,
    'qty_on_hand', COALESCE(v_new_balance, 0), 'variant_qty_on_hand', v_var_balance, 'idempotent_replay', false
  );
END;
$$;

-- ============================================================================
-- 5. Update _prepare_bill_payload, save_bill_draft, issue_bill, issue_purchase, etc.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._prepare_bill_payload(
  p_doc_type text,
  p_party_id uuid,
  p_place_of_supply text,
  p_extra_charges numeric,
  p_auto_round_off boolean,
  p_lines jsonb,
  p_actor_role text,
  p_bill_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz public.business;
  v_party public.parties;
  v_pos text;
  v_party_addr text := NULL;
  v_is_interstate boolean := false;
  v_raw jsonb;
  v_item public.items;
  v_unit_id uuid;
  v_unit_code text;
  v_qty numeric(15,3);
  v_base_qty numeric(15,3);
  v_factor numeric(18,6);
  v_catalog_price numeric(15,2);
  v_unit_price numeric(15,2);
  v_disc_pct numeric(5,2);
  v_tax_incl boolean;
  v_var_id uuid;
  v_var public.item_variants;
  v_prepared_lines jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_max_disc numeric(5,2);
  v_bill_date date := COALESCE(p_bill_date, CURRENT_DATE);
BEGIN
  IF p_doc_type NOT IN ('tax_invoice', 'bill_of_supply', 'quotation') THEN
    RAISE EXCEPTION 'Document type must be tax_invoice, bill_of_supply, or quotation.';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Please add at least one item line.';
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_max_disc := COALESCE(v_biz.cashier_max_discount_pct, 10.00);

  IF p_party_id IS NOT NULL THEN
    SELECT * INTO v_party FROM public.parties WHERE id = p_party_id;
    IF NOT FOUND OR NOT v_party.is_active THEN
      RAISE EXCEPTION 'Selected party not found or inactive.';
    END IF;
    SELECT
      concat_ws(', ', address_line1, NULLIF(address_line2, ''), NULLIF(city, ''), NULLIF(state, ''), NULLIF(pincode, '')),
      COALESCE(NULLIF(upper(trim(state_code)), ''), NULLIF(substring(v_party.gstin FROM 1 FOR 2), ''))
    INTO v_party_addr, v_pos
    FROM public.party_addresses
    WHERE party_id = p_party_id
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
    IF v_pos IS NULL AND v_party.gstin IS NOT NULL THEN
      v_pos := substring(v_party.gstin FROM 1 FOR 2);
    END IF;
  END IF;

  v_pos := COALESCE(NULLIF(upper(trim(COALESCE(p_place_of_supply, ''))), ''), v_pos, NULLIF(upper(trim(COALESCE(v_biz.state_code, ''))), ''));
  v_is_interstate := (
    NULLIF(upper(trim(COALESCE(v_biz.state_code, ''))), '') IS NOT NULL
    AND v_pos IS NOT NULL
    AND upper(trim(v_biz.state_code)) <> v_pos
  );

  FOR v_raw IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_item FROM public.items WHERE id = (v_raw->>'item_id')::uuid;
    IF NOT FOUND OR NOT v_item.is_active THEN
      RAISE EXCEPTION 'One or more selected items are invalid or archived.';
    END IF;

    v_var_id := NULLIF(v_raw->>'variant_id', '')::uuid;
    IF v_var_id IS NOT NULL THEN
      SELECT * INTO v_var FROM public.item_variants WHERE id = v_var_id AND item_id = v_item.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Selected item variant is invalid.'; END IF;
    END IF;

    v_qty := round(COALESCE((v_raw->>'entered_qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity for "%" must be greater than zero.', v_item.name;
    END IF;

    v_unit_id := COALESCE(NULLIF(trim(COALESCE(v_raw->>'entered_unit_id', '')), '')::uuid, v_item.base_unit_id);
    SELECT base_qty, conversion_factor INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id);
    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    v_catalog_price := round((COALESCE(v_var.selling_price, v_item.selling_price, 0) * v_factor)::numeric, 2);
    v_unit_price := round(COALESCE(NULLIF(v_raw->>'unit_price', '')::numeric, v_catalog_price), 2);
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION 'Unit price for "%" cannot be negative.', v_item.name;
    END IF;

    v_disc_pct := round(COALESCE(NULLIF(v_raw->>'discount_pct', '')::numeric, 0), 2);
    IF v_disc_pct < 0 OR v_disc_pct > 100 THEN
      RAISE EXCEPTION 'Discount percentage for "%" must be between 0 and 100.', v_item.name;
    END IF;

    IF p_actor_role NOT IN ('owner', 'manager') THEN
      IF NOT COALESCE(v_biz.allow_cashier_price_override, false) AND v_unit_price < v_catalog_price THEN
        RAISE EXCEPTION 'Price reduction on "%" below catalog rate (₹%) requires Owner or Manager permission.', v_item.name, v_catalog_price;
      END IF;
      IF v_disc_pct > v_max_disc THEN
        RAISE EXCEPTION 'Discount (% %%) on "%" exceeds role limit (% %%). Owner or Manager approval required.', v_disc_pct, v_item.name, v_max_disc;
      END IF;
    END IF;

    v_tax_incl := COALESCE((v_raw->>'tax_inclusive')::boolean, v_item.tax_inclusive);

    v_prepared_lines := v_prepared_lines || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'variant_id', v_var_id,
      'shade', NULLIF(trim(COALESCE(v_raw->>'shade', v_var.shade, '')), ''),
      'batch_lot', NULLIF(trim(COALESCE(v_raw->>'batch_lot', v_var.batch_lot, '')), ''),
      'item_type', v_item.item_type,
      'item_name', v_item.name || CASE WHEN v_var.variant_name IS NOT NULL THEN ' (' || v_var.variant_name || ')' ELSE '' END,
      'sku', COALESCE(v_var.sku, v_item.sku),
      'hsn_code', v_item.hsn_code,
      'entered_qty', v_qty,
      'entered_unit_id', v_unit_id,
      'entered_unit_code', v_unit_code,
      'conversion_factor', v_factor,
      'base_qty', v_base_qty,
      'catalog_unit_price', v_catalog_price,
      'unit_price', v_unit_price,
      'discount_pct', v_disc_pct,
      'tax_inclusive', v_tax_incl,
      'gst_rate', v_item.gst_rate,
      'mrp', COALESCE(v_var.mrp, v_item.mrp),
      'pack_metadata', v_item.pack_metadata,
      'line_meta', COALESCE(v_raw->'line_meta', '{}'::jsonb)
    ));
  END LOOP;

  v_calc := public.compute_bill_amounts(
    v_biz.gst_registered,
    p_doc_type,
    v_is_interstate,
    p_extra_charges,
    p_auto_round_off,
    v_prepared_lines
  );

  RETURN jsonb_build_object(
    'party_name', COALESCE(v_party.name, 'Walk-in Customer'),
    'party_phone', v_party.phone,
    'party_gstin', v_party.gstin,
    'party_address', v_party_addr,
    'place_of_supply_state_code', v_pos,
    'biz_snapshot', jsonb_build_object(
      'name', v_biz.name,
      'pack', v_biz.pack,
      'gst_registered', v_biz.gst_registered,
      'gstin', v_biz.gstin,
      'phone', v_biz.phone,
      'email', v_biz.email,
      'address', v_biz.address,
      'state_code', v_biz.state_code,
      'upi_id', v_biz.upi_id,
      'logo_file_id', v_biz.logo_file_id,
      'upi_qr_file_id', v_biz.upi_qr_file_id,
      'show_upi_qr_on_invoice', v_biz.show_upi_qr_on_invoice,
      'default_print_layout', v_biz.default_print_layout,
      'pack_settings', v_biz.pack_settings,
      'bank_name', v_biz.pack_settings->>'bank_name',
      'bank_account_holder', v_biz.pack_settings->>'bank_account_holder',
      'bank_account_no', v_biz.pack_settings->>'bank_account_no',
      'bank_ifsc', v_biz.pack_settings->>'bank_ifsc',
      'bank_branch', v_biz.pack_settings->>'bank_branch',
      'bank_account_type', v_biz.pack_settings->>'bank_account_type',
      'show_bank_on_invoice', COALESCE((v_biz.pack_settings->>'show_bank_on_invoice')::boolean, true),
      'show_cashier_on_invoice', COALESCE((v_biz.pack_settings->>'show_cashier_on_invoice')::boolean, true),
      'default_cashier_name', v_biz.pack_settings->>'default_cashier_name',
      'cashier_name', COALESCE(
        NULLIF(trim(COALESCE(v_biz.pack_settings->>'default_cashier_name', '')), ''),
        (SELECT full_name FROM public.profiles WHERE id = auth.uid())
      ),
      'show_signatory_on_invoice', COALESCE((v_biz.pack_settings->>'show_signatory_on_invoice')::boolean, true),
      'signatory_label', COALESCE(NULLIF(trim(COALESCE(v_biz.pack_settings->>'signatory_label', '')), ''), 'Authorized Signatory'),
      'show_hsn_on_invoice', COALESCE((v_biz.pack_settings->>'show_hsn_on_invoice')::boolean, true),
      'show_mrp_savings_on_invoice', COALESCE((v_biz.pack_settings->>'show_mrp_savings_on_invoice')::boolean, true),
      'show_customer_details_on_invoice', COALESCE((v_biz.pack_settings->>'show_customer_details_on_invoice')::boolean, true),
      'invoice_greeting', COALESCE(v_biz.pack_settings->>'invoice_greeting', 'Thank you! Visit Again')
    ),
    'prepared_lines', v_prepared_lines,
    'calc', v_calc
  );
END;
$$;

-- Update save_bill_draft and issue_bill to persist variant_id, shade, batch_lot into bill_lines & stock_ledger
DROP FUNCTION IF EXISTS public.save_bill_draft(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.save_bill_draft(
  p_id uuid DEFAULT NULL,
  p_doc_type text DEFAULT 'tax_invoice',
  p_party_id uuid DEFAULT NULL,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_valid_until date DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_extra_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_notes text DEFAULT NULL,
  p_terms text DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_site_id uuid DEFAULT NULL
)
RETURNS public.bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_biz public.business;
  v_prep jsonb;
  v_calc jsonb;
  v_bill public.bills;
  v_existing public.bills;
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
  v_site_name text := NULL;
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to create or edit bills.';
  END IF;

  IF p_site_id IS NOT NULL THEN
    SELECT site_name INTO v_site_name FROM public.party_sites WHERE id = p_site_id;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_prep := public._prepare_bill_payload(
    p_doc_type, p_party_id, p_place_of_supply, p_extra_charges, p_auto_round_off, p_lines, v_role, COALESCE(p_bill_date, CURRENT_DATE)
  );
  v_calc := v_prep->'calc';

  IF p_id IS NULL THEN
    INSERT INTO public.bills (
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin,
      party_address, place_of_supply_state_code, is_interstate, bill_date, due_date,
      valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due, notes, terms, business_snapshot,
      site_id, site_name, created_by
    )
    VALUES (
      NULL, p_doc_type, 'draft', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address', v_prep->>'place_of_supply_state_code',
      (v_calc->>'is_interstate')::boolean, COALESCE(p_bill_date, CURRENT_DATE), p_due_date,
      p_valid_until, (v_calc->>'gst_applied')::boolean, (v_calc->>'subtotal_taxable')::numeric,
      (v_calc->>'discount_total')::numeric, (v_calc->>'cgst_total')::numeric,
      (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
      (v_calc->>'tax_total')::numeric, (v_calc->>'extra_charges')::numeric,
      COALESCE(p_auto_round_off, true), (v_calc->>'round_off')::numeric,
      (v_calc->>'grand_total')::numeric, 0, 0, (v_calc->>'grand_total')::numeric,
      NULLIF(trim(COALESCE(p_notes, '')), ''), COALESCE(p_terms, v_biz.invoice_terms),
      v_prep->'biz_snapshot', p_site_id, v_site_name, auth.uid()
    )
    RETURNING * INTO v_bill;
  ELSE
    SELECT * INTO v_existing FROM public.bills WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft bill not found.'; END IF;
    IF v_existing.status <> 'draft' THEN RAISE EXCEPTION 'Only draft documents can be edited.'; END IF;

    UPDATE public.bills
    SET doc_type = p_doc_type, party_id = p_party_id, party_name = v_prep->>'party_name',
        party_phone = v_prep->>'party_phone', party_gstin = v_prep->>'party_gstin',
        party_address = v_prep->>'party_address',
        place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
        is_interstate = (v_calc->>'is_interstate')::boolean,
        bill_date = COALESCE(p_bill_date, CURRENT_DATE), due_date = p_due_date,
        valid_until = p_valid_until, gst_applied = (v_calc->>'gst_applied')::boolean,
        subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
        discount_total = (v_calc->>'discount_total')::numeric,
        cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
        igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
        extra_charges = (v_calc->>'extra_charges')::numeric,
        auto_round_off = COALESCE(p_auto_round_off, true), round_off = (v_calc->>'round_off')::numeric,
        grand_total = (v_calc->>'grand_total')::numeric, balance_due = (v_calc->>'grand_total')::numeric,
        notes = NULLIF(trim(COALESCE(p_notes, '')), ''), terms = COALESCE(p_terms, v_biz.invoice_terms),
        business_snapshot = v_prep->'biz_snapshot', site_id = p_site_id, site_name = v_site_name
    WHERE id = p_id RETURNING * INTO v_bill;

    DELETE FROM public.bill_lines WHERE bill_id = v_bill.id;
  END IF;

  FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1)
  LOOP
    v_pl := (v_prep->'prepared_lines')->v_i;
    v_cl := (v_calc->'lines')->v_i;

    INSERT INTO public.bill_lines (
      bill_id, line_no, item_id, variant_id, shade, batch_lot, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_bill.id, v_i + 1, (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
      NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''), v_pl->>'item_name',
      NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'catalog_unit_price')::numeric,
      (v_pl->>'unit_price')::numeric, (v_pl->>'discount_pct')::numeric,
      (v_pl->>'tax_inclusive')::boolean, (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'mrp', '')::numeric, COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );
  END LOOP;

  RETURN v_bill;
END;
$$;

DROP FUNCTION IF EXISTS public.issue_bill(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, numeric, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.issue_bill(
  p_draft_id uuid DEFAULT NULL,
  p_doc_type text DEFAULT 'tax_invoice',
  p_party_id uuid DEFAULT NULL,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_valid_until date DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_extra_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_notes text DEFAULT NULL,
  p_terms text DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_paid_amount numeric DEFAULT 0,
  p_payment_mode text DEFAULT 'cash',
  p_payment_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_site_id uuid DEFAULT NULL
)
RETURNS public.bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_biz public.business;
  v_idemp text := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  v_existing public.bills;
  v_prep jsonb;
  v_calc jsonb;
  v_bill_date date := COALESCE(p_bill_date, CURRENT_DATE);
  v_due_date date;
  v_grand numeric(15,2);
  v_paid numeric(15,2);
  v_balance numeric(15,2);
  v_mode text := COALESCE(NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), ''), 'cash');
  v_pay_ref text := NULLIF(trim(COALESCE(p_payment_reference, '')), '');
  v_bill_number text;
  v_bill public.bills;
  v_actor_email text;
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
  v_bill_ledger public.party_ledger_entries;
  v_party_credit_days integer := 0;
  v_site_name text := NULL;
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to issue bills.';
  END IF;
  IF v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode: %.', v_mode;
  END IF;

  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('bill_issue:' || v_idemp));
    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  IF p_site_id IS NOT NULL THEN
    SELECT site_name INTO v_site_name FROM public.party_sites WHERE id = p_site_id;
  END IF;

  IF p_party_id IS NOT NULL THEN
    SELECT credit_days INTO v_party_credit_days FROM public.parties WHERE id = p_party_id;
    v_due_date := COALESCE(p_due_date, CASE WHEN COALESCE(v_party_credit_days, 0) > 0 THEN v_bill_date + v_party_credit_days ELSE NULL END);
  ELSE
    v_due_date := p_due_date;
  END IF;

  v_prep := public._prepare_bill_payload(
    p_doc_type, p_party_id, p_place_of_supply, p_extra_charges, p_auto_round_off, p_lines, v_role, v_bill_date
  );
  v_calc := v_prep->'calc';
  v_grand := (v_calc->>'grand_total')::numeric(15,2);

  IF p_doc_type = 'quotation' THEN
    v_paid := 0;
    v_balance := 0;
  ELSE
    v_paid := round(COALESCE(p_paid_amount, 0)::numeric, 2);
    IF v_paid < 0 THEN RAISE EXCEPTION 'Paid amount cannot be negative.'; END IF;
    IF v_paid > v_grand THEN RAISE EXCEPTION 'Paid amount exceeds bill grand total.'; END IF;
    IF p_party_id IS NULL AND v_paid < v_grand THEN RAISE EXCEPTION 'Walk-in cash bills must be paid in full.'; END IF;
    v_balance := round((v_grand - v_paid)::numeric, 2);
  END IF;

  v_bill_number := public.next_document_number(p_doc_type, v_bill_date);

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.bill_line_init', txid_current()::text, true);

  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.bills WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft bill not found.'; END IF;
    IF v_existing.status <> 'draft' THEN RAISE EXCEPTION 'Document already issued.'; END IF;
    DELETE FROM public.bill_lines WHERE bill_id = p_draft_id;

    UPDATE public.bills
    SET bill_number = v_bill_number, doc_type = p_doc_type, status = 'issued',
        party_id = p_party_id, party_name = v_prep->>'party_name', party_phone = v_prep->>'party_phone',
        party_gstin = v_prep->>'party_gstin', party_address = v_prep->>'party_address',
        place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
        is_interstate = (v_calc->>'is_interstate')::boolean,
        bill_date = v_bill_date, due_date = v_due_date, valid_until = p_valid_until,
        gst_applied = (v_calc->>'gst_applied')::boolean,
        subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
        discount_total = (v_calc->>'discount_total')::numeric,
        cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
        igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
        extra_charges = (v_calc->>'extra_charges')::numeric,
        auto_round_off = COALESCE(p_auto_round_off, true), round_off = (v_calc->>'round_off')::numeric,
        grand_total = v_grand, paid_amount = v_paid, credited_amount = 0, balance_due = v_balance,
        payment_mode = v_mode, payment_reference = v_pay_ref,
        notes = NULLIF(trim(COALESCE(p_notes, '')), ''), terms = COALESCE(p_terms, v_biz.invoice_terms),
        business_snapshot = v_prep->'biz_snapshot', idempotency_key = v_idemp,
        site_id = p_site_id, site_name = v_site_name, issued_at = now(), issued_by = auth.uid()
    WHERE id = p_draft_id RETURNING * INTO v_bill;
  ELSE
    INSERT INTO public.bills (
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      place_of_supply_state_code, is_interstate, bill_date, due_date, valid_until, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total, tax_total,
      extra_charges, auto_round_off, round_off, grand_total, paid_amount, credited_amount, balance_due,
      payment_mode, payment_reference, notes, terms, business_snapshot, idempotency_key,
      site_id, site_name, issued_at, issued_by, created_by
    )
    VALUES (
      v_bill_number, p_doc_type, 'issued', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address', v_prep->>'place_of_supply_state_code',
      (v_calc->>'is_interstate')::boolean, v_bill_date, v_due_date, p_valid_until,
      (v_calc->>'gst_applied')::boolean, (v_calc->>'subtotal_taxable')::numeric,
      (v_calc->>'discount_total')::numeric, (v_calc->>'cgst_total')::numeric,
      (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
      (v_calc->>'tax_total')::numeric, (v_calc->>'extra_charges')::numeric,
      COALESCE(p_auto_round_off, true), (v_calc->>'round_off')::numeric, v_grand,
      v_paid, 0, v_balance, v_mode, v_pay_ref,
      NULLIF(trim(COALESCE(p_notes, '')), ''), COALESCE(p_terms, v_biz.invoice_terms),
      v_prep->'biz_snapshot', v_idemp, p_site_id, v_site_name, now(), auth.uid(), auth.uid()
    )
    RETURNING * INTO v_bill;
  END IF;

  FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1)
  LOOP
    v_pl := (v_prep->'prepared_lines')->v_i;
    v_cl := (v_calc->'lines')->v_i;

    INSERT INTO public.bill_lines (
      bill_id, line_no, item_id, variant_id, shade, batch_lot, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_bill.id, v_i + 1, (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
      NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''), v_pl->>'item_name',
      NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'catalog_unit_price')::numeric,
      (v_pl->>'unit_price')::numeric, (v_pl->>'discount_pct')::numeric,
      (v_pl->>'tax_inclusive')::boolean, (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'mrp', '')::numeric, COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );

    IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
      INSERT INTO public.stock_ledger (
        item_id, variant_id, shade, batch_lot, movement_type, movement_date,
        entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
        unit_cost, reason, reference_no, source_table, source_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
        NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''),
        'sale', v_bill_date, (v_pl->>'entered_qty')::numeric,
        (v_pl->>'entered_unit_id')::uuid, (v_pl->>'conversion_factor')::numeric,
        -((v_pl->>'base_qty')::numeric),
        COALESCE((SELECT purchase_price FROM public.item_variants WHERE id = NULLIF(v_pl->>'variant_id', '')::uuid), (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid)),
        'Sales Bill ' || v_bill.bill_number, v_bill.bill_number, 'bills', v_bill.id, auth.uid()
      );
    END IF;
  END LOOP;

  PERFORM set_config('app.bill_line_init', '', true);

  IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND p_party_id IS NOT NULL AND public.is_module_enabled('parties') AND v_grand > 0 THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, due_date, reference_no,
      source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      p_party_id, 'bill', v_bill_date, v_due_date, v_bill.bill_number,
      'bills', v_bill.id, v_grand,
      CASE WHEN p_doc_type = 'bill_of_supply' THEN 'Bill of Supply ' ELSE 'Tax Invoice ' END || v_bill.bill_number,
      auth.uid()
    )
    RETURNING * INTO v_bill_ledger;

    IF v_paid > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        p_party_id, 'receive', v_paid, v_mode, v_bill_date,
        COALESCE(v_pay_ref, v_bill.bill_number), 'Payment on Bill ' || v_bill.bill_number,
        jsonb_build_array(jsonb_build_object('ledger_entry_id', v_bill_ledger.id, 'amount', v_paid)),
        false, CASE WHEN v_idemp IS NOT NULL THEN 'bill_pay:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'bill.issued', 'bill', v_bill.id::text,
    jsonb_build_object('bill_number', v_bill.bill_number, 'doc_type', v_bill.doc_type, 'grand_total', v_bill.grand_total)
  );

  SELECT * INTO v_bill FROM public.bills WHERE id = v_bill.id;
  RETURN v_bill;
END;
$$;
