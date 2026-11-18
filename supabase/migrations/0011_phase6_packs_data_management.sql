-- BizOne ERP - Phase P6 (Part 1): Business Packs Schema, Pack Workflows & Notification Rules
-- Builds cleanly on Phases P1–P5:
--   1. Extends business, items, parties, bills, bill_lines, purchase_lines, expenses, stock_ledger, backup_records.
--   2. Adds pack-specific tables: item_batches, prescriptions, schedule_register, item_variants,
--      party_sites, hardware_estimates, warranty_records, service_jobs, party_item_rates,
--      import_jobs, drive_connections (tokens encrypted server-side; zero direct client access).
--   3. Updates views (appending columns cleanly at the end of SELECT projections).
--   4. Drops superseded RPC signatures cleanly & deploys pack-aware Billing, Purchase, Return,
--      Void, Party, Item, Expense, Batch FEFO/Expiry Block, Variant Matrix, Warranty, Service Job,
--      Hardware Estimate, Wholesale Slab/Rate, and Notification Sync RPCs.

-- ============================================================================
-- 1. Extend Core Tables for All 7 Business Packs & Backup Metadata
-- ============================================================================
ALTER TABLE public.business
  ADD COLUMN IF NOT EXISTS drug_licence_no text,
  ADD COLUMN IF NOT EXISTS pack_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'goods'
    CHECK (item_type IN ('goods', 'service')),
  ADD COLUMN IF NOT EXISTS wholesale_slabs jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.parties
  ADD COLUMN IF NOT EXISTS price_tier text NOT NULL DEFAULT 'standard'
    CHECK (price_tier IN ('standard', 'wholesale_a', 'wholesale_b', 'vip'));

ALTER TABLE public.bill_lines
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS batch_no text,
  ADD COLUMN IF NOT EXISTS expiry_date date,
  ADD COLUMN IF NOT EXISTS mrp numeric(15,2),
  ADD COLUMN IF NOT EXISTS variant_id uuid,
  ADD COLUMN IF NOT EXISTS variant_label text,
  ADD COLUMN IF NOT EXISTS line_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.purchase_lines
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS batch_no text,
  ADD COLUMN IF NOT EXISTS mfg_date date,
  ADD COLUMN IF NOT EXISTS expiry_date date,
  ADD COLUMN IF NOT EXISTS mrp numeric(15,2),
  ADD COLUMN IF NOT EXISTS selling_rate numeric(15,2),
  ADD COLUMN IF NOT EXISTS variant_id uuid,
  ADD COLUMN IF NOT EXISTS variant_label text,
  ADD COLUMN IF NOT EXISTS line_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS site_id uuid,
  ADD COLUMN IF NOT EXISTS site_name text,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS prescription_id uuid;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS job_id uuid;

ALTER TABLE public.stock_ledger
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS variant_id uuid,
  ADD COLUMN IF NOT EXISTS pack_meta jsonb;

-- Expand backup_records for Drive & attachment-bundle metadata
ALTER TABLE public.backup_records
  DROP CONSTRAINT IF EXISTS backup_records_backup_type_check;
ALTER TABLE public.backup_records
  ADD CONSTRAINT backup_records_backup_type_check
    CHECK (backup_type IN ('manual', 'scheduled', 'drive', 'pre_restore', 'restore', 'drive_restore'));

ALTER TABLE public.backup_records
  ADD COLUMN IF NOT EXISTS destination text NOT NULL DEFAULT 'local'
    CHECK (destination IN ('local', 'google_drive')),
  ADD COLUMN IF NOT EXISTS drive_file_id text,
  ADD COLUMN IF NOT EXISTS include_files boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS encrypted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes text;

-- ============================================================================
-- 2. Pack-Specific Tables & Google Drive Server-Side Connection Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.item_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  batch_no text NOT NULL,
  mfg_date date,
  expiry_date date NOT NULL,
  mrp numeric(15,2),
  purchase_rate numeric(15,2),
  selling_rate numeric(15,2),
  qty_on_hand numeric(15,3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  source_purchase_id uuid REFERENCES public.purchase_bills(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_item_batches_item_expiry ON public.item_batches (item_id, expiry_date ASC) WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_item_batches_updated_at ON public.item_batches;
CREATE TRIGGER trg_item_batches_updated_at
  BEFORE UPDATE ON public.item_batches
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid REFERENCES public.bills(id) ON DELETE CASCADE,
  patient_name text NOT NULL,
  patient_age text,
  patient_phone text,
  doctor_name text NOT NULL,
  doctor_reg_no text,
  notes text,
  attachment_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_bill ON public.prescriptions (bill_id);

CREATE TABLE IF NOT EXISTS public.schedule_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  bill_line_id uuid REFERENCES public.bill_lines(id) ON DELETE SET NULL,
  prescription_id uuid REFERENCES public.prescriptions(id) ON DELETE SET NULL,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  item_name text NOT NULL,
  salt_name text,
  schedule_class text NOT NULL CHECK (schedule_class IN ('H', 'H1', 'X', 'NRx')),
  batch_no text,
  expiry_date date,
  qty numeric(15,3) NOT NULL CHECK (qty > 0),
  unit_code text NOT NULL DEFAULT 'pcs',
  patient_name text NOT NULL,
  doctor_name text NOT NULL,
  doctor_reg_no text,
  sale_date date NOT NULL DEFAULT CURRENT_DATE,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedule_register_date ON public.schedule_register (sale_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.item_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  size text NOT NULL,
  color text NOT NULL DEFAULT 'Default',
  sku text,
  barcode text,
  selling_price numeric(15,2),
  mrp numeric(15,2),
  purchase_price numeric(15,2),
  qty_on_hand numeric(15,3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, size, color)
);
CREATE INDEX IF NOT EXISTS idx_item_variants_item ON public.item_variants (item_id) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_variants_barcode_uniq ON public.item_variants (upper(barcode)) WHERE barcode IS NOT NULL AND barcode <> '';

DROP TRIGGER IF EXISTS trg_item_variants_updated_at ON public.item_variants;
CREATE TRIGGER trg_item_variants_updated_at
  BEFORE UPDATE ON public.item_variants
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.party_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  site_name text NOT NULL,
  contact_name text,
  contact_phone text,
  address text,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_party_sites_party ON public.party_sites (party_id) WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_party_sites_updated_at ON public.party_sites;
CREATE TRIGGER trg_party_sites_updated_at
  BEFORE UPDATE ON public.party_sites
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.hardware_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_number text NOT NULL UNIQUE,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL DEFAULT 'Walk-in Customer',
  site_id uuid REFERENCES public.party_sites(id) ON DELETE SET NULL,
  site_name text,
  title text NOT NULL,
  calc_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_total numeric(15,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'archived')),
  converted_bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hardware_estimates_created ON public.hardware_estimates (created_at DESC);

DROP TRIGGER IF EXISTS trg_hardware_estimates_updated_at ON public.hardware_estimates;
CREATE TRIGGER trg_hardware_estimates_updated_at
  BEFORE UPDATE ON public.hardware_estimates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.warranty_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  bill_line_id uuid REFERENCES public.bill_lines(id) ON DELETE SET NULL,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL DEFAULT 'Walk-in Customer',
  item_name text NOT NULL,
  serial_no text NOT NULL,
  warranty_months integer NOT NULL DEFAULT 12 CHECK (warranty_months >= 0),
  purchase_date date NOT NULL DEFAULT CURRENT_DATE,
  warranty_end_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claimed', 'replaced', 'expired')),
  claim_notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warranty_records_end ON public.warranty_records (warranty_end_date ASC);
CREATE INDEX IF NOT EXISTS idx_warranty_records_serial ON public.warranty_records (upper(serial_no));

DROP TRIGGER IF EXISTS trg_warranty_records_updated_at ON public.warranty_records;
CREATE TRIGGER trg_warranty_records_updated_at
  BEFORE UPDATE ON public.warranty_records
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.service_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number text NOT NULL UNIQUE,
  party_id uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  party_name text NOT NULL DEFAULT 'Walk-in Client',
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'billed', 'cancelled')),
  start_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  completed_date date,
  estimated_amount numeric(15,2) NOT NULL DEFAULT 0,
  linked_bill_id uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  notes text,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_jobs_status ON public.service_jobs (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_service_jobs_updated_at ON public.service_jobs;
CREATE TRIGGER trg_service_jobs_updated_at
  BEFORE UPDATE ON public.service_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.party_item_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  custom_rate numeric(15,2) NOT NULL CHECK (custom_rate >= 0),
  min_qty numeric(15,3) NOT NULL DEFAULT 1 CHECK (min_qty > 0),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_id, item_id)
);

DROP TRIGGER IF EXISTS trg_party_item_rates_updated_at ON public.party_item_rates;
CREATE TRIGGER trg_party_item_rates_updated_at
  BEFORE UPDATE ON public.party_item_rates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type text NOT NULL CHECK (import_type IN ('parties', 'items', 'opening_balances', 'rate_list')),
  file_name text NOT NULL,
  duplicate_mode text NOT NULL DEFAULT 'skip' CHECK (duplicate_mode IN ('skip', 'update', 'error')),
  total_rows integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON public.import_jobs (created_at DESC);

-- Server-only Drive connection secrets + schedule configuration
CREATE TABLE IF NOT EXISTS public.drive_connections (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  connected_email text,
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  folder_id text,
  folder_name text NOT NULL DEFAULT 'BizOne ERP Backups',
  schedule_enabled boolean NOT NULL DEFAULT false,
  schedule_frequency text NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily', 'weekly')),
  retention_count integer NOT NULL DEFAULT 10 CHECK (retention_count BETWEEN 3 AND 50),
  last_sync_at timestamptz,
  last_sync_status text NOT NULL DEFAULT 'never' CHECK (last_sync_status IN ('never', 'ok', 'error', 'disconnected')),
  last_error text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.drive_connections (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_drive_connections_updated_at ON public.drive_connections;
CREATE TRIGGER trg_drive_connections_updated_at
  BEFORE UPDATE ON public.drive_connections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Foreign keys from core tables to newly created pack tables (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bill_lines_batch') THEN
    ALTER TABLE public.bill_lines ADD CONSTRAINT fk_bill_lines_batch FOREIGN KEY (batch_id) REFERENCES public.item_batches(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bill_lines_variant') THEN
    ALTER TABLE public.bill_lines ADD CONSTRAINT fk_bill_lines_variant FOREIGN KEY (variant_id) REFERENCES public.item_variants(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_lines_batch') THEN
    ALTER TABLE public.purchase_lines ADD CONSTRAINT fk_purchase_lines_batch FOREIGN KEY (batch_id) REFERENCES public.item_batches(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_lines_variant') THEN
    ALTER TABLE public.purchase_lines ADD CONSTRAINT fk_purchase_lines_variant FOREIGN KEY (variant_id) REFERENCES public.item_variants(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bills_site') THEN
    ALTER TABLE public.bills ADD CONSTRAINT fk_bills_site FOREIGN KEY (site_id) REFERENCES public.party_sites(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bills_job') THEN
    ALTER TABLE public.bills ADD CONSTRAINT fk_bills_job FOREIGN KEY (job_id) REFERENCES public.service_jobs(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bills_prescription') THEN
    ALTER TABLE public.bills ADD CONSTRAINT fk_bills_prescription FOREIGN KEY (prescription_id) REFERENCES public.prescriptions(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_job') THEN
    ALTER TABLE public.expenses ADD CONSTRAINT fk_expenses_job FOREIGN KEY (job_id) REFERENCES public.service_jobs(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================================
-- 3. Views (Append-Only Column Extensions Preserving Existing Signatures)
-- ============================================================================
CREATE OR REPLACE VIEW public.item_catalog_view AS
SELECT
  i.id,
  i.name,
  i.sku,
  i.barcode,
  i.category_id,
  c.name AS category_name,
  i.brand_id,
  b.name AS brand_name,
  i.base_unit_id,
  u.code AS base_unit_code,
  u.name_en AS base_unit_name_en,
  u.name_hi AS base_unit_name_hi,
  u.allow_decimal AS base_unit_allow_decimal,
  i.selling_price,
  i.mrp,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN i.purchase_price
    ELSE NULL
  END AS purchase_price,
  i.gst_rate,
  i.hsn_code,
  i.tax_inclusive,
  i.low_stock_alert,
  i.allow_negative_stock,
  i.primary_image_file_id,
  i.pack_metadata,
  i.notes,
  i.is_active,
  i.is_demo,
  i.version,
  i.created_at,
  i.updated_at,
  COALESCE(sb.qty_on_hand, 0)::numeric(15,3) AS qty_on_hand,
  sb.last_movement_at,
  (i.item_type = 'goods' AND i.is_active AND COALESCE(sb.qty_on_hand, 0) <= 0) AS is_out_of_stock,
  (i.item_type = 'goods' AND i.is_active AND i.low_stock_alert > 0 AND COALESCE(sb.qty_on_hand, 0) <= i.low_stock_alert) AS is_low_stock,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) AND i.item_type = 'goods'
      THEN round((COALESCE(sb.qty_on_hand, 0) * COALESCE(i.purchase_price, 0))::numeric, 2)
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
      THEN 0::numeric(15,2)
    ELSE NULL
  END AS stock_value,
  (SELECT count(*)::integer FROM public.item_images ii WHERE ii.item_id = i.id) AS image_count,
  (SELECT count(*)::integer FROM public.unit_conversions uc WHERE uc.item_id = i.id) AS conversions_count,
  i.item_type,
  i.wholesale_slabs,
  (SELECT count(*)::integer FROM public.item_batches ib WHERE ib.item_id = i.id AND ib.is_active = true AND ib.qty_on_hand > 0) AS active_batches_count,
  (SELECT count(*)::integer FROM public.item_variants iv WHERE iv.item_id = i.id AND iv.is_active = true) AS variants_count,
  (SELECT MIN(ib.expiry_date) FROM public.item_batches ib WHERE ib.item_id = i.id AND ib.is_active = true AND ib.qty_on_hand > 0) AS nearest_expiry_date
FROM public.items i
LEFT JOIN public.item_categories c ON c.id = i.category_id
LEFT JOIN public.brands b ON b.id = i.brand_id
JOIN public.item_units u ON u.id = i.base_unit_id
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_catalog_view SET (security_invoker = false);

CREATE OR REPLACE VIEW public.inventory_summary_view AS
SELECT
  count(*) FILTER (WHERE i.is_active = true)::integer AS active_items_count,
  count(*) FILTER (WHERE i.is_active = false)::integer AS archived_items_count,
  count(*) FILTER (
    WHERE i.is_active = true
      AND i.item_type = 'goods'
      AND i.low_stock_alert > 0
      AND COALESCE(sb.qty_on_hand, 0) <= i.low_stock_alert
  )::integer AS low_stock_count,
  count(*) FILTER (
    WHERE i.is_active = true
      AND i.item_type = 'goods'
      AND COALESCE(sb.qty_on_hand, 0) <= 0
  )::integer AS out_of_stock_count,
  COALESCE(sum(GREATEST(COALESCE(sb.qty_on_hand, 0), 0)) FILTER (WHERE i.is_active = true AND i.item_type = 'goods'), 0)::numeric(15,3) AS total_stock_units,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
      THEN COALESCE(
        round(sum(GREATEST(COALESCE(sb.qty_on_hand, 0), 0) * COALESCE(i.purchase_price, 0)) FILTER (WHERE i.is_active = true AND i.item_type = 'goods')::numeric, 2),
        0
      )
    ELSE NULL
  END AS total_stock_value
FROM public.items i
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
HAVING public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.inventory_summary_view SET (security_invoker = false);

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
  la.last_entry_date,
  p.price_tier,
  (SELECT count(*)::integer FROM public.party_sites ps WHERE ps.party_id = p.id AND ps.is_active = true) AS sites_count,
  p.is_demo
FROM public.parties p
LEFT JOIN ledger_agg la ON la.party_id = p.id
LEFT JOIN overdue_agg oa ON oa.party_id = p.id;

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
  ) AS active_share_count,
  b.payment_mode,
  b.payment_reference,
  b.site_id,
  b.site_name,
  b.job_id,
  b.prescription_id
FROM public.bills b
LEFT JOIN public.bills sb ON sb.id = b.source_bill_id
LEFT JOIN public.bills cb ON cb.id = b.converted_to_bill_id
WHERE public.is_module_enabled('billing')
  AND public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']);

ALTER VIEW public.bill_list_view SET (security_invoker = false);

CREATE OR REPLACE VIEW public.expense_list_view AS
SELECT
  e.id,
  e.expense_number,
  e.category_id,
  ec.code AS category_code,
  ec.name_en AS category_name_en,
  ec.name_hi AS category_name_hi,
  e.expense_date,
  e.amount,
  e.payment_mode,
  e.reference_no,
  e.paid_to,
  e.notes,
  e.attachment_file_id,
  e.status,
  e.void_reason,
  e.voided_at,
  e.created_by,
  p.full_name AS created_by_name,
  e.created_at,
  e.updated_at,
  e.job_id,
  sj.job_number
FROM public.expenses e
JOIN public.expense_categories ec ON ec.id = e.category_id
LEFT JOIN public.profiles p ON p.id = e.created_by
LEFT JOIN public.service_jobs sj ON sj.id = e.job_id
WHERE public.is_module_enabled('expenses')
  AND (
    public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
    OR (public.current_user_role() = 'cashier' AND e.created_by = auth.uid())
  );

ALTER VIEW public.expense_list_view SET (security_invoker = false);

-- ============================================================================
-- 4. Update Core Business, Item, Party, Expense & Toggle Module RPCs cleanly
-- ============================================================================
DROP FUNCTION IF EXISTS public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text
);

DROP FUNCTION IF EXISTS public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text,
  text, boolean, text, integer, text, integer, numeric, boolean
);

DROP FUNCTION IF EXISTS public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text,
  text, boolean, text, integer, text, integer, numeric, boolean,
  text, integer, text, integer, text, integer
);

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
  p_allow_cashier_price_override boolean DEFAULT NULL,
  p_purchase_prefix text DEFAULT NULL,
  p_purchase_next_number integer DEFAULT NULL,
  p_purchase_return_prefix text DEFAULT NULL,
  p_purchase_return_next_number integer DEFAULT NULL,
  p_expense_prefix text DEFAULT NULL,
  p_expense_next_number integer DEFAULT NULL,
  p_drug_licence_no text DEFAULT NULL,
  p_pack_settings jsonb DEFAULT NULL
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
    allow_cashier_price_override = COALESCE(p_allow_cashier_price_override, allow_cashier_price_override),
    purchase_prefix = COALESCE(NULLIF(trim(p_purchase_prefix), ''), purchase_prefix),
    purchase_next_number = GREATEST(1, COALESCE(p_purchase_next_number, purchase_next_number)),
    purchase_return_prefix = COALESCE(NULLIF(trim(p_purchase_return_prefix), ''), purchase_return_prefix),
    purchase_return_next_number = GREATEST(1, COALESCE(p_purchase_return_next_number, purchase_return_next_number)),
    expense_prefix = COALESCE(NULLIF(trim(p_expense_prefix), ''), expense_prefix),
    expense_next_number = GREATEST(1, COALESCE(p_expense_next_number, expense_next_number)),
    drug_licence_no = CASE WHEN p_drug_licence_no IS NOT NULL THEN NULLIF(upper(trim(p_drug_licence_no)), '') ELSE drug_licence_no END,
    pack_settings = COALESCE(p_pack_settings, pack_settings)
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
    auth.uid(), v_email,
    'business.updated', 'business', '1',
    jsonb_build_object('name', v_row.name, 'gst_registered', v_row.gst_registered, 'drug_licence_no', v_row.drug_licence_no)
  );

  RETURN v_row;
END;
$$;

-- save_item with p_item_type & p_wholesale_slabs
DROP FUNCTION IF EXISTS public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer
);

CREATE OR REPLACE FUNCTION public.save_item(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT '',
  p_sku text DEFAULT NULL,
  p_barcode text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_brand_id uuid DEFAULT NULL,
  p_base_unit_id uuid DEFAULT NULL,
  p_selling_price numeric DEFAULT 0,
  p_mrp numeric DEFAULT NULL,
  p_purchase_price numeric DEFAULT NULL,
  p_gst_rate numeric DEFAULT 0,
  p_hsn_code text DEFAULT NULL,
  p_tax_inclusive boolean DEFAULT false,
  p_low_stock_alert numeric DEFAULT 0,
  p_allow_negative_stock boolean DEFAULT false,
  p_opening_stock numeric DEFAULT 0,
  p_opening_unit_id uuid DEFAULT NULL,
  p_pack_metadata jsonb DEFAULT '{}'::jsonb,
  p_notes text DEFAULT NULL,
  p_conversions jsonb DEFAULT '[]'::jsonb,
  p_images jsonb DEFAULT NULL,
  p_expected_version integer DEFAULT NULL,
  p_item_type text DEFAULT 'goods',
  p_wholesale_slabs jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_can_edit_cost boolean;
  v_actor_email text;
  v_clean_name text;
  v_clean_sku text;
  v_clean_barcode text;
  v_clean_hsn text;
  v_item_type text;
  v_item public.items;
  v_existing public.items;
  v_eff_purchase numeric(15,2);
  v_conv jsonb;
  v_alt_unit uuid;
  v_factor numeric(18,6);
  v_open_qty numeric(15,3);
  v_open_unit uuid;
  v_open_base numeric(15,3);
  v_open_factor numeric(18,6);
  v_img_res jsonb := '{}'::jsonb;
  v_removed_files jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can add or edit items.';
  END IF;

  v_can_edit_cost := v_role IN ('owner', 'manager', 'accountant');
  v_item_type := CASE WHEN COALESCE(p_item_type, 'goods') = 'service' THEN 'service' ELSE 'goods' END;

  v_clean_name := trim(COALESCE(p_name, ''));
  IF length(v_clean_name) < 1 THEN
    RAISE EXCEPTION 'Item name is required.';
  END IF;

  IF p_base_unit_id IS NULL THEN
    RAISE EXCEPTION 'Base unit is required.';
  END IF;

  IF COALESCE(p_selling_price, 0) < 0 THEN
    RAISE EXCEPTION 'Selling price cannot be negative.';
  END IF;
  IF p_mrp IS NOT NULL AND p_mrp < 0 THEN
    RAISE EXCEPTION 'MRP cannot be negative.';
  END IF;
  IF COALESCE(p_purchase_price, 0) < 0 THEN
    RAISE EXCEPTION 'Purchase price cannot be negative.';
  END IF;
  IF COALESCE(p_low_stock_alert, 0) < 0 THEN
    RAISE EXCEPTION 'Low stock alert cannot be negative.';
  END IF;

  v_clean_sku := NULLIF(upper(trim(COALESCE(p_sku, ''))), '');
  v_clean_barcode := NULLIF(upper(trim(COALESCE(p_barcode, ''))), '');
  v_clean_hsn := NULLIF(trim(COALESCE(p_hsn_code, '')), '');

  IF p_id IS NULL THEN
    v_eff_purchase := CASE WHEN v_can_edit_cost THEN COALESCE(p_purchase_price, 0) ELSE 0 END;

    INSERT INTO public.items (
      name, sku, barcode, category_id, brand_id, base_unit_id,
      selling_price, mrp, purchase_price, gst_rate, hsn_code,
      tax_inclusive, low_stock_alert, allow_negative_stock,
      pack_metadata, notes, item_type, wholesale_slabs, created_by
    )
    VALUES (
      v_clean_name, v_clean_sku, v_clean_barcode, p_category_id, p_brand_id, p_base_unit_id,
      round(COALESCE(p_selling_price, 0)::numeric, 2),
      CASE WHEN p_mrp IS NOT NULL THEN round(p_mrp::numeric, 2) ELSE NULL END,
      round(v_eff_purchase::numeric, 2),
      COALESCE(p_gst_rate, 0),
      v_clean_hsn,
      COALESCE(p_tax_inclusive, false),
      CASE WHEN v_item_type = 'service' THEN 0 ELSE round(COALESCE(p_low_stock_alert, 0)::numeric, 3) END,
      CASE WHEN v_item_type = 'service' THEN true ELSE COALESCE(p_allow_negative_stock, false) END,
      COALESCE(p_pack_metadata, '{}'::jsonb),
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      v_item_type,
      COALESCE(p_wholesale_slabs, '[]'::jsonb),
      auth.uid()
    )
    RETURNING * INTO v_item;

    INSERT INTO public.stock_balances (item_id, qty_on_hand)
    VALUES (v_item.id, 0)
    ON CONFLICT (item_id) DO NOTHING;
  ELSE
    SELECT * INTO v_existing FROM public.items WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item not found.';
    END IF;

    IF p_expected_version IS NOT NULL AND v_existing.version <> p_expected_version THEN
      RAISE EXCEPTION 'This item was modified by another user. Please refresh and try again.';
    END IF;

    v_eff_purchase := CASE
      WHEN v_can_edit_cost AND p_purchase_price IS NOT NULL THEN round(p_purchase_price::numeric, 2)
      ELSE v_existing.purchase_price
    END;

    UPDATE public.items
    SET
      name = v_clean_name,
      sku = v_clean_sku,
      barcode = v_clean_barcode,
      category_id = p_category_id,
      brand_id = p_brand_id,
      base_unit_id = p_base_unit_id,
      selling_price = round(COALESCE(p_selling_price, 0)::numeric, 2),
      mrp = CASE WHEN p_mrp IS NOT NULL THEN round(p_mrp::numeric, 2) ELSE NULL END,
      purchase_price = v_eff_purchase,
      gst_rate = COALESCE(p_gst_rate, 0),
      hsn_code = v_clean_hsn,
      tax_inclusive = COALESCE(p_tax_inclusive, false),
      low_stock_alert = CASE WHEN v_item_type = 'service' THEN 0 ELSE round(COALESCE(p_low_stock_alert, 0)::numeric, 3) END,
      allow_negative_stock = CASE WHEN v_item_type = 'service' THEN true ELSE COALESCE(p_allow_negative_stock, false) END,
      pack_metadata = COALESCE(p_pack_metadata, '{}'::jsonb),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      item_type = v_item_type,
      wholesale_slabs = COALESCE(p_wholesale_slabs, '[]'::jsonb),
      version = v_existing.version + 1
    WHERE id = p_id
    RETURNING * INTO v_item;
  END IF;

  -- Sync alternate unit conversions
  DELETE FROM public.unit_conversions WHERE item_id = v_item.id;
  IF p_conversions IS NOT NULL AND jsonb_typeof(p_conversions) = 'array' THEN
    FOR v_conv IN SELECT value FROM jsonb_array_elements(p_conversions)
    LOOP
      v_alt_unit := NULLIF(trim(COALESCE(v_conv->>'alternate_unit_id', '')), '')::uuid;
      v_factor := COALESCE((v_conv->>'conversion_factor')::numeric, 0);
      IF v_alt_unit IS NOT NULL AND v_alt_unit <> p_base_unit_id AND v_factor > 0 THEN
        INSERT INTO public.unit_conversions (item_id, alternate_unit_id, conversion_factor)
        VALUES (v_item.id, v_alt_unit, v_factor)
        ON CONFLICT (item_id, alternate_unit_id) DO UPDATE SET conversion_factor = EXCLUDED.conversion_factor;
      END IF;
    END LOOP;
  END IF;

  -- Opening stock only on create and only for goods
  IF p_id IS NULL AND v_item_type = 'goods' THEN
    v_open_qty := round(COALESCE(p_opening_stock, 0)::numeric, 3);
    IF v_open_qty > 0 THEN
      v_open_unit := COALESCE(p_opening_unit_id, p_base_unit_id);
      SELECT base_qty, conversion_factor INTO v_open_base, v_open_factor
      FROM public.convert_item_qty(v_item.id, v_open_qty, v_open_unit);

      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        v_item.id, 'opening_stock', CURRENT_DATE, v_open_qty, v_open_unit,
        v_open_factor, v_open_base, v_eff_purchase, 'Opening stock balance',
        NULL, 'items', v_item.id, auth.uid()
      );
    END IF;
  END IF;

  IF p_images IS NOT NULL AND jsonb_typeof(p_images) = 'array' THEN
    v_img_res := public.sync_item_images(v_item.id, p_images);
    v_removed_files := COALESCE(v_img_res->'removed_file_ids', '[]'::jsonb);
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NULL THEN 'item.created' ELSE 'item.updated' END,
    'item', v_item.id::text,
    jsonb_build_object('name', v_item.name, 'item_type', v_item.item_type, 'selling_price', v_item.selling_price)
  );

  SELECT * INTO v_item FROM public.items WHERE id = v_item.id;
  RETURN jsonb_build_object(
    'id', v_item.id,
    'version', v_item.version,
    'primary_image_file_id', v_item.primary_image_file_id,
    'item', to_jsonb(v_item),
    'removed_file_ids', v_removed_files
  );
END;
$$;

-- save_party with p_price_tier
DROP FUNCTION IF EXISTS public.save_party(
  uuid, text, text, text, text, text, numeric, text, date, numeric, integer, text, jsonb, integer
);

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
  p_expected_version integer DEFAULT NULL,
  p_price_tier text DEFAULT 'standard'
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
  v_tier text;
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
  v_first_addr_id uuid;
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

  v_tier := COALESCE(NULLIF(trim(COALESCE(p_price_tier, '')), ''), 'standard');
  IF v_tier NOT IN ('standard', 'wholesale_a', 'wholesale_b', 'vip') THEN
    RAISE EXCEPTION 'Invalid price tier: %', v_tier;
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
      credit_limit, credit_days, notes, price_tier, created_by
    )
    VALUES (
      v_clean_name, p_party_type, NULLIF(trim(COALESCE(p_phone, '')), ''),
      NULLIF(trim(COALESCE(p_email, '')), ''), v_clean_gstin,
      v_ob, v_ob_type, v_ob_date,
      round(COALESCE(p_credit_limit, 0)::numeric, 2), COALESCE(p_credit_days, 0),
      NULLIF(trim(COALESCE(p_notes, '')), ''), v_tier, auth.uid()
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
        v_party.id, 'opening_balance', v_ob_date,
        CASE WHEN COALESCE(p_credit_days, 0) > 0 THEN v_ob_date + COALESCE(p_credit_days, 0) ELSE v_ob_date END,
        v_ob_ref, 'parties', v_party.id, v_new_signed,
        'Opening balance (' || CASE WHEN v_ob_type = 'to_receive' THEN 'To Receive' ELSE 'To Give' END || ')',
        auth.uid()
      );
    END IF;
  ELSE
    SELECT * INTO v_old_party FROM public.parties WHERE id = p_party_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Party not found.';
    END IF;
    IF p_expected_version IS NOT NULL AND v_old_party.version <> p_expected_version THEN
      RAISE EXCEPTION 'This party was modified by another user. Please refresh and try again.';
    END IF;

    v_old_signed := CASE WHEN v_old_party.opening_balance = 0 THEN 0 WHEN v_old_party.opening_balance_type = 'to_receive' THEN v_old_party.opening_balance ELSE -v_old_party.opening_balance END;
    v_new_signed := CASE WHEN v_ob = 0 THEN 0 WHEN v_ob_type = 'to_receive' THEN v_ob ELSE -v_ob END;
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
      price_tier = v_tier,
      version = v_old_party.version + 1
    WHERE id = p_party_id
    RETURNING * INTO v_party;

    IF v_delta <> 0 THEN
      IF NOT EXISTS (SELECT 1 FROM public.party_ledger_entries WHERE party_id = v_party.id AND entry_type = 'opening_balance') AND v_old_signed = 0 THEN
        v_ob_ref := public.next_document_number('opening_balance', v_ob_date);
        INSERT INTO public.party_ledger_entries (party_id, entry_type, entry_date, due_date, reference_no, source_table, source_id, signed_amount, note, created_by)
        VALUES (v_party.id, 'opening_balance', v_ob_date, CASE WHEN COALESCE(p_credit_days, 0) > 0 THEN v_ob_date + COALESCE(p_credit_days, 0) ELSE v_ob_date END, v_ob_ref, 'parties', v_party.id, v_delta, 'Opening balance', auth.uid());
      ELSE
        v_ob_ref := public.next_document_number('khata_entry', CURRENT_DATE);
        INSERT INTO public.party_ledger_entries (party_id, entry_type, entry_date, reference_no, source_table, source_id, signed_amount, note, created_by)
        VALUES (v_party.id, 'adjustment', CURRENT_DATE, v_ob_ref, 'parties', v_party.id, v_delta, 'Opening balance adjusted', auth.uid());
      END IF;
    END IF;
  END IF;

  IF p_addresses IS NOT NULL AND jsonb_typeof(p_addresses) = 'array' THEN
    DELETE FROM public.party_addresses WHERE party_id = v_party.id;
    FOR v_addr IN SELECT value FROM jsonb_array_elements(p_addresses)
    LOOP
      v_line1 := trim(COALESCE(v_addr->>'address_line1', ''));
      IF length(v_line1) > 0 THEN
        v_addr_is_default := COALESCE((v_addr->>'is_default')::boolean, false) AND NOT v_has_default;
        IF v_addr_is_default THEN v_has_default := true; END IF;
        INSERT INTO public.party_addresses (party_id, label, address_line1, address_line2, city, state, state_code, pincode, is_default)
        VALUES (
          v_party.id,
          COALESCE(NULLIF(trim(COALESCE(v_addr->>'label', '')), ''), 'Primary'),
          v_line1,
          NULLIF(trim(COALESCE(v_addr->>'address_line2', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'city', '')), ''),
          NULLIF(trim(COALESCE(v_addr->>'state', '')), ''),
          NULLIF(upper(trim(COALESCE(v_addr->>'state_code', ''))), ''),
          NULLIF(trim(COALESCE(v_addr->>'pincode', '')), ''),
          v_addr_is_default
        )
        RETURNING id INTO v_first_addr_id;
      END IF;
    END LOOP;
    IF NOT v_has_default AND v_first_addr_id IS NOT NULL THEN
      UPDATE public.party_addresses SET is_default = true
      WHERE id = (SELECT id FROM public.party_addresses WHERE party_id = v_party.id ORDER BY created_at ASC LIMIT 1);
    END IF;
  END IF;

  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_party_id IS NULL THEN 'party.created' ELSE 'party.updated' END,
    'party', v_party.id::text,
    jsonb_build_object('name', v_party.name, 'party_type', v_party.party_type, 'price_tier', v_party.price_tier)
  );

  RETURN v_party;
END;
$$;

-- save_expense with p_job_id
DROP FUNCTION IF EXISTS public.save_expense(uuid, uuid, date, numeric, text, text, text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.save_expense(
  p_id uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_expense_date date DEFAULT CURRENT_DATE,
  p_amount numeric DEFAULT 0,
  p_payment_mode text DEFAULT 'cash',
  p_reference_no text DEFAULT NULL,
  p_paid_to text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_attachment_file_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_job_id uuid DEFAULT NULL
)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_amt numeric(15,2);
  v_mode text;
  v_date date;
  v_idemp text;
  v_existing public.expenses;
  v_exp_no text;
  v_exp public.expenses;
  v_actor_email text;
BEGIN
  PERFORM public.require_module('expenses');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to record expenses.';
  END IF;
  IF p_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE id = p_category_id AND is_active = true) THEN
    RAISE EXCEPTION 'Please choose a valid expense category.';
  END IF;

  v_amt := round(COALESCE(p_amount, 0)::numeric, 2);
  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero.';
  END IF;

  v_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), ''), 'cash');
  IF v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode.';
  END IF;

  IF p_attachment_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_attachment_file_id) THEN
    RAISE EXCEPTION 'Attached receipt file not found.';
  END IF;
  IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.service_jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'Linked service job not found.';
  END IF;

  v_date := COALESCE(p_expense_date, CURRENT_DATE);
  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');

  IF v_idemp IS NOT NULL AND p_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('expense:' || v_idemp));
    SELECT * INTO v_existing FROM public.expenses WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  PERFORM set_config('app.expense_rpc_context', txid_current()::text, true);

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.expenses WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found.'; END IF;
    IF v_role = 'cashier' AND v_existing.created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Cashiers can only edit their own expense entries.';
    END IF;
    IF v_existing.status = 'voided' THEN
      RAISE EXCEPTION 'Voided expenses cannot be edited.';
    END IF;

    UPDATE public.expenses
    SET category_id = p_category_id, expense_date = v_date, amount = v_amt, payment_mode = v_mode,
        reference_no = NULLIF(trim(COALESCE(p_reference_no, '')), ''),
        paid_to = NULLIF(trim(COALESCE(p_paid_to, '')), ''),
        notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
        attachment_file_id = p_attachment_file_id,
        job_id = p_job_id
    WHERE id = p_id
    RETURNING * INTO v_exp;
  ELSE
    v_exp_no := public.next_document_number('expense', v_date);
    INSERT INTO public.expenses (
      expense_number, category_id, expense_date, amount, payment_mode,
      reference_no, paid_to, notes, attachment_file_id, job_id, idempotency_key, created_by
    )
    VALUES (
      v_exp_no, p_category_id, v_date, v_amt, v_mode,
      NULLIF(trim(COALESCE(p_reference_no, '')), ''), NULLIF(trim(COALESCE(p_paid_to, '')), ''),
      NULLIF(trim(COALESCE(p_notes, '')), ''), p_attachment_file_id, p_job_id, v_idemp, auth.uid()
    )
    RETURNING * INTO v_exp;
  END IF;

  IF p_attachment_file_id IS NOT NULL THEN
    INSERT INTO public.file_links (file_id, entity_type, entity_id)
    VALUES (p_attachment_file_id, 'expense', v_exp.id)
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM set_config('app.expense_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NOT NULL THEN 'expense.updated' ELSE 'expense.created' END,
    'expense', v_exp.id::text,
    jsonb_build_object('expense_number', v_exp.expense_number, 'amount', v_exp.amount, 'job_id', v_exp.job_id)
  );

  RETURN v_exp;
END;
$$;

-- ============================================================================
-- 5. Pack-Aware Billing RPCs (_prepare_bill_payload, save_bill_draft, issue_bill,
--    convert_quotation_to_bill, create_sales_return, void_bill)
-- ============================================================================
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
    + CASE
        WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
        WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
        ELSE 0
      END
  )::numeric(15,2) AS settled_amount,
  GREATEST(
    abs(le.signed_amount)
    - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
    - CASE
        WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
        WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
        ELSE 0
      END,
    0
  )::numeric(15,2) AS remaining_amount,
  CASE WHEN le.signed_amount > 0 THEN 'receive' ELSE 'give' END AS direction_needed,
  (
    GREATEST(
      abs(le.signed_amount)
      - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
      - CASE
          WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
          WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
          ELSE 0
        END,
      0
    ) > 0
    AND le.due_date IS NOT NULL
    AND le.due_date < CURRENT_DATE
  ) AS is_overdue,
  le.created_at
FROM public.party_ledger_entries le
LEFT JOIN public.bills b
  ON le.source_table = 'bills' AND le.source_id = b.id
LEFT JOIN public.purchase_bills pb
  ON le.source_table = 'purchase_bills' AND le.source_id = pb.id
LEFT JOIN public.payment_allocations pa
  ON pa.ledger_entry_id = le.id AND pa.is_reversed = false
WHERE le.is_reversed = false
  AND le.entry_type IN ('opening_balance', 'khata_due', 'bill', 'purchase')
GROUP BY le.id, b.credited_amount, pb.credited_amount
HAVING GREATEST(
  abs(le.signed_amount)
  - COALESCE(SUM(pa.allocated_amount) FILTER (WHERE pa.is_reversed = false), 0)
  - CASE
      WHEN le.source_table = 'bills' THEN COALESCE(b.credited_amount, 0)
      WHEN le.source_table = 'purchase_bills' THEN COALESCE(pb.credited_amount, 0)
      ELSE 0
    END,
  0
) > 0;

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
  v_pb public.purchase_bills;
  v_prev_ctx text;
BEGIN
  v_ledger_id := COALESCE(NEW.ledger_entry_id, OLD.ledger_entry_id);
  IF v_ledger_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT * INTO v_le FROM public.party_ledger_entries WHERE id = v_ledger_id;
  IF NOT FOUND OR v_le.source_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_le.source_table = 'bills' AND v_le.entry_type = 'bill' THEN
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
  ELSIF v_le.source_table = 'purchase_bills' AND v_le.entry_type = 'purchase' THEN
    SELECT COALESCE(SUM(allocated_amount), 0)::numeric(15,2)
    INTO v_paid
    FROM public.payment_allocations
    WHERE ledger_entry_id = v_ledger_id AND is_reversed = false;

    SELECT * INTO v_pb FROM public.purchase_bills WHERE id = v_le.source_id FOR UPDATE;
    IF FOUND AND v_pb.status = 'posted' THEN
      v_prev_ctx := COALESCE(current_setting('app.purchase_rpc_context', true), '');
      PERFORM set_config('app.purchase_rpc_context', txid_current()::text, true);
      UPDATE public.purchase_bills
      SET
        paid_amount = v_paid,
        balance_due = GREATEST(round((grand_total - v_paid - credited_amount)::numeric, 2), 0)
      WHERE id = v_pb.id;
      PERFORM set_config('app.purchase_rpc_context', v_prev_ctx, true);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
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
  v_party public.parties;
  v_amt numeric(15,2);
  v_date date;
  v_idemp text;
  v_existing public.payments;
  v_alloc jsonb;
  v_target_entry_id uuid;
  v_alloc_amt numeric(15,2);
  v_target_row public.party_ledger_entries;
  v_already_settled numeric(15,2);
  v_doc_credited numeric(15,2);
  v_remaining numeric(15,2);
  v_allocated_total numeric(15,2) := 0;
  v_advance_amt numeric(15,2) := 0;
  v_seen_ids uuid[] := ARRAY[]::uuid[];
  v_planned jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_open_rec record;
  v_left_to_allocate numeric(15,2);
  v_apply numeric(15,2);
  v_payment_no text;
  v_payment public.payments;
  v_signed_ledger numeric(15,2);
  v_actor_email text;
BEGIN
  PERFORM public.require_module('parties');
  PERFORM public.require_module('payments');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to post payments.';
  END IF;

  IF p_direction NOT IN ('receive', 'give') THEN
    RAISE EXCEPTION 'Payment direction must be receive or give.';
  END IF;

  IF p_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode.';
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Party not found.';
  END IF;
  IF NOT v_party.is_active THEN
    RAISE EXCEPTION 'Cannot post payment for an archived party.';
  END IF;

  IF p_allocations IS NOT NULL AND jsonb_typeof(p_allocations) = 'array' AND jsonb_array_length(p_allocations) > 0 THEN
    FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations)
    LOOP
      v_target_entry_id := (v_alloc->>'ledger_entry_id')::uuid;
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

      v_doc_credited := 0;
      IF v_target_row.source_table = 'bills' AND v_target_row.source_id IS NOT NULL THEN
        SELECT COALESCE(credited_amount, 0) INTO v_doc_credited FROM public.bills WHERE id = v_target_row.source_id;
      ELSIF v_target_row.source_table = 'purchase_bills' AND v_target_row.source_id IS NOT NULL THEN
        SELECT COALESCE(credited_amount, 0) INTO v_doc_credited FROM public.purchase_bills WHERE id = v_target_row.source_id;
      END IF;

      v_remaining := GREATEST(abs(v_target_row.signed_amount) - v_already_settled - v_doc_credited, 0);
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
              WHEN le.source_table = 'purchase_bills' AND le.source_id IS NOT NULL
                THEN COALESCE((SELECT pb.credited_amount FROM public.purchase_bills pb WHERE pb.id = le.source_id), 0)
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

CREATE OR REPLACE FUNCTION public.guard_immutable_purchase_bills()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_rpc boolean := COALESCE(current_setting('app.purchase_rpc_context', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Posted or voided purchase documents cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF NOT v_in_rpc THEN
      RAISE EXCEPTION 'Posted or voided purchase documents are immutable.';
    END IF;
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'A voided purchase document cannot be modified.';
    END IF;

    IF NEW.purchase_number IS DISTINCT FROM OLD.purchase_number
       OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
       OR NEW.source_purchase_id IS DISTINCT FROM OLD.source_purchase_id
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
       OR NEW.freight_charges IS DISTINCT FROM OLD.freight_charges
       OR NEW.round_off IS DISTINCT FROM OLD.round_off
       OR NEW.grand_total IS DISTINCT FROM OLD.grand_total
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by THEN
      RAISE EXCEPTION 'Financial totals and identity of a posted purchase document cannot be altered.';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'posted' AND NEW.status = 'voided') THEN
      RAISE EXCEPTION 'Invalid purchase status transition from % to %.', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_immutable_purchase_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_purchase_id uuid;
  v_status text;
  v_in_init boolean := COALESCE(current_setting('app.purchase_line_init', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_purchase_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_id ELSE NEW.purchase_id END;
  SELECT status INTO v_status FROM public.purchase_bills WHERE id = v_purchase_id;

  IF v_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_status <> 'draft' AND NOT (TG_OP = 'INSERT' AND v_in_init) THEN
    RAISE EXCEPTION 'Lines of a posted or voided purchase document are immutable.';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_immutable_expenses()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_in_rpc boolean := COALESCE(current_setting('app.expense_rpc_context', true), '') = txid_current()::text;
  v_in_restore boolean := COALESCE(current_setting('app.restore_context', true), '') = txid_current()::text AND public.is_owner();
BEGIN
  IF v_in_restore THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted expenses cannot be deleted; use void_expense instead.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NOT v_in_rpc THEN
      RAISE EXCEPTION 'Posted expenses can only be updated via expense RPCs.';
    END IF;
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'A voided expense cannot be modified.';
    END IF;
  END IF;

  RETURN NEW;
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

  IF p_series_key IN (
    'tax_invoice', 'bill_of_supply', 'quotation', 'credit_note',
    'purchase_bill', 'purchase_return', 'expense'
  ) THEN
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
    ELSIF p_series_key = 'purchase_bill' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.purchase_prefix), ''), 'PUR-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.purchase_next_number, 1));
    ELSIF p_series_key = 'purchase_return' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.purchase_return_prefix), ''), 'PR-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.purchase_return_next_number, 1));
    ELSIF p_series_key = 'expense' THEN
      v_prefix := COALESCE(NULLIF(trim(v_biz.expense_prefix), ''), 'EXP-');
      v_biz_next := GREATEST(1, COALESCE(v_biz.expense_next_number, 1));
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

  IF p_series_key IN (
    'tax_invoice', 'bill_of_supply', 'quotation', 'credit_note',
    'purchase_bill', 'purchase_return', 'expense'
  ) THEN
    v_next := GREATEST(v_next, v_biz_next);
  END IF;

  LOOP
    EXIT WHEN NOT (
      (v_effective_key IN ('tax_invoice', 'bill_of_supply', 'quotation', 'credit_note') AND EXISTS (
        SELECT 1 FROM public.bills WHERE bill_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
      OR (v_effective_key IN ('purchase_bill', 'purchase_return') AND EXISTS (
        SELECT 1 FROM public.purchase_bills WHERE purchase_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
      OR (v_effective_key = 'expense' AND EXISTS (
        SELECT 1 FROM public.expenses WHERE expense_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
      OR (v_effective_key IN ('payment_receive', 'payment_give') AND EXISTS (
        SELECT 1 FROM public.payments WHERE payment_number = v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0')
      ))
    );
    v_next := v_next + 1;
  END LOOP;

  UPDATE public.numbering_series
  SET prefix = v_prefix,
      next_number = v_next + 1,
      updated_at = now()
  WHERE series_key = v_effective_key AND fy_code = v_fy_code;

  IF v_effective_key = 'tax_invoice' THEN
    UPDATE public.business SET invoice_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'quotation' THEN
    UPDATE public.business SET quotation_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'credit_note' THEN
    UPDATE public.business SET credit_note_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'purchase_bill' THEN
    UPDATE public.business SET purchase_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'purchase_return' THEN
    UPDATE public.business SET purchase_return_next_number = v_next + 1 WHERE id = 1;
  ELSIF v_effective_key = 'expense' THEN
    UPDATE public.business SET expense_next_number = v_next + 1 WHERE id = 1;
  END IF;

  RETURN v_prefix || v_fy_code || '-' || lpad(v_next::text, v_padding, '0');
END;
$$;

DROP FUNCTION IF EXISTS public._prepare_bill_payload(text, uuid, text, numeric, boolean, jsonb, text);

CREATE OR REPLACE FUNCTION public._prepare_bill_payload(
  p_doc_type text,
  p_party_id uuid,
  p_place_of_supply text,
  p_extra_charges numeric,
  p_auto_round_off boolean,
  p_lines jsonb,
  p_actor_role text,
  p_bill_date date DEFAULT CURRENT_DATE
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
  v_bill_date date := COALESCE(p_bill_date, CURRENT_DATE);
  v_batch public.item_batches;
  v_batch_id uuid;
  v_batch_no text;
  v_expiry_date date;
  v_line_mrp numeric(15,2);
  v_variant public.item_variants;
  v_variant_id uuid;
  v_variant_label text;
  v_custom_rate numeric(15,2);
  v_slab jsonb;
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
    SELECT base_qty, conversion_factor INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id);
    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    -- Resolve Batch (Medical / batch_expiry)
    v_batch_id := NULLIF(trim(COALESCE(v_raw->>'batch_id', '')), '')::uuid;
    v_batch_no := NULL;
    v_expiry_date := NULL;
    v_line_mrp := v_item.mrp;

    IF v_batch_id IS NOT NULL THEN
      SELECT * INTO v_batch FROM public.item_batches WHERE id = v_batch_id AND item_id = v_item.id;
      IF NOT FOUND OR NOT v_batch.is_active THEN
        RAISE EXCEPTION 'Selected batch for "%" is inactive or missing.', v_item.name;
      END IF;
      IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND v_batch.expiry_date < v_bill_date THEN
        RAISE EXCEPTION 'Batch "%" for "%" expired on %. Sale of expired medicine is blocked.', v_batch.batch_no, v_item.name, v_batch.expiry_date;
      END IF;
      IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND v_batch.qty_on_hand < v_base_qty AND NOT v_item.allow_negative_stock THEN
        RAISE EXCEPTION 'Batch "%" has only % % available for "%".', v_batch.batch_no, v_batch.qty_on_hand, v_unit_code, v_item.name;
      END IF;
      v_batch_no := v_batch.batch_no;
      v_expiry_date := v_batch.expiry_date;
      v_line_mrp := COALESCE(v_batch.mrp, v_item.mrp);
    ELSIF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND public.is_module_enabled('batch_expiry') AND EXISTS (
      SELECT 1 FROM public.item_batches ib WHERE ib.item_id = v_item.id AND ib.is_active = true
    ) THEN
      -- Automatic FEFO selection across non-expired batches with sufficient stock
      SELECT * INTO v_batch
      FROM public.item_batches ib
      WHERE ib.item_id = v_item.id
        AND ib.is_active = true
        AND ib.expiry_date >= v_bill_date
        AND ib.qty_on_hand >= v_base_qty
      ORDER BY ib.expiry_date ASC, ib.created_at ASC
      LIMIT 1;
      IF NOT FOUND THEN
        -- Check if only expired stock exists
        IF EXISTS (SELECT 1 FROM public.item_batches ib WHERE ib.item_id = v_item.id AND ib.is_active = true AND ib.expiry_date < v_bill_date AND ib.qty_on_hand > 0) THEN
          RAISE EXCEPTION 'Available stock for "%" is expired. Select a valid non-expired batch.', v_item.name;
        END IF;
        RAISE EXCEPTION 'Insufficient batch stock for "%" (FEFO check failed).', v_item.name;
      END IF;
      v_batch_id := v_batch.id;
      v_batch_no := v_batch.batch_no;
      v_expiry_date := v_batch.expiry_date;
      v_line_mrp := COALESCE(v_batch.mrp, v_item.mrp);
    END IF;

    -- Resolve Variant (Clothing / variants)
    v_variant_id := NULLIF(trim(COALESCE(v_raw->>'variant_id', '')), '')::uuid;
    v_variant_label := NULL;
    IF v_variant_id IS NOT NULL THEN
      SELECT * INTO v_variant FROM public.item_variants WHERE id = v_variant_id AND item_id = v_item.id;
      IF NOT FOUND OR NOT v_variant.is_active THEN
        RAISE EXCEPTION 'Selected variant for "%" is inactive or missing.', v_item.name;
      END IF;
      IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND v_variant.qty_on_hand < v_base_qty AND NOT v_item.allow_negative_stock THEN
        RAISE EXCEPTION 'Variant "% / %" for "%" has only % in stock.', v_variant.size, v_variant.color, v_item.name, v_variant.qty_on_hand;
      END IF;
      v_variant_label := v_variant.size || CASE WHEN COALESCE(v_variant.color, 'Default') <> 'Default' THEN ' / ' || v_variant.color ELSE '' END;
      v_line_mrp := COALESCE(v_variant.mrp, v_line_mrp);
    END IF;

    -- Base catalog price (prefers variant/batch selling rate, then party negotiated rate / wholesale slab, then item.selling_price)
    v_catalog_price := COALESCE(v_variant.selling_price, v_batch.selling_rate, v_item.selling_price);
    IF p_party_id IS NOT NULL THEN
      SELECT pir.custom_rate INTO v_custom_rate
      FROM public.party_item_rates pir
      WHERE pir.party_id = p_party_id AND pir.item_id = v_item.id AND v_base_qty >= pir.min_qty;
      IF v_custom_rate IS NOT NULL THEN
        v_catalog_price := v_custom_rate;
      ELSIF jsonb_typeof(v_item.wholesale_slabs) = 'array' AND jsonb_array_length(v_item.wholesale_slabs) > 0 THEN
        FOR v_slab IN
          SELECT value FROM jsonb_array_elements(v_item.wholesale_slabs)
          ORDER BY COALESCE((value->>'min_qty')::numeric, 0) DESC
        LOOP
          IF v_base_qty >= COALESCE((v_slab->>'min_qty')::numeric, 999999)
             AND (NULLIF(v_slab->>'tier', '') IS NULL OR v_slab->>'tier' = 'all' OR v_slab->>'tier' = v_party.price_tier) THEN
            v_catalog_price := COALESCE((v_slab->>'rate')::numeric, v_catalog_price);
            EXIT;
          END IF;
        END LOOP;
      END IF;
    END IF;
    v_catalog_price := round((v_catalog_price * v_factor)::numeric, 2);

    v_unit_price := round(COALESCE(NULLIF(v_raw->>'unit_price', '')::numeric, v_catalog_price), 2);
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION 'Unit price for "%" cannot be negative.', v_item.name;
    END IF;

    v_disc_pct := round(COALESCE(NULLIF(v_raw->>'discount_pct', '')::numeric, 0), 2);
    IF v_disc_pct < 0 OR v_disc_pct > 100 THEN
      RAISE EXCEPTION 'Discount percentage for "%" must be between 0 and 100.', v_item.name;
    END IF;

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
      'item_type', v_item.item_type,
      'item_name', v_item.name,
      'sku', COALESCE(v_variant.sku, v_item.sku),
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
      'gst_rate', v_item.gst_rate,
      'batch_id', v_batch_id,
      'batch_no', v_batch_no,
      'expiry_date', v_expiry_date,
      'mrp', v_line_mrp,
      'variant_id', v_variant_id,
      'variant_label', v_variant_label,
      'pack_metadata', v_item.pack_metadata,
      'line_meta', COALESCE(v_raw->'line_meta', '{}'::jsonb)
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
      'pack', v_biz.pack,
      'gst_registered', v_biz.gst_registered,
      'gstin', v_biz.gstin,
      'drug_licence_no', v_biz.drug_licence_no,
      'phone', v_biz.phone,
      'email', v_biz.email,
      'address', v_biz.address,
      'state_code', v_biz.state_code,
      'upi_id', v_biz.upi_id,
      'logo_file_id', v_biz.logo_file_id,
      'upi_qr_file_id', v_biz.upi_qr_file_id,
      'show_upi_qr_on_invoice', v_biz.show_upi_qr_on_invoice,
      'default_print_layout', v_biz.default_print_layout,
      'pack_settings', v_biz.pack_settings,
      'bank_name', v_biz.pack_settings->>'bank_name',
      'bank_account_holder', v_biz.pack_settings->>'bank_account_holder',
      'bank_account_no', v_biz.pack_settings->>'bank_account_no',
      'bank_ifsc', v_biz.pack_settings->>'bank_ifsc',
      'bank_branch', v_biz.pack_settings->>'bank_branch',
      'bank_account_type', v_biz.pack_settings->>'bank_account_type',
      'show_bank_on_invoice', COALESCE((v_biz.pack_settings->>'show_bank_on_invoice')::boolean, true),
      'show_cashier_on_invoice', COALESCE((v_biz.pack_settings->>'show_cashier_on_invoice')::boolean, true),
      'default_cashier_name', v_biz.pack_settings->>'default_cashier_name',
      'cashier_name', COALESCE(
        NULLIF(trim(COALESCE(v_biz.pack_settings->>'default_cashier_name', '')), ''),
        (SELECT full_name FROM public.profiles WHERE id = auth.uid())
      ),
      'show_signatory_on_invoice', COALESCE((v_biz.pack_settings->>'show_signatory_on_invoice')::boolean, true),
      'signatory_label', COALESCE(NULLIF(trim(COALESCE(v_biz.pack_settings->>'signatory_label', '')), ''), 'Authorized Signatory'),
      'show_hsn_on_invoice', COALESCE((v_biz.pack_settings->>'show_hsn_on_invoice')::boolean, true),
      'show_mrp_savings_on_invoice', COALESCE((v_biz.pack_settings->>'show_mrp_savings_on_invoice')::boolean, true),
      'show_customer_details_on_invoice', COALESCE((v_biz.pack_settings->>'show_customer_details_on_invoice')::boolean, true),
      'invoice_greeting', COALESCE(v_biz.pack_settings->>'invoice_greeting', 'Thank you! Visit Again')
    ),
    'prepared_lines', v_prepared_lines,
    'calc', v_calc
  );
END;
$$;

DROP FUNCTION IF EXISTS public.save_bill_draft(
  uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb
);

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
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_site_id uuid DEFAULT NULL,
  p_job_id uuid DEFAULT NULL
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
  v_site_name text := NULL;
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to create or edit bills.';
  END IF;

  IF p_site_id IS NOT NULL THEN
    SELECT site_name INTO v_site_name FROM public.party_sites WHERE id = p_site_id;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_prep := public._prepare_bill_payload(
    p_doc_type, p_party_id, p_place_of_supply, p_extra_charges, p_auto_round_off, p_lines, v_role, COALESCE(p_bill_date, CURRENT_DATE)
  );
  v_calc := v_prep->'calc';

  IF p_id IS NULL THEN
    INSERT INTO public.bills (
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin,
      party_address, place_of_supply_state_code, is_interstate, bill_date, due_date,
      valid_until, gst_applied, subtotal_taxable, discount_total, cgst_total, sgst_total,
      igst_total, tax_total, extra_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due, notes, terms, business_snapshot,
      site_id, site_name, job_id, created_by
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
      v_prep->'biz_snapshot', p_site_id, v_site_name, p_job_id, auth.uid()
    )
    RETURNING * INTO v_bill;
  ELSE
    SELECT * INTO v_existing FROM public.bills WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft bill not found.'; END IF;
    IF v_existing.status <> 'draft' THEN
      RAISE EXCEPTION 'Only draft documents can be edited. Issued documents are immutable.';
    END IF;

    UPDATE public.bills
    SET
      doc_type = p_doc_type, party_id = p_party_id, party_name = v_prep->>'party_name',
      party_phone = v_prep->>'party_phone', party_gstin = v_prep->>'party_gstin',
      party_address = v_prep->>'party_address',
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_calc->>'is_interstate')::boolean,
      bill_date = COALESCE(p_bill_date, CURRENT_DATE), due_date = p_due_date,
      valid_until = p_valid_until, gst_applied = (v_calc->>'gst_applied')::boolean,
      subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
      discount_total = (v_calc->>'discount_total')::numeric,
      cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
      igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
      extra_charges = (v_calc->>'extra_charges')::numeric,
      auto_round_off = COALESCE(p_auto_round_off, true), round_off = (v_calc->>'round_off')::numeric,
      grand_total = (v_calc->>'grand_total')::numeric, balance_due = (v_calc->>'grand_total')::numeric,
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''), terms = COALESCE(p_terms, v_biz.invoice_terms),
      business_snapshot = v_prep->'biz_snapshot',
      site_id = p_site_id, site_name = v_site_name, job_id = p_job_id
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
      igst_amount, tax_amount, line_total,
      batch_id, batch_no, expiry_date, mrp, variant_id, variant_label, line_meta
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
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'batch_id', '')::uuid, NULLIF(v_pl->>'batch_no', ''),
      NULLIF(v_pl->>'expiry_date', '')::date, NULLIF(v_pl->>'mrp', '')::numeric,
      NULLIF(v_pl->>'variant_id', '')::uuid, NULLIF(v_pl->>'variant_label', ''),
      COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );
  END LOOP;

  RETURN v_bill;
END;
$$;

DROP FUNCTION IF EXISTS public.issue_bill(
  uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, numeric, text, text, text
);

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
  p_idempotency_key text DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_job_id uuid DEFAULT NULL,
  p_prescription jsonb DEFAULT NULL
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
  v_prep jsonb;
  v_calc jsonb;
  v_bill_date date;
  v_due_date date;
  v_grand numeric(15,2);
  v_paid numeric(15,2);
  v_balance numeric(15,2);
  v_mode text;
  v_pay_ref text;
  v_bill_number text;
  v_bill public.bills;
  v_line_row public.bill_lines;
  v_actor_email text;
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
  v_bill_ledger public.party_ledger_entries;
  v_party_credit_days integer := 0;
  v_site_name text := NULL;
  v_rx_id uuid := NULL;
  v_has_schedule boolean := false;
  v_sched_class text;
  v_warranty_months integer;
  v_serial_no text;
BEGIN
  PERFORM public.require_module('billing');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to issue bills.';
  END IF;

  v_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), ''), 'cash');
  IF v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode: %.', v_mode;
  END IF;
  v_pay_ref := NULLIF(trim(COALESCE(p_payment_reference, '')), '');

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('bill_issue:' || v_idemp));
    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_bill_date := COALESCE(p_bill_date, CURRENT_DATE);

  IF p_site_id IS NOT NULL THEN
    SELECT site_name INTO v_site_name FROM public.party_sites WHERE id = p_site_id;
  END IF;

  IF p_party_id IS NOT NULL THEN
    SELECT credit_days INTO v_party_credit_days FROM public.parties WHERE id = p_party_id;
    v_due_date := COALESCE(p_due_date, CASE WHEN COALESCE(v_party_credit_days, 0) > 0 THEN v_bill_date + v_party_credit_days ELSE NULL END);
  ELSE
    v_due_date := p_due_date;
  END IF;

  v_prep := public._prepare_bill_payload(
    p_doc_type, p_party_id, p_place_of_supply, p_extra_charges, p_auto_round_off, p_lines, v_role, v_bill_date
  );
  v_calc := v_prep->'calc';
  v_grand := (v_calc->>'grand_total')::numeric(15,2);

  -- Medical schedule H / H1 prescription validation
  IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND v_biz.pack = 'medical' THEN
    FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1) LOOP
      v_sched_class := upper(trim(COALESCE((v_prep->'prepared_lines')->v_i->'pack_metadata'->>'schedule', '')));
      IF v_sched_class IN ('H', 'H1', 'X', 'NRX') THEN
        v_has_schedule := true;
      END IF;
    END LOOP;
    IF v_has_schedule AND (
      p_prescription IS NULL
      OR length(trim(COALESCE(p_prescription->>'patient_name', ''))) < 1
      OR length(trim(COALESCE(p_prescription->>'doctor_name', ''))) < 1
    ) THEN
      RAISE EXCEPTION 'Patient name and Doctor name are required for Schedule H / H1 medicines.';
    END IF;
  END IF;

  IF p_doc_type = 'quotation' THEN
    v_paid := 0;
    v_balance := 0;
  ELSE
    v_paid := round(COALESCE(p_paid_amount, 0)::numeric, 2);
    IF v_paid < 0 THEN RAISE EXCEPTION 'Paid amount cannot be negative.'; END IF;
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
      RAISE EXCEPTION 'Payments module must be enabled to record an immediate payment on a party bill.';
    END IF;
    v_balance := round((v_grand - v_paid)::numeric, 2);
  END IF;

  v_bill_number := public.next_document_number(p_doc_type, v_bill_date);

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.bill_line_init', txid_current()::text, true);

  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.bills WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Draft bill not found.'; END IF;
    IF v_existing.status <> 'draft' THEN RAISE EXCEPTION 'This document has already been issued.'; END IF;
    DELETE FROM public.bill_lines WHERE bill_id = p_draft_id;

    UPDATE public.bills
    SET
      bill_number = v_bill_number, doc_type = p_doc_type, status = 'issued',
      party_id = p_party_id, party_name = v_prep->>'party_name', party_phone = v_prep->>'party_phone',
      party_gstin = v_prep->>'party_gstin', party_address = v_prep->>'party_address',
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_calc->>'is_interstate')::boolean,
      bill_date = v_bill_date, due_date = v_due_date, valid_until = p_valid_until,
      gst_applied = (v_calc->>'gst_applied')::boolean,
      subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
      discount_total = (v_calc->>'discount_total')::numeric,
      cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
      igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
      extra_charges = (v_calc->>'extra_charges')::numeric,
      auto_round_off = COALESCE(p_auto_round_off, true), round_off = (v_calc->>'round_off')::numeric,
      grand_total = v_grand, paid_amount = v_paid, credited_amount = 0, balance_due = v_balance,
      payment_mode = v_mode, payment_reference = v_pay_ref,
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''), terms = COALESCE(p_terms, v_biz.invoice_terms),
      business_snapshot = v_prep->'biz_snapshot', idempotency_key = v_idemp,
      site_id = p_site_id, site_name = v_site_name, job_id = p_job_id,
      issued_at = now(), issued_by = auth.uid()
    WHERE id = p_draft_id
    RETURNING * INTO v_bill;
  ELSE
    INSERT INTO public.bills (
      bill_number, doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      place_of_supply_state_code, is_interstate, bill_date, due_date, valid_until, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total, tax_total,
      extra_charges, auto_round_off, round_off, grand_total, paid_amount, credited_amount, balance_due,
      payment_mode, payment_reference, notes, terms, business_snapshot, idempotency_key,
      site_id, site_name, job_id, issued_at, issued_by, created_by
    )
    VALUES (
      v_bill_number, p_doc_type, 'issued', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address', v_prep->>'place_of_supply_state_code',
      (v_calc->>'is_interstate')::boolean, v_bill_date, v_due_date, p_valid_until,
      (v_calc->>'gst_applied')::boolean, (v_calc->>'subtotal_taxable')::numeric,
      (v_calc->>'discount_total')::numeric, (v_calc->>'cgst_total')::numeric,
      (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
      (v_calc->>'tax_total')::numeric, (v_calc->>'extra_charges')::numeric,
      COALESCE(p_auto_round_off, true), (v_calc->>'round_off')::numeric, v_grand,
      v_paid, 0, v_balance, v_mode, v_pay_ref,
      NULLIF(trim(COALESCE(p_notes, '')), ''), COALESCE(p_terms, v_biz.invoice_terms),
      v_prep->'biz_snapshot', v_idemp, p_site_id, v_site_name, p_job_id, now(), auth.uid(), auth.uid()
    )
    RETURNING * INTO v_bill;
  END IF;

  -- Save optional Prescription & Schedule Register header
  IF p_prescription IS NOT NULL AND length(trim(COALESCE(p_prescription->>'patient_name', ''))) > 0 THEN
    INSERT INTO public.prescriptions (
      bill_id, patient_name, patient_age, patient_phone, doctor_name, doctor_reg_no, notes, attachment_file_id, created_by
    )
    VALUES (
      v_bill.id,
      trim(p_prescription->>'patient_name'),
      NULLIF(trim(COALESCE(p_prescription->>'patient_age', '')), ''),
      NULLIF(trim(COALESCE(p_prescription->>'patient_phone', '')), ''),
      COALESCE(NULLIF(trim(COALESCE(p_prescription->>'doctor_name', '')), ''), 'Self / Clinic'),
      NULLIF(trim(COALESCE(p_prescription->>'doctor_reg_no', '')), ''),
      NULLIF(trim(COALESCE(p_prescription->>'notes', '')), ''),
      NULLIF(trim(COALESCE(p_prescription->>'attachment_file_id', '')), '')::uuid,
      auth.uid()
    )
    RETURNING id INTO v_rx_id;

    UPDATE public.bills SET prescription_id = v_rx_id WHERE id = v_bill.id;
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
      igst_amount, tax_amount, line_total,
      batch_id, batch_no, expiry_date, mrp, variant_id, variant_label, line_meta
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
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'batch_id', '')::uuid, NULLIF(v_pl->>'batch_no', ''),
      NULLIF(v_pl->>'expiry_date', '')::date, NULLIF(v_pl->>'mrp', '')::numeric,
      NULLIF(v_pl->>'variant_id', '')::uuid, NULLIF(v_pl->>'variant_label', ''),
      COALESCE(v_pl->'line_meta', '{}'::jsonb)
    )
    RETURNING * INTO v_line_row;

    IF p_doc_type IN ('tax_invoice', 'bill_of_supply') THEN
      -- Goods deduct stock, batch, and variant balances; services skip stock_ledger
      IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
        IF v_line_row.batch_id IS NOT NULL THEN
          UPDATE public.item_batches
          SET qty_on_hand = GREATEST(0, qty_on_hand - (v_pl->>'base_qty')::numeric)
          WHERE id = v_line_row.batch_id;
        END IF;
        IF v_line_row.variant_id IS NOT NULL THEN
          UPDATE public.item_variants
          SET qty_on_hand = GREATEST(0, qty_on_hand - (v_pl->>'base_qty')::numeric)
          WHERE id = v_line_row.variant_id;
        END IF;

        INSERT INTO public.stock_ledger (
          item_id, movement_type, movement_date, entered_qty, entered_unit_id,
          conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
          source_table, source_id, batch_id, variant_id, created_by
        )
        VALUES (
          (v_pl->>'item_id')::uuid, 'sale', v_bill_date,
          (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
          (v_pl->>'conversion_factor')::numeric, -((v_pl->>'base_qty')::numeric),
          (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid),
          'Sales Bill ' || v_bill.bill_number, v_bill.bill_number,
          'bills', v_bill.id, v_line_row.batch_id, v_line_row.variant_id, auth.uid()
        );
      END IF;

      -- Schedule H/H1 Register logging
      v_sched_class := upper(trim(COALESCE(v_pl->'pack_metadata'->>'schedule', '')));
      IF v_sched_class IN ('H', 'H1', 'X', 'NRX') THEN
        INSERT INTO public.schedule_register (
          bill_id, bill_line_id, prescription_id, item_id, item_name, salt_name,
          schedule_class, batch_no, expiry_date, qty, unit_code,
          patient_name, doctor_name, doctor_reg_no, sale_date
        )
        VALUES (
          v_bill.id, v_line_row.id, v_rx_id, v_line_row.item_id, v_line_row.item_name,
          NULLIF(trim(COALESCE(v_pl->'pack_metadata'->>'salt', '')), ''),
          CASE WHEN v_sched_class = 'NRX' THEN 'NRx' ELSE v_sched_class END,
          v_line_row.batch_no, v_line_row.expiry_date,
          v_line_row.entered_qty, v_line_row.entered_unit_code,
          COALESCE(NULLIF(trim(COALESCE(p_prescription->>'patient_name', '')), ''), v_bill.party_name),
          COALESCE(NULLIF(trim(COALESCE(p_prescription->>'doctor_name', '')), ''), 'Unspecified'),
          NULLIF(trim(COALESCE(p_prescription->>'doctor_reg_no', '')), ''),
          v_bill_date
        );
      END IF;

      -- Auto-create warranty record for Hardware/items carrying warranty_months
      v_warranty_months := COALESCE(NULLIF(v_pl->'pack_metadata'->>'warranty_months', '')::integer, 0);
      IF v_warranty_months > 0 THEN
        v_serial_no := COALESCE(
          NULLIF(trim(COALESCE(v_pl->'line_meta'->>'serial_no', '')), ''),
          v_bill.bill_number || '-L' || v_line_row.line_no
        );
        INSERT INTO public.warranty_records (
          item_id, bill_id, bill_line_id, party_id, party_name, item_name,
          serial_no, warranty_months, purchase_date, warranty_end_date, status
        )
        VALUES (
          v_line_row.item_id, v_bill.id, v_line_row.id, v_bill.party_id, v_bill.party_name,
          v_line_row.item_name, v_serial_no, v_warranty_months, v_bill_date,
          (v_bill_date + (v_warranty_months || ' months')::interval)::date, 'active'
        );
      END IF;
    END IF;
  END LOOP;

  -- Link Service Job status & bill reference when billed
  IF p_job_id IS NOT NULL AND p_doc_type IN ('tax_invoice', 'bill_of_supply') THEN
    UPDATE public.service_jobs
    SET status = 'billed', linked_bill_id = v_bill.id, completed_date = COALESCE(completed_date, v_bill_date)
    WHERE id = p_job_id;
  END IF;

  PERFORM set_config('app.bill_line_init', '', true);

  IF p_doc_type IN ('tax_invoice', 'bill_of_supply') AND p_party_id IS NOT NULL AND public.is_module_enabled('parties') THEN
    IF v_grand > 0 THEN
      INSERT INTO public.party_ledger_entries (
        party_id, entry_type, entry_date, due_date, reference_no,
        source_table, source_id, signed_amount, note, created_by
      )
      VALUES (
        p_party_id, 'bill', v_bill_date, v_due_date, v_bill.bill_number,
        'bills', v_bill.id, v_grand,
        CASE WHEN p_doc_type = 'bill_of_supply' THEN 'Bill of Supply ' ELSE 'Tax Invoice ' END || v_bill.bill_number,
        auth.uid()
      )
      RETURNING * INTO v_bill_ledger;

      IF v_paid > 0 AND public.is_module_enabled('payments') THEN
        PERFORM public.post_payment(
          p_party_id, 'receive', v_paid, v_mode, v_bill_date,
          COALESCE(v_pay_ref, v_bill.bill_number), 'Payment on Bill ' || v_bill.bill_number,
          jsonb_build_array(jsonb_build_object('ledger_entry_id', v_bill_ledger.id, 'amount', v_paid)),
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
    auth.uid(), v_actor_email, 'bill.issued', 'bill', v_bill.id::text,
    jsonb_build_object('bill_number', v_bill.bill_number, 'doc_type', v_bill.doc_type, 'grand_total', v_bill.grand_total, 'payment_mode', v_mode)
  );

  SELECT * INTO v_bill FROM public.bills WHERE id = v_bill.id;
  RETURN v_bill;
END;
$$;

-- Update convert_quotation_to_bill to propagate batch_id, variant_id, site_id, job_id, line_meta
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found.'; END IF;
  IF v_quote.doc_type <> 'quotation' THEN RAISE EXCEPTION 'Only quotations can be converted.'; END IF;
  IF v_quote.status <> 'issued' THEN RAISE EXCEPTION 'Only open issued quotations can be converted.'; END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;
  v_target_type := COALESCE(NULLIF(trim(COALESCE(p_doc_type, '')), ''), CASE WHEN v_biz.gst_registered THEN 'tax_invoice' ELSE 'bill_of_supply' END);

  SELECT jsonb_agg(jsonb_build_object(
    'item_id', bl.item_id,
    'entered_qty', bl.entered_qty,
    'entered_unit_id', bl.entered_unit_id,
    'unit_price', bl.unit_price,
    'discount_pct', bl.discount_pct,
    'tax_inclusive', bl.tax_inclusive,
    'batch_id', bl.batch_id,
    'variant_id', bl.variant_id,
    'line_meta', bl.line_meta
  ) ORDER BY bl.line_no ASC)
  INTO v_lines
  FROM public.bill_lines bl
  WHERE bl.bill_id = p_quotation_id;

  v_new_bill := public.issue_bill(
    NULL, v_target_type, v_quote.party_id, COALESCE(p_bill_date, CURRENT_DATE), p_due_date, NULL,
    v_quote.place_of_supply_state_code, v_quote.extra_charges, v_quote.auto_round_off,
    v_quote.notes, v_quote.terms, v_lines, p_paid_amount, p_payment_mode, p_payment_reference,
    v_idemp, v_quote.site_id, v_quote.job_id, NULL
  );

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);
  UPDATE public.bills SET status = 'converted', converted_to_bill_id = v_new_bill.id WHERE id = p_quotation_id;
  UPDATE public.bills SET converted_from_quotation_id = p_quotation_id WHERE id = v_new_bill.id;
  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'quotation.converted', 'bill', p_quotation_id::text,
    jsonb_build_object('quotation_number', v_quote.bill_number, 'bill_id', v_new_bill.id, 'bill_number', v_new_bill.bill_number)
  );

  SELECT * INTO v_new_bill FROM public.bills WHERE id = v_new_bill.id;
  RETURN v_new_bill;
END;
$$;

-- Sales Return: preserve batch/variant restore & skip stock_ledger for service items
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
  v_item_type text := 'goods';
  v_ret_qty numeric(15,3);
  v_already_ret numeric(15,3);
  v_rem_qty numeric(15,3);
  v_base_qty numeric(15,3);
  v_base_allow_decimal boolean;
  v_prep_lines jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_cn_number text;
  v_cn public.bills;
  v_grand numeric(15,2);
  v_refund numeric(15,2);
  v_refund_mode text;
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

  v_refund_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_refund_mode, ''))), ''), 'cash');
  IF v_refund_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid refund payment mode: %.', v_refund_mode;
  END IF;

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('sales_return:' || v_idemp));
    SELECT * INTO v_existing FROM public.bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_source FROM public.bills WHERE id = p_source_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source invoice not found.'; END IF;
  IF v_source.status <> 'issued' OR v_source.doc_type NOT IN ('tax_invoice', 'bill_of_supply') THEN
    RAISE EXCEPTION 'Sales returns are only allowed against issued invoices.';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Select at least one item line to return.';
  END IF;

  FOR v_req IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_src_line FROM public.bill_lines
    WHERE id = (v_req->>'source_bill_line_id')::uuid AND bill_id = p_source_bill_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Referenced bill line does not belong to source invoice.'; END IF;

    v_ret_qty := round(COALESCE((v_req->>'entered_qty')::numeric, 0), 3);
    IF v_ret_qty <= 0 THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(bl.entered_qty), 0)::numeric(15,3)
    INTO v_already_ret
    FROM public.bill_lines bl JOIN public.bills b ON b.id = bl.bill_id
    WHERE bl.source_bill_line_id = v_src_line.id AND b.doc_type = 'credit_note' AND b.status <> 'voided';

    v_rem_qty := round((v_src_line.entered_qty - v_already_ret)::numeric, 3);
    IF v_ret_qty > v_rem_qty THEN
      RAISE EXCEPTION 'Return quantity for "%" exceeds returnable quantity (% %).', v_src_line.item_name, v_rem_qty, v_src_line.entered_unit_code;
    END IF;

    v_base_qty := round((v_ret_qty * v_src_line.conversion_factor)::numeric, 3);
    v_item_type := 'goods';
    IF v_src_line.item_id IS NOT NULL THEN
      SELECT i.item_type, u.allow_decimal INTO v_item_type, v_base_allow_decimal
      FROM public.items i JOIN public.item_units u ON u.id = i.base_unit_id WHERE i.id = v_src_line.item_id;
      IF FOUND AND NOT COALESCE(v_base_allow_decimal, true) AND v_base_qty <> trunc(v_base_qty) THEN
        RAISE EXCEPTION 'Base unit for "%" does not allow fractional return quantities.', v_src_line.item_name;
      END IF;
    END IF;

    v_prep_lines := v_prep_lines || jsonb_build_array(jsonb_build_object(
      'source_bill_line_id', v_src_line.id, 'item_id', v_src_line.item_id, 'item_type', COALESCE(v_item_type, 'goods'),
      'item_name', v_src_line.item_name, 'sku', v_src_line.sku, 'hsn_code', v_src_line.hsn_code,
      'entered_qty', v_ret_qty, 'entered_unit_id', v_src_line.entered_unit_id,
      'entered_unit_code', v_src_line.entered_unit_code, 'conversion_factor', v_src_line.conversion_factor,
      'base_qty', v_base_qty, 'catalog_unit_price', v_src_line.catalog_unit_price,
      'unit_price', v_src_line.unit_price, 'discount_pct', v_src_line.discount_pct,
      'tax_inclusive', v_src_line.tax_inclusive, 'gst_rate', v_src_line.gst_rate,
      'batch_id', v_src_line.batch_id, 'batch_no', v_src_line.batch_no, 'expiry_date', v_src_line.expiry_date,
      'mrp', v_src_line.mrp, 'variant_id', v_src_line.variant_id, 'variant_label', v_src_line.variant_label
    ));
  END LOOP;

  IF jsonb_array_length(v_prep_lines) = 0 THEN
    RAISE EXCEPTION 'Enter a positive return quantity for at least one item.';
  END IF;

  v_calc := public.compute_bill_amounts(
    v_source.gst_applied,
    CASE WHEN v_source.doc_type = 'bill_of_supply' THEN 'bill_of_supply' ELSE 'credit_note' END,
    v_source.is_interstate, 0, v_source.auto_round_off, v_prep_lines
  );
  v_grand := (v_calc->>'grand_total')::numeric(15,2);
  v_refund := round(COALESCE(p_refund_amount, 0)::numeric, 2);
  IF v_refund < 0 OR v_refund > v_grand THEN
    RAISE EXCEPTION 'Refund amount must be between ₹0 and Credit Note total (₹%).', v_grand;
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
    paid_amount, credited_amount, balance_due, payment_mode,
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
    v_refund, 0, 0, v_refund_mode,
    v_clean_reason, 'Return against ' || v_source.bill_number || ': ' || v_clean_reason, v_source.terms,
    v_source.business_snapshot, v_idemp, now(), auth.uid(), auth.uid()
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
      igst_amount, tax_amount, line_total, batch_id, batch_no, expiry_date, mrp, variant_id, variant_label
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
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'batch_id', '')::uuid, NULLIF(v_pl->>'batch_no', ''),
      NULLIF(v_pl->>'expiry_date', '')::date, NULLIF(v_pl->>'mrp', '')::numeric,
      NULLIF(v_pl->>'variant_id', '')::uuid, NULLIF(v_pl->>'variant_label', '')
    );

    IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
      IF NULLIF(v_pl->>'batch_id', '') IS NOT NULL THEN
        UPDATE public.item_batches SET qty_on_hand = qty_on_hand + (v_pl->>'base_qty')::numeric
        WHERE id = (v_pl->>'batch_id')::uuid;
      END IF;
      IF NULLIF(v_pl->>'variant_id', '') IS NOT NULL THEN
        UPDATE public.item_variants SET qty_on_hand = qty_on_hand + (v_pl->>'base_qty')::numeric
        WHERE id = (v_pl->>'variant_id')::uuid;
      END IF;

      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, batch_id, variant_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, 'sale_return', v_return_date,
        (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric, (v_pl->>'base_qty')::numeric,
        (SELECT purchase_price FROM public.items WHERE id = (v_pl->>'item_id')::uuid),
        'Sales Return ' || v_cn.bill_number || ' (' || v_clean_reason || ')',
        v_cn.bill_number, 'bills', v_cn.id,
        NULLIF(v_pl->>'batch_id', '')::uuid, NULLIF(v_pl->>'variant_id', '')::uuid, auth.uid()
      );
    END IF;
  END LOOP;

  PERFORM set_config('app.bill_line_init', '', true);

  v_new_credited := round((v_source.credited_amount + v_credit_applied)::numeric, 2);
  v_new_balance := GREATEST(round((v_source.grand_total - v_source.paid_amount - v_new_credited)::numeric, 2), 0);
  UPDATE public.bills SET credited_amount = v_new_credited, balance_due = v_new_balance WHERE id = v_source.id;

  IF v_source.party_id IS NOT NULL AND public.is_module_enabled('parties') AND v_grand > 0 THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, reference_no, source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      v_source.party_id, 'sales_return', v_return_date, v_cn.bill_number, 'bills', v_cn.id,
      -v_grand, 'Credit Note ' || v_cn.bill_number || ' against ' || v_source.bill_number, auth.uid()
    );

    IF v_refund > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        v_source.party_id, 'give', v_refund, v_refund_mode, v_return_date,
        v_cn.bill_number, 'Refund for Credit Note ' || v_cn.bill_number, NULL, false,
        CASE WHEN v_idemp IS NOT NULL THEN 'cn_ref:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.bill_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'bill.sales_return', 'bill', v_cn.id::text,
    jsonb_build_object('credit_note_number', v_cn.bill_number, 'source_bill_id', v_source.id, 'grand_total', v_grand)
  );

  RETURN v_cn;
END;
$$;

-- Void Bill: restore batch/variant qty & skip stock_ledger for services
CREATE OR REPLACE FUNCTION public.void_bill(
  p_bill_id uuid,
  p_reason text DEFAULT ''
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found.'; END IF;
  IF v_bill.status <> 'issued' THEN RAISE EXCEPTION 'Only issued documents can be voided.'; END IF;
  IF v_bill.doc_type = 'credit_note' THEN RAISE EXCEPTION 'Credit notes cannot be voided directly.'; END IF;
  IF EXISTS (SELECT 1 FROM public.bills c WHERE c.source_bill_id = p_bill_id AND c.doc_type = 'credit_note' AND c.status <> 'voided') THEN
    RAISE EXCEPTION 'Cannot void a bill that has active credit notes / sales returns.';
  END IF;
  IF v_bill.party_id IS NOT NULL AND v_bill.paid_amount > 0 THEN
    RAISE EXCEPTION 'This bill has allocated payments (₹%). Reverse the linked payment(s) first before voiding.', v_bill.paid_amount;
  END IF;

  IF v_bill.doc_type IN ('tax_invoice', 'bill_of_supply') THEN
    FOR v_line IN
      SELECT bl.*, COALESCE(i.item_type, 'goods') AS item_type, i.purchase_price
      FROM public.bill_lines bl
      LEFT JOIN public.items i ON i.id = bl.item_id
      WHERE bl.bill_id = p_bill_id
      ORDER BY bl.line_no
    LOOP
      IF v_line.item_type = 'goods' THEN
        IF v_line.batch_id IS NOT NULL THEN
          UPDATE public.item_batches SET qty_on_hand = qty_on_hand + v_line.base_qty WHERE id = v_line.batch_id;
        END IF;
        IF v_line.variant_id IS NOT NULL THEN
          UPDATE public.item_variants SET qty_on_hand = qty_on_hand + v_line.base_qty WHERE id = v_line.variant_id;
        END IF;

        INSERT INTO public.stock_ledger (
          item_id, movement_type, movement_date, entered_qty, entered_unit_id,
          conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
          source_table, source_id, batch_id, variant_id, created_by
        )
        VALUES (
          v_line.item_id, 'adjustment_in', CURRENT_DATE,
          v_line.entered_qty, v_line.entered_unit_id, v_line.conversion_factor,
          v_line.base_qty, v_line.purchase_price,
          'Voided ' || v_bill.bill_number || ': ' || v_clean_reason,
          v_bill.bill_number || '-VOID', 'bills', v_bill.id,
          v_line.batch_id, v_line.variant_id, auth.uid()
        );
      END IF;
    END LOOP;
  END IF;

  PERFORM set_config('app.bill_rpc_context', txid_current()::text, true);

  UPDATE public.bills
  SET status = 'voided', void_reason = v_clean_reason, voided_at = now(), voided_by = auth.uid(), balance_due = 0
  WHERE id = p_bill_id
  RETURNING * INTO v_updated;

  -- Mark linked warranty records expired/void if needed
  DELETE FROM public.schedule_register WHERE bill_id = p_bill_id;
  UPDATE public.warranty_records SET status = 'expired', claim_notes = COALESCE(claim_notes || ' · ', '') || 'Bill voided' WHERE bill_id = p_bill_id;

  PERFORM set_config('app.bill_rpc_context', '', true);

  IF v_bill.party_id IS NOT NULL AND v_bill.doc_type IN ('tax_invoice', 'bill_of_supply') THEN
    SELECT * INTO v_orig_le FROM public.party_ledger_entries
    WHERE source_table = 'bills' AND source_id = p_bill_id AND entry_type = 'bill' AND is_reversed = false LIMIT 1;

    IF FOUND THEN
      INSERT INTO public.party_ledger_entries (
        party_id, entry_type, entry_date, reference_no, source_table, source_id, signed_amount, note, created_by
      )
      VALUES (
        v_bill.party_id, 'adjustment', CURRENT_DATE, v_bill.bill_number || '-VOID',
        'bills', p_bill_id, -v_orig_le.signed_amount,
        'Voided bill ' || v_bill.bill_number || ': ' || v_clean_reason, auth.uid()
      )
      RETURNING * INTO v_rev_le;

      UPDATE public.party_ledger_entries SET is_reversed = true, reversed_by_entry_id = v_rev_le.id WHERE id = v_orig_le.id;
    END IF;
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (auth.uid(), v_actor_email, 'bill.voided', 'bill', p_bill_id::text, jsonb_build_object('bill_number', v_bill.bill_number, 'reason', v_clean_reason));

  RETURN v_updated;
END;
$$;

-- ============================================================================
-- 6. Pack-Aware Purchase RPCs (Batch Auto-Creation + Variant Qty Increment)
-- ============================================================================
CREATE OR REPLACE FUNCTION public._prepare_purchase_payload(
  p_party_id uuid DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_gst_applied boolean DEFAULT false,
  p_freight_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_lines jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_biz public.business;
  v_party public.parties;
  v_party_addr text;
  v_pos text;
  v_effective_gst boolean;
  v_is_interstate boolean := false;
  v_raw jsonb;
  v_item public.items;
  v_unit_id uuid;
  v_unit_code text;
  v_qty numeric(15,3);
  v_base_qty numeric(15,3);
  v_factor numeric(18,6);
  v_unit_cost numeric(15,2);
  v_disc_pct numeric(5,2);
  v_tax_incl boolean;
  v_gst_rate numeric(5,2);
  v_prepared_lines jsonb := '[]'::jsonb;
  v_calc_input_lines jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_variant public.item_variants;
  v_variant_id uuid;
  v_variant_label text;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one purchase item line.';
  END IF;

  SELECT * INTO v_biz FROM public.business WHERE id = 1;

  IF p_party_id IS NOT NULL THEN
    SELECT * INTO v_party FROM public.parties WHERE id = p_party_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected supplier was not found.'; END IF;
    IF NOT v_party.is_active THEN RAISE EXCEPTION 'Cannot record purchase for an archived supplier.'; END IF;
    SELECT concat_ws(', ', NULLIF(address_line1, ''), NULLIF(city, ''), NULLIF(state, ''), NULLIF(pincode, '')),
           COALESCE(NULLIF(upper(trim(p_place_of_supply)), ''), NULLIF(upper(trim(state_code)), ''))
    INTO v_party_addr, v_pos
    FROM public.party_addresses WHERE party_id = p_party_id ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  v_pos := COALESCE(NULLIF(upper(trim(COALESCE(p_place_of_supply, ''))), ''), v_pos, v_biz.state_code);
  v_effective_gst := COALESCE(p_gst_applied, false) AND public.is_module_enabled('tax');
  IF v_effective_gst AND v_biz.state_code IS NOT NULL AND v_pos IS NOT NULL AND v_biz.state_code <> v_pos THEN
    v_is_interstate := true;
  END IF;

  FOR v_raw IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    SELECT * INTO v_item FROM public.items WHERE id = (v_raw->>'item_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected item was not found.'; END IF;
    IF NOT v_item.is_active THEN RAISE EXCEPTION 'Item "%" is archived and cannot be purchased.', v_item.name; END IF;

    v_unit_id := COALESCE(NULLIF(v_raw->>'entered_unit_id', '')::uuid, v_item.base_unit_id);
    v_qty := COALESCE((v_raw->>'entered_qty')::numeric, 0);
    SELECT c.base_qty, c.conversion_factor INTO v_base_qty, v_factor
    FROM public.convert_item_qty(v_item.id, v_qty, v_unit_id) c;
    SELECT code INTO v_unit_code FROM public.item_units WHERE id = v_unit_id;

    v_unit_cost := round(GREATEST(0::numeric, COALESCE((v_raw->>'unit_cost')::numeric, COALESCE(v_item.purchase_price, 0), 0)), 2);
    v_disc_pct := LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'discount_pct')::numeric, 0), 2)));
    v_tax_incl := COALESCE((v_raw->>'tax_inclusive')::boolean, false);
    v_gst_rate := CASE WHEN v_effective_gst THEN LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_raw->>'gst_rate')::numeric, v_item.gst_rate, 0), 2))) ELSE 0::numeric END;

    v_variant_id := NULLIF(trim(COALESCE(v_raw->>'variant_id', '')), '')::uuid;
    v_variant_label := NULL;
    IF v_variant_id IS NOT NULL THEN
      SELECT * INTO v_variant FROM public.item_variants WHERE id = v_variant_id AND item_id = v_item.id;
      IF FOUND THEN
        v_variant_label := v_variant.size || CASE WHEN COALESCE(v_variant.color, 'Default') <> 'Default' THEN ' / ' || v_variant.color ELSE '' END;
      END IF;
    END IF;

    v_prepared_lines := v_prepared_lines || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'item_type', v_item.item_type,
      'item_name', v_item.name,
      'sku', COALESCE(v_variant.sku, v_item.sku),
      'hsn_code', v_item.hsn_code,
      'entered_qty', round(v_qty, 3),
      'entered_unit_id', v_unit_id,
      'entered_unit_code', v_unit_code,
      'conversion_factor', v_factor,
      'base_qty', v_base_qty,
      'unit_cost', v_unit_cost,
      'discount_pct', v_disc_pct,
      'tax_inclusive', v_tax_incl,
      'gst_rate', v_gst_rate,
      'batch_no', NULLIF(upper(trim(COALESCE(v_raw->>'batch_no', ''))), ''),
      'mfg_date', NULLIF(trim(COALESCE(v_raw->>'mfg_date', '')), '')::date,
      'expiry_date', NULLIF(trim(COALESCE(v_raw->>'expiry_date', '')), '')::date,
      'mrp', NULLIF(trim(COALESCE(v_raw->>'mrp', '')), '')::numeric,
      'selling_rate', NULLIF(trim(COALESCE(v_raw->>'selling_rate', '')), '')::numeric,
      'variant_id', v_variant_id,
      'variant_label', v_variant_label,
      'line_meta', COALESCE(v_raw->'line_meta', '{}'::jsonb)
    ));

    v_calc_input_lines := v_calc_input_lines || jsonb_build_array(jsonb_build_object(
      'entered_qty', round(v_qty, 3), 'unit_price', v_unit_cost,
      'discount_pct', v_disc_pct, 'tax_inclusive', v_tax_incl, 'gst_rate', v_gst_rate
    ));
  END LOOP;

  v_calc := public.compute_bill_amounts(
    v_effective_gst, CASE WHEN v_effective_gst THEN 'tax_invoice' ELSE 'bill_of_supply' END,
    v_is_interstate, COALESCE(p_freight_charges, 0), COALESCE(p_auto_round_off, true), v_calc_input_lines
  );

  RETURN jsonb_build_object(
    'party_name', COALESCE(v_party.name, 'Cash Supplier'),
    'party_phone', v_party.phone, 'party_gstin', v_party.gstin,
    'party_address', v_party_addr, 'place_of_supply_state_code', v_pos,
    'effective_gst', v_effective_gst, 'is_interstate', (v_calc->>'is_interstate')::boolean,
    'prepared_lines', v_prepared_lines, 'calc', v_calc
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_purchase_draft(
  p_id uuid DEFAULT NULL,
  p_party_id uuid DEFAULT NULL,
  p_supplier_invoice_no text DEFAULT NULL,
  p_supplier_invoice_date date DEFAULT NULL,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_gst_applied boolean DEFAULT false,
  p_freight_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_update_item_cost boolean DEFAULT false,
  p_notes text DEFAULT NULL,
  p_attachment_file_id uuid DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb
)
RETURNS public.purchase_bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_prep jsonb;
  v_calc jsonb;
  v_pb public.purchase_bills;
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
BEGIN
  PERFORM public.require_module('purchases');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to save purchase drafts.';
  END IF;
  IF p_attachment_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_attachment_file_id) THEN
    RAISE EXCEPTION 'Attached file not found.';
  END IF;

  v_prep := public._prepare_purchase_payload(p_party_id, p_place_of_supply, p_gst_applied, p_freight_charges, p_auto_round_off, p_lines);
  v_calc := v_prep->'calc';

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_pb FROM public.purchase_bills WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase draft not found.'; END IF;
    IF v_pb.status <> 'draft' THEN RAISE EXCEPTION 'Only draft purchases can be edited.'; END IF;
    DELETE FROM public.purchase_lines WHERE purchase_id = p_id;
    UPDATE public.purchase_bills
    SET party_id = p_party_id, party_name = v_prep->>'party_name', party_phone = v_prep->>'party_phone',
        party_gstin = v_prep->>'party_gstin', party_address = v_prep->>'party_address',
        supplier_invoice_no = NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''),
        supplier_invoice_date = p_supplier_invoice_date,
        bill_date = COALESCE(p_bill_date, CURRENT_DATE), due_date = p_due_date,
        place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
        is_interstate = (v_prep->>'is_interstate')::boolean,
        gst_applied = (v_prep->>'effective_gst')::boolean,
        subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric,
        discount_total = (v_calc->>'discount_total')::numeric,
        cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
        igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
        freight_charges = (v_calc->>'extra_charges')::numeric, auto_round_off = COALESCE(p_auto_round_off, true),
        round_off = (v_calc->>'round_off')::numeric, grand_total = (v_calc->>'grand_total')::numeric,
        paid_amount = 0, credited_amount = 0, balance_due = (v_calc->>'grand_total')::numeric,
        attachment_file_id = p_attachment_file_id, update_item_cost = COALESCE(p_update_item_cost, false),
        notes = NULLIF(trim(COALESCE(p_notes, '')), '')
    WHERE id = p_id RETURNING * INTO v_pb;
  ELSE
    INSERT INTO public.purchase_bills (
      doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      supplier_invoice_no, supplier_invoice_date, bill_date, due_date,
      place_of_supply_state_code, is_interstate, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total,
      tax_total, freight_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due,
      attachment_file_id, update_item_cost, notes, created_by
    )
    VALUES (
      'purchase_bill', 'draft', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address',
      NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''), p_supplier_invoice_date,
      COALESCE(p_bill_date, CURRENT_DATE), p_due_date, v_prep->>'place_of_supply_state_code',
      (v_prep->>'is_interstate')::boolean, (v_prep->>'effective_gst')::boolean,
      (v_calc->>'subtotal_taxable')::numeric, (v_calc->>'discount_total')::numeric,
      (v_calc->>'cgst_total')::numeric, (v_calc->>'sgst_total')::numeric,
      (v_calc->>'igst_total')::numeric, (v_calc->>'tax_total')::numeric,
      (v_calc->>'extra_charges')::numeric, COALESCE(p_auto_round_off, true),
      (v_calc->>'round_off')::numeric, (v_calc->>'grand_total')::numeric,
      0, 0, (v_calc->>'grand_total')::numeric,
      p_attachment_file_id, COALESCE(p_update_item_cost, false),
      NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid()
    )
    RETURNING * INTO v_pb;
  END IF;

  FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1)
  LOOP
    v_pl := (v_prep->'prepared_lines')->v_i;
    v_cl := (v_calc->'lines')->v_i;
    INSERT INTO public.purchase_lines (
      purchase_id, line_no, item_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total,
      batch_no, mfg_date, expiry_date, mrp, selling_rate, variant_id, variant_label, line_meta
    )
    VALUES (
      v_pb.id, v_i + 1, (v_pl->>'item_id')::uuid, v_pl->>'item_name',
      NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'unit_cost')::numeric,
      (v_pl->>'discount_pct')::numeric, (v_pl->>'tax_inclusive')::boolean,
      (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      NULLIF(v_pl->>'batch_no', ''), NULLIF(v_pl->>'mfg_date', '')::date,
      NULLIF(v_pl->>'expiry_date', '')::date, NULLIF(v_pl->>'mrp', '')::numeric,
      NULLIF(v_pl->>'selling_rate', '')::numeric, NULLIF(v_pl->>'variant_id', '')::uuid,
      NULLIF(v_pl->>'variant_label', ''), COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );
  END LOOP;

  RETURN v_pb;
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_purchase(
  p_draft_id uuid DEFAULT NULL,
  p_party_id uuid DEFAULT NULL,
  p_supplier_invoice_no text DEFAULT NULL,
  p_supplier_invoice_date date DEFAULT NULL,
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_place_of_supply text DEFAULT NULL,
  p_gst_applied boolean DEFAULT false,
  p_freight_charges numeric DEFAULT 0,
  p_auto_round_off boolean DEFAULT true,
  p_update_item_cost boolean DEFAULT false,
  p_notes text DEFAULT NULL,
  p_attachment_file_id uuid DEFAULT NULL,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_paid_amount numeric DEFAULT 0,
  p_payment_mode text DEFAULT 'cash',
  p_payment_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS public.purchase_bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_idemp text;
  v_existing public.purchase_bills;
  v_mode text;
  v_pay_ref text;
  v_bill_date date;
  v_due_date date;
  v_party_credit_days integer := 0;
  v_prep jsonb;
  v_calc jsonb;
  v_grand numeric(15,2);
  v_paid numeric(15,2);
  v_balance numeric(15,2);
  v_pur_no text;
  v_pb public.purchase_bills;
  v_i integer;
  v_pl jsonb;
  v_cl jsonb;
  v_base_unit_cost numeric(15,2);
  v_pur_ledger public.party_ledger_entries;
  v_actor_email text;
  v_batch_id uuid;
  v_variant_id uuid;
BEGIN
  PERFORM public.require_module('purchases');
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper', 'accountant') THEN
    RAISE EXCEPTION 'You do not have permission to post purchases.';
  END IF;

  v_mode := COALESCE(NULLIF(lower(trim(COALESCE(p_payment_mode, ''))), ''), 'cash');
  IF v_mode NOT IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other') THEN
    RAISE EXCEPTION 'Invalid payment mode.';
  END IF;
  v_pay_ref := NULLIF(trim(COALESCE(p_payment_reference, '')), '');

  v_idemp := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');
  IF v_idemp IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('purchase_issue:' || v_idemp));
    SELECT * INTO v_existing FROM public.purchase_bills WHERE idempotency_key = v_idemp;
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  IF p_attachment_file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.files WHERE id = p_attachment_file_id) THEN
    RAISE EXCEPTION 'Attached file not found.';
  END IF;

  v_bill_date := COALESCE(p_bill_date, CURRENT_DATE);
  IF p_party_id IS NOT NULL THEN
    SELECT credit_days INTO v_party_credit_days FROM public.parties WHERE id = p_party_id;
    v_due_date := COALESCE(p_due_date, CASE WHEN COALESCE(v_party_credit_days, 0) > 0 THEN v_bill_date + v_party_credit_days ELSE NULL END);
  ELSE
    v_due_date := p_due_date;
  END IF;

  v_prep := public._prepare_purchase_payload(p_party_id, p_place_of_supply, p_gst_applied, p_freight_charges, p_auto_round_off, p_lines);
  v_calc := v_prep->'calc';
  v_grand := (v_calc->>'grand_total')::numeric(15,2);
  v_paid := round(COALESCE(p_paid_amount, 0)::numeric, 2);

  IF v_paid < 0 THEN RAISE EXCEPTION 'Paid amount cannot be negative.'; END IF;
  IF v_paid > v_grand THEN RAISE EXCEPTION 'Paid amount exceeds purchase grand total.'; END IF;
  IF p_party_id IS NULL AND v_paid < v_grand THEN RAISE EXCEPTION 'Walk-in cash purchases must be paid in full.'; END IF;
  IF p_party_id IS NOT NULL AND v_paid > 0 AND v_role = 'storekeeper' THEN
    RAISE EXCEPTION 'Storekeeper cannot post payment cashouts. Set Paid Now to ₹0.';
  END IF;

  v_balance := round((v_grand - v_paid)::numeric, 2);
  v_pur_no := public.next_document_number('purchase_bill', v_bill_date);

  PERFORM set_config('app.purchase_rpc_context', txid_current()::text, true);
  PERFORM set_config('app.purchase_line_init', txid_current()::text, true);

  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.purchase_bills WHERE id = p_draft_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase draft not found.'; END IF;
    IF v_existing.status <> 'draft' THEN RAISE EXCEPTION 'This purchase bill has already been posted.'; END IF;
    DELETE FROM public.purchase_lines WHERE purchase_id = p_draft_id;
    UPDATE public.purchase_bills
    SET
      purchase_number = v_pur_no, doc_type = 'purchase_bill', status = 'posted',
      party_id = p_party_id, party_name = v_prep->>'party_name', party_phone = v_prep->>'party_phone',
      party_gstin = v_prep->>'party_gstin', party_address = v_prep->>'party_address',
      supplier_invoice_no = NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''),
      supplier_invoice_date = p_supplier_invoice_date,
      bill_date = v_bill_date, due_date = v_due_date,
      place_of_supply_state_code = v_prep->>'place_of_supply_state_code',
      is_interstate = (v_prep->>'is_interstate')::boolean, gst_applied = (v_prep->>'effective_gst')::boolean,
      subtotal_taxable = (v_calc->>'subtotal_taxable')::numeric, discount_total = (v_calc->>'discount_total')::numeric,
      cgst_total = (v_calc->>'cgst_total')::numeric, sgst_total = (v_calc->>'sgst_total')::numeric,
      igst_total = (v_calc->>'igst_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric,
      freight_charges = (v_calc->>'extra_charges')::numeric, auto_round_off = COALESCE(p_auto_round_off, true),
      round_off = (v_calc->>'round_off')::numeric, grand_total = v_grand, paid_amount = v_paid,
      credited_amount = 0, balance_due = v_balance, payment_mode = v_mode, payment_reference = v_pay_ref,
      attachment_file_id = p_attachment_file_id, update_item_cost = COALESCE(p_update_item_cost, false),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''), idempotency_key = v_idemp,
      posted_at = now(), posted_by = auth.uid()
    WHERE id = p_draft_id RETURNING * INTO v_pb;
  ELSE
    INSERT INTO public.purchase_bills (
      purchase_number, doc_type, status, party_id, party_name, party_phone, party_gstin, party_address,
      supplier_invoice_no, supplier_invoice_date, bill_date, due_date,
      place_of_supply_state_code, is_interstate, gst_applied,
      subtotal_taxable, discount_total, cgst_total, sgst_total, igst_total,
      tax_total, freight_charges, auto_round_off, round_off, grand_total,
      paid_amount, credited_amount, balance_due, payment_mode, payment_reference,
      attachment_file_id, update_item_cost, notes, idempotency_key, posted_at, posted_by, created_by
    )
    VALUES (
      v_pur_no, 'purchase_bill', 'posted', p_party_id, v_prep->>'party_name', v_prep->>'party_phone',
      v_prep->>'party_gstin', v_prep->>'party_address',
      NULLIF(trim(COALESCE(p_supplier_invoice_no, '')), ''), p_supplier_invoice_date,
      v_bill_date, v_due_date, v_prep->>'place_of_supply_state_code', (v_prep->>'is_interstate')::boolean,
      (v_prep->>'effective_gst')::boolean, (v_calc->>'subtotal_taxable')::numeric,
      (v_calc->>'discount_total')::numeric, (v_calc->>'cgst_total')::numeric,
      (v_calc->>'sgst_total')::numeric, (v_calc->>'igst_total')::numeric,
      (v_calc->>'tax_total')::numeric, (v_calc->>'extra_charges')::numeric,
      COALESCE(p_auto_round_off, true), (v_calc->>'round_off')::numeric, v_grand,
      v_paid, 0, v_balance, v_mode, v_pay_ref, p_attachment_file_id, COALESCE(p_update_item_cost, false),
      NULLIF(trim(COALESCE(p_notes, '')), ''), v_idemp, now(), auth.uid(), auth.uid()
    )
    RETURNING * INTO v_pb;
  END IF;

  IF p_attachment_file_id IS NOT NULL THEN
    INSERT INTO public.file_links (file_id, entity_type, entity_id)
    VALUES (p_attachment_file_id, 'purchase_bill', v_pb.id) ON CONFLICT DO NOTHING;
  END IF;

  FOR v_i IN 0..(jsonb_array_length(v_prep->'prepared_lines') - 1)
  LOOP
    v_pl := (v_prep->'prepared_lines')->v_i;
    v_cl := (v_calc->'lines')->v_i;
    v_batch_id := NULL;
    v_variant_id := NULLIF(v_pl->>'variant_id', '')::uuid;

    v_base_unit_cost := CASE
      WHEN (v_pl->>'base_qty')::numeric > 0
        THEN round(((v_cl->>'taxable_amount')::numeric / (v_pl->>'base_qty')::numeric), 2)
      ELSE 0
    END;

    -- Auto-upsert Batch when batch_no & expiry_date are entered on a goods purchase
    IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' AND NULLIF(v_pl->>'batch_no', '') IS NOT NULL AND NULLIF(v_pl->>'expiry_date', '') IS NOT NULL THEN
      INSERT INTO public.item_batches (
        item_id, batch_no, mfg_date, expiry_date, mrp, purchase_rate, selling_rate, qty_on_hand, source_purchase_id
      )
      VALUES (
        (v_pl->>'item_id')::uuid,
        v_pl->>'batch_no',
        NULLIF(v_pl->>'mfg_date', '')::date,
        (v_pl->>'expiry_date')::date,
        NULLIF(v_pl->>'mrp', '')::numeric,
        v_base_unit_cost,
        NULLIF(v_pl->>'selling_rate', '')::numeric,
        (v_pl->>'base_qty')::numeric,
        v_pb.id
      )
      ON CONFLICT (item_id, batch_no) DO UPDATE SET
        qty_on_hand = item_batches.qty_on_hand + EXCLUDED.qty_on_hand,
        expiry_date = EXCLUDED.expiry_date,
        mrp = COALESCE(EXCLUDED.mrp, item_batches.mrp),
        purchase_rate = COALESCE(EXCLUDED.purchase_rate, item_batches.purchase_rate),
        selling_rate = COALESCE(EXCLUDED.selling_rate, item_batches.selling_rate),
        is_active = true
      RETURNING id INTO v_batch_id;
    END IF;

    IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' AND v_variant_id IS NOT NULL THEN
      UPDATE public.item_variants SET qty_on_hand = qty_on_hand + (v_pl->>'base_qty')::numeric WHERE id = v_variant_id;
    END IF;

    INSERT INTO public.purchase_lines (
      purchase_id, line_no, item_id, item_name, sku, hsn_code,
      entered_qty, entered_unit_id, entered_unit_code, conversion_factor, base_qty,
      unit_cost, discount_pct, tax_inclusive, gst_rate,
      gross_amount, discount_amount, taxable_amount, cgst_amount, sgst_amount,
      igst_amount, tax_amount, line_total,
      batch_id, batch_no, mfg_date, expiry_date, mrp, selling_rate, variant_id, variant_label, line_meta
    )
    VALUES (
      v_pb.id, v_i + 1, (v_pl->>'item_id')::uuid, v_pl->>'item_name',
      NULLIF(v_pl->>'sku', ''), NULLIF(v_pl->>'hsn_code', ''),
      (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
      v_pl->>'entered_unit_code', (v_pl->>'conversion_factor')::numeric,
      (v_pl->>'base_qty')::numeric, (v_pl->>'unit_cost')::numeric,
      (v_pl->>'discount_pct')::numeric, (v_pl->>'tax_inclusive')::boolean,
      (v_cl->>'effective_gst_rate')::numeric,
      (v_cl->>'gross_amount')::numeric, (v_cl->>'discount_amount')::numeric,
      (v_cl->>'taxable_amount')::numeric, (v_cl->>'cgst_amount')::numeric,
      (v_cl->>'sgst_amount')::numeric, (v_cl->>'igst_amount')::numeric,
      (v_cl->>'tax_amount')::numeric, (v_cl->>'line_total')::numeric,
      v_batch_id, NULLIF(v_pl->>'batch_no', ''), NULLIF(v_pl->>'mfg_date', '')::date,
      NULLIF(v_pl->>'expiry_date', '')::date, NULLIF(v_pl->>'mrp', '')::numeric,
      NULLIF(v_pl->>'selling_rate', '')::numeric, v_variant_id, NULLIF(v_pl->>'variant_label', ''),
      COALESCE(v_pl->'line_meta', '{}'::jsonb)
    );

    IF COALESCE(v_pl->>'item_type', 'goods') = 'goods' THEN
      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, batch_id, variant_id, created_by
      )
      VALUES (
        (v_pl->>'item_id')::uuid, 'purchase', v_bill_date,
        (v_pl->>'entered_qty')::numeric, (v_pl->>'entered_unit_id')::uuid,
        (v_pl->>'conversion_factor')::numeric, (v_pl->>'base_qty')::numeric,
        v_base_unit_cost,
        'Purchase ' || v_pb.purchase_number || COALESCE(' (' || NULLIF(v_pb.supplier_invoice_no, '') || ')', ''),
        v_pb.purchase_number, 'purchase_bills', v_pb.id, v_batch_id, v_variant_id, auth.uid()
      );
    END IF;

    IF COALESCE(p_update_item_cost, false) AND v_base_unit_cost > 0 THEN
      UPDATE public.items SET purchase_price = v_base_unit_cost WHERE id = (v_pl->>'item_id')::uuid;
    END IF;
  END LOOP;

  PERFORM set_config('app.purchase_line_init', '', true);

  IF p_party_id IS NOT NULL AND public.is_module_enabled('parties') AND v_grand > 0 THEN
    INSERT INTO public.party_ledger_entries (
      party_id, entry_type, entry_date, due_date, reference_no,
      source_table, source_id, signed_amount, note, created_by
    )
    VALUES (
      p_party_id, 'purchase', v_bill_date, v_due_date, v_pb.purchase_number,
      'purchase_bills', v_pb.id, -v_grand,
      'Purchase Bill ' || v_pb.purchase_number || COALESCE(' · Inv ' || NULLIF(v_pb.supplier_invoice_no, ''), ''),
      auth.uid()
    )
    RETURNING * INTO v_pur_ledger;

    IF v_paid > 0 AND public.is_module_enabled('payments') THEN
      PERFORM public.post_payment(
        p_party_id, 'give', v_paid, v_mode, v_bill_date,
        COALESCE(v_pay_ref, v_pb.purchase_number), 'Payment for Purchase ' || v_pb.purchase_number,
        jsonb_build_array(jsonb_build_object('ledger_entry_id', v_pur_ledger.id, 'amount', v_paid)),
        false, CASE WHEN v_idemp IS NOT NULL THEN 'pur_pay:' || v_idemp ELSE NULL END
      );
    END IF;
  END IF;

  PERFORM set_config('app.purchase_rpc_context', '', true);

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email, 'purchase.posted', 'purchase_bill', v_pb.id::text,
    jsonb_build_object('purchase_number', v_pb.purchase_number, 'grand_total', v_pb.grand_total)
  );

  SELECT * INTO v_pb FROM public.purchase_bills WHERE id = v_pb.id;
  RETURN v_pb;
END;
$$;

-- ============================================================================
-- 7. Dedicated Pack Workflow RPCs
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_item_batch(
  p_item_id uuid,
  p_batch_no text,
  p_expiry_date date,
  p_mfg_date date DEFAULT NULL,
  p_mrp numeric DEFAULT NULL,
  p_purchase_rate numeric DEFAULT NULL,
  p_selling_rate numeric DEFAULT NULL,
  p_qty_delta numeric DEFAULT 0,
  p_batch_id uuid DEFAULT NULL,
  p_is_active boolean DEFAULT true
)
RETURNS public.item_batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_clean_batch text := upper(trim(COALESCE(p_batch_no, '')));
  v_row public.item_batches;
  v_item public.items;
BEGIN
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can manage item batches.';
  END IF;
  IF length(v_clean_batch) < 1 THEN RAISE EXCEPTION 'Batch number is required.'; END IF;
  IF p_expiry_date IS NULL THEN RAISE EXCEPTION 'Expiry date is required.'; END IF;

  SELECT * INTO v_item FROM public.items WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found.'; END IF;

  IF p_batch_id IS NOT NULL THEN
    UPDATE public.item_batches
    SET batch_no = v_clean_batch, mfg_date = p_mfg_date, expiry_date = p_expiry_date,
        mrp = p_mrp, purchase_rate = COALESCE(p_purchase_rate, purchase_rate),
        selling_rate = COALESCE(p_selling_rate, selling_rate),
        qty_on_hand = GREATEST(0, qty_on_hand + COALESCE(p_qty_delta, 0)),
        is_active = COALESCE(p_is_active, true)
    WHERE id = p_batch_id AND item_id = p_item_id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.item_batches (
      item_id, batch_no, mfg_date, expiry_date, mrp, purchase_rate, selling_rate, qty_on_hand, is_active
    )
    VALUES (
      p_item_id, v_clean_batch, p_mfg_date, p_expiry_date, p_mrp, p_purchase_rate, p_selling_rate,
      GREATEST(0, COALESCE(p_qty_delta, 0)), COALESCE(p_is_active, true)
    )
    ON CONFLICT (item_id, batch_no) DO UPDATE SET
      mfg_date = COALESCE(EXCLUDED.mfg_date, item_batches.mfg_date),
      expiry_date = EXCLUDED.expiry_date,
      mrp = COALESCE(EXCLUDED.mrp, item_batches.mrp),
      purchase_rate = COALESCE(EXCLUDED.purchase_rate, item_batches.purchase_rate),
      selling_rate = COALESCE(EXCLUDED.selling_rate, item_batches.selling_rate),
      qty_on_hand = GREATEST(0, item_batches.qty_on_hand + COALESCE(p_qty_delta, 0)),
      is_active = true
    RETURNING * INTO v_row;
  END IF;

  IF COALESCE(p_qty_delta, 0) <> 0 THEN
    INSERT INTO public.stock_ledger (
      item_id, movement_type, movement_date, entered_qty, entered_unit_id,
      conversion_factor, signed_base_qty, unit_cost, reason, source_table, source_id, batch_id, created_by
    )
    VALUES (
      p_item_id,
      CASE WHEN p_qty_delta > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
      CURRENT_DATE, abs(p_qty_delta), v_item.base_unit_id, 1, p_qty_delta,
      COALESCE(p_purchase_rate, v_item.purchase_price),
      'Batch ' || v_row.batch_no || ' stock update', 'item_batches', v_row.id, v_row.id, auth.uid()
    );
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_near_expiry_batches(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := GREATEST(0, COALESCE(p_days, 90));
BEGIN
  IF NOT public.is_active_staff() THEN RAISE EXCEPTION 'Staff access required.'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(r) ORDER BY r.expiry_date ASC)
    FROM (
      SELECT
        ib.id, ib.item_id, i.name AS item_name, i.sku,
        i.pack_metadata->>'salt' AS salt_name,
        i.pack_metadata->>'schedule' AS schedule_class,
        ib.batch_no, ib.mfg_date, ib.expiry_date, ib.mrp, ib.selling_rate, ib.qty_on_hand,
        (ib.expiry_date - CURRENT_DATE)::integer AS days_to_expiry,
        (ib.expiry_date < CURRENT_DATE) AS is_expired,
        round((ib.qty_on_hand * COALESCE(ib.purchase_rate, i.purchase_price, 0))::numeric, 2) AS stock_cost_value
      FROM public.item_batches ib
      JOIN public.items i ON i.id = ib.item_id
      WHERE ib.is_active = true
        AND i.is_active = true
        AND ib.qty_on_hand > 0
        AND ib.expiry_date <= (CURRENT_DATE + v_days)
    ) r
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_salt_substitutes(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_salt text;
BEGIN
  IF NOT public.is_active_staff() THEN RAISE EXCEPTION 'Staff access required.'; END IF;
  SELECT lower(trim(COALESCE(pack_metadata->>'salt', ''))) INTO v_salt FROM public.items WHERE id = p_item_id;
  IF v_salt IS NULL OR v_salt = '' THEN RETURN '[]'::jsonb; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(r) ORDER BY r.qty_on_hand DESC, r.selling_price ASC)
    FROM (
      SELECT
        c.id, c.name, c.sku, c.selling_price, c.mrp, c.qty_on_hand, c.base_unit_code,
        c.pack_metadata->>'salt' AS salt_name,
        c.pack_metadata->>'manufacturer' AS manufacturer,
        c.nearest_expiry_date
      FROM public.item_catalog_view c
      WHERE c.id <> p_item_id
        AND c.is_active = true
        AND lower(trim(COALESCE(c.pack_metadata->>'salt', ''))) = v_salt
    ) r
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_schedule_register(
  p_from date DEFAULT (CURRENT_DATE - 30),
  p_to date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant', 'cashier']) THEN
    RAISE EXCEPTION 'Insufficient role permissions.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(r) ORDER BY r.sale_date DESC, r.created_at DESC)
    FROM (
      SELECT
        sr.*, b.bill_number
      FROM public.schedule_register sr
      JOIN public.bills b ON b.id = sr.bill_id
      WHERE b.status <> 'voided'
        AND sr.sale_date >= COALESCE(p_from, CURRENT_DATE - 30)
        AND sr.sale_date <= COALESCE(p_to, CURRENT_DATE)
    ) r
  ), '[]'::jsonb);
END;
$$;

-- Clothing Size × Colour Matrix RPC
CREATE OR REPLACE FUNCTION public.save_variant_matrix(
  p_item_id uuid,
  p_variants jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_item public.items;
  v_v jsonb;
  v_size text;
  v_color text;
  v_qty numeric(15,3);
  v_old_qty numeric(15,3);
  v_delta numeric(15,3);
  v_var public.item_variants;
BEGIN
  PERFORM public.require_module('inventory');
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can manage item variants.';
  END IF;
  SELECT * INTO v_item FROM public.items WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found.'; END IF;

  IF p_variants IS NULL OR jsonb_typeof(p_variants) <> 'array' THEN
    RAISE EXCEPTION 'Variants array is required.';
  END IF;

  FOR v_v IN SELECT value FROM jsonb_array_elements(p_variants)
  LOOP
    v_size := trim(COALESCE(v_v->>'size', ''));
    v_color := COALESCE(NULLIF(trim(COALESCE(v_v->>'color', '')), ''), 'Default');
    IF v_size = '' THEN CONTINUE; END IF;
    v_qty := GREATEST(0, round(COALESCE((v_v->>'qty_on_hand')::numeric, 0), 3));

    SELECT qty_on_hand INTO v_old_qty FROM public.item_variants WHERE item_id = p_item_id AND size = v_size AND color = v_color;
    v_old_qty := COALESCE(v_old_qty, 0);
    v_delta := v_qty - v_old_qty;

    INSERT INTO public.item_variants (
      item_id, size, color, sku, barcode, selling_price, mrp, purchase_price, qty_on_hand, is_active
    )
    VALUES (
      p_item_id, v_size, v_color,
      NULLIF(upper(trim(COALESCE(v_v->>'sku', ''))), ''),
      NULLIF(upper(trim(COALESCE(v_v->>'barcode', ''))), ''),
      NULLIF(v_v->>'selling_price', '')::numeric,
      NULLIF(v_v->>'mrp', '')::numeric,
      NULLIF(v_v->>'purchase_price', '')::numeric,
      v_qty,
      COALESCE((v_v->>'is_active')::boolean, true)
    )
    ON CONFLICT (item_id, size, color) DO UPDATE SET
      sku = EXCLUDED.sku,
      barcode = EXCLUDED.barcode,
      selling_price = EXCLUDED.selling_price,
      mrp = EXCLUDED.mrp,
      purchase_price = EXCLUDED.purchase_price,
      qty_on_hand = EXCLUDED.qty_on_hand,
      is_active = EXCLUDED.is_active
    RETURNING * INTO v_var;

    IF v_delta <> 0 THEN
      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason,
        source_table, source_id, variant_id, created_by
      )
      VALUES (
        p_item_id,
        CASE WHEN v_delta > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
        CURRENT_DATE, abs(v_delta), v_item.base_unit_id, 1, v_delta,
        COALESCE(v_var.purchase_price, v_item.purchase_price),
        'Variant ' || v_size || ' / ' || v_color || ' stock sync',
        'item_variants', v_var.id, v_var.id, auth.uid()
      );
    END IF;
  END LOOP;

  RETURN COALESCE((SELECT jsonb_agg(row_to_json(iv) ORDER BY iv.size, iv.color) FROM public.item_variants iv WHERE iv.item_id = p_item_id), '[]'::jsonb);
END;
$$;

-- Party Sites & Party Negotiated Item Rates
CREATE OR REPLACE FUNCTION public.save_party_site(
  p_party_id uuid,
  p_site_name text,
  p_contact_name text DEFAULT NULL,
  p_contact_phone text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_is_active boolean DEFAULT true
)
RETURNS public.party_sites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_row public.party_sites;
BEGIN
  PERFORM public.require_module('parties');
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'Permission denied.';
  END IF;
  IF length(trim(COALESCE(p_site_name, ''))) < 1 THEN
    RAISE EXCEPTION 'Site name is required.';
  END IF;

  IF p_site_id IS NOT NULL THEN
    UPDATE public.party_sites
    SET site_name = trim(p_site_name),
        contact_name = NULLIF(trim(COALESCE(p_contact_name, '')), ''),
        contact_phone = NULLIF(trim(COALESCE(p_contact_phone, '')), ''),
        address = NULLIF(trim(COALESCE(p_address, '')), ''),
        is_active = COALESCE(p_is_active, true)
    WHERE id = p_site_id AND party_id = p_party_id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.party_sites (party_id, site_name, contact_name, contact_phone, address, is_active)
    VALUES (
      p_party_id, trim(p_site_name),
      NULLIF(trim(COALESCE(p_contact_name, '')), ''),
      NULLIF(trim(COALESCE(p_contact_phone, '')), ''),
      NULLIF(trim(COALESCE(p_address, '')), ''),
      COALESCE(p_is_active, true)
    )
    RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_party_item_rate(
  p_party_id uuid,
  p_item_id uuid,
  p_custom_rate numeric,
  p_min_qty numeric DEFAULT 1
)
RETURNS public.party_item_rates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_row public.party_item_rates;
BEGIN
  IF v_role NOT IN ('owner', 'manager', 'accountant') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Accountant can manage party rate cards.';
  END IF;
  INSERT INTO public.party_item_rates (party_id, item_id, custom_rate, min_qty)
  VALUES (p_party_id, p_item_id, round(GREATEST(0, p_custom_rate)::numeric, 2), GREATEST(0.001, COALESCE(p_min_qty, 1)))
  ON CONFLICT (party_id, item_id) DO UPDATE SET
    custom_rate = EXCLUDED.custom_rate,
    min_qty = EXCLUDED.min_qty
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Hardware Estimates & Warranty Claims
CREATE OR REPLACE FUNCTION public.save_hardware_estimate(
  p_title text,
  p_party_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_calc_inputs jsonb DEFAULT '{}'::jsonb,
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_estimated_total numeric DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_id uuid DEFAULT NULL
)
RETURNS public.hardware_estimates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_row public.hardware_estimates;
  v_party_name text := 'Walk-in Customer';
  v_site_name text := NULL;
  v_est_no text;
BEGIN
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN
    RAISE EXCEPTION 'Permission denied.';
  END IF;
  IF length(trim(COALESCE(p_title, ''))) < 1 THEN RAISE EXCEPTION 'Estimate title is required.'; END IF;

  IF p_party_id IS NOT NULL THEN SELECT name INTO v_party_name FROM public.parties WHERE id = p_party_id; END IF;
  IF p_site_id IS NOT NULL THEN SELECT site_name INTO v_site_name FROM public.party_sites WHERE id = p_site_id; END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.hardware_estimates
    SET party_id = p_party_id, party_name = COALESCE(v_party_name, 'Walk-in Customer'),
        site_id = p_site_id, site_name = v_site_name,
        title = trim(p_title), calc_inputs = COALESCE(p_calc_inputs, '{}'::jsonb),
        lines = COALESCE(p_lines, '[]'::jsonb), estimated_total = round(COALESCE(p_estimated_total, 0)::numeric, 2),
        notes = NULLIF(trim(COALESCE(p_notes, '')), '')
    WHERE id = p_id RETURNING * INTO v_row;
  ELSE
    v_est_no := 'EST-' || to_char(CURRENT_DATE, 'YYMM') || '-' || lpad(((floor(random() * 9000) + 1000)::integer)::text, 4, '0');
    INSERT INTO public.hardware_estimates (
      estimate_number, party_id, party_name, site_id, site_name, title,
      calc_inputs, lines, estimated_total, notes, created_by
    )
    VALUES (
      v_est_no, p_party_id, COALESCE(v_party_name, 'Walk-in Customer'), p_site_id, v_site_name,
      trim(p_title), COALESCE(p_calc_inputs, '{}'::jsonb), COALESCE(p_lines, '[]'::jsonb),
      round(COALESCE(p_estimated_total, 0)::numeric, 2), NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid()
    )
    RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.convert_estimate_to_quotation(p_estimate_id uuid)
RETURNS public.bills
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_est public.hardware_estimates;
  v_bill public.bills;
BEGIN
  SELECT * INTO v_est FROM public.hardware_estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Estimate not found.'; END IF;
  IF v_est.status = 'converted' AND v_est.converted_bill_id IS NOT NULL THEN
    SELECT * INTO v_bill FROM public.bills WHERE id = v_est.converted_bill_id;
    RETURN v_bill;
  END IF;

  v_bill := public.issue_bill(
    NULL, 'quotation', v_est.party_id, CURRENT_DATE, NULL, (CURRENT_DATE + 15),
    NULL, 0, true, COALESCE(v_est.notes, 'Estimate ' || v_est.estimate_number || ': ' || v_est.title),
    NULL, v_est.lines, 0, 'cash', NULL, 'est_conv:' || v_est.id::text, v_est.site_id, NULL, NULL
  );

  UPDATE public.hardware_estimates
  SET status = 'converted', converted_bill_id = v_bill.id
  WHERE id = p_estimate_id;

  RETURN v_bill;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_warranty_claim(
  p_warranty_id uuid,
  p_status text,
  p_claim_notes text DEFAULT NULL
)
RETURNS public.warranty_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_row public.warranty_records;
BEGIN
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN RAISE EXCEPTION 'Permission denied.'; END IF;
  IF p_status NOT IN ('active', 'claimed', 'replaced', 'expired') THEN RAISE EXCEPTION 'Invalid warranty status.'; END IF;

  UPDATE public.warranty_records
  SET status = p_status, claim_notes = NULLIF(trim(COALESCE(p_claim_notes, '')), '')
  WHERE id = p_warranty_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Warranty record not found.'; END IF;
  RETURN v_row;
END;
$$;

-- Service Jobs RPC
CREATE OR REPLACE FUNCTION public.save_service_job(
  p_title text,
  p_party_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_status text DEFAULT 'open',
  p_start_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_estimated_amount numeric DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_id uuid DEFAULT NULL
)
RETURNS public.service_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_row public.service_jobs;
  v_party_name text := 'Walk-in Client';
  v_job_no text;
BEGIN
  IF v_role NOT IN ('owner', 'manager', 'cashier', 'accountant') THEN RAISE EXCEPTION 'Permission denied.'; END IF;
  IF length(trim(COALESCE(p_title, ''))) < 1 THEN RAISE EXCEPTION 'Job title is required.'; END IF;
  IF p_status NOT IN ('open', 'in_progress', 'completed', 'billed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid job status.';
  END IF;

  IF p_party_id IS NOT NULL THEN SELECT name INTO v_party_name FROM public.parties WHERE id = p_party_id; END IF;

  IF p_id IS NOT NULL THEN
    UPDATE public.service_jobs
    SET party_id = p_party_id, party_name = COALESCE(v_party_name, 'Walk-in Client'),
        title = trim(p_title), description = NULLIF(trim(COALESCE(p_description, '')), ''),
        status = p_status, start_date = COALESCE(p_start_date, start_date),
        due_date = p_due_date,
        completed_date = CASE WHEN p_status IN ('completed', 'billed') THEN COALESCE(completed_date, CURRENT_DATE) ELSE completed_date END,
        estimated_amount = round(GREATEST(0, COALESCE(p_estimated_amount, 0))::numeric, 2),
        notes = NULLIF(trim(COALESCE(p_notes, '')), '')
    WHERE id = p_id RETURNING * INTO v_row;
  ELSE
    v_job_no := 'JOB-' || to_char(CURRENT_DATE, 'YYMM') || '-' || lpad(((floor(random() * 9000) + 1000)::integer)::text, 4, '0');
    INSERT INTO public.service_jobs (
      job_number, party_id, party_name, title, description, status, start_date, due_date, estimated_amount, notes, created_by
    )
    VALUES (
      v_job_no, p_party_id, COALESCE(v_party_name, 'Walk-in Client'), trim(p_title),
      NULLIF(trim(COALESCE(p_description, '')), ''), p_status, COALESCE(p_start_date, CURRENT_DATE), p_due_date,
      round(GREATEST(0, COALESCE(p_estimated_amount, 0))::numeric, 2), NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid()
    )
    RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;

-- Wholesale Quick Margin / Bulk Item Price Update
CREATE OR REPLACE FUNCTION public.bulk_update_item_prices(
  p_updates jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_user_role();
  v_u jsonb;
  v_count integer := 0;
BEGIN
  IF v_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Only Owner or Manager can bulk-update catalog prices.';
  END IF;
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN RETURN 0; END IF;

  FOR v_u IN SELECT value FROM jsonb_array_elements(p_updates)
  LOOP
    UPDATE public.items
    SET selling_price = COALESCE(NULLIF(v_u->>'selling_price', '')::numeric, selling_price),
        wholesale_slabs = COALESCE(v_u->'wholesale_slabs', wholesale_slabs),
        version = version + 1
    WHERE id = (v_u->>'item_id')::uuid
      AND COALESCE((v_u->>'selling_price')::numeric, selling_price) >= 0;
    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Pack-Specific Reports RPC
CREATE OR REPLACE FUNCTION public.get_pack_reports(
  p_from date DEFAULT date_trunc('month', CURRENT_DATE)::date,
  p_to date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pack text;
  v_from date := COALESCE(p_from, date_trunc('month', CURRENT_DATE)::date);
  v_to date := COALESCE(p_to, CURRENT_DATE);
BEGIN
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Pack reports require Owner, Manager, or Accountant access.';
  END IF;

  SELECT pack INTO v_pack FROM public.business WHERE id = 1;

  RETURN jsonb_build_object(
    'pack', v_pack,
    'near_expiry_count', (SELECT count(*)::integer FROM public.item_batches WHERE is_active = true AND qty_on_hand > 0 AND expiry_date <= CURRENT_DATE + 90),
    'expired_stock_value', COALESCE((SELECT round(SUM(ib.qty_on_hand * COALESCE(ib.purchase_rate, i.purchase_price, 0))::numeric, 2) FROM public.item_batches ib JOIN public.items i ON i.id = ib.item_id WHERE ib.is_active = true AND ib.qty_on_hand > 0 AND ib.expiry_date < CURRENT_DATE), 0),
    'schedule_entries_count', (SELECT count(*)::integer FROM public.schedule_register sr JOIN public.bills b ON b.id = sr.bill_id WHERE b.status <> 'voided' AND sr.sale_date BETWEEN v_from AND v_to),
    'variant_stock_summary', COALESCE((
      SELECT jsonb_agg(row_to_json(v)) FROM (
        SELECT iv.size, iv.color, SUM(iv.qty_on_hand)::numeric(15,3) AS total_qty, count(*)::integer AS sku_count
        FROM public.item_variants iv JOIN public.items i ON i.id = iv.item_id
        WHERE iv.is_active = true AND i.is_active = true
        GROUP BY iv.size, iv.color ORDER BY SUM(iv.qty_on_hand) DESC LIMIT 15
      ) v
    ), '[]'::jsonb),
    'active_warranties_count', (SELECT count(*)::integer FROM public.warranty_records WHERE status IN ('active', 'claimed') AND warranty_end_date >= CURRENT_DATE),
    'claimed_warranties_count', (SELECT count(*)::integer FROM public.warranty_records WHERE status IN ('claimed', 'replaced')),
    'job_profitability', COALESCE((
      SELECT jsonb_agg(row_to_json(j)) FROM (
        SELECT
          sj.id, sj.job_number, sj.title, sj.party_name, sj.status, sj.estimated_amount,
          COALESCE((SELECT SUM(b.grand_total) FROM public.bills b WHERE b.job_id = sj.id AND b.status = 'issued' AND b.doc_type IN ('tax_invoice', 'bill_of_supply')), 0)::numeric(15,2) AS billed_revenue,
          COALESCE((SELECT SUM(ex.amount) FROM public.expenses ex WHERE ex.job_id = sj.id AND ex.status = 'posted'), 0)::numeric(15,2) AS job_expenses
        FROM public.service_jobs sj
        ORDER BY sj.created_at DESC LIMIT 20
      ) j
    ), '[]'::jsonb),
    'tier_sales_summary', COALESCE((
      SELECT jsonb_agg(row_to_json(ts)) FROM (
        SELECT COALESCE(p.price_tier, 'walk_in') AS price_tier, count(b.id)::integer AS bill_count, COALESCE(SUM(b.grand_total), 0)::numeric(15,2) AS total_sales
        FROM public.bills b LEFT JOIN public.parties p ON p.id = b.party_id
        WHERE b.status = 'issued' AND b.doc_type IN ('tax_invoice', 'bill_of_supply') AND b.bill_date BETWEEN v_from AND v_to
        GROUP BY COALESCE(p.price_tier, 'walk_in')
      ) ts
    ), '[]'::jsonb),
    'site_sales_summary', COALESCE((
      SELECT jsonb_agg(row_to_json(ss)) FROM (
        SELECT b.site_name, b.party_name, count(b.id)::integer AS bill_count, COALESCE(SUM(b.grand_total), 0)::numeric(15,2) AS total_sales, COALESCE(SUM(b.balance_due), 0)::numeric(15,2) AS balance_due
        FROM public.bills b
        WHERE b.site_id IS NOT NULL AND b.status = 'issued' AND b.doc_type IN ('tax_invoice', 'bill_of_supply') AND b.bill_date BETWEEN v_from AND v_to
        GROUP BY b.site_name, b.party_name ORDER BY total_sales DESC LIMIT 15
      ) ss
    ), '[]'::jsonb)
  );
END;
$$;

-- Safe Drive Connection Status RPC (never returns tokens)
CREATE OR REPLACE FUNCTION public.get_drive_status_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.drive_connections;
BEGIN
  IF NOT public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN
    RAISE EXCEPTION 'Insufficient permissions.';
  END IF;
  SELECT * INTO v_row FROM public.drive_connections WHERE id = 1;
  RETURN jsonb_build_object(
    'connected', (v_row.refresh_token_enc IS NOT NULL AND v_row.last_sync_status <> 'disconnected'),
    'connected_email', v_row.connected_email,
    'folder_name', COALESCE(v_row.folder_name, 'BizOne ERP Backups'),
    'folder_id', v_row.folder_id,
    'schedule_enabled', COALESCE(v_row.schedule_enabled, false),
    'schedule_frequency', COALESCE(v_row.schedule_frequency, 'daily'),
    'retention_count', COALESCE(v_row.retention_count, 10),
    'last_sync_at', v_row.last_sync_at,
    'last_sync_status', COALESCE(v_row.last_sync_status, 'never'),
    'last_error', v_row.last_error
  );
END;
$$;

-- Extend sync_system_notifications() with Expiry & Warranty alerts
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
  v_expiring_count integer := 0;
  v_expired_count integer := 0;
  v_list jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_active_staff() THEN RAISE EXCEPTION 'Active staff access required.'; END IF;
  v_role := public.current_user_role();

  IF public.is_module_enabled('inventory') THEN
    SELECT count(*) FILTER (WHERE is_active = true AND is_low_stock = true)::integer,
           count(*) FILTER (WHERE is_active = true AND is_out_of_stock = true)::integer
    INTO v_low_count, v_out_count FROM public.item_catalog_view;

    IF v_low_count > 0 OR v_out_count > 0 THEN
      INSERT INTO public.notifications (rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi, target_tab, min_roles, is_resolved)
      VALUES (
        'low_stock', 'system:low_stock', CASE WHEN v_out_count > 0 THEN 'critical' ELSE 'warning' END,
        v_low_count || ' low-stock & ' || v_out_count || ' out-of-stock item(s)',
        v_low_count || ' कम स्टॉक और ' || v_out_count || ' स्टॉक खत्म आइटम',
        'Review stock levels and create supplier purchases or stock adjustments.',
        'स्टॉक स्तर की समीक्षा करें और सप्लायर खरीद या स्टॉक समायोजन दर्ज करें।',
        'items', ARRAY['owner', 'manager', 'storekeeper'], false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, title_en = EXCLUDED.title_en, title_hi = EXCLUDED.title_hi, is_resolved = false, updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:low_stock';
    END IF;
  END IF;

  IF public.is_module_enabled('batch_expiry') THEN
    SELECT
      count(*) FILTER (WHERE ib.expiry_date >= CURRENT_DATE AND ib.expiry_date <= CURRENT_DATE + 60)::integer,
      count(*) FILTER (WHERE ib.expiry_date < CURRENT_DATE)::integer
    INTO v_expiring_count, v_expired_count
    FROM public.item_batches ib JOIN public.items i ON i.id = ib.item_id
    WHERE ib.is_active = true AND i.is_active = true AND ib.qty_on_hand > 0;

    IF v_expiring_count > 0 OR v_expired_count > 0 THEN
      INSERT INTO public.notifications (rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi, target_tab, min_roles, is_resolved)
      VALUES (
        'batch_expiry', 'system:batch_expiry', CASE WHEN v_expired_count > 0 THEN 'critical' ELSE 'warning' END,
        v_expired_count || ' expired & ' || v_expiring_count || ' near-expiry batch(es)',
        v_expired_count || ' एक्सपायर और ' || v_expiring_count || ' जल्द एक्सपायर होने वाले बैच',
        'Review near-expiry stock in Pack Workspace to process returns or clearance.',
        'वापसी या क्लीयरेंस के लिए पैक वर्कस्पेस में एक्सपायरी स्टॉक देखें।',
        'pack', ARRAY['owner', 'manager', 'storekeeper'], false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, title_en = EXCLUDED.title_en, title_hi = EXCLUDED.title_hi, is_resolved = false, updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:batch_expiry';
    END IF;
  END IF;

  IF public.is_module_enabled('parties') THEN
    SELECT count(*) FILTER (WHERE is_active = true AND is_overdue = true)::integer,
           COALESCE(SUM(overdue_receivable) FILTER (WHERE is_active = true), 0)::numeric(15,2)
    INTO v_overdue_count, v_overdue_amt FROM public.party_balances;

    IF v_overdue_count > 0 THEN
      INSERT INTO public.notifications (rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi, target_tab, min_roles, is_resolved)
      VALUES (
        'overdue_khata', 'system:overdue_khata', 'warning',
        v_overdue_count || ' party account(s) have overdue Khata balances',
        v_overdue_count || ' पार्टियों का खाता बकाया समय सीमा पार है',
        'Total overdue receivables: ₹' || v_overdue_amt || '. Send payment reminders from Parties.',
        'कुल बकाया वसूली: ₹' || v_overdue_amt || '। पार्टी स्क्रीन से रिमाइंडर भेजें।',
        'parties', ARRAY['owner', 'manager', 'accountant'], false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET title_en = EXCLUDED.title_en, title_hi = EXCLUDED.title_hi, body_en = EXCLUDED.body_en, body_hi = EXCLUDED.body_hi, is_resolved = false, updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:overdue_khata';
    END IF;
  END IF;

  IF public.is_module_enabled('backup') THEN
    SELECT last_backup_at INTO v_last_backup FROM public.business WHERE id = 1;
    v_days_since_backup := CASE WHEN v_last_backup IS NULL THEN 999 ELSE GREATEST(0, floor(extract(epoch FROM (now() - v_last_backup)) / 86400)::integer) END;

    IF v_last_backup IS NULL OR v_days_since_backup >= 7 THEN
      INSERT INTO public.notifications (rule_key, dedupe_key, severity, title_en, title_hi, body_en, body_hi, target_tab, min_roles, is_resolved)
      VALUES (
        'backup_overdue', 'system:backup_overdue', CASE WHEN v_last_backup IS NULL THEN 'warning' ELSE 'critical' END,
        CASE WHEN v_last_backup IS NULL THEN 'No local backup downloaded yet' ELSE 'Last backup was ' || v_days_since_backup || ' days ago' END,
        CASE WHEN v_last_backup IS NULL THEN 'अभी तक कोई लोकल बैकअप नहीं लिया गया है' ELSE 'अंतिम बैकअप ' || v_days_since_backup || ' दिन पहले लिया गया था' END,
        'Download an updated workspace backup from Settings -> Backup & Storage.',
        'सेटिंग्स -> बैकअप और स्टोरेज से नवीनतम बैकअप डाउनलोड करें।',
        'settings', ARRAY['owner', 'manager', 'accountant'], false
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET severity = EXCLUDED.severity, title_en = EXCLUDED.title_en, title_hi = EXCLUDED.title_hi, is_resolved = false, updated_at = now();
    ELSE
      UPDATE public.notifications SET is_resolved = true WHERE dedupe_key = 'system:backup_overdue';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(n) ORDER BY n.is_read ASC, n.created_at DESC), '[]'::jsonb)
  INTO v_list
  FROM (
    SELECT id, rule_key, severity, title_en, title_hi, body_en, body_hi, target_tab, target_id, is_read, created_at
    FROM public.notifications WHERE is_resolved = false AND v_role = ANY(min_roles)
    ORDER BY is_read ASC, created_at DESC LIMIT 25
  ) n;

  RETURN jsonb_build_object(
    'unread_count', (SELECT count(*)::integer FROM public.notifications WHERE is_resolved = false AND is_read = false AND v_role = ANY(min_roles)),
    'notifications', v_list
  );
END;
$$;

-- ============================================================================
-- 8. Row-Level Security & Least-Privilege Grants for New Tables
-- ============================================================================
ALTER TABLE public.item_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hardware_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warranty_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_item_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_connections ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.item_batches FROM anon, authenticated;
REVOKE ALL ON public.prescriptions FROM anon, authenticated;
REVOKE ALL ON public.schedule_register FROM anon, authenticated;
REVOKE ALL ON public.item_variants FROM anon, authenticated;
REVOKE ALL ON public.party_sites FROM anon, authenticated;
REVOKE ALL ON public.hardware_estimates FROM anon, authenticated;
REVOKE ALL ON public.warranty_records FROM anon, authenticated;
REVOKE ALL ON public.service_jobs FROM anon, authenticated;
REVOKE ALL ON public.party_item_rates FROM anon, authenticated;
REVOKE ALL ON public.import_jobs FROM anon, authenticated;
REVOKE ALL ON public.drive_connections FROM anon, authenticated; -- STRICT server-only secret table

GRANT SELECT ON public.item_batches TO authenticated;
GRANT SELECT ON public.prescriptions TO authenticated;
GRANT SELECT ON public.schedule_register TO authenticated;
GRANT SELECT ON public.item_variants TO authenticated;
GRANT SELECT ON public.party_sites TO authenticated;
GRANT SELECT ON public.hardware_estimates TO authenticated;
GRANT SELECT ON public.warranty_records TO authenticated;
GRANT SELECT ON public.service_jobs TO authenticated;
GRANT SELECT ON public.party_item_rates TO authenticated;
GRANT SELECT ON public.import_jobs TO authenticated;

DROP POLICY IF EXISTS "Staff read item_batches" ON public.item_batches;
CREATE POLICY "Staff read item_batches" ON public.item_batches FOR SELECT TO authenticated USING (public.is_active_staff());

DROP POLICY IF EXISTS "Staff read prescriptions" ON public.prescriptions;
CREATE POLICY "Staff read prescriptions" ON public.prescriptions FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']));

DROP POLICY IF EXISTS "Staff read schedule_register" ON public.schedule_register;
CREATE POLICY "Staff read schedule_register" ON public.schedule_register FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']));

DROP POLICY IF EXISTS "Staff read item_variants" ON public.item_variants;
CREATE POLICY "Staff read item_variants" ON public.item_variants FOR SELECT TO authenticated USING (public.is_active_staff());

DROP POLICY IF EXISTS "Staff read party_sites" ON public.party_sites;
CREATE POLICY "Staff read party_sites" ON public.party_sites FOR SELECT TO authenticated USING (public.is_active_staff());

DROP POLICY IF EXISTS "Staff read hardware_estimates" ON public.hardware_estimates;
CREATE POLICY "Staff read hardware_estimates" ON public.hardware_estimates FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']));

DROP POLICY IF EXISTS "Staff read warranty_records" ON public.warranty_records;
CREATE POLICY "Staff read warranty_records" ON public.warranty_records FOR SELECT TO authenticated USING (public.is_active_staff());

DROP POLICY IF EXISTS "Staff read service_jobs" ON public.service_jobs;
CREATE POLICY "Staff read service_jobs" ON public.service_jobs FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['owner', 'manager', 'cashier', 'accountant']));

DROP POLICY IF EXISTS "Staff read party_item_rates" ON public.party_item_rates;
CREATE POLICY "Staff read party_item_rates" ON public.party_item_rates FOR SELECT TO authenticated USING (public.is_active_staff());

DROP POLICY IF EXISTS "Managers read import_jobs" ON public.import_jobs;
CREATE POLICY "Managers read import_jobs" ON public.import_jobs FOR SELECT TO authenticated USING (public.has_any_role(ARRAY['owner', 'manager', 'accountant']));

GRANT EXECUTE ON FUNCTION public.update_business_profile(
  text, boolean, text, text, text, text, text, text, integer, uuid, uuid, text, integer, text, text,
  text, boolean, text, integer, text, integer, numeric, boolean,
  text, integer, text, integer, text, integer, text, jsonb
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer, text, jsonb
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_party(
  uuid, text, text, text, text, text, numeric, text, date, numeric, integer, text, jsonb, integer, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_expense(uuid, uuid, date, numeric, text, text, text, text, uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public._prepare_bill_payload(text, uuid, text, numeric, boolean, jsonb, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_bill_draft(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_bill(uuid, text, uuid, date, date, date, text, numeric, boolean, text, text, jsonb, numeric, text, text, text, uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_quotation_to_bill(uuid, text, date, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_return(uuid, jsonb, date, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_bill(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public._prepare_purchase_payload(uuid, text, boolean, numeric, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_purchase_draft(uuid, uuid, text, date, date, date, text, boolean, numeric, boolean, boolean, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_purchase(uuid, uuid, text, date, date, date, text, boolean, numeric, boolean, boolean, text, uuid, jsonb, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_item_batch(uuid, text, date, date, numeric, numeric, numeric, numeric, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_near_expiry_batches(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_salt_substitutes(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_schedule_register(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_variant_matrix(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_party_site(uuid, text, text, text, text, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_party_item_rate(uuid, uuid, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_hardware_estimate(text, uuid, uuid, jsonb, jsonb, numeric, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_estimate_to_quotation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_warranty_claim(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_service_job(text, uuid, text, text, date, date, numeric, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_update_item_prices(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pack_reports(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_drive_status_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_system_notifications() TO authenticated;
