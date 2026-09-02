import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BRANCH_BRAND_QUERY,
  type BranchBrandQuery,
} from '../../organisation/contract';
import type { RequestAuthorization } from '../context/tenant-context';
import type { RequiredPermissions } from './decorators/require-permission.decorator';
import { ResolvedTargetScope, TargetScope, coversTarget } from './scope';

/** Uniform refusal — a target scope must never become an existence oracle. */
const DENIED = 'Insufficient permission for this scope.';

/**
 * THE generic scope-authorization primitive (amendment clause 16.8).
 *
 * B1-3 applies this to every business operation. B1-2 publishes it, proves it,
 * and uses it for nothing else — converting business routes is explicitly NOT
 * this slice's work.
 *
 * ── WHAT IT DECIDES ────────────────────────────────────────────────────────
 *   authorize(actor, required permission(s) P, target scope S)
 *
 * and it is authorised only when SOME single assignment satisfies BOTH halves
 * at once: the assignment's role grants P, AND the assignment's scope covers S.
 * That "same assignment" quantifier is FR-SEC-004's non-leakage clause: a
 * permission held at Branch 1 plus a different permission held at Branch 2
 * never combine into authority at either.
 *
 * `mode: 'all'` requires every listed code — each of which must be satisfiable
 * by an assignment that covers the target. `mode: 'any'` requires one.
 *
 * ── WHAT IT NEVER DOES ─────────────────────────────────────────────────────
 * It never consults `EmployeeBranch` or a home branch as a GRANT (clause 1); it
 * never reads a JWT claim; it never classifies permission codes by scope
 * (clause 20 — SRS Appendix C is absent); it never hardcodes a role name
 * (D-3 / P1A CLARIFICATION C); and it never turns a foreign-tenant id into a
 * distinguishable answer.
 */
@Injectable()
export class ScopeAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
  ) {}

  /** Throwing form. 403 on refusal, with a uniform message. */
  async assertAuthorized(
    auth: RequestAuthorization,
    required: RequiredPermissions,
    target: TargetScope,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!(await this.isAuthorized(auth, required, target, tx))) {
      throw new ForbiddenException(DENIED);
    }
  }

  /** Predicate form, for callers that need to branch rather than throw. */
  async isAuthorized(
    auth: RequestAuthorization,
    required: RequiredPermissions,
    target: TargetScope,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    // R-8: zero assignments is ZERO authority. Never "unrestricted".
    if (auth.grants.length === 0) {
      return false;
    }
    if (required.codes.length === 0) {
      // A caller that asks for no permission is a programming error, not an
      // open door.
      return false;
    }

    const resolved = await this.resolveTarget(auth, target, tx);
    if (resolved === null) {
      // Target not visible in this tenant, or unresolvable. Fail closed (R-4,
      // R-1) — and the CALLER is responsible for the tenant-safe 404 shape on
      // resource lookup, so nothing here distinguishes "foreign" from "absent".
      return false;
    }

    // POS narrowing is an AND-only restriction layered on top of the lattice.
    if (!this.posNarrowingAllows(auth, resolved)) {
      return false;
    }

    const covering = auth.grants.filter((g) => coversTarget(g.scope, resolved));
    if (covering.length === 0) {
      return false;
    }

    if (required.mode === 'any') {
      return required.codes.some((code) =>
        covering.some((g) => g.permissions.has(code)),
      );
    }
    return required.codes.every((code) =>
      covering.some((g) => g.permissions.has(code)),
    );
  }

  /**
   * POS sessions (amendment clause 6). A PIN-issued session may act ONLY on the
   * branch its authenticated terminal is bound to, and only while its employee
   * is still permitted there — both facts already re-verified from live state
   * by `TenantContextService` on this very request.
   *
   * A TENANT-scoped role does NOT lift this: a tenant-wide manager on a Branch A
   * terminal still cannot act on Branch B. `EmployeeBranch` narrows and never
   * grants.
   *
   * Non-branch targets are left to the lattice: an unconverted route reaching
   * here with a TENANT target behaves exactly as it does today, which is what
   * keeps the B1-2 -> B1-3 transition non-breaking for POS.
   */
  private posNarrowingAllows(
    auth: RequestAuthorization,
    target: ResolvedTargetScope,
  ): boolean {
    if (auth.context.sessionType !== 'pos') {
      return true;
    }
    if (target.type !== 'branch') {
      return true;
    }
    // Resolution populated this from live terminal state, or refused the
    // request outright; an absent value here can only ever deny.
    return (
      auth.context.branchId !== undefined &&
      auth.context.branchId === target.branchId
    );
  }

  /**
   * Resolve the target against Organisation, and DENY (null) anything not
   * visible in the acting tenant.
   *
   * ── WHY VISIBILITY IS CHECKED HERE, NOT LEFT TO THE CALLER ─────────────────
   * A `TENANT`-scoped assignment covers "every branch in MY tenant". If the
   * primitive took the caller's word for the target's identity, a branch id
   * belonging to ANOTHER tenant would satisfy that grant — and the only thing
   * standing between that and a cross-tenant action would be whether the B1-3
   * caller happened to resolve the resource tenant-safely FIRST. That is
   * exactly the kind of "every caller must remember" rule this slice exists to
   * remove, so the check lives here.
   *
   * Not visible ⇒ `null` ⇒ denied, with no distinction between "another
   * tenant's" and "does not exist" (R-4: a target must never become an
   * existence oracle). The caller still owns the tenant-safe 404 on its own
   * resource lookup; this is defence in depth, not a replacement.
   *
   * A caller that has ALREADY resolved the branch and can supply its parent
   * brand skips the round trip entirely — the common B1-3 path, where the
   * handler loaded the resource anyway.
   */
  private async resolveTarget(
    auth: RequestAuthorization,
    target: TargetScope,
    tx?: Prisma.TransactionClient,
  ): Promise<ResolvedTargetScope | null> {
    if (target.type === 'tenant') {
      return { type: 'tenant' };
    }

    // The caller already resolved the branch (it knows the parent brand), so
    // visibility is established and no query is needed.
    if (target.type === 'branch' && target.brandId !== undefined) {
      return {
        type: 'branch',
        branchId: target.branchId,
        brandId: target.brandId,
      };
    }

    return this.inContext(auth, tx, async (inner) => {
      if (target.type === 'brand') {
        const visible = await this.branchBrand.brandIsVisible(
          inner,
          target.brandId,
        );
        return visible ? { type: 'brand', brandId: target.brandId } : null;
      }

      const brandId = await this.branchBrand.findBrandOfBranch(
        inner,
        target.branchId,
      );
      if (brandId === null) {
        // Invisible in this tenant — denied outright, whatever scope is held.
        return null;
      }
      // The same query that established visibility also yields the parent
      // brand, so it is always carried through — `coversTarget` uses it only
      // when a brand-scoped assignment is actually held.
      return { type: 'branch', branchId: target.branchId, brandId };
    });
  }

  /** Run inside the caller's transaction when given one, else open our own. */
  private inContext<T>(
    auth: RequestAuthorization,
    tx: Prisma.TransactionClient | undefined,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) {
      return fn(tx);
    }
    return this.prisma.withAuthContext(
      { userId: auth.context.userId, tenantId: auth.context.tenantId },
      fn,
    );
  }
}
