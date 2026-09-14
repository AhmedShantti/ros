-- DEMO-CASH-AUTH-FINAL-GAP-P0 — data backfill, no schema change.
--
-- a47b582 fixed BRANCH_MANAGER_PERMISSION_CODES in
-- canonical-role-templates.ts (and seed-dev-data.ts) to include
-- cash.session.close / cash.session.close_other. That fix is
-- provisioning-time policy only: it is read by RegistrationsService.register
-- and ensureCanonicalRole() when a tenant's canonical roles are first
-- materialised into identity.roles/identity.role_permissions, or when an
-- admin re-assigns that named role to an employee (the existing
-- DEMO-OPS-HOTFIX-2 self-heal in ensureCanonicalRole). The live
-- authorization path (ScopeAuthorizationService / PermissionGuard, via
-- TenantContextService) never reads the template code — it reads whatever
-- RolePermission rows already exist for a Role, per request. So any tenant
-- whose "Branch Manager" role was already written to the database before
-- this migration will NOT gain the two permissions on its own; this backfill
-- is what repairs those already-existing rows.
--
-- Scope, deliberately narrow:
--  - Targets ONLY non-system roles literally named 'Branch Manager' — the
--    same name match canonicalRoleKeyForName() already uses to self-heal on
--    the next role (re)assignment. The schema has no dedicated "this is a
--    canonical role" flag (canonical-role-templates.ts's own docblock notes
--    this), so name match is the same signal the application already trusts.
--  - ADDS exactly the two missing permission codes and nothing else. Never
--    removes or replaces a permission a tenant may have added or removed on
--    their own "Branch Manager"-named role — Cashier and every other role
--    are untouched (excluded by the name filter).
--  - Touches only identity.role_permissions join rows; never inserts or
--    updates an identity.membership_roles row, so no assignment's scope
--    (tenant/brand/branch) is created or widened — no cross-branch authority
--    is granted by this migration.
--  - Idempotent: ON CONFLICT DO NOTHING on the (role_id, permission_id)
--    primary key, so a re-run — or Prisma replaying this file — is always a
--    no-op the second time. Verified directly against a live copy of this
--    schema (inserted a synthetic Branch Manager role with a pre-existing
--    permission, ran this statement twice, rolled back): first run adds
--    exactly the two missing codes and leaves the pre-existing one intact;
--    second run inserts zero rows; an unrelated 'Cashier' role in the same
--    tenant is untouched throughout.
--  - ros_migrator (the role every `prisma migrate` runs as) is a PostgreSQL
--    superuser and unconditionally bypasses row-level security, so this
--    statement needs no app.tenant_id session context to see every tenant's
--    rows (identity.roles has FORCE ROW LEVEL SECURITY since
--    20260903100000_identity_roles_force_rls, which is exactly the case that
--    migration proved does not affect ros_migrator).

INSERT INTO identity.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM identity.roles r
CROSS JOIN identity.permissions p
WHERE r.name = 'Branch Manager'
  AND r.is_system = false
  AND p.code IN ('cash.session.close', 'cash.session.close_other')
ON CONFLICT (role_id, permission_id) DO NOTHING;
