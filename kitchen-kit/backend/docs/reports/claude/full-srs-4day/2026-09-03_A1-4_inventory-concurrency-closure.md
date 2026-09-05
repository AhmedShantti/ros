# A1-4 — Inventory concurrency matrix closure

**Report type:** Implementation + concurrency/correctness/performance verification closure.

**Authority statement:** This report is non-authoritative evidence only. The
SRS and ratified governance decisions remain authoritative; nothing in this
document overrides them. Where this report states a requirement is PARTIAL
or NOT IMPLEMENTED, that classification stands unless and until a ratified
decision says otherwise.

**Date:** 2026-09-03

**HEAD (pre-commit, this session's starting point):** `7fdde4cc220af718d7d36b6e17fb27e0f0b8c053`

**Branch:** `full-srs/lane-a2-inventory-concurrency`

**Working tree summary at session start:** 3 modified production files
(`counts.service.ts`, `movements.service.ts`, `waste.service.ts`) and 1
untracked test file (`test/inventory-concurrency-matrix.e2e-spec.ts`)
survived an unexpected machine reboot, uncommitted, with nothing staged.
This session performed a forensic resume, verified the surviving diff was
complete and correct (not partially written), ran the full required
verification, and is committing it now.

**Task identifier:** A1-4 (full-srs-4day task order §0-§26) — Inventory
concurrency matrix closure.

---

## 0. Forensic resume — what survived the reboot

Before any further edits, the surviving state was inspected in full (complete
`git diff` of all three production files, complete read of the 1095-line
untracked test file, `git diff --cached` confirming nothing staged).
Findings:

- **Surviving implementation** was complete and internally consistent for all
  three services (deterministic `stockItemId ASC` lock order in
  `counts.service.ts` and `waste.service.ts`; the `movements.service.ts`
  averageCost lock-read fix). No TODOs, no dead branches, no half-finished
  code.
- **Surviving tests**: `test/inventory-concurrency-matrix.e2e-spec.ts` was a
  complete 17-test suite (barrier-based, real Postgres locks — no sleeps),
  not a stub.
- **Unfinished work**: only the evidence report and the commits — nothing in
  the code or tests.
- **No suspicious/incomplete code** from the interruption was found.
- **Typecheck**: `tsc --noEmit` over the whole project (including the new
  test file, which the project `tsconfig.json` includes by default) —
  **0 errors**, confirmed before any further edit.
- All A1-4 acceptance rows below were already covered by the surviving
  diff+test; this session's job was verification and closure, not further
  implementation.

No reset/clean/checkout/rebase/branch-switch was performed. No new
implementation was required beyond what survived.

---

## 1. What changed (production code)

### `src/modules/inventory/counts/counts.service.ts`

- **CT-08 / FR-INV-044 fix**: `post()` now sorts count lines
  `orderBy: { stockItemId: 'asc' }` before processing — the same global
  deterministic lock order `SaleDepletionService` and `WasteService` use —
  so a multi-item count posting can never invert against a concurrent
  multi-item writer touching the same two items and deadlock (§11).
- A new `tx.stockMovement.groupBy` window-sum query computes, per line, the
  exact `Prisma.Decimal` sum of movements committed after `session.startedAt`
  (the frozen open-time cutoff) — the same boundary FR-INV-044 already used
  for the audit-only `duringWindow` count. The **genuine** variance posted is
  `trueVariance = rawVariance − movementsDuringWindow`, where `rawVariance`
  is the pre-existing counted-vs-opening-baseline figure. This is persisted
  back onto `countLine.variance` (even when zero, so `lines()` never
  disagrees with what was actually posted) and is what drives both the
  posted `count_adjustment` movement and the reported `adjustments[]`.
  `duringWindow` (the separate audit-only count) is unchanged and still
  reported alongside.

### `src/modules/inventory/movements/movements.service.ts`

- Removed the old **unlocked pre-read** of `stock_levels`
  (`tx.stockLevel.findUnique`) that fed `currentQty`/`currentAvg` into
  valuation — this was the source of a lost-update race on `average_cost`
  between two concurrent receipts, and, more subtly, between a receipt and
  any concurrent outbound movement on the same row.
- The single `INSERT … ON CONFLICT DO UPDATE … RETURNING` upsert (already
  the sole atomic write point for `quantity_on_hand`) now also
  `RETURNING`s `average_cost` under the **same row lock** that applies this
  movement's own quantity delta. `currentAvg`/`currentQty` (used for
  valuation) are derived from that locked, post-upsert row state — never a
  value read before the lock was acquired.
- This also closes the **first-receipt** race (§10): the `INSERT` branch of
  the upsert is itself the row's creation-and-lock point, so two concurrent
  first receipts on a never-before-seen `(item, location)` cannot both
  believe they created the row.
- Batch/FIFO locking order (taken before the `stock_levels` lock) is
  unchanged — confirmed by diff inspection.

### `src/modules/inventory/waste/waste.service.ts`

- Multi-line waste records now process lines sorted `stockItemId ASC`
  (`orderedLines`) instead of caller-supplied order — closing the
  waste↔count / waste↔waste multi-item lock-order inversion deadlock (§11),
  using the same global order as Completion and Counts.

**Not touched, confirmed by `git status`/diff inspection**: `prisma/schema.prisma`,
all migrations, `sale-depletion.service.ts`, `fifo-cost-ledger.ts`, any
route/controller/DTO/permission file, `package.json`/`package-lock.json`.

---

## 2. New test file

`test/inventory-concurrency-matrix.e2e-spec.ts` (1095 lines, 17 tests). Uses
`BarrierPrismaService` (overrides `PrismaService.withAuthContext`, the one
choke point every write path in the suite passes through) to force a genuine
two-transaction PostgreSQL race — never `Promise.all` timing luck or a
`sleep()`. One shared Nest app bootstrap for the whole matrix.

---

## 3. Acceptance-row-by-row disposition

### CT-08 — stock count during active trading

**Exact disposition: PASS, both directions proven.**

- "A concurrent sale during the count window is NOT reported as variance
  (genuine variance is zero)" — a real sale commits mid-window; `post()`
  reports **zero** adjustments and writes **zero** `count_adjustment`
  movements; final level is exactly what the sale left it at (90). PASS.
- "Genuine shrinkage during a count window is isolated from a concurrent
  sale" — sale depletes 10 (expected_at_post = 90), counter finds 85 (5
  genuine shrinkage); posted adjustment is exactly `-5`, not `-15`. PASS.

The CT-08 hard rule (stop if the model cannot truthfully represent frozen
expected-at-open plus the count-window movement boundary) did **not** need
to be invoked: `count_session.started_at` plus `stock_movements.occurred_at`
already gave a truthful, queryable boundary — no fake "read current stock at
posting time" was used anywhere in the fix.

### FR-INV-044 — movements during count window reported, not folded

**Exact disposition: PASS.** The separate audit-only `duringWindow` count
(movements committed after `startedAt`) is retained and reported unchanged
alongside the now-corrected `variance`/`adjustments`. The two concerns
(reporting the movement count vs. computing the genuine posted variance) are
kept distinct in the code, per the pre-existing FR-INV-044 contract.

### Transfer-out vs. concurrent sale depletion (FIFO/batch-tracked)

**PASS, 3/3 runs.** No lost stock, no double batch consumption, no deadlock.
Verified: both writers succeed; batch `quantityRemaining`/
`fifoCostQuantityConsumed` exact; `stock_levels` exact; ledger==projection
(`assertLedgerTruthful`); transfer and sale-allocation provenance unchanged.

### Waste vs. concurrent sale depletion (weighted-average, non-batch)

**PASS, 3/3 runs.** No lost update, no deadlock, exact serial-equivalent
final stock (50−6−4=40); exactly one `waste` and one `sale_depletion`
movement retained.

### Concurrent weighted-average receipts — existing non-zero quantity

**PASS, 3/3 runs.** No lost average-cost update. `final_qty=18`,
`final_avg=161` (identical for either serial order by construction).

### Concurrent first receipt (never-before-seen row)

**PASS.** Two concurrent first receipts on a brand-new `(item, location)`
cannot both create the row; final `qty=8`, `avg=238`.

### Zero-quantity / stale-average edge

**PASS.** Row brought to exactly zero with a stale non-zero `average_cost`
(500, from before the zeroing); two concurrent receipts race in; no
divide-by-zero; correct blend (`qty=10`, `avg=160`), since `existing_value`
is correctly 0 when `existing_qty=0` regardless of the stale average.

### 6dp exactness

**PASS.** Receipt quantities `2.500000` / `7.500000` race; final `qty=10.000000`,
`avg=700` — exact, no drift.

### Ledger == projection after every race

**PASS in every scenario above** via the shared `assertLedgerTruthful`
helper: exact `Prisma.Decimal` fold of every `stock_movements` row for the
item equals `stock_levels.quantityOnHand`, **and**
`reconciliation.reconcile(tenantA)` reports no divergence for the item.

### Truthful intermediate `balance_after`

**PASS.** `assertLedgerTruthful` does not merely check the final total — it
greedily reconstructs the true, commit-consistent application order by
matching each remaining movement's own recorded `balance_after` against
`running + quantity`, for every movement, under every race in the suite.
Every movement's `balance_after` is proven to reflect a genuine running fold
under one valid serial order, insensitive to which side of a given race
actually won.

### Deadlock / lock-order-inversion matrix

**PASS, all 3 scenarios.**
- Completion vs. receipt (transfer_in-shaped inbound) on the same item — no
  deadlock, both correct (30+12−5=37).
- Completion vs. count posting on the same item — no deadlock.
- **Multi-item inversion**: `waste([A,B])` vs. `count([B,A])` — opposite
  caller-supplied orders touching the same two keys — no deadlock after the
  deterministic `stockItemId ASC` fix; both writers succeed. The final
  values assert one of two independently-correct outcomes (the count's
  unlocked window-sum read may or may not observe the concurrent waste's
  not-yet-committed write — both outcomes are separately proven correct by
  the CT-08 tests above, which don't race the window read against a
  concurrent writer) — a single hardcoded expectation here would have made
  the test flake on real timing, which the task's determinism rule forbids.

---

## 4. Statement count (canonical sale-completion path)

**A1-4 did not modify the sale-depletion write path** —
`sale-depletion.service.ts` and `fifo-cost-ledger.ts` are untouched
(confirmed by `git status`/diff: only `counts.service.ts`,
`movements.service.ts`, `waste.service.ts` and the new test file changed).
`SaleDepletionService` does not call `MovementsService` at all (confirmed by
grep — no reference), so the `movements.service.ts` averageCost-lock change
cannot affect it.

**Actual measured value, reconfirmed this session**:
`test/sale-depletion-set-oriented-writes.e2e-spec.ts` — including its
`'one stock key, two effects: exactly 5 group statements'` and the
`'statement-count instrumentation (task §20/§23.11)'` describe block — was
run **unmodified** this session: **9/9 passed**, reconfirming the canonical
895→**28**-statement result A1-3B established. No new statement-count
measurement was performed (none was needed — the path is provably
untouched); this is a reconfirmation, not old evidence presented as new.

---

## 5. NFR-PERF-006

`test/order-completion-performance.e2e-spec.ts` run **unmodified** this
session, instrumentation off, 20 iterations, 30-line fixture:

```
p50=36.70ms  p95=39.42ms  (min=35.42ms max=45.40ms)
```

Well under the 200ms gate. Consistent with §4 (untouched sale-completion
path) — the small improvement over A1-3B's own p95 (52.27ms) reflects normal
run-to-run machine-load variance on a shared disposable container, not a
code change on this path.

---

## 6. Full targeted verification run (this session)

| Suite | Result |
|---|---|
| `inventory-concurrency-matrix.e2e-spec.ts` (new) | 17/17 |
| `sale-depletion-set-oriented-writes.e2e-spec.ts` (unmodified) | 9/9 |
| `inventory-exact-decimal-callers` + `inventory-rls` + `inventory` + `movements-concurrency` | 65/65 (4 suites) |
| `order-completion-concurrency` + `order-completion-concurrency-2` + `cash-movements-close-and-payment-concurrency` | 49/49 (3 suites) |
| `order-completion-performance` | 1/1 (see §5) |
| Full unit suite (`npx jest`) | **79 suites / 1057 tests**, incl. `module-boundaries.spec.ts` **45/45** and `authorization-coverage.spec.ts` **9/9** |

### Full E2E suite — reported honestly, not rounded to green

`NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json`
(all 83 e2e spec files, `maxWorkers: 4`, one shared disposable Postgres
container): **82/83 suites passed, 1320/1358 tests passed, time 964.6s.**

One suite failed: **`production.e2e-spec.ts`** (38 tests, all under its
`'D-17-03 scope precedence (branch > brand > tenant)'` describe block —
recipe/production RBAC scoping, unrelated to Inventory).

**Classification: Class C — shared-resource/Postgres contention in the
`maxWorkers=4` full-suite run.** Basis for this classification, all
verified this session, not assumed:

- **A1-4 did not modify that production scope.** `git status`/diff confirms
  the only files touched this session are `counts.service.ts`,
  `movements.service.ts`, `waste.service.ts`, and the new inventory test
  file. Nothing under `src/modules/production/` or its RBAC/scope code was
  touched.
- **The failing suite passed 44/44 immediately in isolation**:
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json test/production.e2e-spec.ts --runInBand`
  → `Test Suites: 1 passed, 1 total`, `Tests: 44 passed, 44 total`, run
  immediately after the full-suite failure, same container, same code, no
  intervening change.
- **No second full-suite rerun was performed** to try to manufacture an
  83/83 number. Only the one suspect suite was re-run in isolation, to
  diagnose it — a full-suite outcome of **82/83 stands as reported**, not
  83/83.

This is reported as evidence of environmental contention (4 parallel Jest
workers competing for one shared disposable Postgres container across 83
suites), consistent with the harness's own documented per-run isolation
model (`e2e-db-isolation`) — not as a claim that the contention's root cause
was independently root-caused beyond what's shown above.

---

## 7. Static / dependency / migration / schema verification

| Check | Result |
|---|---|
| `tsc --noEmit -p tsconfig.json` (whole project, incl. new test file) | 0 errors |
| `eslint` on the 4 changed files (`counts.service.ts`, `movements.service.ts`, `waste.service.ts`, `inventory-concurrency-matrix.e2e-spec.ts`) | 0 errors / 0 warnings |
| `eslint` full-repo (`lint:check` pattern), baseline → final | **48 errors / 3 warnings both before and after** — identical to the pre-A1-4 baseline recorded in the MW1E integration report; all 51 findings are in unrelated pre-existing files (`cash-movements-close-and-payment-concurrency.e2e-spec.ts`, `sync-performance.e2e-spec.ts`); **zero new findings** from A1-4 |
| `authorization-coverage.spec.ts` | **157 routes / 141 permission-bearing / 0 undeclared / 16 auth-only** — unchanged from the pre-A1-4 baseline |
| `npm audit` | **8 vulnerabilities (7 high, 1 moderate)** — unchanged; `package.json`/`package-lock.json` show zero diff |
| `npx prisma validate` | schema valid |
| Migrations count | **37** (unchanged; `git status` on `prisma/migrations/` clean — no new migration added, per the task's "no speculative migration" rule) |
| Schema/API change | **None.** `prisma/schema.prisma` diff: empty. `npm run openapi:check` (generate + `git diff --exit-code` against committed `docs/api/`): clean, zero diff |
| Orphan scratch DBs | **0**, confirmed after cleanup — see below |
| Persistent `ros` database | **Untouched** by any test/app connection this session (`.env`'s `DATABASE_URL`/`APP_DATABASE_URL` both point at the disposable `ros_lane_a_a11_20260902043434` on port 5555, confirmed) |

### Orphan scratch DB note (reboot artifact, disclosed in full)

Two `ros_test_e2e_mtkuwmht_8f1dda_*` databases (a template and one scratch
DB) were found still present on the shared Postgres container at the start
of this session — leftovers from a prior run whose Jest process was killed
hard enough (the machine reboot) that its own `globalTeardown` never ran, a
gap the harness's own `sweep-stale-scratch-databases.ts` recovery tool
exists specifically to cover. Ran `--dry-run` first (confirmed both as the
only stale entries), then the real sweep; verified via `pg_database` that
only `postgres`, `ros`, `ros_lane_a_a11_20260902043434`, `template0`,
`template1` remain. This is disclosed as an artifact of the reboot this
session resumed from, not something A1-4's own test runs left behind (every
suite run in this session, including the new matrix, swept its own scratch
DB in its own teardown, as shown in each run's log line above).

---

## 8. Governance — requirement classification (do not overclaim)

- **BR-INV-003, ledger/projection limb: PROVEN.** Every race in this
  session's matrix proves exact `stock_movements` fold ==
  `stock_levels.quantityOnHand`, with truthful `balance_after` at every
  step, under concurrent writers with no lost updates and no deadlocks.
- **BR-INV-003, overall: remains PARTIAL.** The daily reconciliation
  scheduler/alert limb is **NOT IMPLEMENTED** — nothing in this session
  built a scheduler, and per the task's explicit rule ("no BR-INV-003 daily
  scheduler"), none was built. `reconciliation.reconcile()` is called
  synchronously inside test assertions in this suite; that is not a
  scheduled/alerting mechanism and does not close this limb.
- **FR-INV-011 / FR-INV-051 scheduled obligations remain outstanding.**
  Nothing in this session's diff touches scheduling for either requirement.
- **A1-4 scope claim, precisely stated**: the concurrency-matrix hard goals
  listed in the task order (transfer-vs-sale, waste-vs-sale, CT-08,
  concurrent weighted-average receipts, the deadlock/inversion matrix, exact
  fold, truthful `balance_after`, exact decimals) are **CLOSED** by the
  surviving implementation and this session's verification. No claim is made
  beyond that scope — BR-INV-003's scheduler/alert limb and
  FR-INV-011/FR-INV-051 scheduling are explicitly **not** claimed complete
  here.

---

## 9. Architecture / non-goals preserved

- A1-3's set-oriented depletion architecture is untouched (§4, confirmed by
  diff inspection) — the canonical 28-statement sale-completion path is
  unaffected.
- No BR-INV-003 daily scheduler was built.
- No speculative migration was added (§7 — 37 migrations, zero diff).
- No push, no deploy performed or attempted.

---

## 10. Commits

- `fix(inventory): close concurrent movement races` — the three production
  service files.
- `test(inventory): close concurrency matrix` work is included in the same
  production commit per this session's actual instruction (see commit log
  for the exact split); test file authorship and content are as described
  in §2.
- `docs: record inventory concurrency closure` — this report plus the
  `INDEX.md` row.

(Exact hashes are recorded in `git log` on this branch, appended to
`INDEX.md`'s row for this entry.)
