# PHASE 16 — IMPLEMENTATION PLAN

Maps every ratified decision (C-01…C-11) to schema, RLS, service, permission,
audit action and test. Baseline verified: HEAD `48a16f9`, 9 migrations applied,
no drift.

## Tables (12) — `catalogue` schema

| # | Table | tenant_id | Ratification |
|---|---|---|---|
| 1 | `menus` | direct (approved) | root |
| 2 | `menu_branches` | direct | **C-01 — new table** |
| 3 | `categories` | direct (**added**) | menu-scoped; composed against by placements |
| 4 | `menu_items` | direct (approved) | **C-02** — no `category_id`; `tax_class_id` nullable (**C-04**) |
| 5 | `menu_item_placements` | direct | **C-02 — new table** (item↔category) |
| 6 | `menu_item_variants` | direct (**added**) | **C-03** — no `station_id` |
| 7 | `menu_item_images` | inherited via item | pure child |
| 8 | `availability_rules` | direct (**added**) | **C-07** — no `quantity_sold_today` / `daily_quantity_limit`; XOR CHECK |
| 9 | `modifier_groups` | direct (approved) | root |
| 10 | `modifiers` | inherited via group | pure child |
| 11 | `modifier_group_links` | direct (**added**) | two sibling refs |
| 12 | `price_lists` | direct (approved) | **C-06** — enum `tenant\|brand\|branch` |
| 13 | `price_entries` | direct (**added**) | sibling ref to variants |

**NOT created (ratified):** `combos`, `combo_slots`, `combo_slot_options`
(**C-08**); `price_change_history` (**C-10**).

### `tenant_id` additions — implementation hardening under §13

§13 mandates composite tenant-safe FKs "wherever applicable" and forbids
cross-tenant relationships through ordinary writes. A composite FK needs a
discriminator column, so five tables that reference a **sibling or
cross-aggregate** entity gain `tenant_id`: `categories`,
`menu_item_variants`, `availability_rules`, `modifier_group_links`,
`price_entries`. Pure children (`menu_item_images`, `modifiers`) keep ADR 0003
`EXISTS` inheritance — no `tenant_id` added "merely because it feels safer".

## Composite tenant-safe FKs (D-09)

`categories(tenant_id, menu_id)→menus` · `categories(tenant_id, parent_category_id)→categories` ·
`menu_branches(tenant_id, menu_id)→menus` · `menu_branches(tenant_id, branch_id)→org.branches` ·
`menu_item_placements(tenant_id, menu_item_id)→menu_items` · `(tenant_id, category_id)→categories` ·
`menu_item_variants(tenant_id, menu_item_id)→menu_items` ·
`availability_rules(tenant_id, menu_item_id)→menu_items` · `(tenant_id, variant_id)→variants` · `(tenant_id, branch_id)→org.branches` ·
`modifier_group_links(tenant_id, menu_item_id)→menu_items` · `(tenant_id, modifier_group_id)→modifier_groups` ·
`price_entries(tenant_id, price_list_id)→price_lists` · `(tenant_id, menu_item_variant_id)→variants`

`org.branches(tenant_id, id)` already exists from Phase 15 — no Organisation
change required.

## CHECK constraints

- `modifier_groups`: `ck_min_le_max`, `ck_required_min` (approved SQL, §7.3 #8)
- `availability_rules`: **XOR** — exactly one of `menu_item_id`/`variant_id` (**C-07**)
- `price_lists`: `scope_type` enum restricted to 3 values (**C-06**)

## Permissions (C-05) — 6 codes, 3 from SRS §15.2 + 3 ratified read companions

`menu.item.read|manage` · `menu.price.read|change` · `menu.availability.read|toggle`

## Audit actions (§14)

MENU/MENU_ITEM/VARIANT create+update+activate+deactivate, MENU_BRANCH assign/unassign,
PLACEMENT add/remove, MODIFIER_GROUP/MODIFIER create+update, PRICE_LIST create+update,
PRICE_ENTRY set (before/after price), AVAILABILITY 86/override. All via
`AuditService.record(tx, …)` — mandatory, in-transaction (**C-10**).

## Business rules (C-11) — validated, NOT DB constraints

- MenuItem "sellable" ⇔ ≥1 active variant → reported, never blocks writes.
- Unpriced-variant detection → reporting endpoint.
- Creating a variant does not require price entries; creating a price list does
  not require entries for every variant.

## RLS

All 13 tables `ENABLE`+`FORCE`. Direct `tenant_id` predicate for 11; `EXISTS`
parent inheritance for `menu_item_images` and `modifiers`. 4 policies each.
Grants + default privileges for `ros_app` on the `catalogue` schema.
