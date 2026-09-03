import { Global, Module } from '@nestjs/common';
import { PlatformModule } from '../../platform/platform.module';
import { AuditChainVerificationJob } from './audit-chain-verification.job';
import { AuditService } from './audit.service';

/**
 * Global so any bounded context can inject the audit writer. Audit is
 * cross-cutting governance infrastructure, not part of the identity context.
 *
 * AUD-1 — `AuditChainVerificationJob` (FR-AUD-005) is a scheduled-job
 * PROVIDER only, discovered by `ScheduledJobRegistry` via
 * `@ScheduledJobHandlerFor` (`platform/contract`, the same seam
 * `InventoryDailyReconciliationJob` uses). `PlatformModule` is imported for
 * the same reason Inventory imports it: this module reaches Platform only
 * through `platform/contract` + `platform.module`, so no boundary is crossed
 * and no `KNOWN_DEVIATIONS` entry is added.
 */
@Global()
@Module({
  imports: [PlatformModule],
  providers: [AuditService, AuditChainVerificationJob],
  exports: [AuditService],
})
export class AuditModule {}
