/**
 * Thrown when an `order.line.fired` event's ticket-header snapshot disagrees
 * with an existing Ticket's immutable header (P1E-5 §19.1: "DO NOT silently
 * overwrite. Fail with a typed invariant error."). Propagates out of the
 * handler, out of `dispatcher.drain()`, rolling back the whole Fire
 * transaction — the same failure path any other handler error takes.
 */
export class TicketHeaderMismatchError extends Error {
  readonly code = 'TICKET_HEADER_MISMATCH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TicketHeaderMismatchError';
  }
}
