# DEMO-POS-EMPLOYEE-SESSION-HOTFIX — PIN session must identify employee

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `5e3282e` (DEMO-DRAWER-AUTHZ-HOTFIX-4)
**HEAD (frontend, this task's parent):** `b8528be`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Backend touched `auth.service.ts`,
`terminal-session.service.ts` (+ their two spec files for a constructor
signature change), added
`test/pos-session-refresh-employee-identity.e2e-spec.ts`. **No frontend
change** — the error-handling requirement this ticket restates was already
fully satisfied by `DEMO-DRAWER-AUTHZ-HOTFIX-4`'s commit (`b8528be`);
verified, not re-done. Same pre-existing, unrelated `INDEX.md`/
`PROD-DEMO-SMOKE` items left untouched.
**Task identifier:** DEMO-POS-EMPLOYEE-SESSION-HOTFIX (a request that
passes `PermissionGuard`'s scope check but 403s inside
`requirePosIdentity` with "requires ... the employee taking custody of
the drawer")

## Trace (the 11 items asked for)

1. **`POST /auth/pin`** — unchanged, correct. Always resolves and signs
   BOTH `trm` (terminal) and `emp` (employee) together, from the SAME
   `PinAuthResult`; the two can never be minted independently at login.
2. **`PinService.authenticate`** — unchanged, correct. Returns
   `{employeeId, userId, branchId, terminalId, membershipId}` from one
   transaction (branch/employee/credential/membership all checked
   together).
3. **Employee lookup** — `tx.employee.findFirst({ where: { code:
   employeeCode } })`, requires `status === 'active'` and a linked
   `userId`. Confirmed correct, unchanged.
4. **Linked `User`** — `Employee.userId` is `@unique` (schema, unchanged)
   — at most one Employee per User, tenant-wide. This uniqueness is what
   makes every fix below possible with zero migration.
5. **`Membership`** — resolved by `(userId, tenantId)`, must be `active`.
   Unchanged.
6. **Session row** — **`Session` has NO `employeeId` column**
   (`schema.prisma`, confirmed by direct read) — only `userId`,
   `terminalId`, `membershipId`. The employee identity has never lived
   anywhere durable; it is derived fresh, every time, from
   `Employee.userId`.
7. **JWT/access-token claims** — `AccessTokenPayload.emp` (unchanged,
   correctly declared and signed at PIN login). **This is where the two
   REAL gaps were found** — see ROOT_CAUSE.
8. **`AuthPrincipal`/`TenantContext`** — `JwtAuthGuard` correctly maps
   `payload.emp -> principal.employeeId` (unchanged, already correct —
   confirmed by direct read, no bug here despite being a natural
   suspect).
9. **POS session context** — `TenantContextService.require()` sets
   `context.branchId` from `resolvePosBranch` ONLY when
   `principal.sessionType === 'pos'`; `context.terminalId` is set
   whenever `principal.terminalId` exists, REGARDLESS of sessionType.
   This asymmetry is what lets a non-PIN, terminal-bound-but-not-pos
   token still pass `sessionTerminalBranchTarget()`'s scope check (via its
   terminal-lookup fallback) while having no `emp` claim at all — exactly
   the shape that reaches `requirePosIdentity` and fails there specifically,
   rather than failing earlier at the guard.
10. **`GET /cash-sessions/drawers`** — unchanged this ticket (fixed
    correctly in `DEMO-DRAWER-AUTHZ-HOTFIX-4`); its `requirePosIdentity`
    call is what surfaces the reported message.
11. **`POST /cash-sessions`** — unchanged; the SAME `requirePosIdentity`
    call, so it fails identically whenever `emp` is missing.

## PIN_EMPLOYEE_FOUND / SESSION_EMPLOYEE_FIELD / EMPLOYEE_ID_LOST_AT

**PIN_EMPLOYEE_FOUND:** Yes, always, at `/auth/pin` itself — confirmed
correct.
**SESSION_EMPLOYEE_FIELD:** **Does not exist.** The `Session` Prisma model
has no `employeeId`/`empId` column. Per the ticket's own instruction ("Do
NOT add a migration unless the current schema truly has no way to
represent the required employee identity — prove that before proposing
one"): proven, and no migration was added — `Employee.userId`'s existing
`@unique` constraint is a complete, already-present way to re-derive the
SAME identity from `(tenantId, userId)`, which every token-minting path
already has available. `EmployeesService.findByUser(tenantId, userId)`
already existed (in `identity/employees/employees.service.ts`, the "D-2
minimal substrate" used elsewhere for PIN's own employee resolution) —
written, apparently, in anticipation of exactly this need, but had **zero
callers anywhere in the codebase** before this task.
**EMPLOYEE_ID_LOST_AT:** Not at PIN login. Lost at every OTHER path that
mints or re-mints a terminal-bound token without re-deriving `emp`:

- **`TerminalSessionService.bind()`** (`POST /auth/terminal`) — a
  DASHBOARD-authenticated, already-tenant-scoped session binding itself to
  a terminal. Signs `trm` (and persists `terminalId` directly onto the
  `Session` row) but never looked up whether the caller IS an Employee, so
  it never signed `emp` — **even when the caller genuinely was one**. This
  is the cleanest, most directly reproducible mechanism for the EXACT
  reported shape (terminal present, scope-authorized, employee absent),
  reproduced and fixed below.
- **`AuthService.refresh()`** — already preserved `trm` across rotation
  (when `session.terminalId` was persisted and the terminal is still
  active) but never re-derived `emp` for that same, now-refreshed session.
  This matters for exactly the sessions `bind()` produces (which DO get a
  persisted `session.terminalId` and a persisted `session.membershipId`,
  since `bind()` requires prior tenant selection) — also fixed below.
  A PURE PIN-issued session's OWN refresh is **unaffected by either gap**:
  `AuthService.loginWithPin` deliberately never persists `membershipId`
  onto its `Session` row (a documented, RATIFIED anti-escalation decision
  — refreshing it restores no tenant context at all, and it fails at the
  EARLIER, different "session is not terminal-bound" refusal, never
  reaching the employee-identity check). Confirmed unchanged and correct
  by a dedicated regression test below — this is NOT a gap and was not
  touched.

## ROOT_CAUSE

Two REAL, independent gaps, both now closed, neither requiring a
migration:

1. `TerminalSessionService.bind()` never resolved the caller's Employee
   identity before signing a terminal-bound token.
2. `AuthService.refresh()` never re-resolved it either, for the one class
   of session (tenant-selected AND terminal-bound, i.e. one that went
   through `bind()`) where the tenant context DOES survive rotation.

Both were silent: `PermissionGuard`'s scope check for
`sessionTerminalBranchTarget()` only ever needed `terminalId`/`branchId` —
never `emp` — so these malformed-but-scope-valid tokens sailed through
authorization and failed only deep inside the ONE piece of code
(`requirePosIdentity`) that actually enforces the FR-SEC-021
employee-custody invariant. That invariant itself was never weakened,
bypassed, or removed anywhere — it was doing exactly its job of refusing
an unattributable custody claim; the token simply should never have
reached it in that shape.

## BACKEND_FIX

- **`src/modules/identity/terminals/terminal-session.service.ts`**:
  `bind()` now calls `this.employees.findByUser(context.tenantId,
  context.userId)` and includes `emp: employee.id` in the signed payload
  when an active linked Employee is found — the exact same safe,
  `Employee.userId`-unique derivation the ticket asked for, reusing the
  pre-existing, previously-uncalled `EmployeesService.findByUser`. A
  caller with no linked Employee (a pure back-office user binding to a
  KDS screen) gets no `emp` claim, exactly as before — no behavior change
  for that case.
- **`src/modules/identity/auth/auth.service.ts`**: `refresh()` now
  performs the identical derivation — `if (context && terminalId)`, i.e.
  only when BOTH the tenant context and the terminal binding survived
  rotation — and includes `emp` on the re-signed token under the same
  condition. Deliberately does **NOT** restore `typ: 'pos'` on refresh —
  that remains the separate, ratified FR-SEC-021 boundary this ticket
  explicitly said not to touch ("DO NOT weaken Treasury's employee-custody
  invariant"); only the employee-custody ATTRIBUTION is restored.
- Both changes needed the corresponding unit spec files updated for the
  new constructor parameter (`EmployeesService`) — mechanical, no behavior
  assertion changed.

## FRONTEND_FIX

**None needed.** `DEMO-DRAWER-AUTHZ-HOTFIX-4`'s commit (`b8528be`) already
implements exactly the UI rule this ticket restates: `OpenDrawer` checks
`drawers.error` FIRST (a `ServiceError` with `code === "UNAUTHENTICATED"`
or `"FORBIDDEN"` shows a real session/auth message; any other error shows
its own message), and only an error-FREE, genuinely empty result shows
"No drawer is set up for this branch yet." Verified present and unchanged;
no new frontend commit was needed or made. Frontend `typecheck`/`build`
re-run clean as a sanity check.

## CASH_SESSION_EMPLOYEE_PROOF

New `test/pos-session-refresh-employee-identity.e2e-spec.ts`, 4 tests, all
reading `CashSession.employeeId` directly from the database (never from
an API response, which does not expose it):

1. **Normal PIN login, end to end** — drawer list, cash-session open, and
   `CashSession.employeeId === Employee.id`. (The pre-existing, always-working
   path — confirmed unaffected.)
2. **The proven bug, fixed** — a password-linked Employee logs in via
   `/auth/login` → `/auth/tenant` → `/auth/terminal` (bind). Before the
   fix this reproduces the EXACT reported 403; after the fix,
   `GET /cash-sessions/drawers` → 200, `POST /cash-sessions` → 201, and
   `CashSession.employeeId` matches. A subsequent `/auth/refresh` of this
   SAME session still returns a usable, employee-identified token.
3. **Unchanged, deliberate behaviour** — a refreshed PURE PIN session
   (never tenant-selected) still fails closed, at the earlier
   "not terminal-bound" stage — proving the anti-escalation design was not
   touched.
4. **No identity inheritance** — two employees each PIN-login on the same
   terminal; each one's own `CashSession.employeeId` is exactly their own,
   never the other's.

## Tests

`test/pos-session-refresh-employee-identity.e2e-spec.ts`: **4/4 passed**.

Combined targeted regression — **6 suites, 33 tests, all passed**:
`pos-session-refresh-employee-identity` (4/4), `drawers-provisioning`
(8/8), `cash-session-cashier-role` (4/4), `employee-role-assignments`
(5/5), `workforce-employees-hotfix` (5/5), `registrations` (7/7).

`module-boundaries.spec.ts` + all `identity/auth` unit specs: **7 suites,
98 tests, all passed** (no new deviation; `EmployeesService` was already a
same-module provider for both `AuthService` and `TerminalSessionService`,
so this is a plain in-module DI addition, not a cross-module import).

Backend `typecheck`/`build`: clean. Frontend `typecheck`/`build`: clean
(no source changed).

## SRS relevance

FR-SEC-021 (PIN session identity, "SHALL NOT grant access to the web
dashboard") is the requirement this task closes a real gap in — the
employee-custody attribution now survives every code path that mints a
terminal-bound token, while the SEPARATE `pos` audience/escalation
boundary (also FR-SEC-021, "smaller cost than an escalation path") is
explicitly, deliberately left untouched, exactly as instructed.
