import {
  Currency,
  CurrencyError,
  currencyOf,
  currencyWithExponent,
} from './currency';
import { Money, MoneyError, sumMoney } from './money';
import { RoundingMode } from './rounding';

const EGP = currencyOf('EGP'); // exponent 2
const JPY = currencyOf('JPY'); // exponent 0
const KWD = currencyOf('KWD'); // exponent 3

describe('ADR-008 — currency exponent is never assumed to be 2', () => {
  it('resolves a 2-decimal currency', () => {
    expect(EGP.exponent).toBe(2);
    expect(Money.of(1250n, EGP).toDecimalString()).toBe('12.50');
  });

  it('resolves a 0-decimal currency (JPY)', () => {
    expect(JPY.exponent).toBe(0);
    expect(Money.of(1250n, JPY).toDecimalString()).toBe('1250');
  });

  it('resolves a 3-decimal currency (KWD)', () => {
    expect(KWD.exponent).toBe(3);
    expect(Money.of(1250n, KWD).toDecimalString()).toBe('1.250');
  });

  it.each([
    ['BHD', 3],
    ['OMR', 3],
    ['KRW', 0],
    ['VND', 0],
    ['USD', 2],
    ['SAR', 2],
  ])('%s has exponent %i', (code, exponent) => {
    expect(currencyOf(code).exponent).toBe(exponent);
  });

  it('accepts an explicit exponent for codes outside the reference table', () => {
    expect(currencyWithExponent('XYZ', 3).exponent).toBe(3);
  });

  it('rejects a malformed code or an implausible exponent', () => {
    expect(() => currencyOf('EG')).toThrow(CurrencyError);
    expect(() => currencyOf('12X')).toThrow(CurrencyError);
    expect(() => currencyWithExponent('EGP', 9)).toThrow(CurrencyError);
    expect(() => currencyWithExponent('EGP', -1)).toThrow(CurrencyError);
  });
});

describe('construction and queries', () => {
  it('builds from minor units and from a bare ISO code', () => {
    expect(Money.of(500n, 'EGP').amount).toBe(500n);
    expect(Money.of(500n, EGP).currency.code).toBe('EGP');
  });

  it('zero', () => {
    const z = Money.zero('EGP');
    expect(z.amount).toBe(0n);
    expect(z.isZero()).toBe(true);
    expect(z.isNegative()).toBe(false);
  });

  it('negative values', () => {
    const m = Money.of(-250n, 'EGP');
    expect(m.isNegative()).toBe(true);
    expect(m.isPositive()).toBe(false);
    expect(m.toDecimalString()).toBe('-2.50');
    expect(m.abs().amount).toBe(250n);
    expect(m.negated().amount).toBe(250n);
  });

  it('refuses a number amount — floats must not enter money (ADR-008)', () => {
    expect(() => Money.of(12.5 as unknown as bigint, 'EGP')).toThrow(
      MoneyError,
    );
    expect(() => Money.of(12 as unknown as bigint, 'EGP')).toThrow(MoneyError);
  });

  it('is immutable', () => {
    const m = Money.of(100n, 'EGP');
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('serialises the amount as a string, never a number', () => {
    expect(Money.of(1250n, 'EGP').toJSON()).toEqual({
      amount: '1250',
      currency: 'EGP',
    });
  });
});

describe('BR-CORE-001 — no cross-currency arithmetic, no implicit conversion', () => {
  const egp = Money.of(1000n, 'EGP');
  const usd = Money.of(1000n, 'USD');

  it('addition across currencies fails', () => {
    expect(() => egp.plus(usd)).toThrow(CurrencyError);
  });

  it('subtraction across currencies fails', () => {
    expect(() => egp.minus(usd)).toThrow(CurrencyError);
  });

  it('comparison across currencies fails', () => {
    expect(() => egp.compare(usd)).toThrow(CurrencyError);
  });

  it('the error names both currencies and offers no conversion', () => {
    expect(() => egp.plus(usd)).toThrow(/EGP and USD/);
    expect(() => egp.plus(usd)).toThrow(/BR-CORE-001/);
  });

  it('two currencies with the same code but different exponents are not equal', () => {
    const a = currencyWithExponent('XYZ', 2);
    const b = currencyWithExponent('XYZ', 3);
    expect(() => Money.of(1n, a).plus(Money.of(1n, b))).toThrow(CurrencyError);
  });

  it('same-currency arithmetic works and preserves currency', () => {
    const sum = Money.of(1000n, 'EGP').plus(Money.of(250n, 'EGP'));
    expect(sum.amount).toBe(1250n);
    expect(sum.currency.code).toBe('EGP');

    const diff = Money.of(1000n, 'EGP').minus(Money.of(250n, 'EGP'));
    expect(diff.amount).toBe(750n);
  });

  it('sumMoney folds a same-currency series and rejects an empty one', () => {
    expect(
      sumMoney([Money.of(1n, 'EGP'), Money.of(2n, 'EGP'), Money.of(3n, 'EGP')])
        .amount,
    ).toBe(6n);
    expect(() => sumMoney([])).toThrow(MoneyError);
  });
});

describe('times — exact decimal multiplication, one rounding point', () => {
  it('multiplies by an exact decimal factor without floating point', () => {
    // 15% of 12.50 EGP = 1.875 → HALF_UP → 1.88
    expect(Money.of(1250n, 'EGP').times('0.15').amount).toBe(188n);
  });

  it('honours the rounding mode (BR-FIN-002 override path)', () => {
    const m = Money.of(1250n, 'EGP');
    expect(m.times('0.15', RoundingMode.HALF_UP).amount).toBe(188n);
    expect(m.times('0.15', RoundingMode.DOWN).amount).toBe(187n);
    expect(m.times('0.15', RoundingMode.HALF_EVEN).amount).toBe(188n);
  });

  it('accepts an integer factor', () => {
    expect(Money.of(300n, 'EGP').times(3n).amount).toBe(900n);
  });

  it('rejects an inexact factor rather than coercing it', () => {
    expect(() => Money.of(100n, 'EGP').times('1e-2')).toThrow();
    expect(() =>
      Money.of(100n, 'EGP').times(0.15 as unknown as string),
    ).toThrow();
  });

  it('preserves currency', () => {
    expect(Money.of(100n, 'KWD').times('0.5').currency.code).toBe('KWD');
  });

  it('is exact where a float would drift', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; the exact path has no such error.
    const a = Money.of(10n, 'EGP').times('0.1'); // 1
    const b = Money.of(10n, 'EGP').times('0.2'); // 2
    expect(a.plus(b).amount).toBe(3n);
  });
});

describe('BR-CORE-002 — allocate is exact', () => {
  it('splits evenly when it divides cleanly', () => {
    const parts = Money.of(1000n, 'EGP').allocate([1n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([500n, 500n]);
  });

  it('distributes an indivisible remainder — the classic 100/3 case', () => {
    // 33.33 + 33.33 + 33.33 = 99.99 loses a minor unit; allocate must not.
    const parts = Money.of(10000n, 'EGP').allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([3334n, 3333n, 3333n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(10000n);
  });

  it('gives remainder units to the largest ratios first', () => {
    // 10 minor units across 1:2:4 → exact shares 1.43 / 2.86 / 5.71
    // floors 1 / 2 / 5 leave 2 units, which go to the two largest ratios.
    const parts = Money.of(10n, 'EGP').allocate([1n, 2n, 4n]);
    expect(parts.map((p) => p.amount)).toEqual([1n, 3n, 6n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(10n);
  });

  it('handles unequal ratios exactly', () => {
    const parts = Money.of(10000n, 'EGP').allocate([3n, 7n]);
    expect(parts.map((p) => p.amount)).toEqual([3000n, 7000n]);
  });

  it('accepts decimal ratios', () => {
    const parts = Money.of(10000n, 'EGP').allocate(['0.25', '0.75']);
    expect(parts.map((p) => p.amount)).toEqual([2500n, 7500n]);
  });

  it('allocates a negative amount symmetrically and exactly', () => {
    const parts = Money.of(-10000n, 'EGP').allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([-3334n, -3333n, -3333n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(-10000n);
  });

  it('allocates zero', () => {
    const parts = Money.of(0n, 'EGP').allocate([1n, 2n]);
    expect(parts.map((p) => p.amount)).toEqual([0n, 0n]);
  });

  it('tolerates a zero ratio among non-zero ones', () => {
    const parts = Money.of(100n, 'EGP').allocate([0n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([0n, 100n]);
  });

  it('breaks equal-ratio ties by original index (local choice, not an SRS rule)', () => {
    const parts = Money.of(10n, 'EGP').allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([4n, 3n, 3n]);
  });

  it('preserves currency on every part', () => {
    const parts = Money.of(1000n, 'KWD').allocate([1n, 1n, 1n]);
    expect(parts.every((p) => p.currency.code === 'KWD')).toBe(true);
    expect(parts).toHaveLength(3);
  });

  it('works for a 0-decimal currency', () => {
    const parts = Money.of(100n, 'JPY').allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.amount)).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(100n);
  });

  it('rejects input that would corrupt the split', () => {
    const m = Money.of(100n, 'EGP');
    expect(() => m.allocate([])).toThrow(MoneyError);
    expect(() => m.allocate([0n, 0n])).toThrow(MoneyError);
    expect(() => m.allocate([1n, -1n])).toThrow(MoneyError);
  });

  it('handles very large values exactly, far beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n * 1000n; // > 2^53
    const parts = Money.of(huge, 'EGP').allocate([1n, 1n, 1n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(huge);
  });
});

describe('BR-CORE-002 invariant — sum(allocate(r)) === original, exhaustively', () => {
  const ratioSets: bigint[][] = [
    [1n, 1n],
    [1n, 1n, 1n],
    [1n, 2n],
    [1n, 2n, 4n],
    [3n, 7n],
    [1n, 1n, 1n, 1n, 1n, 1n, 1n],
    [5n, 3n, 2n],
    [1n, 999n],
  ];

  it('holds across many amounts, ratio sets and currencies', () => {
    for (const currency of ['EGP', 'JPY', 'KWD']) {
      for (const ratios of ratioSets) {
        for (let amount = -250n; amount <= 250n; amount += 1n) {
          const parts = Money.of(amount, currency).allocate(ratios);
          const total = parts.reduce((a, p) => a + p.amount, 0n);
          expect(total).toBe(amount);
          expect(parts).toHaveLength(ratios.length);
          expect(parts.every((p) => p.currency.code === currency)).toBe(true);
        }
      }
    }
  });

  it('holds for large pseudo-random amounts with a fixed seed (deterministic)', () => {
    // Deterministic LCG — no Math.random, so this test is reproducible and
    // mirrors what a Dart conformance run would do.
    let seed = 123_456_789n;
    const next = (): bigint => {
      seed = (seed * 1_103_515_245n + 12_345n) % 2_147_483_648n;
      return seed;
    };
    for (let i = 0; i < 500; i++) {
      const amount = next() - 1_073_741_824n;
      const ratios = ratioSets[Number(next() % BigInt(ratioSets.length))];
      const parts = Money.of(amount, 'EGP').allocate(ratios);
      expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(amount);
    }
  });
});

describe('BR-FIN-003 primitive — discount distribution relies on allocate', () => {
  it('distributes a discount across line totals so the parts sum exactly', () => {
    // A 10.00 EGP order discount across lines of 12.50 / 7.50 / 5.00.
    const discount = Money.of(1000n, 'EGP');
    const parts = discount.allocate([1250n, 750n, 500n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(1000n);
    expect(parts.map((p) => p.amount)).toEqual([500n, 300n, 200n]);
  });

  it('still sums exactly when the split does not divide cleanly', () => {
    const discount = Money.of(1000n, 'EGP');
    const parts = discount.allocate([333n, 333n, 334n]);
    expect(parts.reduce((a, p) => a + p.amount, 0n)).toBe(1000n);
  });
});

describe('presentation', () => {
  it('renders using the currency exponent', () => {
    expect(Money.of(5n, 'EGP').toDecimalString()).toBe('0.05');
    expect(Money.of(5n, 'KWD').toDecimalString()).toBe('0.005');
    expect(Money.of(5n, 'JPY').toDecimalString()).toBe('5');
    expect(Money.of(-5n, 'EGP').toDecimalString()).toBe('-0.05');
    expect(Money.of(0n, 'EGP').toDecimalString()).toBe('0.00');
  });

  it('toString appends the code', () => {
    expect(Money.of(1250n, 'EGP').toString()).toBe('12.50 EGP');
  });
});

describe('equality and comparison', () => {
  it('equals requires both amount and currency', () => {
    expect(Money.of(1n, 'EGP').equals(Money.of(1n, 'EGP'))).toBe(true);
    expect(Money.of(1n, 'EGP').equals(Money.of(2n, 'EGP'))).toBe(false);
    expect(Money.of(1n, 'EGP').equals(Money.of(1n, 'USD'))).toBe(false);
  });

  it('compare orders same-currency values', () => {
    expect(Money.of(1n, 'EGP').compare(Money.of(2n, 'EGP'))).toBe(-1);
    expect(Money.of(2n, 'EGP').compare(Money.of(1n, 'EGP'))).toBe(1);
    expect(Money.of(1n, 'EGP').compare(Money.of(1n, 'EGP'))).toBe(0);
  });
});

describe('Currency value object', () => {
  it('is immutable and compares by code and exponent', () => {
    expect(Object.isFrozen(EGP)).toBe(true);
    expect(EGP.equals(currencyOf('egp'))).toBe(true);
    expect(EGP.equals(JPY)).toBe(false);
  });

  it('normalises case and whitespace', () => {
    expect(currencyOf(' egp ').code).toBe('EGP');
  });

  it('exposes a Currency instance from Money', () => {
    expect(Money.of(1n, 'EGP').currency).toBeInstanceOf(Currency);
  });
});
