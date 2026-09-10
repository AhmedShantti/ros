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
 *
 * P2E extension (`FR-PLT-028`/`FR-POS-055`) — `serviceChargeTotal` is now
 * genuinely computed, from the order's PINNED
 * `serviceChargePolicyVersionId` (P2D-R1 clause 7/8: `Order.openedAt`,
 * never today's tenant->brand->branch resolution) and PINNED
 * `countryPackVersion` (rounding mode/precision, FR-FIN-035 — never an
 * independent hardcoded mode). Its BASE is `subtotal` — the SAME "before
 * discount and tax" figure this function already computes, the one value
 * the SRS's own Order-entity table names unambiguously — and it is added
 * to `grandTotal` as an INDEPENDENT term, exactly how order-level discount
 * is already an independent, isolated term here (see that term's own
 * comment below): neither adjusts the other's base. `Order.orderType`/
 * `guestCount` are immutable post-open (an established P2D-R1 rationale
 * point), so re-evaluating the rule-set fresh on every call — rather than
 * caching a winning rule — costs one extra indexed read and carries no
 * staleness risk.
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
import { CountryPackService } from '../../localisation/country-pack/country-pack.service';
import {
  computeServiceChargeAmount,
  evaluateServiceChargeRule,
} from '../service-charge-policy/service-charge-evaluation';
import { parseServiceChargePolicyRules } from '../service-charge-policy/service-charge-policy-rules';

export interface OrderTotalsResult {
  readonly subtotal: bigint;
  readonly taxTotal: bigint;
  readonly discountTotal: bigint;
  readonly serviceChargeTotal: bigint;
  readonly grandTotal: bigint;
  readonly cogsTotal: bigint | null;
}

/**
 * The pinned policy version's rule-set, evaluated against the order's own
 * immutable `orderType`/`guestCount`, applied to `subtotal`. `0n` for
 * every one of the P2D-R1-mandated zero cases: no pinned version, `rules:
 * []`, or no rule in the pinned rule-set matches this order.
 */
async function computeServiceChargeTotal(
  tx: Prisma.TransactionClient,
  tenantId: string,
  countryPacks: CountryPackService,
  order: {
    readonly branchId: string;
    readonly orderType: string;
    readonly guestCount: number | null;
    readonly countryPackVersion: string;
    readonly serviceChargePolicyVersionId: string | null;
  },
  subtotal: bigint,
  currency: string,
): Promise<bigint> {
  if (order.serviceChargePolicyVersionId === null) return 0n;

  const version = await tx.serviceChargePolicy.findUnique({
    where: { id: order.serviceChargePolicyVersionId, tenantId },
    select: { rules: true },
  });
  // The pinned version is immutable and RESTRICT-protected — absence here
  // would mean the pin itself is corrupt, not a normal runtime state.
  if (!version) return 0n;

  const rules = parseServiceChargePolicyRules(version.rules);
  const winner = evaluateServiceChargeRule(rules, {
    orderType: order.orderType,
    guestCount: order.guestCount,
  });
  if (!winner) return 0n;

  const branch = await tx.branch.findUniqueOrThrow({
    where: { id: order.branchId },
    select: { countryCode: true },
  });
  const pack = countryPacks.requirePinned(
    branch.countryCode,
    order.countryPackVersion,
  );
  const rate = parseExactDecimal(winner.ratePercent);
  const amount = computeServiceChargeAmount(
    Money.of(subtotal, currency),
    rate.unscaled,
    rate.scale,
    pack.tax.roundingMode,
    pack.tax.roundingPrecision,
  );
  // FR-POS-058 (`pack.tax.serviceChargeTaxable`) is DELIBERATELY not
  // consulted here. `taxTotal` above is exclusively the SUM of line taxes
  // (FR-FIN-034); every line tax computation requires a `taxClassCode`
  // resolved against `pack.tax.classes`, and no Country Pack field names
  // WHICH class/rate a taxable service charge would use. Inventing one
  // (e.g. defaulting to `standard`) would put a fabricated tax amount on a
  // real invoice, which this codebase refuses to do (see
  // `country-pack.model.ts`'s own `TaxComponentBase` doc for the identical
  // refusal on a different, equally underspecified question). This is the
  // P2E `FR_POS_058_BLOCKER` — see the P2E report for the full record; the
  // service charge AMOUNT above is unaffected and always correct on its
  // own terms.
  return amount.amount;
}

export async function recomputeOrderTotals(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
  businessDay: Date,
  currency: string,
  countryPacks: CountryPackService,
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

  // P2E — service charge on `subtotal`, an INDEPENDENT additive term
  // alongside order-level discount (which is itself already an
  // independent, isolated subtraction — see that term's own history in
  // this function). Neither adjusts the other's base; both are summed
  // once into `grandTotal` below.
  const order = await tx.order.findUniqueOrThrow({
    where: { id_businessDay: { id: orderId, businessDay } },
    select: {
      branchId: true,
      orderType: true,
      guestCount: true,
      countryPackVersion: true,
      serviceChargePolicyVersionId: true,
    },
  });
  const serviceChargeTotal = await computeServiceChargeTotal(
    tx,
    tenantId,
    countryPacks,
    order,
    subtotal,
    currency,
  );

  // NOTE: `roundingAdjustment` is NOT unimplemented — BR-FIN-004 cash
  // rounding IS computed, correctly, in `SalesPaymentService` at PAYMENT
  // CAPTURE time (using the pinned Country Pack's cash-rounding policy via
  // `PINNED_PAYMENT_POLICY_QUERY`), which is the only instant a cash
  // tender's rounding can be computed at; it is intentionally never
  // recomputed here, from order LINES, on line add/void.
  return {
    subtotal,
    taxTotal,
    discountTotal: lineDiscountTotal + orderLevelDiscountMinor,
    serviceChargeTotal,
    grandTotal:
      grandTotalFromLines - orderLevelDiscountMinor + serviceChargeTotal,
    cogsTotal: cogs,
  };
}
