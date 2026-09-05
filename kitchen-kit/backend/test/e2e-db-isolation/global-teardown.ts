/**
 * Jest `globalTeardown` — runs once, after every worker has finished (pass
 * or fail). Per-suite hooks (`jest-hooks.ts`) already drop their own
 * database in `afterAll`; this is the backstop that sweeps anything a
 * crashed suite left behind, scoped strictly to THIS run's own id — never a
 * broader pattern that could touch another run's or lane's databases.
 */
import {
  dropDatabase,
  listDatabasesWithPrefix,
  withAdminConnection,
} from './provision';
import {
  clearRuntimeState,
  readRuntimeState,
  type E2eDbRuntimeState,
} from './runtime-state';
import { scratchDatabasePrefix } from './run-id';

export default async function globalTeardown(): Promise<void> {
  let state: E2eDbRuntimeState;
  try {
    state = readRuntimeState();
  } catch {
    // globalSetup never ran (e.g. --listTests) — nothing to tear down.
    return;
  }

  const prefix = scratchDatabasePrefix(state.runId);
  await withAdminConnection(state.migratorBaseUrl, async (admin) => {
    const orphaned = await listDatabasesWithPrefix(admin, prefix);
    for (const name of orphaned) {
      await dropDatabase(admin, name);
    }
    console.log(
      `[e2e-db-isolation] run ${state.runId}: swept ${orphaned.length} ` +
        `database(s) matching "${prefix}*" (includes the template).`,
    );
  });

  clearRuntimeState();
}
