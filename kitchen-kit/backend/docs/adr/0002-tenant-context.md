# ADR 0002 — Tenant authorization context

- Status: Accepted
- Date: 2026-08-12
- Phase: 7

## Context

Phases 3–6 established a signed-JWT principal and permission resolution. Phase 7
needs a single, strongly-typed, server-derived authorization context that
downstream authorization (Phase 6 already) and PostgreSQL RLS (Phase 8) can
consume, without each module reconstructing `user → membership → tenant`.

## Decision

- **`TenantContext`** (`context/tenant-context.ts`): the validated tenant scope
  of a request — `userId`, `sessionId` (authentication identity), `tenantId`,
  `membershipId` (tenant authorization), optional `terminalId` (device identity),
  optional `branchId` (branch scope, **reserved/unpopulated** this phase).
- **`TenantContextService`** is the ONE resolver. `require(request)` validates
  and resolves **once per request**, memoized at `request.authorization`. A
  single query validates the membership (active, belongs to this user AND tenant,
  tenant active) and loads effective permissions together.
- **`TenantContextGuard`** establishes the context (403 if none/invalid);
  **`PermissionGuard`** consumes the memoized result (no second query);
  `@CurrentTenantContext()` / `@CurrentAuthorization()` inject it into handlers.
- The prior `AuthorizationService` was removed to avoid a second resolver.

### Where context is created / consumed

- **Created:** `TenantContextGuard` (or the first `PermissionGuard`) → calls
  `TenantContextService.require`, which derives context from the *signed* JWT
  principal and validates it against the DB. Nothing is read from client body,
  query, or `x-*` headers.
- **Consumed:** `PermissionGuard` (permission checks) and controllers (via the
  decorators). Services receive the `tenantId` as an explicit argument.

### Trust boundary

`tenantId`/`membershipId`/`userId` come only from the JWT (server-signed at login
/ tenant selection). Tampering the token fails signature verification → 401.
A well-formed token whose `mid` doesn't belong to `sub`+`tid`, or whose
membership/tenant is inactive, fails resolution → 403. Client `x-tenant-id`,
`x-membership-id`, body `tenantId`, and query `tenantId` are ignored (e2e-proven).

## Phase 8 (RLS) handoff — NOT implemented here

- **Source of tenant id:** `request.authorization.context.tenantId`.
- **How it will reach the DB:** Phase 8 adds a transactional helper (e.g.
  `PrismaService.withTenant(tenantId, fn)`) that opens a transaction and issues
  `SET LOCAL app.tenant_id = <tenantId>` as the first statement, then runs the
  tenant-scoped work on that same transaction/connection. `SET LOCAL` scopes the
  setting to the transaction only.
- **Leakage prevention:** context lives on the per-request `request` object
  (GC'd with the request) — no global mutable state, no `AsyncLocalStorage`, no
  connection/session-level PostgreSQL tenant state. `SET LOCAL` guarantees the
  tenant setting cannot survive the transaction and therefore cannot bleed into
  another pooled request.

## Branch scope

`branchId` is reserved but intentionally unpopulated: `tenantId != branchId`, and
a membership does not imply access to every branch. Branch-level authorization is
deferred until the org/branch context and the SRS branch rules are available.
