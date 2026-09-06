# LIVE-DEMO-HOTFIX-2 — Employee-create Idempotency-Key header

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-05
**HEAD (backend, this task's parent):** `43638ed` (LIVE-DEMO-HOTFIX-1)
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Backend touched `src/modules/workforce/employees/employees.controller.ts`
and regenerated `docs/api/openapi.{json,yaml}`. Frontend touched
`api/openapi.json` (synced copy) and regenerated `lib/api/endpoints.ts`. A
pre-existing, unrelated uncommitted item (`PROD-DEMO-SMOKE` report +
its `INDEX.md` row) was left untouched, exactly as in prior sessions.
**Task identifier:** LIVE-DEMO-HOTFIX-2 (idempotency header for
`POST /workforce/employees` and `POST /workforce/employees/:id/pin`)

## Symptom (production evidence)

`POST /workforce/employees` → `400 Bad Request` — "Idempotency-Key header
is required for this operation." The Employees page (fixed in
LIVE-DEMO-HOTFIX-1) now loads and reaches the real backend, but employee
creation itself fails at the idempotency guard.

## Root cause

Both `EmployeesController#create` and the newly-added
`EmployeesController#setPin` (LIVE-DEMO-HOTFIX-1) already carry
`@Idempotent()`, which enforces the header requirement at runtime
(`src/common/idempotency/idempotency.interceptor.ts`). Neither route,
however, declared the header in its OpenAPI/Swagger decorators (unlike
e.g. `TreasuryController`'s idempotent routes, which pair `@Idempotent()`
with an explicit `@ApiHeader({name: 'idempotency-key', required: true, ...})`).

The frontend's typed-client generator
(`scripts/generate-api-types.mjs:284-286`) emits `idempotent: true` on a
wrapper **only when the OpenAPI operation declares an `Idempotency-Key`
header parameter** — it does not infer this from any other signal. Because
`employees.controller.ts` never declared that header, the generated
`lib/api/endpoints.ts` wrappers for `create`/`setPin` called
`http.post(path, { body })` with no `idempotent` flag, so the shared client
never generated or sent an `Idempotency-Key`, and the backend's own guard
correctly rejected every request with 400.

This is a genuine backend OpenAPI-metadata gap, not a frontend logic bug —
confirmed by reading the generator's source before touching anything, per
the task's own conditional allowance ("do not touch backend unless you
prove its OpenAPI/client metadata is wrong").

## Fix

Backend (`src/modules/workforce/employees/employees.controller.ts`):
added `@ApiHeader({ name: 'idempotency-key', required: true, description: ... })`
to `create` and `setPin`, mirroring `TreasuryController`'s exact existing
pattern verbatim. No behavior change — the runtime guard already enforced
this; only the OpenAPI documentation was missing. Regenerated
`docs/api/openapi.json`/`.yaml` (`npm run openapi:generate`) — diff is
additive only (the two new header-parameter declarations).

Frontend: synced the regenerated `api/openapi.json` and re-ran
`npm run api:types`. The generator now correctly emits
`idempotent: true` on both `workforceEmployees.create` and
`workforceEmployees.setPin` in `lib/api/endpoints.ts` — sourced entirely
from the existing shared `idempotent: true` mechanism in `lib/api/client.ts`
(auto-mints an `Idempotency-Key`). No hardcoded key, no ad-hoc header
code, no change to any other endpoint.

## Verification

- Backend `typecheck`: clean.
- Backend `openapi:generate`: succeeded; confirmed via the regenerated
  JSON that both `/workforce/employees` (POST) and
  `/workforce/employees/{employeeId}/pin` (POST) now declare the
  `idempotency-key` header parameter.
- Backend `build`: clean.
- Backend targeted tests: `test/openapi.e2e-spec.ts` (byte-identical
  regeneration audit) + `test/workforce-employees-hotfix.e2e-spec.ts`
  (create → set-PIN → PIN-login round trip) — **54/54 passed**.
- Frontend `typecheck`: clean.
- Frontend `build`: clean (`/workforce/employees` prerenders).
- Confirmed by direct inspection of the generated file that both wrapper
  calls now carry `idempotent: true`.

## Known deviations / follow-ups

- The same OpenAPI-metadata gap (missing `@ApiHeader` declaration despite
  `@Idempotent()`) likely also affects the sibling
  `update`/`deactivate`/`addBranch`/`setCompensation` routes on the same
  controller — not fixed here, as they were not reported as broken and
  this task was scoped to the two routes named in the production report.
  Worth a follow-up sweep.

## SRS relevance

No SRS requirement is newly closed or reopened by this hotfix. It is a
correctness fix to an existing FR-API-020/021 (idempotency) surface that
LIVE-DEMO-HOTFIX-1 introduced without full OpenAPI documentation.
