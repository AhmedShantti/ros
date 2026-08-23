-- P1E-3 — Sales-owned prerequisites for FR-KDS-010:
--   1. tenant-safe FK from a captured modifier selection to its Catalogue
--      modifier, now possible because `20260821010000_catalogue_modifier_tenancy`
--      gave `catalogue.modifiers` a `(tenant_id, id)` unique target;
--   2. two ADDITIVE, index-only unique keys on the partitioned Order/OrderLine
--      parents (K-1 — no column added to every line; see P1E-2 §K);
--   3. `sales.order_line_station_overrides` — FR-KDS-010 tier 1 (explicit
--      line-level station override), 0..N stations per line (FR-KDS-011).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. order_line_modifiers.modifier_id was FK-less (P1E-2 §F). Now tenant-safe.
-- `ON DELETE RESTRICT`: a modifier referenced by captured sale history must
-- not disappear out from under it — unlike the line's own FK, which cascades
-- with the ORDER's lifecycle, not the catalogue's.
-- ----------------------------------------------------------------------------
ALTER TABLE "sales"."order_line_modifiers"
  ADD CONSTRAINT "order_line_modifiers_tenant_id_modifier_id_fkey"
    FOREIGN KEY ("tenant_id", "modifier_id")
    REFERENCES "catalogue"."modifiers"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "order_line_modifiers_tenant_id_modifier_id_idx"
  ON "sales"."order_line_modifiers"("tenant_id", "modifier_id");

-- ----------------------------------------------------------------------------
-- 2. K-1 — additive unique indexes on the partitioned parents. Both include
-- business_day (the partition key), which PostgreSQL requires for any unique
-- index on a partitioned table. No column is added; no row is rewritten.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX "uq_orders_tenant_id_business_day_branch"
  ON "sales"."orders"("tenant_id", "id", "business_day", "branch_id");

CREATE UNIQUE INDEX "uq_order_lines_tenant_order_id_business_day"
  ON "sales"."order_lines"("tenant_id", "order_id", "id", "business_day");

-- ----------------------------------------------------------------------------
-- 3. order_line_station_overrides. NOT partitioned — a leaf reached only
-- through its line, the same pattern as order_line_modifiers, and not in
-- FR-DR-001's partition list.
-- ----------------------------------------------------------------------------
CREATE TABLE "sales"."order_line_station_overrides" (
    "id"            UUID NOT NULL,
    "tenant_id"     UUID NOT NULL,
    "order_id"      UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "business_day"  DATE NOT NULL,
    "branch_id"     UUID NOT NULL,
    "station_id"    UUID NOT NULL,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_station_overrides_pkey" PRIMARY KEY ("id")
);

-- Prevents a duplicate destination on one line.
CREATE UNIQUE INDEX "uq_order_line_station_overrides_line_station"
  ON "sales"."order_line_station_overrides"("tenant_id", "order_line_id", "business_day", "station_id");
CREATE INDEX "order_line_station_overrides_tenant_id_order_line_id_idx"
  ON "sales"."order_line_station_overrides"("tenant_id", "order_line_id", "business_day");

ALTER TABLE "sales"."order_line_station_overrides"
  ADD CONSTRAINT "order_line_station_overrides_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Proves branch_id IS the order's own branch — the K-1 chain, step 1.
ALTER TABLE "sales"."order_line_station_overrides"
  ADD CONSTRAINT "order_line_station_overrides_order_fkey"
    FOREIGN KEY ("tenant_id", "order_id", "business_day", "branch_id")
    REFERENCES "sales"."orders"("tenant_id", "id", "business_day", "branch_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Proves this line belongs to that same order — the K-1 chain, step 2.
ALTER TABLE "sales"."order_line_station_overrides"
  ADD CONSTRAINT "order_line_station_overrides_line_fkey"
    FOREIGN KEY ("tenant_id", "order_id", "order_line_id", "business_day")
    REFERENCES "sales"."order_lines"("tenant_id", "order_id", "id", "business_day")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Proves the station belongs to that same branch (D-09) — the K-1 chain, step 3.
-- Together the three FKs make "override targets a station outside the order's
-- own branch" structurally unrepresentable — no application-only check.
ALTER TABLE "sales"."order_line_station_overrides"
  ADD CONSTRAINT "order_line_station_overrides_branch_id_station_id_fkey"
    FOREIGN KEY ("branch_id", "station_id")
    REFERENCES "org"."stations"("branch_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "sales"."order_line_station_overrides" TO ros_app;

ALTER TABLE "sales"."order_line_station_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_line_station_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_station_overrides_select ON "sales"."order_line_station_overrides" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_station_overrides_insert ON "sales"."order_line_station_overrides" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_station_overrides_update ON "sales"."order_line_station_overrides" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_station_overrides_delete ON "sales"."order_line_station_overrides" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
