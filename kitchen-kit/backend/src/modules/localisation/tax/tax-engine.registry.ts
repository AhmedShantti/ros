/**
 * The registered set of tax-engine strategies — FR-LOC-025 [M].
 *
 * "The tax engine referenced by a pack SHALL be one of a registered set of
 * strategy implementations. Adding a genuinely novel tax model requires a new
 * strategy implementation; changing rates, classes, or rounding does not."
 *
 * The set is CLOSED and built in code. A pack names a strategy by id and the
 * registry either has it or the pack is rejected at parse time — nothing is
 * constructed from a pack-supplied name, so a malformed or hostile pack cannot
 * cause an arbitrary implementation to be instantiated.
 *
 * There is no dispatch on country code here or anywhere below it. `EG` and `SA`
 * both name `vat_standard` and differ only in their pack data, which is what
 * CR-03 and ADR-005 require.
 */

import { TaxComputationStrategy } from './tax.model';
import {
  VAT_STANDARD_ENGINE_ID,
  VatStandardStrategy,
} from './vat-standard.strategy';

/** Raised when a pack names an engine the registry does not implement. */
export class UnknownTaxEngineError extends Error {
  constructor(readonly engineId: string) {
    super(
      `Unknown tax engine ${JSON.stringify(engineId)}. FR-LOC-025 requires the ` +
        'engine to be one of the registered strategy implementations.',
    );
    this.name = 'UnknownTaxEngineError';
  }
}

export class TaxEngineRegistry {
  private readonly strategies: ReadonlyMap<string, TaxComputationStrategy>;

  constructor(
    strategies: readonly TaxComputationStrategy[] = DEFAULT_STRATEGIES,
  ) {
    const map = new Map<string, TaxComputationStrategy>();
    for (const strategy of strategies) {
      if (map.has(strategy.id)) {
        throw new Error(
          `Duplicate tax engine id ${JSON.stringify(strategy.id)}.`,
        );
      }
      map.set(strategy.id, strategy);
    }
    this.strategies = map;
  }

  /** Ids the parser validates `tax.engine` against. */
  get ids(): ReadonlySet<string> {
    return new Set(this.strategies.keys());
  }

  has(engineId: string): boolean {
    return this.strategies.has(engineId);
  }

  require(engineId: string): TaxComputationStrategy {
    const strategy = this.strategies.get(engineId);
    if (!strategy) throw new UnknownTaxEngineError(engineId);
    return strategy;
  }
}

/**
 * The strategies this release registers.
 *
 * One entry, because the SRS names exactly one engine (`vat_standard`) and the
 * jurisdictions in §22.3 — Egypt, Saudi Arabia, the UAE — are all ad-valorem VAT
 * models that differ only in rates, classes and additional components. None of
 * them needs a second strategy; each needs a pack.
 */
export const DEFAULT_STRATEGIES: readonly TaxComputationStrategy[] =
  Object.freeze([new VatStandardStrategy()]);

export { VAT_STANDARD_ENGINE_ID };
