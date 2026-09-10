import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type {
  EffectiveSupplierPriceFacts,
  ProcurementFactsQuery,
  SupplierFacts,
  SupplierItemSourcingFacts,
  VolumeTierFacts,
} from './contract/procurement-facts.query';

/**
 * Private implementation of `PROCUREMENT_FACTS_QUERY`
 * (`procurement/contract/procurement-facts.query.ts`). Bound to the token in
 * `ProcurementModule`; the future Purchase Order slice never imports this
 * class directly.
 */
@Injectable()
export class ProcurementFactsQueryService implements ProcurementFactsQuery {
  async getSupplierFacts(
    tx: Prisma.TransactionClient,
    input: { readonly tenantId: string; readonly supplierId: string },
  ): Promise<SupplierFacts | null> {
    const supplier = await tx.supplier.findUnique({
      where: { id: input.supplierId },
      select: {
        id: true,
        code: true,
        legalName: true,
        tradingName: true,
        status: true,
        currency: true,
        paymentTermsNetDays: true,
      },
    });
    if (!supplier) return null;
    return supplier;
  }

  async getSupplierItemSourcing(
    tx: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly supplierId: string;
      readonly stockItemId: string;
    },
  ): Promise<SupplierItemSourcingFacts | null> {
    const link = await tx.supplierItemLink.findFirst({
      where: { supplierId: input.supplierId, stockItemId: input.stockItemId },
      select: {
        id: true,
        supplierId: true,
        stockItemId: true,
        supplierItemCode: true,
        supplierBarcodes: true,
        preferenceRank: true,
        isActive: true,
      },
    });
    if (!link) return null;
    return {
      supplierItemLinkId: link.id,
      supplierId: link.supplierId,
      stockItemId: link.stockItemId,
      supplierItemCode: link.supplierItemCode,
      supplierBarcodes: link.supplierBarcodes,
      preferenceRank: link.preferenceRank,
      isActive: link.isActive,
    };
  }

  async getEffectivePrice(
    tx: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly supplierItemLinkId: string;
      readonly purchaseUnitId: string;
      readonly at: Date;
    },
  ): Promise<EffectiveSupplierPriceFacts | null> {
    const entry = await tx.supplierPriceEntry.findFirst({
      where: {
        supplierItemLinkId: input.supplierItemLinkId,
        purchaseUnitId: input.purchaseUnitId,
        validFrom: { lte: input.at },
        OR: [{ validUntil: null }, { validUntil: { gt: input.at } }],
      },
    });
    if (!entry) return null;
    return {
      priceEntryId: entry.id,
      purchaseUnitId: entry.purchaseUnitId,
      packSize: entry.packSize.toString(),
      unitPrice: entry.unitPrice.toString(),
      currency: entry.currency,
      validFrom: entry.validFrom.toISOString(),
      validUntil: entry.validUntil ? entry.validUntil.toISOString() : null,
      volumeTiers: (entry.volumeTiers ?? null) as VolumeTierFacts[] | null,
    };
  }
}
