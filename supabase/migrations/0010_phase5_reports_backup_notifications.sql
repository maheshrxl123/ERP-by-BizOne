-- BizOne ERP - Phase P5 (Part 2): Accounting Reports, Notifications, Storage & Backup/Restore
-- Implements:
--   1. notifications & backup_records tables + RLS.
--   2. Owner-only txid-scoped app.restore_context bypass inside P2–P4 immutability triggers.
--   3. Dashboard metrics, Day/Cash/Bank Book (zero double-counting), Profit Estimate,
--      GST & HSN Summaries, Sales/Purchase/Stock Reports, and Party Dues Ageing RPCs.
--   4. System notification sync, Storage usage summary, Export Backup (p5-v1) & Atomic Restore.

-- ============================================================================
-- 1. Notifications & Backup Records Tables
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title_en text NOT NULL,
  title_hi text NOT NULL,
  body_en text NOT NULL,
  body_hi text NOT NULL,
  target_tab text NOT NULL DEFAULT 'home',
  target_id text,
  min_roles text[] NOT NULL DEFAULT ARRAY['owner', 'manager', 'accountant', 'cashier', 'storekeeper', 'viewer'],
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  read_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_active
  ON public.notifications (is_resolved, is_read, created_at DESC);

DROP TRIGGER IF EXISTS trg_notifications_updated_at ON public.notifications;
CREATE TRIGGER trg_notifications_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.backup_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type text NOT NULL CHECK (backup_type IN ('manual', 'pre_restore', 'restore')),
  schema_version text NOT NULL DEFAULT 'p5-v1',
  checksum text,
  size_bytes bigint NOT NULL DEFAULT 0,
  record_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backup_records_created ON public.backup_records (created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.notifications FROM anon, authenticated;
REVOKE ALL ON public.backup_records FROM anon, authenticated;

GRANT SELECT ON public.notifications TO authenticated;
GRANT SELECT ON public.backup_records TO authenticated;

DROP POLICY IF EXISTS "Staff read role notifications" ON public.notifications;
CREATE POLICY "Staff read role notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING (
    public.is_active_staff()
    AND public.current_user_role() = ANY(min_roles)
  );

DROP POLICY IF EXISTS "Backup roles read backup_records" ON public.backup_records;
CREATE POLICY "Backup roles read backup_records" ON public.backup_records
  FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

-- ============================================================================
-- 2. Harden P2–P4 Immutability Guards with Owner-Only Restore Context
-- ============================================================================
CREATE OR REPLACE FUNCTION public.guard_immutable_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.restore_context', true) = txid_current()::text AND public.is_owner() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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

CREATE OR REPLACE FUNCTION public.guard_immutable_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.restore_context', true) = txid_current()::text AND public.is_owner() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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

CREATE OR REPLACE FUNCTION public.guard_immutable_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.restore_context', true) = txid_current()::text AND public.is_owner() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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

CREATE OR REPLACE FUNCTION public.guard_immutable_stock_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.restore_context', true) = txid_current()::text AND public.is_owner() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'Stock ledger entries are immutable and cannot be modified or deleted.';
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_immutable_bills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_rpc boolean := COALESCE(current_setting('app.bill_rpc_context', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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
  v_in_init boolean := COALESCE(current_setting('app.bill_line_init', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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

CREATE OR REPLACE FUNCTION public.apply_stock_ledger_to_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_name text;
  v_allow_neg boolean := false;
  v_current numeric(15,3) := 0;
  v_next numeric(15,3);
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  SELECT name, allow_negative_stock
  INTO v_item_name, v_allow_neg
  FROM public.items
  WHERE id = NEW.item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found for stock movement.';
  END IF;

  INSERT INTO public.stock_balances (item_id, qty_on_hand, last_movement_at, updated_at)
  VALUES (NEW.item_id, 0, NULL, now())
  ON CONFLICT (item_id) DO NOTHING;

  SELECT qty_on_hand INTO v_current
  FROM public.stock_balances
  WHERE item_id = NEW.item_id
  FOR UPDATE;

  v_next := round(COALESCE(v_current, 0) + NEW.signed_base_qty, 3);

  IF v_next < 0 AND NOT COALESCE(v_allow_neg, false) AND NOT v_in_restore THEN
    RAISE EXCEPTION 'Insufficient stock for "%". Available: %, requested reduction: %.',
      v_item_name, v_current, abs(NEW.signed_base_qty);
  END IF;

  UPDATE public.stock_balances
  SET
    qty_on_hand = v_next,
    last_movement_at = GREATEST(COALESCE(last_movement_at, NEW.created_at), NEW.created_at),
    updated_at = now()
  WHERE item_id = NEW.item_id;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 3. Dashboard Metrics RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_dashboard_metrics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_uid uuid := auth.uid();
  v_is_cashier boolean;
  v_today_sales numeric(15,2) := 0;
  v_today_returns numeric(15,2) := 0;
  v_month_sales numeric(15,2) := 0;
  v_today_purchases numeric(15,2) := 0;
  v_month_purchases numeric(15,2) := 0;
  v_today_expenses numeric(15,2) := 0;
  v_month_expenses numeric(15,2) := 0;
  v_cash_in_today numeric(15,2) := 0;
  v_cash_out_today numeric(15,2) := 0;
  v_total_receivable numeric(15,2) := 0;
  v_total_payable numeric(15,2) := 0;
  v_low_stock integer := 0;
  v_out_stock integer := 0;
  v_unread_notif integer := 0;
  v_last_backup timestamptz;
  v_trend jsonb := '[]'::jsonb;
  v_recent_bills jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Active staff access required.';
  END IF;

  v_role := public.current_user_role();
  v_is_cashier := (v_role = 'cashier');

  SELECT last_backup_at INTO v_last_backup FROM public.business WHERE id = 1;

  IF public.is_module_enabled('billing') AND v_role IN ('owner', 'manager', 'cashier', 'accountant', 'viewer') THEN
    SELECT
      COALESCE(SUM(grand_total) FILTER (WHERE status = 'issued' AND doc_type IN ('tax_invoice', 'bill_of_supply') AND bill_date = CURRENT_DATE), 0)::numeric(15,2),
      COALESCE(SUM(grand_total) FILTER (WHERE status = 'issued' AND doc_type = 'credit_note' AND bill_date = CURRENT_DATE), 0)::numeric(15,2),
      COALESCE(SUM(
        CASE
          WHEN doc_type IN ('tax_invoice', 'bill_of_supply') THEN grand_total
          WHEN doc_type = 'credit_note' THEN -grand_total
          ELSE 0
        END
      ) FILTER (WHERE status = 'issued' AND date_trunc('month', bill_date) = date_trunc('month', CURRENT_DATE)), 0)::numeric(15,2)
    INTO v_today_sales, v_today_returns, v_month_sales
    FROM public.bills
    WHERE (NOT v_is_cashier OR created_by = v_uid);

    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_recent_bills
    FROM (
      SELECT id, bill_number, doc_type, status, payment_status, party_name, bill_date, grand_total, balance_due
      FROM public.bills
      WHERE (NOT v_is_cashier OR created_by = v_uid)
      ORDER BY created_at DESC
      LIMIT 6
    ) t;
  END IF;

  IF public.is_module_enabled('purchases') AND v_role IN ('owner', 'manager', 'storekeeper', 'accountant', 'viewer') THEN
    SELECT
      COALESCE(SUM(grand_total) FILTER (WHERE status = 'posted' AND doc_type = 'purchase_bill' AND bill_date = CURRENT_DATE), 0)::numeric(15,2),
      COALESCE(SUM(grand_total) FILTER (WHERE status = 'posted' AND doc_type = 'purchase_bill' AND date_trunc('month', bill_date) = date_trunc('month', CURRENT_DATE)), 0)::numeric(15,2)
    INTO v_today_purchases, v_month_purchases
    FROM public.purchase_bills;
  END IF;

  IF public.is_module_enabled('expenses') AND v_role IN ('owner', 'manager', 'cashier', 'accountant', 'viewer') THEN
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE status = 'posted' AND expense_date = CURRENT_DATE), 0)::numeric(15,2),
      COALESCE(SUM(amount) FILTER (WHERE status = 'posted' AND date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)), 0)::numeric(15,2)
    INTO v_today_expenses, v_month_expenses
    FROM public.expenses
    WHERE (NOT v_is_cashier OR created_by = v_uid);
  END IF;

  -- Cash / Bank flows today without double counting party payments
  IF v_role IN ('owner', 'manager', 'cashier', 'accountant', 'viewer') THEN
    IF public.is_module_enabled('payments') THEN
      SELECT
        v_cash_in_today + COALESCE(SUM(amount) FILTER (WHERE status = 'posted' AND direction = 'receive' AND payment_date = CURRENT_DATE), 0),
        v_cash_out_today + COALESCE(SUM(amount) FILTER (WHERE status = 'posted' AND direction = 'give' AND payment_date = CURRENT_DATE), 0)
      INTO v_cash_in_today, v_cash_out_today
      FROM public.payments
      WHERE (NOT v_is_cashier OR created_by = v_uid);
    END IF;

    IF public.is_module_enabled('billing') THEN
      SELECT
        v_cash_in_today + COALESCE(SUM(paid_amount) FILTER (WHERE party_id IS NULL AND status = 'issued' AND doc_type IN ('tax_invoice', 'bill_of_supply') AND bill_date = CURRENT_DATE), 0),
        v_cash_out_today + COALESCE(SUM(paid_amount) FILTER (WHERE party_id IS NULL AND status = 'issued' AND doc_type = 'credit_note' AND bill_date = CURRENT_DATE), 0)
      INTO v_cash_in_today, v_cash_out_today
      FROM public.bills
      WHERE (NOT v_is_cashier OR created_by = v_uid);
    END IF;

    IF NOT v_is_cashier AND public.is_module_enabled('purchases') THEN
      SELECT
        v_cash_in_today + COALESCE(SUM(paid_amount) FILTER (WHERE party_id IS NULL AND status = 'posted' AND doc_type = 'purchase_return' AND bill_date = CURRENT_DATE), 0),
        v_cash_out_today + COALESCE(SUM(paid_amount) FILTER (WHERE party_id IS NULL AND status = 'posted' AND doc_type = 'purchase_bill' AND bill_date = CURRENT_DATE), 0)
      INTO v_cash_in_today, v_cash_out_today
      FROM public.purchase_bills;
    END IF;

    IF public.is_module_enabled('expenses') THEN
      v_cash_out_today := v_cash_out_today + v_today_expenses;
    END IF;
  END IF;

  IF public.is_module_enabled('parties') AND v_role IN ('owner', 'manager', 'accountant', 'viewer') THEN
    SELECT
      COALESCE(SUM(to_receive), 0)::numeric(15,2),
      COALESCE(SUM(to_give), 0)::numeric(15,2)
    INTO v_total_receivable, v_total_payable
    FROM public.party_balances
    WHERE is_active = true;
  END IF;

  IF public.is_module_enabled('inventory') THEN
    SELECT
      count(*) FILTER (WHERE is_active = true AND is_low_stock = true)::integer,
      count(*) FILTER (WHERE is_active = true AND is_out_of_stock = true)::integer
    INTO v_low_stock, v_out_stock
    FROM public.item_catalog_view;
  END IF;

  SELECT count(*)::integer INTO v_unread_notif
  FROM public.notifications
  WHERE is_resolved = false AND is_read = false AND v_role = ANY(min_roles);

  -- 7-day trend
  SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.day ASC), '[]'::jsonb)
  INTO v_trend
  FROM (
    SELECT
      gs::date AS day,
      CASE WHEN v_role IN ('owner', 'manager', 'cashier', 'accountant', 'viewer') AND public.is_module_enabled('billing') THEN
        COALESCE((
          SELECT SUM(CASE WHEN doc_type = 'credit_note' THEN -grand_total ELSE grand_total END)
          FROM public.bills
          WHERE status = 'issued' AND doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
            AND bill_date = gs::date
            AND (NOT v_is_cashier OR created_by = v_uid)
        ), 0)::numeric(15,2)
      ELSE 0::numeric(15,2) END AS sales,
      CASE WHEN v_role IN ('owner', 'manager', 'storekeeper', 'accountant', 'viewer') AND public.is_module_enabled('purchases') THEN
        COALESCE((
          SELECT SUM(grand_total)
          FROM public.purchase_bills
          WHERE status = 'posted' AND doc_type = 'purchase_bill' AND bill_date = gs::date
        ), 0)::numeric(15,2)
      ELSE 0::numeric(15,2) END AS purchases,
      CASE WHEN v_role IN ('owner', 'manager', 'cashier', 'accountant', 'viewer') AND public.is_module_enabled('expenses') THEN
        COALESCE((
          SELECT SUM(amount)
          FROM public.expenses
          WHERE status = 'posted' AND expense_date = gs::date
            AND (NOT v_is_cashier OR created_by = v_uid)
        ), 0)::numeric(15,2)
      ELSE 0::numeric(15,2) END AS expenses
    FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, interval '1 day') AS gs
  ) d;

  RETURN jsonb_build_object(
    'today_sales', round(v_today_sales - v_today_returns, 2),
    'today_gross_sales', v_today_sales,
    'today_returns', v_today_returns,
    'month_sales', v_month_sales,
    'today_purchases', v_today_purchases,
    'month_purchases', v_month_purchases,
    'today_expenses', v_today_expenses,
    'month_expenses', v_month_expenses,
    'cash_in_today', round(v_cash_in_today, 2),
    'cash_out_today', round(v_cash_out_today, 2),
    'net_cash_today', round(v_cash_in_today - v_cash_out_today, 2),
    'total_receivable', v_total_receivable,
    'total_payable', v_total_payable,
    'low_stock_count', v_low_stock,
    'out_of_stock_count', v_out_stock,
    'unread_notifications_count', v_unread_notif,
    'last_backup_at', v_last_backup,
    'daily_trend', v_trend,
    'recent_bills', v_recent_bills
  );
END;
$$;

-- ============================================================================
-- 4. Day Book, Cash Book & Bank Book (Zero Double-Counting Reconciliation)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_day_book(
  p_from_date date DEFAULT CURRENT_DATE,
  p_to_date date DEFAULT CURRENT_DATE,
  p_book text DEFAULT 'day'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_uid uuid := auth.uid();
  v_is_cashier boolean;
  v_from date := COALESCE(p_from_date, CURRENT_DATE);
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_book text := COALESCE(NULLIF(lower(trim(p_book)), ''), 'day');
  v_opening numeric(15,2) := 0;
  v_total_in numeric(15,2) := 0;
  v_total_out numeric(15,2) := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('reports');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'accountant', 'cashier', 'viewer') THEN
    RAISE EXCEPTION 'You do not have permission to view Day / Cash / Bank books.';
  END IF;
  IF v_book NOT IN ('day', 'cash', 'bank') THEN
    RAISE EXCEPTION 'Book type must be day, cash, or bank.';
  END IF;

  v_is_cashier := (v_role = 'cashier');

  WITH book_entries AS (
    -- 1. Party payments & receipts (includes immediate allocations from party bills/purchases)
    SELECT
      p.id::text AS entry_id,
      p.payment_date AS entry_date,
      p.created_at,
      p.payment_number AS voucher_no,
      CASE WHEN p.direction = 'receive' THEN 'receipt' ELSE 'payment' END AS source_type,
      COALESCE(pt.name, 'Party Payment') AS party_or_particular,
      p.mode AS payment_mode,
      p.reference_no,
      p.notes,
      CASE WHEN p.direction = 'receive' THEN p.amount ELSE 0::numeric(15,2) END AS cash_in,
      CASE WHEN p.direction = 'give' THEN p.amount ELSE 0::numeric(15,2) END AS cash_out
    FROM public.payments p
    LEFT JOIN public.parties pt ON pt.id = p.party_id
    WHERE p.status = 'posted'
      AND public.is_module_enabled('payments')
      AND (NOT v_is_cashier OR p.created_by = v_uid)

    UNION ALL

    -- 2. Walk-in cash/UPI/card bills & credit notes (party_id IS NULL only, no duplicate with payments)
    SELECT
      b.id::text AS entry_id,
      b.bill_date AS entry_date,
      COALESCE(b.issued_at, b.created_at) AS created_at,
      b.bill_number AS voucher_no,
      CASE WHEN b.doc_type = 'credit_note' THEN 'walkin_refund' ELSE 'walkin_sale' END AS source_type,
      b.party_name AS party_or_particular,
      b.payment_mode,
      b.payment_reference AS reference_no,
      b.notes,
      CASE WHEN b.doc_type IN ('tax_invoice', 'bill_of_supply') THEN b.paid_amount ELSE 0::numeric(15,2) END AS cash_in,
      CASE WHEN b.doc_type = 'credit_note' THEN b.paid_amount ELSE 0::numeric(15,2) END AS cash_out
    FROM public.bills b
    WHERE b.party_id IS NULL
      AND b.status = 'issued'
      AND b.paid_amount > 0
      AND public.is_module_enabled('billing')
      AND (NOT v_is_cashier OR b.created_by = v_uid)

    UNION ALL

    -- 3. Walk-in cash/UPI purchases & returns (party_id IS NULL only)
    SELECT
      pb.id::text AS entry_id,
      pb.bill_date AS entry_date,
      COALESCE(pb.posted_at, pb.created_at) AS created_at,
      pb.purchase_number AS voucher_no,
      CASE WHEN pb.doc_type = 'purchase_return' THEN 'walkin_purchase_refund' ELSE 'walkin_purchase' END AS source_type,
      pb.party_name AS party_or_particular,
      pb.payment_mode,
      pb.payment_reference AS reference_no,
      pb.notes,
      CASE WHEN pb.doc_type = 'purchase_return' THEN pb.paid_amount ELSE 0::numeric(15,2) END AS cash_in,
      CASE WHEN pb.doc_type = 'purchase_bill' THEN pb.paid_amount ELSE 0::numeric(15,2) END AS cash_out
    FROM public.purchase_bills pb
    WHERE pb.party_id IS NULL
      AND pb.status = 'posted'
      AND pb.paid_amount > 0
      AND NOT v_is_cashier
      AND public.is_module_enabled('purchases')

    UNION ALL

    -- 4. Posted Expenses
    SELECT
      e.id::text AS entry_id,
      e.expense_date AS entry_date,
      e.created_at,
      e.expense_number AS voucher_no,
      'expense' AS source_type,
      ec.name_en || COALESCE(' · ' || NULLIF(e.paid_to, ''), '') AS party_or_particular,
      e.payment_mode,
      e.reference_no,
      e.notes,
      0::numeric(15,2) AS cash_in,
      e.amount AS cash_out
    FROM public.expenses e
    JOIN public.expense_categories ec ON ec.id = e.category_id
    WHERE e.status = 'posted'
      AND public.is_module_enabled('expenses')
      AND (NOT v_is_cashier OR e.created_by = v_uid)
  ),
  filtered AS (
    SELECT *
    FROM book_entries
    WHERE CASE
      WHEN v_book = 'cash' THEN payment_mode = 'cash'
      WHEN v_book = 'bank' THEN payment_mode IN ('upi', 'card', 'bank_transfer', 'cheque', 'other')
      ELSE true
    END
  )
  SELECT
    COALESCE(SUM(cash_in - cash_out) FILTER (WHERE entry_date < v_from), 0)::numeric(15,2),
    COALESCE(SUM(cash_in) FILTER (WHERE entry_date BETWEEN v_from AND v_to), 0)::numeric(15,2),
    COALESCE(SUM(cash_out) FILTER (WHERE entry_date BETWEEN v_from AND v_to), 0)::numeric(15,2),
    COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.entry_date ASC, r.created_at ASC)
      FROM (
        SELECT *
        FROM filtered
        WHERE entry_date BETWEEN v_from AND v_to
        ORDER BY entry_date ASC, created_at ASC
      ) r
    ), '[]'::jsonb)
  INTO v_opening, v_total_in, v_total_out, v_rows
  FROM filtered;

  RETURN jsonb_build_object(
    'book', v_book,
    'from_date', v_from,
    'to_date', v_to,
    'opening_balance', v_opening,
    'total_in', v_total_in,
    'total_out', v_total_out,
    'closing_balance', round((v_opening + v_total_in - v_total_out)::numeric, 2),
    'rows', v_rows
  );
END;
$$;

-- ============================================================================
-- 5. Profit Estimate Report (Strictly Gated to Owner / Manager / Accountant)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_profit_estimate(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_from date := COALESCE(p_from_date, date_trunc('month', CURRENT_DATE)::date);
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_sales_ex_tax numeric(15,2) := 0;
  v_returns_ex_tax numeric(15,2) := 0;
  v_extra_charges numeric(15,2) := 0;
  v_cogs numeric(15,2) := 0;
  v_expenses numeric(15,2) := 0;
  v_missing_cost_count integer := 0;
  v_expense_breakdown jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('reports');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Profit estimate is restricted to Owner, Manager, or Accountant.';
  END IF;

  IF public.is_module_enabled('billing') THEN
    SELECT
      COALESCE(SUM(subtotal_taxable) FILTER (WHERE doc_type IN ('tax_invoice', 'bill_of_supply')), 0)::numeric(15,2),
      COALESCE(SUM(subtotal_taxable) FILTER (WHERE doc_type = 'credit_note'), 0)::numeric(15,2),
      COALESCE(SUM(extra_charges) FILTER (WHERE doc_type IN ('tax_invoice', 'bill_of_supply')), 0)::numeric(15,2)
    INTO v_sales_ex_tax, v_returns_ex_tax, v_extra_charges
    FROM public.bills
    WHERE status = 'issued'
      AND bill_date BETWEEN v_from AND v_to;
  END IF;

  IF public.is_module_enabled('inventory') THEN
    SELECT
      COALESCE(SUM(
        CASE
          WHEN sl.movement_type = 'sale' THEN abs(sl.signed_base_qty) * COALESCE(sl.unit_cost, i.purchase_price, 0)
          WHEN sl.movement_type = 'sale_return' THEN -abs(sl.signed_base_qty) * COALESCE(sl.unit_cost, i.purchase_price, 0)
          ELSE 0
        END
      ), 0)::numeric(15,2),
      count(*) FILTER (
        WHERE sl.movement_type IN ('sale', 'sale_return')
          AND sl.unit_cost IS NULL AND i.purchase_price IS NULL
      )::integer
    INTO v_cogs, v_missing_cost_count
    FROM public.stock_ledger sl
    JOIN public.items i ON i.id = sl.item_id
    WHERE sl.movement_type IN ('sale', 'sale_return')
      AND sl.movement_date BETWEEN v_from AND v_to;
  END IF;

  IF public.is_module_enabled('expenses') THEN
    SELECT COALESCE(SUM(amount), 0)::numeric(15,2)
    INTO v_expenses
    FROM public.expenses
    WHERE status = 'posted'
      AND expense_date BETWEEN v_from AND v_to;

    SELECT COALESCE(jsonb_agg(row_to_json(c) ORDER BY c.total_amount DESC), '[]'::jsonb)
    INTO v_expense_breakdown
    FROM (
      SELECT ec.code, ec.name_en, ec.name_hi, SUM(e.amount)::numeric(15,2) AS total_amount
      FROM public.expenses e
      JOIN public.expense_categories ec ON ec.id = e.category_id
      WHERE e.status = 'posted' AND e.expense_date BETWEEN v_from AND v_to
      GROUP BY ec.id, ec.code, ec.name_en, ec.name_hi
    ) c;
  END IF;

  RETURN jsonb_build_object(
    'from_date', v_from,
    'to_date', v_to,
    'gross_sales_ex_tax', v_sales_ex_tax,
    'sales_returns_ex_tax', v_returns_ex_tax,
    'net_sales_ex_tax', round((v_sales_ex_tax - v_returns_ex_tax)::numeric, 2),
    'extra_charges_income', v_extra_charges,
    'cogs_estimate', v_cogs,
    'gross_profit', round((v_sales_ex_tax - v_returns_ex_tax - v_cogs)::numeric, 2),
    'operating_expenses', v_expenses,
    'estimated_net_profit', round((v_sales_ex_tax - v_returns_ex_tax + v_extra_charges - v_cogs - v_expenses)::numeric, 2),
    'missing_cost_entries', v_missing_cost_count,
    'expense_breakdown', v_expense_breakdown
  );
END;
$$;

-- ============================================================================
-- 6. GST Summary & HSN Summary Reports
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_gst_summary(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_from date := COALESCE(p_from_date, date_trunc('month', CURRENT_DATE)::date);
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_out_taxable numeric(15,2) := 0;
  v_out_cgst numeric(15,2) := 0;
  v_out_sgst numeric(15,2) := 0;
  v_out_igst numeric(15,2) := 0;
  v_out_total numeric(15,2) := 0;
  v_in_taxable numeric(15,2) := 0;
  v_in_cgst numeric(15,2) := 0;
  v_in_sgst numeric(15,2) := 0;
  v_in_igst numeric(15,2) := 0;
  v_in_total numeric(15,2) := 0;
  v_output_slabs jsonb := '[]'::jsonb;
  v_input_slabs jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('reports');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'accountant', 'viewer') THEN
    RAISE EXCEPTION 'GST summary requires Owner, Manager, Accountant, or Viewer access.';
  END IF;

  IF public.is_module_enabled('billing') THEN
    SELECT
      COALESCE(SUM(CASE WHEN doc_type = 'credit_note' THEN -subtotal_taxable ELSE subtotal_taxable END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'credit_note' THEN -cgst_total ELSE cgst_total END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'credit_note' THEN -sgst_total ELSE sgst_total END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'credit_note' THEN -igst_total ELSE igst_total END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'credit_note' THEN -tax_total ELSE tax_total END), 0)::numeric(15,2)
    INTO v_out_taxable, v_out_cgst, v_out_sgst, v_out_igst, v_out_total
    FROM public.bills
    WHERE status = 'issued'
      AND doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
      AND bill_date BETWEEN v_from AND v_to;

    SELECT COALESCE(jsonb_agg(row_to_json(s) ORDER BY s.gst_rate ASC), '[]'::jsonb)
    INTO v_output_slabs
    FROM (
      SELECT
        bl.gst_rate,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.taxable_amount ELSE bl.taxable_amount END)::numeric(15,2) AS taxable_amount,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.cgst_amount ELSE bl.cgst_amount END)::numeric(15,2) AS cgst_amount,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.sgst_amount ELSE bl.sgst_amount END)::numeric(15,2) AS sgst_amount,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.igst_amount ELSE bl.igst_amount END)::numeric(15,2) AS igst_amount,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.tax_amount ELSE bl.tax_amount END)::numeric(15,2) AS tax_amount,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.line_total ELSE bl.line_total END)::numeric(15,2) AS total_amount
      FROM public.bill_lines bl
      JOIN public.bills b ON b.id = bl.bill_id
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
        AND b.bill_date BETWEEN v_from AND v_to
      GROUP BY bl.gst_rate
    ) s;
  END IF;

  IF public.is_module_enabled('purchases') THEN
    SELECT
      COALESCE(SUM(CASE WHEN doc_type = 'purchase_return' THEN -subtotal_taxable ELSE subtotal_taxable END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'purchase_return' THEN -cgst_total ELSE cgst_total END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'purchase_return' THEN -sgst_total ELSE sgst_total END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'purchase_return' THEN -igst_total ELSE igst_total END), 0)::numeric(15,2),
      COALESCE(SUM(CASE WHEN doc_type = 'purchase_return' THEN -tax_total ELSE tax_total END), 0)::numeric(15,2)
    INTO v_in_taxable, v_in_cgst, v_in_sgst, v_in_igst, v_in_total
    FROM public.purchase_bills
    WHERE status = 'posted'
      AND bill_date BETWEEN v_from AND v_to;

    SELECT COALESCE(jsonb_agg(row_to_json(s) ORDER BY s.gst_rate ASC), '[]'::jsonb)
    INTO v_input_slabs
    FROM (
      SELECT
        pl.gst_rate,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.taxable_amount ELSE pl.taxable_amount END)::numeric(15,2) AS taxable_amount,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.cgst_amount ELSE pl.cgst_amount END)::numeric(15,2) AS cgst_amount,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.sgst_amount ELSE pl.sgst_amount END)::numeric(15,2) AS sgst_amount,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.igst_amount ELSE pl.igst_amount END)::numeric(15,2) AS igst_amount,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.tax_amount ELSE pl.tax_amount END)::numeric(15,2) AS tax_amount,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.line_total ELSE pl.line_total END)::numeric(15,2) AS total_amount
      FROM public.purchase_lines pl
      JOIN public.purchase_bills pb ON pb.id = pl.purchase_id
      WHERE pb.status = 'posted'
        AND pb.bill_date BETWEEN v_from AND v_to
      GROUP BY pl.gst_rate
    ) s;
  END IF;

  RETURN jsonb_build_object(
    'from_date', v_from,
    'to_date', v_to,
    'output', jsonb_build_object(
      'taxable', v_out_taxable,
      'cgst', v_out_cgst,
      'sgst', v_out_sgst,
      'igst', v_out_igst,
      'total_tax', v_out_total,
      'slabs', v_output_slabs
    ),
    'input', jsonb_build_object(
      'taxable', v_in_taxable,
      'cgst', v_in_cgst,
      'sgst', v_in_sgst,
      'igst', v_in_igst,
      'total_tax', v_in_total,
      'slabs', v_input_slabs
    ),
    'net_payable', jsonb_build_object(
      'cgst', round((v_out_cgst - v_in_cgst)::numeric, 2),
      'sgst', round((v_out_sgst - v_in_sgst)::numeric, 2),
      'igst', round((v_out_igst - v_in_igst)::numeric, 2),
      'total_tax', round((v_out_total - v_in_total)::numeric, 2)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_hsn_summary(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE,
  p_scope text DEFAULT 'sales'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_from date := COALESCE(p_from_date, date_trunc('month', CURRENT_DATE)::date);
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_scope text := COALESCE(NULLIF(lower(trim(p_scope)), ''), 'sales');
  v_rows jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('reports');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'accountant', 'viewer') THEN
    RAISE EXCEPTION 'HSN summary requires Owner, Manager, Accountant, or Viewer access.';
  END IF;

  IF v_scope = 'purchases' THEN
    IF public.is_module_enabled('purchases') THEN
      SELECT COALESCE(jsonb_agg(row_to_json(h) ORDER BY h.taxable_value DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT
          COALESCE(NULLIF(trim(pl.hsn_code), ''), 'UNSPECIFIED') AS hsn_code,
          pl.entered_unit_code AS uqc,
          pl.gst_rate,
          SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.entered_qty ELSE pl.entered_qty END)::numeric(15,3) AS total_qty,
          SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.taxable_amount ELSE pl.taxable_amount END)::numeric(15,2) AS taxable_value,
          SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.cgst_amount ELSE pl.cgst_amount END)::numeric(15,2) AS cgst_amount,
          SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.sgst_amount ELSE pl.sgst_amount END)::numeric(15,2) AS sgst_amount,
          SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.igst_amount ELSE pl.igst_amount END)::numeric(15,2) AS igst_amount,
          SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.tax_amount ELSE pl.tax_amount END)::numeric(15,2) AS total_tax,
          SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.line_total ELSE pl.line_total END)::numeric(15,2) AS total_value
        FROM public.purchase_lines pl
        JOIN public.purchase_bills pb ON pb.id = pl.purchase_id
        WHERE pb.status = 'posted' AND pb.bill_date BETWEEN v_from AND v_to
        GROUP BY COALESCE(NULLIF(trim(pl.hsn_code), ''), 'UNSPECIFIED'), pl.entered_unit_code, pl.gst_rate
      ) h;
    END IF;
  ELSE
    IF public.is_module_enabled('billing') THEN
      SELECT COALESCE(jsonb_agg(row_to_json(h) ORDER BY h.taxable_value DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT
          COALESCE(NULLIF(trim(bl.hsn_code), ''), 'UNSPECIFIED') AS hsn_code,
          bl.entered_unit_code AS uqc,
          bl.gst_rate,
          SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.entered_qty ELSE bl.entered_qty END)::numeric(15,3) AS total_qty,
          SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.taxable_amount ELSE bl.taxable_amount END)::numeric(15,2) AS taxable_value,
          SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.cgst_amount ELSE bl.cgst_amount END)::numeric(15,2) AS cgst_amount,
          SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.sgst_amount ELSE bl.sgst_amount END)::numeric(15,2) AS sgst_amount,
          SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.igst_amount ELSE bl.igst_amount END)::numeric(15,2) AS igst_amount,
          SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.tax_amount ELSE bl.tax_amount END)::numeric(15,2) AS total_tax,
          SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.line_total ELSE bl.line_total END)::numeric(15,2) AS total_value
        FROM public.bill_lines bl
        JOIN public.bills b ON b.id = bl.bill_id
        WHERE b.status = 'issued'
          AND b.doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
          AND b.bill_date BETWEEN v_from AND v_to
        GROUP BY COALESCE(NULLIF(trim(bl.hsn_code), ''), 'UNSPECIFIED'), bl.entered_unit_code, bl.gst_rate
      ) h;
    END IF;
  END IF;

  RETURN jsonb_build_object('scope', v_scope, 'from_date', v_from, 'to_date', v_to, 'rows', v_rows);
END;
$$;

-- ============================================================================
-- 7. Sales, Purchases, Stock & Party Dues Ageing Reports
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_sales_reports(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE,
  p_group_by text DEFAULT 'register'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_uid uuid := auth.uid();
  v_is_cashier boolean;
  v_from date := COALESCE(p_from_date, date_trunc('month', CURRENT_DATE)::date);
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_group text := COALESCE(NULLIF(lower(trim(p_group_by)), ''), 'register');
  v_rows jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('reports');
  PERFORM public.require_module('billing');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant', 'viewer') THEN
    RAISE EXCEPTION 'You do not have permission to view sales reports.';
  END IF;
  v_is_cashier := (v_role = 'cashier');

  IF v_group = 'item' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.net_amount DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        bl.item_id,
        bl.item_name,
        MAX(bl.sku) AS sku,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.base_qty ELSE bl.base_qty END)::numeric(15,3) AS net_base_qty,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.taxable_amount ELSE bl.taxable_amount END)::numeric(15,2) AS taxable_amount,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.tax_amount ELSE bl.tax_amount END)::numeric(15,2) AS tax_amount,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -bl.line_total ELSE bl.line_total END)::numeric(15,2) AS net_amount,
        count(DISTINCT b.id)::integer AS bills_count
      FROM public.bill_lines bl
      JOIN public.bills b ON b.id = bl.bill_id
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
        AND b.bill_date BETWEEN v_from AND v_to
        AND (NOT v_is_cashier OR b.created_by = v_uid)
      GROUP BY bl.item_id, bl.item_name
    ) r;
  ELSIF v_group = 'party' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.net_sales DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        b.party_id,
        b.party_name,
        count(*)::integer AS bills_count,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -b.grand_total ELSE b.grand_total END)::numeric(15,2) AS net_sales,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN 0 ELSE b.paid_amount END)::numeric(15,2) AS total_paid,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN 0 ELSE b.balance_due END)::numeric(15,2) AS balance_due
      FROM public.bills b
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
        AND b.bill_date BETWEEN v_from AND v_to
        AND (NOT v_is_cashier OR b.created_by = v_uid)
      GROUP BY b.party_id, b.party_name
    ) r;
  ELSIF v_group = 'user' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.net_sales DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        b.created_by,
        COALESCE(p.full_name, 'Staff') AS staff_name,
        count(*)::integer AS bills_count,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -b.grand_total ELSE b.grand_total END)::numeric(15,2) AS net_sales,
        SUM(CASE WHEN b.doc_type = 'credit_note' THEN -b.paid_amount ELSE b.paid_amount END)::numeric(15,2) AS net_collected
      FROM public.bills b
      LEFT JOIN public.profiles p ON p.id = b.created_by
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
        AND b.bill_date BETWEEN v_from AND v_to
        AND (NOT v_is_cashier OR b.created_by = v_uid)
      GROUP BY b.created_by, p.full_name
    ) r;
  ELSIF v_group = 'returns' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.bill_date DESC, r.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        b.id, b.bill_number, sb.bill_number AS source_bill_number, b.bill_date,
        b.party_name, b.subtotal_taxable, b.tax_total, b.grand_total, b.paid_amount AS refund_amount,
        b.return_reason, b.created_at
      FROM public.bills b
      LEFT JOIN public.bills sb ON sb.id = b.source_bill_id
      WHERE b.status = 'issued'
        AND b.doc_type = 'credit_note'
        AND b.bill_date BETWEEN v_from AND v_to
        AND (NOT v_is_cashier OR b.created_by = v_uid)
    ) r;
  ELSIF v_group = 'quotations' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.bill_date DESC, r.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        b.id, b.bill_number, b.status, b.bill_date, b.valid_until,
        b.party_name, b.grand_total, cb.bill_number AS converted_to_bill_number, b.created_at
      FROM public.bills b
      LEFT JOIN public.bills cb ON cb.id = b.converted_to_bill_id
      WHERE b.doc_type = 'quotation'
        AND b.status <> 'draft'
        AND b.bill_date BETWEEN v_from AND v_to
        AND (NOT v_is_cashier OR b.created_by = v_uid)
    ) r;
  ELSE
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.bill_date DESC, r.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        b.id, b.bill_number, b.doc_type, b.status, b.payment_status, b.bill_date,
        b.party_name, b.party_gstin, b.subtotal_taxable, b.tax_total, b.grand_total,
        b.paid_amount, b.credited_amount, b.balance_due, b.payment_mode, b.created_at
      FROM public.bills b
      WHERE b.status = 'issued'
        AND b.doc_type IN ('tax_invoice', 'bill_of_supply', 'credit_note')
        AND b.bill_date BETWEEN v_from AND v_to
        AND (NOT v_is_cashier OR b.created_by = v_uid)
    ) r;
  END IF;

  RETURN jsonb_build_object('group_by', v_group, 'from_date', v_from, 'to_date', v_to, 'rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_purchase_reports(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE,
  p_group_by text DEFAULT 'register'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_from date := COALESCE(p_from_date, date_trunc('month', CURRENT_DATE)::date);
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_group text := COALESCE(NULLIF(lower(trim(p_group_by)), ''), 'register');
  v_rows jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('reports');
  PERFORM public.require_module('purchases');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'accountant', 'viewer') THEN
    RAISE EXCEPTION 'You do not have permission to view purchase reports.';
  END IF;

  IF v_group = 'supplier' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.net_purchases DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        pb.party_id,
        pb.party_name,
        count(*)::integer AS bills_count,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pb.grand_total ELSE pb.grand_total END)::numeric(15,2) AS net_purchases,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN 0 ELSE pb.paid_amount END)::numeric(15,2) AS total_paid,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN 0 ELSE pb.balance_due END)::numeric(15,2) AS balance_due
      FROM public.purchase_bills pb
      WHERE pb.status = 'posted' AND pb.bill_date BETWEEN v_from AND v_to
      GROUP BY pb.party_id, pb.party_name
    ) r;
  ELSIF v_group = 'item' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.net_amount DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        pl.item_id,
        pl.item_name,
        MAX(pl.sku) AS sku,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.base_qty ELSE pl.base_qty END)::numeric(15,3) AS net_base_qty,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.taxable_amount ELSE pl.taxable_amount END)::numeric(15,2) AS taxable_amount,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.tax_amount ELSE pl.tax_amount END)::numeric(15,2) AS tax_amount,
        SUM(CASE WHEN pb.doc_type = 'purchase_return' THEN -pl.line_total ELSE pl.line_total END)::numeric(15,2) AS net_amount
      FROM public.purchase_lines pl
      JOIN public.purchase_bills pb ON pb.id = pl.purchase_id
      WHERE pb.status = 'posted' AND pb.bill_date BETWEEN v_from AND v_to
      GROUP BY pl.item_id, pl.item_name
    ) r;
  ELSE
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.bill_date DESC, r.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        pb.id, pb.purchase_number, pb.doc_type, pb.status, pb.payment_status, pb.bill_date,
        pb.supplier_invoice_no, pb.party_name, pb.party_gstin,
        pb.subtotal_taxable, pb.tax_total, pb.freight_charges, pb.grand_total,
        pb.paid_amount, pb.credited_amount, pb.balance_due, pb.payment_mode, pb.created_at
      FROM public.purchase_bills pb
      WHERE pb.status = 'posted' AND pb.bill_date BETWEEN v_from AND v_to
    ) r;
  END IF;

  RETURN jsonb_build_object('group_by', v_group, 'from_date', v_from, 'to_date', v_to, 'rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_stock_reports(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE,
  p_view text DEFAULT 'summary'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_can_view_cost boolean;
  v_from date := COALESCE(p_from_date, date_trunc('month', CURRENT_DATE)::date);
  v_to date := COALESCE(p_to_date, CURRENT_DATE);
  v_view text := COALESCE(NULLIF(lower(trim(p_view)), ''), 'summary');
  v_rows jsonb := '[]'::jsonb;
  v_total_valuation numeric(15,2);
BEGIN
  PERFORM public.require_module('reports');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Staff access required.';
  END IF;
  v_can_view_cost := v_role IN ('owner', 'manager', 'accountant');

  IF v_view = 'ledger' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.movement_date DESC, r.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        sl.id, sl.item_id, i.name AS item_name, sl.movement_type, sl.movement_date,
        sl.entered_qty, iu.code AS entered_unit_code, sl.signed_base_qty,
        CASE WHEN v_can_view_cost THEN sl.unit_cost ELSE NULL END AS unit_cost,
        sl.reference_no, sl.reason, sl.created_at
      FROM public.stock_ledger sl
      JOIN public.items i ON i.id = sl.item_id
      JOIN public.item_units iu ON iu.id = sl.entered_unit_id
      WHERE sl.movement_date BETWEEN v_from AND v_to
      ORDER BY sl.movement_date DESC, sl.created_at DESC
      LIMIT 300
    ) r;
  ELSE
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.name ASC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        ic.id, ic.name, ic.sku, ic.category_name, ic.brand_name,
        ic.base_unit_code, ic.qty_on_hand, ic.low_stock_alert,
        ic.is_low_stock, ic.is_out_of_stock, ic.selling_price,
        CASE WHEN v_can_view_cost THEN ic.purchase_price ELSE NULL END AS purchase_price,
        CASE WHEN v_can_view_cost THEN ic.stock_value ELSE NULL END AS stock_value
      FROM public.item_catalog_view ic
      WHERE ic.is_active = true
        AND (v_view <> 'low_stock' OR ic.is_low_stock = true OR ic.is_out_of_stock = true)
    ) r;
  END IF;

  IF v_can_view_cost THEN
    SELECT COALESCE(SUM(stock_value), 0)::numeric(15,2)
    INTO v_total_valuation
    FROM public.item_catalog_view
    WHERE is_active = true;
  ELSE
    v_total_valuation := NULL;
  END IF;

  RETURN jsonb_build_object(
    'view', v_view,
    'from_date', v_from,
    'to_date', v_to,
    'can_view_cost', v_can_view_cost,
    'total_valuation', v_total_valuation,
    'rows', v_rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_party_dues_ageing()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('reports');
  PERFORM public.require_module('parties');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'accountant', 'viewer') THEN
    RAISE EXCEPTION 'Party dues ageing requires Owner, Manager, Accountant, or Viewer access.';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(a) ORDER BY a.total_outstanding DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      p.id AS party_id,
      p.name AS party_name,
      p.party_type,
      p.phone,
      ob.direction_needed,
      SUM(CASE WHEN (CURRENT_DATE - COALESCE(ob.due_date, ob.entry_date)) <= 30 THEN ob.remaining_amount ELSE 0 END)::numeric(15,2) AS bucket_0_30,
      SUM(CASE WHEN (CURRENT_DATE - COALESCE(ob.due_date, ob.entry_date)) BETWEEN 31 AND 60 THEN ob.remaining_amount ELSE 0 END)::numeric(15,2) AS bucket_31_60,
      SUM(CASE WHEN (CURRENT_DATE - COALESCE(ob.due_date, ob.entry_date)) BETWEEN 61 AND 90 THEN ob.remaining_amount ELSE 0 END)::numeric(15,2) AS bucket_61_90,
      SUM(CASE WHEN (CURRENT_DATE - COALESCE(ob.due_date, ob.entry_date)) > 90 THEN ob.remaining_amount ELSE 0 END)::numeric(15,2) AS bucket_90_plus,
      SUM(ob.remaining_amount)::numeric(15,2) AS total_outstanding,
      MAX(GREATEST(0, CURRENT_DATE - COALESCE(ob.due_date, ob.entry_date)))::integer AS max_days
    FROM public.party_open_obligations ob
    JOIN public.parties p ON p.id = ob.party_id
    WHERE p.is_active = true
    GROUP BY p.id, p.name, p.party_type, p.phone, ob.direction_needed
  ) a;

  RETURN jsonb_build_object('as_of_date', CURRENT_DATE, 'rows', v_rows);
END;
$$;

-- ============================================================================
-- 8. Notifications, Storage Usage, Backup Export & Owner Restore
-- ============================================================================
CREATE OR REPLACE FUNCTION public.sync_system_notifications()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_low_count integer := 0;
  v_out_count integer := 0;
  v_overdue_count integer := 0;
  v_overdue_amt numeric(15,2) := 0;
  v_last_backup timestamptz;
  v_days_since_backup integer := 999;
  v_list jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Active staff access required.';
  END IF;
  v_role := public.current_user_role();

  -- 1. Inventory Low/Out of stock
  IF public.is_module_enabled('inventory') THEN
    SELECT
      count(*) FILTER (WHERE is_active = true AND is_low_stock = true)::integer,
      count(*) FILTER (WHERE is_active = true AND is_out_of_stock = true)::integer
    INTO v_low_count, v_out_count
    FROM public.item_catalog_view;

    IF v_low_count > 0 OR v_out_count > 0 THEN
      INSERT INTO public.notifications (
        rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi,
        target_tab, min_roles, is_resolved
      )
      VALUES (
        'low_stock',
        'system:low_stock',
        CASE WHEN v_out_count > 0 THEN 'critical' ELSE 'warning' END,
        v_low_count || ' low-stock & ' || v_out_count || ' out-of-stock item(s)',
        v_low_count || ' कम स्टॉक और ' || v_out_count || ' स्टॉक खत्म आइटम',
        'Review stock levels and create supplier purchases or stock adjustments.',
        'स्टॉक स्तर की समीक्षा करें और सप्लायर खरीद या स्टॉक समायोजन दर्ज करें।',
        'items',
        ARRAY['owner', 'manager', 'storekeeper'],
        false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        severity = EXCLUDED.severity,
        title_en = EXCLUDED.title_en,
        title_hi = EXCLUDED.title_hi,
        is_resolved = false,
        updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:low_stock';
    END IF;
  END IF;

  -- 2. Overdue Party Khata dues
  IF public.is_module_enabled('parties') THEN
    SELECT
      count(*) FILTER (WHERE is_active = true AND is_overdue = true)::integer,
      COALESCE(SUM(overdue_receivable) FILTER (WHERE is_active = true), 0)::numeric(15,2)
    INTO v_overdue_count, v_overdue_amt
    FROM public.party_balances;

    IF v_overdue_count > 0 THEN
      INSERT INTO public.notifications (
        rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi,
        target_tab, min_roles, is_resolved
      )
      VALUES (
        'overdue_khata',
        'system:overdue_khata',
        'warning',
        v_overdue_count || ' party account(s) have overdue Khata balances',
        v_overdue_count || ' पार्टियों का खाता बकाया समय सीमा पार है',
        'Total overdue receivables: ₹' || v_overdue_amt || '. Send payment reminders from Parties.',
        'कुल बकाया वसूली: ₹' || v_overdue_amt || '। पार्टी स्क्रीन से रिमाइंडर भेजें।',
        'parties',
        ARRAY['owner', 'manager', 'accountant'],
        false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        title_en = EXCLUDED.title_en,
        title_hi = EXCLUDED.title_hi,
        body_en = EXCLUDED.body_en,
        body_hi = EXCLUDED.body_hi,
        is_resolved = false,
        updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:overdue_khata';
    END IF;
  END IF;

  -- 3. Backup Overdue (>= 7 days or never backed up)
  IF public.is_module_enabled('backup') THEN
    SELECT last_backup_at INTO v_last_backup FROM public.business WHERE id = 1;
    v_days_since_backup := CASE
      WHEN v_last_backup IS NULL THEN 999
      ELSE GREATEST(0, floor(extract(epoch FROM (now() - v_last_backup)) / 86400)::integer)
    END;

    IF v_last_backup IS NULL OR v_days_since_backup >= 7 THEN
      INSERT INTO public.notifications (
        rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi,
        target_tab, min_roles, is_resolved
      )
      VALUES (
        'backup_overdue',
        'system:backup_overdue',
        CASE WHEN v_last_backup IS NULL THEN 'warning' ELSE 'critical' END,
        CASE WHEN v_last_backup IS NULL THEN 'No local backup downloaded yet' ELSE 'Last backup was ' || v_days_since_backup || ' days ago' END,
        CASE WHEN v_last_backup IS NULL THEN 'अभी तक कोई लोकल बैकअप नहीं लिया गया है' ELSE 'अंतिम बैकअप ' || v_days_since_backup || ' दिन पहले लिया गया था' END,
        'Download an updated workspace backup from Settings -> Backup & Storage.',
        'सेटिंग्स -> बैकअप और स्टोरेज से नवीनतम बैकअप डाउनलोड करें।',
        'settings',
        ARRAY['owner', 'manager', 'accountant'],
        false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        severity = EXCLUDED.severity,
        title_en = EXCLUDED.title_en,
        title_hi = EXCLUDED.title_hi,
        is_resolved = false,
        updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:backup_overdue';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(n) ORDER BY n.is_read ASC, n.created_at DESC), '[]'::jsonb)
  INTO v_list
  FROM (
    SELECT id, rule_key, severity, title_en, title_hi, body_en, body_hi, target_tab, target_id, is_read, created_at
    FROM public.notifications
    WHERE is_resolved = false
      AND v_role = ANY(min_roles)
    ORDER BY is_read ASC, created_at DESC
    LIMIT 25
  ) n;

  RETURN jsonb_build_object(
    'unread_count', (SELECT count(*)::integer FROM public.notifications WHERE is_resolved = false AND is_read = false AND v_role = ANY(min_roles)),
    'notifications', v_list
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
BEGIN
  IF NOT public.is_active_staff() THEN
    RAISE EXCEPTION 'Active staff access required.';
  END IF;

  IF p_notification_id IS NULL THEN
    UPDATE public.notifications
    SET is_read = true, read_at = now(), read_by = auth.uid()
    WHERE is_read = false AND v_role = ANY(min_roles);
  ELSE
    UPDATE public.notifications
    SET is_read = true, read_at = now(), read_by = auth.uid()
    WHERE id = p_notification_id AND v_role = ANY(min_roles);
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_storage_usage_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_total_bytes bigint := 0;
  v_file_count integer := 0;
  v_quota_bytes bigint := 536870912; -- 512 MB default starter allowance
  v_by_purpose jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Storage usage summary requires Owner, Manager, or Accountant access.';
  END IF;

  SELECT COALESCE(SUM(size_bytes), 0)::bigint, count(*)::integer
  INTO v_total_bytes, v_file_count
  FROM public.files;

  SELECT COALESCE(jsonb_agg(row_to_json(p) ORDER BY p.total_bytes DESC), '[]'::jsonb)
  INTO v_by_purpose
  FROM (
    SELECT purpose, count(*)::integer AS file_count, COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes
    FROM public.files
    GROUP BY purpose
  ) p;

  v_counts := jsonb_build_object(
    'parties', (SELECT count(*)::integer FROM public.parties),
    'items', (SELECT count(*)::integer FROM public.items),
    'bills', (SELECT count(*)::integer FROM public.bills),
    'purchases', (SELECT count(*)::integer FROM public.purchase_bills),
    'expenses', (SELECT count(*)::integer FROM public.expenses),
    'payments', (SELECT count(*)::integer FROM public.payments)
  );

  RETURN jsonb_build_object(
    'total_bytes', v_total_bytes,
    'file_count', v_file_count,
    'quota_bytes', v_quota_bytes,
    'usage_pct', round(((v_total_bytes::numeric / v_quota_bytes::numeric) * 100.0), 2),
    'by_purpose', v_by_purpose,
    'table_counts', v_counts
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.export_workspace_backup(p_backup_type text DEFAULT 'manual')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_type text := CASE WHEN p_backup_type IN ('manual', 'pre_restore') THEN p_backup_type ELSE 'manual' END;
  v_data jsonb;
  v_counts jsonb;
  v_snapshot jsonb;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('backup');
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can export workspace backups.';
  END IF;

  v_data := jsonb_build_object(
    'business', COALESCE((SELECT to_jsonb(b) FROM public.business b WHERE b.id = 1), '{}'::jsonb),
    'modules_state', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.module_key) FROM public.modules_state m), '[]'::jsonb),
    'numbering_series', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.series_key, n.fy_code) FROM public.numbering_series n), '[]'::jsonb),
    'files', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at) FROM public.files f), '[]'::jsonb),
    'file_links', COALESCE((SELECT jsonb_agg(to_jsonb(fl) ORDER BY fl.created_at) FROM public.file_links fl), '[]'::jsonb),
    'parties', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at) FROM public.parties p), '[]'::jsonb),
    'party_addresses', COALESCE((SELECT jsonb_agg(to_jsonb(pa) ORDER BY pa.created_at) FROM public.party_addresses pa), '[]'::jsonb),
    'item_categories', COALESCE((SELECT jsonb_agg(to_jsonb(ic) ORDER BY ic.name) FROM public.item_categories ic), '[]'::jsonb),
    'brands', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.name) FROM public.brands br), '[]'::jsonb),
    'item_units', COALESCE((SELECT jsonb_agg(to_jsonb(iu) ORDER BY iu.code) FROM public.item_units iu), '[]'::jsonb),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(it) ORDER BY it.created_at) FROM public.items it), '[]'::jsonb),
    'unit_conversions', COALESCE((SELECT jsonb_agg(to_jsonb(uc) ORDER BY uc.created_at) FROM public.unit_conversions uc), '[]'::jsonb),
    'item_images', COALESCE((SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.created_at) FROM public.item_images ii), '[]'::jsonb),
    'stock_ledger', COALESCE((SELECT jsonb_agg(to_jsonb(sl) ORDER BY sl.created_at) FROM public.stock_ledger sl), '[]'::jsonb),
    'bills', COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.created_at) FROM public.bills bl), '[]'::jsonb),
    'bill_lines', COALESCE((SELECT jsonb_agg(to_jsonb(bll) ORDER BY bll.bill_id, bll.line_no) FROM public.bill_lines bll), '[]'::jsonb),
    'purchase_bills', COALESCE((SELECT jsonb_agg(to_jsonb(pb) ORDER BY pb.created_at) FROM public.purchase_bills pb), '[]'::jsonb),
    'purchase_lines', COALESCE((SELECT jsonb_agg(to_jsonb(pl) ORDER BY pl.purchase_id, pl.line_no) FROM public.purchase_lines pl), '[]'::jsonb),
    'expense_categories', COALESCE((SELECT jsonb_agg(to_jsonb(ec) ORDER BY ec.code) FROM public.expense_categories ec), '[]'::jsonb),
    'expenses', COALESCE((SELECT jsonb_agg(to_jsonb(ex) ORDER BY ex.created_at) FROM public.expenses ex), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(pm) ORDER BY pm.created_at) FROM public.payments pm), '[]'::jsonb),
    'party_ledger_entries', COALESCE((SELECT jsonb_agg(to_jsonb(le) ORDER BY le.created_at) FROM public.party_ledger_entries le), '[]'::jsonb),
    'payment_allocations', COALESCE((SELECT jsonb_agg(to_jsonb(al) ORDER BY al.created_at) FROM public.payment_allocations al), '[]'::jsonb)
  );

  v_counts := jsonb_build_object(
    'parties', jsonb_array_length(v_data->'parties'),
    'items', jsonb_array_length(v_data->'items'),
    'bills', jsonb_array_length(v_data->'bills'),
    'purchase_bills', jsonb_array_length(v_data->'purchase_bills'),
    'expenses', jsonb_array_length(v_data->'expenses'),
    'payments', jsonb_array_length(v_data->'payments')
  );

  UPDATE public.business SET last_backup_at = now() WHERE id = 1;
  UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:backup_overdue';

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.backup_records (backup_type, schema_version, size_bytes, record_counts, created_by)
  VALUES (v_type, 'p5-v1', length(v_data::text)::bigint, v_counts, auth.uid());

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'backup.exported', 'backup', v_type,
    jsonb_build_object('schema_version', 'p5-v1', 'counts', v_counts)
  );

  v_snapshot := jsonb_build_object(
    'app', 'BizOne ERP',
    'schema_version', 'p5-v1',
    'exported_at', now(),
    'exported_by', v_actor_email,
    'record_counts', v_counts,
    'data', v_data
  );

  RETURN v_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_workspace_backup(
  p_snapshot jsonb,
  p_checksum text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_data jsonb;
  v_biz jsonb;
  v_counts jsonb;
  v_actor_email text;
  v_rec jsonb;
BEGIN
  PERFORM public.require_module('backup');
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the business Owner can restore a backup.';
  END IF;

  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'Invalid backup file: root JSON object is missing.';
  END IF;
  IF COALESCE(p_snapshot->>'schema_version', '') <> 'p5-v1' THEN
    RAISE EXCEPTION 'Unsupported backup schema version (%). Expected p5-v1.', COALESCE(p_snapshot->>'schema_version', 'none');
  END IF;

  v_data := p_snapshot->'data';
  IF v_data IS NULL OR jsonb_typeof(v_data) <> 'object' THEN
    RAISE EXCEPTION 'Invalid backup file: data payload is missing.';
  END IF;
  IF v_data->'business' IS NULL OR jsonb_typeof(v_data->'business') <> 'object' THEN
    RAISE EXCEPTION 'Invalid backup file: business settings record is missing.';
  END IF;

  PERFORM set_config('app.restore_context', txid_current()::text, true);

  -- Clear tables in strict child-to-parent dependency order (preserves auth/profiles/integrations/files)
  DELETE FROM public.file_links;
  DELETE FROM public.bill_share_links;
  DELETE FROM public.bill_lines;
  DELETE FROM public.purchase_lines;
  DELETE FROM public.payment_allocations;
  DELETE FROM public.party_ledger_entries;
  DELETE FROM public.payments;
  DELETE FROM public.stock_ledger;
  DELETE FROM public.stock_balances;
  DELETE FROM public.bills;
  DELETE FROM public.purchase_bills;
  DELETE FROM public.expenses;
  DELETE FROM public.item_images;
  DELETE FROM public.unit_conversions;
  DELETE FROM public.items;
  DELETE FROM public.item_categories;
  DELETE FROM public.brands;
  DELETE FROM public.party_addresses;
  DELETE FROM public.parties;
  DELETE FROM public.numbering_series;

  -- Insert any referenced file metadata missing in current DB
  IF jsonb_typeof(v_data->'files') = 'array' AND jsonb_array_length(v_data->'files') > 0 THEN
    INSERT INTO public.files (id, bucket, storage_path, file_name, mime_type, size_bytes, checksum, purpose, uploaded_by, created_at)
    SELECT r.id, r.bucket, r.storage_path, r.file_name, r.mime_type, r.size_bytes, r.checksum, r.purpose,
      CASE WHEN EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.uploaded_by) THEN r.uploaded_by ELSE auth.uid() END,
      r.created_at
    FROM jsonb_populate_recordset(NULL::public.files, v_data->'files') r
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- Restore business settings (id=1)
  v_biz := v_data->'business';
  UPDATE public.business
  SET
    name = COALESCE(NULLIF(v_biz->>'name', ''), name),
    pack = COALESCE(NULLIF(v_biz->>'pack', ''), pack),
    gst_registered = COALESCE((v_biz->>'gst_registered')::boolean, gst_registered),
    gstin = NULLIF(v_biz->>'gstin', ''),
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
    FOR v_rec IN SELECT value FROM jsonb_array_elements(v_data->'modules_state')
    LOOP
      INSERT INTO public.modules_state (module_key, enabled)
      VALUES (v_rec->>'module_key', COALESCE((v_rec->>'enabled')::boolean, false))
      ON CONFLICT (module_key) DO UPDATE SET enabled = EXCLUDED.enabled;
    END LOOP;
  END IF;

  IF jsonb_typeof(v_data->'numbering_series') = 'array' AND jsonb_array_length(v_data->'numbering_series') > 0 THEN
    INSERT INTO public.numbering_series (series_key, fy_code, prefix, next_number, padding, created_at, updated_at)
    SELECT r.series_key, r.fy_code, r.prefix, r.next_number, r.padding, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.numbering_series, v_data->'numbering_series') r;
  END IF;

  IF jsonb_typeof(v_data->'item_units') = 'array' AND jsonb_array_length(v_data->'item_units') > 0 THEN
    INSERT INTO public.item_units (id, code, name_en, name_hi, allow_decimal, is_system, is_active, created_at)
    SELECT r.id, r.code, r.name_en, r.name_hi, r.allow_decimal, r.is_system, r.is_active, r.created_at
    FROM jsonb_populate_recordset(NULL::public.item_units, v_data->'item_units') r
    ON CONFLICT (id) DO NOTHING;
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

  IF jsonb_typeof(v_data->'items') = 'array' AND jsonb_array_length(v_data->'items') > 0 THEN
    INSERT INTO public.items (id, name, sku, barcode, category_id, brand_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, tax_inclusive, low_stock_alert, allow_negative_stock, primary_image_file_id, pack_metadata, notes, is_active, is_demo, version, created_by, created_at, updated_at)
    SELECT r.id, r.name, r.sku, r.barcode, r.category_id, r.brand_id, r.base_unit_id, r.selling_price, r.mrp, r.purchase_price, r.gst_rate, r.hsn_code, r.tax_inclusive, r.low_stock_alert, r.allow_negative_stock,
      CASE WHEN r.primary_image_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.primary_image_file_id) THEN r.primary_image_file_id ELSE NULL END,
      r.pack_metadata, r.notes, r.is_active, r.is_demo, r.version, auth.uid(), r.created_at, r.updated_at
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
    FROM jsonb_populate_recordset(NULL::public.expense_categories, v_data->'expense_categories') r
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF jsonb_typeof(v_data->'bills') = 'array' AND jsonb_array_length(v_data->'bills') > 0 THEN
    -- Parent bills before child credit notes/converted bills
    INSERT INTO public.bills (
      id, bill_number, doc_type, status, source_bill_id, converted_from_quotation_id, converted_to_bill_id,
      party_id, party_name, party_phone, party_gstin, party_address, place_of_supply_state_code, is_interstate,
      bill_date, due_date, valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total, paid_amount, credited_amount,
      balance_due, notes, terms, business_snapshot, void_reason, voided_at, voided_by, return_reason,
      idempotency_key, issued_at, issued_by, is_demo, created_by, created_at, updated_at, payment_mode, payment_reference
    )
    SELECT
      r.id, r.bill_number, r.doc_type, r.status, r.source_bill_id, NULL, NULL,
      r.party_id, r.party_name, r.party_phone, r.party_gstin, r.party_address, r.place_of_supply_state_code, r.is_interstate,
      r.bill_date, r.due_date, r.valid_until, r.gst_applied, r.subtotal_taxable, r.discount_total, r.cgst_total, r.sgst_total,
      r.igst_total, r.tax_total, r.extra_charges, r.auto_round_off, r.round_off, r.grand_total, r.paid_amount, r.credited_amount,
      r.balance_due, r.notes, r.terms, r.business_snapshot, r.void_reason, r.voided_at, auth.uid(), r.return_reason,
      r.idempotency_key, r.issued_at, auth.uid(), r.is_demo, auth.uid(), r.created_at, r.updated_at, COALESCE(r.payment_mode, 'cash'), r.payment_reference
    FROM jsonb_populate_recordset(NULL::public.bills, v_data->'bills') r
    ORDER BY (r.source_bill_id IS NOT NULL) ASC, r.created_at ASC;

    UPDATE public.bills b
    SET converted_from_quotation_id = src.converted_from_quotation_id,
        converted_to_bill_id = src.converted_to_bill_id
    FROM jsonb_populate_recordset(NULL::public.bills, v_data->'bills') src
    WHERE b.id = src.id
      AND (src.converted_from_quotation_id IS NOT NULL OR src.converted_to_bill_id IS NOT NULL);
  END IF;

  IF jsonb_typeof(v_data->'bill_lines') = 'array' AND jsonb_array_length(v_data->'bill_lines') > 0 THEN
    INSERT INTO public.bill_lines (
      id, bill_id, line_no, item_id, source_bill_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, created_at
    )
    SELECT
      r.id, r.bill_id, r.line_no, r.item_id, r.source_bill_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.catalog_unit_price, r.unit_price, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.created_at
    FROM jsonb_populate_recordset(NULL::public.bill_lines, v_data->'bill_lines') r
    ORDER BY (r.source_bill_line_id IS NOT NULL) ASC, r.created_at ASC;
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

  IF jsonb_typeof(v_data->'purchase_lines') = 'array' AND jsonb_array_length(v_data->'purchase_lines') > 0 THEN
    INSERT INTO public.purchase_lines (
      id, purchase_id, line_no, item_id, source_purchase_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, created_at
    )
    SELECT
      r.id, r.purchase_id, r.line_no, r.item_id, r.source_purchase_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.unit_cost, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.created_at
    FROM jsonb_populate_recordset(NULL::public.purchase_lines, v_data->'purchase_lines') r
    ORDER BY (r.source_purchase_line_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'expenses') = 'array' AND jsonb_array_length(v_data->'expenses') > 0 THEN
    INSERT INTO public.expenses (
      id, expense_number, category_id, expense_date, amount, payment_mode, reference_no,
      paid_to, notes, attachment_file_id, status, void_reason, voided_at, voided_by,
      idempotency_key, is_demo, created_by, created_at, updated_at
    )
    SELECT
      r.id, r.expense_number, r.category_id, r.expense_date, r.amount, r.payment_mode, r.reference_no,
      r.paid_to, r.notes,
      CASE WHEN r.attachment_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.attachment_file_id) THEN r.attachment_file_id ELSE NULL END,
      r.status, r.void_reason, r.voided_at, auth.uid(),
      r.idempotency_key, r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.expenses, v_data->'expenses') r;
  END IF;

  IF jsonb_typeof(v_data->'payments') = 'array' AND jsonb_array_length(v_data->'payments') > 0 THEN
    INSERT INTO public.payments (
      id, payment_number, party_id, direction, amount, allocated_amount, advance_amount,
      mode, payment_date, reference_no, notes, status, idempotency_key,
      reversed_at, reversed_by, reversal_reason, is_demo, created_by, created_at, updated_at
    )
    SELECT
      r.id, r.payment_number, r.party_id, r.direction, r.amount, r.allocated_amount, r.advance_amount,
      r.mode, r.payment_date, r.reference_no, r.notes, r.status, r.idempotency_key,
      r.reversed_at, auth.uid(), r.reversal_reason, r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.payments, v_data->'payments') r;
  END IF;

  IF jsonb_typeof(v_data->'party_ledger_entries') = 'array' AND jsonb_array_length(v_data->'party_ledger_entries') > 0 THEN
    INSERT INTO public.party_ledger_entries (
      id, party_id, entry_type, entry_date, due_date, reference_no, source_table, source_id,
      signed_amount, note, idempotency_key, is_reversed, reversed_by_entry_id, is_demo, created_by, created_at
    )
    SELECT
      r.id, r.party_id, r.entry_type, r.entry_date, r.due_date, r.reference_no, r.source_table, r.source_id,
      r.signed_amount, r.note, r.idempotency_key, r.is_reversed, NULL, r.is_demo, auth.uid(), r.created_at
    FROM jsonb_populate_recordset(NULL::public.party_ledger_entries, v_data->'party_ledger_entries') r;

    UPDATE public.party_ledger_entries le
    SET reversed_by_entry_id = src.reversed_by_entry_id
    FROM jsonb_populate_recordset(NULL::public.party_ledger_entries, v_data->'party_ledger_entries') src
    WHERE le.id = src.id AND src.reversed_by_entry_id IS NOT NULL;
  END IF;

  IF jsonb_typeof(v_data->'payment_allocations') = 'array' AND jsonb_array_length(v_data->'payment_allocations') > 0 THEN
    INSERT INTO public.payment_allocations (id, payment_id, party_id, target_type, ledger_entry_id, target_label, allocated_amount, is_reversed, created_at)
    SELECT r.id, r.payment_id, r.party_id, r.target_type, r.ledger_entry_id, r.target_label, r.allocated_amount, r.is_reversed, r.created_at
    FROM jsonb_populate_recordset(NULL::public.payment_allocations, v_data->'payment_allocations') r;
  END IF;

  -- Disable balance trigger validation edge order by rebuilding stock_ledger in chronological order
  IF jsonb_typeof(v_data->'stock_ledger') = 'array' AND jsonb_array_length(v_data->'stock_ledger') > 0 THEN
    INSERT INTO public.stock_ledger (
      id, item_id, movement_type, movement_date, entered_qty, entered_unit_id,
      conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
      source_table, source_id, idempotency_key, is_demo, created_by, created_at
    )
    SELECT
      r.id, r.item_id, r.movement_type, r.movement_date, r.entered_qty, r.entered_unit_id,
      r.conversion_factor, r.signed_base_qty, r.unit_cost, r.reason, r.reference_no,
      r.source_table, r.source_id, r.idempotency_key, r.is_demo, auth.uid(), r.created_at
    FROM jsonb_populate_recordset(NULL::public.stock_ledger, v_data->'stock_ledger') r
    ORDER BY r.movement_date ASC, r.created_at ASC;
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
    'payments', (SELECT count(*)::integer FROM public.payments)
  );

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.backup_records (backup_type, schema_version, checksum, size_bytes, record_counts, created_by)
  VALUES ('restore', 'p5-v1', p_checksum, length(p_snapshot::text)::bigint, v_counts, auth.uid());

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    'backup.restored', 'backup', 'p5-v1',
    jsonb_build_object('checksum', p_checksum, 'counts', v_counts)
  );

  RETURN jsonb_build_object('restored', true, 'counts', v_counts);
END;
$$;

-- ============================================================================
-- 9. Grants for All P5 Reports, Notifications, Storage & Backup RPCs
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.get_dashboard_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_day_book(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_profit_estimate(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_gst_summary(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_hsn_summary(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_reports(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_purchase_reports(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_stock_reports(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_party_dues_ageing() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_system_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_storage_usage_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.export_workspace_backup(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_workspace_backup(jsonb, text) TO authenticated;
