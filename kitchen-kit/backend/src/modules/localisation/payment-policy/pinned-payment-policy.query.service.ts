import { Injectable } from '@nestjs/common';
import { CountryPackService } from '../country-pack/country-pack.service';
import type {
  PinnedPaymentPolicy,
  PinnedPaymentPolicyQuery,
  PinnedPaymentPolicyQueryInput,
} from '../contract';

/**
 * PRIVATE adapter implementing `PinnedPaymentPolicyQuery` (P1F-1A).
 *
 * Never imported directly by another module — only through the
 * `PINNED_PAYMENT_POLICY_QUERY` token `LocalisationModule` binds it to.
 * Delegates entirely to the existing `CountryPackService.requirePinned()` —
 * no new pack-resolution logic, no new cash-rounding logic. This file only
 * narrows the four payment-relevant facts out of the full `CountryPack`.
 */
@Injectable()
export class PinnedPaymentPolicyQueryService implements PinnedPaymentPolicyQuery {
  constructor(private readonly countryPacks: CountryPackService) {}

  requirePinnedPaymentPolicy(
    input: PinnedPaymentPolicyQueryInput,
  ): PinnedPaymentPolicy {
    const pack = this.countryPacks.requirePinned(
      input.countryCode,
      input.packVersion,
    );
    const cashRounding = pack.currency.cashRounding;
    return {
      currencyCode: pack.currency.currency.code,
      cashRoundingEnabled: cashRounding.enabled,
      cashRoundingStepMinorUnits: cashRounding.enabled
        ? (cashRounding.stepMinorUnits ?? null)
        : null,
      roundingMode: pack.tax.roundingMode,
    };
  }
}
