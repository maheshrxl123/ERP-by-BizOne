-- DecorBiz Step 1 (Item 3): Settings > Modules optional feature toggles
-- Adds explicit on/off module rows for all 12 optional features:
--   locations, accounting, gst_returns, einvoice, ai, messaging,
--   google_drive_backup, hindi, pos, online_payments, email_notifications, online_store
-- And updates public.toggle_module(p_key, p_enabled) with dependency checks.

INSERT INTO public.modules_state (module_key, enabled)
VALUES
  ('gst_returns', true),
  ('google_drive_backup', false),
  ('hindi', true),
  ('pos', true),
  ('online_payments', false),
  ('email_notifications', false),
  ('online_store', false)
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
