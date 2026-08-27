/**
 * Order aggregate state rules — SRS §7.3 #22, BR-POS-001…004, and the
 * **Clarification B / C** authority boundary recorded in the governance
 * register (2026-08-20).
 *
 * Pure logic: no database, no clock, no HTTP. The service layer applies these
 * decisions inside a transaction; putting them here means a direct service call
 * cannot bypass them, which is what "enforce in the DOMAIN, not the UI" requires.
 *
 * ── WHAT CLARIFICATION B SETTLED ────────────────────────────────────────────
 * ADR-010 reads literally as "orders are never updated". That would contradict
 * both the state machine and optimistic concurrency, so it was clarified:
 * an order MAY change while pre-finalisation; a COMPLETED order may not.
 * Payments, stock movements and audit entries stay append-only regardless.
 *
 * ── WHAT CLARIFICATION C SETTLED ────────────────────────────────────────────
 *   before fire  — the cashier edits normally;
 *   after fire   — the cashier may NOT mutate fired content; correction is a
 *                  privileged Manager-or-higher operation;
 *   after COMPLETED — nobody edits the original; correction is a Refund.
 *
 * The privileged post-fire path is deliberately NOT implemented: no existing SRS
 * or ratified permission authorises a general post-fire edit.
 * `order.cancel_after_production` (BR-POS-003) covers cancellation only and is
 * explicitly forbidden from being broadened. So this module answers only
 * "may the CASHIER do this?", and the answer after fire is always no.
 */

export type OrderState =
  | 'draft'
  | 'open'
  | 'held'
  | 'parked'
  | 'partially_paid'
  | 'completed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded';

export type OrderLineState =
  'pending' | 'fired' | 'preparing' | 'ready' | 'served' | 'voided' | 'comped';

/** States in which the order is financially posted and therefore frozen. */
const FINALISED: ReadonlySet<OrderState> = new Set<OrderState>([
  'completed',
  'cancelled',
  'partially_refunded',
  'refunded',
]);

/**
 * Line states that mean production has been told about the line.
 *
 * `pending` has not been sent. `voided`/`comped` are terminal bookkeeping states
 * rather than "in the kitchen", and are handled by the caller.
 */
const SENT_TO_PRODUCTION: ReadonlySet<OrderLineState> = new Set<OrderLineState>(
  ['fired', 'preparing', 'ready', 'served'],
);

/**
 * The SRS state machine. Only transitions listed here are legal.
 *
 * Several targets exist in the enum but have NO transition into them here —
 * `completed`, `partially_paid`, `partially_refunded`, `refunded` — because the
 * operations that would produce them (payment, completion, refund) are not
 * implemented. The domain KNOWS these states so historical rows read correctly;
 * it refuses to invent a way of reaching them. A "complete" that merely flipped
 * the column would be a defect.
 */
const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> =
  Object.freeze({
    draft: ['open', 'cancelled'],
    // P1F-1: a partial Payment moves an OPEN order to PARTIALLY_PAID
    // (BR-POS-002). PARTIALLY_PAID -> PARTIALLY_PAID is deliberately NOT a
    // transition: a further partial payment on an already-partially-paid
    // order changes only projections (paid_total, version), never state, so
    // it never calls `assertTransition` at all.
    // P1F-2: a SETTLING Payment (one that brings paid_total to grandTotal)
    // completes the order from EITHER open (a single full-settlement
    // Payment) or partially_paid (the settling split-tender Payment) — never
    // an intermediate state.
    open: ['held', 'parked', 'cancelled', 'partially_paid', 'completed'],
    held: ['open', 'cancelled'],
    parked: ['open', 'cancelled'],
    partially_paid: ['completed'],
    completed: [],
    cancelled: [],
    partially_refunded: [],
    refunded: [],
  });

export class OrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderStateError';
  }
}

/**
 * A stale optimistic-concurrency assertion.
 *
 * Separated from the other state errors because it means something different to
 * a caller: the operation is permitted, it just lost a race, and the correct
 * response is 409 with an invitation to reload — not 422, which reads as "this
 * can never work".
 */
export class OrderVersionConflictError extends OrderStateError {
  constructor(message: string) {
    super(message);
    this.name = 'OrderVersionConflictError';
  }
}

/** BR-POS-001: a COMPLETED order is immutable, for every actor. */
export function isFinalised(state: OrderState): boolean {
  return FINALISED.has(state);
}

export function isSentToProduction(state: OrderLineState): boolean {
  return SENT_TO_PRODUCTION.has(state);
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) {
    throw new OrderStateError(
      `Illegal order transition ${from} -> ${to}.` +
        (TRANSITIONS[from].length === 0
          ? ` ${from} is terminal in this implementation.`
          : ` Legal targets: ${TRANSITIONS[from].join(', ')}.`),
    );
  }
}

/**
 * May the ORDER accept content changes at all?
 *
 * A finalised order rejects every content mutation — that is BR-POS-001, and it
 * binds cashier, manager and any internal caller alike.
 */
export function assertOrderMutable(state: OrderState): void {
  if (isFinalised(state)) {
    throw new OrderStateError(
      `This order is ${state} and can no longer be modified. ` +
        'BR-POS-001 requires corrections to be made as Refunds referencing the original.',
    );
  }
}

/**
 * May the CASHIER mutate this line?
 *
 * Clarification C in one function. Pre-fire, yes. Once production has been told,
 * no — and there is deliberately no `actorIsManager` escape hatch, because no
 * ratified permission authorises a general post-fire edit.
 */
export function assertCashierMayMutateLine(
  orderState: OrderState,
  lineState: OrderLineState,
): void {
  assertOrderMutable(orderState);

  if (isSentToProduction(lineState)) {
    throw new OrderStateError(
      `This line has been sent to production (${lineState}) and cannot be changed by the cashier. ` +
        'A correction after fire is a privileged operation; it is not available in this release ' +
        'because no ratified permission authorises a general post-fire edit.',
    );
  }
  if (lineState === 'voided' || lineState === 'comped') {
    throw new OrderStateError(
      `This line is already ${lineState} and cannot be changed again.`,
    );
  }
}

/** A line may be added only while the order is pre-finalisation. */
export function assertMayAddLine(orderState: OrderState): void {
  assertOrderMutable(orderState);
  if (
    orderState !== 'draft' &&
    orderState !== 'open' &&
    orderState !== 'held'
  ) {
    throw new OrderStateError(
      `Lines cannot be added to an order in state ${orderState}.`,
    );
  }
}

/**
 * FR-POS-003 — a dine-in order needs a table before it is fired.
 *
 * Deliberately a FIRE-time rule, not a creation-time one: the SRS says "before
 * firing to the kitchen", and requiring it at creation would stop a server
 * opening a tab before seating the guests.
 */
export function assertMayFire(
  orderState: OrderState,
  orderType: string,
  tableId: string | null,
): void {
  assertOrderMutable(orderState);
  if (orderType === 'dine_in' && tableId === null) {
    throw new OrderStateError(
      'A dine-in order requires a table assignment before it can be fired (FR-POS-003).',
    );
  }
}

/**
 * P1F-1 — may a Payment be captured against this order?
 *
 * Only DRAFT->OPEN's destination and OPEN's own PARTIALLY_PAID successor
 * accept a payment in this MVP: `open` (first payment) and `partially_paid`
 * (a further split-tender payment). `held`/`parked` are legal operational
 * states elsewhere in the system but a payment against a held or parked
 * order is not source-supported here, so it is refused rather than
 * silently accepted. A finalised order still falls through to
 * `assertOrderMutable`'s own BR-POS-001 message, unchanged.
 */
export function assertMayCapturePayment(orderState: OrderState): void {
  assertOrderMutable(orderState);
  if (orderState !== 'open' && orderState !== 'partially_paid') {
    throw new OrderStateError(
      `Payment cannot be captured while the order is ${orderState}. ` +
        'Only open or partially_paid orders accept a payment in this release.',
    );
  }
}

/**
 * §24.6.4 optimistic concurrency: assert the caller's expected version.
 *
 * Returns the version to write. A mismatch throws, so the caller performs no
 * partial write and emits no audit event.
 */
export function assertVersion(current: number, expected: number): number {
  if (current !== expected) {
    throw new OrderVersionConflictError(
      `Version mismatch: the order is at version ${current}, but the request expected ${expected}. ` +
        'Reload the order and retry.',
    );
  }
  return current + 1;
}
