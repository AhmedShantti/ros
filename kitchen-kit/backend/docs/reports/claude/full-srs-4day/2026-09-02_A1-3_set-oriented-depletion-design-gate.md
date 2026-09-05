# A1-3 — Set-Oriented Depletion Write Design Gate (P1-PERF, Lane A)

| Field | Value |
|---|---|
| **Task / slice name** | `P1-PERF` / `A1-3` — design gate for a set-oriented replacement of `SaleDepletionService`'s per-allocation write pattern |
| **Lane** | A — Performance + Inventory Concurrency |
| **Report type** | **Design gate + SQL feasibility probes + report only.** No product implementation, no schema change, no migration, no public API change. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records a design analysis and the probe results actually executed **in this session** against the repository at the HEAD below. It ratifies nothing and authorises no decision beyond recording this gate's own conclusion. Where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `897333bbbfc32861a1094e9e5606a54087c9c66c` — *perf(inventory): group depletion layer locks* |
| **Branch** | `full-srs/lane-a-perf-inventory` |
| **Worktree** | `/Users/mac/projects/ros-worktrees/lane-a` |
| **Working tree at start** | Clean, verified via `git status --short --untracked-files=all` (empty output). |
| **Working tree at end** | This report + one `INDEX.md` row only. **Zero product-code, schema, migration or contract changes.** |
| **Task identifier** | A1-3 / full-srs-4day / lane-a |
| **Status** | **DESIGN GATE COMPLETE — APPROVE A1-3 IMPLEMENTATION.** `NFR-PERF-006` itself is untouched by this session and remains **PARTIAL / VERIFIED-FAILING**. |

---

## 1. Purpose and scope

`NFR-PERF-006` (SRS p.61, re-read verbatim this session via `pdftotext -layout`, line 3020-3022):

> *"Recipe expansion and inventory depletion for a completed order of up to 30 lines SHALL complete within 200 ms at p95 and SHALL execute within the order's transaction."*

A1-2 (accepted, HEAD `897333b`) removed one class of round trips — redundant `lockLayers` acquisitions, 135 → 5 on the benchmark fixture — and improved the isolated benchmark p95 from 4381.62 ms to 2068.60 ms. The requirement is still failing, and A1-2's own §18 named the remaining dominant cost as *the large number of sequential DB writes*.

This session **does not implement anything**. It answers one question with evidence:

> Can the current per-allocation write pattern (`stock_levels` atomic delta → movement `INSERT` → pointer `UPDATE` → allocation `INSERT`, once per zipped slice) be replaced by a set-oriented design that materially reduces round trips **while keeping every per-movement `balance_after` exactly truthful**?

**Answer: yes, proven with executed SQL against the real schema. Gate APPROVED.**

## 2. Material read before designing

- `ROS_SRS_v1.0.pdf` — `NFR-PERF-006` (l.3020), `BR-INV-003` (l.2003), `BR-CORE-003` (l.1627), `FR-INV-030` (l.2888), `FR-INV-012`/`FR-INV-013`/`FR-INV-014` (l.2835-2853).
- `docs/reports/claude/full-srs-4day/2026-09-02_A1-1_inventory-write-path-correctness.md`
- `docs/reports/claude/full-srs-4day/2026-09-02_A1-1_inventory-write-path-acceptance-correction.md`
- `docs/reports/claude/full-srs-4day/2026-09-02_A1-2_inventory-lock-grouping.md`
- `src/modules/inventory/sale-depletion/sale-depletion.service.ts` (575 lines, read in full)
- `src/modules/inventory/costing/fifo-cost-ledger.ts` (180 lines, read in full)
- `src/modules/inventory/movements/movements.service.ts` (381 lines, read in full)
- `prisma/schema.prisma` — `StockBatch`, `StockMovement`, `StockLevel`, `SaleDepletionEffect`, `SaleDepletionAllocation`
- `prisma/migrations/20260817090000_inventory_partition_rls/migration.sql` (partition-level RLS + `REVOKE UPDATE, DELETE, TRUNCATE ... FROM ros_app`)
- `src/prisma/prisma.service.ts` + `src/common/domain-events/unit-of-work.ts` — the Completion transaction is opened by `UnitOfWork.execute` **with no `isolationLevel`**, i.e. PostgreSQL default **READ COMMITTED**, `maxAttempts = 1` (no serialization retry). This is load-bearing for §7.
- `test/order-completion-performance.e2e-spec.ts` (the `NFR-PERF-006` fixture) and `test/sale-depletion-lock-grouping.e2e-spec.ts`, `test/order-completion-concurrency*.e2e-spec.ts`, `test/movements-concurrency.e2e-spec.ts`.

### 2.1 Database-enforced invariants discovered this session (not previously recorded in a Lane-A report)

Read live from the Lane-A database (`pg_constraint`, `pg_trigger`):

| Relation | Constraint | Definition |
|---|---|---|
| `stock_batches` | `ck_batch_qty_nonneg` | `quantity_remaining >= 0` |
| `stock_batches` | `ck_batch_qty_within_received` | `quantity_remaining <= quantity_received` |
| `stock_batches` | `ck_batch_cost_qty_range` | `fifo_cost_quantity_consumed >= 0 AND fifo_cost_quantity_consumed <= quantity_received` |
| `stock_movements` | `ck_movement_quantity_nonzero` | `quantity <> 0` |
| `stock_levels` | *(none)* | negative `quantity_on_hand` is permitted — `FR-INV-014` |
| all `inventory.*` | *(no user triggers at all)* | verified via `pg_trigger` where `NOT tgisinternal` |

This matters for the gate: **a set-oriented aggregation bug cannot silently corrupt batch state — the database rejects it and the whole Completion rolls back.** Proven in probe P3 §12.3.

## 3. Hard invariants this design must preserve

The 15 invariants from the task statement, restated with where each is discharged in this report:

| # | Invariant | Discharged in |
|---|---|---|
| 1 | Whole-completion depletion stays inside the Order transaction | §5 (no statement leaves `tx`) |
| 2 | Effect reservation/idempotency before Inventory mutation | §10 — **strengthened**: now strictly before *every* lock and mutation |
| 3 | Global stock-key lock order deterministic | §7.3 — unchanged from A1-2 |
| 4 | Physical batch selection FIFO/FEFO per item strategy | §8 — planner untouched |
| 5 | Accounting valuation FIFO by receipt order | §9 — planner untouched |
| 6 | Physical and accounting axes independent | §8/§9, probe P3 §12.3 |
| 7 | Carry-forward cost provenance truthful | §9.2 — **new mandatory flush rule**, probe P7 §12.7 |
| 8 | Exact Decimal/Rational arithmetic, no persisted JS float | §6.4, probe P1 §12.1 |
| 9 | `stock_levels.quantity_on_hand` equals exact movement fold | §6, probes P2/P5 §12.2/§12.5 |
| 10 | Every `balance_after` truthful for THAT movement | §6 — the whole of it |
| 11 | Movement ordering deterministic | §6.2 |
| 12 | Movements append-only | §5.6, probe P8 §12.8 (`ros_app` `UPDATE` denied) |
| 13 | Allocation provenance reconstructible | §5.6, probe P5 §12.5 |
| 14 | Concurrent completions serialize to a valid serial execution | §7, probes P6a/P6b §12.6 |
| 15 | No `SKIP LOCKED`, no process-local mutex, no post-commit repair | §5 — none appear anywhere in the design |

## 4. Current architecture after A1-2, and the bottleneck — **measured, not estimated**

### 4.1 What A1-2 left

Per call: resolve location, load stock items, flatten + sort `triples` by `(stockItemId ASC, orderLineId ASC)`. Then for **every** triple, in that order:

1. `INSERT ... sale_depletion_effects ... ON CONFLICT DO NOTHING RETURNING id` — reservation (1 statement per effect).
2. `lockLayers` — **only when the `(stockItemId, locationId)` group key changes** (A1-2).
3. `planPhysicalConsumption` in memory, then **one `UPDATE stock_batches SET quantity_remaining = ... - $1` per physical slice**, then `evolvePhysicalState` in memory.
4. Cost axis: either one `SELECT stock_levels.average_cost` (weighted-average), or nothing (standard), or `planFifoCostConsumption` + **one `UPDATE stock_batches SET fifo_cost_quantity_consumed = ... + $1` per cost slice** + `evolveAccountingState`, plus `findCarryForwardBasis` on shortfall.
5. Zipper, then **per zipped slice, four statements** in `writeAllocation`: `stock_levels` upsert (atomic delta, `RETURNING quantity_on_hand`) → `stock_movements` `INSERT` → `stock_levels` pointer `UPDATE` → `sale_depletion_allocations` `INSERT`.

### 4.2 Measured statement inventory (this session, real instrumentation)

`log_statement='all'` was enabled on the disposable Lane-A database, `test/order-completion-performance.e2e-spec.ts` was run unmodified (`--runInBand`), the PostgreSQL log was parsed by backend PID and grouped into transactions, and the setting was reset afterwards (§12.9 confirms the reset). **All 20 benchmark transactions contained exactly 895 executed statements — identical, not an average:**

```
statements per benchmark transaction: [895, 895, 895, 895, 895, 895, 895, 895, 895, 895,
                                       895, 895, 895, 895, 895, 895, 895, 895, 895, 895]
```

| Statement shape | Count / completion tx | Scope |
|---|---:|---|
| `set_config('app.user_id',…)` | 1 | per call (RLS context) |
| `SELECT … production.recipe_versions …` | 1 | per call (`planConsumption`) |
| `SELECT … production.recipe_lines …` | 1 | per call (`planConsumption`) |
| `SELECT org.locations.id …` | 1 | per call |
| `SELECT … inventory.stock_items …` | 1 | per call |
| `INSERT … sale_depletion_effects … ON CONFLICT DO NOTHING` | **135** | per effect |
| `SELECT … stock_batches … FOR UPDATE` (`lockLayers`) | **5** | per stock key (A1-2) |
| `UPDATE stock_batches SET quantity_remaining = …` | **105** | per physical slice |
| `UPDATE stock_batches SET fifo_cost_quantity_consumed = …` | **60** | per cost slice |
| `SELECT … stock_levels …` (`currentAverageCost`) | **45** | per weighted-average effect |
| `INSERT … stock_levels … ON CONFLICT DO UPDATE` (atomic delta) | **135** | per allocation |
| `INSERT … stock_movements …` | **135** | per allocation |
| `UPDATE stock_levels SET last_movement_id = …` | **135** | per allocation |
| `INSERT … sale_depletion_allocations …` | **135** | per allocation |
| **Total** | **895** | |

Fixture shape confirmed by the same log: **135 logical depletion effects** (30 lines × 4 base components + 15 modifier components) across **5 distinct stock keys**, **135 allocations** (one zipped slice per effect), 105 physical slices, 60 FIFO cost slices, 45 weighted-average lookups.

### 4.3 Where the time actually goes — **measured**

A second instrumented run with `log_min_duration_statement = 0` (durations for `parse`/`bind`/`execute`) gave, per completion transaction:

| Metric | Value |
|---|---|
| Executed statements | **895** |
| Wire-protocol messages (`parse` + `bind` + `execute`, unnamed prepared statements) | **2,685** |
| **Server-side execution time**, p50 | **119.6 ms** |
| **Server-side execution time**, p95 | **149.6 ms** |
| Wall-clock (test's own `hrtime` measurement), p50 | **464.85 ms** |
| Wall-clock, p95 | **608.24 ms** |

Server-side cost by statement shape (one representative transaction, ms of PostgreSQL execution time summed over `parse`+`bind`+`execute`):

```
INSERT ... stock_levels (atomic delta)          135 execs    32.63 ms
INSERT ... sale_depletion_effects               135 execs    28.44 ms
INSERT ... stock_movements                      135 execs    28.27 ms
INSERT ... sale_depletion_allocations           135 execs    27.56 ms
UPDATE  ... stock_levels (pointer)              135 execs    26.53 ms
UPDATE  ... stock_batches (quantity_remaining)  105 execs    14.36 ms
UPDATE  ... stock_batches (fifo_cost_consumed)   60 execs     7.37 ms
SELECT  ... stock_levels (average cost)          45 execs     4.14 ms
SELECT  ... stock_batches FOR UPDATE              5 execs     0.85 ms
SELECT  ... org.locations                         1 exec      0.47 ms
SELECT  ... production.recipe_lines               1 exec      0.39 ms
SELECT  ... inventory.stock_items                 1 exec      0.23 ms
SELECT  ... production.recipe_versions            1 exec      0.18 ms
SELECT  set_config(...)                           1 exec      0.11 ms
```

### 4.4 Bottleneck statement inventory — the conclusion this gate rests on

1. **Round-trip / driver overhead dominates, not database work.** ~120-150 ms of the 465-608 ms wall clock is PostgreSQL execution. **~75-80 % of the elapsed time is the cost of issuing 895 statements (2,685 protocol messages) sequentially through Prisma over a socket** — per-statement parse/plan, parameter serialisation, Node event-loop hops. That is precisely and only what a set-oriented rewrite removes.
2. **`planConsumption` (recipe expansion) is not a factor.** It is **2 statements, 0.57 ms of server time**. The entire `NFR-PERF-006` budget is spent in the Inventory write path. Nothing in the recipe-expansion half needs optimising for this requirement.
3. **The per-allocation quartet is the single biggest block** — 540 of 895 statements (60 %) and 115 ms of the 120 ms server time.
4. **The reservation loop is the second biggest** — 135 statements, 28 ms.
5. **`lockLayers` is already negligible** — 5 statements, 0.85 ms. A1-2 finished that job; there is nothing left there.

> **Note on comparability.** The wall-clock figures in §4.3 are from **instrumented** runs (full statement logging enabled) on a machine that is measurably less loaded than during the A1-2 session, and are **not** a re-baseline of A1-2's isolated `p50=750.45 / p95=2068.60 ms`. They are reported here only to source the *ratio* of server time to wall time and the *statement counts*, both of which are load-independent. Under either measurement, `NFR-PERF-006` is failing: 504-608 ms p95 ≫ 200 ms.

## 5. Proposed A1-3 SQL architecture

Everything below stays inside the caller's `Prisma.TransactionClient`. Nothing is deferred, retried, repaired post-commit, or run outside the Order transaction.

Notation: **D** = number of distinct `(tenant_id, stock_item_id, location_id)` groups; **N** = number of logical effects; **A** = number of zipped allocations.

### 5.0 Payload transport — how variable-length data reaches SQL

Every multi-row statement takes **one `jsonb` parameter**, cast `::jsonb`, expanded by `jsonb_to_recordset(...)`. **Every decimal and every 64-bit integer is carried as a JSON *string* and cast in SQL (`v.qty::numeric`, `v.unit_cost::bigint`)** — never as a JSON number. That removes any possibility of a JavaScript `number` touching a persisted quantity or cost (`BR-CORE-003`), and it keeps the statement text constant regardless of row count (one prepared plan, not a new plan per cardinality).

Rejected transports and why: `VALUES` lists (statement text varies with row count → a new plan per order shape); Prisma `createMany` (**no ordering guarantee, no window function, no `RETURNING` of a computed column** — cannot produce `balance_after` at all); parallel `unnest(a,b,c)` arrays (Prisma's array-parameter binding for `uuid[]`/`numeric[]` is not exercised anywhere in this repo and would need its own probe; JSONB needs none).

### 5.1 Phase 0 — resolve (unchanged, 4 statements)

`set_config`, `planConsumption`'s two reads, the location lookup, the `stock_items` lookup, and the in-memory flatten + sort of `triples` by `(stockItemId ASC, orderLineId ASC)`. Byte-identical to today.

### 5.2 Phase 1 — ONE reservation statement for the whole call (1 statement)

```sql
WITH req AS (
  SELECT v.ord,
         v.effect_id::uuid       AS effect_id,
         v.order_line_id::uuid   AS order_line_id,
         v.stock_item_id::uuid   AS stock_item_id,
         v.quantity::numeric     AS quantity,
         v.unit_id::uuid         AS unit_id
  FROM jsonb_to_recordset($1::jsonb)
       AS v(ord int, effect_id text, order_line_id text,
            stock_item_id text, quantity text, unit_id text)
)
INSERT INTO "inventory"."sale_depletion_effects"
  ("id","tenant_id","order_id","business_day","order_line_id",
   "stock_item_id","location_id","quantity_in_base_unit","unit_id","created_at")
SELECT req.effect_id, $2::uuid, $3::uuid, $4::date, req.order_line_id,
       req.stock_item_id, $5::uuid, req.quantity, req.unit_id, $6::timestamptz
FROM req
ORDER BY req.ord
ON CONFLICT ("tenant_id","order_line_id","stock_item_id","location_id") DO NOTHING
RETURNING "id","order_line_id","stock_item_id";
```

Detection strategy — see §10. Probe P4 (§12.4) proves both the conflict and the no-conflict path.

### 5.3 Phase 2 — per group, in `stockItemId ASC` order

For each of the **D** groups, in the same order A1-2 already establishes:

**2a — lock (1 statement).** `lockLayers(tx, tenantId, stockItemId, locationId)` — the **existing kernel function, unmodified**: `SELECT … FROM stock_batches WHERE … ORDER BY created_at ASC, id ASC FOR UPDATE`, no `SKIP LOCKED`. Same SQL, same order, same lock set as A1-2 and as `MovementsService.post`.

**2b — plan every effect in the group, in memory, issuing no writes.** Iterate the group's effects in the pre-existing `orderLineId ASC` order. For each: `planPhysicalConsumption` → `evolvePhysicalState`; `planFifoCostConsumption` → `evolveAccountingState`; zipper. **These are A1-2's already-accepted, already-tested pure functions, used unchanged.** A1-2 §16 proved the evolved working state is bit-for-bit equivalent to re-reading the locked rows. Accumulate four things:

- `physicalDeltas: Map<batchId, Rational>`
- `accountingSlices: CostSlice[]` (pending, not yet written — see the flush rule in §9.2)
- `movementRows[]` and `allocationRows[]` in **`ord` order** (§6.2)
- `groupDelta: Rational` — the exact sum of all zipped slice quantities in the group

**2c — physical batch axis (1 statement, §8).**
**2d — accounting axis (1 statement, §9).**
**2e — `stock_levels` group delta + all movements (1 statement, §6).**
**2f — pointer + all allocations (1 statement, §5.6).**

Statement order within a group is `2a → 2c → 2d → 2e → 2f`, which preserves today's relative order of *lock acquisition on `stock_batches` before lock acquisition on `stock_levels`* — the property §7.4 depends on.

### 5.4 Per-group statement 2e — the core (see §6 for the proof)

```sql
WITH lvl AS (
  INSERT INTO "inventory"."stock_levels"
    ("tenant_id","stock_item_id","location_id","quantity_on_hand")
  VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric)          -- $4 = groupDelta (signed)
  ON CONFLICT ("stock_item_id","location_id") DO UPDATE
    SET "quantity_on_hand" =
        "inventory"."stock_levels"."quantity_on_hand" + EXCLUDED."quantity_on_hand"
  RETURNING "quantity_on_hand" - $4::numeric AS start_balance
),
src AS (
  SELECT v.ord,
         v.movement_id::uuid AS movement_id,
         v.batch_id::uuid    AS batch_id,
         v.qty::numeric      AS qty,                          -- SIGNED, negative for depletion
         v.unit_cost::bigint AS unit_cost,
         v.total_cost::bigint AS total_cost,
         lvl.start_balance
           + SUM(v.qty::numeric) OVER (ORDER BY v.ord
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance_after
  FROM jsonb_to_recordset($5::jsonb)
       AS v(ord int, movement_id text, batch_id text, qty text,
            unit_cost text, total_cost text),
       lvl
)
INSERT INTO "inventory"."stock_movements"
  ("id","occurred_at","tenant_id","location_id","stock_item_id","batch_id","movement_type",
   "quantity","unit_id","unit_cost","total_cost","balance_after",
   "reference_type","reference_id","performed_by")
SELECT src.movement_id, $6::timestamptz, $1::uuid, $3::uuid, $2::uuid, src.batch_id,
       'sale_depletion', src.qty, $7::uuid, src.unit_cost, src.total_cost, src.balance_after,
       'order', $8::uuid, $9::uuid
FROM src;
```

### 5.5 Rejections within the proposed architecture

The task's target architecture (§5 A-G) is adopted **except** for two collapses that were considered and are **deliberately rejected**, with the narrowest safe alternative kept:

**Rejected — collapsing all D groups into one movement statement** (`PARTITION BY stock_item_id` over a multi-row `stock_levels` upsert). It is expressible, but the multi-row `INSERT … ON CONFLICT DO UPDATE` would acquire `stock_levels` row locks **in whatever order PostgreSQL happens to process the feeding `SELECT`'s output**. `ORDER BY` inside an `INSERT … SELECT` is not a documented guarantee of *lock-acquisition* order, and §6 of this gate's own charter forbids relying on undocumented ordering. It would also entangle the per-group carry-forward flush (§9.2) across independent keys. The saving is 4 statements out of 28 — against 867 already removed. **Kept: one movement statement per group**, where the `stock_levels` lock is taken by a single-row upsert in the explicit, JS-controlled `stockItemId ASC` group loop.

**Rejected — merging the physical and accounting batch `UPDATE`s into one statement** (a `FULL OUTER JOIN` of the two aggregates with `COALESCE(…,0)`). It saves at most D statements (5 here, 0.05 ms of server time), and it would put the two deliberately independent axes (`D-INV-03`, `P1F2E-A` §E) into one expression where a `COALESCE` slip could leak one axis into the other. **Kept: two statements, one per axis**, so the independence stays visible in the code, in `EXPLAIN`, and in any statement log.

### 5.6 Per-group statement 2f — pointer + allocations, one round trip

```sql
WITH src AS (
  SELECT v.ord, v.effect_id::uuid AS effect_id, v.seq,
         v.allocation_id::uuid AS allocation_id, v.movement_id::uuid AS movement_id,
         v.physical_batch_id::uuid AS pb, v.cost_basis_batch_id::uuid AS cb,
         v.qty::numeric AS qty, v.unit_cost::bigint AS uc, v.total_cost::bigint AS tc
  FROM jsonb_to_recordset($1::jsonb) AS v(ord int, effect_id text, seq int,
       allocation_id text, movement_id text, physical_batch_id text,
       cost_basis_batch_id text, qty text, unit_cost text, total_cost text)
),
ptr AS (
  UPDATE "inventory"."stock_levels" l
     SET "last_movement_id"          = (SELECT movement_id FROM src ORDER BY ord DESC LIMIT 1),
         "last_movement_occurred_at" = $2::timestamptz
   WHERE l."stock_item_id" = $3::uuid AND l."location_id" = $4::uuid
  RETURNING l."last_movement_id"
)
INSERT INTO "inventory"."sale_depletion_allocations"
  ("id","tenant_id","effect_id","sequence","stock_item_id","location_id","physical_batch_id",
   "cost_basis_batch_id","quantity_in_base_unit","unit_id","unit_cost","total_cost",
   "movement_id","movement_occurred_at","created_at")
SELECT src.allocation_id, $5::uuid, src.effect_id, src.seq, $3::uuid, $4::uuid,
       src.pb, src.cb, src.qty, $6::uuid, src.uc, src.tc,
       src.movement_id, $2::timestamptz, $2::timestamptz
FROM src, ptr;
```

- **Allocation provenance is untouched (invariant 13):** one row per zipped slice, each carrying its own `physical_batch_id`, `cost_basis_batch_id`, `sequence`, `quantity_in_base_unit`, `unit_cost`, `total_cost` and `movement_id`. Aggregation happens **only** in the batch `UPDATE`s (§8/§9); it never collapses an allocation row.
- **The pointer collapse is state-equivalent, not an approximation.** Today the pointer is rewritten once per allocation and every intermediate value is immediately overwritten and never read by anything (nothing in the transaction reads `last_movement_id`). Writing only the final value — the last movement in `ord` order — produces the identical committed row.
- **Allocation ids MUST be generated in JS with the repo's `newId()`** (ULID-encoded UUID) and carried in the payload. The probes used `gen_random_uuid()` for convenience only; the implementation must not, or it would break the repo-wide monotonic-id convention.
- **Append-only is unaffected:** `ros_app` has `SELECT, INSERT` on `stock_movements` and its partitions, with `UPDATE, DELETE, TRUNCATE` revoked. Probe P8 (§12.8) confirms an `UPDATE` on the ledger is still refused with `permission denied` while running as `ros_app` — the set-oriented design adds no update path to the ledger.

## 6. `balance_after` proof — the decisive section

### 6.1 The primitive

`balance_after` for movement *k* in a group must equal *(the group's starting on-hand balance)* + *(the sum of deltas 1..k)*. The design derives it in **one** statement from **one** starting balance, computed by a SQL window function over an **explicit** total order.

The starting balance is **never read**. It is *derived from the atomic read-modify-write's own output*:

```
start_balance := (quantity_on_hand AFTER the group upsert) − groupDelta
```

This is the single most important property in the design. `INSERT … ON CONFLICT DO UPDATE … RETURNING` takes the `stock_levels` row lock and applies the delta in one indivisible operation, and its `RETURNING` reports the post-update value. There is therefore **no window at all** in which a concurrently committed writer could make the starting balance stale — because no statement ever observes the starting balance independently of the write that consumes it. §7.2 and probe P6c (§12.6) contrast this against the obvious alternative, which is provably broken.

### 6.2 The explicit total order

`ord` is an integer assigned **in JavaScript**, before the statement is built, as the position in this traversal:

```
for each group g, in stock_item_id ASC (then location_id ASC)     ← A1-2's existing group order
    for each effect e in g, in order_line_id ASC                  ← A1-2's existing within-group order
        for each zipped slice s of e, in zipper emission order     ← the existing `sequence` 0..n-1
            ord := ord + 1
```

`ord` is **reset per group**, because each group has its own independent balance chain on its own `stock_levels` row.

This is **exactly the sequence in which A1-2 executes the same writes today**. The design therefore does not introduce a new ordering; it makes the existing one explicit and machine-checkable. Consequences:

- The SQL says `OVER (ORDER BY v.ord ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`. The frame is stated explicitly rather than relying on the default `RANGE` frame, which would tie rows with equal `ord` together — `ord` is unique by construction, but the explicit `ROWS` frame makes that irrelevant.
- The design relies on **no** unordered `INSERT` behaviour, **no** array order without `ORDER BY`, **no** Prisma `createMany` ordering, and **no** implicit UUID ordering. Probe P1e (§12.1) feeds a deliberately shuffled input array and shows the fold follows `ord`, not array position.
- **Persisted reconstructibility (invariant 11) is unchanged, neither improved nor weakened.** `stock_movements` today has no per-transaction sequence column: every movement in one Completion shares `occurred_at` (`input.occurredAt`) and `recorded_at` (`now()` = transaction start). The persisted total order is reconstructible exactly as it is today — via `sale_depletion_allocations.(effect_id, sequence)` joined to the effects' `(stock_item_id, order_line_id)` ordering, and independently via the `balance_after` chain itself. **A1-3 changes nothing here and requires no schema change to preserve it.**

### 6.3 Worked cases (all executed — §12)

| # | Case required by the charter | Where proven |
|---|---|---|
| 1 | All-negative deltas | P1 (§12.1) — 5 negative deltas, exact chain; P2/P5/P8 on the real schema |
| 2 | Mixed signed deltas | P1b (§12.1) — `−4.5, +7.25, −12.75, +0.000001` folds exactly, including through zero. The primitive is sign-agnostic; **`SaleDepletionService` itself emits only negative deltas**, so mixed signs are proven as generality (and as the shape `MovementsService.post` would need if it were ever set-oriented), not as a path A1-3 takes. |
| 3 | Decimal quantities | P1/P2/P5 — `0.333333`, `1.666667`, `0.000001` at full `DECIMAL(18,6)` scale |
| 4 | Same order, several allocations | P2 (3 allocations in one statement), P5 (3 allocations across 2 effects) |
| 5 | Two order lines for the same stock key | P5 (§12.5) — effect `…6748` (line `…65ff`) contributes `ord` 1-2, effect `…678f` (line `…66c4`) contributes `ord` 3; one continuous chain `−7.333333 → −8.000000 → −8.000001`, one `stock_levels` row, one pointer |
| 6 | FEFO physical while FIFO accounting diverges | P5/P8 — allocation `ord 2` carries `physical_batch_id = b1` with `cost_basis_batch_id = b2` (P8), and P3 (§12.3) applies the two axes as two independent aggregates over **different batch sets** in the same group |

### 6.4 Exactness

Every arithmetic step is PostgreSQL `numeric` (arbitrary-precision decimal) on `DECIMAL(18,6)` columns; no `float8` appears anywhere in the design. Probe P1c/P1d (§12.1) confirms `numeric` summation is exact and that no JSON value is ever routed through a float. On the JavaScript side, quantities remain `Rational`/`toDecimal6` strings exactly as A1-2 left them — the payload is built from the *same* `toDecimal6(slice.quantity)` strings that today's per-allocation statements bind, so **not one arithmetic operation changes**.

## 7. Concurrency and locking proof

Setting: READ COMMITTED (verified — `UnitOfWork.execute` passes no `isolationLevel`, no retry loop). T1 and T2 are two Completions both depleting stock key K.

### 7.1 What is locked, and when

| Step | Lock taken | Notes |
|---|---|---|
| Phase 1 reservation | Row + unique-index entries on `sale_depletion_effects` for every effect of this order | Keyed by `order_line_id`, which is order-scoped, so **two different orders never contend here** |
| 2a `lockLayers(K)` | `FOR UPDATE` on every `stock_batches` row of K eligible on either axis, in `created_at ASC, id ASC` | Unchanged from A1-2. No `SKIP LOCKED`: a racing writer **blocks** |
| 2c/2d batch `UPDATE`s | *(no new lock)* — those rows are already `FOR UPDATE`-held from 2a | |
| 2e `stock_levels` upsert | Row lock on `stock_levels(K)`, taken **and** the delta applied in one operation | This is where the starting balance materialises |
| 2f pointer `UPDATE` | *(no new lock)* — the same `stock_levels(K)` row, already held | |

### 7.2 Why a stale starting balance is structurally impossible

T2 reaches 2e. Two cases, and only two:

- **T1 holds the `stock_levels(K)` row lock.** T2's upsert blocks. When T1 commits, T2's `ON CONFLICT DO UPDATE` re-evaluates against T1's committed row (READ COMMITTED re-reads the updated tuple for a blocked update), adds its own delta, and `RETURNING` reports a value that already contains T1's writes. `start_balance = returned − groupDelta` is therefore T1's committed final balance. Exact.
- **T1 does not hold it yet.** T2's upsert proceeds immediately and T1 blocks later. Same reasoning with the roles swapped.

Either way the two chains are contiguous and non-overlapping, and the last `balance_after` of the later transaction equals the committed `quantity_on_hand`. **There is no third case**, because there is no read of `quantity_on_hand` that is separate from the write that consumes it.

Probe P6a (§12.6) demonstrates case 1 with real clocks (T2 blocked 1.58 s at `lockLayers` and then observed T1's committed batch state `70.000000`, not the stale `100.000000`; chains `190,170` then `168,165`; final projection `165 = 200 − 30 − 5`). Probe P6b demonstrates the same guarantee **with no batch rows at all** — `FOR UPDATE` locks nothing, and serialisation comes from the `stock_levels` upsert alone; chains `47,43` then `39,33`, final `33 = 50 − 7 − 10`. Probe P6c runs the **rejected** shape (plain `SELECT` of the starting balance, then write) under the same race and produces a **provably broken ledger**: the final movement claims `balance_after = 40.000000` while the true projection is `33.000000`. That is the design being rejected, executed and shown to fail.

### 7.3 Deterministic global lock order

Groups are processed in `stockItemId ASC` (then `locationId ASC`) — A1-2's order, unchanged, driven by the JS sort of `triples` and never by map-iteration, recipe traversal or modifier order. Within a transaction the acquisition sequence is:

```
batches(k1) → levels(k1) → batches(k2) → levels(k2) → …    with k1 < k2 < …
```

Two concurrent Completions with any overlapping key set both walk keys ascending, so no cycle can form between them.

### 7.4 Interaction with `MovementsService.post`

`post` acquires, in order: `stock_items` / `locations` / `stock_levels` reads (non-locking), `lockLayers(K)` (**`stock_batches` `FOR UPDATE`**), then the `stock_levels(K)` atomic upsert, then the movement `INSERT`, the `stock_levels` pointer/valuation `UPDATE`, the `stock_batches` physical `UPDATE`s, and `applyCostConsumption`. Its last two write groups touch `stock_batches` rows **it already holds from its own `lockLayers`** — no new lock is acquired after the `stock_levels` lock.

So both writers observe the same relative order — **`stock_batches` before `stock_levels`, per key** — and A1-3 preserves it exactly (§5.3 fixes the `2a → 2c → 2d → 2e` order for this reason). **A1-3 introduces no new ordering inversion against `MovementsService.post`.**

### 7.5 The one ordering change A1-3 does make, and why it is not an inversion

Hoisting reservation (§5.2) means a Completion now holds **all** of its `sale_depletion_effects` index-entry locks *before* it takes any Inventory lock, where today it interleaves them. This is not an inversion because:

- `sale_depletion_effects` has **exactly one writer in the system** — `SaleDepletionService` — so no other transaction can hold an effects lock while waiting on an Inventory lock.
- Its reservation key is `(tenant_id, order_line_id, stock_item_id, location_id)`, and `order_line_id` is order-scoped: **two different orders can never contend on it.** The only contender is a double-Completion of the *same* order, which now fails **before** touching any Inventory row instead of after — strictly better.

**This is flagged here rather than deferred silently:** the *full* completion-vs-`post`-vs-transfer/count/waste deadlock matrix remains A1-4 work (§14), and it must be re-run against the hoisted reservation, not against A1-2's interleaved one.

### 7.6 Serial equivalence

Every mutation of a shared row (`stock_batches`, `stock_levels`) is either performed under a `FOR UPDATE` lock held from the group's `lockLayers`, or is itself an atomic read-modify-write. No mutation is computed from a value read outside the lock that protects it. Two overlapping Completions therefore commit an outcome identical to running them one after the other in the order their `stock_levels(K)` upserts serialised — **`CONCURRENCY SERIAL-EQUIVALENCE: PASS`**, demonstrated in P6a/P6b.

## 8. Physical batch update design

**Yes — one `UPDATE … FROM (aggregate)` per group is safe**, with one mandatory structural rule.

```sql
UPDATE "inventory"."stock_batches" b
   SET "quantity_remaining" = b."quantity_remaining" - agg.q
  FROM (
    SELECT v.batch_id::uuid AS batch_id, SUM(v.qty::numeric) AS q
    FROM jsonb_to_recordset($1::jsonb) AS v(batch_id text, qty text)
    GROUP BY v.batch_id
  ) agg
 WHERE b."id" = agg.batch_id;
```

### 8.1 The mandatory rule: aggregate in SQL, with `GROUP BY`

`UPDATE … FROM` where **two source rows match one target row** applies **only one of them, arbitrarily, and silently.** Probe P3 (§12.3) executes exactly that against the real `stock_batches`: two deltas of `1.000000` and `2.000000` against a batch holding `3.000000` leave `2.000000` — one delta lost, no error, no warning. This is the single most dangerous trap in the whole rewrite, because in this domain *several allocations hitting one batch is the common case*: two order lines consuming the same ingredient from the same FIFO layer, or one effect's physical slice split across cost layers by the zipper.

**Therefore the `GROUP BY` is not an optimisation — it is the correctness mechanism.** Making the aggregation part of the statement means a payload with duplicate batch ids is structurally impossible to mis-apply. (Aggregating in JS with exact `Rational` addition and emitting one row per batch is equally correct arithmetically, but it leaves the hazard one editing mistake away. The `GROUP BY` form is normative for A1-3; a JS-side pre-aggregation may be kept *in addition*, never *instead*.)

### 8.2 What is preserved

- **Exact quantity per batch** — `SUM(numeric)`, no float, verified in P3 (`3.000000 − 0.333333 − 1.666667 = 1.000000`, both deltas applied).
- **No accidental negative batch quantity** — the aggregate can only ever equal the sum of the slices `planPhysicalConsumption` emitted, and that planner caps every take at the layer's `quantityRemaining` in the evolved working state. Belt and braces: `ck_batch_qty_nonneg` rejects any violation and rolls the whole Completion back. Probe P3 §12.3 confirms the CHECK actually fires (`ERROR: new row for relation "stock_batches" violates check constraint "ck_batch_qty_nonneg"`). Intended shortfall semantics (`FR-INV-014`) are unaffected: a shortfall is never a negative batch — it is a `physicalBatchId = NULL` slice, still emitted per allocation exactly as today.
- **Deterministic provenance** — the individual allocation rows are written by §5.6 with their own per-slice quantities and batch ids. Aggregation exists only in the counter update. Probe P5 (§12.5) shows three distinct allocation rows surviving alongside two aggregated batch deltas.
- **FEFO/FIFO selection outcome established while locked** — selection happens in `planPhysicalConsumption` against the `FOR UPDATE`-held, A1-2-evolved working set. Not changed by this design at all.

## 9. Accounting FIFO update design

Same shape, on the independent counter:

```sql
UPDATE "inventory"."stock_batches" b
   SET "fifo_cost_quantity_consumed" = b."fifo_cost_quantity_consumed" + agg.q
  FROM (
    SELECT v.batch_id::uuid AS batch_id, SUM(v.qty::numeric) AS q
    FROM jsonb_to_recordset($1::jsonb) AS v(batch_id text, qty text)
    GROUP BY v.batch_id
  ) agg
 WHERE b."id" = agg.batch_id;
```

### 9.1 Axis independence

The two statements take **different payloads over different batch sets**, exactly as `planPhysicalConsumption` (strategy-ordered, `quantity_remaining`-bounded) and `planFifoCostConsumption` (receipt-ordered, `quantity_received − fifo_cost_quantity_consumed`-bounded) already produce them. Probe P3 §12.3 executes one group where the physical aggregate touches only `b1` and the accounting aggregate touches only `b2`, and both land correctly. `ck_batch_cost_qty_range` fails the transaction closed on any over-consumption of accounting headroom. Carry-forward slices are **excluded** from the accounting payload, exactly as `applyCostConsumption` excludes them today (`evolveAccountingState` already models this) — carry-forward is a valuation reference and must never increment the consumed counter.

### 9.2 MANDATORY: the carry-forward flush rule

This is the one place where naive deferral of the accounting `UPDATE` to the end of the group would be **wrong**, and it is a genuine finding of this gate.

`findCarryForwardBasis` is a real query: *the most recently created layer with `quantity_received − fifo_cost_quantity_consumed = 0`*. Today it runs **after** the current effect's own `applyCostConsumption`, so it correctly sees a layer that this very effect just exhausted. If the accounting `UPDATE` were deferred to the end of the group, the query would run against pre-consumption state and could return a **different, older layer with a different unit cost**.

Probe P7 (§12.7) executes this on real data. Before applying the group's accounting consumption the basis is batch `…656a` at `unit_cost = 100`; after applying it, the basis is batch `…6570` at `unit_cost = 200`. **A different cost basis — a real valuation error, silently different, not a crash.**

Could it be computed in memory from `lockedLayers` instead of a flush? **No.** `lockLayers` deliberately returns only layers eligible on *either* axis (`quantity_remaining > 0 OR headroom > 0`). A layer already exhausted on **both** axes before this Completion began is a legitimate carry-forward basis and is **not in the locked set**. An in-memory computation would therefore be wrong in exactly the case carry-forward exists to serve.

**The rule for A1-3:** before calling `findCarryForwardBasis`, issue the accounting `UPDATE` for everything planned in this group so far *including the current effect's own slices*, then reset the pending accumulator and continue. `findCarryForwardBasis` itself stays **byte-identical**. This costs one extra statement per group **only on the shortfall path** — 0 statements on the `NFR-PERF-006` fixture, which has no FIFO accounting shortfall. It makes the database state at query time identical to the sequential design's state at that same point, which is the definition of equivalence this whole slice is held to.

The physical axis needs no analogous rule: a physical shortfall issues no query, it only emits a `physicalBatchId = NULL` slice.

### 9.3 `currentAverageCost` (weighted-average items)

45 of the 895 statements are `currentAverageCost` reads — one per weighted-average effect. `average_cost` is **never written by `SaleDepletionService`**, so the value cannot change during the call: the read is hoistable to **one** lookup for all non-FIFO groups, before any group is processed, with an identical result. (The `stock_levels` row may not exist yet for such an item; both today's per-effect read and the hoisted read return `0` in that case, including after the group upsert has inserted the row with `average_cost` defaulting to `0`.) This is an incidental, zero-risk win included in the plan.

## 10. Effect reservation design — Option A (one statement), with exact detection

**Adopt option A: one `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING` for the whole call**, placed before every lock and every Inventory mutation.

The gate's three preconditions are met:

1. **Conflict detection remains exact.** The statement `RETURNING`s `(id, order_line_id, stock_item_id)` for every row it actually inserted. The service compares that returned set **by identity** against the requested set — not by cardinality — and throws `SaleDepletionEffectConflictError` naming **every** missing `(orderLineId, stockItemId, locationId)` triple. Detection is strictly more informative than today's per-row check, which reports only the first conflict it reaches.
2. **Duplicate/conflicting effects abort before Inventory mutation.** With reservation hoisted to the front, *no* Inventory row has been read for update or written when the conflict is detected. Today the check happens per effect, so a conflict on effect *k* is detected only after effects *1..k−1* have already mutated `stock_batches`, `stock_levels` and `stock_movements` (harmless, because the transaction rolls back, but strictly weaker). **Invariant 2 is strengthened, not merely preserved.**
3. **A silent skip is impossible.** `ON CONFLICT DO NOTHING` suppresses the *error*, never the *evidence*: a suppressed row is simply absent from `RETURNING`. The set comparison in (1) is what converts that absence into a thrown error. A bare `count(*)` comparison would be adequate arithmetically but is explicitly **not** the specified strategy — identity comparison is, so that a hypothetical duplicate inside the payload itself (two identical triples, which `ON CONFLICT` would collapse) cannot masquerade as a successful reservation.

Probe P4 (§12.4) executes both paths against real data: 3 requested with 2 pre-existing → exactly 1 returned, `must_abort = t`; and, with the conflicting rows removed, 3 requested → 3 returned.

`newId()`-generated effect ids continue to come from the application, as today.

## 11. Round-trip model

Fixture: `test/order-completion-performance.e2e-spec.ts`, 30 lines, 5 distinct stock keys, 135 effects, 135 allocations, 105 physical slices, 60 FIFO cost slices, 45 weighted-average lookups.

| Scope | Statement | BEFORE (measured) | AFTER (projected) |
|---|---|---:|---:|
| per **order** (call) | `set_config` | 1 | 1 |
| per **order** | `planConsumption` reads | 2 | 2 |
| per **order** | location lookup | 1 | 1 |
| per **order** | `stock_items` lookup | 1 | 1 |
| per **order** | effect reservation | **135** *(per effect)* | **1** |
| per **order** | weighted-average cost lookup | **45** *(per effect)* | **1** |
| per **stock key** | `lockLayers` | 5 | 5 |
| per **stock key** | physical `stock_batches` `UPDATE` | **105** *(per physical slice)* | **≤5** (4 here — one group has no physical slices) |
| per **stock key** | accounting `stock_batches` `UPDATE` | **60** *(per cost slice)* | **≤5** (2 here — only FIFO groups) |
| per **stock key** | `stock_levels` delta + movements | **270** *(2 per allocation)* | **5** |
| per **stock key** | pointer + allocations | **270** *(2 per allocation)* | **5** |
| exceptional | carry-forward flush | 0 | +1 per group **only** on FIFO shortfall (0 here) |
| **Total executed statements** | | **895** | **28** |
| Depletion only (excluding `set_config` + `planConsumption`) | | **892** | **25** |
| Wire-protocol messages (`parse`+`bind`+`execute`) | | **2,685** | **~84** |

**Round trips removed: 867 of 895 — a 96.9 % reduction.**

### 11.1 Is there plausible headroom? — yes, and here is the honest reasoning

**No claim of ≤200 ms is made from arithmetic.** What the measurements license is narrower and sufficient for a gate decision:

- Of the ~465-608 ms wall clock, **only ~120-150 ms is PostgreSQL execution time**. The remaining ~320-460 ms is the cost of issuing 895 statements / 2,685 protocol messages sequentially. **That component is what A1-3 removes**, and it is removed by a factor of ~32.
- The ~120-150 ms of server time does **not** vanish — the same rows are still written — but a large share of it is per-statement fixed cost (parse, plan, bind, executor setup, ~0.13 ms averaged over 895 statements) rather than per-row cost. Collapsing 540 single-row DML statements into 10 multi-row ones removes most of that fixed cost too.
- `planConsumption`, the other half of the requirement, costs **2 statements and 0.57 ms**. It contributes nothing meaningful to the budget and needs no work.

Conclusion: the architecture plausibly has **ample** headroom — the dominant cost term is being eliminated almost entirely, and the residual term is small. Whether the measured p95 actually lands under 200 ms **must be re-measured after implementation, in isolation, with instrumentation off**, and is not asserted here.

## 12. SQL feasibility probes — executed this session

**Environment.** `ros-postgres-lane-a` (PostgreSQL 16, port 5555), database `ros_lane_a_a11_20260902043434` (the disposable Lane-A database). **The persistent `ros` database on port 5544 was never connected to.** Every probe against real tables ran inside `BEGIN … ROLLBACK`, and each verifies its own rollback. One throwaway database `ros_lane_a_probe_a13` was created for the two-session concurrency probes and **dropped** (§12.9). Probe scripts live only in this session's scratchpad; **nothing is committed**.

### 12.1 P1 — window-function fold, ordering, and numeric exactness

`start_balance + SUM(qty::numeric) OVER (ORDER BY ord ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`.

- **P1 (all-negative, 6 dp):** start `100.000000`, deltas `−0.2, −0.1, −0.333333, −0.000001, −12.345678` → `99.800000, 99.700000, 99.366667, 99.366666, 87.020988`. Exact.
- **P1b (mixed signs):** start `10.000000`, deltas `−4.5, +7.25, −12.75, +0.000001` → `5.500000, 12.750000, 0.000000, 0.000001`. Exact through zero.
- **P1c (exactness):** `SUM(numeric)` over ten 6-dp values = `4.600000`, exact.
- **P1d:** JSON numeric literals land in `numeric` exactly (`12345678901.123456`), and the design carries decimals as **strings** anyway.
- **P1e (ordering):** input array deliberately shuffled to `ord = 3,1,4,2`; output folds `−1,−2,−3,−4` in `ord` order → `99, 97, 94, 90`. **The fold follows `ORDER BY ord`, not array position.** **PASS.**

### 12.2 P2 — the real statement against the real schema

Real tenant/item/location/unit/user, real partitioned `stock_movements`, inside `BEGIN … ROLLBACK`, after a real `lockLayers` `FOR UPDATE`. One statement performed the `stock_levels` group delta (`−2.000001`) and inserted 3 movements with window-computed `balance_after`.

- starting `quantity_on_hand = −7.000000` (real negative-stock fixture data, `FR-INV-014`)
- movements: `−0.333333 → −7.333333`, `−1.666667 → −9.000000`, `−0.000001 → −9.000001`
- **independent re-fold** of the persisted rows reproduces `−7.333333, −9.000000, −9.000001` exactly
- `stock_levels.quantity_on_hand = −9.000001` **equals** `before + SUM(quantity)` → `equal = t` (**`BR-INV-003`**)
- partition routing: all 3 rows in `inventory.stock_movements_2026_09`, the RLS-forced child partition
- after `ROLLBACK`: 0 probe movements, `quantity_on_hand` back to `−7.000000`

**PASS.**

### 12.3 P3 — `UPDATE … FROM` aggregation, both axes, and the hazard

- **Hazard, executed:** two source rows (`1.000000`, `2.000000`) matching one batch at `3.000000` → result `2.000000`. **One delta silently lost.** This is why §8.1's `GROUP BY` is mandatory.
- **Physical, aggregated:** `0.333333 + 1.666667` on `b1` → `3.000000 → 1.000000`. **Both deltas applied.**
- **Accounting, aggregated, different batch set:** `0.5 + 1.5` on `b2` → `2.000000 → 4.000000`. `b1`'s counter untouched, `b2`'s `quantity_remaining` untouched. **Axes independent.**
- **Fail-closed:** an over-consuming update was rejected — `ERROR: new row for relation "stock_batches" violates check constraint "ck_batch_qty_nonneg"`.
- After `ROLLBACK`: `3.000000 / 5.000000` and `0.000000 / 2.000000` restored.

**PASS.**

### 12.4 P4 — set-oriented reservation and conflict detection

- 3 requested, 2 already existing → **exactly 1** row returned; `requested=3, reserved=1, conflicting=2, must_abort=t`.
- Control (conflicting rows removed first): 3 requested → **3** returned.
- After `ROLLBACK`: the 2 real effects still present, 0 probe effects.

**PASS.**

### 12.5 P5 — allocations + pointer in one statement, two order lines, one key

Statement 1 wrote 3 movements (`−0.333333, −0.666667, −0.000001`); statement 2 wrote 3 allocation rows **and** the pointer in one round trip.

- allocations preserved per-slice provenance: `(effect …6748, seq 90, physical b1, cost-basis b1)`, `(effect …6748, seq 91, physical b2, cost-basis b2)`, `(effect …678f, seq 90, **physical NULL**, cost-basis b2)` — the shortfall slice keeps a cost basis with no physical batch, exactly as `FR-INV-014` + `P1F2E-A` §F require
- **two order lines, one stock key, one continuous chain:** `−7.333333 → −8.000000 → −8.000001`
- `last_movement_id` = the **last** movement in `ord` order → `pointer_is_last_in_order = t`
- `projection_equals_fold = t`
- After `ROLLBACK`: 0 movements, 0 allocations, `quantity_on_hand` restored.

**PASS.**

### 12.6 P6 — concurrency, two live sessions

Run on the throwaway `ros_lane_a_probe_a13` database so that **committing** could be proven without mutating Lane-A state.

- **P6a (batch rows present):** T1 took `FOR UPDATE` at `14:35:45.758` and committed at `14:35:47.778`. T2 began at `14:35:46.200` and **obtained the lock at `14:35:47.779`** — blocked 1.58 s. On unblocking T2 observed `qty_remaining = 70.000000` (T1's committed value), **not** the stale `100.000000`. Chains: T1 `190.000000, 170.000000`; T2 `168.000000, 165.000000`. Final projection `165.000000 = 200 − 30 − 5`. **Contiguous, no gap, no overlap.**
- **P6b (no batch rows at all — `FOR UPDATE` locks nothing):** serialisation came from the `stock_levels` upsert alone. U2 folded `50 → 47 → 43`; U1 then folded `43 → 39 → 33`. Final `33.000000 = 50 − 7 − 10`. **Serial-equivalent even with zero row locks.**
- **P6c (the REJECTED shape, executed):** starting balance obtained by a plain `SELECT`, then written. Result: R2 claims `47, 43`; R1 claims `46, 40`; **true projection `33.000000`.** The final movement's `balance_after` is off by 7 and the two chains overlap. Invariants 9 and 10 both violated. **This is why §6.1 derives the start from the atomic write's own `RETURNING`.**

**PASS.**

### 12.7 P7 — carry-forward staleness (drives the §9.2 flush rule)

Real layers: `b1` `5/5` (accounting-exhausted), `b2` `2/5` (3.0 headroom).

- carry-forward basis **before** applying the group's accounting consumption: `b1`, `unit_cost = 100`
- apply `+3.000000` to `b2` (exhausting it)
- carry-forward basis **after**: `b2`, `unit_cost = 200`

**The two answers differ, and they differ in unit cost.** Deferring the accounting `UPDATE` past `findCarryForwardBasis` is unsafe. **PASS (finding recorded, rule mandated).**

### 12.8 P8 — the whole design executed as `ros_app` under FORCE RLS

Every probe above ran as `ros_migrator`. P8 re-ran the full per-group shape as the **runtime role** `ros_app` with `set_config('app.tenant_id', …, true)` — the exact mechanism `PrismaService.withAuthContext` uses.

- `lockLayers` `FOR UPDATE` under RLS: OK
- statement 1 (`stock_levels` delta + 3 movements with window `balance_after`): OK — `−7.333333, −8.000000, −8.000001`
- statement 2 (pointer + 3 allocations, one round trip): OK, including a `physical_batch_id = NULL` slice
- both aggregated batch `UPDATE`s: OK — physical `3.000000 → 2.000000`, accounting `2.000000 → 3.000001`, axes independent
- final `quantity_on_hand = −8.000001`, `last_movement_id` = last in `ord` order
- **append-only still enforced:** `UPDATE inventory.stock_movements SET balance_after = 0` → `ERROR: permission denied for table stock_movements`
- After `ROLLBACK`: 0 probe rows

**PASS. Every statement in the proposed design is executable by the runtime role under FORCE RLS, with the ledger still append-only.**

### 12.9 Probe cleanup — verified

```
ALTER DATABASE ros_lane_a_a11_… RESET log_statement;
ALTER DATABASE ros_lane_a_a11_… RESET log_min_duration_statement;
ALTER DATABASE ros_lane_a_a11_… RESET log_min_messages;
DROP DATABASE IF EXISTS ros_lane_a_probe_a13;
```

Verified after execution: `pg_db_role_setting` returns **zero rows** (no per-database settings remain), and `pg_database` on port 5555 lists **only** `ros_lane_a_a11_20260902043434` — the probe database is gone. `git status --short --untracked-files=all` is clean apart from this report and the `INDEX.md` row.

## 13. Failure conditions — every one checked

| Rejection condition | Status in this design |
|---|---|
| Final stock balance copied into every movement | **Not present.** Each movement gets `start + cumulative(1..k)`; only the last row equals the final balance. Proven per-row in P2/P5/P8. |
| Approximate `balance_after` | **Not present.** PostgreSQL `numeric` throughout; independent re-fold matches exactly. |
| Post-insert correction of movement rows | **Not present**, and impossible: `ros_app` has no `UPDATE` on `stock_movements` (P8). |
| JS-computed cumulative floating-point balances | **Not present.** No cumulative balance is computed in JS at all; the fold is a SQL window function, and JS carries only exact `toDecimal6` strings. |
| Physical/accounting axis collapse | **Not present.** Two separate planners, two separate payloads, two separate statements over different batch sets (§5.5 explicitly rejects merging them). |
| `SKIP LOCKED` | **Not present.** `lockLayers` is unmodified: plain `FOR UPDATE`. |
| Asynchronous / out-of-transaction depletion | **Not present.** Every statement runs on the caller's `tx`. |
| One DB transaction per movement | **Not present.** Fewer transactions is not even the axis being changed — the count goes from one to one. |
| Dropping allocation provenance | **Not present.** One allocation row per zipped slice, all columns as today (P5, P8). |
| Weakening effect reservation | **Not present — strengthened** (§10): same `ON CONFLICT DO NOTHING`, identity-based detection, and now strictly before any Inventory lock or mutation. |

## 14. A1-4 interactions and dependencies

Flagged separately, as required. **None of these are introduced by A1-3; A1-3 changes the context in which two of them must be re-verified.**

1. **Deadlock matrix (A1-4).** A1-3 introduces no `stock_batches`-vs-`stock_levels` ordering inversion (§7.3, §7.4). It **does** hoist all `sale_depletion_effects` reservation locks to the front of the transaction (§7.5). That is provably not a cycle source (single writer; order-scoped key), but the A1-4 matrix — completion vs `MovementsService.post`, vs transfers, vs counts (`CT-08`), vs waste — must be built against the **hoisted** shape, not A1-2's interleaved one.
2. **Weighted-average concurrent-receipt race (A1-4).** `stock_levels.average_cost` is still read without a lock in `MovementsService.post`, and `SaleDepletionService` still never writes it. A1-3's §9.3 hoist reads the same value once instead of 45 times — the same race, no wider, no narrower. Unchanged residual.
3. **`BR-INV-003` daily reconciliation job (`CG-02`, A1-4).** Not started. A1-3 makes the in-transaction fold *easier* to verify (the last `balance_after` per group is the projection by construction) but does not build the daily job.
4. **Multi-location depletion.** Today one branch resolves to one location per call, so the group key's `location_id` is constant. The design keys and sorts on `(stock_item_id, location_id)` explicitly, so a future multi-location Completion needs no redesign — but that path is untested and out of A1-3's scope.
5. **`MovementsService.post` set-orientation.** Explicitly **not** in A1-3. `post` writes one movement per call; there is nothing to batch. The mixed-sign generality proven in P1b is what a future batched `post` would need, recorded here so it need not be re-proven.

## 15. Risks

| # | Risk | Mitigation / status |
|---|---|---|
| R1 | **`UPDATE … FROM` multiple-match** silently dropping a delta | **Highest-severity risk in the slice.** Executed and confirmed real (P3). Mitigated structurally by mandating `GROUP BY` inside the statement (§8.1), and caught by `ck_batch_qty_nonneg` / `ck_batch_cost_qty_range` if ever reintroduced. |
| R2 | **Carry-forward computed against stale accounting state** | Executed and confirmed real, with a differing unit cost (P7). Mitigated by the mandatory flush rule (§9.2). Must have its own test. |
| R3 | Prisma `$queryRaw` binding of the `jsonb` parameter | The probes used psql literals. The implementation must pass `JSON.stringify(payload)` as a text parameter with an explicit `::jsonb` cast and confirm it on first run. Low risk (text parameter + cast is the most conservative binding available), but it is an **implementation-time check**, not something this gate proved. |
| R4 | Allocation/movement ids | Must be `newId()` from JS, **not** `gen_random_uuid()` (used in probes for convenience only). §5.6. |
| R5 | Payload size for very large orders | 135 rows × ~8 fields ≈ a few KB — fine. `NFR-PERF-006` bounds the case at 30 lines. **A1-3 will not chunk.** If chunking is ever needed, chunk *k+1*'s start balance must come from chunk *k*'s last `balance_after` and the `stock_levels` delta must be applied per chunk — a documented extension, deliberately out of scope. |
| R6 | Error attribution granularity | A constraint violation now names a statement, not a single logical effect. The transaction still fails closed and the message still names the group's stock key. Accepted, minor. |
| R7 | Losing the A1-2 evolve-state equivalence | A1-3 **reuses** `evolvePhysicalState`/`evolveAccountingState` unchanged and relies on A1-2's existing tests. Any change to them would invalidate both slices at once. |
| R8 | Regression invisibility | Mitigated by the acceptance criterion in §16.3: A1-3 must produce **byte-identical** rows to A1-2 for the same input. |

## 16. DECISION

> ## **APPROVE A1-3 IMPLEMENTATION**

Every hard invariant is preserved or strengthened; every rejection condition is absent; the `balance_after` proof is executed, not argued; the concurrency proof is executed against two live sessions including the rejected alternative; the round-trip model is measured, not estimated; and the bottleneck being removed (round-trip overhead, ~75-80 % of wall clock) is exactly the one the design eliminates.

### 16.1 Implementation sequence — two slices

Two commits, not one. They fail differently and deserve separate review: A1-3A is about *idempotency and conflict semantics*, A1-3B is about *ledger truthfulness*. Either can be reverted without losing the other.

**A1-3A — set-oriented effect reservation.**
- Replace the per-triple reservation `INSERT` with the single `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING` of §5.2, hoisted before the group loop.
- Identity-based (not cardinality-based) conflict detection; `SaleDepletionEffectConflictError` naming every missing triple.
- Hoist `currentAverageCost` to one lookup (§9.3).
- Diff: ~60 lines in `sale-depletion.service.ts`. No change to `balance_after`, movements, allocations or batches.
- Tests: conflict on the first / middle / last effect; a conflict proven to abort with **zero** `stock_batches`, `stock_levels`, `stock_movements` and `sale_depletion_allocations` writes; the existing idempotency suites green unchanged.

**A1-3B — set-oriented group write path.**
- Per group: plan all effects in memory (A1-2 evolve functions, unchanged) → aggregated physical `UPDATE` (§8) → aggregated accounting `UPDATE` with the carry-forward flush rule (§9.2) → `stock_levels` delta + movements CTE (§5.4) → pointer + allocations CTE (§5.6).
- Delete `writeAllocation`'s four per-slice statements.
- Diff: ~200 lines, one method plus two new private helpers, in one file. `fifo-cost-ledger.ts`'s public surface unchanged; `MovementsService` untouched; `sale-depletion.contract.ts` untouched.
- Tests: the six §6.3 cases; the carry-forward flush (R2) with an assertion on the resulting `unit_cost`; a multi-allocations-per-batch case that fails against an un-aggregated `UPDATE … FROM` (R1); the `stock_levels`-row-absent case (`itemStd` in the fixture already exercises it); `sale-depletion-lock-grouping.e2e-spec.ts` and both `order-completion-concurrency` suites green **unmodified**.

### 16.2 Not in scope for A1-3

Recipe expansion (measured at 2 statements / 0.57 ms — nothing to do), `MovementsService.post`, any schema or migration change, any contract or OpenAPI change, the A1-4 items in §14, and payload chunking (R5).

### 16.3 Acceptance criterion

**A1-3 is accepted only if, for identical input, it produces byte-identical persisted rows to A1-2** — every `stock_movements.balance_after`, `quantity`, `batch_id`; every `sale_depletion_allocations` column including `sequence`; every `stock_batches.quantity_remaining` and `fifo_cost_quantity_consumed`; and `stock_levels.quantity_on_hand` / `last_movement_id`. This is achievable **by construction**, because `ord` (§6.2) is defined to be the order A1-2 already executes in. `test/sale-depletion-lock-grouping.e2e-spec.ts` — which already asserts exact values with `Prisma.Decimal.equals` — must pass **unmodified**.

Separately, and reported honestly whatever it says: re-run `test/order-completion-performance.e2e-spec.ts` unmodified, in isolation, with instrumentation off, and record p50/p95. `NFR-PERF-006` is `COMPLETE` only if the measured p95 ≤ 200 ms.

## 17. Status of `NFR-PERF-006` after this session

**PARTIAL / VERIFIED-FAILING — unchanged.** This session implemented nothing. The two instrumented runs performed here (p95 504.31 ms and 608.24 ms, with statement logging enabled) confirm the requirement is still failing and are **not** offered as a re-baseline of A1-2's isolated `p50=750.45 / p95=2068.60 ms`.

## 18. Schema / API / product-code status

- **Schema change: NO.** `prisma/schema.prisma` untouched.
- **Migration: NO.** No file created in `prisma/migrations/`.
- **Public API change: NO.** No route, DTO, contract, permission, RBAC or RLS change; `docs/api/openapi.json`/`.yaml` untouched.
- **Product code changed: NO.** `git status --short --untracked-files=all` shows only this report and the `INDEX.md` row.
- Probe scripts exist only in this session's scratchpad and are not committed; probe database dropped; database logging settings reset (§12.9).

## 19. Commit

Docs/design only. Exact subject:

```
docs(inventory): design set-oriented depletion writes
```

Staged explicitly: this report and the one `INDEX.md` row. Nothing else.

## 20. Push / deploy status

**NOT PUSHED. NOT DEPLOYED. NOT MERGED. NOT REBASED.**
