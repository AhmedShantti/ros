-- ---------------------------------------------------------------------------
-- FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1 — Procurement: Supplier master, Item
-- sourcing, Price lists (FR-PRC-005/006/007/008 [partial], FR-INV-005).
--
-- NOTE ON SCOPE: `prisma migrate dev --create-only`'s raw diff against this
-- database's replayed migration history also proposed a large number of
-- unrelated DROP/RENAME CONSTRAINT and RENAME INDEX statements across
-- catalogue/inventory/kitchen/sales/treasury/workforce tables (Prisma
-- re-canonicalizing constraint/index names for relations untouched by this
-- slice). None of that is part of this migration — this file contains ONLY
-- the new `procurement` schema and its three tables.
-- ---------------------------------------------------------------------------

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "procurement";

-- CreateEnum — FR-PRC-005. Exactly two states; no approval/suspension
-- workflow invented (mission brief §2).
CREATE TYPE "procurement"."SupplierStatus" AS ENUM ('active', 'inactive');

-- ============================================================ SUPPLIER =====

-- CreateTable — FR-PRC-005 [M]. Tenant-scoped Supplier master.
CREATE TABLE "procurement"."suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "legal_name" VARCHAR(255) NOT NULL,
    "trading_name" VARCHAR(255),
    "tax_registration_number" VARCHAR(64),
    "addresses" JSONB NOT NULL DEFAULT '[]',
    "contacts" JSONB NOT NULL DEFAULT '[]',
    "payment_terms_net_days" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "delivery_lead_time_days" INTEGER NOT NULL,
    "minimum_order_value" BIGINT NOT NULL,
    "delivery_days" INTEGER[],
    "status" "procurement"."SupplierStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_supplier_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "ck_supplier_payment_terms_non_negative" CHECK ("payment_terms_net_days" >= 0),
    CONSTRAINT "ck_supplier_lead_time_non_negative" CHECK ("delivery_lead_time_days" >= 0),
    CONSTRAINT "ck_supplier_min_order_value_non_negative" CHECK ("minimum_order_value" >= 0)
);

CREATE INDEX "suppliers_tenant_id_idx" ON "procurement"."suppliers"("tenant_id");
CREATE UNIQUE INDEX "suppliers_tenant_id_id_key" ON "procurement"."suppliers"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_supplier_code" ON "procurement"."suppliers"("tenant_id", "code");

ALTER TABLE "procurement"."suppliers" ADD CONSTRAINT "suppliers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT USAGE ON SCHEMA "procurement" TO ros_app;
GRANT SELECT, INSERT, UPDATE ON "procurement"."suppliers" TO ros_app;
REVOKE DELETE, TRUNCATE ON "procurement"."suppliers" FROM ros_app;

ALTER TABLE "procurement"."suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY suppliers_select ON "procurement"."suppliers" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY suppliers_insert ON "procurement"."suppliers" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY suppliers_update ON "procurement"."suppliers" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- =================================================== SUPPLIER ITEM LINK ====

-- CreateTable — FR-PRC-007 / FR-INV-005. Tenant-scoped Supplier <-> StockItem
-- sourcing relationship. `stock_item_id` is a recorded Inventory id with NO
-- cross-schema FK (module boundary — see this migration's header note and
-- `inventory.packaging_units.supplier_id`'s identical precedent).
CREATE TABLE "procurement"."supplier_item_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "supplier_item_code" VARCHAR(64),
    "supplier_barcodes" TEXT[] NOT NULL DEFAULT '{}',
    "preference_rank" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "supplier_item_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_supplier_item_link_preference_rank_non_negative" CHECK ("preference_rank" >= 0)
);

CREATE INDEX "supplier_item_links_tenant_id_stock_item_id_idx" ON "procurement"."supplier_item_links"("tenant_id", "stock_item_id");
CREATE UNIQUE INDEX "supplier_item_links_tenant_id_id_key" ON "procurement"."supplier_item_links"("tenant_id", "id");
-- D-16 precedent (e.g. `stock_batches_tenant_id_id_item_location_key`): lets
-- `supplier_price_entries`' composite FK structurally guarantee its
-- `supplier_id` matches the link's own supplier — no service cross-check needed.
CREATE UNIQUE INDEX "uq_supplier_item_link_supplier_scope" ON "procurement"."supplier_item_links"("tenant_id", "supplier_id", "id");
CREATE UNIQUE INDEX "uq_supplier_item_link" ON "procurement"."supplier_item_links"("tenant_id", "supplier_id", "stock_item_id");

ALTER TABLE "procurement"."supplier_item_links" ADD CONSTRAINT "supplier_item_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."supplier_item_links" ADD CONSTRAINT "supplier_item_links_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "procurement"."suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "procurement"."supplier_item_links" TO ros_app;
REVOKE DELETE, TRUNCATE ON "procurement"."supplier_item_links" FROM ros_app;

ALTER TABLE "procurement"."supplier_item_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."supplier_item_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_item_links_select ON "procurement"."supplier_item_links" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY supplier_item_links_insert ON "procurement"."supplier_item_links" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY supplier_item_links_update ON "procurement"."supplier_item_links" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- =================================================== SUPPLIER PRICE ENTRY ==

-- CreateTable — FR-PRC-006. IMMUTABLE historical agreed-price record (§7: a
-- new agreed price is a NEW row, never an update). `purchase_unit_id` is a
-- recorded Inventory id with NO cross-schema FK (same module-boundary
-- reasoning as `stock_item_id` above).
CREATE TABLE "procurement"."supplier_price_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_item_link_id" UUID NOT NULL,
    "purchase_unit_id" UUID NOT NULL,
    "pack_size" DECIMAL(18,6) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "volume_tiers" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "supplier_price_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_supplier_price_entry_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "ck_supplier_price_entry_pack_size_positive" CHECK ("pack_size" > 0),
    CONSTRAINT "ck_supplier_price_entry_unit_price_non_negative" CHECK ("unit_price" >= 0),
    CONSTRAINT "ck_supplier_price_entry_window_order" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from")
);

CREATE INDEX "supplier_price_entries_tenant_id_supplier_item_link_id_purc_idx" ON "procurement"."supplier_price_entries"("tenant_id", "supplier_item_link_id", "purchase_unit_id", "valid_from");
CREATE UNIQUE INDEX "supplier_price_entries_tenant_id_id_key" ON "procurement"."supplier_price_entries"("tenant_id", "id");

ALTER TABLE "procurement"."supplier_price_entries" ADD CONSTRAINT "supplier_price_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."supplier_price_entries" ADD CONSTRAINT "supplier_price_entries_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "procurement"."suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "procurement"."supplier_price_entries" ADD CONSTRAINT "supplier_price_entries_tenant_id_supplier_id_supplier_item_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id", "supplier_item_link_id") REFERENCES "procurement"."supplier_item_links"("tenant_id", "supplier_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only history — ros_app may SELECT and INSERT only, identical to the
-- `governance.audit_entries` / `inventory.stock_movements` / HR-1
-- `employee_compensations` precedent.
GRANT SELECT, INSERT ON "procurement"."supplier_price_entries" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "procurement"."supplier_price_entries" FROM ros_app;

ALTER TABLE "procurement"."supplier_price_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."supplier_price_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_price_entries_select ON "procurement"."supplier_price_entries" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY supplier_price_entries_insert ON "procurement"."supplier_price_entries" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- §7 — "If overlapping validity windows for the SAME supplier + item +
-- purchase unit + volume tier scope would create two equally applicable
-- agreed prices, reject the ambiguous configuration." A volume-tier schedule
-- is embedded whole in one row (see the model's own doc comment), so the key
-- below IS that full scope: two rows for the same (supplier item link,
-- purchase unit) can never have overlapping validity windows, which is
-- exactly "at most one applicable agreed price (and its tier schedule) at
-- any instant". Same `ex_price_list_no_overlap` / `ex_scheduled_shift_no_overlap`
-- precedent (migrations `20260819120000_price_list_no_overlap`,
-- `20260904010000_workforce_core_employee_schedule_attendance`); `btree_gist`
-- is already installed by the first of those, `CREATE EXTENSION IF NOT
-- EXISTS` repeated here only for this file's own self-containment.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "procurement"."supplier_price_entries"
  ADD CONSTRAINT "ex_supplier_price_entry_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "supplier_item_link_id" WITH =,
    "purchase_unit_id" WITH =,
    tstzrange("valid_from", "valid_until") WITH &&
  );

COMMENT ON CONSTRAINT "ex_supplier_price_entry_no_overlap" ON "procurement"."supplier_price_entries" IS
  'FR-PRC-006 §7: no two simultaneously-effective agreed prices for the same supplier item link + purchase unit. Half-open [valid_from, valid_until) — two windows that merely touch at an instant do not overlap.';
