# MW1E — Integrate A1-3 Set-Oriented Depletion Performance Work

**Report type:** Reviewed-slice integration + cross-lane reconciliation + performance re-verification
**Authority:** This report is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf`
and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
remain authoritative. Where this report disagrees with the SRS or a ratified
governance decision, the SRS and the register win.
**Date:** 2026-09-03
**Starting HEAD:** `a31ce965b9dbd3d85ee0ec85cac2bdc678372aad` ("docs: finalize observability integration evidence")
**Branch:** `full-srs/4day-integration`
**Worktree:** `/Users/mac/projects/ros-worktrees/integration`
**Working tree at start:** clean
**Task identifier:** MW1E

---

## 1. Baseline verification (pre-integration)

All confirmed at starting HEAD `a31ce96` before any change:

- `git log --oneline`: corrected G1-2 harness, G1-1 CI, G1-3 observability +
  MW1D reconciliation, B1-2, B1-3 + correction, MW1C, D4-1A, A1-1, A1-2 all
  present on the branch history.
- Migrations: **37** (`ls prisma/migrations | grep -c '^[0-9]'`).
- `npm run typecheck`: **CLEAN**.
- `module-boundaries.spec.ts`: **45/45 passed**.
- `authorization-coverage.spec.ts`: **157 routes / 141 permission-bearing /
  0 undeclared / 16 reviewed auth-only** — exact match to task brief.
- `npx prisma validate`: valid.
- `test/e2e-db-isolation-config.e2e-spec.ts`: **1/1 passed**, zero orphan
  `ros_test_e2e_*` databases after.
- Persistent `ros` (port 5544, shared container `ros-postgres`) never
  written to at any point in this session — every DB operation ran against
  either a per-suite `ros_test_e2e_*` scratch database (harness-managed) or
  the `postgres` maintenance database (read-only `pg_database` listing /
  `SHOW` calls, and the guarded `ALTER DATABASE` calls in §9 below, which
  target only a scratch database name asserted to match `ros_test_e2e_`).

## 2. Lane-A commit resolution and integration

**A1-3A implementation hash resolution** (task required this be resolved,
not guessed): walked `full-srs/lane-a-perf-inventory` history. Candidate
`a57115e3eb6c8e65916f8899362d4da98e59023f`.

Hard check:
- `git rev-parse 337cd6f^` → `a57115e3eb6c8e65916f8899362d4da98e59023f` — **is the parent of `337cd6f`**. PASS.
- `git show --no-patch --format='%H %s' a57115e3eb6c8e65916f8899362d4da98e59023f`
  → `a57115e3eb6c8e65916f8899362d4da98e59023f perf(inventory): batch depletion effect reservation` — **exact subject match**. PASS.

**Cherry-picks, in ancestry order, cherry-pick (not merge), onto `full-srs/4day-integration`:**

| # | Source | Subject | Result hash | Conflict |
|---|---|---|---|---|
| 1 | `d0c1c82` | docs(inventory): design set-oriented depletion writes | `acf5b34` | `INDEX.md` append conflict (see §3) |
| 2 | `a57115e3` | perf(inventory): batch depletion effect reservation | `dd2bedc` | none — clean |
| 3 | `337cd6f` | docs: record batched depletion reservation | `1664af2` | auto-merged clean (`INDEX.md`) |
| 4 | `859242b` | perf(inventory): batch depletion group writes | `fd4ff56` | none — clean |
| 5 | `0f0e914` | docs: record set-oriented depletion writes | `db6016d` | auto-merged clean (`INDEX.md`) |

## 3. INDEX.md conflict resolution

Commit 1 (`d0c1c82`) produced a real `INDEX.md` append conflict: HEAD's side
ended with the MW1D row, the incoming side appended the new A1-3 design-gate
row after the same anchor line. Resolved by stripping only the three
conflict-marker lines (`<<<<<<<`/`=======`/`>>>>>>>`) via a scripted
line-filter (verified against `git diff` afterward: exactly one line
inserted, zero content lines removed) so both rows survive, in order.
Commits 3 and 5 auto-merged as pure appends with no conflict. Final row
count: 15 (pre-integration) + 3 (design gate, A1-3A report, A1-3B report) =
**18 rows, every existing row preserved exactly once**, verified by
`grep -c "^| 20"`.

## 4. Accepted A1-3 architecture — verified present in the integrated code

Direct read of the integrated
`src/modules/inventory/sale-depletion/sale-depletion.service.ts` (939
lines) confirms every item in task §2:

**A1-3A:**
- One set-oriented `sale_depletion_effects` reservation `INSERT ... SELECT`
  per call (lines 257–292), built from a single `jsonb_to_recordset`
  payload, **before** `lockLayers` or any Inventory mutation.
- Duplicate identity **within the same request** rejected before any SQL
  (lines 195–222), via an in-memory identity-key `Set`.
- Identity-based conflict detection: rows absent from the `INSERT ...
  RETURNING` are reported as real conflicts (lines 294–322), not a row-count
  comparison.
- Partial reservation rollback: no explicit rollback code exists because
  none is needed — the reservation statement and every later statement run
  inside the caller's single Prisma interactive transaction, so any thrown
  error (including `SaleDepletionEffectConflictError`) aborts the whole
  transaction atomically.
- Weighted-average `current_cost` lookup hoisted to one `stockLevel.findMany`
  covering every distinct weighted-average stock item in the call (lines
  325–351), never one lookup per effect.

**A1-3B:**
- Stock-key grouping: `triples` sorted `(stockItemId ASC, orderLineId ASC)`
  then walked as contiguous runs (lines 178–187, 356–390).
- Deterministic `ord`: explicit per-group counter incremented per zipped
  slice (lines 444, 608).
- Aggregate physical `stock_batches` UPDATE with **`GROUP BY batch_id`
  inside the SQL** (line 689) before the `UPDATE ... FROM` (lines 679–693)
  — the correctness mechanism, not an optimisation (see §6).
- Aggregate accounting `stock_batches` UPDATE, independently grouped by
  `batch_id` on the `fifo_cost_quantity_consumed` counter (lines 695–716,
  see §7).
- Carry-forward accounting flush before `findCarryForwardBasis` (lines
  512–545, see §8).
- Atomic `stock_levels` group delta via `INSERT ... ON CONFLICT DO UPDATE`
  (lines 728–737).
- Starting balance derived from the atomic statement's own `RETURNING
  "quantity_on_hand" - $delta AS start_balance` (line 737) — **no
  independent pre-read SELECT** of `quantity_on_hand` anywhere in the file.
- One `stock_movements` INSERT ... SELECT per group (lines 754–763), SQL
  window `balance_after` (`SUM(...) OVER (ORDER BY v.ord ROWS BETWEEN
  UNBOUNDED PRECEDING AND CURRENT ROW)`, lines 747–748).
- Pointer derived from `ORDER BY ord DESC LIMIT 1` (line 788) — never
  `max(uuid)`, never implicit `RETURNING` order.
- Multi-row `sale_depletion_allocations` INSERT (lines 793–802) carrying
  effect linkage, sequence, quantity, unit cost, total cost,
  `physical_batch_id`, `cost_basis_batch_id`, movement linkage, and
  timestamps/provenance — all present as distinct columns in the insert.
- `physical_batch_id`/`cost_basis_batch_id` remain independent throughout
  (never merged into one id — confirmed in the `ZippedSlice` type and the
  two separate aggregate-update functions).
- Exact-decimal transport: every SQL parameter that carries a quantity/cost
  travels as a string (`toDecimal6`/`.toString()`), cast in SQL — no JS
  float touches a persisted value.
- `writeAllocation` (the old per-slice write quartet) is **gone**: `grep
  writeAllocation src/modules/inventory/` finds it only in two explanatory
  comments (one in this file's own header, one an unrelated MovementsService
  comment referencing the historical pattern by name) — no function of that
  name exists any more.

## 5. Cross-cutting hard review — `src/common/ids.ts`

```ts
import { monotonicFactory, ulidToUUID } from 'ulidx';
const monotonicUlid = monotonicFactory();
export function newId(): string {
  return ulidToUUID(monotonicUlid());
}
```

Reviewed against every item in task §4:

- **A. Output format unchanged** — still `ulidToUUID(...)`, still returns
  the same 8-4-4-4-12 lowercase-hex string shape.
- **B. IDs remain valid existing wire/database IDs** — `UUID_PATTERN` is
  untouched; every generated id matches it (proven by the new unit test,
  §6).
- **C. UUID/ULID conversion semantics unchanged** — `ulidToUUID` itself
  was not touched; only the ULID *source* (`ulid()` → `monotonicFactory()`)
  changed.
- **D. Uniqueness preserved** — proven live: 5000/5000 unique in one
  same-process batch (§6).
- **E. Strict same-process monotonic generation proven** — 1000/1000
  strictly increasing in one same-process batch (§6).
- **F. No caller relied on random-tail reordering** — grepped every
  `newId()` call site; none compares or sorts on anything but the returned
  string's natural order (which the monotonic factory only makes *more*
  reliable, never changes the shape of).
- **G. No serialized API token/contract shape change** — `openapi:check`
  clean, zero diff (§13).
- **H. No database schema change** — `ids.ts` is a pure application-layer
  utility; `prisma validate` clean, migrations unchanged at 37 (§14).
- **I. No cross-module ordering test regresses** — full targeted +
  cross-cutting suites green (§10–§11), full E2E 82/82 suites green (§16).

## 6. New unit test for `newId()`

No dedicated `ids.ts` unit test existed pre-integration or in Lane A's
commits (`859242b`'s own diff touches only `ids.ts` + the Inventory service
+ its own e2e spec — no `ids.spec.ts`). Added
`kitchen-kit/backend/src/common/ids.spec.ts` (41 lines, 4 tests) in the
reconciliation commit:

- 50 IDs each match `UUID_PATTERN`.
- 1000 IDs generated synchronously (same millisecond, no round trip) are
  each strictly greater than the previous one (string comparison, matching
  byte-sort order).
- 5000 IDs generated in one batch are all unique (`Set.size === 5000`).
- 200 IDs all still validate against `UUID_PATTERN`.

All 4 pass. This is the "add or preserve a focused unit test" item required
by task §4.

## 7. D4-1A / Sync × monotonic IDs

Ran representative Sync suites after the `ids.ts` integration:
`sync-protocol`, `sync-causal`, `sync-crash-recovery`, `sync-idempotency`,
`sync-rls`, `sync-audit-contention` — **6/6 suites green** (part of the
19-suite/375-test cross-cutting batch in §11). `(tenant_id, op_id)` dedup
identity, HLC ordering, batch ids, causal relationships and replay behavior
all exercised and passing unmodified. No Sync product code was touched by
this integration (confirmed by `git diff --stat`, §15 — Sync files do not
appear).

## 8. Domain events / audit / cross-lane × monotonic IDs

Ran `audit.e2e-spec.ts`, `sales.e2e-spec.ts`, `cash-session-close`,
`cash-movements`, `cash-movements-close-and-payment-concurrency`, `rbac`,
`scoped-rbac`, `scoped-rbac-migration`, `scoped-authorization-matrix` — all
green (§11). `openapi:check` clean confirms no API-shape change from the id
generation change.

## 9. G1-3 observability × monotonic IDs

`observability-red-cardinality.e2e-spec.ts` and
`observability-sync-lifecycle.e2e-spec.ts` both green (§11). Correlation
and ALS-isolation unit coverage
(`src/common/observability/context/correlation.spec.ts`,
`observability-context.spec.ts`) ran as part of the full unit suite
(§12, 1057/1057) — unaffected by the id-generation change (correlation ids
still generated via the same `newId()` entry point, still replaced when a
malformed incoming header is present, causation still null when absent —
no code in the observability module was touched by this integration).

## 10. Targeted A1 E2E (task §26, first block)

```
test:e2e -- sale-depletion-effect-reservation, sale-depletion-lock-grouping,
  sale-depletion-set-oriented-writes, inventory-exact-decimal-callers,
  inventory, inventory-rls, movements-concurrency, order-completion,
  order-completion-structural, order-completion-pinning, order-completion-rls,
  order-completion-concurrency, order-completion-concurrency-2
```
**Result: 13/13 suites passed, 150/150 tests passed.**

## 11. Cross-cutting newId + B1/G regression E2E (task §26, remaining blocks)

```
test:e2e -- app, rbac, audit, sales, cash-session-close, cash-movements,
  cash-movements-close-and-payment-concurrency, sync-protocol, sync-causal,
  sync-crash-recovery, sync-idempotency, sync-rls, sync-audit-contention,
  observability-red-cardinality, observability-sync-lifecycle,
  scoped-authorization-matrix, scoped-rbac, scoped-rbac-migration, openapi
```
**Result: 19/19 suites passed, 375/375 tests passed.**

## 12. Unit suite

`npx jest` (full suite, includes `module-boundaries.spec.ts`,
`authorization-coverage.spec.ts`, and the new `ids.spec.ts`): **79 suites
passed, 1057 tests passed.** `module-boundaries`: **45/45**.
`authorization-coverage`: **157 routes / 141 permission-bearing / 0
undeclared / 16 auth-only** — unchanged from pre-integration baseline.

## 13. Static verification sweep

| Check | Result |
|---|---|
| `git diff --check` | clean (no whitespace-conflict markers) |
| `npx prisma validate` | valid |
| `npm run typecheck` | CLEAN |
| `npm test` (unit) | 79 suites / 1057 tests passed |
| module boundaries | 45/45 |
| `npm run openapi:check` | clean, zero diff |
| `npm run lint:check` | 48 errors / 3 warnings — see §14 for identity diff |
| `npm audit --omit=dev --audit-level=high` | 7 high / 1 moderate |

## 14. Lint — identity-level comparison (task §18 hard requirement)

Total counts alone (48 errors / 3 warnings, both HEADs) are insufficient
per the task brief; did a full `file:line:column:ruleId:severity` identity
diff.

Methodology: disposable `git worktree add` at starting HEAD `a31ce96`
(`kitchen-kit/backend`, real `cp -a node_modules` — **not** a symlink,
which was tried first and produced a spurious 15,627-error run because
type-aware `@typescript-eslint` rules could not resolve the linked
package files correctly against that worktree's own `tsconfig`; a symlink
copy is not equivalent for type-aware lint), `.env` copied in (gitignored,
needed for `prisma generate`), `npx prisma generate` run so the baseline's
generated client types match its own schema, then `npx eslint
"{src,apps,libs,test}/**/*.ts" -f json` at both the baseline worktree and
the current integrated HEAD.

- Baseline (`a31ce96`): **48 errors / 3 warnings**, 51 identity rows.
- Current (post-integration + reconciliation): **48 errors / 3 warnings**,
  51 identity rows.
- Set difference on `(path, line, column, ruleId, severity)`: **0 new, 0
  removed** — the two 51-row identity sets are exactly equal.

**Verdict: ZERO NEW semantic lint findings, identity-for-identity.**
Disposable worktree removed after the comparison (`git worktree remove
--force`); `git worktree list` confirms Lane D's worktree remained at
`2603099` throughout, untouched.

## 15. Dependency audit

`npm audit --omit=dev --audit-level=high`: **7 high, 1 moderate**
(`fast-uri`, `js-yaml` via `@nestjs/swagger`, `mysql2`, `qs` —
transitive, pre-existing, unrelated to Inventory). Matches the task
brief's stated integrated baseline exactly. `git diff a31ce96..HEAD --
package.json package-lock.json`: **empty** — A1-3 added no dependency, as
expected.

## 16. Full diff scope

```
git diff a31ce96..HEAD --stat
```
Touches exactly: 3 new report files, `INDEX.md` (+3 rows),
`src/common/ids.ts` (19 lines), `sale-depletion.service.ts` (776 lines,
the full A1-3A+A1-3B rewrite), 2 new e2e spec files, and the new
`ids.spec.ts` unit test. **No controller, no observability file, no
security/authorization file, no Sync file, no other module file appears in
the diff** — confirms task §8: B1-3 controller changes, observability,
the corrected G1-2 harness, Identity/security work and D4-1A are all
preserved untouched, and A1-3A/B affected only
`sale-depletion.service.ts` + its own tests/reports as specified.

## 17. Concurrency (task §16 hard gate)

`order-completion-concurrency`, `order-completion-concurrency-2`,
`movements-concurrency`, `cash-movements-close-and-payment-concurrency` —
all 4 suites green, all with no lost update / serial-equivalent outcome /
no deadlock assertions passing (already counted inside §10/§11's totals).
`lockLayers` (unchanged kernel) still locks in one deterministic order
(`created_at ASC, id ASC`), `FOR UPDATE`, no `SKIP LOCKED` — grepped both
`sale-depletion.service.ts` and `fifo-cost-ledger.ts` for `SKIP LOCKED`,
`Mutex`, `retry`, `setTimeout`: only pre-existing explanatory comments
about the *absence* of `SKIP LOCKED` match; no new retry loop, no process
mutex.

## 18. Statement count re-measurement (task §23)

Re-measured live against the canonical 30-line fixture
(`test/order-completion-performance.e2e-spec.ts`'s own fixture-building
code), using **Prisma/Postgres query logging in one guarded scratch
execution** (the task's explicit fallback methodology), since the
corrected G1-2 per-suite scratch database is created/dropped automatically
per suite and its name isn't known until the suite's own `beforeAll` runs.

Method: a disposable copy of the performance spec
(`test/_tmp-stmt-count.e2e-spec.ts`, deleted immediately after use, never
committed) that (1) reads its own per-suite scratch database name from
`process.env.APP_DATABASE_URL` inside `beforeAll`, asserting it matches
`^ros_test_e2e_` before doing anything else; (2) runs `ALTER DATABASE
"<scratch-name>" SET log_statement = 'all'` / `SET
log_min_duration_statement = 0` via an admin connection to the `postgres`
maintenance database — scoped to that one scratch database only, **never**
to persistent `ros`, and made irrelevant at teardown since the harness
drops the whole scratch database afterward (no reset needed); (3) runs
exactly one iteration of the identical `planConsumption` +
`depleteForCompletedSale` call, printing ISO timestamps immediately before
and after; (4) `docker logs ros-postgres --since <start> --until <end>`
captured and parsed for `execute <unnamed>:` / simple-protocol `statement:`
marker lines.

The captured window contained some earlier, unrelated fixture-setup
statements (order-line creation, from a few milliseconds before the timed
transaction actually opened); isolating strictly the `BEGIN` → `ROLLBACK`
span of the benchmarked transaction gives:

**28 statements** (30 marker lines between and including `BEGIN`/`ROLLBACK`,
minus those two control statements) — **exact match to the accepted A1-3B
evidence (28 statements)**.

Cleanup verified: temp spec file deleted (`git status` shows it never
tracked), scratch database dropped by the harness's own teardown (`SELECT
datname FROM pg_database WHERE datname LIKE 'ros_test_e2e_%'` → 0 rows
immediately after), persistent `ros` never referenced by name in any
command this section issued.

**Observability-middleware concern (task §23):** the 28-statement count
was measured at the **Postgres wire-protocol level**, inside the same
transaction the HTTP layer wraps — it reflects exactly what the domain
transaction itself sends to the database. G1-3's observability middleware
(structured logging, RED metrics) does no DB read/write of its own inside
this transaction; it operates purely at the HTTP request/response layer
outside the transaction boundary. No evidence of added DB statements from
observability.

## 19. Performance re-verification (task §22)

`test/order-completion-performance.e2e-spec.ts`, **unmodified**, run in
isolation three times (the task's "if one run is anomalous, run a second"
clause was exercised, and a third taken for additional confidence given the
spread observed):

| Run | p50 | p95 | min | max |
|---|---|---|---|---|
| 1 | 44.48 ms | 51.16 ms | 42.80 ms | 58.45 ms |
| 2 | 106.83 ms | 123.11 ms | 81.28 ms | 136.23 ms |
| 3 | 112.86 ms | 143.57 ms | 101.89 ms | 156.87 ms |

All three runs pass the literal `p95 <= 200ms` gate with margin (57–149 ms
of headroom). The spread between run 1 and runs 2–3 is real and was
investigated: `uptime` during run 3 showed `load averages: 7.37 7.98 6.32`
on a machine that also hosts several other active Lane worktrees/sessions;
no stray `jest`/`jest-worker` process was found running concurrently
(checked via `ps aux`), so the variance is attributed to **shared-machine
CPU contention across concurrent sessions**, not to anything the A1-3
integration changed — the code under test is byte-identical across all
three runs, and the 28-statement measurement (§18, a load-independent
complexity metric) is stable. No threshold was weakened, no timeout was
increased.

**NFR-PERF-006: COMPLETE / VERIFIED-PASSING** (p95 ≤ 200ms confirmed across
all three isolated runs; worst observed p95 was 143.57ms, 28% below the
gate).

## 20. Full E2E (task §27)

`npm run test:e2e` (all 82 spec files, no filter): **82/82 suites passed,
1341/1341 tests passed.** Zero failures — the previously-documented
pre-existing baseline QA defect in `reporting-authorization.e2e-spec.ts`
(UTC-vs-`Africa/Cairo` business-day boundary fixture fragility, first
recorded at MW1D) **did not reproduce this run** (it is time-of-day/date
dependent, per its own prior documentation, and evidently did not land on
the fragile boundary this run). No Class A (correctness), Class B (DB
isolation), or Class C (contention) failures observed; no new
unexplained (Class D) failures. Zero orphan `ros_test_e2e_*` databases
after (`SELECT datname ... LIKE 'ros_test_e2e_%'` → 0 rows).

## 21. Reconciliation commit

`6922a3e` — `chore(integration): reconcile set-oriented depletion`. Sole
content: the new `src/common/ids.spec.ts` unit test required by task §4's
hard cross-cutting review of the `newId()` monotonic-factory change (Lane A
shipped the fix but no dedicated test for it). No other reconciliation
diff was required — all 5 cherry-picks were clean or cleanly auto-merged,
lint was identity-for-identity zero-new, no new dependency/schema/API
change.

## 22. Requirement disposition

- **NFR-PERF-006: COMPLETE / VERIFIED-PASSING** — integrated evidence (§19)
  confirms, does not merely carry forward, the isolated A1-3B measurement.
- **A1-3: COMPLETE** — design gate + A1-3A + A1-3B all integrated, reviewed
  architecture verified present in the integrated code (§4), all hard gates
  (§4–§9, §17–§18) pass.
- **A1-4: NOT IMPLEMENTED** (deadlock matrix, weighted-average concurrent-
  receipt race correction, BR-INV-003, multi-location Completion,
  MovementsService set-orientation — none attempted, per task §17).
- **BR-INV-003: NOT IMPLEMENTED.**
- No broader Inventory completion is claimed.

## 23. Readiness

- **Ready for A1-4:** YES — A1-3's set-oriented write path is integrated,
  green, and re-verified in the shared branch; nothing in this session
  narrows or blocks A1-4's scope.
- **Ready for eventual D4-1B integration:** YES from this session's side —
  Lane D's worktree (`/Users/mac/projects/ros-worktrees/lane-d`) was
  confirmed at `2603099`, unchanged, both before (`git worktree list` at
  session start) and after (re-checked at session end) this integration;
  no Sync product file was touched (§7, §16); the shared `newId()` change
  was independently re-verified against representative Sync suites (§7)
  and found not to affect dedup/HLC/batch-id/causal semantics.

---

**No push. No deploy. No rebase. No destructive git operation. No schema
change. No migration. No API change. No permission change.**
