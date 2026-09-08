import {
  CashMovement,
  CashSession,
  Shift,
} from '../../generated/prisma/client';
import { CashClosePolicyRecord } from './cash-close-policy/cash-close-policy.service';
import { ResolvedCashClosePolicy } from './cash-close-policy/cash-close-policy.resolver';

/**
 * Treasury read models.
 *
 * `openingFloat` is a BIGINT of minor units and is serialised as a STRING. A
 * JSON number would be IEEE-754 and would corrupt a large float silently, which
 * ADR-008 forbids — and the client is the Dart POS, which must read back the
 * exact integer the server wrote (BR-FIN-005).
 */
export function toCashSessionView(session: CashSession) {
  return {
    id: session.id,
    branchId: session.branchId,
    drawerId: session.drawerId,
    shiftId: session.shiftId,
    employeeId: session.employeeId,
    openingFloat: session.openingFloat.toString(),
    currency: session.currency,
    status: session.status,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
  };
}

/** P1G-0 — mirrors `toCashSessionView`'s money-as-string discipline exactly. */
export function toCashMovementView(movement: CashMovement) {
  return {
    id: movement.id,
    cashSessionId: movement.cashSessionId,
    branchId: movement.branchId,
    employeeId: movement.employeeId,
    movementType: movement.movementType,
    amountMinor: movement.amount.toString(),
    currency: movement.currency,
    reason: movement.reason,
    occurredAt: movement.occurredAt,
  };
}

/** P1G-1 — mirrors `toCashSessionView`'s money-as-string discipline exactly. */
export function toCashClosePolicyView(policy: CashClosePolicyRecord) {
  return {
    id: policy.id,
    branchId: policy.branchId,
    effectiveFrom: policy.effectiveFrom,
    countMode: policy.countMode,
    varianceToleranceMinorUnits: policy.varianceToleranceMinorUnits.toString(),
    currency: policy.currency,
    varianceApprovalExpirySeconds: policy.varianceApprovalExpirySeconds,
    createdBy: policy.createdBy,
    createdAt: policy.createdAt,
  };
}

/**
 * GOLDEN-PATH-BACKEND-CLOSURE (2026-09-07) — the read-side counterpart to
 * `toCashClosePolicyView`, for `CashClosePolicyResolver`'s resolved shape
 * (no `createdBy`; `id` is named `policyVersionId` there since it is a
 * resolution result, not a freshly-created row).
 */
export function toResolvedCashClosePolicyView(policy: ResolvedCashClosePolicy) {
  return {
    id: policy.policyVersionId,
    branchId: policy.branchId,
    effectiveFrom: policy.effectiveFrom,
    countMode: policy.countMode,
    varianceToleranceMinorUnits: policy.varianceToleranceMinorUnits.toString(),
    currency: policy.currency,
    varianceApprovalExpirySeconds: policy.varianceApprovalExpirySeconds,
    createdAt: policy.createdAt,
  };
}

/**
 * DEMO-MANAGER-CASH-SESSIONS-P0 — `GET /branches/{branchId}/cash-sessions/open`.
 * `drawerName`/`employeeName` come from a same-query join (never a second
 * round trip); mirrors `toCashSessionView`'s money-as-string discipline.
 */
export function toOpenCashSessionView(
  session: CashSession & {
    drawer: { name: string };
    employee: { displayName: string };
  },
) {
  return {
    sessionId: session.id,
    branchId: session.branchId,
    drawerId: session.drawerId,
    drawerName: session.drawer.name,
    employeeId: session.employeeId,
    employeeName: session.employee.displayName,
    status: session.status,
    openedAt: session.openedAt,
    openingFloat: session.openingFloat.toString(),
    currency: session.currency,
  };
}

export function toShiftView(shift: {
  id: string;
  branchId: string;
  employeeId: string;
  status: Shift['status'];
  openedAt: Date;
}) {
  return {
    id: shift.id,
    branchId: shift.branchId,
    employeeId: shift.employeeId,
    status: shift.status,
    openedAt: shift.openedAt,
  };
}
