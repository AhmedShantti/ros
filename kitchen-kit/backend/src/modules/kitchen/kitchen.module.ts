import { Module } from '@nestjs/common';
import { OrganisationModule } from '../organisation/organisation.module';
import { OrderLineFiredHandler } from './tickets/order-line-fired.handler';
import { TicketPersistenceService } from './tickets/ticket-persistence.service';
import { TicketReaderService } from './tickets/ticket-reader.service';
import { RoutingResolverService } from './routing/routing-resolver.service';

/**
 * Kitchen Ops bounded context (P1E-3, P1E-5).
 *
 * No controller: FR-KDS-010 resolution and Ticket persistence have no HTTP
 * endpoint (explicit non-goal — Fire is not implemented in this slice).
 * Imports `OrganisationModule` only for its published `contract/`
 * (`RoutingConfigQuery`) — see `module-boundaries.spec.ts`.
 *
 * `OrderLineFiredHandler` is PRIVATE: declared as an ordinary provider here,
 * never exported, never imported by anything else. `DomainEventHandlerRegistry`
 * discovers it purely via the `@DomainEventHandler` metadata key
 * (`DiscoveryService` scans the WHOLE Nest container, not just modules that
 * import `DomainEventsModule`) — Sales never imports this class and never
 * learns Kitchen exists.
 *
 * P1E-5: registered in `app.module.ts` so the handler is actually discovered
 * at bootstrap (P1E-3/P1E-4 deliberately left this module out, since nothing
 * called `RoutingResolverService` yet — that caller now exists).
 */
@Module({
  imports: [OrganisationModule],
  providers: [
    RoutingResolverService,
    TicketPersistenceService,
    TicketReaderService,
    OrderLineFiredHandler,
  ],
  exports: [RoutingResolverService, TicketReaderService],
})
export class KitchenModule {}
