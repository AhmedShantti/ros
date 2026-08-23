import {
  DEFAULT_ROUNDING_MODE,
  RoundingError,
  RoundingMode,
  divideRounded,
  parseExactDecimal,
  pow10,
} from './rounding';

describe('BR-FIN-002 default rounding mode', () => {
  it('is HALF_UP', () => {
    expect(DEFAULT_ROUNDING_MODE).toBe(RoundingMode.HALF_UP);
  });

  it('is not baked into divideRounded — the mode is always overridable', () => {
    // Same input, different country-pack mode, different result.
    expect(divideRounded(5n, 2n)).toBe(3n); // HALF_UP by default
    expect(divideRounded(5n, 2n, RoundingMode.HALF_EVEN)).toBe(2n);
    expect(divideRounded(5n, 2n, RoundingMode.DOWN)).toBe(2n);
  });
});

describe('divideRounded — exact division rounds away cleanly', () => {
  it('returns the exact quotient when there is no remainder', () => {
    expect(divideRounded(100n, 4n)).toBe(25n);
    expect(divideRounded(-100n, 4n)).toBe(-25n);
  });

  it('throws on division by zero', () => {
    expect(() => divideRounded(1n, 0n)).toThrow(RoundingError);
  });

  it('normalises a negative denominator', () => {
    expect(divideRounded(5n, -2n)).toBe(-3n);
    expect(divideRounded(-5n, -2n)).toBe(3n);
  });
});

describe('divideRounded — HALF_UP (positive and negative midpoints)', () => {
  it('rounds a positive midpoint away from zero', () => {
    expect(divideRounded(5n, 2n, RoundingMode.HALF_UP)).toBe(3n); // 2.5 → 3
  });

  it('rounds a negative midpoint away from zero', () => {
    expect(divideRounded(-5n, 2n, RoundingMode.HALF_UP)).toBe(-3n); // −2.5 → −3
  });

  it('leaves sub-midpoint values alone', () => {
    expect(divideRounded(4n, 3n, RoundingMode.HALF_UP)).toBe(1n); // 1.33 → 1
    expect(divideRounded(-4n, 3n, RoundingMode.HALF_UP)).toBe(-1n);
  });

  it('rounds above the midpoint', () => {
    expect(divideRounded(5n, 3n, RoundingMode.HALF_UP)).toBe(2n); // 1.67 → 2
  });
});

describe('divideRounded — the other modes a country pack may select', () => {
  const cases: Array<[RoundingMode, bigint, bigint, bigint]> = [
    [RoundingMode.HALF_DOWN, 5n, 2n, 2n], //  2.5 → 2
    [RoundingMode.HALF_DOWN, -5n, 2n, -2n], // −2.5 → −2
    [RoundingMode.HALF_EVEN, 5n, 2n, 2n], //  2.5 → 2 (even)
    [RoundingMode.HALF_EVEN, 7n, 2n, 4n], //  3.5 → 4 (even)
    [RoundingMode.HALF_EVEN, -5n, 2n, -2n],
    [RoundingMode.UP, 1n, 3n, 1n], //  0.33 → 1
    [RoundingMode.UP, -1n, 3n, -1n], // −0.33 → −1
    [RoundingMode.DOWN, 29n, 10n, 2n], //  2.9 → 2
    [RoundingMode.DOWN, -29n, 10n, -2n], // −2.9 → −2
    [RoundingMode.CEILING, 21n, 10n, 3n], //  2.1 → 3
    [RoundingMode.CEILING, -29n, 10n, -2n], // −2.9 → −2
    [RoundingMode.FLOOR, 29n, 10n, 2n], //  2.9 → 2
    [RoundingMode.FLOOR, -21n, 10n, -3n], // −2.1 → −3
  ];

  it.each(cases)('%s: %s/%s → %s', (mode, n, d, expected) => {
    expect(divideRounded(n, d, mode)).toBe(expected);
  });
});

describe('BR-FIN-001 — full precision, rounded exactly once', () => {
  it('rounding once yields a different answer than rounding at each step', () => {
    // 5 minor units × 50% × 50%.
    //
    // Carried at full precision and rounded ONCE — the BR-FIN-001 rule:
    //   5 × 5 × 5 / (10 × 10) = 125/100 = 1.25 → HALF_UP → 1
    const single = divideRounded(5n * 5n * 5n, 10n * 10n);
    expect(single).toBe(1n);

    // Rounding after each step instead:
    //   5 × 50% = 2.5 → 3 ; 3 × 50% = 1.5 → 2
    const step1 = divideRounded(5n * 5n, 10n);
    const step2 = divideRounded(step1 * 5n, 10n);
    expect(step1).toBe(3n);
    expect(step2).toBe(2n);

    // The two disagree by a whole minor unit. This is exactly the error
    // BR-FIN-001 exists to prevent, and why the primitive takes a rational
    // rather than a pre-rounded intermediate.
    expect(single).not.toBe(step2);
  });

  it('carries an exact rational without any intermediate float', () => {
    // 1/3 of 10_000 minor units, exact, rounded once.
    expect(divideRounded(10000n, 3n)).toBe(3333n);
    // The same computation via JS floats would produce 3333.3333333333335.
    expect(Number.isInteger(Number(divideRounded(10000n, 3n)))).toBe(true);
  });
});

describe('parseExactDecimal', () => {
  it('parses plain decimals exactly', () => {
    expect(parseExactDecimal('0.15')).toEqual({ unscaled: 15n, scale: 2 });
    expect(parseExactDecimal('1.0825')).toEqual({ unscaled: 10825n, scale: 4 });
    expect(parseExactDecimal('12')).toEqual({ unscaled: 12n, scale: 0 });
    expect(parseExactDecimal('.5')).toEqual({ unscaled: 5n, scale: 1 });
  });

  it('parses signs', () => {
    expect(parseExactDecimal('-0.15')).toEqual({ unscaled: -15n, scale: 2 });
    expect(parseExactDecimal('+2.5')).toEqual({ unscaled: 25n, scale: 1 });
  });

  it('accepts bigint as an exact integer', () => {
    expect(parseExactDecimal(7n)).toEqual({ unscaled: 7n, scale: 0 });
  });

  it('rejects anything that cannot be represented exactly', () => {
    // Exponent notation, non-numerics and floats-as-text are all refused rather
    // than coerced — a factor must never enter money arithmetic inexactly.
    for (const bad of ['1e-3', 'NaN', 'Infinity', '', 'abc', '1.2.3', '1,5']) {
      expect(() => parseExactDecimal(bad)).toThrow(RoundingError);
    }
  });

  it('rejects an absurd scale', () => {
    expect(() => parseExactDecimal(`0.${'1'.repeat(31)}`)).toThrow(
      RoundingError,
    );
  });
});

describe('pow10', () => {
  it('produces exact powers with no floating-point exponentiation', () => {
    expect(pow10(0)).toBe(1n);
    expect(pow10(4)).toBe(10000n);
    // 10^25 is far beyond Number.MAX_SAFE_INTEGER and must still be exact.
    expect(pow10(25)).toBe(10000000000000000000000000n);
  });

  it('rejects a negative or fractional exponent', () => {
    expect(() => pow10(-1)).toThrow(RoundingError);
    expect(() => pow10(1.5)).toThrow(RoundingError);
  });
});
