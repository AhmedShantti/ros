import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import type {
  DispositionMovementResult,
  PostFireVoidDispositionCommand,
  RecordPostFireVoidDispositionInput,
  RecordPostFireVoidDispositionResult,
} from '../contract/post-fire-void-disposition.contract';
import { MovementsService } from '../movements/movements.service';

/**
 * PRIVATE implementation of `POST_FIRE_VOID_DISPOSITION_COMMAND` — see that
 * contract file for the full reasoning. Reuses `MovementsService.post`
 * exactly the way `WasteService.record` does (same `waste` movement type,
 * same reference-type/reason-code shape); this is Inventory's OWN write
 * path, not a duplicate one.
 */
@Injectable()
export class PostFireVoidDispositionService implements PostFireVoidDispositionCommand {
  constructor(
    private readonly movements: MovementsService,
    private readonly audit: AuditService,
  ) {}

  async recordDisposition(
    tx: Prisma.TransactionClient,
    input: RecordPostFireVoidDispositionInput,
  ): Promise<RecordPostFireVoidDispositionResult> {
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

    // A1-4 deadlock matrix: sort by stockItemId ASC, the same global
    // deterministic lock order `WasteService`/`SaleDepletionService` use.
    const ordered = [...input.components].sort((a, b) =>
      a.stockItemId < b.stockItemId
        ? -1
        : a.stockItemId > b.stockItemId
          ? 1
          : 0,
    );

    const movementResults: DispositionMovementResult[] = [];
    let totalValue = 0n;
    for (const component of ordered) {
      const quantityExact = new Prisma.Decimal(
        component.quantityInBaseUnit,
      ).abs();
      if (quantityExact.isZero()) continue;
      const mv = await this.movements.post(tx, input.tenantId, input.actorId, {
        locationId: location.id,
        stockItemId: component.stockItemId,
        movementType: 'waste',
        quantity: quantityExact.negated().toFixed(6),
        referenceType: 'post_fire_void',
        referenceId: input.orderLineId,
        reasonCodeId: input.reasonCodeId,
        notes: `post-fire void disposition: ${input.disposition}`,
      });
      totalValue += BigInt(mv.totalCost);
      movementResults.push({
        stockItemId: component.stockItemId,
        movementId: mv.id,
        unitCost: BigInt(mv.unitCost),
        totalCost: BigInt(mv.totalCost),
      });
    }

    await this.audit.record(tx, {
      tenantId: input.tenantId,
      action: AUDIT_ACTION.WASTE_RECORDED,
      entityType: AUDIT_ENTITY.WASTE_RECORD,
      actorType: 'user',
      actorId: input.actorId,
      entityId: input.orderLineId,
      reasonCode: input.disposition,
      metadata: {
        source: 'post_fire_void',
        orderLineId: input.orderLineId,
        disposition: input.disposition,
        reasonCodeId: input.reasonCodeId,
        movementIds: movementResults.map((m) => m.movementId),
        totalValue: totalValue.toString(),
      },
    });

    return { movements: movementResults, totalValue };
  }
}
