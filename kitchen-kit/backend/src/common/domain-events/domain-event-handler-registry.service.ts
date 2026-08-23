import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { DomainEventHandler } from './domain-event-handler.decorator';
import { DomainEventHandlerSource } from './domain-event-handler-source';
import {
  TransactionalDomainEventHandler,
  TransactionalDomainEventHandlerImplementation,
} from './domain-event-handler.types';

/**
 * The production handler registry. `onModuleInit` scans the ENTIRE Nest
 * container once, at bootstrap, for providers decorated with
 * `@DomainEventHandler(eventType)`, and builds an internal, read-only list
 * from them. `handlersFor()` (called at real dispatch time, always after
 * bootstrap) just filters that list — nothing here re-scans per call.
 *
 * ── WHY `onModuleInit`, NOT THE CONSTRUCTOR ──────────────────────────────────
 * Every provider across the WHOLE application is constructed before ANY
 * `onModuleInit` hook fires (Nest's lifecycle: instantiate all providers
 * app-wide, then run `onModuleInit` on all of them). Scanning in the
 * constructor could observe a not-yet-instantiated provider from a module
 * later in the graph; scanning in `onModuleInit` cannot, because construction
 * is already complete for the whole app by then.
 *
 * ── §5C — REGISTRY LIFETIME ──────────────────────────────────────────────────
 * This registry is an application-global singleton, but its list is built
 * EXACTLY ONCE and never mutated after `onModuleInit` — it holds only
 * immutable, stable handler registrations, which is what the instruction
 * explicitly permits ("A singleton handler registry is acceptable if it
 * contains only immutable/stable handler registrations after bootstrap").
 * This is unrelated to `DomainEventCollector`, which stays per-`UnitOfWork`
 * call and is never a singleton (`unit-of-work.ts`).
 *
 * ── §5D — ORDERING ────────────────────────────────────────────────────────
 * Nest's own discovery order is an internal implementation detail this
 * registry does not rely on. Discovered handlers are sorted by their
 * provider's class name before being frozen into the list, giving a
 * reproducible order across restarts. ENGINEERING IMPLEMENTATION CHOICE — the
 * SRS specifies no handler order, and no business correctness may depend on
 * this one (§5D: "Future atomic subscribers must succeed as a set").
 */
@Injectable()
export class DomainEventHandlerRegistry
  implements OnModuleInit, DomainEventHandlerSource
{
  private handlers: readonly TransactionalDomainEventHandler[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const wrappers = this.discovery.getProviders({
      metadataKey: DomainEventHandler.KEY,
    });

    const discovered: Array<{
      name: string;
      handler: TransactionalDomainEventHandler;
    }> = [];

    for (const wrapper of wrappers) {
      const instance: unknown = wrapper.instance;
      if (instance === null || typeof instance !== 'object') continue;

      const eventType = this.discovery.getMetadataByDecorator(
        DomainEventHandler,
        wrapper,
      );
      if (eventType === undefined) continue;

      const name: string =
        typeof (instance as { constructor?: { name?: unknown } }).constructor
          ?.name === 'string'
          ? (instance as { constructor: { name: string } }).constructor.name
          : String(wrapper.token);
      const candidate =
        instance as Partial<TransactionalDomainEventHandlerImplementation>;
      const method:
        TransactionalDomainEventHandlerImplementation['handle'] | undefined =
        candidate.handle;
      if (typeof method !== 'function') {
        throw new Error(
          `${name} is decorated @DomainEventHandler('${eventType}') but has ` +
            'no handle(event, ctx) method.',
        );
      }

      const handle: TransactionalDomainEventHandlerImplementation['handle'] = (
        event,
        ctx,
      ): Promise<void> => method.call(candidate, event, ctx) as Promise<void>;
      discovered.push({
        name,
        handler: { eventType, handle },
      });
    }

    // Deterministic, reproducible order — NOT Nest's internal discovery order.
    discovered.sort((a, b) => a.name.localeCompare(b.name));
    this.handlers = Object.freeze(discovered.map((d) => d.handler));
  }

  handlersFor(eventType: string): readonly TransactionalDomainEventHandler[] {
    return this.handlers.filter((h) => h.eventType === eventType);
  }

  /** Every discovered handler, for diagnostics/tests. */
  get all(): readonly TransactionalDomainEventHandler[] {
    return this.handlers;
  }
}
