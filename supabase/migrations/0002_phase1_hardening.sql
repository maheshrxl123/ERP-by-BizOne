-- BizOne ERP - Phase 1 Hardening Migration
-- Adds email sync after verified email change, onboarding step control, and upload ownership validation.

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
    UPDATE public.profiles SET email = v_auth_email WHERE id = auth.uid();
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
  v_existing_avatar uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Active staff session required.';
  END IF;

  IF length(trim(COALESCE(p_full_name, ''))) < 1 THEN
    RAISE EXCEPTION 'Display name is required.';
  END IF;

  SELECT avatar_file_id INTO v_existing_avatar FROM public.profiles WHERE id = auth.uid();

  IF p_avatar_file_id IS NOT NULL AND p_avatar_file_id IS DISTINCT FROM v_existing_avatar THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.files f
      WHERE f.id = p_avatar_file_id AND f.uploaded_by = auth.uid()
    ) THEN
      RAISE EXCEPTION 'Avatar file must be uploaded by the signed-in user.';
    END IF;
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

  UPDATE public.business
  SET onboarding_steps = jsonb_set(onboarding_steps, '{profile}', 'true'::jsonb)
  WHERE id = 1;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_row.email, 'profile.updated', 'profile', auth.uid()::text, jsonb_build_object('full_name', v_row.full_name));

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.dismiss_onboarding()
RETURNS public.business
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.business;
  v_email text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only an Owner can dismiss onboarding.';
  END IF;

  SELECT email INTO v_email FROM public.profiles WHERE id = auth.uid();

  UPDATE public.business
  SET onboarding_completed = true
  WHERE id = 1
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_email, 'onboarding.completed', 'business', '1', '{}'::jsonb);

  RETURN v_row;
END;
$$;
