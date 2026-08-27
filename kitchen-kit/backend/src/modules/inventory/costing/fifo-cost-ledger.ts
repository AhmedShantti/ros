/**
 * PRIVATE Inventory kernel — P1F2E-A §D/§L "E. INVENTORY". NOT a contract,
 * NOT exported through `inventory/contract`, imported by NOTHING outside
 * this module (asserted by `module-boundaries.spec.ts`).
 *
 * Owns the FIFO ACCOUNTING (receipt-order) axis — `fifo_cost_quantity_
 * consumed` — which is now SHARED Inventory state written by two paths:
 *
 *   (A) `SaleDepletionService.depleteForCompletedSale` (P1F-2)
 *   (B) `MovementsService.post`, for counter maintenance on any other
 *       outbound consumption of a costing_method=fifo batch-tracked item
 *
 * Both MUST take `FOR UPDATE` locks in the SAME deterministic order
 * (`created_at ASC, id ASC` — one ordering for BOTH the physical and the
 * accounting axis) — never `SKIP LOCKED`, so a racing writer BLOCKS rather
 * than silently working from a stale queue. The dual physical/cost ZIPPER
 * stays in `SaleDepletionService`, not here — this kernel only locks, plans
 * and applies the COST axis, and separately locates a carry-forward basis.
 */

import { Prisma } from '../../../generated/prisma/client';
import {
  Rational,
  ZERO,
  compare,
  fromExactDecimal,
  subtract,
} from '../../../common/money/rational';
import { parseExactDecimal } from '../../../common/money/rounding';

function exact(value: string): Rational {
  return fromExactDecimal(parseExactDecimal(value));
}

/** Render a non-negative Rational as an exact DECIMAL(18,6) string. */
export function toDecimal6(value: Rational): string {
  const SCALE = 1_000_000n;
  const scaled = (value.num * SCALE) / value.den;
  const remainder = (value.num * SCALE) % value.den;
  const rounded = remainder * 2n >= value.den ? scaled + 1n : scaled;
  const whole = rounded / SCALE;
  const frac = (rounded % SCALE).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

export interface LockedBatchLayer {
  readonly id: string;
  readonly quantityReceived: string;
  readonly quantityRemaining: string;
  readonly fifoCostQuantityConsumed: string;
  readonly unitCost: bigint;
  readonly createdAt: Date;
  readonly expiryDate: Date | null;
}

/**
 * Lock every batch layer for (tenantId, stockItemId, locationId) that is
 * still eligible on EITHER axis — physical (`quantity_remaining > 0`) or
 * accounting (`quantity_received - fifo_cost_quantity_consumed > 0`) — in
 * ONE deterministic order, `FOR UPDATE`, never `SKIP LOCKED`. A racing
 * writer touching the same (item, location) blocks here until the winner
 * commits or rolls back — the invariant that makes both axes race-free.
 */
export async function lockLayers(
  tx: Prisma.TransactionClient,
  tenantId: string,
  stockItemId: string,
  locationId: string,
): Promise<LockedBatchLayer[]> {
  return tx.$queryRaw<LockedBatchLayer[]>`
    SELECT "id",
           "quantity_received"::text AS "quantityReceived",
           "quantity_remaining"::text AS "quantityRemaining",
           "fifo_cost_quantity_consumed"::text AS "fifoCostQuantityConsumed",
           "unit_cost" AS "unitCost",
           "created_at" AS "createdAt",
           "expiry_date" AS "expiryDate"
    FROM "inventory"."stock_batches"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "stock_item_id" = ${stockItemId}::uuid
      AND "location_id" = ${locationId}::uuid
      AND ( "quantity_remaining" > 0
         OR ("quantity_received" - "fifo_cost_quantity_consumed") > 0 )
    ORDER BY "created_at" ASC, "id" ASC
    FOR UPDATE
  `;
}

export interface CostSlice {
  readonly batchId: string;
  readonly quantity: Rational;
  readonly unitCost: bigint;
}

/**
 * RECEIPT-ORDER accounting plan: consume `quantity` from the locked layers
 * strictly in the order they were locked (`created_at ASC, id ASC`),
 * regardless of the item's `batch_strategy` — FIFO COST is ALWAYS receipt
 * order, even under FEFO physical selection. Only layers with accounting
 * headroom (`quantity_received - fifo_cost_quantity_consumed > 0`)
 * contribute. Any uncovered remainder is the caller's carry-forward amount.
 */
export function planFifoCostConsumption(
  lockedLayers: readonly LockedBatchLayer[],
  quantity: Rational,
): { readonly slices: readonly CostSlice[]; readonly shortfall: Rational } {
  let remaining = quantity;
  const slices: CostSlice[] = [];
  for (const layer of lockedLayers) {
    if (remaining.num <= 0n) break;
    const available = subtract(
      exact(layer.quantityReceived),
      exact(layer.fifoCostQuantityConsumed),
    );
    if (available.num <= 0n) continue;
    const take = compare(available, remaining) < 0 ? available : remaining;
    if (take.num <= 0n) continue;
    slices.push({
      batchId: layer.id,
      quantity: take,
      unitCost: layer.unitCost,
    });
    remaining = subtract(remaining, take);
  }
  return { slices, shortfall: remaining.num > 0n ? remaining : ZERO };
}

/**
 * Increment `fifo_cost_quantity_consumed` for every slice. Callers MUST hold
 * the `FOR UPDATE` lock from `lockLayers` on every batch touched here.
 */
export async function applyCostConsumption(
  tx: Prisma.TransactionClient,
  slices: readonly CostSlice[],
): Promise<void> {
  for (const slice of slices) {
    if (slice.quantity.num <= 0n) continue;
    await tx.$executeRaw`
      UPDATE "inventory"."stock_batches"
      SET "fifo_cost_quantity_consumed" = "fifo_cost_quantity_consumed" + ${toDecimal6(slice.quantity)}::numeric
      WHERE "id" = ${slice.batchId}::uuid
    `;
  }
}

export interface CarryForwardBasis {
  readonly batchId: string;
  readonly unitCost: bigint;
}

/**
 * FIFO Exhaustion Carry-Forward (ratified 2026-08-25) — the most recently
 * exhausted accounting layer (`quantity_received - fifo_cost_quantity_
 * consumed = 0`), by receipt order, `DESC` so the LATEST exhausted layer
 * (the truest available approximation of current cost) wins. Called AFTER
 * `applyCostConsumption`'s increments, so a layer this call itself just
 * exhausted is correctly eligible. Returns `null` when no exhausted layer
 * exists either — the caller's cue to throw and roll back the WHOLE
 * Completion (P1F2C §F); this kernel never falls back to weighted-average,
 * standard, or latest-purchase cost.
 */
export async function findCarryForwardBasis(
  tx: Prisma.TransactionClient,
  tenantId: string,
  stockItemId: string,
  locationId: string,
): Promise<CarryForwardBasis | null> {
  const rows = await tx.$queryRaw<{ id: string; unitCost: bigint }[]>`
    SELECT "id", "unit_cost" AS "unitCost"
    FROM "inventory"."stock_batches"
    WHERE "tenant_id" = ${tenantId}::uuid
      AND "stock_item_id" = ${stockItemId}::uuid
      AND "location_id" = ${locationId}::uuid
      AND ("quantity_received" - "fifo_cost_quantity_consumed") = 0
    ORDER BY "created_at" DESC, "id" DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { batchId: row.id, unitCost: row.unitCost } : null;
}
