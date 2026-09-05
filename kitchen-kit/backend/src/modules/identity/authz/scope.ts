/**
 * Scoped RBAC — the ratified target-scope lattice (FR-SEC-002/003/004).
 *
 * Authority: `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, "AMENDMENT —
 * D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC" (RATIFIED 2026-09-02),
 * clauses 2, 3 and 4; and `docs/adr/0009-scoped-rbac.md`.
 *
 * This file is PURE: no Nest, no Prisma, no I/O. The lattice is the security
 * invariant, so it is expressed once, in isolation, and unit-tested directly.
 *
 * ── THE TWO KINDS OF SCOPE ──────────────────────────────────────────────────
 * They are deliberately different types, because conflating them is exactly how
 * an upward leak gets written by accident:
 *
 *   AssignmentScope — the authority an actor HOLDS (a row in membership_roles).
 *   TargetScope     — the scope of the RESOURCE an operation acts on.
 *
 * Clause 3: authorization is evaluated against BOTH the required permission AND
 * the target scope. A permission code alone is never sufficient. The target is
 * derived from the protected RESOURCE, never from a classification of
 * permission codes — SRS Appendix C is absent, so no such classification may be
 * invented (clause 20).
 */

/** The three ratified scope types. `BRANCH_GROUP` is deferred, not rejected. */
export type ScopeType = 'tenant' | 'brand' | 'branch';

/** Authority held by an actor. */
export type AssignmentScope =
  | { readonly type: 'tenant' }
  | { readonly type: 'brand'; readonly brandId: string }
  | { readonly type: 'branch'; readonly branchId: string };

/**
 * The scope of the resource an operation targets.
 *
 * A `branch` target may carry its parent `brandId` when the caller already
 * knows it. When it does not, and the actor holds only brand-scoped authority,
 * the parent brand must be resolved from Organisation before coverage can be
 * decided — see `ScopeAuthorizationService`. It is NEVER assumed.
 */
export type TargetScope =
  | { readonly type: 'tenant' }
  | { readonly type: 'brand'; readonly brandId: string }
  | {
      readonly type: 'branch';
      readonly branchId: string;
      readonly brandId?: string;
    };

/** A target whose parent brand is known, so coverage is decidable offline. */
export type ResolvedTargetScope =
  | { readonly type: 'tenant' }
  | { readonly type: 'brand'; readonly brandId: string }
  | {
      readonly type: 'branch';
      readonly branchId: string;
      readonly brandId: string | null;
    };

/**
 * THE LATTICE. Coverage is directional DOWNWARD ONLY — never upward, never
 * sideways.
 *
 *   TENANT   -> TENANT, every BRAND in the tenant, every BRANCH in the tenant
 *   BRAND X  -> BRAND X, and BRANCH whose parent brand is X
 *               (NOT tenant, NOT another brand, NOT a branch of another brand)
 *   BRANCH X -> BRANCH X only
 *               (NOT tenant, NOT any brand, NOT another branch)
 *
 * Same-tenant is a PRECONDITION, not a limb of this function: an assignment and
 * a target only ever meet here after the tenant context has been established and
 * the assignment row was read under that tenant's RLS.
 */
export function coversTarget(
  scope: AssignmentScope,
  target: ResolvedTargetScope,
): boolean {
  switch (scope.type) {
    case 'tenant':
      // Downward to everything in the tenant.
      return true;

    case 'brand':
      if (target.type === 'brand') {
        return target.brandId === scope.brandId;
      }
      if (target.type === 'branch') {
        // An unresolved parent brand can never satisfy a brand scope: unknown
        // fails closed rather than assuming membership.
        return target.brandId !== null && target.brandId === scope.brandId;
      }
      // target.type === 'tenant' — upward. Denied.
      return false;

    case 'branch':
      return target.type === 'branch' && target.branchId === scope.branchId;
  }
}

/**
 * Stable, compact rendering of one assignment scope for the token's scope set
 * and for the effective-scope read contract.
 *
 * Deterministic and exact (clause 8): `tenant`, `brand:<uuid>`,
 * `branch:<uuid>`. It is a SNAPSHOT for presentation and staleness detection —
 * never an authorization source.
 */
export type ScopeSetEntry = string;

export function renderScope(scope: AssignmentScope): ScopeSetEntry {
  switch (scope.type) {
    case 'tenant':
      return 'tenant';
    case 'brand':
      return `brand:${scope.brandId}`;
    case 'branch':
      return `branch:${scope.branchId}`;
  }
}

/**
 * SYMBOLIC permitted-branch set (FR-API-012 "permitted branch set").
 *
 * Clause 8 forbids an unbounded unsafe header, and clause 13 of the B1-2 brief
 * forbids letting a tenant's branch COUNT drive token size. So a tenant-wide or
 * brand-wide permission is carried as the SYMBOL that produced it, never as an
 * expanded list of branch ids:
 *
 *   TENANT scope -> `all: true`             (1 unit, whatever the branch count)
 *   BRAND X      -> `brands: [X]`           (1 unit per brand)
 *   BRANCH B     -> `branches: [B]`         (1 unit per explicit branch)
 *
 * `all: false` with empty `brands` and `branches` means ZERO permitted
 * branches. Omission NEVER means unrestricted (clause 15 / R-8).
 */
export interface PermittedBranchSet {
  /** Representation version. An unknown version fails closed. */
  readonly v: 1;
  /** Every branch in the tenant is permitted (a tenant-scoped assignment exists). */
  readonly all: boolean;
  /** Brands whose branches are permitted. Symbolic — never expanded. */
  readonly brands: readonly string[];
  /** Explicitly permitted branch ids. */
  readonly branches: readonly string[];
}

export const PERMITTED_BRANCH_SET_VERSION = 1 as const;

/** Build the symbolic permitted-branch set from the actor's assignment scopes. */
export function buildPermittedBranchSet(
  scopes: readonly AssignmentScope[],
): PermittedBranchSet {
  const brands = new Set<string>();
  const branches = new Set<string>();
  let all = false;

  for (const scope of scopes) {
    switch (scope.type) {
      case 'tenant':
        all = true;
        break;
      case 'brand':
        brands.add(scope.brandId);
        break;
      case 'branch':
        branches.add(scope.branchId);
        break;
    }
  }

  return {
    v: PERMITTED_BRANCH_SET_VERSION,
    all,
    // Sorted so the snapshot is deterministic for a given authority state.
    brands: [...brands].sort(),
    branches: [...branches].sort(),
  };
}

/**
 * Size of the snapshot in "units", for the token budget. A tenant-wide actor
 * costs ONE unit no matter how many branches the tenant has — which is the
 * whole point of the symbolic representation.
 */
export function permittedBranchSetUnits(set: PermittedBranchSet): number {
  return (set.all ? 1 : 0) + set.brands.length + set.branches.length;
}
