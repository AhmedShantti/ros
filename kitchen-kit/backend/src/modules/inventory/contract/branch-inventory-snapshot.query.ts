import { Prisma } from '../../../generated/prisma/client';

/**
 * Inventory PUBLIC contract — a branch-scoped operational snapshot for the
 * Reporting Overview (RPT-DEMO-1). Deliberately narrow: only metrics backed
 * by real, already-computed source data are exposed — no stock valuation
 * rule and no COGS logic is invented here.
 *
 * `inventory.stock_levels` / `stock_item_reorder_configs` / `waste_records`
 * carry NO `branch_id` column, only `location_id` (an item is stocked at a
 * LOCATION — a branch, a warehouse, or a central kitchen — not directly at a
 * branch). `locationIds` is resolved by the CALLER via Organisation's
 * `BRANCH_LOCATIONS_QUERY` and passed in here; this query never reaches into
 * `org.locations` itself, so the module boundary is crossed only at the
 * orchestrating (Reporting) layer, exactly as `DailyTradingReportService`
 * already composes Sales + Treasury facts without either module reading the
 * other's tables.
 *
 * `lowStockItemCount` mirrors FR-INV-066's existing (previously unpublished)
 * `ReconciliationService.lowStock` comparison: a (stockItem, location) pair
 * counts once when `quantityOnHand < reorderPoint`, and ONLY when a reorder
 * point is actually configured — an item with no configured reorder point is
 * excluded, never treated as "reorder point 0" (which would systematically
 * over-count).
 *
 * `waste` sums `waste_records`/`waste_lines` whose `recordedAt` falls in the
 * caller-supplied `[wasteFrom, wasteTo)` window. This is a CALENDAR window,
 * not a POS business day — `waste_records` carries no business-day column
 * and none is invented here (RPT-DEMO-1 §5: cross-domain metrics with
 * different time models must say so explicitly rather than pretend to
 * agree; see the Reporting response's own `inventory.notes`).
 *
 * Movement-summary and COGS/depletion are DELIBERATELY NOT exposed by this
 * contract — Inventory's COGS logic (`SaleDepletionService`) is a private
 * FIFO/weighted-average kernel with no existing accepted query form safe to
 * publish tonight (RPT-DEMO-1 §2C: "Do NOT invent stock valuation rules").
 *
 * `tx`-FIRST — composed inside the Reporting overview's own RepeatableRead
 * transaction, sharing its MVCC snapshot.
 */
export const BRANCH_INVENTORY_SNAPSHOT_QUERY = Symbol(
  'BRANCH_INVENTORY_SNAPSHOT_QUERY',
);

export interface BranchInventorySnapshotQueryInput {
  readonly tenantId: string;
  readonly locationIds: readonly string[];
  readonly wasteFrom: Date;
  readonly wasteTo: Date;
}

export interface BranchInventorySnapshotFacts {
  /** Count of (stockItem, location) pairs below a CONFIGURED reorder point, over `locationIds`. */
  readonly lowStockItemCount: number;
  /** Count of `waste_records` in `[wasteFrom, wasteTo)`, over `locationIds`. */
  readonly wasteRecordCount: number;
  /** Σ `waste_lines.quantity` over those records — a decimal string (unit-of-measure quantity, not money). */
  readonly wasteQuantityTotal: string;
  /** Σ `waste_records.total_value` over those records — minor-unit money. */
  readonly wasteValueTotal: bigint;
}

export interface BranchInventorySnapshotQuery {
  forLocations(
    tx: Prisma.TransactionClient,
    input: BranchInventorySnapshotQueryInput,
  ): Promise<BranchInventorySnapshotFacts>;
}
