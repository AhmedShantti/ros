import { Injectable } from '@nestjs/common';
import type {
  CountryPackSettingFactInput,
  CountryPackSettingFactQuery,
} from '../contract/country-pack-setting-fact.query';
import type { CountryPack } from './country-pack.model';
import { CountryPackUnavailableError } from './country-pack.registry';
import { CountryPackService } from './country-pack.service';

/**
 * The one Country-Pack-backed setting key this slice honestly supports:
 * the pack's cash-rounding/tax-rounding facts (BR-FIN-002/FR-FIN-035,
 * §22.2's `currency.cashRounding` and `tax.roundingMode`/`roundingPrecision`
 * blocks — the same facts `PINNED_PAYMENT_POLICY_QUERY` exposes for a
 * PINNED historical pack version, here exposed for the CURRENTLY effective
 * one, which a live settings resolve/inspect needs instead).
 *
 * Adding a second key means adding a second mapping function below and one
 * more entry here — never widening this into a passthrough of the whole
 * `CountryPack` object (Localisation's tax-engine internals stay private).
 */
export const COUNTRY_PACK_SETTING_KEYS = Object.freeze([
  'payments.cash_rounding_policy',
] as const);

/**
 * Private implementation of `COUNTRY_PACK_SETTING_FACT_QUERY` — see that
 * file for the contract this adapts to.
 */
@Injectable()
export class CountryPackSettingFactQueryService implements CountryPackSettingFactQuery {
  constructor(private readonly countryPacks: CountryPackService) {}

  getSettingFact(input: CountryPackSettingFactInput): unknown {
    if (input.settingKey === 'payments.cash_rounding_policy') {
      return this.resolveCashRoundingPolicy(input);
    }
    return undefined;
  }

  supportedSettingKeys(): readonly string[] {
    return COUNTRY_PACK_SETTING_KEYS;
  }

  private resolveCashRoundingPolicy(
    input: CountryPackSettingFactInput,
  ): unknown {
    let pack: CountryPack;
    try {
      pack = this.countryPacks.registry.requireEffective(
        input.countryPackCode,
        input.at,
      );
    } catch (error) {
      if (error instanceof CountryPackUnavailableError) {
        return null;
      }
      throw error;
    }
    return {
      currencyCode: pack.currency.currency.code,
      cashRoundingEnabled: pack.currency.cashRounding.enabled,
      cashRoundingStepMinorUnits:
        pack.currency.cashRounding.stepMinorUnits?.toString() ?? null,
      roundingMode: pack.tax.roundingMode,
      roundingPrecision: pack.tax.roundingPrecision,
    };
  }
}
