/**
 * Rounding primitives — SRS §16.7 (BR-FIN-001, BR-FIN-002).
 *
 * BR-FIN-001 requires percentage computations (tax, discount, service charge) to
 * be carried at FULL decimal precision and rounded EXACTLY ONCE, at the point the
 * country pack specifies. The primitive that makes that possible is exact
 * rational division: callers accumulate a numerator/denominator pair at full
 * precision and call {@link divideRounded} once, at the end.
 *
 * BR-FIN-002 makes `HALF_UP` the default and lets a country pack override it, so
 * the mode is always an explicit parameter — it is deliberately NOT baked in.
 * The country-pack rounding *point* is not implemented here; this module only
 * supplies the reusable operation it will call.
 *
 * Everything is `bigint`. There is no floating-point arithmetic anywhere in this
 * file (ADR-008), and no `Number` value ever participates in a monetary result.
 *
 * Determinism (ADR-004 / BR-FIN-005 / FR-OFF-050): every operation here is exact
 * integer arithmetic with explicit tie rules, so a Dart implementation can
 * reproduce it bit-for-bit. Nothing depends on locale, clock or platform.
 */

/**
 * Rounding modes. `HALF_UP` is the BR-FIN-002 default; the others exist so a
 * country pack can override it without this module changing.
 *
 * `HALF_*` modes differ only in how an exact .5 tie is broken. `UP`/`DOWN` are
 * magnitude-relative (away from / toward zero); `CEILING`/`FLOOR` are
 * sign-relative (toward +∞ / −∞).
 */
export enum RoundingMode {
  /** Ties away from zero. 2.5 → 3, −2.5 → −3. BR-FIN-002 default. */
  HALF_UP = 'HALF_UP',
  /** Ties toward zero. 2.5 → 2, −2.5 → −2. */
  HALF_DOWN = 'HALF_DOWN',
  /** Ties to the even neighbour. 2.5 → 2, 3.5 → 4. "Banker's rounding". */
  HALF_EVEN = 'HALF_EVEN',
  /** Always away from zero. 2.1 → 3, −2.1 → −3. */
  UP = 'UP',
  /** Always toward zero (truncate). 2.9 → 2, −2.9 → −2. */
  DOWN = 'DOWN',
  /** Always toward +∞. 2.1 → 3, −2.9 → −2. */
  CEILING = 'CEILING',
  /** Always toward −∞. 2.9 → 2, −2.1 → −3. */
  FLOOR = 'FLOOR',
}

/** BR-FIN-002: the system default, overridable per country pack. */
export const DEFAULT_ROUNDING_MODE = RoundingMode.HALF_UP;

/** Raised for arithmetic that cannot yield a correct result. */
export class RoundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundingError';
  }
}

/**
 * Divide `numerator` by `denominator` exactly, then round to an integer using
 * `mode`. This is the single rounding point BR-FIN-001 requires: callers keep
 * full precision in the rational and round here, once.
 *
 * The sign is handled by working on magnitudes and re-applying it, so every mode
 * behaves symmetrically and predictably for negative values.
 *
 * @throws RoundingError when `denominator` is zero.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = DEFAULT_ROUNDING_MODE,
): bigint {
  if (denominator === 0n) {
    throw new RoundingError('Division by zero.');
  }

  // Normalise so the denominator is positive; the sign rides on `negative`.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const magnitude = negative ? -n : n;

  const quotient = magnitude / d; // truncating division on non-negative values
  const remainder = magnitude % d;

  if (remainder === 0n) {
    return negative ? -quotient : quotient;
  }

  // `twice` compares the remainder against the half-way point without ever
  // leaving integer arithmetic: twice < d ⇒ below .5, === d ⇒ exactly .5.
  const twice = remainder * 2n;
  let roundAwayFromZero: boolean;

  switch (mode) {
    case RoundingMode.HALF_UP:
      roundAwayFromZero = twice >= d;
      break;
    case RoundingMode.HALF_DOWN:
      roundAwayFromZero = twice > d;
      break;
    case RoundingMode.HALF_EVEN:
      roundAwayFromZero = twice > d || (twice === d && quotient % 2n === 1n);
      break;
    case RoundingMode.UP:
      roundAwayFromZero = true;
      break;
    case RoundingMode.DOWN:
      roundAwayFromZero = false;
      break;
    case RoundingMode.CEILING:
      roundAwayFromZero = !negative;
      break;
    case RoundingMode.FLOOR:
      roundAwayFromZero = negative;
      break;
    default:
      throw new RoundingError(`Unsupported rounding mode: ${String(mode)}`);
  }

  const rounded = roundAwayFromZero ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Exact decimal literal, decomposed as `unscaled × 10^-scale`. */
export interface ExactDecimal {
  readonly unscaled: bigint;
  readonly scale: number;
}

/** Guards against absurd scales that would only ever indicate a caller bug. */
const MAX_SCALE = 30;

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse a decimal string into exact `unscaled`/`scale` components.
 *
 * Deliberately strict: plain decimal notation only. Exponent notation
 * (`1e-3`), `Infinity` and `NaN` are rejected rather than coerced, because a
 * factor that cannot be represented exactly must never silently enter a
 * monetary computation (ADR-008).
 *
 * `bigint` input is accepted as an exact integer with scale 0.
 */
export function parseExactDecimal(value: bigint | string): ExactDecimal {
  if (typeof value === 'bigint') {
    return { unscaled: value, scale: 0 };
  }

  const text = value.trim();
  if (!DECIMAL_PATTERN.test(text)) {
    throw new RoundingError(
      `Not an exact decimal literal: ${JSON.stringify(value)}. ` +
        'Use plain decimal notation, e.g. "0.15"; exponent notation is not accepted.',
    );
  }

  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');

  if (fraction.length > MAX_SCALE) {
    throw new RoundingError(
      `Decimal scale ${fraction.length} exceeds the maximum of ${MAX_SCALE}.`,
    );
  }

  const digits = `${whole}${fraction}` || '0';
  const unscaled = BigInt(digits);
  return {
    unscaled: negative ? -unscaled : unscaled,
    scale: fraction.length,
  };
}

/** 10^n as a bigint, without floating-point exponentiation. */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) {
    throw new RoundingError(`pow10 requires a non-negative integer, got ${n}.`);
  }
  return 10n ** BigInt(n);
}
