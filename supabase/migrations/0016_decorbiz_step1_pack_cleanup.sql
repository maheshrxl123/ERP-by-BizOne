-- DecorBiz - Step 1 Item 2 Migration:
--   1. Lock business.pack to single fixed 'decorbiz' configuration.
--   2. Drop Kirana, Medical, Clothing, Wholesale, and Service pack tables, columns, and RPCs.
--   3. Recreate item_catalog_view, party_balances, bill_list_view, expense_list_view cleanly.
--   4. Recreate core RPCs without removed pack parameters/tables & add DecorBiz seed_demo_data().

-- ============================================================================
-- 1. Lock business.pack to 'decorbiz'
-- ============================================================================
DO $$
DECLARE
  v_con record;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.business'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%pack%'
  LOOP
    EXECUTE format('ALTER TABLE public.business DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

UPDATE public.business
SET pack = 'decorbiz'
WHERE id = 1 AND pack IS DISTINCT FROM 'decorbiz';

ALTER TABLE public.business
  ALTER COLUMN pack SET DEFAULT 'decorbiz';

ALTER TABLE public.business
  ADD CONSTRAINT business_pack_check CHECK (pack = 'decorbiz');

ALTER TABLE public.drive_connections
  ALTER COLUMN folder_name SET DEFAULT 'DecorBiz Backups';

UPDATE public.drive_connections
SET folder_name = 'DecorBiz Backups'
WHERE id = 1 AND folder_name IN ('BizOne ERP Backups', 'DecorBiz ERP Backups');

-- Clean removed module keys, playbooks, and notifications
DELETE FROM public.modules_state WHERE module_key IN ('batch_expiry', 'variants');
DELETE FROM public.ai_playbooks WHERE playbook_key IN ('near_expiry_clearance', 'warranty_due_followups');
DELETE FROM public.notifications WHERE dedupe_key = 'system:batch_expiry';

-- ============================================================================
-- 2. Drop Pack-Only RPCs, Dependent Views, Columns & Tables
-- ============================================================================
DROP FUNCTION IF EXISTS public.save_item_batch(uuid, text, date, date, numeric, numeric, numeric, numeric, uuid, boolean);
DROP FUNCTION IF EXISTS public.get_near_expiry_batches(integer);
DROP FUNCTION IF EXISTS public.get_salt_substitutes(uuid);
DROP FUNCTION IF EXISTS public.get_schedule_register(date, date);
DROP FUNCTION IF EXISTS public.save_variant_matrix(uuid, jsonb);
DROP FUNCTION IF EXISTS public.save_party_item_rate(uuid, uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public.update_warranty_claim(uuid, text, text);
DROP FUNCTION IF EXISTS public.save_service_job(text, uuid, text, text, date, date, numeric, text, uuid);
DROP FUNCTION IF EXISTS public.bulk_update_item_prices(jsonb);
DROP FUNCTION IF EXISTS public.switch_business_pack(text, boolean, boolean);
DROP FUNCTION IF EXISTS public.seed_pack_demo_data(text);
DROP FUNCTION IF EXISTS public.get_pack_reports(date, date);

DROP VIEW IF EXISTS public.item_catalog_view CASCADE;
DROP VIEW IF EXISTS public.party_balances CASCADE;
DROP VIEW IF EXISTS public.bill_list_view CASCADE;
DROP VIEW IF EXISTS public.expense_list_view CASCADE;

ALTER TABLE public.bill_lines
  DROP CONSTRAINT IF EXISTS fk_bill_lines_batch,
  DROP CONSTRAINT IF EXISTS fk_bill_lines_variant;

ALTER TABLE public.purchase_lines
  DROP CONSTRAINT IF EXISTS fk_purchase_lines_batch,
  DROP CONSTRAINT IF EXISTS fk_purchase_lines_variant;

ALTER TABLE public.bills
  DROP CONSTRAINT IF EXISTS fk_bills_job,
  DROP CONSTRAINT IF EXISTS fk_bills_prescription;

ALTER TABLE public.expenses
  DROP CONSTRAINT IF EXISTS fk_expenses_job;

ALTER TABLE public.business
  DROP COLUMN IF EXISTS drug_licence_no;

ALTER TABLE public.items
  DROP COLUMN IF EXISTS wholesale_slabs;

ALTER TABLE public.parties
  DROP COLUMN IF EXISTS price_tier;

ALTER TABLE public.bill_lines
  DROP COLUMN IF EXISTS batch_id,
  DROP COLUMN IF EXISTS batch_no,
  DROP COLUMN IF EXISTS expiry_date,
  DROP COLUMN IF EXISTS variant_id,
  DROP COLUMN IF EXISTS variant_label;

ALTER TABLE public.purchase_lines
  DROP COLUMN IF EXISTS batch_id,
  DROP COLUMN IF EXISTS batch_no,
  DROP COLUMN IF EXISTS mfg_date,
  DROP COLUMN IF EXISTS expiry_date,
  DROP COLUMN IF EXISTS selling_rate,
  DROP COLUMN IF EXISTS variant_id,
  DROP COLUMN IF EXISTS variant_label;

ALTER TABLE public.bills
  DROP COLUMN IF EXISTS job_id,
  DROP COLUMN IF EXISTS prescription_id;

ALTER TABLE public.expenses
  DROP COLUMN IF EXISTS job_id;

ALTER TABLE public.stock_ledger
  DROP COLUMN IF EXISTS batch_id,
  DROP COLUMN IF EXISTS variant_id;

DROP TABLE IF EXISTS public.schedule_register CASCADE;
DROP TABLE IF EXISTS public.prescriptions CASCADE;
DROP TABLE IF EXISTS public.warranty_records CASCADE;
DROP TABLE IF EXISTS public.service_jobs CASCADE;
DROP TABLE IF EXISTS public.party_item_rates CASCADE;
DROP TABLE IF EXISTS public.item_batches CASCADE;
DROP TABLE IF EXISTS public.item_variants CASCADE;

-- ============================================================================
-- 3. Recreate Clean Core Views
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
  i.item_type
FROM public.items i
LEFT JOIN public.item_categories c ON c.id = i.category_id
LEFT JOIN public.brands b ON b.id = i.brand_id
JOIN public.item_units u ON u.id = i.base_unit_id
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_catalog_view SET (security_invoker = false);
GRANT SELECT ON public.item_catalog_view TO authenticated;

CREATE OR REPLACE VIEW public.party_balances
WITH (security_invoker = true)
AS
WITH ledger_agg AS (
  SELECT
    le.party_id,
    COALESCE(SUM(le.debit_amount), 0)::numeric(15,2) AS total_debit,
    COALESCE(SUM(le.credit_amount), 0)::numeric(15,2) AS total_credit,
    COALESCE(SUM(le.signed_amount), 0)::numeric(15,2) AS net_balance,
    MAX(le.entry_date) AS last_entry_date
  FROM public.party_ledger_entries le
  GROUP BY le.party_id
),
overdue_agg AS (
  SELECT
    o.party_id,
    COUNT(*)::integer AS open_obligations_count,
    COALESCE(SUM(o.remaining_amount) FILTER (WHERE o.is_overdue AND o.direction_needed = 'receive'), 0)::numeric(15,2) AS overdue_receivable,
    COALESCE(SUM(o.remaining_amount) FILTER (WHERE o.is_overdue AND o.direction_needed = 'give'), 0)::numeric(15,2) AS overdue_payable
  FROM public.party_open_obligations o
  GROUP BY o.party_id
)
SELECT
  p.id AS party_id,
  p.name,
  p.party_type,
  p.phone,
  p.email,
  p.gstin,
  p.opening_balance,
  p.opening_balance_type,
  p.opening_balance_date,
  p.credit_limit,
  p.credit_days,
  p.notes,
  p.is_active,
  p.version,
  p.created_at,
  p.updated_at,
  COALESCE(la.total_debit, 0)::numeric(15,2) AS total_debit,
  COALESCE(la.total_credit, 0)::numeric(15,2) AS total_credit,
  COALESCE(la.net_balance, 0)::numeric(15,2) AS net_balance,
  GREATEST(COALESCE(la.net_balance, 0), 0)::numeric(15,2) AS to_receive,
  GREATEST(-COALESCE(la.net_balance, 0), 0)::numeric(15,2) AS to_give,
  COALESCE(oa.open_obligations_count, 0) AS open_obligations_count,
  COALESCE(oa.overdue_receivable, 0)::numeric(15,2) AS overdue_receivable,
  COALESCE(oa.overdue_payable, 0)::numeric(15,2) AS overdue_payable,
  (
    (COALESCE(la.net_balance, 0) > 0 AND COALESCE(oa.overdue_receivable, 0) > 0)
    OR (COALESCE(la.net_balance, 0) < 0 AND COALESCE(oa.overdue_payable, 0) > 0)
  ) AS is_overdue,
  la.last_entry_date,
  (SELECT count(*)::integer FROM public.party_sites ps WHERE ps.party_id = p.id AND ps.is_active = true) AS sites_count,
  p.is_demo
FROM public.parties p
LEFT JOIN ledger_agg la ON la.party_id = p.id
LEFT JOIN overdue_agg oa ON oa.party_id = p.id;

GRANT SELECT ON public.party_balances TO authenticated;

CREATE OR REPLACE VIEW public.bill_list_view AS
SELECT
  b.id,
  b.bill_number,
  b.doc_type,
  b.status,
  b.payment_status,
  b.source_bill_id,
  sb.bill_number AS source_bill_number,
  b.converted_from_quotation_id,
  b.converted_to_bill_id,
  cb.bill_number AS converted_to_bill_number,
  b.party_id,
  b.party_name,
  b.party_phone,
  b.party_gstin,
  b.place_of_supply_state_code,
  b.is_interstate,
  b.bill_date,
  b.due_date,
  b.valid_until,
  b.gst_applied,
  b.subtotal_taxable,
  b.discount_total,
  b.cgst_total,
  b.sgst_total,
  b.igst_total,
  b.tax_total,
  b.extra_charges,
  b.round_off,
  b.grand_total,
  b.paid_amount,
  b.credited_amount,
  b.balance_due,
  b.notes,
  b.issued_at,
  b.created_at,
  b.updated_at,
  (SELECT count(*)::integer FROM public.bill_lines bl WHERE bl.bill_id = b.id) AS line_count,
  (
    SELECT count(*)::integer
    FROM public.bill_share_links bsl
    WHERE bsl.bill_id = b.id
      AND bsl.is_revoked = false
      AND (bsl.expires_at IS NULL OR bsl.expires_at > now())
  ) AS active_share_count,
  b.payment_mode,
  b.payment_reference,
  b.site_id,
  b.site_name
FROM public.bills b
LEFT JOIN public.bills sb ON sb.id = b.source_bill_id
LEFT JOIN public.bills cb ON cb.id = b.converted_to_bill_id
WHERE public.is_module_enabled('billing')
  AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']);

ALTER VIEW public.bill_list_view SET (security_invoker = false);
GRANT SELECT ON public.bill_list_view TO authenticated;

CREATE OR REPLACE VIEW public.expense_list_view AS
SELECT
  e.id,
  e.expense_number,
  e.category_id,
  ec.code AS category_code,
  ec.name_en AS category_name_en,
  ec.name_hi AS category_name_hi,
  e.expense_date,
  e.amount,
  e.payment_mode,
  e.reference_no,
  e.paid_to,
  e.notes,
  e.attachment_file_id,
  e.status,
  e.void_reason,
  e.voided_at,
  e.created_by,
  p.full_name AS created_by_name,
  e.created_at,
  e.updated_at
FROM public.expenses e
JOIN public.expense_categories ec ON ec.id = e.category_id
LEFT JOIN public.profiles p ON p.id = e.created_by
WHERE public.is_module_enabled('expenses')
  AND (
    public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
    OR (public.current_user_role() = 'cashier' AND e.created_by = auth.uid())
  );

ALTER VIEW public.expense_list_view SET (security_invoker = false);
GRANT SELECT ON public.expense_list_view TO authenticated;

-- ============================================================================
-- 4. Recreate Clean Core RPCs
-- ============================================================================
DROP FUNCTION IF EXISTS public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text,
  text, boolean, text, integer, text, integer, numeric, boolean,
  text, integer, text, integer, text, integer, text, jsonb
);

CREATE OR REPLACE FUNCTION public.update_business_profile(
  p_name text,
  p_gst_registered boolean,
  p_gstin text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_state_code text DEFAULT NULL,
  p_upi_id text DEFAULT NULL,
  p_fy_start_month integer DEFAULT 4,
  p_logo_file_id uuid DEFAULT NULL,
  p_upi_qr_file_id uuid DEFAULT NULL,
  p_invoice_prefix text DEFAULT 'INV-',
  p_invoice_next_number integer DEFAULT 1,
  p_invoice_terms text DEFAULT 'Thank you for your business.',
  p_tax_mode text DEFAULT 'exclusive',
  p_default_print_layout text DEFAULT NULL,
  p_show_upi_qr_on_invoice boolean DEFAULT NULL,
  p_quotation_prefix text DEFAULT NULL,
  p_quotation_next_number integer DEFAULT NULL,
  p_credit_note_prefix text DEFAULT NULL,
  p_credit_note_next_number integer DEFAULT NULL,
  p_cashier_max_discount_pct numeric DEFAULT NULL,
  p_allow_cashier_price_override boolean DEFAULT NULL,
  p_purchase_prefix text DEFAULT NULL,
  p_purchase_next_number integer DEFAULT NULL,
  p_purchase_return_prefix text DEFAULT NULL,
  p_purchase_return_next_number integer DEFAULT NULL,
  p_expense_prefix text DEFAULT NULL,
  p_expense_next_number integer DEFAULT NULL,
  p_pack_settings jsonb DEFAULT NULL
)
RETURNS public.business
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.business;
  v_steps jsonb;
  v_email text;
  v_clean_gstin text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only an Owner can update business settings.';
  END IF;

  IF length(trim(COALESCE(p_name, ''))) < 1 THEN
    RAISE EXCEPTION 'Business name is required.';
  END IF;

  IF COALESCE(p_fy_start_month, 4) < 1 OR COALESCE(p_fy_start_month, 4) > 12 THEN
    RAISE EXCEPTION 'Financial year start month must be between 1 and 12.';
  END IF;

  v_clean_gstin := NULLIF(upper(trim(COALESCE(p_gstin, ''))), '');
  IF COALESCE(p_gst_registered, false) AND v_clean_gstin IS NOT NULL THEN
    IF v_clean_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$' THEN
      RAISE EXCEPTION 'Invalid 15-character GSTIN format.';
    END IF;
  END IF;

  IF p_default_print_layout IS NOT NULL AND p_default_print_layout NOT IN ('a4', 'a5', 'thermal_80') THEN
    RAISE EXCEPTION 'Default print layout must be a4, a5, or thermal_80.';
  END IF;

  IF p_cashier_max_discount_pct IS NOT NULL AND (p_cashier_max_discount_pct < 0 OR p_cashier_max_discount_pct > 100) THEN
    RAISE EXCEPTION 'Cashier max discount percentage must be between 0 and 100.';
  END IF;

  IF p_logo_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_logo_file_id) THEN
    RAISE EXCEPTION 'Logo file not found.';
  END IF;

  IF p_upi_qr_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_upi_qr_file_id) THEN
    RAISE EXCEPTION 'UPI QR file not found.';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();

  UPDATE public.business
  SET
    name = trim(p_name),
    gst_registered = COALESCE(p_gst_registered, false),
    gstin = CASE WHEN COALESCE(p_gst_registered, false) THEN v_clean_gstin ELSE NULL END,
    phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
    email = NULLIF(trim(COALESCE(p_email, '')), ''),
    address = NULLIF(trim(COALESCE(p_address, '')), ''),
    state_code = NULLIF(upper(trim(COALESCE(p_state_code, ''))), ''),
    upi_id = NULLIF(trim(COALESCE(p_upi_id, '')), ''),
    fy_start_month = COALESCE(p_fy_start_month, 4),
    logo_file_id = p_logo_file_id,
    upi_qr_file_id = p_upi_qr_file_id,
    invoice_prefix = COALESCE(NULLIF(trim(p_invoice_prefix), ''), 'INV-'),
    invoice_next_number = GREATEST(1, COALESCE(p_invoice_next_number, 1)),
    invoice_terms = COALESCE(p_invoice_terms, ''),
    tax_mode = CASE WHEN p_tax_mode = 'inclusive' THEN 'inclusive' ELSE 'exclusive' END,
    default_print_layout = COALESCE(p_default_print_layout, default_print_layout),
    show_upi_qr_on_invoice = COALESCE(p_show_upi_qr_on_invoice, show_upi_qr_on_invoice),
    quotation_prefix = COALESCE(NULLIF(trim(p_quotation_prefix), ''), quotation_prefix),
    quotation_next_number = GREATEST(1, COALESCE(p_quotation_next_number, quotation_next_number)),
    credit_note_prefix = COALESCE(NULLIF(trim(p_credit_note_prefix), ''), credit_note_prefix),
    credit_note_next_number = GREATEST(1, COALESCE(p_credit_note_next_number, credit_note_next_number)),
    cashier_max_discount_pct = COALESCE(round(p_cashier_max_discount_pct::numeric, 2), cashier_max_discount_pct),
    allow_cashier_price_override = COALESCE(p_allow_cashier_price_override, allow_cashier_price_override),
    purchase_prefix = COALESCE(NULLIF(trim(p_purchase_prefix), ''), purchase_prefix),
    purchase_next_number = GREATEST(1, COALESCE(p_purchase_next_number, purchase_next_number)),
    purchase_return_prefix = COALESCE(NULLIF(trim(p_purchase_return_prefix), ''), purchase_return_prefix),
    purchase_return_next_number = GREATEST(1, COALESCE(p_purchase_return_next_number, purchase_return_next_number)),
    expense_prefix = COALESCE(NULLIF(trim(p_expense_prefix), ''), expense_prefix),
    expense_next_number = GREATEST(1, COALESCE(p_expense_next_number, expense_next_number)),
    pack_settings = COALESCE(p_pack_settings, pack_settings)
  WHERE id = 1
  RETURNING * INTO v_row;

  v_steps := v_row.onboarding_steps
    || jsonb_build_object(
      'logo', (v_row.logo_file_id IS NOT NULL),
      'address', (v_row.address IS NOT NULL AND length(trim(v_row.address)) > 0),
      'gst', true
    );

  UPDATE public.business
  SET
    onboarding_steps = v_steps,
    onboarding_completed = (
      COALESCE((v_steps->>'logo')::boolean, false)
      AND COALESCE((v_steps->>'address')::boolean, false)
      AND COALESCE((v_steps->>'gst')::boolean, false)
      AND COALESCE((v_steps->>'profile')::boolean, false)
      AND COALESCE((v_steps->>'modules')::boolean, false)
    )
  WHERE id = 1
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_email,
    'business.updated', 'business', '1',
    jsonb_build_object('name', v_row.name, 'gst_registered', v_row.gst_registered)
  );

  RETURN v_row;
END;
$$;

-- save_item (without p_wholesale_slabs)
DROP FUNCTION IF EXISTS public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer, text, jsonb
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
  p_item_type text DEFAULT 'goods'
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
      pack_metadata, notes, item_type, created_by
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
    jsonb_build_object('name', v_item.name, 'item_type', v_item.item_type, 'selling_price', v_item.selling_price)
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

-- save_party (without p_price_tier)
DROP FUNCTION IF EXISTS public.save_party(
  uuid, text, text, text, text, text, numeric, text, date, numeric, integer, text, jsonb, integer, text
);

CREATE OR REPLACE FUNCTION public.save_party(
  p_party_id uuid DEFAULT NULL,
  p_name text DEFAULT '',
  p_party_type text DEFAULT 'customer',
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_gstin text DEFAULT NULL,
  p_opening_balance numeric DEFAULT 0,
  p_opening_balance_type text DEFAULT 'to_receive',
  p_opening_balance_date date DEFAULT CURRENT_DATE,
  p_credit_limit numeric DEFAULT 0,
  p_credit_days integer DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_addresses jsonb DEFAULT '[]'::jsonb,
  p_expected_version integer DEFAULT NULL
)
RETURNS public.parties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_clean_name text;
  v_clean_gstin text;
  v_ob numeric(15,2);
  v_ob_type text;
  v_ob_date date;
  v_old_party public.parties;
  v_party public.parties;
  v_old_signed numeric(15,2);
  v_new_signed numeric(15,2);
  v_delta numeric(15,2);
  v_ob_ref text;
  v_addr jsonb;
  v_has_default boolean := false;
  v_addr_is_default boolean;
  v_line1 text;
  v_first_addr_id uuid;
BEGIN
  PERFORM public.require_module('parties');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to add or edit parties.';
  END IF;

  v_clean_name := trim(COALESCE(p_name, ''));
  IF length(v_clean_name) < 1 OR length(v_clean_name) > 160 THEN
    RAISE EXCEPTION 'Party name is required (max 160 characters).';
  END IF;
  IF p_party_type NOT IN ('customer', 'supplier', 'both') THEN
    RAISE EXCEPTION 'Invalid party type: %', p_party_type;
  END IF;

  v_clean_gstin := NULLIF(upper(trim(COALESCE(p_gstin, ''))), '');
  IF v_clean_gstin IS NOT NULL AND v_clean_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$' THEN
    RAISE EXCEPTION 'Invalid 15-character GSTIN format.';
  END IF;

  v_ob := round(COALESCE(p_opening_balance, 0)::numeric, 2);
  IF v_ob < 0 THEN
    RAISE EXCEPTION 'Opening balance amount cannot be negative.';
  END IF;
  v_ob_type := COALESCE(NULLIF(trim(p_opening_balance_type), ''), 'to_receive');
  IF v_ob_type NOT IN ('to_receive', 'to_give') THEN
    RAISE EXCEPTION 'Invalid opening balance direction.';
  END IF;
  v_ob_date := COALESCE(p_opening_balance_date, CURRENT_DATE);
  IF COALESCE(p_credit_limit, 0) < 0 OR COALESCE(p_credit_days, 0) < 0 THEN
    RAISE EXCEPTION 'Credit limit and credit days must be zero or positive.';
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  IF p_party_id IS NULL THEN
    INSERT INTO public.parties (
      name, party_type, phone, email, gstin,
      opening_balance, opening_balance_type, opening_balance_date,
      credit_limit, credit_days, notes, created_by
    )
    VALUES (
      v_clean_name, p_party_type, NULLIF(trim(COALESCE(p_phone, '')), ''),
      NULLIF(trim(COALESCE(p_email, '')), ''), v_clean_gstin,
      v_ob, v_ob_type, v_ob_date,
      round(COALESCE(p_credit_limit, 0)::numeric, 2), COALESCE(p_credit_days, 0),
      NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid()
    )
    RETURNING * INTO v_party;

    IF v_ob > 0 THEN
      v_new_signed := CASE WHEN v_ob_type = 'to_receive' THEN v_ob ELSE -v_ob END;
      v_ob_ref := public.next_document_number('opening_balance', v_ob_date);
      INSERT INTO public.party_ledger_entries (
        party_id, entry_type, entry_date, due_date, reference_no,
        source_table, source_id, signed_amount, note, created_by
      )
      VALUES (
        v_party.id, 'opening_balance', v_ob_date,
        CASE WHEN COALESCE(p_credit_days, 0) > 0 THEN v_ob_date + COALESCE(p_credit_days, 0) ELSE v_ob_date END,
        v_ob_ref, 'parties', v_party.id, v_new_signed,
        'Opening balance (' || CASE WHEN v_ob_type = 'to_receive' THEN 'To Receive' ELSE 'To Give' END || ')',
        auth.uid()
      );
    END IF;
  ELSE
    SELECT * INTO v_old_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Party not found.';
    END IF;
    IF p_expected_version IS NOT NULL AND v_old_party.version <> p_expected_version THEN
      RAISE EXCEPTION 'This party was modified by another user. Please refresh and try again.';
    END IF;

    v_old_signed := CASE WHEN v_old_party.opening_balance = 0 THEN 0 WHEN v_old_party.opening_balance_type = 'to_receive' THEN v_old_party.opening_balance ELSE -v_old_party.opening_balance END;
    v_new_signed := CASE WHEN v_ob = 0 THEN 0 WHEN v_ob_type = 'to_receive' THEN v_ob ELSE -v_ob END;
    v_delta := v_new_signed - v_old_signed;

    UPDATE public.parties
    SET
      name = v_clean_name,
      party_type = p_party_type,
      phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
      email = NULLIF(trim(COALESCE(p_email, '')), ''),
      gstin = v_clean_gstin,
      opening_balance = v_ob,
      opening_balance_type = v_ob_type,
      opening_balance_date = v_ob_date,
      credit_limit = round(COALESCE(p_credit_limit, 0)::numeric, 2),
      credit_days = COALESCE(p_credit_days, 0),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      version = v_old_party.version + 1
    WHERE id = p_party_id
    RETURNING * INTO v_party;

    IF v_delta <> 0 THEN
      IF NOT EXISTS (SELECT 1 FROM public.party_ledger_entries WHERE party_id = v_party.id AND entry_type = 'opening_balance') AND v_old_signed = 0 THEN
        v_ob_ref := public.next_document_number('opening_balance', v_ob_date);
        INSERT INTO public.party_ledger_entries (party_id, entry_type, entry_date, due_date, reference_no, source_table, source_id, signed_amount, note, created_by)
        VALUES (v_party.id, 'opening_balance', v_ob_date, CASE WHEN COALESCE(p_credit_days, 0) > 0 THEN v_ob_date + COALESCE(p_credit_days, 0) ELSE v_ob_date END, v_ob_ref, 'parties', v_party.id, v_delta, 'Opening balance', auth.uid());
      ELSE
        v_ob_ref := public.next_document_number('khata_entry', CURRENT_DATE);
        INSERT INTO public.party_ledger_entries (party_id, entry_type, entry_date, reference_no, source_table, source_id, signed_amount, note, created_by)
        VALUES (v_party.id, 'adjustment', CURRENT_DATE, v_ob_ref, 'parties', v_party.id, v_delta, 'Opening balance adjusted', auth.uid());
      END IF;
    END IF;
  END IF;

  IF p_addresses IS NOT NULL AND jsonb_typeof(p_addresses) = 'array' THEN
    DELETE FROM public.party_addresses WHERE party_id = v_party.id;
    FOR v_addr IN SELECT value FROM jsonb_array_elements(p_addresses)
    LOOP
      v_line1 := trim(COALESCE(v_addr->>'address_line1', ''));
      IF length(v_line1) > 0 THEN
        v_addr_is_default := COALESCE((v_addr->>'is_default')::boolean, false) AND NOT v_has_default;
        IF v_addr_is_default THEN v_has_default := true; END IF;
        INSERT INTO public.party_addresses (party_id, label, address_line1, address_line2, city, state, state_code, pincode, is_default)
        VALUES (
          v_party.id,
          COALESCE(NULLIF(trim(COALESCE(v_addr->>'label', '')), ''), 'Primary'),
          v_line1,
          NULLIF(trim(COALESCE(v_addr->>'address_line2', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'city', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'state', '')), ''),
          NULLIF(upper(trim(COALESCE(v_addr->>'state_code', ''))), ''),
          NULLIF(trim(COALESCE(v_addr->>'pincode', '')), ''),
          v_addr_is_default
        )
        RETURNING id INTO v_first_addr_id;
      END IF;
    END LOOP;
    IF NOT v_has_default AND v_first_addr_id IS NOT NULL THEN
      UPDATE public.party_addresses SET is_default = true
      WHERE id = (SELECT id FROM public.party_addresses WHERE party_id = v_party.id ORDER BY created_at ASC LIMIT 1);
    END IF;
  END IF;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_party_id IS NULL THEN 'party.created' ELSE 'party.updated' END,
    'party', v_party.id::text,
    jsonb_build_object('name', v_party.name, 'party_type', v_party.party_type)
  );

  RETURN v_party;
END;
$$;

-- save_expense (without p_job_id)
DROP FUNCTION IF EXISTS public.save_expense(uuid, uuid, date, numeric, text, text, text, text, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.save_expense(
  p_id uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_expense_date date DEFAULT CURRENT_DATE,
  p_amount numeric DEFAULT 0,
  p_payment_mode text DEFAULT 'cash',
  p_reference_no text DEFAULT NULL,
  p_paid_to text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_attachment_file_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_amt numeric(15,2);
  v_mode text;
  v_date date;
  v_idemp text;
  v_existing public.expenses;
  v_exp_no text;
  v_exp public.expenses;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('expenses');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to record expenses.';
  END IF;
  IF p_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE id = p_category_id AND is_active = true) THEN
    RAISE EXCEPTION 'Please choose a valid expense category.';
  END IF;

  v_amt := round(COALESCE(p_amount, 0)::numeric, 2);
  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero.';
  END IF;

  v_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), ''), 'cash');
  IF v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode.';
  END IF;

  IF p_attachment_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_attachment_file_id) THEN
    RAISE EXCEPTION 'Attached receipt file not found.';
  END IF;

  v_date := COALESCE(p_expense_date, CURRENT_DATE);
  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');

  IF v_idemp IS NOT NULL AND p_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('expense:' || v_idemp));
    SELECT * INTO v_existing FROM public.expenses WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  PERFORM set_config('app.expense_rpc_context', txid_current()::text, true);

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.expenses WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found.'; END IF;
    IF v_role = 'cashier' AND v_existing.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Cashiers can only edit their own expense entries.';
    END IF;
    IF v_existing.status = 'voided' THEN
      RAISE EXCEPTION 'Voided expenses cannot be edited.';
    END IF;

    UPDATE public.expenses
    SET category_id = p_category_id, expense_date = v_date, amount = v_amt, payment_mode = v_mode,
        reference_no = NULLIF(trim(COALESCE(p_reference_no, '')), ''),
        paid_to = NULLIF(trim(COALESCE(p_paid_to, '')), ''),
        notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
        attachment_file_id = p_attachment_file_id
    WHERE id = p_id
    RETURNING * INTO v_exp;
  ELSE
    v_exp_no := public.next_document_number('expense', v_date);
    INSERT INTO public.expenses (
      expense_number, category_id, expense_date, amount, payment_mode,
      reference_no, paid_to, notes, attachment_file_id, idempotency_key, created_by
    )
    VALUES (
      v_exp_no, p_category_id, v_date, v_amt, v_mode,
      NULLIF(trim(COALESCE(p_reference_no, '')), ''), NULLIF(trim(COALESCE(p_paid_to, '')), ''),
      NULLIF(trim(COALESCE(p_notes, '')), ''), p_attachment_file_id, v_idemp, auth.uid()
    )
    RETURNING * INTO v_exp;
  END IF;

  IF p_attachment_file_id IS NOT NULL THEN
    INSERT INTO public.file_links (file_id, entity_type, entity_id)
    VALUES (p_attachment_file_id, 'expense', v_exp.id)
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM set_config('app.expense_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NOT NULL THEN 'expense.updated' ELSE 'expense.created' END,
    'expense', v_exp.id::text,
    jsonb_build_object('expense_number', v_exp.expense_number, 'amount', v_exp.amount)
  );

  RETURN v_exp;
END;
$$;

-- _prepare_bill_payload (clean DecorBiz version without batches, variants, slabs, rate cards)
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

    v_qty := round(COALESCE((v_raw->>'entered_qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantity for "%" must be greater than zero.', v_item.name;
    END IF;

    v_unit_id := COALESCE(NULLIF(trim(COALESCE(v_raw->>'entered_unit_id', '')), '')::uuid, v_item.base_unit_id);
    SELECT base_qty, conversion_factor INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id);
    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    v_catalog_price := round((COALESCE(v_item.selling_price, 0) * v_factor)::numeric, 2);
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
      'item_type', v_item.item_type,
      'item_name', v_item.name,
      'sku', v_item.sku,
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
      'mrp', v_item.mrp,
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

-- save_bill_draft (without p_job_id or batch/variant cols)
DROP FUNCTION IF EXISTS public.save_bill_draft(
  uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, uuid, uuid
);

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
  v_role text;
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
  v_role := public.current_user_role();
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
    IF v_existing.status <> 'draft' THEN
      RAISE EXCEPTION 'Only draft documents can be edited. Issued documents are immutable.';
    END IF;

    UPDATE public.bills
    SET
      doc_type = p_doc_type, party_id = p_party_id, party_name = v_prep->>'party_name',
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
      business_snapshot = v_prep->'biz_snapshot',
      site_id = p_site_id, site_name = v_site_name
    WHERE id = p_id
    RETURNING * INTO v_bill;

    DELETE FROM public.bill_lines WHERE bill_id = v_bill.id;
  END IF;

  FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1)
  LOOP
    v_pl := (v_prep->'prepared_lines')->v_i;
    v_cl := (v_calc->'lines')->v_i;

    INSERT INTO public.bill_lines (
      bill_id, line_no, item_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_bill.id, v_i + 1, (v_pl->>'item_id')::uuid, v_pl->>'item_name',
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
      NULLIF(v_pl->>'mrp', '')::numeric,
      COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );
  END LOOP;

  RETURN v_bill;
END;
$$;

-- issue_bill (17 params, without p_job_id, p_prescription, batch/variant/warranty/rx)
DROP FUNCTION IF EXISTS public.issue_bill(
  uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, numeric, text, text, text, uuid, uuid, jsonb
);

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
  v_role text;
  v_biz public.business;
  v_idemp text;
  v_existing public.bills;
  v_prep jsonb;
  v_calc jsonb;
  v_bill_date date;
  v_due_date date;
  v_grand numeric(15,2);
  v_paid numeric(15,2);
  v_balance numeric(15,2);
  v_mode text;
  v_pay_ref text;
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
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to issue bills.';
  END IF;

  v_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), ''), 'cash');
  IF v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode: %.', v_mode;
  END IF;
  v_pay_ref := NULLIF(trim(COALESCE(p_payment_reference, '')), '');

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('bill_issue:' || v_idemp));
    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_bill_date := COALESCE(p_bill_date, CURRENT_DATE);

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
    IF v_paid > v_grand THEN
      RAISE EXCEPTION 'Paid amount (₹%) exceeds bill grand total (₹%). Collect extra advance from Payments screen.', v_paid, v_grand;
    END IF;
    IF p_party_id IS NULL AND v_paid < v_grand THEN
      RAISE EXCEPTION 'Walk-in cash bills must be paid in full (or select a party for Khata credit).';
    END IF;
    IF p_party_id IS NOT NULL AND v_paid < v_grand AND NOT public.is_module_enabled('parties') THEN
      RAISE EXCEPTION 'Parties & Khata module must be enabled to leave a credit balance.';
    END IF;
    IF p_party_id IS NOT NULL AND v_paid > 0 AND NOT public.is_module_enabled('payments') THEN
      RAISE EXCEPTION 'Payments module must be enabled to record an immediate payment on a party bill.';
    END IF;
    v_balance := round((v_grand - v_paid)::numeric, 2);
  END IF;

  v_bill_number := public.next_document_number(p_doc_type, v_bill_date);

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.bill_line_init', txid_current()::text, true);

  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.bills WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft bill not found.'; END IF;
    IF v_existing.status <> 'draft' THEN RAISE EXCEPTION 'This document has already been issued.'; END IF;
    DELETE FROM public.bill_lines WHERE bill_id = p_draft_id;

    UPDATE public.bills
    SET
      bill_number = v_bill_number, doc_type = p_doc_type, status = 'issued',
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
      site_id = p_site_id, site_name = v_site_name,
      issued_at = now(), issued_by = auth.uid()
    WHERE id = p_draft_id
    RETURNING * INTO v_bill;
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
      bill_id, line_no, item_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_bill.id, v_i + 1, (v_pl->>'item_id')::uuid, v_pl->>'item_name',
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
      NULLIF(v_pl->>'mrp', '')::numeric,
      COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );

    IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, 'sale', v_bill_date,
        (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric, -((v_pl->>'base_qty')::numeric),
        (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid),
        'Sales Bill ' || v_bill.bill_number, v_bill.bill_number,
        'bills', v_bill.id, auth.uid()
      );
    END IF;
  END LOOP;

  PERFORM set_config('app.bill_line_init', '', true);

  IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND p_party_id IS NOT NULL AND public.is_module_enabled('parties') THEN
    IF v_grand > 0 THEN
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
          false,
          CASE WHEN v_idemp IS NOT NULL THEN 'bill_pay:' || v_idemp ELSE NULL END
        );
      END IF;
    END IF;
  END IF;

  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'bill.issued', 'bill', v_bill.id::text,
    jsonb_build_object('bill_number', v_bill.bill_number, 'doc_type', v_bill.doc_type, 'grand_total', v_bill.grand_total, 'payment_mode', v_mode)
  );

  SELECT * INTO v_bill FROM public.bills WHERE id = v_bill.id;
  RETURN v_bill;
END;
$$;

-- convert_quotation_to_bill (updated for 17-param issue_bill & no batch/variant/job)
CREATE OR REPLACE FUNCTION public.convert_quotation_to_bill(
  p_quotation_id uuid,
  p_doc_type text DEFAULT NULL,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_paid_amount numeric DEFAULT 0,
  p_payment_mode text DEFAULT 'cash',
  p_payment_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_biz public.business;
  v_idemp text;
  v_existing public.bills;
  v_quote public.bills;
  v_target_type text;
  v_lines jsonb;
  v_new_bill public.bills;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to convert quotations.';
  END IF;

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('quote_convert:' || v_idemp));
    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_idemp;
    IF FOUND AND v_existing.converted_from_quotation_id = p_quotation_id THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_quote FROM public.bills WHERE id = p_quotation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found.'; END IF;
  IF v_quote.doc_type <> 'quotation' THEN RAISE EXCEPTION 'Only quotations can be converted.'; END IF;
  IF v_quote.status <> 'issued' THEN RAISE EXCEPTION 'Only open issued quotations can be converted.'; END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_target_type := COALESCE(NULLIF(trim(COALESCE(p_doc_type, '')), ''), CASE WHEN v_biz.gst_registered THEN 'tax_invoice' ELSE 'bill_of_supply' END);

  SELECT jsonb_agg(jsonb_build_object(
    'item_id', bl.item_id,
    'entered_qty', bl.entered_qty,
    'entered_unit_id', bl.entered_unit_id,
    'unit_price', bl.unit_price,
    'discount_pct', bl.discount_pct,
    'tax_inclusive', bl.tax_inclusive,
    'line_meta', bl.line_meta
  ) ORDER BY bl.line_no ASC)
  INTO v_lines
  FROM public.bill_lines bl
  WHERE bl.bill_id = p_quotation_id;

  v_new_bill := public.issue_bill(
    NULL, v_target_type, v_quote.party_id, COALESCE(p_bill_date, CURRENT_DATE), p_due_date, NULL,
    v_quote.place_of_supply_state_code, v_quote.extra_charges, v_quote.auto_round_off,
    v_quote.notes, v_quote.terms, v_lines, p_paid_amount, p_payment_mode, p_payment_reference,
    v_idemp, v_quote.site_id
  );

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  UPDATE public.bills SET status = 'converted', converted_to_bill_id = v_new_bill.id WHERE id = p_quotation_id;
  UPDATE public.bills SET converted_from_quotation_id = p_quotation_id WHERE id = v_new_bill.id;
  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'quotation.converted', 'bill', p_quotation_id::text,
    jsonb_build_object('quotation_number', v_quote.bill_number, 'bill_id', v_new_bill.id, 'bill_number', v_new_bill.bill_number)
  );

  SELECT * INTO v_new_bill FROM public.bills WHERE id = v_new_bill.id;
  RETURN v_new_bill;
END;
$$;

-- convert_estimate_to_quotation (updated for 17-param issue_bill)
CREATE OR REPLACE FUNCTION public.convert_estimate_to_quotation(p_estimate_id uuid)
RETURNS public.bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_est public.hardware_estimates;
  v_bill public.bills;
BEGIN
  SELECT * INTO v_est FROM public.hardware_estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Estimate not found.'; END IF;
  IF v_est.status = 'converted' AND v_est.converted_bill_id IS NOT NULL THEN
    SELECT * INTO v_bill FROM public.bills WHERE id = v_est.converted_bill_id;
    RETURN v_bill;
  END IF;

  v_bill := public.issue_bill(
    NULL, 'quotation', v_est.party_id, CURRENT_DATE, NULL, (CURRENT_DATE + 15),
    NULL, 0, true, COALESCE(v_est.notes, 'Estimate ' || v_est.estimate_number || ': ' || v_est.title),
    NULL, v_est.lines, 0, 'cash', NULL, 'est_conv:' || v_est.id::text, v_est.site_id
  );

  UPDATE public.hardware_estimates
  SET status = 'converted', converted_bill_id = v_bill.id
  WHERE id = p_estimate_id;

  RETURN v_bill;
END;
$$;

-- sync_offline_bill_queue (updated for 17-param issue_bill)
CREATE OR REPLACE FUNCTION public.sync_offline_bill_queue(p_offline_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_key text;
  v_existing public.bills;
  v_issued public.bills;
  v_results jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('billing');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']) THEN
    RAISE EXCEPTION 'Billing permission required for offline sync.';
  END IF;

  IF jsonb_typeof(p_offline_items) <> 'array' THEN
    RAISE EXCEPTION 'Offline queue payload must be a JSON array.';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_offline_items) LOOP
    v_key := trim(COALESCE(v_item->>'idempotency_key', ''));
    IF length(v_key) < 8 THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'status', 'error',
        'error', 'Missing idempotency_key for offline bill.'
      ));
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_key LIMIT 1;
    IF FOUND THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'idempotency_key', v_key,
        'status', 'deduplicated',
        'bill_id', v_existing.id,
        'bill_number', v_existing.bill_number
      ));
      CONTINUE;
    END IF;

    BEGIN
      v_issued := public.issue_bill(
        NULL,
        COALESCE(v_item->>'doc_type', 'tax_invoice'),
        NULLIF(v_item->>'party_id', '')::uuid,
        COALESCE(NULLIF(v_item->>'bill_date', '')::date, CURRENT_DATE),
        NULLIF(v_item->>'due_date', '')::date,
        NULL,
        NULLIF(v_item->>'place_of_supply', ''),
        COALESCE((v_item->>'extra_charges')::numeric, 0),
        true,
        NULLIF(v_item->>'notes', ''),
        NULL,
        COALESCE(v_item->'lines', '[]'::jsonb),
        COALESCE((v_item->>'paid_amount')::numeric, 0),
        COALESCE(v_item->>'payment_mode', 'cash'),
        NULLIF(v_item->>'payment_reference', ''),
        v_key,
        NULL
      );
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'idempotency_key', v_key,
        'status', 'synced',
        'bill_id', v_issued.id,
        'bill_number', v_issued.bill_number
      ));
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'idempotency_key', v_key,
        'status', 'error',
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object('results', v_results);
END;
$$;

-- create_sales_return (without dropped batch/variant cols)
CREATE OR REPLACE FUNCTION public.create_sales_return(
  p_source_bill_id uuid,
  p_lines jsonb,
  p_return_date date DEFAULT CURRENT_DATE,
  p_refund_amount numeric DEFAULT 0,
  p_refund_mode text DEFAULT 'cash',
  p_reason text DEFAULT '',
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_clean_reason text;
  v_idemp text;
  v_existing public.bills;
  v_source public.bills;
  v_return_date date;
  v_req jsonb;
  v_src_line public.bill_lines;
  v_item_type text := 'goods';
  v_ret_qty numeric(15,3);
  v_already_ret numeric(15,3);
  v_rem_qty numeric(15,3);
  v_base_qty numeric(15,3);
  v_base_allow_decimal boolean;
  v_prep_lines jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_cn_number text;
  v_cn public.bills;
  v_grand numeric(15,2);
  v_refund numeric(15,2);
  v_refund_mode text;
  v_credit_applied numeric(15,2);
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
  v_new_credited numeric(15,2);
  v_new_balance numeric(15,2);
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Cashier can record sales returns.';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter a return reason (minimum 3 characters).';
  END IF;

  v_refund_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_refund_mode, ''))), ''), 'cash');
  IF v_refund_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid refund payment mode: %.', v_refund_mode;
  END IF;

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('sales_return:' || v_idemp));
    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_source FROM public.bills WHERE id = p_source_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source invoice not found.'; END IF;
  IF v_source.status <> 'issued' OR v_source.doc_type NOT IN ('tax_invoice', 'bill_of_supply') THEN
    RAISE EXCEPTION 'Sales returns are only allowed against issued invoices.';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Select at least one item line to return.';
  END IF;

  FOR v_req IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_src_line FROM public.bill_lines
    WHERE id = (v_req->>'source_bill_line_id')::uuid AND bill_id = p_source_bill_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Referenced bill line does not belong to source invoice.'; END IF;

    v_ret_qty := round(COALESCE((v_req->>'entered_qty')::numeric, 0), 3);
    IF v_ret_qty <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(bl.entered_qty), 0)::numeric(15,3)
    INTO v_already_ret
    FROM public.bill_lines bl JOIN public.bills b ON b.id = bl.bill_id
    WHERE bl.source_bill_line_id = v_src_line.id AND b.doc_type = 'credit_note' AND b.status <> 'voided';

    v_rem_qty := round((v_src_line.entered_qty - v_already_ret)::numeric, 3);
    IF v_ret_qty > v_rem_qty THEN
      RAISE EXCEPTION 'Return quantity for "%" exceeds returnable quantity (% %).', v_src_line.item_name, v_rem_qty, v_src_line.entered_unit_code;
    END IF;

    v_base_qty := round((v_ret_qty * v_src_line.conversion_factor)::numeric, 3);
    v_item_type := 'goods';
    IF v_src_line.item_id IS NOT NULL THEN
      SELECT i.item_type, u.allow_decimal INTO v_item_type, v_base_allow_decimal
      FROM public.items i JOIN public.item_units u ON u.id = i.base_unit_id WHERE i.id = v_src_line.item_id;
      IF FOUND AND NOT COALESCE(v_base_allow_decimal, true) AND v_base_qty <> trunc(v_base_qty) THEN
        RAISE EXCEPTION 'Base unit for "%" does not allow fractional return quantities.', v_src_line.item_name;
      END IF;
    END IF;

    v_prep_lines := v_prep_lines || jsonb_build_array(jsonb_build_object(
      'source_bill_line_id', v_src_line.id, 'item_id', v_src_line.item_id, 'item_type', COALESCE(v_item_type, 'goods'),
      'item_name', v_src_line.item_name, 'sku', v_src_line.sku, 'hsn_code', v_src_line.hsn_code,
      'entered_qty', v_ret_qty, 'entered_unit_id', v_src_line.entered_unit_id,
      'entered_unit_code', v_src_line.entered_unit_code, 'conversion_factor', v_src_line.conversion_factor,
      'base_qty', v_base_qty, 'catalog_unit_price', v_src_line.catalog_unit_price,
      'unit_price', v_src_line.unit_price, 'discount_pct', v_src_line.discount_pct,
      'tax_inclusive', v_src_line.tax_inclusive, 'gst_rate', v_src_line.gst_rate,
      'mrp', v_src_line.mrp
    ));
  END LOOP;

  IF jsonb_array_length(v_prep_lines) = 0 THEN
    RAISE EXCEPTION 'Enter a positive return quantity for at least one item.';
  END IF;

  v_calc := public.compute_bill_amounts(
    v_source.gst_applied,
    CASE WHEN v_source.doc_type = 'bill_of_supply' THEN 'bill_of_supply' ELSE 'credit_note' END,
    v_source.is_interstate, 0, v_source.auto_round_off, v_prep_lines
  );
  v_grand := (v_calc->>'grand_total')::numeric(15,2);
  v_refund := round(COALESCE(p_refund_amount, 0)::numeric, 2);
  IF v_refund < 0 OR v_refund > v_grand THEN
    RAISE EXCEPTION 'Refund amount must be between ₹0 and Credit Note total (₹%).', v_grand;
  END IF;

  v_credit_applied := GREATEST(round((v_grand - v_refund)::numeric, 2), 0);
  v_return_date := COALESCE(p_return_date, CURRENT_DATE);
  v_cn_number := public.next_document_number('credit_note', v_return_date);

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.bill_line_init', txid_current()::text, true);

  INSERT INTO public.bills (
    bill_number, doc_type, status, source_bill_id,
    party_id, party_name, party_phone, party_gstin, party_address,
    place_of_supply_state_code, is_interstate, bill_date, gst_applied,
    subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total,
    tax_total, extra_charges, auto_round_off, round_off, grand_total,
    paid_amount, credited_amount, balance_due, payment_mode,
    return_reason, notes, terms, business_snapshot, idempotency_key,
    issued_at, issued_by, created_by
  )
  VALUES (
    v_cn_number, 'credit_note', 'issued', v_source.id,
    v_source.party_id, v_source.party_name, v_source.party_phone, v_source.party_gstin, v_source.party_address,
    v_source.place_of_supply_state_code, (v_calc->>'is_interstate')::boolean, v_return_date, (v_calc->>'gst_applied')::boolean,
    (v_calc->>'subtotal_taxable')::numeric, (v_calc->>'discount_total')::numeric,
    (v_calc->>'cgst_total')::numeric, (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
    (v_calc->>'tax_total')::numeric, 0, v_source.auto_round_off, (v_calc->>'round_off')::numeric, v_grand,
    v_refund, 0, 0, v_refund_mode,
    v_clean_reason, 'Return against ' || v_source.bill_number || ': ' || v_clean_reason, v_source.terms,
    v_source.business_snapshot, v_idemp, now(), auth.uid(), auth.uid()
  )
  RETURNING * INTO v_cn;

  FOR v_i IN 0..(jsonb_array_length(v_prep_lines) - 1)
  LOOP
    v_pl := v_prep_lines->v_i;
    v_cl := (v_calc->'lines')->v_i;

    INSERT INTO public.bill_lines (
      bill_id, line_no, item_id, source_bill_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp
    )
    VALUES (
      v_cn.id, v_i + 1, (v_pl->>'item_id')::uuid, (v_pl->>'source_bill_line_id')::uuid,
      v_pl->>'item_name', NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'catalog_unit_price')::numeric,
      (v_pl->>'unit_price')::numeric, (v_pl->>'discount_pct')::numeric,
      (v_pl->>'tax_inclusive')::boolean, (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'mrp', '')::numeric
    );

    IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, 'sale_return', v_return_date,
        (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric, (v_pl->>'base_qty')::numeric,
        (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid),
        'Sales Return ' || v_cn.bill_number || ' (' || v_clean_reason || ')',
        v_cn.bill_number, 'bills', v_cn.id, auth.uid()
      );
    END IF;
  END LOOP;

  PERFORM set_config('app.bill_line_init', '', true);

  v_new_credited := round((v_source.credited_amount + v_credit_applied)::numeric, 2);
  v_new_balance := GREATEST(round((v_source.grand_total - v_source.paid_amount - v_new_credited)::numeric, 2), 0);
  UPDATE public.bills SET credited_amount = v_new_credited, balance_due = v_new_balance WHERE id = v_source.id;

  IF v_source.party_id IS NOT NULL AND public.is_module_enabled('parties') AND v_grand > 0 THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, reference_no, source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      v_source.party_id, 'sales_return', v_return_date, v_cn.bill_number, 'bills', v_cn.id,
      -v_grand, 'Credit Note ' || v_cn.bill_number || ' against ' || v_source.bill_number, auth.uid()
    );

    IF v_refund > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        v_source.party_id, 'give', v_refund, v_refund_mode, v_return_date,
        v_cn.bill_number, 'Refund for Credit Note ' || v_cn.bill_number, NULL, false,
        CASE WHEN v_idemp IS NOT NULL THEN 'cn_ref:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'bill.sales_return', 'bill', v_cn.id::text,
    jsonb_build_object('credit_note_number', v_cn.bill_number, 'source_bill_id', v_source.id, 'grand_total', v_grand)
  );

  RETURN v_cn;
END;
$$;

-- void_bill (without batch/variant/schedule_register/warranty_records)
CREATE OR REPLACE FUNCTION public.void_bill(
  p_bill_id uuid,
  p_reason text DEFAULT ''
)
RETURNS public.bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_clean_reason text;
  v_bill public.bills;
  v_updated public.bills;
  v_line record;
  v_orig_le public.party_ledger_entries;
  v_rev_le public.party_ledger_entries;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('billing');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Only Owner or Manager can void an issued bill.';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter a void reason (minimum 3 characters).';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found.'; END IF;
  IF v_bill.status <> 'issued' THEN RAISE EXCEPTION 'Only issued documents can be voided.'; END IF;
  IF v_bill.doc_type = 'credit_note' THEN RAISE EXCEPTION 'Credit notes cannot be voided directly.'; END IF;
  IF EXISTS (SELECT 1 FROM public.bills c WHERE c.source_bill_id = p_bill_id AND c.doc_type = 'credit_note' AND c.status <> 'voided') THEN
    RAISE EXCEPTION 'Cannot void a bill that has active credit notes / sales returns.';
  END IF;
  IF v_bill.party_id IS NOT NULL AND v_bill.paid_amount > 0 THEN
    RAISE EXCEPTION 'This bill has allocated payments (₹%). Reverse the linked payment(s) first before voiding.', v_bill.paid_amount;
  END IF;

  IF v_bill.doc_type IN ('tax_invoice', 'bill_of_supply') THEN
    FOR v_line IN
      SELECT bl.*, COALESCE(i.item_type, 'goods') AS item_type, i.purchase_price
      FROM public.bill_lines bl
      LEFT JOIN public.items i ON i.id = bl.item_id
      WHERE bl.bill_id = p_bill_id
      ORDER BY bl.line_no
    LOOP
      IF v_line.item_type = 'goods' THEN
        INSERT INTO public.stock_ledger (
          item_id, movement_type, movement_date, entered_qty, entered_unit_id,
          conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
          source_table, source_id, created_by
        )
        VALUES (
          v_line.item_id, 'adjustment_in', CURRENT_DATE,
          v_line.entered_qty, v_line.entered_unit_id, v_line.conversion_factor,
          v_line.base_qty, v_line.purchase_price,
          'Voided ' || v_bill.bill_number || ': ' || v_clean_reason,
          v_bill.bill_number || '-VOID', 'bills', v_bill.id, auth.uid()
        );
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);

  UPDATE public.bills
  SET status = 'voided', void_reason = v_clean_reason, voided_at = now(), voided_by = auth.uid(), balance_due = 0
  WHERE id = p_bill_id
  RETURNING * INTO v_updated;

  PERFORM set_config('app.bill_rpc_context', '', true);

  IF v_bill.party_id IS NOT NULL AND v_bill.doc_type IN ('tax_invoice', 'bill_of_supply') THEN
    SELECT * INTO v_orig_le FROM public.party_ledger_entries
    WHERE source_table = 'bills' AND source_id = p_bill_id AND entry_type = 'bill' AND is_reversed = false LIMIT 1;

    IF FOUND THEN
      INSERT INTO public.party_ledger_entries (
        party_id, entry_type, entry_date, reference_no, source_table, source_id, signed_amount, note, created_by
      )
      VALUES (
        v_bill.party_id, 'adjustment', CURRENT_DATE, v_bill.bill_number || '-VOID',
        'bills', p_bill_id, -v_orig_le.signed_amount,
        'Voided bill ' || v_bill.bill_number || ': ' || v_clean_reason, auth.uid()
      )
      RETURNING * INTO v_rev_le;

      UPDATE public.party_ledger_entries SET is_reversed = true, reversed_by_entry_id = v_rev_le.id WHERE id = v_orig_le.id;
    END IF;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_actor_email, 'bill.voided', 'bill', p_bill_id::text, jsonb_build_object('bill_number', v_bill.bill_number, 'reason', v_clean_reason));

  RETURN v_updated;
END;
$$;

-- _prepare_purchase_payload, save_purchase_draft, issue_purchase (without batches/variants)
CREATE OR REPLACE FUNCTION public._prepare_purchase_payload(
  p_party_id uuid DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_gst_applied boolean DEFAULT false,
  p_freight_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_lines jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz public.business;
  v_party public.parties;
  v_party_addr text;
  v_pos text;
  v_effective_gst boolean;
  v_is_interstate boolean := false;
  v_raw jsonb;
  v_item public.items;
  v_unit_id uuid;
  v_unit_code text;
  v_qty numeric(15,3);
  v_base_qty numeric(15,3);
  v_factor numeric(18,6);
  v_unit_cost numeric(15,2);
  v_disc_pct numeric(5,2);
  v_tax_incl boolean;
  v_gst_rate numeric(5,2);
  v_prepared_lines jsonb := '[]'::jsonb;
  v_calc_input_lines jsonb := '[]'::jsonb;
  v_calc jsonb;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one purchase item line.';
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;

  IF p_party_id IS NOT NULL THEN
    SELECT * INTO v_party FROM public.parties WHERE id = p_party_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected supplier was not found.'; END IF;
    IF NOT v_party.is_active THEN RAISE EXCEPTION 'Cannot record purchase for an archived supplier.'; END IF;
    SELECT concat_ws(', ', NULLIF(address_line1, ''), NULLIF(city, ''), NULLIF(state, ''), NULLIF(pincode, '')),
           COALESCE(NULLIF(upper(trim(p_place_of_supply)), ''), NULLIF(upper(trim(state_code)), ''))
    INTO v_party_addr, v_pos
    FROM public.party_addresses WHERE party_id = p_party_id ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  v_pos := COALESCE(NULLIF(upper(trim(COALESCE(p_place_of_supply, ''))), ''), v_pos, v_biz.state_code);
  v_effective_gst := COALESCE(p_gst_applied, false) AND public.is_module_enabled('tax');
  IF v_effective_gst AND v_biz.state_code IS NOT NULL AND v_pos IS NOT NULL AND v_biz.state_code <> v_pos THEN
    v_is_interstate := true;
  END IF;

  FOR v_raw IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_item FROM public.items WHERE id = (v_raw->>'item_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected item was not found.'; END IF;
    IF NOT v_item.is_active THEN RAISE EXCEPTION 'Item "%" is archived and cannot be purchased.', v_item.name; END IF;

    v_unit_id := COALESCE(NULLIF(v_raw->>'entered_unit_id', '')::uuid, v_item.base_unit_id);
    v_qty := COALESCE((v_raw->>'entered_qty')::numeric, 0);
    SELECT c.base_qty, c.conversion_factor INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id) c;
    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    v_unit_cost := round(GREATEST(0::numeric, COALESCE((v_raw->>'unit_cost')::numeric, COALESCE(v_item.purchase_price, 0), 0)), 2);
    v_disc_pct := LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'discount_pct')::numeric, 0), 2)));
    v_tax_incl := COALESCE((v_raw->>'tax_inclusive')::boolean, false);
    v_gst_rate := CASE WHEN v_effective_gst THEN LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'gst_rate')::numeric, v_item.gst_rate, 0), 2))) ELSE 0::numeric END;

    v_prepared_lines := v_prepared_lines || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'item_type', v_item.item_type,
      'item_name', v_item.name,
      'sku', v_item.sku,
      'hsn_code', v_item.hsn_code,
      'entered_qty', round(v_qty, 3),
      'entered_unit_id', v_unit_id,
      'entered_unit_code', v_unit_code,
      'conversion_factor', v_factor,
      'base_qty', v_base_qty,
      'unit_cost', v_unit_cost,
      'discount_pct', v_disc_pct,
      'tax_inclusive', v_tax_incl,
      'gst_rate', v_gst_rate,
      'mrp', NULLIF(trim(COALESCE(v_raw->>'mrp', '')), '')::numeric,
      'line_meta', COALESCE(v_raw->'line_meta', '{}'::jsonb)
    ));

    v_calc_input_lines := v_calc_input_lines || jsonb_build_array(jsonb_build_object(
      'entered_qty', round(v_qty, 3), 'unit_price', v_unit_cost,
      'discount_pct', v_disc_pct, 'tax_inclusive', v_tax_incl, 'gst_rate', v_gst_rate
    ));
  END LOOP;

  v_calc := public.compute_bill_amounts(
    v_effective_gst, CASE WHEN v_effective_gst THEN 'tax_invoice' ELSE 'bill_of_supply' END,
    v_is_interstate, COALESCE(p_freight_charges, 0), COALESCE(p_auto_round_off, true), v_calc_input_lines
  );

  RETURN jsonb_build_object(
    'party_name', COALESCE(v_party.name, 'Cash Supplier'),
    'party_phone', v_party.phone, 'party_gstin', v_party.gstin,
    'party_address', v_party_addr, 'place_of_supply_state_code', v_pos,
    'effective_gst', v_effective_gst, 'is_interstate', (v_calc->>'is_interstate')::boolean,
    'prepared_lines', v_prepared_lines, 'calc', v_calc
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_purchase_draft(
  p_id uuid DEFAULT NULL,
  p_party_id uuid DEFAULT NULL,
  p_supplier_invoice_no text DEFAULT NULL,
  p_supplier_invoice_date date DEFAULT NULL,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_gst_applied boolean DEFAULT false,
  p_freight_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_update_item_cost boolean DEFAULT false,
  p_notes text DEFAULT NULL,
  p_attachment_file_id uuid DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb
)
RETURNS public.purchase_bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_prep jsonb;
  v_calc jsonb;
  v_pb public.purchase_bills;
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
BEGIN
  PERFORM public.require_module('purchases');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to save purchase drafts.';
  END IF;
  IF p_attachment_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_attachment_file_id) THEN
    RAISE EXCEPTION 'Attached file not found.';
  END IF;

  v_prep := public._prepare_purchase_payload(p_party_id, p_place_of_supply, p_gst_applied, p_freight_charges, p_auto_round_off, p_lines);
  v_calc := v_prep->'calc';

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_pb FROM public.purchase_bills WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase draft not found.'; END IF;
    IF v_pb.status <> 'draft' THEN RAISE EXCEPTION 'Only draft purchases can be edited.'; END IF;
    DELETE FROM public.purchase_lines WHERE purchase_id = p_id;
    UPDATE public.purchase_bills
    SET party_id = p_party_id, party_name = v_prep->>'party_name', party_phone = v_prep->>'party_phone',
        party_gstin = v_prep->>'party_gstin', party_address = v_prep->>'party_address',
        supplier_invoice_no = NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''),
        supplier_invoice_date = p_supplier_invoice_date,
        bill_date = COALESCE(p_bill_date, CURRENT_DATE), due_date = p_due_date,
        place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
        is_interstate = (v_prep->>'is_interstate')::boolean,
        gst_applied = (v_prep->>'effective_gst')::boolean,
        subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
        discount_total = (v_calc->>'discount_total')::numeric,
        cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
        igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
        freight_charges = (v_calc->>'extra_charges')::numeric, auto_round_off = COALESCE(p_auto_round_off, true),
        round_off = (v_calc->>'round_off')::numeric, grand_total = (v_calc->>'grand_total')::numeric,
        paid_amount = 0, credited_amount = 0, balance_due = (v_calc->>'grand_total')::numeric,
        attachment_file_id = p_attachment_file_id, update_item_cost = COALESCE(p_update_item_cost, false),
        notes = NULLIF(trim(COALESCE(p_notes, '')), '')
    WHERE id = p_id RETURNING * INTO v_pb;
  ELSE
    INSERT INTO public.purchase_bills (
      doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      supplier_invoice_no, supplier_invoice_date, bill_date, due_date,
      place_of_supply_state_code, is_interstate, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total,
      tax_total, freight_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due,
      attachment_file_id, update_item_cost, notes, created_by
    )
    VALUES (
      'purchase_bill', 'draft', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address',
      NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''), p_supplier_invoice_date,
      COALESCE(p_bill_date, CURRENT_DATE), p_due_date, v_prep->>'place_of_supply_state_code',
      (v_prep->>'is_interstate')::boolean, (v_prep->>'effective_gst')::boolean,
      (v_calc->>'subtotal_taxable')::numeric, (v_calc->>'discount_total')::numeric,
      (v_calc->>'cgst_total')::numeric, (v_calc->>'sgst_total')::numeric,
      (v_calc->>'igst_total')::numeric, (v_calc->>'tax_total')::numeric,
      (v_calc->>'extra_charges')::numeric, COALESCE(p_auto_round_off, true),
      (v_calc->>'round_off')::numeric, (v_calc->>'grand_total')::numeric,
      0, 0, (v_calc->>'grand_total')::numeric,
      p_attachment_file_id, COALESCE(p_update_item_cost, false),
      NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid()
    )
    RETURNING * INTO v_pb;
  END IF;

  FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1)
  LOOP
    v_pl := (v_prep->'prepared_lines')->v_i;
    v_cl := (v_calc->'lines')->v_i;
    INSERT INTO public.purchase_lines (
      purchase_id, line_no, item_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_pb.id, v_i + 1, (v_pl->>'item_id')::uuid, v_pl->>'item_name',
      NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'unit_cost')::numeric,
      (v_pl->>'discount_pct')::numeric, (v_pl->>'tax_inclusive')::boolean,
      (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'mrp', '')::numeric,
      COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );
  END LOOP;

  RETURN v_pb;
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_purchase(
  p_draft_id uuid DEFAULT NULL,
  p_party_id uuid DEFAULT NULL,
  p_supplier_invoice_no text DEFAULT NULL,
  p_supplier_invoice_date date DEFAULT NULL,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_gst_applied boolean DEFAULT false,
  p_freight_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_update_item_cost boolean DEFAULT false,
  p_notes text DEFAULT NULL,
  p_attachment_file_id uuid DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_paid_amount numeric DEFAULT 0,
  p_payment_mode text DEFAULT 'cash',
  p_payment_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.purchase_bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_idemp text;
  v_existing public.purchase_bills;
  v_mode text;
  v_pay_ref text;
  v_bill_date date;
  v_due_date date;
  v_party_credit_days integer := 0;
  v_prep jsonb;
  v_calc jsonb;
  v_grand numeric(15,2);
  v_paid numeric(15,2);
  v_balance numeric(15,2);
  v_pur_no text;
  v_pb public.purchase_bills;
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
  v_base_unit_cost numeric(15,2);
  v_pur_ledger public.party_ledger_entries;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('purchases');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to post purchases.';
  END IF;

  v_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), ''), 'cash');
  IF v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode.';
  END IF;
  v_pay_ref := NULLIF(trim(COALESCE(p_payment_reference, '')), '');

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('purchase_issue:' || v_idemp));
    SELECT * INTO v_existing FROM public.purchase_bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  IF p_attachment_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_attachment_file_id) THEN
    RAISE EXCEPTION 'Attached file not found.';
  END IF;

  v_bill_date := COALESCE(p_bill_date, CURRENT_DATE);
  IF p_party_id IS NOT NULL THEN
    SELECT credit_days INTO v_party_credit_days FROM public.parties WHERE id = p_party_id;
    v_due_date := COALESCE(p_due_date, CASE WHEN COALESCE(v_party_credit_days, 0) > 0 THEN v_bill_date + v_party_credit_days ELSE NULL END);
  ELSE
    v_due_date := p_due_date;
  END IF;

  v_prep := public._prepare_purchase_payload(p_party_id, p_place_of_supply, p_gst_applied, p_freight_charges, p_auto_round_off, p_lines);
  v_calc := v_prep->'calc';
  v_grand := (v_calc->>'grand_total')::numeric(15,2);
  v_paid := round(COALESCE(p_paid_amount, 0)::numeric, 2);

  IF v_paid < 0 THEN RAISE EXCEPTION 'Paid amount cannot be negative.'; END IF;
  IF v_paid > v_grand THEN RAISE EXCEPTION 'Paid amount exceeds purchase grand total.'; END IF;
  IF p_party_id IS NULL AND v_paid < v_grand THEN RAISE EXCEPTION 'Walk-in cash purchases must be paid in full.'; END IF;
  IF p_party_id IS NOT NULL AND v_paid > 0 AND v_role = 'storekeeper' THEN
    RAISE EXCEPTION 'Storekeeper cannot post payment cashouts. Set Paid Now to ₹0.';
  END IF;

  v_balance := round((v_grand - v_paid)::numeric, 2);
  v_pur_no := public.next_document_number('purchase_bill', v_bill_date);

  PERFORM set_config('app.purchase_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.purchase_line_init', txid_current()::text, true);

  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.purchase_bills WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase draft not found.'; END IF;
    IF v_existing.status <> 'draft' THEN RAISE EXCEPTION 'This purchase bill has already been posted.'; END IF;
    DELETE FROM public.purchase_lines WHERE purchase_id = p_draft_id;
    UPDATE public.purchase_bills
    SET
      purchase_number = v_pur_no, doc_type = 'purchase_bill', status = 'posted',
      party_id = p_party_id, party_name = v_prep->>'party_name', party_phone = v_prep->>'party_phone',
      party_gstin = v_prep->>'party_gstin', party_address = v_prep->>'party_address',
      supplier_invoice_no = NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''),
      supplier_invoice_date = p_supplier_invoice_date,
      bill_date = v_bill_date, due_date = v_due_date,
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_prep->>'is_interstate')::boolean, gst_applied = (v_prep->>'effective_gst')::boolean,
      subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric, discount_total = (v_calc->>'discount_total')::numeric,
      cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
      igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
      freight_charges = (v_calc->>'extra_charges')::numeric, auto_round_off = COALESCE(p_auto_round_off, true),
      round_off = (v_calc->>'round_off')::numeric, grand_total = v_grand, paid_amount = v_paid,
      credited_amount = 0, balance_due = v_balance, payment_mode = v_mode, payment_reference = v_pay_ref,
      attachment_file_id = p_attachment_file_id, update_item_cost = COALESCE(p_update_item_cost, false),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''), idempotency_key = v_idemp,
      posted_at = now(), posted_by = auth.uid()
    WHERE id = p_draft_id RETURNING * INTO v_pb;
  ELSE
    INSERT INTO public.purchase_bills (
      purchase_number, doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      supplier_invoice_no, supplier_invoice_date, bill_date, due_date,
      place_of_supply_state_code, is_interstate, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total,
      tax_total, freight_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due, payment_mode, payment_reference,
      attachment_file_id, update_item_cost, notes, idempotency_key, posted_at, posted_by, created_by
    )
    VALUES (
      v_pur_no, 'purchase_bill', 'posted', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address',
      NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''), p_supplier_invoice_date,
      v_bill_date, v_due_date, v_prep->>'place_of_supply_state_code', (v_prep->>'is_interstate')::boolean,
      (v_prep->>'effective_gst')::boolean, (v_calc->>'subtotal_taxable')::numeric,
      (v_calc->>'discount_total')::numeric, (v_calc->>'cgst_total')::numeric,
      (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
      (v_calc->>'tax_total')::numeric, (v_calc->>'extra_charges')::numeric,
      COALESCE(p_auto_round_off, true), (v_calc->>'round_off')::numeric, v_grand,
      v_paid, 0, v_balance, v_mode, v_pay_ref, p_attachment_file_id, COALESCE(p_update_item_cost, false),
      NULLIF(trim(COALESCE(p_notes, '')), ''), v_idemp, now(), auth.uid(), auth.uid()
    )
    RETURNING * INTO v_pb;
  END IF;

  IF p_attachment_file_id IS NOT NULL THEN
    INSERT INTO public.file_links (file_id, entity_type, entity_id)
    VALUES (p_attachment_file_id, 'purchase_bill', v_pb.id) ON CONFLICT DO NOTHING;
  END IF;

  FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1)
  LOOP
    v_pl := (v_prep->'prepared_lines')->v_i;
    v_cl := (v_calc->'lines')->v_i;

    v_base_unit_cost := CASE
      WHEN (v_pl->>'base_qty')::numeric > 0
        THEN round(((v_cl->>'taxable_amount')::numeric / (v_pl->>'base_qty')::numeric), 2)
      ELSE 0
    END;

    INSERT INTO public.purchase_lines (
      purchase_id, line_no, item_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_pb.id, v_i + 1, (v_pl->>'item_id')::uuid, v_pl->>'item_name',
      NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'unit_cost')::numeric,
      (v_pl->>'discount_pct')::numeric, (v_pl->>'tax_inclusive')::boolean,
      (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'mrp', '')::numeric,
      COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );

    IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, 'purchase', v_bill_date,
        (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric, (v_pl->>'base_qty')::numeric,
        v_base_unit_cost,
        'Purchase ' || v_pb.purchase_number || COALESCE(' (' || NULLIF(v_pb.supplier_invoice_no, '') || ')', ''),
        v_pb.purchase_number, 'purchase_bills', v_pb.id, auth.uid()
      );
    END IF;

    IF COALESCE(p_update_item_cost, false) AND v_base_unit_cost > 0 THEN
      UPDATE public.items SET purchase_price = v_base_unit_cost WHERE id = (v_pl->>'item_id')::uuid;
    END IF;
  END LOOP;

  PERFORM set_config('app.purchase_line_init', '', true);

  IF p_party_id IS NOT NULL AND public.is_module_enabled('parties') AND v_grand > 0 THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, due_date, reference_no,
      source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      p_party_id, 'purchase', v_bill_date, v_due_date, v_pb.purchase_number,
      'purchase_bills', v_pb.id, -v_grand,
      'Purchase Bill ' || v_pb.purchase_number || COALESCE(' · Inv ' || NULLIF(v_pb.supplier_invoice_no, ''), ''),
      auth.uid()
    )
    RETURNING * INTO v_pur_ledger;

    IF v_paid > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        p_party_id, 'give', v_paid, v_mode, v_bill_date,
        COALESCE(v_pay_ref, v_pb.purchase_number), 'Payment for Purchase ' || v_pb.purchase_number,
        jsonb_build_array(jsonb_build_object('ledger_entry_id', v_pur_ledger.id, 'amount', v_paid)),
        false, CASE WHEN v_idemp IS NOT NULL THEN 'pur_pay:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.purchase_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'purchase.posted', 'purchase_bill', v_pb.id::text,
    jsonb_build_object('purchase_number', v_pb.purchase_number, 'grand_total', v_pb.grand_total)
  );

  SELECT * INTO v_pb FROM public.purchase_bills WHERE id = v_pb.id;
  RETURN v_pb;
END;
$$;

-- import_parties_batch (without price_tier)
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
              notes = COALESCE(NULLIF(trim(COALESCE(v_row->>'notes', '')), ''), notes),
              version = version + 1
          WHERE id = v_existing_id;
          v_updated := v_updated + 1;
          CONTINUE;
        END IF;
      END IF;

      INSERT INTO public.parties (
        name, party_type, phone, email, gstin, opening_balance, opening_balance_type,
        opening_balance_date, credit_limit, credit_days, notes, created_by
      )
      VALUES (
        v_name, v_ptype, v_phone, v_email, v_gstin, v_ob, v_ob_type, CURRENT_DATE,
        v_credit_limit, v_credit_days, NULLIF(trim(COALESCE(v_row->>'notes', '')), ''), auth.uid()
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

-- import_items_batch (without salt, schedule, warranty_months)
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
      IF NULLIF(v_row->>'sqft_per_box', '') IS NOT NULL THEN
        v_pack_meta := v_pack_meta || jsonb_build_object('sqft_per_box', (v_row->>'sqft_per_box')::numeric);
      END IF;

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

-- DecorBiz Demo Data Seeder & Cleaner
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

  DELETE FROM public.hardware_estimates WHERE is_demo = true;
  DELETE FROM public.bill_lines WHERE bill_id IN (SELECT id FROM public.bills WHERE is_demo = true);
  DELETE FROM public.purchase_lines WHERE purchase_id IN (SELECT id FROM public.purchase_bills WHERE is_demo = true);
  DELETE FROM public.payment_allocations WHERE payment_id IN (SELECT id FROM public.payments WHERE is_demo = true);
  DELETE FROM public.party_ledger_entries WHERE is_demo = true OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true);
  DELETE FROM public.payments WHERE is_demo = true;
  DELETE FROM public.stock_ledger WHERE is_demo = true OR item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.bills WHERE is_demo = true; GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted + v_n;
  DELETE FROM public.purchase_bills WHERE is_demo = true;
  DELETE FROM public.expenses WHERE is_demo = true;
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

  RETURN jsonb_build_object('removed', v_deleted);
END;
$$;

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

  INSERT INTO public.items (name, sku, category_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, low_stock_alert, pack_metadata, is_demo, created_by)
  VALUES
    ('Kajaria Vitrified Tile 2x2 Box', 'DB-TILE-2X2', v_cat_id, v_box_id, 680, 750, 510, 18, '6907', 20, '{"sqft_per_box":16,"category_type":"tiles"}'::jsonb, true, auth.uid()),
    ('Jaquar Basin Mixer Chrome', 'DB-CP-01', v_cat_id, v_pcs_id, 3450, 3990, 2650, 18, '8481', 5, '{"category_type":"faucets"}'::jsonb, true, auth.uid());

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

  RETURN jsonb_build_object('pack', 'decorbiz', 'demo_items_seeded', 2, 'party_ids', jsonb_build_array(v_party1, v_party2));
END;
$$;

-- Updated Backup Export, Reset, and Restore (without dropped pack tables/columns)
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
    'stock_ledger', COALESCE((SELECT jsonb_agg(to_jsonb(sl) ORDER BY sl.created_at) FROM public.stock_ledger sl), '[]'::jsonb),
    'bills', COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.created_at) FROM public.bills bl), '[]'::jsonb),
    'bill_lines', COALESCE((SELECT jsonb_agg(to_jsonb(bll) ORDER BY bll.bill_id, bll.line_no) FROM public.bill_lines bll), '[]'::jsonb),
    'hardware_estimates', COALESCE((SELECT jsonb_agg(to_jsonb(he) ORDER BY he.created_at) FROM public.hardware_estimates he), '[]'::jsonb),
    'purchase_bills', COALESCE((SELECT jsonb_agg(to_jsonb(pb) ORDER BY pb.created_at) FROM public.purchase_bills pb), '[]'::jsonb),
    'purchase_lines', COALESCE((SELECT jsonb_agg(to_jsonb(pl) ORDER BY pl.purchase_id, pl.line_no) FROM public.purchase_lines pl), '[]'::jsonb),
    'expense_categories', COALESCE((SELECT jsonb_agg(to_jsonb(ec) ORDER BY ec.code) FROM public.expense_categories ec), '[]'::jsonb),
    'expenses', COALESCE((SELECT jsonb_agg(to_jsonb(ex) ORDER BY ex.created_at) FROM public.expenses ex), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(pm) ORDER BY pm.created_at) FROM public.payments pm), '[]'::jsonb),
    'party_ledger_entries', COALESCE((SELECT jsonb_agg(to_jsonb(le) ORDER BY le.created_at) FROM public.party_ledger_entries le), '[]'::jsonb),
    'payment_allocations', COALESCE((SELECT jsonb_agg(to_jsonb(al) ORDER BY al.created_at) FROM public.payment_allocations al), '[]'::jsonb),
    'account_groups', COALESCE((SELECT jsonb_agg(to_jsonb(ag) ORDER BY ag.code) FROM public.account_groups ag), '[]'::jsonb),
    'ledgers', COALESCE((SELECT jsonb_agg(to_jsonb(lg) ORDER BY lg.code) FROM public.ledgers lg), '[]'::jsonb),
    'vouchers', COALESCE((SELECT jsonb_agg(to_jsonb(vc) ORDER BY vc.voucher_date, vc.created_at) FROM public.vouchers vc), '[]'::jsonb),
    'voucher_entries', COALESCE((SELECT jsonb_agg(to_jsonb(ve) ORDER BY ve.voucher_id, ve.created_at) FROM public.voucher_entries ve), '[]'::jsonb),
    'locations', COALESCE((SELECT jsonb_agg(to_jsonb(lc) ORDER BY lc.code) FROM public.locations lc), '[]'::jsonb),
    'sales_orders', COALESCE((SELECT jsonb_agg(to_jsonb(so) ORDER BY so.created_at) FROM public.sales_orders so), '[]'::jsonb),
    'tds_entries', COALESCE((SELECT jsonb_agg(to_jsonb(td) ORDER BY td.created_at) FROM public.tds_entries td), '[]'::jsonb),
    'cheque_register', COALESCE((SELECT jsonb_agg(to_jsonb(cq) ORDER BY cq.created_at) FROM public.cheque_register cq), '[]'::jsonb)
  );

  v_counts := jsonb_build_object(
    'parties', jsonb_array_length(v_data->'parties'),
    'items', jsonb_array_length(v_data->'items'),
    'bills', jsonb_array_length(v_data->'bills'),
    'purchase_bills', jsonb_array_length(v_data->'purchase_bills'),
    'expenses', jsonb_array_length(v_data->'expenses'),
    'payments', jsonb_array_length(v_data->'payments'),
    'vouchers', jsonb_array_length(v_data->'vouchers')
  );

  UPDATE public.business SET last_backup_at = now() WHERE id = 1;
  UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:backup_overdue';
  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.backup_records (
    backup_type, schema_version, size_bytes, record_counts, destination, drive_file_id, include_files, created_by
  ) VALUES (
    v_type, 'p7-v1', length(v_data::text)::bigint, v_counts, v_dest, p_drive_file_id, COALESCE(p_include_files, false), auth.uid()
  );

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'backup.exported', 'backup', v_dest,
    jsonb_build_object('schema_version', 'p7-v1', 'include_files', COALESCE(p_include_files, false), 'counts', v_counts)
  );

  v_snapshot := jsonb_build_object(
    'app', 'DecorBiz',
    'schema_version', 'p7-v1',
    'exported_at', now(),
    'exported_by', v_actor_email,
    'include_files', COALESCE(p_include_files, false),
    'record_counts', v_counts,
    'data', v_data
  );

  RETURN v_snapshot;
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

  DELETE FROM public.bank_reconciliations;
  DELETE FROM public.voucher_entries;
  DELETE FROM public.vouchers;
  DELETE FROM public.einvoice_records;
  DELETE FROM public.gstr2b_entries;
  DELETE FROM public.tds_entries;
  DELETE FROM public.stock_transfers;
  DELETE FROM public.physical_stock_counts;
  DELETE FROM public.location_stock_balances;
  DELETE FROM public.pos_held_bills;
  DELETE FROM public.pos_cash_registers;
  DELETE FROM public.sales_orders;
  DELETE FROM public.recurring_rules;
  DELETE FROM public.leads;
  DELETE FROM public.cheque_register;
  DELETE FROM public.message_logs;
  DELETE FROM public.ai_action_proposals;
  DELETE FROM public.ai_messages;
  DELETE FROM public.ai_conversations;
  DELETE FROM public.file_links;
  DELETE FROM public.bill_share_links;
  DELETE FROM public.hardware_estimates;
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
  IF v_schema NOT IN ('p5-v1', 'p6-v1', 'p7-v1') THEN
    RAISE EXCEPTION 'Unsupported backup schema version (%). Expected p5-v1, p6-v1, or p7-v1.', COALESCE(NULLIF(v_schema, ''), 'none');
  END IF;

  v_data := p_snapshot->'data';
  IF v_data IS NULL OR jsonb_typeof(v_data) <> 'object' OR v_data->'business' IS NULL THEN
    RAISE EXCEPTION 'Invalid backup file: data payload or business settings is missing.';
  END IF;

  PERFORM set_config('app.restore_context', txid_current()::text, true);

  DELETE FROM public.bank_reconciliations;
  DELETE FROM public.voucher_entries;
  DELETE FROM public.vouchers;
  DELETE FROM public.einvoice_records;
  DELETE FROM public.gstr2b_entries;
  DELETE FROM public.tds_entries;
  DELETE FROM public.stock_transfers;
  DELETE FROM public.physical_stock_counts;
  DELETE FROM public.location_stock_balances;
  DELETE FROM public.pos_held_bills;
  DELETE FROM public.pos_cash_registers;
  DELETE FROM public.sales_orders;
  DELETE FROM public.recurring_rules;
  DELETE FROM public.leads;
  DELETE FROM public.cheque_register;
  DELETE FROM public.file_links;
  DELETE FROM public.bill_share_links;
  DELETE FROM public.hardware_estimates;
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
    pack = 'decorbiz',
    gst_registered = COALESCE((v_biz->>'gst_registered')::boolean, gst_registered),
    gstin = NULLIF(v_biz->>'gstin', ''),
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
      IF (v_rec->>'module_key') NOT IN ('batch_expiry', 'variants') THEN
        INSERT INTO public.modules_state (module_key, enabled)
        VALUES (v_rec->>'module_key', COALESCE((v_rec->>'enabled')::boolean, false))
        ON CONFLICT (module_key) DO UPDATE SET enabled = EXCLUDED.enabled;
      END IF;
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
    INSERT INTO public.parties (id, name, party_type, phone, email, gstin, opening_balance, opening_balance_type, opening_balance_date, credit_limit, credit_days, notes, is_active, is_demo, version, created_by, created_at, updated_at)
    SELECT r.id, r.name, r.party_type, r.phone, r.email, r.gstin, r.opening_balance, r.opening_balance_type, r.opening_balance_date, r.credit_limit, r.credit_days, r.notes, r.is_active, r.is_demo, r.version, auth.uid(), r.created_at, r.updated_at
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
    INSERT INTO public.items (id, name, sku, barcode, category_id, brand_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, tax_inclusive, low_stock_alert, allow_negative_stock, primary_image_file_id, pack_metadata, notes, is_active, is_demo, version, item_type, created_by, created_at, updated_at)
    SELECT r.id, r.name, r.sku, r.barcode, r.category_id, r.brand_id, r.base_unit_id, r.selling_price, r.mrp, r.purchase_price, r.gst_rate, r.hsn_code, r.tax_inclusive, r.low_stock_alert, r.allow_negative_stock,
      CASE WHEN r.primary_image_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.primary_image_file_id) THEN r.primary_image_file_id ELSE NULL END,
      r.pack_metadata, r.notes, r.is_active, r.is_demo, r.version, COALESCE(r.item_type, 'goods'), auth.uid(), r.created_at, r.updated_at
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

  IF jsonb_typeof(v_data->'expense_categories') = 'array' AND jsonb_array_length(v_data->'expense_categories') > 0 THEN
    INSERT INTO public.expense_categories (id, code, name_en, name_hi, is_system, is_active, created_at)
    SELECT r.id, r.code, r.name_en, r.name_hi, r.is_system, r.is_active, r.created_at
    FROM jsonb_populate_recordset(NULL::public.expense_categories, v_data->'expense_categories') r ON CONFLICT (id) DO NOTHING;
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

  IF jsonb_typeof(v_data->'bills') = 'array' AND jsonb_array_length(v_data->'bills') > 0 THEN
    INSERT INTO public.bills (
      id, bill_number, doc_type, status, source_bill_id, converted_from_quotation_id, converted_to_bill_id,
      party_id, party_name, party_phone, party_gstin, party_address, place_of_supply_state_code, is_interstate,
      bill_date, due_date, valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total, paid_amount, credited_amount,
      balance_due, notes, terms, business_snapshot, void_reason, voided_at, voided_by, return_reason,
      idempotency_key, issued_at, issued_by, is_demo, created_by, created_at, updated_at, payment_mode, payment_reference,
      site_id, site_name
    )
    SELECT
      r.id, r.bill_number, r.doc_type, r.status, r.source_bill_id, NULL, NULL,
      r.party_id, r.party_name, r.party_phone, r.party_gstin, r.party_address, r.place_of_supply_state_code, r.is_interstate,
      r.bill_date, r.due_date, r.valid_until, r.gst_applied, r.subtotal_taxable, r.discount_total, r.cgst_total, r.sgst_total,
      r.igst_total, r.tax_total, r.extra_charges, r.auto_round_off, r.round_off, r.grand_total, r.paid_amount, r.credited_amount,
      r.balance_due, r.notes, r.terms, r.business_snapshot, r.void_reason, r.voided_at, auth.uid(), r.return_reason,
      r.idempotency_key, r.issued_at, auth.uid(), r.is_demo, auth.uid(), r.created_at, r.updated_at, COALESCE(r.payment_mode, 'cash'), r.payment_reference,
      r.site_id, r.site_name
    FROM jsonb_populate_recordset(NULL::public.bills, v_data->'bills') r
    ORDER BY (r.source_bill_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'bill_lines') = 'array' AND jsonb_array_length(v_data->'bill_lines') > 0 THEN
    INSERT INTO public.bill_lines (
      id, bill_id, line_no, item_id, source_bill_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta, created_at
    )
    SELECT
      r.id, r.bill_id, r.line_no, r.item_id, r.source_bill_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.catalog_unit_price, r.unit_price, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.mrp, COALESCE(r.line_meta, '{}'::jsonb), r.created_at
    FROM jsonb_populate_recordset(NULL::public.bill_lines, v_data->'bill_lines') r
    ORDER BY (r.source_bill_line_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'purchase_lines') = 'array' AND jsonb_array_length(v_data->'purchase_lines') > 0 THEN
    INSERT INTO public.purchase_lines (
      id, purchase_id, line_no, item_id, source_purchase_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta, created_at
    )
    SELECT
      r.id, r.purchase_id, r.line_no, r.item_id, r.source_purchase_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.unit_cost, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.mrp, COALESCE(r.line_meta, '{}'::jsonb), r.created_at
    FROM jsonb_populate_recordset(NULL::public.purchase_lines, v_data->'purchase_lines') r
    ORDER BY (r.source_purchase_line_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'expenses') = 'array' AND jsonb_array_length(v_data->'expenses') > 0 THEN
    INSERT INTO public.expenses (id, expense_number, category_id, expense_date, amount, payment_mode, reference_no, paid_to, notes, attachment_file_id, status, void_reason, voided_at, voided_by, idempotency_key, is_demo, created_by, created_at, updated_at)
    SELECT r.id, r.expense_number, r.category_id, r.expense_date, r.amount, r.payment_mode, r.reference_no, r.paid_to, r.notes,
      CASE WHEN r.attachment_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.attachment_file_id) THEN r.attachment_file_id ELSE NULL END,
      r.status, r.void_reason, r.voided_at, auth.uid(), r.idempotency_key, r.is_demo, auth.uid(), r.created_at, r.updated_at
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
  END IF;

  IF jsonb_typeof(v_data->'payment_allocations') = 'array' AND jsonb_array_length(v_data->'payment_allocations') > 0 THEN
    INSERT INTO public.payment_allocations (id, payment_id, party_id, target_type, ledger_entry_id, target_label, allocated_amount, is_reversed, created_at)
    SELECT r.id, r.payment_id, r.party_id, r.target_type, r.ledger_entry_id, r.target_label, r.allocated_amount, r.is_reversed, r.created_at
    FROM jsonb_populate_recordset(NULL::public.payment_allocations, v_data->'payment_allocations') r;
  END IF;

  IF jsonb_typeof(v_data->'stock_ledger') = 'array' AND jsonb_array_length(v_data->'stock_ledger') > 0 THEN
    INSERT INTO public.stock_ledger (id, item_id, movement_type, movement_date, entered_qty, entered_unit_id, conversion_factor, signed_base_qty, unit_cost, reason, reference_no, source_table, source_id, idempotency_key, pack_meta, is_demo, created_by, created_at)
    SELECT r.id, r.item_id, r.movement_type, r.movement_date, r.entered_qty, r.entered_unit_id, r.conversion_factor, r.signed_base_qty, r.unit_cost, r.reason, r.reference_no, r.source_table, r.source_id, r.idempotency_key, r.pack_meta, r.is_demo, auth.uid(), r.created_at
    FROM jsonb_populate_recordset(NULL::public.stock_ledger, v_data->'stock_ledger') r
    ORDER BY r.movement_date ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'ledgers') = 'array' AND jsonb_array_length(v_data->'ledgers') > 0 THEN
    INSERT INTO public.ledgers (id, code, name, group_id, opening_balance, opening_side, is_bank, bank_account_no, ifsc_code, is_system, is_active, created_at, updated_at)
    SELECT r.id, r.code, r.name, r.group_id, r.opening_balance, r.opening_side, r.is_bank, r.bank_account_no, r.ifsc_code, r.is_system, r.is_active, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.ledgers, v_data->'ledgers') r
    ON CONFLICT (code) DO UPDATE SET opening_balance = EXCLUDED.opening_balance, opening_side = EXCLUDED.opening_side;
  END IF;

  IF jsonb_typeof(v_data->'vouchers') = 'array' AND jsonb_array_length(v_data->'vouchers') > 0 THEN
    INSERT INTO public.vouchers (id, voucher_number, voucher_type, voucher_date, narration, status, cost_centre_id, source_table, source_id, total_debit, total_credit, void_reason, voided_at, voided_by, created_by, created_at, updated_at)
    SELECT r.id, r.voucher_number, r.voucher_type, r.voucher_date, r.narration, r.status, r.cost_centre_id, r.source_table, r.source_id, r.total_debit, r.total_credit, r.void_reason, r.voided_at, auth.uid(), auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.vouchers, v_data->'vouchers') r;
  END IF;

  IF jsonb_typeof(v_data->'voucher_entries') = 'array' AND jsonb_array_length(v_data->'voucher_entries') > 0 THEN
    INSERT INTO public.voucher_entries (id, voucher_id, ledger_id, entry_side, amount, line_narration, created_at)
    SELECT r.id, r.voucher_id, r.ledger_id, r.entry_side, r.amount, r.line_narration, r.created_at
    FROM jsonb_populate_recordset(NULL::public.voucher_entries, v_data->'voucher_entries') r;
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
    'vouchers', (SELECT count(*)::integer FROM public.vouchers)
  );

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.backup_records (
    backup_type, schema_version, checksum, size_bytes, record_counts, destination, drive_file_id, created_by
  ) VALUES (
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

CREATE OR REPLACE FUNCTION public.get_drive_status_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.drive_connections;
BEGIN
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Insufficient permissions.';
  END IF;
  SELECT * INTO v_row FROM public.drive_connections WHERE id = 1;
  RETURN jsonb_build_object(
    'connected', (v_row.refresh_token_enc IS NOT NULL AND v_row.last_sync_status <> 'disconnected'),
    'connected_email', v_row.connected_email,
    'folder_name', COALESCE(v_row.folder_name, 'DecorBiz Backups'),
    'folder_id', v_row.folder_id,
    'schedule_enabled', COALESCE(v_row.schedule_enabled, false),
    'schedule_frequency', COALESCE(v_row.schedule_frequency, 'daily'),
    'retention_count', COALESCE(v_row.retention_count, 10),
    'last_sync_at', v_row.last_sync_at,
    'last_sync_status', COALESCE(v_row.last_sync_status, 'never'),
    'last_error', v_row.last_error
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_system_notifications()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_low_count integer := 0;
  v_out_count integer := 0;
  v_overdue_count integer := 0;
  v_overdue_amt numeric(15,2) := 0;
  v_last_backup timestamptz;
  v_days_since_backup integer := 999;
  v_list jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_active_staff() THEN RAISE EXCEPTION 'Active staff access required.'; END IF;
  v_role := public.current_user_role();

  IF public.is_module_enabled('inventory') THEN
    SELECT count(*) FILTER (WHERE is_active = true AND is_low_stock = true)::integer,
           count(*) FILTER (WHERE is_active = true AND is_out_of_stock = true)::integer
    INTO v_low_count, v_out_count FROM public.item_catalog_view;

    IF v_low_count > 0 OR v_out_count > 0 THEN
      INSERT INTO public.notifications (rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi, target_tab, min_roles, is_resolved)
      VALUES (
        'low_stock', 'system:low_stock', CASE WHEN v_out_count > 0 THEN 'critical' ELSE 'warning' END,
        v_low_count || ' low-stock & ' || v_out_count || ' out-of-stock item(s)',
        v_low_count || ' कम स्टॉक और ' || v_out_count || ' स्टॉक खत्म आइटम',
        'Review stock levels and create supplier purchases or stock adjustments.',
        'स्टॉक स्तर की समीक्षा करें और सप्लायर खरीद या स्टॉक समायोजन दर्ज करें।',
        'items', ARRAY['owner', 'manager', 'storekeeper'], false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, title_en = EXCLUDED.title_en, title_hi = EXCLUDED.title_hi, is_resolved = false, updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:low_stock';
    END IF;
  END IF;

  IF public.is_module_enabled('parties') THEN
    SELECT count(*) FILTER (WHERE is_active = true AND is_overdue = true)::integer,
           COALESCE(SUM(overdue_receivable) FILTER (WHERE is_active = true), 0)::numeric(15,2)
    INTO v_overdue_count, v_overdue_amt FROM public.party_balances;

    IF v_overdue_count > 0 THEN
      INSERT INTO public.notifications (rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi, target_tab, min_roles, is_resolved)
      VALUES (
        'overdue_khata', 'system:overdue_khata', 'warning',
        v_overdue_count || ' party account(s) have overdue Khata balances',
        v_overdue_count || ' पार्टियों का खाता बकाया समय सीमा पार है',
        'Total overdue receivables: ₹' || v_overdue_amt || '. Send payment reminders from Parties.',
        'कुल बकाया वसूली: ₹' || v_overdue_amt || '। पार्टी स्क्रीन से रिमाइंडर भेजें।',
        'parties', ARRAY['owner', 'manager', 'accountant'], false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET title_en = EXCLUDED.title_en, title_hi = EXCLUDED.title_hi, body_en = EXCLUDED.body_en, body_hi = EXCLUDED.body_hi, is_resolved = false, updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:overdue_khata';
    END IF;
  END IF;

  IF public.is_module_enabled('backup') THEN
    SELECT last_backup_at INTO v_last_backup FROM public.business WHERE id = 1;
    v_days_since_backup := CASE WHEN v_last_backup IS NULL THEN 999 ELSE GREATEST(0, floor(extract(epoch FROM (now() - v_last_backup)) / 86400)::integer) END;

    IF v_last_backup IS NULL OR v_days_since_backup >= 7 THEN
      INSERT INTO public.notifications (rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi, target_tab, min_roles, is_resolved)
      VALUES (
        'backup_overdue', 'system:backup_overdue', CASE WHEN v_last_backup IS NULL THEN 'warning' ELSE 'critical' END,
        CASE WHEN v_last_backup IS NULL THEN 'No local backup downloaded yet' ELSE 'Last backup was ' || v_days_since_backup || ' days ago' END,
        CASE WHEN v_last_backup IS NULL THEN 'अभी तक कोई लोकल बैकअप नहीं लिया गया है' ELSE 'अंतिम बैकअप ' || v_days_since_backup || ' दिन पहले लिया गया था' END,
        'Download an updated workspace backup from Settings -> Backup & Storage.',
        'सेटिंग्स -> बैकअप और स्टोरेज से नवीनतम बैकअप डाउनलोड करें।',
        'settings', ARRAY['owner', 'manager', 'accountant'], false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, title_en = EXCLUDED.title_en, title_hi = EXCLUDED.title_hi, is_resolved = false, updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:backup_overdue';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(n) ORDER BY n.is_read ASC, n.created_at DESC), '[]'::jsonb)
  INTO v_list
  FROM (
    SELECT id, rule_key, severity, title_en, title_hi, body_en, body_hi, target_tab, target_id, is_read, created_at
    FROM public.notifications WHERE is_resolved = false AND v_role = ANY(min_roles)
    ORDER BY is_read ASC, created_at DESC LIMIT 25
  ) n;

  RETURN jsonb_build_object(
    'unread_count', (SELECT count(*)::integer FROM public.notifications WHERE is_resolved = false AND is_read = false AND v_role = ANY(min_roles)),
    'notifications', v_list
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_module(p_key text, p_enabled boolean)
RETURNS public.modules_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.modules_state;
  v_email text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only an Owner can switch modules.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = p_key) THEN
    RAISE EXCEPTION 'Unknown module key: %', p_key;
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();

  IF p_enabled = false THEN
    IF p_key = 'billing' THEN
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'accounting' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Advanced Accounting before disabling Billing.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'einvoice' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable E-Invoice before disabling Billing.';
      END IF;
    END IF;
    IF p_key = 'tax' AND EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'einvoice' AND enabled = true) THEN
      RAISE EXCEPTION 'Disable E-Invoice before disabling GST & Tax.';
    END IF;
    IF p_key = 'parties' THEN
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'payments' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Payments before disabling Parties & Khata.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'purchases' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Purchases before disabling Parties & Khata.';
      END IF;
    END IF;
    IF p_key = 'inventory' THEN
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'purchases' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Purchases before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'locations' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Multiple Locations before disabling Items & Stock.';
      END IF;
    END IF;
  END IF;

  IF p_enabled = true THEN
    IF p_key = 'purchases' AND (
      NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'inventory' AND enabled = true)
      OR NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'parties' AND enabled = true)
    ) THEN
      RAISE EXCEPTION 'Enable Items & Stock and Parties & Khata before enabling Purchases.';
    END IF;
    IF p_key = 'payments' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'parties' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Parties & Khata before enabling Payments.';
    END IF;
    IF p_key = 'locations' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'inventory' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Items & Stock before enabling Multiple Locations.';
    END IF;
    IF p_key = 'accounting' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'billing' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Billing before enabling Advanced Accounting.';
    END IF;
    IF p_key = 'einvoice' AND (
      NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'tax' AND enabled = true)
      OR NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'billing' AND enabled = true)
    ) THEN
      RAISE EXCEPTION 'Enable GST & Tax and Billing before enabling E-Invoice.';
    END IF;
  END IF;

  UPDATE public.modules_state
  SET enabled = p_enabled, updated_by = auth.uid(), updated_at = now()
  WHERE module_key = p_key
  RETURNING * INTO v_row;

  UPDATE public.business
  SET onboarding_steps = jsonb_set(onboarding_steps, '{modules}', 'true'::jsonb)
  WHERE id = 1;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_email, 'module.toggled', 'module', p_key, jsonb_build_object('enabled', p_enabled));

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text,
  text, boolean, text, integer, text, integer, numeric, boolean,
  text, integer, text, integer, text, integer, jsonb
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_party(
  uuid, text, text, text, text, text, numeric, text, date, numeric, integer, text, jsonb, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_expense(uuid, uuid, date, numeric, text, text, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public._prepare_bill_payload(text, uuid, text, numeric, boolean, jsonb, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_bill_draft(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_bill(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, numeric, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_quotation_to_bill(uuid, text, date, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_estimate_to_quotation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_return(uuid, jsonb, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_bill(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public._prepare_purchase_payload(uuid, text, boolean, numeric, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_purchase_draft(uuid, uuid, text, date, date, date, text, boolean, numeric, boolean, boolean, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_purchase(uuid, uuid, text, date, date, date, text, boolean, numeric, boolean, boolean, text, uuid, jsonb, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_offline_bill_queue(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_parties_batch(jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_items_batch(jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_demo_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_demo_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.export_workspace_backup(text, boolean, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_workspace_data(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_workspace_backup(jsonb, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_drive_status_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_system_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_module(text, boolean) TO authenticated;
