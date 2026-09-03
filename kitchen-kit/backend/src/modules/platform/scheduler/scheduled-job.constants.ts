/**
 * Tuning constants for the durable scheduler substrate (SCHED-1).
 *
 * Every value here is an IMPLEMENTATION-level default, documented rather than
 * hidden, following this repository's existing convention (see
 * `PIN_MAX_FAILED_ATTEMPTS` in `src/config/env.validation.ts`). None is a
 * requirement-level value: the SRS states cadences ("daily", "at a configurable
 * time"), never lease durations or backoff curves.
 */

/**
 * How long a claim is valid before another instance may reclaim the occurrence.
 * Long enough that an ordinary slow job is not reclaimed under itself; short
 * enough that a killed process does not strand an occurrence for an hour.
 * Mirrors the intent of `SYNC_BATCH_LEASE_MS`.
 */
export const SCHEDULER_LEASE_MS = 120_000;

/** Renew this often while a long job is still running (half the lease). */
export const SCHEDULER_LEASE_RENEW_MS = SCHEDULER_LEASE_MS / 2;

/** First retry waits this long after a transient failure. */
export const SCHEDULER_RETRY_BASE_MS = 60_000;

/** Exponential backoff is capped here so a retry can never disappear. */
export const SCHEDULER_RETRY_CAP_MS = 900_000;

/**
 * Deterministic exponential backoff: attempt 1 -> base, 2 -> 2x, 3 -> 4x,
 * capped. No jitter — the occurrence identity already prevents two instances
 * from executing the same occurrence, so the thundering-herd problem jitter
 * exists to solve does not arise here, and a deterministic curve is what makes
 * the retry tests assert a value rather than a range.
 */
export function retryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    SCHEDULER_RETRY_BASE_MS * 2 ** exponent,
    SCHEDULER_RETRY_CAP_MS,
  );
}

/** Occurrence lifecycle states. Mirrors `ck_job_occurrences_state`. */
export const SCHEDULED_JOB_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;
export type ScheduledJobState =
  (typeof SCHEDULED_JOB_STATE)[keyof typeof SCHEDULED_JOB_STATE];

/**
 * The BOUNDED `outcome_code` vocabulary. An exception message is never
 * persisted here and never becomes a metric label — `exceptionClass` and the
 * message go to the structured log, where the redaction layer governs them.
 */
export const SCHEDULED_JOB_OUTCOME = {
  OK: 'ok',
  /** The handler threw something transient; a retry is scheduled. */
  HANDLER_ERROR: 'handler_error',
  /** The handler threw `ScheduledJobPermanentError` without a code. */
  PERMANENT_ERROR: 'permanent_error',
  /** Attempts exhausted after transient failures. */
  ATTEMPTS_EXHAUSTED: 'attempts_exhausted',
  /** Claimed, then abandoned; every reclaim was also abandoned. */
  LEASE_EXHAUSTED: 'lease_exhausted',
  /** No handler is registered for this job type (deployment/config defect). */
  UNKNOWN_JOB_TYPE: 'unknown_job_type',
} as const;

/** Low-cardinality telemetry phases. Fixed at deploy time; never per-tenant. */
export const SCHEDULED_JOB_PHASE = {
  MATERIALIZED: 'materialized',
  CLAIMED: 'claimed',
  RECLAIMED: 'reclaimed',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  RETRY_SCHEDULED: 'retry_scheduled',
  LEASE_LOST: 'lease_lost',
  EXHAUSTED: 'exhausted',
} as const;
export type ScheduledJobPhase =
  (typeof SCHEDULED_JOB_PHASE)[keyof typeof SCHEDULED_JOB_PHASE];
