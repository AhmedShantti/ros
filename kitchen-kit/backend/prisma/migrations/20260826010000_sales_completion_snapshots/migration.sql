-- ---------------------------------------------------------------------------
-- P1F-2 migration 28 (Sales) — Final Payment + Order Completion snapshots.
--
-- Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
-- correction.md (CONTROLLING) §L. Three LINE-CAPTURE snapshot tables that
-- pin the exact recipe-version closure, modifier effects, and unit-conversion
-- factors a line was captured with, so Completion (planConsumption) resolves
-- consumption ONLY from what was true at sale time — never from whatever is
-- published/configured now. Also: the `orders.state = 'completed'` invariant
-- (SRS §25.2) and the `order_lines.posted_cogs_total` projection column.
--
-- ── APPEND-ONLY (ADR-010, P1D-C precedent) ──────────────────────────────────
-- All three new tables: `ros_app` gets SELECT + INSERT only, UPDATE/DELETE
-- revoked, RLS defines SELECT/INSERT policies only. A line-capture snapshot
-- is written once, at capture, and never revisited.
--
-- ── NOT PARTITIONED ──────────────────────────────────────────────────────
-- Same pattern as `order_line_modifiers`/`order_line_station_overrides`: each
-- is a leaf reached only through its order line, carrying `business_day`
-- solely to hold a tenant-safe composite FK into the partitioned `orders`
-- lineage — none is in FR-DR-001's partition list.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------- ORDERS / LINES
-- SRS §25.2 — a completed order always carries its completion instant.
ALTER TABLE "sales"."orders" ADD CONSTRAINT "ck_completed"
  CHECK ("state" <> 'completed' OR "completed_at" IS NOT NULL);

-- FR-CST-002 (PARTIAL) — a DISTINCT posted-COGS fact, never a rewrite of
-- `unit_cost_snapshot`. Exact bigint SUM of the line's Inventory ALLOCATION
-- total_cost values, written ONLY by Completion. Absent recipe posts 0
-- (never NULL); NULL means "not yet completed".
ALTER TABLE "sales"."order_lines" ADD COLUMN "posted_cogs_total" BIGINT;
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "ck_order_lines_posted_cogs_total_nonneg"
  CHECK ("posted_cogs_total" IS NULL OR "posted_cogs_total" >= 0);

-- ------------------------------------------------------------- CREATE ENUM
CREATE TYPE "sales"."ModifierEffectOperationSnapshot" AS ENUM ('add', 'remove_all');
CREATE TYPE "sales"."RecipeComponentTypeSnapshot" AS ENUM ('stock_item', 'sub_recipe');

-- --------------------------------------- order_line_recipe_versions (pin)
-- The pinned recipe-version CLOSURE for one line: its own base version at
-- depth 0, and every sub-recipe version reachable from it at depth >= 1.
-- `planConsumption` at Completion resolves sub-recipes ONLY to versions
-- pinned here — never to whatever is currently published.
CREATE TABLE "sales"."order_line_recipe_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "order_line_id" UUID NOT NULL,
    "recipe_version_id" UUID NOT NULL,
    "depth" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_recipe_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_olrv_depth_nonneg" CHECK ("depth" >= 0)
);

CREATE UNIQUE INDEX "order_line_recipe_versions_tenant_line_day_version_key"
  ON "sales"."order_line_recipe_versions"("tenant_id", "order_line_id", "business_day", "recipe_version_id");

ALTER TABLE "sales"."order_line_recipe_versions" ADD CONSTRAINT "order_line_recipe_versions_tenant_id_order_line_id_business_day_fkey"
  FOREIGN KEY ("tenant_id", "order_line_id", "business_day")
  REFERENCES "sales"."order_lines"("tenant_id", "id", "business_day") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_recipe_versions" ADD CONSTRAINT "order_line_recipe_versions_tenant_id_recipe_version_id_fkey"
  FOREIGN KEY ("tenant_id", "recipe_version_id")
  REFERENCES "production"."recipe_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------- order_line_modifier_effects (pin)
-- The pinned modifier effects selected on the line, copied verbatim from
-- `production.modifier_recipe_effects` at capture time. A later edit to the
-- source Modifier's recipe effects never changes an already-captured line.
CREATE TABLE "sales"."order_line_modifier_effects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "order_line_id" UUID NOT NULL,
    "order_line_modifier_id" UUID NOT NULL,
    "operation" "sales"."ModifierEffectOperationSnapshot" NOT NULL,
    "component_type" "sales"."RecipeComponentTypeSnapshot" NOT NULL,
    "stock_item_id" UUID,
    "sub_recipe_version_id" UUID,
    "quantity" DECIMAL(18,6),
    "unit_id" UUID,
    "sequence" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_modifier_effects_pkey" PRIMARY KEY ("id"),
    -- XOR: exactly one of stock_item_id / sub_recipe_version_id, matching component_type.
    CONSTRAINT "ck_olme_component_xor" CHECK (
      ("component_type" = 'stock_item' AND "stock_item_id" IS NOT NULL AND "sub_recipe_version_id" IS NULL)
      OR
      ("component_type" = 'sub_recipe' AND "sub_recipe_version_id" IS NOT NULL AND "stock_item_id" IS NULL)
    ),
    -- remove_all targets a stock_item only, and carries no quantity/unit;
    -- add always carries a positive quantity and a unit.
    CONSTRAINT "ck_olme_operation" CHECK (
      ("operation" = 'remove_all' AND "component_type" = 'stock_item' AND "quantity" IS NULL AND "unit_id" IS NULL)
      OR
      ("operation" = 'add' AND "quantity" > 0 AND "unit_id" IS NOT NULL)
    )
);

CREATE INDEX "order_line_modifier_effects_tenant_line_day_idx"
  ON "sales"."order_line_modifier_effects"("tenant_id", "order_line_id", "business_day");

ALTER TABLE "sales"."order_line_modifier_effects" ADD CONSTRAINT "order_line_modifier_effects_tenant_id_order_line_modifier_id_fkey"
  FOREIGN KEY ("tenant_id", "order_line_modifier_id")
  REFERENCES "sales"."order_line_modifiers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_modifier_effects" ADD CONSTRAINT "order_line_modifier_effects_tenant_id_order_line_id_business_day_fkey"
  FOREIGN KEY ("tenant_id", "order_line_id", "business_day")
  REFERENCES "sales"."order_lines"("tenant_id", "id", "business_day") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_modifier_effects" ADD CONSTRAINT "order_line_modifier_effects_tenant_id_stock_item_id_fkey"
  FOREIGN KEY ("tenant_id", "stock_item_id")
  REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_modifier_effects" ADD CONSTRAINT "order_line_modifier_effects_tenant_id_sub_recipe_version_id_fkey"
  FOREIGN KEY ("tenant_id", "sub_recipe_version_id")
  REFERENCES "production"."recipe_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_modifier_effects" ADD CONSTRAINT "order_line_modifier_effects_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------- order_line_component_conversions (pin)
-- The pinned unit-conversion FACTOR from a component's line unit to the
-- stock item's base unit, at capture time. `planConsumption` at Completion
-- takes conversion factors ONLY from here — never from
-- `inventory.uom_conversions` or `stock_items.base_unit_id` directly, so a
-- later change to either can never alter an already-completed depletion.
CREATE TABLE "sales"."order_line_component_conversions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "order_line_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "from_unit_id" UUID NOT NULL,
    "base_unit_id" UUID NOT NULL,
    "factor" DECIMAL(20,10) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_component_conversions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_olcc_factor_positive" CHECK ("factor" > 0)
);

CREATE UNIQUE INDEX "order_line_component_conversions_tenant_line_item_from_unit_key"
  ON "sales"."order_line_component_conversions"("tenant_id", "order_line_id", "stock_item_id", "from_unit_id");

ALTER TABLE "sales"."order_line_component_conversions" ADD CONSTRAINT "order_line_component_conversions_tenant_id_order_line_id_business_day_fkey"
  FOREIGN KEY ("tenant_id", "order_line_id", "business_day")
  REFERENCES "sales"."order_lines"("tenant_id", "id", "business_day") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_component_conversions" ADD CONSTRAINT "order_line_component_conversions_tenant_id_stock_item_id_fkey"
  FOREIGN KEY ("tenant_id", "stock_item_id")
  REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_component_conversions" ADD CONSTRAINT "order_line_component_conversions_from_unit_id_fkey"
  FOREIGN KEY ("from_unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_component_conversions" ADD CONSTRAINT "order_line_component_conversions_base_unit_id_fkey"
  FOREIGN KEY ("base_unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT SELECT, INSERT ON
  "sales"."order_line_recipe_versions",
  "sales"."order_line_modifier_effects",
  "sales"."order_line_component_conversions"
  TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON
  "sales"."order_line_recipe_versions",
  "sales"."order_line_modifier_effects",
  "sales"."order_line_component_conversions"
  FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "sales"."order_line_recipe_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_line_recipe_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_recipe_versions_select ON "sales"."order_line_recipe_versions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_recipe_versions_insert ON "sales"."order_line_recipe_versions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."order_line_modifier_effects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_line_modifier_effects" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_modifier_effects_select ON "sales"."order_line_modifier_effects" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_modifier_effects_insert ON "sales"."order_line_modifier_effects" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."order_line_component_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_line_component_conversions" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_component_conversions_select ON "sales"."order_line_component_conversions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_component_conversions_insert ON "sales"."order_line_component_conversions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
