import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';

/**
 * Regression test for the E2E database-isolation harness (G1-2) itself.
 *
 * ROOT CAUSE THIS GUARDS AGAINST: `AppModule`'s `ConfigModule.forRoot()`
 * snapshots `process.env.DATABASE_URL` / `APP_DATABASE_URL` synchronously
 * at import time (decorator evaluation), not at `NestFactory`/testing-module
 * instantiation time. A harness that rewrites those env vars from a
 * `setupFilesAfterEnv` `beforeAll` hook rewrites them too late — `AppModule`
 * has already been imported (and `ConfigModule.forRoot()` already run) by
 * the time any `beforeAll` body executes, so `ConfigService` keeps
 * resolving to whatever `.env` said: the persistent, shared `ros` database.
 *
 * This was discovered because it silently defeated per-suite database
 * isolation for `organisation.e2e-spec.ts` and (independently confirmed)
 * `approval-runtime.e2e-spec.ts` — both use a whole-table invariant/grant
 * scan that a shared, long-lived database, but not a fresh one, can fail.
 * Every other suite's assertions happened to check only values relative to
 * rows the test itself just created, which stayed correct regardless of
 * which physical database was actually connected — so the defect was
 * invisible everywhere else.
 *
 * The fix moved per-suite database provisioning into a custom Jest
 * `testEnvironment` (`e2e-database-environment.ts`), whose `setup()` Jest
 * awaits BEFORE loading the test file — and therefore before `AppModule` is
 * ever imported. This test proves that ordering holds: that by the time a
 * real `TestingModule` is compiled, `ConfigService` already sees this
 * suite's own per-suite scratch database, not the base connection string.
 */
describe('E2E database isolation — ConfigService sees the per-suite database', () => {
  it('resolves DATABASE_URL/APP_DATABASE_URL to a ros_test_e2e_* scratch database, not the base connection string', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const config = moduleFixture.get(ConfigService);

    const databaseUrl = config.getOrThrow<string>('DATABASE_URL');
    const appDatabaseUrl = config.getOrThrow<string>('APP_DATABASE_URL');

    // The base .env values point at the persistent `ros` database — proving
    // ConfigService resolved to something else proves the per-suite
    // rewrite happened before AppModule's ConfigModule.forRoot() snapshot.
    expect(databaseUrl).not.toMatch(/\/ros(\?|$)/);
    expect(appDatabaseUrl).not.toMatch(/\/ros(\?|$)/);
    expect(databaseUrl).toMatch(/\/ros_test_e2e_[a-z0-9_]+\?/);
    expect(appDatabaseUrl).toMatch(/\/ros_test_e2e_[a-z0-9_]+\?/);

    // Both must point at the SAME scratch database (migrator vs. app-role
    // credentials on one shared per-suite clone), never two different ones.
    const scratchName = (url: string) =>
      new URL(url).pathname.replace(/^\//, '');
    expect(scratchName(appDatabaseUrl)).toBe(scratchName(databaseUrl));

    await moduleFixture.close();
  });
});
