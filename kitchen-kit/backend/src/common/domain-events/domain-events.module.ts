import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TransactionalDomainEventDispatcher } from './domain-event-dispatcher';
import { DomainEventHandlerRegistry } from './domain-event-handler-registry.service';
import { UnitOfWork } from './unit-of-work';

/**
 * SRS §5.5.2 transaction-aware in-process domain-event foundation.
 *
 * Global, like `PrismaModule` and `IdempotencyModule`: this is cross-cutting
 * infrastructure with zero business logic (§5.2.3 — "Shared code ... MUST NOT
 * contain business logic"), so any future bounded-context module can inject
 * `UnitOfWork` without re-importing this module.
 *
 * `DiscoveryModule` (`@nestjs/core`) is imported so `DomainEventHandlerRegistry`
 * can inject `DiscoveryService` and scan the whole application graph for
 * `@DomainEventHandler(...)`-decorated providers at bootstrap — see that
 * file's docblock (P1E-1A correction: production handler registration).
 *
 * `TransactionalDomainEventDispatcher` is built via a factory that hands it
 * the LIVE `DomainEventHandlerRegistry` instance, not a snapshot array —
 * required because the registry's list is only populated in its own
 * `onModuleInit`, which may run after this factory does. Passing the registry
 * by reference means `dispatcher.drain()` (called far later, during real
 * request handling) always sees the fully-populated list.
 *
 * No handler is registered anywhere in the production module graph yet — no
 * business event is published (§7 objective carried over from P1E-1).
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    DomainEventHandlerRegistry,
    {
      provide: TransactionalDomainEventDispatcher,
      useFactory: (registry: DomainEventHandlerRegistry) =>
        new TransactionalDomainEventDispatcher(registry),
      inject: [DomainEventHandlerRegistry],
    },
    UnitOfWork,
  ],
  exports: [UnitOfWork, TransactionalDomainEventDispatcher],
})
export class DomainEventsModule {}
