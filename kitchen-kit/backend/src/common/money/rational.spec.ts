import {
  RationalError,
  add,
  compare,
  divide,
  fromExactDecimal,
  multiply,
  rational,
  subtract,
  toMinorUnits,
  toString,
} from './rational';
import { RoundingMode, parseExactDecimal } from './rounding';

const dec = (value: string) => fromExactDecimal(parseExactDecimal(value));

describe('Exact rational arithmetic', () => {
  it('reduces on construction', () => {
    expect(rational(4n, 8n)).toEqual({ num: 1n, den: 2n });
    expect(rational(-6n, 9n)).toEqual({ num: -2n, den: 3n });
  });

  it('normalises a negative denominator onto the numerator', () => {
    expect(rational(1n, -2n)).toEqual({ num: -1n, den: 2n });
  });

  it('collapses zero to a canonical form', () => {
    expect(rational(0n, 7n)).toEqual({ num: 0n, den: 1n });
  });

  it('rejects a zero denominator rather than producing an infinity', () => {
    expect(() => rational(1n, 0n)).toThrow(RationalError);
    expect(() => divide(rational(1n), rational(0n))).toThrow(RationalError);
  });

  it('converts an exact decimal without loss', () => {
    expect(dec('0.1')).toEqual({ num: 1n, den: 10n });
    expect(dec('12.345')).toEqual({ num: 2469n, den: 200n });
    expect(dec('-0.001')).toEqual({ num: -1n, den: 1000n });
  });

  it('adds thirds exactly', () => {
    const third = rational(1n, 3n);
    expect(add(add(third, third), third)).toEqual({ num: 1n, den: 1n });
    // A third is not representable in binary at all; the rational holds it as
    // 1/3 rather than as the nearest double.
    expect(third).toEqual({ num: 1n, den: 3n });
  });

  it('adds tenths exactly, where floating point cannot', () => {
    expect(add(dec('0.1'), dec('0.2'))).toEqual(dec('0.3'));
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('subtracts, multiplies and divides exactly', () => {
    expect(subtract(dec('1'), dec('0.75'))).toEqual({ num: 1n, den: 4n });
    expect(multiply(dec('1.5'), dec('4'))).toEqual({ num: 6n, den: 1n });
    expect(divide(dec('1'), dec('3'))).toEqual({ num: 1n, den: 3n });
  });

  it('stays exact across a long chain', () => {
    // A ten-deep chain of divisions and multiplications returns to its start.
    let value = rational(1n);
    for (let i = 1n; i <= 10n; i++) value = divide(value, rational(i));
    for (let i = 1n; i <= 10n; i++) value = multiply(value, rational(i));
    expect(value).toEqual({ num: 1n, den: 1n });
  });

  it('compares without materialising a quotient', () => {
    expect(compare(rational(1n, 3n), rational(1n, 2n))).toBe(-1);
    expect(compare(rational(1n, 2n), rational(2n, 4n))).toBe(0);
    expect(compare(rational(2n, 3n), rational(1n, 2n))).toBe(1);
  });

  it('rounds to minor units exactly once, with the given mode', () => {
    const twoThirds = rational(2n, 3n);
    expect(toMinorUnits(twoThirds)).toBe(1n);
    expect(toMinorUnits(twoThirds, RoundingMode.FLOOR)).toBe(0n);
    // An exact half breaks away from zero under the BR-FIN-002 default.
    expect(toMinorUnits(rational(1n, 2n))).toBe(1n);
    expect(toMinorUnits(rational(-1n, 2n))).toBe(-1n);
    expect(toMinorUnits(rational(1n, 2n), RoundingMode.HALF_EVEN)).toBe(0n);
  });

  it('handles magnitudes far beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n;
    expect(toMinorUnits(multiply(rational(huge), dec('1.5')))).toBe(
      13_510_798_882_111_490n,
    );
  });

  it('renders diagnostically without participating in arithmetic', () => {
    expect(toString(rational(3n))).toBe('3');
    expect(toString(rational(1n, 3n))).toBe('1/3');
  });
});
