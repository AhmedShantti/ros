-- ---------------------------------------------------------------------------
-- P1G-1 migration 34 (Treasury) — CashSession Close: immutable count
-- declaration, blind/open freeze, variance, and DB-enforced closed
-- immutability, over the accepted state machine OPEN -> CLOSING -> CLOSED
-- (or OPEN -> CLOSED directly, within tolerance).
--
-- Authority (CONTROLLING, in order):
--   docs/reports/claude/2026-08-30_P1G1_cashsession-close-final-design-gate.md
--   docs/reports/claude/2026-08-30_P1G1_cashsession-close-design-acceptance-closure.md
--   docs/reports/claude/2026-08-30_P1G1_cashsession-close-final-acceptance-closure.md
--   docs/reports/claude/2026-08-30_P1G1_cashsession-close-migration-compatibility-closure.md
--   docs/governance/GOVERNANCE_DECISION_REGISTER.md, "R-6 — Cash Variance
--   Approval Rejection Recovery — RATIFIED 2026-08-30"
--
-- ONE migration, not two: empirically proven (migration-compatibility-closure
-- report §3) that Prisma Migrate 7.9.1 executes migration STATEMENTS
-- NON-TRANSACTIONALLY in this environment, so `ALTER TYPE ... ADD VALUE`
-- committing before its later use in this same file is safe. Statement order
-- below is therefore load-bearing: enum -> new tables -> new unique targets
-- -> new columns -> constraints/FKs -> grants -> RLS.
--
-- ── LEGACY COMPATIBILITY (load-bearing) ─────────────────────────────────────
-- The persistent development database already holds CLOSED CashSession rows
-- with NO P1G-1 close attempt (created before this migration existed, via
-- `ros_app`'s pre-existing table-level INSERT). This migration MUST NOT fail
-- on them, fabricate an attempt or figures for them, or reopen them. Every
-- CHECK below is legacy-tolerant BY CONSTRUCTION — see the per-constraint
-- comments — and the write gate that prevents `ros_app` from ever CREATING a
-- new unanchored 'closed' row lives on the RLS UPDATE policy, not on the
-- table-level CHECKs (which must remain satisfiable by pre-existing data).
-- ---------------------------------------------------------------------------

-- ============================================================ 1. ENUM =====
ALTER TYPE "treasury"."CashSessionStatus" ADD VALUE 'closing';

-- ============================================== 2. IMMUTABLE CLOSE ATTEMPT =
-- FR-OFF-015: `id` is the CLIENT-GENERATED permanent ULID-as-UUID the
-- cashier's terminal assigns at physical count declaration time. The server
-- NEVER reassigns it (enforced structurally: it is the PRIMARY KEY, and
-- `ros_app` holds no UPDATE grant on this table at all).
CREATE TABLE "treasury"."cash_session_close_attempts" (
    "id"                 UUID NOT NULL,
    "tenant_id"          UUID NOT NULL,
    "branch_id"          UUID NOT NULL,
    "cash_session_id"    UUID NOT NULL,

    -- Policy snapshot, pinned at cash_session.opened_at (ratified R-3(a)).
    "policy_version_id"       UUID   NOT NULL,
    "tolerance_minor_units"   BIGINT NOT NULL,
    "count_mode"              "treasury"."CashCountMode" NOT NULL,

    -- FR-FIN-004's eight expected-cash terms, each stored so a historical
    -- close explains itself with no join to current settings (FR-FIN-007).
    "opening_float"             BIGINT NOT NULL,
    "cash_sales_total"          BIGINT NOT NULL,
    "cash_tips_total"           BIGINT NOT NULL,
    "pay_in_total"               BIGINT NOT NULL,
    "cash_refunds_total"        BIGINT NOT NULL,
    "pay_out_total"              BIGINT NOT NULL,
    "safe_drop_total"            BIGINT NOT NULL,
    "cash_rounding_adjustments" BIGINT NOT NULL,

    -- Computed.
    "expected_cash"      BIGINT  NOT NULL,
    "counted_cash"       BIGINT  NOT NULL,
    "variance"           BIGINT  NOT NULL,
    "currency"           CHAR(3) NOT NULL,
    "approval_required"  BOOLEAN NOT NULL,

    -- Provenance.
    "declared_by_employee_id" UUID NOT NULL,
    "declared_by_user_id"     UUID NOT NULL,
    "terminal_id"              UUID NOT NULL,
    "declared_at"                 TIMESTAMPTZ(6) NOT NULL,
    -- DB persistence provenance, distinct from `declared_at` (the device
    -- event instant). Excluded from the INSERT grant below so `ros_app`
    -- cannot forge it.
    "created_at"                     TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "cash_session_close_attempts_pkey" PRIMARY KEY ("id"),

    -- FR-FIN-004: the formula itself, DB-enforced. Safe from BIGINT overflow
    -- because the money-DTO pattern `^\d{1,18}$` caps every term below 1e18,
    -- and 8 * 1e18 < BIGINT_MAX (~9.223e18). WIDENING THAT DTO PATTERN TO 19
    -- DIGITS WOULD BREAK THIS CONSTRAINT.
    CONSTRAINT "ck_csca_formula" CHECK (
      "expected_cash" = "opening_float" + "cash_sales_total" + "cash_tips_total" + "pay_in_total"
                       - "cash_refunds_total" - "pay_out_total" - "safe_drop_total"
                       + "cash_rounding_adjustments"
    ),
    -- FR-FIN-005: signed variance = counted - expected.
    CONSTRAINT "ck_csca_variance" CHECK ("variance" = "counted_cash" - "expected_cash"),
    CONSTRAINT "ck_csca_nonneg" CHECK (
      "counted_cash" >= 0 AND "opening_float" >= 0 AND "tolerance_minor_units" >= 0
    ),
    CONSTRAINT "ck_csca_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
    -- Ratified R-2(a): abs(variance) > tolerance, equality is WITHIN
    -- tolerance. Written OVERFLOW-SAFE — `abs(-9223372036854775808::bigint)`
    -- raises `bigint out of range`; negating a non-negative BIGINT (the
    -- `ck_csca_nonneg` tolerance CHECK guarantees `tolerance >= 0`) never
    -- overflows, because BIGINT_MIN = -BIGINT_MAX - 1 is representable.
    CONSTRAINT "ck_csca_approval_required_matches" CHECK (
      "approval_required" = ("variance" > "tolerance_minor_units" OR "variance" < -"tolerance_minor_units")
    ),
    -- Phase markers (design gate §6/§15): FR-FIN-004's tips/refunds terms are
    -- structurally unrecordable at this HEAD (no tip-entry route; no inbound
    -- transition to `refunded`/`partially_refunded`), so their contribution
    -- is necessarily zero, DB-enforced rather than merely service-trusted.
    -- THE SLICE THAT IMPLEMENTS TIPS OR REFUNDS MUST EXPLICITLY DROP THESE.
    CONSTRAINT "ck_csca_tips_structurally_zero_p1g1"    CHECK ("cash_tips_total" = 0),
    CONSTRAINT "ck_csca_refunds_structurally_zero_p1g1" CHECK ("cash_refunds_total" = 0)
);

CREATE UNIQUE INDEX "cash_session_close_attempts_tenant_id_id_key"
  ON "treasury"."cash_session_close_attempts"("tenant_id", "id");
-- EXACTLY ONE count per session, forever — the blind-integrity guarantee
-- (FR-POS-095) AND (with the session-anchor FK below) the reason attempt
-- substitution is relationally impossible.
CREATE UNIQUE INDEX "uq_csca_one_per_session"
  ON "treasury"."cash_session_close_attempts"("tenant_id", "cash_session_id");
-- The exact target the CashSession's ownership-proving composite FK requires.
CREATE UNIQUE INDEX "uq_csca_session_scoped_id"
  ON "treasury"."cash_session_close_attempts"("tenant_id", "cash_session_id", "id");
CREATE INDEX "cash_session_close_attempts_tenant_id_branch_id_idx"
  ON "treasury"."cash_session_close_attempts"("tenant_id", "branch_id");

-- ==================================================== 3. DENOMINATIONS =====
-- FR-POS-097. Composite identity — the row IS its own duplicate-denomination
-- guard, so no synthetic id is added (design gate §17/§7).
CREATE TABLE "treasury"."cash_count_denominations" (
    "tenant_id"                 UUID   NOT NULL,
    "close_attempt_id"          UUID   NOT NULL,
    "denomination_minor_units"  BIGINT NOT NULL,
    "quantity"                  INTEGER NOT NULL,

    CONSTRAINT "cash_count_denominations_pkey"
      PRIMARY KEY ("tenant_id", "close_attempt_id", "denomination_minor_units"),
    CONSTRAINT "ck_ccd_denom_positive" CHECK ("denomination_minor_units" > 0),
    CONSTRAINT "ck_ccd_qty_positive"   CHECK ("quantity" > 0)
);

-- ============================================ 4. BLOCKER-B UNIQUE TARGETS ==
-- New unique targets proving attempt.branch_id == session.branch_id and
-- attempt.policy_version_id belongs to attempt.branch_id, relationally
-- (migration-compatibility-closure report §5) — not merely trusted to
-- service code.
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "uq_cs_branch_scoped_id" UNIQUE ("tenant_id", "branch_id", "id");
ALTER TABLE "treasury"."cash_close_policies"
  ADD CONSTRAINT "uq_ccp_branch_scoped_id" UNIQUE ("tenant_id", "branch_id", "id");

-- ================================================ 5. ATTEMPT OWNERSHIP FKS =
ALTER TABLE "treasury"."cash_session_close_attempts"
  ADD CONSTRAINT "csca_session_fkey" FOREIGN KEY ("tenant_id", "branch_id", "cash_session_id")
    REFERENCES "treasury"."cash_sessions"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "csca_policy_fkey" FOREIGN KEY ("tenant_id", "branch_id", "policy_version_id")
    REFERENCES "treasury"."cash_close_policies"("tenant_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- No direct org.branches FK: branch validity is proven TRANSITIVELY
  -- through cash_sessions' own (tenant_id, branch_id) -> org.branches FK
  -- (migration-compatibility-closure report §5.2 — redundant otherwise).
  ADD CONSTRAINT "csca_declared_employee_fkey" FOREIGN KEY ("tenant_id", "declared_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "csca_declared_user_fkey" FOREIGN KEY ("declared_by_user_id")
    REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Branch-safe, mirroring `Drawer.terminal` / `OrderPayment.terminal`
  -- (ADR 0008 D-16's `(branch_id, id)` target on `identity.terminals`).
  ADD CONSTRAINT "csca_terminal_fkey" FOREIGN KEY ("branch_id", "terminal_id")
    REFERENCES "identity"."terminals"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "treasury"."cash_count_denominations"
  ADD CONSTRAINT "ccd_attempt_fkey" FOREIGN KEY ("tenant_id", "close_attempt_id")
    REFERENCES "treasury"."cash_session_close_attempts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ==================================== 6. CASH_SESSIONS NEW COLUMNS ==========
-- `closed_at` already exists (migration 20260820160000).
ALTER TABLE "treasury"."cash_sessions"
  ADD COLUMN "close_attempt_id"      UUID NULL,
  ADD COLUMN "expected_cash"         BIGINT NULL,
  ADD COLUMN "counted_cash"          BIGINT NULL,
  ADD COLUMN "variance"              BIGINT NULL,
  ADD COLUMN "variance_reason"       TEXT NULL,
  ADD COLUMN "approval_request_id"   UUID NULL,   -- Governance reference, NO FK (cross-module table; see design gate §30)
  ADD COLUMN "closed_by_user_id"     UUID NULL,
  ADD COLUMN "closed_by_employee_id" UUID NULL;

-- ============================== 7. LEGACY-COMPATIBLE CONSTRAINTS ===========
-- Proven (migration-compatibility-closure report §2.3) to apply cleanly over
-- the persistent DB's real pre-existing CLOSED rows (which have `closed_at`
-- set and, necessarily, every new column NULL).
ALTER TABLE "treasury"."cash_sessions"
  -- C1 — attempt anchor. 'closed' is permitted BOTH anchored (a new P1G-1
  -- close) and unanchored (a legacy row) — the write GATE that prevents
  -- ros_app from creating a NEW unanchored closed row lives on the RLS
  -- UPDATE policy (§9 below), not here.
  ADD CONSTRAINT "ck_cs_attempt_anchor" CHECK (
       ("status" = 'open'    AND "close_attempt_id" IS NULL)
    OR ("status" = 'closing' AND "close_attempt_id" IS NOT NULL)
    OR ("status" = 'closed')
  ),
  -- C2 — core facts require an anchored close. Simultaneously the
  -- closing-state freeze (a `closing` row is always anchored, so an
  -- unanchored row here can only be `open`) AND the legacy guarantee (an
  -- unanchored 'closed' row must hold NULL in every new P1G-1 column).
  -- `closed_at` is DELIBERATELY EXCLUDED — legacy rows already have it set.
  ADD CONSTRAINT "ck_cs_core_facts_require_anchor" CHECK (
       ("status" = 'closed' AND "close_attempt_id" IS NOT NULL)
    OR ("expected_cash" IS NULL AND "counted_cash" IS NULL AND "variance" IS NULL
        AND "variance_reason" IS NULL AND "approval_request_id" IS NULL
        AND "closed_by_user_id" IS NULL AND "closed_by_employee_id" IS NULL)
  ),
  -- C3 — completeness applies ONLY to a new, anchored P1G-1 close.
  ADD CONSTRAINT "ck_cs_anchored_close_complete" CHECK (
       "close_attempt_id" IS NULL OR "status" <> 'closed'
    OR ("expected_cash" IS NOT NULL AND "counted_cash" IS NOT NULL AND "variance" IS NOT NULL
        AND "closed_at" IS NOT NULL AND "closed_by_user_id" IS NOT NULL
        AND "closed_by_employee_id" IS NOT NULL)
  ),
  -- C4 — one-directional only: closed_at implies closed, never the reverse
  -- (a legacy row already satisfies status='closed' with closed_at set; a
  -- biconditional would gain nothing and risks a false assumption later).
  ADD CONSTRAINT "ck_cs_closed_at_requires_closed" CHECK (
    "closed_at" IS NULL OR "status" = 'closed'
  ),
  ADD CONSTRAINT "ck_cs_variance_arith" CHECK (
    "variance" IS NULL OR "variance" = "counted_cash" - "expected_cash"
  ),
  ADD CONSTRAINT "ck_cs_reason_nonblank" CHECK (
    "variance_reason" IS NULL OR length(btrim("variance_reason")) > 0
  ),
  -- Session -> attempt anchor: the THREE-column FK whose middle column is
  -- the session's OWN id, matched against the attempt's cash_session_id —
  -- this is what proves EXACT session ownership (not merely same-tenancy),
  -- and combined with `uq_csca_one_per_session` makes attempt substitution
  -- relationally impossible (migration-compatibility-closure report §3.3's
  -- proof). MATCH SIMPLE (the default) skips the FK entirely while
  -- close_attempt_id IS NULL — the exact behaviour the repo's own
  -- `drawers_terminal_fkey` precedent already relies on.
  ADD CONSTRAINT "cash_sessions_close_attempt_fkey"
    FOREIGN KEY ("tenant_id", "id", "close_attempt_id")
    REFERENCES "treasury"."cash_session_close_attempts"("tenant_id", "cash_session_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cash_sessions_closed_by_user_id_fkey"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cash_sessions_tenant_id_closed_by_employee_id_fkey"
    FOREIGN KEY ("tenant_id", "closed_by_employee_id")
    REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- cash_session_close_attempts: table-level SELECT; COLUMN-LEVEL INSERT that
-- deliberately EXCLUDES created_at, so ros_app cannot forge DB persistence
-- provenance (the exact governance.approval_decisions / cash_close_policies
-- precedent). No UPDATE. No DELETE. No TRUNCATE.
GRANT SELECT ON "treasury"."cash_session_close_attempts" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "cash_session_id",
  "policy_version_id", "tolerance_minor_units", "count_mode",
  "opening_float", "cash_sales_total", "cash_tips_total", "pay_in_total",
  "cash_refunds_total", "pay_out_total", "safe_drop_total", "cash_rounding_adjustments",
  "expected_cash", "counted_cash", "variance", "currency", "approval_required",
  "declared_by_employee_id", "declared_by_user_id", "terminal_id", "declared_at"
) ON "treasury"."cash_session_close_attempts" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_session_close_attempts" FROM ros_app;

-- cash_count_denominations: table-level INSERT is correct here — every
-- column is caller-supplied; there is no server-set provenance column to
-- protect.
GRANT SELECT, INSERT ON "treasury"."cash_count_denominations" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_count_denominations" FROM ros_app;

-- cash_sessions: NARROW column-level UPDATE, exactly the close-relevant
-- columns. No arbitrary UPDATE (opening_float, employee_id, drawer_id,
-- currency, opened_at remain unwritable for the lifetime of the session).
GRANT UPDATE (
  "status", "close_attempt_id", "closed_at",
  "expected_cash", "counted_cash", "variance", "variance_reason",
  "approval_request_id", "closed_by_user_id", "closed_by_employee_id"
) ON "treasury"."cash_sessions" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "treasury"."cash_session_close_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_session_close_attempts" FORCE  ROW LEVEL SECURITY;
CREATE POLICY cash_session_close_attempts_select ON "treasury"."cash_session_close_attempts" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY cash_session_close_attempts_insert ON "treasury"."cash_session_close_attempts" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No UPDATE policy. No DELETE policy. Immutable, forever.

ALTER TABLE "treasury"."cash_count_denominations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_count_denominations" FORCE  ROW LEVEL SECURITY;
CREATE POLICY cash_count_denominations_select ON "treasury"."cash_count_denominations" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY cash_count_denominations_insert ON "treasury"."cash_count_denominations" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No UPDATE policy. No DELETE policy.

-- cash_sessions: the NEW-WRITE gate (migration-compatibility-closure report
-- §2.4's formal proof). Every UPDATE `ros_app` performs must satisfy
-- WITH CHECK on the NEW row; WITH CHECK requires close_attempt_id IS NOT
-- NULL whenever the new status is 'closing' or 'closed' — so EVERY row
-- ros_app transitions into either state is anchored to an immutable attempt.
-- Legacy closed rows are excluded by USING (only 'open'/'closing' are
-- visible to UPDATE), so they can never be touched at all.
DROP POLICY IF EXISTS "cash_sessions_update" ON "treasury"."cash_sessions";
CREATE POLICY cash_sessions_update ON "treasury"."cash_sessions" FOR UPDATE
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('open', 'closing'))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND status IN ('closing', 'closed')
              AND close_attempt_id IS NOT NULL);

COMMENT ON TABLE "treasury"."cash_session_close_attempts" IS
  'P1G-1 immutable CashSession close declaration (FR-POS-094/095/097, FR-FIN-004/005). Append-only: no UPDATE/DELETE grant. Exactly one per session (uq_csca_one_per_session). Client-generated permanent id (FR-OFF-015).';
COMMENT ON TABLE "treasury"."cash_count_denominations" IS
  'P1G-1 denomination-level count rows (FR-POS-097). Composite identity — no synthetic id. Append-only.';
