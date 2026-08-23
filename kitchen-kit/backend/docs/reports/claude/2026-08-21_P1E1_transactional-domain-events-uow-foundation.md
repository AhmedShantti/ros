# P1E-1 — Minimal Transaction-Aware Domain Event / Unit-of-Work Foundation

**Report type:** Claude Code implementation/design/verification evidence
**Authority:** Non-authoritative evidence; SRS and ratified governance remain authoritative
**Date:** 2026-08-21
**HEAD:** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Branch:** `feat/production-spec`
**Working tree:** accumulated uncommitted P0/P1A–P1D work retained throughout; this run added the domain-event/Unit-of-Work infrastructure, Sales/Kitchen event contracts, tests, and one line of `app.module.ts` wiring (see §N) — no commit made
**Claude task:** P1E-1 — implementation slice for the minimal transaction-aware in-process domain-event mechanism (SRS §5.5.2) and the Sales/Kitchen contract substrate it needs. Infrastructure + contracts + verification only — no Fire, no Kitchen persistence, no Payment, no outbox.

---

## A. STARTING STATE

Independently re-verified against the repository, not merely re-quoted from `docs/reports/claude/2026-08-21_P1D1_acceptance-and-fire-kds-gate.md`:

| Claim | Verified |
|---|---|
| HEAD `e5648fb` | ✅ |
| Branch `feat/production-spec` | ✅ |
| 20 migrations on disk | ✅ `ls prisma/migrations` = 20 dirs + lock file |
| 603 unit / 550 E2E / 1153 total | ✅ re-ran full suites before any change; identical counts |
| TS baseline `access-token.service.spec.ts(28,7) TS2322` | ✅ only error before and after this slice |
| Local dev DB: 78 `price_lists` rows, 5 unapplied migrations | ✅ re-verified before, during, and after (§M) |
| Public Treasury API = `POST /cash-sessions` only | ✅ `treasury.controller.ts` unchanged this run |
| `workforce/contract/` exists; Treasury imports only it | ✅ |
| 21 pre-existing private-import deviations recorded in `module-boundaries.spec.ts` | ✅ unchanged `KNOWN_DEVIATIONS` — this slice adds none |
| No event bus, no UoW event drain, no outbox, no Sales/Kitchen `contract/` | ✅ — this is exactly what this slice builds |
| No Fire route, no Kitchen Ticket/TicketLine, no Payment | ✅ confirmed absent both before and after (§K scope regression) |

One correction to the prior report's framing, not its facts: that report's "Full E2E: 550 passed" and "603 unit passed" were necessarily run against a **scratch database with all 20 migrations applied**, not the local dev DB — the dev DB is missing 5 migrations (including `pin_employee_substrate`, which adds `credentials.failed_attempts`) and the existing CashSession/Sales E2E suites fail against it for that reason alone (confirmed directly in §L). The prior report's evidence is unaffected; this note exists so a future session does not try to run E2E straight against the dev DB and misread the result as a regression.

---

## B. SOURCE / ARCHITECTURE INTERPRETATION

Read directly from the extracted SRS text (`ROS_SRS_v1.0.pdf`, cached extraction), not from the prior report's paraphrase.

**§5.2.3 — mechanically enforced rules (verbatim table):**
"A module MUST NOT import from another module's internal directory" (ESLint boundary rule + CI); "A module MUST NOT query another module's tables" (per-module DB role + CI); "Cross-module communication is via a published interface or a domain event" (architecture test suite); "Every module publishes a versioned contract in `modules/<name>/contract/`" (CI check for contract file presence); "Shared code lives in `shared/` and MUST NOT contain business logic" (static analysis rule).

The repository's equivalent of `shared/` is `src/common/` (money, idempotency, ids, duration, throttler — all framework/utility code, zero domain rules). This slice's infrastructure lives at `src/common/domain-events/`, following that existing naming, not inventing a parallel `shared/` tree.

**§5.4 — layered module shape:** `contract/` is "PUBLIC. Other modules may import only this," holding `events.ts` (domain events published), `commands.ts`, `queries.ts`, `types.ts`. The repository does not implement the full `domain/application/infrastructure/presentation` split this section also describes (services sit flat under each module, e.g. `sales/orders/orders.service.ts`) — that divergence pre-dates this slice and is out of scope here; only the `contract/` boundary is load-bearing for P1E-1.

**§5.5.1 — synchronous direct interface call:** "Used when the caller requires the result to proceed and the operation must be in the same transaction." This is the pattern Workforce's `SHIFT_OPENER` already uses (P1D-1) and is untouched by this slice.

**§5.5.2 — asynchronous in-transaction domain events (verbatim):** "Used when a state change must cause other state changes atomically. Events are collected on the aggregate, and dispatched by the unit of work within the same database transaction." Example given: `OrderCompleted` causing inventory depletion, COGS recognition, and cash posting — "All four must succeed or all must fail." **This is the exact mechanism P1E-1 builds**, with none of `OrderCompleted`'s producers wired.

**§5.5.3 — transactional outbox (verbatim):** "Used when a state change must cause an effect **outside the database**, which cannot participate in the transaction." Named examples: fiscal submission, receipt SMS, aggregator push, CDN cache invalidation. The source calls it "mandatory (FR-PLT-041)" — a requirement ID that, as the prior gate report established, is never defined anywhere in the 161-page document. **Out of scope for P1E-1 regardless**: nothing this slice touches is an out-of-process effect (§C below).

**§5.5.4 — event catalogue (verbatim table, confirmed row-for-row):** `order.line.fired` — publisher **Sales**, principal subscriber **Kitchen Ops**. `ticket.bumped` — publisher **Kitchen Ops**, principal subscribers **Sales, Analytics**. The mandatory envelope (verbatim JSON): `eventId, eventType, eventVersion, occurredAt, recordedAt, tenantId, branchId, actorId ("user|system|device"), correlationId, causationId, idempotencyKey, payload`.

**ADR-006 — Event-Driven Internal Integration with Transactional Outbox:** "In-process domain events inside the transaction boundary; transactional outbox for all external effects." "All external effects are at-least-once, so all external integrations must be idempotent" — a consequence for the outbox path, not this slice's in-process path.

Classification of every design choice against these sources is in §O.

---

## C. IMPLEMENTATION SHAPE

```
src/common/domain-events/
  domain-event.types.ts        DomainEventEnvelope<TType, TPayload>, DomainEventActorType,
                                CreateDomainEventInput<TType, TPayload>
  create-domain-event.ts       createDomainEvent() — builds one envelope
  domain-event-collector.ts    DomainEventCollector — per-Unit-of-Work event queue
  unit-of-work-context.ts      UnitOfWorkContext { tx, events }
  domain-event-dispatcher.ts   TransactionalDomainEventHandler, DOMAIN_EVENT_HANDLERS,
                                TransactionalDomainEventDispatcher, MAX_DRAIN_ITERATIONS,
                                DomainEventDispatchLimitExceededError
  unit-of-work.ts              UnitOfWork — wraps PrismaService.withAuthContext
  domain-events.module.ts      DomainEventsModule (@Global(), like PrismaModule/IdempotencyModule)
  *.spec.ts                    unit tests (§L)

src/modules/sales/contract/
  events.ts                    order.line.fired — typed contract only, not published
  index.ts, events.spec.ts

src/modules/kitchen/contract/
  events.ts                    ticket.bumped — typed contract only, not published
  index.ts, events.spec.ts
```

**Why this location, not `modules/<x>/infrastructure/messaging/`:** §5.4's idealized per-module `infrastructure/messaging/` holds "event bus **adapters**" — module-specific glue to a shared mechanism. The mechanism itself is cross-cutting and belongs where the rest of the repository's cross-cutting infrastructure already lives (§5.2.3's `shared/` rule, realized here as `common/`). No module owns the dispatcher; every module will eventually depend on it.

**Why `UnitOfWork` wraps `withAuthContext` rather than replacing it:** `PrismaService.withAuthContext`'s own docblock states "nested calls to withAuthContext are NOT supported (Prisma has no nested interactive transactions); compose within a single scope instead." `UnitOfWork.execute` therefore calls `withAuthContext` exactly once and does its event-draining **inside** that same callback — before it returns — which is what lets the pre-existing `$transaction` commit only after dispatch succeeds. It is not a second transaction layered on top; it is the same one, extended by one more step. IMPLEMENTATION FACT, verified by reading `prisma.service.ts` before writing any of this.

---

## D. DOMAIN EVENT TYPES

`DomainEventEnvelope<TType extends string, TPayload>` carries exactly the §5.5.4 field set, with two ENGINEERING CHOICEs recorded in the type's own docblock and repeated here:

- `occurredAt`/`recordedAt` are typed `Date`, not the ISO-8601 strings shown in the source's JSON rendering — this mechanism is in-process only; string serialization is a concern of a future §5.5.3 adapter, not of this dispatch mechanism.
- `causationId` is `string | null` — the source's example always shows a value, but a root-cause event has nothing to reference. Not source-decided either way.

`actorType` is `'user' | 'system' | 'device'` — the source's literal `"user|system|device"` — **deliberately not** reused from the repository's existing `AuditActorType` (`'user' | 'anonymous' | 'system' | 'terminal'`, `governance/audit/audit.constants.ts`), because the two vocabularies differ and no source read for this slice decides how to unify them.

No `any` anywhere in this file or any file under `domain-events/`, `sales/contract/`, `kitchen/contract/` — verified both by `tsc --noEmit` (strict mode catches an implicit `any` the moment it would change behavior) and by grep (§L, item 26/27). `payload` is `Readonly<TPayload>` on the type and `Object.freeze`d at construction (`create-domain-event.ts`) — a handler that tries to mutate it throws (proven at runtime in `sales/contract/events.spec.ts`, not just asserted at the type level).

`createDomainEvent()` fills `eventId` via the repository's existing `newId()` (ULID-as-UUID, ADR-009 — the same generator every other surrogate key in this codebase uses) and `recordedAt` via `new Date()` at construction.

---

## E. UNIT OF WORK

```ts
class UnitOfWork {
  async execute<T>(scope: AuthScope, fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    return this.prisma.withAuthContext(scope, async (tx) => {
      const ctx = { tx, events: new DomainEventCollector() };
      const result = await fn(ctx);
      await this.dispatcher.drain(ctx);
      return result;
    });
  }
}
```

`ctx.events` is a **new `DomainEventCollector` instance per call** — a local variable inside the callback, never a module- or class-level field. That is the entire concurrency-isolation mechanism: there is nothing to isolate because nothing is shared. Proven against a real, concurrently-executing pair of transactions in §L (test 16), not just argued from the code shape.

No service in the repository is migrated onto `UnitOfWork` in this slice, per instruction — `OrdersService`, `CashSessionsService`, etc. still call `withAuthContext` directly and are untouched.

`DomainEventsModule` is registered `@Global()` in `app.module.ts`, positioned directly after `PrismaModule` and before `IdempotencyModule` — the same placement logic as those two (cross-cutting, no business logic, needed before any bounded-context module). This is the only change to `app.module.ts`.

---

## F. TRANSACTIONAL DISPATCH

`TransactionalDomainEventDispatcher.drain(ctx)`:

1. Drains `ctx.events` into a batch.
2. For each event, for each handler registered for that `eventType` (via `DOMAIN_EVENT_HANDLERS`, filtered at dispatch time — **registration order is preserved**, which is the ENGINEERING CHOICE for handler ordering; the SRS does not specify one), `await handler.handle(event, ctx)` **sequentially**.
3. A handler's rejection propagates unchanged — not caught, not logged-and-continued, not retried.
4. Re-drains `ctx.events` (a handler may have enqueued more) and repeats, bounded by `MAX_DRAIN_ITERATIONS = 50` (ENGINEERING CHOICE — no source specifies a bound; without one, a handler that unconditionally re-emits its own event type would hang the request instead of failing loudly). Exceeding it throws `DomainEventDispatchLimitExceededError`, which propagates exactly like a handler error would.

No `setTimeout`, `queueMicrotask`, `process.nextTick`, unawaited promise, Node `EventEmitter`, `@nestjs/event-emitter`, broker, or background worker anywhere in `domain-events/` — confirmed by grep (§L item 25) as well as by code inspection.

`DOMAIN_EVENT_HANDLERS` defaults to `[]` in `DomainEventsModule`. **No handler is registered anywhere in the production dependency graph** — no business event is published yet, so there is nothing to subscribe to. The e2e proof (§L, items 11–16) constructs its own `TransactionalDomainEventDispatcher` with test handlers directly (plain `new`, no DI) against the app's real `PrismaService`, to prove the mechanism against real PostgreSQL without wiring a fake production handler into the app graph.

---

## G. SALES CONTRACT

`src/modules/sales/contract/events.ts` defines `ORDER_LINE_FIRED_EVENT_TYPE = 'order.line.fired'`, `ORDER_LINE_FIRED_EVENT_VERSION = 1`, and:

```ts
interface OrderLineFiredPayload {
  orderId: string;
  businessDay: Date;   // partition key — required to reference either composite PK
  orderLineId: string;
  course: number | null;
}
```

**Payload scope, and why it stops here:** the prior gate report (§H) found three of FR-KDS-010's five routing tiers have no storage at all, and the two that do carry unresolved semantic questions (modifier replace-vs-augment; item-vs-variant scope). None of that is decided by this slice, so none of it is guessed into the payload. What remains — which line, on which order, on which partition-key business day, on which course — is what the source unambiguously supports today. `course` is included only because `sales.order_lines.course` already exists as a plain fact about the fired line (FR-POS-036 `[S]`), not a routing decision.

`OrdersService` does **not** import this file. No route constructs an `order.line.fired` envelope. This is asserted in three independent ways: (1) `module-boundaries.spec.ts`'s new test confirms the contract exists and contains no `any`; (2) grep confirms no producer references `ORDER_LINE_FIRED_EVENT_TYPE` outside `contract/`/`contract/events.spec.ts` (§L item 13); (3) `orders.controller.ts`'s own docblock — unmodified by this slice — still lists `POST /orders/:id/fire` as "DELIBERATELY ABSENT."

---

## H. KITCHEN CONTRACT

`src/modules/kitchen/contract/events.ts` defines `TICKET_BUMPED_EVENT_TYPE = 'ticket.bumped'`, `TICKET_BUMPED_EVENT_VERSION = 1`, and:

```ts
interface TicketBumpedPayload {
  ticketId: string;   // Kitchen-side identity. Opaque to Sales.
  orderId: string;
  businessDay: Date;  // sales.orders partition key
}
```

**No `KitchenModule`.** No `Ticket`, no `TicketLine`, no controller, no service — none exist in the repository, and this slice does not create any of them. `src/modules/kitchen/` contains exactly the `contract/` directory and nothing else. This is legal under §5.4 ("a contract directory may exist without persistence/business implementation behind it," per the instruction, and consistent with the section's own framing of `contract/` as what a module *publishes*, independent of what else it has built) and is the deliberate minimum: Kitchen's actual schema is blocked on six open conflicts the prior gate report recorded in its §I (partitioned-FK impossibility, missing `tenant_id`, timestamp defaults, stringly-typed status, an under-specified status vocabulary against FR-KDS-040, and the Station-aggregate placement disagreement across three sources) — none of which this slice resolves or needs to resolve to publish a typed event name.

`module-boundaries.spec.ts`'s `walk()`/`moduleOf()` treat any first-level directory under `src/modules/` as a module the moment a file exists there, so `kitchen` is picked up automatically; no special-case wiring was needed or added.

---

## I. TENANCY / TRANSACTION CONTEXT

No new HTTP operation, no new tenant-owned table, no new permission, no new RLS policy, no new DB grant, no auth guard — none of this slice's files touch any of those surfaces. `grep -rn "@RequirePermission\|@Get\|@Post\|CREATE TABLE" src/common/domain-events src/modules/sales/contract src/modules/kitchen` returns nothing.

The four tenancy proofs required (§10 of the task) map to real-PostgreSQL tests, not assertions about the code shape:

| Requirement | Proof |
|---|---|
| A. Envelope tenant/branch data belongs to the current operation | `createDomainEvent` takes `tenantId`/`branchId` as explicit required inputs from the caller — never inferred, never defaulted; type-checked at every call site (`sales/contract/events.spec.ts`, `kitchen/contract/events.spec.ts`) |
| B. Subscriber uses the SAME transaction with the same RLS auth context | e2e test 15 — a handler runs a query with **no explicit context set** and still only sees the tenant the outer `UnitOfWork.execute({tenantId: A}, …)` call established, proving the RLS context set once at `withAuthContext` start is still the one Postgres enforces inside the handler |
| C. A subscriber cannot execute outside the tenant context merely by being reached through the dispatcher | Same test 15 — the dispatcher passes `ctx` through unchanged; there is no alternate code path that re-derives or drops the auth context between the publisher's writes and the handler's |
| D. Concurrent tenant Units of Work do not mix event queues | e2e test 16 — two `UnitOfWork.execute` calls for two different tenants, run via `Promise.all`, each with its own dispatcher/handler; each handler observes only its own tenant's events |

`tenantId` is never accepted from an external request body anywhere in this slice — there is no request body in this slice; it does not add an HTTP surface.

---

## J. ERROR / ROLLBACK SEMANTICS

No new HTTP error code, no controller. Handler exceptions are never caught, logged-and-continued, or auto-retried inside the dispatcher (§F). The one deliberate infrastructure error, `DomainEventDispatchLimitExceededError`, exists solely to turn an otherwise-silent infinite loop into a deterministic thrown error — it is not a business error and carries no HTTP mapping.

`AuditService` is untouched. No `EVENT_DISPATCHED` audit action was added; no event envelope is persisted anywhere; `AuditService` is not treated as an event store or as the dispatcher. The audit hash-chain format (`audit-hash.ts`) was not read for modification and was not modified.

---

## K. ARCHITECTURE BOUNDARY EVIDENCE

`module-boundaries.spec.ts` gained two tests (§L, items 17–18) confirming the Sales and Kitchen contracts exist, export from `events.ts`, and contain no `any` in a type-annotation sense (the check is `/:\s*any\b|<any>|\bas any\b/`, not a bare `\bany\b` — an earlier draft of this check false-failed on the word "any" inside prose comments; fixed before this report, see `git diff`/file content). `KNOWN_DEVIATIONS` is **unchanged** — this slice adds zero new cross-module private imports; `sales/contract` and `kitchen/contract` import only from `common/domain-events` (outside `modules/`, so outside the architecture test's scope entirely) and nothing imports either contract yet, so there is nothing to violate or to grandfather.

---

## L. TESTS

No skipped, no todo, anywhere in this slice.

**Unit — `src/common/domain-events/domain-event-collector.spec.ts` (4 tests, §13.A):** records typed events; preserves insertion order on drain (via `idempotencyKey`, since `drain()` deliberately erases the specific payload type for a heterogeneous queue — the first version of this test asserted on `payload.n` and correctly failed `tsc --noEmit`, which is exactly the "no `any`" property working as intended); a second drain returns nothing; two collector instances have independent queues.

**Unit — `src/common/domain-events/domain-event-dispatcher.spec.ts` (11 tests, §13.B):** dispatches only to the matching-type handler; passes the identical `ctx`/`tx` object through; awaits an async handler before `drain()` resolves; two handlers for one event run in registration order; a handler error propagates and is not swallowed; a later handler in the same batch does not run once an earlier one throws; a handler may enqueue a further event, drained in the next round; an unbounded self-emitting handler is rejected with `DomainEventDispatchLimitExceededError`; an event with no registered handler drains silently (explicit ENGINEERING CHOICE — no source requires a "handler must exist" invariant, and none is asserted); zero-handler default works; `MAX_DRAIN_ITERATIONS` is a positive constant.

**Unit — `sales/contract/events.spec.ts` (4 tests) / `kitchen/contract/events.spec.ts` (4 tests), §13.E:** exact event-name preservation (`order.line.fired`, `ticket.bumped`); positive-integer version; a well-formed envelope carrying only the decided payload fields; the payload is frozen — `Object.isFrozen` true, and a `@ts-expect-error` assignment throws at runtime, proving readonly is enforced by the runtime, not only the type checker.

**Unit — `module-boundaries.spec.ts`, +2 tests (§13.D, items 17–22):** covers 17 (Sales contract exists), 18 (Kitchen contract exists), 19 (contracts import nothing private — mechanically true, since neither imports anything under `modules/`), 20 (nothing outside can import past `contract/` — the pre-existing whole-tree assertion already covers any future consumer), 21 (no new deviation — the pre-existing `KNOWN_DEVIATIONS` equality test fails loudly if this slice had added one; it did not), 22 (Workforce's own two tests are unmodified and still pass).

**E2E, real PostgreSQL — `test/domain-events.e2e-spec.ts` (5 tests, §13.C, items 11–16):** run against the app's real `PrismaService` (real RLS-constrained `ros_app` connection) with a separate `ros_migrator` admin connection for out-of-band visibility checks, using `identity.memberships` (unique on `[userId, tenantId]`, already RLS-enabled) as the smallest available tenant-scoped table — chosen specifically so this suite needs no Sales/Kitchen/CashSession fixtures and makes no claim about Fire.

1. **Publisher write + subscriber write commit together** — both rows present after a successful `UnitOfWork.execute`.
2. **Subscriber failure rolls back BOTH writes** — the subscriber performs its own write, *then* throws; afterward, **neither** row exists (proving the rollback undoes work already performed inside the transaction, not merely work about to happen).
3. **Not visible outside the transaction until the whole Unit of Work commits** — the handler, mid-transaction, queries via the **separate** `ros_migrator` connection and observes its own not-yet-committed row as absent (Postgres READ COMMITTED default); after `execute()` resolves, the same query sees it.
4. **RLS tenant context remains active inside the subscriber** — a tenant-B row is arranged directly via the admin client; the handler, with no explicit context of its own, queries both a tenant-A id and the tenant-B id on the same `tx` the outer `execute({tenantId: A}, …)` opened, and sees only the tenant-A row.
5. **Concurrent Units of Work for two tenants never cross-contaminate** — two `UnitOfWork.execute` calls (tenant A, tenant B) run via `Promise.all`, each with its own dispatcher/handler pair; A's handler observes exactly A's two events, B's handler observes exactly B's one event.

**Scope regression (§13.F, items 29–37) — verified via targeted grep and full-suite execution, not new unit tests** (the task's own §15 lists the equivalent checks as grep-based verification steps, which is the more direct proof for "does not exist" claims than a unit test would be):

| # | Check | Result |
|---|---|---|
| 29 | no `/fire` route | clean — the only match is `orders.controller.ts`'s pre-existing docblock line stating it is "DELIBERATELY ABSENT" |
| 30/31 | no Kitchen Ticket/TicketLine table | clean — no `CREATE TABLE`, no Prisma model, confirmed by reading the full `schema.prisma` diff (none) |
| 32 | no Payment route/table | clean — two matches are pre-existing docblock comments in `treasury.controller.ts`/`treasury.permissions.ts` explaining why `pos.payment.capture` is *not yet* authorised (P1D-F carried item) |
| 33 | no outbox table | clean — zero matches for `platform.outbox`, `OutboxService`, `OutboxModule` |
| 34 | no `pos.order.fire` permission | clean |
| 35 | no broadening of `pos.order.create` | clean — `sales.permissions.ts` untouched |
| 36 | existing CashSession tests remain green | **143/143** (138 pre-existing + 5 new), run against a from-zero scratch DB (§M) |
| 37 | existing P1C Sales line capture remains green | same run — `sales.e2e-spec.ts`/`sales-lines.e2e-spec.ts` included in the 143 |

---

## M. MIGRATION / DATABASE VERIFICATION

**No production migration was created or is needed.** The event mechanism is entirely in-process (§5.5.2); there is no events table, no handler-registration table, no UoW table, no outbox table. `git status --short prisma/migrations/` shows the same 6 pre-existing untracked migration directories as before this slice — zero new.

Because the local dev DB (`ros`) is genuinely 5 migrations behind (deliberately — per every prior report and re-confirmed here), running the CashSession/Sales E2E regression directly against it fails on missing columns (`credentials.failed_attempts`) unrelated to this slice. To verify "existing tests remain green" honestly, a scratch database was used, exactly as the prior P1D-1 gate did:

1. `CREATE DATABASE ros_p1e1_scratch` + `GRANT CONNECT ... TO ros_app`.
2. `DATABASE_URL` pointed at it; `npx prisma migrate deploy` → **all 20 migrations applied from zero, "All migrations have been successfully applied."**
3. `npx prisma migrate status` → **"Database schema is up to date!"**
4. `DATABASE_URL`/`APP_DATABASE_URL` both pointed at the scratch DB for test runs only.
5. `DROP DATABASE ros_p1e1_scratch` after all runs completed.
6. Re-ran `npx prisma migrate status` against the **real** `.env` (local dev DB) afterward: **identical output to before this slice** — same 5 migrations still listed as unapplied.
7. Re-counted `catalogue.price_lists`: **78 rows, unchanged.**

The local dev DB was never pointed at by any test run in this slice; it was only read (`migrate status`, a `SELECT count(*)`) before and after, to prove it, not to use it.

| Command | Result |
|---|---|
| `npx prisma format` | no-op (schema untouched by this slice) |
| `npx prisma validate` | ✅ valid |
| `npx prisma generate` | ✅ Prisma Client 7.9.1 |
| Scratch DB, 20 migrations from zero | ✅ all applied |
| Scratch DB `migrate status` | ✅ up to date |
| CashSession + Sales + Sales-lines + domain-events E2E, scratch DB | ✅ **143/143** |
| Full unit suite | ✅ **628/628**, 47 suites (603 → 628, **+25**, exactly matching §L's per-file counts: 4+11+4+4+2) |
| Full E2E, scratch DB, `--runInBand` | ✅ **555/555**, 25 suites (550 → 555, **+5**, the new `domain-events.e2e-spec.ts`) |
| **Total** | **1183 passing** (1153 → 1183, **+30**), 0 skipped, 0 todo |
| `npx eslint` on all new/changed files | ✅ clean (fixed 4 prettier issues + 10 `require-await` issues found during this run — see below) |
| `npx tsc --noEmit` | exactly the pre-existing baseline `access-token.service.spec.ts(28,7) TS2322` — **no new error** |
| Local dev DB after everything | ✅ unchanged — 78 `price_lists` rows, same 5 unapplied migrations |

Two lint issues found and fixed **during** this slice, recorded for transparency: (1) several test-only handler functions were declared `async` with no `await` inside — fixed by dropping `async` and returning `Promise.resolve()` explicitly, which satisfies `TransactionalDomainEventHandler.handle`'s `Promise<void>` return type without violating `@typescript-eslint/require-await`; (2) the first version of the "no `any`" architecture-test regex (`/\bany\b/`) false-failed on the English word "any" inside a docblock comment — narrowed to `/:\s*any\b|<any>|\bas any\b/`, which matches only TypeScript's `any` type usage.

---

## N. FILES CHANGED

**New**

```
src/common/domain-events/domain-event.types.ts
src/common/domain-events/create-domain-event.ts
src/common/domain-events/domain-event-collector.ts
src/common/domain-events/domain-event-collector.spec.ts
src/common/domain-events/unit-of-work-context.ts
src/common/domain-events/domain-event-dispatcher.ts
src/common/domain-events/domain-event-dispatcher.spec.ts
src/common/domain-events/unit-of-work.ts
src/common/domain-events/domain-events.module.ts
src/modules/sales/contract/events.ts
src/modules/sales/contract/index.ts
src/modules/sales/contract/events.spec.ts
src/modules/kitchen/contract/events.ts
src/modules/kitchen/contract/index.ts
src/modules/kitchen/contract/events.spec.ts
test/domain-events.e2e-spec.ts
docs/reports/claude/2026-08-21_P1E1_transactional-domain-events-uow-foundation.md
```

**Modified**

```
src/app.module.ts                       — +2 lines: import + register DomainEventsModule
src/modules/module-boundaries.spec.ts   — +2 tests (Sales/Kitchen contract existence); fixed
                                           the any-regex false-positive noted in §M
docs/reports/claude/INDEX.md            — +1 row (this report)
```

**Untouched:** `prisma/schema.prisma`, every migration, every governance document, `docs/catalogue/PHASE_16_DISCOVERY.md`, all P0/P1A/P1B/P1C/P1D accumulated work, `sales.permissions.ts`, `treasury.permissions.ts`, `orders.controller.ts`, `orders.service.ts`, `cash-sessions.service.ts`, `treasury.controller.ts`, `workforce/contract/`, the local dev DB.

---

## O. REQUIREMENT / ARCHITECTURE CLASSIFICATION

**§5.2.3 module-boundary compliance: PARTIAL.**
This slice adds zero new violations (module-boundaries test: unchanged `KNOWN_DEVIATIONS`, 2 new passing assertions). It does not repair any of the 21 pre-existing cross-module private-import deviations recorded in P1D-1. Global compliance remains PARTIAL — not COMPLETE — because most of the repository still imports private paths across module boundaries for reasons unrelated to this slice.

**§5.4 module contracts: PARTIAL.**
Three modules now publish `contract/`: Workforce (P1D-1), Sales, Kitchen (this slice). Every other module — Catalogue, Identity, Inventory, Localisation, Organisation, Production, Treasury, Governance — still has none. Global compliance remains PARTIAL.

**§5.5.2 transaction-aware domain-event mechanism: infrastructure COMPLETE; system-wide adoption NOT IMPLEMENTED.**
The mechanism itself is fully executable and proven against real PostgreSQL for every property the SRS sentence requires: in-process, same transaction, dispatched by the unit of work, atomic (rollback undoes publisher and subscriber writes together), no fire-and-forget. **No business producer exists** — `order.line.fired` and `ticket.bumped` are typed contracts with zero call sites outside their own tests. Reporting this as globally COMPLETE would be false; it is PARTIAL at the system level with a COMPLETE, verified foundation.

**§5.5.3 transactional outbox: NOT IMPLEMENTED.**
Not a defect of this slice — §5.5.3 governs out-of-process effects, and this slice's target (in-database Kitchen ticket creation, once it exists) does not qualify (§C, §K of the prior gate report). No outbox table, relay, or broker exists, and none should for this slice's scope.

**§5.5.4 event catalogue: PARTIAL.**
Two of the catalogue's twelve-plus events (`order.line.fired`, `ticket.bumped`) now have a typed contract. The other ten (`order.opened`, `order.line.voided`, `order.completed`, `order.refunded`, `discount.applied`, `stock.received`, `stock.moved`, `stock.counted`, `waste.recorded`, `recipe.version.published`, `shift.opened`/`shift.closed`, `cash.variance.detected`, `purchase_order.approved`, `day.closed`, `sync.conflict.resolved`) have neither a contract nor a mechanism to publish through until this slice. Typed contracts alone do not make the catalogue executable — no event in the catalogue is actually published by anything, in this slice or before it.

**ADR-006:** the "in-process domain events inside the transaction boundary" half now has a real, tested implementation. The "transactional outbox for all external effects" half is entirely unimplemented — no table, no relay, no consumer idempotency handling (a stated *consequence* of the ADR: "all external integrations must be idempotent," which is moot while nothing is external yet).

**Fire: NOT IMPLEMENTED.** No route, no permission, no ticket creation, no routing resolution. Unchanged from the prior gate report — Fire authorization remains a source gap this slice does not touch (§G of that report stands).

**FR-KDS-010: PARTIAL**, unchanged from the prior gate report's tier-by-tier finding — nothing in this slice adds or removes routing storage or resolution logic.

**Payment: NOT IMPLEMENTED.** No route, no table, no permission. Unchanged.

---

## P. P1E-1 EXIT

```
P1E-1 EVENT COLLECTOR COMPLETE:                      YES
P1E-1 TRANSACTIONAL DISPATCH COMPLETE:                YES
P1E-1 UOW FOUNDATION COMPLETE:                        YES
P1E-1 SALES/KITCHEN CONTRACT FOUNDATION COMPLETE:     YES
P1E-1 OVERALL COMPLETE:                               YES
```

All five hold for the SCOPE this slice claims — infrastructure, contracts, and their verification — not for the system-wide adoption §O explicitly marks as still PARTIAL/NOT IMPLEMENTED. No business event is published; no Fire, Kitchen persistence, Payment, or outbox exists; the 21 pre-existing module-boundary deviations are untouched in count.

---

## Q. NEXT SINGLE HIGHEST-LEVERAGE SLICE

## → **B. KDS routing semantics/governance closure**

Not Fire, and not a repeat of "build more infrastructure."

**Why not C (Fire + Ticket) again:** Fire is now blocked on exactly one fewer prerequisite than before (§5.5.2's mechanism exists), but it is still blocked on two others the prior gate report identified and this slice deliberately left untouched: (1) **FR-KDS-010's routing semantics** — 3 of 5 tiers have no storage, and 2 of the tiers that do have storage carry undecided semantics (modifier replace-vs-augment; item-vs-variant scope; which category supplies a multi-category item's default); (2) **Fire authorization** — §15.2 has no fire/send permission code, and Appendix C (which §15.2 designates authoritative) does not exist in the SRS document. Building Fire now means silently deciding at least one of these, which the standing instruction set for this whole engagement forbids.

**Why B over the Fire-authorization decision (E) or another infrastructure slice:** E is a **governance decision**, not an implementation slice — the packet is fully written in the prior gate report's §G and needs a ratification, not code. Another infrastructure slice (e.g., migrating existing services onto `UnitOfWork`) has no source requirement forcing it now and was explicitly out of scope for P1E-1 ("Do not rewrite every service to use the new UoW in this slice" — and nothing has asked to lift that yet).

**What B concretely is:** resolve, as *decisions* (not code), the open questions the prior gate report's §H recorded tier-by-tier:
- Tier 1 (explicit line-level override) — cardinality and storage shape (a child table, given FR-KDS-011 allows one line to route to multiple stations).
- Tier 2 (modifier-driven routing) — does a matching modifier **replace** or **augment** the item/category default, and does `station_routing_rules` gain a `modifier_id` column.
- Tier 3/4 (item/category default) — a discriminator so a row cannot legally set both `menu_item_id` and `category_id` with undefined meaning; an FK from `menu_item_id`/`category_id` into Catalogue (absent today because the approved SQL predates Catalogue); whether routing is scoped to the item or to the specific variant; which category supplies the default when Catalogue's `item_placements` puts an item in more than one.
- Tier 5 (branch fallback) — a storage home: a `fallback_station_id` column on `org.branches`, or a row in `org.settings` (which exists in the approved SQL but not in Prisma/any migration).

**Exact SRS requirements:** FR-KDS-010 (the five-tier precedence itself), FR-KDS-011 (multi-station routing), FR-KDS-001 (Station configuration, including the still-missing `display_colour` column), the §7.3 #24 Station aggregate definition, and the Catalogue `item_placements` many-categories model that creates the Tier-4 ambiguity.

**Dependencies:** none on this slice's own output beyond having somewhere to eventually publish the resolved routing result — which the `order.line.fired` payload this slice defined was deliberately left small enough not to presuppose an answer.

**SOURCE-READY: NO.** Every open question above is explicitly `NOT SOURCE-DECIDABLE` from the SRS text alone (the prior gate report's §H marked each one that way, and this slice's own review of §5.5.4/§5.2.3/§5.4 surfaced nothing new that resolves them). This slice is a **decision-gathering and schema-design** exercise, ending in a design document and, where genuinely uncontested, a migration — not a slice that can proceed purely from source the way P1E-1 could.

**Unresolved decisions:** all five bullet points above, each requiring either a ratified governance decision or an explicit engineering call the user makes knowingly (not one Claude infers).

**What it unlocks:** with routing semantics settled, `order.line.fired`'s payload can be safely extended (additively — this slice's version-1 contract is compatible with that), a Kitchen Ticket schema can be designed against the six conflicts the prior gate's §I catalogued, and Fire itself becomes buildable once the separate Fire-authorization governance decision (§G of that report) is also ratified.

**Not implemented in this run.**

---

## R. COMMIT READINESS

```
COMMIT READY: YES
COMMITTED:    NO
```

1183 tests passing (628 unit + 555 E2E), 0 skipped, 0 todo; TypeScript at the known baseline with no new error; ESLint clean on every new/changed file; Prisma schema unchanged and valid; all 20 migrations apply cleanly from zero on a scratch database; the local dev database was read-only touched (status/count checks) and is verified byte-for-byte unchanged in the facts that matter (78 `price_lists` rows, same 5 unapplied migrations).

Nothing was committed and no destructive git command was used — no `checkout --`, `reset --hard`, `restore`, `clean`, or `stash`. No governance file was read for modification; no `D-21` or later exists anywhere in the repository (re-confirmed by grep). No new dependency was added by this slice (the one `package.json` diff, `canonicalize`, pre-dates this run and is unrelated — confirmed via `git diff`). Nothing from §16/§17's non-goals or do-not-do lists was implemented: no Fire, no Kitchen persistence, no Payment, no outbox, no broker, no new permission, no production migration, no unrelated architecture cleanup.
