# P1G-0 — Acceptance Closure (performed_by FK audit, missing concurrency scenarios)

**Report type:** Narrow acceptance/correction pass — verification and additional evidence only.
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence → prior accepted reports**. Controlling documents: `docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md` and `docs/reports/claude/2026-08-28_P1G0_cash-movements.md` (the implementation report this pass closes out). This report does not redesign, does not start P1G-1, and does not implement Approval, drawer limit, CashSession close, Receipt, KDS, or Day Close.
**Date:** 2026-08-28
**HEAD at start and throughout:** `bfe7e69` (unchanged — no commit performed)
**Branch:** `feat/production-spec`
**Working tree at start:** identical to the end of the P1G-0 implementation report — migration 31, Treasury module/service/DTO/controller/permissions/views, `test/cash-movements.e2e-spec.ts`, plus the same three pre-existing slice-boundary test edits. No migration 32 was created in this pass; no production file was modified.
**Task identifier:** P1G-0 acceptance closure

> ## VERDICT
> ## **P1G-0 FINAL ACCEPTED**
> The `performed_by` tenant-safety concern raised at the start of this pass
> does not describe a real defect: `identity.users` has no `tenant_id`
> column at all (Users are global, tenant membership is many-to-many via
> `Membership`), so no `(tenant_id, id)` composite target can exist on that
> table, and the controlling design gate never asked for one — it
> explicitly specifies a **plain** FK for `performed_by`, mirroring the
> already-shipped `stock_movements.performed_by` precedent. No migration
> correction was made; **no migration 32 was created**. The `identity.
> employees` FK was re-confirmed correct (the stray `workforce.employees`
> string is dead prose in an old migration comment, not a live table). Both
> missing concurrency scenarios were built as new, real-Postgres,
> barrier-synchronized tests (`test/cash-movements-close-and-payment-
> concurrency.e2e-spec.ts`, 9 tests) and pass **3 consecutive clean runs**
> each. Full regression: **732/732 unit, 837/837 e2e** (828 baseline + 9
> new), migrations **31** (unchanged), OpenAPI **3.1.0/138** (byte-identical
> regeneration, zero drift). Persistent local `ros` DB confirmed untouched
> throughout (still 26 `_prisma_migrations` rows).

---

## A. STARTING STATE

```
git status --short   → 14 modified + 10 untracked paths, identical to the
                        end state of the P1G-0 implementation report
git branch --show-current → feat/production-spec
git rev-parse HEAD        → bfe7e695bbc5445d37a119965c2a1c1ba3701608
git diff --stat            → 14 files changed, 1309 insertions(+), 94 deletions(-)
```

Nothing was reset, stashed permanently, or discarded. (One working-tree
diagnostic `git stash push` / `git stash pop` pair was used transiently in
§I below to snapshot the pre-regeneration OpenAPI files for a byte-identity
check — both files were restored to their exact prior content within the
same tool call before any other work continued; `git status --short` was
re-verified identical immediately after.)

---

## B. `performed_by` TENANT-SAFETY AUDIT — PREMISE INCORRECT, NO DEFECT

### B.1 What the controlling design gate actually specifies

`docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md` §B
(migration 31 spec) lists the FKs section explicitly:

```
FKs (ALL tenant-safe composites, RESTRICT):
  (tenant_id, cash_session_id) -> treasury.cash_sessions(tenant_id, id)
  (tenant_id, branch_id)       -> org.branches(tenant_id, id)
  (tenant_id, employee_id)     -> workforce.employees(tenant_id, id)
```

`performed_by` is listed **separately**, in the column list, with its own
comment:

```
performed_by UUID NOT NULL        -- identity User (mirrors stock_movements.performed_by)
```

The design gate never includes `performed_by` in "ALL tenant-safe
composites" — it specifies a **plain** FK to `identity.users(id)` from the
start, by name, citing the existing `stock_movements.performed_by`
precedent. The premise stated at the start of this pass ("the controlling
design required tenant-safe composite FKs [for `performed_by`]") does not
match the controlling document's own text. This is the same category of
error as the earlier P1G-1 P-1/P-2 governance misreading corrected in the
P1G-0 design gate's own §17 — a citation asserted as the design's
requirement that the design document itself does not make.

### B.2 Why `identity.users` cannot expose a `(tenant_id, id)` target

Read directly from `prisma/schema.prisma`:

```prisma
model User {
  id              String     @id @db.Uuid
  email           String     @unique @db.VarChar(255)
  ...
  memberships     Membership[]
  ...
  @@map("users")
  @@schema("identity")
}

model Membership {
  id        String  @id @db.Uuid
  userId    String  @map("user_id") @db.Uuid
  tenantId  String  @map("tenant_id") @db.Uuid
  ...
  @@unique([userId, tenantId])
  @@map("memberships")
  @@schema("identity")
}
```

`identity.users` carries **no `tenant_id` column at all**. Tenancy is
established through `Membership` — a genuine many-to-many: one User can
hold active memberships in multiple tenants simultaneously (this is the
whole reason `Membership` exists as its own table rather than a column on
`User`). A `(tenant_id, id) -> identity.users(tenant_id, id)` FK is not
merely absent by oversight — it is **not constructible** without adding a
`tenant_id` column to `identity.users`, which would either (a) be
meaningless for a multi-tenant User, or (b) require collapsing the
Membership model into a 1:1 User↔Tenant relationship, a real architectural
change to Identity this pass has no authority to make (and which the
instruction itself forbids: "Do NOT modify an Identity table from this
Treasury migration without a gate").

### B.3 The existing precedent this design already follows

```
prisma/migrations/20260816210000_inventory_foundation/migration.sql:403:
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT
  "stock_movements_performed_by_fkey" FOREIGN KEY ("performed_by")
  REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

prisma/migrations/20260828010000_treasury_cash_movements/migration.sql:76:
  FOREIGN KEY ("performed_by") REFERENCES "identity"."users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

Byte-for-byte the same shape. `cash_movements.performed_by` is not a
shortcut relative to an established pattern — it **is** the established
pattern, already accepted (P1D-era `stock_movements`, never challenged).

### B.4 What actually enforces tenant safety for `performed_by` — verified, not assumed

`performed_by` is never client-supplied. Grep-verified: `CashMovementDto`
carries only `id`, `amountMinor`, `reason`, `occurredAt` — no
`performedBy` field exists anywhere in the request surface.
`CashMovementsService.record()` always writes `actorUserId`, which the
controller derives from `context.userId` (`CurrentTenantContext`), never
from the request body (`treasury.controller.ts:318-321`).

`context.userId`/`context.tenantId` are established by
`TenantContextService.resolve()` (`src/modules/identity/context/
tenant-context.service.ts`), which — **DB-verified, not merely a JWT
claim** — requires:

```typescript
tx.membership.findFirst({
  where: {
    id: principal.membershipId,
    userId: principal.userId,
    tenantId: principal.tenantId,
    status: 'active',
    tenant: { status: 'active' },
  },
  ...
})
```

A request cannot reach `CashMovementsService.record()` at all unless this
query proves, against the live database, that `context.userId` holds an
**active** `Membership` in `context.tenantId`. Every `cash_movements` row's
`performed_by` is therefore guaranteed — by a real, per-request database
check, not convention — to belong to the tenant the row is written under.
This is a strictly stronger guarantee than a raw structural FK could
express in the first place, since a plain FK to `identity.users(id)` has no
way to encode "and specifically for tenant X," precisely because a User can
legitimately belong to several tenants.

### B.5 Why the requested "real FK violation" test was not built

The instruction requires: *"Add a DB-negative test proving a CashMovement
cannot carry: tenant A + performed_by User from tenant B. This must be a
real FK violation proof."* Given B.2, no such **structural** proof is
possible or honest to construct: `identity.users(id)` has no per-tenant
identity to violate — a User from "tenant B" is not a distinct row shape at
the FK level, since the same User row can legitimately be `performed_by`
for CashMovements in *any* tenant they hold active membership in. Writing
a raw SQL `INSERT` that bypasses the application layer and sets
`performed_by` to a User with no membership in the target tenant would
**succeed** at the database level (the FK only checks `id` existence in
`identity.users`, nothing else) — fabricating a "real FK violation proof"
here would misrepresent what is actually guaranteed, which is a
request-layer, DB-verified membership check (§B.4), not a table-structural
one. Building a test that pretends otherwise was rejected as dishonest
evidence rather than attempted.

**Disposition: NO DEFECT. NO MIGRATION 32. NO CORRECTION MADE.** The
existing plain FK is the only architecturally correct choice and exactly
matches both the controlling design gate's own text and the established
P1D repository precedent.

---

## C. EMPLOYEE-SCHEMA DISPOSITION — RE-CONFIRMED CORRECT

`identity.employees` is the current, sole, accepted P1D persistence
location for Employee — re-verified directly from the schema and the
migration:

```prisma
model Employee {
  id       String @id @db.Uuid
  tenantId String @map("tenant_id") @db.Uuid
  ...
  @@schema("identity")
}
```

```sql
-- prisma/migrations/20260828010000_treasury_cash_movements/migration.sql:70-72
ALTER TABLE "treasury"."cash_movements" ADD CONSTRAINT
  "cash_movements_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "identity"."employees"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

The string `workforce.employees` appears **nowhere** as a live table —
grepped across every `migration.sql` in the repository, it occurs only
inside **comments** in two older migrations
(`20260820160000_shift_drawer_cash_session_open`,
`20260820120000_sales_order_foundation`), both explicitly documenting a
deviation from an earlier approved-SQL string (*"approved SQL says
`workforce.employees`"*) against the actual, single `CREATE TABLE
"identity"."employees"` in `20260819160000_pin_employee_substrate`. No
table was ever created in a `workforce` schema for Employee. The design
gate's own prose was stale (already caught and corrected during the
original P1G-0 implementation, per that report's file-reading trail); the
migration and Prisma model were never wrong. **No table move performed.
No action needed.**

---

## D. SAFE_DROP vs A SETTLING PAYMENT — NEW CONCURRENCY PROOF

New file: `test/cash-movements-close-and-payment-concurrency.e2e-spec.ts`,
describe block `D` (3 tests, one per run).

**Repository fact, verified by direct code reading** (not assumed):
`SalesPaymentService.capture` (`sales-payment.service.ts` step 5) reads
CashSession facts via `CASH_SESSION_FACTS_QUERY.find()` — a **plain
SELECT**, no `FOR UPDATE`, no advisory lock. Payment takes **no lock at
all** on `cash_sessions` today. This test is therefore an
**interleaving/integrity proof, not a mutual-lock proof** — it does not
and cannot claim Payment serializes with CashSession; that remains an open
P1G-1 obligation, stated plainly rather than implied otherwise.

**Method**: `GatedCashMovementAuditService` (a narrowly-filtered variant of
the existing `GatedAuditService` pattern from `cash-movements.e2e-spec.ts`,
filtered to `event.action === AUDIT_ACTION.CASH_MOVEMENT_RECORDED` so a
concurrently-running Payment's own audit writes — `PAYMENT_CAPTURED`,
`ORDER_COMPLETED`, COGS-posting — never trip this gate) pauses a
`safeDrop()` call after its `INSERT` (still holding the `ros_cash_session`
advisory lock, transaction uncommitted). While paused, a **real settling
Payment** (`SalesPaymentService.capture`, full happy-path order → line →
open → capture, using a menu item with **no recipe** — verified via direct
code reading of `consumption-resolution.service.ts:451`, *"Absent recipe
(`line.recipeVersionId === null`): 0 depletion (BR-MNU-012), no gap"* — so
Completion succeeds with zero inventory/recipe fixtures) is fired and fully
awaited on the **same** CashSession. Two independent-connection checks
confirm the SAFE_DROP row is **not yet visible** (proving genuine temporal
overlap, not accidental sequencing) both immediately after the gate opens
and again immediately after the Payment resolves. The gate is then
released and the SAFE_DROP allowed to commit.

**Assertions per run**: both operations succeed; exactly one
`cash_movements` row (`movementType='safe_drop'`, correct amount); exactly
one `order_payments` row (correct amount, correct `cashSessionId`); the
Order reaches `state='completed'` with `paidTotal === grandTotal`; no lost
update, no duplicate row, no deadlock (implicit — every run completes
within its 20s bound).

**Result: 3/3 runs clean** (both as part of the file's initial pass and
independently re-verified — see §J).

---

## E. MOVEMENT vs A FUTURE SESSION CLOSE — TEST-ONLY LOCK-CONTRACT PROOF

Same file, describe block `E` (6 tests: 3 required-case runs + 3
opposite-direction runs).

No production close service exists (P1G-1 not built). The design gate
hands P1G-1 a binding contract, restated verbatim in `cash-movements.
service.ts`'s own docblock: acquire the **identical** advisory lock
(`pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext(id))`)
before mutating a session. This is proven with **TEST-ONLY** fixture code
only — a `closeSessionHoldingLock()` helper using the **migrator**
connection (`ros_migrator`, via `admin.$transaction`), explicitly **not**
a production service/controller/route, and **no `ros_app` grant was
added** — the writer uses the migrator connection precisely because
`ros_app` cannot `UPDATE cash_sessions` today (§F).

**Required case (3 runs)**: the close-writer acquires the advisory lock
first, updates `status='closed'`, and pauses (transaction open,
uncommitted). A real `CashMovementsService.payIn` call is then fired and
proven — via `pg_stat_activity.wait_event_type='Lock'` polling on a query
naming `pg_advisory_xact_lock` — to be **genuinely blocked** on the same
lock. The close-writer commits; the movement then acquires the lock, reads
`status='closed'`, and deterministically throws `ConflictException` (409).
Assertion: **zero** `cash_movements` rows exist for that session
afterward.

**Opposite direction (3 runs, "if cheap")**: a real movement acquires the
lock first (via the same `GatedCashMovementAuditService` pause used in §D)
and holds it open; the close-writer is started and proven genuinely
blocked on the same lock via the identical `pg_stat_activity` poll; the
movement's gate is released, it commits, and the close-writer then
acquires the lock and proceeds to close the session normally. Assertion:
the session ends `status='closed'` and exactly one movement row exists.

**Result: 6/6 runs clean.** Both directions of serialization on the shared
lock are proven, not merely the minimum required case.

---

## F. ADVISORY-LOCK FINAL CONTRACT — RE-VERIFIED, DOCUMENTED

Re-confirmed, not re-derived, from the existing implementation report and
re-checked directly against the current code and grants:

- `ros_app` genuinely cannot `SELECT ... FOR UPDATE cash_sessions`:
  Postgres requires the row's **UPDATE** privilege to take that lock, and
  the migration's own `REVOKE UPDATE, DELETE, TRUNCATE ... FROM ros_app`
  (append-only-until-P1G-1 posture) removes exactly that privilege. This
  was the original implementation-time finding; unchanged.
- The advisory lock (`pg_advisory_xact_lock(hashtext('ros_cash_session'),
  hashtext(cashSessionId))`) is **transaction-scoped**: auto-released at
  COMMIT/ROLLBACK, never leaked across requests — confirmed by every test
  in this pass completing without any residual `pg_stat_activity` waiter
  after its `commitPromise`/`safeDropPromise`/`movementPromise` resolves.
- **Same session id → same lock key** (via `hashtext` on the literal
  UUID string) — different sessions use different keys and do **not**
  intentionally contend with one another; every §D/§E test uses a fresh
  `mkCashSession()` per run specifically to keep each run's contention
  scoped to its own session, and no cross-run interference was observed
  across any of the 15 new test executions (9 in the file's own pass + 6
  independently re-verified 3-run sequences described in §J).
- **No grant widening occurred anywhere in this pass** — `ros_app`'s
  grants on `cash_sessions`/`cash_movements` are byte-identical to the
  original P1G-0 implementation (no migration 32, no `GRANT`/`REVOKE`
  statement was written or executed against any grant).
- **P1G-1 MUST reuse this exact namespace/key** before mutating a session,
  confirmed as the binding contract by §E's own test construction — the
  test-only close-writer only serializes against `CashMovementsService`
  because it deliberately uses the identical `hashtext('ros_cash_session'),
  hashtext(id)` pair; any other lock name or key would not contend at all,
  which is precisely why this had to be proven with matching lock code
  rather than merely asserted in prose.
- **Payment does not serialize with CashSession today — restated, not
  contradicted.** §D's own passing assertions (the SAFE_DROP row provably
  not yet visible both before and after the concurrent Payment resolves)
  are direct evidence *for* this fact, not against it: the Payment
  completed without ever waiting on SAFE_DROP's held lock, because it
  never asked for that lock. This report does not claim otherwise anywhere
  in §D, §F, or the classifications in §K.

---

## G. TEST-HARNESS WORDING CORRECTION — APPLIED

`docs/reports/claude/2026-08-28_P1G0_cash-movements.md` §G originally
read (categorical): *"Classification: test-harness artifact (a
`supertest`/single-in-process-server concurrent-dispatch limitation when
one request's transaction is held open), not an implementation defect."*

**Corrected in place** (same report, no new report needed, no dated
duplicate created — a wording precision, not a new finding) to:

> "Classification: a test-harness HTTP dispatch artifact; the exact
> lower-level dispatch cause was not further isolated, but production code
> and PostgreSQL lock contention were excluded by direct evidence
> (production's own debug log fired only once; `pg_stat_activity` showed
> exactly one `ros_app` backend the entire time, `idle in
> transaction`/`wait_event_type='Client'`, never `Lock`) — not an
> implementation defect."

The evidentiary claims that ARE hard-evidenced (single debug-log fire,
single `ros_app` backend, `Client` not `Lock` wait) are retained verbatim,
since they were directly observed during the original diagnosis and remain
true. Only the specific attribution to a named `supertest` defect —
which was never isolated to that library specifically — was softened to
"HTTP dispatch artifact, cause not further isolated." No production or
test code changed as a result of this wording correction.

---

## H. RLS / GRANTS — UNCHANGED, RE-CONFIRMED BY ABSENCE OF ANY GRANT DIFF

No `GRANT`/`REVOKE`/`ALTER TABLE ... (ENABLE|FORCE) ROW LEVEL SECURITY`/
`CREATE POLICY` statement was written or executed anywhere in this pass —
confirmed by `git diff --stat` showing zero touched files under
`prisma/migrations/` beyond the pre-existing, untouched
`20260828010000_treasury_cash_movements/` directory (no new migration
directory exists). The full RLS/append-only/grants matrix (21 tests in the
original `cash-movements.e2e-spec.ts`) re-ran clean as part of the full
regression in §J, unchanged.

---

## I. MIGRATION / OPENAPI INVARIANTS

| Check | Result |
|---|---|
| Migration count | **31** — unchanged, no migration 32 created |
| `npx tsc --noEmit` | Clean — only the known pre-existing `access-token.service.spec.ts` baseline error |
| `npx eslint` (new/changed files) | Clean, zero errors, zero warnings (one auto-fixable formatting issue found and fixed) |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `npm run build` (`nest build`) | Clean |
| `git diff --check` | Clean |
| `module-boundaries.spec.ts` | **31/31 passing**, `KNOWN_DEVIATIONS` unchanged |
| OpenAPI regeneration | **Byte-identical** to the pre-pass working-tree files (verified via a true before/after snapshot diff, not merely `git diff` against HEAD) — `3.1.0`, exactly **138** `operationId` occurrences, unchanged |

---

## J. FULL REGRESSION

All runs against a fresh scratch PostgreSQL database, migrated from zero
with `prisma migrate deploy` (31/31 migrations applied cleanly each time),
dropped immediately after use. The persistent local `ros` DB was never
pointed at by `DATABASE_URL`/`APP_DATABASE_URL` during any of these runs.

| Run | Result |
|---|---|
| New file alone, attempt 1 (pre-fixture-fix) | 6 passed / 3 failed — `NotFoundException: No inventory location is registered for branch ...` in §D (missing `Location` fixture; `SaleDepletionService.depleteForCompletedSale` requires a branch `Location` row even for a zero-depletion line) — fixed by adding the same `admin.location.create(...)` fixture the P1F-2 concurrency precedent already uses |
| New file alone, run 1/3 (post-fix) | **9/9 passed** |
| New file alone, run 2/3 (fresh scratch DB) | **9/9 passed** |
| New file alone, run 3/3 (fresh scratch DB) | **9/9 passed** |
| Targeted P1G-0 files (`cash-movements*`) | **44/44 passed** (35 original + 9 new), 2/2 suites |
| Full unit suite (`npx jest`) | **732/732 passed**, 53/53 suites — unchanged |
| Full e2e suite (`npm run test:e2e --runInBand`) | **837/837 passed**, 43/43 suites (828 baseline + 9 new) — zero regressions |

The one genuine defect found and fixed during this pass was in the **new
test's own fixture setup** (a missing `Location` row), not in production
code — diagnosed from the real Postgres error message, not guessed, and
fixed by matching an already-accepted fixture pattern
(`order-completion-concurrency-2.e2e-spec.ts`) rather than inventing a new
one.

---

## K. REQUIREMENT CLASSIFICATIONS — UNCHANGED

No classification changes from the original implementation report, since
no production code changed:

| Requirement | Classification |
|---|---|
| FR-POS-091 [M] | **COMPLETE** |
| FR-POS-092 [M] | **NOT IMPLEMENTED (substrate enabled)** |
| FR-FIN-004 [M] | **PARTIAL — 6/8 terms** (tips/refunds still have no operations) |
| FR-API-020 [M] | **PARTIAL** (system-wide) |
| FR-API-021/022/023 [M] | **IMPLEMENTED for covered routes** |
| NFR-REL-011 [M] | **HELD for this slice's operations** |

Corrections/reversals remain **NOT SOURCE-DECIDABLE** — no UPDATE/DELETE
capability exists on `cash_movements`, and no compensating-movement
mechanism was invented in this pass either.

---

## L. FINAL VERDICT

## **P1G-0 FINAL ACCEPTED**

No production code was changed in this pass. The one item raised as a
possible defect (`performed_by` tenant-safety) was investigated
rigorously and found to be a correct restatement of an already-accepted,
already-shipped repository pattern — not a defect — with the reasoning
recorded in full in §B rather than either silently complying with an
incorrect premise or silently ignoring it. Both requested missing
concurrency scenarios were built as genuine, real-Postgres,
barrier-synchronized tests and independently re-verified 3 consecutive
clean runs each (9 total new test executions verified 3×, for 27
individual clean passes). Full regression is green with zero regressions
and zero drift in migrations or OpenAPI. No commit, no push, no migration
32, no destructive git operation, and the persistent local `ros` DB was
never touched (confirmed still 26 `_prisma_migrations` rows, newest
`20260823030000_kitchen_ticket_persistence`, throughout).
