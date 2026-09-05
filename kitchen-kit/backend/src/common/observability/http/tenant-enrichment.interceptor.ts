import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ObservabilityContextService } from '../context/observability-context';
import type { RequestAuthorization } from '../../../modules/identity/context/tenant-context';

type MaybeAuthorizedRequest = {
  authorization?: RequestAuthorization;
};

/**
 * Enriches the observability context with tenant/branch — ONLY from the
 * already-live-verified `request.authorization` that `TenantContextGuard`
 * attaches (`modules/identity/context/tenant-context.service.ts`), never from
 * a header/body/query/JWT-snapshot claim (SRS §27.6 NFR-OBS-001 trust rule —
 * see `observability-context.ts`'s docblock).
 *
 * Registered as a global `APP_INTERCEPTOR`. Interceptors run AFTER every
 * guard (global and controller-level) has already succeeded, so
 * `request.authorization` — when the route uses `TenantContextGuard` — is
 * already populated by the time this runs. A route with no tenant context
 * (public/pre-auth, or a guard that rejected the request before an
 * interceptor could run at all) simply leaves tenant/branch `null`, which is
 * the honest value per NFR-OBS-001, not a gap to paper over.
 *
 * Deliberately does no logging or metrics of its own (SRS §7: exactly one
 * completion emission, owned by `CorrelationMiddleware`) — this is pure
 * context enrichment, exactly the shape §29 asks for so a future
 * authorization change (B1-3) does not have to remember to preserve
 * observability: it stays a `request.authorization` reader, not a
 * reimplementation of any scoped-RBAC logic.
 */
@Injectable()
export class TenantEnrichmentInterceptor implements NestInterceptor {
  constructor(private readonly context: ObservabilityContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context
        .switchToHttp()
        .getRequest<MaybeAuthorizedRequest>();
      const authContext = request.authorization?.context;
      this.context.enrichTenant(
        authContext?.tenantId ?? null,
        authContext?.branchId ?? null,
      );
    }
    return next.handle();
  }
}
