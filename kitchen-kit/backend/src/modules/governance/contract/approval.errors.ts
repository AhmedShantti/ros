/**
 * Governance PUBLIC contract — typed errors for the Approval runtime.
 *
 * Published alongside `approval.contract.ts` so a consumer can distinguish
 * outcomes (P1G-1's future close, or any future consumer) without Governance
 * owning any HTTP/error semantics of its own (D-14 A-1; D-18 E-1 —
 * "NO GOVERNANCE-SPECIFIC ERROR SEMANTICS IN PHASE 1"). Plain `Error`
 * subclasses with a `readonly code`, following
 * `inventory/contract/sale-depletion.errors.ts`.
 */

export class ApprovalRequestConflictError extends Error {
  readonly code = 'APPROVAL_REQUEST_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRequestConflictError';
  }
}

export class ApprovalDecisionConflictError extends Error {
  readonly code = 'APPROVAL_DECISION_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDecisionConflictError';
  }
}

export class ApprovalNotPendingError extends Error {
  readonly code = 'APPROVAL_NOT_PENDING';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalNotPendingError';
  }
}

export class ApproverNotPermittedError extends Error {
  readonly code = 'APPROVER_NOT_PERMITTED';
  constructor(message: string) {
    super(message);
    this.name = 'ApproverNotPermittedError';
  }
}

/**
 * Thrown when the database rejects the decision INSERT for a reason the
 * four RLS conjuncts enforce (self-approval, excluded approver, expiry) and
 * the service could not more specifically classify beforehand. Distinct
 * from `ApprovalNotPendingError`/`ApproverNotPermittedError`, which the
 * service can and does detect before ever attempting the INSERT.
 */
export class ApprovalDecisionRejectedError extends Error {
  readonly code = 'APPROVAL_DECISION_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDecisionRejectedError';
  }
}
