import { forwardRef, Global, Module } from '@nestjs/common';
import { IdentityModule } from '../../identity/identity.module';
import { PlatformModule } from '../../platform/platform.module';
import { AuditChainVerificationJob } from './audit-chain-verification.job';
import { AuditQueryController } from './audit-query.controller';
import { AuditQueryService } from './audit-query.service';
import { AuditService } from './audit.service';

/**
 * Global so any bounded context can inject the audit writer. Audit is
 * cross-cutting governance infrastructure, not part of the identity context.
 *
 * AUD-1 additions:
 *
 * - `AuditChainVerificationJob` (FR-AUD-005) — a scheduled-job PROVIDER only,
 *   discovered by `ScheduledJobRegistry` via `@ScheduledJobHandlerFor`
 *   (`platform/contract`, the same seam `InventoryDailyReconciliationJob`
 *   uses). `PlatformModule` is imported for the same reason Inventory imports
 *   it: this module reaches Platform only through `platform/contract` +
 *   `platform.module`, so no boundary is crossed and no `KNOWN_DEVIATIONS`
 *   entry is added.
 * - `AuditQueryController` + `AuditQueryService` (FR-AUD-007/008, AUD-R1) —
 *   the auditor query/export HTTP surface. `IdentityModule` is imported to
 *   reuse the EXISTING guard chain (`JwtAuthGuard` → `TenantContextGuard` →
 *   `PermissionGuard`) published as `identity/contract`'s cross-cutting HTTP
 *   surface (the KDS-R11/Kitchen/Reporting precedent) — this module adds NO
 *   `KNOWN_DEVIATIONS` entry for it. Wrapped in `forwardRef()` for the SAME
 *   reason `organisation.module.ts` already wraps its own edge to
 *   `IdentityModule`: `AuditModule` was already reachable from
 *   `IdentityModule` indirectly (Identity → Organisation → `AuditModule`,
 *   Organisation's pre-existing edge), so a plain, un-wrapped import here
 *   closes a real module cycle rather than opening a new architectural one —
 *   `forwardRef` merely defers resolution past both files' initial evaluation.
 *
 * Governance's OTHER module (`governance.module.ts`, the Approval mechanism)
 * is untouched: D-14 A-1 ("no Governance HTTP surface") remains exactly what
 * it always was, for Approvals specifically. This file is a different module.
 */
@Global()
@Module({
  imports: [forwardRef(() => IdentityModule), PlatformModule],
  controllers: [AuditQueryController],
  providers: [AuditService, AuditChainVerificationJob, AuditQueryService],
  exports: [AuditService],
})
export class AuditModule {}
