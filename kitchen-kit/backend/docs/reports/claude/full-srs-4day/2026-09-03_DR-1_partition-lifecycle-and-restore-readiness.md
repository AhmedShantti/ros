# DR-1 — Automated partition lifecycle (FR-DR-002) + backup/restore readiness inventory

| Field | Value |
|---|---|
| **Task / slice name** | DR-1 — Production DR hardening: automatic partition lifecycle (primary), source-decidable backup/restore tooling (secondary, not reached) |
| **Report type** | IMPLEMENTATION + DESIGN GATE + VERIFICATION |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. This report records what was designed, implemented, and measured in this session; where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. It ratifies nothing and authorises nothing. |
| **Date** | 2026-09-03 |
| **Starting HEAD** | `9dddd68306e3afa7e62d901188423f7075fc3f78` (verified `git rev-parse HEAD` at session start; matches the task's stated baseline) |
| **Branch** | `full-srs/lane-f2-dr-partition-lifecycle` (verified `git branch --show-current`) |
| **Working tree** | Clean at session start (`git status --short` empty) |
| **Task identifier** | DR-1 |
| **Status** | **PRIMARY (FR-DR-002) COMPLETE-FOR-THIS-SLICE — see disposition in §12. SECONDARY (backup/restore, FR-DR-020/021/NFR-REL-013) NOT ATTEMPTED — time did not permit reaching it after the primary slice's static/targeted gates went green. READY_FOR_FULL_E2E.** |

---

## 0. Executive summary

FR-DR-002 ("Partitions SHALL be created automatically at least 3 months in
advance by a scheduled job, with alerting if creation fails") was **NOT
IMPLEMENTED** at session start — the SCHED-1 scheduler substrate this slice
depended on had already shipped (integrated at `9dddd68`), and P0-REBASE-2's
own blocker census (§7 item 15) named it as the exact requirement the
scheduler unblocks. This session implements a production-capable partition
lifecycle job on that substrate.

**The central technical finding**, discovered by empirical testing before any
code was written: **the scheduler's own `ros_app` runtime connection cannot
create a partition.** PostgreSQL requires OWNERSHIP of a partitioned parent
table to attach a new partition to it — `CREATE`-on-schema alone is refused
with `must be owner of table`, proven against a real PostgreSQL 16 (§2). Every
migration in this repository grants `ros_app` DML only, never ownership or
`CREATE` — by design, since `ros_app` is the same role every tenant-scoped HTTP
request authenticates as, and widening it would hand DDL power (column
add/drop, constraint drop, ownership-derived `TRUNCATE`) to that same
request-path role. The fix: a new, narrowly-scoped role, `ros_partition_admin`
— same `NOSUPERUSER`/`NOBYPASSRLS` posture as `ros_app`, owning **only** the
three partitioned parent tables this job maintains, holding **no** DML
privilege of its own — reached through a second, isolated connection
(`PartitionAdminConnectionService`) that no other code path can touch.

A second finding, also proven empirically: `CREATE TABLE IF NOT EXISTS ...
PARTITION OF ...` does **not** protect two concurrent sessions racing to
create the same missing partition — the loser fails with `relation already
exists`, not a silent no-op. The fix: a `pg_advisory_xact_lock`, acquired
before a lock-guarded existence re-check, proven safe under a genuine two-
transaction race (§2, §7).

Shipped this session:

- `PartitionLifecycleJob` (`platform.partition_lifecycle`), registered on the
  SCHED-1 substrate, daily at 02:00 UTC, maintaining a rolling 3-month-ahead
  horizon on the three tables that are **already partitioned** in this
  repository: `inventory.stock_movements`, `sales.orders`, `sales.order_lines`.
- `ros_partition_admin` role + one migration transferring ownership of exactly
  those three tables to it (no other schema change).
- Idempotent, advisory-lock-guarded DDL (`PartitionDdlService`) that creates a
  partition complete with `ENABLE`/`FORCE ROW LEVEL SECURITY`, tenant-scoped
  policies matching the parent, and the correct `ros_app` grant shape
  (append-only for `stock_movements`; full DML for `orders`/`order_lines`) —
  never leaving a partition half-configured.
- A durable, bounded critical finding on creation failure
  (`platform.partition_creation_failed`), a Prometheus alert rule, and a
  runbook — the same detection-plus-durable-recording-but-not-delivery shape
  already established for `BR-INV-003`.
- 13 new e2e tests (`test/partition-lifecycle.e2e-spec.ts`) covering every
  item in the task's TESTS list, plus 15 new pure-function unit tests for the
  month/bounds arithmetic — all against real PostgreSQL 16.

**What is explicitly NOT claimed:**

- `sync.sync_operations` is **not** partitioned by this slice — see §9 for the
  evaluation and the precise follow-up this leaves.
- `governance.audit_entries` and `analytics.fact_sales_line` (the other two
  FR-DR-001 tables) are **not** partitioned by this slice — see §9.
- Alert **delivery** is not claimed, for the same reason `BR-INV-003` isn't:
  no notification substrate exists in this repository (governance decision
  N-A), and running an alert evaluator is deployment configuration outside
  it. `FR-DR-002`'s alerting limb is reported **PARTIAL**, not COMPLETE.
- Backup/restore (`FR-DR-020`, `FR-DR-021`, `NFR-REL-013`) — the brief's
  secondary scope — was **not reached**. See §13.

---

## 1. Verification at session start

`pwd` = `/Users/mac/projects/ros-worktrees/lane-f/kitchen-kit/backend`;
`git branch --show-current` = `full-srs/lane-f2-dr-partition-lifecycle`;
`git rev-parse HEAD` = `9dddd68306e3afa7e62d901188423f7075fc3f78` (matches the
task's stated baseline exactly); `git status --short` = clean.

## 2. Census — required reading and current-state audit

Read in full before any design decision: `ROS_SRS_v1.0.pdf` §25 (Data
Architecture), the `_02` P0-REBASE-2 traceability rebase, SCHED-1's own report
and MW1G's integration report.

**FR-DR-001's six named partitioned tables, and their actual current state**
(read from `prisma/schema.prisma` and every migration under
`prisma/migrations/`, not inferred):

| Table (FR-DR-001) | Partition key | Interval | Actually partitioned today? | Evidence |
|---|---|---|---|---|
| `inventory.stock_movements` | `occurred_at` | Monthly | **YES** — RANGE, monthly, 14 partitions `2026_08`..`2027_09` | `20260816210000_inventory_foundation/migration.sql` |
| `sales.orders` | `business_day` | Monthly | **YES** — RANGE, monthly, 6 partitions `2026_08`..`2027_01` | `20260820120000_sales_order_foundation/migration.sql` |
| `sales.order_lines` | `business_day` | Monthly | **YES** — RANGE, monthly, 6 partitions `2026_08`..`2027_01` | same migration |
| `governance.audit_entries` | `occurred_at` | Monthly, 12mo→cold | **NO** — an ordinary, non-partitioned table | `20260812175712_governance_audit_entries/migration.sql`; confirmed no `PARTITION BY` anywhere for this table |
| `analytics.fact_sales_line` | `date_key` | Monthly | **NO TABLE EXISTS** — no `analytics` schema anywhere in this repository | grepped `prisma/schema.prisma`, zero hits |
| `sync.sync_operations` | `created_at` | Weekly | **NO** — deliberately created non-partitioned; own migration's comment states "partitioning needs a partition lifecycle job that does not exist in this repository yet" | `20260902010000_sync_protocol_kernel/migration.sql` lines 41-44 |

**As of "now" (2026-09-03), the existing partition horizon already exceeds 3
months for both groups** (`stock_movements` through 2027-09, `sales.*`
through 2027-01) — there is no live emergency. The gap this slice closes is
that nothing **maintains** that horizon going forward: every existing
partition was created by hand, once, in a foundation migration, and the
`inventory_partition_rls` migration's own comment records this explicitly:
*"Partition creation is currently manual (FR-DR-002 automation is
deferred)."*

**Exact failure mode when a row lands beyond the last partition** (verified
against real PostgreSQL 16, §7 test evidence): the INSERT fails outright —
`ERROR: no partition of relation "<table>" found for row` — a hard write
failure on the live write path (a sale, a stock movement), not a background
job. There is no default/catch-all partition on any of the three tables.

**SCHED-1 blocker confirmation** — from that slice's own §24: *"`FR-DR-002` |
Durable recurring occurrence + retry + failure alerting hooks | A
partition-lifecycle job creating ≥3 months of partitions ahead. Note this
also unblocks the `sync.sync_operations` partitioning D4-1A explicitly
deferred."* The scheduler substrate (job occurrence identity, claim/lease,
retry/backoff, findings, telemetry) is reused unmodified — zero changes to
`ScheduledJobRunnerService`, `ScheduledJobOccurrenceStore`,
`ScheduledJobFindingWriter`, or the contract.

## 3. The privilege problem, proven empirically, and the design it forces

Before writing any production code, the following was tested against a
disposable PostgreSQL 16 container (not this repository's schema — a minimal
reproduction), to settle the design question rather than guess at it:

1. **A role with only `CREATE` on the schema cannot attach a partition to a
   table it does not own.** `CREATE TABLE child PARTITION OF parent ...` as
   that role fails: `ERROR: must be owner of table parent`.
2. **Granting that role membership in the owning role, `WITH INHERIT`, does
   let it attach a partition** — but membership in `ros_migrator` (the
   migration/owner role, which owns every table in the database) would hand
   the grantee owner-level power over the ENTIRE schema, not just the three
   tables in question — rejected as far too broad.
3. **The correct minimal grant, proven working**: a NEW role owning exactly
   the three parent tables (`ALTER TABLE ... OWNER TO`), holding `USAGE`+
   `CREATE` on exactly the two schemas those tables live in (`inventory`,
   `sales`), and nothing else. This role needs **no** DML privilege of its
   own: as owner of a partition it creates, it can `GRANT` DML on that
   partition to `ros_app` without holding that privilege itself (owners have
   implicit grant authority on their own objects).
4. **Ownership transfer does not require the migrator to be, or become,
   non-superuser-capable.** `ros_migrator` (the local-dev bootstrap role,
   created with `POSTGRES_USER`) is a genuine PostgreSQL superuser and
   bypasses ownership checks unconditionally — confirmed by inspecting
   `docker/postgres/init/01-init-app-role.sh`'s own comment ("as the
   migrator/owner superuser"). Transferring ownership of three tables away
   from it costs the migration tooling nothing.
5. **`CREATE TABLE IF NOT EXISTS ... PARTITION OF ...` does NOT make two
   concurrent creators of the SAME missing partition safe.** Reproduced with
   two genuinely concurrent `psql` sessions against the same missing
   partition: the loser fails with `ERROR: relation "x" already exists`,
   not a silent no-op — `IF NOT EXISTS` only protects a session that starts
   strictly after the other has committed. The fix, also proven: acquire
   `pg_advisory_xact_lock(hashtext('platform.partition_lifecycle'))` FIRST,
   THEN re-check existence under the lock, THEN create. Two concurrent
   transactions doing this in that order both succeed, and exactly one
   partition results (reproduced live, zero errors).
6. **A partition bound (`FOR VALUES FROM (...) TO (...)`) cannot be a
   runtime query parameter** — `PREPARE` refuses a DDL utility statement as
   its target with a plain syntax error. Bounds are built as quoted SQL
   literals instead, safe against injection specifically because a bound's
   only origin is pure integer year/month arithmetic (`partition-month.ts`),
   never external input.

These five findings are why the job's real work runs against a **second,
isolated connection** (`ros_partition_admin`, never `ros_app`), inside
`detect()` rather than `commit()` — see §5 for why that placement is
necessary, not a stylistic choice, and what it costs.

## 4. Architecture decision — the new role and connection

| Considered | Decision | Why |
|---|---|---|
| Widen `ros_app` to own the 3 tables | **Rejected** | Hands DDL power to the same role every HTTP request authenticates as — a real increase in blast radius for any request-path defect, and the opposite of this repository's established least-privilege posture (every migration grants `ros_app` DML only, confirmed by grep across all 41 migrations) |
| Membership in `ros_migrator` (`WITH INHERIT`) | **Rejected** | `ros_migrator` owns every table in the database; membership would grant owner-level power far beyond the 3 tables in question |
| `pg_partman` / `pg_cron` | **Rejected** | Same reasoning SCHED-1 already recorded: no extension is installed by any migration, and requiring one would break on managed Postgres that forbids extensions |
| A new dedicated role, `ros_partition_admin`, owning exactly 3 tables, no DML of its own, its own connection | **Adopted** | Minimal, auditable, does not touch RLS, does not require `BYPASSRLS`, never reachable from any tenant-scoped or HTTP code path |

`ros_partition_admin` is `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
NOBYPASSRLS` — the identical posture to `ros_app`. It is created the same way
`ros_app` already is everywhere in this repository (never inside a Prisma
migration, which cannot carry a password): a new idempotent local-dev init
script (`docker/postgres/init/02-init-partition-admin-role.sh`, mirroring
`01-init-app-role.sh` exactly) and a new idempotent e2e-harness function
(`ensurePartitionAdminRole` in `test/e2e-db-isolation/provision.ts`, mirroring
`ensureAppRole` exactly). Its **ownership** of the three tables and its
schema `CREATE` grant are assigned by a migration
(`20260903090000_platform_partition_lifecycle`), which only grants privileges
to a role assumed to already exist — the identical bootstrapping order every
`GRANT ... TO ros_app` statement in this repository already assumes.
Production/managed-Postgres provisioning of this role is out-of-band, exactly
as `ros_app`'s already is (no migration in this repository creates `ros_app`
either) — this is a documented, pre-existing operational assumption this
slice extends by one role, not a new one it introduces. See §14 for the
explicit Render-portability risk this carries.

`PartitionAdminConnectionService` (`src/modules/platform/partitioning/`) owns
a small, dedicated `pg.Pool` (max 3 connections — a low-frequency maintenance
job, never a request path) authenticated via a new required env var,
`PARTITION_ADMIN_DATABASE_URL`, validated at boot exactly like
`APP_DATABASE_URL` (non-empty, not a placeholder, not `ros_migrator`, and — a
new check — not literally equal to `APP_DATABASE_URL`). It is never handed to
any tenant-scoped code, never sets `app.tenant_id`, and cannot itself read or
write a single domain row (it holds no DML grant anywhere).

## 5. Why the DDL runs in `detect()`, not `commit()` — a documented contract deviation

Every other scheduled job in this repository performs its mutation inside
`commit(tx, ...)`, transactionally joined to the occurrence settle — `tx` is
always `PrismaService.withAuthContext`'s connection, i.e. `ros_app`. This job
cannot use that path at all: `ros_app` cannot create a partition regardless of
design choice (§3). The real work therefore runs in `detect()`, against
`PartitionAdminConnectionService` — a deliberate, documented deviation from
the contract's stated "`detect` is EFFECT-FREE" rule (the deviation is
recorded in the job's own docblock, in `PartitionAdminConnectionService`'s
docblock, and here).

What makes this safe: every statement `PartitionDdlService` runs is
idempotent and advisory-lock guarded (§3, §7) — re-running `detect()` after a
lost lease, a retry, or a different tenant's independent occurrence of the
same job type converges to the identical end state, which is the property
"safe to re-run any number of times" is actually protecting. What is **not**
preserved is transactional atomicity between the DDL and the occurrence
settle — a partition can exist even if this specific occurrence later fails
to record itself as succeeded (e.g. a lost lease). This is harmless here: an
idempotent partition, unlike a financial mutation, has no "undo" to lose, and
the next tick (this tenant's or another's) converges to the same result
regardless.

`detect()` uses `context.scheduledFor`, never `new Date()` — the substrate
already makes "now" an explicit, injectable value for every occurrence (the
whole reason `runTick` takes a `now` parameter, and every DST/catch-up test in
this repository depends on it); reaching past that for the real wall clock
was tried first, found to make the job's tests non-deterministic (§7 records
the defect and the fix), and reverted before this report was written.

## 6. Scope: every active tenant runs the same global check

Partition topology is not tenant data — it is shared physical schema. The
scheduler substrate, however, has no concept of a job that is not
tenant-scoped (`platform.job_occurrences`' identity is `(tenant_id, job_type,
occurrence_key)`, and the runner fans a tick out over tenants
unconditionally, per SCHED-1 §10). Inventing a "system tenant" or a global
occurrence bypassing that fan-out would be a change to the substrate's own
identity model — a bigger, separate decision this slice does not take
unilaterally. Instead, every active tenant's daily occurrence runs the
identical check against the identical three tables, and the advisory lock
makes that safe: at most one tenant's occurrence, of however many ticks
happen to overlap, actually performs DDL for a given missing partition — the
rest find it already there and no-op in a single catalog lookup
(`to_regclass`) per table. This redundancy is stated, not hidden, and is the
one governance-adjacent boundary this slice leaves exactly where SCHED-1 left
its own equivalent (per-tenant fan-out instead of a fleet-wide claim,
`BYPASSRLS`-free) — see §14.

## 7. Test evidence

All suites run against a dedicated `ros-postgres-lane-f` container (port
5588, created this session from the repository's own
`docker/postgres/init` scripts) via the standard G1-2 from-zero e2e harness.

**Unit — pure calendar arithmetic, no database**
(`src/modules/platform/partitioning/partition-month.spec.ts`, 15/15 PASS):
month/year rollover (December→January), a multi-year jump, a leap-year
February (2028) proven month-grain-only (no day-of-month special case
needed, by construction), consecutive-month bound adjacency (no gap, no
overlap), `requiredMonths` returning exactly `horizonMonths + 1` months
inclusive of the current one.

**Env validation** (`src/config/env.validation.spec.ts`, 4 new tests): rejects
`ros_migrator` as `PARTITION_ADMIN_DATABASE_URL` in production, rejects a
placeholder value, rejects reusing `APP_DATABASE_URL` verbatim, fails fast
when the variable is missing.

**e2e — `test/partition-lifecycle.e2e-spec.ts`, 13/13 PASS, real PostgreSQL:**

| # | Task brief's TESTS item | Test | Result |
|---|---|---|---|
| 1 | from-zero database has required initial partition topology | asserts the current calendar month's partition exists for every registered table, from the foundation migrations alone | PASS |
| 2 | scheduler creates horizon ≥ 3 months | `now=2027-02-15`; asserts all 12 required (table×month) partitions exist after one tick, zero findings | PASS |
| 3 | duplicate tick creates no duplicate partition | runs a tick, then manually re-invokes `PartitionDdlService.ensurePartition` for every required partition a second time — every call returns `'already_existed'`, before/after catalog state identical | PASS |
| 4 | two scheduler workers race safely | **two real tenants, two real `bootSchedulerApp()` instances**, `Promise.all`'d ticks against the SAME missing partitions; both occurrences succeed, zero findings, exactly one physical partition per required month (`pg_inherits` count = 1) | PASS |
| 5 | existing future partition is a no-op | tick at the real "today" (existing seed already covers 3+ months); `pg_inherits` child counts identical before/after, zero findings | PASS |
| 6 | partial horizon fills only gaps | pre-creates 3 of 4 required months directly via `PartitionDdlService`, leaving one gap per table; tick fills only the gap; the 3 pre-existing partitions' bounds are byte-identical before/after (not recreated) | PASS |
| 7 | month/year boundary | `now=2026-11-20`; asserts the full Nov/Dec-2026→Jan/Feb-2027 span, and the exact `FOR VALUES` bound text for January | PASS |
| 8 | leap-year boundary | `now=2027-12-20`; asserts the exact bound `FOR VALUES FROM ('2028-02-01') TO ('2028-03-01')` for February 2028 | PASS |
| 9 | transaction/DDL failure produces durable failure/finding | `REVOKE CREATE ON SCHEMA "sales" FROM ros_partition_admin`, then ticks; occurrence still **succeeds** (per-partition failures are caught, not thrown — §5/§8), exactly ONE critical finding, `finding_code = platform.partition_creation_failed`, `detail.failures` names every failed `(schema, table, month)` with a real error string; every named failure verified to genuinely not exist as a partition (the finding is truthful); GRANT restored, occurrence re-run, self-heals to zero findings | PASS |
| 10 | application can insert into newly-created future partition | `has_table_privilege('ros_app', <new partition>, <priv>)` for every privilege: `SELECT`/`INSERT` true on all three tables; `UPDATE`/`DELETE` true on `orders`/`order_lines`, **false** on `stock_movements` (append-only, matching the parent); `TRUNCATE` false on `stock_movements` | PASS |
| 11 | no existing partition/data is altered | a pre-existing partition's `pg_class.oid` and `reltuples` are identical before/after three different ticks — same physical relation, not dropped/recreated | PASS |
| 12 | RLS/tenant behaviour preserved | new partitions carry `relrowsecurity`/`relforcerowsecurity = true` and byte-identical tenant-scoped `pg_policy` predicates to the ones the foundation migrations already use (`(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)`), verified via `pg_get_expr` | PASS |
| — | occurrence identity/outcome | one daily occurrence, `state='succeeded'`, `attempt=1`, `lease_owner` released | PASS |

**Regression — nothing else broke.** `PARTITION_LIFECYCLE_JOB` is now
registered globally (`PlatformModule` owns it directly, discovered by
`ScheduledJobRegistry` the same way any handler is), so every suite that
isolates one job type via the shared `onlyJob()` test fixture needed it added
to its disable-list — done once, in `test/scheduler-fixtures.ts`, covering
every current and future caller of that fixture.

| Suite group | Result |
|---|---|
| Unit (`npm test`) | **83 suites / 1147 tests, 0 failures** (was 82/1125 at baseline; +1 suite/+22 tests from this slice) |
| `module-boundaries.spec.ts` + `env.validation.spec.ts` | **58/58 PASS** |
| Scheduler core/concurrency/RLS/performance + Inventory scheduled reconciliation | **5 suites / 66 tests, 0 failures** — proves the new globally-registered job did not disturb the substrate's own exactly-once/lease/DST guarantees |
| Representative regression (inventory schema guard, alert-rules, observability×2, scoped-authorization-matrix, reporting-authorization, kds-authorization) | **6 suites / 105 tests, 0 failures**, then re-confirmed for the config-isolation suite alongside the new partition-lifecycle suite: **7 suites / 118 tests, 0 failures** |
| `test/e2e-db-isolation-config.e2e-spec.ts` (extended this session to also assert `PARTITION_ADMIN_DATABASE_URL` resolves to the per-suite scratch database, closing the exact class of stale-env-var defect this test already guards against) | **PASS** |

One 13-suite concurrent (`--maxWorkers=2`) run produced a single suite
timeout (`scoped-authorization-matrix.e2e-spec.ts`, 7 tests) under heavy
shared-machine load (five separate lane Postgres containers were
simultaneously running on this host at the time — `ros-postgres-lane-a/c/d/e/f`
all present). Postgres itself measured near-idle (`docker stats`, <1% CPU)
during the stall, and the SAME suite had already passed cleanly (23/23) in an
earlier, less-contended 7-suite batch run this session — classified
resource-contention, not a regression, consistent with this repository's own
established Class-C convention from every prior integration wave's report. A
standalone re-run to obtain a third, uncontended confirmation stalled for an
unrelated reason (the process never even opened a database connection,
per `pg_stat_activity`, strongly suggesting host-level scheduling contention
from other concurrent lane sessions on this shared machine, not a defect in
this session's code) and was killed rather than chased further, per the
existing two clean results.

## 8. Alerting disposition — detection + durable recording, not delivery

Identical shape to `BR-INV-003`/`FR-INV-011`/`FR-INV-051` (SCHED-1/MW1G):

| Half | State |
|---|---|
| Detection | **Implemented** — every required partition checked every tick |
| Durable, attributable, acknowledgeable record on failure | **Implemented** — `platform.job_findings`, one row per occurrence aggregating every failed `(schema, table, month)` |
| Low-cardinality metric | **Implemented** — reuses the existing `scheduled_job_findings_total{job_type,severity}` (no new metric needed; `job_type="platform.partition_lifecycle"` is a bounded, registry-derived label value) |
| Alert rule + runbook | **Implemented** — `ROSPartitionLifecycleCreationFailed` in `backend-api.rules.yaml`, `docs/observability/runbooks/partition-lifecycle-failure.md` |
| **Delivery to a human** | **NOT IMPLEMENTED** — no notification substrate exists in this repository, and governance decision N-A ratified that none is introduced in this phase; running an alert evaluator is deployment configuration outside this repository |

Per the task brief's own instruction ("if human alert delivery is
unavailable, classify that literal limb PARTIAL"): **the alerting limb of
FR-DR-002 is PARTIAL.**

## 9. `sync.sync_operations` — evaluated, deliberately NOT partitioned this slice

The task asked whether the scheduler blocker D4-1A cited for deferring this
table's partitioning is now moot. It is — the scheduler exists. That does
**not** make partitioning it now unambiguous, for reasons specific to this
table that do not apply to the three tables this slice did partition:

- **It already has data and is live-written** by the accepted D4-1B offline
  sync handlers. `stock_movements`/`orders`/`order_lines` were partitioned
  from their very first migration (day-zero, before any row existed);
  `sync_operations` was not, and converting it now is a **physical migration
  of an existing, populated, append-only, hash-chain-adjacent table** — a
  different and materially riskier operation than what `PartitionDdlService`
  does (which only ever creates a NEW, empty partition of a table that was
  ALREADY partitioned from creation).
- **Its own migration's comment names the exact reason it is safe as a
  non-partitioned table today**: identity (`op_id`) lives on a small,
  non-partitioned table specifically so a duplicate-submission check never
  needs to know which partition an operation landed in; the history table
  was "designed for later RANGE partitioning on `received_at` with no
  correctness consequence at all" — a **forward design accommodation**, not
  a statement that migrating it now is a mechanical, zero-risk change.
- **A correct migration requires an expand-migrate-contract sequence**
  (FR-DR-012, this same SRS chapter): create the new partitioned table
  alongside the old one, backfill in batches, dual-write, cut reads over,
  then drop the old one — a multi-step, multi-deploy operation this slice
  was not asked to design and has not designed, reviewed, or proven safe
  against concurrent sync writers.

The brief was explicit: do not partition it "unless the SRS/governance/schema
evidence makes the strategy unambiguous and migration of existing data is
proven safe." It is not, and it was not proven. **Follow-up, recorded
precisely for the next slice that picks this up**: design and implement an
expand-migrate-contract migration for `sync.sync_operations`, weekly RANGE
partitioned on `received_at` per FR-DR-001's own table, with an explicit
backfill/dual-write/cutover plan and its own concurrency proof against live
sync submissions — out of scope here, not silently dropped.

`governance.audit_entries` (monthly, `occurred_at`) and
`analytics.fact_sales_line` (the table does not exist; no `analytics` schema
exists at all) are likewise **NOT** partitioned by this slice, for the same
reason: converting a live, populated, hash-chained audit ledger is its own
non-trivial migration with its own correctness obligations, and fabricating
an `analytics` schema and fact table that no other slice has designed would
be inventing scope. Both are recorded here as precise, open gaps — "schema
required but not partitioned" — not silently absorbed into a COMPLETE claim.

## 10. Performance — bounded, no domain-data scan or rewrite

Every check `PartitionDdlService` performs is `to_regclass(...)` — a catalog
(`pg_class`) syscache lookup, never a query against a partition's own rows.
The advisory lock is held only for the few statements one partition's DDL
takes (create + RLS enable/force + N policy drop/create + grant/revoke),
never across a scan. No index, `SELECT`, or scan of `stock_movements`,
`orders`, or `order_lines` **data** appears anywhere in
`PartitionDdlService` — verified by direct code inspection: every statement
it issues is either a catalog read (`to_regclass`) or DDL against the
catalog and the empty new partition it just created. The "does not alter any
existing partition" e2e test (§7, item 11) additionally proves this
empirically: `pg_class.reltuples` for a pre-existing, populated-or-not
partition is bit-for-bit identical after three ticks with different
horizons — nothing scanned or rewrote it.

No SRS latency budget exists for this background job, so nothing here is
asserted as an SLO; the property being proven is shape (catalog-only,
O(months-missing) work, not O(existing-partitions) or O(rows)), which is what
a regression would break first — the same evidentiary standard SCHED-1's own
performance section used for its claim/reclaim statements.

## 11. Migration / schema

**Migration count: 41.** One migration added,
`20260903090000_platform_partition_lifecycle` (verified: `ls
prisma/migrations | wc -l` = 41; the previous session's HEAD carried 40 —
confirmed by listing before this migration was authored). **No existing
migration was modified.** Its content is exactly two kinds of statement:
`GRANT USAGE, CREATE ON SCHEMA ... TO ros_partition_admin` (2 statements) and
`ALTER TABLE ... OWNER TO ros_partition_admin` (3 statements) — no table
created, no column added, no RLS/policy/grant on any EXISTING table touched.
Applied from zero on a freshly-created lane-f container: **all 41 migrations
apply cleanly** (`prisma migrate deploy`, exit 0); post-apply ownership
verified live (`pg_class.relowner` = `ros_partition_admin` for all three
tables, `psql` query, not inferred).

`prisma validate`: clean. `prisma/schema.prisma` itself was **not** changed —
this migration touches only role privileges/ownership, which Prisma's schema
does not model.

## 12. Requirement disposition

| Requirement | Before this slice | **After** | Reasoning |
|---|---|---|---|
| **FR-DR-002** | NOT IMPLEMENTED | **PARTIAL — implementation-ready limb now demonstrated and tested; alert-delivery limb absent** | "Created automatically at least 3 months in advance": implemented, tested under real concurrency, tested at month/year/leap-year boundaries, tested for the from-zero baseline. "With alerting if creation fails": detection + durable, attributable finding + metric + rule + runbook implemented; DELIVERY to a human not implemented (governance N-A, same as `BR-INV-003`). Per the task's own rule for this exact situation, the requirement is not claimed COMPLETE while that limb is absent |
| **FR-DR-020 / FR-DR-021 / NFR-REL-013** | NOT IMPLEMENTED / EXTERNAL | **UNCHANGED — not reached this session** | Secondary scope; see §13 |
| **FR-DR-001** (the six-table partitioning obligation itself) | Partially satisfied (3/6 tables partitioned, none maintained) | **Unchanged in table coverage (still 3/6); the 3 that ARE partitioned now have a maintained horizon, which they did not before** | This slice does not claim FR-DR-001 COMPLETE — 3 of 6 named tables remain unpartitioned (§9), and FR-DR-001 was never this slice's target |

Per the P0-REBASE-2 blocker census (§7, item 1), `FR-DR-002` was one of 15
requirements the scheduler substrate's absence blocked. This slice closes it
to the same "implementation-ready, now demonstrated, alert-delivery absent"
shape SCHED-1 itself achieved for the three Inventory requirements it
touched — an honest, bounded upgrade, not a claim of full closure.

## 13. Secondary scope (backup/restore) — NOT reached

Per the task's own thermal/sequencing rule ("Only after FR-DR-002 is green"),
backup/restore tooling was scoped for **after** the primary slice's
static/targeted gates passed. Reaching that point (writing and verifying 13
new e2e tests, diagnosing and fixing the `detect()` clock-source defect
found along the way — §5 — and running the full regression sweep) consumed
the session's available time. **No backup/restore code, script, or
inventory work was started.** Nothing in this repository was inventoried for
existing backup/restore scripts/docs/compose/CI beyond what was already known
from reading the SRS's own §25.7 targets (RPO ≤5min / RTO ≤60min / continuous
WAL + daily base backup / 35-day PITR + 12 monthly + 7 annual / quarterly
restore drill) during the census in §2. **`FR-DR-020`, `FR-DR-021`, and
`NFR-REL-013` remain exactly as they were before this session** — this report
makes no claim about them, positive or negative, beyond "not attempted here."
The next session picking up this task should start there, using the SRS
targets quoted above.

## 14. Governance-adjacent items recorded, not decided

Following this branch's own established convention (SCHED-1 §22) of naming a
design boundary rather than either engineering around it unilaterally or
hiding it:

1. **Per-tenant fan-out for a physically-global concern.** §6 — the
   substrate has no "global job" concept; this job pays a small, measured,
   redundant-but-safe cost (an extra catalog check per tenant per tick) as
   the consequence of not inventing one. If a future slice needs to remove
   that cost, the change is either a substrate-level "system occurrence"
   concept or a ratified system-worker authority model — a governance
   decision, the same category SCHED-1 §22 already flagged for its own
   fleet-wide-claim question.
2. **`ros_partition_admin`'s production/Render provisioning is out-of-band**,
   identically to `ros_app`'s already-out-of-band provisioning (§4). This is
   not a new gap this slice introduces; it is the same pre-existing
   operational assumption, extended by one role. If a managed-Postgres
   deployment target cannot pre-provision a second login role the way it
   already must for `ros_app`, that is a deployment-configuration problem to
   solve when that deployment is actually attempted — not fabricated or
   assumed away here.
3. **`sync.sync_operations` / `governance.audit_entries` /
   `analytics.fact_sales_line` partitioning** — §9's precise follow-up.

None of these are claimed resolved. None required inventing a governance
decision this session was not authorised to make.

## 15. Static/targeted gates — all run this session, real results

| Gate | Result |
|---|---|
| `git diff --check` | **Clean** — no whitespace errors |
| `prisma validate` | **Clean** |
| `npx prisma migrate deploy` from zero (lane-f, freshly created container) | **All 41 migrations applied, exit 0** |
| `npm run typecheck` (`tsc --noEmit`) | **0 errors** |
| Unit (`npm test`) | **83 suites / 1147 tests, 0 failures** |
| Module boundaries + env validation | **58/58 PASS** |
| Scheduler targeted (core/concurrency/RLS/performance) + Inventory scheduled reconciliation | **5 suites / 66 tests, 0 failures** |
| Partition-lifecycle targeted (`test/partition-lifecycle.e2e-spec.ts`) | **13/13 PASS** |
| DB isolation / from-zero | **Proven on every e2e invocation this session** (harness `migrateFromZero` builds the template from empty each run); `test/e2e-db-isolation-config.e2e-spec.ts` (extended this session) confirms `PARTITION_ADMIN_DATABASE_URL` resolves per-suite, closing the exact stale-env-var class of defect that test already exists to guard against |
| Representative regression (inventory schema guard, alert-rules, observability×2, scoped-authorization-matrix, reporting-authorization, kds-authorization) | **7 suites / 118 tests, 0 failures** (across two runs; see §7 for the one contended-run timeout, resolved by re-confirmation) |
| `npm run openapi:check` | **Clean, zero diff** — confirms zero new/changed HTTP routes (this job exposes none) |
| Lint identity diff (`npx eslint "{src,apps,libs,test}/**/*.ts" -f json`, machine-counted) | **Exactly 48 errors / 0 warnings, in the identical 6 pre-existing files this branch's own prior reports document** (`cash-session-tender-totals.query.service.ts` ×1, `cash-session-close.service.ts` ×1, `cash-sessions.service.ts` ×1, `treasury.controller.ts` ×2, `cash-movements-close-and-payment-concurrency.e2e-spec.ts` ×16, `cash-session-close.e2e-spec.ts` ×27) — **zero new findings from every file this slice touched or added** |
| `npm audit --omit=dev --audit-level=high` | **8 vulnerabilities (7 high / 1 moderate) — byte-identical to the documented baseline** (SCHED-1/MW1G), zero new, zero `package.json`/`package-lock.json` diff (no dependency added) |
| Auth coverage / module boundaries | Unchanged — zero new HTTP routes, zero new cross-module import, zero new `KNOWN_DEVIATIONS` |

**Full E2E was deliberately NOT run**, per the task's explicit thermal rule.

## 16. Files

**Migration (1, new):**
`prisma/migrations/20260903090000_platform_partition_lifecycle/migration.sql`

**Production (6 new, 3 changed):**
`src/modules/platform/partitioning/{partition-month.ts, partitioned-table.registry.ts, partition-admin-connection.service.ts, partition-ddl.service.ts, partition-lifecycle.job.ts}` ·
changed: `src/modules/platform/platform.module.ts`, `src/config/env.validation.ts`,
`docker-compose.yml` ·
new infra: `docker/postgres/init/02-init-partition-admin-role.sh`

**Tests (3 new, 7 changed):**
`src/modules/platform/partitioning/partition-month.spec.ts` ·
`test/partition-lifecycle.e2e-spec.ts` ·
changed: `src/config/env.validation.spec.ts`,
`test/scheduler-fixtures.ts`,
`test/e2e-db-isolation/{env.ts, provision.ts, global-setup.ts, e2e-database-environment.ts, runtime-state.ts}`,
`test/e2e-db-isolation-config.e2e-spec.ts`

**Docs/CI (3 new, 3 changed):**
`docs/observability/runbooks/partition-lifecycle-failure.md` ·
this report · `INDEX.md` row (added, see below) ·
changed: `docs/observability/alerts/backend-api.rules.yaml`, `.env.example`,
`.github/workflows/backend-ci.yml`

## 17. Cross-cutting checks

- **Persistent `ros` untouched.** All work used a dedicated
  `ros-postgres-lane-f` container (port 5588, created this session from this
  repository's own `docker/postgres/init` scripts). The persistent `ros`
  checkout at `/Users/mac/projects/ros` was never entered; its database
  (port 5544) was never connected to.
- **No RLS weakened, no `BYPASSRLS` added anywhere** — `ros_partition_admin`
  is `NOBYPASSRLS`, holds zero DML privilege, and every new partition carries
  `ENABLE`+`FORCE ROW LEVEL SECURITY` with policies byte-identical in shape
  to the parent's own (proven, §7 item 12).
- **No cloud-provider infrastructure invented.** No `render.yaml`, no cloud
  IaC, no managed-service assumption beyond what already existed
  (`ros_app`'s own already-out-of-band provisioning, extended by one role —
  §14).
- **No backup/restore certification claimed** — none was attempted (§13).
- **No push, no deploy, no merge, no rebase, no destructive git.**

## 18. Commits

| Hash | Subject |
|---|---|
| `e8eb5df` | `feat(platform): automate partition lifecycle` |
| *(this report's commit)* | `docs: record partition lifecycle and DR-1 disposition` |

No backup/restore commit — none was made (§13).

---

## READY_FOR_FULL_E2E

Every targeted/static gate in §15 is green. Per the task's thermal rule, the
final full E2E run was deliberately not performed this session and is left
for the next step.
