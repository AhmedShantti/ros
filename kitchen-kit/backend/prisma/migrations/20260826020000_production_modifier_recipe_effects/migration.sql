-- ---------------------------------------------------------------------------
-- P1F-2 migration 29 (Production) — Modifier recipe effects.
--
-- Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
-- correction.md (CONTROLLING) §L. D-17-07 resolution: `catalogue.
-- modifiers.recipe_delta` stays PERMANENTLY opaque and unread (P1E-5); this
-- table is the real, structured replacement Sales' resolveConsumptionBasis
-- reads at LINE CAPTURE. Full-replace via `PUT /modifiers/{id}/recipe-
-- effects`, so — unlike the P1F-2 Sales snapshot tables — this one is
-- mutable (SELECT/INSERT/UPDATE/DELETE), matching `production.recipe_lines`'
-- own append/replace shape.
-- ---------------------------------------------------------------------------

CREATE TYPE "production"."ModifierEffectOperation" AS ENUM ('add', 'remove_all');

-- REUSES the EXISTING "production"."RecipeComponentType" enum
-- ('stock_item' | 'sub_recipe') — no new component-type enum here.
CREATE TABLE "production"."modifier_recipe_effects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "modifier_id" UUID NOT NULL,
    "operation" "production"."ModifierEffectOperation" NOT NULL,
    "component_type" "production"."RecipeComponentType" NOT NULL,
    "stock_item_id" UUID,
    "sub_recipe_id" UUID,
    "quantity" DECIMAL(18,6),
    "unit_id" UUID,
    "sequence" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_recipe_effects_pkey" PRIMARY KEY ("id"),
    -- XOR: exactly one of stock_item_id / sub_recipe_id, matching component_type.
    -- sub_recipe_id is the LOGICAL recipe identity (resolved to its published
    -- version at line-capture time), unlike Sales' pinned-version snapshot.
    CONSTRAINT "ck_mre_component_xor" CHECK (
      ("component_type" = 'stock_item' AND "stock_item_id" IS NOT NULL AND "sub_recipe_id" IS NULL)
      OR
      ("component_type" = 'sub_recipe' AND "sub_recipe_id" IS NOT NULL AND "stock_item_id" IS NULL)
    ),
    -- remove_all targets a stock_item only, and carries no quantity/unit;
    -- add always carries a positive quantity and a unit.
    CONSTRAINT "ck_mre_operation" CHECK (
      ("operation" = 'remove_all' AND "component_type" = 'stock_item' AND "quantity" IS NULL AND "unit_id" IS NULL)
      OR
      ("operation" = 'add' AND "quantity" > 0 AND "unit_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "modifier_recipe_effects_tenant_id_id_key"
  ON "production"."modifier_recipe_effects"("tenant_id", "id");
CREATE INDEX "modifier_recipe_effects_tenant_id_modifier_id_idx"
  ON "production"."modifier_recipe_effects"("tenant_id", "modifier_id");

ALTER TABLE "production"."modifier_recipe_effects" ADD CONSTRAINT "modifier_recipe_effects_tenant_id_modifier_id_fkey"
  FOREIGN KEY ("tenant_id", "modifier_id")
  REFERENCES "catalogue"."modifiers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production"."modifier_recipe_effects" ADD CONSTRAINT "modifier_recipe_effects_tenant_id_stock_item_id_fkey"
  FOREIGN KEY ("tenant_id", "stock_item_id")
  REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production"."modifier_recipe_effects" ADD CONSTRAINT "modifier_recipe_effects_tenant_id_sub_recipe_id_fkey"
  FOREIGN KEY ("tenant_id", "sub_recipe_id")
  REFERENCES "production"."recipes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production"."modifier_recipe_effects" ADD CONSTRAINT "modifier_recipe_effects_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT SELECT, INSERT, UPDATE, DELETE ON "production"."modifier_recipe_effects" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "production"."modifier_recipe_effects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production"."modifier_recipe_effects" FORCE ROW LEVEL SECURITY;
CREATE POLICY modifier_recipe_effects_select ON "production"."modifier_recipe_effects" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_recipe_effects_insert ON "production"."modifier_recipe_effects" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_recipe_effects_update ON "production"."modifier_recipe_effects" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY modifier_recipe_effects_delete ON "production"."modifier_recipe_effects" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
