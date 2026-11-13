-- BizOne ERP - Phase P1–P4 Audit Root Fixes (0007)
-- Idempotent function & trigger fixes:
--   1. sync_bill_paid_on_allocation_change(): preserve outer app.bill_rpc_context instead of resetting to '0'.
--   2. issue_bill(): reject immediate payment > 0 on party bills when 'payments' module is disabled.
--   3. convert_quotation_to_bill(): check idempotency key under advisory lock before status check.
--   4. create_sales_return(): apply only unrefunded credit (grand_total - refund_amount) to source invoice credited_amount
--      so bills.balance_due, party_open_obligations, and party_balances.net_balance always reconcile 100%;
--      and require 'payments' module when refund_amount > 0 on a party bill.
--   5. sync_own_email() & guard_profiles_integrity(): prevent direct client JWT spoofing of profiles.id / profiles.email.
--   6. Harden all app.*_context GUCs with txid_current()::text instead of static '1' so pooled connections
--      or prior session state can never satisfy immutability trigger checks across transactions.

-- 0. Harden immutability triggers with transaction-scoped txid_current()::text tokens
CREATE OR REPLACE FUNCTION public.guard_immutable_bills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_rpc boolean := current_setting('app.bill_rpc_context', true) = txid_current()::text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Issued, voided, or converted bills cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF NOT v_in_rpc THEN
      RAISE EXCEPTION 'Issued, voided, or converted bills are immutable.';
    END IF;

    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'A voided bill cannot be modified.';
    END IF;

    IF NEW.bill_number IS DISTINCT FROM OLD.bill_number
       OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
       OR NEW.source_bill_id IS DISTINCT FROM OLD.source_bill_id
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
       OR NEW.extra_charges IS DISTINCT FROM OLD.extra_charges
       OR NEW.round_off IS DISTINCT FROM OLD.round_off
       OR NEW.grand_total IS DISTINCT FROM OLD.grand_total
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
       OR NEW.business_snapshot IS DISTINCT FROM OLD.business_snapshot THEN
      RAISE EXCEPTION 'Financial totals and identity of an issued bill cannot be altered.';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (
        (OLD.status = 'issued' AND NEW.status = 'voided')
        OR (OLD.status = 'issued' AND OLD.doc_type = 'quotation' AND NEW.status = 'converted')
      ) THEN
        RAISE EXCEPTION 'Invalid status transition from % to %.', OLD.status, NEW.status;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_immutable_bill_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bill_id uuid;
  v_status text;
  v_in_init boolean := current_setting('app.bill_line_init', true) = txid_current()::text;
BEGIN
  v_bill_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.bill_id ELSE NEW.bill_id END;
  SELECT status INTO v_status FROM public.bills WHERE id = v_bill_id;

  IF v_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status <> 'draft' AND NOT (TG_OP = 'INSERT' AND v_in_init) THEN
    RAISE EXCEPTION 'Bill lines of an issued, voided, or converted document are immutable.';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- 1. Preserve app.bill_rpc_context in allocation sync trigger
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
  v_prev_ctx text;
BEGIN
  v_ledger_id := COALESCE(NEW.ledger_entry_id, OLD.ledger_entry_id);
  IF v_ledger_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT * INTO v_le FROM public.party_ledger_entries WHERE id = v_ledger_id;
  IF NOT FOUND OR v_le.source_table <> 'bills' OR v_le.source_id IS NULL OR v_le.entry_type <> 'bill' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

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

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 2. Harden issue_bill() when 'payments' module is disabled on party bills
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
      v_paid, 0, v_balance, NULLIF(trim(COALESCE(p_notes, '')), ''),
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
          COALESCE(NULLIF(trim(COALESCE(p_payment_mode, '')), ''), 'cash'),
          v_bill_date,
          COALESCE(NULLIF(trim(COALESCE(p_payment_reference, '')), ''), v_bill.bill_number),
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
      'balance_due', v_balance
    )
  );

  SELECT * INTO v_bill FROM public.bills WHERE id = v_bill.id;
  RETURN v_bill;
END;
$$;

-- 3. Fix convert_quotation_to_bill() idempotency check order
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation not found.';
  END IF;
  IF v_quote.doc_type <> 'quotation' THEN
    RAISE EXCEPTION 'Only quotations can be converted.';
  END IF;
  IF v_quote.status <> 'issued' THEN
    RAISE EXCEPTION 'Only open issued quotations can be converted (current status: %).', v_quote.status;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_target_type := COALESCE(NULLIF(trim(COALESCE(p_doc_type, '')), ''), CASE WHEN v_biz.gst_registered THEN 'tax_invoice' ELSE 'bill_of_supply' END);
  IF v_target_type NOT IN ('tax_invoice', 'bill_of_supply') THEN
    RAISE EXCEPTION 'Converted bill must be tax_invoice or bill_of_supply.';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'item_id', bl.item_id,
    'entered_qty', bl.entered_qty,
    'entered_unit_id', bl.entered_unit_id,
    'unit_price', bl.unit_price,
    'discount_pct', bl.discount_pct,
    'tax_inclusive', bl.tax_inclusive
  ) ORDER BY bl.line_no ASC)
  INTO v_lines
  FROM public.bill_lines bl
  WHERE bl.bill_id = p_quotation_id;

  v_new_bill := public.issue_bill(
    NULL,
    v_target_type,
    v_quote.party_id,
    COALESCE(p_bill_date, CURRENT_DATE),
    p_due_date,
    NULL,
    v_quote.place_of_supply_state_code,
    v_quote.extra_charges,
    v_quote.auto_round_off,
    v_quote.notes,
    v_quote.terms,
    v_lines,
    p_paid_amount,
    p_payment_mode,
    p_payment_reference,
    v_idemp
  );

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  UPDATE public.bills
  SET status = 'converted',
      converted_to_bill_id = v_new_bill.id
  WHERE id = p_quotation_id;

  UPDATE public.bills
  SET converted_from_quotation_id = p_quotation_id
  WHERE id = v_new_bill.id;
  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'quotation.converted', 'bill', p_quotation_id::text,
    jsonb_build_object('quotation_number', v_quote.bill_number, 'bill_id', v_new_bill.id, 'bill_number', v_new_bill.bill_number)
  );

  SELECT * INTO v_new_bill FROM public.bills WHERE id = v_new_bill.id;
  RETURN v_new_bill;
END;
$$;

-- 4. Fix create_sales_return() credited_amount vs refund reconciliation
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
  v_prep_lines jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_cn_number text;
  v_cn public.bills;
  v_grand numeric(15,2);
  v_refund numeric(15,2);
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

  -- Only the unrefunded portion of the credit note reduces unpaid invoice due
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
        COALESCE(NULLIF(trim(COALESCE(p_refund_mode, '')), ''), 'cash'),
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
    auth.uid(), v_actor_email,
    'bill.credit_note_created', 'bill', v_cn.id::text,
    jsonb_build_object(
      'credit_note_number', v_cn.bill_number,
      'source_bill_id', v_source.id,
      'source_bill_number', v_source.bill_number,
      'grand_total', v_grand,
      'refund_amount', v_refund,
      'credit_applied', v_credit_applied,
      'reason', v_clean_reason
    )
  );

  RETURN v_cn;
END;
$$;

-- 5. Harden profiles.email & profiles.id integrity on JWT updates
CREATE OR REPLACE FUNCTION public.sync_own_email()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_email text;
  v_old_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required.';
  END IF;

  SELECT email INTO v_auth_email FROM auth.users WHERE id = auth.uid();
  SELECT email INTO v_old_email FROM public.profiles WHERE id = auth.uid();

  IF v_auth_email IS NOT NULL AND v_old_email IS DISTINCT FROM v_auth_email THEN
    PERFORM set_config('app.profile_sync_context', txid_current()::text, true);
    UPDATE public.profiles SET email = v_auth_email WHERE id = auth.uid();
    PERFORM set_config('app.profile_sync_context', '', true);
    INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
    VALUES (
      auth.uid(),
      v_auth_email,
      'profile.email_verified',
      'profile',
      auth.uid()::text,
      jsonb_build_object('previous_email', v_old_email, 'new_email', v_auth_email)
    );
  END IF;

  RETURN COALESCE(v_auth_email, v_old_email);
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_profiles_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_other_owners integer;
  v_caller_is_owner boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Profile ID cannot be modified.';
    END IF;

    IF OLD.role = 'owner' AND OLD.is_active = true AND (NEW.role <> 'owner' OR NEW.is_active = false) THEN
      SELECT count(*) INTO v_other_owners
      FROM public.profiles
      WHERE role = 'owner' AND is_active = true AND id <> OLD.id;
      IF v_other_owners = 0 THEN
        RAISE EXCEPTION 'The last active Owner cannot be deactivated or demoted.';
      END IF;
    END IF;

    IF auth.uid() IS NOT NULL THEN
      SELECT public.is_owner() INTO v_caller_is_owner;
      IF NOT v_caller_is_owner AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
        RAISE EXCEPTION 'Only an Owner can change user roles or activation status.';
      END IF;
      IF NEW.email IS DISTINCT FROM OLD.email
         AND current_setting('app.profile_sync_context', true) IS DISTINCT FROM txid_current()::text THEN
        RAISE EXCEPTION 'Profile email can only change after email verification.';
      END IF;
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' AND OLD.is_active = true AND auth.uid() IS NOT NULL THEN
      SELECT count(*) INTO v_other_owners
      FROM public.profiles
      WHERE role = 'owner' AND is_active = true AND id <> OLD.id;
      IF v_other_owners = 0 THEN
        RAISE EXCEPTION 'The last active Owner cannot be deleted.';
      END IF;
    END IF;

    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

-- 6. Harden void_bill() with txid_current()::text context token
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found.';
  END IF;

  IF v_bill.status <> 'issued' THEN
    RAISE EXCEPTION 'Only issued documents can be voided (current status: %).', v_bill.status;
  END IF;

  IF v_bill.doc_type = 'credit_note' THEN
    RAISE EXCEPTION 'Credit notes cannot be voided directly.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bills c
    WHERE c.source_bill_id = p_bill_id AND c.doc_type = 'credit_note' AND c.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'Cannot void a bill that has active credit notes / sales returns.';
  END IF;

  IF v_bill.party_id IS NOT NULL AND v_bill.paid_amount > 0 THEN
    RAISE EXCEPTION 'This bill has allocated payments (₹%). Reverse the linked payment(s) first before voiding.', v_bill.paid_amount;
  END IF;

  IF v_bill.doc_type IN ('tax_invoice', 'bill_of_supply') THEN
    FOR v_line IN SELECT * FROM public.bill_lines WHERE bill_id = p_bill_id ORDER BY line_no
    LOOP
      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        v_line.item_id,
        'adjustment_in',
        CURRENT_DATE,
        v_line.entered_qty,
        v_line.entered_unit_id,
        v_line.conversion_factor,
        v_line.base_qty,
        (SELECT purchase_price FROM public.items WHERE id = v_line.item_id),
        'Voided ' || v_bill.bill_number || ': ' || v_clean_reason,
        v_bill.bill_number || '-VOID',
        'bills',
        v_bill.id,
        auth.uid()
      );
    END LOOP;
  END IF;

  IF v_bill.party_id IS NOT NULL THEN
    SELECT * INTO v_orig_le
    FROM public.party_ledger_entries
    WHERE source_table = 'bills' AND source_id = p_bill_id AND entry_type = 'bill' AND is_reversed = false
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      INSERT INTO public.party_ledger_entries (
        party_id, entry_type, entry_date, reference_no,
        source_table, source_id, signed_amount, note, created_by
      )
      VALUES (
        v_bill.party_id,
        'adjustment',
        CURRENT_DATE,
        v_bill.bill_number || '-VOID',
        'bills',
        v_bill.id,
        -v_orig_le.signed_amount,
        'Voided bill ' || v_bill.bill_number || ': ' || v_clean_reason,
        auth.uid()
      )
      RETURNING * INTO v_rev_le;

      UPDATE public.party_ledger_entries
      SET is_reversed = true, reversed_by_entry_id = v_rev_le.id
      WHERE id = v_orig_le.id;
    END IF;
  END IF;

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  UPDATE public.bills
  SET
    status = 'voided',
    balance_due = 0,
    void_reason = v_clean_reason,
    voided_at = now(),
    voided_by = auth.uid()
  WHERE id = p_bill_id
  RETURNING * INTO v_updated;
  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'bill.voided', 'bill', v_bill.id::text,
    jsonb_build_object('bill_number', v_bill.bill_number, 'reason', v_clean_reason, 'grand_total', v_bill.grand_total)
  );

  RETURN v_updated;
END;
$$;
