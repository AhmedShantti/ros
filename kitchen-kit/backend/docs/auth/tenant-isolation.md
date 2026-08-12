# Tenant Isolation — PostgreSQL Row-Level Security

## Database roles
- **`ros_migrator`** — owner/superuser. Runs migrations & the Prisma CLI (`DATABASE_URL`).
  Legitimately bypasses RLS to seed system roles.
- **`ros_app`** — `NOSUPERUSER`, `NOBYPASSRLS`. The **only** runtime connection
  (`APP_DATABASE_URL`). FORCE RLS genuinely applies to it. No runtime code reads the migrator URL.

## Transaction-local context (`PrismaService.withAuthContext`)
```ts
this.$transaction(async (tx) => {
  await tx.$queryRawUnsafe(
    "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)",
    scope.userId ?? '', scope.tenantId ?? '',
  );
  return fn(tx);            // same connection, same transaction
});
```
- The `true` third arg = `SET LOCAL` semantics — the setting is discarded at COMMIT/ROLLBACK, so
  it **cannot leak** to a later request on a pooled connection.
- Missing context → `''` → `NULLIF(current_setting('app.tenant_id',true),'')::uuid` → NULL → every
  policy predicate is false ⇒ **fail-closed** (no rows read, no writes accepted).
- Nested `withAuthContext` is unsupported (Prisma has no nested interactive tx); calls are sequential.

## Policy pattern
```sql
ENABLE ROW LEVEL SECURITY;  FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>_select ON <t> FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY <t>_insert ON <t> FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

## Which tables are RLS-scoped
- **Scoped + FORCE:** `memberships`, `membership_roles`, `terminals`, `device_fingerprints`,
  `governance.audit_entries`. (`memberships` also allows `user_id = app.user_id` so a user can
  discover their own tenants before selecting one.)
- **Scoped, ENABLE-not-FORCE:** `roles`, `role_permissions` — intentional, so `ros_migrator` seeds
  system roles; safe because `ros_app` is NOBYPASSRLS.
- **Not scoped (tenant-agnostic/global by design):** `users`, `credentials`, `sessions`,
  `password_reset_tokens`, `permissions`, `tenants`. Isolation for these is app-layer (queries keyed
  by `user_id` / `token_hash`).

## Guarantees (all e2e-verified)
Cross-tenant SELECT/INSERT/UPDATE/DELETE are blocked; INSERT-spoofing another tenant is denied;
no context → zero rows; context never leaks across pooled connections; concurrent A/B contexts
never cross-contaminate.
