# Catalogue bounded context (Phase 16)

"What can be sold" (SRS §5.3). **"Item" here means SELLABLE**; in Inventory it
means stockable — translation is required at the boundary and no Inventory entity
is created by this phase.

Authoritative decisions: `PHASE_16_DISCOVERY.md` (C-01…C-11) + the ratification.
Plan: `PHASE_16_PLAN.md`.

## Tables (13, schema `catalogue`)

`menus` · `menu_branches` · `categories` · `menu_items` · `menu_item_placements` ·
`menu_item_variants` · `menu_item_images` · `availability_rules` ·
`modifier_groups` · `modifiers` · `modifier_group_links` · `price_lists` ·
`price_entries`

## Two decisions that shape everything

**MenuItem identity vs menu placement (C-02).** A MenuItem is *tenant-scoped* and
has **no `category_id`**. Appearing on the Main and Delivery menus is modelled by
`menu_item_placements`, so one dish keeps ONE id — preserving the shared `ItemId`
kernel with Production Spec (§5.3.1). The approved SQL's
`menu_items.category_id NOT NULL` was rejected because it would force duplicate
items, hence duplicate ItemIds and duplicate recipes.

**Menu → branch assignment (C-01).** FR-MNU-002 [M] requires it and the approved
SQL had no branch axis at all. `menu_branches` supplies it. Applicability is
`branch assignment + order_types + active_window + priority + is_active` — a menu
with no assignment applies to no branch; there is no implicit tenant-global menu.

## Deliberately absent

| Absent | Why |
|---|---|
| `combos`, `combo_slots`, `combo_slot_options` | C-08 — Combo deferred to a future Catalogue phase |
| `price_change_history` | C-10 — the tamper-evident audit trail is the system of record for FR-MNU-024 |
| `menu_item_variants.station_id` | C-03 — station routing is per-branch (FR-KDS-010); a tenant-scoped variant cannot express it, and has no discriminator for a tenant-safe FK |
| `quantity_sold_today`, `daily_quantity_limit` | C-07 — Sales runtime state; FR-MNU-035 [C] deferred |
| `branch_group` price-list scope | C-06 — ADR 0008 D-10 deferred branch groups |
| Categories lifecycle | C-09 — no `is_active` column in the approved SQL; none added for symmetry |

## Requirements knowingly unmet

- **FR-MNU-004 [M] tax class** — `tax_class_id` is nullable and FK-less; Fiscal is
  out of scope (C-04).
- **FR-MNU-012 [M] modifier → stock item** — `stock_item_id` / `consumption_unit_id`
  are recorded UUIDs with no FK; Inventory is out of scope.
- **FR-MNU-031 [M] auto-86 on zero stock** — depends on Inventory. The branch
  switch it keys off (`org.branches.automatic_availability`) exists from Phase 15.
- **FR-MNU-005 [M] receipt name** — the approved SQL provides POS/kitchen/
  aggregator name columns only; the receipt surface is unmodelled.
- **FR-MNU-020 [M] branch-group scope** — deferred with branch groups.
- **FR-MNU-013 [S] recipe delta** — stored as opaque JSON, never interpreted.
- **FR-MNU-023 offline propagation**, **FR-MNU-034 aggregator propagation**,
  **FR-MNU-025/026 bulk ops & margin warnings** — out of scope this phase.

## Authorization

Six codes (C-05): `menu.item.read|manage`, `menu.price.read|change`,
`menu.availability.read|toggle`. The three `manage/change/toggle` codes are
verbatim SRS §15.2; the three `.read` codes are **provisional** pending Appendix C.
Reads never require a manage code.

Authorization is **tenant-scoped**. ADR 0008 D-02's deferral of branch-scoped RBAC
still stands — no handler reads `TenantContext.branchId`.

## Tenant isolation

All 13 tables are `ENABLE` + `FORCE` RLS with 4 policies each (52 total). Eleven
anchor on a direct `tenant_id`; `menu_item_images` and `modifiers` inherit through
their parent via `EXISTS`, per ADR 0003.

`tenant_id` was added to five tables the approved SQL left without one
(`categories`, `menu_item_variants`, `availability_rules`, `modifier_group_links`,
`price_entries`) — **only** because each references a sibling or cross-aggregate
entity and §13 mandates a composite tenant-safe FK, which needs a discriminator
column. Pure children were left alone.

## C-11 — the MenuItem pricing invariant

"≥1 variant; every variant priced in every active price list" (§7.3 #7) is a
**VALIDATED BUSINESS INVARIANT, NOT A DATABASE HARD CONSTRAINT**. Enforcing it
relationally would create a circular write dependency and would contradict
BR-MNU-012's progressive-precision philosophy. `GET /catalogue/completeness`
reports items without an active variant and unpriced variants; nothing blocks.
