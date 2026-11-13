import { IconSearch, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { MODULE_REGISTRY } from '../../config/modules.config';
import { useApp } from '../app/AppProvider';
import { formatINR } from '../core/format';
import { hasCapability } from '../core/permissions';
import { supabase } from '../core/supabase';
import type { AppDestination } from '../modules/dashboard/HomeScreen';
import type { ItemFilterTab } from '../modules/items/ItemsScreen';
import type { ItemCatalogRecord, PartyBalanceRecord } from '../types/bizone';

interface GlobalSearchModalProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (
    dest: AppDestination,
    settingsTab?: string,
    opts?: {
      partyId?: string | null;
      itemId?: string | null;
      itemFilter?: ItemFilterTab | null;
      action?:
        | 'add-party'
        | 'add-item'
        | 'receive-payment'
        | 'give-payment'
        | null;
    }
  ) => void;
}

export function GlobalSearchModal({
  open,
  onClose,
  onNavigate,
}: GlobalSearchModalProps) {
  const { staff, profile, isModuleEnabled, language, t } = useApp();
  const [query, setQuery] = useState('');
  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);
  const [catalogItems, setCatalogItems] = useState<ItemCatalogRecord[]>([]);

  const canSearchParties =
    isModuleEnabled('parties') && hasCapability(profile?.role, 'parties');
  const canSearchItems =
    isModuleEnabled('inventory') &&
    (hasCapability(profile?.role, 'items') ||
      hasCapability(profile?.role, 'create_bills'));

  useEffect(() => {
    if (!open) return;
    setQuery('');
    if (canSearchParties) {
      supabase
        .from('party_balances')
        .select('*')
        .eq('is_active', true)
        .order('name')
        .limit(100)
        .then(({ data }) => {
          setParties((data as PartyBalanceRecord[] | null) ?? []);
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
        .then(({ data }) => {
          setCatalogItems((data as ItemCatalogRecord[] | null) ?? []);
        });
    } else {
      setCatalogItems([]);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, canSearchParties, canSearchItems]);

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
    ];

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
    }

    for (const mod of MODULE_REGISTRY) {
      items.push({
        id: `mod-${mod.key}`,
        title: language === 'hi' ? mod.nameHi : mod.nameEn,
        subtitle: `Module · ${mod.phase}`,
        action: () =>
          profile?.role === 'owner'
            ? onNavigate('settings', 'modules')
            : onNavigate('home'),
      });
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
    parties,
    catalogItems,
    canSearchParties,
    canSearchItems,
    isModuleEnabled,
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
            className="flex-1 bg-transparent text-sm focus:outline-none"
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
