/**
 * Order total recomputation — FR-FIN-034 (order tax = SUM of line taxes,
 * never a computation on the order total), extracted from
 * `OrderLinesService`'s original private method (P1C) so every write path
 * that changes what an order owes — line capture, pre-fire void, POS-FIN-1
 * discount/comp application, post-fire void — shares exactly ONE
 * full-re-derivation implementation. Never a patched delta onto a stale
 * projection (task instruction §C) — every field is re-derived, fresh, from
 * live rows, on every call.
 *
 * POS-FIN-1 extension: `discountTotal` and the order-level-discount term of
 * `grandTotal` are now genuinely computed (previously always 0 — see the
 * method's own prior doc comment, quoted in the design gate). Line-level
 * discount is already folded into each line's own `lineTotal`/`taxAmount`
 * by whatever wrote those columns (`OrderLinesService.addLine`, or POS-FIN-1's
 * discount service recomputing a line after applying a discount) — this
 * function does not re-derive a line's OWN discount math, only sums it.
 * Order-level discount has no per-line home, so it is looked up fresh from
 * `sales.discounts` (`orderLineId IS NULL`) and subtracted once, here.
 */
import { Money } from '../../../common/money/money';
import {
  Rational,
  add,
  fromExactDecimal,
  multiply,
  rational,
  toMinorUnits,
} from '../../../common/money/rational';
import {
  RoundingMode,
  parseExactDecimal,
} from '../../../common/money/rounding';
import { Prisma } from '../../../generated/prisma/client';

export interface OrderTotalsResult {
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly discountTotal: bigint;
  readonly grandTotal: bigint;
  readonly cogsTotal: bigint | null;
}

export async function recomputeOrderTotals(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
  businessDay: Date,
  currency: string,
): Promise<OrderTotalsResult> {
  const lines = await tx.orderLine.findMany({
    where: {
      orderId,
      businessDay,
      state: { notIn: ['voided', 'comped'] },
    },
    select: {
      lineSubtotal: true,
      taxAmount: true,
      lineTotal: true,
      lineDiscount: true,
      unitCostSnapshot: true,
      quantity: true,
    },
  });

  let subtotal = 0n;
  let taxTotal = 0n;
  let grandTotalFromLines = 0n;
  let lineDiscountTotal = 0n;
  // P1F-2 in-scope micro-fix: COGS is unitCostSnapshot x quantity, not the
  // bare per-unit snapshot — a qty=3 line must contribute 3x, not 1x. Exact
  // rational arithmetic, ONE HALF_UP rounding per line (BR-FIN-001).
  let cogsExact: Rational | null = null;
  for (const line of lines) {
    subtotal += line.lineSubtotal;
    taxTotal += line.taxAmount;
    grandTotalFromLines += line.lineTotal;
    lineDiscountTotal += line.lineDiscount;
    if (line.unitCostSnapshot !== null) {
      const lineCogs = multiply(
        rational(line.unitCostSnapshot),
        fromExactDecimal(parseExactDecimal(line.quantity.toFixed(3))),
      );
      cogsExact = cogsExact ? add(cogsExact, lineCogs) : lineCogs;
    }
  }
  const cogs = cogsExact ? toMinorUnits(cogsExact, RoundingMode.HALF_UP) : null;
  // Named only to make the currency explicit at the boundary; the arithmetic
  // above is already exact bigint minor units.
  void Money.of(grandTotalFromLines, currency);

  // POS-FIN-1 — order-level discount, looked up fresh (never a delta) from
  // the append-only ledger. At most one order-level row exists per order in
  // this MVP (no stacking — FR-POS-051's promotions engine is out of scope),
  // but SUM tolerates more than one defensively rather than assuming it.
  const orderLevelDiscount = await tx.discount.aggregate({
    where: { tenantId, orderId, businessDay, orderLineId: null },
    _sum: { amountMinor: true },
  });
  const orderLevelDiscountMinor = orderLevelDiscount._sum.amountMinor ?? 0n;

  // NOTE: `serviceChargeTotal` and `roundingAdjustment` are still NOT
  // recomputed here — service charge and cash rounding (BR-FIN-004) are not
  // implemented, so this function must not pretend to maintain them. They
  // stay at their defaults of 0, exactly as before this slice.
  return {
    subtotal,
    taxTotal,
    discountTotal: lineDiscountTotal + orderLevelDiscountMinor,
    grandTotal: grandTotalFromLines - orderLevelDiscountMinor,
    cogsTotal: cogs,
  };
}
