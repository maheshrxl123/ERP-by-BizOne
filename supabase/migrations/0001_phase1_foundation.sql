-- BizOne ERP - Phase 1 Foundation Migration
-- Single-business architecture, fixed roles, RLS, private storage, and audit logging.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Core tables
CREATE TABLE IF NOT EXISTS public.files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL DEFAULT 'bizone-private',
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  checksum text,
  purpose text NOT NULL CHECK (purpose IN ('avatar', 'business_logo', 'upi_qr', 'item_image', 'attachment')),
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.file_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_file_links_entity ON public.file_links (entity_type, entity_id, sort_order);

CREATE TABLE IF NOT EXISTS public.business (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL,
  pack text NOT NULL DEFAULT 'general_retail' CHECK (pack IN ('kirana', 'medical', 'clothing', 'hardware', 'general_retail', 'wholesale', 'service')),
  gst_registered boolean NOT NULL DEFAULT false,
  gstin text,
  phone text,
  email text,
  address text,
  state_code text,
  upi_id text,
  fy_start_month integer NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  logo_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  upi_qr_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  invoice_prefix text NOT NULL DEFAULT 'INV-',
  invoice_next_number integer NOT NULL DEFAULT 1 CHECK (invoice_next_number >= 1),
  invoice_terms text NOT NULL DEFAULT 'Thank you for your business.',
  tax_mode text NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('inclusive', 'exclusive')),
  onboarding_completed boolean NOT NULL DEFAULT false,
  onboarding_steps jsonb NOT NULL DEFAULT '{"logo": false, "address": false, "gst": false, "profile": false, "modules": false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'storekeeper', 'accountant', 'viewer')),
  is_active boolean NOT NULL DEFAULT true,
  avatar_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'hi')),
  preferred_theme text NOT NULL DEFAULT 'light' CHECK (preferred_theme IN ('light', 'dark')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.modules_state (
  module_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS public.integration_settings (
  integration_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  display_name text NOT NULL,
  config_public jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_secret text,
  has_secret boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  status text NOT NULL DEFAULT 'not_configured',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Updated-at triggers
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_updated_at ON public.business;
CREATE TRIGGER trg_business_updated_at
  BEFORE UPDATE ON public.business
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_integration_updated_at ON public.integration_settings;
CREATE TRIGGER trg_integration_updated_at
  BEFORE UPDATE ON public.integration_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. Security helper functions (SECURITY DEFINER to avoid recursive RLS lookups)
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = auth.uid() AND p.is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_active_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() = 'owner', false);
$$;

CREATE OR REPLACE FUNCTION public.require_module(p_key text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM public.modules_state WHERE module_key = p_key;
  IF NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION 'Module % is disabled', p_key;
  END IF;
END;
$$;

-- 4. Guard triggers: prevent last Owner removal/demotion & prevent self-role escalation
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
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' AND OLD.is_active = true THEN
      SELECT count(*) INTO v_other_owners
      FROM public.profiles
      WHERE role = 'owner' AND is_active = true AND id <> OLD.id;
      IF v_other_owners = 0 THEN
        RAISE EXCEPTION 'The last active Owner cannot be deleted.';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profiles ON public.profiles;
CREATE TRIGGER trg_guard_profiles
  BEFORE UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profiles_integrity();

-- 5. Transactional RPCs for Phase 1
CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Active staff session required.';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_email, p_action, p_entity_type, p_entity_id, COALESCE(p_details, '{}'::jsonb))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_own_profile(
  p_full_name text,
  p_phone text DEFAULT NULL,
  p_avatar_file_id uuid DEFAULT NULL,
  p_preferred_language text DEFAULT NULL,
  p_preferred_theme text DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.profiles;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Active staff session required.';
  END IF;

  IF length(trim(COALESCE(p_full_name, ''))) < 1 THEN
    RAISE EXCEPTION 'Display name is required.';
  END IF;

  UPDATE public.profiles
  SET
    full_name = trim(p_full_name),
    phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
    avatar_file_id = p_avatar_file_id,
    preferred_language = COALESCE(NULLIF(p_preferred_language, ''), preferred_language),
    preferred_theme = COALESCE(NULLIF(p_preferred_theme, ''), preferred_theme)
  WHERE id = auth.uid()
  RETURNING * INTO v_row;

  -- Mark onboarding profile step if business exists
  UPDATE public.business
  SET onboarding_steps = jsonb_set(onboarding_steps, '{profile}', 'true'::jsonb)
  WHERE id = 1;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_row.email, 'profile.updated', 'profile', auth.uid()::text, jsonb_build_object('full_name', v_row.full_name));

  RETURN v_row;
END;
$$;

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
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only an Owner can update business settings.';
  END IF;

  IF length(trim(COALESCE(p_name, ''))) < 1 THEN
    RAISE EXCEPTION 'Business name is required.';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();

  UPDATE public.business
  SET
    name = trim(p_name),
    gst_registered = COALESCE(p_gst_registered, false),
    gstin = NULLIF(upper(trim(COALESCE(p_gstin, ''))), ''),
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

  SELECT pack INTO v_pack FROM public.business WHERE id = 1;
  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();

  -- Pack-required module guard
  IF p_enabled = false THEN
    IF v_pack = 'medical' AND p_key = 'batch_expiry' THEN
      RAISE EXCEPTION 'Batch and expiry is required by the Medical Store pack.';
    END IF;
    IF p_key = 'billing' AND EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'accounting' AND enabled = true) THEN
      RAISE EXCEPTION 'Disable Advanced Accounting before disabling Billing.';
    END IF;
    IF p_key = 'tax' AND EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'einvoice' AND enabled = true) THEN
      RAISE EXCEPTION 'Disable E-Invoice before disabling Tax.';
    END IF;
  END IF;

  -- Dependency enable guard
  IF p_enabled = true THEN
    IF p_key = 'accounting' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'billing' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable Billing before enabling Advanced Accounting.';
    END IF;
    IF p_key = 'einvoice' AND NOT EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'tax' AND enabled = true) THEN
      RAISE EXCEPTION 'Enable GST & Tax before enabling E-Invoice.';
    END IF;
  END IF;

  INSERT INTO public.modules_state (module_key, enabled, updated_by)
  VALUES (p_key, p_enabled, auth.uid())
  ON CONFLICT (module_key) DO UPDATE
  SET enabled = EXCLUDED.enabled, updated_by = auth.uid(), updated_at = now()
  RETURNING * INTO v_row;

  UPDATE public.business
  SET onboarding_steps = jsonb_set(onboarding_steps, '{modules}', 'true'::jsonb)
  WHERE id = 1;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_email, 'module.toggled', 'module', p_key, jsonb_build_object('enabled', p_enabled));

  RETURN v_row;
END;
$$;

-- 6. Seed default modules & optional integration slots
INSERT INTO public.modules_state (module_key, enabled) VALUES
  ('billing', true),
  ('parties', true),
  ('inventory', true),
  ('purchases', true),
  ('payments', true),
  ('expenses', true),
  ('reports', true),
  ('tax', true),
  ('backup', true),
  ('locations', false),
  ('batch_expiry', false),
  ('variants', false),
  ('accounting', false),
  ('einvoice', false),
  ('messaging', false),
  ('ai', false)
ON CONFLICT (module_key) DO NOTHING;

INSERT INTO public.integration_settings (integration_key, enabled, display_name, config_public, status) VALUES
  ('ai_provider', false, 'BizOne AI Provider', '{"provider": "gemini", "model": "gemini-2.5-flash"}'::jsonb, 'not_configured'),
  ('google_drive', false, 'Google Drive Backup', '{"scope": "https://www.googleapis.com/auth/drive.file"}'::jsonb, 'not_configured'),
  ('smtp_email', false, 'SMTP / Email Delivery', '{"port": 587}'::jsonb, 'not_configured'),
  ('whatsapp_sms', false, 'WhatsApp / SMS Gateway', '{}'::jsonb, 'not_configured')
ON CONFLICT (integration_key) DO NOTHING;

-- 7. Row-Level Security (RLS)
ALTER TABLE public.business ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.modules_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_settings ENABLE ROW LEVEL SECURITY;

-- Business policies
DROP POLICY IF EXISTS "Staff can read business" ON public.business;
CREATE POLICY "Staff can read business" ON public.business
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

DROP POLICY IF EXISTS "Owner can update business" ON public.business;
CREATE POLICY "Owner can update business" ON public.business
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

-- Profiles policies
DROP POLICY IF EXISTS "Staff can read profiles" ON public.profiles;
CREATE POLICY "Staff can read profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.is_active_staff() OR id = auth.uid());

DROP POLICY IF EXISTS "User can update own profile" ON public.profiles;
CREATE POLICY "User can update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() AND public.is_active_staff())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "Owner can update any profile" ON public.profiles;
CREATE POLICY "Owner can update any profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

-- Modules policies
DROP POLICY IF EXISTS "Staff can read modules" ON public.modules_state;
CREATE POLICY "Staff can read modules" ON public.modules_state
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

DROP POLICY IF EXISTS "Owner can update modules" ON public.modules_state;
CREATE POLICY "Owner can update modules" ON public.modules_state
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

-- Files & file_links policies
DROP POLICY IF EXISTS "Staff can read files" ON public.files;
CREATE POLICY "Staff can read files" ON public.files
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

DROP POLICY IF EXISTS "Staff can insert own files" ON public.files;
CREATE POLICY "Staff can insert own files" ON public.files
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_staff() AND uploaded_by = auth.uid());

DROP POLICY IF EXISTS "Owner or uploader can delete files" ON public.files;
CREATE POLICY "Owner or uploader can delete files" ON public.files
  FOR DELETE TO authenticated
  USING (public.is_owner() OR uploaded_by = auth.uid());

DROP POLICY IF EXISTS "Staff can read file_links" ON public.file_links;
CREATE POLICY "Staff can read file_links" ON public.file_links
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

DROP POLICY IF EXISTS "Staff can manage file_links" ON public.file_links;
CREATE POLICY "Staff can manage file_links" ON public.file_links
  FOR ALL TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.is_active_staff());

-- Audit logs: append-only, Owner read
DROP POLICY IF EXISTS "Owner can read audit_logs" ON public.audit_logs;
CREATE POLICY "Owner can read audit_logs" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.is_owner());

-- Integration settings: Owner only (and never expose encrypted_secret via client select)
REVOKE ALL ON public.integration_settings FROM anon, authenticated;
GRANT SELECT (integration_key, enabled, display_name, config_public, has_secret, last_checked_at, status, updated_at)
  ON public.integration_settings TO authenticated;

DROP POLICY IF EXISTS "Owner can read integration public metadata" ON public.integration_settings;
CREATE POLICY "Owner can read integration public metadata" ON public.integration_settings
  FOR SELECT TO authenticated
  USING (public.is_owner());

-- 8. Private Storage Bucket & Storage RLS
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bizone-private',
  'bizone-private',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "BizOne staff read storage" ON storage.objects;
CREATE POLICY "BizOne staff read storage" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'bizone-private' AND public.is_active_staff());

DROP POLICY IF EXISTS "BizOne staff upload storage" ON storage.objects;
CREATE POLICY "BizOne staff upload storage" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'bizone-private' AND public.is_active_staff());

DROP POLICY IF EXISTS "BizOne owner or uploader delete storage" ON storage.objects;
CREATE POLICY "BizOne owner or uploader delete storage" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'bizone-private' AND (public.is_owner() OR owner = auth.uid()));
