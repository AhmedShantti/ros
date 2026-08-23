# P1E-5 — Ticket / TicketLine Persistence + Transactional Kitchen Handler

**Date:** 2026-08-23
**Branch:** `feat/production-spec`
**HEAD at start and end (unchanged — no commit made):** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Slice:** P1E-5 — IMPLEMENTATION (no Fire HTTP, no bump/recall routes, no Payment, no Completion, no Outbox)
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of work performed in this session.
The SRS and ratified governance decisions remain authoritative. No `D-21` or
later decision is created; no governance document is edited.

---

## A. STARTING STATE

- Branch `feat/production-spec`, HEAD `e5648fb`, unchanged throughout.
- Read first: `docs/reports/claude/2026-08-22_P1E4_ticket-ticketline-design-closure.md`,
  `docs/reports/claude/2026-08-21_P1E3_kds-routing-persistence-and-resolver.md`,
  `docs/reports/claude/2026-08-22_P1E3A_routing-contract-implementation-boundary.md`.
- Confirmed absent before this slice: `model Ticket` in `schema.prisma`
  (0 matches), `kitchen.tickets`/`kitchen.ticket_lines` tables, any
  `@DomainEventHandler` in `src/modules/`, `KitchenModule` in `app.module.ts`.
- 23 migrations, 702-test-equivalent unit baseline carried from P1E-3A.

---

## B. P1E-4 ACCEPTANCE CORRECTIONS

Four corrections superseded specific P1E-4 engineering choices; all four are
implemented exactly as specified:

- **A — no semantic backfill of `Modifier.kind`.** Implemented as a
  transitional nullable column with zero backfill (§C).
- **New — Sales modifier snapshot identity.** `orderLineModifierId` (not
  `modifierId` alone) is the idempotency key for `kitchen.ticket_line_modifiers`
  (§I, §D). `sortOrder` was NOT added — `sales.order_line_modifiers` captures
  no ordering value; `orderLineModifierId` is the deterministic,
  business-meaning-free tiebreaker instead (§E).
- **B — fire batches have no `sequence_no`.** `kitchen.ticket_fire_batches`
  carries `id`, `tenant_id`, `ticket_id`, `fire_batch_id`, `fired_at`,
  `created_at` only; ordering is `ORDER BY fired_at, id` (§H).
- **C — `order_type_snapshot` is Kitchen-owned.** `kitchen.tickets.order_type_snapshot`
  is `VARCHAR(32)`, not `sales."OrderType"` (§F).
- **D — cancelled-visibility has no invented default.** `branch_kds_config.cancelled_line_visibility_seconds`
  is nullable with no `@default`; `recall_window_seconds DEFAULT 1800` was
  kept because FR-KDS-025 states that default explicitly (§F).

---

## C. MODIFIER KIND MIGRATION

### Safe migration strategy — investigation before any schema change

Inspected every existing `catalogue.modifiers` row across the environments
available (local dev DB `ros` — the only environment carrying pre-P1E-5
data; the scratch DB starts empty). **All 18 existing rows are literally
named "Chicken instead of Beef"**, each with a distinct `id`/`modifier_group_id`,
`price_delta = -300`, `recipe_delta = NULL`. Traced to their source: every
one is fixture residue from repeated runs of
`test/catalogue.e2e-spec.ts`'s modifier-creation test
(`POST /catalogue/modifier-groups/:id/modifiers`), not seed data.

Checked every candidate signal the prompt names as an unacceptable
inference, and confirmed each is genuinely unusable, not merely
inconvenient:

- **Price sign** — FR-POS-021's own table states a removal may be "0 or −
  delta" and a substitution "± delta"; the sign does not discriminate.
- **Name text** ("Chicken instead of Beef") — a human-language heuristic
  across two locales (`name` is `{"ar": ..., "en": ...}`), explicitly
  forbidden even where it looks obvious.
- **Modifier group name** — a merchandising grouping, not a semantic; the
  same group can hold multiple kinds.
- **`recipe_delta`** — `NULL` on every one of the 18 rows, and the column's
  own repository comment states nothing in this phase interprets it.

**No non-heuristic source of truth exists for any of the 18 rows.**
Full list (`id`, name):

```
01a009e2-dcfe-ccda-ed05-5d024c07b73f  Chicken instead of Beef
01a009e4-71ef-9123-65af-0ff3a34e66bd  Chicken instead of Beef
01a009e9-9a1c-b6c2-54e5-839a8e71b17a  Chicken instead of Beef
01a009e9-cffe-5080-290d-1d4b420e8eeb  Chicken instead of Beef
01a00a39-ec80-5d42-2eec-8b7074d35100  Chicken instead of Beef
01a00a5d-68f8-bd43-b095-c586aee2d429  Chicken instead of Beef
01a00a60-efe6-eb7e-822d-690cad117060  Chicken instead of Beef
01a00a68-109e-ae9c-158f-28934b448fc1  Chicken instead of Beef
01a00ac4-7770-e96c-5f73-a87aa6e98aca  Chicken instead of Beef
01a00ac5-328b-36c4-cb91-e8ebb2bb29db  Chicken instead of Beef
01a00adb-79e0-0d6e-1ec3-182ad0cc4590  Chicken instead of Beef
01a00cca-ee68-fa0d-8503-bfee4ea4371f  Chicken instead of Beef
01a019df-62a4-2c6a-8472-92817e466759  Chicken instead of Beef
01a019df-bbdf-be82-2039-c3ffb74b3448  Chicken instead of Beef
01a019e4-1659-43d6-4b5e-de3d74a15464  Chicken instead of Beef
01a01a47-c16d-2a51-daee-60af75b6598a  Chicken instead of Beef
01a01a4a-df5e-2b68-a32c-8c85ab073e67  Chicken instead of Beef
01a01a4c-f6d6-8643-36bb-85c5f10acb60  Chicken instead of Beef
```

**Decision: the transitional shape (nullable, no backfill), not NOT NULL.**
Migration `20260823010000_catalogue_modifier_kind`:

```sql
CREATE TYPE "catalogue"."ModifierKind" AS ENUM ('addition', 'removal', 'substitution');
ALTER TABLE "catalogue"."modifiers" ADD COLUMN "kind" "catalogue"."ModifierKind";
```

No `UPDATE`, no `DEFAULT`. All 18 rows keep `kind IS NULL` — an honest
"unknown", never a fabricated `'addition'`.

### Enforcement of "new writes require kind"

- `CreateModifierDto.kind` (`catalogue.dto.ts`) — `@IsEnum(ModifierKind)`,
  **no** `@IsOptional()`. A `POST` with no `kind` is rejected 400 before the
  service runs.
- `CreateModifierInput.kind` (`modifier-groups.service.ts`) — required
  (non-optional) TypeScript field; `addModifier` passes it straight through
  to `tx.modifier.create()`.
- `toModifierView` echoes `kind` (possibly `null` for a legacy row) — never
  fabricated on read either.

### FR-POS-021 classification

**PARTIAL**, not COMPLETE — 18 pre-existing rows remain genuinely
unclassified. Reported here explicitly, not narrowed away (§S).

---

## D. SALES MODIFIER SNAPSHOT

`sales.order_line_modifiers.kind_snapshot` (migration
`20260823020000_sales_order_line_modifier_kind_snapshot`) — nullable
`catalogue."ModifierKind"`, for the identical reason the source column is
nullable. `OrderLinesService`'s modifier-capture loop
(`order-lines.service.ts`) now copies `modifier.kind` verbatim into
`kindSnapshot` — never re-derived, never defaulted; the two `select` clauses
that fetch candidate modifiers were extended to include `kind` (they were
previously omitting it, which would have made the field always `undefined`
regardless of the column).

**No new Sales/Identity index was required.** `order_line_modifiers_tenant_id_id_key`
— `UNIQUE (tenant_id, id)` — already existed (added when the table was first
created), and is exactly the D-09 composite target
`kitchen.ticket_line_modifiers.source_order_line_modifier_id` needs.
Verified directly (`\d sales.order_line_modifiers`) before writing any
migration, per the prompt's conditional instruction.

---

## E. `order.line.fired` V1 CONTRACT

`src/modules/sales/contract/events.ts` rewritten to the full payload (no
prior producer exists, so this replaces v1 rather than versioning past it).
Five groups, matching §10 exactly: SOURCE (`orderId`, `businessDay`,
`orderLineId`), FIRE (`fireBatchId`, `firedAt`), ROUTING (`menuItemId`,
`modifierIds`, `categoryIds`, `lineStationOverrides`), TICKET HEADER
(`orderNumber`, `orderType`, `serviceReference` — repeated on every line
event, deliberately, so no event's correctness depends on arrival order),
LINE (`itemNameSnapshot`, `quantity` as a decimal string, `course`,
`sequence`, `preparationNotes`), MODIFIERS (`orderLineModifierId`,
`modifierId`, `nameSnapshot`, `kind`, `quantity` — no `sortOrder`, per §5's
explicit instruction, since no source ordering value exists).

`OrderLineFiredModifierKind` has no `| null` member — the payload type
itself cannot represent an unknown kind. A future Fire producer must fail
closed (refuse to fire) rather than construct a payload with a `null` kind;
that check is not built in this slice (Fire is not implemented), only the
contract that makes it necessary.

`events.spec.ts` rewritten around a `validPayload()`/`build()` helper
covering the full v1 shape: routing selectors, ticket header, modifier
snapshots keyed by `orderLineModifierId`, decimal-string quantity,
`firedAt` ISO-8601 format, envelope freezing. `module-boundaries.spec.ts`'s
pre-existing "Sales publishes order.line.fired" assertion (checks the
literal event name and no `any`) still passes unmodified.

---

## F. TICKET MIGRATION

`kitchen.tickets` (migration `20260823030000_kitchen_ticket_persistence`,
part 2) — the P1E-4 §J shape exactly, with acceptance correction C applied:
`order_type_snapshot VARCHAR(32)` (not `sales."OrderType"`).

Columns, keys, FKs, indexes, RLS all as P1E-4 specified and verified
structurally against the scratch DB (`\d kitchen.tickets`):

- `PRIMARY KEY (id)`; `UNIQUE (tenant_id, id)`;
  `UNIQUE (tenant_id, order_id, business_day, station_id)` (cardinality
  invariant); `UNIQUE (tenant_id, id, order_id, business_day)` (additive FK
  target for `ticket_lines`).
- `tickets_order_fkey (tenant_id, order_id, business_day, branch_id) →
  sales.orders(tenant_id, id, business_day, branch_id)` — targets P1E-3's
  `uq_orders_tenant_id_business_day_branch`, **no new Sales index required**.
- `tickets_branch_id_station_id_fkey (branch_id, station_id) → org.stations(branch_id, id)`.
- `tickets_tenant_id_started_by_fkey` / `..._bumped_by_fkey` → `identity.employees(tenant_id, id)`
  — real DB FKs with **no Prisma relation object**, matching the established
  `sales.orders.opened_by/served_by/closed_by` convention exactly (verified
  that convention first: those columns have DB FKs but no `@relation` in
  `schema.prisma`).
- Three resolver-shaped indexes (station queue FIFO, order→tickets,
  target-time sort).
- Direct-anchor RLS, `ENABLE` + `FORCE`, 4 policies, `ros_app` grants.

`branch_kds_config` additive fields (migration part 0, before the enums):
`recall_window_seconds INTEGER NOT NULL DEFAULT 1800`,
`cancelled_line_visibility_seconds INTEGER` (nullable, no default).

---

## G. TICKETLINE MIGRATION

`kitchen.ticket_lines` — no `station_id`, no `branch_id` (both are the
owning Ticket's, per P1E-4 §K). Composite FKs proven structurally:

- `ticket_lines_ticket_fkey (tenant_id, ticket_id, order_id, business_day) →
  kitchen.tickets(tenant_id, id, order_id, business_day)` — forces this
  line's `order_id` to equal its OWN ticket's `order_id`.
- `ticket_lines_order_line_fkey (tenant_id, order_id, order_line_id,
  business_day) → sales.order_lines(tenant_id, order_id, id, business_day)`
  — targets P1E-3's `uq_order_lines_tenant_order_id_business_day`, **no new
  Sales index required**; forces the OrderLine to belong to the SAME order
  named above.
- Together: "TicketLine pairs Order X's Ticket with Order Y's OrderLine" is
  unrepresentable — proven directly in `kitchen-ticket-persistence.e2e-spec.ts`
  ("TicketLine cannot pair Order X's Ticket with Order Y's OrderLine") by
  attempting exactly that insert and observing rejection.
- `ticket_lines_fire_batch_fkey (tenant_id, ticket_id, fire_batch_row_id) →
  kitchen.ticket_fire_batches(tenant_id, ticket_id, id)` — the batch must
  belong to THIS line's own ticket.
- `UNIQUE (tenant_id, ticket_id, order_line_id)` — idempotency + "one line
  per ticket"; the SAME OrderLine may appear on a DIFFERENT ticket
  (different `ticket_id`), proven by the FR-KDS-011 multi-station test.

---

## H. FIRE-BATCH MIGRATION

`kitchen.ticket_fire_batches` — acceptance correction B applied exactly:
**no `sequence_no` column, no allocator.**

```sql
PRIMARY KEY (id)
UNIQUE (tenant_id, id)
UNIQUE (tenant_id, ticket_id, fire_batch_id)   -- idempotency
UNIQUE (tenant_id, ticket_id, id)              -- FK target for ticket_lines
```

`fire_batch_id` is Sales-minted (one per Fire command, carried in the event
payload — no producer exists yet, so tests mint it directly). Display
ordering is `ORDER BY fired_at, id`; no persisted amendment number. Proven:
two distinct `fireBatchId`s against the same ticket produce two batch rows
(amendment); the same `fireBatchId` replayed produces one (idempotency).

---

## I. TICKET-LINE-MODIFIER MIGRATION

`kitchen.ticket_line_modifiers` — the acceptance-correction shape from §5,
not P1E-4's original design:

```sql
source_order_line_modifier_id UUID NOT NULL   -- the idempotency key
source_modifier_id            UUID NOT NULL   -- traceability only
...
UNIQUE (tenant_id, ticket_line_id, source_order_line_modifier_id)
FK (tenant_id, source_modifier_id)            → catalogue.modifiers(tenant_id, id)   RESTRICT
FK (tenant_id, source_order_line_modifier_id) → sales.order_line_modifiers(tenant_id, id) RESTRICT
```

`kind` is `kitchen."ModifierKindSnapshot"` — a **Kitchen-owned** enum with
the identical three values as `catalogue."ModifierKind"`, deliberately not
reusing the Catalogue type (§16: no hard Kitchen→Catalogue database-type
dependency across the event boundary — the same principle applied to
`order_type_snapshot`, §F).

Proven: a duplicate `(ticket_line, source_order_line_modifier_id)` is a
no-op (replay-idempotent); two DISTINCT `sales.order_line_modifiers` rows
selecting the SAME `catalogue.modifiers` row (legal under FR-MNU-011's
allow-repeat) both remain representable — two snapshot rows, correctly
distinguished by `source_order_line_modifier_id`.

---

## J. KITCHEN HANDLER

`src/modules/kitchen/tickets/order-line-fired.handler.ts` —
`@Injectable() @DomainEventHandler(ORDER_LINE_FIRED_EVENT_TYPE) class
OrderLineFiredHandler`, registered as an ordinary provider in
`KitchenModule` — never exported, never imported by anything else (proven
mechanically, §L).

Flow, exactly as designed: parses `businessDay`/`firedAt`, calls
`RoutingResolverService.resolve(ctx.tx, {...})` (the SAME `RoutingResolutionInput`
shape P1E-3 built — routing semantics untouched), then for each resolved
`stationId`: `getOrCreateTicket` → `getOrCreateFireBatch` → `getOrCreateTicketLine`
→ `ensureTicketLineModifier` (per modifier). All four persistence operations
live in `ticket-persistence.service.ts` (private), never called from
anywhere but this handler.

**Idempotency mechanism** (`ticket-persistence.service.ts`'s own docblock
states the reasoning): check-then-insert is safe here because (1) within
one Fire transaction, `TransactionalDomainEventDispatcher.drain()` processes
every line event of a batch strictly sequentially — verified by reading
the dispatcher source, not assumed — so there is no intra-transaction race;
(2) across transactions, the UNIQUE index is the actual authority — a losing
`create()` throws P2002, caught once to re-fetch the winner's row.

**Immutable-header enforcement**: `getOrCreateTicket` compares
`orderNumberSnapshot`/`orderTypeSnapshot`/`serviceReferenceSnapshot` against
an existing Ticket; a mismatch throws `TicketHeaderMismatchError` (private,
`ticket-persistence.errors.ts`) rather than silently overwriting — proven by
a dedicated test that fires a first line with `orderNumber: 'A-0001'` and a
second (same ticket) with `orderNumber: 'DIFFERENT-NUMBER'`, asserting
rejection and that the mismatched line never persisted.

**Routing failures propagate unmodified.** `RoutingNoDestinationError` /
`RoutingConfigurationConflictError` are not caught anywhere in the handler;
they roll back the whole transaction, including a test-owned write made
earlier in the same `UnitOfWork.execute` callback — proven directly (§O).

---

## K. SELF-CONTAINED TICKET READER

`src/modules/kitchen/tickets/ticket-reader.service.ts` — `TicketReaderService.getCard(tx, ticketId)`
returns a plain `TicketCardDto`. The `select` clause
(`TICKET_CARD_SELECT`) names only Kitchen's own columns and Kitchen's own
child relations (`lines`, `lines.modifiers`) — never `order`, `station`,
`orderLine`, `sourceModifier`, or `sourceOrderLineModifier`, every one of
which is a REAL relation on these models (kept for FK integrity) but would
cross into `sales.*`/`catalogue.*` if selected.

**Functional proof, not merely structural**: one test `REVOKE`s `ros_app`'s
`SELECT` grant on the entire `sales` and `catalogue` schemas, then calls
`getCard`, and asserts it still succeeds (in a `try/finally` that restores
the grants unconditionally). If the reader touched either schema, this
would fail with a Postgres permission-denied error instead of returning the
card — it does not.

No HTTP endpoint, no controller — a plain injectable, exported from
`KitchenModule` for a future consumer, per §21.

---

## L. MODULE BOUNDARIES

`KitchenModule` now imports/provides `OrderLineFiredHandler`,
`TicketPersistenceService`, `TicketReaderService` alongside the
pre-existing `RoutingResolverService`; registered in `app.module.ts`
(previously deliberately absent per P1E-3/P1E-4 — the caller now exists).

Five new `module-boundaries.spec.ts` assertions (17 tests total in the
file, up from 13):

1. **Kitchen imports Sales only through `sales/contract`, and nothing from
   Catalogue at all** — checked both generically (`violations` array, zero
   `kitchen->sales`/`kitchen->catalogue` entries) and by import-statement-line
   inspection of the handler file (not a bare substring check — the file's
   own docblock legitimately discusses `sales.*`/`catalogue.*` in prose).
2. **`OrderLineFiredHandler` is private** — no file outside `kitchen/`
   imports it (checked by import-line, excluding the architecture-test file
   itself, which legitimately names the class in its own assertions).
3. **The foreign-Prisma-query detector fires on a fabricated Kitchen
   violation, and not on real Kitchen source** — a behavioural detector
   (`.order.findMany(`-shaped regex on the seven relevant model delegates),
   self-tested exactly like P1E-3A's `containsPersistenceImplementation`.
4. **Kitchen application code contains no direct Prisma query against Sales
   or Catalogue tables** — the detector run over every non-spec file under
   `kitchen/`.
5. (Pre-existing, re-verified green) zero new `KNOWN_DEVIATIONS`; the
   full-tree deviation snapshot test unchanged.

**17/17 pass.** `trusted-construction-boundary.spec.ts` (P1E-1C's event
publication boundary) — unmodified, re-run as part of the full unit suite
(§O), still green.

---

## M. RLS / FK EVIDENCE

All four new tables: direct `tenant_id` anchor, `ENABLE` + `FORCE` row
level security, 4 policies each, `ros_app` grants — verified two ways: (a)
introspection query against `pg_class.relrowsecurity`/`relforcerowsecurity`
for all four tables in one assertion; (b) `pg_roles.rolbypassrls`/`rolsuper`
for `ros_app`, both `false`.

Cross-tenant unrepresentability, proven functionally (not merely asserted
as a design claim):

| Illegal state | Test |
|---|---|
| Missing tenant context | zero rows on all four tables under `withAuthContext({})` |
| Tenant A reads tenant B's Tickets/TicketLines | zero rows under tenant B's context, cross-tenant `orderId` |
| TicketLine pairs Order X's Ticket + Order Y's Line | direct insert attempt rejected |
| Modifier snapshot references cross-tenant Modifier/OrderLineModifier | FK existence confirmed (`pg_constraint`) |

FR-PLT-013/014's generated cross-tenant suite and CI RLS check will
automatically enumerate all four new tables (they all carry `tenant_id`) —
no hand-registration needed, consistent with every prior Kitchen/Sales
migration in this repository.

---

## N. IDEMPOTENCY / AMENDMENT EVIDENCE

All nine §27 scenarios proven functionally in
`test/kitchen-ticket-persistence.e2e-spec.ts`:

- One fired line → one station (tier 3) → exactly one Ticket + one batch +
  one TicketLine.
- Multi-station resolution (tier 2, two rules on the same modifier) →
  exactly two Tickets, one TicketLine each.
- A later `fireBatchId` on an already-ticketed station reuses the SAME
  Ticket (`id` unchanged), adds only the new line, and the original line's
  full row (including every timestamp) is **byte-for-byte unchanged**
  (`toEqual`) — not merely "still present".
- A header mismatch on a later event fails closed; the mismatched write
  never commits.
- `ROUTING_NO_DESTINATION` rolls back the whole transaction, **including a
  test-owned write made earlier in the same `UnitOfWork.execute` callback**
  — the marker row is confirmed absent afterward.
- `ROUTING_CONFIGURATION_CONFLICT` (two categories routing to different
  stations) likewise rolls back everything.
- Exactly one `$transaction` call for the whole Fire+handler flow (spy on
  `PrismaService.$transaction`).
- The handler is discovered through the REAL `DomainEventHandlerRegistry`
  (`app.get`), not a test-only wiring.
- Duplicate events (same `fireBatchId`/`orderLineId`/`orderLineModifierId`)
  produce zero duplicate rows at every level — Ticket, batch, line, and
  modifier snapshot — each proven by a dedicated test.

---

## O. TESTS

- `sales/contract/events.spec.ts` — rewritten around the full v1 payload,
  10 tests, all passing.
- `module-boundaries.spec.ts` — 17 tests (5 new), all passing.
- `test/kitchen-ticket-persistence.e2e-spec.ts` — **new, 31 tests**, all
  passing, covering §25 (schema/tenancy, 12 tests), §26 (modifier kind, 5
  tests), §27 (handler, 8 tests), §28 (self-contained read, 4 tests, plus
  the RLS/FK tests double as several of §25's numbered items). No test
  skipped or marked `todo`.
- `test/catalogue.e2e-spec.ts` — one pre-existing test updated (`kind:
  'substitution'` now required and asserted echoed back) — the exact test
  that had been silently accumulating the 18 legacy rows (§C).
- **Full unit suite**: 51 suites / **702 tests**, all passing.
- **Full e2e suite**: 28 suites / **605 tests**, all passing (re-run twice —
  once showed one pre-existing, unrelated `organisation.e2e-spec.ts`
  location-registry test fail due to this run's own raw-admin fixture
  inserts contaminating the scratch DB, identical to the pattern P1E-3's
  report already documented; resolved by dropping and recreating the
  scratch DB from zero, exactly as that report's precedent — not a code
  fix, an environment reset).

---

## P. DATABASE / MIGRATION VERIFICATION

- `npx prisma format` / `validate` — clean.
- `npx prisma generate` — Prisma Client 7.9.1, succeeded.
- Three new migrations: `20260823010000_catalogue_modifier_kind`,
  `20260823020000_sales_order_line_modifier_kind_snapshot`,
  `20260823030000_kitchen_ticket_persistence`. **Migration count: 26**
  (23 + 3) — matches the prompt's own expected conceptual sequence
  (Catalogue / Sales / Kitchen, one migration per affected module).
- Scratch DB (`ros_p1e3_scratch`) dropped and recreated from zero; **all 26
  migrations applied cleanly** (`prisma migrate deploy`), twice (once before
  the final full-suite run, confirmed clean both times).
- One real bug caught and fixed by this verification step itself: the
  first draft of `OrderLineModifier.kindSnapshot` was missing
  `@map("kind_snapshot")`, which `prisma migrate diff` caught immediately
  (a proposed `DROP COLUMN "kind_snapshot", ADD COLUMN "kindSnapshot"`) —
  fixed before any test ran against it.
- `prisma migrate diff --from-config-datasource` against the fully-migrated
  scratch DB: the only remaining output is `RENAME` statements for
  pre-existing constraints/indexes whose names differ from Prisma's
  inferred defaults (including this slice's own `started_by`/`bumped_by`
  FKs, which have no Prisma `@relation` — matching the established
  `orders.opened_by` pattern exactly) — the identical, already-documented
  diff-tool artifact P1E-3's report found and declined to trust. **Not
  applied**; every new table/column/FK/index was instead verified directly
  via `\d`, `pg_constraint`, `pg_index`, `pg_class` introspection.
- Local dev DB (`ros`) confirmed **completely untouched**:
  `prisma migrate status` shows the same 8 pre-existing unapplied
  migrations plus this slice's 3 new ones — **11 unapplied, 0 applied by
  this run**; sentinels unchanged (`catalogue.price_lists=78`,
  `catalogue.modifiers=18`, `kitchen.station_routing_rules=0`); `kitchen`
  schema in `ros` still contains only `station_routing_rules` (no
  `tickets`) — proof the new migration genuinely never ran there.

---

## Q. FIRE PRODUCER PREREQUISITES

**CATALOGUE FACTS REQUIRED BY FUTURE FIRE:**

1. **`categoryIds`** — the menu item's assigned category ids (FR-KDS-010
   tier 4 selector). No public Catalogue contract exists to obtain this
   today; Sales already has an accepted `sales->catalogue` edge
   (`KNOWN_DEVIATIONS['sales->catalogue']`,
   `pricing/price-resolution.service`) it uses for price resolution, which
   is the same kind of read Fire would need. **Not solved here** — a future
   Fire producer either extends that existing accepted edge (reads
   `catalogue.menu_item_placements`/`categories` directly, as price
   resolution already does) or a dedicated Catalogue public query is added.
   This report does not silently bless the existing deviation as the
   permanent design; it records that the identical shape of edge already
   exists and is the natural place to look first.
2. **KDS-surface item name (`kitchen_names`)** — `catalogue.menu_items.kitchen_names`
   exists but `sales.order_lines.item_name_snapshot` captures only the
   customer-facing `names` (verified directly in `order-lines.service.ts`:
   `itemNameSnapshot: { item: menuItem.names, variant: variant.name }`). A
   future Fire producer reads `menu_items.kitchen_names` at fire time (the
   same `sales->catalogue` read Sales already performs for pricing) and
   includes it in `OrderLineFiredPayload.itemNameSnapshot`. **Not solved
   here** — P1E-4 §F already recorded this as NOT SOURCE-DECIDABLE (sale-time
   vs. fire-time capture); this slice changes nothing about that.

> **FIRE PREREQUISITE: CATALOGUE PUBLIC FIRE-FACTS QUERY REQUIRED** — for
> `categoryIds` specifically, IF the existing `sales->catalogue`
> `KNOWN_DEVIATIONS` edge is judged insufficient (it is a private-path
> deviation, not a published contract) when the Fire slice is scoped. This
> report does not decide that question; it names it so the Fire slice
> inherits it explicitly rather than rediscovering it.

**SERVICE REFERENCE SOURCE:**

`sales.orders` already carries `table_id` (a live FK to `org.tables`) and no
customer-reference column at all (Customer/CRM is not implemented in this
repository). **A future Fire producer for a dine-in order has an existing
source** — resolve the table's display label via the same Organisation
public surface Branches/Stations already use (`org.tables`, currently read
only by Sales' own private queries — no dedicated public "table label"
contract query exists either). **For a non-dine-in order (delivery,
takeaway, pickup), no source exists at all** — `serviceReference` would be
`null` for every such order until a Customer/CRM slice adds one. **Not
solved here**; recorded as the exact gap rather than fabricated with a
placeholder value. Kitchen's own schema already treats
`service_reference_snapshot` as nullable specifically because of this gap
(P1E-4 §F, carried forward unchanged).

Neither gap was closed by adding a new private-table import from Sales —
`sales.module.ts`/`orders.controller.ts` are unmodified by this slice
beyond the `kindSnapshot` capture (§D). Both gaps are reported, not
silently solved.

---

## R. FILES CHANGED

**New migrations:** `20260823010000_catalogue_modifier_kind`,
`20260823020000_sales_order_line_modifier_kind_snapshot`,
`20260823030000_kitchen_ticket_persistence`.

**Schema:** `prisma/schema.prisma` — `catalogue.ModifierKind` enum,
`Modifier.kind`, `OrderLineModifier.kindSnapshot`; `kitchen.TicketStatus`/
`TicketLineStatus`/`ModifierKindSnapshot` enums; `Ticket`, `TicketFireBatch`,
`TicketLine`, `TicketLineModifier` models; `BranchKdsConfig`'s two additive
fields; back-relations on `Tenant`, `Order`, `OrderLine`, `Station`,
`Modifier`, `OrderLineModifier` (Prisma-required, no DDL impact).

**New application code:**
`src/modules/kitchen/tickets/ticket-persistence.errors.ts`,
`src/modules/kitchen/tickets/ticket-persistence.service.ts`,
`src/modules/kitchen/tickets/order-line-fired.handler.ts`,
`src/modules/kitchen/tickets/ticket-reader.types.ts`,
`src/modules/kitchen/tickets/ticket-reader.service.ts`.

**Modified application code:**
`src/app.module.ts` (registers `KitchenModule`),
`src/modules/kitchen/kitchen.module.ts` (new providers),
`src/modules/sales/contract/events.ts` (final v1 payload),
`src/modules/catalogue/catalogue.dto.ts` (`CreateModifierDto.kind`,
required),
`src/modules/catalogue/catalogue.views.ts` (`toModifierView` echoes
`kind`),
`src/modules/catalogue/modifier-groups/modifier-groups.service.ts`
(`CreateModifierInput.kind`, required; passed to `create`),
`src/modules/sales/orders/order-lines.service.ts` (selects and snapshots
`kind`),
`src/modules/module-boundaries.spec.ts` (5 new P1E-5 assertions).

**Modified tests:** `src/modules/sales/contract/events.spec.ts` (rewritten
for the v1 payload), `test/catalogue.e2e-spec.ts` (one test updated for
required `kind`).

**New test:** `test/kitchen-ticket-persistence.e2e-spec.ts` (31 tests).

No file outside this list was modified. No governance document, ADR, or
decision register was touched. No permission was added or broadened.

---

## S. REQUIREMENT CLASSIFICATION

Exactly the classifications the prompt specified, not narrowed:

- **FR-POS-021: PARTIAL.** New writes require `kind`; 18 pre-existing rows
  remain unclassified (§C) — not COMPLETE while any supported data is
  unclassified.
- **FR-KDS-010: PARTIAL.** Resolver + handler exist and are fully tested;
  no Sales Fire producer exists yet.
- **FR-KDS-011: PARTIAL.** Persistence + handler support multi-station
  (proven, §N); no live POS Fire workflow exists.
- **FR-KDS-020: PARTIAL.** Self-contained persistence/read model exists and
  is proven to touch no Sales/Catalogue table; no KDS UI.
- **FR-KDS-021: PARTIAL.** Snapshot semantics (relational `kind` on
  `ticket_line_modifiers`) exist and are enforceable; no UI; additionally
  blocked on the same 18 unclassified legacy Catalogue rows as FR-POS-021.
- **FR-KDS-024: NOT IMPLEMENTED.** No bump behaviour — non-goal, untouched.
- **FR-KDS-025: PARTIAL** at persistence/config substrate only
  (`recall_window_seconds`, `recalled_at`, `recall_count` columns exist);
  no recall behaviour.
- **FR-KDS-028: PARTIAL.** Amendment persistence semantics (fire-batch
  reuse, byte-for-byte-unchanged original lines) exist and are proven; no
  Fire producer, no UI alert.
- **FR-KDS-029: PARTIAL** at persistence substrate only (`cancelled_at`
  column, `RESTRICT` FK preventing deletion); no `order.line.voided`
  subscriber, no display.
- **FR-KDS-040: PARTIAL.** All seven timestamp columns exist on both Ticket
  and TicketLine, correctly populated by the handler for `created`/`routed`;
  the remaining five (`first_viewed`/`started`/`ready`/`bumped`/`served`)
  require future KDS actions this slice does not implement.

None of these was upgraded merely because a column or a passing test
exists, per explicit instruction.

---

## T. P1E-5 EXIT

- **P1E-5 MODIFIER SEMANTICS SUBSTRATE COMPLETE: YES** — the substrate
  (enum, nullable columns, required-on-new-write enforcement, safe
  transitional migration with zero fabricated backfill) is complete. (The
  underlying FR-POS-021 *requirement* stays PARTIAL, §S — the substrate and
  the requirement are different claims.)
- **P1E-5 TICKET PERSISTENCE COMPLETE: YES**
- **P1E-5 TICKETLINE PERSISTENCE COMPLETE: YES**
- **P1E-5 AMENDMENT IDEMPOTENCY COMPLETE: YES**
- **P1E-5 EVENT CONTRACT COMPLETE: YES**
- **P1E-5 KITCHEN HANDLER COMPLETE: YES**
- **P1E-5 SELF-CONTAINED READ MODEL COMPLETE: YES**
- **P1E-5 TENANCY/RLS COMPLETE: YES**
- **P1E-5 OVERALL COMPLETE: YES**

All 28 Definition-of-Done items (§34) are satisfied: no fabricated
semantic backfill; new Modifiers/OrderLineModifiers require/snapshot
`kind`; Ticket/TicketLine/fire-batch/modifier persistence all exist and are
proven idempotent and replay-safe; Ticket snapshots are self-contained
(functionally proven by revoking cross-schema grants); `order_type_snapshot`
is Kitchen-owned; the recall default is source-correct (1800) and the
cancelled-visibility default is NOT invented; the v1 event contract carries
complete handler data; the handler is private, transactional, uses the
accepted resolver, and is live in `AppModule`; duplicate events never
duplicate any Kitchen row at any level; multi-station and amendment both
work; Kitchen never reads Sales/Catalogue directly (mechanically proven);
all four new tables use `ENABLE`+`FORCE` RLS; 26 migrations apply from
zero; the full suite (702 unit + 605 e2e) passes; the local dev DB is
untouched; no Fire HTTP/permission, no Payment/Completion/Outbox, no
governance edit, no commit.

---

## U. NEXT

### **FIRE AUTHORIZATION DECISION + SALES FIRE COMMAND IMPLEMENTATION**

Exactly the slice the prompt anticipated, and this run's own evidence
confirms it: every layer built across P1E-1 through P1E-5 — the
domain-event/UoW foundation, the routing resolver, the Organisation
contract, and now a fully-tested, idempotent, transactional Ticket
persistence handler — has no caller. `grep -rn "pos.order.fire"` still
returns nothing. §Q's two Fire-producer prerequisites (Catalogue
`categoryIds`/`kitchen_names` facts; the `serviceReference` source gap for
non-dine-in orders) are now the concrete, narrowed blockers the Fire slice
must resolve or explicitly defer — not open-ended unknowns.

**This slice does not implement it.** No Fire route, no `pos.order.fire`
permission, no Sales Fire command service.

---

## V. COMMIT READINESS

**COMMIT READY: YES.** The change is self-contained, passes every
verification this report ran (tsc, eslint, full unit + e2e suites,
26-migrations-from-zero, local-dev-DB-untouched check), and the one real
bug this session found (`kindSnapshot`'s missing `@map`) was caught and
fixed by the verification process itself before any test depended on it.

**COMMITTED: NO.** No commit was created in this session, per explicit
instruction. This report drafts no commit message and stages no files.
