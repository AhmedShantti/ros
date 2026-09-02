import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { ProductionModule } from '../production/production.module';
import { SALE_DEPLETION_COMMAND } from './contract/sale-depletion.contract';
import { CountsService } from './counts/counts.service';
import { InventoryController } from './inventory.controller';
import { MovementsService } from './movements/movements.service';
import { TransfersService } from './movements/transfers.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { SaleDepletionService } from './sale-depletion/sale-depletion.service';
import { StockItemsService } from './stock-items/stock-items.service';
import { WasteService } from './waste/waste.service';
import {
  CountLineTargetResolver,
  CountSessionTargetResolver,
} from './counts/scope-target.resolvers';
import {
  INVENTORY_COUNT_LINE_TARGET_RESOLVER,
  INVENTORY_COUNT_SESSION_TARGET_RESOLVER,
} from './contract';
import { OrganisationModule } from '../organisation/organisation.module';

/**
 * Inventory bounded context (D-INV-01 … D-INV-09, B-1, B-2).
 *
 * Reuses the existing guard chain and the existing tamper-evident audit writer.
 * Neither is modified: no new tenant-context mechanism, no parallel audit
 * system, no scheduler, no outbox, no Governance workflow.
 */
@Module({
  // FR-MNU-046: a valuation change must recompute the recipe costs that depend
  // on it. The dependency is one narrow port (RECIPE_COST_RECOMPUTER), not a
  // reach into Production internals, and Production imports nothing back.
  imports: [IdentityModule, AuditModule, ProductionModule, OrganisationModule],
  controllers: [InventoryController],
  providers: [
    // B1-3 resource-derived authorization targets. They answer "which location
    // does this row belong to?"; Organisation answers what that location is.
    CountSessionTargetResolver,
    {
      provide: INVENTORY_COUNT_SESSION_TARGET_RESOLVER,
      useExisting: CountSessionTargetResolver,
    },
    CountLineTargetResolver,
    {
      provide: INVENTORY_COUNT_LINE_TARGET_RESOLVER,
      useExisting: CountLineTargetResolver,
    },
    StockItemsService,
    MovementsService,
    TransfersService,
    CountsService,
    WasteService,
    ReconciliationService,
    // P1F-2 — the SALE_DEPLETION_COMMAND public contract (Order Completion).
    SaleDepletionService,
    { provide: SALE_DEPLETION_COMMAND, useExisting: SaleDepletionService },
  ],
  exports: [
    StockItemsService,
    MovementsService,
    TransfersService,
    CountsService,
    WasteService,
    ReconciliationService,
    SALE_DEPLETION_COMMAND,
  ],
})
export class InventoryModule {}
