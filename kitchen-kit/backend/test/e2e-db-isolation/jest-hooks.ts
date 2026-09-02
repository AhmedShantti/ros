/**
 * Jest `setupFilesAfterEnv` module — re-evaluated fresh for every test FILE
 * (even when Jest reuses the worker process across files), so this module's
 * own top-level `beforeAll`/`afterAll` registration runs once per suite.
 *
 * Registered before the spec file's own `import { AppModule } from
 * '../src/app.module'` and `Test.createTestingModule(...).compile()` calls,
 * so:
 *  - our `beforeAll` (clone the suite's private database, point
 *    DATABASE_URL/APP_DATABASE_URL at it) always runs BEFORE the spec file's
 *    own `beforeAll` bootstraps Nest and Nest's `ConfigModule` reads those
 *    env vars;
 *  - Jest runs `afterAll` hooks in reverse-registration order, so our
 *    `afterAll` (drop the database) always runs AFTER the spec file's own
 *    `afterAll` closes the Nest app / Prisma connections — and
 *    `provision.dropDatabase` also proactively terminates any connections
 *    that remain, so a suite that forgets to close its app cannot block
 *    cleanup.
 *
 * No business e2e fixture file is touched: every existing spec file keeps
 * building its own fixtures exactly as before, now just against a private,
 * pre-migrated database instead of the shared one.
 */
import { basename } from 'node:path';
import { withDatabaseName } from './db-url';
import { createDatabase, dropDatabase, withAdminConnection } from './provision';
import { readRuntimeState } from './runtime-state';
import { suiteDatabaseName } from './run-id';

function currentSuiteTag(): string {
  try {
    const testPath = expect.getState().testPath;
    if (testPath) return basename(testPath).replace(/\.e2e-spec\.ts$/, '');
  } catch {
    // expect.getState() is best-effort here (for a readable database name
    // only) — fall through to the generic tag below.
  }
  return 'suite';
}

let scratchDatabaseName: string;

beforeAll(async () => {
  const state = readRuntimeState();
  scratchDatabaseName = suiteDatabaseName(state.runId, currentSuiteTag());

  await withAdminConnection(state.migratorBaseUrl, (admin) =>
    createDatabase(admin, scratchDatabaseName, {
      owner: state.migratorRoleName,
      template: state.templateDatabaseName,
      grantConnectTo: state.appRoleName,
    }),
  );

  process.env.DATABASE_URL = withDatabaseName(
    state.migratorBaseUrl,
    scratchDatabaseName,
  );
  process.env.APP_DATABASE_URL = withDatabaseName(
    state.appBaseUrl,
    scratchDatabaseName,
  );
}, 30_000);

afterAll(async () => {
  const state = readRuntimeState();
  // Reset before dropping so a later hook/suite in the same worker process
  // never observes a stale pointer to an already-dropped database.
  process.env.DATABASE_URL = state.migratorBaseUrl;
  process.env.APP_DATABASE_URL = state.appBaseUrl;

  await withAdminConnection(state.migratorBaseUrl, (admin) =>
    dropDatabase(admin, scratchDatabaseName),
  );
}, 30_000);
