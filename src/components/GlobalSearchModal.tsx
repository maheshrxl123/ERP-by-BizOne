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

export function GlobalSearchModal({
  open,
  onClose,
  onNavigate,
}: GlobalSearchModalProps) {
  const { business, staff, profile, isModuleEnabled, language, t } = useApp();
  const [query, setQuery] = useState('');
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
    let active = true;
    setQuery('');
    if (canSearchBills) {
      supabase
        .from('bill_list_view')
        .select('*')
        .order('bill_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(100)
        .then(({ data, error }) => {
          if (active) setBills(error ? [] : ((data as BillRecord[] | null) ?? []));
        });
    } else {
      setBills([]);
    }

    if (canSearchParties) {
      supabase
        .from('party_balances')
        .select('*')
        .eq('is_active', true)
        .order('name')
        .limit(100)
        .then(({ data, error }) => {
          if (active) setParties(error ? [] : ((data as PartyBalanceRecord[] | null) ?? []));
        });
    } else {
      setParties([]);
    }

    if (canSearchItems) {
      supabase
        .from('item_catalog_view')
        .select('*')
        .eq('is_active', true)
        .order('name')
        .limit(150)
        .then(({ data, error }) => {
          if (active) setCatalogItems(error ? [] : ((data as ItemCatalogRecord[] | null) ?? []));
        });
    } else {
      setCatalogItems([]);
    }

    if (canSearchPurchases) {
      supabase
        .from('purchase_list_view')
        .select('*')
        .order('bill_date', { ascending: false })
        .limit(60)
        .then(({ data, error }) => {
          if (active) setPurchases(error ? [] : ((data as PurchaseBillRecord[] | null) ?? []));
        });
    } else {
      setPurchases([]);
    }

    if (canSearchExpenses) {
      supabase
        .from('expense_list_view')
        .select('*')
        .order('expense_date', { ascending: false })
        .limit(60)
        .then(({ data, error }) => {
          if (active) setExpenses(error ? [] : ((data as ExpenseRecord[] | null) ?? []));
        });
    } else {
      setExpenses([]);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      active = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [
    open,
    onClose,
    canSearchBills,
    canSearchParties,
    canSearchItems,
    canSearchPurchases,
    canSearchExpenses,
  ]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items: Array<{
      id: string;
      title: string;
      subtitle: string;
      action: () => void;
    }> = [
      {
        id: 'dest-home',
        title: t('nav.home'),
        subtitle: 'Dashboard & onboarding checklist',
        action: () => onNavigate('home'),
      },
      {
        id: 'dest-profile',
        title: t('nav.profile'),
        subtitle: 'Edit name, phone, photo, email, or password',
        action: () => onNavigate('profile'),
      },
      {
        id: 'dest-help',
        title: t('nav.help'),
        subtitle: 'Quick start guides & shortcuts',
        action: () => onNavigate('help'),
      },
      {
        id: 'dest-pack',
        title: getPackWorkspaceTitle(business?.pack, language),
        subtitle: 'Tile & material estimator, contractor sites, and project quotations',
        action: () => onNavigate('pack'),
      },
    ];
    if (['owner', 'manager', 'storekeeper', 'accountant'].includes(profile?.role ?? '')) {
      items.push({
        id: 'dest-data',
        title: t('nav.data'),
        subtitle: 'CSV / XLSX import mapping, error reports & multi-sheet exports',
        action: () => onNavigate('data'),
      });
    }

    if (canSearchBills) {
      items.push({
        id: 'dest-bills',
        title: t('bills.title'),
        subtitle: t('bills.subtitle'),
        action: () => onNavigate('bills'),
      });
      for (const b of bills) {
        items.push({
          id: `bill-${b.id}`,
          title: b.bill_number || `Draft · ${b.party_name}`,
          subtitle: `${b.party_name}${b.party_phone ? ` · ${b.party_phone}` : ''} · ${formatINR(Number(b.grand_total))} · ${b.payment_status.toUpperCase()}`,
          action: () => onNavigate('bills', undefined, { billId: b.id }),
        });
      }
    }

    if (canSearchItems) {
      items.push({
        id: 'dest-items',
        title: t('nav.items'),
        subtitle: t('items.subtitle'),
        action: () => onNavigate('items'),
      });
      for (const it of catalogItems) {
        items.push({
          id: `item-${it.id}`,
          title: it.name,
          subtitle: `${it.category_name || 'Item'}${it.sku ? ` · SKU ${it.sku}` : ''}${
            it.barcode ? ` · ${it.barcode}` : ''
          } · ${formatINR(Number(it.selling_price))} · ${it.qty_on_hand} ${it.base_unit_code}`,
          action: () => onNavigate('items', undefined, { itemId: it.id }),
        });
      }
    }

    if (canSearchParties) {
      items.push({
        id: 'dest-parties',
        title: t('nav.parties'),
        subtitle: t('parties.subtitle'),
        action: () => onNavigate('parties'),
      });
      if (isModuleEnabled('payments') && hasCapability(profile?.role, 'payments')) {
        items.push({
          id: 'dest-payments',
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
        items.push({
          id: `party-${p.party_id}`,
          title: p.name,
          subtitle: `${t(`parties.${p.party_type}`)}${p.phone ? ` · ${p.phone}` : ''}${
            p.gstin ? ` · ${p.gstin}` : ''
          } · ${balText}`,
          action: () =>
            onNavigate('parties', undefined, { partyId: p.party_id }),
        });
      }
    }

    if (canSearchPurchases) {
      items.push({
        id: 'dest-purchases',
        title: t('purchases.title'),
        subtitle: t('purchases.subtitle'),
        action: () => onNavigate('purchases'),
      });
      for (const pur of purchases) {
        items.push({
          id: `purchase-${pur.id}`,
          title: pur.purchase_number || `Draft · ${pur.party_name}`,
          subtitle: `${pur.party_name}${pur.supplier_invoice_no ? ` · Inv ${pur.supplier_invoice_no}` : ''} · ${formatINR(Number(pur.grand_total))}`,
          action: () => onNavigate('purchases'),
        });
      }
    }

    if (canSearchExpenses) {
      items.push({
        id: 'dest-expenses',
        title: t('expenses.title'),
        subtitle: t('expenses.subtitle'),
        action: () => onNavigate('expenses'),
      });
      for (const exp of expenses) {
        items.push({
          id: `expense-${exp.id}`,
          title: `${exp.expense_number} · ${language === 'hi' ? exp.category_name_hi : exp.category_name_en}`,
          subtitle: `${exp.paid_to || exp.payment_mode} · ${formatINR(Number(exp.amount))}`,
          action: () => onNavigate('expenses'),
        });
      }
    }

    if (canSeeReports) {
      items.push({
        id: 'dest-reports',
        title: t('reports.title'),
        subtitle: t('reports.subtitle'),
        action: () => onNavigate('reports'),
      });
    }
    if (isModuleEnabled('pos') && canSearchBills) {
      items.push({
        id: 'dest-pos',
        title: t('nav.pos'),
        subtitle: 'Fast POS counter billing, hold bills, register shift & offline queue',
        action: () => onNavigate('pos'),
      });
    }
    if (
      isModuleEnabled('accounting') &&
      ['owner', 'manager', 'accountant'].includes(profile?.role ?? '')
    ) {
      items.push({
        id: 'dest-accounting',
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
      items.push({
        id: 'dest-gst',
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
      items.push({
        id: 'dest-operations',
        title: isModuleEnabled('locations') ? t('nav.operations') : 'Operations',
        subtitle: isModuleEnabled('locations')
          ? 'Godown transfers, physical stock counts, orders, leads & cheque register'
          : 'Physical stock counts, orders, leads & cheque register',
        action: () => onNavigate('operations'),
      });
    }
    if (
      isModuleEnabled('messaging') &&
      ['owner', 'manager', 'cashier', 'accountant'].includes(profile?.role ?? '')
    ) {
      items.push({
        id: 'dest-messaging',
        title: t('nav.messaging'),
        subtitle: isModuleEnabled('email_notifications')
          ? 'WhatsApp, SMS & Email templates and delivery logs'
          : 'WhatsApp & SMS templates and delivery logs',
        action: () => onNavigate('messaging'),
      });
    }
    if (isModuleEnabled('ai')) {
      items.push({
        id: 'dest-ai',
        title: t('nav.ai'),
        subtitle: 'Optional AI Chat (EN/HI/Hinglish), analytics, playbooks & approvals',
        action: () => onNavigate('ai'),
      });
    }
    if (
      isModuleEnabled('online_store') &&
      ['owner', 'manager'].includes(profile?.role ?? '')
    ) {
      items.push({
        id: 'dest-online-store',
        title: t('nav.onlineStore'),
        subtitle: 'Online Store configuration & credentials',
        action: () => onNavigate('online_store'),
      });
    }

    if (canSeeBackup) {
      items.push({
        id: 'set-backup',
        title: t('settings.tabs.backup'),
        subtitle: isModuleEnabled('google_drive_backup')
          ? 'Settings · Local JSON backup, Google Drive sync & storage usage'
          : 'Settings · Export JSON backup, checksum verification & storage usage',
        action: () => onNavigate('settings', 'backup'),
      });
    }

    if (profile?.role === 'owner') {
      items.push(
        {
          id: 'set-biz',
          title: t('settings.tabs.business'),
          subtitle: 'Settings · Business logo, address, GSTIN',
          action: () => onNavigate('settings', 'business'),
        },
        {
          id: 'set-mod',
          title: t('settings.tabs.modules'),
          subtitle: 'Settings · Enable or disable modules',
          action: () => onNavigate('settings', 'modules'),
        },
        {
          id: 'set-users',
          title: t('settings.tabs.users'),
          subtitle: 'Settings · Add staff and assign roles',
          action: () => onNavigate('settings', 'users'),
        },
        {
          id: 'set-int',
          title: t('settings.tabs.integrations'),
          subtitle: 'Settings · Encrypted optional provider keys',
          action: () => onNavigate('settings', 'integrations'),
        },
        {
          id: 'set-data',
          title: t('settings.tabs.data'),
          subtitle: 'Settings · CSV/XLSX bulk import & multi-sheet export',
          action: () => onNavigate('settings', 'data'),
        }
      );

      for (const member of staff) {
        items.push({
          id: `staff-${member.id}`,
          title: member.full_name,
          subtitle: `Staff · ${member.email} · ${member.role}`,
          action: () => onNavigate('settings', 'users'),
        });
      }

      for (const mod of MODULE_REGISTRY) {
        items.push({
          id: `mod-${mod.key}`,
          title: language === 'hi' ? mod.nameHi : mod.nameEn,
          subtitle: language === 'hi' ? mod.descriptionHi : mod.descriptionEn,
          action: () => onNavigate('settings', 'modules'),
        });
      }
    }

    if (!q) return items.slice(0, 8);
    return items
      .filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.subtitle.toLowerCase().includes(q)
      )
      .slice(0, 10);
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
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 text-[var(--text-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-[var(--border)]">
          {results.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--text-muted)]">
              No matching screens, modules, or staff found.
            </div>
          ) : (
            results.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  item.action();
                  onClose();
                }}
                className="w-full px-4 py-3 text-left hover:bg-[var(--surface-muted)] transition-colors"
              >
                <div className="text-sm font-medium">{item.title}</div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5">
                  {item.subtitle}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
