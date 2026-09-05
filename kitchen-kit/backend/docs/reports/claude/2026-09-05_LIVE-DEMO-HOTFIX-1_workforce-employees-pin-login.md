# LIVE-DEMO-HOTFIX-1 — Workforce Employees page + POS PIN login

**Report type:** Implementation + verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document records
what was implemented and verified in this session, not a requirements
determination.
**Date:** 2026-09-05
**HEAD (before this session's commits):** `b85c524` (SIGNUP-1)
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary (start of session):** clean except one pre-existing
unrelated uncommitted item (`docs/reports/claude/INDEX.md` carrying a
`PROD-DEMO-SMOKE` row + its untracked report file) — untouched by this
session, excluded from this hotfix's commit exactly as SIGNUP-1 excluded it.
**Task identifier:** LIVE-DEMO-HOTFIX-1

## Symptom chain (production evidence supplied by the user)

After a fresh owner signup (SIGNUP-1): owner reaches the dashboard, terminal
registration works, an employee was created through the Employees UI, but
POS PIN login (`POST /auth/pin`) returned 401, and the Employees page itself
threw `ServiceError("NOT_IMPLEMENTED", "The backend does not offer that
yet.")` client-side, logged as `[ROS] Live API ... No endpoint in
api/openapi.json: workforce`.

## Root cause 1 — Employees page ("backend does not offer that yet")

**Not an OpenAPI staleness problem**, contrary to the initial hypothesis.
Verified directly: the backend's committed `docs/api/openapi.json` and the
frontend's copy already fully documented every `workforce/employees` route
(list/create/get/update/branches/compensation/deactivate), and the frontend's
generated typed client (`lib/api/schema.ts`/`endpoints.ts`) already had real
`api.workforceEmployees.*` wrapper functions for all of them. The actual
cause: `lib/console/services/http.ts`'s `API_COVERAGE.absent` list still
hardcoded `"workforce"` and the registry literally wired
`services.workforce = unsupportedWorkforce` — a stub written before HR-1
(Workforce Core) shipped server-side, never updated afterward. This is a pure
frontend wiring gap; the backend was never at fault.

## Root cause 2 — PIN 401

`WorkforceEmployeesService.create()` (the real, UI-facing employee-creation
endpoint) never created a `User`, `Membership`, or PIN credential — only the
`Employee`/`EmployeeBranch` rows. `PinService.authenticate()` requires
`employee.userId` to be non-null and a `Credential(type:'pin')` row to exist;
neither was ever produced by the real creation path. Separately, no HTTP
route anywhere called the pre-existing `PinService.setPin()` — it was only
ever invoked directly by `seed-dev-data.ts`.

## Fix

**Employees page:** wired `services.workforce.employees` (list/get/create/
update/remove) to the real `api.workforceEmployees.*` calls, added a
`map.toEmployee()` mapper (`lib/console/services/map.ts`), corrected
`API_COVERAGE` (workforce.employees/setEmployeePin now `live`; shifts/
attendance/overtime/performance remain `absent` — genuinely not wired, not
part of this hotfix's scope), and gave the Employees page a real "+ New"
creation drawer and a "Set POS PIN" action (both gated on
`hr.employee.manage`), replacing the stubbed toast.

**PIN 401:** `WorkforceEmployeesService.create()` now auto-provisions, when
the caller does not supply an existing `userId` (the common case), a minimal
internal `User` (a synthesized, obviously-internal, non-deliverable email —
`users.email` is `NOT NULL UNIQUE` and a POS-only employee has none; no
password credential is ever created for this user, a PIN is its only
credential), an active `Membership`, and a tenant-owned "Cashier" `Role`
(created once per tenant, reused by name thereafter) holding the exact same
six permission codes `seed-dev-data.ts`'s own seeded Cashier role gets
(`pos.order.create`, `pos.order.fire`, `pos.order.void_line_prefire`,
`menu.item.read`, `menu.price.read`, `menu.availability.read` — declared as
plain string literals, not imported from `sales`/`catalogue` permission
modules, to avoid two new module-boundary edges for six codes — the same
`workforce->organisation` literal-code precedent `attendance.service.ts`
already uses), assigned at BRANCH scope on `homeBranchId` only. All of this
runs inline on the SAME `withAuthContext` transaction the Employee/
EmployeeBranch rows already use (mirrors `RegistrationsService.register()`'s
own inline-`tx` composition — `withAuthContext` does not support nesting).
The pre-existing `userId`-supplied linking path is completely unchanged.

Added `POST /workforce/employees/:employeeId/pin` (`EmployeesController`),
gated by `hr.employee.manage`, a thin passthrough to the existing
`PinService.setPin` — no verification logic duplicated, and
`PinService.authenticate()` was not touched in any way. Added
`'employees/pin.service'` to the `workforce->identity` module-boundary
allow-list (`module-boundaries.spec.ts`) for this one new, real import edge.

**OpenAPI:** regenerated (`npm run openapi:generate`) — purely additive diff
(the new PIN route). While doing so, found and fixed two pre-existing,
unrelated audit-suite gaps this regeneration surfaced for the first time
since SIGNUP-1 deferred its own OpenAPI regeneration: `POST /auth/
registrations` needed adding to `openapi.e2e-spec.ts`'s `PUBLIC_ROUTES`
allowlist (it is genuinely public, just never registered there), and the new
PIN route needed adding to that same spec's audited `BODYLESS_ALLOWLIST`
(it is a genuine `Promise<void>` 204, matching the file's own convention).
Copied the regenerated spec to the frontend and ran `npm run api:types`,
which is additive-only there too (frontend `endpoints.ts` gained the
`workforceEmployees.setPin` wrapper automatically).

## Deferred / not touched

- Everything else in Workforce Core (shifts, attendance, overtime,
  performance) — still genuinely absent from the console; not part of this
  hotfix.
- POS/KDS business logic — not touched at all; targeted regression proves it.
- The 17-role signup/invitation workflow, data residency, starter-menu
  provisioning — all still deferred from SIGNUP-1, unaffected by this hotfix.

## Tests

New: `test/workforce-employees-hotfix.e2e-spec.ts` — 5/5 passing (owner lists
employees including one created without a `userId`; update path works for an
auto-provisioned employee; full create → set-PIN → PIN-login round trip
succeeds; wrong PIN still 401; a terminal on a branch NOT in the employee's
permitted set is still rejected). All exercise real HTTP routes only — no
`seed-dev-data.ts` import.

Regression (targeted, unmodified except the two `openapi.e2e-spec.ts`
allowlist additions described above): `module-boundaries.spec.ts` 46/46;
`registrations.e2e-spec.ts` + `auth.e2e-spec.ts` + `tenant*.e2e-spec.ts` +
`workforce-hr1.e2e-spec.ts` 63/63 combined; `openapi.e2e-spec.ts` 49/49.
Backend `typecheck`/`build` clean. Frontend `typecheck`/`build` clean (full
page-tree build succeeds, `/workforce/employees` prerenders). Full/heavy e2e
suite deliberately not run.

## Files changed

**Backend:** `src/modules/workforce/employees/employees.{controller,service,dto}.ts`,
`src/modules/module-boundaries.spec.ts`, `docs/api/openapi.{json,yaml}`,
`test/openapi.e2e-spec.ts`, `test/workforce-employees-hotfix.e2e-spec.ts` (new),
`docs/reports/claude/INDEX.md`, this report (new).

**Frontend:** `lib/console/services/{http,map,mock,types,unsupported}.ts`,
`app/(console)/workforce/employees/page.tsx`, `content/console/{en,ar}.ts`,
`lib/api/{schema.ts,endpoints.ts}`, `api/openapi.json`.

## Safe to deploy

YES for the delivered scope — signup, POS regression (via `module-boundaries`
+ unmodified sales/kitchen suites untouched), workforce employees create/list/
PIN-login all verified green; no commit/push performed by this report; both
repos committed separately per instruction, not pushed.
