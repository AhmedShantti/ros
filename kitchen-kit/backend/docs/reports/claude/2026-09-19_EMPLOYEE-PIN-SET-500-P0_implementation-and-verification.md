# EMPLOYEE-PIN-SET-500-P0 — Implementation and Verification

**Report type:** Implementation and verification report.

**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative.

**Date:** 2026-09-19

**HEAD (before this task's commit):** `8de89b516c865954154164c990671e6339f10f8f`

**Branch:** `kds-station-discovery`

**Task identifier:** EMPLOYEE-PIN-SET-500-P0

Implements the smallest safe fix identified in
`docs/reports/claude/2026-09-19_EMPLOYEE-PIN-SET-500-P0_investigation.md`,
per this task's explicit three-phase, identity+hash-delta design decision.

---

## STATUS

**Implemented, verified, committed locally. Not pushed.**

## ROOT CAUSE FIXED

Yes. `PinService.setPin`'s FR-SEC-022 branch-uniqueness verification
(`assertUniqueInBranches`'s O(N) sequential Argon2id `verifyPasswordSafe`
loop) no longer runs inside any Prisma interactive transaction. It cannot
exhaust the 5000ms default transaction timeout regardless of how many
existing PIN credentials exist in the branch, because no transaction is
open while that work runs.

## FILES CHANGED

- `src/modules/identity/employees/pin.service.ts` — `setPin` restructured
  into the three phases below; `assertUniqueInBranches` replaced by
  `snapshotBranchUniqueness` (pure read), `findPinClash` (pure Argon2
  compute, no `tx`), and `branchUniquenessConflict` (message builder).
  `assertPinStillUniqueOnBranchAdd` (a separate, pre-existing, currently
  unwired method) is untouched.
- `test/employee-pin-set-500.e2e-spec.ts` — new, dedicated e2e suite (8
  tests).

## SCHEMA/MIGRATION

**None created — none was necessary.** Per this task's explicit design
decision, the Phase 3 delta re-check compares credential **identity
(`credentialId`) and `secretHash`**, never a timestamp, so no new column or
index was needed. `Credential.rotatedAt` (pre-existing) is not used by the
fix at all.

## PHASE 1

Short, read-only `withAuthContext` transaction. Loads the target employee
(existence + `userId` + current `branchIds`) — the exact same 404
(`NotFoundException('Employee not found.')`) / 409 (`ConflictException`
"no linked user") checks as before, unchanged, still at this point in the
flow. Then calls `snapshotBranchUniqueness`, which reads (never verifies):
every reachable neighbour's `employeeId`/`branchId`, their `userId`s, and
their PIN `Credential` rows (`id`, `userId`, `secretHash`). No Argon2 call.
No advisory lock. No write.

## PHASE 2

Outside any transaction/DB connection. Computes the candidate's
`secretHash` (as before) and runs `findPinClash` — the sequential
`verifyPasswordSafe` loop — against the Phase 1 snapshot's credentials.
This is the O(N) Argon2id work that used to run inside the write
transaction; it now has no timeout to exhaust. A match throws the same
`ConflictException` message as before
(`branchUniquenessConflict`, reconstructed from the Phase 1 snapshot).

## PHASE 3

Short, atomic `withAuthContext` write transaction. `lockTenant` (the
existing `pg_advisory_xact_lock(hashtext('ros_pin'), hashtext(tenantId))`)
is acquired **first**, unchanged. Then: re-reads the target employee's
CURRENT `branchIds` (defends against a concurrent branch-reachability
change since Phase 1) and takes a **fresh** `snapshotBranchUniqueness`
against that current state. Computes the **delta** — credentials in the
current snapshot whose `credentialId` either (a) does not appear in the
Phase 1 snapshot at all (newly reachable/created), or (b) appears but with
a **different `secretHash`** (rotated) — by identity + hash comparison
only, never `rotatedAt` or any timestamp. Runs `findPinClash` against ONLY
that delta (bounded by how many credentials actually changed in the narrow
window, not by branch headcount); a match throws the identical
`ConflictException`, and **nothing is written**. Otherwise, performs the
pre-existing `credential.upsert` and `audit.record` calls, byte-identical
to before, inside this same transaction.

## DELTA RECHECK

Implemented exactly as specified: a `Map<credentialId, secretHash>` built
from the Phase 1 snapshot, filtered against the CURRENT snapshot's
credentials — `previousHash === undefined || previousHash !== c.secretHash`
— never a `rotatedAt`/wall-clock comparison. Verified directly by two
dedicated tests (below) that simulate exactly the "newly reachable/created"
and "existed but hash changed" cases the task named.

## CONCURRENCY TEST

`test/employee-pin-set-500.e2e-spec.ts`:
- *"true concurrent collision"* — two real, overlapping `setPin` calls with
  the identical candidate PIN in the same branch: exactly one fulfilled,
  the other rejects with `ConflictException`. Passing.
- *"non-colliding concurrent assignments both succeed"* — two overlapping
  `setPin` calls with different PINs: both succeed. Passing.
- The pre-existing `pin.e2e-spec.ts` regression, *"concurrent assignment
  cannot introduce a branch collision"* (`Promise.allSettled`, exactly one
  fulfilled) — re-run unmodified, still passing against the new code.

## LARGE-N REGRESSION TEST

*"large-N regression: 220 pre-existing branch PIN credentials no longer
produce P2028 — setPin succeeds"* — 220 is the exact count the prior
investigation empirically proved reproduces `PrismaClientKnownRequestError`
P2028 against the OLD code (7316ms total, thrown at
`tx.credential.upsert`, "the timeout for this transaction was 5000 ms,
however 7212 ms passed..."). Against the NEW code the same fixture
completes with **no thrown error at all** and a correctly written,
Argon2id-hashed credential. Padding fixtures are written directly via the
migrator client (bypassing `UsersService.createUser`'s own — irrelevant —
Argon2 password hash and `EmployeesService.create`'s transaction/audit
overhead) so the test's OWN setup cost doesn't dominate its runtime or
destabilize a parallel full-suite run.

## PIN UNIQUENESS TEST

- *"existing PIN collision: candidate equal to a Phase-1 neighbour PIN ->
  409"* — passing.
- *"race-window NEW credential"* — a colliding credential is written via
  the admin client ~150ms after `setPin` is invoked (inside Phase 2's
  Argon2 window, before Phase 3 opens); Phase 3's delta catches it,
  `ConflictException`, **no credential written** for the target. Passing.
- *"race-window ROTATED credential"* — a neighbour's EXISTING credential
  (present, with a different hash, in the Phase 1 snapshot) is rotated to
  the candidate's hash in that same window; Phase 3's delta catches the
  hash change (same `credentialId`, different `secretHash`) and conflicts.
  Passing.
- All pre-existing `pin.e2e-spec.ts` FR-SEC-022 tests (duplicate-in-branch,
  disjoint-branch permitted) re-run unmodified, still passing.

## AUDIT TEST

- *"a successful setPin writes exactly one PIN_SET audit entry"* — exactly
  one row, correct `actorId`, PIN never present in `afterState`. Passing.
- *"a conflict leaves no credential AND no audit entry (no partial
  write)"* — after a 409, both the `Credential` row and the `PIN_SET`
  audit row are confirmed absent for the losing employee. Passing.
- The pre-existing `pin.e2e-spec.ts` audit tests (never writes the PIN
  into the audit payload) re-run unmodified, still passing.

## FOCUSED TESTS

```
$ npm run test:e2e -- \
    test/pin.e2e-spec.ts \
    test/employee-pin-set-500.e2e-spec.ts \
    test/employee-role-assignments.e2e-spec.ts \
    test/rbac.e2e-spec.ts \
    test/scoped-rbac.e2e-spec.ts \
    test/scoped-rbac-migration.e2e-spec.ts \
    test/cash-session-cashier-role.e2e-spec.ts
Test Suites: 7 passed, 7 total
Tests:       111 passed, 111 total
```
`pin.e2e-spec.ts` alone: **37/37**, all pre-existing behaviour (invalid PIN
shape, missing employee, no linked user, rotation, lockout/authentication)
unchanged — item 8 of the task's test list is satisfied by this unmodified,
still-passing suite rather than duplicated new tests. New
`employee-pin-set-500.e2e-spec.ts`: **8/8**.

## FULL TESTS

Unit (`npm test`): **90 suites, 1243 tests — all passed** (no change from
before this task).

E2e (`npm run test:e2e`, full suite, run twice after final tuning): **120
passed / 9 failed suites**, **1863 passed / 20 failed tests** on the
cleanest run — matching this session's already-established pre-existing
baseline (9 failing suites / 20 failing tests, confirmed pre-existing via
`git stash` reproduction in the prior `CASH-VARIANCE-BRANCH-MANAGER-P0`
task). `employee-pin-set-500.e2e-spec.ts` passed in this run. The full
parallel suite (4 Jest workers, many Argon2id-heavy suites) shows real
run-to-run variance in exactly which unrelated suites fail under CPU
contention (observed across three consecutive full runs: the same core
~9 pre-existing suites — `catalogue`, `inventory`, `openapi`,
`partition-lifecycle`, `procurement-supplier-foundation`,
`reporting-authorization`, `sales`, `scheduler-rls`,
`tenant-isolation/generated-cross-tenant` — plus occasional additional
transient timeouts in unrelated suites (`kds-concurrency`,
`multi-tenant-multi-branch`, `drawers-provisioning`, `sync-performance`,
`terminal`) that are NOT reproducible in isolation and do not reference
`pin.service.ts`, `PinService`, or anything this task touched — confirmed
by grep. This file's own tests were tuned (bare-fixture writes instead of
full-service calls for padding, generous per-test timeouts) specifically
so they do not themselves contribute to that contention; in isolation the
whole file completes in ~110s.

## TYPECHECK

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json
(no output, exit code 0)
```

## BUILD

```
$ npm run build
> nest build
(no output, exit code 0)
```

## PRISMA VALIDATE

```
$ npx prisma validate
The schema at prisma/schema.prisma is valid 🚀
```

## COMMIT SHA

See repository log (committed after this report was written — locally
only).

## PUSHED: NO

## LIVE TEST PLAN

Once this commit is authorized to deploy:
1. Deploy via the same fast-forward-only path used for prior fixes this
   session (no migration to apply — schema unchanged).
2. Reproduce the original live action: `POST
   /workforce/employees/{employeeId}/pin` for an employee whose branch has
   a large PIN-holder count → expect success (or a genuine 409 if the
   candidate truly collides), never a 500.
3. Spot-check a real branch uniqueness collision live (a PIN already known
   to be in use in that branch) → expect 409 with the FR-SEC-022 message,
   not a 500 — confirms Phase 2/3 still enforce uniqueness correctly
   against real production data shapes.
4. No recommended production load/concurrency drill beyond normal
   operation — the concurrency behaviour is covered by this task's e2e
   suite against real Postgres with RLS enforced, the same class of proof
   this repository already relies on for every other RLS-aware fix this
   session.

---

**Not done (explicitly out of scope, confirmed not needed):** no Prisma
transaction timeout raised; no plaintext or deterministic PIN storage; no
Argon2 parameter change; no advisory-locking removal; no weakening of
branch uniqueness; the credential upsert and audit record remain inside
the atomic Phase 3 transaction; no controller/DTO/frontend change; no
schema migration; cash-variance implementation, pricing WIP, and terminal
UX untouched.
