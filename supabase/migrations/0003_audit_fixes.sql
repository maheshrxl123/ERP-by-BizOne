-- BizOne ERP - Audit Fixes Migration (0003)
-- Fixes BEFORE DELETE trigger return value (OLD vs NEW), enforces full module dependency graph & pack rules,
-- hardens file_links ownership RLS, validates GSTIN & media links, and adds atomic business media RPC.

-- 1. Fix guard_profiles_integrity(): BEFORE DELETE must return OLD (returning NEW/NULL cancelled deletes!)
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
    -- Protect last active owner from demotion or deactivation
    IF OLD.role = 'owner' AND OLD.is_active = true AND (NEW.role <> 'owner' OR NEW.is_active = false) THEN
      SELECT count(*) INTO v_other_owners
      FROM public.profiles
      WHERE role = 'owner' AND is_active = true AND id <> OLD.id;
      IF v_other_owners = 0 THEN
        RAISE EXCEPTION 'The last active Owner cannot be deactivated or demoted.';
      END IF;
    END IF;

    -- Prevent non-owners (in authenticated JWT requests) from changing role or is_active
    IF auth.uid() IS NOT NULL THEN
      SELECT public.is_owner() INTO v_caller_is_owner;
      IF NOT v_caller_is_owner AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
        RAISE EXCEPTION 'Only an Owner can change user roles or activation status.';
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

-- 2. Harden file_links RLS so staff cannot alter links for another user's or business-level assets
DROP POLICY IF EXISTS "Staff can manage file_links" ON public.file_links;
DROP POLICY IF EXISTS "Owner or file uploader can insert file_links" ON public.file_links;
DROP POLICY IF EXISTS "Owner or file uploader can delete file_links" ON public.file_links;

CREATE POLICY "Owner or file uploader can insert file_links" ON public.file_links
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_owner()
    OR (
      public.is_active_staff()
      AND entity_type <> 'business'
      AND EXISTS (
        SELECT 1 FROM public.files f
        WHERE f.id = file_id AND f.uploaded_by = auth.uid()
      )
    )
  );

CREATE POLICY "Owner or file uploader can delete file_links" ON public.file_links
  FOR DELETE TO authenticated
  USING (
    public.is_owner()
    OR (
      public.is_active_staff()
      AND entity_type <> 'business'
      AND EXISTS (
        SELECT 1 FROM public.files f
        WHERE f.id = file_id AND f.uploaded_by = auth.uid()
      )
    )
  );

-- 3. Atomic business logo / UPI QR update RPC
CREATE OR REPLACE FUNCTION public.update_business_media(
  p_logo_file_id uuid DEFAULT NULL,
  p_upi_qr_file_id uuid DEFAULT NULL
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
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only an Owner can update business media.';
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
    logo_file_id = p_logo_file_id,
    upi_qr_file_id = p_upi_qr_file_id
  WHERE id = 1
  RETURNING * INTO v_row;

  v_steps := v_row.onboarding_steps
    || jsonb_build_object('logo', (v_row.logo_file_id IS NOT NULL));

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
    'business.media_updated',
    'business',
    '1',
    jsonb_build_object('has_logo', (v_row.logo_file_id IS NOT NULL), 'has_upi_qr', (v_row.upi_qr_file_id IS NOT NULL))
  );

  RETURN v_row;
END;
$$;

-- 4. Harden update_business_profile: GSTIN regex, FY month check, and file existence check
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
  p_tax_mode text DEFAULT 'exclusive'
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
    state_code = NULLIF(trim(COALESCE(p_state_code, '')), ''),
    upi_id = NULLIF(trim(COALESCE(p_upi_id, '')), ''),
    fy_start_month = COALESCE(p_fy_start_month, 4),
    logo_file_id = p_logo_file_id,
    upi_qr_file_id = p_upi_qr_file_id,
    invoice_prefix = COALESCE(NULLIF(trim(p_invoice_prefix), ''), 'INV-'),
    invoice_next_number = GREATEST(1, COALESCE(p_invoice_next_number, 1)),
    invoice_terms = COALESCE(p_invoice_terms, ''),
    tax_mode = CASE WHEN p_tax_mode = 'inclusive' THEN 'inclusive' ELSE 'exclusive' END
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
  VALUES (auth.uid(), v_email, 'business.updated', 'business', '1', jsonb_build_object('name', v_row.name, 'gst_registered', v_row.gst_registered));

  RETURN v_row;
END;
$$;

-- 5. Enforce complete MODULE_REGISTRY dependency graph & pack requirements in toggle_module()
CREATE OR REPLACE FUNCTION public.toggle_module(p_key text, p_enabled boolean)
RETURNS public.modules_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pack text;
  v_row public.modules_state;
  v_email text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only an Owner can switch modules.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = p_key) THEN
    RAISE EXCEPTION 'Unknown module key: %', p_key;
  END IF;

  SELECT pack INTO v_pack FROM public.business WHERE id = 1;
  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();

  -- Pack-required module & reverse-dependency guards when disabling
  IF p_enabled = false THEN
    IF v_pack = 'medical' AND p_key = 'batch_expiry' THEN
      RAISE EXCEPTION 'Batch and expiry is required by the Medical Store pack.';
    END IF;
    IF v_pack = 'clothing' AND p_key = 'variants' THEN
      RAISE EXCEPTION 'Size & Colour Variants is required by the Clothing pack.';
    END IF;
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
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'batch_expiry' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Batch & Expiry before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'variants' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Size & Colour Variants before disabling Items & Stock.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'locations' AND enabled = true) THEN
        RAISE EXCEPTION 'Disable Multiple Locations before disabling Items & Stock.';
      END IF;
    END IF;
  END IF;

  -- Forward dependency guards when enabling
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
    IF p_key IN ('batch_expiry', 'variants', 'locations') AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'inventory' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Items & Stock before enabling %.', p_key;
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
