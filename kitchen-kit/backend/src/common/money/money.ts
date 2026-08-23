/**
 * Money — SRS §7.2 shared kernel, ADR-008, BR-CORE-001, BR-CORE-002.
 *
 * Immutable value object holding an integer count of minor units plus its
 * currency. Every operation returns a new instance; nothing mutates.
 *
 * ADR-008 invariants held here:
 *   - the amount is `bigint`, never `number` — no floating-point money, ever;
 *   - the currency travels with the amount;
 *   - the minor-unit exponent comes from the currency and is never assumed to
 *     be 2 (JPY 0, KWD/BHD/OMR 3).
 *
 * Errors are plain `MoneyError`s, not NestJS HTTP exceptions. A currency
 * mismatch is a programming fault in the domain layer, not a request-validation
 * failure, and the shared kernel must stay transport-agnostic — it is also the
 * half of the system that must one day be mirrored in Dart (BR-FIN-005 /
 * FR-OFF-050), where `BadRequestException` has no meaning. Callers that need an
 * HTTP status translate at their own boundary.
 */

import { Currency, assertSameCurrency, currencyOf } from './currency';
import {
  DEFAULT_ROUNDING_MODE,
  RoundingMode,
  divideRounded,
  parseExactDecimal,
  pow10,
} from './rounding';

/** Raised for any operation that cannot produce a correct monetary result. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** A ratio for {@link Money.allocate}: an exact integer or decimal literal. */
export type Ratio = bigint | string;

export class Money {
  private constructor(
    /** Amount in minor units. EGP 12.50 is `1250n`; JPY 1250 is `1250n`. */
    readonly amount: bigint,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  // ---------------------------------------------------------------- factories

  /**
   * Build a Money from minor units.
   *
   * `currency` accepts a {@link Currency} or an ISO-4217 code, which is resolved
   * through the reference table so the exponent is never guessed by the caller.
   */
  static of(amount: bigint, currency: Currency | string): Money {
    if (typeof amount !== 'bigint') {
      throw new MoneyError(
        `Money.of requires a bigint amount in minor units, got ${typeof amount}. ` +
          'Passing a number would admit floating-point error (ADR-008).',
      );
    }
    return new Money(amount, resolveCurrency(currency));
  }

  /** Zero in the given currency. */
  static zero(currency: Currency | string): Money {
    return new Money(0n, resolveCurrency(currency));
  }

  // ----------------------------------------------------------------- queries

  isZero(): boolean {
    return this.amount === 0n;
  }

  isNegative(): boolean {
    return this.amount < 0n;
  }

  isPositive(): boolean {
    return this.amount > 0n;
  }

  /** Same currency and same amount. */
  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency.equals(other.currency);
  }

  /** −1, 0 or 1. Throws on a currency mismatch (BR-CORE-001). */
  compare(other: Money): -1 | 0 | 1 {
    assertSameCurrency(this.currency, other.currency);
    if (this.amount < other.amount) return -1;
    if (this.amount > other.amount) return 1;
    return 0;
  }

  // -------------------------------------------------------------- arithmetic

  /** BR-CORE-001: same-currency only. */
  plus(other: Money): Money {
    assertSameCurrency(this.currency, other.currency);
    return new Money(this.amount + other.amount, this.currency);
  }

  /** BR-CORE-001: same-currency only. */
  minus(other: Money): Money {
    assertSameCurrency(this.currency, other.currency);
    return new Money(this.amount - other.amount, this.currency);
  }

  /** Additive inverse. Preserves currency. */
  negated(): Money {
    return new Money(-this.amount, this.currency);
  }

  /** Magnitude. Preserves currency. */
  abs(): Money {
    return this.amount < 0n ? this.negated() : this;
  }

  /**
   * Multiply by an exact decimal factor, rounding once to whole minor units.
   *
   * The factor is parsed exactly (`"0.15"`, `"1.0825"`, `3n`) — never through a
   * JavaScript `number` — and the product is carried at full precision as a
   * rational before a single rounding step. That is precisely the shape
   * BR-FIN-001 requires of a percentage computation.
   *
   * Rounding defaults to `HALF_UP` per BR-FIN-002 and is overridable, which is
   * how a country pack will later supply its own mode.
   */
  times(factor: Ratio, rounding: RoundingMode = DEFAULT_ROUNDING_MODE): Money {
    const { unscaled, scale } = parseExactDecimal(factor);
    const rounded = divideRounded(
      this.amount * unscaled,
      pow10(scale),
      rounding,
    );
    return new Money(rounded, this.currency);
  }

  // -------------------------------------------------------------- allocation

  /**
   * Split this amount across `ratios` so that the parts sum **exactly** back to
   * the original — BR-CORE-002.
   *
   * No minor unit is lost or invented: each part takes its exact integer share,
   * and the remainder is handed out one minor unit at a time to the **largest
   * ratios first**, as the SRS specifies.
   *
   * Negative amounts allocate symmetrically: the sign is lifted out, the
   * magnitude is split, and the sign is restored, so the exact-sum invariant
   * holds for both signs.
   *
   * IMPLEMENTATION CHOICE, NOT AN SRS RULE — the SRS says "largest ratios
   * first" but does not say how to order *equal* ratios. This implementation
   * breaks that tie by original index (stable, lowest index first). It is
   * recorded as a local decision rather than a source requirement, and it is
   * deterministic and trivially reproducible in Dart, so it does not compromise
   * the BR-FIN-005 conformance obligation.
   *
   * @throws MoneyError on an empty ratio set, a negative ratio, or ratios that
   *         sum to zero — each would otherwise yield a corrupt split.
   */
  allocate(ratios: readonly Ratio[]): Money[] {
    if (ratios.length === 0) {
      throw new MoneyError('allocate requires at least one ratio.');
    }

    // Normalise every ratio onto a common scale so the weights are exact integers.
    const parsed = ratios.map((r) => parseExactDecimal(r));
    const maxScale = parsed.reduce((m, p) => Math.max(m, p.scale), 0);
    const weights = parsed.map((p) => p.unscaled * pow10(maxScale - p.scale));

    if (weights.some((w) => w < 0n)) {
      throw new MoneyError('allocate ratios must not be negative.');
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0n);
    if (totalWeight === 0n) {
      throw new MoneyError('allocate ratios must not sum to zero.');
    }

    const negative = this.amount < 0n;
    const magnitude = negative ? -this.amount : this.amount;

    // Exact integer share for each part; the shortfall is the remainder.
    const parts = weights.map((w) => (magnitude * w) / totalWeight);
    let remainder = magnitude - parts.reduce((a, b) => a + b, 0n);

    // Largest ratios first (BR-CORE-002); ties by original index (local choice).
    const order = weights
      .map((weight, index) => ({ weight, index }))
      .sort((a, b) =>
        a.weight === b.weight
          ? a.index - b.index
          : a.weight > b.weight
            ? -1
            : 1,
      );

    for (let i = 0; remainder > 0n; i = (i + 1) % order.length) {
      parts[order[i].index] += 1n;
      remainder -= 1n;
    }

    return parts.map((p) => new Money(negative ? -p : p, this.currency));
  }

  // ------------------------------------------------------------ presentation

  /**
   * Decimal rendering using the currency's own exponent — `1250n` EGP renders
   * `"12.50"`, `1250n` JPY renders `"1250"`, `1250n` KWD renders `"1.250"`.
   *
   * String formatting only: it never re-enters arithmetic.
   */
  toDecimalString(): string {
    const { exponent } = this.currency;
    const negative = this.amount < 0n;
    const digits = (negative ? -this.amount : this.amount).toString();

    if (exponent === 0) {
      return negative ? `-${digits}` : digits;
    }
    const padded = digits.padStart(exponent + 1, '0');
    const whole = padded.slice(0, padded.length - exponent);
    const fraction = padded.slice(padded.length - exponent);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency.code}`;
  }

  /** Serialisation-safe shape: the amount stays a string, never a `number`. */
  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount.toString(), currency: this.currency.code };
  }
}

function resolveCurrency(currency: Currency | string): Currency {
  return typeof currency === 'string' ? currencyOf(currency) : currency;
}

/** Sum a same-currency series. Empty input is rejected: the currency is unknown. */
export function sumMoney(values: readonly Money[]): Money {
  if (values.length === 0) {
    throw new MoneyError(
      'sumMoney requires at least one value — the currency cannot be inferred from nothing.',
    );
  }
  return values.reduce((a, b) => a.plus(b));
}
