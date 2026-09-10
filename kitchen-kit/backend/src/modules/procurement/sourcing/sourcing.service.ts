import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import {
  STOCK_ITEM_PURCHASING_FACTS_QUERY,
  type StockItemPurchasingFactsQuery,
} from '../../inventory/contract';
import type {
  CreateSupplierItemLinkDto,
  UpdateSupplierItemLinkDto,
} from '../procurement.dto';
import { rethrowAsConflict } from '../procurement-errors';

/**
 * FR-PRC-007 / FR-INV-005 — Supplier <-> StockItem sourcing.
 *
 * `stockItemId` is validated tenant-safe + existing through Inventory's
 * published `STOCK_ITEM_PURCHASING_FACTS_QUERY` contract — never a private
 * Inventory import or a direct `inventory.stock_items` query.
 */
@Injectable()
export class SourcingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STOCK_ITEM_PURCHASING_FACTS_QUERY)
    private readonly purchasingFacts: StockItemPurchasingFactsQuery,
  ) {}

  async createLink(
    tenantId: string,
    actorId: string,
    input: CreateSupplierItemLinkDto,
  ) {
    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const supplier = await tx.supplier.findUnique({
            where: { id: input.supplierId },
          });
          if (!supplier) throw new NotFoundException('Supplier not found.');

          const facts = await this.purchasingFacts.find(tx, {
            tenantId,
            stockItemId: input.stockItemId,
          });
          if (!facts) throw new NotFoundException('Stock item not found.');

          const link = await tx.supplierItemLink.create({
            data: {
              id: newId(),
              tenantId,
              supplierId: input.supplierId,
              stockItemId: input.stockItemId,
              supplierItemCode: input.supplierItemCode ?? null,
              supplierBarcodes: input.supplierBarcodes ?? [],
              preferenceRank: input.preferenceRank ?? 0,
            },
          });

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.SUPPLIER_ITEM_LINK_CREATED,
            entityType: AUDIT_ENTITY.SUPPLIER_ITEM_LINK,
            actorType: 'user',
            actorId,
            entityId: link.id,
            metadata: {
              supplierId: input.supplierId,
              stockItemId: input.stockItemId,
            },
          });

          return link;
        },
      );
    } catch (err) {
      rethrowAsConflict(
        err,
        'This supplier is already linked to this stock item.',
      );
    }
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    input: UpdateSupplierItemLinkDto,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.supplierItemLink.findUnique({
          where: { id },
        });
        if (!existing) {
          throw new NotFoundException('Sourcing link not found.');
        }

        const updated = await tx.supplierItemLink.update({
          where: { id },
          data: {
            supplierItemCode: input.supplierItemCode,
            supplierBarcodes: input.supplierBarcodes,
            preferenceRank: input.preferenceRank,
            isActive: input.isActive,
          },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.SUPPLIER_ITEM_LINK_UPDATED,
          entityType: AUDIT_ENTITY.SUPPLIER_ITEM_LINK,
          actorType: 'user',
          actorId,
          entityId: updated.id,
          metadata: {
            preferenceRank: updated.preferenceRank,
            isActive: updated.isActive,
          },
        });

        return updated;
      },
    );
  }

  async listForSupplier(
    tenantId: string,
    actorId: string,
    supplierId: string,
    filter?: { isActive?: boolean },
  ) {
    return this.prisma.withAuthContext({ userId: actorId, tenantId }, (tx) =>
      tx.supplierItemLink.findMany({
        where: {
          supplierId,
          isActive: filter?.isActive,
        },
        orderBy: [{ preferenceRank: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async listForStockItem(
    tenantId: string,
    actorId: string,
    stockItemId: string,
    filter?: { isActive?: boolean },
  ) {
    return this.prisma.withAuthContext({ userId: actorId, tenantId }, (tx) =>
      tx.supplierItemLink.findMany({
        where: {
          stockItemId,
          isActive: filter?.isActive,
        },
        orderBy: [{ preferenceRank: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }
}
