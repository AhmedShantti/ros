import {
  assertSelectionRules,
  violatesSelectionRules,
} from './selection-rules';

describe('modifier group selection rules (SRS §7.3 #8 / FR-MNU-011)', () => {
  it('accepts min <= max when not required', () => {
    expect(violatesSelectionRules(0, 1, false)).toBeNull();
    expect(violatesSelectionRules(2, 5, false)).toBeNull();
    expect(violatesSelectionRules(3, 3, false)).toBeNull();
  });

  it('rejects min > max', () => {
    expect(violatesSelectionRules(3, 2, false)).toMatch(/less than or equal/);
  });

  it('rejects a required group with min 0', () => {
    expect(violatesSelectionRules(0, 3, true)).toMatch(/at least 1/);
  });

  it('accepts a required group with min >= 1', () => {
    expect(violatesSelectionRules(1, 3, true)).toBeNull();
  });

  it('reports min>max ahead of the required rule when both are violated', () => {
    expect(violatesSelectionRules(5, 2, true)).toMatch(/less than or equal/);
  });

  it('assert throws BadRequest for violations and passes otherwise', () => {
    expect(() => assertSelectionRules(0, 1, false)).not.toThrow();
    expect(() => assertSelectionRules(3, 2, false)).toThrow(
      /less than or equal/,
    );
    expect(() => assertSelectionRules(0, 3, true)).toThrow(/at least 1/);
  });
});
