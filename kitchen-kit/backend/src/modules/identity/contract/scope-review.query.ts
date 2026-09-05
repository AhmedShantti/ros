import { Prisma } from '../../../generated/prisma/client';

/**
 * Identity PUBLIC contract — M-4+ inherited-scope review state (SRS §5.4).
 *
 * Authority: "AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC",
 * clause 13 (M-4+), limbs C and D.
 *
 * The B1-2 migration backfills every pre-existing role assignment as TENANT
 * scope, because tenant-wide is what an unscoped assignment actually meant, and
 * stamps it `origin = 'migration'` with no review. Until a human has reviewed
 * those inherited grants, the tenant is NOT multi-branch authorization-ready:
 *
 *   limb C — it MUST NOT be allowed to activate a SECOND active branch;
 *   limb D — if it is ALREADY multi-branch, migration must not fail and must
 *            not declare it ready; the review-required state is derived instead.
 *
 * The gate itself lives at Organisation's branch-activation path (Organisation
 * owns branch lifecycle), so Organisation must be able to ask Identity this
 * one question. Identity owns `identity.membership_roles`; this contract is how
 * the fact leaves the module.
 *
 * Transaction-aware: the caller's tenant-scoped RLS context already applies, so
 * the answer is necessarily about the acting tenant and no `tenantId` argument
 * could widen it.
 */
export const SCOPE_REVIEW_QUERY = Symbol('SCOPE_REVIEW_QUERY');

export interface ScopeReviewQuery {
  /**
   * True while the acting tenant still holds at least one migration-originated
   * TENANT assignment that nobody has reviewed.
   *
   * Callers MUST treat `true` as fail-closed for multi-branch activation. It is
   * NOT an authorization decision and grants nothing.
   */
  hasUnreviewedInheritedAssignments(
    tx: Prisma.TransactionClient,
  ): Promise<boolean>;
}
