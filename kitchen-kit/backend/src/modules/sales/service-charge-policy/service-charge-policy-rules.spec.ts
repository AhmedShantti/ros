import {
  ServiceChargePolicyRuleValidationError,
  parseServiceChargePolicyRules,
} from './service-charge-policy-rules';

const validRule = (overrides: Record<string, unknown> = {}) => ({
  orderType: 'dine_in',
  minGuestCount: 6,
  ratePercent: '12.5',
  ...overrides,
});

describe('parseServiceChargePolicyRules (P2D / P2D-R1 clause 3)', () => {
  it('accepts a valid rule and preserves its fields exactly', () => {
    const rules = parseServiceChargePolicyRules([validRule()]);
    expect(rules).toEqual([
      { orderType: 'dine_in', minGuestCount: 6, ratePercent: '12.5' },
    ]);
  });

  it('rules: [] is accepted and preserved exactly — "explicitly no service charge here"', () => {
    expect(parseServiceChargePolicyRules([])).toEqual([]);
  });

  it('rules must be an array', () => {
    expect(() => parseServiceChargePolicyRules({})).toThrow(
      ServiceChargePolicyRuleValidationError,
    );
    expect(() => parseServiceChargePolicyRules('not an array')).toThrow(
      /expected an array/,
    );
    expect(() => parseServiceChargePolicyRules(null)).toThrow(
      /expected an array/,
    );
  });

  it('each rule must be an object', () => {
    expect(() => parseServiceChargePolicyRules(['not an object'])).toThrow(
      /expected an object/,
    );
    expect(() => parseServiceChargePolicyRules([null])).toThrow(
      /expected an object/,
    );
    expect(() => parseServiceChargePolicyRules([['nested', 'array']])).toThrow(
      /expected an object/,
    );
  });

  // ---------------------------------------------------------- orderType
  it('orderType: null means all order types', () => {
    const rules = parseServiceChargePolicyRules([
      validRule({ orderType: null }),
    ]);
    expect(rules[0].orderType).toBeNull();
  });

  it('orderType accepts every real OrderType value', () => {
    for (const orderType of [
      'dine_in',
      'takeaway',
      'delivery',
      'drive_thru',
      'pickup',
      'aggregator',
    ]) {
      const rules = parseServiceChargePolicyRules([validRule({ orderType })]);
      expect(rules[0].orderType).toBe(orderType);
    }
  });

  it('rejects an invalid orderType', () => {
    expect(() =>
      parseServiceChargePolicyRules([validRule({ orderType: 'brunch' })]),
    ).toThrow(/orderType/);
    expect(() =>
      parseServiceChargePolicyRules([validRule({ orderType: 123 })]),
    ).toThrow(/orderType/);
  });

  // ------------------------------------------------------ minGuestCount
  it('minGuestCount: null means no guest-count condition', () => {
    const rules = parseServiceChargePolicyRules([
      validRule({ minGuestCount: null }),
    ]);
    expect(rules[0].minGuestCount).toBeNull();
  });

  it('minGuestCount accepts zero and positive integers', () => {
    expect(
      parseServiceChargePolicyRules([validRule({ minGuestCount: 0 })])[0]
        .minGuestCount,
    ).toBe(0);
    expect(
      parseServiceChargePolicyRules([validRule({ minGuestCount: 6 })])[0]
        .minGuestCount,
    ).toBe(6);
  });

  it('rejects a negative minGuestCount', () => {
    expect(() =>
      parseServiceChargePolicyRules([validRule({ minGuestCount: -1 })]),
    ).toThrow(/minGuestCount/);
  });

  it('rejects a non-integer minGuestCount', () => {
    expect(() =>
      parseServiceChargePolicyRules([validRule({ minGuestCount: 2.5 })]),
    ).toThrow(/minGuestCount/);
    expect(() =>
      parseServiceChargePolicyRules([validRule({ minGuestCount: '6' })]),
    ).toThrow(/minGuestCount/);
  });

  // ---------------------------------------------------------- ratePercent
  it('ratePercent must be an exact-decimal string', () => {
    const rules = parseServiceChargePolicyRules([
      validRule({ ratePercent: '0' }),
    ]);
    expect(rules[0].ratePercent).toBe('0');
  });

  it('rejects a JSON number in the ratePercent position (ADR-008)', () => {
    expect(() =>
      parseServiceChargePolicyRules([validRule({ ratePercent: 12.5 })]),
    ).toThrow(/exact decimal STRING/);
  });

  it('rejects a malformed decimal string', () => {
    expect(() =>
      parseServiceChargePolicyRules([validRule({ ratePercent: 'twelve' })]),
    ).toThrow(/ratePercent/);
  });

  it('rejects exponent notation', () => {
    expect(() =>
      parseServiceChargePolicyRules([validRule({ ratePercent: '1e2' })]),
    ).toThrow(/ratePercent/);
  });

  it('rejects a negative ratePercent', () => {
    expect(() =>
      parseServiceChargePolicyRules([validRule({ ratePercent: '-5' })]),
    ).toThrow(/negative/);
  });

  it('accepts a ratePercent with no invented upper bound (no SRS/precedent defines one)', () => {
    // Deliberately absurd but structurally valid — proves no max is enforced.
    const rules = parseServiceChargePolicyRules([
      validRule({ ratePercent: '500' }),
    ]);
    expect(rules[0].ratePercent).toBe('500');
  });

  it('rejects a missing ratePercent', () => {
    const withoutRate: Record<string, unknown> = {
      orderType: 'dine_in',
      minGuestCount: 6,
    };
    expect(() => parseServiceChargePolicyRules([withoutRate])).toThrow(
      /ratePercent/,
    );
  });

  // ------------------------------------------------------------ multiple
  it('validates every rule in a multi-rule array, whole or not at all', () => {
    expect(() =>
      parseServiceChargePolicyRules([
        validRule(),
        validRule({ ratePercent: 'bad' }),
      ]),
    ).toThrow(/rules\[1\]\.ratePercent/);
  });

  it('preserves multiple valid rules exactly, in order', () => {
    const rules = parseServiceChargePolicyRules([
      { orderType: 'dine_in', minGuestCount: 6, ratePercent: '12.5' },
      { orderType: 'takeaway', minGuestCount: null, ratePercent: '0' },
      { orderType: null, minGuestCount: null, ratePercent: '5' },
    ]);
    expect(rules).toHaveLength(3);
    expect(rules[0].orderType).toBe('dine_in');
    expect(rules[1].orderType).toBe('takeaway');
    expect(rules[2].orderType).toBeNull();
  });
});
