import { Injectable } from '@nestjs/common';
import {
  ScheduledJobContext,
  ScheduledJobDefaultSchedule,
  ScheduledJobFindingInput,
  ScheduledJobHandler,
  ScheduledJobHandlerFor,
} from '../../platform/contract';
import { ReconciliationService } from './reconciliation.service';

/** `<domain>.<job>` — the durable job type, and a bounded metric label value. */
export const INVENTORY_DAILY_RECONCILIATION_JOB =
  'inventory.daily_reconciliation';

/**
 * The finding code recorded when the ledger and the projection disagree.
 * Bounded vocabulary: it is persisted, queried by operators, and referenced by
 * the alert rule in `docs/observability/alerts/backend-api.rules.yaml`.
 */
export const INVENTORY_DIVERGENCE_FINDING_CODE =
  'inventory.ledger_projection_divergence';

/**
 * At most this many diverging pairs are written into a finding's `detail`. A
 * finding is evidence an operator reads, not a data export: an unbounded array
 * would let one broken tenant write a multi-megabyte JSONB row. `divergenceCount`
 * always carries the TRUE total, so the sample can never be mistaken for it.
 */
const MAX_SAMPLED_DIVERGENCES = 50;

interface ReconciliationDetection {
  readonly divergenceCount: number;
  readonly sample: {
    stockItemId: string;
    locationId: string;
    projected: string;
    ledger: string;
  }[];
}

/**
 * SCHEDULED DAILY LEDGER-VS-PROJECTION RECONCILIATION.
 *
 *   BR-INV-003  "The sum of all movements for an (item, location) pair SHALL
 *                equal the stock_levels projection for that pair. A
 *                reconciliation job SHALL verify this daily and raise an alert
 *                on any divergence."
 *   FR-INV-011  "...a scheduled job SHALL verify the reconciliation daily and
 *                alert on divergence."
 *   FR-INV-051  "A scheduled reconciliation job SHALL verify that the sum of
 *                movements equals the stock level projection for every
 *                (item, location) pair, and SHALL raise a platform alert on any
 *                divergence."
 *
 * ── WHAT THIS CLASS DOES AND DOES NOT CONTAIN ─────────────────────────────
 * It contains NO reconciliation logic. The comparison lives in
 * `ReconciliationService.reconcile`, which the on-demand
 * `GET /inventory/reconciliation` endpoint already calls, and which A1-4's
 * concurrency matrix already proves correct. A second implementation here —
 * even an equivalent one — would be a second definition of "reconciled", free
 * to drift from the one the endpoint and the tests exercise. This class
 * supplies only what the substrate needs: WHEN to run, and WHAT to record.
 *
 * ── SCOPE: TENANT-WIDE, DELIBERATELY ──────────────────────────────────────
 * FR-INV-051 says "every (item, location) pair". Inventory locations are not
 * all branch-attributable — `org.locations` resolves to a branch, a warehouse,
 * OR a central kitchen, and a tenant-owned central kitchen belongs to no branch
 * at all. A per-branch occurrence would therefore leave those locations
 * unreconciled while reporting success, which is exactly the silent gap this
 * requirement exists to close. The occurrence is tenant-scoped, and
 * `reconcile()` groups by `(stock_item_id, location_id)` across the whole
 * tenant, so coverage is total by construction.
 *
 * The consequence, stated rather than hidden: a tenant's occurrence fires on ONE
 * schedule, not once per branch timezone. The zone is explicit and durable
 * (`platform.job_schedules.timezone`, defaulting to `UTC` below) and is never
 * the server's local zone. Branch-local scheduling is fully supported by the
 * substrate and is the right anchor for a genuinely per-branch job; it is the
 * wrong anchor for a requirement whose scope is "every pair in the tenant".
 *
 * ── DETECTION ONLY. NOTHING IS "FIXED" ────────────────────────────────────
 * A divergence between an append-only ledger and its projection is a
 * correctness incident, and silently rewriting the projection to agree with the
 * ledger would destroy the evidence needed to find out which writer was wrong.
 * No SRS clause asks for auto-repair here — all three say "verify" and "alert" —
 * so this job writes exactly one thing: a durable finding.
 *
 * ── THE ALERT LIMB IS PARTIAL, AND SAYS SO ────────────────────────────────
 * "Raise an alert" has two halves. DETECTION + a durable, attributable,
 * acknowledgeable record: implemented here, plus a low-cardinality metric and a
 * Prometheus alert rule alongside the ones G1-3 already ships. DELIVERY to a
 * human: NOT implemented, and not fakeable — no email, SMS, push or chat
 * channel exists in this repository, and governance decision N-A ratified that
 * none is introduced in this phase. BR-INV-003 therefore stays PARTIAL after
 * this slice, and the accompanying report says so in those words.
 */
@ScheduledJobHandlerFor(INVENTORY_DAILY_RECONCILIATION_JOB)
@Injectable()
export class InventoryDailyReconciliationJob implements ScheduledJobHandler<ReconciliationDetection> {
  readonly jobType = INVENTORY_DAILY_RECONCILIATION_JOB;

  /**
   * Daily at 03:00 UTC unless a tenant carries a `platform.job_schedules`
   * override. 03:00 is an IMPLEMENTATION-level choice (the SRS says "daily",
   * not an hour), picked to sit after a late-night branch's business-day
   * rollover rather than in the middle of trading. `UTC` is explicit, not a
   * fallback to server-local time — see the scope note above.
   */
  readonly defaultSchedule: ScheduledJobDefaultSchedule = {
    timezone: 'UTC',
    localTimeOfDay: 3 * 60,
    /**
     * ONE, and this is the interesting number.
     *
     * The substrate supports catching up on missed occurrences, and for a job
     * that processes a PAST day's data (a daily digest, a journal export) a
     * larger horizon is right: yesterday's report is still yesterday's report
     * when it runs late.
     *
     * This job is different. It verifies that the ledger and the projection
     * agree RIGHT NOW. Re-running Monday's occurrence on Wednesday would not
     * verify Monday — it would re-verify Wednesday, and then record a finding
     * (or a clean run) against Monday's occurrence key. That is fabricated
     * evidence: it would make `platform.job_occurrences` claim Monday was
     * checked when it was not.
     *
     * So a scheduler that was down for a week produces exactly ONE occurrence
     * when it returns, verifying the state it can actually see. The days that
     * were genuinely not verified have no occurrence row, which is the truthful
     * representation of "not verified", and `scheduled_job_lag_seconds` makes
     * the gap visible. A tenant that wants historical occurrences materialised
     * anyway can raise `platform.job_schedules.catch_up_limit`.
     */
    catchUpLimit: 1,
  };

  /**
   * Three attempts. A reconciliation failure is almost always transient (a
   * connection reset, a statement timeout under load); three bounded, backed-off
   * attempts cover that without a genuinely broken tenant retrying forever.
   */
  readonly maxAttempts = 3;

  constructor(private readonly reconciliation: ReconciliationService) {}

  /**
   * EFFECT-FREE. Reads the ledger and the projection through the canonical
   * service and returns what disagreed. Safe to re-run after a lost lease,
   * because it writes nothing at all.
   */
  async detect(context: ScheduledJobContext): Promise<ReconciliationDetection> {
    const result = await this.reconciliation.reconcile(context.tenantId);
    return {
      divergenceCount: result.divergences.length,
      sample: result.divergences.slice(0, MAX_SAMPLED_DIVERGENCES),
    };
  }

  /**
   * PURE. What this detection warrants recording. The substrate writes it inside
   * the same transaction that settles the occurrence, so a worker that lost its
   * lease leaves no finding behind.
   *
   * A healthy tenant returns NOTHING: an empty findings table for a succeeded
   * occurrence is the honest representation of "checked, and everything agreed".
   * An `info` row per tenant per day would bury the one row that matters.
   *
   * There is no `commit`: this job mutates nothing. See "detection only" above.
   */
  findings(
    _context: ScheduledJobContext,
    detected: ReconciliationDetection,
  ): readonly ScheduledJobFindingInput[] {
    if (detected.divergenceCount === 0) return [];
    return [
      {
        severity: 'critical',
        findingCode: INVENTORY_DIVERGENCE_FINDING_CODE,
        detail: {
          divergenceCount: detected.divergenceCount,
          sampled: detected.sample.length,
          sample: detected.sample,
        },
      },
    ];
  }
}
