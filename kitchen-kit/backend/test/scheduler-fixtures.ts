import { INestApplication, Injectable, Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  ScheduledJobContext,
  ScheduledJobDefaultSchedule,
  ScheduledJobFindingInput,
  ScheduledJobHandler,
  ScheduledJobHandlerFor,
  ScheduledJobPermanentError,
} from './../src/modules/platform/contract';
import { ScheduledJobRunnerService } from './../src/modules/platform/scheduler/scheduled-job-runner.service';
import { ScheduledJobOccurrenceStore } from './../src/modules/platform/scheduler/scheduled-job-occurrence.store';

/**
 * Shared fixtures for the SCHED-1 e2e suites.
 *
 * ── HOW THESE SUITES PROVE CONCURRENCY WITHOUT TIMING LUCK ────────────────
 * Three mechanisms, no sleeps and no "run it 100 times and hope":
 *
 *   TWO REAL APPLICATION INSTANCES. `bootSchedulerApp()` is called twice
 *   against the same scratch database. Each Nest app has its own
 *   `ScheduledJobRunnerService` with its own `processId`, so the lease owners
 *   are genuinely different processes' worth of identity — this is horizontal
 *   scaling, not two calls on one object.
 *
 *   AN EXPLICIT BARRIER INSIDE THE HANDLER. `TestJobControl.gate` makes a
 *   handler's `detect` block on a promise the TEST resolves. That gives an
 *   exact, reproducible interleaving: instance A is provably inside its
 *   handler while the test expires its lease and lets instance B reclaim.
 *
 *   OBSERVABLE LEASE STATE. Every assertion is on durable rows — `state`,
 *   `attempt`, `lease_owner`, `outcome_code`, and the finding rows — read back
 *   through the migrator client. Nothing asserts on wall-clock elapsed time.
 */

/** Job types used only by the e2e suites. Never registered in production. */
export const TEST_JOB = {
  BASIC: 'test.basic_job',
  FLAKY: 'test.flaky_job',
  PERMANENT: 'test.permanent_failure_job',
  GATED: 'test.gated_job',
} as const;

export const TEST_FINDING_CODE = 'test.finding';

/**
 * Mutable, process-wide control surface for the test handlers. Both app
 * instances in a suite run in the same Node process and therefore share this
 * object, which is exactly what lets a test coordinate an interleaving across
 * two "instances".
 */
export class TestJobControl {
  /** Every (jobType, tenantId, occurrenceKey, attempt) a handler actually ran. */
  static readonly executions: {
    jobType: string;
    tenantId: string;
    occurrenceKey: string;
    attempt: number;
  }[] = [];

  /** Attempt numbers on which `FLAKY` should throw a transient error. */
  static failFlakyOnAttempts = new Set<number>();

  /** When set, `GATED.detect` awaits this before returning. */
  static gate: Promise<void> | null = null;
  /** Resolves `gate`. Set by {@link openGate}. */
  static releaseGate: (() => void) | null = null;
  /** Resolves once `GATED.detect` has been entered — no polling, no sleeping. */
  static gateEntered: Promise<void> | null = null;
  private static markEntered: (() => void) | null = null;

  /** When true, every handler emits one finding so the domain effect is observable. */
  static emitFinding = true;

  static reset(): void {
    this.executions.length = 0;
    this.failFlakyOnAttempts = new Set();
    this.gate = null;
    this.releaseGate = null;
    this.gateEntered = null;
    this.markEntered = null;
    this.emitFinding = true;
  }

  /** Arm the gate. `GATED.detect` will block until {@link openGate} is called. */
  static closeGate(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
    this.gateEntered = new Promise<void>((resolve) => {
      this.markEntered = resolve;
    });
  }

  static openGate(): void {
    this.releaseGate?.();
    this.releaseGate = null;
  }

  /**
   * Called from inside `GATED.detect`. Signals that the handler has been
   * ENTERED (so a test can proceed without polling or sleeping) and returns the
   * gate — ONCE. A later attempt of the same occurrence, or another instance
   * running it, is not blocked, which is what lets a test hold worker A inside
   * its handler while worker B runs the same occurrence to completion.
   */
  static enterGate(): Promise<void> | null {
    this.markEntered?.();
    this.markEntered = null;
    const gate = this.gate;
    this.gate = null;
    return gate;
  }

  static executionsFor(jobType: string, tenantId?: string) {
    return this.executions.filter(
      (e) =>
        e.jobType === jobType &&
        (tenantId === undefined || e.tenantId === tenantId),
    );
  }
}

/**
 * Catch-up horizon 1, so ONE tick materialises exactly ONE occurrence per test
 * job type. Bounded catch-up itself is exercised deliberately, with an explicit
 * `platform.job_schedules` override, rather than as an incidental side effect of
 * every other assertion.
 */
const DEFAULT_SCHEDULE: ScheduledJobDefaultSchedule = {
  timezone: 'UTC',
  localTimeOfDay: 3 * 60,
  catchUpLimit: 1,
};

abstract class BaseTestJob implements ScheduledJobHandler<number> {
  abstract readonly jobType: string;
  readonly defaultSchedule: ScheduledJobDefaultSchedule = DEFAULT_SCHEDULE;
  readonly maxAttempts: number = 3;

  detect(context: ScheduledJobContext): Promise<number> {
    TestJobControl.executions.push({
      jobType: context.jobType,
      tenantId: context.tenantId,
      occurrenceKey: context.occurrenceKey,
      attempt: context.attempt,
    });
    return Promise.resolve(context.attempt);
  }

  findings(): readonly ScheduledJobFindingInput[] {
    if (!TestJobControl.emitFinding) return [];
    return [
      {
        severity: 'warning',
        findingCode: TEST_FINDING_CODE,
        // Deliberately carries the attempt, so a duplicated domain effect would
        // be visible as a CHANGED row rather than only as a second row.
        detail: { note: 'fixture' },
      },
    ];
  }
}

@ScheduledJobHandlerFor(TEST_JOB.BASIC)
@Injectable()
export class BasicTestJob extends BaseTestJob {
  readonly jobType = TEST_JOB.BASIC;
}

@ScheduledJobHandlerFor(TEST_JOB.FLAKY)
@Injectable()
export class FlakyTestJob extends BaseTestJob {
  readonly jobType = TEST_JOB.FLAKY;

  async detect(context: ScheduledJobContext): Promise<number> {
    const attempt = await super.detect(context);
    if (TestJobControl.failFlakyOnAttempts.has(context.attempt)) {
      throw new Error('simulated transient failure');
    }
    return attempt;
  }
}

@ScheduledJobHandlerFor(TEST_JOB.PERMANENT)
@Injectable()
export class PermanentFailureTestJob extends BaseTestJob {
  readonly jobType = TEST_JOB.PERMANENT;

  async detect(context: ScheduledJobContext): Promise<number> {
    await super.detect(context);
    throw new ScheduledJobPermanentError(
      'fixture_rule_violated',
      'a business rule no retry can satisfy',
    );
  }
}

@ScheduledJobHandlerFor(TEST_JOB.GATED)
@Injectable()
export class GatedTestJob extends BaseTestJob {
  readonly jobType = TEST_JOB.GATED;

  async detect(context: ScheduledJobContext): Promise<number> {
    const attempt = await super.detect(context);
    const gate = TestJobControl.enterGate();
    if (gate) await gate;
    return attempt;
  }
}

export const TEST_JOB_PROVIDERS: Provider[] = [
  BasicTestJob,
  FlakyTestJob,
  PermanentFailureTestJob,
  GatedTestJob,
];

/**
 * Boot ONE application instance with the test job handlers registered. Call it
 * twice in a suite to get two genuinely independent instances sharing one
 * database — the multi-instance configuration the substrate is designed for.
 */
export async function bootSchedulerApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
    providers: TEST_JOB_PROVIDERS,
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  await app.init();
  return app;
}

export const runnerOf = (app: INestApplication): ScheduledJobRunnerService =>
  app.get(ScheduledJobRunnerService);

export const storeOf = (app: INestApplication): ScheduledJobOccurrenceStore =>
  app.get(ScheduledJobOccurrenceStore);

/** Create a minimal active tenant. Scheduler occurrences need nothing more. */
export async function createSchedulerTenant(
  admin: PrismaClient,
  label: string,
): Promise<string> {
  const id = newId();
  await admin.tenant.create({
    data: {
      id,
      slug: `sched-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      legalName: 'Scheduler fixture',
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    },
  });
  return id;
}

/** Read one occurrence row as the owner role, for truthful state assertions. */
export function readOccurrence(
  admin: PrismaClient,
  tenantId: string,
  jobType: string,
  occurrenceKey: string,
) {
  return admin.scheduledJobOccurrence.findUnique({
    where: {
      tenantId_jobType_occurrenceKey: { tenantId, jobType, occurrenceKey },
    },
  });
}

export function readOccurrences(
  admin: PrismaClient,
  tenantId: string,
  jobType?: string,
) {
  return admin.scheduledJobOccurrence.findMany({
    where: { tenantId, ...(jobType ? { jobType } : {}) },
    orderBy: [{ jobType: 'asc' }, { occurrenceKey: 'asc' }],
  });
}

export function readFindings(
  admin: PrismaClient,
  tenantId: string,
  jobType?: string,
) {
  return admin.scheduledJobFinding.findMany({
    where: { tenantId, ...(jobType ? { jobType } : {}) },
    orderBy: [{ jobType: 'asc' }, { occurrenceKey: 'asc' }],
  });
}

/** Delete every scheduler row for a tenant, so suites do not leak into each other. */
export async function clearScheduler(
  admin: PrismaClient,
  tenantIds: readonly string[],
): Promise<void> {
  for (const tenantId of tenantIds) {
    await admin.scheduledJobFinding.deleteMany({ where: { tenantId } });
    await admin.scheduledJobOccurrence.deleteMany({ where: { tenantId } });
    await admin.scheduledJobSchedule.deleteMany({ where: { tenantId } });
  }
}

/**
 * Restrict a tenant to ONE job type by writing a disabled durable schedule for
 * every other registered type. Uses the real `enabled` flag rather than a test
 * hook, so a suite that narrows its scope is exercising production behaviour.
 */
export async function onlyJob(
  admin: PrismaClient,
  tenantId: string,
  keep: string,
): Promise<void> {
  const all = [
    ...Object.values(TEST_JOB),
    'inventory.daily_reconciliation',
  ] as const;
  for (const jobType of all) {
    if (jobType === keep) continue;
    await admin.scheduledJobSchedule.upsert({
      where: { tenantId_jobType: { tenantId, jobType } },
      create: {
        tenantId,
        jobType,
        enabled: false,
        timezone: 'UTC',
        localTimeOfDay: 3 * 60,
      },
      update: { enabled: false },
    });
  }
}

/** A fixed instant well past 03:00 UTC, so the day's default occurrence is due. */
export const FIXED_NOW = new Date('2026-09-03T12:00:00.000Z');
/** The occurrence key `FIXED_NOW` produces for the default 03:00 UTC schedule. */
export const FIXED_KEY = '2026-09-03T03:00';
