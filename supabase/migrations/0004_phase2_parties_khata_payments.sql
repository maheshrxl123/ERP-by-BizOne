-- BizOne ERP - Phase P2: Parties, Khata & Payments
-- Single-business architecture: party master, addresses, numbering series,
-- immutable khata ledger, payments, allocations, balance/statement views,
-- concurrency-safe transactional RPCs, and strict RBAC/RLS.

-- 1. Helpers: non-throwing module state & multi-role checks
CREATE OR REPLACE FUNCTION public.is_module_enabled(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT m.enabled FROM public.modules_state m WHERE m.module_key = p_key LIMIT 1),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.has_any_role(p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() = ANY(p_roles), false);
$$;

-- 2. Financial Year & Locked Document Numbering Series
CREATE TABLE IF NOT EXISTS public.numbering_series (
  series_key text NOT NULL,
  fy_code text NOT NULL,
  prefix text NOT NULL,
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  padding integer NOT NULL DEFAULT 4 CHECK (padding BETWEEN 1 AND 8),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_key, fy_code)
);

CREATE OR REPLACE FUNCTION public.compute_fy_code(p_date date DEFAULT CURRENT_DATE)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fy_start integer := 4;
  v_yr integer;
  v_mo integer;
  v_start_yr integer;
BEGIN
  SELECT COALESCE(fy_start_month, 4) INTO v_fy_start FROM public.business WHERE id = 1;
  v_yr := EXTRACT(YEAR FROM COALESCE(p_date, CURRENT_DATE))::integer;
  v_mo := EXTRACT(MONTH FROM COALESCE(p_date, CURRENT_DATE))::integer;

  IF v_fy_start = 1 THEN
    RETURN v_yr::text;
  END IF;

  IF v_mo >= v_fy_start THEN
    v_start_yr := v_yr;
  ELSE
    v_start_yr := v_yr - 1;
  END IF;

  RETURN lpad((v_start_yr % 100)::text, 2, '0') || lpad(((v_start_yr + 1) % 100)::text, 2, '0');
END;
$$;

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
BEGIN
  v_fy_code := public.compute_fy_code(COALESCE(p_doc_date, CURRENT_DATE));
  v_prefix := CASE p_series_key
    WHEN 'payment_receive' THEN 'REC-'
    WHEN 'payment_give' THEN 'PAY-'
    WHEN 'khata_entry' THEN 'KHT-'
    WHEN 'opening_balance' THEN 'OB-'
    ELSE upper(left(p_series_key, 3)) || '-'
  END;

  INSERT INTO public.numbering_series (series_key, fy_code, prefix, next_number, padding)
  VALUES (p_series_key, v_fy_code, v_prefix, 1, 4)
  ON CONFLICT (series_key, fy_code) DO NOTHING;

  SELECT prefix, next_number, padding
  INTO v_prefix, v_next, v_padding
  FROM public.numbering_series
  WHERE series_key = p_series_key AND fy_code = v_fy_code
  FOR UPDATE;

  UPDATE public.numbering_series
  SET next_number = v_next + 1, updated_at = now()
  WHERE series_key = p_series_key AND fy_code = v_fy_code;

  RETURN v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0');
END;
$$;

-- 3. Parties & Party Addresses
CREATE TABLE IF NOT EXISTS public.parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) >= 1 AND length(name) <= 160),
  party_type text NOT NULL CHECK (party_type IN ('customer', 'supplier', 'both')),
  phone text,
  email text,
  gstin text,
  opening_balance numeric(15,2) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  opening_balance_type text NOT NULL DEFAULT 'to_receive' CHECK (opening_balance_type IN ('to_receive', 'to_give')),
  opening_balance_date date NOT NULL DEFAULT CURRENT_DATE,
  credit_limit numeric(15,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  credit_days integer NOT NULL DEFAULT 0 CHECK (credit_days >= 0),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_parties_gstin_format CHECK (
    gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_parties_active_name ON public.parties (is_active, name);
CREATE INDEX IF NOT EXISTS idx_parties_type ON public.parties (party_type);
CREATE INDEX IF NOT EXISTS idx_parties_phone ON public.parties (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.party_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Primary' CHECK (length(trim(label)) >= 1 AND length(label) <= 60),
  address_line1 text NOT NULL CHECK (length(trim(address_line1)) >= 1 AND length(address_line1) <= 240),
  address_line2 text,
  city text,
  state text,
  state_code text,
  pincode text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_party_addresses_party ON public.party_addresses (party_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_party_addresses_one_default
  ON public.party_addresses (party_id)
  WHERE is_default = true;

DROP TRIGGER IF EXISTS trg_parties_updated_at ON public.parties;
CREATE TRIGGER trg_parties_updated_at
  BEFORE UPDATE ON public.parties
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_party_addresses_updated_at ON public.party_addresses;
CREATE TRIGGER trg_party_addresses_updated_at
  BEFORE UPDATE ON public.party_addresses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. Immutable Khata Ledger, Payments & Allocations
CREATE TABLE IF NOT EXISTS public.party_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN (
    'opening_balance',
    'khata_due',
    'bill',
    'sales_return',
    'purchase',
    'purchase_return',
    'payment_receive',
    'payment_give',
    'payment_reversal',
    'adjustment'
  )),
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  reference_no text,
  source_table text,
  source_id uuid,
  signed_amount numeric(15,2) NOT NULL CHECK (signed_amount <> 0),
  debit_amount numeric(15,2) GENERATED ALWAYS AS (
    CASE WHEN signed_amount > 0 THEN signed_amount ELSE 0 END
  ) STORED,
  credit_amount numeric(15,2) GENERATED ALWAYS AS (
    CASE WHEN signed_amount < 0 THEN abs(signed_amount) ELSE 0 END
  ) STORED,
  note text,
  idempotency_key text UNIQUE,
  is_reversed boolean NOT NULL DEFAULT false,
  reversed_by_entry_id uuid REFERENCES public.party_ledger_entries(id) ON DELETE RESTRICT,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_party_ledger_party_date
  ON public.party_ledger_entries (party_id, entry_date, created_at);
CREATE INDEX IF NOT EXISTS idx_party_ledger_source
  ON public.party_ledger_entries (source_table, source_id);

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number text NOT NULL UNIQUE,
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('receive', 'give')),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  allocated_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
  advance_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (advance_amount >= 0),
  mode text NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other')),
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  reference_no text,
  notes text,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  idempotency_key text UNIQUE,
  reversed_at timestamptz,
  reversed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reversal_reason text,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_payment_allocation_sum CHECK (allocated_amount + advance_amount = amount)
);

CREATE INDEX IF NOT EXISTS idx_payments_party_date ON public.payments (party_id, payment_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_date_status ON public.payments (payment_date DESC, status);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON public.payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('opening_balance', 'ledger_entry', 'bill', 'purchase_bill', 'advance')),
  ledger_entry_id uuid REFERENCES public.party_ledger_entries(id) ON DELETE RESTRICT,
  target_label text NOT NULL,
  allocated_amount numeric(15,2) NOT NULL CHECK (allocated_amount > 0),
  is_reversed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON public.payment_allocations (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_ledger ON public.payment_allocations (ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;

-- 5. Immutability guards ("no silent mutation of posted entries")
CREATE OR REPLACE FUNCTION public.guard_immutable_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted khata ledger entries cannot be deleted; post a reversal entry instead.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_reversed = true THEN
      RAISE EXCEPTION 'A reversed khata ledger entry cannot be modified.';
    END IF;
    IF NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
       OR NEW.entry_date IS DISTINCT FROM OLD.entry_date
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.reference_no IS DISTINCT FROM OLD.reference_no
       OR NEW.source_table IS DISTINCT FROM OLD.source_table
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.signed_amount IS DISTINCT FROM OLD.signed_amount
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.is_reversed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Posted khata ledger entries are immutable and can only be marked reversed via a reversal entry.';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_ledger_immutable ON public.party_ledger_entries;
CREATE TRIGGER trg_guard_ledger_immutable
  BEFORE UPDATE OR DELETE ON public.party_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_ledger_entry();

CREATE OR REPLACE FUNCTION public.guard_immutable_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted payments cannot be deleted; use reverse_payment instead.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'reversed' THEN
      RAISE EXCEPTION 'A reversed payment cannot be modified.';
    END IF;
    IF NEW.payment_number IS DISTINCT FROM OLD.payment_number
       OR NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount
       OR NEW.advance_amount IS DISTINCT FROM OLD.advance_amount
       OR NEW.mode IS DISTINCT FROM OLD.mode
       OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
       OR NEW.reference_no IS DISTINCT FROM OLD.reference_no
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.status IS DISTINCT FROM 'reversed' THEN
      RAISE EXCEPTION 'Posted payments are immutable; use reverse_payment to record a reversal.';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_payment_immutable ON public.payments;
CREATE TRIGGER trg_guard_payment_immutable
  BEFORE UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_payment();

CREATE OR REPLACE FUNCTION public.guard_immutable_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment allocations cannot be deleted; reverse the parent payment instead.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_reversed = true THEN
      RAISE EXCEPTION 'A reversed payment allocation cannot be modified.';
    END IF;
    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id
       OR NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.target_type IS DISTINCT FROM OLD.target_type
       OR NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id
       OR NEW.target_label IS DISTINCT FROM OLD.target_label
       OR NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount
       OR NEW.is_reversed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Payment allocations are immutable and can only be marked reversed.';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_payment_alloc_immutable ON public.payment_allocations;
CREATE TRIGGER trg_guard_payment_alloc_immutable
  BEFORE UPDATE OR DELETE ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_payment_allocation();

-- 6. Database Views (authoritative balances, open obligations, and summary totals)
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
  COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)::numeric(15,2) AS settled_amount,
  GREATEST(
    abs(le.signed_amount) - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0),
    0
  )::numeric(15,2) AS remaining_amount,
  CASE WHEN le.signed_amount > 0 THEN 'receive' ELSE 'give' END AS direction_needed,
  (
    GREATEST(
      abs(le.signed_amount) - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0),
      0
    ) > 0
    AND le.due_date IS NOT NULL
    AND le.due_date < CURRENT_DATE
  ) AS is_overdue,
  le.created_at
FROM public.party_ledger_entries le
LEFT JOIN public.payment_allocations pa
  ON pa.ledger_entry_id = le.id AND pa.is_reversed = false
WHERE le.is_reversed = false
  AND le.entry_type IN ('opening_balance', 'khata_due', 'bill', 'purchase')
GROUP BY le.id
HAVING GREATEST(
  abs(le.signed_amount) - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0),
  0
) > 0;

CREATE OR REPLACE VIEW public.party_balances
WITH (security_invoker = true)
AS
WITH ledger_agg AS (
  SELECT
    le.party_id,
    COALESCE(SUM(le.debit_amount), 0)::numeric(15,2) AS total_debit,
    COALESCE(SUM(le.credit_amount), 0)::numeric(15,2) AS total_credit,
    COALESCE(SUM(le.signed_amount), 0)::numeric(15,2) AS net_balance,
    MAX(le.entry_date) AS last_entry_date
  FROM public.party_ledger_entries le
  GROUP BY le.party_id
),
overdue_agg AS (
  SELECT
    o.party_id,
    COUNT(*)::integer AS open_obligations_count,
    COALESCE(SUM(o.remaining_amount) FILTER (WHERE o.is_overdue AND o.direction_needed = 'receive'), 0)::numeric(15,2) AS overdue_receivable,
    COALESCE(SUM(o.remaining_amount) FILTER (WHERE o.is_overdue AND o.direction_needed = 'give'), 0)::numeric(15,2) AS overdue_payable
  FROM public.party_open_obligations o
  GROUP BY o.party_id
)
SELECT
  p.id AS party_id,
  p.name,
  p.party_type,
  p.phone,
  p.email,
  p.gstin,
  p.opening_balance,
  p.opening_balance_type,
  p.opening_balance_date,
  p.credit_limit,
  p.credit_days,
  p.notes,
  p.is_active,
  p.version,
  p.created_at,
  p.updated_at,
  COALESCE(la.total_debit, 0)::numeric(15,2) AS total_debit,
  COALESCE(la.total_credit, 0)::numeric(15,2) AS total_credit,
  COALESCE(la.net_balance, 0)::numeric(15,2) AS net_balance,
  GREATEST(COALESCE(la.net_balance, 0), 0)::numeric(15,2) AS to_receive,
  GREATEST(-COALESCE(la.net_balance, 0), 0)::numeric(15,2) AS to_give,
  COALESCE(oa.open_obligations_count, 0) AS open_obligations_count,
  COALESCE(oa.overdue_receivable, 0)::numeric(15,2) AS overdue_receivable,
  COALESCE(oa.overdue_payable, 0)::numeric(15,2) AS overdue_payable,
  (
    (COALESCE(la.net_balance, 0) > 0 AND COALESCE(oa.overdue_receivable, 0) > 0)
    OR (COALESCE(la.net_balance, 0) < 0 AND COALESCE(oa.overdue_payable, 0) > 0)
  ) AS is_overdue,
  la.last_entry_date
FROM public.parties p
LEFT JOIN ledger_agg la ON la.party_id = p.id
LEFT JOIN overdue_agg oa ON oa.party_id = p.id;

CREATE OR REPLACE VIEW public.khata_totals_summary
WITH (security_invoker = true)
AS
SELECT
  COALESCE((SELECT SUM(pb.to_receive) FROM public.party_balances pb WHERE pb.is_active = true), 0)::numeric(15,2) AS total_to_receive,
  COALESCE((SELECT SUM(pb.to_give) FROM public.party_balances pb WHERE pb.is_active = true), 0)::numeric(15,2) AS total_to_give,
  COALESCE((SELECT COUNT(*) FROM public.party_balances pb WHERE pb.is_active = true), 0)::integer AS active_parties_count,
  COALESCE((SELECT COUNT(*) FROM public.party_balances pb WHERE pb.is_active = true AND pb.is_overdue = true), 0)::integer AS overdue_parties_count,
  COALESCE((SELECT SUM(py.amount) FROM public.payments py WHERE py.status = 'posted' AND py.direction = 'receive' AND py.payment_date = CURRENT_DATE), 0)::numeric(15,2) AS today_received,
  COALESCE((SELECT SUM(py.amount) FROM public.payments py WHERE py.status = 'posted' AND py.direction = 'give' AND py.payment_date = CURRENT_DATE), 0)::numeric(15,2) AS today_given;

-- 7. Transactional RPCs for Parties, Khata & Payments
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
  v_clean_gstin text;
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

  v_clean_gstin := NULLIF(upper(trim(COALESCE(p_gstin, ''))), '');
  IF v_clean_gstin IS NOT NULL AND v_clean_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$' THEN
    RAISE EXCEPTION 'Invalid 15-character GSTIN format.';
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
      v_clean_name,
      p_party_type,
      NULLIF(trim(COALESCE(p_phone, '')), ''),
      NULLIF(trim(COALESCE(p_email, '')), ''),
      v_clean_gstin,
      v_ob,
      v_ob_type,
      v_ob_date,
      round(COALESCE(p_credit_limit, 0)::numeric, 2),
      COALESCE(p_credit_days, 0),
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      auth.uid()
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
        v_party.id,
        'opening_balance',
        v_ob_date,
        CASE WHEN COALESCE(p_credit_days, 0) > 0 THEN v_ob_date + COALESCE(p_credit_days, 0) ELSE v_ob_date END,
        v_ob_ref,
        'parties',
        v_party.id,
        v_new_signed,
        'Opening balance (' || CASE WHEN v_ob_type = 'to_receive' THEN 'To Receive' ELSE 'To Give' END || ')',
        auth.uid()
      );
    END IF;

    INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
    VALUES (
      auth.uid(),
      v_actor_email,
      'party.created',
      'party',
      v_party.id::text,
      jsonb_build_object(
        'name', v_party.name,
        'party_type', v_party.party_type,
        'opening_balance', v_party.opening_balance,
        'opening_balance_type', v_party.opening_balance_type
      )
    );
  ELSE
    SELECT * INTO v_old_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Party not found.';
    END IF;

    IF p_expected_version IS NOT NULL AND v_old_party.version <> p_expected_version THEN
      RAISE EXCEPTION 'This party was modified by another user. Please refresh and try again.';
    END IF;

    v_old_signed := CASE
      WHEN v_old_party.opening_balance = 0 THEN 0
      WHEN v_old_party.opening_balance_type = 'to_receive' THEN v_old_party.opening_balance
      ELSE -v_old_party.opening_balance
    END;
    v_new_signed := CASE
      WHEN v_ob = 0 THEN 0
      WHEN v_ob_type = 'to_receive' THEN v_ob
      ELSE -v_ob
    END;
    v_delta := v_new_signed - v_old_signed;

    UPDATE public.parties
    SET
      name = v_clean_name,
      party_type = p_party_type,
      phone = NULLIF(trim(COALESCE(p_phone, '')), ''),
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

    -- Keep ledger immutable: post opening balance or an explicit adjustment delta entry
    IF v_delta <> 0 THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.party_ledger_entries
        WHERE party_id = v_party.id AND entry_type = 'opening_balance'
      ) AND v_old_signed = 0 THEN
        v_ob_ref := public.next_document_number('opening_balance', v_ob_date);
        INSERT INTO public.party_ledger_entries (
          party_id, entry_type, entry_date, due_date, reference_no,
          source_table, source_id, signed_amount, note, created_by
        )
        VALUES (
          v_party.id,
          'opening_balance',
          v_ob_date,
          CASE WHEN COALESCE(p_credit_days, 0) > 0 THEN v_ob_date + COALESCE(p_credit_days, 0) ELSE v_ob_date END,
          v_ob_ref,
          'parties',
          v_party.id,
          v_delta,
          'Opening balance (' || CASE WHEN v_ob_type = 'to_receive' THEN 'To Receive' ELSE 'To Give' END || ')',
          auth.uid()
        );
      ELSE
        v_ob_ref := public.next_document_number('khata_entry', CURRENT_DATE);
        INSERT INTO public.party_ledger_entries (
          party_id, entry_type, entry_date, reference_no,
          source_table, source_id, signed_amount, note, created_by
        )
        VALUES (
          v_party.id,
          'adjustment',
          CURRENT_DATE,
          v_ob_ref,
          'parties',
          v_party.id,
          v_delta,
          'Opening balance adjusted from ' || v_old_party.opening_balance || ' (' || v_old_party.opening_balance_type || ') to ' || v_ob || ' (' || v_ob_type || ')',
          auth.uid()
        );
      END IF;
    END IF;

    INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
    VALUES (
      auth.uid(),
      v_actor_email,
      'party.updated',
      'party',
      v_party.id::text,
      jsonb_build_object(
        'name', v_party.name,
        'party_type', v_party.party_type,
        'opening_delta', v_delta
      )
    );
  END IF;

  -- Sync structured party addresses when an array is provided
  IF p_addresses IS NOT NULL AND jsonb_typeof(p_addresses) = 'array' THEN
    DELETE FROM public.party_addresses WHERE party_id = v_party.id;

    FOR v_addr IN SELECT value FROM jsonb_array_elements(p_addresses)
    LOOP
      v_line1 := trim(COALESCE(v_addr->>'address_line1', ''));
      IF length(v_line1) > 0 THEN
        v_addr_is_default := COALESCE((v_addr->>'is_default')::boolean, false) AND NOT v_has_default;
        IF v_addr_is_default THEN
          v_has_default := true;
        END IF;

        INSERT INTO public.party_addresses (
          party_id, label, address_line1, address_line2,
          city, state, state_code, pincode, is_default
        )
        VALUES (
          v_party.id,
          COALESCE(NULLIF(trim(COALESCE(v_addr->>'label', '')), ''), 'Primary'),
          v_line1,
          NULLIF(trim(COALESCE(v_addr->>'address_line2', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'city', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'state', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'state_code', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'pincode', '')), ''),
          v_addr_is_default
        );
      END IF;
    END LOOP;
  END IF;

  RETURN v_party;
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_party(
  p_party_id uuid,
  p_is_active boolean
)
RETURNS public.parties
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_party public.parties;
  v_balance numeric(15,2);
BEGIN
  PERFORM public.require_module('parties');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can archive or restore a party.';
  END IF;

  SELECT * INTO v_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Party not found.';
  END IF;

  IF p_is_active = false THEN
    SELECT COALESCE(SUM(signed_amount), 0) INTO v_balance
    FROM public.party_ledger_entries
    WHERE party_id = p_party_id;

    IF v_balance <> 0 THEN
      RAISE EXCEPTION 'Settle outstanding balance (%) before archiving this party.', v_balance;
    END IF;
  END IF;

  UPDATE public.parties
  SET is_active = p_is_active, version = v_party.version + 1
  WHERE id = p_party_id
  RETURNING * INTO v_party;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    CASE WHEN p_is_active THEN 'party.restored' ELSE 'party.archived' END,
    'party',
    v_party.id::text,
    jsonb_build_object('name', v_party.name, 'is_active', p_is_active)
  );

  RETURN v_party;
END;
$$;

CREATE OR REPLACE FUNCTION public.post_khata_due(
  p_party_id uuid,
  p_direction text,
  p_amount numeric,
  p_entry_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.party_ledger_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_party public.parties;
  v_amt numeric(15,2);
  v_signed numeric(15,2);
  v_date date;
  v_due date;
  v_ref text;
  v_idemp text;
  v_existing public.party_ledger_entries;
  v_row public.party_ledger_entries;
BEGIN
  PERFORM public.require_module('parties');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to add khata entries.';
  END IF;

  IF p_direction NOT IN ('to_receive', 'to_give') THEN
    RAISE EXCEPTION 'Direction must be to_receive or to_give.';
  END IF;

  v_amt := round(COALESCE(p_amount, 0)::numeric, 2);
  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero.';
  END IF;

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('khata_due:' || v_idemp));
    SELECT * INTO v_existing FROM public.party_ledger_entries WHERE idempotency_key = v_idemp;
    IF FOUND THEN
      IF v_existing.party_id <> p_party_id OR abs(v_existing.signed_amount) <> v_amt THEN
        RAISE EXCEPTION 'Idempotency key already used with different khata entry details.';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
  IF NOT FOUND OR NOT v_party.is_active THEN
    RAISE EXCEPTION 'Active party not found.';
  END IF;

  v_date := COALESCE(p_entry_date, CURRENT_DATE);
  v_due := COALESCE(p_due_date, CASE WHEN v_party.credit_days > 0 THEN v_date + v_party.credit_days ELSE NULL END);
  v_signed := CASE WHEN p_direction = 'to_receive' THEN v_amt ELSE -v_amt END;
  v_ref := public.next_document_number('khata_entry', v_date);

  INSERT INTO public.party_ledger_entries (
    party_id, entry_type, entry_date, due_date, reference_no,
    source_table, signed_amount, note, idempotency_key, created_by
  )
  VALUES (
    p_party_id,
    'khata_due',
    v_date,
    v_due,
    v_ref,
    'parties',
    v_signed,
    COALESCE(NULLIF(trim(COALESCE(p_note, '')), ''), CASE WHEN p_direction = 'to_receive' THEN 'Credit Sale / Udhaar Due' ELSE 'Supplier Credit Due' END),
    v_idemp,
    auth.uid()
  )
  RETURNING * INTO v_row;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    'khata.due_posted',
    'party_ledger_entry',
    v_row.id::text,
    jsonb_build_object('party_id', p_party_id, 'reference_no', v_ref, 'direction', p_direction, 'amount', v_amt)
  );

  RETURN v_row;
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

  -- Serialize concurrent identical idempotency keys cleanly
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

  -- Lock party row so concurrent payments against the same party serialize safely
  SELECT * INTO v_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
  IF NOT FOUND OR NOT v_party.is_active THEN
    RAISE EXCEPTION 'Active party not found.';
  END IF;

  -- Plan and validate all allocations BEFORE inserting immutable payment row
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

      v_remaining := abs(v_target_row.signed_amount) - v_already_settled;
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
        abs(le.signed_amount) - COALESCE((
          SELECT SUM(pa.allocated_amount)
          FROM public.payment_allocations pa
          WHERE pa.ledger_entry_id = le.id AND pa.is_reversed = false
        ), 0) AS rem_amt
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

  -- Post immutable ledger impact: Receive reduces You'll Get (-amt); Give reduces You'll Give (+amt)
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

CREATE OR REPLACE FUNCTION public.reverse_payment(
  p_payment_id uuid,
  p_reason text
)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_actor_email text;
  v_clean_reason text;
  v_payment public.payments;
  v_updated public.payments;
  v_orig_ledger public.party_ledger_entries;
  v_reversal_ledger public.party_ledger_entries;
BEGIN
  PERFORM public.require_module('parties');
  PERFORM public.require_module('payments');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Only Owner or Manager can reverse a posted payment.';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Please enter a reversal reason (minimum 3 characters).';
  END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found.';
  END IF;

  IF v_payment.status = 'reversed' THEN
    RAISE EXCEPTION 'This payment has already been reversed.';
  END IF;

  PERFORM 1 FROM public.parties WHERE id = v_payment.party_id FOR UPDATE;

  UPDATE public.payments
  SET
    status = 'reversed',
    reversed_at = now(),
    reversed_by = auth.uid(),
    reversal_reason = v_clean_reason
  WHERE id = p_payment_id
  RETURNING * INTO v_updated;

  UPDATE public.payment_allocations
  SET is_reversed = true
  WHERE payment_id = p_payment_id AND is_reversed = false;

  SELECT * INTO v_orig_ledger
  FROM public.party_ledger_entries
  WHERE source_table = 'payments' AND source_id = p_payment_id AND is_reversed = false
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, reference_no,
      source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      v_payment.party_id,
      'payment_reversal',
      CURRENT_DATE,
      v_payment.payment_number || '-REV',
      'payments',
      v_payment.id,
      -v_orig_ledger.signed_amount,
      'Reversal of ' || v_payment.payment_number || ': ' || v_clean_reason,
      auth.uid()
    )
    RETURNING * INTO v_reversal_ledger;

    UPDATE public.party_ledger_entries
    SET is_reversed = true, reversed_by_entry_id = v_reversal_ledger.id
    WHERE id = v_orig_ledger.id;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    v_actor_email,
    'payment.reversed',
    'payment',
    v_payment.id::text,
    jsonb_build_object(
      'payment_number', v_payment.payment_number,
      'party_id', v_payment.party_id,
      'amount', v_payment.amount,
      'reason', v_clean_reason
    )
  );

  RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_party_statement(
  p_party_id uuid,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_party public.parties;
  v_opening numeric(15,2) := 0;
  v_debit numeric(15,2) := 0;
  v_credit numeric(15,2) := 0;
  v_closing numeric(15,2) := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('parties');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to view party statements.';
  END IF;

  SELECT * INTO v_party FROM public.parties WHERE id = p_party_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Party not found.';
  END IF;

  IF p_from_date IS NOT NULL THEN
    SELECT COALESCE(SUM(signed_amount), 0)::numeric(15,2)
    INTO v_opening
    FROM public.party_ledger_entries
    WHERE party_id = p_party_id AND entry_date < p_from_date;
  END IF;

  SELECT
    COALESCE(SUM(debit_amount), 0)::numeric(15,2),
    COALESCE(SUM(credit_amount), 0)::numeric(15,2)
  INTO v_debit, v_credit
  FROM public.party_ledger_entries
  WHERE party_id = p_party_id
    AND (p_from_date IS NULL OR entry_date >= p_from_date)
    AND (p_to_date IS NULL OR entry_date <= p_to_date);

  v_closing := v_opening + v_debit - v_credit;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY entry_date ASC, created_at ASC, id ASC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      le.id,
      le.entry_date,
      le.created_at,
      jsonb_build_object(
        'id', le.id,
        'entry_date', le.entry_date,
        'due_date', le.due_date,
        'entry_type', le.entry_type,
        'reference_no', le.reference_no,
        'source_table', le.source_table,
        'source_id', le.source_id,
        'note', le.note,
        'debit_amount', le.debit_amount,
        'credit_amount', le.credit_amount,
        'signed_amount', le.signed_amount,
        'running_balance', (
          v_opening + SUM(le.signed_amount) OVER (ORDER BY le.entry_date ASC, le.created_at ASC, le.id ASC)
        )::numeric(15,2),
        'is_reversed', le.is_reversed,
        'created_at', le.created_at
      ) AS row_json
    FROM public.party_ledger_entries le
    WHERE le.party_id = p_party_id
      AND (p_from_date IS NULL OR le.entry_date >= p_from_date)
      AND (p_to_date IS NULL OR le.entry_date <= p_to_date)
  ) t;

  RETURN jsonb_build_object(
    'party_id', v_party.id,
    'party_name', v_party.name,
    'party_type', v_party.party_type,
    'from_date', p_from_date,
    'to_date', p_to_date,
    'opening_balance', v_opening,
    'period_debit', v_debit,
    'period_credit', v_credit,
    'closing_balance', v_closing,
    'rows', v_rows
  );
END;
$$;

-- 8. Row-Level Security (RLS) & Least-Privilege Grants
ALTER TABLE public.numbering_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;

-- Revoke direct write access on immutable ledger/payment/numbering tables from authenticated JWTs
REVOKE ALL ON public.numbering_series FROM anon, authenticated;
REVOKE ALL ON public.party_ledger_entries FROM anon, authenticated;
REVOKE ALL ON public.payments FROM anon, authenticated;
REVOKE ALL ON public.payment_allocations FROM anon, authenticated;

GRANT SELECT ON public.numbering_series TO authenticated;
GRANT SELECT ON public.party_ledger_entries TO authenticated;
GRANT SELECT ON public.payments TO authenticated;
GRANT SELECT ON public.payment_allocations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.parties TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_addresses TO authenticated;
GRANT SELECT ON public.party_open_obligations TO authenticated;
GRANT SELECT ON public.party_balances TO authenticated;
GRANT SELECT ON public.khata_totals_summary TO authenticated;

-- Numbering series: Owner/Manager/Accountant read-only
DROP POLICY IF EXISTS "Permitted roles read numbering_series" ON public.numbering_series;
CREATE POLICY "Permitted roles read numbering_series" ON public.numbering_series
  FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']));

-- Parties policies (Owner, Manager, Cashier, Accountant while 'parties' module is enabled)
DROP POLICY IF EXISTS "Party roles read parties" ON public.parties;
CREATE POLICY "Party roles read parties" ON public.parties
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Party roles insert parties" ON public.parties;
CREATE POLICY "Party roles insert parties" ON public.parties
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Party roles update parties" ON public.parties;
CREATE POLICY "Party roles update parties" ON public.parties
  FOR UPDATE TO authenticated
  USING (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  )
  WITH CHECK (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

-- Party addresses policies
DROP POLICY IF EXISTS "Party roles read party_addresses" ON public.party_addresses;
CREATE POLICY "Party roles read party_addresses" ON public.party_addresses
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Party roles manage party_addresses" ON public.party_addresses;
CREATE POLICY "Party roles manage party_addresses" ON public.party_addresses
  FOR ALL TO authenticated
  USING (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  )
  WITH CHECK (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

-- Ledger entries policies (Read-only via client; writes strictly via SECURITY DEFINER RPCs)
DROP POLICY IF EXISTS "Party roles read ledger" ON public.party_ledger_entries;
CREATE POLICY "Party roles read ledger" ON public.party_ledger_entries
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('parties')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

-- Payments & allocations policies (Read-only via client; writes strictly via SECURITY DEFINER RPCs)
DROP POLICY IF EXISTS "Payment roles read payments" ON public.payments;
CREATE POLICY "Payment roles read payments" ON public.payments
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('parties')
    AND public.is_module_enabled('payments')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS "Payment roles read allocations" ON public.payment_allocations;
CREATE POLICY "Payment roles read allocations" ON public.payment_allocations
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('parties')
    AND public.is_module_enabled('payments')
    AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant'])
  );
