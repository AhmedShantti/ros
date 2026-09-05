import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { MovementType, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { RECIPE_COST_RECOMPUTER } from '../../production/costing/recipe-cost.port';
import type { RecipeCostRecomputer } from '../../production/costing/recipe-cost.port';
import {
  BatchLot,
  selectBatches,
  totalCost,
  valuationUnitCost,
  weightedAverageCost,
} from '../costing';
import {
  LockedBatchLayer,
  applyCostConsumption,
  lockLayers,
  planFifoCostConsumption,
  toDecimal6,
} from '../costing/fifo-cost-ledger';
import {
  Rational,
  fromExactDecimal,
  isNegative,
  isZero,
  subtract,
} from '../../../common/money/rational';
import { parseExactDecimal } from '../../../common/money/rounding';

function exact(value: string): Rational {
  return fromExactDecimal(parseExactDecimal(value));
}

/** Render a SIGNED Rational as an exact DECIMAL(18,6) string (`toDecimal6` is magnitude-only). */
function toSignedDecimal6(value: Rational): string {
  return isNegative(value)
    ? `-${toDecimal6({ num: -value.num, den: value.den })}`
    : toDecimal6(value);
}

export interface PostMovementInput {
  locationId: string;
  stockItemId: string;
  movementType: MovementType;
  /**
   * Signed exact decimal string (BR-CORE-003, up to 6 dp), e.g. "-2.125000".
   * Must be non-zero (DB CHECK). Internal write-path type only — the public
   * `PostMovementDto.quantity` was already a validated decimal string; this
   * removes the `Number()` conversion that used to sit between the two.
   */
  quantity: string;
  referenceType: string;
  referenceId: string;
  occurredAt?: Date;
  reasonCodeId?: string;
  notes?: string;
  /** Inbound only: cost per base unit for the receipt/opening balance. */
  unitCost?: bigint;
  /** Inbound only: batch to create/credit when the item is batch-tracked. */
  batchId?: string;
  /**
   * BR-INV-002 transfer pairing. Set at INSERT time, never by a later UPDATE:
   * the ledger is append-only (ros_app has no UPDATE privilege), so linking the
   * counterpart afterwards is impossible by design.
   */
  counterpartMovementId?: string;
  counterpartOccurredAt?: Date;
}

export interface PostedMovement {
  id: string;
  occurredAt: Date;
  balanceAfter: number;
  unitCost: string;
  totalCost: string;
  consumedBatches: { batchId: string; quantity: number }[];
}

/**
 * The append-only stock movement ledger (SRS §7.4.3, BR-INV-001).
 *
 * Every quantity in the system is derivable from this table. `stock_levels` is a
 * PROJECTION maintained in the SAME transaction as the movement, so the fold and
 * the projection can never diverge within a request (BR-INV-003).
 *
 * Immutability is enforced by the DATABASE, not here: ros_app holds only
 * SELECT+INSERT, UPDATE/DELETE are revoked, and no update/delete policy exists.
 * A reversal is a NEW movement with the opposite sign — never an edit.
 *
 * Valuation and batch selection are kept strictly independent (D-INV-03): the
 * item's `batchStrategy` decides WHICH batches are consumed; its
 * `costingMethod` decides what that consumption is VALUED at.
 */
@Injectable()
export class MovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(RECIPE_COST_RECOMPUTER)
    private readonly recipeCost: RecipeCostRecomputer,
  ) {}

  /**
   * Append one movement and update the projection, inside the caller's
   * transaction. Callers MUST already be inside `withAuthContext`.
   */
  async post(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorId: string,
    input: PostMovementInput,
  ): Promise<PostedMovement> {
    const qty = exact(input.quantity);
    if (isZero(qty)) {
      throw new BadRequestException('Movement quantity must be non-zero.');
    }
    const outbound = isNegative(qty);
    const qtyAbs: Rational = outbound ? { num: -qty.num, den: qty.den } : qty;
    // Pre-existing valuation/batch-selection axis (costing.ts) is unchanged —
    // it already computed off a JS `number`; only the persisted quantity
    // projection below moves to exact/atomic arithmetic (CG-01).
    const qtyAbsNumber = Number(toDecimal6(qtyAbs));

    const item = await tx.stockItem.findUnique({
      where: { id: input.stockItemId },
    });
    if (!item) {
      throw new NotFoundException('Stock item not found.');
    }
    // Cross-tenant/unknown locations are invisible under RLS -> 404, not 403.
    const location = await tx.location.findUnique({
      where: { id: input.locationId },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException('Location not found.');
    }

    // ---- batch selection (outbound only) --------------------------------
    // P1F-2: batch access is routed through the SAME private fifo-cost-ledger
    // kernel `SaleDepletionService` uses, so this path and Completion take
    // compatible FOR UPDATE locks in the SAME deterministic order and can
    // never double-consume or skip a layer on either axis. This is COUNTER
    // MAINTENANCE AND LOCKING ONLY — `valuationUnitCost` below is UNCHANGED,
    // and how transfers/waste/counts are VALUED is UNCHANGED. Batch locks
    // are taken BEFORE the stock_levels lock below, same relative order as
    // pre-A1-4 (A1-4 §11: this ordering is preserved unchanged).
    let consumed: { batchId: string; quantity: number; unitCost: bigint }[] =
      [];
    let lockedLayers: LockedBatchLayer[] = [];
    if (outbound && item.isBatchTracked) {
      lockedLayers = await lockLayers(
        tx,
        tenantId,
        input.stockItemId,
        input.locationId,
      );
      const lots: BatchLot[] = lockedLayers
        .filter((b) => Number(b.quantityRemaining) > 0)
        .map((b) => ({
          batchId: b.id,
          quantityRemaining: Number(b.quantityRemaining),
          unitCost: b.unitCost,
          receivedAt: b.createdAt,
          expiryDate: b.expiryDate,
        }));
      // FR-INV-014: a shortfall is recorded, never blocked.
      consumed = selectBatches(lots, qtyAbsNumber, item.batchStrategy).consumed;
    }

    const occurredAt = input.occurredAt ?? new Date();

    // ---- projection (BR-INV-003, ATOMIC, same transaction) ---------------
    // The additive delta is applied by PostgreSQL itself — never read-then-
    // absolute-write — so two concurrent movements on the same (item,
    // location) can never lose an update (CG-01), and `balanceAfter` below
    // is the database's own returned value, not a JS-computed guess. Mirrors
    // the already-accepted `SaleDepletionService.writeAllocation` pattern.
    //
    // A1-4 (FR-INV-012/BR-INV-003): this is ALSO now the ONE lock-acquisition
    // point this service uses for `average_cost`. `average_cost` is read
    // back in the SAME statement that applies this movement's own quantity
    // delta and holds the row lock — never an earlier, unprotected pre-read
    // — so the value used to compute a NEW average (inbound) or re-affirmed
    // on write-back (outbound, which never changes it) is always the
    // truthful state as of THIS movement's own lock acquisition. A
    // concurrent writer on the same row genuinely BLOCKS on this statement
    // (a real PostgreSQL row lock) until it commits — never "both read
    // stale, one wins" — including the very first receipt ever posted:
    // the INSERT branch IS the row's creation-and-lock point, so two
    // concurrent first receipts cannot both believe they created the row
    // (§10). Previously `average_cost` was read via an EARLIER, unlocked
    // `stockLevel.findUnique` and later overwritten by an absolute UPDATE —
    // a lost-update race between two concurrent receipts (and, more subtly,
    // between a receipt and any concurrent outbound movement on the same
    // row, whose write-back could silently erase the receipt's committed
    // average). Batch locking (if any) already happened above, so this
    // change does not alter this path's lock order.
    const deltaText = toSignedDecimal6(qty);
    const projected = await tx.$queryRaw<
      { quantityOnHand: string; averageCost: bigint }[]
    >`
      INSERT INTO "inventory"."stock_levels"
        ("tenant_id", "stock_item_id", "location_id", "quantity_on_hand")
      VALUES (${tenantId}::uuid, ${input.stockItemId}::uuid, ${input.locationId}::uuid,
              ${deltaText}::numeric)
      ON CONFLICT ("stock_item_id", "location_id") DO UPDATE
        SET "quantity_on_hand" = "inventory"."stock_levels"."quantity_on_hand" + EXCLUDED."quantity_on_hand"
      RETURNING "quantity_on_hand"::text AS "quantityOnHand", "average_cost" AS "averageCost"
    `;
    const balanceAfter = projected[0].quantityOnHand;
    // Pre-THIS-movement (quantity, average), derived from the LOCKED
    // post-upsert row state. `currentAvg` is exact (bigint, straight off
    // the row); `currentQty` subtracts this movement's own exact delta from
    // the returned new total using the same Rational arithmetic as the rest
    // of this file, converting to `Number` only at this existing JS-facing
    // boundary (mirrors `qtyAbsNumber` above) — not a new float path, and
    // `weightedAverageCost`'s own arithmetic/rounding contract is untouched.
    const currentAvg = projected[0].averageCost;
    const currentQty = Number(
      toSignedDecimal6(subtract(exact(balanceAfter), qty)),
    );

    // ---- valuation -------------------------------------------------------
    const unitCost = outbound
      ? valuationUnitCost({
          costingMethod: item.costingMethod,
          quantity: qtyAbsNumber,
          averageCost: currentAvg,
          standardCost: item.standardCost,
          consumed,
        })
      : (input.unitCost ?? currentAvg);

    const movement = await tx.stockMovement.create({
      data: {
        id: newId(),
        occurredAt,
        tenantId,
        locationId: input.locationId,
        stockItemId: input.stockItemId,
        batchId:
          input.batchId ?? (consumed.length === 1 ? consumed[0].batchId : null),
        movementType: input.movementType,
        quantity: new Prisma.Decimal(input.quantity),
        unitId: item.baseUnitId,
        unitCost,
        totalCost: totalCost(qtyAbsNumber, unitCost),
        balanceAfter: new Prisma.Decimal(balanceAfter),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        counterpartMovementId: input.counterpartMovementId ?? null,
        counterpartOccurredAt: input.counterpartOccurredAt ?? null,
        performedBy: actorId,
        reasonCodeId: input.reasonCodeId ?? null,
        notes: input.notes ?? null,
      },
    });

    // ---- valuation pointer (average cost + last-movement, same tx) -------
    // `quantity_on_hand` is NOT written here — it was already applied
    // atomically above. `averageCost` is sourced from the SAME locked read
    // as the projection above (A1-4): inbound recomputes the weighted
    // average from it (FR-INV-012), outbound re-affirms it unchanged — both
    // write back the truthful state, never a value staled by a concurrent
    // writer that ran between an earlier pre-read and this write.
    const nextAvg = outbound
      ? currentAvg
      : weightedAverageCost(
          currentQty,
          currentAvg,
          Number(input.quantity),
          unitCost,
        );
    await tx.stockLevel.update({
      where: {
        stockItemId_locationId: {
          stockItemId: input.stockItemId,
          locationId: input.locationId,
        },
      },
      data: {
        averageCost: nextAvg,
        lastMovementId: movement.id,
        lastMovementOccurredAt: movement.occurredAt,
      },
    });

    // ---- batch depletion (physical axis) -----------------------------------
    for (const c of consumed) {
      await tx.stockBatch.update({
        where: { id: c.batchId },
        data: { quantityRemaining: { decrement: c.quantity } },
      });
    }

    // ---- P1F-2 FIFO accounting counter maintenance (independent axis) -----
    // For costing_method=fifo batch-tracked items, an outbound consumption
    // here ALSO advances `fifo_cost_quantity_consumed` in RECEIPT order by
    // the SAME total quantity, under the locks already taken above. This is
    // locking/counter-maintenance ONLY — it does not change `unitCost`
    // (computed above, unchanged) or how this movement is valued. No
    // carry-forward is applied here: an uncovered remainder simply leaves
    // the counter short, which is harmless for this path (its own valuation
    // never reads the counter) and is a documented residual — only Sale
    // Completion requires full valued coverage and fails closed on it.
    if (outbound && item.isBatchTracked && item.costingMethod === 'fifo') {
      const plan = planFifoCostConsumption(lockedLayers, qtyAbs);
      await applyCostConsumption(tx, plan.slices);
    }

    await this.audit.record(tx, {
      tenantId,
      action: AUDIT_ACTION.STOCK_MOVEMENT_RECORDED,
      entityType: AUDIT_ENTITY.STOCK_MOVEMENT,
      actorType: 'user',
      actorId,
      entityId: movement.id,
      metadata: {
        movementType: input.movementType,
        stockItemId: input.stockItemId,
        locationId: input.locationId,
        quantity: input.quantity,
        unitCost: unitCost.toString(),
        balanceAfter,
      },
      ...(input.reasonCodeId ? { reasonCode: 'inventory_reason_code' } : {}),
    });

    // FR-MNU-046 — "recipe cost SHALL recompute when component costs change,
    // cascading through dependent sub-recipes and parent recipes". THIS is the
    // valuation mutation boundary: `average_cost` was just rewritten above and
    // FIFO layers were just depleted, so every recipe using this item now holds
    // a stale cost. Recomputation runs on the SAME transaction, so a movement
    // and the costs it invalidates commit or roll back together — there is no
    // window in which the ledger and the recipe costs disagree.
    //
    // D-17-05 NARROW AMENDMENT (design gate 4.1) authorises exactly this.
    await this.recipeCost.recomputeForStockItem(tx, input.stockItemId);

    return {
      id: movement.id,
      occurredAt: movement.occurredAt,
      // Transport-only conversion (PostMovementDto/postedMovementSchema
      // already document `balanceAfter` as a JS `number`, unchanged here —
      // see `docs/reports/claude/full-srs-4day/...A1-1...md` §API impact).
      // The PERSISTED value above is the exact atomic DB result.
      balanceAfter: Number(balanceAfter),
      unitCost: unitCost.toString(),
      totalCost: movement.totalCost.toString(),
      consumedBatches: consumed.map((c) => ({
        batchId: c.batchId,
        quantity: c.quantity,
      })),
    };
  }

  /** FR-INV-035 / opening balances / adjustments — standalone entry point. */
  async postStandalone(
    tenantId: string,
    actorId: string,
    input: PostMovementInput,
  ): Promise<PostedMovement> {
    return this.prisma.withAuthContext({ userId: actorId, tenantId }, (tx) =>
      this.post(tx, tenantId, actorId, input),
    );
  }

  listForItem(tenantId: string, stockItemId: string, locationId?: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.stockMovement.findMany({
          where: { stockItemId, ...(locationId ? { locationId } : {}) },
          orderBy: { occurredAt: 'desc' },
          take: 200,
        }),
      )
      .then((rows) =>
        rows.map((m) => ({
          id: m.id,
          occurredAt: m.occurredAt,
          locationId: m.locationId,
          movementType: m.movementType,
          quantity: m.quantity.toString(),
          balanceAfter: m.balanceAfter.toString(),
          batchId: m.batchId,
          referenceType: m.referenceType,
          referenceId: m.referenceId,
          counterpartMovementId: m.counterpartMovementId,
        })),
      );
  }
}
