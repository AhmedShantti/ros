# SCHED-1 — DURABLE SCHEDULER INFRASTRUCTURE + INVENTORY DAILY RECONCILIATION

| Field | Value |
|---|---|
| **Task / slice name** | SCHED-1 — Durable scheduler infrastructure + first production reconciliation job |
| **Report type** | IMPLEMENTATION + DESIGN GATE + VERIFICATION |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. This report records what was designed, implemented, and measured in this session; where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. It ratifies nothing and authorises nothing. |
| **Date** | 2026-09-03 |
| **Starting HEAD** | `92d470b4cbfb46e18cbad205561661d54c93420c` (verified `git rev-parse HEAD` at session start; matches the expected baseline) |
| **Resulting HEAD** | `fd595ab` (`docs:` commit for this report lands on top) |
| **Branch** | `full-srs/lane-e2-scheduler-foundation` (verified `git branch --show-current`) |
| **Working tree** | Clean at session start (`git status --short` empty) and clean after each commit. `.env` is gitignored and was never staged. |
| **Task identifier** | SCHED-1 |
| **Status** | **COMPLETE — substrate shipped, one production job shipped, 0 of the 15 blocked requirements marked COMPLETE** |

---

## 0. Executive summary — what changed, and what deliberately did not

A production-grade, PostgreSQL-backed scheduled-job substrate now exists in the
`platform` schema (migration 39), together with exactly ONE production job on
it: Inventory's daily ledger-vs-projection reconciliation.

**No requirement moved to COMPLETE.** The substrate makes 15 requirements
*implementable*; it closes none of them, and the Inventory requirements it does
touch stay **PARTIAL** because their alert-DELIVERY limb has no substrate in this
repository and inventing one was out of scope and forbidden. §23 states each
disposition individually; §24 lists what is now implementation-ready but still
not complete.

Three things were found and fixed during implementation that are worth naming
because they were real defects, not polish:

1. **`UPDATE ... FROM (SELECT ... LIMIT n)` does not bound a claim.** PostgreSQL
   planned the subquery on the inner side of a nested loop and re-executed it
   per candidate row; a claim asking for **1** occurrence took **7**. Replaced
   with `WITH ... AS MATERIALIZED`. Caught by the bounded-batch e2e test, not by
   review. (§6, §16)
2. **The single `OR`-predicate claim could not use either index** and degraded to
   `Seq Scan` + `Sort` over the whole occurrence table once history accumulated.
   Split into two index-aligned statements (due / abandoned). (§6, §16)
3. **A binary search over the day is not a correct local-slot resolver**, because
   the "has the local clock reached the slot" predicate is *not monotone* across
   a DST fall-back. Replaced with a two-offset construction plus a bounded search
   confined to the transition window. (§9)

---

## 1. The exact 15-requirement scheduler blocker census from P0-REBASE-2

Source: `docs/reports/claude/2026-09-03_FULL-SRS-current-head-traceability-rebase_02.md`
§7 blocker #1 ("No scheduler/background-job infrastructure anywhere in the
repository. Directly blocks 15 requirements measured this session ... Highest
fan-out single gap in the system"), cross-read against
`docs/reports/claude/2026-09-03_FULL-SRS-current-head-traceability_02.csv`
(733 rows; all 15 IDs located, none missing).

Note: this is the **`_02`** report and CSV. The earlier same-day
`2026-09-03_FULL-SRS-current-head-traceability-rebase.md` is explicitly
superseded by its own §0 and was not used.

| # | Requirement | Domain | Literal scheduling obligation (SRS substance, verbatim from the CSV) | Cadence / timing stated | Retry stated | Alert / escalation stated | Status before this slice | Does the substrate alone close it? | Separate domain job still required? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **BR-INV-003** | Business Rules — Inventory (§7.4) | "The sum of all movements for an (item, location) pair SHALL equal the stock_levels projection for that pair. A reconciliation job SHALL verify this **daily** and raise an **alert** on any divergence." | **Daily** | none | **YES** — "raise an alert on any divergence" | PARTIAL / PARTIALLY VERIFIED | **No** | **No — shipped in this slice** (detection limb) |
| 2 | **FR-INV-011** | Inventory (§11.3) | "Stock levels SHALL be reconcilable to the movement ledger at any point in time, and a scheduled job SHALL verify the reconciliation **daily** and **alert** on divergence." | **Daily** | none | **YES** | PARTIAL / PARTIALLY VERIFIED | **No** | **No — shipped in this slice** (detection limb) |
| 3 | **FR-INV-051** | Inventory (§11.6) | "A scheduled reconciliation job SHALL verify that the sum of movements equals the stock level projection for **every (item, location) pair**, and SHALL raise a **platform alert** on any divergence." | implied daily (BR-INV-003) | none | **YES** — "platform alert" | PARTIAL / UNVERIFIED | **No** | **No — shipped in this slice** (detection limb) |
| 4 | **FR-AUD-005** | Audit & Governance (§20.1) | "A scheduled job SHALL verify **chain integrity** and SHALL raise a **platform-level security alert** on any break." | not stated | none | **YES** — platform-level security alert | NOT IMPLEMENTED | **No** | **YES** — a Governance job wrapping the existing `audit-verify.ts` |
| 5 | **FR-DR-002** | Data Architecture & DR (§25.3) | "Partitions SHALL be created automatically **at least 3 months in advance** by a scheduled job, with **alerting if creation fails**." | recurring, ≥3-month horizon | none | **YES** — on creation failure | NOT IMPLEMENTED | **No** | **YES** — a partition-lifecycle job (also unblocks `sync.sync_operations` partitioning, deferred in D4-1A for exactly this reason) |
| 6 | **FR-SEC-061** | Security & Identity (§20.4) | "Data retention periods SHALL be configurable within statutory bounds, and a scheduled job SHALL **purge or anonymise** data past retention." | not stated | none | none | NOT IMPLEMENTED | **No** | **YES** — a retention job + a data-classification/retention-policy model that does not exist |
| 7 | **FR-RPT-002** | Reporting & Analytics (§19.2) | "The System SHALL maintain **pre-aggregated rollups at hourly, daily, weekly and monthly grain** for the core fact tables." | **hourly/daily/weekly/monthly** | none | none | NOT IMPLEMENTED | **No** | **YES** — plus a rollup schema and (per the CSV) a read replica; the substrate today supports only the `daily` cadence |
| 8 | **FR-RPT-040** | Reporting & Analytics (§19.5) | "The System SHALL support **scheduled report delivery by email and by mobile push**, with configurable recipients, schedule and format." | configurable | none | delivery **is** the requirement | NOT IMPLEMENTED | **No** | **YES** — and blocked additionally on an email/push substrate that does not exist |
| 9 | **FR-RPT-041** | Reporting & Analytics (§19.5) | "The System SHALL support a **daily digest ("morning brief") delivered at a configurable time**, summarising the prior business day." | **daily, configurable time** | none | delivery **is** the requirement | NOT IMPLEMENTED | **No** | **YES** — same delivery blocker; the substrate's per-tenant `timezone`/`local_time_of_day` is exactly the "configurable time" half |
| 10 | **FR-HRM-013** | Workforce / HR (§14.3) | "The System SHALL **project scheduled labour cost for the week** and compare it against a configurable target percentage of forecast sales." | weekly | none | none | NOT IMPLEMENTED | **No** | **YES** — plus the Workforce scheduling model (`scheduled_shifts`) and a forecast; the substrate has no `weekly` cadence yet |
| 11 | **FR-HRM-022** | Workforce / HR (§14.4) | "The System SHALL detect and flag: late arrival beyond a grace period, early departure, **missing clock-out**, clock-in outside the geofence, clock-in with no scheduled shift." | not stated (the *missing clock-out* limb needs a sweep) | none | "flag" | NOT IMPLEMENTED | **No** | **YES** — plus attendance/clock-event tables that do not exist |
| 12 | **FR-HRM-023** | Workforce / HR (§14.4) | "The System SHALL prevent a clock-in more than a configurable interval **before the scheduled shift start**." | request-time check | none | none | NOT IMPLEMENTED | **No** | **YES** — and arguably needs no scheduler at all (see §24 note) |
| 13 | **FR-INV-067** | Inventory (§11.8) | "The System SHALL compute a **suggested order quantity** using forecast_demand / safety_stock / target_level formulas over `average_daily_usage(last N days, day-of-week weighted)`." | implied periodic | none | none | PARTIAL | **No** | **YES** — a reorder/forecasting job plus the forecasting model |
| 14 | **FR-INV-069** | Inventory (§11.8) | "The System SHALL incorporate **known future demand** — scheduled events, catering orders, promotions — into the forecast where recorded." | implied periodic | none | none | PARTIAL | **No** | **YES** — depends on FR-INV-067 and on demand sources that do not exist |
| 15 | **IR-INT-030** | External Integrations (§23.4) | "The System SHALL generate a **daily journal export per branch** containing revenue by category, tax by rate, discounts, COGS, inventory movement value, cash by tender and expenses." | **daily, per branch** | none | none | NOT IMPLEMENTED · **EXTERNAL CERTIFICATION** | **No** | **YES** — and stays externally blocked (accounting-provider certification), independent of the scheduler |

**Reading of the census.** Only **three** of the fifteen (BR-INV-003,
FR-INV-011, FR-INV-051) name a job whose *entire* missing implementation was the
scheduler plus logic that already exists. Every other row needs a domain model,
a delivery channel, or an external dependency in addition. That is why this
slice ships one job and not fifteen, and why §23 upgrades nothing to COMPLETE.

---

## 2. Existing-infrastructure census — proven, not assumed

Every line below was established by reading the repository in this session, not
inferred.

| Primitive looked for | Present? | Evidence |
|---|---|---|
| Cron package (`node-cron`, `cron`) | **NO** | `package.json` dependencies + devDependencies enumerated in full; no cron package |
| `@nestjs/schedule` | **NO** | same |
| Bull / BullMQ / Agenda | **NO** | same |
| Redis (any client) | **NO** | same — `pg`, `@prisma/adapter-pg`, `prom-client` are the only infrastructure clients |
| `pg_cron` / `pg_partman` | **NO** | no `CREATE EXTENSION` in any of the 38 baseline migrations |
| Outbox table / worker | **NO** | SRS §25.1 names `platform.outbox`; no such table existed. Governance decision **N-A** ratified "no notification implementation in Phase 1 (strict) ... no channel, no in-app notification, no table, no endpoint, no permission, no event, no outbox, no queue, no worker, no scheduler" |
| Background processor / `setInterval` loop | **NO** | grep for `setInterval` across `src/`: matches are `MetricsExporterService` (none), test files, and a `sync.failpoint` — no production scheduling loop |
| **Advisory locks** | **YES** | `pg_advisory_xact_lock(hashtext($1), hashtext($2))` in `AuditService`, `OrdersService`, `SalesPaymentService`, `PinService`, `DayCloseService`, `CashMovementsService`, `CashSessionCloseService`. Well-established, per-entity, transaction-scoped |
| **Database lease / claim / reclaim** | **YES — the decisive precedent** | `sync.sync_batches` (migration 37) carries `lease_owner` / `lease_expires_at` / `attempt`, and `BatchReservationService.reserve` reclaims optimistically on the OBSERVED `(lease_owner, attempt)` pair. SCHED-1 reuses this exact shape rather than inventing one |
| `FOR UPDATE SKIP LOCKED` | **NOT used in production code** | grep: only referenced in `fifo-cost-ledger.ts` comments explaining why FIFO deliberately does **not** use it (deterministic ordering, blocking is correct there). No existing caller — SCHED-1 is the first, and its use is the opposite case (independent work units) |
| Retry / dead-letter infrastructure | **PARTIAL** | `serialization-retry.ts` (whole-transaction retry on 40001 inside `UnitOfWork`) — a *transaction* retry, not a *work-unit* retry. No dead-letter concept anywhere |
| Health / readiness integration | **MINIMAL** | `src/health/health.controller.ts` returns a static `{status:'ok'}`; no DB probe, no dependency surface to integrate with. Nothing added |
| Audit / event integration | **YES** | `AuditService` (hash-chained, advisory-locked) and the transactional `DomainEventsModule` (`UnitOfWork` + `@DomainEventHandler` + `DiscoveryService` registry) |
| Handler-registration pattern | **YES ×2** | `@DomainEventHandler` and `@SyncOperationHandlerFor`, both `DiscoveryService.createDecorator()` scanned once at `onModuleInit`. SCHED-1 follows this to the letter |
| **Existing reconciliation service** | **YES** | `src/modules/inventory/reconciliation/reconciliation.service.ts` — `reconcile(tenantId)` compares `SUM(stock_movements.quantity)` to `stock_levels.quantity_on_hand`, grouped by `(stock_item_id, location_id)`, returning every divergence. Its own docblock states "The project has no scheduler, job runner, outbox or notification channel, and D-INV-08 forbids inventing one. So the LOGIC lives here" |
| On-demand reconciliation endpoint | **YES** | `GET /inventory/reconciliation` → `ReconciliationService.reconcile` |
| Business-day / timezone resolution | **YES (forward direction only)** | `src/modules/sales/orders/business-day.ts` — `resolveBusinessDay(instant, zone, cutoverFor)`. `org.branches.timezone` is an IANA zone. **No inverse** (local slot → instant) exists anywhere |
| Scripts that are NOT runtime scheduling | **YES** | `scripts/db/sweep-stale-scratch-databases.ts` (test-harness cleanup), `src/scripts/seed-dev-data.ts`, `generate-openapi.ts`, `sign-country-pack.ts`. None is production scheduling |
| Alerting mechanism | **PARTIAL** | `docs/observability/alerts/backend-api.rules.yaml` (Prometheus rules) + `docs/observability/runbooks/*`, validated structurally by `alert-rules.spec.ts`. G1-3's own report reports `NFR-OBS-006` **PARTIAL**, and the file states deployment of an evaluator is outside the repository |
| Notification delivery (email/SMS/push/chat) | **NO — and ratified as out of scope** | Governance decision **N-A**, quoted above |
| Ratified worker/system authority model | **NO** | Register grep for worker / system actor / service account / BYPASSRLS: `FR-PLT-011` is ratified — "the application database role SHALL NOT have BYPASSRLS"; `ros_app` measured `bypassrls=false`; register asserts "**No cross-tenant read is possible**" |
| `identity.tenants` RLS | **NONE — pre-existing** | Not in `20260812145207_identity_rls`; no `ENABLE ROW LEVEL SECURITY` on it in any of the 39 migrations. `TenantsService.find/update` already reads/writes it outside any tenant context (login must resolve a tenant *before* a context exists) |

**Architecture/dependency rules read before choosing anything:**
`src/modules/module-boundaries.spec.ts` (only `<other>/contract`,
`<other>/contract/*` and `<other>/<other>.module` are legal cross-module
imports; everything else needs a `KNOWN_DEVIATIONS` entry), `eslint.config.mjs`
(`no-console` banned in `src/**` runtime code), `package.json`,
`package-lock.json`.

---

## 3. Architecture decision

**PostgreSQL-backed, in the `platform` schema, with no new dependency.**

| Considered | Decision | Why |
|---|---|---|
| Redis + BullMQ | **Rejected** | Neither exists in `package.json`. The brief forbids adding infrastructure "merely for convenience unless it already exists and is the established project pattern" — it is neither |
| `pg_cron` / `pg_partman` | **Rejected** | No extension is installed by any migration, and requiring one would break on managed Postgres that forbids extensions. Evaluating the schedule in application code from durable rows behaves identically everywhere |
| Reuse `sync.sync_batches` | **Rejected as a table, adopted as a pattern** | A sync batch is a client-submitted unit of work with a client-chosen id; a scheduled occurrence is server-derived from a schedule and has no submitter. Overloading one table would conflate two authorities. Its `(lease_owner, lease_expires_at, attempt)` **shape** is reused exactly |
| A new `platform` schema | **Adopted** | SRS §25.1 names it verbatim: `platform` → "outbox, **jobs**, notifications, feature_flags, migrations". Only the `jobs` half is created; the rest belong to undesigned slices |
| Process-local `setInterval` as the scheduler | **Rejected as the mechanism, retained as a poll** | See §7 |

**Module shape.** `src/modules/platform/` with a public `contract/` and a private
`scheduler/`. It ships **zero** job handlers and imports **zero** domains: a
domain becomes schedulable by declaring a provider carrying
`@ScheduledJobHandlerFor` in its own module, discovered via `DiscoveryService`
at `onModuleInit` — the pattern `@DomainEventHandler` and
`@SyncOperationHandlerFor` already established. `InventoryModule` therefore
imports `platform/contract` and `platform.module` only. **Zero new
`KNOWN_DEVIATIONS`** (§25).

---

## 4. Durability model (design property A)

Two durable sources, and the *absence* of a row is meaningful in neither
direction:

1. **`platform.job_schedules`** — the per-tenant override: `enabled`, `cadence`,
   `timezone` (IANA), `local_time_of_day` (minutes since local midnight),
   `catch_up_limit`.
2. **The handler's registered `defaultSchedule`** — a code constant, validated at
   bootstrap (`ScheduledJobRegistry` throws on a malformed zone, an out-of-range
   minute-of-day, an out-of-range catch-up horizon, or `maxAttempts < 1`).

A tenant with **no** row uses the default, so a tenant onboarded while the
scheduler is running is never silently unscheduled — the failure mode a
schedule table alone would have. A restart loses nothing: no schedule, no
occurrence, no lease and no attempt count lives in process memory.

**Cadence vocabulary is deliberately one value: `daily`.** No cron dialect is
parsed anywhere. The SRS says "daily" and "at a configurable time"; it never
names a cron expression, and inventing one would be inventing semantics no
source states. `ck_job_schedules_cadence` enforces this at the database.

---

## 5. Occurrence identity (design property C)

**`PRIMARY KEY (tenant_id, job_type, occurrence_key)`** on
`platform.job_occurrences`. Uniqueness is PostgreSQL's, not the application's —
proven by test **A2**, which inserts a duplicate identity directly through the
owner client and is refused.

`occurrence_key` is the occurrence's **local wall-clock slot**, rendered
`YYYY-MM-DDTHH:MM` in the schedule's own IANA zone. Three properties follow:

- **Derivable without coordination.** Any instance, on any host, in any server
  timezone, computes the same key from the same durable schedule and the same
  wall clock. No leader election, no shared counter.
- **Fixed-width and lexicographically chronological** (unit-tested), so the
  database index orders it correctly.
- **One occurrence per local day even across a DST fall-back.** Keying on the
  *instant* would produce two occurrences of a once-a-day job, because the same
  local slot maps to two UTC instants. Keying on the *slot* makes "once per local
  day" true by construction. `scheduled_for` records which instant was chosen, so
  the resolution is auditable afterwards.

The tenant, the job type and the scheduled occurrence are therefore all part of
the identity, which is what makes a retry and a duplicate claim idempotent.

---

## 6. Lease / claim / reclaim algorithm (design property B)

One tick, per tenant, inside **one** `withAuthContext({ tenantId })`
transaction:

1. **Reap** — `reapExhausted`: occurrences with `attempt >= max_attempts` that
   are `running` with an expired lease, or `pending` past their gate, go
   terminally `failed` with `lease_exhausted` / `attempts_exhausted`.
2. **Resolve schedules** — one `findMany` over the tenant's override rows,
   merged with the registry defaults.
3. **Materialise** — ONE set-oriented multi-row
   `INSERT ... ON CONFLICT (tenant_id, job_type, occurrence_key) DO NOTHING`.
4. **Claim** — two index-aligned statements (below), bounded by `claimBatch`.

Each claim statement:

```sql
WITH picked AS MATERIALIZED (
  SELECT c.tenant_id, c.job_type, c.occurrence_key
    FROM platform.job_occurrences c
   WHERE c.tenant_id = $1 AND c.state = $2 AND <gate> AND c.attempt < c.max_attempts
   ORDER BY <gate column>, c.job_type, c.occurrence_key
   FOR UPDATE SKIP LOCKED
   LIMIT $n
)
UPDATE platform.job_occurrences o
   SET state='running', lease_owner=$owner, lease_expires_at=$exp,
       attempt=o.attempt+1, started_at=$now
  FROM picked
 WHERE o.tenant_id=picked.tenant_id AND o.job_type=picked.job_type
   AND o.occurrence_key=picked.occurrence_key
RETURNING ...
```

**Two statements, not one `OR`.** The two eligible populations are found by two
different columns — `pending`/`next_attempt_at` and `running`/`lease_expires_at`.
As a single `OR`, PostgreSQL can use neither index and degrades to
`Seq Scan` + `Sort` over the whole occurrence table, which grows forever (one row
per tenant per job per day) while the eligible set stays tiny. Split, each
statement matches an index exactly. `FOR UPDATE` also cannot be combined with
`UNION`, so two statements is the only form that keeps the row locking. Due work
is claimed first; the remaining budget goes to reclaims.

**`AS MATERIALIZED`, not a subquery in `FROM` — a correctness fix.** The first
implementation used `UPDATE ... FROM (SELECT ... LIMIT n) picked`. PostgreSQL 16
planned the subquery on the inner side of a nested loop and **re-executed it per
candidate outer row**, so the `LIMIT` capped each execution rather than the
statement: `claimBatch: 1` claimed **7** occurrences. Reproduced standalone in
`psql` (5 rows inserted, `LIMIT 1`, `UPDATE 5`) before the fix, and `UPDATE 2`
for `LIMIT 2` after. An unbounded claim is precisely the catch-up storm the
design forbids, so this is a correctness property, not a tuning choice.

**Why this is exactly-once.** The CTE takes row locks with
`FOR UPDATE SKIP LOCKED`, so a racing worker never even sees the same candidate
— it skips rather than blocking and then re-reading a row whose state changed
underneath. The `UPDATE` then moves the row out of its state (a second claim in
the same instant finds nothing) and increments `attempt` (the previous owner of
a reclaimed occurrence can never settle it again).

**Reclaim.** A `running` occurrence whose `lease_expires_at` has passed is
eligible; claiming it increments `attempt`, which is what invalidates the dead
owner. A **live** lease is never stolen (test F2).

**Settle.**

```sql
UPDATE platform.job_occurrences SET ... WHERE tenant_id=$1 AND job_type=$2
  AND occurrence_key=$3 AND state='running' AND lease_owner=$4 AND attempt=$5
```

Zero rows updated → `ScheduledJobLeaseLostError`. Because the settle runs in the
**same transaction** as the handler's `commit` and the findings write, that throw
rolls the domain effect back with it.

Lease `120 000 ms`, renewed at half that while a long handler runs; renewal is
predicated on `(lease_owner, attempt)` so a worker that already lost its lease
cannot resurrect ownership.

---

## 7. Multi-instance proof

**The heartbeat is not the scheduler.** `SchedulerHeartbeatService` is a
self-rescheduling `setTimeout` (not `setInterval` — no overlapping ticks),
disabled unless `SCHEDULER_ENABLED === 'true'`, and it decides **nothing**:

| Question | Decided by |
|---|---|
| Which occurrences exist | `platform.job_occurrences` rows, derived from durable schedules + registry defaults |
| Whether one already ran | Its primary key and its `state` |
| Which instance runs it | The claim's `FOR UPDATE SKIP LOCKED` and the lease |

A tick that fires twice claims nothing the first already claimed. A tick that
never fires leaves the work for another instance, with its occurrence identity
intact. Ten instances ticking at once execute each occurrence exactly once
between them. The timer controls **latency**, not correctness — which is exactly
what makes a process-local timer acceptable here, and why enabling it on *every*
instance is the intended production configuration rather than electing one.

**How it is proven.** `test/scheduler-concurrency.e2e-spec.ts` boots
`bootSchedulerApp()` **twice** against the same scratch database. Each Nest
application has its own `PrismaService` (its own pool) and its own
`ScheduledJobRunnerService` with its own `processId`, so `alpha` and `bravo` are
as independent as two pods behind a load balancer. Nothing in that suite proves
a property of one object calling itself twice. Full evidence in §14.

---

## 8. Retry / failure model (design property F)

| Aspect | Behaviour |
|---|---|
| **Eligibility** | Any throw that is **not** `ScheduledJobPermanentError` is transient and retryable |
| **Terminal-on-first-attempt** | `ScheduledJobPermanentError(code, message)` — a validation or business-rule failure. Retrying cannot make it true, and burning three attempts only delays the operator seeing the real reason. Its `code` (a bounded token) becomes `outcome_code` |
| **Backoff** | Deterministic exponential from `60 s`, doubling, capped at `900 s`. Measured from the **tick instant**, never `Date.now()` — one clock, and testable |
| **No jitter** | The occurrence identity already prevents two instances executing the same occurrence, so the thundering herd jitter exists to solve does not arise; a deterministic curve lets tests assert a value rather than a range |
| **Max attempts** | Per handler (`maxAttempts`, DB column `max_attempts`, `CHECK attempt <= max_attempts`). Reclaims consume attempts too, so an occurrence that is repeatedly claimed-and-abandoned also terminates |
| **Terminal states** | `succeeded` / `failed`. `ck_job_occurrences_terminal` forces `completed_at NOT NULL` on both. The lease is always released on settle, so a terminal row can never look like live work to the reclaim scan |
| **Outcome vocabulary** | `ok`, `handler_error`, `permanent_error` (or the handler's own code), `attempts_exhausted`, `lease_exhausted`, `unknown_job_type`. **An exception message is never persisted** — it goes to the structured log, where the redaction layer governs it (test H5, G2) |
| **No duplicate domain effect** | The findings write is `ON CONFLICT (tenant_id, job_type, occurrence_key, finding_code) DO UPDATE`, so attempt 2 upserts its own row. An operator's `acknowledged_at` is deliberately **not** cleared by a re-detection |

---

## 9. Timezone / DST semantics (design property E)

`src/common/time/zoned-time.ts`. Every function takes an explicit IANA zone;
nothing reads `process.env.TZ` or any non-UTC `Date` method. Proven by a test
that runs the same tick under `Pacific/Kiritimati` and `Pacific/Niue` and asserts
byte-identical keys and instants (unit **and** e2e, D3).

**Why Sales' `business-day.ts` is not imported.** It provides the *forward*
direction (instant → business day) and is a **private** file of the Sales module;
`module-boundaries.spec.ts` forbids reaching into it, and the alternative would
be a new `KNOWN_DEVIATIONS` entry for a date utility. The scheduler needs the
*inverse*, which does not exist anywhere in the repository. Only the ~25-line
`Intl.DateTimeFormat` projection idiom is common; the business-day cutover
algorithm is **not** duplicated and stays Sales-owned.

**The rule.** `instantForLocalSlot(slot, zone)` returns the **earliest UTC
instant whose local projection has reached the slot**. One rule, both DST
directions:

| Case | Answer | Why |
|---|---|---|
| **Ordinary day** | The single candidate, which projects back to the slot exactly | — |
| **REPEATED local time** (fall-back) | Both candidates project back to the slot; the **earlier** is returned | The wall clock really does happen twice. The occurrence key is the slot, so the primary key rejects a second row regardless — the choice only decides *when*, not *how many* |
| **SKIPPED local time** (spring-forward) | Neither candidate projects back; the **transition instant** is returned | The occurrence is **not skipped** — a required business occurrence must not vanish because a government moved a clock |

**Implementation, and a defect fixed on the way.** The first version binary-searched
the day. That is wrong: "has the local clock reached the slot" is **not monotone**
across a fall-back (the clock goes backwards), so the search converges on
whichever crossing its midpoints happen to hit. Replaced with: sample the offset
one day either side, form at most two candidates (`naive - offset`), return the
minimum candidate that projects back exactly; if none does, the slot is skipped
and a bounded binary search **confined to the window between the two candidates**
— where the offset changes exactly once and the predicate *is* monotone — finds
the transition instant. Minute granularity is exact, not approximate: every IANA
offset and transition is a whole number of minutes.

**Transitions used as fixtures**, each confirmed against this runtime's ICU data
before being written down:

| Zone | Instant | Local effect | Slot tested | Resolved to |
|---|---|---|---|---|
| `Europe/London` | 2026-03-29 01:00Z | 01:00 → 02:00 (01:00–01:59 **skipped**) | `01:30` | `2026-03-29T01:00:00.000Z` (transition) |
| `Europe/London` | 2026-10-25 01:00Z | 02:00 → 01:00 (01:00–01:59 **repeated**) | `01:30` | `2026-10-25T00:30:00.000Z` (earlier) |
| `Africa/Cairo` | 2026-04-23 22:00Z | 04-23 24:00 → 04-24 01:00 (00:00–00:59 **skipped**) | `00:30` | `2026-04-23T22:00:00.000Z` (transition) |
| `Africa/Cairo` | 2026-10-29 21:00Z | 24:00 → 23:00 (23:00–23:59 **repeated**) | `23:30` | `2026-10-29T20:30:00.000Z` (earlier) |

The Cairo cases matter beyond coverage: Egypt transitions at **local midnight**,
so the skipped window is the *first hour of the local day* — a case any
"transitions happen at 01:00" assumption gets wrong. An initial fixture assumed
02:00 and was corrected against measured ICU data rather than kept.

**Bounded catch-up (design property J).** `dueDailySlots(now, zone, minute,
limit)` returns at most `limit` due slots, most recent first. The horizon is
`platform.job_schedules.catch_up_limit` (1–30, default 3) — durable, per-tenant,
explicit configuration rather than a hidden constant, so anything older is a
**stated operational bound**, not a silent skip. Tested: a week of downtime
yields the horizon, not the week (B1); the horizon is genuinely read from the row
(B2); a bounded claim batch leaves the remainder `pending` and a later tick takes
exactly what was left (B3).

---

## 10. Tenant / RLS execution model (design property D) — and the governance line

**No worker authority model was invented, because none was needed.**

- All three tables are `ENABLE` + `FORCE ROW LEVEL SECURITY` with the four
  standard `app.tenant_id` policies (`SELECT`/`INSERT`/`UPDATE`/`DELETE`),
  identical in shape to `sync.*` (migration 37) and every other tenant table.
- **Every** scheduler statement — materialise, claim, renew, settle, reap,
  findings write — runs inside `PrismaService.withAuthContext({ tenantId })`.
  There is no privileged connection, no `SET ROLE`, and no second Prisma client.
- `ros_app` is `NOSUPERUSER, NOBYPASSRLS`; asserted live in test G3 by querying
  `pg_roles` **through the application's own connection** (`current_user` =
  `ros_app`, `rolbypassrls` = `false`).
- A statement with **no** tenant context reads the empty set, not the fleet
  (test: `withAuthContext({})` over all three tables returns `[]`). This is the
  specific property that makes a per-tenant worker safe: forgetting the context
  fails closed.

**The one cross-tenant read, and why it is not new.** Tenant discovery is a
single `identity.tenants` query for active tenant **ids only**.
`identity.tenants` has carried no RLS since migration 5 — it is the platform
registry a login must resolve *before* any tenant context can exist — and
`TenantsService` already reads it the same way. No tenant-scoped table is read,
and nothing about a tenant beyond its id is loaded.

**The design cost, stated rather than engineered around.** A worker cannot issue
ONE set-oriented claim spanning every tenant, because that requires reading
another tenant's rows and `ros_app` has no `BYPASSRLS` (`FR-PLT-011`, ratified;
register: "No cross-tenant read is possible"). **This repository has no ratified
system-worker authority model, and one was NOT invented.** Consequently the tick
fans out over tenants: three statements per tenant per tick, regardless of how
many job types or occurrences that tenant has. §16 measures exactly what that
costs (≈5 ms per tenant per tick locally, linear). Raising this to a single
fleet-wide claim is a **governance decision**, not an engineering one, and §22
records it as such rather than taking it unilaterally.

`SCHEDULER_TENANT_BATCH` bounds a tick's cost and the cursor round-robins, so no
tenant starves.

---

## 11. Observability integration (design property G)

Everything goes through the **existing** G1-3 services — `MetricsService`,
`StructuredLoggerService`, `ObservabilityContextService` — not a second channel
with its own format.

**Metrics** (four series families, all on the existing registry):

| Metric | Labels | Notes |
|---|---|---|
| `scheduled_job_occurrences_total` | `job_type`, `phase` | `phase` ∈ `materialized, claimed, reclaimed, succeeded, failed, retry_scheduled, lease_lost, exhausted` (closed set of 8) |
| `scheduled_job_duration_seconds` | `job_type` | buckets 0.05 s → 600 s (background work, not requests) |
| `scheduled_job_lag_seconds` | `job_type` | claim instant − `scheduled_for`, clamped at 0. Buckets 1 s → 86 400 s. **The number that says whether the scheduler is keeping up** — duration alone cannot, because a job that runs in 200 ms four hours late is still four hours late |
| `scheduled_job_findings_total` | `job_type`, `severity` | Incremented **only after** the transaction that persisted the finding committed, so a rolled-back attempt inflates nothing |

**Cardinality.** `job_type` comes from `ScheduledJobRegistry` — fixed at deploy
time by how many handlers the build registers. `phase` and `severity` are closed
enums. Total series is `#job_types × #phases`. Deliberately absent and never to
be added: `tenantId`, `branchId`, any occurrence key or UUID, any exception
message. Proven by a sabotage test (500 tenants × 500 occurrence days collapse
onto **one** series; 200 findings → one series), by an e2e assertion that no
`scheduled_job_*` line contains the tenant id, the occurrence key, a UUID or the
exception text, and by an e2e that adds ten days of occurrences for every job
type and asserts the series count did not grow.

**Logging.** `scheduler.occurrence.started|succeeded|retry|failed|lease_lost`,
plus `scheduler.tick.completed|failed` and
`scheduler.heartbeat.enabled|disabled`. Five metadata keys were added to
`ALLOWED_METADATA_KEYS` — `jobType`, `occurrenceKey`, `attempt`, `outcome`,
`lagMs` — all server-derived and bounded in shape. The exception class and
message use the already-allowed `exceptionClass`/`errorMessage`, so they reach
the log (where redaction governs them) and never the queryable `outcome_code`
column or a metric label (tests H5, G2).

**Correlation / causation.** Each occurrence attempt runs inside its own
`ObservabilityContextService.run()` scope with a **fresh correlation id** and a
**NULL causation id**. A scheduled occurrence is a *root* cause — no prior
request or event made it happen — and inventing a causal link would be a false
one, the same rule `resolveCausationId` already applies to a root HTTP request.
Test H4 parses the real JSON envelopes off stdout (the logger is not mocked) and
asserts `tenantId` present, `causationId` null, and **more than one distinct
correlation id** across the tick: distinct occurrences are distinct causal
chains.

---

## 12. Audit / event behaviour (design property H)

The scheduler engine **fabricates no business audit action**. It writes only its
own control-plane rows plus whatever a handler writes through the transaction it
is handed.

It also **cannot bypass** a domain service's audit/event behaviour, because it
never reaches around one: a handler calls the published domain service exactly as
an HTTP caller would, and if that service writes an `AuditEntry` or publishes a
domain event, it still does — the scheduler is upstream of it, not a replacement
for it. `commit(tx, ...)` receives the substrate's own
`Prisma.TransactionClient`, which is the same handle `UnitOfWork` and the sync
kernel hand their own handlers, so a future job that needs transactional events
composes with the existing mechanism rather than around it.

The Inventory job in this slice writes **no** `AuditEntry`, correctly: it mutates
no business state (§13), and `FR-AUD-001` concerns state-changing operations. Its
durable evidence is the `platform.job_findings` row.

---

## 13. The Inventory reconciliation scheduled job

`src/modules/inventory/reconciliation/daily-reconciliation.job.ts`,
job type **`inventory.daily_reconciliation`**.

| Property | Value | Why |
|---|---|---|
| **Cadence** | Daily, 03:00, `UTC` by default; per-tenant override via `platform.job_schedules` | "Daily" is the SRS's word (BR-INV-003 / FR-INV-011). 03:00 is an IMPLEMENTATION-level choice (documented, not hidden), after a late-night branch's business-day rollover rather than mid-trading. `UTC` is explicit, never a fallback to server-local time |
| **Scope** | **Tenant-wide** | FR-INV-051 says "every (item, location) pair". `org.locations` resolves to a branch, a warehouse, **or a tenant-owned central kitchen that belongs to no branch at all**. A per-branch occurrence would leave those unreconciled while reporting success — exactly the silent gap the requirement closes. Test **F** proves coverage of a central-kitchen location a branch-scoped job would miss |
| **Detection logic** | `ReconciliationService.reconcile(tenantId)`, unchanged | The comparison is NOT reimplemented. A second implementation, even an equivalent one, would be a second definition of "reconciled", free to drift from the one `GET /inventory/reconciliation` and A1-4's concurrency matrix exercise. Test **D** asserts the job's finding matches the on-demand answer pair-for-pair and value-for-value |
| **Catch-up horizon** | **1** | This job verifies current agreement. Re-running Monday's occurrence on Wednesday would re-verify *Wednesday* and record it against *Monday's* key, making `job_occurrences` claim a day was checked when it was not. So a week of downtime yields ONE occurrence; the unverified days have **no row**, which is the truthful representation, and `scheduled_job_lag_seconds` makes the gap visible. Test **A2** |
| **Auto-fix** | **None** | No SRS clause asks for repair — all three say "verify" and "alert". Rewriting the projection to agree would destroy the evidence needed to identify the faulty writer. Test **E** asserts `quantity_on_hand`, `last_reconciled_at` and the movement count are byte-identical after a run, and that the divergence is still detectable afterwards |
| **Effect** | One `platform.job_findings` row per diverging occurrence: `severity='critical'`, `finding_code='inventory.ledger_projection_divergence'`, `detail = { divergenceCount, sampled, sample[≤50] }` | `divergenceCount` always carries the TRUE total, so the bounded sample can never be mistaken for it — one broken tenant cannot write a multi-megabyte JSONB row |
| **Healthy tenant** | Writes **nothing** | An empty findings table for a succeeded occurrence is the honest representation of "checked, everything agreed". An `info` row per tenant per day would bury the one row that matters. Test **B** |
| **Attempts** | 3, transient-only | A reconciliation failure is almost always transient (reset connection, statement timeout under load) |

**The alert limb — exactly what exists and what does not.**

| Half | State |
|---|---|
| Detection | **Implemented** — runs on schedule, uses canonical logic |
| Durable, attributable, acknowledgeable record | **Implemented** — `platform.job_findings`, FK'd to the exact occurrence, with `acknowledged_at`/`acknowledged_by`; an acknowledgement survives re-detection (test **H**) |
| Low-cardinality signal | **Implemented** — `scheduled_job_findings_total{job_type,severity}` |
| Alert rule + runbook | **Implemented** — `ROSInventoryLedgerProjectionDivergence` in `backend-api.rules.yaml` + `docs/observability/runbooks/inventory-ledger-divergence.md` |
| **Delivery to a human** | **NOT IMPLEMENTED — the exact blocker** |

**The blocker, named precisely.** Two independent parts:

1. **No notification substrate exists, and its absence is ratified.** Governance
   decision **N-A**: "No notification implementation in Phase 1 (strict). No
   channel, no in-app notification, no table, no endpoint, no permission, no
   event, no outbox, no queue, no worker, no scheduler." Building email/SMS/push
   here would contradict a ratified decision and was explicitly out of scope.
2. **Rule ≠ evaluator.** `backend-api.rules.yaml`'s own header already states
   that defining rules is not running an alert evaluator; loading them into a
   Prometheus/Alertmanager and routing a page is deployment configuration
   outside this repository. This is why G1-3 reports `NFR-OBS-006` **PARTIAL**,
   and the same reasoning applies unchanged here.

**Therefore BR-INV-003, FR-INV-011 and FR-INV-051 remain PARTIAL after this
slice.** A scheduler is not an alert. §23.

**An intentionally awkward note.** The initial draft of the divergence alert rule
fired on the job *completing* — i.e. every day — because a per-tenant divergence
count cannot be a metric label. That rule would have been dishonest (an alert
that always fires is not an alert), and it was replaced by adding a real,
low-cardinality `scheduled_job_findings_total` counter incremented only after the
persisting transaction commits. Recorded here because the first attempt was
wrong, not because the final one is clever.

---

## 14. Exact concurrency test evidence

All suites run against **real PostgreSQL** on the standard G1-2 from-zero
scratch harness. **No `sleep` appears in any of them.** Determinism comes from
three mechanisms: two genuinely separate Nest applications; leases expired by
*writing* a past timestamp relative to the injected tick instant; and a
promise barrier inside a handler whose entry is signalled by a resolved promise
(never polled).

`test/scheduler-concurrency.e2e-spec.ts` — **10/10 PASS**

| # | Brief's required gate | Test | What is asserted |
|---|---|---|---|
| **1** | two workers race to claim the same occurrence: exactly one executes | `1.` | `alpha` and `bravo` tick under `Promise.all`. `a.claimed + b.claimed === 1`; handler ran **once**; row `succeeded`, `attempt=1`, `leaseOwner` null; **one** finding |
| **1** | (stronger) | `1b.` | FOUR concurrent ticks across two instances → total claimed **1**, one execution, **one** occurrence row (materialisation raced too, and the primary key absorbed it) |
| **1** | (deterministic, no race needed) | `1c.` | A separate `pg` client holds `SELECT ... FOR UPDATE` on an otherwise fully eligible row. A tick claims **0** and executes **0** — `SKIP LOCKED` proven against an *arranged* lock. Release the lock; the same occurrence is claimed and executed. Work deferred, never dropped |
| **2** | worker crashes/abandons after claim: lease expiry allows safe reclaim | `2.` | `alpha` held inside its handler by the barrier; row observed `running`, `attempt=1`. `bravo` tick while the lease is LIVE claims **0**. Lease expired; `bravo` reclaims, `attempt=2`, `succeeded`, lease released |
| **3** | original worker resumes after lease is lost: cannot commit a second successful occurrence | `3.` | `bravo` completes it (attempt 2, one finding recorded). `alpha` then finishes its handler and settles: `leaseLost=1`, `succeeded=0`. Final row is **bravo's** — same `attempt`, same `completedAt`. Findings: still exactly **one**, and **the same row id** as bravo's, so alpha's write was rolled back with its settle. Both instances really executed the handler (2 executions), so the single finding is idempotence, not a skipped run |
| **4** | retry after transient failure: same occurrence identity, no duplicate domain effect | `4.` | Fails on `alpha` (attempt 1, `pending`, **zero** findings — a failed attempt commits nothing). Backoff written past; **`bravo`** picks up the same identity: `attempt=2`, `succeeded`, **one** occurrence row, **one** finding |
| **5** | two different tenants: both execute independently, no cross-tenant bleed | `5.` | Concurrent ticks on `alpha`(A) and `bravo`(B). Each tenant: one occurrence, `succeeded`, correct `tenantId`, one finding with the correct `tenantId`, one execution |
| **5** | (failure isolation) | `5b.` | Both tenants' permanently-failing occurrences fail independently with the handler's own code; neither short-circuits the other |
| **6** | two different scheduled occurrences: both execute independently | `6.` | `alpha` materialises two days and claims **one** (`claimBatch:1`); `bravo` takes the other. Both `succeeded`, both `attempt=1`, two distinct occurrence keys, two executions |
| **7** | duplicate scheduler tick: same occurrence not duplicated | `1b.` above, and core `A3.` | Core `A3.`: a second tick at the same instant materialises **0**, claims **0**, executes nothing further, and every row is byte-identical to before |
| **8** | concurrent Inventory reconciliation workers: one logical reconciliation occurrence | inventory `I.` | Two instances reconcile concurrently on a diverged tenant: total claimed **1**, one occurrence row, `attempt=1`, lease released, and **one** finding with the correct divergence count |
| **9** | DST/timezone case | core `D1./D2./D3.` + 28 unit tests | Repeated hour → one occurrence at the earlier instant; skipped hour → occurrence exists at the transition instant, `succeeded`; identical results under two different process timezones |
| **10** | DB state after every race remains truthful | `7.` and core `G1.` | After three concurrent ticks: every row's state is a legal value; every terminal row has `completedAt` set, `outcome_code` set, and **no lease**; `0 <= attempt <= max_attempts`; finding keys `(tenant, job, occurrence, code)` are unique. Core `G1.` repeats this across an exhausting retry sequence |

Supporting suites: `test/scheduler-core.e2e-spec.ts` **30/30**,
`test/scheduler-rls.e2e-spec.ts` **10/10**,
`test/inventory-scheduled-reconciliation.e2e-spec.ts` **11/11**,
`test/scheduler-performance.e2e-spec.ts` **5/5**.

**Targeted scheduler total: 5 suites / 66 tests, all PASS.**

Unit (no database): `zoned-time.spec.ts` **28**,
`scheduled-job.registry.spec.ts` **11**, `scheduled-job.constants.spec.ts`
**9**, plus **9** new `MetricsService` scheduler tests.

---

## 15. Migrations / schema / RLS / indexes

**Migration count: 38 → 39.** One migration added,
`20260903020000_platform_scheduled_jobs`. **No existing migration was modified.**
From-zero migration is verified live on **every** e2e harness run (the harness
migrates a template database from zero per invocation) — including the full E2E
run in §20.

| Requirement from the brief | Evidence |
|---|---|
| Schema namespace follows project conventions | `CREATE SCHEMA IF NOT EXISTS "platform"` + `GRANT USAGE ... TO ros_app`, matching all 12 prior schema creations. `platform` is the name SRS §25.1 assigns |
| Tenant isolation / RLS explicit | All three tables `ENABLE` + `FORCE ROW LEVEL SECURITY`, four `app.tenant_id` policies each. Asserted live from `pg_class`/`pg_policy` in `scheduler-rls.e2e-spec.ts` |
| FORCE RLS where architecture requires it | Yes — all three. Asserted `relforcerowsecurity = true` |
| Indexes cover claim/reclaim scans | `job_occurrences_claim_idx (tenant_id, state, next_attempt_at)`, `job_occurrences_reclaim_idx (tenant_id, state, lease_expires_at)`, `job_occurrences_tenant_job_scheduled_idx (tenant_id, job_type, scheduled_for DESC)`, `job_findings_occurrence_code_key` (UNIQUE), `job_findings_tenant_open_idx`. Plan evidence in §16 |
| Occurrence uniqueness enforced by the DB | `PRIMARY KEY (tenant_id, job_type, occurrence_key)`; a duplicate insert through the owner client is refused (test A2) |
| Timestamps and precision follow conventions | Every timestamp `TIMESTAMPTZ(6)`, matching every prior migration |
| From-zero migrations remain green | Verified on every harness run; `prisma validate` clean |

**Constraints (all DB-enforced):** `ck_job_schedules_cadence` (`daily` only),
`ck_job_schedules_local_time` (0–1439), `ck_job_schedules_catch_up` (1–30),
`ck_job_occurrences_state`, `ck_job_occurrences_terminal` (a terminal row must
record when it terminated), `ck_job_occurrences_running_lease` (a `running` row
must hold a real lease — this is what makes an orphaned claim *detectable*),
`ck_job_occurrences_attempt` (`0 <= attempt <= max_attempts`),
`ck_job_findings_severity`, `ck_job_findings_acknowledged`. FKs: all three to
`identity.tenants` `ON DELETE CASCADE`; `job_findings` → `job_occurrences` on the
full composite key, so a finding can neither outlive nor exist without its
occurrence (asserted live).

**Schema/migration drift.** `prisma migrate diff --from-migrations --to-schema`
against a disposable shadow database reports **zero** lines mentioning any of the
three new tables. Total drift output went 163 → 160 lines after renaming one FK
to Prisma's canonical name; the residual 160 lines are the **pre-existing**,
repo-wide cosmetic FK/index-name differences (e.g. `csca_session_fkey`),
untouched by this slice. The temporary config file used for that check was
deleted and never committed.

**Inventory boundary guard narrowed, not dropped.** `test/inventory.e2e-spec.ts`
forbade a `platform` schema. `platform` was removed from the forbidden list and
replaced with an assertion pinning the schema to **exactly**
`job_findings, job_occurrences, job_schedules` — the same treatment
`workforce`/`treasury`/`fiscal` already received. An unbuilt platform capability
(outbox, notifications, feature flags) still cannot appear quietly.

---

## 16. Performance measurements

Local, in-process, against the scratch PostgreSQL 16 on developer hardware, taken
in the same session as everything else. **These are evidence about SHAPE — index
usage, statement counts, bounded batches — not a certified benchmark against
production hardware.** No SRS latency budget exists for background work, so
nothing here is asserted as an SLO; the assertions are on shape, which is what a
regression breaks first.

| Measurement | Result |
|---|---|
| **Idle tick, one tenant, nothing due** (20 iterations) | p50 **4.17 ms**, p95 **7.46 ms**, min 3.26, max 7.46 |
| **Tick with one due occurrence** (claim + execute + settle, 10 iterations) | p50 **5.53 ms**, p95 **9.44 ms**, min 5.27, max 9.44 |
| **Claim + settle, batch 10, against 2 000 occurrence rows (100 eligible)** (10 iterations) | p50 **16.95 ms**, p95 **18.50 ms** |
| **Fan-out** | 1 tenant **5.58 ms**; 10 tenants **49.22 ms** → **8.8× for 10× the tenants** |
| **Real tenant-discovery tick** (`tenantBatch=5`, no override) | **38.22 ms**; `tenantsScanned <= 5` honoured |

**Claim query plans**, taken through the RLS-constrained runtime role so the
policy predicate is part of what the planner sees, against a *representative*
table (95 % settled history, 5 % eligible — the real production shape, since
`job_occurrences` accumulates one settled row per tenant per job per day forever
while the eligible set stays tiny):

```
due claim:      Limit -> LockRows -> Sort -> Bitmap Index Scan on job_occurrences_reclaim_idx
                Index Cond: (tenant_id = ... AND state = 'pending')
reclaim:        Limit -> LockRows -> Incremental Sort -> Index Scan using job_occurrences_reclaim_idx
                Index Cond: (tenant_id = ... AND state = 'running' AND lease_expires_at <= now())
```

Both halves are **index-driven**; neither is a `Seq Scan`, asserted in the test.
Honest note: the *due* half chose `job_occurrences_reclaim_idx` and a small sort
rather than `job_occurrences_claim_idx`. Both indexes share the
`(tenant_id, state)` prefix, and in this fixture every eligible row has the same
`next_attempt_at`, so the range predicate is not selective and bitmap+sort over
100 rows is genuinely cheaper. With a realistic spread of `next_attempt_at` the
ordered scan on `claim_idx` becomes the cheaper plan. Recorded as measured, not
as hoped.

**"Do not create one DB polling query per tenant."** Partially honoured, and the
gap is a governance boundary rather than an oversight:

- Tenant discovery is **ONE** query for the whole batch — never one per tenant.
- Materialisation is **ONE** set-oriented multi-row `INSERT` per tenant, not one
  per occurrence.
- Claiming is **two** bounded set-oriented `UPDATE`s per tenant, not one per
  occurrence.
- But the tick **does** fan out over tenants (three statements each), because a
  single fleet-wide claim needs a cross-tenant read that `FR-PLT-011` forbids
  and no ratified worker authority model authorises (§10, §22). The measured
  cost is ≈5 ms per tenant per tick and scales linearly, which the test asserts
  is **not worse than linear**.

**Request-path impact: none measurable, by construction.** No HTTP route, guard,
interceptor or middleware was added or changed; `openapi:check` reports zero API
diff; the heartbeat is off unless `SCHEDULER_ENABLED=true`, and when on it is a
`setTimeout` that does not overlap itself.

---

## 17. Authorization coverage counts

Unchanged, exactly as expected — this slice adds **zero HTTP routes**.

| Metric | Baseline (start of session) | Final |
|---|---|---|
| routes | 159 | **159** |
| tenant | 66 | **66** |
| branch | 21 | **21** |
| resource | 43 | **43** |
| UNDECLARED | 17 | **17** |
| resourceOrTenant | 2 | **2** |
| branchOrTenant | 3 | **3** |
| brand | 3 | **3** |
| sessionTerminalBranch | 2 | **2** |
| declaredScope | 2 | **2** |
| `authorization-coverage.spec.ts` | 9/9 PASS | **9/9 PASS** |
| `module-boundaries.spec.ts` | PASS | **PASS** (46/46; combined run 55/55) |

**Security note (design property K).** Scheduled execution creates no hidden
authorization bypass: it exposes no endpoint, adds no permission, and reaches the
Inventory domain only through `ReconciliationService`, the same service the
already-authorized `GET /inventory/reconciliation` route uses. The RLS boundary
is identical to the request path (§10). No private cross-module import (§25).

---

## 18. Lint baseline / final

| | Errors | Warnings | Files |
|---|---|---|---|
| **Baseline** (`npx eslint "{src,apps,libs,test}/**/*.ts"` at session start) | **48** | 0 | `cash-session-tender-totals.query.service.ts` 1 · `cash-session-close.service.ts` 1 · `cash-sessions.service.ts` 1 · `treasury.controller.ts` 2 · `cash-movements-close-and-payment-concurrency.e2e-spec.ts` 16 · `cash-session-close.e2e-spec.ts` 27 |
| **Final** | **48** | 0 | **identical file-by-file** |

**Zero new findings.** The pre-existing 48 were deliberately **not** fixed —
`npm run lint` would have auto-fixed files this slice has no business touching.
`--fix` was applied only to the files this slice created or changed, and the
remaining real (non-formatting) findings in them were fixed by hand: unused
parameters removed rather than underscore-prefixed (this config has no
`argsIgnorePattern`), and the `process.stdout.write` capture helper typed
explicitly instead of assigned through `any`.

`git diff --check`: **clean** (no whitespace errors).

---

## 19. Dependency audit

| | moderate | high | critical | total |
|---|---|---|---|---|
| **Baseline** | 1 | 7 | 0 | 8 |
| **Final** | 1 | 7 | 0 | 8 |

**Unchanged.** `git diff --stat package.json package-lock.json` is **empty** —
zero dependencies added, removed or moved. The 7 high-severity findings are the
pre-existing ones P0-REBASE-2 §7 blocker #10 already records; this slice neither
introduced nor remediated any, and `NFR-MAINT-005` is unaffected.

---

## 20. Full E2E result

**ONE** full run, `--maxWorkers=2`, after every targeted gate was green:

```
Test Suites: 91 passed, 91 total
Tests:       1445 passed, 1445 total
Snapshots:   0 total
Time:        157.093 s
EXIT=0
```

Baseline for comparison: 86 suites / 1379 tests at the previous integration wave.
**+5 suites, +66 tests**, all from this slice. **Zero failures**, so no failure
required classification, no suite was rerun in isolation, and **no second full
run was performed**.

Targeted gates run before it, each green:

| Gate | Result |
|---|---|
| `git diff --check` | clean |
| `prisma validate` | valid |
| `npm run typecheck` | clean |
| Unit (`npx jest`) | **82 suites / 1125 tests PASS** (baseline 79/1059) |
| Module boundaries + authorization coverage | **2 suites / 55 tests PASS** |
| `npm run openapi:check` | **exit 0, zero diff** |
| Scheduler core + concurrency + RLS + performance + inventory-scheduled | **5 suites / 66 tests PASS** |
| Existing Inventory + concurrency matrix + depletion | **8 suites / 106 tests PASS** |
| Observability + authorization + RLS + OpenAPI representatives | **9 suites / 172 tests PASS** |
| Post-commit re-verification | typecheck clean, unit 82/1125, 5 suites / 97 tests PASS |

---

## 21. Orphan scratch DB count

**0.**

Verified against the lane-E PostgreSQL immediately after the full E2E run:

```
SELECT count(*) FROM pg_database
 WHERE datname LIKE 'ros_test%' OR datname LIKE 'ros_lane%' OR datname LIKE 'ros_ci%';
-- 0
```

The one non-harness scratch database created this session
(`ros_test_lane_e_shadow`, used for the Prisma drift check) was dropped
explicitly before the full run. Every harness run reported its own sweep
(`swept 1 database(s) ... (includes the template)`).

---

## 22. Persistent `ros` untouched — proof, and the governance boundary

**Database.** All work used a **dedicated lane-E container**,
`ros-postgres-lane-e` on host port **5577**, created this session from the
repository's own `docker/postgres/init` script. The persistent `ros` database
lives in the separate `ros-postgres` container on port **5544**, whose
credentials are not present in this worktree — an attempted connection to 5544
fails authentication, which is direct evidence that nothing in this session
could have reached it. The other lanes' containers (5555, 5566) were likewise
never touched. `.env` was created for the lane-E container only and is
gitignored (`git check-ignore -v .env` → `kitchen-kit/backend/.gitignore:42`).

**Checkout.** The separate persistent `ros` checkout at
`/Users/mac/projects/ros` was never entered. Every command ran from
`/Users/mac/projects/ros-worktrees/lane-e`.

**Git.** No push, no deploy, no rebase, no merge, no reset, no clean, no stash.
Two commits created on `full-srs/lane-e2-scheduler-foundation`, plus this
report's `docs:` commit.

**The one governance item this slice deliberately did NOT decide.**

> A **fleet-wide, single-statement scheduled-occurrence claim** would require the
> application role to read `platform.job_occurrences` rows belonging to tenants
> other than the one in context. `FR-PLT-011` is ratified — the application
> database role SHALL NOT have `BYPASSRLS` — and the governance register asserts
> "No cross-tenant read is possible". No ratified system-worker authority model
> exists in this repository.
>
> **No such model was invented, and no bypass was added.** The substrate instead
> executes per tenant under normal RLS, which needs no new authority at all and
> is therefore shipped. The *only* cost is that a tick is linear in tenants
> (§16), which is measured and acceptable at any realistic near-term fleet size.
>
> If a future fleet size makes that cost unacceptable, the change required is a
> **ratified worker authority model** (a scheduler-scoped role, or an explicitly
> authorised policy predicate on the control-plane tables) — a governance
> decision, not an engineering one. It is recorded here so the next slice
> proposes it deliberately rather than discovering it under pressure.

This is stated as a **noted design boundary, not a blocker**: the slice's brief
was satisfiable without it, and it was.

---

## 23. Exact requirement dispositions after this slice

**Nothing is upgraded to COMPLETE. Three requirements gain real, cited evidence
and stay PARTIAL.**

| Requirement | Before | **After** | Reasoning |
|---|---|---|---|
| **BR-INV-003** | PARTIAL / PARTIALLY VERIFIED | **PARTIAL / PARTIALLY VERIFIED — unchanged classification, evidence strengthened** | The ledger/projection correctness limb was already PROVEN (A1-4). The **daily scheduling limb is now production-capable**: a real durable, multi-instance-safe daily occurrence running the canonical reconciliation, proven by `inventory-scheduled-reconciliation.e2e-spec.ts` A/A2/B/C/D/E/F/G/H/I/J. The **alert limb remains PARTIAL**: detection + durable finding + metric + rule + runbook exist; **delivery does not**, blocked on (a) governance decision N-A (no notification substrate in this phase) and (b) alert-evaluator deployment being outside this repository. The brief's rule is honoured verbatim — *"If scheduler exists but alert delivery is missing: remain PARTIAL and say exactly why."* |
| **FR-INV-011** | PARTIAL / PARTIALLY VERIFIED | **PARTIAL / PARTIALLY VERIFIED — unchanged classification, evidence strengthened** | "Reconcilable at any point in time" was already proven. "A scheduled job SHALL verify **daily**" is now implemented and tested. "and **alert** on divergence" is not delivered. Same two blockers |
| **FR-INV-051** | PARTIAL / UNVERIFIED | **PARTIAL / PARTIALLY VERIFIED** | Verification upgraded because the **"every (item, location) pair"** clause is now demonstrated end to end, including a central-kitchen location no branch-scoped job would reach (test F), and the scheduled-job clause is implemented. "SHALL raise a **platform alert**" is not delivered. Implementation stays PARTIAL |
| **FR-AUD-005** | NOT IMPLEMENTED | **NOT IMPLEMENTED — now implementation-ready** | No Governance job was written. `audit-verify.ts` exists as a callable verifier; wrapping it is now a small slice |
| **FR-DR-002** | NOT IMPLEMENTED | **NOT IMPLEMENTED — now implementation-ready** | No partition job was written |
| **FR-SEC-061** | NOT IMPLEMENTED | **NOT IMPLEMENTED** | Also blocked on a data-classification/retention-policy model that does not exist |
| **FR-RPT-002** | NOT IMPLEMENTED | **NOT IMPLEMENTED** | Also blocked on a rollup schema and on cadences (`hourly`/`weekly`/`monthly`) the substrate does not yet support |
| **FR-RPT-040** | NOT IMPLEMENTED | **NOT IMPLEMENTED** | Also blocked on an email/push delivery substrate (governance N-A) |
| **FR-RPT-041** | NOT IMPLEMENTED | **NOT IMPLEMENTED** | The "configurable time" half is now directly supported by `platform.job_schedules`; delivery is not |
| **FR-HRM-013** | NOT IMPLEMENTED | **NOT IMPLEMENTED** | Also blocked on the Workforce scheduling model and a `weekly` cadence |
| **FR-HRM-022** | NOT IMPLEMENTED | **NOT IMPLEMENTED** | Also blocked on attendance/clock-event tables |
| **FR-HRM-023** | NOT IMPLEMENTED | **NOT IMPLEMENTED** | Also blocked on attendance tables. Note: on re-reading, this is a **request-time** guard, not a scheduled job — the P0-REBASE-2 census lists it under the scheduler blocker, but the substrate is arguably not what unblocks it (§24) |
| **FR-INV-067** | PARTIAL | **PARTIAL — unchanged** | Also blocked on the forecasting model |
| **FR-INV-069** | PARTIAL | **PARTIAL — unchanged** | Depends on FR-INV-067 and on demand sources that do not exist |
| **IR-INT-030** | NOT IMPLEMENTED · EXTERNAL | **NOT IMPLEMENTED · EXTERNAL — unchanged** | Remains externally blocked (accounting-provider certification), independent of the scheduler |

**Newly satisfied, incidental to the above:** none claimed. The substrate itself
is not a requirement in the CSV.

**The canonical P0 traceability CSV was NOT updated**, per the brief. That
happens in the next traceability rebase, which should read this section.

---

## 24. Requirements that are now IMPLEMENTATION-READY but still NOT complete

"Implementation-ready" means: the scheduler blocker no longer applies, and what
remains is domain work, not infrastructure.

| Requirement | What the substrate now provides | What is still missing before it can be COMPLETE |
|---|---|---|
| **FR-AUD-005** | Durable daily occurrence, multi-instance-safe execution, retry, findings, telemetry | A Governance job wrapping the existing `audit-verify.ts` chain verifier, plus the same alert-DELIVERY blocker (the SRS asks for a *platform-level security alert*) |
| **FR-DR-002** | Durable recurring occurrence + retry + failure alerting hooks | A partition-lifecycle job creating ≥3 months of partitions ahead. Note this also unblocks the `sync.sync_operations` partitioning D4-1A explicitly deferred "because partitioning needs a partition lifecycle job that does not exist in this repository yet" |
| **FR-RPT-041** | **The "configurable time" half directly**: per-tenant `timezone` + `local_time_of_day`, DST-correct | The digest content itself, and an email/push delivery substrate (governance N-A) |
| **FR-RPT-040** | Durable configurable schedule per tenant | Report generation/export, recipient configuration, and the same delivery substrate |
| **FR-SEC-061** | Durable recurring occurrence + bounded retry | A data-classification and retention-policy model, and the purge/anonymise logic. **Not** scheduler-blocked any more; model-blocked |
| **FR-INV-067 / FR-INV-069** | Durable recurring occurrence to run a forecast on | The forecasting model itself (day-of-week-weighted usage, σ, lead times) and known-future-demand sources |
| **FR-HRM-013** | Durable recurring occurrence | A `weekly` cadence (the substrate supports `daily` only — a deliberate, DB-enforced limit rather than an invented cron dialect), the Workforce scheduling model, and a sales forecast |
| **FR-HRM-022** | Durable recurring occurrence for the *missing clock-out* sweep | Attendance and clock-event tables, plus geofence configuration |
| **FR-RPT-002** | Durable recurring occurrence | `hourly` / `weekly` / `monthly` cadences, a rollup schema, and (per the CSV) a read replica |

**Two honest corrections to the census's framing**, offered for the next
traceability rebase to accept or reject:

1. **`FR-HRM-023`** ("prevent a clock-in more than a configurable interval before
   the scheduled shift start") reads as a **request-time validation** on a
   clock-in command, not a scheduled job. It is blocked on the Workforce
   attendance model; the scheduler is probably not what unblocks it, and
   counting it under the scheduler blocker likely overstates that blocker's
   fan-out by one.
2. **`IR-INT-030`** was already classified `EXTERNAL CERTIFICATION` /
   `EXTERNAL BLOCKER`. Its daily cadence is now trivially available, but the
   requirement cannot close regardless until provider certification exists, so
   the scheduler was never its binding constraint.

Neither correction is applied to the CSV here — the brief reserves that for the
next rebase.

---

## 25. Architecture / boundary compliance

| Rule | Result |
|---|---|
| No private cross-module imports | **PASS.** `InventoryModule` imports `platform/contract` and `platform.module` only; `PlatformModule` imports **no** domain module. `module-boundaries.spec.ts` green |
| **Zero new `KNOWN_DEVIATIONS`** | **PASS.** The `KNOWN_DEVIATIONS` map is byte-unchanged. The `inventory -> platform` edge is public from the start |
| Use existing published contracts/services | **PASS.** `ReconciliationService` unchanged; `MetricsService`/`StructuredLoggerService`/`ObservabilityContextService` reused; `PrismaService.withAuthContext` is the only DB entry point |
| `no-console` in `src/**` | **PASS.** All scheduler output goes through `StructuredLoggerService` |
| No new HTTP surface | **PASS.** `openapi:check` exit 0, zero diff |

---

## 26. Files

**Migration (1):** `prisma/migrations/20260903020000_platform_scheduled_jobs/migration.sql`

**Production (12 new, 6 changed):**
`src/common/time/zoned-time.ts` ·
`src/modules/platform/{platform.module.ts, contract/index.ts, contract/scheduled-job.ts}` ·
`src/modules/platform/scheduler/{scheduled-job.constants.ts, scheduled-job.registry.ts, scheduled-job-handler.decorator.ts, scheduled-job-occurrence.store.ts, scheduled-job-finding.writer.ts, scheduled-job-runner.service.ts, scheduler-heartbeat.service.ts}` ·
`src/modules/inventory/reconciliation/daily-reconciliation.job.ts` ·
changed: `prisma/schema.prisma`, `src/app.module.ts`, `src/config/env.validation.ts`,
`src/common/observability/metrics/metrics.service.ts`,
`src/common/observability/logging/redaction.ts`,
`src/modules/inventory/inventory.module.ts`

**Tests (9 new, 3 changed):**
`src/common/time/zoned-time.spec.ts` ·
`src/modules/platform/scheduler/{scheduled-job.registry.spec.ts, scheduled-job.constants.spec.ts}` ·
`test/{scheduler-fixtures.ts, scheduler-core.e2e-spec.ts, scheduler-concurrency.e2e-spec.ts, scheduler-rls.e2e-spec.ts, scheduler-performance.e2e-spec.ts, inventory-scheduled-reconciliation.e2e-spec.ts}` ·
changed: `src/common/observability/metrics/metrics.service.spec.ts`,
`src/common/observability/alerts/alert-rules.spec.ts`, `test/inventory.e2e-spec.ts`

**Docs (3 new, 2 changed):**
`docs/observability/runbooks/{scheduled-job-failure.md, scheduled-job-lag.md, inventory-ledger-divergence.md}` ·
changed: `docs/observability/alerts/backend-api.rules.yaml`, `.env.example`

**Commits:**

| Hash | Subject |
|---|---|
| `23daa5e` | `feat(platform): add durable scheduled job execution` |
| `fd595ab` | `feat(inventory): schedule daily reconciliation` |
| (this report) | `docs: record durable scheduler foundation` |

---

## 27. Unresolved blockers

| Blocker | Why it is still open |
|---|---|
| **Alert DELIVERY for BR-INV-003 / FR-INV-011 / FR-INV-051** | No notification substrate exists and governance decision **N-A** ratified that none is introduced in this phase; separately, running an alert evaluator is deployment configuration outside this repository. Detection, durable recording, a low-cardinality metric, an alert rule and a runbook all exist; a human is still not notified |
| **Fleet-wide single-statement claim** | Needs a ratified worker authority model (§22). Deliberately not invented. Current per-tenant fan-out is measured and linear |
| **Cadences beyond `daily`** | `hourly`/`weekly`/`monthly` are DB-rejected today (`ck_job_schedules_cadence`). Adding them is a small, additive change when a requirement that needs one is implemented; inventing them now would be unused surface |
| **The remaining 12 domain jobs** | Out of scope by the brief ("Do not immediately implement all 15 scheduled requirements in one slice"). §24 lists what each still needs |
