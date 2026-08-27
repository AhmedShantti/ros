import { DomainEventEnvelope } from '../../../common/domain-events/domain-event.types';

/**
 * Sales PUBLIC contract — the domain event this module will publish.
 *
 * SRS §5.5.4's event catalogue lists `order.line.fired`, publisher Sales,
 * principal subscriber Kitchen Ops. NO producer in this repository calls
 * `createDomainEvent` with this type yet — there is still no Fire endpoint
 * (P1E-5 explicitly does not implement one). Tests publish this event from a
 * test-owned `UnitOfWork.execute` call to exercise the Kitchen handler.
 *
 * ── FINAL v1 PAYLOAD (P1E-5) ─────────────────────────────────────────────
 * P1E-1's original payload (`orderId`/`businessDay`/`orderLineId`/`course`
 * only) was deliberately minimal because three of FR-KDS-010's five routing
 * tiers had no storage yet. P1E-3/P1E-3A built the routing persistence and
 * resolver; P1E-4 closed the Ticket/TicketLine design; this slice makes the
 * payload match what a real Kitchen handler needs, in one pass, because NO
 * producer exists yet and changing v1 now is free.
 *
 * The envelope (`DomainEventEnvelope`) already supplies `tenantId`,
 * `branchId`, `actorId`, `actorType`, `correlationId`, `causationId`,
 * `idempotencyKey` — none of those is repeated here.
 *
 * Five groups, each answering one thing the Kitchen handler cannot get any
 * other way (it must not query `sales.*` or `catalogue.*` — P1E-4 §F):
 *
 *   SOURCE   — which order, business day, and line this event is about.
 *   FIRE     — `fireBatchId` identifies the Fire COMMAND, shared by every
 *              line event it publishes, across every station it touches —
 *              the idempotency key `kitchen.ticket_fire_batches` uses
 *              (P1E-5 acceptance correction B: no sequence-number allocator,
 *              no unique-violation-then-retry race). `firedAt` is the
 *              command's own instant — becomes `Ticket.routedAt` /
 *              `TicketFireBatch.firedAt`, never a `DEFAULT now()`.
 *   ROUTING  — the FR-KDS-010 tier 2-4 SELECTORS (not resolved station ids —
 *              resolving them is Kitchen's job, via the Organisation public
 *              contract, inside its own handler) plus tier-1 explicit
 *              overrides.
 *   TICKET HEADER — repeated on EVERY line event of a batch, deliberately:
 *              this makes each event independently sufficient to create the
 *              station Ticket, so Kitchen's correctness never depends on
 *              which of a batch's several events happens to arrive first.
 *   LINE     — FR-KDS-020's card fields, snapshotted at fire time.
 *   MODIFIERS — FR-KDS-020/021. `orderLineModifierId` (P1E-5 acceptance
 *              correction, NOT `modifierId` alone) is the idempotency key —
 *              FR-MNU-011's allow-repeat/free-quantity threshold make
 *              selecting the SAME Catalogue modifier twice on one line
 *              legal, so `modifierId` cannot serve as one.
 *
 * Deliberately excluded: money/tax/cost (no FR-KDS requirement names them);
 * the whole `Order` object; resolved station ids (a Kitchen concern);
 * `variantId` (routing is MenuItem-level per ratified Catalogue conflict
 * C-03; the variant's display name is already inside `itemNameSnapshot`);
 * `sortOrder` on modifiers (current `sales.order_line_modifiers` captures no
 * ordering value — inventing one, or querying Catalogue merely to obtain
 * one, is out of scope; a consumer uses `orderLineModifierId` as a
 * deterministic, business-meaning-free display tiebreaker instead).
 *
 * ── `businessDay` IS `string`, NOT `Date` (P1E-1A correction, unchanged) ──
 * SRS §5.1 driver 7's "network-ready contract". `businessDay` is a
 * DATE-ONLY business key — the `sales.orders`/`sales.order_lines` partition
 * key — and reuses the repository's established `YYYY-MM-DD` wire format
 * (`orders.controller.ts`'s `parseBusinessDay`, `.toISOString().slice(0,
 * 10)` everywhere else a `businessDay` crosses a boundary).
 *
 * `firedAt` is likewise an ISO-8601 string for the identical reason
 * `occurredAt`/`recordedAt` are — see `domain-event.types.ts`'s docblock.
 */
export const ORDER_LINE_FIRED_EVENT_TYPE = 'order.line.fired' as const;
export const ORDER_LINE_FIRED_EVENT_VERSION = 1;

/**
 * The three FR-POS-021 kinds, exactly as `catalogue.ModifierKind` and
 * `sales.order_line_modifiers.kind_snapshot` already constrain them. A
 * future Fire producer MUST fail closed (refuse to fire) rather than publish
 * a modifier whose `kindSnapshot` is `null` — this type has no `| null`
 * member, so the payload itself cannot represent an unknown kind; Fire is
 * not implemented in this slice, so that fail-closed check is not built here
 * either, only the contract that makes it necessary.
 */
export type OrderLineFiredModifierKind =
  'addition' | 'removal' | 'substitution';

export interface OrderLineFiredLineOverride {
  readonly overrideId: string;
  readonly stationId: string;
}

export interface OrderLineFiredModifier {
  /** The idempotency key — see file docblock. NOT `modifierId` alone. */
  readonly orderLineModifierId: string;
  readonly modifierId: string;
  readonly nameSnapshot: Readonly<Record<string, unknown>>;
  readonly kind: OrderLineFiredModifierKind;
  readonly quantity: number;
}

export interface OrderLineFiredPayload {
  // ── SOURCE ────────────────────────────────────────────────────────────
  readonly orderId: string;
  /**
   * `sales.orders`/`sales.order_lines` partition key, as `YYYY-MM-DD` — the
   * repository's established date-only wire format (see file docblock). NOT
   * an ISO-8601 instant.
   */
  readonly businessDay: string;
  readonly orderLineId: string;

  // ── FIRE ──────────────────────────────────────────────────────────────
  /** Identity of the Fire COMMAND — shared by every line event it publishes. */
  readonly fireBatchId: string;
  /** ISO-8601. The Fire command's own instant — see file docblock. */
  readonly firedAt: string;

  // ── ROUTING (selectors, not resolved stations — see file docblock) ─────
  readonly menuItemId: string;
  readonly modifierIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly lineStationOverrides: readonly OrderLineFiredLineOverride[];

  // ── TICKET HEADER SNAPSHOT (repeated on every line event) ──────────────
  readonly orderNumber: string;
  readonly orderType:
    | 'dine_in'
    | 'takeaway'
    | 'delivery'
    | 'drive_thru'
    | 'pickup'
    | 'aggregator';
  /** FR-KDS-020 "table or customer reference". Pre-redacted display string
   *  only — never customer PII (P1E-4 §F). `null` if the order has neither. */
  readonly serviceReference: string | null;

  // ── LINE SNAPSHOT ───────────────────────────────────────────────────────
  readonly itemNameSnapshot: Readonly<Record<string, unknown>>;
  /** `DECIMAL(12,3)` as a string — never a JS number. */
  readonly quantity: string;
  /** FR-POS-036 [S]. `null` when the line was not assigned to a course. */
  readonly course: number | null;
  /** `sales.order_lines.sequence` — display order within the order. */
  readonly sequence: number;
  readonly preparationNotes: string | null;

  // ── MODIFIER DISPLAY SNAPSHOTS ──────────────────────────────────────────
  readonly modifiers: readonly OrderLineFiredModifier[];
}

export type OrderLineFiredEvent = DomainEventEnvelope<
  typeof ORDER_LINE_FIRED_EVENT_TYPE,
  OrderLineFiredPayload
>;

/**
 * `order.opened` — SRS §5.5.4's event catalogue, publisher Sales, subscribers
 * Kitchen Ops and Analytics. P1E-6's Fire producer is the first (and, per the
 * SRS event catalogue, only) place this is published: in ROS's domain
 * vocabulary "opened" means the order's state MACHINE transition
 * `draft -> open` (`order-state.ts`'s `TRANSITIONS`), which happens on the
 * FIRST successful Fire — not order CREATION, which leaves a new order in
 * `draft` (`OrdersService.create`). A subsequent Fire against an already-`open`
 * order does not publish this again (there is no second `draft -> open`
 * transition to report).
 *
 * Narrowest payload the SRS event catalogue supports: enough to identify and
 * classify the order that just opened, nothing else. `tenantId`/`branchId`/
 * `actorId`/`occurredAt` already live on the envelope and are not repeated.
 * No money, customer, or line-level field is included — none is named by any
 * source read for this event, and Kitchen's own correctness continues to
 * rely entirely on the self-contained `order.line.fired` events (P1E-5 §F),
 * not on this one. No subscriber is registered for this event in this
 * slice — publishing it does not require one (§5.5.2's fire-and-forget
 * in-process dispatch tolerates zero handlers).
 */
export const ORDER_OPENED_EVENT_TYPE = 'order.opened' as const;
export const ORDER_OPENED_EVENT_VERSION = 1;

export interface OrderOpenedPayload {
  readonly orderId: string;
  /** `YYYY-MM-DD` — see `OrderLineFiredPayload.businessDay`'s docblock note. */
  readonly businessDay: string;
  readonly orderNumber: string;
  readonly orderType:
    | 'dine_in'
    | 'takeaway'
    | 'delivery'
    | 'drive_thru'
    | 'pickup'
    | 'aggregator';
  readonly channel: 'pos' | 'kiosk' | 'qr' | 'aggregator' | 'phone' | 'api';
  /** ISO-8601. The Fire command's own instant — the same `firedAt` the
   *  batch's `order.line.fired` events carry, since first-Fire is what opens
   *  the order. */
  readonly openedAt: string;
}

export type OrderOpenedEvent = DomainEventEnvelope<
  typeof ORDER_OPENED_EVENT_TYPE,
  OrderOpenedPayload
>;

/**
 * `order.completed` — SRS §5.5.4 event catalogue: publisher Sales,
 * principal subscribers "Inventory, Costing, Treasury, Fiscal, Customer,
 * Analytics". P1F-2 is the FIRST producer. ZERO subscribers are registered
 * in this slice (SRS §5.5.2's fire-and-forget in-process dispatch tolerates
 * zero handlers, same as `order.opened`) — publishing this does not
 * literally satisfy §5.5.2 subscriber compliance, and the P1F-2 report
 * states that honestly rather than claiming it.
 *
 * ── PAYLOAD SHAPE — TRANSCRIBED FROM SRS §24.2.4 ────────────────────────
 * The SRS's own `Order.complete()` reference pseudocode (§24.2.4) records:
 *
 *   this.record(new OrderCompleted({
 *     orderId: this.id, branchId: this.branchId, businessDay: this.businessDay,
 *     lines: this.lines.map(l => l.toConsumptionSpec()),
 *     totals: this.totals(), payments: payments.map(p => p.toSummary()),
 *     completedAt: at, customerId: this.customerId,
 *   }));
 *
 * These six top-level fields are used VERBATIM — "Invent no fields". The
 * SRS pseudocode's helper methods (`toConsumptionSpec`/`totals`/`toSummary`)
 * are not spelled out field-by-field anywhere in the source, so their SUB-
 * shapes below are derived from the concrete P1F-1/P1F-2 schema this
 * repository actually has (`sales.orders`, `sales.order_lines`,
 * `sales.order_payments`, and Production's `planConsumption` output) —
 * documented here as an implementation decision, not asserted as literal
 * SRS text.
 *
 * `customerId` is ALWAYS `null`: no customer/CRM/loyalty concept exists
 * anywhere in this codebase (an explicit NON-GOAL), so the SRS-named field
 * is carried, honestly unpopulated, rather than omitted or fabricated.
 */
export const ORDER_COMPLETED_EVENT_TYPE = 'order.completed' as const;
export const ORDER_COMPLETED_EVENT_VERSION = 1;

export interface OrderCompletedComponent {
  readonly stockItemId: string;
  /** DECIMAL(18,6) exact string. */
  readonly quantityInBaseUnit: string;
  readonly unitId: string;
}

/** `l.toConsumptionSpec()` — one order line's identity, quantity and Production's expanded consumption. */
export interface OrderCompletedLine {
  readonly orderLineId: string;
  readonly menuItemId: string;
  readonly variantId: string;
  /** `DECIMAL(12,3)` as a string. */
  readonly quantity: string;
  /** Exact bigint minor units, as a string. */
  readonly postedCogsTotal: string;
  readonly components: readonly OrderCompletedComponent[];
}

/** `this.totals()` — `sales.orders`' own financial columns, minor units as strings. */
export interface OrderCompletedTotals {
  readonly currency: string;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly serviceChargeTotal: string;
  readonly taxTotal: string;
  readonly roundingAdjustment: string;
  readonly grandTotal: string;
  readonly paidTotal: string;
  readonly tipTotal: string;
  readonly cogsTotal: string;
}

/** `p.toSummary()` — one `sales.order_payments` row, minor units as strings. */
export interface OrderCompletedPaymentSummary {
  readonly id: string;
  readonly tender: 'cash' | 'manual_external_card';
  readonly amount: string;
  readonly roundingAdjustment: string;
  readonly tenderedAmount: string | null;
  readonly changeGiven: string | null;
  readonly cashSessionId: string;
  readonly employeeId: string;
  readonly terminalId: string;
  /** ISO-8601. */
  readonly processedAt: string;
}

export interface OrderCompletedPayload {
  readonly orderId: string;
  readonly branchId: string;
  /** `YYYY-MM-DD` — see `OrderLineFiredPayload.businessDay`'s docblock note. */
  readonly businessDay: string;
  readonly lines: readonly OrderCompletedLine[];
  readonly totals: OrderCompletedTotals;
  /** EVERY payment on the order (not only the settling one). */
  readonly payments: readonly OrderCompletedPaymentSummary[];
  /** ISO-8601. */
  readonly completedAt: string;
  /** Always `null` — see file docblock. */
  readonly customerId: null;
}

export type OrderCompletedEvent = DomainEventEnvelope<
  typeof ORDER_COMPLETED_EVENT_TYPE,
  OrderCompletedPayload
>;
