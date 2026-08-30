import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  BranchCurrencyQuery,
  BranchCurrencyQueryInput,
  BranchCurrencyResult,
} from '../contract/branch-currency.query';

/**
 * PRIVATE Prisma-backed implementation of `BranchCurrencyQuery`
 * (`organisation/contract/branch-currency.query.ts`). Bound to
 * `BRANCH_CURRENCY_QUERY` only inside `OrganisationModule` (`useExisting`) —
 * never imported directly by a consumer; see `module-boundaries.spec.ts`'s
 * contract-purity assertions.
 *
 * `org.branches` carries a real `tenant_id` and is RLS-protected; the
 * caller's `Prisma.TransactionClient` is already inside a tenant-scoped
 * `withAuthContext` session, so `tenantId` is accepted here for interface
 * symmetry with the other published queries and as a readable statement of
 * intent — RLS is what actually makes a cross-tenant `branchId` resolve to
 * `null` rather than another tenant's row.
 */
@Injectable()
export class BranchCurrencyQueryService implements BranchCurrencyQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: BranchCurrencyQueryInput,
  ): Promise<BranchCurrencyResult | null> {
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
      select: { id: true, baseCurrency: true },
    });
    return branch
      ? { branchId: branch.id, baseCurrency: branch.baseCurrency }
      : null;
  }
}
