/**
 * Custom Jest `testEnvironment` for the e2e database-isolation harness (G1-2).
 *
 * WHY THIS EXISTS (root cause this file fixes):
 *
 * The harness previously provisioned each suite's private database from a
 * `setupFilesAfterEnv` `beforeAll` hook (see the removed `jest-hooks.ts`).
 * That hook DID run, and DID rewrite `process.env.DATABASE_URL` /
 * `APP_DATABASE_URL` to the suite's own scratch database, before the spec
 * file's own `beforeAll` body executed.
 *
 * But `AppModule` — imported at the top of every `*.e2e-spec.ts` file — has
 * `ConfigModule.forRoot({...})` inside its `@Module(...)` decorator. A
 * decorator's argument is evaluated the moment the class declaration runs,
 * i.e. the moment the module is first `import`ed, and `@nestjs/config`
 * snapshots `process.env` synchronously at that call. Jest must fully
 * *load* (not yet run any hook of) every `setupFilesAfterEnv` file and the
 * test file itself before it can start executing any registered `beforeAll`
 * — so `AppModule`'s import, and therefore `ConfigModule.forRoot()`'s env
 * snapshot, always happened during that load phase, strictly BEFORE
 * `jest-hooks.ts`'s `beforeAll` body ran and rewrote the env vars.
 *
 * Net effect: `ConfigService.get('DATABASE_URL'/'APP_DATABASE_URL')` — and
 * therefore every `PrismaService` (the app's own runtime client) and every
 * `createMigratorClient(app)` admin test client — silently kept resolving
 * to whatever `.env` said (the persistent, shared `ros` database), no
 * matter what the per-suite scratch database was named or how correctly it
 * was cloned/migrated/dropped. The scratch database existed and was
 * correctly swept; it was simply never the database the application under
 * test, or the test's own admin client, actually queried.
 *
 * This was invisible for almost every suite, because almost every assertion
 * checks a value relative to a row the test itself just created (e.g. "this
 * movement's persisted delta equals X"), which holds regardless of whether
 * other, unrelated historical rows also exist in the same database. It was
 * only exposed by whole-table invariant scans
 * (`organisation.e2e-spec.ts`'s "leaves no org location entity without a
 * registry row", `approval-runtime.e2e-spec.ts`'s column-grant probe) that
 * count or scan an entire table rather than a value the test itself
 * produced.
 *
 * THE FIX: do the per-suite clone-and-env-rewrite in a custom
 * `testEnvironment`'s `setup()`, which Jest awaits BEFORE loading the test
 * file (and therefore before `AppModule` is ever imported and before
 * `ConfigModule.forRoot()` ever snapshots `process.env`) — not in a
 * `setupFilesAfterEnv` hook, which only runs before the test file's own
 * hooks, not before the test file's own imports.
 */
import { basename } from 'node:path';
import type {
  EnvironmentContext,
  JestEnvironmentConfig,
} from '@jest/environment';
import NodeEnvironment from 'jest-environment-node';
import { withDatabaseName } from './db-url';
import { createDatabase, dropDatabase, withAdminConnection } from './provision';
import { readRuntimeState, type E2eDbRuntimeState } from './runtime-state';
import { suiteDatabaseName } from './run-id';

function suiteTagFromTestPath(testPath: string): string {
  return basename(testPath).replace(/\.e2e-spec\.ts$/, '');
}

export default class E2eDatabaseEnvironment extends NodeEnvironment {
  private readonly testPath: string;
  private state: E2eDbRuntimeState | null = null;
  private scratchDatabaseName: string | null = null;

  constructor(config: JestEnvironmentConfig, context: EnvironmentContext) {
    super(config, context);
    this.testPath = context.testPath;
  }

  async setup(): Promise<void> {
    await super.setup();

    // Skip entirely for anything not matched by testRegex as an e2e spec
    // (defensive — jest-e2e.json's testRegex already restricts to these).
    if (!/\.e2e-spec\.ts$/.test(this.testPath)) return;

    const state = readRuntimeState();
    this.state = state;
    const scratchDatabaseName = suiteDatabaseName(
      state.runId,
      suiteTagFromTestPath(this.testPath),
    );
    this.scratchDatabaseName = scratchDatabaseName;

    await withAdminConnection(state.migratorBaseUrl, (admin) =>
      createDatabase(admin, scratchDatabaseName, {
        owner: state.migratorRoleName,
        template: state.templateDatabaseName,
        grantConnectTo: [state.appRoleName, state.partitionAdminRoleName],
      }),
    );

    const migratorUrl = withDatabaseName(
      state.migratorBaseUrl,
      scratchDatabaseName,
    );
    const appUrl = withDatabaseName(state.appBaseUrl, scratchDatabaseName);
    const partitionAdminUrl = withDatabaseName(
      state.partitionAdminBaseUrl,
      scratchDatabaseName,
    );

    // Both the real process.env (read by anything not going through the
    // sandboxed environment global) and this.global.process.env (what the
    // test file/AppModule will actually see) — in `jest-environment-node`
    // these are the same live process, but setting both is cheap and
    // removes any doubt.
    process.env.DATABASE_URL = migratorUrl;
    process.env.APP_DATABASE_URL = appUrl;
    process.env.PARTITION_ADMIN_DATABASE_URL = partitionAdminUrl;
    this.global.process.env.DATABASE_URL = migratorUrl;
    this.global.process.env.APP_DATABASE_URL = appUrl;
    this.global.process.env.PARTITION_ADMIN_DATABASE_URL = partitionAdminUrl;
  }

  async teardown(): Promise<void> {
    if (this.state && this.scratchDatabaseName) {
      // Reset before dropping so nothing in this worker can observe a
      // stale pointer to an already-dropped database.
      process.env.DATABASE_URL = this.state.migratorBaseUrl;
      process.env.APP_DATABASE_URL = this.state.appBaseUrl;
      process.env.PARTITION_ADMIN_DATABASE_URL =
        this.state.partitionAdminBaseUrl;

      await withAdminConnection(this.state.migratorBaseUrl, (admin) =>
        dropDatabase(admin, this.scratchDatabaseName as string),
      );
    }
    await super.teardown();
  }
}
