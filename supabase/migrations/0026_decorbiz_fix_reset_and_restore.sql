-- DecorBiz Migration 0026:
-- 1. Fix "DELETE requires a WHERE clause" (pg_safeupdate) in reset_workspace_data() and restore_workspace_backup()
-- 2. Safely clear Step 2-4 dependent tables (store orders, breakage returns, sample issues, rate cards, commissions, variants, item specs) before items/parties/bills

CREATE OR REPLACE FUNCTION public.reset_workspace_data(p_confirm_phrase text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
  v_tbl text;
  v_optional_tables text[] := ARRAY[
    'store_order_lines',
    'store_orders',
    'customer_wishlists',
    'product_reviews',
    'breakage_returns',
    'sample_issues',
    'contractor_rate_cards',
    'commission_entries',
    'supplier_price_lists',
    'erp_delivery_trips',
    'item_specs_tiles_slabs',
    'item_specs_sanitaryware',
    'item_specs_faucets_cp',
    'item_specs_tile_adhesive',
    'item_specs_other_general',
    'item_variants'
  ];
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the business Owner can reset the workspace.';
  END IF;
  IF trim(COALESCE(p_confirm_phrase, '')) <> 'RESET WORKSPACE' THEN
    RAISE EXCEPTION 'Type exact confirmation phrase "RESET WORKSPACE" to proceed.';
  END IF;

  PERFORM set_config('app.restore_context', txid_current()::text, true);

  FOREACH v_tbl IN ARRAY v_optional_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE true', v_tbl);
    END IF;
  END LOOP;

  DELETE FROM public.bank_reconciliations WHERE true;
  DELETE FROM public.voucher_entries WHERE true;
  DELETE FROM public.vouchers WHERE true;
  DELETE FROM public.einvoice_records WHERE true;
  DELETE FROM public.gstr2b_entries WHERE true;
  DELETE FROM public.tds_entries WHERE true;
  DELETE FROM public.stock_transfers WHERE true;
  DELETE FROM public.physical_stock_counts WHERE true;
  DELETE FROM public.location_stock_balances WHERE true;
  DELETE FROM public.pos_held_bills WHERE true;
  DELETE FROM public.pos_cash_registers WHERE true;
  DELETE FROM public.sales_orders WHERE true;
  DELETE FROM public.recurring_rules WHERE true;
  DELETE FROM public.leads WHERE true;
  DELETE FROM public.cheque_register WHERE true;
  DELETE FROM public.message_logs WHERE true;
  DELETE FROM public.ai_action_proposals WHERE true;
  DELETE FROM public.ai_messages WHERE true;
  DELETE FROM public.ai_conversations WHERE true;
  DELETE FROM public.file_links WHERE true;
  DELETE FROM public.bill_share_links WHERE true;
  DELETE FROM public.hardware_estimates WHERE true;
  DELETE FROM public.bill_lines WHERE true;
  DELETE FROM public.purchase_lines WHERE true;
  DELETE FROM public.payment_allocations WHERE true;
  DELETE FROM public.party_ledger_entries WHERE true;
  DELETE FROM public.payments WHERE true;
  DELETE FROM public.stock_ledger WHERE true;
  DELETE FROM public.stock_balances WHERE true;
  DELETE FROM public.bills WHERE true;
  DELETE FROM public.purchase_bills WHERE true;
  DELETE FROM public.expenses WHERE true;
  DELETE FROM public.item_images WHERE true;
  DELETE FROM public.unit_conversions WHERE true;
  DELETE FROM public.items WHERE true;
  DELETE FROM public.item_categories WHERE true;
  DELETE FROM public.brands WHERE true;
  DELETE FROM public.party_sites WHERE true;
  DELETE FROM public.party_addresses WHERE true;
  DELETE FROM public.parties WHERE true;
  DELETE FROM public.numbering_series WHERE true;
  DELETE FROM public.notifications WHERE true;

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
  v_tbl text;
  v_dest text := CASE WHEN p_destination = 'google_drive' THEN 'google_drive' ELSE 'local' END;
  v_optional_tables text[] := ARRAY[
    'store_order_lines',
    'store_orders',
    'customer_wishlists',
    'product_reviews',
    'breakage_returns',
    'sample_issues',
    'contractor_rate_cards',
    'commission_entries',
    'supplier_price_lists',
    'erp_delivery_trips',
    'item_specs_tiles_slabs',
    'item_specs_sanitaryware',
    'item_specs_faucets_cp',
    'item_specs_tile_adhesive',
    'item_specs_other_general',
    'item_variants'
  ];
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

  FOREACH v_tbl IN ARRAY v_optional_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE true', v_tbl);
    END IF;
  END LOOP;

  DELETE FROM public.bank_reconciliations WHERE true;
  DELETE FROM public.voucher_entries WHERE true;
  DELETE FROM public.vouchers WHERE true;
  DELETE FROM public.einvoice_records WHERE true;
  DELETE FROM public.gstr2b_entries WHERE true;
  DELETE FROM public.tds_entries WHERE true;
  DELETE FROM public.stock_transfers WHERE true;
  DELETE FROM public.physical_stock_counts WHERE true;
  DELETE FROM public.location_stock_balances WHERE true;
  DELETE FROM public.pos_held_bills WHERE true;
  DELETE FROM public.pos_cash_registers WHERE true;
  DELETE FROM public.sales_orders WHERE true;
  DELETE FROM public.recurring_rules WHERE true;
  DELETE FROM public.leads WHERE true;
  DELETE FROM public.cheque_register WHERE true;
  DELETE FROM public.file_links WHERE true;
  DELETE FROM public.bill_share_links WHERE true;
  DELETE FROM public.hardware_estimates WHERE true;
  DELETE FROM public.bill_lines WHERE true;
  DELETE FROM public.purchase_lines WHERE true;
  DELETE FROM public.payment_allocations WHERE true;
  DELETE FROM public.party_ledger_entries WHERE true;
  DELETE FROM public.payments WHERE true;
  DELETE FROM public.stock_ledger WHERE true;
  DELETE FROM public.stock_balances WHERE true;
  DELETE FROM public.bills WHERE true;
  DELETE FROM public.purchase_bills WHERE true;
  DELETE FROM public.expenses WHERE true;
  DELETE FROM public.item_images WHERE true;
  DELETE FROM public.unit_conversions WHERE true;
  DELETE FROM public.items WHERE true;
  DELETE FROM public.item_categories WHERE true;
  DELETE FROM public.brands WHERE true;
  DELETE FROM public.party_sites WHERE true;
  DELETE FROM public.party_addresses WHERE true;
  DELETE FROM public.parties WHERE true;
  DELETE FROM public.numbering_series WHERE true;

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

  IF to_regclass('public.store_order_lines') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.store_order_lines WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.breakage_returns') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.breakage_returns WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.sample_issues') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.sample_issues WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.contractor_rate_cards') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.contractor_rate_cards WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true) OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.supplier_price_lists') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.supplier_price_lists WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true) OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true)';
  END IF;

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

GRANT EXECUTE ON FUNCTION public.reset_workspace_data(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_workspace_backup(jsonb, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_demo_data() TO authenticated;

NOTIFY pgrst, 'reload schema';
