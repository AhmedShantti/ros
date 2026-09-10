import { Module } from '@nestjs/common';
import { GovernanceModule } from '../governance/governance.module';
import { IdentityModule } from '../identity/identity.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { PROCUREMENT_FACTS_QUERY } from './contract';
import { ProcurementController } from './procurement.controller';
import { ProcurementFactsQueryService } from './procurement-facts.query.service';
import { PricingService } from './pricing/pricing.service';
import { SourcingService } from './sourcing/sourcing.service';
import { SuppliersService } from './suppliers/suppliers.service';
import { RequisitionsController } from './requisitions/requisitions.controller';
import { RequisitionsService } from './requisitions/requisitions.service';
import { PurchaseOrderLineBuilder } from './purchase-orders/purchase-order-line-builder.service';
import { PurchaseOrdersController } from './purchase-orders/purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders/purchase-orders.service';
import { PurchaseOrderApprovalService } from './purchase-orders/purchase-order-approval.service';
import { PurchaseOrderAmendmentService } from './purchase-orders/purchase-order-amendment.service';

/**
 * Procurement bounded context.
 *
 * FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1 — Supplier master, Supplier<->StockItem
 * sourcing, and Supplier price lists (FR-PRC-005/006/007/008 [partial],
 * FR-INV-005).
 *
 * FULL-SRS-PRC-PURCHASE-ORDERS-P2 — Purchase Requisitions, Purchase Orders,
 * Approval (via the EXISTING Governance runtime, never a parallel engine),
 * and Amendments (FR-PRC-015/016/017/018/019/023). New module edges this
 * slice adds:
 *   - `OrganisationModule`, for `BRANCH_BRAND_QUERY` (branch existence/
 *     active-status facts) and `LOCATION_FACTS_QUERY` (delivery-location
 *     validation, §5) — both via `organisation/contract` only.
 *   - `GovernanceModule`, for `APPROVAL_COMMANDS` (§9 manual approval) — NOT
 *     `@Global()`, unlike `AuditModule`, so an explicit import is required
 *     (the same edge `sales.module.ts`'s POS-FIN-1 comment already
 *     documents for Sales's own discount/refund approval).
 *   - `PlatformSettingsModule`, for `EFFECTIVE_SETTING_QUERY` (§7 —
 *     `procurement.po_approval_thresholds`, resolved generically, no new
 *     Platform Settings key registration needed).
 *
 * `GoodsReceipt` does not exist yet (mission brief §22 scope fence); the
 * only seam is `PurchaseOrder.receivingStartedAt`, read but never written by
 * this module.
 */
@Module({
  imports: [
    IdentityModule,
    InventoryModule,
    OrganisationModule,
    GovernanceModule,
    PlatformSettingsModule,
  ],
  controllers: [
    ProcurementController,
    RequisitionsController,
    PurchaseOrdersController,
  ],
  providers: [
    SuppliersService,
    SourcingService,
    PricingService,
    ProcurementFactsQueryService,
    {
      provide: PROCUREMENT_FACTS_QUERY,
      useExisting: ProcurementFactsQueryService,
    },
    RequisitionsService,
    PurchaseOrderLineBuilder,
    PurchaseOrdersService,
    PurchaseOrderApprovalService,
    PurchaseOrderAmendmentService,
  ],
  exports: [
    SuppliersService,
    SourcingService,
    PricingService,
    PROCUREMENT_FACTS_QUERY,
    RequisitionsService,
    PurchaseOrdersService,
  ],
})
export class ProcurementModule {}
