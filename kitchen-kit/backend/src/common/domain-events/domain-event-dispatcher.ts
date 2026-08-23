import { Injectable } from '@nestjs/common';
import { StaticDomainEventHandlerSource } from './domain-event-handler-source';
import type { DomainEventHandlerSource } from './domain-event-handler-source';
import type { TransactionalDomainEventHandler } from './domain-event-handler.types';
import type { InternalUnitOfWorkContext } from './internal/unit-of-work-internal-context';

export type {
  TransactionalDomainEventHandler,
  TransactionalDomainEventHandlerImplementation,
} from './domain-event-handler.types';

/** Guards a handler that keeps re-emitting events into its own queue. ENGINEERING CHOICE — no source specifies a limit. */
export const MAX_DRAIN_ITERATIONS = 50;

export class DomainEventDispatchLimitExceededError extends Error {
  constructor(limit: number) {
    super(
      `Domain event drain exceeded ${limit} rounds — a handler is very likely ` +
        're-emitting an event into its own queue on every invocation.',
    );
    this.name = 'DomainEventDispatchLimitExceededError';
  }
}

/**
 * Dispatches queued events to their registered handlers, synchronously and
 * in-transaction (§5.5.2). Never fire-and-forget: every handler is awaited
 * before `drain()` resolves, and a handler's rejection propagates unchanged.
 *
 * Reads handlers from a `DomainEventHandlerSource` — see that file for why:
 * this class does not care whether handlers came from Nest-container
 * discovery (`DomainEventHandlerRegistry`, the production path — wired by
 * `DomainEventsModule`) or an explicit array (`StaticDomainEventHandlerSource`
 * via `TransactionalDomainEventDispatcher.withHandlers()`, the manual/test
 * path).
 *
 * `drain()` takes `InternalUnitOfWorkContext` (P1E-1C), not the public
 * `UnitOfWorkContext` — it needs `.events` to pull the queue, which business
 * code and handlers cannot see or name (`unit-of-work-context.ts`'s own
 * docblock explains why). Only `UnitOfWork.execute()` — infrastructure, not a
 * business module — ever calls this method.
 */
@Injectable()
export class TransactionalDomainEventDispatcher {
  constructor(private readonly handlerSource: DomainEventHandlerSource) {}

  /** Convenience for manual construction — tests, or explicit control without DI. */
  static withHandlers(
    handlers: readonly TransactionalDomainEventHandler[],
  ): TransactionalDomainEventDispatcher {
    return new TransactionalDomainEventDispatcher(
      new StaticDomainEventHandlerSource(handlers),
    );
  }

  /**
   * Drain `ctx.events` to empty, dispatching each event to every handler
   * registered for its `eventType`. Handlers for one event run in the order
   * `handlerSource.handlersFor()` returns them and are awaited sequentially —
   * deterministic, but the SRS does not specify handler ordering; this is an
   * ENGINEERING CHOICE, not a source requirement (see
   * `DomainEventHandlerRegistry`'s own docblock for the production ordering
   * rule).
   *
   * A handler MAY publish further events via `ctx.publishEvent()` (§7E); the
   * loop re-drains until the queue is empty, bounded by
   * `MAX_DRAIN_ITERATIONS`. Handlers themselves receive `ctx` narrowed to the
   * PUBLIC `UnitOfWorkContext` — same object, no `.events` in its type.
   */
  async drain(ctx: InternalUnitOfWorkContext): Promise<void> {
    let rounds = 0;
    let batch = ctx.events.drain();
    while (batch.length > 0) {
      rounds += 1;
      if (rounds > MAX_DRAIN_ITERATIONS) {
        throw new DomainEventDispatchLimitExceededError(MAX_DRAIN_ITERATIONS);
      }
      for (const event of batch) {
        for (const handler of this.handlerSource.handlersFor(event.eventType)) {
          await handler.handle(event, ctx);
        }
      }
      batch = ctx.events.drain();
    }
  }
}
