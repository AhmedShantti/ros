import { TransactionalDomainEventHandler } from './domain-event-handler.types';

/**
 * What `TransactionalDomainEventDispatcher` reads handlers from. Two
 * implementations exist: `DomainEventHandlerRegistry` (production — populated
 * by Nest-container discovery, see `domain-event-handler.decorator.ts`) and
 * `StaticDomainEventHandlerSource` (manual/test — an explicit fixed array).
 * The dispatcher itself is agnostic to which one it is given.
 */
export interface DomainEventHandlerSource {
  handlersFor(eventType: string): readonly TransactionalDomainEventHandler[];
}

/**
 * Wraps a fixed, explicitly-supplied handler array. For manual construction —
 * direct unit tests of the dispatcher, or an integration proof that wants
 * fully explicit control without Nest DI/discovery. Not used by
 * `DomainEventsModule`'s own wiring, which uses `DomainEventHandlerRegistry`.
 */
export class StaticDomainEventHandlerSource implements DomainEventHandlerSource {
  constructor(
    private readonly handlers: readonly TransactionalDomainEventHandler[],
  ) {}

  handlersFor(eventType: string): readonly TransactionalDomainEventHandler[] {
    return this.handlers.filter((h) => h.eventType === eventType);
  }
}
