import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CountryPackLoader } from './country-pack/country-pack.loader';
import { CountryPackService } from './country-pack/country-pack.service';
import {
  COUNTRY_PACK_SIGNATURE_VERIFIER,
  COUNTRY_PACK_TRUST_STORE,
  Ed25519CountryPackSignatureVerifier,
} from './country-pack/country-pack.signature';
import type { CountryPackTrustStore } from './country-pack/country-pack.signature';
import { ConfiguredCountryPackTrustStore } from './country-pack/country-pack.trust.provider';
import {
  PINNED_PAYMENT_POLICY_QUERY,
  TAX_CLASS_LABELS_QUERY,
} from './contract';
import { PinnedPaymentPolicyQueryService } from './payment-policy/pinned-payment-policy.query.service';
import { TAX_CLASS_PROVISIONER } from './tax/tax-class.port';
import { TaxClassLabelsQueryService } from './tax/tax-class-labels.query.service';
import { TaxClassProvisioningService } from './tax/tax-class.provisioner';
import { TaxClassService } from './tax/tax-class.service';
import { TaxEngineRegistry } from './tax/tax-engine.registry';

/**
 * Localisation bounded context — SRS Chapter 22.
 *
 * Country Packs and tax computation are INTERNAL domain capabilities, so this
 * module has NO controller. The SRS defines no `/country-packs` or `/tax`
 * endpoint; FR-LOC-030's authoring tool is [S] and out of scope, and exposing
 * an activation route would invent an administrative workflow no source
 * specifies. `OrderLinesService` (pre-existing) consumes `CountryPackService`
 * directly, an unchanged, documented `sales->localisation` deviation.
 *
 * P1F-1A adds the FIRST published `contract/` QUERY —
 * `PINNED_PAYMENT_POLICY_QUERY` (`modules/localisation/contract`) — the
 * pinned cash-rounding facts Sales' Payment capture needs. New Localisation
 * consumers must go through `contract/`; the pre-existing `OrderLinesService`
 * debt above is deliberately not repaired by this narrow correction.
 *
 * The signature verifier is the concrete Ed25519 / RFC-8785 implementation
 * ratified as carried item P1C-3. It verifies against trusted release PUBLIC
 * keys supplied by deployment configuration; with no manifest configured nothing
 * is trusted, every pack is rejected, and the system refuses to price a sale
 * rather than pricing one under an unverified rate.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: TaxEngineRegistry, useFactory: () => new TaxEngineRegistry() },
    {
      provide: COUNTRY_PACK_TRUST_STORE,
      useClass: ConfiguredCountryPackTrustStore,
    },
    {
      provide: COUNTRY_PACK_SIGNATURE_VERIFIER,
      useFactory: (trust: CountryPackTrustStore) =>
        new Ed25519CountryPackSignatureVerifier(trust),
      inject: [COUNTRY_PACK_TRUST_STORE],
    },
    CountryPackService,
    CountryPackLoader,
    TaxClassService,
    TaxClassProvisioningService,
    {
      provide: TAX_CLASS_PROVISIONER,
      useExisting: TaxClassProvisioningService,
    },
    // P1F-1A — the FIRST published `contract/` query. Payment consumes
    // ONLY this token; `CountryPackService` itself remains exported below
    // for the pre-existing `OrderLinesService` private-import debt, which
    // this narrow correction does not repair.
    PinnedPaymentPolicyQueryService,
    {
      provide: PINNED_PAYMENT_POLICY_QUERY,
      useExisting: PinnedPaymentPolicyQueryService,
    },
    // Minimum Operational Reporting (RPT-R1/R2/R3) — labels only (no rate,
    // no component, no engine config), consumed only by `reporting`.
    TaxClassLabelsQueryService,
    {
      provide: TAX_CLASS_LABELS_QUERY,
      useExisting: TaxClassLabelsQueryService,
    },
  ],
  exports: [
    CountryPackService,
    TaxEngineRegistry,
    TaxClassService,
    TAX_CLASS_PROVISIONER,
    PINNED_PAYMENT_POLICY_QUERY,
    TAX_CLASS_LABELS_QUERY,
  ],
})
export class LocalisationModule {}
