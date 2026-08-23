/**
 * Current cost per BASE unit of a stock item — the `cost_per_base_unit`
 * BR-MNU-003 asks for.
 *
 * ── THIS DOES NOT REIMPLEMENT INVENTORY VALUATION ──────────────────────────
 * It READS the state Inventory already maintains and dispatches on the item's
 * own `costing_method` (FR-INV-001). Nothing here decides what a movement is
 * worth; `MovementsService` does that and writes the result. There is no global
 * default method, and no method ever falls back to another — a FIFO item with no
 * layers reports "unknown", it does not quietly become the weighted average.
 *
 *   weighted_average  the prevailing average the projection already holds
 *   fifo              the cost of the batch that would be consumed NEXT
 *   standard          the item's fixed standard cost
 *
 * ── LOCATION SCOPE — AN IMPLEMENTATION CHOICE, RECORDED ────────────────────
 * `stock_levels` and `stock_batches` are per (item, LOCATION); a RecipeVersion
 * has no location, and BR-MNU-003 says only "current valuation using that stock
 * item's configured costing method". The SRS gives no location scope for recipe
 * cost, so one is chosen and stated rather than left implicit:
 *
 *   weighted_average  value-weighted across every location HOLDING stock; when
 *                     nothing is held anywhere, the most recently moved level's
 *                     average, which is the last valuation actually observed.
 *   fifo              the oldest remaining batch across all locations, which is
 *                     the layer FIFO would consume next.
 *
 * Neither invents a number: both read a value Inventory wrote.
 *
 * ── EXACTNESS ─────────────────────────────────────────────────────────────
 * `costing.ts` (Inventory) computes with `number` and `Math.round`. That is
 * pre-existing and is deliberately NOT touched here. This module reads only the
 * PERSISTED results — `average_cost`, `unit_cost`, `standard_cost` are all
 * BIGINT — and carries them onward as exact rationals, so the pre-existing float
 * step is not inherited into the cost chain.
 */

import { Injectable } from '@nestjs/common';
import { Rational, rational } from '../../../common/money/rational';
import { Prisma } from '../../../generated/prisma/client';

export type CostingMethodValue = 'weighted_average' | 'fifo' | 'standard';

export interface StockValuation {
  readonly stockItemId: string;
  readonly method: CostingMethodValue;
  /**
   * Cost of one BASE unit in minor units, exact. `null` means the item has NO
   * current valuation — never zero. A zero here would be a claim that the
   * ingredient is free.
   */
  readonly costPerBaseUnit: Rational | null;
}

/**
 * The port the cost calculator depends on. Narrow on purpose: one question, one
 * answer, so a test can substitute a controlled valuation without a database and
 * so no part of Inventory leaks into Production.
 */
export interface StockValuationReader {
  valuationsFor(
    tx: Prisma.TransactionClient,
    stockItemIds: readonly string[],
  ): Promise<Map<string, StockValuation>>;
}

@Injectable()
export class StockValuationService implements StockValuationReader {
  /**
   * Batch-resolve valuations. Batched rather than per-item because a ten-deep
   * recipe expansion touches many items and a per-item round trip inside a write
   * transaction is how a checkout gets slow.
   */
  async valuationsFor(
    tx: Prisma.TransactionClient,
    stockItemIds: readonly string[],
  ): Promise<Map<string, StockValuation>> {
    const ids = [...new Set(stockItemIds)];
    const out = new Map<string, StockValuation>();
    if (ids.length === 0) return out;

    const items = await tx.stockItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, costingMethod: true, standardCost: true },
    });

    const needsLevels = items.filter(
      (i) => i.costingMethod === 'weighted_average',
    );
    const needsBatches = items.filter((i) => i.costingMethod === 'fifo');

    const levels = needsLevels.length
      ? await tx.stockLevel.findMany({
          where: { stockItemId: { in: needsLevels.map((i) => i.id) } },
          select: {
            stockItemId: true,
            quantityOnHand: true,
            averageCost: true,
            lastMovementOccurredAt: true,
          },
        })
      : [];

    const batches = needsBatches.length
      ? await tx.stockBatch.findMany({
          where: {
            stockItemId: { in: needsBatches.map((i) => i.id) },
            quantityRemaining: { gt: 0 },
          },
          select: { stockItemId: true, unitCost: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    for (const item of items) {
      const method = item.costingMethod;
      out.set(item.id, {
        stockItemId: item.id,
        method,
        costPerBaseUnit: this.resolve(
          item.id,
          method,
          item.standardCost,
          levels,
          batches,
        ),
      });
    }
    return out;
  }

  private resolve(
    stockItemId: string,
    method: CostingMethodValue,
    standardCost: bigint | null,
    levels: {
      stockItemId: string;
      quantityOnHand: Prisma.Decimal;
      averageCost: bigint;
      lastMovementOccurredAt: Date | null;
    }[],
    batches: { stockItemId: string; unitCost: bigint; createdAt: Date }[],
  ): Rational | null {
    switch (method) {
      case 'standard':
        // FR-INV-012 standard cost. An item configured for `standard` with no
        // standard cost set has no valuation at all — it is not free.
        return standardCost === null ? null : rational(standardCost);

      case 'weighted_average': {
        const mine = levels.filter((l) => l.stockItemId === stockItemId);
        if (mine.length === 0) return null;

        // Value-weighted across locations that actually hold stock. Quantities
        // are DECIMAL(18,6); they are scaled to integers so the weighting stays
        // exact rather than passing through a float.
        const SCALE = 1_000_000n;
        let value = 0n;
        let quantity = 0n;
        for (const level of mine) {
          const qty = this.decimalToScaled(level.quantityOnHand, SCALE);
          if (qty <= 0n) continue;
          value += qty * level.averageCost;
          quantity += qty;
        }
        if (quantity > 0n) return rational(value, quantity);

        // Nothing held anywhere. Fall back to the most recently observed
        // valuation, which is a value Inventory wrote — not an invention.
        const latest = mine
          .filter((l) => l.averageCost > 0n)
          .sort(
            (a, b) =>
              (b.lastMovementOccurredAt?.getTime() ?? 0) -
              (a.lastMovementOccurredAt?.getTime() ?? 0),
          )[0];
        return latest ? rational(latest.averageCost) : null;
      }

      case 'fifo': {
        // FR-INV-013 values a consumption at the cost of the batches consumed,
        // oldest first. The cost of the NEXT base unit is therefore the oldest
        // remaining layer. No layers means no FIFO cost: this deliberately does
        // NOT fall back to the average, which would be a fabricated FIFO.
        const oldest = batches.find((b) => b.stockItemId === stockItemId);
        return oldest ? rational(oldest.unitCost) : null;
      }
    }
  }

  /** Exact Decimal -> scaled integer. Never through `Number`. */
  private decimalToScaled(value: Prisma.Decimal, scale: bigint): bigint {
    const text = value.toFixed(6);
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    const digits = `${whole}${fraction.padEnd(6, '0')}`;
    const scaled = (BigInt(digits) * scale) / 1_000_000n;
    return negative ? -scaled : scaled;
  }
}
