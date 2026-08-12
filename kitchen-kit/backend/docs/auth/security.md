# Security Notes

## JWT (access token)
- Payload = IDs only: `sub, sid`, optional `tid, mid, trm`, `iat/exp`. No password/refresh/secret.
- Symmetric secret `JWT_ACCESS_SECRET` (validated `@MinLength(32)` at boot). TTL `JWT_ACCESS_TTL`.
- Any verification failure → generic 401. Tenant/permission authority is re-validated server-side
  (the token is not trusted blindly).
- **Hardening backlog:** pin `algorithms:['HS256']` on verify + `algorithm` on sign; add
  issuer/audience.

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
- **Hardening backlog:** pin Argon2 `memoryCost/timeCost/parallelism`; ship a real notifier.

## Terminal / device (ADR-0004)
- Registration is a `TERMINAL_MANAGE` action; `tenantId` from context, not the body.
- Device fingerprints stored **only** as SHA-256 hashes, never raw, never logged.
- Session binding validates the terminal in-tenant + active, then mints `trm`; cross-tenant/unknown
  → 404, disabled/revoked → 403. Refresh keeps `trm` only while the terminal stays active.
- **Backlog:** status has no transition state-machine (`revoked→active` is currently allowed).

## Rate limiting & headers (ADR-0006)
- `AuthThrottlerGuard` on login/refresh/password-change/forgot/reset. Key = IP+email where present,
  else IP. Over-limit → 429. Configured by `AUTH_THROTTLE_TTL`/`AUTH_THROTTLE_LIMIT`.
- **Defaults are lenient (60000ms / 50) — production MUST tighten** (≈5–10 / 60s) and set Express
  `trust proxy` so `req.ip` is correct behind a proxy.
- Helmet enabled (CSP disabled for Swagger). Global ValidationPipe: whitelist + forbidNonWhitelisted
  + transform.

## Audit trail (ADR-0007) — tamper-EVIDENT, not compliance-grade
- Per-tenant SHA-256 hash chain in `governance.audit_entries`; append-only for `ros_app`
  (UPDATE/DELETE/TRUNCATE revoked + no update/delete policy); sentinel tenant `000…0` for global
  auth events; metadata is allow-listed and secret-redacted.
- **Accepted limitations:** no production chain verifier; best-effort (emit-after-commit) writes
  (a missing audit is possible, a false one is not); incomplete event coverage; single global
  sentinel chain is a throughput bottleneck; the DB owner/superuser can rewrite the chain. Treat as
  tamper-evident, **not** compliance-grade.
