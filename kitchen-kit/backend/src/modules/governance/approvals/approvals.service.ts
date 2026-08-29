/**
 * Governance Approval runtime — migration 32 (FR-SEC-030..033).
 *
 * Authority: docs/governance/GOVERNANCE_DECISION_REGISTER.md, "Approval
 * Runtime Minimum Resolution — 2026-08-29" (RATIFIED) +
 * docs/reports/claude/2026-08-29_APPROVAL_runtime-design-acceptance-closure.md
 * (CONTROLLING over the earlier design gate where they differ).
 *
 * Implements `ApprovalCommands` (`governance/contract/approval.contract.ts`).
 * PRIVATE — bound to `APPROVAL_COMMANDS` only inside `GovernanceModule`; a
 * consumer never imports this class.
 *
 * ── PERMANENT-ID PROTOCOL (both operations) — the P1E-5A / P1G-0 pattern ───
 * 1. Permanent-id replay/conflict check is LOGICALLY FIRST, before any other
 *    mutation. Existing + identical -> replay (zero new effect, no audit).
 *    Existing + differing -> typed conflict.
 * 2. Exactly ONE actual `INSERT ... ON CONFLICT DO NOTHING RETURNING ...`
 *    — never insert-then-catch-P2002, which leaves the transaction ABORTED
 *    for every subsequent statement (P1E-5A). `createRequest` targets
 *    `ON CONFLICT ("id")` (its table has exactly one relevant unique
 *    constraint); `decide` uses a BARE `ON CONFLICT DO NOTHING` — see
 *    "RLS REJECTION vs CONFLICT" below for why that distinction matters.
 * 3. If that INSERT returns zero rows (another transaction won the SAME
 *    permanent-id race between steps 1 and 2), SELECT the winner IN THE
 *    STILL-HEALTHY transaction: identical -> replay with NO duplicate
 *    audit; differing -> typed conflict.
 *
 * ── DECISION CARDINALITY — the SEPARATE per-request race ───────────────────
 * `decide`'s permanent-id protocol (above) resolves races on the DECISION's
 * own id. A DIFFERENT race exists on the REQUEST: two distinct decision ids
 * racing to be the ONE final decision for the same `approval_request_id`,
 * resolved by the DB `UNIQUE (tenant_id, approval_request_id)` constraint
 * (item 5 — a narrow, ratified amendment of D-15 clause 4, via clause 14).
 * A conflict on THAT constraint is unconditionally a conflict — never a
 * replay, even when the losing attempt's outcome happens to match the
 * winner's, because a distinct permanent id is a distinct business act.
 *
 * ── RLS REJECTION vs CONFLICT — two different failure shapes ───────────────
 * The bare `ON CONFLICT DO NOTHING` on the decision INSERT catches ONLY the
 * two UNIQUE constraints (id, and the per-request one) — see step 2 above.
 * The four-conjunct RLS `WITH CHECK` (tenant / requester != approver /
 * unexpired / excluded-approver != approver) is a DIFFERENT PostgreSQL
 * mechanism: a genuine policy violation RAISES an exception mid-statement
 * (empirically verified: `PrismaClientKnownRequestError` code `P2010`,
 * underlying SQLSTATE `42501`), which is not something `ON CONFLICT` can or
 * should suppress — it is not a race outcome to resolve, it is a
 * definitively illegal decision. There is no "recovery" step for it: the
 * whole transaction rolls back, which is exactly correct (§9 of the design
 * gate proves decision+status can never diverge for precisely this reason).
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UUID_PATTERN } from '../../../common/ids';
import {
  ApprovalDecision,
  ApprovalRequest,
  Prisma,
} from '../../../generated/prisma/client';
import { AUDIT_ACTION, AUDIT_ENTITY } from '../audit/audit.constants';
import { AuditService } from '../audit/audit.service';
import { stableStringify } from '../audit/audit-hash';
import {
  ApprovalCommands,
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  CreateApprovalRequestCommand,
  CreateApprovalRequestResult,
  DecideApprovalCommand,
  DecideApprovalResult,
} from '../contract/approval.contract';
import {
  ApprovalDecisionConflictError,
  ApprovalDecisionRejectedError,
  ApprovalNotPendingError,
  ApprovalRequestConflictError,
  ApproverNotPermittedError,
} from '../contract/approval.errors';

/**
 * `PrismaClientKnownRequestError` (raw-query code `P2010`) whose underlying
 * driver cause is Postgres SQLSTATE `42501` ("insufficient_privilege" —
 * the code an RLS `WITH CHECK` violation raises). Matched defensively on
 * BOTH the structured `meta` shape (verified empirically against this exact
 * repository's Prisma/driver-adapter version) and the message text, so a
 * future driver-adapter upgrade that changes the `meta` shape still degrades
 * to a correct classification rather than a silent miscategorisation.
 */
function isRowLevelSecurityViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const meta = err.meta as
    { driverAdapterError?: { cause?: { originalCode?: string } } } | undefined;
  const originalCode = meta?.driverAdapterError?.cause?.originalCode;
  return (
    originalCode === '42501' || /row-level security policy/i.test(err.message)
  );
}

function assertUuid(label: string, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException(
      `${label} must be a ULID rendered as a UUID.`,
    );
  }
}

function assertNonBlank(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new BadRequestException(`${label} must not be blank.`);
  }
}

/**
 * The DB `ck_approval_request_status` CHECK constraint is the sole source of
 * truth for this value set — Prisma types the plain-`VARCHAR` column as
 * `string` (deliberately not a Postgres enum, to match the migration's own
 * CHECK-based approach). Narrowing here is a type-level formality backed by
 * that constraint, not a runtime validation gap.
 */
function toRequestRecord(row: ApprovalRequest): ApprovalRequestRecord {
  return { ...row, status: row.status as ApprovalRequestRecord['status'] };
}

/** Same rationale as {@link toRequestRecord}, for `ck_approval_decision_value`. */
function toDecisionRecord(row: ApprovalDecision): ApprovalDecisionRecord {
  return {
    ...row,
    decision: row.decision as ApprovalDecisionRecord['decision'],
  };
}

@Injectable()
export class ApprovalsService implements ApprovalCommands {
  constructor(private readonly audit: AuditService) {}

  async createRequest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requestedByUserId: string,
    command: CreateApprovalRequestCommand,
  ): Promise<CreateApprovalRequestResult> {
    assertUuid('id', command.id);
    assertUuid('entityId', command.entityId);
    if (command.excludedApproverUserId !== undefined) {
      assertUuid('excludedApproverUserId', command.excludedApproverUserId);
    }
    assertNonBlank('requestType', command.requestType);
    assertNonBlank('entityType', command.entityType);
    assertNonBlank('requiredPermission', command.requiredPermission);
    if (
      !(command.expiresAt instanceof Date) ||
      Number.isNaN(command.expiresAt.getTime())
    ) {
      throw new BadRequestException('expiresAt must be a valid Date.');
    }

    const expected = {
      tenantId,
      requestType: command.requestType,
      entityType: command.entityType,
      entityId: command.entityId,
      requestedBy: requestedByUserId,
      requiredPermission: command.requiredPermission,
      value: command.value,
      expiresAt: command.expiresAt,
      excludedApproverUserId: command.excludedApproverUserId ?? null,
    };

    // ── STEP 1 — permanent-id replay/conflict check, LOGICALLY FIRST. ──────
    const existing = await tx.approvalRequest.findUnique({
      where: { id: command.id },
    });
    if (existing) {
      this.assertIdenticalRequest(existing, expected);
      return { request: toRequestRecord(existing), created: false };
    }

    // ── STEP 2 — exactly ONE actual INSERT, concurrency-safe. ──────────────
    const inserted = await tx.$queryRaw<ApprovalRequest[]>`
      INSERT INTO "governance"."approval_requests" (
        "id", "tenant_id", "request_type", "entity_type", "entity_id",
        "requested_by", "required_permission", "value", "expires_at",
        "excluded_approver_user_id", "status"
      ) VALUES (
        ${command.id}::uuid, ${tenantId}::uuid, ${command.requestType},
        ${command.entityType}, ${command.entityId}::uuid,
        ${requestedByUserId}::uuid, ${command.requiredPermission},
        ${JSON.stringify(command.value)}::jsonb, ${command.expiresAt}::timestamptz,
        ${command.excludedApproverUserId ?? null}::uuid, 'pending'
      )
      ON CONFLICT ("id") DO NOTHING
      RETURNING
        "id", "tenant_id" AS "tenantId", "request_type" AS "requestType",
        "entity_type" AS "entityType", "entity_id" AS "entityId",
        "requested_by" AS "requestedBy",
        "required_permission" AS "requiredPermission", "value",
        "expires_at" AS "expiresAt",
        "excluded_approver_user_id" AS "excludedApproverUserId", "status",
        "created_at" AS "createdAt"
    `;

    if (inserted.length === 0) {
      // ── STEP 3 — lost the permanent-id race. SELECT the winner in the
      // STILL-HEALTHY transaction (ON CONFLICT resolved its own conflict
      // internally — no exception was raised, so the transaction is fine).
      const winner = await tx.approvalRequest.findUnique({
        where: { id: command.id },
      });
      if (!winner) {
        throw new Error(
          `ApprovalRequest insert conflicted for id ${command.id} but no row is visible afterwards.`,
        );
      }
      this.assertIdenticalRequest(winner, expected);
      // NO duplicate audit — this transaction did not create the row.
      return { request: toRequestRecord(winner), created: false };
    }

    const request = inserted[0];

    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.APPROVAL_REQUEST_CREATED,
      entityType: AUDIT_ENTITY.APPROVAL_REQUEST,
      actorType: 'user',
      actorId: requestedByUserId,
      entityId: request.id,
      approvalId: request.id,
      metadata: {
        requestType: request.requestType,
        entityType: request.entityType,
        entityId: request.entityId,
        requiredPermission: request.requiredPermission,
        expiresAt: request.expiresAt.toISOString(),
        excludedApproverUserId: request.excludedApproverUserId,
      },
    });

    return { request: toRequestRecord(request), created: true };
  }

  async decide(
    tx: Prisma.TransactionClient,
    tenantId: string,
    command: DecideApprovalCommand,
  ): Promise<DecideApprovalResult> {
    assertUuid('id', command.id);
    assertUuid('approvalRequestId', command.approvalRequestId);

    const approverId = command.approver.userId;
    const expectedDecision = {
      tenantId,
      approvalRequestId: command.approvalRequestId,
      approverId,
      decision: command.decision,
      comment: command.comment ?? null,
    };

    // ── STEP 1 — same permanent decision id, LOGICALLY FIRST. ──────────────
    const sameId = await tx.approvalDecision.findUnique({
      where: { id: command.id },
    });
    if (sameId) {
      this.assertIdenticalDecision(sameId, expectedDecision);
      return { decision: toDecisionRecord(sameId), created: false };
    }

    // ── A DIFFERENT decision id already final for this request is ALWAYS a
    // conflict, checked before we ever attempt an INSERT — never a replay,
    // even if the outcome happens to match (a distinct id is a distinct
    // business act; see the module docblock).
    const existingForRequest = await tx.approvalDecision.findFirst({
      where: { tenantId, approvalRequestId: command.approvalRequestId },
    });
    if (existingForRequest) {
      throw new ApprovalDecisionConflictError(
        'That approval request already has a final decision.',
      );
    }

    const request = await tx.approvalRequest.findFirst({
      where: { id: command.approvalRequestId, tenantId },
    });
    if (!request) {
      throw new NotFoundException('Approval request not found.');
    }
    if (request.status !== 'pending') {
      throw new ApprovalNotPendingError(
        `Approval request ${request.id} is already ${request.status}.`,
      );
    }
    if (!command.approver.permissions.has(request.requiredPermission)) {
      throw new ApproverNotPermittedError(
        `The approver does not hold the required permission '${request.requiredPermission}'.`,
      );
    }

    // ── STEP 2 — exactly ONE actual INSERT, concurrency-safe. `approval_
    // decisions` carries TWO unique constraints — the `id` PK and
    // `uq_approval_decision_per_request` (tenant_id, approval_request_id).
    // A DELIBERATELY BARE `ON CONFLICT DO NOTHING` (no target list) is
    // required: `ON CONFLICT ("id") DO NOTHING` suppresses ONLY a violation
    // of the id PK — it does NOT catch a violation of the OTHER unique
    // constraint, which raises an unhandled `23505` instead of the silent
    // zero-row outcome step 3 below depends on. This was found and fixed by
    // the mandatory real-Postgres two-manager race test (scenario 1): two
    // DIFFERENT (fresh) decision ids racing the SAME request conflict only
    // on the per-request constraint, never on `id`, and a targeted
    // `ON CONFLICT ("id")` let that violation escape as a raised exception.
    // A genuinely illegal decision (self-approval / excluded approver /
    // expired) is a SEPARATE, real RLS exception, not a zero-row outcome —
    // see isRowLevelSecurityViolation.
    let inserted: ApprovalDecision[];
    try {
      inserted = await tx.$queryRaw<ApprovalDecision[]>`
        INSERT INTO "governance"."approval_decisions" (
          "id", "tenant_id", "approval_request_id", "approver_id", "decision", "comment"
        ) VALUES (
          ${command.id}::uuid, ${tenantId}::uuid, ${command.approvalRequestId}::uuid,
          ${approverId}::uuid, ${command.decision}, ${command.comment ?? null}
        )
        ON CONFLICT DO NOTHING
        RETURNING
          "id", "tenant_id" AS "tenantId",
          "approval_request_id" AS "approvalRequestId",
          "approver_id" AS "approverId", "decision", "comment",
          "decided_at" AS "decidedAt", "created_at" AS "createdAt"
      `;
    } catch (err) {
      if (isRowLevelSecurityViolation(err)) {
        throw new ApprovalDecisionRejectedError(
          'This decision was rejected by the database: the approver is the ' +
            'requester, the excluded approver, or the request has expired.',
        );
      }
      throw err;
    }

    if (inserted.length === 0) {
      // ── STEP 3 — lost the SAME-decision-id race between steps 1 and 2.
      // SELECT the winner in the STILL-HEALTHY transaction (ON CONFLICT
      // resolved the conflict internally — no exception was raised).
      const winner = await tx.approvalDecision.findUnique({
        where: { id: command.id },
      });
      if (!winner) {
        // The per-request UNIQUE also routes through this same
        // ON-CONFLICT-DO-NOTHING clause: a concurrent DIFFERENT decision id
        // for the SAME request could win it here too. Distinguish exactly
        // as required — never replay merely because the outcome matches.
        const requestWinner = await tx.approvalDecision.findFirst({
          where: { tenantId, approvalRequestId: command.approvalRequestId },
        });
        if (requestWinner) {
          throw new ApprovalDecisionConflictError(
            'That approval request already has a final decision.',
          );
        }
        throw new Error(
          `ApprovalDecision insert conflicted for id ${command.id} but no row is visible afterwards.`,
        );
      }
      this.assertIdenticalDecision(winner, expectedDecision);
      // NO duplicate audit, NO CAS update — this transaction did not create
      // the row, so the request's status transition already happened (or
      // is happening) on the transaction that DID create it.
      return { decision: toDecisionRecord(winner), created: false };
    }

    const decision = inserted[0];
    const nextStatus = command.decision; // 'approved' | 'rejected'

    // ── D-9 U4 CAS — the ONLY legal request transition, asserted. ──────────
    const updateResult = await tx.approvalRequest.updateMany({
      where: { id: request.id, tenantId, status: 'pending' },
      data: { status: nextStatus },
    });
    if (updateResult.count !== 1) {
      throw new Error(
        `CAS status update affected ${updateResult.count} rows for approval ` +
          `request ${request.id}; expected exactly 1. The enclosing ` +
          'transaction must roll back.',
      );
    }

    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.APPROVAL_DECISION_RECORDED,
      entityType: AUDIT_ENTITY.APPROVAL_DECISION,
      actorType: 'user',
      actorId: approverId,
      entityId: decision.id,
      approvalId: request.id,
      approverId,
      metadata: {
        approvalRequestId: decision.approvalRequestId,
        decision: decision.decision,
        decidedAt: decision.decidedAt.toISOString(),
        hasComment: decision.comment !== null,
      },
    });

    return { decision: toDecisionRecord(decision), created: true };
  }

  /**
   * A duplicate business id is permanent-identity conflict territory
   * (FR-OFF-015-style): same id, same content -> the caller is retrying;
   * same id, different content -> a conflict, never a silent rewrite.
   *
   * `status`/`createdAt` are deliberately EXCLUDED — `status` is server-
   * mutable AFTER creation (the request may since have been decided) and
   * `createdAt` is server-stamped, neither is a caller-declared fact.
   * `value` is compared via `stableStringify` (key-order-independent).
   */
  private assertIdenticalRequest(
    existing: ApprovalRequest,
    expected: {
      tenantId: string;
      requestType: string;
      entityType: string;
      entityId: string;
      requestedBy: string;
      requiredPermission: string;
      value: Prisma.InputJsonValue;
      expiresAt: Date;
      excludedApproverUserId: string | null;
    },
  ): void {
    const identical =
      existing.tenantId === expected.tenantId &&
      existing.requestType === expected.requestType &&
      existing.entityType === expected.entityType &&
      existing.entityId === expected.entityId &&
      existing.requestedBy === expected.requestedBy &&
      existing.requiredPermission === expected.requiredPermission &&
      stableStringify(existing.value) === stableStringify(expected.value) &&
      existing.expiresAt.getTime() === expected.expiresAt.getTime() &&
      existing.excludedApproverUserId === expected.excludedApproverUserId;
    if (!identical) {
      throw new ApprovalRequestConflictError(
        'That approval request id already exists with different content. A ' +
          'client-generated identifier is permanent.',
      );
    }
  }

  /**
   * `decidedAt`/`createdAt` are deliberately EXCLUDED — both are server-
   * stamped by `statement_timestamp()`/`CURRENT_TIMESTAMP` DEFAULTs the
   * caller never asserts and cannot supply (see the migration's
   * column-level GRANT INSERT), mirroring `CashMovement`'s own precedent of
   * excluding its server-timing field from the identical-content check.
   */
  private assertIdenticalDecision(
    existing: ApprovalDecision,
    expected: {
      tenantId: string;
      approvalRequestId: string;
      approverId: string;
      decision: string;
      comment: string | null;
    },
  ): void {
    const identical =
      existing.tenantId === expected.tenantId &&
      existing.approvalRequestId === expected.approvalRequestId &&
      existing.approverId === expected.approverId &&
      existing.decision === expected.decision &&
      existing.comment === expected.comment;
    if (!identical) {
      throw new ApprovalDecisionConflictError(
        'That approval decision id already exists with different content. A ' +
          'client-generated identifier is permanent.',
      );
    }
  }
}
