import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ObservabilityContextService } from './context/observability-context';
import { StructuredLoggerService } from './logging/structured-logger.service';
import { MetricsService } from './metrics/metrics.service';
import { MetricsExporterService } from './metrics/metrics-exporter.service';
import { CorrelationMiddleware } from './http/correlation.middleware';
import { ObservabilityRouteGuard } from './http/route-context.guard';
import { TenantEnrichmentInterceptor } from './http/tenant-enrichment.interceptor';

/**
 * Bounded observability foundation (SRS §27.6). Everything this module
 * provides is generic request/execution plumbing — no Sales/Identity/
 * Sync/Inventory business logic lives here, and nothing here queries the
 * database (§26 of the task brief: "Do not make logging depend on Prisma";
 * "Do not make metrics depend on tenant-specific database queries").
 *
 * Wired centrally (this module's `configure()` + global guard/interceptor)
 * rather than per-controller, so a future domain (D4-1B's Sync production
 * handlers, or any handler B1-3 adds) is observed automatically — see §29 of
 * the task brief.
 */
@Module({
  providers: [
    ObservabilityContextService,
    StructuredLoggerService,
    MetricsService,
    MetricsExporterService,
    { provide: APP_GUARD, useClass: ObservabilityRouteGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantEnrichmentInterceptor },
  ],
  exports: [
    ObservabilityContextService,
    StructuredLoggerService,
    MetricsService,
  ],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // A BARE path string (not `{ path, method: RequestMethod.ALL }`) is
    // deliberate: Nest's `RouterMethodFactory` maps `RequestMethod.ALL` to
    // Express's `app.all(path, fn)`, which internally calls
    // `Router.route(path)` — creating a genuine, introspectable Express
    // Route bound to every HTTP verb. That polluted `test/openapi.e2e-spec.ts`'s
    // live-route/OpenAPI-drift check with a spurious `/{*path}` entry the
    // first time this was wired this way. A bare string route resolves to
    // Nest's internal "no method" sentinel, which falls through to plain
    // `app.use(path, fn)` — ordinary connect-style middleware, no Route
    // object, invisible to route introspection, and (unlike a Route) still
    // invoked for a request that matches no controller at all, which this
    // middleware's completion-log path for a true 404 depends on.
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
