-- BizOne ERP - Phase P7: Optional AI, Advanced Modules & v1.0 Hardening
-- Implements:
--   1. Optional Integration Slots ('einvoice_gsp', AI model routing) + Multi-provider AI profiles
--      (encrypted_key column strictly hidden from authenticated/anon clients).
--   2. AI Conversations, Messages, Playbooks, Action Proposals (payload-hash & token-bound,
--      Owner-only approval, no AI self-approval) & Usage Logs.
--   3. Tally-style Double-Entry Accounting: Account Groups, Ledgers, Cost Centres, Vouchers,
--      Voucher Entries (deferred Dr=Cr balance constraint trigger), Bank Reconciliations,
--      Opening Balance Migration, Trial Balance, P&L Statement & Balance Sheet RPCs.
--   4. Advanced GST & Tax: E-Invoice/E-Way Bill records, GSTR-2B ITC Reconciliation,
--      TDS/TCS entries, GSTR-1 & GSTR-3B RPCs.
--   5. Multi-Location Stock ('locations' module), Transfers, Physical Counts, POS-lite Cash Registers
--      & Held Bills, Orders/Challans/POs, Leads, Recurring Rules, Cheque Register,
--      and Idempotent Offline Queue Sync RPC.
--   6. Messaging Templates & Delivery Logs ('messaging' module).
--   7. Updated export_workspace_backup (schema p7-v1, excludes ALL secrets), restore_workspace_backup,
--      and reset_workspace_data.

-- ============================================================================
-- 1. Optional Integration Slots & Multi-Provider AI Configs
-- ============================================================================
INSERT INTO public.integration_settings (integration_key, enabled, display_name, config_public, status)
VALUES (
  'einvoice_gsp',
  false,
  'E-Invoice & E-Way Bill GSP',
  '{"provider": "nic_sandbox", "gst_portal_username": "", "base_url": ""}'::jsonb,
  'not_configured'
)
ON CONFLICT (integration_key) DO NOTHING;

UPDATE public.integration_settings
SET config_public = jsonb_set(config_public, '{model}', '"gemini-4-hydrogen"'::jsonb)
WHERE integration_key = 'ai_provider'
  AND COALESCE(config_public->>'model', '') IN ('', 'gemini-2.5-flash');

CREATE TABLE IF NOT EXISTS public.ai_provider_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'gemini', 'openrouter', 'grok', 'custom')),
  base_url text,
  model text NOT NULL,
  routing_role text NOT NULL DEFAULT 'default' CHECK (routing_role IN ('default', 'chat', 'analytics', 'automation')),
  daily_token_limit integer NOT NULL DEFAULT 200000 CHECK (daily_token_limit >= 1000),
  has_key boolean NOT NULL DEFAULT false,
  encrypted_key text,
  is_active boolean NOT NULL DEFAULT true,
  last_tested_at timestamptz,
  last_test_status text NOT NULL DEFAULT 'untested',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_ai_provider_profiles_updated_at ON public.ai_provider_profiles;
CREATE TRIGGER trg_ai_provider_profiles_updated_at
  BEFORE UPDATE ON public.ai_provider_profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.ai_provider_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_provider_profiles FROM anon, authenticated;
GRANT SELECT (id, label, provider, base_url, model, routing_role, daily_token_limit, has_key, is_active, last_tested_at, last_test_status, created_at, updated_at)
  ON public.ai_provider_profiles TO authenticated;

DROP POLICY IF EXISTS "Owner reads ai_provider_profiles metadata" ON public.ai_provider_profiles;
CREATE POLICY "Owner reads ai_provider_profiles metadata" ON public.ai_provider_profiles
  FOR SELECT TO authenticated
  USING (public.is_owner());

-- ============================================================================
-- 2. AI Conversations, Messages, Playbooks, Action Proposals & Usage Logs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New Chat',
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi', 'hinglish')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user
  ON public.ai_conversations (user_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_ai_conversations_updated_at ON public.ai_conversations;
CREATE TRIGGER trg_ai_conversations_updated_at
  BEFORE UPDATE ON public.ai_conversations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  structured_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools_used text[] NOT NULL DEFAULT ARRAY[]::text[],
  provider text,
  model text,
  tokens_used integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conv
  ON public.ai_messages (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS public.ai_playbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playbook_key text NOT NULL UNIQUE,
  title_en text NOT NULL,
  title_hi text NOT NULL,
  description_en text NOT NULL,
  description_hi text NOT NULL,
  required_module text,
  enabled boolean NOT NULL DEFAULT false,
  schedule_hint text NOT NULL DEFAULT 'On demand / daily digest',
  last_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.ai_playbooks (playbook_key, title_en, title_hi, description_en, description_hi, required_module, enabled, schedule_hint)
VALUES
  ('overdue_reminders', 'Overdue Khata Reminder Drafts', 'बकाया खाता रिमाइंडर ड्राफ्ट', 'Finds overdue parties and prepares payment reminder drafts for Owner approval.', 'बकाया पार्टियों के लिए भुगतान रिमाइंडर ड्राफ्ट तैयार करता है।', 'parties', true, 'Daily'),
  ('open_quotation_followups', 'Open Quotation Follow-ups', 'खुले कोटेशन फॉलो-अप', 'Identifies open quotations near expiry and prepares polite follow-up drafts.', 'समाप्त होने वाले कोटेशन के लिए फॉलो-अप ड्राफ्ट बनाता है।', 'billing', true, 'Daily'),
  ('reorder_suggestions', 'Low-Stock Reorder PO Drafts', 'कम स्टॉक रीऑर्डर ड्राफ्ट', 'Checks low-stock items and prepares draft supplier purchase orders.', 'कम स्टॉक आइटम के लिए सप्लायर ऑर्डर ड्राफ्ट तैयार करता है।', 'purchases', true, 'Daily'),
  ('near_expiry_clearance', 'Near-Expiry Clearance Alerts', 'एक्सपायरी क्लियरेंस सुझाव', 'Flags batches expiring within 60 days for discount or return proposals.', '60 दिनों में समाप्त होने वाले बैच के लिए सुझाव देता है।', 'batch_expiry', false, 'Weekly'),
  ('warranty_due_followups', 'Warranty Renewal / Service Due', 'वारंटी और सर्विस फॉलो-अप', 'Reviews expiring warranties and upcoming service due dates.', 'समाप्त हो रही वारंटी और सर्विस तिथियों की जांच करता है।', 'billing', false, 'Weekly'),
  ('daily_closing_summary', 'Daily Closing Summary', 'दैनिक क्लोजिंग सारांश', 'Summarizes day sales, cash/bank collections, expenses, and exceptions.', 'दिन की बिक्री, नकद/बैंक संग्रह और खर्च का सारांश बनाता है।', 'reports', true, 'Evening'),
  ('weekly_business_digest', 'Weekly Business Summary', 'साप्ताहिक व्यापार सारांश', '7-day comparative performance digest with top items and overdue trends.', '7 दिनों की बिक्री, शीर्ष आइटम और बकाया रुझान का विश्लेषण।', 'reports', true, 'Weekly')
ON CONFLICT (playbook_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ai_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES public.ai_conversations(id) ON DELETE SET NULL,
  playbook_key text,
  tool_name text NOT NULL,
  action_summary text NOT NULL,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  consequences text[] NOT NULL DEFAULT ARRAY[]::text[],
  payload_hash text NOT NULL,
  approval_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  proposed_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  proposed_by_role text NOT NULL,
  approved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejection_reason text,
  execution_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ai_proposals_status
  ON public.ai_action_proposals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('chat', 'analytics', 'playbook', 'test')),
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_conversations FROM anon, authenticated;
REVOKE ALL ON public.ai_messages FROM anon, authenticated;
REVOKE ALL ON public.ai_playbooks FROM anon, authenticated;
REVOKE ALL ON public.ai_action_proposals FROM anon, authenticated;
REVOKE ALL ON public.ai_usage_logs FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_conversations TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.ai_messages TO authenticated;
GRANT SELECT, UPDATE ON public.ai_playbooks TO authenticated;
GRANT SELECT (id, conversation_id, playbook_key, tool_name, action_summary, before_snapshot, proposed_payload, consequences, payload_hash, expires_at, status, proposed_by_user_id, proposed_by_role, approved_by_user_id, rejection_reason, execution_result, created_at, decided_at)
  ON public.ai_action_proposals TO authenticated;
GRANT SELECT ON public.ai_usage_logs TO authenticated;

DROP POLICY IF EXISTS "Users manage own ai_conversations" ON public.ai_conversations;
CREATE POLICY "Users manage own ai_conversations" ON public.ai_conversations
  FOR ALL TO authenticated
  USING (public.is_active_staff() AND user_id = auth.uid())
  WITH CHECK (public.is_active_staff() AND user_id = auth.uid());

DROP POLICY IF EXISTS "Users manage own ai_messages" ON public.ai_messages;
CREATE POLICY "Users manage own ai_messages" ON public.ai_messages
  FOR ALL TO authenticated
  USING (public.is_active_staff() AND user_id = auth.uid())
  WITH CHECK (public.is_active_staff() AND user_id = auth.uid());

DROP POLICY IF EXISTS "Staff read ai_playbooks" ON public.ai_playbooks;
CREATE POLICY "Staff read ai_playbooks" ON public.ai_playbooks
  FOR SELECT TO authenticated
  USING (public.is_active_staff());

DROP POLICY IF EXISTS "Owner updates ai_playbooks" ON public.ai_playbooks;
CREATE POLICY "Owner updates ai_playbooks" ON public.ai_playbooks
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "Staff read own or owner all ai_action_proposals" ON public.ai_action_proposals;
CREATE POLICY "Staff read own or owner all ai_action_proposals" ON public.ai_action_proposals
  FOR SELECT TO authenticated
  USING (public.is_active_staff() AND (public.is_owner() OR proposed_by_user_id = auth.uid()));

DROP POLICY IF EXISTS "Owner reads ai_usage_logs" ON public.ai_usage_logs;
CREATE POLICY "Owner reads ai_usage_logs" ON public.ai_usage_logs
  FOR SELECT TO authenticated
  USING (public.is_owner());

-- ============================================================================
-- 3. Tally-Style Double-Entry Accounting ('accounting' module)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.account_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  nature text NOT NULL CHECK (nature IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_group_id uuid REFERENCES public.account_groups(id) ON DELETE SET NULL,
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.account_groups (code, name, nature, is_system) VALUES
  ('CAP', 'Capital Account', 'equity', true),
  ('LOAN', 'Loans (Liability)', 'liability', true),
  ('CLIA', 'Current Liabilities', 'liability', true),
  ('FIXA', 'Fixed Assets', 'asset', true),
  ('CASS', 'Current Assets', 'asset', true),
  ('CASH_BANK', 'Cash & Bank Balances', 'asset', true),
  ('SALE', 'Sales Accounts', 'income', true),
  ('INDI', 'Indirect Incomes', 'income', true),
  ('PURC', 'Purchase Accounts', 'expense', true),
  ('DIRE', 'Direct Expenses', 'expense', true),
  ('INDE', 'Indirect Expenses', 'expense', true),
  ('TAX', 'Duties & Taxes', 'liability', true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  group_id uuid NOT NULL REFERENCES public.account_groups(id) ON DELETE RESTRICT,
  opening_balance numeric(15,2) NOT NULL DEFAULT 0,
  opening_side text NOT NULL DEFAULT 'debit' CHECK (opening_side IN ('debit', 'credit')),
  is_bank boolean NOT NULL DEFAULT false,
  bank_account_no text,
  ifsc_code text,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_ledgers_updated_at ON public.ledgers;
CREATE TRIGGER trg_ledgers_updated_at
  BEFORE UPDATE ON public.ledgers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.ledgers (code, name, group_id, opening_balance, opening_side, is_bank, is_system)
SELECT v.code, v.name, g.id, 0, v.side, v.is_bank, true
FROM (VALUES
  ('CASH', 'Cash-in-Hand', 'CASH_BANK', 'debit', false),
  ('BANK_MAIN', 'Primary Bank Account', 'CASH_BANK', 'debit', true),
  ('AR', 'Sundry Debtors (Receivable)', 'CASS', 'debit', false),
  ('AP', 'Sundry Creditors (Payable)', 'CLIA', 'credit', false),
  ('INV_STOCK', 'Closing Stock / Inventory', 'CASS', 'debit', false),
  ('SALES', 'Sales Account', 'SALE', 'credit', false),
  ('PURCHASES', 'Purchase Account', 'PURC', 'debit', false),
  ('CGST_OUT', 'Output CGST', 'TAX', 'credit', false),
  ('SGST_OUT', 'Output SGST', 'TAX', 'credit', false),
  ('IGST_OUT', 'Output IGST', 'TAX', 'credit', false),
  ('CGST_IN', 'Input CGST Credit', 'CASS', 'debit', false),
  ('SGST_IN', 'Input SGST Credit', 'CASS', 'debit', false),
  ('IGST_IN', 'Input IGST Credit', 'CASS', 'debit', false),
  ('OP_EXP', 'Operating & Shop Expenses', 'INDE', 'debit', false),
  ('FREIGHT', 'Freight & Cartage', 'DIRE', 'debit', false),
  ('ROUND_OFF', 'Round Off', 'INDE', 'debit', false),
  ('OWNER_CAP', 'Owner Capital / Opening Equity', 'CAP', 'credit', false)
) AS v(code, name, grp_code, side, is_bank)
JOIN public.account_groups g ON g.code = v.grp_code
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.cost_centres (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.cost_centres (code, name)
VALUES ('MAIN', 'Main Shop / Counter')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number text NOT NULL UNIQUE,
  voucher_type text NOT NULL CHECK (voucher_type IN ('journal', 'contra', 'receipt', 'payment', 'sales', 'purchase', 'debit_note', 'credit_note')),
  voucher_date date NOT NULL DEFAULT CURRENT_DATE,
  narration text,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided')),
  cost_centre_id uuid REFERENCES public.cost_centres(id) ON DELETE SET NULL,
  source_table text,
  source_id uuid,
  total_debit numeric(15,2) NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
  total_credit numeric(15,2) NOT NULL DEFAULT 0 CHECK (total_credit >= 0),
  void_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'voided' OR total_debit = total_credit)
);

CREATE INDEX IF NOT EXISTS idx_vouchers_date ON public.vouchers (voucher_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.voucher_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES public.vouchers(id) ON DELETE CASCADE,
  ledger_id uuid NOT NULL REFERENCES public.ledgers(id) ON DELETE RESTRICT,
  entry_side text NOT NULL CHECK (entry_side IN ('debit', 'credit')),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  line_narration text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voucher_entries_voucher ON public.voucher_entries (voucher_id);
CREATE INDEX IF NOT EXISTS idx_voucher_entries_ledger ON public.voucher_entries (ledger_id);

CREATE OR REPLACE FUNCTION public.enforce_voucher_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_vid uuid := COALESCE(NEW.voucher_id, OLD.voucher_id);
  v_status text;
  v_dr numeric(15,2);
  v_cr numeric(15,2);
BEGIN
  SELECT status INTO v_status FROM public.vouchers WHERE id = v_vid;
  IF NOT FOUND OR v_status = 'voided' THEN
    RETURN NULL;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN entry_side = 'debit' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN entry_side = 'credit' THEN amount ELSE 0 END), 0)
  INTO v_dr, v_cr
  FROM public.voucher_entries
  WHERE voucher_id = v_vid;

  IF v_dr <= 0 OR v_dr <> v_cr THEN
    RAISE EXCEPTION 'Double-entry voucher must balance cleanly (Debit %, Credit %).', v_dr, v_cr;
  END IF;

  UPDATE public.vouchers
  SET total_debit = v_dr, total_credit = v_cr, updated_at = now()
  WHERE id = v_vid;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_voucher_entries_balanced ON public.voucher_entries;
CREATE CONSTRAINT TRIGGER trg_voucher_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.voucher_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_voucher_balanced();

CREATE TABLE IF NOT EXISTS public.bank_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES public.ledgers(id) ON DELETE CASCADE,
  statement_date date NOT NULL,
  bank_reference text,
  description text NOT NULL,
  entry_side text NOT NULL CHECK (entry_side IN ('debit', 'credit')),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  matched_voucher_id uuid REFERENCES public.vouchers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'reconciled')),
  reconciled_at timestamptz,
  reconciled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_centres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_reconciliations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.account_groups, public.ledgers, public.cost_centres, public.vouchers, public.voucher_entries, public.bank_reconciliations FROM anon, authenticated;
GRANT SELECT ON public.account_groups, public.ledgers, public.cost_centres, public.vouchers, public.voucher_entries, public.bank_reconciliations TO authenticated;

DROP POLICY IF EXISTS "Accounting roles read account_groups" ON public.account_groups;
CREATE POLICY "Accounting roles read account_groups" ON public.account_groups FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "Accounting roles read ledgers" ON public.ledgers;
CREATE POLICY "Accounting roles read ledgers" ON public.ledgers FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "Accounting roles read cost_centres" ON public.cost_centres;
CREATE POLICY "Accounting roles read cost_centres" ON public.cost_centres FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "Accounting roles read vouchers" ON public.vouchers;
CREATE POLICY "Accounting roles read vouchers" ON public.vouchers FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "Accounting roles read voucher_entries" ON public.voucher_entries;
CREATE POLICY "Accounting roles read voucher_entries" ON public.voucher_entries FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "Accounting roles read bank_reconciliations" ON public.bank_reconciliations;
CREATE POLICY "Accounting roles read bank_reconciliations" ON public.bank_reconciliations FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

CREATE OR REPLACE FUNCTION public.preview_accounting_migration()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receivables numeric(15,2) := 0;
  v_payables numeric(15,2) := 0;
  v_stock_value numeric(15,2) := 0;
  v_cash_net numeric(15,2) := 0;
  v_bank_net numeric(15,2) := 0;
  v_existing_vouchers integer := 0;
BEGIN
  PERFORM public.require_module('accounting');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Accounting permissions required.';
  END IF;

  SELECT COALESCE(SUM(GREATEST(net_balance, 0)), 0), COALESCE(SUM(GREATEST(-net_balance, 0)), 0)
  INTO v_receivables, v_payables
  FROM public.party_balances WHERE is_active = true;

  SELECT COALESCE(SUM(GREATEST(qty_on_hand, 0) * COALESCE(purchase_price, 0)), 0)
  INTO v_stock_value
  FROM public.item_catalog_view WHERE is_active = true;

  SELECT COALESCE(SUM(CASE WHEN mode = 'cash' THEN CASE WHEN direction = 'receive' THEN amount ELSE -amount END ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN mode <> 'cash' THEN CASE WHEN direction = 'receive' THEN amount ELSE -amount END ELSE 0 END), 0)
  INTO v_cash_net, v_bank_net
  FROM public.payments WHERE status = 'posted';

  SELECT count(*)::integer INTO v_existing_vouchers FROM public.vouchers WHERE status = 'posted';

  RETURN jsonb_build_object(
    'receivables', round(v_receivables, 2),
    'payables', round(v_payables, 2),
    'inventory_value', round(v_stock_value, 2),
    'cash_balance', round(GREATEST(v_cash_net, 0), 2),
    'bank_balance', round(GREATEST(v_bank_net, 0), 2),
    'existing_vouchers_count', v_existing_vouchers
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.next_series_number(
  p_series_key text,
  p_default_prefix text DEFAULT 'DOC-',
  p_doc_date date DEFAULT CURRENT_DATE
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fy_code text := public.compute_fy_code(COALESCE(p_doc_date, CURRENT_DATE));
  v_prefix text := COALESCE(NULLIF(trim(p_default_prefix), ''), upper(left(p_series_key, 3)) || '-');
  v_next integer;
  v_padding integer;
BEGIN
  INSERT INTO public.numbering_series (series_key, fy_code, prefix, next_number, padding)
  VALUES (p_series_key, v_fy_code, v_prefix, 1, 4)
  ON CONFLICT (series_key, fy_code) DO NOTHING;

  SELECT next_number, padding
  INTO v_next, v_padding
  FROM public.numbering_series
  WHERE series_key = p_series_key AND fy_code = v_fy_code
  FOR UPDATE;

  UPDATE public.numbering_series
  SET prefix = v_prefix,
      next_number = v_next + 1,
      updated_at = now()
  WHERE series_key = p_series_key AND fy_code = v_fy_code;

  RETURN v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_accounting_from_existing(
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev jsonb := public.preview_accounting_migration();
  v_vid uuid;
  v_vnum text;
  v_rec numeric := (v_prev->>'receivables')::numeric;
  v_pay numeric := (v_prev->>'payables')::numeric;
  v_inv numeric := (v_prev->>'inventory_value')::numeric;
  v_cash numeric := (v_prev->>'cash_balance')::numeric;
  v_bank numeric := (v_prev->>'bank_balance')::numeric;
  v_assets numeric := v_rec + v_inv + v_cash + v_bank;
  v_equity numeric := v_assets - v_pay;
  v_lid_ar uuid; v_lid_ap uuid; v_lid_inv uuid; v_lid_cash uuid; v_lid_bank uuid; v_lid_cap uuid;
BEGIN
  PERFORM public.require_module('accounting');
  IF NOT public.has_any_role(ARRAY['owner', 'accountant']) THEN
    RAISE EXCEPTION 'Only Owner or Accountant can post opening accounting balances.';
  END IF;

  IF v_assets <= 0 AND v_pay <= 0 THEN
    RETURN jsonb_build_object('initialized', false, 'message', 'All source balances are zero; no opening voucher needed.');
  END IF;

  SELECT id INTO v_lid_ar FROM public.ledgers WHERE code = 'AR';
  SELECT id INTO v_lid_ap FROM public.ledgers WHERE code = 'AP';
  SELECT id INTO v_lid_inv FROM public.ledgers WHERE code = 'INV_STOCK';
  SELECT id INTO v_lid_cash FROM public.ledgers WHERE code = 'CASH';
  SELECT id INTO v_lid_bank FROM public.ledgers WHERE code = 'BANK_MAIN';
  SELECT id INTO v_lid_cap FROM public.ledgers WHERE code = 'OWNER_CAP';

  v_vnum := public.next_series_number('voucher', 'VCH-', COALESCE(p_as_of_date, CURRENT_DATE));
  INSERT INTO public.vouchers (voucher_number, voucher_type, voucher_date, narration, status, total_debit, total_credit, created_by)
  VALUES (v_vnum, 'journal', COALESCE(p_as_of_date, CURRENT_DATE), 'Guided opening balance migration from BizOne operational books', 'posted', GREATEST(v_assets, v_pay), GREATEST(v_assets, v_pay), auth.uid())
  RETURNING id INTO v_vid;

  IF v_cash > 0 THEN INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration) VALUES (v_vid, v_lid_cash, 'debit', v_cash, 'Opening Cash'); END IF;
  IF v_bank > 0 THEN INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration) VALUES (v_vid, v_lid_bank, 'debit', v_bank, 'Opening Bank'); END IF;
  IF v_rec > 0 THEN INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration) VALUES (v_vid, v_lid_ar, 'debit', v_rec, 'Opening Receivables'); END IF;
  IF v_inv > 0 THEN INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration) VALUES (v_vid, v_lid_inv, 'debit', v_inv, 'Opening Inventory'); END IF;
  IF v_pay > 0 THEN INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration) VALUES (v_vid, v_lid_ap, 'credit', v_pay, 'Opening Payables'); END IF;

  IF v_equity > 0 THEN
    INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration) VALUES (v_vid, v_lid_cap, 'credit', v_equity, 'Opening Capital Balance');
  ELSIF v_equity < 0 THEN
    INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration) VALUES (v_vid, v_lid_cap, 'debit', abs(v_equity), 'Opening Deficit Balance');
  END IF;

  RETURN jsonb_build_object('initialized', true, 'voucher_id', v_vid, 'voucher_number', v_vnum);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_accounting_voucher(
  p_voucher_type text,
  p_voucher_date date DEFAULT CURRENT_DATE,
  p_narration text DEFAULT NULL,
  p_entries jsonb DEFAULT '[]'::jsonb,
  p_cost_centre_id uuid DEFAULT NULL
)
RETURNS public.vouchers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.vouchers;
  v_vnum text;
  v_entry jsonb;
  v_dr numeric(15,2) := 0;
  v_cr numeric(15,2) := 0;
  v_amt numeric(15,2);
  v_side text;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('accounting');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can post accounting vouchers.';
  END IF;

  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) < 2 THEN
    RAISE EXCEPTION 'At least two voucher lines (debit and credit) are required.';
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    v_side := COALESCE(v_entry->>'entry_side', '');
    v_amt := round(COALESCE((v_entry->>'amount')::numeric, 0), 2);
    IF v_side NOT IN ('debit', 'credit') OR v_amt <= 0 THEN
      RAISE EXCEPTION 'Each voucher entry must specify entry_side (debit/credit) and positive amount.';
    END IF;
    IF v_side = 'debit' THEN v_dr := v_dr + v_amt; ELSE v_cr := v_cr + v_amt; END IF;
  END LOOP;

  IF v_dr <= 0 OR v_dr <> v_cr THEN
    RAISE EXCEPTION 'Voucher is out of balance: Debit % vs Credit %.', v_dr, v_cr;
  END IF;

  v_vnum := public.next_series_number('voucher', 'VCH-', COALESCE(p_voucher_date, CURRENT_DATE));
  INSERT INTO public.vouchers (
    voucher_number, voucher_type, voucher_date, narration, status, cost_centre_id, total_debit, total_credit, created_by
  )
  VALUES (
    v_vnum, p_voucher_type, COALESCE(p_voucher_date, CURRENT_DATE),
    NULLIF(trim(COALESCE(p_narration, '')), ''), 'posted', p_cost_centre_id, v_dr, v_cr, auth.uid()
  )
  RETURNING * INTO v_row;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    INSERT INTO public.voucher_entries (voucher_id, ledger_id, entry_side, amount, line_narration)
    VALUES (
      v_row.id,
      (v_entry->>'ledger_id')::uuid,
      v_entry->>'entry_side',
      round((v_entry->>'amount')::numeric, 2),
      NULLIF(trim(COALESCE(v_entry->>'line_narration', '')), '')
    );
  END LOOP;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_actor_email, 'accounting.voucher_posted', 'voucher', v_row.id::text, jsonb_build_object('voucher_number', v_vnum, 'type', p_voucher_type, 'amount', v_dr));

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_accounting_voucher(p_voucher_id uuid, p_reason text)
RETURNS public.vouchers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.vouchers;
BEGIN
  PERFORM public.require_module('accounting');
  IF NOT public.has_any_role(ARRAY['owner', 'accountant']) THEN
    RAISE EXCEPTION 'Only Owner or Accountant can void vouchers.';
  END IF;
  IF length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Void reason is required.';
  END IF;

  UPDATE public.vouchers
  SET status = 'voided', void_reason = trim(p_reason), voided_at = now(), voided_by = auth.uid()
  WHERE id = p_voucher_id AND status = 'posted'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Posted voucher not found.'; END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trial_balance(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows jsonb;
  v_tot_dr numeric(15,2) := 0;
  v_tot_cr numeric(15,2) := 0;
BEGIN
  PERFORM public.require_module('accounting');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Accounting permissions required.';
  END IF;

  WITH ledger_totals AS (
    SELECT
      l.id,
      l.code,
      l.name,
      ag.name AS group_name,
      ag.nature,
      CASE WHEN l.opening_side = 'debit' THEN l.opening_balance ELSE 0 END AS op_dr,
      CASE WHEN l.opening_side = 'credit' THEN l.opening_balance ELSE 0 END AS op_cr,
      COALESCE(SUM(CASE WHEN ve.entry_side = 'debit' AND v.status = 'posted' AND v.voucher_date BETWEEN p_from_date AND p_to_date THEN ve.amount ELSE 0 END), 0) AS period_dr,
      COALESCE(SUM(CASE WHEN ve.entry_side = 'credit' AND v.status = 'posted' AND v.voucher_date BETWEEN p_from_date AND p_to_date THEN ve.amount ELSE 0 END), 0) AS period_cr
    FROM public.ledgers l
    JOIN public.account_groups ag ON ag.id = l.group_id
    LEFT JOIN public.voucher_entries ve ON ve.ledger_id = l.id
    LEFT JOIN public.vouchers v ON v.id = ve.voucher_id
    WHERE l.is_active = true
    GROUP BY l.id, l.code, l.name, ag.name, ag.nature, l.opening_side, l.opening_balance
  ),
  computed AS (
    SELECT *,
      GREATEST((op_dr + period_dr) - (op_cr + period_cr), 0) AS closing_dr,
      GREATEST((op_cr + period_cr) - (op_dr + period_dr), 0) AS closing_cr
    FROM ledger_totals
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.code), '[]'::jsonb),
    COALESCE(SUM(c.closing_dr), 0),
    COALESCE(SUM(c.closing_cr), 0)
  INTO v_rows, v_tot_dr, v_tot_cr
  FROM computed c
  WHERE (c.op_dr + c.op_cr + c.period_dr + c.period_cr) > 0;

  RETURN jsonb_build_object(
    'from_date', p_from_date,
    'to_date', p_to_date,
    'rows', v_rows,
    'total_debit', round(v_tot_dr, 2),
    'total_credit', round(v_tot_cr, 2),
    'is_balanced', (round(v_tot_dr, 2) = round(v_tot_cr, 2))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_financial_statements(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tb jsonb := public.get_trial_balance(p_from_date, p_to_date);
  v_income numeric(15,2) := 0;
  v_expense numeric(15,2) := 0;
  v_assets numeric(15,2) := 0;
  v_liabilities numeric(15,2) := 0;
  v_equity numeric(15,2) := 0;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN r->>'nature' = 'income' THEN (r->>'closing_cr')::numeric - (r->>'closing_dr')::numeric ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r->>'nature' = 'expense' THEN (r->>'closing_dr')::numeric - (r->>'closing_cr')::numeric ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r->>'nature' = 'asset' THEN (r->>'closing_dr')::numeric - (r->>'closing_cr')::numeric ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r->>'nature' = 'liability' THEN (r->>'closing_cr')::numeric - (r->>'closing_dr')::numeric ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r->>'nature' = 'equity' THEN (r->>'closing_cr')::numeric - (r->>'closing_dr')::numeric ELSE 0 END), 0)
  INTO v_income, v_expense, v_assets, v_liabilities, v_equity
  FROM jsonb_array_elements(v_tb->'rows') r;

  RETURN jsonb_build_object(
    'from_date', p_from_date,
    'to_date', p_to_date,
    'trial_balance', v_tb,
    'profit_and_loss', jsonb_build_object(
      'total_income', round(v_income, 2),
      'total_expense', round(v_expense, 2),
      'net_profit', round(v_income - v_expense, 2)
    ),
    'balance_sheet', jsonb_build_object(
      'total_assets', round(v_assets, 2),
      'total_liabilities', round(v_liabilities, 2),
      'total_equity_with_profit', round(v_equity + (v_income - v_expense), 2),
      'difference', round(v_assets - (v_liabilities + v_equity + (v_income - v_expense)), 2)
    )
  );
END;
$$;

-- ============================================================================
-- 4. Advanced GST, E-Invoice / E-Way Bill, GSTR-2B ITC & TDS/TCS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.einvoice_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  irn text,
  ack_no text,
  ack_date timestamptz,
  qr_payload text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generated', 'cancelled', 'failed')),
  eway_bill_no text,
  eway_valid_until timestamptz,
  vehicle_no text,
  transporter_name text,
  distance_km integer,
  error_message text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.gstr2b_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month text NOT NULL,
  supplier_gstin text NOT NULL,
  supplier_name text,
  invoice_no text NOT NULL,
  invoice_date date NOT NULL,
  taxable_value numeric(15,2) NOT NULL DEFAULT 0,
  cgst numeric(15,2) NOT NULL DEFAULT 0,
  sgst numeric(15,2) NOT NULL DEFAULT 0,
  igst numeric(15,2) NOT NULL DEFAULT 0,
  matched_purchase_id uuid REFERENCES public.purchase_bills(id) ON DELETE SET NULL,
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'mismatch', 'missing_in_books', 'unmatched')),
  variance_amount numeric(15,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tds_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_type text NOT NULL DEFAULT 'TDS' CHECK (tax_type IN ('TDS', 'TCS')),
  section_code text NOT NULL,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL,
  pan_no text,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  base_amount numeric(15,2) NOT NULL CHECK (base_amount > 0),
  rate_pct numeric(5,2) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  tax_amount numeric(15,2) NOT NULL CHECK (tax_amount >= 0),
  challan_no text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deposited')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.einvoice_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gstr2b_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tds_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.einvoice_records, public.gstr2b_entries, public.tds_entries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.einvoice_records, public.gstr2b_entries, public.tds_entries TO authenticated;

DROP POLICY IF EXISTS "GST roles manage einvoice_records" ON public.einvoice_records;
CREATE POLICY "GST roles manage einvoice_records" ON public.einvoice_records FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "GST roles manage gstr2b_entries" ON public.gstr2b_entries;
CREATE POLICY "GST roles manage gstr2b_entries" ON public.gstr2b_entries FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "GST roles manage tds_entries" ON public.tds_entries;
CREATE POLICY "GST roles manage tds_entries" ON public.tds_entries FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

CREATE OR REPLACE FUNCTION public.get_gstr1_data(
  p_from_date date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_b2b jsonb;
  v_b2c jsonb;
  v_cdnr jsonb;
BEGIN
  PERFORM public.require_module('tax');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Tax report permission required.';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bill_id', b.id, 'bill_number', b.bill_number, 'bill_date', b.bill_date,
    'party_name', b.party_name, 'party_gstin', b.party_gstin,
    'place_of_supply', b.place_of_supply_state_code,
    'taxable_value', b.subtotal_taxable, 'cgst', b.cgst_total, 'sgst', b.sgst_total, 'igst', b.igst_total,
    'grand_total', b.grand_total
  ) ORDER BY b.bill_date, b.bill_number), '[]'::jsonb)
  INTO v_b2b
  FROM public.bills b
  WHERE b.status = 'issued' AND b.doc_type = 'tax_invoice' AND b.bill_date BETWEEN p_from_date AND p_to_date
    AND b.party_gstin IS NOT NULL AND length(trim(b.party_gstin)) = 15;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'place_of_supply', sub.place_of_supply,
    'is_interstate', sub.is_interstate,
    'invoice_count', sub.invoice_count,
    'taxable_value', sub.taxable_value,
    'cgst', sub.cgst,
    'sgst', sub.sgst,
    'igst', sub.igst,
    'grand_total', sub.grand_total
  )), '[]'::jsonb)
  INTO v_b2c
  FROM (
    SELECT
      COALESCE(b.place_of_supply_state_code, 'LOCAL') AS place_of_supply,
      b.is_interstate,
      count(*)::integer AS invoice_count,
      round(SUM(b.subtotal_taxable), 2) AS taxable_value,
      round(SUM(b.cgst_total), 2) AS cgst,
      round(SUM(b.sgst_total), 2) AS sgst,
      round(SUM(b.igst_total), 2) AS igst,
      round(SUM(b.grand_total), 2) AS grand_total
    FROM public.bills b
    WHERE b.status = 'issued' AND b.doc_type IN ('tax_invoice', 'bill_of_supply') AND b.bill_date BETWEEN p_from_date AND p_to_date
      AND (b.party_gstin IS NULL OR length(trim(b.party_gstin)) <> 15)
    GROUP BY COALESCE(b.place_of_supply_state_code, 'LOCAL'), b.is_interstate
  ) sub;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bill_number', b.bill_number, 'bill_date', b.bill_date, 'party_name', b.party_name, 'party_gstin', b.party_gstin,
    'taxable_value', b.subtotal_taxable, 'tax_total', b.tax_total, 'grand_total', b.grand_total
  ) ORDER BY b.bill_date), '[]'::jsonb)
  INTO v_cdnr
  FROM public.bills b
  WHERE b.status = 'issued' AND b.doc_type = 'credit_note' AND b.bill_date BETWEEN p_from_date AND p_to_date;

  RETURN jsonb_build_object(
    'from_date', p_from_date,
    'to_date', p_to_date,
    'b2b', v_b2b,
    'b2c_summary', v_b2c,
    'credit_notes', v_cdnr
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_gstr2b_itc(p_period_month text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.gstr2b_entries;
  v_pur public.purchase_bills;
  v_matched integer := 0;
  v_mismatch integer := 0;
  v_missing integer := 0;
BEGIN
  PERFORM public.require_module('tax');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Tax reconciliation permission required.';
  END IF;

  FOR v_row IN SELECT * FROM public.gstr2b_entries WHERE period_month = p_period_month LOOP
    SELECT * INTO v_pur
    FROM public.purchase_bills pb
    WHERE pb.status = 'posted'
      AND pb.doc_type = 'purchase_bill'
      AND upper(COALESCE(pb.party_gstin, '')) = upper(v_row.supplier_gstin)
      AND upper(COALESCE(pb.supplier_invoice_no, pb.purchase_number, '')) = upper(v_row.invoice_no)
    LIMIT 1;

    IF NOT FOUND THEN
      UPDATE public.gstr2b_entries
      SET matched_purchase_id = NULL, match_status = 'missing_in_books',
          variance_amount = round(v_row.cgst + v_row.sgst + v_row.igst, 2)
      WHERE id = v_row.id;
      v_missing := v_missing + 1;
    ELSE
      IF abs(v_pur.tax_total - (v_row.cgst + v_row.sgst + v_row.igst)) <= 1.00 THEN
        UPDATE public.gstr2b_entries
        SET matched_purchase_id = v_pur.id, match_status = 'matched',
            variance_amount = round((v_row.cgst + v_row.sgst + v_row.igst) - v_pur.tax_total, 2)
        WHERE id = v_row.id;
        v_matched := v_matched + 1;
      ELSE
        UPDATE public.gstr2b_entries
        SET matched_purchase_id = v_pur.id, match_status = 'mismatch',
            variance_amount = round((v_row.cgst + v_row.sgst + v_row.igst) - v_pur.tax_total, 2)
        WHERE id = v_row.id;
        v_mismatch := v_mismatch + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'period_month', p_period_month,
    'matched', v_matched,
    'mismatch', v_mismatch,
    'missing_in_books', v_missing
  );
END;
$$;

-- ============================================================================
-- 5. Multi-Location Stock, POS-Lite, Orders, Leads, Cheques & Offline Sync
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  location_type text NOT NULL DEFAULT 'godown' CHECK (location_type IN ('shop', 'godown', 'branch')),
  address text,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.locations (code, name, location_type, is_default)
VALUES ('SHOP', 'Main Shop Floor', 'shop', true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.location_stock_balances (
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  qty_on_hand numeric(15,4) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, item_id)
);

CREATE TABLE IF NOT EXISTS public.stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number text NOT NULL UNIQUE,
  from_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  to_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  qty numeric(15,4) NOT NULL CHECK (qty > 0),
  transfer_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_location_id <> to_location_id)
);

CREATE TABLE IF NOT EXISTS public.physical_stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_number text NOT NULL UNIQUE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  count_date date NOT NULL DEFAULT CURRENT_DATE,
  system_qty numeric(15,4) NOT NULL,
  counted_qty numeric(15,4) NOT NULL CHECK (counted_qty >= 0),
  variance_qty numeric(15,4) NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pos_cash_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_date date NOT NULL DEFAULT CURRENT_DATE,
  opened_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_cash numeric(15,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  expected_cash numeric(15,2) NOT NULL DEFAULT 0,
  counted_cash numeric(15,2),
  variance numeric(15,2),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at timestamptz,
  notes text
);

CREATE TABLE IF NOT EXISTS public.pos_held_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_label text NOT NULL,
  payload jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  doc_kind text NOT NULL DEFAULT 'sales_order' CHECK (doc_kind IN ('sales_order', 'delivery_challan', 'purchase_order')),
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL,
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  expected_date date,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_amount numeric(15,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'fulfilled', 'cancelled')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.recurring_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type text NOT NULL CHECK (rule_type IN ('invoice', 'expense')),
  title text NOT NULL,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  frequency text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'monthly', 'quarterly')),
  next_run_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(15,2) NOT NULL DEFAULT 0,
  template_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  email text,
  source text DEFAULT 'walk_in',
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'quoted', 'won', 'lost')),
  expected_value numeric(15,2) NOT NULL DEFAULT 0,
  next_follow_up date,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cheque_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL CHECK (direction IN ('received', 'issued')),
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL,
  cheque_no text NOT NULL,
  bank_name text NOT NULL,
  cheque_date date NOT NULL,
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cleared', 'bounced', 'cancelled')),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_cash_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_held_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cheque_register ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.locations, public.location_stock_balances, public.stock_transfers, public.physical_stock_counts,
  public.pos_cash_registers, public.pos_held_bills, public.sales_orders, public.recurring_rules, public.leads, public.cheque_register
  FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.locations, public.location_stock_balances, public.stock_transfers,
  public.physical_stock_counts, public.pos_cash_registers, public.pos_held_bills, public.sales_orders,
  public.recurring_rules, public.leads, public.cheque_register TO authenticated;

DROP POLICY IF EXISTS "Staff manage locations" ON public.locations;
CREATE POLICY "Staff manage locations" ON public.locations FOR ALL TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']));

DROP POLICY IF EXISTS "Staff manage location_stock_balances" ON public.location_stock_balances;
CREATE POLICY "Staff manage location_stock_balances" ON public.location_stock_balances FOR ALL TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']));

DROP POLICY IF EXISTS "Staff manage stock_transfers" ON public.stock_transfers;
CREATE POLICY "Staff manage stock_transfers" ON public.stock_transfers FOR ALL TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']));

DROP POLICY IF EXISTS "Staff manage physical_stock_counts" ON public.physical_stock_counts;
CREATE POLICY "Staff manage physical_stock_counts" ON public.physical_stock_counts FOR ALL TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']));

DROP POLICY IF EXISTS "Billing staff manage pos_cash_registers" ON public.pos_cash_registers;
CREATE POLICY "Billing staff manage pos_cash_registers" ON public.pos_cash_registers FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']));

DROP POLICY IF EXISTS "Billing staff manage pos_held_bills" ON public.pos_held_bills;
CREATE POLICY "Billing staff manage pos_held_bills" ON public.pos_held_bills FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']));

DROP POLICY IF EXISTS "Ops staff manage sales_orders" ON public.sales_orders;
CREATE POLICY "Ops staff manage sales_orders" ON public.sales_orders FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']));

DROP POLICY IF EXISTS "Owner manager accountant manage recurring_rules" ON public.recurring_rules;
CREATE POLICY "Owner manager accountant manage recurring_rules" ON public.recurring_rules FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

DROP POLICY IF EXISTS "Staff manage leads" ON public.leads;
CREATE POLICY "Staff manage leads" ON public.leads FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'cashier']));

DROP POLICY IF EXISTS "Staff manage cheque_register" ON public.cheque_register;
CREATE POLICY "Staff manage cheque_register" ON public.cheque_register FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant', 'cashier']))
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager', 'accountant', 'cashier']));

CREATE OR REPLACE FUNCTION public.transfer_location_stock(
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_item_id uuid,
  p_qty numeric,
  p_notes text DEFAULT NULL
)
RETURNS public.stock_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.stock_transfers;
  v_tnum text;
  v_from_qty numeric(15,4) := 0;
BEGIN
  PERFORM public.require_module('locations');
  PERFORM public.require_module('inventory');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'storekeeper']) THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can transfer stock between locations.';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'Source and destination locations must differ.';
  END IF;
  IF COALESCE(p_qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Transfer quantity must be greater than zero.';
  END IF;

  INSERT INTO public.location_stock_balances (location_id, item_id, qty_on_hand)
  SELECT l.id, p_item_id, CASE WHEN l.is_default THEN COALESCE((SELECT qty_on_hand FROM public.stock_balances sb WHERE sb.item_id = p_item_id), 0) ELSE 0 END
  FROM public.locations l
  WHERE l.id IN (p_from_location_id, p_to_location_id)
  ON CONFLICT (location_id, item_id) DO NOTHING;

  SELECT qty_on_hand INTO v_from_qty FROM public.location_stock_balances
  WHERE location_id = p_from_location_id AND item_id = p_item_id FOR UPDATE;

  IF v_from_qty < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock at source location (available %, requested %).', v_from_qty, p_qty;
  END IF;

  UPDATE public.location_stock_balances SET qty_on_hand = qty_on_hand - p_qty, updated_at = now()
  WHERE location_id = p_from_location_id AND item_id = p_item_id;

  UPDATE public.location_stock_balances SET qty_on_hand = qty_on_hand + p_qty, updated_at = now()
  WHERE location_id = p_to_location_id AND item_id = p_item_id;

  v_tnum := public.next_series_number('stock_transfer', 'TRF-', CURRENT_DATE);
  INSERT INTO public.stock_transfers (transfer_number, from_location_id, to_location_id, item_id, qty, notes, created_by)
  VALUES (v_tnum, p_from_location_id, p_to_location_id, p_item_id, p_qty, NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_offline_bill_queue(p_offline_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_key text;
  v_existing public.bills;
  v_issued public.bills;
  v_results jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('billing');
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']) THEN
    RAISE EXCEPTION 'Billing permission required for offline sync.';
  END IF;

  IF jsonb_typeof(p_offline_items) <> 'array' THEN
    RAISE EXCEPTION 'Offline queue payload must be a JSON array.';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_offline_items) LOOP
    v_key := trim(COALESCE(v_item->>'idempotency_key', ''));
    IF length(v_key) < 8 THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'status', 'error',
        'error', 'Missing idempotency_key for offline bill.'
      ));
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_key LIMIT 1;
    IF FOUND THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'idempotency_key', v_key,
        'status', 'deduplicated',
        'bill_id', v_existing.id,
        'bill_number', v_existing.bill_number
      ));
      CONTINUE;
    END IF;

    BEGIN
      v_issued := public.issue_bill(
        NULL,
        COALESCE(v_item->>'doc_type', 'tax_invoice'),
        NULLIF(v_item->>'party_id', '')::uuid,
        COALESCE(NULLIF(v_item->>'bill_date', '')::date, CURRENT_DATE),
        NULLIF(v_item->>'due_date', '')::date,
        NULL,
        NULLIF(v_item->>'place_of_supply', ''),
        COALESCE((v_item->>'extra_charges')::numeric, 0),
        true,
        NULLIF(v_item->>'notes', ''),
        NULL,
        COALESCE(v_item->'lines', '[]'::jsonb),
        COALESCE((v_item->>'paid_amount')::numeric, 0),
        COALESCE(v_item->>'payment_mode', 'cash'),
        NULLIF(v_item->>'payment_reference', ''),
        v_key,
        NULL,
        NULL,
        NULL
      );
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'idempotency_key', v_key,
        'status', 'synced',
        'bill_id', v_issued.id,
        'bill_number', v_issued.bill_number
      ));
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'local_id', v_item->>'local_id',
        'idempotency_key', v_key,
        'status', 'error',
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object('results', v_results);
END;
$$;

-- ============================================================================
-- 6. Messaging Templates & Delivery Logs ('messaging' module)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  name text NOT NULL,
  subject text,
  body_en text NOT NULL,
  body_hi text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.message_templates (template_key, channel, name, subject, body_en, body_hi) VALUES
  ('invoice_receipt', 'whatsapp', 'Invoice Share & UPI Pay', NULL, 'Namaste {{party_name}}, thank you for shopping at {{business_name}}. Invoice {{bill_number}} for {{amount}} is ready. Pay via UPI: {{upi_link}}', 'नमस्ते {{party_name}}, {{business_name}} से खरीदारी के लिए धन्यवाद। आपका बिल {{bill_number}} राशि {{amount}} तैयार है।'),
  ('due_reminder', 'whatsapp', 'Khata Payment Reminder', NULL, 'Reminder from {{business_name}}: Hello {{party_name}}, your balance of {{amount}} is due. Please pay via UPI {{upi_link}} or at the shop.', '{{business_name}} से रिमाइंडर: नमस्ते {{party_name}}, आपका बकाया {{amount}} देय है। कृपया भुगतान करें।'),
  ('invoice_email', 'email', 'Tax Invoice Email', 'Invoice {{bill_number}} from {{business_name}}', 'Dear {{party_name}},\n\nPlease find details for invoice {{bill_number}} totalling {{amount}}.\n\nRegards,\n{{business_name}}', 'प्रिय {{party_name}},\n\nबिल {{bill_number}} राशि {{amount}} का विवरण संलग्न है।\n\nसादर,\n{{business_name}}')
ON CONFLICT (template_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.message_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  recipient text NOT NULL,
  template_key text,
  rendered_body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  error_message text,
  entity_type text,
  entity_id text,
  sent_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_templates, public.message_logs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.message_templates, public.message_logs TO authenticated;

DROP POLICY IF EXISTS "Staff manage message_templates" ON public.message_templates;
CREATE POLICY "Staff manage message_templates" ON public.message_templates FOR ALL TO authenticated
  USING (public.is_active_staff())
  WITH CHECK (public.has_any_role(ARRAY['owner', 'manager']));

DROP POLICY IF EXISTS "Staff read message_logs" ON public.message_logs;
CREATE POLICY "Staff read message_logs" ON public.message_logs FOR SELECT TO authenticated
  USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant', 'cashier']));

-- ============================================================================
-- 7. Updated Backup Export (p7-v1, excludes ALL secrets) & Reset Compatibility
-- ============================================================================
CREATE OR REPLACE FUNCTION public.export_workspace_backup(
  p_backup_type text DEFAULT 'manual',
  p_include_files boolean DEFAULT false,
  p_destination text DEFAULT 'local',
  p_drive_file_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_type text := CASE WHEN p_backup_type IN ('manual', 'scheduled', 'drive', 'pre_restore') THEN p_backup_type ELSE 'manual' END;
  v_dest text := CASE WHEN p_destination = 'google_drive' THEN 'google_drive' ELSE 'local' END;
  v_data jsonb;
  v_counts jsonb;
  v_snapshot jsonb;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('backup');
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can export workspace backups.';
  END IF;

  -- Strictly business/operational data ONLY. Never export integration_settings, encrypted_secret,
  -- drive_connections OAuth tokens, ai_provider_profiles encrypted_key, or approval tokens.
  v_data := jsonb_build_object(
    'business', COALESCE((SELECT to_jsonb(b) FROM public.business b WHERE b.id = 1), '{}'::jsonb),
    'modules_state', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.module_key) FROM public.modules_state m), '[]'::jsonb),
    'numbering_series', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.series_key, n.fy_code) FROM public.numbering_series n), '[]'::jsonb),
    'files', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.created_at) FROM public.files f), '[]'::jsonb),
    'file_links', COALESCE((SELECT jsonb_agg(to_jsonb(fl) ORDER BY fl.created_at) FROM public.file_links fl), '[]'::jsonb),
    'parties', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at) FROM public.parties p), '[]'::jsonb),
    'party_addresses', COALESCE((SELECT jsonb_agg(to_jsonb(pa) ORDER BY pa.created_at) FROM public.party_addresses pa), '[]'::jsonb),
    'party_sites', COALESCE((SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.created_at) FROM public.party_sites ps), '[]'::jsonb),
    'item_categories', COALESCE((SELECT jsonb_agg(to_jsonb(ic) ORDER BY ic.name) FROM public.item_categories ic), '[]'::jsonb),
    'brands', COALESCE((SELECT jsonb_agg(to_jsonb(br) ORDER BY br.name) FROM public.brands br), '[]'::jsonb),
    'item_units', COALESCE((SELECT jsonb_agg(to_jsonb(iu) ORDER BY iu.code) FROM public.item_units iu), '[]'::jsonb),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(it) ORDER BY it.created_at) FROM public.items it), '[]'::jsonb),
    'unit_conversions', COALESCE((SELECT jsonb_agg(to_jsonb(uc) ORDER BY uc.created_at) FROM public.unit_conversions uc), '[]'::jsonb),
    'item_images', COALESCE((SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.created_at) FROM public.item_images ii), '[]'::jsonb),
    'item_batches', COALESCE((SELECT jsonb_agg(to_jsonb(ib) ORDER BY ib.created_at) FROM public.item_batches ib), '[]'::jsonb),
    'item_variants', COALESCE((SELECT jsonb_agg(to_jsonb(iv) ORDER BY iv.created_at) FROM public.item_variants iv), '[]'::jsonb),
    'party_item_rates', COALESCE((SELECT jsonb_agg(to_jsonb(pir) ORDER BY pir.created_at) FROM public.party_item_rates pir), '[]'::jsonb),
    'service_jobs', COALESCE((SELECT jsonb_agg(to_jsonb(sj) ORDER BY sj.created_at) FROM public.service_jobs sj), '[]'::jsonb),
    'prescriptions', COALESCE((SELECT jsonb_agg(to_jsonb(rx) ORDER BY rx.created_at) FROM public.prescriptions rx), '[]'::jsonb),
    'stock_ledger', COALESCE((SELECT jsonb_agg(to_jsonb(sl) ORDER BY sl.created_at) FROM public.stock_ledger sl), '[]'::jsonb),
    'bills', COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.created_at) FROM public.bills bl), '[]'::jsonb),
    'bill_lines', COALESCE((SELECT jsonb_agg(to_jsonb(bll) ORDER BY bll.bill_id, bll.line_no) FROM public.bill_lines bll), '[]'::jsonb),
    'schedule_register', COALESCE((SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.created_at) FROM public.schedule_register sr), '[]'::jsonb),
    'warranty_records', COALESCE((SELECT jsonb_agg(to_jsonb(wr) ORDER BY wr.created_at) FROM public.warranty_records wr), '[]'::jsonb),
    'hardware_estimates', COALESCE((SELECT jsonb_agg(to_jsonb(he) ORDER BY he.created_at) FROM public.hardware_estimates he), '[]'::jsonb),
    'purchase_bills', COALESCE((SELECT jsonb_agg(to_jsonb(pb) ORDER BY pb.created_at) FROM public.purchase_bills pb), '[]'::jsonb),
    'purchase_lines', COALESCE((SELECT jsonb_agg(to_jsonb(pl) ORDER BY pl.purchase_id, pl.line_no) FROM public.purchase_lines pl), '[]'::jsonb),
    'expense_categories', COALESCE((SELECT jsonb_agg(to_jsonb(ec) ORDER BY ec.code) FROM public.expense_categories ec), '[]'::jsonb),
    'expenses', COALESCE((SELECT jsonb_agg(to_jsonb(ex) ORDER BY ex.created_at) FROM public.expenses ex), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(pm) ORDER BY pm.created_at) FROM public.payments pm), '[]'::jsonb),
    'party_ledger_entries', COALESCE((SELECT jsonb_agg(to_jsonb(le) ORDER BY le.created_at) FROM public.party_ledger_entries le), '[]'::jsonb),
    'payment_allocations', COALESCE((SELECT jsonb_agg(to_jsonb(al) ORDER BY al.created_at) FROM public.payment_allocations al), '[]'::jsonb),
    'account_groups', COALESCE((SELECT jsonb_agg(to_jsonb(ag) ORDER BY ag.code) FROM public.account_groups ag), '[]'::jsonb),
    'ledgers', COALESCE((SELECT jsonb_agg(to_jsonb(lg) ORDER BY lg.code) FROM public.ledgers lg), '[]'::jsonb),
    'vouchers', COALESCE((SELECT jsonb_agg(to_jsonb(vc) ORDER BY vc.voucher_date, vc.created_at) FROM public.vouchers vc), '[]'::jsonb),
    'voucher_entries', COALESCE((SELECT jsonb_agg(to_jsonb(ve) ORDER BY ve.voucher_id, ve.created_at) FROM public.voucher_entries ve), '[]'::jsonb),
    'locations', COALESCE((SELECT jsonb_agg(to_jsonb(lc) ORDER BY lc.code) FROM public.locations lc), '[]'::jsonb),
    'sales_orders', COALESCE((SELECT jsonb_agg(to_jsonb(so) ORDER BY so.created_at) FROM public.sales_orders so), '[]'::jsonb),
    'tds_entries', COALESCE((SELECT jsonb_agg(to_jsonb(td) ORDER BY td.created_at) FROM public.tds_entries td), '[]'::jsonb),
    'cheque_register', COALESCE((SELECT jsonb_agg(to_jsonb(cq) ORDER BY cq.created_at) FROM public.cheque_register cq), '[]'::jsonb)
  );

  v_counts := jsonb_build_object(
    'parties', jsonb_array_length(v_data->'parties'),
    'items', jsonb_array_length(v_data->'items'),
    'bills', jsonb_array_length(v_data->'bills'),
    'purchase_bills', jsonb_array_length(v_data->'purchase_bills'),
    'expenses', jsonb_array_length(v_data->'expenses'),
    'payments', jsonb_array_length(v_data->'payments'),
    'vouchers', jsonb_array_length(v_data->'vouchers')
  );

  UPDATE public.business SET last_backup_at = now() WHERE id = 1;
  UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:backup_overdue';
  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();

  INSERT INTO public.backup_records (
    backup_type, schema_version, size_bytes, record_counts, destination, drive_file_id, include_files, created_by
  ) VALUES (
    v_type, 'p7-v1', length(v_data::text)::bigint, v_counts, v_dest, p_drive_file_id, COALESCE(p_include_files, false), auth.uid()
  );

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'backup.exported', 'backup', v_dest,
    jsonb_build_object('schema_version', 'p7-v1', 'include_files', COALESCE(p_include_files, false), 'counts', v_counts)
  );

  v_snapshot := jsonb_build_object(
    'app', 'BizOne ERP',
    'schema_version', 'p7-v1',
    'exported_at', now(),
    'exported_by', v_actor_email,
    'include_files', COALESCE(p_include_files, false),
    'record_counts', v_counts,
    'data', v_data
  );

  RETURN v_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_workspace_data(p_confirm_phrase text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_email text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the business Owner can reset the workspace.';
  END IF;
  IF trim(COALESCE(p_confirm_phrase, '')) <> 'RESET WORKSPACE' THEN
    RAISE EXCEPTION 'Type exact confirmation phrase "RESET WORKSPACE" to proceed.';
  END IF;

  PERFORM set_config('app.restore_context', txid_current()::text, true);

  DELETE FROM public.bank_reconciliations;
  DELETE FROM public.voucher_entries;
  DELETE FROM public.vouchers;
  DELETE FROM public.einvoice_records;
  DELETE FROM public.gstr2b_entries;
  DELETE FROM public.tds_entries;
  DELETE FROM public.stock_transfers;
  DELETE FROM public.physical_stock_counts;
  DELETE FROM public.location_stock_balances;
  DELETE FROM public.pos_held_bills;
  DELETE FROM public.pos_cash_registers;
  DELETE FROM public.sales_orders;
  DELETE FROM public.recurring_rules;
  DELETE FROM public.leads;
  DELETE FROM public.cheque_register;
  DELETE FROM public.message_logs;
  DELETE FROM public.ai_action_proposals;
  DELETE FROM public.ai_messages;
  DELETE FROM public.ai_conversations;
  DELETE FROM public.file_links;
  DELETE FROM public.bill_share_links;
  DELETE FROM public.schedule_register;
  DELETE FROM public.prescriptions;
  DELETE FROM public.warranty_records;
  DELETE FROM public.hardware_estimates;
  DELETE FROM public.service_jobs;
  DELETE FROM public.party_item_rates;
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
  DELETE FROM public.item_batches;
  DELETE FROM public.item_variants;
  DELETE FROM public.item_images;
  DELETE FROM public.unit_conversions;
  DELETE FROM public.items;
  DELETE FROM public.item_categories;
  DELETE FROM public.brands;
  DELETE FROM public.party_sites;
  DELETE FROM public.party_addresses;
  DELETE FROM public.parties;
  DELETE FROM public.numbering_series;
  DELETE FROM public.notifications;

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
  v_dest text := CASE WHEN p_destination = 'google_drive' THEN 'google_drive' ELSE 'local' END;
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

  DELETE FROM public.bank_reconciliations;
  DELETE FROM public.voucher_entries;
  DELETE FROM public.vouchers;
  DELETE FROM public.einvoice_records;
  DELETE FROM public.gstr2b_entries;
  DELETE FROM public.tds_entries;
  DELETE FROM public.stock_transfers;
  DELETE FROM public.physical_stock_counts;
  DELETE FROM public.location_stock_balances;
  DELETE FROM public.pos_held_bills;
  DELETE FROM public.pos_cash_registers;
  DELETE FROM public.sales_orders;
  DELETE FROM public.recurring_rules;
  DELETE FROM public.leads;
  DELETE FROM public.cheque_register;
  DELETE FROM public.file_links;
  DELETE FROM public.bill_share_links;
  DELETE FROM public.schedule_register;
  DELETE FROM public.prescriptions;
  DELETE FROM public.warranty_records;
  DELETE FROM public.hardware_estimates;
  DELETE FROM public.service_jobs;
  DELETE FROM public.party_item_rates;
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
  DELETE FROM public.item_batches;
  DELETE FROM public.item_variants;
  DELETE FROM public.item_images;
  DELETE FROM public.unit_conversions;
  DELETE FROM public.items;
  DELETE FROM public.item_categories;
  DELETE FROM public.brands;
  DELETE FROM public.party_sites;
  DELETE FROM public.party_addresses;
  DELETE FROM public.parties;
  DELETE FROM public.numbering_series;

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
    pack = COALESCE(NULLIF(v_biz->>'pack', ''), pack),
    gst_registered = COALESCE((v_biz->>'gst_registered')::boolean, gst_registered),
    gstin = NULLIF(v_biz->>'gstin', ''),
    drug_licence_no = NULLIF(v_biz->>'drug_licence_no', ''),
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
      INSERT INTO public.modules_state (module_key, enabled)
      VALUES (v_rec->>'module_key', COALESCE((v_rec->>'enabled')::boolean, false))
      ON CONFLICT (module_key) DO UPDATE SET enabled = EXCLUDED.enabled;
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
    INSERT INTO public.parties (id, name, party_type, phone, email, gstin, opening_balance, opening_balance_type, opening_balance_date, credit_limit, credit_days, notes, is_active, is_demo, version, price_tier, created_by, created_at, updated_at)
    SELECT r.id, r.name, r.party_type, r.phone, r.email, r.gstin, r.opening_balance, r.opening_balance_type, r.opening_balance_date, r.credit_limit, r.credit_days, r.notes, r.is_active, r.is_demo, r.version, COALESCE(r.price_tier, 'standard'), auth.uid(), r.created_at, r.updated_at
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
    INSERT INTO public.items (id, name, sku, barcode, category_id, brand_id, base_unit_id, selling_price, mrp, purchase_price, gst_rate, hsn_code, tax_inclusive, low_stock_alert, allow_negative_stock, primary_image_file_id, pack_metadata, notes, is_active, is_demo, version, item_type, wholesale_slabs, created_by, created_at, updated_at)
    SELECT r.id, r.name, r.sku, r.barcode, r.category_id, r.brand_id, r.base_unit_id, r.selling_price, r.mrp, r.purchase_price, r.gst_rate, r.hsn_code, r.tax_inclusive, r.low_stock_alert, r.allow_negative_stock,
      CASE WHEN r.primary_image_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.primary_image_file_id) THEN r.primary_image_file_id ELSE NULL END,
      r.pack_metadata, r.notes, r.is_active, r.is_demo, r.version, COALESCE(r.item_type, 'goods'), COALESCE(r.wholesale_slabs, '[]'::jsonb), auth.uid(), r.created_at, r.updated_at
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

  IF jsonb_typeof(v_data->'item_variants') = 'array' AND jsonb_array_length(v_data->'item_variants') > 0 THEN
    INSERT INTO public.item_variants (id, item_id, size, color, sku, barcode, selling_price, mrp, purchase_price, qty_on_hand, is_active, is_demo, created_at, updated_at)
    SELECT r.id, r.item_id, r.size, r.color, r.sku, r.barcode, r.selling_price, r.mrp, r.purchase_price, r.qty_on_hand, r.is_active, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.item_variants, v_data->'item_variants') r;
  END IF;

  IF jsonb_typeof(v_data->'party_item_rates') = 'array' AND jsonb_array_length(v_data->'party_item_rates') > 0 THEN
    INSERT INTO public.party_item_rates (id, party_id, item_id, custom_rate, min_qty, is_demo, created_at, updated_at)
    SELECT r.id, r.party_id, r.item_id, r.custom_rate, r.min_qty, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.party_item_rates, v_data->'party_item_rates') r;
  END IF;

  IF jsonb_typeof(v_data->'expense_categories') = 'array' AND jsonb_array_length(v_data->'expense_categories') > 0 THEN
    INSERT INTO public.expense_categories (id, code, name_en, name_hi, is_system, is_active, created_at)
    SELECT r.id, r.code, r.name_en, r.name_hi, r.is_system, r.is_active, r.created_at
    FROM jsonb_populate_recordset(NULL::public.expense_categories, v_data->'expense_categories') r ON CONFLICT (id) DO NOTHING;
  END IF;

  IF jsonb_typeof(v_data->'service_jobs') = 'array' AND jsonb_array_length(v_data->'service_jobs') > 0 THEN
    INSERT INTO public.service_jobs (id, job_number, party_id, party_name, title, description, status, start_date, due_date, completed_date, estimated_amount, linked_bill_id, notes, is_demo, created_by, created_at, updated_at)
    SELECT r.id, r.job_number, r.party_id, r.party_name, r.title, r.description, r.status, r.start_date, r.due_date, r.completed_date, r.estimated_amount, NULL, r.notes, r.is_demo, auth.uid(), r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.service_jobs, v_data->'service_jobs') r;
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

  IF jsonb_typeof(v_data->'item_batches') = 'array' AND jsonb_array_length(v_data->'item_batches') > 0 THEN
    INSERT INTO public.item_batches (id, item_id, batch_no, mfg_date, expiry_date, mrp, purchase_rate, selling_rate, qty_on_hand, source_purchase_id, is_active, is_demo, created_at, updated_at)
    SELECT r.id, r.item_id, r.batch_no, r.mfg_date, r.expiry_date, r.mrp, r.purchase_rate, r.selling_rate, r.qty_on_hand, r.source_purchase_id, r.is_active, r.is_demo, r.created_at, r.updated_at
    FROM jsonb_populate_recordset(NULL::public.item_batches, v_data->'item_batches') r;
  END IF;

  IF jsonb_typeof(v_data->'bills') = 'array' AND jsonb_array_length(v_data->'bills') > 0 THEN
    INSERT INTO public.bills (
      id, bill_number, doc_type, status, source_bill_id, converted_from_quotation_id, converted_to_bill_id,
      party_id, party_name, party_phone, party_gstin, party_address, place_of_supply_state_code, is_interstate,
      bill_date, due_date, valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total, paid_amount, credited_amount,
      balance_due, notes, terms, business_snapshot, void_reason, voided_at, voided_by, return_reason,
      idempotency_key, issued_at, issued_by, is_demo, created_by, created_at, updated_at, payment_mode, payment_reference,
      site_id, site_name, job_id, prescription_id
    )
    SELECT
      r.id, r.bill_number, r.doc_type, r.status, r.source_bill_id, NULL, NULL,
      r.party_id, r.party_name, r.party_phone, r.party_gstin, r.party_address, r.place_of_supply_state_code, r.is_interstate,
      r.bill_date, r.due_date, r.valid_until, r.gst_applied, r.subtotal_taxable, r.discount_total, r.cgst_total, r.sgst_total,
      r.igst_total, r.tax_total, r.extra_charges, r.auto_round_off, r.round_off, r.grand_total, r.paid_amount, r.credited_amount,
      r.balance_due, r.notes, r.terms, r.business_snapshot, r.void_reason, r.voided_at, auth.uid(), r.return_reason,
      r.idempotency_key, r.issued_at, auth.uid(), r.is_demo, auth.uid(), r.created_at, r.updated_at, COALESCE(r.payment_mode, 'cash'), r.payment_reference,
      r.site_id, r.site_name, r.job_id, NULL
    FROM jsonb_populate_recordset(NULL::public.bills, v_data->'bills') r
    ORDER BY (r.source_bill_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'bill_lines') = 'array' AND jsonb_array_length(v_data->'bill_lines') > 0 THEN
    INSERT INTO public.bill_lines (
      id, bill_id, line_no, item_id, source_bill_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      catalog_unit_price, unit_price, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, batch_id, batch_no, expiry_date, mrp, variant_id, variant_label, line_meta, created_at
    )
    SELECT
      r.id, r.bill_id, r.line_no, r.item_id, r.source_bill_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.catalog_unit_price, r.unit_price, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.batch_id, r.batch_no, r.expiry_date, r.mrp, r.variant_id, r.variant_label, COALESCE(r.line_meta, '{}'::jsonb), r.created_at
    FROM jsonb_populate_recordset(NULL::public.bill_lines, v_data->'bill_lines') r
    ORDER BY (r.source_bill_line_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'purchase_lines') = 'array' AND jsonb_array_length(v_data->'purchase_lines') > 0 THEN
    INSERT INTO public.purchase_lines (
      id, purchase_id, line_no, item_id, source_purchase_line_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total, batch_id, batch_no, mfg_date, expiry_date, mrp, selling_rate, variant_id, variant_label, line_meta, created_at
    )
    SELECT
      r.id, r.purchase_id, r.line_no, r.item_id, r.source_purchase_line_id, r.item_name, r.sku, r.hsn_code,
      r.entered_qty, r.entered_unit_id, r.entered_unit_code, r.conversion_factor, r.base_qty,
      r.unit_cost, r.discount_pct, r.tax_inclusive, r.gst_rate,
      r.gross_amount, r.discount_amount, r.taxable_amount, r.cgst_amount, r.sgst_amount,
      r.igst_amount, r.tax_amount, r.line_total, r.batch_id, r.batch_no, r.mfg_date, r.expiry_date, r.mrp, r.selling_rate, r.variant_id, r.variant_label, COALESCE(r.line_meta, '{}'::jsonb), r.created_at
    FROM jsonb_populate_recordset(NULL::public.purchase_lines, v_data->'purchase_lines') r
    ORDER BY (r.source_purchase_line_id IS NOT NULL) ASC, r.created_at ASC;
  END IF;

  IF jsonb_typeof(v_data->'expenses') = 'array' AND jsonb_array_length(v_data->'expenses') > 0 THEN
    INSERT INTO public.expenses (id, expense_number, category_id, expense_date, amount, payment_mode, reference_no, paid_to, notes, attachment_file_id, job_id, status, void_reason, voided_at, voided_by, idempotency_key, is_demo, created_by, created_at, updated_at)
    SELECT r.id, r.expense_number, r.category_id, r.expense_date, r.amount, r.payment_mode, r.reference_no, r.paid_to, r.notes,
      CASE WHEN r.attachment_file_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = r.attachment_file_id) THEN r.attachment_file_id ELSE NULL END,
      r.job_id, r.status, r.void_reason, r.voided_at, auth.uid(), r.idempotency_key, r.is_demo, auth.uid(), r.created_at, r.updated_at
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
    INSERT INTO public.stock_ledger (id, item_id, movement_type, movement_date, entered_qty, entered_unit_id, conversion_factor, signed_base_qty, unit_cost, reason, reference_no, source_table, source_id, idempotency_key, batch_id, variant_id, pack_meta, is_demo, created_by, created_at)
    SELECT r.id, r.item_id, r.movement_type, r.movement_date, r.entered_qty, r.entered_unit_id, r.conversion_factor, r.signed_base_qty, r.unit_cost, r.reason, r.reference_no, r.source_table, r.source_id, r.idempotency_key, r.batch_id, r.variant_id, r.pack_meta, r.is_demo, auth.uid(), r.created_at
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

GRANT EXECUTE ON FUNCTION public.preview_accounting_migration() TO authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_accounting_from_existing(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_accounting_voucher(text, date, text, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_accounting_voucher(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trial_balance(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_financial_statements(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_gstr1_data(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_gstr2b_itc(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_location_stock(uuid, uuid, uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_offline_bill_queue(jsonb) TO authenticated;
