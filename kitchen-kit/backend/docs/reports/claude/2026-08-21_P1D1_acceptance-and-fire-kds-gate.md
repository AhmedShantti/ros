# P1D-1 Acceptance Corrections + P1E Fire/KDS Source & Architecture Gate

**Report type:** Claude Code implementation/design/verification evidence
**Authority:** Non-authoritative evidence; SRS and ratified governance remain authoritative
**Date:** 2026-08-21
**HEAD:** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Branch:** `feat/production-spec`
**Working tree:** accumulated uncommitted P0/P1A–P1D work retained throughout; this run added one new file (`src/modules/module-boundaries.spec.ts`) and this report, and modified 6 files under Phase A corrections (see Section O) — no commit made
**Claude task:** P1D-1 acceptance corrections (Phase A) + P1E Fire/KDS source & architecture gate (Phase B, analysis only)

> **Run status:** Phase A corrections implemented and verified. Phase B is **analysis only** — no Fire, no Kitchen tables, no Payment, no event bus, no outbox, no governance amendment, no commit.

---

# A. STARTING REPOSITORY STATE

| Fact | Handoff claim | Verified |
|---|---|---|
| HEAD | `e5648fb03d4ba319a0d7415c72342a278f93e59a` | ✅ `e5648fb docs(governance): ratify D-14 through D-20` |
| Branch | `feat/production-spec` | ✅ |
| Uncommitted work | accumulated, retained | ✅ 32 modified tracked + 31 untracked paths; nothing discarded |
| Migrations | 20 | ✅ 20 directories + `migration_lock.toml` |
| Latest migration | `20260820160000_shift_drawer_cash_session_open` | ✅ |
| Unit tests | 598 | ✅ (now 603, +5 architecture tests) |
| E2E | 549 | ✅ (now 550, +1 net) |
| Total | 1147 | ✅ (now **1153**), 0 skipped, 0 todo |
| TS baseline | `access-token.service.spec.ts(28,7) TS2322` | ✅ exactly one error, unchanged |
| Local dev DB | untouched, 5 unapplied migrations, 78 `price_lists` rows | ✅ verified before and after; **still 5 / 78** |

**Deviations from handoff: none.** All facts confirmed.

**One source fact the handoff did not carry, and it is decisive for this run:**

> **VERIFICATION EVIDENCE — `ROS_SRS_v1.0.pdf` has 161 pages and ends at §29.5 (`FR-OPS-031`). Appendix A, B and C do not exist in the document.** "Appendix C" appears once, as a forward reference at §15.2 ("the full catalogue is maintained in Appendix C"); "Appendix B" appears once at §28.1. Both are dangling. `FR-PLT-041`, cited as mandating the outbox at §5.5.3, is likewise never defined anywhere in the document.

This is **RATIFIED GOVERNANCE**, not a new discovery — decision **D-20** already records it verbatim: *"§15.2 supplies no approval-read code — and Appendix C, which §15.2 designates authoritative, is ABSENT from the SRS."* D-20's answer was to **defer the permission code rather than invent one**. Phase A applies the same, already-ratified reasoning.

---

# B. P1D-1 ACCEPTANCE REVIEW

## 1. CashSession GET authority — **DEFECT CONFIRMED · CORRECTED**

**Evidence.** `treasury.controller.ts:124-133` exposed `@Get(':id')` guarded by `@RequirePermission(TREASURY_PERMISSIONS.CASH_SESSION_OPEN)` — the same code as the POST.

Exhaustive search of §15.2's Cash group returns exactly eight codes: `cash.session.open` ("Open a shift"), `cash.session.close`, `cash.session.close_other`, `cash.drawer.open_no_sale`, `cash.payin`/`cash.payout`, `cash.safedrop`, `cash.variance.approve`, `cash.day.close`. **No read code.** Appendix C, the designated authoritative catalogue, is absent. Governance contains no CashSession read clarification — unlike Sales, where `sales.permissions.ts` records a reasoned read position for `pos.order.create` ("Create and **modify** orders" — a modifier must be able to read what it modifies). `cash.session.open` carries no such implication: opening a drawer does not entail reading arbitrary sessions.

**Correction.** The public route is **withdrawn**. `cash.session.read` was not invented, `cash.session.open` was not reinterpreted, `cash.session.close` was not borrowed, no report permission was used, and no unguarded read was exposed. `CashSessionsService.findOne` survives as an internal, RLS-scoped query for the future Payment/Treasury slices.

**Files.** `treasury.controller.ts`, `treasury.module.ts`, `cash-sessions/cash-sessions.service.ts`, `test/cash-session.e2e-spec.ts`.

**Result.** Public Treasury surface is now exactly `POST /cash-sessions`. **No new permission code.** Verified by live route introspection.

## 2. Workforce contract boundary — **DEFECT CONFIRMED · CORRECTED**

**Evidence.** `cash-sessions.service.ts:53-54` imported `SHIFT_OPENER` and `ShiftOpener` from `../../workforce/shifts/shift.port` — a private subdirectory.

**SRS REQUIREMENT §5.2.3** lists, under rules "enforced mechanically, not by convention": *"A module MUST NOT import from another module's internal directory"* (enforcement: ESLint boundary rule + CI), *"Cross-module communication is via a published interface or a domain event"* (enforcement: architecture test suite), and *"Every module publishes a versioned contract in `modules/<name>/contract/`"*. **§5.4** marks `contract/` **"PUBLIC. Other modules may import only this."**

The repository had **no `contract/` directory anywhere**. The alternative convention the prior run cited (`*.port.ts` in a private subdirectory, as used by `tax-class.port.ts` and `recipe-cost.port.ts`) is **not** SRS-compliant — it is the same defect in two older slices.

**Correction.** Published `src/modules/workforce/contract/` per §5.4 (`types.ts` = DTOs crossing the boundary, `commands.ts` = commands the module accepts, `index.ts` = barrel). `shift.port.ts` removed; `ShiftsService`, the Shift row and all future Workforce concerns stay private. Added `src/modules/module-boundaries.spec.ts` — a static architecture test that reads the source tree with no container and no database.

**Result.** Treasury imports only `modules/workforce/contract`. Enforced mechanically, and **the enforcement surfaced the true scale of the debt**: 21 module pairs across the repo import private directories. Per the instruction not to refactor unrelated modules, each is recorded by **exact inner path** in a documented allow-list, split into (a) cross-cutting HTTP/auth plumbing that belongs in `shared/` per §5.2.3, and (b) five genuine domain edges needing their own `contract/`. A *new* private path — even between an already-listed pair — fails the suite. The debt can shrink; it cannot grow. `workforce` appears in neither list.

## 3. FR-SEC-028 classification — **NO REPOSITORY DEFECT**

**Evidence.** FR-SEC-028 [M] requires **both** halves: *"Terminals SHALL be individually registered, and the System SHALL support revoking a terminal's registration, immediately invalidating its credentials **and wiping its local data on next contact**."*

The repository **already classifies it correctly**:

- `docs/reconciliation/PHASE_1_SRS_REQUIREMENT_MAP.md:130` → **PARTIAL**, gap named as "Offline/local store (absent) for the wipe half"
- `docs/RECONCILIATION_POST_PRODUCTION.md:940` → **PARTIAL**
- Grep for any `FR-SEC-028` + COMPLETE claim returns **nothing**

The overclaim existed **only in the prior Claude report**, not in the repository. No governance edit was needed or made.

**Correction (durable, code-comment only).** Added an explicit scope note to `treasury.controller.ts` stating that registration/revocation enforcement is COMPLETE **on this path**, and that FR-SEC-028 remains **globally PARTIAL** because the offline wipe half needs a local store that does not exist. This prevents recurrence at the point where the claim was made.

## 4. P1D-G consistency — **NO CONFLICT · NO CHANGE NEEDED**

Searched docs, code comments, tests and all P1D-touched files for `"card needs no drawer"`, `"external/manual card"`, `"electronic … no session"`, `"no cash session"` and equivalents. **Zero matches.** The only `"no drawer"` hits are `drawers.service.ts:8` / `treasury.module.ts:23-24`, which say the SRS defines *no drawer-management endpoint* — an unrelated statement about routes.

The ratified register text (`GOVERNANCE_DECISION_REGISTER.md:5437-5450`) stands intact and says the opposite of the prior report:

> *"A future ordinary POS-collected Payment must be attributable to: Employee · Operational Shift · CashSession · Drawer (via the session) · Terminal · tenant · branch. That applies to cash **and** to ordinary POS electronic tenders, because FR-FIN-010 [M] requires per-session totals by tender type. But only physical cash affects physical cash… a card payment appears in the session's tender totals and never in its drawer balance."*

**No governance conflict. Repository/governance truth remains P1D-G.** The contradiction was report-only.

---

# C. P1D-1 CORRECTIONS IMPLEMENTED

**Route withdrawal**

- `treasury.controller.ts` — deleted the `@Get(':id')` handler; dropped now-unused `Get`, `NotFoundException`, `Param`, `ApiNotFoundResponse` imports and the class-level 404 decorator; rewrote the route-surface docblock with the source reasoning; added the FR-SEC-028 scope note.
- `treasury.module.ts` — docblock corrected from "and read one session" to the single-route surface, with the Appendix-C/D-20 reasoning and the new contract-boundary statement.
- `cash-sessions/cash-sessions.service.ts` — `findOne` documented as INTERNAL ONLY with its justification; **behaviour unchanged**.

**Contract boundary**

- **NEW** `workforce/contract/types.ts` — `OpenShiftCommand`, `OpenedShift`.
- **NEW** `workforce/contract/commands.ts` — `SHIFT_OPENER`, `ShiftOpener`, plus the §5.5.1 reasoning for a synchronous in-transaction call rather than an event.
- **NEW** `workforce/contract/index.ts` — barrel.
- **REMOVED** `workforce/shifts/shift.port.ts` (untracked, created by P1D-1 in this same uncommitted set; content preserved and relocated, nothing lost).
- `workforce/shifts/shifts.service.ts`, `workforce/workforce.module.ts`, `treasury/cash-sessions/cash-sessions.service.ts` — imports repointed to `contract`.

**Architecture enforcement**

- **NEW** `src/modules/module-boundaries.spec.ts` — 5 tests: Treasury↛Workforce-private; Workforce publishes via `contract/`; nothing anywhere imports a Workforce internal; no module imports outside a published contract or a recorded path; the recorded-deviation set is exact.

**Tests**

- `test/cash-session.e2e-spec.ts` — the HTTP `GET` test replaced by (a) internal read works + HTTP returns 404 with a positive control proving route-absence rather than a missing row, (b) the internal query does not leak across tenants; route-introspection expectation tightened to `['/cash-sessions']`.

**No** schema change, **no** migration, **no** permission code, **no** governance edit, **no** behaviour change to opening, idempotency, RLS or audit.

---

# D. P1D-1 VERIFIED STATUS

```
P1D-1 OPERATIONAL SHIFT FOUNDATION:  COMPLETE
P1D-1 DRAWER FOUNDATION:             COMPLETE
P1D-1 CASH SESSION OPEN:             COMPLETE
P1D-1 ACCEPTED AFTER CORRECTION:     YES
```

Each is scoped to the narrow slice named and nothing wider. Every acceptance gate holds: public API uses source-supported authority (one route, one SRS-verbatim code); no private cross-module import remains on the Workforce↔Treasury edge; DB invariants, RLS, idempotency and audit are unchanged and re-verified; no broader overclaim remains.

```
FR-POS-090:  PARTIAL
FR-SEC-028:  PARTIAL
```

**FR-POS-090 is PARTIAL, not COMPLETE.** It has two halves: *"A cashier SHALL be required to open a shift, declaring an opening float, **before processing sales**."* Half one is implemented. Half two is **not enforced** — grep of `src/modules/sales/**` for `cashSession`/`shift` returns nothing but an unrelated `business-day.ts` variable. `POST /orders` and `POST /orders/:d/:id/lines` succeed with no open cash session. The precondition is real and unimplemented.

**FR-SEC-028 is globally PARTIAL** — registration/revocation enforced; local-data wipe on next contact absent (needs an offline store).

Explicitly **not** claimed: `shift.opened` event architecture (no bus, no outbox), CashSession lifecycle (no close, no count, no variance, no day close).

---

# E. CURRENT ORDER STATE MACHINE

**IMPLEMENTATION FACT** — `POST /orders` writes `state: 'draft'` (`orders.service.ts:270`). This matches the SRS exactly.

Executable table (`order-state.ts:71-82`, `TRANSITIONS`, frozen) vs SRS §7.4.1 diagram:

| From | Current executable | SRS | Mismatch |
|---|---|---|---|
| `draft` | `open`, `cancelled` | `OPEN` (via **fire**) | `draft → cancelled` is **NOT in the SRS diagram** — engineering addition |
| `open` | `held`, `parked`, `cancelled` | `HELD`, `PARKED`, `PARTIALLY_PAID` (pay), `CANCELLED` (void_all) | **`open → partially_paid` MISSING** (no payment) |
| `held` | `open`, `cancelled` | `OPEN` (resume) | `held → cancelled` **not in diagram** |
| `parked` | `open`, `cancelled` | `OPEN` (resume) | `parked → cancelled` **not in diagram** |
| `partially_paid` | *(terminal)* | `COMPLETED` (full payment) | **`partially_paid → completed` MISSING** — and unreachable anyway |
| `completed` | *(terminal)* | `PARTIALLY_REFUNDED` (refund) | **MISSING** (no refund) |
| `cancelled` | *(terminal)* | terminal | none |
| `partially_refunded` | *(terminal)* | `REFUNDED` | **MISSING** |
| `refunded` | *(terminal)* | terminal | none |

**Answers to the four required proofs:**

1. **`POST /orders` creates `DRAFT`.** Source-correct per UC-POS-01 step 1.
2. **Lines may be added in `draft`, `open`, `held`** (`assertMayAddLine`, lines 173-184). `open` is deliberately included and is **source-correct**: UC-POS-01 step 8 ("Waiter fires subsequent courses") and FR-POS-038 ("Adding a line to an already-fired order SHALL create an amendment ticket") both require post-fire additions.
3. **Fire is supposed to** transition `DRAFT → OPEN`, create tickets, route each line per FR-KDS-010, record `first_fired_at`, publish `order.line.fired` (UC-POS-01 step 6). The transition `draft → open` **exists and is legal in code today**, reachable only through the internal `changeState` service method — **no route exposes it**, and no ticket/routing/event consequence exists.
4. **`OPEN` does NOT mean pre-fire anywhere in code.** No comment, constant or branch treats it so.
5. **The earlier implementation did NOT use `OPEN` as "editable draft".** `draft` is the created state; `open` is a legal *target* of fire.

Two further gaps: `orders.firstFiredAt` and `order_lines.firedAt`/`state` exist in the schema and are **never written** by any code path; `order.opened` (§5.5.4, Sales → Kitchen Ops/Analytics) is never published.

---

# F. STATE NAMING CONFLICT

```
STATE NAMING CONFLICT: NO
```

The premise — that governance says *"OPEN / before Fire = cashier editable"* — **is not what the ratified register says.** The exact text (`GOVERNANCE_DECISION_REGISTER.md:5102-5113`, **CLARIFICATION C — Fire authority boundary**) is **line-scoped, never order-state-scoped**:

> 1. **BEFORE a line is fired** — the cashier may correct or edit normally…
> 2. **AFTER a line is fired** — the cashier **SHALL NOT** directly mutate that fired content…
> 3. **AFTER COMPLETED** — neither cashier nor manager directly modifies the original order.

The word `OPEN` does not appear in Clarification C. The register never equates `OPEN` with pre-fire.

The code matches exactly: `assertCashierMayMutateLine(orderState, lineState)` keys the fire lock on **`OrderLineState`** (`pending` vs `fired`/`preparing`/`ready`/`served`), with `assertOrderMutable(orderState)` layered on top for BR-POS-001. The order-level state is used only for finalisation, never as a fire proxy.

This is also the only coherent reading: an order can be `OPEN` with some lines fired and others `pending`, which is precisely what UC-POS-01 step 8 and FR-POS-038 describe. A state-level lock could not express that.

**Nothing to resolve. No governance amendment. No rename. Fire is not blocked on this.** The post-fire lock is currently absolute for the cashier and the privileged path is unexposed — correct per Clarification C's binding constraint, and `pos.order.cancel_after_production` is not broadened.

---

# G. FIRE AUTHORIZATION

```
FIRE AUTHORIZATION SOURCE-DECIDED: NO  —  NOT SOURCE-DECIDABLE
```

**Exhaustive permission evidence.** §15.2's complete Sales group:

`pos.order.create` · `pos.order.void_line_prefire` · `pos.order.void_line_postfire` · `pos.order.cancel` · `pos.order.cancel_after_production` · `pos.discount.apply` · `pos.discount.approve` · `pos.discount.unlimited` · `pos.comp.apply` · `pos.price.override` · `pos.refund.issue` · `pos.refund.different_tender` · `pos.reprint.receipt` · `pos.order.transfer` · `pos.order.reopen`

**No fire, send, or production-release authority.** A regex sweep for `(pos|kds|kitchen|order|sales)\.[a-z_]+\.[a-z_]+` across all 161 pages returns no additional Sales-side code. §15.2 designates Appendix C authoritative; **Appendix C is absent**. §15.3's `Kitchen Staff` role is "KDS only" — a consumer of fired tickets, not a firer.

`pos.order.create` is quoted "Create and modify orders". Fire *changes* an order, but it is not a content modification: it releases work to production, starts irreversible physical activity, is the trigger for the post-fire cashier lock, and is the boundary the SRS itself uses to split `void_line_prefire` from `void_line_postfire`. Treating the code that grants line entry as also granting production release would make the pre/post-fire split unenforceable at its own boundary. **Do not assume it covers Fire.**

Contrast with the route itself, which **is** source-decided: §26.3 lists `POST /v1/orders/{id}/fire — Fire to kitchen`. **The SRS mandates the endpoint and supplies no permission to guard it.** That is a genuine source gap of the same class D-20 handled.

## Decision packet — DO NOT RATIFY

**OPTION A — clarify that `pos.order.create` includes ordinary Fire/send**

- *Security:* every cashier/waiter who can enter a line can release production. Real exposure: cost is incurred at fire (food is cooked), so it is a fraud/waste vector — the SRS's own §12 risk list includes "Orders opened and cancelled with items fired". No new code invented, so the zero-invented-codes discipline holds.
- *Expected behaviour:* matches reality in a table-service restaurant — the person who takes the order fires it. FR-POS-035's fast-casual mode ("firing automatically upon line entry") makes the two operations literally the same action, which is the strongest argument that one authority covers both.
- *Post-fire lock:* unaffected. The lock is line-state-based and keyed to `void_line_postfire`, which stays separate.
- *Risk:* broadens a ratified code by interpretation — the exact move Clarification C forbids for `order.cancel_after_production`.

**OPTION B — authorise a new granular permission (e.g. `pos.order.fire`)**

- *Security:* least privilege; a runner or a KDS-only account cannot fire. Enables an expo-only or supervisor-fires workflow.
- *Expected behaviour:* every cashier and waiter needs it in practice, so it is granted alongside `pos.order.create` in all shipped roles — near-zero real separation for a real seeding and migration cost.
- *Post-fire lock:* unaffected.
- *Risk:* invents a code. Directly contradicts the repository's standing discipline (D-17-06, `sales.permissions.ts`, `treasury.permissions.ts`) and cannot be reconciled with §15.3's standard roles, which are defined only in terms of catalogue codes.

**RECOMMENDATION — Option A, ratified explicitly and narrowly**, on this reasoning: FR-POS-035 makes automatic-fire-on-line-entry a configured mode of the same [M] requirement, so a permission model that separates them cannot express the SRS's own fast-casual branch. The clarification should state that `pos.order.create` authorises **ordinary Fire/send only**, and explicitly **not** post-fire mutation, void-after-fire, cancel-after-production, or hold-and-fire release if that later proves distinct.

**NOT RATIFIED. Presented for decision only.**

---

# H. FR-KDS-010 ROUTING MATRIX

SRS precedence, verbatim and in order. No tier is collapsed, remapped, or dropped.

### TIER 1 — Explicit line-level station override

| | |
|---|---|
| **SRS semantics** | The line itself names a station, overriding all configuration. |
| **Approved SQL** | **NONE.** `sales.order_lines` has no station column. |
| **Prisma model** | **NONE.** `OrderLine` has `course`, `seatNumber`, `state`, `firedAt`, `readyAt` — no station. |
| **Service/API** | None. |
| **Branch / tenant ownership** | n/a |
| **Cardinality** | Would need 0..n per line (FR-KDS-011), i.e. a child table, **not** a nullable column. |
| **Current behaviour** | Cannot be expressed. |
| **Multiple destinations** | n/a |
| **Status** | **NOT IMPLEMENTED** |
| **Exact gap** | No storage for a per-line station override, and no approved SQL to derive one from. A `sales.order_line_stations` child (or `kitchen`-side equivalent) must be designed. It carries the partition problem in §I. |

### TIER 2 — Modifier-driven routing rule

| | |
|---|---|
| **SRS semantics** | *"a 'make it crispy' modifier may reroute"* — a modifier on a line changes or adds its destination. |
| **Approved SQL** | **NONE.** `kitchen.station_routing_rules` has `menu_item_id` and `category_id` only — **no `modifier_id`**. |
| **Prisma model** | **NONE.** `StationRoutingRule` mirrors the approved SQL. `Modifier`/`ModifierGroup` carry no station. `OrderLineModifier` carries no station. |
| **Service/API** | None. |
| **Branch / tenant** | n/a |
| **Cardinality** | modifier → 0..n stations; and a modifier may *replace* vs *add* a destination — the SRS's "reroute" does not say which. |
| **Current behaviour** | Cannot be expressed. |
| **Multiple destinations** | n/a |
| **Status** | **NOT IMPLEMENTED** |
| **Exact gap** | Two gaps: (a) no `modifier_id` on the rule table; (b) **replace-vs-augment semantics are NOT SOURCE-DECIDABLE** — "may reroute" is the only text. Must not be guessed. |

### TIER 3 — Menu item's assigned station for this branch

| | |
|---|---|
| **SRS semantics** | Per-branch item→station assignment. |
| **Approved SQL** | **PRESENT** — `kitchen.station_routing_rules (id, branch_id, station_id, menu_item_id, category_id, priority)`. Comment: *"nullable = category rule"*. |
| **Prisma model** | **PRESENT** — `StationRoutingRule`, `@@schema("kitchen")`, `@@map("station_routing_rules")`. |
| **Service/API** | **NONE.** No service, no controller, no seeding, no read path. Zero rows are ever written. |
| **Branch ownership** | ✅ `branch_id` FK + **D-09 composite FK** `(branch_id, station_id) → org.stations(branch_id, id)` — a rule cannot target another branch's station. |
| **Tenant ownership** | **No `tenant_id`** (approved design). RLS scopes it by traversal to `org.branches`. Migration comment at `20260816110000/migration.sql:272` records this deliberately. |
| **Cardinality** | Unconstrained — no unique index on `(branch_id, menu_item_id)`. **Multiple rows per item are structurally permitted.** |
| **Current behaviour** | Table exists, has RLS (SELECT/INSERT/UPDATE/DELETE policies), full `ros_app` grants, indexed on `(branch_id, station_id)`. **No code touches it.** |
| **Multiple destinations** | **YES** — supported by cardinality. |
| **Status** | **PARTIAL** |
| **Exact gap** | (a) No resolution service. (b) `menu_item_id` carries **no FK** to `catalogue.menu_items` (approved SQL predates Catalogue; Catalogue now exists) — a rule can name a deleted or foreign-tenant item. (c) `priority SMALLINT` exists but the SRS defines **no priority semantics**; it must not be repurposed as the tier mechanism. (d) The item is `menu_item_id`, but `OrderLine` also carries `variantId` — whether routing is per item or per variant is **NOT SOURCE-DECIDABLE**. |

### TIER 4 — Category default station

| | |
|---|---|
| **SRS semantics** | Fallback to the item's category's station. |
| **Approved SQL** | **PRESENT** — same table, `category_id` column. |
| **Prisma model** | **PRESENT** — `StationRoutingRule.categoryId`. |
| **Service/API** | **NONE.** |
| **Branch / tenant** | Same as Tier 3. |
| **Cardinality** | Unconstrained; multiple rows per category permitted. |
| **Current behaviour** | Same as Tier 3 — exists, unused. |
| **Multiple destinations** | **YES.** |
| **Status** | **PARTIAL** |
| **Exact gap** | (a) No resolution service. (b) `category_id` has **no FK**. (c) **Tier 3 and Tier 4 share one table with no discriminator** — precedence is inferred from which column is non-null, which the approved SQL comment implies but nothing enforces. A row with **both** `menu_item_id` and `category_id` set is currently legal and has **no defined meaning**. (d) Catalogue supports an item in **multiple categories** (`item_placements`); which category supplies the default is **NOT SOURCE-DECIDABLE**. |

### TIER 5 — Fallback station configured for the branch

| | |
|---|---|
| **SRS semantics** | A branch-level last-resort station. |
| **Approved SQL** | **NONE.** `org.branches` has no `fallback_station_id` (verified column by column). |
| **Prisma model** | **NONE.** `Branch` has no station column; only the `stations Station[]` back-relation. |
| **Service/API** | None. |
| **Branch / tenant** | n/a |
| **Cardinality** | Exactly one per branch, by the SRS's singular wording. |
| **Current behaviour** | Cannot be expressed. |
| **Multiple destinations** | No — singular by definition. |
| **Status** | **NOT IMPLEMENTED** |
| **Exact gap** | No storage. Two candidate homes: a `fallback_station_id` column on `org.branches` (composite-FK-safe via `(branch_id, id)`), or an `org.settings` row — but **`org.settings` exists in the approved SQL and is NOT in the Prisma schema or any migration**, so that path needs its own slice. Choosing between them is an **ENGINEERING CHOICE**, not source-decided. |

**Not done, per instruction:** no tier mapped onto another; no generic JSON rules blob; no first-station selection; no route-everything-to-fallback; no hard-coded "Kitchen" station; no routing by station name; `org.print_routing` was **not** treated as a substitute — it keys on `document_type` (`receipt`, `kitchen_ticket`, `bar_ticket`) → `printer_target`, which is paper output, and no SRS text equates print routing with KDS station routing.

---

# I. KITCHEN DATA MODEL MATRIX

| Concept | SRS | Approved SQL | Current repository | Missing physical pieces |
|---|---|---|---|---|
| `kitchen` schema | §25.1 (D-06) | present | ✅ declared in Prisma `schemas` + created by migration; `GRANT USAGE ON SCHEMA kitchen TO ros_app` | — |
| **Station** | FR-KDS-001 [M] — per branch, configurable **name, display colour, capacity**. §7.3 #24 aggregate: `Station` contains `RoutingRules`, `CapacityConfig` | `org.stations (id, branch_id, name, capacity_config JSONB, display_terminal_id, created_at)` | ✅ Prisma `Station`, `@@schema("org")`, D-09 composite FKs, `@@unique([branchId, name])`, `@@unique([branchId, id])` | **`display_colour` absent** (FR-KDS-001 names it explicitly). `capacity_config` is an untyped JSONB with no parser or validation. **Lives in `org`, but §7.3 #24 places the Station aggregate in Kitchen Ops** — a context-map/schema mismatch to record. **No service, no API, no seeding.** |
| **Ticket** | §7.3 #23 — root, contains `TicketLines`, *"Derived from Order; independent lifecycle"*. Glossary: *"the kitchen-facing representation of an order or a subset of an order, **routed to one preparation station**"* | `kitchen.tickets (id, order_id → sales.orders(id), station_id → org.stations(id), status DEFAULT 'queued', fired_at DEFAULT now(), bumped_at, target_time_seconds)` | **ABSENT** — no Prisma model, no migration, no table | Everything. Plus the conflicts below. |
| **TicketLine** | §7.3 #23 contained entity | `kitchen.ticket_lines (id, ticket_id → tickets ON DELETE CASCADE, order_line_id → sales.order_lines(id), status DEFAULT 'queued')` | **ABSENT** | Everything. Plus the conflicts below. |
| **Routing rules** | FR-KDS-010 tiers 3/4 | `kitchen.station_routing_rules` | ✅ table + RLS + grants; **no code** | See §H — modifier tier, line-override tier, branch fallback all absent. |
| **Course** | FR-POS-036 [S]; §7.4.2 `course SMALLINT` | in `sales.order_lines` | ✅ `OrderLine.course Int? @db.SmallInt` | Present and unused. |
| **`first_fired_at`** | §7.4.1; UC-POS-01 step 6 | `sales.orders.first_fired_at` | ✅ column exists | **Never written.** |
| **`fired_at` / line state** | §7.4.2 (`state` ENUM `pending, fired, …`; `fired_at`) | `sales.order_lines` | ✅ `OrderLineState` enum + `firedAt`, `readyAt` | **Never written.** No transition writes `fired`. |
| **`routed_at`, first-viewed, started** | FR-KDS-040 [M] — created, routed, first viewed, started, ready, bumped, served **per ticket AND per line** | approved SQL supplies only `fired_at`, `bumped_at` on the ticket | absent | **Approved SQL covers 2 of 7 timestamps.** Under-specified relative to a [M] requirement. |
| **Outbox** | §5.5.3, ADR-006, §24.2.5 | `platform.outbox (id, tenant_id, topic, payload, headers, status, attempts, next_attempt_at, last_error, created_at, processed_at)` + partial index | **ABSENT** — no `platform` schema, no table | Entire table + relay. Note `FR-PLT-041`, cited as mandating it, is **never defined in the SRS**. |

## Conflicts between approved SQL and SRS / partition reality — **REPORTED, NOT RESOLVED**

**CONFLICT 1 — the ticket FKs cannot be created as written.** `sales.orders` is range-partitioned by `business_day`; its Prisma primary key is **`@@id([id, businessDay])`**, and `sales.order_lines` likewise. PostgreSQL requires a foreign key to reference a unique constraint that **includes the partition key**. Therefore:

```sql
kitchen.tickets.order_id           UUID REFERENCES sales.orders(id)        -- IMPOSSIBLE
kitchen.ticket_lines.order_line_id UUID REFERENCES sales.order_lines(id)   -- IMPOSSIBLE
```

Both must become composite. The repo's established pattern is `(tenant_id, id, business_day)` — `sales.orders` already carries `@@unique([tenantId, id, businessDay])` precisely as that FK target. **Design gap, not a decision to take here.**

**CONFLICT 2 — no `tenant_id` on `kitchen.tickets` / `ticket_lines`.** This breaks the D-09 tenant-safe composite FK convention **and** leaves no RLS predicate. `station_routing_rules` solves this by traversing to `org.branches`, but a Ticket would have to traverse a partitioned `sales.orders` on every row check. Carrying `tenant_id` (and probably `branch_id` and `business_day`) is almost certainly required.

**CONFLICT 3 — `fired_at TIMESTAMPTZ NOT NULL DEFAULT now()`** contradicts FR-OFF-015/offline-first ULID+device-time discipline, and `now()` is the *server* clock, not the fire instant. The repo consistently derives timestamps server-side at the operation, not by column default.

**CONFLICT 4 — `status VARCHAR(16)` with a comment listing values.** Every state in this repository is a real PostgreSQL enum (`OrderState`, `OrderLineState`, `UserStatus`). The approved SQL's stringly-typed status is inconsistent with the shipped convention.

**CONFLICT 5 — ticket status vocabulary vs FR-KDS-040.** Approved SQL offers `queued, in_progress, bumped, recalled`; FR-KDS-040 [M] demands seven timestamps *and* FR-KDS-025 requires recall. The two do not line up and the reconciliation is undefined.

**CONFLICT 6 — Station aggregate placement.** §7.3 #24 places `Station` in **Kitchen Ops**; §7.3 #5 places `Stations` as a contained entity of the **Branch** aggregate in Organisation; approved SQL puts the table in `org`. Three sources, three answers. The repo followed the SQL. **Record; do not resolve here.**

## Narrowest sustainable model for `Order → fired OrderLine → route targets → Ticket/TicketLine`

**DESIGN SKETCH ONLY. No migration written, per instruction.**

Given the glossary's *"routed to one preparation station"* and UC-KDS-01 step 1 (*"Burger → Grill; Fries → Fryer; **both → Packaging**"*), FR-KDS-011's many-stations-per-line is satisfied by **one Ticket per (order, station)** and **one TicketLine per (ticket, order_line)** — a line appearing on several tickets. No `ticket_stations` join table is needed; the SRS already answers the cardinality question.

- `kitchen.tickets` — id (device ULID), **tenant_id, branch_id, business_day**, order_id, station_id, status (enum), `created_at`/`routed_at`/`fired_at`, target_time_seconds; composite FK `(tenant_id, order_id, business_day) → sales.orders`; composite FK `(branch_id, station_id) → org.stations`; unique `(tenant_id, order_id, business_day, station_id)` so a second fire amends rather than duplicates (**FR-POS-038**, **FR-KDS-028**).
- `kitchen.ticket_lines` — id, tenant_id, business_day, ticket_id, order_line_id, status, plus the FR-KDS-040 per-line timestamps; composite FKs throughout.
- Stable ULID identity preserved where device creation applies (FR-OFF-015) — but **whether the POS or the server mints ticket ids is NOT SOURCE-DECIDABLE** and belongs in the Fire API decision packet (§L).
- Snapshot vs reference (FR-KDS-020/021): `sales.order_lines` already snapshots `item_name_snapshot`, `quantity`, and `order_line_modifiers.name_snapshot`, and `orders` holds `order_number`, `order_type`, `table_id`. A ticket therefore needs **no additional content snapshot** — it references. This is the narrow choice and it invents no historical semantics.

---

# J. MODULE / EVENT ARCHITECTURE

```
IN-PROCESS DOMAIN EVENT BUS PRESENT:          NO
TRANSACTION-AWARE UOW EVENT DISPATCH PRESENT: NO
PUBLIC MODULE CONTRACT BOUNDARY READY:        NO
TRANSACTIONAL OUTBOX PRESENT:                 NO
```

**Verification.** Grep across `src/**` for `EventEmitter|eventBus|EventBus|outbox|Outbox|domainEvent|DomainEvent|UnitOfWork` returns **only comments stating the absence** (six files: `workforce/contract/commands.ts`, `workforce.module.ts`, `production.module.ts`, `recipe-cost.port.ts`, `inventory.module.ts`, `reconciliation.service.ts`). Runtime dependencies are 18 packages with **no `@nestjs/event-emitter`, no broker client, no queue**. Cross-module integration is 100% direct injected calls. No `platform` schema, no `outbox` table.

## A. Internal domain event bus — what exactly is missing

For `Sales records order.line.fired → transaction-aware in-process dispatch → Kitchen creates route/ticket state` without Sales depending on Kitchen internals, four pieces are absent:

1. **An event-recording surface on the aggregate.** §5.5.2: *"Events are collected on the aggregate, and dispatched by the unit of work."* Nothing in this codebase collects events; services write rows and return.
2. **A Unit of Work that owns the transaction and drains the collected events inside it.** Today `prisma.withAuthContext(..., tx => …)` is the transaction boundary and it has no event phase.
3. **A subscriber registry** mapping event type → handler, resolved from the Nest container, so Sales publishes `order.line.fired` by *name* and never imports a Kitchen symbol.
4. **The published contracts** — `modules/sales/contract/events.ts` declaring the event (and the §5.5.4 envelope: `eventId`, `eventType`, `eventVersion`, `occurredAt`, `recordedAt`, `tenantId`, `branchId`, `actorId`, `actorType`, `correlationId`, `causationId`, `idempotencyKey`, `payload`), and `modules/kitchen/contract/` for anything Kitchen exposes back.

## B. Transaction propagation

**Already solved in this repository, by the pattern P1D-1 used and Phase A just published properly.** Prisma's `Prisma.TransactionClient` is passed into the callee (`ShiftOpener.openShift(tx, command)`), so the subscriber's writes join the caller's transaction. The dispatcher must therefore pass `tx` to every handler and `await` them **before** the transaction callback returns. That requires handlers to be `async` and the dispatch to be sequential-or-awaited-in-parallel **inside** the `$transaction` closure — not `EventEmitter2`'s fire-and-forget, which would commit Kitchen separately and is exactly what §5.5.2 forbids.

**No async event that commits Kitchen later.** See §K.

## C. Outbox — where each pattern is required, and they must not be conflated

**SRS REQUIREMENT §5.5.3** defines the boundary precisely: the outbox is for *"a state change [that] must cause an effect **outside the database**, which cannot participate in the transaction"* — its named examples are fiscal submission, receipt SMS, aggregator push, CDN invalidation. **§5.5.2** covers state changes causing *other state changes* atomically.

- **Kitchen ticket creation is a row in the same PostgreSQL database.** It **can** participate in the transaction. → **§5.5.2 in-process domain event. Outbox is NOT required and must NOT be used.**
- **The outbox is required for:** fiscal submission (UC-POS-01 step 14), aggregator push, notifications, webhooks — none of which is in Fire's path.
- **Pushing the ticket to the physical KDS device** (NFR-PERF-004: on screen within 1s p95; NFR-REL-003: must work over local network with the internet down) is an out-of-process effect — but ADR-007/Chapter 21.6 make that a **client/local-peer-discovery** concern, not a server outbox concern. **Fire does not need the outbox.**

**No generic broker. No hidden outbox. Neither is authorised or needed for Fire.**

## D. Module contracts the SRS requires

`modules/sales/contract/` — `events.ts`: `order.opened`, `order.line.fired`, `order.line.voided`, `order.completed`, `order.refunded`, `discount.applied` (§5.5.4 publisher = Sales) + the mandatory envelope type. `commands.ts`/`queries.ts`/`types.ts` as §5.4 prescribes.

`modules/kitchen/contract/` — `events.ts`: `ticket.bumped` (§5.5.4 publisher = Kitchen Ops, subscribers Sales + Analytics). Ticket/TicketLine/Station DTOs in `types.ts`. **Sales must not import any of it to fire** — Sales publishes an event, Kitchen subscribes.

**Current state: neither exists.** The only `contract/` directory in the repository is the one Phase A created for Workforce. The architecture test records **21 module pairs** currently reaching into private directories, in two classes: cross-cutting HTTP/auth plumbing that §5.2.3 says belongs in `shared/` (Identity guards/decorators/context, Governance audit, `organisation/prisma-errors`), and five genuine domain edges (`identity→localisation`, `inventory→production`, `sales→catalogue`, `sales→localisation`, `sales→production`).

## E. Failure semantics — see §K.

## Which of these does Fire actually need **now**?

| Piece | Needed for Fire? | Why |
|---|---|---|
| Transaction-aware in-process domain-event dispatch | **YES** | §5.5.2 + §5.3.1 context map (`Sales ──(published events)──▶ Kitchen Ops`). Without it, Sales must call Kitchen directly — a §5.2.3 violation the architecture test now fails on. |
| `modules/sales/contract/events.ts` + `modules/kitchen/contract/` | **YES** | §5.2.3/§5.4; the only legal way Sales and Kitchen may interact. |
| Transactional outbox | **NO** | §5.5.3 does not apply — the effect is in-database. |
| Message broker | **NO** | §5.2.4 makes that an extraction-time swap. |
| Full envelope persistence / event store | **NO** | §24.6.1 applies event sourcing *selectively*; nothing requires persisting `order.line.fired`. |

---

# K. FIRE TRANSACTION BOUNDARY

**Answer from source: Fire and Kitchen ticket creation are ONE atomic unit. If ticket creation or routing fails, Fire ROLLS BACK.**

**Derivation, by rule rather than by example.** §5.5.3 scopes the outbox to effects that *"cannot participate in the transaction"*. Kitchen tickets are rows in the same database and **can** participate. §5.5.2 therefore governs: *"Used when a state change must cause other state changes atomically… dispatched by the unit of work within the same database transaction."* ADR-006 states the same. UC-POS-01 step 6 describes one system action with five consequences and no intermediate observable state. §7.3 #23 makes Ticket *"Derived from Order"* — a fired order with no ticket is a state the model does not admit.

**No eventual consistency is invented for the initial Fire transaction.**

## Intended atomic set

```
BEGIN  (RLS context set: tenant_id)
  1. assert order state + If-Match version           -- assertMayFire, assertVersion
  2. assert FR-POS-003: dine-in ⇒ table assigned     -- already in order-state.ts
  3. select the target lines (course or explicit ids)
  4. resolve FR-KDS-010 routing for EACH line        -- 5-tier precedence, 1..n stations
  5. order.state DRAFT -> OPEN (first fire only)     -- assertTransition
  6. order.first_fired_at = at (first fire only)
  7. order.version += 1
  8. line.state pending -> fired, line.fired_at = at (each fired line)
  9. upsert kitchen.tickets   per (order, station)   -- amend, never duplicate: FR-POS-038
 10. insert kitchen.ticket_lines per (ticket, line)
 11. record FR-KDS-040 initial timestamps: created, routed
 12. audit entry
 13. dispatch order.line.fired to subscribers ON tx  -- §5.5.2 unit of work
COMMIT
```

## Failure behaviour

| Failure | Behaviour | Source |
|---|---|---|
| A line resolves to **zero** stations | **ROLL BACK, 422.** Silently dropping it means food never gets made. | FR-KDS-010 requires resolution to *"one or more stations"* |
| Station row missing / cross-branch | **ROLL BACK.** | D-09 composite FK makes it impossible at the DB layer too |
| Ticket insert fails | **ROLL BACK.** Order stays `DRAFT`; lines stay `pending`. | §5.5.2 |
| Subscriber (Kitchen handler) throws | **ROLL BACK the whole Fire.** | §5.5.2 — dispatch is *inside* the transaction |
| Order already fully fired | Not a failure. **Idempotent replay** semantics — see §L | |
| Optimistic-concurrency mismatch | **409**, no partial write, no audit entry | §24.6.4; matches the existing `voidLinePreFire` behaviour |
| Push to the physical KDS screen fails | **DOES NOT roll back.** Out-of-process delivery; NFR-REL-002/003 make the device resilient by design | §5.5.3 boundary |

---

# L. FUTURE FIRE API — DESIGN ONLY

**NO ROUTE IMPLEMENTED. NOT EXPOSED. Not built in this run.**

## Route

`POST /orders/:businessDay/:id/fire` — **SOURCE-DECIDED as to existence** (§26.3: `POST /v1/orders/{id}/fire — Fire to kitchen`). The `:businessDay` segment is **RECOMMENDED**, following the repo's existing `/orders/:businessDay/:id` convention, which exists because `sales.orders` is partitioned and `id` alone is not a primary key.

| Aspect | Decision | Classification |
|---|---|---|
| `Idempotency-Key` **required** | Yes | **SOURCE-DECIDED** — FR-API-020 [M] makes it mandatory on financially significant endpoints; fire causes physical cost. Repo precedent: `@Idempotent()` on `POST /orders` and `POST .../lines` |
| Replay behaviour | Stored response + `Idempotent-Replay: true`; different fingerprint ⇒ **409** | **SOURCE-DECIDED** — FR-API-022 / FR-API-023 |
| `If-Match` **required** | Yes | **SOURCE-DECIDED** — §26.1 *"Concurrency: If-Match with ETag on updates"*. Repo precedent: `addLine`, `voidLine` both require it |
| Response `ETag` | Yes, from the new `order.version` | **SOURCE-DECIDED** (§26.1) + repo precedent `orderETag()` |
| Both headers together | Yes — they solve different problems | **IMPLEMENTATION FACT** (existing controller comment, lines 196-199) |
| Body: `course?: number` | Fire one course | **SOURCE-DECIDED** — FR-POS-036 [S], UC-POS-01 steps 5/6/8; `order_lines.course` already exists |
| Body: `lineIds?: string[]` | Fire specific lines | **RECOMMENDED** — no SRS text. FR-POS-036 is `[S]`; the `[M]` requirement (FR-POS-035) is "fire an order". **Do not invent course-selection semantics beyond this.** |
| Omitting both ⇒ fire all `pending` lines | **RECOMMENDED** | FR-POS-035 [M] "firing an order" is the mandatory case |
| Client-generated ticket ULIDs | **NOT SOURCE-DECIDABLE** | FR-OFF-015 mandates device ULIDs for *offline-created* records; whether the POS mints ticket ids, or Kitchen does on the server, is undecided. Must be settled before implementation |
| Repeat fire of an already-fired line | **Skip it, do not re-fire, do not error** | **RECOMMENDED**, strongly implied by FR-POS-038 + FR-KDS-028 ("never as a new ticket") |
| Fire after prior fire (new lines) | **Amend the existing station ticket** | **SOURCE-DECIDED** — FR-POS-038 [M]: *"SHALL create an amendment ticket… clearly marked as an addition, not a reprint of the whole order"*; FR-KDS-028: *"a visually distinct update on the existing ticket… never as a new ticket"* |
| Partially fired order | Legal and expected | **SOURCE-DECIDED** — UC-POS-01 step 8 |
| Empty fire (nothing pending) | **NOT SOURCE-DECIDABLE.** Candidates: 200 no-op, 409, 422 | Recommend **422** for consistency with the existing domain-error filter — but this is an open decision |
| Dine-in requires a table | Yes, **at fire time** | **SOURCE-DECIDED** — FR-POS-003: *"require table assignment before firing to the kitchen"*. **Already implemented**: `assertMayFire()` |
| Branch / terminal / Employee | Derived from the **session**, never the body | **IMPLEMENTATION FACT** + FR-SEC-028 root-of-trust; matches `requireTerminal()` / `requirePosIdentity()` |
| `served_by` | **NOT SOURCE-DECIDABLE** whether fire sets it | §7.4.1 has the column; no requirement says fire populates it |
| Audit | Required | **SOURCE-DECIDED** — FR-AUD-003 append-only; every existing write audits |
| Auto-fire mode (fast-casual) | Configurable per branch and per order type | **SOURCE-DECIDED** — FR-POS-035 [M] — but **no settings substrate exists** (`org.settings` is in the approved SQL and **absent from Prisma/migrations**). This half of an [M] requirement is blocked |
| Hold-and-fire | **DEFER** — FR-POS-037 `[S]`, needs a ticket "held" state undefined by the approved SQL | Out of the minimum slice |
| Permission guard | **BLOCKED** — see §G | **NOT SOURCE-DECIDABLE** |

---

# M. PAYMENT READINESS REASSESSMENT

```
P1D-2 PAYMENT SCHEMA DESIGN READY:              YES
P1D-2 PARTIAL CASH PAYMENT CALLABLE PATH READY: NO
P1D-2 FULL CASH PAYMENT CALLABLE PATH READY:    NO
P1D-2 PAYMENT CALLABLE PATH SOURCE-READY:       NO
```

**Schema design is ready** — and only the *design*. P1D-B…G settle attribution, rounding storage, the actor, and the PaymentAttempt distinction; the approved SQL supplies `sales.order_payments`; `orders.rounding_adjustment`, `paid_total`, `tip_total` all exist. Nothing needs a new decision to model it. **No table is authorised or created by this run.**

## A. Can Payment be captured only from `OPEN` / `PARTIALLY_PAID`?

**Yes — that is exactly the constraint, and it is why Payment is blocked.** The SRS diagram places the `pay` transition on `OPEN`. `POST /orders` creates `DRAFT`. **Nothing in the repository can move an order out of `DRAFT`** — `draft → open` is legal in `order-state.ts` but reachable only through an internal method that no route calls. So there is **no order in the system that is legally payable**, and there will not be until Fire exists.

## B. Partial cash Payment below full balance, before Completion?

**NO.** Blockers, in order:

1. **No `OPEN` order exists.** (blocking, and it is Fire's blocker)
2. **`open → partially_paid` is not in `TRANSITIONS`** — `open: ['held','parked','cancelled']`. Adding it is legitimate (it is in the SRS diagram) but is a Payment-slice change.
3. **No payment route, no permission seeded.** `pos.payment.capture` is authorised by P1D-F but is not in `TREASURY_PERMISSION_DEFS` or `SALES_PERMISSION_DEFS`, and no route exists.
4. **No `sales.order_payments` table.** `cash-session.e2e-spec.ts` asserts its absence as a slice boundary.

## C. Would a partial-payment-only slice be useful and source-correct?

**Source-correct: yes** — UC-POS-01 alternate flow 11b (*"Partial payment: order enters PARTIALLY_PAID"*) is a genuine terminal state, and BR-POS-002 forbids `COMPLETED` while `paid_total < grand_total`, so stopping there breaks no invariant.

**Useful: no, not yet.** It would produce an order that can be paid but never completed, on top of an order that cannot be fired. A cashier could take money for food the kitchen was never told to make. That is worse than no payment path.

## D. Must FULL payment be blocked until completion orchestration exists?

**YES — categorically.** UC-POS-01 step 12: full payment ⇒ `COMPLETED` ⇒ step 13, *"Subscribers execute atomically: inventory depletion via recipe expansion; COGS recognition; cash session posting; tax document generation; loyalty accrual; audit entry."* §5.5.2 names this the canonical atomic case: *"All four must succeed or all must fail. There is no acceptable state in which a sale is recorded and inventory is not depleted."*

None of that orchestration exists — and it needs the **same** transaction-aware event dispatcher Fire needs. **A fully-paid order must never be left in `PARTIALLY_PAID`.** Doing so would misstate revenue, skip depletion and COGS, and produce no tax document.

## E. Does a cash-only slice need PaymentAttempt?

```
DOES CASH NEED PaymentAttempt: NO
```

**RATIFIED GOVERNANCE (P1D-C), verified in the register.** A `PaymentAttempt` records payment-rail/terminal interaction outcomes. Physical cash involves no remote authorisation, no decline, no rail round-trip — there is nothing to attempt. UC-POS-01's only decline path is **11a, "Card declined"**. **Do not create an unused `payment_attempts` table for architectural symmetry.** The existing e2e boundary test already asserts its absence.

## F. Does CountryPack carry enough to compute an enabled cash-rounding rule?

**YES — the runtime carries it. It is simply never applied.**

`country-pack.parser.ts:169-197` parses and validates `cashRounding: { enabled: boolean, stepMinorUnits?: bigint }`, requiring `stepMinorUnits` to be present and positive **whenever `enabled` is true** — so an enabled rule cannot be under-specified. `roundingMode` (`RoundingMode`, default `HALF_UP` per BR-FIN-002) is parsed alongside. `country-pack.model.ts:150-152` types it. Packs are versioned and signed.

Three honest caveats, none of them a missing decision:

1. The shipped fixture pack sets `cashRounding: { enabled: false }`. Whether any real deployed pack enables it is **data**, not code.
2. **No rounding is ever applied.** Grep for `cashRounding` outside `localisation/` returns only tax-calculator test fixtures. `common/money/rounding.ts` exports `divideRounded`, `RoundingMode`, `parseExactDecimal`, `pow10` — there is **no round-to-nearest-step function**. BR-FIN-004 (*"applied only to the cash portion of a payment… recorded as a distinct `rounding_adjustment`, never absorbed into revenue or tax"*) is implementable from what exists, but is not implemented.
3. §16.7 is normative and BR-FIN-005 makes client/server divergence a **release-blocking defect**, verified by the §21.9 conformance suite — a `kitchen-kit/conformance/` directory exists and would need a cash-rounding case.

**Nothing is inferred that the source does not carry.** The step and mode come from the pack; neither is guessed.

---

# N. TESTS / MIGRATION VERIFICATION

| Command | Result |
|---|---|
| `git status --short` / `git diff --stat` / `--name-status` | run before any change and after; **+1 untracked path** (`module-boundaries.spec.ts`); no other delta |
| Governance diff | **ZERO from this run.** `GOVERNANCE_DECISION_REGISTER.md` numstat identical before and after (`1150/0`, pre-existing). No governance file opened for writing |
| `grep -rn "D-2[1-9]\|D-[3-9][0-9]"` | only pre-existing *"no D-21 is created"* preservation statements. **No D-21 or later created** |
| `npx prisma format` | clean; **no-op** — schema numstat unchanged at `670/120`, byte-hash stable on re-run. No schema edit was made |
| `npx prisma validate` | ✅ *"The schema at prisma/schema.prisma is valid"* |
| `npx prisma generate` | ✅ Prisma Client 7.9.1 |
| Clean scratch DB from zero | `CREATE DATABASE ros_p1e_scratch` + `GRANT CONNECT … TO ros_app`; `prisma migrate deploy` → **all 20 migrations applied**; dropped afterwards |
| `npx prisma migrate status` (scratch) | ✅ *"20 migrations found… Database schema is up to date!"* |
| Focused cash-session + sales E2E | **3 suites, 138 tests, all passing** |
| Architecture / module-boundary test | **5/5 passing** |
| Full unit — `npx jest` | **43 suites, 603 tests, 0 failed, 0 skipped, 0 todo** *(598 → 603, +5)* |
| Full E2E — `--runInBand` | **24 suites, 550 tests, 0 failed, 0 skipped, 0 todo** *(549 → 550, +1)* |
| **TOTAL** | **1153 passing** *(1147 → 1153)* |
| `npx eslint` on changed paths | ✅ clean (one prettier wrap auto-fixed) |
| `npx tsc --noEmit` | **exactly one error — the known baseline** `access-token.service.spec.ts(28,7) TS2322`. No new errors. Baseline **not** repaired |
| Route introspection (live Nest app) | `POST /cash-sessions` present; **`GET /cash-sessions/:id` absent**; no `/fire`, no `/payment`, no `/refund`, no `/day-close` anywhere |
| RLS probes | e2e suite green: cross-tenant invisibility, `withAuthContext` scoping, the new internal-read tenant-isolation test |
| `ros_app` role flags | `rolsuper=f`, `rolbypassrls=f`, `rolcreatedb=f`, `rolcreaterole=f`. Grants on `treasury.cash_sessions`, `treasury.drawers`, `workforce.shifts` = **SELECT + INSERT only** |
| Local dev DB | **NOT touched, NOT repaired.** Verified before and after: **78 `price_lists` rows, 5 unapplied migrations** |

Tests added cover only the P1D-1 corrections. **No test asserts an unratified design decision** — in particular, none asserts anything about Fire, Payment, routing or a Fire permission.

Checklist §19 items 1-14: all satisfied and verified (route set, POST retained, `cash.session.open` still required, idempotent replay, one-open-session-per-drawer race, RLS, cross-tenant, Shift/CashSession FK integrity, no Workforce private import, contract path exists, no new permission code, no Payment route, no Fire route, P1C Sales regression green).

---

# O. FILES CHANGED

**New**

```
kitchen-kit/backend/src/modules/workforce/contract/types.ts
kitchen-kit/backend/src/modules/workforce/contract/commands.ts
kitchen-kit/backend/src/modules/workforce/contract/index.ts
kitchen-kit/backend/src/modules/module-boundaries.spec.ts
```

**Removed** (untracked; created by P1D-1 in this same uncommitted set — content relocated, nothing lost)

```
kitchen-kit/backend/src/modules/workforce/shifts/shift.port.ts
```

**Modified**

```
kitchen-kit/backend/src/modules/workforce/shifts/shifts.service.ts
kitchen-kit/backend/src/modules/workforce/workforce.module.ts
kitchen-kit/backend/src/modules/treasury/treasury.controller.ts
kitchen-kit/backend/src/modules/treasury/treasury.module.ts
kitchen-kit/backend/src/modules/treasury/cash-sessions/cash-sessions.service.ts
kitchen-kit/backend/test/cash-session.e2e-spec.ts
```

**Untouched:** every governance document, every migration, `prisma/schema.prisma`, `docs/catalogue/PHASE_16_DISCOVERY.md`, all P0/P1A/P1B/P1C/P1D accumulated work, the local dev DB.

---

# P. NEXT SINGLE HIGHEST-LEVERAGE SLICE

## → **A. Minimal transaction-aware domain-event / Unit-of-Work infrastructure, with `modules/sales/contract/` and `modules/kitchen/contract/`**

**Not C (Fire), and not the old roadmap's Payment.**

**Exact SRS IDs / sections:** §5.2.3 (mechanically-enforced boundary rules) · §5.4 (`contract/` is the only public surface) · §5.5.1 (synchronous in-transaction interface call) · §5.5.2 (asynchronous **in-transaction** domain events, dispatched by the unit of work) · §5.5.3 (outbox — scoped **out**, and must stay out) · §5.5.4 (event catalogue: `order.line.fired` Sales → Kitchen Ops; `ticket.bumped` Kitchen Ops → Sales; mandatory envelope) · §5.3.1 (`Sales ──(published events)──▶ Kitchen Ops`) · ADR-006 · §24.6.4.

**WHY NOW — four independent lines of evidence converge:**

1. **Fire cannot be built correctly without it.** §5.3.1 makes Sales→Kitchen an *events* relationship. Building Fire first means Sales injecting a Kitchen service — the exact §5.2.3 violation Phase A just corrected on the Workforce edge, and which `module-boundaries.spec.ts` now fails on. Doing Fire first means knowingly writing the defect twice.
2. **Payment needs the identical mechanism, harder.** UC-POS-01 step 13's six atomic completion subscribers are §5.5.2's canonical example. Payment is blocked on the same missing piece.
3. **It is already an unpaid debt in three shipped slices.** `shift.opened`, `recipe.version.published` and the Sales events are all unpublished, each with a code comment recording the gap. This slice closes the class.
4. **Phase A proved the boundary is enforceable and revealed the scale.** The architecture test found **21 offending module pairs**. Establishing `contract/` in the two modules Fire needs, on the pattern Workforce now demonstrates, converts a growing debt into a shrinking one — with a mechanical test that fails if it grows.

**Dependencies:** none. It is pure infrastructure: no schema change, no migration, no new permission, no new route, no governance decision. It touches no state machine and asserts nothing about Fire, routing or Payment. It sits entirely inside the transaction primitive (`prisma.withAuthContext`) that already exists and already carries `tx` across module boundaries — the P1D-1 `SHIFT_OPENER` pattern is the working proof.

**SOURCE-READY: YES.** §5.5.2 defines the mechanism, §5.4 defines the file layout, §5.5.4 defines the envelope field-by-field, ADR-006 fixes the decision. Nothing here is inferred.

**What it unlocks:** Fire (real semantics, not a flag flip) · order completion orchestration · Payment · `ticket.bumped` back to Sales · `shift.opened` · Inventory depletion · COGS · Analytics ingestion — and it is the precondition §5.2.4 step 2 names for ever extracting a module into a service.

**Exact blockers: none.** It can be implemented from source today.

**What it deliberately does NOT include:** no transactional outbox (§5.5.3 does not apply to in-database effects) · no message broker (§5.2.4 defers it to extraction) · no event persistence or event store (§24.6.1 applies event sourcing selectively) · **no Fire route, no Kitchen tables, no Payment.**

### Why not the alternatives

- **B (KDS routing data-model closure)** — necessary, but **3 of 5 FR-KDS-010 tiers have no storage and two carry NOT-SOURCE-DECIDABLE semantics** (modifier replace-vs-augment; multi-category default; item-vs-variant; branch-fallback home). It needs decisions, not code. It is the natural *second* slice.
- **C (Fire + Kitchen Ticket)** — blocked on **three** things: no event infrastructure (A), no routing tiers 1/2/5 (B), and **no Fire permission** (E). Building it now means inventing at least one of them.
- **D (State-name clarification)** — **not needed.** §F establishes there is no conflict. Spending a slice here would be work on a non-problem.
- **E (Fire permission clarification)** — a real blocker, but it is a **governance decision, not a slice**. The packet is in §G; it costs a ratification, not an implementation.

**Not implemented in this run, per instruction.**

---

# Q. COMMIT READINESS

```
COMMIT READY: YES
COMMITTED:    NO
```

Working tree is clean by every gate: 1153 tests passing, 0 skipped, 0 todo; TypeScript at the known baseline with no new errors; ESLint clean on changed paths; Prisma valid and generating; 20 migrations deploying from zero on a clean database; RLS, grants and role flags verified; live route introspection confirming the withdrawn route.

**Nothing was committed, and no destructive git command was used** — no `checkout --`, no `reset --hard`, no `restore`, no `clean`, no `stash`. The local dev database was neither repaired nor reset (still 78 `price_lists` rows and 5 unapplied migrations); the scratch database was created fresh, used, and dropped.

**Nothing from the §21 non-goals list was implemented.** No Payment, no PaymentAttempt, no Fire, no Kitchen tables, no routing, no event bus, no outbox, no CashSession close, no new permission code, no `orders.cash_session_id`, and no governance amendment.
