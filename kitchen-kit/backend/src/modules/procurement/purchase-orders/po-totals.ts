import {
  divideRounded,
  parseExactDecimal,
  pow10,
} from '../../../common/money/rounding';

/**
 * FR-PRC-017 §4 — server-computed line/header totals. Client-supplied
 * totals are never authoritative; every total in this module is derived
 * here, exactly once, using the repository's existing exact-decimal
 * rounding primitive (`divideRounded`) — no floating-point arithmetic
 * anywhere (ADR-008), matching `ServiceChargePolicy`'s own precedent.
 */

export interface PurchaseOrderLineComputationInput {
  /** Minor units of the PO's currency, per one `purchaseUnitId`. */
  readonly unitPriceMinor: bigint;
  /** Six-decimal Quantity convention, as an exact decimal string. */
  readonly quantity: string;
  /** Minor units. Caller-supplied (no tax-computation engine exists in this
   *  repository for Procurement; this module only sums what it is given). */
  readonly taxAmountMinor: bigint;
}

export interface PurchaseOrderLineTotals {
  readonly netAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
  readonly lineTotalMinor: bigint;
}

/** `round(unitPriceMinor * quantity)` — the single rounding point for this
 *  line, computed once as an exact rational and rounded HALF_UP (BR-FIN-002
 *  default; no country-pack override applies to procurement pricing). */
export function computeLineTotals(
  input: PurchaseOrderLineComputationInput,
): PurchaseOrderLineTotals {
  const quantity = parseExactDecimal(input.quantity);
  const denominator = pow10(quantity.scale);
  const netAmountMinor = divideRounded(
    input.unitPriceMinor * quantity.unscaled,
    denominator,
  );
  return {
    netAmountMinor,
    taxAmountMinor: input.taxAmountMinor,
    lineTotalMinor: netAmountMinor + input.taxAmountMinor,
  };
}

export interface PurchaseOrderHeaderTotals {
  readonly subtotalMinor: bigint;
  readonly taxTotalMinor: bigint;
  readonly grandTotalMinor: bigint;
}

/** `PurchaseOrder.grandTotal === SUM(lines.lineTotal)` (mission brief §4
 *  invariant) — derived by summation, never independently computed. */
export function computeHeaderTotals(
  lines: readonly PurchaseOrderLineTotals[],
): PurchaseOrderHeaderTotals {
  let subtotalMinor = 0n;
  let taxTotalMinor = 0n;
  for (const line of lines) {
    subtotalMinor += line.netAmountMinor;
    taxTotalMinor += line.taxAmountMinor;
  }
  return {
    subtotalMinor,
    taxTotalMinor,
    grandTotalMinor: subtotalMinor + taxTotalMinor,
  };
}
