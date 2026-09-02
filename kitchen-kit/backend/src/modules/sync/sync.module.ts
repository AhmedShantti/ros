import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { IdentityModule } from '../identity/identity.module';
import { SyncTerminalGuard } from './auth/sync-terminal.guard';
import { BatchReservationService } from './batch/batch-reservation.service';
import { SyncBatchService } from './batch/sync-batch.service';
import { ConflictRecordService } from './conflict/conflict-record.service';
import { DeviceStateService } from './device/device-state.service';
import { SyncOperationRegistry } from './operations/sync-operation.registry';
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
 * ── NOTHING BINDS SYNC_AUTHORIZATION_PORT ─────────────────────────────────
 * Deliberate. Branch-scoped authorization is Lane B's, and at this code baseline
 * Lane D has no implementation to bind. An unbound token fails loudly if someone
 * tries to consume it early; a default binding would either fake a permission
 * answer (forbidden by the ratification) or silently disable a working protocol.
 *
 * `SyncFailpoint` is a test-only crash seam whose hook is `null` in production
 * and is never assigned by any code under `src/`. It is a provider rather than
 * a token so a test can mutate its field directly; see its docblock.
 */
@Module({
  imports: [DiscoveryModule, IdentityModule],
  controllers: [SyncController],
  providers: [
    SyncOperationRegistry,
    BatchReservationService,
    DeviceStateService,
    ConflictRecordService,
    RevalidationExceptionService,
    SyncBatchService,
    SyncTerminalGuard,
    SyncFailpoint,
  ],
  exports: [
    SyncOperationRegistry,
    ConflictRecordService,
    RevalidationExceptionService,
  ],
})
export class SyncModule {}
