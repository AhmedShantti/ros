import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import { makePackDocument } from './country-pack.fixture';
import { parseCountryPack } from './country-pack.parser';
import {
  COUNTRY_PACK_SETTING_KEYS,
  countryPackContributes,
  isCountryPackSettingKey,
} from './country-pack.setting-keys';

const parseOptions = { knownEngines: new TaxEngineRegistry().ids };

/**
 * FR-PLT-026 / P2A-R1 clause 1/2 — the contribution predicate itself, in
 * isolation from the parser's `settingsLocks` validation gate that consumes
 * it (`country-pack.parser.spec.ts` proves that gate end-to-end). Every
 * valid pack today unconditionally contributes the sole supported key, so
 * `countryPackContributes` cannot currently be driven to `false` through a
 * production pack document (see `country-pack.parser.spec.ts` test D for
 * why); this file proves the predicate's own behaviour directly instead of
 * inventing an unsupported production shape to force a negative case.
 */
describe('Country Pack setting-key vocabulary (FR-PLT-026 / P2A-R1)', () => {
  it('names exactly the mapped keys', () => {
    expect(COUNTRY_PACK_SETTING_KEYS).toEqual([
      'payments.cash_rounding_policy',
    ]);
  });

  it('isCountryPackSettingKey recognises only the closed set', () => {
    expect(isCountryPackSettingKey('payments.cash_rounding_policy')).toBe(true);
    expect(isCountryPackSettingKey('payments.service_charge_policy')).toBe(
      false,
    );
    expect(isCountryPackSettingKey('not.a.real.key')).toBe(false);
  });

  it('countryPackContributes is true for a genuinely parsed, valid pack', () => {
    const pack = parseCountryPack(makePackDocument(), parseOptions);
    expect(countryPackContributes(pack, 'payments.cash_rounding_policy')).toBe(
      true,
    );
  });
});
