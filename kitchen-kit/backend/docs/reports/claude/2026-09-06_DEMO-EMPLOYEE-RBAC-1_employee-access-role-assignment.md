# DEMO-EMPLOYEE-RBAC-1 — Assign system roles from the Employees page

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (parent):** `4ae0417` (LIVE-DEMO-HOTFIX-2)
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Backend touched identity/authz (new canonical
role-template module), `RegistrationsService`, `WorkforceEmployeesService`/
`EmployeesController` (new role-assignment facade),
`module-boundaries.spec.ts` (new allow-list entries), `openapi.e2e-spec.ts`
(new route schema/allowlist entries), OpenAPI artifacts, and a new e2e spec.
Frontend touched the Workforce service layer, the Employees page, two
domain types, translation content, and the OpenAPI-derived client. A
pre-existing, unrelated uncommitted item (`PROD-DEMO-SMOKE` report + its
`INDEX.md` row) was left untouched, as in every prior session on this
branch.
**Task identifier:** DEMO-EMPLOYEE-RBAC-1 (assign/replace an employee's
system role from `/workforce/employees`)

## Mission

Let an Owner view, assign, and replace an employee's system role — Cashier,
Branch Manager, Shift Supervisor, or Kitchen Staff — directly from the
Employees page, scoped to tenant or branch, using the EXISTING
Role → MembershipRole → Permission RBAC model. No parallel
employee-permission system; no raw permission array accepted from the UI.

## EXISTING_RBAC_ENDPOINTS

`src/modules/identity/authz/rbac.controller.ts` (`@Controller('auth')`) was
already complete and is reused, not duplicated: `GET /auth/roles`
(`identity.role.read`), `POST /auth/roles` (`identity.role.create`),
`POST /auth/roles/:roleId/permissions` (`identity.role.update`),
`POST /auth/memberships/:membershipId/roles` (assign at explicit scope,
`identity.role.assign`), `GET /auth/memberships/:membershipId/roles` (list,
`identity.role.read`), `PATCH /auth/role-assignments/:assignmentId`
(re-scope/re-date), `DELETE /auth/role-assignments/:assignmentId`. All of it
delegates to `RolesService`/`MembershipRolesService`, whose atomic
epoch-bump + audit write (`MembershipRolesService.create`/`.remove`) is
reused **verbatim** by the new facade below — none of it is reimplemented.

## EMPLOYEE_IDENTITY_LINK

The Employees UI/`Employee` record knows only `employee.userId` (nullable),
never a `Membership.id` — and no existing endpoint resolves "the membership
for this user, acting as someone else" (`MembershipsService.listForUser` is
a caller-scoped, pre-tenant-selection method, not usable here). This is
exactly the "cannot be safely consumed without exposing internal IDs" case
the mission's own instructions anticipated, and is why a small facade — not
a redesign of RBAC — was added.

## EXISTING_SYSTEM_ROLES

Confirmed via `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
(~lines 5822-5853): **"ROS has no system-defined 'standard role' persistence
mechanism."** A tenant's Cashier/Branch-Manager-equivalent role is a POLICY
choice made by "the tenant-admin RBAC API or test/seed bootstrap" — never a
hardcoded role-name → permission-set rule in the authorization path itself.
`seed-dev-data.ts` already embodies this policy for Owner/Branch
Manager/Cashier; `RegistrationsService`/`WorkforceEmployeesService`
(SIGNUP-1/LIVE-DEMO-HOTFIX-1) already embody it in production for Owner and
an auto-provisioned Cashier. This session extracted that policy into one
shared, idempotent module
(`src/modules/identity/authz/canonical-role-templates.ts`) rather than
inventing a second copy, and authored two NEW templates (Shift Supervisor,
Kitchen Staff) using only existing permission codes.

## CASHIER_PERMISSION_GAP

**Confirmed and fixed.** `treasury.permissions.ts`'s own docblock quotes
`cash.session.open` as FR-POS-090 verbatim — "a cashier opening a shift and
declaring an opening float" — and `cash.session.close` as "close own
shift" (distinct from `cash.session.close_other`, which is manager-tier).
The Cashier role LIVE-DEMO-HOTFIX-1 auto-provisioned had **neither**, and
also lacked `pos.payment.capture` (a cashier who can create/fire an order
but never capture payment). All three are now in the canonical Cashier
template. Manager-only codes (`cash.session.close_other`,
`cash.variance.approve`, `cash.day.close`, `settings.branch.manage`,
`report.view.financial`, `cash.payin`/`cash.payout`/`cash.safedrop`) are
deliberately withheld — not requested by this ticket, not added silently.

## IMPLEMENTATION

**Canonical role templates** (`identity/authz/canonical-role-templates.ts`,
new): `CANONICAL_ROLE_TEMPLATES` (cashier/branch_manager/shift_supervisor/
kitchen_staff) + `ensureCanonicalRole(tx, tenantId, key)` — idempotent
create-or-reuse-by-name + permission upsert, inlined on the caller's own
transaction (this repository's established pattern for composing atomic
writes without nesting `withAuthContext`). Permission codes are imported
from each owning module's public `contract/` barrel — the same barrels
`identity/authz/permission-catalog.ts` (SIGNUP-1) already established —
zero new module-boundary edges for this file itself.

- **Cashier**: `pos.order.create`, `pos.order.fire`,
  `pos.order.void_line_prefire`, `pos.payment.capture`, `menu.item.read`,
  `menu.price.read`, `menu.availability.read`, `cash.session.open`,
  `cash.session.close`.
- **Branch Manager**: verbatim `seed-dev-data.ts`'s existing set (branch
  read/manage, order create/fire/void-prefire, catalogue reads, inventory
  view/adjust, cash session open, employee view/manage, sales/financial
  reporting).
- **Shift Supervisor** (authored — no prior precedent): everything Cashier
  has, plus `cash.session.close_other` (closing another cashier's shift)
  and `pos.discount.approve` (the catalogue's one generic manager-tier
  override permission). Deliberately without branch-manage, any reporting
  permission, or inventory-adjust — a considered judgment call, not a
  ratified template (per the governance register, role composition is a
  policy decision, not something to defer to a non-existent standard).
- **Kitchen Staff**: exactly `kds.operate` — per KDS-R11's explicit
  "MUST NOT be split" ratification.

**Signup seeding**: `RegistrationsService.register()` now also calls
`ensureCanonicalRole` for all 4 templates inside the same transaction as the
Owner role, so a fresh tenant's role dropdown is never empty.

**Auto-provisioning fix**: `WorkforceEmployeesService`'s
`grantAutoCashierRole` now calls `ensureCanonicalRole(tx, tenantId,
'cashier')` instead of its own narrower inline permission list — the
canonical-role fix, not a hardcoded patch onto one call site.

**New facade** (`EmployeesController`/`WorkforceEmployeesService`, employee-
scoped only — role LISTING still goes straight to the existing
`GET /auth/roles`, no new endpoint needed there):
- `GET /workforce/employees/:employeeId/role-assignments` (`identity.role.read`)
- `POST /workforce/employees/:employeeId/role-assignments` (`identity.role.assign`,
  `@Idempotent()` + `@ApiHeader`, body reuses `AssignRoleDto`/
  `AssignmentScopeDto` verbatim from `identity/authz/dto/assign-role.dto`)
- `DELETE /workforce/employees/:employeeId/role-assignments/:assignmentId`
  (`identity.role.assign`, confirms the assignment belongs to this
  employee's membership before delegating)

Each resolves `employeeId → employee.userId → Membership.id` (404 if no
employee, no linked user, or no membership — cross-tenant employees are
invisible under RLS, so this also closes the cross-tenant case) then
delegates verbatim to `MembershipRolesService.create`/`.listForMembership`/
`.remove`. The scope-DTO→domain mapping (`toAssignmentScope`) is a small,
deliberate duplication of `RbacController`'s own private (unexported,
therefore unimportable) mapper — identical checks, not a parallel design.
Self-elevation note: `MembershipRolesService`/`RolesService` do not
currently verify that the assigning actor already holds every permission
being granted — a pre-existing gap, not something this ticket adds or
closes (moot for the demo: Owner already holds the full catalog).

**Frontend**: `WorkforceService` gained `roleAssignments`/
`assignEmployeeRole`/`removeEmployeeRoleAssignment`; the role picker itself
reuses the ALREADY-real `services.security.roles` (`GET /auth/roles`), no
duplicate wrapper. The Employees drawer gained an "Access / Role" section
(mirroring the existing "Set POS PIN" section's pattern) showing current
assignment(s), a role dropdown, a branch/tenant-wide scope dropdown, and a
single Save that performs a **sequential, best-effort replace** (remove any
existing assignment(s), then create the new one — two independent backend
transactions, not one atomic call; acceptable for a P0 access-control action,
not a financial mutation). Explicitly NOT built, per the mission: a
permission-checkbox editor, a custom role builder, validity-date UI, an
approval workflow, bulk assignment, or a multi-assignment editor (backend
support for multiple simultaneous assignments is untouched and still there).

## BACKEND_FILES

New: `src/modules/identity/authz/canonical-role-templates.ts`,
`test/employee-role-assignments.e2e-spec.ts`, this report.
Modified: `src/modules/identity/registrations/registrations.service.ts`,
`src/modules/workforce/employees/employees.{controller,service}.ts`,
`src/modules/module-boundaries.spec.ts`, `test/openapi.e2e-spec.ts`,
`docs/api/openapi.{json,yaml}`, `docs/reports/claude/INDEX.md` (one new
row, surgically split from the unrelated pending `PROD-DEMO-SMOKE` row).

## FRONTEND_FILES

`lib/console/services/{types,http,mock,unsupported}.ts`,
`lib/console/services/map.ts`, `lib/console/types.ts` (new
`EmployeeRoleAssignment`), `app/(console)/workforce/employees/page.tsx`,
`content/console/{en,ar}.ts`, `lib/api/{schema,endpoints}.ts`,
`api/openapi.json`.

## TESTS

New `test/employee-role-assignments.e2e-spec.ts` — **5/5**:
1. Cashier: facade assign/list/remove cycle, effective permissions include
   `pos.order.create`/`pos.order.fire`/`pos.payment.capture`/
   `cash.session.open`/`cash.session.close` (read from the actual granted
   `RolePermission` rows — a PIN session is `typ:'pos'` and `JwtAuthGuard`
   correctly refuses it on `GET /auth/permissions`, which is not
   `@AllowPosSession()`-opted-in, so permission sets are verified at the
   database layer, the same rows `TenantContextService` itself resolves
   from), no manager-only permission present, and the Cashier actually
   opens their own cash session via the real `POST /cash-sessions` route.
2. Branch Manager: assign, exact branch-scoped manager permission set.
3. Kitchen Staff: assign, effective set is exactly `kds.operate`, and the
   employee reaches a real `GET /kds/stations/:stationId/queue` route (a
   Station has no HTTP creation route in this repository, so it is created
   directly via the admin/migrator client, mirroring `test/kds-fixtures.ts`'s
   own existing pattern).
4. Cross-tenant: a second tenant cannot see or act on the first tenant's
   employee (404, both on GET and on POST with a foreign roleId).
5. `authzEpoch` increments on the membership after a role replacement.

Regression: `test/registrations.e2e-spec.ts` **7/7** (all 4 canonical
templates now seed at signup without breaking existing assertions),
`test/workforce-employees-hotfix.e2e-spec.ts` **12/12**, `openapi.e2e-spec.ts`
**49/49** (after adding the two new routes' response schemas and the new
route's bodyless-204 allowlist entry), `module-boundaries.spec.ts` **46/46**
(two new, alphabetically-ordered `workforce->identity` allow-list entries:
`authz/canonical-role-templates`, `authz/dto/assign-role.dto`,
`authz/membership-roles.service`). Combined backend e2e: **66/66**. Full
E2E suite deliberately not run.

## TYPECHECK

Backend: clean. Frontend: clean.

## BUILD

Backend `nest build`: clean. Frontend `next build`: clean (all routes,
including `/workforce/employees`, prerender).

## Known deviations / follow-ups

- Shift Supervisor's exact permission composition is an authored judgment
  call (no prior precedent existed anywhere in this codebase) — flagged
  explicitly above, not presented as ratified.
- Self-elevation (an assigner granting a role with permissions they
  themselves lack) is not newly prevented — it was not prevented before
  this ticket either, and adding it was out of scope.
- The Save action's "replace" semantics are two sequential HTTP calls, not
  one atomic transaction — acceptable for this P0 UI, documented so it is
  not mistaken for a backend invariant.
- Backend support for multiple simultaneous scoped assignments per employee
  is untouched and still fully available via the underlying
  `MembershipRolesService`; only the P0 UI is single-assignment-at-a-time.

## SRS relevance

No SRS requirement is newly closed or reopened by this feature — it is a
UI/facade convenience over the already-ratified scoped-RBAC model
(FR-SEC-002/003/005), using only existing permission codes.
