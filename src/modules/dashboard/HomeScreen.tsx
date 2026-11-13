import {
  IconAlertCircle,
  IconArrowDownLeft,
  IconArrowUpRight,
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconHistory,
  IconPackage,
  IconReceipt,
  IconRefresh,
  IconUsers,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { BUSINESS_PACKS } from '../../../config/app.config';
import { useApp } from '../../app/AppProvider';
import { formatDateTime, formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import type {
  BillingSummary,
  InventorySummary,
  KhataTotalsSummary,
} from '../../types/bizone';
import type { ItemFilterTab } from '../items/ItemsScreen';

export type AppDestination =
  | 'home'
  | 'bills'
  | 'parties'
  | 'items'
  | 'purchases'
  | 'payments'
  | 'expenses'
  | 'reports'
  | 'settings'
  | 'profile'
  | 'help';

interface HomeScreenProps {
  onNavigate: (
    dest: AppDestination,
    settingsTab?: string,
    opts?: {
      partyId?: string | null;
      itemId?: string | null;
      billId?: string | null;
      itemFilter?: ItemFilterTab | null;
      action?:
        | 'add-party'
        | 'add-item'
        | 'receive-payment'
        | 'give-payment'
        | 'new-bill'
        | 'new-quotation'
        | null;
    }
  ) => void;
}

export function HomeScreen({ onNavigate }: HomeScreenProps) {
  const {
    business,
    profile,
    staff,
    modules,
    auditLogs,
    workspaceError,
    refreshWorkspace,
    showToast,
    isModuleEnabled,
    language,
    t,
  } = useApp();

  const [dismissing, setDismissing] = useState(false);
  const [khataSummary, setKhataSummary] = useState<KhataTotalsSummary | null>(null);
  const [invSummary, setInvSummary] = useState<InventorySummary | null>(null);
  const [billSummary, setBillSummary] = useState<BillingSummary | null>(null);

  const isOwner = profile?.role === 'owner';
  const enabledCount = modules.filter((m) => m.enabled).length;
  const packInfo = BUSINESS_PACKS.find((p) => p.key === business?.pack);
  const canSeeBills =
    isModuleEnabled('billing') && hasCapability(profile?.role, 'create_bills');
  const canSeeParties =
    isModuleEnabled('parties') && hasCapability(profile?.role, 'parties');
  const canSeeItems =
    isModuleEnabled('inventory') &&
    (hasCapability(profile?.role, 'items') ||
      hasCapability(profile?.role, 'create_bills'));
  const canEditItems =
    isModuleEnabled('inventory') && hasCapability(profile?.role, 'items');

  useEffect(() => {
    if (!canSeeParties) {
      setKhataSummary(null);
    } else {
      let active = true;
      supabase
        .from('khata_totals_summary')
        .select('*')
        .maybeSingle()
        .then(({ data }) => {
          if (active && data) {
            setKhataSummary(data as KhataTotalsSummary);
          }
        });
      return () => {
        active = false;
      };
    }
  }, [canSeeParties]);

  useEffect(() => {
    if (!canSeeItems) {
      setInvSummary(null);
      return;
    }
    let active = true;
    supabase
      .from('inventory_summary_view')
      .select('*')
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) {
          setInvSummary(data as InventorySummary);
        }
      });
    return () => {
      active = false;
    };
  }, [canSeeItems]);

  useEffect(() => {
    if (!canSeeBills) {
      setBillSummary(null);
      return;
    }
    let active = true;
    supabase
      .from('billing_summary_view')
      .select('*')
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) {
          setBillSummary(data as BillingSummary);
        }
      });
    return () => {
      active = false;
    };
  }, [canSeeBills]);

  const steps = business?.onboarding_steps ?? {
    logo: false,
    address: false,
    gst: false,
    profile: false,
    modules: false,
  };

  const checklistItems = [
    {
      key: 'logo',
      done: Boolean(steps.logo || business?.logo_file_id),
      label: t('home.stepLogo'),
      action: () => onNavigate('settings', 'business'),
    },
    {
      key: 'address',
      done: Boolean(steps.address || business?.address),
      label: t('home.stepAddress'),
      action: () => onNavigate('settings', 'business'),
    },
    {
      key: 'gst',
      done: Boolean(steps.gst),
      label: t('home.stepGst'),
      action: () => onNavigate('settings', 'invoice'),
    },
    {
      key: 'profile',
      done: Boolean(steps.profile || profile?.avatar_file_id),
      label: t('home.stepProfile'),
      action: () => onNavigate('profile'),
    },
    {
      key: 'modules',
      done: Boolean(steps.modules),
      label: t('home.stepModules'),
      action: () => onNavigate('settings', 'modules'),
    },
  ];

  const completedStepsCount = checklistItems.filter((i) => i.done).length;

  const handleDismissOnboarding = async () => {
    setDismissing(true);
    try {
      const { error } = await supabase.rpc('dismiss_onboarding');
      if (error) throw error;
      await refreshWorkspace();
      showToast('Onboarding checklist dismissed.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Unable to dismiss checklist.',
        'error'
      );
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      {workspaceError && (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] flex items-center justify-between gap-4 text-xs sm:text-sm text-[var(--give)]">
          <span className="inline-flex items-center gap-2">
            <IconAlertCircle size={18} stroke={2} className="shrink-0" />
            <span>{workspaceError}</span>
          </span>
          <button
            type="button"
            onClick={() => refreshWorkspace()}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--give)]/40 bg-[var(--surface)] text-xs font-medium text-[var(--text)]"
          >
            <IconRefresh size={14} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      )}

      {/* Greeting & Business header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            {business?.name ?? t('app.name')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {language === 'hi' ? packInfo?.labelHi : packInfo?.labelEn} ·{' '}
            {business?.gst_registered
              ? `GSTIN ${business.gstin || 'Pending'}`
              : 'Non-GST'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canSeeBills && (
            <button
              type="button"
              onClick={() => onNavigate('bills', undefined, { action: 'new-bill' })}
              className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95 transition-opacity"
            >
              <IconReceipt size={18} stroke={2} />
              <span>{t('quick.newBill')}</span>
            </button>
          )}
          {canEditItems && (
            <button
              type="button"
              onClick={() => onNavigate('items', undefined, { action: 'add-item' })}
              className="h-11 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              <IconPackage size={18} stroke={2} />
              <span>{t('quick.addItem')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Key numbers grid (Phone-first 2x2 -> Desktop 4-col) */}
      <section
        aria-label="Daily business metrics"
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4"
      >
        <button
          type="button"
          onClick={() => canSeeBills && onNavigate('bills')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:bg-[var(--surface-muted)] transition-colors"
        >
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('home.todaySales')}
          </p>
          <p className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--text)]">
            {formatINR(Number(billSummary?.today_sales ?? 0))}
          </p>
        </button>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {t('home.cashReceived')}
          </p>
          <p className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--text)]">
            {formatINR(Number(khataSummary?.today_received ?? 0))}
          </p>
        </div>

        <button
          type="button"
          onClick={() => canSeeParties && onNavigate('parties')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:bg-[var(--surface-muted)] transition-colors"
        >
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--receive-text)]">
            <IconArrowDownLeft size={15} stroke={2} />
            <span>{t('home.youllGet')}</span>
          </div>
          <p className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--receive-text)]">
            {formatINR(Number(khataSummary?.total_to_receive ?? 0))}
          </p>
        </button>

        <button
          type="button"
          onClick={() => canSeeParties && onNavigate('parties')}
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-left hover:bg-[var(--surface-muted)] transition-colors"
        >
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--give)]">
            <IconArrowUpRight size={15} stroke={2} />
            <span>{t('home.youllGive')}</span>
          </div>
          <p className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--give)]">
            {formatINR(Number(khataSummary?.total_to_give ?? 0))}
          </p>
        </button>
      </section>

      {canSeeParties && (khataSummary?.overdue_parties_count ?? 0) > 0 && (
        <button
          type="button"
          onClick={() => onNavigate('parties')}
          className="w-full p-4 rounded-xl border border-[var(--give)]/30 bg-[var(--give-soft)] flex items-center justify-between gap-4 text-left hover:opacity-95"
        >
          <div className="flex items-center gap-3">
            <IconClock size={20} stroke={2} className="text-[var(--give)] shrink-0" />
            <div>
              <p className="text-sm font-semibold text-[var(--give)]">
                {language === 'hi'
                  ? `${khataSummary?.overdue_parties_count} पार्टियों का बकाया देय तिथि से अधिक हो गया है`
                  : `${khataSummary?.overdue_parties_count} ${
                      khataSummary?.overdue_parties_count === 1 ? 'party has' : 'parties have'
                    } overdue balances`}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {language === 'hi'
                  ? 'बकाया देखने और रिमाइंडर भेजने के लिए क्लिक करें'
                  : 'Open Parties & Khata to review dues and send reminders'}
              </p>
            </div>
          </div>
          <IconChevronRight size={18} stroke={2} className="text-[var(--give)] shrink-0" />
        </button>
      )}

      {canSeeItems && (invSummary?.low_stock_count ?? 0) > 0 && (
        <button
          type="button"
          onClick={() =>
            onNavigate('items', undefined, { itemFilter: 'low_stock' })
          }
          className="w-full p-4 rounded-xl border border-amber-500/35 bg-amber-500/10 flex items-center justify-between gap-4 text-left hover:opacity-95"
        >
          <div className="flex items-center gap-3">
            <IconPackage size={20} stroke={2} className="text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                {language === 'hi'
                  ? `${invSummary?.low_stock_count} सामान कम स्टॉक स्तर पर हैं`
                  : `${invSummary?.low_stock_count} ${
                      invSummary?.low_stock_count === 1 ? 'item is' : 'items are'
                    } low on stock`}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {language === 'hi'
                  ? 'कम स्टॉक वाले सामान देखने और स्टॉक जोड़ने के लिए क्लिक करें'
                  : 'Open Items & Inventory to review low-stock items and reorder levels'}
              </p>
            </div>
          </div>
          <IconChevronRight size={18} stroke={2} className="text-amber-600 shrink-0" />
        </button>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* A3 Onboarding Checklist (Owner) or Workspace Snapshot */}
        <div className="lg:col-span-2 space-y-6">
          {isOwner && !business?.onboarding_completed && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold">
                    {completedStepsCount === checklistItems.length
                      ? t('home.onboardingDone')
                      : t('home.onboardingTitle')}
                  </h2>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                    {completedStepsCount} of {checklistItems.length} completed
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDismissOnboarding}
                    disabled={dismissing}
                    className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
                  >
                    {dismissing ? 'Saving...' : 'Mark Complete'}
                  </button>
                  <IconCircleCheck
                    size={20}
                    stroke={2}
                    className={
                      completedStepsCount === checklistItems.length
                        ? 'text-[var(--receive-text)]'
                        : 'text-[var(--text-muted)]'
                    }
                  />
                </div>
              </div>

              <div className="divide-y divide-[var(--border)]">
                {checklistItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={item.action}
                    className="w-full min-h-[56px] px-5 py-3 flex items-center justify-between gap-3 text-left hover:bg-[var(--surface-muted)] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center border ${
                          item.done
                            ? 'bg-[var(--receive-soft)] border-[var(--receive)] text-[var(--receive-text)]'
                            : 'border-[var(--border)] text-transparent'
                        }`}
                      >
                        <IconCheck size={14} stroke={2.5} />
                      </span>
                      <span
                        className={`text-sm font-medium ${
                          item.done
                            ? 'text-[var(--text-muted)] line-through'
                            : 'text-[var(--text)]'
                        }`}
                      >
                        {item.label}
                      </span>
                    </div>
                    <IconChevronRight
                      size={18}
                      stroke={2}
                      className="text-[var(--text-muted)] shrink-0"
                    />
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Recent Activity (Owner audit_logs) */}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border)] flex items-center gap-2">
              <IconHistory size={18} stroke={2} className="text-[var(--text-muted)]" />
              <h2 className="text-base font-semibold">
                {t('home.recentActivity')}
              </h2>
            </div>
            {auditLogs.length === 0 ? (
              <div className="p-6 text-sm text-[var(--text-muted)]">
                {t('home.noActivity')}
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {auditLogs.slice(0, 8).map((log) => (
                  <div
                    key={log.id}
                    className="px-5 py-3 flex items-center justify-between gap-4 text-xs sm:text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-[var(--text)] truncate">
                        {log.action}
                      </p>
                      <p className="text-xs text-[var(--text-muted)] truncate">
                        {log.actor_email || 'System'} · {log.entity_type}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--text-muted)] tabular-nums whitespace-nowrap shrink-0">
                      {formatDateTime(log.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Business Snapshot */}
        <aside className="space-y-4">
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
            <h2 className="text-base font-semibold">
              {t('home.workspaceSummary')}
            </h2>

            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--text-muted)]">
                  {t('home.activePack')}
                </dt>
                <dd className="font-medium">
                  {language === 'hi' ? packInfo?.labelHi : packInfo?.labelEn}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--text-muted)]">
                  {t('home.taxMode')}
                </dt>
                <dd className="font-medium capitalize">
                  {business?.tax_mode ?? 'exclusive'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--text-muted)]">
                  {t('home.teamMembers')}
                </dt>
                <dd className="font-medium tabular-nums inline-flex items-center gap-1">
                  <IconUsers size={15} stroke={2} />
                  <span>{staff.filter((s) => s.is_active).length}</span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--text-muted)]">
                  {t('home.enabledModules')}
                </dt>
                <dd className="font-medium tabular-nums">
                  {enabledCount} / {modules.length}
                </dd>
              </div>
            </dl>

            {isOwner && (
              <button
                type="button"
                onClick={() => onNavigate('settings', 'users')}
                className="w-full h-11 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)] transition-colors"
              >
                Manage Staff & Settings
              </button>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
