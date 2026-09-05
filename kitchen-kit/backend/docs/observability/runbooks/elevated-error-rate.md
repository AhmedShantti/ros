# Runbook: ROS Backend Elevated Error Rate

Alert: `ROSBackendElevatedErrorRate` (`docs/observability/alerts/backend-api.rules.yaml`)

> This runbook is operational guidance, not a governance document. The SRS and
> ratified governance decisions remain authoritative; this file is
> non-authoritative evidence/procedure only.

## What the alert means

The share of HTTP responses with `status_class="5xx"` across all endpoints
has exceeded 5% of total request rate for at least 5 minutes, measured from
the `http_requests_total` RED counter (`src/common/observability/metrics/metrics.service.ts`).
A 5xx is a server-side failure — an unhandled exception, a downstream
dependency failure, or a bug — never a client input error (those are 4xx and
do not count toward this alert).

## User impact

A meaningful fraction of API calls are failing server-side. Depending on
which endpoints are affected, this can mean failed orders, failed payments,
failed sync batches, or a broken dashboard. Treat as customer-impacting until
proven otherwise.

## Metric/query to inspect

```
sum(rate(http_requests_total{status_class="5xx"}[5m])) / sum(rate(http_requests_total[5m]))
```

Break down by route/handler to find the concentrated failure:

```
topk(5, sum by (route, handler) (rate(http_requests_total{status_class="5xx"}[5m])))
```

## First diagnostic steps

1. Identify the top offending `route`/`handler` from the query above.
2. Pull recent `event: "http.request.completed"` log lines with
   `statusClass: "5xx"` for that route (see "Using correlationId" below) and
   read the paired `error`-level application log lines around the same
   `correlationId` for the exception class/message.
3. Check whether the spike started at a deploy boundary (correlate with
   release timestamps) — a bad deploy is the most common cause.
4. Check the database (Postgres) for connection errors, lock contention, or
   an outage — `PrismaService` logs connection failures via the structured
   logger (`event: "nest.log"`).
5. Check whether the failures are tenant-concentrated (a single tenant's data
   triggering an edge case) or spread across tenants (systemic).

## Safe mitigations

- Roll back the most recent deploy if the spike correlates with it.
- If a single downstream dependency (e.g. the database) is the root cause and
  is itself being remediated, no backend-side mitigation may be needed beyond
  monitoring recovery.
- If a single tenant/route is responsible, consider whether a targeted
  circuit-breaker/feature-flag disable is appropriate (only if such a
  mechanism already exists — this slice does not add one).

## What NOT to do

- Do not silence or widen the alert threshold to make it stop firing.
- Do not restart the API process as a first response without first capturing
  logs — a restart destroys the in-memory evidence trail for the current
  incident.
- Do not disable the metrics exporter or logging to "reduce noise".

## Escalation

Escalate to the on-call backend engineer if the error rate has not begun
recovering within 15 minutes of first diagnosis, or if the root cause
implicates data integrity (partial writes, financial operations).

## Recovery verification

Confirm `ROSBackendElevatedErrorRate` has stopped firing and that
`sum(rate(http_requests_total{status_class="5xx"}[5m])) / sum(rate(http_requests_total[5m]))`
has been back under 5% for at least one full evaluation window (5m) before
closing the incident.

## Using correlationId to search logs

Every structured log line carries `correlationId` (SRS §27.6 NFR-OBS-001).
To trace one failing request end-to-end:

1. Take the `correlationId` from a `http.request.completed` line with
   `statusClass: "5xx"`.
2. Search the log stream for every line with that same `correlationId` — this
   surfaces every application log emitted during that one request's
   execution, in order, including the originating exception.
3. If the failure is part of a larger causal chain, use `causationId` (when
   non-null) to find the upstream request/operation that triggered it.
