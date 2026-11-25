-- DecorBiz Step 3: IP Allowlist & TOTP 2FA

ALTER TABLE public.business
  ADD COLUMN IF NOT EXISTS allowed_ips text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE TABLE IF NOT EXISTS public.staff_totp (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  secret text NOT NULL,
  recovery_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_totp ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_totp_select ON public.staff_totp;
CREATE POLICY staff_totp_select ON public.staff_totp
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_owner()
  );

CREATE OR REPLACE FUNCTION public.update_ip_allowlist(p_allowed_ips text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only an Owner can update the IP allowlist.';
  END IF;

  UPDATE public.business
  SET allowed_ips = COALESCE(p_allowed_ips, ARRAY[]::text[]),
      updated_at = now()
  WHERE id = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_ip_allowlist(text[]) TO authenticated;
