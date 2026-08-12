# Phase 14 — Final Auth Security Hardening & Production Readiness

> Reporting convention (same as Phase 13): **FACT** = verified in repo/tests/DB.
> **INFERENCE** = reasonable conclusion. **KNOWN LIMITATION** = accepted from a prior phase.
> **RECOMMENDATION** = future improvement, not an existing requirement.

## 1. Executive Summary

Phase 14 takes the authentication subsystem from Phase 13's **PASS WITH CONDITIONS** to
**PRODUCTION READY WITH DOCUMENTED ACCEPTED LIMITATIONS**, by implementing the production-relevant
hardening the Phase 13 review recommended — **without** redesigning the architecture or changing
token semantics, RLS, RBAC, or the refresh/password flows.

Implemented, each with tests: (1) **JWT hardening** — algorithm/issuer/audience pinned on sign and
verify; (2) **Argon2id parameter pinning** (64 MiB / t=3 / p=4); (3) **rate-limit hardening** —
validated-at-boot config with a **production-safe default** and explicit, safe **proxy-trust**
handling; (4) **production secret/config validation** — placeholder secrets and a migrator runtime
URL are rejected at boot when `NODE_ENV=production`; (5) **password-reset notifier** production seam
+ documented provider contract; (6) an **internal audit-chain verifier** utility + tamper-detection
test (no public endpoint). Token claims (`sub/sid/tid/mid/trm`) are unchanged; access tokens remain
short-lived; append-only RLS audit remains intact.

Final gate (all green): Prisma format/validate/generate/migrate-status (no drift); **unit 92/92**
(was 70; +22), **e2e 90/90** (unchanged), build, lint. An independent final security pass found
**0 CRITICAL / 0 HIGH** issues. The audit trail is still documented as **tamper-evident, not
compliance-grade** (unchanged Phase 12/13 wording).

**Final verdict: PRODUCTION READY WITH CONDITIONS** — the remaining conditions are deployment
actions (real secrets, real notifier, HTTPS, backups/monitoring) enumerated in §21, not code
defects.

## 2. Scope

Address the production-relevant Phase 13 findings only. No new business domains, no framework/library
additions, no architectural redesign. Targeted, tested hardening; all pre-existing tests preserved.

## 3. Baseline

Before any change (Phase 13 HEAD `8f0258d`): **unit 70/70**, **e2e 90/90**, build PASS, lint PASS,
Prisma valid, migrations up to date (no drift). **FACT** (recorded `/tmp/phase14_baseline.log`,
exit 0). No pre-existing failures.

## 4. Changes Made

Modified (8) / new (5) — all additive hardening, no working-flow rewrite:

| File | Change |
|---|---|
| `src/config/env.validation.ts` | +`JWT_ISSUER`, `JWT_AUDIENCE`, `AUTH_THROTTLE_TTL`, `AUTH_THROTTLE_LIMIT` (validated ints, prod-safe defaults), `TRUST_PROXY`; + `assertProductionHardened` (reject placeholder secrets / migrator runtime URL in prod) |
| `src/config/env.validation.spec.ts` *(new)* | 8 unit tests for the contract |
| `src/modules/identity/identity.module.ts` | JWT `signOptions`/`verifyOptions` pin `algorithm HS256` + issuer + audience; throttle factory reads validated numeric config |
| `src/modules/identity/auth/access-token.service.spec.ts` *(new)* | 8 unit tests: valid / wrong-alg / wrong-iss / wrong-aud / bad-sig / tampered / expired / malformed |
| `src/modules/identity/credentials/credentials.service.ts` | Pin explicit `ARGON2_OPTIONS` (argon2id, 65536 KiB, t=3, p=4) |
| `src/main.ts` | Explicit, safe `trust proxy` from `TRUST_PROXY` (default: trust nothing) via `NestExpressApplication` |
| `src/modules/identity/password/password-reset.notifier.ts` | Documented production provider contract on the port |
| `src/modules/governance/audit/audit-verify.ts` *(new)* | Internal `verifyAuditChain` (recompute + linkage + sequence) — no HTTP surface |
| `src/modules/governance/audit/audit-verify.spec.ts` *(new)* | 6 tests incl. content-tamper / broken-link / deleted-entry detection |
| `test/setup-e2e.ts` *(new)* + `test/jest-e2e.json` | e2e opts into a looser, deterministic throttle limit (committed; not dependent on a local `.env`) |
| `test/throttle.e2e-spec.ts` | comment updated to reference `setup-e2e.ts` |
| `.env.example` | document new vars + production guidance |

## 5. Rate Limiting Hardening

**FACT:** `AUTH_THROTTLE_TTL`/`AUTH_THROTTLE_LIMIT` are now in the boot contract as `@IsInt` with
ranges (`TTL` 1000–3,600,000; `LIMIT` 1–100,000). Invalid/out-of-range → boot fails with the
variable name (env.validation.spec proves non-numeric and `0` both throw). The **code default is
production-safe** (`limit 10 / 60,000 ms`); the JwtModule/ThrottlerModule factory reads the
validated numeric values. Endpoint-specific throttling is preserved (login/refresh/change/forgot/
reset only — nothing added to business endpoints). Keying is unchanged (IP+email where present,
else IP). **Deployment assumption documented:** rate-limit keys use `req.ip`, which is only correct
behind a proxy when `TRUST_PROXY` is set — see §5-proxy.

**Proxy trust (FACT):** `TRUST_PROXY` is unset by default → Express `trust proxy = false` → **no**
`X-Forwarded-*` header is trusted, so a client cannot spoof its source IP. When set, `parseTrustProxy`
maps it safely: `false`/empty→false, `true`→true, integer→hop count, otherwise a subnet/`loopback`
string. This never blindly trusts arbitrary `X-Forwarded-For`.

**Tests:** `env.validation.spec` (valid config, explicit values, invalid non-numeric, out-of-range,
production hardened). Enforcement/threshold + key-independence remain covered by `throttle.e2e`;
the e2e run configures the limit deterministically via `setup-e2e.ts` (so the strict code default
does not make the many-call refresh suite flaky). **RECOMMENDATION (not done):** a dedicated
"recovery after TTL" e2e is still future work (would add real wall-clock delay).

## 6. JWT Hardening

**FACT:** `IdentityModule` now sets, from validated config:
- `signOptions: { algorithm: 'HS256', expiresIn: JWT_ACCESS_TTL, issuer: JWT_ISSUER, audience: JWT_AUDIENCE }`
- `verifyOptions: { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE }`

`@nestjs/jwt` merges module-level `verifyOptions` into every `verifyAsync()` call
(`mergeJwtOptions`, verified in source), so `AccessTokenService.verify` enforces them with no code
change. Arbitrary algorithms are rejected; there is no silent fallback. **Token claims are
unchanged** (`sub/sid/tid/mid/trm`), access-token lifetime unchanged (short-lived).

**Tests (`access-token.service.spec`, 8):** valid token verifies; wrong algorithm (HS512), wrong
issuer, wrong audience, wrong secret (bad signature), tampered signature, expired, and malformed all
reject. e2e unchanged (all app-minted tokens now carry the pinned iss/aud; tamper/expired e2e still
pass).

## 7. Argon2 Hardening

**FACT:** `credentials.service.ts` defines an explicit `ARGON2_OPTIONS = { type: argon2id,
memoryCost: 65536 (64 MiB), timeCost: 3, parallelism: 4 }` used by `hashPassword`. These **equal the
library defaults previously relied upon** (argon2 `^0.45.1`), so the change is behavior-preserving
and existing stored hashes (which self-describe their parameters) still verify. **Not weakened.**
Existing credential unit/e2e tests (hash, verify, reject-wrong, rotate, reset) remain green.

## 8. Environment / Secret Hardening

**FACT:** `validateEnv` now runs `assertProductionHardened` after structural validation: when
`NODE_ENV=production`, it rejects boot if `JWT_ACCESS_SECRET`/`DATABASE_URL`/`APP_DATABASE_URL`
match a placeholder pattern (`CHANGE_ME`/`placeholder`/`example`/…), or if `APP_DATABASE_URL` uses
the `ros_migrator` role (runtime must be `ros_app`). Values are never logged — only variable names.
Development/test are unaffected (they use real local values and `NODE_ENV=development`). `.env.example`
documents all vars incl. `JWT_ISSUER/AUDIENCE`, throttle guidance, and `TRUST_PROXY`. No secrets are
committed; `.env` remains gitignored/untracked. **Tests:** production-placeholder and
migrator-runtime-URL rejection, plus hardened-production acceptance (`env.validation.spec`).

## 9. Password Reset Production Readiness

**FACT (behavior unchanged):** reset token is `randomBytes(48)`, SHA-256 hash stored, single-use via
atomic CAS, 1-hour TTL, revokes ALL sessions; forgot-password is enumeration-safe (generic 202); the
default `LoggingPasswordResetNotifier` logs only `userId`, never the token. **Phase 14:** the
notifier **port** now documents the production provider contract (deliver securely; never
log/persist/return the token; credentials from secret management; a delivery failure must not reveal
account existence). Wiring: override `PASSWORD_RESET_NOTIFIER` in `IdentityModule`. No email provider
was invented (none specified by the SRS). This remains a **REQUIRED-BEFORE-PRODUCTION** item (§21).

## 10. Session / Refresh Review

**FACT (unchanged, re-verified):** refresh plaintext never persisted/logged (SHA-256 hash only,
`@unique`); rotation is atomic compare-and-swap; reuse detection revokes the whole chain; expired/
revoked/logout all reject; concurrent refresh → exactly one winner; inactive user → new session
revoked + 401; inactive membership/tenant drops `tid/mid`; disabled/revoked terminal drops `trm`.
The Phase 13 "refresh minting order" note (child session minted before the inactive-user check) is a
benign extra immediately-revoked row — **no concrete security/correctness issue**, so per the Phase
14 rules it is **left unchanged** (LOW, non-blocker). Covered by `refresh.e2e` (8) + unit specs.

## 11. Tenant / RLS Review

**FACT (unchanged, re-verified):** runtime is `ros_app` (`rolsuper=f, rolbypassrls=f`, live-verified
in Phase 13); no runtime code reads the migrator URL; `withAuthContext` sets `app.user_id`/
`app.tenant_id` transaction-locally (`set_config(..., true)`) on the same connection; missing context
→ NULL → fail-closed; no session-level tenant state, no `AsyncLocalStorage`, no global mutable state;
membership dual-predicate (`tenant_id = app.tenant_id OR user_id = app.user_id`) intact; system roles
protected; cross-tenant RBAC impossible. `tenant_id` is never taken from a DTO. RLS not weakened. The
new `TRUST_PROXY` (§5) additionally protects the *IP-based* rate limiter from spoofing. Covered by
`rls.e2e` (18) + `tenant-context.e2e` (17).

## 12. RBAC Review

**FACT (unchanged, re-verified):** `User → Membership → MembershipRole → Role → RolePermission →
Permission`; permissions resolved server-side; JWT carries no roles/permissions; client cannot supply
roles/permissions to elevate; `is_system` not settable via any API path; cross-tenant role assignment
fails; role/permission removal takes effect; 401 vs 403 correct. IDOR/BOLA-focused cases covered by
`rbac.e2e` (#7 foreign membership/role, #8 cross-tenant role grants nothing, #9 system-role, #13
client-supplied cannot elevate).

## 13. Terminal Review

**Decision (STOP-condition check):** the SRS/ADR-0004 define exactly `active|disabled|revoked` with no
richer lifecycle, so per the Phase 14 rules **no state machine was invented.** **FACT (re-verified):**
disabled/revoked terminals cannot bind (403) or refresh-preserve `trm`; status change requires
`TERMINAL_MANAGE`; cross-tenant terminal ops are impossible (RLS → 404); fingerprints are hash-only,
never logged; client cannot self-assign a trusted `terminalId`. The Phase 13 observation that
`revoked→active` is *permitted for a MANAGE-holder* creates **no security bypass** (it is an
authorized admin action, re-enabling a terminal record; it does not resurrect old sessions — those
were revoked). Documented as an accepted product behavior (§20); a stricter transition guard remains
**future work**. Covered by `terminal.e2e` (#1–#25).

## 14. Audit Review

**FACT (unchanged):** append-only for `ros_app`; per-tenant SHA-256 hash chain with `previous_hash`
linkage; secret-safe metadata; sentinel platform tenant for global auth events; tenant-scoped events
stay tenant-scoped. **Phase 14 addition:** `verifyAuditChain` (internal, read-only utility — **no
HTTP endpoint**) recomputes each `entry_hash`, checks linkage and sequence, and reports the first
break; a unit test now proves **tamper detection** (mutated field, broken link, deleted entry, bad
genesis) — closing the Phase 13 "no tamper-detection test" gap. The system is still **tamper-evident,
NOT compliance-grade** (verifier is not auto-run in prod; owner/superuser can still rewrite; emit is
best-effort; event coverage is partial). Covered by `audit.e2e` (7) + `audit-verify.spec` (6) +
`audit*.spec`.

## 15. Error Leakage Review

**FACT (unchanged, re-verified):** login is enumeration-safe (generic 401 + always-run Argon2
verify); forgot-password returns identical 202; reset/refresh failures are generic; cross-tenant
resources 404 without probing; thrown messages are static strings (no SQL/stack/token). New code adds
no logging of secrets (leak scan of changed files clean); `assertProductionHardened` reports variable
**names** only. `main.ts` `Logger.log` logs the port only.

## 16. DTO Validation Review

**FACT (unchanged):** global `ValidationPipe { whitelist, forbidNonWhitelisted, transform }` rejects
unknown fields; tenant/membership/terminal ids cannot be injected as trusted identity (server-derived
from JWT/context); role/permission ids are authorization-checked; UUID-shaped DTO fields; password
policy enforced at DTO + service. No validation weakened. New env values are themselves validated at
boot (see §5/§8).

## 17. Database Review

**FACT:** `npx prisma format`/`validate`/`generate` OK; `migrate status` → 8 migrations, **"Database
schema is up to date!"**, **no drift**. No migration was created, deleted, or reset (Phase 14 changed
no schema). RLS policies/grants unchanged; `ros_app` remains `NOBYPASSRLS`; auth-query indexes
unchanged. **The database was not reset.**

## 18. Test Results

- **Unit:** 20 suites, **92 passed / 92** (was 70; +8 env, +8 access-token, +6 audit-verify).
- **E2E:** 11 suites, **90 passed / 90** (unchanged — hardening is backward-compatible).
- **Build:** PASS. **Lint:** PASS (no `--fix`). **Prisma:** format/validate/generate PASS; migrate
  status up to date, no drift. **FACT** (`/tmp/phase14_retest.log`, `/tmp/phase14_gate.log`).

Coverage added for the Phase 14 changes: JWT alg/iss/aud rejection, env fail-fast + production
guard, Argon2 (existing tests still green under pinned params), audit tamper-detection.

## 19. Security Findings (independent final pass)

Looked for auth/authorization bypass, IDOR/BOLA, tenant escape, RLS bypass, privilege escalation, JWT
confusion, refresh replay, reset abuse, enumeration, rate-limit bypass, secret leakage, race
conditions, pool-context leakage, unsafe bootstrap.

| ID | Severity | Blocker? | Finding | Impact / Exploitability | Mitigation |
|----|----------|----------|---------|-------------------------|------------|
| P14-1 | INFO | No | Access-token revocation window (unchanged, accepted) | A stolen access token is usable until `exp` (short). Not exploitable beyond the window; logout revokes refresh. | Keep short TTL; documented (§20). |
| P14-2 | LOW | No | Terminal `revoked→active` allowed for MANAGE-holder | No bypass — authorized admin action; does not resurrect revoked sessions. | Optional transition guard (future). |
| P14-3 | LOW | No | Refresh mints child session before inactive-user check | Extra immediately-revoked row; not exploitable. | Left unchanged per rules. |
| P14-4 | INFO | No | Audit owner/superuser can rewrite chain; verifier not auto-run | Tamper-evident, not tamper-proof; insider/DB threat. | `verifyAuditChain` + ops process (future). |
| P14-5 | INFO | No | Audit emit best-effort (missing-audit possible, false-audit impossible) | A durable op may lack its audit row (logged). | `record(tx)` path exists for future atomic use. |

**No CRITICAL, no HIGH, no MEDIUM, no BLOCKER.** All findings are accepted limitations or non-
exploitable LOW/INFO.

## 20. Accepted Limitations (carried forward, documented)

- **Access-token revocation window** — short-lived tokens by design; immediate revocation NOT
  implemented (would add a per-request DB lookup — out of scope, and the STOP-condition check found
  no SRS requirement mandating it). Logout revokes the refresh token.
- **Audit is tamper-evident, not compliance-grade** — verifier not auto-run in production; DB
  owner/superuser can rewrite; best-effort transactionality; partial event coverage; single global
  sentinel chain is a throughput bottleneck.
- **Terminal lifecycle** — three states only (no richer state machine, none specified by SRS);
  `revoked→active` is an allowed admin action.
- **Branch-level authorization deferred** (ADR-0002/0004).
- **`roles`/`role_permissions` ENABLE-not-FORCE** — intentional (migrator seeds system roles), safe
  under `NOBYPASSRLS` `ros_app`.

## 21. Production Deployment Requirements

See the checklist in §24 (Production Readiness Checklist). Summary of REQUIRED-BEFORE-PRODUCTION:
real `JWT_ACCESS_SECRET` + DB credentials from secret management; strict `AUTH_THROTTLE_LIMIT`;
`TRUST_PROXY` matched to the proxy topology; a real `PasswordResetNotifier`; HTTPS termination; log
review; backups; monitoring/alerting; audit retention strategy; terminal provisioning process. The
boot-time production guard (§8) enforces the first two categories fail-fast.

## 22. Remaining Future Work

- Production audit chain-verifier job/alert + broader event coverage + sentinel-chain sharding.
- Rate-limit "recovery after TTL" e2e; distributed throttle store if running multi-instance
  (current store is in-memory per process).
- Optional terminal status transition guard; tailored CSP once a fixed front-end origin exists.
- Access-token revocation strategy only if a future SRS requirement mandates it (STOP + design first).

## 23. Final Verdict

**PRODUCTION READY WITH CONDITIONS.** The code's security posture is sound (0 CRITICAL / 0 HIGH, all
gates green, hardening implemented and tested, no behavior/architecture regression). The remaining
**conditions are deployment actions** (§21/§24), not code defects. The audit trail remains explicitly
**tamper-evident, not compliance-grade**.

## 24. Production Readiness Checklist

Legend: **[IMPL]** implemented in code · **[REQ]** required before production (ops) · **[FUT]** future
enhancement.

- [IMPL] Production rejects placeholder JWT secret / DB URLs and a migrator runtime URL at boot (`assertProductionHardened`).
- [REQ] Production `JWT_ACCESS_SECRET` configured (real, ≥32 chars) from secret management.
- [REQ] Database credentials managed securely (no secrets in VCS; `.env` gitignored — verified).
- [IMPL/REQ] `ros_app` is `NOBYPASSRLS` (verified live); ensure the production role is provisioned the same.
- [IMPL/REQ] Migrator credentials never exposed to runtime (runtime uses `APP_DATABASE_URL`=`ros_app`; prod guard rejects a migrator runtime URL).
- [IMPL/REQ] Production throttle limits configured (code default strict `10/60s`; set `AUTH_THROTTLE_LIMIT` per capacity).
- [IMPL/REQ] Trusted-proxy configuration reviewed (`TRUST_PROXY` default trusts nothing; set to match the real proxy topology).
- [REQ] Real password-reset notifier configured (override `PASSWORD_RESET_NOTIFIER`; contract documented).
- [REQ] Notifier provider credentials managed through secrets.
- [REQ] HTTPS enforced (terminate TLS at the proxy/ingress; app trusts proxy only when configured).
- [REQ] Secure deployment environment configured (network policy, least-privilege DB, secrets store).
- [IMPL/REQ] Logs reviewed for secrets/tokens (static scan clean; keep the practice in CI).
- [REQ] Database backups configured.
- [IMPL/REQ] Migrations reviewed (8, no drift; apply via `ros_migrator` in a controlled step).
- [REQ] Monitoring configured (health endpoint exists at `/health`).
- [REQ] Audit retention strategy defined (append-only growth; no partitioning yet).
- [REQ] Alerting configured (auth failures, 429 spikes, reuse-detection events).
- [REQ] Terminal provisioning process defined (registration is a `TERMINAL_MANAGE` admin action; no pairing flow).
- [FUT] Automated audit chain verification job; distributed rate-limit store; terminal transition guard; tailored CSP.
