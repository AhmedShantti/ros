# Runbook: ROS Backend Metrics Exporter Unavailable

Alert: `ROSBackendMetricsScrapeDown` (`docs/observability/alerts/backend-api.rules.yaml`)

> This runbook is operational guidance, not a governance document. The SRS and
> ratified governance decisions remain authoritative; this file is
> non-authoritative evidence/procedure only.

## What the alert means

Prometheus's own `up{job="ros-backend-metrics"}` has been `0` for at least 5
minutes — the scrape target (`MetricsExporterService`,
`src/common/observability/metrics/metrics-exporter.service.ts`) is not
responding to scrapes. This is a MONITORING-BLINDNESS alert: while it fires,
every other alert in this file is unreliable, because they all depend on the
same metrics stream.

## User impact

None directly — this alert says nothing about the API itself, only that its
health cannot currently be observed. Treat it as urgent anyway: it means
every other SLO alert is silently disabled until this is fixed.

## Metric/query to inspect

```
up{job="ros-backend-metrics"}
```

## First diagnostic steps

1. Confirm whether the API process itself is up (a separate liveness check,
   e.g. `GET /health`, not this metrics-specific alert).
2. If the API process is up but the exporter is unreachable, check whether
   `METRICS_PORT`/`METRICS_HOST` are configured as expected for this
   deployment — the exporter is DISABLED BY DEFAULT and only starts when
   `METRICS_PORT` is explicitly set (see that file's docblock; this is a
   deliberate default so test/dev environments never open an unconfigured
   port).
3. Check network reachability between the Prometheus scraper and the
   configured `METRICS_HOST:METRICS_PORT` (the exporter defaults to
   loopback-only binding — a scraper running on a different host requires an
   explicit non-default `METRICS_HOST` plus network-level access, which is
   deployment/IaC configuration this repository does not itself provide).
4. Check process logs for the `event: "nest.log"` line emitted by
   `MetricsExporterService` at startup confirming which host/port it bound
   (or that it stayed disabled because `METRICS_PORT` was unset).

## Safe mitigations

- If `METRICS_PORT` is missing from this deployment's configuration, that is
  the fix — set it and restart. This is a configuration correction, not a
  destructive action.
- If the process is otherwise healthy and only the exporter socket is stuck,
  a restart of the API process is acceptable (unlike the other runbooks,
  there is no in-flight financial operation risk specific to this alert).

## What NOT to do

- Do not treat this as an API outage and take API-side mitigations (rollback,
  scaling) without first confirming the API's own health independently.
- Do not open the exporter to a non-loopback interface without also applying
  network-level access control — it carries no application-level
  authentication (see the file's docblock for why that is an accepted
  trade-off contingent on network isolation).

## Escalation

Escalate to on-call infrastructure/platform if reachability looks like a
network/IaC misconfiguration rather than an application bug.

## Recovery verification

Confirm `up{job="ros-backend-metrics"}` has returned to `1` and stayed there
for at least one full evaluation window (5m), and that the other three alerts
in this file are evaluating normally again (not just quiet).

## Using correlationId to search logs

Not applicable to this alert specifically — it is a scrape-availability
signal, not a request-path failure. Once metrics are restored, use
`correlationId` as described in the other runbooks for any request-level
investigation needed.
