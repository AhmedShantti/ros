-- BRANCH-MANAGER-CASH-CLOSE-RLS-AWARE-MIGRATION-P0 — data backfill, no
-- schema change.
--
-- Both prior attempts at this exact backfill
-- (20260914120000_backfill_branch_manager_cash_close_permissions and
-- 20260919120000_redeploy_backfill_branch_manager_cash_close_permissions)
-- ran a plain, unscoped
--   INSERT INTO identity.role_permissions ... SELECT ... FROM identity.roles ...
-- with no `app.tenant_id` session context. `identity.roles` has had RLS
-- ENABLED since 20260812145207_identity_rls and FORCE-enabled since
-- 20260903100000_identity_roles_force_rls — FORCE means even the table
-- OWNER loses the normal RLS exemption; only an actual superuser or a role
-- carrying the `BYPASSRLS` attribute is exempt regardless. Production's
-- `prisma migrate deploy` connection is, per the 2026-08-25 P3018 incident
-- (`docs/reports/claude/2026-08-25_RENDER_identity-rls-default-privileges-unblock.md`
-- — it could not even `SET ROLE` to `ros_migrator`, let alone act as an
-- equivalent superuser), most likely NOT such a role. `prisma migrate
-- deploy` never sets any `app.tenant_id`/`app.user_id` GUC — it has no
-- concept of "tenant" at all — so under those conditions the prior
-- migrations' `SELECT ... FROM identity.roles` matched literally nothing:
-- Postgres correctly logs `INSERT 0 0` as a fully successful statement,
-- and Prisma has no way to know that "0 rows" was not the intended
-- outcome. Reproduced directly, locally, against this schema's real RLS
-- policies with the `ros_app` role and no context set — confirmed
-- `INSERT 0 0`; the identical statement with `app.tenant_id` set first
-- returns `INSERT 0 2` — see
-- `docs/reports/claude/2026-09-19_CASH-CLOSE-MIGRATION-RLS-ZERO-EFFECT-P0_investigation.md`.
--
-- THIS MIGRATION IS RLS-AWARE AND WORKS UNDER EITHER ROLE
--
-- Rather than depend on the executing role bypassing RLS (unverifiable
-- from this codebase, and evidently false in production), this migration
-- establishes its OWN tenant context per tenant, in SQL, using exactly the
-- mechanism `PrismaService.withAuthContext` already uses at the
-- application layer (`set_config('app.tenant_id', <uuid>, true)` —
-- transaction-local, discarded at COMMIT/ROLLBACK, never leaks). It
-- discovers tenants from `identity.tenants`, which has never had RLS
-- enabled at all (a caller must be able to resolve which tenant to scope
-- into before any tenant context exists) — so no privilege beyond ordinary
-- `SELECT` is needed to enumerate them, under any role.
--
--  - For a role that DOES bypass RLS (a genuine superuser, or `BYPASSRLS`):
--    the extra `set_config` calls and the explicit `r.tenant_id = t.id`
--    filter are harmless no-ops with respect to visibility — the role
--    already saw everything — and the explicit per-tenant filter still
--    keeps each iteration's INSERT correctly scoped to exactly one tenant
--    (never a behavioural difference from the prior migrations' end
--    result on such a role).
--  - For a role that does NOT bypass RLS (production's, per the evidence
--    above): the transaction-local `app.tenant_id` set immediately before
--    each tenant's INSERT is exactly what `roles_select` and
--    `role_permissions_insert`'s policies require to make that tenant's
--    "Branch Manager" row (and only that tenant's) visible/writable — this
--    is the one thing the prior two migrations omitted.
--
-- Scope, deliberately as narrow as the prior two migrations — unchanged:
--  - Targets ONLY non-system roles literally named 'Branch Manager',
--    additionally filtered to the loop's own current tenant
--    (`r.tenant_id = t.id`) — belt-and-braces alongside the RLS policy
--    itself, never relying on RLS alone.
--  - ADDS exactly `cash.session.close` and `cash.session.close_other` and
--    nothing else. No UPDATE, no DELETE — INSERT ... SELECT ... ON
--    CONFLICT DO NOTHING only.
--  - Never touches `identity.membership_roles` — no assignment or scope is
--    created, widened, or otherwise changed.
--  - Idempotent per tenant, per code, on the `(role_id, permission_id)`
--    primary key — a re-run (of this migration, or a future replay of an
--    equivalent statement) is always a no-op the second time.
--  - Clears `app.tenant_id` back to empty at the end, as a courtesy for
--    any statement that might otherwise run later in the same session —
--    but correctness never depends on this: `set_config(..., true)` is
--    already transaction-local and is discarded at COMMIT regardless.

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
      AND p.code IN ('cash.session.close', 'cash.session.close_other')
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END $$;
