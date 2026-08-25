# P1F-2B — Completion Semantics & Repository-Shape Correction Gate

**Report type:** Architecture / source-resolution / repository-audit gate (no production code, no production migration, no commit, no push)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted architecture/design records → repository evidence**. Nothing here creates, amends, or ratifies a governance decision.
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (unchanged — no commit)
**Branch:** `feat/production-spec`
**Working tree:** three preserved user files (`.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts`), the P1F-2 and P1F-2A reports, the governance register entry, INDEX, plus this report
**Task identifier:** P1F-2B

> ## VERDICT (§R)
> ## **BLOCKED — FIFO ZERO-LAYER VALUATION NOT SOURCE-DECIDABLE**
> Nine of the ten corrections are resolved, and the ratified P1F-2 governance package
> is fully preserved. **C-1 is a genuine, narrow, unresolvable-by-engineering gap**:
> when a FIFO-costed item has zero remaining batch layers, no SRS text, no ratified
> decision and no repository artefact defines the unit cost — and the two natural
> fallbacks are explicitly forbidden by P1C-2. §S is **NOT GENERATED**.
> One user decision (§C) unblocks the entire slice.

---

## A. STARTING STATE

| Check | Result |
|---|---|
| Branch | `feat/production-spec` |
| `git rev-parse HEAD` | `cf04e008a35ba421b23b96b5fa6221a8dae5da12` |
| `origin/feat/production-spec` | `cf04e008…` — matches, no divergence |
| `origin/main` | `01c0b0f3d3228af5248782a09e8dc0bc65606f9e` — untouched |
| Working tree | ` M .gitignore`, ` M docs/governance/GOVERNANCE_DECISION_REGISTER.md`, ` M docs/reports/claude/INDEX.md`, ` M src/main.ts`, `?? …P1F2A…md`, `?? …P1F2…md`, `?? src/scripts/seed-dev-data.ts` |
| Migrations | **27** |
| OpenAPI | **3.1.0**, **133** operations (95 paths; verified independently — see §N) |

No branch operation, no destructive git command, no commit, no push. Preserved user files untouched.

## B. P1F-2A ACCEPTED PARTS

The ratified governance package (register entry *“P1F-2 Completion Economics & Depletion Resolution — 2026-08-25”*) is **fully preserved and unamended**. Nothing in this gate re-litigates D-17-05's or D-17-07's narrow reopening, `recipe_delta` opacity, `unit_cost_snapshot` immutability, posted COGS as a distinct Sales fact, module ownership, OrderLine-scoped provenance, within-line-only aggregation, the non-partitioned registry, the Payment route as entry point, `pos.payment.capture` as the only interactive permission, negative stock never blocking, no Costing context, or no D-21+.

**§14 regression audit — what survived review:**

| # | P1F-2A direction | Verdict | Reason |
|---|---|---|---|
| A | `sale_depletion_effects` NON-partitioned registry | **PRESERVED** | Non-partitioned is what lets the business key omit `occurred_at`; also avoids the per-partition RLS obligation that `stock_movements` carries. |
| B | Key `(tenant_id, order_line_id, stock_item_id, location_id)` | **PRESERVED** | Line-scoped per ratification; `location_id` retained as cheap structural protection. Expressible because the table is non-partitioned. |
| C | 1 effect = 1 movement | **PRESERVED** | Matches SRS §7.4.3's `order_lines ──1:N── stock_movements` relationship; bounds movement count at `distinct(line × item)`. |
| D | Line-scoped provenance | **PRESERVED** | Ratified. |
| E | Within-line aggregation only | **PRESERVED** | Ratified; also what makes `REMOVE_ALL` unambiguous (§F of P1F-2A). |
| F | `INSERT … ON CONFLICT DO NOTHING RETURNING` | **PRESERVED** | P1E-5A pattern; verified as the repo's established conflict-safe idiom. |
| G | No `P2002` catch-then-query in an aborted tx | **PRESERVED** | P1E-5A explicitly rejected it. |
| H | Atomic additive stock-level update | **PRESERVED IN PRINCIPLE, ORDER CORRECTED** | The `+=` is right; the *statement order* was illegal — see **§H / C-6**. |
| I | Deterministic lock ordering | **PRESERVED** | Sorted `(stock_item_id, location_id, order_line_id)`; prevents lock-order inversion. |
| J | FIFO without `SKIP LOCKED` | **PRESERVED** | Ratified; skipping a locked older layer would change FIFO truth. |
| K | Production owns quantities; Inventory owns valuation | **PRESERVED** | Ratified §3.1.G. |
| L | Sales owns posted COGS | **PRESERVED** | Ratified §3.1.D. |
| M | Final Payment is the Completion trigger | **PRESERVED** | Ratified §3.6. |
| N | Order CAS last | **PRESERVED** | Nothing found to contradict it. |
| O | One UnitOfWork transaction | **PRESERVED** | `withAuthContext` is a single `$transaction` and structurally forbids nesting. |

**Corrected:** C-1 (§C), C-2 (§D), C-4 (§F), C-5 (§G), C-6 (§H), C-7 (§I — preserved but for a *different, now-proven* reason), C-8 (§J), C-9 (§K), C-10 (§L). C-3 (§E) resolved with **no change required**.

## C. FIFO ZERO-LAYER — **BLOCKER**

P1F-2A asserted both “no valuation gap is reachable” **and** “FIFO with zero layers falls back to `averageCost`, which is a cross-method fallback in tension with the no-fallback principle”. Those cannot both stand. Resolved here from source and code.

### The two cases, separated

**Case 1 — FIFO partial coverage** (some layers exist; requested quantity exceeds them).

| Aspect | Finding |
|---|---|
| Valuation source | `valuationUnitCost` (`src/modules/inventory/costing.ts:145-158`): value-weighted mean of the layers **actually consumed**; `totalCost` then multiplies by the **full** quantity (`:160`) |
| FIFO-native? | **Yes** — it is the cost of the stock this depletion actually drew on |
| Source-backed? | **Yes, by extension** — FR-INV-012 (*“cost of the oldest remaining batch”*) and FR-INV-013 (*“FIFO valuation SHALL follow batch receipt order”*) both describe exactly this draw-down |
| Crosses methods? | **No** |
| Completion continues? | **Yes** — FR-INV-014, UC-POS-01 13a |
| `unit_cost` / `total_cost` | weighted mean of consumed layers / magnitude × full quantity |
| COGS | fully determined |

**Case 1 is RESOLVED and requires no decision.**

**Case 2 — FIFO zero coverage** (no layer with `quantity_remaining > 0` at Completion).

| Aspect | Finding |
|---|---|
| Current code | `costing.ts:150-157`: `const qty = consumed.reduce(…); if (qty <= 0) return input.averageCost;` — **falls back to weighted average** |
| FIFO-native? | **No** |
| Source-backed? | **NO.** FR-INV-012 defines FIFO **only** as *“Consumption valued at the cost of the oldest **remaining** batch”* — with no remaining batch the definition has no referent. FR-INV-013 is scoped to batch-tracked draw-down. SRS §24.5.2's `FifoCostingStrategy` delegates to an undefined `drawDown(batches, qty)` and never specifies empty-input behaviour. |
| Crosses methods? | **YES** — directly contrary to **P1C-2 binding constraint 1** (RATIFIED): *“Every component is valued by ITS OWN configured costing method … There is **no global default**, no fallback from one method to another, and no ‘latest purchase cost’ standing in for FIFO.”* P1C-2 was **not** reopened by the P1F-2 package. |

### Is it reachable? **Yes.**

1. A complete recipe whose component cannot be valued is **refused at line capture** — `StockValuationService` filters `quantityRemaining: { gt: 0 }` (`stock-valuation.service.ts:104-113`) and returns `null`, which P1C-5 turns into a 422. So at capture, ≥1 layer existed.
2. Between capture and completion those layers can be exhausted — by waste, counts, transfers, or (once P1F-2 ships) **a concurrent completion of the same item**.
3. FR-INV-014 mandates the depleting transaction proceed regardless.

So the case is not exotic: it is the natural steady state of a busy FIFO item near zero stock, and concurrent sales are its most likely trigger.

### Is there a deterministic FIFO-native source in the repository?

Exhausted layers **do persist** — there is no `stockBatch.delete` path anywhere in `src/`, and `ck_batch_qty_nonneg` holds them at `>= 0`. `@@index([tenantId, stockItemId, locationId])` supports the lookup. So several candidates are *implementable*. None is *source-backed*:

| Candidate | Available? | Source-backed? |
|---|---|---|
| Cost of the newest exhausted layer (the layer FIFO last drew on) | Yes | **No** — no SRS text; and with all layers exhausted it coincides with the latest receipt, which P1C-2 names explicitly |
| Latest batch ever received | Yes | **No** — this *is* “latest purchase cost standing in for FIFO”, forbidden verbatim |
| `unit_cost` of the most recent prior outbound movement | Yes | **No** — FIFO-lineage but defined nowhere |
| `stock_levels.average_cost` (status quo) | Yes | **No** — cross-method fallback, forbidden by P1C-2 |

**Neither the SRS, nor the governance register (zero FIFO-fallback rulings), nor `docs/inventory/INVENTORY_DESIGN_GATE.md` decides it.** Notably, that gate's own §29 *“Remaining Ambiguities That Cannot Be Resolved”* lists five items and **this is not among them** — the `averageCost` fallback was never surfaced for ratification; it was simply written.

The governing instruction is explicit: *“Do NOT use weighted-average cost for a FIFO item merely because an old helper does so. Do NOT silently preserve a pre-existing helper if doing so contradicts ratified/source semantics.”*

### **BLOCKED — FIFO ZERO-LAYER VALUATION NOT SOURCE-DECIDABLE**

**Smallest exact user decision:** *When a FIFO-costed, batch-tracked stock item has **zero** remaining batch layers at Completion, what `unit_cost` values the depletion?*

| Option | Rule | Consequence |
|---|---|---|
| **A (recommended)** | **Cost of the most recently exhausted layer** for that `(item, location)` — the layer FIFO was last drawing on. FIFO “runs past the end of its queue” and continues at its own last layer cost. | FIFO-lineage, deterministic, no new schema, terminal-safe (a layer existed at capture). **Requires narrowing P1C-2** to mean *“do not substitute a purchase-price lookup for an **available** FIFO layer”*, rather than *“never use a historical layer cost when the queue is empty.”* |
| **B** | **`unit_cost` of the most recent prior outbound movement** for that `(item, location)`. | Explicitly never a purchase price; continues the item's realised FIFO cost lineage. Needs a terminal rule when no prior outbound movement exists. |
| **C** | **Keep the status quo** (`average_cost`) and ratify it explicitly as Inventory's movement-valuation rule. | Zero code change; but must explicitly narrow P1C-2's no-cross-method-fallback clause to exempt Inventory movement valuation. |
| **D** | Refuse the depletion. | **Not viable** — violates FR-INV-014 and UC-POS-01 13a; would roll back a fully-paid sale. |

**Recommendation: A**, with **C** as the acceptable minimum-change alternative. Either way the decision must be recorded as a narrow amendment (no D-21), because both touch P1C-2's wording. **Whichever is chosen must apply only to Inventory movement valuation and must not alter Production's `StockValuationService`**, which correctly returns `null` and must keep refusing uncostable sales at capture.

## D. CONVERSION-GAP SEMANTICS (C-2) — **CORRECTED**

P1F-2A's blanket rule (*missing conversion → gap → component contributes zero → sale completes*) is **rejected**.

**FR-INV-004 [M], verbatim:** *“The System SHALL support mass↔volume conversion for an item where a density factor is configured, **and SHALL reject such conversion where it is not**.”* “Reject” is not “silently treat as zero”.

UC-POS-01 13a covers **inventory state** (*“an ingredient's stock goes negative”*) — a quantity shortage. A missing conversion factor is a **configuration defect**, not an inventory state, and 13a does not license it.

The repository already classifies this correctly and the ratified semantics already exist:

`recipe-cost.ts:85-104` splits gap reasons into `STRUCTURAL_GAP_REASONS = {no_components, no_published_version}` (BR-MNU-012 — the definition is unfinished) and **`VALUATION_GAP_REASONS = {no_valuation, no_unit_conversion}`** (the definition is finished but cannot be priced). **P1C-5 item 4** is directly on point: *“A component Inventory cannot price is a VALUATION gap, is not BR-MNU-012, and **refuses the sale** rather than reducing the cost.”*

| Case | Completion behaviour | Basis |
|---|---|---|
| **A. Absent recipe** (`recipe_version_id IS NULL`) | Zero depletion, zero posted COGS, **sale completes**. Not an error. | P1C-5 (RATIFIED) |
| **B. Structurally incomplete recipe** | Depletes only the components that ARE defined; missing components contribute **nothing** (not a zero-cost component). Sale completes. | BR-MNU-012, P1C-5 item 3 |
| **C. Valid recipe, conversion configured** | Full depletion. | — |
| **D. Specified component, required conversion missing** | **FAIL CLOSED** — 422, whole transaction rolls back. **Never** silently zero. | FR-INV-004; P1C-5 item 4 |
| **E. mass↔volume with no density** | **FAIL CLOSED** — identical to D; FR-INV-004 names this case explicitly. | FR-INV-004 |
| **F. Dangling UoM reference** | Structurally impossible — `uom_conversions.from_unit_id`/`to_unit_id` and `stock_items.base_unit_id` are FK-backed with `ON DELETE RESTRICT`, and no delete path exists. | DDL |

**Reachability of D/E at Completion: STRUCTURALLY NIL under the corrected design.** A complete recipe with a missing conversion is already refused at **line capture** (`no_unit_conversion` is a VALUATION gap → 422). And because §E moves conversion resolution entirely to capture and snapshots the resolved base-unit quantities, **completion performs no unit conversion at all** — so D/E cannot arise there by construction, not merely by improbability.

**Correction to carry into implementation:** the consumption resolution must distinguish `STRUCTURAL` gaps (tolerate, deplete partially — BR-MNU-012) from `VALUATION`/conversion gaps (**throw, refuse**). P1F-2A's §H sentence *“A missing unit conversion is a `gap`, not a throw”* is **wrong and must be removed.**

**One honest qualification on the mechanism.** FR-INV-004's rejection is satisfied in *effect* but not by a dimension check: `Uom.dimension` is **never read anywhere in `src/`**, so no code distinguishes a mass unit from a volume unit. A mass↔volume conversion without density fails only because no `uom_conversions` row matches, yielding `null` → gap → refusal. BR-CORE-004's mandated explicit failure is recorded as **NOT IMPLEMENTED** (`docs/RECONCILIATION_POST_PRODUCTION.md:908`). P1F-2 inherits the correct outcome without implementing the stated rule — classified accordingly in §P and listed in §Q.

## E. UOM / DENSITY HISTORICAL STABILITY (C-3) — **CORRECTED: pinning IS required**

Audit of every write path:

- **`UomConversion`: no create, update or delete path exists anywhere in `src/`.** The only two references in the entire application are reads — `recipe-cost.service.ts:381` (`findMany`) and `:398` (`findFirst`).
- **`Uom`: no create/update/delete path in `src/`.** Rows arrive via migration/seed only.
- `UomConversion` is **not** versioned or effective-dated — no `version`, `effective_from`, `superseded`, not even a `created_at`. Its only key, `uq_uom_conv (from_unit_id, to_unit_id, stock_item_id)`, **structurally admits exactly one generation**: a factor change is necessarily a destructive in-place UPDATE with no record of the prior value.

**However — a reachable mutation of the conversion basis DOES exist, and P1F-2A missed it.**

`conversionToStockBaseUnit` selects its factor row using `toUnitId: item.baseUnitId`, read **at expansion time** (`recipe-cost.service.ts:375-383`). So the conversion basis is a function of `StockItem.baseUnitId`, which **is mutable** through a live route: `POST inventory/items/:itemId/base-unit` → `StockItemsService.changeBaseUnit` (`stock-items.service.ts:135-170`), guarded only by an application-level, unlocked `stockMovement.count(...) > 0` check.

**That guard is vacuous today**, precisely because no sale currently produces a stock movement. Therefore:

> An order line captured now, for a stock item that has never been depleted, can have its item's `base_unit_id` changed before the order completes. If Production re-expands the recipe **at completion**, it resolves a **different conversion factor** — or `null` — than the one the sale was priced on. `recipe_version_id` would be identical on both, because the recipe did not change; the item's base unit did.

The window is narrow (requires `inventory.adjust`, and closes permanently for any item once P1F-2 itself starts writing depletion movements) — but it is real, reachable, and silently corrupts historical depletion. **Recipe-version closure pinning alone is therefore insufficient**, exactly as the governing task anticipated.

### Narrowest historical fact required

Snapshot, at line capture, the **resolved NET base-unit consumption per (order line, stock item)** — the output of the expansion, not the inputs to it:

```
sales.order_line_consumption_components
  id, tenant_id, business_day, order_line_id
  stock_item_id                      -- FK (tenant_id, stock_item_id) -> inventory.stock_items RESTRICT
  quantity_in_base_unit  DECIMAL(18,6) NOT NULL CHECK (> 0)
  unit_id                            -- the base unit resolved AT CAPTURE
  provenance             enum('recipe','modifier_add')
  order_line_modifier_id UUID NULL   -- set when provenance='modifier_add'
  UNIQUE (tenant_id, order_line_id, stock_item_id)
```

This satisfies every constraint the task imposed: it snapshots **quantities, never valuation** (valuation still happens at Completion, per §K of P1F-2A); it is **typed and relational**, not opaque executable JSON; it preserves exact `Decimal` arithmetic; and it duplicates nothing already immutable — `recipe_versions` are immutable (D-17-04) but `base_unit_id` and `uom_conversions` are not, which is exactly the gap it closes.

**Consequential simplifications this produces:**
1. **Completion no longer performs unit conversion at all**, so §D's cases D/E become **structurally unreachable** at completion rather than merely improbable.
2. **NFR-PERF-006 becomes trivially satisfiable** — completion reads rows instead of re-walking the recipe graph.
3. Capture pays no meaningful extra cost: `OrderLinesService` **already runs the full recursive traversal** via `RecipeCostService.cost` and currently discards the per-component `quantityInBaseUnit` it computes (`recipe-cost.ts:244-248`).
4. **`sales.order_line_modifier_effects` (P1F-2A) is DROPPED** — with the net result snapshotted, re-applying modifier effects at completion is redundant. Applied `REMOVE_ALL` operations are recorded in the **line-capture audit entry**, following the ratified P1C-5 item-7 precedent (*"The basis is recorded in the AUDIT entry only… Adding a column would duplicate derivable state"*). FR-POS-024 remains fully test-provable: a "no cheese" line simply has **no cheese row**.
5. `sales.order_line_recipe_versions` is **retained** — recipe-version provenance is a distinct, non-derivable fact required by BR-POS-004 and FR-MNU-045.

**Production still owns the semantics** (ratified §3.1.G) — it computes the plan; only the *moment* moves from completion to capture. Its contract keeps `planConsumption`, now invoked at capture.

**Residual risks, recorded (§Q), not P1F-2 scope:**
1. `ros_app` holds full DML on `inventory.uom` / `uom_conversions` with **no RLS at all** (`20260816210000…:566-576`, `:796-800`) — the only thing protecting captured sales today is that no controller writes them.
2. **BR-CORE-004 / FR-INV-004 mass↔volume rejection is NOT actually implemented as a dimension check** — `Uom.dimension` is never read anywhere in `src/`, so nothing distinguishes a mass unit from a volume unit. The fail-closed behaviour in §D arises incidentally, because a missing conversion row yields `null` → gap → refusal. Already recorded as NOT IMPLEMENTED in `docs/RECONCILIATION_POST_PRODUCTION.md:908`.
3. `changeBaseUnit`'s guard is application-only and unlocked (no row lock, no advisory lock). P1F-2 **improves** this indirectly: once completions write movements, the guard starts biting for real.

## F. SALES SNAPSHOT IMMUTABILITY (C-4) — **CORRECTED**

P1F-2A's migration 28 granted `SELECT, INSERT, UPDATE, DELETE` with all four RLS policies on tables it simultaneously called “immutable”. That is not an immutability guarantee.

**Audit of whether mutation is needed:**
- `OrderLinesService.voidLinePreFire` sets `state='voided'`, `voidedBy`, `voidReasonId` — it **does not delete** the line.
- **No code path anywhere in `src/` deletes an `Order`, an `OrderLine`, or an `OrderLineModifier`** (`order.delete`, `orderLine.delete`, `*.deleteMany` — zero non-generated hits).
- No code path updates an `OrderLineModifier` after creation.

**Therefore no UPDATE or DELETE capability is required.** Corrected privilege model for both new Sales snapshot tables, matching the `sales.order_payments` precedent verbatim (`20260824100000…/migration.sql:124-125`):

```sql
GRANT SELECT, INSERT ON <table> TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON <table> FROM ros_app;

ALTER TABLE <table> ENABLE  ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE   ROW LEVEL SECURITY;
CREATE POLICY <t>_select ON <table> FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY <t>_insert ON <table> FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- deliberately NO update policy and NO delete policy
```

**On the parent CASCADE objection — and an important limit the audit exposed.** Keeping `ON DELETE CASCADE` from the order line is compatible with withholding a direct DELETE grant: PostgreSQL runs referential actions through internal RI triggers that `SetUserIdAndSecContext(...)` to the **table owner** with `SECURITY_NOFORCE_RLS`, so the cascade neither consults the invoker's privileges on the child nor applies the child's RLS policies. Cascade-on-parent-delete therefore still functions, and withholding DELETE is not a reason to grant it.

**But the same rule bounds what the REVOKE buys.** A child-only `REVOKE DELETE` blocks a *direct* `DELETE FROM child`; it does **not** stop a cascade initiated by deleting the parent. `sales.orders` and `sales.order_lines` currently grant `ros_app` full DML with permissive delete policies (`20260820120000_sales_order_foundation/migration.sql:295-302`, `:317-339`), so an actor able to delete an order would still erase the snapshots beneath it. Recorded honestly:
- The child-level REVOKE is still **correct and worth doing** — it is the difference between "immutable" and "immutable except by an unrelated code path", and it matches the `order_payments` precedent exactly.
- **No parent delete path exists** anywhere in `src/` (verified: zero `order.delete`/`orderLine.delete`/`deleteMany` call sites outside tests), so the cascade paths are dormant.
- Making the sale-time snapshots *structurally* indelible would additionally require revoking DELETE on `sales.orders`/`sales.order_lines` — a **Sales-wide hardening decision outside P1F-2's scope**, recorded in §Q rather than smuggled in here. The identical gap already applies to `order_payments` and predates this slice.

**Required proof in implementation** (real `ros_app` connection via `app.get(PrismaService)`, never the migrator client): own-tenant SELECT succeeds; INSERT through the intended service succeeds; cross-tenant read and write blocked; UPDATE rejected; DELETE rejected; the row survives the failed mutation; and the exact grants are inspected from `information_schema.role_table_grants`.

The same append-only model applies to `inventory.sale_depletion_effects`, which P1F-2A already specified correctly.

## G. MODIFIER CONFIGURATION SURFACE (C-5) — **CORRECTED: a new route is required**

P1F-2A created `production.modifier_recipe_effects` as editable master data but established **no write path**, while asserting OpenAPI stays at 133. A table populated only by fixtures cannot make FR-POS-024 operationally implemented.

**Audit result — nothing can be extended:**
- **Production has zero modifier awareness.** `grep -rni "modifier" src/modules/production/` returns **no hits**. `RecipeLine` has no modifier axis (its component is `stock_item | sub_recipe` under `ck_recipe_line_component`). `ProductionModule` does not import Catalogue.
- **Catalogue has no modifier-mutation route at all.** `POST /catalogue/modifier-groups/:groupId/modifiers` is **create-only**; there is no `PATCH`/`PUT`/`DELETE` for an individual modifier, and `ModifierGroupsService` has no update/remove method. Corroborating: `AUDIT_ACTION.MODIFIER_UPDATED` is declared and **never used**.

So a modifier's recipe effects are, today, write-once-at-creation and unchangeable. **A new HTTP operation is unavoidable.**

**Design:**

| Aspect | Decision |
|---|---|
| Owner | **Production** — ratified §3.1.G gives Production “modifier recipe effects”. Catalogue owns modifier *identity*; Production owns its *recipe semantics*. |
| Route | `PUT /modifiers/{modifierId}/recipe-effects` — full replace |
| Permission | **`recipe.edit`** (`PRODUCTION_PERMISSIONS.EDIT`) — an existing SRS §15.2 code. **No permission invented**; D-17-06 forbids new `recipe.*` codes, and substitute groups already ride on `recipe.edit` by the same reasoning. |
| Shape precedent | `PUT /recipes/:recipeId/versions/:version/lines` — the **only** `@Put(` in the codebase: envelope body `{ effects: [...] }` via a dedicated `Replace*Dto` with `@ValidateNested({each:true})`, destructive `deleteMany`+`createMany`, response = parent row + count |
| Cross-module reference | `modifierId` validated by the **composite FK** `(tenant_id, modifier_id) → catalogue.modifiers(tenant_id, id)` plus `rethrowAsNotFoundOnFk(err, …)` → 404. This is exactly how `RecipesService.create` already validates the Catalogue-owned `menuItemVariantId` — **no code import, no boundary deviation added.** |
| Validation | XOR component shape; `add` requires `quantity > 0` + `unit_id`; `remove_all` requires `component_type='stock_item'` and null quantity/unit; kind↔effect consistency against `Modifier.kind` (service-level, since `kind` is nullable for legacy rows) |
| Audit | new `MODIFIER_RECIPE_EFFECTS_REPLACED` action on entity `modifier` — audit taxonomy is not governance-frozen (unlike permissions) and follows the existing `<ENTITY>_<PAST_TENSE>` convention |
| Read-back | `GET /modifiers/{modifierId}/recipe-effects` — **omitted**; the `PUT` returns the full effect set, matching `replaceLines`' precedent of returning parent+count. *(If a read is wanted, count becomes 135; recommended: no.)* |

**Scope decision: include this in P1F-2, do NOT make it a preceding slice.** It is one route, one DTO, one service method on an already-planned table — materially smaller than any of P1F-2's other parts — and without it FR-POS-024 cannot honestly be classified anything but NOT IMPLEMENTED.

**OpenAPI: 133 → 134.** See §N.

## H. STOCK_LEVEL FK / WRITE ORDER (C-6) — **CORRECTED (P1F-2A's order was illegal)**

P1F-2A proposed: atomic `stock_levels` upsert **first** (setting `last_movement_id`), `RETURNING quantity_on_hand`, then insert the movement. **That is not legal against the actual DDL.**

**Findings:**
- `stock_levels.last_movement_id` and `last_movement_occurred_at` **exist** and **are FK-backed**:
  `20260816210000_inventory_foundation/migration.sql:418` —
  `FOREIGN KEY ("tenant_id","last_movement_id","last_movement_occurred_at") REFERENCES "inventory"."stock_movements"("tenant_id","id","occurred_at") ON DELETE RESTRICT ON UPDATE CASCADE`
  (the partition-aware target `@@unique([tenantId, id, occurredAt])`).
- **There is not a single `DEFERRABLE` constraint anywhere in `prisma/migrations/`.** The FK is immediate.
- Therefore an upsert that sets `last_movement_id` to a not-yet-inserted movement **fails immediately with a foreign-key violation**.
- `stock_movements.balance_after` is `DECIMAL(18,6) **NOT NULL**` (`:128`) — so the movement cannot be inserted before the post-update balance is known.
- `ros_app` holds full DML on `stock_levels` (`:566-576`), and `stock_levels` has all four RLS policies — so a subsequent `UPDATE` of the pointer columns is permitted.
- `stock_movements` has `REVOKE UPDATE` — so patching `balance_after` afterwards is **impossible**, and must not be attempted.

**Corrected three-statement sequence, per `(stock_item, location)`:**

```sql
-- 1. ATOMIC ADDITIVE PROJECTION — does NOT touch the last_movement columns.
INSERT INTO inventory.stock_levels
  (tenant_id, stock_item_id, location_id, quantity_on_hand)
VALUES ($1, $2, $3, $4::numeric)                 -- $4 = signed delta (negative)
ON CONFLICT (stock_item_id, location_id) DO UPDATE
   SET quantity_on_hand = inventory.stock_levels.quantity_on_hand
                        + EXCLUDED.quantity_on_hand
RETURNING quantity_on_hand;                       -- authoritative post-balance

-- 2. LEDGER INSERT — balance_after = the value returned by (1).
INSERT INTO inventory.stock_movements (..., balance_after, ...) VALUES (...);

-- 3. POINTER UPDATE — now legal, the movement exists.
UPDATE inventory.stock_levels
   SET last_movement_id = $m, last_movement_occurred_at = $t
 WHERE stock_item_id = $2 AND location_id = $3;
```

**Why this satisfies both requirements:**
- **(A) No lost update.** Statement 1 is a single atomic `+=`. `ON CONFLICT DO UPDATE` takes a row lock that is **held until COMMIT**, so a concurrent completion's statement 1 blocks and then re-reads. On first insert the delta *is* the balance, which is correct for a level that did not previously exist.
- **(B) Truthful `balance_after`.** It is the value PostgreSQL returned from the atomic update — not a JS-computed guess. This **repairs** BR-INV-003 rather than racing it, and is a genuine improvement over the current `MovementsService.post`.
- **Statement 3 is race-free**, precisely because statement 1's row lock is still held: no other transaction can interleave between our 1 and 3.
- `average_cost` is **not** written by any of the three — outbound never moves the average, preserving existing governed behaviour.
- **No `stock_movements` UPDATE. No trigger. No deferred constraint. Append-only preserved.**

Scope: this applies to the **new** batch sale-depletion command only. `MovementsService.post` is **not** rewritten (transfers/counts/waste keep their existing path and their pre-existing lost-update defect — §Q).

## I. MOVEMENT COST SIGN (C-7) — **PRESERVED, now proven**

P1F-2A proposed `total_cost = round_half_up(abs(quantity) × unit_cost)` without establishing the repository convention. Audited:

- `costing.ts:159-161`: `export function totalCost(quantity, unitCost) { return BigInt(Math.round(Math.abs(quantity) * Number(unitCost))); }`
- **The convention is test-locked and explicitly named** — `costing.spec.ts:184-186`:
  ```ts
  it('totalCost multiplies on absolute quantity (movements are signed)', () => {
    expect(totalCost(-3, 250n)).toBe(750n);
    expect(totalCost(3, 250n)).toBe(750n);
  });
  ```
- It is applied uniformly through the single writer `MovementsService.post` (`:176`), so **every** movement type — purchase receipt, transfer out/in, waste, count adjustment, production, sale depletion — stores a **positive magnitude**. The sign lives on `quantity`.

**Conclusion: `stock_movements.total_cost` is POSITIVE MAGNITUDE.** This is a deliberate, pre-existing **deviation from the literal SRS §7.4.3** (*“total_cost — quantity × unit_cost”*, which with signed quantity would be negative for outbound). P1F-2 **must not rewrite the ledger convention.**

Consequences, fixed now so Sonnet cannot choose opportunistically:
- `sale_depletion` movements store `quantity` **negative**, `total_cost` **positive magnitude**.
- `sale_depletion_effects.total_cost` stores the same positive magnitude.
- `order_lines.posted_cogs_total` = **direct exact `bigint` sum** of those values — **no sign flip, no `abs()` at the Sales layer**.
- The §7.4.3 deviation is recorded explicitly in the migration header and the report.

## J. FR-CST-002 CLASSIFICATION (C-8) — **CORRECTED to PARTIAL**

The ratified reconciliation stands: never rewrite `unit_cost_snapshot`; add a distinct posted-COGS fact. But P1F-2A then classified FR-CST-002 as *“COMPLETE with documented deviation”*, which the project's classification discipline does not permit — a documented deviation from an **[M]** field-location requirement is not completion.

**Corrected:**
- **FR-CST-001 — may become COMPLETE** after real Completion implementation and verification (COGS *is* computed at completion at current valuation per each item's own method).
- **FR-CST-002 — PARTIAL.** Substantive immutability and the no-retroactive-recomputation prohibition are honoured; the literal required persistence location (*“recorded on the order line as `unit_cost_snapshot`”*) differs under the ratified two-field reconciliation.

“Documented” is not “satisfied”. Both classifications are carried into §P.

## K. ORDER.COMPLETED EVENT VERSION (C-9) — **1, with the SRS example recorded**

The SRS envelope example (§5.5.4) shows `"eventType": "order.completed", "eventVersion": 2`.

**Assessment: illustrative, not normative.** Every sibling field in that same JSON object is a placeholder — `"eventId": "01J8XZ..."`, `"tenantId": "..."`, `"actorId": "..."`, `"correlationId": "..."`, `"causationId": "..."`, `"idempotencyKey": "..."`, `"payload": { }`. The object demonstrates the **envelope shape**; `2` is sample data in a field whose neighbours are all elided. The SRS nowhere states that `order.completed` has a v1 that was superseded, and defines no v1→v2 migration.

**Repository convention is unambiguous and universal:** every event contract starts at 1 — `ORDER_LINE_FIRED_EVENT_VERSION = 1` (`sales/contract/events.ts:70`), `ORDER_OPENED_EVENT_VERSION = 1` (`:175`), `TICKET_BUMPED_EVENT_VERSION = 1` (`kitchen/contract/events.ts:28`). There is no counter-example.

**Decision: `ORDER_COMPLETED_EVENT_VERSION = 1`**, classified **NOT SOURCE-DECIDABLE**, resolved by the smallest existing repository convention. This is recorded in the contract's doc comment so the SRS example is not silently contradicted, and so a future reader can revisit it deliberately rather than by accident.

## L. §5.5.1 / §5.5.2 TRANSACTION SHAPE (C-10) — **direct contracts, and it is REQUIRED, not merely preferred**

Re-evaluated narrowly. P1F-2A called the synchronous shape a “deliberate divergence”; the audit shows it is **forced by the repository's own event contract**.

- **§5.5.1** — *“Used when the caller requires the result to proceed and the operation must be in the same transaction.”* Sales requires the **valued** depletion result to write `posted_cogs_total`. That is §5.5.1's stated criterion, met exactly. **§5.5.1 authorises the synchronous Inventory command cleanly.**
- **Can the result come back through an event handler instead? No.** `DomainEventHandler.handle(event, ctx)` returns `void`; `TransactionalDomainEventDispatcher.drain` discards handler results; and `UnitOfWorkContext` deliberately exposes **only** `{ tx, publishEvent }` (the collector is withheld by the P1E-1C trusted-construction boundary, mechanically enforced by `trusted-construction-boundary.spec.ts`). There is **no return channel** from handler to publisher. Obtaining posted COGS via a subscriber would require inventing a mutable shared context and breaching that boundary.
- **§5.5.2's requirement is ATOMICITY** — *“All four must succeed or all must fail.”* That is fully satisfied: depletion, COGS, Order mutation, audit and any handler all live in one transaction, and a failure anywhere rolls back everything. A handler rejection and a contract rejection are behaviourally identical.
- **Meaning of `order.completed`:** a notification of an **accomplished fact** — the sale is final and its economic consequences are committed — published inside the same transaction so subscribers still get all-or-nothing.
- **Honest classification:** §5.5.2's **atomicity requirement is satisfied**; its **literal subscriber-driven framing is NOT implemented**, because P1F-2 registers **zero** `order.completed` subscribers. This is stated plainly and must not be described as literal §5.5.2 compliance.
- **Valid future subscribers** (per §5.5.4): Analytics, Fiscal, Customer. **Not Kitchen** — Kitchen is absent from the SRS subscriber list and its instructions were produced at Fire.

## M. CORRECTED MIGRATIONS

**Three module-owned migrations, 27 → 30.** Unchanged in count from P1F-2A, but corrected in content (privileges in 28; nothing else moves). No migration edits committed history; no cross-module migration.

### Migration 28 — SALES
| | |
|---|---|
| Owner / order | Sales / first (independent) |
| Why | posted-COGS projection (ratified §3.1.D); SRS §25.2's missing `ck_completed`; sale-time modifier & recipe-version snapshots (ratified §3.2, BR-POS-004) |

1. `ALTER TABLE sales.orders ADD CONSTRAINT ck_completed CHECK (state <> 'completed' OR completed_at IS NOT NULL);` — SRS §25.2 verbatim; safe, no `completed` row exists.
2. `ALTER TABLE sales.order_lines ADD COLUMN posted_cogs_total BIGINT;` + `CHECK (posted_cogs_total IS NULL OR posted_cogs_total >= 0)`. **Nullable ⇒ zero-downtime**, no backfill, no table rewrite.
3. `CREATE TYPE sales."ConsumptionProvenance" AS ENUM ('recipe','modifier_add');`
4. **`sales.order_line_consumption_components`** *(replaces P1F-2A's `order_line_modifier_effects` — see §E)* — the resolved NET base-unit consumption snapshot, and the **authoritative completion input**. Tenant anchor `tenant_id`; `UNIQUE (tenant_id, order_line_id, stock_item_id)`; `quantity_in_base_unit DECIMAL(18,6) NOT NULL CHECK (> 0)`; composite FKs `(tenant_id, order_line_id, business_day) → sales.order_lines(tenant_id, id, business_day)` CASCADE, `(tenant_id, stock_item_id) → inventory.stock_items(tenant_id, id)` RESTRICT, `(tenant_id, order_line_modifier_id) → sales.order_line_modifiers(tenant_id, id)` CASCADE (nullable), `(unit_id) → inventory.uom(id)` RESTRICT; CHECK tying `order_line_modifier_id IS NOT NULL` to `provenance='modifier_add'`; index `(tenant_id, order_line_id, business_day)`; **NOT partitioned**. **Privileges (CORRECTED): `GRANT SELECT, INSERT` only; `REVOKE UPDATE, DELETE, TRUNCATE`; RLS ENABLE+FORCE with SELECT and INSERT policies ONLY.**
5. `sales.order_line_recipe_versions` — `UNIQUE (tenant_id, order_line_id, business_day, recipe_version_id)`; FKs to the order line (CASCADE) and `production.recipe_versions` (RESTRICT); same **corrected append-only** privileges and RLS. Retained as BR-POS-004 / FR-MNU-045 provenance.

*(P1F-2A's `sales.order_line_modifier_effects` and its two snapshot enums are **dropped** — the net result is snapshotted in (4), and applied `REMOVE_ALL` operations are recorded in the line-capture audit entry per the P1C-5 item-7 precedent.)*

### Migration 29 — PRODUCTION
| | |
|---|---|
| Owner / order | Production / second |
| Why | typed modifier recipe effects (ratified §3.2) + the configuration surface (§G) |

1. `CREATE TYPE production."ModifierEffectOperation" AS ENUM ('add','remove_all');`
2. `production.modifier_recipe_effects` — **reuses** the existing `production."RecipeComponentType"` enum; composite tenant-safe FKs to `catalogue.modifiers(tenant_id, id)` **CASCADE**, `inventory.stock_items` RESTRICT, `production.recipes` RESTRICT, `inventory.uom` RESTRICT; XOR + operation CHECKs; index `(tenant_id, modifier_id)`; RLS ENABLE+FORCE with all four policies; `GRANT SELECT, INSERT, UPDATE, DELETE` — **this one IS editable master data** (§G's replace route), unlike the Sales snapshots.
3. `catalogue.modifiers.recipe_delta` untouched — still opaque, nothing migrated out of it.

### Migration 30 — INVENTORY
| | |
|---|---|
| Owner / order | Inventory / third |
| Why | resolves B-3 — the business idempotency/provenance boundary (ratified §3.4) |

1. `inventory.sale_depletion_effects` — **NON-partitioned**; `UNIQUE (tenant_id, order_line_id, stock_item_id, location_id)`; composite FKs `(tenant_id, order_id, order_line_id, business_day) → sales.order_lines(tenant_id, order_id, id, business_day)` RESTRICT, `(tenant_id, movement_id, movement_occurred_at) → inventory.stock_movements(tenant_id, id, occurred_at)` RESTRICT, plus stock_items / org.locations / uom composite FKs.
2. RLS ENABLE+FORCE, **SELECT and INSERT policies only**.
3. `GRANT SELECT, INSERT`; `REVOKE UPDATE, DELETE, TRUNCATE`. Append-only.
4. **No change to `inventory.stock_movements`** — no column, no constraint, no partition work.

## N. CORRECTED OPENAPI COUNT

Baseline independently verified: **3.1.0, 133 operations across 95 paths** (counting HTTP-verb keys per path item — the same method `test/openapi.e2e-spec.ts:96` uses). Production contributes 10; Catalogue 38.

**Corrected expectation: 134.**

| Change | Δ |
|---|---|
| `PUT /modifiers/{modifierId}/recipe-effects` (Production, `recipe.edit`) — §G | **+1** |
| Completion reuses `POST /orders/{businessDay}/{id}/payments` — no new route | 0 |
| No `/complete` route, no new Payment route, no `pos.order.complete` | 0 |

P1F-2A's “133 unchanged” was **wrong** — it presumed a configuration surface that does not exist. If a companion `GET .../recipe-effects` read route were added it would be 135; **recommended: omit it**, since the `PUT` returns the full effect set, matching the `replaceLines` precedent.

## O. SECURITY / RLS

- **No new permission code.** `pos.payment.capture` (P1D-F) for completion; `recipe.edit` (SRS §15.2, existing) for modifier-effect configuration. D-17-06's zero-invented-codes discipline is intact.
- **Every new table is tenant-anchored** with `tenant_id`, composite tenant-safe FKs (ADR 0008 D-09 / D-17-02), and RLS `ENABLE` + `FORCE`.
- **Two append-only tables in Sales** (`order_line_consumption_components`, `order_line_recipe_versions`) and **one in Inventory** (`sale_depletion_effects`): `SELECT`+`INSERT` grants only, `UPDATE`/`DELETE`/`TRUNCATE` revoked, and **no UPDATE or DELETE policy defined** — the `order_payments` / `audit_entries` / `stock_movements` pattern. The cascade limit of §F applies and is documented rather than hidden.
- **One editable master table in Production** (`modifier_recipe_effects`): full DML with all four policies, which is correct for configuration data behind `recipe.edit`.
- **Completion adds no new interactive authorization surface** — it is a system consequence of an authorised Payment (ratified §3.6, mirroring the Fire Authorization Ratification's point 6).
- RLS proofs must use the real non-bypass `ros_app` connection (`app.get(PrismaService)`), never the migrator client, and must include cross-tenant negative controls plus positive controls.

## P. REQUIREMENT CLASSIFICATION

Post-P1F-2 expectations, corrected.

| Requirement | CURRENT | POST-P1F-2 |
|---|---|---|
| §1.2 completed-sale atomicity | NOT IMPLEMENTED | **PARTIAL** — effects 1–8 satisfied; **effect 9 unreachable** (no linked-customer path) |
| UC-POS-01 (whole use case) | NOT IMPLEMENTED | **PARTIAL** — steps 11–13 satisfied; **14 (fiscal receipt / outbox) and 15 (table release) absent** |
| **FR-CST-001** | NOT IMPLEMENTED | **COMPLETE** (after verification) |
| **FR-CST-002** | PARTIAL | **PARTIAL** — *corrected from P1F-2A*; literal persistence location differs under the ratified reconciliation (§J) |
| BR-POS-001 / BR-POS-002 | DESIGNED ONLY | **COMPLETE** |
| BR-POS-004 | COMPLETE (1 level) | **COMPLETE** — strengthened by recipe-version closure pinning |
| **FR-POS-024** | NOT IMPLEMENTED | **COMPLETE** — *only because* §G adds a real configuration surface |
| FR-POS-007 | PARTIAL | **PARTIAL** (`closed_by` added; `served_by` still unwritten) |
| FR-POS-050 (comps) | NOT IMPLEMENTED | **NOT IMPLEMENTED** — no comp mechanism exists |
| FR-INV-002 / 003 | COMPLETE / PARTIAL | unchanged |
| **FR-INV-004** | NOT IMPLEMENTED | **PARTIAL** — rejection semantics honoured at capture and completion (§D); density-configured conversion itself remains unexercised |
| FR-INV-010 / FR-INV-014 | COMPLETE | **COMPLETE** |
| FR-INV-030 | PARTIAL (no sale writer) | **COMPLETE** for sales |
| BR-INV-001 | COMPLETE | **COMPLETE** |
| **BR-INV-003** | PARTIAL / at risk | **COMPLETE for the completion path** (`balance_after` now derives from the atomic result); **still at risk for transfers/counts/waste** (§Q) |
| FR-MNU-013 | NOT IMPLEMENTED | **PARTIAL** — `ADD`/`REMOVE_ALL` only |
| FR-MNU-045 | PARTIAL | **COMPLETE** — becomes demonstrable |
| BR-MNU-012 | COMPLETE | **COMPLETE** |
| FR-AUD-001 | PARTIAL | **COMPLETE** for completion |
| **NFR-PERF-006** | NOT IMPLEMENTED | **PARTIAL until MEASURED** |
| Fiscal / Receipt / Table release / CRM / Outbox | NOT IMPLEMENTED | **NOT IMPLEMENTED** |

**§1.2 and UC-POS-01 are explicitly NOT claimed COMPLETE.**

## Q. REMAINING RISKS

1. **C-1 is an open blocker** (§C) — the only one gating implementation.
2. **`MovementsService.post` keeps its lost-update pattern** for transfers, counts and waste. P1F-2 fixes only the completion path. Recommend a separate narrow Inventory slice.
3. **UoM/conversion immutability is de facto, not structural** — `ros_app` holds full DML on `uom`/`uom_conversions`, with **no RLS at all** on either table, though no writer exists (§E). A future Inventory slice should revoke write access or version the factors; today the only protection is that no controller has been written.
3a. **`StockItem.baseUnitId` is mutable in a reachable window** (§E) — its FR-INV-002 guard is application-only, unlocked, and vacuous until sales start writing movements. The §E snapshot closes the consequence for completion; the guard itself remains weaker than FR-INV-002's *"structurally impossible, not merely discouraged"* rationale demands.
3b. **BR-CORE-004 / FR-INV-004 dimension checking is NOT implemented** — `Uom.dimension` is never read; mass↔volume safety is incidental (§D).
3c. **Sale-time snapshots are not indelible against a parent cascade** (§F) — child-level REVOKE blocks direct deletes but not a cascade from a deletable `sales.orders`. Pre-existing and equally true of `order_payments`; a Sales-wide hardening decision, out of P1F-2 scope.
4. **`uom_conversions` is not RLS-scoped** while carrying item-specific density rows — pre-existing ambiguity #2 in the Inventory design gate.
5. **`stock_movements` partition horizon ends 2027-09**, no DEFAULT partition, manual per-partition RLS. Completion will be the highest-volume writer. Operational must-fix before production.
6. **Float arithmetic persists in `costing.ts`** helpers used by other callers; the completion path must use exact `Decimal`/`bigint`/`Rational`. Two valuation code paths will coexist — require an equivalence test.
7. **`total_cost` positive-magnitude deviates from literal SRS §7.4.3** (§I) — pre-existing, test-locked, deliberately not rewritten.
8. **`order.completed` has zero subscribers** in P1F-2 (§L) — atomicity satisfied, literal subscriber framing not implemented.
9. **`Modifier.kind` ↔ effects consistency is service-validated only** — `kind` is nullable for legacy rows and a cross-row CHECK is not expressible.
10. **`catalogue.modifiers.recipe_delta` remains dead** — its schema comment (“Production Spec is NOT implemented”) is **stale** at this HEAD and should be corrected to point at `production.modifier_recipe_effects`.
11. **`MODIFIER_UPDATED` audit constant is declared and unused** — evidence the modifier-mutation surface was anticipated and never built.

## R. IMPLEMENTATION READINESS

Can Sonnet implement P1F-2 without inventing FIFO zero-layer valuation, missing-conversion semantics, historical UoM semantics, snapshot mutability, the modifier configuration API, stock-level/movement write ordering, the `total_cost` sign, the event version, or cross-module transaction semantics?

| Item | Status |
|---|---|
| FIFO zero-layer valuation | **NOT SOURCE-DECIDABLE — BLOCKER (§C)** |
| Missing-conversion semantics | Resolved (§D) — fail closed, not silent zero; structurally unreachable at completion |
| Historical UoM semantics | Resolved (§E) — **corrected**: `baseUnitId` is mutable in a reachable window, so resolved base-unit quantities are snapshotted at capture |
| Snapshot mutability | Resolved (§F) — append-only, SELECT+INSERT only, with the cascade limit documented |
| Modifier configuration API | Resolved (§G) — new Production `PUT`, `recipe.edit`, → 134 |
| Stock-level / movement write ordering | Resolved (§H) — three-statement sequence; P1F-2A's order was FK-illegal |
| `total_cost` sign | Resolved (§I) — positive magnitude, proven by test |
| Event version | Resolved (§K) — `1`, convention-based, documented |
| Cross-module transaction semantics | Resolved (§L) — §5.5.1 authorises; UoW contract forbids the alternative |

Nine of nine engineering questions are settled. The tenth is a **product/governance decision about money** that affects mandatory Completion correctness (`stock_movements.unit_cost` is `NOT NULL`, so *every* sale depletion must produce a cost, and posted COGS is defined as the sum of those costs). It cannot be resolved by engineering judgement without inventing financial semantics.

# **BLOCKED — FIFO ZERO-LAYER VALUATION NOT SOURCE-DECIDABLE**

One decision (§C, options A/B/C, recommendation **A**) unblocks the slice. Everything else in this gate is implementation-ready and can be reused verbatim.

## S. REPLACEMENT SONNET PROMPT

# **NOT GENERATED — IMPLEMENTATION BLOCKED**

No speculative implementation instructions are produced. Once the §C decision is ratified as a narrow amendment (no D-21), this gate can be reopened and §S generated against it, reusing §D–§Q unchanged.
