# Phase 13 — Full Integration, Security & Quality Review

> Reporting convention: **FACT** = directly verified in the repository / live DB / test run.
> **INFERENCE** = reasonable conclusion from the implementation. **KNOWN LIMITATION** = accepted
> from a prior phase. **RECOMMENDATION** = future improvement (not an existing requirement).
> This phase made **no changes to working code**; the only additions are documentation
> (this file + `docs/auth/`). All findings are **NON-BLOCKER**.

## 1. Executive Summary

The ROS identity/authentication/authorization subsystem (Phases 1–12) is **internally
consistent, integrated, buildable, testable, migration-safe, tenant-safe, RLS-safe, and
authorization-safe**. The full verification gate passes cleanly: Prisma format/validate/
generate/migrate-status OK with **no drift**, **70/70 unit tests**, **90/90 e2e tests**,
**build OK**, **lint OK** (no `--fix`).

Six independent read-only code reviews (JWT/refresh, password, tenancy/RBAC, RLS/Prisma,
terminal/rate-limit, static-secret/DTO/error) found **0 CRITICAL and 0 HIGH** issues. The
core security properties hold and are backed by tests: server-side-only tenant/permission
resolution, membership-as-authorization-boundary (no `users.tenant_id`), transaction-local
fail-closed RLS on a non-superuser runtime role, opaque hash-only refresh tokens with
rotation + reuse-detection + chain revocation, Argon2id password hashing, enumeration-safe
login/forgot flows, hash-only device fingerprints, and an append-only tamper-evident audit
trail.

Findings are limited to **MEDIUM/LOW/INFO hardening items and accepted limitations** —
principally: production must tighten the (intentionally lenient) rate-limit defaults; JWT
could pin its algorithm allowlist and add issuer/audience; the terminal status field has no
transition state-machine; and the Phase 12 audit trail is tamper-*evident* but not
compliance-grade (no production verifier; owner/superuser can rewrite). None block using
this subsystem as the foundation for the remaining ROS domains.

**Verdict: PASS WITH CONDITIONS** (conditions are production-configuration and future
hardening, not code defects — see §30).

## 2. Scope

Verification, integration, documentation, and hardening review of Phases 1–12. No new
business domains, no architectural redesign, no Phase 14 work. The current repository is
treated as the source of truth for *implementation*; the SRS / approved DB design (`../ROS_
DrawDB_Compatible_v3.sql`) / ADRs are the source of truth for *requirements*.

## 3. Repository State

- **Branch:** `main`. **Working tree:** clean at review start (`git status --short` empty).
- **HEAD:** `bf1622b`. `origin/main` at `823905a` (local ahead; nothing pushed — expected).
- **Backend:** NestJS 11, Prisma 7.9.1 (`prisma-client` generator → `src/generated/prisma`,
  gitignored), PostgreSQL 16 (Docker, host port 5544), roles `ros_migrator` (owner/superuser)
  and `ros_app` (NOSUPERUSER, NOBYPASSRLS). **FACT** (`package.json`, `prisma.config.ts`,
  live `pg_roles`).
- **Migrations:** 8, all applied, schema up to date (§17, §18). **FACT.**
- `.env` and `src/generated` are gitignored; `.env.example` contains only `CHANGE_ME`
  placeholders (no real secrets). **FACT** (`.gitignore`, `.env.example`).

## 4. Phase 1–12 Implementation Inventory

All expected phase commits are present and match the hashes provided in the brief. **FACT**
(`git log --oneline --decorate -22`).

| Phase | Commit | Status | Main Responsibility |
|------|--------|--------|---------------------|
| 0–1 | `202a773`,`29c4490`,`c6e9ce8` | ✅ | NestJS init; consolidate backend + Prisma 7 tooling; Docker Postgres w/ app+migration roles |
| 2 | `58cb0d4` | ✅ | Users + credentials (Argon2id) |
| 3 | `d99a9a1` | ✅ | Password login, access JWT, JwtAuthGuard, `/auth/me` |
| 4 | `f8d5159` | ✅ | Refresh rotation, reuse detection, logout |
| 5 | `39bae3e` | ✅ | Tenants, memberships, tenant selection |
| 6 | `c66659e` | ✅ | RBAC — roles, permissions, PermissionGuard |
| 7 | `74c9b4c` | ✅ | Single authoritative TenantContext |
| 8 | `c256a69` | ✅ | PostgreSQL Row-Level Security (tenant isolation) |
| 9 | `2a24860` | ✅ | Terminal / device identity (tenant-isolated RLS) |
| 10 | `d86361e` | ✅ | Password change + forgot/reset lifecycle |
| 11 | `2998f96` | ✅ | Rate limiting for auth endpoints + security headers |
| 12 | `bf1622b` | ✅ | Tamper-evident security audit trail |

ADRs present and consistent: `0001`–`0007` under `docs/adr/` (identity/tenancy/sessions,
tenant-context, RLS, terminal-identity, password-lifecycle, rate-limiting, audit-trail).
**FACT.** No ADR was silently changed.

## 5. Authentication Endpoint Inventory

Routes from `grep @Controller/@Post/@Get/@Delete` + guard decorators. **FACT** (file:line).
"Auth" = requires valid access JWT (`JwtAuthGuard`); "Tenant ctx" = requires selected-tenant
JWT + `TenantContextGuard`; "Perm" = `PermissionGuard` + `@RequirePermission`.

| Method / Path | Auth | Tenant ctx | Permission | Request DTO | Response | 401 | 403 | 404 | 409 | 429 | Sensitive behavior |
|---|---|---|---|---|---|---|---|---|---|---|---|
| POST `/auth/login` | – | – | – | `LoginDto{email,password}` | tokens + SafeUser | wrong pw / unknown email (generic) | – | – | – | ✅ | enumeration-safe; always runs Argon2 verify |
| POST `/auth/refresh` | – | – | – | `RefreshDto{refreshToken}` | tokens + SafeUser | expired/revoked/reuse/unknown | – | – | – | ✅ | rotation + reuse-detection + chain revoke |
| POST `/auth/logout` | ✅ | – | – | – | 204 | no token | – | – | – | – | revokes session (refresh) |
| GET `/auth/me` | ✅ | – | – | – | SafeUser + `mustReset` | no/invalid token | – | – | – | – | credential hash never fetched |
| GET `/auth/tenants` | ✅ | – | – | – | active memberships+tenant summaries | no token | – | – | – | – | lists only own active memberships |
| POST `/auth/tenant` | ✅ | – | – | `SelectTenantDto{tenantId}` | accessToken + summary | no token | no active membership (generic) | – | – | – | choose-among-own-memberships; re-validated |
| GET `/auth/tenant` | ✅ | – | – | – | `{tenantId,membershipId}` from ctx | no token | – | – | – | – | reflects trusted ctx only |
| POST `/auth/terminals` | ✅ | ✅ | `TERMINAL_MANAGE` | `RegisterTerminalDto` | `TerminalSummary` | no token | no ctx / no perm | – | dup (tenant,branch,name) | – | tenantId from ctx, not body |
| GET `/auth/terminals` | ✅ | ✅ | `TERMINAL_READ` | – | `TerminalSummary[]` | no token | no ctx / no perm | – | – | – | RLS-scoped list |
| POST `/auth/terminals/:id/status` | ✅ | ✅ | `TERMINAL_MANAGE` | `SetTerminalStatusDto{status}` | `TerminalSummary` | no token | no ctx / no perm | cross-tenant id | – | – | no transition state-machine (§14 finding) |
| POST `/auth/terminals/:id/fingerprints` | ✅ | ✅ | `TERMINAL_MANAGE` | `AddFingerprintDto` | 204 | no token | no ctx / no perm | cross-tenant id | – | – | stores SHA-256 hash only; idempotent |
| POST `/auth/terminal` | ✅ | ✅ | – (bind own session) | `BindTerminalDto{terminalId}` | accessToken (adds `trm`) | no token | inactive terminal | cross-tenant/unknown | – | – | terminalId validated in-tenant + active |
| GET `/auth/terminal` | ✅ | ✅ | – | – | `{terminalId}` from ctx | no token | no ctx | – | – | – | reflects trusted `trm` |
| GET `/auth/permissions` | ✅ | ✅ | (any) | – | permission code strings | no token | no ctx | – | – | – | server-resolved codes |
| GET `/auth/roles` | ✅ | ✅ | `ROLE_READ` | – | roles | no token | no perm | – | – | – | tenant + system roles |
| POST `/auth/roles` | ✅ | ✅ | `ROLE_CREATE` | `CreateRoleDto` | role | no token | no perm | – | dup name | – | `isSystem` forced false |
| POST `/auth/roles/:id/permissions` | ✅ | ✅ | `ROLE_UPDATE` | `AddPermissionsDto` | 204 | no token | no perm / system role | role not in tenant | – | – | codes validated vs catalog |
| POST `/auth/memberships/:id/roles` | ✅ | ✅ | `ROLE_ASSIGN` | `AssignRoleDto{roleId}` | 204 | no token | no perm / system role | foreign membership/role | – | – | tenant-scoped; audited |
| DELETE `/auth/memberships/:id/roles/:roleId` | ✅ | ✅ | `ROLE_ASSIGN` | – | 204 | no token | no perm / system role | not found | – | – | tenant-scoped |
| POST `/auth/password/change` | ✅ | – | – | `ChangePasswordDto` | 204 | wrong current pw | disabled account | – | – | ✅ | user from JWT; revokes OTHER sessions |
| POST `/auth/password/forgot` | – | – | – | `ForgotPasswordDto{email}` | 202 `{accepted}` | – | – | – | – | ✅ | identical response; token only for active |
| POST `/auth/password/reset` | – | – | – | `ResetPasswordDto{token,newPassword}` | 204 | invalid/expired/used token | – | – | – | ✅ | single-use CAS; revokes ALL sessions |
| GET `/health` | – | – | – | – | `{status:'ok'}` | – | – | – | – | – | liveness only |

No endpoints beyond the above exist (no invented routes). **FACT.**

## 6. Authentication Flow

Traced login → context → RLS. **FACT** (file:line):
`login` (`auth.service.ts:44-101`) → `verifyPasswordSafe` timing-safe Argon2 verify
(`credentials.service.ts:31-42`) → user-status gate → session create + hashed refresh token
(`sessions.service.ts:47-59`) → access JWT `{sub,sid}` (`auth.service.ts:83-86`) → optional
`POST /auth/tenant` re-validates an active membership/tenant and mints `{sub,sid,tid,mid}`
(`tenant-selection.service.ts:47-76`) → per-request `TenantContextService.resolve`
re-queries the membership (active, belongs to `sub`+`tid`) and computes permissions
server-side (`tenant-context.service.ts:64-103`) → controller → service under
`withAuthContext({userId,tenantId})` → transaction-local `set_config('app.*',…,true)`
(`prisma.service.ts:55-67`) → RLS policies.

Confirmed (FACT): credentials/tenant identity are never trusted from client-side tenant
info; `tid/mid/trm` come only from the signed JWT (never headers/body/query for authz —
e2e-proven, §19); membership/session/terminal ids are validated; permissions resolved
server-side; RLS context derived from the validated principal. The only client-supplied
`tenantId` is the *selection* input to `POST /auth/tenant`, validated against an active
membership before issuing context (choose-among-own, not trust-as-identity). **FACT.**

## 7. JWT Security Review

**FACT** (file:line):
- Payload = IDs only: `sub, sid` and optional `tid, mid, trm`, plus `iat/exp`
  (`auth.types.ts:5-13`, `auth.service.ts:83-86,148-153`). No password/refresh token/secret
  in the payload.
- Symmetric string secret from `JWT_ACCESS_SECRET` via `getOrThrow`, validated `@MinLength(32)`
  at boot (`identity.module.ts:46`, `env.validation.ts:37-39`); startup aborts if missing/short.
- Access TTL = `JWT_ACCESS_TTL` (e.g. `15m`) (`identity.module.ts:50-52`).
- Verification catches every failure (bad signature/expiry/malformed) → bare 401
  (`jwt-auth.guard.ts:41-43`, `access-token.service.ts:17-19`). e2e-proven for missing/
  invalid/expired/tampered tokens (§19 matrix).
- Principal built from claims in `JwtAuthGuard`; tenant/permission authority is deferred to
  `TenantContextService`, which re-validates from DB (does not trust `tid/mid` blindly).
  **FACT** (`tenant-context.service.ts:64-71`).

**INFERENCE:** signing algorithm is HS256 (library default; symmetric secret, no keypair) —
no `algorithms` allowlist is set on verify and no `algorithm` on sign.

Findings: JWT-1 (no algorithm allowlist), JWT-2 (no issuer/audience) — both LOW hardening
(§25). Access tokens are intentionally *not* re-checked against session revocation until
`exp` — a **KNOWN LIMITATION** (short-lived access tokens; the brief explicitly forbids
implementing access-token revocation).

## 8. Refresh Token Security Review

**FACT** (file:line):
- Opaque `randomBytes(64)` (512-bit) base64url; **not** a JWT (`refresh-token.ts:9-11`).
- Stored only as **SHA-256** hex in `refreshTokenHash` (`@unique`); plaintext returned once,
  never persisted (`refresh-token.ts:13-15`, `sessions.service.ts:47-59`, `schema.prisma:111`).
  e2e: "never stores a plaintext refresh token in the DB".
- Rotation mints a child session and revokes the presented one via a **compare-and-swap**
  `updateMany` (WHERE not-revoked AND not-replaced AND not-expired); losers of a concurrent
  race get 0 rows → 401 (`sessions.service.ts:123-162`). e2e: "concurrent refresh… exactly
  one wins".
- Reuse detection: a presented session already replaced/flagged triggers `revokeChain` (walks
  `replacedBySessionId`, caps 1000, revokes all live nodes) in its own transaction, then 401
  (`sessions.service.ts:96-115,180-207`). e2e: "detects reuse and revokes the whole chain".
- Expiry + revocation enforced (`sessions.service.ts:116-121,133`); logout revokes session →
  subsequent refresh rejected (`auth.service.ts:158-159`). e2e-proven.
- On refresh, inactive **user** → new session revoked + 401; inactive **membership/tenant** →
  `tid/mid` dropped; inactive **terminal** → `trm` dropped (`auth.service.ts:120-153`,
  `memberships.service.ts:43-51`).

Findings: RT-1 (child session minted before inactive-user check → an extra immediately-revoked
row; not exploitable) — LOW.

## 9. Password Security Review

**FACT** (file:line):
- **Argon2id** (`credentials.service.ts:15`); `argon2.verify` with malformed-hash → false and a
  timing-guard dummy verify when no hash exists (`credentials.service.ts:21-43`). Raw passwords
  never logged/stored/returned.
- Policy: length 8–256 + small common-password blocklist, enforced on create/rotate/change/reset
  and at the DTO (`password-policy.ts`, `change-password.dto.ts:9`, `reset-password.dto.ts:10`).
- **Change:** current password required + verified (401 on mismatch); acting user from JWT
  principal (no target-user field → cannot change another user); active-account gate (403);
  revokes **OTHER** sessions, keeps current, atomic with rotation in one `$transaction`
  (`password.service.ts:47-73`). Matches ADR-0005. e2e-proven.
- **Reset:** opaque `randomBytes(48)` (384-bit), **SHA-256** hash stored, raw only to notifier;
  single-use + expiry via atomic CAS `updateMany` (consumedAt/expiresAt); 1-hour TTL; revokes
  **ALL** sessions in the same tx; disabled accounts unaffected/stay disabled
  (`password-reset-token.ts`, `password.service.ts:126-152`). Matches ADR-0005. e2e-proven
  (hash-only, single-use replay-blocked, expired→401, unknown→401, malformed→400).
- **Forgot:** unknown/inactive users get no token; controller always returns **202
  `{accepted}`** → enumeration-safe; notifier logs `userId` only, never the token
  (`password.service.ts:91-96`, `password.controller.ts:63-66`, `password-reset.notifier.ts:31`).
  e2e: "known and unknown accounts are indistinguishable".

ADR-0005 conformance: **no functional deviation.** Finding: PW-1 (Argon2 m/t/p params rely on
library defaults rather than being pinned) — LOW.

## 10. Multi-Tenant Authorization Review

**FACT** (file:line): Users are tenant-agnostic — `model User` has **no** `tenant_id`
(`schema.prisma:41`); no `user_roles` table/model anywhere (grep clean; schema comment notes it
was replaced by `membership_roles`). Membership is the boundary
(`Membership{userId,tenantId,status}` `@@unique([userId,tenantId])`). Chain modeled exactly:
`Membership → MembershipRole → Role → RolePermission → Permission`. Inactive membership/tenant
rejected; tenant selection cannot cross boundaries; JWT tenant context is re-validated, not
blindly trusted; no `users.tenant_id` shortcut. Repo grep for `users.tenant_id`, `user_roles`,
`x-tenant-id`, `x-membership-id` reading for authz → **zero** hits. e2e: tenant-context suite
(#9/#10 headers cannot override, #11/#12 body/query cannot override), RBAC #13
(client-supplied role/permission cannot elevate). **FACT.**

## 11. RBAC Review

**FACT** (file:line): Permissions resolved server-side by walking `membershipRoles →
role.rolePermissions → permission.code` (`tenant-context.service.ts:98-103`); JWT carries no
roles/permissions. `@RequirePermission` (AND) / `@RequireAnyPermission` (OR)
(`require-permission.decorator.ts`); `PermissionGuard` enforces every/some
(`permission.guard.ts:46-52`). Guard order JWT→TenantContext→Permission; 401 (unauthenticated)
vs 403 (authorized-but-denied) cleanly separated. Cross-tenant role/membership access blocked at
both app layer (lookups scoped by `ctx.tenantId`) and RLS. System roles protected (create forces
`isSystem:false`; assign/update reject `isSystem` → 403); **verified no API path can set
`is_system=true`**. e2e: RBAC #1–#13 (grant/deny/401/multi-role/role-removed/permission-removed/
cross-tenant/system-role/tampered-JWT/no-elevation). **FACT.**

## 12. Tenant Context Review

**FACT** (file:line): `TenantContextService` is the **single** authoritative resolver
(memoized on `request.authorization`); grep confirms no duplicate resolver, **no
AsyncLocalStorage** (only a comment stating it is not used), no global mutable tenant state.
`resolve` re-queries `membership.findFirst` requiring `id=mid AND userId=sub AND tenantId=tid
AND status='active' AND tenant.status='active'` → 403 on any mismatch
(`tenant-context.service.ts:32-71`). `branchId` is never used as `tenantId` (only on the
Terminal model + a reserved unused `TenantContext.branchId`). Services receive explicit tenant
context via the resolved `ctx`. e2e: tenant-context #1–#17. **FACT.**

## 13. PostgreSQL RLS Review

**Runtime/role separation (FACT, live catalog):** `ros_app` `rolsuper=f, rolbypassrls=f`;
`ros_migrator` `rolsuper=t`. Runtime PrismaService connects via `APP_DATABASE_URL` (ros_app);
`prisma.config.ts` uses `DATABASE_URL` (ros_migrator) for CLI/migrations only; **no runtime code
reads the migrator URL** (grep clean). **FACT** (`prisma.service.ts:37`, `prisma.config.ts`).

**Transaction-local context (FACT):** `withAuthContext` runs
`set_config('app.user_id',$1,true), set_config('app.tenant_id',$2,true)` on the interactive
`$transaction` client, same connection; the `true` = SET-LOCAL semantics (discarded at
COMMIT/ROLLBACK). No session-level settings. Missing context → `''` → `NULLIF(...,'')::uuid` →
NULL → predicate false ⇒ **fail-closed** (`prisma.service.ts:55-67`). e2e rls #14 (no leak to a
later pooled query), #15/#16 (concurrent A/B never cross-contaminate), #9/#18 (no context → 0
rows).

**Per-table RLS matrix (FACT — migration SQL + live `pg_class`/`pg_policies` agree):**

| table (schema) | RLS | FORCE | SELECT policy | write WITH CHECK | notes |
|---|---|---|---|---|---|
| memberships (identity) | ✅ | ✅ | `tenant_id=app.tenant_id OR user_id=app.user_id` | ins/upd `tenant_id=app.tenant_id` | dual-select lets a user discover own tenants pre-selection |
| membership_roles (identity) | ✅ | ✅ | via parent membership | via parent membership tenant | inherited |
| roles (identity) | ✅ | ❌ (not FORCE) | `tenant_id=app.tenant_id OR is_system` | `tenant_id=app.tenant_id` | not-FORCE lets migrator seed system roles; safe (ros_app NOBYPASSRLS) |
| role_permissions (identity) | ✅ | ❌ | via parent role | via parent role tenant | inherited; no UPDATE policy (PK-only) |
| terminals (identity) | ✅ | ✅ | `tenant_id=app.tenant_id` | tenant | |
| device_fingerprints (identity) | ✅ | ✅ | via parent terminal | via parent terminal | no UPDATE policy (append/replace) |
| audit_entries (governance) | ✅ | ✅ | `tenant_id=app.tenant_id` | INSERT tenant only | append-only: `REVOKE UPDATE,DELETE,TRUNCATE` + no update/delete policy |
| users, credentials, sessions, password_reset_tokens, permissions, tenants (identity) | ❌ | ❌ | — | — | tenant-agnostic/global by design (ADR-0001); isolation is app-layer (keyed by user_id/token_hash) |

e2e rls suite proves cross-tenant SELECT/INSERT/UPDATE/DELETE are all blocked and INSERT-spoof
denied. Findings: RLS-1 (roles/role_permissions ENABLE-not-FORCE — INFO, intentional),
RLS-2 (`is_system` write-gap at policy level, not API-reachable — LOW).

## 14. Terminal / Device Security Review

**FACT** (file:line): Registration is a server-controlled `TERMINAL_MANAGE` action; `tenantId`
from ctx not body (`terminal.controller.ts:52-58`). Status enum `active|disabled|revoked`.
Device fingerprint stored only as **SHA-256** `fingerprint_hash`, never raw, never logged;
`TerminalSummary` excludes fingerprint material (`device-fingerprint.ts:9-11`,
`terminal.view.ts:7-30`). Terminal↔session binding validates `terminalId` in-tenant + active →
mints `trm`; cross-tenant/unknown → 404, disabled/revoked → 403 (`terminal-session.service.ts:
43-70`). Client cannot self-assign a trusted terminalId (trusted identity only via signed `trm`).
Refresh keeps `trm` only while the terminal is still active in the tenant. All reads/writes under
`withAuthContext` (RLS). e2e terminal #1–#25 (cross-tenant invisible, disabled/revoked cannot
bind, fingerprint hash-only, tampered `trm` rejected, duplicate→409, fingerprint idempotent).

Finding: TERM-1 (no status transition state-machine — `revoked → active` is permitted by a
MANAGE-holder) — MEDIUM, NON-BLOCKER (ADR-0004 is "minimum-safe"; branch-level authz explicitly
deferred).

## 15. Rate Limiting Review

**FACT** (file:line): `@nestjs/throttler` via `AuthThrottlerGuard` on `POST /auth/login`,
`/auth/refresh`, `/auth/password/change`, `/auth/password/forgot`, `/auth/password/reset`
(per-endpoint, not global). Tracker key = IP+email (lowercased) where the body has `email`, else
IP; `'unknown'` fallback if no IP (`auth-throttler.guard.ts:13-23`). TTL/limit from
`AUTH_THROTTLE_TTL` (default 60000ms) / `AUTH_THROTTLE_LIMIT` (default 50)
(`identity.module.ts:58-68`). Over-limit → `ThrottlerException` → **429**. The guard performs no
logging (no email/token leakage). Helmet enabled with `contentSecurityPolicy:false` (Swagger);
global `ValidationPipe {whitelist, forbidNonWhitelisted, transform}` (`main.ts:13-23`). e2e
throttle: 429 after threshold; IP-key vs account-key independence.

Findings: RL-1 (defaults are intentionally lenient — production must tighten to ~5–10/60s;
documented in `.env.example`/ADR-0006) — MEDIUM. RL-2 (`AUTH_THROTTLE_*` not in the boot env
contract → a typo silently falls back to lenient defaults) — LOW. RL-3 (no `trust proxy` set →
behind a proxy `req.ip` needs configuration for correct keying) — LOW. RL-4 (CSP disabled) —
LOW, documented.

## 16. Audit Trail Review

Per Phase 12 (commit `bf1622b`) and the prior forensic report. **FACT**: `governance.
audit_entries` with per-tenant SHA-256 hash chain (`sequence_no + previous_hash → entry_hash`
over `stableStringify`); append-only for `ros_app` (grants revoked + no update/delete policy,
e2e-proven); RLS ENABLE+FORCE, tenant-scoped; sentinel platform tenant
`00000000-0000-0000-0000-000000000000` for global/anonymous auth events; secret-safe metadata
(allow-listed + `sanitizeMetadata` redaction, e2e-scanned); 10 wired events; actor/tenant
server-derived. e2e audit suite (7): sentinel + tenant chains, password lifecycle, chain
consecutive+linked, no-secrets, append-only, per-tenant RLS isolation.

**KNOWN LIMITATIONS (accepted from Phase 12 — see §26):** no production chain verifier;
best-effort (emit-after-commit) transactionality → a successful op can have a *missing* audit
(never a false-positive); incomplete event coverage (refresh-success, role/permission changes,
terminal status/fingerprint, authz-failures not wired); single global sentinel chain is an
auth-throughput bottleneck; privileged DB owner/superuser (`ros_migrator`) can rewrite the chain
(tamper-evident, not tamper-proof). **This audit trail is NOT claimed to be compliance-grade.**

## 17. Database / Prisma Review

**FACT** (gate log): `npx prisma format` OK; `npx prisma validate` "The schema is valid" (exit
0); `npx prisma generate` → Prisma Client 7.9.1 to `./src/generated/prisma`; `npx prisma migrate
status` → 8 migrations found, **"Database schema is up to date!"** (no drift). Schema uses
`schemas = ["governance","identity"]` + `public` for `_prisma_migrations`. ULID-as-UUID ids
(`newId()`), no FKs on audit (matches approved DDL), tenant-scoped uniques/indexes present.
No unnecessary migration was created. **FACT.**

## 18. Migration Safety Review

**FACT:** all 8 migrations are already applied to the dev DB and status reports no drift and no
pending migrations. Migrations are owned/applied by `ros_migrator`; runtime is `ros_app`. RLS
enable/force + policies + grants are expressed **in migration SQL** (not runtime), so a clean-DB
apply reproduces the full security posture. **No `prisma migrate reset` or any destructive
command was run** against the user's database (per the brief). A fully isolated clean-DB apply
was **not** performed this phase (no throwaway container spun up) to avoid any risk to the dev
environment — **RECOMMENDATION**: add a CI job that applies migrations to an ephemeral Postgres
and runs the RLS e2e suite. INFERENCE (from idempotent migration SQL + green `migrate status`):
a clean apply would succeed.

## 19. Test Matrix

Mapped from actual passing tests (unit 70, e2e 90). **FACT** — ✅ = covered by a named test.

| Area | Cases | Covered |
|---|---|---|
| Authentication | valid login / invalid pw / unknown user / disabled user / malformed | ✅ (auth e2e, password e2e "disabled→403", DTO validation) |
| JWT | valid / expired / malformed / tampered | ✅ (auth e2e me-with-invalid/expired; tenant-context #7/#8 tampered; RBAC #12) |
| Refresh | valid / rotated / reused / expired / revoked / concurrent | ✅ (refresh e2e — all six) |
| Tenant | valid / inactive membership / inactive tenant / unrelated / multiple / no-selection | ✅ (tenant e2e + tenant-context #1–#6,#13) |
| RBAC | granted / denied / multi-role / role-removed / perm-removed / system-role / cross-tenant / tampered | ✅ (rbac e2e #1–#13) |
| RLS | A-sees-A / A-not-B / insert-spoof / update-spoof / delete-spoof / no-context / pooled / concurrent | ✅ (rls e2e #1–#18) |
| Terminal | active / disabled / revoked / cross-tenant / fingerprint / terminal-bound session | ✅ (terminal e2e #1–#25) |
| Password | change / wrong-current / forgot / reset / expired-token / reused-token / concurrent / session-revocation | ✅ (password e2e + `password.service.spec` 9 unit; concurrent-reset via CAS unit) |
| Rate limiting | threshold / 429 / key-independence | ✅ (throttle e2e) — **gap:** no explicit "recovery after TTL" test (RECOMMENDATION) |
| Audit | success / no-secret / tenant+sentinel / append-only | ✅ (audit e2e 7) — **gap:** no tamper-*detection* recompute test (KNOWN, §26) |

## 20. Static Security Review

Repo-wide grep under `src` (excluding `src/generated`) for the mandated patterns; every hit
classified. **FACT** (summary; full per-hit classification in the static-scan agent output):

- `console.log`, `Logger.error`, `Logger.warn` (static), `x-tenant-id`, `x-membership-id`,
  `users.tenant_id`, `user_roles` → **no hits / CLEAN**.
- `Logger.log` → 1 SAFE (`main.ts:40` port).
- `JSON.stringify` → 2 SAFE (`audit-hash.ts` canonical hashing over already-sanitized metadata).
- `this.logger.warn` reuse-detection (`sessions.service.ts:98`) → SAFE (logs session+user ids,
  explicitly not the token). `password-reset.notifier` log → SAFE (userId only).
- `password`/`token`/`refreshToken`/`accessToken`/`secret`/`Authorization`/`BYPASSRLS`/
  `DATABASE_URL`/`APP_DATABASE_URL` → all SAFE (variable/type/config names; secrets read via
  `config.getOrThrow`, never logged; raw tokens hashed, returned once, never persisted).
- `AsyncLocalStorage` → 1 SAFE (comment stating it is not used).

No password/hash/token (plaintext or hash) / JWT secret / DB credential / fingerprint hash is
ever logged, thrown, or returned. No whole-object serialization of `req`/`principal`/`dto`/
`headers`. **No SECURITY ISSUE hits.** **FACT.**

## 21. API / DTO Exposure Review

**FACT:** all response boundaries go through view mappers that strip sensitive fields —
`SafeUser` (no `passwordHash`), `TenantSummary`, `MembershipView`, `TerminalSummary` (no
`fingerprintHash`). Login/refresh/select-tenant/bind return the raw access + refresh token
(expected, one-time) and never any hash. `/auth/me` selects only `mustReset` from credentials —
the hash is never fetched. No endpoint exposes credential secret, refresh/reset token hash, JWT
secret, DB creds, or fingerprint hash. **CONFIRMED.**

## 22. Error Handling Review

**FACT:** 401 = auth failure (guards, login, refresh, reset, wrong current pw); 403 =
authorized-but-denied (permission guard, no-context, inactive terminal/account, system-role);
404 = cross-tenant resources hidden via RLS → generic "not found" (no probing); 409 = duplicate
(email/role-name/terminal, `P2002` mapped to a generic message); 429 = rate limit; 400 =
validation (global pipe + password policy). Forgot-password returns identical 202 regardless of
email existence. Thrown messages are static strings — no SQL error, stack trace, or token/hash
is interpolated; env-validation reports variable **names** only. **CONFIRMED.**

## 23. Documentation Review

**Before this phase:** ADRs `0001`–`0007` present and accurate; `README.md` present; **no
`docs/auth/` developer guide existed.** **This phase adds** concise engineering docs (no
existing docs rewritten):
- `docs/auth/README.md` — index + subsystem map
- `docs/auth/authentication-flow.md` — login/refresh/logout/tenant-selection
- `docs/auth/authorization.md` — RBAC + TenantContext
- `docs/auth/tenant-isolation.md` — RLS model, roles, transaction-local context
- `docs/auth/security.md` — JWT/refresh/password/terminal/rate-limit/audit + accepted limitations
- `docs/auth/testing.md` — how to run unit/e2e/gate + DB roles + migrations

## 24. Environment / Deployment Review

**FACT:** `.env.example` documents `ROS_DB_*`, `DATABASE_URL`, `APP_DATABASE_URL`,
`JWT_ACCESS_SECRET/TTL`, `JWT_REFRESH_TTL`, `AUTH_THROTTLE_TTL/LIMIT`, `NODE_ENV`, `PORT` — all
placeholders, no real secrets. `.gitignore` excludes `.env*`, `/dist`, `/node_modules`,
`/src/generated`, `/coverage`. `git status` clean; no secrets tracked. Boot-time
`EnvironmentVariables` validates `DATABASE_URL`, `APP_DATABASE_URL`, `JWT_ACCESS_SECRET`
(`@MinLength(32)`), `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `NODE_ENV`, `PORT`. **Finding RL-2:**
`AUTH_THROTTLE_*` are consumed with defaults but not in this validated contract (LOW).

## 25. Findings

| ID | Severity | Blocker? | Area | Finding | Evidence | Recommendation |
|----|----------|----------|------|---------|----------|----------------|
| JWT-1 | LOW | No | JWT | No `algorithms` allowlist on verify / no `algorithm` on sign (relies on HS256 default) | `access-token.service.ts:18-19`, `identity.module.ts:47-53` | Pin `algorithms:['HS256']` + `algorithm:'HS256'` |
| JWT-2 | LOW | No | JWT | No issuer/audience issued or validated | `identity.module.ts`, `access-token.service.ts:19` | Add `issuer`/`audience` to sign+verify |
| RT-1 | LOW | No | Refresh | Child session minted before inactive-user check (extra immediately-revoked row) | `auth.service.ts:113-124` | Check `user.status` before minting, or accept |
| PW-1 | LOW | No | Password | Argon2 m/t/p params not pinned (library defaults) | `credentials.service.ts:15` | Pin `memoryCost/timeCost/parallelism` |
| TERM-1 | MEDIUM | No | Terminal | No status transition state-machine (`revoked→active` allowed by MANAGE) | `terminals.service.ts:130-152` | Enforce allowed transitions (block reactivating `revoked`) |
| RL-1 | MEDIUM | No | Rate limit | Default TTL/limit intentionally lenient (60000/50) | `identity.module.ts:63-64`, `.env.example` | Set production `AUTH_THROTTLE_LIMIT`≈5–10 / 60s |
| RL-2 | LOW | No | Env | `AUTH_THROTTLE_*` not in boot env contract → typo → silent lenient default | `env.validation.ts` | Add validated optional fields |
| RL-3 | LOW | No | Deploy | No `trust proxy`; behind a proxy `req.ip` keying needs config | `main.ts` | Set Express `trust proxy` in prod |
| RL-4 | LOW | No | Headers | CSP disabled (`contentSecurityPolicy:false`) for Swagger | `main.ts:13` | Tailored CSP once a fixed FE origin exists |
| RLS-1 | INFO | No | RLS | `roles`/`role_permissions` ENABLE but not FORCE | migration `…_rls`, live catalog | Intentional (migrator seeds system roles); safe — none |
| RLS-2 | LOW | No | RLS | `is_system` not gated in WITH CHECK (not API-reachable) | `roles` policy; `roles.service.ts:39` | Add `AND is_system=false` (defense-in-depth) |
| API-1 | LOW | No | API | No URI versioning (all routes under `/auth`) | `main.ts` (no `enableVersioning`) | Add versioning if intended, else document |
| DOC-1 | MEDIUM | No | Docs | `docs/auth/` was missing | pre-phase tree | **Resolved this phase** |
| AUD-1..5 | INFO | No | Audit | Phase 12 known limitations | §16, §26 | See §26/§27 |

**Totals: CRITICAL 0, HIGH 0, MEDIUM 3 (TERM-1, RL-1, DOC-1[resolved]), LOW 8, INFO ≥6. All
NON-BLOCKER.**

## 26. Known Accepted Limitations

Distinct from defects — these are ratified/accepted design choices:
- **Access-token revocation window** — access tokens remain valid until `exp` (≤ `JWT_ACCESS_TTL`)
  after logout/revoke. Accepted (short-lived tokens); the brief forbids implementing access-token
  revocation. KNOWN LIMITATION.
- **Audit (Phase 12):** (1) no production chain verifier; (2) best-effort emit-after-commit
  (missing-audit possible, false-positive impossible); (3) incomplete event coverage
  (refresh-success, role/permission/terminal-status/fingerprint, authz-failures not wired);
  (4) single global sentinel chain = auth-throughput bottleneck; (5) owner/superuser can rewrite
  the chain (tamper-evident, not tamper-proof). **Not compliance-grade.** KNOWN LIMITATIONS.
- **Branch-level authorization deferred** — `branchId`/`MembershipRole.branchId` recorded but not
  enforced; a tenant admin manages all branches (ADR-0002/0004). KNOWN LIMITATION.
- **`roles`/`role_permissions` not FORCE RLS** — intentional so `ros_migrator` seeds system roles;
  safe because `ros_app` is NOBYPASSRLS. KNOWN LIMITATION.

## 27. Required Follow-ups

**Immediate blockers:** none.

**Before production:**
- Set `AUTH_THROTTLE_LIMIT`/`TTL` to strict production values (RL-1); add them to the validated
  env contract (RL-2); set Express `trust proxy` (RL-3).
- Provide a real `PasswordResetNotifier` (email/SMS) implementation (current is a logging stub).
- Rotate/set strong `JWT_ACCESS_SECRET` and DB passwords from a secret manager.

**Future hardening:** pin JWT algorithm + add issuer/audience (JWT-1/2); pin Argon2 params
(PW-1); terminal status transition guard (TERM-1); `is_system` WITH CHECK (RLS-2); tailored CSP
(RL-4); CI clean-DB migration+RLS job (§18); rate-limit recovery-after-TTL test; audit
tamper-detection/recompute test.

**Future architecture/domain work (Phase 14+):** production audit chain verifier + broaded event
coverage + sentinel-chain sharding; access-token revocation strategy if required; branch-level
authorization; business-domain permission catalog.

## 28. Verification Commands (actually executed)

```
git status --short                         # clean
git log --oneline --decorate -22           # all phase commits present
git show --stat bf1622b
npx prisma format                          # exit 0
npx prisma validate                        # exit 0 — schema valid
npx prisma generate                        # exit 0 — Client 7.9.1 → src/generated/prisma
npx prisma migrate status                  # exit 0 — 8 migrations, "up to date", no drift
npm test                                   # exit 0 — 17 suites, 70 tests
npm run test:e2e                           # exit 0 — 11 suites, 90 tests
npm run build                              # exit 0 — nest build
npx eslint "{src,test}/**/*.ts"            # exit 0 (no --fix)
# read-only DB introspection (pg_roles, pg_class, pg_policies, role_table_grants) via psql SELECT
# repo-wide grep/rg for the §19 pattern set (read-only)
```
No destructive command was run; no `prisma migrate reset`; the dev database was not reset.

## 29. Test Results (exact)

- **Unit:** Test Suites 17 passed / 17; Tests **70 passed / 70**; 0 failed. **FACT** (gate log).
- **E2E:** Test Suites 11 passed / 11; Tests **90 passed / 90**; 0 failed. **FACT** (gate log).
- **Build:** PASS (`nest build`, exit 0). **Lint:** PASS (eslint, no `--fix`, exit 0).
- **Prisma:** format/validate/generate PASS; **migrate status:** up to date, no drift.

## 30. Final Security Verdict

**PASS WITH CONDITIONS.**

The subsystem is internally consistent, correctly integrated, fully building/testing, migration-
and RLS-safe, and resistant to the common auth failure modes — with 0 CRITICAL and 0 HIGH
findings and comprehensive passing tests. It is a sound foundation for the remaining ROS domains.

The **conditions** are production configuration and future hardening, not code defects:
(1) tighten the intentionally-lenient rate-limit defaults and validate/trust-proxy them before
production; (2) supply a real password-reset notifier and secret-managed credentials; (3) treat
the Phase 12 audit trail as **tamper-evident, not compliance-grade** until a production verifier +
broader event coverage exist. None of these block Phase 14.

"Production-ready" is asserted only for the code's correctness and security posture under test;
full production readiness additionally requires the "Before production" items in §27.
