import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  BranchJurisdictionQuery,
  BranchJurisdictionQueryInput,
  BranchJurisdictionResult,
} from '../contract/branch-jurisdiction.query';

/**
 * PRIVATE Prisma-backed implementation of `BranchJurisdictionQuery`
 * (`organisation/contract/branch-jurisdiction.query.ts`). Bound to
 * `BRANCH_JURISDICTION_QUERY` only inside `OrganisationModule`
 * (`useExisting`) — never imported directly by a consumer; see
 * `module-boundaries.spec.ts`'s contract-purity assertions.
 *
 * `org.branches` carries a real `tenant_id` and is RLS-protected; the
 * caller's `Prisma.TransactionClient` is already inside a tenant-scoped
 * `withAuthContext` session, so `tenantId` is accepted here for interface
 * symmetry with the other published queries (mirrors
 * `BranchCurrencyQueryService`) — RLS is what actually makes a cross-tenant
 * `branchId` resolve to `null` rather than another tenant's row.
 */
@Injectable()
export class BranchJurisdictionQueryService implements BranchJurisdictionQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: BranchJurisdictionQueryInput,
  ): Promise<BranchJurisdictionResult | null> {
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
      select: { id: true, countryCode: true },
    });
    return branch
      ? { branchId: branch.id, countryCode: branch.countryCode }
      : null;
  }
}
