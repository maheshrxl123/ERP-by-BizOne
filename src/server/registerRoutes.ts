import type { Express } from 'express';
import { registerAdminUserRoutes } from './routes/adminUsers.ts';
import { registerAiRoutes } from './routes/ai.ts';
import { registerBackupRoutes } from './routes/backup.ts';
import { registerEinvoiceRoutes } from './routes/einvoice.ts';
import { registerFeatureModuleRoutes } from './routes/featureModules.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerGoogleDriveRoutes } from './routes/googleDrive.ts';
import { registerIntegrationRoutes } from './routes/integrations.ts';
import { registerMessagingRoutes } from './routes/messaging.ts';
import { registerSetupRoutes } from './routes/setup.ts';
import { registerShareRoutes } from './routes/share.ts';
import { registerStoreAdminRoutes } from './routes/storeAdmin.ts';
import { registerStorefrontRoutes } from './routes/storefront.ts';
import { registerTotpRoutes } from './routes/totp.ts';

export function registerAllApiRoutes(app: Express) {
  registerSetupRoutes(app);
  registerAdminUserRoutes(app);
  registerFileRoutes(app);
  registerIntegrationRoutes(app);
  registerBackupRoutes(app);
  registerGoogleDriveRoutes(app);
  registerAiRoutes(app);
  registerMessagingRoutes(app);
  registerEinvoiceRoutes(app);
  registerFeatureModuleRoutes(app);
  registerShareRoutes(app);
  registerStorefrontRoutes(app);
  registerStoreAdminRoutes(app);
  registerTotpRoutes(app);
}
