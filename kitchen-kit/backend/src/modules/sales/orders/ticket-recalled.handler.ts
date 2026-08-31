import { Injectable } from '@nestjs/common';
import { DomainEventHandler } from '../../../common/domain-events/domain-event-handler.decorator';
import { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import {
  TICKET_RECALLED_EVENT_TYPE,
  TicketRecalledEvent,
} from '../../kitchen/contract';

/** Identical local reimplementation — see `ticket-bumped.handler.ts`'s docblock. */
function parseBusinessDay(value: string): Date {
  const [y, m, d] = value.split('-').map((p) => Number.parseInt(p, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * PRIVATE Sales subscriber for `ticket.recalled` (KDS-R12, ratified
 * 2026-08-30). Reverts exactly the order lines the corresponding
 * `ticket.bumped` marked ready: `ready -> fired`, clearing `ready_at`.
 *
 * The `state: 'ready'` guard IS the precision mechanism the event's own
 * docblock promises: an order line that another station has not yet
 * completed was never marked `ready` in the first place, so it simply does
 * not match here — Sales never needs to ask Kitchen which lines were
 * "actually" ready. `served`/`voided`/`comped` lines are excluded by the same
 * guard (none of those states is `ready`), so they are never regressed.
 *
 * Same-transaction rollback guarantee as `TicketBumpedHandler`.
 */
@Injectable()
@DomainEventHandler(TICKET_RECALLED_EVENT_TYPE)
export class TicketRecalledHandler {
  async handle(
    event: TicketRecalledEvent,
    ctx: UnitOfWorkContext,
  ): Promise<void> {
    const { payload } = event;
    if (payload.revertedOrderLineIds.length === 0) {
      return;
    }
    await ctx.tx.orderLine.updateMany({
      where: {
        tenantId: event.tenantId,
        id: { in: [...payload.revertedOrderLineIds] },
        businessDay: parseBusinessDay(payload.businessDay),
        state: 'ready',
      },
      data: {
        state: 'fired',
        readyAt: null,
      },
    });
  }
}
