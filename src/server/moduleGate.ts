import type { NextFunction, Request, Response } from 'express';

export type ModuleEnabledChecker = (moduleKey: string) => Promise<boolean>;

export function createModuleGate(isEnabled: ModuleEnabledChecker) {
  return function requireModuleEnabled(...moduleKeys: string[]) {
    return async (_req: Request, res: Response, next: NextFunction) => {
      try {
        for (const moduleKey of moduleKeys) {
          const enabled = await isEnabled(moduleKey);
          if (!enabled) {
            res.status(403).json({
              error: `Feature "${moduleKey}" is currently turned off in Settings -> Modules.`,
              moduleKey,
            });
            return;
          }
        }
        next();
      } catch {
        res.status(403).json({
          error: 'Unable to verify module activation state.',
          moduleKey: moduleKeys[0] || null,
        });
      }
    };
  };
}
