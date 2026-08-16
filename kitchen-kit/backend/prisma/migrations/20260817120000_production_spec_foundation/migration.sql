-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "production";

-- CreateEnum
CREATE TYPE "production"."RecipeScope" AS ENUM ('tenant', 'brand', 'branch');

-- CreateEnum
CREATE TYPE "production"."RecipeType" AS ENUM ('menu_item', 'sub_recipe', 'production_item');

-- CreateEnum
CREATE TYPE "production"."RecipeVersionStatus" AS ENUM ('draft', 'published', 'superseded');

-- CreateEnum
CREATE TYPE "production"."RecipeComponentType" AS ENUM ('stock_item', 'sub_recipe');

-- CreateTable
CREATE TABLE "production"."recipes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" "production"."RecipeScope" NOT NULL,
    "brand_id" UUID,
    "branch_id" UUID,
    "recipe_type" "production"."RecipeType" NOT NULL,
    "menu_item_variant_id" UUID,
    "stock_item_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production"."recipe_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "production"."RecipeVersionStatus" NOT NULL DEFAULT 'draft',
    "yield_quantity" DECIMAL(18,6) NOT NULL,
    "yield_unit_id" UUID NOT NULL,
    "yield_percentage" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "prep_time_seconds" INTEGER,
    "computed_cost" BIGINT,
    "cost_computed_at" TIMESTAMPTZ(6),
    "effective_from" TIMESTAMPTZ(6),
    "published_by" UUID,
    "instructions" JSONB,
    "reference_images" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production"."recipe_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipe_version_id" UUID NOT NULL,
    "sequence" SMALLINT NOT NULL,
    "component_type" "production"."RecipeComponentType" NOT NULL,
    "stock_item_id" UUID,
    "sub_recipe_id" UUID,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "wastage_percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,
    "substitute_group_id" UUID,

    CONSTRAINT "recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production"."substitute_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,

    CONSTRAINT "substitute_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production"."substitute_group_members" (
    "tenant_id" UUID NOT NULL,
    "substitute_group_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,

    CONSTRAINT "substitute_group_members_pkey" PRIMARY KEY ("substitute_group_id","stock_item_id")
);

-- CreateIndex
CREATE INDEX "recipes_tenant_id_scope_idx" ON "production"."recipes"("tenant_id", "scope");

-- CreateIndex
CREATE INDEX "recipes_tenant_id_recipe_type_idx" ON "production"."recipes"("tenant_id", "recipe_type");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_tenant_id_id_key" ON "production"."recipes"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "recipe_versions_tenant_id_recipe_id_idx" ON "production"."recipe_versions"("tenant_id", "recipe_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_tenant_id_id_key" ON "production"."recipe_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_recipe_version" ON "production"."recipe_versions"("recipe_id", "version");

-- CreateIndex
CREATE INDEX "recipe_lines_tenant_id_recipe_version_id_idx" ON "production"."recipe_lines"("tenant_id", "recipe_version_id");

-- CreateIndex
CREATE INDEX "recipe_lines_tenant_id_sub_recipe_id_idx" ON "production"."recipe_lines"("tenant_id", "sub_recipe_id");

-- CreateIndex
CREATE INDEX "substitute_groups_tenant_id_idx" ON "production"."substitute_groups"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "substitute_groups_tenant_id_id_key" ON "production"."substitute_groups"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "substitute_group_members_tenant_id_idx" ON "production"."substitute_group_members"("tenant_id");

-- AddForeignKey
ALTER TABLE "production"."recipes" ADD CONSTRAINT "recipes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipes" ADD CONSTRAINT "recipes_tenant_id_brand_id_fkey" FOREIGN KEY ("tenant_id", "brand_id") REFERENCES "org"."brands"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipes" ADD CONSTRAINT "recipes_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipes" ADD CONSTRAINT "recipes_tenant_id_menu_item_variant_id_fkey" FOREIGN KEY ("tenant_id", "menu_item_variant_id") REFERENCES "catalogue"."menu_item_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipes" ADD CONSTRAINT "recipes_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_versions" ADD CONSTRAINT "recipe_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_versions" ADD CONSTRAINT "recipe_versions_tenant_id_recipe_id_fkey" FOREIGN KEY ("tenant_id", "recipe_id") REFERENCES "production"."recipes"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_versions" ADD CONSTRAINT "recipe_versions_yield_unit_id_fkey" FOREIGN KEY ("yield_unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_versions" ADD CONSTRAINT "recipe_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_recipe_version_id_fkey" FOREIGN KEY ("tenant_id", "recipe_version_id") REFERENCES "production"."recipe_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_sub_recipe_id_fkey" FOREIGN KEY ("tenant_id", "sub_recipe_id") REFERENCES "production"."recipes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_lines" ADD CONSTRAINT "recipe_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."recipe_lines" ADD CONSTRAINT "recipe_lines_tenant_id_substitute_group_id_fkey" FOREIGN KEY ("tenant_id", "substitute_group_id") REFERENCES "production"."substitute_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."substitute_groups" ADD CONSTRAINT "substitute_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."substitute_group_members" ADD CONSTRAINT "substitute_group_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."substitute_group_members" ADD CONSTRAINT "substitute_group_members_tenant_id_substitute_group_id_fkey" FOREIGN KEY ("tenant_id", "substitute_group_id") REFERENCES "production"."substitute_groups"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production"."substitute_group_members" ADD CONSTRAINT "substitute_group_members_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Production Spec — hand-written block.
-- Frozen design: docs/production/PRODUCTION_SPEC_DESIGN_GATE.md
-- Everything below is RATIFIED-DESIGN (gate 17) and cannot be expressed in
-- the Prisma schema language.
-- ============================================================================

-- ---------------------------------------------------------------- CHECKs ---
-- Source-mandated (approved SQL L457).
ALTER TABLE "production"."recipe_versions"
  ADD CONSTRAINT "ck_recipe_yield_positive" CHECK ("yield_quantity" > 0);

-- D-17-02 XOR: scope <-> the one typed scope column (gate 5).
ALTER TABLE "production"."recipes"
  ADD CONSTRAINT "ck_recipe_scope" CHECK (
       ("scope" = 'tenant' AND "brand_id" IS NULL     AND "branch_id" IS NULL)
    OR ("scope" = 'brand'  AND "brand_id" IS NOT NULL AND "branch_id" IS NULL)
    OR ("scope" = 'branch' AND "branch_id" IS NOT NULL AND "brand_id" IS NULL)
  );

-- D-17-02 XOR: recipe_type <-> the one typed target column (gate 5).
-- menu_item -> variant; sub_recipe / production_item -> stock item.
ALTER TABLE "production"."recipes"
  ADD CONSTRAINT "ck_recipe_target" CHECK (
       ("recipe_type" = 'menu_item'
          AND "menu_item_variant_id" IS NOT NULL AND "stock_item_id" IS NULL)
    OR ("recipe_type" IN ('sub_recipe','production_item')
          AND "stock_item_id" IS NOT NULL AND "menu_item_variant_id" IS NULL)
  );

-- D-17-02 XOR: component_type <-> the one typed component column (gate 10).
ALTER TABLE "production"."recipe_lines"
  ADD CONSTRAINT "ck_recipe_line_component" CHECK (
       ("component_type" = 'stock_item'
          AND "stock_item_id" IS NOT NULL AND "sub_recipe_id" IS NULL)
    OR ("component_type" = 'sub_recipe'
          AND "sub_recipe_id" IS NOT NULL AND "stock_item_id" IS NULL)
  );

-- ------------------------------------------- D-17-08 Q1: ONE published -----
-- At most one published version per recipe. Prisma cannot express a partial
-- index, so it lives here; verified to produce no Prisma drift.
-- NOT deferrable: a publish transaction MUST demote the incumbent before
-- promoting the target.
CREATE UNIQUE INDEX "uq_recipe_single_published"
  ON "production"."recipe_versions" ("recipe_id")
  WHERE "status" = 'published';

-- No index is created on effective_from, by ratification (D-17-08 Q2) and per
-- SRS 25.4 "No index without a query that uses it" — nothing queries it.

-- ---------------------------------------------------------------- GRANTS ---
GRANT USAGE ON SCHEMA "production" TO ros_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "production"."recipes",
  "production"."recipe_lines",
  "production"."substitute_groups",
  "production"."substitute_group_members"
TO ros_app;

-- GAP-2 (RATIFIED): published-version immutability without triggers.
-- ADR 0007's blanket REVOKE UPDATE is not applicable here because the
-- draft->published and published->superseded transitions REQUIRE UPDATE.
-- A column-level grant lets ros_app change ONLY `status`, on any row: yield,
-- units, instructions, images, effective_from and the cost columns become
-- structurally unwritable after INSERT.
GRANT SELECT, INSERT, DELETE ON "production"."recipe_versions" TO ros_app;
REVOKE UPDATE ON "production"."recipe_versions" FROM ros_app;
GRANT UPDATE ("status") ON "production"."recipe_versions" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
-- ADR 0003 pattern, predicate byte-identical to every other context.
ALTER TABLE "production"."recipes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production"."recipes" FORCE ROW LEVEL SECURITY;
CREATE POLICY recipes_select ON "production"."recipes" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY recipes_insert ON "production"."recipes" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY recipes_update ON "production"."recipes" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY recipes_delete ON "production"."recipes" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "production"."recipe_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production"."recipe_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_versions_select ON "production"."recipe_versions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY recipe_versions_insert ON "production"."recipe_versions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- UPDATE is already column-restricted to `status` by the grant above; the
-- policy adds the tenant boundary.
CREATE POLICY recipe_versions_update ON "production"."recipe_versions" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- GAP-2: status-predicated DELETE. Published and superseded versions are not
-- deletable; FR-MNU-045 "supersede but not delete".
CREATE POLICY recipe_versions_delete ON "production"."recipe_versions" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND status = 'draft');

ALTER TABLE "production"."recipe_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production"."recipe_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY recipe_lines_select ON "production"."recipe_lines" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- GAP-2: writes are permitted ONLY against a DRAFT parent version, so a
-- published version's composition is structurally frozen.
CREATE POLICY recipe_lines_insert ON "production"."recipe_lines" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM "production"."recipe_versions" v
                WHERE v.id = recipe_version_id AND v.status = 'draft'));
CREATE POLICY recipe_lines_update ON "production"."recipe_lines" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM "production"."recipe_versions" v
                WHERE v.id = recipe_version_id AND v.status = 'draft'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM "production"."recipe_versions" v
                WHERE v.id = recipe_version_id AND v.status = 'draft'));
CREATE POLICY recipe_lines_delete ON "production"."recipe_lines" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM "production"."recipe_versions" v
                WHERE v.id = recipe_version_id AND v.status = 'draft'));

ALTER TABLE "production"."substitute_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production"."substitute_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY substitute_groups_select ON "production"."substitute_groups" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY substitute_groups_insert ON "production"."substitute_groups" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY substitute_groups_update ON "production"."substitute_groups" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY substitute_groups_delete ON "production"."substitute_groups" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "production"."substitute_group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production"."substitute_group_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY substitute_group_members_select ON "production"."substitute_group_members" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY substitute_group_members_insert ON "production"."substitute_group_members" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY substitute_group_members_update ON "production"."substitute_group_members" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY substitute_group_members_delete ON "production"."substitute_group_members" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
