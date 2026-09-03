import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { IdentityModule } from '../identity/identity.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { SyncAuthorizationAdapter } from './auth/sync-authorization.adapter';
import { SyncTerminalGuard } from './auth/sync-terminal.guard';
import { BatchReservationService } from './batch/batch-reservation.service';
import { SyncBatchService } from './batch/sync-batch.service';
import { ConflictRecordService } from './conflict/conflict-record.service';
import { SYNC_AUTHORIZATION_PORT } from './contract/sync-authorization.port';
import { DeviceStateService } from './device/device-state.service';
import { SyncOperationRegistry } from './operations/sync-operation.registry';
import { SyncRecoveryController } from './recovery/sync-recovery.controller';
import { SyncRecoveryService } from './recovery/sync-recovery.service';
import { RevalidationExceptionService } from './revalidation/revalidation-exception.service';
import { SyncController } from './sync.controller';
import { SyncFailpoint } from './sync.failpoint';

/**
 * Offline/Sync bounded context — the D4-1A PROTOCOL KERNEL.
 *
 * Imports `IdentityModule` solely for the published `identity/contract` surface
 * it needs: the guard chain and `TERMINAL_FACTS_QUERY`. `DiscoveryModule`
 * supplies the container scan that `SyncOperationRegistry` uses to find
 * `@SyncOperationHandlerFor` providers wherever they live, which is what keeps
 * this module free of any domain import — Sync never mentions Sales, Treasury or
 * Kitchen, and a domain adds offline support without editing the protocol.
 *
 * `AuditModule` is deliberately NOT imported: `AuditService` is `@Global()`, and
 * Sync reaches it only through `governance/contract`, so importing the module
 * would manufacture exactly the private-path boundary deviation that
 * `module-boundaries.spec.ts` records for older modules. Likewise
 * `IdempotencyModule` is `@Global()` and needs no import.
 *
 * ── D4-1B BINDS SYNC_AUTHORIZATION_PORT FOR REAL ──────────────────────────
 * `OrganisationModule` is imported for exactly one published query,
 * `BRANCH_BRAND_QUERY`, which `SyncTerminalGuard` now uses to close the MW1C
 * inactive-branch gap centrally (see that guard's docblock) — the SAME query
 * `AuthorizationTargetResolver` uses for T-12, so Sync and every HTTP route
 * agree on what "operative branch" means; no second definition is created.
 * `SyncAuthorizationAdapter` binds `SYNC_AUTHORIZATION_PORT` to B1-3's
 * published `ScopeAuthorizationService`, through the new `POS_ACTOR_
 * AUTHORIZATION` seam `IdentityModule` now also exports — see `sync-
 * authorization.adapter.ts` and `identity/contract/pos-actor-authorization.ts`.
 *
 * `SyncFailpoint` is a test-only crash seam whose hook is `null` in production
 * and is never assigned by any code under `src/`. It is a provider rather than
 * a token so a test can mutate its field directly; see its docblock.
 */
@Module({
  imports: [DiscoveryModule, IdentityModule, OrganisationModule],
  controllers: [SyncController, SyncRecoveryController],
  providers: [
    SyncOperationRegistry,
    BatchReservationService,
    DeviceStateService,
    ConflictRecordService,
    RevalidationExceptionService,
    SyncBatchService,
    SyncTerminalGuard,
    SyncFailpoint,
    SyncAuthorizationAdapter,
    { provide: SYNC_AUTHORIZATION_PORT, useExisting: SyncAuthorizationAdapter },
    SyncRecoveryService,
  ],
  exports: [
    SyncOperationRegistry,
    ConflictRecordService,
    RevalidationExceptionService,
    // D4-1B — a domain module (e.g. Kitchen) registering `@SyncOperationHandlerFor`
    // providers needs this token resolvable in ITS OWN module graph, since
    // Nest DI is not global. Importing `SyncModule` for exactly this token is
    // the sanctioned DI-composition path (`module-boundaries.spec.ts`'s
    // `${module}.module` exemption) — no domain type crosses with it.
    SYNC_AUTHORIZATION_PORT,
  ],
})
export class SyncModule {}
