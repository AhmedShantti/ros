-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "catalogue";

-- CreateEnum
CREATE TYPE "catalogue"."PriceListScope" AS ENUM ('tenant', 'brand', 'branch');

-- CreateTable
CREATE TABLE "catalogue"."menus" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "order_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active_window" JSONB,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."menu_branches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "parent_category_id" UUID,
    "name" JSONB NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "colour" VARCHAR(9),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."menu_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "names" JSONB NOT NULL,
    "kitchen_names" JSONB NOT NULL DEFAULT '{}',
    "aggregator_names" JSONB NOT NULL DEFAULT '{}',
    "description" JSONB,
    "tax_class_id" UUID,
    "revenue_account_code" VARCHAR(32),
    "barcode_plu" VARCHAR(32),
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dietary_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "colour" VARCHAR(9),
    "is_combo" BOOLEAN NOT NULL DEFAULT false,
    "is_open_price" BOOLEAN NOT NULL DEFAULT false,
    "is_weighed" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."menu_item_placements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_item_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."menu_item_variants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "barcode" VARCHAR(32),
    "prep_time_seconds" INTEGER,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "menu_item_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."menu_item_images" (
    "id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "menu_item_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."availability_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID,
    "variant_id" UUID,
    "branch_id" UUID,
    "channel" VARCHAR(16),
    "day_of_week" SMALLINT,
    "starts_at" TIME(6),
    "ends_at" TIME(6),
    "is_manual_86" BOOLEAN NOT NULL DEFAULT false,
    "auto_reenable_at" TIMESTAMPTZ(6),

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."modifier_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "min_selections" SMALLINT NOT NULL DEFAULT 0,
    "max_selections" SMALLINT NOT NULL DEFAULT 1,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "allow_repeat" BOOLEAN NOT NULL DEFAULT false,
    "free_quantity_threshold" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."modifiers" (
    "id" UUID NOT NULL,
    "modifier_group_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "price_delta" BIGINT NOT NULL DEFAULT 0,
    "stock_item_id" UUID,
    "consumption_quantity" DECIMAL(18,6),
    "consumption_unit_id" UUID,
    "recipe_delta" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."modifier_group_links" (
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "modifier_group_id" UUID NOT NULL,
    "price_override" JSONB,
    "default_selection_override" JSONB,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "modifier_group_links_pkey" PRIMARY KEY ("menu_item_id","modifier_group_id")
);

-- CreateTable
CREATE TABLE "catalogue"."price_lists" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "scope_type" "catalogue"."PriceListScope" NOT NULL,
    "scope_id" UUID,
    "order_type" VARCHAR(16),
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "recurrence_rule" JSONB,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "status" VARCHAR(16) NOT NULL DEFAULT 'scheduled',

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue"."price_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "menu_item_variant_id" UUID NOT NULL,
    "price" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "price_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menus_tenant_id_idx" ON "catalogue"."menus"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "menus_tenant_id_id_key" ON "catalogue"."menus"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "menu_branches_tenant_id_branch_id_idx" ON "catalogue"."menu_branches"("tenant_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_branches_tenant_id_menu_id_branch_id_key" ON "catalogue"."menu_branches"("tenant_id", "menu_id", "branch_id");

-- CreateIndex
CREATE INDEX "categories_tenant_id_menu_id_idx" ON "catalogue"."categories"("tenant_id", "menu_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_id_key" ON "catalogue"."categories"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "menu_items_tenant_id_idx" ON "catalogue"."menu_items"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_tenant_id_id_key" ON "catalogue"."menu_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "menu_item_placements_tenant_id_category_id_idx" ON "catalogue"."menu_item_placements"("tenant_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_placements_tenant_id_menu_item_id_category_id_key" ON "catalogue"."menu_item_placements"("tenant_id", "menu_item_id", "category_id");

-- CreateIndex
CREATE INDEX "menu_item_variants_tenant_id_menu_item_id_idx" ON "catalogue"."menu_item_variants"("tenant_id", "menu_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_variants_tenant_id_id_key" ON "catalogue"."menu_item_variants"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "menu_item_images_menu_item_id_idx" ON "catalogue"."menu_item_images"("menu_item_id");

-- CreateIndex
CREATE INDEX "availability_rules_tenant_id_menu_item_id_idx" ON "catalogue"."availability_rules"("tenant_id", "menu_item_id");

-- CreateIndex
CREATE INDEX "availability_rules_tenant_id_variant_id_idx" ON "catalogue"."availability_rules"("tenant_id", "variant_id");

-- CreateIndex
CREATE INDEX "modifier_groups_tenant_id_idx" ON "catalogue"."modifier_groups"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_groups_tenant_id_id_key" ON "catalogue"."modifier_groups"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "modifiers_modifier_group_id_idx" ON "catalogue"."modifiers"("modifier_group_id");

-- CreateIndex
CREATE INDEX "modifier_group_links_tenant_id_modifier_group_id_idx" ON "catalogue"."modifier_group_links"("tenant_id", "modifier_group_id");

-- CreateIndex
CREATE INDEX "price_lists_tenant_id_scope_type_scope_id_idx" ON "catalogue"."price_lists"("tenant_id", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_tenant_id_id_key" ON "catalogue"."price_lists"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_price_list_name" ON "catalogue"."price_lists"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "price_entries_tenant_id_menu_item_variant_id_idx" ON "catalogue"."price_entries"("tenant_id", "menu_item_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_price_entry" ON "catalogue"."price_entries"("tenant_id", "price_list_id", "menu_item_variant_id");

-- AddForeignKey
ALTER TABLE "catalogue"."menus" ADD CONSTRAINT "menus_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."menu_branches" ADD CONSTRAINT "menu_branches_tenant_id_menu_id_fkey" FOREIGN KEY ("tenant_id", "menu_id") REFERENCES "catalogue"."menus"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."menu_branches" ADD CONSTRAINT "menu_branches_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."categories" ADD CONSTRAINT "categories_tenant_id_menu_id_fkey" FOREIGN KEY ("tenant_id", "menu_id") REFERENCES "catalogue"."menus"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."categories" ADD CONSTRAINT "categories_tenant_id_parent_category_id_fkey" FOREIGN KEY ("tenant_id", "parent_category_id") REFERENCES "catalogue"."categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."menu_items" ADD CONSTRAINT "menu_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."menu_item_placements" ADD CONSTRAINT "menu_item_placements_tenant_id_menu_item_id_fkey" FOREIGN KEY ("tenant_id", "menu_item_id") REFERENCES "catalogue"."menu_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."menu_item_placements" ADD CONSTRAINT "menu_item_placements_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "catalogue"."categories"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."menu_item_variants" ADD CONSTRAINT "menu_item_variants_tenant_id_menu_item_id_fkey" FOREIGN KEY ("tenant_id", "menu_item_id") REFERENCES "catalogue"."menu_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."menu_item_images" ADD CONSTRAINT "menu_item_images_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "catalogue"."menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."availability_rules" ADD CONSTRAINT "availability_rules_tenant_id_menu_item_id_fkey" FOREIGN KEY ("tenant_id", "menu_item_id") REFERENCES "catalogue"."menu_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."availability_rules" ADD CONSTRAINT "availability_rules_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "catalogue"."menu_item_variants"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."availability_rules" ADD CONSTRAINT "availability_rules_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."modifier_groups" ADD CONSTRAINT "modifier_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."modifiers" ADD CONSTRAINT "modifiers_modifier_group_id_fkey" FOREIGN KEY ("modifier_group_id") REFERENCES "catalogue"."modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."modifier_group_links" ADD CONSTRAINT "modifier_group_links_tenant_id_menu_item_id_fkey" FOREIGN KEY ("tenant_id", "menu_item_id") REFERENCES "catalogue"."menu_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."modifier_group_links" ADD CONSTRAINT "modifier_group_links_tenant_id_modifier_group_id_fkey" FOREIGN KEY ("tenant_id", "modifier_group_id") REFERENCES "catalogue"."modifier_groups"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."price_lists" ADD CONSTRAINT "price_lists_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."price_entries" ADD CONSTRAINT "price_entries_tenant_id_price_list_id_fkey" FOREIGN KEY ("tenant_id", "price_list_id") REFERENCES "catalogue"."price_lists"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogue"."price_entries" ADD CONSTRAINT "price_entries_tenant_id_menu_item_variant_id_fkey" FOREIGN KEY ("tenant_id", "menu_item_variant_id") REFERENCES "catalogue"."menu_item_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Phase 16 — Catalogue: constraints, grants and RLS.
-- Hand-written because Prisma cannot express CHECK constraints, grants or RLS.
-- Ratified by the Phase 16 design gate (C-01 … C-11).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SRS §7.3 #8 / FR-MNU-011: min <= max, and required implies min >= 1.
-- Both come verbatim from the approved SQL.
-- ----------------------------------------------------------------------------
ALTER TABLE "catalogue"."modifier_groups"
  ADD CONSTRAINT "ck_min_le_max" CHECK ("min_selections" <= "max_selections");
ALTER TABLE "catalogue"."modifier_groups"
  ADD CONSTRAINT "ck_required_min" CHECK (NOT "is_required" OR "min_selections" >= 1);

-- ----------------------------------------------------------------------------
-- C-07: an availability rule targets EXACTLY ONE of menu_item / variant.
-- The approved SQL left both nullable with no stated rule, so both-null and
-- both-set were legal. The ratification requires the XOR invariant.
-- ----------------------------------------------------------------------------
ALTER TABLE "catalogue"."availability_rules"
  ADD CONSTRAINT "ck_availability_target_xor"
  CHECK (("menu_item_id" IS NOT NULL) <> ("variant_id" IS NOT NULL));

-- ----------------------------------------------------------------------------
-- Runtime role privileges (same pattern as Phases 8/9/12/15).
--
-- NOTE: an `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator ...` statement that
-- previously followed here was removed for Render deployment compatibility
-- (42501 permission denied — the connecting migration role there cannot SET
-- ROLE to ros_migrator). Future catalogue tables must grant ros_app explicitly.
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "catalogue" TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "catalogue" TO ros_app;

-- ----------------------------------------------------------------------------
-- RLS. Direct tenant_id anchor for 11 tables; the two pure children
-- (menu_item_images, modifiers) inherit through their parent via EXISTS,
-- following ADR 0003. Missing context -> NULL -> predicate false -> FAIL CLOSED.
-- ----------------------------------------------------------------------------

ALTER TABLE "catalogue"."menus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."menus" FORCE ROW LEVEL SECURITY;
CREATE POLICY menus_select ON "catalogue"."menus" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menus_insert ON "catalogue"."menus" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menus_update ON "catalogue"."menus" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menus_delete ON "catalogue"."menus" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."menu_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."menu_branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_branches_select ON "catalogue"."menu_branches" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_branches_insert ON "catalogue"."menu_branches" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_branches_update ON "catalogue"."menu_branches" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_branches_delete ON "catalogue"."menu_branches" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY categories_select ON "catalogue"."categories" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY categories_insert ON "catalogue"."categories" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY categories_update ON "catalogue"."categories" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY categories_delete ON "catalogue"."categories" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."menu_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."menu_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_items_select ON "catalogue"."menu_items" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_items_insert ON "catalogue"."menu_items" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_items_update ON "catalogue"."menu_items" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_items_delete ON "catalogue"."menu_items" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."menu_item_placements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."menu_item_placements" FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_item_placements_select ON "catalogue"."menu_item_placements" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_item_placements_insert ON "catalogue"."menu_item_placements" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_item_placements_update ON "catalogue"."menu_item_placements" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_item_placements_delete ON "catalogue"."menu_item_placements" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."menu_item_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."menu_item_variants" FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_item_variants_select ON "catalogue"."menu_item_variants" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_item_variants_insert ON "catalogue"."menu_item_variants" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_item_variants_update ON "catalogue"."menu_item_variants" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY menu_item_variants_delete ON "catalogue"."menu_item_variants" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."availability_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."availability_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY availability_rules_select ON "catalogue"."availability_rules" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY availability_rules_insert ON "catalogue"."availability_rules" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY availability_rules_update ON "catalogue"."availability_rules" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY availability_rules_delete ON "catalogue"."availability_rules" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."modifier_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."modifier_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY modifier_groups_select ON "catalogue"."modifier_groups" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_groups_insert ON "catalogue"."modifier_groups" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_groups_update ON "catalogue"."modifier_groups" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_groups_delete ON "catalogue"."modifier_groups" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."modifier_group_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."modifier_group_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY modifier_group_links_select ON "catalogue"."modifier_group_links" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_group_links_insert ON "catalogue"."modifier_group_links" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_group_links_update ON "catalogue"."modifier_group_links" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_group_links_delete ON "catalogue"."modifier_group_links" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."price_lists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."price_lists" FORCE ROW LEVEL SECURITY;
CREATE POLICY price_lists_select ON "catalogue"."price_lists" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY price_lists_insert ON "catalogue"."price_lists" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY price_lists_update ON "catalogue"."price_lists" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY price_lists_delete ON "catalogue"."price_lists" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."price_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."price_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY price_entries_select ON "catalogue"."price_entries" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY price_entries_insert ON "catalogue"."price_entries" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY price_entries_update ON "catalogue"."price_entries" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY price_entries_delete ON "catalogue"."price_entries" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "catalogue"."menu_item_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."menu_item_images" FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_item_images_select ON "catalogue"."menu_item_images" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "catalogue"."menu_items" p
                 WHERE p.id = menu_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY menu_item_images_insert ON "catalogue"."menu_item_images" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "catalogue"."menu_items" p
                 WHERE p.id = menu_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY menu_item_images_update ON "catalogue"."menu_item_images" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "catalogue"."menu_items" p
                 WHERE p.id = menu_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "catalogue"."menu_items" p
                 WHERE p.id = menu_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY menu_item_images_delete ON "catalogue"."menu_item_images" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "catalogue"."menu_items" p
                 WHERE p.id = menu_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "catalogue"."modifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalogue"."modifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY modifiers_select ON "catalogue"."modifiers" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "catalogue"."modifier_groups" p
                 WHERE p.id = modifier_group_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY modifiers_insert ON "catalogue"."modifiers" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "catalogue"."modifier_groups" p
                 WHERE p.id = modifier_group_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY modifiers_update ON "catalogue"."modifiers" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "catalogue"."modifier_groups" p
                 WHERE p.id = modifier_group_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "catalogue"."modifier_groups" p
                 WHERE p.id = modifier_group_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY modifiers_delete ON "catalogue"."modifiers" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "catalogue"."modifier_groups" p
                 WHERE p.id = modifier_group_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
