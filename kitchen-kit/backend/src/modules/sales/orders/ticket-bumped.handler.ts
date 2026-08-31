import { Injectable } from '@nestjs/common';
import { DomainEventHandler } from '../../../common/domain-events/domain-event-handler.decorator';
import { UnitOfWorkContext } from '../../../common/domain-events/unit-of-work-context';
import {
  TICKET_BUMPED_EVENT_TYPE,
  TicketBumpedEvent,
} from '../../kitchen/contract';

/**
 * `YYYY-MM-DD` -> a UTC-midnight `Date` for a `@db.Date` column. Identical
 * parsing rule to `orders.controller.ts`'s private `parseBusinessDay` and to
 * `OrderLineFiredHandler`'s own local copy — reimplemented locally because it
 * is a two-line date parse, not a shared business rule (Kitchen's handler
 * docblock records the same reasoning in the opposite direction).
 */
function parseBusinessDay(value: string): Date {
  const [y, m, d] = value.split('-').map((p) => Number.parseInt(p, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * PRIVATE Sales subscriber for `ticket.bumped` — UC-POS-01 step 7 ("System
 * receives ticket.bumped, updates line states to ready"), corrected by the
 * KDS operator-lifecycle design gate §13 and its acceptance correction §1
 * (SERIALIZABLE makes `readyOrderLineIds` trustworthy across stations).
 *
 * Imports ONLY `kitchen/contract` (the public event type) — never a Kitchen
 * private path, never a Kitchen table. Runs inside the SAME transaction
 * Kitchen's bump UnitOfWork opened (`dispatcher.drain` is still inside that
 * `$transaction`): a throw here rolls back the Kitchen bump, its audit entry,
 * and this update together (§5.5.2).
 *
 * Guards on `state IN ('fired', 'preparing')` so a line already `served`,
 * `voided`, or `comped` is NEVER regressed, and a line already `ready`
 * (a legal re-bump-after-recall replay is the only way that combination
 * would even be attempted twice) is simply left untouched rather than
 * rewritten. Does NOT touch `sales.orders.version` — a fired line cannot be
 * cashier-edited anyway, and bumping it would inject a spurious ETag
 * invalidation into the POS from an unrelated cook action (design gate §13).
 */
@Injectable()
@DomainEventHandler(TICKET_BUMPED_EVENT_TYPE)
export class TicketBumpedHandler {
  async handle(
    event: TicketBumpedEvent,
    ctx: UnitOfWorkContext,
  ): Promise<void> {
    const { payload } = event;
    if (payload.readyOrderLineIds.length === 0) {
      return;
    }
    await ctx.tx.orderLine.updateMany({
      where: {
        tenantId: event.tenantId,
        id: { in: [...payload.readyOrderLineIds] },
        businessDay: parseBusinessDay(payload.businessDay),
        state: { in: ['fired', 'preparing'] },
      },
      data: {
        state: 'ready',
        readyAt: new Date(payload.bumpedAt),
      },
    });
  }
}
