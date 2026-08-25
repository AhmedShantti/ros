# Render Deployment Unblock — `ALTER DEFAULT PRIVILEGES` (42501/P3018) removed from 6 migrations

**Report type:** Deployment-blocker correction report (migration edits only — no implementation, no schema redesign)
**Authority statement:** This report is non-authoritative evidence. The SRS and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority for requirements and architecture decisions. Nothing in this document creates, amends, or ratifies governance.
**Date:** 2026-08-25
**HEAD:** `cf04e008a35ba421b23b96b5fa6221a8dae5da12` (unchanged, no commit made)
**Branch:** `feat/production-spec`
**Working tree summary:** six migration files modified (see §2); all other working-tree changes present at task start are pre-existing and untouched by this task
**Task identifier:** Render production deploy unblock. Initial scope was the `identity_rls` migration's `ALTER DEFAULT PRIVILEGES` statement only; investigation found the identical failure pattern in 5 further already-committed migrations, and the user explicitly approved (via in-session confirmation, see §5) extending the same narrow removal to all 6 so the deploy chain actually completes. P1F-2/Completion/Inventory/COGS, database redesign, and all other migrations remain explicitly out of scope.

---

## 1. Root cause confirmed

`prisma/migrations/20260812145207_identity_rls/migration.sql` (as committed at `cf04e00`) contained, immediately after the two `GRANT` statements at lines 21–22:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;
```

`ALTER DEFAULT PRIVILEGES FOR ROLE <x>` requires the executing session to either **be** role `x`, be a superuser, or hold membership in role `x` with `SET`/inherited privilege sufficient to assume it. On Render, the role that runs `prisma migrate deploy` is not, and cannot `SET ROLE` to, `ros_migrator` — so PostgreSQL raises `42501 permission denied to change default privileges`, which Prisma surfaces as `P3018`.

This statement is the **only** statement in the migration requiring that elevated relationship. All other statements (`GRANT USAGE`, `GRANT ... ON ALL TABLES`, `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY`, all eight `CREATE POLICY` statements) operate on objects the connecting role already owns or has ordinary grant authority over, and do not require role-assumption privileges. Confirmed by inspecting the full file (123 lines) — no other statement in this migration touches role privileges.

## 2. Changes made — 6 files, 6 statements removed

`grep -rn "ALTER DEFAULT PRIVILEGES" prisma/migrations/` found the pattern `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA <x> GRANT ... ON TABLES TO ros_app;` as an **executable** statement in 5 migrations besides `identity_rls`, all already committed and none yet applied on Render (all chronologically after the failing `identity_rls` migration, so none had run). With the user's explicit approval to apply the same narrow removal everywhere the pattern appears (see §5), all 6 occurrences across 6 files were removed:

| File | Schema(s) | Occurrences removed |
|---|---|---|
| `20260812145207_identity_rls/migration.sql` | `identity` | 1 |
| `20260812175712_governance_audit_entries/migration.sql` | `governance` | 1 |
| `20260816110000_organisation_foundation/migration.sql` | `org`, `kitchen` | 2 |
| `20260816150000_catalogue_foundation/migration.sql` | `catalogue` | 1 |
| `20260816210000_inventory_foundation/migration.sql` | `inventory` | 1 |

**Exact SQL removed (6 statements total, one shape, schema/privilege list varies):**
```sql
-- identity_rls
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;

-- governance_audit_entries
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "governance"
  GRANT SELECT, INSERT ON TABLES TO ros_app;

-- organisation_foundation (two statements)
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "org"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "kitchen"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;

-- catalogue_foundation
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "catalogue"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;

-- inventory_foundation
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "inventory"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;
```

**Preserved unchanged in every file:** every `GRANT USAGE`/`GRANT ... ON ALL TABLES`/explicit per-table `GRANT`, every `REVOKE` (e.g. governance's append-only `REVOKE UPDATE, DELETE, TRUNCATE`), every `ENABLE`/`FORCE ROW LEVEL SECURITY`, and every `CREATE POLICY` statement — none were touched, reordered, or reworded. Each removed statement was replaced with a short comment explaining the removal (same wording pattern each time) so the migration history stays legible; no other line in any of the 6 files changed. `prisma/schema.prisma` was not touched, and no new migration was created.

## 3. Nothing else modified

`git status` before and after this task confirms the only modifications under `prisma/` are these 6 files. The other pre-existing working-tree changes (`.gitignore`, `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, `docs/reports/claude/INDEX.md`, `src/main.ts`, `src/scripts/seed-dev-data.ts`, and the several untracked P1F-2 gate reports) all predate this task and were left untouched, per the user's "unrelated migrations / no new features" scope.

## 4. Validation performed (no production database touched)

1. **Full migration-chain replay against a disposable, isolated container** (run twice — once after the first `identity_rls`-only edit, once again after all 6 edits) — started a throwaway `postgres:16` Docker container (port 5599, removed after each use), bootstrapped with the same `docker/postgres/init/01-init-app-role.sh` role-setup script the project's normal local dev DB uses, then ran `npx prisma migrate deploy` against it. All 27 migrations applied cleanly both times, with **zero errors**: `All migrations have been successfully applied.` The existing local dev container (`ros-postgres`, 9 days up) was never touched by either run.
2. **Privilege-matrix check after the final 27-migration replay** — queried `has_table_privilege('ros_app', <table>, <priv>)` for every table in all 6 edited schemas (`identity`, `governance`, `org`, `kitchen`, `catalogue`, `inventory`). Every one of the 70 tables across those schemas has `SELECT`+`INSERT` at minimum, and every table has the exact `UPDATE`/`DELETE` shape the migration comments describe (e.g. `governance.audit_entries` and `inventory.stock_movements`/its 13 range partitions are `SELECT,INSERT` only — deliberate append-only ledgers, explicitly `REVOKE`d, unrelated to this change). No table was found with zero privileges — i.e. no table in any of the 6 schemas actually depended on the removed `ALTER DEFAULT PRIVILEGES` statement; every one already has its own explicit `GRANT`, confirmed by inspection of `identity_terminals`, `org_location_registry`, and `kds_station_routing_hardening` (three later migrations whose own comments *mention* the removed default-privileges mechanism but each already grants explicitly — "self-contained on a clean database" is each one's own stated intent). Their comments are now slightly stale (they reference a mechanism that no longer exists) but functionally inert; left unedited since they are outside the 6 files in scope and the migrations remain correct without change.
3. **`npx prisma generate`** — succeeded (Prisma Client 7.9.1), both before and after the full 6-file edit.
4. **`npm run build`** (`nest build`) — succeeded with no errors, both before and after the full 6-file edit.

Note on validation scope: the local throwaway container's `ros_migrator` role is the container's bootstrap superuser (mirroring the existing `docker-compose.yml` setup), so it does **not** reproduce Render's specific privilege gap — locally, the original `ALTER DEFAULT PRIVILEGES` statements would have succeeded too. This validation therefore proves (a) all 6 edited files are syntactically valid and execute cleanly end-to-end in real migration order, and (b) no table in any of the 6 schemas actually relies on the removed mechanism for its `ros_app` grants. It does not, and cannot, prove Render-specific role permissions from a local run.

## 5. Scope decision — extended from 1 file to 6, with explicit user approval

The initial task instruction was scoped to `identity_rls` only, with an explicit "do not silently modify any other migration." Investigation (§1 process) found the identical failure pattern, unmodified, in 5 further migrations — meaning the `identity_rls`-only fix would only move the Render failure to the next migration in the chain (`governance_audit_entries`), not resolve it. This was surfaced to the user directly (not applied silently), who was asked how to proceed and explicitly chose to extend the same narrow removal to all 5 remaining files. No file outside these 6, and no statement other than the `ALTER DEFAULT PRIVILEGES` lines, was changed.

## 6. Behavioral consequence of the removal

`ALTER DEFAULT PRIVILEGES` only affects objects **created after** the statement runs by the named role in that schema — it grants nothing on existing tables (those already got their explicit `GRANT`s, all preserved). Removing it across all 6 files means: if `ros_migrator` creates a **new** table in `identity`, `governance`, `org`, `kitchen`, `catalogue`, or `inventory` via a **future** migration, `ros_app` will not automatically receive DML on it — that future migration will need its own explicit `GRANT` on the new table, exactly the pattern §4's privilege-matrix check confirms every existing table in these 6 schemas already follows (including tables added by later migrations whose comments referenced but did not actually rely on the removed mechanism). This is a forward-looking authoring reminder only; it does not affect any table that exists today, and does not weaken RLS, tenant isolation, or any policy in any of the 6 migrations.
