import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  StationListItem,
  StationListQuery,
  StationListQueryInput,
} from '../contract/station-list.query';

/**
 * PRIVATE Organisation implementation of `StationListQuery`. `branchId` is
 * filtered explicitly (`Station` carries no `tenant_id` column of its own —
 * tenant scope is inherited through its branch, per `StationsService`'s own
 * docblock); `input.tenantId` exists on this contract only so the shape
 * matches every sibling query (`KdsBranchConfigQueryInput`, `RoutingConfig
 * QueryInput`) and so the caller's `withAuthContext({ tenantId })` — which
 * is what actually keeps this RLS-scoped to the right tenant — has an
 * obvious place to get it from; it is not part of this method's own WHERE.
 */
@Injectable()
export class StationListQueryService implements StationListQuery {
  async listForBranch(
    tx: Prisma.TransactionClient,
    input: StationListQueryInput,
  ): Promise<readonly StationListItem[]> {
    return tx.station.findMany({
      where: { branchId: input.branchId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, displayColour: true },
    });
  }
}
