import type { BusinessPackKey } from '../../config/app.config';
import type { UserRole } from '../core/permissions';

export interface OnboardingSteps {
  logo: boolean;
  address: boolean;
  gst: boolean;
  profile: boolean;
  modules: boolean;
}

export interface BusinessRecord {
  id: number;
  name: string;
  pack: BusinessPackKey;
  gst_registered: boolean;
  gstin: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  state_code: string | null;
  upi_id: string | null;
  fy_start_month: number;
  logo_file_id: string | null;
  upi_qr_file_id: string | null;
  invoice_prefix: string;
  invoice_next_number: number;
  invoice_terms: string;
  tax_mode: 'inclusive' | 'exclusive';
  onboarding_completed: boolean;
  onboarding_steps: OnboardingSteps;
  created_at: string;
  updated_at: string;
}

export interface ProfileRecord {
  id: string;
  full_name: string;
  phone: string | null;
  email: string;
  role: UserRole;
  is_active: boolean;
  avatar_file_id: string | null;
  preferred_language: 'en' | 'hi';
  preferred_theme: 'light' | 'dark';
  created_at: string;
  updated_at: string;
}

export interface ModuleStateRecord {
  module_key: string;
  enabled: boolean;
  updated_at: string;
}

export interface FileRecord {
  id: string;
  bucket: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  checksum: string | null;
  purpose: 'avatar' | 'business_logo' | 'upi_qr' | 'item_image' | 'attachment';
  uploaded_by: string | null;
  created_at: string;
  signedUrl?: string;
}

export interface AuditLogRecord {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface IntegrationSettingRecord {
  integration_key: string;
  enabled: boolean;
  display_name: string;
  config_public: Record<string, unknown>;
  has_secret: boolean;
  last_checked_at: string | null;
  status: string;
  updated_at: string;
}

export type PartyType = 'customer' | 'supplier' | 'both';
export type BalanceDirection = 'to_receive' | 'to_give';
export type PaymentDirection = 'receive' | 'give';
export type PaymentMode =
  | 'cash'
  | 'upi'
  | 'card'
  | 'bank_transfer'
  | 'cheque'
  | 'other';

export interface PartyAddressRecord {
  id?: string;
  party_id?: string;
  label: string;
  address_line1: string;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  pincode?: string | null;
  is_default: boolean;
}

export interface PartyRecord {
  id: string;
  name: string;
  party_type: PartyType;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  opening_balance: number;
  opening_balance_type: BalanceDirection;
  opening_balance_date: string;
  credit_limit: number;
  credit_days: number;
  notes: string | null;
  is_active: boolean;
  is_demo: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartyBalanceRecord {
  party_id: string;
  name: string;
  party_type: PartyType;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  opening_balance: number;
  opening_balance_type: BalanceDirection;
  opening_balance_date: string;
  credit_limit: number;
  credit_days: number;
  notes: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  total_debit: number;
  total_credit: number;
  net_balance: number;
  to_receive: number;
  to_give: number;
  open_obligations_count: number;
  overdue_receivable: number;
  overdue_payable: number;
  is_overdue: boolean;
  last_entry_date: string | null;
}

export interface KhataTotalsSummary {
  total_to_receive: number;
  total_to_give: number;
  active_parties_count: number;
  overdue_parties_count: number;
  today_received: number;
  today_given: number;
}

export interface OpenObligationRecord {
  ledger_entry_id: string;
  party_id: string;
  entry_type: string;
  entry_date: string;
  due_date: string | null;
  reference_no: string;
  note: string | null;
  original_amount: number;
  settled_amount: number;
  remaining_amount: number;
  direction_needed: PaymentDirection;
  is_overdue: boolean;
  created_at: string;
}

export interface PartyLedgerEntryRecord {
  id: string;
  party_id: string;
  entry_type:
    | 'opening_balance'
    | 'khata_due'
    | 'bill'
    | 'sales_return'
    | 'purchase'
    | 'purchase_return'
    | 'payment_receive'
    | 'payment_give'
    | 'payment_reversal'
    | 'adjustment';
  entry_date: string;
  due_date: string | null;
  reference_no: string | null;
  source_table: string | null;
  source_id: string | null;
  signed_amount: number;
  debit_amount: number;
  credit_amount: number;
  note: string | null;
  is_reversed: boolean;
  reversed_by_entry_id: string | null;
  created_at: string;
  running_balance?: number;
}

export interface PaymentAllocationRecord {
  id: string;
  payment_id: string;
  party_id: string;
  target_type:
    | 'opening_balance'
    | 'ledger_entry'
    | 'bill'
    | 'purchase_bill'
    | 'advance';
  ledger_entry_id: string | null;
  target_label: string;
  allocated_amount: number;
  is_reversed: boolean;
  created_at: string;
}

export interface PaymentRecord {
  id: string;
  payment_number: string;
  party_id: string;
  direction: PaymentDirection;
  amount: number;
  allocated_amount: number;
  advance_amount: number;
  mode: PaymentMode;
  payment_date: string;
  reference_no: string | null;
  notes: string | null;
  status: 'posted' | 'reversed';
  idempotency_key: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  parties?: { name: string; party_type: PartyType; phone: string | null } | null;
  payment_allocations?: PaymentAllocationRecord[];
}

export interface PartyStatementData {
  party_id: string;
  party_name: string;
  party_type: PartyType;
  from_date: string | null;
  to_date: string | null;
  opening_balance: number;
  period_debit: number;
  period_credit: number;
  closing_balance: number;
  rows: PartyLedgerEntryRecord[];
}

export interface ItemCategoryRecord {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BrandRecord {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ItemUnitRecord {
  id: string;
  code: string;
  name_en: string;
  name_hi: string;
  allow_decimal: boolean;
  is_system: boolean;
  is_active: boolean;
}

export interface UnitConversionRecord {
  id?: string;
  item_id?: string;
  alternate_unit_id: string;
  conversion_factor: number;
  item_units?: ItemUnitRecord;
}

export interface ItemImageRecord {
  id: string;
  item_id: string;
  file_id: string;
  sort_order: number;
  is_primary: boolean;
  created_at: string;
  files?: {
    id: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
  } | null;
}

export interface ItemCatalogRecord {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  category_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  base_unit_id: string;
  base_unit_code: string;
  base_unit_name_en: string;
  base_unit_name_hi: string;
  base_unit_allow_decimal: boolean;
  selling_price: number;
  mrp: number | null;
  purchase_price: number | null;
  gst_rate: number;
  hsn_code: string | null;
  tax_inclusive: boolean;
  low_stock_alert: number;
  allow_negative_stock: boolean;
  primary_image_file_id: string | null;
  pack_metadata: Record<string, string | number | boolean | null>;
  notes: string | null;
  is_active: boolean;
  is_demo: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  qty_on_hand: number;
  last_movement_at: string | null;
  is_out_of_stock: boolean;
  is_low_stock: boolean;
  stock_value: number | null;
  image_count: number;
  conversions_count: number;
}

export interface InventorySummary {
  active_items_count: number;
  archived_items_count: number;
  low_stock_count: number;
  out_of_stock_count: number;
  total_stock_units: number;
  total_stock_value: number | null;
}

export interface StockLedgerEntryRecord {
  id: string;
  item_id: string;
  movement_type:
    | 'opening_stock'
    | 'adjustment_in'
    | 'adjustment_out'
    | 'sale'
    | 'sale_return'
    | 'purchase'
    | 'purchase_return'
    | 'transfer_in'
    | 'transfer_out';
  movement_date: string;
  entered_qty: number;
  entered_unit_id: string;
  entered_unit_code: string;
  entered_unit_name_en: string;
  entered_unit_name_hi: string;
  conversion_factor: number;
  signed_base_qty: number;
  unit_cost: number | null;
  reason: string | null;
  reference_no: string | null;
  source_table: string | null;
  source_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}


