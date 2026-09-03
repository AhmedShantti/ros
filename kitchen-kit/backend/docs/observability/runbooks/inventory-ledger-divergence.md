# Runbook — `ROSInventoryLedgerProjectionDivergence`

**Alert:** the daily inventory reconciliation job recorded a critical finding.
**Severity:** critical. **Requirement:** BR-INV-003 / FR-INV-011 / FR-INV-051.

## What the alert means

BR-INV-003: *"The sum of all movements for an (item, location) pair SHALL equal
the `stock_levels` projection for that pair."* The scheduled job
`inventory.daily_reconciliation` compared them and they disagreed for at least
one pair.

This is a **correctness incident**, not a capacity one. The append-only movement
ledger and its projection are meant to be two views of the same fact; a
disagreement means one writer produced a value the other did not, and until you
know which, neither number can be trusted for that pair.

**Nothing has been auto-corrected.** The job is detection-only by design:
rewriting the projection to agree with the ledger would destroy the evidence
needed to identify the faulty writer.

## Find what diverged

The metric carries only job type and severity — a per-tenant label would be
unbounded cardinality. The authoritative record is the durable finding row:

```sql
SELECT job_type, occurrence_key, severity, finding_code, detail, detected_at
  FROM platform.job_findings
 WHERE finding_code = 'inventory.ledger_projection_divergence'
   AND acknowledged_at IS NULL
 ORDER BY detected_at DESC;
```

`detail` carries `divergenceCount` (the TRUE total) and `sample` (at most 50
pairs, each with `stockItemId`, `locationId`, `projected` and `ledger`). If
`sampled < divergenceCount`, the sample is a sample — re-run the on-demand
endpoint (`GET /inventory/reconciliation`) for the full list.

## Diagnose

For each diverging pair, reconstruct the ledger:

```sql
SELECT id, movement_type, quantity, balance_after, occurred_at, created_at
  FROM inventory.stock_movements
 WHERE stock_item_id = $1 AND location_id = $2
 ORDER BY occurred_at, id;
```

Then compare with `inventory.stock_levels.quantity_on_hand` for the same pair.
Look for:

- a movement whose `balance_after` does not equal the running fold — the
  projection and the ledger were written non-atomically;
- a projection value that no prefix of the ledger produces — a write that
  bypassed the movement path;
- a gap around a specific `occurred_at` — correlate with deploys and with the
  offline sync backlog (`sync.sync_operations`) for that branch.

## Do not

- Do not `UPDATE inventory.stock_levels` to make the numbers agree. That hides
  the defect and destroys the evidence.
- Do not acknowledge the finding until the cause is identified. Acknowledgement
  (`acknowledged_at` / `acknowledged_by`) means "a human has taken this on", and
  a re-detection of the same occurrence deliberately does not clear it.

## Known limitation — delivery

This rule defines an alert; it does not deliver one. Loading these rules into a
Prometheus/Alertmanager and routing the page is deployment configuration outside
this repository, and no email/SMS/push/chat channel exists in the application.
The alert limb of BR-INV-003 / FR-INV-011 / FR-INV-051 is therefore reported
**PARTIAL**, with detection and durable recording implemented and delivery not.
