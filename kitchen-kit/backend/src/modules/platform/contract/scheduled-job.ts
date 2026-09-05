import { Prisma } from '../../../generated/prisma/client';

/**
 * Platform PUBLIC contract — the scheduled-job seam (SRS §5.4).
 *
 * SCHED-1 ships the scheduler SUBSTRATE, not the domains. A domain that needs
 * work run on a schedule registers a handler through this contract; the
 * substrate owns everything around it — durable schedule, occurrence identity,
 * multi-instance claim, lease, reclaim, retry, backoff, telemetry — and calls
 * the handler for one occurrence at a time, under that tenant's RLS context.
 *
 * ── THE TWO-PHASE SHAPE, AND WHY IT IS NOT ONE `execute()` ─────────────────
 * A scheduled occurrence must be exactly-once even though the worker holding it
 * can lose its lease at any moment (a GC pause, a network partition, an
 * `kill -9` followed by another instance reclaiming the expired lease). The
 * only way to make "the domain effect happened" and "the occurrence is settled
 * as succeeded" inseparable is to commit them in ONE transaction, guarded by
 * the lease this worker still believes it holds.
 *
 *   detect(ctx)          — EFFECT-FREE. Reads, computes, decides. Runs in its
 *                          own short transaction (or none). May be re-run any
 *                          number of times, by any number of workers, with no
 *                          consequence. This is where a reconciliation compares
 *                          a ledger to a projection, or a verifier walks a hash
 *                          chain.
 *
 *   findings(ctx, r)     — PURE. Derives the durable findings this detection
 *                          warrants. The SUBSTRATE writes them, inside the
 *                          settle transaction, so the common case (a job whose
 *                          only output is "here is what I found") needs no
 *                          transaction handling in the domain at all.
 *
 *   commit(tx, ctx, r)   — THE DOMAIN EFFECT, for a job that genuinely mutates
 *                          something. Receives the substrate's OWN transaction,
 *                          the same one that settles the occurrence. Everything
 *                          written through `tx` commits, or rolls back,
 *                          together with the settle. A worker whose lease was
 *                          reclaimed while it was detecting fails the settle's
 *                          `(lease_owner, attempt)` guard, the whole
 *                          transaction rolls back, and its `commit` writes —
 *                          and its findings — never existed.
 *
 * A handler that opens its own transaction inside `commit`, or writes through
 * any client other than `tx`, breaks that guarantee. The safe path is the easy
 * path precisely because `tx` is the only write handle offered.
 *
 * ── WHAT A HANDLER MUST NOT DO ────────────────────────────────────────────
 * Do not swallow failures: THROW. A bare throw is treated as TRANSIENT and the
 * occurrence is retried with bounded backoff. Throw
 * {@link ScheduledJobPermanentError} for a validation or business-rule failure
 * that retrying cannot fix — the occurrence goes terminally `failed` on the
 * spot rather than burning every attempt on a defect no amount of waiting
 * repairs.
 */
export interface ScheduledJobContext {
  readonly tenantId: string;
  readonly jobType: string;
  /** The occurrence's local wall-clock slot, `YYYY-MM-DDTHH:MM`. */
  readonly occurrenceKey: string;
  /** The UTC instant this occurrence became due. */
  readonly scheduledFor: Date;
  /** 1 on the first execution. Increments on every claim, including reclaims. */
  readonly attempt: number;
  /** The IANA zone the occurrence was scheduled in. Never the server's zone. */
  readonly timezone: string;
}

/**
 * A scheduled job. Registered by declaring an `@Injectable()` provider carrying
 * {@link ScheduledJobHandlerFor} in the domain's OWN Nest module — the
 * substrate never imports a domain.
 */
export interface ScheduledJobHandler<TDetected = unknown> {
  /** `<domain>.<job>`, e.g. `inventory.daily_reconciliation`. */
  readonly jobType: string;
  /** The schedule used when a tenant has no `platform.job_schedules` override. */
  readonly defaultSchedule: ScheduledJobDefaultSchedule;
  /**
   * Total attempts before the occurrence is terminally `failed`. Includes the
   * first attempt, and includes attempts consumed by lease reclaim.
   */
  readonly maxAttempts: number;
  /** EFFECT-FREE. Safe to re-run. */
  detect(context: ScheduledJobContext): Promise<TDetected>;
  /**
   * PURE derivation of the durable findings this detection warrants. Called by
   * the substrate, which writes them inside the settle transaction and only
   * then counts them in `scheduled_job_findings_total` — so a rolled-back
   * attempt neither leaves a finding row nor inflates the metric that alerts
   * on one.
   *
   * Return an empty array for a healthy result. A per-tenant, per-day "nothing
   * wrong" row would bury the one row that matters.
   */
  findings?(
    context: ScheduledJobContext,
    detected: TDetected,
  ): readonly ScheduledJobFindingInput[];
  /**
   * The domain effect for a job that genuinely mutates something, committed
   * atomically with the occurrence settle. Omit for a detect-and-report job:
   * findings are written by the substrate.
   */
  commit?(
    tx: Prisma.TransactionClient,
    context: ScheduledJobContext,
    detected: TDetected,
  ): Promise<void>;
}

/**
 * A job type's schedule when a tenant carries no durable override row. This is
 * the "derived deterministically from durable configuration" half of the
 * durability requirement: the value is a code constant, not process state, so a
 * restart cannot lose it and a tenant onboarded while the scheduler is running
 * is never silently unscheduled.
 *
 * `timezone` is an explicit IANA zone. There is deliberately no "server local"
 * option: a deployment moved between regions must not move every tenant's
 * business schedule with it.
 */
export interface ScheduledJobDefaultSchedule {
  readonly timezone: string;
  /** Minutes since local midnight, 0..1439. */
  readonly localTimeOfDay: number;
  /** Bounded catch-up horizon in occurrences. */
  readonly catchUpLimit: number;
}

/**
 * Throw this — never a bare `Error` — for a failure that RETRYING CANNOT FIX:
 * a validation failure, a business-rule violation, a missing configuration the
 * job cannot invent. The occurrence goes terminally `failed` immediately, with
 * this `code` recorded as its `outcome_code`.
 *
 * `code` must be a BOUNDED vocabulary token, not free text and not an
 * interpolated message: it is persisted, and it is the only part of a failure
 * an operator queries on.
 */
export class ScheduledJobPermanentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduledJobPermanentError';
  }
}

/** Severity vocabulary for a durable finding. */
export type ScheduledJobFindingSeverity = 'info' | 'warning' | 'critical';

/**
 * What a job DETECTED, written through the substrate's transaction inside
 * `commit`. Durable, attributable to an exact occurrence, acknowledgeable.
 *
 * This is the DETECTION half of the SRS's "SHALL raise an alert" clauses. It is
 * NOT a delivery channel: no email, SMS, push or chat integration exists in this
 * repository, and governance decision N-A ratified that none is introduced in
 * this phase. A caller that records a finding has recorded evidence, not
 * notified anybody, and no code in this repository claims otherwise.
 */
export interface ScheduledJobFindingInput {
  readonly severity: ScheduledJobFindingSeverity;
  /** Bounded vocabulary, e.g. `inventory.ledger_projection_divergence`. */
  readonly findingCode: string;
  readonly detail: Record<string, unknown>;
}
