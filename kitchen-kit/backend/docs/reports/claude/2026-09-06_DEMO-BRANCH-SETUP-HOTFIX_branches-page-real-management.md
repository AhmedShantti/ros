# DEMO-BRANCH-SETUP-HOTFIX — Branches page must be real

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `0c5928a` (DEMO-OPS-HOTFIX-2)
**HEAD (frontend, this task's parent):** `5449678`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Backend added
`test/branches-signup-and-management.e2e-spec.ts` only — no source change.
Frontend touched `app/(console)/organisation/branches/page.tsx` only (2
one-line permission-key corrections). The same pre-existing, unrelated
`INDEX.md`/`PROD-DEMO-SMOKE` working-tree inconsistency noted in the prior
report was left exactly as found.
**Task identifier:** DEMO-BRANCH-SETUP-HOTFIX (Branches page real
management surface)

## Diagnosis

### 1. Signup's branch

`RegistrationsService.register()` (unchanged) creates, in the SAME
transaction: a `Brand` named after `dto.organisation`, a `Branch` named
"Main" under that brand (`timezone`/`baseCurrency`/`countryCode` from the
documented signup platform defaults), and its required `org.locations`
registry row (`locationType: 'branch'`) — mirroring
`BranchesService.create`'s own invariant exactly. The Owner's
`MembershipRole` is `scopeType: 'tenant'`. Confirmed by direct read; no
change needed or made.

### 2. Backend routes (`organisation.controller.ts`, unchanged)

- `POST /org/branches` — `CreateBranchDto` requires `brandId` (real UUID,
  server-validated same-tenant via composite FK), `code` (≤16 chars),
  `name`, `timezone`, `baseCurrency` (ISO-4217), `countryCode` (ISO-3166-1
  alpha-2); optional `address`/`automaticAvailability`. Permission:
  `settings.branch.manage`. **No `@Idempotent()`** — no Idempotency-Key
  needed (confirmed by reading the controller directly).
- `GET /org/branches` — tenant-owner-only (deliberately, per
  `live-session.ts`'s own docblock — a branch/brand-scoped actor gets 403
  here, ratified behaviour, not a bug). Permission: `settings.branch.read`.
- `GET/PATCH /org/branches/:id` — branch-scoped, `settings.branch.read` /
  `settings.branch.manage`.
- `GET /org/access` — the endpoint the session/branch-switcher (and this
  console's `useSession().availableBranches`, and the new Stations page's
  branch selector) actually reads, live-resolved from the caller's real
  scoped grants (`BranchesService.listAccessible` — a tenant-scoped grant
  short-circuits to every branch in the tenant, so Owner sees the Main
  branch here too).
- `POST /org/brands` exists (`settings.tenant.manage`) but is **not**
  needed for this fix — the Owner's signup-created brand already exists
  and is exactly what "Add Branch" should offer.

### 3. Frontend `/branches` page — root cause found

`app/(console)/organisation/branches/page.tsx` already had a real,
correctly-wired list (`services.organisation.branches.list()` →
`api.organisation.listBranches()` → `GET /org/branches`, unchanged, proven
live in prior tickets' e2e runs) and a real, correctly-wired create call
(`services.organisation.branches.create()` → `POST /org/branches`,
correctly deriving `brandId` from the session's real `availableBrands` —
never an invented UUID). **Both were already correct before this task.**

The actual defect: `PermissionKey` (`lib/console/permissions.ts`) is
declared as `(typeof PERMISSION_CATALOGUE)[number]["key"]`, but the
catalogue's own `def()` helper types its `key` parameter as plain
`string` — so `PermissionKey` resolves to `string`, not a literal union.
TypeScript therefore never rejects an arbitrary, wrong permission string
anywhere `usePermission`/`Gate` is called; there is no compile-time or
runtime signal when a key does not exist in the real backend catalogue.

`BranchesPage`'s "Add Branch" button was gated on
`usePermission("org.manage")`, and `BranchDrawer`'s management panels
(brand reassignment, drive-through toggle, operating hours / print
routing / station routing "Add" buttons) were gated on
`usePermission("org.branch.manage")`. **Neither string is a real backend
permission code** — confirmed by grepping every `*.permissions.ts` file
in the backend: the only real Organisation codes are
`settings.tenant.manage`, `settings.branch.read`, `settings.branch.manage`.
`"org.manage"` is declared only in the *frontend's own* catalogue (as a
label with no backend counterpart); `"org.branch.manage"` does not appear
in the frontend catalogue at all. Both therefore evaluate to `false` for
every user, including the Owner — hence no "Add Branch" button and no
per-branch management actions, regardless of what the Owner's real,
correctly-provisioned permission set actually contains.

The page-level `<Gate permissions={["org.manage", "settings.branch.manage",
"report.view.sales"]}>` still passes (`canAny` — the second, correct
string is enough), so the page itself renders and the branch list is not
blocked by this bug; only the create/manage affordances were hidden. I
could not reproduce "shows no branches" as a distinct, separate defect
anywhere in the list/fetch/mapping path — `GET /org/branches` and
`GET /org/access` are both proven, via a fresh e2e run in this task, to
return the Main branch immediately after signup, and `map.toBranch` has no
null-unsafe field that could throw on a freshly-created branch's shape. A
page with real rows but no way to add a second one is the most likely
account of "shows no branches" from an owner testing specifically for the
ability to add one.

### Sibling defect, found but out of scope for this ticket

The exact same `usePermission("org.manage")` pattern also gates the
manage button on `app/(console)/organisation/{brands,warehouses,
central-kitchens}/page.tsx` — not touched here, since this ticket is
scoped to Branches; flagged as a follow-up.

## Fix

`app/(console)/organisation/branches/page.tsx` — two one-line corrections:
`usePermission("org.manage")` → `usePermission("settings.branch.manage")`
(the "Add Branch" button), `usePermission("org.branch.manage")` →
`usePermission("settings.branch.manage")` (the branch-detail management
panels). No other line changed; no backend code changed.

## Tests

New `test/branches-signup-and-management.e2e-spec.ts` — **4/4 passed**:
1. Signup owner immediately sees the real "Main" branch via
   `GET /org/branches`.
2. The same branch is visible via `GET /org/access` (what the
   session/branch-switcher, and the Stations page's branch selector,
   actually read).
3. Owner creates a second branch using only the tenant's existing brand
   (from `GET /org/brands`, no invented id) — it appears in both
   `GET /org/branches` and `GET /org/access` immediately.
4. Cross-tenant branch access is rejected (404, RLS-invisible).

Backend `typecheck`/`build`: clean (no source changed). Frontend
`typecheck`/`build`: clean, `/organisation/branches` and
`/operations/stations` both prerender.

## SRS relevance

FR-BRN-001 (branch as the operational/isolation unit) is pre-existing and
unmodified. This is a presentation-layer correctness fix (FR-SEC-045: "a
client-side permission check is a courtesy, never a security control") —
the server-side authorization for branch create/read/update was already
correct and untouched; only the console's own client-side courtesy check
was wrong.
