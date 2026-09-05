import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SCHEDULED_JOB_OUTCOME,
  SCHEDULED_JOB_STATE,
  SCHEDULER_LEASE_MS,
} from './scheduled-job.constants';

/** One occurrence this worker owns for exactly one attempt. */
export interface ClaimedOccurrence {
  readonly jobType: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: Date;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  /** True when this claim took an expired lease off a previous owner. */
  readonly reclaimed: boolean;
}

/** A due occurrence to be materialised, computed by the cadence engine. */
export interface OccurrencePlan {
  readonly jobType: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: Date;
  readonly maxAttempts: number;
}

/**
 * Raised when the settle finds that this worker no longer owns the occurrence —
 * its lease expired and another instance reclaimed it. Because the settle runs
 * in the SAME transaction as the handler's `commit`, throwing here rolls the
 * domain effect back with it: a worker that lost its lease cannot commit a
 * second successful occurrence.
 */
export class ScheduledJobLeaseLostError extends Error {
  constructor(
    readonly jobType: string,
    readonly occurrenceKey: string,
    readonly attempt: number,
  ) {
    super(
      `Lease lost for ${jobType} occurrence ${occurrenceKey} (attempt ${attempt}); ` +
        'another worker has reclaimed it. This attempt commits nothing.',
    );
    this.name = 'ScheduledJobLeaseLostError';
  }
}

/**
 * Durable occurrence state: materialise, claim, renew, settle, reap.
 *
 * EVERY statement here runs inside `PrismaService.withAuthContext({ tenantId })`
 * (or inside a transaction the caller already opened that way), so
 * `platform.job_occurrences`' FORCE-RLS policies apply to the scheduler exactly
 * as they apply to a request-path caller. There is no `BYPASSRLS`, no
 * superuser connection, and no cross-tenant statement anywhere in this file: a
 * worker with no tenant context sees nothing at all rather than seeing
 * everything.
 */
@Injectable()
export class ScheduledJobOccurrenceStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert every due occurrence that does not exist yet, in ONE set-oriented
   * statement. `ON CONFLICT DO NOTHING` on the primary key
   * `(tenant_id, job_type, occurrence_key)` is what makes a duplicate scheduler
   * tick, a second application instance, and a catch-up replay all converge on
   * the same single row — the uniqueness is PostgreSQL's, not the application's.
   *
   * @returns how many occurrences were newly created.
   */
  async materialize(
    tx: Prisma.TransactionClient,
    tenantId: string,
    plans: readonly OccurrencePlan[],
  ): Promise<number> {
    if (plans.length === 0) return 0;
    const values = plans.map(
      (p) => Prisma.sql`(
        ${tenantId}::uuid, ${p.jobType}, ${p.occurrenceKey},
        ${p.scheduledFor}::timestamptz, ${SCHEDULED_JOB_STATE.PENDING},
        0, ${p.maxAttempts}, ${p.scheduledFor}::timestamptz
      )`,
    );
    return tx.$executeRaw(Prisma.sql`
      INSERT INTO platform.job_occurrences (
        tenant_id, job_type, occurrence_key, scheduled_for, state,
        attempt, max_attempts, next_attempt_at
      ) VALUES ${Prisma.join(values, ', ')}
      ON CONFLICT (tenant_id, job_type, occurrence_key) DO NOTHING`);
  }

  /**
   * Claim up to `limit` occurrences for this worker.
   *
   * ── WHY TWO STATEMENTS AND NOT ONE `OR` ──────────────────────────────────
   * There are two eligible populations, and they are found by two DIFFERENT
   * columns:
   *
   *   DUE      `state = 'pending' AND next_attempt_at <= now`
   *   ABANDONED `state = 'running' AND lease_expires_at <= now`
   *
   * Expressed as one `OR`, PostgreSQL cannot use either index — it has to scan
   * and then sort, which was measured live turning into a `Seq Scan` +`Sort`
   * over the whole occurrence table once history accumulated. Since
   * `job_occurrences` grows forever (one row per tenant per job per day) and
   * the eligible set stays tiny, that is the difference between a claim that
   * scales with the FLEET and one that scales with the scheduler's own history.
   *
   * Split, each statement matches an index exactly — `job_occurrences_claim_idx`
   * for the due set, `job_occurrences_reclaim_idx` for the abandoned set — with
   * the `ORDER BY` satisfied by the index rather than by a sort. `FOR UPDATE`
   * cannot be combined with `UNION`, so two statements is also the only way to
   * keep the row locking.
   *
   * Due work is claimed FIRST and the remaining budget goes to reclaims: fresh
   * occurrences are what the business is waiting on, and an abandoned one has
   * already waited out a whole lease.
   *
   * ── WHY A `MATERIALIZED` CTE AND NOT A SUBQUERY IN `FROM` ────────────────
   * `UPDATE ... FROM (SELECT ... LIMIT n) picked` looks equivalent and is NOT.
   * PostgreSQL is free to plan the subquery on the inner side of a nested loop
   * and RE-EXECUTE it once per candidate outer row; the `LIMIT` then caps each
   * execution rather than the statement, and a claim asking for one occurrence
   * quietly takes every eligible one. That was observed live against PostgreSQL
   * 16 on this exact query (`claimBatch: 1` claiming 7 occurrences) before this
   * form replaced it. `WITH ... AS MATERIALIZED` forces exactly one evaluation,
   * so the `LIMIT` is a statement-level bound and the batch size means what it
   * says. This is a correctness property, not a performance tweak: an unbounded
   * claim is exactly the catch-up storm the design forbids.
   *
   * ── WHY THIS IS EXACTLY-ONCE UNDER CONCURRENCY ────────────────────────────
   * The CTE takes row locks with `FOR UPDATE SKIP LOCKED`, so two workers
   * racing on the same tick never even see the same candidate row: the loser
   * skips it rather than blocking on it and then re-reading a row whose state
   * has changed underneath. The UPDATE then moves the row out of its previous
   * state and stamps THIS worker's `lease_owner` and a FRESH `attempt`. Both
   * facts matter:
   *
   *   - the state change means a second claim in the same instant finds nothing;
   *   - the `attempt` increment means the PREVIOUS owner of a reclaimed
   *     occurrence can never settle it again (its settle predicate names the
   *     attempt it observed).
   *
   * `attempt < max_attempts` still holds in both populations; an occurrence that
   * has spent its attempts is left for {@link reapExhausted} rather than being
   * claimed into a state it can never leave.
   */
  async claim(
    tx: Prisma.TransactionClient,
    tenantId: string,
    now: Date,
    leaseOwner: string,
    limit: number,
  ): Promise<ClaimedOccurrence[]> {
    const due = await this.claimWhere(
      tx,
      tenantId,
      now,
      leaseOwner,
      limit,
      SCHEDULED_JOB_STATE.PENDING,
    );
    if (due.length >= limit) return due;
    const abandoned = await this.claimWhere(
      tx,
      tenantId,
      now,
      leaseOwner,
      limit - due.length,
      SCHEDULED_JOB_STATE.RUNNING,
    );
    return [...due, ...abandoned];
  }

  /**
   * One index-aligned claim statement. `fromState` selects which population and
   * therefore which column gates eligibility and which index serves the scan.
   */
  private async claimWhere(
    tx: Prisma.TransactionClient,
    tenantId: string,
    now: Date,
    leaseOwner: string,
    limit: number,
    fromState: 'pending' | 'running',
  ): Promise<ClaimedOccurrence[]> {
    if (limit <= 0) return [];
    const leaseExpiresAt = new Date(now.getTime() + SCHEDULER_LEASE_MS);
    const reclaiming = fromState === SCHEDULED_JOB_STATE.RUNNING;
    // Gate column and ORDER BY are chosen together so the index provides the
    // ordering; they are literal SQL fragments, never caller input.
    const gate = reclaiming
      ? Prisma.sql`c.lease_expires_at <= ${now}::timestamptz`
      : Prisma.sql`c.next_attempt_at <= ${now}::timestamptz`;
    const ordering = reclaiming
      ? Prisma.sql`c.lease_expires_at ASC, c.job_type ASC, c.occurrence_key ASC`
      : Prisma.sql`c.next_attempt_at ASC, c.job_type ASC, c.occurrence_key ASC`;

    const rows = await tx.$queryRaw<
      {
        job_type: string;
        occurrence_key: string;
        scheduled_for: Date;
        attempt: number;
        max_attempts: number;
      }[]
    >(Prisma.sql`
      WITH picked AS MATERIALIZED (
        SELECT c.tenant_id, c.job_type, c.occurrence_key
          FROM platform.job_occurrences c
         WHERE c.tenant_id = ${tenantId}::uuid
           AND c.state = ${fromState}
           AND ${gate}
           AND c.attempt < c.max_attempts
         ORDER BY ${ordering}
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE platform.job_occurrences o
         SET state            = ${SCHEDULED_JOB_STATE.RUNNING},
             lease_owner      = ${leaseOwner},
             lease_expires_at = ${leaseExpiresAt}::timestamptz,
             attempt          = o.attempt + 1,
             started_at       = ${now}::timestamptz
        FROM picked
       WHERE o.tenant_id      = picked.tenant_id
         AND o.job_type       = picked.job_type
         AND o.occurrence_key = picked.occurrence_key
      RETURNING o.job_type, o.occurrence_key, o.scheduled_for, o.attempt,
                o.max_attempts`);

    return rows.map((r) => ({
      jobType: r.job_type,
      occurrenceKey: r.occurrence_key,
      scheduledFor: r.scheduled_for,
      attempt: Number(r.attempt),
      maxAttempts: Number(r.max_attempts),
      leaseOwner,
      reclaimed: reclaiming,
    }));
  }

  /**
   * Extend this attempt's lease while a long job is still running. Predicated
   * on `(lease_owner, attempt)`, so a worker whose lease was already reclaimed
   * cannot resurrect its ownership by renewing.
   *
   * @returns true when the lease is still ours.
   */
  async renew(
    tenantId: string,
    occurrence: ClaimedOccurrence,
    now: Date,
  ): Promise<boolean> {
    const leaseExpiresAt = new Date(now.getTime() + SCHEDULER_LEASE_MS);
    const updated = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.scheduledJobOccurrence.updateMany({
        where: {
          tenantId,
          jobType: occurrence.jobType,
          occurrenceKey: occurrence.occurrenceKey,
          state: SCHEDULED_JOB_STATE.RUNNING,
          leaseOwner: occurrence.leaseOwner,
          attempt: occurrence.attempt,
        },
        data: { leaseExpiresAt },
      }),
    );
    return updated.count === 1;
  }

  /**
   * Move the occurrence to a terminal or retryable state, IN THE CALLER'S
   * TRANSACTION.
   *
   * The predicate names the exact `(lease_owner, attempt, state='running')`
   * this worker claimed. Zero rows updated means the lease was reclaimed while
   * the handler was working, so this throws — and because the caller runs the
   * handler's `commit` in this same transaction, the throw rolls that commit
   * back. That single fact is what makes "a worker that lost its lease cannot
   * commit a second successful occurrence" true rather than hoped for.
   */
  async settle(
    tx: Prisma.TransactionClient,
    tenantId: string,
    occurrence: ClaimedOccurrence,
    result: {
      state: 'succeeded' | 'failed' | 'pending';
      outcomeCode: string;
      completedAt: Date | null;
      durationMs: number | null;
      nextAttemptAt: Date;
    },
  ): Promise<void> {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE platform.job_occurrences
         SET state            = ${result.state},
             outcome_code     = ${result.outcomeCode},
             completed_at     = ${result.completedAt}::timestamptz,
             duration_ms      = ${result.durationMs}::int,
             next_attempt_at  = ${result.nextAttemptAt}::timestamptz,
             lease_owner      = NULL,
             lease_expires_at = NULL
       WHERE tenant_id      = ${tenantId}::uuid
         AND job_type       = ${occurrence.jobType}
         AND occurrence_key = ${occurrence.occurrenceKey}
         AND state          = ${SCHEDULED_JOB_STATE.RUNNING}
         AND lease_owner    = ${occurrence.leaseOwner}
         AND attempt        = ${occurrence.attempt}`);
    if (updated !== 1) {
      throw new ScheduledJobLeaseLostError(
        occurrence.jobType,
        occurrence.occurrenceKey,
        occurrence.attempt,
      );
    }
  }

  /**
   * Terminally fail occurrences that can never make progress again: a `running`
   * occurrence whose lease expired for the LAST time (every attempt spent), and
   * a `pending` occurrence whose attempts are spent.
   *
   * Without this an abandoned occurrence would sit `running` with an expired
   * lease forever, invisible to the claim (which requires
   * `attempt < max_attempts`) and indistinguishable from live work. Crash
   * safety is not just "reclaimable"; it is also "eventually truthful".
   */
  async reapExhausted(
    tx: Prisma.TransactionClient,
    tenantId: string,
    now: Date,
  ): Promise<number> {
    return tx.$executeRaw(Prisma.sql`
      UPDATE platform.job_occurrences
         SET state            = ${SCHEDULED_JOB_STATE.FAILED},
             outcome_code     = CASE WHEN state = ${SCHEDULED_JOB_STATE.RUNNING}
                                     THEN ${SCHEDULED_JOB_OUTCOME.LEASE_EXHAUSTED}
                                     ELSE ${SCHEDULED_JOB_OUTCOME.ATTEMPTS_EXHAUSTED} END,
             completed_at     = ${now}::timestamptz,
             lease_owner      = NULL,
             lease_expires_at = NULL
       WHERE tenant_id = ${tenantId}::uuid
         AND attempt  >= max_attempts
         AND (
               (state = ${SCHEDULED_JOB_STATE.RUNNING}
                AND lease_expires_at <= ${now}::timestamptz)
            OR (state = ${SCHEDULED_JOB_STATE.PENDING}
                AND next_attempt_at <= ${now}::timestamptz)
             )`);
  }
}
