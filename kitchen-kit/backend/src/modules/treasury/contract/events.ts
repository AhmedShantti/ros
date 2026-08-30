import { DomainEventEnvelope } from '../../../common/domain-events/domain-event.types';

/**
 * Treasury PUBLIC contract — the domain event this module publishes.
 *
 * SRS §5.5.4's event catalogue lists `cash.variance.detected`, publisher
 * Treasury, principal subscribers Governance, Analytics — this is Treasury's
 * FIRST published domain event (mirrors `sales/contract/events.ts`'s
 * `order.line.fired`/`order.opened`, Sales' own first-of-kind entries, which
 * also currently have no registered handler; §5.5.2's mechanism dispatches
 * to zero handlers without error, exactly as it does for those two today).
 *
 * ── WHEN THIS IS PUBLISHED (design-decidable trigger, not new governance) ──
 * The SRS names the event but not its exact emission instant. The
 * ALREADY-ACCEPTED domain point is used: the instant a CashSession Close
 * declaration's variance becomes an immutable computed fact — i.e. once per
 * NEWLY CREATED `cash_session_close_attempts` row
 * (`CashSessionCloseService.declareClose`), for BOTH the within-tolerance
 * and above-tolerance paths, since a variance (including an exact-zero one)
 * is computed and durably recorded either way. A permanent-id REPLAY of an
 * already-declared attempt does not re-publish — the attempt is not
 * newly created, so there is no new fact to announce (mirrors this same
 * service's own audit-entry replay discipline).
 *
 * `finalizeClose`'s manager decision does NOT publish a second
 * `cash.variance.detected` — the variance itself was already announced at
 * declaration; the decision is a separate fact, already carried by the
 * Approval Runtime's own immutable `ApprovalRequest`/`ApprovalDecision` rows
 * and this module's `CASH_SESSION_CLOSED` audit action. Publishing it again
 * at finalize would misname a decision as a second detection.
 *
 * ── PAYLOAD ──────────────────────────────────────────────────────────────
 * Mirrors the FR-FIN-004 eight-term formula the immutable attempt row
 * itself carries, plus provenance. Money is a base-10 minor-unit integer
 * STRING throughout (ADR-008 — never a JSON number). The envelope
 * (`DomainEventEnvelope`) already supplies `tenantId`, `branchId`,
 * `actorId`, `actorType`, `correlationId`, `causationId`, `idempotencyKey`
 * — none of those is repeated here.
 */
export const CASH_VARIANCE_DETECTED_EVENT_TYPE = 'cash.variance.detected' as const;
export const CASH_VARIANCE_DETECTED_EVENT_VERSION = 1;

export interface CashVarianceDetectedPayload {
  readonly cashSessionId: string;
  /** The immutable declaration this variance was computed on. */
  readonly closeAttemptId: string;
  readonly policyVersionId: string;
  readonly countMode: 'blind' | 'open';
  readonly currency: string;
  readonly toleranceMinorUnits: string;

  // ── FR-FIN-004's eight expected-cash terms ──────────────────────────────
  readonly openingFloatMinorUnits: string;
  readonly cashSalesTotalMinorUnits: string;
  /** Structurally zero at this HEAD — see the attempt table's own CHECK. */
  readonly cashTipsTotalMinorUnits: string;
  readonly payInTotalMinorUnits: string;
  /** Structurally zero at this HEAD — see the attempt table's own CHECK. */
  readonly cashRefundsTotalMinorUnits: string;
  readonly payOutTotalMinorUnits: string;
  readonly safeDropTotalMinorUnits: string;
  readonly cashRoundingAdjustmentsMinorUnits: string;

  // ── THE COMPUTED FACT ────────────────────────────────────────────────────
  readonly expectedCashMinorUnits: string;
  readonly countedCashMinorUnits: string;
  readonly varianceMinorUnits: string;
  readonly approvalRequired: boolean;

  // ── PROVENANCE ────────────────────────────────────────────────────────────
  readonly declaredByEmployeeId: string;
  readonly declaredByUserId: string;
  readonly terminalId: string;
  /** ISO-8601. The device declaration instant (distinct from the envelope's
   *  own `occurredAt`, which is the server's `declareClose` instant). */
  readonly declaredAt: string;
}

export type CashVarianceDetectedEvent = DomainEventEnvelope<
  typeof CASH_VARIANCE_DETECTED_EVENT_TYPE,
  CashVarianceDetectedPayload
>;
