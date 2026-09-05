import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — the Internal-MVP single-active-branch
 * fail-closed assertion the Minimum Operational Reporting slice needs
 * (RPT-R1/R2/R3; design gate + acceptance correction §8/§14/§15).
 *
 * This is NOT branch-aware RBAC and does NOT reopen D-2. `operativeBranches`
 * reads a TENANT-SHAPE fact (`org.branches.status`), never a principal's
 * scope — it never consults `identity.membership_roles.branch_id` and never
 * populates `TenantContext.branchId`. The Reporting module's daily-trading
 * route is refused (403) unless the caller's tenant resolves to EXACTLY ONE
 * active branch, and the supplied `branchId` equals it:
 *
 *   0 active branches  -> 403 (fail-closed)
 *   1 active branch    -> continue (Internal-MVP shape)
 *   >1 active branches -> 403 (unsupported for this release)
 *
 * `limit` caps the query so the caller can distinguish 0 / 1 / >1 without
 * reading every branch row of a large tenant — `2` is enough for that
 * distinction (design gate §15).
 *
 * `find()` is `tx`-FIRST — the report's single-active-branch check executes
 * INSIDE the same RepeatableRead transaction that assembles the rest of the
 * response (design correction §8/Correction F), closing the TOCTOU window a
 * separate guard-transaction would leave open: a branch activated or
 * deactivated between a guard's own snapshot and the report's snapshot could
 * otherwise let a two-active-branch shape slip through.
 */
export const BRANCH_REPORTING_SCOPE_QUERY = Symbol(
  'BRANCH_REPORTING_SCOPE_QUERY',
);

export interface BranchReportingScopeQueryInput {
  readonly tenantId: string;
  readonly limit: number;
}

export interface BranchReportingScopeQueryBranchInput {
  readonly tenantId: string;
  readonly branchId: string;
}

export interface BranchReportingScopeQuery {
  /** Ids of `status = 'active'` branches in `tenantId`, capped at `limit`. */
  operativeBranches(
    tx: Prisma.TransactionClient,
    input: BranchReportingScopeQueryInput,
  ): Promise<readonly string[]>;

  /**
   * Whether ONE named branch is `status = 'active'` in `tenantId`.
   *
   * ── B1-3: WHAT SURVIVES THE INTERNAL-MVP MASK ─────────────────────────────
   * The mask above asserted TWO different things at once: that the tenant is
   * single-branch (an Internal-MVP release limit, retired in B1-3 once scoped
   * enforcement and the M-4+ review make multi-branch safe), and that the branch
   * being reported on is OPERATIVE (a business rule, which nothing retires).
   *
   * Conflating them is why the release limit could not be lifted without also
   * lifting the business rule. This asks only the second question, per branch,
   * so the count of a tenant's branches stops being an authorization input —
   * which is exactly what `FR-BRN-001`'s "unlimited branches" requires.
   *
   * Same fail-closed convention as everything else in this contract: a branch
   * that is invisible in the caller's RLS context is indistinguishable from one
   * that is inactive, and both answer `false`.
   */
  isOperativeBranch(
    tx: Prisma.TransactionClient,
    input: BranchReportingScopeQueryBranchInput,
  ): Promise<boolean>;
}
