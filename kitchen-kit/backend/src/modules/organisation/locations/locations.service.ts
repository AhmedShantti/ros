import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { LocationType, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LocationSummary, toLocationSummary } from './location.view';

/**
 * The unified location registry (`org.locations`) — P15-2 of the frozen
 * Inventory Design Gate (blocker C-02, Decision A).
 *
 * WHY IT EXISTS: Inventory keys its ledger, batches, level projections, counts
 * and waste on a location that may be a Branch, a Warehouse or a Central
 * Kitchen — three separate Phase 15 tables. Inventory needs ONE non-null,
 * FK-able location identity, because `inventory.stock_levels` will carry
 * PRIMARY KEY (stock_item_id, location_id) and PostgreSQL forbids nullable
 * primary-key columns. A nullable typed triple could not have served.
 *
 * WHAT IT IS NOT: a replacement for those entities. Branch, Warehouse and
 * CentralKitchen remain authoritative for all of their own domain data; a
 * location row holds no domain attributes, only identity and linkage.
 *
 * INTEGRITY: the tenant boundary is structural — three composite FKs
 * (tenant_id, <typed id>) plus the `ck_location_target` CHECK, which enforces
 * XOR across the typed columns, agreement with `location_type`, and that
 * `ref_id` equals whichever typed column is set.
 */
@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a location for a newly created org entity.
   *
   * MUST be called inside the parent's own `withAuthContext` transaction, so
   * the registry row and the entity commit or roll back together — the entity
   * can never exist without its location.
   *
   * Idempotent: the (tenant_id, location_type, ref_id) key makes a repeated
   * registration a no-op rather than a duplicate.
   */
  async register(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationType: LocationType,
    refId: string,
  ): Promise<void> {
    await tx.location.createMany({
      data: [
        {
          id: newId(),
          tenantId,
          locationType,
          refId,
          branchId: locationType === 'branch' ? refId : null,
          warehouseId: locationType === 'warehouse' ? refId : null,
          centralKitchenId: locationType === 'central_kitchen' ? refId : null,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** All locations in the acting tenant. Read-only reference data. */
  list(tenantId: string): Promise<LocationSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.location.findMany({ orderBy: { createdAt: 'asc' } }),
      )
      .then((rows) => rows.map(toLocationSummary));
  }

  /**
   * Resolve the registry row for a concrete org entity. Cross-tenant rows are
   * invisible under RLS, so a foreign ref yields 404 rather than 403.
   */
  async findByRef(
    tenantId: string,
    locationType: LocationType,
    refId: string,
  ): Promise<LocationSummary> {
    const location = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.location.findUnique({
        where: {
          tenantId_locationType_refId: { tenantId, locationType, refId },
        },
      }),
    );
    if (!location) {
      throw new NotFoundException('Location not found.');
    }
    return toLocationSummary(location);
  }
}
