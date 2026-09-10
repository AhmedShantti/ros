import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  PurchaseUnitFacts,
  StockItemPurchasingFacts,
  StockItemPurchasingFactsQuery,
  StockItemPurchasingFactsQueryInput,
} from '../contract/purchasing-facts.query';

/**
 * FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1 — private implementation of
 * `STOCK_ITEM_PURCHASING_FACTS_QUERY` (`inventory/contract/
 * purchasing-facts.query.ts`). Bound to the token in `InventoryModule`;
 * Procurement never imports this class directly.
 */
@Injectable()
export class StockItemPurchasingFactsQueryService implements StockItemPurchasingFactsQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: StockItemPurchasingFactsQueryInput,
  ): Promise<StockItemPurchasingFacts | null> {
    // RLS scopes this to the caller's own tenant; a cross-tenant id is
    // simply invisible, same as a non-existent one (no existence oracle).
    const item = await tx.stockItem.findUnique({
      where: { id: input.stockItemId },
      select: {
        id: true,
        sku: true,
        isActive: true,
        baseUnitId: true,
        baseUnit: { select: { id: true, code: true } },
        packagingUnits: {
          select: { id: true, name: true, conversionFactorToBase: true },
        },
      },
    });
    if (!item) return null;

    const purchaseUnits: PurchaseUnitFacts[] = [
      {
        id: item.baseUnit.id,
        kind: 'base',
        label: item.baseUnit.code,
        conversionFactorToBase: '1',
      },
      ...item.packagingUnits.map((p) => ({
        id: p.id,
        kind: 'packaging' as const,
        label: p.name,
        conversionFactorToBase: p.conversionFactorToBase.toString(),
      })),
    ];

    return {
      stockItemId: item.id,
      sku: item.sku,
      isActive: item.isActive,
      baseUnitId: item.baseUnitId,
      purchaseUnits,
    };
  }
}
