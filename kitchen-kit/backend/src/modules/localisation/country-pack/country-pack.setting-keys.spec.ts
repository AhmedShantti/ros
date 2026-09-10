import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import { makePackDocument } from './country-pack.fixture';
import { parseCountryPack } from './country-pack.parser';
import {
  COUNTRY_PACK_SETTING_KEYS,
  countryPackContributes,
  isCountryPackSettingKey,
  isProviderExclusiveSettingKey,
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

  /**
   * P2C1-R1 — provider-exclusivity is a distinct, third question from
   * `isCountryPackSettingKey` (is this key in the closed vocabulary at
   * all?) and `countryPackContributes` (does THIS pack define it?): does
   * this key admit a lower-level generic-settings override AT ALL, for
   * ANY pack?
   */
  it('isProviderExclusiveSettingKey: payments.cash_rounding_policy is provider-exclusive (FR-POS-063)', () => {
    expect(isProviderExclusiveSettingKey('payments.cash_rounding_policy')).toBe(
      true,
    );
  });

  it('isProviderExclusiveSettingKey: a key outside the closed vocabulary is not provider-exclusive', () => {
    expect(isProviderExclusiveSettingKey('not.a.real.key')).toBe(false);
  });

  it('isProviderExclusiveSettingKey is not a blanket rule for every COUNTRY_PACK_SETTING_KEYS entry — only an individually-evidenced subset (none exist beyond the one key today)', () => {
    for (const key of COUNTRY_PACK_SETTING_KEYS) {
      // Today's closed vocabulary has exactly one entry, and it IS
      // provider-exclusive — this assertion exists so that if a SECOND
      // key is ever added to COUNTRY_PACK_SETTING_KEYS without its own
      // deliberate provider-exclusivity judgment, this test forces that
      // judgment to be made explicitly rather than silently inherited.
      expect(isProviderExclusiveSettingKey(key)).toBe(true);
    }
  });
});
