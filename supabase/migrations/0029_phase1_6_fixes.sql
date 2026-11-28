-- DecorBiz Phase 1-6 Reliability, Uniqueness & Draft Payment Migration
--   1. Safely archive/unpublish synthetic QA / ZZTEST test rows (non-destructive: no DELETEs).
--   2. Enforce uniqueness of active Party phone & GSTIN inside save_party().
--   3. Support retaining payment_mode / paid_amount / payment_reference on save_bill_draft().

-- ============================================================================
-- 1. Safely Isolate / Archive Synthetic QA & ZZTEST Test Records
-- ============================================================================
UPDATE public.items
SET is_active = false, is_published_online = false
WHERE (name ILIKE 'ZZTEST-%' OR name ILIKE 'QA Test%')
  AND (is_active = true OR is_published_online = true);

UPDATE public.parties
SET is_active = false
WHERE (name ILIKE 'ZZTEST-%' OR name ILIKE 'QA Test%')
  AND is_active = true;

UPDATE public.store_coupons
SET is_active = false
WHERE (code ILIKE 'ZZTEST%' OR code ILIKE 'QATEST%')
  AND is_active = true;

UPDATE public.store_banners
SET is_active = false
WHERE (title ILIKE 'ZZTEST%' OR title ILIKE 'QA Test%')
  AND is_active = true;

UPDATE public.store_delivery_zones
SET is_active = false
WHERE (zone_name ILIKE 'ZZTEST%' OR zone_name ILIKE 'QA Test%')
  AND is_active = true;

-- ============================================================================
-- 2. Enforce Active Party Phone & GSTIN Uniqueness in save_party()
-- ============================================================================
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
  v_clean_phone text;
  v_phone_digits text;
  v_phone_key text;
  v_clean_gstin text;
  v_dup_name text;
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

  v_clean_phone := NULLIF(trim(COALESCE(p_phone, '')), '');
  v_phone_digits := regexp_replace(COALESCE(v_clean_phone, ''), '\D', '', 'g');
  v_phone_key := CASE WHEN length(v_phone_digits) >= 10 THEN right(v_phone_digits, 10) ELSE v_phone_digits END;

  v_clean_gstin := NULLIF(upper(trim(COALESCE(p_gstin, ''))), '');
  IF v_clean_gstin IS NOT NULL AND v_clean_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$' THEN
    RAISE EXCEPTION 'Invalid 15-character GSTIN format.';
  END IF;

  IF length(v_phone_key) > 0 THEN
    SELECT p.name INTO v_dup_name
    FROM public.parties p
    WHERE p.is_active = true
      AND (p_party_id IS NULL OR p.id <> p_party_id)
      AND p.phone IS NOT NULL
      AND (
        CASE
          WHEN length(regexp_replace(p.phone, '\D', '', 'g')) >= 10 THEN right(regexp_replace(p.phone, '\D', '', 'g'), 10)
          ELSE regexp_replace(p.phone, '\D', '', 'g')
        END
      ) = v_phone_key
    LIMIT 1;
    IF v_dup_name IS NOT NULL THEN
      RAISE EXCEPTION 'Phone number already belongs to active party "%".', v_dup_name;
    END IF;
  END IF;

  IF v_clean_gstin IS NOT NULL THEN
    SELECT p.name INTO v_dup_name
    FROM public.parties p
    WHERE p.is_active = true
      AND (p_party_id IS NULL OR p.id <> p_party_id)
      AND upper(trim(COALESCE(p.gstin, ''))) = v_clean_gstin
    LIMIT 1;
    IF v_dup_name IS NOT NULL THEN
      RAISE EXCEPTION 'GSTIN "%" already belongs to active party "%".', v_clean_gstin, v_dup_name;
    END IF;
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
      v_clean_name, p_party_type, v_clean_phone,
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
      phone = v_clean_phone,
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

-- Best-effort partial unique index on active GSTINs if existing production rows have no duplicates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.parties
    WHERE is_active = true AND gstin IS NOT NULL AND trim(gstin) <> ''
    GROUP BY upper(trim(gstin))
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_active_gstin_unique
      ON public.parties (upper(trim(gstin)))
      WHERE is_active = true AND gstin IS NOT NULL AND trim(gstin) <> '';
  END IF;
END $$;

-- ============================================================================
-- 3. Preserve Payment Intent Fields on save_bill_draft()
-- ============================================================================
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
  p_site_id uuid DEFAULT NULL,
  p_paid_amount numeric DEFAULT 0,
  p_payment_mode text DEFAULT NULL,
  p_payment_reference text DEFAULT NULL
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
  v_grand numeric(15,2);
  v_paid numeric(15,2);
  v_mode text := NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), '');
  v_pay_ref text := NULLIF(trim(COALESCE(p_payment_reference, '')), '');
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to create or edit bills.';
  END IF;

  IF v_mode IS NOT NULL AND v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode: %', v_mode;
  END IF;

  IF p_site_id IS NOT NULL THEN
    SELECT site_name INTO v_site_name FROM public.party_sites WHERE id = p_site_id;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_prep := public._prepare_bill_payload(
    p_doc_type, p_party_id, p_place_of_supply, p_extra_charges, p_auto_round_off, p_lines, v_role, COALESCE(p_bill_date, CURRENT_DATE)
  );
  v_calc := v_prep->'calc';
  v_grand := (v_calc->>'grand_total')::numeric;
  v_paid := LEAST(GREATEST(round(COALESCE(p_paid_amount, 0)::numeric, 2), 0), v_grand);

  IF p_id IS NULL THEN
    INSERT INTO public.bills (
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin,
      party_address, place_of_supply_state_code, is_interstate, bill_date, due_date,
      valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total,
      paid_amount, payment_mode, payment_reference, credited_amount, balance_due, notes, terms, business_snapshot,
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
      v_grand, v_paid, v_mode, v_pay_ref, 0, GREATEST(v_grand - v_paid, 0),
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
        grand_total = v_grand, paid_amount = v_paid,
        payment_mode = v_mode, payment_reference = v_pay_ref,
        balance_due = GREATEST(v_grand - v_paid, 0),
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

GRANT EXECUTE ON FUNCTION public.save_bill_draft(
  uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, uuid, numeric, text, text
) TO authenticated;

-- ============================================================================
-- 4. Harden create_sales_return() & create_purchase_return() with Variant/Lot Tracking
-- ============================================================================
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
      'source_bill_line_id', v_src_line.id,
      'item_id', v_src_line.item_id,
      'variant_id', v_src_line.variant_id,
      'shade', v_src_line.shade,
      'batch_lot', v_src_line.batch_lot,
      'item_type', COALESCE(v_item_type, 'goods'),
      'item_name', v_src_line.item_name,
      'sku', v_src_line.sku,
      'hsn_code', v_src_line.hsn_code,
      'entered_qty', v_ret_qty,
      'entered_unit_id', v_src_line.entered_unit_id,
      'entered_unit_code', v_src_line.entered_unit_code,
      'conversion_factor', v_src_line.conversion_factor,
      'base_qty', v_base_qty,
      'catalog_unit_price', v_src_line.catalog_unit_price,
      'unit_price', v_src_line.unit_price,
      'discount_pct', v_src_line.discount_pct,
      'tax_inclusive', v_src_line.tax_inclusive,
      'gst_rate', v_src_line.gst_rate,
      'mrp', v_src_line.mrp,
      'line_meta', COALESCE(v_src_line.line_meta, '{}'::jsonb)
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
    site_id, site_name, issued_at, issued_by, created_by
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
    v_source.business_snapshot, v_idemp,
    v_source.site_id, v_source.site_name, now(), auth.uid(), auth.uid()
  )
  RETURNING * INTO v_cn;

  FOR v_i IN 0..(jsonb_array_length(v_prep_lines) - 1)
  LOOP
    v_pl := v_prep_lines->v_i;
    v_cl := (v_calc->'lines')->v_i;

    INSERT INTO public.bill_lines (
      bill_id, line_no, item_id, variant_id, shade, batch_lot, source_bill_line_id,
      item_name, sku, hsn_code, entered_qty, entered_unit_id, entered_unit_code,
      conversion_factor, base_qty, catalog_unit_price, unit_price, discount_pct,
      tax_inclusive, gst_rate, gross_amount, discount_amount, taxable_amount,
      cgst_amount, sgst_amount, igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_cn.id, v_i + 1, (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
      NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''),
      (v_pl->>'source_bill_line_id')::uuid, v_pl->>'item_name',
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

    IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
      INSERT INTO public.stock_ledger (
        item_id, variant_id, shade, batch_lot, movement_type, movement_date,
        entered_qty, entered_unit_id, conversion_factor, signed_base_qty,
        unit_cost, reason, reference_no, source_table, source_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
        NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''),
        'sale_return', v_return_date,
        (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric, (v_pl->>'base_qty')::numeric,
        COALESCE(
          (SELECT purchase_price FROM public.item_variants WHERE id = NULLIF(v_pl->>'variant_id', '')::uuid),
          (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid)
        ),
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

CREATE OR REPLACE FUNCTION public.create_purchase_return(
  p_source_purchase_id uuid,
  p_lines jsonb,
  p_return_date date DEFAULT CURRENT_DATE,
  p_refund_amount numeric DEFAULT 0,
  p_refund_mode text DEFAULT 'cash',
  p_reason text DEFAULT '',
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.purchase_bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_clean_reason text;
  v_refund_mode text;
  v_idemp text;
  v_existing public.purchase_bills;
  v_source public.purchase_bills;
  v_return_date date;
  v_req jsonb;
  v_src_line public.purchase_lines;
  v_item_type text := 'goods';
  v_ret_qty numeric(15,3);
  v_already_ret numeric(15,3);
  v_rem_qty numeric(15,3);
  v_base_qty numeric(15,3);
  v_base_allow_decimal boolean;
  v_prep_lines jsonb := '[]'::jsonb;
  v_calc_input jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_pr_number text;
  v_pr public.purchase_bills;
  v_grand numeric(15,2);
  v_refund numeric(15,2);
  v_credit_applied numeric(15,2);
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
  v_new_credited numeric(15,2);
  v_new_balance numeric(15,2);
BEGIN
  PERFORM public.require_module('purchases');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to record purchase returns.';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter a return reason (minimum 3 characters).';
  END IF;

  v_refund_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_refund_mode, ''))), ''), 'cash');
  IF v_refund_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid refund mode.';
  END IF;

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('purchase_return:' || v_idemp));
    SELECT * INTO v_existing FROM public.purchase_bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_source FROM public.purchase_bills WHERE id = p_source_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source purchase bill not found.';
  END IF;
  IF v_source.status <> 'posted' OR v_source.doc_type <> 'purchase_bill' THEN
    RAISE EXCEPTION 'Purchase returns are only allowed against posted purchase bills.';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Select at least one item line to return.';
  END IF;

  FOR v_req IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_src_line
    FROM public.purchase_lines
    WHERE id = (v_req->>'source_purchase_line_id')::uuid AND purchase_id = p_source_purchase_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced purchase line does not belong to source purchase.';
    END IF;

    v_ret_qty := round(COALESCE((v_req->>'entered_qty')::numeric, 0), 3);
    IF v_ret_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(pl.entered_qty), 0)::numeric(15,3)
    INTO v_already_ret
    FROM public.purchase_lines pl
    JOIN public.purchase_bills pb ON pb.id = pl.purchase_id
    WHERE pl.source_purchase_line_id = v_src_line.id
      AND pb.doc_type = 'purchase_return'
      AND pb.status <> 'voided';

    v_rem_qty := round((v_src_line.entered_qty - v_already_ret)::numeric, 3);
    IF v_ret_qty > v_rem_qty THEN
      RAISE EXCEPTION 'Return quantity (% %) for "%" exceeds returnable quantity (% %).',
        v_ret_qty, v_src_line.entered_unit_code, v_src_line.item_name, v_rem_qty, v_src_line.entered_unit_code;
    END IF;

    v_base_qty := round((v_ret_qty * v_src_line.conversion_factor)::numeric, 3);
    v_item_type := 'goods';
    SELECT i.item_type, u.allow_decimal INTO v_item_type, v_base_allow_decimal
    FROM public.items i
    JOIN public.item_units u ON u.id = i.base_unit_id
    WHERE i.id = v_src_line.item_id;

    IF FOUND AND NOT COALESCE(v_base_allow_decimal, true) AND v_base_qty <> trunc(v_base_qty) THEN
      RAISE EXCEPTION 'Base unit for "%" does not allow fractional return quantities.', v_src_line.item_name;
    END IF;

    v_prep_lines := v_prep_lines || jsonb_build_array(jsonb_build_object(
      'source_purchase_line_id', v_src_line.id,
      'item_id', v_src_line.item_id,
      'variant_id', v_src_line.variant_id,
      'shade', v_src_line.shade,
      'batch_lot', v_src_line.batch_lot,
      'item_type', COALESCE(v_item_type, 'goods'),
      'item_name', v_src_line.item_name,
      'sku', v_src_line.sku,
      'hsn_code', v_src_line.hsn_code,
      'entered_qty', v_ret_qty,
      'entered_unit_id', v_src_line.entered_unit_id,
      'entered_unit_code', v_src_line.entered_unit_code,
      'conversion_factor', v_src_line.conversion_factor,
      'base_qty', v_base_qty,
      'unit_cost', v_src_line.unit_cost,
      'discount_pct', v_src_line.discount_pct,
      'tax_inclusive', v_src_line.tax_inclusive,
      'gst_rate', v_src_line.gst_rate,
      'mrp', v_src_line.mrp,
      'line_meta', COALESCE(v_src_line.line_meta, '{}'::jsonb)
    ));

    v_calc_input := v_calc_input || jsonb_build_array(jsonb_build_object(
      'entered_qty', v_ret_qty,
      'unit_price', v_src_line.unit_cost,
      'discount_pct', v_src_line.discount_pct,
      'tax_inclusive', v_src_line.tax_inclusive,
      'gst_rate', v_src_line.gst_rate
    ));
  END LOOP;

  IF jsonb_array_length(v_prep_lines) = 0 THEN
    RAISE EXCEPTION 'Enter a positive return quantity for at least one item.';
  END IF;

  v_calc := public.compute_bill_amounts(
    v_source.gst_applied,
    CASE WHEN v_source.gst_applied THEN 'tax_invoice' ELSE 'bill_of_supply' END,
    v_source.is_interstate,
    0,
    v_source.auto_round_off,
    v_calc_input
  );

  v_grand := (v_calc->>'grand_total')::numeric(15,2);
  v_refund := round(COALESCE(p_refund_amount, 0)::numeric, 2);
  IF v_refund < 0 OR v_refund > v_grand THEN
    RAISE EXCEPTION 'Refund amount must be between ₹0 and Purchase Return total (₹%).', v_grand;
  END IF;
  IF v_source.party_id IS NOT NULL AND v_refund > 0 AND NOT public.is_module_enabled('payments') THEN
    RAISE EXCEPTION 'Payments module must be enabled to record a supplier cash/UPI refund. Set refund to ₹0 to adjust supplier Khata.';
  END IF;
  IF v_source.party_id IS NOT NULL AND v_refund > 0 AND v_role = 'storekeeper' THEN
    RAISE EXCEPTION 'Storekeeper cannot post payment receipts. Set refund to ₹0 to debit supplier Khata.';
  END IF;

  v_credit_applied := GREATEST(round((v_grand - v_refund)::numeric, 2), 0);
  v_return_date := COALESCE(p_return_date, CURRENT_DATE);
  v_pr_number := public.next_document_number('purchase_return', v_return_date);

  PERFORM set_config('app.purchase_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.purchase_line_init', txid_current()::text, true);

  INSERT INTO public.purchase_bills (
    purchase_number, doc_type, status, source_purchase_id,
    party_id, party_name, party_phone, party_gstin, party_address,
    place_of_supply_state_code, is_interstate, bill_date, gst_applied,
    subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total,
    tax_total, freight_charges, auto_round_off, round_off, grand_total,
    paid_amount, credited_amount, balance_due,
    payment_mode, return_reason, notes, idempotency_key,
    posted_at, posted_by, created_by
  )
  VALUES (
    v_pr_number, 'purchase_return', 'posted', v_source.id,
    v_source.party_id, v_source.party_name, v_source.party_phone, v_source.party_gstin, v_source.party_address,
    v_source.place_of_supply_state_code, (v_calc->>'is_interstate')::boolean, v_return_date, (v_calc->>'gst_applied')::boolean,
    (v_calc->>'subtotal_taxable')::numeric, (v_calc->>'discount_total')::numeric,
    (v_calc->>'cgst_total')::numeric, (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
    (v_calc->>'tax_total')::numeric, 0, v_source.auto_round_off, (v_calc->>'round_off')::numeric, v_grand,
    v_refund, 0, 0,
    v_refund_mode, v_clean_reason,
    'Purchase Return against ' || v_source.purchase_number || ': ' || v_clean_reason,
    v_idemp, now(), auth.uid(), auth.uid()
  )
  RETURNING * INTO v_pr;

  FOR v_i IN 0..(jsonb_array_length(v_prep_lines) - 1)
  LOOP
    v_pl := v_prep_lines->v_i;
    v_cl := (v_calc->'lines')->v_i;

    INSERT INTO public.purchase_lines (
      purchase_id, line_no, item_id, variant_id, shade, batch_lot,
      source_purchase_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, mrp, line_meta
    )
    VALUES (
      v_pr.id, v_i + 1, (v_pl->>'item_id')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid,
      NULLIF(v_pl->>'shade', ''), NULLIF(v_pl->>'batch_lot', ''),
      (v_pl->>'source_purchase_line_id')::uuid, v_pl->>'item_name',
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
      NULLIF(v_pl->>'mrp', '')::numeric, COALESCE(v_pl->'line_meta', '{}'::jsonb)
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
        'purchase_return',
        v_return_date,
        (v_pl->>'entered_qty')::numeric,
        (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric,
        -((v_pl->>'base_qty')::numeric),
        round(((v_cl->>'taxable_amount')::numeric / NULLIF((v_pl->>'base_qty')::numeric, 0)), 2),
        'Purchase Return ' || v_pr.purchase_number || ' (' || v_clean_reason || ')',
        v_pr.purchase_number,
        'purchase_bills',
        v_pr.id,
        auth.uid()
      );
    END IF;
  END LOOP;

  PERFORM set_config('app.purchase_line_init', '', true);

  v_new_credited := round((v_source.credited_amount + v_credit_applied)::numeric, 2);
  v_new_balance := GREATEST(round((v_source.grand_total - v_source.paid_amount - v_new_credited)::numeric, 2), 0);

  UPDATE public.purchase_bills
  SET credited_amount = v_new_credited,
      balance_due = v_new_balance
  WHERE id = v_source.id;

  IF v_source.party_id IS NOT NULL AND public.is_module_enabled('parties') AND v_grand > 0 THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, reference_no,
      source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      v_source.party_id,
      'purchase_return',
      v_return_date,
      v_pr.purchase_number,
      'purchase_bills',
      v_pr.id,
      v_grand,
      'Purchase Return ' || v_pr.purchase_number || ' against ' || v_source.purchase_number,
      auth.uid()
    );

    IF v_refund > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        v_source.party_id,
        'receive',
        v_refund,
        v_refund_mode,
        v_return_date,
        v_pr.purchase_number,
        'Refund for Purchase Return ' || v_pr.purchase_number,
        NULL,
        false,
        CASE WHEN v_idemp IS NOT NULL THEN 'pr_ref:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.purchase_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'purchase.return_posted', 'purchase_bill', v_pr.id::text,
    jsonb_build_object(
      'purchase_return_number', v_pr.purchase_number,
      'source_purchase_id', v_source.id,
      'source_purchase_number', v_source.purchase_number,
      'grand_total', v_grand,
      'refund_amount', v_refund,
      'credit_applied', v_credit_applied,
      'reason', v_clean_reason
    )
  );

  RETURN v_pr;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_sales_return(uuid, jsonb, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_purchase_return(uuid, jsonb, date, numeric, text, text, text) TO authenticated;

