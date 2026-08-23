# Production Spec — Design Gate

**Document status: CLOSED / RATIFIED**
**Date: 2026-08-16**
**Baseline: HEAD `48a16f9`, 13 migrations applied, no drift, no `production` schema**

This document is the frozen design for the Production Spec bounded context. It
records decisions; it does not implement them. No migration, Prisma model,
service, controller, endpoint, or test was created by this gate.

---

## 1. Status

| Item | State |
|---|---|
| Production Spec **design** | **AUTHORIZED — this gate is closed** |
| Production Spec **implementation** | **NOT STARTED** — requires separate authorization |
| D-17-01 … D-17-07 | RATIFIED, immutable |
| D-17-08 | RATIFIED (Q1=A, Q2=A, Q3/Q4/Q5 N/A) |
| GAP-1 (recipe-creation surface) | **CLOSED / RATIFIED — Option A** |
| GAP-2 (published-version immutability) | **CLOSED / RATIFIED — CONFIRMED** |
| Open questions | **ZERO** |

Prerequisite phases: Organisation (Phase 15) CLOSED, Catalogue (Phase 16)
CLOSED, Inventory CLOSED and ratified. D-17-01 ("Inventory first") is satisfied.

---

## 2. Source Inventory

Every source below was actually inspected during this gate.

### SRS — `ROS_SRS_v1.0.pdf`
- §7.4.2 OrderLine Entity — BR-POS-004
- §7.4.3 StockMovement Entity — append-only precedent
- §7.4.4 Recipe Aggregate — attribute tables for `recipes`, `recipe_versions`, `recipe_lines`
- §10.1 FR-MNU-003 — priority resolution and ambiguity warning
- §10.4 FR-MNU-020 … FR-MNU-026 — pricing effective-dating (contrast case)
- §10.6 FR-MNU-040 … FR-MNU-050, BR-MNU-012 — Recipe Management
- BR-MNU-001, BR-MNU-002, BR-MNU-003
- §6 FR-PLT-003, FR-PLT-025 … FR-PLT-028; event catalogue (`recipe.version.published`)
- §15.2 permission catalogue — `recipe.view`, `recipe.edit`, `recipe.publish`
- §17.5 FR-BRN-020 … FR-BRN-025 — Central Kitchen
- §19 FR-LOC-021; §21.3 local data model; FR-OFF-003, FR-OFF-041 … FR-OFF-044
- §25.1–25.5 — schema organisation, representative DDL, indexing, migration strategy
- §26.2 error semantics (404 on cross-tenant); §26.3 Representative Endpoints

### Approved SQL — `ROS_DrawDB_Compatible_v3.sql`
- L441–494 `production.recipes`, `production.recipe_versions`, `production.recipe_lines`,
  `production.substitute_groups`, `production.substitute_group_members`
- L368 `catalogue.modifiers.recipe_delta`
- L893–900 `sales.order_lines.recipe_version_id`, `unit_cost_snapshot`
- L1381–1390 `ck.production_orders.recipe_version_id`
- L1007–1015 `workforce.employment_terms`; L1255–1262 `fiscal.tax_rules` (effective-period contrast)

### ADRs
- ADR 0001 … ADR 0008, all read
- In depth: **ADR 0003** (roles, `withAuthContext`, policy shape, excluded tables),
  **ADR 0007** (append-only pattern), **ADR 0008 D-09** (composite tenant-safe FKs, full text)

### Phase documentation
- `docs/inventory/INVENTORY_DESIGN_GATE.md` (§26, §26.1, §28, §29)
- `docs/inventory/INVENTORY_PHASE_CLOSEOUT.md`
- `docs/catalogue/README.md`, `docs/catalogue/PHASE_16_DISCOVERY.md`, `PHASE_16_PLAN.md`

> **No Phase 17 document exists in the repository.** D-17-01 … D-17-08 were
> ratified in session only. §4 of this gate transcribes them so they survive.

### Implementation inspected (read-only, for boundaries and conventions)
- `prisma/schema.prisma`
- `src/modules/catalogue/menus/menus.service.ts:274` (`resolveForBranch`)
- `src/modules/inventory/costing.ts`, `src/modules/inventory/inventory.permissions.ts`
- `src/modules/governance/audit/audit.constants.ts`
- `prisma/migrations/20260816210000_inventory_foundation/migration.sql`
- `test/` conventions — `rls-admin.ts`, the `*-rls.e2e-spec.ts` pairing

### Live database verification (read-only)
- `(tenant_id, id)` unique present on `org.brands`, `org.branches`,
  `catalogue.menu_item_variants`, `inventory.stock_items` — every composite FK
  target this design needs already exists
- `inventory.uom` has **no `tenant_id`** — global reference data, un-RLS'd
- `tenant_id` placement surveyed across all 29 catalogue/inventory tables
- Canonical policy predicate and `identity.users` FK convention captured verbatim
- **Partial unique index probe:** a partial unique index was created on an
  existing table, `prisma migrate diff` reported **"No difference detected"**,
  and the index was dropped and verified gone. This proves the D-17-08 partial
  unique index will not produce Prisma drift.

---

## 3. Requirements Matrix

| Requirement | Source | Implementation status | Phase disposition |
|---|---|---|---|
| FR-MNU-040 [M] recipes for variants, sub-recipes, production items | §10.6 | Designed | **INCLUDED** — `recipe_type` |
| FR-MNU-041 [M] components are stock items or sub-recipes, with qty + unit | §10.6 | Designed | **INCLUDED** — typed nullable + XOR (D-17-02) |
| FR-MNU-042 [M] reject circular sub-recipes, display full cycle path | §10.6 | Designed | **INCLUDED** — service (see §11) |
| FR-MNU-043 [M] yield quantity + yield percentage | §10.6 | Designed | **INCLUDED** |
| FR-MNU-044 [M] per-component wastage percentage | §10.6 | Designed | **INCLUDED** |
| FR-MNU-045 [M] versioning; publish supersedes, does not delete | §10.6 | Designed | **INCLUDED** (versioning + supersession) |
| FR-MNU-045 [M] completed orders retain version in force at sale | §10.6 | Not owned here | **EXCLUDED** — Sales obligation |
| FR-MNU-046 [M] automatic cost recomputation, cascading | §10.6 | Not implemented | **DEFERRED** — D-17-05 |
| FR-MNU-047 [S] branch variant recipe | §10.6 | Designed | **INCLUDED** via `scope` (D-17-03) |
| FR-MNU-047 [S] deviation compliance report | §10.6 | Not implemented | **EXCLUDED** — reporting surface unscoped |
| FR-MNU-048 [S] recipe scaling | §10.6 | Not implemented | **EXCLUDED** |
| FR-MNU-049 [S] localised instructions + reference images | §10.6 | Designed | **INCLUDED** — JSONB, stored |
| FR-MNU-050 [C] nutritional aggregation | §10.6 | Not implemented | **EXCLUDED** |
| BR-MNU-001 no self-reference, cycle detection on save with path | §7.4.4 | Designed | **INCLUDED** — service |
| BR-MNU-002 publishing must not alter completed orders | §7.4.4 | Designed | **INCLUDED** as immutability (D-17-04); order side is Sales |
| BR-MNU-003 recipe cost formula, depth limit 10 | §7.4.4 | Not implemented | **DEFERRED** — D-17-05 |
| BR-MNU-012 sale permitted with absent/incomplete recipe | §10.6 | Not applicable | **EXCLUDED** — Sales unimplemented |
| BR-POS-004 snapshot `recipe_version_id` at sale | §7.4.2 | Not owned here | **EXCLUDED** — Sales |
| FR-BRN-021…025 production orders, yield variance | §17.5 [S] | Not implemented | **EXCLUDED** — Central Kitchen |
| FR-MNU-013 [S] `modifiers.recipe_delta` semantics | §10.3 | Not implemented | **DEFERRED** — D-17-07 |
| FR-PLT-003 [M] immutable `tenant_id`, non-transferable records | §6 | Designed | **INCLUDED** — RLS + composite FKs |
| FR-PLT-010/012/013 RLS both clauses, fail closed, isolation suite | §6 | Designed | **INCLUDED** — §9, §18 |
| §15.2 `recipe.view` / `recipe.edit` / `recipe.publish` | §15.2 | Designed | **INCLUDED** — exactly three (D-17-06) |
| §6 event `recipe.version.published` | §6 | Not implemented | **EXCLUDED** — no event infrastructure exists (§16) |
| §21.3 offline recipe distribution | §21.3 | Not implemented | **EXCLUDED** |

---

## 4. Binding Decisions (transcribed — do not reinterpret)

| ID | Decision |
|---|---|
| **D-17-01** | Inventory first. Satisfied — Inventory is CLOSED and ratified. |
| **D-17-02** | Polymorphic references use typed nullable columns + real composite FKs to tenant-scoped targets + XOR CHECK. Service validation may supplement but MUST NOT be the sole tenant guarantee. Follows ADR 0008 D-09. |
| **D-17-03** | Recipe scope = `tenant` \| `brand` \| `branch`; `scope_id` required for brand and branch. Precedence **branch > brand > tenant**, documented as analogy-derived from FR-PLT-025, **not** a recipe-specific SRS requirement. No additional scope levels. |
| **D-17-04** | Published recipe versions immutable at database level. Lifecycle `draft → published → superseded`. `archived` unimplemented. Enforcement mirrors the `governance.audit_entries` pattern **where technically applicable**. |
| **D-17-05** | Costing deferred. `computed_cost` / `cost_computed_at` may exist but remain unpopulated. FR-MNU-046 / BR-MNU-003 not implemented. — **NARROWLY AMENDED 2026-08-20; original text above is preserved verbatim. See §4.1.** |
| **D-17-06** | Exactly `recipe.view`, `recipe.edit`, `recipe.publish`. No additional codes. |
| **D-17-07** | `modifiers.recipe_delta` remains opaque. No component-resolution, operation-identifier, or substitution semantics. FR-MNU-013 deferred. |
| **D-17-08** | Max one `published` version per recipe; partial unique index required; `effective_from` **informational only**; no temporal resolution; Q3/Q4/Q5 not applicable; the published version is selected by lifecycle state **after** applying D-17-03 scope precedence. |
| **GAP-1** | **CLOSED / RATIFIED — Option A.** `POST /v1/recipes` authorized as a documented API deviation. No auto-creation from version creation. No invented auto-create key or uniqueness rule. `recipe.edit` governs it. |
| **GAP-2** | **CLOSED / RATIFIED — CONFIRMED.** Column-level `UPDATE (status)` grant + status-predicated RLS on children. No triggers. No blanket `REVOKE UPDATE`. |


### 4.1 D-17-05 AMENDMENT (2026-08-20) — NARROW REOPEN

> **REOPENED BY EXPLICIT USER GOVERNANCE ACTION, and only as far as the active
> Sales critical path requires.** The original D-17-05 text is preserved verbatim
> in the table above and is **not deleted**. **No new numbered decision; no D-21;
> the decision tally is unchanged.** D-17-01 … D-17-04 and D-17-06 … D-17-08,
> GAP-1 and GAP-2 are untouched.

**Why reopened.** BR-POS-004 requires `unit_cost_snapshot` on every OrderLine at
sale time and forbids recomputing it later. With costing deferred wholesale,
`recipe_versions.computed_cost` was provably never written, so Sales line capture
could only have fabricated a zero. BR-MNU-012 permits zero cost **only** for an
incomplete or absent recipe; it has never permitted a fabricated zero for a
complete one. The defer had therefore become the sole blocker on a mandatory
sale-time snapshot.

**The defer is lifted ONLY for:**

- **FR-MNU-046** — recipe-cost recomputation on component valuation change,
  cascading through dependent sub-recipes and parent recipes.
- **BR-MNU-003** — the recipe-cost formula, including wastage, yield, recursive
  sub-recipe expansion and the depth-10 limit.
- **FR-CST-001 / FR-CST-002** — only so far as obtaining a truthful unit cost and
  persisting it as a sale-time snapshot requires.
- **BR-POS-004** — `unit_cost_snapshot` at line capture.

**Still deferred, and NOT authorised by this amendment:**

- theoretical-vs-actual analysis;
- menu-engineering and profitability analytics;
- contribution-margin reporting (FR-CST-005);
- cost-variance dashboards;
- the wider FR-CST reporting surface;
- the completion-time COGS posting workflow;
- any analytics not required to produce a truthful sale snapshot.

**This is NOT permission to implement the Costing bounded context.**

**Binding constraints on the implementation:**

1. **Every component is valued by ITS OWN configured costing method** —
   `inventory.stock_items.costing_method` ∈ `fifo | weighted_average | standard`
   (FR-INV-001). There is **no global default**, no fallback from one method to
   another, and no "latest purchase cost" standing in for FIFO.
2. **BR-MNU-012 is preserved exactly.** An incomplete or absent recipe may yield
   zero or partial cost. A **complete** recipe whose component valuation is
   unavailable **fails**; it does not silently become zero.
3. Arithmetic is exact. No floating point enters a cost result.
4. Recomputation hooks the **actual valuation mutation boundary**, not a
   scheduler — the SRS says "when component costs change", and §20 of this gate
   still excludes schedulers, jobs and message brokers.

---

## 5. Recipe Identity

`production.recipes` is the **logical recipe identity, stable across versions**
(§7.4.4; approved SQL L442 comment).

| Column | Source | Design |
|---|---|---|
| `id` | §7.4.4 | ULID-as-UUID via `newId()` |
| `tenant_id` | §7.4.4 | NOT NULL, FK `identity.tenants(id)`, RLS anchor |
| `scope` | §7.4.4 | `tenant` \| `brand` \| `branch` (D-17-03) |
| `scope_id` | §7.4.4 | Decomposed — see below |
| `recipe_type` | §7.4.4 | `menu_item` \| `sub_recipe` \| `production_item` |
| `target_id` | §7.4.4 | Decomposed — see below |
| `created_at` | approved SQL | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

**D-17-02 decomposition of `scope_id`** — typed nullable columns, composite FKs,
XOR CHECK tied to `scope`:

- `brand_id` → `org.brands (tenant_id, id)`
- `branch_id` → `org.branches (tenant_id, id)`
- `ck_recipe_scope`: `scope='tenant'` ⇒ both NULL; `scope='brand'` ⇒ exactly
  `brand_id`; `scope='branch'` ⇒ exactly `branch_id`

**D-17-02 decomposition of `target_id`** — §7.4.4 defines it as "MenuItemVariant
or StockItem produced":

- `menu_item_variant_id` → `catalogue.menu_item_variants (tenant_id, id)`
- `stock_item_id` → `inventory.stock_items (tenant_id, id)`
- `ck_recipe_target`: `recipe_type='menu_item'` ⇒ exactly `menu_item_variant_id`;
  `recipe_type IN ('sub_recipe','production_item')` ⇒ exactly `stock_item_id`

Mapping evidence: FR-MNU-040 names the three kinds; a sub-recipe is a prep item
and a production item is central-kitchen output, both of which are stock
(FR-BRN-023 "produce output stock").

**All four composite targets already carry `(tenant_id, id)`** — verified live.
No prerequisite work in Organisation, Catalogue, or Inventory is required.

**`scope_id` retention.** The original bare `scope_id` column is **not** retained;
the typed columns replace it, exactly as ADR 0008 D-09 and Inventory's
`org.locations` precedent handled polymorphism.

---

## 6. Version Model

`production.recipe_versions`.

| Column | Source | Design |
|---|---|---|
| `id` | approved SQL | ULID-as-UUID |
| `tenant_id` | **RATIFIED-DESIGN** | Added for the D-09 composite FK and a direct RLS anchor |
| `recipe_id` | approved SQL | Composite FK `(tenant_id, recipe_id)` → `production.recipes (tenant_id, id)` |
| `version` | §7.4.4 "Incremented on publish" | `INTEGER NOT NULL`; see derivation below |
| `status` | §7.4.4 | `draft` \| `published` \| `superseded`. `archived` **not implemented** (D-17-04) |
| `yield_quantity` | §7.4.4, FR-MNU-043 | `NUMERIC(18,6) NOT NULL CHECK (> 0)` |
| `yield_unit_id` | approved SQL | `NOT NULL` FK → `inventory.uom(id)`, single-column (see §10) |
| `yield_percentage` | FR-MNU-043 | `NUMERIC(5,2) NOT NULL DEFAULT 100.00` |
| `prep_time_seconds` | §7.4.4 "Used for KDS timing" | `INTEGER` nullable |
| `computed_cost` | §7.4.4 | Present, **never written** (D-17-05) |
| `cost_computed_at` | §7.4.4 | Present, **never written** (D-17-05) |
| `effective_from` | §7.4.4 | `TIMESTAMPTZ` nullable, **INFORMATIONAL ONLY** (D-17-08 Q2) |
| `published_by` | §7.4.4 | FK → `identity.users(id)`, single-column — matches `stock_movements.performed_by`, `waste_records.recorded_by` |
| `instructions` | FR-MNU-049 | `JSONB`, localised, stored only |
| `reference_images` | FR-MNU-049 | `JSONB`, stored only |
| `created_at` | approved SQL | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

**Explicitly absent, and never to be added:** `effective_to`, `published_at`,
`priority`, `updated_at`.

**`version` assignment — a forced derivation, not a new decision.** `version` is
`NOT NULL` and `uq_recipe_version UNIQUE (recipe_id, version)` applies to drafts
as well as published rows, so a value must exist at draft-insert time. §7.4.4's
note "Incremented on publish" describes the intent that each publication yields a
new version number; it cannot mean the column is populated at publish, because
the row cannot be inserted without it. Design: at draft creation, `version =
max(version) + 1` for that `recipe_id`, or `1` if none exists. Concurrent draft
creation may collide; `uq_recipe_version` rejects the loser, which is the
correct and intended outcome — the constraint, not the service, is the guarantee.

---

## 7. Version Lifecycle

```
draft ──publish──▶ published ──(next publish)──▶ superseded
```

**Permitted transitions.** `draft → published`; `published → superseded`.
**Forbidden transitions.** Everything else, including `superseded → published`,
`published → draft`, `superseded → draft`, and any transition into or out of
`archived`. `archived` is not implemented (D-17-04) — the token appears in the
SRS only inside the §7.4.4 enum listing, with no defined semantics anywhere.

**Publish behaviour (single transaction).**
1. Load the target version; require `status = 'draft'`.
2. Transition the currently-published version of the same `recipe_id`, if any, to
   `superseded`.
3. Transition the target version to `published`, setting `published_by`.
4. Record an audit entry.

> **Ordering is mandatory.** Step 2 must precede step 3. The partial unique index
> is not deferrable, so setting the new version to `published` before demoting the
> old one raises a unique violation.

**Supersession** is an effect of publishing (FR-MNU-045: "Publishing a new
version SHALL supersede but not delete the prior version"). It is never an effect
of a date. `effective_from` is not read at any point in this flow.

**Deletion.** No version is ever deleted. Drafts may be deleted; published and
superseded rows may not (enforced by RLS DELETE policy, §9).

### Database enforcement (GAP-2, RATIFIED)

ADR 0007's blanket `REVOKE UPDATE, DELETE` cannot be applied: lifecycle
transitions require `UPDATE`. This is precisely D-17-04's "where technically
applicable" clause. The ratified mechanism, composed from existing ADR 0003 and
ADR 0007 patterns and using **no triggers**:

| Control | Effect |
|---|---|
| `REVOKE UPDATE ON production.recipe_versions FROM ros_app` then `GRANT UPDATE (status) ON production.recipe_versions TO ros_app` | `ros_app` can change **only** `status`, on any row. Yield, units, instructions, images, `effective_from`, `computed_cost` become structurally unwritable after insert. |
| Partial unique index `(recipe_id) WHERE status = 'published'` | At most one published version per recipe (D-17-08 Q1). |
| RLS UPDATE/DELETE policies on `production.recipe_lines` predicated on the parent version's `status = 'draft'` | A published or superseded version's lines cannot be modified or deleted. |
| RLS DELETE policy on `production.recipe_versions` predicated on `status = 'draft'` | Published and superseded versions cannot be deleted. |
| RLS INSERT policy on `production.recipe_lines` predicated on the parent's `status = 'draft'` | Lines cannot be added to a published version. |

Consequences deliberately accepted:
- A future costing phase cannot write `computed_cost` without an explicit grant
  change. That is the intended friction — D-17-05 defers costing.
- Prisma's `update()` issues `UPDATE … SET status = $1 … RETURNING *`; `RETURNING`
  requires only `SELECT`, which is granted. `recipe_versions` has no `updated_at`,
  so Prisma will not attempt to write a second column.

---

## 8. D-17-08 Version Selection (RATIFIED)

The binding rule, in full:

1. Determine the applicable recipe identity using D-17-03 scope precedence:
   **branch > brand > tenant**.
2. Within that recipe identity, select the **unique version with
   `status = 'published'`**.
3. **`effective_from` is informational and MUST NOT be evaluated.**

**No temporal resolver exists and none will be written.** There is no
effective-date comparison, no reference-instant selection, no timezone rule, no
device-clock handling, no scheduler, and no offline effective-date logic anywhere
in Production Spec.

Uniqueness in step 2 is guaranteed structurally by the partial unique index, not
by application logic. Because at most one published version can exist, tie
resolution (Q4) and overlapping effective periods (Q5) are **not applicable**.

If no published version exists for the resolved scope, the result is **no
recipe** — not an error and not a fallback to a superseded or draft version.
Downstream handling of that state is Sales' concern under BR-MNU-012 and is out
of scope here.

**Implementation obligation:** `effective_from` must appear in zero code paths
other than storage and read-back. This is grep-assertable and is listed in §22.

---

## 9. Tenant Isolation

Follows ADR 0003 and ADR 0008 D-09 exactly. No new security architecture.

**`tenant_id` placement.** All five tables carry a direct `tenant_id`:

| Table | `tenant_id` | Justification |
|---|---|---|
| `recipes` | approved SQL | Aggregate root |
| `recipe_versions` | **RATIFIED-DESIGN addition** | Needed for the composite FK to `recipes` and a direct RLS anchor |
| `recipe_lines` | **RATIFIED-DESIGN addition** | D-17-02 mandates composite FKs to `inventory.stock_items` and `production.recipes`; a composite FK requires the child to carry `tenant_id` |
| `substitute_groups` | approved SQL | Already tenant-scoped |
| `substitute_group_members` | **RATIFIED-DESIGN addition** | Composite FK to `inventory.stock_items` |

Precedent for adding `tenant_id` to a child: Inventory's `stock_levels`
(D-INV-09), `stock_level_batch_allocations`, `stock_item_reorder_configs`. The
alternative — the `waste_lines` inheritance pattern with single-column FKs — is
**rejected here** because it leaves the cross-tenant component edge representable,
which D-17-02 forbids.

**RLS.** `ENABLE` + `FORCE` on all five tables, four policies each (20 total),
predicate exactly as used everywhere else in the project:

```
tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
```

`SELECT`/`DELETE` use `USING`; `INSERT` uses `WITH CHECK`; `UPDATE` uses both.
Missing context ⇒ `NULL` ⇒ fail-closed. `recipe_lines` policies additionally
carry the `status = 'draft'` parent predicate on `INSERT`/`UPDATE`/`DELETE`
(§7), following the `waste_lines` `EXISTS(parent)` shape extended with a status
condition.

**Composite tenant-safe FKs.** Every tenant-scoped reference is composite:

| Edge | Target |
|---|---|
| `recipes (tenant_id, brand_id)` | `org.brands (tenant_id, id)` |
| `recipes (tenant_id, branch_id)` | `org.branches (tenant_id, id)` |
| `recipes (tenant_id, menu_item_variant_id)` | `catalogue.menu_item_variants (tenant_id, id)` |
| `recipes (tenant_id, stock_item_id)` | `inventory.stock_items (tenant_id, id)` |
| `recipe_versions (tenant_id, recipe_id)` | `production.recipes (tenant_id, id)` |
| `recipe_lines (tenant_id, recipe_version_id)` | `production.recipe_versions (tenant_id, id)` |
| `recipe_lines (tenant_id, stock_item_id)` | `inventory.stock_items (tenant_id, id)` |
| `recipe_lines (tenant_id, sub_recipe_id)` | `production.recipes (tenant_id, id)` |
| `recipe_lines (tenant_id, substitute_group_id)` | `production.substitute_groups (tenant_id, id)` |
| `substitute_group_members (tenant_id, substitute_group_id)` | `production.substitute_groups (tenant_id, id)` |
| `substitute_group_members (tenant_id, stock_item_id)` | `inventory.stock_items (tenant_id, id)` |

Requires `UNIQUE (tenant_id, id)` on `production.recipes`,
`production.recipe_versions`, and `production.substitute_groups`.

**Non-tenant-scoped references (single-column, by design):**
- `yield_unit_id`, `unit_id` → `inventory.uom(id)` — `uom` is **global platform
  reference data with no `tenant_id`** and is deliberately un-RLS'd (verified
  live). A composite FK is neither possible nor meaningful.
- `published_by` → `identity.users(id)` — users are global; tenancy is expressed
  through membership. Matches `stock_movements.performed_by`.

**Cross-tenant attack cases, all structurally blocked:**

| Attack | Blocked by |
|---|---|
| Scope a recipe to another tenant's brand/branch | Composite FK on `(tenant_id, brand_id)` / `(tenant_id, branch_id)` |
| Target another tenant's menu item variant | Composite FK on `(tenant_id, menu_item_variant_id)` |
| Target or consume another tenant's stock item | Composite FK on `(tenant_id, stock_item_id)` |
| Attach a line to another tenant's version | Composite FK on `(tenant_id, recipe_version_id)` |
| Reference another tenant's recipe as a sub-recipe | Composite FK on `(tenant_id, sub_recipe_id)` |
| Add another tenant's stock item to a substitute group | Composite FK on `(tenant_id, stock_item_id)` |
| Read/modify another tenant's recipes | RLS `FORCE`, fail-closed |
| Modify a published version's content | Column-level grant + status-predicated RLS (§7) |

---

## 10. Recipe Lines

`production.recipe_lines`.

| Column | Source | Design |
|---|---|---|
| `id` | approved SQL | ULID-as-UUID |
| `tenant_id` | **RATIFIED-DESIGN** | See §9 |
| `recipe_version_id` | approved SQL | Composite FK; `ON DELETE CASCADE` per approved SQL |
| `sequence` | §7.4.4 | `SMALLINT NOT NULL` |
| `component_type` | §7.4.4 | `stock_item` \| `sub_recipe` |
| `stock_item_id` / `sub_recipe_id` | D-17-02 decomposition of `component_id` | Typed nullable + composite FKs + XOR |
| `quantity` | §7.4.4 "Per recipe yield, not per portion" | `NUMERIC(18,6) NOT NULL` |
| `unit_id` | approved SQL | `NOT NULL` FK → `inventory.uom(id)` |
| `wastage_percentage` | FR-MNU-044 | `NUMERIC(5,2) NOT NULL DEFAULT 0` |
| `is_optional` | §7.4.4 "Excluded from availability blocking" | `BOOLEAN NOT NULL DEFAULT false` |
| `substitute_group_id` | §7.4.4 "Alternatives permitted" | Nullable, composite FK |

`ck_recipe_line_component`: `component_type='stock_item'` ⇒ exactly
`stock_item_id`; `component_type='sub_recipe'` ⇒ exactly `sub_recipe_id`.

**Yield / usage semantics.** `quantity` is per recipe yield, never per portion
(§7.4.4). `wastage_percentage` is per-component trim loss (FR-MNU-044);
`yield_percentage` is whole-recipe preparation loss (FR-MNU-043). Both are
**stored only** — the BR-MNU-003 formula that consumes them is costing, deferred
by D-17-05.

**UOM discipline (non-negotiable).** `recipe_versions.yield_unit_id` and
`recipe_lines.unit_id` are `NOT NULL` and MUST reference **real, pre-existing
`inventory.uom` rows**. Production Spec **never** fabricates a UOM identifier and
**never** creates, modifies, or seeds a UOM row. This is Phase 17 guardrail 1 and
the reason D-17-01 sequenced Inventory first. Unit-dimension compatibility
between a component's unit and the stock item's base unit is **not** validated
this phase — no source defines the rule, and `inventory.uom_conversions` belongs
to the closed Inventory context.

---

## 11. Sub-Recipes

A `sub_recipe` component references **`production.recipes` (logical identity)**,
not a specific version. Evidence: FR-MNU-041 "components as either stock items or
**other recipes** (sub-recipes)"; BR-MNU-001 "A **recipe** SHALL NOT reference
itself … through sub-recipes"; §7.4.4 `component_type` enum value `sub_recipe`.
All three name the recipe, never the version. The version consumed is then
resolved by the D-17-08 rule (§8).

**BR-MNU-001 / FR-MNU-042 cycle detection.**
- Runs **on save**, rejecting the change and displaying the **full cycle path**.
- Enforced in the **service** via a recursive query over
  `recipe_lines → sub_recipe_id → recipe_versions → recipe_lines`. PostgreSQL
  cannot express this as a declarative constraint, and triggers are not
  authorized, so the database is not the enforcement point here. This asymmetry
  is recorded openly in §17 and follows the Inventory precedent of listing
  service-enforced invariants explicitly (`INVENTORY_DESIGN_GATE.md` §28).
- **No depth limit is imposed on cycle detection.** BR-MNU-003's "depth limit of
  10" governs **cost expansion**, which D-17-05 defers. Importing that limit into
  cycle detection would be invention.
- A direct self-reference (`sub_recipe_id = recipes.id` of the owning recipe) is
  the degenerate case and is rejected by the same check.

**No additional recursion semantics are defined.** No expansion, no flattening,
no memoisation, no depth cap, no ordering guarantee.

---

## 12. Substitute Groups

Exactly what the sources establish, and nothing more.

- `production.substitute_groups (id, tenant_id, name)` — approved SQL L483–487.
- `production.substitute_group_members (substitute_group_id, stock_item_id)`,
  PK on both columns — approved SQL L489–494, plus the `tenant_id` addition of §9.
- `recipe_lines.substitute_group_id` nullable — §7.4.4 "Alternatives permitted".

**No selection algorithm.** No source defines how a substitute is chosen, when it
is chosen, by whom, or with what cost consequence. None is designed, and none may
be implemented. Substitute groups are, in this phase, pure configuration.

Per D-17-06, substitute-group operations fall under `recipe.edit`. No new
permission is introduced.

---

## 13. Scope Resolution

Three distinct concepts, deliberately kept separate:

1. **Recipe identity scope** — a property of `production.recipes`
   (`scope`, `brand_id`, `branch_id`). It determines *which recipe row* applies to
   a given branch context.
2. **Scope precedence (D-17-03)** — **branch > brand > tenant**. Given a branch
   context, the most specific matching recipe identity for a target wins. This
   precedence is **analogy-derived from FR-PLT-025** and is documented as such,
   not as an SRS recipe requirement. FR-MNU-047 [S] establishes that a branch may
   hold a variant differing from the brand standard; it does not state a
   precedence rule.
3. **Version selection (D-17-08)** — once the recipe identity is fixed, the
   version is the unique `status = 'published'` row. Lifecycle state only.

Scope precedence and version selection **compose in that order and only that
order**: resolve identity first, then version. Because `effective_from` is
non-operational, there is no third temporal stage and no composition-order
ambiguity of the kind flagged during D-17-08 discovery.

**Not implemented:** the FR-MNU-047 deviation compliance report; branch groups
(ADR 0008 D-10, deferred); branch-scoped RBAC (ADR 0008 D-02, deferred — all
authorization remains tenant-scoped).

---

## 14. API Surface

Three endpoints from SRS §26.3 "Representative Endpoints", verified verbatim,
plus one ratified deviation.

| Method | Path | Intent | Source |
|---|---|---|---|
| `POST` | `/v1/recipes` | Create the logical recipe identity | **GAP-1 RATIFIED DEVIATION** |
| `GET` | `/v1/recipes/{id}/versions` | Version history | §26.3 verbatim |
| `POST` | `/v1/recipes/{id}/versions` | Create a draft version | §26.3 verbatim |
| `POST` | `/v1/recipes/{id}/versions/{v}/publish` | Publish | §26.3 verbatim |

**GAP-1 deviation notice.** §26.3 defines version creation but **no operation
that creates a `production.recipes` row**; there is no `POST /v1/recipes`,
`GET /v1/recipes`, or `GET /v1/recipes/{id}` anywhere in the SRS. §26.3 is
explicitly labelled *Representative*, so the omission is a gap rather than a
prohibition. `POST /v1/recipes` is therefore authorized as a **deliberate,
documented API deviation**.

Binding constraints on the deviation:
- Recipes are **never auto-created** from version creation. `POST
  /v1/recipes/{id}/versions` requires an existing recipe and returns **404** if
  the id does not resolve within the tenant.
- **No auto-create key and no uniqueness rule** over
  `(scope, scope_id, recipe_type, target_id)` is invented. Multiple recipe rows
  with the same target are not prevented by this phase.
- **No further endpoints.** No list, no detail, no update, no delete, no
  resolution endpoint. In particular there is deliberately **no
  "effective recipe" endpoint** — the SRS defines one for menus
  (`GET /v1/menu`) and none for recipes, and D-17-08 authorizes a selection
  *rule*, not a selection *surface*.
- `{v}` in the publish path is the `version` integer, not the version `id`.

**Error semantics** (§26.2, and matching every prior phase): 401 unauthenticated;
403 authenticated without the required permission; **404 for cross-tenant or
unknown resources — never 403**, to avoid disclosing existence; 409 for lifecycle
conflicts (publishing a non-draft, or a uniqueness violation); 400 for validation.

Recipes appear under the "# Catalogue" heading in the §26.3 listing. That is an
API grouping only; ownership is Production Spec per §7.3 #11 and the §5.4 context
map. Catalogue is not modified.

---

## 15. Authorization

Exactly three permission codes, all verbatim from SRS §15.2 (D-17-06). **No code
is invented, and the catalogue is not expanded.**

| Operation | Permission | Evidence |
|---|---|---|
| `POST /v1/recipes` | `recipe.edit` | GAP-1 ratification, explicit |
| `GET /v1/recipes/{id}/versions` | `recipe.view` | §15.2 "View recipes" |
| `POST /v1/recipes/{id}/versions` (create draft) | `recipe.edit` | §15.2 "Edit recipes" |
| Modify a draft version's lines / substitute groups | `recipe.edit` | §15.2; D-17-06 |
| `POST /v1/recipes/{id}/versions/{v}/publish` | `recipe.publish` | §15.2 "Publish a recipe version" |

- Reads never require an edit or publish code.
- `recipe.publish` does **not** imply `recipe.edit`, and neither implies
  `recipe.view`. Roles compose the codes explicitly, matching every prior phase.
- Authorization is **tenant-scoped**. ADR 0008 D-02's deferral of branch-scoped
  RBAC stands: no handler reads `TenantContext.branchId`, even though recipes
  carry a branch scope.
- All three codes are SRS-attested, so — as with Inventory — none is provisional.

---

## 16. Events

The §6 event catalogue lists `recipe.version.published` (Publisher: Production
Spec; Principal Subscribers: Costing, Catalogue).

**No event is emitted, and no infrastructure is built.** The repository contains
**no outbox, no event bus, and no message broker**, and Phase 17 guardrail 6
forbids inventing one. Costing is deferred (D-17-05) and Catalogue must not be
modified (D-17-07), so both nominal subscribers are absent.

**Boundary statement.** Publication is recorded in `governance.audit_entries`
via the existing `AuditService` — the project's only durable record of state
change — using existing constants extended for the recipe entity. That is a
tamper-evident audit record, **not** an event, and no consumer subscribes to it.
When event infrastructure is separately ratified, `recipe.version.published`
becomes its first Production Spec publisher.

---

## 17. Database Constraints

### SOURCE-MANDATED (present in the approved SQL / SRS)
- `PRIMARY KEY (id)` on `recipes`, `recipe_versions`, `recipe_lines`,
  `substitute_groups`
- `PRIMARY KEY (substitute_group_id, stock_item_id)` on `substitute_group_members`
- `uq_recipe_version UNIQUE (recipe_id, version)`
- `CHECK (yield_quantity > 0)`
- `recipe_lines.recipe_version_id … ON DELETE CASCADE`
- `substitute_group_members.substitute_group_id … ON DELETE CASCADE`
- FKs to `identity.tenants`, `identity.users`, `inventory.uom`

### RATIFIED-DESIGN (deviation from the approved SQL, authorized by D-17-02 / D-17-08 / GAP-2)
- `UNIQUE (tenant_id, id)` on `recipes`, `recipe_versions`, `substitute_groups` (D-09)
- `tenant_id` added to `recipe_versions`, `recipe_lines`, `substitute_group_members`
- Composite tenant-safe FKs — the eleven edges tabulated in §9
- Typed nullable columns replacing `scope_id`, `target_id`, `component_id`
- `ck_recipe_scope`, `ck_recipe_target`, `ck_recipe_line_component` XOR CHECKs
- **Partial unique index `(recipe_id) WHERE status = 'published'`** — D-17-08 Q1.
  Prisma cannot express partial indexes, so it is raw SQL in the migration;
  **empirically verified to produce no Prisma drift.**
- `REVOKE UPDATE` + `GRANT UPDATE (status)` on `recipe_versions` — GAP-2
- Status-predicated RLS policies on `recipe_lines` and `recipe_versions` — GAP-2
- `ENABLE` + `FORCE ROW LEVEL SECURITY` and four policies on all five tables

### NOT AUTHORIZED (must not appear)
- `effective_to`, `published_at`, `priority`, `updated_at`
- Any trigger, rule, or stored procedure
- `archived` status usage or any transition involving it
- Blanket `REVOKE UPDATE` on `recipe_versions`
- Any uniqueness rule over `(scope, scope_id, recipe_type, target_id)`
- Any index on `effective_from` (there is no query that uses it — §25.4:
  "No index without a query that uses it")
- Population of `computed_cost` / `cost_computed_at`

### Enforcement-point summary

| Invariant | Enforced at |
|---|---|
| One published version per recipe | **DB partial unique index** |
| Published-version content immutability | **DB column-level grant** |
| Published-version children immutability | **DB RLS (status-predicated)** |
| Published/superseded not deletable | **DB RLS (status-predicated)** |
| `version` unique per recipe | **DB UNIQUE** |
| Exactly one scope target / component target | **DB CHECK (XOR)** |
| Tenant isolation | **DB RLS + composite FK** |
| Real UOM references | **DB FK** |
| `yield_quantity > 0` | **DB CHECK** |
| Lifecycle transition legality | **Service** (status guard) + DB grant |
| Publish ordering (demote before promote) | **Service** (same transaction) |
| BR-MNU-001 cycle detection with full path | **Service** — no declarative form exists |
| `version = max + 1` assignment | **Service**, guaranteed by DB UNIQUE |
| Unit-dimension compatibility | **Not enforced** — no source rule |
| Costing | **Deferred** (D-17-05) — **narrowly reopened 2026-08-20 for BR-MNU-003 / FR-MNU-046 / BR-POS-004 only; see §4.1** |

---

## 18. RLS / Security Test Matrix

Two suites, mirroring the established `*.e2e-spec.ts` + `*-rls.e2e-spec.ts`
pairing. Every negative assertion is accompanied by a **positive control**, so a
zero result proves filtering rather than absent data — the discipline that caught
the Inventory partition bypass.

**`production-rls.e2e-spec.ts`** — exercised through `PrismaService` as `ros_app`
(NOBYPASSRLS); the migrator client arranges fixtures and observes truth only.

| # | Case | Expectation |
|---|---|---|
| 1 | No tenant context, count all five tables | 0 rows each (fail-closed) |
| 2 | No tenant context, INSERT a recipe | rejected |
| 3 | Same tenant, read own recipes / versions / lines | visible (positive control) |
| 4 | Cross-tenant SELECT on each of the five tables | 0 rows |
| 5 | Cross-tenant INSERT spoofing `tenant_id`, plus identical INSERT with own tenant | rejected / succeeds |
| 6 | Cross-tenant UPDATE and DELETE | 0 rows; truth row unchanged |
| 7 | Recipe scoped to another tenant's brand | composite FK violation |
| 8 | Recipe scoped to another tenant's branch | composite FK violation |
| 9 | Recipe targeting another tenant's menu item variant | composite FK violation |
| 10 | Recipe targeting another tenant's stock item | composite FK violation |
| 11 | Line referencing another tenant's stock item | composite FK violation |
| 12 | Line referencing another tenant's recipe as sub-recipe | composite FK violation |
| 13 | Substitute member referencing another tenant's stock item | composite FK violation |
| 14 | Second `published` version for one recipe | partial unique index violation |
| 15 | UPDATE any non-`status` column on a published version | permission denied |
| 16 | UPDATE any non-`status` column on a **draft** version | permission denied (grant is table-wide) |
| 17 | UPDATE/DELETE lines of a published version | 0 rows (RLS) |
| 18 | INSERT a line into a published version | rejected (RLS) |
| 19 | UPDATE/DELETE lines of a draft version | succeeds (positive control) |
| 20 | DELETE a published or superseded version | 0 rows (RLS) |
| 21 | DELETE a draft version | succeeds (positive control) |
| 22 | `yield_unit_id` / `unit_id` resolve to real `inventory.uom` rows | FK holds; unknown UUID rejected |
| 23 | All five tables `relrowsecurity` **and** `relforcerowsecurity`, 4 policies each | asserted from `pg_class` / `pg_policies` |
| 24 | `ros_app` grants on `recipe_versions` include no table-wide UPDATE | asserted from `information_schema.role_column_grants` |

**`production.e2e-spec.ts`** — HTTP behaviour.

| # | Case | Expectation |
|---|---|---|
| 25 | Unauthenticated on every endpoint | 401 |
| 26 | Authenticated, no recipe permission | 403 |
| 27 | `recipe.view` only: read versions / create recipe / publish | 200 / 403 / 403 |
| 28 | `recipe.edit` only: create recipe + draft / publish | 201 / 403 |
| 29 | `recipe.publish` only: publish / create draft | 200 / 403 |
| 30 | Cross-tenant recipe id on any route | **404, never 403** |
| 31 | Create draft under a non-existent recipe | 404 (no auto-creation) |
| 32 | Publish a draft with no prior published version | target published |
| 33 | Publish a second draft | prior → `superseded`, new → `published`, still exactly one published |
| 34 | Publish an already-published or superseded version | 409 |
| 35 | Branch/brand/tenant scope resolution | branch > brand > tenant honoured |
| 36 | Scope precedence with only a tenant-scoped recipe present | tenant recipe returned |
| 37 | `effective_from` set to a future instant, then far past | **selection identical in both cases** |
| 38 | Recipe with no published version | resolves to nothing; not an error |
| 39 | Direct self-reference as sub-recipe | rejected, cycle path returned |
| 40 | Transitive cycle A→B→C→A | rejected, full path returned |
| 41 | Optional line and wastage percentage round-trip | stored and returned unchanged |
| 42 | `computed_cost` / `cost_computed_at` after every operation | remain `NULL` |

Test 37 is the assertion that D-17-08 Q2 is honoured in behaviour, not just in
prose.

---

## 19. Application Service Boundary

**Production Spec owns:**
- The five `production.*` tables and their migration
- Recipe identity creation (`POST /v1/recipes`)
- Draft version authoring, and line and substitute-group editing on drafts
- Publication and supersession within one transaction
- BR-MNU-001 cycle detection
- D-17-03 scope precedence and the D-17-08 selection rule
- Audit entries for recipe creation, draft creation, and publication
- Its own permission registration for the three §15.2 codes

**Production Spec must not touch:**
- `inventory.*` — read-only FK references to `stock_items` and `uom`; **never**
  creates, modifies, or seeds a UOM or stock item
- `catalogue.*` — read-only FK reference to `menu_item_variants`; `recipe_delta`
  stays opaque (D-17-07)
- `org.*`, `identity.*`, `governance.*` — read-only; audit via the existing
  `AuditService` only
- `sales.*`, `ck.*` — unimplemented; not created, not written
- Any completed phase's schema, service, or test, except the additive
  registration of Production Spec's own permissions

---

## 20. Explicitly Out of Scope

- Inventory changes of any kind
- Catalogue changes of any kind
- Sales `order_lines.recipe_version_id` writes (BR-POS-004 is Sales' obligation)
- Central Kitchen `production_orders.recipe_version_id` writes (FR-BRN-021…025)
- Recipe costing — FR-MNU-046, BR-MNU-003 (D-17-05) — **narrowly reopened 2026-08-20, see §4.1**
- `modifiers.recipe_delta` semantics — FR-MNU-013 (D-17-07)
- `archived` lifecycle semantics (D-17-04)
- Nutritional aggregation — FR-MNU-050 [C]
- Recipe scaling — FR-MNU-048 [S]
- FR-MNU-047 [S] deviation compliance report
- Offline recipe distribution and future-dated propagation (§21.3, FR-OFF-*)
- Effective-date resolution of any kind (D-17-08 Q2/Q3/Q4/Q5)
- Schedulers, jobs, cron, background workers
- Outbox / event-bus / message-broker infrastructure (§16)
- New permission codes beyond the three (D-17-06)
- Triggers, rules, stored procedures
- Branch-scoped RBAC (ADR 0008 D-02), branch groups (ADR 0008 D-10)
- Any schema addition not listed as RATIFIED-DESIGN in §17
- Unit-dimension compatibility validation
- Any endpoint beyond the four in §14

---

## 21. Open Questions

**ZERO open questions regarding D-17-08.** Q1 = A, Q2 = A, Q3/Q4/Q5 not
applicable. The rule in §8 is complete and requires no further input.

**GAP-1 — CLOSED / RATIFIED** (Option A: `POST /v1/recipes` authorized as a
documented deviation; no auto-creation; no invented uniqueness rule;
`recipe.edit` governs).

**GAP-2 — CLOSED / RATIFIED** (column-level `UPDATE (status)` grant plus
status-predicated RLS on children; no triggers; no blanket `REVOKE UPDATE`;
approved application of D-17-04's "where technically applicable" clause using
ADR 0003 and ADR 0007 patterns).

**No new ambiguity was discovered while closing this gate.**

Two items are recorded as **knowingly accepted, not open**:
1. **Sub-recipe expansion is not version-pinned.** A parent version references a
   sub-recipe by logical identity, so publishing a new sub-recipe version changes
   what the parent expands to. BR-MNU-002 is nonetheless satisfied, because
   completed orders snapshot `recipe_version_id` and `unit_cost_snapshot` and are
   never re-expanded (BR-POS-004). Costing is deferred and Sales is
   unimplemented, so this has no effect in this phase. It is recorded here so a
   future costing phase inherits the fact rather than rediscovering it.
2. **Cycle detection is service-enforced, not database-enforced.** PostgreSQL has
   no declarative form for it and triggers are not authorized. This is the same
   class of accepted asymmetry as Inventory's BR-INV-002 transfer pairing
   (`INVENTORY_DESIGN_GATE.md` §28).

---

## 22. Implementation Gate Checklist

All conditions must be green before Production Spec implementation is considered
complete. Implementation itself requires **separate authorization**.

**Schema and migration**
1. `production` added to the Prisma datasource `schemas` list
2. Migration applies cleanly as `ros_migrator`; `prisma migrate status` reports up to date
3. `prisma validate` clean; `prisma migrate diff --from-config-datasource --to-schema` reports **no difference**
4. All five tables exist with the columns of §5, §6, §10, §12
5. `UNIQUE (tenant_id, id)` present on `recipes`, `recipe_versions`, `substitute_groups`
6. All eleven composite FKs of §9 verified in `pg_constraint`
7. Three XOR CHECK constraints present and each proven to reject a violating row
8. `uq_recipe_version UNIQUE (recipe_id, version)` present
9. **Partial unique index `(recipe_id) WHERE status='published'`** present, and drift re-verified
10. No trigger exists in the `production` schema (asserted from `pg_trigger`)
11. No `effective_to`, `published_at`, `priority`, or `updated_at` column exists

**Security**
12. `ENABLE` + `FORCE` RLS on all five tables; four policies each (20 total)
13. Policy predicate byte-identical to the project standard
14. `recipe_lines` INSERT/UPDATE/DELETE policies carry the `status = 'draft'` parent predicate
15. `recipe_versions` DELETE policy carries the `status = 'draft'` predicate
16. `ros_app` holds **no table-wide UPDATE** on `recipe_versions`, and holds `UPDATE (status)` only — verified from `information_schema.role_column_grants`
17. Live `ros_app` probes: fail-closed with no context; cross-tenant SELECT/INSERT/UPDATE/DELETE blocked; **each with a positive control**
18. Live probe: a second published version is rejected by the index
19. Live probe: a published version's non-status column cannot be updated; its lines cannot be inserted, updated, or deleted

**Behaviour**
20. Exactly four routes exist; no list, detail, update, delete, or resolution endpoint
21. 404 (never 403) for cross-tenant and unknown ids
22. Permission mapping of §15 enforced; each of the three codes tested in isolation
23. Publish demotes before promoting, in one transaction
24. Cycle detection rejects direct and transitive cycles and returns the full path
25. **`effective_from` appears in zero selection code paths** — grep-asserted across `src/`
26. `computed_cost` / `cost_computed_at` remain `NULL` after every operation
27. Both test suites of §18 pass in full

**Repository health**
28. Read-only ESLint clean (`npx eslint`, never `npm run lint`, which mutates)
29. `nest build` clean; `tsc -p tsconfig.build.json --noEmit` clean
30. Full unit suite and full E2E suite green (`NODE_OPTIONS=--experimental-vm-modules`)
31. No completed-phase file modified except additive permission registration
32. Nothing committed without explicit instruction

---

## Final Status

| Item | Status |
|---|---|
| Design gate | **CLOSED / RATIFIED** |
| D-17-02 … D-17-08 | Preserved verbatim, not reinterpreted |
| GAP-1 | **CLOSED / RATIFIED** — Option A |
| GAP-2 | **CLOSED / RATIFIED** — CONFIRMED |
| Open questions | **ZERO** |
| `effective_from` | **Informational only** — never participates in selection |
| Single-published-version rule | Preserved; partial unique index required |
| Implementation | **NOT STARTED — requires separate authorization** |
