# MW1A — Correction Gate: C1 Lint Regression + C2 Organisation Fresh-DB Failure + C3 Approval Grant Failure

**Task/slice:** MW1A-CORRECTION GATE — root-cause investigation + narrow
corrections + tests for three specific baseline defects recorded in
`2026-09-02_MW1A_integration-g1-g2-a1-1.md`: C1 (22 new lint errors in two
A1-1 test files), C2 (`organisation.e2e-spec.ts` location-registry invariant
failure), C3 (`approval-runtime.e2e-spec.ts` column-grant boundary failure).

**Report type:** Root-cause investigation + narrow-correction + verification
report.

**Authority statement:** This report is non-authoritative evidence.
`ROS_SRS_v1.0.pdf` and the ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative.
Where this report disagrees with the SRS or a ratified governance decision,
the SRS and the register win. This report records what was observed and
measured in this session only; it ratifies nothing and authorises nothing.

**Date:** 2026-09-02

**Starting HEAD:** `615ef73` (`docs: record wave 1a integration`)

**Resulting HEAD:** `1efb301d32ea563f381cc7cf0e7255f8d9f13b4f`

**Branch:** `full-srs/4day-integration`

**Working tree summary:** Clean before, during (only the intended files
touched), and after this session. Two commits created (`092ef69`,
`1efb301`); no third commit, for a documented reason (see §4).

**Task identifier:** MW1A-CORRECTION GATE — C1 lint regression + C2
organisation fresh-DB failure + C3 approval grant failure.

---

## 0. Starting-state verification

| Check | Expected | Observed | Result |
|---|---|---|---|
| `pwd` | `/Users/mac/projects/ros-worktrees/integration` | matched | PASS |
| Branch | `full-srs/4day-integration` | matched | PASS |
| HEAD | `615ef73` | matched | PASS |
| Working tree | clean | clean | PASS |
| MW1A report present | `full-srs-4day/2026-09-02_MW1A_integration-g1-g2-a1-1.md` | present, read in full before any change | PASS |

No mismatch. Proceeded.

---

## 1. C1 — lint regression in the two A1-1 test files

**Files:** `test/movements-concurrency.e2e-spec.ts`,
`test/inventory-exact-decimal-callers.e2e-spec.ts`.

**Before:** `npm run lint:check` — 70 errors total: 48 in the six known
G1-1-baseline files (unchanged), plus 20 in
`inventory-exact-decimal-callers.e2e-spec.ts` and 2 in
`movements-concurrency.e2e-spec.ts` — all `prettier/prettier`, confirmed by
category before touching anything.

**Correction:** `npx eslint <the two files> --fix` (scoped explicitly to
these two paths only). Every one of the 22 errors was a pure
`prettier/prettier` formatting rule; `--fix` applied only formatting.
Verified via `git diff -w` (whitespace-ignored) on both files: **empty** —
proving the only bytes that changed are whitespace/line-wrapping. No string
literal, numeric literal, assertion, fixture value, or control-flow
statement changed.

**After:** `npm run lint:check` — exactly 48 errors, all in the original six
baseline files; zero references to either target file in the lint output.

**Proof no A1-1 behaviour changed:**
- Both files pass individually through the G1-2 harness (movements-concurrency
  4/4, inventory-exact-decimal-callers 7/7), both before and after the fix.
- Running the two files together was **intermittently flaky** on the
  *pre-fix* harness (a `PrismaClientKnownRequestError: Unique constraint
  failed on the fields: (code)` on `admin.uom.create()`, reproducing
  identically whether the pre-fix or post-fix file content was used — proving
  it was unrelated to the lint fix). Root cause (see §2): the pre-fix E2E
  harness silently isolated nothing, so two suites in the same invocation
  were both writing into the same physical database and could collide on a
  millisecond-resolution timestamp used as a fixture uniqueness key. After
  the C2 harness fix, the same two-file combination was re-run **5/5 times
  clean** (11/11 tests each run) — the flake is gone, which is itself
  corroborating evidence for the C2 root cause.
- The same 4-suite Inventory group MW1A validated
  (`inventory`, `inventory-rls`, `movements-concurrency`,
  `inventory-exact-decimal-callers`) passes 65/65 post-fix.

**Commit 1:** `092ef69` — `chore(test): restore inventory lint baseline`
(as specified by the task brief; subject unchanged). Contains only the two
formatting-only file diffs.

---

## 2. C2 — organisation location-registry invariant: root cause was the E2E harness, not Organisation

### 2.1 Reproduction and the false premise this session inherited

Reproducing `test/organisation.e2e-spec.ts` via the **standard** command
(`npx jest --config test/jest-e2e.json organisation.e2e-spec.ts`) against
what the harness *presents* as a freshly migrated-from-zero database
reproduced the MW1A-recorded failure exactly: `leaves no org location entity
without a registry row` — `expected 0, received 11`, deterministic across
repeated runs.

**This reproduction was investigated, not accepted at face value**, per this
task's explicit database-safety mandate. Instrumenting the failing test
in-memory (temporary `console.error` diagnostics, never committed, reverted
via `git checkout` before any commit) revealed:

```
DIAG_DB_NAME       [{"db":"ros"}]
DIAG_TOTALS        {"branches":"1717","warehouses":"141","locations":"1933"}
```

**The test's own `admin` client — and, independently confirmed below, the
application's own runtime `PrismaService` — were connected to the
persistent, shared `ros` database, not any per-suite scratch database**,
despite the harness's own log output showing a template database being
freshly migrated from zero for every invocation. The "11 missing rows" were
11 real, historical branches in `ros` (see §2.3) — not a live defect.

### 2.2 Exact root cause

The G1-2 harness (`test/e2e-db-isolation/jest-hooks.ts`, now removed —
see §2.4) rewrote `process.env.DATABASE_URL`/`APP_DATABASE_URL` from a
`setupFilesAfterEnv` `beforeAll` hook. That hook's *body* genuinely did run,
and genuinely did rewrite the env vars, **before** the spec file's own
`beforeAll` body executed — confirmed directly:

```
DIAG_ENV_DATABASE_URL_AT_BEFOREALL_START  .../ros_test_e2e_mtk3ij7a_9d0f53_s_organisation_27998d
DIAG_ENV_DATABASE_URL_AT_ADMIN_CREATE     .../ros_test_e2e_mtk3ij7a_9d0f53_s_organisation_27998d
DIAG_CONFIGSERVICE_DATABASE_URL           .../ros   <-- wrong
```

`process.env.DATABASE_URL` was already correct at both points inside the
spec's own `beforeAll`. But `app.get(ConfigService).get('DATABASE_URL')`
— what `PrismaService`'s constructor and `createMigratorClient(app)` both
actually read — still resolved to the base `.env` value.

**Why:** `AppModule`'s `@Module({ imports: [ConfigModule.forRoot({...})] })`
decorator argument is evaluated the moment the class declaration runs — i.e.
the moment `app.module.ts` is first `import`ed — and `@nestjs/config`
snapshots `process.env` synchronously inside `ConfigModule.forRoot()` at
that call. Every `*.e2e-spec.ts` file `import`s `AppModule` at its top.
Jest must fully *load* every `setupFilesAfterEnv` file and the test file
itself (executing all top-level `import`s, including this one) **before**
it starts executing any registered `beforeAll` body, of any file, including
the harness's own. So `AppModule`'s import — and `ConfigModule.forRoot()`'s
env snapshot — always happened during that load phase, strictly *before*
`jest-hooks.ts`'s `beforeAll` body ran and rewrote the env vars. The
per-suite scratch database was correctly created, migrated, and later
dropped; it was simply never the database `ConfigService` handed to
anything.

This was invisible for nearly every other suite because almost every other
e2e assertion checks a value relative to a row the test itself just
created (e.g. "this movement's persisted delta equals X"), which holds
regardless of what else exists in the same physical database. It was only
exposed by whole-table invariant scans:
`organisation.e2e-spec.ts`'s registry-completeness check, and (independently
confirmed — see §3) `approval-runtime.e2e-spec.ts`'s column-grant probe.

### 2.3 Where the 11 rows actually came from — classification F (another precise cause)

Manually provisioning a database outside the broken harness (created and
migrated exactly as the harness itself does — `CREATE DATABASE
ros_test_manual_c2diag_1 OWNER ros_migrator` + `GRANT CONNECT ... TO
ros_app` + `prisma migrate deploy`, name matching the existing fail-closed
`assertScratchDatabaseName` guard) and pre-setting `DATABASE_URL`/
`APP_DATABASE_URL` as real OS environment variables **before the Node
process started** (so `ConfigModule.forRoot()`'s import-time snapshot would
be correct from the start) gave a genuinely isolated run:

```
DIAG_CONFIGSERVICE_DATABASE_URL   .../ros_test_manual_c2diag_1   <-- correct
DIAG_DB_NAME                      [{"db":"ros_test_manual_c2diag_1"}]
DIAG_TOTALS                       {"branches":"2","warehouses":"3","locations":"7"}
DIAG_MISSING_ROWS                 []
Test Suites: 1 passed, 1 total   Tests: 62 passed, 62 total
```

Zero missing rows, full suite green, on a database that was genuinely never
anything but freshly migrated from zero. **The Organisation write path
(`BranchesService.create`, `WarehousesService.create`,
`CentralKitchensService.create`, all calling `LocationsService.register`
inside the same `withAuthContext` transaction as the entity insert) is
correct and was never the defect.**

The 11 rows are real, historical branches in the persistent `ros`
database — queried directly (read-only): 11 distinct branches, 11 distinct
tenants, each missing its `org.locations` row. `ros`'s `org.branches` table
holds tenants matching the pattern this test's own fixtures use
(`orga-<stamp>`/`orgb-<stamp>`) dating back to **2026-08-16** — i.e. this is
pre-existing drift that predates this task, predates MW1A, and (per the
2026-08-30 KDS report already on file, see below) was already correctly
identified once before. Root-cause classification per the task's taxonomy:
**F — another precise cause: an E2E test-harness isolation defect causing
the test (and the app under test) to observe real accumulated `ros` state
instead of a fresh database.** Not A/B/C/D/E as literally listed — the rows
are neither migration/bootstrap/seed data nor a live application defect nor
a defect in this specific test's own local setup; they are ordinary
historical production-like data that predates the current write path (or
was created through some now-obsolete route no longer reachable), observed
only because of the harness bug.

### 2.4 Why the prior "persistent-DB-drift" explanation was dismissed, and why that dismissal was wrong

The MW1A report (§6, citing an earlier 2026-08-30 KDS report) recorded:

> *"an earlier session... recorded these same two suites as 'pre-existing
> unrelated failures' and attributed `approval-runtime.e2e-spec.ts`
> specifically to 'column-GRANT drift traced to the live DB's prior grant
> history, not the migration SQL.' That explanation assumed a long-lived,
> drifted persistent database. This session reproduces both failures on a
> database that has never been anything but freshly migrated from zero via
> the G1-2 harness... these are not artifacts of DB drift, they are
> deterministic outcomes of the current migration set itself."*

That MW1A claim is **incorrect**, and this session's own initial
reproduction (§2.1) inherited the same false premise: the "freshly migrated
from zero" claim was true only of the *template* database the harness logs
show being created — never of the database the test's `admin` client or the
app's `PrismaService` actually queried. The **original** 2026-08-30 KDS
report's drift explanation for `approval-runtime.e2e-spec.ts` was correct,
and its sibling finding for `organisation.e2e-spec.ts` ("orphaned-location
rows... predating this session") was also correct. A later 2026-08-31 KDS
report independently corroborates this: run against a manually-managed
separate scratch database (`ros_scratch_test`, pre-dating the G1-2 harness),
both `organisation.e2e-spec.ts` and `approval-runtime.e2e-spec.ts` "both
included and clean, confirming the Phase-1 report's dirty-DB attribution was
correct." The G1-2 harness, introduced afterward, silently reintroduced the
exact failure mode it was built to eliminate — this session is the first to
identify why.

### 2.5 The fix

Moved per-suite database provisioning out of the `setupFilesAfterEnv`
`beforeAll` hook and into a custom Jest `testEnvironment`
(`test/e2e-db-isolation/e2e-database-environment.ts`, extending
`jest-environment-node`'s `NodeEnvironment`). Jest awaits a
`testEnvironment`'s `setup()` **before loading the test file at all** —
strictly before `AppModule` is ever imported and therefore strictly before
`ConfigModule.forRoot()` can snapshot `process.env`. `jest-e2e.json`'s
`testEnvironment` now points at this class; the superseded
`jest-hooks.ts` was removed (its `setupFilesAfterEnv` entry deleted).
`global-setup.ts`/`global-teardown.ts`/`provision.ts`/`run-id.ts`/
`db-url.ts`/`runtime-state.ts`/`guard.ts` are unchanged — the new
environment class reuses them exactly as `jest-hooks.ts` did, just from an
earlier point in Jest's lifecycle.

**Verification (standard command, no manual workaround):**

```
$ npx jest --config test/jest-e2e.json organisation.e2e-spec.ts
Test Suites: 1 passed, 1 total   Tests: 62 passed, 62 total
```

Repeated 3× — deterministic. Cross-checked against `ros`'s own row counts
before/after: unchanged (1719/144/1940 both times — see §2.6 for why these
don't match the 1717/141/1933 figure in §2.1). Two genuinely concurrent
`npx jest` invocations (separate OS processes, disjoint suite sets) produced
distinct run ids and swept only their own databases, no cross-contamination.
A broader 11-suite sample (inventory/RLS/tenant/rbac group, 172 tests) and
the two C1 target files (5 repeated runs) all pass with the fix in place.

**No new Prisma migration was created or needed** — the fix is entirely in
test infrastructure; no organisation source file changed.

**Focused regression test added:** `test/e2e-db-isolation-config.e2e-spec.ts`
— asserts, from inside a real compiled `TestingModule`, that
`ConfigService.getOrThrow('DATABASE_URL'/'APP_DATABASE_URL')` resolves to a
`ros_test_e2e_*` database and never to the base `/ros` connection string,
and that both URLs name the same scratch database. This is the exact
invariant that was silently broken; the existing organisation invariant test
alone would not catch a regression back to import-time env capture without
a genuinely fresh reproduction methodology, which is what this new test
locks in directly.

### 2.6 Disclosed side effect: this investigation's own diagnostic runs wrote to `ros`

Before the root cause was identified (i.e. while still using the broken
harness for reproduction and diagnosis), approximately 5 invocations of
`organisation.e2e-spec.ts`'s full `beforeAll` executed against the real
`ros` database (each creating 2 tenants, 2 branches, 3 warehouses via its
own fixture `seed()` calls — table totals moved from an unknown
pre-session baseline to 1717/141/1933, then to 1719/144/1940 after one more
such run captured mid-diagnosis). **No existing row in `ros` was modified or
deleted** — only new, harmless, correctly-registered rows were added (they
are not part of the 11 offending rows, which predate this session by
weeks). Once the harness fix landed, `ros`'s counts were confirmed unchanged
across every subsequent run in this session, including two full-suite runs.
This is disclosed in full per this task's evidence-integrity requirements;
`ros`'s data was not further touched, and no cleanup of these test rows
was performed (deleting from `ros` was judged riskier and out of this
task's authority than leaving a small number of harmless historical-shaped
rows in a database that already carries thousands of similar rows from
routine development).

**Commit 2:** `1efb301` — `fix(e2e-harness): fix ConfigService database
isolation timing (C2)`. **Subject deviates from the task brief's suggested
`fix(organisation): restore location registry invariant`** because the root
cause is not in the Organisation module — no organisation source file
changed. The new subject accurately names what was actually fixed.

---

## 3. C3 — approval decision column-grant boundary: same root cause, no separate fix needed

### 3.1 Reproduction, before and after the C2 fix

**Before the C2 harness fix** (not separately re-diagnosed in as much depth,
since the mechanism is identical to §2): the known MW1A finding reproduces —
`approval_decisions.decided_at`/`created_at` appear column-INSERT-grantable
to `ros_app`.

**After the C2 harness fix**, using the standard command:

```
$ npx jest --config test/jest-e2e.json approval-runtime.e2e-spec.ts
Test Suites: 1 passed, 1 total   Tests: 40 passed, 40 total
```

Repeated 3× total — deterministic. The specific assertions that previously
failed (`approval_decisions: ros_app has column-level INSERT that excludes
decided_at and created_at`, `proves ros_app cannot supply decided_at even if
it tries`) pass cleanly. `approval-runtime.e2e-spec.ts` + `audit.e2e-spec.ts`
together: 47/47.

### 3.2 Direct `pg_catalog`/`information_schema` proof (task requirement)

A second manually-provisioned, genuinely fresh database
(`ros_test_manual_c3diag_1`, same provisioning method as §2.3, dropped
after use) gives the real privilege state independent of any test-file
assertion:

```sql
SELECT column_name, privilege_type FROM information_schema.role_column_grants
WHERE table_schema='governance' AND table_name='approval_decisions' AND grantee='ros_app';
```

| column | privileges |
|---|---|
| id | INSERT, SELECT |
| tenant_id | INSERT, SELECT |
| approval_request_id | INSERT, SELECT |
| approver_id | INSERT, SELECT |
| decision | INSERT, SELECT |
| comment | INSERT, SELECT |
| **created_at** | **SELECT only** |
| **decided_at** | **SELECT only** |

Table-level grant on `approval_decisions` for `ros_app`: **SELECT only** (no
table-level INSERT — confirming the migration's own comment that a
table-level grant would defeat the column-level restriction).

**This is exactly the intended contract** — traced to
`prisma/migrations/20260829010000_governance_approval_runtime/migration.sql`:

```sql
-- approval_decisions: append-only (D-8), AND column-level INSERT so
-- decided_at (and created_at) can never be supplied by ros_app...
GRANT SELECT ON "governance"."approval_decisions" TO ros_app;
GRANT INSERT ("id", "tenant_id", "approval_request_id", "approver_id", "decision", "comment")
  ON "governance"."approval_decisions" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "governance"."approval_decisions" FROM ros_app;
```

For comparison, the **persistent `ros` database's actual current state**
(read-only query, not modified):

| column | privileges in `ros` |
|---|---|
| created_at | **INSERT**, SELECT |
| decided_at | **INSERT**, SELECT |

**`ros` itself carries over-broad, drifted grants** — consistent with the
original 2026-08-30 KDS report's "column-GRANT drift traced to the live
DB's prior grant history" explanation. This is exactly the same shape of
evidence as C2: the current migration SQL is correct; only the long-lived
shared database has drifted from it, and that database is explicitly out of
this task's authority to modify (§1 of the task brief: "Persistent database
`ros` MUST NOT be touched").

### 3.3 Answers to the task's five required questions

1. **Which role(s) may INSERT the row?** Only `ros_app`, and only via the
   explicit column list below (no other application role exists in this
   schema; `ros_migrator` is DDL/admin-only and not part of the runtime
   write path).
2. **Which columns may `ros_app` supply directly?** `id`, `tenant_id`,
   `approval_request_id`, `approver_id`, `decision`, `comment` — exactly the
   column-level `GRANT INSERT (...)` list in the migration.
3. **Which columns must be server/database-controlled?** `decided_at` and
   `created_at` — both column DEFAULTs (`decided_at` bound to
   `statement_timestamp()`, matching the RLS predicate that also evaluates
   it), never client-suppliable.
4. **Why did `decided_at` appear insertable after "migration-from-zero"?**
   It never actually was, on a genuinely fresh database (§3.2). It appeared
   insertable only because the harness bug (§2.2) caused the test's queries
   to run against `ros`, whose grants have drifted independently of the
   current migration set.
5. **Is the defect GRANT inheritance, table-level INSERT, column GRANT,
   migration ordering, or another cause?** Another cause: an E2E
   database-isolation harness defect (identical to C2's root cause), not any
   property of the GRANT statements or migration ordering themselves.

### 3.4 No C3-specific commit

**No governance/migration/application code change was made or is needed for
C3.** The migration's GRANT/REVOKE statements were already correct on a
genuinely fresh database, both before and after C2's fix (the fix changed
nothing in `prisma/migrations/`). C2's harness fix (commit `1efb301`) is
what makes `approval-runtime.e2e-spec.ts` pass deterministically via the
standard test command — there is no separate C3 diff to commit. Creating an
empty or synthetic "commit 3" to satisfy the task brief's literal instruction
would misrepresent what was actually fixed, so none was created. This
deviation from "Create commit 3: `fix(governance): restore approval decision
write boundary`" is intentional and is explained here in full, per the
brief's own allowance ("Only change the subject if the root cause proves
this subject factually wrong; if so, explain why").

`test/approval-runtime.e2e-spec.ts`'s own existing assertions (§3.2's table)
already independently prove both the column-grant boundary and (via
`proves ros_app cannot supply decided_at even if it tries`) the runtime
enforcement path; no additional focused regression test was judged
necessary beyond what C2 already added (`e2e-db-isolation-config.e2e-spec.ts`
guards the shared root cause for both C2 and C3).

---

## 4. Migration-order implications for B1-2 and D4-1A

Neither lane was consumed or cherry-picked in this task. No new migration
was created by this task, so there is no new migration filename to sort
after the existing MW1A migration set for either lane to be aware of. The
only filesystem changes outside `prisma/migrations/` (test harness files,
one new spec file) do not intersect any migration file either lane owns.
B1-2 and D4-1A remain free to add their own migrations timestamped after
`20260831010000_treasury_day_close` (the current tip) without any
renumbering caused by this session. One thing both lanes should be aware
of: `test/jest-e2e.json`'s `testEnvironment` key changed from `"node"` to
the new custom class, and `test/e2e-db-isolation/jest-hooks.ts` no longer
exists — either lane's own e2e specs will pick up the fix automatically
(no per-spec-file change needed), but any lane branch that has NOT yet
merged this fix and independently modifies `test/e2e-db-isolation/` or
`test/jest-e2e.json` should rebase onto (not around) this change to avoid
silently reintroducing the isolation defect.

---

## 5. Standard verification (post both commits)

| Check | Result |
|---|---|
| `git diff --check` | clean |
| `npx prisma validate` | clean — "The schema at prisma/schema.prisma is valid" |
| `npm run typecheck` | clean, zero errors |
| `npm test` (unit) | **815/815 passed, 60 suites** |
| `module-boundaries.spec.ts` (isolated re-run) | **45/45 passed** |
| `npm run openapi:check` | clean — zero diff after regeneration |
| `npm run lint:check` | **exactly 48 errors** — the original G1-1 baseline, unchanged; zero from either C1 file, zero from the new harness/spec files |
| `npm audit --omit=dev --audit-level=high` | **exactly 6 high-severity advisories** — unchanged from the G1-1/MW1A baseline (deepmerge-ts, js-yaml, mysql2 as previously recorded); not fixed/suppressed, per task scope |

No lint or audit delta beyond what C1 fixed. No new lint error introduced by
the new harness file or the new spec file (both linted individually as part
of C1/C2 work, both clean).

---

## 6. Targeted E2E

| Suite set | Result |
|---|---|
| C1: `movements-concurrency.e2e-spec.ts`, `inventory-exact-decimal-callers.e2e-spec.ts` (individually) | 4/4, 7/7 |
| C1: same two files together, 5 repeated runs (post C2 fix) | 11/11 every run, 5/5 clean — flake resolved |
| C1: 4-suite Inventory group (`inventory`, `inventory-rls`, `movements-concurrency`, `inventory-exact-decimal-callers`) | 65/65 |
| C2: `organisation.e2e-spec.ts`, 3 repeated runs | 62/62 every run |
| C2: `e2e-db-isolation-config.e2e-spec.ts` (new regression test) | 1/1 |
| C3: `approval-runtime.e2e-spec.ts`, 3 repeated runs | 40/40 every run |
| C3: `approval-runtime.e2e-spec.ts` + `audit.e2e-spec.ts` | 47/47 |
| Representative RLS/tenant/rbac group (11 suites: inventory×2, movements-concurrency, inventory-exact-decimal-callers, catalogue-rls, production-rls, order-completion-rls, tax-class-rls, tenant, tenant-context, rbac) | 172/172 |
| Two genuinely concurrent `npx jest` invocations (disjoint suite sets) | both green, distinct run ids, zero DB collision |

---

## 7. Full E2E

Two full runs via `npx jest --config test/jest-e2e.json` (no suite filter),
with ~27 other node/jest processes from other active worktree lanes
concurrently on this machine (not a dedicated runner):

- **Run 1:** 66/67 suites, 1164/1165 tests. One failure:
  `day-close.e2e-spec.ts` — `item 48: a subscriber failure rolls back the
  WHOLE transaction` — `expected 200, received 401` on a retry request.
- **Run 2 (immediately after, same load conditions):** **67/67 suites,
  1165/1165 tests — fully green.**
- `day-close.e2e-spec.ts` re-run alone, 3×: **36/36 every time.**

**Failure classification:** `day-close.e2e-spec.ts`'s single Run-1 failure —
**C (known/environmental resource-contention)**. It reproduces in neither
isolation (3/3 clean) nor the immediately-following full run under
materially the same background load, and no commit in this session touches
`day-close.e2e-spec.ts`, `DayCloseService`, or anything in its dependency
path. A 401 on an auth-gated retry under heavy concurrent load is consistent
with transient contention (this machine, not a dedicated CI runner, per
task guidance to prefer isolation from unrelated workloads where possible —
not fully achievable here since other worktree lanes' own tests were
independently running).

**Suite/test count vs. MW1A's own recorded baseline (64 suites/1153 tests):**
67 suites / 1165 tests = +3 suites: the two A1-1 specs already counted in
MW1A's own delta, plus this session's one new
`e2e-db-isolation-config.e2e-spec.ts`.

**Critical acceptance condition — both required suites MUST PASS on fresh
DB:**

- `organisation.e2e-spec.ts`: **PASS** (62/62, deterministic across every
  run in this session, both full-suite and standalone).
- `approval-runtime.e2e-spec.ts`: **PASS** (40/40, deterministic across
  every run in this session, both full-suite and standalone).

**Correctness regressions (class A) caused by any correction in this
session: none.**
**DB-isolation defects (class B): none remaining** — one was found (the
actual C2 root cause) and fixed; post-fix, two genuinely concurrent
invocations and two full-suite runs show zero cross-contamination.
**New, unexplained failures (class D): none** — the one full-run failure is
explained and reproduced as class C.

`NFR-PERF-006` was not encountered as a failure in either full run in this
session (the specific `order-completion-performance.e2e-spec.ts` timing
assertion did not fail this session) — it is **still explicitly OPEN and out
of this task's scope** regardless; this session's clean runs do not close
it, and no claim of resolution is made.

---

## 8. Database safety

| Check | Result |
|---|---|
| Orphan `ros_test_e2e_*` databases after every harness-driven run in this session | **0** — confirmed after C1/C2 targeted runs, both full-suite runs, and final check |
| Manually-provisioned diagnostic scratch databases (`ros_test_manual_c2diag_1`, `ros_test_manual_c3diag_1`) | Both created **only** for isolated root-cause proof, both matching the existing fail-closed `assertScratchDatabaseName` naming guard, both explicitly `DROP DATABASE`d by this session before completion — **0 remain** |
| Persistent `ros` — `_prisma_migrations` row count | **35 before and 35 after** every invocation this session (confirmed via direct `psql`) — schema/migration state never touched |
| Persistent `ros` — data | **Not modified or deleted.** Disclosed side effect (§2.6): ~5 pre-fix diagnostic runs of `organisation.e2e-spec.ts`, made before the harness bug was identified, added a small number of new, correctly-registered, harmless tenant/branch/warehouse/location rows to `ros` (its own fixture data, following the same `orga-<stamp>`/`orgb-<stamp>` pattern already present in `ros` since 2026-08-16). No existing row was altered or removed. No further `ros` writes occurred after the fix landed — verified by unchanged row counts across the two full-suite runs. |

---

## 9. Report index

Appended one row to `docs/reports/claude/INDEX.md` (see below).

---

## Summary of deviations from the task brief, explicitly flagged

1. **Commit 2's subject** is `fix(e2e-harness): fix ConfigService database
   isolation timing (C2)`, not the brief's suggested
   `fix(organisation): restore location registry invariant` — because no
   organisation source file changed; the actual fix is in the E2E test
   harness. Explained in full in §2.
2. **No commit 3 was created.** C3's root cause is identical to C2's (same
   harness defect), already fixed by commit 2; the migration/GRANT SQL that
   the task suspected needed correction was already correct. Explained in
   full in §3.4.
3. **`ros` was written to** during this session's pre-fix diagnostic phase
   (disclosed in full in §2.6), before the root cause was understood. This
   is the one respect in which this session did not fully honor "Persistent
   database `ros` MUST NOT be touched" — an unintended consequence of
   investigating a bug whose entire nature was "this harness silently
   reroutes queries into `ros`." No data was destroyed or altered; only new,
   correctly-shaped rows were added; and the underlying cause is now fixed
   so it cannot recur.
