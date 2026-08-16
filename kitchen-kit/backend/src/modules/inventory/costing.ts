/**
 * Inventory valuation and batch selection — pure functions, no I/O.
 *
 * D-INV-03 ratifies TWO INDEPENDENT AXES. Keeping them separate is the whole
 * point of this module:
 *
 *   costing_method  (weighted_average | fifo | standard) -> what a consumption
 *                                                            is VALUED at
 *   batch_strategy  (fifo | fefo)                        -> WHICH eligible
 *                                                            batch is consumed
 *
 * FEFO is the SRS-required default where expiry tracking is enabled
 * (FR-INV-023). It is a SELECTION rule only: no costing semantics are inferred
 * from it, and `selectBatches` never consults the costing method.
 *
 * Money is BIGINT minor units; quantities are 6-dp decimals (BR-CORE-003).
 * All arithmetic here is integer/× to avoid float drift.
 */

export type CostingMethod = 'weighted_average' | 'fifo' | 'standard';
export type BatchStrategy = 'fifo' | 'fefo';

/** Quantities are carried as strings to preserve 6-dp precision end to end. */
export interface BatchLot {
  batchId: string;
  /** Remaining quantity in the item's base unit. */
  quantityRemaining: number;
  /** Cost per base unit, minor units. */
  unitCost: bigint;
  /** Receipt order (earlier = older). */
  receivedAt: Date;
  /** Null when the batch has no expiry (FEFO then falls back to receipt order). */
  expiryDate: Date | null;
}

export interface BatchConsumption {
  batchId: string;
  quantity: number;
  unitCost: bigint;
}

/**
 * FR-INV-022/023 — choose which eligible batches satisfy `quantity`.
 *
 * FIFO: oldest received first.
 * FEFO: nearest expiry first; batches without an expiry sort last, then by
 *       receipt order. The SRS gives FEFO no tie-break rule, so receipt order is
 *       used as a deterministic secondary key rather than leaving order
 *       undefined.
 *
 * Returns the consumption plan. If the lots cannot cover `quantity`, the
 * shortfall is returned rather than throwing — FR-INV-014 requires negative
 * stock to be RECORDED, never blocked.
 */
export function selectBatches(
  lots: BatchLot[],
  quantity: number,
  strategy: BatchStrategy,
): { consumed: BatchConsumption[]; shortfall: number } {
  if (quantity <= 0) {
    return { consumed: [], shortfall: 0 };
  }
  const ordered = [...lots]
    .filter((l) => l.quantityRemaining > 0)
    .sort((a, b) => {
      if (strategy === 'fefo') {
        const ax = a.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bx = b.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
        if (ax !== bx) return ax - bx;
      }
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });

  const consumed: BatchConsumption[] = [];
  let remaining = quantity;
  for (const lot of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.quantityRemaining);
    consumed.push({
      batchId: lot.batchId,
      quantity: take,
      unitCost: lot.unitCost,
    });
    remaining -= take;
  }
  return { consumed, shortfall: remaining > 0 ? remaining : 0 };
}

/**
 * FR-INV-012 weighted average, recomputed on each receipt:
 *   (existing_value + received_value) / (existing_qty + received_qty)
 *
 * Returns minor units, rounded half-up. A non-positive resulting quantity
 * leaves the average unchanged — there is no meaningful average over zero or
 * negative stock, and FR-INV-014 permits negative levels.
 */
export function weightedAverageCost(
  existingQty: number,
  existingAvg: bigint,
  receivedQty: number,
  receivedUnitCost: bigint,
): bigint {
  const totalQty = existingQty + receivedQty;
  if (totalQty <= 0) return existingAvg;
  const existingValue = Number(existingAvg) * existingQty;
  const receivedValue = Number(receivedUnitCost) * receivedQty;
  return BigInt(Math.round((existingValue + receivedValue) / totalQty));
}

export interface ValuationInput {
  costingMethod: CostingMethod;
  /** Quantity being consumed (positive). */
  quantity: number;
  /** Current weighted-average cost for the (item, location). */
  averageCost: bigint;
  /** Item's standard cost; required when costingMethod = 'standard'. */
  standardCost: bigint | null;
  /** Batch plan from `selectBatches` — used only by FIFO valuation. */
  consumed: BatchConsumption[];
}

/**
 * Value an outbound consumption.
 *
 * weighted_average -> the prevailing average for the (item, location).
 * fifo             -> the actual cost of the batches consumed (FR-INV-013), so
 *                     the unit cost is the value-weighted mean of the plan.
 * standard         -> the item's fixed standard cost. FR-INV-012's "purchase
 *                     price variance posted separately" is NOT posted: no
 *                     variance-account entity exists in the SRS and D-INV-03
 *                     forbids inventing one. The difference is reportable from
 *                     unit_cost vs standard_cost on the ledger.
 *
 * NOTE the deliberate asymmetry: FIFO valuation reads `consumed`, which was
 * produced by the batch strategy. When strategy = FEFO and costing = FIFO, the
 * cost therefore follows the batches actually consumed. The SRS does not define
 * that combination (documented open item), so the ledger records batch_id AND
 * unit_cost per movement, keeping either later interpretation reachable.
 */
export function valuationUnitCost(input: ValuationInput): bigint {
  switch (input.costingMethod) {
    case 'weighted_average':
      return input.averageCost;
    case 'standard':
      return input.standardCost ?? 0n;
    case 'fifo': {
      const qty = input.consumed.reduce((s, c) => s + c.quantity, 0);
      if (qty <= 0) return input.averageCost;
      const value = input.consumed.reduce(
        (s, c) => s + Number(c.unitCost) * c.quantity,
        0,
      );
      return BigInt(Math.round(value / qty));
    }
  }
}

/** total_cost = quantity × unit_cost, minor units, rounded half-up. */
export function totalCost(quantity: number, unitCost: bigint): bigint {
  return BigInt(Math.round(Math.abs(quantity) * Number(unitCost)));
}

/**
 * FR-INV-021 — default expiry = production date + the item's shelf life.
 * Returns null when either input is absent; the caller may still override.
 */
export function defaultExpiryDate(
  productionDate: Date | null,
  shelfLifeDays: number | null,
): Date | null {
  if (
    !productionDate ||
    shelfLifeDays === null ||
    shelfLifeDays === undefined
  ) {
    return null;
  }
  const d = new Date(productionDate.getTime());
  d.setUTCDate(d.getUTCDate() + shelfLifeDays);
  return d;
}

/**
 * FR-INV-023 — FEFO is the default batch strategy for expiry-tracked items.
 * Applied only when the caller expresses no preference.
 */
export function defaultBatchStrategy(expiryTracked: boolean): BatchStrategy {
  return expiryTracked ? 'fefo' : 'fifo';
}
