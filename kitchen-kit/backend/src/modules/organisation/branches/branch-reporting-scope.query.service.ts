import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  BranchReportingScopeQuery,
  BranchReportingScopeQueryInput,
} from '../contract/branch-reporting-scope.query';

/**
 * PRIVATE Prisma-backed implementation of `BranchReportingScopeQuery`
 * (`organisation/contract/branch-reporting-scope.query.ts`). Bound to
 * `BRANCH_REPORTING_SCOPE_QUERY` only inside `OrganisationModule`
 * (`useExisting`) — never imported directly by a consumer.
 */
@Injectable()
export class BranchReportingScopeQueryService implements BranchReportingScopeQuery {
  async operativeBranches(
    tx: Prisma.TransactionClient,
    input: BranchReportingScopeQueryInput,
  ): Promise<readonly string[]> {
    const rows = await tx.branch.findMany({
      where: { tenantId: input.tenantId, status: 'active' },
      select: { id: true },
      take: input.limit,
    });
    return rows.map((r) => r.id);
  }
}
