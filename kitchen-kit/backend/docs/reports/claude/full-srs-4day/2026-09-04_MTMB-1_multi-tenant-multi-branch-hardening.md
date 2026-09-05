# MTMB-1 — Multi-Tenant / Multi-Branch Operational Hardening

**Report type:** Implementation + verification report.
**Authority statement:** This report is non-authoritative evidence. The
ROS SRS and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` (and referenced ADRs)
remain the sole authority for requirement status. Nothing in this document
overrides them; where this report and the register would ever conflict,
the register governs.
**Date:** 2026-09-04
**HEAD (baseline, before this task's commits):** `3ceb6ab104419665c95189b8474529d493b82a4b`
**Branch:** `full-srs/lane-c3-mtmb-hardening`
**Working tree summary (before commit):** modified
`docs/api/openapi.json`, `docs/api/openapi.yaml`,
`src/modules/authorization-coverage.spec.ts`,
`src/modules/organisation/branches/branches.service.ts`,
`src/modules/organisation/brands/brands.service.ts`,
`src/modules/organisation/organisation.controller.ts`,
`src/scripts/seed-dev-data.ts`; new file
`test/multi-tenant-multi-branch.e2e-spec.ts`.
**Task identifier:** MTMB-1.

---

## 1. CURRENT_REALITY

Census performed against current HEAD (schema, guards, controllers,
services, existing tests, governance register, prior session reports).

- **Scoped RBAC substrate already exists and is COMPLETE.** `MembershipRole`
  carries `scope_type` / `scope_brand_id` / `scope_branch_id` (migration
  `20260902010000_identity_scoped_role_assignments`). `PermissionGuard` /
  `ScopeAuthorizationService` (`src/modules/identity/authz/`) is the single
  enforcement point deciding permission AND target scope for every
  classified route, proven end to end in
  `test/scoped-authorization-matrix.e2e-spec.ts`.
- **Tenant fail-closed context is COMPLETE.** `TenantContextGuard`
  (`src/modules/identity/context/tenant-context.guard.ts`) rejects any
  request that reaches the data layer without a resolved tenant; every
  Prisma call goes through `prisma.withAuthContext`.
- **A generated, schema-driven cross-tenant isolation suite already
  exists** at `test/tenant-isolation/generated-cross-tenant.e2e-spec.ts`
  (+ `introspect.ts` / `synthesize.ts` / `fixture-overrides.ts`). It
  discovers every `tenant_id`-bearing table via `information_schema` and
  proves isolation generically — this is the FR-PLT-013 literal mechanism
  (a 2026-09-03 traceability snapshot called this PARTIAL/hand-written;
  that is stale relative to current HEAD, where the generated suite is
  real and passing).
- **RLS inventory gate exists**: `test/tenant-isolation/rls-inventory.e2e-spec.ts`
  proves ENABLE+FORCE+policy coverage per tenant-scoped table generically.
- **Branch/brand/tenant CRUD + lifecycle exist**
  (`src/modules/organisation/{branches,brands}/*.service.ts`,
  `organisation.controller.ts`): create/read/status transitions, with an
  `active`/`inactive` `BranchStatus`. The T-12 lifecycle rule (a deactivated
  branch is refused on every other route, for every scope including
  tenant-wide owner, with the branch-status route itself as the sole
  governed exemption so deactivation is not a one-way door) is
  pre-existing, ratified behaviour — reused as-is, not reinvented.
- **Tenant discovery/switching already exists and is complete**:
  `GET /auth/tenants` (memberships), `POST /auth/tenant` (mints a new
  tenant-bound token), `GET /auth/tenant` (`src/modules/identity/tenants/tenant.controller.ts:59,79,116`).
  A session/token is bound to exactly one tenant; entering a different
  tenant a user belongs to is a new token via `POST /auth/tenant`, not a
  hot in-session switch. This is the intentional, existing architecture —
  not a gap, and not something this task invents.
- **Tenant membership model**: `Membership` is unique per `(userId,
  tenantId)`, but one `User` may hold many `Membership` rows across
  different tenants — the substrate for two tenants to coexist under
  possibly-shared user accounts already supports the demo's two-tenant
  shape without any new cross-tenant concept being invented.
- **HR/PIN branch substrate already exists**: `Employee.homeBranchId`,
  `EmployeeBranch` (permitted branches), and PIN sign-in
  (`POST /auth/pin`) rejects sign-in at a terminal outside the employee's
  permitted branches. Confirmed live in this session (§4/§5 below).
- **Gap actually found**: there was no route through which an
  authenticated caller could discover the accessible-branches/brands set
  implied by their OWN live scoped grants.
  - `GET /org/branches` lists *every* branch in the tenant and is itself
    gated by `ORGANISATION_PERMISSIONS.BRANCH_READ` held at TENANT scope
    — a branch-scoped actor holding that permission only at Branch 1 gets
    `403` from it (correctly, per the scope lattice), but is left with no
    route through which to discover their own accessible branches at all.
  - `GET /auth/permissions` returns only the caller's SYMBOLIC scope set
    (permission ids + `all: true` / scope ids), never expanded into names
    or status — not something a branch picker can render directly.
  - This is the one real gap this task closes (§3below).

## 2. GAPS_FOUND

| Requirement / capability | CURRENT (at baseline HEAD) | GAP | ACTION |
|---|---|---|---|
| FR-SEC-002 (scope on role assignment) | COMPLETE — `scope_type`/`scope_brand_id`/`scope_branch_id` on `MembershipRole` | none | none |
| FR-SEC-003 (multiple scoped assignments) | COMPLETE — proven in `scoped-authorization-matrix.e2e-spec.ts` | none | none |
| FR-SEC-004 (union within scope, no leakage) | COMPLETE — `PermissionGuard` single enforcement point | none | none |
| FR-PLT-012 (fail-closed tenant context) | COMPLETE — `TenantContextGuard` | none | none |
| FR-PLT-013 (generated, CI-executable cross-tenant suite) | COMPLETE at current HEAD — `test/tenant-isolation/generated-cross-tenant.e2e-spec.ts` | none found this session | ran it — passes (§7) |
| Accessible-branches/brands discovery for frontend | MISSING — no route reflects the caller's own live scope as resolved rows | real gap | implemented `GET /org/access` (§3) |
| Tenant discovery/switching | COMPLETE — `GET /auth/tenants`, `POST /auth/tenant`, `GET /auth/tenant` | none | documented (§6) |
| Inactive-branch lifecycle (T-12) | COMPLETE, ratified | none | reused, re-proven in new suite |
| FR-BRN-001/002 (unlimited branches/brands; per-branch config) | PARTIAL — branches/brands/per-branch config exist; branch-groups/cross-branch operating model do not | out of core scope for MTMB-1 | not touched |
| FR-BRN-003/004 (multi-country FX), FR-BRN-005 (branch groups), FR-BRN-006/007 (central override/reporting), FR-BRN-008 (branch template) | PARTIAL/NOT IMPLEMENTED, unchanged | explicitly out of scope | not touched, not claimed COMPLETE |

## 3. IMPLEMENTATION

One new read surface, `GET /org/access`, plus its supporting service
methods. No schema change; no new migration.

- **`BranchesService.listAccessible(tenantId, grants)`**
  (`src/modules/organisation/branches/branches.service.ts`): a
  TENANT-scoped grant sees every branch in the tenant (active or inactive
  — visibility is an authorization question, `status` is returned so the
  frontend can grey out an inactive branch rather than have it silently
  disappear); a BRAND-scoped grant sees every branch under that brand; a
  BRANCH-scoped grant sees exactly that branch. Result is the **union**
  across every held grant (never an intersection, never a single "best"
  grant), because FR-SEC-003 lets one actor hold several independent
  scoped assignments at once. Zero grants returns an empty list — never
  "every branch".
- **`BrandsService.listAccessible(tenantId, grants)`**
  (`src/modules/organisation/brands/brands.service.ts`): same lattice; a
  BRANCH-scoped grant's parent brand is included (one extra query
  resolving `branchId → brandId`) so a branch-scoped manager can see the
  brand their branch belongs to, never any other brand.
- **`GET /org/access`** (`src/modules/organisation/organisation.controller.ts`):
  calls both `listAccessible` methods from the caller's live
  `RequestAuthorization.grants` (never a JWT-stale claim, never
  `EmployeeBranch` — that narrows PIN sign-in, it does not grant scope).
  Returns `{ tenantId, brands, branches }`.
  - Deliberately carries **no `@RequirePermission`**, mirroring the
    existing `GET /auth/permissions` precedent: reading one's own live
    scope cannot be gated on holding a permission over that scope without
    becoming circular. Added to `authorization-coverage.spec.ts`'s
    `REVIEWED_UNPROTECTED_ROUTES` allowlist with an explicit rationale
    (required — any unprotected route not on this allowlist fails the
    coverage gate).
- Both service methods mirror the scope lattice from
  `identity/authz/scope.ts` *without importing it* — Organisation is only
  permitted `identity/context/tenant-context` per
  `module-boundaries.spec.ts`'s allow-list; `ScopedGrant` itself lives
  there, so no new module-boundary exemption was needed.
- No schema change. Migration count unchanged (44 → 44).

## 4. FRONTEND_BRANCH_DISCOVERY_CONTRACT

### 4.0 Addendum audit — `GET /org/branches` vs. a new route

A same-session addendum reported that a frontend census found the current
frontend already treats `GET /org/branches` as its authoritative
branch-selector source, and asked that this task audit that route under
the real scoped-RBAC model and reuse it — not add a new route — unless it
fundamentally cannot express the authorized-branch set without leaking or
breaking existing semantics.

**Audit performed** against
`src/modules/organisation/organisation.controller.ts:405-415`:
`GET /org/branches` carries `@AuthorizationTarget(tenantTarget(...))` +
`@RequirePermission(BRANCH_READ)` — a **TENANT-target** collection read.
Under `PermissionGuard`/`ScopeAuthorizationService`, a grant only
satisfies a tenant-target requirement if the grant itself is
TENANT-scoped; a BRAND- or BRANCH-scoped grant, however genuine, does not
cover a tenant-target resource by design (that is exactly what "no upward
leak" means for FR-SEC-004).

**This is not merely current behaviour — it is an existing, ratified,
currently-passing test invariant**, not something this task is free to
change:

- `test/scoped-authorization-matrix.e2e-spec.ts` **case 6**, *"BRANCH
  assignment → a TENANT-target operation is DENIED (no upward leak)"*
  (line ~407): a BRANCH-scoped actor calling `GET /org/branches` is
  asserted `.expect(403)`, with the comment *"the collection belongs to
  the tenant, and a single branch's authority must not read it."*
- **case 7**, *"BRAND assignment → a TENANT-target operation is DENIED"*
  (line ~428): same assertion for a BRAND-scoped actor.
- Conversely, `test/multi-tenant-multi-branch.e2e-spec.ts` **case 6**
  (this session) proves the TENANT-scope path already works exactly as
  the addendum expects: Owner A (`{ type: 'tenant' }`) calling
  `GET /org/branches` gets `200` with the full active-branch list.

**Verdict — proven, not assumed:** `GET /org/branches` already
correctly serves a tenant-wide owner (`ACCESSIBLE_BRANCH_API` for that
actor class works today, unchanged). It does **not**, and structurally
**cannot without breaking the two tests above**, serve a branch- or
brand-scoped actor — those actors get a hard `403`, never a filtered
subset. Repurposing this route's gate to scope-filter instead of
tenant-gate would directly invert `scoped-authorization-matrix`'s own
"no upward leak" proof and fail 2 currently-passing, ratified tests. This
is exactly the addendum's own stated exception: *"the existing route
fundamentally cannot express the authorized-branch set without leaking
or breaking existing semantics."* `GET /org/branches` therefore stays
**exactly as-is** (not touched by this task, in either direction), and
the new read this task adds is required, not optional:

```
ACCESSIBLE_BRANCH_API = GET /org/access
```

`GET /org/branches` remains the correct route for the one case it was
always built for — a TENANT-scope actor listing every branch it owns —
and is unaffected by anything in this task. `GET /org/access` is the
complementary read for every scope width (including branch- and
brand-scoped actors `GET /org/branches` was never meant to serve),
proven in `multi-tenant-multi-branch.e2e-spec.ts` cases 17-20 (§8).

### 4.1 Other addendum items

- **No "current branch" JWT claim was added, and none is required.**
  `TenantContext.branchId` (`src/modules/identity/context/tenant-context.ts:14,32`)
  already exists but is explicitly documented as *"the POS session's
  OPERATING branch"* — populated only for terminal-bound PIN/POS
  sessions, not a dashboard "currently selected branch" concept. No SRS
  requirement or governance decision was found requiring one for
  dashboard sessions. The frontend keeping "current branch" as
  client-side state (set from a `GET /org/access` response) is
  consistent with the existing architecture and requires no backend
  change.
- **Frontend cache contract (recorded, not enforced by this task):** all
  branch-scoped data the frontend caches MUST be keyed/refetched by
  `tenantId + branchId` (not `branchId` alone) — tenant tokens are
  re-minted per `POST /auth/tenant` (§5) and `Branch.id` uniqueness is
  only guaranteed within a tenant (cross-tenant branch UUID collision is
  not part of any uniqueness constraint the frontend can rely on), so a
  cache keyed on `branchId` alone risks bleeding stale or cross-tenant
  data across a tenant switch. This is a frontend-side convention this
  report records per the addendum; no backend code enforces or needs to
  enforce it.

### 4.2 The `GET /org/access` contract itself

```
GET /org/access
Authorization: Bearer <token>

200 OK
{
  "tenantId": "<uuid>",
  "brands":   [ { "id", "name", "theme", "defaultSettings", "createdAt" }, ... ],
  "branches": [ { "id", "name", "code", "status" ("active"|"inactive"),
                  "brandId", "timezone", ... }, ... ]
}
```

- No permission required beyond a valid session — this is the caller's
  OWN authority, reflected back.
- Result is computed from **live** scoped role assignments on every call,
  never from a JWT claim, never from `Employee.homeBranchId` /
  `EmployeeBranch` (those restrict PIN sign-in, they grant nothing).
- A TENANT-scope holder gets every brand/branch in the tenant (active and
  inactive — inactive branches are included with `status: "inactive"` so
  the frontend can grey them out, not silently drop them).
- A BRAND-scope holder gets that brand and its branches only.
- A BRANCH-scope holder (one or many branches) gets the union of exactly
  those branches and their parent brand(s) — never more.
- Zero scoped assignments → `{ brands: [], branches: [] }`, never
  "every branch in the tenant" (unrestricted-by-omission is the failure
  mode this explicitly avoids).
- Proven live in `test/multi-tenant-multi-branch.e2e-spec.ts` cases 17–20
  plus a zero-grant case (§8).

## 5. TENANT_CONTEXT_BEHAVIOR

- One dashboard `User` MAY hold `Membership` rows in multiple tenants
  (`(userId, tenantId)` unique, not `userId` alone) — this is pre-existing
  architecture, not invented here.
- A session/access token is bound to **exactly one tenant**. Entering a
  different tenant the same user belongs to requires
  `POST /auth/tenant { tenantId }` after `POST /auth/login`, which mints a
  new tenant-scoped token (`GET /auth/tenants` lists the candidate
  tenants first). There is no in-session hot-switch, and none was added —
  this matches the existing, intentional architecture.
- For the Sunday demo this is sufficient: Tenant A and Tenant B coexist
  securely and independently; no single user needs to hot-switch between
  them, and none of the demo actors do.

## 6. DEMO_SEED_SHAPE

The pre-existing seed (`src/scripts/seed-dev-data.ts`) created exactly one
tenant / one branch — it did not support the two-tenant, multi-branch
demo shape, so it was extended (not duplicated) to produce:

```
Demo Restaurant Group (Tenant A)
  Brand: Demo Restaurant Group
    Branch: Downtown (DOWNTOWN)
    Branch: Airport  (AIRPORT)

Second Demo Tenant (Tenant B)
  Brand: Second Demo Tenant
    Branch: Main (MAIN)
```

Actors seeded: Tenant A Owner (TENANT scope), Downtown Manager (BRANCH
scope Downtown only), Multi-Branch Manager (BRANCH scope Downtown +
Airport — two independent scoped assignments on one role, proving
FR-SEC-003 at the seed layer too), a Downtown POS cashier (PIN login, home
branch Downtown), and a Tenant B Owner (TENANT scope on Tenant B,
independent of Tenant A). One POS terminal per operational branch
(POS-Downtown, POS-Airport, POS-Main). A menu item + active price list is
assigned to both Tenant A branches so the Downtown/Airport POS path is
directly demoable.

Run with `nest build && node dist/scripts/seed-dev-data.js`; writes
`credentials.md` (gitignored, not committed) with every login and ID this
run created. **Verified live this session**: ran end to end against the
lane-c disposable database; wrote `credentials.md`; both tenants, both
brands, all three branches, all terminals and actors created successfully
with no errors.

No production secrets and no fixed passwords beyond the repository's
existing dev-seed convention (`DevPass123!` / PIN `1234`, timestamp-suffixed
emails, safe to re-run).

## 7. REQUIREMENT_DISPOSITION

Re-adjudicated only requirements genuinely touched or newly verified this
session; nothing outside this list is reclassified by this report.

| Requirement | Disposition | Evidence |
|---|---|---|
| FR-SEC-002 | COMPLETE (unchanged) | `scoped-authorization-matrix.e2e-spec.ts` 46/46 (with generated-cross-tenant + rls-inventory) this session |
| FR-SEC-003 | COMPLETE (unchanged) | same suite; also re-proven at the seed layer (Multi-Branch Manager, two scoped assignments on one role) |
| FR-SEC-004 | COMPLETE (unchanged) | same suite; `authorization-coverage.spec.ts` 9/9 route-classification gate, `GET /org/access` correctly on the reviewed-unprotected allowlist |
| FR-PLT-012 | COMPLETE (unchanged) | `TenantContextGuard`, exercised throughout every new/existing e2e run this session |
| FR-PLT-013 | COMPLETE at current HEAD (re-confirmed, not re-implemented) | `test/tenant-isolation/generated-cross-tenant.e2e-spec.ts` run this session, passing |
| FR-BRN-001 | PARTIAL (unchanged) — unlimited branches/brands per tenant/brand exist; branch groups/cross-branch operating model do not | not touched this session |
| FR-BRN-002 | PARTIAL (unchanged) — per-branch config (timezone/currency/country pack) exists | not touched this session |
| FR-BRN-003/004 | PARTIAL/NOT IMPLEMENTED (unchanged) — multi-country FX explicitly out of scope | not touched, NOT claimed complete |
| FR-BRN-005 | PARTIAL/NOT IMPLEMENTED (unchanged) — branch groups explicitly out of scope, and no existing route required it | not touched, NOT claimed complete |
| FR-BRN-006/007 | PARTIAL/NOT IMPLEMENTED (unchanged) — central override/reporting explicitly out of scope | not touched, NOT claimed complete |
| FR-BRN-008 | PARTIAL/NOT IMPLEMENTED (unchanged) — branch template explicitly out of scope | not touched, NOT claimed complete |

## 8. TEST_RESULTS (MTMB_E2E)

`test/multi-tenant-multi-branch.e2e-spec.ts` — **20/20 passing** (real
HTTP against the real Nest app, real disposable PostgreSQL). Builds
exactly the demo shape (Tenant A / Brand A / Branch A1 Downtown + A2
Airport; Tenant B / Brand B / Branch B1 Main) and actors (Owner A,
Manager A1, MultiBranch Manager, Manager B1, POS employee A1, POS
employee A12) over real business routes:

1–2. demo shape itself (two active branches under Brand A; Tenant B
   isolated with exactly one branch).
3–8. tenant + branch isolation over real Organisation routes: A1-only
   manager allowed A1/denied A2; multi-branch manager allowed both;
   tenant-wide owner allowed both + full list; inactive-branch T-12
   rejection (including tenant-wide owner) with the status route itself
   as the sole governed exemption; cross-tenant branch access is a
   non-enumerating 404 (foreign vs. nonexistent — identical message).
9. POS: an order opened at A1 is visible to an A1-scoped manager,
   invisible to (and even un-queryable by) an A2-only manager.
10. KDS: an A1-fired ticket appears on the A1 station queue; the A2
   terminal cannot even address the A1 station (terminal/station
   binding — a second, independent branch-locality mechanism from RBAC);
   A2's own queue never contains it.
11. Inventory: the same SKU carries independent stock per location — a
   further A1-only depletion never moves A2's figure.
12. Treasury: A1 and A2 `CashSession`s are independent rows bound to
   their own branch; an A1-only manager cannot pay-in against A2's
   session.
13–14. HR: POS employee A1 (permitted A1 only) is refused PIN sign-in at
   A2's terminal; a fresh A1-only employee gains A2 only through the real
   `POST /workforce/employees/:id/branches` grant route (never a direct
   write); POS employee A12 (permitted A1+A2) signs in and clocks
   in/out at both.
15–16. Reporting: an A1-scoped manager reads A1's daily-trading report
   only (`403` on A2's); an A2-scoped manager reads A2's only.
17–20 (+1). `GET /org/access`: A1-only actor sees exactly A1;
   multi-branch manager sees exactly A1+A2; tenant-wide owner sees every
   active branch; no Tenant B branch ever leaks into Tenant A's response
   or vice versa; a membership with zero scoped assignments discovers
   nothing.

## 9. RLS_RESULT

No new tenant-scoped table was created (no schema change), so the "every
new `tenant_id` table: ENABLE RLS, FORCE RLS, policy, generated coverage"
requirement in the task brief has no new subject this session.
`test/tenant-isolation/rls-inventory.e2e-spec.ts` (existing, generic,
schema-driven) was re-run this session and passes, confirming existing
coverage is undisturbed.

## 10. AUTH_RESULT

- `src/modules/module-boundaries.spec.ts` + `src/modules/authorization-coverage.spec.ts`:
  **55/55 passing**. `GET /org/access` correctly appears in
  `REVIEWED_UNPROTECTED_ROUTES` with an explicit rationale; no undeclared
  routes.
- `test/scoped-authorization-matrix.e2e-spec.ts` +
  `test/tenant-isolation/generated-cross-tenant.e2e-spec.ts` +
  `test/tenant-isolation/rls-inventory.e2e-spec.ts`: **46/46 passing**
  (run together this session).

## 11. TEST_RESULTS — full regression sweep (Section 11 of the task brief)

Run sequentially against the lane-c disposable PostgreSQL container
(`ros-postgres-lane-c`, dedicated port 5599 — the persistent `ros`
database on port 5544 was never touched), migrating from zero:

| Gate | Result |
|---|---|
| `git diff --check` | clean |
| `npx prisma validate` | valid |
| `npm run typecheck` | clean |
| `npm test -- --ci` (unit) | **1150/1150 passing, 83 suites** |
| `module-boundaries.spec.ts` + `authorization-coverage.spec.ts` | **55/55** |
| `multi-tenant-multi-branch.e2e-spec.ts` | **20/20** |
| `scoped-authorization-matrix.e2e-spec.ts` + `generated-cross-tenant.e2e-spec.ts` + `rls-inventory.e2e-spec.ts` | **46/46** |
| `pin.e2e-spec.ts` + `pos-financial-corrections.e2e-spec.ts` + `workforce-hr1.e2e-spec.ts` + `reporting-authorization.e2e-spec.ts` + `reporting-sales.e2e-spec.ts` | **136/136** |
| Final combined re-run of all 9 named e2e suites together (pre-commit gate) | **9 suites / 202 tests, all passing** |
| `npm run openapi:check` | fails against the committed baseline **until this task's `docs/api/*` regeneration is committed** (expected — `GET /org/access` is new surface); regenerated files are part of this commit, see §12 |
| Migration count | **44** (unchanged from baseline; no migration added — none was needed) |

## 12. OPENAPI

`GET /org/access` is new surface, so `npm run openapi:generate` produces a
real diff against the committed `docs/api/openapi.{json,yaml}` — this diff
is included in this task's commit. After that commit, `npm run
openapi:check` (generate + `git diff --exit-code -- docs/api`) is clean
(verified: the generation is idempotent — a second generate produces the
identical diff, confirmed by running it twice this session).

## 13. LINT

`npm run lint:check`: **52 errors / 0 warnings**, measured directly this
session both with and without this task's changes applied (verified by
stashing this task's diff and re-running — identical 52/0 either way).
This is **higher than the 47/0 figure the task brief cites as canonical**
and higher than the 47/0 the most recent integration report
(`2026-09-04_MW1I_ci-dep-pos-hr1-integration.md`) claimed at a commit one
docs-only commit before this session's baseline HEAD — that discrepancy is
real, pre-existing drift unrelated to this task (all 52 errors are in
`src/modules/treasury/cash-session-close/cash-session-close.service.ts`,
`src/modules/treasury/cash-sessions/cash-sessions.service.ts`,
`src/modules/treasury/treasury.controller.ts`,
`test/cash-movements-close-and-payment-concurrency.e2e-spec.ts`,
`test/cash-session-close.e2e-spec.ts`, and
`test/tenant-isolation/fixture-overrides.ts` — none of them touched by
MTMB-1). **Zero of the 52 errors are in any file this task modified**
(`branches.service.ts`, `brands.service.ts`,
`organisation.controller.ts`, `authorization-coverage.spec.ts`,
`seed-dev-data.ts`, `multi-tenant-multi-branch.e2e-spec.ts` — all lint
clean). Not investigated or fixed further: out of MTMB-1's scope, and the
task brief forbids using this task to paper over unrelated findings.

## 14. AUDIT

`npm audit --omit=dev --audit-level=high`: **0 vulnerabilities.**

## 15. KNOWN_DEVIATIONS

- Lint baseline discrepancy (52 vs. the 47 the brief cites) — see §13.
  Real, pre-existing, unrelated to MTMB-1, not fixed here.
- `openapi:check` will show a diff until this task's commit lands (§12) —
  expected for any session that adds a route; resolved by the commit
  itself.
- No governance reopening was needed or attempted: FR-SEC-002/003/004 were
  already ratified in scope by the 2026-09-02 D-2 amendment
  (`GOVERNANCE_DECISION_REGISTER.md`), and `GET /org/access` is a pure
  read composed from already-authorized scope data — it grants nothing
  new.
- FR-BRN-003/004/005/006/007/008 remain exactly as classified before this
  session (PARTIAL/NOT IMPLEMENTED) — none touched, per the task's
  explicit DO-NOT list.
- No full E2E suite was run, per explicit instruction.

## 16. READY_FOR_FULL_E2E

**NO** — not run this session, by explicit instruction ("Do NOT run full
E2E"). The targeted regression battery in §11 is the complete evidence
this session provides; a full E2E run is recommended before any release
gate, as with every prior lane report in this series, but is out of this
task's scope.
