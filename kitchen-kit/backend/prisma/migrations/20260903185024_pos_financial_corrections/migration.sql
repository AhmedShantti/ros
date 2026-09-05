-- ---------------------------------------------------------------------------
-- POS-FIN-1 — Production financial corrections: discounts/comps, approval
-- thresholds, post-fire void disposition, append-only refunds.
--
-- Authority: SRS §8.3.2 (FR-POS-045..051), §8.5 (FR-POS-070..075), §15.6
-- (FR-SEC-030..035), Chapter 20 (FR-AUD-001/006), CR-04, BR-POS-001/002.
--
-- NOTE ON SCOPE: `prisma migrate dev --create-only` against this branch's
-- schema diff also reported a large amount of PRE-EXISTING drift unrelated
-- to this slice (constraint/index renames and re-adds across `kitchen`,
-- `treasury`, `workforce`, `catalogue`, `inventory` — apparently cosmetic
-- naming differences between how those constraints were originally hand-
-- authored and how this Prisma version would name them today). None of that
-- is reproduced here: this migration contains ONLY the new POS-FIN-1
-- objects below. No pre-existing table, column, constraint or index outside
-- `sales.discount_approval_policy_versions` / `sales.discounts` /
-- `sales.post_fire_void_records` / `sales.refunds` is touched.
--
-- D-13 (RATIFIED): Sales, not Governance, evaluates approval thresholds and
-- calls the generic `governance.approval_requests`/`approval_decisions`
-- contract — no second approval table is created here. Every table below is
-- APPEND-ONLY at the DB-grant level (SELECT+INSERT only), the same CR-04/
-- ADR-010 discipline `sales.order_payments`/`governance.audit_entries`
-- already use, copying the exact RLS/GRANTS shape of migration 32
-- (`20260829010000_governance_approval_runtime`).
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "sales"."DiscountKind" AS ENUM ('discount', 'comp');

-- CreateEnum
CREATE TYPE "sales"."DiscountValueType" AS ENUM ('percentage', 'fixed');

-- CreateEnum
CREATE TYPE "sales"."PostFireVoidDisposition" AS ENUM ('returned_to_stock', 'wasted', 'given_to_staff');

-- CreateTable
CREATE TABLE "sales"."discount_approval_policy_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "max_percent_without_approval_bp" BIGINT,
    "max_amount_without_approval_minor" BIGINT,
    "max_discounts_per_shift_per_employee" INTEGER,
    "discount_after_payment_started_allowed" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_approval_policy_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_discount_policy_max_percent_bp_range"
      CHECK ("max_percent_without_approval_bp" IS NULL OR ("max_percent_without_approval_bp" >= 0 AND "max_percent_without_approval_bp" <= 10000)),
    CONSTRAINT "ck_discount_policy_max_amount_nonneg"
      CHECK ("max_amount_without_approval_minor" IS NULL OR "max_amount_without_approval_minor" >= 0),
    CONSTRAINT "ck_discount_policy_max_per_shift_nonneg"
      CHECK ("max_discounts_per_shift_per_employee" IS NULL OR "max_discounts_per_shift_per_employee" >= 0)
);

-- CreateTable
CREATE TABLE "sales"."discounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "order_line_id" UUID,
    "kind" "sales"."DiscountKind" NOT NULL,
    "value_type" "sales"."DiscountValueType",
    "percentage_value_bp" BIGINT,
    "fixed_value_minor" BIGINT,
    "amount_minor" BIGINT NOT NULL,
    "reason_code_id" UUID NOT NULL,
    "applied_by_employee_id" UUID NOT NULL,
    "applied_by_user_id" UUID NOT NULL,
    "approval_required" BOOLEAN NOT NULL,
    "approved_by_employee_id" UUID,
    "approved_by_user_id" UUID,
    "approval_request_id" UUID,
    "order_version_after" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id"),
    -- FR-POS-045 "%  or fixed amount"; FR-POS-050 comp carries neither.
    CONSTRAINT "ck_discount_value_shape" CHECK (
      ("kind" = 'comp' AND "value_type" IS NULL AND "percentage_value_bp" IS NULL AND "fixed_value_minor" IS NULL)
      OR ("kind" = 'discount' AND "value_type" = 'percentage' AND "percentage_value_bp" IS NOT NULL AND "percentage_value_bp" >= 0 AND "percentage_value_bp" <= 10000 AND "fixed_value_minor" IS NULL)
      OR ("kind" = 'discount' AND "value_type" = 'fixed' AND "fixed_value_minor" IS NOT NULL AND "fixed_value_minor" > 0 AND "percentage_value_bp" IS NULL)
    ),
    CONSTRAINT "ck_discount_amount_nonneg" CHECK ("amount_minor" >= 0)
);

-- CreateTable
CREATE TABLE "sales"."post_fire_void_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "order_line_id" UUID NOT NULL,
    "disposition" "sales"."PostFireVoidDisposition" NOT NULL,
    "reason_code_id" UUID NOT NULL,
    "financial_amount_removed" BIGINT NOT NULL,
    "inventory_movement_ids" JSONB NOT NULL DEFAULT '[]',
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_fire_void_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_post_fire_void_amount_nonneg" CHECK ("financial_amount_removed" >= 0)
);

-- CreateTable
CREATE TABLE "sales"."refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "refund_business_day" DATE NOT NULL,
    "original_payment_id" UUID NOT NULL,
    "tender" "sales"."OrderPaymentTender" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "cash_session_id" UUID,
    "reason_code_id" UUID NOT NULL,
    "applied_by_employee_id" UUID NOT NULL,
    "applied_by_user_id" UUID NOT NULL,
    "approval_required" BOOLEAN NOT NULL,
    "approved_by_employee_id" UUID,
    "approved_by_user_id" UUID,
    "approval_request_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_refund_amount_positive" CHECK ("amount_minor" > 0),
    -- FR-POS-074 default path needs a session when the payout is cash.
    CONSTRAINT "ck_refund_cash_session_required_for_cash" CHECK (
      ("tender" = 'cash' AND "cash_session_id" IS NOT NULL)
      OR ("tender" = 'manual_external_card' AND "cash_session_id" IS NULL)
    )
);

-- CreateIndex
CREATE INDEX "discount_approval_policy_versions_tenant_id_branch_id_creat_idx" ON "sales"."discount_approval_policy_versions"("tenant_id", "branch_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "discount_approval_policy_versions_tenant_id_id_key" ON "sales"."discount_approval_policy_versions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "discounts_tenant_id_order_id_business_day_idx" ON "sales"."discounts"("tenant_id", "order_id", "business_day");

-- CreateIndex
CREATE INDEX "discounts_tenant_id_branch_id_applied_by_user_id_created_at_idx" ON "sales"."discounts"("tenant_id", "branch_id", "applied_by_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "discounts_tenant_id_id_key" ON "sales"."discounts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "post_fire_void_records_tenant_id_order_id_business_day_idx" ON "sales"."post_fire_void_records"("tenant_id", "order_id", "business_day");

-- CreateIndex
CREATE INDEX "post_fire_void_records_tenant_id_order_line_id_idx" ON "sales"."post_fire_void_records"("tenant_id", "order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_fire_void_records_tenant_id_id_key" ON "sales"."post_fire_void_records"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_order_id_business_day_idx" ON "sales"."refunds"("tenant_id", "order_id", "business_day");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_branch_id_refund_business_day_idx" ON "sales"."refunds"("tenant_id", "branch_id", "refund_business_day");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_tenant_id_id_key" ON "sales"."refunds"("tenant_id", "id");

-- AddForeignKey — branch-inclusive, the same `uq_orders_tenant_id_business_day_branch`
-- target `sales.order_payments` already uses, so a row's branch_id disagreeing
-- with its own order's branch is structurally unrepresentable.
ALTER TABLE "sales"."discounts" ADD CONSTRAINT "discounts_tenant_id_order_id_business_day_branch_id_fkey" FOREIGN KEY ("tenant_id", "order_id", "business_day", "branch_id") REFERENCES "sales"."orders"("tenant_id", "id", "business_day", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales"."post_fire_void_records" ADD CONSTRAINT "post_fire_void_records_tenant_id_order_id_business_day_bra_fkey" FOREIGN KEY ("tenant_id", "order_id", "business_day", "branch_id") REFERENCES "sales"."orders"("tenant_id", "id", "business_day", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales"."post_fire_void_records" ADD CONSTRAINT "post_fire_void_records_tenant_id_order_line_id_business_da_fkey" FOREIGN KEY ("tenant_id", "order_line_id", "business_day") REFERENCES "sales"."order_lines"("tenant_id", "id", "business_day") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales"."refunds" ADD CONSTRAINT "refunds_tenant_id_order_id_business_day_branch_id_fkey" FOREIGN KEY ("tenant_id", "order_id", "business_day", "branch_id") REFERENCES "sales"."orders"("tenant_id", "id", "business_day", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- discount_approval_policy_versions: append-only, mirroring CashClosePolicy
-- (migration 33) — a configuration CHANGE is a new immutable version.
GRANT SELECT, INSERT ON "sales"."discount_approval_policy_versions" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sales"."discount_approval_policy_versions" FROM ros_app;

-- discounts / post_fire_void_records / refunds: append-only (CR-04 /
-- BR-POS-001) — the original Order/OrderLine/OrderPayment rows these
-- reference are never mutated by any code path that touches these tables.
GRANT SELECT, INSERT ON "sales"."discounts" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sales"."discounts" FROM ros_app;

GRANT SELECT, INSERT ON "sales"."post_fire_void_records" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sales"."post_fire_void_records" FROM ros_app;

GRANT SELECT, INSERT ON "sales"."refunds" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sales"."refunds" FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "sales"."discount_approval_policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."discount_approval_policy_versions" FORCE ROW LEVEL SECURITY;

CREATE POLICY discount_approval_policy_versions_select ON "sales"."discount_approval_policy_versions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY discount_approval_policy_versions_insert ON "sales"."discount_approval_policy_versions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."discounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."discounts" FORCE ROW LEVEL SECURITY;

CREATE POLICY discounts_select ON "sales"."discounts" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY discounts_insert ON "sales"."discounts" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."post_fire_void_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."post_fire_void_records" FORCE ROW LEVEL SECURITY;

CREATE POLICY post_fire_void_records_select ON "sales"."post_fire_void_records" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY post_fire_void_records_insert ON "sales"."post_fire_void_records" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."refunds" FORCE ROW LEVEL SECURITY;

CREATE POLICY refunds_select ON "sales"."refunds" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY refunds_insert ON "sales"."refunds" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No UPDATE/DELETE policy on any of the four tables — fully append-only,
-- and UPDATE/DELETE/TRUNCATE are already revoked above (defence in depth).
