import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { ProductionModule } from '../production/production.module';
import { SALE_DEPLETION_COMMAND } from './contract/sale-depletion.contract';
import { POST_FIRE_VOID_DISPOSITION_COMMAND } from './contract/post-fire-void-disposition.contract';
import { CountsService } from './counts/counts.service';
import { InventoryController } from './inventory.controller';
import { MovementsService } from './movements/movements.service';
import { TransfersService } from './movements/transfers.service';
import { InventoryDailyReconciliationJob } from './reconciliation/daily-reconciliation.job';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { SaleDepletionService } from './sale-depletion/sale-depletion.service';
import { StockItemsService } from './stock-items/stock-items.service';
import { WasteService } from './waste/waste.service';
import { PostFireVoidDispositionService } from './waste/post-fire-void-disposition.service';
import {
  CountLineTargetResolver,
  CountSessionTargetResolver,
} from './counts/scope-target.resolvers';
import {
  INVENTORY_COUNT_LINE_TARGET_RESOLVER,
  INVENTORY_COUNT_SESSION_TARGET_RESOLVER,
} from './contract';
import { OrganisationModule } from '../organisation/organisation.module';
import { PlatformModule } from '../platform/platform.module';

/**
 * Inventory bounded context (D-INV-01 … D-INV-09, B-1, B-2).
 *
 * Reuses the existing guard chain and the existing tamper-evident audit writer.
 * Neither is modified: no new tenant-context mechanism, no parallel audit
 * system, no outbox, no Governance workflow.
 *
 * SCHED-1 — Inventory now registers ONE scheduled job
 * (`InventoryDailyReconciliationJob`) with the platform scheduler substrate. It
 * reaches Platform only through `platform/contract` and `platform.module`, so
 * no module boundary is crossed and no `KNOWN_DEVIATIONS` entry is added.
 * Inventory does not own, start or poll the scheduler; it declares a provider
 * and the substrate discovers it.
 */
@Module({
  // FR-MNU-046: a valuation change must recompute the recipe costs that depend
  // on it. The dependency is one narrow port (RECIPE_COST_RECOMPUTER), not a
  // reach into Production internals, and Production imports nothing back.
  imports: [
    IdentityModule,
    AuditModule,
    ProductionModule,
    OrganisationModule,
    PlatformModule,
  ],
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
    // SCHED-1 — BR-INV-003 / FR-INV-011 / FR-INV-051 daily scheduled
    // reconciliation. Holds NO reconciliation logic of its own; it decides when
    // to run and what to record, and delegates the comparison to
    // `ReconciliationService`.
    InventoryDailyReconciliationJob,
    // P1F-2 — the SALE_DEPLETION_COMMAND public contract (Order Completion).
    SaleDepletionService,
    { provide: SALE_DEPLETION_COMMAND, useExisting: SaleDepletionService },
    // POS-FIN-1 — the POST_FIRE_VOID_DISPOSITION_COMMAND public contract
    // (FR-POS-071 wasted/given-to-staff disposition).
    PostFireVoidDispositionService,
    {
      provide: POST_FIRE_VOID_DISPOSITION_COMMAND,
      useExisting: PostFireVoidDispositionService,
    },
  ],
  exports: [
    StockItemsService,
    MovementsService,
    TransfersService,
    CountsService,
    WasteService,
    ReconciliationService,
    InventoryDailyReconciliationJob,
    SALE_DEPLETION_COMMAND,
    POST_FIRE_VOID_DISPOSITION_COMMAND,
  ],
})
export class InventoryModule {}
