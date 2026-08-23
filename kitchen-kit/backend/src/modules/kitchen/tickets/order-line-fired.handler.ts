import { Injectable } from '@nestjs/common';
import { DomainEventHandler } from '../../../common/domain-events/domain-event-handler.decorator';
import { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import { Prisma } from '../../../generated/prisma/client';
import {
  ORDER_LINE_FIRED_EVENT_TYPE,
  OrderLineFiredEvent,
} from '../../sales/contract';
import { RoutingResolverService } from '../routing/routing-resolver.service';
import { TicketPersistenceService } from './ticket-persistence.service';

/**
 * `YYYY-MM-DD` -> a UTC-midnight `Date` for a `@db.Date` column. Identical
 * parsing rule to `orders.controller.ts`'s private `parseBusinessDay` — not
 * imported from there (that file is Sales-private; Kitchen must not reach
 * into it), reimplemented locally because it is a two-line date parse, not a
 * shared business rule.
 */
function parseBusinessDay(value: string): Date {
  const [y, m, d] = value.split('-').map((p) => Number.parseInt(p, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * PRIVATE production Kitchen handler for `order.line.fired` (SRS §5.5.4).
 * Registered as a provider in `KitchenModule` only — never exported, never
 * imported by anything (`module-boundaries.spec.ts` proves this; see that
 * file's P1E-5 assertions). `DomainEventHandlerRegistry`'s `DiscoveryService`
 * scan finds it purely via the `@DomainEventHandler` metadata key, so Sales
 * never imports this class and never learns Kitchen exists.
 *
 * Runs inside the SAME transaction the Fire command opened
 * (`UnitOfWork.execute` -> `dispatcher.drain(ctx)` -> this handler, all
 * before `withAuthContext`'s `$transaction` commits — P1E-1C). Opens no
 * transaction of its own. Reads Organisation-owned routing configuration
 * ONLY through `RoutingResolverService`, which itself reaches Organisation
 * only through its accepted public contract (P1E-3A) — this file contains no
 * Prisma query against `sales.*` or `catalogue.*` at all.
 *
 * One fired line may resolve to multiple stations (FR-KDS-011); this handler
 * loops over every resolved station and creates/reuses that station's own
 * Ticket, exactly the P1E-4 §D cardinality. A routing failure
 * (`RoutingNoDestinationError` / `RoutingConfigurationConflictError`)
 * propagates unmodified, rolling back the Sales Fire write and every Kitchen
 * write made so far in the same transaction (P1E-5 §27/§34).
 */
@Injectable()
@DomainEventHandler(ORDER_LINE_FIRED_EVENT_TYPE)
export class OrderLineFiredHandler {
  constructor(
    private readonly routingResolver: RoutingResolverService,
    private readonly ticketPersistence: TicketPersistenceService,
  ) {}

  async handle(
    event: OrderLineFiredEvent,
    ctx: UnitOfWorkContext,
  ): Promise<void> {
    const { payload } = event;
    const businessDay = parseBusinessDay(payload.businessDay);
    /** FR-KDS-040 "routed" / FR-KDS-042 "fire time" — the Fire command's own
     *  instant, never `DEFAULT now()`. */
    const firedAt = new Date(payload.firedAt);
    /** FR-KDS-040 "created" — this handler invocation's own instant. */
    const createdAt = new Date();

    const resolution = await this.routingResolver.resolve(ctx.tx, {
      tenantId: event.tenantId,
      branchId: event.branchId,
      menuItemId: payload.menuItemId,
      modifierIds: payload.modifierIds,
      categoryIds: payload.categoryIds,
      lineOverrides: payload.lineStationOverrides.map((override) => ({
        overrideId: override.overrideId,
        stationId: override.stationId,
      })),
    });

    for (const stationId of resolution.stationIds) {
      const ticket = await this.ticketPersistence.getOrCreateTicket(ctx.tx, {
        tenantId: event.tenantId,
        branchId: event.branchId,
        businessDay,
        orderId: payload.orderId,
        stationId,
        orderNumberSnapshot: payload.orderNumber,
        orderTypeSnapshot: payload.orderType,
        serviceReferenceSnapshot: payload.serviceReference,
        createdAt,
        routedAt: firedAt,
      });

      const batch = await this.ticketPersistence.getOrCreateFireBatch(ctx.tx, {
        tenantId: event.tenantId,
        ticketId: ticket.id,
        fireBatchId: payload.fireBatchId,
        firedAt,
      });

      const line = await this.ticketPersistence.getOrCreateTicketLine(ctx.tx, {
        tenantId: event.tenantId,
        ticketId: ticket.id,
        fireBatchRowId: batch.id,
        orderId: payload.orderId,
        orderLineId: payload.orderLineId,
        businessDay,
        itemNameSnapshot: payload.itemNameSnapshot as Prisma.InputJsonValue,
        quantity: payload.quantity,
        course: payload.course,
        sequence: payload.sequence,
        preparationNotes: payload.preparationNotes,
        createdAt,
        routedAt: firedAt,
      });

      for (const modifier of payload.modifiers) {
        await this.ticketPersistence.ensureTicketLineModifier(
          ctx.tx,
          event.tenantId,
          line.id,
          {
            sourceOrderLineModifierId: modifier.orderLineModifierId,
            sourceModifierId: modifier.modifierId,
            nameSnapshot: modifier.nameSnapshot as Prisma.InputJsonValue,
            kind: modifier.kind,
            quantity: modifier.quantity,
          },
        );
      }
    }
  }
}
