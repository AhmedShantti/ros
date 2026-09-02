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

  /**
   * The two facts the generic authorization path needs about a branch, in ONE
   * query: its parent brand (for the lattice's BRAND→BRANCH limb) and whether
   * it is `status = 'active'`.
   *
   * ── WHY `isActive` BELONGS HERE ──────────────────────────────────────────
   * T-12: a branch moved away from `active` is denied for EVERY scope, TENANT
   * included, and that has to hold route-wide rather than in the two modules
   * that happened to check it. Asking for the brand and the status separately
   * would mean two round trips on every branch-targeted request AND two moments
   * at which the answer could differ; asking once, inside the caller's own
   * transaction, means the authorization decision sees one consistent branch.
   *
   * `null` means NOT VISIBLE in the caller's RLS context — another tenant's, or
   * nobody's — and the two must stay indistinguishable to the client.
   * Deactivation is deliberately NOT folded into `null`: an inactive branch of
   * your OWN tenant is a refusal (403), while an invisible one is the ordinary
   * tenant-safe 404.
   */
  findBranchAuthorizationFacts(
    tx: Prisma.TransactionClient,
    branchId: string,
  ): Promise<{ readonly brandId: string; readonly isActive: boolean } | null>;
}
