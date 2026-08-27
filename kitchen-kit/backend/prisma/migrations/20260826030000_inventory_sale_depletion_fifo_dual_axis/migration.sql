-- ---------------------------------------------------------------------------
-- P1F-2 migration 30 (Inventory) — Sale depletion, dual-axis FIFO/FEFO.
--
-- Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
-- correction.md (CONTROLLING) §C, §G, §H. ORDER MATTERS in this file — the
-- guard must run before the CHECK is added, which must run before the
-- counter column exists, which must be backfilled before the new unique
-- index and the two new tables are created.
--
-- ── TWO INDEPENDENT AXES (never conflated) ──────────────────────────────────
-- `quantity_remaining`            — PHYSICAL axis (unchanged, pre-existing).
-- `fifo_cost_quantity_consumed`   — NEW FIFO ACCOUNTING (receipt-order) axis.
-- The physical axis decides WHICH batch is decremented (batch_strategy:
-- fifo|fefo); the accounting axis decides WHAT COST is charged for
-- costing_method=fifo, strictly in RECEIPT order, regardless of physical
-- strategy. "consumed" (not "remaining") so DEFAULT 0 gives every new batch
-- full cost quantity and NO existing batch-creation writer changes.
-- ---------------------------------------------------------------------------

-- ------------------------------------------------------------------ 1 GUARD
-- Fail loudly rather than invent state: the receipt-order backfill below
-- (step 4) can only be truthful if quantity_remaining has NEVER exceeded
-- quantity_received. Audited: the ONLY batch mutation site in `src/` is
-- movements.service.ts's `{ quantityRemaining: { decrement } }` — there is
-- no increment, no refill, no upsert anywhere — but the invariant itself has
-- never been DB-enforced until step 2 below, so it is verified, not assumed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "inventory"."stock_batches"
             WHERE "quantity_remaining" > "quantity_received") THEN
    RAISE EXCEPTION
      'P1F-2 migration 30: stock_batches contains rows with quantity_remaining > '
      'quantity_received; the FIFO accounting backfill cannot be truthfully derived. '
      'Investigate before migrating.';
  END IF;
END $$;

-- -------------------------------------------------------- 2 STRUCTURAL CHECK
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "ck_batch_qty_within_received"
  CHECK ("quantity_remaining" <= "quantity_received");

-- --------------------------------------------------------------- 3 COUNTER
ALTER TABLE "inventory"."stock_batches"
  ADD COLUMN "fifo_cost_quantity_consumed" DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE "inventory"."stock_batches" ADD CONSTRAINT "ck_batch_cost_qty_range"
  CHECK ("fifo_cost_quantity_consumed" >= 0 AND "fifo_cost_quantity_consumed" <= "quantity_received");

-- ------------------------------------------------- 4 RECEIPT-ORDER BACKFILL
-- Exact DECIMAL window arithmetic, FIFO batch-tracked items ONLY. Does NOT
-- seed from each batch's OWN physical consumption
-- (`quantity_received - quantity_remaining` per row) — that is provably
-- wrong the moment costing_method=fifo and batch_strategy=fefo diverge
-- (P1F2E-A §C's own counterexample). Instead: compute the TOTAL physically
-- consumed per (tenant, stock_item, location), then re-allocate that total
-- through the layers in RECEIPT order —
--   consumed_i = min(received_i, max(TOTAL - cum_received_before_i, 0))
-- with no floating point anywhere. Non-FIFO / non-batch-tracked items are
-- untouched and remain at DEFAULT 0, where this column is not an accounting
-- authority.
WITH scoped AS (
  SELECT b.id,
         b.quantity_received,
         COALESCE(SUM(b.quantity_received) OVER (
           PARTITION BY b.tenant_id, b.stock_item_id, b.location_id
           ORDER BY b.created_at, b.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_received_before,
         SUM(b.quantity_received - b.quantity_remaining) OVER (
           PARTITION BY b.tenant_id, b.stock_item_id, b.location_id)     AS total_consumed
  FROM "inventory"."stock_batches" b
  JOIN "inventory"."stock_items" i
    ON i.tenant_id = b.tenant_id AND i.id = b.stock_item_id
  WHERE i.costing_method = 'fifo' AND i.is_batch_tracked
)
UPDATE "inventory"."stock_batches" t
   SET "fifo_cost_quantity_consumed" =
       LEAST(s.quantity_received, GREATEST(s.total_consumed - s.cum_received_before, 0))
  FROM scoped s
 WHERE t.id = s.id;

-- ---------------------------------------------------- 5 STRUCTURAL FK TARGET
-- Additive: no column added, no semantics changed (D-16 precedent). Proves an
-- allocation's physical/cost-basis batch belongs to the SAME stock item and
-- location as its parent effect (P1F2E-A §G).
CREATE UNIQUE INDEX "stock_batches_tenant_id_id_item_location_key"
  ON "inventory"."stock_batches"("tenant_id", "id", "stock_item_id", "location_id");

-- ------------------------------------------------- 6 sale_depletion_effects
-- NON-partitioned PARENT / business identity. One row per (OrderLine,
-- StockItem, Location) touched by a completed sale, reserved FIRST — before
-- ANY Inventory mutation (P1F2E-A §E) — via `INSERT ... ON CONFLICT (...) DO
-- NOTHING`. NO cost columns, NO movement columns here.
CREATE TABLE "inventory"."sale_depletion_effects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "order_line_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity_in_base_unit" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_depletion_effects_pkey" PRIMARY KEY ("id")
);

-- Business identity — the reservation key (P1F2E-A §E).
CREATE UNIQUE INDEX "sale_depletion_effects_tenant_line_item_location_key"
  ON "inventory"."sale_depletion_effects"("tenant_id", "order_line_id", "stock_item_id", "location_id");
-- FK target for the child, proving the child's item/location ARE this
-- effect's (P1F2E-A §G structural correction).
CREATE UNIQUE INDEX "sale_depletion_effects_tenant_id_id_item_location_key"
  ON "inventory"."sale_depletion_effects"("tenant_id", "id", "stock_item_id", "location_id");

ALTER TABLE "inventory"."sale_depletion_effects" ADD CONSTRAINT "sale_depletion_effects_tenant_id_order_id_order_line_id_business_day_fkey"
  FOREIGN KEY ("tenant_id", "order_id", "order_line_id", "business_day")
  REFERENCES "sales"."order_lines"("tenant_id", "order_id", "id", "business_day") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."sale_depletion_effects" ADD CONSTRAINT "sale_depletion_effects_tenant_id_stock_item_id_fkey"
  FOREIGN KEY ("tenant_id", "stock_item_id")
  REFERENCES "inventory"."stock_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."sale_depletion_effects" ADD CONSTRAINT "sale_depletion_effects_tenant_id_location_id_fkey"
  FOREIGN KEY ("tenant_id", "location_id")
  REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."sale_depletion_effects" ADD CONSTRAINT "sale_depletion_effects_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------- 7 sale_depletion_allocations
-- NON-partitioned CHILD. One row per (physical batch, cost layer) slice the
-- zipper emitted for one effect. `stock_item_id`/`location_id` are a
-- deliberate, minimal redundancy (copied from the parent) that exists SOLELY
-- to make the composite structural FKs below expressible.
CREATE TABLE "inventory"."sale_depletion_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "effect_id" UUID NOT NULL,
    "sequence" SMALLINT NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "physical_batch_id" UUID,
    "cost_basis_batch_id" UUID,
    "quantity_in_base_unit" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "unit_cost" BIGINT NOT NULL,
    "total_cost" BIGINT NOT NULL,
    "movement_id" UUID NOT NULL,
    "movement_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_depletion_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_sda_quantity_positive" CHECK ("quantity_in_base_unit" > 0)
);

CREATE UNIQUE INDEX "sale_depletion_allocations_tenant_effect_sequence_key"
  ON "inventory"."sale_depletion_allocations"("tenant_id", "effect_id", "sequence");
CREATE INDEX "sale_depletion_allocations_tenant_id_effect_id_idx"
  ON "inventory"."sale_depletion_allocations"("tenant_id", "effect_id");
CREATE INDEX "sale_depletion_allocations_tenant_id_physical_batch_id_idx"
  ON "inventory"."sale_depletion_allocations"("tenant_id", "physical_batch_id");
CREATE INDEX "sale_depletion_allocations_tenant_id_cost_basis_batch_id_idx"
  ON "inventory"."sale_depletion_allocations"("tenant_id", "cost_basis_batch_id");

-- Composite FKs default to MATCH SIMPLE: a NULL physical_batch_id (unbacked)
-- or NULL cost_basis_batch_id (weighted_average/standard) disables that FK —
-- exactly the desired behaviour, since stock_item_id/location_id stay
-- NOT NULL. No MATCH FULL anywhere.
ALTER TABLE "inventory"."sale_depletion_allocations" ADD CONSTRAINT "sale_depletion_allocations_tenant_id_effect_id_item_location_fkey"
  FOREIGN KEY ("tenant_id", "effect_id", "stock_item_id", "location_id")
  REFERENCES "inventory"."sale_depletion_effects"("tenant_id", "id", "stock_item_id", "location_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."sale_depletion_allocations" ADD CONSTRAINT "sale_depletion_allocations_tenant_id_physical_batch_item_location_fkey"
  FOREIGN KEY ("tenant_id", "physical_batch_id", "stock_item_id", "location_id")
  REFERENCES "inventory"."stock_batches"("tenant_id", "id", "stock_item_id", "location_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."sale_depletion_allocations" ADD CONSTRAINT "sale_depletion_allocations_tenant_id_cost_basis_batch_item_location_fkey"
  FOREIGN KEY ("tenant_id", "cost_basis_batch_id", "stock_item_id", "location_id")
  REFERENCES "inventory"."stock_batches"("tenant_id", "id", "stock_item_id", "location_id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Deliberately NOT structural for item/location (P1F2E-A §G) — a fourth
-- unique index on the RANGE-partitioned, highest-volume `stock_movements`
-- table was rejected as a permanent tax on the hottest write path. The
-- movement's item/location binding is SERVICE-ENFORCED and tested as such.
ALTER TABLE "inventory"."sale_depletion_allocations" ADD CONSTRAINT "sale_depletion_allocations_tenant_id_movement_id_occurred_at_fkey"
  FOREIGN KEY ("tenant_id", "movement_id", "movement_occurred_at")
  REFERENCES "inventory"."stock_movements"("tenant_id", "id", "occurred_at") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."sale_depletion_allocations" ADD CONSTRAINT "sale_depletion_allocations_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "inventory"."uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- 8 GRANTS
-- Append-only, same pattern as every other P1F sale-history table.
GRANT SELECT, INSERT ON
  "inventory"."sale_depletion_effects",
  "inventory"."sale_depletion_allocations"
  TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON
  "inventory"."sale_depletion_effects",
  "inventory"."sale_depletion_allocations"
  FROM ros_app;

-- ------------------------------------------------------------------- 8 RLS
ALTER TABLE "inventory"."sale_depletion_effects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."sale_depletion_effects" FORCE ROW LEVEL SECURITY;
CREATE POLICY sale_depletion_effects_select ON "inventory"."sale_depletion_effects" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY sale_depletion_effects_insert ON "inventory"."sale_depletion_effects" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "inventory"."sale_depletion_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."sale_depletion_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY sale_depletion_allocations_select ON "inventory"."sale_depletion_allocations" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY sale_depletion_allocations_insert ON "inventory"."sale_depletion_allocations" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 9 — deliberately NO change to `stock_movements` or `stock_levels`: no new
-- column, no new index, no partition work.
