import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedPrincipal } from '../../auth/auth.types';
import { AuthorizationService } from '../authorization.service';
import {
  PERMISSIONS_KEY,
  RequiredPermissions,
} from '../decorators/require-permission.decorator';

/**
 * Authorization guard. Runs AFTER JwtAuthGuard (which establishes the principal
 * and returns 401 for auth failures). This guard only ever returns 403:
 *   - authenticated but no active tenant/membership context, or
 *   - authenticated with context but missing the required permission(s).
 * Role/permission data is resolved from the DB via the server-side principal;
 * nothing from the client body/query is trusted.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      RequiredPermissions | undefined
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    // No @RequirePermission on the route → nothing to authorize here.
    if (!required) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: AuthenticatedPrincipal }>();
    const principal = request.principal;
    if (!principal) {
      // JwtAuthGuard should have run first; defensive 401.
      throw new UnauthorizedException();
    }
    if (!principal.tenantId || !principal.membershipId) {
      throw new ForbiddenException('No active tenant context.');
    }

    const effective = await this.authz.getEffectivePermissions(principal);
    const ok =
      required.mode === 'any'
        ? required.codes.some((code) => effective.has(code))
        : required.codes.every((code) => effective.has(code));

    if (!ok) {
      throw new ForbiddenException('Insufficient permission.');
    }
    return true;
  }
}
