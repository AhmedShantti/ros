import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  BranchInventorySnapshotFacts,
  BranchInventorySnapshotQuery,
  BranchInventorySnapshotQueryInput,
} from '../contract/branch-inventory-snapshot.query';

/**
 * PRIVATE Prisma-backed implementation of `BranchInventorySnapshotQuery`
 * (`inventory/contract/branch-inventory-snapshot.query.ts`). Bound to
 * `BRANCH_INVENTORY_SNAPSHOT_QUERY` only inside `InventoryModule`
 * (`useExisting`) — never imported directly by a consumer.
 */
@Injectable()
export class BranchInventorySnapshotQueryService implements BranchInventorySnapshotQuery {
  async forLocations(
    tx: Prisma.TransactionClient,
    input: BranchInventorySnapshotQueryInput,
  ): Promise<BranchInventorySnapshotFacts> {
    if (input.locationIds.length === 0) {
      return {
        lowStockItemCount: 0,
        wasteRecordCount: 0,
        wasteQuantityTotal: '0',
        wasteValueTotal: 0n,
      };
    }
    const locationIds = [...input.locationIds];

    // FR-INV-066 — mirrors ReconciliationService.lowStock's comparison,
    // scoped to this branch's own location(s).
    const [configs, levels] = await Promise.all([
      tx.stockItemReorderConfig.findMany({
        where: {
          tenantId: input.tenantId,
          locationId: { in: locationIds },
          reorderPoint: { not: null },
        },
        select: { stockItemId: true, locationId: true, reorderPoint: true },
      }),
      tx.stockLevel.findMany({
        where: { tenantId: input.tenantId, locationId: { in: locationIds } },
        select: { stockItemId: true, locationId: true, quantityOnHand: true },
      }),
    ]);
    const key = (stockItemId: string, locationId: string) =>
      `${stockItemId}:${locationId}`;
    const onHandByKey = new Map(
      levels.map((l) => [key(l.stockItemId, l.locationId), l.quantityOnHand]),
    );
    const lowStockItemCount = configs.filter((c) => {
      const onHand = onHandByKey.get(key(c.stockItemId, c.locationId));
      const onHandValue = onHand ? Number(onHand) : 0;
      // reorderPoint is guaranteed non-null by the `where` clause above.
      return onHandValue < Number(c.reorderPoint);
    }).length;

    // Waste — a CALENDAR window on `recordedAt`, deliberately NOT a business
    // day (`waste_records` carries no business-day column).
    const wasteRecords = await tx.wasteRecord.findMany({
      where: {
        tenantId: input.tenantId,
        locationId: { in: locationIds },
        recordedAt: { gte: input.wasteFrom, lt: input.wasteTo },
      },
      select: { totalValue: true, lines: { select: { quantity: true } } },
    });
    let wasteQuantityTotal = 0;
    let wasteValueTotal = 0n;
    for (const record of wasteRecords) {
      wasteValueTotal += record.totalValue;
      for (const line of record.lines) {
        wasteQuantityTotal += Number(line.quantity);
      }
    }

    return {
      lowStockItemCount,
      wasteRecordCount: wasteRecords.length,
      wasteQuantityTotal: wasteQuantityTotal.toString(),
      wasteValueTotal,
    };
  }
}
