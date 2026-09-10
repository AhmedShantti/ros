import { Injectable } from '@nestjs/common';
import type {
  CountryPackSettingFact,
  CountryPackSettingFactInput,
  CountryPackSettingFactQuery,
} from '../contract/country-pack-setting-fact.query';
import type { CountryPack } from './country-pack.model';
import { CountryPackUnavailableError } from './country-pack.registry';
import { COUNTRY_PACK_SETTING_KEYS } from './country-pack.setting-keys';
import { CountryPackService } from './country-pack.service';

/**
 * Private implementation of `COUNTRY_PACK_SETTING_FACT_QUERY` — see that
 * file for the contract this adapts to. The supported-key vocabulary and the
 * "does this pack contribute this key" question both live in
 * `country-pack.setting-keys.ts`, the single Localisation-owned canonical
 * source the parser also consumes — never a second, drifting copy here.
 */
@Injectable()
export class CountryPackSettingFactQueryService implements CountryPackSettingFactQuery {
  constructor(private readonly countryPacks: CountryPackService) {}

  getSettingFact(
    input: CountryPackSettingFactInput,
  ): CountryPackSettingFact | null | undefined {
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
  ): CountryPackSettingFact | null {
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
      value: {
        currencyCode: pack.currency.currency.code,
        cashRoundingEnabled: pack.currency.cashRounding.enabled,
        cashRoundingStepMinorUnits:
          pack.currency.cashRounding.stepMinorUnits?.toString() ?? null,
        roundingMode: pack.tax.roundingMode,
        roundingPrecision: pack.tax.roundingPrecision,
      },
      locked: pack.settingsLocks.includes(input.settingKey),
    };
  }
}
