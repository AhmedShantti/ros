import { Prisma } from '../../../generated/prisma/client';

/**
 * The one thing Inventory needs from Production — FR-MNU-046.
 *
 * "Recipe cost SHALL recompute when component costs change, cascading through
 * dependent sub-recipes and parent recipes." The only place a component's
 * current cost changes is the inventory valuation mutation boundary, so the call
 * has to originate there; a port keeps that a one-line dependency on an
 * interface rather than Inventory reaching into Production's internals.
 *
 * Deliberately NOT an event: this repository has no outbox, no event bus and no
 * scheduler, and the Production design gate section 20 still excludes all three.
 * The recomputation runs inside the caller's transaction, so a movement and the
 * costs it invalidates commit or roll back together.
 */
export const RECIPE_COST_RECOMPUTER = Symbol('RECIPE_COST_RECOMPUTER');

export interface RecipeCostRecomputer {
  /**
   * Recompute every recipe version affected by a change to this stock item's
   * valuation, then cascade to their parents. Returns the version ids touched.
   */
  recomputeForStockItem(
    tx: Prisma.TransactionClient,
    stockItemId: string,
  ): Promise<string[]>;

  /**
   * P1F-2 — the SAME cascade, batched across several stock items in one call.
   * Order Completion calls this ONCE, after all movements, with the DISTINCT
   * FIFO stock items the depletion touched — not once per movement/allocation.
   */
  recomputeForStockItems(
    tx: Prisma.TransactionClient,
    stockItemIds: readonly string[],
  ): Promise<string[]>;
}
