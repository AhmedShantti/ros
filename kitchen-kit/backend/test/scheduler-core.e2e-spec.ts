import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaClient } from './../src/generated/prisma/client';
import { MetricsService } from './../src/common/observability/metrics/metrics.service';
import { PrismaService } from './../src/prisma/prisma.service';
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
  readFindings,
  readOccurrence,
  readOccurrences,
  runnerOf,
} from './scheduler-fixtures';

/**
 * SCHED-1 — the durable scheduler substrate, end to end against real
 * PostgreSQL.
 *
 * This suite proves the SINGLE-worker properties: durable occurrence identity,
 * bounded catch-up, retry and terminal failure, timezone/DST resolution, and
 * that a duplicate tick is a no-op. The multi-instance races live in
 * `scheduler-concurrency.e2e-spec.ts`; the tenant boundary lives in
 * `scheduler-rls.e2e-spec.ts`.
 *
 * Every tick is driven with an EXPLICIT instant. Nothing here waits for a
 * timer, and the heartbeat is disabled (`SCHEDULER_ENABLED` unset in tests), so
 * no background tick can race an assertion.
 */
describe('Scheduler core (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    app = await bootSchedulerApp();
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    tenantId = await createSchedulerTenant(admin, 'core');
  }, 90_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    TestJobControl.reset();
    await clearScheduler(admin, [tenantId]);
  });

  const tick = (over?: Parameters<ReturnType<typeof runnerOf>['runTick']>[0]) =>
    runnerOf(app).runTick({
      now: FIXED_NOW,
      tenantIds: [tenantId],
      claimBatch: 50,
      ...over,
    });

  // ── A. Durable occurrence identity ────────────────────────────────────────

  it('A1. materialises one durable occurrence per job type per local day, and executes it', async () => {
    const result = await tick();

    expect(result.claimed).toBeGreaterThan(0);
    // Every claimed occurrence reached exactly one outcome — nothing was
    // claimed and then dropped on the floor.
    expect(
      result.succeeded + result.failed + result.retried + result.leaseLost,
    ).toBe(result.claimed);
    expect(result.leaseLost).toBe(0);

    const basic = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.BASIC,
      FIXED_KEY,
    );
    expect(basic).not.toBeNull();
    expect(basic?.state).toBe('succeeded');
    expect(basic?.attempt).toBe(1);
    expect(basic?.outcomeCode).toBe('ok');
    expect(basic?.completedAt).not.toBeNull();
    // The lease is RELEASED on settle — a succeeded row holding a lease would
    // be indistinguishable from live work to the reclaim scan.
    expect(basic?.leaseOwner).toBeNull();
    expect(basic?.leaseExpiresAt).toBeNull();
    // `scheduled_for` is the UTC instant the local 03:00 slot resolves to.
    expect(basic?.scheduledFor.toISOString()).toBe('2026-09-03T03:00:00.000Z');
  });

  it('A2. the occurrence key IS the local wall-clock slot, and the DB primary key enforces it', async () => {
    await tick();
    // Inserting the same identity again is refused by PostgreSQL, not by the app.
    await expect(
      admin.scheduledJobOccurrence.create({
        data: {
          tenantId,
          jobType: TEST_JOB.BASIC,
          occurrenceKey: FIXED_KEY,
          scheduledFor: new Date('2026-09-03T03:00:00.000Z'),
          maxAttempts: 3,
          nextAttemptAt: new Date('2026-09-03T03:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
  });

  it('A3. a DUPLICATE tick at the same instant creates nothing and executes nothing further', async () => {
    const first = await tick();
    const before = await readOccurrences(admin, tenantId);
    const executionsAfterFirst = TestJobControl.executions.length;

    const second = await tick();

    expect(second.materialized).toBe(0);
    expect(second.claimed).toBe(0);
    expect(TestJobControl.executions.length).toBe(executionsAfterFirst);

    const after = await readOccurrences(admin, tenantId);
    expect(after).toHaveLength(before.length);
    expect(
      after.map(
        (o) => `${o.jobType}/${o.occurrenceKey}/${o.attempt}/${o.state}`,
      ),
    ).toEqual(
      before.map(
        (o) => `${o.jobType}/${o.occurrenceKey}/${o.attempt}/${o.state}`,
      ),
    );
    expect(first.materialized).toBeGreaterThan(0);
  });

  it('A4. two DIFFERENT scheduled occurrences both execute, independently', async () => {
    // Day 1.
    await tick({ now: new Date('2026-09-03T12:00:00Z') });
    // Day 2 — a later tick materialises the next day's slot, not a second copy
    // of the first.
    await tick({ now: new Date('2026-09-04T12:00:00Z') });

    const keys = (await readOccurrences(admin, tenantId, TEST_JOB.BASIC)).map(
      (o) => o.occurrenceKey,
    );
    expect(keys).toContain('2026-09-03T03:00');
    expect(keys).toContain('2026-09-04T03:00');

    const runs = TestJobControl.executionsFor(TEST_JOB.BASIC, tenantId);
    expect(new Set(runs.map((r) => r.occurrenceKey))).toEqual(
      new Set(['2026-09-03T03:00', '2026-09-04T03:00']),
    );
    expect(runs).toHaveLength(2);
  });

  it('A5. a succeeded occurrence is never re-executed by a later tick', async () => {
    await tick();
    const executions = TestJobControl.executionsFor(TEST_JOB.BASIC).length;
    for (let i = 0; i < 3; i += 1) await tick();
    expect(TestJobControl.executionsFor(TEST_JOB.BASIC)).toHaveLength(
      executions,
    );
  });

  // ── B. Bounded catch-up (backpressure) ────────────────────────────────────

  it('B1. a week of downtime materialises the CATCH-UP HORIZON, not the week', async () => {
    await admin.scheduledJobSchedule.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        timezone: 'UTC',
        localTimeOfDay: 3 * 60,
        catchUpLimit: 3,
      },
    });
    await tick({ now: new Date('2026-09-10T12:00:00Z') });
    const keys = (await readOccurrences(admin, tenantId, TEST_JOB.BASIC)).map(
      (o) => o.occurrenceKey,
    );
    expect(keys).toEqual([
      '2026-09-08T03:00',
      '2026-09-09T03:00',
      '2026-09-10T03:00',
    ]);
  });

  it('B2. the horizon is DURABLE, per-tenant configuration — not a hidden constant', async () => {
    await admin.scheduledJobSchedule.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        timezone: 'UTC',
        localTimeOfDay: 3 * 60,
        catchUpLimit: 1,
      },
    });
    await tick({ now: new Date('2026-09-10T12:00:00Z') });
    const keys = (await readOccurrences(admin, tenantId, TEST_JOB.BASIC)).map(
      (o) => o.occurrenceKey,
    );
    expect(keys).toEqual(['2026-09-10T03:00']);
  });

  it('B3. a bounded claim batch leaves the remainder PENDING, not lost', async () => {
    const result = await tick({
      now: new Date('2026-09-10T12:00:00Z'),
      claimBatch: 1,
    });
    expect(result.claimed).toBe(1);

    const pending = await admin.scheduledJobOccurrence.findMany({
      where: { tenantId, state: 'pending' },
    });
    expect(pending.length).toBeGreaterThan(0);

    // A later tick picks up exactly what was left, with no duplication.
    await tick({ now: new Date('2026-09-10T12:00:00Z'), claimBatch: 50 });
    const stillPending = await admin.scheduledJobOccurrence.count({
      where: { tenantId, state: 'pending' },
    });
    expect(stillPending).toBe(0);
  });

  // ── C. Schedule resolution ────────────────────────────────────────────────

  it('C1. a durable schedule row OVERRIDES the handler default', async () => {
    await admin.scheduledJobSchedule.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        timezone: 'Africa/Cairo',
        localTimeOfDay: 5 * 60,
        catchUpLimit: 1,
      },
    });
    await tick({ now: new Date('2026-09-03T12:00:00Z') });
    const basic = await readOccurrences(admin, tenantId, TEST_JOB.BASIC);
    expect(basic).toHaveLength(1);
    expect(basic[0].occurrenceKey).toBe('2026-09-03T05:00');
    // Cairo is UTC+3 in September, so local 05:00 is 02:00Z.
    expect(basic[0].scheduledFor.toISOString()).toBe(
      '2026-09-03T02:00:00.000Z',
    );
  });

  it('C2. disabling a schedule stops materialisation for that job type only', async () => {
    await admin.scheduledJobSchedule.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        enabled: false,
        timezone: 'UTC',
        localTimeOfDay: 3 * 60,
      },
    });
    await tick();
    expect(await readOccurrences(admin, tenantId, TEST_JOB.BASIC)).toHaveLength(
      0,
    );
    expect(
      (await readOccurrences(admin, tenantId, TEST_JOB.PERMANENT)).length,
    ).toBeGreaterThan(0);
  });

  it('C3. a tenant with NO schedule row is still scheduled, from the durable code default', async () => {
    expect(
      await admin.scheduledJobSchedule.count({ where: { tenantId } }),
    ).toBe(0);
    await tick();
    expect(
      (await readOccurrences(admin, tenantId, TEST_JOB.BASIC)).length,
    ).toBe(1);
  });

  // ── D. Timezone / DST ─────────────────────────────────────────────────────

  it('D1. a REPEATED local hour (DST fall-back) produces ONE occurrence, at the earlier instant', async () => {
    await admin.scheduledJobSchedule.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        timezone: 'Europe/London',
        localTimeOfDay: 90, // 01:30 local — happens twice on 2026-10-25.
        catchUpLimit: 1,
      },
    });
    // Tick twice, from instants either side of the repeated hour.
    await tick({ now: new Date('2026-10-25T01:00:00Z') });
    await tick({ now: new Date('2026-10-25T12:00:00Z') });

    const rows = await readOccurrences(admin, tenantId, TEST_JOB.BASIC);
    const onTheDay = rows.filter((r) =>
      r.occurrenceKey.startsWith('2026-10-25'),
    );
    expect(onTheDay).toHaveLength(1);
    expect(onTheDay[0].occurrenceKey).toBe('2026-10-25T01:30');
    expect(onTheDay[0].scheduledFor.toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(
      TestJobControl.executionsFor(TEST_JOB.BASIC, tenantId).filter((e) =>
        e.occurrenceKey.startsWith('2026-10-25'),
      ),
    ).toHaveLength(1);
  });

  it('D2. a SKIPPED local hour (DST spring-forward) is NOT skipped — it runs at the transition instant', async () => {
    await admin.scheduledJobSchedule.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        timezone: 'Europe/London',
        localTimeOfDay: 90, // 01:30 local — never happens on 2026-03-29.
        catchUpLimit: 1,
      },
    });
    await tick({ now: new Date('2026-03-29T12:00:00Z') });

    const rows = await readOccurrences(admin, tenantId, TEST_JOB.BASIC);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceKey).toBe('2026-03-29T01:30');
    expect(rows[0].scheduledFor.toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(rows[0].state).toBe('succeeded');
  });

  it('D3. the server timezone never participates — the same tick under two process zones is identical', async () => {
    const original = process.env.TZ;
    const snapshot = async () => {
      await clearScheduler(admin, [tenantId]);
      await tick({ now: new Date('2026-09-03T12:00:00Z') });
      return (await readOccurrences(admin, tenantId)).map(
        (o) =>
          `${o.jobType}/${o.occurrenceKey}/${o.scheduledFor.toISOString()}`,
      );
    };
    try {
      process.env.TZ = 'Pacific/Kiritimati';
      const a = await snapshot();
      process.env.TZ = 'Pacific/Niue';
      const b = await snapshot();
      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  // ── E. Retry and terminal failure ─────────────────────────────────────────

  it('E1. a TRANSIENT failure retries the SAME occurrence identity, with backoff', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1]);
    const first = await tick();
    expect(first.retried).toBe(1);

    const afterFail = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.FLAKY,
      FIXED_KEY,
    );
    expect(afterFail?.state).toBe('pending');
    expect(afterFail?.attempt).toBe(1);
    expect(afterFail?.outcomeCode).toBe('handler_error');
    expect(afterFail?.completedAt).toBeNull();
    // Backoff really gates the retry: an immediate tick at the SAME instant
    // claims nothing for this job type.
    expect(afterFail!.nextAttemptAt.getTime()).toBeGreaterThan(
      FIXED_NOW.getTime(),
    );
    const gated = await tick();
    expect(TestJobControl.executionsFor(TEST_JOB.FLAKY, tenantId)).toHaveLength(
      1,
    );
    expect(gated.retried).toBe(0);
  });

  it('E2. after the backoff, the retry succeeds on the SAME row with NO duplicate domain effect', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1]);
    await tick();
    // Simulate the backoff elapsing. Time is data here, never a sleep.
    await admin.scheduledJobOccurrence.update({
      where: {
        tenantId_jobType_occurrenceKey: {
          tenantId,
          jobType: TEST_JOB.FLAKY,
          occurrenceKey: FIXED_KEY,
        },
      },
      data: { nextAttemptAt: new Date('2026-09-03T04:00:00Z') },
    });

    await tick();

    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.FLAKY,
      FIXED_KEY,
    );
    expect(row?.state).toBe('succeeded');
    expect(row?.attempt).toBe(2);
    expect(row?.outcomeCode).toBe('ok');

    // ONE occurrence row for the identity, and ONE finding — the domain effect
    // was not duplicated by the retry.
    expect(await readOccurrences(admin, tenantId, TEST_JOB.FLAKY)).toHaveLength(
      1,
    );
    const findings = await readFindings(admin, tenantId, TEST_JOB.FLAKY);
    expect(findings).toHaveLength(1);
    expect(findings[0].findingCode).toBe(TEST_FINDING_CODE);
    expect(findings[0].occurrenceKey).toBe(FIXED_KEY);

    // And the handler really did run twice — the single finding is idempotence,
    // not a skipped execution.
    expect(TestJobControl.executionsFor(TEST_JOB.FLAKY, tenantId)).toHaveLength(
      2,
    );
  });

  it('E3. attempts are BOUNDED — a permanently transient job ends terminally, not in a retry loop', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1, 2, 3, 4, 5]);
    for (let i = 0; i < 5; i += 1) {
      await tick();
      await admin.scheduledJobOccurrence.updateMany({
        where: { tenantId, jobType: TEST_JOB.FLAKY },
        data: { nextAttemptAt: new Date('2026-09-03T04:00:00Z') },
      });
    }
    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.FLAKY,
      FIXED_KEY,
    );
    expect(row?.state).toBe('failed');
    expect(row?.attempt).toBe(3);
    expect(row?.outcomeCode).toBe('attempts_exhausted');
    expect(row?.completedAt).not.toBeNull();
    // Exactly maxAttempts executions — never more.
    expect(TestJobControl.executionsFor(TEST_JOB.FLAKY, tenantId)).toHaveLength(
      3,
    );
  });

  it('E4. a BUSINESS-RULE failure is terminal on the FIRST attempt — no retry burns attempts on it', async () => {
    await tick();
    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.PERMANENT,
      FIXED_KEY,
    );
    expect(row?.state).toBe('failed');
    expect(row?.attempt).toBe(1);
    expect(row?.outcomeCode).toBe('fixture_rule_violated');
    expect(
      TestJobControl.executionsFor(TEST_JOB.PERMANENT, tenantId),
    ).toHaveLength(1);

    // And a later tick does not resurrect it.
    await tick();
    expect(
      TestJobControl.executionsFor(TEST_JOB.PERMANENT, tenantId),
    ).toHaveLength(1);
  });

  it('E5. a failed attempt commits NO finding — the effect rolls back with the settle', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1]);
    await tick();
    expect(await readFindings(admin, tenantId, TEST_JOB.FLAKY)).toHaveLength(0);
  });

  // ── F. Crash safety ───────────────────────────────────────────────────────

  it('F1. an occurrence abandoned by a dead worker is RECLAIMED once its lease expires', async () => {
    await admin.scheduledJobOccurrence.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        occurrenceKey: '2026-09-01T03:00',
        scheduledFor: new Date('2026-09-01T03:00:00Z'),
        state: 'running',
        attempt: 1,
        maxAttempts: 3,
        nextAttemptAt: new Date('2026-09-01T03:00:00Z'),
        leaseOwner: 'dead-worker:1',
        // Expired RELATIVE TO THE TICK INSTANT below — the tick instant is the
        // only clock this suite consults.
        leaseExpiresAt: new Date('2026-09-01T04:00:00Z'),
        startedAt: new Date('2026-09-01T03:00:00Z'),
      },
    });

    await tick({ now: new Date('2026-09-01T12:00:00Z') });

    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.BASIC,
      '2026-09-01T03:00',
    );
    expect(row?.state).toBe('succeeded');
    // The reclaim took the attempt off the dead owner.
    expect(row?.attempt).toBe(2);
    expect(row?.leaseOwner).toBeNull();
    expect(
      TestJobControl.executionsFor(TEST_JOB.BASIC, tenantId).filter(
        (e) => e.occurrenceKey === '2026-09-01T03:00',
      ),
    ).toHaveLength(1);
  });

  it('F2. an occurrence abandoned with a LIVE lease is NOT stolen', async () => {
    await admin.scheduledJobOccurrence.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        occurrenceKey: '2026-09-01T03:00',
        scheduledFor: new Date('2026-09-01T03:00:00Z'),
        state: 'running',
        attempt: 1,
        maxAttempts: 3,
        nextAttemptAt: new Date('2026-09-01T03:00:00Z'),
        leaseOwner: 'live-worker:1',
        // Still live at the tick instant below.
        leaseExpiresAt: new Date('2026-09-01T23:00:00Z'),
        startedAt: new Date('2026-09-01T03:00:00Z'),
      },
    });

    await tick({ now: new Date('2026-09-01T12:00:00Z') });

    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.BASIC,
      '2026-09-01T03:00',
    );
    expect(row?.state).toBe('running');
    expect(row?.attempt).toBe(1);
    expect(row?.leaseOwner).toBe('live-worker:1');
  });

  it('F3. an occurrence abandoned with every attempt SPENT is reaped as failed, not left running forever', async () => {
    await admin.scheduledJobOccurrence.create({
      data: {
        tenantId,
        jobType: TEST_JOB.BASIC,
        occurrenceKey: '2026-09-01T03:00',
        scheduledFor: new Date('2026-09-01T03:00:00Z'),
        state: 'running',
        attempt: 3,
        maxAttempts: 3,
        nextAttemptAt: new Date('2026-09-01T03:00:00Z'),
        leaseOwner: 'dead-worker:3',
        leaseExpiresAt: new Date('2026-09-01T04:00:00Z'),
        startedAt: new Date('2026-09-01T03:00:00Z'),
      },
    });

    await tick({ now: new Date('2026-09-01T12:00:00Z') });

    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.BASIC,
      '2026-09-01T03:00',
    );
    expect(row?.state).toBe('failed');
    expect(row?.outcomeCode).toBe('lease_exhausted');
    expect(row?.completedAt).not.toBeNull();
    expect(row?.leaseOwner).toBeNull();
  });

  // ── G. Truthfulness of durable state ──────────────────────────────────────

  it('G1. every terminal row records when it terminated, and holds no lease', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1, 2, 3]);
    for (let i = 0; i < 4; i += 1) {
      await tick();
      await admin.scheduledJobOccurrence.updateMany({
        where: { tenantId, state: 'pending' },
        data: { nextAttemptAt: new Date('2026-09-03T04:00:00Z') },
      });
    }
    const rows = await readOccurrences(admin, tenantId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['succeeded', 'failed']).toContain(row.state);
      expect(row.completedAt).not.toBeNull();
      expect(row.leaseOwner).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.attempt).toBeGreaterThan(0);
      expect(row.attempt).toBeLessThanOrEqual(row.maxAttempts);
      expect(row.outcomeCode).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('G2. an outcome_code is NEVER an exception message', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1]);
    await tick();
    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.FLAKY,
      FIXED_KEY,
    );
    expect(row?.outcomeCode).toBe('handler_error');
    expect(row?.outcomeCode).not.toContain('simulated');
  });

  // ── H. Observability (G1-3 conventions) ───────────────────────────────────

  it('H1. emits the occurrence lifecycle through the SAME MetricsService the HTTP path uses', async () => {
    await tick();
    const text = await app.get(MetricsService).metricsText();

    expect(text).toContain('scheduled_job_occurrences_total{');
    expect(text).toContain(`job_type="${TEST_JOB.BASIC}",phase="claimed"`);
    expect(text).toContain(`job_type="${TEST_JOB.BASIC}",phase="succeeded"`);
    expect(text).toContain(`job_type="${TEST_JOB.PERMANENT}",phase="failed"`);
    expect(text).toContain('scheduled_job_duration_seconds_count{');
    expect(text).toContain('scheduled_job_lag_seconds_count{');
    expect(text).toContain('scheduled_job_findings_total{');
  });

  it('H2. NO scheduler metric label is a tenant id, an occurrence key, or an exception message', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1]);
    await tick();
    const text = await app.get(MetricsService).metricsText();
    const lines = text
      .split('\n')
      .filter((l) => l.startsWith('scheduled_job_'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(tenantId);
      expect(line).not.toContain(FIXED_KEY);
      expect(line).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      expect(line).not.toContain('simulated transient failure');
    }
  });

  it('H3. the metric series count is bounded by (job types x phases), not by occurrences', async () => {
    // Ten days of occurrences for every registered job type.
    for (let day = 1; day <= 10; day += 1) {
      await tick({
        now: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00Z`),
      });
    }
    const text = await app.get(MetricsService).metricsText();
    const series = text
      .split('\n')
      .filter((l) => l.startsWith('scheduled_job_occurrences_total{'));
    // 8 phases; a handful of job types. Ten days of occurrences added ZERO
    // series — which is the property that makes this metric safe to keep
    // forever.
    expect(series.length).toBeLessThanOrEqual(8 * 12);
  });

  /**
   * Capture the structured log lines a block writes to stdout, then restore the
   * real writer. Nothing about the logger is mocked — this reads the exact JSON
   * envelopes `StructuredLoggerService` really emits, so the assertions are on
   * production output rather than on a stand-in.
   */
  type StdoutWrite = typeof process.stdout.write;

  async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
    const chunks: string[] = [];
    const stream = process.stdout;
    // `write` is overloaded, so `bind` widens to `any`; the assertion narrows it
    // back to the exact signature being replaced and restored.
    const original = stream.write.bind(stream) as StdoutWrite;
    const capture = ((
      chunk: string | Uint8Array,
      ...rest: never[]
    ): boolean => {
      if (typeof chunk === 'string') chunks.push(chunk);
      return original(chunk, ...rest);
    }) as StdoutWrite;
    stream.write = capture;
    try {
      await fn();
    } finally {
      stream.write = original;
    }
    return chunks.join('');
  }

  interface LogEnvelopeView {
    event?: string;
    tenantId?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    jobType?: string;
    occurrenceKey?: string;
  }

  const schedulerEnvelopes = (captured: string): LogEnvelopeView[] =>
    captured
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LogEnvelopeView];
        } catch {
          return [];
        }
      })
      .filter((e) => (e.event ?? '').startsWith('scheduler.occurrence.'));

  it('H4. each occurrence runs in its OWN observability context, with an honest null causation', async () => {
    const captured = await captureStdout(() => tick());
    const envelopes = schedulerEnvelopes(captured);

    expect(envelopes.length).toBeGreaterThan(0);
    const correlationIds = new Set<string>();
    for (const envelope of envelopes) {
      expect(envelope.tenantId).toBe(tenantId);
      expect(typeof envelope.correlationId).toBe('string');
      // A scheduled occurrence is a ROOT cause: there is no prior request or
      // event that made it happen, and inventing one would be a false causal
      // link (the same rule `resolveCausationId` applies to a root request).
      expect(envelope.causationId).toBeNull();
      expect(typeof envelope.jobType).toBe('string');
      expect(typeof envelope.occurrenceKey).toBe('string');
      correlationIds.add(String(envelope.correlationId));
    }
    // Distinct occurrences are distinct causal chains, not one shared id.
    expect(correlationIds.size).toBeGreaterThan(1);
  });

  it('H5. an exception message reaches the LOG but never the durable outcome code', async () => {
    TestJobControl.failFlakyOnAttempts = new Set([1]);
    const captured = await captureStdout(() => tick());

    expect(captured).toContain('scheduler.occurrence.retry');
    // The message IS useful — it just belongs where the redaction layer governs
    // it, not in a queryable column or a metric label.
    expect(captured).toContain('simulated transient failure');

    const row = await readOccurrence(
      admin,
      tenantId,
      TEST_JOB.FLAKY,
      FIXED_KEY,
    );
    expect(row?.outcomeCode).toBe('handler_error');
  });

  it('G3. the scheduler reads and writes as the RLS-constrained app role, never as an owner', async () => {
    // Proven by construction: the runner only ever touches the database through
    // PrismaService, which connects as ros_app. Assert that role directly.
    const [{ current_user: role, rolbypassrls: bypass }] =
      await prisma.$queryRawUnsafe<
        { current_user: string; rolbypassrls: boolean }[]
      >(
        'SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)',
      );
    expect(role).toBe('ros_app');
    expect(bypass).toBe(false);
  });
});
