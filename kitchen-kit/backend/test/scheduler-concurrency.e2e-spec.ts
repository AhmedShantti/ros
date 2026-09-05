import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { App } from 'supertest/types';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';
import {
  FIXED_KEY,
  FIXED_NOW,
  TEST_FINDING_CODE,
  TEST_JOB,
  TestJobControl,
  bootSchedulerApp,
  clearScheduler,
  createSchedulerTenant,
  onlyJob,
  readFindings,
  readOccurrence,
  readOccurrences,
  runnerOf,
} from './scheduler-fixtures';

/**
 * SCHED-1 — THE MULTI-INSTANCE HARD GATE.
 *
 * ── WHY THIS IS TWO REAL INSTANCES ────────────────────────────────────────
 * `bootSchedulerApp()` is called TWICE against the same scratch database. Each
 * Nest application has its own `PrismaService` (its own connection pool) and
 * its own `ScheduledJobRunnerService` with its own `processId`, so `alpha` and
 * `bravo` below are as independent as two pods behind a load balancer. Nothing
 * in this suite proves a property of one object calling itself twice.
 *
 * ── WHY NOTHING HERE IS TIMING LUCK ───────────────────────────────────────
 * Three deterministic mechanisms, no sleeps anywhere in the file:
 *
 *   1. `FOR UPDATE SKIP LOCKED` semantics are proven against an EXPLICIT row
 *      lock held by a separate `pg` client, so the "loser" outcome is arranged,
 *      not hoped for.
 *   2. The lease is expired by WRITING a past `lease_expires_at` relative to the
 *      injected tick instant — never by waiting for one to elapse.
 *   3. A handler-level promise barrier (`TestJobControl.gate`) holds instance
 *      alpha provably inside its handler while bravo reclaims and completes the
 *      same occurrence. `gateEntered` resolves when the handler is entered, so
 *      the test never polls.
 *
 * Every assertion is on durable rows read back through the owner client.
 */
describe('Scheduler multi-instance concurrency (e2e)', () => {
  let alpha: INestApplication<App>;
  let bravo: INestApplication<App>;
  let admin: PrismaClient;
  let tenantA: string;
  let tenantB: string;
  let migratorUrl: string;

  beforeAll(async () => {
    alpha = await bootSchedulerApp();
    bravo = await bootSchedulerApp();
    admin = createMigratorClient(alpha);
    migratorUrl = alpha.get(ConfigService).getOrThrow<string>('DATABASE_URL');
    tenantA = await createSchedulerTenant(admin, 'conc-a');
    tenantB = await createSchedulerTenant(admin, 'conc-b');
  }, 120_000);

  afterAll(async () => {
    await admin.$disconnect();
    await alpha.close();
    await bravo.close();
  });

  beforeEach(async () => {
    TestJobControl.reset();
    await clearScheduler(admin, [tenantA, tenantB]);
  });

  const tickOn = (
    app: INestApplication<App>,
    tenantIds: string[],
    now: Date = FIXED_NOW,
  ) => runnerOf(app).runTick({ now, tenantIds, claimBatch: 50 });

  /** Expire a live lease by writing the past, relative to the tick instant. */
  const expireLease = (tenantId: string, jobType: string, key: string) =>
    admin.scheduledJobOccurrence.update({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId,
          jobType,
          occurrenceKey: key,
        },
      },
      data: { leaseExpiresAt: new Date(FIXED_NOW.getTime() - 60_000) },
    });

  // ── 1. Two workers race to claim the same occurrence ──────────────────────

  it('1. two instances racing on the SAME occurrence: exactly one executes', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);

    const [a, b] = await Promise.all([
      tickOn(alpha, [tenantA]),
      tickOn(bravo, [tenantA]),
    ]);

    // Exactly one instance claimed it; the other found nothing to do.
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.succeeded + b.succeeded).toBe(1);

    const runs = TestJobControl.executionsFor(TEST_JOB.BASIC, tenantA);
    expect(runs).toHaveLength(1);
    expect(runs[0].occurrenceKey).toBe(FIXED_KEY);
    expect(runs[0].attempt).toBe(1);

    const row = await readOccurrence(admin, tenantA, TEST_JOB.BASIC, FIXED_KEY);
    expect(row?.state).toBe('succeeded');
    expect(row?.attempt).toBe(1);
    expect(row?.leaseOwner).toBeNull();
    expect(await readFindings(admin, tenantA, TEST_JOB.BASIC)).toHaveLength(1);
  });

  it('1b. FOUR concurrent ticks across two instances still execute the occurrence exactly once', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);

    const results = await Promise.all([
      tickOn(alpha, [tenantA]),
      tickOn(bravo, [tenantA]),
      tickOn(alpha, [tenantA]),
      tickOn(bravo, [tenantA]),
    ]);

    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(TestJobControl.executionsFor(TEST_JOB.BASIC, tenantA)).toHaveLength(
      1,
    );
    // Materialisation raced too, and the primary key absorbed it.
    expect(await readOccurrences(admin, tenantA, TEST_JOB.BASIC)).toHaveLength(
      1,
    );
  });

  it('1c. SKIP LOCKED, proven against an explicitly held row lock (no race required)', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    // Materialise without claiming: a claim batch of zero is not expressible,
    // so claim it, then hand it back to `pending` as if it had never run.
    await tickOn(alpha, [tenantA]);
    await admin.scheduledJobOccurrence.update({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId: tenantA,
          jobType: TEST_JOB.BASIC,
          occurrenceKey: FIXED_KEY,
        },
      },
      data: {
        state: 'pending',
        attempt: 0,
        outcomeCode: null,
        completedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await admin.scheduledJobFinding.deleteMany({
      where: { tenantId: tenantA },
    });
    TestJobControl.reset();

    const holder = new Client({ connectionString: migratorUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      const locked = await holder.query(
        `SELECT occurrence_key FROM platform.job_occurrences
          WHERE tenant_id = $1 AND job_type = $2 AND occurrence_key = $3
          FOR UPDATE`,
        [tenantA, TEST_JOB.BASIC, FIXED_KEY],
      );
      expect(locked.rowCount).toBe(1);

      // The row is eligible in every respect EXCEPT that another session holds
      // its lock. `SKIP LOCKED` must make the claim find nothing at all.
      const blocked = await tickOn(bravo, [tenantA]);
      expect(blocked.claimed).toBe(0);
      expect(
        TestJobControl.executionsFor(TEST_JOB.BASIC, tenantA),
      ).toHaveLength(0);

      await holder.query('ROLLBACK');
    } finally {
      await holder.end();
    }

    // Once the lock is released the very same occurrence is claimable — the
    // work was deferred, never dropped.
    const after = await tickOn(bravo, [tenantA]);
    expect(after.claimed).toBe(1);
    expect(TestJobControl.executionsFor(TEST_JOB.BASIC, tenantA)).toHaveLength(
      1,
    );
  });

  // ── 2. Crash after claim, reclaim after lease expiry ──────────────────────

  it('2. an occurrence abandoned by instance alpha is reclaimed by instance bravo', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.GATED);
    TestJobControl.closeGate();

    // Alpha claims and is held inside its handler — a process that has claimed
    // and is now, from the database's point of view, indistinguishable from one
    // that has died.
    const alphaTick = tickOn(alpha, [tenantA]);
    await TestJobControl.gateEntered;

    const claimed = await readOccurrence(
      admin,
      tenantA,
      TEST_JOB.GATED,
      FIXED_KEY,
    );
    expect(claimed?.state).toBe('running');
    expect(claimed?.attempt).toBe(1);
    const alphaOwner = claimed?.leaseOwner;
    expect(alphaOwner).toBeTruthy();

    // Bravo cannot touch it while the lease is live.
    const refused = await tickOn(bravo, [tenantA]);
    expect(refused.claimed).toBe(0);

    // The lease expires; bravo reclaims and completes it.
    await expireLease(tenantA, TEST_JOB.GATED, FIXED_KEY);
    const bravoTick = await tickOn(bravo, [tenantA]);
    expect(bravoTick.claimed).toBe(1);
    expect(bravoTick.succeeded).toBe(1);

    const reclaimed = await readOccurrence(
      admin,
      tenantA,
      TEST_JOB.GATED,
      FIXED_KEY,
    );
    expect(reclaimed?.state).toBe('succeeded');
    expect(reclaimed?.attempt).toBe(2);
    expect(reclaimed?.leaseOwner).toBeNull();

    TestJobControl.openGate();
    await alphaTick;
  });

  // ── 3. The resumed original worker cannot commit a second occurrence ──────

  it('3. alpha resumes after losing its lease and CANNOT commit a second successful occurrence', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.GATED);
    TestJobControl.closeGate();

    const alphaTick = tickOn(alpha, [tenantA]);
    await TestJobControl.gateEntered;

    // Bravo takes it over while alpha is still inside its handler.
    await expireLease(tenantA, TEST_JOB.GATED, FIXED_KEY);
    await tickOn(bravo, [tenantA]);

    const afterBravo = await readOccurrence(
      admin,
      tenantA,
      TEST_JOB.GATED,
      FIXED_KEY,
    );
    expect(afterBravo?.state).toBe('succeeded');
    expect(afterBravo?.attempt).toBe(2);
    const bravoCompletedAt = afterBravo?.completedAt;
    const findingsAfterBravo = await readFindings(
      admin,
      tenantA,
      TEST_JOB.GATED,
    );
    expect(findingsAfterBravo).toHaveLength(1);

    // Alpha now finishes its handler and tries to settle attempt 1.
    TestJobControl.openGate();
    const alphaResult = await alphaTick;

    // It is told, in the durable state itself, that it lost.
    expect(alphaResult.leaseLost).toBe(1);
    expect(alphaResult.succeeded).toBe(0);

    const final = await readOccurrence(
      admin,
      tenantA,
      TEST_JOB.GATED,
      FIXED_KEY,
    );
    // Bravo's settle stands, untouched — alpha overwrote nothing.
    expect(final?.state).toBe('succeeded');
    expect(final?.attempt).toBe(2);
    expect(final?.completedAt?.toISOString()).toBe(
      bravoCompletedAt?.toISOString(),
    );

    // And alpha's DOMAIN EFFECT never happened: still exactly one finding, and
    // it is bravo's row, not a second one written by alpha.
    const finalFindings = await readFindings(admin, tenantA, TEST_JOB.GATED);
    expect(finalFindings).toHaveLength(1);
    expect(finalFindings[0].id).toBe(findingsAfterBravo[0].id);

    // Exactly one occurrence row exists for the identity.
    expect(await readOccurrences(admin, tenantA, TEST_JOB.GATED)).toHaveLength(
      1,
    );
    // Both instances really did run the handler — the single finding is
    // idempotence under a lost lease, not a skipped execution.
    expect(TestJobControl.executionsFor(TEST_JOB.GATED, tenantA)).toHaveLength(
      2,
    );
  });

  // ── 4. Retry after transient failure, across instances ────────────────────

  it('4. a transient failure on alpha is retried by bravo, with no duplicate domain effect', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.FLAKY);
    TestJobControl.failFlakyOnAttempts = new Set([1]);

    await tickOn(alpha, [tenantA]);
    const afterFail = await readOccurrence(
      admin,
      tenantA,
      TEST_JOB.FLAKY,
      FIXED_KEY,
    );
    expect(afterFail?.state).toBe('pending');
    expect(afterFail?.attempt).toBe(1);
    expect(await readFindings(admin, tenantA, TEST_JOB.FLAKY)).toHaveLength(0);

    // The backoff elapses (written, not waited for) and the OTHER instance
    // picks the same occurrence identity up.
    await admin.scheduledJobOccurrence.update({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId: tenantA,
          jobType: TEST_JOB.FLAKY,
          occurrenceKey: FIXED_KEY,
        },
      },
      data: { nextAttemptAt: new Date(FIXED_NOW.getTime() - 1000) },
    });
    await tickOn(bravo, [tenantA]);

    const row = await readOccurrence(admin, tenantA, TEST_JOB.FLAKY, FIXED_KEY);
    expect(row?.state).toBe('succeeded');
    expect(row?.attempt).toBe(2);
    expect(await readOccurrences(admin, tenantA, TEST_JOB.FLAKY)).toHaveLength(
      1,
    );
    const findings = await readFindings(admin, tenantA, TEST_JOB.FLAKY);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingCode).toBe(TEST_FINDING_CODE);
  });

  // ── 5. Tenant independence ────────────────────────────────────────────────

  it('5. two tenants execute independently, with no cross-tenant bleed', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    await onlyJob(admin, tenantB, TEST_JOB.BASIC);

    await Promise.all([tickOn(alpha, [tenantA]), tickOn(bravo, [tenantB])]);

    for (const tenantId of [tenantA, tenantB]) {
      const rows = await readOccurrences(admin, tenantId, TEST_JOB.BASIC);
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('succeeded');
      expect(rows[0].tenantId).toBe(tenantId);
      expect(
        TestJobControl.executionsFor(TEST_JOB.BASIC, tenantId),
      ).toHaveLength(1);
      const findings = await readFindings(admin, tenantId, TEST_JOB.BASIC);
      expect(findings).toHaveLength(1);
      expect(findings[0].tenantId).toBe(tenantId);
    }
  });

  it("5b. one tenant's failure does not affect the other tenant's occurrence", async () => {
    await onlyJob(admin, tenantA, TEST_JOB.PERMANENT);
    await onlyJob(admin, tenantB, TEST_JOB.PERMANENT);

    await tickOn(alpha, [tenantA, tenantB]);

    for (const tenantId of [tenantA, tenantB]) {
      const row = await readOccurrence(
        admin,
        tenantId,
        TEST_JOB.PERMANENT,
        FIXED_KEY,
      );
      expect(row?.state).toBe('failed');
      expect(row?.outcomeCode).toBe('fixture_rule_violated');
    }
    // Both ran; neither short-circuited the other.
    expect(
      TestJobControl.executionsFor(TEST_JOB.PERMANENT, tenantA),
    ).toHaveLength(1);
    expect(
      TestJobControl.executionsFor(TEST_JOB.PERMANENT, tenantB),
    ).toHaveLength(1);
  });

  // ── 6. Distinct occurrences ───────────────────────────────────────────────

  it('6. two DIFFERENT occurrences are executed independently, and can be split across instances', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    await admin.scheduledJobSchedule.upsert({
      where: {
        tenantId_jobType: { tenantId: tenantA, jobType: TEST_JOB.BASIC },
      },
      create: {
        tenantId: tenantA,
        jobType: TEST_JOB.BASIC,
        timezone: 'UTC',
        localTimeOfDay: 3 * 60,
        catchUpLimit: 2,
      },
      update: { catchUpLimit: 2, enabled: true },
    });

    // One instance materialises both, claiming only one of them.
    const first = await runnerOf(alpha).runTick({
      now: FIXED_NOW,
      tenantIds: [tenantA],
      claimBatch: 1,
    });
    expect(first.claimed).toBe(1);

    // The other instance takes the remaining one.
    const second = await tickOn(bravo, [tenantA]);
    expect(second.claimed).toBe(1);

    const rows = await readOccurrences(admin, tenantA, TEST_JOB.BASIC);
    expect(rows.map((r) => r.occurrenceKey)).toEqual([
      '2026-09-02T03:00',
      '2026-09-03T03:00',
    ]);
    expect(rows.every((r) => r.state === 'succeeded')).toBe(true);
    expect(rows.every((r) => r.attempt === 1)).toBe(true);
    expect(
      new Set(
        TestJobControl.executionsFor(TEST_JOB.BASIC, tenantA).map(
          (e) => e.occurrenceKey,
        ),
      ).size,
    ).toBe(2);
    expect(TestJobControl.executionsFor(TEST_JOB.BASIC, tenantA)).toHaveLength(
      2,
    );
  });

  // ── 7. Truthful durable state after every race ────────────────────────────

  it('7. after every race in this suite, no row is left running, half-settled, or over-attempted', async () => {
    await onlyJob(admin, tenantA, TEST_JOB.BASIC);
    await Promise.all([
      tickOn(alpha, [tenantA]),
      tickOn(bravo, [tenantA]),
      tickOn(alpha, [tenantA]),
    ]);

    const rows = await admin.scheduledJobOccurrence.findMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    for (const row of rows) {
      expect(['succeeded', 'failed', 'pending']).toContain(row.state);
      if (row.state === 'succeeded' || row.state === 'failed') {
        expect(row.completedAt).not.toBeNull();
        expect(row.leaseOwner).toBeNull();
        expect(row.leaseExpiresAt).toBeNull();
        expect(row.outcomeCode).not.toBeNull();
      }
      expect(row.attempt).toBeLessThanOrEqual(row.maxAttempts);
      expect(row.attempt).toBeGreaterThanOrEqual(0);
    }

    // Findings never outnumber their occurrences: one per (occurrence, code).
    const findings = await admin.scheduledJobFinding.findMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    const keys = findings.map(
      (f) => `${f.tenantId}/${f.jobType}/${f.occurrenceKey}/${f.findingCode}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
