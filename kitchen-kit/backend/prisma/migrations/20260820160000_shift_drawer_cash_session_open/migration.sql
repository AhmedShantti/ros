-- ---------------------------------------------------------------------------
-- P1D-1 — Operational Shift + Drawer + CashSession OPEN.
--
-- Authorised by carried item P1D-A (2026-08-20): D-2's Workforce defer is
-- reopened NARROWLY for an Operational Shift identity and lifecycle, and for
-- nothing else. Schedule, ScheduledShift, Attendance, clock events, breaks,
-- leave, swaps, payroll and labour cost all remain deferred and are absent here.
--
-- OPEN ONLY. There is no close command, no counted cash, no denominations, no
-- variance, no pay-in/out, no safe drop and no approval — and the runtime GRANTS
-- below make that true at the database, not merely at the service layer.
--
-- ── DOCUMENTED DEVIATIONS FROM THE APPROVED SQL, AND WHY ────────────────────
--
--   `workforce.shifts` does not exist in the approved SQL at all. The SRS puts
--       Shift in Workforce (§5.4), routes `Workforce ──▶ Treasury
--       [shift → cash session]` on the context map, makes Workforce the
--       publisher of `shift.opened` (§5.5.4), and models a cash session as "one
--       employee, one SHIFT, one drawer" (§16.2). The omission is therefore
--       physical, not conceptual, and P1D-A resolves it in the SRS's favour.
--
--   `cash_sessions` has no shift column in the approved SQL, contradicting
--       §16.2's own model diagram. `shift_id` is added, NOT NULL.
--
--   `UNIQUE (drawer_id, status)` — the approved SQL's attempt at FR-FIN-001 — is
--       NOT reproduced. It is wrong: it permits exactly one OPEN and one CLOSED
--       session per drawer for all time, so the second close of a drawer's life
--       would fail. The approved SQL's own inline comment concedes the point
--       ("partial-unique via index below supersedes this in practice"), but no
--       such index was ever written. A partial unique index is written here.
--
--   `cash_sessions.employee_id → workforce.employees(id)` becomes
--       `identity.employees`, following the P1A precedent: the D-2 amendment
--       built the employee substrate there. Same entity, repository location.
--
--   No `tenant_id` appears on the approved SQL's treasury tables. FR-PLT-003 [M]
--       requires one on every tenant-scoped record and RLS cannot work without
--       it, so all three tables carry it.
--
--   `cash_sessions.currency` is added. The approved SQL has no currency column,
--       but an opening float is money and money without a currency is a number
--       (ADR-008). It is snapshotted from the branch, never supplied by a client.
--
--   Deliberately NOT created: `treasury.cash_movements`, `treasury.denominations`,
--       `treasury.reconciliations`, `treasury.day_closes`,
--       `treasury.session_summaries`, `treasury.variance_reports`,
--       `treasury.expenses`, and every `workforce.*` table other than `shifts`.
--       None has an executable consumer in this slice.
-- ---------------------------------------------------------------------------

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "workforce";
CREATE SCHEMA IF NOT EXISTS "treasury";

-- CreateEnum
CREATE TYPE "workforce"."ShiftStatus" AS ENUM ('open', 'closed');
CREATE TYPE "treasury"."CashSessionStatus" AS ENUM ('open', 'closed');

-- ------------------------------------------------------------------ SHIFT ---
CREATE TABLE "workforce"."shifts" (
    "id"          UUID NOT NULL,
    "tenant_id"   UUID NOT NULL,
    "branch_id"   UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "status"      "workforce"."ShiftStatus" NOT NULL DEFAULT 'open',
    "opened_at"   TIMESTAMPTZ(6) NOT NULL,
    "closed_at"   TIMESTAMPTZ(6),
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id"),
    -- A closed shift must say when. Nothing can close one yet; the constraint is
    -- here so the close slice cannot introduce a half-closed row later.
    CONSTRAINT "ck_shift_closed_at" CHECK ("status" <> 'closed' OR "closed_at" IS NOT NULL),
    CONSTRAINT "ck_shift_period" CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at")
);

CREATE UNIQUE INDEX "shifts_tenant_id_id_key" ON "workforce"."shifts"("tenant_id", "id");

-- THE composite target `treasury.cash_sessions` references. A session must match
-- all four columns, so a session whose branch or employee disagrees with its
-- shift is a foreign-key violation rather than a missed service check.
CREATE UNIQUE INDEX "uq_shift_scope"
  ON "workforce"."shifts"("tenant_id", "branch_id", "employee_id", "id");

CREATE INDEX "shifts_tenant_id_branch_id_status_idx"
  ON "workforce"."shifts"("tenant_id", "branch_id", "status");
CREATE INDEX "shifts_tenant_id_employee_id_status_idx"
  ON "workforce"."shifts"("tenant_id", "employee_id", "status");

ALTER TABLE "workforce"."shifts"
  ADD CONSTRAINT "shifts_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- D-09 composite FKs: a shift can never reach another tenant's branch or employee.
ALTER TABLE "workforce"."shifts"
  ADD CONSTRAINT "shifts_branch_fkey" FOREIGN KEY ("tenant_id", "branch_id")
  REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."shifts"
  ADD CONSTRAINT "shifts_employee_fkey" FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- NOTE ON SHIFT OVERLAP. No one-open-shift-per-employee constraint is created.
-- The only overlap rule in the SRS is §7.3 #26's "no overlapping shifts for one
-- employee", and that is an invariant of the SCHEDULE aggregate over
-- SCHEDULED shifts — roster planning, not the operational duty period modelled
-- here. Inventing a global uniqueness for convenience would be a product
-- decision no source makes. CashSession integrity does not depend on it: the
-- session names its exact shift through the four-column key above.

-- ----------------------------------------------------------------- DRAWER ---
CREATE TABLE "treasury"."drawers" (
    "id"          UUID NOT NULL,
    "tenant_id"   UUID NOT NULL,
    "branch_id"   UUID NOT NULL,
    "name"        VARCHAR(64) NOT NULL,
    "terminal_id" UUID,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drawers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "drawers_tenant_id_id_key" ON "treasury"."drawers"("tenant_id", "id");
-- Composite target for `cash_sessions`: a session can never reach a drawer in
-- another branch.
CREATE UNIQUE INDEX "uq_drawer_scope"
  ON "treasury"."drawers"("tenant_id", "branch_id", "id");
CREATE UNIQUE INDEX "uq_drawer_name"
  ON "treasury"."drawers"("tenant_id", "branch_id", "name");
CREATE INDEX "drawers_tenant_id_branch_id_idx"
  ON "treasury"."drawers"("tenant_id", "branch_id");

ALTER TABLE "treasury"."drawers"
  ADD CONSTRAINT "drawers_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "treasury"."drawers"
  ADD CONSTRAINT "drawers_branch_fkey" FOREIGN KEY ("tenant_id", "branch_id")
  REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- ADR 0008 D-16 precedent: `(branch_id, id)` on terminals is the same branch-safe
-- target `org.stations` already uses. Same-branch implies same-tenant, because
-- `branch_id` is itself constrained tenant-safely above.
ALTER TABLE "treasury"."drawers"
  ADD CONSTRAINT "drawers_terminal_fkey" FOREIGN KEY ("branch_id", "terminal_id")
  REFERENCES "identity"."terminals"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------- CASH SESSION ---
CREATE TABLE "treasury"."cash_sessions" (
    "id"            UUID NOT NULL,
    "tenant_id"     UUID NOT NULL,
    "branch_id"     UUID NOT NULL,
    "drawer_id"     UUID NOT NULL,
    "shift_id"      UUID NOT NULL,
    "employee_id"   UUID NOT NULL,
    "opening_float" BIGINT NOT NULL,
    "currency"      CHAR(3) NOT NULL,
    "status"        "treasury"."CashSessionStatus" NOT NULL DEFAULT 'open',
    "opened_at"     TIMESTAMPTZ(6) NOT NULL,
    "closed_at"     TIMESTAMPTZ(6),
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id"),
    -- FR-POS-090 declares an opening FLOAT. A negative float is not a float; no
    -- source permits one, so the database refuses it.
    CONSTRAINT "ck_cash_session_float" CHECK ("opening_float" >= 0),
    CONSTRAINT "ck_cash_session_closed_at" CHECK ("status" <> 'closed' OR "closed_at" IS NOT NULL),
    CONSTRAINT "ck_cash_session_period" CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at")
);

CREATE UNIQUE INDEX "cash_sessions_tenant_id_id_key"
  ON "treasury"."cash_sessions"("tenant_id", "id");

-- ================== FR-FIN-001 [M] — THE ONE-OPEN-SESSION INVARIANT ==========
-- "one open cash session per drawer at any time."
--
-- A PARTIAL unique index, not `UNIQUE (drawer_id, status)`. The difference is not
-- stylistic: the plain composite would allow exactly one CLOSED row per drawer
-- for the life of the system, so a drawer could never be used twice. Restricting
-- uniqueness to `WHERE status = 'open'` states the invariant the SRS actually
-- wrote, and leaves closed history unbounded.
--
-- Scoped on `drawer_id` alone, deliberately: it is a primary key, so it is
-- already globally unique, and adding `tenant_id` would only widen what the
-- index permits.
--
-- This is also the CONCURRENCY control. Two racing opens on one drawer both
-- reach the index; PostgreSQL admits exactly one and raises 23505 for the other,
-- which the service turns into a deterministic 409. No advisory lock, no
-- read-then-write window.
CREATE UNIQUE INDEX "uq_one_open_session_per_drawer"
  ON "treasury"."cash_sessions"("drawer_id")
  WHERE "status" = 'open';
-- =============================================================================

CREATE INDEX "cash_sessions_tenant_id_branch_id_status_idx"
  ON "treasury"."cash_sessions"("tenant_id", "branch_id", "status");
CREATE INDEX "cash_sessions_tenant_id_shift_id_idx"
  ON "treasury"."cash_sessions"("tenant_id", "shift_id");
CREATE INDEX "cash_sessions_tenant_id_employee_id_idx"
  ON "treasury"."cash_sessions"("tenant_id", "employee_id");

ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "cash_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "cash_sessions_branch_fkey" FOREIGN KEY ("tenant_id", "branch_id")
  REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Same tenant AND same branch as the session.
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "cash_sessions_drawer_fkey"
  FOREIGN KEY ("tenant_id", "branch_id", "drawer_id")
  REFERENCES "treasury"."drawers"("tenant_id", "branch_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- FOUR columns. This is what makes "session employee ≠ shift employee" and
-- "session branch ≠ shift branch" impossible rather than merely validated —
-- FR-FIN-002's "bound to exactly one employee" enforced structurally.
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "cash_sessions_shift_fkey"
  FOREIGN KEY ("tenant_id", "branch_id", "employee_id", "shift_id")
  REFERENCES "workforce"."shifts"("tenant_id", "branch_id", "employee_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury"."cash_sessions"
  ADD CONSTRAINT "cash_sessions_employee_fkey" FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- LEAST PRIVILEGE, and it encodes the slice boundary.
--
-- No UPDATE and no DELETE on any of the three tables. Close, counted cash,
-- variance and reconciliation are not implemented, so the runtime role is not
-- given the ability to write them "for later convenience" — a privilege granted
-- ahead of the behaviour that needs it is a privilege nothing is testing.
-- The close slice grants exactly the columns it requires, when it exists.
GRANT USAGE ON SCHEMA "workforce" TO ros_app;
GRANT USAGE ON SCHEMA "treasury" TO ros_app;
GRANT SELECT, INSERT ON "workforce"."shifts" TO ros_app;
GRANT SELECT, INSERT ON "treasury"."drawers" TO ros_app;
GRANT SELECT, INSERT ON "treasury"."cash_sessions" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "workforce"."shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY shifts_select ON "workforce"."shifts" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY shifts_insert ON "workforce"."shifts" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "treasury"."drawers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."drawers" FORCE ROW LEVEL SECURITY;
CREATE POLICY drawers_select ON "treasury"."drawers" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY drawers_insert ON "treasury"."drawers" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "treasury"."cash_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "treasury"."cash_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_sessions_select ON "treasury"."cash_sessions" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY cash_sessions_insert ON "treasury"."cash_sessions" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No UPDATE or DELETE policy exists on any of the three tables. Even if the
-- grants above were widened by mistake, there is no policy to permit the row.
