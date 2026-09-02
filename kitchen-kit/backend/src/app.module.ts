import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { AuditModule } from './modules/governance/audit/audit.module';
import { GovernanceModule } from './modules/governance/governance.module';
import { IdentityModule } from './modules/identity/identity.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LocalisationModule } from './modules/localisation/localisation.module';
import { ProductionModule } from './modules/production/production.module';
import { OrganisationModule } from './modules/organisation/organisation.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { DomainEventsModule } from './common/domain-events/domain-events.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { SalesModule } from './modules/sales/sales.module';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { WorkforceModule } from './modules/workforce/workforce.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { PrismaModule } from './prisma/prisma.module';
import { SyncModule } from './modules/sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail fast at boot if required secrets/vars are missing or malformed.
      validate: validateEnv,
    }),
    PrismaModule,
    // SRS §27.6 observability foundation (G1-3) — structured logging, RED
    // metrics, correlation/causation context. Imported early/globally so
    // every downstream module's routes are observed automatically.
    ObservabilityModule,
    // SRS §5.5.2 transaction-aware domain-event foundation (P1E-1). No
    // business event is published yet; see the module's own docblock.
    DomainEventsModule,
    IdempotencyModule,
    SalesModule,
    // Governance audit trail — global, cross-cutting; consumed by identity.
    AuditModule,
    // Governance bounded context — the general Approval mechanism (migration
    // 32, FR-SEC-030..033). No HTTP surface; consumed only via
    // `governance/contract`.
    GovernanceModule,
    HealthModule,
    // Identity bounded context (users, credentials, auth, sessions, tenants,
    // rbac, terminals) — grown incrementally from Phase 2 onwards.
    IdentityModule,
    // Organisation bounded context (Phase 15) — brands, branches, warehouses,
    // central kitchens, stations, tables, hours and routing configuration.
    OrganisationModule,
    // Kitchen Ops bounded context (P1E-3/P1E-5) — routing resolution and
    // Ticket/TicketLine persistence. No controller yet: Fire (the only
    // producer of `order.line.fired`) is not implemented.
    KitchenModule,
    // Catalogue bounded context (Phase 16) — menus, categories, sellable items,
    // variants, modifiers, price lists and availability configuration.
    CatalogueModule,
    // Inventory bounded context — stock item master, the append-only movement
    // ledger, level projections, counting, waste and reorder configuration.
    InventoryModule,
    ProductionModule,
    // Localisation bounded context (SRS ch.22) - signed, versioned Country
    // Packs and the registered tax-engine strategies they select. No
    // controller: tax computation is internal domain behaviour.
    LocalisationModule,
    // Workforce bounded context - the MINIMAL Operational Shift authorised by
    // carried item P1D-A. Schedule, attendance and payroll stay deferred.
    WorkforceModule,
    // Treasury bounded context - Drawer and CashSession OPEN (FR-FIN-001/002,
    // FR-POS-090). No close, no counting, no variance, no day close.
    TreasuryModule,
    // Reporting bounded context (RPT-R1/R2/R3) — the Internal-MVP branch
    // daily-trading read surface. Zero tables, zero migrations; reaches
    // every fact through Sales/Treasury/Organisation/Localisation's own
    // published contract/ tokens.
    ReportingModule,
    // Offline/Sync bounded context (D4-1A, migration 37) — the protocol kernel
    // behind POST /v1/sync/batch: operation dedup, history, crash-recoverable
    // batch reservation, HLC, causal ordering and per-operation failure
    // isolation. Ships ZERO domain operation handlers by design; domains attach
    // in D4-1B via `@SyncOperationHandlerFor`.
    SyncModule,
  ],
})
export class AppModule {}
