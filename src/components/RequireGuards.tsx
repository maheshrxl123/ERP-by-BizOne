import { IconLock, IconSettings } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { MODULE_REGISTRY } from '../../config/modules.config';
import { useApp } from '../app/AppProvider';
import type { UserRole } from '../core/permissions';
import type { AppDestination } from '../modules/dashboard/HomeScreen';

interface RequireModuleProps {
  moduleKey: string;
  onNavigate: (dest: AppDestination, settingsTab?: string) => void;
  children: ReactNode;
}

export function RequireModule({
  moduleKey,
  onNavigate,
  children,
}: RequireModuleProps) {
  const { isModuleEnabled, profile, language } = useApp();
  const enabled = isModuleEnabled(moduleKey);
  if (enabled) return <>{children}</>;

  const def = MODULE_REGISTRY.find((m) => m.key === moduleKey);
  const isOwner = profile?.role === 'owner';

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 mt-4">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold inline-flex items-center gap-2">
              <IconLock size={20} stroke={2} className="text-[var(--primary-dark)] shrink-0" />
              <span>{def ? (language === 'hi' ? def.nameHi : def.nameEn) : moduleKey}</span>
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              {language === 'hi'
                ? 'यह मॉड्यूल सेटिंग्स -> मॉड्यूल और सुविधाएं में बंद है।'
                : 'This module is currently turned off in Settings -> Modules & Features.'}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--give)] shrink-0">
            <IconLock size={15} stroke={2} />
            <span>{language === 'hi' ? 'बंद है' : 'Disabled'}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onNavigate('home')}
            className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold"
          >
            {language === 'hi' ? 'होम पर वापस जाएं' : 'Back to Home'}
          </button>
          {isOwner && (
            <button
              type="button"
              onClick={() => onNavigate('settings', 'modules')}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              <IconSettings size={17} stroke={2} />
              <span>{language === 'hi' ? 'मॉड्यूल सेटिंग्स' : 'Module Settings'}</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

interface RequireRoleProps {
  roles: UserRole[];
  onNavigate: (dest: AppDestination, settingsTab?: string) => void;
  children: ReactNode;
}

export function RequireRole({ roles, onNavigate, children }: RequireRoleProps) {
  const { profile, language } = useApp();
  if (profile?.role && roles.includes(profile.role)) {
    return <>{children}</>;
  }

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 mt-4">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold inline-flex items-center gap-2">
              <IconLock size={20} stroke={2} className="text-[var(--primary-dark)] shrink-0" />
              <span>{language === 'hi' ? 'पहुंच प्रतिबंधित' : 'Access Restricted'}</span>
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              {language === 'hi'
                ? 'आपकी भूमिका को इस अनुभाग तक पहुंचने की अनुमति नहीं है।'
                : 'Your assigned role does not have permission to access this module.'}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--give)] shrink-0">
            <IconLock size={15} stroke={2} />
            <span>{language === 'hi' ? 'प्रतिबंधित' : 'Restricted'}</span>
          </span>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="h-11 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold"
        >
          {language === 'hi' ? 'होम पर वापस जाएं' : 'Back to Home'}
        </button>
      </section>
    </div>
  );
}
