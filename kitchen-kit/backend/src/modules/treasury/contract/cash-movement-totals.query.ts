import { Prisma } from '../../../generated/prisma/client';

/**
 * P1G-0 — the in-process totals a future Cash Close (P1G-1) reads to compute
 * three of FR-FIN-004 [M]'s expected-cash terms (Pay-ins, Pay-outs, Safe
 * Drops). NOT an HTTP route: §15.2's Cash permission catalogue names no
 * movement-read permission, so none is invented (design gate §8/§11).
 *
 * Queries the immutable `treasury.cash_movements` ledger directly — no
 * maintained projection exists or is created (design gate §6): the rows are
 * append-only, so a derived total is historically stable by construction.
 *
 * `tx`-FIRST is load-bearing, not stylistic: a future Cash Close must read
 * this INSIDE the same transaction that holds the `cash_sessions` row lock,
 * so no movement can commit between the read and the close (design gate §10).
 */
export const CASH_MOVEMENT_TOTALS_QUERY = Symbol('CASH_MOVEMENT_TOTALS_QUERY');

export interface CashMovementTotals {
  readonly cashSessionId: string;
  /** Positive minor-unit magnitudes, summed by declared type. */
  readonly payInTotal: bigint;
  readonly payOutTotal: bigint;
  readonly safeDropTotal: bigint;
  /** payInTotal - payOutTotal - safeDropTotal — the signed FR-FIN-004 contribution. */
  readonly netCashMovementEffect: bigint;
}

export interface CashMovementTotalsQuery {
  totalsForSession(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cashSessionId: string,
  ): Promise<CashMovementTotals>;
}
