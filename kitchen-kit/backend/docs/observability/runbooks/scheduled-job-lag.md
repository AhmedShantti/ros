# Runbook — `ROSScheduledJobLagBreach`

**Alert:** occurrences are being claimed more than 6 hours after their scheduled
instant, at p95, for 30 minutes. **Severity:** warning.
**SLO:** scheduled-job-timeliness.

## What the alert means

`scheduled_job_lag_seconds` measures the gap between an occurrence's
`scheduled_for` instant and the moment a worker claimed it. Lag is a separate
signal from duration: a daily verification job that runs in 200 ms, six hours
late, has not failed — but it is no longer answering the question it was
scheduled to answer, and any alert that depends on it is six hours stale.

Nothing is lost while this fires. Occurrences are durable rows; late work is
still done, with its original occurrence identity.

## Diagnose, in this order

1. **Is any instance actually ticking?** The heartbeat is disabled unless
   `SCHEDULER_ENABLED` is exactly `"true"`. A deploy that dropped the variable
   leaves every occurrence pending forever. Check for the
   `scheduler.heartbeat.enabled` log line at boot on at least one instance; a
   `scheduler.heartbeat.disabled` line on all of them is the answer.

2. **Are ticks erroring?** Look for `scheduler.tick.failed`. A tick that throws
   is logged and swallowed by design (durable state is unchanged and the next
   tick retries), so a persistently failing tick is silent apart from this log
   line and this alert.

3. **Is the tenant batch too small for the fleet?** One tick scans
   `SCHEDULER_TENANT_BATCH` tenants (default 100), round-robin. With
   `SCHEDULER_TICK_MS` at 30 s, a fleet of N tenants is fully swept every
   `ceil(N / batch) * tick` seconds. At 10 000 tenants that is 50 minutes per
   sweep — fine for a daily job, not fine if the batch has been lowered.

4. **Is claim throughput the limit?** `SCHEDULER_CLAIM_BATCH` caps occurrences
   claimed per tenant per tick. A tenant with a large catch-up backlog drains at
   that rate.

## Fix

- Restore `SCHEDULER_ENABLED=true` on the instances that should run it. Enabling
  it on **every** instance is the intended configuration — exactly-once comes
  from the occurrence primary key and the claim lease, not from electing one
  instance.
- Raise `SCHEDULER_TENANT_BATCH` or lower `SCHEDULER_TICK_MS`, then re-measure.
- Correct whatever `scheduler.tick.failed` is reporting.

## Do not

Do not "catch up" by deleting pending occurrences. They are the record of work
that was scheduled and has not happened.
