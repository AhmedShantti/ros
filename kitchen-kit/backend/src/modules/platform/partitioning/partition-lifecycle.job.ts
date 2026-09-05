import { Injectable } from '@nestjs/common';
import {
  ScheduledJobContext,
  ScheduledJobDefaultSchedule,
  ScheduledJobFindingInput,
  ScheduledJobHandler,
  ScheduledJobHandlerFor,
} from '../contract';
import { PartitionDdlService } from './partition-ddl.service';
import { YearMonth, requiredMonths, yearMonthKey } from './partition-month';
import { PARTITIONED_TABLES } from './partitioned-table.registry';

/** `<domain>.<job>` — the durable job type. `platform`, not `inventory` or
 * `sales`, because the tables it maintains span domains and the job owns no
 * domain business logic — it owns physical partition topology. */
export const PARTITION_LIFECYCLE_JOB = 'platform.partition_lifecycle';

/**
 * FR-DR-002: "Partitions SHALL be created automatically at least 3 months in
 * advance." This is that literal number, named once and imported everywhere
 * it is used (the job and its tests) rather than re-stated.
 */
export const PARTITION_HORIZON_MONTHS = 3;

export const PARTITION_CREATION_FAILED_FINDING_CODE =
  'platform.partition_creation_failed';

interface PartitionAttemptResult {
  readonly schema: string;
  readonly table: string;
  readonly month: string;
  readonly outcome: 'created' | 'already_existed' | 'failed';
  readonly error?: string;
}

interface PartitionLifecycleDetection {
  readonly attempts: readonly PartitionAttemptResult[];
}

/**
 * SCHEDULED PARTITION LIFECYCLE — FR-DR-002.
 *
 *   FR-DR-002 "Partitions SHALL be created automatically at least 3 months in
 *              advance by a scheduled job, with alerting if creation fails."
 *
 * ── WHY THE REAL WORK HAPPENS IN `detect()`, NOT `commit()` ─────────────────
 * Every other job in this repository does its mutation in `commit(tx, ...)`,
 * transactionally joined to the occurrence settle. This job cannot: `tx` is
 * always the substrate's own `ros_app` connection (`PrismaService.
 * withAuthContext`), and `ros_app` cannot create a partition — PostgreSQL
 * requires OWNERSHIP of the parent table to attach a partition, which
 * `ros_app` deliberately does not have (see `PartitionAdminConnectionService`
 * for the empirical proof and the reasoning against widening `ros_app`
 * instead). The actual DDL therefore runs against a SEPARATE, narrowly-scoped
 * connection (`ros_partition_admin`, owning only these three tables) inside
 * `detect()`.
 *
 * This is a deliberate, DOCUMENTED deviation from the contract's "`detect` is
 * EFFECT-FREE" rule, not an oversight of it. What makes it safe is that every
 * statement `PartitionDdlService` runs is IDEMPOTENT and advisory-lock guarded
 * (proven safe under real concurrent execution — see that service's
 * docblock): re-running `detect()` after a lost lease, a retry, or a second
 * tenant's independent occurrence of this same job type produces the exact
 * same end state, with no duplicate and no partial partition, which is the
 * property "safe to re-run any number of times" actually protects. What is
 * NOT preserved is transactional atomicity with the occurrence settle: a
 * partition can exist even if this occurrence itself later fails to commit
 * its `findings`/settle (e.g. a lost lease). That is harmless here — an
 * idempotent partition, unlike a financial mutation, has no "undo" to lose,
 * and the next tick (this tenant's or another's) converges to the same
 * result regardless.
 *
 * ── SCOPE: EVERY ACTIVE TENANT RUNS THE SAME GLOBAL CHECK ───────────────────
 * Partition topology is not tenant data — it is shared physical schema. The
 * scheduler substrate, however, has no concept of a job that is not
 * tenant-scoped (`platform.job_occurrences`' identity is `(tenant_id,
 * job_type, occurrence_key)`, and the runner fans a tick out over tenants
 * unconditionally). Inventing a "system tenant" or a global occurrence
 * bypassing that fan-out would be a change to the substrate's own identity
 * model — a bigger, separate decision this slice does not take unilaterally.
 * Instead, every active tenant's daily occurrence runs the SAME check against
 * the SAME three tables, and the advisory lock in `PartitionDdlService` makes
 * that safe: at most one tenant's occurrence, of the N whose ticks happen to
 * overlap, actually performs DDL for a given missing partition — the rest
 * find it already there and no-op in a single catalog lookup per table. The
 * measured cost of that redundancy is bounded and stated in the accompanying
 * report's performance section, not hidden.
 *
 * ── ALERTING: DETECTION + A DURABLE FINDING, NOT DELIVERY ───────────────────
 * "With alerting if creation fails" has the same two halves G1-3/SCHED-1
 * already established for BR-INV-003: a durable, attributable
 * `platform.job_findings` row plus a Prometheus alert rule and runbook exist;
 * DELIVERY to a human does not, for the same repository-wide reason
 * (governance decision N-A: no notification substrate in this phase). This
 * job's creation-failure limb is therefore reported PARTIAL for the same
 * stated reason as BR-INV-003/FR-INV-011/FR-INV-051, not COMPLETE.
 */
@ScheduledJobHandlerFor(PARTITION_LIFECYCLE_JOB)
@Injectable()
export class PartitionLifecycleJob implements ScheduledJobHandler<PartitionLifecycleDetection> {
  readonly jobType = PARTITION_LIFECYCLE_JOB;

  /**
   * Daily at 02:00 UTC — before the Inventory reconciliation job's 03:00 UTC
   * slot, so partition coverage is refreshed ahead of anything that might
   * write into a boundary month. UTC, explicit, never server-local, for the
   * same reason `zoned-time.ts` never reads `process.env.TZ`: partition
   * topology is not any tenant's business day, so there is no tenant zone to
   * anchor it to (see `partition-month.ts`'s own docblock).
   */
  readonly defaultSchedule: ScheduledJobDefaultSchedule = {
    timezone: 'UTC',
    localTimeOfDay: 2 * 60,
    /**
     * ONE: a scheduler that was down for a week and materialised several
     * stale catch-up occurrences would have every one of them recompute
     * against a `scheduledFor` within hours of each other and do effectively
     * IDENTICAL, redundant work — there is no missed-day content to "catch up
     * on" the way a reconciliation-of-yesterday or a digest-of-yesterday has.
     * A single occurrence, using the real due instant, is sufficient: the
     * 3-month horizon has enormous slack against being computed from an
     * instant that is at most a day or two stale.
     */
    catchUpLimit: 1,
  };

  /**
   * Five, one more than Inventory's three: DDL contends on the advisory lock
   * described in `PartitionDdlService`, and a worker that loses that race
   * (blocked briefly, not failed) should not be the reason an otherwise
   * healthy tenant burns its attempts. An IMPLEMENTATION-level choice,
   * documented rather than hidden — the SRS states no retry count.
   */
  readonly maxAttempts = 5;

  constructor(private readonly ddl: PartitionDdlService) {}

  async detect(
    context: ScheduledJobContext,
  ): Promise<PartitionLifecycleDetection> {
    // `context.scheduledFor`, not `new Date()`: the substrate already makes
    // "now" an explicit, injectable value for every occurrence (that is the
    // whole reason `ScheduledJobRunnerService.runTick` takes a `now`
    // parameter, and every DST/catch-up test in this repository depends on
    // it) — reaching past that to read the real wall clock would make this
    // job's output depend on WHEN it happens to execute rather than on the
    // occurrence it is executing, undermining exactly the determinism the
    // rest of the substrate is built around. `scheduledFor` is never more
    // than about a day stale even after a missed tick (`catchUpLimit: 1`
    // above), which is irrelevant slop against a horizon measured in months.
    const months: readonly YearMonth[] = requiredMonths(
      context.scheduledFor,
      PARTITION_HORIZON_MONTHS,
    );

    const attempts: PartitionAttemptResult[] = [];
    for (const table of PARTITIONED_TABLES) {
      for (const ym of months) {
        const month = yearMonthKey(ym);
        try {
          // sequential: each partition's DDL takes the same global advisory
          // lock, so concurrency here would only serialise anyway, and
          // sequential execution keeps one failing table from racing ahead of
          // a still-in-flight statement on another.
          const outcome = await this.ddl.ensurePartition(table, ym);
          attempts.push({
            schema: table.schema,
            table: table.table,
            month,
            outcome,
          });
        } catch (error) {
          attempts.push({
            schema: table.schema,
            table: table.table,
            month,
            outcome: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return { attempts };
  }

  /**
   * A healthy tick — every required partition already existed, or was
   * created cleanly — writes NOTHING, for the same reason Inventory's
   * reconciliation does: an `info` row every tenant every day would bury the
   * one row that matters. A failure writes exactly ONE finding per
   * occurrence, aggregating every table/month that failed, so one broken
   * tenant/tick cannot write more than a single bounded row.
   */
  findings(
    _context: ScheduledJobContext,
    detected: PartitionLifecycleDetection,
  ): readonly ScheduledJobFindingInput[] {
    const failures = detected.attempts.filter((a) => a.outcome === 'failed');
    if (failures.length === 0) return [];
    return [
      {
        severity: 'critical',
        findingCode: PARTITION_CREATION_FAILED_FINDING_CODE,
        detail: {
          failureCount: failures.length,
          failures: failures.map((f) => ({
            schema: f.schema,
            table: f.table,
            month: f.month,
            error: f.error,
          })),
        },
      },
    ];
  }
}
