import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { AuthorizedRequest } from './tenant-context.service';
import { RequestAuthorization, TenantContext } from './tenant-context';

function authorizationOf(ctx: ExecutionContext): RequestAuthorization {
  const request = ctx.switchToHttp().getRequest<AuthorizedRequest>();
  if (!request.authorization) {
    // Only reachable if the route forgot TenantContextGuard.
    throw new ForbiddenException('No active tenant context.');
  }
  return request.authorization;
}

/** Inject the validated TenantContext (requires TenantContextGuard on the route). */
export const CurrentTenantContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext =>
    authorizationOf(ctx).context,
);

/** Inject the full resolved authorization (context + effective permissions). */
export const CurrentAuthorization = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestAuthorization =>
    authorizationOf(ctx),
);
