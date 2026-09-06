# DEMO-OPS-HOTFIX-2 — Cashier shift open + KDS Stations setup

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `7a16d42` (DEMO-EMPLOYEE-RBAC-1)
**HEAD (frontend, this task's parent):** `ca23b73`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Backend touched
`src/modules/identity/authz/canonical-role-templates.ts` and
`src/modules/workforce/employees/employees.service.ts`; added
`test/cash-session-cashier-role.e2e-spec.ts`. No migration, no OpenAPI
change (no route/DTO touched). Frontend added
`app/(console)/operations/stations/page.tsx` and touched
`lib/console/nav.ts`, `content/console/en.ts`, `content/console/ar.ts`. A
pre-existing, unrelated uncommitted `INDEX.md` inconsistency (the working
tree is missing the already-committed `LIVE-DEMO-HOTFIX-2` /
`DEMO-EMPLOYEE-RBAC-1` rows relative to HEAD, plus the long-pending
`PROD-DEMO-SMOKE` row) was left exactly as found — not investigated or
"fixed" here, only this task's own row was inserted on top of it.
**Task identifier:** DEMO-OPS-HOTFIX-2 (cashier own-shift open 403; KDS
Stations setup UI)

## PART A — Cashier own-shift open 403

### Investigation

1. **Endpoint:** `POST /cash-sessions` (`TreasuryController#openCashSession`,
   `src/modules/treasury/treasury.controller.ts`).
2. **Required permission:** `TREASURY_PERMISSIONS.CASH_SESSION_OPEN`
   (`cash.session.open`), via `@RequirePermission`.
3. **Scope resolved:** `@AuthorizationTarget(sessionTerminalBranchTarget())`
   — for a POS session this resolves directly to
   `{type:'branch', branchId: auth.context.branchId}`, where
   `auth.context.branchId` is the terminal's OWN branch, re-verified live by
   `TenantContextService.resolvePosBranch` on every request (not from any
   client-supplied value, not from a token claim).
4. **Current canonical Cashier permissions**
   (`identity/authz/canonical-role-templates.ts`, unchanged by this task —
   read and verified correct): `pos.order.create`, `pos.order.fire`,
   `pos.order.line.void.prefire`, `pos.payment.capture`,
   `catalogue.item.read`, `catalogue.price.read`,
   `catalogue.availability.read`, **`cash.session.open`**,
   **`cash.session.close`**. This already includes everything Part A's
   symptom needs.
5. **Root cause — NOT the current template, NOT the scope-resolution code.**
   Reproduced the full flow end to end via real HTTP in a fresh e2e run
   (signup → create employee → auto-grant Cashier at branch scope → PIN
   login → `POST /cash-sessions`) and it returned **201**, and the manual
   "Employees page → Assign Role" flow (list → delete existing → `GET
   /auth/roles` → `POST .../role-assignments` → fresh PIN login → open
   session) **also** returned 201 — both paths work correctly against the
   *current* code.

   The actual gap is in the **manual RBAC-assignment path only**:
   `WorkforceEmployeesService.assignRoleToEmployee` (the handler behind
   `POST /workforce/employees/:id/role-assignments`, i.e. the Employees-page
   "Assign Role" action) resolves `roleId` from `GET /auth/roles` — an
   **existing** role, found by id — and hands it straight to
   `MembershipRolesService.create`. It never re-applies
   `ensureCanonicalRole`'s permission upsert to that existing row. Any
   tenant/employee whose "Cashier" role predates a template fix (the
   `LIVE-DEMO-HOTFIX-1` report documents its own original Cashier
   auto-provision cut as missing exactly `cash.session.open` /
   `cash.session.close` / `pos.payment.capture`) keeps a permanently stale
   role even after using the *current* RBAC UI to assign it — the auto-grant
   path (`WorkforceEmployeesService.create` → `grantAutoCashierRole`) always
   calls `ensureCanonicalRole` and so self-heals, but the manual-assignment
   path never did. This is consistent with every symptom reported (PIN login
   already worked; the manager used the new Employees-page role UI; the
   permission-scope 403 is exact, not a stale-token 403 — confirmed by
   comparing to `TenantContextService`'s distinct, differently-worded
   `STALE_SNAPSHOT` message).

   I could not directly inspect the live demo's actual database to confirm
   the affected role row's exact history (no access to that environment from
   this session — the local dev Postgres containers reachable here hold no
   tenant data), so this is the most-supported explanation from source and
   reproduction, not a confirmed read of the specific stale row. It is,
   however, the only mechanism under the current, already-reviewed code
   that can produce this exact 403 for a Cashier whose PIN login already
   succeeds.

### Fix

`identity/authz/canonical-role-templates.ts`: added
`canonicalRoleKeyForName(name)` — maps an existing `Role.name` back to its
`CanonicalRoleTemplateKey`, if it is one of the 4 canonical templates.

`workforce/employees/employees.service.ts` —
`WorkforceEmployeesService.assignRoleToEmployee`: before delegating to
`MembershipRolesService.create`, looks up the target role's name and, if it
matches a canonical template, calls `ensureCanonicalRole` for that key in
the same transaction. `ensureCanonicalRole` is idempotent
(create-or-reuse-by-name, upsert-only on `RolePermission`) — this call
reconciles the role's permission set to the CURRENT template on every
assignment through this endpoint, closing the gap for good rather than for
one employee. This is the fix at the level the ticket asked for — "the
canonical role template/provisioning" — not a hand patch on one employee,
and it changes no scope-authorization code, no Treasury logic, and no
existing permission definition.

### Tests

New `test/cash-session-cashier-role.e2e-spec.ts`:
1. Auto-provisioned Cashier opens own cash session — **201**, plus reaches
   `close-context` (proves `cash.session.close` scope too).
2. Manual RBAC reassignment (delete existing + create new, exactly mirroring
   the Employees-page UI, including the Idempotency-Key it already sends)
   still lets a fresh PIN login open a session — **201**.
3. A **STALE pre-existing "Cashier" role** (only `pos.order.create`,
   simulating a role that predates the current template) is repaired the
   next time it is assigned through the RBAC endpoint — confirmed the role's
   `RolePermission` rows include `cash.session.open`/`cash.session.close`
   after the assignment call, and the resulting PIN-login → open-session
   flow returns **201**. This is the test that would have failed before this
   fix and is the direct proof of the root cause and the fix.
4. Cashier PIN login at a foreign branch is rejected (401/403 — POS
   narrowing, unchanged).

**4/4 passed.**

### Known, pre-existing, out-of-scope gap (not fixed here)

`POST /cash-sessions/:id/close` (the actual physical close-declare call, as
opposed to reaching `close-context`) additionally requires a per-branch
cash-close policy (FR-FIN-006), which — like Drawer creation — has **no
public HTTP administration route** yet
(`test/cash-session-close.e2e-spec.ts` configures one directly via
`CashClosePolicyService`, not through the API; `drawers.service.ts`'s own
docblock is explicit that drawer creation is deliberately not exposed
either). Neither gap was reported as a blocker in this ticket (only "open"
was), and closing either is a materially larger, separate piece of work —
recorded here as a known follow-up, not attempted.

## PART B — KDS Stations setup

### Investigation

- **Backend routes** (`organisation.controller.ts`, unchanged, already
  present, already documented in OpenAPI):
  `POST /org/branches/:branchId/stations`,
  `GET /org/branches/:branchId/stations`, `GET /org/stations/:stationId`,
  `PATCH /org/stations/:stationId`. DTO: `CreateStationDto`
  (`name`, optional `capacityConfig`, `displayTerminalId`, `displayColour`).
  **Permission:** `ORGANISATION_PERMISSIONS.BRANCH_MANAGE`
  (`settings.branch.manage`) for create/update, `BRANCH_READ`
  (`settings.branch.read`) for list/get — branch-scoped via
  `@AuthorizationTarget`. **No `@Idempotent()`** on any station route — no
  Idempotency-Key is required, confirmed by reading the controller directly
  (no OpenAPI regeneration needed for this reason either).
- **Frontend service layer**: already fully wired to the real API —
  `services.operations.stations/createStation/updateStation`
  (`lib/console/services/http.ts`), listed under `API_COVERAGE.live` as
  `operations.stations`/`operations.createStation`/`organisation.station`/
  `organisation.stationRoutingRules`. This was **not** the stale-capability
  bug LIVE-DEMO-HOTFIX-1 found for Workforce — Stations' service layer was
  already real.
- **Root cause: no page at all.** `lib/console/nav.ts`'s Operations section
  had entries for Open Orders/Tables/Kitchen/Terminals but none for
  Stations, and no `app/(console)/operations/stations` route existed. The
  KDS screen (`components/terminal/kds-live.tsx`) already calls the SAME
  `useStations(scope)` hook and already renders
  `content/console/en.ts`'s pre-existing `"kds.noStations"` string —
  *"This branch has no stations set up yet. Add one under Operations →
  Stations."* — literally naming a destination that never existed. Station
  selection on the KDS screen is already `localStorage`-persisted
  (`getKdsStationId`/`setKdsStationId`) and already reload-safe.

### Fix

- `app/(console)/operations/stations/page.tsx` (new): gated on
  `settings.branch.manage`; a branch selector (only shown when more than one
  branch is in scope) backed by the session's real `availableBranches`;
  lists real stations for the selected branch via
  `services.operations.stations`; a "New station" drawer with `name`
  (required) and `capacityPerHour` (optional) that calls
  `services.operations.createStation` — the exact same service call the
  console's `useStations`/KDS path already consumes, so a created station is
  immediately visible to KDS on next load with zero KDS-side change.
- `lib/console/nav.ts`: added the Operations → Stations nav entry, gated on
  `settings.branch.manage` (same permission the route itself enforces).
- `content/console/{en,ar}.ts`: added `nav.stations` and 8 `stations.*`
  strings (both locales).
- **No backend change** — Part B needed none; both the routes and the
  permission model were already correct and already documented.

### Tests

- Frontend `typecheck`: clean.
- Frontend `build`: clean — `/operations/stations` prerenders alongside
  every other console route.
- Manual verification of the underlying API contract used a live e2e
  reproduction of the existing (unmodified) station routes was not
  re-added as a new backend test file, since Part B changed zero backend
  code; the routes' own pre-existing coverage is unaffected.

## Verification (both parts)

- Backend `typecheck`: clean.
- Backend `build`: clean.
- Backend targeted regression, single combined run: `cash-session-cashier-role`
  (4/4, new), `employee-role-assignments` (5/5), `workforce-employees-hotfix`
  (5/5), `registrations` (7/7) — **21/21 passed**.
- `openapi.e2e-spec.ts` (byte-identical regeneration audit): **49/49** —
  confirms Part A truly needed no OpenAPI change.
- `module-boundaries.spec.ts`: **46/46**, `KNOWN_DEVIATIONS` unchanged (the
  new `canonicalRoleKeyForName` import reuses the already-declared
  `workforce->identity` / `authz/canonical-role-templates` deviation entry;
  no new edge).
- Frontend `typecheck`: clean.
- Frontend `build`: clean.
- Full/heavy e2e suite deliberately not run, per the ticket's own
  instruction ("Targeted only. No full E2E.").

## SRS relevance

FR-POS-090 (own-shift open/close), the D-2/B1-3 scoped-RBAC amendment
(branch-scoped assignment + POS narrowing), and FR-KDS-001 (station
configurable name/colour/capacity) are all pre-existing, already-ratified
requirements this task did not reinterpret. No new permission, no new
role concept, no new Station model — Part A reconciles an existing role's
permission grants to its own already-ratified template; Part B exposes an
already-real API surface through a UI that was simply never built.
