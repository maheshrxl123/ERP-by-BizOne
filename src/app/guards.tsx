import { IconLock } from '@tabler/icons-react';
import type { UserRole } from '../core/permissions';
import { useApp } from './AppProvider';

interface RequireRoleProps {
  roles: UserRole[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function RequireRole({ roles, children, fallback }: RequireRoleProps) {
  const { profile, t } = useApp();

  if (!profile || !roles.includes(profile.role)) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center space-y-2">
        <IconLock size={24} stroke={2} className="text-[var(--give)] mx-auto" />
        <p className="text-sm font-semibold">Permission required</p>
        <p className="text-xs text-[var(--text-muted)]">
          {t('settings.noPermission')}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

interface RequireModuleProps {
  moduleKey: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function RequireModule({
  moduleKey,
  children,
  fallback,
}: RequireModuleProps) {
  const { isModuleEnabled } = useApp();

  if (!isModuleEnabled(moduleKey)) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center space-y-2">
        <IconLock size={24} stroke={2} className="text-[var(--text-muted)] mx-auto" />
        <p className="text-sm font-semibold">Module disabled</p>
        <p className="text-xs text-[var(--text-muted)]">
          Enable this module in Settings → Modules & Features to use it.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
