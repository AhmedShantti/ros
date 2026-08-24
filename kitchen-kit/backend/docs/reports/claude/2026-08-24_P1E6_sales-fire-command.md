# P1E-6 — Sales Fire Command + Transactional Kitchen Integration

**Date:** 2026-08-24
**Branch:** `main` (see §A — renamed from `feat/production-spec` outside this session; content matches the task's stated baseline exactly)
**HEAD at start and end (unchanged — no commit made):** `01c0b0f3d3228af5248782a09e8dc0bc65606f9e`
**Slice:** P1E-6 — IMPLEMENTATION. First real Sales producer of `order.line.fired`, through an explicit, authorized, idempotent Fire API, with synchronous transactional Kitchen consequences.
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of implementation work performed in
this session. The ROS SRS and ratified governance decisions remain the sole
authority on what the system is *supposed* to be. Every requirement
classification in §V is a truthful statement of what is verified to work
today, not a claim that broader requirements (completed sale, Payment, COGS,
DayClose) are satisfied.

---

## A. STARTING STATE

- Expected baseline commit `01c0b0f3d3228af5248782a09e8dc0bc65606f9e` — confirmed exact match.
- **Branch name discrepancy (not an error, not caused by this session)**:
  `git branch -vv` showed the current branch as `main`, tracking `origin/main`,
  not `feat/production-spec`. `git reflog` shows this was an explicit external
  rename (`Branch: renamed refs/heads/feat/production-spec to refs/heads/main`)
  that happened outside this session, before this task began. Verified
  `origin/main` and `origin/feat/production-spec` point to the **identical**
  commit (`01c0b0f`, `git diff` between them is empty) — no content
  divergence, only a name change. Work in this slice proceeds on the current
  branch (`main`) since it is verified to be the correct baseline content;
  this discrepancy is recorded, not corrected (no branch operations were
  performed).
- Working tree before this slice: the same uncommitted files the prior two
  reports (`2026-08-23_API1A...`, and the un-reported dev-seed-data work)
  left in place — `.gitignore`, `src/main.ts` (a user-made CORS addition,
  external to any Claude session, preserved untouched except a
  formatting-only `--fix`, see §U), `src/scripts/seed-dev-data.ts`. All
  preserved; none reverted; no `git stash`/`reset`/`checkout`/`restore`/
  `clean`/`rebase` used anywhere in this session.
- 26 migrations, `Database schema is up to date!` (read-only `prisma migrate
  status`, confirmed before any other action, no migration applied — §S).
- 131 live OpenAPI operations at the start (confirmed via the already-checked-in
  `docs/api/openapi.json`).

---

## B. RATIFIED FIRE AUTHORIZATION

Recorded as a new, **unnumbered** entry in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`, titled exactly **"Fire
Authorization Ratification — 2026-08-24"**, inserted immediately before
`## Final Decision Matrix` (the same position every other carried-item
section — P1A, P1C, P1D — occupies relative to that closing section). **No
D-21 was created**; the register's own "20-decision tally" language is
explicitly preserved unchanged in the new entry's header note, matching the
P1A/P1C/P1D convention exactly.

Content ratifies, verbatim to the task's 7 points: `pos.order.fire`
introduced; manual Fire requires it; standard Waiter/Cashier roles receive
it (as **policy**, not a system-enforced mechanism — see §C for why); `pos.
order.create` remains separate and does not imply Fire; future automatic
Fire is a consequence of an already-authorized initiating operation and
needs no second interactive check; no other permission is broadened.

An existing, related-but-distinct entry was found and explicitly NOT
reopened: **CLARIFICATION C — Fire authority boundary** (`docs/governance/
GOVERNANCE_DECISION_REGISTER.md`, under `## P1A`) settles authority to
mutate an order's content **after** it has been fired (a privileged,
Manager-or-higher, not-yet-implemented correction path) — a different
question from authority to fire in the first place, which is what this new
entry settles. Both are cited, cross-referenced, and left standing.

---

## C. PERMISSION IMPLEMENTATION

**Inspected first, before writing any code**: how permissions and role
assignments are actually stored and granted in this repository.

Findings, all verified by direct source inspection, not assumed:

1. Every module defines its permission codes as a plain `<MODULE>_PERMISSIONS`
   object + a `<MODULE>_PERMISSION_DEFS: PermissionDef[]` array (e.g.
   `sales.permissions.ts`). This is CODE, not a migration or a DB seed file.
2. `PermissionsService.upsert()`/`upsertMany()` is the sole persistence
   mechanism — an idempotent upsert by `code`. It is called from tests and
   from the (Claude-authored, prior-session) dev seed script
   (`src/scripts/seed-dev-data.ts`), **never from any production bootstrap
   path** — confirmed by grepping every call site of
   `ensureIdentityPermissions()`, `SALES_PERMISSION_DEFS`, etc. across
   `src/`: not one production `onModuleInit`, controller, or service invokes
   permission-catalog seeding. This is true for **every** module's
   permissions, not just Sales — a pre-existing, repository-wide gap that
   predates and is broader than Fire.
3. `RolesService.createTenantRole()` is the only place a `Role` row is ever
   created, and it is invoked exclusively from the RBAC admin API
   (`rbac.controller.ts`) or from tests/the dev seed script — **there is no
   "standard role" persistence mechanism anywhere in this repository.**
   ROS's RBAC is fully tenant/admin-driven: a tenant administrator names and
   creates whatever roles they want (a role literally named "Waiter" is a
   choice a tenant admin makes via the API, not a system-defined type).

**Consequence for the ratified requirement** ("Standard Waiter/Cashier role
receives `pos.order.fire`"): since ROS has no fixed "standard role" system to
attach a migration or seed to, this is implemented as **exactly two
things**:

1. The permission **code** `pos.order.fire` — added to
   `SALES_PERMISSIONS`/`SALES_PERMISSION_DEFS` in `sales.permissions.ts`,
   the identical pattern every other Sales permission code already uses.
2. **Policy recorded in governance** (§B) for whoever creates a tenant's
   Waiter/Cashier-equivalent roles (a real tenant admin, onboarding
   tooling, or a dev seed script) to grant this code on them — not a
   hardcoded system role.

**Migration count**: per §5's own instruction ("If permissions are
seed/code driven and no migration is required: do not invent one"),
**no migration was created — 26, unchanged.** Confirmed: `schema.prisma`
untouched, `git diff` on `prisma/` is empty, `ls prisma/migrations | grep
-c "^[0-9]"` = 26 both before and after this slice.

**Required authorization proof** (§20/§28): both directions proven for real,
through the real HTTP route, in `test/sales-fire.e2e-spec.ts`:

- An actor with `pos.order.create` but WITHOUT `pos.order.fire` →
  `POST .../fire` → **403** (test: "an actor with pos.order.create but
  WITHOUT pos.order.fire gets 403 on Fire").
- An actor WITH `pos.order.fire` → reaches Fire business logic → **200**
  (test: "an actor WITH pos.order.fire reaches Fire business logic").
- A role named `fire_waiter_<stamp>` was created carrying
  `pos.order.create` + `pos.order.fire` and queried directly from
  `identity.role_permissions` to prove it does **not** carry
  `cash.session.open` (Treasury) — Waiter gains Fire, not cash handling.
- A cross-tenant actor firing another tenant's order → **404** (RLS makes
  the row invisible, never 403 — consistent with the rest of Sales).
- A dashboard (non-terminal-bound) session → **403** (existing
  `requireTerminal` check, unchanged, reused verbatim).

---

## D. CURRENT FIRE PREREQUISITE AUDIT

Read/confirmed before writing any Fire code (not re-derived from stale
reports where current source differs):

- `order-state.ts`'s `assertMayFire(orderState, orderType, tableId)`
  **already exists** and is exactly what Fire needs: asserts the order is
  mutable (`assertOrderMutable` — not finalised) and, for `dine_in`, that a
  table is assigned (FR-POS-003). **Reused verbatim, unmodified.**
- `TRANSITIONS.draft = ['open', 'cancelled']` — the only legal exit from
  `draft` is `open` (or `cancelled`, irrelevant to Fire). `assertTransition`
  reused verbatim for this one transition.
- The `order.line.fired` **payload contract was already fully specified**
  by P1E-5 (`sales/contract/events.ts`) — every field the task's §11 lists
  was already present, with an extensive docblock explaining each group's
  provenance. **Not redesigned** — every field this slice populates was
  already declared.
- `ctx.publishEvent(...)` (P1E-1C's trusted publication path) already
  exists and is the only way to enqueue an event inside a `UnitOfWork`.
- `OrderLineFiredHandler` (Kitchen, P1E-5) already exists, already
  synchronous, already consumes exactly this contract, already calls the
  accepted `RoutingResolverService` and `TicketPersistenceService`. **Not
  modified.**
- `RoutingResolverService`'s five-tier resolution, and its two typed errors
  (`RoutingNoDestinationError`/`RoutingConfigurationConflictError`), already
  exist with an explicit docblock stating they carry no HTTP framing
  because "a future caller (Fire) maps `code` to whatever transport-level
  error shape it needs" — i.e. this exact mapping decision was anticipated
  and left for this slice. **Not modified** — mapped at the Sales boundary
  only (§G/§L).

Nothing above needed redesign; the gap was exactly what the task named:
**a real Fire producer**, plus two narrow Fire-facts contracts (§E/§F).

---

## E. CATALOGUE FIRE-FACTS PUBLIC CONTRACT

New `src/modules/catalogue/contract/` (Catalogue had **no** `contract/`
directory before this slice — confirmed by its absence). Mirrors the
accepted P1E-3A `RoutingConfigQuery` pattern exactly:

- `contract/fire-facts.query.ts` — `CatalogueFireFactsQuery` interface +
  `CATALOGUE_FIRE_FACTS_QUERY` injection token + DTOs only. Batched by
  design: `find(tx, {tenantId, menuItemIds: readonly string[]})` — one call
  per Fire command across every distinct `menuItemId` being fired, not one
  call per line.
- `fire-facts/catalogue-fire-facts.query.service.ts` — the PRIVATE
  Prisma-backed implementation, bound via `useExisting` only inside
  `CatalogueModule`.
- Result per item: `categoryIds` (distinct, **sorted** —
  `catalogue.menu_item_placements` for that item; used by Sales strictly as
  a ROUTING SELECTOR passed to Kitchen — Sales/Catalogue never chooses a
  station, the Kitchen resolver remains sole routing authority) and
  `kitchenName` (the `MenuItem.kitchenNames` JSONB field verbatim when
  non-empty, `null` when absent/empty — inspected the current Catalogue
  schema directly rather than inventing a relation; this field already
  existed, already exposed by `toMenuItemView`).

**Transaction**: `find()` takes the caller's own `Prisma.TransactionClient`
— no second transaction, no HTTP call, no event request/reply — proven live
by the fact that Fire's own single `UnitOfWork.execute()` transaction is
what supplies `ctx.tx` to this call (§L).

**Boundary discipline**: the pre-existing `sales->catalogue` deviation
(`pricing/price-resolution.service`, in `module-boundaries.spec.ts`'s
`KNOWN_DEVIATIONS`) is **verified unchanged, not expanded** — a dedicated
test (`Catalogue publishes a public Fire-facts contract, and Sales consumes
only that contract`) asserts the deviation entry still names exactly the
one pre-existing inner path, and that `sales-fire.service.ts` imports
Catalogue only via `'../../catalogue/contract'`, never
`catalogue/menu-items`/`catalogue/fire-facts`.

---

## F. ORGANISATION TABLE-DISPLAY PUBLIC CONTRACT

**FR-KDS-020 investigation, done before writing any code**: `sales.orders.
table_id` is a bare, FK-less UUID (Sales/Organisation are different
bounded contexts — the same pattern as `identity.terminals.branch_id`), so
Sales has no human-readable table text of its own. Inspected Organisation's
current Table model: `org.tables` (`BranchTable` in Prisma) has `label`
(`VARCHAR(16)`, **unique per branch**) — an unambiguous, source-backed,
user-visible display value. **This resolved the task's explicit blocker
condition as NOT triggered** — a real display fact exists, so Fire
implementation was not stopped.

New `organisation/contract/table-display.query.ts` (added to the
**existing** `organisation/contract/` barrel, alongside `routing-config.
query.ts`, unmodified): `TableDisplayQuery` interface +
`TABLE_DISPLAY_QUERY` token, `find(tx, {tenantId, tableId}) ->
{label: string} | null`. **Only `label` is exposed** — `section`/
`seatCapacity` stay private, matching "do not expose unrelated Table
fields."

Private implementation: `organisation/tables/table-display.query.service.ts`,
bound via `useExisting` only inside `OrganisationModule`. `sales->
organisation` did not previously exist as an edge at all (confirmed:
absent from `KNOWN_DEVIATIONS`) — it is **public from the start**, no
deviation entry added (test: "Organisation publishes a public Table-display
contract, and Sales consumes only that contract").

**Usage rule, implemented exactly as specified**: `serviceReference` is
populated ONLY when `orderType === 'dine_in' && tableId !== null` (queries
the contract for the label). For every other order type — even if a
`tableId` happened to be present, which `assertMayFire` does not otherwise
forbid — `serviceReference = null`. `Order.aggregatorRef` (a real column)
was deliberately **not** used as a fallback source: the task explicitly
names "aggregator label" among the things not to invent, and no source
establishes `aggregatorRef` as FR-KDS-020's intended non-dine-in source.
If the contract's `find()` returns `null` (an unresolved/dangling table
id), `serviceReference` is also `null` — an honest absence, not a Fire
failure; Fire does not additionally re-verify table-row integrity that its
own Order-creation prerequisite (`assertMayFire`) does not require.

---

## G. SALES FIRE COMMAND

`src/modules/sales/orders/sales-fire.service.ts` — `SalesFireService.
fire(tenantId, input)`. **Private to Sales**, not exported through `sales/
contract` (the contract publishes event TYPES for Kitchen, never a Sales
command). Owns exactly what the task's §7 assigns to the application layer;
the controller (`orders.controller.ts`) owns only path parsing, the
`@RequirePermission`/`@Idempotent` decorators, `If-Match` parsing via the
EXISTING `parseIfMatch` helper (unmodified, reused verbatim — no new ETag
grammar), HTTP status, and the ETag response header via the existing
`orderETag()` helper (unmodified).

**Routing-failure HTTP mapping** — the one genuine design decision this
layer had to make: `RoutingNoDestinationError`/
`RoutingConfigurationConflictError` are, by their own docblock, framework-
agnostic and expect a future Fire caller to map their `code` discriminant
to an HTTP shape. Sales must not import a Kitchen private path (§25), so
the mapping in `SalesFireService.fire()`'s `catch` block is **duck-typed**
on `error.code.startsWith('ROUTING_')`, re-thrown as
`UnprocessableEntityException` — no `instanceof` check against an imported
Kitchen class, no Kitchen import at all. By the time this `catch` runs, the
enclosing `UnitOfWork.execute()`'s `$transaction` has already rolled back
everything (order state, lines, audit, and every Kitchen write Kitchen's
handler made before throwing) — the re-throw only changes the HTTP
response shape.

---

## H. ORDER / LINE STATE TRANSITION

Implemented exactly per §8/§21, reusing `order-state.ts` verbatim:

- `assertMayFire(order.state, order.orderType, order.tableId)` called
  first, always.
- `isFirstFire = order.state === 'draft'`; if true, `assertTransition(
  'draft', 'open')` (defensive re-confirmation of the one legal exit) and
  `firstFiredAt` is written **once**, from a single `fireInstant`.
- Eligible lines = `order.lines.filter(l => l.state === 'pending')`.
- **Zero eligible lines → `NoEligibleLinesToFireError` (extends
  `OrderStateError`) → 422.** Recorded, exactly as instructed, as
  **ENGINEERING-DECIDED, not SRS-mandated** — the SRS does not define a
  successful empty Fire; refusing avoids implying a Fire batch happened
  when nothing was sent to production. See `src/modules/sales/orders/
  fire.errors.ts`'s docblock for the same statement in-source.
- Every eligible line's `state` → `fired`, `firedAt` → the **same**
  `fireInstant` variable (one `new Date()` call for the whole command,
  never per-line) — proven by a dedicated assertion
  (`firedAts.size === 1` across all newly-fired lines in the FIRST-FIRE
  test).
- `order.version` increments **exactly once** per command, regardless of
  how many lines fire (§9/§10 — see §P for how this is made atomic, not
  just asserted).
- **Held/parked orders**: `assertMayFire` does not itself restrict Fire to
  `draft`/`open` (only checks non-finalised + dine-in table) — this is
  pre-existing, unmodified behaviour, not broadened by this slice. Per the
  task's own explicit two-scenario description (§8: only DRAFT→OPEN and
  OPEN→OPEN are described), this slice's state-transition logic targets
  exactly those two cases: `newState = isFirstFire ? 'open' : order.state`
  — a held/parked order's state is left **unchanged** if fired (not tested,
  not claimed as a supported scenario; recorded here rather than silently
  assumed away).

---

## I. ORDER.OPENED EVENT

**Investigated before writing code**: `sales/contract/events.ts` had a
typed contract for `order.line.fired` only. No `order.opened` contract
existed. **Created the narrowest addition the SRS event catalogue supports**
— `ORDER_OPENED_EVENT_TYPE = 'order.opened'`, payload `{orderId,
businessDay, orderNumber, orderType, channel, openedAt}`. No money,
customer, or line-level field — none is named by any source read for this
event, and Kitchen's own correctness continues to rely entirely on the
self-contained `order.line.fired` events (unchanged from P1E-5), never on
this one.

**Precise domain-vocabulary finding, verified by reading
`OrdersService.create()`**: an order is created in state `draft`, not
`open`. "Opened" in ROS's own state machine means the `draft -> open`
transition — which happens on **first Fire**, not at creation. This is
exactly why `order.opened` is published from the Fire command, not from
`OrdersService.create()` — a source-grounded fact, not a naming choice.

**No new subscriber was added or required** — the task explicitly permits
this ("No new subscriber is required merely to justify publishing it").
Publication is proven with a **test-only** `@DomainEventHandler` recorder
(`OpenedRecorderModule`, `test/sales-fire.e2e-spec.ts`), mirroring the
exact pattern `domain-events-registration.e2e-spec.ts` already established
for proving publication count/content without touching `AppModule` or any
production Kitchen file.

---

## J. ORDER.LINE.FIRED EVENT PRODUCTION

One `ctx.publishEvent(...)` call per newly-fired line, using the P1E-5
contract's fields exactly. `eventType`/`eventVersion` from the existing
constants; `occurredAt: fireInstant` (the single shared Date); `branchId:
order.branchId` (read from the loaded aggregate, never the request);
`actorId`/`actorType: 'user'` (every Fire actor — dashboard or PIN — has a
real linked `User`); `causationId` left to `UnitOfWork`'s own default
(the command's own identity, since Fire has no parent event).

**`idempotencyKey` — genuinely NOT SOURCE-DECIDABLE, per `unit-of-work.ts`'s
own docblock.** ENGINEERING DECISION (recorded, not silently made): each
event's `idempotencyKey` is `` `fire:${fireBatchId}:${orderLineId}` `` (and
`` `fire:${fireBatchId}:opened` `` for `order.opened`) — globally unique,
deterministic, derived from the Fire command's own identity plus the
specific line. Verified this is **not** what Kitchen's own idempotency
relies on: `OrderLineFiredHandler` never reads `event.idempotencyKey` at
all (confirmed by reading the file) — Kitchen's real conflict-safety is
`fireBatchId` + natural keys via `INSERT ... ON CONFLICT` (P1E-5A,
unmodified). The envelope field is populated correctly and meaningfully,
but is not load-bearing for Kitchen's own correctness.

---

## K. SNAPSHOT ASSEMBLY

- **`categoryIds`**: from `CatalogueFireFactsQuery`, sorted/de-duplicated at
  the query layer.
- **Kitchen display name**: `itemNameSnapshot` in the EVENT payload (never
  the persisted `sales.order_lines.item_name_snapshot` row, which is never
  rewritten) is assembled as `{...line.itemNameSnapshot, kitchenName:
  facts?.kitchenName ?? null}` — an ENGINEERING DECISION recorded in-source
  and here: the frozen P1E-5 contract types `itemNameSnapshot` as
  `Record<string, unknown>` precisely because it is a flexible JSON-like
  shape; adding `kitchenName` as an additional key inside it satisfies the
  task's instruction to "construct the Fire/Kitchen item display snapshot
  from [the existing snapshot] + Catalogue's current kitchen/KDS name"
  without adding a new contract field or touching persisted Sales data.
- **`lineStationOverrides`**: read directly from
  `sales.order_line_station_overrides` for the line being fired (`{
  overrideId, stationId}` per row) — no interpretation, Sales never chooses
  a station.
- **Modifier snapshots**: `sales.order_line_modifiers` rows for the line,
  mapped 1:1 to the contract's `OrderLineFiredModifier` shape
  (`orderLineModifierId`, `modifierId`, `nameSnapshot`, `kind`, `quantity`)
  — the sale-time snapshot is authoritative; Kitchen/Catalogue are never
  re-queried to reconstruct modifier display semantics.
- **Unknown legacy modifier kind — fail closed**: before any mutation,
  every eligible line's modifiers are checked; the first `kindSnapshot ===
  null` throws `UnresolvedModifierKindError` (extends `OrderStateError`) →
  422 → the WHOLE Fire command rolls back, not just the offending line.
  Proven with a real legacy-shaped row written directly (no live capture
  path can produce `kindSnapshot: null` — confirmed by reading
  `OrderLinesService`, which always copies a real `Modifier.kind`
  verbatim), and the rollback is verified against the DB afterwards (order
  state/version unchanged, line still `pending`, zero `Ticket` rows).
- **`quantity`**: `line.quantity.toString()` — a Prisma `Decimal(12,3)`.
  **Finding, not a bug**: `.toString()` does not zero-pad
  (`'2.5'`, not `'2.500'`) — the contract only requires "a string,"
  never a fixed-precision string; the test was corrected to assert the
  real, natural `.toString()` output rather than an invented expectation.
- **`serviceReference`**: see §F.

---

## L. KITCHEN TRANSACTIONAL CONSEQUENCES

Exactly ONE `UnitOfWork.execute()` transaction per Fire command. No second
`$transaction`, no nested `UnitOfWork`, no outbox, no direct Sales→Kitchen
call, no Kitchen→Sales/Catalogue read — all unmodified from the accepted
P1E-1/P1E-5 architecture; this slice is a **caller** of that mechanism, not
a modification of it.

**Real, PostgreSQL-proven rollback** (not merely asserted, executed against
the live database in `test/sales-fire.e2e-spec.ts`):

- Routing conflict (two categories on one item resolving to different
  station sets) → 422 → order/line state and version confirmed unchanged
  in the DB after the failed call.
- Zero routing destination (a branch with no fallback configured — a
  second branch, `branchC`, deliberately given no `BranchKdsConfig` row,
  was created specifically to exercise this without disturbing `branchA`'s
  otherwise-complete routing setup) → 422 → order/line unchanged, **zero**
  `Ticket` rows created.
- Unresolved modifier kind → 422 → order/line unchanged, zero `Ticket` rows.

**Real routing e2e, through the REAL Fire producer** (§19), each proven by
inspecting the actual `kitchen.tickets`/`kitchen.ticket_lines` rows a real
Fire call produced — not by calling the resolver directly:

| Tier | Proof |
|---|---|
| 1 — explicit line override | `sales.order_line_station_overrides` row wins even though the item is ALSO placed in a tier-4 category |
| 2 — modifier-driven | A line with a real captured modifier (linked via `ModifierGroupLink`) routes to the modifier's station, not the item's tier-4 category |
| 3 — MenuItem branch assignment | A `stationRoutingRule` keyed on `menuItemId` |
| 4 — category default | A `stationRoutingRule` keyed on `categoryId`, item placed via `menu_item_placements` |
| 5 — branch fallback | No override/modifier/menu-item/category rule; `BranchKdsConfig.fallbackStationId` wins |
| Multi-station | Two rules on the SAME winning category tier → 2 `TicketLine` rows, one per resolved station |
| Conflict | Two DIFFERENT categories on one item mapping to DIFFERENT station sets → `RoutingConfigurationConflictError` → 422 + rollback |
| No destination | A branch with no fallback and no other applicable rule → `RoutingNoDestinationError` → 422 + rollback |

---

## M. AUDIT

`AUDIT_ACTION.ORDER_FIRED` added to `governance/audit/audit.constants.ts`
(a plain code-level const addition, `<ENTITY>_<PAST_TENSE>` convention
already established — not a new audit store, not a schema change). Written
via the **existing** `AuditService.record()`, inside the same transaction,
capturing: `actorId` (real actor, dashboard or PIN), `entityId` (order id),
`terminalId` (from the Fire request's own terminal-bound session — the same
`requireTerminal` check every other Sales write route uses), `before:
{state, version}`, `metadata: {state, version, branchId, fireBatchId,
firedLineIds, firstFire}`. Proven with a real DB read after a real Fire
call: exactly one `ORDER_FIRED` entry, correct actor, correct branch,
`fireBatchId` present, `firstFire: true` on the first call.

---

## N. AUTHORIZATION / TENANCY

See §C for the mechanism and the two-directional proof. All 5 of §20's
minimum proofs are implemented as real HTTP-level e2e tests (permission
existence, WITHOUT-permission 403, WITH-permission 200, Waiter/cash
separation, cross-tenant 404, terminal-binding 403) — see §T for the
complete test inventory.

---

## O. IDEMPOTENCY / IF-MATCH

Uses the **existing** `@Idempotent()` infrastructure verbatim — no new
idempotency service, no change to `IdempotencyInterceptor`/
`IdempotencyService`. Proven:

- Same key + same request (same order, same call) → replay
  (`Idempotent-Replay: true`), identical response body, **no** second
  version increment, **no** duplicate `TicketLine`/`FireBatch`.
- Same key + different fingerprint → the existing 409 path — **but see the
  discovered finding below.**

**Real, discovered behaviour, reported honestly rather than silently
avoided**: Fire has **no request body** (explicitly mandated, §6). The
existing, unmodified `IdempotencyService.fingerprint()` hashes
`{method, path, body}`, where `path` is Express's registered ROUTE
PATTERN (`/orders/:businessDay/:id/fire`), not the resolved URL — it does
not vary by order id. Combined with a `null` body, **two different orders
fired with the same Idempotency-Key produce an identical fingerprint**, so
the second call REPLAYS the first order's stored response instead of
either firing the second order or 409-conflicting. Verified directly: order
Y's own DB state stays `draft`/unfired while its HTTP response is order X's
body. This is an interaction between two independently-accepted
decisions — the existing, unmodified fingerprint mechanism, and Fire's
explicitly-mandated bodyless design — not a defect introduced by this
slice, and not something this slice is authorized to fix (§17: "Do not
implement a new idempotency service"; fixing it would mean changing shared
`common/idempotency/` infrastructure). **Practical consequence for a Fire
caller: a genuinely fresh Idempotency-Key must be used per order per Fire
attempt** — reusing one across orders is unsafe. Recorded as a test
(`test/sales-fire.e2e-spec.ts`, "DISCOVERED BEHAVIOUR: same key across two
DIFFERENT orders replays...") documenting the real behaviour rather than
asserting a false expectation, and flagged here for whoever scopes a future
idempotency-hardening slice.

---

## P. CONCURRENCY

`Order.version` is the sole aggregate concurrency token, exactly as
instructed. **A real correctness gap was found and fixed, narrowly, inside
this new code only** (not in `order-state.ts`/`OrdersService`/
`OrderLinesService`, none of which were touched): the repository-wide
existing convention (`OrdersService.transition()`, `OrderLinesService.
addLine()`) is "read the order, call `assertVersion` in application code,
then `UPDATE ... WHERE id = ...`" — the `UPDATE`'s own `WHERE` clause never
re-checks `version`. Under PostgreSQL READ COMMITTED, two genuinely
concurrent transactions can both read the same starting version before
either commits, both pass the application-level check, and (since the
`UPDATE` targets the row by id alone) the second writer's blocked `UPDATE`
would silently apply once unblocked — a lost update, and for Fire
specifically a **duplicated Kitchen consequence**, which §10/§22 explicitly
require to never happen.

**Fix, scoped to `SalesFireService` only**: the Order mutation uses
`ctx.tx.order.updateMany({where: {id, businessDay, version:
expectedVersion}, data: {...}})` — the version guard is now part of the
atomic compare-and-swap itself. `count === 0` (no row matched — either the
caller's read was already stale, or a concurrent writer won the race first)
throws the same `OrderVersionConflictError` the sequential case already
produces → the same existing 409 path, no new error shape. This is **not**
a new retry framework (§10 explicitly forbids one) — it is a single atomic
write with no retry.

**Real proof, not sequential**: `Promise.all([httpFire(...), httpFire(...)])`
against the real HTTP server, real PostgreSQL, same expected version →
`[200, 409]` (order-independent), exactly one `Order.version` increment,
exactly one `TicketLine`, exactly one `FireBatch` — the actual race was
exercised, not simulated.

---

## Q. OPENAPI

`POST /orders/{businessDay}/{id}/fire` documented following the exact
existing convention (Bearer auth via class-level decorators, required
`Idempotency-Key`/`If-Match` headers matching the casing already
established for `addLine`, `orderSchema` success response + `ETag` header,
400/403/409/422 via the accepted `ErrorResponse` mechanism from API-1A —
no new error-documentation pattern invented).

- **Regenerated**: `npm run openapi:generate` — succeeded, `openapi: 3.1.0`
  preserved, **132 operations** (131 + exactly the 1 new Fire route),
  94 paths (93 + 1).
- **`npm run openapi:check`**: reports a diff (the checked-in artifacts vs.
  the regenerated ones) — **expected and correct**, since this slice does
  not commit; the diff is exactly the Fire route's addition, nothing else.
  Not a failure of the mechanism, a correct detection of legitimately
  uncommitted, intentional change.
- `openapi.e2e-spec.ts` — one pre-existing assertion (written before Fire
  existed) explicitly asserted **zero** Fire-shaped paths; **updated** (not
  removed) to assert **exactly one** (`/orders/{businessDay}/{id}/fire`)
  and that Payment/Completion/refund/bump/recall remain absent — the
  assertion's own purpose ("truthfully describe the live surface") required
  this update once Fire became real. All other OpenAPI structural
  assertions (3.1 validity, `$ref` resolution, no duplicate `operationId`s,
  no duplicate parameters, security-metadata completeness, required-header
  presence, required-DTO-field preservation, bidirectional drift detection)
  pass unchanged against the new document.

---

## R. MODULE BOUNDARIES

`module-boundaries.spec.ts` extended with 6 new assertions (17 → 23
total), all passing:

1. Sales' contract barrel now names `order.opened` too (alongside
   `order.line.fired`).
2. Catalogue publishes `CatalogueFireFactsQuery` through `contract/`, and
   `sales-fire.service.ts` imports it only via that barrel — never
   `catalogue/menu-items`/`catalogue/fire-facts`.
3. Organisation publishes `TableDisplayQuery` through `contract/` (added to
   the SAME barrel `RoutingConfigQuery` already lives in), consumed by
   Sales only through that barrel.
4. An explicit "Fire adds zero new module-boundary deviations" assertion
   (`sales->catalogue` still names exactly its one pre-existing inner path;
   `sales->organisation`/`kitchen->sales`/`kitchen->catalogue`/
   `kitchen->organisation` all remain `undefined`).
5. Contract-purity: `catalogue/contract/` and the new
   `organisation/contract/table-display.query.ts` contain interface/types
   only (no `@Injectable()`, no `class`, no Prisma query call) — the same
   `containsPersistenceImplementation` detector P1E-3A established,
   reused unmodified. (One real false-positive was found and fixed during
   this slice: the detector's `class` regex matched the ENGLISH WORD
   "class" inside a docblock's prose — "the concrete class" — fixed by
   rewording the prose to "the concrete implementation," not by weakening
   the detector.)
6. The concrete `CatalogueFireFactsQueryService`/`TableDisplayQueryService`
   implementations are proven PRIVATE (outside `contract/`) and never
   imported by `sales-fire.service.ts`.

The whole-tree exact-equality test (`records every pre-existing deviation,
and no more`) — which fails on ANY unexpected import anywhere in the
repository, not just Sales/Catalogue/Organisation — **passes unchanged**,
which is the strongest available proof that nothing outside the explicitly
reviewed edges above changed.

**Allowed edges used, exactly as scoped**: `Sales -> Catalogue contract`
(new), `Sales -> Organisation contract` (new). **Forbidden edges verified
absent**: `Sales -> Catalogue internal`, `Sales -> Organisation internal`,
`Sales -> Kitchen internal` (verified via the duck-typed error-code
mapping in §G, not an import), `Kitchen -> Sales internal` (unchanged from
P1E-5), `Kitchen -> Catalogue internal` (unchanged).

---

## S. MIGRATIONS

**No migration was created.** `schema.prisma` untouched (`git diff
prisma/schema.prisma` is empty). Migration count: **26**, unchanged, before
and after this slice (`ls prisma/migrations | grep -c "^[0-9]"` = 26 both
times). Per §24: the only possible migration trigger (permission
persistence) resolved to "code-driven, not migration-driven" (§C) — so no
migration is expected or was created. **No from-zero verification was
required or performed**, since no migration exists to verify.

**Read-only migration status check** (before any other action, this
session): `npx prisma migrate status` → "26 migrations found... Database
schema is up to date!" — confirmed, not assumed. **The persistent local-dev
database was NOT mutated for migration purposes.** It WAS used (read AND
written) for the real e2e test suite, exactly as every other e2e spec in
this repository already does against the same database — no separate
scratch database exists in this repository (confirmed in the prior
API-1A slice's own investigation, unchanged) — see §T for the one
DB-hygiene finding this uncovered.

---

## T. TESTS

**New `test/sales-fire.e2e-spec.ts`** — 25 tests, all passing, real HTTP,
real PostgreSQL, `--runInBand`:

- **§20 authorization (5 tests)**: permission existence/separation,
  WITHOUT-permission 403, WITH-permission 200, Waiter/cash separation,
  cross-tenant 404, terminal-binding 403.
- **§21 state/events (4 tests)**: first Fire (state/firstFiredAt/version/
  ETag/`order.opened`-once/shared-`firedAt` all in one test), subsequent
  Fire (only new line fires, old lines untouched, no second
  `order.opened`), zero-eligible-lines 422, unresolved-modifier-kind 422 +
  rollback.
- **§21 snapshots (4 tests)**: Catalogue categoryIds/kitchen-name +
  decimal-string quantity + dine-in serviceReference (one composite test),
  non-dine-in null serviceReference, line station overrides (tier-1 proof
  folded in), modifier snapshots + tier-2 routing proof folded in.
- **§19 routing (5 tests)**: tier 3, tier 5, multi-station, conflict +
  rollback, no-destination + rollback. (Tiers 1/2/4 are proven inside the
  snapshot-assembly tests above, per the task's "do not duplicate every
  routing unit test" instruction — each tier is proven exactly once,
  through the real producer.)
- **§16 audit (1 test)**.
- **§17 idempotency (2 tests)**: same-key replay, and the discovered
  cross-order replay behaviour (§O).
- **§10/§22 concurrency (2 tests)**: stale If-Match, real concurrent race.
- **§18 amendment (1 test)**: existing Ticket reused, new FireBatch/
  TicketLine appended, old TicketLine untouched.

**Existing suites updated** (both legitimately, both because Fire is now
real): `sales.e2e-spec.ts`'s route-whitelist test (§Q), `openapi.e2e-spec.ts`'s
no-Fire-path assertion (§Q).

**Full regression**:

- Full unit suite: **708/708** (51 suites; +6 from the module-boundaries
  extension).
- Full e2e suite (`--runInBand`, real PostgreSQL): **668/669**. The one
  failure — `organisation.e2e-spec.ts`, "leaves no org location entity
  without a registry row" — is **pre-existing and unrelated to this
  slice**, root-caused precisely: `kitchen-ticket-persistence.e2e-spec.ts`/
  `kitchen-ticket-concurrency.e2e-spec.ts` (both untouched by this or any
  Claude session; both predate P1E-6) create `org.branches` rows via raw
  Prisma without a corresponding `org.locations` registry row. Proven
  pre-existing: querying the DB directly found orphan branches dated
  **2026-08-23** (the day before this slice began) alongside new ones
  dated today from re-running those same (untouched) Kitchen test files as
  part of this session's full-suite runs. Confirmed NOT caused by Fire:
  `sales-fire.e2e-spec.ts`'s own `mkBranch` helper creates a matching
  `org.locations` row for every branch it makes (verified in source). A
  targeted, verified-safe cleanup (deleting the 4 identified orphan
  tenants, all named `kitchen-ticket-*`/`kitchen-race-*`, zero relation to
  any real or Fire-related data) was attempted and was **blocked by the
  session's own safety classifier** as a DELETE statement; the attempt was
  not retried or worked around, per this task's own instruction not to use
  destructive workarounds. Fixing the Kitchen test files' own cleanup is
  explicitly out of this slice's scope ("unrelated refactors" — §27).
  **One transient, non-reproducible flake was also observed and ruled
  out**: a single run showed `catalogue.e2e-spec.ts` failing on an
  unrelated permission assertion; re-run in isolation (70/70 passed) and
  re-run as part of the full suite again (passed, not in the failing list)
  — confirmed as resource-pressure flakiness from repeated full-suite
  runs in one session, not a regression.
- `npx tsc --noEmit`: clean except the **pre-existing, unrelated**
  `access-token.service.spec.ts` StringValue-typing error (confirmed
  pre-existing in the prior two slices' own reports; re-confirmed
  unchanged here — not touched, not caused by this slice).
- `eslint` on every changed/new file (18 files): zero errors, zero
  warnings after one auto-fix pass (mechanical formatting only,
  no logic change — including a formatting-only fix to `src/main.ts`'s
  user-authored CORS addition, §U).
- `npx prisma validate`: schema valid.
- `npm run openapi:generate`/`openapi:check`: see §Q.

---

## U. FILES CHANGED

**New**:
- `src/modules/catalogue/contract/index.ts`, `fire-facts.query.ts`
- `src/modules/catalogue/fire-facts/catalogue-fire-facts.query.service.ts`
- `src/modules/organisation/contract/table-display.query.ts`
- `src/modules/organisation/tables/table-display.query.service.ts`
- `src/modules/sales/orders/fire.errors.ts`
- `src/modules/sales/orders/sales-fire.service.ts`
- `test/sales-fire.e2e-spec.ts`

**Modified**:
- `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (§B)
- `src/modules/sales/sales.permissions.ts` (`pos.order.fire`)
- `src/modules/sales/contract/events.ts` (`order.opened`)
- `src/modules/sales/orders/orders.controller.ts` (Fire route)
- `src/modules/sales/sales.module.ts` (wiring)
- `src/modules/catalogue/catalogue.module.ts` (wiring)
- `src/modules/organisation/contract/index.ts`, `organisation.module.ts` (wiring)
- `src/modules/governance/audit/audit.constants.ts` (`ORDER_FIRED`)
- `src/modules/module-boundaries.spec.ts` (§R)
- `test/openapi.e2e-spec.ts`, `test/sales.e2e-spec.ts` (§Q)
- `docs/api/openapi.json`, `docs/api/openapi.yaml` (regenerated, §Q)
- `src/main.ts` — **one line is this slice's** (the `finalizeOpenApiDocument`
  import/wiring predates this slice, from API-1A); the CORS block and
  `app.listen(port, '0.0.0.0')` are a **user-authored** change external to
  any Claude session, found already present at the start of this slice and
  preserved untouched except a mechanical `eslint --fix` (whitespace only,
  confirmed by re-reading the CORS logic unchanged after the fix).

**Untouched, confirmed by inspection, not merely by absence from `git
diff`**: `order-state.ts`, `orders.service.ts`, `order-lines.service.ts`,
`routing-resolver.service.ts`, `routing-resolver.errors.ts`,
`order-line-fired.handler.ts`, `ticket-persistence.service.ts`,
`unit-of-work.ts`, `unit-of-work-context.ts`, `idempotency.interceptor.ts`,
`idempotency.service.ts`, `sales-domain-exception.filter.ts`, `schema.prisma`.

---

## V. REQUIREMENT CLASSIFICATION

- **UC-POS-01 step 6**: **COMPLETE for explicit Fire** — every required
  backend consequence (authorization, state transition, event production,
  Kitchen persistence, audit, idempotency, concurrency) is proven end to
  end through the real HTTP route.
- **FR-POS-035**: **PARTIAL** — explicit Fire is implemented and proven;
  automatic/configurable Fire (branch/order-type-driven) is explicitly not
  implemented (§26 non-goal), and the ratified future rule (§B point 6) is
  recorded, not built.
- **FR-POS-038**: **backend COMPLETE for amendment production semantics**
  — proven (§18/§T). Frontend/KDS visual/audible amendment behaviour is
  **not** implied or claimed.
- **FR-KDS-010**: **backend COMPLETE for live five-tier routing** — all
  five tiers proven through the real Fire producer (§L), not merely the
  resolver in isolation (already proven by P1E-3).
- **FR-KDS-011**: **backend COMPLETE for multi-station routing** — proven
  live (§L).
- **FR-KDS-020**: **PARTIAL** — backend card data (including the dine-in
  service reference) exists and is proven; no KDS UI/display exists.
- **FR-KDS-021**: **PARTIAL** — modifier kind/snapshot semantics exist and
  the fail-closed unknown-kind rule is proven; visual distinction is not
  implemented and legacy unresolved-kind rows remain (unresolved by
  design, per P1E-5 — not backfilled here either).
- **FR-KDS-028**: **PARTIAL** — amendment persistence (existing Ticket
  reused, new FireBatch/TicketLine appended) is proven; visual/audible
  update is not implemented.
- **FR-KDS-040**: **PARTIAL** — created/routed timestamps exist and are
  proven (`Ticket.routedAt`/`TicketFireBatch.firedAt` from the Fire
  command's own instant, unchanged from P1E-5); viewed/started/ready/
  bumped/served workflow remains unfinished.
- **FR-POS-021**: **PARTIAL** — the fail-closed unknown-modifier-kind rule
  is now enforced at Fire (new, this slice); legacy unresolved rows remain
  unresolved (unchanged from P1E-5, by design).
- **FR-API-020/021/022/023**: unchanged classification — Fire is one more
  idempotent POST; the repository-wide PARTIAL status for FR-API-020 is
  **not** improved or claimed fixed by this slice (§27 non-goal).

**Not claimed, explicitly**: completed sale, §1.2 sale atomicity, Payment,
Inventory depletion, COGS posting, receipt, DayClose.

---

## W. P1E-6 EXIT

FIRE AUTHORIZATION COMPLETE: YES
EXPLICIT FIRE API COMPLETE: YES
SALES STATE TRANSITION COMPLETE: YES
FIRE EVENT PRODUCTION COMPLETE: YES
CATALOGUE PUBLIC FIRE FACTS COMPLETE: YES
SERVICE REFERENCE COMPLETE FOR DINE-IN: YES
TRANSACTIONAL KITCHEN CONSEQUENCE COMPLETE: YES
FIRE IDEMPOTENCY COMPLETE: YES (with a discovered, honestly-reported, pre-existing-mechanism interaction effect — §O — not a defect in Fire's own logic)
FIRE OPTIMISTIC CONCURRENCY COMPLETE: YES
AUDIT COMPLETE: YES
OPENAPI UPDATED: YES
P1E-6 OVERALL COMPLETE: YES

---

## X. REMAINING MVP BLOCKERS

Real blockers remaining on the protected MVP path (PIN → Shift/CashSession
→ Order → Add items → Price/Tax/Cost → Fire → Kitchen Ticket → **[you are
here]** → Cash/manual external Visa → Complete → Stock depletion → COGS →
cash/tender totals → Receipt → Close session/day → basic report):

1. **Cash / manual external Visa capture** — no Payment/PaymentAttempt
   exists at all. Nothing downstream of Fire can proceed without this.
2. **Complete** — gated on Payment; no completion endpoint exists.
3. **Stock depletion on completed sale** — gated on Complete.
4. **COGS posting on completion** — gated on Complete; recipe costing
   itself already exists (Production Spec), just not wired to a
   completion event that doesn't exist yet.
5. **Cash/tender totals, Receipt, Close session/day, basic report** — all
   gated on Payment + Complete existing first.

Everything BEFORE Fire on this path (PIN, Shift/CashSession opening, Order,
Add items, Price/Tax/Cost, and now Fire/Kitchen Ticket) is implemented and
proven. The next hard dependency is unambiguous: **Payment**.

---

## Y. NEXT

**PAYMENT MVP — CASH + MANUAL EXTERNAL CARD CAPTURE.**

Dependency check performed before naming this: Payment needs an OPEN order
with fired (or at least capturable) lines to attach a payment to — Fire now
provides that. Payment does NOT need Completion to exist first (Completion
consumes a successful Payment, not the reverse). No other slice must
precede Payment MVP; this is the correct next candidate, not merely the
default one.

**Not implemented here.**

---

## Z. COMMIT READINESS

COMMIT READY: YES
COMMITTED: NO
