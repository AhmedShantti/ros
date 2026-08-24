# P1E-6A — Fire Acceptance Correction

**Date:** 2026-08-24
**Branch:** `main` (tracking `origin/main` — pre-existing state at session start, not created or renamed by this session; record-only per the task's explicit branch-safety instruction, no branch operation performed)
**HEAD at start and end (unchanged — no commit made):** `01c0b0f3d3228af5248782a09e8dc0bc65606f9e`
**Slice:** P1E-6A — CORRECTION. A narrow acceptance-review correction of seven specific defects found in the P1E-6 report. P1E-6's core Fire implementation (permission, route, `assertMayFire`/`assertTransition`/`assertVersion` reuse, DRAFT→OPEN + `order.opened`, `order.line.fired` payload architecture, both public Fire-facts contracts, the 5 routing tiers, multi-station, Ticket/FireBatch/TicketLine persistence, same-UoW Kitchen transaction, audit design, CAS version-write strategy, OpenAPI route) is **ACCEPTED and was not reopened** — every change in this report is additive/corrective to one of the seven named defects, nothing else.
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of correction work performed in
this session. The ROS SRS and ratified governance decisions remain the sole
authority on what the system is *supposed* to be. §O's classification table
is a truthful statement of what is verified to work today, not a claim that
broader requirements (Payment, completed sale, standard-role RBAC seeding)
are satisfied.

---

## A. STARTING STATE

- Baseline: the accepted P1E-6 implementation, HEAD `01c0b0f3d3228af5248782a09e8dc0bc65606f9e`, uncommitted (the P1E-6 report and all its code/test changes remain untracked/modified working-tree state — confirmed via `git status` before any P1E-6A edit).
- Branch: `main`, tracking `origin/main` (the same discrepancy the P1E-6 report already recorded as a pre-session external rename, content-identical to `feat/production-spec`). No branch operation performed in this session.
- 26 migrations, unchanged at session start.
- 132 OpenAPI operations, unchanged at session start.
- No `git stash`/`reset`/`checkout`/`restore`/`clean`/`rebase` used anywhere in this session. No commit, no push.

---

## B. DEFECT A — IDEMPOTENCY RESOURCE IDENTITY

**Root cause.** `IdempotencyInterceptor.intercept()` computed the fingerprint's
`path` input from Express's **registered route pattern**
(`(request as {route?:{path?:string}}).route?.path`, e.g.
`/orders/:businessDay/:id/fire`), preferring it over the **resolved** request
path (`request.path`, e.g. `/orders/2026-08-24/ord_123/fire`). Since Fire's
request body is empty by design (P1E-6 §6 MVP requirement), two calls to Fire
**different orders** with the same Idempotency-Key hashed to the *identical*
fingerprint (`{method, path: <pattern>, body: null}` collapses the order id
entirely) — the second call incorrectly replayed the first order's stored
response instead of either firing the second order or 409-conflicting.
`POST /orders/:businessDay/:id/lines` carries the same route-pattern
structure and was exposed to the identical class of collision whenever two
different orders' first line-add shared a key and an identical body.

**Fix (one line, `src/common/idempotency/idempotency.interceptor.ts`).**
`routePath` now comes from `request.path` (the resolved path) instead of
`request.route?.path` (the registered pattern). This single change fixes
*both* derived values that feed the mismatch/replay decision — `endpoint`
(`${request.method} ${routePath}`, used in `reserve()`'s FR-API-023 mismatch
check) and the `fingerprint` hash input — since both were built from the same
`routePath` variable. `IdempotencyService.fingerprint()`'s own signature is
**unchanged** (still 3 args: `method, path, body`); no second/Fire-specific
idempotency mechanism was built, per the task's explicit instruction.

**Query parameters (§2.2).** Verified none of the four currently-idempotent
routes (`POST /orders`, `POST .../lines`, `POST .../fire`, `POST
/cash-sessions`) has query-string-dependent semantics. `request.path` itself
never includes the query string (Express excludes it by construction), so no
canonicalization code was added — there is nothing to canonicalize today.
Flagged for future awareness only: a future idempotent route that *does* use
semantically-relevant query parameters would need an explicit extension at
that time.

**Stored/in-flight key compatibility assessment (§D).** The `identity.
idempotency_keys` table stores `(tenant_id, key, endpoint, fingerprint,
response_*)`. Both `endpoint` and `fingerprint` change their *computed value*
under this fix (same formula, different `path` input) for any row whose
route has a path parameter (Fire, line-add) — rows for `POST /orders` and
`POST /cash-sessions` are **numerically unaffected** (no path parameter to
substitute, so `request.path === request.route.path` for those two routes
always). Practical effect for the two affected routes: a row **reserved
before this fix and not yet completed** at deploy time would, on retry after
deploy, compute a *different* fingerprint/endpoint than what was stored —
`reserve()`'s mismatch check (`existing.fingerprint !== fingerprint ||
existing.endpoint !== endpoint`) would treat the retry as a **conflicting
request** (409) rather than either a correct replay or silently succeeding
twice. This is the **safe direction of failure** — it fails closed (a 409
asking the caller to retry with a fresh key) rather than either a silent
double-effect or an incorrect cross-resource replay. No stored row is ever
financially replayed against the wrong resource as a result of this
deployment transition. Given the 30-day-minimum retention window (FR-API-021)
and that Fire/line-add idempotency keys are short-lived, single-attempt
values in practice (not long-parked), the narrowest safe strategy — **no
migration, no backfill, ship the fix as-is** — was chosen; a broader backfill
would require recomputing fingerprints from data the table does not retain
(the original request body), which is not possible and not necessary given
the fail-closed direction.

**Regression tests (A–J), all real HTTP through the real interceptor:**

| # | Proof | Location |
|---|---|---|
| A | `POST /orders`: same key + same body still replays (FR-API-022) | `test/sales.e2e-spec.ts` — pre-existing, re-verified unmodified |
| B | `POST /orders`: same key + different body still 409s (FR-API-023) | `test/sales.e2e-spec.ts` — pre-existing, re-verified unmodified |
| C | `POST .../lines`: same key + same body still replays, one line only | `test/sales-lines.e2e-spec.ts` — pre-existing, re-verified unmodified |
| D | `POST /cash-sessions`: same key + same body still replays | `test/cash-session.e2e-spec.ts` — pre-existing, re-verified unmodified |
| E | Same key reused on a genuinely different endpoint still 409s | `test/sales.e2e-spec.ts` (idempotency-foundation block, service-level) — pre-existing, re-verified unmodified |
| F | **NEW** — Fire: same key across two *different* orders now 409-conflicts, never replays order X onto order Y | `test/sales-fire.e2e-spec.ts`, rewritten (was the P1E-6 "DISCOVERED BEHAVIOUR" test documenting the bug; now proves the fix) |
| G | **NEW** — order-lines: same key + identical body across two *different* orders now 409-conflicts, orderTwo gets zero lines, zero version bump | `test/sales-lines.e2e-spec.ts`, new test |
| H | Order Y (the second/rejected party in F/G) is left completely untouched — no state change, no version bump | asserted inline in F and G |
| I | Order X's own response body never leaks onto order Y's response | asserted inline in F |
| J | No duplicate Ticket/FireBatch/TicketLine from either scenario | pre-existing single-Fire tests already prove one-Ticket-per-Fire; F additionally confirms order Y produces zero Kitchen rows since its Fire never ran |

Business-day differentiation (a named item in the task) was assessed and
found to have no distinct realizable scenario beyond "different order":
`businessDay` is part of an order's own composite identity
(`orders(id, business_day)`), so two different business days always
necessarily mean two different orders — exactly what test F already proves.

All ten proofs pass; full results in §M.

---

## C. DEFECT B — FIRE LEGAL SOURCE STATES

**Root cause.** `assertMayFire()` (`order-state.ts`) permits Fire from any
non-finalised `OrderState` — by design, for the *general* state machine,
`held`/`parked` are legitimate operational states. But the MVP **explicit
Fire command** (this slice) only actually implements two transitions:
DRAFT→OPEN (first Fire) and OPEN→OPEN (amendment Fire). Firing a `held` or
`parked` order was previously accepted and would silently proceed through
the full Fire pipeline (CAS write, Kitchen consequence, audit, event) with no
domain error at all.

**Fix, narrowly scoped to Fire's own command file — `order-state.ts` was NOT
touched.** `src/modules/sales/orders/fire.errors.ts` gained
`IllegalFireSourceStateError extends OrderStateError` (so
`SalesDomainExceptionFilter`'s existing `@Catch(OrderStateError, ...)` maps
it to 422 with zero filter changes — the same mechanism
`OrderVersionConflictError`/`NoEligibleLinesToFireError` already use).
`SalesFireService.fire()` now checks, immediately after loading the order and
**before** calling `assertMayFire` (and before any mutation, event, audit, or
Kitchen work):

```
if (order.state !== 'draft' && order.state !== 'open' && !isFinalised(order.state)) {
  throw new IllegalFireSourceStateError(...);
}
assertMayFire(order.state, order.orderType, order.tableId);  // unchanged call
```

Ordering is deliberate: a genuinely **finalised** order (`completed`,
`cancelled`, `partially_refunded`, `refunded`) still falls through to
`assertMayFire`'s own, pre-existing, more specific BR-POS-001 message
("...can no longer be modified...") — verified unchanged by a dedicated test.
Only the *remaining* non-finalised-but-not-draft/open states (`held`,
`parked`, `partially_paid`) hit the new guard. `assertMayFire` itself,
`TRANSITIONS`, and `FINALISED` in `order-state.ts` are byte-for-byte
unchanged — `held`/`parked` remain fully legal everywhere else in the system
(e.g. `assertMayAddLine` still allows `held`).

**Tests, `test/sales-fire.e2e-spec.ts`, new describe block "Fire legal source
states (P1E-6A Defect B)":**

- HELD → 422, and the attempt makes zero changes: order state/version
  unchanged, line stays `pending` with `firedAt: null`, zero new
  `ORDER_FIRED` audit rows, zero new `order.opened` events, zero Ticket rows.
- PARKED → 422, same full-rollback proof.
- DRAFT still succeeds (first Fire unaffected by the new guard).
- OPEN still succeeds (amendment Fire unaffected — draft→open then a second
  fire on the same now-open order both return 200).
- A finalised (`completed`) order still gets `assertMayFire`'s own
  `BR-POS-001` message, not the new guard's message — proves the ordering
  decision above is correct, not merely untested.

All five pass; full results in §M.

---

## D. DEFECT C — DINE-IN SERVICE REFERENCE MUST RESOLVE

**Root cause.** `SalesFireService.fire()`'s Organisation table-display lookup
silently set `serviceReference = null` whenever `TableDisplayQuery.find()`
returned `null` for a present, non-null `tableId` — indistinguishable, in the
resulting Kitchen ticket, from a table that legitimately resolved to no
label. Only a genuinely **absent** `tableId` should defer to
`assertMayFire`'s existing FR-POS-003 rejection ("a dine-in order requires a
table assignment before it can be fired"); a **present-but-unresolvable**
`tableId` is a data-integrity problem, not that case.

**Fix (`sales-fire.service.ts`).** A new `UnresolvedServiceReferenceError
extends OrderStateError` (`fire.errors.ts`, same 422 mapping mechanism as
Defect B). When `order.orderType === 'dine_in' && order.tableId` and
`this.tableDisplay.find(...)` returns `null`, Fire now throws instead of
defaulting to `null` — full transaction rollback, no mutation/event/audit/
Kitchen work survives (same `UnitOfWork.execute()` transaction as everything
else in Fire, so this is "free" — no new rollback mechanism was built).

**A real database constraint changes what "unresolvable" can mean in
practice.** Investigating how to construct a dangling `tableId` for the test
surfaced a pre-existing DB-level guarantee: `sales.orders` carries a real
composite FK, `orders_branch_id_table_id_fkey FOREIGN KEY (branch_id,
table_id) REFERENCES org.tables(branch_id, id) ON DELETE RESTRICT`
(migration `20260820120000_sales_order_foundation`). This means:

- A **syntactically nonexistent** `tableId` can never be attached to an
  order at all — `OrdersService.create()`'s insert fails the FK outright.
- A **cross-branch/cross-tenant** `tableId` can never be attached either —
  the FK requires the table to belong to the *same branch* as the order, and
  branch is itself tenant-scoped (derived server-side from the terminal, not
  client input) — so a genuinely cross-tenant attachment is structurally
  impossible, not merely RLS-hidden.
- A table row that **was** validly attached can never be deleted out from
  under the order afterward — `ON DELETE RESTRICT` blocks the delete while
  any order still references it, for the order's entire lifetime.

So the scenario Defect C describes — an order whose `tableId` is present but
does not resolve — **cannot occur today through any code path**, service or
raw-admin. The fix is genuine defense-in-depth (e.g. against a future RLS
policy change, or a future relaxation of this FK), not a fix for a reachable
bug. This is reported honestly rather than silently declaring the scenario
untestable: the test proves the *service's own handling* of an unresolved
result via a test-only DI seam — the existing, already test-swappable
`TABLE_DISPLAY_QUERY` public-contract token (`TestingModule.overrideProvider`)
is bound to a stub that delegates to the real one-line Prisma lookup for
every table id **except** ids a given test opts into a
`simulateUnresolvedTableIds` set, which it reports as unresolved regardless
of the row's real (FK-valid) existence. This is not a new production hook —
it reuses an injection point P1E-6 already built for a different reason.

**Tests, `test/sales-fire.e2e-spec.ts`, new describe block "dine-in service
reference resolution (P1E-6A Defect C)":**

- An unresolvable tableId (DI-simulated) → 422, full rollback (order stays
  `draft`, version unchanged, line stays `pending`, zero `order.opened`
  events, zero Ticket rows).
- A valid tableId still resolves and reaches Kitchen unaffected — the real
  (non-stubbed) path: `Ticket.serviceReferenceSnapshot` carries the real
  `org.tables.label` (`'T1'`), line fires normally.
- Non-dine-in still succeeds with `serviceReference = null`, unaffected.

The originally-planned separate "cross-tenant table" test was **not**
written as a distinct case, since the FK proves it collapses into the exact
same "unresolvable" branch already covered by the DI-simulated test above —
writing a second test for a structurally-impossible precondition would have
tested nothing new. This is recorded as a finding, not a gap.

All four pass; full results in §M.

---

## E. §G — STANDARD ROLE CLASSIFICATION CORRECTION

The P1E-6 report's own framing is corrected here, in text only — no new
subsystem, no migration, no ratified-policy change:

- **`pos.order.fire` permission code implemented: YES** — defined in
  `SALES_PERMISSIONS`/`SALES_PERMISSION_DEFS`, enforced by
  `@RequirePermission(SALES_PERMISSIONS.ORDER_FIRE)` on the Fire route.
- **Manual Fire enforcement: YES** — proven end to end (an actor with
  `pos.order.create` but without `pos.order.fire` gets 403 on Fire; an actor
  with it reaches Fire's business logic).
- **Standard Waiter/Cashier SHIPPED grant: NO — a pre-existing FR-SEC-010
  gap, unchanged by this slice.** No module's permission catalog has ever had
  a production migration/seed path that assigns permissions to a
  standard/default role (confirmed repository-wide in P1E-6, re-confirmed
  here, not re-investigated further since nothing changed) — this is not
  specific to Fire and this session did not build one.
- **The dev seed script does NOT satisfy FR-SEC-010.** `src/scripts/
  seed-dev-data.ts`'s `Cashier` role now also receives `pos.order.fire`
  (previously it had `pos.order.create`/`pos.order.void_line_prefire` only,
  meaning the seeded dev Cashier — the one role a local developer actually
  exercises — could not fire an order at all, a real local-dev usability gap
  now closed). This is a **local-only convenience seed**, explicitly not a
  production RBAC migration; it does not create, alter, or seed any
  `identity.roles`/`identity.role_permissions` row in any real tenant, and is
  called out in code with a comment saying exactly that.

The ratified governance policy (Fire Authorization Ratification —
2026-08-24) is unchanged; nothing here removes or reinterprets it.

---

## F. §5 — DETERMINISTIC FIRE CONCURRENCY PROOF

**Why the P1E-6 proof was insufficient.** `sales-fire.e2e-spec.ts`'s existing
optimistic-concurrency test issues two HTTP requests via `Promise.all` — this
proves *an* observable outcome (one 200, one 409) but cannot prove *both*
requests' underlying database transactions read the **same starting
version** before either wrote; a sufficiently unlucky interleaving could in
principle let the second request's read happen after the first's write,
which would still produce the same HTTP outcome without ever exercising the
actual race the CAS is meant to guard against.

**New file: `test/sales-fire-concurrency.e2e-spec.ts`.** Mirrors
`kitchen-ticket-concurrency.e2e-spec.ts`'s established P1E-5A pattern: call
the real application service directly (`app.get(SalesFireService)`, no
HTTP), open two genuinely independent calls, and synchronize them with an
explicit **barrier** (`makeBarrier(2)` — releases only once both parties have
arrived; no `sleep`, no timing assumption) so both are guaranteed to have
completed their own read (and derived their own `nextVersion`) before either
is allowed to proceed to its write.

**The seam.** `SalesFireService.fire()` has no test hook and none was added.
Instead, this suite overrides `CATALOGUE_FIRE_FACTS_QUERY` — an *existing*,
already test-swappable public-contract injection point from P1E-6 — with a
`BarrierAwareCatalogueFireFacts` stub that awaits a test-supplied barrier
before resolving (empty facts; the test does not need real Catalogue data).
Fire calls this exact dependency **strictly after** loading the order and
computing `nextVersion` from its own read (`assertVersion`), and **strictly
before** the CAS `updateMany` — verified by reading `sales-fire.service.ts`'s
own statement order (§B of the P1E-6 report; unchanged in P1E-6A). Pausing
there is pausing exactly "after the read, before the write," with **zero
production code changes** — no new hook, no retry logic added to
`SalesFireService`.

**Proof mechanics.** Both concurrent `fire()` calls are given the *same*
`expectedVersion` (read once, before either participant starts — modelling
"both clients loaded the order, then both tried to Fire it"). Because
neither can proceed past the barrier until *both* have independently
completed their own order read and version computation, and neither has
written yet at that point, both necessarily observe the same starting
version under READ COMMITTED — this is the deterministic guarantee the task
required, not a probabilistic one.

**Required post-conditions, all asserted and passing:**

- Exactly one `Promise.allSettled` result fulfils; exactly one rejects with
  `OrderVersionConflictError`.
- `Order.version` bumped exactly once (`raceVersion + 1`, not `+2`).
- Exactly one `Ticket` row for the order (not two).
- Exactly one `TicketLine` (one line, one expected station).
- Exactly one `TicketFireBatch`.
- Exactly one `ORDER_FIRED` audit entry (not two).

Run five consecutive times during verification with zero flakiness (§M).

---

## G. §6 — KITCHEN E2E FIXTURE HYGIENE

**Root cause, confirmed by direct timestamp inspection of the persistent dev
database (not merely inferred):** `test/kitchen-ticket-persistence.e2e-spec.
ts` and `test/kitchen-ticket-concurrency.e2e-spec.ts` each create an
`org.branches` row directly via the raw migrator client (`admin.branch.
create`) with **no matching `org.locations` registry row** — every other
fixture helper in the repository that creates a branch this way (e.g.
`sales-fire.e2e-spec.ts`'s own `mkBranch`) already pairs it with a matching
`admin.location.create(...)`. `organisation.e2e-spec.ts` carries an
invariant test, `'leaves no org location entity without a registry row'`,
that fails whenever such an orphan exists anywhere in the database at query
time — so running the full suite (Kitchen files, then Organisation's own
file) reliably tripped it.

**Fix.** Both files now create the matching `org.locations` row
(`locationType: 'branch', refId: branchA, branchId: branchA`) immediately
after their existing `admin.branch.create(...)` call — no other fixture
change, no weakening of the invariant test itself.

**Verification, via direct SQL, not assumption.** Queried the persistent
`ros` database for every `org.branches` row missing a matching
`org.locations` row, ordered by `created_at`: **10 orphan rows exist, all
timestamped 2026-08-23 or earlier-this-session (2026-08-24 11:00–11:26 UTC)
— i.e., all from *before* this fix was applied**, across this and the prior
P1E-6 session's own repeated full-suite verification runs. Re-ran both
Kitchen suites *after* the fix and queried again: the newest `KT`/`KR`-coded
branch rows (created 2026-08-24 12:07 UTC, after the fix) **do** have a
matching location row (`has_location: t`), while the 10 pre-fix rows remain
exactly 10 — the fix stops new orphans from being created; it does not (and
per the task's explicit instruction, must not) retroactively delete
historical rows from the user's persistent database.

Consequence: `organisation.e2e-spec.ts`'s invariant test still fails on the
**persistent** `ros` database (10 pre-existing orphans, not from this
session's fix) but passes cleanly on the **clean scratch database** (§H) —
proving the fix is complete and correct, with the residual persistent-DB
failure being purely historical contamination this session was explicitly
told not to delete.

---

## H. §7 — CLEAN TEMPORARY DATABASE VERIFICATION

A dedicated database, `ros_p1e6a_scratch`, was created (via `createdb`,
connecting as `ros_migrator`) distinct from the persistent `ros` dev
database. All 26 existing migrations were applied from zero via `prisma
migrate deploy` against it — all 26 applied cleanly, no errors, no manual
intervention.

**A real setup mistake, found and fixed before trusting any result.** The
first full-suite attempt against the scratch database failed nearly every
test with `Foreign key constraint violated on the constraint:
brands_tenant_id_fkey`. Root-caused by direct inspection of
`PrismaService`'s constructor (`src/prisma/prisma.service.ts:37`): the
**application's own** runtime Prisma client connects via
`config.getOrThrow('APP_DATABASE_URL')` — a *separate* environment variable
from the plain `DATABASE_URL` the raw-migrator test fixture client
(`createMigratorClient`) and `prisma migrate deploy` both use. Overriding
only `DATABASE_URL` pointed migrations and raw fixture setup at the scratch
database while the application itself (everything called through a NestJS
service, e.g. `TenantsService.create()`) kept writing to the **persistent**
`ros` database — so `admin.brand.create()`'s FK check against the scratch
database correctly found no matching tenant row, because the tenant was
never created there at all. Confirmed directly: querying the scratch
database found zero rows matching the test run's tenant slug pattern.
Fixed by exporting **both** `DATABASE_URL` and `APP_DATABASE_URL`
(preserving each variable's own distinct role/credential — `ros_migrator` for
the former, `ros_app` for the latter) pointed at `ros_p1e6a_scratch`; re-run
succeeded cleanly. Recorded here in full because it is exactly the kind of
finding that would otherwise silently produce a false "verified clean" claim.

**Full results, both suites, against the clean scratch database, both
env vars correctly scoped:**

- Unit: **708/708 passing** (identical to the persistent-DB run — unit tests
  do not touch a real database).
- E2E (`--runInBand`, full suite, no filter): **679/679 passing, 32/32
  suites — 100%.** This includes `organisation.e2e-spec.ts`'s location
  registry invariant test, which **passes** here (zero orphans, since only
  the now-fixed fixture code ever ran against this database) — direct proof
  that §G's fix is complete, not merely locally consistent.
- No credential was printed at any point in this verification (connection
  strings were only ever passed via shell-scoped environment variables,
  passwords piped through `PGPASSWORD` sourced from `.env` via a Node
  one-liner that never echoes the value).
- After verification completed, `ros_p1e6a_scratch` was dropped via
  `dropdb` (confirmed removed via `\l`). The persistent `ros` database was
  never reset, dropped, or had any row deleted by this session.

---

## I. NON-GOALS (UNCHANGED, EXPLICITLY NOT DONE)

No Payment, no Completion, no auto-Fire, no schema/migration change (26
migrations, unchanged), no OpenAPI regeneration (no documentation-facing
change was made — see §J), no commit, no push, no `git stash`/`reset`/
`checkout`/`restore`/`clean`/`rebase`, no branch operation, no reset/drop of
the persistent `ros` database, no deletion of the persistent database's
historical orphan rows (§G), no redesign of `order-state.ts`'s general state
machine, no weakening of `organisation.e2e-spec.ts`'s invariant test, no
production RBAC migration/seed path built for FR-SEC-010.

---

## J. OPENAPI

Not regenerated. No controller decorator, route, request/response DTO
shape, or status code was changed by any of the seven corrections — Defects
B and C add new 422 *reasons* under the Fire route's already-documented
`@ApiUnprocessableEntityResponse`, not a new response code or route.
Confirmed via `test/openapi.e2e-spec.ts` (31/31 passing, unmodified) and a
direct operation-count check: **132 operations, `openapi: 3.1.0`, unchanged**
from the P1E-6 baseline.

---

## K. FILES CHANGED (P1E-6A ONLY)

- `src/common/idempotency/idempotency.interceptor.ts` — Defect A (one-line
  fingerprint-input fix, see §B).
- `src/modules/sales/orders/fire.errors.ts` — two new error classes,
  `IllegalFireSourceStateError` (Defect B) and
  `UnresolvedServiceReferenceError` (Defect C).
- `src/modules/sales/orders/sales-fire.service.ts` — the Defect B state
  guard and the Defect C fail-closed table-resolution check (see §C/§D for
  exact placement/ordering).
- `src/scripts/seed-dev-data.ts` — dev-only `Cashier` role now includes
  `pos.order.fire` (§E).
- `test/sales-fire.e2e-spec.ts` — rewrote the P1E-6 "DISCOVERED BEHAVIOUR"
  idempotency test to prove the fix (§B); added the Defect B describe block
  (5 tests) and Defect C describe block (3 tests, plus the
  `SentinelAwareTableDisplayQuery` DI seam and its `TestingModule`
  wiring) — 25 → 33 tests.
- `test/sales-lines.e2e-spec.ts` — one new cross-order idempotency
  regression test (§B, item G).
- `test/sales-fire-concurrency.e2e-spec.ts` — **new file**, the deterministic
  barrier-synchronized concurrency proof (§F), one test, its own minimal
  fixture set and app bootstrap.
- `test/kitchen-ticket-persistence.e2e-spec.ts`,
  `test/kitchen-ticket-concurrency.e2e-spec.ts` — one added
  `admin.location.create(...)` call each (§G).

No file outside this list was modified by this session. `order-state.ts`,
`orders.controller.ts`, `sales.module.ts`, both public Fire-facts contracts,
`ticket-persistence.service.ts`, `routing-resolver.service.ts`,
`unit-of-work.ts`, `schema.prisma`, and every other P1E-6-accepted file are
confirmed untouched (verified by `git status`/`git diff` inspection, not
merely by absence from this list).

---

## L. VERIFICATION SUMMARY

| Check | Result |
|---|---|
| `nest build` (canonical typecheck) | Clean |
| `eslint` on every changed file | Clean, zero warnings |
| `npx prisma validate` | Valid |
| Unit suite | 708/708 passing |
| E2E suite, persistent `ros` DB | 678/679 passing — the 1 failure is the pre-existing, pre-session `organisation.e2e-spec.ts` orphan-location invariant (§G), not a new regression |
| E2E suite, clean `ros_p1e6a_scratch`, migrated from zero | **679/679 passing, 32/32 suites — 100%** |
| Deterministic concurrency proof | 5/5 consecutive runs, zero flakiness |
| OpenAPI | 132 operations, 3.1.0, unchanged; `openapi.e2e-spec.ts` 31/31 |
| Migrations | 26, unchanged |

Net e2e test count: 669 (P1E-6 baseline) → 679 (+1 sales-lines, +8
sales-fire.e2e-spec.ts net, +1 sales-fire-concurrency.e2e-spec.ts) —
arithmetic cross-checked against the actual suite total, exact match.

---

## M. §O — REQUIREMENT CLASSIFICATION (UPDATED FROM P1E-6)

| Requirement | Classification | Note |
|---|---|---|
| FR-API-020 | **PARTIAL, unchanged** | Still 4/72 mutating routes idempotent; this slice fixed a *correctness defect* within the existing 4, not the coverage gap. |
| FR-API-021 | **IMPLEMENTED, unchanged** | ≥30-day retention untouched. |
| FR-API-022 | **IMPLEMENTED — defect corrected this session** | Same-key-same-request replay is now correctly resource-scoped (was previously vulnerable to a false-positive cross-resource replay on Fire/line-add; see §B). |
| FR-API-023 | **IMPLEMENTED — defect corrected this session** | Same-key-different-request now correctly 409s across distinct resources on every idempotent route (was previously unable to detect the Fire/line-add cross-order case; see §B). |
| FR-SEC-010 | **PARTIAL, gap unchanged, framing corrected** | Permission code + manual enforcement: YES. Standard-role shipped grant: NO — pre-existing, not built here (§E). |
| UC-POS-01 step 6 | **COMPLETE for explicit Fire, now hardened** | Draft→open and open→open Fire proven end to end; held/parked/partially_paid now correctly rejected rather than silently accepted (§C). |
| FR-POS-035 | **PARTIAL, unchanged** | Explicit Fire implemented; auto/configurable Fire remains not implemented (§26 non-goal, unchanged). |
| FR-POS-038 | **backend COMPLETE, unaffected** | Amendment (open→open) Fire semantics unchanged and re-verified passing after the Defect B guard was added. |
| FR-KDS-010 | **backend COMPLETE, unaffected** | Five-tier routing untouched by any of the seven defects. |
| FR-KDS-011 | **backend COMPLETE, unaffected** | Multi-station routing untouched. |
| FR-KDS-020 | **PARTIAL, backend correctness strengthened** | Dine-in service reference now fails closed on an unresolvable table instead of silently defaulting to null (§D); no KDS UI exists, unchanged. |

**Not claimed, explicitly:** completed sale, Payment, Inventory depletion,
COGS posting, receipt, DayClose, a shipped standard-role RBAC grant
(FR-SEC-010 remains open).

---

## N. §P — P1E-6A EXIT

```
DEFECT A (IDEMPOTENCY RESOURCE IDENTITY): FIXED
DEFECT B (FIRE LEGAL SOURCE STATES): FIXED
DEFECT C (DINE-IN SERVICE REFERENCE FAIL-CLOSED): FIXED
STANDARD ROLE CLASSIFICATION CORRECTED: YES
DETERMINISTIC CONCURRENCY PROOF: YES (5/5 runs, zero flakiness)
KITCHEN FIXTURE HYGIENE FIXED: YES (verified via clean-DB 100% pass)
CLEAN TEMP DATABASE VERIFICATION: YES (679/679 e2e, 32/32 suites, 100%)
P1E-6 CORE FIRE ARCHITECTURE REOPENED: NO
PAYMENT/COMPLETION/AUTO-FIRE IMPLEMENTED: NO
```

---

## O. §Q — COMMIT READINESS

Working tree contains this session's changes plus every prior uncommitted
change already recorded in the P1E-6 report's own starting state (`.gitignore`,
`src/main.ts`, and the rest of the P1E-6 slice). All of P1E-6A's own new/
modified files build clean, lint clean, and pass 100% on a from-zero clean
database.

```
BRANCH SAFE FOR COMMIT: NO / NEEDS EXPLICIT BRANCH DECISION
```

The `main`-vs-`feat/production-spec` naming discrepancy (external rename,
predating this and the P1E-6 session, content-identical to
`origin/feat/production-spec`) is unresolved and was explicitly out of scope
to resolve here. No commit and no push were performed.

---

## P. §R — NEXT

```
NEXT: BRANCH / CHECKPOINT RESOLUTION, THEN PAYMENT MVP
```

Payment MVP (cash + manual external card capture) was named as the next
slice by the P1E-6 report and remains the next slice; nothing in this
correction advances or blocks it further than P1E-6 already left it.
