/**
 * Recovery tool for the e2e database-isolation harness (G1-2).
 *
 * Normal operation never needs this: each suite drops its own scratch
 * database in `afterAll`, and `globalTeardown` sweeps anything left behind by
 * *that same run*. The one gap neither covers is a run whose Jest process was
 * killed hard enough that `globalTeardown` itself never executed (a SIGKILL,
 * an OOM, a hard CI cancel) — its `ros_test_e2e_<runId>_*` databases then have
 * no automatic cleanup, since a run only ever sweeps its own id.
 *
 * This script finds every `ros_test_e2e_*` database whose embedded run id is
 * older than `--older-than-minutes` (default 60) and drops it, through the
 * same fail-closed `assertScratchDatabaseName` guard the harness itself uses.
 * Safe to run at any time, including while other runs are active: a run id
 * embeds its own creation time, so an in-progress run's databases are simply
 * too young to match and are left untouched.
 *
 * Usage: npx ts-node scripts/db/sweep-stale-scratch-databases.ts [--older-than-minutes=60] [--dry-run]
 */
import { loadHarnessBaseEnv } from '../../test/e2e-db-isolation/env';
import {
  dropDatabase,
  listDatabasesWithPrefix,
  withAdminConnection,
} from '../../test/e2e-db-isolation/provision';
import { runIdCreatedAtMs } from '../../test/e2e-db-isolation/run-id';

function parseArgs(argv: string[]): {
  olderThanMinutes: number;
  dryRun: boolean;
} {
  const olderThanArg = argv.find((a) => a.startsWith('--older-than-minutes='));
  const olderThanMinutes = olderThanArg
    ? Number(olderThanArg.split('=')[1])
    : 60;
  return { olderThanMinutes, dryRun: argv.includes('--dry-run') };
}

// ros_test_e2e_<runId>_... where runId = <base36-epoch-ms>_<6-hex>
const SCRATCH_PREFIX = 'ros_test_e2e_';
const RUN_ID_PATTERN = /^ros_test_e2e_([0-9a-z]+_[0-9a-f]{6})_/;

async function main(): Promise<void> {
  const { olderThanMinutes, dryRun } = parseArgs(process.argv.slice(2));
  const cutoffMs = Date.now() - olderThanMinutes * 60_000;
  const env = loadHarnessBaseEnv();

  await withAdminConnection(env.migratorBaseUrl, async (admin) => {
    const names = await listDatabasesWithPrefix(admin, SCRATCH_PREFIX);
    const stale = names.filter((name) => {
      const match = RUN_ID_PATTERN.exec(name);
      if (!match) return false; // not this harness's naming shape — leave alone
      return runIdCreatedAtMs(match[1]) < cutoffMs;
    });

    if (stale.length === 0) {
      console.log(
        `sweep-stale-scratch-databases: nothing older than ${olderThanMinutes}m among ${names.length} "${SCRATCH_PREFIX}*" database(s).`,
      );
      return;
    }

    for (const name of stale) {
      if (dryRun) {
        console.log(`[dry-run] would drop ${name}`);
        continue;
      }
      await dropDatabase(admin, name);
      console.log(`dropped ${name}`);
    }
  });
}

main().catch((err) => {
  console.error('sweep-stale-scratch-databases failed:', err);
  process.exit(1);
});
