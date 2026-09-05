import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
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
 * exactly the way `WasteService.record` does for `wasted`/`given_to_staff`
 * (same `waste` movement type, same reference-type/reason-code shape); this
 * is Inventory's OWN write path, not a duplicate one.
 *
 * POS-FIN-1 acceptance correction (2026-09-04): now called for ALL THREE
 * dispositions, and ALWAYS writes an `inventory.post_fire_void_disposition_
 * records` row (append-only) — `returned_to_stock` posts no movement (there
 * is nothing to reverse; see the contract's own doc comment) but still gets
 * a record, satisfying FR-POS-071's literal "SHALL create the corresponding
 * inventory record" for every classification, not only two of three.
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
    // `returned_to_stock` posts NO movement — no fake positive/negative
    // entry is fabricated just to manufacture a ledger row (the acceptance
    // correction's own explicit instruction). Nothing was ever physically
    // removed from the sale-depletion ledger for a post-fire-voided line
    // (this system depletes at Order Completion, not at Fire), so there is
    // genuinely nothing to reverse.
    if (input.disposition !== 'returned_to_stock') {
      for (const component of ordered) {
        const quantityExact = new Prisma.Decimal(
          component.quantityInBaseUnit,
        ).abs();
        if (quantityExact.isZero()) continue;
        const mv = await this.movements.post(
          tx,
          input.tenantId,
          input.actorId,
          {
            locationId: location.id,
            stockItemId: component.stockItemId,
            movementType: 'waste',
            quantity: quantityExact.negated().toFixed(6),
            referenceType: 'post_fire_void',
            referenceId: input.orderLineId,
            reasonCodeId: input.reasonCodeId,
            notes: `post-fire void disposition: ${input.disposition}`,
          },
        );
        totalValue += BigInt(mv.totalCost);
        movementResults.push({
          stockItemId: component.stockItemId,
          movementId: mv.id,
          unitCost: BigInt(mv.unitCost),
          totalCost: BigInt(mv.totalCost),
        });
      }
    }

    // ── The Inventory-OWNED disposition record — ALWAYS written, all three
    // classifications alike (FR-POS-071's own acceptance correction). ──────
    const dispositionRecordId = newId();
    await tx.postFireVoidDispositionRecord.create({
      data: {
        id: dispositionRecordId,
        tenantId: input.tenantId,
        locationId: location.id,
        orderLineId: input.orderLineId,
        disposition: input.disposition,
        reasonCodeId: input.reasonCodeId,
        components: ordered.map((c) => ({
          stockItemId: c.stockItemId,
          quantityInBaseUnit: c.quantityInBaseUnit,
        })),
        movementIds: movementResults.map((m) => m.movementId),
        totalValue,
        actorId: input.actorId,
      },
    });

    await this.audit.record(tx, {
      tenantId: input.tenantId,
      action: AUDIT_ACTION.POST_FIRE_VOID_DISPOSITION_RECORDED,
      entityType: AUDIT_ENTITY.POST_FIRE_VOID_DISPOSITION_RECORD,
      actorType: 'user',
      actorId: input.actorId,
      entityId: dispositionRecordId,
      reasonCode: input.disposition,
      metadata: {
        source: 'post_fire_void',
        orderLineId: input.orderLineId,
        disposition: input.disposition,
        reasonCodeId: input.reasonCodeId,
        componentCount: ordered.length,
        movementIds: movementResults.map((m) => m.movementId),
        totalValue: totalValue.toString(),
      },
    });

    return { dispositionRecordId, movements: movementResults, totalValue };
  }
}
