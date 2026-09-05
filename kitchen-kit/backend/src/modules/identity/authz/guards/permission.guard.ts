import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  AUTHORIZATION_TARGET_KEY,
  type AuthorizationTargetSpec,
} from '../../contract/authorization-target';
import {
  AuthorizedRequest,
  TenantContextService,
} from '../../context/tenant-context.service';
import { AuthorizationTargetResolver } from '../authorization-target.resolver';
import { ScopeAuthorizationService } from '../scope-authorization.service';
import {
  PERMISSIONS_KEY,
  RequiredPermissions,
} from '../decorators/require-permission.decorator';

/**
 * Authorization guard. Runs AFTER JwtAuthGuard (which establishes the principal
 * and returns 401 for auth failures). It consumes the single, authoritative
 * tenant authorization context (TenantContextService, memoized per request), so
 * it neither re-resolves tenant/membership nor trusts any client-supplied
 * role/permission/tenant data. It only ever returns 403:
 *   - no valid active tenant context, or
 *   - authenticated with context but missing the required permission(s) AT THE
 *     TARGET SCOPE.
 *
 * ── B1-3: THIS IS THE SINGLE ROUTE-LEVEL ENFORCEMENT POINT ──────────────────
 * Ratified: "AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC"
 * clauses 3 and 16; `docs/adr/0009-scoped-rbac.md` D-03 / D-10.
 *
 * A route declares WHAT it needs with `@RequirePermission` and WHERE it acts
 * with `@AuthorizationTarget`. Both are read here, and the decision is made by
 * `ScopeAuthorizationService` — `permission AND target scope`, satisfied by ONE
 * SINGLE assignment, which is FR-SEC-004's non-leakage clause.
 *
 * B1-3 deliberately did NOT add a second guard alongside this one. A separate
 * `ScopeTargetGuard` would have to be listed in every controller's
 * `@UseGuards(...)`, and a route that declared a target but forgot the guard
 * would silently fall back to the weaker tenant-only check — a hole that looks
 * exactly like correct code at the call site. Folding the decision into the
 * guard that is ALREADY on every protected route removes that failure mode
 * entirely: there is nothing extra to remember.
 *
 * ── THE TRANSITIONAL RULE, NOW ALLOWLISTED RATHER THAN AMBIENT ──────────────
 * A route carrying `@RequirePermission(P)` and NO `@AuthorizationTarget` is
 * still treated as a TENANT-target operation, exactly as B1-2 left it:
 * `RequestAuthorization.permissions` holds ONLY tenant-scoped permissions, so
 * BRAND- and BRANCH-scoped grants cannot satisfy it. That path is fail-closed,
 * but it is no longer allowed to spread silently —
 * `src/modules/authorization-coverage.spec.ts` fails the build for any
 * permission-bearing route that does not declare a target and is not on the
 * reviewed, itemised allowlist.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
    private readonly targetResolver: AuthorizationTargetResolver,
    private readonly scopeAuthorization: ScopeAuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      RequiredPermissions | undefined
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    // No @RequirePermission on the route → nothing to authorize here.
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    const auth = await this.tenantContext.require(request);

    const target = this.reflector.getAllAndOverride<
      AuthorizationTargetSpec | undefined
    >(AUTHORIZATION_TARGET_KEY, [context.getHandler(), context.getClass()]);

    if (!target) {
      // TRANSITIONAL: tenant-target operation, tenant-scoped permissions only.
      const ok =
        required.mode === 'any'
          ? required.codes.some((code) => auth.permissions.has(code))
          : required.codes.every((code) => auth.permissions.has(code));
      if (!ok) {
        throw new ForbiddenException('Insufficient permission.');
      }
      return true;
    }

    const resolution = await this.targetResolver.resolve(request, auth, target);

    if (resolution.outcome === 'deny') {
      // Uniform message: the refusal must not disclose WHICH condition failed.
      // A branch that is not active, a POS session off its terminal's branch,
      // and a plain scope refusal are indistinguishable here on purpose.
      throw new ForbiddenException('Insufficient permission for this scope.');
    }

    if (resolution.outcome === 'notFound') {
      // The addressed resource is not visible in this tenant — another
      // tenant's, or nobody's. The route's OWN tenant-safe wording is used, so
      // the two cases are byte-identical to each other and to what the handler
      // would have said. Raised HERE so the operation never runs unscoped.
      throw new NotFoundException(resolution.message);
    }

    if (resolution.outcome === 'badRequest') {
      // Input that cannot denote a resource at all. Nothing can be authorized
      // against it, and the handler must not see it.
      throw new BadRequestException(resolution.message);
    }

    await this.scopeAuthorization.assertAuthorized(
      auth,
      required,
      resolution.target,
    );
    return true;
  }
}
