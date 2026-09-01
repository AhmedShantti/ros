import { DomainEventEnvelope } from '../../../common/domain-events/domain-event.types';

/**
 * Kitchen Ops PUBLIC contract — the domain events this module publishes.
 *
 * SRS §5.5.4's event catalogue lists `ticket.bumped`, publisher Kitchen Ops,
 * principal subscribers Sales, Analytics. `ticket.recalled` (KDS-R12,
 * ratified 2026-08-30) is an EXTENSION of that "Event Catalogue (Core
 * Subset)", not a contradiction of it — the SRS is silent on what happens to
 * Sales readiness when a bumped ticket is recalled, and the register records
 * the extension explicitly rather than claiming SRS authorship.
 *
 * `businessDay` is `string` (`YYYY-MM-DD`), not `Date` — same P1E-1A
 * network-ready-contract correction as `sales/contract/events.ts`; see that
 * file's docblock for the full reasoning (SRS §5.1 driver 7).
 *
 * ── `ticket.bumped` v1 PAYLOAD — KDS operator-lifecycle design gate §12,
 *    finalized by the acceptance correction §1.6 ─────────────────────────────
 * `stationId`, `bumpedAt`, `orderLineIds` and `readyOrderLineIds` are ADDED to
 * the P1E-1 stub (`ticketId`/`orderId`/`businessDay` only). `readyOrderLineIds`
 * is the load-bearing field the acceptance correction's SERIALIZABLE
 * mechanism makes trustworthy (§13/§1.6): the order lines on THIS ticket that
 * are now complete across EVERY station that line was routed to, computed
 * from Kitchen's own `ticket_lines` only. Sales consumes this field alone —
 * it never queries Kitchen. `TICKET_BUMPED_EVENT_VERSION` stays 1: nothing
 * has consumed the P1E-1 stub, so widening the payload breaks no consumer.
 */
export const TICKET_BUMPED_EVENT_TYPE = 'ticket.bumped' as const;
export const TICKET_BUMPED_EVENT_VERSION = 1;

export interface TicketBumpedPayload {
  /** Kitchen-side identity of the bumped ticket. Opaque to Sales. */
  readonly ticketId: string;
  readonly orderId: string;
  /** `sales.orders` partition key, as `YYYY-MM-DD` — see file docblock. */
  readonly businessDay: string;
  /** The station whose Ticket just reached the `bumped` aggregate state. */
  readonly stationId: string;
  /** ISO-8601 — the one server-authoritative instant for this bump. */
  readonly bumpedAt: string;
  /** Every OrderLine on this ticket (not only the ones that just completed). */
  readonly orderLineIds: readonly string[];
  /**
   * The subset of `orderLineIds` that are now bumped/served (or cancelled,
   * with at least one actually bumped/served) on EVERY Kitchen TicketLine
   * across every station that order line was routed to (FR-KDS-011). Sales
   * marks exactly these lines ready — never fewer, never more.
   */
  readonly readyOrderLineIds: readonly string[];
}

export type TicketBumpedEvent = DomainEventEnvelope<
  typeof TICKET_BUMPED_EVENT_TYPE,
  TicketBumpedPayload
>;

/**
 * KDS-R12 (ratified 2026-08-30) — `ticket.recalled`. Publisher Kitchen Ops,
 * subscriber Sales. Withdraws exactly the readiness `ticket.bumped` granted:
 * Sales reverts `revertedOrderLineIds` from `ready` back to `fired`, clearing
 * `ready_at`, and never touches a line that is `served`/`voided`/`comped`
 * (enforced Sales-side by guarding the update on `state = 'ready'`, so an
 * order line that another station has not yet completed — and therefore was
 * never marked `ready` in the first place — is silently left untouched).
 */
export const TICKET_RECALLED_EVENT_TYPE = 'ticket.recalled' as const;
export const TICKET_RECALLED_EVENT_VERSION = 1;

export interface TicketRecalledPayload {
  readonly ticketId: string;
  readonly orderId: string;
  readonly businessDay: string;
  readonly stationId: string;
  /** ISO-8601 — the one server-authoritative instant for this recall. */
  readonly recalledAt: string;
  /**
   * OrderLineIds of this ticket's non-cancelled lines that were `bumped` and
   * are being reverted by this recall. Sales reverts exactly the ones that
   * were actually `ready` (see the class docblock) — never queries Kitchen.
   */
  readonly revertedOrderLineIds: readonly string[];
}

export type TicketRecalledEvent = DomainEventEnvelope<
  typeof TICKET_RECALLED_EVENT_TYPE,
  TicketRecalledPayload
>;
