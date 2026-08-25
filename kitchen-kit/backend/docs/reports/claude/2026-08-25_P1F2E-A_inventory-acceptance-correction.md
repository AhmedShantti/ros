# P1F-2E-A — Dual-Axis Inventory Acceptance Correction

**Report type:** Narrow acceptance correction + final readiness gate (no production code, no production migration, no governance change, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence**. **No governance is created or amended by this gate; no D-21+ exists.**
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (verified unchanged — no commit)
**Branch:** `feat/production-spec`
**Working tree:** three preserved user files, the P1F-2 / A / B / C / D / E reports, the governance register, INDEX, plus this report
**Task identifier:** P1F-2E-A

> ## VERDICT (§K)
> ## **IMPLEMENTATION READY**
> Five acceptance corrections resolved without redesigning P1F-2E. The most
> consequential: the proposed backfill was **provably wrong** for the very
> configuration P1F-2E exists to support, and `quantity_remaining <= quantity_received`
> turns out **not** to be enforced anywhere — so the migration now guards, constrains,
> and backfills in true receipt order. Migrations remain **30**; OpenAPI remains **135**.

---

## A. STARTING STATE

| Check | Result |
|---|---|
| Branch | `feat/production-spec` |
| HEAD | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` |
| `origin/feat/production-spec` | matches |
| Migrations | **27** · OpenAPI **3.1.0 / 133** |
| Preserved user files | untouched |

No branch operation, no destructive git command, no commit, no push, no production code, **no governance change**.

## B. P1F-2E ACCEPTED BASELINE

Preserved without reopening, exactly per §8 of the governing task: the independent physical FIFO/FEFO axis, the FIFO accounting receipt-order axis, the `fifo_cost_quantity_consumed` direction, the FIFO Exhaustion Carry-Forward ratification, the zipper reconciliation, the effect business identity, N allocations = N movements, per-allocation real physical batch and actual cost basis, the positive `total_cost` convention, posted COGS from allocation `total_cost`, the three Sales snapshots, the two Production contract methods, the `GET`+`PUT` modifier-effect API, OpenAPI **135**, the final-Payment completion trigger, UnitOfWork, Order CAS last, every existing P1F-2 atomicity/idempotency test, and FR-CST-002 **PARTIAL**.

## C. FIFO COUNTER BACKFILL (C-16)

### The defect

P1F-2E proposed, and called exact:

```sql
UPDATE inventory.stock_batches
SET fifo_cost_quantity_consumed = quantity_received - quantity_remaining;
```

`quantity_remaining` is the **physical** axis. Seeding the accounting axis from each batch's *own physical* consumption is precisely the error P1F-2E's own A/B counterexample disproves: under `costing_method = fifo` + `batch_strategy = fefo`, physical and accounting per-batch positions diverge by construction. Replaying that counterexample against the proposed backfill — A(day 1, 10 @ 100), B(day 2, 10 @ 200), 5 consumed physically from B — yields `A.consumed = 0, B.consumed = 5`, whereas receipt-order accounting truth is `A.consumed = 5, B.consumed = 0`. Every subsequent COGS on that item would then be charged from the wrong layer. **Corrected.**

### Audited invariants

| Fact | Finding |
|---|---|
| Batch mutation sites in `src/` | **Exactly one** — `movements.service.ts:218`, `{ quantityRemaining: { decrement } }`. There is **no increment, no refill, no upsert** anywhere. |
| Inbound movements | Never touch `quantity_remaining` (batch selection runs only `if (outbound && item.isBatchTracked)`); a positive `count_adjustment` cannot refill a layer. |
| `quantity_remaining >= 0` | Enforced — `ck_batch_qty_nonneg`. |
| **`quantity_remaining <= quantity_received`** | **NOT ENFORCED — no such constraint exists.** |

So `quantity_received − quantity_remaining` is a sound *per-batch physical consumption* figure **only if** the un-enforced invariant happens to hold. It is not structurally guaranteed, so the migration must not assume it silently.

### Corrected migration-30 sequence

**1 — Guard, fail loudly rather than invent state:**

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory.stock_batches
             WHERE quantity_remaining > quantity_received) THEN
    RAISE EXCEPTION
      'P1F-2 migration 30: stock_batches contains rows with quantity_remaining > quantity_received; '
      'the FIFO accounting backfill cannot be truthfully derived. Investigate before migrating.';
  END IF;
END $$;
```

**2 — Make it structural going forward:**

```sql
ALTER TABLE inventory.stock_batches
  ADD CONSTRAINT ck_batch_qty_within_received
  CHECK (quantity_remaining <= quantity_received);
```

**3 — Add the counter** (`DECIMAL(18,6) NOT NULL DEFAULT 0`, plus `ck_batch_cost_qty_range` bounding it to `[0, quantity_received]`).

**4 — Receipt-order backfill, exact DECIMAL window arithmetic, FIFO batch-tracked items only:**

```sql
WITH scoped AS (
  SELECT b.id,
         b.quantity_received,
         COALESCE(SUM(b.quantity_received) OVER (
           PARTITION BY b.tenant_id, b.stock_item_id, b.location_id
           ORDER BY b.created_at, b.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_received_before,
         SUM(b.quantity_received - b.quantity_remaining) OVER (
           PARTITION BY b.tenant_id, b.stock_item_id, b.location_id)     AS total_consumed
  FROM inventory.stock_batches b
  JOIN inventory.stock_items i
    ON i.tenant_id = b.tenant_id AND i.id = b.stock_item_id
  WHERE i.costing_method = 'fifo' AND i.is_batch_tracked
)
UPDATE inventory.stock_batches t
   SET fifo_cost_quantity_consumed =
       LEAST(s.quantity_received,
             GREATEST(s.total_consumed - s.cum_received_before, 0))
  FROM scoped s
 WHERE t.id = s.id;
```

This computes the **total physically consumed per (tenant, stock_item, location)** and re-allocates that total through the layers in **receipt order** — exactly the `consumed_i = min(received_i, max(TOTAL − cum_before_i, 0))` formula, with no floating point. **Non-FIFO items are untouched and remain at `DEFAULT 0`**, where the column is not an accounting authority.

**Why the batch-derived total is the strongest available fact:** the ledger cannot substitute for it — `stock_movements.batch_id` is populated only when exactly one layer was consumed, so historical multi-batch consumption is unattributable from movements alone. The batch rows themselves carry the authoritative remaining quantities, and (per the audit above) they can only ever have decreased.

**Required verification — clean-from-zero is explicitly insufficient:**
- **A.** From-zero migration correct (all counters 0, no batches exist).
- **B.** **UPGRADE test** — apply migrations through 29; create a FIFO-costed, FEFO-strategy item with ≥2 batches whose expiry order contradicts receipt order; simulate physical consumption via the existing path so physical and receipt orders diverge; apply migration 30; **assert the counters are receipt-order correct and are NOT a per-batch copy of physical consumption**.

## D. SHARED COUNTER LOCKING (C-17)

`fifo_cost_quantity_consumed` becomes **shared Inventory state** written by two paths, so both must use one protocol.

**Design: a PRIVATE Inventory kernel — not a contract, not exported across modules.**

`src/modules/inventory/costing/fifo-cost-ledger.ts` (name to match Inventory conventions), owning:

| Responsibility | Notes |
|---|---|
| `lockLayers(tx, tenantId, stockItemId, locationId)` | `SELECT … FOR UPDATE`, `ORDER BY created_at ASC, id ASC`, over the union of physically-available (`quantity_remaining > 0`) and accounting-available (`quantity_received − fifo_cost_quantity_consumed > 0`) rows. **No `SKIP LOCKED`.** |
| `planFifoCostConsumption(lockedLayers, quantity)` | receipt-order accounting slices |
| `applyCostConsumption(tx, slices)` | increments the counter |
| `findCarryForwardBasis(tx, …)` | returns `{ batchId, unitCost }` — see §F |

**Consumers:** (A) `SaleDepletionCommand`; (B) `MovementsService.post`, where it must maintain the counter. The completion-specific **dual physical/cost zipper stays in the SaleDepletion implementation** — it is not part of the kernel.

**Consequence for `MovementsService.post`:** it currently reads batches with a plain `findMany` and takes **no lock**. Under this design it must route batch access through the kernel, so it now acquires `FOR UPDATE` in the same deterministic order. This is **additive locking safety only** — `valuationUnitCost` and the financial valuation of transfers/waste/counts are **not** changed, and the pre-existing `stock_levels` lost-update on those paths remains an explicitly out-of-scope, separately classified Inventory debt (§J).

**Invariant to prove:** a Waste/Transfer/Count outbound racing a Sale Completion on the same FIFO item/location cannot double-consume accounting quantity, skip a cost layer, drive `fifo_cost_quantity_consumed` above `quantity_received` (also DB-guarded by `ck_batch_cost_qty_range`), or leave the Completion reading a stale queue.

**New deterministic concurrency test:** Completion vs. an existing `MovementsService` outbound (e.g. waste) on the same FIFO item/location, real PostgreSQL barrier released before counter mutation, ≥3 clean runs; **assert the final counter state equals the serial result exactly**.

## E. EFFECT RESERVATION ORDER (C-18)

P1F-2E's prose said only the winning effect may mutate stock, but its prompt numbered the reservation **after** batch/counter/projection work. Corrected — for each logical `(OrderLine, StockItem, Location)` the order is now normative:

```
1. INSERT INTO inventory.sale_depletion_effects (...)
   ON CONFLICT (tenant_id, order_line_id, stock_item_id, location_id) DO NOTHING
   RETURNING id;
2. 0 rows  -> raise a conflict IMMEDIATELY. No Inventory state has been touched.
3. WINNER ONLY, in this order:
     lock batches (kernel, one ordering, both axes)
     plan physical flow          (batch_strategy order)
     plan accounting cost flow   (receipt order)
     mutate quantity_remaining
     mutate fifo_cost_quantity_consumed
     zipper -> allocations
     per allocation: atomic stock_levels delta -> movement -> pointer update
     insert sale_depletion_allocations rows
```

All inside the same outer UnitOfWork transaction; any downstream failure rolls the reservation back with everything else. **Inventory is never mutated before the business identity is reserved.** This also makes the C-20 §I idempotency test meaningful: a conflicting pre-existing effect must leave **zero** batch, counter, stock-level, movement and allocation changes.

The effect row's `quantity_in_base_unit` is known before any batch work — it comes from Production's `planConsumption` output, which Sales has already computed — so reserving first introduces no ordering dependency.

## F. CARRY-FORWARD PROVENANCE (C-19)

P1F-2E wrote carry-forward allocations with `cost_basis_batch_id = NULL`, discarding the identity of the historical layer that actually supplied the carried cost. Corrected.

The carry-forward query returns **both** columns:

```sql
SELECT id, unit_cost
FROM inventory.stock_batches
WHERE tenant_id = $1 AND stock_item_id = $2 AND location_id = $3
  AND (quantity_received - fifo_cost_quantity_consumed) = 0
ORDER BY created_at DESC, id DESC
LIMIT 1;
```

A carry-forward allocation persists:

```
cost_basis_batch_id = <the exhausted batch id>      -- provenance retained
unit_cost           = <that batch's unit_cost>
physical_batch_id   = NULL                          -- genuinely unbacked stock
```

Physical backing and accounting provenance are independent axes, so a NULL physical batch does not imply a NULL cost basis.

**Resulting invariant — clean and testable:** for `costing_method = 'fifo'`, **every valued allocation carries a non-null `cost_basis_batch_id`**, carry-forward included. It cannot be NULL, because the terminal no-exhausted-layer case **fails closed** (P1F-2C §F) rather than emitting a basis-less allocation. `cost_basis_batch_id` is NULL only for `weighted_average` and `standard` allocations. Not expressible as a DB CHECK (it needs a join to `stock_items`), so it is service-enforced and test-proven.

**Consequence:** OrderLine → FIFO cost-layer provenance stays truthful indefinitely, and a **later receipt cannot change how an old carry-forward COGS is explained** — a required traceability test.

## G. STRUCTURAL BATCH CONSISTENCY (C-20)

Audited unique targets: `stock_batches` has only `stock_batches_tenant_id_id_key (tenant_id, id)`. The P1F-2E allocation FKs therefore prove only tenant-membership — **not** that a referenced batch belongs to the same `stock_item`/`location` as its parent effect. Corrected so the wrong-reference state is unrepresentable.

**Additive unique targets (Inventory-owned, migration 30):**

```sql
CREATE UNIQUE INDEX stock_batches_tenant_id_id_item_location_key
  ON inventory.stock_batches (tenant_id, id, stock_item_id, location_id);
-- on sale_depletion_effects:
UNIQUE (tenant_id, id, stock_item_id, location_id)
```

Neither adds a column nor changes semantics — the D-16 additive-index precedent.

**`sale_depletion_allocations` carries `stock_item_id` and `location_id`** (deliberate, minimal redundancy that exists solely to make the composite FKs expressible) and gains:

| FK | Target | Proves |
|---|---|---|
| `(tenant_id, effect_id, stock_item_id, location_id)` | `sale_depletion_effects(tenant_id, id, stock_item_id, location_id)` RESTRICT | the allocation's item/location **are** its parent effect's |
| `(tenant_id, physical_batch_id, stock_item_id, location_id)` | `stock_batches(tenant_id, id, stock_item_id, location_id)` RESTRICT | the physical batch belongs to that same item **and** location |
| `(tenant_id, cost_basis_batch_id, stock_item_id, location_id)` | `stock_batches(…)` RESTRICT | the cost-basis batch likewise |

Because PostgreSQL composite FKs default to `MATCH SIMPLE`, a row with `physical_batch_id IS NULL` (unbacked) or `cost_basis_batch_id IS NULL` (weighted-average/standard) is **not** enforced against the target — exactly the desired behaviour, since `stock_item_id`/`location_id` remain `NOT NULL`. No `MATCH FULL` anywhere.

**Allocation → `stock_movements` item/location binding: deliberately NOT structural.** It *is* expressible — a unique index on `(tenant_id, id, occurred_at, stock_item_id, location_id)` would include the partition key — but it would add a **fourth** unique index to the highest-volume, RANGE-partitioned table in the system, propagated to every existing and future monthly partition, permanently taxing the hottest write path. The marginal gain is small: the movement's `stock_item_id`/`location_id` are written in the same statement sequence, from the same in-memory values, as the allocation whose item/location the FKs above already verify. **It therefore remains service-enforced**, and the implementation report **must not claim a PostgreSQL test proves this particular binding structurally** — the test asserts service behaviour, not an encoded invariant.

## H. MIGRATION 30

**Total remains 30** (28 Sales, 29 Production, 30 Inventory). No migration 31 is created merely because the same unimplemented Inventory migration gains constraints. No committed migration is edited.

Migration 30 contents, in order:

1. **Guard** — `RAISE EXCEPTION` if any `quantity_remaining > quantity_received` (§C).
2. `ALTER TABLE stock_batches ADD CONSTRAINT ck_batch_qty_within_received CHECK (quantity_remaining <= quantity_received);`
3. `ALTER TABLE stock_batches ADD COLUMN fifo_cost_quantity_consumed DECIMAL(18,6) NOT NULL DEFAULT 0;` + `ck_batch_cost_qty_range CHECK (>= 0 AND <= quantity_received)`. Defaulted non-volatile column ⇒ **no table rewrite**, no writer change.
4. **Receipt-order backfill** window `UPDATE`, FIFO batch-tracked items only (§C).
5. `CREATE UNIQUE INDEX stock_batches_tenant_id_id_item_location_key …` (§G) — additive.
6. `inventory.sale_depletion_effects` — business `UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)` **plus** `UNIQUE (tenant_id, id, stock_item_id, location_id)`; composite FKs to `sales.order_lines`, `stock_items`, `org.locations`, `uom` (RESTRICT); NOT partitioned.
7. `inventory.sale_depletion_allocations` — columns per P1F-2E §I **plus** `stock_item_id`, `location_id`; `UNIQUE (tenant_id, effect_id, sequence)`; the three composite FKs of §G; movement FK `(tenant_id, movement_id, movement_occurred_at)` RESTRICT; `unit_id` FK RESTRICT; indexes `(tenant_id, effect_id)`, `(tenant_id, physical_batch_id)`, `(tenant_id, cost_basis_batch_id)`; NOT partitioned.
8. Both new tables: RLS `ENABLE`+`FORCE`, **SELECT and INSERT policies only**, `GRANT SELECT, INSERT`, `REVOKE UPDATE, DELETE, TRUNCATE`.
9. **No change** to `stock_movements` or `stock_levels` — no new column, no new index, no partition work.

## I. TEST DELTAS

Added to the existing P1F-2E suite (which is retained in full):

- **MIGRATION UPGRADE** — migrate through 29; create FIFO-costed + FEFO-strategy batches whose expiry order contradicts receipt order; consume physically so the axes diverge; apply migration 30; assert counters are **receipt-order** correct, not physical-per-batch copies. Also assert the guard raises on a deliberately corrupt `quantity_remaining > quantity_received` row.
- **CARRY-FORWARD PROVENANCE** — zero physical stock; assert `physical_batch_id IS NULL` **and** `cost_basis_batch_id = <the actual exhausted FIFO batch>`; then add a later receipt and assert the historical allocation's explanation is unchanged.
- **STRUCTURAL** — an allocation cannot bind effect item A to a physical batch of item B; nor effect location A to a batch at location B; same two checks for `cost_basis_batch_id`; cross-tenant still impossible. These assert **encoded FK behaviour**. The allocation↔movement item/location binding is tested as **service behaviour only** and must be labelled as such.
- **CONCURRENCY** — Completion vs. existing `MovementsService` outbound on the same FIFO item/location, barrier before counter mutation, ≥3 clean runs; final counter state equals the serial result exactly.
- **IDEMPOTENCY ORDER** — a conflicting pre-existing effect produces **zero** batch changes, zero counter changes, zero stock-level changes, zero movements, zero allocations.

## J. REQUIREMENT CLASSIFICATION

Unchanged from P1F-2E except where these corrections strengthen the evidence.

| Requirement | POST-P1F-2 |
|---|---|
| **FR-INV-012** | **COMPLETE for the completion path** |
| **FR-INV-013** | **COMPLETE for the completion path** — receipt-order valuation **and** every physical batch recorded. Not claimed globally: transfers/waste/counts keep their existing *valuation* (only counter maintenance and locking are added) |
| **FR-INV-022 / 023** | **COMPLETE** — physical axis independent |
| **FR-INV-014** | **COMPLETE** |
| **FR-INV-027 [S]** | reporting surface **NOT IMPLEMENTED**; provenance substrate now complete, including carry-forward cost basis (§F) |
| **FR-INV-030** | **COMPLETE** for sales |
| **FR-INV-051 / BR-INV-003** | **COMPLETE for the completion path**; still at risk for transfers/counts/waste (`stock_levels` lost update — out of scope) |
| **FR-CST-001** | **COMPLETE** after verification |
| **FR-CST-002** | **PARTIAL** |
| **FR-POS-024** | **COMPLETE** only with the config API + snapshot + passing no-cheese test |
| **NFR-PERF-006** | **PARTIAL until measured** |
| **§1.2 / UC-POS-01** | **PARTIAL** |

**Residual, explicitly out of scope and separately classified:** the `stock_levels` lost-update on transfers/counts/waste, and their receipt-order *valuation* — a future Inventory slice.

## K. IMPLEMENTATION READINESS

| Correction | Status |
|---|---|
| **C-16** FIFO counter backfill | Resolved — guard + permanent CHECK + receipt-order window backfill; upgrade test mandated (§C) |
| **C-17** shared counter locking | Resolved — one private Inventory kernel, one deterministic lock order, no `SKIP LOCKED`, race test mandated (§D) |
| **C-18** effect reservation order | Resolved — reservation is step 1; Inventory is never mutated first (§E) |
| **C-19** carry-forward provenance | Resolved — carry-forward stores the actual exhausted batch id; FIFO allocations always carry a cost basis (§F) |
| **C-20** structural consistency | Resolved — additive unique targets + composite FKs; the one remaining service-enforced binding documented, not overclaimed (§G) |

# **IMPLEMENTATION READY**

## L. FINAL SONNET PROMPT

**Supersedes P1F-2E §P and every earlier P1F-2 implementation prompt.**

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
#   > docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-correction.md  <- CONTROLLING
#   > docs/reports/claude/2026-08-25_P1F2E_dual-axis-inventory-gate.md
#   > docs/reports/claude/2026-08-25_P1F2D_final-sanity-gate.md
#   > docs/reports/claude/2026-08-25_P1F2C_fifo-ratification-final-gate.md
#   > docs/reports/claude/2026-08-25_P1F2B_completion-correction-gate.md
#   > repository code
#
# READ IN FULL FIRST: P1F2E-A, then P1F2E, P1F2D, P1F2C, P1F2B.
# ALL earlier implementation prompts are SUPERSEDED (P1F-2A §AA, P1F-2C §N,
# P1F-2D §N, P1F-2E §P) — ignore them.
# Where documents differ, the LATER one WINS (E-A > E > D > C > B).
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
Never edit an existing migration. Never combine modules. Header comment
explaining WHY; composite tenant-safe FKs; RLS ENABLE+FORCE; explicit grants.

MIGRATION 28 — SALES  (THREE new snapshot tables + two column/constraint changes)
 1. ALTER TABLE sales.orders ADD CONSTRAINT ck_completed
      CHECK (state <> 'completed' OR completed_at IS NOT NULL);      -- SRS §25.2
 2. ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;
    + CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0);
 3. CREATE TYPE sales."ModifierEffectOperationSnapshot" AS ENUM ('add','remove_all');
    CREATE TYPE sales."RecipeComponentTypeSnapshot"     AS ENUM ('stock_item','sub_recipe');
    -- DO NOT create a ConsumptionProvenance enum.
 4. sales.order_line_recipe_versions   (pinned version closure)
      UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)
      FK order_line CASCADE; FK (tenant_id, recipe_version_id) ->
        production.recipe_versions(tenant_id,id) RESTRICT
 5. sales.order_line_modifier_effects  (pinned modifier effects)
      operation, component_type, stock_item_id NULL, sub_recipe_version_id NULL,
      quantity DECIMAL(18,6) NULL, unit_id NULL, sequence
      FKs: order_line_modifier CASCADE, order_line CASCADE,
           stock_items RESTRICT, recipe_versions RESTRICT, uom RESTRICT
      XOR CHECK; remove_all => component_type='stock_item' AND quantity IS NULL
        AND unit_id IS NULL; add => quantity > 0 AND unit_id IS NOT NULL
      sub_recipe_version_id is a PINNED VERSION, never a logical recipe id.
 6. sales.order_line_component_conversions  (pinned conversion basis)
      stock_item_id, from_unit_id, base_unit_id, factor DECIMAL(20,10) NOT NULL
      UNIQUE (tenant_id, order_line_id, stock_item_id, from_unit_id)
      FKs: order_line CASCADE; stock_items RESTRICT; uom x2 RESTRICT
 ALL THREE Sales snapshot tables: NOT partitioned; tenant-anchored;
   GRANT SELECT, INSERT only; REVOKE UPDATE, DELETE, TRUNCATE;
   RLS ENABLE+FORCE with SELECT and INSERT policies ONLY.
 DO NOT create sales.order_line_consumption_components.

MIGRATION 29 — PRODUCTION
 1. CREATE TYPE production."ModifierEffectOperation" AS ENUM ('add','remove_all');
 2. production.modifier_recipe_effects
      REUSE the existing production."RecipeComponentType" enum.
      FK (tenant_id, modifier_id) -> catalogue.modifiers(tenant_id,id) CASCADE
      FK (tenant_id, stock_item_id) -> inventory.stock_items(tenant_id,id) RESTRICT
      FK (tenant_id, sub_recipe_id) -> production.recipes(tenant_id,id) RESTRICT
      FK (unit_id) -> inventory.uom(id) RESTRICT
      XOR + operation CHECKs; UNIQUE (tenant_id,id); INDEX (tenant_id, modifier_id)
      RLS ENABLE+FORCE, all four policies; GRANT SELECT, INSERT, UPDATE, DELETE.
 3. Leave catalogue.modifiers.recipe_delta EXACTLY as is — opaque, never read.

MIGRATION 30 — INVENTORY  (order matters; P1F2E-A §H)
 1. GUARD — fail loudly rather than invent state:
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM inventory.stock_batches
                   WHERE quantity_remaining > quantity_received) THEN
          RAISE EXCEPTION 'P1F-2 migration 30: stock_batches has quantity_remaining > '
            'quantity_received; the FIFO accounting backfill cannot be truthfully derived.';
        END IF; END $$;
 2. ALTER TABLE inventory.stock_batches ADD CONSTRAINT ck_batch_qty_within_received
      CHECK (quantity_remaining <= quantity_received);
      -- audited: NOT enforced today; only ck_batch_qty_nonneg exists.
 3. ALTER TABLE inventory.stock_batches
      ADD COLUMN fifo_cost_quantity_consumed DECIMAL(18,6) NOT NULL DEFAULT 0;
    ADD CONSTRAINT ck_batch_cost_qty_range
      CHECK (fifo_cost_quantity_consumed >= 0
         AND fifo_cost_quantity_consumed <= quantity_received);
    -- cost-remaining is DERIVED: quantity_received - fifo_cost_quantity_consumed.
    -- `consumed` not `remaining` so DEFAULT 0 gives new batches full cost quantity
    -- and NO batch-creation writer has to change.
 4. RECEIPT-ORDER BACKFILL (exact DECIMAL window SQL; FIFO batch-tracked ONLY).
    DO NOT seed from each batch's own physical consumption — that is provably
    wrong for costing=fifo + strategy=fefo:
      WITH scoped AS (
        SELECT b.id, b.quantity_received,
               COALESCE(SUM(b.quantity_received) OVER (
                 PARTITION BY b.tenant_id, b.stock_item_id, b.location_id
                 ORDER BY b.created_at, b.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before,
               SUM(b.quantity_received - b.quantity_remaining) OVER (
                 PARTITION BY b.tenant_id, b.stock_item_id, b.location_id) AS total_consumed
        FROM inventory.stock_batches b
        JOIN inventory.stock_items i
          ON i.tenant_id = b.tenant_id AND i.id = b.stock_item_id
        WHERE i.costing_method = 'fifo' AND i.is_batch_tracked)
      UPDATE inventory.stock_batches t
         SET fifo_cost_quantity_consumed =
             LEAST(s.quantity_received, GREATEST(s.total_consumed - s.cum_before, 0))
        FROM scoped s WHERE t.id = s.id;
    Non-FIFO items stay at DEFAULT 0.
 5. CREATE UNIQUE INDEX stock_batches_tenant_id_id_item_location_key
      ON inventory.stock_batches (tenant_id, id, stock_item_id, location_id);
      -- additive; no column added, no semantics changed (D-16 precedent)
 6. inventory.sale_depletion_effects — NON-partitioned, PARENT / business identity
      id, tenant_id, order_id, business_day, order_line_id, stock_item_id,
      location_id, quantity_in_base_unit DECIMAL(18,6) NOT NULL, unit_id, created_at
      UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)   -- business identity
      UNIQUE (tenant_id, id, stock_item_id, location_id)              -- FK target for children
      FK (tenant_id, order_id, order_line_id, business_day)
         -> sales.order_lines(tenant_id, order_id, id, business_day) RESTRICT
      FK (tenant_id, stock_item_id), (tenant_id, location_id), (unit_id) RESTRICT
      NO cost columns, NO movement columns on the parent.
 7. inventory.sale_depletion_allocations — NON-partitioned, CHILD
      id, tenant_id, effect_id, sequence SMALLINT NOT NULL,
      stock_item_id, location_id,          -- deliberate redundancy for composite FKs
      physical_batch_id UUID NULL, cost_basis_batch_id UUID NULL,
      quantity_in_base_unit DECIMAL(18,6) NOT NULL CHECK (> 0), unit_id,
      unit_cost BIGINT NOT NULL, total_cost BIGINT NOT NULL,
      movement_id UUID NOT NULL, movement_occurred_at TIMESTAMPTZ NOT NULL, created_at
      UNIQUE (tenant_id, effect_id, sequence)
      FK (tenant_id, effect_id, stock_item_id, location_id)
         -> sale_depletion_effects(tenant_id, id, stock_item_id, location_id) RESTRICT
      FK (tenant_id, physical_batch_id, stock_item_id, location_id)
         -> stock_batches(tenant_id, id, stock_item_id, location_id) RESTRICT
      FK (tenant_id, cost_basis_batch_id, stock_item_id, location_id)
         -> stock_batches(tenant_id, id, stock_item_id, location_id) RESTRICT
      FK (tenant_id, movement_id, movement_occurred_at)
         -> stock_movements(tenant_id, id, occurred_at) RESTRICT
      FK (unit_id) -> inventory.uom(id) RESTRICT
      INDEX (tenant_id, effect_id), (tenant_id, physical_batch_id),
            (tenant_id, cost_basis_batch_id)
      NOTE: composite FKs are MATCH SIMPLE, so a NULL batch id disables that FK —
      exactly right for unbacked / non-FIFO allocations.
 8. Both new tables: RLS ENABLE+FORCE; SELECT and INSERT policies ONLY;
    GRANT SELECT, INSERT; REVOKE UPDATE, DELETE, TRUNCATE.
 9. DO NOT alter stock_movements or stock_levels. No new column, no new index there.

====================================================================
C. SALES
====================================================================
LINE CAPTURE (OrderLinesService.create, SAME existing transaction):
  Call Production's resolveConsumptionBasis ONCE and persist all THREE snapshots.
  Record applied REMOVE_ALL operations in the line-capture AUDIT metadata.
  DO NOT snapshot resolved/net consumption quantities. DO NOT snapshot valuation.
  Do NOT change existing pricing/tax/unit_cost_snapshot behaviour.
  IN-SCOPE MICRO-FIX: recomputeOrderTotals does
      cogs = (cogs ?? 0n) + line.unitCostSnapshot
  ignoring quantity. Multiply by line.quantity with ONE HALF_UP rounding.
  Change nothing else there. Test a qty=3 line contributes 3x.

COMPLETION:
  - order-state.ts: 'completed' becomes a legal target from BOTH 'open' AND
    'partially_paid'. NEVER persist an intermediate state.
  - Order CAS is the LAST mutation: paid_total, rounding_adjustment,
    state='completed', completed_at, closed_by (the EMPLOYEE — P1D-E),
    cogs_total, version+1.
  - order_lines.posted_cogs_total = exact bigint SUM of that line's ALLOCATION
    total_cost values. Absent recipe posts 0 (not NULL). NULL = not completed.
  - orders.cogs_total = exact bigint SUM of line posted totals. No rounding at
    either level. Document the post-completion meaning in the schema comment.
  - Audits: PAYMENT_CAPTURED (unchanged) AND new ORDER_COMPLETED (entity 'order',
    before{state,version,paidTotal}, gaps, movement ids, posted COGS).
  - Publish order.completed, ORDER_COMPLETED_EVENT_VERSION = 1, payload EXACTLY
    per SRS §24.2.4. Invent no fields. ZERO subscribers in P1F-2 — report that
    honestly; do not claim literal §5.5.2 subscriber compliance.
  - Migrate SalesPaymentService to unitOfWork.execute (SalesFireService precedent).
  - Remove FULL_PAYMENT_REQUIRES_COMPLETION only once the settling path is green;
    replace its test with completion tests.

====================================================================
D. PRODUCTION
====================================================================
NEW src/modules/production/contract/ — EXACTLY TWO methods, tx-first:
 1. resolveConsumptionBasis(tx, {tenantId, recipeVersionId|null, modifierIds[]})
      -> { versionClosure[], modifierEffects Map, conversions[] }
      LINE CAPTURE ONLY. Returns NO resolved/net consumption quantities and NO
      money; configured modifier ADD quantities and pinned conversion factors ARE
      part of it.
 2. planConsumption(tx, {lines:[...]}) -> { perLine:[{orderLineId,
      components:[{stockItemId, quantityInBaseUnit, unitId}], gaps[]}] }
      COMPLETION ONLY. REAL recursive expansion: sub-recipe recursion,
      yield/wastage arithmetic, existing depth-10 and cycle guards, modifier
      application, within-line aggregation. Resolves sub-recipes ONLY to versions
      in pinnedVersionIds and takes conversion factors ONLY from the pinned
      `conversions` input. MUST NOT read uom_conversions or stock_items.base_unit_id.
 Extend the EXISTING RECIPE_COST_RECOMPUTER port with
      recomputeForStockItems(tx, stockItemIds) -> string[]
 Implementations live OUTSIDE contract/ and reuse RecipeCostService's traversal.

MODIFIER SEMANTICS (deterministic, no DSL), per line at COMPLETION:
  1 expand base recipe from the PINNED closure
  2 aggregate per stock_item WITHIN the line
  3 apply ALL REMOVE_ALL   4 apply ALL ADD   5 re-aggregate, drop non-positive
 REMOVE_ALL targets a stock_item only, removing EVERY occurrence at every depth;
 of an absent component it is a NO-OP, not an error.
 ADD scaling = effect.quantity x order_line_modifiers.quantity x order_lines.quantity;
 ADD quantities are per SOLD PORTION — NOT divided by the base recipe yield.
 Removal STRICTLY precedes addition. NEVER read catalogue.modifiers.recipe_delta.

CONVERSION GAPS FAIL CLOSED: STRUCTURAL (no_components / no_published_version)
 -> tolerate, deplete partially. VALUATION (no_valuation / no_unit_conversion)
 -> THROW, roll back.

NEW ROUTES (both):
  GET /modifiers/{modifierId}/recipe-effects   @RequirePermission(VIEW)  // recipe.view
  PUT /modifiers/{modifierId}/recipe-effects   @RequirePermission(EDIT)  // recipe.edit
 INVENT NO PERMISSION. PUT is a full replace shaped like
 PUT /recipes/:id/versions/:v/lines. Validate XOR shape, add/remove_all rules,
 kind<->effect consistency vs Modifier.kind (service-level). Validate modifierId
 via composite FK + rethrowAsNotFoundOnFk -> 404.
 New audit action MODIFIER_RECIPE_EFFECTS_REPLACED.

====================================================================
E. INVENTORY — DUAL AXIS  (P1F2E-A is CONTROLLING)
====================================================================
NEW src/modules/inventory/contract/:
  SALE_DEPLETION_COMMAND + depleteForCompletedSale(tx, {tenantId, actorId,
    branchId, orderId, businessDay, occurredAt, lines})
  Inventory resolves the branch location itself from
    org.locations (tenant_id, location_type='branch', ref_id=branchId).

NEW PRIVATE KERNEL (NOT a contract, NOT exported cross-module):
  src/modules/inventory/costing/fifo-cost-ledger.ts, owning:
    lockLayers(tx, tenantId, stockItemId, locationId)
      SELECT ... FROM inventory.stock_batches
      WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
        AND ( quantity_remaining > 0
           OR (quantity_received - fifo_cost_quantity_consumed) > 0 )
      ORDER BY created_at ASC, id ASC        -- ONE ordering for BOTH axes
      FOR UPDATE;                             -- NEVER SKIP LOCKED
    planFifoCostConsumption(lockedLayers, quantity)   -- receipt order
    applyCostConsumption(tx, slices)                  -- increments the counter
    findCarryForwardBasis(tx, ...)                    -- returns {batchId, unitCost}
  USED BY BOTH: (A) SaleDepletionCommand, (B) MovementsService.post for counter
  maintenance. Both therefore take compatible FOR UPDATE locks in the SAME order.
  The dual physical/cost ZIPPER stays in SaleDepletion, not in the kernel.

TWO INDEPENDENT AXES — NEVER CONFLATE:
  batch_strategy (fifo|fefo) -> WHICH PHYSICAL batch is decremented.
  costing_method             -> WHAT COST is charged.
Both honoured simultaneously. FEFO cost is NEVER called FIFO. The fifo+fefo
combination is NEVER refused and NEVER falls back to another method.

Process distinct (stock_item_id, location_id) ASC, then order_line_id ASC.
NEVER JS map iteration order.

PER (OrderLine, StockItem, Location) — ORDER IS NORMATIVE (P1F2E-A §E):
 STEP 1  RESERVE THE BUSINESS IDENTITY FIRST — before ANY Inventory mutation:
   INSERT INTO inventory.sale_depletion_effects (...)
   ON CONFLICT (tenant_id, order_line_id, stock_item_id, location_id) DO NOTHING
   RETURNING id;
   NEVER INSERT-catch-P2002-then-query (P1E-5A rejected it).
 STEP 2  0 rows -> raise a conflict IMMEDIATELY. No Inventory state touched.
 STEP 3  WINNER ONLY, in this order:
   3a lock layers via the kernel (one ordering, both axes)
   3b PHYSICAL PLAN: eligible quantity_remaining > 0;
        fifo -> created_at ASC, id ASC
        fefo -> expiry_date ASC NULLS LAST, created_at ASC, id ASC
      Emit (physical_batch_id, qty); unbacked remainder -> physical_batch_id NULL
      (negative stock permitted, FR-INV-014). Decrement quantity_remaining.
   3c COST PLAN:
        weighted_average -> one slice (cost_basis_batch_id NULL,
                            unit_cost = stock_levels.average_cost). Outbound NEVER
                            changes average_cost.
        standard         -> one slice (NULL, stock_items.standard_cost). No fallback.
        fifo             -> eligible (quantity_received - fifo_cost_quantity_consumed) > 0
                            ORDER BY created_at ASC, id ASC   -- RECEIPT ORDER ALWAYS
                            Emit (cost_basis_batch_id, qty, layer unit_cost);
                            increment fifo_cost_quantity_consumed.
        CARRY-FORWARD for any uncovered remainder, AFTER the increments — one
        query serves partial AND zero coverage, and it returns BOTH columns:
          SELECT id, unit_cost FROM inventory.stock_batches
          WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
            AND (quantity_received - fifo_cost_quantity_consumed) = 0
          ORDER BY created_at DESC, id DESC LIMIT 1;
        The allocation stores cost_basis_batch_id = THAT BATCH ID and its
        unit_cost, even though physical_batch_id is NULL. For costing_method=fifo
        EVERY valued allocation has a NON-NULL cost_basis_batch_id.
        If no exhausted accounting layer exists either -> throw a distinct domain
        error and roll the WHOLE Completion back. NO weighted-average, NO standard,
        NO latest-purchase fallback for FIFO. Do NOT modify valuationUnitCost.
   3d ZIPPER (exact Decimal, no floating point): two-pointer merge of the physical
      and cost plans over the same total D; take = min(remaining, remaining);
      emit {physicalBatchId, costBasisBatchId, quantity, unitCost}.
      Σ emitted quantity MUST equal D exactly. For non-FIFO costing the cost plan
      is one slice, degenerating to one allocation per physical batch.
   3e PER ALLOCATION, deterministic order, exactly three statements
      (projection-first-with-pointer is FK-ILLEGAL: stock_levels.last_movement_id
       is an IMMEDIATE composite FK and no DEFERRABLE constraint exists here):
      1) INSERT INTO inventory.stock_levels (tenant_id, stock_item_id, location_id,
             quantity_on_hand)
         VALUES ($1,$2,$3,$4::numeric)              -- signed delta (negative)
         ON CONFLICT (stock_item_id, location_id) DO UPDATE
            SET quantity_on_hand = inventory.stock_levels.quantity_on_hand
                                 + EXCLUDED.quantity_on_hand
         RETURNING quantity_on_hand;
         -- does NOT touch last_movement_*; does NOT touch average_cost
      2) INSERT the stock_movement with balance_after = the value from (1),
         movement_type='sale_depletion', reference_type='order',
         reference_id = ORDER id (NOT order_line_id), quantity NEGATIVE,
         unit = the stock item's base unit,
         batch_id = physical_batch_id (NULL only for an unbacked slice),
         unit_cost = the ACTUAL cost-basis unit cost (NEVER blended).
      3) UPDATE inventory.stock_levels SET last_movement_id=$m,
            last_movement_occurred_at=$t WHERE stock_item_id=$2 AND location_id=$3;
      Do NOT batch allocations into one projection delta — per-movement
      balance_after must stay truthful (BR-INV-003).
   3f INSERT sale_depletion_allocations rows, sequence 0..N-1, carrying
      stock_item_id and location_id (for the composite FKs).
      ASSERT Σ allocations.quantity_in_base_unit == effect.quantity_in_base_unit.

ARITHMETIC — exact, ONE rounding point PER ALLOCATION:
  allocation.total_cost = round_half_up(quantity × unit_cost)   POSITIVE magnitude
  quantity is NEGATIVE on the movement; total_cost is POSITIVE (repo convention,
  test-locked by costing.spec.ts:184-186 — a deliberate §7.4.3 deviation).
  Posted COGS comes from total_cost ONLY — never recompute unit_cost × quantity.

COUNTER MAINTENANCE ELSEWHERE:
  Route MovementsService.post's batch access through the SAME kernel so that, for
  costing_method='fifo' batch-tracked items, an outbound consumption also advances
  fifo_cost_quantity_consumed in RECEIPT order by the same total quantity, under
  the same FOR UPDATE ordering. This is COUNTER MAINTENANCE AND LOCKING ONLY —
  do NOT change valuationUnitCost, and do NOT change how transfers/waste/counts
  are VALUED. Their pre-existing stock_levels lost update stays out of scope.

NEGATIVE STOCK NEVER BLOCKS COMPLETION (FR-INV-014, UC-POS-01 13a).
Recipe-cost recomputation: recomputeForStockItems ONCE, after all movements, with
the DISTINCT FIFO stock items only.

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
              11b depleteForCompletedSale (reserve-first dual-axis; valued allocations)
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
  1 HTTP Idempotency-Key — unchanged interceptor
  2 permanent client Payment id (FR-OFF-015) — step 1, BEFORE any completion
    read/write. Identical facts -> replay; differing immutable fact -> 409.
  3 sale_depletion_effects UNIQUE key, reserved BEFORE any Inventory mutation.
No separate completion-operation id.

====================================================================
H. REQUIRED TESTS
====================================================================
FINANCIAL: OPEN -> COMPLETED via one settling payment; PARTIALLY_PAID ->
  COMPLETED; partial stays PARTIALLY_PAID; exact settlement; over-tendered cash
  + change; manual external card; permanent-id replay AFTER completion; HTTP
  replay after completion; same Payment id different facts -> 409; stale
  If-Match -> 409.
ATOMICITY: force a failure at EACH mandatory stage — expansion, modifier
  resolution, effect reservation, batch lock/plan, counter update, allocation
  insert, stock movement, stock-level projection, COGS projection, Order CAS,
  audit, order.completed handler — and prove TOTAL rollback.
MIGRATION UPGRADE (mandatory — clean-from-zero is INSUFFICIENT):
  - migrate through 29; create a FIFO-costed + FEFO-strategy item with >=2
    batches whose expiry order contradicts receipt order; consume physically so
    the axes diverge; apply migration 30; assert fifo_cost_quantity_consumed is
    RECEIPT-ORDER correct and is NOT a per-batch copy of physical consumption.
  - assert the guard RAISES on a deliberately corrupt
    quantity_remaining > quantity_received row.
DUAL-AXIS: fifo+fifo coincide; fifo costing + FEFO physical (physical by expiry,
  cost by receipt — assert both); one OrderLine spanning >=2 physical batches
  with EVERY batch attributable; one physical batch split across >=2 cost layers;
  one cost layer across >=2 physical FEFO batches; Σ allocation quantities ==
  requested depletion; Σ allocation total_cost == line posted_cogs_total and
  Σ lines == orders.cogs_total; PROVE NO weighted-average fallback (make
  average_cost differ sharply from the layer cost); no-historical-layer fails closed.
CARRY-FORWARD PROVENANCE: zero physical stock -> allocation has
  physical_batch_id NULL AND cost_basis_batch_id = the ACTUAL exhausted FIFO
  batch; a LATER receipt does not change that historical explanation.
TRACEABILITY: batch -> Orders/OrderLines; Order -> physical batches;
  OrderLine -> cost-basis layers; effect -> all its movements.
STRUCTURAL (these assert ENCODED FK behaviour): an allocation cannot bind effect
  item A to a physical batch of item B; nor effect location A to a batch at
  location B; same two for cost_basis_batch_id; cross-tenant impossible.
  The allocation<->movement item/location binding is SERVICE-ENFORCED — test it
  as service behaviour and DO NOT claim the FKs encode it.
CONCURRENCY (real PostgreSQL barriers, NO sleeps, >=3 clean runs each):
  1 two settling Payments, same Order, same version -> exactly one winner;
  2 two Orders, same weighted-average item -> BR-INV-003:
    SUM(stock_movements.quantity) == stock_levels.quantity_on_hand;
  3 two Orders, same FIFO item, overlapping PHYSICAL and COST layers ->
    deterministic consumption on BOTH axes, no double consumption;
  4 COMPLETION vs existing MovementsService outbound (e.g. waste) on the same
    FIFO item/location, barrier before counter mutation -> final counter state
    equals the SERIAL result exactly;
  5 lock-order inversion: two completions touching the same two stock items in
    opposite input order -> both succeed, no deadlock.
IDEMPOTENCY ORDER: a conflicting pre-existing effect produces ZERO batch changes,
  ZERO counter changes, ZERO stock-level changes, ZERO movements, ZERO allocations.
INVENTORY/MODIFIERS/PINNING/GAPS: nested expansion; same item via multiple
  sub-recipe paths aggregated WITHIN a line; same item on two lines independently
  traceable; absent recipe (0 depletion, posted COGS 0); incomplete recipe;
  negative stock; each costing method; ADD; REMOVE_ALL; substitution; "no cheese"
  depletes NO cheese; REMOVE_ALL of an absent component is a no-op; double-modifier
  scaling; a later modifier_recipe_effects edit does NOT change a captured line;
  changing base_unit_id or a uom_conversions factor after capture does NOT change
  that line's completed depletion; VALUATION gap rolls back (not zeroed);
  STRUCTURAL gap depletes partially.
RLS / APPEND-ONLY: via the REAL ros_app connection (app.get(PrismaService)), never
  the migrator client — own-tenant SELECT/INSERT succeed; cross-tenant blocked;
  UPDATE and DELETE rejected on effects AND allocations; row survives; grants
  inspected from information_schema.
MODULE BOUNDARIES: Production's and Inventory's contract/ files interface-only;
  impls outside contract/; the fifo-cost-ledger kernel is PRIVATE and imported by
  nothing outside Inventory; sales-payment.service.ts imports Production and
  Inventory ONLY from <module>/contract; KNOWN_DEVIATIONS DOES NOT GROW.

====================================================================
I. BUILD / VERIFY
====================================================================
  nest build; npx tsc --noEmit (only the known access-token.service.spec.ts
    baseline error may remain — ZERO new); eslint on changed files;
    npx prisma validate; git diff --check
  npm run openapi:check -> 3.1.0 and EXACTLY 135 operations. No /complete route.
  Clean FROM-ZERO scratch DB: 30 migrations, BOTH DATABASE_URL and
    APP_DATABASE_URL set; drop it after; PROVE the persistent `ros` dev DB was
    never migrated. ALSO run the migration-UPGRADE test above.
  Full unit suite + full E2E suite, green.
  NFR-PERF-006: benchmark planConsumption PLUS depleteForCompletedSale inside the
    Completion transaction. 30 lines, NESTED recipes (depth >= 2), mixed costing
    methods, multi-batch FIFO items, modifiers present. >=20 iterations. Report
    p50 AND p95. COMPLETE only if measured p95 <= 200 ms; otherwise PARTIAL with
    the real number.
  DO NOT COMMIT. DO NOT PUSH.

====================================================================
NON-GOALS
====================================================================
No refunds/voids/reversals. No PaymentAttempt or integrated card. No receipt.
No fiscal document or outbox. No loyalty/CRM. No table release. No session/day
close. No X/Z reports. No comp mechanism. No Costing module. No separate
accounting cost-layer TABLE (the batch is the cost layer). No new permission.
No RFC7807. No /v1. No FR-INV-027 reporting surface (substrate only). Do NOT fix
MovementsService.post's stock_levels lost update for transfers/counts/waste. Do
NOT change valuationUnitCost or how transfers/waste/counts are VALUED. Do NOT
retire the existing sales->production KNOWN_DEVIATIONS entry. Do NOT add
exhausted_at or any stock_movements / stock_levels schema change. Do NOT add a
unique index to stock_movements for item/location binding.

====================================================================
REPORT
====================================================================
Write docs/reports/claude/2026-08-26_P1F2_order-completion.md with the required
ROS header. Include full verification evidence, MEASURED p50/p95, exact test
counts, every deviation and residual risk, and honest reporting of any failure.
Classifications — do NOT overclaim:
  FR-INV-012 COMPLETE for the completion path
  FR-INV-013 COMPLETE for the completion path (receipt-order costing AND every
    physical batch recorded); NOT claimed globally
  FR-INV-022/023 COMPLETE · FR-INV-027 substrate only, reporting NOT IMPLEMENTED
  FR-INV-030 COMPLETE for sales · BR-INV-003 COMPLETE for the completion path
  FR-CST-001 COMPLETE (after verification) · FR-CST-002 PARTIAL
  FR-POS-024 COMPLETE only with the config API + snapshot + passing no-cheese test
  NFR-PERF-006 PARTIAL unless measured · §1.2 PARTIAL · UC-POS-01 PARTIAL
Record as residual, out-of-scope debt: the stock_levels lost update and the
receipt-order VALUATION of transfers/counts/waste.
Update docs/reports/claude/INDEX.md.

DEFINITION OF DONE: 30 migrations from zero on a clean scratch DB AND the
migration-upgrade test green; full unit + full E2E green; concurrency tests >=3
clean runs each including Completion-vs-MovementsService; all dual-axis,
carry-forward-provenance, traceability and structural tests green; historical
pinning green; performance measured and reported; OpenAPI 3.1.0 / 135 with zero
drift; tsc clean apart from the known baseline; report + INDEX written; nothing
committed or pushed; the three preserved user files untouched.
```
