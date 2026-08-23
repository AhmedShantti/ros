/**
 * `vat_standard` — the registered tax-engine strategy named by SRS §22.2's pack
 * sample (`tax: { engine: "vat_standard" }`).
 *
 * It implements the ad-valorem VAT MODEL and nothing about any jurisdiction.
 * There is no country code in this file, no rate, no class name and no fee: the
 * caller hands it a tax class taken from a country pack, and every number comes
 * from that class. Changing a rate, adding a class or adding a component is a
 * pack edit (FR-LOC-025); only a genuinely different tax model would need a new
 * strategy beside this one.
 *
 * ── THE ARITHMETIC (BR-FIN-001) ─────────────────────────────────────────────
 * Every rate is an exact decimal percent. Components are normalised onto one
 * common denominator so several rates combine without a single intermediate
 * rounding:
 *
 *     rate_i = n_i / D        where D = 100 * 10^S, S = max component scale
 *
 * Exclusive pricing — the base is the line NET:
 *     tax_i = round( net * n_i / D )
 *
 * Inclusive pricing — the base is the line GROSS, and net is never materialised
 * before the tax is derived, because doing so would round twice:
 *     gross = net * (D + SUM n_j) / D   =>   tax_i = round( gross * n_i / (D + SUM n_j) )
 *
 * In both cases each component is carried at full precision as a rational and
 * rounded EXACTLY ONCE, at that component's own rounding point — which is
 * BR-FIN-001 and FR-FIN-032's "each with its own ... rounding" in one operation.
 * `divideRounded` is the shared primitive, so the server rounds the way the Dart
 * client will (BR-FIN-005).
 *
 * ── THE ROUNDING POINT (FR-FIN-035) ─────────────────────────────────────────
 * `roundingPrecision` is decimal places. An amount is an integer count of minor
 * units, so precision `p` on a currency of exponent `e` means the amount must be
 * a multiple of `g = 10^(e - p)`: precision 2 on EGP rounds to the piastre,
 * precision 0 on EGP rounds to whole pounds. The parser already refuses `p > e`.
 */

import { Money } from '../../../common/money/money';
import { divideRounded, pow10 } from '../../../common/money/rounding';
import { TaxComponentDef } from '../country-pack/country-pack.model';
import {
  LineTaxResult,
  TaxComponentAmount,
  TaxComputationStrategy,
  TaxLineInput,
} from './tax.model';

/** The strategy id the pack's `tax.engine` names. */
export const VAT_STANDARD_ENGINE_ID = 'vat_standard';

/** Render an exact decimal percent back to its canonical string form. */
function formatPercent(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString();
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

interface NormalisedComponent {
  readonly def: TaxComponentDef;
  /** Rate numerator on the shared denominator. */
  readonly numerator: bigint;
  /** Minor-unit granularity implied by this component's rounding precision. */
  readonly granularity: bigint;
}

export class VatStandardStrategy implements TaxComputationStrategy {
  readonly id = VAT_STANDARD_ENGINE_ID;

  computeLine(input: TaxLineInput): LineTaxResult {
    const { taxableBase, taxClass, pricingMode } = input;
    const currency = taxableBase.currency;

    // An exempt supply is outside the scope of the tax: no components, no
    // breakdown, and the base is simultaneously the net and the gross under
    // both pricing modes. It is NOT a zero-rated supply and never reports as one.
    if (taxClass.exempt) {
      return {
        taxClassCode: taxClass.code,
        pricingMode,
        netAmount: taxableBase,
        taxAmount: Money.zero(currency),
        grossAmount: taxableBase,
        exempt: true,
        zeroRated: false,
        components: [],
      };
    }

    const scale = taxClass.components.reduce(
      (max, c) => Math.max(max, c.ratePercent.scale),
      0,
    );
    // rate_i = numerator_i / denominator, exactly, with no shared rounding.
    const denominator = 100n * pow10(scale);
    const normalised: NormalisedComponent[] = taxClass.components.map(
      (def) => ({
        def,
        numerator:
          def.ratePercent.unscaled * pow10(scale - def.ratePercent.scale),
        granularity: pow10(currency.exponent - def.roundingPrecision),
      }),
    );

    const rateSum = normalised.reduce((sum, c) => sum + c.numerator, 0n);
    // Inclusive pricing divides by (1 + total rate); exclusive multiplies by the
    // rate alone. One expression, two denominators.
    const sharedDenominator =
      pricingMode === 'tax_inclusive' ? denominator + rateSum : denominator;

    const components: TaxComponentAmount[] = normalised.map((c) => {
      const units = divideRounded(
        taxableBase.amount * c.numerator,
        sharedDenominator * c.granularity,
        c.def.roundingMode,
      );
      return {
        code: c.def.code,
        ratePercent: formatPercent(
          c.def.ratePercent.unscaled,
          c.def.ratePercent.scale,
        ),
        amount: Money.of(units * c.granularity, currency),
      };
    });

    const taxAmount = components.reduce(
      (sum, c) => sum.plus(c.amount),
      Money.zero(currency),
    );
    const netAmount =
      pricingMode === 'tax_inclusive'
        ? taxableBase.minus(taxAmount)
        : taxableBase;
    const grossAmount =
      pricingMode === 'tax_inclusive'
        ? taxableBase
        : taxableBase.plus(taxAmount);

    return {
      taxClassCode: taxClass.code,
      pricingMode,
      netAmount,
      taxAmount,
      grossAmount,
      exempt: false,
      // Zero-rated: genuinely inside the scope of the tax, at a rate of zero.
      zeroRated: rateSum === 0n,
      components,
    };
  }
}
