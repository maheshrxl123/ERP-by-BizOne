-- BizOne ERP - Phase P4: Billing & Sales
-- Single-business architecture: Tax Invoices, Bills of Supply, Quotations, Credit Notes (Sales Returns),
-- FY-locked document numbering synced with Invoice Settings (S3), authoritative server tax/round-off math,
-- immutable issued bills & lines, stock deduction/restoration, Khata/Payments reconciliation,
-- role-gated price/discount overrides, share links with revocation, and strict RLS.

-- 1. Extend public.business with Phase 4 Invoice Settings (S3) & Cashier Override Policy
ALTER TABLE public.business
  ADD COLUMN IF NOT EXISTS default_print_layout text NOT NULL DEFAULT 'a4'
    CHECK (default_print_layout IN ('a4', 'a5', 'thermal_80')),
  ADD COLUMN IF NOT EXISTS show_upi_qr_on_invoice boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS quotation_prefix text NOT NULL DEFAULT 'QTN-',
  ADD COLUMN IF NOT EXISTS quotation_next_number integer NOT NULL DEFAULT 1
    CHECK (quotation_next_number >= 1),
  ADD COLUMN IF NOT EXISTS credit_note_prefix text NOT NULL DEFAULT 'CN-',
  ADD COLUMN IF NOT EXISTS credit_note_next_number integer NOT NULL DEFAULT 1
    CHECK (credit_note_next_number >= 1),
  ADD COLUMN IF NOT EXISTS cashier_max_discount_pct numeric(5,2) NOT NULL DEFAULT 10.00
    CHECK (cashier_max_discount_pct >= 0 AND cashier_max_discount_pct <= 100),
  ADD COLUMN IF NOT EXISTS allow_cashier_price_override boolean NOT NULL DEFAULT false;

-- Backwards-compatible update_business_profile: preserves first 15 args from P1/0003 and appends S3 args
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
  p_allow_cashier_price_override boolean DEFAULT NULL
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
    allow_cashier_price_override = COALESCE(p_allow_cashier_price_override, allow_cashier_price_override)
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
      'default_print_layout', v_row.default_print_layout
    )
  );

  RETURN v_row;
END;
$$;

-- Drop old 15-arg overload if PostgreSQL created a second overload with 23 args
DROP FUNCTION IF EXISTS public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text
);

-- 2. Extend Document Numbering Series for Sales Invoices, Bills of Supply, Quotations & Credit Notes
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

  IF p_series_key IN ('tax_invoice', 'bill_of_supply', 'quotation', 'credit_note') THEN
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

  IF p_series_key IN ('tax_invoice', 'bill_of_supply', 'quotation', 'credit_note') THEN
    v_next := GREATEST(v_next, v_biz_next);
  END IF;

  UPDATE public.numbering_series
  SET prefix = v_prefix,
      next_number = v_next + 1,
      updated_at = now()
  WHERE series_key = v_effective_key AND fy_code = v_fy_code;

  -- Keep business settings counters aligned with issued sequence
  IF v_effective_key = 'tax_invoice' THEN
    UPDATE public.business SET invoice_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'quotation' THEN
    UPDATE public.business SET quotation_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'credit_note' THEN
    UPDATE public.business SET credit_note_next_number = v_next + 1 WHERE id = 1;
  END IF;

  RETURN v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0');
END;
$$;

-- 3. Bills, Bill Lines, and Share Links Tables
CREATE TABLE IF NOT EXISTS public.bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number text UNIQUE,
  doc_type text NOT NULL CHECK (doc_type IN ('tax_invoice', 'bill_of_supply', 'quotation', 'credit_note')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'voided', 'converted')),
  source_bill_id uuid REFERENCES public.bills(id) ON DELETE RESTRICT,
  converted_from_quotation_id uuid REFERENCES public.bills(id) ON DELETE RESTRICT,
  converted_to_bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  party_id uuid REFERENCES public.parties(id) ON DELETE RESTRICT,
  party_name text NOT NULL DEFAULT 'Walk-in Customer' CHECK (length(trim(party_name)) >= 1 AND length(party_name) <= 180),
  party_phone text,
  party_gstin text,
  party_address text,
  place_of_supply_state_code text,
  is_interstate boolean NOT NULL DEFAULT false,
  bill_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  valid_until date,
  gst_applied boolean NOT NULL DEFAULT false,
  subtotal_taxable numeric(15,2) NOT NULL DEFAULT 0 CHECK (subtotal_taxable >= 0),
  discount_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  cgst_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (cgst_total >= 0),
  sgst_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (sgst_total >= 0),
  igst_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (igst_total >= 0),
  tax_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  extra_charges numeric(15,2) NOT NULL DEFAULT 0 CHECK (extra_charges >= 0),
  auto_round_off boolean NOT NULL DEFAULT true,
  round_off numeric(15,2) NOT NULL DEFAULT 0,
  grand_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  paid_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  credited_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (credited_amount >= 0),
  balance_due numeric(15,2) NOT NULL DEFAULT 0 CHECK (balance_due >= 0),
  payment_status text GENERATED ALWAYS AS (
    CASE
      WHEN status = 'voided' THEN 'voided'
      WHEN status = 'draft' THEN 'draft'
      WHEN doc_type = 'quotation' THEN status
      WHEN doc_type = 'credit_note' THEN 'credited'
      WHEN balance_due <= 0 THEN 'paid'
      WHEN (paid_amount + credited_amount) > 0 THEN 'partial'
      ELSE 'unpaid'
    END
  ) STORED,
  notes text,
  terms text,
  business_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  void_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  return_reason text,
  idempotency_key text UNIQUE,
  is_demo boolean NOT NULL DEFAULT false,
  issued_at timestamptz,
  issued_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_bills_issued_number CHECK (status = 'draft' OR bill_number IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_bills_date_status ON public.bills (bill_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bills_doc_type_status ON public.bills (doc_type, status, bill_date DESC);
CREATE INDEX IF NOT EXISTS idx_bills_party ON public.bills (party_id, bill_date DESC) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_source ON public.bills (source_bill_id) WHERE source_bill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bills_number_trgm ON public.bills USING gin (bill_number gin_trgm_ops) WHERE bill_number IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bills_updated_at ON public.bills;
CREATE TRIGGER trg_bills_updated_at
  BEFORE UPDATE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no >= 1),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  source_bill_line_id uuid REFERENCES public.bill_lines(id) ON DELETE RESTRICT,
  item_name text NOT NULL,
  sku text,
  hsn_code text,
  entered_qty numeric(15,3) NOT NULL CHECK (entered_qty > 0),
  entered_unit_id uuid NOT NULL REFERENCES public.item_units(id) ON DELETE RESTRICT,
  entered_unit_code text NOT NULL,
  conversion_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  base_qty numeric(15,3) NOT NULL CHECK (base_qty > 0),
  catalog_unit_price numeric(15,2) NOT NULL DEFAULT 0 CHECK (catalog_unit_price >= 0),
  unit_price numeric(15,2) NOT NULL CHECK (unit_price >= 0),
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
  UNIQUE (bill_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_bill_lines_bill ON public.bill_lines (bill_id, line_no);
CREATE INDEX IF NOT EXISTS idx_bill_lines_item ON public.bill_lines (item_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_source ON public.bill_lines (source_bill_line_id) WHERE source_bill_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.bill_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (length(token) >= 24),
  expires_at timestamptz,
  is_revoked boolean NOT NULL DEFAULT false,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bill_share_links_bill ON public.bill_share_links (bill_id, created_at DESC);

-- 4. Strict Immutability Triggers for Issued / Voided / Converted Bills & Lines
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

    -- Core document identity, lines-derived totals, and snapshots remain strictly immutable
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

DROP TRIGGER IF EXISTS trg_guard_bills_immutable ON public.bills;
CREATE TRIGGER trg_guard_bills_immutable
  BEFORE UPDATE OR DELETE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_bills();

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

DROP TRIGGER IF EXISTS trg_guard_bill_lines_immutable ON public.bill_lines;
CREATE TRIGGER trg_guard_bill_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.bill_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_bill_lines();

-- 5. Authoritative Server Tax, Discount & Round-off Calculator (matches src/core/money.ts 1:1)
CREATE OR REPLACE FUNCTION public.compute_bill_amounts(
  p_gst_registered boolean,
  p_doc_type text,
  p_is_interstate boolean,
  p_extra_charges numeric,
  p_auto_round_off boolean,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gst_applied boolean;
  v_interstate boolean;
  v_line jsonb;
  v_qty numeric;
  v_price numeric;
  v_disc_pct numeric;
  v_gst_rate numeric;
  v_tax_incl boolean;
  v_gross numeric(15,2);
  v_disc_amt numeric(15,2);
  v_after_disc numeric(15,2);
  v_taxable numeric(15,2);
  v_tax numeric(15,2);
  v_cgst numeric(15,2);
  v_sgst numeric(15,2);
  v_igst numeric(15,2);
  v_line_total numeric(15,2);
  v_subtotal numeric(15,2) := 0;
  v_discount_total numeric(15,2) := 0;
  v_cgst_total numeric(15,2) := 0;
  v_sgst_total numeric(15,2) := 0;
  v_igst_total numeric(15,2) := 0;
  v_tax_total numeric(15,2) := 0;
  v_extra numeric(15,2);
  v_pre_round numeric(15,2);
  v_round_off numeric(15,2);
  v_grand numeric(15,2);
  v_calc_lines jsonb := '[]'::jsonb;
BEGIN
  v_gst_applied := COALESCE(p_gst_registered, false)
    AND public.is_module_enabled('tax')
    AND COALESCE(p_doc_type, 'tax_invoice') <> 'bill_of_supply';
  v_interstate := v_gst_applied AND COALESCE(p_is_interstate, false);

  FOR v_line IN SELECT value FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb))
  LOOP
    v_qty := GREATEST(0::numeric, COALESCE((v_line->>'entered_qty')::numeric, 0));
    v_price := GREATEST(0::numeric, round(COALESCE((v_line->>'unit_price')::numeric, 0), 2));
    v_disc_pct := LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_line->>'discount_pct')::numeric, 0), 2)));
    v_tax_incl := COALESCE((v_line->>'tax_inclusive')::boolean, false);
    v_gst_rate := CASE
      WHEN v_gst_applied THEN LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_line->>'gst_rate')::numeric, 0), 2)))
      ELSE 0::numeric
    END;

    v_gross := round((v_qty * v_price)::numeric, 2);
    v_disc_amt := round((v_gross * v_disc_pct / 100.0)::numeric, 2);
    v_after_disc := round((v_gross - v_disc_amt)::numeric, 2);

    v_taxable := v_after_disc;
    v_tax := 0;
    v_line_total := v_after_disc;

    IF v_gst_rate > 0 THEN
      IF v_tax_incl THEN
        v_taxable := round((v_after_disc / (1.0 + v_gst_rate / 100.0))::numeric, 2);
        v_tax := round((v_after_disc - v_taxable)::numeric, 2);
        v_line_total := v_after_disc;
      ELSE
        v_taxable := v_after_disc;
        v_tax := round((v_taxable * v_gst_rate / 100.0)::numeric, 2);
        v_line_total := round((v_taxable + v_tax)::numeric, 2);
      END IF;
    END IF;

    v_cgst := 0;
    v_sgst := 0;
    v_igst := 0;
    IF v_tax > 0 THEN
      IF v_interstate THEN
        v_igst := v_tax;
      ELSE
        v_cgst := round((v_tax / 2.0)::numeric, 2);
        v_sgst := round((v_tax - v_cgst)::numeric, 2);
      END IF;
    END IF;

    v_subtotal := round((v_subtotal + v_taxable)::numeric, 2);
    v_discount_total := round((v_discount_total + v_disc_amt)::numeric, 2);
    v_cgst_total := round((v_cgst_total + v_cgst)::numeric, 2);
    v_sgst_total := round((v_sgst_total + v_sgst)::numeric, 2);
    v_igst_total := round((v_igst_total + v_igst)::numeric, 2);

    v_calc_lines := v_calc_lines || jsonb_build_array(jsonb_build_object(
      'gross_amount', v_gross,
      'discount_amount', v_disc_amt,
      'taxable_amount', v_taxable,
      'cgst_amount', v_cgst,
      'sgst_amount', v_sgst,
      'igst_amount', v_igst,
      'tax_amount', v_tax,
      'line_total', v_line_total,
      'effective_gst_rate', v_gst_rate
    ));
  END LOOP;

  v_tax_total := round((v_cgst_total + v_sgst_total + v_igst_total)::numeric, 2);
  v_extra := GREATEST(0::numeric, round(COALESCE(p_extra_charges, 0)::numeric, 2));
  v_pre_round := round((v_subtotal + v_tax_total + v_extra)::numeric, 2);

  IF COALESCE(p_auto_round_off, true) THEN
    v_round_off := round((round(v_pre_round, 0) - v_pre_round)::numeric, 2);
  ELSE
    v_round_off := 0;
  END IF;
  v_grand := round((v_pre_round + v_round_off)::numeric, 2);

  RETURN jsonb_build_object(
    'gst_applied', v_gst_applied,
    'is_interstate', v_interstate,
    'subtotal_taxable', v_subtotal,
    'discount_total', v_discount_total,
    'cgst_total', v_cgst_total,
    'sgst_total', v_sgst_total,
    'igst_total', v_igst_total,
    'tax_total', v_tax_total,
    'extra_charges', v_extra,
    'round_off', v_round_off,
    'grand_total', v_grand,
    'lines', v_calc_lines
  );
END;
$$;

-- 6. Reconcile Party Open Obligations & Payment Allocations with Bills + Credit Notes
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
    + CASE WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0) ELSE 0 END
  )::numeric(15,2) AS settled_amount,
  GREATEST(
    abs(le.signed_amount)
    - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
    - CASE WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0) ELSE 0 END,
    0
  )::numeric(15,2) AS remaining_amount,
  CASE WHEN le.signed_amount > 0 THEN 'receive' ELSE 'give' END AS direction_needed,
  (
    GREATEST(
      abs(le.signed_amount)
      - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
      - CASE WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0) ELSE 0 END,
      0
    ) > 0
    AND le.due_date IS NOT NULL
    AND le.due_date < CURRENT_DATE
  ) AS is_overdue,
  le.created_at
FROM public.party_ledger_entries le
LEFT JOIN public.bills b
  ON le.source_table = 'bills' AND le.source_id = b.id
LEFT JOIN public.payment_allocations pa
  ON pa.ledger_entry_id = le.id AND pa.is_reversed = false
WHERE le.is_reversed = false
  AND le.entry_type IN ('opening_balance', 'khata_due', 'bill', 'purchase')
GROUP BY le.id, b.credited_amount
HAVING GREATEST(
  abs(le.signed_amount)
  - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
  - CASE WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0) ELSE 0 END,
  0
) > 0;

-- Keep bills.paid_amount and bills.balance_due synced whenever Khata payments allocate or reverse against a bill
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

DROP TRIGGER IF EXISTS trg_payment_allocations_sync_bill ON public.payment_allocations;
CREATE TRIGGER trg_payment_allocations_sync_bill
  AFTER INSERT OR UPDATE ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.sync_bill_paid_on_allocation_change();

-- Update post_payment so credited_amount on bills is subtracted when calculating remaining open due
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
  v_actor_email text;
  v_party public.parties;
  v_amt numeric(15,2);
  v_date date;
  v_idemp text;
  v_existing public.payments;
  v_payment public.payments;
  v_payment_no text;
  v_allocated_total numeric(15,2) := 0;
  v_advance_amt numeric(15,2) := 0;
  v_planned jsonb := '[]'::jsonb;
  v_alloc jsonb;
  v_plan_item jsonb;
  v_target_entry_id uuid;
  v_alloc_amt numeric(15,2);
  v_target_row public.party_ledger_entries;
  v_already_settled numeric(15,2);
  v_bill_credited numeric(15,2) := 0;
  v_remaining numeric(15,2);
  v_open_rec record;
  v_apply numeric(15,2);
  v_left_to_allocate numeric(15,2);
  v_signed_ledger numeric(15,2);
  v_seen_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM public.require_module('parties');
  PERFORM public.require_module('payments');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to record payments.';
  END IF;

  IF p_direction NOT IN ('receive', 'give') THEN
    RAISE EXCEPTION 'Payment direction must be receive or give.';
  END IF;

  IF p_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode: %', p_mode;
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
      IF v_existing.party_id <> p_party_id OR v_existing.direction <> p_direction OR v_existing.amount <> v_amt THEN
        RAISE EXCEPTION 'Idempotency key already used with different payment parameters.';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
  IF NOT FOUND OR NOT v_party.is_active THEN
    RAISE EXCEPTION 'Active party not found.';
  END IF;

  IF p_allocations IS NOT NULL AND jsonb_typeof(p_allocations) = 'array' AND jsonb_array_length(p_allocations) > 0 THEN
    FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
    LOOP
      v_target_entry_id := NULLIF(trim(COALESCE(v_alloc->>'ledger_entry_id', '')), '')::uuid;
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

      v_bill_credited := 0;
      IF v_target_row.source_table = 'bills' AND v_target_row.source_id IS NOT NULL THEN
        SELECT COALESCE(credited_amount, 0) INTO v_bill_credited FROM public.bills WHERE id = v_target_row.source_id;
      END IF;

      v_remaining := GREATEST(abs(v_target_row.signed_amount) - v_already_settled - v_bill_credited, 0);
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

-- 7. Internal Helpers for Resolving & Validating Bill Lines + Price/Discount Policy
CREATE OR REPLACE FUNCTION public._prepare_bill_payload(
  p_doc_type text,
  p_party_id uuid,
  p_place_of_supply text,
  p_extra_charges numeric,
  p_auto_round_off boolean,
  p_lines jsonb,
  p_actor_role text
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
    SELECT base_qty, conversion_factor
    INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id);

    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    v_catalog_price := round((v_item.selling_price * v_factor)::numeric, 2);
    v_unit_price := round(COALESCE(NULLIF(v_raw->>'unit_price', '')::numeric, v_catalog_price), 2);
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION 'Unit price for "%" cannot be negative.', v_item.name;
    END IF;

    v_disc_pct := round(COALESCE(NULLIF(v_raw->>'discount_pct', '')::numeric, 0), 2);
    IF v_disc_pct < 0 OR v_disc_pct > 100 THEN
      RAISE EXCEPTION 'Discount percentage for "%" must be between 0 and 100.', v_item.name;
    END IF;

    -- Server-side price & discount override enforcement
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
      'gst_rate', v_item.gst_rate
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
      'default_print_layout', v_biz.default_print_layout
    ),
    'prepared_lines', v_prepared_lines,
    'calc', v_calc
  );
END;
$$;

-- 8. Transactional RPCs for Billing & Sales

-- Save / Update Draft Bill or Draft Quotation
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
  p_lines jsonb DEFAULT '[]'::jsonb
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
  v_actor_email text;
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to create or edit bills.';
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_prep := public._prepare_bill_payload(
    p_doc_type, p_party_id, p_place_of_supply, p_extra_charges, p_auto_round_off, p_lines, v_role
  );
  v_calc := v_prep->'calc';

  IF p_id IS NULL THEN
    INSERT INTO public.bills (
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin,
      party_address, place_of_supply_state_code, is_interstate, bill_date, due_date,
      valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due, notes, terms, business_snapshot, created_by
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
      v_prep->'biz_snapshot', auth.uid()
    )
    RETURNING * INTO v_bill;
  ELSE
    SELECT * INTO v_existing FROM public.bills WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Draft bill not found.';
    END IF;
    IF v_existing.status <> 'draft' THEN
      RAISE EXCEPTION 'Only draft documents can be edited. Issued documents are immutable.';
    END IF;

    UPDATE public.bills
    SET
      doc_type = p_doc_type,
      party_id = p_party_id,
      party_name = v_prep->>'party_name',
      party_phone = v_prep->>'party_phone',
      party_gstin = v_prep->>'party_gstin',
      party_address = v_prep->>'party_address',
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_calc->>'is_interstate')::boolean,
      bill_date = COALESCE(p_bill_date, CURRENT_DATE),
      due_date = p_due_date,
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
      grand_total = (v_calc->>'grand_total')::numeric,
      balance_due = (v_calc->>'grand_total')::numeric,
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      terms = COALESCE(p_terms, v_biz.invoice_terms),
      business_snapshot = v_prep->'biz_snapshot'
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
  END LOOP;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NULL THEN 'bill.draft_created' ELSE 'bill.draft_updated' END,
    'bill', v_bill.id::text,
    jsonb_build_object('doc_type', v_bill.doc_type, 'grand_total', v_bill.grand_total)
  );

  RETURN v_bill;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_bill_draft(p_bill_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_bill public.bills;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('billing');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to delete drafts.';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found.';
  END IF;
  IF v_bill.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft documents can be deleted.';
  END IF;

  DELETE FROM public.bills WHERE id = p_bill_id;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_actor_email, 'bill.draft_deleted', 'bill', p_bill_id::text, jsonb_build_object('doc_type', v_bill.doc_type));

  RETURN true;
END;
$$;

-- Issue a Bill or Quotation atomically (either creating fresh or promoting a draft)
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
  v_actor_email text;
  v_idemp text;
  v_existing public.bills;
  v_biz public.business;
  v_prep jsonb;
  v_calc jsonb;
  v_bill_date date;
  v_due_date date;
  v_bill_number text;
  v_bill public.bills;
  v_grand numeric(15,2);
  v_paid numeric(15,2);
  v_balance numeric(15,2);
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

    -- Delete draft lines while status is still 'draft' before transitioning to 'issued'
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
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin,
      party_address, place_of_supply_state_code, is_interstate, bill_date, due_date,
      valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due, notes, terms, business_snapshot,
      idempotency_key, issued_at, issued_by, created_by
    )
    VALUES (
      v_bill_number, p_doc_type, 'issued', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address', v_prep->>'place_of_supply_state_code',
      (v_calc->>'is_interstate')::boolean, v_bill_date, v_due_date,
      p_valid_until, (v_calc->>'gst_applied')::boolean, (v_calc->>'subtotal_taxable')::numeric,
      (v_calc->>'discount_total')::numeric, (v_calc->>'cgst_total')::numeric,
      (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
      (v_calc->>'tax_total')::numeric, (v_calc->>'extra_charges')::numeric,
      COALESCE(p_auto_round_off, true), (v_calc->>'round_off')::numeric,
      v_grand, v_paid, 0, v_balance,
      NULLIF(trim(COALESCE(p_notes, '')), ''), COALESCE(p_terms, v_biz.invoice_terms),
      v_prep->'biz_snapshot', v_idemp, now(), auth.uid(), auth.uid()
    )
    RETURNING * INTO v_bill;
  END IF;

  -- Insert immutable bill lines and deduct stock for invoices / bills of supply
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

  -- Post to Party Khata Ledger & immediate Payment Allocation when party is linked
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

-- Convert an issued Quotation into an Invoice / Bill of Supply
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

  -- Record reverse pointer on new bill only via direct SQL? Wait: guard blocks modifying source fields on issued bills!
  -- Actually trigger allows converted_from_quotation_id to stay untouched if set on creation, OR let's leave source link on quote + check trigger:
  -- Notice trigger does NOT block converted_from_quotation_id! Let's link it cleanly while inside app.bill_rpc_context:
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

-- Void an Issued Bill (Owner & Manager only)
CREATE OR REPLACE FUNCTION public.void_bill(
  p_bill_id uuid,
  p_reason text
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

  -- Restore stock if bill had deducted stock
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

  -- Reverse bill ledger entry if posted to Khata
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

-- Sales Return / Credit Note Creation (B5)
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

  -- Inherit GST / supply profile from source invoice accurately
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

    -- Restore returned stock
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

  -- Update source invoice credited amount (unrefunded portion only) & balance_due
  v_new_credited := round((v_source.credited_amount + v_credit_applied)::numeric, 2);
  v_new_balance := GREATEST(round((v_source.grand_total - v_source.paid_amount - v_new_credited)::numeric, 2), 0);

  UPDATE public.bills
  SET credited_amount = v_new_credited,
      balance_due = v_new_balance
  WHERE id = v_source.id;

  -- Post Khata credit & optional cash refund
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
      'reason', v_clean_reason
    )
  );

  RETURN v_cn;
END;
$$;

-- Create & Revoke Share Links (B3 / B6)
CREATE OR REPLACE FUNCTION public.create_bill_share_link(
  p_bill_id uuid,
  p_expires_in_hours integer DEFAULT NULL
)
RETURNS public.bill_share_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_role text;
  v_bill public.bills;
  v_token text;
  v_exp timestamptz := NULL;
  v_link public.bill_share_links;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('billing');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to share bills.';
  END IF;

  SELECT * INTO v_bill FROM public.bills WHERE id = p_bill_id;
  IF NOT FOUND OR v_bill.status = 'draft' THEN
    RAISE EXCEPTION 'Share links can only be created for issued bills or quotations.';
  END IF;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  IF p_expires_in_hours IS NOT NULL AND p_expires_in_hours > 0 THEN
    v_exp := now() + make_interval(hours => p_expires_in_hours);
  END IF;

  INSERT INTO public.bill_share_links (bill_id, token, expires_at, created_by)
  VALUES (p_bill_id, v_token, v_exp, auth.uid())
  RETURNING * INTO v_link;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'bill.share_link_created', 'bill', p_bill_id::text,
    jsonb_build_object('bill_number', v_bill.bill_number, 'expires_at', v_exp)
  );

  RETURN v_link;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_bill_share_link(p_link_id uuid)
RETURNS public.bill_share_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_link public.bill_share_links;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('billing');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to revoke share links.';
  END IF;

  UPDATE public.bill_share_links
  SET is_revoked = true,
      revoked_at = now(),
      revoked_by = auth.uid()
  WHERE id = p_link_id
  RETURNING * INTO v_link;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Share link not found.';
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'bill.share_link_revoked', 'bill', v_link.bill_id::text,
    jsonb_build_object('link_id', p_link_id)
  );

  RETURN v_link;
END;
$$;

-- 9. Views for Bills List, Summary KPIs, and GST Breakup
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
  ) AS active_share_count
FROM public.bills b
LEFT JOIN public.bills sb ON sb.id = b.source_bill_id
LEFT JOIN public.bills cb ON cb.id = b.converted_to_bill_id
WHERE public.is_module_enabled('billing')
  AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']);

ALTER VIEW public.bill_list_view SET (security_invoker = false);

CREATE OR REPLACE VIEW public.billing_summary_view AS
SELECT
  COALESCE(
    SUM(b.grand_total) FILTER (
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply')
        AND b.bill_date = CURRENT_DATE
    ), 0
  )::numeric(15,2) AS today_sales,
  COALESCE(
    SUM(b.grand_total) FILTER (
      WHERE b.status = 'issued'
        AND b.doc_type = 'credit_note'
        AND b.bill_date = CURRENT_DATE
    ), 0
  )::numeric(15,2) AS today_returns,
  COALESCE(
    SUM(
      CASE
        WHEN b.doc_type IN ('tax_invoice', 'bill_of_supply') THEN b.grand_total
        WHEN b.doc_type = 'credit_note' THEN -b.grand_total
        ELSE 0
      END
    ) FILTER (WHERE b.status = 'issued' AND b.bill_date = CURRENT_DATE), 0
  )::numeric(15,2) AS today_net_sales,
  COALESCE(
    SUM(b.grand_total) FILTER (
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply')
        AND date_trunc('month', b.bill_date) = date_trunc('month', CURRENT_DATE)
    ), 0
  )::numeric(15,2) AS month_sales,
  COALESCE(
    SUM(b.balance_due) FILTER (
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply')
        AND b.balance_due > 0
    ), 0
  )::numeric(15,2) AS total_unpaid_amount,
  count(*) FILTER (
    WHERE b.status = 'issued'
      AND b.doc_type IN ('tax_invoice', 'bill_of_supply')
      AND b.balance_due > 0
  )::integer AS unpaid_bills_count,
  count(*) FILTER (
    WHERE b.status = 'issued'
      AND b.doc_type = 'quotation'
  )::integer AS open_quotations_count,
  count(*) FILTER (WHERE b.status = 'draft')::integer AS drafts_count
FROM public.bills b
HAVING public.is_module_enabled('billing')
  AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']);

ALTER VIEW public.billing_summary_view SET (security_invoker = false);

-- 10. Row-Level Security & Least-Privilege Grants
ALTER TABLE public.bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_share_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.bills FROM anon, authenticated;
REVOKE ALL ON public.bill_lines FROM anon, authenticated;
REVOKE ALL ON public.bill_share_links FROM anon, authenticated;

GRANT SELECT ON public.bills TO authenticated;
GRANT SELECT ON public.bill_lines TO authenticated;
GRANT SELECT ON public.bill_share_links TO authenticated;
GRANT SELECT ON public.bill_list_view TO authenticated;
GRANT SELECT ON public.billing_summary_view TO authenticated;

GRANT EXECUTE ON FUNCTION public.compute_bill_amounts(boolean, text, boolean, numeric, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_bill_draft(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_bill_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_bill(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_quotation_to_bill(uuid, text, date, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_bill(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_return(uuid, jsonb, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_bill_share_link(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_bill_share_link(uuid) TO authenticated;

DROP POLICY IF EXISTS "Billing roles read bills" ON public.bills;
CREATE POLICY "Billing roles read bills" ON public.bills
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('billing')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Billing roles read bill_lines" ON public.bill_lines;
CREATE POLICY "Billing roles read bill_lines" ON public.bill_lines
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('billing')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Billing roles read bill_share_links" ON public.bill_share_links;
CREATE POLICY "Billing roles read bill_share_links" ON public.bill_share_links
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('billing')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );
