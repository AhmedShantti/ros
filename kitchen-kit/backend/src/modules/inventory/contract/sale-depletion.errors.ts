/**
 * P1F-2 Inventory domain errors. Plain `Error` subclasses (no HTTP framing
 * here — same discipline `kitchen/routing/routing-resolver.errors.ts`
 * already established) with a stable `code` a caller can map. Both roll the
 * WHOLE Completion transaction back when thrown from inside
 * `depleteForCompletedSale`.
 */

/**
 * P1F2C §F — for `costing_method = 'fifo'`, no eligible cost layer AND no
 * exhausted (carry-forward) layer exists either. NO weighted-average, NO
 * standard, NO latest-purchase fallback is applied for FIFO; this is the
 * fail-closed terminal case.
 */
export class NoHistoricalCostLayerError extends Error {
  readonly code = 'NO_HISTORICAL_COST_LAYER';
  constructor(message: string) {
    super(message);
    this.name = 'NoHistoricalCostLayerError';
  }
}

/**
 * P1F2E-A §E step 2 — the business-identity reservation
 * (`sale_depletion_effects`) lost a genuine race: 0 rows came back from the
 * `ON CONFLICT ... DO NOTHING RETURNING id`. No Inventory state has been
 * touched; the caller retries the whole Completion.
 */
export class SaleDepletionEffectConflictError extends Error {
  readonly code = 'SALE_DEPLETION_EFFECT_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'SaleDepletionEffectConflictError';
  }
}
