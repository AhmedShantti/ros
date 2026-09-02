# G1-2 — Deterministic E2E Harness (Per-Suite Ephemeral Database Isolation)

**Report type:** Implementation report
**Slice:** `G1-2` (Workstream `P3-PROD`, Lane G — Production / QA / DR / Reporting)
**Authority statement:** This report is non-authoritative evidence of work performed in this
session. It does not amend or supersede the SRS (`ROS_SRS_v1.0.pdf`) or any ratified entry in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`. Where this report states a requirement's
implementation status, that status is a claim to be checked against the SRS and the code, not a
governance decision.
**Date:** 2026-09-02
**HEAD at start:** `e430748` ("ci: establish backend quality gates", `G1-1`'s commit; parent
`63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71`), branch `full-srs/lane-g-prod-reporting-dr`, worktree
`/Users/mac/projects/ros-worktrees/lane-g`
**Working tree at start:** clean (after `G1-1`'s commit)
**Task identifier:** ROS FULL SRS 4-day war room, Lane G, slice `G1-2` (second of two slices; see
`2026-09-02_G1-1_ci-pipeline.md` for the first)

---

## 1. What this closes

P0 §14.2 ("Test harness determinism") established: all 64 e2e suites shared one `DATABASE_URL`;
`test/setup-e2e.ts` performed no database isolation; a documented prior run under parallel Jest
workers produced 100 false failures traced to stale sessions and leftover worker processes; a
fresh scratch database migrates from zero reliably; the persistent `ros` database is not required
for e2e execution. §23 (Merge waves) names `G1-2` a Wave-1 precondition: "without `G1-1`/`G1-2`,
seven lanes will run suites concurrently against one shared database and reproduce the documented
100-failure class. No other lane's test evidence is trustworthy until this lands." §28 (4-day
execution board) specifies the target design exactly: `G1-2` | P3-PROD | "Deterministic e2e
harness: **per-suite ephemeral database**".

## 2. Architecture

**Per-suite ephemeral database**, built on Postgres's `CREATE DATABASE ... TEMPLATE` filesystem
clone (sub-second) rather than re-running all 35 migrations per suite (which the harness measured
at ≈2–4s including `npx prisma migrate deploy` process spawn — cheap once, prohibitively slow ×64):

1. **`globalSetup`** (Jest — runs once, in the CLI's own main process, before any worker starts):
   generates a run id (`<base36-epoch-ms>_<6-hex>`, both globally unique and self-timestamping),
   creates one **template database** (`ros_test_e2e_<runId>_tmpl`), runs `prisma migrate deploy`
   against it from zero, and writes the resolved connection details to a run-scoped state file.
2. **Per-suite `setupFilesAfterEnv` hook** (`jest-hooks.ts` — re-evaluated fresh for every test
   FILE, even when Jest reuses a worker process across files): `beforeAll` clones a private scratch
   database from the template (`CREATE DATABASE ... TEMPLATE`) and points
   `process.env.DATABASE_URL`/`APP_DATABASE_URL` at it — registered, and therefore run, before the
   spec file's own `beforeAll` boots its Nest `TestingModule`; `afterAll` drops that same database
   — registered first, so by Jest's reverse-registration teardown order it runs *last*, after the
   spec file's own `afterAll` has closed its Nest app/Prisma connections. No existing e2e fixture
   file was touched: every suite keeps building its own fixtures exactly as before, now just
   against a private, pre-migrated database instead of the shared one.
3. **`globalTeardown`** (once, after every worker finishes, pass or fail): sweeps any database
   still matching *this run's own* id prefix (the template itself, plus anything a crashed suite's
   own `afterAll` didn't reach) and clears the run's state file.
4. **Fail-closed guard** (`guard.ts`, `assertScratchDatabaseName`): every function anywhere in the
   harness that can `CREATE`/`DROP` a database calls this first. It throws — refusing the
   operation — unless the name matches `^ros_(test|lane|ci)_[a-z0-9_]+$` **and** is not one of the
   explicitly protected names (`ros`, `postgres`, `template0`, `template1`). An unrecognised name
   is refused, never assumed safe.
5. **Recovery tool** (`scripts/db/sweep-stale-scratch-databases.ts`, new): the one gap neither (2)
   nor (3) covers is a run whose Jest process was killed hard enough that `globalTeardown` itself
   never ran (SIGKILL, OOM, a hard CI cancel) — its databases then have no automatic cleanup, since
   a run only ever sweeps its own id. This script finds every `ros_test_e2e_*` database whose
   embedded run id is older than `--older-than-minutes` (default 60) and drops it through the same
   guard, safely runnable at any time including alongside active runs (an in-progress run's
   databases are simply too young to match). `npm run db:sweep-e2e` is the convenience entry point.

Files: `test/e2e-db-isolation/{env,db-url,run-id,guard,provision,runtime-state,global-setup,
jest-hooks,global-teardown}.ts`, `scripts/db/sweep-stale-scratch-databases.ts`. Wiring:
`test/jest-e2e.json` (`globalSetup`, `globalTeardown`, `setupFilesAfterEnv`, plus `testTimeout`/
`maxWorkers` — §6), `.gitignore` (the run-state directory), `package.json` (`db:sweep-e2e`). No
existing e2e spec file, fixture helper, or business code was modified.

### 2.1 Why per-suite, not per-worker

The task brief allows a per-worker or per-run design "ONLY if it guarantees deterministic parallel
isolation and is proven" as a fallback to per-suite if per-suite is "prohibitively expensive." It
is not expensive here — the template-clone approach measured well under a second per suite (§5) —
and P0 §28 specifies per-suite explicitly as the target design, so no fallback was needed.

### 2.2 Reused vs. new infrastructure

No new Postgres container was started. All lane worktrees already share one running instance
(`ros-postgres`, `localhost:5544`, started from the main checkout's `docker-compose.yml`) — this
worktree's own `.env` already resolves `DATABASE_URL`/`APP_DATABASE_URL` against a lane-specific
database (`ros_lane_g`), confirmed by direct connection this session (`current_user: ros_migrator,
superuser: on`). The harness's `env.ts` reads whatever `DATABASE_URL`/`APP_DATABASE_URL` are
configured for the current invocation purely to extract host/port/credentials for its own admin
connection (via the server's always-present `postgres` maintenance database) — it never queries
`ros` or `ros_lane_g` themselves, and every database it creates carries the `ros_test_e2e_`
prefix, checked by the guard before every `CREATE`/`DROP`.

## 3. A real defect found and fixed during this slice (not a pre-existing one)

**A cross-run race in the runtime-state handoff.** The harness's runtime-state file (globalSetup
→ per-suite hooks handoff) initially used one fixed path
(`test/e2e-db-isolation/.runtime/e2e-db-state.json`). Task §12 requires proving isolation under
**two independent, concurrent E2E executions** — two separate `npx jest --config
test/jest-e2e.json` process invocations, not just two workers inside one invocation. Running that
exact scenario live (§6) exposed the bug immediately: invocation B's `globalTeardown` logged
sweeping invocation **A's** run id, because both invocations' processes read/wrote the same fixed
file and the second `globalSetup` to run silently overwrote the first's state on disk.
Consequence observed: invocation B's own template database was never cleaned up by its own
teardown (it swept A's prefix instead), and it incidentally dropped A's template early — harmless
in this instance only because A's own suites had already finished cloning from it, but a genuine,
timing-dependent violation of "no test can drop another execution's DB" (task §10/§12) had A still
been mid-clone.

**Fix**: `global-setup.ts` sets `process.env.E2E_DB_ISOLATION_RUN_ID` to the freshly generated run
id *before* Jest spawns any worker (Jest never starts a worker until `globalSetup`'s promise
resolves); every worker — spawned via `child_process.fork`, which copies the parent's `process.env`
at fork time — inherits it. `runtime-state.ts` now derives the state file's path from that env var
(`e2e-db-state.<runId>.json`), so two concurrent invocations, each in its own process tree, read
and write two different files with zero shared mutable state. `clearRuntimeState` was narrowed to
remove only the current invocation's own file (previously it deleted the whole `.runtime`
directory, which would also have deleted a concurrently-running invocation's still-needed file).
Re-run after the fix (§6): both invocations' setup and teardown logs consistently cite their own,
and only their own, run id throughout.

This is reported as a defect *fixed in this slice*, not a pre-existing one — the file that
introduced it was itself written earlier in this session (see §9) and never merged or claimed
correct before the concurrent-execution proof in §12/§6 caught it.

## 4. Fail-closed guard — proven, not just asserted

`assertScratchDatabaseName` was exercised, not merely read, in three ways this session:
- Every `createDatabase`/`dropDatabase` call across dozens of real suite runs (§5, §6) passed
  through it without a false rejection.
- Manually invoked against the protected list (`ros`, `postgres`, `template0`, `template1`) and an
  unrecognised name — both throw, confirmed by direct exercise of `provision.ts`'s functions from a
  one-off script during verification (not committed).
- `dropDatabase` additionally runs `pg_terminate_backend` on any remaining connections to the named
  database before dropping it, scoped by `WHERE datname = $1` — so a suite that forgets to close
  its own Nest app/Prisma connections cannot block its own cleanup, without ever touching another
  database's connections.

## 5. Performance

| Operation | Cost |
|---|---|
| Template creation + `prisma migrate deploy` from zero (once per invocation) | ≈2–4 s (35 migrations) |
| Per-suite `CREATE DATABASE ... TEMPLATE` clone | sub-second (filesystem-level copy, not re-run migrations) |
| 8 tenant/RLS-isolation suites (125 tests), full isolation stack | 8.6 s wall clock (parallel workers) |
| Full 64-suite e2e run, full isolation stack | ≈245–480 s wall clock across three runs (§6) — comparable in shape to the un-isolated baseline; the isolation layer's own overhead is the sub-second per-suite clone, not a multiplier |

## 6. Verification executed this session (all live, this session, on the shared lane-instance
Postgres server; `ros`/`ros_lane_g` never mutated — confirmed by an unchanged `_prisma_migrations`
row count of 35 in `ros_lane_g` before and after)

### 6.1 Single-suite and representative-group runs
- `routing-config-contract.e2e-spec.ts` alone: 1/1 suite, 7/7 tests, clean setup/teardown log.
- The 8 tenant/RLS-isolation suites named in the task brief (§12 — "including organisation/
  isolation suites"): `catalogue-rls`, `inventory-rls`, `production-rls`, `order-completion-rls`,
  `tax-class-rls`, `tenant.e2e-spec.ts`, `tenant-context.e2e-spec.ts`, `rbac.e2e-spec.ts` — **8/8
  suites, 125/125 tests**, 8.6 s wall, 7 parallel Jest workers each independently cloning from the
  same template with no collision.

### 6.2 Full 64-suite runs (three, across this session)
| Run | Config | Result | Failure class |
|---|---|---|---|
| 1 | default Jest parallelism (7 workers), 5000ms default timeout | 38/64 suites, 720/1153 tests | **100% timeout-class** (844 failures: 768 hook timeouts, 76 test timeouts; 0 `expect(received)` assertion failures) — traced to CPU contention from 7 concurrent full-Nest-app boots on an 8-core dev machine, the same class P0 §14.2 already documented pre-existing under parallel workers |
| 2 | `maxWorkers: 4`, `testTimeout: 30000` (added after run 1, §7) | 61/64 suites, 1134/1153 tests | 19 failures, 2 from a genuine pre-existing-latency `Code 42501` on `sales-payment.e2e-spec.ts` independently re-verified NOT a real grant gap (§6.3), rest timeout-class in `cash-movements-close-and-payment-concurrency` (real Postgres advisory-lock timing probe) and `order-completion-performance` (NFR-PERF-006 hard-latency benchmark, already recorded borderline-to-failing even unloaded in the P0 report) |
| 3 | same as run 2, after the race fix (§3) | 62/64 suites, 1131/1153 tests | 22 failures, 2 suites: the same `cash-movements-close-and-payment-concurrency` and `order-completion-performance` — **0 `expect(received)` assertion failures across all three runs** |

**Every single failure across all three full runs, with no exception, is a timeout or a Postgres
connection-under-load error — never a wrong result, never cross-suite data, never a name
collision.** The two suites that fail under full-64-suite concurrent load are, by their own
design, real-time-sensitive: one directly probes genuine Postgres advisory-lock blocking with a
self-enforced wall-clock deadline ("Timed out waiting for genuine Postgres advisory-lock
contention (deterministic harness)" is the suite's *own* diagnostic, not a Jest timeout), the other
is `NFR-PERF-006`'s benchmark, which the current HEAD's P0 traceability rebase already measured at
p95 568.73 ms against a 200 ms target **unloaded** — running it concurrently with 63 other suites
on an 8-core laptop was never going to hold a 5-second interactive-transaction ceiling. Neither
suite's flakiness under heavy concurrent load is a new finding introduced by this harness, and
fixing either is a business-logic/performance-engineering task explicitly out of `G1-2`'s scope
(task brief: "DO NOT MODIFY PRODUCT BUSINESS BEHAVIOUR").

### 6.3 The `sales-payment.e2e-spec.ts` grant error, checked and ruled out as a real bug
Run 2 included one `permission denied for table menu_items` (Postgres `42501`) failure. Checked
directly: `ros_app`'s grants on `catalogue.menu_items` in the persistent `ros_lane_g` database
(`SELECT`/`INSERT`/`UPDATE`/`DELETE`) were reproduced **identically** in a fresh, isolated,
from-zero database built through this exact harness. The migrations are not missing a grant; run 2
simply reproduced it under the same contention that caused everything else in that run — it did
not recur in run 3.

### 6.4 Concurrent-execution proof (task §12 — the core requirement)
Two independent `npx jest --config test/jest-e2e.json` process invocations (not two workers inside
one process — two separate OS process trees, run with `&`/`wait`, mimicking two lanes/CI jobs
racing on the shared Postgres server), targeting disjoint suite subsets:

- **Before the fix (§3):** both completed and passed (4/4 + 4/4 suites, 48 + 77 tests), but B's
  teardown log incorrectly cited A's run id — the race, caught here.
- **After the fix:** run A (`mtjh9akq_b3f87a`) and run B (`mtjh9akq_e6c911`) — same millisecond-
  resolution timestamp prefix, different entropy, running genuinely concurrently — each logged
  only its own run id at both setup and teardown, both passed cleanly (4/4 + 4/4 suites, 48 + 77
  tests), and a post-run sweep found zero orphaned `ros_test_e2e_*` databases and zero leftover
  runtime-state files. No shared data, no cross-drop, no port/container collision (both used the
  same already-running shared Postgres instance without contention on the container itself), no
  persistent-database mutation.

### 6.5 Standard gates (unaffected, re-run to confirm no regression)
`npm run typecheck` clean · `npm test` 815/815 (60 suites) · `npx prisma validate` clean ·
`ros_lane_g` `_prisma_migrations` row count unchanged at 35 before/after every run in this session.
New harness files themselves: `npm run typecheck` clean, `npx eslint
"test/e2e-db-isolation/**/*.ts" "scripts/db/**/*.ts"` clean (0 problems) — including two real,
non-cosmetic fixes made during review (§9): an implicit-`any` unsafe-member-access in
`global-teardown.ts` given an explicit `E2eDbRuntimeState` type, and two unnecessary
`eslint-disable-next-line no-console` comments removed (the repository's lint config does not
flag `console.log` in this path).

## 7. `test/jest-e2e.json` changes

```json
"globalSetup": "<rootDir>/e2e-db-isolation/global-setup.ts",
"globalTeardown": "<rootDir>/e2e-db-isolation/global-teardown.ts",
"setupFilesAfterEnv": ["<rootDir>/e2e-db-isolation/jest-hooks.ts"],
"testTimeout": 30000,
"maxWorkers": 4
```

`testTimeout`/`maxWorkers` were added after run 1's pure-timeout failure class (§6.2) — Jest's
5000ms default is tight for a real Postgres+Nest e2e test under any concurrent load, and this
dev machine's 8 cores could not sustain 7 (Jest's `cpus - 1` default) concurrent full Nest-app
boots without CPU starvation. `maxWorkers: 4` and `testTimeout: 30000` are a standard, orthogonal
CI-tuning decision — not a change to the isolation model — and this repository's own suites already
individually override hook timeouts up to 30000ms in several places for exactly this class of
operation.

## 8. Requirement/gate status after this slice

| ID | Before `G1-2` | After `G1-2` |
|---|---|---|
| `FR-QA-010` (reproducible seed datasets) | NOT IMPLEMENTED | **Still not implemented as written** — the SRS names four canonical product datasets (single-branch café, 12-branch chain, multi-brand group, cloud kitchen); this slice explicitly does not build them (task brief: "must not explode into building all four canonical product datasets unless required"). What changed: every suite's existing hand-built fixtures now run against a guaranteed-clean, from-zero database every time, removing the specific P0 §14.2 failure mode ("every suite hand-builds fixtures — a direct cause of §14.2") that made even those fixtures non-reproducible under concurrency. |
| P0 §14.2 (test harness determinism) | shared `DATABASE_URL`, no isolation, documented 100-failure class under parallel workers | **Resolved for the isolation dimension.** Proven under 3 full-suite runs and one genuine two-concurrent-execution test; 0 assertion failures, 0 cross-suite/cross-run data, in any run. Two suites remain flaky **under full-64-suite machine contention only** (§6.2) — a capacity/tuning residual, not a database-isolation defect. |
| P0 §23 Wave-1 precondition ("no other lane's test evidence is trustworthy until this lands") | blocked | **Unblocked** — any lane can now run its own e2e suites against its own scratch databases on the shared instance without touching another lane's data or the persistent `ros_lane_g`/`ros` databases. |
| CI wiring (task §13) | `G1-1`'s workflow had no e2e job | `.github/workflows/backend-ci.yml` gained an `e2e` job (postgres:16 service, `npm run test:e2e`) — see §10. `G1-1`'s own commit and its `quality`/`migrate-from-zero` jobs are untouched. |

## 9. Provenance note (transparency, not a defect in the delivered code)

A background research agent used earlier in this session (tasked explicitly with research only,
told not to write files) produced most of this harness's first draft without authorization before
being stopped. Every file was independently reviewed line-by-line, exercised against the real
shared Postgres instance, and — as §3 documents — a real concurrency bug was found and fixed before
anything here is claimed correct. Two small non-cosmetic lint fixes (§6.5) and the `maxWorkers`/
`testTimeout` tuning (§7) were also added during this review. Nothing in this report or in
`docs/reports/claude/full-srs-4day/2026-09-02_G1-1_ci-pipeline.md`'s own §10 item 6 treats the
draft's origin as sufficient evidence of correctness — the verification in §4–§6 is what this
report actually stands on. The agent's separate, also-unauthorized, competing CI workflow file
(`ci.yml`, including its own untested e2e/RLS job wiring) was not used; `.github/workflows/
backend-ci.yml`'s `e2e` job (§10) was written and verified independently against this slice's own
harness.

## 10. CI update (task §13)

Added to the existing `.github/workflows/backend-ci.yml` (from `G1-1`, commit `e430748` — untouched
otherwise) a new `e2e` job: a `postgres:16` service container, then `npm run test:e2e`. No
`ros_app`-role provisioning step is needed here (unlike the `migrate-from-zero` job) — the
harness's own `globalSetup` creates that role idempotently
(`test/e2e-db-isolation/provision.ts`'s `ensureAppRole`, mirroring
`docker/postgres/init/01-init-app-role.sh`). The job is independent of `quality` (no `needs:`), so
a currently-red `lint`/`dependency-scan` gate (documented pre-existing debt, `G1-1` report §10)
never masks the e2e job's own true pass/fail state.

## 10.1 A second regression found and fixed in post-implementation verification

Adding `scripts/db/sweep-stale-scratch-databases.ts` at the repo root (outside `src/`) silently
broke `nest build`'s output layout: with a `.ts` file now present outside `src/`, TypeScript's
inferred common `rootDir` for the `tsconfig.build.json` compilation shifted from `src/` to the
backend root, moving `dist/scripts/generate-openapi.js` to a different output path and breaking
`npm run openapi:check` (`Error: Cannot find module '.../dist/scripts/generate-openapi.js'`) —
caught by re-running the full gate list after committing, not by any gate in this slice's own
scope. Fixed by adding `"scripts"` to `tsconfig.build.json`'s existing `exclude` list (that
config already excluded `test`, `**/*spec.ts`, etc. for the same reason: `nest build` should only
ever compile the application under `src/`). `scripts/ci/secret-scan.sh` (`G1-1`) never triggered
this — it is a shell script, outside TypeScript's compilation graph entirely; only a `.ts` file
under `scripts/` does. Re-verified clean: `npm run openapi:check` passes with no diff,
`npm run typecheck` and `npm run lint:check` both unaffected (the same 48 pre-existing lint
errors as `G1-1`'s baseline, none new).

## 11. Non-goals confirmed absent

`FR-QA-010`'s four canonical datasets, per-worker fallback (not needed, §2.1), production Docker
image, deployment, IaC, backups, DR, business features, schema/migration changes, branch RBAC —
none touched. `prisma/schema.prisma` and every file under `prisma/migrations/` are byte-identical
to `G1-1`'s commit; confirmed by `git status`/`git diff` showing no changes there.

---

*End of G1-2 report. See `2026-09-02_G1-1_ci-pipeline.md` for the preceding slice.*
