-- BRANCH-MANAGER-CASH-CLOSE-DEPLOY-MIGRATION-P0 — data backfill, no schema
-- change. Byte-for-byte the same statement as
-- 20260914120000_backfill_branch_manager_cash_close_permissions, re-applied
-- as a NEW migration because live proof shows the live database still
-- lacks these two grants on the "Branch Manager" role despite that earlier
-- migration already being present in the deployed source tree (confirmed
-- an ancestor of, and physically present at, the live backend SHA —
-- 2026-09-19_CASH-CLOSE-BACKFILL-DEPLOYMENT-TRUTH-P0_investigation.md).
--
-- Live reproduction (2026-09-19): `manager001` holds the exact canonical
-- role name "Branch Manager", correctly scoped to the "Main" branch, can
-- open/use a cash session (`cash.session.open` present), but their own
-- `GET /cash-sessions/{id}/close-context` still 403s "Insufficient
-- permission for this scope." — the live symptom the 2026-09-14 migration
-- was already supposed to have repaired.
--
-- WHY A SECOND MIGRATION, NOT A RE-RUN OF THE FIRST
-- Prisma tracks applied migrations by directory name in its own
-- `_prisma_migrations` table — replaying an already-recorded migration's
-- file is not something `prisma migrate deploy` does. Whatever the exact
-- reason the 2026-09-14 migration's effect is not visible on the live
-- database today (an earlier migration-chain stall of the kind
-- `2026-08-25_RENDER_identity-rls-default-privileges-unblock.md` already
-- documented once in this project, a deploy that ran an older build,
-- or some other drift this session cannot observe without Render Shell or
-- production DB access), a NEW migration is the only vehicle that is
-- GUARANTEED to actually execute on the next `prisma migrate deploy` —
-- the same deploy step every previous migration, including the one this
-- repeats, already relies on (confirmed to run in production by the
-- 2026-08-25 incident above).
--
-- The general, template-driven backfill mechanism (`ded6dd6`,
-- `reconcileExistingCanonicalRoles` / `backfill-canonical-role-permissions.ts`)
-- is NOT replaced or altered by this migration — it remains the right tool
-- for reconciling ANY canonical role's ANY missing code once it can
-- actually be invoked (a Render Shell, or an equivalent one-off job
-- runner). This migration exists ONLY because that invocation path is
-- unavailable today, and a schema migration is the one mechanism that
-- deploys unconditionally, without needing shell access, as part of the
-- existing pipeline.
--
-- Scope, deliberately narrow — identical to the 2026-09-14 migration:
--  - Targets ONLY non-system roles literally named 'Branch Manager'.
--  - ADDS exactly `cash.session.close` and `cash.session.close_other` and
--    nothing else. Never removes or replaces any permission a tenant may
--    have added or removed on their own "Branch Manager"-named role — a
--    custom, differently-named role is untouched (excluded by the name
--    filter), and no OTHER canonical role (Cashier, Shift Supervisor,
--    Kitchen Staff) is touched either.
--  - Touches only `identity.role_permissions` join rows; never inserts,
--    updates, or deletes an `identity.membership_roles` row, so no
--    assignment's scope (tenant/brand/branch) is created, widened, or
--    otherwise changed — no cross-branch authority is granted by this
--    migration.
--  - No UPDATE, no DELETE — INSERT ... SELECT ... ON CONFLICT DO NOTHING
--    only.
--  - Idempotent: `ON CONFLICT (role_id, permission_id) DO NOTHING` on the
--    primary key, so a re-run (or a second deploy that somehow replays it)
--    is always a no-op, whether or not the two codes are already present
--    from the 2026-09-14 migration, from `ded6dd6`'s general backfill
--    (once it CAN be run), or from ordinary provisioning.
--  - `ros_migrator` (the role every `prisma migrate` runs as) is a
--    PostgreSQL superuser and unconditionally bypasses row-level security,
--    so this statement needs no `app.tenant_id` session context to see
--    every tenant's rows (`identity.roles` has FORCE ROW LEVEL SECURITY
--    since `20260903100000_identity_roles_force_rls`, which is exactly the
--    case that migration proved does not affect `ros_migrator`).

INSERT INTO identity.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM identity.roles r
CROSS JOIN identity.permissions p
WHERE r.name = 'Branch Manager'
  AND r.is_system = false
  AND p.code IN ('cash.session.close', 'cash.session.close_other')
ON CONFLICT (role_id, permission_id) DO NOTHING;
