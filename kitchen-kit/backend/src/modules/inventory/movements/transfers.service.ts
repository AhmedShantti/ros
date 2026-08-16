import { BadRequestException, Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { MovementsService } from './movements.service';

export interface TransferInput {
  stockItemId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  reasonCodeId?: string;
  notes?: string;
}

export interface ReceiveTransferInput {
  transferReferenceId: string;
  /** Quantity actually received; may differ from dispatched (FR-INV-032). */
  receivedQuantity: number;
  /** Mandatory when receivedQuantity differs — the discrepancy adjustment
   *  carries it (ck_reason_required). */
  discrepancyReasonCodeId?: string;
}

/**
 * Inter-location transfers (FR-INV-031/032/034).
 *
 * D-INV-06 / BR-INV-002 is preserved EXACTLY: every `transfer_out` has exactly
 * one `transfer_in` of equal absolute quantity, linked by
 * `counterpart_movement_id`. In-transit stock is the interval between them.
 *
 * A receiving discrepancy does NOT unbalance the pair and does NOT get its own
 * table. The pair is written at the dispatched quantity; the difference becomes
 * a SEPARATE `manual_adjustment` movement at the receiving location, carrying a
 * mandatory reason code.
 *
 * FR-INV-034: the transfer values at the sending location's cost, computed via
 * the item's configured costing method (D-INV-03). Any resulting difference at
 * the receiving location is reportable from the ledger but is NOT posted to a
 * variance account — no such entity exists in the SRS and inventing one is
 * forbidden.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly movements: MovementsService,
    private readonly audit: AuditService,
  ) {}

  /** Dispatch: writes the `transfer_out` leg. */
  async dispatch(tenantId: string, actorId: string, input: TransferInput) {
    if (input.quantity <= 0) {
      throw new BadRequestException('Transfer quantity must be positive.');
    }
    if (input.fromLocationId === input.toLocationId) {
      throw new BadRequestException(
        'Source and destination locations must differ.',
      );
    }
    const referenceId = newId();
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const out = await this.movements.post(tx, tenantId, actorId, {
          locationId: input.fromLocationId,
          stockItemId: input.stockItemId,
          movementType: 'transfer_out',
          quantity: -Math.abs(input.quantity),
          referenceType: 'transfer',
          referenceId,
          reasonCodeId: input.reasonCodeId,
          notes: input.notes,
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.STOCK_TRANSFER_DISPATCHED,
          entityType: AUDIT_ENTITY.STOCK_MOVEMENT,
          actorType: 'user',
          actorId,
          entityId: out.id,
          metadata: {
            transferReferenceId: referenceId,
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            quantity: String(input.quantity),
            unitCost: out.unitCost,
          },
        });
        return {
          transferReferenceId: referenceId,
          dispatchMovementId: out.id,
          quantityDispatched: input.quantity,
          unitCost: out.unitCost,
        };
      },
    );
  }

  /**
   * Receive: writes the `transfer_in` leg at the DISPATCHED quantity (keeping
   * BR-INV-002 intact) and, when the received quantity differs, an additional
   * `manual_adjustment` at the receiving location for the difference.
   */
  async receive(
    tenantId: string,
    actorId: string,
    toLocationId: string,
    input: ReceiveTransferInput,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const out = await tx.stockMovement.findFirst({
          where: {
            referenceType: 'transfer',
            referenceId: input.transferReferenceId,
            movementType: 'transfer_out',
          },
        });
        if (!out) {
          throw new BadRequestException('Transfer not found.');
        }
        const already = await tx.stockMovement.findFirst({
          where: {
            referenceType: 'transfer',
            referenceId: input.transferReferenceId,
            movementType: 'transfer_in',
          },
        });
        if (already) {
          throw new BadRequestException('Transfer already received.');
        }

        const dispatched = Math.abs(Number(out.quantity));
        const discrepancy = input.receivedQuantity - dispatched;
        if (discrepancy !== 0 && !input.discrepancyReasonCodeId) {
          throw new BadRequestException(
            'A receiving discrepancy requires a reason code.',
          );
        }

        // BR-INV-002: the paired leg is ALWAYS the dispatched quantity, and the
        // counterpart link is written AT INSERT. The ledger is append-only
        // (ros_app holds no UPDATE privilege), so back-patching the link with an
        // UPDATE is impossible by design — the database refuses it.
        const inMv = await this.movements.post(tx, tenantId, actorId, {
          locationId: toLocationId,
          stockItemId: out.stockItemId,
          movementType: 'transfer_in',
          quantity: dispatched,
          referenceType: 'transfer',
          referenceId: input.transferReferenceId,
          // FR-INV-034: value at the sending location's cost.
          unitCost: out.unitCost,
          counterpartMovementId: out.id,
          counterpartOccurredAt: out.occurredAt,
        });

        let adjustmentMovementId: string | null = null;
        if (discrepancy !== 0) {
          const adj = await this.movements.post(tx, tenantId, actorId, {
            locationId: toLocationId,
            stockItemId: out.stockItemId,
            movementType: 'manual_adjustment',
            quantity: discrepancy,
            referenceType: 'transfer',
            referenceId: input.transferReferenceId,
            reasonCodeId: input.discrepancyReasonCodeId,
            notes: 'Transfer receiving discrepancy (FR-INV-032).',
          });
          adjustmentMovementId = adj.id;
        }

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.STOCK_TRANSFER_RECEIVED,
          entityType: AUDIT_ENTITY.STOCK_MOVEMENT,
          actorType: 'user',
          actorId,
          entityId: inMv.id,
          before: { quantityDispatched: String(dispatched) },
          metadata: {
            transferReferenceId: input.transferReferenceId,
            quantityReceived: String(input.receivedQuantity),
            discrepancy: String(discrepancy),
            adjustmentMovementId,
          },
        });

        return {
          transferReferenceId: input.transferReferenceId,
          receiveMovementId: inMv.id,
          quantityDispatched: dispatched,
          quantityReceived: input.receivedQuantity,
          discrepancy,
          adjustmentMovementId,
        };
      },
    );
  }
}
