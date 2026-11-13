import { IconLock, IconSettings } from '@tabler/icons-react';
import { MODULE_REGISTRY } from '../../config/modules.config';
import { useApp } from '../app/AppProvider';
import { hasCapability, type Capability } from '../core/permissions';
import type { AppDestination } from '../modules/dashboard/HomeScreen';

const MODULE_CAPABILITY: Record<string, Capability> = {
  billing: 'create_bills',
  parties: 'parties',
  inventory: 'items',
  purchases: 'purchases',
  payments: 'payments',
  expenses: 'expenses',
  reports: 'reports',
};

interface ModulePhasePlaceholderProps {
  moduleKey: string;
  onNavigate: (dest: AppDestination, settingsTab?: string) => void;
}

export function ModulePhasePlaceholder({
  moduleKey,
  onNavigate,
}: ModulePhasePlaceholderProps) {
  const { isModuleEnabled, profile, language } = useApp();
  const def = MODULE_REGISTRY.find((m) => m.key === moduleKey);
  const enabled = isModuleEnabled(moduleKey);
  const isOwner = profile?.role === 'owner';
  const requiredCap = MODULE_CAPABILITY[moduleKey];
  const hasPermission =
    !requiredCap ||
    hasCapability(profile?.role, requiredCap) ||
    (moduleKey === 'inventory' && hasCapability(profile?.role, 'create_bills'));

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 mt-4">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-[var(--primary-dark)]">
              {def ? `Roadmap ${def.phase}` : 'Module'}
            </p>
            <h1 className="text-xl font-semibold mt-1">
              {def
                ? language === 'hi'
                  ? def.nameHi
                  : def.nameEn
                : moduleKey}
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1.5">
              {def
                ? language === 'hi'
                  ? def.descriptionHi
                  : def.descriptionEn
                : ''}
            </p>
          </div>
          {!hasPermission ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--give)] shrink-0">
              <IconLock size={15} stroke={2} />
              <span>Restricted</span>
            </span>
          ) : !enabled ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--give)] shrink-0">
              <IconLock size={15} stroke={2} />
              <span>Disabled</span>
            </span>
          ) : null}
        </div>

        <div className="p-4 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs sm:text-sm text-[var(--text-muted)] leading-relaxed">
          {!hasPermission
            ? 'Your assigned role does not have permission to access this module.'
            : enabled
              ? `This workspace is currently running Phase 1 (Foundation, Authentication, Business Setup, Profile, Uploads & Permissions). Full ${def?.nameEn || moduleKey} workflows activate in ${def?.phase || 'upcoming phases'}.`
              : 'This module is currently turned off in Settings -> Modules & Features. All routes and RPC access remain locked while disabled.'}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onNavigate('home')}
            className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold"
          >
            Back to Home
          </button>
          {isOwner && (
            <button
              type="button"
              onClick={() => onNavigate('settings', 'modules')}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              <IconSettings size={17} stroke={2} />
              <span>Module Settings</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
