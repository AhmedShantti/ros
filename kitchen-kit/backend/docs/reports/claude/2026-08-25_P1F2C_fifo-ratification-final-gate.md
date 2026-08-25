# P1F-2C — FIFO Exhaustion Carry-Forward Ratification & Final Implementation Gate

**Report type:** Governance recording + narrow design reconciliation + final readiness gate (no production code, no production migration, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted architecture/design records → repository evidence**. Nothing here creates a numbered decision.
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (verified unchanged — no commit)
**Branch:** `feat/production-spec`
**Working tree:** three preserved user files (`.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts`), the P1F-2 / P1F-2A / P1F-2B reports, the governance register, INDEX, plus this report
**Task identifier:** P1F-2C

> ## VERDICT (§M)
> ## **IMPLEMENTATION READY**
> The single P1F-2B blocker is closed by the user's ratified **FIFO Exhaustion
> Carry-Forward** rule. Every P1F-2B correction is preserved unchanged, no new
> schema is required, migrations remain **30**, OpenAPI remains **134**, and the
> replacement Sonnet 5 implementation prompt is generated in **§N**.

---

## A. STARTING STATE

| Check | Result |
|---|---|
| Branch | `feat/production-spec` |
| `git rev-parse HEAD` | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` |
| `origin/feat/production-spec` | `cf04e008…` — matches, no divergence |
| `origin/main` | `01c0b0f3d3228af5248782a09e8dc0bc65606f9e` — untouched |
| Migrations | **27** |
| OpenAPI | **3.1.0**, **133** operations |
| Preserved user files | untouched |

No branch operation, no destructive git command, no commit, no push.

## B. FIFO RATIFICATION RECORDED

Recorded in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` as the unnumbered entry **“FIFO Exhaustion Carry-Forward Ratification — 2026-08-25”**, inserted after the *P1F-2 Completion Economics & Depletion Resolution* entry and before *Final Decision Matrix*, in the established unnumbered style.

- **No D-21 or later decision created**; tally remains 17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN.
- Original **P1C-2** text and the original **D-17-05** text in `PRODUCTION_SPEC_DESIGN_GATE.md` §4 are **preserved verbatim and not rewritten**.
- The entry states explicitly: scope is Inventory movement valuation at Completion only; available layers are always consumed first; only the uncovered remainder carries forward; the zero-layer case uses the most recently *exhausted* layer; no weighted-average / standard / latest-purchase fallback; Production sale-time valuation unchanged; negative stock never blocks Completion; no retroactive COGS rewrite; terminal case fails closed.
- **D-16 OPEN · D-12 BLOCKED · D-3 RATIFIED IN PART · P-1** preserved, together with P1C-1, P1C-5, P1D-B…G, the Fire Authorization Ratification and the P1F-2 Completion Economics entry.

## C. P1C-2 NARROW AMENDMENT

P1C-2's clause — *“Every component is valued by **its own** configured costing method … No global default, no fallback between methods”* — is narrowed **for this case only**, and is now to be read as forbidding:

- substituting a **different costing method** for an available FIFO layer, and
- substituting a **purchase-price lookup** for an available FIFO layer.

It does **not** forbid continuing an item's **own FIFO cost lineage** at its last actual layer cost when the queue is empty and the SRS defines no value. Carry-forward is FIFO-native: the cost originates from a real FIFO layer **of that same item and location**, selected by the same strategy that consumed it. Every other clause of P1C-2 stands, including BR-MNU-012's preservation and the prohibition on a global default.

## D. FIFO AVAILABLE-LAYER RULE (unchanged)

Normal FIFO is untouched. For each `(stock_item, location)` whose item is FIFO-costed **and** batch-tracked:

```sql
SELECT id, quantity_remaining, unit_cost, created_at, expiry_date
FROM inventory.stock_batches
WHERE tenant_id = $1 AND stock_item_id = $2 AND location_id = $3
  AND quantity_remaining > 0
ORDER BY <strategy ASC>            -- fifo: created_at ASC, id ASC
                                   -- fefo: expiry_date ASC NULLS LAST, created_at ASC, id ASC
FOR UPDATE;                        -- never SKIP LOCKED
```

Layers are drawn down in that order; **each backed quantity is valued at its own actual layer cost**. `batch_id` is recorded on the movement when exactly one layer was consumed (existing convention preserved). Carry-forward is never used while a positive layer remains.

## E. FIFO PARTIAL-COVERAGE RULE

Where the depletion exceeds the total remaining quantity:

1. Consume every available layer normally, in strategy order.
2. Value each backed quantity at **its own layer cost** — no blending across layers.
3. Value **only the unbacked remainder** at the unit cost of the **last layer consumed in this same plan**.

**Key simplification, and it is exact:** in the partial-coverage case the “most recently exhausted layer” *is the final layer of our own consumption plan* — we exhausted it moments earlier, inside this transaction. **No historical query is needed.** The carry-forward cost is `consumed[consumed.length - 1].unitCost`.

This preserves layer-level FIFO truth for the backed portion, which a single blended mean over the whole depletion would destroy — exactly what the ratification forbids.

## F. FIFO ZERO-LAYER RULE

Where **no** positive-quantity layer exists at the start of the depletion, the entire quantity is unbacked and is valued at the unit cost of the **most recently exhausted layer** for the same `tenant · stock_item · location`, resolved by the query in §G.

Explicitly **not** used: `stock_levels.average_cost`, `stock_items.standard_cost`, or any newest-receipt lookup.

**Terminal edge case — proven unreachable through the sale path, and fails closed regardless.**

- Batch history is structurally protected: there is **no `stockBatch.delete` path anywhere in `src/`**; `stock_batches`' FKs to tenants, stock items and locations are all **`ON DELETE RESTRICT`** (so no cascade can remove them); and `stock_movements.batch_id → stock_batches(tenant_id, id)` is likewise **`ON DELETE RESTRICT`**, hard-pinning every batch a single-batch movement ever referenced.
- The only configuration with no layers at all is a **FIFO-costed, `is_batch_tracked = false`** item. Such an item cannot reach Completion through a complete recipe: Production's `StockValuationService` filters `quantityRemaining > 0`, returns `null`, and P1C-5 **refuses the sale at line capture** (422). An incomplete recipe's *defined* component that cannot be priced is likewise a VALUATION gap and is refused; an absent recipe depletes nothing.
- **Defence in depth:** if no historical exhausted layer is found, the depletion raises a distinct domain error and the whole Completion **rolls back**. It never silently adopts another costing method. This is consistent with P1C-5's own precedent (an unpriceable complete recipe is refused, not zero-costed), and it costs nothing operationally because the case is unreachable.

## G. HISTORICAL LAYER QUERY

`inventory.stock_batches` carries **no `updated_at`, no `exhausted_at`, and no depletion-history column** — only `created_at` (receipt time), `quantity_remaining`, `unit_cost`, `expiry_date`. **No such column is added** (see §J).

Exhaustion order is therefore **inferred from the item's own consumption strategy**, which is exact rather than approximate — see the validity proof below. The query is the **reverse of the strategy's ascending order**, restricted to exhausted layers, taking the first row:

```sql
-- costing_method = 'fifo', batch_strategy = 'fifo'
SELECT unit_cost FROM inventory.stock_batches
WHERE tenant_id = $1 AND stock_item_id = $2 AND location_id = $3
  AND quantity_remaining = 0
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- costing_method = 'fifo', batch_strategy = 'fefo'
SELECT unit_cost FROM inventory.stock_batches
WHERE tenant_id = $1 AND stock_item_id = $2 AND location_id = $3
  AND quantity_remaining = 0
ORDER BY expiry_date DESC NULLS FIRST, created_at DESC, id DESC
LIMIT 1;
```

These are the exact reverses of `selectBatches`' orderings (`costing.ts:63-71`), which sort FIFO by `receivedAt` ascending and FEFO by `expiryDate ?? +Infinity` ascending then `receivedAt` — hence `NULLS FIRST` on the reversed FEFO ordering. `id DESC` is added as a deterministic tie-break, which `selectBatches`' JS sort lacks.

**Why the inference is exact, not a guess.** Every reduction of `quantity_remaining` in the entire codebase flows through `MovementsService.post`, which computes its plan solely via `selectBatches(...)` — there is no other writer. Consumption therefore always follows the configured strategy, so the layer exhausted last is by construction the last layer in strategy order among exhausted layers. It coincides with the most recently *received* layer only under `batch_strategy = 'fifo'`, where those genuinely are the same historical row — which is precisely the distinction the ratification demands.

**Stated limitation.** The ordering is derived, not recorded. If a future slice ever introduces out-of-strategy batch consumption (a direct batch adjustment, a manual layer write-off), the inference would weaken and an explicit `exhausted_at` would become warranted. That is recorded here as a forward obligation, **not** implemented now.

**Locking / concurrency.** The carry-forward row need not be locked: exhausted layers are immutable in practice (inbound receipts create *new* batches; nothing refills a spent layer), and within our own transaction the set of exhausted layers only grows through our own consumption — which is exactly the layer §E already identifies without a query. The read happens inside the same transaction, after the positive-layer `FOR UPDATE`, so it observes a consistent snapshot.

**Index.** `@@index([tenantId, stockItemId, locationId])` already serves the equality predicate. **No new index is required.** The zero-coverage path executes at most once per `(item, location)` per completion. If profiling later shows pressure, a partial index on `quantity_remaining = 0` is a future optimisation, not a P1F-2 change.

## H. EXACT COST ARITHMETIC

All arithmetic is exact — `Prisma.Decimal` quantities, `bigint` money, `common/money/rational` for intermediates. **No floating point.** The repository's **positive-magnitude** movement-cost convention (P1F-2B §I, test-locked by `costing.spec.ts:184-186`) is preserved: `quantity` carries the sign, `total_cost` carries the magnitude.

**One rounding point**, at the movement:

```
backedValue   = Σ_i ( layerQty_i  × layerUnitCost_i )          -- exact Rational
unbackedValue = unbackedQty × carryForwardUnitCost              -- exact Rational
total_cost    = round_half_up( backedValue + unbackedValue )    -- bigint, POSITIVE
```

For `weighted_average` and `standard` there is a single cost, so this reduces to the existing `total_cost = round_half_up( |quantity| × unit_cost )`.

**`stock_movements.unit_cost` is a derived representative only**, because the column admits one value while a FIFO depletion may span layers at different costs:

```
unit_cost = round_half_up( total_cost / |quantity| )            -- representative, NOT authoritative
```

**The authoritative posted-COGS amount is `total_cost`.** Posted COGS must never be recomputed as `unit_cost × quantity` — that would reintroduce rounding error and erase layer truth. Accordingly:

```
order_lines.posted_cogs_total = exact bigint Σ of that line's effect total_cost   -- no rounding
orders.cogs_total             = exact bigint Σ of line posted totals              -- no rounding
```

`sale_depletion_effects` stores both `unit_cost` (representative) and `total_cost` (authoritative), matching the movement. Layer-level truth is preserved in the ledger by the per-layer valuation feeding `total_cost`, and by `batch_id` where a single layer was consumed.

## I. P1F-2B CORRECTIONS PRESERVED

All carried forward unchanged; the FIFO ratification mechanically affects none of them.

| Correction | Status |
|---|---|
| Conversion gaps fail closed; mass↔volume never silently zeroed | **PRESERVED** |
| Resolved net base-unit consumption snapshotted at line capture | **PRESERVED** |
| Sales consumption snapshots append-only (SELECT+INSERT only) | **PRESERVED** |
| Recipe-version provenance snapshot retained | **PRESERVED** |
| `production.modifier_recipe_effects` — ADD / REMOVE_ALL; substitution = REMOVE_ALL + ADD | **PRESERVED** |
| Production `PUT /modifiers/{id}/recipe-effects` under `recipe.edit` | **PRESERVED** |
| OpenAPI 134 | **PRESERVED** |
| Non-partitioned `sale_depletion_effects`, key `(tenant_id, order_line_id, stock_item_id, location_id)` | **PRESERVED** |
| One effect = one stock movement | **PRESERVED** |
| Movement `total_cost` positive magnitude | **PRESERVED** (and now spans FIFO layers — §H) |
| Atomic additive stock-level update; corrected FK-safe three-statement order | **PRESERVED** |
| Deterministic FIFO row locking, no `SKIP LOCKED` | **PRESERVED** (carry-forward adds no lock — §G) |
| Line-scoped COGS | **PRESERVED** |
| FR-CST-002 remains **PARTIAL** | **PRESERVED** |
| `order.completed` event version **1** | **PRESERVED** |
| Synchronous Production/Inventory contracts under §5.5.1; event as in-transaction fact; zero P1F-2 subscribers reported honestly | **PRESERVED** |
| One UnitOfWork transaction; Order CAS last | **PRESERVED** |
| No `/complete` route; `pos.payment.capture` only | **PRESERVED** |

## J. MIGRATION PLAN

**Unchanged: 27 → 30.** Three module-owned migrations, exactly as corrected in P1F-2B §M.

- **28 — SALES:** `ck_completed` CHECK; `order_lines.posted_cogs_total` (nullable, zero-downtime); `sales."ConsumptionProvenance"` enum; `sales.order_line_consumption_components` (append-only); `sales.order_line_recipe_versions` (append-only).
- **29 — PRODUCTION:** `production."ModifierEffectOperation"` enum; `production.modifier_recipe_effects` (editable master data, full DML, all four policies).
- **30 — INVENTORY:** `inventory.sale_depletion_effects` (non-partitioned, append-only, SELECT+INSERT only).

**No schema is added for FIFO carry-forward.** Repository inspection proves the historical basis is safely queryable from existing columns: `quantity_remaining`, `unit_cost`, `created_at`, `expiry_date`, served by the existing `@@index([tenantId, stockItemId, locationId])` (§G). **No `exhausted_at` column, no new index, no change to `inventory.stock_batches` or `inventory.stock_movements`.**

## K. OPENAPI

**3.1.0 / 134 operations.** Baseline 133 (independently verified: 95 paths; Production 10, Catalogue 38) **+1** for `PUT /modifiers/{modifierId}/recipe-effects`. Completion reuses `POST /orders/{businessDay}/{id}/payments`; **no `/complete` route**; no new Payment route. Repository audit does not contradict this.

## L. REQUIREMENT CLASSIFICATION

Corrected classifications preserved from P1F-2B; none is relaxed by this ratification.

| Requirement | POST-P1F-2 |
|---|---|
| **FR-CST-001** | **COMPLETE only after implementation and verification** |
| **FR-CST-002** | **PARTIAL** — substantive immutability honoured; literal persistence location differs under the ratified two-field reconciliation |
| **FR-POS-024** | **COMPLETE only after** the modifier configuration API exists, line capture snapshots effects, **and** a real no-cheese depletion test passes |
| **BR-INV-003** | **COMPLETE for the Completion path only after** the concurrency tests pass; still at risk for transfers/counts/waste |
| **NFR-PERF-006** | **PARTIAL until a measured p95 ≤ 200 ms is reported** |
| **FR-INV-012 / 013** | **COMPLETE** for the completion path — layer-level FIFO valuation plus the ratified carry-forward |
| **FR-INV-014** | **COMPLETE** — negative stock recorded, never blocking |
| **FR-INV-004** | **PARTIAL** — rejection honoured in effect; `Uom.dimension` still never read (BR-CORE-004 not implemented) |
| **§1.2** | **PARTIAL** — effects 1–8 satisfied; effect 9 unreachable. **NOT COMPLETE** |
| **UC-POS-01** | **PARTIAL** — fiscal receipt / outbox / table release remain absent. **NOT COMPLETE** |

## M. IMPLEMENTATION READINESS

Can P1F-2 now be implemented without inventing mandatory financial, inventory, modifier, conversion, idempotency, concurrency, event, permission, schema or transaction semantics?

| Domain | Settled by |
|---|---|
| Financial (settlement, posted COGS, rounding, sign) | §24.2.4 + P1F-2A §D/§F + P1F-2B §I + §H here |
| Inventory (FIFO layers, partial coverage, zero layers, negative stock) | FR-INV-012/013/014 + **this ratification** (§D–§G) |
| Modifier (ADD/REMOVE_ALL, substitution, configuration API) | Ratified §3.2 + P1F-2B §G |
| Conversion (gaps, historical stability) | P1F-2B §D/§E — fail closed, snapshot at capture |
| Idempotency (HTTP key, permanent Payment id, effect registry) | FR-API-020/022/023, FR-OFF-015, P1F-2A §I |
| Concurrency (stock levels, FIFO locks, Order CAS) | P1F-2B §H + P1F-2A §N |
| Event (`order.completed`, version) | §5.5.4 + §24.2.4 + P1F-2B §K |
| Permission | `pos.payment.capture`, `recipe.edit` — **none invented** |
| Schema | 3 module-owned migrations, fully specified |
| Transaction | §5.5.1 + the UoW contract (P1F-2B §L) |

The last remaining blocker is closed. Nothing outstanding is a governance question; what remains is ordinary implementation work.

# **IMPLEMENTATION READY**

## N. FINAL SONNET IMPLEMENTATION PROMPT

**This supersedes P1F-2A §AA in full.** Do not use that prompt.

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
#   > docs/reports/claude/2026-08-25_P1F2C_fifo-ratification-final-gate.md   (FIFO rules)
#   > docs/reports/claude/2026-08-25_P1F2B_completion-correction-gate.md     (THE DESIGN)
#   > repository code
#
# READ IN FULL BEFORE WRITING ANY CODE:
#   2026-08-25_P1F2B_completion-correction-gate.md   <- primary design
#   2026-08-25_P1F2C_fifo-ratification-final-gate.md <- FIFO valuation rules
#   2026-08-25_P1F2A_completion-resolution-gate.md   <- context (its §AA is SUPERSEDED — ignore it)
#   the two governance entries above, plus P1C-2, P1C-5, P1D-B..G
#   CLAUDE.md
#
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
  .gitignore
  src/main.ts
  src/scripts/seed-dev-data.ts
Never migrate the persistent `ros` dev database. Use a disposable scratch DB and
set BOTH DATABASE_URL and APP_DATABASE_URL (the app reads APP_DATABASE_URL).

====================================================================
B. THREE MODULE-OWNED MIGRATIONS — 27 -> 30
====================================================================
Never edit an existing migration. Never combine modules. Follow existing
conventions: header comment explaining WHY, composite tenant-safe FKs
(ADR 0008 D-09 / D-17-02), RLS ENABLE + FORCE, explicit grants.

MIGRATION 28 — SALES
  1. ALTER TABLE sales.orders ADD CONSTRAINT ck_completed
       CHECK (state <> 'completed' OR completed_at IS NOT NULL);        -- SRS §25.2
  2. ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;
     + CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0);      -- nullable, zero-downtime
  3. CREATE TYPE sales."ConsumptionProvenance" AS ENUM ('recipe','modifier_add');
  4. CREATE TABLE sales.order_line_consumption_components   -- P1F-2B §E
       id, tenant_id, business_day, order_line_id,
       stock_item_id, quantity_in_base_unit DECIMAL(18,6) NOT NULL CHECK (>0),
       unit_id, provenance, order_line_modifier_id NULL, created_at
       UNIQUE (tenant_id, order_line_id, stock_item_id)
       FK (tenant_id, order_line_id, business_day) -> sales.order_lines(tenant_id,id,business_day) CASCADE
       FK (tenant_id, stock_item_id) -> inventory.stock_items(tenant_id,id) RESTRICT
       FK (tenant_id, order_line_modifier_id) -> sales.order_line_modifiers(tenant_id,id) CASCADE
       FK (unit_id) -> inventory.uom(id) RESTRICT
       CHECK (order_line_modifier_id IS NOT NULL) = (provenance='modifier_add')
       NOT partitioned.
       GRANT SELECT, INSERT only; REVOKE UPDATE, DELETE, TRUNCATE;
       RLS ENABLE+FORCE with SELECT and INSERT policies ONLY.
  5. CREATE TABLE sales.order_line_recipe_versions
       id, tenant_id, business_day, order_line_id, recipe_version_id, depth, created_at
       UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)
       FK to order_lines CASCADE; FK (tenant_id, recipe_version_id) ->
         production.recipe_versions(tenant_id,id) RESTRICT
       Same append-only grants + RLS as (4).

MIGRATION 29 — PRODUCTION
  1. CREATE TYPE production."ModifierEffectOperation" AS ENUM ('add','remove_all');
  2. CREATE TABLE production.modifier_recipe_effects   -- P1F-2A §F
       id, tenant_id, modifier_id, operation, component_type, stock_item_id NULL,
       sub_recipe_id NULL, quantity DECIMAL(18,6) NULL, unit_id NULL, sequence, created_at
       REUSE the existing production."RecipeComponentType" enum — do NOT duplicate it.
       FK (tenant_id, modifier_id) -> catalogue.modifiers(tenant_id,id) CASCADE
       FK (tenant_id, stock_item_id) -> inventory.stock_items(tenant_id,id) RESTRICT
       FK (tenant_id, sub_recipe_id) -> production.recipes(tenant_id,id) RESTRICT
       FK (unit_id) -> inventory.uom(id) RESTRICT
       CHECK ck_mre_component: XOR stock_item_id / sub_recipe_id agreeing with component_type
       CHECK ck_mre_remove_all: operation='remove_all' => component_type='stock_item'
                                AND quantity IS NULL AND unit_id IS NULL
       CHECK ck_mre_add: operation='add' => quantity IS NOT NULL AND quantity>0
                         AND unit_id IS NOT NULL
       UNIQUE (tenant_id, id); INDEX (tenant_id, modifier_id)
       RLS ENABLE+FORCE, all four policies; GRANT SELECT, INSERT, UPDATE, DELETE
       (this IS editable master data).
  3. Leave catalogue.modifiers.recipe_delta EXACTLY as is — still opaque, never read.

MIGRATION 30 — INVENTORY
  1. CREATE TABLE inventory.sale_depletion_effects   -- P1F-2A §I, NON-partitioned
       id, tenant_id, order_id, business_day, order_line_id, stock_item_id, location_id,
       quantity_in_base_unit DECIMAL(18,6) NOT NULL, unit_id,
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
  4. DO NOT alter inventory.stock_movements or inventory.stock_batches.
     NO exhausted_at column. NO new index. (P1F-2C §J)

====================================================================
C. SALES
====================================================================
LINE CAPTURE (OrderLinesService.create, inside the SAME existing transaction):
  - persist the resolved recipe-version closure into order_line_recipe_versions
  - persist the resolved NET base-unit consumption into
    order_line_consumption_components (quantities only, never valuation)
  - record applied REMOVE_ALL operations in the line-capture AUDIT metadata
    (P1C-5 item-7 precedent — no extra table)
  - do NOT change existing pricing/tax/unit_cost_snapshot behaviour
  IN-SCOPE MICRO-FIX: recomputeOrderTotals currently does
      cogs = (cogs ?? 0n) + line.unitCostSnapshot
  ignoring quantity. Multiply by line.quantity with ONE HALF_UP rounding.
  Change nothing else in that method. Test a qty=3 line contributes 3x.

COMPLETION:
  - order-state.ts: add 'completed' as a legal target from BOTH 'open' AND
    'partially_paid'. NEVER persist an intermediate state.
  - Order CAS (LAST mutation): paid_total, rounding_adjustment, state='completed',
    completed_at, closed_by (the EMPLOYEE — P1D-E), cogs_total, version+1.
  - order_lines.posted_cogs_total = exact bigint SUM of that line's effect
    total_cost. Absent recipe posts 0 (not NULL). NULL means "not completed".
  - orders.cogs_total = exact bigint SUM of line posted totals. No rounding at
    either level. Document the post-completion meaning in the schema comment.
  - Audits: PAYMENT_CAPTURED (unchanged) AND a new ORDER_COMPLETED action
    (entity 'order', with before{state,version,paidTotal}, gaps, movement ids,
    posted COGS). Adding an audit action is ordinary taxonomy, NOT a permission.
  - Publish order.completed, ORDER_COMPLETED_EVENT_VERSION = 1, payload EXACTLY
    per SRS §24.2.4 (orderId, branchId, businessDay, lines, totals, payments,
    completedAt, customerId=null). Invent no fields. Zero subscribers in P1F-2 —
    say so honestly in the report.
  - Migrate SalesPaymentService from prisma.withAuthContext to unitOfWork.execute
    (SalesFireService is the precedent) so it can publish.
  - Remove FULL_PAYMENT_REQUIRES_COMPLETION only once the settling path is green;
    replace its test with completion tests, do not delete coverage.

====================================================================
D. PRODUCTION
====================================================================
  - NEW src/modules/production/contract/ (Production's first contract):
      RECIPE_CONSUMPTION_QUERY symbol + interface, all methods tx-first:
        resolveVersionClosure(tx, recipeVersionId)
        resolveModifierEffects(tx, {tenantId, modifierIds})
        planConsumption(tx, input) -> QUANTITIES ONLY, never money
      Implementation PRIVATE, outside contract/, reusing RecipeCostService's
      existing traversal (it already computes quantityInBaseUnit and discards it).
      Extend the existing RECIPE_COST_RECOMPUTER port with
        recomputeForStockItems(tx, stockItemIds) -> string[]
  - Modifier semantics (deterministic, no DSL), evaluated per line:
      1 expand base recipe from the PINNED version closure
      2 aggregate per stock_item WITHIN the line
      3 apply ALL REMOVE_ALL  (zero that stock item's aggregate)
      4 apply ALL ADD         (expand sub-recipe ADDs, convert, scale)
      5 re-aggregate, drop non-positive
    REMOVE_ALL targets a stock_item only and removes EVERY occurrence at every
    depth. REMOVE_ALL of an absent component = NO-OP, not an error.
    ADD scaling = effect.quantity x order_line_modifiers.quantity x order_lines.quantity.
    ADD quantities are per SOLD PORTION — NOT divided by the base recipe yield.
    Removal STRICTLY precedes addition (this is what makes substitution correct).
    NEVER read catalogue.modifiers.recipe_delta.
  - CONVERSION GAPS FAIL CLOSED. Distinguish STRUCTURAL gaps
    (no_components / no_published_version -> tolerate, deplete partially,
    BR-MNU-012) from VALUATION gaps (no_valuation / no_unit_conversion -> THROW,
    roll back). P1F-2A's "a missing unit conversion is a gap, not a throw" is WRONG.
  - NEW ROUTE: PUT /modifiers/{modifierId}/recipe-effects
      @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)   // recipe.edit — INVENT NOTHING
      Full replace, shaped exactly like PUT /recipes/:id/versions/:v/lines:
      envelope body { effects: [...] } via a dedicated ReplaceDto with
      @ValidateNested({each:true}); deleteMany + createMany; response = count.
      Validate XOR component shape, add/remove_all field rules, and kind<->effect
      consistency against Modifier.kind (service-level; kind is nullable for
      legacy rows). Validate modifierId via the composite FK +
      rethrowAsNotFoundOnFk -> 404, exactly as RecipesService validates
      menuItemVariantId. New audit action MODIFIER_RECIPE_EFFECTS_REPLACED.

====================================================================
E. INVENTORY
====================================================================
  - NEW src/modules/inventory/contract/ (Inventory's first contract):
      SALE_DEPLETION_COMMAND symbol + SaleDepletionCommand.depleteForCompletedSale(
        tx, {tenantId, actorId, branchId, orderId, businessDay, occurredAt, lines})
      Inventory resolves the branch location itself from
        org.locations (tenant_id, location_type='branch', ref_id=branchId).
      Returns per line: {orderLineId, postedCogsTotal, effects[]}.
  - Sort ALL effects by (stock_item_id, location_id, order_line_id) ASC and process
    in that order. NEVER JS map iteration order. This is also the deadlock-avoidance
    lock ordering.
  - VALUATION (P1F-2C §D–§H):
      weighted_average -> stock_levels.average_cost. Outbound NEVER changes it.
      standard         -> stock_items.standard_cost. No fallback.
      fifo (batch-tracked):
        SELECT ... WHERE quantity_remaining > 0
          ORDER BY  fifo: created_at ASC, id ASC
                    fefo: expiry_date ASC NULLS LAST, created_at ASC, id ASC
          FOR UPDATE            -- NEVER SKIP LOCKED
        Consume oldest-first. Value EACH backed quantity at ITS OWN layer cost.
        PARTIAL COVERAGE: value the unbacked remainder at the unit cost of the
          LAST layer in our own consumption plan (consumed[last].unitCost).
          No historical query needed. Do NOT blend one mean over the whole depletion.
        ZERO COVERAGE: carry-forward from the most recently EXHAUSTED layer:
          SELECT unit_cost FROM inventory.stock_batches
          WHERE tenant_id=$1 AND stock_item_id=$2 AND location_id=$3
            AND quantity_remaining = 0
          ORDER BY  fifo: created_at DESC, id DESC
                    fefo: expiry_date DESC NULLS FIRST, created_at DESC, id DESC
          LIMIT 1;
        NO weighted-average, NO standard, NO latest-purchase fallback for FIFO.
        If NO exhausted layer exists either -> throw a distinct domain error and
        roll the whole Completion back. NEVER substitute another costing method.
        Do NOT modify the existing valuationUnitCost helper or MovementsService.post.
  - ARITHMETIC — exact, no floating point, ONE rounding point:
      backedValue   = Σ (layerQty_i × layerUnitCost_i)        exact Rational
      unbackedValue = unbackedQty × carryForwardUnitCost      exact Rational
      total_cost    = round_half_up(backedValue + unbackedValue)   POSITIVE magnitude
      unit_cost     = round_half_up(total_cost / |quantity|)       REPRESENTATIVE ONLY
    quantity is NEGATIVE on the movement; total_cost is POSITIVE (repo convention,
    test-locked by costing.spec.ts:184-186 — a deliberate §7.4.3 deviation).
    Posted COGS comes from total_cost ONLY — never recompute unit_cost × quantity.
  - WRITE ORDER — exactly three statements per (stock_item, location).
    P1F-2A's projection-first-with-pointer order is FK-ILLEGAL: 
    stock_levels.last_movement_id is an IMMEDIATE composite FK to the ledger and
    there is no DEFERRABLE constraint in this repo.
      1) INSERT INTO inventory.stock_levels (tenant_id, stock_item_id, location_id,
             quantity_on_hand)
         VALUES ($1,$2,$3,$4::numeric)              -- signed delta (negative)
         ON CONFLICT (stock_item_id, location_id) DO UPDATE
            SET quantity_on_hand = inventory.stock_levels.quantity_on_hand
                                 + EXCLUDED.quantity_on_hand
         RETURNING quantity_on_hand;                -- authoritative post-balance
         -- does NOT touch last_movement_*; does NOT touch average_cost
      2) INSERT the stock_movement with balance_after = the value returned by (1),
         movement_type='sale_depletion', reference_type='order',
         reference_id = ORDER id (NOT order_line_id), quantity NEGATIVE,
         unit = the stock item's base unit, batch_id set only when exactly one
         layer was consumed (existing convention).
      3) UPDATE inventory.stock_levels SET last_movement_id=$m,
             last_movement_occurred_at=$t WHERE stock_item_id=$2 AND location_id=$3;
         -- legal now; race-free because (1)'s row lock is held to COMMIT
    Decrement consumed batches under the FOR UPDATE lock.
  - EFFECT REGISTRY:
      INSERT INTO inventory.sale_depletion_effects (...)
      ON CONFLICT (tenant_id, order_line_id, stock_item_id, location_id) DO NOTHING
      RETURNING id, quantity_in_base_unit, unit_cost, total_cost, movement_id;
      0 rows => raise a conflict and let the WHOLE transaction roll back.
      NEVER INSERT-catch-P2002-then-query (P1E-5A rejected it).
  - NEGATIVE STOCK NEVER BLOCKS COMPLETION (FR-INV-014, UC-POS-01 13a).
  - Recipe-cost recomputation: call recomputeForStockItems ONCE, after all
    movements, with the DISTINCT **FIFO** stock items only. Skip weighted_average
    and standard — an outbound sale provably does not change their valuation.

====================================================================
F. ONE UNITOFWORK TRANSACTION
====================================================================
Normative order (P1F-2B §P). No nesting. No outbox for same-DB consequences.
No cross-module private query — every hop goes through a contract/ token.
  1 permanent Payment-id replay/conflict check   (MUST BE FIRST)
  2 load order + non-voided lines + consumption snapshots + version closures
  3 assertMayCapturePayment  4 assertVersion  5 CashSession facts
  6 pinned payment policy    7 tender computation   8 settlement decision
  9 insert immutable Payment
  PARTIAL  -> 10a existing P1F-1 CAS
  SETTLING -> 10b planConsumption (from the SNAPSHOT — no conversion at completion)
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
Three layers, engaged in this order:
  1 HTTP Idempotency-Key (FR-API-020/022/023) — unchanged interceptor
  2 permanent client Payment id (FR-OFF-015) — step 1 of the tx, BEFORE any
    completion read/write. Identical facts -> replay stored result;
    any differing immutable fact -> 409 fail closed.
  3 effect-registry UNIQUE key — defence in depth for the invariant.
No separate completion-operation id: (Order id, terminal 'completed', Payment id)
is sufficient.

====================================================================
H–M. REQUIRED TESTS  (all must pass; report exact counts)
====================================================================
FINANCIAL: OPEN -> COMPLETED via one settling payment; PARTIALLY_PAID ->
  COMPLETED; partial stays PARTIALLY_PAID; exact settlement; over-tendered cash
  + change; manual external card; Payment permanent-id replay AFTER completion;
  HTTP replay after completion; same Payment id different facts -> 409;
  stale If-Match -> 409.
ATOMICITY: force a failure at EACH mandatory stage — Production expansion,
  modifier resolution, effect reservation, stock movement, FIFO batch update,
  stock-level projection, COGS projection, Order CAS, audit,
  order.completed handler — and prove TOTAL rollback: no Payment, no completion,
  no partial depletion, no partial COGS, no audit residue.
INVENTORY: nested expansion; same stock item via multiple sub-recipe paths
  aggregated WITHIN a line; same stock item on two lines stays independently
  traceable; absent recipe; incomplete recipe; negative stock; each costing method.
FIFO (explicit): one layer; several layers; partial coverage with an unbacked
  remainder (assert the backed portion keeps its OWN layer costs and only the
  remainder carries forward); zero positive layers with historical exhausted
  layers (assert carry-forward from the most recently exhausted layer);
  PROVE NO weighted-average fallback (construct an item whose average_cost
  differs sharply from the last layer cost and assert the layer cost wins);
  and, if structurally reachable, the no-historical-layer case fails closed.
MODIFIERS: ADD; REMOVE_ALL; substitution (REMOVE_ALL + ADD); the "no cheese"
  case depletes NO cheese; REMOVE_ALL of an absent component is a no-op;
  double-modifier quantity scaling.
CONVERSION GAPS: fail closed — assert a VALUATION/conversion gap rolls back and
  is NOT silently zeroed; assert a STRUCTURAL gap depletes partially.
IDEMPOTENCY: exact replay creates no second effect row, movement, projection
  delta, COGS or audit.
CONCURRENCY (real PostgreSQL barriers, NO sleeps, >=3 clean runs each):
  1 two settling Payments, same Order, same version -> exactly one winner, one
    Payment, one effect set, one projection delta, one ORDER_COMPLETED audit;
  2 two different Orders on the same weighted-average item -> BR-INV-003:
    SUM(stock_movements.quantity) == stock_levels.quantity_on_hand;
  3 two different Orders on the same FIFO item -> deterministic layer
    consumption, correct per-order costs, no double consumption;
  4 lock-order inversion: two completions touching the same two stock items in
    opposite input order -> both succeed, no deadlock.
RLS / APPEND-ONLY / FK: via the REAL ros_app connection (app.get(PrismaService)),
  never the migrator client — own-tenant SELECT/INSERT succeed; cross-tenant
  blocked; UPDATE rejected; DELETE rejected; row survives the failed mutation;
  grants inspected from information_schema; effect cannot point at the wrong
  OrderLine / stock item / location; cross-tenant effect impossible.
MODULE BOUNDARIES: extend module-boundaries.spec.ts to prove Production's and
  Inventory's contract/ files are interface-only, their impls are outside
  contract/, sales-payment.service.ts imports them ONLY from <module>/contract,
  and KNOWN_DEVIATIONS DOES NOT GROW.

====================================================================
N–S. BUILD / VERIFY
====================================================================
  nest build; npx tsc --noEmit (only the known access-token.service.spec.ts
    baseline error may remain — ZERO new); eslint on changed files;
    npx prisma validate; git diff --check
  npm run openapi:check -> 3.1.0 and EXACTLY 134 operations
    (133 + PUT /modifiers/{modifierId}/recipe-effects). No /complete route.
  Clean FROM-ZERO scratch DB: 30 migrations applied, BOTH DATABASE_URL and
    APP_DATABASE_URL set; drop the scratch DB after; PROVE the persistent `ros`
    dev DB was never migrated (prisma migrate status with default env).
  Full unit suite + full E2E suite, green.
  NFR-PERF-006: 30-line order, realistic NESTED recipes, mixed costing methods,
    modifiers present. Instrument ONLY the expansion+depletion section.
    >=20 iterations. Report p50 AND p95. DO NOT claim NFR-PERF-006 COMPLETE
    unless p95 <= 200 ms — report the real number either way.
  DO NOT COMMIT. DO NOT PUSH.

====================================================================
NON-GOALS
====================================================================
No refunds/voids/reversals. No PaymentAttempt or integrated card. No receipt.
No fiscal document or outbox. No loyalty/CRM. No table release. No session/day
close. No X/Z reports. No comp mechanism. No Costing module. No new permission.
No RFC7807. No /v1. Do NOT fix MovementsService.post's lost update for
transfers/counts/waste (separate slice). Do NOT change valuationUnitCost. Do NOT
retire the existing sales->production KNOWN_DEVIATIONS entry. Do NOT add an
exhausted_at column or any stock_batches/stock_movements schema change.

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
  BR-INV-003 COMPLETE for the completion path only · NFR-PERF-006 PARTIAL unless measured
  §1.2 PARTIAL · UC-POS-01 PARTIAL
Update docs/reports/claude/INDEX.md.

DEFINITION OF DONE: 30 migrations from zero on a clean scratch DB; full unit +
full E2E green; concurrency tests >=3 clean runs each; FIFO carry-forward tests
green including the no-weighted-average-fallback proof; performance measured and
reported; OpenAPI 3.1.0 / 134 with zero drift; tsc clean apart from the known
baseline; report + INDEX written; nothing committed or pushed; the three
preserved user files untouched.
```
