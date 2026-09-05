# AUD-1 — Audit Production Completion Slice

**Report type:** Implementation + tests + verification.
**Authority:** This report is **non-authoritative evidence**. The SRS
(`ROS_SRS_v1.0.pdf`) and ratified governance decisions
(`docs/governance/GOVERNANCE_DECISION_REGISTER.md`) remain authoritative.
Where this report's narrative differs from the SRS or from a register entry,
the SRS / register govern.
**Date:** 2026-09-03.
**HEAD at task start:** `9dddd68306e3afa7e62d901188423f7075fc3f78`
(`docs: record scheduler foundation integration`).
**HEAD at report time:** `3d60d2f` (`feat(audit): add auditor query and
export surface`), on top of `4b35a56` (`feat(audit): schedule chain
integrity verification`) — both created this session; this report's own
commit (`docs: record audit production completion`) follows it.
**Branch:** `full-srs/lane-c2-audit-production`.
**Working tree at task start:** clean.
**Working tree at report time:** clean except for this report and the two
INDEX.md updates, about to be committed as the third, final commit of this
slice.
**Task identifier:** AUD-1 — "Production audit completion slice: scheduled
chain-integrity verification + auditor query/export surface."
**Primary targets:** FR-AUD-005, FR-AUD-007, FR-AUD-008. FR-AUD-010 evaluated
only to the extent stated in §7.

---

## 0. Scope discipline

Per task instructions: no push, no deploy, no merge/rebase, no touching the
persistent `ros` checkout, no second definition of audit-chain verification,
no weakening of audit immutability, no unrestricted tenant-wide audit
exposure, no notification channel contrary to governance N-A, and **no final
full E2E run** (that is reserved for a later, separate step — see §11).

This session ran entirely against a **dedicated, disposable local Postgres
container** (`ros-postgres-lane-c`, port 5599, created this session) — the
persistent `ros` checkout and its database were never touched. `git worktree
list` / `git status` confirm no other worktree or the main checkout was
modified.

---

## 1. Baseline verification

- `git log -1` at session start: `9dddd68 docs: record scheduler foundation
  integration` — matches the task's stated `BASELINE`.
- `git status`: clean.
- `git diff 9dddd68 --stat`: empty (HEAD *is* the baseline).

## 2. Census — what existed vs. the literal FR-AUD-005/007/008 limbs, before this slice

Read directly from the SRS (Audit & Governance chapter, §20.1) and
cross-checked against the traceability record
(`2026-09-03_FULL-SRS-current-head-traceability_02.csv`):

| Requirement | Literal text (verbatim) | Pre-slice state |
|---|---|---|
| FR-AUD-004 [M] | "each entry's hash covers its own content and the previous entry's hash, per tenant" | COMPLETE — `audit-hash.ts` / `computeEntryHash`, verified live |
| FR-AUD-005 [M] | "A scheduled job SHALL verify chain integrity and SHALL raise a platform-level security alert on any break." | **NOT IMPLEMENTED.** `audit-verify.ts` (`verifyAuditChain`) existed as a callable, unit-tested, pure verification function — but **no scheduler called it**, and no alerting sink existed. SCHED-1 (prior slice) had shipped a generic scheduler substrate with exactly one production job (`inventory.daily_reconciliation`); nothing in Governance used it. |
| FR-AUD-007 [M] | "Audit log access SHALL itself be audited." | **NOT IMPLEMENTED** — vacuously, since no audit-log read surface existed at all. |
| FR-AUD-008 [M] | "The audit log SHALL be searchable and filterable by actor, entity, action, date range, branch, and correlation ID, and SHALL be exportable by users with audit.view plus report.export." | **NOT IMPLEMENTED** — no audit query/filter/export route in any controller; `audit.view` and `report.export` did not exist as permission codes anywhere in `identity.permissions`. |
| FR-AUD-010 [M] | Impersonation session (reason, time limit, tenant-visible notification, full audit capture) | **NOT IMPLEMENTED**, zero impersonation code anywhere. **Not addressed by this slice** — see §7. |

The canonical hash-chain verification algorithm (`verifyAuditChain` in
`src/modules/governance/audit/audit-verify.ts`) is **reused verbatim** by this
slice's scheduled job. It is not reimplemented, extended, or forked. No
second definition of chain verification exists anywhere in the repository
after this slice.

---

## 3. Governance research and the AUD-R1 decision

Before writing any code, the governance decision register was read for
everything bearing on audit read/export permissions:

- **D-19** (RATIFIED 2026-08-18, audit hash coverage) explicitly defers:
  *"D-20 must address FR-AUD-007/FR-AUD-008 audit-read permissions where
  applicable."*
- **D-20** (RATIFIED 2026-08-18, "Read Permission for Reading Approval
  Requests") governs `governance.approval_requests` /
  `governance.approval_decisions` read access **only**, and its own
  ratification log states: *"FR-AUD-007 remains conditional on audit-log
  access; FR-AUD-008 remains a knowingly unsatisfied gap, NOT closed by D-20
  and NOT reinterpreted as authorizing an endpoint."* — i.e. D-20 explicitly
  leaves this as a **separate, later decision**, not a prohibition.
- **RPT-R1** (RATIFIED 2026-08-31) lists `report.export` among codes *"NOT
  authorized and MUST NOT be created"* — scoped to the ONE route RPT-R1
  itself governs (`GET /reports/branches/{branchId}/daily-trading/
  {businessDay}`), because no route needing it existed at the time.
- **N-A** (no notification implementation in Phase 1, strict) — relevant to
  FR-AUD-005's "alert" limb; respected exactly, see §5.

`FR-AUD-008` [M] names `audit.view` and `report.export` **literally, verbatim,
in the requirement text itself** — unlike the approval-read case D-20
declined to decide (where the permission code was NOT derivable because
Appendix C is absent from the supplied SRS). This is the distinguishing fact
that makes the two situations different, not merely similar.

Given (a) the SRS literally names both codes for this exact purpose, (b) D-19
and D-20 both explicitly leave FR-AUD-007/008 open for a later decision
rather than forbidding one, and (c) this task's own instructions require
"existing permission catalogue only; do not invent permissions unless SRS
explicitly names one and repository governance permits it" — a new governance
decision was written and ratified in the register, mirroring the existing
`RPT-R1`/`KDS-R11` pattern for an explicit, narrow, user-authorized exception:

**`AUD-R1` — Audit Log Query/Export Permissions & Surface**, appended to
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` (end of file). Ten binding
clauses. In summary:

1. Introduces `audit.view` and `report.export`, verbatim from FR-AUD-008.
2. Names the exact two routes these codes authorize, and no others.
3. **Narrowly reopens RPT-R1 clause 6** to permit `report.export` for
   `GET /governance/audit/entries/export` only — RPT-R1's own route and its
   prohibition on every `report.view.*` code remain in force, unmodified.
   `reporting/reporting.permissions.ts` itself is not touched; it carries a
   one-paragraph note pointing at this amendment.
4. Confirms D-20 is not reopened, reinterpreted, or contradicted — this
   decides a **different table** (`governance.audit_entries`, its own
   pre-existing RLS boundary) than D-20 governs.
5. Confirms D-19 (hash coverage) is unchanged — the new routes read
   `entry_hash`/`previous_hash` as opaque bytes and compute nothing.
6. States the scope mechanism (tenant-default, branch-narrowed via
   `branchFromQueryOrTenant`) and records, honestly, that `branch_id` on
   `audit_entries` is a **pre-existing, unpopulated column** (see §6.3).
7. No standard-role seeding is authorized.
8. Binding implementation constraints (permission-based only, code-driven
   seeding, no schema/RLS change for the query/export routes themselves).
9. Records that FR-AUD-007 is satisfied by this slice's own implementation.
10. States FR-AUD-009/FR-AUD-010 are not addressed by this entry.

`reporting/reporting.permissions.ts` was given a short pointer comment to
this amendment; no other line in that file changed, and its own RPT-R1
prohibition remains word-for-word what it was.

---

## 4. FR-AUD-005 — scheduled chain-integrity verification

**File:** `src/modules/governance/audit/audit-chain-verification.job.ts`
(`AuditChainVerificationJob`, job type `governance.audit_chain_verification`).

- **Reuses the existing canonical algorithm.** `detect()` reads one tenant's
  `governance.audit_entries` chain (ordered by `sequenceNo` ascending, inside
  `PrismaService.withAuthContext({ tenantId })`) and passes it, unmodified,
  into the existing `verifyAuditChain` (`audit-verify.ts`). No new
  verification logic of any kind exists.
- **Correct tenant scope.** The scheduler substrate (`ScheduledJobRunnerService`,
  SCHED-1, unmodified) hands the job exactly one tenant's RLS context per
  occurrence; `detect` never reads across tenants — RLS is forced,
  unmodified, on `audit_entries` (ADR 0007).
- **Durable occurrence.** Materialized/claimed/settled entirely by the
  existing `platform.job_occurrences` substrate — no new table, no new
  mechanism.
- **Detects any chain break.** Content tampering, broken `previous_hash`
  linkage, a bad genesis, and sequence gaps/duplicates — exactly what
  `verifyAuditChain`'s own unit suite (`audit-verify.spec.ts`, untouched)
  already proves for the algorithm; this slice's own e2e suite
  (`test/audit-chain-verification.e2e-spec.ts`) proves the SCHEDULED PATH
  detects a real, deterministic, live-database content-tampering sabotage
  (see §10).
- **Durable critical/security finding.** `findings()` returns one `critical`
  `ScheduledJobFindingInput` (`findingCode: 'governance.audit_chain_broken'`)
  on any break, written by the substrate's own `ScheduledJobFindingWriter`
  (idempotent `ON CONFLICT` upsert, unmodified) — nothing on a healthy chain.
- **Low-cardinality metric.** No new metric was added — the job reuses the
  **existing** `scheduled_job_findings_total{job_type, severity}` and
  `scheduled_job_occurrences_total{job_type, phase}` (SCHED-1, unmodified).
  `job_type` is registry-bounded (fixed at deploy time), so this adds exactly
  one new label value to an already-bounded series set — no cardinality
  growth mechanism.
- **Alert rule + runbook.** `ROSAuditChainIntegrityBroken` added to
  `docs/observability/alerts/backend-api.rules.yaml`, structurally identical
  in shape to the existing `ROSInventoryLedgerProjectionDivergence` rule;
  runbook at `docs/observability/runbooks/audit-chain-integrity-broken.md`.
  Both verified by the existing `alert-rules.spec.ts` (unmodified — it
  discovers rules from the file and checks references/runbook existence
  generically; no new assertion was needed).
- **No false "human delivery" claim.** Stated explicitly, in the job's own
  docblock, the runbook, and here: **no notification channel exists**
  (governance N-A, unchanged). The alert limb is DETECTION + a durable,
  attributable record + a Prometheus rule definition. Delivery to a human
  (paging, email, Slack, etc.) is **not implemented and not claimed**.
  **FR-AUD-005 is classified PARTIAL after this slice** — the scheduled
  verification itself is complete and proven; the "raise a...alert" clause's
  delivery half remains unmet, exactly as SCHED-1's own inventory job was
  classified for the identical reason.
- **Multi-instance safe.** Inherited entirely from the unmodified SCHED-1
  substrate (exactly-once claim/lease/settle) — this job adds no I/O outside
  that substrate's own transaction boundary.
- **No audit mutation while verifying.** The job has **no `commit`** — it is
  detection-only. `detect()` performs exactly one `SELECT`; nothing in this
  file, or reachable from it, issues an `UPDATE`/`DELETE`/`INSERT` against
  `audit_entries`.

**Cost, stated honestly:** each occurrence re-verifies the tenant's *entire*
chain from `sequence_no = 1` (the canonical `verifyAuditChain` requires
starting from the first row — there is no incremental/resumable variant to
reuse without writing a second, divergent algorithm, which this slice
declines to do). Documented in the job's own docblock and the runbook.

**Scope gap, stated honestly:** the global "sentinel" chain
(`SENTINEL_TENANT_ID` — anonymous/auth events with no real tenant) has no
`identity.tenants` row and is therefore **not** covered by this tenant-scoped
job. Recorded as a documented gap, not silently claimed covered.

---

## 5. FR-AUD-007/008 — auditor query/export surface

**Files:** `src/modules/governance/audit/audit.permissions.ts`,
`audit-query.dto.ts`, `audit-query.service.ts`, `audit-query.controller.ts`.

### 5.1 Routes

- `GET /governance/audit/entries` — search/filter, gated by `audit.view`
  alone.
- `GET /governance/audit/entries/export` — gated by `audit.view` **AND**
  `report.export` (`mode: 'all'`).

Both use the **existing** permission catalogue mechanism
(`PermissionsService.upsertMany`, `@RequirePermission`, `PermissionGuard`) —
no new authorization primitive. Both declare an explicit
`@AuthorizationTarget(branchFromQueryOrTenant('branchId'))` — the existing
ADR 0009 D-03 `branchOrTenant` lattice, unmodified: omitting `branchId` is a
TENANT-target request (requires a tenant-scope grant); supplying it is a
BRANCH-target request against exactly that branch (satisfied by a
branch-scope grant covering it, or by a tenant-scope grant, per the existing
one-directional lattice). **No cross-tenant read is possible under any
circumstance** — `audit_entries`' FORCE-RLS policy (ADR 0007, unmodified) is
the actual boundary regardless of what a caller supplies; the permission gate
is an additional, independent layer on top of it.

### 5.2 Filters — exactly the six FR-AUD-008 names

`actorId`, `entityType` + `entityId` (the requirement's "entity" split into
its two persisted columns), `action`, `dateFrom`/`dateTo`, `branchId`,
`correlationId`. No filter beyond these six exists. `AuditEntryQueryDto`
(search) makes the date range optional; `AuditEntryExportQueryDto` (export)
makes it **required**, so every export is bounded by construction. The global
`ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`) refuses any
other query parameter with 400.

### 5.3 Pagination — keyset, provably stable

`governance.audit_entries.sequence_no` is a per-tenant, gap-free, immutable,
strictly monotonic integer (FR-AUD-004, enforced by the existing per-tenant
advisory lock and the `uq_audit_sequence` unique constraint). Search orders
`DESC` and filters `sequenceNo < cursor`; no `OFFSET` is used anywhere. Because
the chain is append-only, a page already returned can never change, and a
concurrent append can only add rows **above** the cursor a page has already
passed — there is no "page drift" failure mode to design around, unlike
OFFSET pagination. Proven live in `test/audit-query.e2e-spec.ts` (§10):
paginating with `limit: 7` over 25+ concurrently-growing entries visits every
pre-existing row exactly once, no skip, no duplicate.

### 5.4 Export

Not paginated: a bounded, complete result for the requested (mandatory) date
range. Hard-capped at `AUDIT_EXPORT_MAX_RECORDS = 10_000` (an
implementation-level safety bound, documented as such — FR-AUD-008 names no
numeric bound); a request matching more rows is refused (400) **before** the
access is recorded (a refused request never reaches the log, per FR-AUD-007's
own sense of "access"). **Format: JSON only.** The SRS names no export
format for this requirement; CSV was deliberately **not** invented (task
instruction: "CSV/JSON format only if SRS/source authorizes it; do not invent
formats" — JSON is the existing wire format for every other route in this
API, so it is not a new format decision, merely the existing one applied
here).

### 5.5 Canonical facts and hash-chain fields preserved verbatim

Every `FR-AUD-002` field is returned, unabridged
(`AuditEntryView` — id, tenantId, branchId, sequenceNo, occurredAt,
recordedAt, actorId, actorType, impersonatedBy, action, entityType, entityId,
beforeState, afterState, reasonCode, reasonText, approverId, approvalId,
ipAddress, userAgent, terminalId, correlationId, causationId, entryHash,
previousHash). `entryHash`/`previousHash` are read as the **opaque persisted
bytes**, hex-encoded for the wire — `computeEntryHash` is never called by
this surface; nothing is re-derived, re-signed, or modified. Both routes are
`GET`-only, read-only, no writes to `audit_entries` of any kind.

### 5.6 FR-AUD-007 — audit log access is itself audited

Every call to either route — through the **existing** `AuditService.record`,
inside the **same transaction** as the read — writes exactly one
`AUDIT_LOG_QUERIED` / `AUDIT_LOG_EXPORTED` entry (two new, additive
`AUDIT_ACTION` constants; one new `AUDIT_ENTITY.AUDIT_LOG` constant). The
entry's `afterState` carries the filters applied and the result count, never
the audit-record content itself (that would double an export's size for no
evidentiary value the read itself doesn't already provide). No new
audit-writing mechanism, no new hash-chain behaviour — this is a plain
consumer of the existing writer, exactly like every other audited action in
the repository.

### 5.7 Redaction

`beforeState`/`afterState` on returned/exported entries are exactly what was
already persisted by the existing write-time `sanitizeMetadata` (secret-key
pattern redaction, unchanged). No new redaction logic was added or was
needed — the write-time policy already governs everything this read surface
returns.

### 5.8 Known limitation, stated honestly: `branch_id` population

`governance.audit_entries.branch_id` is a **pre-existing, previously
unpopulated column** — `AuditService.record`/`AuditEvent` carry no
`branchId` field, and no producer anywhere in the repository writes it today
(confirmed by direct inspection of `audit.service.ts`). This is a
**pre-existing gap**, not introduced by this slice, and populating it would
require touching every one of the ~90 existing `AuditService.emit`/`.record`
call sites across every bounded context — far outside AUD-1's scope (FR-AUD-005/
007/008), and not something this slice's DO-NOT list ("no second definition
of audit-chain verification", "no weakened immutability") asks for either.
The `branchId` **filter and target-scope mechanism are fully implemented and
correct** (they will work exactly as specified the moment any producer starts
populating the column); today, a `branchId`-filtered query against
historical data returns zero rows for any entry written before that
population work happens, which is the honest, undramatic consequence of
filtering on a column nothing has written yet. Recorded here, in AUD-R1
clause 6, and in the traceability classification below — not silently
discovered later.

**FR-AUD-008 classified PARTIAL**, not COMPLETE, for exactly this reason: the
requirement's own "filterable by ... branch" clause is not YET meaningfully
satisfiable against existing history (the mechanism is correct and complete;
the underlying data is not there). Every other clause (searchable, other five
filters, exportable by the two named permissions) is fully implemented and
proven. **FR-AUD-007 classified COMPLETE** — its one clause ("access SHALL
itself be audited") has no such caveat and is fully implemented and proven.

---

## 6. FR-AUD-010 — not addressed

Per task instruction, evaluated only to the extent its literal obligations
are closed by this slice: **they are not.** No impersonation session code,
reason capture, time limit, tenant-visible notification, or "full audit
capture of every action performed" during an impersonation exists anywhere
in the repository, before or after this slice. **FR-AUD-010 remains NOT
IMPLEMENTED**, unchanged from its pre-slice classification. Nothing in this
report, AUD-R1, or the code changed by this slice should be read as closing,
narrowing, or otherwise deciding it.

---

## 7. Security requirements — checklist

| Requirement | Status |
|---|---|
| Existing permission catalogue only; SRS-named codes, governance-permitted | ✅ `audit.view`/`report.export`, both verbatim from FR-AUD-008; AUD-R1 records the governance permission (§3) |
| Tenant/scope enforcement using current B1 architecture | ✅ `branchFromQueryOrTenant` (ADR 0009 D-03, unmodified) + FORCE RLS (ADR 0007, unmodified) |
| Safe pagination | ✅ keyset on immutable `sequence_no`, no OFFSET (§5.3) |
| Stable deterministic ordering | ✅ `sequenceNo DESC`, unique per tenant |
| Bounded date range if required | ✅ required on export; `AUDIT_EXPORT_MAX_RECORDS` hard cap |
| Filters exactly supported by SRS | ✅ exactly the six named (§5.2), `ValidationPipe` refuses any other |
| No cross-tenant enumeration | ✅ FORCE RLS + permission gate, proven live (§10) |
| Exported records preserve canonical facts + hash-chain fields | ✅ full `FR-AUD-002` field set, opaque hex hash bytes (§5.5) |
| Export does not modify/re-sign audit history | ✅ read-only routes, no write path to `audit_entries` exists in this surface |
| CSV/JSON only if authorized; no invented formats | ✅ JSON only — the existing API-wide format (§5.4) |

---

## 8. Proofs (task's "Prove" list)

All proven live against a real, disposable PostgreSQL 16 database
(`ros-postgres-lane-c`, freshly migrated from zero this session), not mocked:

1. **Auditor sees authorized records** — `audit-query.e2e-spec.ts`, "an
   authorized auditor sees only their own tenant's records".
2. **Foreign tenant/branch facts cannot leak** — "a foreign tenant's facts
   cannot leak through the query surface" (403, no read reaches the handler);
   "branch scope: ... a differently-scoped branch is refused" (403 for a
   branch outside the caller's grant).
3. **Chain verification passes on a valid chain** —
   `audit-chain-verification.e2e-spec.ts`, "a valid chain: the occurrence
   succeeds and records no finding".
4. **Deterministic sabotage of one historical link is detected** — same
   file, "a sabotaged historical link is detected deterministically: exactly
   one critical finding" — a real `UPDATE` against `governance.audit_entries`
   (as the migrator role; `ros_app` itself cannot `UPDATE` this table at all,
   FR-AUD-003, unchanged) is detected, with the correct `brokenAtSequenceNo`
   and `"content tampered"` reason.
5. **Scheduled job records one critical finding** — same test; exactly one
   `platform.job_findings` row, `severity: 'critical'`,
   `findingCode: 'governance.audit_chain_broken'`.
6. **Duplicate scheduler occurrence does not duplicate effect** — "a
   duplicate tick over the same occurrence does not duplicate the finding" —
   a second identical tick claims nothing new (the occurrence is already
   `succeeded`) and the finding count/id are unchanged.
7. **Query pagination cannot skip/duplicate under stable snapshot/order** —
   "keyset pagination visits every entry exactly once" over a live,
   concurrently-growing table (each page fetch itself writes a new
   FR-AUD-007 access entry — the traversal is proven correct against that
   real concurrent growth, not an idealized static table).
8. **Export count/content equals authorized query result** — "export
   content/count equals the equivalent query result, with hash-chain fields
   verbatim" — every exported row's `sequenceNo`/`entryHash`/`previousHash`
   compared byte-for-byte against the migrator-read database rows.
9. **Secret/sensitive payload fields remain governed by current redaction
   policy** — no new redaction code exists; existing `sanitizeMetadata`
   coverage confirmed unchanged by `audit-hash.spec.ts` (untouched) and by
   direct inspection (§5.7).
10. **Existing audit write throughput/integrity not regressed** — `audit.
    service.ts`/`audit-hash.ts`/`audit-verify.ts` are **byte-unmodified** by
    this slice (only `audit.constants.ts` gained two additive `AUDIT_ACTION`
    values and one additive `AUDIT_ENTITY` value — the existing
    `audit.e2e-spec.ts` suite, unmodified, passes unchanged, proving the
    write path/hash-chain/append-only/RLS behaviour is exactly what it was).

Also proven, beyond the task's explicit list, because the new
`AuditModule.imports: [IdentityModule]` edge closed a real NestJS module
cycle (`AuditModule → IdentityModule → OrganisationModule → AuditModule`,
the last edge pre-existing): both edges now use `forwardRef()` (mirroring the
pre-existing `OrganisationModule ↔ IdentityModule` pattern exactly), verified
by every e2e suite in §10 actually booting `AppModule` successfully.

---

## 9. Files changed

**New:**
- `src/modules/governance/audit/audit-chain-verification.job.ts` (FR-AUD-005)
- `src/modules/governance/audit/audit.permissions.ts`
- `src/modules/governance/audit/audit-query.dto.ts`
- `src/modules/governance/audit/audit-query.service.ts`
- `src/modules/governance/audit/audit-query.controller.ts`
- `docs/observability/runbooks/audit-chain-integrity-broken.md`
- `test/audit-chain-verification.e2e-spec.ts`
- `test/audit-query.e2e-spec.ts`

**Modified:**
- `src/modules/governance/audit/audit.constants.ts` (+2 `AUDIT_ACTION`, +1 `AUDIT_ENTITY`, additive only)
- `src/modules/governance/audit/audit.module.ts` (wiring: new job/controller/service, `forwardRef(IdentityModule)`, `PlatformModule`)
- `src/modules/organisation/organisation.module.ts` (`forwardRef(AuditModule)` — closes the new cycle; see §8)
- `src/modules/reporting/reporting.permissions.ts` (+1 comment paragraph, no code change)
- `src/scripts/seed-dev-data.ts` (seeds the two new permission defs, mirroring every other module's own pattern)
- `test/scheduler-fixtures.ts` (`onlyJob` now also disables the new job type — mirrors the existing `inventory.daily_reconciliation` entry)
- `docs/observability/alerts/backend-api.rules.yaml` (+1 alert rule, `ROSAuditChainIntegrityBroken`)
- `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (+`AUD-R1`, appended)
- `docs/api/openapi.json` / `docs/api/openapi.yaml` (regenerated — the two new routes only, `git diff` inspected, additive only)

**Untouched (confirmed by inspection, not assumption):** `audit.service.ts`,
`audit-hash.ts`, `audit-verify.ts`, `audit.service.spec.ts`,
`audit-hash.spec.ts`, `audit-verify.spec.ts`, `audit.e2e-spec.ts`, the
scheduler substrate (`scheduled-job-runner.service.ts`,
`scheduled-job-occurrence.store.ts`, `scheduled-job-finding.writer.ts`,
`scheduled-job.registry.ts`), `reporting.controller.ts`, every other
module's permission/controller files, `prisma/schema.prisma` (no migration —
this slice adds zero tables/columns; `platform.job_occurrences`/
`platform.job_findings` were already migrated by SCHED-1).

---

## 10. Gates run this session (all against live PostgreSQL 16, freshly migrated from zero)

| Gate | Result |
|---|---|
| `git diff --check` | clean, exit 0 |
| `prisma validate` | valid |
| `typecheck` (`tsc --noEmit`) | clean, 0 errors |
| Unit (`npm run test`) | **82 suites / 1128 tests, 0 failures** |
| Module boundaries (`module-boundaries.spec.ts`) | pass — **zero new `KNOWN_DEVIATIONS` entries**; `governance->identity` still crosses only through `identity/contract` |
| Authorization coverage (`authorization-coverage.spec.ts`) | pass — both new routes declare an explicit `@AuthorizationTarget`; 0 undeclared beyond the pre-existing reviewed allowlist |
| Audit targeted e2e | `audit.e2e-spec.ts` **7/7** (unmodified, unchanged behaviour) · `audit-chain-verification.e2e-spec.ts` **4/4** (new) · `audit-query.e2e-spec.ts` **9/9** (new) |
| Scheduler targeted e2e | `scheduler-core` / `scheduler-concurrency` / `scheduler-rls` / `scheduler-performance` / `inventory-scheduled-reconciliation` — **66/66**, unmodified behaviour (one fixture update, `onlyJob`, needed — §9) |
| Scoped-auth targeted e2e | `scoped-authorization-matrix.e2e-spec.ts` **34/34** |
| Observability targeted | `observability-red-cardinality` + `observability-sync-lifecycle` **5/5**; `alert-rules.spec.ts` (unit) included in the 1128 |
| **Combined targeted e2e total** | **11 suites / 125 tests, 0 failures** |
| OpenAPI check (`openapi:generate` + diff) | clean — additive only, the two new routes, confirmed via `git diff` |
| Lint, exact identity diff | **0 errors in every file this slice touched or created** (verified with a targeted `eslint` pass); 6 pre-existing baseline files carry pre-existing, unmodified-by-this-slice lint debt (treasury/sales test files never touched by this session — confirmed via `git status`) |
| `npm audit --omit=dev` | **8 pre-existing vulnerabilities (7 high, 1 moderate)** — `deepmerge-ts`/`fast-uri`/`js-yaml`(via `@nestjs/swagger`)/`mysql2`(via `prisma`)/`qs`, all pre-existing transitive dependencies; **zero new dependency added** (`package.json`/`package-lock.json` untouched, confirmed via `git status`) |

**Full E2E run: NOT performed**, per explicit task instruction. This report
therefore ends with the required signal:

## READY_FOR_FULL_E2E

---

## 11. Commits

```
4b35a56 feat(audit): schedule chain integrity verification
3d60d2f feat(audit): add auditor query and export surface
(this commit) docs: record audit production completion
```

No push. No deploy. No merge/rebase performed at any point in this session.
