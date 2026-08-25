# P1F-2E — Dual-Axis Batch Accounting & Multi-Batch Traceability Gate

**Report type:** Narrow Inventory design correction + final readiness gate (no production code, no production migration, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence**. Nothing here creates or amends a governance decision.
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (verified unchanged — no commit)
**Branch:** `feat/production-spec`
**Working tree:** three preserved user files, the P1F-2 / A / B / C / D reports, the governance register, INDEX, plus this report
**Task identifier:** P1F-2E

> ## VERDICT (§O)
> ## **IMPLEMENTATION READY**
> **C-14** resolved by proving (with a counterexample) that a second, accounting-side
> remaining quantity is *necessary*, then adopting the minimal model: one additional
> column on `stock_batches`, keeping the **batch** as the SRS cost layer.
> **C-15** resolved by splitting the logical effect into **N allocations = N movements**,
> so every physical batch consumed is recorded and every COGS amount carries its
> cost-basis layer. `fefo` + `fifo` is **no longer a documented open item**.
> Migrations remain **30**; OpenAPI remains **135**.

---

## A. STARTING STATE

| Check | Result |
|---|---|
| Branch | `feat/production-spec` |
| HEAD | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` |
| `origin/feat/production-spec` | matches |
| Migrations | **27** · OpenAPI **3.1.0 / 133** |
| Preserved user files | untouched |

No branch operation, no destructive git command, no commit, no push, no production code.

## B. P1F-2D PRESERVED BASELINE

Everything in §15 of the governing task is preserved untouched: Option A completion-time recursive expansion, the recipe-version closure pin, the modifier-effect snapshot, the conversion-basis snapshot, the `GET`+`PUT` modifier-effect API, OpenAPI baseline logic, fail-closed conversion gaps, the FIFO Exhaustion Carry-Forward ratification, posted-COGS fields, the Payment completion trigger, `pos.payment.capture`, UnitOfWork, Order CAS last, the effect business identity, RLS discipline, no `/complete` route, `order.completed` v1, and FR-CST-002 **PARTIAL**.

**Two P1F-2D wording defects corrected** (task §15):
1. P1F-2D §J said *“All four Sales snapshot tables”*; its design lists **three** new Sales snapshot tables — `order_line_recipe_versions`, `order_line_modifier_effects`, `order_line_component_conversions`. **Three** is correct and is used throughout §P.
2. `resolveConsumptionBasis` was described as returning *“no money, no quantities”*. Corrected to **“no resolved/net consumption quantities and no money”** — configured **modifier ADD quantities** are legitimately part of the snapshot, as are the pinned conversion factors.

## C. C-14 SOURCE ANALYSIS

**FR-INV-012 [M]** defines FIFO costing. **FR-INV-013 [M]**: *“Where an item is batch-tracked, FIFO valuation SHALL follow batch receipt order, and consumption SHALL record which batch was consumed.”* **FR-INV-022/023 [M]** independently make physical consumption `fifo` **or** `fefo`, with FEFO the default for expiry-tracked items.

Both are **[M]**, both are unconditional, and the combination `costing_method = fifo` + `batch_strategy = fefo` is **reachable and normal** (any expiry-tracked FIFO-costed item). P1F-2D's treatment — valuing at the physically-consumed FEFO batches and marking FR-INV-013 “not applicable” — is therefore **rejected**. FR-INV-013's receipt-order clause is not conditioned on `batch_strategy`; it is conditioned only on the item being batch-tracked.

**Conclusion:** the design must satisfy **both axes simultaneously**. Physical flow follows `batch_strategy`; valuation flow follows **receipt order** whenever `costing_method = fifo`.

### Why a second remaining-quantity is *necessary* — counterexample

Could the cost plan simply scan `quantity_remaining` in receipt order, with no new state? **No.** Proof:

- Batch **A** — received day 1, qty 10, unit cost 100, distant expiry.
- Batch **B** — received day 2, qty 10, unit cost 200, near expiry.
- `batch_strategy = fefo`, `costing_method = fifo`.

**Sale 1, qty 5.** Physical (FEFO): B −5 ⇒ B.remaining = 5. Cost (receipt order over `quantity_remaining`): A has 10 ⇒ charge 5 @ 100. Correct — but A's cost layer is now 5 consumed, and **nothing records that**.

**Sale 2, qty 10.** Physical (FEFO): B −5 (B = 0), then A −5 (A = 5). Cost, re-scanning `quantity_remaining` in receipt order: A still shows 10 ⇒ charge 10 @ 100. **Wrong** — A only had 5 cost-quantity left; its cost layer is double-charged and B's 200-cost layer is never charged at all.

The accounting position is therefore **not derivable** from `quantity_remaining`. A second, independently-advancing counter is required.

### Model comparison

| Option | Assessment |
|---|---|
| **A. Second quantity on `stock_batches`** | **CHOSEN.** The batch remains the cost layer, exactly as FR-INV-012 (*“the cost of the oldest remaining **batch**”*), FR-INV-013 (*“which **batch** was consumed”*) and §24.5.2 (`batches.availableOrdered`) all frame it. One additive column. Both counters live on the **same row**, so a single lock set covers both axes — a decisive concurrency simplification. No new writer is needed (see §M). |
| **B. Separate `fifo_cost_layers` table** | Rejected. Duplicates the layer set; needs its own writer on receipt — and **no batch writer exists in `src/` at all**, so a second one would be dead on arrival; doubles the lock surface across two tables; and reifies an accounting entity the SRS never names. |
| **C. Derive from allocations only** | Rejected. Non-sale consumption (waste, transfers, counts) also consumes cost quantity and produces no allocation rows, so the derived position would drift. |

**No new accounting entity is created. FEFO cost is never called FIFO. The combination is never forbidden. No fallback to another costing method occurs.**

## D. PHYSICAL BATCH MODEL

Unchanged from today, and unchanged by this gate.

```sql
-- eligible physical layers
WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
  AND quantity_remaining > 0
ORDER BY  batch_strategy='fifo' : created_at ASC, id ASC
          batch_strategy='fefo' : expiry_date ASC NULLS LAST, created_at ASC, id ASC
```

Drawn down in that order; `quantity_remaining` is decremented. Each physically backed slice retains `physical_batch_id` and `quantity`. An unbacked remainder (negative stock, permitted by FR-INV-014) carries `physical_batch_id = NULL`. `ck_batch_qty_nonneg` is never violated because the plan never over-allocates a layer.

## E. FIFO ACCOUNTING MODEL

**New column** (Inventory-owned, migration 30):

```sql
ALTER TABLE inventory.stock_batches
  ADD COLUMN fifo_cost_quantity_consumed DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE inventory.stock_batches
  ADD CONSTRAINT ck_batch_cost_qty_range
  CHECK (fifo_cost_quantity_consumed >= 0
     AND fifo_cost_quantity_consumed <= quantity_received);
```

**Cost-remaining is derived:** `quantity_received − fifo_cost_quantity_consumed`.

Chosen as *consumed* rather than *remaining* deliberately: `DEFAULT 0` makes a newly created batch automatically carry its full cost quantity, so **no batch-creation writer has to change** — which matters because `stock_batches` has no application writer at all today.

**Backfill** (exact, and vacuous on a from-zero database):
```sql
UPDATE inventory.stock_batches
   SET fifo_cost_quantity_consumed = quantity_received - quantity_remaining;
```

**Cost plan** — used only when `costing_method = 'fifo'` and the item is batch-tracked:

```sql
WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
  AND (quantity_received - fifo_cost_quantity_consumed) > 0
ORDER BY created_at ASC, id ASC          -- RECEIPT ORDER, always (FR-INV-013)
```

Each valued slice retains `cost_basis_batch_id`, `quantity`, `unit_cost` (the layer's own `unit_cost`). `fifo_cost_quantity_consumed` is incremented by the consumed amount.

**Keeping the two axes in step.** Every outbound batch-tracked consumption must advance the cost axis, or the cost queue drifts from physical reality. `MovementsService.post` is therefore extended, **for `costing_method='fifo'` batch-tracked items only**, to advance `fifo_cost_quantity_consumed` in receipt order by the same total quantity it consumed physically. This is **counter maintenance only** — `valuationUnitCost` is **not** modified and the existing valuation of transfers/waste/counts is unchanged. Correcting *those* paths' valuation to receipt-order FIFO is a separate Inventory slice, recorded in §N.

`costing_method` is immutable after creation (`StockItemsService` exposes `create`, `list`, `findOne`, `changeBaseUnit`, `setReorderConfig`, `createReasonCode`, `listReasonCodes` — **no costing-method update path**), so an item can never switch axes mid-life.

## F. FIFO CARRY-FORWARD

The ratified **FIFO Exhaustion Carry-Forward** rule is **not reopened**. It is re-pointed at the accounting axis, which is what it always meant:

- It applies when the **FIFO accounting cost queue** is exhausted — i.e. no batch has `quantity_received − fifo_cost_quantity_consumed > 0`.
- The basis is the **most recently exhausted FIFO accounting cost layer**, resolved in **receipt order** (P1F-2D §E), *not* the last physically consumed FEFO batch:

```sql
SELECT unit_cost FROM inventory.stock_batches
WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
  AND (quantity_received - fifo_cost_quantity_consumed) = 0
ORDER BY created_at DESC, id DESC
LIMIT 1;
```

Run **after** the cost-plan increments are applied, so it serves both partial- and zero-coverage in one query. Such an allocation carries `cost_basis_batch_id = NULL` (no layer bore the cost) while retaining the carried-forward `unit_cost`. If no exhausted accounting layer exists either → **fail closed**, roll the whole Completion back; never substitute another costing method.

## G. PHYSICAL/COST PLAN RECONCILIATION

Both plans cover exactly the same total depleted quantity **D**. They are merged by a deterministic two-pointer **zipper** producing allocation slices:

```
i, j = 0, 0 ;  emitted = 0 ;  out = []
while emitted < D:
    p = physicalPlan[i]      # (physicalBatchId | null, remaining)
    c = costPlan[j]          # (costBasisBatchId | null, remaining, unitCost)
    take = min(p.remaining, c.remaining)          # exact Decimal
    out.append({ physicalBatchId: p.batchId,
                 costBasisBatchId: c.batchId,
                 quantity: take,
                 unitCost: c.unitCost })
    p.remaining -= take ; c.remaining -= take ; emitted += take
    if p.remaining == 0: i += 1
    if c.remaining == 0: j += 1
```

Worked example (the task's own):

| physical | cost basis | qty |
|---|---|---|
| B | A | 3 |
| B | B | 2 |

**Properties:** exact `Prisma.Decimal` throughout, **no floating point**; `Σ out.quantity == D` exactly, by construction; at most `|physicalPlan| + |costPlan| − 1` allocations; deterministic given deterministic inputs. For non-FIFO costing the cost plan is a single slice `(null, D, unitCost)`, so the zipper degenerates to the physical plan — one allocation per physical batch.

## H. C-15 MULTI-BATCH TRACEABILITY

P1F-2D populated `stock_movements.batch_id` only when exactly one batch was consumed, discarding batch identity for every multi-batch depletion. That fails **FR-INV-013 [M]**'s *“consumption SHALL record which batch was consumed”* and destroys the substrate **FR-INV-027 [S]** needs.

**Corrected:** one logical effect produces **N allocations**, each mapping to **exactly one immutable stock movement**:

```
1 sale_depletion_effect   (business identity — UNCHANGED)
      = N sale_depletion_allocations
      = N stock_movements
```

`stock_movements.batch_id = physical_batch_id` on every batch-backed allocation, and `NULL` only for a genuinely unbacked (negative-stock) slice. **No representative single batch id is ever placed on a multi-batch aggregate.** `FR-INV-030 [M]` is satisfied per movement, and `FR-INV-051 [M]` still holds because the N movement quantities sum to the same net delta.

## I. EFFECT / ALLOCATION / MOVEMENT MODEL

**Parent — `inventory.sale_depletion_effects`** (business identity preserved exactly):

```
id, tenant_id, order_id, business_day, order_line_id,
stock_item_id, location_id,
quantity_in_base_unit DECIMAL(18,6) NOT NULL,   -- net total for the invariant check
unit_id, created_at
UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)   -- UNCHANGED, no occurred_at
```

Cost and movement columns are **removed from the parent** — they are per-allocation facts now.

**Child — `inventory.sale_depletion_allocations`:**

```
id, tenant_id, effect_id, sequence SMALLINT NOT NULL,
physical_batch_id   UUID NULL,      -- NULL only for an unbacked (negative-stock) slice
cost_basis_batch_id UUID NULL,      -- NULL only for a carry-forward slice
quantity_in_base_unit DECIMAL(18,6) NOT NULL CHECK (> 0),
unit_id,
unit_cost  BIGINT NOT NULL,         -- the ACTUAL cost-basis unit cost, never blended
total_cost BIGINT NOT NULL,         -- positive magnitude
movement_id UUID NOT NULL, movement_occurred_at TIMESTAMPTZ NOT NULL,
created_at
UNIQUE (tenant_id, effect_id, sequence)
```

FKs — all composite and tenant-safe: `(tenant_id, effect_id)` → parent **RESTRICT**; `(tenant_id, physical_batch_id)` and `(tenant_id, cost_basis_batch_id)` → `inventory.stock_batches(tenant_id, id)` **RESTRICT** (which also hard-pins the batch history the carry-forward rule depends on); `(tenant_id, movement_id, movement_occurred_at)` → `inventory.stock_movements(tenant_id, id, occurred_at)` **RESTRICT**; `(unit_id)` → `inventory.uom(id)` **RESTRICT**.

Indexes for §L traceability: `(tenant_id, effect_id)`, `(tenant_id, physical_batch_id)`, `(tenant_id, cost_basis_batch_id)`.

Both tables: **NOT partitioned**, RLS `ENABLE`+`FORCE`, **SELECT and INSERT policies only**, `GRANT SELECT, INSERT`, `REVOKE UPDATE, DELETE, TRUNCATE`.

**Invariant:** `Σ allocations.quantity_in_base_unit == effect.quantity_in_base_unit`, asserted by test.

## J. CONCURRENCY / LOCKING

The two plans touch **different subsets of the same table**, so a single lock set covers both — the decisive advantage of §C Option A.

Per `(stock_item, location)`, **before computing either plan**, lock the union of candidate rows in **one deterministic order**:

```sql
SELECT id, quantity_remaining, quantity_received, fifo_cost_quantity_consumed,
       unit_cost, created_at, expiry_date
FROM inventory.stock_batches
WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
  AND ( quantity_remaining > 0
     OR (quantity_received - fifo_cost_quantity_consumed) > 0 )
ORDER BY created_at ASC, id ASC          -- ONE ordering for BOTH axes
FOR UPDATE;                               -- NEVER SKIP LOCKED
```

Both plans are then computed from that locked snapshot, and **both counters are mutated only afterwards** — so physical locks are never taken in one order and accounting locks later in another. Locks are held to COMMIT.

**Global ordering across items** in a multi-line completion is unchanged: process distinct `(stock_item_id, location_id)` ascending, then `order_line_id` — never JS map iteration order.

**Per-allocation write sequence** — the accepted FK-safe three statements, repeated per allocation in deterministic order:

1. atomic additive `stock_levels` delta → `RETURNING quantity_on_hand`
2. `INSERT` the immutable movement with `balance_after` = that returned value
3. `UPDATE stock_levels` last-movement pointer

The row lock from the first allocation's statement 1 is held to COMMIT, so subsequent allocations for the same `(item, location)` are already serialized. Each movement therefore carries a **truthful running `balance_after`**, preserving **BR-INV-003**.

> **Batching considered and rejected.** Collapsing N allocations into one projection delta would save statements but make per-movement `balance_after` unattributable. **BR-INV-003 is not sacrificed to save statements.** N is small — bounded by `|physicalPlan| + |costPlan| − 1` per (line, item).

## K. IDEMPOTENCY

`sale_depletion_effects` remains the sole business reservation:

```sql
INSERT INTO inventory.sale_depletion_effects (...)
ON CONFLICT (tenant_id, order_line_id, stock_item_id, location_id) DO NOTHING
RETURNING id;
```

**Never** `INSERT`-catch-`P2002`-then-query. Only the **winning parent** may decrement physical quantities, advance `fifo_cost_quantity_consumed`, alter `stock_levels`, or create allocations and movements. `0` rows returned ⇒ raise a conflict and roll the **whole** transaction back, including the parent reservation — leaving no orphan movement or allocation.

An exact Payment replay never reaches the effect writer: the permanent Payment-id check short-circuits at step 1 of the Completion transaction, and the Order's terminal `completed` state plus the version CAS make a second completion unreachable. The registry conflict is defence in depth, not the hot path.

## L. COGS PROVENANCE

```
allocation.total_cost      = round_half_up(quantity × unit_cost)    -- POSITIVE magnitude
order_lines.posted_cogs_total = exact bigint Σ of that line's allocation total_cost
orders.cogs_total             = exact bigint Σ of line posted totals
```

**Rounding point refinement (a change from P1F-2D):** rounding now occurs **per allocation**, not once per effect. This is strictly more truthful — each movement is an independent ledger fact whose `total_cost` is exactly its own quantity × its own cost-basis unit cost. Each movement's `unit_cost` is the **actual cost-basis layer's unit cost**, never a blended representative, so P1F-2D's "representative unit cost" caveat disappears entirely. Posted COGS is still **never** reconstructed from `unit_cost × quantity` — it is the sum of stored `total_cost` values.

**Traceability queries (§12 of the task) — all mechanically possible:**

| Query | Path |
|---|---|
| **A.** Batch X → which Orders/OrderLines consumed it? | `allocations WHERE physical_batch_id = X` → `effects` → `order_id`, `order_line_id` |
| **B.** Order Y → which physical batches consumed? | `effects WHERE order_id = Y` → `allocations.physical_batch_id` |
| **C.** OrderLine Z → which FIFO cost layers funded its COGS? | `effects WHERE order_line_id = Z` → `allocations.cost_basis_batch_id`, `unit_cost`, `total_cost` |
| **D.** Effect → every movement it generated | `allocations WHERE effect_id = …` → `movement_id` |

## M. MIGRATION 30

**Total remains 30** — 28 Sales, 29 Production, 30 Inventory. All new Inventory structures live in migration **30**; no migration 31 is created merely because migration 30 gains another Inventory table, and no committed migration is edited.

| Item | Detail |
|---|---|
| **`stock_batches.fifo_cost_quantity_consumed`** | `DECIMAL(18,6) NOT NULL DEFAULT 0` + `ck_batch_cost_qty_range` (`>= 0 AND <= quantity_received`). **Backfill** `= quantity_received - quantity_remaining` (exact; vacuous from zero). **Zero-downtime:** a defaulted non-volatile column, no rewrite on PG 11+, and no batch-creation writer needs changing. Tenant safety, RLS, grants and existing FKs on `stock_batches` are unchanged. |
| **`sale_depletion_effects`** | As P1F-2D, minus the cost/movement columns (now per-allocation). Tenant-anchored; composite FKs to `sales.order_lines` (RESTRICT), `stock_items`, `org.locations`, `uom` (RESTRICT); `UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)`; NOT partitioned; RLS ENABLE+FORCE, SELECT+INSERT policies only; `GRANT SELECT, INSERT`, `REVOKE UPDATE, DELETE, TRUNCATE`; immutable. |
| **`sale_depletion_allocations`** | Columns per §I; `UNIQUE (tenant_id, effect_id, sequence)`; FKs per §I, all **RESTRICT**; indexes `(tenant_id, effect_id)`, `(tenant_id, physical_batch_id)`, `(tenant_id, cost_basis_batch_id)`; NOT partitioned; same RLS + append-only privileges; immutable. |
| **`stock_movements` / `stock_levels`** | **Unchanged.** No `exhausted_at`, no new column, no new index, no partition work. |

## N. REQUIREMENT CLASSIFICATION

| Requirement | POST-P1F-2 |
|---|---|
| **FR-INV-012** | **COMPLETE for the completion path** — each item valued by its own configured method, including `fifo` under a FEFO physical strategy |
| **FR-INV-013** | **COMPLETE for the completion path** — FIFO valuation follows receipt-order cost quantity, **and every physical batch consumed is recorded** on its own movement. *Not claimed globally:* transfers/waste/counts still value via the existing `valuationUnitCost`, which is untouched |
| **FR-INV-022 / 023** | **COMPLETE** — physical consumption remains independent and strategy-driven |
| **FR-INV-014** | **COMPLETE** — negative stock recorded, never blocking |
| **FR-INV-020** | unchanged — batch creation is still Procurement's, unimplemented |
| **FR-INV-027 [S]** | **NOT IMPLEMENTED as a reporting surface**, but the **provenance substrate now exists** and is test-proven (§L) |
| **FR-INV-030** | **COMPLETE** for sales — one immutable movement per allocation |
| **FR-INV-051** | substrate preserved — movement sums still equal the projection (BR-INV-003 tests) |
| **BR-INV-003** | **COMPLETE for the completion path** after the concurrency tests; still at risk for transfers/counts/waste |
| **FR-CST-001** | **COMPLETE** after implementation and verification — valuation is genuine current valuation per method |
| **FR-CST-002** | **PARTIAL** — unchanged |
| **FR-POS-024** | **COMPLETE** only with the config API + snapshot + passing no-cheese test |
| **NFR-PERF-006** | **PARTIAL until measured** (p95 ≤ 200 ms) |
| **§1.2 / UC-POS-01** | **PARTIAL** — not claimed COMPLETE |

**No mandatory requirement is left as a “documented open item” on the Completion path.**

## O. IMPLEMENTATION READINESS

| Criterion | Status |
|---|---|
| `fifo` + `fefo` honours **both** physical FEFO and accounting FIFO | ✔ §C–§G |
| Multi-batch consumption records every physical batch | ✔ §H–§I |
| COGS has exact cost-basis provenance | ✔ §L |
| Idempotency remains one business effect | ✔ §K |
| Concurrency design deterministic | ✔ §J |
| No mandatory requirement left as an open item on the Completion path | ✔ §N |

# **IMPLEMENTATION READY**

## P. FINAL SONNET PROMPT

**Supersedes all prior P1F-2 implementation prompts** (P1F-2A §AA, P1F-2C §N, P1F-2D §N).

---

```
# ROS — P1F-2
# FINAL PAYMENT + ORDER COMPLETION ATOMIC ORCHESTRATION
# MODEL: CLAUDE SONNET 5
#
# IMPLEMENTATION TASK. The design is SETTLED. Do not redesign, do not re-litigate.
#
# AUTHORITY (in order):
#   ROS_SRS_v1.0.pdf
#   > docs/governance/GOVERNANCE_DECISION_REGISTER.md — entries
#       "P1F-2 Completion Economics & Depletion Resolution — 2026-08-25"
#       "FIFO Exhaustion Carry-Forward Ratification — 2026-08-25"
#   > docs/reports/claude/2026-08-25_P1F2E_dual-axis-inventory-gate.md   <- CONTROLLING
#   > docs/reports/claude/2026-08-25_P1F2D_final-sanity-gate.md
#   > docs/reports/claude/2026-08-25_P1F2C_fifo-ratification-final-gate.md
#   > docs/reports/claude/2026-08-25_P1F2B_completion-correction-gate.md
#   > repository code
#
# READ IN FULL BEFORE WRITING CODE: P1F2E, then P1F2D, then P1F2C, then P1F2B.
# P1F-2A §AA, P1F-2C §N and P1F-2D §N are SUPERSEDED — ignore all three.
# Where documents differ, the LATER letter WINS (E > D > C > B).
# If a design document and the code disagree, STOP and report. Do not improvise.

====================================================================
A. REPOSITORY SAFETY
====================================================================
Expected branch: feat/production-spec
Expected HEAD:   cf04e008a35ba421b23b96b5fa6221a8dae5da12   (verify, do not assume)
Baseline: 27 migrations · OpenAPI 3.1.0 / 133 operations.
NEVER USE: git stash / reset / checkout / restore / clean / rebase /
           commit --amend / push --force / push --force-with-lease
NO branch operation. DO NOT COMMIT. DO NOT PUSH.
DO NOT TOUCH, format, stage or revert:
  .gitignore · src/main.ts · src/scripts/seed-dev-data.ts
Never migrate the persistent `ros` dev DB. Use a disposable scratch DB and set
BOTH DATABASE_URL and APP_DATABASE_URL (the app reads APP_DATABASE_URL).

====================================================================
B. THREE MODULE-OWNED MIGRATIONS — 27 -> 30
====================================================================
Never edit an existing migration. Never combine modules. Follow existing
conventions: header comment explaining WHY, composite tenant-safe FKs
(ADR 0008 D-09 / D-17-02), RLS ENABLE + FORCE, explicit grants.

MIGRATION 28 — SALES  (THREE new snapshot tables + two column/constraint changes)
 1. ALTER TABLE sales.orders ADD CONSTRAINT ck_completed
      CHECK (state <> 'completed' OR completed_at IS NOT NULL);       -- SRS §25.2
 2. ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;
    + CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0);
 3. CREATE TYPE sales."ModifierEffectOperationSnapshot" AS ENUM ('add','remove_all');
    CREATE TYPE sales."RecipeComponentTypeSnapshot"     AS ENUM ('stock_item','sub_recipe');
    -- DO NOT create a ConsumptionProvenance enum.
 4. sales.order_line_recipe_versions   (pinned version closure)
      id, tenant_id, business_day, order_line_id, recipe_version_id, depth, created_at
      UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)
      FK (tenant_id, order_line_id, business_day) -> sales.order_lines(tenant_id,id,business_day) CASCADE
      FK (tenant_id, recipe_version_id) -> production.recipe_versions(tenant_id,id) RESTRICT
 5. sales.order_line_modifier_effects  (pinned modifier effects)
      id, tenant_id, business_day, order_line_id, order_line_modifier_id,
      operation, component_type, stock_item_id NULL, sub_recipe_version_id NULL,
      quantity DECIMAL(18,6) NULL, unit_id NULL, sequence, created_at
      FKs: order_line_modifier (CASCADE), order_line (CASCADE),
           stock_items (RESTRICT), recipe_versions (RESTRICT), uom (RESTRICT)
      XOR CHECK on component; remove_all => component_type='stock_item'
        AND quantity IS NULL AND unit_id IS NULL;
      add => quantity IS NOT NULL AND quantity > 0 AND unit_id IS NOT NULL
      sub_recipe_version_id is a PINNED VERSION, never a logical recipe id.
 6. sales.order_line_component_conversions  (pinned conversion basis)
      id, tenant_id, business_day, order_line_id, stock_item_id,
      from_unit_id, base_unit_id, factor DECIMAL(20,10) NOT NULL, created_at
      UNIQUE (tenant_id, order_line_id, stock_item_id, from_unit_id)
      FKs: order_line CASCADE; stock_items RESTRICT; uom x2 RESTRICT
 ALL THREE Sales snapshot tables: NOT partitioned; tenant-anchored;
   GRANT SELECT, INSERT only; REVOKE UPDATE, DELETE, TRUNCATE;
   RLS ENABLE+FORCE with SELECT and INSERT policies ONLY.
 DO NOT create sales.order_line_consumption_components.

MIGRATION 29 — PRODUCTION
 1. CREATE TYPE production."ModifierEffectOperation" AS ENUM ('add','remove_all');
 2. production.modifier_recipe_effects
      id, tenant_id, modifier_id, operation, component_type, stock_item_id NULL,
      sub_recipe_id NULL, quantity DECIMAL(18,6) NULL, unit_id NULL, sequence, created_at
      REUSE the existing production."RecipeComponentType" enum — do NOT duplicate it.
      FK (tenant_id, modifier_id) -> catalogue.modifiers(tenant_id,id) CASCADE
      FK (tenant_id, stock_item_id) -> inventory.stock_items(tenant_id,id) RESTRICT
      FK (tenant_id, sub_recipe_id) -> production.recipes(tenant_id,id) RESTRICT
      FK (unit_id) -> inventory.uom(id) RESTRICT
      XOR + operation CHECKs; UNIQUE (tenant_id,id); INDEX (tenant_id, modifier_id)
      RLS ENABLE+FORCE, all four policies; GRANT SELECT, INSERT, UPDATE, DELETE
      (editable master data).
 3. Leave catalogue.modifiers.recipe_delta EXACTLY as is — opaque, never read.

MIGRATION 30 — INVENTORY  (dual-axis + allocations)
 1. ALTER TABLE inventory.stock_batches
      ADD COLUMN fifo_cost_quantity_consumed DECIMAL(18,6) NOT NULL DEFAULT 0;
    ADD CONSTRAINT ck_batch_cost_qty_range
      CHECK (fifo_cost_quantity_consumed >= 0
         AND fifo_cost_quantity_consumed <= quantity_received);
    BACKFILL: UPDATE inventory.stock_batches
              SET fifo_cost_quantity_consumed = quantity_received - quantity_remaining;
    (Cost-remaining is DERIVED: quantity_received - fifo_cost_quantity_consumed.
     `consumed` not `remaining` so DEFAULT 0 gives new batches full cost quantity
     and no batch-creation writer has to change.)
 2. inventory.sale_depletion_effects — NON-partitioned, PARENT / business identity
      id, tenant_id, order_id, business_day, order_line_id, stock_item_id,
      location_id, quantity_in_base_unit DECIMAL(18,6) NOT NULL, unit_id, created_at
      UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)  -- NO occurred_at
      FK (tenant_id, order_id, order_line_id, business_day)
         -> sales.order_lines(tenant_id, order_id, id, business_day) RESTRICT
      FK (tenant_id, stock_item_id), (tenant_id, location_id), (unit_id) RESTRICT
      NO cost columns, NO movement columns on the parent.
 3. inventory.sale_depletion_allocations — NON-partitioned, CHILD
      id, tenant_id, effect_id, sequence SMALLINT NOT NULL,
      physical_batch_id UUID NULL, cost_basis_batch_id UUID NULL,
      quantity_in_base_unit DECIMAL(18,6) NOT NULL CHECK (> 0), unit_id,
      unit_cost BIGINT NOT NULL, total_cost BIGINT NOT NULL,
      movement_id UUID NOT NULL, movement_occurred_at TIMESTAMPTZ NOT NULL, created_at
      UNIQUE (tenant_id, effect_id, sequence)
      FK (tenant_id, effect_id) -> sale_depletion_effects(tenant_id, id) RESTRICT
      FK (tenant_id, physical_batch_id)   -> stock_batches(tenant_id, id) RESTRICT
      FK (tenant_id, cost_basis_batch_id) -> stock_batches(tenant_id, id) RESTRICT
      FK (tenant_id, movement_id, movement_occurred_at)
         -> stock_movements(tenant_id, id, occurred_at) RESTRICT
      FK (unit_id) -> inventory.uom(id) RESTRICT
      INDEX (tenant_id, effect_id), (tenant_id, physical_batch_id),
            (tenant_id, cost_basis_batch_id)
 4. Both new tables: RLS ENABLE+FORCE; SELECT and INSERT policies ONLY;
    GRANT SELECT, INSERT; REVOKE UPDATE, DELETE, TRUNCATE.
 5. DO NOT alter stock_movements or stock_levels. NO exhausted_at. NO new index there.

====================================================================
C. SALES
====================================================================
LINE CAPTURE (OrderLinesService.create, SAME existing transaction):
  Call Production's resolveConsumptionBasis ONCE and persist all THREE snapshots:
    order_line_recipe_versions · order_line_modifier_effects ·
    order_line_component_conversions
  Record applied REMOVE_ALL operations in the line-capture AUDIT metadata
  (P1C-5 item-7 precedent — no extra table).
  DO NOT snapshot resolved/net consumption quantities. DO NOT snapshot valuation.
  Do NOT change existing pricing/tax/unit_cost_snapshot behaviour.
  IN-SCOPE MICRO-FIX: recomputeOrderTotals does
      cogs = (cogs ?? 0n) + line.unitCostSnapshot
  ignoring quantity. Multiply by line.quantity with ONE HALF_UP rounding.
  Change nothing else there. Test that a qty=3 line contributes 3x.

COMPLETION:
  - order-state.ts: add 'completed' as a legal target from BOTH 'open' AND
    'partially_paid'. NEVER persist an intermediate state.
  - Order CAS is the LAST mutation: paid_total, rounding_adjustment,
    state='completed', completed_at, closed_by (the EMPLOYEE — P1D-E),
    cogs_total, version+1.
  - order_lines.posted_cogs_total = exact bigint SUM of that line's ALLOCATION
    total_cost values. Absent recipe posts 0 (not NULL). NULL = not completed.
  - orders.cogs_total = exact bigint SUM of line posted totals. No rounding at
    either level. Document the post-completion meaning in the schema comment.
  - Audits: PAYMENT_CAPTURED (unchanged) AND a new ORDER_COMPLETED action
    (entity 'order', before{state,version,paidTotal}, gaps, movement ids,
    posted COGS). A new audit action is ordinary taxonomy, NOT a permission.
  - Publish order.completed, ORDER_COMPLETED_EVENT_VERSION = 1, payload EXACTLY
    per SRS §24.2.4. Invent no fields. ZERO subscribers in P1F-2 — report that
    honestly; do not claim literal §5.5.2 subscriber compliance.
  - Migrate SalesPaymentService from prisma.withAuthContext to unitOfWork.execute
    (SalesFireService is the precedent) so it can publish.
  - Remove FULL_PAYMENT_REQUIRES_COMPLETION only once the settling path is green;
    replace its test with completion tests — do not delete coverage.

====================================================================
D. PRODUCTION
====================================================================
NEW src/modules/production/contract/ — EXACTLY TWO methods, tx-first:
 1. resolveConsumptionBasis(tx, {tenantId, recipeVersionId|null, modifierIds[]})
      -> { versionClosure[], modifierEffects Map, conversions[] }
      CALLED AT LINE CAPTURE ONLY.
      Returns NO resolved/net consumption quantities and NO money. Configured
      modifier ADD quantities and pinned conversion factors ARE part of it.
 2. planConsumption(tx, {lines:[{orderLineId, recipeVersionId|null,
        pinnedVersionIds[], quantity, modifierEffects[], conversions[]}]})
      -> { perLine:[{orderLineId, components:[{stockItemId,
           quantityInBaseUnit, unitId}], gaps[]}] }
      CALLED AT COMPLETION ONLY. Performs the REAL recursive expansion:
      sub-recipe recursion, yield/wastage arithmetic, existing depth-10 and cycle
      guards, modifier application, within-line aggregation.
      MUST resolve sub-recipes ONLY to versions in pinnedVersionIds and take
      conversion factors ONLY from the pinned `conversions` input.
      MUST NOT read uom_conversions or stock_items.base_unit_id.
 Extend the EXISTING RECIPE_COST_RECOMPUTER port with:
      recomputeForStockItems(tx, stockItemIds) -> string[]
 Implementations live OUTSIDE contract/ and reuse RecipeCostService's traversal.

MODIFIER SEMANTICS (deterministic, no DSL), per line at COMPLETION:
  1 expand base recipe from the PINNED closure
  2 aggregate per stock_item WITHIN the line
  3 apply ALL REMOVE_ALL  (zero that stock item's aggregate)
  4 apply ALL ADD         (expand sub-recipe ADDs, convert via pinned factors, scale)
  5 re-aggregate, drop non-positive
 REMOVE_ALL targets a stock_item only, removing EVERY occurrence at every depth.
 REMOVE_ALL of an absent component = NO-OP, not an error.
 ADD scaling = effect.quantity x order_line_modifiers.quantity x order_lines.quantity.
 ADD quantities are per SOLD PORTION — NOT divided by the base recipe yield.
 Removal STRICTLY precedes addition. NEVER read catalogue.modifiers.recipe_delta.

CONVERSION GAPS FAIL CLOSED: STRUCTURAL gaps (no_components /
 no_published_version) -> tolerate, deplete partially (BR-MNU-012).
 VALUATION gaps (no_valuation / no_unit_conversion) -> THROW, roll back.

NEW ROUTES (both — a full-replace PUT with no read-back is not operable):
  GET /modifiers/{modifierId}/recipe-effects   @RequirePermission(VIEW)  // recipe.view
  PUT /modifiers/{modifierId}/recipe-effects   @RequirePermission(EDIT)  // recipe.edit
 INVENT NO PERMISSION. PUT is a full replace shaped exactly like
 PUT /recipes/:id/versions/:v/lines. Validate XOR shape, add/remove_all field
 rules, kind<->effect consistency vs Modifier.kind (service-level; kind nullable
 for legacy rows). Validate modifierId via the composite FK +
 rethrowAsNotFoundOnFk -> 404. New audit action MODIFIER_RECIPE_EFFECTS_REPLACED.

====================================================================
E. INVENTORY — DUAL AXIS (P1F2E is CONTROLLING here)
====================================================================
NEW src/modules/inventory/contract/:
  SALE_DEPLETION_COMMAND + depleteForCompletedSale(tx, {tenantId, actorId,
    branchId, orderId, businessDay, occurredAt, lines})
  Inventory resolves the branch location itself from
    org.locations (tenant_id, location_type='branch', ref_id=branchId).
  Returns per line: {orderLineId, postedCogsTotal, effects[{allocations[]}]}.

TWO INDEPENDENT AXES — NEVER CONFLATE:
  stock_items.batch_strategy (fifo|fefo) -> WHICH PHYSICAL batch is decremented.
  stock_items.costing_method             -> WHAT COST is charged.
Both must be honoured simultaneously. FEFO cost is NEVER called FIFO. The
fifo+fefo combination is NEVER refused and NEVER falls back to another method.

Process distinct (stock_item_id, location_id) ASC, then order_line_id ASC.
NEVER JS map iteration order.

STEP 1 — ONE LOCK SET COVERING BOTH AXES, per (stock_item, location):
  SELECT id, quantity_remaining, quantity_received, fifo_cost_quantity_consumed,
         unit_cost, created_at, expiry_date
  FROM inventory.stock_batches
  WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
    AND ( quantity_remaining > 0
       OR (quantity_received - fifo_cost_quantity_consumed) > 0 )
  ORDER BY created_at ASC, id ASC        -- ONE ordering for BOTH axes
  FOR UPDATE;                             -- NEVER SKIP LOCKED
  Compute BOTH plans from this locked snapshot, then mutate. Never take physical
  locks in one order and accounting locks later in another.

STEP 2 — PHYSICAL PLAN (batch_strategy):
  eligible: quantity_remaining > 0
  order:    fifo -> created_at ASC, id ASC
            fefo -> expiry_date ASC NULLS LAST, created_at ASC, id ASC
  Emit (physical_batch_id, qty). Unbacked remainder -> physical_batch_id = NULL
  (negative stock is permitted, FR-INV-014). Decrement quantity_remaining.

STEP 3 — COST PLAN:
  weighted_average -> single slice (cost_basis_batch_id NULL,
                      unit_cost = stock_levels.average_cost). Outbound NEVER
                      changes average_cost.
  standard         -> single slice (NULL, stock_items.standard_cost). No fallback.
  fifo (batch-tracked):
    eligible: (quantity_received - fifo_cost_quantity_consumed) > 0
    order:    created_at ASC, id ASC          -- RECEIPT ORDER ALWAYS (FR-INV-013),
                                              -- regardless of batch_strategy
    Emit (cost_basis_batch_id, qty, layer unit_cost);
    increment fifo_cost_quantity_consumed.
    CARRY-FORWARD (ratified) for any uncovered remainder — run AFTER the cost
    increments, serving partial- AND zero-coverage with one query:
      SELECT unit_cost FROM inventory.stock_batches
      WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
        AND (quantity_received - fifo_cost_quantity_consumed) = 0
      ORDER BY created_at DESC, id DESC LIMIT 1;
    Such a slice has cost_basis_batch_id = NULL and the carried unit_cost.
    NO weighted-average, NO standard, NO latest-purchase fallback for FIFO.
    If no exhausted accounting layer exists either -> throw a distinct domain
    error and roll the WHOLE Completion back.
  Do NOT modify valuationUnitCost.

STEP 4 — ZIPPER (exact Decimal, no floating point):
  Two-pointer merge of physical and cost plans over the same total D:
    take = min(physical.remaining, cost.remaining)
    emit { physicalBatchId, costBasisBatchId, quantity: take, unitCost }
  Sum of emitted quantities MUST equal D exactly.
  For non-FIFO costing the cost plan is one slice, so this degenerates to one
  allocation per physical batch.

STEP 5 — PER-ALLOCATION WRITE, in deterministic order. Exactly three statements
each (projection-first-with-pointer is FK-ILLEGAL: stock_levels.last_movement_id
is an IMMEDIATE composite FK and no DEFERRABLE constraint exists here):
  1) INSERT INTO inventory.stock_levels (tenant_id, stock_item_id, location_id,
         quantity_on_hand)
     VALUES ($1,$2,$3,$4::numeric)                 -- signed delta (negative)
     ON CONFLICT (stock_item_id, location_id) DO UPDATE
        SET quantity_on_hand = inventory.stock_levels.quantity_on_hand
                             + EXCLUDED.quantity_on_hand
     RETURNING quantity_on_hand;
     -- does NOT touch last_movement_*; does NOT touch average_cost
  2) INSERT the stock_movement with balance_after = the value returned by (1),
     movement_type='sale_depletion', reference_type='order',
     reference_id = ORDER id (NOT order_line_id), quantity NEGATIVE,
     unit = the stock item's base unit,
     batch_id = physical_batch_id  (NULL only for an unbacked slice),
     unit_cost = the ACTUAL cost-basis unit cost (NEVER blended).
  3) UPDATE inventory.stock_levels SET last_movement_id=$m,
        last_movement_occurred_at=$t WHERE stock_item_id=$2 AND location_id=$3;
  Do NOT batch allocations into one projection delta — per-movement
  balance_after must stay truthful (BR-INV-003).

STEP 6 — ARITHMETIC (exact, ONE rounding point PER ALLOCATION):
  allocation.total_cost = round_half_up(quantity × unit_cost)   POSITIVE magnitude
  quantity is NEGATIVE on the movement; total_cost is POSITIVE (repo convention,
  test-locked by costing.spec.ts:184-186 — a deliberate §7.4.3 deviation).
  Posted COGS comes from total_cost ONLY — never recompute unit_cost × quantity.

STEP 7 — EFFECT + ALLOCATION ROWS:
  Reserve the PARENT first, conflict-safely:
    INSERT INTO inventory.sale_depletion_effects (...)
    ON CONFLICT (tenant_id, order_line_id, stock_item_id, location_id) DO NOTHING
    RETURNING id;
    0 rows => raise a conflict; the WHOLE transaction rolls back.
    NEVER INSERT-catch-P2002-then-query (P1E-5A rejected it).
  Only the winning parent may decrement physical quantities, advance
  fifo_cost_quantity_consumed, alter stock_levels, or create allocations/movements.
  Then INSERT one sale_depletion_allocations row per allocation, sequence 0..N-1.
  ASSERT Σ allocations.quantity_in_base_unit == effect.quantity_in_base_unit.

COUNTER MAINTENANCE ELSEWHERE:
  Extend MovementsService.post so that, for costing_method='fifo' batch-tracked
  items ONLY, an outbound consumption also advances fifo_cost_quantity_consumed
  in RECEIPT order by the same total quantity. This is COUNTER MAINTENANCE ONLY —
  do NOT change valuationUnitCost and do NOT change how transfers/waste/counts
  are valued. Without it the accounting queue drifts from physical reality.

NEGATIVE STOCK NEVER BLOCKS COMPLETION (FR-INV-014, UC-POS-01 13a).
Recipe-cost recomputation: call recomputeForStockItems ONCE, after all movements,
with the DISTINCT FIFO stock items only.

====================================================================
F. ONE UNITOFWORK TRANSACTION
====================================================================
  1 permanent Payment-id replay/conflict check   (MUST BE FIRST)
  2 load order + non-voided lines + all three pinned snapshots
  3 assertMayCapturePayment  4 assertVersion  5 CashSession facts
  6 pinned payment policy    7 tender computation   8 settlement decision
  9 insert immutable Payment
  PARTIAL  -> 10a existing P1F-1 CAS
  SETTLING -> 10b planConsumption (REAL recursive expansion from pinned inputs)
              11b depleteForCompletedSale (dual-axis; returns valued allocations)
              12b recomputeForStockItems (distinct FIFO items only)
              13b write order_lines.posted_cogs_total from the allocations
              14b Order CAS (LAST mutation)
  15 audit PAYMENT_CAPTURED   16 audit ORDER_COMPLETED
  17 publish order.completed  18 dispatcher drain   19 re-read   20 COMMIT
No nesting. No outbox for same-DB consequences. No cross-module private query.
NEVER write posted COGS before depletion succeeds. NEVER complete the Order
before depletion + COGS succeed. NEVER leave a Payment committed if a mandatory
consequence fails.

====================================================================
G. IDEMPOTENCY
====================================================================
  1 HTTP Idempotency-Key (FR-API-020/022/023) — unchanged interceptor
  2 permanent client Payment id (FR-OFF-015) — step 1, BEFORE any completion
    read/write. Identical facts -> replay; differing immutable fact -> 409.
  3 sale_depletion_effects UNIQUE key — defence in depth.
No separate completion-operation id.

====================================================================
H. REQUIRED TESTS
====================================================================
FINANCIAL: OPEN -> COMPLETED via one settling payment; PARTIALLY_PAID ->
  COMPLETED; partial stays PARTIALLY_PAID; exact settlement; over-tendered cash
  + change; manual external card; Payment permanent-id replay AFTER completion;
  HTTP replay after completion; same Payment id different facts -> 409;
  stale If-Match -> 409.
ATOMICITY: force a failure at EACH mandatory stage — expansion, modifier
  resolution, effect reservation, allocation insert, stock movement, batch
  update, cost-counter update, stock-level projection, COGS projection, Order
  CAS, audit, order.completed handler — and prove TOTAL rollback: no Payment,
  no completion, no partial depletion, no partial COGS, no audit residue.
DUAL-AXIS (NEW, mandatory):
  - fifo costing + fifo physical strategy: physical and cost plans coincide.
  - fifo costing + FEFO physical strategy: physical batches consumed in EXPIRY
    order while accounting costs consume in RECEIPT order; assert both.
  - one OrderLine spanning >= 2 physical batches: EVERY batch attributable via
    allocations and via stock_movements.batch_id.
  - one physical batch split across >= 2 FIFO accounting cost layers.
  - one FIFO cost layer applied across >= 2 physical FEFO batches.
  - negative/unbacked remainder uses carry-forward (cost_basis_batch_id NULL).
  - Σ allocation quantities == requested depletion exactly.
  - Σ allocation total_cost == line posted_cogs_total, and Σ lines == orders.cogs_total.
  - PROVE NO weighted-average fallback: make average_cost differ sharply from
    the layer cost and assert the layer cost wins.
  - no-historical-layer case fails closed.
TRACEABILITY: batch -> Orders/OrderLines; Order -> physical batches;
  OrderLine -> cost-basis layers; effect -> all its movements.
INVENTORY: nested expansion; same stock item via multiple sub-recipe paths
  aggregated WITHIN a line; same stock item on two lines independently
  traceable; absent recipe (0 depletion, posted COGS 0); incomplete recipe;
  negative stock; each costing method.
MODIFIERS: ADD; REMOVE_ALL; substitution; the "no cheese" case depletes NO
  cheese; REMOVE_ALL of an absent component is a no-op; double-modifier scaling;
  a later edit to modifier_recipe_effects does NOT change a captured line.
HISTORICAL PINNING: changing StockItem.base_unit_id or a uom_conversions factor
  after line capture does NOT change that line's completed depletion.
CONVERSION GAPS: VALUATION/conversion gap rolls back, NOT silently zeroed;
  STRUCTURAL gap depletes partially.
IDEMPOTENCY: exact replay creates ZERO duplicate effects, allocations, movements,
  projection deltas, COGS or audit entries.
CONCURRENCY (real PostgreSQL barriers, NO sleeps, >=3 clean runs each):
  1 two settling Payments, same Order, same version -> exactly one winner;
  2 two different Orders, same weighted-average item -> BR-INV-003:
    SUM(stock_movements.quantity) == stock_levels.quantity_on_hand;
  3 two different Orders, same FIFO item, overlapping PHYSICAL and COST layers
    -> deterministic consumption on BOTH axes, correct per-order costs,
    no double consumption of either counter;
  4 lock-order inversion: two completions touching the same two stock items in
    opposite input order -> both succeed, no deadlock.
RLS / APPEND-ONLY / FK: via the REAL ros_app connection (app.get(PrismaService)),
  never the migrator client — own-tenant SELECT/INSERT succeed; cross-tenant
  blocked; UPDATE and DELETE rejected on effects AND allocations; row survives
  the failed mutation; grants inspected from information_schema; allocation
  cannot point at the wrong effect / batch / movement.
MODULE BOUNDARIES: Production's and Inventory's contract/ files are
  interface-only; impls outside contract/; sales-payment.service.ts imports them
  ONLY from <module>/contract; KNOWN_DEVIATIONS DOES NOT GROW.

====================================================================
I. BUILD / VERIFY
====================================================================
  nest build; npx tsc --noEmit (only the known access-token.service.spec.ts
    baseline error may remain — ZERO new); eslint on changed files;
    npx prisma validate; git diff --check
  npm run openapi:check -> 3.1.0 and EXACTLY 135 operations
    (133 + GET and PUT /modifiers/{modifierId}/recipe-effects). No /complete route.
  Clean FROM-ZERO scratch DB: 30 migrations, BOTH DATABASE_URL and
    APP_DATABASE_URL set; drop it after; PROVE the persistent `ros` dev DB was
    never migrated (prisma migrate status with default env).
  Full unit suite + full E2E suite, green.
  NFR-PERF-006: benchmark planConsumption (real recursive expansion) PLUS
    depleteForCompletedSale, inside the Completion transaction. 30 lines,
    genuinely NESTED recipes (depth >= 2), mixed costing methods, multi-batch
    FIFO items, modifiers present. >=20 iterations. Report p50 AND p95. Report
    COMPLETE only if measured p95 <= 200 ms; otherwise PARTIAL with the real number.
  DO NOT COMMIT. DO NOT PUSH.

====================================================================
NON-GOALS
====================================================================
No refunds/voids/reversals. No PaymentAttempt or integrated card. No receipt.
No fiscal document or outbox. No loyalty/CRM. No table release. No session/day
close. No X/Z reports. No comp mechanism. No Costing module. No separate
accounting cost-layer TABLE (the batch is the cost layer). No new permission.
No RFC7807. No /v1. No FR-INV-027 reporting surface (substrate only). Do NOT fix
MovementsService.post's lost update for transfers/counts/waste. Do NOT change
valuationUnitCost or how transfers/waste/counts are VALUED. Do NOT retire the
existing sales->production KNOWN_DEVIATIONS entry. Do NOT add exhausted_at or
any other stock_movements / stock_levels schema change.

====================================================================
REPORT
====================================================================
Write docs/reports/claude/2026-08-26_P1F2_order-completion.md with the required
ROS header. Include full verification evidence, MEASURED p50/p95, exact test
counts, every deviation and residual risk, and honest reporting of any failure.
Use these classifications and do NOT overclaim:
  FR-INV-012 COMPLETE for the completion path
  FR-INV-013 COMPLETE for the completion path (receipt-order costing AND every
    physical batch recorded); NOT claimed globally — transfers/waste/counts are
    unchanged
  FR-INV-022/023 COMPLETE · FR-INV-027 substrate only, reporting NOT IMPLEMENTED
  FR-INV-030 COMPLETE for sales · BR-INV-003 COMPLETE for the completion path
  FR-CST-001 COMPLETE (after verification) · FR-CST-002 PARTIAL
  FR-POS-024 COMPLETE only with the config API + snapshot + passing no-cheese test
  NFR-PERF-006 PARTIAL unless measured · §1.2 PARTIAL · UC-POS-01 PARTIAL
Update docs/reports/claude/INDEX.md.

DEFINITION OF DONE: 30 migrations from zero on a clean scratch DB; full unit +
full E2E green; concurrency tests >=3 clean runs each; ALL dual-axis and
traceability tests green including the no-weighted-average-fallback proof and
the fifo-costing+fefo-strategy case; historical-pinning tests green; performance
measured and reported; OpenAPI 3.1.0 / 135 with zero drift; tsc clean apart from
the known baseline; report + INDEX written; nothing committed or pushed; the
three preserved user files untouched.
```
