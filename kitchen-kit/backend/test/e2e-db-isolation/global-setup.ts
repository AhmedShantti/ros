/**
 * Jest `globalSetup` — runs exactly once, in the main process, before any
 * worker starts. Builds this run's TEMPLATE database (migrated from zero)
 * and hands its identity to every worker via `runtime-state.ts`.
 *
 * The persistent `ros` database is never referenced here: `loadHarnessBaseEnv`
 * reads DATABASE_URL/APP_DATABASE_URL exactly as configured for this
 * invocation (`.env` locally, CI job env in CI), and every database this
 * harness creates is a freshly-generated `ros_test_e2e_*` name, checked by
 * `assertScratchDatabaseName` before every CREATE.
 */
import { loadHarnessBaseEnv } from './env';
import { generateRunId, templateDatabaseName } from './run-id';
import {
  createDatabase,
  ensureAppRole,
  migrateFromZero,
  withAdminConnection,
} from './provision';
import { withDatabaseName } from './db-url';
import { RUN_ID_ENV_VAR, writeRuntimeState } from './runtime-state';

export default async function globalSetup(): Promise<void> {
  const env = loadHarnessBaseEnv();
  const runId = generateRunId();
  // Set BEFORE any worker is spawned (Jest never starts a worker until this
  // function's promise resolves), so every worker's `child_process.fork`
  // inherits it and can find this exact invocation's own runtime-state file
  // — see runtime-state.ts for why this matters when two separate `npx jest`
  // invocations race on the same machine.
  process.env[RUN_ID_ENV_VAR] = runId;
  const templateName = templateDatabaseName(runId);
  const templateMigratorUrl = withDatabaseName(
    env.migratorBaseUrl,
    templateName,
  );

  await withAdminConnection(env.migratorBaseUrl, async (admin) => {
    await ensureAppRole(admin, env.appRoleName, env.appRolePassword);
    await createDatabase(admin, templateName, {
      owner: env.migratorRoleName,
      grantConnectTo: env.appRoleName,
    });
  });

  migrateFromZero(templateMigratorUrl);

  writeRuntimeState({
    runId,
    migratorBaseUrl: env.migratorBaseUrl,
    appBaseUrl: env.appBaseUrl,
    migratorRoleName: env.migratorRoleName,
    appRoleName: env.appRoleName,
    templateDatabaseName: templateName,
  });

  console.log(
    `[e2e-db-isolation] run ${runId}: template database "${templateName}" ` +
      'migrated from zero — per-suite databases will clone it.',
  );
}
