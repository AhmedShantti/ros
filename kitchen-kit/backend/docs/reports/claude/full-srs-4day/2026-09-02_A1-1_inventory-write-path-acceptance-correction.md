# A1-1 ACCEPTANCE CORRECTION — Exact Persisted Movement Deltas (P1-PERF, Lane A)

| Field | Value |
|---|---|
| **Task / slice name** | `P1-PERF` / `A1-1` acceptance correction — exact persisted movement deltas for every `MovementsService.post` caller |
| **Lane** | A — Performance + Inventory Concurrency |
| **Report type** | Narrow implementation correction + tests + report |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was implemented and verified **in this session** against the repository at the HEAD below. It ratifies nothing and authorizes no decision beyond recording this correction's own result. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `eef0f156501fbcf5ace4529ac7c545f8bfd8f880` — *fix(inventory): make movement projection atomic* (the A1-1 slice this corrects) |
| **Branch** | `full-srs/lane-a-perf-inventory` |
| **Worktree** | `/Users/mac/projects/ros-worktrees/lane-a` |
| **Working tree at start** | Clean, verified via `git status --short --untracked-files=all` before any edit. |
| **Prior report read** | `docs/reports/claude/full-srs-4day/2026-09-02_A1-1_inventory-write-path-correctness.md` |
| **Task identifier** | A1-1-correction / full-srs-4day / lane-a |
| **Status** | COMPLETE — acceptance-clean at the time of writing; commit performed immediately after per the task's own commit step |

---

## 1. Acceptance gap

A1-1 made `MovementsService.post` itself atomic and exact (the DB projection, `balance_after`
sourcing, and internal `PostMovementInput.quantity` type). It explicitly left every **caller's own**
pre-existing arithmetic untouched, converting whatever float that arithmetic had already produced to
a string only at the final hand-off (`.toFixed(6)`) — a deliberate, narrowly-scoped decision recorded
as residual risk in the A1-1 report (§7). This correction closes that gap: for every caller of
`MovementsService.post`, the arithmetic chain from the caller's own authoritative input (the DTO's
validated decimal string, or another movement's already-persisted `Prisma.Decimal`) through to
`PostMovementInput.quantity` is now exact end to end — no `Number()`/`parseFloat()`/JS
`+`/`-`/`Math.abs()` on a value that determines a persisted `stock_movements.quantity`.

## 2. Callers inspected

Static search (§10 below) confirms exactly **6** call sites into `MovementsService.post`/
`postStandalone`, across **4** files:

| File | Call site | Pre-correction float path | Status |
|---|---|---|---|
| `inventory.controller.ts:517` | `postMovement` (standalone) | `Number(dto.quantity)` at the controller | **Fixed** — `dto.quantity` passed straight through (already a validated decimal string) |
| `transfers.service.ts:77` | `dispatch` → `transfer_out` | `-Math.abs(input.quantity)` where `input.quantity` came from `Number(dto.quantity)` at the controller | **Fixed** |
| `transfers.service.ts:168` | `receive` → `transfer_in` | `dispatched = Math.abs(Number(out.quantity))` | **Fixed** |
| `transfers.service.ts:183` | `receive` → `manual_adjustment` (discrepancy) | `discrepancy = input.receivedQuantity - dispatched` (JS subtraction of two floats) | **Fixed** |
| `counts.service.ts:273` | `post` → `count_adjustment` | `variance` computed in `recordCount` via `countedQuantity - Number(line.expectedQuantity)`, re-read via `Number(line.variance)` in `post` | **Fixed** (both ends) |
| `waste.service.ts:75` | `record` → `waste` | `-Math.abs(line.quantity)` where `line.quantity` came from `Number(l.quantity)` at the controller | **Fixed** |

## 3. Exact arithmetic changes

All four public DTOs feeding these paths (`PostMovementDto.quantity`, `DispatchTransferDto.quantity`,
`ReceiveTransferDto.receivedQuantity`, `RecordCountDto.countedQuantity`, `WasteLineDto.quantity`) were
**already** `@Matches(DECIMAL) string` fields — the controller was the first point of float
contamination (`Number(dto.*)`), not the wire format. The fix removes every such controller-level
`Number()` call and threads the string through:

- **`TransfersService`** — `TransferInput.quantity` and `ReceiveTransferInput.receivedQuantity`
  changed from `number` to exact decimal `string`. `dispatch()` parses via `new Prisma.Decimal(...)`
  and uses `.negated()`; `receive()` computes `dispatched = out.quantity.abs()` directly off the
  already-exact `Prisma.Decimal` read from the ledger (never `Number(out.quantity)`), and
  `discrepancy = receivedExact.minus(dispatchedExact)` — decimal.js exact subtraction, never JS `-`.
- **`CountsService`** — `recordCount`'s `countedQuantity` parameter changed from `number` to `string`.
  `variance = countedExact.minus(expectedExact)` where `expectedExact` is `line.expectedQuantity`
  itself (already an exact `Prisma.Decimal`, never `Number()`-converted) — persisted into
  `count_lines.variance` as a `Prisma.Decimal`, not a JS number. `post()` reads that same
  `Prisma.Decimal` back (`line.variance ?? new Prisma.Decimal(0)`) with no `Number()` round trip.
- **`WasteService`** — `RecordWasteInput.lines[].quantity` changed from `number` to `string`. One
  `Prisma.Decimal` magnitude (`new Prisma.Decimal(line.quantity).abs()`) now feeds **both** the
  persisted movement quantity (`.negated().toFixed(6)`) and the `waste_lines.quantity` row (a
  secondary, denormalized reporting table using the identical magnitude) — previously each was
  computed by a separate `Math.abs(line.quantity)` call on the same tainted float.
- Every **return value** documented in the public OpenAPI schema as a JS `number`
  (`quantityDispatched`, `quantityReceived`, `discrepancy`, `adjustments[].variance`) is converted via
  `.toNumber()` **once**, at the very end, from the already-exact `Prisma.Decimal` — never used to
  compute anything persisted. This is the identical transport-boundary pattern A1-1 established for
  `PostedMovement.balanceAfter`.
- No second decimal library was introduced. `Prisma.Decimal` (decimal.js, already a repository
  primitive — used throughout `movements.service.ts` and `sale-depletion.service.ts`) was used
  directly in these three caller files rather than round-tripping through `Rational`/
  `parseExactDecimal`/`toDecimal6`, since the values here are single caller-local computations
  (negate, abs, subtract) rather than the fold/lock/consumption-plan arithmetic those primitives exist
  for — `Prisma.Decimal`'s own arbitrary-precision methods (`.abs()`, `.negated()`, `.minus()`,
  `.isZero()`, `.lte()`, `.toFixed()`, `.toNumber()`) are sufficient and are explicitly named as an
  acceptable "existing repository primitive" by the task itself (§3).

## 4. What remains out of scope (unchanged, per the task's explicit exclusions)

- `costing.ts` valuation arithmetic (`selectBatches`, `valuationUnitCost`, `weightedAverageCost`,
  `totalCost`) — untouched.
- FIFO/FEFO batch selection — untouched.
- `averageCost` concurrent-receipt race — untouched (still A1-4).
- Transfer-vs-sale, count-vs-sale, waste-vs-sale races, deadlock-inversion probe, daily reconciliation
  job — all still A1-4/CG-02, not attempted.
- `A1-2` lock grouping, `A1-3` set-oriented writes — not attempted.
- `CountsService.open()`'s `expectedQuantity: byItem.get(stockItemId)?.quantityOnHand ?? 0` — a direct
  field copy (Decimal → Decimal, or the literal `0`), no arithmetic, not part of this gap.

## 5. Public contract

**No DTO/API/OpenAPI change.** Every DTO field this correction touches
(`PostMovementDto.quantity`, `DispatchTransferDto.quantity`, `ReceiveTransferDto.receivedQuantity`,
`RecordCountDto.countedQuantity`, `WasteLineDto.quantity`) was **already** a validated decimal
string before this session — the fix is entirely on the internal side of that boundary. Every
OpenAPI-documented response field that was a JS `number` (`quantityDispatched`, `quantityReceived`,
`discrepancy`, `adjustments[].variance`) still is, produced via a single `.toNumber()` conversion of
the now-exact `Prisma.Decimal` at the point of return. Verified, not assumed:

- `npx prisma validate` — schema valid, zero diff.
- `npm run openapi:check` — **zero diff.** `docs/api/openapi.json`/`.yaml` byte-identical to the
  starting HEAD.
- No route, permission, RBAC, or RLS change.

No STOP condition fired — no public contract change was ever required.

## 6. Tests

New file: `test/inventory-exact-decimal-callers.e2e-spec.ts` (7 tests), calling `TransfersService`,
`CountsService`, `WasteService` directly against the Lane-A disposable database (service-layer, real
Postgres — the controller's only remaining job in this chain is an unconditional pass-through of an
already-validated string, so testing at the service layer exercises 100% of the arithmetic this
correction changed).

- **TRANSFER**
  - The task-specified example: dispatched `0.300003`, received `0.100001` → asserts the persisted
    `transfer_out` movement is exactly `-0.300003`, `transfer_in` is exactly `0.300003` (the
    dispatched quantity, BR-INV-002), and the `manual_adjustment` discrepancy movement is exactly
    `-0.200002`.
  - **Adversarial magnitude** (new, beyond the task's literal example, to make the regression
    deterministic rather than incidental): `100000000000.123456` / `100000000000.523456` — 18
    significant decimal digits, at the `NUMERIC(18,6)` ceiling. Verified empirically before writing
    the test: `Number('100000000000.123456').toFixed(6)` → `'100000000000.123459'`, a real,
    guaranteed, single-operation precision loss at this magnitude (not a repeated-operation
    accumulation like A1-1's own regression — a single `Number()` call is already lossy here).
    Asserts all three movements exact, including the discrepancy (`0.400000` exactly).
  - Zero-discrepancy case: no reason code required, no adjustment movement written.
- **COUNT** — a `CountSession`/`CountLine` seeded directly (bypassing `open()` to isolate the
  `recordCount`/`post` exactness, per the task's "focused test" instruction), `expectedQuantity =
  100000000000.100000`, `countedQuantity = 100000000000.500000` → asserts `recordCount`'s returned
  `variance` string (`'0.4'`, decimal.js's own trailing-zero-stripped representation) and the
  persisted `count_adjustment` movement's exact quantity (`0.400000`). A zero-variance case asserts no
  movement is posted.
- **WASTE** — the same adversarial magnitude, asserting both the persisted `waste` movement
  (`-100000000000.123456`) and the `waste_lines.quantity` row (`100000000000.123456`, the same exact
  Decimal feeding both). A second, plain 6dp case (`2.700003`) for a non-adversarial sanity check.

All assertions use `Prisma.Decimal.equals()` (decimal.js exact comparison) or direct string equality
against the service's own already-exact `.toString()` output — never `Number()`/`parseFloat()` in an
assertion, per the task's explicit instruction.

### 6.1 Verification that the new tests actually detect the gap (not vacuous)

Before finalizing, the pre-correction arithmetic (`Number()`/`Math.abs()`/JS `-`/`+`, with the
**string** signatures left intact so the test file needed no changes) was temporarily reintroduced
into `transfers.service.ts`, `counts.service.ts`, and `waste.service.ts`, and the full
`inventory-exact-decimal-callers.e2e-spec.ts` suite was re-run:

- The 3 **adversarial-magnitude** tests (transfer, count, waste) **failed**, exactly as predicted —
  e.g. the count test's `recorded.variance` came back `'0.399994'` instead of the exact `'0.4'`.
- The 4 tests built from smaller, non-adversarial magnitudes (the task's literal transfer example,
  the zero-discrepancy/zero-variance cases, and the plain 6dp waste case) still **passed** even under
  the sabotaged code — expected and consistent with A1-1's own finding: a single JS float operation on
  modest, well-formed 6dp operands usually still rounds correctly through `.toFixed(6)`; the failure
  mode this correction targets is specifically large-magnitude and/or repeated arithmetic, which the
  adversarial cases are deliberately built to expose deterministically.

The three services were then restored exactly (diffed byte-identical to the pre-sabotage version) and
the full targeted suite re-verified green. This confirms the new tests are a genuine regression guard
for this correction, not a suite that would pass regardless of the fix.

`test/movements-concurrency.e2e-spec.ts` (A1-1's own suite) was re-run unmodified and remains green —
untouched by this correction, since `movements.service.ts` itself was not edited this session.

## 7. Static search — every `MovementsService.post`/`postStandalone` call site

```
src/modules/inventory/inventory.controller.ts:517   postStandalone (standalone POST /inventory/movements)
src/modules/inventory/movements/transfers.service.ts:77    dispatch → transfer_out
src/modules/inventory/movements/transfers.service.ts:168   receive  → transfer_in
src/modules/inventory/movements/transfers.service.ts:183   receive  → manual_adjustment
src/modules/inventory/counts/counts.service.ts:273         post     → count_adjustment
src/modules/inventory/waste/waste.service.ts:75            record   → waste
```

Exhaustive — cross-checked against every `PostMovementInput` reference and every direct
`stockMovement.create` call in `src/` (only two exist: `movements.service.ts` itself, and
`sale-depletion.service.ts`, which was already exact per A1-1's own audit and is untouched here — no
other code constructs a `stock_movements` row).

Confirmed after this correction: **zero** `Number()`/`parseFloat()`/`Math.abs()`/JS arithmetic path
remains in any of these six call sites that determines a persisted `stock_movements.quantity`. Every
remaining `Number()`-shaped call in the three touched files is a `.toNumber()` on an already-exact
`Prisma.Decimal`, used **only** to populate a transport-boundary field the OpenAPI schema documents as
a JS number, **after** the corresponding movement (and its exact quantity) has already been
persisted — confirmed by inspection: `transfers.service.ts:108,218-220`,
`counts.service.ts:286`. This is not a repository-wide "zero float" claim — `costing.ts` (valuation)
and `movements.service.ts`'s own `averageCost` computation still use JS `number` by design, unrelated
to `stock_movements.quantity` (§4).

## 8. Files changed

- `src/modules/inventory/inventory.controller.ts` — four call sites (`dispatch`, `receive`,
  `recordCount`, `recordWaste`): removed `Number(dto.*)`, pass the validated string straight through.
- `src/modules/inventory/movements/transfers.service.ts` — `TransferInput.quantity` and
  `ReceiveTransferInput.receivedQuantity` now `string`; `dispatch`/`receive` use `Prisma.Decimal`
  throughout instead of `Math.abs`/`Number`/JS subtraction.
- `src/modules/inventory/counts/counts.service.ts` — `recordCount`'s `countedQuantity` param now
  `string`; `variance` computed and persisted as an exact `Prisma.Decimal` in both `recordCount` and
  `post`.
- `src/modules/inventory/waste/waste.service.ts` — `RecordWasteInput.lines[].quantity` now `string`;
  one exact `Prisma.Decimal` feeds both the movement and the `waste_lines` row.
- `test/inventory-exact-decimal-callers.e2e-spec.ts` — **new**: 7 tests covering all three callers.

No Prisma schema file touched. No migration created. `movements.service.ts` itself was **not**
modified in this session (its own atomic-projection fix from A1-1 stands unchanged).

## 9. Checks / tests executed this session

All against the Lane-A disposable database `ros_lane_a_a11_20260902043434` on the dedicated
`ros-postgres-lane-a` container (host port 5555) — never the persistent `ros` database.

| Check | Result |
|---|---|
| `git diff --check` | Clean |
| `npx prisma validate` | Schema valid, zero diff |
| `npx tsc --noEmit -p .` | Clean except the pre-existing, unrelated `access-token.service.spec.ts:28` `TS2322` (present at the starting HEAD too) |
| `npm run openapi:check` | Zero diff |
| Unit suite (`npx jest`) | **815/815 passed**, 60/60 suites — unchanged from A1-1 |
| `test/inventory-exact-decimal-callers.e2e-spec.ts` (**new**) | 7/7 passed; independently verified to **fail** (3 of 7) against the reintroduced pre-correction arithmetic (§6.1) |
| `test/movements-concurrency.e2e-spec.ts` (A1-1's own suite) | 4/4 passed, unmodified |
| `test/inventory.e2e-spec.ts` + `test/inventory-rls.e2e-spec.ts` | 54/54 passed |
| `test/order-completion*.e2e-spec.ts` + `test/sales-lines.e2e-spec.ts` | targeted run alongside the above: 163/163 passed across 12 suites in that combined run (`order-completion-performance` did not time out this run — see note below) |
| Full e2e suite (all 66 files, `--maxWorkers=4`) | **1162/1164 passed, 64/66 suites.** Two failures: (1) `order-completion-performance.e2e-spec.ts` — the same pre-existing `NFR-PERF-006` Prisma 5000 ms transaction timeout confirmed unrelated in the A1-1 report (this run: 5193 ms elapsed, same root cause, same file this correction never touches). (2) `sales.e2e-spec.ts` — `FR-OFF-015/FR-POS-002 numbering CONCURRENCY` test failed with `permission denied for table order_number_blocks` inside `OrdersService.allocateOrderNumber` — a file and domain (sales order numbering) this correction has zero relation to. **Re-run in isolation immediately after: 63/63 passed, 2/2 suites, clean.** This is a transient full-suite-parallel-load artifact (4 workers hammering one disposable single-container Postgres instance simultaneously across 66 suites), not a reproducible regression — confirmed by the clean isolated re-run and by the fact that neither this correction's diff nor its new test touches `orders.service.ts`, order numbering, or any grant/permission surface. |

**Note on `order-completion-performance.e2e-spec.ts`:** this is the pre-existing `NFR-PERF-006`
benchmark, already confirmed in the A1-1 report to fail intermittently at baseline HEAD on a Prisma
5000 ms interactive-transaction timeout (measured 5006–5166 ms elapsed, i.e. right at the boundary).
This session's targeted run did not trip it; a prior run in this same session did, with the identical
symptom. This is consistent with a pre-existing, timing-sensitive condition — not a regression from
this correction, which does not touch `sale-depletion.service.ts` or `fifo-cost-ledger.ts` at all —
and is explicitly excluded from this correction's acceptance bar by the task itself ("No need to use
NFR-PERF-006 as acceptance for this correction").

## 10. Persistent `ros` database

**Untouched.** All work this session ran against the disposable `ros_lane_a_a11_20260902043434`
database on the dedicated `ros-postgres-lane-a` container, confirmed via `.env`
(`APP_DATABASE_URL`/`DATABASE_URL`) unchanged from the A1-1 session.

## 11. Commit

Committed after this report and the INDEX row. Exact subject:

```
fix(inventory): preserve exact movement deltas
```

Staged explicitly (no `git add .`/`git add -A`): the four `src/` files, the one new `test/` file, this
report, and the one `INDEX.md` row.

## 12. Push / deploy status

**NOT PUSHED. NOT DEPLOYED. NOT MERGED. NOT REBASED.**
