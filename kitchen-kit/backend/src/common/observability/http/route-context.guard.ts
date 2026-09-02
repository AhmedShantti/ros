import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { ObservabilityContextService } from '../context/observability-context';

/**
 * Enriches the observability context with the NORMALIZED route template and
 * stable handler identity (SRS §27.6 NFR-OBS-003 "per endpoint and per
 * handler" — see `metrics.service.ts`'s docblock for the exact definitions).
 *
 * Registered as a GLOBAL `APP_GUARD`, which Nest always runs BEFORE any
 * controller-level `@UseGuards(...)` guard (`JwtAuthGuard`,
 * `TenantContextGuard`, `PermissionGuard`, ...). That ordering is the whole
 * point: it means route/handler are captured even for a request a later
 * guard goes on to reject with 401/403, so RED metrics stay complete for
 * every endpoint — not just the ones that end in 2xx. This guard never
 * denies; it always returns `true`.
 *
 * `request.route.path` is Express's own matched-route path TEMPLATE (e.g.
 * `/orders/:businessDay/:id`), already free of any live resource id — Express
 * populates it before invoking the route's handler stack, which includes
 * every Nest guard, so it is available here. A request that matches no route
 * at all never reaches any guard, Nest global or controller-level; the
 * completion path in `correlation.middleware.ts` labels that case
 * `"unmatched"` instead of a raw path.
 */
@Injectable()
export class ObservabilityRouteGuard implements CanActivate {
  constructor(private readonly context: ObservabilityContextService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const route = normalizeRoute(request);
    const handler = `${context.getClass().name}#${context.getHandler().name}`;

    this.context.enrichRoute(route, handler);
    return true;
  }
}

function normalizeRoute(request: Request): string {
  const routePath = (request as { route?: { path?: unknown } }).route?.path;
  if (typeof routePath === 'string' && routePath.length > 0) {
    // Express may report the route relative to a mounted router; the
    // baseUrl (also template-shaped, never containing a live id once
    // mounted under Nest's controller prefixes) restores the full template.
    return `${request.baseUrl}${routePath}` || routePath;
  }
  if (Array.isArray(routePath) && routePath.length > 0) {
    return `${request.baseUrl}${String(routePath[0])}`;
  }
  return 'unmatched';
}
