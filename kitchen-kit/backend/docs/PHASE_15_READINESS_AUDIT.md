# PHASE 15 READINESS AUDIT

## ROS Backend — Independent technical audit of Phases 1–14

- Date: 2026-08-16
- Auditor scope: repository at `kitchen-kit/backend`, HEAD `48a16f9`
- Method: source review + **live execution** of the test/build/lint toolchain +
  **direct database interrogation** of the running PostgreSQL instance
- Nothing was modified. No code, schema, migration, test or configuration change
  was made. Two normally-mutating commands were deliberately avoided:
  `npm run lint` (its script includes `--fix`) and `prisma generate` (writes
  `src/generated`). ESLint was run read-only instead.

---

## 1. Executive Summary

**Verdict: READY FOR PHASE 15.**

The authentication and tenancy foundation is materially stronger than a
documentation-only review would establish, and — importantly — the claims in the
previous phase reports were **independently reproduced**, not taken on trust. The
central security property that Phase 15 depends on, PostgreSQL row-level tenant
isolation, was proven empirically against the live database as the runtime role,
including a negative control to confirm the test itself was meaningful.

Verified by execution rather than by reading:

| Claim | Reported | **Actually measured** | Status |
|---|---|---|---|
| Unit tests | 70/70 PASS | **92 passed / 92, 20 suites** | PASS (count differs) |
| E2E tests | 90/90 PASS | **90 passed / 90, 11 suites** | PASS (exact match) |
| Build | PASS | `nest build` exit 0 | PASS |
| Lint | PASS | `eslint` (no `--fix`) exit 0 | PASS |
| Prisma validate | PASS | valid | PASS |
| Migrations | 8 found | 8 found, **"Database schema is up to date"** | PASS |
| RLS enforcement | asserted | **proven live as `ros_app`** | PASS |
| `ros_app` has no BYPASSRLS | asserted | `rolbypassrls = f`, `rolsuper = f` | PASS |
| Audit append-only | asserted | UPDATE/DELETE → `permission denied` | PASS |

No CRITICAL findings. One HIGH, seven MEDIUM, six LOW, four INFO. **None of them
block Phase 15**, though several should be settled before Organisation
permissions and Organisation audit events are introduced, because Phase 15
widens their blast radius.

Two caveats on the previous reports. First, the unit-test figure of 70 is stale —
the suite is now 92; the direction is favourable but the number in the report is
not accurate. Second, `Build: PASS` is true but narrower than it sounds: a **full**
TypeScript check across the repository currently **fails** (F-M3), because the
build config excludes test files.

---

## 2. Repository State

```
kitchen-kit/backend
├── prisma/            schema.prisma + 8 migrations (+ migration_lock.toml)
├── src/
│   ├── common/        ids.ts, duration.ts, throttler/
│   ├── config/        env.validation.ts (+ spec)
│   ├── generated/     Prisma client (gitignored)
│   ├── health/        health module
│   ├── modules/
│   │   ├── governance/audit/    audit service, hash, verify, constants
│   │   └── identity/            auth, authz, context, credentials,
│   │                            memberships, password, sessions, tenants,
│   │                            terminals, users
│   ├── prisma/        prisma.module.ts, prisma.service.ts
│   ├── app.module.ts  main.ts
└── test/              11 e2e suites + setup-e2e.ts + rls-admin.ts
```

- Git HEAD `48a16f9 feat(identity): final auth security hardening`; working tree
  clean apart from untracked documentation added during Phase 15 discovery.
- **No Organisation implementation exists.** A repository-wide search for
  org/brand/branch/warehouse/station code returns only
  `identity.terminals.branchId` (a recorded UUID with no FK) and
  `membership_roles.branch_id` (present, deliberately unconsumed). There is no
  half-built Organisation code to reconcile — the phase starts from a clean
  slate.
- **Zero `TODO`, `FIXME`, `HACK`, `XXX`, `@ts-ignore`, `@ts-expect-error` or
  `eslint-disable` anywhere** in `src/` or `test/`. This is unusual and is a
  genuine positive signal: there are no parked shortcuts.

---

## 3. Previous Phase Verification

Commands executed in `kitchen-kit/backend`:

```
npx jest --ci                      → 20 suites, 92 tests passed          exit 0
npx jest --config test/jest-e2e.json --ci
                                   → 11 suites, 90 tests passed          exit 0
npx nest build                     →                                     exit 0
npx tsc -p tsconfig.build.json --noEmit →                                exit 0
npx tsc -p tsconfig.json --noEmit  → 1 error (see F-M3)                  exit 1
npx eslint "{src,apps,libs,test}/**/*.ts"  (read-only)                   exit 0
npx prisma validate                → schema is valid                     exit 0
npx prisma migrate status          → 8 migrations, schema up to date     exit 0
```

Docker and PostgreSQL were running at audit time, so **every** database-dependent
claim was verifiable; nothing had to be taken on documentation alone.

ESLint is configured with `tseslint.configs.recommendedTypeChecked` and
`projectService: true`, so linting is genuinely type-aware rather than
syntax-only — a meaningful quality signal.

---

## 4. Authentication Audit

**Reviewed:** `auth.service.ts`, `auth.controller.ts`, `access-token.service.ts`,
`guards/jwt-auth.guard.ts`, `sessions/sessions.service.ts`,
`sessions/refresh-token.ts`, `credentials/credentials.service.ts`,
`password-policy.ts`, `auth.types.ts`.

Verified correct:

- **Login is enumeration-safe.** Unknown account, missing credential, wrong
  password and inactive account all produce one generic 401, and
  `verifyPasswordSafe` always runs a verification even when no credential exists,
  closing the timing channel (`auth.service.ts:48–80`).
- **Credentials never leave the service.** Only Argon2id hashes are persisted;
  `toSafeUser` strips everything sensitive; no hash appears in any response or
  audit payload.
- **Refresh tokens are opaque, 512-bit random values**; only a SHA-256 hash is
  stored (`refresh-token.ts`). A fast hash is correct here — the token is
  high-entropy and not user-chosen — and the reasoning is documented in-code.
- **Rotation is atomic.** `sessions.service.ts:rotate` claims the old session
  with a conditional `updateMany ... WHERE revoked_at IS NULL AND
  replaced_by_session_id IS NULL AND expires_at > now`. Exactly one of N
  concurrent refreshes can win; losers are rejected without minting a token.
- **Reuse detection is correct and well-reasoned.** A replayed token revokes the
  entire rotation lineage, and the revocation is deliberately performed *outside*
  the rotation transaction so it commits despite the 401 that follows. A
  logout-revoked token (revoked but never replaced) is rejected **without**
  nuking the chain — the right distinction between attack and benign reuse.
- **Token payload carries no authorization data** — `sub`, `sid`, optional
  `tid`/`mid`/`trm` only. Permissions are resolved server-side per request and
  are never client-influenced.

**Accepted, documented design limit:** `JwtAuthGuard` verifies signature and
expiry only; it performs **no session-revocation lookup**. A logged-out user's
access token therefore remains usable until `exp` (`JWT_ACCESS_TTL = 15m`). I
initially flagged this as a finding, then confirmed it is explicitly recorded and
accepted as `P14-1` in `PHASE_14_FINAL_SECURITY_HARDENING.md` (§20, INFO,
non-blocking), with logout revoking the refresh token. The documentation is
accurate here. It is restated as **F-I2** because Phase 15 inherits it: an
Organisation mutation can be performed with a revoked session for up to 15
minutes.

---

## 5. Multi-Tenant Isolation Audit

**Reviewed:** `context/tenant-context.ts`, `tenant-context.service.ts`,
`tenant-context.guard.ts`, `current-tenant-context.decorator.ts`,
`prisma/prisma.service.ts`, `tenants/tenant-selection.service.ts`.

- **One resolver, memoised once per request.** `TenantContextService.require`
  resolves `user → membership → tenant` in a single query that simultaneously
  loads effective permissions, caching at `request.authorization`. No component
  re-derives tenancy.
- **Tenant identity originates only from the signed JWT.** No body, query or
  header path feeds tenancy. `x-tenant-id`, body `tenantId` and query `tenantId`
  are all ignored — asserted by `tenant-context.e2e-spec.ts`.
- **No global mutable state and no `AsyncLocalStorage`.** Context lives on the
  per-request object and is garbage-collected with it.
- **`withAuthContext` is the single DB context mechanism** — one interactive
  transaction whose first statement is
  `set_config('app.user_id',$1,true), set_config('app.tenant_id',$2,true)`.
  Transaction-local, so settings are discarded at COMMIT/ROLLBACK and cannot leak
  across pooled connections. A missing value is passed as `''`, which the
  policies map to `NULL` → fail closed.
- **Runtime connects as `ros_app`**, and `env.validation.ts:106` actively rejects
  an `APP_DATABASE_URL` containing `ros_migrator` in production. This is a
  genuinely good control — it makes the "never use the migrator at runtime" rule
  machine-enforced rather than merely documented.

---

## 6. RBAC Audit

**Reviewed:** `authz/permission.guard.ts`, `require-permission.decorator.ts`,
`roles.service.ts`, `membership-roles.service.ts`, `permissions.service.ts`,
`permissions.constants.ts`, `rbac.controller.ts`.

Correct:

- Guard order is `JwtAuthGuard` (401) → `TenantContextGuard` (403) →
  `PermissionGuard` (403); the permission guard consumes the memoised context and
  issues no second query.
- Cross-tenant role operations are blocked at **both** layers: a foreign role is
  invisible under RLS (→ 404, no probing) and the write policy would reject it
  regardless.
- System roles cannot be modified (`403`) or assigned via the API, and
  `createTenantRole` hard-codes `isSystem: false` — a client cannot mint a
  system role.
- The permission catalogue is deliberately minimal (six `identity.*` codes) with
  an in-code comment explaining that business permissions were **not** invented.
  That discipline held.

**Finding F-H1** (below): `RolesService.addPermissions` does not require the
granting user to already hold the permission being granted.

---

## 7. RLS Audit — verified against the live database

This section reports **measured** state, not migration source.

### Roles

```
rolname       | rolsuper | rolbypassrls | rolcanlogin
ros_migrator  | t        | t            | t
ros_app       | f        | f            | t
```

`ros_app` is not a superuser and cannot bypass RLS. ✔

### RLS status per table (`pg_class.relrowsecurity` / `relforcerowsecurity`)

| Table | RLS | FORCE | Assessment |
|---|---|---|---|
| `governance.audit_entries` | ✔ | ✔ | correct |
| `identity.memberships` | ✔ | ✔ | correct |
| `identity.membership_roles` | ✔ | ✔ | correct |
| `identity.terminals` | ✔ | ✔ | correct |
| `identity.device_fingerprints` | ✔ | ✔ | correct |
| `identity.roles` | ✔ | ✖ | intentional — owner seeds system roles (ADR 0003) |
| `identity.role_permissions` | ✔ | ✖ | intentional — same reason |
| `identity.users`, `credentials`, `sessions`, `password_reset_tokens`, `permissions`, `tenants` | ✖ | ✖ | documented as global/tenant-agnostic — see **F-M7** |

23 policies exist, distributed as documented. `audit_entries` has SELECT and
INSERT policies only — no UPDATE or DELETE policy — which is the intended
append-only shape.

### Empirical enforcement test (connected as `ros_app`)

| Probe | Expected | **Result** |
|---|---|---|
| A. `SELECT` on `memberships` with **no** tenant context | 0 rows (fail closed) | **0 rows** ✔ |
| C1. Cross-tenant `INSERT` — FK-valid row belonging to another tenant | rejected | **`ERROR: new row violates row-level security policy`** ✔ |
| C2. Same-tenant `INSERT` (negative control) | succeeds | **`INSERT 0 1`** ✔ |
| C3. Cross-tenant `SELECT` | 0 rows | **0 rows** ✔ |
| C4. `UPDATE` / `DELETE` on `audit_entries` | denied | **`permission denied for table audit_entries`** ✔ |

All probes ran inside transactions that were rolled back; no data was persisted.

**Method note — a false positive I caught and discarded.** My first cross-tenant
INSERT probe selected the "oldest" tenant as context and the "newest" tenant as
the row owner, and it returned `INSERT 0 1`, which looks exactly like an RLS
bypass. Before reporting it I checked the premise: the database contains
**exactly one tenant** (the e2e suites clean up after themselves), so oldest and
newest were the same row and the insert was legitimately same-tenant. The probe
was invalid, not the isolation. It was replaced with the C1/C2 pair above, which
uses a non-existent tenant as context and a real tenant as the row owner — so the
foreign key is satisfied and only the tenancy rule is violated — plus a positive
control proving the test can succeed when it should. **RLS is genuinely
enforced.**

---

## 8. Device Identity Audit

**Reviewed:** `terminals.service.ts`, `terminal-session.service.ts`,
`terminal.controller.ts`, `device-fingerprint.ts`, ADR 0004.

- Terminals are tenant-scoped with `ENABLE`+`FORCE` RLS; a cross-tenant terminal
  is invisible → 404, so terminal ids cannot be probed.
- Raw device fingerprints are **never stored** — only SHA-256 hashes; the raw
  value never reaches logs or audit metadata.
- Re-registration is idempotent via check-then-create (correct, since
  `device_fingerprints` has no UPDATE policy).
- Only `active` terminals may bind to a session; revoked/disabled terminals drop
  `trm` on refresh.
- Activation/pairing is **deliberately not invented** (ADR 0004) — consistent
  with the project's stated discipline.

Branch-level authorization is recorded-but-unenforced by design (ADR 0004,
re-deferred by ADR 0008 D-02). This is correct for Phase 15 as specified.

---

## 9. Password Lifecycle Audit

**Reviewed:** `password.service.ts`, `password-reset-token.ts`,
`password-policy.ts`, `password.controller.ts`, ADR 0005.

- Reset tokens are opaque and stored only as SHA-256 hashes; consumption is an
  atomic compare-and-swap; TTL is 1 hour.
- Password change revokes **all other** sessions
  (`where: { userId, id: { not: currentSessionId }, revokedAt: null }`) — correct,
  it preserves the caller's session while invalidating everything else.
- Reset completion revokes **all** sessions for the user.
- `forgot-password` is enumeration-safe (generic 202 regardless of account
  existence) and is throttled.

`mustReset` is advisory — a user with `mustReset = true` can still log in and
obtain full tokens. That is documented as intentional (surfaced via `/me`), and
is recorded as **F-I3**, not a defect.

---

## 10. Rate Limiting & Security Middleware Audit

**Reviewed:** `common/throttler/auth-throttler.guard.ts`, `identity.module.ts`,
`main.ts`, `env.validation.ts`, ADR 0006.

- The throttler tracker keys on **IP *and* account** where an email is present,
  so one account cannot be brute-forced across many IPs and one IP cannot spray
  many accounts. This is better than the usual IP-only default.
- `TRUST_PROXY` defaults to trusting **no** forwarding header, so a client cannot
  spoof its source IP to evade the limiter. Opting in requires explicit
  configuration. Correct default.
- Throttle defaults are production-safe (strict); the looser limit is opted into
  by `test/setup-e2e.ts`, committed so it does not depend on a developer's local
  `.env`.

Two real gaps: security headers are never exercised by any test (**F-M1**), and
rate limiting is applied per-route to auth/password endpoints only, with no
per-tenant API limiting (**F-M6**).

---

## 11. Audit Trail Audit

**Reviewed:** `audit.service.ts`, `audit-hash.ts`, `audit-verify.ts`,
`audit.constants.ts`, migration `20260812175712`, ADR 0007.

Strong:

- **Tamper evidence is real.** `entry_hash = SHA-256(canonical(entry) ‖
  previous_hash)`, over a deterministic `stableStringify` with recursively sorted
  keys, so the canonical form does not depend on property order.
- **Immutability is enforced at the database, not in code.** `ros_app` holds only
  `INSERT, SELECT` on `audit_entries`; `UPDATE`/`DELETE` are revoked and have no
  policy. I verified both are refused at runtime (§7, probe C4).
- **Chain writes are race-safe** via a per-tenant `pg_advisory_xact_lock`, so
  `sequence_no` and `previous_hash` cannot interleave.
- **Secrets cannot reach the trail.** `sanitizeMetadata` redacts any key matching
  a broad secret pattern (`pass|secret|token|hash|authorization|cookie|
  fingerprint|api_key|refresh|credential|mfa|bearer`) before hashing *and* before
  storage — defence in depth, not just a convention.
- `verifyAuditChain` detects content tampering, broken linkage, bad genesis and
  sequence gaps, and is deliberately **not** exposed over HTTP.

Gaps: every production call site uses best-effort `emit()` and none uses the
mandatory in-transaction `record()` (**F-M4**), and several security-sensitive
RBAC/terminal operations are not audited at all (**F-M5**).

---

## 12. API / Controller / Service Audit

- Controllers are thin; business logic lives in services; services take
  `tenantId` as an explicit argument and wrap work in `withAuthContext`. The
  layering the project claims is the layering it actually has.
- Error semantics are consistent and security-aware: 401 authentication, 403 no
  context / missing permission, **404 for cross-tenant resources** (no existence
  disclosure), 409 on `P2002`, 400 on malformed input.
- DTOs use `class-validator`; id-shaped fields use `UUID_PATTERN` rather than
  `@IsUUID()` — correct, because ULID-derived UUIDs are not RFC-4122 and a strict
  validator would wrongly reject them. This is a subtle detail the codebase gets
  right.
- No DTO accepts `tenantId` or any ownership field the server derives.

`AppModule` registers no global exception filter and no logging interceptor
(**F-I4**); the global `ValidationPipe`, helmet and `trust proxy` are wired in
`main.ts` only (**F-M1**, **F-M2**).

---

## 13. Database / Prisma Audit

- `prisma validate` passes; `prisma migrate status` reports 8 migrations applied
  and **no drift**.
- Migration pattern is consistent: Prisma-generated DDL followed by hand-written
  raw SQL for grants, RLS enablement and policies — the same shape Phase 15 will
  need.
- IDs are ULID-rendered-as-UUID (`newId()`), time-ordered and index-friendly.
- Money and quantity types are absent from the identity schema, as they should
  be.
- All tables are owned by `ros_migrator`; runtime holds DML only, no DDL.
- `ros_migrator` is `SUPERUSER` + `BYPASSRLS` in this environment. ADR 0003
  describes it as "locally a superuser", so this matches the documented local
  posture, but it must not be replicated in production (**F-L2**).

---

## 14. Test Verification

| Suite | Result |
|---|---|
| Unit (`jest`, `rootDir: src`) | **20 suites, 92 tests, all passed**, 1.9 s |
| E2E (`jest --config test/jest-e2e.json`) | **11 suites, 90 tests, all passed**, 7.2 s |

E2E coverage genuinely includes the security matrix it claims: cross-tenant
SELECT/UPDATE/DELETE/INSERT-spoof, missing-context fail-closed, RBAC 403 paths,
refresh rotation and reuse detection, throttling, terminal binding, and audit
chain verification. `test/rls-admin.ts` restricts the privileged client to
arrange/teardown, with runtime isolation always proven through HTTP as `ros_app`
— the right discipline.

Weaknesses: the `ValidationPipe` is re-declared in nine separate e2e files
(**F-M2**), helmet is exercised nowhere (**F-M1**), and the full type check is
red (**F-M3**).

---

## 15. Documentation Verification

Present and, on inspection, **accurate**: `docs/adr/0001`–`0008`,
`docs/auth/{README,authentication-flow,authorization,security,tenant-isolation,testing}.md`,
`docs/PHASE_13_FULL_INTEGRATION_SECURITY_REVIEW.md`,
`docs/PHASE_14_FINAL_SECURITY_HARDENING.md`,
`docs/PHASE_15_DISCOVERY_REPORT.md`.

I spot-checked documentation claims against code rather than assuming: the ADR
0003 RLS table list, the ADR 0004 terminal decisions, the ADR 0007 sentinel-tenant
design and the Phase 14 finding register all match the implementation. The
Phase 14 report is notably honest — it records the access-token revocation window
as an accepted limitation rather than glossing over it.

The one inaccuracy found is the **stale unit-test count (70 vs actual 92)** in the
status summary carried into this task's prompt.

---

## 16. Findings by Severity

### HIGH

**F-H1 — A tenant role administrator can self-elevate to any permission in the catalogue**

- Component: RBAC · `src/modules/identity/authz/roles.service.ts:65–100`
  (`addPermissions`), `rbac.controller.ts:82–112`
- What is wrong: `addPermissions` validates that the requested permission codes
  *exist*, that the role is in the acting tenant, and that it is not a system
  role — but it never checks that the **granting user already holds** the
  permission being granted. Combined with `identity.role.assign`, a holder of
  `identity.role.update` can add any catalogue permission to a role and assign
  that role to their own membership.
- Why it matters: today the catalogue contains only six `identity.*` codes, so
  the practical ceiling is low. Phase 15 adds `settings.tenant.manage` and
  `settings.branch.manage` to the **same global catalogue**, at which point this
  becomes a path from "role admin" to "full Organisation control".
- Impact: privilege escalation **within** a tenant. It is **not** cross-tenant —
  RLS and the composite tenant checks still confine it to the acting tenant.
- Honest caveat: for a tenant-owner-like role this may be intended behaviour. No
  ADR or SRS requirement states either way, so it is currently an **undocumented**
  capability rather than a ratified one.
- Recommended fix: decide explicitly, then either enforce grant-only-what-you-hold
  in `addPermissions`, or document the escalation path as accepted in the
  authorization docs and the Phase 15 security review.
- **Blocks Phase 15: NO** — but should be settled before Organisation permissions
  are seeded.

### MEDIUM

**F-M1 — Security headers (helmet) are configured only in `main.ts` and are exercised by no test**

- Component: Security middleware · `src/main.ts:36`
- A repository-wide search for helmet or any header assertion
  (`x-frame-options`, `strict-transport-security`, `content-security-policy`,
  `x-content-type-options`) returns **only** the `main.ts` line. E2E suites boot
  `AppModule` via `Test.createTestingModule`, which never executes `bootstrap()`,
  so helmet is **not even loaded** during tests.
- Impact: Phase 11's security-header work is entirely unverified; a regression in
  `main.ts` would be invisible to the full suite. CSP is also disabled
  (`contentSecurityPolicy: false`) to keep Swagger working — a documented
  trade-off, but likewise untested.
- Fix: add an e2e suite that applies the same middleware and asserts the headers,
  or move middleware wiring into `AppModule` so it is covered by construction.
- **Blocks Phase 15: NO**

**F-M2 — Global `ValidationPipe` is duplicated across nine e2e files; production wiring is untested**

- Component: API validation · `src/main.ts:39–46` vs nine `test/*.e2e-spec.ts`
- Each suite re-declares its own `ValidationPipe`. The configuration in `main.ts`
  is therefore never integration-tested, and the two can drift silently.
- Impact for Phase 15: the "DTOs reject unknown fields / never accept `tenantId`"
  guarantee depends on `forbidNonWhitelisted`. A new Organisation e2e suite that
  forgets to replicate the pipe would appear to pass while testing nothing.
- Fix: extract one shared test bootstrap helper, or register the pipe in
  `AppModule` via `APP_PIPE`.
- **Blocks Phase 15: NO** (but fix before writing Organisation e2e suites)

**F-M3 — Full TypeScript check fails; `nest build` does not cover test code**

- Component: Build/type gate · `src/modules/identity/auth/access-token.service.spec.ts:28`
- `npx tsc -p tsconfig.json --noEmit` → **exit 1**:
  `error TS2322: Type 'string' is not assignable to type 'number | StringValue | undefined'`.
  `npx tsc -p tsconfig.build.json --noEmit` → exit 0, because
  `tsconfig.build.json` excludes `test` and `**/*spec.ts`.
- Impact: "Build: PASS" is accurate but narrower than it reads. There is no
  command in `package.json` that type-checks the whole repository, so test-code
  type errors accumulate silently.
- Fix: add a `typecheck` script running the full config and fix the existing
  error.
- **Blocks Phase 15: NO**

**F-M4 — All audit writes are best-effort; the mandatory in-transaction path is unused**

- Component: Audit · `audit.service.ts:123` (`emit`), all 10 call sites
- Every production call uses `emit()`, which catches and logs failures so a
  successful operation is never turned into a failure. `record(tx, event)` — the
  mandatory, in-caller-transaction variant — has **zero** production call sites.
- Impact: an audit write can fail while the mutation commits, leaving an
  unrecorded security event. Directly relevant to Phase 15: FR-PLT-004 states
  branch reassignment SHALL carry a full audit record, which requires `record()`,
  not `emit()`.
- Fix: use `record(tx, …)` for mutations whose auditability is a stated
  requirement.
- **Blocks Phase 15: NO** (but Organisation must not copy the `emit` pattern for
  mandatory events)

**F-M5 — Security-sensitive RBAC and terminal operations are not audited**

- Component: Audit coverage · `roles.service.ts`, `membership-roles.service.ts`,
  `terminal.controller.ts`
- Audited: login success/failure, logout, refresh reuse, tenant selection, role
  **assignment**, terminal registration, password change/reset.
- **Not audited:** role creation, permission grants to a role
  (`addPermissions` — the very operation in F-H1), role **removal**
  (`removeRole`, while `assignRole` *is* audited — an internal inconsistency),
  terminal status changes, and terminal-session binding.
- Impact: the escalation path in F-H1 would leave no audit trail for the grant
  itself, only for the subsequent assignment.
- **Blocks Phase 15: NO**

**F-M6 — Rate limiting covers only auth/password routes; no per-tenant API limiting**

- Component: Throttling · `auth.controller.ts:34,47`,
  `password.controller.ts:33,57,70`
- `AuthThrottlerGuard` is applied per-route via `@UseGuards`; it is **not**
  registered as a global `APP_GUARD`. Every other route, including all future
  Organisation endpoints, is unthrottled.
- SRS FR-PLT-015 [M] requires per-tenant rate limits on API requests; that is not
  implemented, and the current tracker keys on IP/email, not tenant.
- Also note the default in-memory throttler storage means limits are per process,
  not per cluster (**F-L4**).
- **Blocks Phase 15: NO** (Organisation endpoints will simply be unthrottled)

**F-M7 — Six identity tables have no RLS while `ros_app` holds full DML**

- Component: RLS · verified live: `users`, `credentials`, `sessions`,
  `password_reset_tokens`, `permissions`, `tenants` all have
  `relrowsecurity = false`, and `ros_app` holds `SELECT, INSERT, UPDATE, DELETE`
  on each.
- This is documented and reasoned in ADR 0003 (global/tenant-agnostic identity
  data; the tenant registry is gated at the application layer), so it is a
  deliberate design, not an oversight.
- Impact for Phase 15: there is **no database-level backstop** on these tables.
  Any Organisation code that calls `tx.tenant.findMany()` or `tx.user.findMany()`
  returns rows for **all** tenants. The discipline that has protected this so far
  is application-layer only.
- Fix: no change required now; Phase 15 code review must explicitly confirm that
  Organisation services never query `tenants`/`users` unscoped.
- **Blocks Phase 15: NO**

### LOW

| ID | Component | Finding | Blocks? |
|---|---|---|---|
| **F-L1** | Grants vs policies | `ros_app` holds `UPDATE` on `device_fingerprints`, `membership_roles`, `role_permissions`, which have **no** UPDATE policy. RLS denies by default, so it fails closed, but the grant is broader than the policy — a defence-in-depth mismatch. | NO |
| **F-L2** | DB roles | `ros_migrator` is `SUPERUSER` + `BYPASSRLS`. Matches ADR 0003's "locally a superuser", but production must provision a non-superuser owner. | NO |
| **F-L3** | Audit | `verifyAuditChain` requires a contiguous chain starting at `sequenceNo = 1` (`expectedSeq = i + 1`), so it cannot verify a slice or a paginated window of a long chain. | NO |
| **F-L4** | Throttling | Default in-memory throttler storage → limits are per instance; a multi-replica deployment multiplies the effective limit. | NO |
| **F-L5** | Tooling | `npm run lint` runs `eslint --fix`, which **mutates source**. There is no read-only lint script, so CI cannot lint without risking writes. | NO |
| **F-L6** | RBAC | System roles cannot be assigned through the API (`403` in `MembershipRolesService.assign`), so any seeded system role is unusable at runtime. | NO |

### INFO

| ID | Finding |
|---|---|
| **F-I1** | Unit-test count in the previous status summary (70) is **stale**; the actual suite is **92**. E2E (90) matches exactly. |
| **F-I2** | Access-token revocation window: a revoked session's access token stays valid ≤ 15 min. Documented and accepted as `P14-1`. Phase 15 inherits it for Organisation mutations. |
| **F-I3** | `mustReset` is advisory — a flagged user can still authenticate. Surfaced via `/me`; documented in ADR 0005. |
| **F-I4** | No global exception filter and no logging interceptor. Nest's default filter is in use; logging is ad-hoc via `Logger`. Not a defect, but there is no structured request/audit correlation log. |

---

## 17. Blockers

**None.**

No finding in this audit prevents Phase 15 from beginning. The foundation's
critical security properties — tenant isolation at the database layer, a
non-bypassing runtime role, fail-closed missing context, append-only audit,
enumeration-safe authentication — were each verified empirically and hold.

Separately, and **not** a defect in the existing implementation: the
`PHASE_15_DISCOVERY_REPORT.md` records two open Phase 15 **design decisions**
(the `print_routing` nullable-uniqueness semantics, and confirmation that Prisma
back-relation fields on `Tenant`/`Terminal` fall within ADR 0008 D-16). Those are
decisions awaiting ratification, not blockers arising from this audit. The third
item in that report — environment verification — is now **resolved**: Docker is
running, and `prisma migrate status` confirms 8 migrations applied with no drift.

---

## 18. Non-Blocking Issues

Recommended ordering, by value relative to Phase 15:

1. **F-M2** — consolidate the e2e bootstrap **before** writing Organisation e2e
   suites, so tenant-isolation and DTO-rejection tests cannot silently test
   nothing.
2. **F-H1** — decide and document the permission-grant escalation rule **before**
   seeding `settings.*` permissions.
3. **F-M4 / F-M5** — settle mandatory-vs-best-effort audit and close the RBAC
   coverage gaps before Organisation audit events are designed.
4. **F-M3 / F-L5** — add `typecheck` and read-only `lint:ci` scripts; fix the
   existing spec type error.
5. **F-M1** — add security-header coverage.
6. **F-M6** — per-tenant rate limiting (SRS FR-PLT-015 [M]) as its own piece of
   work.
7. **F-M7** — enforce by review that Organisation never queries `tenants`/`users`
   unscoped.
8. **F-L1 … F-L6** — housekeeping.

---

## 19. PHASE 15 Readiness Verdict

# READY FOR PHASE 15

**Why.** The properties Phase 15 will build on are not merely documented — they
were reproduced:

- Tenant isolation is enforced by PostgreSQL, proven live as `ros_app` with a
  negative control (cross-tenant INSERT rejected, same-tenant INSERT accepted,
  cross-tenant SELECT empty, no-context fail-closed).
- The runtime role cannot bypass RLS (`rolbypassrls = f`, `rolsuper = f`), and
  production configuration that would connect as the migrator is rejected at
  boot.
- The audit trail is genuinely immutable to the runtime role — `UPDATE` and
  `DELETE` are refused by the database, not merely by convention.
- `withAuthContext` is the single, transaction-local context mechanism; there is
  no global mutable state and no `AsyncLocalStorage`.
- The whole toolchain passes: 92 unit tests, 90 e2e tests, build, type-aware
  lint, Prisma validation, and a clean migration state with no drift.
- There is no partial Organisation implementation to reconcile, and no parked
  technical debt markers anywhere in the codebase.

The pattern Phase 15 must replicate — Prisma-generated DDL followed by raw SQL
for grants, RLS enablement and policies — already exists and is proven by the
Phase 8/9/12 migrations.

**Exact state from which Phase 15 should begin:**

- Commit `48a16f9`, working tree clean apart from untracked Phase 15
  documentation.
- 8 migrations applied; database schema up to date; no drift.
- `prisma/schema.prisma` containing the `identity` and `governance` schemas only.
- ADR 0008 Accepted, with 14 ratified decisions.
- `PHASE_15_DISCOVERY_REPORT.md` complete, with two open design decisions
  outstanding.
- Next planned artefact: the single coherent Organisation migration (§13 of the
  discovery report), **after** those two decisions are ratified.

---

## 20. Recommended Next Steps

1. Ratify the two open Phase 15 design decisions in the discovery report
   (`print_routing` nullable uniqueness; Prisma back-relations on
   `Tenant`/`Terminal`).
2. Optionally address **F-M2** and **F-H1** first — both are cheap now and both
   get more expensive once Organisation code and permissions exist.
3. Begin Phase 15.1 (Prisma schema additions for the `org` and `kitchen` models)
   from the state described above. No migration should be authored until the
   schema additions are reviewed.
4. Carry F-H1, F-M4, F-M5, F-M6 and F-M7 into the Phase 15 security review as
   explicitly tracked items.

---

*This audit made no changes to the repository. Database probes ran inside
transactions that were rolled back; no rows were persisted. The two commands in
`package.json` that mutate files (`lint` via `--fix`, and `prisma generate`) were
deliberately not run.*
