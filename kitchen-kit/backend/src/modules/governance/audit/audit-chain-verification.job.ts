import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  ScheduledJobContext,
  ScheduledJobDefaultSchedule,
  ScheduledJobFindingInput,
  ScheduledJobHandler,
  ScheduledJobHandlerFor,
} from '../../platform/contract';
import { verifyAuditChain, VerifiableAuditEntry } from './audit-verify';

/** `<domain>.<job>` — the durable job type, and a bounded metric label value. */
export const AUDIT_CHAIN_VERIFICATION_JOB =
  'governance.audit_chain_verification';

/**
 * The finding code recorded when a tenant's audit hash chain fails
 * verification. Bounded vocabulary: persisted, queried by operators, and
 * referenced by the alert rule in `docs/observability/alerts/backend-api.rules.yaml`.
 */
export const AUDIT_CHAIN_BROKEN_FINDING_CODE = 'governance.audit_chain_broken';

interface ChainVerificationDetection {
  readonly entriesVerified: number;
  readonly valid: boolean;
  readonly brokenAtSequenceNo: string | null;
  readonly reason: string | null;
}

/**
 * SCHEDULED AUDIT HASH-CHAIN VERIFICATION.
 *
 *   FR-AUD-005 [M] "A scheduled job SHALL verify chain integrity and SHALL
 *   raise a platform-level security alert on any break."
 *
 * ── WHAT THIS CLASS DOES AND DOES NOT CONTAIN ─────────────────────────────
 * It contains NO verification algorithm. Recomputing and comparing hashes is
 * `verifyAuditChain` (`audit-verify.ts`), the SAME function
 * `audit-verify.spec.ts` already proves correct against content tampering,
 * broken linkage, a bad genesis and sequence gaps/duplicates. This class
 * supplies only what the substrate needs: WHEN to run, WHAT to read, and WHAT
 * to record. A second implementation of chain verification — even an
 * equivalent one — would be a second definition free to drift from the one
 * the unit suite exercises, which is exactly what AUD-1 forbids.
 *
 * ── SCOPE: ONE TENANT'S OWN CHAIN, DELIBERATELY ───────────────────────────
 * `FR-AUD-004`'s chain is per-tenant (`hash(n) = SHA-256(canonical_json(entry_n)
 * || hash(n-1))`, scoped by `tenant_id`). The scheduler substrate hands this
 * job exactly one tenant's RLS context per occurrence
 * (`ScheduledJobRunnerService.runTenant`), so `detect` reads and verifies
 * that tenant's own `governance.audit_entries` chain — no cross-tenant read is
 * possible or attempted (RLS forced, unchanged; see D-9/ADR 0007). The global
 * "sentinel" chain (`SENTINEL_TENANT_ID`, anonymous/auth events with no real
 * tenant) is verified as part of the sentinel's OWN tenant registration —
 * `identity.tenants` carries no such row, so that chain is out of THIS job's
 * per-tenant reach; it remains a documented gap, not silently claimed covered.
 *
 * ── DETECTION ONLY. NO MUTATION, EVER ─────────────────────────────────────
 * `detect` performs exactly one read (`auditEntry.findMany`, ordered by
 * `sequenceNo` ascending) and computes a pure, in-memory verdict. It writes
 * nothing — no `commit` exists on this handler — so a verification run can
 * never itself alter, re-sign, or otherwise touch the chain it is checking.
 * That is also what keeps the job safe to re-run indefinitely: `verifyAuditChain`
 * is a pure function of its input rows.
 *
 * ── COST, STATED HONESTLY ─────────────────────────────────────────────────
 * This is a FULL re-verification of the tenant's entire chain from sequence 1
 * on every occurrence — `verifyAuditChain` itself requires it (it asserts
 * `sequenceNo === i + 1` from the first row), so no incremental/resumable
 * variant exists to reuse without writing a second, divergent verification
 * routine, which AUD-1 explicitly forbids. Cost therefore grows with chain
 * length. `scheduled_job_duration_seconds{job_type="governance.
 * audit_chain_verification"}` is the existing SCHED-1 metric that makes this
 * visible; splitting large tenants into incremental verification is left for a
 * future slice.
 *
 * ── THE ALERT LIMB IS PARTIAL, AND SAYS SO ────────────────────────────────
 * "Raise a platform-level security alert" has two halves. DETECTION + a
 * durable, attributable, acknowledgeable record: implemented here (a
 * `critical` finding via `platform.job_findings`), plus the existing
 * `scheduled_job_findings_total` metric and a Prometheus alert rule alongside
 * the ones SCHED-1/G1-3 already ship. DELIVERY to a human: NOT implemented —
 * no email, SMS, push or chat channel exists in this repository, and
 * governance decision N-A ratified that none is introduced in this phase.
 * `FR-AUD-005` therefore stays PARTIAL after this slice, and the accompanying
 * report says so in those words — no false "human delivery" claim is made
 * anywhere in this file or its finding.
 */
@ScheduledJobHandlerFor(AUDIT_CHAIN_VERIFICATION_JOB)
@Injectable()
export class AuditChainVerificationJob implements ScheduledJobHandler<ChainVerificationDetection> {
  readonly jobType = AUDIT_CHAIN_VERIFICATION_JOB;

  /**
   * Daily at 02:00 UTC unless a tenant carries a `platform.job_schedules`
   * override — one hour before Inventory's 03:00 daily reconciliation, so the
   * two detection-only jobs do not compete for the same window. `UTC` is
   * explicit, matching the reconciliation job's own reasoning: a tenant's
   * audit chain has no single "local" timezone once branches span zones.
   */
  readonly defaultSchedule: ScheduledJobDefaultSchedule = {
    timezone: 'UTC',
    localTimeOfDay: 2 * 60,
    /**
     * ONE — same reasoning as `InventoryDailyReconciliationJob`. This job
     * verifies the chain's integrity RIGHT NOW; re-running Monday's occurrence
     * on Wednesday would re-verify Wednesday's chain state and record the
     * result against Monday's occurrence key, which is fabricated evidence.
     * A scheduler down for a week produces exactly ONE occurrence when it
     * returns, verifying the state it can actually see.
     */
    catchUpLimit: 1,
  };

  /**
   * Three attempts. A verification failure is almost always transient (a
   * connection reset, a statement timeout on a very long chain); three
   * bounded, backed-off attempts cover that without a genuinely broken tenant
   * retrying forever.
   */
  readonly maxAttempts = 3;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * EFFECT-FREE. Reads this tenant's own chain (RLS-scoped by the substrate's
   * ambient tenant context) and recomputes/validates it via the canonical
   * `verifyAuditChain`. Safe to re-run after a lost lease: it writes nothing.
   */
  async detect(
    context: ScheduledJobContext,
  ): Promise<ChainVerificationDetection> {
    const rows = await this.prisma.withAuthContext(
      { tenantId: context.tenantId },
      (tx) =>
        tx.auditEntry.findMany({
          where: { tenantId: context.tenantId },
          orderBy: { sequenceNo: 'asc' },
          select: {
            tenantId: true,
            sequenceNo: true,
            occurredAt: true,
            actorType: true,
            actorId: true,
            action: true,
            entityType: true,
            entityId: true,
            terminalId: true,
            reasonCode: true,
            beforeState: true,
            afterState: true,
            correlationId: true,
            entryHash: true,
            previousHash: true,
          },
        }),
    );

    const entries: VerifiableAuditEntry[] = rows.map((r) => ({
      tenantId: r.tenantId,
      sequenceNo: r.sequenceNo,
      occurredAt: r.occurredAt,
      actorType: r.actorType as VerifiableAuditEntry['actorType'],
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      terminalId: r.terminalId,
      reasonCode: r.reasonCode,
      beforeState: r.beforeState,
      afterState: r.afterState,
      correlationId: r.correlationId,
      entryHash: r.entryHash,
      previousHash: r.previousHash,
    }));

    const verdict = verifyAuditChain(entries);
    return {
      entriesVerified: entries.length,
      valid: verdict.valid,
      brokenAtSequenceNo: verdict.brokenAtSequenceNo?.toString() ?? null,
      reason: verdict.reason ?? null,
    };
  }

  /**
   * PURE. A healthy chain (including an empty one — a brand-new tenant with no
   * audit entries yet is trivially valid) returns NOTHING: a per-tenant,
   * per-day "chain intact" row would bury the one row that matters. A broken
   * chain returns exactly one `critical` finding — this IS the FR-AUD-005
   * "platform-level security alert" detection limb.
   *
   * There is no `commit`: this job mutates nothing. See "detection only" above.
   */
  findings(
    context: ScheduledJobContext,
    detected: ChainVerificationDetection,
  ): readonly ScheduledJobFindingInput[] {
    if (detected.valid) return [];
    return [
      {
        severity: 'critical',
        findingCode: AUDIT_CHAIN_BROKEN_FINDING_CODE,
        detail: {
          tenantId: context.tenantId,
          entriesVerified: detected.entriesVerified,
          brokenAtSequenceNo: detected.brokenAtSequenceNo,
          reason: detected.reason,
        },
      },
    ];
  }
}
