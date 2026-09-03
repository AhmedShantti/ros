# Runbook — `ROSScheduledJobFailures`

**Alert:** a scheduled job occurrence reached a terminal `failed` state.
**Severity:** critical. **SLO:** scheduled-job-success.

## What the alert means

`platform.job_occurrences` moved an occurrence to `state='failed'`. That happens
for exactly four reasons, and the row's `outcome_code` says which:

| `outcome_code` | Meaning |
|---|---|
| `attempts_exhausted` | The handler threw transiently on every attempt. |
| `permanent_error`, or a job-specific code | The handler threw `ScheduledJobPermanentError` — a validation or business-rule failure that retrying cannot fix. Terminal on the first attempt by design. |
| `lease_exhausted` | Every attempt was claimed and then abandoned (the worker died mid-execution) until the attempts ran out. |
| `unknown_job_type` | An occurrence exists for a job type this build no longer registers — a deploy/config defect. |

A failed occurrence is **not** retried further. It is durable evidence, and the
work it represents did not happen.

## Diagnose

1. Find the occurrences. Run as a tenant-scoped query (RLS applies):

   ```sql
   SELECT job_type, occurrence_key, attempt, max_attempts, outcome_code,
          scheduled_for, started_at, completed_at, duration_ms
     FROM platform.job_occurrences
    WHERE state = 'failed'
      AND completed_at > now() - interval '2 days'
    ORDER BY completed_at DESC;
   ```

2. Read the structured logs for the same window. The scheduler logs
   `scheduler.occurrence.failed` with `jobType`, `occurrenceKey`, `attempt`,
   `outcome`, `exceptionClass` and `errorMessage`. The exception class and
   message are deliberately **not** in the metric or the `outcome_code` column
   (unbounded cardinality, and a redaction hazard); the log line is where they
   live.

3. Classify:
   - `unknown_job_type` → a handler was removed or renamed while occurrences for
     it were still pending. Restore the handler or delete the orphaned
     occurrences deliberately; do not leave them failing silently.
   - `permanent_error` → a real domain defect. Fix the cause; the occurrence
     will not re-run on its own.
   - `attempts_exhausted` / `lease_exhausted` → infrastructure. Check database
     availability, statement timeouts, and whether the process is being killed
     mid-execution (an OOM kill looks exactly like `lease_exhausted`).

## Recover

There is no "retry" endpoint. To re-run a specific occurrence deliberately,
reset it under its tenant's context:

```sql
UPDATE platform.job_occurrences
   SET state = 'pending', attempt = 0, outcome_code = NULL,
       completed_at = NULL, next_attempt_at = now()
 WHERE tenant_id = $1 AND job_type = $2 AND occurrence_key = $3;
```

This is safe: the occurrence identity is unchanged, so nothing can double-run —
any instance that claims it takes the lease exclusively.

## Escalate

If failures span multiple tenants and multiple job types simultaneously, the
scheduler substrate itself is not the cause — look at database health first.
