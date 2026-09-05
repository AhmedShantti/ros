import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { IdentityModule } from '../identity/identity.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { SyncAuthorizationAdapter } from './auth/sync-authorization.adapter';
import { SyncTerminalGuard } from './auth/sync-terminal.guard';
import { BatchReservationService } from './batch/batch-reservation.service';
import { SyncBatchService } from './batch/sync-batch.service';
import { ConflictRecordService } from './conflict/conflict-record.service';
import { SYNC_AUTHORIZATION_PORT } from './contract/sync-authorization.port';
import { DeviceStateService } from './device/device-state.service';
import { KdsTicketBumpLineSyncHandler } from './integration/kds-ticket-bump-line.sync-handler';
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
 * `@SyncOperationHandlerFor` providers wherever they live.
 *
 * ── D4-1B ACCEPTANCE CORRECTION — KitchenModule IS NOW IMPORTED, ON PURPOSE ─
 * D4-1A's original claim ("Sync never mentions Sales, Treasury or Kitchen")
 * is corrected here. The first D4-1B implementation kept that claim true by
 * putting the `@SyncOperationHandlerFor('kds.ticket.bump_line')` PROVIDER
 * inside `modules/kitchen` instead — which made the DOMAIN module depend on
 * the PROTOCOL module's registration/authorization internals
 * (`SyncOperationHandlerFor`, `SyncOperationContext`, `SYNC_AUTHORIZATION_PORT`)
 * to register itself, and reimplemented ticket/line business rules a second
 * time to avoid nesting `KdsOperationsService`'s own `UnitOfWork` transaction.
 *
 * The correction inverts that: `modules/sync/integration/` owns the ONE
 * `@SyncOperationHandlerFor` provider for `kds.ticket.bump_line`, imports
 * `KitchenModule` for exactly ONE published token
 * (`KDS_OFFLINE_TICKET_OPERATIONS`, `kitchen/contract`), and contains zero
 * ticket/line domain logic of its own — only envelope mapping. Kitchen no
 * longer imports Sync at all. This is the correct direction for an
 * INTEGRATION adapter (§5.5.1 interface calls the SRS context map already
 * describes elsewhere in this repository): the kernel itself (batch
 * orchestration, HLC, dedup, causal order, crash recovery) still knows
 * nothing about any domain — only `modules/sync/integration/` does, and it
 * is exactly as thin as the seam it wraps.
 *
 * `kds.ticket.recall` is DELIBERATELY NOT registered here — see the D4-1B
 * report's ACCEPTANCE CORRECTION section (KDS RECALL GOVERNANCE): the
 * offline recall handler did not implement the ratified LWW-by-HLC-per-field
 * + monotonic-state-guard rule (D1-1 §6.1 row 15), because no domain table
 * carries a persisted HLC watermark to compare against. Registering it back
 * requires that schema work first, not a semantics-mismatched approximation.
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
  imports: [DiscoveryModule, IdentityModule, OrganisationModule, KitchenModule],
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
    // D4-1B ACCEPTANCE CORRECTION — the ONE domain integration handler this
    // module owns. Discovered by `SyncOperationRegistry` via
    // `@SyncOperationHandlerFor`, same mechanism as every other handler; it
    // simply now lives, and is registered, on the Sync side of the seam
    // instead of the Kitchen side. See the module docblock above.
    KdsTicketBumpLineSyncHandler,
  ],
  exports: [
    SyncOperationRegistry,
    ConflictRecordService,
    RevalidationExceptionService,
  ],
})
export class SyncModule {}
