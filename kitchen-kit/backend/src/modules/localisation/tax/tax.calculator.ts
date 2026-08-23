/**
 * Pure line-level tax calculation — FR-FIN-030…035, BR-FIN-001, BR-FIN-002.
 *
 * Everything here is a function of its arguments: no clock, no database, no
 * request, no ambient configuration. That is what lets the same inputs be
 * replayed by the shared conformance corpus (FR-OFF-050) and, later, by the Dart
 * client (BR-FIN-005).
 */

import { Currency } from '../../../common/money/currency';
import { Money, sumMoney } from '../../../common/money/money';
import { RoundingMode } from '../../../common/money/rounding';
import {
  CountryPack,
  TaxClassDef,
  packLabel,
} from '../country-pack/country-pack.model';
import { TaxEngineRegistry } from './tax-engine.registry';
import {
  LineTaxResult,
  TaxComputationError,
  UnknownTaxClassError,
} from './tax.model';

/**
 * Resolve the tax class that applies to a line — FR-FIN-033's "order-type
 * dependent rates where the jurisdiction differentiates dine-in from takeaway".
 *
 * An override replaces the class WHOLE (its exemption and its components), which
 * matches the approved SQL's `fiscal.tax_rules` shape: a rule row is keyed by
 * (class, `applies_to_order_type`) and carries its own rate. An order type with
 * no override for this class falls through to the base class untouched.
 */
export function resolveTaxClass(
  pack: CountryPack,
  classCode: string,
  orderType: string | null,
): TaxClassDef {
  const base = pack.tax.classes.get(classCode);
  if (!base) throw new UnknownTaxClassError(classCode, packLabel(pack));
  if (orderType === null) return base;

  const override = pack.tax.orderTypeOverrides.find(
    (o) => o.orderType === orderType && o.classCode === classCode,
  );
  if (!override) return base;

  return {
    code: base.code,
    exempt: override.exempt,
    components: override.components,
    ...(base.label ? { label: base.label } : {}),
  };
}

/** A single sale line, before tax. */
export interface TaxableLine {
  /** The line's taxable amount: NET under exclusive pricing, GROSS under inclusive. */
  readonly taxableBase: Money;
  readonly taxClassCode: string;
  /** `null` when the jurisdiction does not differentiate by order type. */
  readonly orderType: string | null;
}

/**
 * Compute one line's tax under a resolved pack.
 *
 * The pack supplies the engine (FR-FIN-030), the pricing mode (FR-FIN-031), the
 * classes (FR-FIN-033) and the rounding policy (FR-FIN-035). This function
 * supplies only the wiring.
 */
export function computeLineTax(
  pack: CountryPack,
  engines: TaxEngineRegistry,
  line: TaxableLine,
): LineTaxResult {
  if (!line.taxableBase.currency.equals(pack.currency.currency)) {
    throw new TaxComputationError(
      `Line is priced in ${line.taxableBase.currency.code} but country pack ` +
        `${packLabel(pack)} defines ${pack.currency.currency.code}. ` +
        'BR-CORE-001 forbids implicit conversion.',
    );
  }
  const strategy = engines.require(pack.tax.engine);
  return strategy.computeLine({
    taxableBase: line.taxableBase,
    taxClass: resolveTaxClass(pack, line.taxClassCode, line.orderType),
    pricingMode: pack.tax.pricingMode,
  });
}

/**
 * FR-FIN-034 — an order's tax is the SUM of its line taxes.
 *
 * There is deliberately no "compute tax from the order total" counterpart. The
 * SRS calls that non-negotiable because the two methods differ by a minor unit
 * or two and fiscal validation rejects the discrepancy.
 */
export function sumLineTax(
  results: readonly LineTaxResult[],
  currency: Currency,
): Money {
  if (results.length === 0) return Money.zero(currency);
  return sumMoney(results.map((r) => r.taxAmount));
}

/**
 * The line's taxable base from its priced parts.
 *
 * `quantity` is an exact decimal STRING (the column is `DECIMAL(12,3)`, and
 * fractional quantities are real: 0.5 kg of grilled meat). `Money.times` carries
 * the product at full precision and rounds once, so a fractional quantity never
 * introduces a floating-point step.
 *
 * Modifier totals and line discounts are applied here rather than inside the tax
 * engine because they are pricing concerns, not tax concerns — but note that
 * order-level discount distribution (BR-FIN-003) is NOT part of this slice, so a
 * caller must not pass an apportioned share it computed itself.
 */
export function computeTaxableBase(params: {
  readonly unitPrice: Money;
  readonly quantity: string;
  readonly modifierTotal?: Money;
  readonly lineDiscount?: Money;
  readonly rounding?: RoundingMode;
}): Money {
  const { unitPrice, quantity, modifierTotal, lineDiscount, rounding } = params;
  let base = unitPrice.times(quantity, rounding ?? RoundingMode.HALF_UP);
  if (modifierTotal) base = base.plus(modifierTotal);
  if (lineDiscount) base = base.minus(lineDiscount);
  return base;
}
