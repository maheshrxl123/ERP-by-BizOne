import { IconSearch, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { MODULE_REGISTRY } from '../../config/modules.config';
import { useApp } from '../app/AppProvider';
import { formatINR } from '../core/format';
import { hasCapability } from '../core/permissions';
import { supabase } from '../core/supabase';
import { getPackWorkspaceTitle } from '../packs/registry';
import type {
  AppDestination,
  NavigationAction,
} from '../modules/dashboard/HomeScreen';
import type { ItemFilterTab } from '../modules/items/ItemsScreen';
import type {
  BillRecord,
  ExpenseRecord,
  ItemCatalogRecord,
  PartyBalanceRecord,
  PurchaseBillRecord,
} from '../types/decorbiz';

interface GlobalSearchModalProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (
    dest: AppDestination,
    settingsTab?: string,
    opts?: {
      partyId?: string | null;
      itemId?: string | null;
      billId?: string | null;
      itemFilter?: ItemFilterTab | null;
      action?: NavigationAction | null;
    }
  ) => void;
}

type SearchCategory =
  | 'Screens & Modules'
  | 'Items'
  | 'Parties'
  | 'Bills'
  | 'Purchases'
  | 'Expenses'
  | 'Staff';

interface SearchEntry {
  id: string;
  category: SearchCategory;
  title: string;
  subtitle: string;
  keywords?: string;
  action: () => void;
}

export function GlobalSearchModal({
  open,
  onClose,
  onNavigate,
}: GlobalSearchModalProps) {
  const { business, staff, profile, isModuleEnabled, language, t } = useApp();
  const [query, setQuery] = useState('');
  const [searchingRemote, setSearchingRemote] = useState(false);
  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [catalogItems, setCatalogItems] = useState<ItemCatalogRecord[]>([]);
  const [bills, setBills] = useState<BillRecord[]>([]);
  const [purchases, setPurchases] = useState<PurchaseBillRecord[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);

  const canSearchBills =
    isModuleEnabled('billing') && hasCapability(profile?.role, 'create_bills');
  const canSearchParties =
    isModuleEnabled('parties') && hasCapability(profile?.role, 'parties');
  const canSearchItems =
    isModuleEnabled('inventory') &&
    (hasCapability(profile?.role, 'items') ||
      hasCapability(profile?.role, 'create_bills'));
  const canSearchPurchases =
    isModuleEnabled('purchases') && hasCapability(profile?.role, 'purchases');
  const canSearchExpenses =
    isModuleEnabled('expenses') && hasCapability(profile?.role, 'expenses');
  const canSeeReports =
    isModuleEnabled('reports') && hasCapability(profile?.role, 'reports');
  const canSeeBackup =
    isModuleEnabled('backup') && hasCapability(profile?.role, 'backup');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const cleanQ = query.trim().replace(/[%_,]/g, ' ');
    const isFiltered = cleanQ.length >= 1;
    const timer = window.setTimeout(async () => {
      if (isFiltered && active) setSearchingRemote(true);
      try {
        const tasks: Array<Promise<void>> = [];

        if (canSearchBills) {
          let req = supabase
            .from('bill_list_view')
            .select('*')
            .order('bill_date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(isFiltered ? 25 : 100);
          if (isFiltered) {
            req = req.or(
              `bill_number.ilike.%${cleanQ}%,party_name.ilike.%${cleanQ}%,party_phone.ilike.%${cleanQ}%`
            );
          }
          tasks.push(
            Promise.resolve(req).then(({ data, error }) => {
              if (active) setBills(error ? [] : ((data as BillRecord[] | null) ?? []));
            })
          );
        } else {
          setBills([]);
        }

        if (canSearchParties) {
          let req = supabase
            .from('party_balances')
            .select('*')
            .eq('is_active', true)
            .order('name')
            .limit(isFiltered ? 25 : 100);
          if (isFiltered) {
            req = req.or(
              `name.ilike.%${cleanQ}%,phone.ilike.%${cleanQ}%,gstin.ilike.%${cleanQ}%,email.ilike.%${cleanQ}%`
            );
          }
          tasks.push(
            Promise.resolve(req).then(({ data, error }) => {
              if (active) setParties(error ? [] : ((data as PartyBalanceRecord[] | null) ?? []));
            })
          );
        } else {
          setParties([]);
        }

        if (canSearchItems) {
          let req = supabase
            .from('item_catalog_view')
            .select('*')
            .eq('is_active', true)
            .order('name')
            .limit(isFiltered ? 30 : 150);
          if (isFiltered) {
            req = req.or(
              `name.ilike.%${cleanQ}%,sku.ilike.%${cleanQ}%,barcode.ilike.%${cleanQ}%,brand_name.ilike.%${cleanQ}%,category_name.ilike.%${cleanQ}%`
            );
          }
          tasks.push(
            Promise.resolve(req).then(({ data, error }) => {
              if (active) setCatalogItems(error ? [] : ((data as ItemCatalogRecord[] | null) ?? []));
            })
          );
        } else {
          setCatalogItems([]);
        }

        if (canSearchPurchases) {
          let req = supabase
            .from('purchase_list_view')
            .select('*')
            .order('bill_date', { ascending: false })
            .limit(isFiltered ? 20 : 60);
          if (isFiltered) {
            req = req.or(
              `purchase_number.ilike.%${cleanQ}%,party_name.ilike.%${cleanQ}%,supplier_invoice_no.ilike.%${cleanQ}%`
            );
          }
          tasks.push(
            Promise.resolve(req).then(({ data, error }) => {
              if (active) setPurchases(error ? [] : ((data as PurchaseBillRecord[] | null) ?? []));
            })
          );
        } else {
          setPurchases([]);
        }

        if (canSearchExpenses) {
          let req = supabase
            .from('expense_list_view')
            .select('*')
            .order('expense_date', { ascending: false })
            .limit(isFiltered ? 20 : 60);
          if (isFiltered) {
            req = req.or(
              `expense_number.ilike.%${cleanQ}%,paid_to.ilike.%${cleanQ}%,category_name_en.ilike.%${cleanQ}%`
            );
          }
          tasks.push(
            Promise.resolve(req).then(({ data, error }) => {
              if (active) setExpenses(error ? [] : ((data as ExpenseRecord[] | null) ?? []));
            })
          );
        } else {
          setExpenses([]);
        }

        await Promise.all(tasks);
      } finally {
        if (active) setSearchingRemote(false);
      }
    }, isFiltered ? 120 : 0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    open,
    query,
    canSearchBills,
    canSearchParties,
    canSearchItems,
    canSearchPurchases,
    canSearchExpenses,
  ]);

  const groupedResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    const entries: SearchEntry[] = [
      {
        id: 'dest-home',
        category: 'Screens & Modules',
        title: t('nav.home'),
        subtitle: 'Dashboard & onboarding checklist',
        action: () => onNavigate('home'),
      },
      {
        id: 'dest-profile',
        category: 'Screens & Modules',
        title: t('nav.profile'),
        subtitle: 'Edit name, phone, photo, email, or password',
        action: () => onNavigate('profile'),
      },
      {
        id: 'dest-help',
        category: 'Screens & Modules',
        title: t('nav.help'),
        subtitle: 'Quick start guides & shortcuts',
        action: () => onNavigate('help'),
      },
      {
        id: 'dest-pack',
        category: 'Screens & Modules',
        title: getPackWorkspaceTitle(business?.pack, language),
        subtitle: 'Tile & material estimator, contractor sites, and project quotations',
        action: () => onNavigate('pack'),
      },
    ];
    if (['owner', 'manager', 'storekeeper', 'accountant'].includes(profile?.role ?? '')) {
      entries.push({
        id: 'dest-data',
        category: 'Screens & Modules',
        title: t('nav.data'),
        subtitle: 'CSV / XLSX import mapping, error reports & multi-sheet exports',
        action: () => onNavigate('data'),
      });
    }

    if (canSearchBills) {
      entries.push({
        id: 'dest-bills',
        category: 'Screens & Modules',
        title: t('bills.title'),
        subtitle: t('bills.subtitle'),
        action: () => onNavigate('bills'),
      });
      for (const b of bills) {
        entries.push({
          id: `bill-${b.id}`,
          category: 'Bills',
          title: b.bill_number || `Draft · ${b.party_name}`,
          subtitle: `${b.party_name}${b.party_phone ? ` · ${b.party_phone}` : ''} · ${formatINR(Number(b.grand_total))} · ${b.payment_status.toUpperCase()}`,
          keywords: `${b.party_gstin || ''} ${b.doc_type}`,
          action: () => onNavigate('bills', undefined, { billId: b.id }),
        });
      }
    }

    if (canSearchItems) {
      entries.push({
        id: 'dest-items',
        category: 'Screens & Modules',
        title: t('nav.items'),
        subtitle: t('items.subtitle'),
        action: () => onNavigate('items'),
      });
      for (const it of catalogItems) {
        entries.push({
          id: `item-${it.id}`,
          category: 'Items',
          title: it.name,
          subtitle: `${it.category_name || 'Item'}${it.brand_name ? ` · ${it.brand_name}` : ''}${it.sku ? ` · SKU ${it.sku}` : ''}${
            it.barcode ? ` · ${it.barcode}` : ''
          } · ${formatINR(Number(it.selling_price))} · ${it.qty_on_hand} ${it.base_unit_code}`,
          keywords: `${it.hsn_code || ''} ${it.product_line || ''}`,
          action: () => onNavigate('items', undefined, { itemId: it.id }),
        });
      }
    }

    if (canSearchParties) {
      entries.push({
        id: 'dest-parties',
        category: 'Screens & Modules',
        title: t('nav.parties'),
        subtitle: t('parties.subtitle'),
        action: () => onNavigate('parties'),
      });
      if (isModuleEnabled('payments') && hasCapability(profile?.role, 'payments')) {
        entries.push({
          id: 'dest-payments',
          category: 'Screens & Modules',
          title: t('nav.payments'),
          subtitle: t('payments.subtitle'),
          action: () => onNavigate('payments'),
        });
      }
      for (const p of parties) {
        const net = Number(p.net_balance || 0);
        const balText =
          net > 0
            ? `${t('parties.youllGet')} ${formatINR(net)}`
            : net < 0
              ? `${t('parties.youllGive')} ${formatINR(Math.abs(net))}`
              : t('parties.settled');
        entries.push({
          id: `party-${p.party_id}`,
          category: 'Parties',
          title: p.name,
          subtitle: `${t(`parties.${p.party_type}`)}${p.phone ? ` · ${p.phone}` : ''}${
            p.gstin ? ` · ${p.gstin}` : ''
          } · ${balText}`,
          keywords: `${p.email || ''}`,
          action: () =>
            onNavigate('parties', undefined, { partyId: p.party_id }),
        });
      }
    }

    if (canSearchPurchases) {
      entries.push({
        id: 'dest-purchases',
        category: 'Screens & Modules',
        title: t('purchases.title'),
        subtitle: t('purchases.subtitle'),
        action: () => onNavigate('purchases'),
      });
      for (const pur of purchases) {
        entries.push({
          id: `purchase-${pur.id}`,
          category: 'Purchases',
          title: pur.purchase_number || `Draft · ${pur.party_name}`,
          subtitle: `${pur.party_name}${pur.supplier_invoice_no ? ` · Inv ${pur.supplier_invoice_no}` : ''} · ${formatINR(Number(pur.grand_total))}`,
          action: () => onNavigate('purchases'),
        });
      }
    }

    if (canSearchExpenses) {
      entries.push({
        id: 'dest-expenses',
        category: 'Screens & Modules',
        title: t('expenses.title'),
        subtitle: t('expenses.subtitle'),
        action: () => onNavigate('expenses'),
      });
      for (const exp of expenses) {
        entries.push({
          id: `expense-${exp.id}`,
          category: 'Expenses',
          title: `${exp.expense_number} · ${language === 'hi' ? exp.category_name_hi : exp.category_name_en}`,
          subtitle: `${exp.paid_to || exp.payment_mode} · ${formatINR(Number(exp.amount))}`,
          action: () => onNavigate('expenses'),
        });
      }
    }

    if (canSeeReports) {
      entries.push({
        id: 'dest-reports',
        category: 'Screens & Modules',
        title: t('reports.title'),
        subtitle: t('reports.subtitle'),
        action: () => onNavigate('reports'),
      });
    }
    if (isModuleEnabled('pos') && canSearchBills) {
      entries.push({
        id: 'dest-pos',
        category: 'Screens & Modules',
        title: t('nav.pos'),
        subtitle: 'Fast POS counter billing, hold bills & register shift',
        action: () => onNavigate('pos'),
      });
    }
    if (
      isModuleEnabled('accounting') &&
      ['owner', 'manager', 'accountant'].includes(profile?.role ?? '')
    ) {
      entries.push({
        id: 'dest-accounting',
        category: 'Screens & Modules',
        title: t('nav.accounting'),
        subtitle: 'Double-entry vouchers, Trial Balance, P&L, Balance Sheet & reconciliation',
        action: () => onNavigate('accounting'),
      });
    }
    if (
      isModuleEnabled('gst_returns') &&
      isModuleEnabled('tax') &&
      ['owner', 'manager', 'accountant'].includes(profile?.role ?? '')
    ) {
      entries.push({
        id: 'dest-gst',
        category: 'Screens & Modules',
        title: isModuleEnabled('einvoice') ? t('nav.gst') : 'GST Returns',
        subtitle: isModuleEnabled('einvoice')
          ? 'GSTR-1, GSTR-3B, GSTR-2B ITC match, E-Invoice / EWB & TDS/TCS'
          : 'GSTR-1, GSTR-3B, GSTR-2B ITC match & TDS/TCS',
        action: () => onNavigate('gst'),
      });
    }
    if (
      (isModuleEnabled('inventory') || isModuleEnabled('locations')) &&
      ['owner', 'manager', 'storekeeper', 'cashier', 'accountant'].includes(profile?.role ?? '')
    ) {
      entries.push({
        id: 'dest-operations',
        category: 'Screens & Modules',
        title: isModuleEnabled('locations') ? t('nav.operations') : 'Operations',
        subtitle: 'Godown transfers, physical stock counts, orders, leads & cheque register',
        action: () => onNavigate('operations'),
      });
    }
    if (
      isModuleEnabled('messaging') &&
      ['owner', 'manager', 'cashier', 'accountant'].includes(profile?.role ?? '')
    ) {
      entries.push({
        id: 'dest-messaging',
        category: 'Screens & Modules',
        title: t('nav.messaging'),
        subtitle: isModuleEnabled('email_notifications')
          ? 'WhatsApp, SMS & Email templates and delivery logs'
          : 'WhatsApp & SMS templates and delivery logs',
        action: () => onNavigate('messaging'),
      });
    }
    if (isModuleEnabled('ai')) {
      entries.push({
        id: 'dest-ai',
        category: 'Screens & Modules',
        title: t('nav.ai'),
        subtitle: 'AI Chat (EN/HI/Hinglish), analytics, playbooks & approvals',
        action: () => onNavigate('ai'),
      });
    }
    if (
      isModuleEnabled('online_store') &&
      ['owner', 'manager'].includes(profile?.role ?? '')
    ) {
      entries.push({
        id: 'dest-online-store',
        category: 'Screens & Modules',
        title: t('nav.onlineStore'),
        subtitle: 'Online Store catalogue, orders, coupons & delivery zones',
        action: () => onNavigate('online_store'),
      });
    }

    if (canSeeBackup) {
      entries.push({
        id: 'set-backup',
        category: 'Screens & Modules',
        title: t('settings.tabs.backup'),
        subtitle: isModuleEnabled('google_drive_backup')
          ? 'Settings · Local JSON backup, Google Drive sync & storage usage'
          : 'Settings · Export JSON backup, checksum verification & storage usage',
        action: () => onNavigate('settings', 'backup'),
      });
    }

    if (profile?.role === 'owner') {
      entries.push(
        {
          id: 'set-biz',
          category: 'Screens & Modules',
          title: t('settings.tabs.business'),
          subtitle: 'Settings · Business logo, address, GSTIN',
          action: () => onNavigate('settings', 'business'),
        },
        {
          id: 'set-mod',
          category: 'Screens & Modules',
          title: t('settings.tabs.modules'),
          subtitle: 'Settings · Enable or disable modules',
          action: () => onNavigate('settings', 'modules'),
        },
        {
          id: 'set-users',
          category: 'Screens & Modules',
          title: t('settings.tabs.users'),
          subtitle: 'Settings · Add staff and assign roles',
          action: () => onNavigate('settings', 'users'),
        },
        {
          id: 'set-int',
          category: 'Screens & Modules',
          title: t('settings.tabs.integrations'),
          subtitle: 'Settings · Encrypted optional provider keys',
          action: () => onNavigate('settings', 'integrations'),
        },
        {
          id: 'set-data',
          category: 'Screens & Modules',
          title: t('settings.tabs.data'),
          subtitle: 'Settings · CSV/XLSX bulk import & multi-sheet export',
          action: () => onNavigate('settings', 'data'),
        }
      );

      for (const member of staff) {
        entries.push({
          id: `staff-${member.id}`,
          category: 'Staff',
          title: member.full_name,
          subtitle: `Staff · ${member.email} · ${member.role}`,
          action: () => onNavigate('settings', 'users'),
        });
      }

      for (const mod of MODULE_REGISTRY) {
        entries.push({
          id: `mod-${mod.key}`,
          category: 'Screens & Modules',
          title: language === 'hi' ? mod.nameHi : mod.nameEn,
          subtitle: language === 'hi' ? mod.descriptionHi : mod.descriptionEn,
          action: () => onNavigate('settings', 'modules'),
        });
      }
    }

    const filtered = !q
      ? entries.slice(0, 10)
      : entries
          .filter(
            (i) =>
              i.title.toLowerCase().includes(q) ||
              i.subtitle.toLowerCase().includes(q) ||
              (i.keywords ? i.keywords.toLowerCase().includes(q) : false)
          )
          .slice(0, 24);

    const groups = new Map<SearchCategory, SearchEntry[]>();
    for (const item of filtered) {
      const arr = groups.get(item.category) ?? [];
      arr.push(item);
      groups.set(item.category, arr);
    }
    return Array.from(groups.entries());
  }, [
    query,
    staff,
    bills,
    parties,
    catalogItems,
    purchases,
    expenses,
    canSearchBills,
    canSearchParties,
    canSearchItems,
    canSearchPurchases,
    canSearchExpenses,
    canSeeReports,
    canSeeBackup,
    isModuleEnabled,
    business?.pack,
    profile?.role,
    language,
    t,
    onNavigate,
  ]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 p-4 bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-3">
          <IconSearch size={18} stroke={2} className="text-[var(--text-muted)] shrink-0" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.searchPlaceholder')}
            className="flex-1 bg-transparent text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-dark)] rounded"
          />
          {searchingRemote && (
            <span className="text-[11px] text-[var(--text-muted)] shrink-0">Searching...</span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 text-[var(--text-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {groupedResults.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--text-muted)]">
              No matching bills, items, parties, modules, or staff found.
            </div>
          ) : (
            groupedResults.map(([category, groupItems]) => (
              <div key={category} className="border-b border-[var(--border)] last:border-b-0">
                <div className="px-4 py-1.5 bg-[var(--surface-muted)] text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {category} ({groupItems.length})
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {groupItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        item.action();
                        onClose();
                      }}
                      className="w-full px-4 py-2.5 text-left hover:bg-[var(--surface-muted)] transition-colors"
                    >
                      <div className="text-sm font-medium">{item.title}</div>
                      <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
                        {item.subtitle}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
