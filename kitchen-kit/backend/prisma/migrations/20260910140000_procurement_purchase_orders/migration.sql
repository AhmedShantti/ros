-- ---------------------------------------------------------------------------
-- FULL-SRS-PRC-PURCHASE-ORDERS-P2 — Procurement: Purchase Requisitions,
-- Purchase Orders, Approval (via the existing Governance runtime), and
-- Amendments (FR-PRC-015/016/017/018/019/023).
--
-- Hand-authored, following `20260910122221_procurement_supplier_foundation`'s
-- exact RLS/grant/composite-FK pattern (`prisma migrate dev`'s raw diff
-- against this database's replayed history also proposes a large number of
-- unrelated constraint/index RENAME statements across other schemas — none
-- of that is part of this migration).
-- ---------------------------------------------------------------------------

-- CreateEnum — FR-PRC-015 §minimum lifecycle.
CREATE TYPE "procurement"."PurchaseRequisitionStatus" AS ENUM ('draft', 'submitted', 'converted');

-- CreateEnum — FR-PRC-017 §6. `sent` deliberately absent (no real transmission
-- path exists in this slice).
CREATE TYPE "procurement"."PurchaseOrderStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'rejected');

-- CreateEnum — mirrors `org."LocationType"` exactly (mission brief §5).
CREATE TYPE "procurement"."PurchaseOrderDeliveryLocationType" AS ENUM ('branch', 'warehouse', 'central_kitchen');

-- CreateEnum — FR-PRC-018 value bands (D-5 RATIFIED single-step; §15.2
-- purchase.order.approve_tier_1/2/3).
CREATE TYPE "procurement"."PurchaseOrderApprovalBand" AS ENUM ('auto', 'tier_1', 'tier_2', 'tier_3');

-- ==================================================== PURCHASE REQUISITION =

-- CreateTable — FR-PRC-015 [S]. Tenant-scoped, branch-attributed purchasing
-- request. `requesting_branch_id`/`requested_by` are recorded ids with NO
-- cross-schema FK (module boundary — see this migration's header note).
CREATE TABLE "procurement"."purchase_requisitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requesting_branch_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" "procurement"."PurchaseRequisitionStatus" NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "submitted_at" TIMESTAMPTZ(6),

    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_requisitions_tenant_id_id_key" ON "procurement"."purchase_requisitions"("tenant_id", "id");
CREATE INDEX "purchase_requisitions_tenant_id_status_idx" ON "procurement"."purchase_requisitions"("tenant_id", "status");
CREATE INDEX "purchase_requisitions_tenant_id_requesting_branch_id_idx" ON "procurement"."purchase_requisitions"("tenant_id", "requesting_branch_id");

ALTER TABLE "procurement"."purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "procurement"."purchase_requisitions" TO ros_app;
REVOKE DELETE, TRUNCATE ON "procurement"."purchase_requisitions" FROM ros_app;

ALTER TABLE "procurement"."purchase_requisitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."purchase_requisitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_requisitions_select ON "procurement"."purchase_requisitions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_requisitions_insert ON "procurement"."purchase_requisitions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_requisitions_update ON "procurement"."purchase_requisitions" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- =============================================== PURCHASE REQUISITION LINE =

-- CreateTable — FR-PRC-015. "Consumed" state is derived by querying
-- `purchase_order_lines.source_requisition_line_id`, never stored here.
CREATE TABLE "procurement"."purchase_requisition_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "purchase_unit_id" UUID NOT NULL,
    "preferred_supplier_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "purchase_requisition_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_prl_quantity_positive" CHECK ("quantity" > 0)
);

CREATE UNIQUE INDEX "purchase_requisition_lines_tenant_id_id_key" ON "procurement"."purchase_requisition_lines"("tenant_id", "id");
CREATE INDEX "purchase_requisition_lines_tenant_id_requisition_id_idx" ON "procurement"."purchase_requisition_lines"("tenant_id", "requisition_id");

ALTER TABLE "procurement"."purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_tenant_id_requisition_id_fkey"
  FOREIGN KEY ("tenant_id", "requisition_id") REFERENCES "procurement"."purchase_requisitions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_tenant_id_preferred_supplier_fkey"
  FOREIGN KEY ("tenant_id", "preferred_supplier_id") REFERENCES "procurement"."suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "procurement"."purchase_requisition_lines" TO ros_app;
REVOKE DELETE, TRUNCATE ON "procurement"."purchase_requisition_lines" FROM ros_app;

ALTER TABLE "procurement"."purchase_requisition_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."purchase_requisition_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_requisition_lines_select ON "procurement"."purchase_requisition_lines" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_requisition_lines_insert ON "procurement"."purchase_requisition_lines" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_requisition_lines_update ON "procurement"."purchase_requisition_lines" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ========================================================= PURCHASE ORDER =

-- CreateTable — FR-PRC-016/017/018/019/023. See the Prisma model's own doc
-- comments for every field's meaning; `delivery_location_id` is a recorded
-- Organisation `org.locations.id` with NO cross-schema FK.
CREATE TABLE "procurement"."purchase_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "delivery_location_type" "procurement"."PurchaseOrderDeliveryLocationType" NOT NULL,
    "delivery_location_id" UUID NOT NULL,
    "expected_delivery_date" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "procurement"."PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "requested_by" UUID NOT NULL,
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "tax_total" BIGINT NOT NULL DEFAULT 0,
    "grand_total" BIGINT NOT NULL DEFAULT 0,
    "approval_band" "procurement"."PurchaseOrderApprovalBand",
    "approval_required_permission" VARCHAR(64),
    "approval_thresholds_snapshot" JSONB,
    "evaluated_total_at_submission" BIGINT,
    "approval_request_id" UUID,
    "approved_band" "procurement"."PurchaseOrderApprovalBand",
    "approved_at" TIMESTAMPTZ(6),
    "approved_by" UUID,
    "rejected_at" TIMESTAMPTZ(6),
    "rejected_by" UUID,
    "receiving_started_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_po_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "ck_po_subtotal_non_negative" CHECK ("subtotal" >= 0),
    CONSTRAINT "ck_po_tax_total_non_negative" CHECK ("tax_total" >= 0),
    CONSTRAINT "ck_po_grand_total_non_negative" CHECK ("grand_total" >= 0),
    CONSTRAINT "ck_po_grand_total_sum" CHECK ("grand_total" = "subtotal" + "tax_total"),
    CONSTRAINT "ck_po_version_positive" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "purchase_orders_tenant_id_id_key" ON "procurement"."purchase_orders"("tenant_id", "id");
CREATE INDEX "purchase_orders_tenant_id_status_idx" ON "procurement"."purchase_orders"("tenant_id", "status");
CREATE INDEX "purchase_orders_tenant_id_supplier_id_idx" ON "procurement"."purchase_orders"("tenant_id", "supplier_id");

ALTER TABLE "procurement"."purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "procurement"."suppliers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "procurement"."purchase_orders" TO ros_app;
REVOKE DELETE, TRUNCATE ON "procurement"."purchase_orders" FROM ros_app;

ALTER TABLE "procurement"."purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."purchase_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_select ON "procurement"."purchase_orders" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_orders_insert ON "procurement"."purchase_orders" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_orders_update ON "procurement"."purchase_orders" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ==================================================== PURCHASE ORDER LINE =

-- CreateTable — FR-PRC-016/017. `source_requisition_line_id` is UNIQUE (one
-- requisition line may be consolidated into at most one PO line — NULL
-- permitted many times, only non-null values are constrained).
CREATE TABLE "procurement"."purchase_order_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "purchase_unit_id" UUID NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "net_amount" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "supplier_price_entry_id" UUID,
    "source_requisition_line_id" UUID,
    "attribution_branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_pol_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "ck_pol_unit_price_non_negative" CHECK ("unit_price" >= 0),
    CONSTRAINT "ck_pol_net_amount_non_negative" CHECK ("net_amount" >= 0),
    CONSTRAINT "ck_pol_tax_amount_non_negative" CHECK ("tax_amount" >= 0),
    CONSTRAINT "ck_pol_line_total_sum" CHECK ("line_total" = "net_amount" + "tax_amount")
);

CREATE UNIQUE INDEX "purchase_order_lines_tenant_id_id_key" ON "procurement"."purchase_order_lines"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_po_line_source_requisition_line" ON "procurement"."purchase_order_lines"("tenant_id", "source_requisition_line_id");
CREATE INDEX "purchase_order_lines_tenant_id_purchase_order_id_idx" ON "procurement"."purchase_order_lines"("tenant_id", "purchase_order_id");

ALTER TABLE "procurement"."purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_purchase_order_id_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_id") REFERENCES "procurement"."purchase_orders"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_supplier_price_entry_fkey"
  FOREIGN KEY ("tenant_id", "supplier_price_entry_id") REFERENCES "procurement"."supplier_price_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "procurement"."purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_source_requisition_line_fkey"
  FOREIGN KEY ("tenant_id", "source_requisition_line_id") REFERENCES "procurement"."purchase_requisition_lines"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unlike `purchase_orders`/`purchase_requisitions` (mutable header rows,
-- never row-deleted) and `purchase_order_amendments` (append-only ledger,
-- §10), `purchase_order_lines` genuinely needs DELETE: `update()` (draft
-- line edits) and `amend()` (§10) replace a PO's line set wholesale
-- (delete-then-recreate) rather than diffing individual lines. This loses
-- no history — an amendment's full before/after line snapshot is already
-- captured immutably in `purchase_order_amendments.before_snapshot` /
-- `.after_snapshot` BEFORE the old lines are ever removed.
GRANT SELECT, INSERT, UPDATE, DELETE ON "procurement"."purchase_order_lines" TO ros_app;
REVOKE TRUNCATE ON "procurement"."purchase_order_lines" FROM ros_app;

ALTER TABLE "procurement"."purchase_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."purchase_order_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_lines_select ON "procurement"."purchase_order_lines" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_order_lines_insert ON "procurement"."purchase_order_lines" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_order_lines_update ON "procurement"."purchase_order_lines" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- =================================================== PURCHASE ORDER AMENDMENT

-- CreateTable — FR-PRC-023. Append-only (SELECT/INSERT-only grant below),
-- same immutable-ledger posture as `supplier_price_entries`.
CREATE TABLE "procurement"."purchase_order_amendments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "amendment_number" INTEGER NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "reason" TEXT NOT NULL,
    "before_snapshot" JSONB NOT NULL,
    "after_snapshot" JSONB NOT NULL,
    "old_total" BIGINT NOT NULL,
    "new_total" BIGINT NOT NULL,
    "old_approval_band" "procurement"."PurchaseOrderApprovalBand",
    "new_approval_band" "procurement"."PurchaseOrderApprovalBand",

    CONSTRAINT "purchase_order_amendments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_poa_amendment_number_positive" CHECK ("amendment_number" > 0)
);

CREATE UNIQUE INDEX "purchase_order_amendments_tenant_id_id_key" ON "procurement"."purchase_order_amendments"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_po_amendment_number" ON "procurement"."purchase_order_amendments"("tenant_id", "purchase_order_id", "amendment_number");
CREATE INDEX "purchase_order_amendments_tenant_id_purchase_order_id_idx" ON "procurement"."purchase_order_amendments"("tenant_id", "purchase_order_id");

ALTER TABLE "procurement"."purchase_order_amendments" ADD CONSTRAINT "purchase_order_amendments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "procurement"."purchase_order_amendments" ADD CONSTRAINT "purchase_order_amendments_tenant_id_purchase_order_id_fkey"
  FOREIGN KEY ("tenant_id", "purchase_order_id") REFERENCES "procurement"."purchase_orders"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only — ros_app may SELECT and INSERT only, identical to the
-- `supplier_price_entries` / `governance.audit_entries` precedent.
GRANT SELECT, INSERT ON "procurement"."purchase_order_amendments" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "procurement"."purchase_order_amendments" FROM ros_app;

ALTER TABLE "procurement"."purchase_order_amendments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."purchase_order_amendments" FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_amendments_select ON "procurement"."purchase_order_amendments" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY purchase_order_amendments_insert ON "procurement"."purchase_order_amendments" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
