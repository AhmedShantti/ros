-- ============================================================================
-- Phase 8 — PostgreSQL Row-Level Security for the identity tenant-scoped tables.
--
-- Runtime role: ros_app (NOSUPERUSER, NOBYPASSRLS). Owner/migration role:
-- ros_migrator. Tenant context is transaction-local:
--   set_config('app.tenant_id', <uuid>, true)   -- true = SET LOCAL (per-tx)
--   set_config('app.user_id',   <uuid>, true)
-- Both are read via NULLIF(current_setting(<key>, true), '')::uuid so that a
-- missing/empty context yields NULL → the predicate is false → FAIL CLOSED.
--
-- Only two identity tables carry a direct tenant_id (memberships, roles); their
-- child join tables inherit the boundary through the parent (no tenant_id added,
-- per the approved design / ADR 0001). See docs/adr/0003-rls.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Runtime role privileges. ros_app has no table privileges yet (the app ran as
-- ros_migrator until now). Grant DML on existing identity tables. No DDL/owner
-- rights.
--
-- NOTE: the `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator ...` statement that
-- previously followed here was removed for Render deployment compatibility:
-- the connecting migration role there is not, and cannot SET ROLE to,
-- ros_migrator, so the statement fails with 42501 (permission denied to
-- change default privileges). Default privileges only govern objects created
-- by ros_migrator AFTER this migration runs; existing tables already have the
-- explicit GRANT above. See docs/reports/claude/ for the deployment-unblock
-- report covering this change.
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA identity TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO ros_app;

-- ----------------------------------------------------------------------------
-- memberships — tenant-scoped, with a user-scoped SELECT exception so a user can
-- discover the tenants they belong to BEFORE selecting one (GET /auth/tenants).
-- Reads: tenant OR own-user. Writes (INSERT/UPDATE/DELETE): tenant only — a user
-- can never create/modify a membership in an arbitrary tenant via user_id.
-- FORCE: the app never writes memberships as the table owner; enforce for all.
-- ----------------------------------------------------------------------------
ALTER TABLE identity.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_select ON identity.memberships FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY memberships_insert ON identity.memberships FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY memberships_update ON identity.memberships FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY memberships_delete ON identity.memberships FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- roles — tenant-owned roles are isolated; system roles (tenant_id NULL,
-- is_system) are readable by every tenant but writable only by the owner
-- (ros_migrator, which bypasses RLS because the table is ENABLE but not FORCE).
-- Tenant admins (ros_app) can only write roles in their own tenant.
-- ----------------------------------------------------------------------------
ALTER TABLE identity.roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY roles_select ON identity.roles FOR SELECT
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR is_system
  );
CREATE POLICY roles_insert ON identity.roles FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY roles_update ON identity.roles FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY roles_delete ON identity.roles FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- role_permissions — inherited through the parent role. Read follows role read
-- (tenant OR system); writes only for roles in the current tenant. ENABLE (not
-- FORCE) so ros_migrator can seed system-role permissions.
-- ----------------------------------------------------------------------------
ALTER TABLE identity.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY role_permissions_select ON identity.role_permissions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM identity.roles r
    WHERE r.id = role_id
      AND (r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR r.is_system)
  ));
CREATE POLICY role_permissions_insert ON identity.role_permissions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM identity.roles r
    WHERE r.id = role_id
      AND r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
CREATE POLICY role_permissions_delete ON identity.role_permissions FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM identity.roles r
    WHERE r.id = role_id
      AND r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- ----------------------------------------------------------------------------
-- membership_roles — inherited through the parent membership. Read follows the
-- membership read (tenant OR own-user); writes only within the current tenant.
-- FORCE (no owner runtime writes).
-- ----------------------------------------------------------------------------
ALTER TABLE identity.membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.membership_roles FORCE ROW LEVEL SECURITY;

CREATE POLICY membership_roles_select ON identity.membership_roles FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM identity.memberships m
    WHERE m.id = membership_id
      AND (m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  ));
CREATE POLICY membership_roles_insert ON identity.membership_roles FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM identity.memberships m
    WHERE m.id = membership_id
      AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
CREATE POLICY membership_roles_delete ON identity.membership_roles FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM identity.memberships m
    WHERE m.id = membership_id
      AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
