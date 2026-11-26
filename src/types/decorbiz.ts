import type { BusinessPackKey } from '../../config/app.config';
import type { UserRole } from '../core/permissions';
import type { ProductLineKey, TaxonomyScopeKey } from '../core/productLines';
import type {
  AnySpecsMap,
  FaucetsCpSpecs,
  OtherGeneralSpecs,
  SanitarywareSpecs,
  TileAdhesiveSpecs,
  TilesSlabsSpecs,
} from '../core/productSpecs';

export type {
  AnySpecsMap,
  FaucetsCpSpecs,
  OtherGeneralSpecs,
  ProductLineKey,
  SanitarywareSpecs,
  TaxonomyScopeKey,
  TileAdhesiveSpecs,
  TilesSlabsSpecs,
};

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
  pack_settings?: Record<string, unknown>;
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
  default_print_layout?: PrintLayoutType;
  show_upi_qr_on_invoice?: boolean;
  quotation_prefix?: string;
  quotation_next_number?: number;
  credit_note_prefix?: string;
  credit_note_next_number?: number;
  cashier_max_discount_pct?: number;
  allow_cashier_price_override?: boolean;
  purchase_prefix?: string;
  purchase_next_number?: number;
  purchase_return_prefix?: string;
  purchase_return_next_number?: number;
  expense_prefix?: string;
  expense_next_number?: number;
  last_backup_at?: string | null;
  allowed_ips?: string[];
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
  purpose: 'avatar' | 'business_logo' | 'upi_qr' | 'item_image' | 'attachment' | 'store_banner';
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
  sites_count?: number;
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

export type ItemType = 'goods' | 'service';

export interface ItemCategoryRecord {
  id: string;
  name: string;
  description: string | null;
  product_line?: TaxonomyScopeKey;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BrandRecord {
  id: string;
  name: string;
  product_line?: TaxonomyScopeKey;
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
  product_line?: TaxonomyScopeKey;
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

export interface ItemVariantRecord {
  id: string;
  item_id: string;
  item_name?: string;
  base_unit_code?: string;
  variant_name: string;
  size_label: string | null;
  finish: string | null;
  shade: string | null;
  batch_lot: string | null;
  sku: string | null;
  barcode: string | null;
  selling_price: number;
  mrp: number | null;
  purchase_price: number | null;
  qty_on_hand: number;
  reserved_qty?: number;
  available_qty?: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ItemLotBalanceRecord {
  item_id: string;
  variant_id: string | null;
  variant_name: string;
  shade: string;
  batch_lot: string;
  qty_on_hand: number;
  last_movement_at: string | null;
}

export interface ItemCatalogRecord {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  item_type?: 'goods' | 'service';
  product_line?: ProductLineKey;
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
  supplier_id?: string | null;
  supplier_name?: string | null;
  country_of_origin?: string | null;
  warranty_months?: number | null;
  video_url?: string | null;
  description?: string | null;
  specs?: AnySpecsMap | null;
  pack_metadata: Record<string, unknown>;
  notes: string | null;
  is_active: boolean;
  is_demo: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  qty_on_hand: number;
  reserved_qty?: number;
  available_qty?: number;
  is_published_online?: boolean;
  online_price?: number | null;
  online_slug?: string | null;
  online_description?: string | null;
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
  variant_id?: string | null;
  variant_name?: string | null;
  shade?: string | null;
  batch_lot?: string | null;
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

export type PrintLayoutType = 'a4' | 'a5' | 'thermal_80';
export type BillDocType =
  | 'tax_invoice'
  | 'bill_of_supply'
  | 'quotation'
  | 'credit_note';
export type BillStatus = 'draft' | 'issued' | 'voided' | 'converted';
export type BillPaymentStatus =
  | 'draft'
  | 'unpaid'
  | 'partial'
  | 'paid'
  | 'voided'
  | 'converted'
  | 'issued'
  | 'credited';

export interface BillBusinessSnapshot {
  name?: string;
  pack?: string;
  gst_registered?: boolean;
  gstin?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  state_code?: string | null;
  upi_id?: string | null;
  logo_file_id?: string | null;
  upi_qr_file_id?: string | null;
  show_upi_qr_on_invoice?: boolean;
  default_print_layout?: PrintLayoutType;
  pack_settings?: Record<string, unknown>;
  bank_name?: string | null;
  bank_account_holder?: string | null;
  bank_account_no?: string | null;
  bank_ifsc?: string | null;
  bank_branch?: string | null;
  bank_account_type?: string | null;
  show_bank_on_invoice?: boolean;
  show_cashier_on_invoice?: boolean;
  cashier_name?: string | null;
  default_cashier_name?: string | null;
  show_signatory_on_invoice?: boolean;
  signatory_label?: string | null;
  show_hsn_on_invoice?: boolean;
  show_mrp_savings_on_invoice?: boolean;
  show_customer_details_on_invoice?: boolean;
  invoice_greeting?: string | null;
}

export interface BillRecord {
  id: string;
  bill_number: string | null;
  doc_type: BillDocType;
  status: BillStatus;
  payment_status: BillPaymentStatus;
  source_bill_id: string | null;
  source_bill_number?: string | null;
  converted_from_quotation_id: string | null;
  converted_to_bill_id: string | null;
  converted_to_bill_number?: string | null;
  party_id: string | null;
  party_name: string;
  party_phone: string | null;
  party_gstin: string | null;
  party_address: string | null;
  place_of_supply_state_code: string | null;
  is_interstate: boolean;
  bill_date: string;
  due_date: string | null;
  valid_until: string | null;
  gst_applied: boolean;
  subtotal_taxable: number;
  discount_total: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  tax_total: number;
  extra_charges: number;
  auto_round_off: boolean;
  round_off: number;
  grand_total: number;
  paid_amount: number;
  credited_amount: number;
  balance_due: number;
  notes: string | null;
  terms: string | null;
  business_snapshot: BillBusinessSnapshot;
  void_reason: string | null;
  voided_at: string | null;
  voided_by: string | null;
  return_reason: string | null;
  issued_at: string | null;
  issued_by?: string | null;
  created_by?: string | null;
  payment_mode?: PaymentMode;
  payment_reference?: string | null;
  site_id?: string | null;
  site_name?: string | null;
  created_at: string;
  updated_at: string;
  line_count?: number;
  active_share_count?: number;
}

export interface BillLineRecord {
  id: string;
  bill_id: string;
  line_no: number;
  item_id: string;
  variant_id?: string | null;
  shade?: string | null;
  batch_lot?: string | null;
  source_bill_line_id: string | null;
  item_name: string;
  sku: string | null;
  hsn_code: string | null;
  entered_qty: number;
  entered_unit_id: string;
  entered_unit_code: string;
  conversion_factor: number;
  base_qty: number;
  catalog_unit_price: number;
  unit_price: number;
  discount_pct: number;
  tax_inclusive: boolean;
  gst_rate: number;
  gross_amount: number;
  discount_amount: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  tax_amount: number;
  line_total: number;
  mrp?: number | null;
  line_meta?: Record<string, unknown>;
}

export interface BillShareLinkRecord {
  id: string;
  bill_id: string;
  token: string;
  expires_at: string | null;
  is_revoked: boolean;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
}

export interface BillingSummary {
  today_sales: number;
  today_returns: number;
  today_net_sales: number;
  month_sales: number;
  total_unpaid_amount: number;
  unpaid_bills_count: number;
  open_quotations_count: number;
  drafts_count: number;
}

export interface PublicSharedBillPayload {
  bill: Omit<BillRecord, 'voided_at' | 'voided_by' | 'converted_from_quotation_id' | 'converted_to_bill_id'>;
  lines: Array<Omit<BillLineRecord, 'bill_id' | 'item_id' | 'source_bill_line_id' | 'entered_unit_id' | 'conversion_factor' | 'base_qty' | 'catalog_unit_price'>>;
  assets: {
    logoUrl: string | null;
    upiQrUrl: string | null;
    showUpiQr: boolean;
    defaultPrintLayout: PrintLayoutType;
    upiId: string | null;
  };
  expiresAt: string | null;
}

// ============================================================================
// Phase P5: Purchases, Expenses, Accounting Reports, Notifications & Backup
// ============================================================================
export type PurchaseDocType = 'purchase_bill' | 'purchase_return';
export type PurchaseStatus = 'draft' | 'posted' | 'voided';
export type PurchasePaymentStatus =
  | 'draft'
  | 'unpaid'
  | 'partial'
  | 'paid'
  | 'voided'
  | 'debited';

export interface PurchaseBillRecord {
  id: string;
  purchase_number: string | null;
  doc_type: PurchaseDocType;
  status: PurchaseStatus;
  payment_status: PurchasePaymentStatus;
  source_purchase_id: string | null;
  source_purchase_number?: string | null;
  party_id: string | null;
  party_name: string;
  party_phone: string | null;
  party_gstin: string | null;
  party_address?: string | null;
  supplier_invoice_no: string | null;
  supplier_invoice_date: string | null;
  place_of_supply_state_code: string | null;
  is_interstate: boolean;
  bill_date: string;
  due_date: string | null;
  gst_applied: boolean;
  subtotal_taxable: number;
  discount_total: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  tax_total: number;
  freight_charges: number;
  auto_round_off?: boolean;
  round_off: number;
  grand_total: number;
  paid_amount: number;
  credited_amount: number;
  balance_due: number;
  payment_mode: PaymentMode;
  payment_reference: string | null;
  attachment_file_id: string | null;
  update_item_cost?: boolean;
  notes: string | null;
  return_reason?: string | null;
  void_reason?: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
  line_count?: number;
}

export interface PurchaseLineRecord {
  id: string;
  purchase_id: string;
  line_no: number;
  item_id: string;
  variant_id?: string | null;
  shade?: string | null;
  batch_lot?: string | null;
  source_purchase_line_id: string | null;
  item_name: string;
  sku: string | null;
  hsn_code: string | null;
  entered_qty: number;
  entered_unit_id: string;
  entered_unit_code: string;
  conversion_factor: number;
  base_qty: number;
  unit_cost: number;
  discount_pct: number;
  tax_inclusive: boolean;
  gst_rate: number;
  gross_amount: number;
  discount_amount: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  tax_amount: number;
  line_total: number;
  mrp?: number | null;
  line_meta?: Record<string, unknown>;
}

export interface PurchaseSummary {
  today_purchases: number;
  month_purchases: number;
  month_returns: number;
  total_unpaid_payables: number;
  unpaid_purchases_count: number;
  drafts_count: number;
}

export interface ExpenseCategoryRecord {
  id: string;
  code: string;
  name_en: string;
  name_hi: string;
  is_system: boolean;
  is_active: boolean;
}

export interface ExpenseRecord {
  id: string;
  expense_number: string;
  category_id: string;
  category_code: string;
  category_name_en: string;
  category_name_hi: string;
  expense_date: string;
  amount: number;
  payment_mode: PaymentMode;
  reference_no: string | null;
  paid_to: string | null;
  notes: string | null;
  attachment_file_id: string | null;
  status: 'posted' | 'voided';
  void_reason: string | null;
  voided_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseSummary {
  today_expenses: number;
  month_expenses: number;
  today_cash_expenses: number;
  posted_count: number;
}

export interface DashboardDailyTrendPoint {
  day: string;
  sales: number;
  purchases: number;
  expenses: number;
}

export interface DashboardMetrics {
  today_sales: number;
  today_gross_sales: number;
  today_returns: number;
  month_sales: number;
  today_purchases: number;
  month_purchases: number;
  today_expenses: number;
  month_expenses: number;
  cash_in_today: number;
  cash_out_today: number;
  net_cash_today: number;
  total_receivable: number;
  total_payable: number;
  low_stock_count: number;
  out_of_stock_count: number;
  unread_notifications_count: number;
  last_backup_at: string | null;
  daily_trend: DashboardDailyTrendPoint[];
  recent_bills: Array<{
    id: string;
    bill_number: string | null;
    doc_type: BillDocType;
    status: BillStatus;
    payment_status: BillPaymentStatus;
    party_name: string;
    bill_date: string;
    grand_total: number;
    balance_due: number;
  }>;
}

export interface DayBookRow {
  entry_id: string;
  entry_date: string;
  created_at: string;
  voucher_no: string;
  source_type: string;
  party_or_particular: string;
  payment_mode: PaymentMode;
  reference_no: string | null;
  notes: string | null;
  cash_in: number;
  cash_out: number;
}

export interface DayBookResult {
  book: 'day' | 'cash' | 'bank';
  from_date: string;
  to_date: string;
  opening_balance: number;
  total_in: number;
  total_out: number;
  closing_balance: number;
  rows: DayBookRow[];
}

export interface ProfitEstimateResult {
  from_date: string;
  to_date: string;
  gross_sales_ex_tax: number;
  sales_returns_ex_tax: number;
  net_sales_ex_tax: number;
  extra_charges_income: number;
  cogs_estimate: number;
  gross_profit: number;
  operating_expenses: number;
  estimated_net_profit: number;
  missing_cost_entries: number;
  expense_breakdown: Array<{
    code: string;
    name_en: string;
    name_hi: string;
    total_amount: number;
  }>;
}

export interface GstSlabRow {
  gst_rate: number;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  tax_amount: number;
  total_amount: number;
}

export interface GstSummaryResult {
  from_date: string;
  to_date: string;
  output: {
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    total_tax: number;
    slabs: GstSlabRow[];
  };
  input: {
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    total_tax: number;
    slabs: GstSlabRow[];
  };
  net_payable: {
    cgst: number;
    sgst: number;
    igst: number;
    total_tax: number;
  };
}

export interface HsnSummaryRow {
  hsn_code: string;
  uqc: string;
  gst_rate: number;
  total_qty: number;
  taxable_value: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_tax: number;
  total_value: number;
}

export interface PartyDuesAgeingRow {
  party_id: string;
  party_name: string;
  party_type: PartyType;
  phone: string | null;
  direction_needed: PaymentDirection;
  bucket_0_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  bucket_90_plus: number;
  total_outstanding: number;
  max_days: number;
}

export interface NotificationRecord {
  id: string;
  rule_key: string;
  severity: 'info' | 'warning' | 'critical';
  title_en: string;
  title_hi: string;
  body_en: string;
  body_hi: string;
  target_tab: string;
  target_id: string | null;
  is_read: boolean;
  created_at: string;
}

export interface StorageUsageSummary {
  total_bytes: number;
  file_count: number;
  quota_bytes: number;
  usage_pct: number;
  by_purpose: Array<{
    purpose: string;
    file_count: number;
    total_bytes: number;
  }>;
  table_counts: Record<string, number>;
}

export interface BackupHistoryRecord {
  id: string;
  backup_type: 'manual' | 'scheduled' | 'drive' | 'pre_restore' | 'restore' | 'drive_restore';
  schema_version: string;
  checksum: string | null;
  size_bytes: number;
  record_counts: Record<string, number>;
  destination?: 'local' | 'google_drive' | string | null;
  drive_file_id?: string | null;
  include_files?: boolean;
  encrypted?: boolean;
  notes?: string | null;
  created_at: string;
}

// ============================================================================
// Phase P6: DecorBiz Sites, Material Estimates, Import & Drive
// ============================================================================
export interface PartySiteRecord {
  id: string;
  party_id: string;
  site_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  address: string | null;
  is_active: boolean;
  is_demo?: boolean;
  created_at: string;
}

export interface HardwareEstimateRecord {
  id: string;
  estimate_number: string;
  party_id: string | null;
  party_name: string;
  site_id: string | null;
  site_name: string | null;
  title: string;
  calc_inputs: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  estimated_total: number;
  status: 'open' | 'converted' | 'archived';
  converted_bill_id: string | null;
  notes: string | null;
  is_demo?: boolean;
  created_at: string;
  updated_at: string;
}

export interface ImportErrorRow {
  row: number;
  name: string;
  error: string;
}

export interface ImportJobResult {
  job_id: string;
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  errors: ImportErrorRow[];
}

export interface DriveConnectionStatus {
  oauthConfigured: boolean;
  integrationEnabled: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  redirectUri: string;
  connected: boolean;
  connectedEmail: string | null;
  folderId: string | null;
  folderName: string;
  scheduleEnabled: boolean;
  scheduleFrequency: 'daily' | 'weekly';
  retentionCount: number;
  lastSyncAt: string | null;
  lastSyncStatus: 'never' | 'ok' | 'error' | 'disconnected' | string;
  lastError: string | null;
}

export interface DriveBackupFile {
  id: string;
  name: string;
  size?: string;
  createdTime?: string;
}

// ============================================================================
// Phase P7: Optional AI, Double-Entry Accounting, Advanced GST, POS-Lite, Ops & Messaging
// ============================================================================
export interface AiProviderProfileRecord {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'grok' | 'custom';
  base_url: string | null;
  model: string;
  routing_role: 'default' | 'chat' | 'analytics' | 'automation';
  daily_token_limit: number;
  has_key: boolean;
  is_active: boolean;
  last_tested_at: string | null;
  last_test_status: string;
  created_at: string;
}

export interface AiConversationRecord {
  id: string;
  user_id: string;
  title: string;
  language: 'en' | 'hi' | 'hinglish';
  created_at: string;
  updated_at: string;
}

export interface AiMessageRecord {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  structured_blocks: Array<Record<string, unknown>>;
  tools_used: string[];
  provider: string | null;
  model: string | null;
  tokens_used: number;
  created_at: string;
}

export interface AiPlaybookRecord {
  id: string;
  playbook_key: string;
  title_en: string;
  title_hi: string;
  description_en: string;
  description_hi: string;
  required_module: string | null;
  enabled: boolean;
  schedule_hint: string;
  last_run_at: string | null;
}

export interface AiActionProposalRecord {
  id: string;
  conversation_id: string | null;
  playbook_key: string | null;
  tool_name: string;
  action_summary: string;
  before_snapshot: Record<string, unknown>;
  proposed_payload: Record<string, unknown>;
  consequences: string[];
  payload_hash: string;
  expires_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed';
  proposed_by_user_id: string;
  proposed_by_role: string;
  approved_by_user_id: string | null;
  rejection_reason: string | null;
  execution_result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
}

export interface AccountGroupRecord {
  id: string;
  code: string;
  name: string;
  nature: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
}

export interface LedgerAccountRecord {
  id: string;
  code: string;
  name: string;
  group_id: string;
  opening_balance: number;
  opening_side: 'debit' | 'credit';
  is_bank: boolean;
  bank_account_no: string | null;
  ifsc_code: string | null;
  is_system: boolean;
  is_active: boolean;
}

export interface VoucherRecord {
  id: string;
  voucher_number: string;
  voucher_type: 'journal' | 'contra' | 'receipt' | 'payment' | 'sales' | 'purchase' | 'debit_note' | 'credit_note';
  voucher_date: string;
  narration: string | null;
  status: 'posted' | 'voided';
  total_debit: number;
  total_credit: number;
  created_at: string;
}

export interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  group_name: string;
  nature: string;
  closing_dr: number;
  closing_cr: number;
}

export interface FinancialStatementsResult {
  from_date: string;
  to_date: string;
  trial_balance: {
    rows: TrialBalanceRow[];
    total_debit: number;
    total_credit: number;
    is_balanced: boolean;
  };
  profit_and_loss: {
    total_income: number;
    total_expense: number;
    net_profit: number;
  };
  balance_sheet: {
    total_assets: number;
    total_liabilities: number;
    total_equity_with_profit: number;
    difference: number;
  };
}

export interface BankReconciliationRow {
  id: string;
  ledger_id: string;
  statement_date: string;
  bank_reference: string | null;
  description: string;
  entry_side: 'debit' | 'credit';
  amount: number;
  matched_voucher_id: string | null;
  status: 'unmatched' | 'matched' | 'reconciled';
}

export interface EinvoiceRecord {
  id: string;
  bill_id: string;
  irn: string | null;
  ack_no: string | null;
  ack_date: string | null;
  qr_payload: string | null;
  status: 'pending' | 'generated' | 'cancelled' | 'failed';
  eway_bill_no: string | null;
  eway_valid_until: string | null;
  vehicle_no: string | null;
  transporter_name: string | null;
  distance_km: number | null;
  error_message: string | null;
  created_at: string;
}

export interface TdsEntryRecord {
  id: string;
  tax_type: 'TDS' | 'TCS';
  section_code: string;
  party_id: string | null;
  party_name: string;
  pan_no: string | null;
  entry_date: string;
  base_amount: number;
  rate_pct: number;
  tax_amount: number;
  challan_no: string | null;
  status: 'pending' | 'deposited';
  notes: string | null;
}

export interface LocationRecord {
  id: string;
  code: string;
  name: string;
  location_type: 'shop' | 'godown' | 'branch';
  address: string | null;
  is_default: boolean;
  is_active: boolean;
}

export interface StockTransferRecord {
  id: string;
  transfer_number: string;
  from_location_id: string;
  to_location_id: string;
  item_id: string;
  qty: number;
  transfer_date: string;
  notes: string | null;
  status: 'completed' | 'cancelled';
  created_at: string;
}

export interface PosCashRegisterRecord {
  id: string;
  register_date: string;
  opening_cash: number;
  expected_cash: number;
  counted_cash: number | null;
  variance: number | null;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
}

export interface OfflineBillQueueItem {
  local_id: string;
  idempotency_key: string;
  doc_type: 'tax_invoice' | 'bill_of_supply';
  party_id: string | null;
  party_name: string;
  bill_date: string;
  lines: Array<{
    item_id: string;
    item_name: string;
    entered_qty: number;
    entered_unit_id: string;
    unit_price: number;
    discount_pct: number;
    tax_inclusive?: boolean;
  }>;
  paid_amount: number;
  payment_mode: PaymentMode;
  payment_reference: string | null;
  grand_total_estimate: number;
  notes: string | null;
  created_at: string;
  sync_status: 'queued' | 'error';
  sync_error: string | null;
}

export interface OfflineSyncResultItem {
  local_id: string;
  idempotency_key: string;
  status: 'synced' | 'deduplicated' | 'error';
  bill_id?: string;
  bill_number?: string;
  error?: string;
}

export interface MessageTemplateRecord {
  id: string;
  template_key: string;
  channel: 'whatsapp' | 'sms' | 'email';
  name: string;
  subject: string | null;
  body_en: string;
  body_hi: string;
  is_active: boolean;
}

export interface MessageLogRecord {
  id: string;
  channel: 'whatsapp' | 'sms' | 'email';
  recipient: string;
  template_key: string | null;
  rendered_body: string;
  status: 'queued' | 'sent' | 'failed';
  error_message: string | null;
  created_at: string;
}

// ============================================================================
// Step 4: Retail Storefront & E-Commerce Fulfillment Types
// ============================================================================
export interface CustomerRecord {
  id: string;
  auth_user_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  default_address: string | null;
  default_pincode: string | null;
  email_verified: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PublishedStoreVariantRecord {
  id: string;
  variant_name: string;
  size_label: string | null;
  finish: string | null;
  shade: string | null;
  sku: string | null;
  selling_price: number;
  mrp: number | null;
  available_qty: number;
}

export interface PublishedStoreItemRecord {
  id: string;
  name: string;
  sku: string | null;
  item_type: 'goods' | 'service';
  product_line: ProductLineKey;
  category_id: string | null;
  category_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  base_unit_code: string;
  base_unit_name_en: string;
  selling_price: number;
  online_price: number | null;
  effective_price: number;
  mrp: number | null;
  gst_rate: number;
  tax_inclusive: boolean;
  allow_negative_stock: boolean;
  primary_image_file_id: string | null;
  warranty_months: number | null;
  video_url: string | null;
  description: string | null;
  online_description: string | null;
  online_slug: string;
  specs: AnySpecsMap | null;
  qty_on_hand: number;
  reserved_qty: number;
  available_qty: number;
  in_stock: boolean;
  image_file_ids: string[];
  variants: PublishedStoreVariantRecord[];
  avg_rating?: number;
  review_count?: number;
  created_at: string;
  updated_at: string;
}

export interface StoreDeliveryZoneRecord {
  id: string;
  zone_name: string;
  pincodes: string[];
  area_keywords: string[];
  delivery_charge: number;
  min_order_amount: number;
  estimated_days: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoreCouponRecord {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'pct' | 'flat';
  discount_value: number;
  min_order_amount: number;
  max_discount: number | null;
  valid_until: string | null;
  usage_limit: number | null;
  used_count: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoreBannerRecord {
  id: string;
  title: string;
  subtitle: string | null;
  cta_label: string | null;
  cta_link: string | null;
  image_file_id: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface StorePageRecord {
  id: string;
  slug: string;
  title: string;
  content: string;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoreDeliveryTripRecord {
  id: string;
  trip_number: string;
  trip_date: string;
  driver_name: string;
  driver_phone: string | null;
  vehicle_no: string | null;
  status: 'planned' | 'dispatched' | 'completed' | 'cancelled';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type StoreOrderStatus =
  | 'pending'
  | 'confirmed'
  | 'packing'
  | 'out_for_delivery'
  | 'ready_for_pickup'
  | 'delivered'
  | 'picked_up'
  | 'cancelled';

export type StorePaymentMethod = 'cod' | 'pay_on_pickup' | 'razorpay';
export type StorePaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded';

export interface StoreOrderLineRecord {
  id: string;
  order_id: string;
  item_id: string;
  variant_id: string | null;
  item_name: string;
  variant_name: string | null;
  sku: string | null;
  ordered_unit: string;
  ordered_qty: number;
  base_qty: number;
  unit_price: number;
  line_total: number;
  wastage_pct: number;
  created_at: string;
}

export interface StoreOrderRecord {
  id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  status: StoreOrderStatus;
  fulfillment_type: 'delivery' | 'pickup';
  zone_id: string | null;
  delivery_address: string | null;
  delivery_pincode: string | null;
  delivery_area: string | null;
  coupon_code: string | null;
  subtotal: number;
  discount_amount: number;
  delivery_charge: number;
  grand_total: number;
  payment_method: StorePaymentMethod;
  payment_status: StorePaymentStatus;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  delivery_trip_id: string | null;
  stock_state: 'none' | 'reserved' | 'deducted' | 'released';
  customer_notes: string | null;
  internal_notes: string | null;
  confirmed_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  lines?: StoreOrderLineRecord[];
  delivery_trip?: StoreDeliveryTripRecord | null;
}

export interface ProductReviewRecord {
  id: string;
  item_id: string;
  customer_id: string;
  customer_name: string;
  rating: number;
  title: string | null;
  comment: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  updated_at: string;
  item_name?: string;
}

export interface BreakageReturnRecord {
  id: string;
  return_number: string;
  bill_id: string | null;
  party_id: string | null;
  item_id: string;
  variant_id: string | null;
  shade: string | null;
  batch_lot: string | null;
  qty: number;
  unit_id: string;
  reason: string;
  disposition: 'replace' | 'credit' | 'write_off';
  credit_amount: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SampleIssueRecord {
  id: string;
  sample_number: string;
  party_id: string | null;
  party_name: string;
  item_id: string;
  variant_id: string | null;
  shade: string | null;
  qty: number;
  unit_id: string;
  issued_date: string;
  expected_return_date: string | null;
  returned_date: string | null;
  status: 'issued' | 'returned' | 'kept' | 'cancelled';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractorRateCardRecord {
  id: string;
  party_id: string;
  item_id: string;
  variant_id: string | null;
  agreed_rate: number;
  discount_pct: number;
  min_qty: number;
  valid_until: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CommissionEntryRecord {
  id: string;
  party_id: string | null;
  party_name: string;
  bill_id: string | null;
  bill_number: string | null;
  bill_date: string;
  base_amount: number;
  commission_pct: number;
  commission_amount: number;
  status: 'pending' | 'approved' | 'paid' | 'cancelled';
  paid_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierPriceListRecord {
  id: string;
  party_id: string;
  item_id: string;
  supplier_sku: string | null;
  supplier_rate: number;
  moq: number;
  lead_time_days: number;
  valid_until: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ErpDeliveryTripRecord {
  id: string;
  trip_number: string;
  trip_date: string;
  party_id: string | null;
  party_name: string;
  site_id: string | null;
  site_name: string | null;
  bill_id: string | null;
  driver_name: string;
  driver_phone: string | null;
  vehicle_no: string | null;
  status: 'planned' | 'dispatched' | 'delivered' | 'cancelled';
  notes: string | null;
  created_at: string;
  updated_at: string;
}
