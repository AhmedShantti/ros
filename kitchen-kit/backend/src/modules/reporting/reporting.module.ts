import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { InventoryModule } from '../inventory/inventory.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { LocalisationModule } from '../localisation/localisation.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { SalesModule } from '../sales/sales.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { WorkforceModule } from '../workforce/workforce.module';
import { DailyTradingReportService } from './daily-trading-report.service';
import { OperationalOverviewService } from './operational-overview.service';
import { ReportingController } from './reporting.controller';

/**
 * Reporting bounded context — Minimum Operational Reporting (RPT-R1/R2/R3,
 * governance register "Minimum Operational Reporting Ratification —
 * 2026-08-31"). A thin orchestration/read-presentation module: it owns
 * ZERO Prisma models and ZERO migrations.
 *
 * `IdentityModule` is imported purely to reuse the EXISTING guard chain
 * (`JwtAuthGuard` → `TenantContextGuard` → `PermissionGuard`) and
 * `@RequirePermission` decorator, published as `identity/contract`'s
 * cross-cutting HTTP surface (the KDS-R11/kitchen precedent) — this module
 * adds NO `KNOWN_DEVIATIONS` entry for it. `SalesModule`,
 * `TreasuryModule`, `OrganisationModule` and `LocalisationModule` are
 * imported ONLY for their published `contract/` tokens
 * (`DAILY_TRADING_SALES_QUERY`, `DAILY_CASH_RECONCILIATION_QUERY`,
 * `BRANCH_CURRENCY_QUERY` + `BRANCH_REPORTING_SCOPE_QUERY`,
 * `TAX_CLASS_LABELS_QUERY`) — this module never queries any of their tables
 * or imports any of their private paths (`module-boundaries.spec.ts`
 * mechanically enforces this).
 *
 * `AuditModule` is deliberately NOT imported: it is `@Global()`
 * (`AuditService` is already injectable without it), and this module writes
 * no business audit entry anyway — its one route is an ordinary GET.
 *
 * `SalesModule` and `TreasuryModule` already import each other via
 * `forwardRef()` (P1G-1's bidirectional contract edge). Reporting imports
 * BOTH of them from the top and neither imports Reporting back, so no new
 * circular module dependency is introduced and no `forwardRef()` is needed
 * here.
 *
 * RPT-DEMO-1 — `InventoryModule`, `WorkforceModule`, `KitchenModule` are
 * added for exactly the same reason as the four above: their published
 * `contract/` tokens only (`BRANCH_INVENTORY_SNAPSHOT_QUERY`,
 * `ATTENDANCE_SUMMARY_QUERY`, `KDS_SUMMARY_QUERY`), consumed by
 * `OperationalOverviewService`. None of the three imports Reporting, so no
 * circular dependency is introduced and no `forwardRef()` is needed.
 */
@Module({
  imports: [
    IdentityModule,
    SalesModule,
    TreasuryModule,
    OrganisationModule,
    LocalisationModule,
    InventoryModule,
    WorkforceModule,
    KitchenModule,
  ],
  controllers: [ReportingController],
  providers: [DailyTradingReportService, OperationalOverviewService],
})
export class ReportingModule {}
