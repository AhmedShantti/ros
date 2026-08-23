import { DomainEventEnvelope } from '../../../common/domain-events/domain-event.types';

/**
 * Kitchen Ops PUBLIC contract — the domain event this (not-yet-implemented)
 * module will eventually publish.
 *
 * SRS §5.5.4's event catalogue lists `ticket.bumped`, publisher Kitchen Ops,
 * principal subscribers Sales, Analytics. No `KitchenModule`, no `Ticket`, and
 * no `TicketLine` exist in this repository (see the P1D-1/P1E gate report §I —
 * the approved `kitchen.tickets`/`kitchen.ticket_lines` DDL cannot even be
 * created as written against the partitioned `sales.orders`/`sales.order_lines`
 * tables). A `contract/` directory can still exist and hold a typed event
 * definition without any persistence or business implementation behind it —
 * that is deliberately all this file is.
 *
 * ── PAYLOAD — WHY IT IS THIS SMALL ──────────────────────────────────────────
 * A Kitchen Ticket's actual shape is undecided (six open conflicts are
 * recorded in the prior gate report, §I) — the identity fields below are the
 * only ones any plausible Ticket design must have, because Sales must be able
 * to correlate the bump back to the Order it fired without the event carrying
 * (or forcing a lookup into) any not-yet-designed Kitchen schema.
 *
 * `businessDay` is `string` (`YYYY-MM-DD`), not `Date` — same P1E-1A
 * network-ready-contract correction as `sales/contract/events.ts`; see that
 * file's docblock for the full reasoning (SRS §5.1 driver 7).
 */
export const TICKET_BUMPED_EVENT_TYPE = 'ticket.bumped' as const;
export const TICKET_BUMPED_EVENT_VERSION = 1;

export interface TicketBumpedPayload {
  /** Kitchen-side identity of the bumped ticket. Opaque to Sales. */
  readonly ticketId: string;
  readonly orderId: string;
  /** `sales.orders` partition key, as `YYYY-MM-DD` — see file docblock. */
  readonly businessDay: string;
}

export type TicketBumpedEvent = DomainEventEnvelope<
  typeof TICKET_BUMPED_EVENT_TYPE,
  TicketBumpedPayload
>;
