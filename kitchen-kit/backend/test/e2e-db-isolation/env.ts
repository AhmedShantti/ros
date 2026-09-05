/**
 * Reads the two base connection strings the harness clones from: the
 * migrator/owner role (DATABASE_URL) and the runtime app role
 * (APP_DATABASE_URL). Neither is ever mutated — every scratch/template
 * database is a name-swapped copy of these, on the same server, same
 * credentials, same roles that already exist in `prisma/migrations`' own
 * GRANT statements.
 *
 * Calls `dotenv` itself (harmless if it's already loaded elsewhere, and a
 * no-op for any variable already set) so the harness works whether the
 * caller is a local `npm run test:e2e` reading `.env`, or CI, which sets
 * these directly as job env — no dependency on Nest's own (later, lazier)
 * ConfigModule bootstrap order.
 */
import 'dotenv/config';

export interface HarnessBaseEnv {
  migratorBaseUrl: string;
  appBaseUrl: string;
  partitionAdminBaseUrl: string;
  migratorRoleName: string;
  appRoleName: string;
  appRolePassword: string;
  partitionAdminRoleName: string;
  partitionAdminPassword: string;
}

export function loadHarnessBaseEnv(): HarnessBaseEnv {
  const migratorBaseUrl = process.env.DATABASE_URL;
  const appBaseUrl = process.env.APP_DATABASE_URL;
  const partitionAdminBaseUrl = process.env.PARTITION_ADMIN_DATABASE_URL;
  if (!migratorBaseUrl || !appBaseUrl || !partitionAdminBaseUrl) {
    throw new Error(
      'e2e-db-isolation: DATABASE_URL, APP_DATABASE_URL and ' +
        'PARTITION_ADMIN_DATABASE_URL must all be set (directly, or via ' +
        '.env) before running the e2e suite.',
    );
  }
  const migratorUrl = new URL(migratorBaseUrl);
  const appUrl = new URL(appBaseUrl);
  const partitionAdminUrl = new URL(partitionAdminBaseUrl);
  return {
    migratorBaseUrl,
    appBaseUrl,
    partitionAdminBaseUrl,
    migratorRoleName: decodeURIComponent(migratorUrl.username),
    appRoleName: decodeURIComponent(appUrl.username),
    appRolePassword: decodeURIComponent(appUrl.password),
    partitionAdminRoleName: decodeURIComponent(partitionAdminUrl.username),
    partitionAdminPassword: decodeURIComponent(partitionAdminUrl.password),
  };
}
