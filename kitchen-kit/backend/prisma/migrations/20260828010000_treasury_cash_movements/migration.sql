-- ---------------------------------------------------------------------------
-- P1G-0 migration 31 (Treasury) — Mid-shift cash movements: PAY_IN, PAY_OUT,
-- SAFE_DROP (FR-POS-091 [M]).
--
-- Authority: docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md
-- (CONTROLLING) §7/§B. Supplies exactly the three missing FR-FIN-004 [M]
-- expected-cash terms this slice owns (Pay-ins, Pay-outs, Safe Drops). Does
-- NOT implement CashSession close, count, variance, approval, X report, or
-- the FR-POS-092 drawer limit (all four of its parameters are undecided —
-- gate §5). No `expected_cash` column anywhere; this table is a source-fact
-- ledger, never a projection.
--
-- ── APPEND-ONLY ──────────────────────────────────────────────────────────
-- `ros_app` gets SELECT + INSERT only; UPDATE/DELETE/TRUNCATE revoked. RLS
-- defines SELECT/INSERT policies only. A movement is recorded once, at the
-- moment it is declared, and never revisited (CR-04 / immutable-financial-
-- record posture, matching every other posted-financial table in this repo).
--
-- ── PERMANENT IDENTITY (FR-OFF-015) ─────────────────────────────────────────
-- `id` is a CLIENT-GENERATED ULID rendered as UUID. The device assigns it;
-- the server never reassigns it. Idempotency-Key alone is not sufficient —
-- §21.3's local data model lists "Shifts, cash sessions, drawer events" as
-- synced Up/Continuous, so this is a device-created, offline-capable entity.
-- ---------------------------------------------------------------------------

CREATE TYPE "treasury"."CashMovementType" AS ENUM ('pay_in', 'pay_out', 'safe_drop');

CREATE TABLE "treasury"."cash_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    -- Deliberate denormalisation (design gate §7): needed at the FK/index
    -- level for branch-safe attribution, auth, and audit. drawer_id/shift_id
    -- are NOT copied — both are immutably reachable via cash_session_id.
    "branch_id" UUID NOT NULL,
    "cash_session_id" UUID NOT NULL,
    -- P1D-E: the accountable business actor is the EMPLOYEE, not the login user.
    "employee_id" UUID NOT NULL,
    "movement_type" "treasury"."CashMovementType" NOT NULL,
    -- POSITIVE magnitude, minor units (design gate §2 Option A). The type
    -- column supplies the sign; a client can never submit a negative amount.
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    -- FR-POS-091 [M] literal: "each with reason and amount" — mandatory for
    -- ALL THREE movement types, never optional.
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The identity USER who transmitted the movement (mirrors
    -- inventory.stock_movements.performed_by), distinct from employee_id.
    "performed_by" UUID NOT NULL,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_cash_movement_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "ck_cash_movement_reason_present" CHECK (length(btrim("reason")) > 0)
);

CREATE UNIQUE INDEX "cash_movements_tenant_id_id_key"
  ON "treasury"."cash_movements"("tenant_id", "id");
CREATE INDEX "cash_movements_tenant_id_cash_session_id_idx"
  ON "treasury"."cash_movements"("tenant_id", "cash_session_id");
CREATE INDEX "cash_movements_tenant_id_branch_id_occurred_at_idx"
  ON "treasury"."cash_movements"("tenant_id", "branch_id", "occurred_at");

ALTER TABLE "treasury"."cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_cash_session_id_fkey"
  FOREIGN KEY ("tenant_id", "cash_session_id")
  REFERENCES "treasury"."cash_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id")
  REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Mirrors inventory.stock_movements.performed_by exactly: the identity USER who
-- transmitted the movement, not tenant-scoped (users are global, per the existing precedent).
ALTER TABLE "treasury"."cash_movements" ADD CONSTRAINT "cash_movements_performed_by_fkey"
  FOREIGN KEY ("performed_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT SELECT, INSERT ON "treasury"."cash_movements" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_movements" FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "treasury"."cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_movements_select ON "treasury"."cash_movements" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY cash_movements_insert ON "treasury"."cash_movements" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
