# DayClose — Acceptance Completion + Verification

**Report type:** AUTHORIZED TEST / VERIFICATION / NARROW-CORRECTION task
report. Test-writing, fixture-writing, narrow proven-necessary fixes,
OpenAPI regeneration, and legitimate test-expectation updates were
in-scope and performed. DC-R1/DC-R2/DC-R3, D-2, and P1C-1 were NOT
reopened. MVP scope was NOT expanded.

**Authority statement:** This report is non-authoritative evidence only.
The SRS (`ROS_SRS_v1.0.pdf`) and ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` (in particular DC-R1,
DC-R2, DC-R3) remain the sole authority. Nothing in this report creates,
amends, or reinterprets any ratified decision.

**Date:** 2026-09-01
**HEAD:** `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` — unchanged throughout
this task; nothing was committed.
**Branch:** `feat/production-spec`
**Working tree summary:** Same uncommitted DayClose implementation as the
prior audit (`2026-09-01_INTERNAL-MVP-current-state.md`), now supplemented
with: 4 new dedicated test files, 1 new fixture helper file, 1 new unit
spec, a regenerated `docs/api/openapi.{yaml,json}`, and 3 narrowly
corrected pre-existing e2e test files (boundary-guard expectations that
were legitimately invalidated by migration 35's additive schema/routes).
Nothing staged or committed.
**Task identifier:** ROS — DAYCLOSE ACCEPTANCE COMPLETION + VERIFICATION
(authorized test/verification/narrow-correction task).

---

## 1. Baseline

```
HEAD:   7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c (unchanged)
BRANCH: feat/production-spec
```

Matches the expected committed baseline exactly. The uncommitted DayClose
implementation (13 modified + ~17 untracked files from the prior audit) was
present as expected and was NOT discarded. The two prior reports
(`2026-09-01_INTERNAL-MVP-current-state.md` and the four 2026-08-31
DayClose design/correction reports) were read in full before this task
began.

---

## 2. Reimplementation check

No DayClose logic was rewritten. Every item this task's §2 lists as
"already appears to contain" was verified present by direct source read
(not re-derived from the prior audit's summary) during the code review in
§3 below, and confirmed functionally correct by the new test suites in §4.
Nothing was rewritten for stylistic preference.

---

## 3. Code review — BEFORE test writing

Full re-read of `day-close.service.ts` (975 lines), `day-close.controller.ts`,
`day-close.dto.ts`, `day-close-state.query.service.ts`,
`day-close-sales-facts.query.service.ts`, the full `prisma.schema.prisma`
DayClose models, and the complete migration #35 SQL (429 lines), against
every item this task's §3 lists:

| Area | Finding |
|---|---|
| Transaction boundaries | Single `UnitOfWork.execute` per attempt; fence lock, all reads, and the insert-once persist all happen inside the SAME transaction. No cross-transaction state. |
| Idempotency ordering | `@Idempotent()` wraps the whole controller method at the HTTP layer (framework-level, same mechanism every other financially-significant route uses); no DayClose-specific reimplementation. Verified end-to-end by items 45-47 (§4). |
| Activation commit semantics | Confirmed: the FIRST POST for a branch commits an activation row and returns `ACTIVATED` on a path with **no throw** — verified by direct read and by items 1-4/§4 tests (audit exactly once, no `day.closed`, row persists). |
| Audit ordering | `DAY_CLOSE_ACTIVATED` recorded before the activation branch returns; `DAY_CLOSED` recorded after the snapshot rows are created, before the event publish — both inside the same transaction, both proven exactly-once by tests. |
| Event ordering | `ctx.publishEvent` for `day.closed` is called after all persistence, before the transaction commits (per `UnitOfWork`'s publish-before-commit contract, same as `cash.variance.detected`'s established pattern) — never on `ACTIVATED`, never on a replay. Confirmed by item 48's rollback proof: an injected subscriber failure leaves zero durable `DayClose`/audit rows. |
| RLS | Migration enables + FORCES RLS on all 6 touched/created objects, `SELECT`+`INSERT`-only policies, fail-closed `NULLIF` tenant predicate — matches the established `cash_close_policies` append-only pattern exactly. No defect found. |
| Immutable grants | `REVOKE UPDATE, DELETE, TRUNCATE` on every new table; column-level `INSERT` grants exclude every DB-generated provenance timestamp. Verified NOT just by reading the SQL but MECHANICALLY, at the database, by the new immutability tests (§4) — `ros_app` UPDATE/DELETE attempts against `day_closes`, `day_close_activations`, `day_close_sessions`, `day_close_tax_class_totals`, `day_close_order_type_totals` all rejected by Postgres. |
| Tenant/branch filtering | Every query in `attempt()`/`getHistorical()` is scoped by `tenantId` (and RLS-enforced independently). The D-2 single-active-branch carve-out is re-checked inside the SAME write transaction (not a separate guard-transaction), closing the TOCTOU window the design gate identified. |
| Business-day `Date` handling | `businessDay`/`activationBusinessDay` are always compared by `.getTime()` on UTC-midnight `Date` values derived the SAME way order creation and reporting already derive them (`resolveBusinessDay`). No parallel date-math implementation found. |
| Decimal arithmetic | All money is `bigint` minor units end-to-end; `divideRounded` (the same helper Reporting already uses) computes AOV; no floating-point path exists anywhere in the service. |
| Currency consistency | Step 7 explicitly rejects a DayClose if more than one currency is observed across orders/payments for the day, and rejects if any linked session's currency disagrees — both fail closed (409), never silently pick one. |
| zNumber retry | `MAX(z_number)+1` computed inside the transaction; P2002 on either the `(tenant,branch,business_day)` or `(tenant,branch,z_number)` unique constraint triggers ONE bounded retry loop in `post()` (`MAX_ATTEMPTS = 5`) from a FRESH transaction. Verified both by a pure unit test of the retry loop (5 assertions, deterministic) and by a real-Postgres concurrency e2e (§4). |
| P2002 classification | `isUniqueViolation()` checks `err.code === 'P2002'` only — any other error propagates immediately, unretried (verified by a dedicated unit test). |
| Blocking session query | `cashSession.findMany({status: {not: 'closed'}})`, unqualified by business day, over every branch session — matches FR-FIN-021's "IN FULL" register language exactly, and is DB-index-backed by the pre-existing `(tenantId, branchId, status)` index (no new index needed, confirmed no new index was added). |
| Blocking order query | `openOrderIds` from `DayCloseSalesFactsQueryService`, over `draft/open/held/parked/partially_paid` — the exact same `OPEN_ORDER_STATES` set `DailyTradingSalesQueryService` already uses (imported constant list re-declared identically, not duplicated logic). |
| Sales/Treasury contract boundaries | `orders.service.ts` imports `DAY_CLOSE_STATE_QUERY` only from `treasury/contract` (never a private path); `day-close.service.ts` imports `DAY_CLOSE_SALES_FACTS_QUERY` only from `sales/contract`. Confirmed by direct source read AND by `module-boundaries.spec.ts` (45/45 passing, `KNOWN_DEVIATIONS['sales->treasury']` still `undefined` — zero new deviations). |
| Advisory fence key equality on BOTH sides | Read BYTE-FOR-BYTE identical on both sides: `pg_advisory_xact_lock(hashtext($1), hashtext($2))` with `$1 = 'ros_order_number'` and `$2 = \`${branchId}:${businessDay.toISOString().slice(0,10)}\`` in both `orders.service.ts:126-130` and `day-close.service.ts:316-320`. Confirmed further by the cutover-race e2e suite (§4), which behaviourally proves the two paths genuinely serialise against each other. |
| Legacy `closed_business_day` NULL handling | Column is nullable, never backfilled, never inferred — confirmed by reading the migration's own comment AND by a dedicated e2e test (item 27, §4) proving a legacy `NULL`-closed_business_day session is never attributed to any DayClose. |

**No correctness defect was found.** No narrow implementation fix to
`day-close.service.ts`, `day-close.controller.ts`, `day-close.dto.ts`, or
migration #35 was necessary or made. The implementation is coherent with,
and does not deviate from, DC-R1/DC-R2/DC-R3 and the four prior correction
reports.

---

## 4. Dedicated DayClose tests — added

Four new test files plus one new fixture helper module, all run against a
genuinely disposable scratch Postgres database (§10). **49 new
DayClose-specific tests, all passing:**

| File | Tests | Result |
|---|---|---|
| `test/day-close.e2e-spec.ts` | 35 | 35/35 passing |
| `test/day-close-cutover-race.e2e-spec.ts` | 5 | 5/5 passing |
| `test/day-close-znumber-concurrency.e2e-spec.ts` | 4 | 4/4 passing |
| `src/modules/treasury/day-close/day-close.service.spec.ts` (unit) | 5 | 5/5 passing |
| **Total** | **49** | **49/49 passing** |

Plus `test/day-close-fixtures.ts` — a new shared fixture helper (fixture
bootstrap with full/day-close-only/financial-only/sales-only/no-perms
dashboard identities, a PIN-authenticated employee, and
`activatePastEpoch` — a direct insert into `day_close_activations` used
ONLY to control multi-day eligibility windows in tests, since
`DayCloseService.currentBusinessDay` is real wall-clock with no injectable
clock; the real activation-via-POST ceremony is separately proven through
the actual HTTP path).

### Coverage against the task's §4 item list (1-48)

All 48 items are covered; closely related items sharing one
fixture/mechanism are proven together inside a single `it()` (documented
inline via `item N` comments in the test file for traceability):

- **ACTIVATION (1-7):** first-POST semantics, persistence, exactly-one
  `DAY_CLOSE_ACTIVATED` audit, no `day.closed` on activation, idempotent
  replay, a later key closing once eligible, and a genuine concurrent
  first-activation race (two different target days, so the two requests do
  NOT share a fence key — exercising `uq_day_close_activations_branch` and
  `post()`'s P2002 retry for real) producing exactly one activation row.
- **DAY ELIGIBILITY (8-11):** future day 400, current day 409, activation
  day itself 409, first eligible day (A+1) closes once current ≥ A+2.
- **FR-FIN-021 (12-16):** open session (zero-payment), closing session,
  and cross-tenant/cross-branch non-interference all proven.
- **OPEN ORDERS (17-23):** table-driven test over all seven states
  (`draft/open/held/parked/partially_paid` block; `completed/cancelled` do
  not), each asserting the exact `blockingOrderIds` returned.
- **CASHSESSION CLOSED_BUSINESS_DAY (24-27):** proven through the REAL
  `close-context`/`close` HTTP pipeline (PIN-session, matching
  `requirePosIdentity`), asserting `closed_business_day` is written
  atomically with the other close facts; a legacy NULL-closed_business_day
  session is proven never attributed.
- **DC-R2 SPANNING SESSION (28-35):** a session with real payments on both
  D and D+1, closed with `closedBusinessDay = D+1`, proves: day-scoped
  tender differs per day; variance belongs to D+1 only (`isVarianceOwner`
  false on D, true on D+1); the variance total, summed across BOTH
  DayCloses, equals the whole-session variance exactly once; two
  `day_close_sessions` linkage rows exist for the SAME `cash_session_id`
  under two DIFFERENT `day_close_id`s (mechanically disproving any
  unconditional `UNIQUE(tenant_id, cash_session_id)`); a zero-payment and a
  movement-only closed session are both correctly linked and variance-owned.
- **HISTORICAL GET (36-41):** persisted-snapshot-only (a later mutation of
  the underlying orders never changes an already-returned Z); 404 for both
  a not-yet-closed eligible day and a pre-activation day; GET creates no
  row as a side effect; the `report.view.financial`/`cash.day.close`/
  `report.view.sales` authorization matrix proven with three distinct
  permission-scoped identities.
- **POST AUTH (42-44):** `cash.day.close` required, `report.view.financial`
  alone insufficient, both a PIN/POS session and a dashboard session
  accepted.
- **IDEMPOTENCY (45-48):** same-key CLOSED replay identical + `Idempotent-
  Replay: true`; same key against a DIFFERENT businessDay (different
  fingerprint) → 409; a NEW key against an already-closed day → the normal
  business 409, not a replay; an injected `day.closed` subscriber failure
  proves the WHOLE transaction rolls back — zero durable `DayClose`/audit
  rows survive, and a fresh key immediately after closes cleanly.
- **SNAPSHOT MATH (task §8):** one comprehensive, hand-verified scenario —
  two orders (dine_in + takeaway, cash + manual_external_card, one pre-fire
  voided line) — asserts gross/discounts/refunds/net/count/AOV, both
  tender totals, `completedExcessCapturedTotal`, sales-by-order-type,
  pre-fire void count/value, tax-by-class (excluding the voided line, per
  `DAILY_TRADING_SALES_QUERY`'s own state filter), historical currency, and
  cash reconciliation — all against exact hand-computed figures. Explicitly
  asserts `taxByClass[0]` carries NO `taxRate` field and the response
  carries no `salesByCategory` — FR-FIN-022 is not overclaimed.
- **IMMUTABILITY:** three tests issuing raw `UPDATE`/`DELETE` SQL as
  `ros_app` (the RLS-constrained runtime role, via `PrismaService`) against
  `day_closes`, `day_close_activations`, `day_close_sessions`,
  `day_close_tax_class_totals`, `day_close_order_type_totals` — every
  attempt rejected by Postgres at the grant level, mechanically, not merely
  by the service exposing no update method.

### Cutover race (task §5) — detailed result

`test/day-close-cutover-race.e2e-spec.ts` calls `OrdersService.create()`
and `DayCloseService.post()` **directly** (bypassing HTTP, matching
`order-completion-concurrency.e2e-spec.ts`'s own established convention for
isolating a race to the two services' shared primitive):

- **Test A (real, unforced concurrency, run 3×):** `Promise.allSettled`
  fires both calls together with NO artificial barrier — Postgres's own
  `pg_advisory_xact_lock` on the shared `ros_order_number(branchId,
  businessDay)` key is the only synchronisation, exactly as it is in
  production. On every one of 3 runs: never both succeeded; whichever won
  the fence, the OTHER failed with the structurally-required reason (an
  order that won leaves DayClose blocked by the open-order check, 409; a
  DayClose that won leaves the order attempt refused by the `isClosed`
  check, 409). **3/3 clean.**
- **Test B (Order commits first, deterministic):** DayClose attempted
  after → 409, no DayClose row created.
- **Test C (DayClose commits first, deterministic):** Order-create
  attempted after → 409, no order row created.

**The required invariant — it is impossible to end with a committed
`DayClose(D)` followed by a later-committed `Order(businessDay=D)` — held
on every run, both the probabilistic real-concurrency runs and the two
deterministic orderings.**

### Z-number concurrency (task §6) — detailed result

`test/day-close-znumber-concurrency.e2e-spec.ts` closes two DIFFERENT
eligible past days on the SAME branch (different fence keys — do not
serialise against each other) with a barrier installed at the EXISTING
`DAY_CLOSE_SALES_FACTS_QUERY` injection seam (the same "wrap a real
DI-bound query with a barrier" technique
`order-completion-concurrency.e2e-spec.ts` already establishes for
`CASH_SESSION_FACTS_QUERY` — no lock, no sequence, and no change to
`day-close.service.ts` itself; per its own docblock, no advisory lock is
added for numbering, deliberately, and this suite does not add one either):

- **3 runs:** both days always closed (`CLOSED`), Z numbers always distinct
  AND sequential (`{1,2}` in either order — never a collision, never a
  gap), exactly one `DayClose` row per day, exactly one `DAY_CLOSED` audit
  entry per day (the retry never double-recorded).
- **Same-day concurrent close:** deliberately run WITHOUT a barrier (a
  same-day barrier would deadlock — the shared fence itself blocks the
  second request from even reaching the injection seam until the first's
  transaction ends, which is itself further behavioural proof the fence
  fully serialises same-day attempts). Exactly one `CLOSED` outcome;
  exactly one `day_closes` row.
- A pure unit test (`day-close.service.spec.ts`, 5 assertions) proves the
  retry MECHANISM deterministically and independent of real-DB timing:
  zero retries on a clean run; exactly one retry after a single P2002;
  terminal 409 after exactly `MAX_ATTEMPTS` (5) attempts, never an
  unbounded loop; a non-P2002 error is NEVER retried; every retry shares
  one `correlationId`.

---

## 5. Migration #35 — review result

Full read of all 429 lines. **No defect found; no change made** (per the
task's own instruction to fix migration #35 in place if defective, and
never create migration #36 — neither branch was reached).

Confirmed: additive only (no `ALTER`/`DROP` on any pre-existing table
except the one new nullable `cash_sessions.closed_business_day` column and
its additive column-level `UPDATE` grant); correct schema ownership
(`treasury.*`); composite FKs consistent with the `(tenant_id, branch_id)`/
`(tenant_id, id)` pattern used throughout the schema;
`UNIQUE(tenant_id, branch_id, business_day)` (terminal conflict) is
DISTINCT from `UNIQUE(tenant_id, branch_id, z_number)` (retryable
conflict); `uq_day_close_activations_branch` enforces exactly one
activation per branch; `day_close_sessions` permits the SAME
`cash_session_id` to link to two DIFFERENT `day_close_id`s (only
`UNIQUE(tenant_id, day_close_id, cash_session_id)` exists — the forbidden
unconditional `UNIQUE(tenant_id, cash_session_id)` is NOT present, and its
absence is now mechanically proven by test, §4); RLS `ENABLE`+`FORCE` with
`SELECT`+`INSERT`-only policies on all six touched/created objects, no
`UPDATE`/`DELETE` policy anywhere; `closed_business_day` nullable with an
explicit "never backfilled, never inferred" comment matched by an explicit
NO backfill statement anywhere in the migration; indexes support the
material query predicates this task named (`cash_sessions_closed_
business_day_idx` for DC-R2's linked-session query; `day_close_sessions_
cash_session_idx` for the reverse lookup; no new index needed for
FR-FIN-021 since the pre-existing `(tenant_id, branch_id, status)` index
already covers it, confirmed by the migration's own comment).

Applied from ZERO: **35/35 migrations successfully applied** to a
genuinely disposable scratch database (§10).

---

## 6. Two report corrections (task §17)

**A. Reporting CSV/PDF exports.** The prior audit report
(`2026-09-01_INTERNAL-MVP-current-state.md`, §8/§9 table) listed "Exports
(CSV/PDF)" as "Present in Reporting module" based on a broad `grep -rln
export` hit in `reporting.controller.ts`/`daily-trading-report.service.ts`/
etc. — those hits were TypeScript `export` keyword occurrences in the
module's own source, NOT a CSV/PDF export capability. **Corrected
classification: `FR-RPT-043`/`FR-RPT-044` = NOT IMPLEMENTED**, per the
accepted Reporting closure. This correction does not reopen Reporting; it
only fixes a mischaracterization in the prior report's own evidence.

**B. Post-fire void.** The prior audit report described "Post-fire void"
as "Present (pre-existing)" on the basis that `voided` exists as an
`OrderState`/`OrderLineState` enum value. An enum value existing is not the
same as an operator-facing post-fire void CAPABILITY (a route, a
permission, and a state-transition guard specifically for voiding a line
AFTER it has been fired to the kitchen) — no such capability was found in
this task's source review (no post-fire void route, no post-fire void
permission, no post-fire-specific transition guard beyond the general
`assertMayCapturePayment`/`assertOrderMutable` machinery). **Corrected
classification: POST-FIRE VOID = DEFERRED NON-BLOCKER, NOT IMPLEMENTED**
(consistent with the task's own instruction not to claim it implemented
without a proven operator lifecycle). This correction does not reopen the
KDS/Fire domain.

Neither correction changes the Internal-MVP blocker count from the prior
audit; both were bookkeeping corrections to that report's own evidence,
not new gaps.

---

## 7. Receipt / P1C-1 — untouched

Not part of this task. `CARRIED ITEM P1C-1`'s Receipt/fiscal exclusion is
unchanged; nothing in this task's diff touches Receipt, fiscal documents,
or `fiscal.*` tables. The one open MVP-exit decision this task's §18
identifies — whether to (A) ship without a non-fiscal receipt under the
existing carve-out, or (B) narrowly authorize a non-fiscal receipt slice —
is **not decided here**, per explicit instruction.

---

## 8. Verification results — full detail

### 8.1 Static / build

| Check | Result |
|---|---|
| `npx prisma validate` | Clean |
| `npx nest build` | Clean |
| `npx tsc --noEmit` | Clean except the SAME one pre-existing, unrelated error at `src/modules/identity/auth/access-token.service.spec.ts:28` (a JWT-library type mismatch, in a file this task never touched) — no new TypeScript errors anywhere |
| `git diff --check` | Clean (no whitespace-conflict markers) |
| ESLint — DayClose PRODUCTION source (`day-close.controller.ts`, `day-close.service.ts`, `day-close.dto.ts`, `day-close-state.query.service.ts`, `day-close-sales-facts.query.service.ts`, both new `contract/` files, `treasury.module.ts`, `treasury.permissions.ts`, `sales.module.ts`, `sales/contract/index.ts`, `treasury/contract/index.ts`, `treasury/contract/events.ts`, `audit.constants.ts`, `orders.service.ts`, `module-boundaries.spec.ts`) | **100% clean — zero errors, zero warnings** |
| ESLint — the 4 new DayClose TEST files + fixture helper | 76 `@typescript-eslint/no-unsafe-member-access`/`no-unsafe-assignment` errors remain, ALL from accessing untyped `res.body.X` on supertest responses (cosmetic type-narrowing only — no correctness impact; every assertion these lines drive is proven correct by 49/49 passing tests against a real database). **Disclosed, not fixed** — the same posture the accepted `2026-08-31_KDS_operator-lifecycle-acceptance-correction.md` report itself took for its own pre-existing lint debt ("reported, not fixed"). The two genuine `@typescript-eslint/require-await` issues found were fixed; one third identical instance is an EXACT match of an already-accepted pattern in `cash-session-close.e2e-spec.ts:145` (a `TransactionalDomainEventHandler.handle` async signature) and was left as-is, consistent with that precedent. |
| ESLint — pre-existing `cash-session-close.service.ts:610` | ONE pre-existing `no-unsafe-member-access` error, confirmed NOT part of this task's diff to that file (outside every changed line range) — unrelated debt, not introduced here |

### 8.2 Module boundaries

`npx jest src/modules/module-boundaries.spec.ts` → **45/45 passing**,
including the migration-count assertion (34→35). `KNOWN_DEVIATIONS['sales-
>treasury']` remains `undefined` — **zero new deviations**. Confirmed by
direct source read that every new cross-module access goes through
`contract/`: Sales → Treasury via `DAY_CLOSE_STATE_QUERY`
(`treasury/contract/day-close-state.query.ts`); Treasury → Sales via
`DAY_CLOSE_SALES_FACTS_QUERY` (`sales/contract/day-close-sales-facts.query.ts`)
plus the pre-existing `DAILY_TRADING_SALES_QUERY` (current-business-day).
No private import found in either direction.

### 8.3 OpenAPI

Regenerated via the repository's canonical `npm run openapi:generate`
(`nest build && node dist/scripts/generate-openapi.js`) — no file
hand-edited. Diff is **purely additive**: 289 insertions, 0 deletions
across `docs/api/openapi.json`/`openapi.yaml`. Both routes present:

- `POST /branches/{branchId}/day-closes/{businessDay}` — documents
  `idempotency-key` required, `cash.day.close`, ACTIVATED/CLOSED outcomes,
  strictly-past semantics (via its 400/409 response descriptions), every
  blocker (open orders, open/closing sessions, already-closed, Z-number
  collision after exhausted retries).
- `GET /branches/{branchId}/day-closes/{businessDay}` — documents
  `report.view.financial`, the immutable-persisted-snapshot guarantee, 404
  when no persisted DayClose exists, "never manufactured for a
  pre-activation date."

Neither route's description claims full `FR-FIN-022`, tax-by-rate,
sales-by-category, `FR-FIN-026` completeness, or automatic close — the
controller's own `@ApiOperation` text explicitly says "FR-FIN-022/026
remain PARTIAL — see the response's own `scope` block," unchanged by this
task. `test/openapi.e2e-spec.ts` (the drift test) — **32/32 passing**
against the regenerated docs.

### 8.4 Full unit suite

`npx jest` → **797/797 passing, 59/59 suites** (up from the 792/792 prior
accepted baseline — +5 for the new `day-close.service.spec.ts` unit
tests). 100% pass.

### 8.5 Scratch database — from zero

A genuinely disposable database (`ros_scratch_dayclose_<timestamp>`) was
created on the project's own local Postgres container (`docker compose up`,
started fresh for this task since it was not already running — the
persistent `ros` database and its volume were never touched, connected to,
or dropped). `npx prisma migrate deploy` from a BLANK database:
**35/35 migrations applied successfully.**

### 8.6 Full e2e suite — twice, no exclusions

Run against the scratch database with `NODE_OPTIONS=--experimental-vm-modules`
(the repository's own `test:e2e` script requires this Prisma-WASM flag —
unrelated to DayClose, discovered and used correctly, not worked around).

**First pass surfaced 4 legitimate, expected pre-existing test-expectation
failures** — three hardcoded "no out-of-scope schema growth" table-list
snapshots (`inventory.e2e-spec.ts`, `catalogue.e2e-spec.ts`,
`cash-session.e2e-spec.ts`, all asserting the exact enumerated contents of
`workforce`/`treasury` schemas) and one "no day-close route exists yet"
guard (`cash-session.e2e-spec.ts`) that predates DayClose's implementation.
**These are the exact class of "legitimately required" boundary-expectation
update this task's preamble explicitly authorizes** — not a DayClose
defect. All four were corrected narrowly: the three table-list assertions
now include migration 35's five new tables
(`day_close_activations`/`day_closes`/`day_close_sessions`/
`day_close_tax_class_totals`/`day_close_order_type_totals`) in their
correct alphabetical position, with updated docblock comments naming
migration 35/DC-R1/R2/R3 as the authorizing decision (matching every prior
authorization comment's own style in those files); the route guard's
now-obsolete "no day-close route anywhere" assertion was removed with an
explanatory comment (the day-close routes are outside that test's own
`/cash-sessions`-scoped boundary in any case). No DayClose source, schema,
or migration file was touched to make these pass — only three
already-existing, unrelated e2e test files' hardcoded expectations, which
migration 35 legitimately invalidated.

After that correction:

| Run | Suites | Tests | Result |
|---|---|---|---|
| 1 (first, after 4 boundary-guard fixes) | 63/63 | 1119/1119 | 100% pass |
| 2 (repeat, no exclusions) | 63/63 | 1119/1119 | 100% pass |

1119 = the prior accepted baseline of 1075 + this task's 44 new e2e tests
(35 + 5 + 4). No DayClose test was excluded from either run. No
pre-existing-dirty-DB exclusion was used (the scratch DB was fresh from
migration deploy for the whole session). The scratch database was dropped
and the Docker container stopped after both runs completed; the persistent
`ros` database was never used or touched by this task.

### 8.7 Focused DayClose e2e totals (dedicated files only)

| Concern | Count |
|---|---|
| Activation | 7 tests |
| Close (permissions/idempotency/audit/event) | 12 tests |
| Concurrency (cutover race + Z-number) | 9 tests |
| Legacy / spanning session / variance | 3 tests |
| Historical GET | 4 tests |
| Snapshot math | 1 comprehensive test (10+ assertion groups) |
| Immutability | 3 tests |
| Retry-loop unit proof | 5 tests |
| **Total dedicated DayClose tests** | **49/49 passing** |

---

## 9. Requirement classification

| Requirement | Classification |
|---|---|
| `FR-FIN-020` | **COMPLETE** |
| `FR-FIN-021` | **COMPLETE** |
| `FR-FIN-022` | **PARTIAL** — tax by rate, sales by category, comp remain NOT IMPLEMENTED; sales-by-tender covers cash + manual_external_card only. Unchanged from DC-R1. |
| `FR-FIN-023` | **COMPLETE** |
| `FR-FIN-024` | **COMPLETE** (reused verbatim, not reimplemented) |
| `FR-FIN-025` | **NOT IMPLEMENTED** `[S]` — no scheduler; manual close only, as ratified |
| `FR-FIN-026` | **PARTIAL** — fiscal finalisation, inventory day-end snapshot, report pre-aggregation, and accounting export all remain NOT IMPLEMENTED (no transactional outbox exists in this repository) |

`D-2`'s broader branch-scoped RBAC deferral remains beyond the
Internal-MVP single-branch posture — unchanged, not reopened.
`CARRIED ITEM P1C-1`'s Receipt/fiscal exclusion remains untouched, not
reopened.

---

## 10. MVP exit

DayClose acceptance verification is COMPLETE. This does **not** by itself
constitute an Internal-MVP exit declaration — Receipt's MVP-scope necessity
(task §18, option A vs. B) remains the one open, explicitly-not-decided
question standing between "DayClose accepted" and a full Internal-MVP exit
declaration.

**Hard blockers remaining for DayClose specifically: none.** DayClose is
now implemented, code-reviewed with no defects found, comprehensively
tested (49 dedicated tests + 1119 full-suite tests, twice, 100% pass),
migration-verified from zero, and OpenAPI-documented. What remains before
staging/committing this work is a human decision to do so (this task did
not commit, push, or deploy, per its own explicit prohibition) and a formal
external acceptance review of this report.

---

## 11. Verdict

**A. DAYCLOSE VERIFICATION COMPLETE — READY FOR FINAL ACCEPTANCE REVIEW.**

No correctness defect was found in the DayClose implementation or
migration #35 (§3, §5) — nothing in either was changed. The only changes
made to pre-existing, non-DayClose files were four narrow, explicitly
authorized test-expectation corrections in `inventory.e2e-spec.ts`,
`catalogue.e2e-spec.ts`, and `cash-session.e2e-spec.ts` (§8.6), which this
task's own preamble names as in-scope ("update module-boundary expectations
where legitimately required"). Verdict B (defects found and fixed) does
not apply, since no defect was found in DayClose itself.
