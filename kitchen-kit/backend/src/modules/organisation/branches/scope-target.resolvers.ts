import { Injectable } from '@nestjs/common';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';
import { Prisma } from '../../../generated/prisma/client';

/**
 * PRIVATE Prisma-backed `ScopeTargetResolver` implementations for
 * Organisation's resource-derived authorization targets
 * (`organisation/contract/scope-target.resolvers.ts`). Bound to their tokens
 * only inside `OrganisationModule` — never imported directly by a consumer.
 *
 * Every one of these runs inside the CALLER's RLS transaction, so a row
 * belonging to another tenant is invisible and the resolver returns `null`.
 * `null` is not a refusal with a reason attached: the guard defers to the
 * route's own tenant-safe 404, which is byte-identical for "another tenant's"
 * and "does not exist" (brief §6).
 *
 * None of these may EVER widen. Where an owning branch exists but cannot be
 * read, the answer is `null`, never a TENANT target — a TENANT target is
 * satisfied only by a tenant-wide grant, but returning one for a branch-owned
 * resource would misdescribe what the operation touches.
 */
@Injectable()
export class StationTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const stationId = input.keys.stationId;
    if (!stationId) return null;
    const station = await tx.station.findUnique({
      where: { id: stationId },
      select: { branchId: true },
    });
    return station ? { type: 'branch', branchId: station.branchId } : null;
  }
}

@Injectable()
export class TableTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const tableId = input.keys.tableId;
    if (!tableId) return null;
    const table = await tx.branchTable.findUnique({
      where: { id: tableId },
      select: { branchId: true },
    });
    return table ? { type: 'branch', branchId: table.branchId } : null;
  }
}

@Injectable()
export class WarehouseTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const warehouseId = input.keys.warehouseId;
    if (!warehouseId) return null;
    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { branchId: true },
    });
    if (!warehouse) return null;
    return warehouse.branchId === null
      ? { type: 'tenant' }
      : { type: 'branch', branchId: warehouse.branchId };
  }
}

@Injectable()
export class LocationTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const locationId = input.keys.locationId;
    if (!locationId) return null;
    const location = await tx.location.findUnique({
      where: { id: locationId },
      select: {
        branchId: true,
        warehouseId: true,
        centralKitchenId: true,
      },
    });
    if (!location) return null;

    if (location.branchId !== null) {
      return { type: 'branch', branchId: location.branchId };
    }
    if (location.warehouseId !== null) {
      // A branch-owned warehouse is that branch's stock; a standalone one is
      // the tenant's.
      const warehouse = await tx.warehouse.findUnique({
        where: { id: location.warehouseId },
        select: { branchId: true },
      });
      if (!warehouse) return null;
      return warehouse.branchId === null
        ? { type: 'tenant' }
        : { type: 'branch', branchId: warehouse.branchId };
    }
    // A central kitchen is tenant-level by construction (ADR 0009 D-02), so
    // TENANT is its true owning scope, not a widening fallback.
    return { type: 'tenant' };
  }
}
