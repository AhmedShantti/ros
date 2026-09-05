import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ObservabilityContextService } from '../context/observability-context';
import {
  CAUSATION_HEADER,
  CORRELATION_HEADER,
  resolveCausationId,
  resolveCorrelationId,
} from '../context/correlation';
import { MetricsService, classifyStatus } from '../metrics/metrics.service';
import { StructuredLoggerService } from '../logging/structured-logger.service';

const UNMATCHED = 'unmatched';

/**
 * Establishes the request's {@link ObservabilityContextService} store for the
 * ENTIRE request lifecycle (SRS §27.6) and owns the SINGLE request-completion
 * emission point (§7: "Do not duplicate one completion log in middleware AND
 * interceptor").
 *
 * Runs first, before any guard/interceptor, so correlation/causation exist
 * even for a request a guard later rejects (401/403) or that matches no
 * route at all (404). `ObservabilityRouteGuard` (a global `APP_GUARD`, which
 * therefore still runs before controller-level guards) fills in
 * `route`/`handler` on the SAME store for a request that matches a
 * controller; a request that never reaches a matched route keeps the
 * `"unmatched"` label, which is what all such probes/404s collapse onto
 * — never the raw, unbounded path (see `metrics.service.ts`'s cardinality
 * note).
 *
 * The completion log/metric fires from `res.once('finish', ...)`, which is
 * the actual bytes-sent status code and fires exactly once per response
 * regardless of which downstream layer (interceptor, exception filter,
 * Express's own 404 handling) produced it — so there is exactly one
 * measurement per request, never a double count between an interceptor and
 * an exception filter observing the same response (§19).
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(
    private readonly context: ObservabilityContextService,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLoggerService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    const causationId = resolveCausationId(req.headers[CAUSATION_HEADER]);
    res.setHeader(CORRELATION_HEADER, correlationId);

    const store = {
      correlationId,
      causationId,
      tenantId: null,
      branchId: null,
      route: null,
      handler: null,
      method: req.method,
      startedAtNs: process.hrtime.bigint(),
      completed: false,
    };

    this.context.run(store, () => {
      res.once('finish', () => {
        if (store.completed) return; // exactly-once guard
        store.completed = true;

        const durationNs = process.hrtime.bigint() - store.startedAtNs;
        const durationMs = Number(durationNs) / 1_000_000;
        const statusClass = classifyStatus(res.statusCode);
        const route = store.route ?? UNMATCHED;
        const handler = store.handler ?? UNMATCHED;

        this.metrics.recordRequest(
          { method: store.method, route, handler, statusClass },
          durationMs / 1000,
        );

        this.logger.logEvent(
          statusClass === '5xx' ? 'error' : 'info',
          'http.request.completed',
          `${store.method} ${route} -> ${res.statusCode}`,
          {
            method: store.method,
            route,
            handler,
            statusCode: res.statusCode,
            statusClass,
            durationMs: Math.round(durationMs * 100) / 100,
          },
        );
      });
      next();
    });
  }
}
