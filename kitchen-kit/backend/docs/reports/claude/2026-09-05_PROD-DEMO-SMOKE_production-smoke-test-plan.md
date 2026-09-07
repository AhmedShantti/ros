# PROD-DEMO-SMOKE — Production Demo Smoke-Test Plan (Read-Only Census)

**Report type:** Read-only audit / smoke-test-plan derivation (no implementation, no migration, no seeding, no DB connection, no push, no commit performed by this task)
**Authority statement:** This report is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. Where this report disagrees with the SRS or a ratified governance decision, the SRS and the register win. This report records what was observed in repository source this session — it ratifies nothing and authorises nothing.
**Date:** 2026-09-05
**HEAD:** `1ab5fa41632119a34eb1c423ac26e35b86c61ad8` (matches the expected accepted head given in the task brief; confirmed via `git log -1`)
**Branch:** `full-srs/lane-d4-reporting-demo` (confirmed via `git branch --show-current`; local branch is 20 commits behind `origin/full-srs/lane-d4-reporting-demo` — not fast-forwarded by this task, per the read-only/no-push instruction)
**Working tree summary:** clean at session start (`git status` → "nothing to commit, working tree clean"); no files modified, no migration run, no seed run, no database connection made, nothing committed or pushed by this task.
**Task identifier:** PRODUCTION-DEMO-SMOKE-CENSUS

Everything below is derived exclusively from repository source (controllers, DTOs, `src/scripts/seed-dev-data.ts`, `package.json`, `docs/api/openapi.json`, and prior accepted reports in this repo). No credential, route, or ID was invented. Where the repository does not literally contain a fact, it is stated as `MISSING_INFORMATION`, not guessed.

---

## 1. Health endpoint

`src/health/health.controller.ts`
```
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; service: string } {
    return { status: 'ok', service: 'ros-identity' };
  }
}
```
- **Route:** `GET /health` — no global prefix, no API version prefix (confirmed: no `app.setGlobalPrefix()` anywhere in `src`; `applyApiVersioning` uses `VERSION_NEUTRAL` and only `SyncController` opts into `/v1`).
- **Auth:** none — no guard on the controller.
- **Expected success response:** `200 { "status": "ok", "service": "ros-identity" }`. Confirmed present as `/health` → `get` in `docs/api/openapi.json`, response schema properties `status`/`service` (both string).

## 2. Auth login contract

`src/modules/identity/auth/auth.controller.ts`, `login.dto.ts`, `pin-login.dto.ts`, `tenant.controller.ts`, `select-tenant.dto.ts`. Cross-checked against `docs/api/openapi.json`.

- **`POST /auth/login`** — guarded only by `AuthThrottlerGuard` (public, rate-limited).
  - Request body (`login.dto.ts`, both required): `{ "email": string (valid email), "password": string (1-256 chars) }`.
  - Response (`200`, `authTokensSchema`): `{ "tokenType": "Bearer", "accessToken": string, "refreshToken": string, "expiresIn": integer, "user": {...} }`.
  - **Access token field is `accessToken`** (camelCase) — not `access_token`/`token`.
  - This token is **unscoped** (no tenant selected yet).

- **`POST /auth/tenant`** — guard: `JwtAuthGuard` (`Authorization: Bearer <unscoped accessToken>` required).
  - Request body (`select-tenant.dto.ts`, required): `{ "tenantId": string (UUID) }`.
  - Response (`200`): `{ "accessToken": string, "tokenType": "Bearer", "expiresIn": integer, "tenant": {...}, "membership": {...} }`.
  - This second `accessToken` is the **tenant-scoped** token every subsequent authenticated call in this plan uses.

- **`GET /auth/tenant`** (guard: `JwtAuthGuard`) — returns the caller's currently-selected tenant context: `{ "tenantId": string|null, "membershipId": string|null }`.

- **`GET /auth/tenants`** (guard: `JwtAuthGuard`, `tenant.controller.ts:59`) — lists tenants the *already-authenticated* caller belongs to. Requires a prior successful login; **not** a pre-auth discovery route.

- **`POST /auth/pin`** — POS PIN login, guarded only by `AuthThrottlerGuard` (public, rate-limited).
  - Request body (`pin-login.dto.ts`, all required): `{ "tenantId": string (UUID), "terminalId": string (UUID), "employeeCode": string (1-32 chars), "pin": string (4-8 digits) }`.
  - Response: same `authTokensSchema` shape as `/auth/login` — already tenant-scoped (no follow-up `/auth/tenant` call needed for PIN login).

## 3. Demo actors created by `seed-dev-data.ts`

`src/scripts/seed-dev-data.ts` — read in full (584 lines). Critical fact up front: **every actor's email is timestamp-suffixed at run time** (`` `owner.a.${stamp}@example.com` ``, `stamp = Date.now()` at ln 121/147 etc.) — there is **no fixed, literal email address** in the repository for any demo actor. Only the **password** and **PIN** literals are fixed. This means the exact emails needed for the smoke test **cannot be derived from source alone**; they are only known from a specific run's console output / `credentials.md` (which the script itself says must never be committed, and none exists in this working tree — confirmed absent).

| Actor | Scope | Auth method | Login identity (pattern, not literal) | Secret (literal, from source) |
|---|---|---|---|---|
| Tenant A Owner (owner/admin) | TENANT scope, all of Tenant A | `POST /auth/login` → `POST /auth/tenant` | `` owner.a.${stamp}@example.com `` | `DevPass123!` (`DEV_PASSWORD`, ln 97) |
| Downtown Manager (branch manager) | BRANCH scope — Downtown only | `POST /auth/login` → `POST /auth/tenant` | `` manager.downtown.${stamp}@example.com `` | `DevPass123!` |
| Multi-Branch Manager | BRANCH scope — Downtown + Airport (two independent scoped assignments on one role) | `POST /auth/login` → `POST /auth/tenant` | `` manager.multibranch.${stamp}@example.com `` | `DevPass123!` |
| Downtown Cashier (POS employee, password path) | TENANT-scope Cashier role membership | `POST /auth/login` → `POST /auth/tenant` | `` cashier.downtown.${stamp}@example.com `` | `DevPass123!` |
| Downtown Cashier (POS employee, PIN path) | home branch = Downtown (`Employee.homeBranchId`) | `POST /auth/pin` | employee code `EMP001` (literal, ln 316) | PIN `1234` (`DEV_PIN`, ln 98) |
| Tenant B Owner (second tenant, isolation proof) | TENANT scope, all of Tenant B | `POST /auth/login` → `POST /auth/tenant` | `` owner.b.${stamp}@example.com `` | `DevPass123!` |
| Terminal — POS-Downtown | registered on Downtown branch | n/a (used as `terminalId` in `/auth/pin` body) | name `POS-Downtown` (ln 304) | id is a runtime UUID, not literal |
| Terminal — POS-Airport | registered on Airport branch | n/a | name `POS-Airport` (ln 308) | id is a runtime UUID |
| Terminal — POS-Main | registered on Tenant B's Main branch | n/a | name `POS-Main` (ln 417) | id is a runtime UUID |

Branch codes (literal, ln 271/280/411): Downtown = `DOWNTOWN`, Airport = `AIRPORT`, Main (Tenant B) = `MAIN`.

## 4. `seed-dev-data.ts` idempotency/safety

**Conclusion: safe to re-run (non-destructive), but NOT idempotent — every run creates a brand-new, additional demo tenant rather than reusing or updating an existing one.**

Exact evidence:
- Its own doc-comment (ln 88-90): *"Safe to re-run: every tenant/user is timestamp-suffixed, so each run creates fresh, independent tenants rather than colliding with a previous run."*
- `const stamp = Date.now();` (ln 121) is used to suffix every seeded email and every tenant slug (`` `demo-restaurant-group-${stamp}` ``, ln 140; `` `second-demo-tenant-${stamp}` ``, ln 366) — there is no lookup/`findOrCreate` against an existing tenant/user anywhere in the script; every call is a plain `.create(...)`.
- No deletion, update, or truncation of any existing row occurs anywhere in the script — nothing it does can destroy prior data.
- Consequence: running it N times against the same database produces N independent demo tenants (Tenant A / Tenant B pairs), each with its own distinct actor emails. It never collides with or overwrites a prior run, but it also never converges — running it twice is not equivalent to running it once, and repeated runs accumulate straggler tenants. This is also independently confirmed by the prior accepted report `docs/reports/claude/2026-08-26_RENDER_country-pack-order-create-unblock.md` §I: *"seed-dev-data.ts creates a brand-new, timestamp-suffixed tenant on every run ... there is no 'existing demo tenant' that predates the pack."*

## 5. Package.json seed command

**No dedicated `npm run seed*`/`demo*` script exists.** Full `scripts` block in `package.json` was read; no entry matches `seed` or `demo`. The script's own header comment (`seed-dev-data.ts` ln 66-70) states the only invocation method:
```
nest build && node dist/scripts/seed-dev-data.js
```
It is explicitly labeled "NOT wired to any HTTP route, run manually."

## 6. Verifying demo data exists WITHOUT seeding

**No pre-authentication discovery route exists in this repository.** Confirmed by reading every route on `tenants.controller.ts`'s sibling `tenant.controller.ts` (only routes: `GET /auth/tenants`, `POST /auth/tenant`, `GET /auth/tenant`, all gated by `JwtAuthGuard`) and by the `TenantContextGuard`/`PermissionGuard` chain on every business route (`org/*`, `reports/*`) requiring a valid, already-tenant-scoped JWT. There is no public "list tenants" or "does a demo tenant exist" endpoint.

Practical, read-only ways to check, in order of preference:
1. **`GET /health`** — confirms the process is up and DB-reachable enough to serve requests, but proves nothing about demo data.
2. **Attempt `POST /auth/login`** with a previously-captured demo email (from an earlier run's `credentials.md`, kept locally and never committed) — HTTP `200` with an `accessToken` proves that specific actor exists; `401` proves either wrong credentials or no such user, and cannot by itself distinguish "never seeded" from "seeded under a different timestamp."
3. There is no code-level way to enumerate `` owner.a.*@example.com `` without already knowing an exact past `stamp` value, because the seed script never writes that value anywhere queryable pre-auth.

**Consequence:** if no `credentials.md` (or equivalent out-of-band record) from a prior Render seed run survives, this repository provides **no read-only way to confirm whether demo data already exists** on the target production database. This is reported as `MISSING_INFORMATION`, not assumed either way.

## 7. Exact curl commands, in order

All commands assume `BASE=https://ros-zchd.onrender.com` and require a real, previously-known demo owner email (see §3/§6 — this session has none). Placeholders are shown literally as `<...>`; do not substitute an invented value.

```bash
BASE="https://ros-zchd.onrender.com"

# A. Health check — no auth, safe to run standalone.
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/health"
curl -s "$BASE/health"
# expect: 200 {"status":"ok","service":"ros-identity"}

# B. Login as demo owner (requires a real, known email — see §6).
LOGIN_JSON=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"<demo-owner-email>","password":"DevPass123!"}')
echo "$LOGIN_JSON"
ACCESS_TOKEN=$(echo "$LOGIN_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')

# B2. Select the tenant (its tenantId comes from LOGIN_JSON's "user" object,
#     or from a prior credentials.md record — never invented).
TENANT_ID="<tenantId>"
TENANT_JSON=$(curl -s -X POST "$BASE/auth/tenant" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\":\"$TENANT_ID\"}")
echo "$TENANT_JSON"
SCOPED_TOKEN=$(echo "$TENANT_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')

# C. Accessible tenant/branch scope.
curl -s "$BASE/org/access" -H "Authorization: Bearer $SCOPED_TOKEN"
# expect: 200 { "tenantId": "...", "brands": [...], "branches": [...] }

# D. Low-risk authenticated read proving the selected branch works.
curl -s "$BASE/org/branches" -H "Authorization: Bearer $SCOPED_TOKEN"
# expect: 200, array including the Downtown/Airport (or Main) branch rows
#         returned by step C — pick a branchId from THAT response, not guessed.

# E. Reporting overview for a branch obtained from step C/D.
BRANCH_ID="<branchId from step C or D>"
BUSINESS_DAY="<YYYY-MM-DD, e.g. today in the branch's own business-day terms>"
curl -s "$BASE/reports/branches/$BRANCH_ID/overview?businessDay=$BUSINESS_DAY" \
  -H "Authorization: Bearer $SCOPED_TOKEN"
# requires REPORTING_PERMISSIONS.VIEW_SALES AND VIEW_FINANCIAL on that branch
# (the seeded Owner and Branch Manager roles both carry these — cashier does not).
```

PIN-login alternative for step B/B2 (already tenant-scoped, no `/auth/tenant` call needed) — only if a terminal/employee/PIN triple is actually known:
```bash
curl -s -X POST "$BASE/auth/pin" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"<tenantId>","terminalId":"<terminalId>","employeeCode":"EMP001","pin":"1234"}'
```

## 8. Token capture and required headers, per authenticated call

- Every authenticated call captures the token from the prior response's `accessToken` field into a shell variable via `python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])'` (or `jq -r .accessToken`) — never a hard-coded/fabricated token.
- **Required header on every authenticated call:** `Authorization: Bearer <token>` only.
- **No tenant/branch HTTP header is used anywhere in this codebase.** Confirmed directly: `tenant-context.service.ts` resolves tenant/branch context exclusively from the validated JWT's claims (`principal.tenantId`/`principal.membershipId`) plus live DB re-resolution — never from a request header. A repo-wide `grep -rn "headers\["` under `src/modules/identity` found only `user-agent` reads (for audit logging), nothing tenant/branch-related. `GET /org/access` and `GET /org/branches` both rely solely on the `TenantContextGuard` reading the already-selected tenant out of the token — no `X-Tenant-Id`/`X-Branch-Id` header exists in this system.

## 9. Bootstrap/seed step beyond `prisma migrate deploy`

**Yes — a bootstrap step beyond `prisma migrate deploy` is required, and it is not automatic.**
- No migration inserts any row into the permissions table (`grep -rl "INSERT INTO.*permission"` across `prisma/migrations/*.sql` → no matches); the permission catalog (`IDENTITY_PERMISSION_DEFS`, `REPORTING_PERMISSION_DEFS`, etc.) is populated only by `PermissionsService.upsertMany`, and the only caller of that method in the whole repository (outside its own unit spec) is `seed-dev-data.ts` (ln 124-136).
- No `onModuleInit`/`onApplicationBootstrap` hook anywhere in `src/app.module.ts` or elsewhere seeds permissions, roles, tenants, or users automatically at process start (confirmed by reading `main.ts` bootstrap end-to-end and grepping for those lifecycle hooks).
- `start:prod` (`package.json`) is `node dist/main` — a plain process start with no chained migrate/seed step.
- **Consequence:** immediately after `prisma migrate deploy` alone, the production database has schema but zero tenants/users/permissions/roles. `POST /auth/login` would `401` for every credential (no user rows exist at all) until `seed-dev-data.ts` (or an equivalent real signup flow) is run at least once.

---

## RETURN

```
STATUS: Read-only census complete. No file modified, no migration run, no seed run, no DB connection made, nothing committed/pushed.

HEAD: 1ab5fa41632119a34eb1c423ac26e35b86c61ad8 (matches expected accepted head)

HEALTH:
  GET /health, no auth, no prefix.
  200 { "status": "ok", "service": "ros-identity" }
  (src/health/health.controller.ts)

LOGIN_CONTRACT:
  POST /auth/login  body: { "email": string, "password": string }
    -> 200 { "tokenType":"Bearer", "accessToken", "refreshToken", "expiresIn", "user":{...} }  (UNSCOPED token)
  POST /auth/tenant  (Authorization: Bearer <unscoped accessToken>)  body: { "tenantId": string(UUID) }
    -> 200 { "accessToken", "tokenType", "expiresIn", "tenant":{...}, "membership":{...} }  (SCOPED token — use for all further calls)
  POST /auth/pin  body: { "tenantId","terminalId","employeeCode","pin" } -> same authTokensSchema, already scoped.
  Access token field name is "accessToken" everywhere (never access_token/token).

DEMO_ACTORS:
  Tenant A "Demo Restaurant Group": Owner (TENANT scope), Downtown Manager (BRANCH:Downtown),
    Multi-Branch Manager (BRANCH:Downtown+Airport), Downtown Cashier (password + PIN paths),
    branches DOWNTOWN/AIRPORT, terminals POS-Downtown/POS-Airport, employee EMP001.
  Tenant B "Second Demo Tenant": Owner (TENANT scope), branch MAIN, terminal POS-Main.
  All created by src/scripts/seed-dev-data.ts.

DEMO_CREDENTIALS_FOUND:
  Password (literal): DevPass123!  |  PIN (literal): 1234  |  employee code (literal): EMP001
  Emails: NOT literal/fixed — every run timestamp-suffixes them (e.g. owner.a.<Date.now()>@example.com).
  No fixed demo email exists anywhere in the repository. Not invented; not guessed.

SEED_COMMAND:
  None in package.json. Manual only: `nest build && node dist/scripts/seed-dev-data.js`
  (script's own header comment: "NOT wired to any HTTP route, run manually").

SEED_SAFETY:
  Safe / non-destructive to re-run (never updates, deletes, or collides with existing rows —
  every tenant/user email is Date.now()-suffixed, script's own comment confirms this).
  NOT idempotent: each run adds a brand-new, independent demo tenant pair rather than reusing one.
  Repeated runs accumulate straggler demo tenants; none is ever overwritten or removed.

HOW_TO_VERIFY_DATA_EXISTS:
  No pre-auth discovery route exists anywhere in this codebase (GET /auth/tenants requires an
  already-valid JWT). GET /health only proves liveness. The only way to confirm demo data exists
  without seeding is to attempt POST /auth/login with an email captured from a prior seed run's
  (uncommitted) credentials.md. If no such record survives, existence cannot be determined
  read-only from this repository alone — see MISSING_INFORMATION.

REQUIRED_AUTH_HEADERS:
  Authorization: Bearer <accessToken> only, on every authenticated call.
  No X-Tenant-Id / X-Branch-Id or any other tenant/branch header exists in this codebase —
  tenant/branch context is resolved exclusively from JWT claims (tenant-context.service.ts).

SMOKE_COMMANDS: see report §7 (full ordered curl sequence: A health -> B login -> B2 select tenant
  -> C GET /org/access -> D GET /org/branches -> E GET /reports/branches/:branchId/overview).
  Token capture pattern and no-hardcoded-token rule: see report §8.

MISSING_INFORMATION:
  1. No literal demo actor email exists anywhere in the repository (by design — timestamp-suffixed
     at seed time). A real email/tenantId/branchId pair must come from an out-of-band record
     (a prior run's credentials.md or Render logs), which this read-only repository census cannot
     supply and must not invent.
  2. Whether the target production database (https://ros-zchd.onrender.com) already has a
     seeded demo tenant is unknown — this session has no DB access and no discovery route exists
     to check it via the public API alone.
  3. No render.yaml/Procfile/deploy manifest was found in this repository; the exact Render
     service root directory and environment variables (DATABASE_URL, COUNTRY_PACK_DIR,
     COUNTRY_PACK_TRUST_MANIFEST, etc.) are only inferable from the prior accepted report
     docs/reports/claude/2026-08-26_RENDER_country-pack-order-create-unblock.md, not confirmed
     live this session.
  4. Whether `POST /orders` (not part of this smoke plan) would work is irrelevant to this plan's
     scope (auth + reads only) but the prior RENDER report documents a known country-pack
     activation gap if it is ever exercised.

SAFE_TO_SEED_PRODUCTION_DEMO_DB: CONDITIONAL
  Running seed-dev-data.ts against production will not corrupt or delete any existing data
  (confirmed non-destructive, §4/§9). It IS required at least once for any login to succeed at all
  (no bootstrap seeds permissions/users otherwise, §9). The condition: running it more than once
  accumulates additional, never-cleaned-up demo tenants — acceptable for a one-off Sunday demo,
  but the operator should decide deliberately whether a NEW seed run is wanted (fresh tenant/IDs)
  or whether existing demo credentials from a prior run should be reused instead. This report takes
  no action either way per its READ ONLY mandate.

NEXT_ACTION:
  Human decision required (outside this read-only task's mandate): (a) locate/confirm whether a
  prior credentials.md/seed run already exists for https://ros-zchd.onrender.com; if yes, reuse
  those exact email/tenantId/branchId values in report §7's command sequence; if no, run
  `node dist/scripts/seed-dev-data.js` against production once, capture its console output
  (owner/tenant IDs + credentials.md), and then execute report §7 verbatim with those real values.
```
