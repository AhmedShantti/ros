# Runbook — `ROSAuditChainIntegrityBroken`

**Alert:** the scheduled audit hash-chain verification job recorded a
critical finding. **Severity:** critical. **Requirement:** FR-AUD-005 [M].

## What the alert means

FR-AUD-004: *"Audit entries SHALL be hash-chained: each entry's hash covers
its own content and the previous entry's hash, per tenant."* FR-AUD-005: *"A
scheduled job SHALL verify chain integrity and SHALL raise a platform-level
security alert on any break."*

The scheduled job `governance.audit_chain_verification` re-read one tenant's
entire `governance.audit_entries` chain, ordered by `sequence_no`, and
recomputed every entry's hash with the SAME algorithm the write path uses
(`computeEntryHash`, `audit-hash.ts`). The recomputed value disagreed with
what is stored, or the chain's linkage/ordering does not hold.

This is a **security incident**, not a capacity one. `audit_entries` is
append-only at the database grant level (`FR-AUD-003`, ADR 0007: the
application role holds no `UPDATE`/`DELETE`), so a broken chain is not an
application bug in the ordinary sense — it means the row content, or the
`entry_hash`/`previous_hash` bytes, differ from what the writer originally
produced. **Nothing has been auto-corrected.** The job is detection-only by
design: it has no `commit`, performs exactly one read, and writes nothing but
this finding.

## Find what broke

The metric carries only job type and severity — a per-tenant label would be
unbounded cardinality. The authoritative record is the durable finding row:

```sql
SELECT job_type, occurrence_key, severity, finding_code, detail, detected_at
  FROM platform.job_findings
 WHERE finding_code = 'governance.audit_chain_broken'
   AND acknowledged_at IS NULL
 ORDER BY detected_at DESC;
```

`detail` carries `tenantId`, `entriesVerified` (how far the chain was read),
`brokenAtSequenceNo` (the first `sequence_no` where verification failed, as a
string), and `reason` — one of:

- `sequence gap/disorder: expected N, got M` — a row is missing, duplicated,
  or out of order for this tenant's chain;
- `previous_hash does not link to the prior entry` — the stored
  `previous_hash` does not equal the prior row's `entry_hash`;
- `entry_hash does not match the recomputed hash (content tampered)` — one or
  more of the entry's own fields were altered after it was written.

## Diagnose

For the reported `tenantId` and `brokenAtSequenceNo`, inspect the row and its
immediate predecessor directly (requires the migrator/superuser role — the
application role has no ordinary reason to run this query, and it is
diagnostic, not a fix):

```sql
SELECT sequence_no, occurred_at, recorded_at, action, entity_type, entity_id,
       actor_id, actor_type, encode(entry_hash, 'hex') AS entry_hash,
       encode(previous_hash, 'hex') AS previous_hash
  FROM governance.audit_entries
 WHERE tenant_id = $1
 ORDER BY sequence_no
 LIMIT 5 OFFSET GREATEST($2::bigint - 3, 0);
```

Look for:

- a row whose columns look inconsistent with the surrounding narrative
  (e.g. a metadata shape unlike its neighbors) — possible direct database
  tampering, bypassing the application entirely (the application role itself
  cannot `UPDATE`/`DELETE` this table);
- a gap in `sequence_no` — correlate with deploy history and with any
  out-of-band data operation (a restore, a manual `INSERT` by a superuser
  role) around that time;
- whether the SAME finding re-detects on the next occurrence — a persistent
  break at the same `sequence_no` confirms it is not a one-off computation
  glitch.

## Do not

- Do not `UPDATE`/re-insert rows to make the chain agree. Rewriting history
  to pass verification defeats the entire purpose of a tamper-evident chain
  and destroys the evidence of what actually happened.
- Do not acknowledge the finding until the cause is identified and any
  necessary escalation (security incident process, access review) has
  started. Acknowledgement (`acknowledged_at`/`acknowledged_by`) means "a
  human has taken this on"; a re-detection of the same occurrence
  deliberately does not clear it.
- Do not assume a broken chain is always malicious. A restore from a partial
  backup, or a manual data-repair script run outside the application, can
  produce the identical symptom. Rule this out first from deploy/ops history
  before treating it as a compromise.

## Known limitations

**Delivery.** This rule defines an alert; it does not deliver one. Loading
these rules into a Prometheus/Alertmanager and routing the page is deployment
configuration outside this repository, and no email/SMS/push/chat channel
exists in the application. `FR-AUD-005`'s alert limb is therefore reported
**PARTIAL**: detection and durable recording are implemented; human delivery
is not.

**Scope.** The job verifies one tenant's own chain per occurrence
(`identity.tenants`-scoped, per FR-AUD-004's per-tenant chaining). The global
"sentinel" chain (`SENTINEL_TENANT_ID` — anonymous/unauthenticated auth events
with no real tenant, e.g. failed logins) has no corresponding tenant row and
is **not** covered by this job; verifying it remains a documented gap.

**Cost.** Each occurrence re-verifies the ENTIRE tenant chain from
`sequence_no = 1` — the canonical verification algorithm (`verifyAuditChain`)
requires starting from the first row, so no incremental/resumable variant
exists without writing a second, divergent verification routine, which this
slice deliberately does not do. `scheduled_job_duration_seconds{job_type=
"governance.audit_chain_verification"}` makes the growing cost visible over
time for a tenant with a very long-lived chain.
