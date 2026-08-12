# ADR 0007 — Security audit trail (governance.audit_entries)

- Status: Accepted
- Date: 2026-08-12
- Phase: 12
- Deciders: Product owner (sentinel-tenant decision ratified interactively)

## Context

Formal, tamper-evident audit for identity/auth security events, using the
approved `governance.audit_entries` (tenant-scoped, per-tenant hash chain,
append-only). The identity model (ADR 0001) is tenant-agnostic, so core auth
events (login/logout/refresh/password) have no tenant, conflicting with
`tenant_id NOT NULL` and the per-tenant chain.

## Decisions

### Sentinel platform tenant (ratified)
Global/anonymous identity-auth events use the reserved tenant
`00000000-0000-0000-0000-000000000000`. They form one "platform" hash chain;
tenant-scoped events (tenant-selected, role-assigned, terminal-registered) chain
under their real tenant. **Zero schema deviation** — `tenant_id` stays NOT NULL,
the per-tenant `UNIQUE (tenant_id, sequence_no)` and chain are unchanged, and RLS
naturally hides the platform chain from real tenants (no membership).

### Hash chain
Per tenant: `sequence_no` is monotonic from 1; `previous_hash` = the prior
entry's `entry_hash`; `entry_hash` = SHA-256 over a **stable canonical**
representation (`stableStringify`, recursively sorted keys — not iteration-order
dependent) of the entry's meaningful fields plus `previous_hash`. Sensitive
values are never in the hashed payload. **Concurrency:** a per-tenant
transaction advisory lock (`pg_advisory_xact_lock('ros_audit', tenant)`,
DB-global across processes) serializes chain writers, so `sequence_no` /
`previous_hash` cannot race; `UNIQUE (tenant_id, sequence_no)` is the backstop.

### Append-only enforcement
`ros_app` is granted only `SELECT, INSERT`; `UPDATE/DELETE/TRUNCATE` are
`REVOKE`d, and RLS has no update/delete policy. Enforced at BOTH the grant and
RLS layers (e2e-verified: `ros_app` UPDATE/DELETE reject). Tenant isolation via
`app.tenant_id` (Phase 8 model), so no cross-tenant read.

### Actor & tenancy
The actor comes only from the validated principal/TenantContext — never client
body/query/headers. Anonymous events (failed login) use `actor_type=anonymous`,
`actor_id=null` (no fake ids, no email stored → enumeration-safe). Runtime is
`ros_app` (no migrator/BYPASSRLS path).

### Metadata safety
Metadata is built explicitly (allow-listed) by callers; the writer additionally
**redacts secret-looking keys** (`sanitizeMetadata`). Whole request/DTO/principal
objects are never serialized. Never stores password/hash/token/reset-token/
Authorization/cookie/raw fingerprint (e2e-scanned).

### Transaction model
Two APIs: `record(tx, event)` (mandatory — composes into a caller's tenant-scoped
transaction; for future business domains) and `emit(event)` (own
`withAuthContext` transaction; **best-effort** — a failure is logged, never
turning a successful operation into a failure). Phase-12 identity events use
`emit` because the audited operations span different tenant-context scopes and
the audit table is tenant-scoped (needs its own `app.tenant_id`); the operation
is the source of truth, the audit is written immediately after it is durable.

## Event taxonomy (wired)
LOGIN_SUCCESS, LOGIN_FAILURE, LOGOUT, REFRESH_REUSE_DETECTED (sentinel);
TENANT_SELECTED, ROLE_ASSIGNED, TERMINAL_REGISTERED (real tenant);
PASSWORD_CHANGED, PASSWORD_RESET_REQUESTED, PASSWORD_RESET_COMPLETED (sentinel).

## Consequences / limitations
- This covers currently-implemented identity/auth security operations; business
  domains reuse `AuditService.record`/`emit`.
- `emit` is best-effort (not same-transaction) — documented above; strict
  in-transaction auditing uses `record`.
- `correlation_id` is per-event (a request-correlation middleware can tie related
  events later). Not-yet-wired events (e.g. ROLE_CREATED, PERMISSION_*,
  TERMINAL_STATUS_CHANGED, REFRESH_SUCCESS) are supported by the infra and can be
  added without changes.
