-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "inventory";

-- CreateEnum
CREATE TYPE "inventory"."CostingMethod" AS ENUM ('weighted_average', 'fifo', 'standard');

-- CreateEnum
CREATE TYPE "inventory"."BatchStrategy" AS ENUM ('fifo', 'fefo');

-- CreateEnum
CREATE TYPE "inventory"."CountScope" AS ENUM ('full_location', 'category', 'item_list');

-- CreateEnum
CREATE TYPE "inventory"."CountSessionStatus" AS ENUM ('in_progress', 'posted', 'cancelled');

-- CreateEnum
CREATE TYPE "inventory"."MovementType" AS ENUM ('purchase_receipt', 'purchase_return', 'sale_depletion', 'sale_reversal', 'transfer_out', 'transfer_in', 'production_input', 'production_output', 'waste', 'count_adjustment', 'manual_adjustment', 'opening_balance', 'expiry_writeoff');

-- CreateTable
CREATE TABLE "inventory"."uom" (
    "id" UUID NOT NULL,
    "dimension" VARCHAR(16) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "base_unit_of_dimension" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "uom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."uom_conversions" (
    "id" UUID NOT NULL,
    "from_unit_id" UUID NOT NULL,
    "to_unit_id" UUID NOT NULL,
    "factor" DECIMAL(20,10) NOT NULL,
    "stock_item_id" UUID,

    CONSTRAINT "uom_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."packaging_units" (
    "id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "supplier_id" UUID,
    "name" VARCHAR(64) NOT NULL,
    "conversion_factor_to_base" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "packaging_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_item_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(120) NOT NULL,

    CONSTRAINT "stock_item_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sku" VARCHAR(32) NOT NULL,
    "names" JSONB NOT NULL,
    "category_id" UUID,
    "base_unit_id" UUID NOT NULL,
    "recipe_unit_id" UUID,
    "costing_method" "inventory"."CostingMethod" NOT NULL DEFAULT 'weighted_average',
    "standard_cost" BIGINT,
    "is_batch_tracked" BOOLEAN NOT NULL DEFAULT true,
    "expiry_tracked" BOOLEAN NOT NULL DEFAULT false,
    "shelf_life_days" INTEGER,
    "batch_strategy" "inventory"."BatchStrategy" NOT NULL DEFAULT 'fifo',
    "storage_requirements" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_item_reorder_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "reorder_point" DECIMAL(18,6),
    "reorder_quantity" DECIMAL(18,6),

    CONSTRAINT "stock_item_reorder_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "batch_number" VARCHAR(64),
    "production_date" DATE,
    "expiry_date" DATE,
    "quantity_received" DECIMAL(18,6) NOT NULL,
    "quantity_remaining" DECIMAL(18,6) NOT NULL,
    "unit_cost" BIGINT NOT NULL,
    "supplier_id" UUID,
    "goods_receipt_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_movements" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "batch_id" UUID,
    "movement_type" "inventory"."MovementType" NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "unit_cost" BIGINT NOT NULL,
    "total_cost" BIGINT NOT NULL,
    "balance_after" DECIMAL(18,6) NOT NULL,
    "reference_type" VARCHAR(32) NOT NULL,
    "reference_id" UUID NOT NULL,
    "counterpart_movement_id" UUID,
    "counterpart_occurred_at" TIMESTAMPTZ(6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performed_by" UUID NOT NULL,
    "reason_code_id" UUID,
    "notes" TEXT,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- CreateTable
CREATE TABLE "inventory"."stock_levels" (
    "tenant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity_on_hand" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "quantity_reserved" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "average_cost" BIGINT NOT NULL DEFAULT 0,
    "last_movement_id" UUID,
    "last_movement_occurred_at" TIMESTAMPTZ(6),
    "last_reconciled_at" TIMESTAMPTZ(6),

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("stock_item_id","location_id")
);

-- CreateTable
CREATE TABLE "inventory"."stock_level_batch_allocations" (
    "tenant_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "quantity_allocated" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "stock_level_batch_allocations_pkey" PRIMARY KEY ("stock_item_id","location_id","batch_id")
);

-- CreateTable
CREATE TABLE "inventory"."count_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "scope_type" "inventory"."CountScope" NOT NULL DEFAULT 'full_location',
    "scope_id" UUID,
    "status" "inventory"."CountSessionStatus" NOT NULL DEFAULT 'in_progress',
    "is_blind_count" BOOLEAN NOT NULL DEFAULT true,
    "started_by" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMPTZ(6),
    "posted_by" UUID,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "count_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."count_session_items" (
    "id" UUID NOT NULL,
    "count_session_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,

    CONSTRAINT "count_session_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."count_lines" (
    "id" UUID NOT NULL,
    "count_session_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "batch_id" UUID,
    "expected_quantity" DECIMAL(18,6),
    "counted_quantity" DECIMAL(18,6),
    "variance" DECIMAL(18,6),
    "recount_of_line_id" UUID,

    CONSTRAINT "count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."reason_codes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category" VARCHAR(16) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "label" JSONB NOT NULL,

    CONSTRAINT "reason_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."waste_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "reason_code_id" UUID NOT NULL,
    "total_value" BIGINT NOT NULL,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approval_request_id" UUID,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waste_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory"."waste_lines" (
    "id" UUID NOT NULL,
    "waste_record_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "batch_id" UUID,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_cost" BIGINT NOT NULL,

    CONSTRAINT "waste_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uom_code_key" ON "inventory"."uom"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_uom_conv" ON "inventory"."uom_conversions"("from_unit_id", "to_unit_id", "stock_item_id");

-- CreateIndex
CREATE INDEX "packaging_units_stock_item_id_idx" ON "inventory"."packaging_units"("stock_item_id");

-- CreateIndex
CREATE INDEX "stock_item_categories_tenant_id_idx" ON "inventory"."stock_item_categories"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_item_categories_tenant_id_id_key" ON "inventory"."stock_item_categories"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "stock_items_tenant_id_idx" ON "inventory"."stock_items"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenant_id_id_key" ON "inventory"."stock_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stock_item_sku" ON "inventory"."stock_items"("tenant_id", "sku");

-- CreateIndex
CREATE INDEX "stock_item_reorder_configs_tenant_id_location_id_idx" ON "inventory"."stock_item_reorder_configs"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_item_reorder_configs_tenant_id_stock_item_id_location_key" ON "inventory"."stock_item_reorder_configs"("tenant_id", "stock_item_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_batches_tenant_id_stock_item_id_location_id_idx" ON "inventory"."stock_batches"("tenant_id", "stock_item_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_batches_tenant_id_expiry_date_idx" ON "inventory"."stock_batches"("tenant_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_batches_tenant_id_id_key" ON "inventory"."stock_batches"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "idx_mv_item_loc_time" ON "inventory"."stock_movements"("stock_item_id", "location_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "idx_mv_reference" ON "inventory"."stock_movements"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_occurred_at_idx" ON "inventory"."stock_movements"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenant_id_id_occurred_at_key" ON "inventory"."stock_movements"("tenant_id", "id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_levels_tenant_id_location_id_stock_item_id_idx" ON "inventory"."stock_levels"("tenant_id", "location_id", "stock_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_levels_tenant_id_stock_item_id_location_id_key" ON "inventory"."stock_levels"("tenant_id", "stock_item_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_level_batch_allocations_tenant_id_batch_id_idx" ON "inventory"."stock_level_batch_allocations"("tenant_id", "batch_id");

-- CreateIndex
CREATE INDEX "count_sessions_tenant_id_location_id_idx" ON "inventory"."count_sessions"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "count_sessions_tenant_id_id_key" ON "inventory"."count_sessions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "count_session_items_count_session_id_stock_item_id_key" ON "inventory"."count_session_items"("count_session_id", "stock_item_id");

-- CreateIndex
CREATE INDEX "count_lines_count_session_id_idx" ON "inventory"."count_lines"("count_session_id");

-- CreateIndex
CREATE INDEX "reason_codes_tenant_id_idx" ON "inventory"."reason_codes"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "reason_codes_tenant_id_id_key" ON "inventory"."reason_codes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_reason_code" ON "inventory"."reason_codes"("tenant_id", "category", "code");

-- CreateIndex
CREATE INDEX "waste_records_tenant_id_location_id_idx" ON "inventory"."waste_records"("tenant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "waste_records_tenant_id_id_key" ON "inventory"."waste_records"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "waste_lines_waste_record_id_idx" ON "inventory"."waste_lines"("waste_record_id");

-- AddForeignKey
ALTER TABLE "inventory"."uom_conversions" ADD CONSTRAINT "uom_conversions_from_unit_id_fkey" FOREIGN KEY ("from_unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."uom_conversions" ADD CONSTRAINT "uom_conversions_to_unit_id_fkey" FOREIGN KEY ("to_unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."uom_conversions" ADD CONSTRAINT "uom_conversions_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "inventory"."stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."packaging_units" ADD CONSTRAINT "packaging_units_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "inventory"."stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_item_categories" ADD CONSTRAINT "stock_item_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_item_categories" ADD CONSTRAINT "stock_item_categories_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "inventory"."stock_item_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_items" ADD CONSTRAINT "stock_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_items" ADD CONSTRAINT "stock_items_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "inventory"."stock_item_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_items" ADD CONSTRAINT "stock_items_base_unit_id_fkey" FOREIGN KEY ("base_unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_items" ADD CONSTRAINT "stock_items_recipe_unit_id_fkey" FOREIGN KEY ("recipe_unit_id") REFERENCES "inventory"."uom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_item_reorder_configs" ADD CONSTRAINT "stock_item_reorder_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_item_reorder_configs" ADD CONSTRAINT "stock_item_reorder_configs_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_item_reorder_configs" ADD CONSTRAINT "stock_item_reorder_configs_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "stock_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "stock_batches_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "stock_batches_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "inventory"."stock_batches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_reason_code_id_fkey" FOREIGN KEY ("tenant_id", "reason_code_id") REFERENCES "inventory"."reason_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_counterpart_movement_id_counterp_fkey" FOREIGN KEY ("tenant_id", "counterpart_movement_id", "counterpart_occurred_at") REFERENCES "inventory"."stock_movements"("tenant_id", "id", "occurred_at") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_last_movement_id_last_movement_occu_fkey" FOREIGN KEY ("tenant_id", "last_movement_id", "last_movement_occurred_at") REFERENCES "inventory"."stock_movements"("tenant_id", "id", "occurred_at") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_level_batch_allocations" ADD CONSTRAINT "stock_level_batch_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_level_batch_allocations" ADD CONSTRAINT "stock_level_batch_allocations_tenant_id_stock_item_id_fkey" FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_level_batch_allocations" ADD CONSTRAINT "stock_level_batch_allocations_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."stock_level_batch_allocations" ADD CONSTRAINT "stock_level_batch_allocations_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "inventory"."stock_batches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_tenant_id_scope_id_fkey" FOREIGN KEY ("tenant_id", "scope_id") REFERENCES "inventory"."stock_item_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_sessions" ADD CONSTRAINT "count_sessions_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_session_items" ADD CONSTRAINT "count_session_items_count_session_id_fkey" FOREIGN KEY ("count_session_id") REFERENCES "inventory"."count_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_session_items" ADD CONSTRAINT "count_session_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "inventory"."stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_lines" ADD CONSTRAINT "count_lines_count_session_id_fkey" FOREIGN KEY ("count_session_id") REFERENCES "inventory"."count_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_lines" ADD CONSTRAINT "count_lines_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "inventory"."stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_lines" ADD CONSTRAINT "count_lines_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "inventory"."stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."count_lines" ADD CONSTRAINT "count_lines_recount_of_line_id_fkey" FOREIGN KEY ("recount_of_line_id") REFERENCES "inventory"."count_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."reason_codes" ADD CONSTRAINT "reason_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."waste_records" ADD CONSTRAINT "waste_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."waste_records" ADD CONSTRAINT "waste_records_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."waste_records" ADD CONSTRAINT "waste_records_tenant_id_reason_code_id_fkey" FOREIGN KEY ("tenant_id", "reason_code_id") REFERENCES "inventory"."reason_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."waste_records" ADD CONSTRAINT "waste_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."waste_lines" ADD CONSTRAINT "waste_lines_waste_record_id_fkey" FOREIGN KEY ("waste_record_id") REFERENCES "inventory"."waste_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."waste_lines" ADD CONSTRAINT "waste_lines_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "inventory"."stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."waste_lines" ADD CONSTRAINT "waste_lines_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "inventory"."stock_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- D-INV-01: initial monthly partitions. FR-DR-002 automated creation is
-- DEFERRED, so these are explicit. NOTE: there is deliberately NO DEFAULT
-- partition — an occurred_at outside the declared range is REJECTED rather
-- than silently absorbed. Pre-creating future partitions is therefore a
-- standing operational obligation until the scheduling phase lands.
CREATE TABLE "inventory"."stock_movements_2026_08" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2026_09" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2026_10" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2026_11" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2026_12" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_01" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_02" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_03" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_04" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_05" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_06" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-06-01 00:00:00+00') TO ('2027-07-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_07" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-07-01 00:00:00+00') TO ('2027-08-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_08" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-08-01 00:00:00+00') TO ('2027-09-01 00:00:00+00');
CREATE TABLE "inventory"."stock_movements_2027_09" PARTITION OF "inventory"."stock_movements"
  FOR VALUES FROM ('2027-09-01 00:00:00+00') TO ('2027-10-01 00:00:00+00');

-- ============================================================================
-- Inventory: constraints, privileges and RLS.
-- Hand-written because Prisma cannot express CHECK constraints, grants, RLS or
-- privilege revocation. Ratified by D-INV-01 … D-INV-09 (+ B-1, B-2).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Ledger CHECKs, verbatim from the approved SQL (SRS §7.4.3 / §25.2).
-- ck_batch_required and ck_reason_required are correct but INERT for the
-- purchase_*/production_* types, which have no writer in this phase.
-- ---------------------------------------------------------------------------
ALTER TABLE "inventory"."stock_movements"
  ADD CONSTRAINT "ck_movement_quantity_nonzero" CHECK ("quantity" <> 0);
ALTER TABLE "inventory"."stock_movements"
  ADD CONSTRAINT "ck_batch_required" CHECK (
    "movement_type" NOT IN ('purchase_receipt','production_output') OR "batch_id" IS NOT NULL);
ALTER TABLE "inventory"."stock_movements"
  ADD CONSTRAINT "ck_reason_required" CHECK (
    "movement_type" NOT IN ('waste','manual_adjustment') OR "reason_code_id" IS NOT NULL);

-- Batch invariants (SRS §7.3 #14), verbatim from the approved SQL.
ALTER TABLE "inventory"."stock_batches"
  ADD CONSTRAINT "ck_batch_qty_nonneg" CHECK ("quantity_remaining" >= 0);
ALTER TABLE "inventory"."stock_batches"
  ADD CONSTRAINT "ck_expiry_after_production" CHECK (
    "expiry_date" IS NULL OR "production_date" IS NULL OR "expiry_date" >= "production_date");

-- D-INV-05: scope_id is required for, and only for, a category-scoped session.
ALTER TABLE "inventory"."count_sessions"
  ADD CONSTRAINT "ck_count_scope" CHECK (
    ("scope_type" = 'category' AND "scope_id" IS NOT NULL)
    OR ("scope_type" <> 'category' AND "scope_id" IS NULL));

-- D-INV-03: standard costing requires a standard cost.
ALTER TABLE "inventory"."stock_items"
  ADD CONSTRAINT "ck_standard_cost_present" CHECK (
    "costing_method" <> 'standard' OR "standard_cost" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Runtime privileges. uom/uom_conversions/packaging_units are GLOBAL reference
-- data (no RLS), following the identity.permissions precedent (ADR 0003).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "inventory" TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "inventory"."uom", "inventory"."uom_conversions", "inventory"."packaging_units",
  "inventory"."stock_item_categories", "inventory"."stock_items",
  "inventory"."stock_item_reorder_configs", "inventory"."stock_batches",
  "inventory"."stock_levels", "inventory"."stock_level_batch_allocations",
  "inventory"."count_sessions", "inventory"."count_session_items",
  "inventory"."count_lines", "inventory"."waste_records", "inventory"."waste_lines",
  "inventory"."reason_codes"
  TO ros_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator IN SCHEMA "inventory"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;

-- ---------------------------------------------------------------------------
-- BR-INV-001 — the ledger is APPEND-ONLY, enforced at the database.
-- ros_app may only SELECT and INSERT; UPDATE/DELETE are revoked AND have no
-- policy. Identical to the governance.audit_entries pattern (ADR 0007).
-- Applied to the parent and to every partition.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON "inventory"."stock_movements" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "inventory"."stock_movements" FROM ros_app;
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT c.oid::regclass AS t FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
           WHERE i.inhparent = 'inventory.stock_movements'::regclass
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON %s TO ros_app', p.t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM ros_app', p.t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RLS. Direct tenant_id anchor for the tenant-scoped tables (D-INV-09 puts the
-- anchor on stock_levels and stock_level_batch_allocations so the hot path is
-- an index-friendly equality rather than a correlated EXISTS -- NFR-PERF-005).
-- Pure children inherit through their parent (ADR 0003).
-- uom / uom_conversions / packaging_units: see note below.
-- Missing context -> NULL -> predicate false -> FAIL CLOSED.
-- ---------------------------------------------------------------------------

ALTER TABLE "inventory"."stock_item_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_item_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_item_categories_select ON "inventory"."stock_item_categories" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_item_categories_insert ON "inventory"."stock_item_categories" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_item_categories_update ON "inventory"."stock_item_categories" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_item_categories_delete ON "inventory"."stock_item_categories" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."stock_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_items_select ON "inventory"."stock_items" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_items_insert ON "inventory"."stock_items" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_items_update ON "inventory"."stock_items" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_items_delete ON "inventory"."stock_items" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."stock_item_reorder_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_item_reorder_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_item_reorder_configs_select ON "inventory"."stock_item_reorder_configs" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_item_reorder_configs_insert ON "inventory"."stock_item_reorder_configs" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_item_reorder_configs_update ON "inventory"."stock_item_reorder_configs" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_item_reorder_configs_delete ON "inventory"."stock_item_reorder_configs" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."stock_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_batches_select ON "inventory"."stock_batches" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_batches_insert ON "inventory"."stock_batches" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_batches_update ON "inventory"."stock_batches" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_batches_delete ON "inventory"."stock_batches" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."stock_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_levels" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_levels_select ON "inventory"."stock_levels" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_levels_insert ON "inventory"."stock_levels" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_levels_update ON "inventory"."stock_levels" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_levels_delete ON "inventory"."stock_levels" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."stock_level_batch_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_level_batch_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_level_batch_allocations_select ON "inventory"."stock_level_batch_allocations" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_level_batch_allocations_insert ON "inventory"."stock_level_batch_allocations" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_level_batch_allocations_update ON "inventory"."stock_level_batch_allocations" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_level_batch_allocations_delete ON "inventory"."stock_level_batch_allocations" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."count_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."count_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY count_sessions_select ON "inventory"."count_sessions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY count_sessions_insert ON "inventory"."count_sessions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY count_sessions_update ON "inventory"."count_sessions" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY count_sessions_delete ON "inventory"."count_sessions" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."waste_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."waste_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY waste_records_select ON "inventory"."waste_records" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY waste_records_insert ON "inventory"."waste_records" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY waste_records_update ON "inventory"."waste_records" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY waste_records_delete ON "inventory"."waste_records" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."reason_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."reason_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY reason_codes_select ON "inventory"."reason_codes" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY reason_codes_insert ON "inventory"."reason_codes" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY reason_codes_update ON "inventory"."reason_codes" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY reason_codes_delete ON "inventory"."reason_codes" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- stock_movements: tenant-anchored, but APPEND-ONLY -- SELECT and INSERT
-- policies only. There is intentionally NO update/delete policy, mirroring
-- governance.audit_entries. RLS on a partitioned parent is inherited by every
-- partition automatically.
ALTER TABLE "inventory"."stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_select ON "inventory"."stock_movements" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY stock_movements_insert ON "inventory"."stock_movements" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Pure children -- tenant boundary inherited via the parent (ADR 0003).

ALTER TABLE "inventory"."packaging_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."packaging_units" FORCE ROW LEVEL SECURITY;
CREATE POLICY packaging_units_select ON "inventory"."packaging_units" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "inventory"."stock_items" p
                 WHERE p.id = stock_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY packaging_units_insert ON "inventory"."packaging_units" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."stock_items" p
                 WHERE p.id = stock_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY packaging_units_update ON "inventory"."packaging_units" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "inventory"."stock_items" p
                 WHERE p.id = stock_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."stock_items" p
                 WHERE p.id = stock_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY packaging_units_delete ON "inventory"."packaging_units" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "inventory"."stock_items" p
                 WHERE p.id = stock_item_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "inventory"."count_session_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."count_session_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY count_session_items_select ON "inventory"."count_session_items" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY count_session_items_insert ON "inventory"."count_session_items" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY count_session_items_update ON "inventory"."count_session_items" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY count_session_items_delete ON "inventory"."count_session_items" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "inventory"."count_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."count_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY count_lines_select ON "inventory"."count_lines" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY count_lines_insert ON "inventory"."count_lines" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY count_lines_update ON "inventory"."count_lines" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY count_lines_delete ON "inventory"."count_lines" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "inventory"."count_sessions" p
                 WHERE p.id = count_session_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE "inventory"."waste_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."waste_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY waste_lines_select ON "inventory"."waste_lines" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "inventory"."waste_records" p
                 WHERE p.id = waste_record_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY waste_lines_insert ON "inventory"."waste_lines" FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."waste_records" p
                 WHERE p.id = waste_record_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY waste_lines_update ON "inventory"."waste_lines" FOR UPDATE
  USING (EXISTS (SELECT 1 FROM "inventory"."waste_records" p
                 WHERE p.id = waste_record_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM "inventory"."waste_records" p
                 WHERE p.id = waste_record_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY waste_lines_delete ON "inventory"."waste_lines" FOR DELETE
  USING (EXISTS (SELECT 1 FROM "inventory"."waste_records" p
                 WHERE p.id = waste_record_id AND p.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid));

-- uom and uom_conversions are GLOBAL, un-tenanted platform reference data in the
-- approved SQL and are deliberately NOT RLS-scoped, following the
-- identity.permissions precedent (ADR 0003 "Excluded tables"). The residual
-- question of whether item-specific density rows in uom_conversions should be
-- tenant-isolated is a documented open item, not resolved here.

