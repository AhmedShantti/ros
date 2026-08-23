# P1E-5A — PostgreSQL Conflict-Safe Kitchen Idempotency Correction

**Date:** 2026-08-23
**Branch:** `feat/production-spec`
**HEAD at start and end (unchanged — no commit made):** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Slice:** P1E-5A — NARROW CORRECTION ONLY (no schema redesign, no new migration, no Fire, no Payment, no commit)
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of a correction performed in this
session. P1E-5's schema, migrations, routing semantics, event contract, RLS,
Ticket/TicketLine cardinality, modifier-kind strategy, and module boundaries
are accepted and are **not** reopened here — only the one concurrency
correctness defect named by this slice's instructions is addressed.

**Session note:** this run was interrupted once by a transient network
failure (`ENOTFOUND`) partway through the final full e2e regression pass.
The interruption occurred strictly after the code correction and the new
concurrency tests had already been written and had already passed once;
nothing was redone that did not need to be. Verified on resumption: `git
status` showed the exact same uncommitted change set as before the
interruption (the rewritten `ticket-persistence.service.ts` and the new
`kitchen-ticket-concurrency.e2e-spec.ts`, both intact, no partial/corrupted
state), and `HEAD` was unchanged.

---

## A. STARTING STATE

- Branch `feat/production-spec`, HEAD `e5648fb`, unchanged throughout.
- Read: `docs/reports/claude/2026-08-23_P1E5_ticket-persistence-and-kitchen-handler.md`.
- 26 migrations, 702 unit / 605 e2e tests passing at P1E-5's close.
- `TicketPersistenceService` (`src/modules/kitchen/tickets/ticket-persistence.service.ts`)
  was the exact file named for review: all four `getOrCreate*`/`ensure*`
  methods used a `try { create() } catch (P2002) { findUniqueOrThrow() }`
  pattern to handle a losing cross-transaction race.

---

## B. DEFECT VERIFICATION

Read the actual implementation before assuming anything. Confirmed the
acceptance-review concern is accurate, not overstated: all four methods
(`getOrCreateTicket`, `getOrCreateFireBatch`, `getOrCreateTicketLine`,
`ensureTicketLineModifier`) followed the identical shape:

```ts
try {
  return await tx.ticket.create({ data: {...} });
} catch (err) {
  if (!isUniqueViolation(err)) throw err;
  const raced = await tx.ticket.findUniqueOrThrow({ where });   // ← same tx
  ...
  return raced;
}
```

`isUniqueViolation` catches Prisma's `P2002` (the JS-level exception Prisma
raises for a unique-constraint violation) and the code then issues a
**further query on the same `Prisma.TransactionClient`**.

**Why this is broken, proven directly against real PostgreSQL** (§C) rather
than argued abstractly: once any statement inside a PostgreSQL transaction
raises a database-level error — a unique-violation included — the whole
transaction is marked **aborted**. Every subsequent statement on that same
transaction/connection fails with `25P02 current transaction is aborted,
commands ignored until end of transaction block`, until an explicit
`ROLLBACK` (or `ROLLBACK TO SAVEPOINT`). Prisma's interactive
`$transaction(async (tx) => {...})` callback does **not** wrap each
individual query in its own `SAVEPOINT` — every `await tx.model.X()` call
runs directly on the shared underlying transaction. Catching the JS
exception in application code does nothing to un-abort the SQL transaction
that produced it.

**Why P1E-5's own test suite did not catch this**: every "duplicate event"
test in `kitchen-ticket-persistence.e2e-spec.ts` replayed sequentially —
two separate calls to `fire()`, each opening its **own** `UnitOfWork.execute()`
call and therefore its own transaction. The second call's `findUnique`
pre-check always found the first call's already-**committed** row and
returned early via the `if (existing) return existing;` branch — the
`try { create() } catch { ... }` branch was never reached by any P1E-5 test.
The bug is real and was genuinely untested, exactly as the acceptance review
suspected.

---

## C. POSTGRES TRANSACTION BEHAVIOUR

Proven directly, not assumed, with two minimal transactions against the
scratch database:

```sql
-- (1) WITH a savepoint before the conflicting insert:
BEGIN;
CREATE TEMP TABLE t (id int PRIMARY KEY);
INSERT INTO t VALUES (1);
SAVEPOINT sp1;
INSERT INTO t VALUES (1);        -- ERROR: duplicate key
ROLLBACK TO sp1;
SELECT 'still usable after ROLLBACK TO SAVEPOINT' AS proof;
                                  -- ✅ returns the row — transaction recovered
ROLLBACK;

-- (2) WITHOUT a savepoint — exactly Prisma's interactive-transaction shape:
BEGIN;
CREATE TEMP TABLE t2 (id int PRIMARY KEY);
INSERT INTO t2 VALUES (1);
INSERT INTO t2 VALUES (1);       -- ERROR: duplicate key
SELECT 'unreachable if transaction is aborted' AS proof;
                                  -- ❌ ERROR: current transaction is aborted,
                                  --    commands ignored until end of transaction block
ROLLBACK;
```

Case (2) is exactly what `try { create() } catch { findUniqueOrThrow() }`
does inside a Prisma interactive transaction: the `catch` block's query is
the "unreachable" `SELECT` above. **This is the mechanical proof of the
defect**, not an inference from Postgres documentation.

**Resolution — no savepoint machinery added.** Rather than wrapping every
create in a manual `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` (a retry-framework
shape the prompt explicitly disallows, §9), each method now uses `INSERT
... ON CONFLICT (<natural key>) DO NOTHING RETURNING ...`. PostgreSQL
resolves the conflict **inside the statement itself** — no exception is
ever raised for the expected race, so the transaction is never put into an
aborted state in the first place. Proven with the same minimal harness:

```sql
BEGIN;
CREATE TEMP TABLE t3 (id int PRIMARY KEY);
INSERT INTO t3 VALUES (1);
INSERT INTO t3 VALUES (1) ON CONFLICT (id) DO NOTHING RETURNING id;
                                  -- returns 0 rows, NO ERROR
SELECT 'transaction never left aborted state' AS proof;  -- ✅ succeeds
ROLLBACK;
```

---

## D. TICKET CONFLICT-SAFE CREATE

`getOrCreateTicket` — natural key `(tenant_id, order_id, business_day,
station_id)`, matching `uq_tickets_order_station` exactly:

```sql
INSERT INTO "kitchen"."tickets" (...)
VALUES (...)
ON CONFLICT ("tenant_id", "order_id", "business_day", "station_id") DO NOTHING
RETURNING <every column, aliased to the exact Prisma field name>
```

If the `INSERT` returns a row, that row was created by this call — no
comparison needed. If it returns zero rows, another transaction won; a plain
`SELECT` (which itself can raise no conflict) fetches the winner, and
`assertHeaderUnchanged` (unchanged from P1E-5 — §4) compares
`orderNumberSnapshot`/`orderTypeSnapshot`/`serviceReferenceSnapshot` against
the incoming event, throwing `TicketHeaderMismatchError` on a genuine
mismatch. **The winner's row is never updated** — the `SELECT` path has no
`UPDATE` statement anywhere.

All values are bound via Prisma's tagged-template `$queryRaw` (never
`$queryRawUnsafe`, never string concatenation) — every interpolated
`${value}` becomes a parameterized placeholder the same way an ordinary
Prisma query would, with an explicit Postgres type cast (`::uuid`, `::date`,
`::timestamptz`) on each one for unambiguous binding.

---

## E. FIRE-BATCH CONFLICT-SAFE CREATE

`getOrCreateFireBatch` — natural key `(tenant_id, ticket_id, fire_batch_id)`,
matching `uq_ticket_fire_batches_ticket_fire_batch`. Same
`INSERT ... ON CONFLICT DO NOTHING RETURNING` / fallback-`SELECT` shape.
**No `sequence_no`, no `MAX()+1` allocator** — unchanged from P1E-5's
accepted design (§5); this correction touches only the conflict-handling
mechanism, never the schema or the batch-identity model. A different
`fireBatchId` on the same ticket still produces a new row; the same
`fireBatchId` replayed still converges on one.

---

## F. TICKETLINE CONFLICT-SAFE CREATE

`getOrCreateTicketLine` — natural key `(tenant_id, ticket_id,
order_line_id)`, matching `uq_ticket_lines_ticket_order_line`. Same pattern.
`item_name_snapshot` is bound as `${JSON.stringify(...)}::jsonb` (a JSON
string, explicitly cast — not raw JS object interpolation); `quantity` is
bound as `${input.quantity}::decimal(12,3)` (the caller's decimal string,
cast, never a JS number).

**New, narrow invariant added per §6**: P1E-5 had no check at all for a
TicketLine losing a race with *different* immutable content — a silent
divergence could have hidden real corruption. `getOrCreateTicketLine` now
compares `itemNameSnapshot` (via `JSON.stringify`), `quantity` (via
`.toString()`), `course`, `sequence`, and `preparationNotes` against the
existing row on the fallback path, and throws `TicketHeaderMismatchError`
(the same typed error the Ticket header check uses — no new error class) on
a mismatch. This is the narrowest possible extension of the existing policy,
not a new invariant class or a schema change.

---

## G. MODIFIER CONFLICT-SAFE CREATE

`ensureTicketLineModifier` — natural key `(tenant_id, ticket_line_id,
source_order_line_modifier_id)`, matching
`uq_ticket_line_modifiers_line_source`. `INSERT ... ON CONFLICT DO NOTHING`
via `$executeRaw` (no `RETURNING` needed — this method's contract, unchanged
from P1E-5, never reports which case occurred; a second call for the
identical key is a pure no-op either way). Two **distinct**
`source_order_line_modifier_id` values referencing the same Catalogue
Modifier remain independently representable — proven directly (§H test 4
uses a real race; P1E-5's own sequential test for this case, unmodified,
still passes in the full suite, §L).

`ModifierKind` strategy is completely untouched: `kind` is still cast as
`${input.kind}::"kitchen"."ModifierKindSnapshot"`, the same enum P1E-5
defined; legacy `null`-kind handling on `catalogue.modifiers`/
`sales.order_line_modifiers` is not touched by this slice at all (no file
under `catalogue/` or `sales/` was modified).

---

## H. REAL CONCURRENCY TESTS

New file: `test/kitchen-ticket-concurrency.e2e-spec.ts`, **8 tests**, using a
genuine two-party barrier (`makeBarrier(2)`) so both racing calls have
already opened their own `PrismaService.withAuthContext` transaction
(`BEGIN` + `set_config` already executed) before either attempts the
conflicting write — a real database-level race across two independent
connections/transactions, not two `Promise.all`'d calls sharing one
transaction.

| # | Test | Result |
|---|---|---|
| 1+5 | Two concurrent transactions race to create the SAME Ticket; both issue a further, unrelated statement (`tx.tenant.count()`) afterward | ✅ exactly one Ticket exists; **both** transactions remain usable (no `25P02`); both converge on the same `ticket.id` |
| 2 | Same race for `(ticket, fireBatchId)` | ✅ exactly one batch row; both transactions remain usable |
| 3 | Same race for `(ticket, orderLineId)` | ✅ exactly one TicketLine; both transactions remain usable |
| 4 | Same race for `(ticketLine, sourceOrderLineModifierId)` | ✅ exactly one modifier snapshot; both transactions remain usable |
| 6 | Competing Ticket creation with a **different** immutable header (`orderNumberSnapshot` differs) | ✅ one call fulfils, the other rejects with `TicketHeaderMismatchError`; exactly one Ticket persists, carrying one of the two candidate headers (whichever won) |
| 7 | A genuine FK violation (station id that does not exist) | ✅ still throws and rolls back; zero Tickets created — never treated as an idempotent conflict |
| — | End-to-end: two concurrent Fire commands (real `unitOfWork.execute` calls, real handler, real routing resolution) for two different lines of the same order, same station | ✅ exactly one Ticket, two TicketLines |
| — | Sequential replay of the same fired line (regression sanity check) | ✅ exactly one Ticket, one TicketLine |

All 8 passed on the first run against a freshly-migrated scratch database —
no flakiness observed across the two full runs this session performed
(before and after the network interruption).

---

## I. HANDLER REGRESSION

Re-ran `test/kitchen-ticket-persistence.e2e-spec.ts` (P1E-5's own 31 tests)
unmodified against the corrected service — **31/31 still pass**, proving:

- duplicate `order.line.fired` → one Ticket, one batch, one TicketLine, one
  modifier snapshot (all four, individually asserted);
- a later `fireBatchId` on an already-ticketed station reuses the same
  Ticket and adds a new batch (no `sequence_no`);
- multi-station resolution unchanged (two Tickets, one line each);
- a routing failure (`ROUTING_NO_DESTINATION`) rolls back a test-owned
  marker write **and** every Kitchen write in the same transaction;
- an immutable Ticket header mismatch fails closed;
- exactly one `PrismaService.$transaction` call for the whole Fire+handler
  flow (spy-based assertion, unchanged from P1E-5).

**No retry framework was added around `UnitOfWork`** — `unit-of-work.ts` and
`domain-event-dispatcher.ts` are byte-for-byte unmodified by this slice;
`git status` confirms neither file appears in the changed set.

---

## J. MODULE BOUNDARIES

No accepted boundary was touched. `TicketPersistenceService` still:

- receives `tx: Prisma.TransactionClient` from its caller (the handler) and
  opens no transaction of its own;
- writes only `kitchen.*` tables, via table names hard-coded in this file's
  own SQL (`"kitchen"."tickets"`, `"kitchen"."ticket_fire_batches"`,
  `"kitchen"."ticket_lines"`, `"kitchen"."ticket_line_modifiers"`) — no
  `sales.*`/`catalogue.*` table is named anywhere in the new SQL;
- obtains routing configuration only through `RoutingResolverService` /
  the Organisation public contract — untouched, not even imported by this
  file.

`module-boundaries.spec.ts` re-run unmodified: **17/17 pass**, including the
P1E-5 assertions that scan `kitchen/**` for direct Prisma delegate calls
against `order`/`orderLine`/`orderLineModifier`/`modifier`/`modifierGroup`/
`menuItem`/`category` — the new raw-SQL `INSERT`/`SELECT` statements target
only `kitchen.*` tables by literal double-quoted identifier, so this
detector (which looks for Prisma delegate method calls, not raw SQL table
names) continues to find nothing, and a direct manual check confirms no
`sales.`/`catalogue.` schema-qualified table name appears anywhere in
`ticket-persistence.service.ts`. **Zero new `KNOWN_DEVIATIONS`.**

---

## K. MIGRATION VERIFICATION

- **No new migration** — `ls prisma/migrations | wc -l` still returns 26.
  `git status` shows no new file under `prisma/migrations/`.
- `schema.prisma` **not edited** for this correction (`git status` shows no
  modification to it).
- `npx prisma format` / `validate` — clean (re-run as regression; no
  content changed).
- Scratch DB (`ros_p1e3_scratch`) dropped and recreated from zero twice this
  session (once before, once after the network interruption); **all 26
  migrations applied cleanly both times** (`prisma migrate deploy`).
- Local dev DB (`ros`) confirmed **completely untouched**: `prisma migrate
  status` shows the identical 11 unapplied migrations (8 pre-existing + the
  3 P1E-5 migrations); sentinels unchanged
  (`catalogue.price_lists=78`, `catalogue.modifiers=18`,
  `kitchen.station_routing_rules=0`).

---

## L. FULL TESTS

- `npx tsc --noEmit` — zero new errors; only the pre-existing baseline
  (`access-token.service.spec.ts(28,7)`).
- `npx eslint` on both changed files — zero errors.
- Full unit suite: **51 suites / 702 tests**, all passing (unchanged count
  from P1E-5 — this correction added no new unit test file, only the raw-SQL
  service rewrite, which the existing e2e suites exercise).
- Full e2e suite: **29 suites / 613 tests**, all passing (605 at P1E-5's
  close + 8 new concurrency tests = 613).
- Named regression suites, run individually as this slice's instructions
  specified:
  - `routing-config-contract.e2e-spec.ts` (P1E-3A) — pass.
  - `kitchen-ticket-persistence.e2e-spec.ts` — 31/31 pass.
  - `kitchen-ticket-concurrency.e2e-spec.ts` — 8/8 pass.
  - `cash-session.e2e-spec.ts` — pass.
  - `routing-resolver.service.spec.ts`, `module-boundaries.spec.ts`,
    `trusted-construction-boundary.spec.ts` — 42/42 pass.
  - Catalogue + Sales e2e suites — 172/172 pass.
- One transient interruption occurred mid-session (`ENOTFOUND` during the
  first full e2e run) after a single, already-diagnosed contamination
  failure in `organisation.e2e-spec.ts`'s location-registry test — the same
  pre-existing, unrelated pattern P1E-3/P1E-5 already documented (raw
  `admin.branch.create`/`admin.station.create` fixture inserts bypass the
  application's location-registry auto-creation logic). Resolved on
  resumption by dropping and recreating the scratch DB from zero — an
  environment reset, not a code change — after which the full suite passed
  clean.

---

## M. FILES CHANGED

**Modified:** `src/modules/kitchen/tickets/ticket-persistence.service.ts` —
rewritten from `try { create() } catch (P2002) { findUniqueOrThrow() }` to
`INSERT ... ON CONFLICT (<natural key>) DO NOTHING RETURNING ...` for all
four idempotent creation points, plus the new TicketLine immutable-snapshot
check (§F).

**New:** `test/kitchen-ticket-concurrency.e2e-spec.ts` (8 tests).

No other file was touched. No migration, no `schema.prisma` edit, no
governance document, no permission, no route.

---

## N. P1E-5A EXIT

- **P1E-5A EXPECTED CONFLICTS ARE NON-ABORTING: YES.** Proven directly
  against PostgreSQL (§C) and by 8 real two-transaction race tests (§H) —
  every expected natural-key conflict on all four tables resolves via
  `ON CONFLICT DO NOTHING`, raising no exception and leaving the losing
  transaction fully usable.
- **P1E-5A REAL CONCURRENCY PROVEN: YES.** Genuine two-connection races
  (barrier-synchronized, not sequential or `Promise.all`-on-one-transaction)
  for all four natural keys, plus an end-to-end handler-level race, plus the
  immutable-header-conflict and FK-violation-still-aborts cases.
- **P1E-5A IMMUTABLE SNAPSHOTS SAFE: YES.** Ticket header comparison
  unchanged and re-proven under real concurrency (not just sequentially);
  TicketLine now carries the equivalent check (new, narrow, §F); the
  winner's row is never updated on either table.
- **P1E-5A HANDLER REGRESSION-FREE: YES.** All 31 of P1E-5's own handler
  tests pass unmodified; exactly one `$transaction` per Fire; no retry
  framework added; `unit-of-work.ts`/`domain-event-dispatcher.ts` untouched.
- **P1E-5A OVERALL COMPLETE: YES.**

---

## O. P1E-5 FINAL ACCEPTANCE

**P1E-5 FINAL ACCEPTANCE: YES.** The one concurrency correctness defect
acceptance review raised — catching a PostgreSQL unique-violation and
continuing to query the same now-aborted transaction — is confirmed real
(§B, mechanically reproduced in §C) and is now corrected across all four
idempotent creation points (§D–§G), with the correction proven under
genuine PostgreSQL concurrency (§H, 8 tests) rather than merely re-asserted
sequentially, and proven not to have disturbed P1E-5's accepted schema,
routing semantics, event contract, RLS, cardinality, modifier-kind
strategy, or module boundaries (§I, §J, full regression §L).

---

## P. NEXT

**NEXT: REPOSITORY CHECKPOINT / COMMIT / PUSH.**

Every slice from P1E-1 through P1E-5A has accumulated as uncommitted working-
tree changes across this entire multi-session engagement — `git log -1`
still shows `e5648fb`, the commit that predates all of it. The next action
is not new feature work; it is committing (and, if the user directs it,
pushing) this substantial, fully-verified body of work before continuing to
the Fire authorization decision P1E-5's own report identified as the
following slice. **This report does not perform that checkpoint** — no
`git add`, no `git commit`, no `git push` was run in this session, per
explicit instruction.

---

## Q. COMMIT READINESS

**COMMIT READY: YES.** The correction is narrow, self-contained, passes
every verification this report ran (tsc, eslint, full unit + e2e suites,
8 real concurrency tests, 26-migrations-from-zero, local-dev-DB-untouched
check), and touches exactly two files.

**COMMITTED: NO.** No commit and no push were performed in this session,
per explicit instruction. This report drafts no commit message and stages
no files; that step is the user's.
