import {
  BadRequestException,
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
import {
  BatchLot,
  selectBatches,
  totalCost,
  valuationUnitCost,
  weightedAverageCost,
} from '../costing';

export interface PostMovementInput {
  locationId: string;
  stockItemId: string;
  movementType: MovementType;
  /** Signed: negative = out of stock. Must be non-zero (DB CHECK). */
  quantity: number;
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
    if (input.quantity === 0) {
      throw new BadRequestException('Movement quantity must be non-zero.');
    }

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

    const level = await tx.stockLevel.findUnique({
      where: {
        stockItemId_locationId: {
          stockItemId: input.stockItemId,
          locationId: input.locationId,
        },
      },
    });
    const currentQty = level ? Number(level.quantityOnHand) : 0;
    const currentAvg = level ? level.averageCost : 0n;
    const outbound = input.quantity < 0;

    // ---- batch selection (outbound only) --------------------------------
    let consumed: { batchId: string; quantity: number; unitCost: bigint }[] =
      [];
    if (outbound && item.isBatchTracked) {
      const batches = await tx.stockBatch.findMany({
        where: {
          stockItemId: input.stockItemId,
          locationId: input.locationId,
          quantityRemaining: { gt: 0 },
        },
      });
      const lots: BatchLot[] = batches.map((b) => ({
        batchId: b.id,
        quantityRemaining: Number(b.quantityRemaining),
        unitCost: b.unitCost,
        receivedAt: b.createdAt,
        expiryDate: b.expiryDate,
      }));
      // FR-INV-014: a shortfall is recorded, never blocked.
      consumed = selectBatches(
        lots,
        Math.abs(input.quantity),
        item.batchStrategy,
      ).consumed;
    }

    // ---- valuation -------------------------------------------------------
    const unitCost = outbound
      ? valuationUnitCost({
          costingMethod: item.costingMethod,
          quantity: Math.abs(input.quantity),
          averageCost: currentAvg,
          standardCost: item.standardCost,
          consumed,
        })
      : (input.unitCost ?? currentAvg);

    const occurredAt = input.occurredAt ?? new Date();
    const balanceAfter = currentQty + input.quantity;

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
        quantity: input.quantity,
        unitId: item.baseUnitId,
        unitCost,
        totalCost: totalCost(input.quantity, unitCost),
        balanceAfter,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        counterpartMovementId: input.counterpartMovementId ?? null,
        counterpartOccurredAt: input.counterpartOccurredAt ?? null,
        performedBy: actorId,
        reasonCodeId: input.reasonCodeId ?? null,
        notes: input.notes ?? null,
      },
    });

    // ---- projection (BR-INV-003, same transaction) -----------------------
    const nextAvg = outbound
      ? currentAvg
      : weightedAverageCost(currentQty, currentAvg, input.quantity, unitCost);
    await tx.stockLevel.upsert({
      where: {
        stockItemId_locationId: {
          stockItemId: input.stockItemId,
          locationId: input.locationId,
        },
      },
      create: {
        tenantId,
        stockItemId: input.stockItemId,
        locationId: input.locationId,
        quantityOnHand: balanceAfter,
        averageCost: nextAvg,
        lastMovementId: movement.id,
        lastMovementOccurredAt: movement.occurredAt,
      },
      update: {
        quantityOnHand: balanceAfter,
        averageCost: nextAvg,
        lastMovementId: movement.id,
        lastMovementOccurredAt: movement.occurredAt,
      },
    });

    // ---- batch depletion --------------------------------------------------
    for (const c of consumed) {
      await tx.stockBatch.update({
        where: { id: c.batchId },
        data: { quantityRemaining: { decrement: c.quantity } },
      });
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
        quantity: String(input.quantity),
        unitCost: unitCost.toString(),
        balanceAfter: String(balanceAfter),
      },
      ...(input.reasonCodeId ? { reasonCode: 'inventory_reason_code' } : {}),
    });

    return {
      id: movement.id,
      occurredAt: movement.occurredAt,
      balanceAfter,
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
