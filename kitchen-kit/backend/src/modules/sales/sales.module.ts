import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { LocalisationModule } from '../localisation/localisation.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { ProductionModule } from '../production/production.module';
import { OrderLinesService } from './orders/order-lines.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { SalesFireService } from './orders/sales-fire.service';
import { SalesDomainExceptionFilter } from './sales-domain-exception.filter';

/**
 * Sales bounded context.
 *
 * PUBLIC SURFACE: open an order, read orders, capture a line, void a PRE-FIRE
 * line. Every financially significant value on those routes is server-derived —
 * the branch from the terminal's registration, the business day from the
 * branch's FR-FIN-024 cutover, `country_pack_version` from the signed pack in
 * force (FR-LOC-021), the price from the canonical `PriceResolutionService`, the
 * tax from the pinned pack's engine, and the cost from the recipe under each
 * component's own costing method.
 *
 * The imports are the six contexts a truthful BR-POS-004 snapshot / Fire
 * command need: Catalogue for price, item identity, and (P1E-6) Fire-time
 * category/kitchen-name facts (`catalogue/contract`'s
 * `CATALOGUE_FIRE_FACTS_QUERY`); Localisation for the pack and the tax class;
 * Production for the recipe version and its cost; Organisation (P1E-6) for
 * the dine-in Table display fact (`organisation/contract`'s
 * `TABLE_DISPLAY_QUERY`); Identity for the POS session; Governance for the
 * audit chain. Nothing is duplicated here — this module orchestrates, it
 * does not re-derive.
 *
 * PUBLIC SURFACE, P1E-6 addition: explicit Fire
 * (`POST /orders/{businessDay}/{id}/fire`). STILL UNEXPOSED: complete,
 * payment and refund — completion must drive fiscal documents, inventory
 * depletion, COGS posting and drawer attribution; none of those exist, and a
 * state flip would misrepresent all of them.
 */
@Module({
  imports: [
    IdentityModule,
    AuditModule,
    LocalisationModule,
    CatalogueModule,
    OrganisationModule,
    ProductionModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderLinesService,
    SalesFireService,
    // Domain errors are plain Errors so the pure layers stay free of HTTP; this
    // maps them onto the Problem Details statuses SRS 26 specifies.
    { provide: APP_FILTER, useClass: SalesDomainExceptionFilter },
  ],
  exports: [OrdersService, OrderLinesService],
})
export class SalesModule {}
