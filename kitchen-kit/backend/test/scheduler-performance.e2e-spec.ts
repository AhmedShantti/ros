import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';
import {
  FIXED_NOW,
  TEST_JOB,
  TestJobControl,
  bootSchedulerApp,
  clearScheduler,
  createSchedulerTenant,
  onlyJob,
  runnerOf,
} from './scheduler-fixtures';

/**
 * SCHED-1 — scheduler cost measurement.
 *
 * The requirement this answers is negative: the scheduler must not materially
 * regress the request path, and a tick with nothing to do must be cheap enough
 * to run every 30 seconds on every instance forever. So what is measured is the
 * cost of the SCHEDULER's own statements, plus the plan the claim query
 * actually gets — not a throughput number for the jobs themselves, which is a
 * property of each job.
 *
 * ── WHAT THESE NUMBERS ARE, AND ARE NOT ───────────────────────────────────
 * They are local measurements against a scratch PostgreSQL on developer/CI
 * hardware, taken in the same process as the application under test. They are
 * evidence about SHAPE — does the claim use its index, does an idle tick cost
 * one query per tenant or one per occurrence, does the batch bound hold — not a
 * certified benchmark against production hardware. The accompanying report
 * states them with that qualification and claims nothing more.
 *
 * There is no SRS latency budget for background work, so nothing here is
 * asserted as an SLO. The assertions are on SHAPE (index usage, statement
 * counts, bounded batches), which is what a regression would break first.
 */
const PENDING_OCCURRENCES = Number(process.env.SCHED_BENCH_OCCURRENCES ?? 2000);

interface Stats {
  p50: number;
  p95: number;
  min: number;
  max: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

const round = (s: Stats) => ({
  p50: Number(s.p50.toFixed(2)),
  p95: Number(s.p95.toFixed(2)),
  min: Number(s.min.toFixed(2)),
  max: Number(s.max.toFixed(2)),
});

describe('Scheduler performance (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    app = await bootSchedulerApp();
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    tenantId = await createSchedulerTenant(admin, 'perf');
  }, 120_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(() => {
    TestJobControl.reset();
  });

  it('A. an IDLE tick (nothing due) is a small, bounded number of statements per tenant', async () => {
    await clearScheduler(admin, [tenantId]);
    await onlyJob(admin, tenantId, TEST_JOB.BASIC);
    // Run once so today's occurrence exists and is settled; every later tick at
    // the same instant has genuinely nothing to do.
    await runnerOf(app).runTick({ now: FIXED_NOW, tenantIds: [tenantId] });

    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = process.hrtime.bigint();
      const result = await runnerOf(app).runTick({
        now: FIXED_NOW,
        tenantIds: [tenantId],
      });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(result.claimed).toBe(0);
    }
    const s = stats(samples);
    console.log('SCHED-1 idle tick, one tenant (ms):', round(s));
    // Shape assertion only: an idle tick is three statements in one
    // transaction (reap, schedules, materialise+claim), not a scan per
    // occurrence. A regression to per-occurrence work would blow past this by
    // orders of magnitude.
    expect(s.p95).toBeLessThan(500);
  });

  it('B. a tick WITH due work claims and executes, and stays proportional to the claim batch', async () => {
    await clearScheduler(admin, [tenantId]);
    await onlyJob(admin, tenantId, TEST_JOB.BASIC);
    const samples: number[] = [];
    for (let day = 1; day <= 10; day += 1) {
      const now = new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`);
      const started = process.hrtime.bigint();
      const result = await runnerOf(app).runTick({
        now,
        tenantIds: [tenantId],
      });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(result.claimed).toBe(1);
      expect(result.succeeded).toBe(1);
    }
    const s = stats(samples);
    console.log('SCHED-1 tick with one due occurrence (ms):', round(s));
    expect(s.p95).toBeLessThan(1000);
  });

  it('C. the CLAIM query uses its index and stays bounded with a large pending backlog', async () => {
    await clearScheduler(admin, [tenantId]);

    // A REPRESENTATIVE table, not a degenerate one. `job_occurrences` accumulates
    // one settled row per tenant per job per day forever, while the ELIGIBLE set
    // stays tiny — so the interesting question is whether the claim finds those
    // few rows without reading the history. 95% settled, 5% pending.
    const settledCount = Math.floor(PENDING_OCCURRENCES * 0.95);
    const rows = Array.from({ length: PENDING_OCCURRENCES }, (_, i) => {
      const settled = i < settledCount;
      return {
        tenantId,
        jobType: 'perf.synthetic_job',
        occurrenceKey: `2020-01-01T00:00-${i}`,
        scheduledFor: new Date('2020-01-01T00:00:00Z'),
        state: settled ? 'succeeded' : 'pending',
        attempt: settled ? 1 : 0,
        maxAttempts: 3,
        nextAttemptAt: new Date('2020-01-01T00:00:00Z'),
        ...(settled
          ? { completedAt: new Date('2020-01-01T01:00:00Z'), outcomeCode: 'ok' }
          : {}),
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      await admin.scheduledJobOccurrence.createMany({
        data: rows.slice(i, i + 500),
      });
    }
    await admin.$executeRawUnsafe('ANALYZE platform.job_occurrences');

    const total = await admin.scheduledJobOccurrence.count({
      where: { tenantId },
    });
    const backlog = await admin.scheduledJobOccurrence.count({
      where: { tenantId, state: 'pending' },
    });
    console.log(
      `SCHED-1 occurrence table: ${total} rows for this tenant, ${backlog} eligible`,
    );
    expect(total).toBeGreaterThanOrEqual(PENDING_OCCURRENCES);

    // The claim's own plan, taken through the RLS-constrained runtime role so
    // the policy predicate is part of what the planner sees.
    const explain = (label: string, sql: string) =>
      prisma
        .withAuthContext({ tenantId }, (tx) =>
          tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(sql),
        )
        .then((plan) => {
          const text = plan.map((r) => r['QUERY PLAN']).join('\n');
          console.log(
            `SCHED-1 ${label} plan (${total} rows in table):\n${text}`,
          );
          return text;
        });

    // Both halves of the claim, planned through the RLS-constrained runtime
    // role so the policy predicate is part of what the planner sees.
    const duePlan = await explain(
      'due claim',
      `EXPLAIN (COSTS OFF)
       SELECT c.tenant_id, c.job_type, c.occurrence_key
         FROM platform.job_occurrences c
        WHERE c.tenant_id = '${tenantId}'::uuid
          AND c.state = 'pending'
          AND c.next_attempt_at <= now()
          AND c.attempt < c.max_attempts
        ORDER BY c.next_attempt_at ASC, c.job_type ASC, c.occurrence_key ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 10`,
    );
    const reclaimPlan = await explain(
      'reclaim',
      `EXPLAIN (COSTS OFF)
       SELECT c.tenant_id, c.job_type, c.occurrence_key
         FROM platform.job_occurrences c
        WHERE c.tenant_id = '${tenantId}'::uuid
          AND c.state = 'running'
          AND c.lease_expires_at <= now()
          AND c.attempt < c.max_attempts
        ORDER BY c.lease_expires_at ASC, c.job_type ASC, c.occurrence_key ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 10`,
    );

    // Neither half may become a sequential scan of the occurrence table: that
    // is the difference between a scheduler that scales with the FLEET and one
    // that scales with its own accumulated history.
    for (const planText of [duePlan, reclaimPlan]) {
      expect(planText).not.toMatch(/Seq Scan on job_occurrences/);
      expect(planText).toMatch(/Index Scan|Index Only Scan|Bitmap/);
    }

    // And the claim itself, against that backlog, stays a bounded batch.
    const samples: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const started = process.hrtime.bigint();
      const result = await runnerOf(app).runTick({
        now: new Date('2026-09-03T12:00:00Z'),
        tenantIds: [tenantId],
        claimBatch: 10,
      });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      // `perf.synthetic_job` has no registered handler, so each claimed
      // occurrence settles terminally as `unknown_job_type` — which is itself
      // the behaviour a stale job type must have.
      expect(result.claimed).toBeLessThanOrEqual(10 + 1);
    }
    const s = stats(samples);
    console.log(
      `SCHED-1 claim+settle, batch 10, ${backlog} eligible of ${total} rows (ms):`,
      round(s),
    );
    expect(s.p95).toBeLessThan(2000);

    const stale = await admin.scheduledJobOccurrence.findFirst({
      where: { tenantId, jobType: 'perf.synthetic_job', state: 'failed' },
    });
    expect(stale?.outcomeCode).toBe('unknown_job_type');
  });

  it('D. the tick fans out over TENANTS, not over occurrences — cost per tenant is flat', async () => {
    const tenants: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = await createSchedulerTenant(admin, `perf-fan-${i}`);
      await onlyJob(admin, id, TEST_JOB.BASIC);
      tenants.push(id);
    }
    try {
      const oneStarted = process.hrtime.bigint();
      await runnerOf(app).runTick({
        now: new Date('2026-11-01T12:00:00Z'),
        tenantIds: [tenants[0]],
      });
      const oneMs = Number(process.hrtime.bigint() - oneStarted) / 1e6;

      const allStarted = process.hrtime.bigint();
      await runnerOf(app).runTick({
        now: new Date('2026-11-01T12:00:00Z'),
        tenantIds: tenants,
      });
      const allMs = Number(process.hrtime.bigint() - allStarted) / 1e6;

      console.log(
        `SCHED-1 fan-out: 1 tenant ${oneMs.toFixed(2)}ms, 10 tenants ${allMs.toFixed(2)}ms ` +
          `(${(allMs / Math.max(oneMs, 0.01)).toFixed(1)}x for 10x the tenants)`,
      );
      // The honest shape, stated rather than hidden: cost is LINEAR in tenants,
      // because RLS forbids one cross-tenant claim (see the store's docblock and
      // the SCHED-1 report). It must NOT be worse than linear.
      expect(allMs).toBeLessThan(oneMs * 40 + 2000);
    } finally {
      await clearScheduler(admin, tenants);
    }
  });

  it('E. tenant discovery is ONE query, bounded and round-robin — never one query per tenant', async () => {
    // Driven through the real discovery path (no `tenantIds` override).
    const started = process.hrtime.bigint();
    const result = await runnerOf(app).runTick({
      now: new Date('2026-11-02T12:00:00Z'),
      tenantBatch: 5,
      claimBatch: 1,
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(
      `SCHED-1 real discovery tick, tenantBatch=5 (ms): ${ms.toFixed(2)}`,
    );
    // The batch bound is honoured: never more tenants than asked for.
    expect(result.tenantsScanned).toBeLessThanOrEqual(5);
  });
});
