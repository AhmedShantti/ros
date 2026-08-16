import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { CountsService } from './counts/counts.service';
import { InventoryController } from './inventory.controller';
import { MovementsService } from './movements/movements.service';
import { TransfersService } from './movements/transfers.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { StockItemsService } from './stock-items/stock-items.service';
import { WasteService } from './waste/waste.service';

/**
 * Inventory bounded context (D-INV-01 … D-INV-09, B-1, B-2).
 *
 * Reuses the existing guard chain and the existing tamper-evident audit writer.
 * Neither is modified: no new tenant-context mechanism, no parallel audit
 * system, no scheduler, no outbox, no Governance workflow.
 */
@Module({
  imports: [IdentityModule, AuditModule],
  controllers: [InventoryController],
  providers: [
    StockItemsService,
    MovementsService,
    TransfersService,
    CountsService,
    WasteService,
    ReconciliationService,
  ],
  exports: [
    StockItemsService,
    MovementsService,
    TransfersService,
    CountsService,
    WasteService,
    ReconciliationService,
  ],
})
export class InventoryModule {}
