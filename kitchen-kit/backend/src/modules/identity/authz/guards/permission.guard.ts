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
