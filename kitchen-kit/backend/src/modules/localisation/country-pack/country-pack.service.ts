/**
 * Country Pack application service — the only place that answers "which pack
 * prices this branch's sale?".
 *
 * ── HOW A BRANCH REACHES A PACK ─────────────────────────────────────────────
 * FR-BRN-002 [M] lists "country pack assignment" among the things each branch
 * holds, and FR-BRN-003 [M] requires branches in different countries to operate
 * under different packs WITHIN ONE TENANT. The approved SQL makes
 * `fiscal.country_packs.code` the primary key — a pack IS identified by its
 * jurisdiction — and gives `org.branches` exactly one jurisdiction attribute,
 * `country_code CHAR(2)`. Those two facts compose into the resolver used here:
 *
 *     branch.country_code -> pack code -> version effective at transaction time
 *
 * `identity.tenants.country_pack_code` is deliberately NOT used for this. It is
 * a tenant-wide default and cannot satisfy FR-BRN-003, which requires two
 * branches of one tenant to resolve differently.
 *
 * ── HISTORICAL STABILITY (FR-LOC-021) ───────────────────────────────────────
 * The effective-date lookup runs ONCE, when an order is created, and its result
 * is pinned to `sales.orders.country_pack_version`. Every later interpretation
 * of that order goes through {@link CountryPackService.requirePinned}, which is
 * a pure (code, version) lookup with no date in it. Activating a newer pack
 * therefore cannot move a historical sale onto a different rate.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TaxEngineRegistry } from '../tax/tax-engine.registry';
import { CountryPack } from './country-pack.model';
import {
  CountryPackRegistry,
  CountryPackUnavailableError,
} from './country-pack.registry';
import { COUNTRY_PACK_SIGNATURE_VERIFIER } from './country-pack.signature';
import type { CountryPackSignatureVerifier } from './country-pack.signature';

/** Raised when a branch cannot be resolved to a jurisdiction. */
export class BranchJurisdictionUnknownError extends Error {
  constructor(branchId: string) {
    super(`No branch ${branchId} is visible in this tenant context.`);
    this.name = 'BranchJurisdictionUnknownError';
  }
}

@Injectable()
export class CountryPackService {
  private readonly logger = new Logger(CountryPackService.name);
  readonly registry: CountryPackRegistry;

  constructor(
    private readonly prisma: PrismaService,
    readonly engines: TaxEngineRegistry,
    @Inject(COUNTRY_PACK_SIGNATURE_VERIFIER)
    verifier: CountryPackSignatureVerifier,
  ) {
    this.registry = new CountryPackRegistry(verifier, {
      knownEngines: engines.ids,
    });
  }

  /**
   * Activate a pack document. Fails closed on a bad signature; the caller
   * decides whether that is fatal (a loader logs and continues to the next pack,
   * so one bad file cannot take the process down while leaving good packs live).
   */
  activate(document: unknown): Promise<CountryPack> {
    return this.registry.activate(document);
  }

  /**
   * The pack version in force for a branch at `at`.
   *
   * Reads the branch through `withAuthContext`, so a branch belonging to another
   * tenant is invisible under RLS and surfaces as "unknown", never as a
   * cross-tenant read.
   */
  async resolveForBranch(
    tenantId: string,
    branchId: string,
    at: Date,
  ): Promise<CountryPack> {
    const branch = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true, countryCode: true, baseCurrency: true },
      }),
    );
    if (!branch) throw new BranchJurisdictionUnknownError(branchId);
    return this.requireEffectiveFor(branch, at);
  }

  /**
   * The same resolution for a caller that already holds the branch row.
   *
   * Pure: no database access, so a write transaction can call it without
   * nesting a second one.
   */
  requireEffectiveFor(
    branch: { id: string; countryCode: string; baseCurrency: string },
    at: Date,
  ): CountryPack {
    const pack = this.registry.requireEffective(branch.countryCode, at);

    if (pack.currency.currency.code !== branch.baseCurrency) {
      // A pack whose currency disagrees with the branch's would price sales in
      // one currency and tax them under another. Refuse rather than reconcile.
      throw new CountryPackUnavailableError(
        `Country pack ${pack.code}-${pack.version} defines ` +
          `${pack.currency.currency.code} but branch ${branch.id} trades in ` +
          `${branch.baseCurrency}.`,
      );
    }
    return pack;
  }

  /**
   * The exact pack a historical transaction names — FR-LOC-021's "interpreted
   * under the pack version in force at their transaction time".
   */
  requirePinned(countryCode: string, version: string): CountryPack {
    const pack = this.registry.resolveExact(countryCode, version);
    if (!pack) {
      throw new CountryPackUnavailableError(
        `Country pack ${countryCode}-${version} is not activated on this node, ` +
          'so the transactions pinned to it cannot be interpreted here.',
      );
    }
    return pack;
  }

  /** Diagnostic only. Never exposed over HTTP. */
  describeActivated(): Record<string, string[]> {
    return this.registry.describe();
  }

  /** @internal used by the loader to report what it achieved. */
  logActivationSummary(): void {
    const activated = this.registry.describe();
    if (this.registry.size === 0) {
      this.logger.warn(
        'No country pack is active. Tax computation and order capture will ' +
          'refuse to run until a signed, effective pack is activated (FR-LOC-022).',
      );
      return;
    }
    this.logger.log(`Active country packs: ${JSON.stringify(activated)}`);
  }
}
