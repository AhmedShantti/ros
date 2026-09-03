# Runbook — `ROSPartitionLifecycleCreationFailed`

**Alert:** the partition-lifecycle job recorded a critical finding.
**Severity:** critical. **Requirement:** FR-DR-002.

## What the alert means

FR-DR-002: *"Partitions SHALL be created automatically at least 3 months in
advance by a scheduled job, with alerting if creation fails."* The scheduled
job `platform.partition_lifecycle` attempted to ensure a required partition
existed for one of `inventory.stock_movements`, `sales.orders` or
`sales.order_lines`, and the attempt failed.

**This is time-sensitive.** Every table this job maintains is RANGE-partitioned
with no default/catch-all partition. Once the last existing partition's upper
bound passes, ANY insert whose partition key value falls beyond it fails
outright with `no partition of relation "<table>" found for row` — a hard write
failure on the live write path (a sale, a stock movement), not a background
job. The job runs daily and maintains a 3-month horizon specifically so a
single missed day is not an outage; a *sustained* failure is.

## Find what failed

The metric carries only job type and severity — a per-tenant label would be
unbounded cardinality. The authoritative record is the durable finding row:

```sql
SELECT job_type, occurrence_key, severity, finding_code, detail, detected_at
  FROM platform.job_findings
 WHERE finding_code = 'platform.partition_creation_failed'
   AND acknowledged_at IS NULL
 ORDER BY detected_at DESC;
```

`detail.failures` is an array of `{ schema, table, month, error }` — every
table/month this occurrence could not create a partition for, with the
underlying PostgreSQL error message.

## Check how much runway is left

```sql
SELECT n.nspname AS schema, p.relname AS parent,
       max(pg_get_expr(c.relpartbound, c.oid)) AS newest_partition_bound
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  JOIN pg_namespace n ON n.oid = p.relnamespace
 WHERE p.relname IN ('stock_movements', 'orders', 'order_lines')
 GROUP BY n.nspname, p.relname;
```

If the newest partition's upper bound is more than a few weeks away, there is
runway to diagnose calmly. If it is imminent (or already in the past), treat
this as an active incident: the next write past that bound will fail live.

## Diagnose

Common causes, roughly in likelihood order:

- **`ros_partition_admin` cannot connect** — `PARTITION_ADMIN_DATABASE_URL`
  misconfigured, credentials rotated without updating the deployment, or the
  role was dropped. Check application logs for
  `scheduler.occurrence.failed`/`handler_error` around this job type — a
  connection failure throws rather than being caught per-partition, so it
  surfaces as a retried/exhausted occurrence, not (only) a finding.
- **Ownership or grant drift** — `ros_partition_admin` no longer owns the
  parent table, or lost `CREATE` on the schema (someone ran a manual `ALTER
  TABLE ... OWNER TO` or `REVOKE`). Confirm:
  ```sql
  SELECT c.relname, r.rolname AS owner
    FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
   WHERE c.relname IN ('stock_movements', 'orders', 'order_lines');
  -- expect: ros_partition_admin
  ```
- **A manually-created partition with a colliding name but different bounds**
  — an operator (or a stale manual runbook) created
  `<table>_YYYY_MM` by hand with the wrong `FOR VALUES` range. The job's
  `CREATE TABLE IF NOT EXISTS` sees the name already exists and silently
  treats it as satisfied — but wrong bounds are a REAL gap this alert cannot
  see. Compare the bound shown by the query above against the calendar month
  its name implies.

## Recover

1. Fix the underlying cause (connectivity, ownership/grants, or a
   hand-created partition with wrong bounds).
2. Re-run the job manually (or wait for the next scheduled tick — the DDL is
   idempotent and safe to retry immediately) rather than creating the missing
   partition by hand: a hand-created partition risks exactly the bounds/RLS/
   grant drift the previous section describes.
3. Confirm the finding no longer reappears and the newest-partition-bound
   query above shows the full 3-month horizon restored.

## Do not

- Do not create the missing partition by hand under time pressure without
  matching this job's exact naming, bounds, RLS policies (`ENABLE`/`FORCE ROW
  LEVEL SECURITY` plus tenant-scoped policies) and `ros_app` grants — a
  hand-created partition missing RLS silently reopens the exact cross-tenant
  read defect `20260817090000_inventory_partition_rls` fixed. If you must,
  copy the DDL from `PartitionDdlService` exactly.
- Do not grant `ros_app` ownership of the parent table as a workaround. See
  `PartitionAdminConnectionService` for why that role is deliberately kept
  DDL-incapable.

## Known limitation — delivery

This rule defines an alert; it does not deliver one. Loading these rules into
a Prometheus/Alertmanager and routing the page is deployment configuration
outside this repository, and no email/SMS/push/chat channel exists in the
application. The alerting limb of FR-DR-002 is therefore reported **PARTIAL**,
with detection and durable recording implemented and delivery not — the same
disposition already recorded for BR-INV-003/FR-INV-011/FR-INV-051.
