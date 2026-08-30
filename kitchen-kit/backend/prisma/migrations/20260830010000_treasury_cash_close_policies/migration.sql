-- ---------------------------------------------------------------------------
-- P1G-1 migration 33 (Treasury) — Cash-close policy substrate: branch-scoped,
-- effective-dated, IMMUTABLE cash variance tolerance + count mode + approval
-- expiry, unblocking (but not implementing) CashSession Close.
--
-- Authority (CONTROLLING order):
--   1. docs/reports/claude/2026-08-30_P1G1_variance-settings-final-design-gate.md
--   2. docs/governance/GOVERNANCE_DECISION_REGISTER.md, "P1G-1 Cash-Close
--      Policy Ratification — 2026-08-30" (R-1(a)..R-5, C-1, C-2)
--   3. docs/reports/claude/2026-08-30_P1G1_variance-settings-ratification-recorded.md
--
-- SCOPE FENCE — this migration does NOT implement CashSession Close, count
-- declaration, expected-cash computation, variance recording, approval
-- consumption, Day Close, X/Z report, or the FR-POS-092 drawer limit. It does
-- NOT modify `treasury.cash_sessions` in any way (R-3(a): no snapshot column
-- at open). It is NOT the generic FR-PLT-025 settings hierarchy or the
-- FR-PLT-026 lock mechanism — both remain NOT IMPLEMENTED after this
-- migration; see the table comment below.
--
-- ── R-1(a) — ABSOLUTE MONEY TOLERANCE ───────────────────────────────────────
-- `variance_tolerance_minor_units BIGINT`, no percentage, no hybrid, no
-- floating point (BR-CORE-001). No DEFAULT — FR-FIN-006 names no value and
-- none is invented; the unconfigured state is the ABSENCE of a row (R-5), not
-- a column default.
--
-- ── R-2(a) — COMPARISON SEMANTICS ───────────────────────────────────────────
-- Not enforced by this table at all: `abs(counted - expected) > tolerance` is
-- a FUTURE CashSession-Close-time computation. This table only stores the
-- configured scalar the future comparison will read.
--
-- ── R-3(a) / C-2 — EFFECTIVE VERSIONING, NO BACKDATING ──────────────────────
-- Versions are IMMUTABLE, append-only facts (`ros_app` holds SELECT + a
-- column-level INSERT only; no UPDATE, no DELETE, no TRUNCATE — the exact
-- `governance.approval_decisions` precedent from migration 32). A future
-- CashSession is governed by the version effective at the session's OPEN
-- time (`cash_session.opened_at` as the resolver's `asOf`); this migration
-- adds NO column to `cash_sessions` to implement that rule (R-3(a) is a
-- resolver-time SELECTION rule, not a schema change to the session).
--
-- `effective_from >= created_at` is the anti-backdating enforcement (C-2).
-- Both columns default to `statement_timestamp()`, which Postgres evaluates
-- ONCE per statement — so an "effective immediately" INSERT that omits
-- `effective_from` gets the IDENTICAL instant as `created_at` in the same
-- INSERT, satisfying the CHECK with equality, using DATABASE time only
-- (never the application's clock as the security boundary). `created_at` is
-- excluded from `ros_app`'s column-level INSERT grant, so a caller cannot
-- forge history by supplying a fabricated `created_at` to sneak an earlier
-- `effective_from` past the CHECK.
--
-- ── R-4(a) — APPROVAL EXPIRY, NO INVENTED DURATION ──────────────────────────
-- `variance_approval_expiry_seconds INTEGER NOT NULL CHECK (... > 0)`, no
-- DEFAULT. D-10 (E2) is unchanged: the FUTURE Governance `ApprovalRequest`
-- still carries its own mandatory, immutable, explicit `expires_at`; this
-- column is only the CONFIGURED DURATION Treasury will derive it from.
--
-- ── R-5 — FAIL-CLOSED, NO INVENTED DEFAULT ──────────────────────────────────
-- `count_mode` alone carries a genuine DEFAULT ('blind' — FR-POS-095 [M]
-- states it explicitly, exact precedent: `branch_kds_config
-- .recall_window_seconds DEFAULT 1800` for FR-KDS-025, which also states its
-- default). No other column carries a DEFAULT: a branch with no row is
-- UNCONFIGURED, and a future CashSession Close consuming this table's
-- resolver MUST fail closed rather than assume a value — this migration
-- makes that omission structurally possible to detect (SELECT returns zero
-- rows), never structurally impossible to reach (no NOT NULL DEFAULT that
-- would silently manufacture a tolerance).
--
-- ── TENANCY / RLS (D-09, ADR 0008 D-11's binding instruction) ───────────────
-- `tenant_id` is a REAL column (not inherited through a join — ADR 0008
-- D-11's explicit requirement for any future settings table). The composite
-- FK `(tenant_id, branch_id) -> org.branches(tenant_id, id)` makes a
-- cross-tenant branch reference a FOREIGN-KEY VIOLATION, not a missed
-- service check (D-09). `ENABLE`+`FORCE` RLS, fail-closed `NULLIF` predicate,
-- SELECT+INSERT policies only — the `treasury.cash_movements` precedent
-- (migration 31) exactly.
-- ---------------------------------------------------------------------------

CREATE TYPE "treasury"."CashCountMode" AS ENUM ('blind', 'open');

CREATE TABLE "treasury"."cash_close_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "count_mode" "treasury"."CashCountMode" NOT NULL DEFAULT 'blind',
    -- R-1(a): no DEFAULT. FR-FIN-006 names no value; none is invented.
    "variance_tolerance_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    -- R-4(a): no DEFAULT. No 5m/15m/30m constant is authorised anywhere.
    "variance_approval_expiry_seconds" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "cash_close_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_ccp_tolerance_non_negative" CHECK ("variance_tolerance_minor_units" >= 0),
    CONSTRAINT "ck_ccp_expiry_positive" CHECK ("variance_approval_expiry_seconds" > 0),
    CONSTRAINT "ck_ccp_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
    -- C-2: the anti-backdating enforcement. See the header comment for why
    -- an "effective immediately" INSERT still satisfies this (equality).
    CONSTRAINT "ck_ccp_no_backdating" CHECK ("effective_from" >= "created_at")
);

-- Composite-FK target for the branch edge below (D-09).
CREATE UNIQUE INDEX "cash_close_policies_tenant_id_id_key"
  ON "treasury"."cash_close_policies"("tenant_id", "id");

-- One version per branch per instant — the deterministic conflict for a
-- concurrent same-branch, same-`effective_from` race (no advisory lock, no
-- SELECT FOR UPDATE needed: the unique index resolves the race itself).
CREATE UNIQUE INDEX "uq_ccp_branch_effective_from"
  ON "treasury"."cash_close_policies"("tenant_id", "branch_id", "effective_from");

-- The resolver's only access path: latest version effective at or before
-- some `asOf` instant, for one branch.
CREATE INDEX "cash_close_policies_resolve_idx"
  ON "treasury"."cash_close_policies"("tenant_id", "branch_id", "effective_from" DESC);

ALTER TABLE "treasury"."cash_close_policies" ADD CONSTRAINT "cash_close_policies_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id")
  REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Untenanted global FK, mirroring `cash_movements.performed_by` and
-- `stock_movements.performed_by` exactly: `identity.users` carries no
-- `tenant_id`, so no composite form exists for this edge.
ALTER TABLE "treasury"."cash_close_policies" ADD CONSTRAINT "cash_close_policies_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- Immutable append-only facts (§5.3 of the design gate). SELECT is
-- table-level; INSERT is COLUMN-level and deliberately excludes `created_at`
-- so `ros_app` cannot forge the creation instant and defeat the
-- anti-backdating CHECK (the exact `governance.approval_decisions` pattern,
-- empirically verified in migration 32).
GRANT SELECT ON "treasury"."cash_close_policies" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "effective_from", "count_mode",
  "variance_tolerance_minor_units", "currency",
  "variance_approval_expiry_seconds", "created_by"
) ON "treasury"."cash_close_policies" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "treasury"."cash_close_policies" FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "treasury"."cash_close_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_close_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_close_policies_select ON "treasury"."cash_close_policies" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY cash_close_policies_insert ON "treasury"."cash_close_policies" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No UPDATE policy. No DELETE policy. Versions are immutable facts.

COMMENT ON TABLE "treasury"."cash_close_policies" IS
  'P1G-1 narrow Treasury cash-close policy — NOT the generic FR-PLT-025 six-level settings hierarchy (Platform Default / Country Pack / Tenant / Brand / Branch / Terminal) and NOT the FR-PLT-026 lock mechanism. Both remain NOT IMPLEMENTED. This table is branch-scoped only.';
