import { Prisma } from '../../../generated/prisma/client';
import type { VerifiedTerminalPrincipal } from '../../identity/contract';

/**
 * Governance PUBLIC contract — the shared Approval runtime (FR-SEC-030..033).
 *
 * Authority: docs/governance/GOVERNANCE_DECISION_REGISTER.md, "Approval
 * Runtime Minimum Resolution — 2026-08-29" (RATIFIED) +
 * docs/reports/claude/2026-08-29_APPROVAL_runtime-design-acceptance-closure.md
 * (CONTROLLING).
 *
 * `tx`-FIRST throughout — load-bearing, not stylistic: an approval request
 * and its later decision must live inside the SAME transaction as the
 * consuming module's business write (e.g. a future CashSession close), so
 * the whole operation is atomic and inherits the consuming route's
 * `Idempotency-Key` at-most-once guarantee (D-14 A-1 — Governance has no
 * HTTP surface of its own; `FR-API-020` does not attach here).
 *
 * `tenantId` and the actor id are TRUSTED POSITIONAL ARGUMENTS, supplied by
 * the caller's own `TenantContext` — never fields inside the command
 * payload. This mirrors `CashMovementsService.record(tenantId, actorUserId,
 * input)` and `ShiftOpener.openShift(tx, command)` exactly, and is what
 * makes tenant spoofing structurally awkward; the RLS INSERT policy
 * independently rejects a mismatched tenant regardless.
 *
 * `value` is an OPAQUE `JSONB` carrier (SB-2, RATIFIED): Governance never
 * interprets it, so the type here is `Prisma.InputJsonValue` /
 * `Prisma.JsonValue` — the generic Prisma JSON type, not a Governance-owned
 * shape. Money inside it MUST be a base-10 integer string of minor units,
 * never a JSON number.
 *
 * `requestType` and `entityType` are equally opaque strings the consuming
 * domain supplies (D-13 "generic carrier"; D-16's enumeration remains OPEN —
 * no closed vocabulary is invented anywhere in Governance).
 *
 * The concrete implementation (`governance/approvals/approvals.service.ts`)
 * is PRIVATE, bound to `APPROVAL_COMMANDS` only inside `GovernanceModule`. A
 * consumer injects the token and depends on the `ApprovalCommands` interface
 * below; it never imports the concrete implementation.
 */
export const APPROVAL_COMMANDS = Symbol('APPROVAL_COMMANDS');

export interface CreateApprovalRequestCommand {
  /** FR-OFF-015-style client-generated permanent id, ULID rendered as UUID. */
  readonly id: string;
  /** Opaque to Governance. D-16's enumeration remains OPEN. */
  readonly requestType: string;
  readonly entityType: string;
  readonly entityId: string;
  /** Opaque carrier (SB-2). Money as base-10 integer strings of minor units. */
  readonly value: Prisma.InputJsonValue;
  /** An existing SRS §15.2 permission CODE. No new code is created here. */
  readonly requiredPermission: string;
  /** MANDATORY — no default duration exists (D-10). The caller must supply it. */
  readonly expiresAt: Date;
  /** Item 8 (F-1 = R-b): an Identity USER id prohibited from approving this request. */
  readonly excludedApproverUserId?: string;
}

export interface ApprovalRequestRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestedBy: string;
  readonly requiredPermission: string;
  readonly value: Prisma.JsonValue;
  readonly expiresAt: Date;
  readonly excludedApproverUserId: string | null;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly createdAt: Date;
}

export interface CreateApprovalRequestResult {
  readonly request: ApprovalRequestRecord;
  /** False when an identical permanent id already existed (replay). */
  readonly created: boolean;
}

export interface DecideApprovalCommand {
  /** FR-OFF-015-style client-generated permanent id for THIS decision. */
  readonly id: string;
  readonly approvalRequestId: string;
  readonly decision: 'approved' | 'rejected';
  readonly comment?: string;
  /**
   * Obtained from `TERMINAL_PIN_VERIFIER.verifyTerminalPin(...)` (Identity's
   * contract) BEFORE this transaction was opened. `approverId` on the
   * resulting decision is ALWAYS `approver.userId` — never a second,
   * independently caller-supplied field.
   */
  readonly approver: VerifiedTerminalPrincipal;
}

export interface ApprovalDecisionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly approvalRequestId: string;
  readonly approverId: string;
  readonly decision: 'approved' | 'rejected';
  readonly comment: string | null;
  readonly decidedAt: Date;
  readonly createdAt: Date;
}

export interface DecideApprovalResult {
  readonly decision: ApprovalDecisionRecord;
  /** False when an identical permanent decision id already existed (replay). */
  readonly created: boolean;
}

export interface ApprovalCommands {
  createRequest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requestedByUserId: string,
    command: CreateApprovalRequestCommand,
  ): Promise<CreateApprovalRequestResult>;

  decide(
    tx: Prisma.TransactionClient,
    tenantId: string,
    command: DecideApprovalCommand,
  ): Promise<DecideApprovalResult>;
}
