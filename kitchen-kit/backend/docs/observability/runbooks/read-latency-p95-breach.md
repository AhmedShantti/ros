# Runbook: ROS Backend Read Latency (p95) Breach

Alert: `ROSBackendReadLatencyP95Breach` (`docs/observability/alerts/backend-api.rules.yaml`)

> This runbook is operational guidance, not a governance document. The SRS and
> ratified governance decisions remain authoritative; this file is
> non-authoritative evidence/procedure only.

## What the alert means

`NFR-PERF-030` requires read (`GET`) endpoints to respond within 200ms at
p95. The p95 of `http_request_duration_seconds` across all `GET` requests has
exceeded 200ms for at least 5 minutes.

## User impact

Dashboard/reporting/POS read operations feel slow. Depending on which routes
are affected, this can degrade POS responsiveness (NFR-PERF-001 is a
stricter, separate client-side budget) or make back-office screens sluggish.

## Metric/query to inspect

```
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{method="GET"}[5m])) by (le))
```

Break down by route to find which endpoint(s) are slow:

```
topk(5, histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{method="GET"}[5m]))))
```

## First diagnostic steps

1. Identify the top offending `route`/`handler`.
2. Check for a correlated spike in database query latency or lock contention
   at the same time window (Postgres `pg_stat_activity`, slow query log if
   configured).
3. Check for a correlated spike in request RATE on the same route — latency
   growth under load can indicate a missing index or an N+1 query rather than
   an outright regression.
4. Check whether the breach started at a deploy boundary.
5. Check `http_request_duration_seconds_count` for the affected route to
   confirm the slow route is actually receiving traffic (a p95 computed from
   very few samples is noisy, not necessarily a real regression).

## Safe mitigations

- Roll back the most recent deploy if the regression correlates with it.
- If a specific query is identified as the cause, this runbook does not
  authorize a schema/index change mid-incident — escalate instead.

## What NOT to do

- Do not raise the alert threshold to stop the page.
- Do not add a caching layer or index under incident pressure without review.

## Escalation

Escalate to the on-call backend engineer if p95 has not begun recovering
within 15 minutes, or if a specific query/index is implicated and requires a
schema change to fix (schema changes are out of scope for an on-call
response).

## Recovery verification

Confirm `ROSBackendReadLatencyP95Breach` has stopped firing and that the p95
query above has been back under 200ms for at least one full evaluation window
(5m) before closing the incident.

## Using correlationId to search logs

Take the `correlationId` from a slow `http.request.completed` log line
(`durationMs` will show the actual measured duration) and search for every
log line sharing that `correlationId` to see what the request did internally
during that time.
