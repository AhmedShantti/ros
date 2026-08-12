# ADR 0004 — Terminal / device identity

- Status: Accepted
- Date: 2026-08-12
- Phase: 9

## Context

Terminals are the POS security boundary (authentication, session binding, future
offline/sync). The approved schema defines `identity.terminals` and
`identity.device_fingerprints`, and `session.terminal_id`. The SRS text is not in
the repo, so activation/pairing and the status state machine are not fully
specified. Per the phase brief ("minimum-safe + document; do not invent
activation/branch semantics"), the following decisions were made.

## Decisions

### Data model (approved schema + minimal, documented additions)
- `terminals`: `tenant_id`, `branch_id` (both required), `name`, `terminal_type`
  (`pos/kds/kiosk/handheld`), `status`, `last_seen_at`, `created_at`. Added a
  `@@unique(tenant_id, branch_id, name)` to make duplicate registration a 409.
- `device_fingerprints`: `terminal_id`, **`fingerprint_hash`** (SHA-256 of the
  raw value — raw never stored/logged), `os`, `app_version`, `registered_at`.
  Added `@@unique(terminal_id, fingerprint_hash)` for idempotent registration.
- `session.terminal_id` → FK to `terminals` (SET NULL).
- IDs are ULID-as-UUID (unchanged strategy).

### Lifecycle (minimum-safe)
`TerminalStatus = active | disabled | revoked`. The SQL only defined a default of
`active`; these values are derived from the security requirements. Only `active`
terminals can be bound to a session.

### Activation / pairing — DEFERRED
The approved schema has **no** activation/pairing token table. No activation
flow, QR, or PIN is invented. Registration is a server-controlled admin action
(create terminal + optional device fingerprint). Activation/pairing awaits the
SRS.

### Branch authorization — DEFERRED
`branch_id` is required and recorded, and terminals are tenant-isolated, but
**branch-level authorization is not enforced** (no branch-membership model
exists; the org context is unbuilt). A tenant admin manages all terminals in
their tenant regardless of branch. To be revisited when the org/branch context
and SRS branch rules exist. `branch_id` is not a client-overridable authorization
field today.

### Session ↔ terminal binding
`POST /auth/terminal` binds the caller's current (tenant-scoped) session to a
terminal validated server-side against the trusted TenantContext: cross-tenant
terminal → 404 (invisible under RLS); disabled/revoked → 403. The bound terminal
is minted into the access token as `trm`; the JwtAuthGuard lifts it into
`principal.terminalId`. **Only POS/terminal sessions carry `trm`** — normal
web/admin tokens do not. Refresh preserves `trm` only while the terminal remains
active (revoked/disabled terminals drop from the refreshed token). Existing
tokens remain valid until expiry (≤15m) — consistent with the short-token model
(immediate revocation deferred to Phase 14).

### RBAC
Two identity-domain permissions: `identity.terminal.read`,
`identity.terminal.manage`. (The business permission catalogue is still absent;
these follow the Phase 6 convention and are guarded by the existing
PermissionGuard — no second mechanism.) Session binding requires tenant context
but no special permission (self-service, like tenant selection).

### RLS (Phase 8 model)
- `terminals` (direct `tenant_id`): ENABLE+FORCE; per-op policies keyed on
  `app.tenant_id`.
- `device_fingerprints` (inherited via terminal): ENABLE+FORCE; SELECT/INSERT/
  DELETE via `EXISTS (terminal t: t.tenant_id = app.tenant_id)`. **Append-only**
  (no UPDATE policy) — re-registration is check-then-create idempotent.
- All terminal queries run as `ros_app` through `withAuthContext`. No migrator
  runtime path.

## Audit
Terminal operations are structured to be auditable later (register/status/bind).
Formal `governance.audit_entries` integration remains the audit phase; no second
audit mechanism is introduced here.

## Deviations from approved SQL
- Added two unique constraints (terminal name per branch; fingerprint per
  terminal) — safety/idempotency; documented above.
- Introduced `TerminalStatus`/`TerminalType` enums (SQL used `VARCHAR`).
