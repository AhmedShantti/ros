-- ---------------------------------------------------------------------------
-- Migration 35 (Treasury) — DayClose: Internal-MVP operational business-day
-- close (FR-FIN-020/021/023/024), its immutable Z snapshot, the activation
-- epoch, and the DC-R2 close-business-day session/variance-ownership
-- attribution on `cash_sessions`.
--
-- Authority (CONTROLLING order):
--   1. docs/governance/GOVERNANCE_DECISION_REGISTER.md, "Day Close
--      Ratification — 2026-08-31" (DC-R1, DC-R2, DC-R3) — BINDING.
--   2. docs/reports/claude/2026-08-31_DAYCLOSE-final-design-gate.md
--   3. docs/reports/claude/2026-08-31_DAYCLOSE-design-gate-acceptance-correction.md
--   4. docs/reports/claude/2026-08-31_DAYCLOSE-pre-ratification-final-correction.md
--   5. docs/reports/claude/2026-08-31_DAYCLOSE-activation-mechanic-final-correction.md
--   6. docs/reports/claude/2026-08-31_DAYCLOSE-user-ratification.md
-- Each later report/entry governs the earlier where they differ; the
-- register entry is binding over all reports.
--
-- ── SCOPE FENCE ──────────────────────────────────────────────────────────
-- ONE additive Treasury migration. No Sales/Organisation/Reporting schema
-- change. `FR-FIN-022` [M] remains PARTIAL (tax by rate, sales by category,
-- comp, and full sales-by-tender all remain NOT IMPLEMENTED/PARTIAL) and
-- `FR-FIN-026` [M] remains PARTIAL (fiscal finalisation, inventory day-end
-- snapshot, report pre-aggregation, accounting export all remain NOT
-- IMPLEMENTED) — this migration does NOT claim otherwise; see DC-R1.
-- `FR-FIN-025` [S] (automatic close) is NOT IMPLEMENTED — no scheduler, no
-- forced session closure.
--
-- ── INSERT-ONCE / NO `version` (design-gate acceptance correction §8) ──────
-- `treasury.day_closes` and its children carry NO status/lifecycle column
-- and NO `version` — §24.6.4's OCC clause governs `UPDATE`s only; this
-- aggregate is INSERT-once and `ros_app` holds no `UPDATE` grant on any of
-- these tables at all.
--
-- ── DC-R2 — CLOSE-BUSINESS-DAY OWNERSHIP ────────────────────────────────────
-- `cash_sessions.closed_business_day` is NULLABLE (legacy tolerance — real
-- pre-existing `closed` rows, and every row closed before this migration,
-- keep it NULL forever; NEVER backfilled, NEVER inferred). Written EXACTLY
-- ONCE by the application, in the SAME `UPDATE` that already writes
-- `expected_cash`/`counted_cash`/`variance` at the `CLOSED` transition, from
-- the SAME authoritative `resolveBusinessDay` resolver Sales/Order-creation
-- use. `UNIQUE (tenant_id, cash_session_id)` — UNCONDITIONAL — is FORBIDDEN
-- on the linkage table below; only `UNIQUE (tenant_id, day_close_id,
-- cash_session_id)` is created, so a spanning session may legitimately link
-- to two DayCloses.
--
-- ── ACTIVATION EPOCH (activation-mechanic final correction) ────────────────
-- `treasury.day_close_activations` — exactly one immutable row per
-- `(tenant_id, branch_id)`, created lazily on the branch's FIRST DayClose
-- POST, on a path that COMMITS (never throrws-then-relies-on-rollback).
-- `activationBusinessDay` is NEVER closeable;
-- `firstEligibleBusinessDay = activationBusinessDay + 1` is derived, never
-- stored. The activation path COMMITS and returns `outcome: 'ACTIVATED'`;
-- it never throws and relies on rollback for persistence.
--
-- ── Z NUMBER (§13 final design gate, §11 acceptance correction) ────────────
-- `z_number BIGINT`, sequential per `(tenant_id, branch_id)`, starting at 1,
-- `MAX(z_number)+1` computed inside the closing transaction (no SEQUENCE
-- object — this repository has zero sequence objects and zero triggers, and
-- a SEQUENCE is non-transactional and would guarantee gaps on rollback).
-- `UNIQUE (tenant_id, branch_id, z_number)` is the structural backstop for a
-- RETRYABLE allocation collision, distinct in MEANING from the TERMINAL
-- `UNIQUE (tenant_id, branch_id, business_day)` conflict (the day is
-- genuinely already closed) — the application distinguishes the two by the
-- violated constraint name.
--
-- ── IMMUTABILITY (§12 final design gate, the `cash_close_policies`
--    append-only pattern) ─────────────────────────────────────────────────
-- Every new table: `SELECT` is table-level; `INSERT` is COLUMN-level and
-- excludes every DB-generated provenance timestamp (`created_at`,
-- `closed_at`, `activated_at`) so `ros_app` cannot forge history.
-- `REVOKE UPDATE, DELETE, TRUNCATE`. `ENABLE`+`FORCE ROW LEVEL SECURITY`,
-- fail-closed `NULLIF` tenant predicate, `SELECT`+`INSERT` policies only —
-- no `UPDATE` policy, no `DELETE` policy, on any of the six new tables.
--
-- ── FR-FIN-021 blocker ───────────────────────────────────────────────────
-- No new index is required: `cash_sessions` already carries
-- `@@index([tenantId, branchId, status])` (migration 20260820160000), the
-- exact predicate the global open-session blocker reads.
-- ---------------------------------------------------------------------------

-- ============================================== 1. DAY_CLOSE_ACTIVATIONS ===
CREATE TABLE "treasury"."day_close_activations" (
    "id"                       UUID NOT NULL,
    "tenant_id"                UUID NOT NULL,
    "branch_id"                UUID NOT NULL,
    "activation_business_day"  DATE NOT NULL,
    "activated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "activated_by"             UUID NOT NULL,
    -- P1D-E actor provenance when the activating request was POS-originated
    -- (`@AllowPosSession`). NULL for a dashboard-originated activation.
    "activated_by_employee_id" UUID NULL,

    CONSTRAINT "day_close_activations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "day_close_activations_tenant_id_id_key"
  ON "treasury"."day_close_activations"("tenant_id", "id");
-- Exactly one activation row per branch, forever — the fail-closed epoch.
CREATE UNIQUE INDEX "uq_day_close_activations_branch"
  ON "treasury"."day_close_activations"("tenant_id", "branch_id");

ALTER TABLE "treasury"."day_close_activations" ADD CONSTRAINT "day_close_activations_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id")
  REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."day_close_activations" ADD CONSTRAINT "day_close_activations_activated_by_fkey"
  FOREIGN KEY ("activated_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."day_close_activations" ADD CONSTRAINT "day_close_activations_activated_by_employee_fkey"
  FOREIGN KEY ("tenant_id", "activated_by_employee_id")
  REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================== 2. DAY_CLOSES ====
-- The approved-SQL table (`ROS_DrawDB_Compatible_v3.sql`), corrected per the
-- final design gate §6 audit: `tenant_id` added, composite FKs, Z-number
-- column, DB-enforced immutability grants, and the normalised Z-snapshot
-- columns `FR-FIN-022` requires — none of which the approved SQL carried.
CREATE TABLE "treasury"."day_closes" (
    "id"           UUID NOT NULL,
    "tenant_id"    UUID NOT NULL,
    "branch_id"    UUID NOT NULL,
    "business_day" DATE NOT NULL,
    -- FR-FIN-023: sequential per (tenant_id, branch_id), starting at 1.
    "z_number"     BIGINT NOT NULL,

    -- FR-RPT-004's "as of" convention, reused verbatim.
    "data_as_of" TIMESTAMPTZ(6) NOT NULL,
    "closed_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "closed_by"  UUID NOT NULL,
    -- P1D-E. NULL only for a dashboard-originated close.
    "closed_by_employee_id" UUID NULL,

    -- Historical transaction currency (ADR-008/BR-CORE-001) — never
    -- re-derived from today's mutable `org.branches.base_currency`.
    "currency" CHAR(3) NOT NULL,

    -- ── Sales Summary (FR-FIN-022 class A/B) ────────────────────────────
    "gross_sales_minor"       BIGINT NOT NULL,
    -- Structurally zero at this HEAD — no discount mechanism exists.
    -- THE SLICE THAT IMPLEMENTS DISCOUNTS MUST EXPLICITLY DROP THIS CHECK.
    "discounts_minor"         BIGINT NOT NULL,
    -- Structurally zero at this HEAD — no inbound transition to
    -- refunded/partially_refunded exists. DROP WITH THE REFUND SLICE.
    "refunds_minor"           BIGINT NOT NULL,
    "tax_total_minor"         BIGINT NOT NULL,
    "net_sales_minor"         BIGINT NOT NULL,
    "completed_order_count"   INTEGER NOT NULL,
    -- NULL at zero count (RPT-R3's own convention, reused verbatim).
    "average_order_value_minor" BIGINT NULL,

    -- ── Tender totals (PARTIAL — two tenders only, RPT-R2 cl. 8) ────────
    "cash_amount_total_minor"             BIGINT NOT NULL,
    "cash_rounding_adjustment_total_minor" BIGINT NOT NULL,
    "cash_payment_count"                   INTEGER NOT NULL,
    "card_amount_total_minor"              BIGINT NOT NULL,
    "card_payment_count"                   INTEGER NOT NULL,

    -- ── Reconciliation (acceptance-correction identity terms) ───────────
    "unsettled_captured_total_minor"       BIGINT NOT NULL,
    "completed_excess_captured_total_minor" BIGINT NOT NULL,

    -- ── Void and comp summary ────────────────────────────────────────────
    "voided_line_count"      INTEGER NOT NULL,
    "voided_line_value_minor" BIGINT NOT NULL,
    -- Structurally zero — no code path writes state:'comped'. DROP WITH
    -- THE COMP SLICE.
    "comp_line_count"        INTEGER NOT NULL DEFAULT 0,
    "comp_line_value_minor"  BIGINT NOT NULL DEFAULT 0,

    -- ── Cash reconciliation / variance summary (DC-R2 ownership) ────────
    "session_count"                INTEGER NOT NULL,
    "variance_owner_session_count" INTEGER NOT NULL,
    "variance_total_minor"         BIGINT NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "day_closes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_dc_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "ck_dc_z_number_positive" CHECK ("z_number" > 0),
    -- FR-CST-003 [M] verbatim, DB-enforced.
    CONSTRAINT "ck_dc_net_sales_arith" CHECK (
      "net_sales_minor" = "gross_sales_minor" - "discounts_minor" - "refunds_minor" - "tax_total_minor"
    ),
    CONSTRAINT "ck_dc_discounts_structurally_zero" CHECK ("discounts_minor" = 0),
    CONSTRAINT "ck_dc_refunds_structurally_zero" CHECK ("refunds_minor" = 0),
    CONSTRAINT "ck_dc_comp_structurally_zero" CHECK ("comp_line_count" = 0 AND "comp_line_value_minor" = 0),
    CONSTRAINT "ck_dc_aov_null_iff_zero_count" CHECK (
      ("completed_order_count" = 0) = ("average_order_value_minor" IS NULL)
    ),
    CONSTRAINT "ck_dc_nonneg" CHECK (
      "gross_sales_minor" >= 0 AND "tax_total_minor" >= 0
      AND "cash_amount_total_minor" >= 0 AND "card_amount_total_minor" >= 0
      AND "completed_order_count" >= 0 AND "cash_payment_count" >= 0 AND "card_payment_count" >= 0
      AND "unsettled_captured_total_minor" >= 0 AND "completed_excess_captured_total_minor" >= 0
      AND "voided_line_count" >= 0 AND "voided_line_value_minor" >= 0
      AND "session_count" >= 0 AND "variance_owner_session_count" >= 0
    ),
    CONSTRAINT "ck_dc_variance_owner_le_session_count" CHECK ("variance_owner_session_count" <= "session_count")
);

CREATE UNIQUE INDEX "day_closes_tenant_id_id_key"
  ON "treasury"."day_closes"("tenant_id", "id");
-- TERMINAL conflict — the day is genuinely already closed (§14/§18).
CREATE UNIQUE INDEX "uq_day_closes_branch_business_day"
  ON "treasury"."day_closes"("tenant_id", "branch_id", "business_day");
-- RETRYABLE conflict — FR-FIN-023's structural backstop for a transient
-- Z-number allocation collision (a local bounded retry, never a 409).
CREATE UNIQUE INDEX "uq_day_closes_branch_z_number"
  ON "treasury"."day_closes"("tenant_id", "branch_id", "z_number");

ALTER TABLE "treasury"."day_closes" ADD CONSTRAINT "day_closes_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id")
  REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."day_closes" ADD CONSTRAINT "day_closes_closed_by_fkey"
  FOREIGN KEY ("closed_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."day_closes" ADD CONSTRAINT "day_closes_closed_by_employee_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_employee_id")
  REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================ 3. TAX-CLASS REPEATING GROUP =
CREATE TABLE "treasury"."day_close_tax_class_totals" (
    "id"               UUID NOT NULL,
    "tenant_id"        UUID NOT NULL,
    "day_close_id"     UUID NOT NULL,
    -- No FK — mirrors `sales.order_lines.tax_class_id`'s own FK-less design.
    "tax_class_id"     UUID NOT NULL,
    "tax_amount_minor" BIGINT NOT NULL,
    "net_amount_minor" BIGINT NOT NULL,
    "gross_amount_minor" BIGINT NOT NULL,
    "line_count"       INTEGER NOT NULL,

    CONSTRAINT "day_close_tax_class_totals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_dctc_arith" CHECK ("gross_amount_minor" = "net_amount_minor" + "tax_amount_minor"),
    CONSTRAINT "ck_dctc_nonneg" CHECK (
      "tax_amount_minor" >= 0 AND "net_amount_minor" >= 0 AND "gross_amount_minor" >= 0 AND "line_count" >= 0
    )
);
CREATE UNIQUE INDEX "uq_dctc_day_close_tax_class"
  ON "treasury"."day_close_tax_class_totals"("tenant_id", "day_close_id", "tax_class_id");
ALTER TABLE "treasury"."day_close_tax_class_totals" ADD CONSTRAINT "day_close_tax_class_totals_day_close_fkey"
  FOREIGN KEY ("tenant_id", "day_close_id")
  REFERENCES "treasury"."day_closes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================== 4. ORDER-TYPE REPEATING GROUP =
-- `order_type` stored as TEXT with a CHECK against `sales.OrderType`'s
-- values — Treasury does not own that enum type and does not cross-
-- reference it (no cross-schema enum coupling).
CREATE TABLE "treasury"."day_close_order_type_totals" (
    "id"               UUID NOT NULL,
    "tenant_id"        UUID NOT NULL,
    "day_close_id"     UUID NOT NULL,
    "order_type"       VARCHAR(16) NOT NULL,
    "gross_sales_minor" BIGINT NOT NULL,
    "net_sales_minor"   BIGINT NOT NULL,
    "order_count"       INTEGER NOT NULL,

    CONSTRAINT "day_close_order_type_totals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_dcot_order_type" CHECK (
      "order_type" IN ('dine_in', 'takeaway', 'delivery', 'drive_thru', 'pickup', 'aggregator')
    ),
    CONSTRAINT "ck_dcot_nonneg" CHECK (
      "gross_sales_minor" >= 0 AND "net_sales_minor" >= 0 AND "order_count" >= 0 AND "net_sales_minor" <= "gross_sales_minor"
    )
);
CREATE UNIQUE INDEX "uq_dcot_day_close_order_type"
  ON "treasury"."day_close_order_type_totals"("tenant_id", "day_close_id", "order_type");
ALTER TABLE "treasury"."day_close_order_type_totals" ADD CONSTRAINT "day_close_order_type_totals_day_close_fkey"
  FOREIGN KEY ("tenant_id", "day_close_id")
  REFERENCES "treasury"."day_closes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ================================================== 5. DAY_CLOSE_SESSIONS ==
-- DC-R2's LINKAGE child. One row per session PER DayClose — a spanning
-- session MAY appear under TWO DayClose rows. UNCONDITIONAL
-- `UNIQUE (tenant_id, cash_session_id)` IS FORBIDDEN (DC-R2 clause 6) —
-- only the PER-DAYCLOSE unique below is created. `is_variance_owner` is a
-- MATERIALISED, defence-in-depth-only flag (true ownership is the theorem
-- `session.closed_business_day == day_close.business_day`); its partial
-- unique index below turns a materialisation bug into a write failure,
-- never a silently double-counted variance.
CREATE TABLE "treasury"."day_close_sessions" (
    "id"                UUID NOT NULL,
    "tenant_id"         UUID NOT NULL,
    "day_close_id"      UUID NOT NULL,
    "cash_session_id"   UUID NOT NULL,
    "is_variance_owner" BOOLEAN NOT NULL,

    -- Day-scoped tender contribution — genuinely day-attributable, from the
    -- immutable `order_payments.business_day`. Zero for a zero-payment or
    -- movement-only session.
    "day_scoped_cash_sales_total_minor"          BIGINT NOT NULL,
    "day_scoped_cash_rounding_adjustments_minor" BIGINT NOT NULL,
    "day_scoped_manual_external_card_total_minor" BIGINT NOT NULL,
    "day_scoped_payment_count"                    INTEGER NOT NULL,
    "business_day_count"                          INTEGER NOT NULL,

    -- WHOLE_SESSION close facts — NEVER a day total. Snapshot of
    -- `cash_sessions`' own immutable close-facts row.
    "whole_session_opening_float_minor" BIGINT NOT NULL,
    "whole_session_expected_cash_minor" BIGINT NOT NULL,
    "whole_session_counted_cash_minor"  BIGINT NOT NULL,
    "whole_session_variance_minor"      BIGINT NOT NULL,

    CONSTRAINT "day_close_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_dcs_nonneg" CHECK (
      "day_scoped_cash_sales_total_minor" >= 0 AND "day_scoped_manual_external_card_total_minor" >= 0
      AND "day_scoped_payment_count" >= 0 AND "business_day_count" >= 0
      AND "whole_session_opening_float_minor" >= 0 AND "whole_session_counted_cash_minor" >= 0
    ),
    CONSTRAINT "ck_dcs_variance_arith" CHECK (
      "whole_session_variance_minor" = "whole_session_counted_cash_minor" - "whole_session_expected_cash_minor"
    )
);
CREATE UNIQUE INDEX "day_close_sessions_tenant_id_id_key"
  ON "treasury"."day_close_sessions"("tenant_id", "id");
-- Linkage cardinality (DC-R2 clause 5) — one row per session PER DayClose.
CREATE UNIQUE INDEX "uq_dcs_day_close_cash_session"
  ON "treasury"."day_close_sessions"("tenant_id", "day_close_id", "cash_session_id");
-- Defence-in-depth only (design-gate acceptance correction §4.4) — at most
-- one OWNING DayClose per session; NOT the ownership mechanism itself.
CREATE UNIQUE INDEX "uq_dcs_variance_owner"
  ON "treasury"."day_close_sessions"("tenant_id", "cash_session_id")
  WHERE "is_variance_owner";
CREATE INDEX "day_close_sessions_cash_session_idx"
  ON "treasury"."day_close_sessions"("tenant_id", "cash_session_id");

ALTER TABLE "treasury"."day_close_sessions" ADD CONSTRAINT "day_close_sessions_day_close_fkey"
  FOREIGN KEY ("tenant_id", "day_close_id")
  REFERENCES "treasury"."day_closes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."day_close_sessions" ADD CONSTRAINT "day_close_sessions_cash_session_fkey"
  FOREIGN KEY ("tenant_id", "cash_session_id")
  REFERENCES "treasury"."cash_sessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================ 6. CASH_SESSIONS — DC-R2 ATTRIBUTION COLUMN ==
-- NULLABLE — legacy tolerance. Every row `closed` before this migration
-- (whether pre-P1G-1 unanchored, or P1G-1-anchored but pre-migration-35)
-- keeps this NULL forever. NEVER backfilled, NEVER inferred. Written
-- EXACTLY ONCE by the application, in the SAME `UPDATE` that already writes
-- the other close facts at the `CLOSED` transition.
ALTER TABLE "treasury"."cash_sessions"
  ADD COLUMN "closed_business_day" DATE NULL;

CREATE INDEX "cash_sessions_closed_business_day_idx"
  ON "treasury"."cash_sessions"("tenant_id", "branch_id", "closed_business_day");

-- ---------------------------------------------------------------- GRANTS ---
-- Every new table is append-only: `SELECT` table-level, `INSERT`
-- column-level excluding every DB-generated provenance timestamp so
-- `ros_app` cannot forge history. No `UPDATE` grant anywhere. No `DELETE`,
-- no `TRUNCATE`.
GRANT SELECT ON "treasury"."day_close_activations" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "activation_business_day",
  "activated_by", "activated_by_employee_id"
) ON "treasury"."day_close_activations" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."day_close_activations" FROM ros_app;

GRANT SELECT ON "treasury"."day_closes" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "business_day", "z_number",
  "data_as_of", "closed_by", "closed_by_employee_id", "currency",
  "gross_sales_minor", "discounts_minor", "refunds_minor", "tax_total_minor",
  "net_sales_minor", "completed_order_count", "average_order_value_minor",
  "cash_amount_total_minor", "cash_rounding_adjustment_total_minor", "cash_payment_count",
  "card_amount_total_minor", "card_payment_count",
  "unsettled_captured_total_minor", "completed_excess_captured_total_minor",
  "voided_line_count", "voided_line_value_minor", "comp_line_count", "comp_line_value_minor",
  "session_count", "variance_owner_session_count", "variance_total_minor"
) ON "treasury"."day_closes" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."day_closes" FROM ros_app;

GRANT SELECT, INSERT ON "treasury"."day_close_tax_class_totals" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."day_close_tax_class_totals" FROM ros_app;

GRANT SELECT, INSERT ON "treasury"."day_close_order_type_totals" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."day_close_order_type_totals" FROM ros_app;

GRANT SELECT, INSERT ON "treasury"."day_close_sessions" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."day_close_sessions" FROM ros_app;

-- cash_sessions: additive column-level UPDATE grant. Accumulates alongside
-- migration 34's existing narrow grant (status/close_attempt_id/closed_at/
-- expected_cash/counted_cash/variance/variance_reason/approval_request_id/
-- closed_by_user_id/closed_by_employee_id) — Postgres column-level GRANTs
-- for the same grantee on the same table are additive; this does not need
-- to repeat the prior column list.
GRANT UPDATE ("closed_business_day") ON "treasury"."cash_sessions" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "treasury"."day_close_activations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."day_close_activations" FORCE ROW LEVEL SECURITY;
CREATE POLICY day_close_activations_select ON "treasury"."day_close_activations" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY day_close_activations_insert ON "treasury"."day_close_activations" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "treasury"."day_closes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."day_closes" FORCE ROW LEVEL SECURITY;
CREATE POLICY day_closes_select ON "treasury"."day_closes" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY day_closes_insert ON "treasury"."day_closes" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "treasury"."day_close_tax_class_totals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."day_close_tax_class_totals" FORCE ROW LEVEL SECURITY;
CREATE POLICY day_close_tax_class_totals_select ON "treasury"."day_close_tax_class_totals" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY day_close_tax_class_totals_insert ON "treasury"."day_close_tax_class_totals" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "treasury"."day_close_order_type_totals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."day_close_order_type_totals" FORCE ROW LEVEL SECURITY;
CREATE POLICY day_close_order_type_totals_select ON "treasury"."day_close_order_type_totals" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY day_close_order_type_totals_insert ON "treasury"."day_close_order_type_totals" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "treasury"."day_close_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."day_close_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY day_close_sessions_select ON "treasury"."day_close_sessions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY day_close_sessions_insert ON "treasury"."day_close_sessions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No UPDATE policy, no DELETE policy on any of the six tables above —
-- immutable, forever.

COMMENT ON TABLE "treasury"."day_close_activations" IS
  'Migration 35 — the immutable DayClose activation epoch. Exactly one row per (tenant_id, branch_id). Append-only: no UPDATE/DELETE grant.';
COMMENT ON TABLE "treasury"."day_closes" IS
  'Migration 35 — the immutable DayClose/Z root (FR-FIN-020/023). Insert-once: no status column, no version. FR-FIN-022 remains PARTIAL (see docs/governance/GOVERNANCE_DECISION_REGISTER.md DC-R1) — this table never claims full Z compliance.';
COMMENT ON TABLE "treasury"."day_close_sessions" IS
  'Migration 35 — DC-R2 linkage child. One row per session PER DayClose; a spanning session MAY link to two DayCloses. UNCONDITIONAL UNIQUE(tenant_id, cash_session_id) is FORBIDDEN by DC-R2 clause 6.';
