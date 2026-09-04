/**
 * POS-FIN-1 — Post-fire void (FR-POS-070/071).
 *
 * Preserves the pre-fire void path (`OrderLinesService.voidLinePreFire`)
 * exactly as it was — nothing in this file is reachable from it, and this
 * service refuses (via `assertMayVoidPostFire`) any line that has NOT
 * already been sent to production, so the two paths cannot overlap.
 *
 * ── WHY DISPOSITION IS MANDATORY ────────────────────────────────────────
 * FR-POS-071: the classification IS the void — there is no "void, then
 * classify later" two-step, because "forcing disposition classification at
 * the moment of the void is the only reliable way to capture it".
 *
 * ── "returned_to_stock" IS A NO-OP ON INVENTORY, DELIBERATELY ───────────
 * This system depletes stock at Order COMPLETION (`SalesPaymentService.
 * completeSettling`), never at Fire. A post-fire-voided line is EXCLUDED
 * from that future depletion (`recomputeOrderTotals`'s own line filter,
 * identical to a pre-fire void). So at the moment of THIS void, the line's
 * stock has never been removed from the sale-depletion ledger — there is
 * nothing to "return". "wasted"/"given_to_staff" are different: the kitchen
 * PHYSICALLY consumed real ingredients producing this item regardless of
 * the sale accounting, so those two call
 * `POST_FIRE_VOID_DISPOSITION_COMMAND` to record that consumption now,
 * because it will never be captured any other way.
 */
import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { PRODUCTION_CONSUMPTION_QUERY } from '../../production/contract';
import type {
  PlanConsumptionLineInput,
  ProductionConsumptionQuery,
} from '../../production/contract';
import { POST_FIRE_VOID_DISPOSITION_COMMAND } from '../../inventory/contract/post-fire-void-disposition.contract';
import type {
  PostFireVoidDispositionCommand,
  PostFireVoidDispositionValue,
} from '../../inventory/contract/post-fire-void-disposition.contract';
import {
  ORDER_LINE_VOIDED_POSTFIRE_EVENT_TYPE,
  ORDER_LINE_VOIDED_POSTFIRE_EVENT_VERSION,
} from '../contract';
import {
  OrderVersionConflictError,
  assertMayVoidPostFire,
  assertVersion,
} from './order-state';
import { recomputeOrderTotals } from './order-totals';

export type PostFireVoidDisposition =
  'returned_to_stock' | PostFireVoidDispositionValue;

export interface VoidPostFireInput {
  readonly id?: string;
  readonly expectedVersion: number;
  readonly reasonCodeId: string;
  readonly disposition: PostFireVoidDisposition;
}

@Injectable()
export class PostFireVoidService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(PRODUCTION_CONSUMPTION_QUERY)
    private readonly consumption: ProductionConsumptionQuery,
    @Inject(POST_FIRE_VOID_DISPOSITION_COMMAND)
    private readonly disposition: PostFireVoidDispositionCommand,
  ) {}

  async voidPostFire(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    lineId: string,
    input: VoidPostFireInput,
  ) {
    const recordId = input.id ?? newId();

    return this.unitOfWork.execute(
      { userId: actorUserId, tenantId },
      async (ctx) => {
        const tx = ctx.tx;

        const order = await tx.order.findUnique({
          where: { id_businessDay: { id: orderId, businessDay } },
          select: {
            id: true,
            businessDay: true,
            branchId: true,
            terminalId: true,
            state: true,
            version: true,
            currency: true,
          },
        });
        if (!order) throw new NotFoundException('Order not found.');

        const line = await tx.orderLine.findUnique({
          where: { id_businessDay: { id: lineId, businessDay } },
          select: {
            id: true,
            orderId: true,
            state: true,
            lineTotal: true,
            recipeVersionId: true,
            quantity: true,
            recipeVersionPins: { select: { recipeVersionId: true } },
            modifierEffectPins: true,
            componentConversions: true,
            modifiers: { select: { id: true, quantity: true } },
          },
        });
        if (!line || line.orderId !== order.id) {
          throw new NotFoundException('Order line not found.');
        }

        assertMayVoidPostFire(order.state, line.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        const reason = await tx.reasonCode.findUnique({
          where: { id: input.reasonCodeId },
          select: { id: true },
        });
        if (!reason) {
          throw new UnprocessableEntityException(
            'A post-fire void requires a reason code that exists in this tenant (FR-POS-075).',
          );
        }

        const financialAmountRemoved = line.lineTotal;

        let inventoryMovementIds: string[] = [];
        if (input.disposition !== 'returned_to_stock') {
          const modifierQuantityById = new Map(
            line.modifiers.map((m) => [m.id, m.quantity]),
          );
          const planLine: PlanConsumptionLineInput = {
            orderLineId: line.id,
            recipeVersionId: line.recipeVersionId,
            pinnedVersionIds: line.recipeVersionPins.map(
              (p) => p.recipeVersionId,
            ),
            quantity: line.quantity.toFixed(3),
            modifierEffects: line.modifierEffectPins.map((e) => ({
              operation: e.operation,
              componentType: e.componentType,
              stockItemId: e.stockItemId,
              subRecipeVersionId: e.subRecipeVersionId,
              quantity: e.quantity ? e.quantity.toFixed(6) : null,
              unitId: e.unitId,
              modifierSelectionQuantity:
                modifierQuantityById.get(e.orderLineModifierId) ?? 1,
            })),
            conversions: line.componentConversions.map((c) => ({
              stockItemId: c.stockItemId,
              fromUnitId: c.fromUnitId,
              baseUnitId: c.baseUnitId,
              factor: c.factor.toFixed(10),
            })),
          };
          const planResult = await this.consumption.planConsumption(tx, {
            lines: [planLine],
          });
          const components = planResult.perLine[0]?.components ?? [];

          if (components.length > 0) {
            const result = await this.disposition.recordDisposition(tx, {
              tenantId,
              actorId: actorUserId,
              branchId: order.branchId,
              orderLineId: line.id,
              disposition: input.disposition,
              reasonCodeId: reason.id,
              components: components.map((c) => ({
                stockItemId: c.stockItemId,
                quantityInBaseUnit: c.quantityInBaseUnit,
              })),
            });
            inventoryMovementIds = result.movements.map((m) => m.movementId);
          }
        }

        const voided = await tx.orderLine.update({
          where: { id_businessDay: { id: lineId, businessDay } },
          data: {
            state: 'voided',
            voidedBy: actorUserId,
            voidReasonId: reason.id,
          },
        });

        const totals = await recomputeOrderTotals(
          tx,
          tenantId,
          order.id,
          businessDay,
          order.currency,
        );
        // CAS on `version` — see `discounts.service.ts`'s identical
        // reasoning; a plain PK update would let two concurrent order
        // mutations silently apply against a stale total.
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, businessDay, version: input.expectedVersion },
          data: { ...totals, version: nextVersion, updatedAt: new Date() },
        });
        if (updateResult.count === 0) {
          throw new OrderVersionConflictError(
            `Version mismatch: the order changed concurrently and is no ` +
              `longer at version ${input.expectedVersion}. Reload the order and retry.`,
          );
        }
        const updatedOrder = await tx.order.findUniqueOrThrow({
          where: { id_businessDay: { id: order.id, businessDay } },
        });

        const record = await tx.postFireVoidRecord.create({
          data: {
            id: recordId,
            tenantId,
            branchId: order.branchId,
            orderId: order.id,
            businessDay,
            orderLineId: line.id,
            disposition: input.disposition,
            reasonCodeId: reason.id,
            financialAmountRemoved,
            inventoryMovementIds,
            actorUserId,
          },
        });

        const voidedAt = new Date();
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ORDER_LINE_VOIDED_POSTFIRE,
          entityType: AUDIT_ENTITY.ORDER_LINE,
          actorType: 'user',
          actorId: actorUserId,
          entityId: lineId,
          terminalId: order.terminalId,
          reasonCode: reason.id,
          before: { state: line.state, lineTotal: line.lineTotal.toString() },
          metadata: {
            orderId: order.id,
            postFireVoidRecordId: recordId,
            disposition: input.disposition,
            financialAmountRemoved: financialAmountRemoved.toString(),
            inventoryMovementIds,
            orderVersion: nextVersion,
          },
        });

        ctx.publishEvent({
          eventType: ORDER_LINE_VOIDED_POSTFIRE_EVENT_TYPE,
          eventVersion: ORDER_LINE_VOIDED_POSTFIRE_EVENT_VERSION,
          occurredAt: voidedAt,
          branchId: order.branchId,
          actorId: actorUserId,
          actorType: 'user',
          idempotencyKey: `order.line.voided_postfire:${recordId}`,
          payload: {
            orderId: order.id,
            businessDay: businessDay.toISOString().slice(0, 10),
            orderLineId: line.id,
            voidedAt: voidedAt.toISOString(),
          },
        });

        return { line: voided, order: updatedOrder, record };
      },
    );
  }
}
