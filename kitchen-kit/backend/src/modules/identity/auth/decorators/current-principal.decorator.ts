import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedPrincipal } from '../auth.types';

/**
 * Extracts the principal established by JwtAuthGuard. Only valid on routes
 * guarded by JwtAuthGuard.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { principal?: AuthenticatedPrincipal }>();
    return request.principal as AuthenticatedPrincipal;
  },
);
