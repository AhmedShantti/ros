-- ---------------------------------------------------------------------------
-- HR-1 — Workforce Core: Employee record, Schedule substrate, Attendance.
--
-- Authority: SRS Chapter 14 (FR-HRM-001/002/003/005/006/010/012/020/021/022/
-- 023/025), §7.3 Aggregate Catalogue #25 Employee / #26 Schedule /
-- #27 AttendanceRecord, §5.5.4 (no clock-in/out event is in the core event
-- catalogue subset — none is invented here).
--
-- P1D-A is UNCHANGED: `workforce.shifts` (Operational Shift) and
-- `treasury.cash_sessions` remain distinct, and this migration adds no column
-- to either. The govenance register's P1D-1 "still deferred" list (Schedule,
-- ScheduledShift, AttendanceRecord, clock-in/out and its corrections) is what
-- this migration implements — the narrow reopening HR-1's brief authorises.
--
-- ── WHERE `employees` PHYSICALLY LIVES, AND WHY THIS DOES NOT MOVE IT ──────
-- SRS §7.3 #25 assigns Employee to the Workforce context, but the row has
-- lived in `identity` since the D-2 amendment (migration
-- `20260819160000_pin_employee_substrate`) because `PinService` reads it
-- inside the SAME transaction as credential/lockout checks (nested
-- transactions are unsupported — see `pin-verification.contract.ts`).
-- Relocating the table would require rewriting that security-critical,
-- already-proven transactional path, which nothing in this slice's brief
-- asks for. This migration ADDS the missing FR-HRM-001/002 columns to the
-- EXISTING table instead — additive, nullable except where a value is
-- mechanically safe to default, zero risk to any existing row or query.
-- Mirrors the exact precedent P1D-A itself set: "the absence of
-- `workforce.shifts` from the approved SQL is a physical-design omission,
-- not evidence that the two concepts are one" — physical placement is not
-- conceptual ownership. The new HR write surface lives in
-- `src/modules/workforce/employees/`, not `src/modules/identity/employees/`.
--
-- ── WHAT IS DELIBERATELY NOT INVENTED ──────────────────────────────────────
-- FR-HRM-022's grace period and FR-HRM-023's early-clock-in window get NO
-- DEFAULT anywhere in this file: the SRS states both are "configurable" but
-- gives no number for either (contrast FR-HRM-012's schedule rules, which the
-- SRS DOES give literal defaults for — 6 consecutive days, 11h rest, 12h max
-- shift, 48h before overtime — and which this slice therefore enforces as
-- fixed code constants in the service layer, NOT as a per-branch override
-- table, since no existing config architecture generalises that and building
-- one is out of this slice's scope). `attendance_settings` rows are wholly
-- absent until a tenant explicitly configures them; the consuming service
-- treats an absent/NULL field as "this specific check is inactive", never as
-- zero and never as unlimited. See the HR-1 report for this documented gap.
-- ---------------------------------------------------------------------------

-- ============================================================ EMPLOYEE ====

-- CreateEnum — FR-HRM-002. Exactly these five; no sixth type.
CREATE TYPE "identity"."EmployeeEmploymentType" AS ENUM (
  'full_time', 'part_time', 'casual', 'contractor', 'trainee'
);

-- AlterTable — FR-HRM-001. Every column additive and NULLABLE (except
-- `names_localized`, which defaults to an empty JSON object — a safe,
-- non-fabricated "no locale variants recorded yet" starting state, not a
-- guessed business fact). No existing row loses data or fails a NOT NULL
-- backfill.
ALTER TABLE "identity"."employees"
  ADD COLUMN "names_localized"  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "national_id"      VARCHAR(64),
  ADD COLUMN "contact_details"  JSONB,
  ADD COLUMN "emergency_contact" JSONB,
  ADD COLUMN "date_of_birth"    DATE,
  ADD COLUMN "hire_date"        DATE,
  ADD COLUMN "termination_date" DATE,
  ADD COLUMN "position"         VARCHAR(120),
  ADD COLUMN "department"       VARCHAR(120),
  ADD COLUMN "employment_type"  "identity"."EmployeeEmploymentType";

ALTER TABLE "identity"."employees"
  ADD CONSTRAINT "ck_employee_termination_after_hire"
    CHECK ("termination_date" IS NULL OR "hire_date" IS NULL OR "termination_date" >= "hire_date"),
  ADD CONSTRAINT "ck_employee_dob_not_future"
    CHECK ("date_of_birth" IS NULL OR "date_of_birth" <= CURRENT_DATE);

COMMENT ON COLUMN "identity"."employees"."employment_type" IS
  'FR-HRM-002. NULL on any row that predates this migration until explicitly set; the Workforce create command requires it for every NEW employee.';

-- ========================================================= COMPENSATION ===

-- CreateEnum — FR-HRM-003 literal basis values.
CREATE TYPE "workforce"."CompensationBasis" AS ENUM ('hourly', 'monthly_salary', 'per_shift');

-- CreateTable — FR-HRM-003. IMMUTABLE effective-dated versions, the
-- `treasury.cash_close_policies` shape (migration
-- `20260830010000_treasury_cash_close_policies`) exactly: a changed rate is a
-- NEW row, never an edit, so "what did we pay this person on date X" stays
-- answerable regardless of later changes. Visibility of these rows is an
-- APPLICATION permission check (`hr.compensation.view`) enforced by the
-- service/controller, not an RLS row filter — RLS here is tenant isolation
-- only, identical to every other table in this repository.
CREATE TABLE "workforce"."employee_compensations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "basis" "workforce"."CompensationBasis" NOT NULL,
    -- Exact integer minor units. Never a float (BR money discipline).
    "amount_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "employee_compensations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_ec_amount_non_negative" CHECK ("amount_minor_units" >= 0),
    CONSTRAINT "ck_ec_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "ck_ec_no_backdating" CHECK ("effective_from" >= "created_at")
);

CREATE UNIQUE INDEX "employee_compensations_tenant_id_id_key" ON "workforce"."employee_compensations"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_ec_employee_effective_from" ON "workforce"."employee_compensations"("tenant_id", "employee_id", "effective_from");
CREATE INDEX "employee_compensations_resolve_idx" ON "workforce"."employee_compensations"("tenant_id", "employee_id", "effective_from" DESC);

ALTER TABLE "workforce"."employee_compensations" ADD CONSTRAINT "employee_compensations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workforce"."employee_compensations" ADD CONSTRAINT "employee_compensations_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."employee_compensations" ADD CONSTRAINT "employee_compensations_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT ON "workforce"."employee_compensations" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "employee_id", "basis", "amount_minor_units", "currency",
  "effective_from", "created_by"
) ON "workforce"."employee_compensations" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "workforce"."employee_compensations" FROM ros_app;

ALTER TABLE "workforce"."employee_compensations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."employee_compensations" FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_compensations_select ON "workforce"."employee_compensations" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY employee_compensations_insert ON "workforce"."employee_compensations" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- =========================================================== SCHEDULE =====

-- CreateTable — §7.3 #26 Schedule aggregate root.
CREATE TABLE "workforce"."schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "week_start_date" DATE NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "schedules_tenant_id_id_key" ON "workforce"."schedules"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_schedule_branch_week" ON "workforce"."schedules"("tenant_id", "branch_id", "week_start_date");

ALTER TABLE "workforce"."schedules" ADD CONSTRAINT "schedules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workforce"."schedules" ADD CONSTRAINT "schedules_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."schedules" ADD CONSTRAINT "schedules_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT ON "workforce"."schedules" TO ros_app;
GRANT INSERT ("id", "tenant_id", "branch_id", "week_start_date", "created_by") ON "workforce"."schedules" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "workforce"."schedules" FROM ros_app;

ALTER TABLE "workforce"."schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."schedules" FORCE ROW LEVEL SECURITY;
CREATE POLICY schedules_select ON "workforce"."schedules" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY schedules_insert ON "workforce"."schedules" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- CreateTable — §7.3 #26's contained entity.
CREATE TABLE "workforce"."scheduled_shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "position" VARCHAR(120),
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "scheduled_shifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_scheduled_shift_starts_before_ends" CHECK ("starts_at" < "ends_at")
);

CREATE UNIQUE INDEX "scheduled_shifts_tenant_id_id_key" ON "workforce"."scheduled_shifts"("tenant_id", "id");
CREATE INDEX "scheduled_shifts_tenant_id_branch_id_starts_at_idx" ON "workforce"."scheduled_shifts"("tenant_id", "branch_id", "starts_at");
CREATE INDEX "scheduled_shifts_tenant_id_employee_id_starts_at_idx" ON "workforce"."scheduled_shifts"("tenant_id", "employee_id", "starts_at");

ALTER TABLE "workforce"."scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workforce"."scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_tenant_id_schedule_id_fkey"
  FOREIGN KEY ("tenant_id", "schedule_id") REFERENCES "workforce"."schedules"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- §7.3 #26's own key invariant: "No overlapping shifts for one employee".
-- A real Postgres EXCLUDE constraint, not merely re-checked in application
-- code — the exact `catalogue.price_lists` precedent (migration
-- `20260819120000_price_list_no_overlap`). `btree_gist` is already present in
-- this database (that same migration installs it); `CREATE EXTENSION IF NOT
-- EXISTS` is idempotent and repeated here only for this file's own
-- self-containment.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "workforce"."scheduled_shifts"
  ADD CONSTRAINT "ex_scheduled_shift_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "employee_id" WITH =,
    tstzrange("starts_at", "ends_at") WITH &&
  );

COMMENT ON CONSTRAINT "ex_scheduled_shift_no_overlap" ON "workforce"."scheduled_shifts" IS
  'SRS §7.3 #26: no overlapping shifts for one employee. Half-open [starts_at, ends_at) — two shifts that merely touch at an instant do not overlap.';

GRANT SELECT ON "workforce"."scheduled_shifts" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "schedule_id", "employee_id", "position",
  "starts_at", "ends_at", "created_by"
) ON "workforce"."scheduled_shifts" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "workforce"."scheduled_shifts" FROM ros_app;

ALTER TABLE "workforce"."scheduled_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."scheduled_shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_shifts_select ON "workforce"."scheduled_shifts" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scheduled_shifts_insert ON "workforce"."scheduled_shifts" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ========================================================= ATTENDANCE =====

CREATE TYPE "workforce"."AttendanceStatus" AS ENUM ('open', 'closed');

-- CreateTable — §7.3 #27 AttendanceRecord aggregate root. MUTABLE (like
-- `treasury.cash_sessions`), unlike its own immutable `clock_events` /
-- `attendance_corrections` children: clock-out and manual correction both
-- update this row, and every mutation is additionally evidenced by an
-- immutable child row, so nothing here is a silent, un-evidenced edit.
CREATE TABLE "workforce"."attendance_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "scheduled_shift_id" UUID,
    "status" "workforce"."AttendanceStatus" NOT NULL DEFAULT 'open',
    "clock_in_at" TIMESTAMPTZ(6) NOT NULL,
    "clock_out_at" TIMESTAMPTZ(6),

    -- FR-HRM-022 — five INDEPENDENT flags. Never compressed into one boolean.
    "late_arrival" BOOLEAN NOT NULL DEFAULT false,
    "early_departure" BOOLEAN NOT NULL DEFAULT false,
    "missing_clock_out" BOOLEAN NOT NULL DEFAULT false,
    "outside_geofence" BOOLEAN NOT NULL DEFAULT false,
    "unscheduled" BOOLEAN NOT NULL DEFAULT false,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id"),
    -- §7.3 #27's own key invariant: "Clock-out after clock-in".
    CONSTRAINT "ck_attendance_clock_out_after_in" CHECK ("clock_out_at" IS NULL OR "clock_out_at" > "clock_in_at")
);

CREATE UNIQUE INDEX "attendance_records_tenant_id_id_key" ON "workforce"."attendance_records"("tenant_id", "id");
CREATE INDEX "attendance_records_tenant_id_branch_id_status_idx" ON "workforce"."attendance_records"("tenant_id", "branch_id", "status");
CREATE INDEX "attendance_records_tenant_id_employee_id_status_idx" ON "workforce"."attendance_records"("tenant_id", "employee_id", "status");

-- Real-Postgres, concurrency-safe "one open attendance record per employee"
-- guard (tests 20/37): a second concurrent clock-in for the SAME employee
-- attempts to insert a second 'open' row and hits this partial unique index,
-- never a read-then-insert race. Mirrors `treasury.cash_sessions`'
-- one-open-session-per-drawer discipline.
CREATE UNIQUE INDEX "uq_attendance_one_open_per_employee" ON "workforce"."attendance_records"("tenant_id", "employee_id") WHERE "status" = 'open';

ALTER TABLE "workforce"."attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_records" ADD CONSTRAINT "attendance_records_tenant_id_scheduled_shift_id_fkey"
  FOREIGN KEY ("tenant_id", "scheduled_shift_id") REFERENCES "workforce"."scheduled_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT ON "workforce"."attendance_records" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "employee_id", "scheduled_shift_id", "status",
  "clock_in_at", "clock_out_at", "late_arrival", "early_departure",
  "missing_clock_out", "outside_geofence", "unscheduled"
) ON "workforce"."attendance_records" TO ros_app;
-- Narrow column-level UPDATE. `outside_geofence` is deliberately excluded:
-- it is a clock-in-time-only determination and is never revisited, including
-- by a correction (a correction changes WHEN, not WHERE, the employee was).
GRANT UPDATE (
  "status", "clock_in_at", "clock_out_at", "late_arrival", "early_departure",
  "missing_clock_out", "unscheduled"
) ON "workforce"."attendance_records" TO ros_app;
REVOKE DELETE, TRUNCATE ON "workforce"."attendance_records" FROM ros_app;

ALTER TABLE "workforce"."attendance_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."attendance_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_records_select ON "workforce"."attendance_records" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY attendance_records_insert ON "workforce"."attendance_records" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY attendance_records_update ON "workforce"."attendance_records" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- CreateEnum
CREATE TYPE "workforce"."ClockEventType" AS ENUM ('clock_in', 'clock_out');

-- All three literal SRS channels are MODELLED (FR-HRM-020/021); only
-- `pos_pin` is reachable by any route in this repository — no mobile auth
-- channel and no biometric device integration exist here (documented gap,
-- HR-1 report).
CREATE TYPE "workforce"."ClockMethod" AS ENUM ('pos_pin', 'mobile', 'biometric');

-- CreateTable — FR-HRM-021. IMMUTABLE, append-only operational evidence.
-- Never updated, never deleted, regardless of any later manual correction.
CREATE TABLE "workforce"."clock_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance_record_id" UUID NOT NULL,
    "event_type" "workforce"."ClockEventType" NOT NULL,
    "method" "workforce"."ClockMethod" NOT NULL,
    "terminal_id" UUID,
    "device_id" VARCHAR(120),
    "gps_lat" DECIMAL(9,6),
    "gps_lng" DECIMAL(9,6),
    -- Server-derived (DB DEFAULT, not app-supplied — see the INSERT grant
    -- below). Immutable evidence of when the event was actually recorded,
    -- never a client-asserted instant.
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "clock_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_clock_event_terminal_required_for_pos_pin"
      CHECK ("method" != 'pos_pin' OR "terminal_id" IS NOT NULL),
    CONSTRAINT "ck_clock_event_gps_pair" CHECK (("gps_lat" IS NULL) = ("gps_lng" IS NULL))
);

CREATE UNIQUE INDEX "clock_events_tenant_id_id_key" ON "workforce"."clock_events"("tenant_id", "id");
CREATE INDEX "clock_events_tenant_id_attendance_record_id_occurred_at_idx" ON "workforce"."clock_events"("tenant_id", "attendance_record_id", "occurred_at");

ALTER TABLE "workforce"."clock_events" ADD CONSTRAINT "clock_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workforce"."clock_events" ADD CONSTRAINT "clock_events_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."clock_events" ADD CONSTRAINT "clock_events_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."clock_events" ADD CONSTRAINT "clock_events_tenant_id_attendance_record_id_fkey"
  FOREIGN KEY ("tenant_id", "attendance_record_id") REFERENCES "workforce"."attendance_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Terminal has no `(tenant_id, id)` unique key (only `(branch_id, id)` — see
-- `identity.terminals`'s own migration); this is the same composite shape
-- `org.stations` already uses to reach it. A NULL terminal_id (mobile /
-- biometric, forward-compat only) leaves the FK unenforced for that row —
-- correct MATCH SIMPLE behaviour, not a hole, since no route ever populates
-- it for those methods today.
ALTER TABLE "workforce"."clock_events" ADD CONSTRAINT "clock_events_branch_id_terminal_id_fkey"
  FOREIGN KEY ("branch_id", "terminal_id") REFERENCES "identity"."terminals"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT ON "workforce"."clock_events" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "employee_id", "attendance_record_id",
  "event_type", "method", "terminal_id", "device_id", "gps_lat", "gps_lng"
) ON "workforce"."clock_events" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "workforce"."clock_events" FROM ros_app;

ALTER TABLE "workforce"."clock_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."clock_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY clock_events_select ON "workforce"."clock_events" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY clock_events_insert ON "workforce"."clock_events" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- CreateEnum
CREATE TYPE "workforce"."AttendanceCorrectionField" AS ENUM ('clock_in_at', 'clock_out_at');

-- CreateTable — FR-HRM-025. IMMUTABLE, append-only correction evidence. One
-- row per corrected field per correction command; `original_value` is
-- whatever the field held immediately before THIS correction (so a chain of
-- corrections remains fully reconstructable from these rows alone).
CREATE TABLE "workforce"."attendance_corrections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance_record_id" UUID NOT NULL,
    "field" "workforce"."AttendanceCorrectionField" NOT NULL,
    "original_value" TIMESTAMPTZ(6),
    "corrected_value" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_attendance_correction_reason_not_blank" CHECK (length(btrim("reason")) > 0)
);

CREATE UNIQUE INDEX "attendance_corrections_tenant_id_id_key" ON "workforce"."attendance_corrections"("tenant_id", "id");
CREATE INDEX "attendance_corrections_tenant_id_attendance_record_id_created_idx" ON "workforce"."attendance_corrections"("tenant_id", "attendance_record_id", "created_at");

ALTER TABLE "workforce"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_tenant_id_attendance_record_id_fkey"
  FOREIGN KEY ("tenant_id", "attendance_record_id") REFERENCES "workforce"."attendance_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_corrections" ADD CONSTRAINT "attendance_corrections_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT ON "workforce"."attendance_corrections" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "employee_id", "attendance_record_id",
  "field", "original_value", "corrected_value", "reason", "actor_id"
) ON "workforce"."attendance_corrections" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "workforce"."attendance_corrections" FROM ros_app;

ALTER TABLE "workforce"."attendance_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."attendance_corrections" FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_corrections_select ON "workforce"."attendance_corrections" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY attendance_corrections_insert ON "workforce"."attendance_corrections" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- CreateTable — FR-HRM-022/023 configurable thresholds. IMMUTABLE versioned
-- rows, the `cash_close_policies` shape exactly. See the file header for why
-- `grace_minutes` / `early_clock_in_minutes` carry no DEFAULT.
CREATE TABLE "workforce"."attendance_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "grace_minutes" INTEGER,
    "early_clock_in_minutes" INTEGER,
    "geofence_center_lat" DECIMAL(9,6),
    "geofence_center_lng" DECIMAL(9,6),
    "geofence_radius_meters" INTEGER,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_as_grace_non_negative" CHECK ("grace_minutes" IS NULL OR "grace_minutes" >= 0),
    CONSTRAINT "ck_as_early_clock_in_non_negative" CHECK ("early_clock_in_minutes" IS NULL OR "early_clock_in_minutes" >= 0),
    CONSTRAINT "ck_as_geofence_radius_positive" CHECK ("geofence_radius_meters" IS NULL OR "geofence_radius_meters" > 0),
    -- All three geofence columns set together, or none at all.
    CONSTRAINT "ck_as_geofence_triple" CHECK (
      ("geofence_center_lat" IS NULL AND "geofence_center_lng" IS NULL AND "geofence_radius_meters" IS NULL)
      OR ("geofence_center_lat" IS NOT NULL AND "geofence_center_lng" IS NOT NULL AND "geofence_radius_meters" IS NOT NULL)
    ),
    CONSTRAINT "ck_as_no_backdating" CHECK ("effective_from" >= "created_at")
);

CREATE UNIQUE INDEX "attendance_settings_tenant_id_id_key" ON "workforce"."attendance_settings"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_attendance_settings_branch_effective_from" ON "workforce"."attendance_settings"("tenant_id", "branch_id", "effective_from");
CREATE INDEX "attendance_settings_resolve_idx" ON "workforce"."attendance_settings"("tenant_id", "branch_id", "effective_from" DESC);

ALTER TABLE "workforce"."attendance_settings" ADD CONSTRAINT "attendance_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_settings" ADD CONSTRAINT "attendance_settings_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workforce"."attendance_settings" ADD CONSTRAINT "attendance_settings_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT ON "workforce"."attendance_settings" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "branch_id", "effective_from", "grace_minutes",
  "early_clock_in_minutes", "geofence_center_lat", "geofence_center_lng",
  "geofence_radius_meters", "created_by"
) ON "workforce"."attendance_settings" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "workforce"."attendance_settings" FROM ros_app;

ALTER TABLE "workforce"."attendance_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workforce"."attendance_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_settings_select ON "workforce"."attendance_settings" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY attendance_settings_insert ON "workforce"."attendance_settings" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
