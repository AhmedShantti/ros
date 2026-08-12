# ADR 0005 — Password change / reset lifecycle

- Status: Accepted
- Date: 2026-08-12
- Phase: 10
- Deciders: Product owner (ratified interactively)

## Context

Phase 10 adds authenticated password change and the forgot/reset flow. The
approved schema has no reset-token table and the SRS text is unavailable, so the
security-sensitive session/credential decisions were ratified explicitly.

## Decisions

### Hashing
Continue Argon2id with the existing library defaults (64 MB / t=3 / p=4). No
bcrypt/PBKDF2. Credential rotation reuses `CredentialsService.rotatePassword`
(in-place update of the single password credential — no duplicate credentials).

### Session revocation (ratified)
- **Password CHANGE** → revoke all **OTHER** sessions; keep the current session.
  (User proved the current password; they stay logged in here, logged out
  everywhere else.)
- **Password RESET** → revoke **ALL** sessions (including terminal-bound). Reset
  is credential-compromise recovery; every existing session and refresh-token
  chain is invalidated. The user re-authenticates with the new password.

Both run atomically with the credential rotation in one Prisma transaction. The
existing refresh-token rotation/reuse-detection and session-lineage model are
untouched (revocation just sets `revoked_at`).

### must_reset (ratified: informational)
Surfaced in `/auth/me` (`mustReset`), cleared on any successful change/reset
(via `rotatePassword`). **Not enforced as a gate** this phase (no endpoint
gating). Setting it true is an admin/forced-reset trigger that awaits SRS
definition; deferred.

### Reset-token architecture
New `identity.password_reset_tokens` (`id`, `user_id`, `token_hash`,
`expires_at`, `consumed_at`, `created_at`). Opaque `randomBytes(48)` token;
**only the SHA-256 hash is stored** (raw never persisted/logged/returned).
Single-use + expiry (1 hour) enforced by an **atomic compare-and-swap consume**
(`updateMany ... WHERE id=? AND consumed_at IS NULL AND expires_at > now`) →
concurrent uses of the same token yield exactly one success. Not a JWT. Global
identity data (users are tenant-agnostic, ADR 0001) → **not RLS-scoped**, like
users/credentials/sessions; `ros_app` granted DML.

### Enumeration safety
`POST /auth/password/forgot` always returns a generic `202`; a token is issued
only for an **active** account. Known/unknown/disabled accounts are externally
indistinguishable. A disabled account cannot regain access (login still checks
status). Delivery is via an injectable `PasswordResetNotifier` port (default logs
without the token; email infra deferred) so the raw token reaches exactly one
seam.

### Error semantics
Change: 401 (wrong current password / missing token), 403 (inactive account).
Reset: 204 success; 401 for invalid/expired/consumed/unknown token; 400 for a
malformed token (DTO). Forgot: 202 always.

## Consequences
- Rate limiting (Phase 11) can throttle the three distinct endpoints without
  response-shape changes.
- No new credential model; no change to the JWT/refresh architecture.
