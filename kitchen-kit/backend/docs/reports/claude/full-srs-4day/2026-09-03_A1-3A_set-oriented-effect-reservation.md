# A1-3A — Set-Oriented Effect Reservation + Weighted-Average Cost Hoist (P1-PERF, Lane A)

| Field | Value |
|---|---|
| **Task / slice name** | `P1-PERF` / `A1-3A` — set-oriented `sale_depletion_effects` reservation, hoisted before every Inventory lock/mutation, plus a hoisted weighted-average `current_cost` lookup |
| **Lane** | A — Performance + Inventory Concurrency |
| **Report type** | Implementation + tests + correctness/performance verification + report |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was implemented and verified **in this session** against the repository at the HEAD below, executing the design accepted in `2026-09-02_A1-3_set-oriented-depletion-design-gate.md`. It ratifies nothing and authorizes no decision beyond recording this slice's own result. Where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. |
| **Date** | 2026-09-03 |
| **Starting HEAD** | `d0c1c826f2b8561d8cdb452f86cf6fd50dd8b1c5` — *docs(inventory): design set-oriented depletion writes* |
| **Branch** | `full-srs/lane-a-perf-inventory` |
| **Worktree** | `/Users/mac/projects/ros-worktrees/lane-a` |
| **Working tree at start** | Clean, verified via `git status --short --untracked-files=all` (empty output). |
| **Task identifier** | A1-3A / full-srs-4day / lane-a |
| **Status** | **A1-3A ACCEPTED.** Correctness, idempotency, rollback and lock-ordering requirements all met; a real, measured round-trip reduction achieved (895 → 717 statements, reservation 135→1, weighted-average reads 45→1). `NFR-PERF-006` itself remains **PARTIAL / VERIFIED-FAILING** — expected, not required for A1-3A acceptance; A1-3B is the slice that reaches the 200 ms gate. |

---

## 1. Scope discipline

Implements **only** design-gate §16.1's first slice:

1. One set-oriented effect reservation statement for the whole depletion call.
2. Identity-based (not cardinality-based) conflict detection, naming every missing identity.
3. Reservation hoisted before every Inventory lock/mutation.
4. Weighted-average `current_cost` lookup hoisted from per-effect reads to one lookup per call.

**Not touched, verified by diff inspection:** `MovementsService.post`, `fifo-cost-ledger.ts` public behavior/signatures, the physical batch `UPDATE` shape, the accounting batch `UPDATE` shape, `writeAllocation`'s four per-slice statements, any movement window function, the `stock_levels` group-delta write, pointer batching, allocation `createMany`/batching. All of that is A1-3B, explicitly deferred. `transaction boundary`, exact Decimal/Rational arithmetic, the physical FIFO/FEFO planner, the accounting FIFO planner, `lockLayers`, the deterministic stock-key lock order, `evolvePhysicalState`, `evolveAccountingState`, stock movement posting shape, `balance_after` logic, allocation provenance, batch quantity writes and accounting consumed-quantity writes are all byte-identical to A1-2 — confirmed by `git diff` showing zero touches to `fifo-cost-ledger.ts`, `movements.service.ts`, or the `writeAllocation` method body.

## 2. Files changed

```
kitchen-kit/backend/src/modules/inventory/sale-depletion/sale-depletion.service.ts | 171 insertions, 37 deletions
kitchen-kit/backend/test/sale-depletion-effect-reservation.e2e-spec.ts             | new file, 807 lines
```

No schema file, no migration, no contract/DTO, no route, no permission, no OpenAPI file touched — confirmed in §11 below.

## 3. Implementation

### 3.1 Duplicate-identity sabotage guard (before ANY SQL)

Immediately after `triples` is flattened and sorted (unchanged sort: `stockItemId ASC, orderLineId ASC`), a pure-JS pass builds `effectIdentityKey(orderLineId, stockItemId, locationId)` for every triple and rejects the call — throwing `SaleDepletionEffectConflictError` naming every duplicate — if any key repeats. This runs before the stock-item lookup, before the reservation `INSERT`, before anything touches the database. It exists because a duplicate identity inside one `ON CONFLICT DO NOTHING` batch would otherwise let Postgres silently insert only one of the two identically-keyed rows while the caller's code believes both effect ids succeeded — the "masquerade as success" case §16.1/§6(D) of the task forbids.

### 3.2 Stock-item existence validated before reservation

`stockItemById` is still built exactly as in A1-2, but is now checked for every triple **before** the reservation statement runs (previously this check happened per-triple, interleaved with mutation). This is necessary, not cosmetic: the reservation statement now targets every triple in one round trip, so an unknown `stockItemId` would otherwise surface as a raw FK-violation error from the batched `INSERT` instead of the existing clean `NotFoundException`. Zero Inventory state is touched either way.

### 3.3 The reservation statement — exact SQL shape

```sql
WITH req AS (
  SELECT v.ord::int             AS ord,
         v.effect_id::uuid      AS effect_id,
         v.order_line_id::uuid  AS order_line_id,
         v.stock_item_id::uuid  AS stock_item_id,
         v.quantity::numeric    AS quantity,
         v.unit_id::uuid        AS unit_id
  FROM jsonb_to_recordset($1::jsonb)
       AS v(ord int, effect_id text, order_line_id text,
            stock_item_id text, quantity text, unit_id text)
)
INSERT INTO "inventory"."sale_depletion_effects"
  ("id", "tenant_id", "order_id", "business_day", "order_line_id",
   "stock_item_id", "location_id", "quantity_in_base_unit", "unit_id", "created_at")
SELECT req.effect_id, $2::uuid, $3::uuid,
       $4::date, req.order_line_id,
       req.stock_item_id, $5::uuid, req.quantity, req.unit_id,
       $6::timestamptz
FROM req
ORDER BY req.ord
ON CONFLICT ("tenant_id", "order_line_id", "stock_item_id", "location_id") DO NOTHING
RETURNING "order_line_id" AS "orderLineId", "stock_item_id" AS "stockItemId"
```

Matches the design gate's §5.2 architecture exactly. `effectId` is generated in JS with `newId()` (never `gen_random_uuid()`), one per triple, kept in an `effectIds[]` array parallel to `triples`. Bound via Prisma's tagged-template `$queryRaw` — `JSON.stringify(reservationPayload)` is passed as an ordinary string parameter, cast `::jsonb` in SQL; every quantity travels as the pre-existing `quantityInBaseUnit` **string**, cast `::numeric` in SQL — never a JS float. The statement is skipped entirely (zero SQL) when `triples.length === 0`, matching A1-2's existing zero-work behavior.

### 3.4 Identity-based conflict detection

`RETURNING` yields `(orderLineId, stockItemId)` for every row actually inserted (locationId is constant for the call and folded into the identity key). The service builds a `Set` of returned identity keys and filters `triples` for any whose identity is **absent** — not by comparing array lengths. Every triple failing that test is a genuine conflict; **all** of them are named in the thrown `SaleDepletionEffectConflictError` message (`"A depletion effect already exists for N of M requested effect(s): (order line …, stock item …, location …); …"`), not only the first. This runs strictly before `lockLayers` is ever called for this transaction.

### 3.5 Weighted-average cost hoist

Before the group loop, the service collects the distinct `stockItemId`s among `triples` whose `costingMethod === 'weighted_average'` and issues one `tx.stockLevel.findMany({ where: { stockItemId: { in: [...] }, locationId } })`, building a `Map<stockItemId, bigint>`. Inside the loop, the weighted-average branch now reads `averageCostByStockItemId.get(triple.stockItemId) ?? 0n` instead of calling a per-effect `currentAverageCost` query (that method has been deleted — it is now unreachable dead code, not merely unused). `standard`-cost items still read `item.standardCost` directly (never touch this map); FIFO items never consult it. A missing `stock_levels` row yields `undefined` from the map, defaulting to `0n` — the same zero-default semantics `currentAverageCost`'s `level?.averageCost ?? 0n` produced pre-A1-3A. Cost-strategy selection itself (`item.costingMethod === 'weighted_average' || 'standard'` vs. the FIFO `else` branch) is untouched.

## 4. JSONB Prisma binding — hard-check proof

Proven twice, both against the real Lane-A disposable database and the real `Prisma.TransactionClient` / `tx.$queryRaw` tagged-template path (never `$queryRawUnsafe` string interpolation, never a mock):

1. **A standalone probe** (session scratchpad, not committed — deleted after use) drove `JSON.stringify(payload)` through `jsonb_to_recordset($1::jsonb)` with several rows carrying UUIDs (`::uuid`), decimal strings at `DECIMAL(18,6)` precision including `0.000001` (`::numeric`), and a `timestamptz`/`date` pair (`::timestamptz`/`::date`), inside a real `prisma.withAuthContext`-shaped transaction, rolled back deliberately. All values round-tripped exactly (`1.250000`, `0.000001` returned byte-identical as text; the timestamp returned `2026-09-03T12:34:56.789Z` exactly).
2. **The committed suite** (`test/sale-depletion-effect-reservation.e2e-spec.ts`, "real Prisma jsonb binding + all-success batch reservation") drives the actual `SaleDepletionService.depleteForCompletedSale` through a **separate, real** `PrismaClient` connected via `APP_DATABASE_URL` with query-event logging enabled (`log: [{ emit: 'event', level: 'query' }]`), and asserts exactly **one** `INSERT INTO "inventory"."sale_depletion_effects" ... jsonb_to_recordset ...` statement is issued for a 3-row, 2-stock-item batch, with all three allocations produced correctly.

**JSONB PRISMA BINDING: PASS.**

## 5. Duplicate-payload protection — sabotage test

`test/sale-depletion-effect-reservation.e2e-spec.ts`, "duplicate request identity — sabotage": one order line with two components pointing at the **same** `stockItemId` (so both triples share one identity key). The call is rejected with `SaleDepletionEffectConflictError` whose message contains `"Duplicate depletion effect identity requested within the same call"`, and the query log confirms **zero** `INSERT INTO "inventory"."sale_depletion_effects"` statements were ever issued — the guard fires before any SQL, exactly as designed in §16.1(D) of the task. `sale_depletion_effects` is unchanged before/after.

## 6. Rollback proof — partial reservation success, then a conflict

`test/sale-depletion-effect-reservation.e2e-spec.ts`, "rollback proof — partial reservation success, then a conflict": two stock keys `lo`/`hi`; `hi` has one pre-existing effect (committed beforehand, simulating a prior Completion); a single call requests two **new** effects on `lo` (which the one reservation statement would successfully insert) plus one effect on `hi` (which it would skip). The call throws `SaleDepletionEffectConflictError`. After the throw:

- `sale_depletion_effects` — exact `toEqual` match against the pre-call snapshot: the two `lo` rows the INSERT statement itself actually wrote **do not survive**, because the containing `logging.$transaction(...)` (the exact same mechanism `PrismaService.withAuthContext` uses) never commits.
- `stock_movements`, `sale_depletion_allocations` — both empty, exact match against pre-call snapshots.
- `stock_batches.quantity_remaining` for both `lo` and `hi` — unchanged (`Prisma.Decimal.equals`).

**PARTIAL INSERT ROLLBACK: PASS.**

## 7. Lock-before-reservation-validation proof

`test/sale-depletion-effect-reservation.e2e-spec.ts`, "FIRST triple conflicts": `jest.spyOn(fifoCostLedger, 'lockLayers')` (same technique `sale-depletion-lock-grouping.e2e-spec.ts` already uses — calls through to the real implementation, a genuine Postgres `FOR UPDATE`, never mocked) is installed before a call whose **first**-sorted triple conflicts. After the call throws, `expect(spy).not.toHaveBeenCalled()` passes: **zero** `SELECT … stock_batches … FOR UPDATE` acquisitions occurred. Combined with §6's proof that zero Inventory mutation survives, and the "MIDDLE"/"LAST"/"MULTIPLE conflicts" tests (which also assert zero movements/allocations), this demonstrates conflict detection strictly precedes every Inventory lock and mutation, for a conflict occurring anywhere in the sorted triple sequence — not only at the first position.

**INVENTORY LOCK BEFORE RESERVATION VALIDATION: NO** (no lock occurs before validation). **INVENTORY MUTATION BEFORE RESERVATION VALIDATION: NO.**

## 8. Identity-based conflict detection — first / middle / last / multiple

Four dedicated tests, each pre-inserting a real conflicting `sale_depletion_effects` row at a different position in a 2- or 3-triple sorted sequence:

- **FIRST** (of 2, on the alphabetically-lower stock item) — conflict detected, zero mutation.
- **MIDDLE** (of 3, same stock item) — conflict detected, zero mutation.
- **LAST** (of 3, same stock item) — conflict detected, zero mutation.
- **MULTIPLE** (2 of 3 pre-exist) — the thrown message is asserted to contain **both** conflicting order-line ids and the literal `"2 of 3"` — proving every missing identity is reported, not only the first.

**IDENTITY-BASED CONFLICT DETECTION: PASS. MULTIPLE CONFLICT REPORTING: PASS.**

## 9. Weighted-average cost hoist — batching and default-semantics proof

Three tests, all using the same query-event-logging `PrismaClient` as §4:

1. **Three effects on the same weighted-average stock item** (across 3 order lines, `average_cost` pre-set to `1500`) — all three allocations resolve to `unitCost = 1500n`, and exactly **one** statement matching `"inventory"."stock_levels"` + `average_cost` + `SELECT` appears in the query log for the whole call (not three).
2. **A weighted-average item with no `stock_levels` row at all** — the resulting allocation's `unitCost` is `0n`, matching `currentAverageCost`'s pre-A1-3A `level?.averageCost ?? 0n` default exactly.
3. **A FIFO item alongside a weighted-average item in the same call** — the FIFO allocation's `unitCost` (`777n`) comes from its real cost-basis batch (`costBasisBatchId !== null`); the weighted-average allocation's `unitCost` (`1500n`) comes from the hoisted map (`costBasisBatchId === null`) — proving cost-strategy selection is unaffected by the hoist.

**WEIGHTED-AVERAGE READS BEFORE: 45** (fixture value, design gate §4.2). **WEIGHTED-AVERAGE READS AFTER: 1**, confirmed both by this batching test and by the real-fixture statement-count measurement in §10.

## 10. Statement-count measurement — real fixture, real instrumentation

Methodology matches the design gate's own (§4.2/§12 of the design gate report): `ALTER DATABASE … SET log_statement = 'all'` / `log_min_duration_statement = 0` on the same disposable Lane-A database (`ros_lane_a_a11_20260902043434`, port 5555), `test/order-completion-performance.e2e-spec.ts` run **unmodified**, `--runInBand`, the container's Postgres log parsed and grouped into per-backend-PID transactions bounded by `statement: BEGIN` / `statement: ROLLBACK`, settings reset and verified afterward (`pg_db_role_setting` — zero rows).

**All 20 benchmark transactions carried an identical, deterministic statement count: 719 raw log lines per transaction** (including the `BEGIN`/`ROLLBACK` bookkeeping lines themselves, which the design gate's own 895-statement itemization did **not** count as line items). Excluding those two bookkeeping lines for an apples-to-apples comparison against the 895 baseline:

**TOTAL STATEMENTS AFTER: 717** — exactly the design-gate-predicted value (`895 − 134 reservation-INSERTs-removed − 44 average-cost-reads-removed = 717`).

Full breakdown of one representative transaction (all 20 identical):

| Statement shape | Count (A1-2, measured 2026-09-02) | Count (A1-3A, measured 2026-09-03) |
|---|---:|---:|
| `set_config` | 1 | 1 |
| `production.recipe_versions` SELECT | 1 | 1 |
| `production.recipe_lines` SELECT | 1 | 1 |
| `org.locations` SELECT | 1 | 1 |
| `inventory.stock_items` SELECT | 1 | 1 |
| `sale_depletion_effects` reservation INSERT | **135** (per effect) | **1** (whole call, `jsonb_to_recordset`) |
| `stock_batches … FOR UPDATE` (`lockLayers`) | 5 | 5 (unchanged) |
| `stock_batches` physical `UPDATE` | 105 | 105 (unchanged — A1-3B) |
| `stock_batches` accounting `UPDATE` | 60 | 60 (unchanged — A1-3B) |
| `stock_levels` average-cost SELECT | **45** (per effect) | **1** (whole call) |
| `stock_levels` atomic delta INSERT | 135 | 135 (unchanged — A1-3B) |
| `stock_movements` INSERT | 135 | 135 (unchanged — A1-3B) |
| `stock_levels` pointer UPDATE | 135 | 135 (unchanged — A1-3B) |
| `sale_depletion_allocations` INSERT | 135 | 135 (unchanged — A1-3B) |
| **Total (excl. BEGIN/ROLLBACK)** | **895** | **717** |

867 → 178 round trips removed by A1-3A alone (**19.9%** of the original 895); the remaining 674 per-allocation/per-slice statements (A1-3B's target) are completely untouched, exactly as scoped.

**RESERVATION STATEMENTS BEFORE: 135. RESERVATION STATEMENTS AFTER: 1.**
**WEIGHTED-AVERAGE READS BEFORE: 45. WEIGHTED-AVERAGE READS AFTER: 1.**
**TOTAL STATEMENTS BEFORE: 895. TOTAL STATEMENTS AFTER: 717.**

## 11. Performance — NFR-PERF-006, isolation, instrumentation off

`test/order-completion-performance.e2e-spec.ts` run **unmodified**, in isolation, immediately **before** the §10 instrumentation was enabled (so this measurement carries zero statement-logging overhead):

```
NFR-PERF-006: 30 lines, 20 iterations —
p50=369.44ms p95=425.75ms (min=339.09ms max=458.03ms)
all=[458.0,376.0,359.7,425.7,375.0,350.7,409.1,368.9,394.9,372.3,
     367.9,367.3,359.4,378.1,401.7,349.0,400.4,346.9,339.1,369.4]
```

**PERFORMANCE P50: 369.44 ms. PERFORMANCE P95: 425.75 ms.**

Down from A1-2's isolated baseline (`p50=750.45ms / p95=2068.60ms`, `2026-09-02_A1-2_inventory-lock-grouping.md`) — a **~50.8% p50** / **~79.4% p95** reduction from removing 178 round trips, consistent with the design gate's reasoning that round-trip overhead (not server-side execution time) dominates the wall clock. p95 remains **more than double** the 200 ms target: the 674 remaining per-allocation/per-slice statements (A1-3B's scope) are still the dominant cost, exactly as the design gate predicted.

**NFR-PERF-006: PARTIAL / VERIFIED-FAILING** (unchanged classification — improved, not met). A1-3A's own acceptance criterion is correctness + a measured, meaningful round-trip reduction, not the 200 ms gate (design gate §13/§16.1).

## 12. Exact-decimal and semantic-equivalence evidence

- `test/sale-depletion-lock-grouping.e2e-spec.ts` — **passes unmodified**, byte-for-byte (5/5 tests), including its `Prisma.Decimal.equals` assertions on `stock_batches.quantity_remaining`, `fifo_cost_quantity_consumed`, `stock_movements.balance_after`/`quantity`, and `stock_levels.quantity_on_hand`. Per the design gate's own §16.3 acceptance criterion, this is the direct proof that A1-3A's persisted outputs are semantically identical to A1-2's for identical input — `ord` (the reservation payload's row order) is, by construction, the same `stockItemId ASC, orderLineId ASC` sequence A1-2 already walked, so nothing about the write shape downstream of the reservation changed.
- `test/inventory-exact-decimal-callers.e2e-spec.ts` — 7/7 pass in isolation (a transient timeout occurred only when this suite was batched with ten other Nest-app-bootstrapping suites in one process under DB load immediately after the §10 instrumentation run; re-run alone, it is clean — not a regression, see §14).
- `test/movements-concurrency.e2e-spec.ts` — 6/6 pass; `MovementsService.post` is untouched by this slice.

**EXACT DECIMAL: PASS. A1-2 PHYSICAL/ACCOUNTING SEMANTICS: PRESERVED.**

## 13. Concurrency

Design gate §7.5/§7.6 reasoning re-confirmed unchanged by inspection: `sale_depletion_effects` still has exactly one product writer (`SaleDepletionService`); its reservation key `(tenant_id, order_line_id, stock_item_id, location_id)` is still order-scoped, so two different orders never contend on it; a duplicate Completion of the *same* order now fails strictly before any Inventory lock (§7 above) instead of after, which is strictly safer, not a new ordering risk. No retry loop, no `SKIP LOCKED`, no process mutex were added anywhere in this diff (confirmed by `grep` over the changed file — none of those strings appear).

Existing concurrency suites run unchanged and green:

- `test/order-completion-concurrency.e2e-spec.ts` — pass
- `test/order-completion-concurrency-2.e2e-spec.ts` — pass
- `test/movements-concurrency.e2e-spec.ts` — pass
- `test/cash-movements-close-and-payment-concurrency.e2e-spec.ts` — pass

**CONCURRENCY: PASS.**

## 14. Full targeted test results (this session)

| Suite | Result |
|---|---|
| `src/modules/module-boundaries.spec.ts` | 45/45 pass |
| Full unit suite (`npx jest`, no DB) | 815/815 pass (60 suites) |
| `test/sale-depletion-lock-grouping.e2e-spec.ts` | 5/5 pass, unmodified |
| `test/sale-depletion-effect-reservation.e2e-spec.ts` (new, A1-3A-specific) | 10/10 pass |
| `test/order-completion.e2e-spec.ts` | pass |
| `test/order-completion-structural.e2e-spec.ts` | pass |
| `test/order-completion-pinning.e2e-spec.ts` | pass |
| `test/order-completion-rls.e2e-spec.ts` | pass |
| `test/order-completion-concurrency.e2e-spec.ts` | pass (15/15 combined with -2 below) |
| `test/order-completion-concurrency-2.e2e-spec.ts` | pass |
| `test/movements-concurrency.e2e-spec.ts` | pass |
| `test/inventory-exact-decimal-callers.e2e-spec.ts` | 7/7 pass in isolation |
| `test/cash-movements-close-and-payment-concurrency.e2e-spec.ts` | 34/34 pass |
| `test/order-completion-performance.e2e-spec.ts` | pass, see §11 |

One combined run (11 e2e suites batched in a single `--runInBand` process, run back-to-back with no gap after the §10 instrumentation had just hammered the same database with 20 heavy transactions) hit a single `beforeAll` hook timeout in `inventory-exact-decimal-callers.e2e-spec.ts` (Nest app bootstrap exceeded the default 5000 ms hook timeout under that load) — re-run alone immediately after, that same suite passed 7/7 cleanly. Not attributed to this diff: `SaleDepletionService`'s changed code path is not exercised by that suite's `beforeAll` at all (it fails before any test body runs), and the same suite is clean in every other configuration tried in this session.

## 15. Static verification

| Check | Result |
|---|---|
| `git diff --check` | Clean |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` — schema file untouched |
| `npx tsc --noEmit -p .` (no `typecheck` npm script exists in this package; this is the same equivalent A1-1/A1-2 used) | Clean except the pre-existing, unrelated `access-token.service.spec.ts:28` `TS2322` (present at the starting HEAD too; Lane A does not edit Identity) |
| `npm test` (unit) | 815/815 pass |
| `module-boundaries` | 45/45 pass |
| `npm run openapi:check` | Clean — `docs/api/openapi.json`/`.yaml` regenerated byte-identical, `git diff --exit-code` passed |
| `npx eslint` on both changed files | Zero errors (an initial prettier-formatting pass on the new test file was auto-fixed with `--fix`, then re-verified clean) |

No new lint errors attributable to A1-3A anywhere in the touched files; no unrelated historical lane lint was inspected or touched.

## 16. Database safety

All work in this session used the pre-existing disposable Lane-A database (`ros_lane_a_a11_20260902043434`, `ros-postgres-lane-a`, port 5555) already in use for A1-1/A1-2/A1-3 — the same methodology the design gate used, per the task's §15. **No new probe/scratch database was created or dropped this session** (unlike the design gate, which needed a second throwaway database for two-session concurrency probes — A1-3A's concurrency claims are re-confirmed by inspection plus the existing, unmodified concurrency suites, not by new two-session probes). The persistent `ros` database (port 5544) was never connected to — confirmed by every connection string used in this session (`.env`'s `DATABASE_URL`/`APP_DATABASE_URL`, both port 5555).

Temporary instrumentation used for §10: `ALTER DATABASE ros_lane_a_a11_20260902043434 SET log_statement = 'all'` and `SET log_min_duration_statement = 0`, both `RESET` immediately after log capture; `pg_db_role_setting` queried afterward and confirmed **zero rows** (no per-database settings remain). Two throwaway probe test files (`test/zz-probe-jsonb.e2e-spec.ts`, `test/zz-probe-query-events.e2e-spec.ts`) were created to hard-check the JSONB binding path and query-event-log mechanism before committing to the real committed test suite's design; both were deleted before this report/commit — `git status --short --untracked-files=all` at the time of the implementation commit shows only the two files listed in §2.

**PERSISTENT `ros` TOUCHED: NO.**

## 17. Requirement disposition

| Requirement (task §3–§13) | Disposition |
|---|---|
| One set-oriented reservation statement for the whole call | **MET** — §3.3 |
| Reservation hoisted before every Inventory lock/mutation | **MET** — §7 |
| Real Prisma `TransactionClient`/`$queryRaw` JSONB binding proven | **MET** — §4 |
| Exact numeric transport (string, never JS float) | **MET** — §3.3, quantities carried as the pre-existing string field |
| Effect ids generated in JS with `newId()` | **MET** — §3.3 |
| Identity-based (not cardinality) conflict detection | **MET** — §3.4, §8 |
| All-conflicts reporting, not just the first | **MET** — §8 (MULTIPLE test) |
| Duplicate request identity fails closed | **MET** — §5 |
| Transaction rollback of partial reservation | **MET** — §6 |
| Zero lock/mutation before reservation validated | **MET** — §7 |
| Weighted-average cost hoisted to one lookup | **MET** — §3.5, §9 |
| Missing `stock_level` → same zero-default semantics | **MET** — §9 (test 2) |
| FIFO/standard items unaffected by the hoist | **MET** — §9 (test 3) |
| A1-1/A1-2 invariants preserved (§2 of the task) | **MET** — §1, §12 |
| No A1-3B scope creep | **MET** — §1, verified by diff inspection against the task's §18 stop-list |
| Statement-count gate measured, not asserted | **MET** — §10 |
| Performance measured honestly, no COMPLETE claim without p95≤200ms | **MET** — §11, correctly reported PARTIAL |

## 18. Remaining A1-3B work (not started, not implied complete)

Per design gate §16.1's second slice, entirely untouched by this session:

- Aggregate the physical `stock_batches` `UPDATE` per group (`GROUP BY` inside the statement — the design gate's §8.1 mandatory-aggregation finding).
- Aggregate the accounting `stock_batches` `UPDATE` per group, including the §9.2 carry-forward flush rule.
- Collapse the per-allocation `stock_levels` delta + `stock_movements` INSERT into one per-group CTE with the window-function `balance_after` fold (design gate §5.4/§6).
- Collapse the per-allocation pointer `UPDATE` + `sale_depletion_allocations` INSERT into one per-group CTE (design gate §5.6).
- Delete `writeAllocation`'s four per-slice statements.
- Re-run `sale-depletion-lock-grouping.e2e-spec.ts` and both `order-completion-concurrency` suites **unmodified** against the A1-3B shape (design gate §16.1 acceptance criteria).
- Only after A1-3B is `NFR-PERF-006`'s literal 200 ms p95 gate expected to be reachable (design gate §11: projected ~28 total statements, ~84 protocol messages).

## 19. Commits

Implementation commit (this session): `perf(inventory): batch depletion effect reservation`.
Report/index commit (this session, following): `docs: record batched depletion reservation`.

No push. No deploy. No rebase.
