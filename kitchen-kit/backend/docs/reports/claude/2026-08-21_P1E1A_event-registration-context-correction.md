# P1E-1A — Production Handler Registration + Trusted Event Context (Acceptance Correction)

**Report type:** Claude Code implementation/design/verification evidence
**Authority:** Non-authoritative evidence; SRS and ratified governance remain authoritative
**Date:** 2026-08-21
**HEAD:** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Branch:** `feat/production-spec`
**Working tree:** accumulated uncommitted P0/P1A–P1E-1 work retained throughout; this run added 7 new files under `src/common/domain-events/`, 1 new `test/*.e2e-spec.ts`, and modified the 4 P1E-1 contract/spec files plus `create-domain-event.ts`/`domain-event.types.ts`/`unit-of-work-context.ts`/`unit-of-work.ts`/`domain-event-dispatcher.ts`/`domain-events.module.ts`/`domain-event-dispatcher.spec.ts`/`test/domain-events.e2e-spec.ts` (see §K) — no commit made
**Claude task:** P1E-1A — correct two P1E-1 acceptance defects (production handler registration; trusted event context), plus the directly-necessary contract representation correction (network-ready envelope timestamps and `businessDay`) discovered while doing so. No KDS routing, no Fire, no Payment, no Outbox.

---

## A. STARTING STATE

Re-verified against the repository, not merely re-quoted from `docs/reports/claude/2026-08-21_P1E1_transactional-domain-events-uow-foundation.md`:

| Claim from P1E-1 report | Verified |
|---|---|
| `DomainEventCollector` exists, per-UoW | ✅ unchanged this run |
| `TransactionalDomainEventDispatcher` exists | ✅ present, refactored (§C) |
| `UnitOfWork` wraps `PrismaService.withAuthContext` | ✅ unchanged mechanism, extended (§E) |
| Handlers receive the same `Prisma.TransactionClient` | ✅ still true, re-proven (§G) |
| Rollback/commit proven against real PostgreSQL | ✅ still true, re-proven (§G) plus a SECOND real-DB proof through the DI path (§D) |
| `DOMAIN_EVENT_HANDLERS` token defaulted to `[]` | ✅ confirmed, then REMOVED as dead code once the registry replaced it (§C) |
| No production handler registered anywhere | ✅ still true — no business handler exists; only test-only fixtures exist (§D, §J) |
| E2E tests constructed the dispatcher directly with test handlers, never through Nest registration | ✅ confirmed — this was exactly the gap Correction A closes |
| `createDomainEvent` accepted `tenantId` from its caller | ✅ confirmed — still true at the LOW-LEVEL API (deliberately; see §E), but the production-facing `ctx.createEvent` surface no longer does |

No deviation from the acceptance-status table in the prompt. Additionally verified before touching anything: 20 migrations on disk, unit 628 / E2E 555 / total 1183 all passing (P1E-1's own final counts), TS baseline unchanged (`access-token.service.spec.ts(28,7) TS2322`), local dev DB unchanged (78 `price_lists` rows, 5 unapplied migrations).

---

## B. ACCEPTANCE DEFECTS CONFIRMED

### Defect A — no production-style handler registration path

**Confirmed by reading the code, not assuming it.** `domain-events.module.ts` bound `DOMAIN_EVENT_HANDLERS` to a hardcoded `[]`; nothing in the module graph could add to it without editing that literal. `TransactionalDomainEventDispatcher`'s only consumer of a non-empty handler set was `new TransactionalDomainEventDispatcher([testHandler])`, called directly inside test files — never through `app.get(...)`. There was no mechanism by which a bounded-context module could contribute a handler during its own composition without either (a) `AppModule` importing the handler class directly, or (b) editing the shared infrastructure's handler list by hand — both of which the correction prompt explicitly forbids, and (b) is also what "Do not edit the dispatcher every time a subscriber is added" rules out.

### Defect B — event context was caller-supplied, not UoW-trusted

**Confirmed.** `CreateDomainEventInput` (and therefore `createDomainEvent()`) accepted `tenantId` as an ordinary field the caller filled in like any other — nothing compared it against the `AuthScope` the enclosing `UnitOfWork.execute(scope, …)` call was opened with. A business publisher inside a tenant-A Unit of Work could, by a copy-paste bug, construct an envelope claiming tenant B, and nothing in the type system or the runtime would catch it. "tenantId/branchId are required caller inputs" (the P1E-1 report's phrasing) is true but does not establish that the value is TRUSTED — a required field can still be wrong.

### Directly-necessary correction found while fixing the above — network-ready envelope

While re-reading §5.1 (driver 7: "Any module must be extractable later" → "in-process message bus with a network-ready contract") to decide how `ctx.createEvent` should be typed, it became clear the P1E-1 envelope did not actually meet that driver: `occurredAt`/`recordedAt` were typed `Date` (an in-process-only value with no defined wire representation), and `businessDay` in both contract payloads was also `Date` despite being a DATE-ONLY key with an existing, established `YYYY-MM-DD` wire convention already used everywhere else in this codebase. This is corrected in §F. It is "directly necessary" rather than scope creep because `ctx.createEvent`'s whole purpose is to be the trusted PUBLIC construction surface — getting its output contract wrong at the same moment it is being hardened for trust would just relocate the defect.

---

## C. HANDLER REGISTRATION DESIGN

**Mechanism: decorator + `DiscoveryService`-based bootstrap scan**, the same officially-supported `@publicApi` pattern `@nestjs/schedule`'s `@Cron` and similar Nest ecosystem discovery-based decorators use — not a bespoke reflection scheme.

```
src/common/domain-events/
  domain-event-handler.decorator.ts   DomainEventHandler = DiscoveryService.createDecorator<string>()
  domain-event-handler.types.ts       TransactionalDomainEventHandlerImplementation (handle only)
                                       TransactionalDomainEventHandler (+ eventType, dispatcher-facing)
  domain-event-handler-source.ts      DomainEventHandlerSource interface
                                       StaticDomainEventHandlerSource (manual/test path)
  domain-event-handler-registry.service.ts   DomainEventHandlerRegistry (production path)
```

A bounded-context module declares a PRIVATE provider:

```ts
@Injectable()
@DomainEventHandler('order.line.fired')
class SomeKitchenHandler {
  handle(event, ctx: UnitOfWorkContext): Promise<void> { ... }
}
```

...in its OWN `providers` array. Nothing else references the class. `DomainEventHandlerRegistry.onModuleInit()` scans the ENTIRE Nest module graph via `DiscoveryService.getProviders({ metadataKey: DomainEventHandler.KEY })` — which finds this provider regardless of whether its module was ever imported into `DomainEventsModule`, because Nest's `DiscoveryService` reads the whole `ModulesContainer`, not just modules reachable from the caller. This is exactly the property that satisfies every constraint in §5A of the prompt:

- **Sales publishes only the contract** (`modules/sales/contract/events.ts`) — it never imports Kitchen, and nothing in this correction changes that.
- **Kitchen's handler stays private** — never exported, never imported by anyone, discovered purely by metadata.
- **`common/domain-events` imports neither Sales nor Kitchen** — `grep -rn "from '.*modules/sales\|from '.*modules/kitchen'" src/common/domain-events/` returns nothing.
- **No AppModule edit is required to add a subscriber** — a future Kitchen module just needs to be imported into `AppModule` for ANY reason it would need anyway (e.g. eventually exposing its own controller); its handler is found automatically the moment it is a provider anywhere in the graph.
- **No dispatcher edit is required per subscriber** — `TransactionalDomainEventDispatcher` never changed to accommodate a new handler; it only ever asks its `DomainEventHandlerSource` for `handlersFor(eventType)`.

**§5C — registry lifetime.** `DomainEventHandlerRegistry` is `@Injectable()` (application-global, via `DomainEventsModule`'s providers), but its handler list is built EXACTLY ONCE in `onModuleInit()` and never mutated again — `Object.freeze`d before assignment. This is explicitly what the prompt permits ("A singleton handler registry is acceptable if it contains only immutable/stable handler registrations after bootstrap"). `DomainEventCollector` (the EVENT QUEUE) is unaffected by this correction and remains a fresh instance per `UnitOfWork.execute()` call, as it was in P1E-1 — the two are unrelated and were not conflated.

**§5D — ordering.** Nest's own `DiscoveryService.getProviders()` order is an internal implementation detail this registry does not lean on. Every discovered handler is sorted by its provider's CLASS NAME (`localeCompare`) before being frozen into the list — proven in `domain-event-handler-registry.spec.ts`'s dedicated ordering test, which deliberately registers a `ZzzHandler` before an `AaaHandler` and asserts `Aaa` still fires first. **ENGINEERING IMPLEMENTATION CHOICE** — the SRS specifies no handler order; this is documented as such in the registry's own docblock, and no test anywhere asserts that ordering has BUSINESS meaning.

**Manual/test path preserved.** `StaticDomainEventHandlerSource` (an explicit array wrapper) plus `TransactionalDomainEventDispatcher.withHandlers([...])` (a static convenience factory) remain available for direct construction — used by P1E-1's own mechanism-proof e2e suite and by every unit test in this directory. The dispatcher itself is agnostic to which `DomainEventHandlerSource` it is given; production wiring (`DomainEventsModule`) supplies the registry, tests may supply either.

---

## D. NEST PRODUCTION-WIRING PROOF

`test/domain-events-registration.e2e-spec.ts` — real PostgreSQL, real Nest container, **no manual dispatcher construction anywhere in the test bodies**.

- `TestRegistrationModule`, a genuinely separate `@Module({...})` with four `@DomainEventHandler`-decorated providers (`CommitProofHandler`, `MultiProofHandlerAlpha`, `MultiProofHandlerBeta`, `FailingProofHandler`) plus a shared `TestRegistrationRecorder`, is imported ALONGSIDE `AppModule` in `Test.createTestingModule({ imports: [AppModule, TestRegistrationModule] })` — never INTO `AppModule`. `AppModule` itself is untouched by this suite.
- `uow = app.get(UnitOfWork)` — resolved through the real Nest container. No test in this file ever calls `new UnitOfWork(...)` or `new TransactionalDomainEventDispatcher(...)`.
- The publisher code in every test knows only an event TYPE STRING (`REGISTRATION_COMMIT_EVENT` etc.) — never a handler class — mirroring exactly how a real Sales producer would only import `ORDER_LINE_FIRED_EVENT_TYPE` from `modules/sales/contract`.

Three tests, covering all eight required properties (§11.A):

1. **Registration/discovery/invocation (items 1–3):** the publisher writes a row, records an event by TYPE only; `CommitProofHandler` — reached purely by discovery — fires and writes its own row on the SAME transaction. Both rows exist after commit.
2. **Multiple handlers + isolation (items 4–6):** both `MultiProofHandlerAlpha` and `MultiProofHandlerBeta` are registered for `REGISTRATION_MULTI_EVENT`; both fire exactly once, in the deterministic `Alpha, Beta` order (alphabetical, per §5D); `CommitProofHandler`/`FailingProofHandler` (registered for OTHER event types) never fire for this event.
3. **Failure propagation + real rollback through the DI path (items 7–8):** `FailingProofHandler` writes its own row, THEN throws; `uow.execute(...)` rejects with the exact error; afterward NEITHER the publisher's row nor the subscriber's row exists in the database — proving rollback holds not just for the manually-constructed P1E-1 mechanism proof, but for a handler reached through the actual production registration path.

Verified against real PostgreSQL on a from-zero scratch database (§J) — **3/3 passing**.

---

## E. TRUSTED EVENT CONTEXT

**What was inspected before choosing a shape**, per the prompt's explicit requirement:

- `AuthScope` (`prisma.service.ts`): `{ userId?: string; tenantId?: string }`. Nothing more. This is the ONLY thing `UnitOfWork.execute(scope, fn)` receives about who/what is running.
- `withAuthContext`: confirms `tenantId` (and `userId`) are what actually get fed into the RLS-consumed `SET LOCAL` — i.e. `AuthScope.tenantId` genuinely IS the trusted tenant for the transaction the Unit of Work is running inside.
- JWT/POS session context (`current-principal.decorator.ts`, `pos-session.decorator.ts`): exist, and DO carry actor/device identity — but only at the HTTP layer. A generic `UnitOfWork`/`AuthScope` has no access to them, and giving it access would make `common/domain-events` depend on `identity`, which is a cross-module dependency this infrastructure must not acquire.
- Correlation-id infrastructure: `AuditEvent.correlationId?: string` exists on `AuditService`, but grep confirms **no caller anywhere in `src/modules/**` ever supplies one** — `AuditService.record` always falls back to `event.correlationId ?? newId()`. There is no propagated correlation chain to reuse; there is exactly one existing precedent (a self-fallback), which is what is reused.
- Idempotency context (`common/idempotency/`): HTTP-layer, deduplicates an HTTP operation via `Idempotency-Key`. Conceptually distinct from an event's `idempotencyKey`, which (per ADR-006) deduplicates AT-LEAST-ONCE EVENT delivery. Reusing one for the other is a plausible future design choice, not something this correction decides.
- Audit actor context (`AuditActorType`): `'user' | 'anonymous' | 'system' | 'terminal'` — confirmed (again) to differ from the SRS envelope's `'user' | 'system' | 'device'`, so it is not reused as a source of `actorType` either; unifying the two vocabularies is unrelated to this correction and not decided here.

**Design — `ctx.createEvent`, the ONLY change to the public construction surface.** `UnitOfWorkContext` gained one field:

```ts
createEvent: (input: TrustedDomainEventInput<TType, TPayload>) => DomainEventEnvelope<TType, TPayload>
```

`TrustedDomainEventInput` = `Omit<CreateDomainEventInput<TType, TPayload>, 'tenantId' | 'correlationId'> & { correlationId?: string }`.

### §6A — tenantId: impossible by API shape, not by convention

`tenantId` does not exist as a key in `TrustedDomainEventInput` at all — a caller cannot even express it in a well-typed object literal (TypeScript's excess-property check on object literals rejects it outright). The IMPLEMENTATION additionally never reads `tenantId` off the caller's `input` object under any circumstance — `unit-of-work.ts`'s `createEvent` closure does `createDomainEvent({ ...input, correlationId: ..., tenantId: scope.tenantId })`, spreading `input` FIRST and overwriting `tenantId` LAST. This means even a caller that defeats the type system entirely (`as unknown as TrustedDomainEventInput<...>` with a `tenantId` key smuggled in) cannot make a foreign value survive — there is no code path that would read it. **Proven, not merely typed:** `unit-of-work.spec.ts` test 10 constructs exactly that adversarial input (`tenantId: 'tenant-B'` inside a UoW opened with `tenantId: 'tenant-A'`) and asserts the resulting envelope's `tenantId` is `'tenant-A'`. If `scope.tenantId` is itself absent, `createEvent` throws (`/requires a tenantId/`) rather than emit an event with an empty or fabricated tenant — proven by a dedicated test — while a tenant-less `UnitOfWork.execute` that never calls `createEvent` still runs fine (also tested), so this does not foreclose a future tenant-less system UoW that has no reason to publish events.

### §6B — branchId: honestly reported as UNVERIFIED, not invented

`AuthScope` carries no branch concept whatsoever, and this repository's RLS scopes by TENANT, not branch — branch scoping is an application-layer concern each service currently derives its own way (`CashSessionsService.open` takes it from `terminal.branchId`, never from a request body, as the concrete precedent). Per the explicit instruction "Do NOT invent a generic branch context if AuthScope does not contain one," none was invented. `branchId` remains a REQUIRED but UNVERIFIED field on `ctx.createEvent`'s input — the docblock on `unit-of-work.ts` states plainly that a future Fire implementation must source it the same way `CashSessionsService` does (a trusted, branch-scoped domain entity resolved inside the same transaction), never from arbitrary caller input, and that this is **NOT SOURCE-DECIDABLE** beyond that statement.

### §6C — actorId / actorType / correlationId / idempotencyKey

- **actorId / actorType** — NOT in `AuthScope`; the only richer actor context (`current-principal`/`pos-session` decorators) lives at the HTTP layer, which a generic Unit of Work must not depend on (that would be a `common` → `identity` dependency). Left required and UNVERIFIED, with the same "future producer must pass its own already-trusted values" documentation, citing `CashSessionsService.open`'s `actorUserId`/`employeeId`/`terminalId` pattern as the existing precedent for how that should look.
- **correlationId** — made OPTIONAL and, when omitted, defaulted to a fresh `newId()` — reusing `AuditService.record`'s own one-line existing precedent (`event.correlationId ?? newId()`) rather than inventing a new mechanism. Proven: two calls omitting `correlationId` produce two DIFFERENT ULID-shaped values (`unit-of-work.spec.ts`); a caller-supplied value is preserved verbatim, never overridden.
- **idempotencyKey** — deliberately NOT given the same treatment. An idempotency key's entire purpose is caller-supplied determinism; a framework-generated random value on every call would make the field inert, and it is not the same key as the HTTP layer's `Idempotency-Key` (different deduplication scope — see above). Stays required, unverified, never fabricated.
- **§14 proof that nothing is fabricated:** `unit-of-work.spec.ts`'s final test constructs a `TrustedDomainEventInput` literal missing `idempotencyKey` under `// @ts-expect-error` — proving the omission is a COMPILE ERROR, the strongest available guarantee that this field (and `branchId`/`actorId`/`actorType` alongside it) is never silently defaulted.

No second request-context framework was created. No governance was silently changed by any of this — `causationId`'s nullable-for-root-events treatment is unchanged from P1E-1 and remains **ENGINEERING IMPLEMENTATION CHOICE, NOT SOURCE-DECIDABLE**.

---

## F. EVENT ENVELOPE / NETWORK-READY CONTRACT

Audited against SRS §5.1 driver 7 ("in-process message bus with a network-ready contract") and §5.2.4's extraction path (step 2: "Replace the in-process event bus binding … with a network transport" — implying the CONTRACT does not change shape at extraction, only the transport binding does).

| Field | P1E-1 | P1E-1A | Classification |
|---|---|---|---|
| `occurredAt` | `Date` | `string` (ISO-8601) | **SOURCE-REQUIRED** — driver 7 + §5.5.4's own JSON example (`"occurredAt": "2026-08-04T11:02:33.412Z"`), corroborated by the repository's established `.toISOString()` convention at every existing serialization boundary (e.g. `cash-sessions.service.ts` audit metadata) |
| `recordedAt` | `Date` | `string` (ISO-8601) | Same as above |
| `businessDay` (both payloads) | `Date` | `string` (`YYYY-MM-DD`) | **SOURCE-REQUIRED** for the same driver-7 reason; the EXACT format is an **ENGINEERING CHOICE** — but not a new one: it reuses the repository's own established convention (`orders.controller.ts`'s `parseBusinessDay`; the repeated `businessDay.toISOString().slice(0, 10)` pattern in `orders.service.ts`, `sales.views.ts`, `order-lines.service.ts`) rather than inventing a new one |
| `eventId` | ULID via `newId()` | unchanged | Confirmed still ULID-shaped; `UUID_PATTERN`-matching, re-asserted in `unit-of-work.spec.ts` |
| Nullable values (`causationId`) | `string \| null` | unchanged | Still **ENGINEERING CHOICE**, not source-decided |

`CreateDomainEventInput.occurredAt` (the low-level constructor's INPUT) deliberately stayed `Date` — ergonomic construction matching how every other in-process value in this codebase is handled; only the ENVELOPE itself (the actual public/network contract) changed. `createDomainEvent()` converts at the one point where the two meet (`.toISOString()`).

**No serialization adapter or network transport was built** — per instruction. The correction is limited to the CONTRACT'S TYPE, proven via `JSON.stringify`/`JSON.parse` round-tripping cleanly in `sales/contract/events.spec.ts` (an object containing a native `Date` would not round-trip predictably without an explicit reviver; an ISO string does, by construction).

---

## G. TRANSACTION / ROLLBACK EVIDENCE

P1E-1's own real-PostgreSQL rollback/commit proof (`test/domain-events.e2e-spec.ts`, 5 tests) was **re-run unmodified in substance** — only its dispatcher-construction call sites were updated from `new TransactionalDomainEventDispatcher([handler])` to `TransactionalDomainEventDispatcher.withHandlers([handler])` (the same manual/test construction path, now expressed through the new `DomainEventHandlerSource` abstraction rather than a removed constructor overload) — and **all 5 still pass** against a from-zero scratch database.

Correction A adds a SECOND, independent rollback proof through the production DI path (§D, test 3: "handler failure through the DI-resolved path propagates and rolls back BOTH the publisher and subscriber writes in real PostgreSQL") — because P1E-1's proof alone did not establish that a handler reached through `DomainEventHandlerRegistry`/Nest discovery behaves identically to a manually-supplied one. It does: both rows are confirmed absent (via the migrator/superuser connection, never the app connection, exactly as P1E-1's pattern established) after the rejected `uow.execute(...)` call.

No change was made to `PrismaService.withAuthContext`, to the `$transaction` boundary, or to when `dispatcher.drain()` is called relative to that boundary — the atomicity guarantee established in P1E-1 is structurally untouched; only WHO supplies the handlers and HOW the envelope is constructed changed.

---

## H. MODULE BOUNDARIES

No new cross-module import was introduced by this correction. `grep -rn "from '.*modules/" src/common/domain-events/**/*.ts` returns nothing — the new handler-registration files (`domain-event-handler.decorator.ts`, `domain-event-handler-source.ts`, `domain-event-handler.types.ts`, `domain-event-handler-registry.service.ts`) import only `@nestjs/common`, `@nestjs/core`, and sibling files within `common/domain-events/`.

`module-boundaries.spec.ts` was **not modified** by this correction (P1E-1 already added its Sales/Kitchen contract-existence assertions; nothing here required extending it) — re-run and confirmed **still 7/7 passing**, `KNOWN_DEVIATIONS` unchanged, zero new entries.

`TestRegistrationModule` (`test/domain-events-registration.e2e-spec.ts`) is a TEST-ONLY module living entirely inside a `.e2e-spec.ts` file, outside `src/modules/`, so it is not and cannot be a module-boundary violation, and `module-boundaries.spec.ts`'s static scan (which walks `src/modules/`) does not and should not see it.

---

## I. TESTS

No skipped, no todo, anywhere in this correction.

**Unit — new (25 tests across 2 new files):**
- `domain-event-handler-registry.spec.ts` (7): discovers a decorated provider; ignores an undecorated one; unrelated event types return nothing; multiple decorated providers for one event type all register; registration order is deterministic regardless of declaration order (the `Zzz`-before-`Aaa` proof); a handler fires only for its own event type; **throws at bootstrap** if a decorated provider has no `handle()` method.
- `unit-of-work.spec.ts` (7, no DB — pure logic, using a fake `PrismaService`): an event created in a tenant-A UoW carries tenant A; a caller cannot substitute tenant B even via a type-system bypass; `createEvent` throws rather than fabricate a tenantId when the UoW has none; a tenant-less UoW may still run business logic that never calls `createEvent`; `correlationId` defaults to a fresh, distinct ULID per call when omitted; a caller-supplied `correlationId` is preserved verbatim; the compile-time proof that `branchId`/`actorId`/`actorType`/`idempotencyKey` are never fabricated (`@ts-expect-error` on omission).

**Unit — modified:**
- `domain-event-dispatcher.spec.ts` (11, unchanged count, updated construction/context shape): all `new TransactionalDomainEventDispatcher([...])` calls replaced with `.withHandlers([...])`; `makeCtx()` gained a `createEvent` stub to satisfy the extended `UnitOfWorkContext` shape.
- `sales/contract/events.spec.ts` (6, was 4, **+2**): added "envelope timestamps are network-ready ISO-8601 strings, not Date instances" (including a `JSON.stringify`/`JSON.parse` round-trip proof) and "businessDay is a date-only YYYY-MM-DD string, not an instant."
- `kitchen/contract/events.spec.ts` (6, was 4, **+2**): the symmetric two tests.

**E2E — new (3 tests, real PostgreSQL, via `test/domain-events-registration.e2e-spec.ts`):** covered in full in §D.

**E2E — modified:** `test/domain-events.e2e-spec.ts` (5, unchanged count) — construction calls updated to `.withHandlers(...)`; docblock updated to explain the split between "mechanism proof" (this file) and "production-wiring proof" (the new file).

**Contract checks (§11.C, items 15–20):**

| # | Check | Result |
|---|---|---|
| 15 | mandatory `actorType` field exists | ✅ present in `DomainEventEnvelope`, unchanged; re-confirmed the P1E-1 report's own prose once rendered it merged with `actorId` — the TYPE was always correct; verified again here |
| 16 | `eventId` remains ULID | ✅ `UUID_PATTERN`-matching, asserted in `unit-of-work.spec.ts` |
| 17 | `businessDay` representation is timezone-safe/date-only | ✅ `string` matching `/^\d{4}-\d{2}-\d{2}$/`, asserted in both contract spec files |
| 18 | public contracts remain free of `any` | ✅ `tsc --noEmit` clean; `module-boundaries.spec.ts`'s existing any-regex check (`:\s*any\b\|<any>\|\bas any\b`) still passes for both contract files |
| 19 | no cross-module private imports | ✅ (§H) |
| 20 | no new `KNOWN_DEVIATIONS` | ✅ (§H) |

**Regression / scope (§11.D, items 21–29) — grep + full-suite execution:**

| # | Check | Result |
|---|---|---|
| 21 | no Fire route | clean — only the pre-existing docblock note that it is absent |
| 22 | no Kitchen persistence | clean — no new Prisma model, no new table |
| 23 | no Payment | clean — the two matches are the same pre-existing docblock comments from before this run |
| 24 | no Outbox | clean |
| 25 | no new permission | clean |
| 26 | no production event producer | clean — `ORDER_LINE_FIRED_EVENT_TYPE`/`TICKET_BUMPED_EVENT_TYPE` referenced only inside their own `contract/` files (definition) and their own `.spec.ts` files (tests) |
| 27 | full P1E-1 transactional tests remain green | ✅ 5/5 (§G) |
| 28 | P1D CashSession regression remains green | ✅ included in the 146/146 run (§J) |
| 29 | P1C Sales line regression remains green | ✅ same run |

---

## J. DATABASE / MIGRATION VERIFICATION

**No production migration was created or is needed.** No event table, handler table, registry table, or outbox table exists or was added — `git status --short prisma/migrations/` shows the same 6 pre-existing untracked migration directories as before this correction, zero new.

A fresh scratch database (`ros_p1e1a_scratch`) was used for every real-DB verification, exactly as P1E-1 and the P1D-1 gate did before it — the local dev DB (`ros`) remains genuinely 5 migrations behind and was never pointed at by any test in this correction, only read (`migrate status`, a row count) before and after.

| Command | Result |
|---|---|
| `npx prisma format` | no-op (schema untouched) |
| `npx prisma validate` | ✅ valid |
| `npx prisma generate` | ✅ Prisma Client 7.9.1 |
| Scratch DB, 20 migrations from zero | ✅ "All migrations have been successfully applied" |
| Scratch DB `migrate status` | ✅ "Database schema is up to date!" |
| Focused domain-events E2E (mechanism + registration) | ✅ **8/8** |
| CashSession + Sales + Sales-lines + domain-events E2E | ✅ **146/146** (138 pre-existing + 5 P1E-1 mechanism + 3 P1E-1A registration) |
| Full unit suite | ✅ **646/646**, 49 suites (628 → 646, **+18**: 7 registry + 7 UoW + 2 sales contract + 2 kitchen contract) |
| Full E2E, scratch DB, `--runInBand` | ✅ **558/558**, 26 suites (555 → 558, **+3**, the new registration spec) |
| **TOTAL** | **1204 passing** (1183 → 1204, **+21**), 0 skipped, 0 todo |
| `npx eslint` on all new/changed files | ✅ clean (multiple `require-await`/prettier/`no-unsafe-*` issues found and fixed during this run — see below) |
| `npx tsc --noEmit` | exactly the pre-existing baseline `access-token.service.spec.ts(28,7) TS2322` — **no new error** |
| `npx prisma migrate status` against the real dev DB, before vs. after | ✅ identical — same 5 migrations still unapplied |
| `catalogue.price_lists` row count, before vs. after | ✅ **78, unchanged** |
| `package.json`/`package-lock.json` diff | unchanged from before this run (`canonicalize`, pre-existing and unrelated) — **no new dependency added** |

Lint issues found and fixed during this run, for transparency: several fixture `handle()` methods declared `async` with no `await` inside (fixed by dropping `async` and returning `Promise.resolve()` explicitly); `Function.prototype.bind`/`.call()` on a narrowed method type lost type information under this TS configuration, requiring an explicit `as Promise<void>` cast at the one point `DomainEventHandlerRegistry` re-wraps a discovered instance method (`domain-event-handler-registry.service.ts`); an `import type` was required for `DomainEventHandlerSource` in `domain-event-dispatcher.ts` because `emitDecoratorMetadata` + `isolatedModules` cannot otherwise determine a decorated class's constructor-parameter type is type-only.

---

## K. FILES CHANGED

**New**

```
src/common/domain-events/domain-event-handler.decorator.ts
src/common/domain-events/domain-event-handler.types.ts
src/common/domain-events/domain-event-handler-source.ts
src/common/domain-events/domain-event-handler-registry.service.ts
src/common/domain-events/domain-event-handler-registry.spec.ts
src/common/domain-events/unit-of-work.spec.ts
test/domain-events-registration.e2e-spec.ts
docs/reports/claude/2026-08-21_P1E1A_event-registration-context-correction.md
```

**Modified**

```
src/common/domain-events/domain-event.types.ts        — occurredAt/recordedAt: Date -> string
src/common/domain-events/create-domain-event.ts        — .toISOString() at construction
src/common/domain-events/unit-of-work-context.ts       — + TrustedDomainEventInput, + createEvent field
src/common/domain-events/unit-of-work.ts                — + trust-bound createEvent implementation
src/common/domain-events/domain-event-dispatcher.ts    — reads a DomainEventHandlerSource; + withHandlers(); DOMAIN_EVENT_HANDLERS removed
src/common/domain-events/domain-events.module.ts        — + DiscoveryModule; dispatcher wired via registry factory
src/common/domain-events/domain-event-dispatcher.spec.ts — construction calls updated; makeCtx() gained createEvent
src/modules/sales/contract/events.ts                    — businessDay: Date -> string (YYYY-MM-DD)
src/modules/sales/contract/events.spec.ts                — +2 tests
src/modules/kitchen/contract/events.ts                   — businessDay: Date -> string (YYYY-MM-DD)
src/modules/kitchen/contract/events.spec.ts               — +2 tests
test/domain-events.e2e-spec.ts                           — construction calls updated; docblock updated
docs/reports/claude/INDEX.md                              — +1 row (this report)
```

**Untouched:** `prisma/schema.prisma`, every migration, every governance document, `module-boundaries.spec.ts`, `app.module.ts` (already wired in P1E-1, not re-touched), `sales.permissions.ts`, `treasury.permissions.ts`, `orders.controller.ts`, `orders.service.ts`, `cash-sessions.service.ts`, `treasury.controller.ts`, `workforce/contract/`, the local dev DB.

---

## L. REQUIREMENT CLASSIFICATION

**§5.2.3 module-boundary compliance: PARTIAL** — unchanged from P1E-1. This correction adds zero new violations and repairs none of the 21 pre-existing ones; that was never its scope.

**§5.4 module contracts: PARTIAL** — unchanged. Still Workforce, Sales, Kitchen only.

**§5.5.2 transaction-aware domain-event mechanism: infrastructure COMPLETE (upgraded from P1E-1's classification); system-wide adoption still NOT IMPLEMENTED.** P1E-1 already called the raw mechanism infrastructure-complete; this correction closes the two gaps that made that claim premature — production registration now has a real, proven path through the actual Nest container (not just `new`), and the event context is now bound to trusted UoW state rather than merely "required." No business producer exists; `order.line.fired` and `ticket.bumped` remain unpublished by anything.

**§5.1 driver 7 (network-ready contract): now genuinely met by the envelope TYPE** — `occurredAt`/`recordedAt`/`businessDay` are wire-safe strings. **Not fully realized as a system property** — no adapter, serializer, or actual network transport exists, and none was built (correctly, per instruction). The contract's SHAPE is now ready for that future step; nothing exercises it yet.

**§5.5.3 transactional outbox: NOT IMPLEMENTED** — unaffected by this correction, as instructed.

**§5.5.4 event catalogue: PARTIAL** — unchanged; still two of twelve-plus events have typed contracts, none are published.

**ADR-006:** unchanged from P1E-1's classification — in-process half now has a REAL production registration path in addition to the transaction mechanism; outbox half untouched.

**Fire: NOT IMPLEMENTED.** **FR-KDS-010: PARTIAL**, unchanged. **Payment: NOT IMPLEMENTED.** None of the three was touched by this correction.

---

## M. P1E-1A EXIT

```
P1E-1A PRODUCTION HANDLER REGISTRATION COMPLETE: YES
P1E-1A TRUSTED EVENT CONTEXT COMPLETE:            YES
P1E-1A NETWORK-READY CONTRACT CHECK COMPLETE:     YES
P1E-1A OVERALL COMPLETE:                          YES
```

Each holds for the SCOPE this correction claims: a real, DI-proven production registration path (§D); tenantId trust-bound by API shape and proven unforgeable, with `branchId`/`actorId`/`actorType`/`idempotencyKey` honestly reported as unverified rather than falsely bound (§E); the envelope's timestamp and date-only fields brought into line with SRS §5.1 driver 7 (§F). System-wide adoption of any of this remains PARTIAL/NOT IMPLEMENTED, as §L states explicitly — this correction does not and must not be read as closing that.

---

## N. P1E-1 CORRECTED ACCEPTANCE

```
P1E-1 ACCEPTED AFTER CORRECTION: YES
```

The two defects the acceptance review found are closed with evidence, not by narrowing the claim: production registration is proven through the real Nest container against real PostgreSQL, not merely `new`; event context is now bound to the trusted Unit-of-Work scope, with every field that CAN be trust-derived from `AuthScope` actually being derived, and every field that CANNOT be (because `AuthScope`/the current runtime genuinely does not carry it) honestly left required-and-unverified rather than faked. §5.5.2's SYSTEM-WIDE adoption is explicitly **NOT** claimed COMPLETE anywhere in this report — only the infrastructure is, and that distinction is preserved throughout §L.

---

## O. NEXT SINGLE HIGHEST-LEVERAGE SLICE

## → **KDS ROUTING SEMANTICS / GOVERNANCE CLOSURE**

This is the expected candidate the correction prompt named, and re-evaluating from current evidence confirms it, not by default but because nothing about this correction changed the reasoning the P1E-1 report's own §Q gave:

**WHY NOW.** Fire is now blocked on ONE fewer prerequisite than before P1E-1 (§5.5.2's mechanism, including a real production registration path and a trust-bound context, now exists and is proven). It remains blocked on exactly the same two things P1E-1's exit report identified and this correction did not touch: (1) **FR-KDS-010's routing semantics** — 3 of 5 tiers have no storage, and the 2 that do carry undecided semantics (modifier replace-vs-augment; item-vs-variant scope; multi-category default resolution); (2) **Fire authorization** — no fire/send permission code exists in §15.2, and Appendix C (which §15.2 designates authoritative) does not exist in the SRS document. Building Fire now would still require silently deciding at least one of these — exactly what every prior instruction in this engagement has forbidden.

**Exact SRS requirements:** FR-KDS-010 (five-tier precedence), FR-KDS-011 (multi-station routing), FR-KDS-001 (Station configuration, including the still-missing `display_colour` column), §7.3 #24 (Station aggregate), and Catalogue's `item_placements` many-categories model (source of the Tier-4 ambiguity).

**Dependencies:** none on this correction's own output. The `order.line.fired` payload P1E-1 defined (and this correction only changed the WIRE TYPE of, not the field set) was deliberately kept minimal enough not to presuppose a routing answer, so it needs no rework once routing is decided — it needs extension, additively.

**SOURCE-READY: NO.** Every open question above is explicitly `NOT SOURCE-DECIDABLE` from the SRS text alone — this was true before P1E-1, remained true after P1E-1, and is unaffected by this correction. It is a decision-gathering and schema-design exercise requiring either ratified governance or an explicit, knowing engineering call from the user — not something derivable purely from source the way P1E-1/P1E-1A's infrastructure was.

**Unresolved decisions:** the five bullet points enumerated in the P1E-1 report's own §Q (Tier 1 storage shape; Tier 2 replace-vs-augment + `modifier_id` column; Tier 3/4 discriminator + Catalogue FK + item-vs-variant scope + multi-category default; Tier 5 storage home). None are resolved or narrowed by this correction.

**What it unlocks:** a safely extensible `order.line.fired` payload; a Kitchen Ticket schema design against the six conflicts the P1D-1/P1E gate report's §I catalogued; and, together with the separate Fire-authorization governance decision (that same report's §G), an eventually buildable Fire slice.

**Not implemented in this run.**

---

## P. COMMIT READINESS

```
COMMIT READY: YES
COMMITTED:    NO
```

1204 tests passing (646 unit + 558 E2E), 0 skipped, 0 todo; TypeScript at the known baseline with no new error; ESLint clean on every new/changed file; Prisma schema unchanged and valid; all 20 migrations apply cleanly from zero on a scratch database; the local dev database was read-only touched (status/count checks) and is verified unchanged (78 `price_lists` rows, same 5 unapplied migrations).

Nothing was committed and no destructive git command was used. No governance file was modified; no `D-21` or later exists anywhere (re-confirmed by grep). No new dependency was added. Nothing from the non-goals/do-not-do lists was implemented: no Fire, no `pos.order.fire`, no broadened `pos.order.create`, no FR-KDS-010 resolver, no Kitchen Ticket/TicketLine, no Station management, no branch fallback, no modifier routing, no Payment, no Completion, no Outbox, no broker, no external transport, no event persistence, no adoption of the existing business events (`shift.opened`, `recipe.version.published`, etc.), and no cleanup of the 21 pre-existing module-boundary deviations.
