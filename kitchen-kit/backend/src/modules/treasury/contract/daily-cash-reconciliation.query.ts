import { Prisma } from '../../../generated/prisma/client';

/**
 * Treasury PUBLIC contract — WHOLE-SESSION close/movement facts for the
 * Minimum Operational Reporting slice's Cash Reconciliation section
 * (RPT-R1/R2/R3; design gate + acceptance correction
 * `docs/reports/claude/2026-08-31_MINIMUM-reporting-*`, §26/§27/§3).
 *
 * `treasury.cash_sessions` carries NO `business_day` column, and neither do
 * `workforce.shifts`, `treasury.cash_movements` or
 * `treasury.cash_session_close_attempts` — no new immutable anchor is
 * invented (no migration authorised). EVERYTHING returned here is
 * WHOLE-SESSION scope: a caller MUST NOT sum `expectedCash`, `countedCash`,
 * `variance`, `payInTotal`, `payOutTotal` or `safeDropTotal` into a
 * day-level total — a session spanning two business days would contribute
 * the same whole-session figure to both days' reports (the double-count
 * defect the acceptance correction removed). Day-scoped tender totals come
 * from Sales' `DAILY_TRADING_SALES_QUERY`, which reads the immutable
 * `order_payments.business_day` instead.
 *
 * The `cash_sessions` row is the close-fact source directly —
 * `expectedCash`/`countedCash`/`variance` are populated exactly once, at
 * `status: 'closed'`, straight onto that row (P1G-1 migration 34).
 * `CashSessionCloseAttempt` and `cash_count_denominations` are NEVER read
 * here — they are not needed and reading them would leak Treasury's close
 * workflow internals across the boundary.
 *
 * `forSessions` is `tx`-FIRST — the report reads this inside its own single
 * RepeatableRead transaction, sharing the MVCC snapshot every other section
 * reads from. Fail-closed: a supplied `cashSessionId` that does not resolve
 * in `(tenantId, branchId)` — unknown id, wrong branch, or a genuinely
 * cross-tenant id (RLS) — is silently DROPPED from the result. The caller
 * MUST treat the result as a (possibly strict) subset of the input ids and
 * treat any other relationship as an internal invariant breach (design
 * gate §32 — surfaced as a 409, never a partial financial total).
 */
export const DAILY_CASH_RECONCILIATION_QUERY = Symbol(
  'DAILY_CASH_RECONCILIATION_QUERY',
);

export interface DailyCashReconciliationQueryInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly cashSessionIds: readonly string[];
}

export interface CashSessionWholeSessionFacts {
  readonly cashSessionId: string;
  readonly employeeId: string;
  readonly drawerId: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly status: 'open' | 'closing' | 'closed';
  readonly currency: string;
  readonly openingFloat: bigint;
  /** Non-null iff `status === 'closed'`. */
  readonly expectedCash: bigint | null;
  readonly countedCash: bigint | null;
  readonly variance: bigint | null;
  /** Σ `cash_movements.amount` where `movement_type = 'pay_in'` — WHOLE-SESSION. */
  readonly payInTotal: bigint;
  /** Σ `cash_movements.amount` where `movement_type = 'pay_out'` — WHOLE-SESSION. */
  readonly payOutTotal: bigint;
  /** Σ `cash_movements.amount` where `movement_type = 'safe_drop'` — WHOLE-SESSION. */
  readonly safeDropTotal: bigint;
}

export interface DailyCashReconciliationQuery {
  forSessions(
    tx: Prisma.TransactionClient,
    input: DailyCashReconciliationQueryInput,
  ): Promise<readonly CashSessionWholeSessionFacts[]>;
}
