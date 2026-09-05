import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  dueDailySlots,
  instantForLocalSlot,
  parseLocalSlotKey,
} from '../../../common/time/zoned-time';
import { ObservabilityContextService } from '../../../common/observability/context/observability-context';
import { StructuredLoggerService } from '../../../common/observability/logging/structured-logger.service';
import { MetricsService } from '../../../common/observability/metrics/metrics.service';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  ScheduledJobContext,
  ScheduledJobFindingInput,
  ScheduledJobHandler,
  ScheduledJobPermanentError,
} from '../contract/scheduled-job';
import { ScheduledJobFindingWriter } from './scheduled-job-finding.writer';
import {
  SCHEDULED_JOB_OUTCOME,
  SCHEDULED_JOB_PHASE,
  SCHEDULED_JOB_STATE,
  SCHEDULER_LEASE_RENEW_MS,
  retryDelayMs,
} from './scheduled-job.constants';
import {
  ClaimedOccurrence,
  OccurrencePlan,
  ScheduledJobLeaseLostError,
  ScheduledJobOccurrenceStore,
} from './scheduled-job-occurrence.store';
import { ScheduledJobRegistry } from './scheduled-job.registry';

/** What one tick did, for tests, telemetry and the operator log. */
export interface SchedulerTickResult {
  readonly tenantsScanned: number;
  readonly materialized: number;
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly retried: number;
  readonly leaseLost: number;
  readonly reaped: number;
}

const EMPTY_TICK: SchedulerTickResult = {
  tenantsScanned: 0,
  materialized: 0,
  claimed: 0,
  succeeded: 0,
  failed: 0,
  retried: 0,
  leaseLost: 0,
  reaped: 0,
};

interface ResolvedSchedule {
  readonly jobType: string;
  readonly timezone: string;
  readonly localTimeOfDay: number;
  readonly catchUpLimit: number;
  readonly maxAttempts: number;
  readonly enabled: boolean;
}

/**
 * The scheduler substrate's execution engine (SCHED-1).
 *
 * ── WHAT A "TICK" IS, AND WHAT IT IS NOT ──────────────────────────────────
 * A tick is a LIVENESS POLL, not the schedule. Nothing about which occurrences
 * exist, which instance runs them, or whether one already ran is decided here:
 * all three are decided by `platform.job_occurrences`' primary key, its claim
 * UPDATE and its lease. A tick that never fires delays work; it cannot
 * duplicate it, lose it, or reorder it. That is the whole reason the timer in
 * `SchedulerHeartbeatService` is allowed to be an ordinary process-local timer:
 * it is not the correctness mechanism, and killing it costs latency only.
 *
 * ── ONE TICK, PER TENANT ──────────────────────────────────────────────────
 *   1. discover tenants (ONE query against `identity.tenants`);
 *   2. for each tenant, in ONE transaction under that tenant's RLS context:
 *      reap exhausted occurrences, materialise everything due (one
 *      set-oriented INSERT), then claim a bounded batch (one set-oriented
 *      UPDATE ... FOR UPDATE SKIP LOCKED);
 *   3. execute each claimed occurrence: `detect` outside the settle
 *      transaction, then `commit` + settle inside one lease-guarded
 *      transaction.
 *
 * Steps 1-2 are three statements per tenant regardless of how many job types or
 * occurrences that tenant has — the fan-out is over TENANTS, never over
 * occurrences. A single cross-tenant claim would be one statement for the whole
 * fleet, and is deliberately NOT done: it requires reading another tenant's
 * rows, `ros_app` has no `BYPASSRLS` (FR-PLT-011, ratified), and this
 * repository has no ratified system-worker authority model to authorise such a
 * read. Inventing one here would be inventing governance. The per-tick tenant
 * batch (`SCHEDULER_TENANT_BATCH`) bounds the cost and round-robins across
 * ticks so no tenant starves.
 */
@Injectable()
export class ScheduledJobRunnerService {
  /** Identifies THIS process for its lifetime; the lease owner prefix. */
  private readonly processId = newId();
  /** Round-robin cursor over the tenant registry, so no tenant starves. */
  private tenantCursor = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ScheduledJobRegistry,
    private readonly store: ScheduledJobOccurrenceStore,
    private readonly findingWriter: ScheduledJobFindingWriter,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
    private readonly observability: ObservabilityContextService,
  ) {}

  /**
   * Run one tick across a bounded batch of tenants.
   *
   * @param now         the instant to schedule against. Injectable so the DST
   *                    and catch-up tests assert on a fixed instant rather than
   *                    on whatever the wall clock happened to be.
   * @param tenantBatch how many tenants this tick may scan.
   * @param claimBatch  how many occurrences this tick may claim per tenant.
   */
  async runTick(options?: {
    now?: Date;
    tenantBatch?: number;
    claimBatch?: number;
    /** Restrict the tick to these tenants. Tests only; production scans all. */
    tenantIds?: readonly string[];
  }): Promise<SchedulerTickResult> {
    if (this.registry.registeredTypes.length === 0) return EMPTY_TICK;

    const now = options?.now ?? new Date();
    const tenantBatch = options?.tenantBatch ?? 100;
    const claimBatch = options?.claimBatch ?? 10;

    const tenantIds =
      options?.tenantIds ?? (await this.nextTenantBatch(tenantBatch));
    let result: SchedulerTickResult = {
      ...EMPTY_TICK,
      tenantsScanned: tenantIds.length,
    };

    for (const tenantId of tenantIds) {
      const perTenant = await this.runTenant(tenantId, now, claimBatch);
      result = {
        tenantsScanned: result.tenantsScanned,
        materialized: result.materialized + perTenant.materialized,
        claimed: result.claimed + perTenant.claimed,
        succeeded: result.succeeded + perTenant.succeeded,
        failed: result.failed + perTenant.failed,
        retried: result.retried + perTenant.retried,
        leaseLost: result.leaseLost + perTenant.leaseLost,
        reaped: result.reaped + perTenant.reaped,
      };
    }
    return result;
  }

  /**
   * The ONE cross-tenant read in the whole substrate, and it is not a new
   * capability: `identity.tenants` has carried no row-level security since
   * migration 5, because a login must resolve a tenant BEFORE any tenant
   * context can exist, and `TenantsService` already reads it the same way. No
   * tenant-scoped table is read here, and nothing about a tenant beyond its id
   * is loaded.
   *
   * The cursor makes the scan round-robin rather than always starting at the
   * same tenant, so with more tenants than one batch can hold, later tenants
   * are reached on a later tick instead of never.
   */
  private async nextTenantBatch(limit: number): Promise<string[]> {
    const rows = await this.prisma.tenant.findMany({
      where: { status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
      skip: this.tenantCursor,
      take: limit,
    });
    if (rows.length < limit) {
      // Reached the end of the registry: start the next tick from the top.
      this.tenantCursor = 0;
    } else {
      this.tenantCursor += limit;
    }
    return rows.map((r) => r.id);
  }

  /** Reap + materialise + claim for one tenant, then execute what was claimed. */
  private async runTenant(
    tenantId: string,
    now: Date,
    claimBatch: number,
  ): Promise<Omit<SchedulerTickResult, 'tenantsScanned'>> {
    const leaseOwner = `${this.processId}:${now.getTime()}`;

    const { materialized, reaped, claimed, plannedTypes } =
      await this.prisma.withAuthContext({ tenantId }, async (tx) => {
        const reapedCount = await this.store.reapExhausted(tx, tenantId, now);
        const schedules = await this.resolveSchedules(tx, tenantId);
        const plans = this.planOccurrences(schedules, now);
        const materializedCount = await this.store.materialize(
          tx,
          tenantId,
          plans,
        );
        const claimedRows = await this.store.claim(
          tx,
          tenantId,
          now,
          leaseOwner,
          claimBatch,
        );
        return {
          materialized: materializedCount,
          reaped: reapedCount,
          claimed: claimedRows,
          plannedTypes: [...new Set(plans.map((p) => p.jobType))],
        };
      });

    if (materialized > 0) {
      // Counted per job type, not per occurrence: the metric's meaning is
      // "this job type produced new work on this tick", which stays stable as
      // catch-up horizons change. `job_type` is registry-bounded (see
      // `ScheduledJobMetricLabels`); no tenant id ever appears here.
      for (const jobType of plannedTypes) {
        this.metrics.recordScheduledJobPhase({
          jobType,
          phase: SCHEDULED_JOB_PHASE.MATERIALIZED,
        });
      }
    }
    for (const occurrence of claimed) {
      this.metrics.recordScheduledJobPhase({
        jobType: occurrence.jobType,
        phase: occurrence.reclaimed
          ? SCHEDULED_JOB_PHASE.RECLAIMED
          : SCHEDULED_JOB_PHASE.CLAIMED,
      });
      this.metrics.recordScheduledJobLag(
        occurrence.jobType,
        (now.getTime() - occurrence.scheduledFor.getTime()) / 1000,
      );
    }

    let succeeded = 0;
    let failed = 0;
    let retried = 0;
    let leaseLost = 0;
    for (const occurrence of claimed) {
      const outcome = await this.execute(tenantId, occurrence, now);
      if (outcome === 'succeeded') succeeded += 1;
      else if (outcome === 'failed') failed += 1;
      else if (outcome === 'retry') retried += 1;
      else leaseLost += 1;
    }

    return {
      materialized,
      claimed: claimed.length,
      succeeded,
      failed,
      retried,
      leaseLost,
      reaped,
    };
  }

  /**
   * The effective schedule for every registered job type, for one tenant:
   * the durable `platform.job_schedules` override when it exists, otherwise the
   * handler's registered default.
   *
   * The default is what makes a tenant onboarded five minutes ago scheduled
   * immediately, without an operator remembering to insert a row — the failure
   * mode a schedule table alone would have.
   */
  private async resolveSchedules(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<ResolvedSchedule[]> {
    const overrides = await tx.scheduledJobSchedule.findMany({
      where: { tenantId },
    });
    const byType = new Map(overrides.map((o) => [o.jobType, o]));
    return this.registry.all.map((handler) => {
      const override = byType.get(handler.jobType);
      return {
        jobType: handler.jobType,
        timezone: override?.timezone ?? handler.defaultSchedule.timezone,
        localTimeOfDay:
          override?.localTimeOfDay ?? handler.defaultSchedule.localTimeOfDay,
        catchUpLimit:
          override?.catchUpLimit ?? handler.defaultSchedule.catchUpLimit,
        maxAttempts: handler.maxAttempts,
        enabled: override?.enabled ?? true,
      };
    });
  }

  /** Turn effective schedules into the occurrences that are due at `now`. */
  private planOccurrences(
    schedules: readonly ResolvedSchedule[],
    now: Date,
  ): OccurrencePlan[] {
    const plans: OccurrencePlan[] = [];
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      for (const due of dueDailySlots(
        now,
        schedule.timezone,
        schedule.localTimeOfDay,
        schedule.catchUpLimit,
      )) {
        plans.push({
          jobType: schedule.jobType,
          occurrenceKey: due.key,
          scheduledFor: due.scheduledFor,
          maxAttempts: schedule.maxAttempts,
        });
      }
    }
    return plans;
  }

  /**
   * Execute ONE claimed occurrence.
   *
   * ── THE TWO PHASES, AND WHY THE SPLIT IS LOAD-BEARING ─────────────────────
   * `detect` runs FIRST, outside the settle transaction. It is contractually
   * effect-free, so re-running it after a lost lease costs work and nothing
   * else — and it can take as long as it needs without holding a write
   * transaction open across a whole reconciliation scan.
   *
   * `commit` + `settle` then run in ONE transaction whose settle predicate
   * names the `(lease_owner, attempt)` this worker claimed. If the lease was
   * reclaimed while `detect` was running, the settle matches zero rows, throws
   * `ScheduledJobLeaseLostError`, and the transaction rolls back — taking the
   * handler's `commit` writes with it. Concretely: the original worker, resumed
   * after its lease was lost, CANNOT commit a second successful occurrence.
   */
  private async execute(
    tenantId: string,
    occurrence: ClaimedOccurrence,
    now: Date,
  ): Promise<'succeeded' | 'failed' | 'retry' | 'lease-lost'> {
    const handler = this.registry.get(occurrence.jobType);
    if (!handler) {
      // A claimed occurrence for a job type this build no longer registers.
      // Terminal, not retryable: waiting cannot make a deleted handler appear.
      await this.settleTerminal(
        tenantId,
        occurrence,
        SCHEDULED_JOB_OUTCOME.UNKNOWN_JOB_TYPE,
        0,
      );
      return 'failed';
    }

    const context: ScheduledJobContext = {
      tenantId,
      jobType: occurrence.jobType,
      occurrenceKey: occurrence.occurrenceKey,
      scheduledFor: occurrence.scheduledFor,
      attempt: occurrence.attempt,
      timezone: handler.defaultSchedule.timezone,
    };

    // A scheduled occurrence is a ROOT cause: it has no prior HTTP request or
    // domain event that made it happen. It therefore gets a fresh correlation
    // id and a NULL causation id — the same honesty rule `resolveCausationId`
    // already applies to a root HTTP request, rather than inventing a false
    // causal link. Everything the handler logs inherits both.
    return this.observability.run(
      {
        correlationId: newId(),
        causationId: null,
        tenantId,
        branchId: null,
        route: null,
        handler: null,
        method: 'SCHEDULER',
        startedAtNs: process.hrtime.bigint(),
        completed: false,
      },
      async () =>
        this.executeInContext(tenantId, occurrence, handler, context, now),
    );
  }

  private async executeInContext(
    tenantId: string,
    occurrence: ClaimedOccurrence,
    handler: ScheduledJobHandler,
    context: ScheduledJobContext,
    now: Date,
  ): Promise<'succeeded' | 'failed' | 'retry' | 'lease-lost'> {
    const meta = {
      tenantId,
      jobType: occurrence.jobType,
      occurrenceKey: occurrence.occurrenceKey,
      attempt: occurrence.attempt,
      lagMs: now.getTime() - occurrence.scheduledFor.getTime(),
    };
    this.logger.logEvent(
      'info',
      'scheduler.occurrence.started',
      'Scheduled job occurrence started.',
      meta,
    );

    const startedNs = process.hrtime.bigint();
    let detected: unknown;
    let renewal: NodeJS.Timeout | undefined;
    try {
      // Keep the lease alive across a long detection so an honest, slow job is
      // not reclaimed out from under itself. `unref` so a pending renewal can
      // never hold the process open at shutdown.
      renewal = setInterval(() => {
        void this.store
          .renew(tenantId, occurrence, new Date())
          .catch(() => undefined);
      }, SCHEDULER_LEASE_RENEW_MS);
      renewal.unref?.();
      detected = await handler.detect(context);
    } catch (error) {
      if (renewal) clearInterval(renewal);
      return this.onFailure(tenantId, occurrence, error, startedNs, meta, now);
    }
    if (renewal) clearInterval(renewal);

    const durationMs = elapsedMs(startedNs);
    // Derived BEFORE the transaction opens: `findings` is contractually pure,
    // so a defect in it fails here rather than while a write transaction is
    // held open, and the array is the same one counted after the commit.
    let findings: readonly ScheduledJobFindingInput[] = [];
    try {
      findings = handler.findings?.(context, detected) ?? [];
    } catch (error) {
      return this.onFailure(tenantId, occurrence, error, startedNs, meta, now);
    }

    try {
      await this.prisma.withAuthContext({ tenantId }, async (tx) => {
        if (handler.commit) {
          await handler.commit(tx, context, detected);
        }
        for (const finding of findings) {
          await this.findingWriter.record(tx, {
            tenantId,
            jobType: occurrence.jobType,
            occurrenceKey: occurrence.occurrenceKey,
            finding,
          });
        }
        await this.store.settle(tx, tenantId, occurrence, {
          state: SCHEDULED_JOB_STATE.SUCCEEDED,
          outcomeCode: SCHEDULED_JOB_OUTCOME.OK,
          completedAt: new Date(),
          durationMs,
          // A succeeded occurrence never runs again; this column is retained
          // only so the row keeps a NOT NULL value with an honest meaning.
          nextAttemptAt: occurrence.scheduledFor,
        });
      });
    } catch (error) {
      if (error instanceof ScheduledJobLeaseLostError) {
        this.metrics.recordScheduledJobPhase({
          jobType: occurrence.jobType,
          phase: SCHEDULED_JOB_PHASE.LEASE_LOST,
        });
        this.logger.logEvent(
          'warn',
          'scheduler.occurrence.lease_lost',
          'Lease was reclaimed while this attempt was running; it committed nothing.',
          meta,
        );
        return 'lease-lost';
      }
      return this.onFailure(tenantId, occurrence, error, startedNs, meta, now);
    }

    this.metrics.recordScheduledJobPhase({
      jobType: occurrence.jobType,
      phase: SCHEDULED_JOB_PHASE.SUCCEEDED,
    });
    this.metrics.recordScheduledJobDuration(
      occurrence.jobType,
      durationMs / 1000,
    );
    // Counted only now, after the transaction that persisted them committed —
    // a rolled-back attempt inflates nothing.
    for (const finding of findings) {
      this.metrics.recordScheduledJobFinding(
        occurrence.jobType,
        finding.severity,
      );
    }
    this.logger.logEvent(
      'info',
      'scheduler.occurrence.succeeded',
      'Scheduled job occurrence succeeded.',
      {
        ...meta,
        durationMs,
        outcome: SCHEDULED_JOB_OUTCOME.OK,
        count: findings.length,
      },
    );
    return 'succeeded';
  }

  /**
   * Decide whether a failure is retryable, and settle accordingly.
   *
   * `ScheduledJobPermanentError` is TERMINAL on the spot: a validation or
   * business-rule failure is not made true by waiting, and burning three
   * attempts on it only delays the operator seeing the real reason. Anything
   * else is treated as transient and retried with bounded, deterministic
   * backoff until `max_attempts` — after which the occurrence is terminally
   * `failed` with `attempts_exhausted`, never retried forever.
   */
  private async onFailure(
    tenantId: string,
    occurrence: ClaimedOccurrence,
    error: unknown,
    startedNs: bigint,
    meta: Record<string, unknown>,
    now: Date,
  ): Promise<'failed' | 'retry' | 'lease-lost'> {
    const durationMs = elapsedMs(startedNs);
    const permanent = error instanceof ScheduledJobPermanentError;
    const outcomeCode = permanent
      ? error.code || SCHEDULED_JOB_OUTCOME.PERMANENT_ERROR
      : SCHEDULED_JOB_OUTCOME.HANDLER_ERROR;
    const attemptsLeft = occurrence.attempt < occurrence.maxAttempts;
    const retry = !permanent && attemptsLeft;

    const logMeta = {
      ...meta,
      durationMs,
      outcome: retry ? SCHEDULED_JOB_OUTCOME.HANDLER_ERROR : outcomeCode,
      exceptionClass: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    };

    try {
      await this.prisma.withAuthContext({ tenantId }, (tx) =>
        this.store.settle(tx, tenantId, occurrence, {
          state: retry
            ? SCHEDULED_JOB_STATE.PENDING
            : SCHEDULED_JOB_STATE.FAILED,
          outcomeCode: retry
            ? SCHEDULED_JOB_OUTCOME.HANDLER_ERROR
            : permanent
              ? outcomeCode
              : SCHEDULED_JOB_OUTCOME.ATTEMPTS_EXHAUSTED,
          completedAt: retry ? null : new Date(),
          durationMs,
          // Backoff is measured from the TICK INSTANT, not from `Date.now()`:
          // the tick instant is the one authority on "when" for the whole
          // occurrence, and mixing two clocks would make the retry gate
          // untestable and, on a clock step, wrong.
          nextAttemptAt: retry
            ? new Date(now.getTime() + retryDelayMs(occurrence.attempt))
            : occurrence.scheduledFor,
        }),
      );
    } catch (settleError) {
      if (settleError instanceof ScheduledJobLeaseLostError) {
        this.metrics.recordScheduledJobPhase({
          jobType: occurrence.jobType,
          phase: SCHEDULED_JOB_PHASE.LEASE_LOST,
        });
        this.logger.logEvent(
          'warn',
          'scheduler.occurrence.lease_lost',
          'Lease was reclaimed before this failed attempt could be recorded.',
          meta,
        );
        return 'lease-lost';
      }
      throw settleError;
    }

    this.metrics.recordScheduledJobPhase({
      jobType: occurrence.jobType,
      phase: retry
        ? SCHEDULED_JOB_PHASE.RETRY_SCHEDULED
        : SCHEDULED_JOB_PHASE.FAILED,
    });
    if (!retry) {
      this.metrics.recordScheduledJobPhase({
        jobType: occurrence.jobType,
        phase: SCHEDULED_JOB_PHASE.EXHAUSTED,
      });
    }
    this.logger.logEvent(
      retry ? 'warn' : 'error',
      retry ? 'scheduler.occurrence.retry' : 'scheduler.occurrence.failed',
      retry
        ? 'Scheduled job occurrence failed transiently; a retry is scheduled.'
        : 'Scheduled job occurrence failed terminally.',
      logMeta,
    );
    return retry ? 'retry' : 'failed';
  }

  /** Settle an occurrence terminally without running a handler. */
  private async settleTerminal(
    tenantId: string,
    occurrence: ClaimedOccurrence,
    outcomeCode: string,
    durationMs: number,
  ): Promise<void> {
    await this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        this.store.settle(tx, tenantId, occurrence, {
          state: SCHEDULED_JOB_STATE.FAILED,
          outcomeCode,
          completedAt: new Date(),
          durationMs,
          nextAttemptAt: occurrence.scheduledFor,
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof ScheduledJobLeaseLostError) return;
        throw error;
      });
    this.metrics.recordScheduledJobPhase({
      jobType: occurrence.jobType,
      phase: SCHEDULED_JOB_PHASE.FAILED,
    });
    this.logger.logEvent(
      'error',
      'scheduler.occurrence.failed',
      'Scheduled job occurrence failed terminally.',
      {
        tenantId,
        jobType: occurrence.jobType,
        occurrenceKey: occurrence.occurrenceKey,
        attempt: occurrence.attempt,
        outcome: outcomeCode,
      },
    );
  }

  /**
   * The UTC instant a local occurrence key resolves to in a zone. Exposed for
   * operator tooling and for tests that need to assert the DST resolution the
   * substrate actually used, rather than re-deriving it independently.
   */
  static instantForOccurrenceKey(
    occurrenceKey: string,
    timeZone: string,
  ): Date {
    return instantForLocalSlot(parseLocalSlotKey(occurrenceKey), timeZone);
  }
}

function elapsedMs(startedNs: bigint): number {
  return Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
}
