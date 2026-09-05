# MW1G — Integrate SCHED-1 durable scheduler foundation

**Report type:** Reviewed-slice integration + verification
**Authority:** This report is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf` and the
ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative.
Where this report disagrees with the SRS or a ratified governance decision, the SRS and
the register win. This report records what was observed and measured in this session — it
ratifies nothing and authorises nothing.
**Date:** 2026-09-03
**Worktree:** `/Users/mac/projects/ros-worktrees/integration`
**Branch:** `full-srs/4day-integration`
**Baseline HEAD:** `92d470b4cbfb46e18cbad205561661d54c93420c` (verified clean working
tree at session start)
**Implementation HEAD (post cherry-pick, pre report commit):** `bfb97f77561afde21fadcc11865f2e1b1a10812d`
**Resulting HEAD (post report commit, see §7):** recorded at the end of §7 after the
report commit is made — the report file itself cannot know its own resulting commit
hash at write time, so the chat response states it explicitly after the commit.
**Task identifier:** MW1G

## 0. Scope and starting-state verification

Verified before any change: `pwd` = worktree root
(`/Users/mac/projects/ros-worktrees/integration`), branch = `full-srs/4day-integration`,
`git rev-parse HEAD` = `92d470b4cbfb46e18cbad205561661d54c93420c` (matched the task's
expected starting HEAD exactly), `git status --porcelain=v1 -uall` clean.

All three target commits confirmed to exist as commit objects (`git cat-file -t`) and
confirmed **not reachable** from integration HEAD before starting
(`git merge-base --is-ancestor <sha> HEAD` failed for all three, as expected):

| Commit | Subject |
|---|---|
| `23daa5e` | feat(platform): add durable scheduled job execution |
| `fd595ab` | feat(inventory): schedule daily reconciliation |
| `6d9e5aa` | docs: record durable scheduler foundation |

`git show --stat` was inspected for every commit before cherry-picking to assess
overlap risk against the current tree:

- No `platform` schema, module, or scheduler code existed anywhere on the integration
  branch prior to this session (`src/modules/platform` did not exist; `platform` schema
  had zero tables).
- `platform` was already present in the Inventory module-boundary test's forbidden-schema
  list (`test/inventory.e2e-spec.ts`, `'procurement','crm','analytics','platform','ck'`)
  — exactly the line `fd595ab` is designed to narrow (remove `platform`, add a pinned
  assertion against the exact 3 scheduler tables), so this was an expected, not a
  conflicting, touch point.
- `app.module.ts`, `env.validation.ts`, `.env.example`, `redaction.ts`,
  `metrics.service.ts`, `alert-rules.spec.ts`, and `backend-api.rules.yaml` were all
  grepped for any pre-existing scheduler/job/platform content before the cherry-pick:
  none found. All additions to these shared files are purely additive.
- Migration count on the integration branch immediately before this session: **38**
  (confirmed via directory listing, not inferred).

## 1. Cherry-pick mapping (chronological order, exactly as specified)

| # | Source commit | Subject | Resulting commit | Conflict? |
|---|---|---|---|---|
| 1 | `23daa5e` | feat(platform): add durable scheduled job execution | `d79d4f5` | none |
| 2 | `fd595ab` | feat(inventory): schedule daily reconciliation | `e09c6ce` | none |
| 3 | `6d9e5aa` | docs: record durable scheduler foundation | `bfb97f7` | none |

All three cherry-picks (`git cherry-pick -x`) applied **byte-clean, zero conflicts** —
including `docs/reports/claude/full-srs-4day/INDEX.md`, which is a pure append and
merged cleanly with every prior row preserved exactly once (81 lines, 25 table rows
after; the new SCHED-1 row appended at the end, prior MW1F/D4-1B/A1-4/A1-3B rows
byte-identical to before). No manual conflict resolution was required at any step.

## 2. Post-integration hard-truth verification

- **Migration count: 39, measured** (`ls prisma/migrations | grep -E '^[0-9]' | wc -l`
  → 39; the sole new migration is `20260903020000_platform_scheduled_jobs`).
- **Occurrence identity DB-enforced**: `platform.job_occurrences` primary key is
  `(tenant_id, job_type, occurrence_key)` per the migration SQL — confirmed by direct
  read of `migration.sql`, not inferred.
- **RLS**: all three platform tables (`job_schedules`, `job_occurrences`,
  `job_findings`) carry both `ENABLE ROW LEVEL SECURITY` and
  `FORCE ROW LEVEL SECURITY` (confirmed by direct grep of the migration SQL, lines
  262–267). No `BYPASSRLS` grant anywhere in the migration or the platform module
  (grepped, zero hits besides comments stating its *absence*).
- **withAuthContext**: the runner and occurrence store are the only two files issuing
  tenant-scoped scheduler statements, and both go through
  `PrismaService.withAuthContext` — confirmed by direct read of
  `scheduled-job-runner.service.ts` and `scheduled-job-occurrence.store.ts`.
- **Zero new HTTP routes**: no `@Controller` anywhere under `src/modules/platform/`
  (grepped, zero hits); `openapi:check` (§3, step 15) produced a byte-identical
  `docs/api/openapi.{json,yaml}` diff — direct proof, not inference.
- **Zero new dependency**: `git diff --stat` against the baseline HEAD for
  `package.json`/`package-lock.json` is empty; `npm audit` totals unchanged at
  7 high / 1 moderate (§3, step 17).
- **Zero new `KNOWN_DEVIATIONS`**: no governance/deviation-register file
  (`docs/governance/GOVERNANCE_DECISION_REGISTER.md`, `docs/adr/*`) appears in the
  cherry-picked diff (`git diff --stat` against baseline HEAD, confirmed).
- **Fleet processing remains per-tenant fan-out**: `scheduler-performance.e2e-spec.ts`
  measured this directly this session (§3, step 10) — 1 tenant 6.15 ms, 10 tenants
  75.93 ms (12.4x for 10x the tenants), consistent with linear-in-tenants fan-out, no
  set-oriented cross-tenant claim.
- **Heartbeat liveness-only**: `SchedulerHeartbeatService` is disabled by default in
  this session's test/dev environment (`SCHEDULER_ENABLED` unset) and every e2e run
  this session shows `scheduler.heartbeat.disabled` logged while occurrences are still
  claimed and settled directly by the harness — direct evidence that heartbeat is not
  load-bearing for correctness, matching the design intent stated in the source code.

## 3. Verification steps run this session (sequential, as required)

| # | Step | Result |
|---|---|---|
| 1 | `git diff --check` (baseline HEAD → resulting HEAD) | **Clean** — no whitespace errors |
| 2 | `prisma validate` | **Clean** — schema valid |
| 3 | `tsc --noEmit` (after `prisma generate` to pick up new `platform` models) | **0 errors** |
| 4 | Unit tests (`npm test`) | **82 suites / 1125 tests, 0 failures** |
| 5 | Module boundaries (`module-boundaries.spec.ts`) | **46/46 PASS** (unchanged from MW1F's 46/46 — SCHED-1 adds no new boundary assertion) |
| 6 | Authorization coverage (`authorization-coverage.spec.ts`) | **9/9 PASS** — exact totals: **159 routes, UNDECLARED 17** (both figures byte-identical to the pre-MW1G/MW1F baseline, confirming zero new HTTP routes) |
| 7 | Scheduler core e2e | **30/30 PASS** |
| 8 | Scheduler concurrency e2e | **10/10 PASS** |
| 9 | Scheduler RLS e2e | **10/10 PASS** |
| 10 | Scheduler performance e2e | **5/5 PASS** — measured: batch-claim p50 17.64 ms / p95 28.44 ms (100 eligible of 2000 rows); fan-out 1-tenant 6.15 ms vs 10-tenant 75.93 ms (12.4x); real discovery tick (batch=5) 40.17 ms |
| 11 | Inventory scheduled reconciliation e2e | **11/11 PASS** |
| 12 | Existing Inventory concurrency matrix / depletion regressions (`inventory-concurrency-matrix`, `sale-depletion-*`, `movements-concurrency`, `inventory.e2e-spec`) | **6 suites / 81 tests, 0 failures** — unmodified by SCHED-1, confirming no regression |
| 13 | Observability alert/metric representative tests (`alert-rules.spec.ts` unit + `observability-red-cardinality`, `observability-sync-lifecycle` e2e) | **26/26 unit + 2 suites/5 tests e2e, 0 failures** |
| 14 | Scoped authorization representative tests (`scoped-authorization-matrix`, `reporting-authorization`, `kds-authorization` e2e) | **3 suites / 64 tests, 0 failures** |
| 15 | OpenAPI check (`npm run openapi:check`) | **Clean, zero diff** against `docs/api/openapi.{json,yaml}` — direct confirmation of zero new/changed HTTP routes |
| 16 | Lint baseline/final identity diff | **Exact match — 48/48, byte-identical file:line:column:ruleId:severity list, zero new findings.** Method: disposable detached worktree at baseline HEAD `92d470b`, real `cp -a node_modules` + `.env` copy + fresh `prisma generate`, `eslint … -f json` on both baseline and resulting HEAD, normalized to `path:line:col:ruleId:severity`, sorted, diffed — `diff` exit 0. Worktree removed after use. |
| 17 | Dependency audit (`npm audit`) | **8 vulnerabilities: 7 high / 1 moderate, unchanged from baseline.** Zero `package.json`/`package-lock.json` diff (`git diff --stat` empty) |
| 18 | From-zero migration gate | **Proven repeatedly, not separately re-run**: every one of the 8 e2e invocations in steps 7–14 and the full run in step 19 builds its own template database via the harness's `migrateFromZero` (`test/e2e-db-isolation/global-setup.ts`), applying all 39 migrations from an empty database before any suite runs. All succeeded. |
| 19 | **One** full E2E run, `--maxWorkers=2` | **91 suites / 1445 tests, 0 failures.** Single run, no reruns performed to manufacture green — none were needed. |
| 20 | Orphan scratch DB count | **0** — confirmed two ways: the harness's own teardown log (`swept 1 database(s) … (includes the template)`) after the full run, and a live `psql` count of `pg_database` rows matching `ros_test_e2e_%` immediately after (`0`). |

No suite was isolated for classification purposes — the single full E2E run was
green with zero failures, so no reruns and no isolation were needed.

## 4. Transactional safety review — ScheduledJobHandler contract and runner

Direct code review (`src/modules/platform/contract/scheduled-job.ts` and
`src/modules/platform/scheduler/scheduled-job-runner.service.ts`), not inference:

- `handler.detect(ctx)` is documented and implemented as effect-free, run **outside**
  the settle transaction, and may be re-run by any number of workers with no
  consequence.
- `handler.commit(tx, ctx, detected)` — where present — receives the substrate's own
  `Prisma.TransactionClient`, and is the **only** write handle offered to the handler.
  In the runner (`scheduled-job-runner.service.ts` lines ~444–460), `handler.commit(tx, …)`,
  the finding-writer inserts, and `this.store.settle(tx, …)` all execute inside one
  `this.prisma.withAuthContext({ tenantId }, async (tx) => { … })` transaction.
  `store.settle` is predicated on the exact `(lease_owner, attempt)` this worker
  claimed; if the lease was reclaimed while `detect` ran, the settle predicate matches
  zero rows, `ScheduledJobLeaseLostError` is thrown, and the **entire transaction —
  including any `commit` writes and any finding inserts — rolls back**. Metrics for
  findings are only recorded *after* the transaction commits successfully, so a
  rolled-back attempt inflates no counter either.
- **Inventory's `InventoryDailyReconciliationJob` does not implement `commit` at all**
  (confirmed by direct read of `daily-reconciliation.job.ts`): it only implements
  `detect` (calls the existing, already-verified `ReconciliationService.reconcile`,
  read-only) and `findings` (pure derivation, no I/O). It performs no HTTP call, no
  email/push/webhook, and mutates nothing. There is therefore no code path in this
  integration that could violate the transactional-effect boundary the contract
  documents — this is confirmed by inspection, not assumed.

**Evidence-clarification recorded, as required, and not generalized beyond its scope:**
the exactly-once domain-effect guarantee this session verified (scheduler core, RLS,
and concurrency e2e suites) is valid **specifically for transactional DB effects
committed inside the same transaction as the lease-guarded occurrence settle** (i.e.
any handler whose `commit` writes only through the `tx` argument it is given). It does
**not** generalize to a future job whose effect is a nontransactional external side
effect — email, push, a payment/fiscal-device provider call, or an outbound webhook —
because such an effect cannot be rolled back by a Postgres transaction abort. A future
handler of that shape will need an outbox and/or provider-side idempotency key design
before an exactly-once **external delivery** claim would be justified. No such handler
exists in this integration, and none was added. This is an evidence clarification
applied to the contract and the one real job it currently carries, not a redesign —
no code changed as a result of this review; only this report and this session's
requirement-status classifications are affected.

## 5. Requirement status (unchanged classification, verified not asserted)

Per the source commits' own stated dispositions, verified against this session's test
evidence rather than merely carried forward:

- **BR-INV-003** — ledger/projection reconciliation limb now runs on a schedule
  (`inventory.daily_reconciliation`, tenant-wide, verified by 11/11
  scheduled-reconciliation e2e tests). **Remains PARTIAL** — detection and durable,
  attributable findings exist; delivery to a human does not (no email/SMS/push/chat
  channel in this repository; governance decision N-A ratified none is introduced in
  this phase).
- **FR-INV-011** — "a scheduled job SHALL verify the reconciliation daily and alert on
  divergence." **Remains PARTIAL** for the same reason: the scheduled verification limb
  is implemented and verified; the alert-delivery limb is not.
- **FR-INV-051** — "SHALL raise a platform alert on any divergence," every
  (item, location) pair including non-branch/central-kitchen locations (tenant-wide
  scope, confirmed by direct read of `daily-reconciliation.job.ts` and its e2e suite).
  **Remains PARTIAL but PARTIALLY VERIFIED**: detection is verified end-to-end
  (including the divergence-sample-bounding and true-count-vs-sample behavior); a
  Prometheus alert rule and runbook exist (`backend-api.rules.yaml`,
  `inventory-ledger-divergence.md`) but no alert evaluator runs in this repository and
  no delivery channel exists, so alert *delivery* is not claimed.

No requirement is marked COMPLETE by this integration. No auto-fix of divergence
exists or was added. No `BYPASSRLS`/system-worker authority was invented.

## 6. Cross-cutting checks

- **Persistent `ros` untouched**: `git worktree list` before and after this session
  shows `/Users/mac/projects/ros` at `358feb4` [`feat/production-spec`], unchanged
  throughout. No command in this session targeted that path.
- **No merge/rebase/push/deploy**: none performed. All history additions are plain
  `git cherry-pick -x` onto the tip of `full-srs/4day-integration`.
- **No redesign of SCHED-1**: zero source-code changes beyond the three cherry-picked
  commits; the transactional-safety review in §4 is documentation/evidence only.
- **Existing G1/MW1D observability preserved**: `alert-rules.spec.ts` (26/26),
  `observability-red-cardinality` and `observability-sync-lifecycle` e2e (2 suites / 5
  tests) all pass unmodified; scheduled-job metric labels are `job_type` (bounded
  registry) and closed `phase`/`severity` enums only — grepped, no tenant/branch/
  occurrence UUID ever appears as a label anywhere in `metrics.service.ts` or the
  runner.

## 7. Report commit

This report and its `INDEX.md` row are recorded in a dedicated commit, on top of
`bfb97f7` (the implementation HEAD from the three cherry-picks), titled
`docs: record scheduler foundation integration`. No reconciliation production-code
changes were needed anywhere in this integration (all three cherry-picks applied
byte-clean), so no such commit was fabricated — this report commit carries
documentation only.
