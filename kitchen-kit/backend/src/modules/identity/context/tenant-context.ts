import type { AssignmentScope } from '../authz/scope';

/**
 * Strongly-typed, server-derived authorization context for a tenant-scoped
 * request. Every field originates from the signed access token (established by
 * JwtAuthGuard) and is validated server-side by TenantContextService — never
 * from client body, query, or headers.
 *
 * Field classification:
 *  - userId, sessionId   → authentication identity
 *  - tenantId, membershipId → tenant authorization (the active membership)
 *  - terminalId          → device/terminal identity (present for terminal sessions)
 *  - sessionType/employeeId → POS session identity (PIN-issued sessions only)
 *  - branchId            → the POS session's OPERATING branch (B1-2). Populated
 *      ONLY for `pos` sessions, and ONLY from live server-side terminal state
 *      (`identity.terminals.branch_id`, which carries a tenant-safe composite FK
 *      to `org.branches`). NEVER from a request body and NEVER from a JWT branch
 *      claim. For dashboard sessions it stays undefined: a dashboard actor has
 *      no single operating branch, it has SCOPED ASSIGNMENTS (see
 *      `RequestAuthorization.grants`).
 */
export interface TenantContext {
  userId: string;
  sessionId: string;
  tenantId: string;
  membershipId: string;
  terminalId?: string;
  /** `pos` for PIN-issued sessions; undefined for dashboard sessions. */
  sessionType?: 'pos';
  /** Employee behind a POS session (FR-SEC-021). */
  employeeId?: string;
  branchId?: string;
}

/**
 * One effective, in-date scoped role assignment, with the permissions that
 * assignment's role grants AT THAT SCOPE.
 *
 * FR-SEC-004 [M]: "effective permissions SHALL be the union of granted
 * permissions within each assignment's own scope. Permissions SHALL NOT leak
 * across scopes." That non-leakage clause is only expressible if the scope
 * travels WITH the permissions — which is precisely what the pre-B1-2 flat
 * `Set<string>` destroyed.
 */
export interface ScopedGrant {
  /** Stable assignment id (`identity.membership_roles.id`). */
  readonly assignmentId: string;
  readonly roleId: string;
  readonly scope: AssignmentScope;
  readonly permissions: ReadonlySet<string>;
}

/**
 * The resolved authorization for a request, attached exactly once at
 * `request.authorization`.
 *
 * ── `permissions` IS THE TRANSITIONAL TENANT-TARGET SET, NOT A UNION ─────────
 * B1-2 introduces scoped assignments BEFORE B1-3 attaches an explicit target
 * scope to every business operation. If `permissions` stayed a flat union of
 * every assignment, a BRANCH-scoped grant would satisfy every not-yet-converted
 * route in the tenant — an authorization LEAK created by the very slice meant to
 * close one.
 *
 * So, per clause 3 of the B1-2 brief and clause 16 of the ratified amendment:
 * an operation carrying `@RequirePermission` and NO explicit target scope is a
 * TENANT-target operation, and `permissions` therefore contains ONLY the
 * permissions of `tenant`-scoped assignments. BRAND- and BRANCH-scoped grants
 * are NEVER flattened into it. They reach a route only through
 * `ScopeAuthorizationService` with an explicit target — which is B1-3's work.
 *
 * The deliberate consequence: migrated legacy TENANT assignments keep working
 * unchanged, and new narrow assignments FAIL CLOSED on unconverted routes.
 */
export interface RequestAuthorization {
  context: TenantContext;
  /** TENANT-scoped permissions only. See the docblock above. */
  permissions: ReadonlySet<string>;
  /** Every effective, in-date assignment, scope-qualified. */
  grants: readonly ScopedGrant[];
  /** Live `memberships.authz_epoch` this request was authorised against. */
  authzEpoch: number;
  /** M-4+ — the tenant still holds unreviewed migration-originated grants. */
  scopeReviewRequired: boolean;
}
