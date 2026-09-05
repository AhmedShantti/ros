# A1-1 — Inventory Movement Write-Path Correctness (P1-PERF, Lane A)

| Field | Value |
|---|---|
| **Task / slice name** | `P1-PERF` / `A1-1` — Inventory movement write-path correctness (`MovementsService.post`) |
| **Lane** | A — Performance + Inventory Concurrency |
| **Report type** | Implementation + tests + acceptance report |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was implemented and verified **in this session** against the repository at the HEAD below. It ratifies nothing and authorizes no decision beyond recording this slice's own result. |
| **Date** | 2026-09-02 |
| **Baseline HEAD** | `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71` — *chore: initialize full SRS 4-day war room* |
| **Branch** | `full-srs/lane-a-perf-inventory` |
| **Worktree** | `/Users/mac/projects/ros-worktrees/lane-a` |
| **Working tree at start** | Clean, verified via `git status --short --untracked-files=all` before any edit. |
| **Design reference** | `docs/reports/claude/2026-09-02_FULL-SRS-current-head-traceability-rebase.md` §12.1 (CG-01, defect finding) and §29.2–29.9 (exact requirement IDs, implementation boundary, invariants, required tests, acceptance criteria). No new design gate required for A1-1 (§29.10: "`A1-1` and `A1-2` may proceed without one"). |
| **Task identifier** | A1-1 / full-srs-4day / lane-a |
| **Status** | COMPLETE — acceptance-clean at the time of writing; commit performed immediately after per the task's own commit step |

---

## 1. Primary requirements

- `BR-INV-003` — the sum of all movements for an (item, location) pair SHALL equal the `stock_levels` projection.
- `BR-CORE-003` — quantities carry 6 decimal places of precision.
- `FR-INV-030` — the movement/projection write path.

Secondary, explicitly preserved (not modified): `BR-INV-001` (append-only ledger), `BR-INV-002` (transfer pairing).

## 2. Confirmed defect (CG-01, §12.1 of the traceability rebase)

`MovementsService.post` (`src/modules/inventory/movements/movements.service.ts`), pre-fix:

```
const level = await tx.stockLevel.findUnique({ ... });
const currentQty = level ? Number(level.quantityOnHand) : 0;   // IEEE-754
...
const balanceAfter = currentQty + input.quantity;               // IEEE-754
...
await tx.stockLevel.upsert({ ..., update: { quantityOnHand: balanceAfter, ... } }); // absolute write
```

Two defects in six lines, on the write path for **transfers, counts, waste, adjustments, and the
standalone `POST /inventory/movements` route** — every write path except sale depletion:

- **(a) Lost update.** Read-then-**absolute**-write on `stock_levels`, with no `FOR UPDATE` guarding
  the general path (the existing `lockLayers` lock only fires for `outbound && item.isBatchTracked`).
  Two concurrent movements on one `(item, location)` can both read the same `currentQty`, both
  compute independently, and the second write silently discards the first movement's effect.
- **(b) Float arithmetic on quantities.** `Number(NUMERIC)` + JS `+` determines both the ledger's own
  `stock_movements.balance_after` and the persisted `stock_levels.quantity_on_hand`.

The already-accepted `SaleDepletionService.writeAllocation` pattern (atomic
`INSERT … ON CONFLICT … DO UPDATE SET quantity_on_hand = quantity_on_hand + EXCLUDED.quantity_on_hand
RETURNING quantity_on_hand::text`) existed in the codebase for the completion path only. A1-1 applies
the same pattern to `MovementsService.post`.

## 3. Implementation

### 3.1 Atomic projection (§6 of the task)

`movements.service.ts` `post()` now derives the signed delta as an exact `Rational`
(`common/money/rational.ts` + `common/money/rounding.ts`, the same exact-decimal primitives
`SaleDepletionService` and `fifo-cost-ledger.ts` already use), formats it as a signed
`DECIMAL(18,6)` string, and applies it via:

```sql
INSERT INTO "inventory"."stock_levels"
  ("tenant_id", "stock_item_id", "location_id", "quantity_on_hand")
VALUES ($tenantId, $stockItemId, $locationId, $deltaText::numeric)
ON CONFLICT ("stock_item_id", "location_id") DO UPDATE
  SET "quantity_on_hand" = "inventory"."stock_levels"."quantity_on_hand" + EXCLUDED."quantity_on_hand"
RETURNING "quantity_on_hand"::text AS "quantityOnHand"
```

`balanceAfter` is taken **directly from the query's returned value** — never computed from a
pre-transaction read — and used both to persist `stock_movements.balance_after` and, converted to a
JS number only at the very end for the API response (see §5), returned to the caller. This mirrors
`SaleDepletionService.writeAllocation` exactly: atomic delta first, movement row second (using the
returned balance), pointer/valuation update third.

`averageCost` and `lastMovementId`/`lastMovementOccurredAt` are written in a **separate**
`stockLevel.update` after the movement row is created (mirroring `SaleDepletionService`'s own
pointer-update step) — `quantity_on_hand` is never touched there; it was already applied atomically.

### 3.2 Exact decimal quantity (§7 of the task)

- `PostMovementInput.quantity` changed from `number` to a **signed exact decimal string** (up to 6
  dp, e.g. `"-2.125000"`), parsed via the existing `parseExactDecimal` → `Rational` primitives.
  This is an internal write-path type only — see §5, no DTO/OpenAPI change.
- The zero-quantity guard (`ck_movement_quantity_nonzero`) now checks `isZero(qty)` on the parsed
  `Rational`, not a raw `number === 0` comparison.
- `stock_movements.quantity` is persisted as `new Prisma.Decimal(input.quantity)` (a string round
  trip through decimal.js, never through a JS double).
- The FIFO accounting counter-maintenance step (`applyCostConsumption` / `planFifoCostConsumption`)
  now reuses the already-parsed exact `Rational` magnitude directly, removing a redundant
  `Math.abs(input.quantity).toFixed(6)` round trip through a JS double that existed pre-fix.
- No second money/decimal library was introduced; only the repository's existing `Rational` /
  `parseExactDecimal` / `toDecimal6` helpers are used (`toDecimal6` — previously private to
  `fifo-cost-ledger.ts` — is now also exported and reused here, matching how `sale-depletion.service.ts`
  already imports it).

**Left unchanged, and explicitly out of scope (see §7 "Residual risks"):**
- `costing.ts` (`selectBatches`, `valuationUnitCost`, `weightedAverageCost`, `totalCost`) — the
  batch-selection and valuation axis. This module already computed off a JS `number` before this
  slice; it still does. It is unrelated to the persisted quantity/`balance_after` projection this
  slice fixes (§16 of the task: "if unrelated to this exact movement quantity path, do not fix it").
- `averageCost`'s concurrent-receipt race (two simultaneous receipts computing weighted-average cost
  off the same stale pre-read). CG-01 names only the `quantity_on_hand`/`balance_after` lost update;
  the traceability report's own test matrix (§12.4, §29.8) places "two concurrent receipts … weighted
  average correct" under **A1-4**, not A1-1. `SaleDepletionService` never had to solve this either
  (it never touches `averageCost`).

### 3.3 Callers updated (type-compatibility only, no behavior change)

`PostMovementInput.quantity: string` required every caller to change how it converts its own
`number`/`Decimal` value into that string. Every call site keeps its own pre-existing arithmetic
exactly as it was — only the final hand-off to `MovementsService.post` moved from an implicit
`number` to an explicit `.toFixed(6)` (or, for the public HTTP DTO, an already-string field passed
straight through, removing a `Number()` call that no longer needs to exist):

- `inventory.controller.ts` `postMovement` — `quantity: dto.quantity` (was `Number(dto.quantity)`).
  `PostMovementDto.quantity` was already a validated decimal **string**; the controller no longer
  degrades it to a double before handing it to the service.
- `transfers.service.ts` `dispatch`/`receive` — `(-Math.abs(input.quantity)).toFixed(6)`,
  `dispatched.toFixed(6)`, `discrepancy.toFixed(6)`.
- `counts.service.ts` `post` — `variance.toFixed(6)`.
- `waste.service.ts` `record` — `(-Math.abs(line.quantity)).toFixed(6)`.

None of these files' own internal arithmetic (`Math.abs`, `discrepancy = received - dispatched`,
count `variance`) was touched — that arithmetic predates this slice, is not part of CG-01's named
defect location (`movements.service.ts:119-232`), and is recorded as residual risk (§7) rather than
fixed here, per the task's "narrowest correction" instruction.

## 4. Transaction / locking reasoning (§9 of the task)

- The atomic `INSERT … ON CONFLICT … DO UPDATE` takes PostgreSQL's own row-level lock on the
  `stock_levels` row for the duration of the statement — no `SELECT … FOR UPDATE`, no process-local
  mutex, no read-then-retry loop. Two concurrent transactions targeting the same `(stock_item_id,
  location_id)` serialize at that one statement; there is no window in which both can read a stale
  value.
- `fifo-cost-ledger.ts`'s existing `lockLayers` (`FOR UPDATE`, `created_at ASC, id ASC`, no
  `SKIP LOCKED`) is **unchanged** — same call, same ordering, same condition (`outbound &&
  item.isBatchTracked`). This slice does not touch batch/FIFO locking at all.
- No lock grouping, no `SKIP LOCKED`, no depletion refactor — A1-2/A1-3 territory, not attempted.

## 5. API / schema impact

**None.** Verified, not assumed:

- `PostMovementDto.quantity` (public, `@Matches(DECIMAL)` validated string) is unchanged.
- `postedMovementSchema.balanceAfter` (OpenAPI, documented `type: 'number'`) is unchanged — the
  service still returns a JS `number` for `balanceAfter`; only the *persisted* value is now exact.
  The conversion happens once, at the very end of `post()`, converting the DB's own returned exact
  string to a `number` purely for the transport boundary — never used to compute anything persisted.
- `npx prisma validate` — schema valid, zero diff to `prisma/schema.prisma`.
- `npm run openapi:check` (`nest build && node dist/scripts/generate-openapi.js && git diff
  --exit-code -- docs/api`) — **zero diff.** The generated `docs/api/openapi.json`/`.yaml` are
  byte-identical to HEAD.
- No route, permission, RBAC, or RLS change.
- `PostMovementInput`/`TransferInput`/etc. (internal, non-exported-through-OpenAPI TypeScript
  interfaces) changed; this is exactly the "internal-service/write-path only" boundary the task asked
  for, not a DTO/OpenAPI change, so no STOP was required.

## 6. Tests added

New file: `test/movements-concurrency.e2e-spec.ts`. Barrier pattern copied verbatim from the already
-accepted `kds-concurrency.e2e-spec.ts` / `order-completion-concurrency.e2e-spec.ts` style: a
`BarrierPrismaService extends PrismaService`, overriding `withAuthContext` to pause every call at the
one choke point `MovementsService.post` always passes through, released only once both parties have
arrived — a genuine two-transaction PostgreSQL race, not `Promise.all` timing luck.

### 6.1 Concurrency tests (§12 of the task)

1. **Two same-sign concurrent movements** on one `(item, location)`: seed `10.000000`, concurrently
   `+2.125000` and `+3.375000`. Asserts (a) `stock_levels.quantity_on_hand` equals the exact fold of
   `stock_movements.quantity` (`Prisma.Decimal.equals`, never `Number()`/`parseFloat()`), (b) the
   final value is exactly `15.500000`, (c) both movement rows exist, (d) the pair of returned
   `balanceAfter` values matches one of the two valid serial interleavings (`{12.125000, 15.500000}`
   or `{13.375000, 15.500000}`) — never a value reflecting only one movement.
2. **One positive + one negative concurrent movement**: `+5.500000` / `-3.250000` on `10.000000` →
   exact `12.250000`, same fold-equals-level assertion.
3. **Three clean runs** of a same-item real-barrier race (`0.500001` / `0.250002` on `1000.000000`,
   repeated 3 times with fresh fixtures) — the task's "three clean runs" requirement.

### 6.2 Exact-decimal regression (§13 of the task)

Seeds `100000000000.000000` — 12 integer digits, the maximum `NUMERIC(18,6)` allows before its 6
decimal digits, and the magnitude at which a JS `number` (≈15–17 reliable significant decimal digits)
mathematically cannot hold all 18 significant digits the column allows. 200 **sequential** (not
concurrent — this test is about arithmetic exactness, not races) movements alternate `+0.700003` /
`-0.399991`. Assertion: `stock_levels.quantity_on_hand` equals the exact `Prisma.Decimal` fold of
every `stock_movements.quantity` row, and both equal an independently computed `Prisma.Decimal`
expectation — all decimal.js arbitrary-precision arithmetic, zero `Number()`/`parseFloat()` anywhere
in the assertion chain.

This magnitude/delta combination was chosen over a larger iteration count at nominal magnitude
(P0's "10,000" figure) after empirically verifying the tradeoff: at nominal magnitude (e.g. starting
near 10 or 1,000), the pre-fix formula's own per-call DB string round trip (`Number(string) → add →
.toFixed(6) → string → DB → next read`) mostly self-corrects each step's tiny double-rounding error
before it can compound, so a very large iteration count is needed before any drift becomes visible at
6 dp. At the `NUMERIC(18,6)` ceiling, the drift is immediate and persistent rather than probabilistic
— verified by literally reintroducing the pre-fix formula (see §6.3) before finalizing this test's
shape, keeping the suite's total runtime sane per the task's own instruction rather than running (up
to) 10,000 real DB round trips.

### 6.3 Verification that the new tests actually detect CG-01 (not vacuous)

Before finalizing, the pre-fix pattern (read-then-absolute-write, `Number()` arithmetic, no atomic
upsert) was temporarily reintroduced into `movements.service.ts` (with a 25 ms artificial delay to
widen the race window) and the full `movements-concurrency.e2e-spec.ts` suite was re-run:

- All 3 concurrency tests **failed** (`fold.equals(level)` → `false`; the lost update reproduced).
- The exact-decimal regression test **failed** (`fold.equals(level)` → `false`; the drift
  reproduced — `100000000045.000458` vs the exact `100000000045.001800` at the equivalent 500-step,
  nominal-magnitude construction originally tried, and confirmed again at the final 200-step,
  ceiling-magnitude construction).

The atomic-projection code was then restored exactly (diffed byte-identical to the pre-sabotage
version) and the full suite re-verified green. This confirms the new tests are a genuine regression
guard for CG-01, not a suite that would pass regardless of the fix.

## 7. Residual risks (explicitly not fixed in this slice)

| Risk | Why deferred |
|---|---|
| `averageCost` concurrent-receipt race (two simultaneous receipts computing weighted-average cost off the same stale `currentQty`/`currentAvg` pre-read) | Not named by CG-01 (which is about `quantity_on_hand`/`balance_after` only); the traceability report's own test matrix places "two concurrent receipts … weighted average correct" under **A1-4**, not A1-1 (§12.4, §29.8). `SaleDepletionService` never had to solve this either. |
| `costing.ts` float arithmetic (`selectBatches`, `valuationUnitCost`, `weightedAverageCost`, `totalCost`) | Pre-existing, unrelated to the persisted quantity/`balance_after` projection this slice fixes (§16 of the task: unrelated float usage → do not fix, record as residual risk). Governs batch selection and monetary valuation, not the ledger/projection invariant BR-INV-003 protects. |
| `TransfersService.receive`'s own `discrepancy = input.receivedQuantity - dispatched` (JS float subtraction) and `dispatched = Math.abs(Number(out.quantity))` | Pre-existing float arithmetic outside `movements.service.ts:119-232` (CG-01's named location). Left untouched per "narrowest correction" — only the final hand-off to `MovementsService.post` was changed (`.toFixed(6)`), not this pre-existing computation. |
| `BR-INV-003` daily reconciliation job (CG-02, §12.2 of the traceability report) | No scheduler/outbox exists; explicitly owned by `B2-3`, not A1-1 (task §15: "No new module, no scheduler, no outbox"). |
| Races NOT covered by this slice: transfer-out vs. concurrent sale depletion, count vs. concurrent sale (CT-08), waste vs. concurrent sale, two concurrent receipts (lost update + weighted-average), deadlock-inversion probe between the completion path and `MovementsService.post` | All explicitly named as **A1-4** scope in the traceability report (§12.4, §29.8) and explicitly out of scope for A1-1 per the task's own §15. |

## 8. Files changed

- `src/modules/inventory/movements/movements.service.ts` — the core fix (atomic projection, exact
  decimal, `PostMovementInput.quantity: string`).
- `src/modules/inventory/inventory.controller.ts` — `postMovement`: pass `dto.quantity` straight
  through instead of `Number(dto.quantity)`.
- `src/modules/inventory/movements/transfers.service.ts` — three `.post()` call sites: `.toFixed(6)`
  at the hand-off.
- `src/modules/inventory/counts/counts.service.ts` — one `.post()` call site: `.toFixed(6)`.
- `src/modules/inventory/waste/waste.service.ts` — one `.post()` call site: `.toFixed(6)`.
- `test/movements-concurrency.e2e-spec.ts` — **new**: concurrency + exact-decimal regression suite.
- Seven existing e2e fixture files updated for the `PostMovementInput.quantity: string` type change
  (test-fixture-only edits — a literal `10` → `'10'`, `Number(qty)` → `qty` where `qty` was already
  typed `string`, etc., no assertion logic changed): `test/order-completion-concurrency.e2e-spec.ts`,
  `test/order-completion-concurrency-2.e2e-spec.ts`, `test/order-completion-pinning.e2e-spec.ts`,
  `test/order-completion-rls.e2e-spec.ts`, `test/order-completion-structural.e2e-spec.ts`,
  `test/order-completion.e2e-spec.ts`, `test/sales-lines.e2e-spec.ts`.

No Prisma schema file touched. No migration created.

## 9. Checks / tests executed this session

All against the Lane-A disposable database `ros_lane_a_a11_20260902043434` on a dedicated Postgres
16 container (`ros-postgres-lane-a`, host port 5555) — never the persistent `ros` database.

| Check | Result |
|---|---|
| `git diff --check` | Clean, no whitespace errors |
| `npx prisma validate` | Schema valid, zero diff to `prisma/schema.prisma` |
| `npx tsc --noEmit -p .` | Clean except the pre-existing, unrelated `access-token.service.spec.ts:28` `TS2322` (present at baseline HEAD too — see §10) |
| `npm run openapi:check` | Zero diff — `docs/api/openapi.json`/`.yaml` byte-identical to HEAD |
| Unit suite (`npx jest`) | **815/815 passed**, 60/60 suites — matches the traceability report's baseline unit count exactly |
| `module-boundaries.spec.ts` + `costing.spec.ts` | 65/65 passed |
| `test/inventory.e2e-spec.ts` + `test/inventory-rls.e2e-spec.ts` | 54/54 passed (covers transfers, counts, waste, append-only ledger/projection, tenant isolation, boundary compliance) |
| `test/order-completion*.e2e-spec.ts` + `test/sales-lines.e2e-spec.ts` (8 suites — sale depletion / FIFO costing / completion paths that share the write-path kernel) | 98/98 passed |
| `test/movements-concurrency.e2e-spec.ts` (**new**) | 4/4 passed; independently verified to **fail** against the reintroduced pre-fix code (§6.3) |
| Full e2e suite (all 65 files, `--maxWorkers=4`) | **1156/1157 passed, 64/65 suites.** The one failure (`test/order-completion-performance.e2e-spec.ts`, the `NFR-PERF-006` benchmark) is a Prisma interactive-transaction timeout (5000 ms exceeded) inside `SaleDepletionService` — a file this slice does not touch. **Independently re-run against unmodified baseline HEAD** (`git stash` of every change in this slice, confirmed clean tree at `63d3b7c2`, re-run of just that one suite, `git stash apply` + drop to restore): **fails identically at baseline**, same 5000 ms/5166 ms timeout, same root cause. Confirmed pre-existing, not a regression from this slice, and explicitly excluded from A1-1's acceptance bar by the task itself ("Do NOT make NFR-PERF-006 benchmark an acceptance criterion for A1-1"). |

## 10. Pre-existing, unrelated TS error

`src/modules/identity/auth/access-token.service.spec.ts:28` — `TS2322: Type 'string' is not
assignable to type 'number | StringValue | undefined'`. Present at baseline HEAD
(`63d3b7c2`) before any change in this session, in a file this slice never touches
(identity/auth, unrelated to inventory). Reported separately per the task's own instruction; not
fixed here (out of scope for A1-1).

## 11. Readiness for A1-2 / A1-3

- **A1-2** (lock grouping per `(stock_item_id, location_id)` in `SaleDepletionService`, evolving
  in-memory FIFO layer state) — **NOT STARTED.** This slice does not touch `sale-depletion.service.ts`
  or `fifo-cost-ledger.ts` beyond exporting the already-existing `toDecimal6` function for reuse.
  `MovementsService.post` is now on the same atomic-projection pattern `SaleDepletionService` already
  used, so A1-2's lock-grouping work has one fewer inconsistency to reconcile between the two write
  paths.
- **A1-3** (window-function set-oriented writes) — **NOT STARTED.** Requires its own design gate per
  §29.10 of the traceability report; not attempted, not implied ready, no design produced in this
  session.
- **A1-4** (transfer vs. sale, count vs. sale / CT-08, waste vs. sale, two-receipts race, deadlock
  inversion matrix) — **NOT STARTED**, per the task's explicit non-goals (§15).

## 12. Commit

Committed after this report and the INDEX row, per the task's §20. Exact subject:

```
fix(inventory): make movement projection atomic
```

Staged explicitly (no `git add .`/`git add -A`): the five `src/` files, the eight `test/` files, this
report, and the one `INDEX.md` row.

## 13. Push / deploy status

**NOT PUSHED. NOT DEPLOYED. NOT MERGED. NOT REBASED**, per the task's explicit instructions.
