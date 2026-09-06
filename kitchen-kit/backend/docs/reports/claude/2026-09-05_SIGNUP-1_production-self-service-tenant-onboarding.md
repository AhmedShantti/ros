# SIGNUP-1 — Production Self-Service Tenant Onboarding

**Report type:** Implementation + verification report
**Task identifier:** SIGNUP-1
**Date:** 2026-09-05
**HEAD (backend, start of task):** `1ab5fa41632119a34eb1c423ac26e35b86c61ad8`
**Branch (backend):** `full-srs/lane-d4-reporting-demo`
**Working tree at task start:** `docs/reports/claude/INDEX.md` modified (unrelated, pre-existing), one new untracked report (`2026-09-05_PROD-DEMO-SMOKE_...md`, unrelated, pre-existing) — both left untouched by this task except this report's own `INDEX.md` row.
**No commit made.** Nothing pushed.

**Authority statement.** This report is non-authoritative evidence. The SRS
(FR-PLT-020, FR-SEC-020, FR-SEC-025, FR-SEC-046, FR-SEC-047, FR-SEC-063) and
ratified governance decisions remain authoritative over any claim made here.
Every test result below was executed in this session against the current
working tree; no prior result is reported as new.

---

## 0. Mid-task scope lock (binding, applied)

Partway through this session the user issued a hard scope lock ("ship in
~2 hours") that changed the plan already in flight. Applied changes, and
what they mean for the rest of this report:

1. **Starter menu (F. in the original mission) is DEFERRED**, not built.
   No menu/category/item/variant/price-list creation happens at signup in
   this slice. A signed-up tenant has a working branch and no menu. This is
   the single largest deviation from the original mission brief — see
   `SRS_REQUIREMENTS_REMAINING` below.
2. **FR-SEC-063 (data residency)** — deferred exactly as originally
   instructed: no schema/migration work, no frontend field, reported as an
   explicit SRS remainder.
3. **Explicitly deferred, not attempted:** non-owner `roleKey` self-service
   (join-an-existing-tenant / approval-queue workflow), email verification,
   billing, an onboarding wizard, extra default roles beyond Owner, OpenAPI
   regeneration (not run — see §9), and any broad refactor.
4. **New release gate:** existing POS and KDS e2e coverage must stay green.
   No POS/KDS source file was touched. Verified — see §8.
5. Final verification order and final chat-reply format were both changed
   by the scope lock; both were followed as specified.

---

## 1. Scope decision (resolves a real conflict, made explicit)

The frontend's `/signup` page (`ros-front/kitchen-kit`) is a generic
17-role "account request" form. Its own pre-existing doc comments in
`lib/api/registration.ts` explicitly argued that self-granting `owner` via
a free-text field is unsafe, and that an admin-confirmed approval queue is
the "safer reading" for every other role. That is a materially different,
larger, unratified feature (staff self-registration into an *existing*
tenant) than SRS FR-PLT-020, which requires atomic **new**-tenant
self-service signup.

Per this repository's own reporting policy (SRS authoritative over any
report/comment), this implementation resolves the conflict as follows:

- Endpoint: `POST /auth/registrations` — the frontend's own previously
  documented intended path (its stub's doc comment named this exact route
  and request shape). No frontend URL/body-shape change was needed for the
  owner path.
- **This slice supports `roleKey === "owner"` only** (creates a new
  tenant). Any other `roleKey` returns `400 Bad Request` with a clear
  message naming the reason (no invitation/approval mechanism exists yet)
  rather than either silently succeeding or attempting an insecure
  "resolve `organisation`/`scopeName` against an existing tenant by name"
  behaviour — which would have been a genuine tenant-isolation risk with no
  invite token to gate it.

## 2. Endpoint implemented

`POST /auth/registrations`, public, rate-limited (see §5 for why a
*different* guard than the shared `AuthThrottlerGuard` was required),
returns `201 Created`.

### Request (`RegisterTenantDto`)

Matches the frontend's own already-documented `RegistrationRequest`
literally — no frontend request-shape change:

```
fullName      string, 1-80
email         valid email, <=255
phone?        optional, loose E.164-ish
roleKey       string, 1-64 — business rule: must equal "owner" in this slice
organisation  string, 1-120        → new Tenant.legalName
scopeName?    string, 1-120        → first branch name (default "Main")
employeeCode? string, <=32         → accepted for contract parity, unused
pin?          string, 4-8 digits   → accepted for contract parity, unused
password      string, 10-128       → FR-SEC-025 (signup-specific minimum)
```

`ValidationPipe({whitelist:true, forbidNonWhitelisted:true, transform:true})`
(already global in `main.ts`) rejects unknown/malformed fields (FR-SEC-047).

### Response (`201`)

```
{
  status: "created",
  email: string,
  auth: { tokenType: "Bearer", accessToken, refreshToken, expiresIn, user: SafeUser },
  tenant: { id, slug, legalName, status, defaultCurrency, defaultLocale },
  membership: { membershipId, status: "active" }
}
```

`auth` carries a **tenant-scoped** access token (`tid`/`mid`/`scp`/`pbr`/`epo`
already set) — the signup just created exactly one tenant, so the frontend
skips the ordinary login → `/auth/tenant` round-trip entirely (mission
Design §G, "prefer returning a tenant-scoped token directly").

## 3. Atomic transaction design

`PrismaService.withAuthContext` opens exactly one interactive Postgres
transaction and does **not** support nesting. Every existing service this
task would naturally reuse (`TenantsService.create`, `UsersService.
createUser`, `BranchesService.create`, `BrandsService.create`, `RolesService`,
`MembershipRolesService`) opens its **own** such transaction — so none of
them could be called from inside a shared one.

`RegistrationsService.register()` therefore:

1. Pre-checks the normalized email (`UsersRepository.findByEmail`) outside
   any transaction — fast, clean 409 on the common case, mirroring
   `UsersService.createUser`'s own pre-check.
2. Runs the idempotent, production-safe permission-catalog bootstrap
   (`PermissionsService.upsertMany(ALL_PERMISSION_DEFS)` — see §4) ahead of
   the transaction; the `permissions` table is global/non-RLS (ADR 0001),
   so this is safe outside `withAuthContext`.
3. Pre-generates every id (`newId()` — the repository's own existing
   convention: ids are always caller-supplied, never DB-generated), which
   is what lets `withAuthContext({userId, tenantId})` be opened before
   either row exists.
4. Opens **exactly one** `withAuthContext` transaction and, directly
   against the raw `tx` client, replicates (never calls) the exact write
   shape and audit calls of: `TenantsService.create` (tenant, minus its
   own out-of-transaction tax-class step — see below), `UsersService.
   createUser` + `CredentialsService.createPasswordCredential(tx, ...)`
   (reused directly — it already takes `tx`), `Membership` insert
   (mirrors `MembershipsRepository.create`), `Role` + `RolePermission`
   grants (mirrors `RolesService.createTenantRole`/`addPermissions`),
   `MembershipRole` + `authzEpoch` bump + audit (mirrors
   `MembershipRolesService.create` exactly), `Brand` + `Branch` +
   `org.locations` registration (mirrors `BranchesService.create` +
   `LocationsService.register`'s combined invariant — a branch can never
   exist without its location row), and a `Session` row with its
   `membershipId` already bound (unlike ordinary login, which binds it
   later via `/auth/tenant`).
5. Catches `P2002` (unique-violation race on email) inside the transaction
   and rethrows `ConflictException`, mirroring `UsersService.createUser`'s
   own second-layer catch.
6. After the transaction commits: best-effort tax-class provisioning
   (`TaxClassProvisioner.provisionForTenant`, try/catch, non-fatal) — this
   exactly mirrors `TenantsService.create`'s own existing non-atomic
   pattern for this one specific side-effect (a tenant must still be
   creatable when no signed country pack is activated).
7. Builds the authorization snapshot (`AuthorizationSnapshotService.build`)
   and mints the access token **after** the transaction (avoids a second
   nested `withAuthContext` call) and emits a best-effort `TENANT_SELECTED`
   audit event, mirroring `TenantSelectionService.select`'s own pattern.

A new audit action `TENANT_CREATED` was added to `AUDIT_ACTION`
(`audit.constants.ts`) and is recorded **inside** the transaction (mandatory
`AuditService.record(tx, ...)` path) — so a rollback also rolls back the
audit entry, and a committed signup is always accompanied by exactly one
`TENANT_CREATED` entry.

## 4. Permission bootstrap (production-safe, no `seed-dev-data.ts` dependency)

`seed-dev-data.ts` is a manually-run dev/demo script, never invoked by any
HTTP route, and the repository's own permission bootstrap
(`PermissionsService.ensureIdentityPermissions()`) only ever covered the
6 RBAC-admin codes — every *business* module's permission catalog
(`SALES_PERMISSION_DEFS`, `CATALOGUE_PERMISSION_DEFS`, …, 11 modules total)
was previously aggregated **only** inside that dev script.

This task extracts that aggregation into a new, production shared module:
`src/modules/identity/authz/permission-catalog.ts` (`ALL_PERMISSION_DEFS`,
`ALL_PERMISSION_CODES`), imported by `RegistrationsService` and called via
`PermissionsService.upsertMany(...)` — the same idempotent upsert
`PermissionsService` already exposed. `seed-dev-data.ts` itself is
untouched (still imports each module's defs directly) — there is exactly
one authored list of definitions per module either way; nothing was
duplicated.

**Architecture-boundary consequence (handled correctly, verified):**
`identity/authz/permission-catalog.ts` needs every module's permission defs,
which live in each module's own root (e.g. `sales/sales.permissions.ts`),
not a private subdirectory reachable only via that module's public
`contract/` barrel. Per SRS §5.2.3/§5.4 and the existing, mechanically
enforced `module-boundaries.spec.ts`, a NEW private cross-module import
would have required 9+ new `KNOWN_DEVIATIONS` entries. Instead — mirroring
the exact, already-accepted precedent in this codebase (Kitchen's own thin
`export { KDS_PERMISSIONS } from '../kitchen.permissions'` re-export through
`kitchen/contract`) — this task added one thin re-export line to each of:
`sales/contract`, `catalogue/contract`, `inventory/contract`,
`organisation/contract`, `production/contract`, `treasury/contract`,
`workforce/contract`, `governance/contract`, and `kitchen/contract`
(extended its existing line to also re-export `KDS_PERMISSION_DEFS`), plus
a brand-new `reporting/contract/index.ts` (Reporting's first published
contract). **Zero new `KNOWN_DEVIATIONS` entries were added.**
`module-boundaries.spec.ts` — all 46 assertions — passes unchanged (see §7).

## 5. Security-relevant finding and fix: throttling guard choice

The mission specified reusing the existing `AuthThrottlerGuard`
(IP+email-keyed) "like every other sensitive auth endpoint." Testing this
directly (see §7) surfaced a real defect in that plan: `AuthThrottlerGuard.
getTracker()` keys by `` `${ip}:${email}` `` whenever the request body has
an email. For **login**, that is exactly right (the same account being
hammered from one IP). For **signup**, the email is attacker-chosen and
different on every request by construction — so IP+email keying would let
an attacker completely sidestep the rate limit simply by varying the email
field on every call, defeating FR-SEC-046 for the one endpoint that most
needs IP-based protection (unauthenticated, resource-creating).

**Fix:** `RegistrationsController` uses the plain `ThrottlerGuard` (from
`@nestjs/throttler`) directly instead of `AuthThrottlerGuard` — pure
IP-keyed limiting, using the same already-registered `AUTH_THROTTLE_TTL`/
`AUTH_THROTTLE_LIMIT` config. Verified with a real request-volume test
(§7) — confirmed 429 once the configured limit is exceeded.

## 6. Data residency, country pack, currency, timezone (documented deviations)

- **FR-SEC-063 (data residency/region selection at signup):** the backend
  schema has **no** residency/region column anywhere on `Tenant` (confirmed
  by a full model read), and the frontend collects no such field either.
  Per the mission's own explicit instruction for this exact situation: no
  migration was added, no frontend field was added. **FR-SEC-063 is NOT
  satisfied by this slice** — reported honestly as an SRS remainder, not
  papered over.
- **Country pack / currency / timezone:** `TenantsService`'s
  `countryPackCode`/`defaultCurrency` and `BranchesService`'s
  `timezone`/`baseCurrency`/`countryCode` are all `NOT NULL` columns the
  frontend signup form never collects, and there is confirmed **no**
  existing default-region/currency/timezone governance mechanism in this
  repository (`src/config/env.validation.ts` has no such env var). Also
  confirmed: no country pack is actually **activated** in a normal running
  process today regardless (a pre-existing gap independently documented in
  `seed-dev-data.ts`'s own "Known limitation" section) — so a signed-up
  tenant's menu items would carry no tax class either way, unrelated to
  this slice.
  **Resolution:** one named, hardcoded platform-default constant set
  (`DEFAULT_SIGNUP_COUNTRY_PACK_CODE = 'EG'`, `DEFAULT_SIGNUP_CURRENCY =
  'EGP'`, `DEFAULT_SIGNUP_TIMEZONE = 'Africa/Cairo'`), matching the one
  fixture convention already used throughout `seed-dev-data.ts` and the
  e2e suite. This is **not** a governed, per-tenant-configurable default —
  it is a single hardcoded value that should be revisited the moment this
  product needs multi-region/multi-country signup. Documented here, not
  overstated as "complete."

## 7. Backend files changed

**New:**
- `src/modules/identity/registrations/dto/register-tenant.dto.ts`
- `src/modules/identity/registrations/registrations.service.ts`
- `src/modules/identity/registrations/registrations.controller.ts`
- `src/modules/identity/authz/permission-catalog.ts`
- `src/modules/reporting/contract/index.ts`
- `test/registrations.e2e-spec.ts`

**Modified:**
- `src/modules/identity/identity.module.ts` (registers the new controller/service)
- `src/modules/governance/audit/audit.constants.ts` (`TENANT_CREATED` action)
- `src/modules/{sales,catalogue,inventory,organisation,production,treasury,workforce,governance,kitchen}/contract/index.ts`
  (thin permission-catalog re-export line each; `kitchen`'s existing line extended)
- `docs/reports/claude/INDEX.md` (this report's row)

**Not touched:** any POS or KDS source file (per the mid-task scope lock's
release gate). `seed-dev-data.ts` untouched. No Prisma schema/migration
change. No production database touched.

## 8. Test results (this session, this working tree)

All commands run with `env -u DATABASE_URL -u APP_DATABASE_URL
-u PARTITION_ADMIN_DATABASE_URL` (the shell had stale placeholder DB env
vars shadowing `.env` — cleared so the e2e DB-isolation harness could load
the real local Postgres config; this is an environment artifact of this
session, not a code change).

**1. Signup targeted suite — `test/registrations.e2e-spec.ts` — 7/7 passed:**
happy path (creates user+tenant+branch+owner role, returns usable
tenant-scoped token); password usable via normal `/auth/login` and never
stored plaintext (asserted `$argon2id$` prefix, never compared to
plaintext); non-owner `roleKey` → 400, zero rows created; duplicate email →
409, zero partial tenant; unknown/malformed-field validation → 400
(`forbidNonWhitelisted`); **mid-flow failure rollback proof** — forced a
throw from `AuditService.record` deep in the transaction (after
tenant+user+membership+role+permission-grants already ran) via
`jest.spyOn`, then asserted zero `user`/`tenant` rows exist for that
attempt; two independent signups produce two fully isolated tenants
(cross-tenant `GET /auth/tenants` isolation asserted); IP-based throttling
confirmed 429 once `AUTH_THROTTLE_LIMIT` (test env: 50) is exceeded.

Also verified directly in the happy-path test: `GET /org/branches` (one
branch, named "Main"), `GET /auth/permissions` (>20 codes, includes
`identity.role.assign`), `GET /org/access` (200) — all using the
signup-returned scoped token, no separate login/tenant-selection call.

**2. Targeted auth/org regression — `auth.e2e-spec.ts` + `tenant.e2e-spec.ts`
   — 21/21 passed**, unchanged.

**3. Targeted POS regression** (`sales-fire.e2e-spec.ts`,
`sales-payment.e2e-spec.ts`, `order-completion.e2e-spec.ts`,
`receipt.e2e-spec.ts`, `pos-financial-corrections.e2e-spec.ts`) —
**153/153 passed** (order create/open, add line, fire, payment/completion,
receipt, discount/comp/refund/post-fire-void all exercised). One flaked
500-vs-201 failure on the very first run of this exact command set was
NOT reproduced on an immediate rerun of the identical command (153/153
clean) — recorded honestly as a one-off flake, not attributed to this
change (no POS source file was touched).

**4. Targeted KDS regression** (`kds-operator-lifecycle.e2e-spec.ts`,
`kds-first-viewed.e2e-spec.ts`, `kds-amendment.e2e-spec.ts`,
`kds-authorization.e2e-spec.ts`, `kitchen-ticket-persistence.e2e-spec.ts`)
— **69/69 passed** (fired order reaches KDS, station queue read, start
line, bump line/bump-all, recall, amendment/first-viewed regression all
covered by these specs).

**5. Module-boundary architecture test** — `src/modules/module-boundaries.spec.ts`
— **46/46 passed**, `KNOWN_DEVIATIONS` unchanged (zero new entries — see §4).

**6. Identity unit suite** — `src/modules/identity/**/*.spec.ts` —
**98/98 passed** (15 suites), unchanged.

**7. `npm run typecheck`** — clean, both before and after every fix in
this session.

**8. `npm run build`** (`nest build`) — clean.

Full/heavy e2e suite was **deliberately not run** (thermal rule + scope
lock's explicit instruction) — only the targeted files above.

## 9. Frontend changes (ros-front/kitchen-kit)

- `lib/api/registration.ts` — replaced the `NOT_IMPLEMENTED` stub with a
  real call: `http.post<RegistrationOutcome>("/auth/registrations",
  {body, idempotent:true, anonymous:true})`. Extended `RegistrationOutcome`
  with optional `auth`/`tenant`/`membership` (kept `status`/`email` for
  backward-compatible UI copy). Added `persistRegistrationSession()`
  (writes tokens via the existing `lib/api/session.ts` `setTokens`, sets
  the tenant id, sets the default currency — the exact same three calls
  `lib/api/auth.ts`'s own `selectTenant()` already makes). Doc comment
  rewritten to describe what was actually built (owner-only), not the old
  "nothing exists yet" framing. `REGISTRATION_IS_WIRED` flipped to `true`.
- `app/(auth)/signup/page.tsx` — `onSubmit` now checks `result.auth`: when
  present, persists the session, calls `GET /auth/permissions` and the
  existing console session store's `signIn(roleFromPermissions(granted),
  false)`, then `router.replace(takeReturnTo() ?? "/dashboard")` — mirroring
  `login/page.tsx`'s own `enterConsole()` byte-for-byte in intent. When
  `auth` is absent (i.e. a future non-owner path), the existing
  `SubmittedCard`/`pending_approval` rendering is kept as the fallback —
  unchanged behaviour for that case. Top-of-file doc comment corrected to
  match. **No other frontend file touched** — the 17-role `RolePicker` UI
  is unchanged; a non-owner submission now correctly surfaces the
  backend's 400 through the form's existing generic API-error path (not
  special-cased — verified this required no new UI code, since
  `ServiceError` rendering already exists for every other endpoint).
- Both `npm run typecheck` and `npm run build` (`next build`) pass clean
  on the frontend, including static prerender of `/signup`.
- **OpenAPI regeneration was NOT run** (`npm run openapi:generate` in the
  backend, `npm run api:types` in the frontend) — deferred per the
  mid-task scope lock ("only if cheap/fast; otherwise note as
  deferred/follow-up"). `docs/api/openapi.json`/`.yaml` and the frontend's
  generated `lib/api/schema.ts` do **not** yet describe
  `POST /auth/registrations`. This is a real, tracked follow-up, not
  something this report treats as done.

## 10. Known deviations (full list)

1. **Starter menu deferred entirely** (mid-task scope lock) — a signed-up
   tenant has a tenant, owner user, Owner role with the full permission
   catalog, and one branch ("Main"), but **no menu, category, item,
   variant, or price list**. FR-PLT-020's "starter menu template" limb is
   **NOT** satisfied by this slice.
2. **FR-SEC-063 (data residency) NOT satisfied** — no schema/frontend
   support exists; not attempted per explicit instruction.
3. **Country pack / currency / timezone** hardcoded to a single platform
   default (`EG`/`EGP`/`Africa/Cairo`), not per-tenant configurable, not a
   governed default — see §6.
4. **FR-SEC-025 (password minimum ≥10) enforced only for signup**, not
   globally — the shared `PASSWORD_MIN_LENGTH` constant (still `8`,
   `credentials/password-policy.ts`) was deliberately left unchanged
   (broader change, out of scope; would affect password reset/admin user
   creation too).
5. **Non-owner `roleKey` self-service is explicitly unimplemented** (400) —
   an administrator-invitation/approval-queue flow for joining an existing
   tenant is a separate, larger, unratified feature. The frontend's 17-role
   `RolePicker` UI still offers all 17 roles; only `"owner"` succeeds.
6. **OpenAPI not regenerated** — see §9.
7. **Audit for `TENANT_SELECTED`-equivalent post-signup event** is
   best-effort (`AuditService.emit`, not the mandatory in-transaction
   `record`), exactly mirroring how ordinary tenant selection already
   works for login — not atomic with the signup transaction itself
   (the signup's own `TENANT_CREATED` entry IS atomic/in-transaction).

## 11. SRS requirement status

**Closed (this slice):**
- FR-PLT-020 — partially: first user + tenant + working branch + default
  role set (Owner, full permission catalog, tenant scope) created
  atomically in one flow. **Starter menu template limb NOT closed** (see
  Known Deviations #1).
- FR-SEC-020 — dashboard auth uses email + password (signup creates a
  password-authenticated user; unchanged auth mechanism).
- FR-SEC-025 — minimum password length ≥10, enforced at signup
  specifically (see Known Deviations #4 for the global-policy gap).
- FR-SEC-046 — auth endpoints rate limited (fixed a real gap in the
  originally-planned approach — see §5).
- FR-SEC-047 — strict request validation, unknown fields rejected.

**Remaining (explicit SRS remainder, not attempted or only partially attempted):**
- FR-PLT-020's starter-menu limb (deferred).
- FR-SEC-063 — data residency region selection at signup (not satisfied at all).
- Non-owner self-service signup / administrator-invitation flow (unratified, out of scope).
- Global password-policy minimum still 8, not 10 (FR-SEC-025 only fully closed for the signup path).

## 12. Safe to deploy

**Conditionally yes**, for exactly the scope delivered: a new tenant owner
can sign up, land in the dashboard immediately with full tenant-scoped
Owner permissions, and operate on one branch — but with **no starter menu**
(cannot yet reach POS setup with sellable items) and **no data-residency
support**. Recommend a follow-up slice for starter-menu provisioning before
this is presented as feature-complete self-service onboarding externally.

Verified in this session: signup e2e (7/7), auth/tenant e2e (21/21), POS
targeted e2e (153/153), KDS targeted e2e (69/69), module-boundaries (46/46),
identity unit (98/98), typecheck (backend + frontend, both clean), build
(backend `nest build` + frontend `next build`, both clean). No commit, no
push, no migration, no production DB access.
