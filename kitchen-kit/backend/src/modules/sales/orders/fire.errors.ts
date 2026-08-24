import { OrderStateError } from './order-state';

/**
 * Fire-specific domain rejections. Both extend `OrderStateError` so
 * `SalesDomainExceptionFilter`'s existing `@Catch(OrderStateError, ...)` maps
 * them to 422 with zero filter changes — the same mechanism
 * `OrderVersionConflictError` already relies on for its own (different)
 * status mapping.
 */

/**
 * ENGINEERING-DECIDED (P1E-6 §8), not SRS-mandated: the SRS does not define
 * what a Fire command with zero eligible PENDING lines should do. Refusing
 * with 422 rather than silently succeeding avoids implying a Fire "batch"
 * happened when nothing was actually sent to production.
 */
export class NoEligibleLinesToFireError extends OrderStateError {
  constructor(message: string) {
    super(message);
    this.name = 'NoEligibleLinesToFireError';
  }
}

/**
 * FR-POS-021 / P1E-5: a legacy `Modifier`/`OrderLineModifier` row may carry a
 * `null` `kindSnapshot` (no non-heuristic source ever existed for it — see
 * `docs/reports/claude/2026-08-23_P1E5_ticket-persistence-and-kitchen-
 * handler.md`). `order.line.fired`'s `OrderLineFiredModifier.kind` has no
 * `| null` member, so the payload cannot represent an unknown kind — Fire
 * FAILS CLOSED on the whole command rather than guessing `addition` /
 * `removal` / `substitution` for even one modifier on one line being fired.
 */
export class UnresolvedModifierKindError extends OrderStateError {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedModifierKindError';
  }
}

/**
 * P1E-6A Defect B: `assertMayFire` (order-state.ts) permits any
 * non-finalised state, including `held`/`parked` — correct for the GENERAL
 * state machine, but the MVP explicit Fire command only actually implements
 * the draft->open first Fire and the open->open amendment Fire. Firing a
 * `held`/`parked`/`partially_paid` order is refused HERE, narrowly, rather
 * than by broadening or redesigning `order-state.ts`'s reusable rules (which
 * still permit held/parked for every other purpose — e.g. `assertMayAddLine`
 * still allows `held`). Checked before `assertMayFire` so a legitimate
 * finalised-order refusal still reaches `assertMayFire`'s own, more specific
 * BR-POS-001 message unchanged.
 */
export class IllegalFireSourceStateError extends OrderStateError {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalFireSourceStateError';
  }
}

/**
 * P1E-6A Defect C: a dine-in order's `tableId` is present but does not
 * resolve through the Organisation `TableDisplayQuery` public contract (the
 * table was deleted, or belongs to another tenant). Failing CLOSED here
 * — instead of silently firing with `serviceReference: null` — because a
 * present-but-dangling `tableId` is a data-integrity problem, not the
 * "no table assigned yet" case FR-POS-003 already covers via
 * `assertMayFire`'s `tableId === null` check.
 */
export class UnresolvedServiceReferenceError extends OrderStateError {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedServiceReferenceError';
  }
}
