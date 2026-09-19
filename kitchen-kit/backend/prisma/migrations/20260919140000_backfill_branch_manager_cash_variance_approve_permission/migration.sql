-- CASH-VARIANCE-BRANCH-MANAGER-P0 — data backfill, no schema change.
--
-- The canonical Branch Manager role TEMPLATE
-- (`src/modules/identity/authz/canonical-role-templates.ts`) now grants
-- `cash.variance.approve` (FR-FIN-006 [M] — approval authority for an
-- above-tolerance cash-session close variance, checked by the Approval
-- Runtime against a separately PIN-verified approver). A template change
-- alone is provisioning-time-only (`ensureCanonicalRole` reconciles a role
-- only at signup, cashier auto-provision, or explicit reassignment — never
-- retroactively), so already-provisioned tenants' existing "Branch Manager"
-- rows need an explicit backfill, exactly the same category of gap already
-- fixed for `cash.session.close`/`close_other` by
-- `20260919130000_rls_aware_redeploy_backfill_branch_manager_cash_close_permissions`.
--
-- THIS MIGRATION IS RLS-AWARE, MIRRORING THAT PROVEN PATTERN EXACTLY
--
-- `identity.roles` has had RLS ENABLED since 20260812145207_identity_rls and
-- FORCE-enabled since 20260903100000_identity_roles_force_rls — FORCE means
-- even the table OWNER loses the normal RLS exemption; only an actual
-- superuser or a role carrying `BYPASSRLS` is exempt regardless. Production's
-- `prisma migrate deploy` connection is, per the 2026-08-25 P3018 incident and
-- the 2026-09-19 CASH-CLOSE-MIGRATION-RLS-ZERO-EFFECT-P0 investigation, most
-- likely NOT such a role, and `prisma migrate deploy` never sets any
-- `app.tenant_id`/`app.user_id` GUC. A plain, unscoped
-- `INSERT INTO identity.role_permissions ... SELECT ... FROM identity.roles`
-- would therefore match literally nothing under that connection — Postgres
-- would log `INSERT 0 0` as a fully successful statement with zero rows
-- affected.
--
-- This migration instead establishes its OWN tenant context per tenant, in
-- SQL, using the same primitive `PrismaService.withAuthContext` uses at the
-- application layer (`set_config('app.tenant_id', <uuid>, true)` —
-- transaction-local, discarded at COMMIT/ROLLBACK, never leaks). It
-- discovers tenants from `identity.tenants`, which has never had RLS enabled
-- at all — a caller must be able to resolve which tenant to scope into
-- before any tenant context exists — so no privilege beyond ordinary
-- `SELECT` is needed to enumerate them, under any role. This works
-- correctly under both a bypassing role (a superuser/BYPASSRLS: the extra
-- `set_config` calls and the explicit `r.tenant_id = t.id` filter are
-- harmless no-ops with respect to visibility) and a non-bypassing role
-- (production's, per the evidence above: the transaction-local
-- `app.tenant_id` is exactly what `roles_select`/`role_permissions_insert`'s
-- policies require to make that tenant's "Branch Manager" row visible and
-- writable).
--
-- Scope, deliberately narrow:
--  - Targets ONLY non-system roles literally named 'Branch Manager',
--    additionally filtered to the loop's own current tenant
--    (`r.tenant_id = t.id`) — belt-and-braces alongside the RLS policy
--    itself, never relying on RLS alone.
--  - ADDS exactly `cash.variance.approve` and nothing else. No UPDATE, no
--    DELETE — INSERT ... SELECT ... ON CONFLICT DO NOTHING only.
--  - Shift Supervisor, Cashier, Kitchen Staff, and any tenant-created custom
--    role are never referenced by this statement and are therefore
--    untouched, by construction (the `r.name = 'Branch Manager'` filter).
--  - Never touches `identity.membership_roles` — no assignment or scope is
--    created, widened, or otherwise changed.
--  - Idempotent per tenant, on the `(role_id, permission_id)` primary key —
--    a re-run is always a no-op the second time.
--  - Clears `app.tenant_id` back to empty at the end, as a courtesy for any
--    statement that might otherwise run later in the same session — but
--    correctness never depends on this: `set_config(..., true)` is already
--    transaction-local and is discarded at COMMIT regardless.

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM identity.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO identity.role_permissions (role_id, permission_id)
    SELECT r.id, p.id
    FROM identity.roles r
    CROSS JOIN identity.permissions p
    WHERE r.tenant_id = t.id
      AND r.name = 'Branch Manager'
      AND r.is_system = false
      AND p.code = 'cash.variance.approve'
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END $$;
