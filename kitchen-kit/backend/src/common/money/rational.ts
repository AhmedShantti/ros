/**
 * Exact rational arithmetic on `bigint` — the primitive BR-MNU-003 needs.
 *
 * BR-FIN-001 requires percentage computations to be carried at FULL precision
 * and rounded EXACTLY ONCE. `divideRounded` already gives that for a single
 * division, but a recipe cost is a CHAIN: quantity, a unit conversion, a wastage
 * uplift, a yield divisor and a recursive sub-recipe, each an exact decimal.
 * Rounding anywhere in that chain would put a fabricated fraction of a piastre
 * into every sale, multiplied by every ingredient. So the whole chain is carried
 * as `num / den` and rounded once, at the end, by the caller.
 *
 * Every value is reduced by its GCD after each operation. That is not cosmetic:
 * a ten-deep sub-recipe expansion multiplies denominators, and without reduction
 * the numbers grow until the arithmetic — while still exact — becomes slow.
 *
 * There is no floating point in this file, and no `Number` ever holds a value
 * that participates in a result.
 */

import { ExactDecimal, RoundingMode, divideRounded, pow10 } from './rounding';

export class RationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RationalError';
  }
}

/** An exact rational. `den` is always positive; the sign rides on `num`. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Build a reduced rational. */
export function rational(num: bigint, den: bigint = 1n): Rational {
  if (den === 0n)
    throw new RationalError('Rational denominator must not be zero.');
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return { num: 0n, den: 1n };
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

export const ZERO: Rational = { num: 0n, den: 1n };
export const ONE: Rational = { num: 1n, den: 1n };

/** An exact decimal (`unscaled × 10^-scale`) as a rational. */
export function fromExactDecimal(value: ExactDecimal): Rational {
  return rational(value.unscaled, pow10(value.scale));
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function subtract(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function multiply(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function divide(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new RationalError('Division by a zero rational.');
  return rational(a.num * b.den, a.den * b.num);
}

export function isZero(value: Rational): boolean {
  return value.num === 0n;
}

export function isNegative(value: Rational): boolean {
  return value.num < 0n;
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * THE rounding point. Collapse the exact rational to whole minor units, rounding
 * once with the supplied mode.
 */
export function toMinorUnits(
  value: Rational,
  mode: RoundingMode = RoundingMode.HALF_UP,
): bigint {
  return divideRounded(value.num, value.den, mode);
}

/** Diagnostic rendering. Never used in a computation. */
export function toString(value: Rational): string {
  return value.den === 1n ? value.num.toString() : `${value.num}/${value.den}`;
}
