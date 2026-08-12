import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  AuthorizedRequest,
  TenantContextService,
} from './tenant-context.service';

/**
 * Establishes the trusted tenant authorization context for tenant-scoped routes.
 * Runs after JwtAuthGuard. Rejects with 403 when no valid active tenant context
 * can be established. On success, request.authorization is populated for the
 * PermissionGuard and controllers to consume (no re-resolution downstream).
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly tenantContext: TenantContextService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    await this.tenantContext.require(request);
    return true;
  }
}
