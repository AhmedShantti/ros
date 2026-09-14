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
import { Prisma } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { CountryPackService } from '../../localisation/country-pack/country-pack.service';
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

/**
 * The subset of an `OrderLine` (plus its P1F-2 consumption-basis pins)
 * `disposeProducedLine` needs — exactly the `select` shape `voidPostFire`
 * already loaded before this method was extracted from it.
 */
export interface ProducedLineForDisposition {
  readonly id: string;
  readonly lineTotal: bigint;
  readonly recipeVersionId: string | null;
  readonly quantity: Prisma.Decimal;
  readonly recipeVersionPins: readonly { recipeVersionId: string }[];
  readonly modifierEffectPins: readonly Prisma.OrderLineModifierEffectGetPayload<
    Record<string, never>
  >[];
  readonly componentConversions: readonly Prisma.OrderLineComponentConversionGetPayload<
    Record<string, never>
  >[];
  readonly modifiers: readonly { id: string; quantity: number }[];
}

export interface DisposeProducedLineInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly branchId: string;
  readonly businessDay: Date;
  /** FR-OFF-015-style permanent id for the `PostFireVoidRecord` row. */
  readonly recordId: string;
  readonly line: ProducedLineForDisposition;
  readonly disposition: PostFireVoidDisposition;
  /** Already validated to exist in this tenant by the caller. */
  readonly reasonCodeId: string;
}

@Injectable()
export class PostFireVoidService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly countryPacks: CountryPackService,
    @Inject(PRODUCTION_CONSUMPTION_QUERY)
    private readonly consumption: ProductionConsumptionQuery,
    @Inject(POST_FIRE_VOID_DISPOSITION_COMMAND)
    private readonly disposition: PostFireVoidDispositionCommand,
  ) {}

  /**
   * The shared post-fire-void domain path (FR-POS-070/071) — "classify the
   * disposition of the produced item, and let the classification create the
   * corresponding inventory record", independent of WHO is calling it or
   * WHY. Runs inside the CALLER's already-open transaction (never opens its
   * own — `PrismaService.withAuthContext`/`UnitOfWork.execute` do not nest),
   * so it does NOT touch the order row, recompute totals, write the
   * order-level audit entry, or publish the Kitchen event: those differ by
   * caller (a single `voidPostFire` call vs. `CancelOrderService` disposing
   * several lines under ONE order-level outcome) and stay the caller's own
   * responsibility.
   *
   * Extracted verbatim from this class's own `voidPostFire` (FULL-SRS-POS-
   * ORDER-CANCELLATION-P3) so order cancellation reuses the EXACT existing
   * disposition mechanics — never a second implementation — per the
   * mission's own "Do not duplicate inventory/waste implementation; invoke/
   * reuse the existing post-fire void domain path" instruction.
   */
  async disposeProducedLine(
    tx: Prisma.TransactionClient,
    input: DisposeProducedLineInput,
  ) {
    const { line } = input;
    const financialAmountRemoved = line.lineTotal;

    // ── Resolve the components considered — for ALL THREE dispositions,
    // `returned_to_stock` included (acceptance correction, 2026-09-04): the
    // Inventory command below writes an Inventory-owned disposition record
    // unconditionally, and that record's own `components` field is what
    // makes "returned_to_stock" genuinely evidenced rather than merely
    // inferred from an absent movement. ────────────────────────────────────
    const modifierQuantityById = new Map(
      line.modifiers.map((m) => [m.id, m.quantity]),
    );
    const planLine: PlanConsumptionLineInput = {
      orderLineId: line.id,
      recipeVersionId: line.recipeVersionId,
      pinnedVersionIds: line.recipeVersionPins.map((p) => p.recipeVersionId),
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

    const dispositionResult = await this.disposition.recordDisposition(tx, {
      tenantId: input.tenantId,
      actorId: input.actorUserId,
      branchId: input.branchId,
      orderLineId: line.id,
      disposition: input.disposition,
      reasonCodeId: input.reasonCodeId,
      components: components.map((c) => ({
        stockItemId: c.stockItemId,
        quantityInBaseUnit: c.quantityInBaseUnit,
      })),
    });
    const inventoryMovementIds = dispositionResult.movements.map(
      (m) => m.movementId,
    );
    const inventoryDispositionRecordId = dispositionResult.dispositionRecordId;

    const voidedLine = await tx.orderLine.update({
      where: {
        id_businessDay: { id: line.id, businessDay: input.businessDay },
      },
      data: {
        state: 'voided',
        voidedBy: input.actorUserId,
        voidReasonId: input.reasonCodeId,
      },
    });

    const record = await tx.postFireVoidRecord.create({
      data: {
        id: input.recordId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        orderId: voidedLine.orderId,
        businessDay: input.businessDay,
        orderLineId: line.id,
        disposition: input.disposition,
        reasonCodeId: input.reasonCodeId,
        financialAmountRemoved,
        inventoryMovementIds,
        actorUserId: input.actorUserId,
      },
    });

    return {
      voidedLine,
      record,
      financialAmountRemoved,
      inventoryMovementIds,
      inventoryDispositionRecordId,
    };
  }

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

        const {
          voidedLine: voided,
          record,
          financialAmountRemoved,
          inventoryMovementIds,
          inventoryDispositionRecordId,
        } = await this.disposeProducedLine(tx, {
          tenantId,
          actorUserId,
          branchId: order.branchId,
          businessDay,
          recordId,
          line,
          disposition: input.disposition,
          reasonCodeId: reason.id,
        });

        const totals = await recomputeOrderTotals(
          tx,
          tenantId,
          order.id,
          businessDay,
          order.currency,
          this.countryPacks,
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
          include: { lines: { orderBy: { sequence: 'asc' } } },
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
            inventoryDispositionRecordId,
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
