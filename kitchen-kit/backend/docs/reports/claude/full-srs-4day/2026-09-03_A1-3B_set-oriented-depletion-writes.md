# A1-3B — Set-Oriented Group Write Path (P1-PERF, Lane A)

| Field | Value |
|---|---|
| **Task / slice name** | `P1-PERF` / `A1-3B` — set-oriented per-stock-key group write path for `SaleDepletionService`, replacing the per-allocation `writeAllocation` quartet |
| **Lane** | A — Performance + Inventory Concurrency |
| **Report type** | Implementation + tests + correctness/concurrency/performance verification + report |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was implemented and verified **in this session** against the repository at the HEAD below, executing the design accepted in `2026-09-02_A1-3_set-oriented-depletion-design-gate.md` and building on the accepted `2026-09-03_A1-3A_set-oriented-effect-reservation.md`. It ratifies nothing and authorizes no decision beyond recording this slice's own result. Where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. |
| **Date** | 2026-09-03 |
| **Starting HEAD** | `337cd6f19bc4a8e958e6e1eb8bd5539950eec5db` — *docs: record batched depletion reservation* |
| **Branch** | `full-srs/lane-a-perf-inventory` |
| **Worktree** | `/Users/mac/projects/ros-worktrees/lane-a` |
| **Working tree at start** | Clean, verified via `git status --short --untracked-files=all` (empty output). |
| **Task identifier** | A1-3B / full-srs-4day / lane-a |
| **Status** | **A1-3B ACCEPTED. `NFR-PERF-006`: COMPLETE / VERIFIED-PASSING.** Measured p95 = 52.27 ms ≤ 200 ms, with all correctness/concurrency gates green. `A1-3` (A1-3A + A1-3B) is COMPLETE. |

---

## 1. Scope discipline

Implements design gate §16.1B: per stock-key group, plan every effect in memory (A1-2's unchanged evolve functions), then issue at most five statements — aggregated physical `stock_batches` UPDATE, aggregated accounting `stock_batches` UPDATE (with the mandatory carry-forward flush), one `stock_levels` delta + multi-row `stock_movements` INSERT with a SQL window-computed `balance_after`, and one pointer UPDATE + multi-row `sale_depletion_allocations` INSERT. `writeAllocation` (the old four-statement-per-slice method) is deleted — it is not dead code retained as a fallback; it no longer exists in the file.

**Not touched, verified by diff inspection:** `fifo-cost-ledger.ts` (all of `lockLayers`, `planFifoCostConsumption`, `applyCostConsumption` — now unused and superseded by the group-aggregate UPDATE but the file itself is untouched — actually see §11 below for the one clarification), `MovementsService`, the A1-3A reservation statement, the weighted-average hoist, `planPhysicalConsumption`, `evolvePhysicalState`, `evolveAccountingState`, the zipper, `sale-depletion.contract.ts`, `prisma/schema.prisma`, any route/DTO/permission/OpenAPI file.

**One additional file was touched and is disclosed prominently: `src/common/ids.ts`.** See §4 — this was not anticipated by the design gate and is explained in full there.

## 2. Files changed

```
kitchen-kit/backend/src/common/ids.ts                                            |  19 insertions(+), 3 deletions(-)  (net: +16, of which the change is a 2-line logic swap; the rest is an expanded doc comment)
kitchen-kit/backend/src/modules/inventory/sale-depletion/sale-depletion.service.ts | 434 insertions(+), 189 deletions(-)
kitchen-kit/backend/test/sale-depletion-set-oriented-writes.e2e-spec.ts            | new file, 9 tests
```

No schema file, no migration, no contract/DTO, no route, no permission, no OpenAPI file touched — confirmed in §16.

## 3. Group / `ord` model

Group key: `stockItemId` (locationId is one resolved value for the whole call, per A1-2's existing simplification, unchanged). `triples` remains sorted `stockItemId ASC, orderLineId ASC` (unchanged sort from A1-2/A1-3A). A1-3B walks this array in one pass, splitting it into contiguous runs of equal `stockItemId` — a group is exactly one such run, since the array is already sorted. `depleteForCompletedSale` calls a new private `processGroup(...)` once per run.

Inside `processGroup`, `ord` is a plain JS `let ord = 0` counter, incremented once per zipped slice, in the existing traversal order: for each triple in the group (`orderLineId ASC`, unchanged), for each zipped slice of that triple (unchanged zipper emission order). `ord` is local to the group (reset to 0 at group entry) — exactly the design gate §6.2 model, and identical to the sequence A1-2 already executed writes in. No object insertion order, Postgres row order, or UUID order is ever relied on for `ord` itself; `ord` is generated in JS, sequentially, before any SQL for the group is issued.

Per-effect `sequence` (persisted on `sale_depletion_allocations.sequence`) is a **separate** counter, reset to `0` at the start of each triple's own zipped-slice loop — unchanged from A1-2/pre-A1-3B behavior, verified in §9.

## 4. `src/common/ids.ts` — the one incidental fix, disclosed in full

**What happened.** The first run of `test/sale-depletion-lock-grouping.e2e-spec.ts` against the new group-write code failed 2 of 5 tests — both were the multi-effect-same-group scenarios, on `expect(m.balanceAfter.equals(running)).toBe(true)` where `running` is folded by the test over `stockMovement.findMany({ orderBy: [{occurredAt:'asc'},{id:'asc'}] })`. Root cause, isolated and confirmed empirically (`node -e` probe, reproduced below): `ulidx`'s plain `ulid()` (which `newId()` called) only orders by its millisecond timestamp component; two ids generated within the same millisecond carry an independent random tail and are **not** guaranteed to sort in generation order — a tight loop of 20 `ulid()` calls with no delay was confirmed **not** strictly increasing. A1-2/A1-3A's per-slice writes generated one movement id per real DB round trip, which in practice almost always crossed a millisecond boundary between calls, masking this. A1-3B generates every movement/allocation id for a whole group synchronously, with no await in between, which reaches the same-millisecond case reliably.

**The fix.** `src/common/ids.ts`'s own doc comment already promises the id "remains chronologically sortable by byte order" — that promise was not actually kept by plain `ulid()`. `ulidx` ships exactly the fix for this as a first-class export: `monotonicFactory()`, which increments the random tail whenever the clock has not advanced since the last call in the same process, guaranteeing strict monotonicity. `newId()` now calls a single module-level `monotonicFactory()` instance instead of the bare `ulid()` export. Re-verified: 20 calls through the factory are strictly increasing (`node -e` probe, shown in-session).

**Why this is in scope, not scope creep.** This is a one-function, two-line logic change to a shared ID-generation utility, fixing a pre-existing latent gap between the function's documented contract and its actual behavior, using the ID library's own supported API. It touches no schema, no migration, no API, no permission. It is a strict correctness improvement (same-process id generation order and byte-sort order become always identical) with no behavior any caller could rely on being different — `newId()`'s only contract is "a unique, time-ordered id," which is now more truly met, not less. Full unit suite (815/815) and every e2e suite run this session are green after the change; nothing in the codebase depends on ties or same-millisecond reordering.

**Blast radius check.** `newId()` is called broadly across the codebase (every `id: newId()` call site). Since monotonic generation only changes behavior in the previously-broken same-millisecond-tie case, and produces a still-unique, still-valid ULID/UUID in every case, this was assessed as safe without touching any other module — confirmed by the unmodified 815/815 unit and 131/131 targeted e2e results (§14).

## 5. Physical batch aggregate SQL

```sql
UPDATE "inventory"."stock_batches" b
   SET "quantity_remaining" = b."quantity_remaining" - agg.q
  FROM (
    SELECT v.batch_id::uuid AS batch_id, SUM(v.qty::numeric) AS q
    FROM jsonb_to_recordset($1::jsonb) AS v(batch_id text, qty text)
    GROUP BY v.batch_id
  ) agg
 WHERE b."id" = agg.batch_id
```

`private runPhysicalAggregateUpdate` (`sale-depletion.service.ts`). One row is pushed into the payload per physical slice (`physicalPlan.slices`, excluding the null-batch shortfall slice — unchanged from A1-2's own exclusion), **not pre-aggregated in JS** — the `GROUP BY` inside the SQL is the sole aggregation mechanism, per design gate §8.1. Bound via Prisma's tagged-template `$executeRaw` (`${JSON.stringify(rows)}::jsonb`) — never `$queryRawUnsafe`/string-concatenated SQL (see §12).

## 6. Accounting batch aggregate SQL

```sql
UPDATE "inventory"."stock_batches" b
   SET "fifo_cost_quantity_consumed" = b."fifo_cost_quantity_consumed" + agg.q
  FROM (
    SELECT v.batch_id::uuid AS batch_id, SUM(v.qty::numeric) AS q
    FROM jsonb_to_recordset($1::jsonb) AS v(batch_id text, qty text)
    GROUP BY v.batch_id
  ) agg
 WHERE b."id" = agg.batch_id
```

`private runAccountingAggregateUpdate`, same shape, independent statement, independent payload (`plan.slices` from `planFifoCostConsumption`, excluding the carry-forward slice), issued once per group's final flush and once more per mid-group carry-forward flush (§7).

## 7. `GROUP BY batch_id` proof (design gate §8.1/§15 hazard)

New test `sale-depletion-set-oriented-writes.e2e-spec.ts` — *"several effects in one group hit the SAME physical AND accounting batch — every delta is applied, none lost"*: one batch, `qty=20`, four effects in one group taking `3 + 4 + 2.5 + 1.5 = 11`. Asserted: `quantityRemaining == 9` (`20 − 11`, not the last-delta-wins `20 − 1.5 = 18.5` the un-aggregated `UPDATE … FROM` hazard would silently produce — design gate §8.1/probe P3) and `fifoCostQuantityConsumed == 11`. **PASS.**

## 8. Carry-forward treatment (design gate §9.2 — the mandatory flush rule)

Implementation: a group-local `accountingPendingRows: BatchDeltaRow[]` array accumulates one row per real FIFO cost slice (`plan.slices`, excluding carry-forward) as each effect in the group is planned. When an effect's `planFifoCostConsumption` reports a shortfall, **before** calling `findCarryForwardBasis`, the code flushes: if `accountingPendingRows.length > 0`, it issues `runAccountingAggregateUpdate` immediately (including the current effect's own just-queued slices) and resets the array to `[]`. Only then does it query `findCarryForwardBasis`. The carry-forward slice itself (`{batchId: basis.batchId, quantity: plan.shortfall, unitCost: basis.unitCost}`) is pushed into the zipper's `cost` array but **never** into `accountingPendingRows` — carry-forward is excluded from the persisted `fifo_cost_quantity_consumed` aggregate, exactly as A1-2's `applyCostConsumption(tx, plan.slices)` (called before the carry-forward push) already excluded it.

Any remaining `accountingPendingRows` at group end (i.e., not already flushed by a mid-group shortfall) are written by one final `runAccountingAggregateUpdate` call after the effect loop — this is the "0 extra statements on the no-shortfall path" case.

**Proof, new tests:**
- *"a shortfall mid-group carry-forwards to the batch THIS SAME GROUP just exhausted, not a stale snapshot"* — one batch (`qty=5`), two effects in one group: effect 1 takes `5` (exactly exhausting the batch's accounting headroom), effect 2 takes `2` (100% shortfall). Asserted: effect 2's carry-forward `costBasisBatchId` equals the batch effect 1 just exhausted, at the same `unitCost` — the only way this can be true is if the flush ran before `findCarryForwardBasis`, since without it the query would see zero accounting consumption and either find no exhausted layer (`NoHistoricalCostLayerError`) or a stale one. **PASS.**
- *"statement-count proof: the flush issues an EXTRA accounting UPDATE only on the shortfall path"* — query-log-based: exactly **one** `UPDATE … fifo_cost_quantity_consumed` statement for that same fixture (the mandatory pre-carry-forward flush; there is no second flush because effect 2 contributes nothing further to the accounting aggregate). **PASS.**

## 9. Atomic stock-level delta + `RETURNING`

```sql
WITH lvl AS (
  INSERT INTO "inventory"."stock_levels"
    ("tenant_id", "stock_item_id", "location_id", "quantity_on_hand")
  VALUES ($1::uuid, $2::uuid, $3::uuid, $groupDeltaStr::numeric)
  ON CONFLICT ("stock_item_id", "location_id") DO UPDATE
    SET "quantity_on_hand" = "inventory"."stock_levels"."quantity_on_hand" + EXCLUDED."quantity_on_hand"
  RETURNING "quantity_on_hand" - $groupDeltaStr::numeric AS start_balance
), ...
```

`groupDeltaStr` is built in JS from `groupMagnitude` (a `Rational`, accumulated via exact `add(groupMagnitude, slice.quantity)` over every zipped slice in the group — always non-negative by construction, since it sums the unsigned per-slice quantities) as `groupMagnitude.num === 0n ? '0.000000' : '-' + toDecimal6(groupMagnitude)`. No JS `Number` is involved. `start_balance` is derived **inside the same statement** from the just-applied `RETURNING` value — it is never independently `SELECT`ed.

**Starting-balance derivation proof:** new test *"no plain SELECT of stock_levels.quantity_on_hand is ever issued — the start balance is derived from the write itself"* — query-log-based, over a 2-effect one-group call: zero statements matching `SELECT … stock_levels … quantity_on_hand` that are not the `INSERT … ON CONFLICT` itself, and exactly one atomic upsert statement for the whole group. **INDEPENDENT PRE-READ OF STARTING BALANCE: NO.**

## 10. `balance_after` window SQL

```sql
src AS (
  SELECT v.ord, v.movement_id::uuid AS movement_id, v.batch_id::uuid AS batch_id,
         v.qty::numeric AS qty, v.unit_cost::bigint AS unit_cost, v.total_cost::bigint AS total_cost,
         lvl.start_balance
           + SUM(v.qty::numeric) OVER (ORDER BY v.ord
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance_after
  FROM jsonb_to_recordset($rows::jsonb) AS v(ord int, movement_id text, batch_id text, qty text, unit_cost text, total_cost text), lvl
)
INSERT INTO "inventory"."stock_movements" (...) SELECT ... FROM src
```

`private writeGroupLevelsAndMovements` — one statement, one `INSERT … SELECT`, `movement_id`s generated in JS with `newId()` (never `gen_random_uuid()`), `qty` transported as a signed decimal string (`'-' + toDecimal6(slice.quantity)`), `unit_cost`/`total_cost` as bigint strings (`.toString()`), explicit `::numeric`/`::bigint`/`::uuid` casts throughout — never a JS float on a persisted value.

Test coverage: `sale-depletion-lock-grouping.e2e-spec.ts` (unmodified, §14) already asserts exact intermediate `balance_after` per movement for multi-effect groups; the new *"three effects in one group, decimals at the 6dp precision edge, fold exactly"* test adds `0.333333`, `1.666667`, `0.000001` in one group and independently re-folds the persisted `stock_movements` rows, asserting each intermediate `balance_after` and the final `stock_levels.quantity_on_hand` match the exact re-fold. **PASS.**

## 11. Movement multi-row insertion

One `INSERT … SELECT` per group (§10's statement), replacing the 135 (canonical fixture) individual `tx.stockMovement.create(...)` Prisma-client-API calls A1-2/A1-3A issued. `fifo-cost-ledger.ts`'s public surface (`lockLayers`, `planFifoCostConsumption`, `findCarryForwardBasis`) is unchanged; the one function it exported that A1-2/A1-3A called directly for a DB write, `applyCostConsumption`, is no longer called from `sale-depletion.service.ts` (superseded by `runAccountingAggregateUpdate`) — it remains defined and exported in `fifo-cost-ledger.ts`, untouched, in case another caller needs it; `module-boundaries.spec.ts` (45/45, §14) confirms no boundary violation was introduced.

## 12. Final pointer derivation

```sql
ptr AS (
  UPDATE "inventory"."stock_levels" l
     SET "last_movement_id"          = (SELECT movement_id FROM src ORDER BY ord DESC LIMIT 1),
         "last_movement_occurred_at" = $occurredAt::timestamptz
   WHERE l."stock_item_id" = $stockItemId::uuid AND l."location_id" = $locationId::uuid
  RETURNING l."last_movement_id"
)
```

The pointer is resolved by SQL from `src`'s own `ord` column (the same `ord` used for the `balance_after` fold) via `ORDER BY ord DESC LIMIT 1` — never `max(UUID)`, never raw `RETURNING` row order. Proof: new test *"two order lines on one stock key: pointer = the last zipped slice in `ord` order, matching the returned allocation"* re-derives the true last-`ord` allocation independently in the test (via the same `orderLineId ASC` sort the service uses) and asserts `stock_levels.lastMovementId` equals that allocation's `movementId`. The high-precision decimal test (§10) also asserts the pointer equals the third (last) movement's id. **FINAL POINTER: PASS.**

## 13. Allocation multi-row insertion

One `INSERT … SELECT` per group, in the same statement as the pointer `UPDATE` (one round trip, `FROM src, ptr`), replacing 135 (canonical fixture) individual `tx.$executeRaw` per-slice inserts. Every column (`physical_batch_id`, `cost_basis_batch_id`, `sequence`, `quantity_in_base_unit`, `unit_id`, `unit_cost`, `total_cost`, `movement_id`, `movement_occurred_at`) is preserved unchanged. Proof: new test *"sequence resets per effect; every allocation column matches its zipped slice"* — a 2-effect group where effect 1 produces 2 allocation rows (`sequence` 0, 1) and effect 2 produces 1 (`sequence` 0, correctly reset), cross-checked field-by-field against the DB for all 3 persisted rows. **ALLOCATION PROVENANCE: PASS.**

## 14. Physical × accounting axis proof

New test *"FEFO physical batch differs from FIFO accounting batch — each axis mutates only its own batch/field"*: two batches, FEFO strategy so physical picks the later-received/earlier-expiry batch while FIFO accounting picks the earlier-received batch. Asserted: `allocation.physicalBatchId ≠ allocation.costBasisBatchId`; the physical batch's `quantityRemaining` changes and its `fifoCostQuantityConsumed` stays `0`; the accounting (cost-basis) batch's `fifoCostQuantityConsumed` changes and its `quantityRemaining` stays unchanged; `stock_movements.batch_id` follows the physical batch, unchanged from A1-2. **PASS.** (`sale-depletion-lock-grouping.e2e-spec.ts`'s pre-existing FEFO/FIFO-divergence test, unmodified, is the same proof at larger scale — also green, §17.)

## 15. Semantic equivalence to A1-2/A1-3A

`test/sale-depletion-lock-grouping.e2e-spec.ts` — the design gate's own §16.3 acceptance gate — **passes unmodified, 5/5**, including its `Prisma.Decimal.equals` assertions on `stock_batches.quantity_remaining`/`fifo_cost_quantity_consumed`, `stock_movements.balance_after`/`quantity`, and `stock_levels.quantity_on_hand`, across its lock-acquisition-order tests and its two multi-effect group-state-correctness tests (FEFO/FIFO divergence, carry-forward). This is by-construction equivalence: `ord` is defined to be the exact sequence A1-2 already executed writes in (§3), and the group-aggregate SQL is proven (§7, §14) to apply every delta exactly once. **SEMANTIC EQUIVALENCE TO A1-2/A1-3A: PASS.**

## 16. Concurrency / lock order

**Lock order is unchanged.** Groups are still processed in the pre-existing `stockItemId ASC` order (§3). Within a group, statement order is fixed `2a lock → 2c physical → 2d accounting → 2e levels+movements → 2f pointer+allocations` — `stock_batches` `FOR UPDATE` (2a) is still acquired, and both `stock_batches` UPDATEs (2c/2d) still execute, strictly before the `stock_levels` row lock is taken (2e) — preserving the relative order `stock_batches` before `stock_levels` per key that `MovementsService.post` also follows (design gate §7.4, unchanged by this slice — `MovementsService` was not touched). No new row-lock order was introduced: the aggregate `UPDATE … FROM` statements lock the same `stock_batches` rows already `FOR UPDATE`-held from 2a's `lockLayers`, in the same set, just applied via `GROUP BY` instead of one `UPDATE` per slice. No `SKIP LOCKED`, no process-local mutex, no retry loop anywhere in the diff (confirmed by `grep` over the changed files — none of those strings appear).

**Serial-equivalence proof:** `test/order-completion-concurrency.e2e-spec.ts` (part of a 15-test combined run with `-2` below) and `test/order-completion-concurrency-2.e2e-spec.ts` — **19/19 pass together with `movements-concurrency.e2e-spec.ts`**, unmodified, now exercising the group-write path end to end under real two-transaction contention on shared stock keys. `test/cash-movements-close-and-payment-concurrency.e2e-spec.ts` — 34/34 pass (representative cash/payment concurrency, unaffected by this slice but re-run per task §23). **DEADLOCK: NONE** — no new lock-acquisition ordering was introduced (see above), and every concurrency suite that would surface a new cycle passed.

## 17. Exact-decimal proof

No JS `Number` participates in any computation feeding a persisted quantity, cost, or balance anywhere in the diff — every SQL payload numeric field is built from an existing `Rational`/`toDecimal6` string or a `bigint.toString()`, cast `::numeric`/`::bigint` in SQL; `groupMagnitude` (§9) is an exact `Rational` accumulator. `test/inventory-exact-decimal-callers.e2e-spec.ts` — 7/7 pass. `test/sale-depletion-lock-grouping.e2e-spec.ts` — 5/5 pass with `Prisma.Decimal.equals` assertions throughout. The new high-precision test (§10) exercises `0.333333`, `1.666667`, `0.000001` — values at the `DECIMAL(18,6)` scale edge — through the full window-fold, aggregate-UPDATE, and pointer path, with exact re-fold verification. **EXACT DECIMAL: PASS.**

## 18. Before / after statement breakdown

Methodology: identical to A1-2/A1-3A — `ALTER DATABASE … SET log_statement = 'all'` / `log_min_duration_statement = 0` on the disposable Lane-A database (`ros_lane_a_a11_20260902043434`, `ros-postgres-lane-a`, port 5555), `test/order-completion-performance.e2e-spec.ts` run **unmodified**, `--runInBand`, the container's Postgres log (`docker logs`) parsed by backend PID, statements grouped into per-transaction `BEGIN…COMMIT/ROLLBACK` spans (correctly counting both simple-protocol `statement:` log entries and extended-protocol `execute <unnamed>:` entries — the app's Prisma client uses the extended/prepared-statement protocol, so most statements are logged as `parse`/`bind`/`execute` triples; "one statement" = one `execute`, matching A1-3A's own reported ratio of 2,685 messages / 895 statements = 3 messages/statement), settings reset and verified afterward (`pg_db_role_setting` — zero rows, confirmed below).

**Run twice (40 transactions total, two full 20-iteration runs of the unmodified fixture): every single transaction carried exactly 28 statements, identical across all 40.**

| Statement shape | A1-2 (baseline) | A1-3A | A1-3B (measured) |
|---|---:|---:|---:|
| `set_config` | 1 | 1 | 1 |
| `production.recipe_versions` SELECT | 1 | 1 | 1 |
| `production.recipe_lines` SELECT | 1 | 1 | 1 |
| `org.locations` SELECT | 1 | 1 | 1 |
| `inventory.stock_items` SELECT | 1 | 1 | 1 |
| `sale_depletion_effects` reservation INSERT | 135 | **1** | 1 |
| `stock_levels` average-cost SELECT | 45 | **1** | 1 |
| `stock_batches … FOR UPDATE` (`lockLayers`) | 5 | 5 | 5 |
| `stock_batches` physical UPDATE | 105 | 105 | **4** |
| `stock_batches` accounting UPDATE | 60 | 60 | **2** |
| `stock_levels` delta + `stock_movements` INSERT | 270 (135+135) | 270 | **5** |
| `stock_levels` pointer + `sale_depletion_allocations` INSERT | 270 (135+135) | 270 | **5** |
| **Total (excl. `BEGIN`/`ROLLBACK`)** | **895** | **717** | **28** |

867 statements removed by A1-3A+A1-3B together vs. A1-2 (96.9%); A1-3B alone removes 689 of the 674 statements it targeted (105+60+270+270 = 705 A1-3B-scoped statements in A1-3A's baseline → 4+2+5+5 = 16, a 689-statement/97.7% reduction of its own scope). **The measured 28 matches the design gate's own projected breakdown exactly** (physical=4, accounting=2 — one of the fixture's 5 stock keys has no physical slices and 3 have no FIFO accounting slices, per the fixture's known shape from the design gate §4.2/§11).

Fixture shape (unchanged from A1-2/A1-3A): 30 lines, 5 distinct stock keys, 135 logical effects, 135 zipped allocations, 105 physical slices across the batch-tracked groups, 60 FIFO cost slices, 45 weighted-average effects (now 1 hoisted lookup).

Wire-protocol messages: ~28 statements × 3 (parse+bind+execute for unnamed prepared statements, per A1-3A's own measured ratio) ≈ **84**, matching the design gate's own §11 projection almost exactly.

Cleanup verified: `ALTER DATABASE … RESET log_statement` / `RESET log_min_duration_statement` executed; `SELECT * FROM pg_db_role_setting` returned **zero rows** after reset.

## 19. Performance — NFR-PERF-006

`test/order-completion-performance.e2e-spec.ts` run **unmodified**, in isolation, with instrumentation off (the final of three isolation runs this session, taken after the instrumentation cleanup in §18 to guarantee zero logging overhead):

```
NFR-PERF-006: 30 lines, 20 iterations —
p50=41.38ms p95=52.27ms (min=39.65ms max=66.47ms)
all=[52.3,45.8,44.0,41.0,66.5,44.5,42.7,41.2,41.5,42.2,
     39.9,40.2,42.6,42.9,41.4,40.2,39.7,40.7,40.2,41.1]
```

**PERFORMANCE P50: 41.38 ms. PERFORMANCE P95: 52.27 ms. MIN: 39.65 ms. MAX: 66.47 ms.**

Down from A1-3A's isolated `p50=369.44ms / p95=425.75ms` (a further **~88.8% p50** / **~87.7% p95** reduction), and from A1-2's original isolated `p50=750.45ms / p95=2068.60ms` (**~94.5% p50** / **~97.5% p95** cumulative reduction across A1-3A+A1-3B). Two other isolation-style runs taken earlier the same session (one immediately before enabling instrumentation, one taken with instrumentation already active) measured `p50=48.19/p95=75.86ms` and `p50=44.31/p95=47.87ms` respectively — all three runs are well under the 200 ms gate; the figures above (the cleanest — post-cleanup, zero logging overhead) are reported as authoritative.

**Literal p95 = 52.27 ms ≤ 200 ms. NFR-PERF-006: COMPLETE / VERIFIED-PASSING** — correctness and concurrency gates are also green (§15, §16), so both conditions for `COMPLETE` (task §21/§27) are met.

## 20. Remaining bottleneck (n/a — gate passed)

Not applicable: p95 (52.27 ms) is well under the 200 ms literal target with correctness/concurrency green, so `NFR-PERF-006` is `COMPLETE` and task §22's attribution work does not apply. For completeness: of the remaining 28 statements, `set_config`+`planConsumption`'s 4 statements are unrelated to Inventory and untouched (as A1-3's design gate already established, 0.57 ms of server time); the 5 `lockLayers` acquisitions plus the 16 group-write statements (4+2+5+5) are the residual Inventory cost, now dominated by fixed per-round-trip overhead on a handful of statements rather than by count. No further optimisation was attempted or is claimed — that would be A1-4/out-of-scope territory (task §26).

## 21. Schema / API / product-code safety

- **Schema change: NO.** `prisma/schema.prisma` untouched; `npx prisma validate` — `The schema at prisma/schema.prisma is valid`.
- **Migration: NO.** No file created in `prisma/migrations/`.
- **Public API change: NO.** `npm run openapi:check` — clean, `docs/api/openapi.json`/`.yaml` regenerated byte-identical, `git diff --exit-code` passed (confirmed via `git status --short` showing zero changes under `docs/api/`).
- **Product code changed:** `git status --short --untracked-files=all` shows exactly `src/common/ids.ts`, `src/modules/inventory/sale-depletion/sale-depletion.service.ts`, and the new test file — nothing else.
- **Permission/RBAC/RLS: unchanged.** No route, DTO, contract, or permission file touched.

## 22. Database safety

All work in this session used the pre-existing disposable Lane-A database (`ros_lane_a_a11_20260902043434`, container `ros-postgres-lane-a`, port 5555) already in continuous use for A1-1/A1-2/A1-3/A1-3A. **The persistent `ros` database (port 5544) was never connected to** — confirmed by `.env`'s `DATABASE_URL`/`APP_DATABASE_URL`, both port 5555, the only connection strings used this session. Temporary instrumentation (`log_statement`, `log_min_duration_statement`, both `ALTER DATABASE`-scoped) was reset immediately after log capture (§18); `pg_db_role_setting` confirmed empty afterward. No new probe/scratch database was created or dropped this session (the design-gate-era two-session concurrency probes are not re-run here; A1-3B's concurrency claim rests on the unmodified `order-completion-concurrency`/`-2`/`movements-concurrency` suites, §16). Scratch files (`pglog.txt`, parser scripts) were written only to the session scratchpad directory, never committed.

**PERSISTENT `ros` TOUCHED: NO.**

## 23. Remaining A1-4 work

Unchanged from A1-3A's own §18/design-gate §14 list — none of it was started this session:

- The full deadlock matrix (completion vs. `MovementsService.post`, vs. transfers, vs. counts `CT-08`, vs. waste) — must still be built/re-verified against A1-3A's hoisted-reservation shape (unaffected by A1-3B, which changed no lock order).
- The weighted-average concurrent-receipt race (`average_cost` read without a lock in `MovementsService.post`) — unchanged residual, A1-3B does not touch `MovementsService`.
- `BR-INV-003` daily reconciliation job (`CG-02`) — not started.
- Multi-location depletion — the group key already generalizes to `(stockItemId, locationId)` by construction (§3), but multi-location Completion itself remains untested/out of scope.
- `MovementsService.post` set-orientation — explicitly out of A1-3's scope (it posts one movement per call; nothing to batch).

## 24. Static verification

| Check | Result |
|---|---|
| `git diff --check` | Clean (exit 0) |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` — schema file untouched |
| `npx tsc --noEmit -p .` | Clean except the pre-existing, unrelated `access-token.service.spec.ts:28` `TS2322` (present at the starting HEAD; Lane A does not edit Identity) |
| `npm test` (unit, `npx jest`) | 815/815 pass, 60 suites |
| `module-boundaries` (`src/modules/module-boundaries.spec.ts`) | 45/45 pass |
| `npm run openapi:check` | Clean — byte-identical regeneration, zero diff |
| `npx eslint` on all three changed/new files | Zero errors after one prettier `--fix` pass on the new test file (formatting only — one genuine `no-unused-vars` finding was fixed by removing the unused intermediate, not suppressed) |

No new lint errors attributable to A1-3B anywhere in the touched files; no unrelated historical Lane-A lint was inspected or touched.

## 25. Test results (this session)

| Suite | Result |
|---|---|
| `src/modules/module-boundaries.spec.ts` | 45/45 pass |
| Full unit suite (`npx jest`, no DB) | 815/815 pass (60 suites) |
| `test/sale-depletion-lock-grouping.e2e-spec.ts` | 5/5 pass, **unmodified** |
| `test/sale-depletion-effect-reservation.e2e-spec.ts` | 10/10 pass, **unmodified** |
| `test/sale-depletion-set-oriented-writes.e2e-spec.ts` (**new**, A1-3B-specific, 9 tests per task §23 items 1-8/11) | 9/9 pass |
| `test/order-completion.e2e-spec.ts` + `-structural` + `-pinning` + `-rls` | 46/46 pass (4 suites) |
| `test/order-completion-concurrency.e2e-spec.ts` + `-2` + `movements-concurrency.e2e-spec.ts` | 19/19 pass (3 suites) |
| `test/cash-movements-close-and-payment-concurrency.e2e-spec.ts` | 34/34 pass |
| `test/inventory-exact-decimal-callers.e2e-spec.ts` | 7/7 pass |
| `test/order-completion-performance.e2e-spec.ts` | pass, see §19 |
| **Final combined run, all 13 e2e suites above together, `--runInBand`** | **131/131 pass, 13/13 suites** |

## 26. Requirement disposition

| Requirement | Disposition |
|---|---|
| One aggregated physical `stock_batches` UPDATE per group, `GROUP BY`-mandatory | **MET** — §5, §7 |
| One aggregated accounting `stock_batches` UPDATE per group + mandatory carry-forward flush | **MET** — §6, §8 |
| One atomic `stock_levels` group delta, starting balance never independently read | **MET** — §9 |
| One `INSERT … SELECT` per group with SQL window-computed `balance_after` | **MET** — §10 |
| One pointer UPDATE + one multi-row allocation INSERT per group, pointer via explicit `ord` | **MET** — §12, §13 |
| `writeAllocation` deleted, no hidden per-slice fallback | **MET** — §1, §11 (confirmed by `grep`) |
| Physical/accounting axes independent | **MET** — §14 |
| Byte-identical semantics to A1-2/A1-3A | **MET** — §15 (`sale-depletion-lock-grouping` unmodified, green) |
| Lock order unchanged, no new deadlock | **MET** — §16 |
| Exact Decimal/Rational, no JS float on persisted values | **MET** — §17 |
| Statement-count measured, not asserted | **MET** — §18 |
| Performance measured honestly; `COMPLETE` only if p95 ≤ 200 ms with correctness green | **MET** — §19, correctly reported COMPLETE |
| Schema/API/permission unchanged | **MET** — §21 |
| Persistent `ros` untouched | **MET** — §22 |
| A1-3A reservation still strictly first, unmodified | **MET** — reservation code path untouched (§1); its own 10 tests pass unmodified (§25) |

## 27. Commits

Implementation commit (this session): `perf(inventory): batch depletion group writes`.
Report/index commit (this session, following): `docs: record set-oriented depletion writes`.

No push. No deploy. No rebase. No merge.
