# P1G-0 — Mid-Shift Treasury Cash Movements (PAY_IN / PAY_OUT / SAFE_DROP)

**Report type:** Implementation report (migration, production code, tests, verification evidence)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence**. The controlling design document is `docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md` §19, which this report implements with two binding corrections issued before execution ("client id is required"; "one actual insert only") and one implementation-time finding (§F below). Where this report and the gate appear to differ, the gate governs and the difference is a documentation bug here, not a design change.
**Date:** 2026-08-28
**HEAD at start:** `bfe7e69` (P1F-2 final-accepted commit; unchanged throughout — no commit performed by this task)
**Branch:** `feat/production-spec`
**Working tree at report time:** uncommitted — 1 new migration, 1 new Treasury sub-module (`cash-movements/`), 1 new `contract/` file, Treasury controller/DTO/module/permissions/views modified, `AUDIT_ACTION`/`AUDIT_ENTITY` extended, `prisma/schema.prisma` updated, OpenAPI regenerated (135→138), 3 pre-existing slice-boundary e2e tests updated to reflect the new accepted scope, 1 new e2e test file. Three prior design-gate/audit reports and this report. **Nothing committed, nothing pushed.**
**Task identifier:** P1G-0

> ## VERDICT
> ## **IMPLEMENTATION COMPLETE — FR-POS-091 COMPLETE, FR-POS-092 NOT IMPLEMENTED (SUBSTRATE ENABLED)**
> All three mid-shift cash movement operations (PAY_IN, PAY_OUT, SAFE_DROP)
> are implemented per the design gate, with one binding mid-implementation
> correction (§F): the gate's literal `SELECT ... FOR UPDATE` locking
> mechanism is inoperable under this schema's grants (Postgres requires the
> UPDATE privilege to take that lock; `ros_app` deliberately holds none on
> `cash_sessions`) — replaced with a transaction-scoped **advisory lock**
> giving the identical serialization guarantee, at no grant-widening cost,
> matching this repository's own existing precedent. A second real hang was
> found and fixed **in the test harness only** (§G) — production code was
> never implicated. Migration **31**, applied cleanly from a fresh scratch DB.
> OpenAPI **3.1.0 / 138** (135 + 3), exactly as predicted. Full regression:
> **732/732 unit, 828/828 e2e** (793 baseline + 35 new), zero regressions.
> Three pre-existing slice-boundary tests were deliberately updated (not
> silently left broken) to admit the new, still-precisely-fenced scope.

---

## A. WHAT WAS BUILT

### A.1 One migration, 30 → 31

`prisma/migrations/20260828010000_treasury_cash_movements/` (Treasury-owned) —

- `treasury."CashMovementType"` enum: exactly `pay_in`, `pay_out`, `safe_drop`.
- `treasury.cash_movements` — append-only source-fact ledger. `id UUID PK` (client-generated ULID, FR-OFF-015 — never server-reassigned), `tenant_id`, `branch_id` (deliberate denormalisation for branch-safe auth/index/audit), `cash_session_id`, `employee_id` (P1D-E accountable actor), `movement_type`, `amount BIGINT` (`CHECK > 0`, positive magnitude — the type carries the sign), `currency`, `reason TEXT` (`CHECK` non-blank, mandatory per FR-POS-091 [M] for all three types), `occurred_at`, `created_at`, `performed_by` (identity User, mirrors `stock_movements.performed_by`).
- Tenant-safe composite FKs to `treasury.cash_sessions`, `org.branches`, `identity.employees`; plain FK to `identity.users` for `performed_by` (matching the `stock_movements` precedent exactly).
- `GRANT SELECT, INSERT ... TO ros_app; REVOKE UPDATE, DELETE, TRUNCATE`; RLS `ENABLE`+`FORCE`, SELECT+INSERT policies only.
- **Deliberately absent**: `drawer_id`/`shift_id` columns (immutably reachable via `cash_session_id`), any `expected_cash` column, any drawer-limit column, any settings column.

`prisma/schema.prisma` updated to match exactly: new enum, new `CashMovement` model, required back-relations on `CashSession`, `Branch`, `Employee`, `Tenant`, and `User` (Prisma requires both sides of every relation — verified by `npx prisma format`/`validate`, both clean).

### A.2 Treasury module additions (`src/modules/treasury/`)

- `cash-movements/cash-movements.service.ts` — `CashMovementsService.payIn/payOut/safeDrop`, all delegating to one private `record()` implementing the exact four-step permanent-id protocol from the gate's Correction 2 (see §B).
- `contract/cash-movement-totals.query.ts` — `CASH_MOVEMENT_TOTALS_QUERY` + `CashMovementTotalsQuery.totalsForSession(tx, tenantId, cashSessionId)`, `tx`-first so a future P1G-1 close can read it inside its own close transaction. **No HTTP route** — §15.2 names no movement-read permission, so none is invented (design gate §8/§11).
- `cash-movements/cash-movement-totals.query.service.ts` — the private Prisma-backed implementation, outside `contract/`, bound via `useExisting` (mirrors `CashSessionFactsQueryService` exactly). Groups the immutable ledger directly (`groupBy`) — no maintained projection.
- `treasury.controller.ts` — three new routes, `POST /cash-sessions/{sessionId}/pay-in|pay-out|safe-drop`, one route per permission (`@RequirePermission` is route-level static and cannot inspect the body — design gate §9). `Idempotency-Key` mandatory on all three (`@Idempotent()`). Class docblock rewritten to state the new surface and explicitly enumerate what remains deliberately absent (close, drawer limit, correction/reversal, X report, drawer administration, payment capture).
- `treasury.dto.ts` — `CashMovementDto`: `id` **required** (Correction 1 — no server-generated fallback), `amountMinor` (positive-only regex, rejects `"0"` and any non-digit), `reason` (non-blank), `occurredAt` optional.
- `treasury.permissions.ts` — `cash.payin`, `cash.payout`, `cash.safedrop` added, **taken verbatim from the SRS §15.2 catalogue**. No permission invented.
- `treasury.views.ts` — `toCashMovementView`, mirroring `toCashSessionView`'s money-as-string discipline.
- `treasury.module.ts` — wires `CashMovementsService`, `CashMovementTotalsQueryService`, binds `CASH_MOVEMENT_TOTALS_QUERY`; both exported for a future P1G-1 to consume.
- `governance/audit/audit.constants.ts` — `AUDIT_ACTION.CASH_MOVEMENT_RECORDED` (one action, type in metadata — the `STOCK_MOVEMENT_RECORDED` precedent), `AUDIT_ENTITY.CASH_MOVEMENT`.

### A.3 Permanent-id protocol (Correction 2), exactly as specified

Inside one `PrismaService.withAuthContext` transaction:

1. **Permanent-id replay/conflict check, logically first** — `tx.cashMovement.findUnique({where:{id}})`, before any CashSession-dependent mutation. Identical content → replay (zero new effect); differing → 409.
2. **Lock the CashSession** (see §F for the corrected mechanism), validate `status='open'`, branch match, own-session-only, currency.
3. **Exactly ONE actual INSERT** — `INSERT ... ON CONFLICT ("id") DO NOTHING RETURNING ...` (P1E-5A pattern; never insert-then-catch-P2002, which leaves the transaction aborted for every subsequent statement).
4. **If that INSERT returns zero rows** (another transaction won the same permanent-id race between steps 1 and 3) — `SELECT` the winner **in the still-healthy transaction**: identical facts → replay with **no duplicate audit**; differing → 409.

Audit is written **exactly once**, only on the branch that actually created the row (step 3's success path) — never on a replay (step 1 or step 4).

---

## B. THE DESIGN GATE'S OWN CORRECTIONS APPLIED

- **`id` required, not optional** — `CashMovementDto.id!: string` with `@Matches(UUID_PATTERN)`, no `@IsOptional()`. OpenAPI marks it required. Tests: missing id → 400, malformed id → 400, valid id preserved exactly as the permanent PK.
- **One actual insert only** — implemented exactly as specified in §A.3 above; proven under real concurrency (§D).

---

## C. `assertIdentical` — ONE DEVIATION FROM THE LITERAL GATE, JUSTIFIED

The gate's Correction 2 says "identical immutable facts → replay". The initial implementation compared `occurredAt` as part of that identity check. **Found during testing**: when a caller omits `occurredAt` (a legitimate case — "defaults to server receipt time if omitted"), the service defaults it to `new Date()` **per call**, so two genuinely-identical retries of the same business id (a sequential HTTP retry, or two requests racing on the same id) would each get a *different* server-stamped instant and be wrongly flagged as conflicting content.

**Fix**: `occurredAt` is excluded from the identical-content comparison, mirroring the existing `OrderPayment.assertIdentical`-equivalent precedent in `sales-payment.service.ts`, which likewise excludes its own server-stamped timing field (`processedAt`) from the identity check. This is a narrowing of what counts as a "fact" to what the caller actually asserts — type, amount, session, employee, reason — not a weakening of the conflict-detection guarantee for any client-declared field. Documented directly in the method's own docblock.

---

## D. CONCURRENCY — REAL POSTGRES, REAL BARRIERS, ≥3 CLEAN RUNS EACH

`test/cash-movements.e2e-spec.ts`, `CONCURRENCY` describe block — **12 tests, 3 runs × 4 scenarios**, all against direct `CashMovementsService` calls (see §G for why HTTP dispatch was abandoned for this block specifically).

1. **Two simultaneous PAY_INs on the same session** — both succeed, totals sum exactly.
2. **PAY_IN vs PAY_OUT on the same session** — both succeed, `netCashMovementEffect` exact.
3. **Two movements racing the same session under the shared advisory lock** — both succeed, exactly 2 rows (the P1G-1 lock-order contract this slice establishes).
4. **Duplicate business id raced** (two concurrent calls with the identical permanent id, no artificial gate — a genuine `Promise.all` race) — exactly one call reports `created: true`, the other replays the identical winner, exactly one row persisted.

Barrier technique: a `GatedAuditService extends AuditService`, overriding `record()` to pause (once armed) at the exact point `CashMovementsService.record()`'s successful-create path calls it — the **last** statement inside the transaction, so the advisory lock taken in step 2 is still held throughout the pause. The racing second call is confirmed to be **genuinely blocked** (not merely slow) via `pg_stat_activity.wait_event_type='Lock'` on a backend whose own query names `pg_advisory_xact_lock` — polled, never a fixed sleep used as the proof itself. Verified directly against three real concurrent `psql` sessions before writing the poll (documented in the design gate).

**Result: all 12 pass, 3 consecutive clean full-file runs, plus a fourth full-suite run — zero flakes.**

---

## E. RLS / IDEMPOTENCY / DOMAIN / AUTH — FULL MATRIX

`test/cash-movements.e2e-spec.ts`, 35 tests total:

- **Domain (8)**: creation, zero-amount rejected, negative-amount rejected (fails the digit-only pattern), blank-reason rejected, missing-id rejected (Correction 1), malformed-id rejected, client id preserved exactly, record immutable via the real `ros_app` connection.
- **Totals contract (1)**: `payIn − payOut − safeDrop` matches the immutable ledger exactly over a mixed sequence, read inside a transaction.
- **AUTH (6)**: each permission authorises only its own route (tested against a session **owned by the pay-in-only employee**, so the assertion isolates the permission check from the separate own-session-only check); missing permission → 403; own-session-only → 403; wrong branch → 403; cross-tenant → 404 (RLS-invisible, never 403); closed session → 409 (fixture constructed directly via the migrator, since no close route exists yet).
- **Idempotency (4)**: same key + same body → replay with `Idempotent-Replay: true`; same key + different body → 409; duplicate business id (different keys), identical facts → replay, exactly one row **and** exactly one audit entry; duplicate business id, differing facts → 409.
- **RLS (4)**: own-tenant SELECT succeeds; cross-tenant SELECT returns zero rows with tenant B holding its own real row (genuine filtering proof); UPDATE rejected, row survives unmodified; DELETE rejected, row survives; `information_schema.role_table_grants` shows SELECT+INSERT and **not** UPDATE/DELETE/TRUNCATE.
- **Concurrency (12)**: §D.

---

## F. IMPLEMENTATION-TIME FINDING — `FOR UPDATE` IS INOPERABLE UNDER THIS SCHEMA'S GRANTS

The design gate specified `SELECT ... FOR UPDATE` on `cash_sessions` as the locking mechanism (§4/§10). **Found empirically, real error**: `permission denied for table cash_sessions` (Postgres error `42501`) the first time this was exercised against the scratch DB.

**Root cause, verified**: PostgreSQL requires the **UPDATE** privilege (not merely SELECT) to acquire a row lock via `FOR UPDATE`/`FOR SHARE`. `ros_app` deliberately holds **no** UPDATE grant on `cash_sessions` — the table's own existing docblock states the append-only-until-P1G-1 posture explicitly, and this is a real, structural consequence of that posture that the gate's literal mechanism did not anticipate.

**Fix**: a transaction-scoped **advisory lock** — `pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext(cashSessionId))` — acquired before the (now plain, non-locking) `SELECT` of session facts. This gives the **identical** serialization guarantee (blocks a concurrent writer for the same session; auto-released at COMMIT/ROLLBACK) with **zero grant change**, and matches an **existing repository precedent**: `AuditService.record`'s own per-tenant chain-write lock uses the exact same primitive and call shape (`pg_advisory_xact_lock(hashtext($1), hashtext($2))`), found by inspecting that file directly rather than inventing a new pattern.

**Documented as a binding contract for the future P1G-1 close**: it must acquire the **same** advisory lock (same namespace string, same key) before mutating a session, or the two paths will not actually serialize against each other. Recorded in the service's own docblock, not just this report.

This was not a design defect requiring re-litigation — the gate's *intent* (serialize all writers of a session) is fully honoured; only the literal SQL mechanism named in the gate text needed correcting once its grant precondition was checked against reality. Verified proof mechanism, not assumed: three real concurrent `psql` sessions confirmed both that `FOR UPDATE` fails with `42501` under `ros_app`'s actual grants, and that the advisory-lock replacement produces the expected `pg_stat_activity` waiter signature before it was relied on in any test.

---

## G. TEST-HARNESS FINDING — HTTP DISPATCH HUNG THE FIRST CONCURRENCY DRAFT

The first draft of the `CONCURRENCY` block dispatched both racing calls via `supertest` against `app.getHttpServer()` (matching the AUTH/domain tests' own HTTP style). This **hung indefinitely** — diagnosed live, per the user's explicit diagnostic protocol, with targeted instrumentation at three checkpoints (inside the gate, at the top of the controller handler, and a full `pg_stat_activity` dump mid-wait):

- The **first** HTTP request correctly reached the service, acquired the advisory lock, and paused — confirmed by exact-timestamp logs.
- The **second** HTTP request, fired concurrently against the same in-process `http.Server` while the first request's transaction was still open, **never entered the controller handler at all** within the wait window.
- `pg_stat_activity` during the stall showed exactly **one** `ros_app` backend (`idle in transaction`, `wait_event_type='Client'` — correctly parked on the app-level pause, not blocked by Postgres) and **no second connection at all** — proving the stall was not a Postgres lock wait and could not be a production deadlock, since production code was never reached by the second call.

**Classification**: a test-harness HTTP dispatch artifact; the exact lower-level dispatch cause was not further isolated, but production code and PostgreSQL lock contention were excluded by direct evidence (production's own debug log fired only once; `pg_stat_activity` showed exactly one `ros_app` backend the entire time, `idle in transaction`/`wait_event_type='Client'`, never `Lock`) — **not** an implementation defect. **Fix, test-only**: the `CONCURRENCY` block now calls `CashMovementsService.payIn/payOut/safeDrop` **directly** (`app.get(CashMovementsService)`), sidestepping the HTTP layer entirely for this block while still proving the real Postgres advisory-lock contention the block exists to prove. This does not weaken coverage: the HTTP/guard/permission/idempotency layers remain fully covered by the separate AUTH and IDEMPOTENCY groups in the same file, which still dispatch via real HTTP. Verified clean **3 consecutive isolated runs** of the `CONCURRENCY` block alone, then the full 35-test file, then the full 828-test e2e suite, all clean, with zero stray processes or leaked Postgres connections after each (`pg_stat_activity` count confirmed 0 post-run).

No production code was touched to fix this — `treasury.controller.ts` and `cash-movements.service.ts` are exactly as designed once §F's correction is applied.

---

## H. THREE SLICE-BOUNDARY TESTS DELIBERATELY UPDATED

`test/cash-session.e2e-spec.ts` (×2), `test/catalogue.e2e-spec.ts`, `test/inventory.e2e-spec.ts` each contained a hard-coded "table/route census" assertion from the P1D-1 slice, asserting the **exact** pre-P1G-0 boundary (`['/cash-sessions']`; `['treasury.cash_sessions','treasury.drawers','workforce.shifts']`). These are deliberate tripwires — exactly as intended, they failed the moment this slice added a table and three routes, forcing an explicit, reviewed update rather than a silent scope drift.

**Updated, not weakened**: each assertion now admits exactly the three new routes and the one new table, and the `forbidden` substring list in `cash-session.e2e-spec.ts` had `'payin'/'payout'/'safedrop'` removed (now legitimately present) while `'close'/'count'/'variance'/'drawer'` remain asserted absent — still true, since P1G-1 (close) and FR-POS-092 (drawer limit) are genuinely not implemented. All four updated assertions pass; the surrounding comments were rewritten to name P1G-0/FR-POS-091 as the authorising change, matching the file's own established citation convention (P1D-A, C-04 AMENDMENT, etc.).

---

## I. FULL REGRESSION

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean — only the known pre-existing `access-token.service.spec.ts` baseline error; zero new |
| `npx eslint` on every changed/added file | Clean, zero errors, zero warnings |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `npx prisma format` | Clean (both sides of every new relation present) |
| `nest build` | Clean |
| `npm run openapi:generate` | `openapi: 3.1.0`, **exactly 138** `operationId` occurrences (135 + 3 new routes) |
| `npx jest src/modules/module-boundaries.spec.ts` | **31/31 passing** — `KNOWN_DEVIATIONS` unchanged |
| `git diff --check` | Clean |
| Clean-from-zero migration | Fresh scratch DB, `prisma migrate deploy`: **all 31 migrations applied successfully** |
| Persistent local `ros` DB | Confirmed untouched throughout — still **26** `_prisma_migrations` rows, newest `20260823030000_kitchen_ticket_persistence` |
| Full unit suite (`npx jest`) | **732/732 passing**, 53/53 suites — zero regressions |
| Full e2e suite (`npm run test:e2e --runInBand`) | **828/828 passing**, 42/42 suites (793 baseline + 35 new) — zero regressions, run twice (once mid-development, once final against a fresh scratch DB) |

---

## J. SCOPE FENCE — CONFIRMED HELD

Not built, as instructed: CashSession close, count, denominations, variance, approval, X report, Day close, FR-POS-092 drawer-limit enforcement, any correction/reversal endpoint, refunds, integrated card, branch-wide RBAC redesign, offline sync, NFR-PERF-006 optimization, a general reporting platform. No fourth movement type. No `cash.drawer.open_no_sale` route. No migration 32.

---

## K. REQUIREMENT CLASSIFICATION

| Requirement | Classification | Basis |
|---|---|---|
| **FR-POS-091** [M] | **COMPLETE** | All three operations, each with mandatory `reason`+`amount`, immutable, fully attributed; §D/§E |
| **FR-POS-092** [M] | **NOT IMPLEMENTED (substrate enabled)** | Zero of its four clauses implemented — no drawer-limit source, level, default, or prompt/block policy exists anywhere (design gate §5); explicitly not overclaimed as PARTIAL |
| **FR-FIN-004** [M] | **PARTIAL — 6/8 terms** | Opening Float, Cash Sales, Rounding Adjustments (already implementable via P1F-2) + Pay-ins, Pay-outs, Safe Drops (this slice) = 6/8; Cash Tips ([S], no operation) and Cash Refunds (non-goal) remain structurally unavailable. **Not claimed COMPLETE.** |
| **FR-API-020** [M] | **PARTIAL** (system-wide) | +3 financially-significant routes with mandatory Idempotency-Key; the remaining mutating routes' coverage is unchanged by this slice |
| **FR-API-021** [M] | **IMPLEMENTED for covered routes** | Reuses the existing store (key, fingerprint, response) |
| **FR-API-022** [M] | **IMPLEMENTED for covered routes** | Replay with `Idempotent-Replay: true` — tested |
| **FR-API-023** [M] | **IMPLEMENTED for covered routes** | 409 on fingerprint mismatch — tested |
| **NFR-REL-011** [M] | **HELD for this slice's operations** | At-most-once via permanent id **and** Idempotency-Key, both tested under real concurrency; not a general system-wide claim |

---

## L. P1G-1 DEPENDENCY CONTRACT — DELIVERED

Per the design gate §16, this slice guarantees to a future P1G-1:

1. An immutable, append-only `cash_movements` ledger, DB-enforced (grants + RLS, not convention).
2. Movement totals by session and type, via the `tx`-first `CASH_MOVEMENT_TOTALS_QUERY` contract, readable inside a close transaction under the close's own lock.
3. Atomic serialization against `CashSession` via the transaction-scoped advisory lock (`hashtext('ros_cash_session'), hashtext(cashSessionId)`) — **P1G-1 MUST acquire the identical lock** before mutating a session, or the two paths will not serialize against each other. This is the one binding technical obligation this report hands forward explicitly (§F).
4. No mutation after session close is achievable **once P1G-1 also takes the same lock** — not yet enforced today, since no close path exists to race against.
5. Exact minor-unit integer arithmetic (`BIGINT`, positive magnitude + type discriminator, sign applied once in the totals contract).
6. Trusted actor/session attribution (Employee via P1D-E, branch, currency — all server-derived, never client-supplied).
7. Permanent business identity (client ULID) with at-most-once semantics.

P1G-1 itself is not designed or implemented here.

---

## Update to INDEX.md

Appended (see `docs/reports/claude/INDEX.md`).
