import {
  IconBell,
  IconBook,
  IconBriefcase,
  IconBuildingStore,
  IconBuildingWarehouse,
  IconCalculator,
  IconCash,
  IconChartBar,
  IconChevronLeft,
  IconChevronRight,
  IconCreditCard,
  IconFileSpreadsheet,
  IconHelp,
  IconHome,
  IconLanguage,
  IconLogout,
  IconMenu2,
  IconMessage,
  IconMoon,
  IconPackage,
  IconPlus,
  IconReceipt,
  IconRobot,
  IconScale,
  IconSearch,
  IconSettings,
  IconShoppingBag,
  IconSun,
  IconUser,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { GlobalSearchModal } from '../components/GlobalSearchModal';
import { RequireModule, RequireRole } from '../components/RequireGuards';
import { PWAInstallButton } from '../components/pwa/PWAInstallButton';
import { getInitials } from '../core/format';
import { hasCapability, ROLE_LABELS } from '../core/permissions';
import type { AppDestination, NavigationAction } from '../modules/dashboard/HomeScreen';
import type { ItemFilterTab } from '../modules/items/ItemsScreen';
import type { SettingsTabKey } from '../modules/settings/SettingsScreen';
import { getPackWorkspaceTitle } from '../packs/registry';
import { useApp } from './AppProvider';

const AccountingScreen = lazy(() =>
  import('../modules/accounting/AccountingScreen').then((m) => ({
    default: m.AccountingScreen,
  }))
);
const AiAssistantScreen = lazy(() =>
  import('../modules/ai/AiAssistantScreen').then((m) => ({
    default: m.AiAssistantScreen,
  }))
);
const BillsScreen = lazy(() =>
  import('../modules/bills/BillsScreen').then((m) => ({
    default: m.BillsScreen,
  }))
);
const HomeScreen = lazy(() =>
  import('../modules/dashboard/HomeScreen').then((m) => ({
    default: m.HomeScreen,
  }))
);
const ImportExportPanel = lazy(() =>
  import('../modules/data/ImportExportPanel').then((m) => ({
    default: m.ImportExportPanel,
  }))
);
const ExpensesScreen = lazy(() =>
  import('../modules/expenses/ExpensesScreen').then((m) => ({
    default: m.ExpensesScreen,
  }))
);
const AdvancedGstScreen = lazy(() =>
  import('../modules/gst/AdvancedGstScreen').then((m) => ({
    default: m.AdvancedGstScreen,
  }))
);
const HelpScreen = lazy(() =>
  import('../modules/help/HelpScreen').then((m) => ({
    default: m.HelpScreen,
  }))
);
const ItemsScreen = lazy(() =>
  import('../modules/items/ItemsScreen').then((m) => ({
    default: m.ItemsScreen,
  }))
);
const MessagingScreen = lazy(() =>
  import('../modules/messaging/MessagingScreen').then((m) => ({
    default: m.MessagingScreen,
  }))
);
const NotificationsScreen = lazy(() =>
  import('../modules/notifications/NotificationsScreen').then((m) => ({
    default: m.NotificationsScreen,
  }))
);
const OperationsScreen = lazy(() =>
  import('../modules/operations/OperationsScreen').then((m) => ({
    default: m.OperationsScreen,
  }))
);
const PackWorkspaceScreen = lazy(() =>
  import('../modules/packs/PackWorkspaceScreen').then((m) => ({
    default: m.PackWorkspaceScreen,
  }))
);
const PartiesScreen = lazy(() =>
  import('../modules/parties/PartiesScreen').then((m) => ({
    default: m.PartiesScreen,
  }))
);
const PaymentsScreen = lazy(() =>
  import('../modules/payments/PaymentsScreen').then((m) => ({
    default: m.PaymentsScreen,
  }))
);
const PosLiteScreen = lazy(() =>
  import('../modules/pos/PosLiteScreen').then((m) => ({
    default: m.PosLiteScreen,
  }))
);
const UserProfileScreen = lazy(() =>
  import('../modules/profile/UserProfileScreen').then((m) => ({
    default: m.UserProfileScreen,
  }))
);
const PurchasesScreen = lazy(() =>
  import('../modules/purchases/PurchasesScreen').then((m) => ({
    default: m.PurchasesScreen,
  }))
);
const ReportsScreen = lazy(() =>
  import('../modules/reports/ReportsScreen').then((m) => ({
    default: m.ReportsScreen,
  }))
);
const SettingsScreen = lazy(() =>
  import('../modules/settings/SettingsScreen').then((m) => ({
    default: m.SettingsScreen,
  }))
);
const OnlineStoreAdminScreen = lazy(() =>
  import('../modules/store/OnlineStoreAdminScreen').then((m) => ({
    default: m.OnlineStoreAdminScreen,
  }))
);

export function AppShell() {
  const {
    business,
    profile,
    language,
    setLanguage,
    theme,
    setTheme,
    signedUrlCache,
    isModuleEnabled,
    signOut,
    t,
  } = useApp();

  const [dest, setDest] = useState<AppDestination>('home');
  const [settingsTab, setSettingsTab] = useState<SettingsTabKey>('business');
  const [navPartyId, setNavPartyId] = useState<string | null>(null);
  const [navItemId, setNavItemId] = useState<string | null>(null);
  const [navBillId, setNavBillId] = useState<string | null>(null);
  const [navItemFilter, setNavItemFilter] = useState<ItemFilterTab | null>(null);
  const [navAction, setNavAction] = useState<NavigationAction | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const quickDialogRef = useRef<HTMLDivElement | null>(null);
  const moreDialogRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  const isOwner = profile?.role === 'owner';
  const avatarUrl = profile?.avatar_file_id
    ? signedUrlCache[profile.avatar_file_id]
    : undefined;
  const logoUrl = business?.logo_file_id
    ? signedUrlCache[business.logo_file_id]
    : undefined;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setQuickOpen(false);
        setMoreOpen(false);
        setUserMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const activeDialog = quickOpen
      ? quickDialogRef.current
      : moreOpen
        ? moreDialogRef.current
        : null;
    if (!activeDialog) {
      if (lastFocusedRef.current && typeof lastFocusedRef.current.focus === 'function') {
        lastFocusedRef.current.focus();
        lastFocusedRef.current = null;
      }
      return;
    }
    if (!lastFocusedRef.current && document.activeElement instanceof HTMLElement) {
      lastFocusedRef.current = document.activeElement;
    }
    const focusableSelector =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(
      activeDialog.querySelectorAll<HTMLElement>(focusableSelector)
    );
    (focusables[0] ?? activeDialog).focus();

    const handleTrap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleTrap);
    return () => window.removeEventListener('keydown', handleTrap);
  }, [quickOpen, moreOpen]);

  useEffect(() => {
    const labelMap: Record<AppDestination, string> = {
      home: t('nav.home'),
      bills: t('nav.bills'),
      parties: t('nav.parties'),
      items: t('nav.items'),
      purchases: t('nav.purchases'),
      payments: t('nav.payments'),
      expenses: t('nav.expenses'),
      reports: t('nav.reports'),
      pos: t('nav.pos'),
      accounting: t('nav.accounting'),
      gst: t('nav.gst'),
      operations: t('nav.operations'),
      messaging: t('nav.messaging'),
      ai: t('nav.ai'),
      online_store: t('nav.onlineStore'),
      pack: getPackWorkspaceTitle(business?.pack, language),
      data: t('nav.data'),
      notifications: t('nav.notifications'),
      settings: t('nav.settings'),
      profile: t('nav.profile'),
      help: t('nav.help'),
    };
    const sectionTitle = labelMap[dest] || t('app.name');
    const bizTitle = business?.name || 'DecorBiz ERP';
    document.title = `${sectionTitle} — ${bizTitle}`;
  }, [dest, business?.name, business?.pack, language, t]);

  const navigate = useCallback(
    (
      next: AppDestination,
      nextSettingsTab?: string,
      opts?: {
        partyId?: string | null;
        itemId?: string | null;
        billId?: string | null;
        itemFilter?: ItemFilterTab | null;
        action?: NavigationAction | null;
      }
    ) => {
      setDest(next);
      setNavPartyId(opts?.partyId ?? null);
      setNavItemId(opts?.itemId ?? null);
      setNavBillId(opts?.billId ?? null);
      setNavItemFilter(opts?.itemFilter ?? null);
      setNavAction(opts?.action ?? null);
      if (next === 'settings' && nextSettingsTab) {
        setSettingsTab(nextSettingsTab as SettingsTabKey);
      } else if (next === 'settings' && !isOwner) {
        setSettingsTab('appearance');
      }
      setQuickOpen(false);
      setMoreOpen(false);
      setUserMenuOpen(false);
    },
    [isOwner]
  );

  const clearNavIntent = useCallback(() => {
    setNavPartyId(null);
    setNavItemId(null);
    setNavBillId(null);
    setNavItemFilter(null);
    setNavAction(null);
  }, []);

  // Single primary desktop sidebar items gated by module state & role
  const rawSidebarItems: Array<{
    id: AppDestination;
    label: string;
    icon: typeof IconHome;
    visible: boolean;
  }> = [
    { id: 'home', label: t('nav.home'), icon: IconHome, visible: true },
    {
      id: 'bills',
      label: t('nav.bills'),
      icon: IconReceipt,
      visible:
        isModuleEnabled('billing') && hasCapability(profile?.role, 'create_bills'),
    },
    {
      id: 'parties',
      label: t('nav.parties'),
      icon: IconUsers,
      visible:
        isModuleEnabled('parties') && hasCapability(profile?.role, 'parties'),
    },
    {
      id: 'items',
      label: t('nav.items'),
      icon: IconPackage,
      visible:
        isModuleEnabled('inventory') &&
        (hasCapability(profile?.role, 'items') ||
          hasCapability(profile?.role, 'create_bills')),
    },
    {
      id: 'purchases',
      label: t('nav.purchases'),
      icon: IconShoppingBag,
      visible:
        isModuleEnabled('purchases') &&
        hasCapability(profile?.role, 'purchases'),
    },
    {
      id: 'payments',
      label: t('nav.payments'),
      icon: IconCash,
      visible:
        isModuleEnabled('payments') &&
        hasCapability(profile?.role, 'payments'),
    },
    {
      id: 'expenses',
      label: t('nav.expenses'),
      icon: IconCreditCard,
      visible:
        isModuleEnabled('expenses') &&
        hasCapability(profile?.role, 'expenses'),
    },
    {
      id: 'reports',
      label: t('nav.reports'),
      icon: IconChartBar,
      visible:
        isModuleEnabled('reports') && hasCapability(profile?.role, 'reports'),
    },
    {
      id: 'pos',
      label: t('nav.pos'),
      icon: IconCalculator,
      visible:
        isModuleEnabled('pos') &&
        isModuleEnabled('billing') &&
        hasCapability(profile?.role, 'create_bills'),
    },
    {
      id: 'accounting',
      label: t('nav.accounting'),
      icon: IconBook,
      visible:
        isModuleEnabled('accounting') &&
        ['owner', 'manager', 'accountant'].includes(profile?.role ?? ''),
    },
    {
      id: 'gst',
      label: isModuleEnabled('einvoice')
        ? t('nav.gst')
        : language === 'hi'
          ? 'जीएसटी रिटर्न'
          : 'GST Returns',
      icon: IconScale,
      visible:
        isModuleEnabled('gst_returns') &&
        isModuleEnabled('tax') &&
        ['owner', 'manager', 'accountant'].includes(profile?.role ?? ''),
    },
    {
      id: 'operations',
      label: isModuleEnabled('locations')
        ? t('nav.operations')
        : language === 'hi'
          ? 'संचालन'
          : 'Operations',
      icon: IconBuildingWarehouse,
      visible:
        (isModuleEnabled('inventory') || isModuleEnabled('locations')) &&
        ['owner', 'manager', 'storekeeper', 'cashier', 'accountant'].includes(
          profile?.role ?? ''
        ),
    },
    {
      id: 'messaging',
      label: t('nav.messaging'),
      icon: IconMessage,
      visible:
        isModuleEnabled('messaging') &&
        ['owner', 'manager', 'cashier', 'accountant'].includes(profile?.role ?? ''),
    },
    {
      id: 'ai',
      label: t('nav.ai'),
      icon: IconRobot,
      visible: isModuleEnabled('ai'),
    },
    {
      id: 'online_store',
      label: t('nav.onlineStore'),
      icon: IconBuildingStore,
      visible:
        isModuleEnabled('online_store') &&
        ['owner', 'manager'].includes(profile?.role ?? ''),
    },
    {
      id: 'pack',
      label: getPackWorkspaceTitle(business?.pack, language),
      icon: IconBriefcase,
      visible: isModuleEnabled('estimator'),
    },
    {
      id: 'data',
      label: t('nav.data'),
      icon: IconFileSpreadsheet,
      visible: ['owner', 'manager', 'storekeeper', 'accountant'].includes(
        profile?.role ?? ''
      ),
    },
    {
      id: 'notifications',
      label: t('nav.notifications'),
      icon: IconBell,
      visible: true,
    },
    {
      id: 'settings',
      label: t('nav.settings'),
      icon: IconSettings,
      visible: true,
    },
    { id: 'help', label: t('nav.help'), icon: IconHelp, visible: true },
  ];
  const sidebarItems = rawSidebarItems.filter((item) => item.visible);

  const rawQuickActionItems: Array<{
    key: string;
    id: AppDestination;
    action: NavigationAction;
    label: string;
    icon: typeof IconReceipt;
    visible: boolean;
  }> = [
    {
      key: 'new-bill',
      id: 'bills',
      action: 'new-bill',
      label: t('quick.newBill'),
      icon: IconReceipt,
      visible:
        isModuleEnabled('billing') && hasCapability(profile?.role, 'create_bills'),
    },
    {
      key: 'receive-payment',
      id: 'payments',
      action: 'receive-payment',
      label: t('quick.receivePayment'),
      icon: IconCash,
      visible:
        isModuleEnabled('payments') && hasCapability(profile?.role, 'payments'),
    },
    {
      key: 'give-payment',
      id: 'payments',
      action: 'give-payment',
      label: t('quick.givePayment'),
      icon: IconCash,
      visible:
        isModuleEnabled('payments') && hasCapability(profile?.role, 'payments'),
    },
    {
      key: 'add-party',
      id: 'parties',
      action: 'add-party',
      label: t('quick.addParty'),
      icon: IconUsers,
      visible:
        isModuleEnabled('parties') && hasCapability(profile?.role, 'parties'),
    },
    {
      key: 'add-item',
      id: 'items',
      action: 'add-item',
      label: t('quick.addItem'),
      icon: IconPackage,
      visible:
        isModuleEnabled('inventory') && hasCapability(profile?.role, 'items'),
    },
    {
      key: 'add-expense',
      id: 'expenses',
      action: 'add-expense',
      label: t('quick.addExpense'),
      icon: IconCreditCard,
      visible:
        isModuleEnabled('expenses') && hasCapability(profile?.role, 'expenses'),
    },
    {
      key: 'new-purchase',
      id: 'purchases',
      action: 'new-purchase',
      label: t('quick.newPurchase'),
      icon: IconShoppingBag,
      visible:
        isModuleEnabled('purchases') && hasCapability(profile?.role, 'purchases'),
    },
  ];
  const quickActionItems = rawQuickActionItems.filter((item) => item.visible);

  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden flex bg-[var(--bg)] text-[var(--text)]">
      {/* Desktop: ONE Primary Sidebar only (240px expanded / 72px collapsed) with dedicated scroll */}
      <aside
        className={`no-print hidden md:flex flex-col shrink-0 h-screen max-h-screen overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-150 ${
          sidebarCollapsed ? 'w-[72px]' : 'w-[240px]'
        }`}
      >
        <div className="h-14 shrink-0 px-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
          {!sidebarCollapsed && (
            <button
              type="button"
              onClick={() => navigate('home')}
              className="flex items-center gap-2.5 min-w-0 text-left"
            >
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={business?.name || 'Business logo'}
                  width={32}
                  height={32}
                  className="w-8 h-8 rounded-lg object-cover border border-[var(--border)] shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] flex items-center justify-center shrink-0">
                  <IconBuildingStore size={18} stroke={2} />
                </div>
              )}
              <span className="font-semibold text-sm truncate">
                {business?.name || t('app.name')}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)] shrink-0 mx-auto md:mx-0"
          >
            {sidebarCollapsed ? (
              <IconChevronRight size={18} stroke={2} />
            ) : (
              <IconChevronLeft size={18} stroke={2} />
            )}
          </button>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 space-y-1">
          {sidebarItems.map((item) => {
            const Icon = item.icon;
            const active = dest === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                aria-current={active ? 'page' : undefined}
                title={sidebarCollapsed ? item.label : undefined}
                className={`w-full min-h-[44px] px-3 rounded-lg flex items-center gap-3 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)]'
                } ${sidebarCollapsed ? 'justify-center px-0' : ''}`}
              >
                <Icon size={20} stroke={2} className="shrink-0" />
                {!sidebarCollapsed && (
                  <span className="truncate">{item.label}</span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Main Column */}
      <div className="flex-1 min-w-0 md:h-screen md:overflow-y-auto overscroll-contain flex flex-col">
        {/* Top App Bar */}
        <header className="no-print h-14 sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)] px-4 sm:px-6 flex items-center justify-between gap-3">
          {/* Mobile Business Name */}
          <div className="flex items-center gap-2 min-w-0 md:hidden">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={business?.name || 'Business logo'}
                width={28}
                height={28}
                className="w-7 h-7 rounded-lg object-cover border border-[var(--border)] shrink-0"
              />
            ) : (
              <div className="w-7 h-7 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] flex items-center justify-center shrink-0">
                <IconBuildingStore size={16} stroke={2} />
              </div>
            )}
            <span className="font-semibold text-sm truncate">
              {business?.name || t('app.name')}
            </span>
          </div>

          {/* Desktop Global Search Trigger */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden md:flex items-center gap-2 h-9 px-3 w-72 lg:w-80 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <IconSearch size={16} stroke={2} />
            <span className="truncate flex-1 text-left">
              {t('common.searchPlaceholder')}
            </span>
            <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)]">
              ⌘K
            </kbd>
          </button>

          {/* Right Utilities + Profile Menu */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Global search"
              className="md:hidden min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            >
              <IconSearch size={20} stroke={2} />
            </button>

            <div className="hidden sm:block">
              <PWAInstallButton />
            </div>

            {isModuleEnabled('hindi') && (
              <button
                type="button"
                onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')}
                aria-label="Switch language"
                className="hidden sm:inline-flex items-center gap-1 h-9 px-2.5 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
              >
                <IconLanguage size={16} stroke={2} />
                <span>{language === 'en' ? 'हिं' : 'EN'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => navigate('notifications')}
              aria-label={t('nav.notifications')}
              title={t('nav.notifications')}
              className={`w-9 h-9 flex items-center justify-center rounded-lg border transition-colors ${
                dest === 'notifications'
                  ? 'border-[var(--primary-dark)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] hover:bg-[var(--surface-muted)] text-[var(--text)]'
              }`}
            >
              <IconBell size={17} stroke={2} />
            </button>

            <button
              type="button"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              aria-label="Switch theme"
              className="hidden sm:flex w-9 h-9 items-center justify-center rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)]"
            >
              {theme === 'light' ? (
                <IconMoon size={16} stroke={2} />
              ) : (
                <IconSun size={16} stroke={2} />
              )}
            </button>

            {/* Profile Avatar Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                aria-label="Open profile menu"
                className="min-w-[44px] min-h-[44px] flex items-center justify-center gap-2 sm:px-2 rounded-lg hover:bg-[var(--surface-muted)]"
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={profile?.full_name || 'User'}
                    width={32}
                    height={32}
                    className="w-8 h-8 rounded-full object-cover border border-[var(--border)]"
                  />
                ) : (
                  <span className="w-8 h-8 rounded-full bg-[var(--primary-soft)] text-[var(--primary-dark)] text-xs font-semibold flex items-center justify-center">
                    {getInitials(profile?.full_name || 'User')}
                  </span>
                )}
                <span className="hidden lg:inline text-xs font-medium max-w-[120px] truncate">
                  {profile?.full_name}
                </span>
              </button>

              {userMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setUserMenuOpen(false)}
                  />
                  <div className="absolute right-0 mt-1 w-56 z-40 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm py-1.5">
                    <div className="px-4 py-2 border-b border-[var(--border)]">
                      <p className="text-sm font-semibold truncate">
                        {profile?.full_name}
                      </p>
                      <p className="text-xs text-[var(--text-muted)] truncate">
                        {profile?.role
                          ? ROLE_LABELS[profile.role].en
                          : ''}{' '}
                        · {profile?.email}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate('profile')}
                      className="w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-[var(--surface-muted)]"
                    >
                      <IconUser size={16} stroke={2} />
                      <span>{t('nav.profile')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate('settings')}
                      className="w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-[var(--surface-muted)]"
                    >
                      <IconSettings size={16} stroke={2} />
                      <span>{t('nav.settings')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => signOut()}
                      className="w-full px-4 py-2.5 text-left text-sm text-[var(--give)] flex items-center gap-2 hover:bg-[var(--give-soft)]"
                    >
                      <IconLogout size={16} stroke={2} />
                      <span>{t('nav.signOut')}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Scrollable Content Viewport (bottom padded on mobile for 5-control nav) */}
        <main className="flex-1 pb-20 md:pb-8">
          <Suspense
            fallback={
              <div className="p-6 text-sm text-[var(--text-muted)]">
                {t('common.loading')}
              </div>
            }
          >
          {dest === 'home' && <HomeScreen onNavigate={navigate} />}
          {dest === 'profile' && <UserProfileScreen />}
          {dest === 'settings' && <SettingsScreen initialTab={settingsTab} />}
          {dest === 'help' && <HelpScreen />}
          {dest === 'bills' && (
            <RequireModule moduleKey="billing" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'cashier', 'accountant']}
                onNavigate={navigate}
              >
                <BillsScreen
                  initialBillId={navBillId}
                  initialPartyId={navPartyId}
                  initialAction={
                    navAction === 'new-bill' || navAction === 'new-quotation'
                      ? navAction
                      : null
                  }
                  onActionConsumed={clearNavIntent}
                  onOpenParty={(pid) =>
                    navigate('parties', undefined, { partyId: pid })
                  }
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'parties' && (
            <RequireModule moduleKey="parties" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'cashier', 'accountant']}
                onNavigate={navigate}
              >
                <PartiesScreen
                  initialPartyId={navPartyId}
                  initialAction={
                    navAction === 'add-party' ||
                    navAction === 'receive-payment' ||
                    navAction === 'give-payment'
                      ? navAction
                      : null
                  }
                  onActionConsumed={clearNavIntent}
                  onOpenPayments={() => navigate('payments')}
                  onNewBill={(pid) =>
                    navigate('bills', undefined, {
                      partyId: pid,
                      action: 'new-bill',
                    })
                  }
                  onOpenBill={(bid) =>
                    navigate('bills', undefined, { billId: bid })
                  }
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'items' && (
            <RequireModule moduleKey="inventory" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'cashier', 'storekeeper', 'accountant']}
                onNavigate={navigate}
              >
                <ItemsScreen
                  initialItemId={navItemId}
                  initialFilter={navItemFilter}
                  initialAction={navAction === 'add-item' ? 'add-item' : null}
                  onActionConsumed={clearNavIntent}
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'purchases' && (
            <RequireModule moduleKey="purchases" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'storekeeper', 'accountant']}
                onNavigate={navigate}
              >
                <PurchasesScreen
                  initialAction={
                    navAction === 'new-purchase' ? 'new-purchase' : null
                  }
                  onActionConsumed={clearNavIntent}
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'payments' && (
            <RequireModule moduleKey="payments" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'cashier', 'accountant']}
                onNavigate={navigate}
              >
                <PaymentsScreen
                  initialAction={
                    navAction === 'receive-payment' ||
                    navAction === 'give-payment'
                      ? navAction
                      : null
                  }
                  onActionConsumed={clearNavIntent}
                  onOpenParty={(pid) =>
                    navigate('parties', undefined, { partyId: pid })
                  }
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'expenses' && (
            <RequireModule moduleKey="expenses" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'cashier', 'accountant']}
                onNavigate={navigate}
              >
                <ExpensesScreen
                  initialAction={
                    navAction === 'add-expense' ? 'add-expense' : null
                  }
                  onActionConsumed={clearNavIntent}
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'reports' && (
            <RequireModule moduleKey="reports" onNavigate={navigate}>
              <RequireRole
                roles={[
                  'owner',
                  'manager',
                  'cashier',
                  'storekeeper',
                  'accountant',
                  'viewer',
                ]}
                onNavigate={navigate}
              >
                <ReportsScreen />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'pos' && (
            <RequireModule moduleKey="pos" onNavigate={navigate}>
              <RequireModule moduleKey="billing" onNavigate={navigate}>
                <RequireRole
                  roles={['owner', 'manager', 'cashier', 'accountant']}
                  onNavigate={navigate}
                >
                  <PosLiteScreen />
                </RequireRole>
              </RequireModule>
            </RequireModule>
          )}
          {dest === 'accounting' && (
            <RequireModule moduleKey="accounting" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'accountant']}
                onNavigate={navigate}
              >
                <AccountingScreen />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'gst' && (
            <RequireModule moduleKey="gst_returns" onNavigate={navigate}>
              <RequireModule moduleKey="tax" onNavigate={navigate}>
                <RequireRole
                  roles={['owner', 'manager', 'accountant']}
                  onNavigate={navigate}
                >
                  <AdvancedGstScreen />
                </RequireRole>
              </RequireModule>
            </RequireModule>
          )}
          {dest === 'operations' && (
            <RequireRole
              roles={['owner', 'manager', 'storekeeper', 'cashier', 'accountant']}
              onNavigate={navigate}
            >
              <OperationsScreen />
            </RequireRole>
          )}
          {dest === 'messaging' && (
            <RequireModule moduleKey="messaging" onNavigate={navigate}>
              <RequireRole
                roles={['owner', 'manager', 'cashier', 'accountant']}
                onNavigate={navigate}
              >
                <MessagingScreen
                  onOpenSettings={() => navigate('settings', 'integrations')}
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'ai' && (
            <RequireModule moduleKey="ai" onNavigate={navigate}>
              <AiAssistantScreen
                onOpenSettings={() => navigate('settings', 'integrations')}
              />
            </RequireModule>
          )}
          {dest === 'online_store' && (
            <RequireModule moduleKey="online_store" onNavigate={navigate}>
              <RequireRole roles={['owner', 'manager']} onNavigate={navigate}>
                <OnlineStoreAdminScreen
                  onOpenIntegrations={() => navigate('settings', 'integrations')}
                />
              </RequireRole>
            </RequireModule>
          )}
          {dest === 'pack' && (
            <RequireModule moduleKey="estimator" onNavigate={navigate}>
              <PackWorkspaceScreen onNavigate={navigate} />
            </RequireModule>
          )}
          {dest === 'notifications' && (
            <NotificationsScreen onNavigate={navigate} />
          )}
          {dest === 'data' && (
            <RequireRole
              roles={['owner', 'manager', 'storekeeper', 'accountant']}
              onNavigate={navigate}
            >
              <div className="max-w-6xl mx-auto p-4 sm:p-6">
                <ImportExportPanel />
              </div>
            </RequireRole>
          )}
          </Suspense>
        </main>
      </div>

      {/* Mobile: EXACTLY 5 bottom navigation controls (Home, Bills, Quick Actions +, Parties, More) */}
      <nav
        aria-label="Mobile bottom navigation"
        className="no-print md:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-[var(--surface)] border-t border-[var(--border)] grid grid-cols-5 items-center"
      >
        <button
          type="button"
          onClick={() => navigate('home')}
          aria-current={dest === 'home' ? 'page' : undefined}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            dest === 'home'
              ? 'text-[var(--primary-dark)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          <IconHome size={22} stroke={2} />
          <span className="text-[11px] font-medium">{t('nav.home')}</span>
        </button>

        <button
          type="button"
          onClick={() => navigate('bills')}
          aria-current={dest === 'bills' ? 'page' : undefined}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            dest === 'bills'
              ? 'text-[var(--primary-dark)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          <IconReceipt size={22} stroke={2} />
          <span className="text-[11px] font-medium">{t('nav.bills')}</span>
        </button>

        <button
          type="button"
          onClick={() => setQuickOpen(true)}
          aria-label={t('quick.title')}
          className="h-full flex flex-col items-center justify-center"
        >
          <span className="w-11 h-11 rounded-full bg-[var(--primary)] text-[var(--on-primary)] flex items-center justify-center">
            <IconPlus size={22} stroke={2.5} />
          </span>
        </button>

        <button
          type="button"
          onClick={() => navigate('parties')}
          aria-current={dest === 'parties' ? 'page' : undefined}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            dest === 'parties'
              ? 'text-[var(--primary-dark)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          <IconUsers size={22} stroke={2} />
          <span className="text-[11px] font-medium">{t('nav.parties')}</span>
        </button>

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`h-full flex flex-col items-center justify-center gap-0.5 ${
            moreOpen ||
            [
              'items',
              'purchases',
              'payments',
              'expenses',
              'reports',
              'pos',
              'accounting',
              'gst',
              'operations',
              'messaging',
              'ai',
              'online_store',
              'pack',
              'data',
              'notifications',
              'settings',
              'profile',
              'help',
            ].includes(dest)
              ? 'text-[var(--primary-dark)]'
              : 'text-[var(--text-muted)]'
          }`}
        >
          <IconMenu2 size={22} stroke={2} />
          <span className="text-[11px] font-medium">{t('nav.more')}</span>
        </button>
      </nav>

      {/* Quick Actions Bottom Sheet */}
      {quickOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center"
          onClick={() => setQuickOpen(false)}
        >
          <div
            ref={quickDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t('quick.title')}
            className="w-full md:max-w-md rounded-t-2xl md:rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 rounded-full bg-[var(--border)] mx-auto md:hidden" />
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('quick.title')}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setQuickOpen(false)}
                className="min-w-11 min-h-11 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              >
                <IconX size={18} stroke={2} />
              </button>
            </div>
            {quickActionItems.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)] py-2">
                No quick actions are available for your assigned role or enabled modules.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {quickActionItems.map((actionItem) => {
                  const Icon = actionItem.icon;
                  return (
                    <button
                      key={actionItem.key}
                      type="button"
                      onClick={() => {
                        navigate(actionItem.id, undefined, {
                          action: actionItem.action,
                        });
                      }}
                      className="min-h-[56px] p-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] flex items-center gap-3 text-left"
                    >
                      <Icon
                        size={20}
                        stroke={2}
                        className="text-[var(--primary-dark)] shrink-0"
                      />
                      <span className="text-sm font-medium">{actionItem.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile More Bottom Sheet */}
      {moreOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end md:hidden"
          onClick={() => setMoreOpen(false)}
        >
          <div
            ref={moreDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={t('nav.more')}
            className="w-full rounded-t-2xl bg-[var(--surface)] border-t border-[var(--border)] p-5 space-y-3 max-h-[82vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 rounded-full bg-[var(--border)] mx-auto" />
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('nav.more')}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setMoreOpen(false)}
                className="min-w-11 min-h-11 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              >
                <IconX size={18} stroke={2} />
              </button>
            </div>

            <div className="divide-y divide-[var(--border)]">
              {sidebarItems
                .filter((i) => !['home', 'bills', 'parties'].includes(i.id))
                .map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => navigate(item.id)}
                      className="w-full min-h-[52px] flex items-center gap-3 text-left text-sm font-medium"
                    >
                      <Icon size={20} stroke={2} className="text-[var(--text-muted)]" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              <button
                type="button"
                onClick={() => navigate('profile')}
                className="w-full min-h-[52px] flex items-center gap-3 text-left text-sm font-medium"
              >
                <IconUser size={20} stroke={2} className="text-[var(--text-muted)]" />
                <span>{t('nav.profile')}</span>
              </button>
              {isModuleEnabled('hindi') && (
                <button
                  type="button"
                  onClick={() => setLanguage(language === 'en' ? 'hi' : 'en')}
                  className="w-full min-h-[52px] flex items-center justify-between text-left text-sm font-medium"
                >
                  <span className="inline-flex items-center gap-3">
                    <IconLanguage size={20} stroke={2} className="text-[var(--text-muted)]" />
                    <span>Language</span>
                  </span>
                  <span className="text-xs text-[var(--primary-dark)]">
                    {language === 'en' ? 'English -> हिन्दी' : 'हिन्दी -> English'}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                className="w-full min-h-[52px] flex items-center justify-between text-left text-sm font-medium"
              >
                <span className="inline-flex items-center gap-3">
                  {theme === 'light' ? (
                    <IconMoon size={20} stroke={2} className="text-[var(--text-muted)]" />
                  ) : (
                    <IconSun size={20} stroke={2} className="text-[var(--text-muted)]" />
                  )}
                  <span>Theme</span>
                </span>
                <span className="text-xs text-[var(--primary-dark)] capitalize">
                  {theme}
                </span>
              </button>
              <button
                type="button"
                onClick={() => signOut()}
                className="w-full min-h-[52px] flex items-center gap-3 text-left text-sm font-medium text-[var(--give)]"
              >
                <IconLogout size={20} stroke={2} />
                <span>{t('nav.signOut')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <GlobalSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={navigate}
      />
    </div>
  );
}
