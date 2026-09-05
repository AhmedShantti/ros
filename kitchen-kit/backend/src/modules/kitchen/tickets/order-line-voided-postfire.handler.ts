import { Injectable } from '@nestjs/common';
import { DomainEventHandler } from '../../../common/domain-events/domain-event-handler.decorator';
import { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import {
  ORDER_LINE_VOIDED_POSTFIRE_EVENT_TYPE,
  OrderLineVoidedPostFireEvent,
} from '../../sales/contract';
import { TicketPersistenceService } from './ticket-persistence.service';
import { TicketProjectionService } from './ticket-projection.service';

/**
 * PRIVATE production Kitchen handler for `order.line.voided_postfire`
 * (POS-FIN-1, FR-POS-070/071) — see that event's own docblock in
 * `sales/contract/events.ts` for why it is a documented catalogue
 * EXTENSION, not a literal SRS §5.5.4 entry. Registered as a provider in
 * `KitchenModule` only — never exported, never imported by anything
 * (`module-boundaries.spec.ts`), the exact `OrderLineFiredHandler`/
 * `TicketRecalledHandler` precedent.
 *
 * Runs inside the SAME transaction the Sales void command opened
 * (`UnitOfWork.execute` -> `dispatcher.drain(ctx)` -> this handler, before
 * `withAuthContext`'s `$transaction` commits) — opens no transaction of its
 * own.
 */
@Injectable()
@DomainEventHandler(ORDER_LINE_VOIDED_POSTFIRE_EVENT_TYPE)
export class OrderLineVoidedPostFireHandler {
  constructor(
    private readonly ticketPersistence: TicketPersistenceService,
    private readonly projection: TicketProjectionService,
  ) {}

  async handle(
    event: OrderLineVoidedPostFireEvent,
    ctx: UnitOfWorkContext,
  ): Promise<void> {
    const { payload } = event;
    const cancelledAt = new Date(payload.voidedAt);

    const affectedTicketIds =
      await this.ticketPersistence.cancelTicketLinesForOrderLine(
        ctx.tx,
        event.tenantId,
        payload.orderLineId,
        cancelledAt,
      );

    for (const ticketId of affectedTicketIds) {
      await this.projection.apply(ctx.tx, event.tenantId, ticketId, {
        now: cancelledAt,
      });
    }
  }
}
