import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowDownLeft,
  IconArrowRight,
  IconArrowUpRight,
  IconBell,
  IconBriefcase,
  IconBuildingStore,
  IconChartBar,
  IconCheck,
  IconCircleDashed,
  IconFileSpreadsheet,
  IconPlus,
  IconReceipt,
  IconSettings,
  IconShoppingBag,
  IconUsers,
  IconWallet,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { DECORBIZ_PACK } from '../../../config/app.config';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type { DashboardMetrics } from '../../types/decorbiz';
import type { SettingsTabKey } from '../settings/SettingsScreen';

export type AppDestination =
  | 'home'
  | 'bills'
  | 'parties'
  | 'items'
  | 'purchases'
  | 'payments'
  | 'expenses'
  | 'reports'
  | 'pos'
  | 'accounting'
  | 'gst'
  | 'operations'
  | 'messaging'
  | 'ai'
  | 'online_store'
  | 'pack'
  | 'data'
  | 'notifications'
  | 'settings'
  | 'profile'
  | 'help';

export type NavigationAction =
  | 'new-bill'
  | 'new-quotation'
  | 'receive-payment'
  | 'give-payment'
  | 'add-party'
  | 'add-item'
  | 'new-purchase'
  | 'add-expense';

interface HomeScreenProps {
  onNavigate: (
    dest: AppDestination,
    settingsTab?: SettingsTabKey,
    options?: {
      action?: NavigationAction;
      itemLowStockOnly?: boolean;
      partyFilter?: 'all' | 'receive' | 'give';
    }
  ) => void;
}

const INITIAL_METRICS: DashboardMetrics = {
  today_sales: 0,
  today_gross_sales: 0,
  today_returns: 0,
  month_sales: 0,
  today_purchases: 0,
  month_purchases: 0,
  today_expenses: 0,
  month_expenses: 0,
  cash_in_today: 0,
  cash_out_today: 0,
  net_cash_today: 0,
  total_receivable: 0,
  total_payable: 0,
  low_stock_count: 0,
  out_of_stock_count: 0,
  unread_notifications_count: 0,
  last_backup_at: null,
  daily_trend: [],
  recent_bills: [],
};

export function HomeScreen({ onNavigate }: HomeScreenProps) {
  const { business, profile, modules, language, isModuleEnabled, t } = useApp();

  const [metrics, setMetrics] = useState<DashboardMetrics>(INITIAL_METRICS);
  const [unreadAlertsCount, setUnreadAlertsCount] = useState(0);
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    setLoadingMetrics(true);
    setMetricsError(null);
    try {
      const [metricsRes, notifRes] = await Promise.all([
        supabase.rpc('get_dashboard_metrics'),
        supabase.rpc('sync_system_notifications'),
      ]);

      if (metricsRes.error) throw metricsRes.error;
      const data = metricsRes.data;

      if (data && typeof data === 'object') {
        const d = data as Partial<DashboardMetrics>;
        const nextMetrics: DashboardMetrics = {
          today_sales: Number(d.today_sales ?? 0),
          today_gross_sales: Number(d.today_gross_sales ?? 0),
          today_returns: Number(d.today_returns ?? 0),
          month_sales: Number(d.month_sales ?? 0),
          today_purchases: Number(d.today_purchases ?? 0),
          month_purchases: Number(d.month_purchases ?? 0),
          today_expenses: Number(d.today_expenses ?? 0),
          month_expenses: Number(d.month_expenses ?? 0),
          cash_in_today: Number(d.cash_in_today ?? 0),
          cash_out_today: Number(d.cash_out_today ?? 0),
          net_cash_today: Number(d.net_cash_today ?? 0),
          total_receivable: Number(d.total_receivable ?? 0),
          total_payable: Number(d.total_payable ?? 0),
          low_stock_count: Number(d.low_stock_count ?? 0),
          out_of_stock_count: Number(d.out_of_stock_count ?? 0),
          unread_notifications_count: Number(d.unread_notifications_count ?? 0),
          last_backup_at:
            typeof d.last_backup_at === 'string' ? d.last_backup_at : null,
          daily_trend: Array.isArray(d.daily_trend) ? d.daily_trend : [],
          recent_bills: Array.isArray(d.recent_bills) ? d.recent_bills : [],
        };
        setMetrics(nextMetrics);
        setUnreadAlertsCount(nextMetrics.unread_notifications_count);
      }

      if (!notifRes.error && notifRes.data && typeof notifRes.data === 'object') {
        const nd = notifRes.data as {
          unread_count?: number;
          notifications?: Array<{ is_read?: boolean }>;
        };
        const rows = Array.isArray(nd.notifications) ? nd.notifications : [];
        setUnreadAlertsCount(
          Number(nd.unread_count ?? rows.filter((n) => !n.is_read).length)
        );
      }
    } catch (err) {
      setMetricsError(
        err instanceof Error
          ? err.message
          : 'Unable to load dashboard metrics. Please try again.'
      );
    } finally {
      setLoadingMetrics(false);
    }
  }, []);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const packInfo = DECORBIZ_PACK;

  const isOwner = profile?.role === 'owner';
  const canCreateBill =
    hasCapability(profile?.role, 'create_bills') && isModuleEnabled('billing');
  const canRecordPayment =
    hasCapability(profile?.role, 'payments') && isModuleEnabled('payments');
  const canCreatePurchase =
    hasCapability(profile?.role, 'purchases') && isModuleEnabled('purchases');
  const canCreateExpense =
    hasCapability(profile?.role, 'expenses') && isModuleEnabled('expenses');
  const canViewReports =
    hasCapability(profile?.role, 'reports') && isModuleEnabled('reports');

  const hasLogo = Boolean(business?.logo_file_id);
  const hasAddressOrPhone = Boolean(
    business?.phone?.trim() || business?.address?.trim()
  );
  const hasGstConfigured = Boolean(
    !business?.gst_registered || business?.gstin?.trim()
  );
  const hasProfileDetails = Boolean(
    profile?.full_name?.trim() && profile?.phone?.trim()
  );

  const rawChecklistItems: Array<{
    key: string;
    label: string;
    done: boolean;
    visible: boolean;
    action: () => void;
  }> = [
    {
      key: 'logo',
      label: t('home.stepLogo'),
      done: hasLogo,
      visible: isOwner,
      action: () => onNavigate('settings', 'business'),
    },
    {
      key: 'address',
      label: t('home.stepAddress'),
      done: hasAddressOrPhone,
      visible: isOwner,
      action: () => onNavigate('settings', 'business'),
    },
    {
      key: 'gst',
      label: t('home.stepGst'),
      done: hasGstConfigured,
      visible: isOwner,
      action: () => onNavigate('settings', 'invoice'),
    },
    {
      key: 'profile',
      label: t('home.stepProfile'),
      done: hasProfileDetails,
      visible: true,
      action: () => onNavigate('profile'),
    },
    {
      key: 'modules',
      label: t('home.stepModules'),
      done: modules.some((m) => m.enabled),
      visible: isOwner,
      action: () => onNavigate('settings', 'modules'),
    },
  ];

  const checklistItems = rawChecklistItems.filter((i) => i.visible);
  const completedSteps = checklistItems.filter((i) => i.done).length;
  const showChecklist =
    checklistItems.length > 0 && completedSteps < checklistItems.length;

  const maxTrendVal = Math.max(
    1,
    ...metrics.daily_trend.map((d) =>
      Math.max(Number(d.sales || 0), Number(d.purchases || 0) + Number(d.expenses || 0))
    )
  );

  const totalStockAlerts =
    metrics.low_stock_count + metrics.out_of_stock_count;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      {/* Header & Primary Action Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-2 border-b border-[var(--border)]">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconBuildingStore size={24} stroke={2} className="text-[var(--primary-dark)] shrink-0" />
            <span>{business?.name || t('app.name')}</span>
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {packInfo
              ? `${language === 'hi' ? packInfo.labelHi : packInfo.labelEn} • ${
                  business?.gst_registered
                    ? `GSTIN: ${business.gstin || 'Pending'}`
                    : language === 'hi'
                      ? 'बिना जीएसटी बिलिंग'
                      : 'Non-GST Billing'
                }`
              : t('app.tagline')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate('notifications')}
            className={`hidden h-10 px-3.5 rounded-lg border text-xs sm:text-sm font-medium items-center gap-2 transition-colors ${
              unreadAlertsCount > 0
                ? 'border-[var(--warning)]/50 bg-[var(--warning-soft)] text-[var(--text)]'
                : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-[var(--text)]'
            }`}
          >
            <IconBell
              size={17}
              stroke={2}
              className={
                unreadAlertsCount > 0
                  ? 'text-[var(--warning)]'
                  : 'text-[var(--text-muted)]'
              }
            />
            <span>{language === 'hi' ? 'अलर्ट' : 'Alerts'}</span>
            {unreadAlertsCount > 0 && (
              <span className="font-mono font-bold tabular-nums text-[var(--give)]">
                ({unreadAlertsCount})
              </span>
            )}
          </button>

          {canCreateBill && (
            <button
              type="button"
              onClick={() => onNavigate('bills', undefined, { action: 'new-bill' })}
              className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
            >
              <IconPlus size={17} stroke={2.2} />
              <span>{t('quick.newBill')}</span>
            </button>
          )}
          {canRecordPayment && (
            <button
              type="button"
              onClick={() =>
                onNavigate('payments', undefined, { action: 'receive-payment' })
              }
              className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5"
            >
              <IconArrowDownLeft
                size={17}
                stroke={2}
                className="text-[var(--receive-text)]"
              />
              <span>{t('quick.receivePayment')}</span>
            </button>
          )}
          {canCreatePurchase && (
            <button
              type="button"
              onClick={() =>
                onNavigate('purchases', undefined, { action: 'new-purchase' })
              }
              className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5"
            >
              <IconShoppingBag
                size={17}
                stroke={2}
                className="text-[var(--primary-dark)]"
              />
              <span>{t('quick.newPurchase')}</span>
            </button>
          )}
          {canCreateExpense && (
            <button
              type="button"
              onClick={() =>
                onNavigate('expenses', undefined, { action: 'add-expense' })
              }
              className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5"
            >
              <IconWallet size={17} stroke={2} className="text-[var(--give)]" />
              <span>{t('quick.addExpense')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {metricsError && (
        <div
          role="alert"
          className="rounded-xl border border-[var(--give)] bg-[var(--give-soft)] p-3.5 flex items-center justify-between gap-3 text-xs sm:text-sm text-[var(--give)]"
        >
          <div className="flex items-center gap-2 font-medium">
            <IconAlertCircle size={18} stroke={2} className="shrink-0" />
            <span>{metricsError}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadMetrics()}
            className="h-8 px-3 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-xs font-semibold text-[var(--text)] shrink-0"
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* 6 Primary KPI Cards */}
      <section aria-label="Business Summary" className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* 1. Today's Sales */}
        <button
          type="button"
          onClick={() => onNavigate('bills')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 text-left hover:border-[var(--primary-dark)] transition-colors"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--text-muted)]">
            <span>{t('home.todaySales')}</span>
            <IconReceipt size={17} stroke={2} className="text-[var(--primary-dark)]" />
          </div>
          <div className="mt-2 text-lg sm:text-2xl font-bold font-mono tabular-nums tracking-tight">
            {loadingMetrics ? '—' : formatINR(metrics.today_sales)}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span className="font-mono tabular-nums">
              {loadingMetrics
                ? t('common.loading')
                : `${t('purchases.monthPurchases')}: ${formatINR(metrics.month_sales)}`}
            </span>
          </div>
        </button>

        {/* 2. Cash / Bank In Today */}
        <button
          type="button"
          onClick={() => onNavigate('payments')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 text-left hover:border-[var(--primary-dark)] transition-colors"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--text-muted)]">
            <span>{t('home.cashReceived')}</span>
            <IconArrowDownLeft
              size={17}
              stroke={2}
              className="text-[var(--receive-text)]"
            />
          </div>
          <div className="mt-2 text-lg sm:text-2xl font-bold font-mono tabular-nums tracking-tight text-[var(--receive-text)]">
            {loadingMetrics ? '—' : formatINR(metrics.cash_in_today)}
          </div>
          <div className="mt-1.5 text-xs text-[var(--text-muted)] font-mono tabular-nums">
            {loadingMetrics
              ? t('common.loading')
              : `${
                  language === 'hi' ? 'आज भुगतान (Out)' : 'Out today'
                }: ${formatINR(metrics.cash_out_today)}`}
          </div>
        </button>

        {/* 3. To Receive (You'll Get) */}
        <button
          type="button"
          onClick={() =>
            onNavigate('parties', undefined, { partyFilter: 'receive' })
          }
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 text-left hover:border-[var(--primary-dark)] transition-colors"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--text-muted)]">
            <span>{t('home.youllGet')}</span>
            <IconUsers size={17} stroke={2} className="text-[var(--receive-text)]" />
          </div>
          <div className="mt-2 text-lg sm:text-2xl font-bold font-mono tabular-nums tracking-tight text-[var(--receive-text)]">
            {loadingMetrics ? '—' : formatINR(metrics.total_receivable)}
          </div>
          <div className="mt-1.5 text-xs text-[var(--text-muted)]">
            {loadingMetrics
              ? t('common.loading')
              : language === 'hi'
                ? 'ग्राहकों से लेना बाकी (To Receive)'
                : 'Customer receivables due'}
          </div>
        </button>

        {/* 4. To Pay (You'll Give) */}
        <button
          type="button"
          onClick={() =>
            onNavigate('parties', undefined, { partyFilter: 'give' })
          }
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 text-left hover:border-[var(--primary-dark)] transition-colors"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--text-muted)]">
            <span>{t('home.youllGive')}</span>
            <IconArrowUpRight size={17} stroke={2} className="text-[var(--give)]" />
          </div>
          <div className="mt-2 text-lg sm:text-2xl font-bold font-mono tabular-nums tracking-tight text-[var(--give)]">
            {loadingMetrics ? '—' : formatINR(metrics.total_payable)}
          </div>
          <div className="mt-1.5 text-xs text-[var(--text-muted)]">
            {loadingMetrics
              ? t('common.loading')
              : language === 'hi'
                ? 'सप्लायर को देना बाकी (To Pay)'
                : 'Supplier payables due'}
          </div>
        </button>

        {/* 5. Purchases & Expenses Today */}
        <button
          type="button"
          onClick={() => onNavigate('purchases')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 text-left hover:border-[var(--primary-dark)] transition-colors"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--text-muted)]">
            <span>
              {t('purchases.todayPurchases')} &amp; {t('nav.expenses')}
            </span>
            <IconShoppingBag
              size={17}
              stroke={2}
              className="text-[var(--primary-dark)]"
            />
          </div>
          <div className="mt-2 text-lg sm:text-2xl font-bold font-mono tabular-nums tracking-tight">
            {loadingMetrics
              ? '—'
              : formatINR(metrics.today_purchases + metrics.today_expenses)}
          </div>
          <div className="mt-1.5 text-xs text-[var(--text-muted)] font-mono tabular-nums">
            {loadingMetrics
              ? t('common.loading')
              : `Pur: ${formatINR(metrics.today_purchases)} • Exp: ${formatINR(
                  metrics.today_expenses
                )}`}
          </div>
        </button>

        {/* 6. Low Stock & Out of Stock Alerts */}
        <button
          type="button"
          onClick={() =>
            onNavigate('items', undefined, {
              itemLowStockOnly: totalStockAlerts > 0,
            })
          }
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5 text-left hover:border-[var(--primary-dark)] transition-colors"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--text-muted)]">
            <span>{t('items.lowStock')}</span>
            <IconAlertTriangle
              size={17}
              stroke={2}
              className={
                totalStockAlerts > 0
                  ? 'text-[var(--warning-text)]'
                  : 'text-[var(--text-muted)]'
              }
            />
          </div>
          <div
            className={`mt-2 text-lg sm:text-2xl font-bold font-mono tabular-nums tracking-tight ${
              totalStockAlerts > 0 ? 'text-[var(--warning-text)]' : ''
            }`}
          >
            {loadingMetrics ? '—' : String(totalStockAlerts)}
          </div>
          <div className="mt-1.5 text-xs text-[var(--text-muted)]">
            {loadingMetrics
              ? t('common.loading')
              : `${metrics.low_stock_count} low stock • ${metrics.out_of_stock_count} out of stock`}
          </div>
        </button>
      </section>

      {/* Main Two-Column Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 cols): 7-Day Operating Trend + Onboarding Checklist (when incomplete) */}
        <div className="lg:col-span-2 space-y-6">
          {/* 7-Day Operating Trend */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">
                  {language === 'hi'
                    ? 'पिछले 7 दिनों का व्यापार रुझान'
                    : '7-Day Operating Trend'}
                </h2>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {language === 'hi'
                    ? 'दैनिक बिक्री बनाम खरीद और खर्च'
                    : 'Daily sales compared against purchases and expenses'}
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[var(--primary-dark)]" />
                  <span>{language === 'hi' ? 'बिक्री' : 'Sales'}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[var(--give)]" />
                  <span>
                    {language === 'hi' ? 'खरीद + खर्च' : 'Purchases + Expenses'}
                  </span>
                </span>
              </div>
            </div>

            {metrics.daily_trend.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)] py-8 text-center">
                {language === 'hi'
                  ? 'चार्ट डेटा लोड हो रहा है...'
                  : 'No trend data available yet.'}
              </p>
            ) : (
              <div className="grid grid-cols-7 gap-2 sm:gap-3 pt-2 items-end h-44">
                {metrics.daily_trend.map((pt) => {
                  const salesVal = Number(pt.sales || 0);
                  const outVal = Number(pt.purchases || 0) + Number(pt.expenses || 0);
                  const salesPct = Math.max(
                    4,
                    Math.round((salesVal / maxTrendVal) * 100)
                  );
                  const outPct = Math.max(
                    4,
                    Math.round((outVal / maxTrendVal) * 100)
                  );
                  const shortLabel = pt.day.slice(5);

                  const toBarHeightClass = (pct: number) => {
                    if (pct >= 90) return 'h-full';
                    if (pct >= 75) return 'h-5/6';
                    if (pct >= 60) return 'h-4/6';
                    if (pct >= 45) return 'h-3/6';
                    if (pct >= 30) return 'h-2/6';
                    if (pct >= 15) return 'h-1/6';
                    return 'h-2';
                  };

                  return (
                    <div
                      key={pt.day}
                      className="flex flex-col items-center justify-end h-full gap-1.5"
                    >
                      <div className="w-full flex items-end justify-center gap-1.5 h-32 px-1">
                        <div
                          title={`Sales: ${formatINR(salesVal)}`}
                          className={`w-3 sm:w-4 rounded-t bg-[var(--primary-dark)] transition-all ${toBarHeightClass(salesPct)}`}
                        />
                        <div
                          title={`Purchases + Expenses: ${formatINR(outVal)}`}
                          className={`w-3 sm:w-4 rounded-t bg-[var(--give)] opacity-80 transition-all ${toBarHeightClass(outPct)}`}
                        />
                      </div>
                      <span className="text-[11px] font-mono tabular-nums text-[var(--text-muted)]">
                        {shortLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {canViewReports && (
              <div className="pt-3 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="text-[var(--text-muted)] font-mono tabular-nums">
                  {language === 'hi' ? 'इस महीने कुल बिक्री' : 'Month Sales'}:{' '}
                  <span className="font-semibold text-[var(--text)]">
                    {formatINR(metrics.month_sales)}
                  </span>{' '}
                  • {language === 'hi' ? 'खरीद' : 'Purchases'}:{' '}
                  <span className="font-semibold text-[var(--text)]">
                    {formatINR(metrics.month_purchases)}
                  </span>{' '}
                  • {language === 'hi' ? 'खर्च' : 'Expenses'}:{' '}
                  <span className="font-semibold text-[var(--text)]">
                    {formatINR(metrics.month_expenses)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('reports')}
                  className="font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline"
                >
                  <span>
                    {language === 'hi'
                      ? 'डे-बुक और रिपोर्ट खोलें'
                      : 'Open Day Book & Reports'}
                  </span>
                  <IconArrowRight size={14} stroke={2} />
                </button>
              </div>
            )}
          </section>

          {/* Onboarding Checklist (shown only when setup is incomplete) */}
          {showChecklist && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">
                    {t('home.onboardingTitle')}
                  </h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    {language === 'hi'
                      ? 'अपनी दुकान का सेटअप पूरा करने के लिए ये चरण पूरे करें।'
                      : 'Complete these setup steps to get your business workspace ready.'}
                  </p>
                </div>
                <span className="text-xs font-mono font-semibold tabular-nums text-[var(--primary-dark)]">
                  {completedSteps}/{checklistItems.length}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {checklistItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={item.action}
                    className="w-full min-h-[48px] px-3.5 py-2.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] flex items-center justify-between gap-3 text-left transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {item.done ? (
                        <span className="w-5 h-5 rounded-full bg-[var(--receive-soft)] text-[var(--receive-text)] flex items-center justify-center shrink-0">
                          <IconCheck size={14} stroke={2.5} />
                        </span>
                      ) : (
                        <IconCircleDashed
                          size={20}
                          stroke={2}
                          className="text-[var(--text-muted)] shrink-0"
                        />
                      )}
                      <span
                        className={`text-xs sm:text-sm truncate ${
                          item.done
                            ? 'line-through text-[var(--text-muted)]'
                            : 'font-medium text-[var(--text)]'
                        }`}
                      >
                        {item.label}
                      </span>
                    </div>
                    <IconArrowRight
                      size={15}
                      stroke={2}
                      className="text-[var(--text-muted)] shrink-0"
                    />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right Column (1 col): Recent Bills + Quick Workspace Shortcuts */}
        <div className="space-y-6">
          {/* Recent Bills */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {language === 'hi' ? 'हाल के बिल' : 'Recent Bills'}
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('bills')}
                className="text-xs font-semibold text-[var(--primary-dark)] hover:underline"
              >
                {language === 'hi' ? 'सभी देखें' : 'View All'}
              </button>
            </div>

            {metrics.recent_bills.length === 0 ? (
              <div className="py-8 text-center space-y-3">
                <p className="text-xs sm:text-sm text-[var(--text-muted)]">
                  {t('bills.emptyTitle')}
                </p>
                {canCreateBill && (
                  <button
                    type="button"
                    onClick={() =>
                      onNavigate('bills', undefined, { action: 'new-bill' })
                    }
                    className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    <IconPlus size={15} stroke={2.2} />
                    <span>{t('quick.newBill')}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {metrics.recent_bills.map((bill) => (
                  <button
                    key={bill.id}
                    type="button"
                    onClick={() => onNavigate('bills')}
                    className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-[var(--surface-muted)] px-2 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-semibold">
                          {bill.bill_number || 'DRAFT'}
                        </span>
                        <span className="text-sm font-medium truncate">
                          {bill.party_name}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--text-muted)] mt-0.5">
                        {formatDate(bill.bill_date)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-mono font-semibold tabular-nums">
                        {formatINR(bill.grand_total)}
                      </div>
                      <div
                        className={`text-[11px] font-medium ${
                          bill.payment_status === 'paid'
                            ? 'text-[var(--receive-text)]'
                            : bill.status === 'voided'
                              ? 'text-[var(--text-muted)] line-through'
                              : 'text-[var(--give)]'
                        }`}
                      >
                        {bill.status === 'voided'
                          ? t('bills.statuses.voided')
                          : bill.payment_status === 'paid'
                            ? t('bills.statuses.paid')
                            : bill.payment_status === 'partial'
                              ? `${t('bills.balanceDue')}: ${formatINR(bill.balance_due)}`
                              : t('bills.statuses.unpaid')}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Quick Workspace Shortcuts */}
          <section className="hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
            <h2 className="text-sm font-semibold text-[var(--text-muted)]">
              {language === 'hi' ? 'त्वरित नेविगेशन' : 'Quick Workspace Shortcuts'}
            </h2>
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => onNavigate('pack')}
                className="w-full h-11 px-3.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] flex items-center justify-between text-xs sm:text-sm font-medium transition-colors"
              >
                <span className="inline-flex items-center gap-2.5">
                  <IconBriefcase
                    size={17}
                    stroke={2}
                    className="text-[var(--primary-dark)]"
                  />
                  <span>{t('nav.pack')}</span>
                </span>
                <IconArrowRight
                  size={15}
                  stroke={2}
                  className="text-[var(--text-muted)]"
                />
              </button>

              {canViewReports && (
                <button
                  type="button"
                  onClick={() => onNavigate('reports')}
                  className="w-full h-11 px-3.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] flex items-center justify-between text-xs sm:text-sm font-medium transition-colors"
                >
                  <span className="inline-flex items-center gap-2.5">
                    <IconChartBar
                      size={17}
                      stroke={2}
                      className="text-[var(--primary-dark)]"
                    />
                    <span>{t('nav.reports')}</span>
                  </span>
                  <IconArrowRight
                    size={15}
                    stroke={2}
                    className="text-[var(--text-muted)]"
                  />
                </button>
              )}

              <button
                type="button"
                onClick={() => onNavigate('data')}
                className="w-full h-11 px-3.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] flex items-center justify-between text-xs sm:text-sm font-medium transition-colors"
              >
                <span className="inline-flex items-center gap-2.5">
                  <IconFileSpreadsheet
                    size={17}
                    stroke={2}
                    className="text-[var(--primary-dark)]"
                  />
                  <span>{t('nav.data')}</span>
                </span>
                <IconArrowRight
                  size={15}
                  stroke={2}
                  className="text-[var(--text-muted)]"
                />
              </button>

              <button
                type="button"
                onClick={() => onNavigate('settings', isOwner ? 'business' : 'appearance')}
                className="w-full h-11 px-3.5 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] flex items-center justify-between text-xs sm:text-sm font-medium transition-colors"
              >
                <span className="inline-flex items-center gap-2.5">
                  <IconSettings
                    size={17}
                    stroke={2}
                    className="text-[var(--primary-dark)]"
                  />
                  <span>{t('nav.settings')}</span>
                </span>
                <IconArrowRight
                  size={15}
                  stroke={2}
                  className="text-[var(--text-muted)]"
                />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
