# P1E-2 — KDS Routing Semantics + Persistence Design Closure

**Report type:** Claude Code design/architecture gate evidence (ANALYSIS ONLY — no code, no migration)
**Authority:** Non-authoritative evidence; SRS and ratified governance remain authoritative
**Date:** 2026-08-21
**HEAD:** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Branch:** `feat/production-spec`
**Working tree:** accumulated uncommitted P0/P1A–P1E-1C work retained, untouched; this run wrote only this report + the INDEX row — no source file, schema, or migration was modified
**Claude task:** P1E-2 — close FR-KDS-001/010/011 routing semantics and produce a migration-ready persistence design. No implementation, no migration, no Fire, no Payment, no commit.

---

## A. STARTING STATE

Every §4 baseline fact was re-verified against the repository. **No deviation found**, with three refinements worth recording:

| §4 claim | Verified |
|---|---|
| `kitchen` schema exists | ✅ declared in `prisma/schema.prisma:16` |
| Station lives in `org.stations` | ✅ `@@schema("org")` |
| Station has branch ownership | ✅ `branchId` + FK, `@@unique([branchId, id])` |
| Station has `capacity_config` | ✅ `capacityConfig Json @default("{}")` |
| Station lacks `display_colour` | ✅ absent |
| `kitchen.station_routing_rules` exists | ✅ with `branch_id, station_id, menu_item_id?, category_id?, priority` |
| No executable resolver | ✅ zero service/controller/read path touches the table |
| `menu_item_id`/`category_id` integrity incomplete | ✅ **no FK of any kind** on either column |
| Invalid selector combinations structurally allowed | ✅ **no CHECK constraint**; a row with both selectors set, or neither, is currently legal |
| No modifier routing storage | ✅ no `modifier_id` column anywhere |
| No line-level station override storage | ✅ `OrderLine` has no station column |
| No branch fallback storage | ✅ `Branch` has no fallback column; **`org.settings` does not exist** in Prisma or any migration |
| No Ticket/TicketLine | ✅ no model, no table |
| Orders/OrderLines partitioned, need partition-safe FKs | ✅ `@@id([id, businessDay])`, and **FR-DR-001 [M]** mandates it |
| Event/UoW foundation complete | ✅ P1E-1C accepted; not reopened by this gate |
| No Fire route / no Fire permission / no Payment | ✅ all three confirmed absent |
| Migrations | ✅ 20, unchanged |

**Refinement 1 — the FK-lessness has a documented, now-expired cause.** ADR 0008 D-06 states verbatim: *"`menu_item_id` and `category_id` are intentionally FK-less (**Catalogue does not exist**); the comment reads `nullable = category rule`. No `active` flag, no uniqueness, no `tenant_id`."* Catalogue **now exists** (Phase 16, shipped). The stated reason for the omission has expired — this materially changes what is achievable now versus at Phase 15.

**Refinement 2 — a prior report's classification is corrected by this gate.** The P1D-1 gate report (§H, Tier 3) recorded *"whether routing is per item or per variant is NOT SOURCE-DECIDABLE."* Re-reading FR-KDS-010 tier 3 verbatim — *"Menu item's assigned station for this branch"* — the SRS **is** explicit. That item was over-flagged; see §D/KDS-R4.

**Refinement 3 — `org.settings` is SRS-mandated, ratified-as-DEFERRED, and unimplemented.** §25.1's schema map lists `settings` under `org`, and it exists in the approved SQL — but **ADR 0008 D-11 classifies it DEFERRED** and records that it *"cannot be RLS-anchored as designed"*. It appears in neither the Prisma schema nor any migration. This decides KDS-R6 more firmly than "it does not exist" would; see §I.

**Refinement 4 — station/KDS governance does not live where one would expect it.** `docs/governance/GOVERNANCE_DECISION_REGISTER.md` is exclusively about the Approval/Governance workflow; searching it for `station`, `KDS`, `FR-KDS`, or `station_routing_rules` returns **zero hits**. All station and routing decisions live in `docs/adr/0008-organisation-foundation.md` under an **independent, colliding `D-xx` sequence** (see §B). Any future reader citing "D-09" or "D-16" without a source prefix will cite the wrong decision.

---

## B. SOURCE REQUIREMENTS

Read verbatim from `ROS_SRS_v1.0.pdf` (not from prior-report paraphrase).

**FR-KDS-001 [M]** — *"The System SHALL support definition of preparation stations per branch, with configurable name, display colour, and capacity."* Standard types listed include **Expediter (Pass)**.

**FR-KDS-010 [M]** — *"The System SHALL route each order line to one or more stations, resolved by the following precedence: 1. Explicit line-level station override 2. Modifier-driven routing rule (a "make it crispy" modifier may reroute) 3. Menu item's assigned station for this branch 4. Category default station 5. Fallback station configured for the branch"*

**FR-KDS-011 [M]** — *"A single order line SHALL be routable to multiple stations when the item requires multi-station preparation (a burger requiring grill and packaging)."*

**FR-KDS-020/021 [M]** — ticket cards contain order number, order type, elapsed time, table/customer reference, item lines with quantity and modifiers, preparation notes; modifiers visually distinguished, removals rendered differently from additions.

**FR-KDS-028 [S]** — *"Amendments to a fired order SHALL appear as a visually distinct update on the existing ticket … never as a new ticket."*

**FR-KDS-040 [M]** — *"The System SHALL record the following timestamps per ticket and per line: created, routed, first viewed, started, ready, bumped, and served."*

**FR-POS-035 [M]** — fire automatically upon line entry (fast-casual) or explicitly (table-service), *"configurable per branch and per order type."*
**FR-POS-036 [S]** courses · **FR-POS-037 [S]** hold-and-fire · **FR-POS-038 [M]** amendment ticket, *"not a reprint of the whole order."*

**UC-POS-01 step 6 (decisive for timing)** — *"Waiter fires course 1. System transitions order to OPEN, creates tickets, **routes each line to its station per FR-KDS-010**, records first_fired_at, and publishes `order.line.fired`."*

**UC-KDS-01 step 1 (decisive for multi-station)** — *"System evaluates routing rules per line. Burger → Grill; Fries → Fryer; **both → Packaging**; ticket summary → Expediter."*

**FR-PLT-003 [M]** — *"Every tenant-scoped record SHALL carry an immutable tenant_id. Records SHALL NOT be transferable between tenants."*

**FR-DR-001 [M]** — `sales.orders` and `sales.order_lines` range-partitioned by `business_day`, monthly, 24-month retention. **No `kitchen.*` table is in the partition list.**

**§25.1 schema map** — `org` = "brands, branches, warehouses, central_kitchens, stations, tables, **settings**"; `kitchen` = "tickets, ticket_lines, **station_routing_rules**"; `sales` = "orders, order_lines, order_line_modifiers, order_discounts, order_payments, refunds".

**§7.3 aggregates** — #23 `Ticket | Kitchen Ops | TicketLines | Derived from Order; independent lifecycle`; #24 `Station | Kitchen Ops | RoutingRules, CapacityConfig | Belongs to one branch`; #5 lists Stations among the **Branch** aggregate's contained entities.

**§6.1 hierarchy** — Station sits under Branch, sibling of Terminal and Drawer.

**Decisive intra-document parallel — FR-POS-040 [M]:** *"Price for an item SHALL be resolved by the following precedence, **evaluated at order time**: 1. Manual price override … 7. Base price."* Structurally identical language to FR-KDS-010, and unambiguously first-match-wins (a manual override is not combined with the base price). This is the strongest available evidence for how "resolved by the following precedence" is meant to read. See §D/KDS-R1.

**FR-POS-042 [M]** — *"The System SHALL record which price list and which rule produced the [price]."* **There is no FR-KDS equivalent for routing** — verified by reading every FR-KDS requirement (001, 010–013, 020–029, 040–045). Decisive for §E's provenance question.

**⚠ DECISION-ID NAMESPACE COLLISION — read every `D-xx` citation below with its source prefix.** `docs/governance/GOVERNANCE_DECISION_REGISTER.md` is **exclusively** about the Approval/Governance workflow; a full-text search for `station`, `KDS`, `FR-KDS`, `station_routing_rules` across `docs/governance/` returns **zero hits**. Every station/routing decision lives in **`docs/adr/0008-organisation-foundation.md`**, which uses an independent `D-xx` sequence. The same number means different things:

| ID | Governance register | ADR 0008 |
|---|---|---|
| D-06 | Approval Request Mutability (RATIFIED) | **`kitchen.station_routing_rules` schema placement** (RATIFIED) |
| D-09 | RLS / tenant isolation for Governance tables (RATIFIED) | **Composite tenant-safe foreign keys** (RATIFIED) |
| D-16 | `request_type` enumeration (**OPEN**) | **Station → Terminal relationship** (RATIFIED) |

**Convention for this report: every `D-xx` refers to ADR 0008 unless it is explicitly labelled "governance register".** The governance register contributes exactly one relevant item — carried **Clarification C** (fire authority boundary) — which is named as such wherever cited. Register tally re-verified: **20 decisions (17 RATIFIED · 1 IN PART · 1 BLOCKED · 1 OPEN)**; highest is D-20; **no D-21 exists**, and this gate creates none.

**Ratified governance located this run (ADR 0008):**

- **ADR 0008 D-06 (kitchen schema placement) — RATIFIED.** *"Create the `kitchen` schema in Phase 15 containing **only** `station_routing_rules`… **Expose it as Organisation configuration API.** No Kitchen Ops behaviour is implemented — no tickets, no ticket lines, no routing resolution."* SQL evidence: *"`menu_item_id` and `category_id` are intentionally FK-less (**Catalogue does not exist**)… No `active` flag, no uniqueness, no `tenant_id`."* Isolation *"rests entirely on `branch_id → org.branches.tenant_id`, which is sound **provided D-09's composite FK prevents a cross-tenant branch_id**."*
- **ADR 0008 D-07 (Station aggregate ownership) — RATIFIED (2026-08-15).** *"Station is an **aggregate root within the Organisation context**, whose tenant scope is inherited through Branch, and which owns StationRoutingRules as child entities."* Rationale: *"The SRS contradicts itself: §7.3 row #5 lists Stations among the Branch aggregate's contained entities, while §7.3 row #24 lists Station as an aggregate root in the Kitchen Ops context… Treating Station as root reconciles #24's structure with §25.1's placement."*
- **ADR 0008 D-09 (composite tenant-safe FKs) — RATIFIED.** *"For children that carry no `tenant_id` (operating_hours, stations, tables, print_routing, **station_routing_rules**), anchor sibling references on the **branch composite** instead."* Reason: *"PostgreSQL evaluates referential-integrity checks with row security **disabled**… A composite FK makes the cross-tenant edge **unrepresentable** rather than merely **validated**."*
- **ADR 0008 D-15 (uniqueness) — RATIFIED, and directly on point.** *"Leave `station_routing_rules` unconstrained"*, because *"`station_routing_rules` uniqueness is **entangled with Catalogue keys that do not exist yet** and is **deliberately left open**."*
- **ADR 0008 D-11 (`org.settings`) — DEFERRED.** *"Not implemented in Phase 15… the approved table cannot satisfy its own mandatory requirements… It also has **no `tenant_id`**, and `scope_id` is a polymorphic UUID with no FK — so it **cannot be RLS-anchored** as designed."*
- **ADR 0008 D-16 (Station → Terminal) — RATIFIED.** Implemented a composite FK *"which requires adding `UNIQUE (branch_id, id)` to `identity.terminals`. That addition is an **index only** — no column is added, no column is altered, no semantics change, and no Identity application code is touched."*
- **ADR 0008 scope statement — RATIFIED.** *"**No behaviour is implemented for configuration this phase creates.** Station routing rules are **stored, not resolved** (FR-KDS-010 is Kitchen Ops)."*
- **D-INV-09 precedent** — register line 88: *"Inventory D-INV-09 added `tenant_id` to `stock_levels`."* Line 1626 records the pattern: *"Add `tenant_id` + composite tenant-safe FK; direct RLS anchor — parent-independent — `recipe_lines`, `stock_levels`."*
- **Carried item Clarification C (governance register)** — the only Kitchen-adjacent governance text that exists: *"BEFORE a line is fired — the cashier may correct or edit normally… AFTER a line is fired — the cashier **SHALL NOT** directly mutate that fired content."* Governs override mutability (§K, §M).

**Governance coverage gap, recorded:** there is **no ratified governance anywhere** on FR-KDS-011, modifier routing, line-level station overrides, branch fallback storage, or `priority` semantics. Prior analysis of these exists only in `docs/reports/claude/`, which is **evidence, not authority**. Every decision this gate takes on those points is therefore labelled explicitly (§D, §P).

---

## C. CURRENT ROUTING SCHEMA AUDIT

`kitchen.station_routing_rules`, as actually shipped (`20260816110000_organisation_foundation/migration.sql`):

| Aspect | Current state |
|---|---|
| Columns | `id` (PK), `branch_id`, `station_id`, `menu_item_id?`, `category_id?`, `priority SMALLINT DEFAULT 0` |
| `tenant_id` | **absent** — deliberate, D-06 "PARENT anchor" design |
| FK → station | ✅ `(branch_id, station_id) → org.stations(branch_id, id) ON DELETE RESTRICT` — D-09 compliant |
| FK → branch | ✅ `branch_id → org.branches(id)` (single-column; branch ids are globally unique, so this unambiguously determines tenant) |
| FK → menu_item | ❌ **none** |
| FK → category | ❌ **none** |
| FK → modifier | ❌ column does not exist |
| CHECK constraints | ❌ **none** — a row with both selectors, or neither, is legal today |
| UNIQUE constraints | ❌ **none** — duplicate selector→station rows are legal today |
| Indexes | `(branch_id, station_id)` only |
| RLS | ✅ `ENABLE` + `FORCE`; all four operations gated by `EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)` |
| Grants | ✅ `GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen"."station_routing_rules" TO ros_app` |
| Rows written by any code | **zero** |

**Documented rationale for the no-`tenant_id` shape, verbatim** (`migration.sql:268-276`):

> `-- RLS. Two anchors:`
> `--   * DIRECT  — brands/branches/warehouses/central_kitchens carry tenant_id.`
> `--   * PARENT  — stations/tables/operating_hours/print_routing/`
> `--               station_routing_rules carry NO tenant_id (approved design) and`
> `--               inherit the boundary through org.branches …`
> `-- Context is read as NULLIF(current_setting('app.tenant_id', true), '')::uuid,`
> `-- so a missing context yields NULL -> predicate false -> FAIL CLOSED.`

**Assessment.** The row's *own* tenancy is sound: `branch_id` resolves to exactly one branch and therefore one tenant, and RLS fails closed. The defect is **not** the rule's tenancy — it is that the **Catalogue selectors have no integrity at all**, and cannot gain *tenant-safe* integrity while the table lacks `tenant_id`, because their tenant-safe FK targets are `(tenant_id, id)`. Since *"PostgreSQL evaluates referential-integrity checks with row security disabled"* (ADR 0008 D-09), RLS does not compensate: a tenant-A rule referencing a tenant-B menu item is currently **representable**.

`org.stations`, as shipped: `id` (PK), `branch_id`, `name VARCHAR(64)`, `capacity_config JSONB DEFAULT '{}'`, `display_terminal_id?`, `created_at`. No `tenant_id`, **no `display_colour`**, **no status/active flag**, `@@unique([branchId, id])` + `@@unique([branchId, name])`. RLS `ENABLE`+`FORCE` with the same branch-traversal predicate. Referenced with `ON DELETE RESTRICT` by both `org.print_routing` and `kitchen.station_routing_rules`.

---

## D. KDS-R1..R10 VALIDATION

```
KDS-R1:  VALID
KDS-R2:  VALID
KDS-R3:  VALID  (as an explicitly-labelled ENGINEERING DECISION)
KDS-R4:  VALID  (and source-decided — corrects a prior report)
KDS-R5:  VALID  (as an explicitly-labelled ENGINEERING DECISION)
KDS-R6:  NEEDS REVISION  (typed table upheld; "Kitchen-owned" conflicts with ratified D-07)
KDS-R7:  VALID  (with one named schema prerequisite)
KDS-R8:  VALID  (with two named schema prerequisites)
KDS-R9:  VALID
KDS-R10: VALID
```

### KDS-R1 — Fixed precedence, first applicable tier wins → **VALID**

FR-KDS-010 says *"resolved by the following precedence"* over a numbered 1–5 list. **FR-POS-040** uses structurally identical language (*"resolved by the following precedence, evaluated at order time"*, numbered 1–7) for price resolution, where first-match-wins is beyond doubt and is already implemented that way in this repo (`price-resolution.ts`, `PriceTier`). Applying a different reading to FR-KDS-010 would require the same words to mean two different things in one document. **Source-supported, not merely a reasonable choice.**

### KDS-R2 — Distinct union within the winning tier → **VALID**

FR-KDS-011 [M] requires multi-station routing, and UC-KDS-01 step 1 gives the concrete case: *"Burger → Grill; … both → Packaging"* — one line, two stations. Since KDS-R1 forbids crossing tiers, the only place multi-station can come from is **multiple matches within one tier**, i.e. the distinct union. KDS-R1 and KDS-R2 are therefore not independent choices: given first-match-wins, KDS-R2 is the *only* way FR-KDS-011 can be satisfied. Deduplication is required because two rules may name the same station.

**One modelling caution, flagged not resolved:** UC-KDS-01's *"ticket summary → Expediter"* is a **different mechanism** — FR-KDS-013 [S] describes the Expediter (Pass) as a display *"showing complete orders, with per-station completion state"*, i.e. an order-level view, not a per-line routing destination. Modelling Expediter as a routing rule target would be a mis-reading. FR-KDS-013 is `[S]` and out of scope here; the routing design must not assume Expediter is a routed station.

### KDS-R3 — Modifier routing replaces lower tiers in v1 → **VALID (ENGINEERING DECISION)**

The SRS wording is *"a 'make it crispy' modifier **may reroute**"*. "Reroute" reads as redirect/replace rather than add. Combined with KDS-R1, a winning tier-2 match means tiers 3–5 are simply not consulted — so KDS-R3 is KDS-R1 applied at tier 2, not a separate rule. **The SRS does not explicitly decide replace-vs-augment**, so this is correctly labelled an engineering decision.

**Operational sharp edge, recorded deliberately:** under replace, a burger routed `{Grill, Packaging}` at tier 3 that gains a "make it crispy" modifier routed `{Fryer}` at tier 2 will route to `{Fryer}` **only** — Packaging is lost. That is a real risk in production configuration. It is nonetheless what precedence + "reroute" mean, and the mitigation is the fail-closed explainability in KDS-R10 plus operator configuration discipline.

**Future-AUGMENT compatibility — confirmed structurally free.** Replace-vs-augment is a **resolver behaviour**, not a storage shape: the rule row is a `(selector → station)` mapping either way. Introducing an augment mode later requires a resolver change plus (if it is to be configurable) one boolean/enum on the branch KDS config — it does **not** invalidate or rewrite any existing rule row. Per KDS-R3's own instruction, **no augment mode is modelled now**.

### KDS-R4 — Tier 3 is MenuItem-level → **VALID, and source-decided**

FR-KDS-010 tier 3 reads *"**Menu item's** assigned station for this branch"*. That is explicit. It is further corroborated by ratified Catalogue conflict **C-03** (`docs/catalogue/PHASE_16_DISCOVERY.md:158-175`, outcome recorded in `docs/catalogue/README.md:37`), which considered and **rejected** variant-level routing:

> *"a variant is tenant-scoped, and a station is branch-scoped… A single `station_id` on a tenant-scoped row cannot express 'for this branch'… It is also a **cross-tenant hazard**: per ADR 0008 D-09, an FK check bypasses RLS, so `station_id` would need a composite guard — but the variant carries neither `tenant_id` nor `branch_id`, so **there is no column to compose with.** There is no tenant-safe way to implement this FK as specified."*

C-03's enumerated options were: *"drop `station_id` from variants this phase (defer station routing to Kitchen Ops), or **introduce a per-branch item/station assignment table**, or accept an unguarded cross-tenant FK (rejected by D-09)."* The first was ratified; `kitchen.station_routing_rules` **is** the second. C-03's "no column to compose with" reasoning is also the precise reason §J must add `tenant_id` — the identical argument applied to the rule table.

**This corrects the P1D-1 gate report**, which classified item-vs-variant as NOT SOURCE-DECIDABLE. It is decided: **MenuItem**. Variant-level routing is a possible future extension and is **not** current FR-KDS-010 semantics.

### KDS-R5 — Multi-category conflicts fail closed → **VALID (ENGINEERING DECISION)**

FR-KDS-010 tier 4 says *"**Category** default station"* — singular, and the SRS implicitly assumes an item has one category. This repository's Catalogue deliberately does not: ratified **C-02** makes `MenuItem` tenant-scoped with **no `category_id`**, placed into many categories via `catalogue.menu_item_placements` (`@@unique([tenantId, menuItemId, categoryId])`). The SRS therefore **neither mandates nor forbids** KDS-R5's behaviour — it did not anticipate the case.

KDS-R5 is sound as an engineering decision, for a reason worth stating: categories in this model are a **merchandising/display** axis (they carry `sortOrder` and `colour`, and belong to a `Menu`), not a preparation axis. Silently unioning two merchandising categories' station defaults would fan a single dish out to unrelated preparation stations with no operator having asked for it. Failing closed surfaces a configuration error instead of quietly producing wrong food routing, and the prescribed remedy (an explicit tier-3 MenuItem rule) is both available and higher-precedence.

**Alternative considered and rejected:** falling through to tier 5 (fallback) on conflict. Rejected because it silently converts a detectable misconfiguration into a plausible-looking result, which is precisely the failure mode KDS-R10 exists to prevent.

### KDS-R6 — Branch KDS config Kitchen-owned → **NEEDS REVISION**

**Upheld:** the typed-relational direction, unambiguously. A fallback station stored as a generic settings value cannot carry `FOREIGN KEY (branch_id, fallback_station_id) → org.stations(branch_id, id)`, so "the fallback belongs to this branch" would degrade from *unrepresentable* to *validated in application code* — exactly what §11 and D-09 forbid. Also upheld: not adding a KDS column to `org.branches`, which would make every branch update touch KDS configuration and would place a Kitchen concern in the Organisation aggregate root.

**`org.settings` is independently ruled out by ratified governance, not merely by my preference.** **ADR 0008 D-11** classifies it **DEFERRED** and records exactly why it could not carry this: *"It also has **no `tenant_id`**, and `scope_id` is a polymorphic UUID with no FK — so it **cannot be RLS-anchored** as designed without either adding `tenant_id` or writing a `scope_type`-aware policy."* D-11 further warns that if it is later built to drive policy, *"a cross-tenant `scope_id` write becomes a financial integrity issue."* Using it for a station reference would import exactly that hazard. KDS-R6's instruction to avoid it is therefore **confirmed by ratified governance**.

**Requires revision:** the phrase *"Kitchen-owned"*. **Ratified ADR 0008 D-07** places Station — *and explicitly its RoutingRules children* — as an aggregate root **within the Organisation context**, and **ADR 0008 D-06** directs that the routing table be *"expose[d] as **Organisation configuration API**"* while holding that *"Station routing rules are **stored, not resolved** (FR-KDS-010 is Kitchen Ops)."* The ratified split is therefore: **configuration storage + API = Organisation; resolution behaviour = Kitchen Ops.** A branch-level fallback-station setting is configuration of exactly the same class as `station_routing_rules`. Declaring the new table "Kitchen-owned" would contradict D-07/D-06; declaring the *resolver* Kitchen-owned (§N) is exactly right.

**Recommended resolution** (§I): a typed one-row-per-branch table placed in the **`kitchen` schema** — co-located with `station_routing_rules`, the table it is functionally a sibling of — while its **bounded-context ownership is Organisation, per D-07**, exactly as `station_routing_rules` already is. This preserves the existing ratified schema-placement/context-ownership split rather than inventing a second one. Because §25.1 enumerates neither this table nor a fallback column anywhere, the schema choice is the one point that warrants explicit ratification.

### KDS-R7 — Line override as 0..N child records → **VALID (one prerequisite)**

FR-KDS-011 makes a single nullable `station_id` on `OrderLine` structurally incapable of expressing the requirement, so a child relation is correct. Sales ownership is correct: the override is order-entry intent, captured with the line, dying with the line. §7.3 #22 places OrderLines under the Order aggregate (Sales); §7.3 #24 places RoutingRules under Station. Rules are *configuration*; an override is *transaction intent*. Clean split. Column set and the one prerequisite are derived in §K.

### KDS-R8 — Typed relational routing rules → **VALID (two prerequisites)**

Evolving `kitchen.station_routing_rules` with a third nullable selector plus an exactly-one CHECK is correct and strictly better than `selector_type + selector_id`, which would make real FKs impossible on all three selectors. Prerequisites are derived in §J and §L; the modifier selector carries a genuine cross-module blocker (§P).

### KDS-R9 — Existing `priority` does not redefine FR-KDS-010 → **VALID**

Investigated as instructed. Evidence:
- `priority SMALLINT NOT NULL DEFAULT 0` originates in the approved SQL (`ROS_DrawDB_Compatible_v3.sql:257`) with **no explanatory comment** — the only comment on that table is on `menu_item_id` (*"nullable = category rule"*).
- ADR 0008 D-06's own inventory of the table records **no meaning** for it, and ADR 0008 explicitly holds resolution behaviour out of Phase 15 scope (*"stored, not resolved"*).
- **No ratified governance anywhere assigns it semantics** (confirmed by exhaustive search of `docs/governance/` and `docs/adr/`). The sibling case is documented as an acknowledged blank: `docs/organisation/README.md:28` — *"Print routing priority / active flag — **defined by neither the SRS nor the approved SQL**."*
- Every occurrence of "priority" in the SRS was reviewed. The only routing-adjacent hits are **FR-MNU-020 price-list priority** and §7.3 #10's *"No overlapping windows of same priority for same scope"* — both **PriceList**, unrelated to stations. FR-KDS-010 defines its own fixed five-tier precedence and never mentions a priority column.
- No repository code reads it.

**Classification: NOT SOURCE-DECIDABLE — most consistent with (B) unused design residue**, plausibly copied from the PriceList priority pattern during DrawDB modelling. **Recommendation:** leave the column physically present (dropping it is out of scope and would be a destructive change to approved SQL), assign it **no semantics**, ensure the resolver **never reads it**, and record it as a deprecation candidate for the implementation slice. It must not be permitted to collapse, reorder, or override the five tiers. Do not implement around it.

### KDS-R10 — Zero routes fail closed + explainable result → **VALID**

Fail-closed is required, not merely prudent: UC-POS-01 step 6 makes ticket creation and routing part of the same Fire action, and P1E-1's accepted infrastructure dispatches in-transaction so a handler throw rolls the whole Fire back (§5.5.2). A line silently fired to zero stations is food that is never cooked.

The explainable-result shape has an **exact, already-shipped precedent in this repository**: `src/modules/catalogue/pricing/price-resolution.ts` exports `PriceTier`, `TIER_LABEL`, and `ResolvedPrice { amount, priceListId, priceEntryId, tier, tierLabel, … }`, documented as *"enough provenance for a future Sales layer to snapshot which list and which rule produced it (FR-POS-042). **Nothing is persisted here.**"* Mirroring that shape is therefore consistent rather than novel.

**Provenance persistence — decided by evidence, not preference: do NOT persist it.** FR-POS-042 [M] explicitly requires recording which rule produced a *price*. **No FR-KDS requirement imposes an equivalent obligation for routing** (all of FR-KDS-001, 010–013, 020–029, 040–045 reviewed). Additionally, the *outcome* of routing is inherently persisted anyway — as the resulting Ticket/TicketLine rows, which record which station received the line. So "which station" is durable; "which tier/rule chose it" is a runtime diagnostic. **Runtime-only provenance is sufficient.**

---

## E. FINAL ROUTING ALGORITHM

**Determinism convention** (mirroring the shipped `PriceContext`: *"Everything the resolution depends on. Nothing is read from ambient state… The instant to evaluate at — supplied, never read from the clock."*)

**INPUT — `RoutingContext`** (all supplied, nothing ambient):
`tenantId`, `branchId`, `orderId`, `businessDay`, `orderLineId`, `menuItemId`, `selectedModifierIds: readonly string[]`, `categoryIds: readonly string[]` (the line's item's placements), `lineStationOverrideIds: readonly string[]`.

**OUTPUT — `ResolvedRouting`** (runtime only, never persisted):
```
{ stations: readonly string[],        // 1..N distinct station ids, deterministically ordered
  tier: RoutingTier,                  // 1 | 2 | 3 | 4 | 5
  tierLabel: string,                  // line_override | modifier | menu_item | category | fallback
  sourceIds: readonly string[] }      // the selector/rule ids that produced the result
```
…or a typed failure (`RoutingUnresolved`) carrying a machine-readable reason.

**ALGORITHM** — evaluate tiers in order; the **first tier producing a non-empty station set wins**; that set is returned and lower tiers are not consulted.

1. **Tier 1 — line override.** If `lineStationOverrideIds` is non-empty → stations = distinct union of those ids. Return tier 1.
2. **Tier 2 — modifier.** Load active rules for `branchId` where `modifier_id ∈ selectedModifierIds`. If any match → stations = distinct union of their `station_id`. Return tier 2. (Replaces tiers 3–5 — KDS-R3.)
3. **Tier 3 — menu item.** Load rules for `branchId` where `menu_item_id = menuItemId`. If any match → distinct union. Return tier 3.
4. **Tier 4 — category.** Load rules for `branchId` where `category_id ∈ categoryIds`. Group matched rules **by `category_id`**, producing one station set per category. Then:
   - zero categories matched → fall through to tier 5;
   - exactly one category matched → use its set;
   - multiple categories matched, **all producing an identical station set** (compare as sets, order-independent) → use that set;
   - multiple categories matched producing **differing** sets → **`ROUTING_CONFIGURATION_CONFLICT`** (terminal failure; do **not** fall through). Error payload names the competing `categoryId`s and their sets.
5. **Tier 5 — branch fallback.** If the branch's KDS config has a non-null `fallback_station_id` → stations = `[fallbackStationId]`. Return tier 5.
6. **No tier produced stations → `ROUTING_NO_DESTINATION`** (terminal failure).

**Deterministic ordering.** The returned `stations` array is sorted ascending by station id (ULID-as-UUID byte order). This is an **ENGINEERING CHOICE** for reproducibility only; no source assigns business meaning to station order, and none may be inferred from it. `sourceIds` is likewise sorted.

**Defined edge cases** (each maps to a test in §O):

| Case | Behaviour |
|---|---|
| Duplicate routes (two rules, same selector → same station) | Deduplicated by the distinct union. Additionally made **unrepresentable** by the proposed unique index (§J) |
| Station belonging to another branch | **Unrepresentable** — `(branch_id, station_id) → org.stations(branch_id, id)` |
| Selector belonging to another tenant | **Unrepresentable** once the `tenant_id` prerequisite lands (§J/§L); today it is representable — a current defect |
| Dangling rule (selector row deleted) | **Unrepresentable** once selector FKs land; `ON DELETE CASCADE` from the selector removes the rule |
| Deleted station | **Blocked** — existing `ON DELETE RESTRICT` prevents deleting a station that any rule references |
| Inactive station | **NOT SOURCE-DECIDABLE — no status column exists.** See §H; the resolver cannot filter on a concept the schema does not have |
| Multiple modifier matches | Distinct union within tier 2 (KDS-R2) |
| Multiple MenuItem station matches | Distinct union within tier 3 — this is the FR-KDS-011 burger case |
| Identical multi-category results | Resolve to that set (tier 4, case 3) |
| Conflicting multi-category results | `ROUTING_CONFIGURATION_CONFLICT` — fail closed |
| Missing fallback | Tier 5 yields nothing → `ROUTING_NO_DESTINATION` |
| Line with no route at all | `ROUTING_NO_DESTINATION` → Fire rolls back |
| Repeated invocation | Pure function of `RoutingContext` + rule rows; no clock, no ambient state → identical result |
| Config changed after fire | Not re-resolved. See §M |

---

## F. MODIFIER IDENTITY

Inspected as §6 required, and the terminology **does** differ between SRS and repository in a way that matters.

| Entity | Repository shape | Routing selector? |
|---|---|---|
| `catalogue.ModifierGroup` | `id @id`, `tenantId`, `name`, min/max selections, `@@unique([tenantId, id])` | **No** — this is the *question* ("Cooking style"), not the answer |
| `catalogue.Modifier` | `id @id`, `modifierGroupId`, `name`, `priceDelta`, `isDefault`, `sortOrder`. **No `tenant_id`. No `@@unique([tenantId, id])`.** Documented as *"Pure child of ModifierGroup — inherits the tenant boundary via EXISTS."* | **YES — this is the correct selector** |
| `catalogue.ModifierGroupLink` | join of MenuItem ↔ ModifierGroup with per-item overrides | No |
| `sales.OrderLineModifier` | `id`, `tenantId`, `orderLineId`, `businessDay`, **`modifierId`**, `modifierGroupId`, `nameSnapshot`, `priceDelta`, `quantity` | This is the **runtime record** of a selected choice |

**Mapping, stated explicitly:** the SRS's *"a 'make it crispy' modifier"* is an individual selectable **choice**, which in this repository is `catalogue.Modifier` — **not** `ModifierGroup` (the group would be "Cooking style", which cannot itself imply a station). At runtime the selected choice is `sales.order_line_modifiers.modifier_id`, which references `catalogue.modifiers.id`. There is **no `ModifierOption` entity** in this repository; `Modifier` fills that role.

**The routing selector must therefore be `modifier_id → catalogue.modifiers(id)`.**

**Blocker, stated precisely.** `catalogue.modifiers` carries **no `tenant_id`** and has **no `(tenant_id, id)` unique key**, so a D-09 tenant-safe composite FK to it is **impossible today**. A plain single-column FK to `modifiers(id)` *is* expressible and would prevent dangling references — but not cross-tenant ones, and D-09 is explicit that *"PostgreSQL evaluates referential-integrity checks with row security disabled"*, so RLS does not compensate. Note also that `sales.order_line_modifiers.modifier_id` already has **no FK at all** for the same reason, so this gap is pre-existing and wider than routing.

Making tier 2 tenant-safe requires **`catalogue.modifiers` to gain `tenant_id` + `@@unique([tenantId, id])`** — a change to a **Catalogue-owned** table. Under §5.2.3 (*"Database migrations are owned by exactly one module"*), the routing slice **cannot make this change unilaterally**. Carried to §P as a blocker.

---

## G. MULTI-CATEGORY SEMANTICS

The conflict is structural, not incidental: FR-KDS-010 assumes *"Category default station"* (one category), while ratified **C-02** gives `MenuItem` **no `category_id`** and models placement as a many-to-many via `catalogue.menu_item_placements` (`@@unique([tenantId, menuItemId, categoryId])`, plus `@@index([tenantId, categoryId])`).

**Resolved per KDS-R5, restated exactly:** group tier-4 matches **by category**, compare the resulting station **sets**:

- 0 categories with rules → fall through to tier 5;
- 1 category with rules → use its set;
- N categories, all sets **equal** → use that set (a genuine agreement, not a conflict);
- N categories, sets **differ** → `ROUTING_CONFIGURATION_CONFLICT`, terminal.

Set comparison is order-independent and duplicate-insensitive (compare as sorted distinct id lists), so `{Grill, Packaging}` and `{Packaging, Grill}` agree.

**No category priority is invented; no arbitrary category is chosen.** The documented remedy for a conflicted item is an explicit **tier-3 MenuItem rule**, which by KDS-R1 wins before tier 4 is ever evaluated — so the escape hatch is always available and requires no new concept.

**Classification: ENGINEERING DECISION.** The SRS does not decide it because it did not model multi-category placement. Recorded here so a future reader does not mistake it for a source requirement.

---

## H. STATION MODEL

**Where it is stored, and why — settled, no change recommended.** `org.stations`, per **ratified D-07** (*"Station is an aggregate root within the Organisation context"*) and §25.1's schema map (`stations` under `org`). ADR 0008 ADR 0008 D-07 explicitly reconciled §7.3 #24's "Kitchen Ops" against §25.1's placement, weighing that *"four future contexts reference `org.stations(id)` directly"*. **Relocating Station to the `kitchen` schema now would reopen a ratified decision, break four FK paths, and deliver nothing this gate needs. Do not do it.**

**Delta required by FR-KDS-001 [M]:**

| Element | Current | Required | Assessment |
|---|---|---|---|
| name | ✅ `VARCHAR(64)`, unique per branch | ✅ | met |
| capacity | ✅ `capacity_config JSONB DEFAULT '{}'` | ✅ | met *structurally* — see below |
| **display colour** | ❌ **absent** | ✅ mandatory | **GAP — must be added** |

**`display_colour` representation.** Follow the repository's existing colour convention exactly: `catalogue.categories.colour` and `catalogue.menu_items.colour` are both `VARCHAR(9)` nullable (hex `#RRGGBBAA`). Recommend `display_colour VARCHAR(9) NULL` on `org.stations`. Nullable because FR-KDS-001 requires it be *configurable*, not that every station have one before it can exist; a null means "use the client default". This is an **additive, non-destructive** column.

**`capacity_config` semantics — NOT SOURCE-DECIDABLE, and typed validation is NOT required now.** The only requirements that would give it structure are **FR-KDS-045 [C]** (*"capacity warning when queued items at a station exceed configured throughput capacity for the next 15 minutes"*) and **FR-KDS-012 [S]** (prep-time-aware staggering). `[C]` and `[S]` are both outside this gate, and nothing in FR-KDS-001 specifies the shape. **Recommendation: leave it opaque JSONB, add no parser and no validation in the routing slice** — routing never reads it. Typing it belongs to the slice that implements FR-KDS-045.

**Station status/active — GAP, and it has a routing consequence.** There is **no** status or `is_active` column on `org.stations` (ADR 0008 D-07's own SQL evidence records *"No `tenant_id`, no status, no colour column, no uniqueness"*). Consequences:

- *Effect of disabling a station with active routing rules:* **there is no "disable" mechanism.** The only removal is deletion, which is **blocked** by `ON DELETE RESTRICT` from both `kitchen.station_routing_rules` and `org.print_routing`. So a station in use cannot be removed and cannot be deactivated. An operator's only path today is to delete every referencing rule first.
- *May the fallback reference an inactive station?* **Unanswerable as posed** — "inactive" does not exist. Once the fallback FK exists, a fallback station cannot be deleted while referenced (`ON DELETE RESTRICT`), which is the correct fail-closed behaviour.

**Recommendation:** do **not** invent a station status in this gate — no FR-KDS requirement mandates one, and inventing lifecycle semantics would exceed the mandate. **Record it as a source gap** (§P) and, if operators need it, resolve it in the station-management slice where activation/deactivation semantics can be designed properly. The routing resolver must **not** silently filter on a concept that does not exist.

**No station-management API is designed here.** This gate covers persistence integrity only, as §10 instructed.

---

## I. BRANCH KDS CONFIG

**Recommendation: a typed, one-row-per-branch table, `kitchen.branch_kds_config`.**

| Aspect | Design |
|---|---|
| Schema | `kitchen` — co-located with `station_routing_rules`, the table it is functionally a sibling of (both are FR-KDS-010 routing configuration) |
| Bounded context | **Organisation**, per ratified **ADR 0008 D-07** — *not* Kitchen. This is the KDS-R6 revision (§D) |
| Primary key | `branch_id` — enforces one row per branch by construction, no partial index needed |
| `tenant_id` | **Present.** Required for the D-09 composite FK to `org.branches`, and enables a direct RLS anchor instead of a traversal |
| `branch_id` | Present (also the PK) |
| `business_day` | **Absent** — configuration, not transactional; not in FR-DR-001's partition list |
| `fallback_station_id` | **Nullable** `UUID`. FR-KDS-010 tier 5 says *"Fallback station **configured** for the branch"* — configuration may be absent, and KDS-R10 then correctly fails closed |
| FK → tenant | `tenant_id → identity.tenants(id) ON DELETE RESTRICT` (repo precedent) |
| FK → branch | `(tenant_id, branch_id) → org.branches(tenant_id, id) ON DELETE CASCADE` — target exists (`@@unique([tenantId, id])`) |
| FK → station | `(branch_id, fallback_station_id) → org.stations(branch_id, id) ON DELETE RESTRICT` — target exists (`@@unique([branchId, id])`). **Makes "fallback belongs to another branch" unrepresentable** |
| Unique | PK suffices |
| CHECK | none required |
| Indexes | PK only; the table is at most one row per branch |
| RLS | `ENABLE` + `FORCE`; all four ops `USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)` — the **DIRECT anchor** pattern, fail-closed |
| Grants | `SELECT, INSERT, UPDATE, DELETE` to `ros_app`. Note: `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "kitchen"` **already grants these automatically** for new kitchen tables |
| Deletion | Cascades with the branch |
| Mutability | Freely mutable configuration (see §M) |

**Why not the three rejected alternatives:** `org.branches.fallback_station_id` — puts a Kitchen concern in the Organisation aggregate root and makes every branch write touch KDS config; `org.settings` — cannot express the station FK (and does not exist in this repository); untyped JSON anywhere — same FK objection, and directly contrary to §11.

**Ratification point, stated honestly:** §25.1 enumerates neither this table under `kitchen` nor any fallback column anywhere — the approved SQL has no fallback storage at all. Some new table is therefore **unavoidable** to satisfy FR-KDS-010 tier 5 [M]. The schema placement (`kitchen` vs `org`) is the one aspect warranting explicit ratification; the typed-relational shape is not optional if D-09 and §11 are to hold.

**Forward value (not designed here, but it makes the table the right shape):** FR-KDS-022 (*"configurable target"*), FR-KDS-023 (*"configurable per station"*), FR-KDS-025 (*"configurable period (default 30 minutes)"*), and FR-POS-035 (*"configurable per branch and per order type"*) all imply per-branch KDS configuration. A typed branch KDS config table is where those land — but **none of them is added now**.

---

## J. ROUTING RULE PERSISTENCE

**Evolve `kitchen.station_routing_rules` in place.** No replacement, no rule engine.

| Aspect | Design |
|---|---|
| Schema / context | `kitchen` schema (unchanged, §25.1-mandated); **Organisation** context per D-07 |
| Primary key | `id` (unchanged) |
| `tenant_id` | **ADD — the central change.** Not for the row's own RLS anchor (branch traversal already works and fails closed) but because the Catalogue selectors' tenant-safe FK targets are `(tenant_id, id)`, and without it those FKs are **impossible** — C-03's *"no column to compose with"*, applied to this table. ADR 0008 D-09's prescribed workaround (*"anchor sibling references on the **branch** composite"*) works for the **station** reference and is already in place, but is **structurally inapplicable to Catalogue selectors**, which are tenant-scoped and carry no branch. Precedent for the fix: D-INV-09 added `tenant_id` to `stock_levels`; register line 1626 records the pattern for *"parent-independent"* tables. Aligns with FR-PLT-003 [M] and the Prisma Catalogue header rule: *"tables that reference a SIBLING or cross-aggregate entity carry tenant_id so a composite tenant-safe FK (D-09) can be expressed."* **Additive change to a ratified shape (ADR 0008 D-06/D-09) — requires ratification.** |
| `branch_id` | present (unchanged) |
| `station_id` | present (unchanged) |
| `business_day` | **Absent** — configuration, not transactional |
| Selectors | `menu_item_id?`, `category_id?`, **`modifier_id?` (ADD)** — all nullable |
| CHECK | **ADD:** `(menu_item_id IS NOT NULL)::int + (category_id IS NOT NULL)::int + (modifier_id IS NOT NULL)::int = 1` — makes zero-selector and multi-selector rows **unrepresentable**. Closes a live defect (§C) |
| FK → station | `(branch_id, station_id) → org.stations(branch_id, id) ON DELETE RESTRICT` (unchanged) |
| FK → branch | **UPGRADE** to `(tenant_id, branch_id) → org.branches(tenant_id, id)` once `tenant_id` exists |
| FK → menu_item | **ADD:** `(tenant_id, menu_item_id) → catalogue.menu_items(tenant_id, id) ON DELETE CASCADE` — target exists. Precedent: `sales.order_lines` already has exactly this FK |
| FK → category | **ADD:** `(tenant_id, category_id) → catalogue.categories(tenant_id, id) ON DELETE CASCADE` — target exists (`@@unique([tenantId, id])`) |
| FK → modifier | **BLOCKED** — see §F/§P. Requires `catalogue.modifiers` to gain `tenant_id` + `(tenant_id, id)` unique first |
| Unique | **ADD:** `UNIQUE NULLS NOT DISTINCT (branch_id, menu_item_id, category_id, modifier_id, station_id)`. `NULLS NOT DISTINCT` is essential — with default NULL semantics two identical menu-item rules (both with `category_id`/`modifier_id` NULL) would **not** collide. **Direct repo precedent: ADR 0008 D-15**, where `org.print_routing`'s index was replaced with `UNIQUE NULLS NOT DISTINCT` precisely because *"Prisma emits a plain UNIQUE here, under which PostgreSQL treats NULLs as distinct."* PostgreSQL 16 supports it; **Prisma cannot express it, so the migration must patch it** — exactly as `print_routing` already does. **Crucially, ADR 0008 D-15 also decided this table's case explicitly**: *"Leave `station_routing_rules` unconstrained"*, because *"`station_routing_rules` uniqueness is **entangled with Catalogue keys that do not exist yet** and is **deliberately left open**."* Catalogue now exists — **the stated condition has expired, and D-15 anticipated this exact moment.** Adding uniqueness now completes a decision that was deferred, not one that was refused |
| Indexes | keep `(branch_id, station_id)`; **ADD** `(tenant_id, branch_id, menu_item_id)`, `(tenant_id, branch_id, category_id)`, `(tenant_id, branch_id, modifier_id)` — the three resolver lookup paths, each tier-1 selective |
| `priority` | **Retain physically, assign no semantics, never read.** §D/KDS-R9 |
| RLS | **SIMPLIFY** to the DIRECT anchor once `tenant_id` exists: `USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`. Cheaper than the current `EXISTS` traversal and structurally identical to `sales.order_line_modifiers` |
| FORCE RLS | **Required**, as today |
| Grants | already `SELECT, INSERT, UPDATE, DELETE` to `ros_app`; unchanged |
| Deletion | Rule rows are deletable. Cascade from a deleted selector (menu item/category/modifier) removes dependent rules |
| Mutability | Mutable configuration — see §M |

**Migration ordering note (analysis only, no SQL written):** adding `tenant_id` to an existing table requires backfilling from `org.branches` before `NOT NULL`; the table is empty in every environment (zero rows are ever written), so the backfill is trivial. The CHECK and UNIQUE constraints must be added **after** any backfill.

---

## K. LINE OVERRIDE PERSISTENCE

**Recommendation: `sales.order_line_station_overrides`**, modelled directly on the shipped `sales.order_line_modifiers`, which is the exact structural precedent (a non-partitioned child of a partitioned parent).

| Aspect | Design | Justification |
|---|---|---|
| Schema / context | `sales` / **Sales** | Order-entry intent; §7.3 #22 |
| Partitioned? | **No** | Not in FR-DR-001's list; matches `order_line_modifiers` (`PRIMARY KEY ("id")`, no `business_day` in PK) |
| Primary key | `id` | Same precedent |
| `tenant_id` | **Required** | Direct RLS anchor + composite FK |
| `business_day` | **Required** | Not for partitioning — it is a **mandatory FK component**, since `order_lines`' tenant-safe unique is `(tenant_id, id, business_day)` |
| `order_line_id` | Required | The line being overridden |
| `station_id` | Required | The destination |
| `branch_id` | **Required** | The only way to express `(branch_id, station_id) → org.stations(branch_id, id)`; `order_lines` carries no branch |
| `order_id` | **Required** (see prerequisite) | Needed to tie `branch_id` back to the order's branch |
| FK → tenant | `tenant_id → identity.tenants(id)` | Repo precedent |
| FK → line | `(tenant_id, order_line_id, business_day) → sales.order_lines(tenant_id, id, business_day) ON DELETE CASCADE` | **Target exists.** Verbatim precedent: `order_line_modifiers_line_fkey` |
| FK → station | `(branch_id, station_id) → org.stations(branch_id, id) ON DELETE RESTRICT` | Target exists |
| FK → order (branch tie) | `(tenant_id, order_id, business_day, branch_id) → sales.orders(tenant_id, id, business_day, branch_id)` | **PREREQUISITE — target does not exist** |
| FK → line↔order tie | `(tenant_id, order_id, order_line_id, business_day) → sales.order_lines(tenant_id, order_id, id, business_day)` | **PREREQUISITE — target does not exist** |
| Unique | `(tenant_id, order_line_id, business_day, station_id)` | Makes a duplicate station on one line **unrepresentable** |
| CHECK | none required | |
| Indexes | unique above serves lookup; add `(tenant_id, order_line_id)` mirroring `order_line_modifiers_tenant_line_idx` | |
| RLS | `ENABLE` + `FORCE`; four policies on `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid` | Verbatim `order_line_modifiers` pattern |
| Grants | `SELECT, INSERT, UPDATE, DELETE` to `ros_app` | |
| Deletion | `ON DELETE CASCADE` with the line | |
| Mutability | Governed by ratified **Clarification C** — see §M | |

**The branch-integrity prerequisite, stated exactly.** `sales.order_lines` has **no `branch_id`**, so "this override's station belongs to the order's branch" cannot be expressed with existing keys. Two options:

- **Option K-1 (RECOMMENDED — index-only, additive).** Add two unique indexes: `sales.orders (tenant_id, id, business_day, branch_id)` and `sales.order_lines (tenant_id, order_id, id, business_day)`. Both **include `business_day`**, which PostgreSQL requires for a unique index on a partitioned table — verified against the actual partition key. No column is added, no data is rewritten, nothing is destructive. The override row then carries `order_id` + `branch_id` and the three FKs above chain: station ∈ branch → branch = the order's branch → order owns the line. **Fully DB-enforced.** **Ratified precedent for exactly this manoeuvre: ADR 0008 D-16**, which added `UNIQUE (branch_id, id)` to an *Identity*-owned table purely to enable a composite FK, and characterised it as *"an **index only** — no column is added, no column is altered, no semantics change, and no Identity application code is touched."* K-1 is the same move on Sales-owned tables, and here the routing slice would own both sides.
- **Option K-2.** Add a `branch_id` column to `sales.order_lines` plus `(tenant_id, id, business_day, branch_id)` unique. Yields a smaller override row (no `order_id`), but adds a column to a partitioned, retention-managed table and denormalises branch onto every line. Heavier for no integrity gain.

**Recommend K-1.** Under either option the guarantee is complete; K-1 achieves it with two additive indexes.

**Retention interaction, recorded:** FR-DR-001 archives `order_lines` partitions after 24 months. A non-partitioned child with an FK to a partitioned parent constrains partition detachment. This is **pre-existing and identical** for `sales.order_line_modifiers`, which the repository already accepted with `ON DELETE CASCADE`. Following the same precedent keeps behaviour uniform; it is a known operational consideration for the archival slice, not a blocker here.

---

## L. TENANCY / RLS / FK DESIGN

**Every proposed FK, with its exact referenced key — verified to exist or explicitly marked a prerequisite:**

| FK | Referenced unique/PK | Status |
|---|---|---|
| `routing_rules(tenant_id, branch_id)` → `org.branches` | `@@unique([tenantId, id])` | ✅ exists |
| `routing_rules(branch_id, station_id)` → `org.stations` | `@@unique([branchId, id])` | ✅ exists (already in place) |
| `routing_rules(tenant_id, menu_item_id)` → `catalogue.menu_items` | `@@unique([tenantId, id])` | ✅ exists — needs `tenant_id` on the rule table |
| `routing_rules(tenant_id, category_id)` → `catalogue.categories` | `@@unique([tenantId, id])` | ✅ exists — needs `tenant_id` on the rule table |
| `routing_rules(tenant_id, modifier_id)` → `catalogue.modifiers` | **none — no `tenant_id` column** | ❌ **PREREQUISITE** |
| `branch_kds_config(tenant_id, branch_id)` → `org.branches` | `@@unique([tenantId, id])` | ✅ exists |
| `branch_kds_config(branch_id, fallback_station_id)` → `org.stations` | `@@unique([branchId, id])` | ✅ exists |
| `overrides(tenant_id, order_line_id, business_day)` → `sales.order_lines` | `@@unique([tenantId, id, businessDay])` | ✅ exists |
| `overrides(branch_id, station_id)` → `org.stations` | `@@unique([branchId, id])` | ✅ exists |
| `overrides(tenant_id, order_id, business_day, branch_id)` → `sales.orders` | **none** | ❌ **PREREQUISITE (K-1)** |
| `overrides(tenant_id, order_id, order_line_id, business_day)` → `sales.order_lines` | **none** | ❌ **PREREQUISITE (K-1)** |

**Why `tenant_id` on the rule table is load-bearing, not cosmetic.** ADR 0008 D-09 verbatim: *"PostgreSQL evaluates referential-integrity checks with row security **disabled**."* RLS therefore cannot make a cross-tenant selector reference impossible; only a composite FK can — ADR 0008 D-09's own words: *"unrepresentable, not validated."* Today a tenant-A branch rule can reference a tenant-B menu item, and nothing prevents it. ADR 0008 D-06 accepted the FK-less shape explicitly *"(Catalogue does not exist)"*; that condition has expired.

**What is preserved:** tenant isolation (direct anchor, fail-closed); branch-local stations (composite FK, unchanged); no cross-tenant selector references (after the prerequisite); no cross-branch routing target (already enforced); fail-closed RLS via `NULLIF(current_setting('app.tenant_id', true), '')::uuid` on every new table.

**Nothing in this design relies on application validation where PostgreSQL can enforce it** — with exactly two honestly-declared exceptions, both carried to §P: (1) the modifier selector's tenant safety, blocked on a Catalogue-owned change; (2) station "inactive" filtering, blocked on a status concept the schema does not define.

**RLS strategy per table:** `kitchen.station_routing_rules` — migrate PARENT → DIRECT anchor (simpler, cheaper, same fail-closed guarantee). `kitchen.branch_kds_config` — DIRECT. `sales.order_line_station_overrides` — DIRECT. All `ENABLE` + `FORCE`. All four operations policied. `ros_app` remains `NOBYPASSRLS` (verified in prior runs and unchanged by this gate).

---

## M. HISTORICAL / MUTABILITY SEMANTICS

**When is routing resolved? — SOURCE-DECIDED: at Fire time (option A).**

Two independent pieces of evidence, and the gate's warning against inferring from pricing is well-founded — the pricing evidence in fact points the *other* way and is what makes the answer clean:

1. **UC-POS-01 step 6** sequences it explicitly: *"Waiter fires course 1. System transitions order to OPEN, creates tickets, **routes each line to its station per FR-KDS-010**, records first_fired_at."* Routing is an action *of* firing, not of line entry.
2. **BR-POS-004** enumerates *exactly* what must be snapshotted at sale time: *"item_name_snapshot, unit_price, tax_class_id, unit_cost_snapshot, and recipe_version_id SHALL be captured at the time of sale and SHALL NOT be recomputed from current master data."* **Station routing is deliberately not in that list.** The rule is specific and closed, and BR-POS-004's rationale is about *financial reproducibility* — reports must show the price actually charged. Routing has no such reporting obligation. Note the contrast: FR-POS-040 says price is *"evaluated at order time"* while FR-KDS-010 assigns no timing at all, deferring to the use case.

**Consequences, worked through as §8 required:**

| Scenario | Behaviour |
|---|---|
| Config changed while order is DRAFT | Fire uses the config **current at Fire**. Nothing was resolved earlier, so nothing is stale |
| Firing a held course later | Resolved **at that fire**, with config current then. Different courses of one order may legitimately route differently if config changed between fires — correct, since each fire is a separate release to production |
| Amendment lines (FR-POS-038) | Resolved when the amendment fires. The amendment joins the **existing** ticket for its station (FR-KDS-028: *"never as a new ticket"*) |
| Already-fired lines when config changes | **Never re-resolved.** Their destination is already durable as Ticket/TicketLine rows. A config update cannot retroactively move fired work — this is precisely why routing needs no versioning |
| Offline POS | Tier 1 (line override) is captured offline as order data and travels with the line. Tiers 2–5 need branch config, which NFR-REL-003 requires to work on the local network. Full offline resolution is an **Offline/KDS concern outside this gate** |
| Replay / idempotency | The resolver is a pure function of `RoutingContext` + rules; re-running Fire under `@Idempotent()` replay returns the stored response without re-resolving |

**Routing-rule mutability — versioning is NOT required. Stated with its reasoning:**

- No FR-KDS requirement imposes effective-dating, versioning, or history on routing rules. FR-KDS-040's timestamps are on **tickets and lines**, not rules.
- **Do not import Pricing's history rules.** Price lists are versioned because BR-POS-004 and FR-POS-042 impose financial reproducibility. Routing carries **no equivalent obligation** (§D/KDS-R10). Copying that machinery would be inventing a requirement.
- The correctness concern — *"a routing configuration update must not corrupt already-fired kitchen intent"* — is **already fully answered** by resolve-at-Fire: fired intent is materialised as Ticket rows, which a rule change cannot reach.

**Therefore: rules are mutable configuration.** Create / update / delete are ordinary operations. **Deactivation:** no `active` flag is recommended (ADR 0008 D-06 records its absence; no requirement asks for one), and with the proposed unique + CHECK constraints, deleting a rule is unambiguous and safe.

**Audit implications, analysed as required.** Routing configuration changes are **not** currently audited, and no FR-KDS requirement mandates it. However **FR-AUD-003**-class append-only auditing is the repository's established pattern for configuration mutations, and a future station-management API would be the natural place to audit rule create/update/delete — the same way `stations.service.ts` already audits. **Recommendation: the implementation slice should audit rule mutations** through the existing `AuditService` (no new mechanism, no new table), while **not** versioning the rows. This is an ENGINEERING RECOMMENDATION, not a source requirement.

---

## N. FUTURE MODULE INTERACTION

**Recommended shape: Sales publishes; Kitchen subscribes and resolves. Sales never calls Kitchen, and needs no routing interface at all.**

Under §5.3.1's context map (`Sales ──(published events)──▶ Kitchen Ops`) and the accepted P1E-1 infrastructure:

```
Fire (Sales, inside UnitOfWork.execute)
  ├── validates + transitions order DRAFT → OPEN, sets first_fired_at, line.state → fired
  └── ctx.publishEvent({ eventType: 'order.line.fired', ... })      ← Sales' own contract
             │  (queued; dispatched in-transaction at UoW drain)
             ▼
  Kitchen's PRIVATE @DomainEventHandler('order.line.fired')
       ├── resolves routing internally (§E) — Kitchen-private resolver
       ├── creates Ticket / TicketLine on ctx.tx  (NOT this gate)
       └── throws on ROUTING_NO_DESTINATION / ROUTING_CONFIGURATION_CONFLICT
                        │
                        ▼
             dispatcher propagates → UoW rejects → PostgreSQL ROLLBACK → Fire fails
```

**Why this shape and not a synchronous `KitchenRoutingResolver.resolve(...)` call from Sales:**

- Sales must **not** create Kitchen state (§5.2.3). If Sales called a resolver and then wrote tickets, it would own Kitchen's data.
- The event route needs **no new cross-module interface at all** — Sales imports nothing from Kitchen. It avoids adding to the 21 recorded boundary deviations, and avoids repeating the `sales->catalogue: ['pricing/price-resolution.service']` pattern that `module-boundaries.spec.ts` already records as debt to be closed.
- KDS-R10's fail-closed requirement is satisfied *by construction* through P1E-1's accepted in-transaction dispatch — no new mechanism.
- The resolver stays **entirely private to Kitchen**, which is where FR-KDS-010 behaviour belongs (ADR 0008 D-06: *"FR-KDS-010's resolution precedence is the behaviour, and it stays out"* of the Phase 15 scope).

**Concrete consequence for the Sales contract — the current event payload is insufficient.** `OrderLineFiredPayload` today carries only `orderId`, `businessDay`, `orderLineId`, `course`. Kitchen cannot route from that: it would need to read `sales.*` tables, which §5.2.3 forbids (*"A module MUST NOT query another module's tables"*). The payload must therefore be **extended** to carry what routing needs:

`menuItemId`, `selectedModifierIds[]`, `categoryIds[]`, `lineStationOverrideIds[]`
(`tenantId` and `branchId` are already on the **envelope** — no payload duplication needed.)

**This extension is free right now.** P1E-1C verified that **no producer publishes `order.line.fired`** anywhere. Extending the payload before a producer exists breaks nothing and needs no event-version bump. Deferring it until after Fire ships would make it a breaking contract change. **Flagged as a concrete input to the Fire slice, not implemented here.**

**Nothing was implemented:** no `/fire` route, no Ticket/TicketLine, no subscriber, no publisher, no permission. Verified by grep (§Q).

---

## O. FUTURE TEST MATRIX

Not written this run. Specified for the implementation slice.

**TIER PRECEDENCE**
1. Line override present + modifier rule present → result is the override set, `tier = 1`
2. Modifier rule present + MenuItem rule present → modifier set, `tier = 2`; MenuItem stations absent from result
3. MenuItem rule present + category rule present → MenuItem set, `tier = 3`
4. Category rule present + fallback configured → category set, `tier = 4`
5. Tiers 1–4 all empty + fallback configured → `[fallback]`, `tier = 5`

**MULTI-STATION**
6. Two override rows, same station → single station returned (dedupe)
7. Two modifiers → two stations → distinct union, `tier = 2`
8. Two MenuItem rules → two stations → distinct union, `tier = 3`
9. **FR-KDS-011 proven**: one line resolves to `{Grill, Packaging}` (the UC-KDS-01 burger)

**MULTI-CATEGORY**
10. Item in one category with a rule → resolves, `tier = 4`
11. Item in two categories, **identical** station sets → resolves to that set
12. Item in two categories, **differing** sets → `ROUTING_CONFIGURATION_CONFLICT`; does **not** fall through to fallback
13. Same conflicted item **plus** an explicit MenuItem rule → resolves at `tier = 3`; tier 4 never evaluated

**INTEGRITY (DB-level — each asserts the write is *rejected*, not that code declined it)**
14. Rule referencing another tenant's menu item → FK violation *(requires the `tenant_id` prerequisite)*
15. Rule targeting another branch's station → FK violation
16. Rule referencing a non-existent selector → FK violation
17. Row with two selectors non-null → CHECK violation
18. Row with zero selectors → CHECK violation
19. Duplicate `(branch, selector, station)` → unique violation *(proves `NULLS NOT DISTINCT` works — a plain UNIQUE would let this through)*
20. Fallback station deleted while referenced → `ON DELETE RESTRICT` violation; and: no `fallback_station_id` configured + no other tier → `ROUTING_NO_DESTINATION`

**LINE OVERRIDE**
21. Override FK resolves against the partitioned line via `(tenant_id, order_line_id, business_day)`
22. One line, two override rows, two stations → both returned
23. Duplicate station for one line → unique violation
24. Tenant A cannot read or write tenant B's overrides
25. Post-fire mutation policy: mutation attempt on an override whose line is `fired` is refused, per ratified **Clarification C** (*"AFTER a line is fired — the cashier SHALL NOT directly mutate that fired content"*)

**RESOLUTION**
26. All tiers empty → `ROUTING_NO_DESTINATION`; no partial state; (once Fire exists) the transaction rolls back
27. Result ordering is deterministic and stable across repeated runs and across insertion orders
28. `tier`, `tierLabel`, and `sourceIds` correctly identify the winning tier and the exact rules that produced it
29. Same `RoutingContext` + same rows → byte-identical result (pure function; no clock, no ambient state)

**RLS**
30. No tenant context set → zero rows visible on all three tables (fail closed)
31. Tenant A cannot observe tenant B's rules, branch KDS config, or overrides
32. `ros_app` is `NOBYPASSRLS` (`rolbypassrls = false`)
33. `ENABLE` **and** `FORCE` verified on all three tables via `pg_class.relrowsecurity` / `relforcerowsecurity`

---

## P. UNRESOLVED ITEMS / SOURCE GAPS

**BLOCKERS to a routing migration (precise, not ambiguous):**

1. **`catalogue.modifiers` has no `tenant_id`** → tier 2's tenant-safe FK is impossible. Requires `tenant_id` + `(tenant_id, id)` unique on a **Catalogue-owned** table. Under §5.2.3 (*"Database migrations are owned by exactly one module"*) the routing slice cannot make this change unilaterally. **Options:** (a) a small Catalogue slice adds it first — recommended, and it also fixes the pre-existing FK-less `sales.order_line_modifiers.modifier_id`; (b) ship tiers 1/3/4/5 first and add tier 2 after; (c) accept a plain non-tenant-safe FK — **not recommended**, contrary to ADR 0008 D-09.
2. **Two missing unique indexes** for the line-override branch tie (Option K-1): `sales.orders (tenant_id, id, business_day, branch_id)` and `sales.order_lines (tenant_id, order_id, id, business_day)`. Both additive, both partition-key-valid, both Sales-owned — the same slice can add them.

**RATIFICATION REQUIRED (no D-number created here):**

3. **Adding `tenant_id` + uniqueness + selector FKs to `kitchen.station_routing_rules`** — additive, but it changes a shape ADR 0008 D-06/D-09 ratified as the "PARENT anchor" design. Strong precedent exists (D-INV-09 on `stock_levels`), and both ADR 0008 D-06's stated reason for the FK-less selectors (*"Catalogue does not exist"*) and ADR 0008 D-15's stated reason for leaving uniqueness open (*"entangled with Catalogue keys that do not exist yet"*) have expired.
4. **Creating `kitchen.branch_kds_config`** — ADR 0008 D-11 defers `org.settings`, and §25.1 enumerates neither this table nor any fallback storage. Some new table is unavoidable for FR-KDS-010 tier 5 [M]; the `kitchen`-vs-`org` placement is the ratifiable point.
5. **KDS-R3 (modifier replaces lower tiers)** and **KDS-R5 (multi-category conflict fails closed)** — both are engineering decisions on points the SRS does not decide. They are internally consistent and defensible, but they are *decisions*, and are recorded as such rather than presented as source requirements.

**SOURCE GAPS (no requirement decides these):**

6. **Station has no status/active concept.** No FR-KDS requirement mandates one. Consequence: "may the fallback reference an inactive station?" is unanswerable as posed, and the resolver must not filter on a concept the schema lacks (§H).
7. **`capacity_config` has no defined shape.** Only `[C]`/`[S]` requirements would give it structure. Leave opaque; routing never reads it.
8. **`station_routing_rules.priority` has no source meaning** (§D/KDS-R9). Retain, assign nothing, never read.
9. **FR-PLT-003 [M] vs. the PARENT-anchor pattern.** *"Every tenant-scoped record SHALL carry an immutable tenant_id"* is in tension with `org.stations`/`org.tables`/`org.operating_hours`/`org.print_routing` carrying none. This gate does **not** propose changing those — it proposes `tenant_id` only on `station_routing_rules`, and only because the Catalogue FKs require it. The broader tension is recorded, not resolved.
10. **Expediter (Pass) is not a routing destination** (FR-KDS-013 `[S]`). Recorded so the implementation does not model it as one (§D/KDS-R2).

**FIRE AUTHORIZATION: NOT SOURCE-DECIDABLE / UNRESOLVED.** No authoritative material discovered in this run decides it. §15.2's Sales permission group contains no fire/send code and Appendix C is absent from the SRS. **Unchanged by this gate; no permission created, no code broadened, no governance edited.**

---

## Q. P1E-2 EXIT

```
P1E-2 ROUTING SEMANTICS CLOSED:  YES
P1E-2 PERSISTENCE DESIGN CLOSED: YES
P1E-2 TENANCY/FK DESIGN CLOSED:  YES
P1E-2 MIGRATION-READY:           NO
P1E-2 OVERALL COMPLETE:          YES
```

All twenty §18 questions are answered without ambiguity: five-tier semantics (§E), multi-station union (§D/R2), modifier semantics and identity (§D/R3, §F), tier 3 fixed at MenuItem (§D/R4), multi-category conflict behaviour (§G), fallback ownership and storage (§I), line-override ownership and storage (§K), selector model (§J), `priority` treatment (§D/R9), zero-route behaviour (§E), station delta (§H), tenant/RLS strategy (§L), every composite FK shape with its exact referenced key (§L), CHECK/UNIQUE constraints (§J, §K), indexes (§J, §K), deletion/mutability (§M), module ownership (§N), future interaction boundary (§N), unresolved items (§P), and blockers (§P).

**MIGRATION-READY is NO deliberately, and the distinction matters:** no persistence-critical *ambiguity* remains — every shape is decided — but two concrete schema prerequisites and two ratification points must land before a migration can be written **as designed**. Tiers 1, 3, 4 and 5 are fully migration-ready once items 2–4 of §P land; tier 2 additionally needs item 1, which is Catalogue-owned. Claiming YES would misrepresent a cross-module dependency as absent.

**OVERALL COMPLETE is YES** because this gate's mandate — closing the semantics and producing the design — is discharged; the remaining items are *identified dependencies*, not open questions.

**Nothing was implemented.** No Prisma model, no migration, no SQL, no service, no resolver, no permission, no governance edit, no `D-21`.

---

## R. NEXT SINGLE HIGHEST-LEVERAGE SLICE

## → **A. KDS ROUTING PERSISTENCE IMPLEMENTATION** (schema + resolver, prerequisites included in scope)

**WHY NOW.** This gate exists to make FR-KDS-010 implementable, and it succeeded for four of five tiers with every constraint, FK, index and RLS predicate specified. The prerequisites are small, additive and fully enumerated (§P items 1–4): two unique indexes, one `tenant_id` column on an empty table, one new one-row-per-branch table, and one Catalogue column. Choosing anything else leaves this gate's output as another unused table — the exact condition (`station_routing_rules` exists, zero code touches it) that made this gate necessary. It is also the last purely-additive Kitchen work that can proceed *without* resolving Fire authorization or the six open Ticket/TicketLine conflicts.

**EXACT SRS REQUIREMENTS.** FR-KDS-010 [M] (five-tier precedence — tiers 1/3/4/5 fully, tier 2 after its prerequisite), FR-KDS-011 [M] (multi-station), FR-KDS-001 [M] (`display_colour` — the one mandatory Station gap), FR-PLT-003 [M] and D-09/D-INV-09 (tenant-safe composite FKs), FR-DR-001 [M] (partition-safe FK shapes).

**DEPENDENCIES.** §P items 2–4 (Sales indexes, `tenant_id` on the rule table, `branch_kds_config`) are in-scope for the slice itself. §P item 1 (Catalogue `modifiers.tenant_id`) is the only cross-module dependency and gates **tier 2 only**.

**SOURCE-READY: YES** for tiers 1, 3, 4, 5 and for the Station `display_colour` delta. **PARTIAL** for tier 2, pending the Catalogue change.

**BLOCKERS.** (1) `catalogue.modifiers` needs `tenant_id` + `(tenant_id, id)` unique — Catalogue-owned, blocks tier 2 only. (2) Ratification of §P items 3–4 before the migration is written. Neither is an unknown; both are specified.

**WHAT IT UNLOCKS.** A real, tested routing resolver with the §O matrix behind it; the last configuration substrate Fire needs; and — once Ticket/TicketLine design closes and Fire authorization is ratified — a Fire slice with no remaining routing unknowns. It also closes three live integrity defects that exist in the repository today: rules with zero or multiple selectors, duplicate selector→station rows, and cross-tenant selector references.

**Not implemented in this run.**

---

## S. COMMIT READINESS

```
COMMIT READY: YES
COMMITTED:    NO
```

This was an analysis-only gate. **No source file, Prisma model, migration, or governance document was modified** — the only files written are this report and its `INDEX.md` row. Verified: `git status --short` count unchanged at 70 entries before and after; HEAD unchanged at `e5648fb`; 20 migrations unchanged; no `D-21` or later anywhere; no Fire route, no Fire permission, no Ticket/TicketLine model, no Payment, no Outbox; the local dev database was not touched (not connected to at all this run).

No commit was created and no destructive git command was used.
