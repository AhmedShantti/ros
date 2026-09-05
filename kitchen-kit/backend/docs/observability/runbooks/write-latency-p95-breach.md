# Runbook: ROS Backend Write Latency (p95) Breach

Alert: `ROSBackendWriteLatencyP95Breach` (`docs/observability/alerts/backend-api.rules.yaml`)

> This runbook is operational guidance, not a governance document. The SRS and
> ratified governance decisions remain authoritative; this file is
> non-authoritative evidence/procedure only.

## What the alert means

`NFR-PERF-031` requires write endpoints (`POST`/`PUT`/`PATCH`/`DELETE`) to
respond within 400ms at p95. The p95 of `http_request_duration_seconds`
across all such requests has exceeded 400ms for at least 5 minutes.

## User impact

Order creation, payment, sync batch submission, and other mutating
operations feel slow or risk client-side timeouts. Financially significant
endpoints (payment, fire) are the highest-priority routes to check first.

## Metric/query to inspect

```
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{method=~"POST|PUT|PATCH|DELETE"}[5m])) by (le))
```

Break down by route:

```
topk(5, histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{method=~"POST|PUT|PATCH|DELETE"}[5m]))))
```

## First diagnostic steps

1. Identify the top offending `route`/`handler`.
2. If the route is inside a `UnitOfWork.execute()` transaction
   (`src/common/domain-events/unit-of-work.ts`), check for lock contention —
   writes inside the same transactional boundary as domain-event recording
   are more sensitive to contention than plain reads.
3. Check for a correlated spike in write RATE (load-driven) vs. a flat-rate
   latency regression (code/query regression).
4. Check whether the breach started at a deploy boundary.
5. For sync batch routes specifically, also check `NFR-PERF-032` (batch of
   500 ops ≤ 3s p95) separately — this alert's threshold is the general write
   NFR, not the batch-specific one.

## Safe mitigations

- Roll back the most recent deploy if the regression correlates with it.
- No automatic mitigation (e.g. load shedding) exists in this slice —
  escalate for a manual decision if the breach persists.

## What NOT to do

- Do not raise the alert threshold to stop the page.
- Do not retry-storm a slow endpoint from tooling while diagnosing — this can
  worsen contention on an already-struggling write path.
- Do not apply a schema/index change mid-incident without review.

## Escalation

Escalate to the on-call backend engineer if p95 has not begun recovering
within 15 minutes, or immediately if the affected route is a financially
significant endpoint (payment, fire, cash session close).

## Recovery verification

Confirm `ROSBackendWriteLatencyP95Breach` has stopped firing and that the p95
query above has been back under 400ms for at least one full evaluation window
(5m) before closing the incident.

## Using correlationId to search logs

Take the `correlationId` from a slow `http.request.completed` log line and
search for every log line sharing that `correlationId` to see what the
request did internally (and, once domain-event handlers exist, which events
it caused — trace via `causationId`) during that time.
