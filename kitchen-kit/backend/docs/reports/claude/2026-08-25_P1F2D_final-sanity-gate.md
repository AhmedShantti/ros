# P1F-2D — Final Implementation Sanity Gate

**Report type:** Narrow design correction + final readiness gate (no production code, no production migration, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence**. Nothing here creates or amends a governance decision.
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (verified unchanged — no commit)
**Branch:** `feat/production-spec`
**Working tree:** three preserved user files, the P1F-2 / P1F-2A / P1F-2B / P1F-2C reports, the governance register, INDEX, plus this report
**Task identifier:** P1F-2D

> ## VERDICT (§M)
> ## **IMPLEMENTATION READY**
> All three issues are resolved without reopening any ratified governance.
> **C-11** needs no new cost-layer table — a source-compatible interpretation is
> proven, and the carry-forward query is corrected onto the receipt-order axis.
> **C-13 Option A is adopted**, which **dissolves C-12 by construction**: no
> aggregated net row is persisted, so no column can become false.
> Migrations remain **30**; OpenAPI becomes **135**.

---

## A. STARTING STATE

| Check | Result |
|---|---|
| Branch | `feat/production-spec` |
| HEAD | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` |
| `origin/feat/production-spec` | `cf04e008…` — matches |
| Migrations | **27** · OpenAPI **3.1.0 / 133** |
| Preserved user files | untouched |

No branch operation, no destructive git command, no commit, no push, no production code.

## B. ACCEPTED P1F-2C BASELINE

Everything in §8 of the governing task is preserved untouched: the **FIFO Exhaustion Carry-Forward Ratification**, D-17-05's completion-COGS reopening, D-17-07's ADD/REMOVE_ALL reopening, `posted_cogs_total`, FR-CST-002 **PARTIAL**, the effect-registry natural key, line-scoped depletion, one effect = one movement, positive `total_cost` magnitude, exact Rational/bigint costing, the atomic additive stock-level update, the FK-safe three-statement write order, deterministic locking, no `SKIP LOCKED`, fail-closed conversion gaps, append-only Sales snapshots, UnitOfWork atomicity, the Payment route as trigger, `pos.payment.capture`, `order.completed` v1, Order CAS last, no Costing module, no `/complete` route.

**C-11 does not mechanically require a change to the Inventory cost-layer representation** (§C), so nothing in that list moves.

## C. FIFO COSTING VS BATCH CONSUMPTION (C-11)

### The two axes, as the repository already models them

| Axis | Column | Values | Governs |
|---|---|---|---|
| **Physical consumption** | `stock_items.batch_strategy` | `fifo` \| `fefo` | *Which* batch is decremented — FR-INV-022 / FR-INV-023 |
| **Valuation** | `stock_items.costing_method` | `weighted_average` \| `fifo` \| `standard` | *What cost* is recorded — FR-INV-012 |

`docs/inventory/INVENTORY_DESIGN_GATE.md` §12 already states the separation verbatim (*"FEFO is never assumed to imply FIFO costing"*), and its §29 records the combination as an explicit non-invention: *"FEFO batch selection combined with FIFO costing — the SRS does not define the cost basis. The design records `batch_id` and `unit_cost` on every movement so either reading remains satisfiable later. **Not invented.**"*

### Answers

**A. Which physical batch quantity is decremented?**
The batch chosen by `batch_strategy`, via `selectBatches` (`costing.ts:55-86`) — FIFO: `receivedAt` ascending; FEFO: `expiryDate ?? +∞` ascending, then `receivedAt`. Only layers with `quantity_remaining > 0` are eligible; the shortfall is returned and never blocks. **Unchanged by P1F-2.**

**B. Which cost layers determine COGS?**
The **batches actually consumed**, each valued at **its own `unit_cost`**. This is the repository's existing, documented behaviour (`costing.ts:135-141`: *"FIFO valuation reads `consumed`, which was produced by the batch strategy"*). P1F-2 makes it stricter, not looser: P1F-2C §E already replaced the old single blended mean with per-layer valuation summed exactly (§H of that report).

**C. Which batch identity is recorded for traceability?**
`stock_movements.batch_id` when exactly one layer was consumed (existing convention, `movements.service.ts:171`), satisfying FR-INV-013's *"consumption SHALL record which batch was consumed"* for the single-layer case. Multi-layer consumption records the aggregate `total_cost` and, in P1F-2, one `sale_depletion_effects` row per `(order_line, stock_item, location)`. **No change to `reference_type`/`reference_id`.**

**D. How can FIFO valuation remain receipt-order based if physical consumption is FEFO?**
For the *consumed set*, it cannot — and **the SRS does not require it to**. FR-INV-013's receipt-order clause is scoped to FIFO valuation of a batch-tracked item; FR-INV-022/023 then deliberately override consumption order for physical (spoilage) reasons, and the SRS supplies no rule for the resulting cost basis. That is exactly the gap Inventory's ratified design recorded and declined to invent. P1F-2 does not invent it either: it preserves the existing behaviour and classifies the `fefo` + `fifo` combination as the **documented open item**, not as FIFO compliance.
Where P1F-2 *does* introduce a new valuation rule — the carry-forward basis — it is placed on the **receipt-order axis**, which is FR-INV-013's own valuation axis (§E).

**E. Can the current schema represent independent physical flow and accounting cost flow?**
**No.** `stock_batches` carries a single `quantity_remaining`; there is no second "cost-layer remaining" quantity, and no accounting-layer table exists. Representing the two flows independently would require a new cost-layer entity.

### Verdict — **NOT BLOCKED; no new cost-layer table**

A source-compatible simpler interpretation is proven: **for a batch-tracked item, the FIFO cost layer *is* the physical batch.** The SRS models FIFO valuation entirely in terms of batches — FR-INV-012 says *"the cost of the oldest remaining **batch**"*, FR-INV-013 says *"…record which **batch** was consumed"*, and §24.5.2's `FifoCostingStrategy` reads `this.batches.availableOrdered(...)`. **The SRS never posits an accounting layer distinct from the physical batch.** The two axes therefore differ only in *selection order*, not in the objects selected.

Creating a separate accounting cost-layer table would invent semantics the SRS does not define and that Inventory's ratified design explicitly declined to invent — and would additionally require reopening the closed Inventory context. **P1F-2 must not create one.** Recorded as a future option should Procurement/central-kitchen work ever require true dual-flow accounting.

## D. FIFO/FEFO COMBINATION MATRIX

`is_batch_tracked = false` ⇒ `selectBatches` is never called (`movements.service.ts:124`), so no layer exists and no layer is decremented.

| `costing_method` | `batch_strategy` | Physical decrement | Valuation | FR-INV-013 receipt-order clause | Classification |
|---|---|---|---|---|---|
| `fifo` | `fifo` | oldest received first | each consumed layer at its own cost — **receipt order** | **satisfied literally** | **COMPLETE** |
| `fifo` | `fefo` | nearest expiry first | each consumed layer at its own cost — expiry order | **not applicable** — FR-INV-022/023 override the physical order and the SRS defines no cost basis | **DOCUMENTED OPEN ITEM** (Inventory gate §29). Behaviour preserved, not invented |
| `weighted_average` | `fifo` \| `fefo` | per strategy | `stock_levels.average_cost`; outbound never changes it | n/a | COMPLETE |
| `standard` | `fifo` \| `fefo` | per strategy | `stock_items.standard_cost` (CHECK-guaranteed non-null); **no fallback** | n/a | COMPLETE |
| `fifo` | n/a (`is_batch_tracked = false`) | none | no layers ever ⇒ unsellable with a complete recipe (P1C-5 refusal at capture) | n/a | unreachable via the sale path |

**The implementation must not conflate the axes**: `batch_strategy` selects; `costing_method` values. A `fefo` + `fifo` item is depleted in expiry order and costed at those layers' costs, and the report must classify that as the open item — never as FIFO compliance.

## E. CARRY-FORWARD COST LAYER — **corrected**

The ratified **FIFO Exhaustion Carry-Forward** rule stands. P1F-2C §G resolved the carry-forward layer using the item's `batch_strategy` ordering, branching to FEFO order for FEFO items. **That is corrected.**

**Corrected rule: for `costing_method = 'fifo'`, the carry-forward layer is always resolved by RECEIPT order, regardless of `batch_strategy`.**

```sql
SELECT unit_cost
FROM inventory.stock_batches
WHERE tenant_id = $1 AND stock_item_id = $2 AND location_id = $3
  AND quantity_remaining = 0
ORDER BY created_at DESC, id DESC
LIMIT 1;
```

Justification:
- FR-INV-013 ties **FIFO valuation** to **batch receipt order**. Carry-forward is a *valuation* rule, so it belongs on the valuation axis — not the physical-consumption axis.
- For `batch_strategy = 'fifo'` the two orderings are **identical**, so nothing changes for the compliant combination.
- For `fefo` + `fifo` — the SRS-undefined combination — receipt order is the only ordering FR-INV-013 actually names, and using it keeps the *new* rule P1F-2 introduces receipt-order-faithful rather than compounding the undefined case.
- It removes the strategy branch entirely: **one query, no `batch_strategy` input, deterministic** (`id DESC` tie-break).

**Partial-coverage simplification (also corrected).** P1F-2C treated partial coverage specially (*"the last layer in our own consumption plan"*), which under FEFO is not the receipt-order-latest. Corrected: an unbacked remainder means the queue is now empty, so **the same single query serves both cases**, run *after* the batch decrements are applied — at which point the layers just consumed are themselves exhausted and eligible. One rule, one query, both paths.

The backed portion is still valued **per layer at its own cost**; only the unbacked remainder uses carry-forward. Zero-layer, no-history remains **fail closed** (P1F-2C §F) — never another costing method.

## F. NET CONSUMPTION SNAPSHOT (C-12) — **dissolved**

The contradiction was real: `UNIQUE (tenant_id, order_line_id, stock_item_id)` aggregates `cheese = 20g (recipe) + 10g (modifier A) + 5g (modifier B) = 35g`, for which no single `provenance` or `order_line_modifier_id` is truthful.

**Under §G's Option A the aggregated row is not persisted at all**, so the defect cannot exist:

- **`sales.order_line_consumption_components` is REMOVED** from the design.
- **The `sales."ConsumptionProvenance"` enum is REMOVED** — it becomes unnecessary.
- What *is* snapshotted are the **inputs**, each of which carries honest, non-aggregated identity: modifier effects (real `order_line_modifier_id`) and conversion factors (real `from_unit_id`). Aggregation happens in memory at Completion and is never written as a row claiming a single source.

Per-source provenance therefore remains fully recoverable — from `order_line_modifiers`, the snapshotted effects, and the line-capture audit — **without any column whose value becomes false after aggregation**. No separate provenance child table is needed for P1F-2's scope (FR-POS-024 is proven by the *absence* of a cheese component; refunds are a non-goal).

## G. RECIPE EXPANSION TRANSACTION LOCATION (C-13) — **Option A adopted**

**NFR-PERF-006 [M]:** *"Recipe expansion **and** inventory depletion for a completed order of up to 30 lines SHALL complete within 200 ms at p95 and **SHALL execute within the order's transaction**."*

**Option A is adopted: Completion performs the recursive expansion, using only historically pinned inputs.** It is implementable cleanly, so the SRS's literal requirement is honoured rather than deviated from.

**Why it is clean — most inputs are already immutable and need no snapshot:**

- **Recipe structure is DB-frozen.** `recipe_lines` INSERT/UPDATE/DELETE policies each require `EXISTS (SELECT 1 FROM recipe_versions v WHERE v.id = recipe_version_id AND v.status = 'draft')`, and `recipe_versions` has `REVOKE UPDATE` with only a column-level `GRANT UPDATE("status")`, plus a `status='draft'`-predicated DELETE policy. So a **published** version's lines, yield, yield percentage and units **cannot change** (D-17-04 / GAP-2). Completion may safely re-read them.
- **The version closure** is pinned by `order_line_recipe_versions`, closing the late-bound sub-recipe hole.

**Only two genuinely mutable inputs must be snapshotted:**

1. **Modifier effects** — `production.modifier_recipe_effects` is editable master data ⇒ `sales.order_line_modifier_effects` (restored from P1F-2A, with `sub_recipe_version_id` pinned).
2. **Conversion basis** — `uom_conversions` is fully writable with no RLS, and `stock_items.base_unit_id` has a live route whose FR-INV-002 guard is vacuous until sales write movements (P1F-2B §E) ⇒ **`sales.order_line_component_conversions`**, pinning the resolved factor and target base unit per `(order_line, stock_item, from_unit)`.

**At Completion**, Production expands recursively from the pinned closure + pinned modifier effects + pinned conversion factors, and **never reads `uom_conversions` or `stock_items.base_unit_id`**. No historical reinterpretation is possible, and a genuine expansion phase exists to benchmark.

**Valuation is untouched**: nothing about Inventory valuation is snapshotted; valuation remains Completion-time current valuation per §C/§E.

Net effect on the design: one Sales table is removed (`order_line_consumption_components`), two are present (`order_line_modifier_effects` restored, `order_line_component_conversions` new), and `order_line_recipe_versions` is retained — **three Sales snapshot tables, all append-only**.

## H. PRODUCTION CONTRACT LIFECYCLE

The P1F-2C ambiguity (calling `planConsumption` at both moments) is removed. **Exactly two contract methods, at two distinct moments.**

### 1. `resolveConsumptionBasis` — LINE CAPTURE

| | |
|---|---|
| **OWNER** | Production |
| **CALLER** | Sales — `OrderLinesService.create` |
| **WHEN** | Line capture, inside the existing line-capture transaction |
| **INPUT** | `tx`, `{ tenantId, recipeVersionId \| null, modifierIds[] }` |
| **OUTPUT** | `{ versionClosure: {recipeVersionId, depth}[], modifierEffects: Map<modifierId, ResolvedEffect[]>, conversions: {stockItemId, fromUnitId, factor: string, baseUnitId}[] }` — **no money, no quantities** |
| **WHY PRODUCTION** | It owns the recipe graph, sub-recipe resolution and unit-conversion semantics (§25.1, ratified §3.1.G). Sales must not walk `recipe_lines` or read `uom_conversions`. |

Sales persists all three outputs as append-only snapshots. The traversal is a by-product of the recipe-cost expansion Sales **already** performs at capture, so no second walk is added.

### 2. `planConsumption` — COMPLETION

| | |
|---|---|
| **OWNER** | Production |
| **CALLER** | Sales — the settling-payment path |
| **WHEN** | Completion, inside the Completion UnitOfWork |
| **INPUT** | `tx`, `{ lines: [{ orderLineId, recipeVersionId \| null, pinnedVersionIds[], quantity, modifierEffects[], conversions[] }] }` |
| **OUTPUT** | `{ perLine: [{ orderLineId, components: [{stockItemId, quantityInBaseUnit, unitId}], gaps: [] }] }` |
| **WHY PRODUCTION** | It performs the **real recursive expansion** — sub-recipe recursion, yield/wastage arithmetic, depth-10 and cycle guards, modifier ADD/REMOVE_ALL application and within-line aggregation. This is genuine computation, **not** a pass-through of data Sales already owns. It resolves sub-recipes **only** to versions present in `pinnedVersionIds`, and takes conversion factors **only** from the pinned input. |

Plus, on the **existing** `RECIPE_COST_RECOMPUTER` port: `recomputeForStockItems(tx, stockItemIds)` — called once at Completion, after all movements, with the distinct **FIFO** items only.

**No method returns data Sales already owns unchanged.** Method 1 resolves facts Sales cannot compute; method 2 performs expansion Sales must not implement.

## I. MODIFIER CONFIGURATION API (§7)

`production.modifier_recipe_effects` is a **new** table, so by construction **no existing route exposes it**. Catalogue's `GET /catalogue/modifier-groups/:groupId/modifiers` returns `toModifierView(...)` over Catalogue's own `modifiers` columns and cannot surface a Production-owned table. **No read-back exists.**

A full-replace `PUT` with no way to read the current configuration is not an operable management surface — an editor cannot amend one effect without already knowing all of them.

**Both routes are therefore required**, following Production's existing read/write permission split exactly (reads → `VIEW`, writes → `EDIT`), inventing nothing:

| Method | Path | Permission | Shape |
|---|---|---|---|
| `GET` | `/modifiers/{modifierId}/recipe-effects` | `recipe.view` (`PRODUCTION_PERMISSIONS.VIEW`) | returns the full effect set |
| `PUT` | `/modifiers/{modifierId}/recipe-effects` | `recipe.edit` (`PRODUCTION_PERMISSIONS.EDIT`) | full replace, mirroring `PUT /recipes/:id/versions/:v/lines` |

**OpenAPI: 133 + 2 = 135** (§K).

## J. MIGRATIONS

**Unchanged count: 27 → 30.** C-11 requires no Inventory cost-layer table (§C), so migration 30 is untouched; C-12/C-13 only change migration 28's Sales table set.

**28 — SALES**
1. `ALTER TABLE sales.orders ADD CONSTRAINT ck_completed CHECK (state <> 'completed' OR completed_at IS NOT NULL);`
2. `ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;` + `CHECK (… IS NULL OR … >= 0)` — nullable, zero-downtime.
3. `CREATE TYPE sales."ModifierEffectOperationSnapshot" AS ENUM ('add','remove_all');` and `sales."RecipeComponentTypeSnapshot" AS ENUM ('stock_item','sub_recipe');`
   *(`ConsumptionProvenance` is **not** created — removed by C-12.)*
4. `sales.order_line_recipe_versions` — pinned version closure. `UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)`.
5. `sales.order_line_modifier_effects` — pinned modifier effects; XOR + operation CHECKs; `sub_recipe_version_id` (pinned version, never a logical recipe id).
6. **`sales.order_line_component_conversions`** *(new — C-13)* — `UNIQUE (tenant_id, order_line_id, stock_item_id, from_unit_id)`; `factor DECIMAL(20,10) NOT NULL`; `base_unit_id`; FKs to the order line (CASCADE), `inventory.stock_items` (RESTRICT), `inventory.uom` ×2 (RESTRICT).
   *(`sales.order_line_consumption_components` is **not** created — removed by C-12/C-13.)*

All four Sales snapshot tables are **NOT partitioned**, tenant-anchored, with composite tenant-safe FKs, **`GRANT SELECT, INSERT` only**, `REVOKE UPDATE, DELETE, TRUNCATE`, and RLS `ENABLE`+`FORCE` with **SELECT and INSERT policies only**.

**29 — PRODUCTION**: `production."ModifierEffectOperation"` enum; `production.modifier_recipe_effects` (reusing the existing `RecipeComponentType` enum; editable master data — full DML, all four policies).

**30 — INVENTORY**: `inventory.sale_depletion_effects` (non-partitioned, append-only, SELECT+INSERT only). **No change to `stock_batches` or `stock_movements`; no `exhausted_at`; no new index.**

## K. OPENAPI

**3.1.0 / 135 operations.** Baseline 133, **+2** for `GET` and `PUT /modifiers/{modifierId}/recipe-effects` (§I). Completion reuses `POST /orders/{businessDay}/{id}/payments`; **no `/complete` route**, no new Payment route. *(P1F-2B/C's 134 assumed PUT-only and is superseded.)*

## L. NFR-PERF-006

Under **Option A** a genuine expansion phase exists inside the Completion transaction, so the requirement is honoured literally — **no deviation is claimed, and none is needed**.

- Benchmark the **real** phase: `planConsumption` (recursive expansion) **plus** `depleteForCompletedSale` (valued depletion), both inside the Completion UnitOfWork.
- Fixture: 30 lines, genuinely **nested** recipes (sub-recipes at depth ≥ 2), mixed costing methods, modifiers present.
- ≥20 iterations; report **p50 and p95**.
- **Classification: PARTIAL until measured.** It may be reported COMPLETE only if a measured **p95 ≤ 200 ms** is stated in the implementation report. If it exceeds, report the real number as PARTIAL — do not tune the test to pass.
- The gate's warnings are satisfied by construction: this is not a snapshot read mislabelled as expansion, and the benchmarked phase genuinely exists.

## M. IMPLEMENTATION READINESS

| Issue | Resolution |
|---|---|
| **C-11** FIFO costing vs FIFO/FEFO consumption | Resolved — cost layer *is* the batch (source-proven); no new table; matrix in §D; carry-forward corrected onto the receipt-order axis (§E) |
| **C-12** aggregated snapshot provenance | **Dissolved** — no aggregated row is persisted; inputs carry honest identity; enum and table removed (§F) |
| **C-13** expansion location | **Option A** — real recursive expansion at Completion from pinned inputs; two new snapshot facts; NFR-PERF-006 honoured literally (§G) |
| Production contract lifecycle | Two methods, two distinct moments, no pass-through (§H) |
| Modifier configuration read-back | `GET` + `PUT`, `recipe.view` / `recipe.edit`, no permission invented (§I) |

Nothing outstanding requires inventing FIFO/FEFO semantics, snapshot provenance, completion-expansion semantics, contract lifecycle, or a modifier read surface.

# **IMPLEMENTATION READY**

## N. FINAL SONNET PROMPT

**Supersedes P1F-2A §AA and P1F-2C §N in full.** Do not use either.

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
#   > docs/reports/claude/2026-08-25_P1F2D_final-sanity-gate.md    <- CONTROLLING
#   > docs/reports/claude/2026-08-25_P1F2C_fifo-ratification-final-gate.md
#   > docs/reports/claude/2026-08-25_P1F2B_completion-correction-gate.md
#   > repository code
#
# READ IN FULL BEFORE WRITING CODE: P1F2D, then P1F2C, then P1F2B.
# P1F-2A §AA and P1F-2C §N are SUPERSEDED — ignore both.
# Where P1F2D differs from P1F2B/C, P1F2D WINS.
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

MIGRATION 28 — SALES
 1. ALTER TABLE sales.orders ADD CONSTRAINT ck_completed
      CHECK (state <> 'completed' OR completed_at IS NOT NULL);       -- SRS §25.2
 2. ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;
    + CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0);     -- nullable
 3. CREATE TYPE sales."ModifierEffectOperationSnapshot" AS ENUM ('add','remove_all');
    CREATE TYPE sales."RecipeComponentTypeSnapshot"     AS ENUM ('stock_item','sub_recipe');
    -- DO NOT create a ConsumptionProvenance enum.
 4. sales.order_line_recipe_versions
      id, tenant_id, business_day, order_line_id, recipe_version_id, depth, created_at
      UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)
      FK (tenant_id, order_line_id, business_day) -> sales.order_lines(tenant_id,id,business_day) CASCADE
      FK (tenant_id, recipe_version_id) -> production.recipe_versions(tenant_id,id) RESTRICT
 5. sales.order_line_modifier_effects
      id, tenant_id, business_day, order_line_id, order_line_modifier_id,
      operation, component_type, stock_item_id NULL, sub_recipe_version_id NULL,
      quantity DECIMAL(18,6) NULL, unit_id NULL, sequence, created_at
      FK (tenant_id, order_line_modifier_id) -> sales.order_line_modifiers(tenant_id,id) CASCADE
      FK (tenant_id, order_line_id, business_day) -> sales.order_lines(...) CASCADE
      FK (tenant_id, stock_item_id) -> inventory.stock_items(tenant_id,id) RESTRICT
      FK (tenant_id, sub_recipe_version_id) -> production.recipe_versions(tenant_id,id) RESTRICT
      FK (unit_id) -> inventory.uom(id) RESTRICT
      XOR CHECK on component; remove_all => component_type='stock_item'
        AND quantity IS NULL AND unit_id IS NULL;
      add => quantity IS NOT NULL AND quantity > 0 AND unit_id IS NOT NULL
      NOTE: sub_recipe_version_id is a PINNED VERSION, never a logical recipe id.
 6. sales.order_line_component_conversions          -- P1F2D §G
      id, tenant_id, business_day, order_line_id, stock_item_id,
      from_unit_id, base_unit_id, factor DECIMAL(20,10) NOT NULL, created_at
      UNIQUE (tenant_id, order_line_id, stock_item_id, from_unit_id)
      FK to order_lines CASCADE; FK (tenant_id, stock_item_id) RESTRICT;
      FK (from_unit_id), (base_unit_id) -> inventory.uom(id) RESTRICT
 ALL FOUR Sales snapshot tables: NOT partitioned; tenant-anchored;
   GRANT SELECT, INSERT only; REVOKE UPDATE, DELETE, TRUNCATE;
   RLS ENABLE+FORCE with SELECT and INSERT policies ONLY.
 DO NOT create sales.order_line_consumption_components. (Removed by P1F2D §F.)

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
      XOR + operation CHECKs as above; UNIQUE (tenant_id,id); INDEX (tenant_id, modifier_id)
      RLS ENABLE+FORCE, all four policies; GRANT SELECT, INSERT, UPDATE, DELETE
      (this IS editable master data).
 3. Leave catalogue.modifiers.recipe_delta EXACTLY as is — opaque, never read.

MIGRATION 30 — INVENTORY
 1. inventory.sale_depletion_effects — NON-partitioned
      id, tenant_id, order_id, business_day, order_line_id, stock_item_id,
      location_id, quantity_in_base_unit DECIMAL(18,6) NOT NULL, unit_id,
      unit_cost BIGINT NOT NULL, total_cost BIGINT NOT NULL,
      movement_id UUID NOT NULL, movement_occurred_at TIMESTAMPTZ NOT NULL, created_at
      UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)   -- NO occurred_at
      FK (tenant_id, order_id, order_line_id, business_day)
         -> sales.order_lines(tenant_id, order_id, id, business_day) RESTRICT
      FK (tenant_id, movement_id, movement_occurred_at)
         -> inventory.stock_movements(tenant_id, id, occurred_at) RESTRICT
      FK (tenant_id, stock_item_id), (tenant_id, location_id), (unit_id) RESTRICT
 2. RLS ENABLE+FORCE; SELECT and INSERT policies ONLY.
 3. GRANT SELECT, INSERT; REVOKE UPDATE, DELETE, TRUNCATE.
 4. DO NOT alter stock_movements or stock_batches. NO exhausted_at. NO new index.

====================================================================
C. SALES
====================================================================
LINE CAPTURE (OrderLinesService.create, SAME existing transaction):
  Call Production's resolveConsumptionBasis ONCE and persist all three snapshots:
    - order_line_recipe_versions      (pinned version closure)
    - order_line_modifier_effects     (pinned modifier effects)
    - order_line_component_conversions(pinned factor + base unit)
  Record applied REMOVE_ALL operations in the line-capture AUDIT metadata
  (P1C-5 item-7 precedent — no extra table).
  DO NOT snapshot quantities. DO NOT snapshot valuation.
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
  - order_lines.posted_cogs_total = exact bigint SUM of that line's effect
    total_cost. Absent recipe posts 0 (not NULL). NULL means "not completed".
  - orders.cogs_total = exact bigint SUM of line posted totals. No rounding at
    either level. Document the post-completion meaning in the schema comment.
  - Audits: PAYMENT_CAPTURED (unchanged) AND a new ORDER_COMPLETED action
    (entity 'order', before{state,version,paidTotal}, gaps, movement ids,
    posted COGS). A new audit action is ordinary taxonomy, NOT a permission.
  - Publish order.completed, ORDER_COMPLETED_EVENT_VERSION = 1, payload EXACTLY
    per SRS §24.2.4 (orderId, branchId, businessDay, lines, totals, payments,
    completedAt, customerId=null). Invent no fields. ZERO subscribers in P1F-2 —
    report that honestly; do not claim literal §5.5.2 subscriber compliance.
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
      CALLED AT LINE CAPTURE ONLY. No money, no quantities.
 2. planConsumption(tx, {lines:[{orderLineId, recipeVersionId|null,
        pinnedVersionIds[], quantity, modifierEffects[], conversions[]}]})
      -> { perLine:[{orderLineId, components:[{stockItemId,
           quantityInBaseUnit, unitId}], gaps[]}] }
      CALLED AT COMPLETION ONLY. Performs the REAL recursive expansion:
      sub-recipe recursion, yield/wastage arithmetic, existing depth-10 and
      cycle guards, modifier application, within-line aggregation.
      It MUST resolve sub-recipes ONLY to versions in pinnedVersionIds, and take
      conversion factors ONLY from the pinned `conversions` input.
      It MUST NOT read uom_conversions or stock_items.base_unit_id.
 Also extend the EXISTING RECIPE_COST_RECOMPUTER port with:
      recomputeForStockItems(tx, stockItemIds) -> string[]
 Implementations live OUTSIDE contract/ and reuse RecipeCostService's traversal
 (it already computes quantityInBaseUnit and discards it). Do not duplicate
 recipe semantics.

MODIFIER SEMANTICS (deterministic, no DSL), per line at COMPLETION:
  1 expand base recipe from the PINNED version closure
  2 aggregate per stock_item WITHIN the line
  3 apply ALL REMOVE_ALL  (zero that stock item's aggregate)
  4 apply ALL ADD         (expand sub-recipe ADDs, convert via pinned factors, scale)
  5 re-aggregate, drop non-positive
 REMOVE_ALL targets a stock_item only and removes EVERY occurrence at every depth.
 REMOVE_ALL of an absent component = NO-OP, not an error.
 ADD scaling = effect.quantity x order_line_modifiers.quantity x order_lines.quantity.
 ADD quantities are per SOLD PORTION — NOT divided by the base recipe yield.
 Removal STRICTLY precedes addition (this makes substitution correct).
 NEVER read catalogue.modifiers.recipe_delta.

CONVERSION GAPS FAIL CLOSED. Distinguish STRUCTURAL gaps (no_components /
 no_published_version -> tolerate, deplete partially, BR-MNU-012) from VALUATION
 gaps (no_valuation / no_unit_conversion -> THROW, roll back).

NEW ROUTES (both; a full-replace PUT with no read-back is not operable):
  GET /modifiers/{modifierId}/recipe-effects   @RequirePermission(VIEW)  // recipe.view
  PUT /modifiers/{modifierId}/recipe-effects   @RequirePermission(EDIT)  // recipe.edit
 INVENT NO PERMISSION. PUT is a full replace shaped exactly like
 PUT /recipes/:id/versions/:v/lines: envelope body { effects: [...] } via a
 dedicated ReplaceDto with @ValidateNested({each:true}); deleteMany+createMany;
 response = the effect set plus a count. Validate XOR component shape, add /
 remove_all field rules, and kind<->effect consistency against Modifier.kind
 (service-level; kind is nullable for legacy rows). Validate modifierId via the
 composite FK + rethrowAsNotFoundOnFk -> 404, exactly as RecipesService validates
 menuItemVariantId. New audit action MODIFIER_RECIPE_EFFECTS_REPLACED.

====================================================================
E. INVENTORY
====================================================================
NEW src/modules/inventory/contract/:
  SALE_DEPLETION_COMMAND + depleteForCompletedSale(tx, {tenantId, actorId,
    branchId, orderId, businessDay, occurredAt, lines})
  Inventory resolves the branch location itself from
    org.locations (tenant_id, location_type='branch', ref_id=branchId).
  Returns per line: {orderLineId, postedCogsTotal, effects[]}.

Sort ALL effects by (stock_item_id, location_id, order_line_id) ASC and process
in that order. NEVER JS map iteration order. This is also the deadlock-avoidance
lock ordering.

TWO AXES — DO NOT CONFLATE (P1F2D §C/§D):
  stock_items.batch_strategy  (fifo|fefo) decides WHICH batch is decremented.
  stock_items.costing_method  decides WHAT cost is recorded.
VALUATION:
  weighted_average -> stock_levels.average_cost. Outbound NEVER changes it.
  standard         -> stock_items.standard_cost. No fallback.
  fifo (batch-tracked):
    SELECT id, quantity_remaining, unit_cost, created_at, expiry_date
    FROM inventory.stock_batches
    WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
      AND quantity_remaining > 0
    ORDER BY  batch_strategy='fifo' : created_at ASC, id ASC
              batch_strategy='fefo' : expiry_date ASC NULLS LAST, created_at ASC, id ASC
    FOR UPDATE;                      -- NEVER SKIP LOCKED
    Consume in that order. Value EACH backed quantity at ITS OWN layer cost.
    Record batch_id on the movement when exactly one layer was consumed.
  CARRY-FORWARD (ratified; corrected by P1F2D §E) — used ONLY for an unbacked
  remainder, i.e. when the queue is empty. AFTER applying the batch decrements:
    SELECT unit_cost FROM inventory.stock_batches
    WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
      AND quantity_remaining = 0
    ORDER BY created_at DESC, id DESC        -- RECEIPT ORDER ALWAYS (FR-INV-013),
    LIMIT 1;                                 -- regardless of batch_strategy
  This single query serves BOTH partial-coverage and zero-coverage.
  NO weighted-average, NO standard, NO latest-purchase fallback for FIFO.
  If NO exhausted layer exists either -> throw a distinct domain error and roll
  the WHOLE Completion back. NEVER substitute another costing method.
  Do NOT modify valuationUnitCost or MovementsService.post.

ARITHMETIC — exact, no floating point, ONE rounding point:
  backedValue   = Σ (layerQty_i × layerUnitCost_i)         exact Rational
  unbackedValue = unbackedQty × carryForwardUnitCost       exact Rational
  total_cost    = round_half_up(backedValue + unbackedValue)    POSITIVE magnitude
  unit_cost     = round_half_up(total_cost / |quantity|)        REPRESENTATIVE ONLY
quantity is NEGATIVE on the movement; total_cost is POSITIVE (repo convention,
test-locked by costing.spec.ts:184-186 — a deliberate §7.4.3 deviation).
Posted COGS comes from total_cost ONLY — never recompute unit_cost × quantity.

WRITE ORDER — exactly three statements per (stock_item, location).
Projection-first-with-pointer is FK-ILLEGAL: stock_levels.last_movement_id is an
IMMEDIATE composite FK to the ledger and no DEFERRABLE constraint exists here.
  1) INSERT INTO inventory.stock_levels (tenant_id, stock_item_id, location_id,
         quantity_on_hand)
     VALUES ($1,$2,$3,$4::numeric)                 -- signed delta (negative)
     ON CONFLICT (stock_item_id, location_id) DO UPDATE
        SET quantity_on_hand = inventory.stock_levels.quantity_on_hand
                             + EXCLUDED.quantity_on_hand
     RETURNING quantity_on_hand;                   -- authoritative post-balance
     -- does NOT touch last_movement_*; does NOT touch average_cost
  2) INSERT the stock_movement with balance_after = the value returned by (1),
     movement_type='sale_depletion', reference_type='order',
     reference_id = ORDER id (NOT order_line_id), quantity NEGATIVE,
     unit = the stock item's base unit.
  3) UPDATE inventory.stock_levels SET last_movement_id=$m,
        last_movement_occurred_at=$t WHERE stock_item_id=$2 AND location_id=$3;
     -- legal now; race-free because (1)'s row lock is held to COMMIT
Decrement consumed batches under the FOR UPDATE lock.

EFFECT REGISTRY:
  INSERT INTO inventory.sale_depletion_effects (...)
  ON CONFLICT (tenant_id, order_line_id, stock_item_id, location_id) DO NOTHING
  RETURNING id, quantity_in_base_unit, unit_cost, total_cost, movement_id;
  0 rows => raise a conflict and let the WHOLE transaction roll back.
  NEVER INSERT-catch-P2002-then-query (P1E-5A rejected it).

NEGATIVE STOCK NEVER BLOCKS COMPLETION (FR-INV-014, UC-POS-01 13a).
Recipe-cost recomputation: call recomputeForStockItems ONCE, after all movements,
with the DISTINCT FIFO stock items only — an outbound sale provably does not
change weighted_average or standard valuation.

====================================================================
F. ONE UNITOFWORK TRANSACTION
====================================================================
No nesting. No outbox for same-DB consequences. No cross-module private query —
every hop goes through a contract/ token.
  1 permanent Payment-id replay/conflict check   (MUST BE FIRST)
  2 load order + non-voided lines + all three pinned snapshots
  3 assertMayCapturePayment  4 assertVersion  5 CashSession facts
  6 pinned payment policy    7 tender computation   8 settlement decision
  9 insert immutable Payment
  PARTIAL  -> 10a existing P1F-1 CAS
  SETTLING -> 10b planConsumption (REAL recursive expansion from pinned inputs)
              11b depleteForCompletedSale  (valued effects returned)
              12b recomputeForStockItems (distinct FIFO items only)
              13b write order_lines.posted_cogs_total from the valued effects
              14b Order CAS (LAST mutation)
  15 audit PAYMENT_CAPTURED   16 audit ORDER_COMPLETED
  17 publish order.completed  18 dispatcher drain   19 re-read   20 COMMIT
NEVER write posted COGS before depletion succeeds.
NEVER complete the Order before depletion + COGS succeed.
NEVER leave a Payment committed if a mandatory consequence fails.

====================================================================
G. IDEMPOTENCY
====================================================================
  1 HTTP Idempotency-Key (FR-API-020/022/023) — unchanged interceptor
  2 permanent client Payment id (FR-OFF-015) — step 1, BEFORE any completion
    read/write. Identical facts -> replay; any differing immutable fact -> 409.
  3 effect-registry UNIQUE key — defence in depth.
No separate completion-operation id.

====================================================================
H–M. REQUIRED TESTS
====================================================================
FINANCIAL: OPEN -> COMPLETED via one settling payment; PARTIALLY_PAID ->
  COMPLETED; partial stays PARTIALLY_PAID; exact settlement; over-tendered cash
  + change; manual external card; Payment permanent-id replay AFTER completion;
  HTTP replay after completion; same Payment id different facts -> 409;
  stale If-Match -> 409.
ATOMICITY: force a failure at EACH mandatory stage — expansion, modifier
  resolution, effect reservation, stock movement, FIFO batch update, stock-level
  projection, COGS projection, Order CAS, audit, order.completed handler — and
  prove TOTAL rollback: no Payment, no completion, no partial depletion, no
  partial COGS, no audit residue.
INVENTORY: nested expansion; same stock item via multiple sub-recipe paths
  aggregated WITHIN a line; same stock item on two lines independently
  traceable; absent recipe (0 depletion, posted COGS 0); incomplete recipe
  (partial); negative stock; each costing method.
FIFO (explicit): one layer; several layers; partial coverage with an unbacked
  remainder — assert the backed portion keeps its OWN per-layer costs and only
  the remainder carries forward; zero positive layers with historical exhausted
  layers — assert carry-forward from the RECEIPT-ORDER-latest exhausted layer;
  a fefo-strategy + fifo-costing item — assert physical consumption follows
  expiry order while carry-forward still uses receipt order; PROVE NO
  weighted-average fallback (make average_cost differ sharply from the layer
  cost and assert the layer cost wins); no-historical-layer case fails closed.
MODIFIERS: ADD; REMOVE_ALL; substitution (REMOVE_ALL + ADD); the "no cheese"
  case depletes NO cheese; REMOVE_ALL of an absent component is a no-op;
  double-modifier quantity scaling; a later edit to modifier_recipe_effects does
  NOT change an already-captured line's depletion.
HISTORICAL PINNING: changing StockItem.base_unit_id or a uom_conversions factor
  after line capture does NOT change that line's completed depletion.
CONVERSION GAPS: VALUATION/conversion gap rolls back and is NOT silently zeroed;
  STRUCTURAL gap deplete partially.
IDEMPOTENCY: exact replay creates no second effect row, movement, projection
  delta, COGS or audit.
CONCURRENCY (real PostgreSQL barriers, NO sleeps, >=3 clean runs each):
  1 two settling Payments, same Order, same version -> exactly one winner, one
    Payment, one effect set, one projection delta, one ORDER_COMPLETED audit;
  2 two different Orders, same weighted-average item -> BR-INV-003:
    SUM(stock_movements.quantity) == stock_levels.quantity_on_hand;
  3 two different Orders, same FIFO item -> deterministic layer consumption,
    correct per-order costs, no double consumption;
  4 lock-order inversion: two completions touching the same two stock items in
    opposite input order -> both succeed, no deadlock.
RLS / APPEND-ONLY / FK: via the REAL ros_app connection (app.get(PrismaService)),
  never the migrator client — own-tenant SELECT/INSERT succeed; cross-tenant
  blocked; UPDATE rejected; DELETE rejected; row survives the failed mutation;
  grants inspected from information_schema; effect cannot point at the wrong
  OrderLine / stock item / location.
MODULE BOUNDARIES: extend module-boundaries.spec.ts — Production's and
  Inventory's contract/ files are interface-only; impls live outside contract/;
  sales-payment.service.ts imports them ONLY from <module>/contract; and
  KNOWN_DEVIATIONS DOES NOT GROW.

====================================================================
N–S. BUILD / VERIFY
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
    genuinely NESTED recipes (depth >= 2), mixed costing methods, modifiers
    present. >=20 iterations. Report p50 AND p95. Report COMPLETE only if the
    measured p95 <= 200 ms; otherwise report PARTIAL with the real number.
  DO NOT COMMIT. DO NOT PUSH.

====================================================================
NON-GOALS
====================================================================
No refunds/voids/reversals. No PaymentAttempt or integrated card. No receipt.
No fiscal document or outbox. No loyalty/CRM. No table release. No session/day
close. No X/Z reports. No comp mechanism. No Costing module. No accounting
cost-layer table. No new permission. No RFC7807. No /v1. Do NOT fix
MovementsService.post's lost update for transfers/counts/waste (separate slice).
Do NOT change valuationUnitCost. Do NOT retire the existing sales->production
KNOWN_DEVIATIONS entry. Do NOT add exhausted_at or any stock_batches /
stock_movements schema change.

====================================================================
REPORT
====================================================================
Write docs/reports/claude/2026-08-26_P1F2_order-completion.md with the required
ROS header (task/slice, report type, authority statement, date, HEAD, branch,
working-tree summary, task id). Include full verification evidence, MEASURED
p50/p95, exact test counts, every deviation and residual risk, and honest
reporting of any failure. Use these classifications and do NOT overclaim:
  FR-CST-001 COMPLETE (after verification) · FR-CST-002 PARTIAL
  FR-POS-024 COMPLETE only with the config API + snapshot + passing no-cheese test
  FR-INV-012/013 COMPLETE for costing_method=fifo + batch_strategy=fifo;
    the fefo+fifo combination is the DOCUMENTED OPEN ITEM, not FIFO compliance
  BR-INV-003 COMPLETE for the completion path only · NFR-PERF-006 PARTIAL unless measured
  §1.2 PARTIAL · UC-POS-01 PARTIAL
Update docs/reports/claude/INDEX.md.

DEFINITION OF DONE: 30 migrations from zero on a clean scratch DB; full unit +
full E2E green; concurrency tests >=3 clean runs each; FIFO tests green
including the no-weighted-average-fallback proof and the fefo+fifo case;
historical-pinning tests green; performance measured and reported; OpenAPI
3.1.0 / 135 with zero drift; tsc clean apart from the known baseline; report +
INDEX written; nothing committed or pushed; the three preserved user files
untouched.
```
