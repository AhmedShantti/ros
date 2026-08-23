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

- **FR-MNU-004 [M] tax class** — `tax_class_id` remains **nullable**, but is no
  longer FK-less: `fiscal.tax_classes` now exists and every non-null reference is
  a real tenant-safe FK. See the **C-04 AMENDMENT** below.
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

## C-04 — MenuItem tax class

> **REOPENED AND AMENDED 2026-08-20 by explicit user governance action, NARROWLY
> and only for TaxClass IDENTITY AND INTEGRITY.**
> The original ratified text is preserved verbatim below and is **not deleted**.
> **No new numbered decision; no D-21; the decision tally is unchanged.**

### C-04 as originally ratified (SUPERSEDED — retained for the record)

- **SQL:** `tax_class_id UUID NOT NULL, -- FK fiscal.tax_classes(id)`.
- **SRS:** FR-MNU-004 [M] lists "Tax class" as a required item attribute.
- **Why it blocked:** `fiscal.tax_classes` does not exist and Fiscal is explicitly
  out of scope (brief §16). `NOT NULL` forces every create call to supply an id
  that cannot be validated or resolved. Precedent exists for a recorded FK-less
  UUID (`identity.terminals.branch_id`, ADR 0004) — but that column was populated
  by a *client* that knew real branch ids; here no tax class exists anywhere in
  the system, so any value is fabricated.
- **Ratified outcome:** `menu_items.tax_class_id` is **nullable and FK-less**,
  informational until Fiscal lands; never validated or resolved by Phase 16.

### C-04 AMENDMENT (2026-08-20) — binding

**Why reopened.** The original blocker was factual and has been removed: the
premise "no tax class exists anywhere in the system" no longer holds. P1B
delivered a signed, versioned Country Pack whose `tax.classes` are real, and
BR-POS-004 requires `sales.order_lines.tax_class_id UUID NOT NULL` at sale time.
Without a stable identity, line capture could only fabricate a UUID. The reopen
is **narrow**: it settles TaxClass identity and referential integrity, and
nothing else about Fiscal.

**What is now binding:**

1. **`fiscal.tax_classes` is the stable semantic TaxClass identity.** It exists,
   with a UUID primary identity, exactly as the approved SQL always specified.

2. **A TaxClass carries an immutable semantic `code`** — `standard`, `reduced`,
   `zero`, `exempt` and any further code a Country Pack defines. The set is
   **open**: a pack may name a class this repository has never seen, and adding
   one is data, not a code change. No enum is hard-coded.

3. **A TaxClass DOES NOT own tax rates.** Rates, component definitions, rounding,
   order-type overrides and every fiscal semantic remain data inside the pinned
   Country Pack version. Nothing rate-shaped may be added to
   `fiscal.tax_classes`, and nothing rate-shaped may be added to
   `catalogue.menu_items`.

4. **The division of authority is exact.**
   - TaxClass identity answers *"what semantic tax class is this item assigned
     to?"*
   - Country Pack version answers *"what does that class mean, in rates and
     rules, for this transaction?"*

   This is what lets a pack change the rate attached to `standard` without
   rewriting a single historical OrderLine.

5. **`code` is unique per `(tenant_id, country_pack_code)`** and is
   **immutable after creation**. A semantic identity may not be mutated into a
   different meaning — historical order lines point at it.

6. **`catalogue.menu_items.tax_class_id` stays NULLABLE**, because onboarding
   master data legitimately arrives incomplete and the original ratification
   already settled that. **When non-null it is a real tenant-safe FK** to
   `fiscal.tax_classes`, enforced by the DATABASE, not by service code.

7. **A MenuItem without a TaxClass is not sellable.** Line capture fails with a
   business-rule error. It **MUST NOT** silently default to `standard` — a
   defaulted tax class is a wrong tax return.

8. **`sales.order_lines.tax_class_id` snapshots the stable UUID.** Pack lookup at
   sale time goes UUID → semantic code → the class of that code **inside the
   exact pinned pack version**.

**Explicitly forbidden by this amendment:** converting `order_lines.tax_class_id`
to a string; hashing a class code into a UUID; generating a mapping UUID at sale
time; storing a tax rate on `menu_items` or on `fiscal.tax_classes`.

**Unchanged:** C-01, C-02, C-03, C-05 … C-10 and the C-11 amendment and
active-state clarification. Fiscal remains otherwise out of scope — no tax
document, no invoice template, no fiscal submission, and no `fiscal.tax_rules`
table is created by this amendment.

## C-11 — the MenuItem pricing invariant

> **REOPENED AND AMENDED 2026-08-19 by explicit user governance action.**
> The original ratified text is preserved verbatim below and is **not deleted**.
> The amendment that supersedes it follows immediately after.

### C-11 as originally ratified (SUPERSEDED — retained for the record)

"≥1 variant; every variant priced in every active price list" (§7.3 #7) is a
**VALIDATED BUSINESS INVARIANT, NOT A DATABASE HARD CONSTRAINT**. Enforcing it
relationally would create a circular write dependency and would contradict
BR-MNU-012's progressive-precision philosophy. `GET /catalogue/completeness`
reports items without an active variant and unpriced variants; nothing blocks.

### C-11 AMENDMENT (2026-08-19) — binding

**Why reopened.** Two grounds, both established by audit:

1. **The BR-MNU-012 justification does not hold.** Its exact text is *"An item MAY
   be sold with an incomplete or absent **recipe**. The System SHALL permit the
   sale, SHALL record zero or partial **cost**, and SHALL list the item in a
   '**recipes** requiring completion' report."* It concerns **recipes and cost
   only**; there is **no textual link to pricing or `PriceEntry`**. It is
   **removed as a pricing justification** and must not be cited for pricing
   completeness again.
2. **SRS §7.1** requires an invariant that must always hold to be enforced inside
   its aggregate consistency boundary, and **§7.3 #7** states the invariant
   unconditionally. Downgrading it wholesale to non-blocking reporting conflicted
   with both.

**What is now binding:**

1. A PriceList **MAY** be incomplete — missing a `PriceEntry` for an active
   variant — **only while it is non-active / non-effective**.
2. **No operation may leave an active PriceList missing a price for an active
   variant.** This binds every operation that could produce that state, in either
   direction:
   - activating (or making effective) a PriceList that lacks an entry for any
     active variant;
   - creating or activating a variant while an active PriceList lacks an entry
     for it;
   - any future mutation that would remove an entry or reactivate a list.
3. The **circular write dependency is resolved by the lifecycle**, not by
   abandoning the invariant: a list is authored while non-active, entries are
   added, and the completeness condition is checked **at the activation /
   effectiveness boundary**.
4. `GET /catalogue/completeness` **remains**, as a reporting aid for non-active
   lists. It no longer discharges the invariant on its own.

### C-11 ACTIVE-STATE CLARIFICATION (2026-08-19) — binding

Recorded by explicit user governance action. It settles the residual sub-question
below. **No new numbered decision; no D-21; the decision tally is unchanged.**

- **`active` is the administrative PriceList status** (`price_lists.status`).
- **Completeness is required whenever `status = 'active'`.**
- **Temporal eligibility is a separate concern.** `valid_from` / `valid_to` /
  recurrence decide whether an active list *participates in price resolution at a
  given instant* — they do not decide whether it must be complete.
- **Temporal non-effectiveness does NOT permit an administratively active list to
  be incomplete.** A future-dated list must therefore be **complete before** it is
  changed to `active`.
- **A draft / inactive list may be incomplete** (`scheduled`, `expired`).
- **No operation may leave an active list incomplete** — this binds every change
  to an active variant/list relationship, in either direction.

*(Superseded text follows, retained for the record.)*

**Residual sub-question, recorded and NOT invented here.** The exact operational
definition of "active / effective" is not settled by this amendment. The schema
carries both a `status` column (`scheduled | active | expired`) and a validity
window (`valid_from` / `valid_to`), and — once weekly-local-time recurrence v1 is
implemented — a recurrence pattern as well. Whether the invariant binds on
`status = 'active'` alone, on current effectiveness within the window, or on both,
must be settled before implementation. It is flagged here rather than chosen.
