export type UserRole =
  | 'owner'
  | 'manager'
  | 'cashier'
  | 'storekeeper'
  | 'accountant'
  | 'viewer';

export type Capability =
  | 'create_bills'
  | 'void_bill'
  | 'payments'
  | 'parties'
  | 'items'
  | 'view_profit'
  | 'stock_adjustment'
  | 'purchases'
  | 'expenses'
  | 'reports'
  | 'export_data'
  | 'backup'
  | 'manage_settings';

const ROLE_MATRIX: Record<UserRole, Capability[]> = {
  owner: [
    'create_bills',
    'void_bill',
    'payments',
    'parties',
    'items',
    'view_profit',
    'stock_adjustment',
    'purchases',
    'expenses',
    'reports',
    'export_data',
    'backup',
    'manage_settings',
  ],
  manager: [
    'create_bills',
    'void_bill',
    'payments',
    'parties',
    'items',
    'view_profit',
    'stock_adjustment',
    'purchases',
    'expenses',
    'reports',
    'export_data',
    'backup',
  ],
  cashier: ['create_bills', 'payments', 'parties', 'expenses', 'reports'],
  storekeeper: ['items', 'stock_adjustment', 'purchases', 'reports'],
  accountant: [
    'create_bills',
    'payments',
    'parties',
    'view_profit',
    'purchases',
    'expenses',
    'reports',
    'export_data',
    'backup',
  ],
  viewer: ['reports'],
};

export const ROLE_LABELS: Record<
  UserRole,
  { en: string; hi: string; summaryEn: string }
> = {
  owner: {
    en: 'Owner',
    hi: 'ओनर (मालिक)',
    summaryEn: 'Full business control, staff, modules, integrations, and backups.',
  },
  manager: {
    en: 'Manager',
    hi: 'मैनेजर',
    summaryEn: 'Daily operations, void bills, purchases, stock, and reports.',
  },
  cashier: {
    en: 'Cashier',
    hi: 'कैशियर',
    summaryEn: 'Fast billing, receive payments, add parties, and own expenses.',
  },
  storekeeper: {
    en: 'Storekeeper',
    hi: 'स्टोरकीपर',
    summaryEn: 'Items catalogue, stock adjustments, and supplier purchases.',
  },
  accountant: {
    en: 'Accountant',
    hi: 'अकाउंटेंट',
    summaryEn: 'GST reports, ledgers, purchases, expenses, and data exports.',
  },
  viewer: {
    en: 'View-only',
    hi: 'केवल देखें',
    summaryEn: 'Read-only access to dashboard and standard reports.',
  },
};

export function hasCapability(
  role: UserRole | undefined | null,
  cap: Capability
): boolean {
  if (!role) return false;
  return ROLE_MATRIX[role]?.includes(cap) ?? false;
}
