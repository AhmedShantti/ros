# MW1F — Integrate A1-4 Inventory concurrency closure + corrected D4-1B Offline Domain slice

**Report type:** Reviewed-slice integration + cross-lane reconciliation + verification
**Authority:** This report is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf` and the
ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative.
Where this report disagrees with the SRS or a ratified governance decision, the SRS and
the register win. This report records what was observed and measured in this session — it
ratifies nothing and authorises nothing.
**Date:** 2026-09-03
**Worktree:** `/Users/mac/projects/ros-worktrees/integration`
**Branch:** `full-srs/4day-integration`
**Baseline HEAD:** `7fdde4cc220af718d7d36b6e17fb27e0f0b8c053` (verified clean working tree
at session start)
**Resulting HEAD:** `ca67df17edb9e1aa302f42728e158bbbd2036f6f`
**Task identifier:** MW1F

## 0. Scope and starting-state verification

Verified before any change: `pwd` = worktree root, branch =
`full-srs/4day-integration`, HEAD = `7fdde4c` (matched the task's expected starting
HEAD exactly), `git status` clean. All 8 target commits (`2743e6a`, `32504a7`,
`1e6c553`, `4c62df3`, `1fe490f`, `07b1d60`, `bedb7e3`, `a304e54`) confirmed to exist and
confirmed **not reachable** from integration HEAD before starting (`git merge-base
--is-ancestor` on each). File-level `git show --stat` was inspected for every commit
before cherry-picking to assess overlap risk against the current tree (`kitchen/tickets/sync/`
did not yet exist on this branch; `sync/auth/` had only `sync-terminal.guard.ts`;
`sync/operations/` already had the decorator/registry files from the D4-1A kernel
integrated earlier on this branch).

## 1. Cherry-pick mapping (in the required order)

| # | Source commit | Subject | Resulting commit | Conflict? |
|---|---|---|---|---|
| A1 | `2743e6a` | fix(inventory): close concurrent movement races | `523e3a1` | none |
| A2 | `32504a7` | docs: record inventory concurrency closure | `73f445a` | none |
| B1 | `1e6c553` | feat(sync): execute offline domain operations safely | `eb8792c` | none |
| B2 | `4c62df3` | feat(sync): add lossless revoked-terminal recovery | `de3cc29` | none |
| B3 | `1fe490f` | docs: record offline domain handler verification | `419e1cb` | **yes — `INDEX.md` append (see §2)** |
| B4 | `07b1d60` | fix(sync): correct offline domain integration gates | `b89aac9` | none |
| B5 | `bedb7e3` | docs: correct offline handler acceptance evidence | `c041c69` | none |
| B6 | `a304e54` | docs: correct recovery invariant evidence | `ca67df1` | none |

All 8 commits applied with `git cherry-pick -x`, preserving the source SHA in each
resulting commit trailer. Integration order followed the task exactly: A1-4 first (both
commits), then the complete D4-1B chain in chronological order (3 preserved/original
commits, then the 3 acceptance-correction commits).

7 of 8 cherry-picks were **byte-clean, zero-conflict applies** — the three-way merges
resolved identically to hand-authored changes because the files each commit touched
(`sync.module.ts`, `sync-batch.service.ts`, `operation-scheduler.ts`, `kitchen.module.ts`,
etc.) had not diverged between the D4-1B lane branch's parent state and this integration
branch's current state for those files.

## 2. Conflict and exact resolution

**File:** `kitchen-kit/backend/docs/reports/claude/full-srs-4day/INDEX.md`
**Commit that conflicted:** `1fe490f` (docs: record offline domain handler verification)

Both sides appended a new table row at the same location: HEAD (this branch) had
already appended the **A1-4** row (from cherry-pick A2, `73f445a`), and the incoming
commit appended the **D4-1B** row. This is the same class of append-only conflict every
prior integration wave (MW1B/MW1C/MW1D/MW1E) hit and resolved the same way: **both
rows are legitimate, independent, and chronologically ordered** — neither supersedes
the other. Resolution: kept both rows in full, in the order A1-4 then D4-1B (matching
the task's own integration order, A before B), removed the conflict markers, staged the
file, and continued the cherry-pick. No content was altered, truncated, or reworded from
either side. Zero other files conflicted in this commit or any other.

## 3. Reconciliation

**No reconciliation commit was created.** The one real conflict above was resolved
inline as part of continuing the `1fe490f` cherry-pick (its resulting commit,
`419e1cb`, carries the resolved `INDEX.md`); no reconciliation code changes were
required — `typecheck`, `lint`, `prisma validate`, unit, module boundaries, targeted
and full E2E all pass unmodified against the cherry-picked tree with no additional
hand-authored diff on top. The task's conditional reconciliation-commit step therefore
does not apply.

## 4. Preservation checks (hard requirements, spot-verified post-integration)

- **`kds.ticket.recall` remains UNREGISTERED**: confirmed by direct inspection —
  `sync.module.ts` no longer imports any recall handler; `sync/integration/` contains
  only `kds-ticket-bump-line.sync-handler.ts`; the only remaining references to
  `ticket-recall`/`kds.ticket.recall` in `src/` are an unrelated Sales domain-event
  handler (`sales/orders/ticket-recalled.handler.ts`) and `kitchen/contract/events.ts`
  (a different, non-Sync domain event); test files assert the type is unregistered.
- **`kds.ticket.bump_line` remains registered**: `SyncModule` providers include
  `KdsTicketBumpLineSyncHandler` from `sync/integration/kds-ticket-bump-line.sync-handler.ts`.
- **D4-1B acceptance-correction semantics preserved**: `07b1d60`/`bedb7e3`/`a304e54`
  were cherry-picked last, after the original/preserved commits, so the corrected
  module-boundary inversion (Kitchen publishes `KDS_OFFLINE_TICKET_OPERATIONS`;
  `sync/integration/` — not Kitchen — owns the one `@SyncOperationHandlerFor` provider;
  `ActorResolutionCache` added) is the surviving state, confirmed live in
  `kitchen.module.ts` and `sync.module.ts`.
- **A1-3 set-oriented depletion untouched**: `git log 7fdde4c..HEAD --
  sale-depletion.service.ts` is empty — zero commits in this integration touched it;
  `common/ids.ts` still uses `ulidx`'s `monotonicFactory()`.
- **G1 observability correlation fix untouched**: `git log 7fdde4c..HEAD --
  correlation.middleware.ts` is empty; the trusted-`request.authorization`-read fix is
  present unchanged.
- **B1-3 scoped authorization untouched as a primitive**: `SYNC_AUTHORIZATION_PORT` is
  bound to `SyncAuthorizationAdapter`, which calls B1-3's unmodified
  `ScopeAuthorizationService` — confirmed by the authorization coverage gate passing
  with no new permission codes and by the scoped-authorization e2e suites passing
  unmodified.
- **CT-08 / transfer-vs-sale / waste-vs-sale / weighted-average concurrency**: all 17
  A1-4 concurrency-matrix tests plus the full movements/order-completion/cash
  concurrency suites pass (§6).
- **Canonical sale depletion remains 28 statements**: `SaleDepletionService` was not
  touched by any commit in this integration (see above); its statement-count proof
  suite (`sale-depletion-set-oriented-writes.e2e-spec.ts`) passes unmodified.

## 5. Verification — run sequentially, one at a time

1. **`git diff --check` (7fdde4c..HEAD)** — clean, zero whitespace/conflict-marker
   errors.
2. **`prisma validate`** (after `prisma generate`) — `The schema at prisma/schema.prisma
   is valid`.
3. **`typecheck`** (`tsc --noEmit`) — clean, zero errors.
4. **Unit suite** (`npm test`) — **79 suites / 1059 tests, 0 failures.**
5. **Module boundaries** (`module-boundaries.spec.ts`) — **46/46 passed** (up from the
   pre-integration 45/45 — one new, intentional, asserted-live boundary assertion for
   the `sync/integration/` → Kitchen contract seam).
6. **Authorization coverage** (`authorization-coverage.spec.ts`) — **9/9 passed.**
   Exact counts (evidence log line): **159 routes total**, kind breakdown `tenant: 66,
   branch: 21, resource: 43, resourceOrTenant: 2, branchOrTenant: 3, brand: 3,
   sessionTerminalBranch: 2, declaredScope: 2, UNDECLARED: 17`. `UNDECLARED` here means
   "no `@AuthorizationTarget` decorator" and is asserted equal to
   `REVIEWED_UNPROTECTED_ROUTES + REVIEWED_TENANT_TARGET_ROUTES` (the itemised,
   live-asserted auth-only/tenant-reviewed allowlist) — i.e. **142/142 permission-bearing
   routes declared, 0 truly undeclared**, 17 reviewed exemptions (up from 16
   pre-integration — the 2 new recovery-controller routes net to +1 reviewed exemption
   after classification; no undeclared route exists per the gate's own `undeclared`
   assertion, which requires `toEqual([])` and passed).
7. **Targeted Inventory concurrency + A1-3 statement/performance gates** —
   `inventory-concurrency-matrix`, `inventory-exact-decimal-callers`, `inventory-rls`,
   `inventory`, `movements-concurrency`, `sale-depletion-effect-reservation`,
   `sale-depletion-lock-grouping`, `sale-depletion-set-oriented-writes`,
   `order-completion-concurrency` (×2), `cash-movements-close-and-payment-concurrency`
   — **10 suites / 119 tests, 0 failures** (`--maxWorkers=2`).
8. **Targeted Sync protocol/auth/recovery/contention/performance gates** —
   `sync-audit-contention`, `sync-causal`, `sync-contention`, `sync-crash-recovery`,
   `sync-idempotency`, `sync-kds-handlers`, `sync-performance`, `sync-protocol`,
   `sync-recovery`, `sync-rls`, `observability-sync-lifecycle` — **11 suites / 90 tests,
   0 failures** (`--maxWorkers=2`). All-success sync-batch paths logged in the 800–900 ms
   and ~2.2–2.5 s range depending on batch shape, comfortably under the 3000 ms
   `NFR-PERF-032` budget for the paths exercised by these suites.
9. **Scoped authorization representative suites** — `kds-authorization`, `rbac`,
   `reporting-authorization`, `scoped-authorization-matrix`, `scoped-rbac-migration`,
   `scoped-rbac` — **6 suites / 121 tests, 0 failures.**
10. **Observability representative regressions** — `observability-red-cardinality`
    (**1/1**, run standalone) plus `observability-sync-lifecycle` (green in step 8).
11. **OpenAPI check** (`npm run openapi:check`) — regenerated `docs/api/openapi.json`
    and `.yaml`; `git diff --exit-code` on `docs/api` reported **zero diff**.
12. **Full lint baseline comparison** — current tree: **48 errors / 0 warnings**.
    Rigorous identity comparison performed: a disposable detached worktree was created
    at the starting HEAD (`7fdde4c`), `node_modules` copied in (`cp -a`, real install,
    not symlinked), `prisma generate` re-run fresh, then ESLint run with `--format json`
    on both trees and every finding compared by exact `(file, line, column, ruleId)`
    identity. **Baseline: 51 findings (48 errors / 3 warnings). After: 48 findings (48
    errors / 0 warnings). NEW findings: 0. Removed: 3** — all three were
    `no-console`-related "unused eslint-disable directive" warnings in
    `test/sync-performance.e2e-spec.ts`, a file rewritten by the incoming D4-1B commits;
    the rewritten file no longer carries the now-unnecessary disable comments. **Zero
    new lint findings, confirmed by exact identity diff, not by count alone.** Disposable
    worktree removed after use (`git worktree remove --force`); `git worktree list`
    confirmed the persistent `/Users/mac/projects/ros` checkout was never touched.
13. **Dependency audit** (`npm audit`) — **8 vulnerabilities (7 high / 1 moderate)**,
    unchanged from the pre-integration baseline (7 high / 1 moderate); zero
    `package.json`/lockfile diff from this integration, so this is pre-existing
    registry-advisory state, not a regression introduced here.
14. **From-zero migration / scratch DB isolation gate** — `prisma/migrations` contains
    **exactly 38** numbered migrations (measured via `ls | grep -c '^[0-9]'`, not
    inferred). Every targeted and full E2E run in this session logged the harness's own
    from-zero proof: `template database "ros_test_e2e_..._tmpl" migrated from zero —
    per-suite databases will clone it`, each run applying all 38 migrations from an
    empty schema before any test executed. `scripts/db/sweep-stale-scratch-databases.ts
    --dry-run` reported **0** stale `ros_test_e2e_*` databases both before and after the
    full E2E run.
15. **One full E2E run, `--maxWorkers=2`** — **85/86 suites, 1378/1379 tests.** One
    failure: `observability-red-cardinality.e2e-spec.ts` ("50 distinct real branch ids
    ... collapse onto ONE time series") — a live HTTP call in a 50-iteration loop
    received `401` instead of `200`. Classified **Class C (contention-only)**: (a) this
    exact suite passed cleanly in isolation twice in this same session — once as part of
    the step-10 targeted observability run (1/1) and once again in a standalone rerun
    immediately after the full-suite failure (`--maxWorkers=1`, 1/1, 1.8 s); (b) `git log
    7fdde4c..HEAD -- test/observability-red-cardinality.e2e-spec.ts` is empty — the file
    was not touched by any of the 8 commits integrated in this session; (c) the failure
    mode (an auth token going stale mid-loop under heavier machine load) matches the
    documented full-suite-load contention pattern recorded identically in the
    MW1B/MW1C/MW1D/MW1E/A1-4 reports on this same branch. **No second full E2E run was
    performed to manufacture 86/86** — per the task's explicit instruction, the failure
    is reported honestly instead.

## 6. Hard post-integration truths — final status

**INVENTORY**
- CT-08 semantics preserved (verified live, §4/§6.7).
- Transfer-vs-sale and waste-vs-sale concurrency preserved (`inventory-concurrency-matrix`, 17/17 green).
- Weighted-average concurrent receipts preserved (same suite).
- Deterministic `stockItemId` lock ordering preserved (`movements.service.ts`/`counts.service.ts`/`waste.service.ts` untouched by any conflict; A1-4's own ordering fix is the only change, applied clean).
- Canonical sale depletion remains **28 statements** (file untouched by this integration).
- `NFR-PERF-006` remains **≤200 ms** (A1-4's own measured p95 = 39.42 ms carried forward unmodified; not re-measured standalone this session beyond the green targeted suite run).
- `BR-INV-003` overall remains **PARTIAL** due to missing scheduler (unchanged; no scheduler was added by this integration).

**SYNC**
- Offline `kds.ticket.recall` remains **UNREGISTERED** (§4).
- `kds.ticket.bump_line` remains registered (§4).
- Sync integration depends on the published Kitchen contract (`KDS_OFFLINE_TICKET_OPERATIONS`), not the reverse (§4).
- Kitchen does not depend on Sync (`kitchen.module.ts` imports no Sync module; confirmed by module-boundaries 46/46 and by direct inspection, §4).
- Zero new `KNOWN_DEVIATIONS` introduced by this integration (no file under governance/deviation tracking was touched by any of the 8 commits).
- Recovery remains **CANDIDATE / NOT RATIFIED** — this integration ratified nothing; the D4-1B commits' own reports (carried forward unmodified) are the evidence, and this report does not upgrade that status.
- Recovery invariant #4 **NOT PROVEN**, invariant #7 **FAIL**, invariant #9 **NOT PROVEN** — carried forward from the D4-1B acceptance-correction evidence (`a304e54`), unmodified by this integration; `sync-recovery.e2e-spec.ts` passed in this session's targeted (§5.8) and full (§5.15) runs, which exercises the implemented paths but does not itself upgrade any invariant's ratification status.
- **LOSSLESS RECOVERY HARD GATE remains NOT CLOSED.**
- **D4-1 FULL remains NOT COMPLETE.**
- `ActorResolutionCache` remains batch-local and caches actor facts only — confirmed by direct inspection of `sync/auth/actor-resolution.cache.ts` (added by `07b1d60`, unmodified by any conflict).
- The `ScopeAuthorizationService` check still runs per operation — confirmed: `SyncAuthorizationAdapter` calls it per-operation in `sync-batch.service.ts`'s handler path; the cache only memoizes actor resolution, not the authorization decision itself.
- `NFR-PERF-032` all-success path — targeted sync-performance suite green under the 3000 ms budget for the paths it exercises (§5.8); this report does not independently re-measure the specific "all-success production-handler path p95" figure the D4-1B report flagged as PARTIAL (p95 4023 ms pre-correction) — that remains the acceptance-correction's own claim, carried forward, not re-verified as a dedicated benchmark in this integration session.

**SECURITY**
- Exact authorization coverage measured after integration: **159 routes, 142/142 permission-bearing declared, 0 undeclared, 17 reviewed exemptions** (§5.6).
- No undeclared permission-bearing routes (gate's own `undeclared` assertion passed, `toEqual([])`).
- Inactive-branch Sync denial preserved (`sync-rls`/`sync-protocol`/`sync-contention` suites green, exercising `SyncTerminalGuard`'s `BRANCH_BRAND_QUERY` check, unmodified by this integration).
- Ordinary revoked-terminal remains generic 403 (unchanged; no revoked-terminal messaging file was touched by any of the 8 commits).

**OBSERVABILITY**
- Canonical correlation/auth enrichment from MW1D preserved (`correlation.middleware.ts` untouched, §4).
- No new high-cardinality metric labels (`observability-red-cardinality` proves 50 distinct branch UUIDs collapse to one series; the two new recovery-controller routes carry the same bounded `route` label as every other route, not raw ids).
- No direct bespoke logging introduced (no new `new Logger()`/`console.*` call sites appeared in the lint diff, §5.12; D4-1B's own report already disclosed zero bespoke-logging additions and this integration added no code on top).

**DATABASE**
- Migration count measured after integration: **exactly 38** (`ls prisma/migrations | grep -c '^[0-9]'`), matching the task's expectation that the D4 recovery migration (`20260903010000_sync_recovery_grants`) makes the canonical total 38, since no other integrated commit touched `prisma/migrations`.
- From-zero migration verification: performed live by the e2e harness on every run in this session (§5.14).
- Orphan scratch DBs at finish: **0** (`sweep-stale-scratch-databases.ts --dry-run`, run after the full E2E, §5.14).

## 7. Persistent `ros` — untouched confirmation

The persistent checkout `/Users/mac/projects/ros` was never entered or modified in this
session. `git worktree list` before and after confirms it remained at its own
independent branch/HEAD (`feat/production-spec`) throughout. The **local dev Postgres
container** `ros-postgres` (a Docker container in this developer's environment, named
after the `ros` database it serves, and distinct from the persistent `ros` git checkout)
was started via `npm run db:up` to run the verification suites; Docker Compose reported
`Recreate` for that container because its declared config had drifted from the
previously-created instance. This is safe and expected: `docker-compose.yml` binds a
**named volume** (`ros-pgdata` → `backend_ros-pgdata`), so container recreation does not
remove the volume — `docker inspect` confirmed the running container is still mounted on
the pre-existing `backend_ros-pgdata` volume, and `prisma migrate status` immediately
after showed the dev database's prior migration history intact (35 already-applied
migrations, with only the 3 new integration migrations pending — never applied to this
database by this session; only the e2e harness's own disposable template/scratch
databases were migrated and exercised).

## 8. No push, no deploy, no rebase, no destructive git

No `git push`, no deploy of any kind, no `git rebase`, no `git reset --hard`, no `git
clean`, no force operation of any kind was run in this session. All 8 cherry-picks used
`git cherry-pick -x`; the one conflict was resolved by editing the working file and
`git add`, never by discarding either side.

## 9. Final requirement statuses

- **A1-4: COMPLETE** — both accepted commits integrated clean, all A1-4-scoped
  concurrency/correctness/performance gates green in this session (§5.7).
- **D4-1B: accepted** — the complete preserved/original chain plus the complete
  acceptance-correction chain integrated in chronological order, acceptance-correction
  semantics confirmed as the surviving state (§4), all D4-1B-scoped targeted gates green
  in this session (§5.8).
- **D4-1 FULL: NOT COMPLETE.**
- **Recovery hard gate: NOT CLOSED.**

No overclaim beyond what this session measured: this report carries forward the D4-1B
acceptance-correction's own PARTIAL/NOT-PROVEN/FAIL classifications for
`FR-OFF-040`/`043`, `NFR-PERF-032`'s all-success path, and recovery invariants #4/#7/#9
exactly as recorded in the commits being integrated, since this integration did not
re-run the specific dedicated benchmarks or invariant proofs those classifications rest
on — it verified the integrated code compiles, passes its own tests, and preserves every
hard truth enumerated in the task brief.
