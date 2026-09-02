import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — B1-2 scoped RBAC (SRS §5.4, §5.5.1).
 *
 * The ratified scope lattice says a BRAND-scoped assignment covers a BRANCH
 * target "whose parent brand = X" (D-2 REOPENED IN PART (2), clause 2). The
 * parent-brand fact belongs to Organisation (`org.branches.brand_id`), and
 * Identity must reach it through this published contract — never through a
 * direct Prisma read of Organisation's private tables, and never by importing
 * `branches/branches.service`. `module-boundaries.spec.ts` enforces that
 * mechanically.
 *
 * Transaction-aware, matching `RoutingConfigQuery` and `BranchReportingScopeQuery`:
 * the caller's tenant-scoped RLS context already applies inside `tx`, so a
 * branch belonging to another tenant is INVISIBLE and yields `null`. That is
 * load-bearing — it is what keeps a foreign branch id from becoming a 403
 * existence oracle.
 *
 * This is NOT an authorization decision and grants nothing. It answers exactly
 * one question: which brand does this (tenant-visible) branch belong to?
 */
export const BRANCH_BRAND_QUERY = Symbol('BRANCH_BRAND_QUERY');

export interface BranchBrandQuery {
  /**
   * Parent brand id of a branch visible in the caller's RLS context.
   *
   * `null` means "not visible" — the branch does not exist, or belongs to
   * another tenant. Callers MUST treat `null` as fail-closed and MUST NOT
   * distinguish the two cases to the client.
   */
  findBrandOfBranch(
    tx: Prisma.TransactionClient,
    branchId: string,
  ): Promise<string | null>;

  /**
   * Whether a brand is visible in the caller's RLS context.
   *
   * Same fail-closed contract: `false` covers both "does not exist" and
   * "belongs to another tenant", and the two must stay indistinguishable.
   */
  brandIsVisible(
    tx: Prisma.TransactionClient,
    brandId: string,
  ): Promise<boolean>;
}
