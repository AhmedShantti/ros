import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { AuditModule } from './modules/governance/audit/audit.module';
import { IdentityModule } from './modules/identity/identity.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ProductionModule } from './modules/production/production.module';
import { OrganisationModule } from './modules/organisation/organisation.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail fast at boot if required secrets/vars are missing or malformed.
      validate: validateEnv,
    }),
    PrismaModule,
    // Governance audit trail — global, cross-cutting; consumed by identity.
    AuditModule,
    HealthModule,
    // Identity bounded context (users, credentials, auth, sessions, tenants,
    // rbac, terminals) — grown incrementally from Phase 2 onwards.
    IdentityModule,
    // Organisation bounded context (Phase 15) — brands, branches, warehouses,
    // central kitchens, stations, tables, hours and routing configuration.
    OrganisationModule,
    // Catalogue bounded context (Phase 16) — menus, categories, sellable items,
    // variants, modifiers, price lists and availability configuration.
    CatalogueModule,
    // Inventory bounded context — stock item master, the append-only movement
    // ledger, level projections, counting, waste and reorder configuration.
    InventoryModule,
    ProductionModule,
  ],
})
export class AppModule {}
