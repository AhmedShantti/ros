import { Prisma } from '../../../generated/prisma/client';

/**
 * Sales PUBLIC contract — the CashSession tender totals a P1G-1 CashSession
 * Close needs (FR-FIN-004 terms "Cash Sales" and "Cash Rounding
 * Adjustments"; FR-FIN-010 tender totals).
 *
 * SRS §5.2.3 places `sales.order_payments` inside Sales; Treasury MUST NOT
 * query it directly — the exact class of defect the acceptance-closure
 * report already corrected for `CashSessionsService.open` (a direct query
 * against another module's table is a boundary violation even with no
 * private TypeScript import). This is Sales' FIRST published `contract/`
 * QUERY (`contract/` previously held only `events.ts`) — the mirror image
 * of `treasury/contract`'s `CASH_SESSION_FACTS_QUERY`, which already
 * crosses this same edge in the other direction.
 *
 * `totalsForSession` is `tx`-FIRST — load-bearing, not stylistic: the future
 * CashSession Close reads this INSIDE the SAME transaction that holds the
 * `ros_cash_session` advisory lock (the P1G-0 `CASH_MOVEMENT_TOTALS_QUERY`
 * precedent), so no payment can commit between the read and the close.
 *
 * Only `cash` and `manual_external_card` tenders exist at this HEAD
 * (`OrderPaymentTender`) — every other §15.2 tender type (card via
 * integrated terminal, digital wallet, gift card, …) is unimplemented, so
 * `manualExternalCardTotal` is the entire non-cash total this query can
 * report; FR-FIN-010's remaining tender types stay unmet regardless of this
 * contract's shape.
 *
 * Returns zeros (never `null`) when the session has no payments at all —
 * "no payments yet" and "zero payments" are the same fact for a formula
 * term, and forcing every caller to null-check a term that participates in
 * arithmetic would only invite a silent `NaN`/`undefined` bug in a codebase
 * that otherwise forbids floating-point money entirely.
 */
export const CASH_SESSION_TENDER_TOTALS_QUERY = Symbol(
  'CASH_SESSION_TENDER_TOTALS_QUERY',
);

export interface CashSessionTenderTotals {
  readonly cashSessionId: string;
  /** tender='cash' — Σ amount. FR-FIN-004 term 2. */
  readonly cashSalesTotal: bigint;
  /**
   * tender='cash' — Σ rounding_adjustment (signed; FR-POS-063/BR-FIN-004 is
   * CASH-only, CHECK-enforced zero for every other tender). FR-FIN-004 term 8.
   */
  readonly cashRoundingAdjustments: bigint;
  /** tender='manual_external_card' — Σ amount. NOT a cash term; FR-FIN-010 input only. */
  readonly manualExternalCardTotal: bigint;
  /** Total Payment row count for the session, for the close snapshot's provenance. */
  readonly paymentCount: number;
  /**
   * POS-FIN-1 — `sales.refunds` where `tender='cash' AND cash_session_id`
   * is THIS session (a Refund's own `cashSessionId` is only ever set for a
   * cash refund — see the model's CHECK constraint). FR-FIN-004 term 5
   * ("Cash Refunds"), previously structurally zero (no refund mechanism
   * existed); real from this slice on.
   */
  readonly cashRefundsTotal: bigint;
}

export interface CashSessionTenderTotalsQuery {
  totalsForSession(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cashSessionId: string,
  ): Promise<CashSessionTenderTotals>;
}
