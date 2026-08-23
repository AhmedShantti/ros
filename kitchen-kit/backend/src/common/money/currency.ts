/**
 * Currency — SRS §7.2 shared kernel, ADR-008.
 *
 * A currency is an ISO-4217 code plus its exponent (the number of decimal places
 * in its minor unit). ADR-008 is explicit that the exponent MUST NOT be assumed
 * to be 2: JPY has 0, and KWD/BHD/OMR/JOD/TND have 3. Every monetary amount in
 * ROS is an integer count of minor units, so the exponent is what gives that
 * integer meaning.
 *
 * There was no existing Currency abstraction in the repository — the schema
 * carries bare `CHAR(3)` codes (`Branch.baseCurrency`, `PriceEntry.currency`) —
 * so this is the first one and nothing competes with it.
 *
 * The exponent table below is ISO-4217 reference data, not jurisdiction policy.
 * It is deliberately NOT a country pack: no tax rule, rounding point or fiscal
 * behaviour lives here (ADR-005 keeps those as data, elsewhere).
 */

/** Raised when a currency cannot be constructed or two currencies conflict. */
export class CurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyError';
  }
}

/**
 * ISO-4217 minor-unit exponents for currencies that are NOT the 2-decimal
 * default. Listing only the exceptions keeps the table small and honest;
 * `DEFAULT_EXPONENT` covers the rest.
 */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
  // Zero-decimal currencies.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal currencies.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Four-decimal currencies.
  CLF: 4,
  UYW: 4,
});

/** The ISO-4217 majority case. Never assume it — always resolve via {@link currencyOf}. */
const DEFAULT_EXPONENT = 2;

const CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * An ISO-4217 currency. Immutable; construct via {@link currencyOf} or
 * {@link currencyWithExponent}.
 */
export class Currency {
  private constructor(
    /** Upper-case ISO-4217 alphabetic code, e.g. `EGP`. */
    readonly code: string,
    /** Minor-unit exponent: 2 for EGP, 0 for JPY, 3 for KWD. */
    readonly exponent: number,
  ) {
    Object.freeze(this);
  }

  /** @internal — use {@link currencyOf} / {@link currencyWithExponent}. */
  static create(code: string, exponent: number): Currency {
    const normalised = code.trim().toUpperCase();
    if (!CODE_PATTERN.test(normalised)) {
      throw new CurrencyError(
        `Invalid ISO-4217 code: ${JSON.stringify(code)}. Expected three letters.`,
      );
    }
    if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
      throw new CurrencyError(
        `Invalid minor-unit exponent for ${normalised}: ${exponent}. Expected 0–4.`,
      );
    }
    return new Currency(normalised, exponent);
  }

  /** True when both the code and the exponent match. */
  equals(other: Currency): boolean {
    return this.code === other.code && this.exponent === other.exponent;
  }

  toString(): string {
    return this.code;
  }
}

/**
 * Resolve a currency from its ISO-4217 code, taking the exponent from the
 * reference table (2 unless the code is a known exception).
 */
export function currencyOf(code: string): Currency {
  const normalised = code.trim().toUpperCase();
  const exponent = EXPONENT_OVERRIDES[normalised] ?? DEFAULT_EXPONENT;
  return Currency.create(normalised, exponent);
}

/**
 * Build a currency with an explicit exponent, for codes the reference table does
 * not cover or where a caller holds authoritative configuration.
 */
export function currencyWithExponent(code: string, exponent: number): Currency {
  return Currency.create(code, exponent);
}

/**
 * Assert that two currencies are the same.
 *
 * BR-CORE-001: arithmetic between different currencies SHALL raise an error, and
 * there is no implicit conversion. This is the single chokepoint enforcing it.
 */
export function assertSameCurrency(a: Currency, b: Currency): void {
  if (!a.equals(b)) {
    throw new CurrencyError(
      `Currency mismatch: ${a.code} and ${b.code}. ` +
        'BR-CORE-001 forbids implicit conversion — convert explicitly first.',
    );
  }
}
