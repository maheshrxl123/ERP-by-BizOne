-- DecorBiz Migration 0024:
-- 1. Fix issue_bill() taxable_amount insertion bug (was writing tax_amount instead of taxable_amount)
-- 2. Allow 'store_banner' in files.purpose check constraint
-- 3. Harden staff_totp (revoke direct client SELECT, add safe staff_totp_status view)
-- 4. Add 7 Step 2 optional toggled modules + tables + RLS + RPCs:
--    estimator, breakage_returns, samples, contractor_rate_cards, commissions,
--    supplier_price_lists, delivery_trips

-- ============================================================================
-- 1. Fix issue_bill() taxable_amount bug from 0021
-- ============================================================================
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
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
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

GRANT EXECUTE ON FUNCTION public.issue_bill(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, numeric, text, text, text, uuid) TO authenticated;

-- ============================================================================
-- 2. Allow 'store_banner' in files.purpose
-- ============================================================================
ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_purpose_check;
ALTER TABLE public.files ADD CONSTRAINT files_purpose_check
  CHECK (purpose IN ('avatar', 'business_logo', 'upi_qr', 'item_image', 'attachment', 'store_banner'));

-- ============================================================================
-- 3. Harden staff_totp: remove direct client SELECT of secrets/recovery hashes
-- ============================================================================
DROP POLICY IF EXISTS staff_totp_select ON public.staff_totp;
REVOKE ALL ON public.staff_totp FROM anon, authenticated;

CREATE OR REPLACE VIEW public.staff_totp_status AS
SELECT
  user_id,
  enabled,
  updated_at
FROM public.staff_totp
WHERE user_id = auth.uid()
   OR public.is_owner();

ALTER VIEW public.staff_totp_status SET (security_invoker = false);
REVOKE ALL ON public.staff_totp_status FROM anon;
GRANT SELECT ON public.staff_totp_status TO authenticated;

-- ============================================================================
-- 4. Step 2 Optional Toggled Modules + Toggle Dependencies
-- ============================================================================
INSERT INTO public.modules_state (module_key, enabled)
VALUES
  ('estimator', true),
  ('breakage_returns', false),
  ('samples', false),
  ('contractor_rate_cards', false),
  ('commissions', false),
  ('supplier_price_lists', false),
  ('delivery_trips', false)
ON CONFLICT (module_key) DO NOTHING;

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
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'pos' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable POS-Lite before disabling Billing.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'commissions' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Commissions before disabling Billing.';
      END IF;
    END IF;
    IF p_key = 'tax' THEN
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'einvoice' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable E-Invoice before disabling GST & Tax.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'gst_returns' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable GST Returns before disabling GST & Tax.';
      END IF;
    END IF;
    IF p_key = 'parties' THEN
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'payments' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Payments before disabling Parties & Khata.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'purchases' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Purchases before disabling Parties & Khata.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'contractor_rate_cards' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Contractor Rate Cards before disabling Parties & Khata.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'commissions' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Commissions before disabling Parties & Khata.';
      END IF;
    END IF;
    IF p_key = 'inventory' THEN
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'purchases' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Purchases before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'locations' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Godowns & Locations before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'online_store' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Online Store before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'breakage_returns' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Breakage Returns before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'samples' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Samples Tracking before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'contractor_rate_cards' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Contractor Rate Cards before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'supplier_price_lists' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Supplier Price Lists before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'delivery_trips' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Delivery Trips before disabling Items & Stock.';
      END IF;
    END IF;
    IF p_key = 'backup' THEN
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'google_drive_backup' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Google Drive Backup before disabling Local Backup.';
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
      RAISE EXCEPTION 'Enable Items & Stock before enabling Godowns & Locations.';
    END IF;
    IF p_key = 'online_store' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'inventory' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Items & Stock before enabling Online Store.';
    END IF;
    IF p_key = 'accounting' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'billing' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Billing before enabling Advanced Accounting.';
    END IF;
    IF p_key = 'pos' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'billing' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Billing before enabling POS-Lite.';
    END IF;
    IF p_key = 'gst_returns' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'tax' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable GST & Tax before enabling GST Returns.';
    END IF;
    IF p_key = 'einvoice' AND (
      NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'tax' AND enabled = true)
      OR NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'billing' AND enabled = true)
    ) THEN
      RAISE EXCEPTION 'Enable GST & Tax and Billing before enabling E-Invoice.';
    END IF;
    IF p_key = 'google_drive_backup' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'backup' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Local Backup before enabling Google Drive Backup.';
    END IF;
    IF p_key IN ('breakage_returns', 'samples', 'supplier_price_lists', 'delivery_trips')
       AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'inventory' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Items & Stock before enabling this module.';
    END IF;
    IF p_key = 'contractor_rate_cards' AND (
      NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'inventory' AND enabled = true)
      OR NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'parties' AND enabled = true)
    ) THEN
      RAISE EXCEPTION 'Enable Items & Stock and Parties & Khata before enabling Contractor Rate Cards.';
    END IF;
    IF p_key = 'commissions' AND (
      NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'billing' AND enabled = true)
      OR NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'parties' AND enabled = true)
    ) THEN
      RAISE EXCEPTION 'Enable Billing and Parties & Khata before enabling Commissions.';
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

GRANT EXECUTE ON FUNCTION public.toggle_module(text, boolean) TO authenticated;

-- ============================================================================
-- 5. Step 2 Optional Module Tables + RLS + Triggers + RPC
-- ============================================================================

-- 5a. Breakage Returns
CREATE TABLE IF NOT EXISTS public.breakage_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number text NOT NULL UNIQUE,
  bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES public.item_variants(id) ON DELETE SET NULL,
  shade text,
  batch_lot text,
  qty numeric(15,3) NOT NULL CHECK (qty > 0),
  unit_id uuid NOT NULL REFERENCES public.item_units(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(trim(reason)) >= 1),
  disposition text NOT NULL CHECK (disposition IN ('replace', 'credit', 'write_off')),
  credit_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_breakage_returns_updated_at ON public.breakage_returns;
CREATE TRIGGER trg_breakage_returns_updated_at
  BEFORE UPDATE ON public.breakage_returns
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.breakage_returns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breakage_returns_select ON public.breakage_returns;
CREATE POLICY breakage_returns_select ON public.breakage_returns
  FOR SELECT TO authenticated
  USING (public.is_module_enabled('breakage_returns') AND public.is_active_staff());

DROP POLICY IF EXISTS breakage_returns_write ON public.breakage_returns;
CREATE POLICY breakage_returns_write ON public.breakage_returns
  FOR ALL TO authenticated
  USING (public.is_module_enabled('breakage_returns') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper', 'cashier'))
  WITH CHECK (public.is_module_enabled('breakage_returns') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper', 'cashier'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.breakage_returns TO authenticated;

CREATE OR REPLACE FUNCTION public.record_breakage_return(
  p_item_id uuid,
  p_qty numeric,
  p_unit_id uuid DEFAULT NULL,
  p_reason text DEFAULT 'Transit breakage',
  p_disposition text DEFAULT 'write_off',
  p_credit_amount numeric DEFAULT 0,
  p_party_id uuid DEFAULT NULL,
  p_bill_id uuid DEFAULT NULL,
  p_variant_id uuid DEFAULT NULL,
  p_shade text DEFAULT NULL,
  p_batch_lot text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.breakage_returns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_item public.items;
  v_unit_id uuid;
  v_factor numeric(18,6) := 1;
  v_base_qty numeric(15,3);
  v_no text;
  v_row public.breakage_returns;
  v_email text;
BEGIN
  PERFORM public.require_module('breakage_returns');
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'cashier') THEN
    RAISE EXCEPTION 'You do not have permission to record breakage returns.';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Breakage quantity must be greater than zero.';
  END IF;
  IF p_disposition NOT IN ('replace', 'credit', 'write_off') THEN
    RAISE EXCEPTION 'Invalid breakage disposition: %', p_disposition;
  END IF;

  SELECT * INTO v_item FROM public.items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found.';
  END IF;

  v_unit_id := COALESCE(p_unit_id, v_item.base_unit_id);
  IF v_unit_id <> v_item.base_unit_id THEN
    SELECT conversion_factor INTO v_factor
    FROM public.unit_conversions
    WHERE item_id = p_item_id AND alternate_unit_id = v_unit_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unit conversion missing for selected unit.';
    END IF;
  END IF;
  v_base_qty := round((p_qty * v_factor)::numeric, 3);

  v_no := 'BRK-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || lpad((floor(random() * 9000 + 1000))::text, 4, '0');

  INSERT INTO public.breakage_returns (
    return_number, bill_id, party_id, item_id, variant_id, shade, batch_lot,
    qty, unit_id, reason, disposition, credit_amount, notes, created_by
  )
  VALUES (
    v_no, p_bill_id, p_party_id, p_item_id, p_variant_id,
    NULLIF(trim(COALESCE(p_shade, '')), ''), NULLIF(trim(COALESCE(p_batch_lot, '')), ''),
    p_qty, v_unit_id, trim(p_reason), p_disposition, COALESCE(p_credit_amount, 0),
    NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid()
  )
  RETURNING * INTO v_row;

  IF p_disposition IN ('replace', 'write_off') AND v_item.item_type = 'goods' THEN
    INSERT INTO public.stock_ledger (
      item_id, variant_id, shade, batch_lot, movement_type, movement_date,
      entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
      unit_cost, reason, reference_no, source_table, source_id, created_by
    )
    VALUES (
      p_item_id, p_variant_id,
      NULLIF(trim(COALESCE(p_shade, '')), ''), NULLIF(trim(COALESCE(p_batch_lot, '')), ''),
      'adjustment_out', CURRENT_DATE, p_qty, v_unit_id, v_factor, -v_base_qty,
      v_item.purchase_price,
      CASE WHEN p_disposition = 'replace' THEN 'Breakage replacement: ' ELSE 'Breakage write-off: ' END || trim(p_reason),
      v_no, 'breakage_returns', v_row.id, auth.uid()
    );
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_email, 'breakage_return.recorded', 'breakage_return', v_row.id::text,
    jsonb_build_object('return_number', v_no, 'item_id', p_item_id, 'qty', p_qty, 'disposition', p_disposition)
  );

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_breakage_return(uuid, numeric, uuid, text, text, numeric, uuid, uuid, uuid, text, text, text) TO authenticated;

-- 5b. Samples Tracking
CREATE TABLE IF NOT EXISTS public.sample_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_number text NOT NULL UNIQUE,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL CHECK (length(trim(party_name)) >= 1),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES public.item_variants(id) ON DELETE SET NULL,
  shade text,
  qty numeric(15,3) NOT NULL CHECK (qty > 0),
  unit_id uuid NOT NULL REFERENCES public.item_units(id) ON DELETE RESTRICT,
  issued_date date NOT NULL DEFAULT CURRENT_DATE,
  expected_return_date date,
  returned_date date,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'returned', 'kept', 'cancelled')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_sample_issues_updated_at ON public.sample_issues;
CREATE TRIGGER trg_sample_issues_updated_at
  BEFORE UPDATE ON public.sample_issues
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.sample_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sample_issues_select ON public.sample_issues;
CREATE POLICY sample_issues_select ON public.sample_issues
  FOR SELECT TO authenticated
  USING (public.is_module_enabled('samples') AND public.is_active_staff());

DROP POLICY IF EXISTS sample_issues_write ON public.sample_issues;
CREATE POLICY sample_issues_write ON public.sample_issues
  FOR ALL TO authenticated
  USING (public.is_module_enabled('samples') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper', 'cashier'))
  WITH CHECK (public.is_module_enabled('samples') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper', 'cashier'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sample_issues TO authenticated;

-- 5c. Contractor Rate Cards
CREATE TABLE IF NOT EXISTS public.contractor_rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES public.item_variants(id) ON DELETE CASCADE,
  agreed_rate numeric(15,2) NOT NULL CHECK (agreed_rate >= 0),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  min_qty numeric(15,3) NOT NULL DEFAULT 1 CHECK (min_qty >= 0),
  valid_until date,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contractor_rate_cards_unique
  ON public.contractor_rate_cards (party_id, item_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

DROP TRIGGER IF EXISTS trg_contractor_rate_cards_updated_at ON public.contractor_rate_cards;
CREATE TRIGGER trg_contractor_rate_cards_updated_at
  BEFORE UPDATE ON public.contractor_rate_cards
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.contractor_rate_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contractor_rate_cards_select ON public.contractor_rate_cards;
CREATE POLICY contractor_rate_cards_select ON public.contractor_rate_cards
  FOR SELECT TO authenticated
  USING (public.is_module_enabled('contractor_rate_cards') AND public.is_active_staff());

DROP POLICY IF EXISTS contractor_rate_cards_write ON public.contractor_rate_cards;
CREATE POLICY contractor_rate_cards_write ON public.contractor_rate_cards
  FOR ALL TO authenticated
  USING (public.is_module_enabled('contractor_rate_cards') AND public.current_user_role() IN ('owner', 'manager', 'cashier'))
  WITH CHECK (public.is_module_enabled('contractor_rate_cards') AND public.current_user_role() IN ('owner', 'manager', 'cashier'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_rate_cards TO authenticated;

-- 5d. Commissions
CREATE TABLE IF NOT EXISTS public.commission_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL CHECK (length(trim(party_name)) >= 1),
  bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  bill_number text,
  bill_date date NOT NULL DEFAULT CURRENT_DATE,
  base_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (base_amount >= 0),
  commission_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  commission_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
  paid_date date,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_commission_entries_updated_at ON public.commission_entries;
CREATE TRIGGER trg_commission_entries_updated_at
  BEFORE UPDATE ON public.commission_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.commission_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_entries_select ON public.commission_entries;
CREATE POLICY commission_entries_select ON public.commission_entries
  FOR SELECT TO authenticated
  USING (public.is_module_enabled('commissions') AND public.is_active_staff());

DROP POLICY IF EXISTS commission_entries_write ON public.commission_entries;
CREATE POLICY commission_entries_write ON public.commission_entries
  FOR ALL TO authenticated
  USING (public.is_module_enabled('commissions') AND public.current_user_role() IN ('owner', 'manager', 'accountant', 'cashier'))
  WITH CHECK (public.is_module_enabled('commissions') AND public.current_user_role() IN ('owner', 'manager', 'accountant', 'cashier'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.commission_entries TO authenticated;

-- 5e. Supplier Price Lists
CREATE TABLE IF NOT EXISTS public.supplier_price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  supplier_sku text,
  supplier_rate numeric(15,2) NOT NULL CHECK (supplier_rate >= 0),
  moq numeric(15,3) NOT NULL DEFAULT 1 CHECK (moq > 0),
  lead_time_days integer NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0),
  valid_until date,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_id, item_id)
);

DROP TRIGGER IF EXISTS trg_supplier_price_lists_updated_at ON public.supplier_price_lists;
CREATE TRIGGER trg_supplier_price_lists_updated_at
  BEFORE UPDATE ON public.supplier_price_lists
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.supplier_price_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_price_lists_select ON public.supplier_price_lists;
CREATE POLICY supplier_price_lists_select ON public.supplier_price_lists
  FOR SELECT TO authenticated
  USING (public.is_module_enabled('supplier_price_lists') AND public.is_active_staff());

DROP POLICY IF EXISTS supplier_price_lists_write ON public.supplier_price_lists;
CREATE POLICY supplier_price_lists_write ON public.supplier_price_lists
  FOR ALL TO authenticated
  USING (public.is_module_enabled('supplier_price_lists') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper'))
  WITH CHECK (public.is_module_enabled('supplier_price_lists') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_price_lists TO authenticated;

-- 5f. General ERP Delivery Trips (Showroom / Contractor Site Dispatches)
CREATE TABLE IF NOT EXISTS public.erp_delivery_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_number text NOT NULL UNIQUE,
  trip_date date NOT NULL DEFAULT CURRENT_DATE,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL CHECK (length(trim(party_name)) >= 1),
  site_id uuid REFERENCES public.party_sites(id) ON DELETE SET NULL,
  site_name text,
  bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  driver_name text NOT NULL CHECK (length(trim(driver_name)) >= 1),
  driver_phone text,
  vehicle_no text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'dispatched', 'delivered', 'cancelled')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_erp_delivery_trips_updated_at ON public.erp_delivery_trips;
CREATE TRIGGER trg_erp_delivery_trips_updated_at
  BEFORE UPDATE ON public.erp_delivery_trips
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.erp_delivery_trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erp_delivery_trips_select ON public.erp_delivery_trips;
CREATE POLICY erp_delivery_trips_select ON public.erp_delivery_trips
  FOR SELECT TO authenticated
  USING (public.is_module_enabled('delivery_trips') AND public.is_active_staff());

DROP POLICY IF EXISTS erp_delivery_trips_write ON public.erp_delivery_trips;
CREATE POLICY erp_delivery_trips_write ON public.erp_delivery_trips
  FOR ALL TO authenticated
  USING (public.is_module_enabled('delivery_trips') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper', 'cashier'))
  WITH CHECK (public.is_module_enabled('delivery_trips') AND public.current_user_role() IN ('owner', 'manager', 'storekeeper', 'cashier'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_delivery_trips TO authenticated;

-- ============================================================================
-- 6. Variant, Shade & Batch Lot Support in Purchase RPCs
-- ============================================================================
CREATE OR REPLACE FUNCTION public._prepare_purchase_payload(
  p_party_id uuid,
  p_place_of_supply text,
  p_gst_applied boolean,
  p_freight_charges numeric,
  p_auto_round_off boolean,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz public.business;
  v_party public.parties;
  v_pos text := NULL;
  v_party_addr text := NULL;
  v_is_interstate boolean := false;
  v_effective_gst boolean := false;
  v_raw jsonb;
  v_item public.items;
  v_var_id uuid;
  v_var public.item_variants;
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

    v_var_id := NULLIF(v_raw->>'variant_id', '')::uuid;
    v_var := NULL;
    IF v_var_id IS NOT NULL THEN
      SELECT * INTO v_var FROM public.item_variants WHERE id = v_var_id AND item_id = v_item.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Selected item variant is invalid.'; END IF;
    END IF;

    v_unit_id := COALESCE(NULLIF(v_raw->>'entered_unit_id', '')::uuid, v_item.base_unit_id);
    v_qty := COALESCE((v_raw->>'entered_qty')::numeric, 0);
    SELECT c.base_qty, c.conversion_factor INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id) c;
    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    v_unit_cost := round(GREATEST(0::numeric, COALESCE((v_raw->>'unit_cost')::numeric, COALESCE(v_var.purchase_price, v_item.purchase_price, 0), 0)), 2);
    v_disc_pct := LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'discount_pct')::numeric, 0), 2)));
    v_tax_incl := COALESCE((v_raw->>'tax_inclusive')::boolean, false);
    v_gst_rate := CASE WHEN v_effective_gst THEN LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'gst_rate')::numeric, v_item.gst_rate, 0), 2))) ELSE 0::numeric END;

    v_prepared_lines := v_prepared_lines || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'variant_id', v_var_id,
      'shade', NULLIF(trim(COALESCE(v_raw->>'shade', v_var.shade, '')), ''),
      'batch_lot', NULLIF(trim(COALESCE(v_raw->>'batch_lot', v_var.batch_lot, '')), ''),
      'item_type', v_item.item_type,
      'item_name', v_item.name || CASE WHEN v_var.variant_name IS NOT NULL THEN ' (' || v_var.variant_name || ')' ELSE '' END,
      'sku', COALESCE(v_var.sku, v_item.sku),
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
      'mrp', COALESCE(NULLIF(trim(COALESCE(v_raw->>'mrp', '')), '')::numeric, v_var.mrp),
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
      purchase_id, line_no, item_id, variant_id, shade, batch_lot, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_pb.id, v_i + 1, (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
      NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''), v_pl->>'item_name',
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
      purchase_id, line_no, item_id, variant_id, shade, batch_lot, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_pb.id, v_i + 1, (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
      NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''), v_pl->>'item_name',
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
        item_id, variant_id, shade, batch_lot, movement_type, movement_date,
        entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
        unit_cost, reason, reference_no, source_table, source_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
        NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''),
        'purchase', v_bill_date,
        (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric, (v_pl->>'base_qty')::numeric,
        v_base_unit_cost,
        'Purchase ' || v_pb.purchase_number || COALESCE(' (' || NULLIF(v_pb.supplier_invoice_no, '') || ')', ''),
        v_pb.purchase_number, 'purchase_bills', v_pb.id, auth.uid()
      );
    END IF;

    IF COALESCE(p_update_item_cost, false) AND v_base_unit_cost > 0 THEN
      IF NULLIF(v_pl->>'variant_id', '') IS NOT NULL THEN
        UPDATE public.item_variants SET purchase_price = v_base_unit_cost WHERE id = (v_pl->>'variant_id')::uuid;
      ELSE
        UPDATE public.items SET purchase_price = v_base_unit_cost WHERE id = (v_pl->>'item_id')::uuid;
      END IF;
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

  RETURN v_pb;
END;
$$;

