import { RecipeCostError } from '../costing/recipe-cost';

/**
 * `planConsumption`'s VALUATION-classified gap (`no_unit_conversion`) — a
 * stock_item component (from the pinned recipe closure OR a pinned modifier
 * ADD effect) has no pinned conversion factor from its line unit to the
 * stock item's base unit. Per P1F2E-A §L "CONVERSION GAPS FAIL CLOSED":
 * STRUCTURAL gaps tolerate and deplete partially; this one THROWS and rolls
 * the whole Completion back — extends `RecipeCostError` so the existing
 * `SalesDomainExceptionFilter` maps it to 422 with zero filter changes,
 * exactly as it already does for every other `RecipeCostError`.
 */
export class ConsumptionConversionGapError extends RecipeCostError {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumptionConversionGapError';
  }
}
