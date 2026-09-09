import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import { CountryPackSettingFactQueryService } from './country-pack-setting-fact.query.service';
import { makePackDocument, withCurrency } from './country-pack.fixture';
import { CountryPackRegistry } from './country-pack.registry';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './country-pack.signing.fixture';
import { Ed25519CountryPackSignatureVerifier } from './country-pack.signature';

/**
 * FULL-SRS-PLT-SETTINGS-RESOLVER-P1 §9 test B — proves the Country-Pack
 * tier's own mapping (`payments.cash_rounding_policy`) produces a real value
 * once a pack is genuinely activated. The generic "a lower level overrides a
 * higher one" composition rule is level-agnostic and is proven for real over
 * HTTP by `test/platform-settings.e2e-spec.ts` (tests C-F); no e2e suite in
 * this repository activates a real signed Country Pack (`COUNTRY_PACK_DIR`
 * is unset by default), so that half is proven here instead, at the same
 * level `country-pack.registry.spec.ts` already tests activation itself.
 */
describe('CountryPackSettingFactQueryService', () => {
  const RELEASE = generateReleaseKey('ros-release-test');
  const parseOptions = { knownEngines: new TaxEngineRegistry().ids };

  const buildActivatedService = async (
    overrides: Record<string, unknown> = {},
  ) => {
    const verifier = new Ed25519CountryPackSignatureVerifier(
      trustStoreFor(RELEASE.trusted()),
    );
    const registry = new CountryPackRegistry(verifier, parseOptions);
    await registry.activate(
      signPackDocument(makePackDocument(overrides), RELEASE),
    );
    const countryPacks = {
      registry,
    } as unknown as import('./country-pack.service').CountryPackService;
    return new CountryPackSettingFactQueryService(countryPacks);
  };

  it('returns undefined for a settingKey with no Country Pack representation', async () => {
    const service = await buildActivatedService();
    expect(
      service.getSettingFact({
        countryPackCode: 'EG',
        settingKey: 'some.unsupported.key',
        at: new Date(),
      }),
    ).toBeUndefined();
  });

  it('returns null when the supported key has no pack activated for that code', async () => {
    const service = await buildActivatedService();
    expect(
      service.getSettingFact({
        countryPackCode: 'ZZ',
        settingKey: 'payments.cash_rounding_policy',
        at: new Date(),
      }),
    ).toBeNull();
  });

  it('maps payments.cash_rounding_policy from a genuinely activated pack', async () => {
    const service = await buildActivatedService(
      withCurrency({ cashRounding: { enabled: true, stepMinorUnits: 25 } }),
    );
    const fact = service.getSettingFact({
      countryPackCode: 'EG',
      settingKey: 'payments.cash_rounding_policy',
      at: new Date(),
    }) as {
      currencyCode: string;
      cashRoundingEnabled: boolean;
      cashRoundingStepMinorUnits: string | null;
      roundingMode: string;
      roundingPrecision: number;
    };

    expect(fact.currencyCode).toBe('EGP');
    expect(fact.cashRoundingEnabled).toBe(true);
    expect(fact.cashRoundingStepMinorUnits).toBe('25');
    expect(fact.roundingMode).toBe('HALF_UP');
    expect(fact.roundingPrecision).toBe(2);
  });

  it('supportedSettingKeys names exactly the mapped keys', async () => {
    const service = await buildActivatedService();
    expect(service.supportedSettingKeys()).toEqual([
      'payments.cash_rounding_policy',
    ]);
  });
});
