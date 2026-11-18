-- BizOne ERP - Phase P5 (Part 1): Purchases, Purchase Returns, Expenses & Walk-in Payment Mode
-- Builds cleanly on Phases P1–P4:
--   1. Adds payment_mode & payment_reference to bills (for walk-in Cash vs Bank/UPI Book attribution).
--   2. Extends business document numbering for Purchases, Purchase Returns, Expenses & last_backup_at.
--   3. Implements purchase_bills, purchase_lines, Purchase Return (Debit Note), void_purchase, and
--      reconciles party_open_obligations + post_payment + allocation sync triggers with purchase_bills.
--   4. Implements expense_categories (9 seeded EN/HI categories), expenses, void_expense, and strict
--      Cashier "Own only" RLS & view isolation.

-- ============================================================================
-- 1. Walk-in Payment Mode Tracking on Bills (Cash Book vs Bank Book precision)
-- ============================================================================
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'cash'
    CHECK (payment_mode IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other')),
  ADD COLUMN IF NOT EXISTS payment_reference text;

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
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_bill_date := COALESCE(p_bill_date, CURRENT_DATE);

  IF p_party_id IS NOT NULL THEN
    SELECT credit_days INTO v_party_credit_days FROM public.parties WHERE id = p_party_id;
    v_due_date := COALESCE(p_due_date, CASE WHEN COALESCE(v_party_credit_days, 0) > 0 THEN v_bill_date + v_party_credit_days ELSE NULL END);
  ELSE
    v_due_date := p_due_date;
  END IF;

  v_prep := public._prepare_bill_payload(
    p_doc_type, p_party_id, p_place_of_supply, p_extra_charges, p_auto_round_off, p_lines, v_role
  );
  v_calc := v_prep->'calc';
  v_grand := (v_calc->>'grand_total')::numeric(15,2);

  IF p_doc_type = 'quotation' THEN
    v_paid := 0;
    v_balance := 0;
  ELSE
    v_paid := round(COALESCE(p_paid_amount, 0)::numeric, 2);
    IF v_paid < 0 THEN
      RAISE EXCEPTION 'Paid amount cannot be negative.';
    END IF;
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
      RAISE EXCEPTION 'Payments module must be enabled to record an immediate payment on a party bill. Set paid amount to ₹0 or enable Payments.';
    END IF;
    v_balance := round((v_grand - v_paid)::numeric, 2);
  END IF;

  v_bill_number := public.next_document_number(p_doc_type, v_bill_date);

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.bill_line_init', txid_current()::text, true);

  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.bills WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Draft bill not found.';
    END IF;
    IF v_existing.status <> 'draft' THEN
      RAISE EXCEPTION 'This document has already been issued.';
    END IF;

    DELETE FROM public.bill_lines WHERE bill_id = p_draft_id;

    UPDATE public.bills
    SET
      bill_number = v_bill_number,
      doc_type = p_doc_type,
      status = 'issued',
      party_id = p_party_id,
      party_name = v_prep->>'party_name',
      party_phone = v_prep->>'party_phone',
      party_gstin = v_prep->>'party_gstin',
      party_address = v_prep->>'party_address',
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_calc->>'is_interstate')::boolean,
      bill_date = v_bill_date,
      due_date = v_due_date,
      valid_until = p_valid_until,
      gst_applied = (v_calc->>'gst_applied')::boolean,
      subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
      discount_total = (v_calc->>'discount_total')::numeric,
      cgst_total = (v_calc->>'cgst_total')::numeric,
      sgst_total = (v_calc->>'sgst_total')::numeric,
      igst_total = (v_calc->>'igst_total')::numeric,
      tax_total = (v_calc->>'tax_total')::numeric,
      extra_charges = (v_calc->>'extra_charges')::numeric,
      auto_round_off = COALESCE(p_auto_round_off, true),
      round_off = (v_calc->>'round_off')::numeric,
      grand_total = v_grand,
      paid_amount = v_paid,
      credited_amount = 0,
      balance_due = v_balance,
      payment_mode = v_mode,
      payment_reference = v_pay_ref,
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      terms = COALESCE(p_terms, v_biz.invoice_terms),
      business_snapshot = v_prep->'biz_snapshot',
      idempotency_key = v_idemp,
      issued_at = now(),
      issued_by = auth.uid()
    WHERE id = p_draft_id
    RETURNING * INTO v_bill;
  ELSE
    INSERT INTO public.bills (
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      place_of_supply_state_code, is_interstate, bill_date, due_date, valid_until, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total, tax_total,
      extra_charges, auto_round_off, round_off, grand_total, paid_amount, credited_amount, balance_due,
      payment_mode, payment_reference,
      notes, terms, business_snapshot, idempotency_key, issued_at, issued_by, created_by
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
      v_paid, 0, v_balance,
      v_mode, v_pay_ref,
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      COALESCE(p_terms, v_biz.invoice_terms), v_prep->'biz_snapshot', v_idemp,
      now(), auth.uid(), auth.uid()
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
      igst_amount, tax_amount, line_total
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
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric
    );

    IF p_doc_type IN ('tax_invoice', 'bill_of_supply') THEN
      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid,
        'sale',
        v_bill_date,
        (v_pl->>'entered_qty')::numeric,
        (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric,
        -((v_pl->>'base_qty')::numeric),
        (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid),
        'Sales Bill ' || v_bill.bill_number,
        v_bill.bill_number,
        'bills',
        v_bill.id,
        auth.uid()
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
        p_party_id,
        'bill',
        v_bill_date,
        v_due_date,
        v_bill.bill_number,
        'bills',
        v_bill.id,
        v_grand,
        CASE WHEN p_doc_type = 'bill_of_supply' THEN 'Bill of Supply ' ELSE 'Tax Invoice ' END || v_bill.bill_number,
        auth.uid()
      )
      RETURNING * INTO v_bill_ledger;

      IF v_paid > 0 AND public.is_module_enabled('payments') THEN
        PERFORM public.post_payment(
          p_party_id,
          'receive',
          v_paid,
          v_mode,
          v_bill_date,
          COALESCE(v_pay_ref, v_bill.bill_number),
          'Payment on Bill ' || v_bill.bill_number,
          jsonb_build_array(jsonb_build_object(
            'ledger_entry_id', v_bill_ledger.id,
            'amount', v_paid
          )),
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
    auth.uid(), v_actor_email,
    'bill.issued', 'bill', v_bill.id::text,
    jsonb_build_object(
      'bill_number', v_bill.bill_number,
      'doc_type', v_bill.doc_type,
      'party_id', v_bill.party_id,
      'grand_total', v_bill.grand_total,
      'paid_amount', v_paid,
      'payment_mode', v_mode,
      'balance_due', v_balance
    )
  );

  SELECT * INTO v_bill FROM public.bills WHERE id = v_bill.id;
  RETURN v_bill;
END;
$$;

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
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_source FROM public.bills WHERE id = p_source_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source invoice not found.';
  END IF;
  IF v_source.status <> 'issued' OR v_source.doc_type NOT IN ('tax_invoice', 'bill_of_supply') THEN
    RAISE EXCEPTION 'Sales returns are only allowed against issued invoices.';
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Select at least one item line to return.';
  END IF;

  FOR v_req IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_src_line
    FROM public.bill_lines
    WHERE id = (v_req->>'source_bill_line_id')::uuid AND bill_id = p_source_bill_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Referenced bill line does not belong to source invoice.';
    END IF;

    v_ret_qty := round(COALESCE((v_req->>'entered_qty')::numeric, 0), 3);
    IF v_ret_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(SUM(bl.entered_qty), 0)::numeric(15,3)
    INTO v_already_ret
    FROM public.bill_lines bl
    JOIN public.bills b ON b.id = bl.bill_id
    WHERE bl.source_bill_line_id = v_src_line.id
      AND b.doc_type = 'credit_note'
      AND b.status <> 'voided';

    v_rem_qty := round((v_src_line.entered_qty - v_already_ret)::numeric, 3);
    IF v_ret_qty > v_rem_qty THEN
      RAISE EXCEPTION 'Return quantity (% %) for "%" exceeds returnable quantity (% %).',
        v_ret_qty, v_src_line.entered_unit_code, v_src_line.item_name, v_rem_qty, v_src_line.entered_unit_code;
    END IF;

    v_base_qty := round((v_ret_qty * v_src_line.conversion_factor)::numeric, 3);

    IF v_src_line.item_id IS NOT NULL THEN
      SELECT u.allow_decimal INTO v_base_allow_decimal
      FROM public.items i
      JOIN public.item_units u ON u.id = i.base_unit_id
      WHERE i.id = v_src_line.item_id;

      IF FOUND AND NOT COALESCE(v_base_allow_decimal, true) AND v_base_qty <> trunc(v_base_qty) THEN
        RAISE EXCEPTION 'Base unit for "%" does not allow fractional return quantities (computed %).',
          v_src_line.item_name, v_base_qty;
      END IF;
    END IF;

    v_prep_lines := v_prep_lines || jsonb_build_array(jsonb_build_object(
      'source_bill_line_id', v_src_line.id,
      'item_id', v_src_line.item_id,
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
      'gst_rate', v_src_line.gst_rate
    ));
  END LOOP;

  IF jsonb_array_length(v_prep_lines) = 0 THEN
    RAISE EXCEPTION 'Enter a positive return quantity for at least one item.';
  END IF;

  v_calc := public.compute_bill_amounts(
    v_source.gst_applied,
    CASE WHEN v_source.doc_type = 'bill_of_supply' THEN 'bill_of_supply' ELSE 'credit_note' END,
    v_source.is_interstate,
    0,
    v_source.auto_round_off,
    v_prep_lines
  );

  v_grand := (v_calc->>'grand_total')::numeric(15,2);
  v_refund := round(COALESCE(p_refund_amount, 0)::numeric, 2);
  IF v_refund < 0 OR v_refund > v_grand THEN
    RAISE EXCEPTION 'Refund amount must be between ₹0 and Credit Note total (₹%).', v_grand;
  END IF;

  IF v_source.party_id IS NOT NULL AND v_refund > 0 AND NOT public.is_module_enabled('payments') THEN
    RAISE EXCEPTION 'Payments module must be enabled to issue an immediate cash/UPI refund. Set refund to ₹0 to credit the party Khata instead.';
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
    paid_amount, credited_amount, balance_due,
    payment_mode,
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
    v_refund, 0, 0,
    v_refund_mode,
    v_clean_reason, 'Return against ' || v_source.bill_number || ': ' || v_clean_reason, v_source.terms,
    v_source.business_snapshot, v_idemp,
    now(), auth.uid(), auth.uid()
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
      igst_amount, tax_amount, line_total
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
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric
    );

    INSERT INTO public.stock_ledger (
      item_id, movement_type, movement_date, entered_qty, entered_unit_id,
      conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
      source_table, source_id, created_by
    )
    VALUES (
      (v_pl->>'item_id')::uuid,
      'sale_return',
      v_return_date,
      (v_pl->>'entered_qty')::numeric,
      (v_pl->>'entered_unit_id')::uuid,
      (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric,
      (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid),
      'Sales Return ' || v_cn.bill_number || ' (' || v_clean_reason || ')',
      v_cn.bill_number,
      'bills',
      v_cn.id,
      auth.uid()
    );
  END LOOP;

  PERFORM set_config('app.bill_line_init', '', true);

  v_new_credited := round((v_source.credited_amount + v_credit_applied)::numeric, 2);
  v_new_balance := GREATEST(round((v_source.grand_total - v_source.paid_amount - v_new_credited)::numeric, 2), 0);

  UPDATE public.bills
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
      'sales_return',
      v_return_date,
      v_cn.bill_number,
      'bills',
      v_cn.id,
      -v_grand,
      'Credit Note ' || v_cn.bill_number || ' against ' || v_source.bill_number,
      auth.uid()
    );

    IF v_refund > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        v_source.party_id,
        'give',
        v_refund,
        v_refund_mode,
        v_return_date,
        v_cn.bill_number,
        'Refund for Credit Note ' || v_cn.bill_number,
        NULL,
        false,
        CASE WHEN v_idemp IS NOT NULL THEN 'cn_ref:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    'bill.sales_return',
    'bill',
    v_cn.id::text,
    jsonb_build_object(
      'credit_note_number', v_cn.bill_number,
      'source_bill_id', v_source.id,
      'source_bill_number', v_source.bill_number,
      'grand_total', v_grand,
      'refund_amount', v_refund,
      'refund_mode', v_refund_mode,
      'credit_applied', v_credit_applied,
      'reason', v_clean_reason
    )
  );

  RETURN v_cn;
END;
$$;

-- Append payment_mode & payment_reference at the end of bill_list_view
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
  b.payment_reference
FROM public.bills b
LEFT JOIN public.bills sb ON sb.id = b.source_bill_id
LEFT JOIN public.bills cb ON cb.id = b.converted_to_bill_id
WHERE public.is_module_enabled('billing')
  AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']);

ALTER VIEW public.bill_list_view SET (security_invoker = false);

-- ============================================================================
-- 2. Extend public.business & next_document_number for Purchases, Expenses & Backup
-- ============================================================================
ALTER TABLE public.business
  ADD COLUMN IF NOT EXISTS purchase_prefix text NOT NULL DEFAULT 'PUR-',
  ADD COLUMN IF NOT EXISTS purchase_next_number integer NOT NULL DEFAULT 1
    CHECK (purchase_next_number >= 1),
  ADD COLUMN IF NOT EXISTS purchase_return_prefix text NOT NULL DEFAULT 'PR-',
  ADD COLUMN IF NOT EXISTS purchase_return_next_number integer NOT NULL DEFAULT 1
    CHECK (purchase_return_next_number >= 1),
  ADD COLUMN IF NOT EXISTS expense_prefix text NOT NULL DEFAULT 'EXP-',
  ADD COLUMN IF NOT EXISTS expense_next_number integer NOT NULL DEFAULT 1
    CHECK (expense_next_number >= 1),
  ADD COLUMN IF NOT EXISTS last_backup_at timestamptz;

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
  p_expense_next_number integer DEFAULT NULL
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
    expense_next_number = GREATEST(1, COALESCE(p_expense_next_number, expense_next_number))
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
    auth.uid(),
    v_email,
    'business.updated',
    'business',
    '1',
    jsonb_build_object(
      'name', v_row.name,
      'gst_registered', v_row.gst_registered,
      'invoice_prefix', v_row.invoice_prefix,
      'purchase_prefix', v_row.purchase_prefix,
      'expense_prefix', v_row.expense_prefix
    )
  );

  RETURN v_row;
END;
$$;

DROP FUNCTION IF EXISTS public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text,
  text, boolean, text, integer, text, integer, numeric, boolean
);

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
  v_biz public.business;
  v_biz_next integer := 1;
  v_effective_key text;
BEGIN
  v_fy_code := public.compute_fy_code(COALESCE(p_doc_date, CURRENT_DATE));
  v_effective_key := p_series_key;

  IF p_series_key IN (
    'tax_invoice', 'bill_of_supply', 'quotation', 'credit_note',
    'purchase_bill', 'purchase_return', 'expense'
  ) THEN
    SELECT * INTO v_biz FROM public.business WHERE id = 1 FOR UPDATE;

    IF p_series_key = 'tax_invoice' OR (p_series_key = 'bill_of_supply' AND NOT COALESCE(v_biz.gst_registered, false)) THEN
      v_effective_key := 'tax_invoice';
      v_prefix := COALESCE(NULLIF(trim(v_biz.invoice_prefix), ''), 'INV-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.invoice_next_number, 1));
    ELSIF p_series_key = 'bill_of_supply' THEN
      v_prefix := 'BOS-';
      v_biz_next := 1;
    ELSIF p_series_key = 'quotation' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.quotation_prefix), ''), 'QTN-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.quotation_next_number, 1));
    ELSIF p_series_key = 'credit_note' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.credit_note_prefix), ''), 'CN-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.credit_note_next_number, 1));
    ELSIF p_series_key = 'purchase_bill' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.purchase_prefix), ''), 'PUR-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.purchase_next_number, 1));
    ELSIF p_series_key = 'purchase_return' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.purchase_return_prefix), ''), 'PR-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.purchase_return_next_number, 1));
    ELSIF p_series_key = 'expense' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.expense_prefix), ''), 'EXP-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.expense_next_number, 1));
    END IF;
  ELSE
    v_prefix := CASE p_series_key
      WHEN 'payment_receive' THEN 'REC-'
      WHEN 'payment_give' THEN 'PAY-'
      WHEN 'khata_entry' THEN 'KHT-'
      WHEN 'opening_balance' THEN 'OB-'
      WHEN 'stock_adjustment' THEN 'ADJ-'
      ELSE upper(left(p_series_key, 3)) || '-'
    END;
  END IF;

  INSERT INTO public.numbering_series (series_key, fy_code, prefix, next_number, padding)
  VALUES (v_effective_key, v_fy_code, v_prefix, v_biz_next, 4)
  ON CONFLICT (series_key, fy_code) DO NOTHING;

  SELECT next_number, padding
  INTO v_next, v_padding
  FROM public.numbering_series
  WHERE series_key = v_effective_key AND fy_code = v_fy_code
  FOR UPDATE;

  IF p_series_key IN (
    'tax_invoice', 'bill_of_supply', 'quotation', 'credit_note',
    'purchase_bill', 'purchase_return', 'expense'
  ) THEN
    v_next := GREATEST(v_next, v_biz_next);
  END IF;

  LOOP
    EXIT WHEN NOT (
      (v_effective_key IN ('tax_invoice', 'bill_of_supply', 'quotation', 'credit_note') AND EXISTS (
        SELECT 1 FROM public.bills WHERE bill_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
      OR (v_effective_key IN ('purchase_bill', 'purchase_return') AND EXISTS (
        SELECT 1 FROM public.purchase_bills WHERE purchase_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
      OR (v_effective_key = 'expense' AND EXISTS (
        SELECT 1 FROM public.expenses WHERE expense_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
      OR (v_effective_key IN ('payment_receive', 'payment_give') AND EXISTS (
        SELECT 1 FROM public.payments WHERE payment_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
    );
    v_next := v_next + 1;
  END LOOP;

  UPDATE public.numbering_series
  SET prefix = v_prefix,
      next_number = v_next + 1,
      updated_at = now()
  WHERE series_key = v_effective_key AND fy_code = v_fy_code;

  IF v_effective_key = 'tax_invoice' THEN
    UPDATE public.business SET invoice_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'quotation' THEN
    UPDATE public.business SET quotation_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'credit_note' THEN
    UPDATE public.business SET credit_note_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'purchase_bill' THEN
    UPDATE public.business SET purchase_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'purchase_return' THEN
    UPDATE public.business SET purchase_return_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'expense' THEN
    UPDATE public.business SET expense_next_number = v_next + 1 WHERE id = 1;
  END IF;

  RETURN v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0');
END;
$$;

-- ============================================================================
-- 3. Purchase Bills & Purchase Lines
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.purchase_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_number text UNIQUE,
  doc_type text NOT NULL CHECK (doc_type IN ('purchase_bill', 'purchase_return')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'voided')),
  source_purchase_id uuid REFERENCES public.purchase_bills(id) ON DELETE RESTRICT,
  party_id uuid REFERENCES public.parties(id) ON DELETE RESTRICT,
  party_name text NOT NULL DEFAULT 'Cash Supplier',
  party_phone text,
  party_gstin text,
  party_address text,
  supplier_invoice_no text,
  supplier_invoice_date date,
  bill_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  place_of_supply_state_code text,
  is_interstate boolean NOT NULL DEFAULT false,
  gst_applied boolean NOT NULL DEFAULT false,
  subtotal_taxable numeric(15,2) NOT NULL DEFAULT 0 CHECK (subtotal_taxable >= 0),
  discount_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  cgst_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (cgst_total >= 0),
  sgst_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (sgst_total >= 0),
  igst_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (igst_total >= 0),
  tax_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  freight_charges numeric(15,2) NOT NULL DEFAULT 0 CHECK (freight_charges >= 0),
  auto_round_off boolean NOT NULL DEFAULT true,
  round_off numeric(15,2) NOT NULL DEFAULT 0,
  grand_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  paid_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  credited_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (credited_amount >= 0),
  balance_due numeric(15,2) NOT NULL DEFAULT 0 CHECK (balance_due >= 0),
  payment_status text GENERATED ALWAYS AS (
    CASE
      WHEN status = 'draft' THEN 'draft'
      WHEN status = 'voided' THEN 'voided'
      WHEN doc_type = 'purchase_return' THEN 'debited'
      WHEN balance_due <= 0 THEN 'paid'
      WHEN paid_amount + credited_amount > 0 THEN 'partial'
      ELSE 'unpaid'
    END
  ) STORED,
  payment_mode text NOT NULL DEFAULT 'cash'
    CHECK (payment_mode IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other')),
  payment_reference text,
  attachment_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  update_item_cost boolean NOT NULL DEFAULT false,
  notes text,
  return_reason text,
  void_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  posted_at timestamptz,
  posted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_bills_date ON public.purchase_bills (bill_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_bills_party ON public.purchase_bills (party_id, bill_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_bills_status ON public.purchase_bills (status, doc_type);
CREATE INDEX IF NOT EXISTS idx_purchase_bills_source ON public.purchase_bills (source_purchase_id) WHERE source_purchase_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_purchase_bills_updated_at ON public.purchase_bills;
CREATE TRIGGER trg_purchase_bills_updated_at
  BEFORE UPDATE ON public.purchase_bills
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.purchase_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.purchase_bills(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no >= 1),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  source_purchase_line_id uuid REFERENCES public.purchase_lines(id) ON DELETE RESTRICT,
  item_name text NOT NULL,
  sku text,
  hsn_code text,
  entered_qty numeric(15,3) NOT NULL CHECK (entered_qty > 0),
  entered_unit_id uuid NOT NULL REFERENCES public.item_units(id) ON DELETE RESTRICT,
  entered_unit_code text NOT NULL,
  conversion_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  base_qty numeric(15,3) NOT NULL CHECK (base_qty > 0),
  unit_cost numeric(15,2) NOT NULL CHECK (unit_cost >= 0),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  tax_inclusive boolean NOT NULL DEFAULT false,
  gst_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (gst_rate >= 0 AND gst_rate <= 100),
  gross_amount numeric(15,2) NOT NULL DEFAULT 0,
  discount_amount numeric(15,2) NOT NULL DEFAULT 0,
  taxable_amount numeric(15,2) NOT NULL DEFAULT 0,
  cgst_amount numeric(15,2) NOT NULL DEFAULT 0,
  sgst_amount numeric(15,2) NOT NULL DEFAULT 0,
  igst_amount numeric(15,2) NOT NULL DEFAULT 0,
  tax_amount numeric(15,2) NOT NULL DEFAULT 0,
  line_total numeric(15,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_purchase_lines_purchase ON public.purchase_lines (purchase_id, line_no);
CREATE INDEX IF NOT EXISTS idx_purchase_lines_item ON public.purchase_lines (item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_lines_source ON public.purchase_lines (source_purchase_line_id) WHERE source_purchase_line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_immutable_purchase_bills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_rpc boolean := COALESCE(current_setting('app.purchase_rpc_context', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Posted or voided purchase documents cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF NOT v_in_rpc THEN
      RAISE EXCEPTION 'Posted or voided purchase documents are immutable.';
    END IF;
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'A voided purchase document cannot be modified.';
    END IF;

    IF NEW.purchase_number IS DISTINCT FROM OLD.purchase_number
       OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
       OR NEW.source_purchase_id IS DISTINCT FROM OLD.source_purchase_id
       OR NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.party_name IS DISTINCT FROM OLD.party_name
       OR NEW.bill_date IS DISTINCT FROM OLD.bill_date
       OR NEW.gst_applied IS DISTINCT FROM OLD.gst_applied
       OR NEW.is_interstate IS DISTINCT FROM OLD.is_interstate
       OR NEW.subtotal_taxable IS DISTINCT FROM OLD.subtotal_taxable
       OR NEW.discount_total IS DISTINCT FROM OLD.discount_total
       OR NEW.cgst_total IS DISTINCT FROM OLD.cgst_total
       OR NEW.sgst_total IS DISTINCT FROM OLD.sgst_total
       OR NEW.igst_total IS DISTINCT FROM OLD.igst_total
       OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
       OR NEW.freight_charges IS DISTINCT FROM OLD.freight_charges
       OR NEW.round_off IS DISTINCT FROM OLD.round_off
       OR NEW.grand_total IS DISTINCT FROM OLD.grand_total
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by THEN
      RAISE EXCEPTION 'Financial totals and identity of a posted purchase document cannot be altered.';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'posted' AND NEW.status = 'voided') THEN
      RAISE EXCEPTION 'Invalid purchase status transition from % to %.', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_purchase_bills_immutable ON public.purchase_bills;
CREATE TRIGGER trg_guard_purchase_bills_immutable
  BEFORE UPDATE OR DELETE ON public.purchase_bills
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_purchase_bills();

CREATE OR REPLACE FUNCTION public.guard_immutable_purchase_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_purchase_id uuid;
  v_status text;
  v_in_init boolean := COALESCE(current_setting('app.purchase_line_init', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_purchase_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_id ELSE NEW.purchase_id END;
  SELECT status INTO v_status FROM public.purchase_bills WHERE id = v_purchase_id;

  IF v_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status <> 'draft' AND NOT (TG_OP = 'INSERT' AND v_in_init) THEN
    RAISE EXCEPTION 'Lines of a posted or voided purchase document are immutable.';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_purchase_lines_immutable ON public.purchase_lines;
CREATE TRIGGER trg_guard_purchase_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_purchase_lines();

-- ============================================================================
-- 4. Reconcile Party Open Obligations, post_payment & Allocation Sync with Purchases
-- ============================================================================
CREATE OR REPLACE VIEW public.party_open_obligations
WITH (security_invoker = true)
AS
SELECT
  le.id AS ledger_entry_id,
  le.party_id,
  le.entry_type,
  le.entry_date,
  le.due_date,
  COALESCE(le.reference_no, upper(le.entry_type)) AS reference_no,
  le.note,
  abs(le.signed_amount)::numeric(15,2) AS original_amount,
  (
    COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
    + CASE
        WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
        WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
        ELSE 0
      END
  )::numeric(15,2) AS settled_amount,
  GREATEST(
    abs(le.signed_amount)
    - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
    - CASE
        WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
        WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
        ELSE 0
      END,
    0
  )::numeric(15,2) AS remaining_amount,
  CASE WHEN le.signed_amount > 0 THEN 'receive' ELSE 'give' END AS direction_needed,
  (
    GREATEST(
      abs(le.signed_amount)
      - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
      - CASE
          WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
          WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
          ELSE 0
        END,
      0
    ) > 0
    AND le.due_date IS NOT NULL
    AND le.due_date < CURRENT_DATE
  ) AS is_overdue,
  le.created_at
FROM public.party_ledger_entries le
LEFT JOIN public.bills b
  ON le.source_table = 'bills' AND le.source_id = b.id
LEFT JOIN public.purchase_bills pb
  ON le.source_table = 'purchase_bills' AND le.source_id = pb.id
LEFT JOIN public.payment_allocations pa
  ON pa.ledger_entry_id = le.id AND pa.is_reversed = false
WHERE le.is_reversed = false
  AND le.entry_type IN ('opening_balance', 'khata_due', 'bill', 'purchase')
GROUP BY le.id, b.credited_amount, pb.credited_amount
HAVING GREATEST(
  abs(le.signed_amount)
  - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
  - CASE
      WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
      WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
      ELSE 0
    END,
  0
) > 0;

CREATE OR REPLACE FUNCTION public.sync_bill_paid_on_allocation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ledger_id uuid;
  v_le public.party_ledger_entries;
  v_paid numeric(15,2);
  v_bill public.bills;
  v_pb public.purchase_bills;
  v_prev_ctx text;
BEGIN
  v_ledger_id := COALESCE(NEW.ledger_entry_id, OLD.ledger_entry_id);
  IF v_ledger_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT * INTO v_le FROM public.party_ledger_entries WHERE id = v_ledger_id;
  IF NOT FOUND OR v_le.source_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_le.source_table = 'bills' AND v_le.entry_type = 'bill' THEN
    SELECT COALESCE(SUM(allocated_amount), 0)::numeric(15,2)
    INTO v_paid
    FROM public.payment_allocations
    WHERE ledger_entry_id = v_ledger_id AND is_reversed = false;

    SELECT * INTO v_bill FROM public.bills WHERE id = v_le.source_id FOR UPDATE;
    IF FOUND AND v_bill.status = 'issued' THEN
      v_prev_ctx := COALESCE(current_setting('app.bill_rpc_context', true), '');
      PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
      UPDATE public.bills
      SET
        paid_amount = v_paid,
        balance_due = GREATEST(round((grand_total - v_paid - credited_amount)::numeric, 2), 0)
      WHERE id = v_bill.id;
      PERFORM set_config('app.bill_rpc_context', v_prev_ctx, true);
    END IF;
  ELSIF v_le.source_table = 'purchase_bills' AND v_le.entry_type = 'purchase' THEN
    SELECT COALESCE(SUM(allocated_amount), 0)::numeric(15,2)
    INTO v_paid
    FROM public.payment_allocations
    WHERE ledger_entry_id = v_ledger_id AND is_reversed = false;

    SELECT * INTO v_pb FROM public.purchase_bills WHERE id = v_le.source_id FOR UPDATE;
    IF FOUND AND v_pb.status = 'posted' THEN
      v_prev_ctx := COALESCE(current_setting('app.purchase_rpc_context', true), '');
      PERFORM set_config('app.purchase_rpc_context', txid_current()::text, true);
      UPDATE public.purchase_bills
      SET
        paid_amount = v_paid,
        balance_due = GREATEST(round((grand_total - v_paid - credited_amount)::numeric, 2), 0)
      WHERE id = v_pb.id;
      PERFORM set_config('app.purchase_rpc_context', v_prev_ctx, true);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.post_payment(
  p_party_id uuid,
  p_direction text,
  p_amount numeric,
  p_mode text DEFAULT 'cash',
  p_payment_date date DEFAULT CURRENT_DATE,
  p_reference_no text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_allocations jsonb DEFAULT NULL,
  p_auto_allocate boolean DEFAULT true,
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_party public.parties;
  v_amt numeric(15,2);
  v_date date;
  v_idemp text;
  v_existing public.payments;
  v_alloc jsonb;
  v_target_entry_id uuid;
  v_alloc_amt numeric(15,2);
  v_target_row public.party_ledger_entries;
  v_already_settled numeric(15,2);
  v_doc_credited numeric(15,2);
  v_remaining numeric(15,2);
  v_allocated_total numeric(15,2) := 0;
  v_advance_amt numeric(15,2) := 0;
  v_seen_ids uuid[] := ARRAY[]::uuid[];
  v_planned jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_open_rec record;
  v_left_to_allocate numeric(15,2);
  v_apply numeric(15,2);
  v_payment_no text;
  v_payment public.payments;
  v_signed_ledger numeric(15,2);
  v_actor_email text;
BEGIN
  PERFORM public.require_module('parties');
  PERFORM public.require_module('payments');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to post payments.';
  END IF;

  IF p_direction NOT IN ('receive', 'give') THEN
    RAISE EXCEPTION 'Payment direction must be receive or give.';
  END IF;

  IF p_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode.';
  END IF;

  v_amt := round(COALESCE(p_amount, 0)::numeric, 2);
  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero.';
  END IF;

  v_date := COALESCE(p_payment_date, CURRENT_DATE);
  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');

  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('payment:' || v_idemp));
    SELECT * INTO v_existing FROM public.payments WHERE idempotency_key = v_idemp;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Party not found.';
  END IF;
  IF NOT v_party.is_active THEN
    RAISE EXCEPTION 'Cannot post payment for an archived party.';
  END IF;

  IF p_allocations IS NOT NULL AND jsonb_typeof(p_allocations) = 'array' AND jsonb_array_length(p_allocations) > 0 THEN
    FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
    LOOP
      v_target_entry_id := (v_alloc->>'ledger_entry_id')::uuid;
      v_alloc_amt := round(COALESCE((v_alloc->>'amount')::numeric, 0), 2);
      IF v_alloc_amt <= 0 THEN
        CONTINUE;
      END IF;

      IF v_target_entry_id = ANY(v_seen_ids) THEN
        RAISE EXCEPTION 'Duplicate due entry in allocation list.';
      END IF;
      v_seen_ids := array_append(v_seen_ids, v_target_entry_id);

      IF v_allocated_total + v_alloc_amt > v_amt THEN
        RAISE EXCEPTION 'Total allocated amount exceeds payment amount (%).', v_amt;
      END IF;

      SELECT * INTO v_target_row
      FROM public.party_ledger_entries
      WHERE id = v_target_entry_id
      FOR UPDATE;

      IF NOT FOUND OR v_target_row.party_id <> p_party_id OR v_target_row.is_reversed = true THEN
        RAISE EXCEPTION 'Referenced due entry is invalid or reversed.';
      END IF;

      IF v_target_row.entry_type NOT IN ('opening_balance', 'khata_due', 'bill', 'purchase') THEN
        RAISE EXCEPTION 'Payments can only allocate against due entries.';
      END IF;

      IF (p_direction = 'receive' AND v_target_row.signed_amount <= 0)
         OR (p_direction = 'give' AND v_target_row.signed_amount >= 0) THEN
        RAISE EXCEPTION 'Allocation entry direction does not match payment direction.';
      END IF;

      SELECT COALESCE(SUM(allocated_amount), 0) INTO v_already_settled
      FROM public.payment_allocations
      WHERE ledger_entry_id = v_target_entry_id AND is_reversed = false;

      v_doc_credited := 0;
      IF v_target_row.source_table = 'bills' AND v_target_row.source_id IS NOT NULL THEN
        SELECT COALESCE(credited_amount, 0) INTO v_doc_credited FROM public.bills WHERE id = v_target_row.source_id;
      ELSIF v_target_row.source_table = 'purchase_bills' AND v_target_row.source_id IS NOT NULL THEN
        SELECT COALESCE(credited_amount, 0) INTO v_doc_credited FROM public.purchase_bills WHERE id = v_target_row.source_id;
      END IF;

      v_remaining := GREATEST(abs(v_target_row.signed_amount) - v_already_settled - v_doc_credited, 0);
      IF v_alloc_amt > v_remaining THEN
        RAISE EXCEPTION 'Allocation amount (%) exceeds remaining due (%).', v_alloc_amt, v_remaining;
      END IF;

      v_planned := v_planned || jsonb_build_array(jsonb_build_object(
        'target_type', CASE v_target_row.entry_type
          WHEN 'opening_balance' THEN 'opening_balance'
          WHEN 'bill' THEN 'bill'
          WHEN 'purchase' THEN 'purchase_bill'
          ELSE 'ledger_entry'
        END,
        'ledger_entry_id', v_target_entry_id,
        'target_label', COALESCE(v_target_row.reference_no, upper(v_target_row.entry_type)),
        'amount', v_alloc_amt
      ));
      v_allocated_total := v_allocated_total + v_alloc_amt;
    END LOOP;
  ELSIF COALESCE(p_auto_allocate, true) THEN
    v_left_to_allocate := v_amt;
    FOR v_open_rec IN
      SELECT
        le.id AS ledger_entry_id,
        le.entry_type,
        COALESCE(le.reference_no, upper(le.entry_type)) AS ref_label,
        GREATEST(
          abs(le.signed_amount)
          - COALESCE((
            SELECT SUM(pa.allocated_amount)
            FROM public.payment_allocations pa
            WHERE pa.ledger_entry_id = le.id AND pa.is_reversed = false
          ), 0)
          - CASE
              WHEN le.source_table = 'bills' AND le.source_id IS NOT NULL
                THEN COALESCE((SELECT b.credited_amount FROM public.bills b WHERE b.id = le.source_id), 0)
              WHEN le.source_table = 'purchase_bills' AND le.source_id IS NOT NULL
                THEN COALESCE((SELECT pb.credited_amount FROM public.purchase_bills pb WHERE pb.id = le.source_id), 0)
              ELSE 0
            END,
          0
        ) AS rem_amt
      FROM public.party_ledger_entries le
      WHERE le.party_id = p_party_id
        AND le.is_reversed = false
        AND le.entry_type IN ('opening_balance', 'khata_due', 'bill', 'purchase')
        AND ((p_direction = 'receive' AND le.signed_amount > 0) OR (p_direction = 'give' AND le.signed_amount < 0))
      ORDER BY le.entry_date ASC, le.created_at ASC, le.id ASC
      FOR UPDATE OF le
    LOOP
      EXIT WHEN v_left_to_allocate <= 0;
      IF v_open_rec.rem_amt <= 0 THEN
        CONTINUE;
      END IF;

      v_apply := LEAST(v_left_to_allocate, v_open_rec.rem_amt);
      v_planned := v_planned || jsonb_build_array(jsonb_build_object(
        'target_type', CASE v_open_rec.entry_type
          WHEN 'opening_balance' THEN 'opening_balance'
          WHEN 'bill' THEN 'bill'
          WHEN 'purchase' THEN 'purchase_bill'
          ELSE 'ledger_entry'
        END,
        'ledger_entry_id', v_open_rec.ledger_entry_id,
        'target_label', v_open_rec.ref_label,
        'amount', v_apply
      ));
      v_allocated_total := v_allocated_total + v_apply;
      v_left_to_allocate := v_left_to_allocate - v_apply;
    END LOOP;
  END IF;

  v_advance_amt := v_amt - v_allocated_total;
  v_payment_no := public.next_document_number(
    CASE WHEN p_direction = 'receive' THEN 'payment_receive' ELSE 'payment_give' END,
    v_date
  );

  INSERT INTO public.payments (
    payment_number, party_id, direction, amount,
    allocated_amount, advance_amount, mode, payment_date,
    reference_no, notes, status, idempotency_key, created_by
  )
  VALUES (
    v_payment_no,
    p_party_id,
    p_direction,
    v_amt,
    v_allocated_total,
    v_advance_amt,
    p_mode,
    v_date,
    NULLIF(trim(COALESCE(p_reference_no, '')), ''),
    NULLIF(trim(COALESCE(p_notes, '')), ''),
    'posted',
    v_idemp,
    auth.uid()
  )
  RETURNING * INTO v_payment;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_planned)
  LOOP
    INSERT INTO public.payment_allocations (
      payment_id, party_id, target_type, ledger_entry_id, target_label, allocated_amount
    )
    VALUES (
      v_payment.id,
      p_party_id,
      v_plan_item->>'target_type',
      (v_plan_item->>'ledger_entry_id')::uuid,
      v_plan_item->>'target_label',
      (v_plan_item->>'amount')::numeric(15,2)
    );
  END LOOP;

  IF v_advance_amt > 0 THEN
    INSERT INTO public.payment_allocations (
      payment_id, party_id, target_type, ledger_entry_id, target_label, allocated_amount
    )
    VALUES (
      v_payment.id,
      p_party_id,
      'advance',
      NULL,
      'On-Account Advance',
      v_advance_amt
    );
  END IF;

  v_signed_ledger := CASE WHEN p_direction = 'receive' THEN -v_amt ELSE v_amt END;
  INSERT INTO public.party_ledger_entries (
    party_id, entry_type, entry_date, reference_no,
    source_table, source_id, signed_amount, note, created_by
  )
  VALUES (
    p_party_id,
    CASE WHEN p_direction = 'receive' THEN 'payment_receive' ELSE 'payment_give' END,
    v_date,
    v_payment.payment_number,
    'payments',
    v_payment.id,
    v_signed_ledger,
    COALESCE(NULLIF(trim(COALESCE(p_notes, '')), ''), upper(p_mode) || ' payment' || CASE WHEN v_advance_amt > 0 THEN ' (includes advance ' || v_advance_amt || ')' ELSE '' END),
    auth.uid()
  );

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    'payment.posted',
    'payment',
    v_payment.id::text,
    jsonb_build_object(
      'payment_number', v_payment.payment_number,
      'party_id', p_party_id,
      'direction', p_direction,
      'amount', v_amt,
      'allocated_amount', v_allocated_total,
      'advance_amount', v_advance_amt,
      'mode', p_mode
    )
  );

  RETURN v_payment;
END;
$$;

-- ============================================================================
-- 5. Purchase RPCs (Drafts, Post Purchase, Purchase Return, Void)
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
  v_pos text;
  v_party_addr text := NULL;
  v_is_interstate boolean := false;
  v_effective_gst boolean := false;
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
    RAISE EXCEPTION 'Please add at least one item line to the purchase bill.';
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;

  IF p_party_id IS NOT NULL THEN
    SELECT * INTO v_party FROM public.parties WHERE id = p_party_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected supplier was not found.';
    END IF;
    IF NOT v_party.is_active THEN
      RAISE EXCEPTION 'Cannot record purchase for an archived supplier.';
    END IF;
    SELECT concat_ws(', ', NULLIF(address_line1, ''), NULLIF(city, ''), NULLIF(state, ''), NULLIF(pincode, '')),
           COALESCE(NULLIF(upper(trim(p_place_of_supply)), ''), NULLIF(upper(trim(state_code)), ''))
    INTO v_party_addr, v_pos
    FROM public.party_addresses
    WHERE party_id = p_party_id
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  END IF;

  v_pos := COALESCE(NULLIF(upper(trim(COALESCE(p_place_of_supply, ''))), ''), v_pos, v_biz.state_code);
  v_effective_gst := COALESCE(p_gst_applied, false) AND public.is_module_enabled('tax');
  IF v_effective_gst AND v_biz.state_code IS NOT NULL AND v_pos IS NOT NULL AND v_biz.state_code <> v_pos THEN
    v_is_interstate := true;
  END IF;

  FOR v_raw IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_item FROM public.items WHERE id = (v_raw->>'item_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected item was not found.';
    END IF;
    IF NOT v_item.is_active THEN
      RAISE EXCEPTION 'Item "%" is archived and cannot be purchased.', v_item.name;
    END IF;

    v_unit_id := COALESCE(NULLIF(v_raw->>'entered_unit_id', '')::uuid, v_item.base_unit_id);
    v_qty := COALESCE((v_raw->>'entered_qty')::numeric, 0);

    SELECT c.base_qty, c.conversion_factor
    INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id) c;

    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    v_unit_cost := round(GREATEST(0::numeric, COALESCE((v_raw->>'unit_cost')::numeric, COALESCE(v_item.purchase_price, 0), 0)), 2);
    v_disc_pct := LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'discount_pct')::numeric, 0), 2)));
    v_tax_incl := COALESCE((v_raw->>'tax_inclusive')::boolean, false);
    v_gst_rate := CASE
      WHEN v_effective_gst THEN LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'gst_rate')::numeric, v_item.gst_rate, 0), 2)))
      ELSE 0::numeric
    END;

    v_prepared_lines := v_prepared_lines || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
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
      'gst_rate', v_gst_rate
    ));

    v_calc_input_lines := v_calc_input_lines || jsonb_build_array(jsonb_build_object(
      'entered_qty', round(v_qty, 3),
      'unit_price', v_unit_cost,
      'discount_pct', v_disc_pct,
      'tax_inclusive', v_tax_incl,
      'gst_rate', v_gst_rate
    ));
  END LOOP;

  -- Reuse compute_bill_amounts math (identical tax/discount/round-off semantics)
  -- When v_effective_gst is false, passing doc_type='bill_of_supply' forces 0 tax
  v_calc := public.compute_bill_amounts(
    v_effective_gst,
    CASE WHEN v_effective_gst THEN 'tax_invoice' ELSE 'bill_of_supply' END,
    v_is_interstate,
    COALESCE(p_freight_charges, 0),
    COALESCE(p_auto_round_off, true),
    v_calc_input_lines
  );

  RETURN jsonb_build_object(
    'party_name', COALESCE(v_party.name, 'Cash Supplier'),
    'party_phone', v_party.phone,
    'party_gstin', v_party.gstin,
    'party_address', v_party_addr,
    'place_of_supply_state_code', v_pos,
    'effective_gst', v_effective_gst,
    'is_interstate', (v_calc->>'is_interstate')::boolean,
    'prepared_lines', v_prepared_lines,
    'calc', v_calc
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

  v_prep := public._prepare_purchase_payload(
    p_party_id, p_place_of_supply, p_gst_applied, p_freight_charges, p_auto_round_off, p_lines
  );
  v_calc := v_prep->'calc';

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_pb FROM public.purchase_bills WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase draft not found.';
    END IF;
    IF v_pb.status <> 'draft' THEN
      RAISE EXCEPTION 'Only draft purchases can be edited.';
    END IF;

    DELETE FROM public.purchase_lines WHERE purchase_id = p_id;

    UPDATE public.purchase_bills
    SET
      party_id = p_party_id,
      party_name = v_prep->>'party_name',
      party_phone = v_prep->>'party_phone',
      party_gstin = v_prep->>'party_gstin',
      party_address = v_prep->>'party_address',
      supplier_invoice_no = NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''),
      supplier_invoice_date = p_supplier_invoice_date,
      bill_date = COALESCE(p_bill_date, CURRENT_DATE),
      due_date = p_due_date,
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_prep->>'is_interstate')::boolean,
      gst_applied = (v_prep->>'effective_gst')::boolean,
      subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
      discount_total = (v_calc->>'discount_total')::numeric,
      cgst_total = (v_calc->>'cgst_total')::numeric,
      sgst_total = (v_calc->>'sgst_total')::numeric,
      igst_total = (v_calc->>'igst_total')::numeric,
      tax_total = (v_calc->>'tax_total')::numeric,
      freight_charges = (v_calc->>'extra_charges')::numeric,
      auto_round_off = COALESCE(p_auto_round_off, true),
      round_off = (v_calc->>'round_off')::numeric,
      grand_total = (v_calc->>'grand_total')::numeric,
      paid_amount = 0,
      credited_amount = 0,
      balance_due = (v_calc->>'grand_total')::numeric,
      attachment_file_id = p_attachment_file_id,
      update_item_cost = COALESCE(p_update_item_cost, false),
      notes = NULLIF(trim(COALESCE(p_notes, '')), '')
    WHERE id = p_id
    RETURNING * INTO v_pb;
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
      COALESCE(p_bill_date, CURRENT_DATE), p_due_date,
      v_prep->>'place_of_supply_state_code', (v_prep->>'is_interstate')::boolean,
      (v_prep->>'effective_gst')::boolean,
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
      igst_amount, tax_amount, line_total
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
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric
    );
  END LOOP;

  RETURN v_pb;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_purchase_draft(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_pb public.purchase_bills;
BEGIN
  PERFORM public.require_module('purchases');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to delete purchase drafts.';
  END IF;

  SELECT * INTO v_pb FROM public.purchase_bills WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase draft not found.';
  END IF;
  IF v_pb.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft purchase bills can be deleted.';
  END IF;

  DELETE FROM public.purchase_bills WHERE id = p_id;
  RETURN true;
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
    IF FOUND THEN
      RETURN v_existing;
    END IF;
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

  v_prep := public._prepare_purchase_payload(
    p_party_id, p_place_of_supply, p_gst_applied, p_freight_charges, p_auto_round_off, p_lines
  );
  v_calc := v_prep->'calc';
  v_grand := (v_calc->>'grand_total')::numeric(15,2);
  v_paid := round(COALESCE(p_paid_amount, 0)::numeric, 2);

  IF v_paid < 0 THEN
    RAISE EXCEPTION 'Paid amount cannot be negative.';
  END IF;
  IF v_paid > v_grand THEN
    RAISE EXCEPTION 'Paid amount (₹%) exceeds purchase grand total (₹%).', v_paid, v_grand;
  END IF;
  IF p_party_id IS NULL AND v_paid < v_grand THEN
    RAISE EXCEPTION 'Walk-in cash purchases must be paid in full (or select a supplier for Khata credit).';
  END IF;
  IF p_party_id IS NOT NULL AND v_paid < v_grand AND NOT public.is_module_enabled('parties') THEN
    RAISE EXCEPTION 'Parties & Khata module must be enabled for supplier credit.';
  END IF;
  IF p_party_id IS NOT NULL AND v_paid > 0 AND NOT public.is_module_enabled('payments') THEN
    RAISE EXCEPTION 'Payments module must be enabled to record an immediate payment on a supplier purchase.';
  END IF;
  IF p_party_id IS NOT NULL AND v_paid > 0 AND v_role = 'storekeeper' THEN
    RAISE EXCEPTION 'Storekeeper cannot post payment cashouts. Set Paid Now to ₹0 so Accounts/Manager can settle payment.';
  END IF;

  v_balance := round((v_grand - v_paid)::numeric, 2);
  v_pur_no := public.next_document_number('purchase_bill', v_bill_date);

  PERFORM set_config('app.purchase_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.purchase_line_init', txid_current()::text, true);

  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.purchase_bills WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase draft not found.';
    END IF;
    IF v_existing.status <> 'draft' THEN
      RAISE EXCEPTION 'This purchase bill has already been posted.';
    END IF;

    DELETE FROM public.purchase_lines WHERE purchase_id = p_draft_id;

    UPDATE public.purchase_bills
    SET
      purchase_number = v_pur_no,
      doc_type = 'purchase_bill',
      status = 'posted',
      party_id = p_party_id,
      party_name = v_prep->>'party_name',
      party_phone = v_prep->>'party_phone',
      party_gstin = v_prep->>'party_gstin',
      party_address = v_prep->>'party_address',
      supplier_invoice_no = NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''),
      supplier_invoice_date = p_supplier_invoice_date,
      bill_date = v_bill_date,
      due_date = v_due_date,
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_prep->>'is_interstate')::boolean,
      gst_applied = (v_prep->>'effective_gst')::boolean,
      subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
      discount_total = (v_calc->>'discount_total')::numeric,
      cgst_total = (v_calc->>'cgst_total')::numeric,
      sgst_total = (v_calc->>'sgst_total')::numeric,
      igst_total = (v_calc->>'igst_total')::numeric,
      tax_total = (v_calc->>'tax_total')::numeric,
      freight_charges = (v_calc->>'extra_charges')::numeric,
      auto_round_off = COALESCE(p_auto_round_off, true),
      round_off = (v_calc->>'round_off')::numeric,
      grand_total = v_grand,
      paid_amount = v_paid,
      credited_amount = 0,
      balance_due = v_balance,
      payment_mode = v_mode,
      payment_reference = v_pay_ref,
      attachment_file_id = p_attachment_file_id,
      update_item_cost = COALESCE(p_update_item_cost, false),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      idempotency_key = v_idemp,
      posted_at = now(),
      posted_by = auth.uid()
    WHERE id = p_draft_id
    RETURNING * INTO v_pb;
  ELSE
    INSERT INTO public.purchase_bills (
      purchase_number, doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      supplier_invoice_no, supplier_invoice_date, bill_date, due_date,
      place_of_supply_state_code, is_interstate, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total,
      tax_total, freight_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due,
      payment_mode, payment_reference, attachment_file_id, update_item_cost,
      notes, idempotency_key, posted_at, posted_by, created_by
    )
    VALUES (
      v_pur_no, 'purchase_bill', 'posted', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address',
      NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''), p_supplier_invoice_date,
      v_bill_date, v_due_date,
      v_prep->>'place_of_supply_state_code', (v_prep->>'is_interstate')::boolean,
      (v_prep->>'effective_gst')::boolean,
      (v_calc->>'subtotal_taxable')::numeric, (v_calc->>'discount_total')::numeric,
      (v_calc->>'cgst_total')::numeric, (v_calc->>'sgst_total')::numeric,
      (v_calc->>'igst_total')::numeric, (v_calc->>'tax_total')::numeric,
      (v_calc->>'extra_charges')::numeric, COALESCE(p_auto_round_off, true),
      (v_calc->>'round_off')::numeric, v_grand,
      v_paid, 0, v_balance,
      v_mode, v_pay_ref, p_attachment_file_id, COALESCE(p_update_item_cost, false),
      NULLIF(trim(COALESCE(p_notes, '')), ''), v_idemp, now(), auth.uid(), auth.uid()
    )
    RETURNING * INTO v_pb;
  END IF;

  IF p_attachment_file_id IS NOT NULL THEN
    INSERT INTO public.file_links (file_id, entity_type, entity_id)
    VALUES (p_attachment_file_id, 'purchase_bill', v_pb.id)
    ON CONFLICT DO NOTHING;
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
      igst_amount, tax_amount, line_total
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
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric
    );

    v_base_unit_cost := CASE
      WHEN (v_pl->>'base_qty')::numeric > 0
        THEN round(((v_cl->>'taxable_amount')::numeric / (v_pl->>'base_qty')::numeric), 2)
      ELSE 0
    END;

    INSERT INTO public.stock_ledger (
      item_id, movement_type, movement_date, entered_qty, entered_unit_id,
      conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
      source_table, source_id, created_by
    )
    VALUES (
      (v_pl->>'item_id')::uuid,
      'purchase',
      v_bill_date,
      (v_pl->>'entered_qty')::numeric,
      (v_pl->>'entered_unit_id')::uuid,
      (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric,
      v_base_unit_cost,
      'Purchase ' || v_pb.purchase_number || COALESCE(' (' || NULLIF(v_pb.supplier_invoice_no, '') || ')', ''),
      v_pb.purchase_number,
      'purchase_bills',
      v_pb.id,
      auth.uid()
    );

    IF COALESCE(p_update_item_cost, false) AND v_base_unit_cost > 0 THEN
      UPDATE public.items
      SET purchase_price = v_base_unit_cost
      WHERE id = (v_pl->>'item_id')::uuid;
    END IF;
  END LOOP;

  PERFORM set_config('app.purchase_line_init', '', true);

  IF p_party_id IS NOT NULL AND public.is_module_enabled('parties') AND v_grand > 0 THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, due_date, reference_no,
      source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      p_party_id,
      'purchase',
      v_bill_date,
      v_due_date,
      v_pb.purchase_number,
      'purchase_bills',
      v_pb.id,
      -v_grand,
      'Purchase Bill ' || v_pb.purchase_number || COALESCE(' · Inv ' || NULLIF(v_pb.supplier_invoice_no, ''), ''),
      auth.uid()
    )
    RETURNING * INTO v_pur_ledger;

    IF v_paid > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        p_party_id,
        'give',
        v_paid,
        v_mode,
        v_bill_date,
        COALESCE(v_pay_ref, v_pb.purchase_number),
        'Payment for Purchase ' || v_pb.purchase_number,
        jsonb_build_array(jsonb_build_object(
          'ledger_entry_id', v_pur_ledger.id,
          'amount', v_paid
        )),
        false,
        CASE WHEN v_idemp IS NOT NULL THEN 'pur_pay:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.purchase_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'purchase.posted', 'purchase_bill', v_pb.id::text,
    jsonb_build_object(
      'purchase_number', v_pb.purchase_number,
      'party_id', v_pb.party_id,
      'supplier_invoice_no', v_pb.supplier_invoice_no,
      'grand_total', v_pb.grand_total,
      'paid_amount', v_paid,
      'payment_mode', v_mode,
      'balance_due', v_balance
    )
  );

  SELECT * INTO v_pb FROM public.purchase_bills WHERE id = v_pb.id;
  RETURN v_pb;
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

    SELECT u.allow_decimal INTO v_base_allow_decimal
    FROM public.items i
    JOIN public.item_units u ON u.id = i.base_unit_id
    WHERE i.id = v_src_line.item_id;

    IF FOUND AND NOT COALESCE(v_base_allow_decimal, true) AND v_base_qty <> trunc(v_base_qty) THEN
      RAISE EXCEPTION 'Base unit for "%" does not allow fractional return quantities.', v_src_line.item_name;
    END IF;

    v_prep_lines := v_prep_lines || jsonb_build_array(jsonb_build_object(
      'source_purchase_line_id', v_src_line.id,
      'item_id', v_src_line.item_id,
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
      'gst_rate', v_src_line.gst_rate
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
      purchase_id, line_no, item_id, source_purchase_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total
    )
    VALUES (
      v_pr.id, v_i + 1, (v_pl->>'item_id')::uuid, (v_pl->>'source_purchase_line_id')::uuid,
      v_pl->>'item_name', NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'unit_cost')::numeric,
      (v_pl->>'discount_pct')::numeric, (v_pl->>'tax_inclusive')::boolean,
      (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric
    );

    INSERT INTO public.stock_ledger (
      item_id, movement_type, movement_date, entered_qty, entered_unit_id,
      conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
      source_table, source_id, created_by
    )
    VALUES (
      (v_pl->>'item_id')::uuid,
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

CREATE OR REPLACE FUNCTION public.void_purchase(
  p_purchase_id uuid,
  p_reason text
)
RETURNS public.purchase_bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_clean_reason text;
  v_pb public.purchase_bills;
  v_line public.purchase_lines;
  v_ledger public.party_ledger_entries;
  v_rev_entry public.party_ledger_entries;
  v_alloc_count integer := 0;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('purchases');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Only Owner or Manager can void posted purchase bills.';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter a clear void reason (minimum 3 characters).';
  END IF;

  SELECT * INTO v_pb FROM public.purchase_bills WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase document not found.';
  END IF;
  IF v_pb.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted purchase documents can be voided.';
  END IF;
  IF v_pb.doc_type = 'purchase_return' THEN
    RAISE EXCEPTION 'Purchase returns cannot be voided directly.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.purchase_bills
    WHERE source_purchase_id = p_purchase_id AND status = 'posted'
  ) THEN
    RAISE EXCEPTION 'Cannot void this purchase because a Purchase Return has been recorded against it.';
  END IF;

  SELECT * INTO v_ledger
  FROM public.party_ledger_entries
  WHERE source_table = 'purchase_bills'
    AND source_id = p_purchase_id
    AND entry_type = 'purchase'
    AND is_reversed = false
  FOR UPDATE;

  IF FOUND THEN
    SELECT count(*) INTO v_alloc_count
    FROM public.payment_allocations
    WHERE ledger_entry_id = v_ledger.id AND is_reversed = false;
    IF v_alloc_count > 0 THEN
      RAISE EXCEPTION 'Cannot void purchase with active payment allocations. Reverse the linked payment first.';
    END IF;
  END IF;

  PERFORM set_config('app.purchase_rpc_context', txid_current()::text, true);

  FOR v_line IN SELECT * FROM public.purchase_lines WHERE purchase_id = p_purchase_id ORDER BY line_no
  LOOP
    INSERT INTO public.stock_ledger (
      item_id, movement_type, movement_date, entered_qty, entered_unit_id,
      conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
      source_table, source_id, created_by
    )
    VALUES (
      v_line.item_id,
      'purchase_return',
      CURRENT_DATE,
      v_line.entered_qty,
      v_line.entered_unit_id,
      v_line.conversion_factor,
      -v_line.base_qty,
      round((v_line.taxable_amount / NULLIF(v_line.base_qty, 0)), 2),
      'Void Purchase ' || v_pb.purchase_number || ' (' || v_clean_reason || ')',
      v_pb.purchase_number,
      'purchase_bills',
      v_pb.id,
      auth.uid()
    );
  END LOOP;

  IF v_ledger.id IS NOT NULL THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, reference_no,
      source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      v_ledger.party_id,
      'adjustment',
      CURRENT_DATE,
      v_pb.purchase_number,
      'purchase_bills',
      v_pb.id,
      -v_ledger.signed_amount,
      'Void Reversal for Purchase ' || v_pb.purchase_number || ' (' || v_clean_reason || ')',
      auth.uid()
    )
    RETURNING * INTO v_rev_entry;

    UPDATE public.party_ledger_entries
    SET is_reversed = true, reversed_by_entry_id = v_rev_entry.id
    WHERE id = v_ledger.id;
  END IF;

  UPDATE public.purchase_bills
  SET
    status = 'voided',
    void_reason = v_clean_reason,
    voided_at = now(),
    voided_by = auth.uid(),
    balance_due = 0
  WHERE id = p_purchase_id
  RETURNING * INTO v_pb;

  PERFORM set_config('app.purchase_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'purchase.voided', 'purchase_bill', p_purchase_id::text,
    jsonb_build_object('purchase_number', v_pb.purchase_number, 'reason', v_clean_reason)
  );

  RETURN v_pb;
END;
$$;

CREATE OR REPLACE VIEW public.purchase_list_view AS
SELECT
  pb.id,
  pb.purchase_number,
  pb.doc_type,
  pb.status,
  pb.payment_status,
  pb.source_purchase_id,
  spb.purchase_number AS source_purchase_number,
  pb.party_id,
  pb.party_name,
  pb.party_phone,
  pb.party_gstin,
  pb.supplier_invoice_no,
  pb.supplier_invoice_date,
  pb.place_of_supply_state_code,
  pb.is_interstate,
  pb.bill_date,
  pb.due_date,
  pb.gst_applied,
  pb.subtotal_taxable,
  pb.discount_total,
  pb.cgst_total,
  pb.sgst_total,
  pb.igst_total,
  pb.tax_total,
  pb.freight_charges,
  pb.round_off,
  pb.grand_total,
  pb.paid_amount,
  pb.credited_amount,
  pb.balance_due,
  pb.payment_mode,
  pb.payment_reference,
  pb.attachment_file_id,
  pb.notes,
  pb.posted_at,
  pb.created_at,
  pb.updated_at,
  (SELECT count(*)::integer FROM public.purchase_lines pl WHERE pl.purchase_id = pb.id) AS line_count
FROM public.purchase_bills pb
LEFT JOIN public.purchase_bills spb ON spb.id = pb.source_purchase_id
WHERE public.is_module_enabled('purchases')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'accountant']);

ALTER VIEW public.purchase_list_view SET (security_invoker = false);

CREATE OR REPLACE VIEW public.purchase_summary_view AS
SELECT
  COALESCE(SUM(pb.grand_total) FILTER (
    WHERE pb.status = 'posted' AND pb.doc_type = 'purchase_bill' AND pb.bill_date = CURRENT_DATE
  ), 0)::numeric(15,2) AS today_purchases,
  COALESCE(SUM(pb.grand_total) FILTER (
    WHERE pb.status = 'posted' AND pb.doc_type = 'purchase_bill'
      AND date_trunc('month', pb.bill_date) = date_trunc('month', CURRENT_DATE)
  ), 0)::numeric(15,2) AS month_purchases,
  COALESCE(SUM(pb.grand_total) FILTER (
    WHERE pb.status = 'posted' AND pb.doc_type = 'purchase_return'
      AND date_trunc('month', pb.bill_date) = date_trunc('month', CURRENT_DATE)
  ), 0)::numeric(15,2) AS month_returns,
  COALESCE(SUM(pb.balance_due) FILTER (
    WHERE pb.status = 'posted' AND pb.doc_type = 'purchase_bill' AND pb.balance_due > 0
  ), 0)::numeric(15,2) AS total_unpaid_payables,
  count(*) FILTER (
    WHERE pb.status = 'posted' AND pb.doc_type = 'purchase_bill' AND pb.balance_due > 0
  )::integer AS unpaid_purchases_count,
  count(*) FILTER (WHERE pb.status = 'draft')::integer AS drafts_count
FROM public.purchase_bills pb
HAVING public.is_module_enabled('purchases')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'accountant']);

ALTER VIEW public.purchase_summary_view SET (security_invoker = false);

-- ============================================================================
-- 6. Expenses & Categories (Cashier Own-Only Enforcement)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_en text NOT NULL,
  name_hi text NOT NULL,
  is_system boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.expense_categories (code, name_en, name_hi, is_system) VALUES
  ('rent', 'Shop Rent', 'दुकान किराया', true),
  ('electricity', 'Electricity & Water', 'बिजली और पानी', true),
  ('salary', 'Staff Salary & Wages', 'स्टाफ वेतन', true),
  ('transport', 'Transport & Delivery', 'परिवहन और डिलीवरी', true),
  ('packing', 'Packing & Supplies', 'पैकिंग सामग्री', true),
  ('maintenance', 'Repairs & Maintenance', 'मरम्मत और रखरखाव', true),
  ('telecom', 'Phone & Internet', 'फ़ोन और इंटरनेट', true),
  ('hospitality', 'Tea & Staff Welfare', 'चाय-पानी और आतिथ्य', true),
  ('misc', 'Miscellaneous Expense', 'अन्य खर्च', true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_number text NOT NULL UNIQUE,
  category_id uuid NOT NULL REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  payment_mode text NOT NULL DEFAULT 'cash'
    CHECK (payment_mode IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other')),
  reference_no text,
  paid_to text,
  notes text,
  attachment_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided')),
  void_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON public.expenses (expense_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON public.expenses (category_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_created_by ON public.expenses (created_by, expense_date DESC);

DROP TRIGGER IF EXISTS trg_expenses_updated_at ON public.expenses;
CREATE TRIGGER trg_expenses_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.guard_immutable_expenses()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_rpc boolean := COALESCE(current_setting('app.expense_rpc_context', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted expenses cannot be deleted; use void_expense instead.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NOT v_in_rpc THEN
      RAISE EXCEPTION 'Posted expenses can only be updated via expense RPCs.';
    END IF;
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'A voided expense cannot be modified.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_expenses_immutable ON public.expenses;
CREATE TRIGGER trg_guard_expenses_immutable
  BEFORE UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_expenses();

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
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  PERFORM set_config('app.expense_rpc_context', txid_current()::text, true);

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.expenses WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expense not found.';
    END IF;
    IF v_role = 'cashier' AND v_existing.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Cashiers can only edit their own expense entries.';
    END IF;
    IF v_existing.status = 'voided' THEN
      RAISE EXCEPTION 'Voided expenses cannot be edited.';
    END IF;

    UPDATE public.expenses
    SET
      category_id = p_category_id,
      expense_date = v_date,
      amount = v_amt,
      payment_mode = v_mode,
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
      NULLIF(trim(COALESCE(p_reference_no, '')), ''),
      NULLIF(trim(COALESCE(p_paid_to, '')), ''),
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      p_attachment_file_id, v_idemp, auth.uid()
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
    jsonb_build_object(
      'expense_number', v_exp.expense_number,
      'amount', v_exp.amount,
      'payment_mode', v_exp.payment_mode,
      'expense_date', v_exp.expense_date
    )
  );

  RETURN v_exp;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_expense(
  p_expense_id uuid,
  p_reason text
)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_clean_reason text;
  v_exp public.expenses;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('expenses');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can void expenses.';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter a void reason (minimum 3 characters).';
  END IF;

  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found.';
  END IF;
  IF v_exp.status = 'voided' THEN
    RAISE EXCEPTION 'Expense is already voided.';
  END IF;

  PERFORM set_config('app.expense_rpc_context', txid_current()::text, true);
  UPDATE public.expenses
  SET status = 'voided',
      void_reason = v_clean_reason,
      voided_at = now(),
      voided_by = auth.uid()
  WHERE id = p_expense_id
  RETURNING * INTO v_exp;
  PERFORM set_config('app.expense_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'expense.voided', 'expense', p_expense_id::text,
    jsonb_build_object('expense_number', v_exp.expense_number, 'amount', v_exp.amount, 'reason', v_clean_reason)
  );

  RETURN v_exp;
END;
$$;

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

CREATE OR REPLACE VIEW public.expense_summary_view AS
SELECT
  COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'posted' AND e.expense_date = CURRENT_DATE), 0)::numeric(15,2) AS today_expenses,
  COALESCE(SUM(e.amount) FILTER (
    WHERE e.status = 'posted'
      AND date_trunc('month', e.expense_date) = date_trunc('month', CURRENT_DATE)
  ), 0)::numeric(15,2) AS month_expenses,
  COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'posted' AND e.payment_mode = 'cash' AND e.expense_date = CURRENT_DATE), 0)::numeric(15,2) AS today_cash_expenses,
  count(*) FILTER (WHERE e.status = 'posted')::integer AS posted_count
FROM public.expenses e
WHERE public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
   OR (public.current_user_role() = 'cashier' AND e.created_by = auth.uid())
HAVING public.is_module_enabled('expenses')
  AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']);

ALTER VIEW public.expense_summary_view SET (security_invoker = false);

-- ============================================================================
-- 7. Row-Level Security & Least-Privilege Grants
-- ============================================================================
ALTER TABLE public.purchase_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.purchase_bills FROM anon, authenticated;
REVOKE ALL ON public.purchase_lines FROM anon, authenticated;
REVOKE ALL ON public.expense_categories FROM anon, authenticated;
REVOKE ALL ON public.expenses FROM anon, authenticated;

GRANT SELECT ON public.purchase_bills TO authenticated;
GRANT SELECT ON public.purchase_lines TO authenticated;
GRANT SELECT ON public.purchase_list_view TO authenticated;
GRANT SELECT ON public.purchase_summary_view TO authenticated;
GRANT SELECT ON public.expense_categories TO authenticated;
GRANT SELECT ON public.expenses TO authenticated;
GRANT SELECT ON public.expense_list_view TO authenticated;
GRANT SELECT ON public.expense_summary_view TO authenticated;

GRANT EXECUTE ON FUNCTION public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text,
  text, boolean, text, integer, text, integer, numeric, boolean,
  text, integer, text, integer, text, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION public._prepare_purchase_payload(uuid, text, boolean, numeric, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_purchase_draft(uuid, uuid, text, date, date, date, text, boolean, numeric, boolean, boolean, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_purchase_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_purchase(uuid, uuid, text, date, date, date, text, boolean, numeric, boolean, boolean, text, uuid, jsonb, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_purchase_return(uuid, jsonb, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_purchase(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_expense(uuid, uuid, date, numeric, text, text, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(uuid, text) TO authenticated;

DROP POLICY IF EXISTS "Purchase roles read purchase_bills" ON public.purchase_bills;
CREATE POLICY "Purchase roles read purchase_bills" ON public.purchase_bills
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('purchases')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'accountant'])
  );

DROP POLICY IF EXISTS "Purchase roles read purchase_lines" ON public.purchase_lines;
CREATE POLICY "Purchase roles read purchase_lines" ON public.purchase_lines
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('purchases')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'accountant'])
  );

DROP POLICY IF EXISTS "Authenticated read expense_categories" ON public.expense_categories;
CREATE POLICY "Authenticated read expense_categories" ON public.expense_categories
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

DROP POLICY IF EXISTS "Expense roles read expenses" ON public.expenses;
CREATE POLICY "Expense roles read expenses" ON public.expenses
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('expenses')
    AND (
      public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
      OR (public.current_user_role() = 'cashier' AND created_by = auth.uid())
    )
  );
