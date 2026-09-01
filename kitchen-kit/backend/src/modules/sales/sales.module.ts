import { Module, forwardRef } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LocalisationModule } from '../localisation/localisation.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { ProductionModule } from '../production/production.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { CashSessionTenderTotalsQueryService } from './orders/cash-session-tender-totals.query.service';
import { DailyTradingSalesQueryService } from './orders/daily-trading-sales.query.service';
import { DayCloseSalesFactsQueryService } from './orders/day-close-sales-facts.query.service';
import {
  CASH_SESSION_TENDER_TOTALS_QUERY,
  DAILY_TRADING_SALES_QUERY,
  DAY_CLOSE_SALES_FACTS_QUERY,
} from './contract';
import { OrderLinesService } from './orders/order-lines.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { SalesFireService } from './orders/sales-fire.service';
import { SalesPaymentService } from './orders/sales-payment.service';
import { TicketBumpedHandler } from './orders/ticket-bumped.handler';
import { TicketRecalledHandler } from './orders/ticket-recalled.handler';
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
 * (`POST /orders/{businessDay}/{id}/fire`).
 *
 * PUBLIC SURFACE, P1F-1/P1F-2 addition: CASH / manual-external-card Payment
 * capture (`POST /orders/{businessDay}/{id}/payments`). A SETTLING payment
 * (one that brings paid_total to grand_total) atomically COMPLETES the
 * order in the same transaction — recipe expansion, dual-axis Inventory
 * depletion, COGS posting, and the `completed` CAS — via `UnitOfWork`, the
 * `SalesFireService` precedent. `TreasuryModule` is imported for ONE
 * published contract query — `CASH_SESSION_FACTS_QUERY` from
 * `modules/treasury/contract` (P1D-G attribution). `InventoryModule` is
 * imported for ONE published contract command —
 * `SALE_DEPLETION_COMMAND` from `modules/inventory/contract` — the first
 * `sales -> inventory` edge.
 *
 * STILL UNEXPOSED: refund — it must drive fiscal documents and drawer
 * attribution; neither exists, and a state flip would misrepresent both.
 *
 * P1G-1 migration 34 makes this edge BIDIRECTIONAL: CashSession Close (in
 * Treasury) needs Sales' cash/rounding tender totals (FR-FIN-004/010),
 * published as `CASH_SESSION_TENDER_TOTALS_QUERY` in `sales/contract`
 * (Sales' first published QUERY). `TreasuryModule` now also imports
 * `SalesModule` — a genuine module-level circular import, resolved with
 * NestJS's own `forwardRef()` on BOTH sides (there is no circular PROVIDER
 * dependency: `SalesPaymentService` depends on Treasury's
 * `CASH_SESSION_FACTS_QUERY` token, and a future Treasury close service
 * depends on this module's `CASH_SESSION_TENDER_TOTALS_QUERY` token — two
 * distinct tokens, never a class depending on itself through the cycle).
 * This is the smallest correct NestJS resolution for two modules that must
 * consume each other's published `contract/`; the contract design itself
 * (Sales owns tender totals, Treasury only ever reaches them through
 * `sales/contract`) is unchanged.
 *
 * Minimum Operational Reporting (RPT-R1/R2/R3, governance register
 * "Minimum Operational Reporting Ratification — 2026-08-31") adds Sales'
 * SECOND published `contract/` query, `DAILY_TRADING_SALES_QUERY` — the
 * completed-sales/tender/tax-by-class/session-span facts the `reporting`
 * module's daily-trading route composes. `reporting` imports ONLY this
 * token and `SalesModule` for DI composition, never a private Sales path.
 */
@Module({
  imports: [
    IdentityModule,
    AuditModule,
    LocalisationModule,
    CatalogueModule,
    OrganisationModule,
    ProductionModule,
    // P1F-1 — the FIRST sales->treasury edge, consumed only through
    // `treasury/contract`'s `CASH_SESSION_FACTS_QUERY`. P1G-1 makes the
    // edge bidirectional (see the module docblock) — `forwardRef` required.
    forwardRef(() => TreasuryModule),
    // P1F-2 — the FIRST sales->inventory edge, consumed only through
    // `inventory/contract`'s `SALE_DEPLETION_COMMAND`.
    InventoryModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderLinesService,
    SalesFireService,
    SalesPaymentService,
    // KDS operator lifecycle (KDS-R11/KDS-R12) — PRIVATE subscribers, never
    // exported, discovered purely via `@DomainEventHandler` metadata
    // (`DomainEventHandlerRegistry`'s `DiscoveryService` scan), exactly the
    // `OrderLineFiredHandler` precedent in the opposite direction. Import
    // ONLY `kitchen/contract` — never a Kitchen private path or table.
    TicketBumpedHandler,
    TicketRecalledHandler,
    CashSessionTenderTotalsQueryService,
    {
      provide: CASH_SESSION_TENDER_TOTALS_QUERY,
      useExisting: CashSessionTenderTotalsQueryService,
    },
    // Minimum Operational Reporting (RPT-R1/R2/R3) — Sales' SECOND published
    // `contract/` query, consumed only by the `reporting` module.
    DailyTradingSalesQueryService,
    {
      provide: DAILY_TRADING_SALES_QUERY,
      useExisting: DailyTradingSalesQueryService,
    },
    // Migration 35 (DayClose) — Sales' THIRD published `contract/` query,
    // consumed only by Treasury's `day-close/day-close.service.ts`.
    DayCloseSalesFactsQueryService,
    {
      provide: DAY_CLOSE_SALES_FACTS_QUERY,
      useExisting: DayCloseSalesFactsQueryService,
    },
    // Domain errors are plain Errors so the pure layers stay free of HTTP; this
    // maps them onto the Problem Details statuses SRS 26 specifies.
    { provide: APP_FILTER, useClass: SalesDomainExceptionFilter },
  ],
  exports: [
    OrdersService,
    OrderLinesService,
    CASH_SESSION_TENDER_TOTALS_QUERY,
    DAILY_TRADING_SALES_QUERY,
    DAY_CLOSE_SALES_FACTS_QUERY,
  ],
})
export class SalesModule {}
