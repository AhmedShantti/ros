import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import {
  STOCK_ITEM_PURCHASING_FACTS_QUERY,
  type StockItemPurchasingFactsQuery,
} from '../../inventory/contract';
import {
  BRANCH_BRAND_QUERY,
  LOCATION_FACTS_QUERY,
  type BranchBrandQuery,
  type LocationFactsQuery,
} from '../../organisation/contract';
import {
  PROCUREMENT_FACTS_QUERY,
  type ProcurementFactsQuery,
} from '../contract';
import type { PurchaseOrderLineDto } from '../procurement.dto';
import { computeLineTotals } from './po-totals';

export interface BuiltPurchaseOrderLine {
  readonly id: string;
  readonly stockItemId: string;
  readonly purchaseUnitId: string;
  readonly quantity: Prisma.Decimal;
  readonly attributionBranchId: string;
  readonly sourceRequisitionLineId: string | null;
  readonly supplierPriceEntryId: string | null;
  readonly unitPriceMinor: bigint;
  readonly netAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
  readonly lineTotalMinor: bigint;
}

/**
 * FR-PRC-016/017 — the one place a PurchaseOrderLine is built and validated,
 * shared by `purchase-orders.service.ts` (create/update) and
 * `purchase-order-amendment.service.ts` (amend), so the two never drift.
 *
 * Reuses Procurement's OWN published `PROCUREMENT_FACTS_QUERY` contract for
 * supplier/sourcing/price facts (mission brief §0: "Existing:
 * PROCUREMENT_FACTS_QUERY... use/advance where already supported") rather
 * than re-injecting `SuppliersService`/`SourcingService`/`PricingService`
 * directly — narrower surface, and exactly what that contract was published
 * for (its own doc comment names "the future Purchase Order slice").
 */
@Injectable()
export class PurchaseOrderLineBuilder {
  constructor(
    @Inject(STOCK_ITEM_PURCHASING_FACTS_QUERY)
    private readonly purchasingFacts: StockItemPurchasingFactsQuery,
    @Inject(PROCUREMENT_FACTS_QUERY)
    private readonly procurementFacts: ProcurementFactsQuery,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchFacts: BranchBrandQuery,
    @Inject(LOCATION_FACTS_QUERY)
    private readonly locationFacts: LocationFactsQuery,
  ) {}

  /** FR-PRC-005 §5 — validate the PO's delivery location against
   *  Organisation's unified `org.locations` registry; `locationType` must
   *  agree with what the caller declared. */
  async resolveDeliveryLocation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    deliveryLocationType: 'branch' | 'warehouse' | 'central_kitchen',
    deliveryLocationId: string,
  ): Promise<void> {
    const location = await this.locationFacts.find(tx, {
      tenantId,
      locationId: deliveryLocationId,
    });
    if (!location) {
      throw new NotFoundException(
        `Delivery location ${deliveryLocationId} not found.`,
      );
    }
    if (location.locationType !== deliveryLocationType) {
      throw new BadRequestException(
        `deliveryLocationId ${deliveryLocationId} is a '${location.locationType}' ` +
          `location, not '${deliveryLocationType}'.`,
      );
    }
  }

  /**
   * Build and fully validate one PO line, from a submitted requisition line
   * (mission brief §2 consolidation) or a manual caller-supplied line.
   * `alreadyConsumedRequisitionLineIds` guards against consolidating the
   * SAME requisition line twice within one request (the DB's
   * `uq_po_line_source_requisition_line` index is the ultimate backstop for
   * a genuine cross-request race — see this method's `ConflictException`
   * mapping of a P2002 on that index in the caller).
   */
  async buildLine(
    tx: Prisma.TransactionClient,
    tenantId: string,
    supplierId: string,
    poCurrency: string,
    dto: PurchaseOrderLineDto,
  ): Promise<BuiltPurchaseOrderLine> {
    let stockItemId: string;
    let purchaseUnitId: string;
    let quantity: Prisma.Decimal;
    let attributionBranchId: string;
    let sourceRequisitionLineId: string | null = null;

    if (dto.sourceRequisitionLineId) {
      if (
        dto.stockItemId ||
        dto.purchaseUnitId ||
        dto.quantity ||
        dto.attributionBranchId
      ) {
        throw new BadRequestException(
          'When sourceRequisitionLineId is set, stockItemId/purchaseUnitId/' +
            'quantity/attributionBranchId must not also be supplied — they ' +
            'are taken from the requisition line.',
        );
      }
      const reqLine = await tx.purchaseRequisitionLine.findUnique({
        where: { id: dto.sourceRequisitionLineId },
        include: { requisition: true },
      });
      if (!reqLine) {
        throw new NotFoundException(
          `Requisition line ${dto.sourceRequisitionLineId} not found.`,
        );
      }
      if (reqLine.requisition.status !== 'submitted') {
        throw new UnprocessableEntityException(
          `Requisition line ${dto.sourceRequisitionLineId}'s parent ` +
            `requisition must be 'submitted' (it is ` +
            `'${reqLine.requisition.status}').`,
        );
      }
      const alreadyConsumed = await tx.purchaseOrderLine.findFirst({
        where: { tenantId, sourceRequisitionLineId: reqLine.id },
        select: { id: true },
      });
      if (alreadyConsumed) {
        throw new ConflictException(
          `Requisition line ${dto.sourceRequisitionLineId} has already ` +
            'been consolidated into another purchase order.',
        );
      }
      stockItemId = reqLine.stockItemId;
      purchaseUnitId = reqLine.purchaseUnitId;
      quantity = reqLine.quantity;
      attributionBranchId = reqLine.requisition.requestingBranchId;
      sourceRequisitionLineId = reqLine.id;
    } else {
      if (
        !dto.stockItemId ||
        !dto.purchaseUnitId ||
        !dto.quantity ||
        !dto.attributionBranchId
      ) {
        throw new BadRequestException(
          'A manual purchase order line requires stockItemId, ' +
            'purchaseUnitId, quantity, and attributionBranchId.',
        );
      }
      quantity = new Prisma.Decimal(dto.quantity);
      if (quantity.lte(0)) {
        throw new BadRequestException('Line quantity must be > 0.');
      }
      const branch = await this.branchFacts.findBranchAuthorizationFacts(
        tx,
        dto.attributionBranchId,
      );
      if (!branch) {
        throw new NotFoundException(
          `Branch ${dto.attributionBranchId} not found.`,
        );
      }
      if (!branch.isActive) {
        throw new UnprocessableEntityException(
          `Branch ${dto.attributionBranchId} is not active.`,
        );
      }
      stockItemId = dto.stockItemId;
      purchaseUnitId = dto.purchaseUnitId;
      attributionBranchId = dto.attributionBranchId;
    }

    const itemFacts = await this.purchasingFacts.find(tx, {
      tenantId,
      stockItemId,
    });
    if (!itemFacts || !itemFacts.isActive) {
      throw new NotFoundException(
        `Stock item ${stockItemId} not found or inactive.`,
      );
    }
    if (!itemFacts.purchaseUnits.some((u) => u.id === purchaseUnitId)) {
      throw new BadRequestException(
        `purchaseUnitId ${purchaseUnitId} is not a valid purchase unit for ` +
          `stock item ${stockItemId}.`,
      );
    }

    const sourcing = await this.procurementFacts.getSupplierItemSourcing(tx, {
      tenantId,
      supplierId,
      stockItemId,
    });
    if (!sourcing || !sourcing.isActive) {
      throw new BadRequestException(
        `Supplier ${supplierId} does not actively source stock item ${stockItemId}.`,
      );
    }

    let unitPriceMinor: bigint;
    let supplierPriceEntryId: string | null = null;
    if (dto.unitPrice !== undefined) {
      unitPriceMinor = BigInt(dto.unitPrice);
    } else {
      const price = await this.procurementFacts.getEffectivePrice(tx, {
        tenantId,
        supplierItemLinkId: sourcing.supplierItemLinkId,
        purchaseUnitId,
        at: new Date(),
      });
      if (!price) {
        throw new UnprocessableEntityException(
          `No effective agreed price for supplier ${supplierId} / stock ` +
            `item ${stockItemId} / purchase unit ${purchaseUnitId}. Supply ` +
            'an explicit unitPrice for this line.',
        );
      }
      if (price.currency !== poCurrency) {
        throw new BadRequestException(
          `The effective supplier price is in ${price.currency}, but this ` +
            `purchase order's currency is ${poCurrency}.`,
        );
      }
      unitPriceMinor = BigInt(price.unitPrice);
      supplierPriceEntryId = price.priceEntryId;
    }
    if (unitPriceMinor < 0n) {
      throw new BadRequestException('unitPrice must not be negative.');
    }
    const taxAmountMinor =
      dto.taxAmount !== undefined ? BigInt(dto.taxAmount) : 0n;
    if (taxAmountMinor < 0n) {
      throw new BadRequestException('taxAmount must not be negative.');
    }

    const totals = computeLineTotals({
      unitPriceMinor,
      quantity: quantity.toString(),
      taxAmountMinor,
    });

    return {
      id: newId(),
      stockItemId,
      purchaseUnitId,
      quantity,
      attributionBranchId,
      sourceRequisitionLineId,
      supplierPriceEntryId,
      unitPriceMinor,
      ...totals,
    };
  }

  /** FR-PRC-016 §2 — a requisition becomes `converted` only when EVERY one
   *  of its lines has been consumed by some PurchaseOrderLine. Never
   *  silently half-converted; never reverted once converted (no GoodsReceipt
   *  exists yet to make "un-converting" a meaningful, safe operation). */
  async markRequisitionsConvertedIfComplete(
    tx: Prisma.TransactionClient,
    tenantId: string,
    requisitionIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const requisitionId of requisitionIds) {
      const totalLines = await tx.purchaseRequisitionLine.count({
        where: { tenantId, requisitionId },
      });
      if (totalLines === 0) continue;
      const consumedLines = await tx.purchaseOrderLine.count({
        where: { tenantId, sourceRequisitionLine: { requisitionId } },
      });
      if (consumedLines === totalLines) {
        await tx.purchaseRequisition.updateMany({
          where: { id: requisitionId, status: 'submitted' },
          data: { status: 'converted' },
        });
      }
    }
  }

  /** For a nested `purchaseOrder.create({ data: { lines: { create: [...] } } })`
   *  — the relation supplies `purchaseOrderId` implicitly. */
  toPrismaLineCreateInput(tenantId: string, line: BuiltPurchaseOrderLine) {
    return {
      id: line.id,
      tenantId,
      stockItemId: line.stockItemId,
      purchaseUnitId: line.purchaseUnitId,
      quantity: line.quantity,
      unitPrice: line.unitPriceMinor,
      netAmount: line.netAmountMinor,
      taxAmount: line.taxAmountMinor,
      lineTotal: line.lineTotalMinor,
      supplierPriceEntryId: line.supplierPriceEntryId,
      sourceRequisitionLineId: line.sourceRequisitionLineId,
      attributionBranchId: line.attributionBranchId,
    };
  }

  /** For a bare `purchaseOrderLine.createMany({ data: [...] })` (line
   *  REPLACEMENT on update/amend) — `purchaseOrderId` must be explicit. */
  toPrismaLineCreateManyInput(
    tenantId: string,
    purchaseOrderId: string,
    line: BuiltPurchaseOrderLine,
  ) {
    return {
      ...this.toPrismaLineCreateInput(tenantId, line),
      purchaseOrderId,
    };
  }
}
