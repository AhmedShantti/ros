# Security Notes

## JWT (access token)
- Payload = IDs only: `sub, sid`, optional `tid, mid, trm`, `iat/exp`. No password/refresh/secret.
- Symmetric secret `JWT_ACCESS_SECRET` (validated `@MinLength(32)` at boot). TTL `JWT_ACCESS_TTL`
  (short-lived; access-token revocation is intentionally not implemented — logout revokes the
  refresh token).
- **Pinned (Phase 14):** algorithm `HS256` on both sign and verify (`algorithms:['HS256']`), plus
  issuer `JWT_ISSUER` and audience `JWT_AUDIENCE` — a token minted with a different algorithm,
  issuer, or audience is rejected. Any verification failure → generic 401. Tenant/permission
  authority is re-validated server-side (the token is not trusted blindly).

## Refresh token
- Opaque `randomBytes(64)` (512-bit), **not** a JWT. Stored **only** as a SHA-256 hash (`@unique`);
  plaintext returned once, never persisted. Rotation via compare-and-swap; reuse detection revokes
  the whole chain; expiry/revocation/logout all reject.

## Passwords (ADR-0005)
- **Argon2id** hashing; verify is timing-safe (dummy verify when no hash). Policy: length 8–256 +
  common-password blocklist. Raw passwords never logged/stored/returned.
- **Change:** current password required; user comes from the JWT (cannot target another user);
  revokes **other** sessions, keeps current — atomic with rotation.
- **Reset:** opaque `randomBytes(48)` token, SHA-256 hash stored, single-use via CAS, 1-hour TTL;
  revokes **all** sessions; disabled accounts stay disabled.
- **Forgot:** always returns `202` regardless of whether the email exists (no enumeration); the
  notifier logs only `userId`, never the token.
- **Pinned (Phase 14):** Argon2id parameters are explicit — `memoryCost 65536` (64 MiB),
  `timeCost 3`, `parallelism 4` — so a library default change cannot silently weaken hashing.
- **Notifier:** the dev `LoggingPasswordResetNotifier` records only `userId`. Production MUST wire a
  real provider by overriding `PASSWORD_RESET_NOTIFIER` in `IdentityModule` (contract in
  `password-reset.notifier.ts`): deliver the token securely, never log/persist/return it, read
  provider credentials from secret management, and never let a delivery failure reveal account
  existence.

## Terminal / device (ADR-0004)
- Registration is a `TERMINAL_MANAGE` action; `tenantId` from context, not the body.
- Device fingerprints stored **only** as SHA-256 hashes, never raw, never logged.
- Session binding validates the terminal in-tenant + active, then mints `trm`; cross-tenant/unknown
  → 404, disabled/revoked → 403. Refresh keeps `trm` only while the terminal stays active.
- **Backlog:** status has no transition state-machine (`revoked→active` is currently allowed).

## Rate limiting & headers (ADR-0006)
- `AuthThrottlerGuard` on login/refresh/password-change/forgot/reset. Key = IP+email where present,
  else IP. Over-limit → 429. Configured by `AUTH_THROTTLE_TTL`/`AUTH_THROTTLE_LIMIT`.
- **Phase 14:** the throttle vars are **validated at boot** (invalid → fail fast) and the **code
  default is production-safe** (`10 / 60s`); development/test opt into a looser limit explicitly
  (`.env` / `test/setup-e2e.ts`). Tune the production limit via env.
- **Proxy trust:** `TRUST_PROXY` is unset by default → Express trusts **no** `X-Forwarded-*` header,
  so a client cannot spoof its source IP (which the limiter keys on). Behind a trusted proxy set
  `TRUST_PROXY` to a hop count (e.g. `1`), `true`, or a subnet.
- Helmet enabled (CSP disabled for Swagger). Global ValidationPipe: whitelist + forbidNonWhitelisted
  + transform.

## Audit trail (ADR-0007) — tamper-EVIDENT, not compliance-grade
- Per-tenant SHA-256 hash chain in `governance.audit_entries`; append-only for `ros_app`
  (UPDATE/DELETE/TRUNCATE revoked + no update/delete policy); sentinel tenant `000…0` for global
  auth events; metadata is allow-listed and secret-redacted.
- **Phase 14:** an internal `verifyAuditChain` utility (`audit-verify.ts`) recomputes and validates
  a tenant's chain (content tampering, broken linkage, sequence gaps) — used by tests/ops only,
  **not** exposed as an HTTP endpoint. A tamper-detection unit test now covers the property.
- **Accepted limitations (unchanged):** the verifier is not run in production automatically;
  best-effort (emit-after-commit) writes (a missing audit is possible, a false one is not);
  incomplete event coverage; single global sentinel chain is a throughput bottleneck; the DB
  owner/superuser can still rewrite the chain. Treat as tamper-evident, **not** compliance-grade.
