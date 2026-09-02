import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type { BranchBrandQuery } from '../contract/branch-brand.query';

/**
 * PRIVATE Prisma-backed implementation of `BranchBrandQuery`
 * (`organisation/contract/branch-brand.query.ts`). Bound to
 * `BRANCH_BRAND_QUERY` only inside `OrganisationModule` (`useExisting`) —
 * never imported directly by a consumer.
 */
@Injectable()
export class BranchBrandQueryService implements BranchBrandQuery {
  async findBrandOfBranch(
    tx: Prisma.TransactionClient,
    branchId: string,
  ): Promise<string | null> {
    const branch = await tx.branch.findUnique({
      where: { id: branchId },
      select: { brandId: true },
    });
    // Another tenant's branch is invisible under RLS and lands here as null —
    // indistinguishable from "does not exist", by design.
    return branch?.brandId ?? null;
  }

  async findBranchAuthorizationFacts(
    tx: Prisma.TransactionClient,
    branchId: string,
  ): Promise<{ brandId: string; isActive: boolean } | null> {
    const branch = await tx.branch.findUnique({
      where: { id: branchId },
      select: { brandId: true, status: true },
    });
    // Invisible under RLS lands here as null — indistinguishable from "does not
    // exist". Being INACTIVE is a different answer and is reported as such, so
    // the caller can refuse it without turning it into a 404.
    return branch === null
      ? null
      : { brandId: branch.brandId, isActive: branch.status === 'active' };
  }

  async brandIsVisible(
    tx: Prisma.TransactionClient,
    brandId: string,
  ): Promise<boolean> {
    const brand = await tx.brand.findUnique({
      where: { id: brandId },
      select: { id: true },
    });
    return brand !== null;
  }
}
