# P1E-4 — Ticket / TicketLine Architecture + Persistence Design Closure

**Date:** 2026-08-22
**Branch:** `feat/production-spec`
**HEAD at start and end (unchanged — no commit made):** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Slice:** P1E-4 — ARCHITECTURE / DESIGN GATE ONLY (no code, no migration, no implementation)
**Report author:** Claude (Opus 5), per the repository's `CLAUDE.md` reporting policy

This report is **non-authoritative evidence** of analysis performed in this
session. The SRS and ratified governance decisions remain authoritative;
nothing here overrides them, and nothing here is a governance ratification.
No `D-21` or later decision is created. Where the source does not decide a
question, this report says **NOT SOURCE-DECIDABLE** and labels the
recommendation as an engineering choice rather than presenting it as source.

**Nothing was implemented.** No Prisma model, no migration, no service, no
handler, no route. Migration count remains **23**.

---

## A. STARTING STATE

- Branch `feat/production-spec`, HEAD `e5648fb`, unchanged throughout.
- Accepted baseline read and verified against the repository, not merely
  taken from the prior reports:
  - P1E-1/1A/1B/1C transactional domain-event + Unit-of-Work foundation —
    present and complete (`src/common/domain-events/`).
  - P1E-3 routing persistence (`kitchen.station_routing_rules`,
    `kitchen.branch_kds_config`, `sales.order_line_station_overrides`,
    `org.stations.display_colour`) — present.
  - P1E-3A contract/implementation split — `organisation/contract`
    publishes the `ROUTING_CONFIG_QUERY` token + `RoutingConfigQuery`
    interface; the Prisma implementation is private at
    `organisation/routing-config/routing-config.query.service.ts`.
  - Kitchen routing resolver — `src/modules/kitchen/routing/routing-resolver.service.ts`.
- **Confirmed absent** (direct verification, not inference):
  - `grep -c "model Ticket" prisma/schema.prisma` → **0**.
  - `kitchen` schema tables in a fully-migrated database →
    `branch_kds_config`, `station_routing_rules` only. **No `tickets`, no
    `ticket_lines`.**
  - `grep -rn "@DomainEventHandler" src/modules/` → **no matches**. No
    production event handler of any kind exists.
  - `SALES_PERMISSIONS` = `pos.order.create`, `pos.order.void_line_prefire`
    only. **No `pos.order.fire`.** No Fire route in `orders.controller.ts`.
  - No Payment, no Completion, no Outbox.
- `src/modules/kitchen/` currently contains only: `contract/` (the
  `ticket.bumped` typed event, unpublished), `kitchen.module.ts`,
  `routing/`. `KitchenModule` is **not** registered in `app.module.ts`
  (P1E-3 §K) — the implementation slice must register it.

---

## B. SOURCE REQUIREMENTS

Read from `ROS_SRS_v1.0.pdf` directly (extracted with `pdftotext -layout`),
not from prior paraphrases. Verbatim quotations of the load-bearing text:

**Glossary (§2):**
> **Ticket** — The kitchen-facing representation of an order or a subset of an
> order, routed to one preparation station.

> **Modifier** — An adjustment to an order line — an addition, removal, or
> substitution — which may carry a price delta and a recipe delta.

**§7.3 Aggregate Catalogue, row 23:**
> | 23 | Ticket | Kitchen Ops | TicketLines | Derived from Order; independent lifecycle |

Row 24: `Station | Kitchen Ops | RoutingRules, CapacityConfig | Belongs to one branch`.

**FR-KDS-010 [M]** — five-tier routing precedence (unchanged from P1E-2/P1E-3;
already implemented by the resolver).

**FR-KDS-011 [M]:**
> A single order line SHALL be routable to multiple stations when the item
> requires multi-station preparation (a burger requiring grill and packaging).

**FR-KDS-013 [S]** — Expediter (Pass) display showing complete orders, with
per-station completion state.

**FR-KDS-020 [M]:**
> The KDS SHALL display tickets as cards containing: order number, order type,
> elapsed time, table or customer reference, item lines with quantity and
> modifiers, and preparation notes.

**FR-KDS-021 [M]:**
> Modifiers SHALL be visually distinguished from item names, with removals
> (- no onion) rendered differently from additions (+ extra cheese).

**FR-KDS-022 [M]** — colour-coded by elapsed time against a configurable target.

**FR-KDS-023 [M]** — sort orders, configurable per station: oldest first
(FIFO), by target completion time, by order type priority, by course sequence.

**FR-KDS-024 [M]:**
> Staff SHALL be able to mark an individual item ready ("bump item") or an
> entire ticket ready ("bump all").

**FR-KDS-025 [M]:**
> The System SHALL provide a recall function restoring the most recently
> bumped tickets, retained for a configurable period (default 30 minutes).

**FR-KDS-026 [M]** — bump requires deliberate interaction (a UI requirement;
no persistence implication).

**FR-KDS-028 [S]:**
> Amendments to a fired order SHALL appear as a visually distinct update on
> the existing ticket, with an audible and visual alert, never as a new ticket.

**FR-KDS-029 [M]:**
> Cancelled lines SHALL be struck through and highlighted on the station
> display, with an alert, and SHALL remain visible for a configurable period so
> the cook stops preparing.

**FR-KDS-040 [M]:**
> The System SHALL record the following timestamps **per ticket and per line**:
> created, routed, first viewed, started, ready, bumped, and served.

**FR-KDS-041 [M]:**
> The System SHALL compute and report: average preparation time by item, by
> station, by hour, **by employee**, and by order type.

**FR-KDS-042 [M]:**
> The System SHALL define and report "ticket time" as bump time minus fire
> time, and "order time" as last-line-ready minus order-open.

**FR-KDS-044 [S]** — configurable per-item target preparation times, defaulting
to the recipe's `prep_time_seconds`.

**FR-POS-021 [M]** — the decisive requirement for §G:
> Modifiers SHALL support three semantic kinds:
> | Kind | Effect on Price | Effect on Recipe |
> | Addition ("extra cheese") | + delta | Adds ingredient quantity |
> | Removal ("no onion") | 0 or − delta | Removes ingredient quantity |
> | Substitution ("chicken instead of beef") | ± delta | Replaces one component with another |

**FR-POS-038 [M]:**
> Adding a line to an already-fired order SHALL create an amendment ticket to
> the kitchen clearly marked as an addition, not a reprint of the whole order.
>
> *Rationale: Reprinting an entire ticket when one item is added is the single
> most common cause of duplicate production in kitchens using printer-based
> systems. The kitchen sees a ticket that looks new and makes everything on it
> again.*

**FR-POS-025 [S]** — free-text kitchen notes per line, per-branch disableable.

**UC-POS-01 step 6:**
> Waiter fires course 1. System transitions order to OPEN, **creates tickets,
> routes each line to its station per FR-KDS-010**, records `first_fired_at`,
> and publishes `order.line.fired`.

**UC-KDS-01** — trigger: `order.line.fired` received. Steps 4–5 are decisive
for §N/§O:
> 4. Grill staff long-press to mark started (optional configuration), then
>    long-press to bump when done.
> 5. System **records `ready_at` for that line** and publishes `ticket.bumped`.

Step 7–8:
> 7. Expediter display shows the order as fully prepared when all station lines
>    are bumped, and highlights it for assembly.
> 8. Expediter bumps the order. System **sets all order lines to served**,
>    computes order time, and notifies the POS.

Alternate 6a:
> Line is voided at the POS after firing: the line is struck through on the
> station display with an audible alert, and the POS prompts for waste
> disposition.

**§5.5.2** — domain events "dispatched by the unit of work within the same
database transaction". **§5.5.4** — event catalogue names `order.line.fired`
(Sales → Kitchen Ops), `order.line.voided` (Sales → Kitchen Ops, Inventory,
Governance), `ticket.bumped` (Kitchen Ops → Sales, Analytics); plus the
mandatory envelope (`eventId`, `eventType`, `eventVersion`, `occurredAt`,
`recordedAt`, `tenantId`, `branchId`, `actorId`, `actorType`,
`correlationId`, `causationId`, `idempotencyKey`, `payload`).

**§25.1** — `kitchen` schema contents: `tickets, ticket_lines,
station_routing_rules`.

**FR-DR-001 [M]** — partitioned tables are `sales.orders`,
`sales.order_lines`, `inventory.stock_movements`,
`governance.audit_entries`, `analytics.fact_sales_line`. **`kitchen.tickets`
and `kitchen.ticket_lines` are NOT in the partition list** — they are not
partitioned. (Same reasoning P1E-2 applied to
`sales.order_line_station_overrides`.)

**FR-OFF-015 [M]:**
> All entities created on a device SHALL receive a client-generated ULID as
> their permanent primary key. The server SHALL NOT reassign identifiers.

**FR-PLT-003 [M]** — every tenant-scoped record carries an immutable
`tenant_id`; records are not transferable between tenants.
**FR-PLT-010/011/012/013/014 [M]** — RLS at the database layer independent of
application filtering; app role without `BYPASSRLS`; fail-closed on missing
tenant context; a generated cross-tenant isolation suite over *every* table
with `tenant_id`; CI fails if any `tenant_id` table lacks **enabled and
forced** RLS.

**NFR-PERF-004 [M]** — a fired order appears on the target station display
within 1 s at p95 on the local network. **NFR-REL-002 [M]** — KDS continues to
display and accept bump actions during a network outage, buffering bump events
locally. **NFR-REL-003 [M]** — routing functions via local peer discovery when
the internet is down.

**§24.6.4** — "Aggregates carry a version. Updates assert the expected version
and fail on mismatch." **§24.6.5** — soft delete with referential preservation.
**§24.8** — explicitly rejected anti-pattern: *"Shared database between modules
— Destroys boundaries and makes extraction impossible; enforced against by
per-module DB grants."*

**ADR-010 (SRS §5.6)** — verbatim:
> **Decision:** Orders, payments, stock movements, and audit entries are never
> updated or deleted. Corrections are new records that reference the original.

**Ticket is NOT in ADR-010's list.** This matters for §S and is stated there
rather than assumed here.

**Ratified repository decisions consulted:** ADR 0008 D-06 (kitchen schema
placement), D-07 (Station is an Organisation aggregate root), D-09 (composite
tenant-safe FKs — FK checks run with RLS disabled, so only a composite FK makes
a cross-tenant reference unrepresentable), D-12 (no delete/deactivate
endpoints; DELETE policies still created for FR-PLT-013 completeness), D-15
(missing uniqueness), D-16 (Station→Terminal additive index precedent).
Governance register D-1…D-20 are the *approval-workflow* series and are
unrelated to Kitchen (the D-xx namespace collision P1E-2 recorded; ADR 0008
D-xx numbers are cited as "ADR 0008 D-xx" throughout).

---

## C. CURRENT SALES/KITCHEN MODEL AUDIT

Verified directly against `prisma/schema.prisma` and a fully-migrated
PostgreSQL database (23 migrations from zero).

### `sales.Order` (partitioned)
`id`, `tenantId`, `branchId`, `terminalId`, `orderNumber VarChar(24)`,
`businessDay Date`, `orderType OrderType`, `channel OrderChannel`,
`state OrderState` (default `draft`), `tableId?`, `guestCount?`, `openedBy`,
`servedBy?`, `closedBy?`, `currency`, nine money columns, `openedAt`,
**`firstFiredAt?`**, `completedAt?`, `originDeviceTime`, `idempotencyKey`,
`aggregatorRef?`, `countryPackVersion`, `notes?`, `metadata`, **`version`
(§24.6.4)**, `createdAt`, `updatedAt`.

Partition key `business_day`; PK `(id, business_day)`.

Unique targets available to a child FK (verified by `pg_index`):

| index | columns |
|---|---|
| `orders_tenant_id_id_business_day_key` | `(tenant_id, id, business_day)` |
| **`uq_orders_tenant_id_business_day_branch`** | `(tenant_id, id, business_day, branch_id)` |
| `uq_order_number` | `(branch_id, business_day, order_number)` |
| `uq_orders_idempotency` | `(tenant_id, idempotency_key, business_day)` |

### `sales.OrderLine` (partitioned)
`id`, `tenantId`, `orderId`, `businessDay`, `sequence SmallInt`, `menuItemId`,
`variantId`, **`itemNameSnapshot Json`**, `quantity Decimal(12,3)`, six money
columns, `taxClassId`, `unitCostSnapshot?`, `recipeVersionId?`, price
provenance (`priceListId?`, `priceEntryId?`, `priceRule?`), **`course?
SmallInt`**, `seatNumber? SmallInt`, `state OrderLineState` (default
`pending`), **`firedAt?`**, **`readyAt?`**, `voidReasonId?`, `voidedBy?`,
`isComp`, **`notes? Text`** (kitchen instruction), `createdAt`.

Unique targets:

| index | columns |
|---|---|
| `order_lines_tenant_id_id_business_day_key` | `(tenant_id, id, business_day)` |
| `uq_order_line_sequence` | `(tenant_id, order_id, business_day, sequence)` |
| **`uq_order_lines_tenant_order_id_business_day`** | `(tenant_id, order_id, id, business_day)` |

**Finding (load-bearing for §K):** the two bolded indexes — both **added by
P1E-3** as the K-1 partition-safe substrate for
`sales.order_line_station_overrides` — are *exactly* the FK targets Ticket and
TicketLine need. **No new index on `sales.orders` or `sales.order_lines` is
required by this design.** P1E-3's K-1 work has already paid for Ticket's
foreign-key chain.

### `sales.OrderLineModifier`
`id`, `tenantId`, `orderLineId`, `businessDay`, `modifierId`,
`modifierGroupId`, **`nameSnapshot Json`**, `priceDelta BigInt`,
`quantity SmallInt` (default 1), `createdAt`. Composite FK to
`catalogue.modifiers(tenant_id, id)` `ON DELETE RESTRICT` (added by P1E-3).

### `catalogue.Modifier`
`id`, `tenantId`, `modifierGroupId`, `name Json`, `priceDelta BigInt`,
`stockItemId?`, `consumptionQuantity?`, `consumptionUnitId?`,
`recipeDelta? Json`, `isDefault`, `sortOrder`.

**CRITICAL FINDING — see §G.** Neither `catalogue.modifiers` nor
`sales.order_line_modifiers` carries **any** column expressing FR-POS-021's
three semantic kinds. There is no `kind`, no `action`, no `type`.
`priceDelta` cannot substitute: FR-POS-021 itself states a removal may be
`0 or − delta` and a substitution `± delta`, so the sign is not a
discriminant. `recipeDelta` is documented in the schema as *"Opaque JSON —
Production Spec is NOT implemented; nothing in this phase interprets or
executes a recipe delta"*, and is nullable. **FR-KDS-021 [M] is therefore not
satisfiable from current data.**

### Enums
`OrderType` = `dine_in | takeaway | delivery | drive_thru | pickup |
aggregator`. `OrderState` = `draft | open | held | parked | partially_paid |
completed | cancelled | partially_refunded | refunded`. `OrderLineState` =
`pending | fired | preparing | ready | served | voided | comped`.

### `org.Station`
`id`, `branchId`, `name VarChar(64)`, `capacityConfig Json`,
`displayColour? VarChar(9)`, `displayTerminalId?`, `createdAt`.
**No `tenant_id`** — a pure child of Branch. Unique targets:
`stations_branch_id_id_key (branch_id, id)` (the D-09 composite target) and
`stations_branch_id_name_key`.

**Consequence:** any table referencing a Station tenant-safely must carry
`branch_id` and use `(branch_id, station_id) → org.stations(branch_id, id)`.
Ticket therefore needs `branch_id`.

### `kitchen.BranchKdsConfig`
`branchId` (PK), `tenantId`, `fallbackStationId?`. Organisation-owned
logically (ADR 0008 D-07), physically in the `kitchen` schema (D-06).
Direct-anchor RLS. **This is the natural home for the FR-KDS-025 recall window
and the FR-KDS-029 cancelled-line visibility period** (§P, §Q) — it already
exists, is branch-scoped, and is already RLS-anchored, whereas `org.settings`
is DEFERRED and cannot be RLS-anchored (ADR 0008 D-11).

### Order-number representation
`orders.orderNumber VarChar(24)`, format `<branch_code>-<business_day_seq>`
(FR-POS-002), unique per `(branch_id, business_day, order_number)`.

### Post-Fire line mutability — ratified clarification
`src/modules/sales/orders/order-state.ts` contains `assertCashierMayMutateLine`
("Clarification C in one function"): once a line is in
`fired | preparing | ready | served` (`isSentToProduction`), the cashier may
not change it, with **no manager escape hatch**, because *"no ratified
permission authorises a general post-fire edit"*. Corrections after fire are
Refunds referencing the original (BR-POS-001).

`assertMayAddLine` permits adding a line while the order is `draft | open |
held`. **The FR-POS-038 amendment path is therefore already legal at the Sales
state-machine level** — adding a line to an `open` (already-fired) order is
permitted today. What does not exist is the Fire operation that would turn
that new line into an amendment on the kitchen side.

### Domain-event / UoW infrastructure
- `UnitOfWork.execute(scope, fn, causal?)` wraps `PrismaService.withAuthContext`
  — one `$transaction`, RLS context set as its first statement, `fn` runs
  inside it, then `dispatcher.drain(ctx)` runs **before** the callback returns,
  so handler writes commit or roll back with the business write.
- `ctx` is `{ tx, publishEvent }` only. `publishEvent` binds `tenantId` from
  the trusted `AuthScope` and `correlationId` once per `execute()` call.
- `TransactionalDomainEventDispatcher.drain()` loops: `batch =
  ctx.events.drain()`, then **`for (const event of batch) for (const handler of
  …) await handler.handle(event, ctx)`** — strictly sequential, in publication
  order, with a `MAX_DRAIN_ITERATIONS = 50` re-entrancy guard.
- Handler contract: `handle(event, ctx: UnitOfWorkContext): Promise<void>`,
  registered by `@DomainEventHandler('<eventType>')` (a
  `DiscoveryService.createDecorator<string>()`).

**Consequence for §U:** multiple `order.line.fired` events published by one
Fire command are dispatched **sequentially inside a single transaction**.
There is no intra-transaction concurrency to defend against; the concurrency
that matters is *between* transactions (two Fire requests), which is a database
uniqueness problem, not an ordering problem.

### Prior-report dispositions (evidence verified, not inherited)

P1D-1 §I recorded six conflicts between the approved SQL and SRS/partition
reality, and a design sketch. Each is verified here against the current
repository and given a disposition:

| P1D-1 item | Verified? | Disposition in this gate |
|---|---|---|
| **CONFLICT 1** — `kitchen.tickets.order_id UUID REFERENCES sales.orders(id)` is impossible against a partitioned table | **Confirmed** — `orders_pkey` is `(id, business_day)`; PostgreSQL requires the FK target to include the partition key | **RESOLVED** — §J/§K use composite FKs against `uq_orders_tenant_id_business_day_branch` and `uq_order_lines_tenant_order_id_business_day` |
| **CONFLICT 2** — no `tenant_id` on tickets/ticket_lines; no RLS predicate; traversing a partitioned parent per row check | **Confirmed** | **RESOLVED** — §M: every Kitchen table carries `tenant_id` with a DIRECT anchor. P1D-1's guess that `branch_id` and `business_day` are "probably" also required is confirmed, with the exact reasons (§J: `org.stations` has no `tenant_id`; the Order FK needs the partition key) |
| **CONFLICT 3** — `fired_at TIMESTAMPTZ NOT NULL DEFAULT now()` uses the server clock, not the fire instant | **Confirmed** | **RESOLVED** — §N: no `DEFAULT now()` on any of the seven FR-KDS-040 timestamps; `routed_at` comes from `payload.firedAt` |
| **CONFLICT 4** — `status VARCHAR(16)` is inconsistent with the repo's native-enum convention | **Confirmed** — every state vocabulary in `schema.prisma` is a PostgreSQL enum | **RESOLVED** — §N uses native enums |
| **CONFLICT 5** — the approved status vocabulary does not line up with FR-KDS-040's seven timestamps plus FR-KDS-025 recall | **Confirmed** | **RESOLVED** — §N reconciles them explicitly (option C: enums *and* all seven timestamps), with the `recalled`/`cancelled` non-derivability argument as the reason both are needed |
| **CONFLICT 6** — Station aggregate placement: §7.3 #24 says Kitchen Ops, §7.3 #5 says a Branch contained entity, approved SQL says `org` | **Confirmed** | **NOT REOPENED** — already settled by ratified ADR 0008 D-07 (Station is an Organisation aggregate root) and unchanged by P1E-3/P1E-3A. This gate touches no Station ownership question; `org.stations` stays exactly where it is |

**P1D-1's cardinality sketch is upheld.** It reached the same conclusion §D
reaches — one Ticket per `(order, station)`, one TicketLine per
`(ticket, order_line)`, no `ticket_stations` join table — from the same
glossary text plus UC-KDS-01 step 1's "*both → Packaging*". §D re-derives it
independently and adds the FR-KDS-028 stability argument P1D-1 did not make.

> ### P1D-1's snapshot sketch is SUPERSEDED
>
> P1D-1's final bullet stated, verbatim:
>
> > *"Snapshot vs reference (FR-KDS-020/021): `sales.order_lines` already
> > snapshots `item_name_snapshot`, `quantity`, and
> > `order_line_modifiers.name_snapshot`, and `orders` holds `order_number`,
> > `order_type`, `table_id`. A ticket therefore needs **no additional content
> > snapshot** — it references. This is the narrow choice and it invents no
> > historical semantics."*
>
> **This is rejected as the runtime design**, and the rejection is the reason
> §F exists. The sketch is correct that the *data values* already exist in
> Sales; it is wrong about who may read them. "It references" means Kitchen
> executing `tx.order.find…` / `tx.orderLine.find…` on every KDS card render —
> which SRS §24.8 names as a rejected anti-pattern (*"Shared database between
> modules — Destroys boundaries and makes extraction impossible; enforced
> against by per-module DB grants"*) and §5.2.3 forbids. It would also make
> `NFR-PERF-004`'s 1 s p95 depend on a cross-module join, and would break
> `NFR-REL-003`'s local-peer-discovery KDS, which by definition cannot reach
> the Sales tables.
>
> P1D-1 was written before the module-boundary enforcement existed
> (`module-boundaries.spec.ts` and the P1E-3A contract-purity assertions are
> later work), so the sketch was reasonable at the time and is simply
> outdated. §F replaces it: the Ticket aggregate is **self-sufficient for
> rendering and operation**; FKs to Sales remain for integrity only and are
> never traversed by Kitchen application code.

P1D-1 also recorded that *"whether the POS or the server mints ticket ids is
NOT SOURCE-DECIDABLE and belongs in the Fire API decision packet"*. §I closes
that item: neither — **Kitchen mints them**, as an engineering decision, with
FR-OFF-015 satisfied because ids are permanent ULIDs minted by the creating
node and never reassigned.

### Current `order.line.fired` payload — insufficient
```ts
export interface OrderLineFiredPayload {
  readonly orderId: string;
  readonly businessDay: string;   // YYYY-MM-DD
  readonly orderLineId: string;
  readonly course: number | null;
}
```
Its own docblock already concedes this, stating the fuller field set "is NOT
SOURCE-DECIDABLE yet". It is now decidable, because P1E-2/P1E-3 fixed routing
semantics and this gate fixes the Kitchen persistence shape. **No producer
exists, so changing the v1 payload is free.**

### `ticket.bumped` payload — insufficient
`{ ticketId, orderId, businessDay }`. It cannot tell Sales *which lines*
became ready, which is precisely what UC-POS-01 step 7 requires ("updates line
states to ready"). Addressed in §O.

---

## D. TICKET CARDINALITY

### Decision

> **One persistent Ticket aggregate per `(tenant_id, order_id, business_day,
> station_id)`.** A multi-station OrderLine is represented by one TicketLine
> under **each** station Ticket it routes to. **No `ticket_stations` join
> table.**

Enforced by `UNIQUE (tenant_id, order_id, business_day, station_id)`.

### Validation against source

- **Glossary** — "the kitchen-facing representation of an order **or a subset
  of an order**, routed to **one** preparation station." A Ticket is
  (order-subset × exactly one station). A join table would model a ticket
  routed to *several* stations, contradicting the glossary directly. **This
  alone rules out `ticket_stations`.**
- **FR-KDS-011** — a line routable to multiple stations. Under the chosen
  cardinality this is one TicketLine per destination station Ticket, which is
  what the requirement's own example describes: the burger appears on Grill's
  ticket *and* on Packaging's ticket. Nothing requires a shared row.
- **FR-KDS-028** — "never as a new ticket." Ticket identity must be **stable
  across successive Fire commands** for the same order+station. A
  cardinality keyed on the Fire event (one Ticket per fire) would make every
  amendment a new ticket, violating FR-KDS-028. Keying on `(order, station)`
  is the only cardinality under which "the existing ticket" is a
  well-defined, look-up-able row.
- **FR-POS-038** — "an amendment ticket … clearly marked as an addition, not a
  reprint of the whole order." Reconciled in §E; note that FR-POS-038 does not
  say *a new Ticket row* — it says a distinguishable amendment, which §E
  delivers without duplicating the aggregate.
- **UC-KDS-01 step 7** — the Expediter view "shows the order as fully prepared
  when **all station lines** are bumped". This is a query across the Tickets of
  one order — natural under `(order, station)` keying, since
  `WHERE tenant_id = ? AND order_id = ? AND business_day = ?` returns exactly
  the per-station set with per-station completion state (FR-KDS-013's
  requirement). No extra structure is needed for the Expediter later.
- **§7.3 #23** — "Ticket … Contained Entities: TicketLines … Derived from
  Order; independent lifecycle." One contained collection; independent
  lifecycle is what §N models.

**Classification: SOURCE-DECIDED.** The glossary fixes station cardinality;
FR-KDS-028 fixes stability across fires. The `UNIQUE` key is the mechanical
expression of both.

### Ticket ≠ course

A course is **not** part of Ticket identity. UC-POS-01 fires courses
separately (step 6 fires course 1, step 8 "fires subsequent courses"), and
FR-KDS-028 requires the second course to land on the *existing* station ticket,
not a new one. Course lives on TicketLine (`course`), supporting FR-KDS-023's
"by course sequence" sort. **SOURCE-DECIDED** (FR-KDS-028 + FR-KDS-023 read
together).

---

## E. AMENDMENT MODEL

### The conflict, and why it is only apparent

- **FR-POS-038 [M]:** adding a line to an already-fired order "SHALL create an
  amendment ticket … clearly marked as an addition, not a reprint of the whole
  order."
- **FR-KDS-028 [S]:** amendments "SHALL appear as a visually distinct update on
  the existing ticket … **never as a new ticket**."

FR-POS-038 is written from the **printer-replacement** perspective — its own
rationale is about reprinting a *paper* ticket causing duplicate production.
Its normative content is *"clearly marked as an addition, not a reprint of the
whole order"*. FR-KDS-028 states the **display** consequence on a screen-based
KDS: the same ticket, visibly updated. Both are satisfied by one persistent
Ticket that gains a distinguishable, alertable batch of new lines. Neither
requires a second Ticket row, and FR-KDS-028 explicitly forbids one.

**Classification: SOURCE-DECIDED** (the two requirements are compatible under
one reading; no invention needed).

### Options evaluated

| | Shape | Verdict |
|---|---|---|
| **A** | `kitchen.ticket_fire_batches` child table; `ticket_lines` FK to it | **CHOSEN** |
| B | `ticket_lines.fire_batch_id` + `ticket_lines.amendment_sequence` columns, no table | Rejected — see below |
| C | `ticket_lines.is_amendment BOOLEAN` | Rejected outright: cannot distinguish batch 1 from batch 2, which the requirement set demands |

**Why B is rejected.** B is *nearly* sufficient — "which lines are new for
amendment N" would be `WHERE ticket_id = ? AND amendment_sequence = ?`. It
fails on two specific points:

1. **The per-ticket sequence has no uniqueness home.** Under B the handler must
   compute `max(amendment_sequence) + 1` for a newly-seen `fire_batch_id` on
   that ticket. Two concurrent Fire commands against the same order, routing to
   the same station, would each compute the same value and both commit — two
   distinct amendments silently labelled "amendment 1", with nothing in the
   database able to reject it. Under A, `UNIQUE (tenant_id, ticket_id,
   sequence_no)` rejects the second, and the loser retries. §27 asks
   specifically about "concurrent Fire attempts against same order version";
   this is that case.
2. **No batch-scoped identity to make batch application idempotent.** A's
   `UNIQUE (tenant_id, ticket_id, fire_batch_id)` is the exact guard for "has
   this Fire command already touched this station's ticket?" — needed because a
   single Fire command arrives as *several* independent line events that must
   all converge on the same batch row. Under B this is inferred from line rows
   rather than stated.

**Why A is not over-modelling.** §16 requires a concrete requirement per table.
The batch table's three keys each serve a distinct, named obligation:
`(ticket_id, fire_batch_id)` → idempotent convergence of the several line
events of one Fire; `(ticket_id, sequence_no)` → FR-KDS-028's "which amendment
is this" ordering invariant; `(ticket_id, id)` → the FK target that ties a
TicketLine to a batch **of its own ticket**. It also gives batch-level
`fired_at` a single home, which FR-KDS-042's "bump time minus fire time" needs.

§7.3 #23 lists only "TicketLines" as contained entities, but that catalogue is
conceptual, not a table list — Order's row lists "OrderLines, LineModifiers,
Discounts, Payments, ServiceCharges" and the repository implements those as
separate tables already. A batch table is not a deviation from the aggregate
catalogue.

**Classification: ENGINEERING-DECIDED** (the requirement to distinguish
multiple amendment batches is source; the table-vs-columns shape is not).

### Semantics

- `sequence_no = 0` — the **original fire** for this ticket. `sequence_no ≥ 1` —
  the *n*-th amendment. A ticket always has at least the `0` batch: a Ticket
  is only ever created by a Fire.
- Original TicketLines are **never** recreated, rewritten, or re-timestamped
  when an amendment arrives. An amendment only INSERTs new `ticket_lines`
  rows pointing at the new batch row. This is the persistence expression of
  FR-POS-038's "not a reprint of the whole order".
- "Which lines are new for this amendment alert" = the rows whose
  `fire_batch_row_id` is that batch. A single indexed FK traversal.
- **First fire** is `sequence_no = 0`; **subsequent course fire** and **line
  added after prior fire** are indistinguishable at the persistence layer and
  deliberately so — both are "a later Fire command adding lines to an existing
  station ticket", both must alert, and no source text distinguishes them.
  (If a future requirement needs to, `ticket_fire_batches` is where a `reason`
  column would go — recorded, not added.)
- **Idempotent retry**: replaying the same Fire command re-presents the same
  `fire_batch_id`; the batch `UNIQUE` makes the batch row a no-op and the
  TicketLine `UNIQUE (tenant_id, ticket_id, order_line_id)` makes each line a
  no-op. No duplicate alert, no duplicate line.

---

## F. SNAPSHOT MODEL

### The non-negotiable constraint

SRS §24.8 rejects "Shared database between modules — Destroys boundaries and
makes extraction impossible; enforced against by per-module DB grants", and
§5.2.3 forbids importing another module's internals. The instruction for this
gate states it operationally: Kitchen application code must never execute
`tx.order.find…`, `tx.orderLine.find…`, or `tx.orderLineModifier.find…` to
display or operate Kitchen state.

Therefore the Ticket aggregate must be **self-sufficient for rendering and
operation**. Database foreign keys to Sales rows remain (for integrity, checked
by PostgreSQL with RLS disabled per ADR 0008 D-09), but they are never
traversed by Kitchen application code.

The *source* basis for snapshotting is BR-POS-004's principle — captured values
"SHALL NOT be recomputed from current master data" — extended to the Kitchen
boundary by §24.8. FR-KDS-020's field list then fixes exactly *which* values.

### Ticket-level snapshots (derived field-by-field from FR-KDS-020)

FR-KDS-020's card contains: **order number, order type, elapsed time, table or
customer reference**, item lines with quantity and modifiers, and preparation
notes. The first two and the fourth are ticket-header data:

| Field | Basis | Classification |
|---|---|---|
| `order_id` (+ `business_day`) | source reference; FK integrity, correlation, reporting | SOURCE-REQUIRED (identity) |
| `order_number_snapshot` | FR-KDS-020 "order number" | **SOURCE-REQUIRED** |
| `order_type_snapshot` | FR-KDS-020 "order type"; also FR-KDS-023's "order type priority" sort | **SOURCE-REQUIRED** |
| `service_reference_snapshot` | FR-KDS-020 "table or customer reference" | **SOURCE-REQUIRED** |
| `routed_at` | elapsed-time anchor (FR-KDS-020 "elapsed time", FR-KDS-022 colour) | **SOURCE-REQUIRED** |
| `target_ready_at` | FR-KDS-022 "against a configurable target"; FR-KDS-023 "by target completion time" | SOURCE-REQUIRED, nullable (see §R) |
| `station_id`, `branch_id`, `tenant_id` | identity/tenancy | SOURCE-REQUIRED (FR-PLT-003/010) |

**Course context is deliberately NOT on the Ticket.** A ticket spans courses
(FR-KDS-028 keeps later courses on the same ticket); course is per-line.

**Financial data is deliberately excluded.** No price, tax, discount, or cost
appears on any Kitchen table. No FR-KDS requirement names money. Copying it
"because Sales has it" would widen the Kitchen data surface with no consumer
and would put revenue data on a screen mounted in a kitchen.

**`service_reference_snapshot` is a DISPLAY STRING, not customer PII.**
FR-KDS-020 asks for "table or customer reference" — what the cook needs to
match food to a destination. The recommendation is a single
`VARCHAR(64)` holding the table label (dine-in) or a minimal customer
reference (e.g. a short name or the last digits of an order/phone reference
chosen by the Fire producer). **No address, no full phone number, no email, no
loyalty id.** *NOT SOURCE-DECIDABLE* exactly which customer field is
appropriate for a delivery/takeaway ticket — no SRS text specifies it, and the
CRM module is not implemented. The recommendation is: one opaque, already-
redacted display string minted by the Fire producer, so the decision can be
refined later without a Kitchen schema change.

### Kitchen item name — a recorded upstream gap

FR-MNU-005 [M] requires item names "independently configurable for each surface
(POS, KDS, customer receipt, aggregator listing)", with the rationale naming
the KDS surface explicitly ("The KDS should read 'GRL CHKN SW'"), and
NFR-USA-006 [M] requires legibility at 2 m, which is what the short kitchen
name exists for. `catalogue.menu_items.kitchen_names` exists.

**But `sales.order_lines.item_name_snapshot` captures the CUSTOMER-facing
names**, verified in `order-lines.service.ts`:
```ts
itemNameSnapshot: { item: menuItem.names, variant: variant.name },
```
`menuItem.kitchenNames` is not captured anywhere in Sales.

Kitchen cannot resolve it live (that would be a Catalogue query). So it must
be snapshotted. Two options:

- **(i) Fire-time capture into the event payload** — the Sales Fire producer
  reads `catalogue.menu_items.kitchen_names` (Sales→Catalogue is an already-
  recorded module edge: `sales->catalogue` appears in
  `module-boundaries.spec.ts`'s `KNOWN_DEVIATIONS`, and Sales already reads
  Catalogue for price resolution) and includes it in the payload. **No Sales
  schema change.**
- (ii) Add `kitchen_name_snapshot JSONB` to `sales.order_lines` at line
  creation — more faithful to BR-POS-004's "at the time of sale", but a
  migration on a partitioned table for a Kitchen concern.

**Recommendation: (i).** Fire is the moment the kitchen instruction is issued,
so Fire-time capture is defensible; and it keeps this gate's prerequisite list
to Catalogue only. **Classification: NOT SOURCE-DECIDABLE** whether the KDS
name must be snapshotted at sale time or at fire time — BR-POS-004's snapshot
list names `item_name_snapshot` and does not mention a kitchen-surface name at
all. Option (ii) is recorded so a later slice can adopt it without redesign.

The Kitchen column is therefore a single `item_name_snapshot JSONB` holding
**both** surfaces, e.g.
`{ "kitchen": {…}, "item": {…}, "variant": {…} }`, so a station configured for
either surface renders without a second lookup and FR-KDS-031's icon/image mode
can be added later beside it.

---

## G. MODIFIER MODEL

### The upstream gap — stated exactly, not fabricated around

FR-KDS-021 [M] requires removals to render differently from additions.
FR-POS-021 [M] requires modifiers to support three semantic kinds
(addition / removal / substitution). The glossary defines Modifier the same way.

**Neither `catalogue.modifiers` nor `sales.order_line_modifiers` carries that
kind.** Verified column-by-column in §C. The candidate substitutes all fail:

- `price_delta` — FR-POS-021's own table says removal is "0 **or** − delta" and
  substitution is "± delta". The sign does not identify the kind. A free
  "no onion" and a free "extra napkin" are both `0`.
- `name` / `name_snapshot` — parsing "No Onion" for a leading "No" is string
  heuristics on localised JSONB across Arabic and English. Not a semantic.
  §10's instruction is explicit: *"Do not assume `nameSnapshot` alone is
  sufficient."* It is not.
- `recipe_delta` — nullable, `[S]`-level (FR-MNU-013), and the schema's own
  comment states nothing interprets it. A modifier with no recipe delta still
  has a kind.
- `modifier_group` — a group ("Extras", "Remove") is a merchandising grouping,
  not a per-modifier semantic; the same group can hold both kinds.

> **GAP-K1 — `catalogue.modifiers` has no FR-POS-021 semantic kind.**
> FR-POS-021 [M] is unmet today, independently of Kitchen. Because of it,
> FR-KDS-021 [M] is **not implementable** from current data. This is an
> upstream Catalogue defect surfaced by this gate, not a Kitchen problem.
> **Classification: SOURCE-DECIDED that the gap exists** (FR-POS-021 is [M] and
> the column is absent). Exact remedy in §J/prerequisites.

### Representation chosen

| | Shape | Verdict |
|---|---|---|
| **A** | `kitchen.ticket_line_modifiers` relational child rows | **CHOSEN** |
| B | typed JSON array column on `ticket_lines` | Rejected |
| C | reuse a Sales read | Excluded by the module boundary |

**Why A.** FR-KDS-021 is `[M]` and its distinction must be *enforceable and
testable*, not merely conventional. A PostgreSQL enum column makes an invalid
kind unrepresentable; a JSON array makes it a convention that a future writer
can silently break, and §10 warns against exactly that ("Avoid generic opaque
JSON if it would make FR-KDS-021 impossible to enforce or test"). Additional
weight: the identical data in Sales (`sales.order_line_modifiers`) is already
relational, so A keeps the two sides symmetric; display ordering wants an
explicit `sort_order`; and FR-KDS-030's "all-day counts" `[S]` and FR-KDS-041's
by-item reporting become plain aggregates rather than JSON traversal.

**Classification: ENGINEERING-DECIDED**, with FR-KDS-021's `[M]` enforceability
as the deciding argument.

### Fields

| Field | Purpose | Classification |
|---|---|---|
| `name_snapshot JSONB` | FR-KDS-020 "modifiers" — localised display text, snapshotted | SOURCE-REQUIRED |
| `kind` (enum `addition\|removal\|substitution`) | FR-KDS-021, FR-POS-021 | **SOURCE-REQUIRED — blocked on GAP-K1** |
| `quantity SMALLINT` | mirrors `sales.order_line_modifiers.quantity` (FR-MNU-011 allow-repeat / free-quantity threshold) | ENGINEERING-REQUIRED |
| `sort_order SMALLINT` | deterministic display order (FR-MNU-010 "in configured order", FR-POS-020) | ENGINEERING-REQUIRED |
| `source_modifier_id` | reporting/traceability; tenant-safe composite FK to `catalogue.modifiers(tenant_id, id)` `ON DELETE RESTRICT`, mirroring what `sales.order_line_modifiers` already does | ENGINEERING-REQUIRED |

`source_modifier_id` is a **reference, not a read path** — Kitchen never
queries Catalogue through it; it exists so PostgreSQL can prove tenant safety
(D-09) and so reporting can join later.

---

## H. `order.line.fired` CONTRACT — FINAL v1 PAYLOAD

The envelope already supplies `eventId`, `eventType`, `eventVersion`,
`occurredAt`, `recordedAt`, `tenantId`, `branchId`, `actorId`, `actorType`,
`correlationId`, `causationId`, `idempotencyKey`. **None of those is repeated
in the payload.**

```ts
export interface OrderLineFiredPayload {
  // ── SOURCE IDENTITIES ──────────────────────────────────────────────
  readonly orderId: string;
  /** `YYYY-MM-DD` — the partition key, in the repository's date-only wire form. */
  readonly businessDay: string;
  readonly orderLineId: string;

  // ── FIRE CONTEXT ───────────────────────────────────────────────────
  /** Identity of the Fire COMMAND. Shared by every line event of one Fire,
   *  across every station. Minted by Sales. See §I. */
  readonly fireBatchId: string;
  /** The Fire command's own instant, ISO-8601. Identical for every line of
   *  the batch — deliberately NOT each event's `occurredAt`, which may differ
   *  per line. Becomes `routed_at`. See §N. */
  readonly firedAt: string;

  // ── ROUTING INPUTS (Kitchen must not query Catalogue or Sales) ──────
  readonly menuItemId: string;
  readonly modifierIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly lineStationOverrides: readonly {
    readonly overrideId: string;
    readonly stationId: string;
  }[];

  // ── TICKET HEADER SNAPSHOT (repeated on every line event — see below) ─
  readonly orderNumber: string;
  readonly orderType: 'dine_in' | 'takeaway' | 'delivery'
                    | 'drive_thru' | 'pickup' | 'aggregator';
  /** FR-KDS-020 "table or customer reference". Display string only; already
   *  redacted by the producer. Never full customer PII. See §F. */
  readonly serviceReference: string | null;

  // ── LINE SNAPSHOT ──────────────────────────────────────────────────
  /** Both surfaces: { kitchen, item, variant } — see §F. */
  readonly itemNameSnapshot: Readonly<Record<string, unknown>>;
  /** DECIMAL(12,3) as a string — never a JS number (float money/quantity is a
   *  rejected anti-pattern, §24.8). */
  readonly quantity: string;
  readonly course: number | null;
  /** `sales.order_lines.sequence` — display order within the order. */
  readonly sequence: number;
  /** FR-POS-025 kitchen note; FR-KDS-020 "preparation notes". */
  readonly preparationNotes: string | null;

  // ── MODIFIER DISPLAY SNAPSHOTS ─────────────────────────────────────
  readonly modifiers: readonly {
    readonly modifierId: string;
    readonly nameSnapshot: Readonly<Record<string, unknown>>;
    /** FR-KDS-021 / FR-POS-021. Blocked on GAP-K1 (§G). */
    readonly kind: 'addition' | 'removal' | 'substitution';
    readonly quantity: number;
    readonly sortOrder: number;
  }[];
}
```

`ORDER_LINE_FIRED_EVENT_VERSION` stays **1** — no producer exists, so this
replaces the current v1 shape rather than versioning past it.

### Why the ticket header is repeated on every line event

This is the decisive design point for §12/§27. If the header were carried only
on a separate "order fired" event, or only on the *first* line event of a
batch, Kitchen's correctness would depend on that event being processed first.
Repeating `orderNumber` / `orderType` / `serviceReference` on every line event
makes **each event independently sufficient to create a Ticket from nothing**.
Any event may legitimately be the one that creates the station's Ticket; the
rest converge on it. The cost is a few duplicated strings in an in-process
payload; the benefit is that no ordering assumption exists to be violated.

### What is deliberately NOT in the payload

- **`isFirstFire`.** "First fire" is order-scoped; what Kitchen actually needs
  is *per-ticket* ("is this batch `sequence_no` 0 for THIS station's ticket?"),
  which Kitchen derives from its own state. Putting an order-scoped flag in the
  payload would be both wrong for the multi-station case and an
  order-dependence.
- **The whole Order object.** Only the FR-KDS-020 field list crosses.
- **Money.** No FR-KDS requirement names it (§F).
- **`variantId`.** Routing is MenuItem-level by ratified Catalogue conflict
  C-03 (P1E-2), and the variant's display name is already inside
  `itemNameSnapshot`.
- **Resolved station ids.** Routing is Kitchen's job (P1E-2/P1E-3: Organisation
  *stores* configuration, Kitchen *resolves* it). Sales must not resolve
  routing and hand Kitchen an answer; that would move FR-KDS-010 into Sales.
  The payload carries only the routing *inputs*.

### `order.line.voided` — noted, not designed

§5.5.4 names it (Sales → Kitchen Ops, Inventory, Governance) and UC-KDS-01 6a
describes its Kitchen effect. Its payload and handler are **out of scope for
this gate** and for the next slice; §Q fixes only the *persistence* that its
future subscriber will need.

---

## I. IDENTITY / FIRE-BATCH MODEL

### Who mints what

| Id | Minted by | Basis |
|---|---|---|
| `fireBatchId` | **Sales**, once per Fire command | It *is* the Fire command's identity; only Sales knows the command boundary |
| `Ticket.id` | **Kitchen** (the handler), at creation | Derived Kitchen state |
| `TicketLine.id` | **Kitchen** | Derived Kitchen state |
| `ticket_fire_batches.id` | **Kitchen** | Derived Kitchen state |
| `ticket_line_modifiers.id` | **Kitchen** | Derived Kitchen state |

All use the repository ULID mechanism (`newId()` → `ulidToUUID(ulid())`,
time-ordered, stored as `uuid`).

### FR-OFF-015 analysis

> "All entities created **on a device** SHALL receive a client-generated ULID
> as their permanent primary key. The server SHALL NOT reassign identifiers."

The requirement is about **permanence and non-reassignment**, scoped to
entities created on a device. It does **not** say POS mints ids for records POS
does not create. A Ticket is not created by the POS: UC-POS-01 step 6 says
"System … creates tickets" as a consequence of Fire, and §7.3 #23 calls Ticket
"Derived from Order; independent lifecycle."

The sustainable reading: **whichever Kitchen execution environment creates the
Ticket owns its permanent id** — the server today; a local KDS node later under
NFR-REL-003 ("routing SHALL function via local peer discovery even when the
internet connection is down"). Because ids are ULIDs minted by the creating
node and never reassigned, that future move requires no redesign — which is
exactly the property FR-OFF-015 protects.

**Sales does not need to know Ticket ids to Fire.** The Fire producer publishes
line events and never references a Ticket. This keeps the dependency direction
one-way (Sales → event → Kitchen), as §5.5.4's publisher/subscriber table
requires.

**Classification:**
- Ids are permanent, client-generated ULIDs, never reassigned — **SOURCE-DECIDED** (FR-OFF-015).
- *Which* node creates a Ticket and therefore mints its id — **ENGINEERING-DECIDED** (Kitchen handler), consistent with §7.3 #23 and UC-POS-01 step 6.

### Idempotency does not depend on id equality

A replayed Fire may legitimately mint *different* Ticket ids on a retry, so
identity cannot be the idempotency guard. **Natural/composite uniqueness is**:
`tickets (tenant_id, order_id, business_day, station_id)`,
`ticket_fire_batches (tenant_id, ticket_id, fire_batch_id)`,
`ticket_lines (tenant_id, ticket_id, order_line_id)`. Each is a database
constraint, not an application check. This is why `fireBatchId` must come from
Sales: it is the only value stable across a retry of the same command.

---

## J. TICKET TABLE DESIGN — `kitchen.tickets`

Not partitioned (FR-DR-001 does not list it). Physical schema `kitchen`
(§25.1 names `tickets` there; ADR 0008 D-06 precedent). **Logical ownership:
Kitchen Ops** — unlike `station_routing_rules` / `branch_kds_config`, which are
Organisation-owned configuration, Ticket is Kitchen's own aggregate (§7.3 #23).

### Columns

| Column | Type | Null | Classification | Basis |
|---|---|---|---|---|
| `id` | `UUID` | NO | SOURCE-REQUIRED | ULID PK (§7.2, FR-OFF-015) |
| `tenant_id` | `UUID` | NO | SOURCE-REQUIRED | FR-PLT-003/010 |
| `branch_id` | `UUID` | NO | **ENGINEERING-REQUIRED** | `org.stations` has no `tenant_id`; its only D-09 target is `(branch_id, id)`, so a tenant-safe Station FK is impossible without it |
| `business_day` | `DATE` | NO | SOURCE-REQUIRED | `sales.orders` partition key; required by any FK to it |
| `order_id` | `UUID` | NO | SOURCE-REQUIRED | §7.3 #23 "Derived from Order" |
| `station_id` | `UUID` | NO | SOURCE-REQUIRED | Glossary: routed to one station |
| `order_number_snapshot` | `VARCHAR(24)` | NO | SOURCE-REQUIRED | FR-KDS-020 |
| `order_type_snapshot` | `sales."OrderType"` | NO | SOURCE-REQUIRED | FR-KDS-020; FR-KDS-023 order-type sort |
| `service_reference_snapshot` | `VARCHAR(64)` | YES | SOURCE-REQUIRED | FR-KDS-020 "table or customer reference"; null for a ticket with neither |
| `status` | `kitchen."TicketStatus"` | NO | ENGINEERING-REQUIRED | §N |
| `created_at` | `TIMESTAMPTZ` | NO | SOURCE-REQUIRED | FR-KDS-040 "created" |
| `routed_at` | `TIMESTAMPTZ` | NO | SOURCE-REQUIRED | FR-KDS-040 "routed"; elapsed anchor |
| `first_viewed_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 "first viewed" |
| `started_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 "started" |
| `ready_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 "ready" |
| `bumped_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 "bumped"; FR-KDS-042 |
| `served_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 "served" |
| `target_ready_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-022 target; FR-KDS-023 sort. See §R |
| `recalled_at` | `TIMESTAMPTZ` | YES | ENGINEERING-REQUIRED | FR-KDS-025; §P |
| `recall_count` | `SMALLINT` NOT NULL DEFAULT 0 | NO | ENGINEERING-REQUIRED | §P — flags a ticket whose FR-KDS-042 ticket time is not a clean measurement |
| `started_by` | `UUID` | YES | SOURCE-REQUIRED | FR-KDS-041 "by employee"; §R |
| `bumped_by` | `UUID` | YES | SOURCE-REQUIRED | FR-KDS-041 "by employee"; §R |
| `version` | `INTEGER` NOT NULL DEFAULT 1 | NO | SOURCE-REQUIRED | §24.6.4 — "Aggregates carry a version"; Ticket is an aggregate root |

**Deliberately absent:** `fired_at` (it is the batch's, §L — a ticket amended
three times has three fire times, and `routed_at` is the ticket's own anchor);
`target_time_seconds` (duplicate of `target_ready_at` − `routed_at`);
`is_amendment` (§E); any money column (§F); any course column (§D).

`order_type_snapshot` reuses the existing `sales."OrderType"` enum rather than
duplicating six labels into a Kitchen enum. **ENGINEERING-DECIDED**: an enum is
a *value type*, not a queryable table, so sharing it does not breach §24.8's
"shared database between modules" (which is about tables and grants), and
duplicating it would create a drift hazard where a newly added order type
silently fails to render on the KDS. The alternative (a `kitchen."OrderTypeSnapshot"`
mirror) is recorded should a future extraction make the coupling costly.

### Keys

```
PRIMARY KEY (id)
UNIQUE (tenant_id, id)                                  -- D-09 target for children
UNIQUE (tenant_id, order_id, business_day, station_id)  -- §D CARDINALITY INVARIANT
UNIQUE (tenant_id, id, order_id, business_day)          -- additive target; lets ticket_lines
                                                        -- prove same-order (§K, K-1 pattern)
```

### Foreign keys

```
(tenant_id)                                     -> identity.tenants(id)                       ON DELETE RESTRICT
(tenant_id, order_id, business_day, branch_id)  -> sales.orders(tenant_id, id,
                                                                business_day, branch_id)      ON DELETE RESTRICT
(branch_id, station_id)                         -> org.stations(branch_id, id)                ON DELETE RESTRICT
(tenant_id, started_by)                         -> identity.employees(tenant_id, id)          ON DELETE RESTRICT
(tenant_id, bumped_by)                          -> identity.employees(tenant_id, id)          ON DELETE RESTRICT
```

The Order FK targets **`uq_orders_tenant_id_business_day_branch`**, which
already exists (added by P1E-3). It is partition-safe (includes
`business_day`) and simultaneously proves that the Ticket's `branch_id` **is
the order's own branch** — so `(branch_id, station_id) → org.stations` then
proves the Station is in that same branch. Together: *a Ticket referencing a
Station outside its own Order's branch is structurally unrepresentable.*

`ON DELETE RESTRICT` on the Order FK rather than `CASCADE`: Kitchen timing
history is the evidence base for FR-KDS-041/042, and orders are never deleted
anyway (ADR-010). `RESTRICT` states that intent in the schema.

### Indexes

```
(tenant_id, branch_id, station_id, status, routed_at)  -- the station queue read; serves
                                                       -- FR-KDS-023 FIFO directly
(tenant_id, order_id, business_day)                    -- order -> its station tickets
                                                       -- (Expediter, FR-KDS-013)
(tenant_id, branch_id, station_id, target_ready_at)    -- FR-KDS-023 "by target completion"
```

### RLS / grants / deletion / mutability

- Direct tenant anchor: `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
- `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` (FR-PLT-014).
- Four policies (SELECT / INSERT / UPDATE / DELETE). The DELETE policy is
  created even though no code deletes — ADR 0008 D-12's precedent, because
  FR-PLT-013 requires delete isolation to be *tested*.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON kitchen.tickets TO ros_app;`
- **Deletion policy:** no application delete path (§24.6.5, ADR 0008 D-12).
- **Mutability:** §S.

---

## K. TICKETLINE TABLE DESIGN — `kitchen.ticket_lines`

Not partitioned (FR-DR-001).

### Columns

| Column | Type | Null | Classification | Basis |
|---|---|---|---|---|
| `id` | `UUID` | NO | SOURCE-REQUIRED | PK |
| `tenant_id` | `UUID` | NO | SOURCE-REQUIRED | FR-PLT-003/010 |
| `ticket_id` | `UUID` | NO | SOURCE-REQUIRED | §7.3 #23 containment |
| `fire_batch_row_id` | `UUID` | NO | ENGINEERING-REQUIRED | §E amendment identity |
| `order_id` | `UUID` | NO | **ENGINEERING-REQUIRED** | carried solely to make the two composite FKs below meet — see the integrity proof |
| `order_line_id` | `UUID` | NO | SOURCE-REQUIRED | source reference |
| `business_day` | `DATE` | NO | SOURCE-REQUIRED | partition key of the FK target |
| `item_name_snapshot` | `JSONB` | NO | SOURCE-REQUIRED | FR-KDS-020; both surfaces (§F) |
| `quantity` | `DECIMAL(12,3)` | NO | SOURCE-REQUIRED | FR-KDS-020 "quantity"; matches `sales.order_lines.quantity` exactly |
| `course` | `SMALLINT` | YES | SOURCE-REQUIRED | FR-KDS-023 "by course sequence" |
| `sequence` | `SMALLINT` | NO | ENGINEERING-REQUIRED | stable display order within a ticket, mirroring `order_lines.sequence` |
| `preparation_notes` | `TEXT` | YES | SOURCE-REQUIRED | FR-KDS-020 "preparation notes"; FR-POS-025 |
| `status` | `kitchen."TicketLineStatus"` | NO | ENGINEERING-REQUIRED | §N |
| `created_at` | `TIMESTAMPTZ` | NO | SOURCE-REQUIRED | FR-KDS-040 (per line) |
| `routed_at` | `TIMESTAMPTZ` | NO | SOURCE-REQUIRED | FR-KDS-040 |
| `first_viewed_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 |
| `started_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 |
| `ready_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040; UC-KDS-01 step 5 |
| `bumped_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040 |
| `served_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-040; UC-KDS-01 step 8 |
| `cancelled_at` | `TIMESTAMPTZ` | YES | SOURCE-REQUIRED | FR-KDS-029; §Q |
| `recalled_at` | `TIMESTAMPTZ` | YES | ENGINEERING-REQUIRED | §P (set only by a ticket-level recall) |
| `started_by` | `UUID` | YES | SOURCE-REQUIRED | FR-KDS-041 "by employee" |
| `bumped_by` | `UUID` | YES | SOURCE-REQUIRED | FR-KDS-041 "by employee" |

**`branch_id` is NOT required on `ticket_lines`** (§15 asked explicitly). The
line's station is its Ticket's station, and its branch is its Ticket's branch;
both composite FKs below already anchor it through `ticket_id`. Adding
`branch_id` would denormalise a value that no constraint or query needs.

**`station_id` is NOT required either** — same reason. FR-KDS-011's
multi-station case is expressed by *two TicketLines under two Tickets*, not by
a station column.

**No money, no tax, no cost** (§F).

### Keys

```
PRIMARY KEY (id)
UNIQUE (tenant_id, id)                              -- D-09 target for ticket_line_modifiers
UNIQUE (tenant_id, ticket_id, order_line_id)        -- idempotency + "one line per ticket"
```

That single `UNIQUE` does three jobs at once:
- a replayed Fire cannot create a duplicate TicketLine;
- the **same** OrderLine **may** appear on two station Tickets (different
  `ticket_id`) — FR-KDS-011 stays expressible;
- a second Fire batch cannot re-add the same line to the same ticket.

### Foreign keys — and the integrity proof §17 asks for

```
(tenant_id)                                          -> identity.tenants(id)                    RESTRICT
(tenant_id, ticket_id, order_id, business_day)       -> kitchen.tickets(tenant_id, id,
                                                                       order_id, business_day)  CASCADE
(tenant_id, order_id, order_line_id, business_day)   -> sales.order_lines(tenant_id, order_id,
                                                                          id, business_day)     RESTRICT
(tenant_id, ticket_id, fire_batch_row_id)            -> kitchen.ticket_fire_batches(tenant_id,
                                                                       ticket_id, id)           CASCADE
(tenant_id, started_by)                              -> identity.employees(tenant_id, id)       RESTRICT
(tenant_id, bumped_by)                               -> identity.employees(tenant_id, id)       RESTRICT
```

**Can a TicketLine reference Order X's Ticket and Order Y's OrderLine?**
**No — it is unrepresentable.**

1. FK 2 forces `ticket_lines.order_id` to equal the `order_id` of the Ticket it
   names (they are compared as one composite tuple against
   `kitchen.tickets`'s additive `UNIQUE (tenant_id, id, order_id, business_day)`).
2. FK 3 forces `ticket_lines.order_line_id` to be a line **of that same
   `order_id`**, targeting the existing
   `uq_order_lines_tenant_order_id_business_day`.
3. Therefore Ticket.order_id ≡ line.order_id ≡ the OrderLine's own order.

This is the identical K-1 chaining technique P1E-3 proved for
`sales.order_line_station_overrides` — and it needs **no new index on Sales**,
because P1E-3 already created both required targets. The only additive unique
this design introduces is on `kitchen.tickets`, a table being created anyway.
**Enforced by PostgreSQL, not by Kitchen service validation**, exactly as §17
requires.

FK 4 likewise forces a line's fire batch to be a batch **of its own ticket**
(the batch table carries a `UNIQUE (tenant_id, ticket_id, id)` for this).

`ON DELETE RESTRICT` to `sales.order_lines`: a voided line is *marked*, never
deleted (FR-KDS-029, §Q). `CASCADE` from `kitchen.tickets` is safe because no
code deletes a Ticket; it exists so that a future, explicitly audited
administrative purge (§24.6.5's "hard deletion … only for records with no
references and only via an explicitly audited administrative operation") does
not strand children.

### Indexes

```
(tenant_id, ticket_id, status)               -- ticket render + bump-all scan
(tenant_id, ticket_id, fire_batch_row_id)    -- "which lines are new in this amendment" (§E)
(tenant_id, order_line_id, business_day)     -- the future order.line.voided subscriber (§Q)
```

### RLS / grants
Identical pattern to `kitchen.tickets`: direct tenant anchor, `ENABLE` +
`FORCE`, four policies, grants to `ros_app`, no application delete path.

---

## L. CHILD TABLES

### `kitchen.ticket_fire_batches`

**Concrete requirement:** §E — distinguishing multiple amendment batches per
ticket, giving the per-ticket amendment ordering a uniqueness home, and giving
the several line events of one Fire command an idempotent convergence point.

| Column | Type | Null | Classification |
|---|---|---|---|
| `id` | `UUID` | NO | PK (Kitchen-minted) |
| `tenant_id` | `UUID` | NO | SOURCE-REQUIRED (FR-PLT-003) |
| `ticket_id` | `UUID` | NO | ownership |
| `fire_batch_id` | `UUID` | NO | ENGINEERING-REQUIRED — the Sales Fire-command identity from the payload |
| `sequence_no` | `SMALLINT` | NO | ENGINEERING-REQUIRED — 0 = original fire, ≥1 = amendment *n* |
| `fired_at` | `TIMESTAMPTZ` | NO | SOURCE-REQUIRED — FR-KDS-042 "fire time" |
| `created_at` | `TIMESTAMPTZ` | NO | ENGINEERING-REQUIRED |

```
PRIMARY KEY (id)
UNIQUE (tenant_id, id)
UNIQUE (tenant_id, ticket_id, id)            -- FK target proving batch belongs to the line's ticket
UNIQUE (tenant_id, ticket_id, fire_batch_id) -- IDEMPOTENCY: one Fire command touches a ticket once
UNIQUE (tenant_id, ticket_id, sequence_no)   -- amendment ordering invariant (§E, concurrency)
CHECK  (sequence_no >= 0)
FK (tenant_id)             -> identity.tenants(id)              RESTRICT
FK (tenant_id, ticket_id)  -> kitchen.tickets(tenant_id, id)    CASCADE
INDEX (tenant_id, ticket_id, sequence_no)
```
Direct-anchor RLS, `ENABLE` + `FORCE`, four policies, `ros_app` grants.
**Mutation policy: INSERT-only.** A batch row is never updated after creation —
it records a historical fact (this Fire command touched this ticket at this
instant).

Note `fire_batch_id` is **not** globally unique in this table: one Fire command
legitimately produces one batch row per affected station Ticket. It is unique
*within a ticket*, which is exactly the constraint that matters.

### `kitchen.ticket_line_modifiers`

**Concrete requirement:** §G — FR-KDS-021 [M] and FR-KDS-020's "modifiers",
renderable with no Catalogue or Sales read.

| Column | Type | Null | Classification |
|---|---|---|---|
| `id` | `UUID` | NO | PK |
| `tenant_id` | `UUID` | NO | SOURCE-REQUIRED |
| `ticket_line_id` | `UUID` | NO | ownership |
| `source_modifier_id` | `UUID` | NO | ENGINEERING-REQUIRED (traceability + D-09 tenant safety) |
| `name_snapshot` | `JSONB` | NO | SOURCE-REQUIRED (FR-KDS-020) |
| `kind` | `kitchen."ModifierKindSnapshot"` | NO | **SOURCE-REQUIRED (FR-KDS-021) — blocked on GAP-K1** |
| `quantity` | `SMALLINT` NOT NULL DEFAULT 1 | NO | ENGINEERING-REQUIRED |
| `sort_order` | `SMALLINT` NOT NULL DEFAULT 0 | NO | ENGINEERING-REQUIRED |

```
PRIMARY KEY (id)
UNIQUE (tenant_id, id)
FK (tenant_id)                        -> identity.tenants(id)                  RESTRICT
FK (tenant_id, ticket_line_id)        -> kitchen.ticket_lines(tenant_id, id)   CASCADE
FK (tenant_id, source_modifier_id)    -> catalogue.modifiers(tenant_id, id)    RESTRICT
INDEX (tenant_id, ticket_line_id)
```
No unique on `(ticket_line_id, source_modifier_id)`: FR-MNU-011's
`allow_repeat` and free-quantity threshold mean a repeated selection is legal;
`sales.order_line_modifiers` imposes no such unique either, and Kitchen must be
a faithful snapshot of what Sales captured. Deterministic display order is
`(sort_order, id)` — `id` is a ULID, so the tiebreak is creation order.

Direct-anchor RLS, `ENABLE` + `FORCE`, four policies, `ros_app` grants.
**Mutation policy: INSERT-only** — a modifier snapshot is captured at fire and
never edited.

### No further tables

Explicitly **not** added, each for a named reason:
- `ticket_stations` — contradicts the glossary (§D).
- `ticket_state_events` (a full transition history) — FR-KDS-040 requires
  *timestamps*, not a transition log; FR-KDS-041/042 are computable from the
  columns above. Recorded as the shape a future audit-grade requirement would
  need (§P).
- `ticket_line_images` (FR-KDS-031 icon/image mode `[S]`) — DEFER (§V).

---

## M. TENANCY / RLS / FK DESIGN

| Table | Anchor | RLS | Grants |
|---|---|---|---|
| `kitchen.tickets` | **DIRECT** `tenant_id` | ENABLE + FORCE, 4 policies | `ros_app` SELECT/INSERT/UPDATE/DELETE |
| `kitchen.ticket_lines` | **DIRECT** `tenant_id` | ENABLE + FORCE, 4 policies | same |
| `kitchen.ticket_fire_batches` | **DIRECT** `tenant_id` | ENABLE + FORCE, 4 policies | same |
| `kitchen.ticket_line_modifiers` | **DIRECT** `tenant_id` | ENABLE + FORCE, 4 policies | same |

Every table carries its own `tenant_id` — the DIRECT anchor pattern, not the
PARENT-`EXISTS` pattern. This is the same migration P1E-3 performed on
`catalogue.modifiers` and `kitchen.station_routing_rules`, for the same two
reasons: it is cheaper (no join per row), and — decisively — **a composite
tenant-safe FK to the row is impossible without it** (ADR 0008 D-09:
referential-integrity checks run with row security *disabled*, so only a
composite FK, never RLS, makes a cross-tenant reference unrepresentable).

Predicate: `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
Missing context → `NULL` → predicate false → zero rows / rejected write.
Fail-closed per FR-PLT-012. `ros_app` is `NOSUPERUSER`, `NOBYPASSRLS`
(FR-PLT-011).

### Unrepresentable-by-construction summary

| Illegal state | Prevented by |
|---|---|
| Ticket references another tenant's Order | `(tenant_id, order_id, business_day, branch_id)` composite FK |
| Ticket references a Station outside its Order's branch | the same FK proves `branch_id` is the order's branch; `(branch_id, station_id) → org.stations(branch_id, id)` then proves the station is in it |
| **TicketLine joins Order X's Ticket to Order Y's OrderLine** | the two-hop composite chain in §K — `order_id` is forced equal on both sides |
| TicketLine references a fire batch of a *different* ticket | `(tenant_id, ticket_id, fire_batch_row_id) → ticket_fire_batches(tenant_id, ticket_id, id)` |
| Modifier snapshot references another tenant's Catalogue modifier | `(tenant_id, source_modifier_id) → catalogue.modifiers(tenant_id, id)` |
| Two Tickets for the same order+station | `UNIQUE (tenant_id, order_id, business_day, station_id)` |
| Duplicate TicketLine on one ticket | `UNIQUE (tenant_id, ticket_id, order_line_id)` |
| Two amendments sharing a sequence number | `UNIQUE (tenant_id, ticket_id, sequence_no)` |
| One Fire command applied twice to one ticket | `UNIQUE (tenant_id, ticket_id, fire_batch_id)` |
| Cross-tenant read/write | RLS, ENABLE + FORCE, direct anchor |

**None of these is left to application validation.** Every row is a database
constraint.

### FR-PLT-013 / FR-PLT-014 consequence

All four new tables carry `tenant_id`, so the generated cross-tenant isolation
suite will enumerate them automatically and the CI RLS check will fail the
build if any policy is missing or unforced. No hand-registration needed.

---

## N. STATUS + TIMESTAMP STATE MACHINE

### Explicit state **and** timestamps — option C

The old approved SQL (`ROS_DrawDB_Compatible_v3.sql`) uses
`status VARCHAR(16) NOT NULL DEFAULT 'queued'  -- queued, in_progress, bumped,
recalled` and only two timestamps (`fired_at`, `bumped_at`). It is **not
copied**: it predates FR-KDS-040's seven timestamps, carries no `tenant_id`,
and its `order_id UUID REFERENCES sales.orders(id)` is not even creatable
against the partitioned `sales.orders` (composite PK `(id, business_day)`).

Choosing between the three options §18 lists:

- **(B) timestamps only** fails on two states that no timestamp combination
  expresses unambiguously. **`recalled`**: after a recall, `bumped_at` is set
  (preserved, §P) *and* the ticket is active again — indistinguishable from a
  bumped ticket unless a state says otherwise. **`cancelled`**: a cancelled
  line may also be `ready`/`bumped` (it was cooked before the void arrived,
  UC-KDS-01 6a), so `cancelled_at` alone cannot answer "what should the display
  do". Additionally FR-KDS-023's sorted, filtered station queue wants an
  indexable discriminant, not a seven-column `CASE`.
- **(A) enums only** loses FR-KDS-040, which is `[M]` and explicit.
- **(C) both** is chosen. PostgreSQL enums (repository convention — every state
  vocabulary in `schema.prisma` is a native enum, never `VARCHAR`).

**Classification: ENGINEERING-DECIDED**, forced by FR-KDS-040 `[M]` (timestamps
are not optional) plus the two ambiguities above (state is not derivable).

### `kitchen."TicketLineStatus"`

```
queued | started | ready | bumped | served | cancelled
```

Transitions:
```
queued    -> started | ready | bumped | cancelled
started   -> ready | bumped | cancelled
ready     -> bumped | served | cancelled
bumped    -> served | cancelled | queued|started   (ticket recall, §P)
served    -> cancelled                             (late void, FR-KDS-029)
cancelled -> (terminal)
```

**No line-level `recalled` state.** FR-KDS-025 says "restoring the most
recently bumped **tickets**". Recall returns the *ticket*, and its lines return
to `queued`/`started`; the fact that a recall happened is recorded on the
ticket (`recalled_at`, `recall_count`) and on each line (`recalled_at`).
Line-level recall is **NOT SOURCE-DECIDABLE** (§P).

### `kitchen."TicketStatus"`

```
queued | in_progress | ready | bumped | served | recalled
```

- `queued` — created, nothing started.
- `in_progress` — at least one line `started`, not all lines terminal.
- `ready` — every non-cancelled line is `ready` or beyond.
- `bumped` — the ticket has been bumped (bump-all, or the last line bumped).
- `served` — the Expediter/pass bump (UC-KDS-01 step 8).
- `recalled` — restored from `bumped` (§P).

Ticket status is **maintained by the same transaction that changes a line**,
not derived on read: FR-KDS-023 sorts and filters the station queue by it, and
NFR-PERF-004's 1 s p95 argues against an aggregate-per-read. It is a
**projection with a maintained column** — exactly the pattern ADR-010's own
consequences paragraph describes for `stock_levels`, and it must be
reconcilable from the line rows (a property the test matrix checks, §W-25).

**No `cancelled` ticket status.** A ticket is not cancelled; its *lines* are
(FR-KDS-029 is line-level: "Cancelled **lines**"). A ticket all of whose lines
are cancelled is a display concern, not a new state — recorded as
NOT SOURCE-DECIDABLE if a future requirement disagrees.

### `ready` versus `bumped` — resolved from source, not by fiat

§18 asks whether a single bump action setting both is an engineering decision.
**It is not — UC-KDS-01 decides it.** Step 4–5:

> 4. Grill staff long-press to mark started (optional configuration), then
>    long-press to **bump** when done.
> 5. System records **`ready_at`** for that line and publishes `ticket.bumped`.

The bump action is what records `ready_at`. FR-KDS-024 uses the same equation:
"mark an individual item **ready** ('bump item')". So **a bump sets both
`ready_at` and `bumped_at` to the same instant**, and the two columns still
exist separately because FR-KDS-040 `[M]` names both and FR-KDS-042 defines
ticket time on *bump* specifically.

They can legitimately diverge later without redesign: FR-KDS-013's Expediter
`[S]` and FR-KDS-012's staggered release `[S]` both introduce a "station says
ready, pass says done" separation. **Classification: SOURCE-DECIDED**
(UC-KDS-01 step 5 + FR-KDS-024) that a bump sets both today.

Compatibility check against §18's demand:
- **FR-KDS-024** — "mark an individual item ready (bump item) or an entire
  ticket ready (bump all)": both write `ready_at` + `bumped_at`, on one line or
  on all eligible lines. ✔
- **FR-KDS-040** — all seven timestamps exist and are individually
  addressable. ✔
- **UC-KDS-01** — step 5's "records `ready_at` … and publishes
  `ticket.bumped`" is exactly this behaviour. ✔

### Timestamp semantics — exact source/action for each

| Timestamp | Set by | Value | Nullability |
|---|---|---|---|
| `created_at` | the Kitchen handler, at row INSERT | the handler's own clock, passed **explicitly** | NOT NULL |
| `routed_at` | the Kitchen handler | **`payload.firedAt`** — the Fire command's authoritative instant, identical across every line and station of the batch | NOT NULL |
| `first_viewed_at` | first KDS read of the ticket by a station display | write-once | NULL until viewed |
| `started_at` | explicit "mark started" (UC-KDS-01 step 4, optional per config) | write-once | NULL until started |
| `ready_at` | the bump action | write-once (until a recall, §P) | NULL until bumped |
| `bumped_at` | the bump action | most recent bump | NULL until bumped |
| `served_at` | the Expediter/pass bump (UC-KDS-01 step 8) | write-once | NULL until served |

**`created_at` and `routed_at` are deliberately NOT collapsed**, as §22
requires. In the normal Fire path they are microseconds apart, but they are
different facts and diverge in two real cases: (a) on **replay**, `created_at`
is the replay instant while `routed_at` is preserved from the original Fire
payload; (b) for a Ticket that already existed, `created_at` is the *first*
fire while a later batch's `routed_at` is the amendment's fire time.

**No `DEFAULT now()` on any of the seven**, per §22 — the operation supplies
the authoritative occurrence timestamp. This is what makes replay preserve the
original fire/routing time rather than silently restamping it
(NFR-REL-002's "published on reconnection with **its original timestamp
preserved**" makes the same demand for buffered bumps).

`created_at` on `ticket_fire_batches` / `ticket_line_modifiers` is ordinary
row-creation metadata and **may** use `DEFAULT CURRENT_TIMESTAMP` in line with
the rest of the repository — the §22 rule binds the seven FR-KDS-040
timestamps, which are operational facts, not the bookkeeping columns.

---

## O. BUMP SEMANTICS

Persistence and transitions only — **no route is designed or implemented.**

### Bump item (FR-KDS-024, one TicketLine)

- Sets `ready_at` and `bumped_at` to the action instant, `bumped_by` to the
  acting employee, `status = bumped`.
- If `started_at` is null it stays null — starting is explicitly optional
  ("optional configuration", UC-KDS-01 step 4). Prep time for FR-KDS-041 then
  falls back to `routed_at → ready_at`.
- **Idempotent:** a line already `bumped` or `served` is left untouched — no
  timestamp is overwritten, no error. A `cancelled` line cannot be bumped.
- Then recompute the **Ticket** projection in the same transaction.

### When the Ticket becomes ready / bumped

- `ready` — every non-`cancelled` line is `ready` or beyond; set
  `ticket.ready_at` if unset.
- `bumped` — every non-`cancelled` line is `bumped` or beyond; set
  `ticket.bumped_at`, `bumped_by`.
- A ticket **all** of whose lines are `cancelled` is not "bumped"; it stays in
  its current status and the display strikes it through (§Q).

### Bump all (FR-KDS-024, whole Ticket)

- For every line that is not already `bumped`/`served`/`cancelled`: set
  `ready_at`, `bumped_at`, `bumped_by`, `status = bumped`.
- **Already-bumped lines are left exactly as they are** — their original
  `bumped_at` and `bumped_by` are preserved. This matters for FR-KDS-041's
  by-employee attribution: a cook who bumped their own item at 12:03 must not
  be retroactively replaced by the expediter who bumped-all at 12:07.
- Cancelled lines are skipped.
- Ticket → `bumped`, `bumped_at`/`bumped_by` set.

### When `ticket.bumped` is published

**Only on aggregate ticket bump** — i.e. when the Ticket transitions to
`bumped`, whether that was reached by "bump all" or by the last outstanding
line being bumped individually. **An item bump that leaves other lines
outstanding publishes nothing.**

Evidence and reasoning: §5.5.4 names the event `ticket.bumped`, not
`ticket.line.bumped`, and its subscribers are Sales and Analytics — consumers
of a *ticket-completion* fact. UC-KDS-01 step 5 does say "System records
`ready_at` for that line and publishes `ticket.bumped`", but in that scenario
the Grill ticket has exactly one line (the burger), so the line bump *is* the
ticket bump — the step is consistent with both readings and discriminates
neither.

**Classification: NOT SOURCE-DECIDABLE** whether an item bump on a
multi-line ticket should also publish. The recommendation (aggregate only) is
chosen because the alternative makes Sales receive N events per ticket with no
way to tell which was the last, and because §5.5.4's event *name* is
ticket-scoped. Recorded here so the Fire/bump implementation slice adopts it
knowingly rather than by accident.

### What `ticket.bumped`'s payload must eventually carry

UC-POS-01 step 7 — "System receives `ticket.bumped`, **updates line states to
ready**" — is the requirement. The current payload
(`{ ticketId, orderId, businessDay }`) cannot satisfy it: Sales cannot know
*which* lines. The payload must add the affected `orderLineId`s, e.g.:

```ts
{
  ticketId, orderId, businessDay,
  stationId,
  bumpedAt: string,            // ISO — NFR-REL-002 original-timestamp preservation
  orderLineIds: readonly string[],
}
```

Sales sets those lines to `ready` **only when every station ticket carrying
them has bumped** — a line routed to Grill *and* Packaging is not ready until
both bump (FR-KDS-011). That cross-ticket rule lives in Sales' subscriber and
is **out of scope here**; it is recorded because it constrains the payload.

**This gate does not finalise `ticket.bumped`.** It is named as a dependency of
the *bump* slice, not of the Ticket-persistence slice.

---

## P. RECALL SEMANTICS

FR-KDS-025 is `[M]`. Design only; nothing implemented.

| Question (§20) | Answer | Classification |
|---|---|---|
| Which states are recallable? | `bumped` only | **SOURCE-DECIDED** — "restoring the most recently **bumped** tickets" |
| Ticket only, or lines too? | **Ticket only** | **SOURCE-DECIDED** for tickets; line-level recall is **NOT SOURCE-DECIDABLE** — no source text mentions it. Recommend ticket-level only |
| How is the 30-minute window evaluated? | `now() - bumped_at <= recall_window_seconds`, evaluated at the recall attempt | ENGINEERING-DECIDED (mechanism); the default and configurability are SOURCE-DECIDED |
| Where is the window configured? | **`kitchen.branch_kds_config.recall_window_seconds INT NOT NULL DEFAULT 1800`** | ENGINEERING-DECIDED |
| Is `bumped_at` cleared? | **No — preserved** | ENGINEERING-DECIDED, see below |
| Is `recalled_at` required? | Yes | ENGINEERING-DECIDED |
| What state does the ticket return to? | `in_progress` if any line has `started_at`, else `queued`; lines return to `started`/`queued` symmetrically | ENGINEERING-DECIDED |
| Is repeated recall idempotent? | Recalling a ticket that is not `bumped` is rejected as an invalid transition (not a silent no-op); a *fresh* recall after a re-bump is legal and increments `recall_count` | ENGINEERING-DECIDED |

**Why `bumped_at` is preserved rather than cleared.** FR-KDS-042 `[M]` defines
ticket time as "bump time minus fire time". Clearing `bumped_at` to make the
ticket "look current" would destroy the only input to a mandatory metric —
precisely the failure §20's sustainability principle warns against ("do not
erase historical timestamps merely to make state look current"). Instead:
`bumped_at` retains the most recent bump, `recalled_at` records the most recent
recall, and `recall_count` (≥ 1) marks the ticket as one whose ticket time is
**not a clean measurement**, so FR-KDS-041/042 reporting can exclude or
annotate it.

**Known limitation, stated rather than hidden:** with single `bumped_at` /
`recalled_at` columns, a ticket bumped → recalled → re-bumped retains only the
*latest* of each. Full transition history would need a `ticket_state_events`
table. No source requirement asks for it (FR-KDS-040 asks for timestamps,
FR-KDS-041/042 for aggregates over them), so it is **DEFERRED** and
`recall_count` is the honest flag that the simple columns are lossy for that
ticket. Recorded in §X.

`kitchen.branch_kds_config` is the right home for the window because it already
exists, is branch-scoped, is already RLS-anchored, and is the same table that
already holds the branch's KDS fallback station. `org.settings` is not an
option — ADR 0008 D-11 records it as DEFERRED and un-RLS-anchorable.

**Recall does not touch `ready_at`.** The work was genuinely done; only the
ticket's presence in the active queue is restored.

---

## Q. CANCELLATION SEMANTICS

FR-KDS-029 `[M]`: cancelled lines "SHALL be struck through and highlighted on
the station display, with an alert, and SHALL remain visible for a configurable
period so the cook stops preparing."

| Aspect | Design |
|---|---|
| Marker | `ticket_lines.status = 'cancelled'` + `ticket_lines.cancelled_at TIMESTAMPTZ` |
| Deletion | **Never.** A future `order.line.voided` subscriber MUST NOT delete the TicketLine. `ON DELETE RESTRICT` on the `sales.order_lines` FK backs this at the database level, and there is no application delete path (§24.6.5, ADR 0008 D-12) |
| Visibility period | `kitchen.branch_kds_config.cancelled_line_visibility_seconds INT NOT NULL DEFAULT 900` — ENGINEERING-DECIDED value; FR-KDS-029 requires configurability but names no default |
| Already-`ready`/`bumped` line | Still marked `cancelled` (`cancelled_at` set), and `ready_at`/`bumped_at` are **preserved**. UC-KDS-01 6a is explicit that this case exists and that "the POS prompts for waste disposition" — the food was made; the Kitchen record must say so |
| Interaction with amendments | A cancelled line stays in its original fire batch. It is never moved, and a later amendment never rewrites it |
| Ticket status effect | Cancelled lines are excluded from the ready/bumped aggregate (§O), so one cancelled line does not block a ticket from becoming ready |
| Alert | The alert is a display concern; the persistence fact enabling it is `cancelled_at` being newly set |

**Not designed here:** the `order.line.voided` payload, its subscriber, waste
disposition, or any Inventory effect. Out of scope by §21 and §31.

---

## R. ELAPSED / TARGET / REPORTING SUPPORT

### Elapsed (FR-KDS-020, FR-KDS-022)

`now() − routed_at`. **No stored column** — it is derivable and would be stale
the instant it were written.

### Target (FR-KDS-022, FR-KDS-023)

`tickets.target_ready_at TIMESTAMPTZ NULL`. Storing the **absolute instant**
rather than a duration is what makes FR-KDS-023's "by target completion time"
sort a plain indexed `ORDER BY` and FR-KDS-022's colour bands a direct
comparison. Storing *both* `target_seconds` and `target_ready_at` would
duplicate a derivable value (`target_ready_at = routed_at + target_seconds`),
which §23 forbids — so only the absolute is stored.

Nullable: a branch that has configured no target has no colour banding, which
is the correct degenerate behaviour. **Where the target value comes from is
DEFERRED** — FR-KDS-044 `[S]` ("configurable per-item target preparation times,
defaulting to the recipe's `prep_time_seconds`") is the eventual source, and
`catalogue.menu_item_variants.prep_time_seconds` already exists, but neither
per-item target configuration nor Prep-Time-Aware mode is in this MVP. The
column exists so adding it later is a value change, not a schema change.

### Sorting (FR-KDS-023) — all four supported, no extra columns

| Sort | Column |
|---|---|
| Oldest first (FIFO) | `tickets.routed_at` — indexed |
| By target completion time | `tickets.target_ready_at` — indexed |
| By order type priority | `tickets.order_type_snapshot` |
| By course sequence | `ticket_lines.course` |

### Reporting compatibility (FR-KDS-041, FR-KDS-042)

What must be preserved **now** so these are possible later:

| Report | Inputs, all present |
|---|---|
| avg prep time **by item** | `ticket_lines.order_line_id` → item, `started_at`/`routed_at` → `ready_at` |
| **by station** | `tickets.station_id` |
| **by hour** | `routed_at` / `bumped_at` |
| **by employee** | **`started_by` / `bumped_by`** |
| **by order type** | `tickets.order_type_snapshot` |
| "ticket time" = bump − fire (FR-KDS-042) | `tickets.bumped_at` − first batch's `fired_at`; `recall_count > 0` flags an unclean measurement |
| "order time" = last-line-ready − order-open (FR-KDS-042) | Kitchen supplies `max(ready_at)` per order; `orders.opened_at` is Sales' half. **Cross-module — computed in a reporting/analytics context, never by Kitchen querying Sales** |

> **§24's specific question, answered:** yes — FR-KDS-041's "by employee" is
> **impossible** without an actor id on the state transition. Timestamps alone
> cannot attribute. `started_by` and `bumped_by` on both Ticket and TicketLine
> are therefore **SOURCE-REQUIRED by FR-KDS-041 `[M]`**, not speculative
> columns. `first_viewed_by` and `served_by` are **not** added: no requirement
> attributes viewing or serving to an employee, and adding them would be the
> speculation §24 warns against.

Actor ids reference `identity.employees(tenant_id, id)` — the same target
`sales.orders.opened_by/served_by/closed_by` already uses, so KDS timing
attribution joins to the same employee dimension as sales attribution.

**No reporting is implemented.** No `analytics` table, no rollup, no query.

---

## S. MUTABILITY / HISTORY

**ADR-010 does not cover Ticket.** Its decision names "Orders, payments, stock
movements, and audit entries". Calling every Ticket row append-only would be
factually wrong *and* unimplementable: a Ticket exists precisely to advance
through operational state (FR-KDS-040's seven timestamps are seven UPDATEs).
Instead, mutability is classified per column class:

| Class | Columns | Policy | Enforcement |
|---|---|---|---|
| **Identity** | `id`, `tenant_id`, `branch_id`, `business_day`, `order_id`, `station_id`, `ticket_id`, `order_line_id`, `fire_batch_row_id`, `source_modifier_id` | **Immutable after creation** | `tenant_id` immutability is FR-PLT-003 `[M]`; DB: RLS `UPDATE … WITH CHECK` already prevents moving a row to another tenant. Application: never included in an update payload |
| **Source snapshots** | `order_number_snapshot`, `order_type_snapshot`, `service_reference_snapshot`, `item_name_snapshot`, `quantity`, `course`, `preparation_notes`, `sequence`, `name_snapshot`, `kind`, `sort_order` | **Immutable after creation** (BR-POS-004 principle: never recomputed from current master data) | Application-enforced; DB enforcement would need a trigger, which this design does not add |
| **Lifecycle timestamps** | `created_at`, `routed_at`, `first_viewed_at`, `started_at`, `ready_at`, `served_at` | **Write-once** — set only if currently `NULL` | Application-enforced (`WHERE … AND x_at IS NULL`), making the write itself idempotent |
| **Recall-affected** | `bumped_at`, `recalled_at`, `recall_count` | **Controlled transitions only** — `bumped_at` rewritten only by a legitimate re-bump after a recall; `recall_count` monotonically increasing | Application-enforced; §P documents the known lossiness |
| **State projection** | `tickets.status`, `ticket_lines.status` | **Mutable through valid transitions only** (§N); always reconcilable from the line rows | Application-enforced; reconcilability is a test obligation (§W-25) |
| **Cancellation** | `cancelled_at` | Write-once | Application-enforced |
| **Concurrency** | `tickets.version` | Incremented on every ticket update | §24.6.4 |
| **Amendment content** | `ticket_lines` rows, `ticket_fire_batches` rows, `ticket_line_modifiers` rows | **APPEND ONLY.** An amendment INSERTs; it never rewrites, re-times, or deletes previously fired content | The `UNIQUE (tenant_id, ticket_id, order_line_id)` makes re-insertion impossible, so "append" is the only available operation |

**Deletion:** no application DELETE path on any of the four tables — §24.6.5's
soft-delete-with-referential-preservation pattern, and ADR 0008 D-12's
precedent of exposing no destructive endpoint while still creating DELETE
policies so FR-PLT-013's isolation matrix can exercise them.
`ON DELETE RESTRICT` toward `sales.order_lines` makes destroying Kitchen
history as a side effect of a Sales operation impossible.

**Enforcement split, stated plainly:** the database enforces *tenancy,
referential integrity, and uniqueness* — everything in §M's
unrepresentable-state table. The application enforces *transition legality and
write-once discipline*. This design deliberately does **not** add triggers;
where DB enforcement is absent (snapshot immutability, write-once timestamps)
it is named here as an application obligation and a test obligation (§W-21)
rather than being claimed as a database guarantee.

---

## T. EVENT HANDLER TRANSACTION DESIGN

Design only. **Nothing implemented.**

```
POS  ──HTTP──▶  Sales Fire command
                  │
                  └─ unitOfWork.execute(scope, async (ctx) => {
                        …transition order → open, lines → fired,
                          set orders.first_fired_at, order_lines.fired_at…
                        for (const line of firedLines)
                          ctx.publishEvent({ eventType: 'order.line.fired', … })
                     })
                  │
                  ├─ fn resolves
                  └─ dispatcher.drain(ctx)          ← still inside the SAME $transaction
                        │
                        └─ for each event, sequentially:
                             KitchenOrderLineFiredHandler.handle(event, ctx)
                                 │
                                 ├─ routingResolver.resolve(ctx.tx, {...})   ← SAME tx
                                 │      └─ routingConfigQuery.find(ctx.tx, …) ← Organisation
                                 │         public contract (P1E-3A), same tx
                                 │
                                 └─ for each resolved stationId:
                                      upsert kitchen.tickets      (order+station)
                                      upsert kitchen.ticket_fire_batches (ticket+fireBatchId)
                                      insert kitchen.ticket_lines (ticket+orderLine)
                                      insert kitchen.ticket_line_modifiers
                  │
                  └─ callback returns ⇒ withAuthContext's $transaction COMMITs
```

Confirmed against the actual infrastructure (§C), point by point against §26:

- **No outbox for Ticket DB writes.** §5.5.2 is the correct pattern: the writes
  are in the same database and must be atomic. §5.5.3's outbox is for effects
  *outside* the database.
- **No second transaction.** `UnitOfWork.execute` runs inside
  `withAuthContext`'s single `$transaction`; the resolver and the Organisation
  contract query both take the caller's `ctx.tx` (proven by P1E-3A's e2e test:
  exactly one `$transaction` call).
- **Failure rolls back everything.** A handler rejection propagates out of
  `drain()`, out of the callback, and `$transaction` rolls back the Sales write
  *and* every Kitchen write together. §5.5.2's requirement, exactly.
- **No Kitchen query of Sales.** The handler reads only the event payload
  (Sales-owned facts, pushed) and the Organisation public contract (routing
  config). It writes only `kitchen.*`.
- **No Sales import of Kitchen internals.** Sales publishes a typed event from
  its own `contract/`; it never imports `KitchenModule`, the handler, or any
  Kitchen type. The dependency is Sales → event → Kitchen, one-way.
- **One line → multiple TicketLines across multiple station Tickets.** The
  resolver returns `stationIds: readonly string[]`; the handler loops. One
  event, N tickets.
- **Later events converge.** Line 2 of the same batch, routing to a station
  already ticketed by line 1, finds the existing Ticket and the existing batch
  row and only INSERTs its own TicketLine.

**RLS context.** The handler runs inside the tenant context
`withAuthContext` set as the transaction's first statement, so every Kitchen
INSERT is checked by the same `WITH CHECK` predicate as the Sales write. The
handler must never carry a tenant id from the payload into a `WHERE` clause as
a security control — RLS is the control (FR-PLT-010: "independent of
application-layer filtering").

**Module wiring the implementation slice must add:** `KitchenModule` into
`app.module.ts` (currently absent), and the handler annotated
`@DomainEventHandler(ORDER_LINE_FIRED_EVENT_TYPE)` so
`DomainEventHandlerRegistry`'s `DiscoveryService` scan finds it.

**Boundary note:** the handler is Kitchen-**private** (`src/modules/kitchen/`,
not `contract/`). Nothing outside Kitchen references it; it is reached only by
the dispatcher. The existing `module-boundaries.spec.ts` assertions
("`violations.filter(v => v.importer === 'kitchen')` is empty", zero new
`KNOWN_DEVIATIONS`) must continue to hold.

---

## U. CONCURRENCY / IDEMPOTENCY

Each scenario §27 lists, with the mechanism that makes it safe:

| # | Scenario | Mechanism |
|---|---|---|
| 1 | **Two lines of one order route to the same station** | Both events are handled sequentially inside one transaction (dispatcher `await`s each handler in publication order). The second finds the Ticket the first created. Converges to one Ticket, two TicketLines |
| 2 | **Two line events processed sequentially in the same UoW** | Same as 1. No intra-transaction concurrency exists — verified in the dispatcher source, not assumed |
| 3 | **Repeated Fire HTTP request (replay)** | The same `fireBatchId` re-presents. `UNIQUE (tenant_id, ticket_id, fire_batch_id)` no-ops the batch; `UNIQUE (tenant_id, ticket_id, order_line_id)` no-ops each line. **No duplicate ticket, batch, line, or amendment alert** |
| 4 | **Accidental duplicate event within one drain** | Same two uniques. Idempotent by construction, not by a seen-set |
| 5 | **Concurrent Fire attempts against the same order** | Two layers: `orders.version` optimistic concurrency (§24.6.4) at the Sales level, and — should Fire not bump the version — `UNIQUE (tenant_id, order_id, business_day, station_id)` plus `UNIQUE (tenant_id, ticket_id, sequence_no)` at the Kitchen level. One transaction commits; the other gets a unique violation and retries against the now-existing state |
| 6 | **A later amendment to the same station** | Finds the existing Ticket; creates a *new* batch row with the next `sequence_no`; appends only new lines |
| 7 | **The same line routed to two stations** | Two Tickets, two TicketLines. `UNIQUE (tenant_id, ticket_id, order_line_id)` permits it because `ticket_id` differs — the constraint is deliberately ticket-scoped, not line-scoped |
| 8 | **Lost update on ticket status** | `tickets.version` (§24.6.4): the update asserts the expected version |
| 9 | **Event-order-dependent snapshots** | **Eliminated by design**: every `order.line.fired` event carries the full ticket header, so whichever event arrives first can create the Ticket and no later event needs to patch it |

**Ticket creation must be an atomic upsert, not check-then-insert.** The
recommended shape is `INSERT … ON CONFLICT (tenant_id, order_id, business_day,
station_id) DO NOTHING` followed by a `SELECT`, or `ON CONFLICT … DO UPDATE SET
… RETURNING`. A bare `SELECT` then `INSERT` is a lost-update race across
transactions even though it is safe within one. The unique index is the
authority in either case.

**No advisory or row locks are proposed.** §24.6.4 confines pessimistic locking
to two named cases — "order-number allocation and count-session exclusivity" —
and Ticket creation is neither. Uniqueness + retry is the source-consistent
mechanism.

---

## V. MVP / DEFERRED BOUNDARY

| Item | Classification |
|---|---|
| `kitchen.tickets` / `kitchen.ticket_lines` | **MVP PERSISTENCE REQUIRED NOW** |
| Ticket/TicketLine display snapshots (§F) | **MVP REQUIRED NOW** — FR-KDS-020 `[M]`; without them the module boundary is violated on day one |
| `kitchen.ticket_line_modifiers` + `kind` | **MVP REQUIRED NOW** — FR-KDS-021 `[M]`; blocked on GAP-K1 (§G), whose fix is 3 ALTERs |
| `kitchen.ticket_fire_batches` (amendment grouping) | **MVP REQUIRED NOW** — retro-fitting batch identity onto existing ticket lines is a data migration, not a column add |
| Seven timestamps × ticket + line | **MVP REQUIRED NOW** — FR-KDS-040 `[M]`, columns only |
| `started_by` / `bumped_by` | **MVP REQUIRED NOW** (columns) — FR-KDS-041 `[M]`; unrecorded attribution is unrecoverable later |
| Final `order.line.fired` payload | **MVP REQUIRED NOW** — no producer exists, so it is free now and a versioned break later |
| Cancellation marker (`cancelled_at`, status) | **MVP REQUIRED NOW** (columns) — FR-KDS-029 `[M]` |
| Recall columns (`recalled_at`, `recall_count`) + `branch_kds_config` window | **MVP REQUIRED NOW** (columns + config) — FR-KDS-025 `[M]` |
| `target_ready_at` column | **MVP REQUIRED NOW** (column, nullable) — FR-KDS-022 `[M]`; population deferred |
| Sorting support | **MVP** — satisfied by existing columns + indexes; no new work |
| Bump item / bump all **behaviour** | **DESIGN NOW / IMPLEMENT LATER** — §O; needs the KDS route slice |
| Recall **behaviour** | **DESIGN NOW / IMPLEMENT LATER** — §P |
| Cancellation **handler** (`order.line.voided` subscriber) | **DESIGN NOW / IMPLEMENT LATER** — §Q |
| `ticket.bumped` final payload | **DESIGN NOW / IMPLEMENT LATER** — §O; belongs to the bump slice |
| FR-KDS-013 Expediter (Pass) display `[S]` | **DEFER SAFELY** — §D shows the per-station query already works; no schema change |
| FR-KDS-012 staggered release `[S]` | **DEFER SAFELY** — would add `ticket_lines.release_at`; additive, non-breaking |
| FR-KDS-030 all-day counts `[S]` | **DEFER SAFELY** — an aggregate over existing rows |
| FR-KDS-031 icon/image mode `[S]` | **DEFER SAFELY** — additive |
| FR-KDS-045 capacity warnings `[C]` | **DEFER SAFELY** — `org.stations.capacity_config` already exists, unparsed |
| FR-KDS-027 priority flags `[S]` | **DEFER SAFELY** — additive column |
| FR-KDS-041/042 reporting **queries** | **DEFER SAFELY** — §R proves the inputs are preserved |
| NFR-REL-003 local peer discovery | **DEFER SAFELY** — §I shows ULID minting by the creating node already accommodates it |
| NFR-REL-002 local bump buffering | **DEFER SAFELY** — the "original timestamp preserved" requirement is already honoured by §N's no-`DEFAULT now()` rule |
| Fire HTTP route + `pos.order.fire` permission | **OUT OF SCOPE** — §28; unchanged, still `FIRE AUTHORIZATION: NOT SOURCE-DECIDABLE` |

No `[S]`/`[C]` feature is pulled into the MVP. Every item marked "REQUIRED NOW"
is either `[M]`-backed or is a column whose later addition would require a data
migration rather than a schema addition.

---

## W. FUTURE TEST MATRIX

Exact tests for the implementation slice. All 48 items from §30, plus the
prerequisite tests GAP-K1 introduces.

**SCHEMA / TENANCY**
1. Ticket tenant isolation — tenant B cannot read tenant A's tickets.
2. Ticket `branch_id` must match its Station's branch (composite FK rejects otherwise).
3. Ticket Order FK is partition-safe — a `(tenant, order, business_day, branch)` tuple that is not a real order row is rejected.
4. `UNIQUE` — a second Ticket for the same `(tenant, order, business_day, station)` is rejected.
5. TicketLine composite OrderLine FK rejects a non-existent `(tenant, order, line, business_day)`.
6. **TicketLine cannot reference an OrderLine from a different Order than its Ticket** — the §M proof, tested directly.
7. The same OrderLine may appear on two station Tickets (accepted).
8. Duplicate TicketLine for the same `(ticket, order_line)` rejected.

**SNAPSHOTS**
9. A Ticket card renders (order number, order type, service reference, elapsed anchor) with **zero** Sales queries — asserted by spying on the Prisma client, not by inspection.
10. TicketLine renders item name, quantity, and preparation notes with zero Sales queries.
11. Modifiers render from `kitchen.ticket_line_modifiers` only — zero Catalogue queries.
12. Removal vs addition distinction survives the whole path: Catalogue `kind` → Sales snapshot → event payload → Kitchen row.

**AMENDMENTS**
13. First fire creates the Ticket with a `sequence_no = 0` batch.
14. A later fire to the same station **reuses** the same Ticket row (same `id`).
15. The amendment adds only new `ticket_lines` rows.
16. Original TicketLines are byte-for-byte unchanged (including their timestamps) after an amendment.
17. Multiple amendment batches are distinguishable — `sequence_no` 0, 1, 2 with the correct line membership.
18. Retry of the same `fireBatchId` creates no duplicate batch and no duplicate line.

**TIMESTAMPS**
19. All seven FR-KDS-040 timestamps exist and are individually addressable on `tickets`.
20. All seven exist on `ticket_lines`.
21. Write-once discipline: a second attempt to set `started_at`/`ready_at`/`served_at` does not overwrite the first.
22. Replay preserves the original `routed_at` (from `payload.firedAt`) while `created_at` reflects the replay — the two do not collapse.

**BUMP**
23. Bump one line sets `ready_at` + `bumped_at` + `bumped_by`, status `bumped`.
24. Bump all sets them for every eligible line, skips cancelled lines, and **preserves** an already-bumped line's original `bumped_at`/`bumped_by`.
25. Ticket status transitions correctly and is **reconcilable** from its lines (the §N projection obligation).
26. Duplicate bump is idempotent — no timestamp changes, no error.
27. `ticket.bumped` publication semantics are testable: aggregate bump publishes, a non-final item bump does not.

**RECALL**
28. Recall within the window restores the ticket and its lines.
29. Recall outside `recall_window_seconds` is rejected.
30. `bumped_at` is **not** destroyed by a recall; `recalled_at` and `recall_count` are set.
31. Recalling a non-`bumped` ticket is rejected; a fresh recall after a re-bump increments `recall_count`.

**CANCEL**
32. A fired cancellation does **not** delete the TicketLine.
33. The cancellation stays distinguishable (`status = cancelled`, `cancelled_at`).
34. A cancelled line cannot silently disappear — it is still returned by the ticket read; `ON DELETE RESTRICT` blocks a delete attempt.

**CONCURRENCY / IDEMPOTENCY**
35. Duplicate line-fired event creates no duplicate Ticket.
36. …and no duplicate TicketLine.
37. Two lines to the same station converge on one Ticket.
38. A multi-station line creates one TicketLine per station Ticket.
39. Concurrent same-order/same-station creation cannot produce two Tickets — two real transactions racing; one must fail on the unique.

**BOUNDARIES**
40. Kitchen queries no Sales table (mechanical architecture test, extending `module-boundaries.spec.ts`; a Prisma-client spy in the handler e2e as the runtime half).
41. Sales imports no Kitchen private code.
42. The handler uses the caller's `tx` — exactly one `$transaction` for the whole Fire (the P1E-3A assertion pattern).
43. Handler failure rolls back **both** the Sales write and the Kitchen writes.
44. Zero new `KNOWN_DEVIATIONS`.

**RLS**
45. Missing tenant context fails closed on all four new tables.
46. Tenant A cannot see tenant B's Tickets, TicketLines, batches, or modifier snapshots.
47. `ENABLE` **and** `FORCE` row level security verified on all four (`pg_class.relforcerowsecurity`).
48. Exercised as `ros_app` (`NOBYPASSRLS`), never as `ros_migrator`.

**PREREQUISITE (GAP-K1)**
49. `catalogue.modifiers.kind` is `NOT NULL` and rejects a value outside the three FR-POS-021 kinds.
50. Existing modifier rows are backfilled and the backfill is total.
51. `sales.order_line_modifiers.kind_snapshot` is captured at line creation and is not recomputed (BR-POS-004).

---

## X. UNRESOLVED ITEMS

Every open point, labelled exactly as §33 requires.

1. **Ticket cardinality = one per (tenant, order, business_day, station)** — **SOURCE-DECIDED** (Glossary + FR-KDS-028).
2. **No `ticket_stations` join table** — **SOURCE-DECIDED** (Glossary: "routed to one preparation station").
3. **Course is not part of Ticket identity** — **SOURCE-DECIDED** (FR-KDS-028 + FR-KDS-023).
4. **FR-POS-038 and FR-KDS-028 are compatible under one Ticket** — **SOURCE-DECIDED**.
5. **Amendment grouping needs more than a boolean** — **SOURCE-DECIDED** (FR-KDS-028's "which amendment" alert).
6. **`ticket_fire_batches` table vs. two columns on `ticket_lines`** — **ENGINEERING-DECIDED** (§E; concurrency + idempotency argument).
7. **Amendments append, never rewrite original lines** — **SOURCE-DECIDED** (FR-POS-038 "not a reprint of the whole order").
8. **Ticket must be self-sufficient for rendering (no Sales reads)** — **SOURCE-DECIDED** (§24.8 + §5.2.3).
9. **Exact ticket-header snapshot field list** — **SOURCE-DECIDED** (FR-KDS-020 enumerates them).
10. **No money on Kitchen tables** — **SOURCE-DECIDED** (no FR-KDS requirement names it).
11. **What "customer reference" means for a delivery ticket** — **NOT SOURCE-DECIDABLE.** Recommendation: one pre-redacted display string ≤ 64 chars, minted by the Fire producer; no address, no full phone, no loyalty id.
12. **GAP-K1: `catalogue.modifiers` has no FR-POS-021 kind** — **SOURCE-DECIDED that the gap exists and blocks FR-KDS-021 `[M]`.** Remedy is a prerequisite migration (§Z).
13. **Backfill value for existing `catalogue.modifiers.kind` rows** — **NOT SOURCE-DECIDABLE.** Recommendation: `DEFAULT 'addition'` (the modal case) with the backfill flagged for operator review; no source basis exists to infer a kind from existing data.
14. **Relational `ticket_line_modifiers` over typed JSON** — **ENGINEERING-DECIDED** (FR-KDS-021 `[M]` enforceability).
15. **KDS-surface item name is not captured by Sales** — **NOT SOURCE-DECIDABLE** whether it must be snapshotted at sale time or fire time. FR-MNU-005 `[M]` requires the surface to exist; BR-POS-004's snapshot list does not name it. Recommendation: Fire-time capture into the payload; option (ii) recorded (§F).
16. **One `order.line.fired` per line, retaining the catalogued event name** — **SOURCE-DECIDED** (§5.5.4 names it; §12's preferred direction confirmed).
17. **`fireBatchId` shared across a Fire command's line events** — **ENGINEERING-DECIDED**; no source names a batch identity, but idempotency and FR-KDS-028 require one.
18. **Ticket header repeated on every line event** — **ENGINEERING-DECIDED**, to eliminate event-order dependence (§H).
19. **Kitchen mints Ticket/TicketLine/batch ids** — **ENGINEERING-DECIDED**; permanence/non-reassignment is **SOURCE-DECIDED** (FR-OFF-015).
20. **Explicit state enums alongside the seven timestamps** — **ENGINEERING-DECIDED**, forced by two non-derivable states (`recalled`, `cancelled`) and FR-KDS-023's indexable queue.
21. **A bump sets both `ready_at` and `bumped_at`** — **SOURCE-DECIDED** (UC-KDS-01 step 5, FR-KDS-024).
22. **`created_at` and `routed_at` are distinct** — **ENGINEERING-DECIDED**, required by §22's no-collapse rule; they diverge on replay and on amendment.
23. **No `DEFAULT now()` on the seven timestamps** — **SOURCE-DECIDED** (NFR-REL-002's original-timestamp preservation).
24. **Does an item bump on a multi-line ticket publish `ticket.bumped`?** — **NOT SOURCE-DECIDABLE.** Recommendation: aggregate ticket bump only (§O).
25. **`ticket.bumped` must carry the affected `orderLineId`s** — **SOURCE-DECIDED** (UC-POS-01 step 7). The final payload belongs to the bump slice, not this gate.
26. **Sales marks a line ready only when every station ticket carrying it has bumped** — **SOURCE-DECIDED** (FR-KDS-011 + UC-KDS-01 step 7). Implementation is Sales-side, out of scope.
27. **Recall applies to tickets** — **SOURCE-DECIDED** (FR-KDS-025 "bumped tickets").
28. **Line-level recall** — **NOT SOURCE-DECIDABLE.** Recommendation: not in MVP.
29. **`bumped_at` preserved through a recall** — **ENGINEERING-DECIDED**, required to keep FR-KDS-042 computable.
30. **Recall window stored on `kitchen.branch_kds_config`** — **ENGINEERING-DECIDED** (`org.settings` is unavailable per ADR 0008 D-11).
31. **Full ticket state-transition history (`ticket_state_events`)** — **DEFERRED**; no source requirement. `recall_count` is the honest flag that the simple columns are lossy for a re-bumped ticket.
32. **Cancelled lines are marked, never deleted** — **SOURCE-DECIDED** (FR-KDS-029).
33. **Cancelled-line visibility period default (900 s)** — **NOT SOURCE-DECIDABLE**; FR-KDS-029 requires configurability but names no default.
34. **`started_by` / `bumped_by` are required now** — **SOURCE-DECIDED** (FR-KDS-041 `[M]` "by employee" is otherwise impossible).
35. **`first_viewed_by` / `served_by` are NOT added** — **SOURCE-DECIDED by absence**; no requirement attributes them.
36. **`target_ready_at` stored absolute, nullable; population deferred** — **ENGINEERING-DECIDED** (FR-KDS-044 is `[S]`).
37. **Ticket is NOT covered by ADR-010** — **SOURCE-DECIDED**; ADR-010's list is "Orders, payments, stock movements, and audit entries". Per-column-class mutability (§S) replaces a blanket append-only claim.
38. **Snapshot immutability and write-once timestamps are application-enforced, not database-enforced** — **ENGINEERING-DECIDED** (no triggers added). Stated as an obligation rather than claimed as a guarantee.
39. **Sharing the `sales."OrderType"` enum for the snapshot column** — **ENGINEERING-DECIDED**; a Kitchen-local mirror is the recorded alternative.
40. **Ticket creation must be an atomic upsert, not check-then-insert** — **ENGINEERING-DECIDED** (cross-transaction race).
41. **No pessimistic locking** — **SOURCE-DECIDED** (§24.6.4 confines it to two named cases, neither of them Ticket).
42. **`kitchen.tickets` / `ticket_lines` are not partitioned** — **SOURCE-DECIDED** (FR-DR-001's table list excludes them).
43. **Fire authorization / `pos.order.fire`** — **NOT SOURCE-DECIDABLE**, unchanged from P1D-1. Deliberately untouched (§28). **Ticket persistence is not blocked by it.**
44. **`order.line.voided` payload and subscriber** — **BLOCKED** on a dedicated slice; §Q fixes only the persistence its future subscriber needs.
45. **Cross-module "order time" (FR-KDS-042)** — **SOURCE-DECIDED** as a reporting-context computation; **NOT SOURCE-DECIDABLE** which module owns the query. Out of scope; noted so it is not later mistaken for a licence for Kitchen to read `orders.opened_at`.
46. **P1D-1's "a ticket needs no additional content snapshot — it references" sketch** — **SUPERSEDED** (§C). Rejected as the runtime design on §24.8 / §5.2.3 / NFR-PERF-004 / NFR-REL-003 grounds. Its cardinality sketch is upheld; only its snapshot-vs-reference conclusion is reversed.
47. **P1D-1 CONFLICT 1–5 (approved-SQL vs partition/enum/timestamp reality)** — all five **RESOLVED** by this design (§C table). **CONFLICT 6 (Station aggregate placement)** — **NOT REOPENED**; already settled by ratified ADR 0008 D-07.
48. **P1D-1's open item "POS or server mints ticket ids"** — **CLOSED as ENGINEERING-DECIDED**: neither; the Kitchen handler mints them (§I).

---

## Y. P1E-4 EXIT

- **P1E-4 TICKET CARDINALITY CLOSED: YES**
- **P1E-4 SNAPSHOT MODEL CLOSED: YES**
- **P1E-4 AMENDMENT MODEL CLOSED: YES**
- **P1E-4 EVENT CONTRACT CLOSED: YES**
- **P1E-4 LIFECYCLE/TIMESTAMPS CLOSED: YES**
- **P1E-4 TENANCY/FK DESIGN CLOSED: YES**
- **P1E-4 IDEMPOTENCY/CONCURRENCY CLOSED: YES**
- **P1E-4 MIGRATION-READY: NO**
- **P1E-4 OVERALL COMPLETE: YES**

**Why MIGRATION-READY is NO, and why OVERALL is still YES.** The Kitchen design
itself is complete and unambiguous — every one of §32's 30 questions is
answered, and no persistence-critical ambiguity remains in the Ticket
aggregate. But **GAP-K1** is a genuine blocking prerequisite outside Kitchen:
`kitchen.ticket_line_modifiers.kind` cannot be populated because
`catalogue.modifiers` has no FR-POS-021 kind and `sales.order_line_modifiers`
therefore snapshots none. Writing the Kitchen migration before that prerequisite
would either ship a column that can never be filled or force a fabricated
semantic — both of which this gate exists to prevent. `MIGRATION-READY: NO`
is the honest answer for the *migration*; the *design* is closed, which is what
`OVERALL COMPLETE: YES` claims. This is the identical pattern P1E-2 used
(design closed, `MIGRATION-READY: NO` pending two prerequisites) and P1E-3 then
discharged.

### Exact migration prerequisites for the next slice

**Prerequisite migration P (Catalogue + Sales), 3 statements plus backfill:**
```
CREATE TYPE catalogue."ModifierKind" AS ENUM ('addition','removal','substitution');

ALTER TABLE catalogue.modifiers
  ADD COLUMN kind catalogue."ModifierKind" NOT NULL DEFAULT 'addition';
  -- DEFAULT is the total backfill; see §X-13. Operator review flagged.

ALTER TABLE sales.order_line_modifiers
  ADD COLUMN kind_snapshot catalogue."ModifierKind" NOT NULL DEFAULT 'addition';
  -- BR-POS-004 sale-time snapshot; the DEFAULT covers existing rows only and
  -- the capture path must supply it explicitly for new rows.
```
Plus the application change: `ModifierGroupsService.addModifier` accepts and
persists `kind`; `OrderLinesService` snapshots it at line creation.

**No other prerequisite exists.** In particular — verified against a
fully-migrated database — `sales.orders` and `sales.order_lines` need **no new
index**: `uq_orders_tenant_id_business_day_branch` and
`uq_order_lines_tenant_order_id_business_day` (both created by P1E-3) are
exactly the FK targets §J and §K require. The only additive unique this design
introduces is on `kitchen.tickets`, a table the same migration creates.

**Migration Q (Kitchen), the main one:** 4 tables, 3 enums
(`TicketStatus`, `TicketLineStatus`, `ModifierKindSnapshot` — or reuse
`catalogue."ModifierKind"`), 2 new columns on `kitchen.branch_kds_config`
(`recall_window_seconds`, `cancelled_line_visibility_seconds`), all FKs,
uniques, CHECKs, indexes, RLS `ENABLE` + `FORCE` + 4 policies each, and
`ros_app` grants.

---

## Z. NEXT

### **TICKET / TICKETLINE PERSISTENCE + TRANSACTIONAL KITCHEN HANDLER IMPLEMENTATION**

**WHY NOW.** Every piece built in P1E-1 through P1E-3A is blocked on the same
missing thing, and this is it. The routing resolver (P1E-3) has no caller. The
domain-event/UoW foundation (P1E-1C) has no production handler — `grep -rn
"@DomainEventHandler" src/modules/` returns nothing. `sales.order_line_station_overrides`
(P1E-3) has no writer. `order.line.fired` and `ticket.bumped` are typed
contracts with no producer or consumer. One slice — persist Ticket/TicketLine
and add the Kitchen handler — gives all four their first real use, and it is
the last thing standing between this repository and a working Fire.

**SRS IDs.** FR-KDS-011, FR-KDS-020, FR-KDS-021, FR-KDS-029, FR-KDS-040
(columns), FR-POS-021 (prerequisite), FR-POS-038 / FR-KDS-028 (amendment
persistence), FR-PLT-003 / 010 / 011 / 012 / 013 / 014, FR-DR-001 (by exclusion),
FR-OFF-015, §5.5.2, §5.5.4, §7.3 #23, §24.6.4, §24.6.5, §25.1, UC-POS-01 step 6,
UC-KDS-01 (trigger).

**DEPENDENCIES.** All satisfied except one: P1E-1C event/UoW foundation ✔;
P1E-3 routing resolver ✔; P1E-3A Organisation public contract ✔; P1E-3's K-1
unique indexes on `sales.orders`/`sales.order_lines` ✔ (the FK targets exist and
were verified against a live database). **Outstanding: prerequisite migration P
(GAP-K1)**, which the same slice should perform first.

**SOURCE-READY.** Yes. §J/§K/§L give exact columns, types, nullability, keys,
FKs, CHECKs, indexes, RLS, and grants; §H gives the exact event payload; §N
gives the exact state machine and timestamp semantics; §W gives 51 tests. The
45 items in §X are each labelled, and none of the `NOT SOURCE-DECIDABLE` ones
blocks the schema — each has a recommended default that a later requirement can
change without a redesign.

**BLOCKERS.** GAP-K1 only, and it is discharged by three ALTER statements
inside the same slice.

**WHAT IT UNLOCKS.** The Fire HTTP slice (which then only needs the
authorization decision, still deliberately open); the bump/recall route slice;
the `order.line.voided` subscriber; the Expediter view; and FR-KDS-041/042
reporting — all of which need Ticket rows to exist before they can do anything.

**NOT the Fire HTTP route.** Combining them would drag in the
`pos.order.fire` authorization question, which §28 explicitly keeps closed and
which P1D-1 recorded as `NOT SOURCE-DECIDABLE`. The handler can be built and
proven end-to-end by publishing `order.line.fired` from a test-owned
`UnitOfWork.execute` call, with no route and no permission — so persistence and
authorization stay independently decidable.

**This gate does not implement any of it.** No table, model, service, handler,
route, or migration was created.

---

## AA. COMMIT READINESS

**COMMIT READY: YES** — in the narrow sense that this slice's only artefacts
are this report and its `INDEX.md` row. No source file, schema file, or
migration was touched; `git status` shows no change under `prisma/` or `src/`
attributable to P1E-4, and migration count remains 23.

**COMMITTED: NO.** No commit was created, per instruction. This report drafts
no commit message and stages no files; that step is the user's.
