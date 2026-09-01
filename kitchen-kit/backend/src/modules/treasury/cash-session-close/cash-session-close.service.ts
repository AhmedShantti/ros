/**
 * CashSession Close — P1G-1 migration 34.
 *
 * Authority (CONTROLLING, in order): the four accepted P1G-1 CashSession
 * Close design/closure reports (final design gate, design acceptance
 * closure, final acceptance closure, migration-compatibility closure) and
 * the "R-6 — Cash Variance Approval Rejection Recovery — RATIFIED
 * 2026-08-30" register entry.
 *
 * ── THE PROTOCOL (C-3) ──────────────────────────────────────────────────
 * `declareClose` is the SOLE write that creates the immutable count
 * declaration. Within tolerance, it closes the session in the SAME
 * transaction (one request). Above tolerance, it freezes the session
 * (`OPEN -> CLOSING`) and returns without disclosing anything until AFTER
 * COMMIT — the blind-count control (FR-POS-095 [M]) is that disclosure can
 * only ever follow a durably committed, immutable count.
 *
 * `finalizeClose` is the ONLY way out of `CLOSING`. There is NO
 * above-tolerance one-request path — a manager PIN entered before
 * disclosure could not be an INFORMED decision against the actual
 * `ApprovalRequest.value` (design acceptance closure §2).
 *
 * ── R-6(a) — REJECTION ───────────────────────────────────────────────────
 * An explicit REJECTED decision COMMITS — it is never implemented by
 * throwing after the decision INSERT (that would roll back the very
 * immutable record FR-SEC-033 [M] requires). The session simply stays
 * `CLOSING`; nothing about the session row is touched. A retry supplies
 * FRESH `approvalRequestId`/`approvalDecisionId` values.
 *
 * ── EXPIRY BASE ───────────────────────────────────────────────────────────
 * `expiresAt` is computed from `SELECT statement_timestamp()` read
 * immediately before `createRequest` — NEVER `transaction_timestamp()`
 * (fixed at BEGIN, ages across the advisory-lock wait that is this
 * transaction's own first statement) and never an application clock (final
 * acceptance closure §2).
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import type { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import { CashCountMode, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import {
  APPROVAL_COMMANDS,
  ApprovalDecisionConflictError,
  ApprovalDecisionRejectedError,
  ApprovalNotPendingError,
  ApprovalRequestConflictError,
  ApproverNotPermittedError,
} from '../../governance/contract';
import type { ApprovalCommands } from '../../governance/contract';
import type { VerifiedTerminalPrincipal } from '../../identity/contract';
import {
  CASH_SESSION_TENDER_TOTALS_QUERY,
  DAILY_TRADING_SALES_QUERY,
} from '../../sales/contract';
import type {
  CashSessionTenderTotalsQuery,
  DailyTradingSalesQuery,
} from '../../sales/contract';
import { CashClosePolicyResolver } from '../cash-close-policy/cash-close-policy.resolver';
import {
  CASH_MOVEMENT_TOTALS_QUERY,
  CASH_VARIANCE_DETECTED_EVENT_TYPE,
  CASH_VARIANCE_DETECTED_EVENT_VERSION,
} from '../contract';
import type {
  CashMovementTotalsQuery,
  CashVarianceDetectedPayload,
} from '../contract';
import { TREASURY_PERMISSIONS } from '../treasury.permissions';

const LOCK_KEY = 'ros_cash_session';

export interface CloseActor {
  readonly employeeId: string;
  readonly terminalId: string;
}

interface DenominationInput {
  readonly denominationMinorUnits: string;
  readonly quantity: number;
}

export interface DeclareCloseInput {
  readonly cashSessionId: string;
  readonly closeAttemptId: string;
  readonly countedTotalMinorUnits?: string;
  readonly denominations?: readonly DenominationInput[];
}

export interface FinalizeCloseInput {
  readonly cashSessionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reason: string;
  readonly comment?: string;
}

/** Structurally zero at this HEAD (design gate §6) — never invented as non-zero. */
const CASH_TIPS_TOTAL = 0n;
const CASH_REFUNDS_TOTAL = 0n;

@Injectable()
export class CashSessionCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly policyResolver: CashClosePolicyResolver,
    @Inject(CASH_MOVEMENT_TOTALS_QUERY)
    private readonly movementTotals: CashMovementTotalsQuery,
    @Inject(CASH_SESSION_TENDER_TOTALS_QUERY)
    private readonly tenderTotals: CashSessionTenderTotalsQuery,
    @Inject(APPROVAL_COMMANDS)
    private readonly approvals: ApprovalCommands,
    /**
     * Migration 35 (DayClose, DC-R2) — `currentBusinessDay` is the SAME
     * authoritative `resolveBusinessDay`/`cutoverLookup` implementation
     * Order creation and Reporting already share. Used ONLY to derive
     * `closed_business_day` at the CLOSED transition, from the live clock,
     * inside this SAME transaction — NEVER re-derived historically.
     */
    @Inject(DAILY_TRADING_SALES_QUERY)
    private readonly businessDayQuery: DailyTradingSalesQuery,
  ) {}

  // ============================================================ CONTEXT ===

  /**
   * `GET /cash-sessions/{id}/close-context` — read-only, no lock (nothing is
   * mutated; `declareClose` re-resolves everything fresh under the lock, so
   * a stale read here can never corrupt a close).
   *
   * `open` + blind: expected-cash fields are ABSENT from the response
   * object entirely (not present as keys, never merely `null`) — the
   * central FR-POS-095 [M] control. `open` + open-mode: included, if a
   * policy is configured (a preview only; not authoritative).
   * `closing`/`closed`: the count was already legitimately disclosed by
   * `declareClose`'s own response, so re-showing it here leaks nothing new.
   */
  async getCloseContext(
    tenantId: string,
    actor: CloseActor,
    permissions: ReadonlySet<string>,
    cashSessionId: string,
  ) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const session = await this.loadSession(tx, cashSessionId);
      this.assertCloseAuthority(session, actor, permissions);

      if (session.status === 'open') {
        // Acceptance closure correction: ONE policy resolve, not two, and
        // `toleranceMinorUnits` is now included in EITHER mode — the
        // accepted design table (final design gate §11: "BLIND / OPEN MODE
        // AND LEAK AUDIT") lists `countMode`/`currency`/`openingFloat`/
        // `toleranceMinorUnits` as ✅ in BOTH blind and open mode; ONLY
        // `expectedCash` and the formula breakdown are blind-mode-omitted.
        // A configured tolerance is a POLICY fact (what threshold triggers
        // approval), not a VARIANCE fact (what the count reveals) — FR-POS-095
        // protects the latter, not the former.
        const policy = await this.policyResolver.resolve(tx, {
          tenantId,
          branchId: session.branchId,
          asOf: session.openedAt,
        });
        const countMode = policy?.countMode ?? 'blind';
        const base = {
          cashSessionId: session.id,
          status: session.status,
          countMode,
          currency: session.currency,
          openingFloatMinorUnits: session.openingFloat.toString(),
          ...(policy
            ? {
                toleranceMinorUnits:
                  policy.varianceToleranceMinorUnits.toString(),
              }
            : {}),
        };
        if (countMode !== 'open') {
          // BLIND (or no policy at all) — expectedCash/breakdown are
          // structurally absent, not null.
          return base;
        }
        const facts = await this.computeExpectedCash(tx, tenantId, session);
        return {
          ...base,
          expectedCashMinorUnits: facts.expectedCash.toString(),
        };
      }

      // `closing` / `closed` — the attempt is committed; disclosure already
      // legitimately happened at `declareClose` time.
      const attempt = await tx.cashSessionCloseAttempt.findUniqueOrThrow({
        where: { id: session.closeAttemptId! },
      });
      return {
        cashSessionId: session.id,
        status: session.status,
        countMode: attempt.countMode,
        currency: session.currency,
        openingFloatMinorUnits: session.openingFloat.toString(),
        toleranceMinorUnits: attempt.toleranceMinorUnits.toString(),
        expectedCashMinorUnits: attempt.expectedCash.toString(),
        countedCashMinorUnits: attempt.countedCash.toString(),
        varianceMinorUnits: attempt.variance.toString(),
        approvalRequired: attempt.approvalRequired,
        closedAt: session.closedAt,
      };
    });
  }

  // ========================================================== DECLARE ====

  async declareClose(
    tenantId: string,
    actorUserId: string,
    actor: CloseActor,
    permissions: ReadonlySet<string>,
    input: DeclareCloseInput,
  ) {
    const denominations = this.parseDenominations(input.denominations);
    const declaredTotal = this.resolveCountedTotal(
      input.countedTotalMinorUnits,
      denominations,
    );

    return this.unitOfWork.execute(
      { userId: actorUserId, tenantId },
      async (ctx: UnitOfWorkContext) => {
        const tx = ctx.tx;
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          LOCK_KEY,
          input.cashSessionId,
        );

        // ── Permanent-id replay, LOGICALLY FIRST (P1E-5A pattern). ────────
        const existingAttempt = await tx.cashSessionCloseAttempt.findUnique({
          where: { id: input.closeAttemptId },
        });
        if (existingAttempt) {
          if (
            existingAttempt.cashSessionId !== input.cashSessionId ||
            existingAttempt.countedCash !== declaredTotal
          ) {
            throw new ConflictException(
              'That closeAttemptId already exists with different content. A ' +
                'client-generated identifier is permanent (FR-OFF-015).',
            );
          }
          const session = await this.loadSession(tx, input.cashSessionId);
          return this.buildDeclareResult(session, existingAttempt, false);
        }

        const session = await this.loadSession(tx, input.cashSessionId);
        this.assertCloseAuthority(session, actor, permissions);
        if (session.status !== 'open') {
          throw new ConflictException(
            'That cash session is not open — a close is already declared or ' +
              'the session is already closed.',
          );
        }

        // ── R-3(a): policy pinned at OPEN time, resolved lazily here. ─────
        const policy = await this.policyResolver.resolve(tx, {
          tenantId,
          branchId: session.branchId,
          asOf: session.openedAt,
        });
        if (!policy) {
          throw new ConflictException(
            'No cash-close policy is configured for this branch as of when ' +
              'the session opened. A settings.branch.manage holder must ' +
              'configure one before this session can be closed.',
          );
        }
        if (policy.currency !== session.currency) {
          throw new ConflictException(
            'The configured cash-close policy is denominated in a ' +
              'different currency than this cash session.',
          );
        }

        const facts = await this.computeExpectedCash(tx, tenantId, session);
        const variance = declaredTotal - facts.expectedCash;
        const approvalRequired =
          variance > policy.varianceToleranceMinorUnits ||
          variance < -policy.varianceToleranceMinorUnits;

        const attemptRow = await tx.$queryRaw<
          {
            id: string;
            cashSessionId: string;
            expectedCash: bigint;
            countedCash: bigint;
            variance: bigint;
            currency: string;
            countMode: CashCountMode;
            toleranceMinorUnits: bigint;
            approvalRequired: boolean;
            declaredAt: Date;
          }[]
        >`
          INSERT INTO "treasury"."cash_session_close_attempts" (
            "id", "tenant_id", "branch_id", "cash_session_id",
            "policy_version_id", "tolerance_minor_units", "count_mode",
            "opening_float", "cash_sales_total", "cash_tips_total", "pay_in_total",
            "cash_refunds_total", "pay_out_total", "safe_drop_total", "cash_rounding_adjustments",
            "expected_cash", "counted_cash", "variance", "currency", "approval_required",
            "declared_by_employee_id", "declared_by_user_id", "terminal_id", "declared_at"
          ) VALUES (
            ${input.closeAttemptId}::uuid, ${tenantId}::uuid, ${session.branchId}::uuid, ${session.id}::uuid,
            ${policy.policyVersionId}::uuid, ${policy.varianceToleranceMinorUnits}, ${policy.countMode}::"treasury"."CashCountMode",
            ${facts.openingFloat}, ${facts.cashSalesTotal}, ${CASH_TIPS_TOTAL}, ${facts.payInTotal},
            ${CASH_REFUNDS_TOTAL}, ${facts.payOutTotal}, ${facts.safeDropTotal}, ${facts.cashRoundingAdjustments},
            ${facts.expectedCash}, ${declaredTotal}, ${variance}, ${session.currency}, ${approvalRequired},
            ${actor.employeeId}::uuid, ${actorUserId}::uuid, ${actor.terminalId}::uuid, statement_timestamp()
          )
          RETURNING
            "id", "cash_session_id" AS "cashSessionId",
            "expected_cash" AS "expectedCash", "counted_cash" AS "countedCash",
            "variance", "currency", "count_mode" AS "countMode",
            "tolerance_minor_units" AS "toleranceMinorUnits",
            "approval_required" AS "approvalRequired", "declared_at" AS "declaredAt"
        `;
        const attempt = attemptRow[0];

        for (const d of denominations) {
          await tx.$executeRaw`
            INSERT INTO "treasury"."cash_count_denominations" (
              "tenant_id", "close_attempt_id", "denomination_minor_units", "quantity"
            ) VALUES (
              ${tenantId}::uuid, ${input.closeAttemptId}::uuid, ${d.denominationMinorUnits}, ${d.quantity}
            )
          `;
        }

        // ── FR-AUD-001/006 ("cash variances" SHALL always be audited) — ───
        // acceptance closure correction. Written exactly once, here, for
        // EVERY newly created attempt (both the within-tolerance and
        // above-tolerance paths) — never on the permanent-id replay branch
        // above, which returns before reaching this statement. A frozen
        // (closing) session may sit unresolved, or be rejected and retried,
        // for an unbounded time before any CASH_SESSION_CLOSED entry exists;
        // the variance itself must not wait for that to be durably audited.
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CASH_VARIANCE_DECLARED,
          entityType: AUDIT_ENTITY.CASH_SESSION,
          actorType: 'user',
          actorId: actorUserId,
          entityId: session.id,
          terminalId: actor.terminalId,
          metadata: this.varianceAuditMetadata(
            session.id,
            attempt,
            facts,
            policy.policyVersionId,
            actor.employeeId,
          ),
        });

        // ── SRS §5.5.4 `cash.variance.detected` (Treasury -> Governance,
        // Analytics) — acceptance closure correction. Published in the SAME
        // transaction as the attempt INSERT (§5.5.2), so a rollback drops
        // both together; never on a permanent-id replay (no new fact to
        // announce). The idempotency key is the attempt's own permanent id —
        // the same FR-OFF-015 identity a genuine replay is keyed on, so a
        // replayed HTTP request can never cause a second logical event even
        // if some future producer keyed handler idempotency off of it.
        const variancePayload: CashVarianceDetectedPayload = {
          cashSessionId: session.id,
          closeAttemptId: attempt.id,
          policyVersionId: policy.policyVersionId,
          countMode: attempt.countMode,
          currency: attempt.currency,
          toleranceMinorUnits: attempt.toleranceMinorUnits.toString(),
          openingFloatMinorUnits: facts.openingFloat.toString(),
          cashSalesTotalMinorUnits: facts.cashSalesTotal.toString(),
          cashTipsTotalMinorUnits: CASH_TIPS_TOTAL.toString(),
          payInTotalMinorUnits: facts.payInTotal.toString(),
          cashRefundsTotalMinorUnits: CASH_REFUNDS_TOTAL.toString(),
          payOutTotalMinorUnits: facts.payOutTotal.toString(),
          safeDropTotalMinorUnits: facts.safeDropTotal.toString(),
          cashRoundingAdjustmentsMinorUnits:
            facts.cashRoundingAdjustments.toString(),
          expectedCashMinorUnits: attempt.expectedCash.toString(),
          countedCashMinorUnits: attempt.countedCash.toString(),
          varianceMinorUnits: attempt.variance.toString(),
          approvalRequired: attempt.approvalRequired,
          declaredByEmployeeId: actor.employeeId,
          declaredByUserId: actorUserId,
          terminalId: actor.terminalId,
          declaredAt: attempt.declaredAt.toISOString(),
        };
        ctx.publishEvent({
          eventType: CASH_VARIANCE_DETECTED_EVENT_TYPE,
          eventVersion: CASH_VARIANCE_DETECTED_EVENT_VERSION,
          occurredAt: attempt.declaredAt,
          branchId: session.branchId,
          actorId: actorUserId,
          actorType: 'user',
          idempotencyKey: `cash.variance.detected:${attempt.id}`,
          payload: variancePayload,
        });

        if (approvalRequired) {
          await tx.$executeRaw`
            UPDATE "treasury"."cash_sessions"
            SET "close_attempt_id" = ${input.closeAttemptId}::uuid,
                "status" = 'closing'::"treasury"."CashSessionStatus"
            WHERE "tenant_id" = ${tenantId}::uuid AND "id" = ${session.id}::uuid
          `;
          const updated = await this.loadSession(tx, session.id);
          return this.buildDeclareResult(updated, attempt, true);
        }

        // Within tolerance — the ONE-REQUEST fast path. Close now.
        const closedAt = new Date();
        const closedBusinessDay =
          await this.businessDayQuery.currentBusinessDay(tx, {
            tenantId,
            branchId: session.branchId,
          });
        await tx.$executeRaw`
          UPDATE "treasury"."cash_sessions"
          SET "close_attempt_id" = ${input.closeAttemptId}::uuid,
              "status" = 'closed'::"treasury"."CashSessionStatus",
              "expected_cash" = ${attempt.expectedCash},
              "counted_cash" = ${attempt.countedCash},
              "variance" = ${attempt.variance},
              "closed_at" = ${closedAt}::timestamptz,
              "closed_by_user_id" = ${actorUserId}::uuid,
              "closed_by_employee_id" = ${actor.employeeId}::uuid,
              "closed_business_day" = ${closedBusinessDay}::date
          WHERE "tenant_id" = ${tenantId}::uuid AND "id" = ${session.id}::uuid
        `;
        const updated = await this.loadSession(tx, session.id);

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CASH_SESSION_CLOSED,
          entityType: AUDIT_ENTITY.CASH_SESSION,
          actorType: 'user',
          actorId: actorUserId,
          entityId: session.id,
          terminalId: actor.terminalId,
          metadata: this.closedAuditMetadata(session.id, attempt, null),
        });

        return this.buildDeclareResult(updated, attempt, true);
      },
    );
  }

  // ========================================================== FINALIZE ===

  async finalizeClose(
    tenantId: string,
    actorUserId: string,
    actor: CloseActor,
    permissions: ReadonlySet<string>,
    approver: VerifiedTerminalPrincipal,
    input: FinalizeCloseInput,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          LOCK_KEY,
          input.cashSessionId,
        );

        const session = await this.loadSession(tx, input.cashSessionId);
        this.assertCloseAuthority(session, actor, permissions);

        // ── Idempotent-replay of an ALREADY-APPROVED finalize. ────────────
        if (session.status === 'closed') {
          if (session.approvalRequestId === input.approvalRequestId) {
            return this.buildFinalizeResult(session, 'closed');
          }
          throw new ConflictException(
            'That cash session is already closed under a different approval request.',
          );
        }
        if (session.status !== 'closing') {
          throw new ConflictException(
            'That cash session has no pending close awaiting a decision.',
          );
        }

        const attempt = await tx.cashSessionCloseAttempt.findUniqueOrThrow({
          where: { id: session.closeAttemptId! },
        });

        // ── FR-SEC-016 fail-closed: the owner MUST have a linked User. ────
        const owner = await tx.employee.findUniqueOrThrow({
          where: { id: session.employeeId },
          select: { userId: true },
        });
        if (!owner.userId) {
          throw new ConflictException(
            "The session owner's Employee record has no linked Identity " +
              'User, so self-approval cannot be enforced. This close cannot ' +
              'be finalised until that link exists.',
          );
        }
        const ownerUserId: string = owner.userId;

        // ── R-3(a): the SAME deterministic version the attempt itself was
        // declared against — resolved by (tenant, branch, session.openedAt),
        // never by the attempt's stored `policyVersionId` directly (there is
        // no lookup-by-id method; re-resolving the identical historical
        // instant is guaranteed by the resolver's own determinism to return
        // the identical row — see its docblock).
        const policy = await this.policyResolver.resolve(tx, {
          tenantId,
          branchId: session.branchId,
          asOf: session.openedAt,
        });
        if (!policy || policy.policyVersionId !== attempt.policyVersionId) {
          throw new ConflictException(
            'The cash-close policy that governed this session could not be ' +
              're-resolved identically. This close cannot be finalised.',
          );
        }

        // ── R-4(a) / final acceptance closure §2: expiry base is a DB ─────
        // statement instant, read here — never transaction_timestamp(),
        // never an application clock.
        const [{ now: dbNow }] = await tx.$queryRaw<{ now: Date }[]>`
          SELECT statement_timestamp() AS "now"
        `;
        const expiresAt = new Date(
          dbNow.getTime() + policy.varianceApprovalExpirySeconds * 1000,
        );

        const value: Prisma.InputJsonValue = {
          cashSessionId: session.id,
          closeAttemptId: attempt.id,
          expectedCashMinorUnits: attempt.expectedCash.toString(),
          countedCashMinorUnits: attempt.countedCash.toString(),
          varianceMinorUnits: attempt.variance.toString(),
          toleranceMinorUnits: attempt.toleranceMinorUnits.toString(),
          currency: attempt.currency,
          countMode: attempt.countMode,
          policyVersionId: attempt.policyVersionId,
          reason: input.reason,
        };

        try {
          await this.approvals.createRequest(tx, tenantId, actorUserId, {
            id: input.approvalRequestId,
            requestType: 'cash.variance',
            entityType: AUDIT_ENTITY.CASH_SESSION,
            entityId: session.id,
            requiredPermission: TREASURY_PERMISSIONS.CASH_VARIANCE_APPROVE,
            value,
            expiresAt,
            excludedApproverUserId: ownerUserId,
          });
        } catch (error) {
          if (error instanceof ApprovalRequestConflictError) {
            throw new ConflictException(error.message);
          }
          throw error;
        }

        let decisionResult;
        try {
          decisionResult = await this.approvals.decide(tx, tenantId, {
            id: input.approvalDecisionId,
            approvalRequestId: input.approvalRequestId,
            decision: input.decision,
            comment: input.comment,
            approver,
          });
        } catch (error) {
          if (
            error instanceof ApprovalDecisionRejectedError ||
            error instanceof ApproverNotPermittedError
          ) {
            throw new ForbiddenException(error.message);
          }
          if (
            error instanceof ApprovalDecisionConflictError ||
            error instanceof ApprovalNotPendingError
          ) {
            throw new ConflictException(error.message);
          }
          throw error;
        }

        if (decisionResult.decision.decision === 'rejected') {
          // R-6(a): COMMIT the rejection. Never throw here — that would
          // roll back the immutable ApprovalDecision FR-SEC-033 requires.
          // The session is deliberately left untouched, still `closing`.
          return this.buildFinalizeResult(session, 'rejected');
        }

        // ── APPROVED — close now, from the immutable attempt. ─────────────
        const closedAt = new Date();
        const closedBusinessDay =
          await this.businessDayQuery.currentBusinessDay(tx, {
            tenantId,
            branchId: session.branchId,
          });
        await tx.$executeRaw`
          UPDATE "treasury"."cash_sessions"
          SET "status" = 'closed'::"treasury"."CashSessionStatus",
              "expected_cash" = ${attempt.expectedCash},
              "counted_cash" = ${attempt.countedCash},
              "variance" = ${attempt.variance},
              "variance_reason" = ${input.reason},
              "approval_request_id" = ${input.approvalRequestId}::uuid,
              "closed_at" = ${closedAt}::timestamptz,
              "closed_by_user_id" = ${actorUserId}::uuid,
              "closed_by_employee_id" = ${actor.employeeId}::uuid,
              "closed_business_day" = ${closedBusinessDay}::date
          WHERE "tenant_id" = ${tenantId}::uuid AND "id" = ${session.id}::uuid
        `;
        const closedSession = await this.loadSession(tx, session.id);

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CASH_SESSION_CLOSED,
          entityType: AUDIT_ENTITY.CASH_SESSION,
          actorType: 'user',
          actorId: actorUserId,
          entityId: session.id,
          terminalId: actor.terminalId,
          approverId: approver.userId,
          approvalId: input.approvalRequestId,
          metadata: this.closedAuditMetadata(
            session.id,
            attempt,
            input.approvalRequestId,
          ),
        });

        return this.buildFinalizeResult(closedSession, 'closed');
      },
    );
  }

  // ------------------------------------------------------------- internals

  private async loadSession(
    tx: Prisma.TransactionClient,
    cashSessionId: string,
  ) {
    const session = await tx.cashSession.findUnique({
      where: { id: cashSessionId },
      select: {
        id: true,
        branchId: true,
        employeeId: true,
        openingFloat: true,
        currency: true,
        status: true,
        openedAt: true,
        closedAt: true,
        closeAttemptId: true,
        expectedCash: true,
        countedCash: true,
        variance: true,
        varianceReason: true,
        approvalRequestId: true,
        closedByUserId: true,
        closedByEmployeeId: true,
        closedBusinessDay: true,
      },
    });
    if (!session) throw new NotFoundException('Cash session not found.');
    return session;
  }

  /**
   * §15.2's own/other split, enforced against the RESOLVED permission set
   * (guard-level `@RequireAnyPermission` only proves the actor holds AT
   * LEAST ONE of the two codes; this proves the SPECIFIC one their
   * relationship to the session requires).
   */
  private assertCloseAuthority(
    session: { employeeId: string },
    actor: CloseActor,
    permissions: ReadonlySet<string>,
  ): void {
    const isOwner = session.employeeId === actor.employeeId;
    const required = isOwner
      ? TREASURY_PERMISSIONS.CASH_SESSION_CLOSE
      : TREASURY_PERMISSIONS.CASH_SESSION_CLOSE_OTHER;
    if (!permissions.has(required)) {
      throw new ForbiddenException(
        isOwner
          ? "Closing your own cash session requires 'cash.session.close'."
          : "Closing another employee's cash session requires 'cash.session.close_other'.",
      );
    }
  }

  private async computeExpectedCash(
    tx: Prisma.TransactionClient,
    tenantId: string,
    session: { id: string; openingFloat: bigint },
  ) {
    const [movements, tenders] = await Promise.all([
      this.movementTotals.totalsForSession(tx, tenantId, session.id),
      this.tenderTotals.totalsForSession(tx, tenantId, session.id),
    ]);
    const openingFloat = session.openingFloat;
    const cashSalesTotal = tenders.cashSalesTotal;
    const payInTotal = movements.payInTotal;
    const payOutTotal = movements.payOutTotal;
    const safeDropTotal = movements.safeDropTotal;
    const cashRoundingAdjustments = tenders.cashRoundingAdjustments;
    const expectedCash =
      openingFloat +
      cashSalesTotal +
      CASH_TIPS_TOTAL +
      payInTotal -
      CASH_REFUNDS_TOTAL -
      payOutTotal -
      safeDropTotal +
      cashRoundingAdjustments;
    return {
      openingFloat,
      cashSalesTotal,
      payInTotal,
      payOutTotal,
      safeDropTotal,
      cashRoundingAdjustments,
      expectedCash,
    };
  }

  /** FR-POS-097: total OR denominations OR both (matching, no duplicates). */
  private resolveCountedTotal(
    countedTotalMinorUnits: string | undefined,
    denominations: readonly {
      denominationMinorUnits: bigint;
      quantity: number;
    }[],
  ): bigint {
    const explicit =
      countedTotalMinorUnits !== undefined
        ? this.parseMoney(countedTotalMinorUnits, 'countedTotalMinorUnits')
        : undefined;
    const summed =
      denominations.length > 0
        ? denominations.reduce(
            (sum, d) => sum + d.denominationMinorUnits * BigInt(d.quantity),
            0n,
          )
        : undefined;
    if (explicit === undefined && summed === undefined) {
      throw new BadRequestException(
        'At least one of countedTotalMinorUnits or denominations is required.',
      );
    }
    if (explicit !== undefined && summed !== undefined && explicit !== summed) {
      throw new BadRequestException(
        'countedTotalMinorUnits does not equal the sum of the supplied denominations.',
      );
    }
    return (explicit ?? summed)!;
  }

  private parseDenominations(
    input:
      | readonly { denominationMinorUnits: string; quantity: number }[]
      | undefined,
  ): { denominationMinorUnits: bigint; quantity: number }[] {
    if (!input) return [];
    const seen = new Set<string>();
    return input.map((d) => {
      if (seen.has(d.denominationMinorUnits)) {
        throw new BadRequestException(
          `Duplicate denomination ${d.denominationMinorUnits} — combine quantities into one entry.`,
        );
      }
      seen.add(d.denominationMinorUnits);
      return {
        denominationMinorUnits: this.parseMoney(
          d.denominationMinorUnits,
          'denominationMinorUnits',
        ),
        quantity: d.quantity,
      };
    });
  }

  private parseMoney(raw: string, field: string): bigint {
    if (!/^\d{1,18}$/.test(raw)) {
      throw new BadRequestException(
        `${field} must be a non-negative whole number of minor units expressed as a string.`,
      );
    }
    return BigInt(raw);
  }

  private buildDeclareResult(
    session: { id: string; status: string },
    attempt: {
      id: string;
      expectedCash: bigint;
      countedCash: bigint;
      variance: bigint;
      currency: string;
      countMode: CashCountMode;
      toleranceMinorUnits: bigint;
      approvalRequired: boolean;
    },
    justCreated: boolean,
  ) {
    return {
      cashSessionId: session.id,
      closeAttemptId: attempt.id,
      status: session.status,
      approvalRequired: attempt.approvalRequired,
      currency: attempt.currency,
      countMode: attempt.countMode,
      toleranceMinorUnits: attempt.toleranceMinorUnits.toString(),
      expectedCashMinorUnits: attempt.expectedCash.toString(),
      countedCashMinorUnits: attempt.countedCash.toString(),
      varianceMinorUnits: attempt.variance.toString(),
      created: justCreated,
    };
  }

  private buildFinalizeResult(
    session: { id: string; status: string },
    outcome: 'closed' | 'rejected',
  ) {
    return { cashSessionId: session.id, status: session.status, outcome };
  }

  private closedAuditMetadata(
    cashSessionId: string,
    attempt: {
      id: string;
      expectedCash: bigint;
      countedCash: bigint;
      variance: bigint;
      currency: string;
      countMode: CashCountMode;
      approvalRequired: boolean;
    },
    approvalRequestId: string | null,
  ) {
    return {
      cashSessionId,
      closeAttemptId: attempt.id,
      expectedCashMinorUnits: attempt.expectedCash.toString(),
      countedCashMinorUnits: attempt.countedCash.toString(),
      varianceMinorUnits: attempt.variance.toString(),
      currency: attempt.currency,
      countMode: attempt.countMode,
      approvalRequired: attempt.approvalRequired,
      approvalRequestId,
    };
  }

  /** FR-AUD-002's field set for the `CASH_VARIANCE_DECLARED` action — the
   *  full 8-term formula breakdown, not merely the resulting figures, so the
   *  entry is self-sufficient evidence without a join to the (still
   *  immutable, but separately-tabled) close attempt row. */
  private varianceAuditMetadata(
    cashSessionId: string,
    attempt: {
      id: string;
      expectedCash: bigint;
      countedCash: bigint;
      variance: bigint;
      currency: string;
      countMode: CashCountMode;
      toleranceMinorUnits: bigint;
      approvalRequired: boolean;
    },
    facts: {
      openingFloat: bigint;
      cashSalesTotal: bigint;
      payInTotal: bigint;
      payOutTotal: bigint;
      safeDropTotal: bigint;
      cashRoundingAdjustments: bigint;
    },
    policyVersionId: string,
    declaredByEmployeeId: string,
  ) {
    return {
      cashSessionId,
      closeAttemptId: attempt.id,
      policyVersionId,
      countMode: attempt.countMode,
      currency: attempt.currency,
      toleranceMinorUnits: attempt.toleranceMinorUnits.toString(),
      openingFloatMinorUnits: facts.openingFloat.toString(),
      cashSalesTotalMinorUnits: facts.cashSalesTotal.toString(),
      cashTipsTotalMinorUnits: CASH_TIPS_TOTAL.toString(),
      payInTotalMinorUnits: facts.payInTotal.toString(),
      cashRefundsTotalMinorUnits: CASH_REFUNDS_TOTAL.toString(),
      payOutTotalMinorUnits: facts.payOutTotal.toString(),
      safeDropTotalMinorUnits: facts.safeDropTotal.toString(),
      cashRoundingAdjustmentsMinorUnits:
        facts.cashRoundingAdjustments.toString(),
      expectedCashMinorUnits: attempt.expectedCash.toString(),
      countedCashMinorUnits: attempt.countedCash.toString(),
      varianceMinorUnits: attempt.variance.toString(),
      approvalRequired: attempt.approvalRequired,
      declaredByEmployeeId,
    };
  }
}
