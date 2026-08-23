-- P1E-3 — Catalogue modifier tenancy (prerequisite for FR-KDS-010 tier 2).
--
-- `catalogue.modifiers` was a "pure child of ModifierGroup — inherits the
-- tenant boundary via EXISTS" (no tenant_id, PARENT-anchor RLS). P1E-2 found
-- this makes a tenant-safe composite FK to a modifier impossible: ADR 0008
-- D-09's PostgreSQL evidence is that referential-integrity checks run with
-- row security DISABLED, so only a composite FK — never RLS alone — can make
-- a cross-tenant reference unrepresentable, and a composite FK needs
-- UNIQUE (tenant_id, id) on the referenced table.
--
-- This migration ADDS tenant_id, backfills it from the owning ModifierGroup,
-- and migrates RLS from the PARENT-anchor pattern to the DIRECT-anchor
-- pattern every other tenant_id-carrying Catalogue table already uses. No
-- row is recreated; every existing id is preserved; pricing/modifier
-- semantics are untouched.
-- ============================================================================

-- Step 1: add nullable, so this migration is correct against a POPULATED
-- table (not merely the zero-row environments this run happens to run
-- against) — a bare `ADD COLUMN ... NOT NULL` would fail on any existing row.
ALTER TABLE "catalogue"."modifiers" ADD COLUMN "tenant_id" UUID;

-- Step 2: backfill from the owning ModifierGroup, which is already tenant_id
-- NOT NULL (it was never a "pure child").
UPDATE "catalogue"."modifiers" m
SET "tenant_id" = g."tenant_id"
FROM "catalogue"."modifier_groups" g
WHERE g."id" = m."modifier_group_id";

-- Step 3: every modifier is a child of a modifier_group and every group has
-- exactly one tenant, so the backfill above is total. Enforce it going forward.
ALTER TABLE "catalogue"."modifiers" ALTER COLUMN "tenant_id" SET NOT NULL;

-- ----------------------------------------------------------------------------
-- Constraints. The old single-column parent FK is replaced by the D-09
-- composite that also proves the tenant match (not merely that a group with
-- this id exists somewhere).
-- ----------------------------------------------------------------------------
ALTER TABLE "catalogue"."modifiers"
  DROP CONSTRAINT "modifiers_modifier_group_id_fkey";

ALTER TABLE "catalogue"."modifiers"
  ADD CONSTRAINT "modifiers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "catalogue"."modifiers"
  ADD CONSTRAINT "modifiers_tenant_id_modifier_group_id_fkey"
    FOREIGN KEY ("tenant_id", "modifier_group_id")
    REFERENCES "catalogue"."modifier_groups"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The D-09 composite-FK target future tenant-safe references (e.g.
-- kitchen.station_routing_rules, sales.order_line_modifiers) will use.
CREATE UNIQUE INDEX "modifiers_tenant_id_id_key"
  ON "catalogue"."modifiers"("tenant_id", "id");

-- Superseded by the tenant-scoped index below.
DROP INDEX "catalogue"."modifiers_modifier_group_id_idx";
CREATE INDEX "modifiers_tenant_id_modifier_group_id_idx"
  ON "catalogue"."modifiers"("tenant_id", "modifier_group_id");

-- ----------------------------------------------------------------------------
-- RLS — migrate from PARENT anchor (EXISTS traversal through modifier_groups)
-- to DIRECT anchor (tenant_id = app.tenant_id), the pattern every other
-- tenant_id-carrying Catalogue table already uses (modifier_groups,
-- price_lists, price_entries, menu_items, categories, ...). Cheaper (no join)
-- and structurally identical fail-closed guarantee: a missing
-- app.tenant_id context still yields NULL -> predicate false -> zero rows.
-- ----------------------------------------------------------------------------
DROP POLICY "modifiers_select" ON "catalogue"."modifiers";
DROP POLICY "modifiers_insert" ON "catalogue"."modifiers";
DROP POLICY "modifiers_update" ON "catalogue"."modifiers";
DROP POLICY "modifiers_delete" ON "catalogue"."modifiers";

CREATE POLICY modifiers_select ON "catalogue"."modifiers" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifiers_insert ON "catalogue"."modifiers" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifiers_update ON "catalogue"."modifiers" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifiers_delete ON "catalogue"."modifiers" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ENABLE/FORCE and ros_app grants on catalogue.modifiers already exist
-- (20260816150000_catalogue_foundation) and are unaffected by this migration.
