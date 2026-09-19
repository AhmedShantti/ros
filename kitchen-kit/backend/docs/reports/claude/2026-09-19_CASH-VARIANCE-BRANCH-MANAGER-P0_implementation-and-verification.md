# CASH-VARIANCE-BRANCH-MANAGER-P0 — Implementation and Verification

**Report type:** Implementation and verification report.

**Authority statement:** This report is non-authoritative evidence. The SRS
(`ROS_SRS_v1.0.pdf`) and ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority.
This report ratifies nothing.

**Date:** 2026-09-19

**HEAD (before this task's commit):** `38fb9cc31be18822eedb5d71809bc3f5ef20984e`

**Branch:** `kds-station-discovery`

**Working tree summary:** 3 files modified
(`src/modules/identity/authz/canonical-role-templates.ts`,
`src/scripts/seed-dev-data.ts`, `test/cash-session-close.e2e-spec.ts`), 2
files added (a new migration and a new e2e spec), plus this report and its
`INDEX.md` entry.

**Task identifier:** CASH-VARIANCE-BRANCH-MANAGER-P0

Implements only the proven finding of
`docs/reports/claude/2026-09-19_CASH-VARIANCE-APPROVE-REJECT-P0_investigation.md`
Section A/"ROOT CAUSE(S)" item 1 — nothing beyond the decision scope this
task specified.

---

## STATUS

**Implemented, verified, committed locally. Not pushed.**

## FILES CHANGED

- `src/modules/identity/authz/canonical-role-templates.ts` — added
  `TREASURY_PERMISSIONS.CASH_VARIANCE_APPROVE` to
  `BRANCH_MANAGER_PERMISSION_CODES`; extended the Branch Manager docblock to
  document the new authority and its scope decision (Shift
  Supervisor/Cashier deliberately excluded).
- `src/scripts/seed-dev-data.ts` — added the same permission to the seeded
  demo "Branch Manager" role, matching the canonical template for this one
  permission (no other seed drift touched).
- `test/cash-session-close.e2e-spec.ts` — added a new describe block,
  `'Branch Manager canonical role — cash.variance.approve
  (CASH-VARIANCE-BRANCH-MANAGER-P0)'`, with 5 tests covering requirements
  A–L (see below); hoisted `branchManagerRoleId` out of `beforeAll` so it is
  reachable from the new tests.
- `prisma/migrations/20260919140000_backfill_branch_manager_cash_variance_approve_permission/migration.sql`
  — new, additive-only backfill migration.
- `test/branch-manager-cash-variance-approve-rls-aware-migration.e2e-spec.ts`
  — new migration proof spec.

## MIGRATION

```
prisma/migrations/20260919140000_backfill_branch_manager_cash_variance_approve_permission/migration.sql
```

RLS-aware, mirroring
`20260919130000_rls_aware_redeploy_backfill_branch_manager_cash_close_permissions`
exactly:

```sql
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM identity.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO identity.role_permissions (role_id, permission_id)
    SELECT r.id, p.id
    FROM identity.roles r
    CROSS JOIN identity.permissions p
    WHERE r.tenant_id = t.id
      AND r.name = 'Branch Manager'
      AND r.is_system = false
      AND p.code = 'cash.variance.approve'
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

Enumerates `identity.tenants` (never RLS-protected), sets
`app.tenant_id` per tenant before each scoped `INSERT`, filters to
non-system roles literally named `Branch Manager`, adds exactly one
permission code, `ON CONFLICT DO NOTHING`. No `UPDATE`/`DELETE`. No
`identity.membership_roles` row touched. No previously-applied migration
modified.

## BRANCH MANAGER PERMISSION

`CANONICAL_ROLE_TEMPLATES.branch_manager.permissionCodes` now includes
`cash.variance.approve` (confirmed by the unit spec
`canonical-role-templates.spec.ts`, 12/12 passing, and directly asserted by
the new e2e test "A/B/C — the canonical template grants the code to Branch
Manager only").

## SHIFT SUPERVISOR UNCHANGED

Not modified in `canonical-role-templates.ts` (`SHIFT_SUPERVISOR_PERMISSION_CODES`
untouched). Verified two ways:
1. e2e assertion: `CANONICAL_ROLE_TEMPLATES.shift_supervisor.permissionCodes`
   does not contain `cash.variance.approve`.
2. Migration proof spec: a seeded "Shift Supervisor" role (sharing the
   identical starting permission gap as the stale Branch Manager fixture)
   is snapshotted before and after both migration runs and asserted
   byte-identical (`toEqual`) both times — the migration's own
   `r.name = 'Branch Manager'` filter never matches it.

## CASHIER UNCHANGED

Not modified in `canonical-role-templates.ts` (`CASHIER_PERMISSION_CODES`
untouched) or in `seed-dev-data.ts`'s Cashier role. Verified two ways,
mirroring Shift Supervisor: an e2e template assertion, and a migration-proof
fixture "Cashier" role snapshotted unchanged across both migration runs.

## RLS MIGRATION PROOF

`test/branch-manager-cash-variance-approve-rls-aware-migration.e2e-spec.ts`
— run:

```
$ npm run test:e2e -- test/branch-manager-cash-variance-approve-rls-aware-migration.e2e-spec.ts
Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
```

Structure mirrors `branch-manager-cash-close-rls-aware-migration.e2e-spec.ts`:
a brand-new `createAppClient` (`ros_app`/`APP_DATABASE_URL`) connection,
confirmed to start with **no** `app.tenant_id` context
(`SELECT current_setting('app.tenant_id', true)` → null/empty), executes the
actual `migration.sql` file content (read from disk, never duplicated
inline) via `$executeRawUnsafe`. Two independent tenants. Proves:
- **Before:** each tenant's stale "Branch Manager" role (already holding
  `cash.session.open/close/close_other`, simulating a tenant already fixed
  by the prior migration) lacks `cash.variance.approve`.
- **After one execution:** both tenants' Branch Manager roles gain exactly
  that one code — nothing else.
- **Second execution** (a second, independent fresh `ros_app` connection):
  no-op, identical result.
- **Untouched throughout, both tenants, snapshotted before/after both
  runs:** the Shift Supervisor role, the Cashier role, a differently-named
  custom role sharing the identical starting gap, and the `MembershipRole`
  assignment row on the Branch Manager role (id/membership/role/scope/
  validity byte-identical via `toEqual`).

This proof is deliberately DB-level (`RolePermission` rows), not a live HTTP
round trip — `cash.variance.approve` is checked by the Approval Runtime
during `finalizeClose`, not by a route guard reachable without a full
declare-above-tolerance-then-finalize fixture; that live behavioural proof
exists separately, directly against the real canonical template (see next
section), and does not need the migration in the loop since a
freshly-provisioned tenant gets the template's current permission set
immediately.

## CANONICAL APPROVE TEST

New describe block in `test/cash-session-close.e2e-spec.ts`, using the
file's existing `branchManagerRole` fixture (built from
`CANONICAL_ROLE_TEMPLATES.branch_manager.permissionCodes` verbatim, exactly
like the pre-existing `close`/`close_other` canonical-role block) — never a
synthetic role with the permission manually added:

- **A/B/C:** template-level assertions (Branch Manager has it; Cashier and
  Shift Supervisor do not).
- **A (DB):** the real, persisted `RolePermission` rows for
  `branchManagerRoleId` contain `cash.variance.approve`.
- **D/E/F/G/H:** `employeeCashier` (owns the session, `cashierRole` holds
  only `cash.session.open`/`close` — no `close_other`) declares a
  count 5000 minor units above tolerance, then calls `finalize` supplying
  `employeeBranchManager`'s (a different employee) code + PIN. Asserts: 200,
  `outcome: 'closed'`, session's `expectedCash`/`countedCash`/`variance`
  match the frozen declared attempt exactly, `ApprovalRequest.requiredPermission
  === 'cash.variance.approve'`, `ApprovalDecision.approverId === userBranchManager`,
  decision `'approved'`. F is proven implicitly: the call succeeds despite
  the caller's role never holding `close_other`.
- **I:** `employeeBranchManager` opens and declares their OWN session, then
  attempts to finalize using their own code/PIN as "approver" → 403,
  session stays `closing` — self-approval blocked even for the newly-granted
  real canonical role.
- **J/K/L:** reject (200, `outcome: 'rejected'`, session stays `closing`,
  `closedAt` null) → a second `declare` on the same session → **409**
  (proves R-6(a) point 7: rejection does not permit a recount, using the
  real canonical role rather than the pre-existing synthetic-role test) → a
  fresh-id retry with the same real Branch Manager approver → 200,
  `outcome: 'closed'`.

## REJECT/RETRY TEST

Covered by the J/K/L test above, and unchanged/re-verified by the
pre-existing `"R-6(a): an explicit REJECTION commits..."` test in the same
file (still passing, untouched). **R-6(a) was not modified — no code in
`cash-session-close.service.ts`, the Treasury controller, or the Approval
Runtime was touched by this task**, exactly as instructed.

## SELF-APPROVAL TEST

Covered by the new "I" test above (real canonical Branch Manager
self-approving their own variance → 403), plus the pre-existing
`"self-approval is blocked..."` test in the same file (untouched, still
passing) for the original synthetic-role fixture.

## FOCUSED TESTS

```
$ npm run test:e2e -- \
    test/branch-manager-cash-variance-approve-rls-aware-migration.e2e-spec.ts \
    test/branch-manager-cash-close-rls-aware-migration.e2e-spec.ts \
    test/canonical-role-permission-backfill.e2e-spec.ts \
    test/branch-manager-cash-close-backfill.e2e-spec.ts \
    test/branch-manager-cash-close-redeploy-migration.e2e-spec.ts
Test Suites: 5 passed, 5 total
Tests:       6 passed, 6 total

$ npm run test:e2e -- test/cash-session-close.e2e-spec.ts
Test Suites: 1 passed, 1 total
Tests:       46 passed, 46 total

$ npm run test:e2e -- \
    test/cash-session-cashier-role.e2e-spec.ts \
    test/employee-role-assignments.e2e-spec.ts \
    test/rbac.e2e-spec.ts \
    test/scoped-rbac-migration.e2e-spec.ts \
    test/scoped-rbac.e2e-spec.ts
Test Suites: 5 passed, 5 total
Tests:       66 passed, 66 total

$ npx jest src/modules/identity/authz/canonical-role-templates.spec.ts
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```

## FULL TESTS

Unit (`npm test`): **90 suites, 1243 tests — all passed.**

E2e (`npm run test:e2e`, full suite): **119/128 suites, 1855/1875 tests
passed.** 9 suites / 20 tests failed:
`partition-lifecycle.e2e-spec.ts`, `catalogue.e2e-spec.ts`,
`reporting-authorization.e2e-spec.ts`, `sales.e2e-spec.ts`,
`procurement-supplier-foundation.e2e-spec.ts`, `inventory.e2e-spec.ts`,
`scheduler-rls.e2e-spec.ts`, `tenant-isolation/generated-cross-tenant.e2e-spec.ts`,
`openapi.e2e-spec.ts`.

**Confirmed pre-existing and unrelated to this task**, not a regression:
1. None of the 9 failing files reference `canonical-role-templates`,
   `seed-dev-data`, `Branch Manager`, or `cash.variance.approve` (checked by
   grep).
2. Directly reproduced on the pre-existing tree: `git stash` (removing all
   of this task's changes) and re-running `test/sales.e2e-spec.ts` +
   `test/openapi.e2e-spec.ts` alone reproduces the identical failures
   (e.g. `sales.e2e-spec.ts`'s public-surface-leak assertion on
   `/catalogue/branches/:branchId/tax-classes`) with this task's changes
   entirely absent. Stash was popped immediately after and the working tree
   confirmed restored.

None of the failures are in Treasury, identity/authz, or any file this task
touched.

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

Fresh-scratch-schema application independently confirmed by the e2e global
setup's own template-database rebuild log, which lists
`20260919140000_backfill_branch_manager_cash_variance_approve_permission`
immediately before "All migrations have been successfully applied."

## COMMIT SHA

See repository log (committed after this report was written — locally only).

## PUSHED

**NO.**

## LIVE TEST PLAN

Once this commit is authorized to deploy:
1. Deploy (this repo has no `render.yaml`/Dockerfile — dashboard-configured;
   `prisma migrate deploy` runs the new migration as part of the existing
   deploy flow, same as `38fb9cc`).
2. Confirm via a privileged one-off check (not this session's access) that
   the tenant(s) that produced the live "does not hold
   'cash.variance.approve'" failure now show that code on their "Branch
   Manager" role.
3. Reproduce the original live failing action: the same manager who
   previously got the `cash.variance.approve` 403 attempts to finalize the
   same class of above-tolerance close (a fresh cash session, since the
   original session's fate depends on what recovery the operator already
   took) → expect the finalize to succeed (or, if rejecting, to correctly
   commit as `outcome: 'rejected'` with the session still `closing`).
4. Confirm the second live failure (`cash.session.close_other`) separately —
   per the investigation report, this is most likely explained by the
   already-diagnosed stale-Branch-Manager-role data problem
   (`38fb9cc`/`ac85158`), not this task's change; it needs the SAME
   deployment (both migrations ship together) and the same live
   confirmation step against that specific tenant/role.
5. Do **not** attempt to test recount-after-reject in production — R-6(a)
   makes that explicitly impossible by design; the only valid live retry
   path is finalize-with-fresh-ids on the same declared count.

---

**Not done (explicitly out of scope, confirmed not needed):** Shift
Supervisor and Cashier permission grants; any Treasury
controller/service/Approval-Runtime code change; any frontend change; any
change to R-6(a)/reject/recount semantics; `organisation.branch.manage`
(`BRANCH_MANAGE`) or `organisation.branch.read` (`BRANCH_READ`) grants; any
push.
