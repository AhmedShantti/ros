import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthorizedRequest,
  TenantContextService,
} from '../../context/tenant-context.service';
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
 *   - authenticated with context but missing the required permission(s).
 *
 * ── B1-2 TRANSITIONAL RULE — THIS GUARD IS A *TENANT-TARGET* GUARD ──────────
 * Ratified: "AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC"
 * clause 16, and clause 3 of the B1-2 brief.
 *
 * A route carrying `@RequirePermission(P)` and NO explicit target scope is
 * treated as a TENANT-target operation. `RequestAuthorization.permissions` is
 * therefore the TENANT-scoped permission set ONLY — BRAND- and BRANCH-scoped
 * assignments are never flattened into it. Consequently:
 *
 *   TENANT assignment holding P  -> may pass here (legacy behaviour preserved);
 *   BRAND  assignment holding P  -> MUST NOT pass here;
 *   BRANCH assignment holding P  -> MUST NOT pass here.
 *
 * This is deliberate and fail-closed. B1-2 introduces scoped assignments BEFORE
 * B1-3 attaches an explicit target scope to every business operation; if a
 * narrow grant satisfied every not-yet-converted route, the slice that exists to
 * CLOSE an authorization gap would have opened a wider one. Migrated legacy
 * TENANT assignments keep working unchanged; new narrow assignments fail closed
 * until B1-3 converts the route.
 *
 * B1-3 replaces this for branch/brand-targeted operations with
 * `ScopeAuthorizationService`, which evaluates permission AND target scope.
 * This guard is NOT the place to add a branch parameter.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
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
    const { permissions } = await this.tenantContext.require(request);

    const ok =
      required.mode === 'any'
        ? required.codes.some((code) => permissions.has(code))
        : required.codes.every((code) => permissions.has(code));

    if (!ok) {
      throw new ForbiddenException('Insufficient permission.');
    }
    return true;
  }
}
