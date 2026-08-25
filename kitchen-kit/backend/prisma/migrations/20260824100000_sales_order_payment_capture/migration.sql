-- ---------------------------------------------------------------------------
-- P1F-1 — Sales Payment MVP: partial CASH + manual/external card capture.
--
-- Implements SRS §7.3 #22 / §7.4.1 (paid_total, rounding_adjustment already
-- exist on `orders`), §8.4 Payment (FR-POS-060/061/063/065/066), §16.7
-- (BR-FIN-004), and the ratified P1D-B..G carried items
-- (docs/governance/GOVERNANCE_DECISION_REGISTER.md).
--
-- ── APPEND-ONLY (ADR-010, P1D-C) ────────────────────────────────────────────
-- Same pattern as `governance.audit_entries`: `ros_app` gets SELECT + INSERT
-- only, UPDATE/DELETE explicitly revoked, and RLS defines no update/delete
-- policy at all. There is no mutable `status` column — P1D-C is exactly the
-- rule that a successful Payment is immutable and CASH/MANUAL_EXTERNAL_CARD
-- in this MVP have no PaymentAttempt lifecycle to model.
--
-- ── NOT PARTITIONED ──────────────────────────────────────────────────────
-- Mirrors `order_line_modifiers` / `order_line_station_overrides`: a leaf
-- reached only through its order, carrying `business_day` solely so it can
-- hold a tenant-safe composite FK to the partitioned `orders` table — not in
-- FR-DR-001's partition list.
--
-- ── CASHSESSION FK — TENANT-SAFE, NOT BRANCH-SAFE ───────────────────────────
-- `treasury.cash_sessions` exposes only `(tenant_id, id)` as a composite
-- unique target (no `(tenant_id, branch_id, id)`). A branch-safe composite FK
-- would require a NEW additive index on a Treasury-owned table — a separate
-- Treasury migration this slice does not make. Branch (and employee,
-- terminal, currency, open-status) matching is validated at the service
-- layer instead, through Treasury's public `CashSessionFactsQuery` contract
-- (SRS §5.4) — see `sales-payment.service.ts`. The FK below still makes
-- cross-TENANT attachment structurally impossible, which is the RLS-relevant
-- invariant.
--
-- ── P1F-1A CORRECTION (in place — this migration is still uncommitted) ─────
-- Two FKs below were strengthened from the original P1F-1 draft, both using
-- EXISTING targets (no new Sales/Identity index):
--   Order FK   — now BRANCH-INCLUSIVE: `(tenant_id, order_id, business_day,
--                branch_id) -> sales.orders(tenant_id, id, business_day,
--                branch_id)`, using the P1E-3 `uq_orders_tenant_id_business_
--                day_branch` target — so `order_payments.branch_id`
--                disagreeing with the referenced order's own branch is now
--                structurally unrepresentable (ADR 0008 D-09), not merely
--                service-validated.
--   Terminal FK — now BRANCH-SAFE: `(branch_id, terminal_id) -> identity.
--                terminals(branch_id, id)`, the ADR 0008 D-16 target
--                `treasury.drawers.terminal` already uses — not the older,
--                acknowledged single-column `orders.terminal_id ->
--                identity.terminals(id)` weakness this new table does not
--                repeat merely because that precedent exists.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "sales"."OrderPaymentTender" AS ENUM ('cash', 'manual_external_card');

-- CreateTable
CREATE TABLE "sales"."order_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "tender" "sales"."OrderPaymentTender" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "rounding_adjustment" BIGINT NOT NULL DEFAULT 0,
    "cash_session_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "tendered_amount" BIGINT,
    "change_given" BIGINT,
    "payment_terminal_txn_ref" VARCHAR(64),
    "card_scheme" VARCHAR(32),
    "card_last4" VARCHAR(4),
    "authorization_code" VARCHAR(32),
    "processed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_order_payments_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "ck_order_payments_last4" CHECK ("card_last4" IS NULL OR "card_last4" ~ '^[0-9]{4}$'),
    -- CASH carries tendered/change and NO card metadata.
    CONSTRAINT "ck_order_payments_cash_fields" CHECK (
      "tender" <> 'cash' OR (
        "tendered_amount" IS NOT NULL AND "change_given" IS NOT NULL
        AND "payment_terminal_txn_ref" IS NULL AND "card_scheme" IS NULL
        AND "card_last4" IS NULL AND "authorization_code" IS NULL
      )
    ),
    -- MANUAL_EXTERNAL_CARD carries a terminal reference, zero rounding
    -- (BR-FIN-004: only the cash portion ever rounds), and NO cash fields.
    CONSTRAINT "ck_order_payments_card_fields" CHECK (
      "tender" <> 'manual_external_card' OR (
        "payment_terminal_txn_ref" IS NOT NULL AND "rounding_adjustment" = 0
        AND "tendered_amount" IS NULL AND "change_given" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "order_payments_tenant_id_id_key" ON "sales"."order_payments"("tenant_id", "id");
CREATE INDEX "order_payments_tenant_order_idx" ON "sales"."order_payments"("tenant_id", "order_id", "business_day");
CREATE INDEX "order_payments_tenant_cash_session_idx" ON "sales"."order_payments"("tenant_id", "cash_session_id");

-- --------------------------------------------------------- FOREIGN KEYS ---
-- BRANCH-INCLUSIVE (P1F-1A): reuses the EXISTING P1E-3 target
-- `uq_orders_tenant_id_business_day_branch` — no new Sales index.
ALTER TABLE "sales"."order_payments" ADD CONSTRAINT "order_payments_tenant_id_order_id_business_day_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "order_id", "business_day", "branch_id")
  REFERENCES "sales"."orders"("tenant_id", "id", "business_day", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_payments" ADD CONSTRAINT "order_payments_tenant_id_cash_session_id_fkey"
  FOREIGN KEY ("tenant_id", "cash_session_id")
  REFERENCES "treasury"."cash_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_payments" ADD CONSTRAINT "order_payments_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- BRANCH-SAFE (P1F-1A): reuses the EXISTING ADR 0008 D-16 target
-- `identity.terminals(branch_id, id)` — the same one `treasury.drawers`
-- already uses for its own terminal binding — instead of repeating the
-- older, acknowledged single-column `orders.terminal_id -> identity.
-- terminals(id)` weakness in this new table.
ALTER TABLE "sales"."order_payments" ADD CONSTRAINT "order_payments_branch_id_terminal_id_fkey"
  FOREIGN KEY ("branch_id", "terminal_id") REFERENCES "identity"."terminals"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- Append-only: SELECT + INSERT only, UPDATE/DELETE explicitly revoked.
GRANT SELECT, INSERT ON "sales"."order_payments" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sales"."order_payments" FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "sales"."order_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_payments" FORCE ROW LEVEL SECURITY;

-- Read + append are tenant-scoped; there is intentionally NO update/delete policy.
CREATE POLICY order_payments_select ON "sales"."order_payments" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_payments_insert ON "sales"."order_payments" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
