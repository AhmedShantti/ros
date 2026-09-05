import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type { ScopeReviewQuery } from '../contract/scope-review.query';

/**
 * PRIVATE Prisma-backed implementation of `ScopeReviewQuery`
 * (`identity/contract/scope-review.query.ts`). Bound to `SCOPE_REVIEW_QUERY`
 * only inside `IdentityModule` (`useExisting`) — never imported directly.
 *
 * The predicate is exactly M-4+'s "unreviewed inherited authority":
 * `origin = 'migration' AND reviewed_at IS NULL`. The caller's tenant-scoped
 * RLS context restricts it to the acting tenant, so no `tenantId` argument
 * could widen the answer.
 */
@Injectable()
export class ScopeReviewQueryService implements ScopeReviewQuery {
  async hasUnreviewedInheritedAssignments(
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const found = await tx.membershipRole.findFirst({
      where: { origin: 'migration', reviewedAt: null },
      select: { id: true },
    });
    return found !== null;
  }
}
