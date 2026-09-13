/**
 * FULL-SRS-POS-ORDER-CANCELLATION-P3 — Order cancellation (FR-POS-070,
 * FR-POS-075, BR-POS-003).
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 * Not a new state machine, not a new void mechanism, not a new inventory
 * disposition implementation. `order-state.ts` already carries the
 * `draft/open/held/parked -> cancelled` transitions (BR-POS-003's target
 * state has existed since the state machine was first written); this
 * service is the first REAL caller that reaches them. Every line-level
 * effect reuses an EXISTING domain path:
 *
 *   pre-fire line   -> the SAME "mark voided, no inventory effect" write
 *                      `OrderLinesService.voidLinePreFire` already performs
 *                      (inlined here rather than called, because that
 *                      method opens its OWN transaction/version-CAS/audit —
 *                      see its own docblock on why a caller cannot nest
 *                      one; only the FIELD WRITES are shared).
 *   fired/produced  -> `PostFireVoidService.disposeProducedLine` — the
 *   line              EXACT SAME disposition/inventory/PostFireVoidRecord
 *                      mechanics `POST .../lines/:lineId/void-postfire`
 *                      already uses, extracted so this service can call it
 *                      inside its OWN transaction instead of opening a
 *                      second, nested one.
 *
 * ── ONE AUDIT ENTRY, NOT N ───────────────────────────────────────────────
 * FR-POS-075 requires "audit entries containing the actor, approver,
 * reason, amount, and full before/after state" for the cancellation. This
 * writes exactly ONE `ORDER_CANCELLED` entry, mirroring the established
 * `CASH_MOVEMENT_RECORDED`/`TICKET_BUMPED` "one verb, many instances"
 * convention (see `audit.constants.ts`'s own docblock) rather than echoing
 * a second `ORDER_LINE_VOIDED_POSTFIRE`-shaped entry per disposed line —
 * the full per-line breakdown (state, disposition, reason,
 * inventory-movement/`PostFireVoidRecord` ids) lives inside this ONE
 * entry's own `before`/`metadata` instead. The KDS-facing
 * `order.line.voided_postfire` DOMAIN EVENT is still published once per
 * disposed line (§7 of the mission — Kitchen's existing subscriber is the
 * only thing that keeps Ticket/TicketLine state honest, and it is keyed off
 * that event, not off the audit trail).
 *
 * ── WHY NO `order.cancelled` DOMAIN EVENT ────────────────────────────────
 * No source in this repository — the SRS event catalogue excerpts quoted
 * across the governance register and prior traceability reports — names an
 * `order.cancelled` event or a subscriber for one (unlike `order.opened`/
 * `order.completed`, both explicitly named in §5.5.4). Inventing one here
 * would be "aesthetic symmetry" with no consumer, which the mission
 * explicitly says not to do. If a future slice needs one, adding it is
 * additive; this report records the decision honestly rather than silently
 * omitting it.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import type { PostFireVoidRecord } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { APPROVAL_COMMANDS } from '../../governance/contract';
import type { ApprovalCommands } from '../../governance/contract';
import { CountryPackService } from '../../localisation/country-pack/country-pack.service';
import type { VerifiedApproverPrincipal } from '../../identity/contract';
import { SALES_PERMISSIONS } from '../sales.permissions';
import {
  ORDER_LINE_VOIDED_POSTFIRE_EVENT_TYPE,
  ORDER_LINE_VOIDED_POSTFIRE_EVENT_VERSION,
} from '../contract';
import {
  OrderVersionConflictError,
  assertMayCancelOrder,
  assertTransition,
  assertVersion,
  isBumped,
  isSentToProduction,
} from './order-state';
import { recomputeOrderTotals } from './order-totals';
import { PostFireVoidService } from './post-fire-void.service';
import type {
  PostFireVoidDisposition,
  ProducedLineForDisposition,
} from './post-fire-void.service';
import { obtainSynchronousApproval } from './approval-helper';

const CANCEL_APPROVAL_REQUEST_TYPE = 'order.cancel_after_production';

export interface ManagerApprovalInput {
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly approver: VerifiedApproverPrincipal;
}

export interface CancelOrderLineDispositionInput {
  readonly orderLineId: string;
  readonly disposition: PostFireVoidDisposition;
}

export interface CancelOrderInput {
  readonly expectedVersion: number;
  readonly reasonCodeId: string;
  readonly lineDispositions?: readonly CancelOrderLineDispositionInput[];
  readonly manager?: ManagerApprovalInput;
}

@Injectable()
export class CancelOrderService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly countryPacks: CountryPackService,
    private readonly postFireVoid: PostFireVoidService,
    @Inject(APPROVAL_COMMANDS) private readonly approvals: ApprovalCommands,
  ) {}

  async cancelOrder(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    input: CancelOrderInput,
  ) {
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
            subtotal: true,
            discountTotal: true,
            serviceChargeTotal: true,
            taxTotal: true,
            grandTotal: true,
            paidTotal: true,
          },
        });
        if (!order) throw new NotFoundException('Order not found.');

        const lines = await tx.orderLine.findMany({
          where: { orderId: order.id, businessDay },
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
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

        // ── §12 idempotency — a retry against an already-cancelled order
        // is a safe no-op: no second audit entry, no second event, no
        // double-void. Deliberately BEFORE every other assertion (an
        // already-cancelled order would otherwise fail `assertMayCancelOrder`
        // via `assertOrderMutable`, which is correct for a GENUINE attempt
        // but wrong for a replay). ─────────────────────────────────────────
        if (order.state === 'cancelled') {
          const fullOrder = await tx.order.findUniqueOrThrow({
            where: { id_businessDay: { id: order.id, businessDay } },
            include: { lines: { orderBy: { sequence: 'asc' } } },
          });
          return {
            order: fullOrder,
            postFireVoidRecords: [],
            alreadyCancelled: true,
          };
        }

        assertMayCancelOrder(order.state, order.paidTotal);
        assertTransition(order.state, 'cancelled');
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        const reason = await tx.reasonCode.findUnique({
          where: { id: input.reasonCodeId },
          select: { id: true, category: true },
        });
        if (!reason) {
          throw new UnprocessableEntityException(
            'Cancelling an order requires a reason code that exists in this tenant (FR-POS-075).',
          );
        }
        if (reason.category === 'waste') {
          throw new UnprocessableEntityException(
            'A waste-only reason code cannot be used to cancel an order — ' +
              'cancellation is a correction reason, not a stock-waste reason.',
          );
        }

        // ── Classify every non-terminal line (BR-POS-003 + §3 of the
        // mission). `voided`/`comped` lines are already-settled bookkeeping
        // and are left untouched — a retry/amendment cannot re-void them. ──
        const eligibleLines = lines.filter(
          (l) => l.state !== 'voided' && l.state !== 'comped',
        );
        const preFireLines = eligibleLines.filter(
          (l) => !isSentToProduction(l.state),
        );
        const producedLines = eligibleLines.filter((l) =>
          isSentToProduction(l.state),
        );
        const hasBumpedLine = producedLines.some((l) => isBumped(l.state));

        // ── BR-POS-003 — elevated approval, order-level, only when a
        // BUMPED line is involved (fired-but-not-yet-bumped uses the SAME
        // disposition mechanics below but needs no elevated approval). ────
        let approver: { userId: string; employeeId: string } | null = null;
        if (hasBumpedLine) {
          if (!input.manager) {
            throw new ForbiddenException(
              'This order has a line that has been fired to the kitchen and ' +
                'bumped; cancelling it requires elevated approval from a user ' +
                "holding 'pos.order.cancel_after_production' (BR-POS-003). " +
                'Supply a manager PIN and retry.',
            );
          }
          await obtainSynchronousApproval(this.approvals, {
            tx,
            tenantId,
            requestedByUserId: actorUserId,
            requestType: CANCEL_APPROVAL_REQUEST_TYPE,
            entityType: AUDIT_ENTITY.ORDER,
            entityId: order.id,
            value: {
              orderId: order.id,
              businessDay: businessDay.toISOString().slice(0, 10),
              producedLineIds: producedLines
                .filter((l) => isBumped(l.state))
                .map((l) => l.id),
            },
            requiredPermission: SALES_PERMISSIONS.ORDER_CANCEL_AFTER_PRODUCTION,
            approvalRequestId: input.manager.approvalRequestId,
            approvalDecisionId: input.manager.approvalDecisionId,
            approver: input.manager.approver,
          });
          approver = {
            userId: input.manager.approver.userId,
            employeeId: input.manager.approver.employeeId,
          };
        }

        // ── §5/§9 — every produced/fired line needs a caller-supplied
        // disposition; an order with none of those needs none. ────────────
        const dispositionByLineId = new Map(
          (input.lineDispositions ?? []).map((d) => [
            d.orderLineId,
            d.disposition,
          ]),
        );
        for (const line of producedLines) {
          if (!dispositionByLineId.has(line.id)) {
            throw new UnprocessableEntityException(
              `Order line ${line.id} has already been sent to production; ` +
                'cancelling this order requires a disposition ' +
                '(returned_to_stock/wasted/given_to_staff) for it (FR-POS-071).',
            );
          }
        }
        const producedLineIdSet = new Set(producedLines.map((l) => l.id));
        for (const supplied of input.lineDispositions ?? []) {
          if (!producedLineIdSet.has(supplied.orderLineId)) {
            throw new UnprocessableEntityException(
              `Order line ${supplied.orderLineId} is not an eligible ` +
                'produced/fired line on this order; a disposition may only ' +
                'be supplied for a line already sent to production.',
            );
          }
        }

        // ── A. pre-fire lines — the SAME field-write `voidLinePreFire` uses
        // (no inventory effect, no kitchen side effect — Clarification A). ─
        for (const line of preFireLines) {
          await tx.orderLine.update({
            where: { id_businessDay: { id: line.id, businessDay } },
            data: {
              state: 'voided',
              voidedBy: actorUserId,
              voidReasonId: reason.id,
            },
          });
        }

        // ── B/C. fired-not-bumped and produced/bumped lines — the SAME
        // disposition mechanics `PostFireVoidService` already implements,
        // reused via its extracted `disposeProducedLine`. ──────────────────
        const disposedAt = new Date();
        const postFireVoidRecords: PostFireVoidRecord[] = [];
        for (const line of producedLines) {
          const recordId = newId();
          const disposition = dispositionByLineId.get(line.id)!;
          const disposeInput: ProducedLineForDisposition = line;
          const result = await this.postFireVoid.disposeProducedLine(tx, {
            tenantId,
            actorUserId,
            branchId: order.branchId,
            businessDay,
            recordId,
            line: disposeInput,
            disposition,
            reasonCodeId: reason.id,
          });
          postFireVoidRecords.push(result.record);

          // §7 — KDS consistency: reuse the EXISTING published event/contract
          // Kitchen already subscribes to, unchanged, one per disposed line.
          ctx.publishEvent({
            eventType: ORDER_LINE_VOIDED_POSTFIRE_EVENT_TYPE,
            eventVersion: ORDER_LINE_VOIDED_POSTFIRE_EVENT_VERSION,
            occurredAt: disposedAt,
            branchId: order.branchId,
            actorId: actorUserId,
            actorType: 'user',
            idempotencyKey: `order.line.voided_postfire:${recordId}`,
            payload: {
              orderId: order.id,
              businessDay: businessDay.toISOString().slice(0, 10),
              orderLineId: line.id,
              voidedAt: disposedAt.toISOString(),
            },
          });
        }

        // ── §6 — ONE canonical totals path, never a manual zero. Every
        // eligible line is now voided, so subtotal/tax/grand collapse to
        // whatever the shared function derives from zero active lines. ────
        const totals = await recomputeOrderTotals(
          tx,
          tenantId,
          order.id,
          businessDay,
          order.currency,
          this.countryPacks,
        );
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, businessDay, version: input.expectedVersion },
          data: {
            ...totals,
            state: 'cancelled',
            version: nextVersion,
            updatedAt: new Date(),
          },
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

        // ── §10 — exactly ONE order-level audit entry, actor/approver/
        // reason/amount/full before+after. ──────────────────────────────
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ORDER_CANCELLED,
          entityType: AUDIT_ENTITY.ORDER,
          actorType: 'user',
          actorId: actorUserId,
          entityId: order.id,
          terminalId: order.terminalId,
          ...(approver
            ? {
                approverId: approver.userId,
                approvalId: input.manager!.approvalRequestId,
              }
            : {}),
          reasonCode: reason.id,
          before: {
            state: order.state,
            version: order.version,
            subtotal: order.subtotal.toString(),
            discountTotal: order.discountTotal.toString(),
            serviceChargeTotal: order.serviceChargeTotal.toString(),
            taxTotal: order.taxTotal.toString(),
            grandTotal: order.grandTotal.toString(),
            paidTotal: order.paidTotal.toString(),
            lines: lines.map((l) => ({
              id: l.id,
              state: l.state,
              lineTotal: l.lineTotal.toString(),
            })),
          },
          metadata: {
            orderId: order.id,
            // FR-POS-075 "amount" — the grandTotal snapshot immediately
            // before cancellation (the collectible figure the order is no
            // longer allowed to retain after this write, per §6).
            amountMinor: order.grandTotal.toString(),
            approvalRequired: hasBumpedLine,
            preFireVoidedLineIds: preFireLines.map((l) => l.id),
            producedLineDispositions: producedLines.map((l) => ({
              orderLineId: l.id,
              priorState: l.state,
              disposition: dispositionByLineId.get(l.id),
            })),
            postFireVoidRecordIds: postFireVoidRecords.map((r) => r.id),
            orderVersion: nextVersion,
            after: {
              state: updatedOrder.state,
              version: updatedOrder.version,
              subtotal: updatedOrder.subtotal.toString(),
              discountTotal: updatedOrder.discountTotal.toString(),
              serviceChargeTotal: updatedOrder.serviceChargeTotal.toString(),
              taxTotal: updatedOrder.taxTotal.toString(),
              grandTotal: updatedOrder.grandTotal.toString(),
              paidTotal: updatedOrder.paidTotal.toString(),
            },
          },
        });

        return {
          order: updatedOrder,
          postFireVoidRecords,
          alreadyCancelled: false,
        };
      },
    );
  }
}
