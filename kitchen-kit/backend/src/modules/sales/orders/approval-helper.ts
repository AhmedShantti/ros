import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  ApprovalCommands,
  ApprovalDecisionConflictError,
  ApprovalDecisionRejectedError,
  ApprovalNotPendingError,
  ApprovalRequestConflictError,
  ApproverNotPermittedError,
} from '../../governance/contract';
import type { VerifiedTerminalPrincipal } from '../../identity/contract';

/**
 * POS-FIN-1 shared approval helper — discount, comp and refund approval all
 * reduce to the SAME single-phase shape: evaluate a threshold, and if a
 * manager PIN was supplied, create the approval request and decide it
 * APPROVED in the same call, inside the SAME transaction as the financial
 * write (D-13: Sales evaluates the threshold, Governance only records the
 * generic request/decision).
 *
 * ── WHY THIS IS SINGLE-PHASE, NOT `CashSessionCloseService`'s TWO-PHASE
 *    declare/finalize SHAPE ─────────────────────────────────────────────
 * `declareClose`/`finalizeClose` exists ONLY because of FR-POS-095's blind-
 * count disclosure rule — a manager must decide WITHOUT having seen the
 * variance first. No analogous non-disclosure constraint exists for a
 * discount/refund: the threshold, reason and amount are already visible to
 * whoever is entering them. A single call — verify the manager's PIN, then
 * atomically create+decide — is the correct, narrower shape here.
 *
 * ── WHY THE DECISION IS ALWAYS 'approved' HERE ──────────────────────────
 * FR-SEC-032's synchronous channel is "manager PIN entry on the terminal" —
 * entering a valid PIN IS the approval act. There is no synchronous
 * "manager PIN entry that means reject" UX: a manager who declines simply
 * does not enter a PIN, and the caller never reaches this helper at all
 * (the route returns 403/422 asking for one). A genuine recorded REJECTED
 * decision would require the async/mobile-push channel FR-SEC-032 also
 * names, which — per the 2026-08-29 register entry — "remains deferred and
 * knowingly unmet" project-wide; this helper does not invent it. This is a
 * recorded scope narrowing, not a silent one.
 *
 * `expiresAt` is a short, fixed window (D-10: evaluated at the decision
 * INSERT boundary, `statement_timestamp()` read fresh inside THIS
 * transaction, never `transaction_timestamp()`/an app clock — the same
 * expiry-base bug class the cash-close final acceptance closure already
 * found and fixed once) — sufficient because `decide` is called
 * immediately after `createRequest`, in the same transaction; no ratified
 * configurable duration exists for discount/refund approval (§7 item 1 of
 * the design gate), so a short constant is used rather than inventing one.
 */
const SYNCHRONOUS_APPROVAL_WINDOW_MS = 2 * 60 * 1000;

export interface ObtainSynchronousApprovalParams {
  readonly tx: Prisma.TransactionClient;
  readonly tenantId: string;
  readonly requestedByUserId: string;
  readonly requestType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly value: Prisma.InputJsonValue;
  readonly requiredPermission: string;
  /** The applying employee's own linked Identity User id (SoD). */
  readonly excludedApproverUserId?: string;
  /** FR-OFF-015-style client-generated permanent ids. */
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly approver: VerifiedTerminalPrincipal;
}

export interface SynchronousApprovalResult {
  readonly approverId: string;
  readonly approvalRequestId: string;
}

export async function obtainSynchronousApproval(
  approvals: ApprovalCommands,
  params: ObtainSynchronousApprovalParams,
): Promise<SynchronousApprovalResult> {
  const [{ now }] = await params.tx.$queryRaw<{ now: Date }[]>`
    SELECT statement_timestamp() AS "now"
  `;
  const expiresAt = new Date(now.getTime() + SYNCHRONOUS_APPROVAL_WINDOW_MS);

  try {
    await approvals.createRequest(
      params.tx,
      params.tenantId,
      params.requestedByUserId,
      {
        id: params.approvalRequestId,
        requestType: params.requestType,
        entityType: params.entityType,
        entityId: params.entityId,
        requiredPermission: params.requiredPermission,
        value: params.value,
        expiresAt,
        ...(params.excludedApproverUserId
          ? { excludedApproverUserId: params.excludedApproverUserId }
          : {}),
      },
    );
  } catch (error) {
    if (error instanceof ApprovalRequestConflictError) {
      throw new ConflictException(error.message);
    }
    throw error;
  }

  try {
    const decisionResult = await approvals.decide(params.tx, params.tenantId, {
      id: params.approvalDecisionId,
      approvalRequestId: params.approvalRequestId,
      decision: 'approved',
      approver: params.approver,
    });
    return {
      approverId: decisionResult.decision.approverId,
      approvalRequestId: params.approvalRequestId,
    };
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
}
