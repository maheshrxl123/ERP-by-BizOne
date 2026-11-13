import {
  IconArrowDownLeft,
  IconArrowUpRight,
  IconCash,
  IconChevronRight,
  IconClock,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconUsers,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatDate, formatINR } from '../../core/format';
import { supabase } from '../../core/supabase';
import type {
  KhataTotalsSummary,
  PartyBalanceRecord,
  PaymentDirection,
} from '../../types/bizone';
import { PartyDetailView } from './PartyDetailView';
import { PartyFormModal } from './PartyFormModal';
import { PaymentModal } from './PaymentModal';

type PartyFilterTab = 'all' | 'customer' | 'supplier' | 'overdue' | 'archived';

interface PartiesScreenProps {
  initialPartyId?: string | null;
  initialAction?: 'add-party' | 'receive-payment' | 'give-payment' | null;
  onActionConsumed?: () => void;
  onOpenPayments?: () => void;
  onNewBill?: (partyId: string) => void;
  onOpenBill?: (billId: string) => void;
}

export function PartiesScreen({
  initialPartyId,
  initialAction,
  onActionConsumed,
  onOpenPayments,
  onNewBill,
  onOpenBill,
}: PartiesScreenProps) {
  const { isModuleEnabled, language, t } = useApp();

  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(
    initialPartyId ?? null
  );
  const [summary, setSummary] = useState<KhataTotalsSummary | null>(null);
  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filterTab, setFilterTab] = useState<PartyFilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [addPartyOpen, setAddPartyOpen] = useState(false);
  const [quickPaymentParty, setQuickPaymentParty] =
    useState<PartyBalanceRecord | null>(null);
  const [quickPaymentDir, setQuickPaymentDir] =
    useState<PaymentDirection>('receive');
  const [quickPaymentOpen, setQuickPaymentOpen] = useState(false);

  const paymentsEnabled = isModuleEnabled('payments');

  const loadParties = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [sumRes, listRes] = await Promise.all([
        supabase.from('khata_totals_summary').select('*').maybeSingle(),
        supabase.from('party_balances').select('*').order('name', { ascending: true }),
      ]);
      if (sumRes.error) throw sumRes.error;
      if (listRes.error) throw listRes.error;

      setSummary((sumRes.data as KhataTotalsSummary | null) ?? null);
      setParties((listRes.data as PartyBalanceRecord[] | null) ?? []);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load parties.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadParties();
  }, [loadParties]);

  useEffect(() => {
    if (initialPartyId) {
      setSelectedPartyId(initialPartyId);
      onActionConsumed?.();
    }
  }, [initialPartyId, onActionConsumed]);

  useEffect(() => {
    if (initialAction === 'add-party') {
      setSelectedPartyId(null);
      setAddPartyOpen(true);
      onActionConsumed?.();
    }
  }, [initialAction, onActionConsumed]);

  const filteredParties = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return parties.filter((p) => {
      if (filterTab === 'archived') {
        if (p.is_active) return false;
      } else {
        if (!p.is_active) return false;
        if (filterTab === 'customer' && p.party_type === 'supplier') return false;
        if (filterTab === 'supplier' && p.party_type === 'customer') return false;
        if (filterTab === 'overdue' && !p.is_overdue) return false;
      }

      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.phone ?? '').toLowerCase().includes(q) ||
        (p.gstin ?? '').toLowerCase().includes(q)
      );
    });
  }, [parties, filterTab, searchQuery]);

  if (selectedPartyId) {
    return (
      <PartyDetailView
        partyId={selectedPartyId}
        onBack={() => {
          setSelectedPartyId(null);
          void loadParties();
        }}
        onUpdated={() => void loadParties()}
        onNewBill={onNewBill}
        onOpenBill={onOpenBill}
      />
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
            {t('parties.title')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--text-muted)] mt-0.5">
            {t('parties.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {paymentsEnabled && onOpenPayments && (
            <button
              type="button"
              onClick={onOpenPayments}
              className="h-11 px-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              <IconCash size={18} stroke={2} />
              <span>{t('nav.payments')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setAddPartyOpen(true)}
            className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
          >
            <IconPlus size={18} stroke={2.5} />
            <span>{t('parties.addParty')}</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--receive-text)]">
            <IconArrowDownLeft size={15} stroke={2} />
            <span>{t('parties.youllGet')}</span>
          </div>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--receive-text)]">
            {formatINR(Number(summary?.total_to_receive ?? 0))}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--give)]">
            <IconArrowUpRight size={15} stroke={2} />
            <span>{t('parties.youllGive')}</span>
          </div>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums text-[var(--give)]">
            {formatINR(Number(summary?.total_to_give ?? 0))}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--text-muted)]">
            <IconUsers size={15} stroke={2} />
            <span>{t('parties.activeParties')}</span>
          </div>
          <p className="mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums">
            {summary?.active_parties_count ?? 0}
          </p>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--text-muted)]">
            <IconClock size={15} stroke={2} />
            <span>{t('parties.overdueDues')}</span>
          </div>
          <p
            className={`mt-1.5 text-xl sm:text-2xl font-semibold tabular-nums ${
              (summary?.overdue_parties_count ?? 0) > 0
                ? 'text-[var(--give)]'
                : 'text-[var(--text)]'
            }`}
          >
            {summary?.overdue_parties_count ?? 0}
          </p>
        </div>
      </section>

      {loadError && (
        <div className="p-4 rounded-xl border border-[var(--give)]/40 bg-[var(--give-soft)] flex items-center justify-between gap-4 text-xs sm:text-sm text-[var(--give)]">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadParties()}
            className="h-9 px-3 rounded-lg border border-[var(--give)]/40 bg-[var(--surface)] text-xs font-medium text-[var(--text)] inline-flex items-center gap-1.5"
          >
            <IconRefresh size={14} stroke={2} />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      )}

      {/* Search & Filter Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <IconSearch
            size={17}
            stroke={2}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('parties.searchPlaceholder')}
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'all', label: t('parties.all') },
              { id: 'customer', label: t('parties.customers') },
              { id: 'supplier', label: t('parties.suppliers') },
              { id: 'overdue', label: t('parties.overdue') },
              { id: 'archived', label: t('parties.archived') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterTab(tab.id)}
              className={`min-h-[38px] px-3 rounded-lg border text-xs font-medium transition-colors ${
                filterTab === tab.id
                  ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Parties List / Empty State */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        {loading && parties.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--text-muted)]">
            {t('common.loading')}
          </div>
        ) : filteredParties.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm font-semibold">{t('parties.emptyTitle')}</p>
            <p className="text-xs sm:text-sm text-[var(--text-muted)] max-w-md mx-auto">
              {t('parties.emptyDesc')}
            </p>
            {filterTab === 'all' && !searchQuery && (
              <button
                type="button"
                onClick={() => setAddPartyOpen(true)}
                className="h-10 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs sm:text-sm font-semibold inline-flex items-center gap-1.5"
              >
                <IconPlus size={16} stroke={2.5} />
                <span>{t('parties.addParty')}</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    <th className="py-2.5 px-4 font-medium">{t('parties.name')}</th>
                    <th className="py-2.5 px-4 font-medium">{t('parties.type')}</th>
                    <th className="py-2.5 px-4 font-medium">
                      {language === 'hi' ? 'अंतिम लेनदेन' : 'Last Activity'}
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">
                      {t('parties.runningBalance')}
                    </th>
                    <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredParties.map((p) => {
                    const net = Number(p.net_balance || 0);
                    return (
                      <tr
                        key={p.party_id}
                        className="hover:bg-[var(--surface-muted)]/60 cursor-pointer"
                        onClick={() => setSelectedPartyId(p.party_id)}
                      >
                        <td className="py-3 px-4">
                          <div className="font-semibold text-[var(--text)]">
                            {p.name}
                          </div>
                          <div className="text-xs text-[var(--text-muted)] tabular-nums">
                            {p.phone || 'No phone'}
                            {p.gstin ? ` · ${p.gstin}` : ''}
                            {p.is_overdue ? ` · ${t('parties.overdue')}` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs text-[var(--text-muted)]">
                          {t(`parties.${p.party_type}`)}
                        </td>
                        <td className="py-3 px-4 text-xs text-[var(--text-muted)] tabular-nums">
                          {formatDate(p.last_entry_date)}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums whitespace-nowrap">
                          {net > 0 ? (
                            <div>
                              <span className="font-semibold text-[var(--receive-text)]">
                                {formatINR(net)}
                              </span>
                              <div className="text-[11px] text-[var(--receive-text)]">
                                {t('parties.youllGet')}
                              </div>
                            </div>
                          ) : net < 0 ? (
                            <div>
                              <span className="font-semibold text-[var(--give)]">
                                {formatINR(Math.abs(net))}
                              </span>
                              <div className="text-[11px] text-[var(--give)]">
                                {t('parties.youllGive')}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-[var(--text-muted)]">
                              {t('parties.settled')}
                            </span>
                          )}
                        </td>
                        <td
                          className="py-3 px-4 text-right whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="inline-flex items-center gap-1.5">
                            {paymentsEnabled && p.is_active && (
                              <button
                                type="button"
                                onClick={() => {
                                  setQuickPaymentParty(p);
                                  setQuickPaymentDir(
                                    net < 0 || p.party_type === 'supplier'
                                      ? 'give'
                                      : 'receive'
                                  );
                                  setQuickPaymentOpen(true);
                                }}
                                className="h-8 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium hover:bg-[var(--surface-muted)]"
                              >
                                {net < 0 || p.party_type === 'supplier'
                                  ? t('payments.givePayment')
                                  : t('payments.receivePayment')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setSelectedPartyId(p.party_id)}
                              className="h-8 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1 hover:bg-[var(--surface-muted)]"
                            >
                              <span>{language === 'hi' ? 'खाता' : 'Khata'}</span>
                              <IconChevronRight size={14} stroke={2} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Rows */}
            <div className="md:hidden divide-y divide-[var(--border)]">
              {filteredParties.map((p) => {
                const net = Number(p.net_balance || 0);
                return (
                  <button
                    key={p.party_id}
                    type="button"
                    onClick={() => setSelectedPartyId(p.party_id)}
                    className="w-full min-h-[64px] p-4 flex items-center justify-between gap-3 text-left hover:bg-[var(--surface-muted)]"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{p.name}</p>
                      <p className="text-xs text-[var(--text-muted)] truncate tabular-nums">
                        {t(`parties.${p.party_type}`)}
                        {p.phone ? ` · ${p.phone}` : ''}
                        {p.is_overdue ? ` · ${t('parties.overdue')}` : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0 tabular-nums">
                      {net > 0 ? (
                        <>
                          <p className="text-sm font-semibold text-[var(--receive-text)]">
                            {formatINR(net)}
                          </p>
                          <p className="text-[11px] text-[var(--receive-text)]">
                            {t('parties.youllGet')}
                          </p>
                        </>
                      ) : net < 0 ? (
                        <>
                          <p className="text-sm font-semibold text-[var(--give)]">
                            {formatINR(Math.abs(net))}
                          </p>
                          <p className="text-[11px] text-[var(--give)]">
                            {t('parties.youllGive')}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-[var(--text-muted)]">
                          {t('parties.settled')}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>

      <PartyFormModal
        open={addPartyOpen}
        onClose={() => setAddPartyOpen(false)}
        onSaved={(created) => {
          void loadParties();
          setSelectedPartyId(created.id);
        }}
      />

      <PaymentModal
        open={quickPaymentOpen}
        lockedParty={quickPaymentParty}
        initialDirection={quickPaymentDir}
        onClose={() => {
          setQuickPaymentOpen(false);
          setQuickPaymentParty(null);
        }}
        onSaved={() => void loadParties()}
      />
    </div>
  );
}
