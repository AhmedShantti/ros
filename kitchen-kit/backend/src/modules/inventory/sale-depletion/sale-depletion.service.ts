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
 *
 * A1-3B (design gate: docs/reports/claude/full-srs-4day/2026-09-02_A1-3_
 * set-oriented-depletion-design-gate.md) replaced the per-allocation write
 * quartet (`writeAllocation`) with a set-oriented write per stock-key group:
 * one aggregated physical `stock_batches` UPDATE, one aggregated accounting
 * `stock_batches` UPDATE (with a mandatory carry-forward flush — §9.2 of the
 * design gate), one `stock_levels` delta + `stock_movements` INSERT with a
 * SQL window-computed `balance_after`, and one pointer UPDATE + multi-row
 * `sale_depletion_allocations` INSERT. Planning (the physical/accounting
 * planners, the evolve-state functions, the zipper) is unchanged from A1-2.
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

/**
 * A1-3A — the canonical business identity for one depletion effect, matching
 * `sale_depletion_effects`'s real unique constraint
 * `(tenant_id, order_line_id, stock_item_id, location_id)` (tenant is
 * constant for the whole call, so it is omitted from the key).
 */
function effectIdentityKey(
  orderLineId: string,
  stockItemId: string,
  locationId: string,
): string {
  return `${orderLineId}::${stockItemId}::${locationId}`;
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

/** A1-3B — a (triple, its already-reserved effect id) pair, group-scoped. */
interface GroupItem {
  readonly triple: DepletionTriple;
  readonly effectId: string;
}

/** A1-3B — one row of the per-group aggregated `stock_batches` payload. */
interface BatchDeltaRow {
  readonly batch_id: string;
  readonly qty: string;
}

/** A1-3B — one row of the per-group `stock_levels` delta + movements payload. */
interface MovementRow {
  readonly ord: number;
  readonly movement_id: string;
  readonly batch_id: string | null;
  readonly qty: string;
  readonly unit_cost: string;
  readonly total_cost: string;
}

/** A1-3B — one row of the per-group pointer + allocations payload. */
interface AllocationRow {
  readonly ord: number;
  readonly effect_id: string;
  readonly seq: number;
  readonly allocation_id: string;
  readonly movement_id: string;
  readonly physical_batch_id: string | null;
  readonly cost_basis_batch_id: string | null;
  readonly qty: string;
  readonly unit_cost: string;
  readonly total_cost: string;
}

interface StockItemRow {
  readonly id: string;
  readonly costingMethod: string;
  readonly batchStrategy: 'fifo' | 'fefo';
  readonly isBatchTracked: boolean;
  readonly standardCost: bigint | null;
  readonly baseUnitId: string;
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

    // A1-3A — reject a duplicate business identity WITHIN this single
    // request BEFORE any SQL at all. Without this, a payload duplicate
    // would let the set-oriented `ON CONFLICT DO NOTHING` reservation below
    // silently insert only ONE of the two identically-keyed rows while both
    // call sites believe they reserved a distinct effect — the exact
    // "masquerade as success" the design gate (§16.1) forbids.
    {
      const seen = new Set<string>();
      const duplicates: DepletionTriple[] = [];
      for (const triple of triples) {
        const key = effectIdentityKey(
          triple.orderLineId,
          triple.stockItemId,
          locationId,
        );
        if (seen.has(key)) {
          duplicates.push(triple);
        } else {
          seen.add(key);
        }
      }
      if (duplicates.length > 0) {
        throw new SaleDepletionEffectConflictError(
          `Duplicate depletion effect identity requested within the same call: ` +
            duplicates
              .map(
                (t) =>
                  `(order line ${t.orderLineId}, stock item ${t.stockItemId}, location ${locationId})`,
              )
              .join('; ') +
            '.',
        );
      }
    }

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
    const stockItemById = new Map<string, StockItemRow>(
      stockItems.map((i) => [i.id, i]),
    );
    // Validate BEFORE the reservation INSERT: a missing stock item would
    // otherwise surface as a raw FK violation from the reservation
    // statement (it targets every triple in one round trip) instead of this
    // clean 404 — no Inventory row has been touched yet either way.
    for (const triple of triples) {
      if (!stockItemById.has(triple.stockItemId)) {
        throw new NotFoundException(
          `Stock item ${triple.stockItemId} not found.`,
        );
      }
    }

    // A1-3A — STEP 1, hoisted: reserve EVERY business identity for this
    // call in ONE set-oriented statement, strictly before any Inventory
    // lock or mutation (design gate §5.2/§10). `effectId` is still
    // generated in JS with `newId()`, never `gen_random_uuid()`. Exact
    // numeric transport: `quantity` travels as the STRING already carried
    // by `triple.quantityInBaseUnit`, cast in SQL — never a JS float.
    const effectIds = triples.map(() => newId());
    if (triples.length > 0) {
      const reservationPayload = triples.map((t, i) => ({
        ord: i,
        effect_id: effectIds[i],
        order_line_id: t.orderLineId,
        stock_item_id: t.stockItemId,
        quantity: t.quantityInBaseUnit,
        unit_id: t.unitId,
      }));
      const reserved = await tx.$queryRaw<
        { orderLineId: string; stockItemId: string }[]
      >`
        WITH req AS (
          SELECT v.ord::int             AS ord,
                 v.effect_id::uuid      AS effect_id,
                 v.order_line_id::uuid  AS order_line_id,
                 v.stock_item_id::uuid  AS stock_item_id,
                 v.quantity::numeric    AS quantity,
                 v.unit_id::uuid        AS unit_id
          FROM jsonb_to_recordset(${JSON.stringify(reservationPayload)}::jsonb)
               AS v(ord int, effect_id text, order_line_id text,
                    stock_item_id text, quantity text, unit_id text)
        )
        INSERT INTO "inventory"."sale_depletion_effects"
          ("id", "tenant_id", "order_id", "business_day", "order_line_id",
           "stock_item_id", "location_id", "quantity_in_base_unit", "unit_id", "created_at")
        SELECT req.effect_id, ${input.tenantId}::uuid, ${input.orderId}::uuid,
               ${input.businessDay}::date, req.order_line_id,
               req.stock_item_id, ${locationId}::uuid, req.quantity, req.unit_id,
               ${input.occurredAt}::timestamptz
        FROM req
        ORDER BY req.ord
        ON CONFLICT ("tenant_id", "order_line_id", "stock_item_id", "location_id") DO NOTHING
        RETURNING "order_line_id" AS "orderLineId", "stock_item_id" AS "stockItemId"
      `;

      // STEP 2 — identity-based conflict detection, NOT cardinality: a row
      // absent from RETURNING is a genuine pre-existing conflict. Report
      // EVERY missing identity, not only the first. Zero Inventory state —
      // no `stock_batches` lock, no `stock_levels`/`stock_movements`/
      // `sale_depletion_allocations` write — has been touched at this point.
      const reservedKeys = new Set(
        reserved.map((r) =>
          effectIdentityKey(r.orderLineId, r.stockItemId, locationId),
        ),
      );
      const conflicts = triples.filter(
        (t) =>
          !reservedKeys.has(
            effectIdentityKey(t.orderLineId, t.stockItemId, locationId),
          ),
      );
      if (conflicts.length > 0) {
        throw new SaleDepletionEffectConflictError(
          `A depletion effect already exists for ${conflicts.length} of ${triples.length} ` +
            `requested effect(s): ` +
            conflicts
              .map(
                (t) =>
                  `(order line ${t.orderLineId}, stock item ${t.stockItemId}, location ${locationId})`,
              )
              .join('; ') +
            '.',
        );
      }
    }

    // A1-3A — hoist the weighted-average `current_cost` lookup: `average_
    // cost` is never written by this service (design gate §9.3), so its
    // value cannot change during this call. ONE lookup for every distinct
    // weighted-average stock item instead of one read per effect. FIFO and
    // standard-cost items never consult this map, and cost strategy
    // selection itself is untouched (still decided per-triple below).
    const weightedAverageStockItemIds = [
      ...new Set(
        triples
          .map((t) => stockItemById.get(t.stockItemId))
          .filter(
            (item): item is NonNullable<typeof item> =>
              !!item && item.costingMethod === 'weighted_average',
          )
          .map((item) => item.id),
      ),
    ];
    const averageCostByStockItemId = new Map<string, bigint>();
    if (weightedAverageStockItemIds.length > 0) {
      const levels = await tx.stockLevel.findMany({
        where: { stockItemId: { in: weightedAverageStockItemIds }, locationId },
        select: { stockItemId: true, averageCost: true },
      });
      for (const level of levels) {
        averageCostByStockItemId.set(level.stockItemId, level.averageCost);
      }
    }

    const effectsByLine = new Map<string, SaleDepletionEffectResult[]>();
    const distinctFifoStockItemIds = new Set<string>();

    // A1-3B — process contiguous stock-key groups set-orientedly. `triples`
    // is already sorted (stockItemId ASC, then orderLineId ASC), so a group
    // is exactly one contiguous run of equal `stockItemId` (`locationId` is
    // one resolved value for the whole call — design gate §3). Each group
    // does ONE `lockLayers` FOR UPDATE, then plans every effect in the group
    // in memory (A1-2's unchanged evolve functions), then issues at most
    // five statements total: aggregated physical UPDATE, aggregated
    // accounting UPDATE, `stock_levels` delta + movements, pointer +
    // allocations.
    const items: GroupItem[] = triples.map((triple, i) => ({
      triple,
      effectId: effectIds[i],
    }));
    let cursor = 0;
    while (cursor < items.length) {
      const groupStockItemId = items[cursor].triple.stockItemId;
      let end = cursor;
      while (
        end < items.length &&
        items[end].triple.stockItemId === groupStockItemId
      ) {
        end++;
      }
      await this.processGroup(
        tx,
        input,
        locationId,
        stockItemById,
        items.slice(cursor, end),
        averageCostByStockItemId,
        distinctFifoStockItemIds,
        effectsByLine,
      );
      cursor = end;
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

  /**
   * A1-3B — one stock-key group, set-oriented (design gate §5.3/§16.1B).
   * Statement order within the group is fixed: 2a lock → 2c physical →
   * 2d accounting → 2e levels+movements → 2f pointer+allocations, which
   * preserves the pre-existing relative lock order of `stock_batches`
   * before `stock_levels` per key (design gate §7.4).
   */
  private async processGroup(
    tx: Prisma.TransactionClient,
    input: DepleteForCompletedSaleInput,
    locationId: string,
    stockItemById: Map<string, StockItemRow>,
    groupItems: readonly GroupItem[],
    averageCostByStockItemId: Map<string, bigint>,
    distinctFifoStockItemIds: Set<string>,
    effectsByLine: Map<string, SaleDepletionEffectResult[]>,
  ): Promise<void> {
    const stockItemId = groupItems[0].triple.stockItemId;
    const item = stockItemById.get(stockItemId);
    if (!item) {
      // Unreachable: every triple's stock item was validated to exist
      // before the hoisted reservation statement ran.
      throw new NotFoundException(`Stock item ${stockItemId} not found.`);
    }

    // 2a — lock, once per group, unchanged kernel function/ordering.
    let lockedLayers = await lockLayers(
      tx,
      input.tenantId,
      stockItemId,
      locationId,
    );

    const physicalDeltaRows: BatchDeltaRow[] = [];
    let accountingPendingRows: BatchDeltaRow[] = [];
    const movementRows: MovementRow[] = [];
    const allocationRows: AllocationRow[] = [];
    let groupMagnitude: Rational = ZERO; // Σ|delta_i|; the group delta itself is always ≤ 0.
    let ord = 0;

    for (const { triple, effectId } of groupItems) {
      const requested = exact(triple.quantityInBaseUnit);

      // 3b — PHYSICAL PLAN, against the CURRENT working state. The actual
      // `stock_batches` UPDATE is DEFERRED to one aggregated statement at
      // the end of the group (§8 of the design gate) — each row here is
      // one physical slice; SQL `GROUP BY batch_id` performs the exact
      // aggregation, never JS pre-aggregation alone (§8.1 mandatory rule).
      const physicalPlan = item.isBatchTracked
        ? this.planPhysicalConsumption(
            lockedLayers,
            requested,
            item.batchStrategy,
          )
        : { slices: [] as PhysicalSlice[], shortfall: requested };
      const physical: PhysicalSlice[] = [...physicalPlan.slices];
      if (physicalPlan.shortfall.num > 0n) {
        physical.push({
          physicalBatchId: null,
          quantity: physicalPlan.shortfall,
        });
      }
      for (const slice of physicalPlan.slices) {
        physicalDeltaRows.push({
          batch_id: slice.physicalBatchId as string,
          qty: toDecimal6(slice.quantity),
        });
      }
      lockedLayers = this.evolvePhysicalState(
        lockedLayers,
        physicalPlan.slices,
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
            : (averageCostByStockItemId.get(stockItemId) ?? 0n);
        cost = [{ batchId: null, quantity: requested, unitCost }];
      } else {
        distinctFifoStockItemIds.add(stockItemId);
        const plan = planFifoCostConsumption(lockedLayers, requested);
        for (const slice of plan.slices) {
          accountingPendingRows.push({
            batch_id: slice.batchId,
            qty: toDecimal6(slice.quantity),
          });
        }
        // Independent of the physical axis above (D-INV-03 / design gate
        // §9): FIFO costing consumes receipt order regardless of which
        // physical batch FEFO selected. Pure/in-memory; unaffected by when
        // the aggregated DB write below actually happens.
        lockedLayers = this.evolveAccountingState(lockedLayers, plan.slices);
        const slices: CostSlice[] = [...plan.slices];
        if (plan.shortfall.num > 0n) {
          // MANDATORY carry-forward flush rule (design gate §9.2): flush
          // every accounting delta accumulated so far in THIS group —
          // including this effect's own slices just queued above — before
          // querying for a carry-forward basis. `findCarryForwardBasis`
          // must see the same `fifo_cost_quantity_consumed` state the
          // sequential (A1-2) design would have at this exact point, or it
          // can return a different, stale-cost layer (design gate §9.2,
          // proven live by probe P7).
          if (accountingPendingRows.length > 0) {
            await this.runAccountingAggregateUpdate(tx, accountingPendingRows);
            accountingPendingRows = [];
          }
          const basis = await findCarryForwardBasis(
            tx,
            input.tenantId,
            stockItemId,
            locationId,
          );
          if (!basis) {
            throw new NoHistoricalCostLayerError(
              `No FIFO cost layer — current or exhausted — exists for stock item ` +
                `${stockItemId} at location ${locationId}; the Completion cannot be valued.`,
            );
          }
          // Carry-forward is a valuation reference, not a real consumption
          // of `basis.batchId` — it is EXCLUDED from the persisted
          // aggregate, exactly as `applyCostConsumption` excluded it
          // pre-A1-3B (design gate §9.1).
          slices.push({
            batchId: basis.batchId,
            quantity: plan.shortfall,
            unitCost: basis.unitCost,
          });
        }
        cost = slices;
      }

      // 3d — ZIPPER: exact Decimal two-pointer merge over the same total D.
      const zipped: ZippedSlice[] = this.zip(
        physical,
        cost.map((c) => ({
          costBasisBatchId: c.batchId,
          quantity: c.quantity,
          unitCost: c.unitCost,
        })),
      );

      // 3e/3f — build the movement/allocation rows for this effect's
      // slices, in `ord` order, but DO NOT write yet — one write per group,
      // not per slice (design gate §5.4/§5.6).
      const allocations: SaleDepletionAllocationResult[] = [];
      let sequence = 0;
      for (const slice of zipped) {
        const movementId = newId();
        const allocationId = newId();
        const totalCost = toMinorUnits(
          multiply(slice.quantity, { num: slice.unitCost, den: 1n }),
        );
        const unitCostStr = slice.unitCost.toString();
        const totalCostStr = totalCost.toString();
        const qtyStr = toDecimal6(slice.quantity);

        movementRows.push({
          ord,
          movement_id: movementId,
          batch_id: slice.physicalBatchId,
          qty: '-' + qtyStr,
          unit_cost: unitCostStr,
          total_cost: totalCostStr,
        });
        allocationRows.push({
          ord,
          effect_id: effectId,
          seq: sequence,
          allocation_id: allocationId,
          movement_id: movementId,
          physical_batch_id: slice.physicalBatchId,
          cost_basis_batch_id: slice.costBasisBatchId,
          qty: qtyStr,
          unit_cost: unitCostStr,
          total_cost: totalCostStr,
        });
        groupMagnitude = add(groupMagnitude, slice.quantity);

        allocations.push({
          id: allocationId,
          sequence,
          physicalBatchId: slice.physicalBatchId,
          costBasisBatchId: slice.costBasisBatchId,
          quantityInBaseUnit: qtyStr,
          unitId: item.baseUnitId,
          unitCost: slice.unitCost,
          totalCost,
          movementId,
          movementOccurredAt: input.occurredAt,
        });
        ord++;
        sequence++;
      }

      const totalAllocated = allocations.reduce(
        (sum, a) => add(sum, exact(a.quantityInBaseUnit)),
        ZERO,
      );
      if (compare(totalAllocated, requested) !== 0) {
        throw new Error(
          `P1F-2 invariant violated: allocations for effect ${effectId} sum to ` +
            `${toDecimal6(totalAllocated)}, expected ${toDecimal6(requested)}.`,
        );
      }

      const arr = effectsByLine.get(triple.orderLineId) ?? [];
      arr.push({
        effectId,
        stockItemId,
        locationId,
        allocations,
      });
      effectsByLine.set(triple.orderLineId, arr);
    }

    // 2c — aggregated physical UPDATE, once, only if the group produced any
    // batch-backed physical slices.
    if (physicalDeltaRows.length > 0) {
      await this.runPhysicalAggregateUpdate(tx, physicalDeltaRows);
    }
    // 2d — aggregated accounting UPDATE — whatever the carry-forward flush
    // above did not already write out.
    if (accountingPendingRows.length > 0) {
      await this.runAccountingAggregateUpdate(tx, accountingPendingRows);
    }
    // 2e — ONE atomic `stock_levels` group delta + ONE multi-row
    // `stock_movements` INSERT with a SQL window-computed `balance_after`.
    // Every group has ≥1 effect and every effect zips to ≥1 slice, so
    // `movementRows` is never empty here.
    const groupDeltaStr =
      groupMagnitude.num === 0n ? '0.000000' : '-' + toDecimal6(groupMagnitude);
    await this.writeGroupLevelsAndMovements(
      tx,
      input,
      locationId,
      stockItemId,
      item.baseUnitId,
      groupDeltaStr,
      movementRows,
    );
    // 2f — ONE pointer UPDATE + ONE multi-row `sale_depletion_allocations`
    // INSERT, the pointer resolved to the LAST movement in `ord` order.
    await this.writeGroupAllocationsAndPointer(
      tx,
      input,
      locationId,
      stockItemId,
      item.baseUnitId,
      allocationRows,
    );
  }

  /**
   * A1-3B design gate §8.1 — the ONE aggregated physical `stock_batches`
   * UPDATE per group. The `GROUP BY` inside the SQL is NOT an optimisation
   * — it is the correctness mechanism: `UPDATE ... FROM` with two source
   * rows matching one target row applies only one of them, silently
   * (design gate §8.1, probe P3). A real Prisma tagged-template parameter
   * (never `$queryRawUnsafe`/string-concatenated SQL) — the JSONB payload
   * is the only variable part of the statement text.
   */
  private async runPhysicalAggregateUpdate(
    tx: Prisma.TransactionClient,
    rows: readonly BatchDeltaRow[],
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "inventory"."stock_batches" b
         SET "quantity_remaining" = b."quantity_remaining" - agg.q
        FROM (
          SELECT v.batch_id::uuid AS batch_id, SUM(v.qty::numeric) AS q
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(batch_id text, qty text)
          GROUP BY v.batch_id
        ) agg
       WHERE b."id" = agg.batch_id
    `;
  }

  /**
   * A1-3B design gate §9 — the ONE aggregated accounting `stock_batches`
   * UPDATE per group (or per flush — §9.2's mandatory carry-forward flush
   * rule may call this more than once per group on the shortfall path).
   * Independent counter, independent batch set from the physical axis
   * above (§9.1) — never merged into one statement (design gate §5.5).
   */
  private async runAccountingAggregateUpdate(
    tx: Prisma.TransactionClient,
    rows: readonly BatchDeltaRow[],
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "inventory"."stock_batches" b
         SET "fifo_cost_quantity_consumed" = b."fifo_cost_quantity_consumed" + agg.q
        FROM (
          SELECT v.batch_id::uuid AS batch_id, SUM(v.qty::numeric) AS q
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(batch_id text, qty text)
          GROUP BY v.batch_id
        ) agg
       WHERE b."id" = agg.batch_id
    `;
  }

  /** A1-3B design gate §5.4/§6 — `stock_levels` group delta + movements. */
  private async writeGroupLevelsAndMovements(
    tx: Prisma.TransactionClient,
    input: DepleteForCompletedSaleInput,
    locationId: string,
    stockItemId: string,
    baseUnitId: string,
    groupDeltaStr: string,
    rows: readonly MovementRow[],
  ): Promise<void> {
    await tx.$executeRaw`
      WITH lvl AS (
        INSERT INTO "inventory"."stock_levels"
          ("tenant_id", "stock_item_id", "location_id", "quantity_on_hand")
        VALUES (${input.tenantId}::uuid, ${stockItemId}::uuid, ${locationId}::uuid,
                ${groupDeltaStr}::numeric)
        ON CONFLICT ("stock_item_id", "location_id") DO UPDATE
          SET "quantity_on_hand" =
              "inventory"."stock_levels"."quantity_on_hand" + EXCLUDED."quantity_on_hand"
        RETURNING "quantity_on_hand" - ${groupDeltaStr}::numeric AS start_balance
      ),
      src AS (
        SELECT v.ord,
               v.movement_id::uuid  AS movement_id,
               v.batch_id::uuid     AS batch_id,
               v.qty::numeric       AS qty,
               v.unit_cost::bigint  AS unit_cost,
               v.total_cost::bigint AS total_cost,
               lvl.start_balance
                 + SUM(v.qty::numeric) OVER (ORDER BY v.ord
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance_after
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
             AS v(ord int, movement_id text, batch_id text, qty text,
                  unit_cost text, total_cost text),
             lvl
      )
      INSERT INTO "inventory"."stock_movements"
        ("id", "occurred_at", "tenant_id", "location_id", "stock_item_id", "batch_id",
         "movement_type", "quantity", "unit_id", "unit_cost", "total_cost", "balance_after",
         "reference_type", "reference_id", "performed_by")
      SELECT src.movement_id, ${input.occurredAt}::timestamptz, ${input.tenantId}::uuid,
             ${locationId}::uuid, ${stockItemId}::uuid, src.batch_id,
             'sale_depletion', src.qty, ${baseUnitId}::uuid, src.unit_cost, src.total_cost,
             src.balance_after, 'order', ${input.orderId}::uuid, ${input.actorId}::uuid
      FROM src
    `;
  }

  /** A1-3B design gate §5.6 — pointer UPDATE + multi-row allocation INSERT. */
  private async writeGroupAllocationsAndPointer(
    tx: Prisma.TransactionClient,
    input: DepleteForCompletedSaleInput,
    locationId: string,
    stockItemId: string,
    baseUnitId: string,
    rows: readonly AllocationRow[],
  ): Promise<void> {
    await tx.$executeRaw`
      WITH src AS (
        SELECT v.ord, v.effect_id::uuid AS effect_id, v.seq,
               v.allocation_id::uuid AS allocation_id, v.movement_id::uuid AS movement_id,
               v.physical_batch_id::uuid AS pb, v.cost_basis_batch_id::uuid AS cb,
               v.qty::numeric AS qty, v.unit_cost::bigint AS uc, v.total_cost::bigint AS tc
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
             AS v(ord int, effect_id text, seq int, allocation_id text, movement_id text,
                  physical_batch_id text, cost_basis_batch_id text, qty text,
                  unit_cost text, total_cost text)
      ),
      ptr AS (
        UPDATE "inventory"."stock_levels" l
           SET "last_movement_id"          = (SELECT movement_id FROM src ORDER BY ord DESC LIMIT 1),
               "last_movement_occurred_at" = ${input.occurredAt}::timestamptz
         WHERE l."stock_item_id" = ${stockItemId}::uuid AND l."location_id" = ${locationId}::uuid
        RETURNING l."last_movement_id"
      )
      INSERT INTO "inventory"."sale_depletion_allocations"
        ("id", "tenant_id", "effect_id", "sequence", "stock_item_id", "location_id",
         "physical_batch_id", "cost_basis_batch_id", "quantity_in_base_unit", "unit_id",
         "unit_cost", "total_cost", "movement_id", "movement_occurred_at", "created_at")
      SELECT src.allocation_id, ${input.tenantId}::uuid, src.effect_id, src.seq,
             ${stockItemId}::uuid, ${locationId}::uuid, src.pb, src.cb, src.qty,
             ${baseUnitId}::uuid, src.uc, src.tc, src.movement_id,
             ${input.occurredAt}::timestamptz, ${input.occurredAt}::timestamptz
      FROM src, ptr
    `;
  }

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
   * working set to match the (now group-deferred) `stock_batches` UPDATE for
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
   * locked-layer working set to match the (now group-deferred)
   * `stock_batches` UPDATE for `slices` — the FIFO receipt-order counter,
   * independent of whichever physical batch FEFO selected. Pure/exact;
   * never mutates its input.
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
}
