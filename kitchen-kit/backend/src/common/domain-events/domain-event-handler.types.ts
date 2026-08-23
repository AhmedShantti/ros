import { DomainEventEnvelope } from './domain-event.types';
import { UnitOfWorkContext } from './unit-of-work-context';

/**
 * What a DISCOVERABLE provider implements — just the handling behavior.
 * Deliberately does NOT include `eventType`: for a `@DomainEventHandler(...)`
 * -decorated provider, the decorator argument is the single source of truth
 * for the event type, so a provider does not also redeclare it as a property
 * that could drift out of sync with the decorator. `handle` runs INSIDE the
 * publisher's still-open transaction (§5.5.2) — it receives the same `tx`
 * everything else in the Unit of Work uses, via `ctx`. A thrown error is never
 * caught here; it propagates to the dispatcher, then to the Unit of Work, then
 * rolls back the whole PostgreSQL transaction (§12).
 */
export interface TransactionalDomainEventHandlerImplementation<
  TEvent extends DomainEventEnvelope = DomainEventEnvelope,
> {
  handle(event: TEvent, ctx: UnitOfWorkContext): Promise<void>;
}

/**
 * The full, dispatcher-facing shape: an implementation PLUS the event type it
 * handles. What `DomainEventHandlerSource.handlersFor()` returns — built by
 * `DomainEventHandlerRegistry` from decorator metadata + instance, or supplied
 * directly and explicitly to `StaticDomainEventHandlerSource` (no decorator to
 * derive it from in the manual/test path, so the caller states it).
 */
export interface TransactionalDomainEventHandler<
  TEvent extends DomainEventEnvelope = DomainEventEnvelope,
> extends TransactionalDomainEventHandlerImplementation<TEvent> {
  readonly eventType: TEvent['eventType'];
}
