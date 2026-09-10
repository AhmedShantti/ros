import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PROCUREMENT_FACTS_QUERY } from './contract';
import { ProcurementController } from './procurement.controller';
import { ProcurementFactsQueryService } from './procurement-facts.query.service';
import { PricingService } from './pricing/pricing.service';
import { SourcingService } from './sourcing/sourcing.service';
import { SuppliersService } from './suppliers/suppliers.service';

/**
 * Procurement bounded context (FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1) —
 * Supplier master, Supplier<->StockItem sourcing, and Supplier price lists
 * (FR-PRC-005/006/007/008 [partial], FR-INV-005). No Purchase Order, no
 * Goods Receipt, no Supplier Invoice (mission brief §19 scope fence).
 *
 * `IdentityModule` is imported ONLY for the cross-cutting HTTP/auth guard
 * chain and decorators published as `identity/contract`'s `http.ts`/
 * `authorization-target.ts` — never a private Identity path.
 * `InventoryModule` is imported ONLY for `STOCK_ITEM_PURCHASING_FACTS_QUERY`
 * (`inventory/contract/purchasing-facts.query.ts`) — Procurement never
 * queries `inventory.*` tables or imports an Inventory private path.
 * `AuditModule` is deliberately NOT imported: it is `@Global()`, so
 * `AuditService` (reached here only via `governance/contract`) is already
 * injectable without it — see `module-boundaries.spec.ts`'s zero-deviation
 * precedent (Kitchen, Reporting).
 *
 * `module-boundaries.spec.ts` KNOWN_DEVIATIONS gains ZERO new entries for
 * `procurement`.
 */
@Module({
  imports: [IdentityModule, InventoryModule],
  controllers: [ProcurementController],
  providers: [
    SuppliersService,
    SourcingService,
    PricingService,
    ProcurementFactsQueryService,
    {
      provide: PROCUREMENT_FACTS_QUERY,
      useExisting: ProcurementFactsQueryService,
    },
  ],
  exports: [
    SuppliersService,
    SourcingService,
    PricingService,
    PROCUREMENT_FACTS_QUERY,
  ],
})
export class ProcurementModule {}
