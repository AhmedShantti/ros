# PHASE 16 — CATALOGUE FOUNDATION: DISCOVERY & DESIGN GATE

- Date: 2026-08-16
- Phase: 16.1 (Discovery) → 16.2 (Design Gate)
- Status: **BLOCKED — CLARIFICATION REQUIRED.** No schema, migration or code written.
- Baseline: Phase 15 closed out; DB schemas present are `identity`, `governance`,
  `org`, `kitchen`. No `catalogue` schema, no catalogue Prisma models.

Sources inspected: ROS_SRS_v1.0.pdf (§5.3, §7.3, Chapter 10, §15.2, §22),
`ROS_DrawDB_Compatible_v3.sql` (catalogue block, L272–430), `prisma/schema.prisma`,
9 applied migrations, the Phase 15 Organisation implementation, ADR 0001–0008,
`PHASE_15_DISCOVERY_REPORT.md`, `PHASE_15_READINESS_AUDIT.md`.

---

## 0. Sequencing note

Catalogue as the Phase 16 target is **[DERIVED]**, not stated by the SRS. The
supplied SRS does not contain Chapter 30 (Release Roadmap), although earlier
sections reference it. The derivation rests on: Phase 15 ended before Catalogue;
Phase 15 discovery deferred branch templates to "after Catalogue + Workforce" and
central menu/recipe override to "Catalogue / Production Spec"; §5.3 defines
Catalogue as a bounded context; §7.3 defines its aggregates; Chapter 10 defines
its requirements. **No claim of roadmap authority is made.**

---

## 1. Catalogue aggregates (SRS §7.3)

| # | Aggregate | Contained entities | Stated invariants |
|---|---|---|---|
| 7 | **MenuItem** | Variants, ModifierGroupLinks, Images | **≥1 variant; every variant priced in every active price list** |
| 8 | **ModifierGroup** | Modifiers | min ≤ max; if required then min ≥ 1 |
| 9 | **Combo** | ComboSlots, SlotOptions | Every slot has ≥1 option |
| 10 | **PriceList** | PriceEntries, ValidityWindow | No overlapping windows of same priority for same scope |

§5.3 lists Catalogue's key aggregates as *MenuItem, Category, Modifier, Combo,
PriceList* and fixes the ubiquitous language: **"'Item' here means sellable. In
Inventory, 'Item' means stockable. Translation required."**

Note **Category and Menu are named in §5.3 / FR-MNU-001 but are not §7.3
aggregate roots** — §7.3 gives no invariants for them.

## 2. Functional requirements in scope

**Structure** — FR-MNU-001 [M] hierarchy Menu → Category → Sub-category
(optional) → Item → Variant. FR-MNU-002 [M] multiple menus per tenant, assignable
to **branches**, order types and time windows. FR-MNU-003 [M] explicit priority
ordering with ambiguity warnings. FR-MNU-004 [M] the 15-attribute item table.
FR-MNU-005 [M] independent names per surface (POS/KDS/receipt/aggregator).
FR-MNU-006 [M] variants with independent pricing, recipes, barcodes, availability.
FR-MNU-007 [S] sort order + live POS preview.

**Modifiers** — FR-MNU-010 [M] reusable groups with per-item price/default
overrides. FR-MNU-011 [M] min/max, required, allow-repeat, default, free-quantity
threshold. FR-MNU-012 [M] modifier → stock item + consumption quantity.
FR-MNU-013 [S] recipe delta.

**Pricing** — FR-MNU-020 [M] named price lists with scope (tenant/brand/branch/
**branch group**), validity window, optional recurrence, priority. FR-MNU-021 [M]
order-type-specific pricing. FR-MNU-022 [M] time-based pricing in the branch
timezone. FR-MNU-023 [M] scheduled future price changes propagated to offline
terminals. FR-MNU-024 [M] full price change history. FR-MNU-025 [S] bulk
operations. FR-MNU-026 [S] margin warnings.

**Availability** — FR-MNU-030 [M] manual 86 per item per branch with auto-re-enable.
FR-MNU-031 [M] auto-86 on zero stock when the branch flag is set (the
`org.branches.automatic_availability` column Phase 15 already stores).
FR-MNU-032 [M] authorised override, recorded. FR-MNU-033 [S] remaining sellable
quantity. FR-MNU-034 [S] aggregator propagation. FR-MNU-035 [C] daily quantity
limits decrementing on sale.

**Out of scope by brief §5 / §16** — FR-MNU-040…050 (Recipe Management) belong to
Production Spec. §5.3.1 fixes the boundary: `Catalogue ──(shared kernel:
ItemId)──▶ Production Spec`.

## 3. Approved SQL — `catalogue` block

13 tables: `menus`, `categories`, `menu_items`, `menu_item_variants`,
`menu_item_images`, `availability_rules`, `modifier_groups`, `modifiers`,
`modifier_group_links`, `combos`, `combo_slots`, `combo_slot_options`,
`price_lists`, `price_entries`, `price_change_history`.

Tenant anchoring, as designed:

| Direct `tenant_id` | Inherits via parent |
|---|---|
| `menus`, `menu_items`, `modifier_groups`, `combos`, `price_lists` | `categories` (→menu), `menu_item_variants` (→item), `menu_item_images` (→item), `availability_rules` (→item/variant), `modifiers` (→group), `modifier_group_links` (→item+group), `combo_slots` (→combo), `combo_slot_options` (→slot), `price_entries` (→list), `price_change_history` (none) |

This matches the Phase 15 pattern exactly (direct anchor + `EXISTS(parent)`
inheritance), so §9's RLS shape is a known, proven quantity — **once the
ownership questions below are settled.**

## 4–17. Semantics — resolved vs unresolved

**Resolved and safe to implement** (no ratification needed):

- **Tenant scope / RLS shape** — identical to Phase 15: `ENABLE`+`FORCE`, direct
  `tenant_id` predicate or `EXISTS(parent … tenant_id = app.tenant_id)`,
  fail-closed via `NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
- **Composite tenant-safe FKs** — ADR 0008 D-09 applies unchanged. Every edge
  where a child carries its own `tenant_id` (`menu_items → categories`,
  `combos → menu_items`, `price_entries → menu_item_variants`) or references a
  sibling needs a composite FK plus a `@@unique` target.
- **Localisation model** — JSONB per name field (`{"ar":…,"en":…}`), verbatim from
  the approved SQL; FR-MNU-005's four surfaces map to `names`, `kitchen_names`,
  `aggregator_names`, `description`. Receipt name has **no column** (gap, §19).
- **Modifier selection semantics** — fully specified: FR-MNU-011 [M] plus the SQL
  CHECKs `ck_min_le_max` and `ck_required_min`, matching §7.3 #8.
- **Ubiquitous-language boundary** — Catalogue "Item" = sellable. No Inventory
  table is created; `modifiers.stock_item_id` / `consumption_unit_id` stay
  FK-less recorded UUIDs (ADR 0004 precedent).
- **Order type / channel vocabulary** — owned by Sales (`sales.order_type_enum`,
  `sales.channel_enum`), but the approved Catalogue tables reference them as
  `TEXT[]` / `VARCHAR(16)`, **not** as the enum type. So Catalogue needs no Sales
  schema; the vocabulary is duplicated as free text by design.

**Unresolved — these are the design gate.** See §18.

## 18. BLOCKERS — material ambiguities

### C-01 — FR-MNU-002 [M] menu→branch assignment has NO schema

- **SRS:** FR-MNU-002 [M] "A tenant SHALL be able to define multiple menus … and
  assign each to **branches**, order types, and time windows."
- **SQL:** `catalogue.menus` has `order_types TEXT[]`, `active_window JSONB`,
  `priority`, `is_active` — and **no branch reference whatsoever**. A
  repository-wide search finds no `menu_branches`, `branch_menus` or
  `menu_assignments` table, and no `branch_id` on any catalogue table except
  `availability_rules`.
- **Why it blocks:** two of FR-MNU-002's three assignment axes are modelled and
  one is absent. Menu resolution (FR-MNU-003 [M]) cannot be implemented without
  it — "which menus are active for this branch right now" is unanswerable.
  Inventing a junction table invents the cardinality, the scoping (branch vs brand
  vs branch-group) and the tenancy edge.
- **Decision required:** add a junction table (shape to be ratified), or defer all
  branch-scoped menu resolution and ship menus as tenant-global.

### C-02 — Item↔menu cardinality contradicts multi-menu reuse

- **SQL:** `menu_items.category_id UUID NOT NULL → categories(id)`, and
  `categories.menu_id UUID NOT NULL → menus(id)`. Therefore **an item belongs to
  exactly one category, hence exactly one menu.**
- **SRS:** FR-MNU-002 [M] gives Breakfast / Main / Late Night / Ramadan / Delivery
  as concurrent menus, and FR-MNU-003 [M] resolves *between* simultaneously active
  menus. FR-MNU-021 [M] prices the *same item* differently by order type.
  §7.3 #7's invariant prices "every variant … in every active price list".
- **Why it blocks:** under the SQL, putting "Chicken Sandwich" on both the Main
  and Delivery menus requires **two separate `menu_items` rows** with separate
  ids, variants, barcodes, modifier links and recipes. That breaks the shared
  `ItemId` kernel with Production Spec (§5.3.1) — one sellable dish would have two
  ItemIds and two recipes. The alternative reading (item shared across menus via a
  join) contradicts `category_id NOT NULL`.
- **Decision required:** is a MenuItem menu-scoped (duplicated per menu) or
  tenant-scoped and *placed* on menus? This determines the entire schema shape and
  cannot be deferred.

### C-03 — Station assignment: per-branch (SRS) vs per-variant (SQL)

- **SRS:** FR-KDS-010 [M] resolution step 3 is "Menu item's assigned station
  **for this branch**"; step 4 "Category default station". FR-MNU-004 [M] lists
  "Station routing" as an item attribute.
- **SQL:** `menu_item_variants.station_id UUID REFERENCES org.stations(id)` — a
  **single** station per variant, tenant-wide.
- **Why it blocks:** a variant is tenant-scoped; a station is branch-scoped
  (Phase 15: `org.stations` has no `tenant_id`, inheriting through `branch_id`).
  A single `station_id` on a tenant-scoped row cannot express "for this branch",
  and a tenant with 12 branches has 12 different Grill stations. It is also a
  **cross-tenant hazard**: per ADR 0008 D-09, an FK check bypasses RLS, so
  `station_id` would need a composite guard — but the variant carries neither
  `tenant_id` nor `branch_id`, so **there is no column to compose with.** There is
  no tenant-safe way to implement this FK as specified.
- **Decision required:** drop `station_id` from variants this phase (defer station
  routing to Kitchen Ops), or introduce a per-branch item/station assignment table
  (invents schema), or accept an unguarded cross-tenant FK (rejected by D-09).

### C-04 — `menu_items.tax_class_id NOT NULL` → Fiscal (out of scope)

- **SQL:** `tax_class_id UUID NOT NULL, -- FK fiscal.tax_classes(id)`.
- **SRS:** FR-MNU-004 [M] lists "Tax class" as a required item attribute.
- **Why it blocks:** `fiscal.tax_classes` does not exist and Fiscal is explicitly
  out of scope (brief §16). `NOT NULL` forces every create call to supply an id
  that cannot be validated or resolved. Precedent exists for a recorded FK-less
  UUID (`identity.terminals.branch_id`, ADR 0004) — but that column was populated
  by a *client* that knew real branch ids; here no tax class exists anywhere in
  the system, so any value is fabricated.
- **Decision required:** make it nullable this phase (deviation from approved
  SQL), keep it NOT NULL and require an opaque unvalidated UUID, or defer
  MenuItem until Fiscal exists (blocks the phase).

### C-05 — Permission catalogue incomplete (recurrence of D-01)

- **SRS §15.2** "Catalogue & Recipes" gives exactly three Catalogue codes:
  `menu.item.manage` ("Create and edit menu items"), `menu.price.change`
  ("Change prices"), `menu.availability.toggle` ("86 items"). The remaining three
  (`recipe.view/edit/publish`) are Production Spec.
- **Missing:** no **read** permission for any catalogue object; nothing for menus,
  categories, modifier groups, combos or price lists as manageable objects. The
  full catalogue is "maintained in **Appendix C**", which is **not in the supplied
  SRS**.
- **Why it blocks:** brief §10 explicitly forbids seeding invented codes such as
  `catalogue.item.read` without authorisation. Without a read code the §15.3
  Auditor role ("read-only everything") is unexpressible — identical to the
  problem ADR 0008 D-01 resolved for Organisation by ratifying two invented
  `.read` companions.
- **Decision required:** mirror the D-01 pattern (use the 3 SRS codes + ratify
  invented read companions), or use only the 3 SRS codes (no read/write split),
  or supply Appendix C.

### C-06 — `price_lists.scope_type` includes `branch_group`, which Phase 15 deferred

- **SQL:** `scope_type VARCHAR(16) NOT NULL -- tenant, brand, branch, branch_group`
  with a polymorphic `scope_id UUID` (no FK). FR-MNU-020 [M] names the same four
  scopes.
- **Conflict:** ADR 0008 **D-10 deferred branch groups**; no `branch_groups` table
  exists, and FR-BRN-005 [M] remains knowingly unimplemented. A price list scoped
  to `branch_group` would reference a non-existent entity.
- **Also:** `scope_id` is polymorphic with no FK and no `tenant_id` correlation —
  the same un-RLS-anchorable shape that caused `org.settings` to be deferred
  (D-11). A `scope_id` pointing at another tenant's brand/branch is not prevented
  by anything.
- **Decision required:** restrict `scope_type` to the three implementable scopes
  this phase, implement price lists without branch-group support and document the
  [M] gap, or defer PriceList entirely.

### C-07 — `availability_rules` mixes configuration with Sales runtime state

- **SQL columns:** `day_of_week`, `starts_at`, `ends_at`, `channel`, `branch_id`
  (configuration) **plus** `is_manual_86`, `auto_reenable_at`,
  `daily_quantity_limit`, `quantity_sold_today INTEGER NOT NULL DEFAULT 0`.
- **SRS:** FR-MNU-035 [C] says the daily limit decrements **on sale**;
  FR-MNU-030/032 [M] make 86-ing an operational act by an authorised user.
- **Why it blocks:** `quantity_sold_today` is high-churn runtime state written by
  the Sales context — structurally the same problem as `org.tables.status`, which
  ADR 0008 **D-05 resolved by omitting the column** from Phase 15. Keeping it here
  would let Sales write a Catalogue-owned row, breaking the aggregate boundary the
  project has otherwise held.
- **Secondary ambiguity:** `menu_item_id` and `variant_id` are **both nullable**
  with no stated rule — both-null and both-set are legal, and no source defines
  either case.
- **Decision required:** split configuration from runtime state (and defer the
  runtime half), implement verbatim, or defer availability entirely.

### C-08 — Is Combo in Phase 16 scope?

- SRS §5.3 and §7.3 #9 define Combo as a Catalogue aggregate, and brief §3 lists
  it among "key aggregates". But brief §16's explicit IN SCOPE list names Menu,
  Category, Sub-category, MenuItem, Variant, Modifier/ModifierGroup and PriceList
  — **Combo is absent**.
- `catalogue.combos.menu_item_id` also makes a combo *both* its own aggregate and
  a `menu_items` row (`is_combo` flag), duplicating identity; and
  `combo_slots`' `CHECK (true)` is an explicit no-op placeholder, so §7.3 #9's
  "every slot has ≥1 option" has no enforcement mechanism in the approved design.
- **Decision required:** in or out for Phase 16.

### C-09 — Lifecycle model conflicts with ratified D-12

- **SQL:** `menus.is_active`, `menu_items.is_active`,
  `menu_item_variants.is_active` exist; `categories` has **no** `is_active`.
- **Conflict:** ADR 0008 **D-12** ratified that Phase 15 exposes **no delete or
  deactivate endpoints** for any Organisation entity. Catalogue's approved schema
  actively provides deactivation columns, and FR-MNU-030 requires availability
  toggling — so Catalogue appears to *require* a lifecycle API that Organisation
  was denied.
- **Decision required:** does Catalogue get activate/deactivate endpoints (and if
  so, does D-12 need revisiting for consistency), and what happens to categories,
  which have no such column?

### C-10 — `price_change_history` duplicates the tamper-evident audit trail

- **SQL:** a dedicated `catalogue.price_change_history` table
  (`old_price`, `new_price`, `changed_by → identity.users(id)`, `effective_at`,
  `changed_at`). **No `tenant_id`, and `price_entry_id` has no FK.**
- **SRS:** FR-MNU-024 [M] "full price change history: who changed what, from what
  to what, when, and effective when" — which `governance.audit_entries` already
  captures (actor, before/after state, hash-chained, append-only, RLS-scoped).
- **Why it blocks:** two competing systems of record for the same [M] requirement.
  The dedicated table is **mutable** (no append-only REVOKE) and **not
  tenant-anchored**, so using it would weaken a guarantee the audit trail already
  provides. Brief §11 forbids weakening audit immutability.
- **Decision required:** use the audit trail as the system of record, implement
  both, or implement the dedicated table with added `tenant_id` + append-only
  protection (deviation).

### C-11 — §7.3 #7 MenuItem invariant is not implementable as stated

- **Invariant:** "≥1 variant; **every variant priced in every active price list**".
- **Why it blocks:** the second clause is a global cross-aggregate constraint. It
  cannot be enforced at write time without either blocking price-list creation
  until every variant is priced, or blocking variant creation until every active
  price list has an entry — and "active" is itself time- and scope-dependent
  (FR-MNU-020/022). The approved SQL provides no mechanism, and no FR states when
  the invariant is evaluated or what happens on violation.
- **Interaction with BR-MNU-012** — the SRS explicitly permits selling an item
  with an *incomplete recipe* ("progressive precision"), suggesting a
  warn-don't-block philosophy that the §7.3 invariant contradicts.
- **Decision required:** enforce at write time, validate-and-warn, or treat as a
  reporting concern.

## 19. Non-blocking gaps (documentable, no decision needed)

- **Receipt name has no column.** FR-MNU-005 [M] names four surfaces (POS, KDS,
  receipt, aggregator); the SQL provides `names`, `kitchen_names`,
  `aggregator_names` — three. The receipt surface is unmodelled.
- **`prep_time_seconds` sits on the variant**, though FR-MNU-004 lists preparation
  time as an *item* attribute. Minor; variant-level is the finer grain.
- **`menu_items.images`** is a separate table (`menu_item_images`) per §7.3 #7 —
  consistent.
- **No `created_at`/`updated_at`** on `menus`, `categories`, `variants`,
  `modifier_groups`, `modifiers`, `price_lists`, `price_entries`.
- **Missing uniqueness** (D-15 analogue): no unique on
  `price_entries(price_list_id, menu_item_variant_id)` — duplicate prices for one
  variant in one list are legal; no unique on `categories(menu_id, name)`,
  `modifier_groups(tenant_id, name)`, `menus(tenant_id, name)`.
- **`modifiers.recipe_delta JSONB`** (FR-MNU-013 [S]) carries Production Spec
  vocabulary inside a Catalogue table. Storable as opaque JSON without
  implementing Production Spec, per brief §5 ("document the boundary").
- **`modifiers.stock_item_id` / `consumption_unit_id`** — FR-MNU-012 [M] requires
  stock linkage; Inventory is out of scope. Recordable as FK-less UUIDs
  (ADR 0004 precedent), but the requirement stays functionally unmet.
- **`price_change_history` has no `tenant_id`** — see C-10.

## 20. Missing roadmap information

Chapter 30 (Release Roadmap) is absent from the supplied SRS. Nothing in this
document relies on it, and the Phase 16 target is marked **[DERIVED]** (§0).
Appendix B (traceability matrix) and Appendix C (permission catalogue) are also
referenced by the SRS but absent; Appendix C is the direct cause of **C-05**.

---

## DESIGN GATE VERDICT

# BLOCKED — CLARIFICATION REQUIRED

Eleven material ambiguities (C-01 … C-11) hit brief §15 STOP conditions 1, 2, 3,
4, 5, 6, 7, 8, 12, 13 and 15. Four of them — **C-01, C-02, C-03, C-04** — are
structural: they determine the shape of the core tables, so no
schema, migration or model can be written without resolving them first. Per
brief §7 and §19, none has been resolved by guessing and nothing has been
implemented around them.

**Nothing was written beyond this document.** `prisma/schema.prisma` is
unmodified, no migration exists, no `catalogue` schema was created, and no
application code was added.
