-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "kitchen";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "org";

-- CreateEnum
CREATE TYPE "org"."BranchStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "org"."WarehouseType" AS ENUM ('branch', 'central', 'virtual');

-- CreateTable
CREATE TABLE "org"."brands" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "theme" JSONB NOT NULL DEFAULT '{}',
    "default_settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org"."branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "timezone" VARCHAR(48) NOT NULL,
    "base_currency" CHAR(3) NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "address" JSONB,
    "status" "org"."BranchStatus" NOT NULL DEFAULT 'active',
    "automatic_availability" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org"."warehouses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "warehouse_type" "org"."WarehouseType" NOT NULL DEFAULT 'branch',
    "branch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org"."central_kitchens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,

    CONSTRAINT "central_kitchens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org"."stations" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "capacity_config" JSONB NOT NULL DEFAULT '{}',
    "display_terminal_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org"."tables" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "label" VARCHAR(16) NOT NULL,
    "section" VARCHAR(64),
    "seat_capacity" SMALLINT,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org"."operating_hours" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "opens_at" TIME(6) NOT NULL,
    "closes_at" TIME(6) NOT NULL,
    "business_day_cutover" TIME(6) NOT NULL DEFAULT '00:00:00'::time without time zone,

    CONSTRAINT "operating_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org"."print_routing" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "document_type" VARCHAR(24) NOT NULL,
    "printer_target" VARCHAR(64) NOT NULL,
    "station_id" UUID,

    CONSTRAINT "print_routing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen"."station_routing_rules" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "menu_item_id" UUID,
    "category_id" UUID,
    "priority" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "station_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenant_id_id_key" ON "org"."brands"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenant_id_name_key" ON "org"."brands"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "branches_tenant_id_brand_id_idx" ON "org"."branches"("tenant_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "branches_tenant_id_id_key" ON "org"."branches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_branch_code" ON "org"."branches"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "warehouses_tenant_id_branch_id_idx" ON "org"."warehouses"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenant_id_id_key" ON "org"."warehouses"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenant_id_name_key" ON "org"."warehouses"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "central_kitchens_tenant_id_name_key" ON "org"."central_kitchens"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "central_kitchens_warehouse_id_key" ON "org"."central_kitchens"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stations_branch_id_id_key" ON "org"."stations"("branch_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stations_branch_id_name_key" ON "org"."stations"("branch_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_table_label" ON "org"."tables"("branch_id", "label");

-- CreateIndex
CREATE INDEX "operating_hours_branch_id_day_of_week_idx" ON "org"."operating_hours"("branch_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "print_routing_branch_id_document_type_station_id_key" ON "org"."print_routing"("branch_id", "document_type", "station_id");

-- CreateIndex
CREATE INDEX "station_routing_rules_branch_id_station_id_idx" ON "kitchen"."station_routing_rules"("branch_id", "station_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminals_branch_id_id_key" ON "identity"."terminals"("branch_id", "id");

-- AddForeignKey
ALTER TABLE "org"."brands" ADD CONSTRAINT "brands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."branches" ADD CONSTRAINT "branches_tenant_id_brand_id_fkey" FOREIGN KEY ("tenant_id", "brand_id") REFERENCES "org"."brands"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."warehouses" ADD CONSTRAINT "warehouses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."warehouses" ADD CONSTRAINT "warehouses_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."central_kitchens" ADD CONSTRAINT "central_kitchens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."central_kitchens" ADD CONSTRAINT "central_kitchens_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "org"."warehouses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."stations" ADD CONSTRAINT "stations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "org"."branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."stations" ADD CONSTRAINT "stations_branch_id_display_terminal_id_fkey" FOREIGN KEY ("branch_id", "display_terminal_id") REFERENCES "identity"."terminals"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."tables" ADD CONSTRAINT "tables_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "org"."branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."operating_hours" ADD CONSTRAINT "operating_hours_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "org"."branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."print_routing" ADD CONSTRAINT "print_routing_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "org"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."print_routing" ADD CONSTRAINT "print_routing_branch_id_station_id_fkey" FOREIGN KEY ("branch_id", "station_id") REFERENCES "org"."stations"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen"."station_routing_rules" ADD CONSTRAINT "station_routing_rules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "org"."branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen"."station_routing_rules" ADD CONSTRAINT "station_routing_rules_branch_id_station_id_fkey" FOREIGN KEY ("branch_id", "station_id") REFERENCES "org"."stations"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Phase 15 — Organisation foundation: constraints, grants and RLS.
-- Everything below is hand-written because Prisma cannot express CHECK
-- constraints, `NULLS NOT DISTINCT`, grants, or row-level security.
-- Ratified in docs/adr/0008-organisation-foundation.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Structural invariant from the approved SQL: day_of_week is 0..6
-- (0 = Sunday … 6 = Saturday, ADR 0008 D-04).
-- ----------------------------------------------------------------------------
ALTER TABLE "org"."operating_hours"
  ADD CONSTRAINT "operating_hours_day_of_week_check"
  CHECK ("day_of_week" BETWEEN 0 AND 6);

-- ----------------------------------------------------------------------------
-- D-15 print-routing uniqueness. `station_id` is nullable, and PostgreSQL's
-- default UNIQUE treats NULLs as DISTINCT — so the index Prisma generated would
-- permit unlimited duplicate branch-level defaults (station_id IS NULL), which
-- is precisely the row shape the constraint exists to de-duplicate. Replace it
-- with NULLS NOT DISTINCT (PostgreSQL 15+; this deployment runs 16).
-- ----------------------------------------------------------------------------
DROP INDEX "org"."print_routing_branch_id_document_type_station_id_key";
CREATE UNIQUE INDEX "print_routing_branch_id_document_type_station_id_key"
  ON "org"."print_routing" ("branch_id", "document_type", "station_id")
  NULLS NOT DISTINCT;

-- ----------------------------------------------------------------------------
-- Runtime role privileges. ros_app is the RLS-constrained application role
-- (NOSUPERUSER, NOBYPASSRLS, no DDL). Same pattern as Phase 8/9/12.
-- DELETE is granted and DELETE policies exist even though Phase 15 exposes no
-- delete endpoint (D-12), so the cross-tenant DELETE tests prove the RLS
-- boundary rather than a missing privilege.
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "org" TO ros_app;
GRANT USAGE ON SCHEMA "kitchen" TO ros_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "org"."brands", "org"."branches", "org"."warehouses", "org"."central_kitchens",
  "org"."stations", "org"."tables", "org"."operating_hours", "org"."print_routing"
  TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen"."station_routing_rules" TO ros_app;

ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "org"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "kitchen"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;

-- ----------------------------------------------------------------------------
-- RLS. Two anchors:
--   * DIRECT  — brands/branches/warehouses/central_kitchens carry tenant_id.
--   * PARENT  — stations/tables/operating_hours/print_routing/
--               station_routing_rules carry NO tenant_id (approved design) and
--               inherit the boundary through org.branches, exactly like the
--               Phase 8/9 children (role_permissions, membership_roles,
--               device_fingerprints).
-- Context is read as NULLIF(current_setting('app.tenant_id', true), '')::uuid,
-- so a missing context yields NULL -> predicate false -> FAIL CLOSED.
-- ----------------------------------------------------------------------------

ALTER TABLE "org"."brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."brands" FORCE ROW LEVEL SECURITY;
CREATE POLICY brands_select ON "org"."brands" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY brands_insert ON "org"."brands" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY brands_update ON "org"."brands" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY brands_delete ON "org"."brands" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "org"."branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY branches_select ON "org"."branches" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY branches_insert ON "org"."branches" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY branches_update ON "org"."branches" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY branches_delete ON "org"."branches" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "org"."warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."warehouses" FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouses_select ON "org"."warehouses" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY warehouses_insert ON "org"."warehouses" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY warehouses_update ON "org"."warehouses" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY warehouses_delete ON "org"."warehouses" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "org"."central_kitchens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."central_kitchens" FORCE ROW LEVEL SECURITY;
CREATE POLICY central_kitchens_select ON "org"."central_kitchens" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY central_kitchens_insert ON "org"."central_kitchens" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY central_kitchens_update ON "org"."central_kitchens" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY central_kitchens_delete ON "org"."central_kitchens" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "org"."stations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."stations" FORCE ROW LEVEL SECURITY;
CREATE POLICY stations_select ON "org"."stations" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY stations_insert ON "org"."stations" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY stations_update ON "org"."stations" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY stations_delete ON "org"."stations" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "org"."tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY tables_select ON "org"."tables" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY tables_insert ON "org"."tables" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY tables_update ON "org"."tables" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY tables_delete ON "org"."tables" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "org"."operating_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."operating_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY operating_hours_select ON "org"."operating_hours" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY operating_hours_insert ON "org"."operating_hours" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY operating_hours_update ON "org"."operating_hours" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY operating_hours_delete ON "org"."operating_hours" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "org"."print_routing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."print_routing" FORCE ROW LEVEL SECURITY;
CREATE POLICY print_routing_select ON "org"."print_routing" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY print_routing_insert ON "org"."print_routing" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY print_routing_update ON "org"."print_routing" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY print_routing_delete ON "org"."print_routing" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "kitchen"."station_routing_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kitchen"."station_routing_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY station_routing_rules_select ON "kitchen"."station_routing_rules" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY station_routing_rules_insert ON "kitchen"."station_routing_rules" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY station_routing_rules_update ON "kitchen"."station_routing_rules" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY station_routing_rules_delete ON "kitchen"."station_routing_rules" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "org"."branches" b WHERE b.id = branch_id
    AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
