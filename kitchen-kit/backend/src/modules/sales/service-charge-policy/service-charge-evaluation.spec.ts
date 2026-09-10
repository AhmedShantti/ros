import { Money } from '../../../common/money/money';
import {
  RoundingMode,
  parseExactDecimal,
} from '../../../common/money/rounding';
import type { ServiceChargePolicyRule } from './service-charge-policy-rules';
import {
  ServiceChargeRuleAmbiguityError,
  computeServiceChargeAmount,
  evaluateServiceChargeRule,
} from './service-charge-evaluation';

function rule(
  overrides: Partial<ServiceChargePolicyRule> = {},
): ServiceChargePolicyRule {
  return {
    orderType: overrides.orderType ?? null,
    minGuestCount: overrides.minGuestCount ?? null,
    ratePercent: overrides.ratePercent ?? '10',
  };
}

describe('evaluateServiceChargeRule (P2E rule matching)', () => {
  it('rules: [] => no match', () => {
    expect(
      evaluateServiceChargeRule([], { orderType: 'dine_in', guestCount: 4 }),
    ).toBeNull();
  });

  it('a wildcard rule (orderType: null, minGuestCount: null) matches any order', () => {
    const r = rule();
    expect(
      evaluateServiceChargeRule([r], {
        orderType: 'takeaway',
        guestCount: null,
      }),
    ).toBe(r);
  });

  it('matching orderType => the rule applies', () => {
    const r = rule({ orderType: 'dine_in' });
    expect(
      evaluateServiceChargeRule([r], {
        orderType: 'dine_in',
        guestCount: null,
      }),
    ).toBe(r);
  });

  it('non-matching orderType => no match', () => {
    const r = rule({ orderType: 'dine_in' });
    expect(
      evaluateServiceChargeRule([r], {
        orderType: 'takeaway',
        guestCount: null,
      }),
    ).toBeNull();
  });

  it('minGuestCount satisfied => the rule applies', () => {
    const r = rule({ minGuestCount: 6 });
    expect(
      evaluateServiceChargeRule([r], { orderType: 'dine_in', guestCount: 6 }),
    ).toBe(r);
    expect(
      evaluateServiceChargeRule([r], { orderType: 'dine_in', guestCount: 9 }),
    ).toBe(r);
  });

  it('minGuestCount not satisfied => no match', () => {
    const r = rule({ minGuestCount: 6 });
    expect(
      evaluateServiceChargeRule([r], { orderType: 'dine_in', guestCount: 5 }),
    ).toBeNull();
  });

  it('guestCount null does not satisfy a positive minimum', () => {
    const r = rule({ minGuestCount: 6 });
    expect(
      evaluateServiceChargeRule([r], {
        orderType: 'dine_in',
        guestCount: null,
      }),
    ).toBeNull();
  });

  it('guestCount null does not satisfy even a zero minimum — null means "unknown", not "zero"', () => {
    const r = rule({ minGuestCount: 0 });
    expect(
      evaluateServiceChargeRule([r], {
        orderType: 'dine_in',
        guestCount: null,
      }),
    ).toBeNull();
  });

  it('an orderType-specific rule outranks a wildcard rule that also matches', () => {
    const wildcard = rule({ ratePercent: '5' });
    const specific = rule({ orderType: 'dine_in', ratePercent: '12' });
    expect(
      evaluateServiceChargeRule([wildcard, specific], {
        orderType: 'dine_in',
        guestCount: null,
      }),
    ).toBe(specific);
    // Order in the array must not matter.
    expect(
      evaluateServiceChargeRule([specific, wildcard], {
        orderType: 'dine_in',
        guestCount: null,
      }),
    ).toBe(specific);
  });

  it('among same-orderType-specificity rules, the highest SATISFIED minGuestCount wins (graduated thresholds)', () => {
    const base = rule({
      orderType: 'dine_in',
      minGuestCount: null,
      ratePercent: '10',
    });
    const tier6 = rule({
      orderType: 'dine_in',
      minGuestCount: 6,
      ratePercent: '15',
    });
    const tier10 = rule({
      orderType: 'dine_in',
      minGuestCount: 10,
      ratePercent: '20',
    });
    const rules = [base, tier6, tier10];

    expect(
      evaluateServiceChargeRule(rules, { orderType: 'dine_in', guestCount: 3 }),
    ).toBe(base);
    expect(
      evaluateServiceChargeRule(rules, { orderType: 'dine_in', guestCount: 6 }),
    ).toBe(tier6);
    expect(
      evaluateServiceChargeRule(rules, { orderType: 'dine_in', guestCount: 9 }),
    ).toBe(tier6);
    expect(
      evaluateServiceChargeRule(rules, {
        orderType: 'dine_in',
        guestCount: 10,
      }),
    ).toBe(tier10);
    expect(
      evaluateServiceChargeRule(rules, {
        orderType: 'dine_in',
        guestCount: 100,
      }),
    ).toBe(tier10);
  });

  it('two rules identical on both discriminators is a genuine tie — throws, never array order', () => {
    const a = rule({
      orderType: 'dine_in',
      minGuestCount: 6,
      ratePercent: '10',
    });
    const b = rule({
      orderType: 'dine_in',
      minGuestCount: 6,
      ratePercent: '20',
    });
    expect(() =>
      evaluateServiceChargeRule([a, b], {
        orderType: 'dine_in',
        guestCount: 6,
      }),
    ).toThrow(ServiceChargeRuleAmbiguityError);
    expect(() =>
      evaluateServiceChargeRule([b, a], {
        orderType: 'dine_in',
        guestCount: 6,
      }),
    ).toThrow(ServiceChargeRuleAmbiguityError);
  });
});

describe('computeServiceChargeAmount (P2E exact-decimal, single-rounding-point money)', () => {
  it('computes an exact percentage of the base, rounded once at the pack precision', () => {
    const base = Money.of(10_000n, 'EGP'); // 100.00 EGP
    const rate = parseExactDecimal('12.5');
    const amount = computeServiceChargeAmount(
      base,
      rate.unscaled,
      rate.scale,
      RoundingMode.HALF_UP,
      2,
    );
    expect(amount.amount).toBe(1_250n); // 12.50 EGP
  });

  it('rounds HALF_UP at a tie', () => {
    // 33 minor units * 12.5% = 4.125 -> rounds to 4 at precision 2? Use a
    // case that lands exactly on .5 of a minor unit: base=1, rate=50%.
    const base = Money.of(1n, 'EGP');
    const rate = parseExactDecimal('50');
    const amount = computeServiceChargeAmount(
      base,
      rate.unscaled,
      rate.scale,
      RoundingMode.HALF_UP,
      2,
    );
    expect(amount.amount).toBe(1n); // 0.5 -> 1 (away from zero)
  });

  it('respects a non-default rounding mode from the pinned pack', () => {
    const base = Money.of(1n, 'EGP');
    const rate = parseExactDecimal('50');
    const amount = computeServiceChargeAmount(
      base,
      rate.unscaled,
      rate.scale,
      RoundingMode.HALF_DOWN,
      2,
    );
    expect(amount.amount).toBe(0n); // 0.5 -> 0 (toward zero)
  });

  it('a zero rate yields zero', () => {
    const base = Money.of(10_000n, 'EGP');
    const rate = parseExactDecimal('0');
    const amount = computeServiceChargeAmount(
      base,
      rate.unscaled,
      rate.scale,
      RoundingMode.HALF_UP,
      2,
    );
    expect(amount.amount).toBe(0n);
  });
});
