import { Prisma } from '../../../generated/prisma/client';
import type { ScopeAuthorizationActor } from './authorization-target';

/**
 * Identity PUBLIC contract — D4-1B's SYNC_AUTHORIZATION_PORT binding seam.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Every OTHER caller of `ScopeAuthorizationService` (`identity/authz/scope-
 * authorization.service.ts`) obtains a `ScopeAuthorizationActor` from
 * `TenantContextService.resolve`, which needs a signed `AuthenticatedPrincipal`
 * — a JWT-bound `userId`/`membershipId` pair re-verified against a live token
 * epoch. A sync operation carries neither: `actorEmployeeId` is an employee id
 * ASSERTED by the offline terminal in the operation envelope (D4-1A report
 * §17.4), not an authenticated session. There is no token, so there is no
 * epoch to compare — and none is needed, because the resolution below reads
 * live database state on every call; it cannot go stale between calls the way
 * a minted token can.
 *
 * This is the ONLY new query D4-1B adds to Identity to close that gap. It does
 * NOT duplicate `ScopeAuthorizationService`'s lattice (`identity/authz/
 * scope.ts` `coversTarget`) — it produces the SAME `ScopeAuthorizationActor` shape
 * that primitive already consumes, using the SAME membership-roles read
 * `TenantContextService.resolve` uses (`toAssignmentScope`, exported from
 * `tenant-context.service.ts` for exactly this reuse) and the SAME
 * `EmployeeBranch` AND-only narrowing check `TenantContextService
 * .resolvePosBranch` performs for a live PIN session. Sync therefore gets a
 * `pos`-shaped actor with the identical non-leakage guarantees an ordinary POS
 * session has — never a parallel permission model.
 *
 * `POS_ACTOR_AUTHORIZATION` is deliberately separate from `TERMINAL_PIN_VERIFIER`
 * (`pin-verification.contract.ts`): that contract authenticates a PIN and would
 * require the operation envelope to carry a live PIN entry, which the SRS
 * envelope does not — `actorEmployeeId` is asserted, not verified by secret.
 * The trust boundary is the same one `pin-verification.contract.ts`'s docblock
 * already documents for `SalesPaymentService`/`CashMovementsService` accepting
 * a caller-supplied trusted `employeeId`: Sync's kernel is the trusted caller,
 * and the untrusted-input problem was already solved one layer down, by
 * `SyncTerminalGuard` authenticating the TERMINAL the envelope arrived on.
 */
export const POS_ACTOR_AUTHORIZATION = Symbol('POS_ACTOR_AUTHORIZATION');

export interface ResolvePosActorInput {
  readonly tenantId: string;
  /** Asserted by the terminal in the operation envelope — never a session. */
  readonly employeeId: string;
  /** The terminal's own LIVE branch, server-derived — never client-supplied. */
  readonly branchId: string;
}

export interface PosActorAuthorizationPort {
  /**
   * Resolve a live, `pos`-shaped `ScopeAuthorizationActor` for an asserted
   * employee acting through a terminal bound to `branchId`.
   *
   * `null` — fail closed, never throws — when: the employee does not exist,
   * is not `active`, has no linked `User` (cannot hold a membership), the
   * membership is missing/inactive/for an inactive tenant, or the employee is
   * not permitted at `branchId` (`identity.employee_branches`, AND-only
   * narrowing, mirroring `TenantContextService.resolvePosBranch`). The caller
   * (`SyncAuthorizationPort`'s implementation) treats `null` as "not
   * authorized" — there is no second, more permissive fallback.
   *
   * Returns a `ScopeAuthorizationActor` whose `context.sessionType` is `'pos'`
   * and whose `context.branchId` is `branchId`, so
   * `ScopeAuthorizationService.posNarrowingAllows` applies the identical
   * AND-only narrowing an ordinary PIN-issued session gets: a tenant-wide
   * grant still authorizes at this branch, but the actor can never be
   * authorized at any OTHER branch through this resolution, regardless of
   * what tenant/brand-scoped roles it holds.
   */
  resolve(
    tx: Prisma.TransactionClient,
    input: ResolvePosActorInput,
  ): Promise<ScopeAuthorizationActor | null>;
}
