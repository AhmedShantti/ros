# ROS Authentication & Authorization — Developer Guide

Concise engineering docs for the identity/auth subsystem (Phases 1–12). ADRs in
`../adr/` are the authoritative decision records; this guide is the practical map.

## Subsystem map

| Concern | Code | ADR |
|---|---|---|
| Users + credentials (Argon2id) | `src/modules/identity/users`, `.../credentials` | 0001, 0005 |
| Login / access JWT / `/auth/me` | `.../auth` | 0001 |
| Refresh rotation / reuse detection / logout | `.../sessions`, `.../auth` | 0001 |
| Tenants / memberships / tenant selection | `.../tenants`, `.../memberships` | 0001 |
| RBAC (roles/permissions/guard) | `.../authz` | 0001 |
| Single TenantContext | `.../context` | 0002 |
| Row-Level Security | `src/prisma/prisma.service.ts`, migrations | 0003 |
| Terminal / device identity | `.../terminals` | 0004 |
| Password change/forgot/reset | `.../password`, `.../credentials` | 0005 |
| Rate limiting / security headers | `src/common/throttler`, `src/main.ts` | 0006 |
| Audit trail | `src/modules/governance/audit` | 0007 |

## Documents
- [authentication-flow.md](authentication-flow.md) — login, refresh, logout, tenant selection
- [authorization.md](authorization.md) — RBAC + TenantContext
- [tenant-isolation.md](tenant-isolation.md) — RLS, DB roles, transaction-local context
- [security.md](security.md) — JWT/refresh/password/terminal/rate-limit/audit + accepted limits
- [testing.md](testing.md) — running tests, the verification gate, migrations

## Core invariants (do not break)
- Users are **tenant-agnostic**; **membership** is the authorization boundary (no `users.tenant_id`).
- Tenant/permission identity is **never** trusted from client headers/body/query — only from the
  signed JWT (`tid/mid/trm`), and TenantContext **re-validates** it from the DB every request.
- Runtime connects as **`ros_app`** (NOSUPERUSER, NOBYPASSRLS); migrations as `ros_migrator`.
- RLS context is **transaction-local** (`set_config(..., true)`) and **fail-closed**.
- Secrets (passwords, token plaintext/hashes, JWT secret, DB creds, fingerprint hashes) are never
  logged, thrown, or returned.
