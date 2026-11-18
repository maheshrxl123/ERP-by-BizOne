import {
  IconAlertCircle,
  IconArrowRight,
  IconBell,
  IconCheck,
  IconChecks,
  IconPackage,
  IconRefresh,
  IconShieldCheck,
  IconUsers,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDateTime } from '../../core/format';
import { supabase } from '../../core/supabase';
import type { NotificationRecord } from '../../types/bizone';
import type { AppDestination, NavigationAction } from '../dashboard/HomeScreen';
import type { SettingsTabKey } from '../settings/SettingsScreen';

interface NotificationsScreenProps {
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

type NotificationFilter = 'all' | 'unread' | 'warnings';

export function NotificationsScreen({ onNavigate }: NotificationsScreenProps) {
  const { language, showToast } = useApp();
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [markingAll, setMarkingAll] = useState(false);

  const loadNotifications = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data, error } = await supabase.rpc('sync_system_notifications');
      if (error) throw error;
      if (data && typeof data === 'object') {
        const payload = data as {
          unread_count?: number;
          notifications?: NotificationRecord[];
        };
        const rows = Array.isArray(payload.notifications) ? payload.notifications : [];
        setNotifications(rows);
        setUnreadCount(
          Number(
            payload.unread_count ?? rows.filter((n) => !n.is_read).length
          )
        );
      }
    } catch (err) {
      if (!silent) {
        showToast(
          err instanceof Error ? err.message : 'Unable to load notifications.',
          'error'
        );
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  const handleMarkRead = async (notificationId: string | null) => {
    if (notificationId === null) setMarkingAll(true);
    try {
      const { error } = await supabase.rpc('mark_notification_read', {
        p_notification_id: notificationId,
      });
      if (error) throw error;
      if (notificationId === null) {
        setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
        setUnreadCount(0);
        showToast(
          language === 'hi'
            ? 'सभी सूचनाएं पढ़ी गई के रूप में चिह्नित की गईं।'
            : 'All notifications marked as read.',
          'success'
        );
      } else {
        setNotifications((prev) =>
          prev.map((n) => (n.id === notificationId ? { ...n, is_read: true } : n))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      }
    } catch {
      // Non-blocking fallback
    } finally {
      if (notificationId === null) setMarkingAll(false);
    }
  };

  const handleOpenNotificationTarget = (n: NotificationRecord) => {
    if (!n.is_read) {
      void handleMarkRead(n.id);
    }
    if (
      n.target_tab === 'items' ||
      n.rule_key.includes('stock') ||
      n.rule_key.includes('expiry')
    ) {
      onNavigate('items', undefined, { itemLowStockOnly: true });
      return;
    }
    if (n.target_tab === 'backup' || n.rule_key.includes('backup')) {
      onNavigate('settings', 'backup');
      return;
    }
    if (n.target_tab === 'parties' || n.rule_key.includes('receivable')) {
      onNavigate('parties', undefined, { partyFilter: 'receive' });
      return;
    }
    if (n.target_tab === 'bills') {
      onNavigate('bills');
      return;
    }
    if (n.target_tab === 'purchases') {
      onNavigate('purchases');
      return;
    }
    if (n.target_tab === 'settings') {
      onNavigate('settings', 'business');
    }
  };

  const filteredNotifications = useMemo(() => {
    return notifications.filter((n) => {
      if (filter === 'unread') return !n.is_read;
      if (filter === 'warnings') {
        return n.severity === 'critical' || n.severity === 'warning';
      }
      return true;
    });
  }, [notifications, filter]);

  const warningCount = useMemo(
    () =>
      notifications.filter(
        (n) => n.severity === 'critical' || n.severity === 'warning'
      ).length,
    [notifications]
  );

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <IconBell size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>
              {language === 'hi' ? 'अलर्ट और सूचनाएं' : 'Alerts & Notifications'}
            </span>
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {language === 'hi'
              ? 'कम स्टॉक, एक्सपायरी, बकाया वसूली और बैकअप रिमाइंडर एक जगह देखें।'
              : 'Monitor low stock, batch expiry, overdue collections, and workspace backup alerts.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadNotifications(false)}
            className="h-10 px-3.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <IconRefresh size={16} stroke={2} />
            <span>{language === 'hi' ? 'रिफ्रेश करें' : 'Refresh'}</span>
          </button>

          {unreadCount > 0 && (
            <button
              type="button"
              disabled={markingAll}
              onClick={() => void handleMarkRead(null)}
              className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95 disabled:opacity-50"
            >
              <IconChecks size={16} stroke={2} />
              <span>
                {language === 'hi' ? 'सभी पढ़े गए चिह्नित करें' : 'Mark All Read'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-xs font-medium text-[var(--text-muted)]">
            {language === 'hi' ? 'कुल सूचनाएं' : 'Total Alerts'}
          </div>
          <div className="mt-1 text-xl sm:text-2xl font-bold font-mono tabular-nums">
            {notifications.length}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-xs font-medium text-[var(--text-muted)]">
            {language === 'hi' ? 'अपठित (Unread)' : 'Unread'}
          </div>
          <div
            className={`mt-1 text-xl sm:text-2xl font-bold font-mono tabular-nums ${
              unreadCount > 0 ? 'text-[var(--primary-dark)]' : ''
            }`}
          >
            {unreadCount}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="text-xs font-medium text-[var(--text-muted)]">
            {language === 'hi' ? 'जरूरी ध्यान दें' : 'Action Required'}
          </div>
          <div
            className={`mt-1 text-xl sm:text-2xl font-bold font-mono tabular-nums ${
              warningCount > 0 ? 'text-[var(--give)]' : 'text-[var(--receive-text)]'
            }`}
          >
            {warningCount}
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-3">
        <div className="flex items-center gap-2">
          {(
            [
              {
                id: 'all',
                label: language === 'hi' ? 'सभी' : 'All',
                count: notifications.length,
              },
              {
                id: 'unread',
                label: language === 'hi' ? 'अपठित' : 'Unread',
                count: unreadCount,
              },
              {
                id: 'warnings',
                label: language === 'hi' ? 'चेतावनी / क्रिटिकल' : 'Critical & Warnings',
                count: warningCount,
              },
            ] as const
          ).map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`h-9 px-3.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 ${
                  active
                    ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                    : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                <span>{tab.label}</span>
                <span className="font-mono tabular-nums opacity-85">({tab.count})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Notifications List */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 rounded-lg bg-[var(--surface-muted)] animate-pulse"
              />
            ))}
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <IconShieldCheck
              size={32}
              stroke={1.75}
              className="mx-auto text-[var(--receive-text)]"
            />
            <div className="text-sm font-semibold">
              {language === 'hi'
                ? 'कोई लंबित अलर्ट नहीं है'
                : 'All clear — no matching alerts'}
            </div>
            <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto">
              {language === 'hi'
                ? 'स्टॉक स्तर, एक्सपायरी और बैकअप स्थिति सामान्य हैं।'
                : 'Stock levels, batch expiry checks, and backup reminders are up to date.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {filteredNotifications.map((n) => {
              const isCritical = n.severity === 'critical';
              const isWarning = n.severity === 'warning';
              const hasTarget = Boolean(n.target_tab || n.rule_key);
              const titleText = language === 'hi' ? n.title_hi || n.title_en : n.title_en;
              const bodyText = language === 'hi' ? n.body_hi || n.body_en : n.body_en;

              return (
                <div
                  key={n.id}
                  className={`p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors ${
                    !n.is_read ? 'bg-[var(--surface-muted)]/40' : ''
                  }`}
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                        isCritical
                          ? 'bg-[var(--give-soft)] text-[var(--give)]'
                          : isWarning
                            ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                            : 'bg-[var(--surface-muted)] text-[var(--primary-dark)]'
                      }`}
                    >
                      {n.target_tab === 'items' || n.rule_key.includes('stock') ? (
                        <IconPackage size={18} stroke={2} />
                      ) : n.target_tab === 'parties' ? (
                        <IconUsers size={18} stroke={2} />
                      ) : (
                        <IconAlertCircle size={18} stroke={2} />
                      )}
                    </div>

                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`text-sm ${
                            !n.is_read ? 'font-semibold text-[var(--text)]' : 'font-medium text-[var(--text)]'
                          }`}
                        >
                          {titleText}
                        </span>
                        {!n.is_read && (
                          <span className="text-[11px] font-semibold text-[var(--primary-dark)]">
                            • {language === 'hi' ? 'नया' : 'Unread'}
                          </span>
                        )}
                      </div>
                      <p className="text-xs sm:text-sm text-[var(--text-muted)] leading-relaxed">
                        {bodyText}
                      </p>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        {formatDateTime(n.created_at)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    {!n.is_read && (
                      <button
                        type="button"
                        onClick={() => void handleMarkRead(n.id)}
                        className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5"
                      >
                        <IconCheck size={14} stroke={2} />
                        <span>{language === 'hi' ? 'पढ़ा गया' : 'Mark Read'}</span>
                      </button>
                    )}

                    {hasTarget && (
                      <button
                        type="button"
                        onClick={() => handleOpenNotificationTarget(n)}
                        className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
                      >
                        <span>{language === 'hi' ? 'खोलें' : 'Open'}</span>
                        <IconArrowRight size={14} stroke={2} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
