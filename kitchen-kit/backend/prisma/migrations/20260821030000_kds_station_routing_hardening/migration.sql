-- P1E-3 — Organisation/Kitchen-config prerequisites for FR-KDS-001/010/011:
--   1. org.stations.display_colour (FR-KDS-001 [M]);
--   2. kitchen.station_routing_rules hardened: tenant-safe selectors, a
--      modifier_id selector, exactly-one-selector CHECK, duplicate prevention;
--   3. kitchen.branch_kds_config — FR-KDS-010 tier 5 branch fallback station.
--
-- Physical schema for both kitchen tables follows the existing ADR 0008 D-06
-- placement (SRS §25.1: `kitchen` = "tickets, ticket_lines,
-- station_routing_rules"). LOGICAL ownership of this configuration remains
-- Organisation (ADR 0008 D-07/D-06 — "Station routing rules are stored, not
-- resolved"); FR-KDS-010 resolution BEHAVIOUR is Kitchen Ops and is NOT
-- implemented by this migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. FR-KDS-001 [M] "configurable name, display colour, and capacity."
-- Same nullable VARCHAR(9) convention as catalogue.categories.colour /
-- catalogue.menu_items.colour.
-- ----------------------------------------------------------------------------
ALTER TABLE "org"."stations" ADD COLUMN "display_colour" VARCHAR(9);

-- ----------------------------------------------------------------------------
-- 2a. station_routing_rules — add tenant_id (nullable first; this migration
-- is correct against a POPULATED table, not merely today's zero rows),
-- backfill from the rule's own branch, then enforce NOT NULL.
-- ----------------------------------------------------------------------------
ALTER TABLE "kitchen"."station_routing_rules" ADD COLUMN "tenant_id" UUID;

UPDATE "kitchen"."station_routing_rules" r
SET "tenant_id" = b."tenant_id"
FROM "org"."branches" b
WHERE b."id" = r."branch_id";

ALTER TABLE "kitchen"."station_routing_rules" ALTER COLUMN "tenant_id" SET NOT NULL;

-- 2b. add the modifier selector (tier 2).
ALTER TABLE "kitchen"."station_routing_rules" ADD COLUMN "modifier_id" UUID;

-- ----------------------------------------------------------------------------
-- 2c. Replace the single-column branch FK with the D-09 composite (a rule can
-- only target a branch within its OWN tenant — the single-column FK alone
-- could not express that), and add the tenant-safe FK to the three Catalogue
-- selectors. ADR 0008 D-06's stated reason for leaving menu_item_id/
-- category_id FK-less ("Catalogue does not exist") has expired.
-- ----------------------------------------------------------------------------
ALTER TABLE "kitchen"."station_routing_rules"
  DROP CONSTRAINT "station_routing_rules_branch_id_fkey";

ALTER TABLE "kitchen"."station_routing_rules"
  ADD CONSTRAINT "station_routing_rules_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kitchen"."station_routing_rules"
  ADD CONSTRAINT "station_routing_rules_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id")
    REFERENCES "org"."branches"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kitchen"."station_routing_rules"
  ADD CONSTRAINT "station_routing_rules_tenant_id_menu_item_id_fkey"
    FOREIGN KEY ("tenant_id", "menu_item_id")
    REFERENCES "catalogue"."menu_items"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kitchen"."station_routing_rules"
  ADD CONSTRAINT "station_routing_rules_tenant_id_category_id_fkey"
    FOREIGN KEY ("tenant_id", "category_id")
    REFERENCES "catalogue"."categories"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kitchen"."station_routing_rules"
  ADD CONSTRAINT "station_routing_rules_tenant_id_modifier_id_fkey"
    FOREIGN KEY ("tenant_id", "modifier_id")
    REFERENCES "catalogue"."modifiers"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 2d. Exactly one of menu_item_id / category_id / modifier_id is non-null.
-- Prisma cannot express CHECK constraints — hand-written, as
-- 20260816110000_organisation_foundation's header states for this table's
-- sibling constructs.
-- ----------------------------------------------------------------------------
ALTER TABLE "kitchen"."station_routing_rules"
  ADD CONSTRAINT "ck_station_routing_rule_one_selector" CHECK (
    (("menu_item_id" IS NOT NULL)::int
     + ("category_id" IS NOT NULL)::int
     + ("modifier_id" IS NOT NULL)::int) = 1
  );

-- ----------------------------------------------------------------------------
-- 2e. Prevent a duplicate (branch, selector, station) row. No prior
-- uniqueness existed on this table (ADR 0008 D-15 left it "deliberately
-- open... entangled with Catalogue keys that do not exist yet" — they now
-- do). NULLS NOT DISTINCT (PostgreSQL 16) is required: with default NULL
-- semantics, two identical menu-item rules (both category_id/modifier_id
-- NULL) would NOT collide under a plain UNIQUE — the exact defect
-- `org.print_routing` already hit and was fixed the same way.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX "uq_station_routing_rule_selector_station"
  ON "kitchen"."station_routing_rules"
  ("branch_id", "menu_item_id", "category_id", "modifier_id", "station_id")
  NULLS NOT DISTINCT;

-- 2f. Resolver lookup indexes — one per selector tier the resolver queries by.
CREATE INDEX "station_routing_rules_tenant_id_branch_id_menu_item_id_idx"
  ON "kitchen"."station_routing_rules"("tenant_id", "branch_id", "menu_item_id");
CREATE INDEX "station_routing_rules_tenant_id_branch_id_category_id_idx"
  ON "kitchen"."station_routing_rules"("tenant_id", "branch_id", "category_id");
CREATE INDEX "station_routing_rules_tenant_id_branch_id_modifier_id_idx"
  ON "kitchen"."station_routing_rules"("tenant_id", "branch_id", "modifier_id");

-- ----------------------------------------------------------------------------
-- 2g. RLS — migrate from PARENT anchor (EXISTS traversal through
-- org.branches) to DIRECT anchor, now that tenant_id exists directly on the
-- row. Same fail-closed guarantee, cheaper (no join).
-- ----------------------------------------------------------------------------
DROP POLICY "station_routing_rules_select" ON "kitchen"."station_routing_rules";
DROP POLICY "station_routing_rules_insert" ON "kitchen"."station_routing_rules";
DROP POLICY "station_routing_rules_update" ON "kitchen"."station_routing_rules";
DROP POLICY "station_routing_rules_delete" ON "kitchen"."station_routing_rules";

CREATE POLICY station_routing_rules_select ON "kitchen"."station_routing_rules" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY station_routing_rules_insert ON "kitchen"."station_routing_rules" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY station_routing_rules_update ON "kitchen"."station_routing_rules" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY station_routing_rules_delete ON "kitchen"."station_routing_rules" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- 3. branch_kds_config — FR-KDS-010 tier 5. One row per branch (PK = branch_id).
-- ----------------------------------------------------------------------------
CREATE TABLE "kitchen"."branch_kds_config" (
    "branch_id"           UUID NOT NULL,
    "tenant_id"           UUID NOT NULL,
    "fallback_station_id" UUID,

    CONSTRAINT "branch_kds_config_pkey" PRIMARY KEY ("branch_id")
);

CREATE UNIQUE INDEX "branch_kds_config_tenant_id_branch_id_key"
  ON "kitchen"."branch_kds_config"("tenant_id", "branch_id");

ALTER TABLE "kitchen"."branch_kds_config"
  ADD CONSTRAINT "branch_kds_config_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kitchen"."branch_kds_config"
  ADD CONSTRAINT "branch_kds_config_tenant_id_branch_id_fkey"
    FOREIGN KEY ("tenant_id", "branch_id")
    REFERENCES "org"."branches"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The fallback MUST belong to the same branch (D-09). RESTRICT: a station
-- actively configured as a branch's fallback cannot be silently deleted out
-- from under the configuration.
ALTER TABLE "kitchen"."branch_kds_config"
  ADD CONSTRAINT "branch_kds_config_branch_id_fallback_station_id_fkey"
    FOREIGN KEY ("branch_id", "fallback_station_id")
    REFERENCES "org"."stations"("branch_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- kitchen's `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator` (organisation
-- foundation migration) grants new ros_migrator-created kitchen tables to
-- ros_app automatically; explicit grant kept for clarity/consistency with the
-- rest of this migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen"."branch_kds_config" TO ros_app;

ALTER TABLE "kitchen"."branch_kds_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kitchen"."branch_kds_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY branch_kds_config_select ON "kitchen"."branch_kds_config" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY branch_kds_config_insert ON "kitchen"."branch_kds_config" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY branch_kds_config_update ON "kitchen"."branch_kds_config" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY branch_kds_config_delete ON "kitchen"."branch_kds_config" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
