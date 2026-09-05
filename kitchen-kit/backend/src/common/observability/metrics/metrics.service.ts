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

/**
 * SCHED-1 scheduled-job telemetry labels.
 *
 * BOTH label values are fixed at deploy time and neither can grow with traffic:
 *
 *   `job_type` is drawn from `ScheduledJobRegistry`, whose contents are the
 *   handlers this build registers — one per `@ScheduledJobHandlerFor` provider,
 *   known at bootstrap, unchanged until the next deploy.
 *
 *   `phase` is the closed `SCHEDULED_JOB_PHASE` enum.
 *
 * Total series is `#job_types x #phases`. Deliberately ABSENT, and never to be
 * added: `tenantId` (unbounded — one series per customer), `branchId`, any
 * occurrence key or UUID (unbounded — one series per day per tenant), and any
 * exception message (unbounded and a redaction hazard). Those belong on the
 * structured log line and in `platform.job_occurrences`, both of which are
 * governed by their own controls.
 */
export interface ScheduledJobMetricLabels {
  jobType: string;
  phase: string;
}

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 2, 5,
];

/** Background work runs longer than a request; buckets reach minutes, not seconds. */
const SCHEDULED_JOB_DURATION_BUCKETS_SECONDS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];

/** Lag buckets span a tick (seconds) to a missed day (tens of thousands of seconds). */
const SCHEDULED_JOB_LAG_BUCKETS_SECONDS = [
  1, 5, 15, 30, 60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400,
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

  /**
   * SCHED-1 — occurrence lifecycle counts. One series per (job type, phase).
   * `claimed`/`succeeded`/`failed`/`retry_scheduled` together give the RED
   * shape for background work that `http_requests_total` gives for requests.
   */
  private readonly scheduledJobOccurrences = new Counter({
    name: 'scheduled_job_occurrences_total',
    help: 'Scheduled job occurrence lifecycle transitions, labeled by job type and phase.',
    labelNames: ['job_type', 'phase'],
    registers: [this.registry],
  });

  /**
   * SCHED-1 — durable findings a scheduled job recorded, counted ONLY after the
   * transaction that wrote them committed. `severity` is the closed
   * `('info'|'warning'|'critical')` set; the finding CODE is deliberately not a
   * label (a job may define many, and a per-tenant count certainly is not one).
   * This is the metric an operator alerts on to learn that a verification job
   * found something; `platform.job_findings` is where they read what.
   */
  private readonly scheduledJobFindings = new Counter({
    name: 'scheduled_job_findings_total',
    help: 'Durable findings recorded by scheduled jobs, labeled by job type and severity.',
    labelNames: ['job_type', 'severity'],
    registers: [this.registry],
  });

  /** SCHED-1 — how long the handler took, per job type. */
  private readonly scheduledJobDuration = new Histogram({
    name: 'scheduled_job_duration_seconds',
    help: 'Scheduled job execution duration in seconds, labeled by job type.',
    labelNames: ['job_type'],
    buckets: SCHEDULED_JOB_DURATION_BUCKETS_SECONDS,
    registers: [this.registry],
  });

  /**
   * SCHED-1 — LAG: how far behind its scheduled instant an occurrence was when
   * a worker claimed it. This is the number that says whether the scheduler is
   * keeping up; duration alone cannot, because a job that runs in 200ms four
   * hours late is still four hours late.
   */
  private readonly scheduledJobLag = new Histogram({
    name: 'scheduled_job_lag_seconds',
    help: "Delay between an occurrence's scheduled instant and its claim, in seconds, labeled by job type.",
    labelNames: ['job_type'],
    buckets: SCHEDULED_JOB_LAG_BUCKETS_SECONDS,
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

  /** Count one occurrence lifecycle transition. */
  recordScheduledJobPhase(labels: ScheduledJobMetricLabels, count = 1): void {
    this.scheduledJobOccurrences.inc(
      { job_type: labels.jobType, phase: labels.phase },
      count,
    );
  }

  /** Observe a completed occurrence's handler duration. */
  recordScheduledJobDuration(jobType: string, durationSeconds: number): void {
    this.scheduledJobDuration.observe({ job_type: jobType }, durationSeconds);
  }

  /** Count a finding, AFTER the transaction that persisted it committed. */
  recordScheduledJobFinding(
    jobType: string,
    severity: string,
    count = 1,
  ): void {
    this.scheduledJobFindings.inc({ job_type: jobType, severity }, count);
  }

  /** Observe claim lag. Clamped at zero: a claim can never precede its slot. */
  recordScheduledJobLag(jobType: string, lagSeconds: number): void {
    this.scheduledJobLag.observe(
      { job_type: jobType },
      Math.max(0, lagSeconds),
    );
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
