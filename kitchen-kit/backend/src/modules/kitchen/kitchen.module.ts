import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { KdsStationGuard } from './auth/kds-station.guard';
import { KitchenController } from './kitchen.controller';
import { OrderLineFiredHandler } from './tickets/order-line-fired.handler';
import { KdsOperationsService } from './tickets/kds-operations.service';
import { TicketPersistenceService } from './tickets/ticket-persistence.service';
import { TicketProjectionService } from './tickets/ticket-projection.service';
import { TicketReaderService } from './tickets/ticket-reader.service';
import { RoutingResolverService } from './routing/routing-resolver.service';
import { TicketTargetResolver } from './tickets/scope-target.resolver';
import { KDS_TICKET_TARGET_RESOLVER } from './contract';

/**
 * Kitchen Ops bounded context (P1E-3, P1E-5, KDS operator lifecycle).
 *
 * `KitchenController` is the module's FIRST controller (KDS-R11/KDS-R12,
 * ratified 2026-08-30) — Fire itself still has no HTTP endpoint (explicit
 * non-goal). Imports `IdentityModule` purely to reuse the EXISTING guard
 * chain (`JwtAuthGuard` -> `TenantContextGuard` -> `PermissionGuard`),
 * published as `identity/contract`'s cross-cutting HTTP surface, and its
 * `TERMINAL_FACTS_QUERY` public contract; `OrganisationModule` for its
 * published `contract/` (`RoutingConfigQuery`, `StationDisplayBindingQuery`,
 * `KdsBranchConfigQuery`) — see `module-boundaries.spec.ts`.
 *
 * `AuditModule` is deliberately NOT imported here (acceptance correction
 * Blocker A, 2026-08-31): it is `@Global()`, so `AuditService` is already
 * injectable without it, and every other HTTP module's habit of importing it
 * anyway "for explicitness" is exactly what manufactures each of THEIR
 * pre-existing `<module>->governance` `KNOWN_DEVIATIONS` entries (a private
 * path straight into Governance's `audit/` implementation directory).
 * Kitchen reaches `AuditService`/`AUDIT_ACTION`/`AUDIT_ENTITY` only through
 * `governance/contract`, so it needs no module import at all to get them.
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
  imports: [IdentityModule, OrganisationModule],
  controllers: [KitchenController],
  providers: [
    TicketTargetResolver,
    { provide: KDS_TICKET_TARGET_RESOLVER, useExisting: TicketTargetResolver },
    RoutingResolverService,
    TicketPersistenceService,
    TicketProjectionService,
    TicketReaderService,
    OrderLineFiredHandler,
    KdsOperationsService,
    KdsStationGuard,
  ],
  exports: [
    KDS_TICKET_TARGET_RESOLVER,
    RoutingResolverService,
    TicketReaderService,
  ],
})
export class KitchenModule {}
