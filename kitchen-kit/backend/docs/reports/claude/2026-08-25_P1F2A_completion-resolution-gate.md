# P1F-2A — Completion Economics, Modifier Depletion & Inventory Idempotency/Concurrency Resolution Gate

**Report type:** Architecture / design / governance-recording gate (no production code, no production migration, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → approved architecture/design records → repository evidence**. The SRS (`ROS_SRS_v1.0.pdf`) and `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (with the domain design records it indexes) remain authoritative. Nothing here creates a numbered decision.
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (unchanged — no commit)
**Branch:** `feat/production-spec`
**Working tree:** the three preserved user files (`.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts`), the prior P1F-2 gate report, plus this report, the governance register entry and the INDEX row
**Task identifier:** P1F-2A

> ## VERDICT (§Z)
> ## **IMPLEMENTATION READY**
> All three P1F-2 blockers are resolved: **B-1** and **B-2** by the user's ratified
> governance package (recorded in the register), **B-3** architecturally here. The
> feared fourth blocker — valuation-gap incompatibility with mandatory SRS COGS
> semantics — is **resolved by proof that no valuation gap is reachable**, so no
> provisional-COGS machinery is needed and BR-POS-001 stays intact.

---

## A. STARTING STATE

| Check | Result |
|---|---|
| Branch | `feat/production-spec` |
| `git rev-parse HEAD` | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` |
| `origin/feat/production-spec` | `cf04e008…` — **matches**, no divergence |
| `origin/main` | `01c0b0f3d3228af5248782a09e8dc0bc65606f9e` — untouched |
| Working tree | ` M .gitignore`, ` M docs/reports/claude/INDEX.md`, ` M src/main.ts`, `?? …P1F2_completion-architecture-gate.md`, `?? src/scripts/seed-dev-data.ts` |
| Migrations | **27** |
| OpenAPI | **3.1.0**, **133** operations |

No branch operation, no destructive git command, no commit, no push. The three preserved user files were not touched.

## B. RATIFIED GOVERNANCE AMENDMENT

Recorded in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` as the unnumbered entry **“P1F-2 Completion Economics & Depletion Resolution — 2026-08-25”**, inserted immediately before *Final Decision Matrix*, in the established **P1A / P1C / P1D / Fire Authorization Ratification** style.

- **No D-21 or later numbered decision was created**; the tally remains 17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN.
- **D-17-05 narrowly reopened** for the completion-time COGS workflow only; every other deferred item (theoretical-vs-actual, menu engineering, contribution margin, cost-variance dashboards, wider FR-CST reporting) explicitly remains deferred, and it remains **not** permission to implement the Costing bounded context.
- **D-17-07 narrowly reopened** for typed `ADD` / `REMOVE_ALL` modifier depletion only; `recipe_delta` stays uninterpreted and FR-MNU-013's wider surface stays deferred.
- **Original D-17-05 / D-17-07 text preserved verbatim** in `docs/production/PRODUCTION_SPEC_DESIGN_GATE.md` §4 — history is not rewritten.
- Also recorded: **line-scoped depletion provenance**; **non-partitioned Inventory effect registry**; **Inventory concurrency hardening as a precondition**; **Payment API + `pos.payment.capture` as the completion trigger** (Option A ratified); **negative stock never blocks Completion**.
- Explicitly **not** reopened: broader Costing, Fiscal (P1C-1 stands), CRM/Loyalty, D-2's branch-scoped RBAC defer, D-17-01…04/06/08, GAP-1, GAP-2.
- **D-16 OPEN · D-12 BLOCKED · D-3 RATIFIED IN PART · P-1** untouched. **No new permission code.**

## C. SRS COMPATIBILITY CHECK

The ratified package was checked clause-by-clause against mandatory SRS text. **One deliberate, documented deviation exists; everything else is compatible.**

| SRS | Requirement | Compatibility |
|---|---|---|
| §1.2 effect 3 | Inventory depletion, recursively expanded | **Compatible** — satisfied by the design in §H/§I |
| §1.2 effect 4 | *"Recognition of COGS at the recipe's current valuation"* | **Compatible** — posted COGS = actually-valued depletion at completion (§D) |
| §5.5.2 | *"OrderCompleted causes inventory depletion, COGS recognition, and cash posting. All four must succeed or all must fail."* | **Compatible** — one transaction, §P |
| §24.2.4 | `complete()` legal states, settlement, `OrderCompleted` payload | **Compatible** — unchanged from the prior gate |
| NFR-PERF-006 | expansion + depletion ≤200 ms p95 **inside the transaction** | **Compatible by design; must be MEASURED** (§W) |
| **FR-CST-001** | *"On order completion … valuing consumption at the item's current cost per the configured costing method"* | **Compatible** — §K values each item by its own method at completion |
| **FR-CST-002** | *"COGS SHALL be recorded on the order line as `unit_cost_snapshot` and SHALL NOT be recomputed retroactively"* | **DELIBERATE DOCUMENTED DEVIATION** — see below |
| **BR-POS-004** | sale-time snapshots never recomputed from current master data | **Compatible, and strengthened** (§G recipe-version closure pinning) |
| **BR-POS-001** | COMPLETED order SHALL NOT be modified | **Compatible** — no post-completion mutation exists because no valuation gap is reachable (§L) |
| **BR-POS-002** | no completion while underpaid | **Compatible** — unchanged settlement rule |
| **FR-POS-024** | removal modifiers reduce consumption | **Compatible** — §F `REMOVE_ALL` |
| **FR-INV-014 / UC-POS-01 13a** | negative stock recorded, never blocks the sale | **Compatible** — §K, §L |
| **FR-INV-030 / BR-INV-001** | every stock change an immutable movement, append-only | **Compatible** — unchanged |
| **BR-INV-003** | movements sum == `stock_levels` projection | **Compatible, and repaired** — §M makes `balance_after` derive from the atomic projection result |
| **FR-AUD-001** | audit every state change | **Compatible** — §P steps 17–18 |

**The single deviation — FR-CST-002.** Its two clauses cannot both be satisfied by one column once the sale-time estimate must remain immutable evidence: recording posted COGS *into* `unit_cost_snapshot` would rewrite a sale-time snapshot (violating BR-POS-004 and P1C-5 item 5), while never writing it would leave completion COGS unrecorded (violating §1.2 effect 4 / FR-CST-001). The ratified resolution keeps **both** facts in **two** fields. This is strictly more information than the SRS requires, and neither field is ever recomputed retroactively — so FR-CST-002's *substantive* prohibition is honoured while its *literal* single-field wording is not. Recorded as a deviation in the register entry, not silently glossed.

**No clause of the ratified package contradicts an unambiguous mandatory SRS requirement.**

## D. COGS FACT MODEL

**Posted per-line COGS = Option A — the exact sum of the actually-valued `stock_movements.total_cost` attributable to that OrderLine.** Chosen over any recomputed formula because it makes posted COGS *definitionally* equal to what Inventory actually valued and depleted, which is precisely SRS §1.2 effect 4 and FR-CST-001, and it is reconcilable to the ledger by construction.

**New Sales column**

```
sales.order_lines.posted_cogs_total   BIGINT NULL
```

- Minor units. `NULL` until Completion; set exactly once, at Completion.
- Equals `SUM(stock_movements.total_cost)` over the movements produced for this line (equivalently, `SUM(sale_depletion_effects.total_cost)` for the line).
- `0` is meaningful and distinct from `NULL`: an absent-recipe line (P1C-5) posts `0`; `NULL` means "not completed".

**No `posted_unit_cogs` column.** A per-unit figure is exactly `posted_cogs_total / quantity` and is therefore derivable. **CARRIED ITEM P1C-5 item 7** is directly on point — *"No persistent `cost_basis` column is created … Adding a column would duplicate derivable state."* Storing a unit figure would also re-introduce the very rounding/quantity confusion §3.1.F exists to eliminate.

**No `posted_cogs_at` column.** The posting instant is exactly `orders.completed_at`; a second timestamp duplicates derivable state.

**Order roll-up**

```
sales.orders.cogs_total = SUM(order_lines.posted_cogs_total)   -- after completion
```

Exact `bigint` addition; **no rounding at this level**.

**Units, quantity and the single rounding point**

| Layer | Type | Rule |
|---|---|---|
| `OrderLine.quantity` | `Decimal(12,3)` | number of sold portions (fractional supported, e.g. 0.5 kg) |
| per-portion component consumption | exact rational | `recipe_line.quantity × conversionFactor × (1 + wastage/100) ÷ (yield_percentage/100) ÷ yield_quantity` |
| line component consumption | `Decimal(18,6)` | per-portion × `OrderLine.quantity` |
| `stock_movements.quantity` | `Decimal(18,6)` | negative; the stock item's **base unit** |
| `stock_movements.unit_cost` | `BIGINT` | per base unit, per §K |
| `stock_movements.total_cost` | `BIGINT` | **`round_half_up(abs(quantity) × unit_cost)` — the ONE rounding point** |
| `order_lines.posted_cogs_total` | `BIGINT` | exact sum of the line's movement `total_cost` — **no rounding** |
| `orders.cogs_total` | `BIGINT` | exact sum of line totals — **no rounding** |

Exactly one rounding point, at the movement, `HALF_UP` (matching `RoundingMode.HALF_UP` already used by recipe cost). **No floating point** on the completion path: quantities are `Prisma.Decimal`, money is `bigint`, and the intermediate product is computed with the repository's exact `common/money/rational` kernel.

> **Note — existing helpers are float-based.** `costing.ts`'s `totalCost()`, `weightedAverageCost()` and the FIFO branch of `valuationUnitCost()` use JS `number` + `Math.round`. The **new** batch depletion command must use exact arithmetic and **must not** reuse those helpers, while leaving them untouched for their existing callers (transfers, counts, waste). A test must prove both agree on representative values (§V).

**Write-once enforcement.** No trigger (GAP-2 precedent forbids triggers). `posted_cogs_total` is written only by the completion path, and every Sales mutation path already refuses a finalised order via `assertOrderMutable` (`completed` is already in `FINALISED`). Proven by test, not by DDL. A `CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0)` guards sign only.

**`sales.orders` also gains** `CONSTRAINT ck_completed CHECK (state <> 'completed' OR completed_at IS NOT NULL)` — specified verbatim by SRS §25.2 and currently absent.

**In-scope micro-correction (§3.1.F).** `order-lines.service.ts:841-842` currently computes the pre-completion running estimate as `cogs += line.unitCostSnapshot`, ignoring `line.quantity`. Left alone, `orders.cogs_total` would change *magnitude* at completion for reasons unrelated to posting, making the ratified semantic switch indistinguishable from a bug. The fix is one expression — multiply by `quantity`, rounded `HALF_UP` once — plus a test. Included, explicitly scoped, nothing else in that method touched.

## E. SALE-TIME vs POSTED COST

| | `order_lines.unit_cost_snapshot` | `order_lines.posted_cogs_total` |
|---|---|---|
| Meaning | recipe cost **estimate** per **one unit** at sale time | **posted COGS total** for the whole line at completion |
| Written | line capture | completion |
| Basis | recipe expansion valued at then-current valuation | the movements Inventory actually valued and posted |
| Scale | per unit | per line (quantity-inclusive) |
| Governing source | BR-POS-004, P1C-2, P1C-5 | §1.2 effect 4, FR-CST-001, ratified §3.1 |
| Mutability | immutable, never rewritten | write-once at completion, never rewritten |
| Nullability | `NULL` ⇒ absent recipe (P1C-5) | `NULL` ⇒ order not completed |

The two legitimately differ — valuation moves between capture and completion, and the estimate is per unit. Neither is derivable from the other. **Neither field is ever overloaded with the other's meaning.**

`orders.cogs_total` is the one column whose *meaning* changes at completion (running estimate → posted total), which the user ratified explicitly (§3.1.E). This must be documented in the schema doc-comment — the prior gate found the column currently has **no** doc comment at all, which is what invited the misreading in the first place.

## F. MODIFIER EFFECT MODEL

**Production-owned master table.** Note `catalogue.modifiers` is Catalogue-owned; the *effects* are Production-owned (recipe semantics), referencing the Catalogue modifier by composite tenant-safe FK — the same cross-schema pattern `production.recipes.menu_item_variant_id → catalogue.menu_item_variants` already uses.

```
production.modifier_recipe_effects
  id                 UUID PK
  tenant_id          UUID NOT NULL
  modifier_id        UUID NOT NULL
  operation          production.ModifierEffectOperation NOT NULL   -- add | remove_all
  component_type     production.RecipeComponentType NOT NULL       -- stock_item | sub_recipe (REUSED enum)
  stock_item_id      UUID NULL
  sub_recipe_id      UUID NULL
  quantity           DECIMAL(18,6) NULL
  unit_id            UUID NULL
  sequence           SMALLINT NOT NULL
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
```

New enum `ModifierEffectOperation { add, remove_all }` (`@@schema("production")`). `RecipeComponentType` is **reused, not duplicated**.

FKs — all composite and tenant-safe (D-09 / D-17-02):
- `(tenant_id)` → `identity.tenants(id)`
- `(tenant_id, modifier_id)` → `catalogue.modifiers(tenant_id, id)` **ON DELETE CASCADE** (effects are part of the modifier's definition)
- `(tenant_id, stock_item_id)` → `inventory.stock_items(tenant_id, id)` **ON DELETE RESTRICT**
- `(tenant_id, sub_recipe_id)` → `production.recipes(tenant_id, id)` **ON DELETE RESTRICT**
- `(unit_id)` → `inventory.uom(id)` **ON DELETE RESTRICT**

CHECKs (D-17-02 XOR style):
- `ck_mre_component`: exactly one of `stock_item_id` / `sub_recipe_id`, agreeing with `component_type`
- `ck_mre_remove_all`: `operation='remove_all'` ⇒ `component_type='stock_item'` **AND** `quantity IS NULL` **AND** `unit_id IS NULL`
- `ck_mre_add`: `operation='add'` ⇒ `quantity IS NOT NULL AND quantity > 0 AND unit_id IS NOT NULL`

Keys: `@@unique([tenantId, id])`; index `[tenantId, modifierId]`.

**This builds on existing ratified structure rather than inventing:** `catalogue.ModifierKind { addition, removal, substitution }` already exists and is *already snapshotted* on the sale as `order_line_modifiers.kind_snapshot` (P1E-5). `kind` is the **classification**; `modifier_recipe_effects` supplies the **typed components**. Their relationship:

| `Modifier.kind` | Expected effects |
|---|---|
| `addition` | one or more `ADD` |
| `removal` | one or more `REMOVE_ALL` |
| `substitution` | one or more `REMOVE_ALL` **plus** one or more `ADD` |

Consistency is service-validated (not a DB constraint — `kind` is nullable for legacy rows and a cross-row CHECK is not expressible).

### Exact semantics — answers to every §6 question

- **Binding.** `modifier_id` + typed component + quantity + unit. No JSON, no DSL, no expression evaluator.
- **Tenant safety.** Composite FKs only; service validation supplements but is never the sole guarantee (D-17-02).
- **Unit conversion.** An `ADD` quantity in `unit_id` is converted to the target stock item's **`base_unit_id`** by the existing `conversionToStockBaseUnit` (item-specific factor preferred over generic; `null` ⇒ gap, never an assumed 1).
- **Can `ADD` target a sub-recipe?** **Yes** — `component_type='sub_recipe'`, expanded recursively through its own published version and yield, exactly like a `RecipeLine` sub-recipe component. Depth-10 and cycle guards are the existing ones.
- **How is `REMOVE_ALL` identified unambiguously?** It targets a **`stock_item` only**, and is applied to the line's **fully-expanded, aggregated** quantity for that stock item. Because expansion aggregates per stock item *within the line* first (§3.3), "all" is unambiguous: every occurrence, at every depth, via every path, is covered by one operation.
- **Nested / multiple occurrences.** Handled by construction — aggregation precedes removal, so a stock item appearing in the base recipe *and* inside two sub-recipes is one aggregated quantity, zeroed by one `REMOVE_ALL`. This is exactly what makes FR-POS-024 true rather than approximately true.
- **`REMOVE_ALL` of a component not present.** **No-op, not an error** ("no cheese" on a cheeseless burger is a legitimate order).
- **Combining multiple removals.** Set union of removed `stock_item_id`s; each operation is idempotent, so combination is order-independent.
- **`ADD` scaling.** `effect.quantity × order_line_modifiers.quantity × order_lines.quantity`. (`order_line_modifiers.quantity` is the existing `SMALLINT` supporting "double cheese".) Modifier `ADD` quantities are expressed **per one sold portion** and are therefore **not** divided by the base recipe's yield — they are additions to a portion, not to a batch.

### Deterministic evaluation order

```
1. expand base recipe (pinned version closure) -> per-stock-item base-unit quantities
2. aggregate per stock_item WITHIN the line
3. apply ALL REMOVE_ALL operations   (zero the aggregate for each targeted stock item)
4. apply ALL ADD operations          (expand sub-recipe ADDs, convert, scale, accumulate)
5. aggregate again per stock_item; drop non-positive results
```

**Removal strictly precedes addition** — this is what makes substitution (`REMOVE_ALL X` + `ADD X'`) correct, and what makes a same-item substitution (`REMOVE_ALL cheddar` + `ADD cheddar`) behave as a replacement rather than a self-cancellation. Within each phase the operations are commutative, so the result is order-independent and fully deterministic.

## G. MODIFIER SALE SNAPSHOT

The semantic *definition* is Production-owned; the *sale snapshot* is **Sales-owned immutable history**. Because one modifier may produce several component effects, a **normalized immutable child table** is used — not an extra column and not an opaque JSON blob.

```
sales.order_line_modifier_effects
  id                      UUID PK
  tenant_id               UUID NOT NULL
  business_day            DATE NOT NULL
  order_line_id           UUID NOT NULL
  order_line_modifier_id  UUID NOT NULL
  operation               sales.ModifierEffectOperationSnapshot NOT NULL  -- add | remove_all
  component_type          sales.RecipeComponentTypeSnapshot NOT NULL      -- stock_item | sub_recipe
  stock_item_id           UUID NULL
  sub_recipe_version_id   UUID NULL      -- PINNED version, never a logical recipe id
  quantity                DECIMAL(18,6) NULL
  unit_id                 UUID NULL
  sequence                SMALLINT NOT NULL
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
```

Snapshot enums mirror the Production enums in the `sales` schema, exactly as `kitchen.ModifierKindSnapshot` already mirrors `catalogue.ModifierKind` — established precedent for a cross-schema snapshot enum.

**Critical detail: `sub_recipe_version_id`, not `sub_recipe_id`.** A logical recipe id would be re-resolved at completion to whatever is *currently* published, so republishing a sub-recipe between sale and completion would silently change historical depletion — precisely what §3.2 forbids. Pinning the version closes that hole.

FKs: `(tenant_id)`→tenants; `(tenant_id, order_line_modifier_id)` → `sales.order_line_modifiers(tenant_id, id)` **CASCADE**; `(tenant_id, order_line_id, business_day)` → `sales.order_lines(tenant_id, id, business_day)` **CASCADE**; `(tenant_id, stock_item_id)` → `inventory.stock_items(tenant_id, id)` **RESTRICT**; `(tenant_id, sub_recipe_version_id)` → `production.recipe_versions(tenant_id, id)` **RESTRICT**; `(unit_id)` → `inventory.uom(id)` **RESTRICT**. XOR CHECK and operation CHECKs mirror §F.

> Real FKs are used deliberately — in contrast to `catalogue.modifiers.stock_item_id`, which is FK-less recorded-UUID debt the schema itself flags. Sale history must never dangle.

### Recipe-version closure pin (required companion)

The same late-binding hole exists for the **base** recipe: `order_lines.recipe_version_id` pins only the *top-level* version, while `recipe_lines.sub_recipe_id` references **logical recipe identity** and is resolved at expansion time by `status='published'` (there is no temporal resolution — D-17-08). So republishing any nested sub-recipe would change a historical line's depletion.

```
sales.order_line_recipe_versions
  id                 UUID PK
  tenant_id          UUID NOT NULL
  business_day       DATE NOT NULL
  order_line_id      UUID NOT NULL
  recipe_version_id  UUID NOT NULL
  depth              SMALLINT NOT NULL
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)
```

Captured at line capture as a by-product of the recipe-cost traversal Sales **already performs** (so it costs one extra small insert set, not an extra traversal). At completion, Production resolves every sub-recipe **only** to a version present in this closure.

> **Scope note, flagged for the user.** This table is an *extension* beyond the literal ratified package, justified by the package's own stated principle — *"later master-data edits cannot change historical depletion"* (§3.2) — and by BR-POS-004. It is small and cheap. If the user prefers to descope it, the residual risk is explicit: **a sub-recipe republished between sale and completion changes what a completed order depletes**, and BR-POS-004's guarantee holds only one level deep.

## H. PRODUCTION CONSUMPTION CONTRACT

**New public contract — `src/modules/production/contract/`** (Production's first). Follows the established `treasury/contract` pattern exactly: `Symbol` token, `tx`-first methods, `useExisting` binding, consumers import **only** from `<module>/contract`.

| Field | Value |
|---|---|
| **OWNER** | Production |
| **CONSUMER** | Sales — line capture (methods 1–2) and Completion (method 3) |
| **TOKEN** | `RECIPE_CONSUMPTION_QUERY = Symbol('RECIPE_CONSUMPTION_QUERY')` |
| **SYNC / IN-TX** | every method takes `tx: Prisma.TransactionClient` first |
| **MONEY** | **none** — Inventory owns valuation; this contract returns quantities only |

```ts
export interface RecipeConsumptionQuery {
  /** Line capture: the pinned version closure for a top-level recipe version. */
  resolveVersionClosure(
    tx: Prisma.TransactionClient,
    recipeVersionId: string,
  ): Promise<ResolvedVersionClosure>;          // { versions: { recipeVersionId, depth }[] }

  /** Line capture: the typed effects a set of modifiers currently defines. */
  resolveModifierEffects(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; modifierIds: readonly string[] },
  ): Promise<ReadonlyMap<string, readonly ResolvedModifierEffect[]>>;

  /** Completion: net line-scoped depletion quantities. */
  planConsumption(
    tx: Prisma.TransactionClient,
    input: RecipeConsumptionInput,
  ): Promise<RecipeConsumptionPlan>;
}

export interface OrderLineConsumptionRequest {
  readonly orderLineId: string;
  readonly recipeVersionId: string | null;        // NULL => absent recipe (P1C-5)
  readonly pinnedVersionIds: readonly string[];   // from order_line_recipe_versions
  readonly quantity: string;                      // decimal string, OrderLine.quantity
  readonly modifierEffects: readonly SnapshotModifierEffect[];
}

export interface OrderLineConsumptionPlan {
  readonly orderLineId: string;
  readonly components: readonly {
    readonly stockItemId: string;
    readonly quantityInBaseUnit: string;   // decimal string, positive
    readonly unitId: string;               // the stock item's base unit
    readonly provenance: 'recipe' | 'modifier_add';
  }[];
  readonly gaps: readonly ConsumptionGap[];
}
```

**Required properties (all satisfied):** input uses the **pinned** `recipe_version_id` and closure; Sales excludes voided lines before calling; **absent recipe ⇒ zero components, no error** (P1C-5, source-backed); incomplete recipe ⇒ partial components, existing governed semantics; nested sub-recipes expanded recursively; existing depth-10 and cycle guards reused (`RecipeExpansionError`); existing unit conversion reused; modifiers applied per §F's deterministic order; **duplicates aggregated WITHIN each OrderLine only** (§3.3).

**Errors:** `RecipeExpansionError` (cycle/depth — existing), `RecipeCostError` subtypes reused for conversion gaps. **A missing unit conversion is a `gap`, not a throw** — depletion must not block a paid sale (UC-POS-01 13a); the gap is reported, audited, and that component contributes zero quantity.

**Implementation note:** `planConsumption` reuses `RecipeCostService`'s existing traversal, which *already* computes `quantityInBaseUnit` per line (`recipe-cost.ts:244-248`) and currently discards it into money. A quantity-returning sibling shares the traversal rather than duplicating recipe semantics. Crucially, quantity expansion has **no valuation dependency**, so unlike cost expansion it cannot fail for a missing valuation.

## I. INVENTORY EFFECT REGISTRY

**New Inventory-owned, NON-PARTITIONED table** — the business idempotency and provenance boundary (ratified §3.4).

```
inventory.sale_depletion_effects
  id                     UUID PK
  tenant_id              UUID NOT NULL
  order_id               UUID NOT NULL
  business_day           DATE NOT NULL
  order_line_id          UUID NOT NULL
  stock_item_id          UUID NOT NULL
  location_id            UUID NOT NULL
  quantity_in_base_unit  DECIMAL(18,6) NOT NULL      -- positive magnitude depleted
  unit_id                UUID NOT NULL
  unit_cost              BIGINT NOT NULL
  total_cost             BIGINT NOT NULL
  movement_id            UUID NOT NULL
  movement_occurred_at   TIMESTAMPTZ NOT NULL
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()

  CONSTRAINT uq_sale_depletion_effect
    UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)
```

### Key decision and rationale

**Business identity = `(tenant_id, order_line_id, stock_item_id, location_id)`.**

- `tenant_id` — tenant safety, aligns with RLS.
- `order_line_id` — line-scoped provenance, ratified §3.3.
- `stock_item_id` — one net effect per item per line; duplicate recipe paths already aggregated inside the line.
- `location_id` — **included.** A completed order resolves exactly one branch location today, so it adds no ambiguity; but it costs nothing, prevents a same-item-different-location collision from being silently merged, and keeps the key structurally correct if central-kitchen or multi-location fulfilment is ever introduced. This is structural protection, not an invented dimension.
- **`occurred_at` is deliberately absent** — the ratified rule (§3.4) that partition mechanics must not leak into business identity. This table is non-partitioned precisely so the key can be honest.
- `order_id` / `business_day` are **columns, not key members** — carried so the composite FK can prove the line belongs to that order and business day.

### FKs (all composite, tenant-safe)

- `(tenant_id)` → `identity.tenants(id)`
- `(tenant_id, order_id, order_line_id, business_day)` → `sales.order_lines(tenant_id, order_id, id, business_day)` — the existing `uq_order_lines_tenant_order_id_business_day` target. **ON DELETE RESTRICT.** *This is what makes "an effect row cannot point to the wrong OrderLine" structurally true rather than service-validated.*
- `(tenant_id, stock_item_id)` → `inventory.stock_items(tenant_id, id)` RESTRICT
- `(tenant_id, location_id)` → `org.locations(tenant_id, id)` RESTRICT
- `(tenant_id, movement_id, movement_occurred_at)` → `inventory.stock_movements(tenant_id, id, occurred_at)` RESTRICT — uses the existing `@@unique([tenantId, id, occurredAt])`; **both** columns are required because the ledger's uniqueness is partition-aware.
- `(unit_id)` → `inventory.uom(id)` RESTRICT

> **Boundary note.** An Inventory table with an FK into Sales is a cross-context reference. It is consistent with established practice in this repository — Kitchen already FKs into Sales (`ticket_lines → order_lines`, `ticket_line_modifiers → order_line_modifiers`) — and D-17-02 requires real composite FKs to tenant-scoped targets rather than service validation alone. The polymorphic `reference_type`/`reference_id` on `stock_movements` is left exactly as the SRS defines it (§J).

### Append-only, RLS, privileges

```sql
GRANT SELECT, INSERT ON inventory.sale_depletion_effects TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON inventory.sale_depletion_effects FROM ros_app;
ALTER TABLE inventory.sale_depletion_effects ENABLE  ROW LEVEL SECURITY;
ALTER TABLE inventory.sale_depletion_effects FORCE   ROW LEVEL SECURITY;
CREATE POLICY sale_depletion_effects_select ON inventory.sale_depletion_effects FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY sale_depletion_effects_insert ON inventory.sale_depletion_effects FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- no UPDATE and no DELETE policy, by design
```

Same shape as `order_payments`, `stock_movements` and `audit_entries`. **Non-partitioned, so no per-partition RLS obligation** — a deliberate advantage over putting the identity on the ledger.

### Insert pattern and conflict semantics

P1E-5A conflict-safe pattern, never `INSERT`-catch-`P2002`-then-query:

```sql
INSERT INTO inventory.sale_depletion_effects (...) VALUES (...)
ON CONFLICT (tenant_id, order_line_id, stock_item_id, location_id) DO NOTHING
RETURNING id, quantity_in_base_unit, unit_cost, total_cost, movement_id;
```

`0` rows returned ⇒ the business effect already exists ⇒ **raise a conflict and roll the whole transaction back** (which also removes the movement inserted moments earlier, leaving no orphan).

**Why rolling back is correct rather than idempotently continuing:** a genuine client retry never reaches this code. The permanent Payment-id replay check short-circuits at step 1 of the transaction (§P), and a second *distinct* completion of the same order is impossible because `completed` is terminal and the Order CAS guards the version. The registry conflict is therefore **defence-in-depth for an invariant violation**, not a hot path — so failing closed is right, and "duplicate identical completion does not touch the stock projection again" is guaranteed one layer earlier, by the replay short-circuit.

## J. STOCK MOVEMENT PROVENANCE

**Exactly 1 effect row = 1 `stock_movements` row**, for each `(OrderLine, StockItem, Location)`.

Why: duplicate recipe/sub-recipe paths are netted *before* Inventory (§3.3), so one movement per line-item is the natural granularity; it preserves line-level ledger traceability for refunds/reversals; it keeps `1:1` reconciliation between registry and ledger trivially provable; and it bounds movement count at `distinct(line × item)` rather than at recipe-path count.

**`reference_type` / `reference_id` semantics are NOT changed:**
- `reference_type = 'order'` — exactly the value SRS §7.4.3 enumerates.
- `reference_id = order_id` — **the Order id, unchanged.** SRS §7.4.3's reference is document-level; re-pointing it at `order_line_id` would silently alter an existing convention shared with transfers/counts/waste, for no gain. **The effect registry supplies the finer OrderLine provenance**, which is exactly why it exists.
- `movement_type = 'sale_depletion'` — the existing enum value, whose documented trigger is already *"Order completed"*.
- `quantity` negative; `batch_id` set only when exactly one batch was consumed (existing convention preserved).

## K. VALUATION BY COSTING METHOD

Inventory owns valuation (ratified §3.1.G). Production never values. Sales never queries Inventory internals — it receives valued effects through the Inventory contract.

**Valuation instant:** immediately **before** the depletion writes for that item, inside the same transaction, under the FIFO lock where applicable. Reading before depletion matters for FIFO (layers are consumed by the write); it is immaterial for weighted-average and standard.

| Method | Data read | Locks | `unit_cost` | Negative stock |
|---|---|---|---|---|
| **`weighted_average`** | `stock_levels.average_cost` for `(item, location)` | none (atomic `+=` only) | the prevailing average | permitted; `average_cost` **unchanged** by outbound (existing governed behaviour, preserved) |
| **`fifo`** | `stock_batches` for `(tenant, item, location)` with `quantity_remaining > 0` | `SELECT … ORDER BY created_at, id FOR UPDATE` | value-weighted mean of the layers actually consumed | permitted; see §10.1 below |
| **`standard`** | `stock_items.standard_cost` | none | the fixed standard cost; **no fallback to any other method** | permitted; cost unaffected |

`total_cost = round_half_up(abs(quantity) × unit_cost)`, exact arithmetic (§D).
`stock_levels.average_cost` is **not** modified by sale depletion — preserving `weightedAverageCost`'s existing rule that only inbound movements move the average.
Line posted COGS = exact sum of the line's `total_cost` (§D).

### 10.1 FIFO when quantity exceeds available layers

Two distinct sub-cases, and they are **not** the same:

1. **Partial coverage** (some layers exist). Layers are consumed oldest-first; the **unbacked remainder is valued at the same value-weighted mean of the layers actually consumed**. This is FIFO-*derived* — it is the cost of the stock this depletion actually drew on — and is **not** a cross-method fallback and **not** "latest purchase cost standing in for FIFO". It is deterministic and is exactly what the existing `valuationUnitCost` already does, because `totalCost()` multiplies the FIFO mean by the **full** quantity.
2. **Zero layers.** The existing `valuationUnitCost` falls back to `input.averageCost`.

**Sub-case 2 is a genuine residual concern and is reported, not silently adopted.** It is a cross-method fallback, in tension with **P1C-2 binding constraint 1** (*"no fallback from one method to another"*). Three facts bound the risk:
- P1C-2's binding constraints textually govern the **recipe-cost** computation (Production's sale-time snapshot). Production's own `StockValuationService` correctly returns `null` for FIFO-with-no-layers and never falls back — that constraint is honoured where it was written to apply.
- `valuationUnitCost` is **Inventory's own** movement valuation, pre-existing, and §3.1.G ratifies Inventory as the owner of `movement.unit_cost`.
- The path is hard to reach: P1C-5 already **refuses the sale at line capture** if a complete recipe has an unpriceable component, so at least one layer existed at capture; reaching sub-case 2 requires all layers to be exhausted between capture and completion.

**Recommendation (not a blocker, not adopted here):** a future narrow decision should state explicitly whether FIFO-with-no-layers may use `average_cost`. P1F-2 must **not** change this behaviour unilaterally — doing so would alter Inventory valuation for transfers, counts and waste as well.

## L. VALUATION GAP SEMANTICS

**Finding: no valuation gap is reachable at Completion. The provisional/adjustment mechanism contemplated by §11 is therefore NOT required and is NOT designed.**

Proof:

1. **`stock_movements.unit_cost` and `total_cost` are `BIGINT NOT NULL`.** A movement cannot exist without a cost.
2. **`valuationUnitCost` is a total function** (`src/modules/inventory/costing.ts`): every branch of the `CostingMethod` switch returns a `bigint`. `weighted_average` → `averageCost`; `standard` → `standardCost ?? 0n`; `fifo` → weighted mean of consumed layers, or `averageCost` when none were consumed.
3. **`standard` can never be null**: `CONSTRAINT ck_standard_cost_present CHECK (costing_method <> 'standard' OR standard_cost IS NOT NULL)`.
4. **Posted COGS is defined as the sum of actually-valued movement totals** (§D). Since every movement is valued, every posted line COGS is fully determined at Completion.

**Consequences — all favourable:**

- **§1.2 effect 4 and FR-CST-001 are satisfied at completion**, with no deferred remainder.
- **BR-POS-001 is preserved intact** — nothing ever mutates a COMPLETED order, because there is nothing left to resolve.
- **FR-CST-002's no-retroactive-recomputation clause is preserved** — no adjustment mechanism exists to violate it.
- **No adjustment table, no provisional status column, no append-only cost-adjustment ledger is created** — which also honours the instruction not to build a generic accounting system.
- **A COMPLETED Order may never carry an outstanding valuation gap.** That is the invariant.

**Invariant preventing silent missing COGS:** at Completion, for every non-voided line, `posted_cogs_total IS NOT NULL`, and `orders.cogs_total = SUM(order_lines.posted_cogs_total)`. Both are asserted by test. A line with an absent recipe posts `0` (a truthful zero under P1C-5, semantically distinct from `NULL`).

**Distinguish clearly:** a *quantity* gap (missing unit conversion, incomplete recipe) is real and is reported as a `ConsumptionGap` — that component simply contributes no depletion, the sale completes, and the gap is recorded in the completion audit entry. That is a **depletion-completeness** matter, governed by BR-MNU-012/P1C-5 and UC-POS-01 13a — **not** a valuation gap, and it never leaves COGS unresolved for the quantities that *were* depleted.

## M. STOCK_LEVELS CONCURRENCY

**Current defect (confirmed):** `MovementsService.post` reads the level (`:111-119`), computes `balanceAfter = currentQty + input.quantity` in JS (`:161`), then `upsert`s an absolute value (`:192-214`). No row lock, no `decrement`, no version. Two concurrent depletions of the same `(item, location)` under READ COMMITTED **lose an update**. Ratified §3.5 forbids shipping Completion on this.

**Replacement, for the new Sale Depletion command only:**

```sql
INSERT INTO inventory.stock_levels
  (tenant_id, stock_item_id, location_id, quantity_on_hand,
   average_cost, last_movement_id, last_movement_occurred_at)
VALUES ($1, $2, $3, $4::numeric, $5, $6, $7)
ON CONFLICT (stock_item_id, location_id) DO UPDATE
   SET quantity_on_hand          = inventory.stock_levels.quantity_on_hand
                                 + EXCLUDED.quantity_on_hand,
       last_movement_id          = EXCLUDED.last_movement_id,
       last_movement_occurred_at = EXCLUDED.last_movement_occurred_at
RETURNING quantity_on_hand;
```

- The conflict target is the existing PK `(stock_item_id, location_id)`.
- `EXCLUDED.quantity_on_hand` carries the **signed delta** (negative for depletion); on first insert the delta *is* the balance, which is correct for a level that did not previously exist.
- **`average_cost` is deliberately NOT updated** — outbound sale movements never move the average, exactly as today.
- `ON CONFLICT DO UPDATE` takes a row lock for the duration of the statement, so concurrent `+=` operations serialize correctly at the row level with no lost update and no application-level retry.

**`balance_after` becomes truthful.** The projection is updated **first**, and the `RETURNING quantity_on_hand` value is written into `stock_movements.balance_after`. This inverts the current order (movement first, then projection) and is a genuine repair: `balance_after` now provably equals the projection, strengthening **BR-INV-003** instead of racing it.

**Multiple effects on the same `(item, location)` within one sale — chosen: option A, applied individually in deterministic order.** Each application is its own atomic `+=` and its own movement, so they compose correctly and every movement carries a truthful running `balance_after`. Aggregating the projection delta (option B) would save at most a few writes while making per-movement `balance_after` unattributable — a poor trade against BR-INV-003 reconcilability and line-level traceability. Write count is bounded by `distinct(line × item)`, which for a 30-line order is small.

**Deterministic ordering** (also the deadlock-avoidance ordering, §N): sort all effects by `(stock_item_id, location_id, order_line_id)` ascending and apply in that order. **Never** JS object/`Map` iteration order.

**Scope discipline:** the existing `MovementsService.post` is **not** rewritten by P1F-2 — transfers, counts and waste keep their current path. The new atomic behaviour lives in the new batch command. This is called out honestly: the lost-update defect persists for those callers and warrants a separate narrow fix (§Y).

## N. FIFO CONCURRENCY

For each `(stock_item_id, location_id)` whose item is FIFO **and** batch-tracked:

```sql
SELECT id, quantity_remaining, unit_cost, created_at, expiry_date
FROM inventory.stock_batches
WHERE tenant_id = $1 AND stock_item_id = $2 AND location_id = $3
  AND quantity_remaining > 0
ORDER BY created_at ASC, id ASC
FOR UPDATE;
```

- **`ORDER BY created_at, id`** — receipt order, with `id` as the deterministic tie-break (`created_at` is not unique and has no index guaranteeing order). For FEFO items the existing strategy ordering (`expiry_date` then receipt order) is preserved.
- **`FOR UPDATE`, never `SKIP LOCKED`** — skipping a locked older layer would consume a *newer* layer and change FIFO truth, which ratified §3.5 forbids explicitly.
- **Locks are scoped to the affected `(item, location)` rows only** — no table lock, no global inventory lock.
- Batch decrements remain `{ decrement: … }` (already atomic) but now execute under the lock.
- `stock_batches` has `@@index([tenantId, stockItemId, locationId])`, so the locking read is index-supported.

**Global lock ordering across a multi-line completion:** the distinct `(stock_item_id, location_id)` pairs are sorted **ascending by `stock_item_id`, then `location_id`** and locked in that order — the same ordering used for projection writes (§M). Two concurrent completions touching an overlapping set of items therefore acquire locks in the same sequence and cannot deadlock by lock-order inversion.

**Two concurrent completions consuming the same FIFO item:** the second blocks on `FOR UPDATE` until the first commits, then its read returns the **updated** `quantity_remaining`. Therefore:
- **correct movement costs** — each values only the layers it actually consumed;
- **correct batch balances** — no double consumption, because the decrement happens under the lock;
- **correct stock level** — the atomic `+=` (§M) is independently safe;
- **no lost update** — neither the level nor any batch is written from a stale read.

Items that are **not** FIFO-and-batch-tracked take **no row lock at all** — only the atomic `+=`. Locks are taken exactly where FIFO truth requires them and nowhere else.

## O. RECIPE-COST RECOMPUTATION / PERFORMANCE

**Problem:** `MovementsService.post` calls `recipeCost.recomputeForStockItem(tx, stockItemId)` on **every** movement (`:251`), each of which cascades **upward** through dependent sub-recipes and parents. A 30-line completion could trigger dozens of cascades inside the transaction — a direct threat to NFR-PERF-006 and a source of write amplification and lock contention on `recipe_versions`.

**Design — recompute at most once per distinct affected item, and only where valuation actually changed:**

| Method | Does an outbound sale movement change the item's valuation? | Recompute? |
|---|---|---|
| `weighted_average` | **No** — `nextAvg = currentAvg` for outbound; `average_cost` is untouched | **Skip** |
| `standard` | **No** — `standard_cost` is master data, unaffected | **Skip** |
| `fifo` | **Yes** — consuming layers can change the oldest remaining layer, hence the item's FIFO valuation | **Recompute once** |

This is a principled reduction, justified line-by-line from the code, not a shortcut: for the common weighted-average tenant it eliminates the cascade entirely.

**New contract method** on the existing `RECIPE_COST_RECOMPUTER` port (extended, not replaced):

```ts
recomputeForStockItems(
  tx: Prisma.TransactionClient,
  stockItemIds: readonly string[],
): Promise<string[]>;   // affected recipeVersionIds
```

Called **once**, after all movements are written, with the de-duplicated set of **FIFO** stock items touched. The existing single-item method is unchanged for its existing callers. Internally it de-duplicates the upward cascade so a shared parent recipe is recomputed once, not once per child.

**Legitimate invalidation is not removed** — it is deferred to the end of the batch and de-duplicated, which is strictly more correct (a single recompute over the final state, rather than N recomputes over intermediate states).

**NFR-PERF-006 must be MEASURED, not asserted** (§W). It is classified **PARTIAL / unproven** until a benchmark exists.

## P. COMPLETION TRANSACTION

**One `UnitOfWork` transaction.** `SalesPaymentService` must be migrated from plain `prisma.withAuthContext` to `unitOfWork.execute(...)` so it can publish `order.completed` (it currently has no `ctx.publishEvent`). `SalesFireService` is the exact precedent. Nesting is structurally impossible — `withAuthContext` is a single `$transaction` and its own contract forbids nesting.

| # | Step | Owner | R/W | Contract | Fails? |
|---|---|---|---|---|---|
| 0 | HTTP idempotency interceptor (resource-scoped fingerprint) | Platform | R/W | — | 409 |
| — | **BEGIN — `unitOfWork.execute({userId, tenantId}, ctx => …)`, RLS context set** | | | | |
| 1 | **Permanent Payment-id replay / conflict check — MUST be first** | Sales | R | — | 409 / replay |
| 2 | Load Order + non-voided lines + modifier-effect snapshots + version closures | Sales | R | — | 404 |
| 3 | `assertMayCapturePayment(state)` — `open` \| `partially_paid` | Sales | R | — | 422 |
| 4 | `assertVersion(order.version, expectedVersion)` | Sales | R | — | 409 |
| 5 | CashSession facts (branch/employee/terminal/currency/open) | Treasury | R | `CASH_SESSION_FACTS_QUERY` | 404/422 |
| 6 | Pinned payment policy (currency, cash rounding, mode) | Localisation | R | `PINNED_PAYMENT_POLICY_QUERY` | 422 |
| 7 | Tender computation — rounding, change, or card metadata | Sales | — | — | 400/422 |
| 8 | **Settlement decision** `paidTotal + amount >= grandTotal − compTotal` | Sales | — | — | — |
| 9 | Insert immutable Payment (`ON CONFLICT DO NOTHING RETURNING …`) | Sales | W | — | 409 |
| **— PARTIAL branch —** | | | | | |
| 10a | Order CAS: `paid_total`, `rounding_adjustment`, `state='partially_paid'`, `version+1` | Sales | W | — | 409 |
| **— SETTLING branch —** | | | | | |
| 10b | Plan consumption for all non-voided lines | Production | R | `RECIPE_CONSUMPTION_QUERY` | 422 |
| 11b | **Valued sale depletion** (resolve branch location; sort effects; FIFO locks; atomic `+=`; movement; effect registry) | Inventory | W | `SALE_DEPLETION_COMMAND` | 409/422 |
| 12b | Recompute recipe cost once for distinct FIFO items touched | Production | W | `RECIPE_COST_RECOMPUTER` | — |
| 13b | Write `order_lines.posted_cogs_total` per line from the valued effects | Sales | W | — | — |
| 14b | Order CAS: `paid_total`, `rounding_adjustment`, `state='completed'`, `completed_at`, `closed_by`, `cogs_total`, `version+1` | Sales | W | — | 409 |
| **— both branches —** | | | | | |
| 15 | Audit `PAYMENT_CAPTURED` (entity `order_payment`) | Governance | W | `AuditService.record(tx, …)` | — |
| 16 | *(settling only)* Audit `ORDER_COMPLETED` (entity `order`, with `before`, gap list, movement ids, posted COGS) | Governance | W | `AuditService.record(tx, …)` | — |
| 17 | *(settling only)* `ctx.publishEvent(order.completed)` | Sales | — | `sales/contract` | — |
| 18 | `dispatcher.drain(ctx)` — synchronous handlers on the same `tx` | Platform | W | — | rollback |
| 19 | Re-read Order; build response | Sales | R | — | — |
| — | **COMMIT** | | | | |
| 20 | Response + `ETag` + idempotency record | Platform | W | — | — |

**Ordering guarantees demanded by the task, and where they are met:**
- *"Do not write OrderLine posted COGS before Inventory depletion succeeds"* — step 13b strictly follows 11b, and derives entirely from 11b's returned valued effects.
- *"Do not complete Order before mandatory Inventory/COGS writes succeed"* — the Order CAS (14b) is the **last** mutation, after depletion and COGS.
- *"Do not leave a Payment committed if downstream completion fails"* — the Payment insert (9) is in the same transaction; any failure in 10b–18 rolls it back.
- *No nested transaction* — one `withAuthContext`, structurally enforced.
- *No mandatory same-DB consequence in an outbox* — none used; no outbox exists.
- *No cross-module private query* — every cross-boundary step goes through a `contract/` token.

**Inventory contract (new, `src/modules/inventory/contract/`):**

```ts
export const SALE_DEPLETION_COMMAND = Symbol('SALE_DEPLETION_COMMAND');

export interface SaleDepletionCommand {
  depleteForCompletedSale(
    tx: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly actorId: string;
      readonly branchId: string;          // Inventory resolves the branch location itself
      readonly orderId: string;
      readonly businessDay: Date;
      readonly occurredAt: Date;          // the single completion instant
      readonly lines: readonly {
        readonly orderLineId: string;
        readonly components: readonly {
          readonly stockItemId: string;
          readonly quantityInBaseUnit: string;
        }[];
      }[];
    },
  ): Promise<SaleDepletionResult>;        // per line: { orderLineId, postedCogsTotal, effects[] }
}
```

Inventory resolves the branch's location itself via `org.locations (tenant_id, location_type='branch', ref_id=branchId)` — the existing unique key. This avoids a new Organisation contract and keeps location knowledge where the FKs already point (`MovementsService` already reads `tx.location`).

## Q. ORDER.COMPLETED EVENT

Required (SRS §5.5.4 catalogue; §24.2.4 records it; §5.5.2 names it the atomicity mechanism). Payload follows §24.2.4 **exactly** — no convenience fields added:

`orderId`, `branchId`, `businessDay` (`YYYY-MM-DD` string), `lines` (each line's consumption spec), `totals`, `payments` (each payment's summary), `completedAt` (ISO-8601), `customerId` (always `null` today).

Contract additions to `src/modules/sales/contract/events.ts`, following existing conventions: `ORDER_COMPLETED_EVENT_TYPE = 'order.completed'`, `ORDER_COMPLETED_EVENT_VERSION = 1`, money as decimal strings of minor units, `idempotencyKey` derived from the completion's own identity (`complete:${orderId}:${paymentId}`), never from the HTTP header.

**Subscribers in P1F-2: NONE.** Inventory depletion and COGS are performed **synchronously via contracts before publication** (steps 11b–13b), precisely so that **Inventory correctness never depends on an asynchronous post-commit consumer**. The event is published for contract fidelity and future consumers.

This is a deliberate, documented divergence from §5.5.2's literal *subscriber* framing: the SRS's requirement is **atomicity**, which the synchronous shape satisfies at least as strongly (a handler failure and a contract failure both roll the transaction back identically), while giving Sales precise domain errors rather than opaque handler failures. Future subscribers — Analytics, Fiscal, Customer — may attach without changing this design. **No Kitchen subscriber** (Kitchen is not in §5.5.4's subscriber list, and instructions were produced at Fire).

## R. MIGRATION PLAN

Baseline **27**. Module-owned, **never combined across modules**. Result: **30**.

### Migration 28 — SALES

| Item | Detail |
|---|---|
| **MODULE** | Sales |
| **ORDER** | first (independent) |
| **WHY** | posted-COGS projection (ratified §3.1.D), SRS §25.2's missing `ck_completed`, and the sale-time modifier/recipe snapshots (ratified §3.2, BR-POS-004) |

1. `ALTER TABLE sales.orders ADD CONSTRAINT ck_completed CHECK (state <> 'completed' OR completed_at IS NOT NULL);` — SRS §25.2 verbatim. Safe: no `completed` row exists.
2. `ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;` + `CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0)`. Nullable ⇒ **zero-downtime**, no backfill, no rewrite.
3. `CREATE TYPE sales.ModifierEffectOperationSnapshot AS ENUM ('add','remove_all');`
   `CREATE TYPE sales.RecipeComponentTypeSnapshot AS ENUM ('stock_item','sub_recipe');`
4. `CREATE TABLE sales.order_line_modifier_effects` (§G) — FKs as listed; **tenant-safe** composite FKs throughout; RLS ENABLE+FORCE, all four policies; `GRANT SELECT, INSERT, UPDATE, DELETE TO ros_app` (matching `order_line_station_overrides`, since rows are written with their line and cascade with it). **Immutability** is behavioural (written once at capture, never updated).
5. `CREATE TABLE sales.order_line_recipe_versions` (§G) — same treatment; `UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)`.

Both new tables are **NOT partitioned** — leaves reached only through their order line, carrying `business_day` solely to compose the partition-aware FK, exactly as `order_line_station_overrides` and `order_payments` already do.

### Migration 29 — PRODUCTION

| Item | Detail |
|---|---|
| **MODULE** | Production |
| **ORDER** | second |
| **WHY** | typed modifier recipe effects (ratified §3.2) |

1. `CREATE TYPE production.ModifierEffectOperation AS ENUM ('add','remove_all');`
2. `CREATE TABLE production.modifier_recipe_effects` (§F) — composite tenant-safe FKs to `catalogue.modifiers`, `inventory.stock_items`, `production.recipes`, `inventory.uom`; XOR + operation CHECKs; RLS ENABLE+FORCE with all four policies (tenant-scoped master data); `GRANT SELECT, INSERT, UPDATE, DELETE TO ros_app` (editable master data, like other Production config).
3. **`catalogue.modifiers.recipe_delta` is left exactly as-is** — still opaque, still uninterpreted. Nothing is migrated out of it; D-17-07's remaining clauses stand.

### Migration 30 — INVENTORY

| Item | Detail |
|---|---|
| **MODULE** | Inventory |
| **ORDER** | third (FKs reference `sales.order_lines`, present since migration 20260820120000) |
| **WHY** | resolves B-3 — the business idempotency/provenance boundary (ratified §3.4) |

1. `CREATE TABLE inventory.sale_depletion_effects` (§I) — **non-partitioned**; `UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)`; composite FKs incl. the partition-aware `(tenant_id, movement_id, movement_occurred_at) → inventory.stock_movements(tenant_id, id, occurred_at)`.
2. **RLS** ENABLE + FORCE; **SELECT and INSERT policies only** — no UPDATE, no DELETE policy.
3. **Privileges:** `GRANT SELECT, INSERT`; `REVOKE UPDATE, DELETE, TRUNCATE`. Append-only.
4. **No change to `inventory.stock_movements`** — no new column, no new constraint, no partition work. The partition horizon (2027-09, no DEFAULT partition) and the per-partition RLS obligation are untouched by this slice and remain the pre-existing operational risk recorded in §Y.

**No migration edits any earlier committed migration.** No cross-module table is altered from another module's migration.

## S. MODULE BOUNDARIES

New public contracts, each following the `treasury/contract` pattern (Symbol token, `tx`-first, `useExisting`, consumer imports only from `<module>/contract`):

- **`src/modules/production/contract/`** — `RECIPE_CONSUMPTION_QUERY` (§H); the existing `RECIPE_COST_RECOMPUTER` port gains `recomputeForStockItems` (§O).
- **`src/modules/inventory/contract/`** — `SALE_DEPLETION_COMMAND` (§P).
- **`src/modules/sales/contract/events.ts`** — `order.completed` (§Q).

`module-boundaries.spec.ts` must be extended to prove mechanically:
1. Production's and Inventory's `contract/` files are interface-only (`containsPersistenceImplementation === false`).
2. Their concrete implementations live outside `contract/` and are concrete (`=== true`).
3. `sales-payment.service.ts` imports Production and Inventory **only** from `<module>/contract`.
4. **`KNOWN_DEVIATIONS` does not grow** — in particular no `sales->inventory` entry appears, and `sales->production` does not gain entries.

**Pre-existing debt, unchanged:** `'sales->production': ['costing/recipe-cost','costing/recipe-cost.service']` (line capture imports the concrete `RecipeCostService`). Introducing `production/contract/` makes retiring this possible, but that is a **separate** decision; P1F-2 must not *add* to the list and need not shrink it.

## T. FAILURE MATRIX

All rows inside the single transaction unless noted. "Retry safe" = a retry with the same permanent Payment id and `Idempotency-Key` is correct and non-duplicating.

| Failure stage | HTTP / error | Payment? | COMPLETED? | Inventory? | COGS? | Audit? | Retry safe |
|---|---|---|---|---|---|---|---|
| Payment validation (amount ≤ 0, missing tender field) | 400 | No | No | No | No | No | Yes |
| CashSession closed between read and write | 422 `INVALID_CASH_SESSION` | No | No | No | No | No | Yes |
| Stale `If-Match` | 409 | No | No | No | No | No | Yes (reload) |
| Duplicate Payment id, identical facts | 201 replay | pre-existing | unchanged | none new | none new | none new | Yes |
| Duplicate Payment id, different facts | 409 | No | No | No | No | No | No — client defect, fail closed |
| Insufficient cash tendered | 422 | No | No | No | No | No | Yes |
| **Production expansion** (cycle/depth) | 422 | **No** | No | No | No | No | Yes |
| **Modifier consumption resolution** failure | 422 | **No** | No | No | No | No | Yes |
| **Effect-registry conflict** (invariant violation) | 409 | **No** | No | **No** | No | No | Yes |
| **Stock movement** insert failure | 500/409 | **No** | No | **No** | No | No | Yes |
| **FIFO batch update** failure (e.g. `ck_batch_qty_nonneg`) | 500 | **No** | No | **No** | No | No | Yes |
| **Stock level projection** failure | 500 | **No** | No | **No** | No | No | Yes |
| **COGS projection** write failure | 500 | **No** | No | **No** | **No** | No | Yes |
| **Order CAS** loses the race | 409 | **No** | No | **No** | No | No | Yes |
| **Audit** failure | 500 | No | No | No | No | No | Yes — audit is transactional (FR-AUD-001) |
| **`order.completed` handler** failure | propagates | No | No | No | No | No | Yes — §5.5.2 |
| Deadlock / serialization conflict | 500 (or 409) | No | No | No | No | No | Yes |
| **Negative stock** | **not an error** | Yes | Yes | Yes (goes negative) | Yes | Yes | n/a — UC-POS-01 13a |
| **Absent recipe** (`recipe_version_id IS NULL`) | **not an error** | Yes | Yes | none for that line | `0` | Yes | n/a — P1C-5 |
| **Incomplete recipe / conversion gap** | **not an error** | Yes | Yes | partial | partial | Yes (gaps recorded) | n/a — BR-MNU-012 |

**Every mandatory-stage failure yields: no final Payment, no completion, no partial depletion, no partial COGS, no audit residue** — because all of it is one transaction. The only writes outside it are the pre-transaction idempotency reservation and the post-commit response record, both by design.

## U. IDEMPOTENCY

Three independent layers, in the order they engage:

1. **HTTP `Idempotency-Key`** (FR-API-020/022/023) — the P1E-6A-corrected resource-scoped interceptor. Replay ⇒ stored response + `Idempotent-Replay: true`; different fingerprint ⇒ **409**. Unchanged.
2. **Permanent client-generated Payment id** (FR-OFF-015) — step 1 of the transaction, **before any read or write of completion state**. Identical facts ⇒ replay the stored `{order, payment}`; any differing immutable fact ⇒ **409** fail-closed. This is what makes an exact retry after a *successful completion* produce no second Payment, no second depletion, no second COGS, no second audit, no second transition, and no version churn.
3. **Effect registry unique key** (§I) — `(tenant_id, order_line_id, stock_item_id, location_id)`, enforced by PostgreSQL. Defence-in-depth for the invariant "one net depletion per line-item", not the hot retry path.

**No separate permanent completion-operation id is introduced.** `(Order id, terminal `completed` state, final Payment id)` is sufficient: completion is a deterministic function of the settling Payment, `completed` is terminal in the state machine, and the Order CAS makes a second completion unreachable. Adding another identity would serve no consumer — consistent with the repository's discipline of not duplicating derivable state.

## V. CONCURRENCY TEST DESIGN

All against **real PostgreSQL**, using a real barrier (`makeBarrier(n)` — releases only when all parties arrive). **No sleeps as a correctness proof.** Barriers are injected through **existing DI seams**, never a new production hook.

1. **Two settling Payments, same Order, same expected version.** Seam: `CASH_SESSION_FACTS_QUERY` (called after the order read/version compute, before the settlement gate and CAS) — the proven P1F-1 seam. Assert: exactly one `201` with `state='completed'`; exactly one `409`; exactly **one** Payment row; exactly one set of `sale_depletion_effects`; one movement per line-item; `stock_levels.quantity_on_hand` decremented **exactly once**; exactly one `ORDER_COMPLETED` audit entry.
2. **Two different Orders consuming the same weighted-average stock item.** Seam: `SALE_DEPLETION_COMMAND` (barrier between valuation and the atomic `+=`). Assert **BR-INV-003**: `SUM(stock_movements.quantity)` for `(item, location)` equals `stock_levels.quantity_on_hand`; both orders complete; both post COGS at the same unchanged average.
3. **Two different Orders consuming the same FIFO item.** Same seam. Assert: deterministic layer consumption (the blocked transaction consumes the *next* layers, never the same ones); `SUM(quantity_remaining)` decreased by exactly the total consumed; each order's `unit_cost` reflects the layers **it** consumed; ledger sum equals projection; no double consumption.
4. **Deadlock-avoidance:** two completions whose line sets touch the same two stock items in opposite input order. Assert both succeed (the sorted lock order prevents inversion), with no deadlock error.

Each concurrency test runs **≥3 times** clean, matching the P1E-5A / P1E-6A / P1F-1 precedent.

## W. PERFORMANCE TEST DESIGN

**NFR-PERF-006** — recipe expansion + inventory depletion for a completed order of up to **30 lines**, **≤200 ms p95**, **inside the transaction**.

- Fixture: 30 order lines over realistic **nested** recipes (sub-recipes at depth ≥2), a mix of costing methods, some lines carrying `ADD` and `REMOVE_ALL` modifiers.
- Instrument **only the expansion + depletion section** (steps 10b–13b), not HTTP or fixture setup.
- Run ≥20 iterations against a clean scratch DB; report **p50 and p95** explicitly in the implementation report.
- **NFR-PERF-006 may NOT be classified COMPLETE without a measured number in the report.** If p95 exceeds 200 ms, report it honestly as **PARTIAL** with the measurement — do not tune the test to pass.
- Also record the count of recipe-cost recomputations actually triggered, to demonstrate §O's reduction (expected: zero for an all-weighted-average fixture).

## X. REQUIREMENT CLASSIFICATION

Post-P1F-2 expectations, assuming the design is implemented as specified.

| Requirement | CURRENT | POST-P1F-2 |
|---|---|---|
| §1.2 completed-sale atomicity | NOT IMPLEMENTED | **PARTIAL** — effects 1,2,3,4,5,6,7,8 satisfied; **effect 9 unreachable** (no linked-customer path) |
| UC-POS-01 (whole use case) | NOT IMPLEMENTED | **PARTIAL** — steps 11–13 satisfied; **14 (fiscal receipt/outbox) and 15 (table release) absent** |
| UC-POS-01 §11/§12/§13 | NOT IMPLEMENTED | **COMPLETE** (§13's fiscal-document and loyalty sub-effects excepted, see above) |
| FR-CST-001 | NOT IMPLEMENTED | **COMPLETE** |
| FR-CST-002 | PARTIAL | **COMPLETE with documented deviation** (two fields, §C) |
| BR-POS-001 | DESIGNED ONLY | **COMPLETE** |
| BR-POS-002 | DESIGNED ONLY | **COMPLETE** |
| BR-POS-004 | COMPLETE (1 level) | **COMPLETE** (strengthened by version-closure pinning) |
| FR-POS-007 | PARTIAL (`opened_by`) | **PARTIAL** (`closed_by` added; `served_by` still unwritten) |
| **FR-POS-024** | NOT IMPLEMENTED | **COMPLETE** |
| FR-POS-050 (comps deplete, cost recognised) | NOT IMPLEMENTED | **NOT IMPLEMENTED** — no comp mechanism exists |
| FR-POS-060 / 061 / 063 / 065 / 066 | PARTIAL / COMPLETE | unchanged from P1F-1 |
| FR-POS-064 | NOT IMPLEMENTED | NOT IMPLEMENTED |
| FR-INV-014 | COMPLETE | **COMPLETE** |
| FR-INV-030 | PARTIAL (no sale writer) | **COMPLETE** for sales |
| BR-INV-001 | COMPLETE | **COMPLETE** |
| **BR-INV-003** | PARTIAL / at risk | **COMPLETE for the completion path** — `balance_after` now derives from the atomic projection result; **still at risk for transfers/counts/waste** (§Y) |
| FR-MNU-013 | NOT IMPLEMENTED | **PARTIAL** — `ADD`/`REMOVE_ALL` only; wider surface deferred |
| FR-MNU-045 | PARTIAL | **COMPLETE** — becomes demonstrable once completion exists |
| FR-AUD-001 | PARTIAL | **COMPLETE** for completion |
| FR-PLT-003/010/012/013 | COMPLETE | **COMPLETE** — new tables carry RLS + composite FKs |
| **NFR-PERF-006** | NOT IMPLEMENTED | **PARTIAL until MEASURED** (§W) |
| Fiscal (tax documents/submissions) | NOT IMPLEMENTED | **NOT IMPLEMENTED** — P1C-1 stands |
| Receipt | NOT IMPLEMENTED | **NOT IMPLEMENTED** — §5.5.3, deferred |
| Table release (FR-POS-081 [S]) | NOT IMPLEMENTED | **NOT IMPLEMENTED** — `BranchTable.status` absent by D-05 |
| FR-CRM-004 / FR-CRM-020 | NOT IMPLEMENTED | **NOT IMPLEMENTED** — unreachable |
| FR-PLT-041 (outbox) | NOT IMPLEMENTED | NOT IMPLEMENTED |

**§1.2 and UC-POS-01 are explicitly NOT claimed COMPLETE.** Fiscal document generation, receipt, and table release remain absent; customer/loyalty remains conditionally unreachable.

## Y. REMAINING RISKS

1. **FIFO with zero layers falls back to `average_cost`** (§K.10.1) — a cross-method fallback in tension with P1C-2's recipe-costing constraint. Pre-existing, Inventory-owned, hard to reach. **Recommend a future narrow decision**; P1F-2 must not change it unilaterally.
2. **`MovementsService.post` keeps its lost-update pattern** for transfers, counts and waste. P1F-2 fixes only the completion path (§M). **Recommend a separate narrow Inventory slice**; leaving it is a real, if lower-frequency, correctness risk.
3. **`stock_movements` partition horizon ends 2027-09**, with no DEFAULT partition and a manual per-partition RLS/REVOKE obligation. Completion will be the highest-volume writer. **Operational must-fix before production**, independent of P1F-2.
4. **NFR-PERF-006 unproven until measured** (§W).
5. **Recipe-version closure pinning is an extension** beyond the literal ratified package (§G). If descoped, republishing a sub-recipe mid-order changes historical depletion.
6. **Float arithmetic persists in `costing.ts` helpers** used by other callers; the completion path uses exact arithmetic, so two valuation code paths coexist. Mitigated by an equivalence test (§V), but worth eventual convergence.
7. **`Modifier.kind` ↔ effects consistency is service-validated only** — a cross-row CHECK is not expressible and `kind` is nullable for legacy rows.
8. **`catalogue.modifiers.stock_item_id` / `consumption_quantity` (FR-MNU-012) remain FK-less and unused.** The new effects table supersedes them functionally; they are left untouched, and FR-MNU-012 stays formally unmet.
9. **Comps still cannot deplete** (FR-POS-050) — `is_comp` has no writer, so `compTotal` stays 0 and comped-line depletion is untestable.

## Z. IMPLEMENTATION READINESS

Can Sonnet implement P1F-2 without inventing valuation semantics, modifier semantics, idempotency identity, concurrency behaviour, schema ownership, module contracts, or financial arithmetic?

| Former blocker | Status |
|---|---|
| **B-1** — completion-time COGS deferred | **RESOLVED** — D-17-05 narrowly reopened (§B) + posted-COGS model (§D) |
| **B-2** — modifier semantics opaque | **RESOLVED** — D-17-07 narrowly reopened (§B) + typed `ADD`/`REMOVE_ALL` model (§F/§G) |
| **B-3** — depletion identity not expressible | **RESOLVED HERE** — non-partitioned effect registry keyed `(tenant_id, order_line_id, stock_item_id, location_id)` (§I) |
| **Feared B-4** — valuation-gap vs mandatory SRS COGS | **RESOLVED** — no gap is reachable; `valuationUnitCost` is total and `unit_cost` is NOT NULL, so no provisional mechanism is needed and BR-POS-001 stays intact (§L) |

Valuation is source-defined per method; modifier semantics are ratified and typed; idempotency identity is settled; concurrency behaviour is specified in exact SQL; schema ownership follows §25.1; contracts follow the established pattern; arithmetic is exact `bigint`/`Decimal` with one rounding point.

# **IMPLEMENTATION READY**

## AA. SONNET IMPLEMENTATION PROMPT

---

```
# ROS — P1F-2
# FINAL PAYMENT + ORDER COMPLETION ATOMIC ORCHESTRATION
# MODEL: CLAUDE SONNET 5
#
# IMPLEMENTATION TASK. Design is settled — do not redesign.
#
# AUTHORITY (in order): SRS ROS_SRS_v1.0.pdf > ratified governance
# (docs/governance/GOVERNANCE_DECISION_REGISTER.md, entry "P1F-2 Completion
# Economics & Depletion Resolution — 2026-08-25") > the design gate
# docs/reports/claude/2026-08-25_P1F2A_completion-resolution-gate.md > repo code.
#
# READ FIRST, IN FULL:
#   docs/reports/claude/2026-08-25_P1F2A_completion-resolution-gate.md   (THE DESIGN)
#   docs/reports/claude/2026-08-25_P1F2_completion-architecture-gate.md  (context)
#   docs/governance/GOVERNANCE_DECISION_REGISTER.md — the P1F-2 entry + P1D-B..G + P1C-2 + P1C-5
#   CLAUDE.md
#
# If the design gate and the code disagree, STOP and report — do not improvise.
#
# NEVER USE: git stash / reset / checkout / restore / clean / rebase / commit --amend
#            / push --force / push --force-with-lease
# DO NOT COMMIT. DO NOT PUSH. NO BRANCH OPERATION.
# DO NOT TOUCH: .gitignore, src/main.ts, src/scripts/seed-dev-data.ts
#
# Expected branch: feat/production-spec
# Expected HEAD:   cf04e008a35ba421b23b96b5fa6221a8dae5da12  (verify, do not assume)
# Baseline migrations: 27.  Baseline OpenAPI: 3.1.0, 133 operations.

====================================================================
1. ACCEPTED GOVERNANCE (do not re-litigate)
====================================================================
- D-17-05 narrowly reopened for completion-time COGS ONLY.
- D-17-07 narrowly reopened for typed ADD / REMOVE_ALL modifier depletion ONLY.
  `catalogue.modifiers.recipe_delta` stays OPAQUE and uninterpreted — do not read it.
- order_lines.unit_cost_snapshot is IMMUTABLE sale-time evidence. NEVER rewrite it.
- Posted COGS is a DISTINCT fact, derived from actual valued Inventory depletion.
- Depletion provenance is ORDERLINE-scoped. Aggregate duplicate stock items WITHIN a
  line; NEVER across lines.
- Inventory owns valuation + the ledger. Production owns recipe/modifier semantics +
  expansion + unit conversion. Sales owns Order/OrderLine/completion/posted COGS.
- Do NOT create a Costing module. Do NOT create a `/complete` route. Do NOT create
  `pos.order.complete`. Do NOT invent any permission.
- Negative stock NEVER blocks completion.

====================================================================
2. MIGRATIONS — module-owned, 3 new, final count 30
====================================================================
Follow existing migration conventions exactly (header comment block explaining WHY,
composite tenant-safe FKs, RLS ENABLE+FORCE, explicit grants). Do NOT edit any
existing migration. Do NOT combine modules.

MIGRATION 28 — SALES
  a) ALTER TABLE sales.orders ADD CONSTRAINT ck_completed
       CHECK (state <> 'completed' OR completed_at IS NOT NULL);      -- SRS §25.2
  b) ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;
     + CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0);
  c) CREATE TYPE sales."ModifierEffectOperationSnapshot" AS ENUM ('add','remove_all');
     CREATE TYPE sales."RecipeComponentTypeSnapshot"     AS ENUM ('stock_item','sub_recipe');
  d) CREATE TABLE sales.order_line_modifier_effects  — see gate §G for exact columns,
     XOR CHECK, operation CHECKs, and all FKs. NOT partitioned. RLS ENABLE+FORCE, 4
     policies, GRANT SELECT,INSERT,UPDATE,DELETE TO ros_app.
  e) CREATE TABLE sales.order_line_recipe_versions   — see gate §G.
     UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id). Same RLS/grants.

MIGRATION 29 — PRODUCTION
  a) CREATE TYPE production."ModifierEffectOperation" AS ENUM ('add','remove_all');
  b) CREATE TABLE production.modifier_recipe_effects — see gate §F. REUSE the existing
     production."RecipeComponentType" enum; do NOT duplicate it. Composite tenant-safe
     FKs to catalogue.modifiers (CASCADE), inventory.stock_items (RESTRICT),
     production.recipes (RESTRICT), inventory.uom (RESTRICT). XOR + operation CHECKs.
     RLS ENABLE+FORCE, 4 policies, full DML grant.

MIGRATION 30 — INVENTORY
  a) CREATE TABLE inventory.sale_depletion_effects — see gate §I. NON-PARTITIONED.
     UNIQUE (tenant_id, order_line_id, stock_item_id, location_id).
     FK (tenant_id, order_id, order_line_id, business_day)
        -> sales.order_lines(tenant_id, order_id, id, business_day) RESTRICT
     FK (tenant_id, movement_id, movement_occurred_at)
        -> inventory.stock_movements(tenant_id, id, occurred_at) RESTRICT
     plus stock_items / org.locations / uom composite FKs.
  b) RLS ENABLE + FORCE; SELECT and INSERT policies ONLY (no UPDATE/DELETE policy).
  c) GRANT SELECT, INSERT TO ros_app; REVOKE UPDATE, DELETE, TRUNCATE.
  d) DO NOT alter inventory.stock_movements.

====================================================================
3. PUBLIC CONTRACTS (SRS §5.4 — contract/ is the ONLY legal import surface)
====================================================================
NEW src/modules/production/contract/  (Production's first contract)
  RECIPE_CONSUMPTION_QUERY symbol + RecipeConsumptionQuery with:
    resolveVersionClosure(tx, recipeVersionId)
    resolveModifierEffects(tx, { tenantId, modifierIds })
    planConsumption(tx, input)   -> quantities ONLY, never money
  Exact input/output shapes: gate §H. Implementation is PRIVATE (outside contract/)
  and reuses RecipeCostService's traversal — do NOT duplicate recipe semantics.
  Extend the existing RECIPE_COST_RECOMPUTER port with:
    recomputeForStockItems(tx, stockItemIds) -> string[]

NEW src/modules/inventory/contract/  (Inventory's first contract)
  SALE_DEPLETION_COMMAND symbol + SaleDepletionCommand.depleteForCompletedSale(tx, input)
  Exact shape: gate §P. Inventory resolves the branch location itself from
  org.locations (tenant_id, location_type='branch', ref_id=branchId).

src/modules/sales/contract/events.ts
  ORDER_COMPLETED_EVENT_TYPE = 'order.completed'; ORDER_COMPLETED_EVENT_VERSION = 1.
  Payload EXACTLY per SRS §24.2.4 (gate §Q). Invent no fields.

Extend module-boundaries.spec.ts to prove: contract/ files are interface-only; the
concrete impls are outside contract/; sales-payment.service.ts imports Production and
Inventory ONLY from <module>/contract; and KNOWN_DEVIATIONS DOES NOT GROW.

====================================================================
4. MODIFIER SEMANTICS (gate §F) — deterministic, no DSL
====================================================================
Operations: ADD, REMOVE_ALL. Substitution = REMOVE_ALL + ADD.
Evaluation order, per line:
  1 expand base recipe from the PINNED version closure
  2 aggregate per stock_item WITHIN the line
  3 apply ALL REMOVE_ALL (zero that stock item's aggregate)
  4 apply ALL ADD (expand sub-recipe ADDs, convert to base unit, scale)
  5 re-aggregate; drop non-positive
REMOVE_ALL targets a stock_item only; removes every occurrence at every depth.
REMOVE_ALL of an absent component = NO-OP, not an error.
ADD scaling = effect.quantity x order_line_modifiers.quantity x order_lines.quantity.
ADD quantities are per SOLD PORTION and are NOT divided by the base recipe yield.
Removal STRICTLY precedes addition (this is what makes substitution correct).

====================================================================
5. SALE-TIME SNAPSHOT (line capture) — gate §G
====================================================================
In OrderLinesService.create, inside the SAME existing transaction:
  - persist the resolved recipe version closure into sales.order_line_recipe_versions
    (obtained from resolveVersionClosure; the cost traversal already walks this graph)
  - persist resolved modifier effects into sales.order_line_modifier_effects, storing
    sub_recipe_version_id (PINNED), never a logical recipe id
Do NOT change existing pricing/tax/unit_cost_snapshot behaviour.
IN-SCOPE MICRO-FIX: order-lines.service.ts recomputeOrderTotals currently does
  cogs = (cogs ?? 0n) + line.unitCostSnapshot
ignoring quantity. Multiply by line.quantity with a single HALF_UP rounding. Change
nothing else in that method. Add a test proving a qty=3 line contributes 3x.

====================================================================
6. COMPLETION TRANSACTION — gate §P (follow the table exactly)
====================================================================
Migrate SalesPaymentService from prisma.withAuthContext to unitOfWork.execute so it can
publish events (SalesFireService is the precedent). ONE transaction. No nesting.

Order of operations is NORMATIVE:
  1 permanent Payment-id replay/conflict check  (MUST be first)
  2 load order + non-voided lines + modifier effect snapshots + version closures
  3 assertMayCapturePayment  4 assertVersion  5 CashSession facts  6 pinned policy
  7 tender computation  8 settlement decision  9 insert immutable Payment
  PARTIAL  -> 10a existing P1F-1 CAS (state stays/becomes partially_paid)
  SETTLING -> 10b planConsumption
              11b depleteForCompletedSale  (valued effects returned)
              12b recomputeForStockItems  (DISTINCT FIFO items only)
              13b write order_lines.posted_cogs_total from the valued effects
              14b Order CAS: paid_total, rounding_adjustment, state='completed',
                  completed_at, closed_by (EMPLOYEE — P1D-E), cogs_total, version+1
  15 audit PAYMENT_CAPTURED   16 audit ORDER_COMPLETED (new constant; include before{},
     gaps, movement ids, posted COGS)   17 publish order.completed   18 drain
  19 re-read  20 COMMIT
NEVER write posted COGS before depletion succeeds. NEVER complete the Order before
depletion + COGS succeed. Remove FULL_PAYMENT_REQUIRES_COMPLETION only once the
settling path is implemented and green; replace its test with completion tests.
State machine: add 'completed' as a legal target from BOTH 'open' and 'partially_paid'
in order-state.ts TRANSITIONS. No intermediate state may ever be persisted.

====================================================================
7. INVENTORY COMMAND — gate §I, §K, §M, §N
====================================================================
Sort ALL effects by (stock_item_id, location_id, order_line_id) ASC and process in that
order — never JS map iteration order. Per (stock_item, location):
  - if FIFO and batch-tracked: SELECT ... WHERE quantity_remaining > 0
      ORDER BY created_at ASC, id ASC FOR UPDATE      (NEVER SKIP LOCKED)
  - value per gate §K (weighted_average -> stock_levels.average_cost;
      fifo -> value-weighted mean of consumed layers, remainder at that same mean;
      standard -> standard_cost). NO cross-method fallback beyond the documented
      pre-existing FIFO-with-zero-layers case; do NOT change valuationUnitCost.
  - ATOMIC projection FIRST:
      INSERT ... ON CONFLICT (stock_item_id, location_id) DO UPDATE
        SET quantity_on_hand = stock_levels.quantity_on_hand + EXCLUDED.quantity_on_hand,
            last_movement_id = EXCLUDED.last_movement_id,
            last_movement_occurred_at = EXCLUDED.last_movement_occurred_at
      RETURNING quantity_on_hand;
    average_cost is NOT changed by outbound.
  - insert the stock_movement with balance_after = the RETURNING value,
    movement_type='sale_depletion', reference_type='order', reference_id=ORDER id,
    quantity negative, unit = stock item base unit
  - decrement consumed batches under the lock
  - INSERT INTO sale_depletion_effects ... ON CONFLICT (tenant_id, order_line_id,
      stock_item_id, location_id) DO NOTHING RETURNING ...;
    0 rows => raise a conflict and let the whole transaction roll back.
    NEVER INSERT-catch-P2002-then-query.
Arithmetic: EXACT. quantity is Prisma.Decimal, money is bigint, use common/money/rational.
total_cost = round_half_up(abs(quantity) x unit_cost) — the ONE rounding point.
Do NOT reuse costing.ts's float helpers on this path; do NOT modify them either.
Do NOT modify MovementsService.post (transfers/counts/waste keep their path).

====================================================================
8. POSTED COGS — gate §D
====================================================================
order_lines.posted_cogs_total = exact bigint SUM of that line's movement total_cost.
orders.cogs_total = exact bigint SUM of line posted totals. No rounding at either level.
Absent recipe => posts 0 (NOT NULL). NULL means "not completed".
No posted_unit_cogs column, no posted_cogs_at column (derivable — P1C-5 item 7).
Document orders.cogs_total's post-completion meaning in the schema doc comment.

====================================================================
9. VERIFICATION — all required
====================================================================
FINANCIAL: OPEN->COMPLETED via one settling payment; PARTIALLY_PAID->COMPLETED;
  partial stays PARTIALLY_PAID; exact settlement; over-tendered cash + change;
  manual external card; Payment permanent-id replay AFTER completion; HTTP replay after
  completion; same Payment id different facts -> 409; stale If-Match -> 409.
ATOMICITY: force a failure at EACH mandatory stage (expansion, modifier resolution,
  effect registry, movement, FIFO batch update, level projection, COGS projection,
  Order CAS, audit, order.completed handler) and prove TOTAL rollback: no Payment, no
  completion, no partial depletion, no partial COGS, no audit residue.
INVENTORY: nested expansion; same stock item via multiple sub-recipe paths aggregated
  within a line; same stock item on two lines stays independently traceable; ADD;
  REMOVE_ALL; substitution; the "no cheese" case; absent recipe; incomplete recipe;
  negative stock; each costing method.
IDEMPOTENCY: exact replay creates no second effect row, movement, projection delta,
  COGS or audit.
CONCURRENCY (real PostgreSQL barriers, NO sleeps, >=3 clean runs each): gate §V tests
  1-4, including BR-INV-003 ledger==projection and FIFO determinism.
STRUCTURAL: cross-tenant effect impossible; effect cannot point at the wrong OrderLine
  or wrong stock item/location; registry append-only; RLS proven via the real ros_app
  connection (app.get(PrismaService)); ros_app cannot UPDATE/DELETE the registry.
PERFORMANCE: gate §W — 30 lines, nested recipes, measure the expansion+depletion section,
  report p50 AND p95. Do NOT claim NFR-PERF-006 COMPLETE without the measurement.
BUILD/SUITE: nest build; npx tsc --noEmit (only the known access-token.service.spec.ts
  baseline error may remain, zero new); eslint on changed files; npx prisma validate;
  git diff --check; npm run openapi:check -> 3.1.0 and EXACTLY 133 operations (no new
  route); full unit suite; full E2E suite against a CLEAN FROM-ZERO scratch DB with BOTH
  DATABASE_URL and APP_DATABASE_URL set (expect 30 migrations); drop the scratch DB after;
  prove the persistent `ros` dev DB was never migrated.

====================================================================
10. NON-GOALS
====================================================================
No refunds/voids/reversals. No PaymentAttempt or integrated card. No receipt. No fiscal
document or outbox. No loyalty/CRM. No table release. No session/day close. No X/Z
reports. No comp mechanism. No Costing module. No new permission. No RFC7807. No /v1.
Do NOT fix MovementsService.post's lost-update for transfers/counts/waste (separate slice).
Do NOT change FIFO-with-zero-layers valuation. Do NOT retire the existing
sales->production KNOWN_DEVIATIONS entry.

====================================================================
11. REPORT
====================================================================
Write docs/reports/claude/2026-08-26_P1F2_order-completion.md with the required ROS
header (task, type, authority statement, date, HEAD, branch, worktree, task id), the
full verification evidence including MEASURED p50/p95, exact test counts, requirement
classifications per gate §X (do NOT claim §1.2 or UC-POS-01 COMPLETE), every deviation
and residual risk, and honest reporting of any failure. Update
docs/reports/claude/INDEX.md. DO NOT COMMIT. DO NOT PUSH.

DEFINITION OF DONE: 30 migrations applied from zero on a clean scratch DB; full unit +
full E2E green; concurrency tests >=3 clean runs each; performance measured and reported;
OpenAPI 3.1.0 / 133 operations with zero drift; tsc clean apart from the known baseline;
report + INDEX written; nothing committed or pushed; the three preserved user files
untouched.
```
