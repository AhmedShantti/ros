import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * RED metrics (SRS §27.6 NFR-OBS-003: "RED metrics (Rate, Errors, Duration)
 * per endpoint and per handler").
 *
 * ── LABEL DISCIPLINE — BOUNDED CARDINALITY ONLY ──────────────────────────────
 * Every label value here is drawn from a FIXED, small set fixed at deploy
 * time (HTTP methods, registered route templates, registered handler names,
 * four status classes) — never from per-request data (`tenantId`, `branchId`,
 * `userId`, `orderId`, correlation id, raw path, or an error message). The
 * total series count is bounded by
 * `(#methods × #route-templates × #handlers × 4 status classes)`, which is
 * fixed by how many endpoints this API registers, NOT by how many requests or
 * distinct resource ids it serves. See `metrics.service.spec.ts` for the
 * cardinality-sabotage proof (many distinct resource ids → same series).
 *
 * ── endpoint vs. handler (§9) ────────────────────────────────────────────────
 *   endpoint = `method` + `route` (normalized route TEMPLATE, e.g. `GET /orders/:id`)
 *   handler  = stable `Controller#method` identity (e.g. `OrdersController#getOrder`)
 * Both are separate labels on the same series, so either can be aggregated on
 * independently (`sum by (route)`, `sum by (handler)`) without conflating a
 * route served by two handlers (unlikely here, but not assumed) with a
 * handler reachable via more than one route.
 */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export function classifyStatus(statusCode: number): StatusClass {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  return '2xx';
}

export interface RequestMetricLabels {
  method: string;
  route: string;
  handler: string;
  statusClass: StatusClass;
}

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 2, 5,
];

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** RATE (+ ERRORS via `status_class`, 5xx independently selectable). */
  private readonly requestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests, labeled by method, normalized route, handler and status class.',
    labelNames: ['method', 'route', 'handler', 'status_class'],
    registers: [this.registry],
  });

  /** DURATION — buckets suitable for p50/p95/p99 via histogram_quantile. */
  private readonly requestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, labeled by method, normalized route, handler and status class.',
    labelNames: ['method', 'route', 'handler', 'status_class'],
    buckets: DURATION_BUCKETS_SECONDS,
    registers: [this.registry],
  });

  constructor() {
    // Process-level defaults (event loop lag, heap, fds) — bounded, no
    // request-shaped labels; standard prom-client behaviour.
    collectDefaultMetrics({ register: this.registry });
  }

  recordRequest(labels: RequestMetricLabels, durationSeconds: number): void {
    const labelValues = {
      method: labels.method,
      route: labels.route,
      handler: labels.handler,
      status_class: labels.statusClass,
    };
    this.requestsTotal.inc(labelValues);
    this.requestDuration.observe(labelValues, durationSeconds);
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
