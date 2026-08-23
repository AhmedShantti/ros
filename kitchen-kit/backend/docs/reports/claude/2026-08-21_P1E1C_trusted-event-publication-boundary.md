# P1E-1C — Final Trusted Event Publication Boundary Correction

**Report type:** Claude Code implementation/design/verification evidence
**Authority:** Non-authoritative evidence; SRS and ratified governance remain authoritative
**Date:** 2026-08-21
**HEAD:** `e5648fb03d4ba319a0d7415c72342a278f93e59a`
**Branch:** `feat/production-spec`
**Working tree:** accumulated uncommitted P0/P1A–P1E-1B work retained throughout; this run added 2 new files and modified 9 existing files under `src/common/domain-events/` and `test/` (see §K) — no commit made
**Claude task:** P1E-1C — close the one remaining bypass acceptance review found: `UnitOfWorkContext` still exposed the raw event collector (`ctx.events`), so business code could hand-build a `DomainEventEnvelope` and call `ctx.events.record(...)` directly, skipping `ctx.createEvent`'s entire trust boundary. Replace the two-step construct-then-record API with one authoritative publish operation, and hide the collector from business/handler code both by type and by mechanical enforcement. No KDS routing, no Fire, no Payment, no Outbox.

---

## A. STARTING STATE

Verified against the repository directly, per §2's instruction not to assume the review is correct without inspecting code:

| Fact to verify | Result |
|---|---|
| Exact `UnitOfWorkContext` shape | `{ tx: Prisma.TransactionClient; events: DomainEventCollector; createEvent: TrustedCreateDomainEvent }` — **`events` IS publicly exposed**, confirmed by reading `unit-of-work-context.ts` |
| `DomainEventCollector.record()` signature | `record<TType, TPayload>(event: DomainEventEnvelope<TType, TPayload>): void` — accepts **any** object shaped like the type, no trust check |
| Every production (non-test) importer of `DomainEventCollector` | Only `common/domain-events/` internals (`unit-of-work-context.ts`, `unit-of-work.ts`, `domain-event-collector.ts` itself, `domain-event-handler-registry.service.ts`) — confirmed by `grep -rln "DomainEventCollector" src/`; **nothing under `src/modules/**` imports it today** |
| Every production call to `.events.record(...)` | None under `src/modules/**` today (confirmed by grep) — only test files (`domain-event-dispatcher.spec.ts`, both P1E-1 e2e specs) |
| Is the raw collector reachable from a business module? | **YES, structurally** — even though nothing exploits it today, `ctx.events` was a public field on the type every business callback and handler receives, and `DomainEventCollector.record()` performs no validation. The bypass was REAL, not hypothetical, so §2's "prove it's unreachable and report evidence instead" branch does not apply — the fix proceeds. |

This matches the correction's own framing exactly: the defect is a structural possibility the type system allowed, independent of whether any code currently uses it.

---

## B. BYPASS CONFIRMATION

Concretely, before this correction, business code inside a `UnitOfWork.execute()` callback could do:

```ts
ctx.events.record({
  eventId: 'attacker-chosen',
  eventType: 'x',
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  recordedAt: new Date().toISOString(),
  tenantId: 'tenant-B',        // arbitrary — bypasses P1E-1A's trust binding
  branchId: 'x',
  actorId: 'x',
  actorType: 'system',
  correlationId: 'whatever-i-want',  // bypasses P1E-1B's UoW-scoped binding
  causationId: 'whatever-i-want',
  idempotencyKey: 'x',
  payload: {},
});
```

This compiles and runs — `DomainEventEnvelope` (the type) is legitimately public (Sales/Kitchen contracts must be able to type their events), and TypeScript's structural typing does not care that the object was hand-built rather than produced by `ctx.createEvent()`. Closing `internal/create-domain-event.ts` (P1E-1B, Defect A) did nothing to prevent this — the low-level CONSTRUCTOR was unreachable, but the QUEUE itself, which is where an envelope actually becomes something the dispatcher will act on, remained wide open. **Confirmed as a real defect, not a false alarm.**

---

## C. PUBLIC EVENT PUBLICATION API

**One operation replaces the two-step `createEvent()` + `events.record()` pair: `ctx.publishEvent(input)`.**

```ts
export type TrustedPublishEvent = <TType extends string, TPayload extends object>(
  input: TrustedDomainEventInput<TType, TPayload>,
) => DomainEventEnvelope<TType, TPayload>;

export interface UnitOfWorkContext {
  readonly tx: Prisma.TransactionClient;
  readonly publishEvent: TrustedPublishEvent;
}
```

Internally (`unit-of-work.ts`), `publishEvent`:

1. rejects (throws) if the enclosing UoW has no trusted `tenantId` (unchanged from P1E-1A);
2. constructs the envelope via `internal/create-domain-event.ts`, with `tenantId`/`correlationId` ALWAYS supplied from trusted state, applied LAST (unchanged from P1E-1A/B);
3. **enqueues it into the transaction-scoped collector in the SAME call** (new — this is what removes the intermediate step a caller-built object could be substituted into);
4. returns the constructed envelope, so a caller that needs it (e.g. a handler wanting to point a child event's `causationId` at the parent) has it without a second lookup.

`publishEvent` does **not** dispatch. It only records — dispatch remains exclusively at `UnitOfWork.execute()`'s drain step, after the business callback (and any handler chain it triggers) resolves. Proven explicitly (§K, items 9–10): a handler registered for the published event's type has **not** fired by the time `publishEvent` returns inside the business callback, and only fires after `execute()` itself resolves.

**Naming.** `publishEvent`, not `emitEvent` — per the correction's explicit instruction not to use a name suggesting immediate dispatch. `publishEvent` also matches the SRS's own vocabulary (§5.5.4's catalogue: "Sales — publisher — `order.line.fired`").

---

## D. INTERNAL COLLECTOR BOUNDARY

**Type-level split, plus mechanical enforcement — the same two-layer pattern P1E-1B used for the low-level constructor, applied to the collector.**

```
src/common/domain-events/
  unit-of-work-context.ts                        UnitOfWorkContext { tx, publishEvent }  — PUBLIC
  internal/unit-of-work-internal-context.ts       InternalUnitOfWorkContext extends
                                                   UnitOfWorkContext { events: DomainEventCollector } — INTERNAL
```

`UnitOfWork.execute()` builds ONE runtime object typed as `InternalUnitOfWorkContext` (it needs `.events` to drain after the business callback resolves) and passes that SAME object everywhere — to the business callback and to every handler — but those call sites receive it typed as the narrower `UnitOfWorkContext`. This is not a proxy or a wrapper: it is the identical object at runtime, with the compiler narrowing what each caller is allowed to reference. `TransactionalDomainEventDispatcher.drain()` — infrastructure, not business code — is the one place that still needs and declares `InternalUnitOfWorkContext` explicitly, since it must call `ctx.events.drain()`.

**Mechanical enforcement (§10's four requirements), all in `trusted-construction-boundary.spec.ts`, extended this correction:**

| Requirement | Enforcement |
|---|---|
| A. `src/modules/**` cannot import `DomainEventCollector` | new dedicated check — resolves relative specifiers to the collector file, plus a literal-substring backstop |
| A (cont.). `src/modules/**` cannot import internal construction | unchanged from P1E-1B, re-verified still passing |
| B. `src/modules/**` cannot use a raw `.events.record(...)` path | new — a TEXTUAL scan (`/\.events\.record\(/`) across every non-spec file under `src/modules/**`, independent of how a collector reference might have been obtained, since the act of calling `.record()` is what matters |
| C. business publication goes through the trusted context operation only | the combination of the above two, plus the type-level removal of `.events`/`.createEvent` from `UnitOfWorkContext` itself |
| D. public Sales/Kitchen event TYPES remain importable | unchanged, re-verified: both contract files still import `DomainEventEnvelope` from `domain-event.types`, and neither imports `internal/` or the collector |

Each detector carries a **self-test** proving it actually fires on a violation (a fabricated, non-real source string) — not merely that "no violations" passes vacuously because the scanner silently finds nothing. This mirrors P1E-1B's own self-test pattern exactly, extended to the two new violation kinds.

**No unrelated architecture debt was added.** `module-boundaries.spec.ts` (the separate, pre-existing module-to-module boundary test) is untouched — confirmed both by `git status --short` (still shows as the same untracked, unmodified file) and by its own suite re-passing 7/7 with `KNOWN_DEVIATIONS` unchanged.

---

## E. CORRELATION / CAUSATION REGRESSION

**No redesign — only the call-site rename from `createEvent` to `publishEvent` (and, for the two nested-emission dispatcher tests, from `ctx.events.record(...)` to `ctx.publishEvent(...)`, which is now the only way a handler CAN enqueue a child event).**

All P1E-1B guarantees re-verified, unchanged in substance:

- `tenantId` — trust-bound, unoverridable even via a type-system bypass (`unit-of-work.spec.ts`, re-run).
- `correlationId` — resolved once per `UnitOfWork.execute()` call, shared by every event that call publishes, distinct across separate calls, reusable via inheritance (`UnitOfWorkCausalContext`), still absent from `TrustedDomainEventInput` entirely — a caller cannot express it per-event even by accident.
- `causationId` — required, non-null, defaults to the operation's own `commandId` for a root event, explicitly overridable by a handler wanting `parentEvent.eventId` for a child event. The child-event pattern (§7 of this correction) is now expressed identically to before, just through `ctx.publishEvent({..., causationId: parentEvent.eventId})` instead of a separate `createEvent`+`events.record` pair — and since `publishEvent` still lives on the SAME `UnitOfWorkContext` a handler already receives, **no expansion of what a handler can reach was needed to support this** (§7's explicit constraint: "Do not expose the collector just to support [child events]").

---

## F. HANDLER / DISPATCH REGRESSION

**Preserved exactly, per §11's instruction — "No redesign unless hiding the collector requires a narrow internal-context type change,"** which it did (§D), and nothing else changed:

- `DiscoveryService`-based handler registration (`DomainEventHandlerRegistry`) — untouched.
- Immutable-after-`onModuleInit` registry list — untouched.
- Deterministic (alphabetical-by-class-name) handler traversal — untouched.
- Bounded nested drain (`MAX_DRAIN_ITERATIONS`) — untouched; re-proven still throwing `DomainEventDispatchLimitExceededError` on an unbounded self-emitting handler (now expressed via `ctx.publishEvent(...)` inside the handler, since that is the only path left).
- Same `Prisma.TransactionClient` passed to every handler — untouched (still literally the same runtime object, narrowed only in its static type).
- Handlers awaited sequentially, rejection propagates unchanged — untouched.
- Rollback on handler failure — re-proven, both through the manually-constructed mechanism-proof suite and through the real Nest-DI registration path.

**No production handler was added.** `TestRegistrationModule`'s four fixture handlers remain test-only, never imported by `AppModule`.

---

## G. TENANT / RLS EVIDENCE

**Re-proven exactly as required by §12**, using the SAME real-PostgreSQL suites (with their event-construction call sites updated to `ctx.publishEvent`):

- **tenant-A UoW → `publishEvent()` → envelope tenant A → handler same tx / same RLS context**: `test/domain-events.e2e-spec.ts` test 15, re-run — a handler with no explicit context of its own still sees only the tenant-A row, proving the RLS context set at `withAuthContext` start is what the handler's query (on the identical `tx`) is still bound by.
- **Adversarial proof that application code cannot use the SUPPORTED PUBLIC context API to claim tenant B**: `unit-of-work.spec.ts` test 10 (re-run, unmodified in substance) constructs a `TrustedDomainEventInput` object carrying a smuggled `tenantId: 'tenant-B'` field (via `as unknown as TrustedDomainEventInput<...>`, since the well-typed surface has no such key at all) and asserts the resulting envelope's `tenantId` is still `'tenant-A'`.

No HTTP route, no permission, no RLS migration — none were touched by this correction; the RLS mechanism itself (`PrismaService.withAuthContext`) is byte-for-byte unmodified.

---

## H. ARCHITECTURE ENFORCEMENT

Two independent architecture-test files now guard `common/domain-events`, unchanged in count from P1E-1B but the second one substantially extended:

1. **`module-boundaries.spec.ts`** — module-to-module contract boundaries, `src/modules/**` wide. **Unmodified. 7/7.**
2. **`trusted-construction-boundary.spec.ts`** — the internal-construction AND raw-collector/publication boundary for `common/domain-events` specifically. **Grew from 6 to 10 tests** (§D) — **10/10.**

No third architecture-test file was created; the correction extended the existing, correctly-scoped one rather than adding parallel machinery, per §10's "do not add unrelated architecture debt."

---

## I. TESTS

No skipped, no todo, anywhere in this correction.

| # | Check (§13) | Result |
|---|---|---|
| 1 | public UoW context exposes trusted publication operation | ✅ `unit-of-work.spec.ts`, new |
| 2 | public UoW context does NOT expose raw collector mutation | ✅ new — both a compile-time absence (the type has no `events` key) and a runtime probe on the actual object confirming the collector still exists internally but is unreachable through the typed surface |
| 3 | `publishEvent` constructs + queues one event | ✅ new — a real (fake-Prisma) dispatcher/handler pair confirms exactly one handler invocation per `publishEvent` call |
| 4 | two published events keep one UoW correlation | ✅ re-run (P1E-1B test 5, renamed call site only) |
| 5 | tenant substitution remains impossible | ✅ re-run (test 10) |
| 6 | root causation remains non-null | ✅ re-run (causation describe block, test 9) |
| 7 | child event can use parent eventId as causationId | ✅ re-run (test 11) |
| 8 | child retains causal correlation | ✅ re-run (test 8/11b) |
| 9 | event is NOT dispatched immediately when `publishEvent` is called | ✅ new — handler-fired flag checked false immediately after the `publishEvent` call, inside the same business callback |
| 10 | event dispatches during UoW drain | ✅ new — an ordered-events array proves `callback-start`, `callback-end`, THEN `handler`, never any other order |
| 11 | handler failure still rolls back publisher + handler writes | ✅ re-run, real PostgreSQL, both the manual-mechanism suite and the Nest-DI registration suite |
| 12 | nested event remains drainable | ✅ re-run (`domain-event-dispatcher.spec.ts`'s nested-emission test, call site updated to `ctx.publishEvent`) |
| 13 | multiple handlers still work | ✅ re-run (dispatcher spec + registration e2e items 4–6) |
| 14 | Nest discovery still works | ✅ `domain-event-handler-registry.spec.ts` 7/7, re-run |
| 15 | concurrent UoWs remain isolated | ✅ re-run (test 16, call sites updated to `ctx.publishEvent`) |
| 16 | modules cannot import raw collector | ✅ `trusted-construction-boundary.spec.ts`, new dedicated check |
| 17 | modules cannot import internal constructor | ✅ re-run, unchanged |
| 18 | Sales/Kitchen public event types remain importable | ✅ re-run, both contract files re-verified to import types only |
| 19 | no new module-boundary deviations | ✅ `module-boundaries.spec.ts` untouched, 7/7 |
| 20 | no production event publisher | clean (grep) |
| 21 | no Fire | clean |
| 22 | no Kitchen persistence | clean |
| 23 | no Payment | clean — same two pre-existing docblock comments as every prior report |
| 24 | no Outbox | clean |
| 25 | CashSession regression | ✅ included in the 146/146 run |
| 26 | Sales/P1C regression | ✅ same run |

---

## J. DATABASE / MIGRATION

**No production migration was created or is needed.** `ctx.publishEvent`'s combined construct-and-enqueue behavior is pure in-memory logic inside `UnitOfWork.execute()` — no new table, no new column, no persisted queue. `git status --short prisma/migrations/` shows the same 6 pre-existing untracked migration directories as every prior report in this engagement, zero new.

A fresh scratch database (`ros_p1e1c_scratch`) was used for every real-DB verification. The local dev DB (`ros`) was never pointed at by any test, only read (`migrate status`, a row count) before and after.

| Command | Result |
|---|---|
| `npx prisma format` | no-op (schema untouched) |
| `npx prisma validate` | ✅ valid |
| `npx prisma generate` | ✅ Prisma Client 7.9.1 |
| Scratch DB, 20 migrations from zero | ✅ "All migrations have been successfully applied" |
| Scratch DB `migrate status` | ✅ "Database schema is up to date!" |
| Focused domain-events + CashSession + Sales E2E | ✅ **146/146** (unchanged count — no new E2E test added this correction) |
| Full unit suite | ✅ **672/672**, 50 suites (663 → 672, **+9**: 4 new architecture-boundary tests + 5 new `unit-of-work.spec.ts` tests) |
| Full E2E, scratch DB, `--runInBand` | ✅ **558/558**, 26 suites (unchanged from P1E-1B) |
| **TOTAL** | **1230 passing** (1221 → 1230, **+9**), 0 skipped, 0 todo |
| `npx eslint` on all new/changed files | ✅ clean |
| `npx tsc --noEmit` | exactly the pre-existing baseline `access-token.service.spec.ts(28,7) TS2322` — **no new error** |
| `npx prisma migrate status` against the real dev DB, before vs. after | ✅ identical — same 5 migrations still unapplied |
| `catalogue.price_lists` row count, before vs. after | ✅ **78, unchanged** |
| `package.json`/`package-lock.json` diff | unchanged from every prior report (`canonicalize`, pre-existing, unrelated) |

---

## K. FILES CHANGED

**Moved**

None this correction (P1E-1B's move of `create-domain-event.ts` into `internal/` stands unchanged).

**New**

```
src/common/domain-events/internal/unit-of-work-internal-context.ts
docs/reports/claude/2026-08-21_P1E1C_trusted-event-publication-boundary.md
```

**Modified**

```
src/common/domain-events/unit-of-work-context.ts            — UnitOfWorkContext: events+createEvent -> publishEvent only; docblock rewrite
src/common/domain-events/unit-of-work.ts                     — builds InternalUnitOfWorkContext internally; publishEvent constructs+enqueues in one call; docblock rewrite
src/common/domain-events/domain-event-dispatcher.ts          — drain() now takes InternalUnitOfWorkContext, not the narrowed public type
src/common/domain-events/trusted-construction-boundary.spec.ts — extended: +collector-import check, +raw-`.events.record(`-usage check, +2 self-tests
src/common/domain-events/domain-event-dispatcher.spec.ts     — makeCtx() -> InternalUnitOfWorkContext with publishEvent; 2 handler-side tests moved from `ctx.events.record` to `ctx.publishEvent`
src/common/domain-events/domain-event-handler-registry.spec.ts — FIXTURE_CTX: events+createEvent -> publishEvent only
src/common/domain-events/unit-of-work.spec.ts                 — all ctx.createEvent -> ctx.publishEvent; +5 new tests (§I items 1–3, 9–10)
test/domain-events.e2e-spec.ts                                 — all ctx.events.record(testEvent(...)) -> ctx.publishEvent(testEventInput(...)); import of internal constructor removed (no longer needed)
test/domain-events-registration.e2e-spec.ts                    — ctx.createEvent + separate ctx.events.record -> single ctx.publishEvent call
docs/reports/claude/INDEX.md                                    — +1 row (this report)
```

**Untouched:** `prisma/schema.prisma`, every migration, every governance document, `module-boundaries.spec.ts`, `domain-event-collector.ts`, `domain-event-handler.decorator.ts`, `domain-event-handler-registry.service.ts`, `domain-event-handler-source.ts`, `domain-event-handler.types.ts`, `domain-events.module.ts`, `internal/create-domain-event.ts` (logic unchanged — only its callers' call shape changed), `app.module.ts`, `sales.permissions.ts`, `treasury.permissions.ts`, `orders.controller.ts`, `orders.service.ts`, `cash-sessions.service.ts`, `treasury.controller.ts`, `workforce/contract/`, `common/idempotency/`, the local dev DB.

---

## L. REQUIREMENT CLASSIFICATION

**§5.2.3 mechanically enforced boundaries: reinforced, classification unchanged (PARTIAL globally).** This correction adds a second, correctly-scoped mechanical boundary inside `common/domain-events` (construction AND publication, not just construction) but does not touch the 21 pre-existing module-to-module deviations `module-boundaries.spec.ts` records.

**§5.4 public module contracts: unchanged (PARTIAL).** Still Workforce, Sales, Kitchen only — and this correction reaffirms (§D, item 18) that neither Sales nor Kitchen's contract needed to lose anything to close this bypass; PUBLIC EVENT CONTRACT TYPES and INTERNAL AUTHORITATIVE CONSTRUCTION remain cleanly separated, exactly as instructed.

**§5.5.2 transactional domain-event mechanism: COMPLETE, and the "collected by the aggregate/UoW" requirement is now held to the standard the SRS text actually implies.** §5.5.2 says "Events are collected on the aggregate, and dispatched by the unit of work" — it describes an INTERNAL collection mechanism, never a business-visible mutation API. P1E-1/1A/1B implemented the collection and dispatch correctly but LEAKED the collection mechanism itself as a public surface; this correction closes that gap. There is now exactly ONE way business code (or a handler) can add anything to what will be dispatched: `ctx.publishEvent(...)`, and it always goes through trusted construction. System-wide EVENT CATALOGUE ADOPTION remains PARTIAL/NOT IMPLEMENTED — no business event is published by anything; this correction, like every one before it, changes nothing about that.

**§5.5.4 mandatory envelope infrastructure: COMPLETE**, unchanged from P1E-1B's classification — this correction touches WHO can construct an envelope, not what fields it carries or what they mean.

**§5.5.3 Outbox: NOT IMPLEMENTED.** **Fire: NOT IMPLEMENTED.** **Payment: NOT IMPLEMENTED.** **FR-KDS-010: PARTIAL**, unchanged. None touched by this correction.

---

## M. P1E-1C EXIT

```
P1E-1C TRUSTED PUBLICATION BOUNDARY COMPLETE: YES
P1E-1C RAW COLLECTOR BYPASS CLOSED:           YES
P1E-1C CAUSAL CONTEXT REGRESSION-FREE:        YES
P1E-1C OVERALL COMPLETE:                      YES
```

`UnitOfWorkContext` (the type every business callback and every handler actually receives) exposes exactly one queue-affecting operation, `publishEvent`, which always constructs from trusted inputs and always enqueues atomically with construction — there is no intermediate state in which a caller-built object could be substituted. The raw collector is unreachable both by TYPE (`UnitOfWorkContext` declares no `events` field) and by MECHANICAL ENFORCEMENT (`trusted-construction-boundary.spec.ts` fails CI the moment any file under `src/modules/**` imports `DomainEventCollector`, imports anything under `internal/`, or contains the literal `.events.record(` call pattern — each backed by a self-test proving the detector fires, not just that it currently finds nothing). Every P1E-1A/B correlation and causation guarantee was re-verified, not merely assumed, after the rename to `publishEvent`.

---

## N. P1E-1 FINAL ACCEPTANCE

```
P1E-1 FINAL ACCEPTANCE: YES
```

Answered YES specifically because raw envelope injection cannot bypass the trusted Unit-of-Work publication surface in production module code — verified two ways, not one: (1) the TYPE `UnitOfWorkContext` a business callback or handler receives has no field through which a raw envelope could be queued; (2) the mechanical architecture test proves no file under `src/modules/**` can reach the underlying machinery by any of the three routes examined (internal construction, direct collector import, literal `.events.record(` usage), and each check is proven to actually detect a violation, not merely to report none exist by omission.

Across four acceptance passes — P1E-1 (mechanism), P1E-1A (production registration + trusted tenant), P1E-1B (causal-chain correctness + construction-bypass closure), P1E-1C (publication-bypass closure) — every defect raised was corrected with real, re-verified evidence, never by narrowing what was claimed. §5.5.2's infrastructure is COMPLETE by the strictest standard applied across all four reports. §5.5.2's SYSTEM-WIDE adoption remains, and is explicitly stated to remain, NOT claimed anywhere — building a real Fire/Kitchen producer and consumer is separate, much larger work this four-part correction was never scoped to include.

---

## O. NEXT SINGLE HIGHEST-LEVERAGE SLICE

## → **KDS ROUTING SEMANTICS / GOVERNANCE CLOSURE**

Unchanged reasoning across every prior report's own next-slice section: this correction touched none of FR-KDS-010's open tiers and nothing about Fire's authorization gap. The event-publication infrastructure Fire will eventually need — trusted, causally-correct, and now reachable through exactly one mechanically-enforced surface — is complete. The two remaining blockers to Fire are exactly the two the P1D-1/P1E-1 gate report identified from the start: FR-KDS-010's undecided routing semantics, and the absent Fire-authorization permission code. Both are **NOT SOURCE-DECIDABLE** and require either ratified governance or an explicit engineering decision from the user — not further infrastructure work.

**Not implemented in this run.**

---

## P. COMMIT READINESS

```
COMMIT READY: YES
COMMITTED:    NO
```

1230 tests passing (672 unit + 558 E2E), 0 skipped, 0 todo; TypeScript at the known baseline with no new error; ESLint clean on every new/changed file; Prisma schema unchanged and valid; all 20 migrations apply cleanly from zero on a scratch database; the local dev database was read-only touched and is verified unchanged (78 `price_lists` rows, same 5 unapplied migrations).

Nothing was committed and no destructive git command was used. No governance file was modified; no `D-21` or later exists anywhere (re-confirmed by grep). No new dependency was added. Nothing from the non-goals list was implemented: no KDS routing, no Fire, no `pos.order.fire`, no broadened `pos.order.create`, no Kitchen Ticket/TicketLine, no Station management, no Payment, no Completion, no Outbox, no broker, no event persistence, no adoption of any existing business event, and no unrelated module-boundary cleanup.
