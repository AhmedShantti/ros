import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  BranchLocationsQuery,
  BranchLocationsQueryInput,
} from '../contract/branch-locations.query';

/**
 * PRIVATE Prisma-backed implementation of `BranchLocationsQuery`
 * (`organisation/contract/branch-locations.query.ts`). Bound to
 * `BRANCH_LOCATIONS_QUERY` only inside `OrganisationModule` (`useExisting`)
 * — never imported directly by a consumer.
 */
@Injectable()
export class BranchLocationsQueryService implements BranchLocationsQuery {
  async listLocationIds(
    tx: Prisma.TransactionClient,
    input: BranchLocationsQueryInput,
  ): Promise<readonly string[]> {
    const rows = await tx.location.findMany({
      where: { tenantId: input.tenantId, branchId: input.branchId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
