/**
 * Inventory's implementation of the P1F-2 `SaleDepletionCommand` contract.
 * Lives OUTSIDE `contract/` per the module-boundary rule. Owns the dual
 * physical/cost ZIPPER (P1F2E-A §E step 3d) — the private
 * `costing/fifo-cost-ledger.ts` kernel only locks, plans and applies the
 * COST axis.
 *
 * Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
 * correction.md (CONTROLLING) §L "E. INVENTORY — DUAL AXIS", ORDER IS
 * NORMATIVE throughout this file.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  Rational,
  ZERO,
  add,
  compare,
  fromExactDecimal,
  multiply,
  subtract,
  toMinorUnits,
} from '../../../common/money/rational';
import { parseExactDecimal } from '../../../common/money/rounding';
import { Prisma } from '../../../generated/prisma/client';
import {
  CostSlice,
  LockedBatchLayer,
  applyCostConsumption,
  findCarryForwardBasis,
  lockLayers,
  planFifoCostConsumption,
  toDecimal6,
} from '../costing/fifo-cost-ledger';
import type {
  DepleteForCompletedSaleInput,
  DepleteForCompletedSaleResult,
  SaleDepletionAllocationResult,
  SaleDepletionCommand,
  SaleDepletionEffectResult,
  SaleDepletionLineResult,
} from '../contract/sale-depletion.contract';
import {
  NoHistoricalCostLayerError,
  SaleDepletionEffectConflictError,
} from '../contract/sale-depletion.errors';

function exact(value: string): Rational {
  return fromExactDecimal(parseExactDecimal(value));
}

interface PhysicalSlice {
  readonly physicalBatchId: string | null;
  readonly quantity: Rational;
}

interface ZippedSlice {
  readonly physicalBatchId: string | null;
  readonly costBasisBatchId: string | null;
  readonly quantity: Rational;
  readonly unitCost: bigint;
}

/** One flattened (orderLineId, stockItemId) unit of work, before sorting. */
interface DepletionTriple {
  readonly orderLineId: string;
  readonly stockItemId: string;
  readonly quantityInBaseUnit: string;
  readonly unitId: string;
}

@Injectable()
export class SaleDepletionService implements SaleDepletionCommand {
  async depleteForCompletedSale(
    tx: Prisma.TransactionClient,
    input: DepleteForCompletedSaleInput,
  ): Promise<DepleteForCompletedSaleResult> {
    const location = await tx.location.findFirst({
      where: {
        tenantId: input.tenantId,
        locationType: 'branch',
        refId: input.branchId,
      },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException(
        `No inventory location is registered for branch ${input.branchId}.`,
      );
    }
    const locationId = location.id;

    // Flatten, then process distinct (stock_item_id, location_id) ASC, then
    // order_line_id ASC — NEVER JS map iteration order (P1F2E-A §E). Since
    // this slice depletes a single resolved branch location, the sort key
    // reduces to (stockItemId ASC, orderLineId ASC).
    const triples: DepletionTriple[] = [];
    for (const line of input.lines) {
      for (const component of line.components) {
        if (exact(component.quantityInBaseUnit).num <= 0n) continue;
        triples.push({
          orderLineId: line.orderLineId,
          stockItemId: component.stockItemId,
          quantityInBaseUnit: component.quantityInBaseUnit,
          unitId: component.unitId,
        });
      }
    }
    triples.sort((a, b) => {
      if (a.stockItemId !== b.stockItemId) {
        return a.stockItemId < b.stockItemId ? -1 : 1;
      }
      return a.orderLineId < b.orderLineId
        ? -1
        : a.orderLineId > b.orderLineId
          ? 1
          : 0;
    });

    const stockItemIds = [...new Set(triples.map((t) => t.stockItemId))];
    const stockItems = await tx.stockItem.findMany({
      where: { id: { in: stockItemIds } },
      select: {
        id: true,
        costingMethod: true,
        batchStrategy: true,
        isBatchTracked: true,
        standardCost: true,
        baseUnitId: true,
      },
    });
    const stockItemById = new Map(stockItems.map((i) => [i.id, i]));

    const effectsByLine = new Map<string, SaleDepletionEffectResult[]>();
    const distinctFifoStockItemIds = new Set<string>();

    // A1-2: lock FIFO layers ONCE per distinct (stockItemId, locationId) key
    // instead of once per logical effect. `triples` is already sorted
    // (stockItemId ASC, then orderLineId ASC) above; `locationId` is a
    // single resolved value for this whole call, so that existing sort
    // ALREADY produces the required global lock order — stock_item_id
    // ascending, then location_id — and keeps same-key triples contiguous,
    // so a group boundary is detected simply by watching the key change as
    // the sorted array is walked. The within-group processing order stays
    // exactly what it already was: orderLineId ASC.
    let currentGroupKey: string | null = null;
    let lockedLayers: LockedBatchLayer[] = [];

    for (const triple of triples) {
      const item = stockItemById.get(triple.stockItemId);
      if (!item) {
        throw new NotFoundException(
          `Stock item ${triple.stockItemId} not found.`,
        );
      }
      const requested = exact(triple.quantityInBaseUnit);

      // STEP 1 — reserve the business identity FIRST, before ANY Inventory
      // mutation. `ON CONFLICT ... DO NOTHING`, never insert-catch-P2002.
      const effectId = newId();
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "inventory"."sale_depletion_effects"
          ("id", "tenant_id", "order_id", "business_day", "order_line_id",
           "stock_item_id", "location_id", "quantity_in_base_unit", "unit_id", "created_at")
        VALUES (${effectId}::uuid, ${input.tenantId}::uuid, ${input.orderId}::uuid,
                ${input.businessDay}::date, ${triple.orderLineId}::uuid,
                ${triple.stockItemId}::uuid, ${locationId}::uuid,
                ${triple.quantityInBaseUnit}::numeric, ${triple.unitId}::uuid, ${input.occurredAt}::timestamptz)
        ON CONFLICT ("tenant_id", "order_line_id", "stock_item_id", "location_id") DO NOTHING
        RETURNING "id"
      `;
      // STEP 2 — 0 rows: a genuine conflict. No Inventory state touched.
      if (inserted.length === 0) {
        throw new SaleDepletionEffectConflictError(
          `A depletion effect already exists for order line ${triple.orderLineId}, ` +
            `stock item ${triple.stockItemId}, location ${locationId}.`,
        );
      }
      const winningEffectId = inserted[0].id;

      // STEP 3 — WINNER ONLY.
      // 3a — lock layers, one ordering for both axes. ONCE per distinct
      // (stockItemId, locationId): a later triple in the SAME group reuses
      // the working state evolved below, never a stale re-read.
      const groupKey = `${triple.stockItemId}::${locationId}`;
      if (groupKey !== currentGroupKey) {
        lockedLayers = await lockLayers(
          tx,
          input.tenantId,
          triple.stockItemId,
          locationId,
        );
        currentGroupKey = groupKey;
      }

      // 3b — PHYSICAL PLAN, against the CURRENT working state.
      const physicalSlices = item.isBatchTracked
        ? this.planPhysicalConsumption(
            lockedLayers,
            requested,
            item.batchStrategy,
          )
        : { slices: [] as PhysicalSlice[], shortfall: requested };
      const physical: PhysicalSlice[] = [...physicalSlices.slices];
      if (physicalSlices.shortfall.num > 0n) {
        physical.push({
          physicalBatchId: null,
          quantity: physicalSlices.shortfall,
        });
      }
      for (const slice of physicalSlices.slices) {
        await tx.$executeRaw`
          UPDATE "inventory"."stock_batches"
          SET "quantity_remaining" = "quantity_remaining" - ${toDecimal6(slice.quantity)}::numeric
          WHERE "id" = ${slice.physicalBatchId}::uuid
        `;
      }
      // Evolve the PHYSICAL axis of the working state to match the write
      // just issued, so the NEXT triple in this group (if any) plans
      // against the post-consumption state rather than the original
      // snapshot `lockLayers` returned at the top of the group — equivalent
      // to re-reading the locked rows from PostgreSQL, without doing so.
      lockedLayers = this.evolvePhysicalState(
        lockedLayers,
        physicalSlices.slices,
      );

      // 3c — COST PLAN. `batchId` is null only for weighted_average/standard
      // (a single whole-quantity slice with no cost-basis batch); FIFO slices
      // — including the carry-forward one — always carry a real batch id.
      let cost: readonly {
        batchId: string | null;
        quantity: Rational;
        unitCost: bigint;
      }[];
      if (
        item.costingMethod === 'weighted_average' ||
        item.costingMethod === 'standard'
      ) {
        const unitCost =
          item.costingMethod === 'standard'
            ? (item.standardCost ?? 0n)
            : await this.currentAverageCost(tx, triple.stockItemId, locationId);
        cost = [{ batchId: null, quantity: requested, unitCost }];
      } else {
        distinctFifoStockItemIds.add(triple.stockItemId);
        const plan = planFifoCostConsumption(lockedLayers, requested);
        await applyCostConsumption(tx, plan.slices);
        // Evolve the ACCOUNTING axis of the working state to match the
        // write just issued — independent of the physical axis above
        // (D-INV-03 / §9): FIFO costing consumes receipt order regardless
        // of which physical batch FEFO selected.
        lockedLayers = this.evolveAccountingState(lockedLayers, plan.slices);
        const slices = [...plan.slices];
        if (plan.shortfall.num > 0n) {
          const basis = await findCarryForwardBasis(
            tx,
            input.tenantId,
            triple.stockItemId,
            locationId,
          );
          if (!basis) {
            throw new NoHistoricalCostLayerError(
              `No FIFO cost layer — current or exhausted — exists for stock item ` +
                `${triple.stockItemId} at location ${locationId}; the Completion cannot be valued.`,
            );
          }
          slices.push({
            batchId: basis.batchId,
            quantity: plan.shortfall,
            unitCost: basis.unitCost,
          });
        }
        cost = slices;
      }

      // 3d — ZIPPER: exact Decimal two-pointer merge over the same total D.
      const zipped = this.zip(
        physical,
        cost.map((c) => ({
          costBasisBatchId: c.batchId,
          quantity: c.quantity,
          unitCost: c.unitCost,
        })),
      );

      // 3e/3f — per allocation: stock_levels delta -> movement -> pointer
      // update -> insert the allocation row. Deterministic order.
      const allocations: SaleDepletionAllocationResult[] = [];
      let sequence = 0;
      for (const slice of zipped) {
        const allocation = await this.writeAllocation(
          tx,
          input,
          locationId,
          winningEffectId,
          triple.stockItemId,
          item.baseUnitId,
          sequence,
          slice,
        );
        allocations.push(allocation);
        sequence++;
      }

      const totalAllocated = allocations.reduce(
        (sum, a) => add(sum, exact(a.quantityInBaseUnit)),
        ZERO,
      );
      if (compare(totalAllocated, requested) !== 0) {
        throw new Error(
          `P1F-2 invariant violated: allocations for effect ${winningEffectId} sum to ` +
            `${toDecimal6(totalAllocated)}, expected ${toDecimal6(requested)}.`,
        );
      }

      const arr = effectsByLine.get(triple.orderLineId) ?? [];
      arr.push({
        effectId: winningEffectId,
        stockItemId: triple.stockItemId,
        locationId,
        allocations,
      });
      effectsByLine.set(triple.orderLineId, arr);
    }

    const perLine: SaleDepletionLineResult[] = input.lines.map((line) => {
      const effects = effectsByLine.get(line.orderLineId) ?? [];
      const postedCogsTotal = effects.reduce(
        (sum, e) => sum + e.allocations.reduce((s, a) => s + a.totalCost, 0n),
        0n,
      );
      return { orderLineId: line.orderLineId, postedCogsTotal, effects };
    });

    return { perLine, distinctFifoStockItemIds: [...distinctFifoStockItemIds] };
  }

  // ------------------------------------------------------------- internals

  private planPhysicalConsumption(
    lockedLayers: readonly LockedBatchLayer[],
    quantity: Rational,
    strategy: 'fifo' | 'fefo',
  ): { slices: PhysicalSlice[]; shortfall: Rational } {
    const eligible = lockedLayers.filter(
      (l) => exact(l.quantityRemaining).num > 0n,
    );
    const ordered =
      strategy === 'fefo'
        ? [...eligible].sort((a, b) => {
            const ax = a.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
            const bx = b.expiryDate?.getTime() ?? Number.POSITIVE_INFINITY;
            if (ax !== bx) return ax - bx;
            if (a.createdAt.getTime() !== b.createdAt.getTime()) {
              return a.createdAt.getTime() - b.createdAt.getTime();
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          })
        : eligible; // already created_at ASC, id ASC from lockLayers.

    let remaining = quantity;
    const slices: PhysicalSlice[] = [];
    for (const layer of ordered) {
      if (remaining.num <= 0n) break;
      const available = exact(layer.quantityRemaining);
      const take = compare(available, remaining) < 0 ? available : remaining;
      if (take.num <= 0n) continue;
      slices.push({ physicalBatchId: layer.id, quantity: take });
      remaining = subtract(remaining, take);
    }
    return { slices, shortfall: remaining.num > 0n ? remaining : ZERO };
  }

  /**
   * A1-2: evolve the PHYSICAL axis (`quantity_remaining`) of a locked-layer
   * working set to match the `stock_batches` UPDATE just issued for
   * `slices`, so the next logical effect in the same locked
   * (stockItemId, locationId) group plans against the true post-consumption
   * state — equivalent to re-reading the locked rows from PostgreSQL,
   * without doing so. Pure/exact: never mutates its input, never touches
   * the independent ACCOUNTING axis (see `evolveAccountingState`).
   */
  private evolvePhysicalState(
    layers: readonly LockedBatchLayer[],
    slices: readonly PhysicalSlice[],
  ): LockedBatchLayer[] {
    const deltas = new Map<string, Rational>();
    for (const s of slices) {
      if (!s.physicalBatchId) continue;
      deltas.set(
        s.physicalBatchId,
        add(deltas.get(s.physicalBatchId) ?? ZERO, s.quantity),
      );
    }
    return layers.map((l) => {
      const d = deltas.get(l.id);
      return d
        ? {
            ...l,
            quantityRemaining: toDecimal6(
              subtract(exact(l.quantityRemaining), d),
            ),
          }
        : l;
    });
  }

  /**
   * A1-2: evolve the ACCOUNTING axis (`fifo_cost_quantity_consumed`) of a
   * locked-layer working set to match the `stock_batches` UPDATE just
   * issued by `applyCostConsumption` for `slices` — the FIFO receipt-order
   * counter, independent of whichever physical batch FEFO selected. Pure/
   * exact; never mutates its input.
   */
  private evolveAccountingState(
    layers: readonly LockedBatchLayer[],
    slices: readonly CostSlice[],
  ): LockedBatchLayer[] {
    const deltas = new Map<string, Rational>();
    for (const s of slices) {
      deltas.set(s.batchId, add(deltas.get(s.batchId) ?? ZERO, s.quantity));
    }
    return layers.map((l) => {
      const d = deltas.get(l.id);
      return d
        ? {
            ...l,
            fifoCostQuantityConsumed: toDecimal6(
              add(exact(l.fifoCostQuantityConsumed), d),
            ),
          }
        : l;
    });
  }

  /** Two-pointer merge — Σ emitted quantity MUST equal the shared total D exactly. */
  private zip(
    physical: readonly PhysicalSlice[],
    cost: readonly {
      costBasisBatchId: string | null;
      quantity: Rational;
      unitCost: bigint;
    }[],
  ): ZippedSlice[] {
    const out: ZippedSlice[] = [];
    let pi = 0;
    let ci = 0;
    let pRemaining = physical[0]?.quantity ?? ZERO;
    let cRemaining = cost[0]?.quantity ?? ZERO;
    while (pi < physical.length && ci < cost.length) {
      const take =
        compare(pRemaining, cRemaining) < 0 ? pRemaining : cRemaining;
      if (take.num > 0n) {
        out.push({
          physicalBatchId: physical[pi].physicalBatchId,
          costBasisBatchId: cost[ci].costBasisBatchId,
          quantity: take,
          unitCost: cost[ci].unitCost,
        });
      }
      pRemaining = subtract(pRemaining, take);
      cRemaining = subtract(cRemaining, take);
      if (pRemaining.num <= 0n) {
        pi++;
        pRemaining = physical[pi]?.quantity ?? ZERO;
      }
      if (cRemaining.num <= 0n) {
        ci++;
        cRemaining = cost[ci]?.quantity ?? ZERO;
      }
    }
    return out;
  }

  private async currentAverageCost(
    tx: Prisma.TransactionClient,
    stockItemId: string,
    locationId: string,
  ): Promise<bigint> {
    const level = await tx.stockLevel.findUnique({
      where: { stockItemId_locationId: { stockItemId, locationId } },
      select: { averageCost: true },
    });
    return level?.averageCost ?? 0n;
  }

  private async writeAllocation(
    tx: Prisma.TransactionClient,
    input: DepleteForCompletedSaleInput,
    locationId: string,
    effectId: string,
    stockItemId: string,
    baseUnitId: string,
    sequence: number,
    slice: ZippedSlice,
  ): Promise<SaleDepletionAllocationResult> {
    const totalCost = toMinorUnits(
      multiply(slice.quantity, { num: slice.unitCost, den: 1n }),
    );

    // 1 — atomic signed projection delta. Does NOT touch last_movement_* or average_cost.
    const projected = await tx.$queryRaw<{ quantityOnHand: string }[]>`
      INSERT INTO "inventory"."stock_levels"
        ("tenant_id", "stock_item_id", "location_id", "quantity_on_hand")
      VALUES (${input.tenantId}::uuid, ${stockItemId}::uuid, ${locationId}::uuid,
              ${'-' + toDecimal6(slice.quantity)}::numeric)
      ON CONFLICT ("stock_item_id", "location_id") DO UPDATE
        SET "quantity_on_hand" = "inventory"."stock_levels"."quantity_on_hand" + EXCLUDED."quantity_on_hand"
      RETURNING "quantity_on_hand"::text AS "quantityOnHand"
    `;
    const balanceAfter = projected[0].quantityOnHand;

    // 2 — the stock movement itself.
    const movementId = newId();
    await tx.stockMovement.create({
      data: {
        id: movementId,
        occurredAt: input.occurredAt,
        tenantId: input.tenantId,
        locationId,
        stockItemId,
        batchId: slice.physicalBatchId,
        movementType: 'sale_depletion',
        quantity: new Prisma.Decimal(toDecimal6(slice.quantity)).negated(),
        unitId: baseUnitId,
        unitCost: slice.unitCost,
        totalCost,
        balanceAfter: new Prisma.Decimal(balanceAfter),
        referenceType: 'order',
        // NOT order_line_id — the ORDER id, per P1F2E-A §L step 3e-2.
        referenceId: input.orderId,
        performedBy: input.actorId,
      },
    });

    // 3 — pointer update.
    await tx.stockLevel.update({
      where: { stockItemId_locationId: { stockItemId, locationId } },
      data: {
        lastMovementId: movementId,
        lastMovementOccurredAt: input.occurredAt,
      },
    });

    // sale_depletion_allocations row.
    const allocationId = newId();
    await tx.$executeRaw`
      INSERT INTO "inventory"."sale_depletion_allocations"
        ("id", "tenant_id", "effect_id", "sequence", "stock_item_id", "location_id",
         "physical_batch_id", "cost_basis_batch_id", "quantity_in_base_unit", "unit_id",
         "unit_cost", "total_cost", "movement_id", "movement_occurred_at", "created_at")
      VALUES (${allocationId}::uuid, ${input.tenantId}::uuid, ${effectId}::uuid, ${sequence},
              ${stockItemId}::uuid, ${locationId}::uuid,
              ${slice.physicalBatchId}::uuid, ${slice.costBasisBatchId}::uuid,
              ${toDecimal6(slice.quantity)}::numeric, ${baseUnitId}::uuid,
              ${slice.unitCost}, ${totalCost}, ${movementId}::uuid, ${input.occurredAt}::timestamptz,
              ${input.occurredAt}::timestamptz)
    `;

    return {
      id: allocationId,
      sequence,
      physicalBatchId: slice.physicalBatchId,
      costBasisBatchId: slice.costBasisBatchId,
      quantityInBaseUnit: toDecimal6(slice.quantity),
      unitId: baseUnitId,
      unitCost: slice.unitCost,
      totalCost,
      movementId,
      movementOccurredAt: input.occurredAt,
    };
  }
}
