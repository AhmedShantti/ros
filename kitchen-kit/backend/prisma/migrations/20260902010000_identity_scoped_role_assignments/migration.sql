-- ---------------------------------------------------------------------------
-- B1-2 migration 36 (Identity) — SCOPED ROLE ASSIGNMENTS.
--
-- Implements FR-SEC-002 [M], FR-SEC-003 [M], FR-SEC-004 [M] (persistence half)
-- and FR-SEC-005 [S], plus the T-4-LIVE authorization epoch that FR-API-012's
-- token snapshot is validated against.
--
-- Authority (CONTROLLING):
--   docs/governance/GOVERNANCE_DECISION_REGISTER.md —
--     "AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC"
--     (RATIFIED 2026-09-02, explicit user governance action)
--   docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-ratification.md
--   docs/adr/0009-scoped-rbac.md (supersedes the branch-scope deferrals in
--     ADR 0002 and ADR 0004, as ADR 0008 D-02 required)
--
-- ── WHAT THIS MIGRATION IS ──────────────────────────────────────────────────
-- A TABLE-IDENTITY change to `identity.membership_roles`, not an additive
-- column set. ADR 0008 D-02 recorded the reason verbatim: the shipped
-- `PRIMARY KEY (membership_id, role_id)` admits one row per membership+role, so
-- FR-SEC-003's own worked example ("Branch Manager at Branch 1 and Cashier at
-- Branch 2") is only half-representable and "Cashier at Branch 1 AND Cashier at
-- Branch 2" is not representable at all. Clause 11 of the amendment authorises
-- the change.
--
-- ── SCOPE REFERENCES ARE TYPED, NEVER POLYMORPHIC ───────────────────────────
-- Clause 10 forbids a single untyped `scope_id`. PostgreSQL evaluates
-- referential-integrity checks with row security DISABLED (ADR 0008 D-09), so
-- RLS alone can NEVER make a cross-tenant scope reference impossible — only a
-- real composite FK can. `scope_brand_id` and `scope_branch_id` therefore each
-- carry `(tenant_id, <col>)` composite FKs, and a CHECK binds them to
-- `scope_type` so an inconsistent row cannot exist at all.
--
-- ── LEGACY `branch_id` IS DROPPED, NOT KEPT ALONGSIDE ───────────────────────
-- `membership_roles.branch_id` was verified NEVER WRITTEN by any code path and
-- NEVER READ by any authorization path (it was declared "RESERVED" in
-- `tenant-context.ts` and "not yet consumed" in the schema). Keeping it beside
-- `scope_branch_id` would leave two branch-shaped columns with different
-- authority — a permanent ambiguity. It is dropped. Its data is not migrated
-- because it has none: the backfill below asserts that.
--
-- ── M-4+ BACKFILL ───────────────────────────────────────────────────────────
-- Every pre-existing assignment is backfilled `scope_type = 'tenant'`, because
-- tenant-wide is what an unscoped assignment ACTUALLY meant. Behaviour is
-- preserved exactly on migration day. Each backfilled row is stamped
-- `origin = 'migration'` with `reviewed_at IS NULL`, so inherited authority
-- stays permanently distinguishable from deliberately granted authority — which
-- is what makes the second-active-branch gate (clause 13.C) and the
-- already-multi-branch review state (clause 13.D) possible at all.
--
-- ── WHAT THIS MIGRATION IS NOT ──────────────────────────────────────────────
-- NO branch predicate enters any RLS policy. NO `app.branch_id` GUC is
-- introduced. Tenant RLS keeps ENABLE + FORCE and is not weakened anywhere:
-- branch/brand authorization is an APPLICATION layer (clause 14). No permission
-- code is created, altered or reclassified (clause 20 — SRS Appendix C is
-- absent, so no permission may be classified tenant-only or branch-only).
-- ---------------------------------------------------------------------------

-- ============================================================== 1. ENUMS ===
CREATE TYPE "identity"."RoleScopeType" AS ENUM ('tenant', 'brand', 'branch');
CREATE TYPE "identity"."MembershipRoleOrigin" AS ENUM ('explicit', 'migration');

COMMENT ON TYPE "identity"."RoleScopeType" IS
  'FR-SEC-002 assignment scope. EXACTLY three members authorised by D-2 REOPENED IN PART (2) cl.4. BRANCH_GROUP is deferred (cl.5), not rejected — a mandatory FR-BRN-005 follow-up once the BranchGroup entity exists; the enum extends additively without reinterpreting these three. WAREHOUSE/CENTRAL_KITCHEN/LOCATION are not authorised.';

-- ================================================== 2. MEMBERSHIP (T-4-LIVE) =
-- Monotonic authorization epoch. A token carries the epoch it was minted at;
-- a mismatch against the live row means the token's scope snapshot is STALE and
-- the request is refused. The token never grants — live resolution does — so
-- this detects staleness, it does not confer authority.
ALTER TABLE "identity"."memberships"
  ADD COLUMN "authz_epoch" INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN "identity"."memberships"."authz_epoch" IS
  'T-4-LIVE (D-2 REOPENED IN PART (2) cl.7). Bumped transactionally whenever this membership''s scoped role-assignment authority changes. Detects a stale token snapshot; never a grant.';

-- D-09 composite-FK target, so membership_roles(tenant_id, membership_id) can
-- be made structurally same-tenant. Additive; (id) remains the primary key.
ALTER TABLE "identity"."memberships"
  ADD CONSTRAINT "memberships_tenant_id_id_key" UNIQUE ("tenant_id", "id");

-- ====================================== 3. MEMBERSHIP_ROLES — NEW COLUMNS ===
-- Added nullable first, backfilled, then constrained. `updated_at` has no
-- DEFAULT in the Prisma model (@updatedAt is application-side), so it is
-- backfilled from created_at and then made NOT NULL.
ALTER TABLE "identity"."membership_roles"
  ADD COLUMN "id"              UUID,
  ADD COLUMN "tenant_id"       UUID,
  ADD COLUMN "scope_type"      "identity"."RoleScopeType",
  ADD COLUMN "scope_brand_id"  UUID,
  ADD COLUMN "scope_branch_id" UUID,
  ADD COLUMN "valid_from"      TIMESTAMPTZ(6),
  ADD COLUMN "valid_to"        TIMESTAMPTZ(6),
  ADD COLUMN "origin"          "identity"."MembershipRoleOrigin",
  ADD COLUMN "reviewed_at"     TIMESTAMPTZ(6),
  ADD COLUMN "reviewed_by"     UUID,
  ADD COLUMN "updated_at"      TIMESTAMPTZ(6);

-- ================================================== 4. M-4+ BACKFILL =======
-- Legacy-tolerant by construction: it runs against whatever rows exist and
-- invents nothing. `gen_random_uuid()` (PostgreSQL 13+ core) is used rather
-- than a ULID because SQL has no ULID generator; migration-originated rows are
-- not time-ordered by id, which is acceptable — `created_at` carries the
-- ordering fact and these rows are explicitly marked as inherited.
UPDATE "identity"."membership_roles" mr
SET "id"         = gen_random_uuid(),
    "tenant_id"  = m."tenant_id",
    "scope_type" = 'tenant',
    "valid_from" = mr."created_at",
    "origin"     = 'migration',
    "updated_at" = mr."created_at"
FROM "identity"."memberships" m
WHERE m."id" = mr."membership_id";

-- Fail loudly rather than silently dropping authority: an assignment whose
-- parent membership vanished cannot be scoped, and must not be left unscoped.
DO $$
DECLARE orphans BIGINT;
BEGIN
  SELECT count(*) INTO orphans
  FROM "identity"."membership_roles" WHERE "tenant_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'B1-2 backfill: % membership_roles row(s) have no parent membership; refusing to migrate rather than silently drop or unscope authority.', orphans;
  END IF;
END $$;

-- The legacy branch_id was never written by any code path. If that is ever
-- untrue in some environment, stop: silently discarding it would discard a
-- (however unused) recorded intent, and silently promoting it to a BRANCH scope
-- would GRANT authority this migration is not authorised to grant.
DO $$
DECLARE populated BIGINT;
BEGIN
  SELECT count(*) INTO populated
  FROM "identity"."membership_roles" WHERE "branch_id" IS NOT NULL;
  IF populated > 0 THEN
    RAISE EXCEPTION
      'B1-2 backfill: % membership_roles row(s) carry a legacy branch_id. It was never consumed by any authorization path, so this migration will neither discard it silently nor promote it to a BRANCH scope. Resolve manually before migrating.', populated;
  END IF;
END $$;

ALTER TABLE "identity"."membership_roles" DROP COLUMN "branch_id";

-- ================================================ 5. NOT NULL + DEFAULTS ===
ALTER TABLE "identity"."membership_roles"
  ALTER COLUMN "id"         SET NOT NULL,
  ALTER COLUMN "tenant_id"  SET NOT NULL,
  ALTER COLUMN "scope_type" SET NOT NULL,
  ALTER COLUMN "valid_from" SET NOT NULL,
  ALTER COLUMN "valid_from" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "origin"     SET NOT NULL,
  ALTER COLUMN "origin"     SET DEFAULT 'explicit',
  ALTER COLUMN "updated_at" SET NOT NULL;

-- ====================================================== 6. TABLE IDENTITY ===
-- The composite PK is REPLACED, not augmented (ADR 0008 D-02; amendment cl.11).
ALTER TABLE "identity"."membership_roles" DROP CONSTRAINT "membership_roles_pkey";
ALTER TABLE "identity"."membership_roles" ADD  CONSTRAINT "membership_roles_pkey" PRIMARY KEY ("id");

-- The single-column membership FK is replaced by the tenant-safe composite one.
ALTER TABLE "identity"."membership_roles"
  DROP CONSTRAINT "membership_roles_membership_id_fkey";

ALTER TABLE "identity"."membership_roles"
  ADD CONSTRAINT "membership_roles_tenant_id_membership_id_fkey"
  FOREIGN KEY ("tenant_id", "membership_id")
  REFERENCES "identity"."memberships"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- D-09 tenant-safe scope references. RLS cannot enforce these (FK checks run
-- with row security disabled), so the FK is the ONLY thing that can.
ALTER TABLE "identity"."membership_roles"
  ADD CONSTRAINT "membership_roles_tenant_id_scope_brand_id_fkey"
  FOREIGN KEY ("tenant_id", "scope_brand_id")
  REFERENCES "org"."brands"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "identity"."membership_roles"
  ADD CONSTRAINT "membership_roles_tenant_id_scope_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "scope_branch_id")
  REFERENCES "org"."branches"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ========================================================== 7. INVARIANTS ===
-- Scope consistency: an inconsistent row is impossible at the DATABASE layer,
-- not merely discouraged in TypeScript.
ALTER TABLE "identity"."membership_roles"
  ADD CONSTRAINT "ck_membership_role_scope_consistent" CHECK (
       ("scope_type" = 'tenant' AND "scope_brand_id" IS NULL     AND "scope_branch_id" IS NULL)
    OR ("scope_type" = 'brand'  AND "scope_brand_id" IS NOT NULL AND "scope_branch_id" IS NULL)
    OR ("scope_type" = 'branch' AND "scope_brand_id" IS NULL     AND "scope_branch_id" IS NOT NULL)
  );

-- FR-SEC-005: an assignment that expires before it begins is not a temporary
-- elevation, it is a data error.
ALTER TABLE "identity"."membership_roles"
  ADD CONSTRAINT "ck_membership_role_validity_window" CHECK (
    "valid_to" IS NULL OR "valid_to" > "valid_from"
  );

-- Review state is only meaningful together: a row is reviewed by someone, at a
-- time, or is not reviewed at all.
ALTER TABLE "identity"."membership_roles"
  ADD CONSTRAINT "ck_membership_role_review_state" CHECK (
    ("reviewed_at" IS NULL AND "reviewed_by" IS NULL)
    OR ("reviewed_at" IS NOT NULL AND "reviewed_by" IS NOT NULL)
  );

-- No two assignments of the same role, at the SAME exact scope, for the same
-- membership, may be effective at overlapping times. Historical (expired) and
-- future (not-yet-valid) assignments remain fully representable — this forbids
-- only genuine duplication, which is what FR-SEC-004's "union within each
-- assignment's own scope" would otherwise silently double-count.
--
-- A partial unique index on `valid_to IS NULL` would catch only the open-ended
-- case; a range EXCLUDE is the exact invariant. `btree_gist` is already an
-- established dependency of this repository (migration
-- 20260819120000_price_list_no_overlap creates it for the same reason).
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "identity"."membership_roles"
  ADD CONSTRAINT "ex_membership_role_no_overlap"
  EXCLUDE USING gist (
    "membership_id" WITH =,
    "role_id" WITH =,
    "scope_type" WITH =,
    COALESCE("scope_branch_id", "scope_brand_id", "tenant_id") WITH =,
    tstzrange("valid_from", "valid_to") WITH &&
  );

COMMENT ON CONSTRAINT "ex_membership_role_no_overlap" ON "identity"."membership_roles" IS
  'FR-SEC-003/004: at most one effective assignment per (membership, role, exact scope) at any instant. Historical and future assignments remain representable.';

-- ============================================================= 8. INDEXES ===
DROP INDEX IF EXISTS "identity"."membership_roles_role_id_idx";
CREATE INDEX "membership_roles_tenant_id_membership_id_idx"
  ON "identity"."membership_roles"("tenant_id", "membership_id");
CREATE INDEX "membership_roles_role_id_idx"
  ON "identity"."membership_roles"("role_id");
CREATE INDEX "membership_roles_tenant_id_scope_branch_id_idx"
  ON "identity"."membership_roles"("tenant_id", "scope_branch_id");
CREATE INDEX "membership_roles_tenant_id_scope_brand_id_idx"
  ON "identity"."membership_roles"("tenant_id", "scope_brand_id");

-- ================================================================= 9. RLS ===
-- The table keeps ENABLE + FORCE. The policies are re-expressed against the new
-- LOCAL `tenant_id` (previously they joined `identity.memberships` because the
-- table had no tenant column of its own), and the MISSING `UPDATE` policy is
-- added — without it, PostgreSQL denies every UPDATE under FORCE, which made
-- FR-SEC-005 expiry-by-update and M-4+ review impossible at runtime.
--
-- Every predicate reads `NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
-- so an absent context yields NULL -> false -> FAIL CLOSED (FR-PLT-012).
-- NO branch predicate is introduced anywhere (clause 14).
DROP POLICY "membership_roles_select" ON "identity"."membership_roles";
DROP POLICY "membership_roles_insert" ON "identity"."membership_roles";
DROP POLICY "membership_roles_delete" ON "identity"."membership_roles";

-- Read: the owning tenant, OR the subject themselves. The own-user limb is
-- PRESERVED EXACTLY from the original policy — it is what lets a user read
-- their own assignments before a tenant has been selected.
CREATE POLICY "membership_roles_select" ON "identity"."membership_roles" FOR SELECT
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM "identity"."memberships" m
      WHERE m."id" = "membership_id"
        AND m."user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );

CREATE POLICY "membership_roles_insert" ON "identity"."membership_roles" FOR INSERT
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- NEW. `USING` gates which rows may be updated; `WITH CHECK` gates the RESULT,
-- so an update can neither reach out of the tenant nor move a row into another
-- tenant. Both limbs are required — `USING` alone would permit re-tenanting.
CREATE POLICY "membership_roles_update" ON "identity"."membership_roles" FOR UPDATE
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY "membership_roles_delete" ON "identity"."membership_roles" FOR DELETE
  USING (
    "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
