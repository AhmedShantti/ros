-- ---------------------------------------------------------------------------
-- P0 PIN substrate — authorised by the D-2 AMENDMENT (2026-08-19).
--
-- D-2 was reopened IN PART, to the minimum FR-SEC-021/022 require:
--   1. Employee <-> User linkage      (SRS 7.3 #25: "May link to at most one User")
--   2. permitted / home branch        (FR-HRM-001 "permitted branches", FR-HRM-005)
--   3. tenant-safe Terminal -> Branch (FR-SEC-021 cannot be trusted otherwise)
--   4. FR-SEC-021 / FR-SEC-022 PIN behaviour
--
-- STILL DEFERRED, and NOT implemented here: general branch-scoped RBAC
-- (FR-SEC-002/003/004) and the wider Workforce domain (scheduling, attendance,
-- payroll, compensation, certifications). This is deliberately NOT the full
-- FR-HRM-001 employee record, which therefore remains PARTIAL.
--
-- The permitted-branch set is AUTHENTICATION INTEGRITY only. It grants no
-- permission and takes no part in permission resolution.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "identity"."EmployeeStatus" AS ENUM ('active', 'suspended', 'terminated');

-- AlterTable: FR-SEC-022 lockout state, persisted so it survives request and
-- process boundaries. Applies to the `pin` credential; harmless for others.
ALTER TABLE "identity"."credentials"
  ADD COLUMN "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "identity"."employees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "code" VARCHAR(32) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "home_branch_id" UUID NOT NULL,
    "status" "identity"."EmployeeStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."employee_branches" (
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_branches_pkey" PRIMARY KEY ("employee_id", "branch_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "identity"."employees"("user_id");
CREATE UNIQUE INDEX "employees_tenant_id_id_key" ON "identity"."employees"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_employee_code" ON "identity"."employees"("tenant_id", "code");
CREATE INDEX "employees_tenant_id_home_branch_id_idx" ON "identity"."employees"("tenant_id", "home_branch_id");
CREATE INDEX "employee_branches_tenant_id_branch_id_idx" ON "identity"."employee_branches"("tenant_id", "branch_id");

-- AddForeignKey
ALTER TABLE "identity"."employees" ADD CONSTRAINT "employees_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SRS 7.3 #25: at most one User. The UNIQUE index above also stops two employees
-- claiming the same login, which the aggregate boundary implies.
ALTER TABLE "identity"."employees" ADD CONSTRAINT "employees_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Composite tenant-safe FK (ADR 0008 D-09): an employee can never take another
-- tenant's branch as home. RI is evaluated with row security DISABLED, so this
-- is a structural guarantee rather than an application check.
ALTER TABLE "identity"."employees" ADD CONSTRAINT "employees_tenant_id_home_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "home_branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "identity"."employee_branches" ADD CONSTRAINT "employee_branches_tenant_id_employee_id_fkey"
  FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "identity"."employee_branches" ADD CONSTRAINT "employee_branches_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- D-2 (amended) item 3 — Terminal -> Branch is no longer a bare recorded UUID.
-- Probed before application: zero terminals reference a non-existent
-- (tenant_id, branch_id) pair, so no row is lost and nothing is rewritten.
ALTER TABLE "identity"."terminals" ADD CONSTRAINT "terminals_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "identity"."employees",
  "identity"."employee_branches"
  TO ros_app;

-- ------------------------------------------------------------------- RLS ---
-- FR-PLT-010/011/012: ENABLE + FORCE, fail-closed predicate, and the runtime
-- role is NOSUPERUSER / NOBYPASSRLS so these policies are the real boundary.
ALTER TABLE "identity"."employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."employees" FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_select ON "identity"."employees" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY employees_insert ON "identity"."employees" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY employees_update ON "identity"."employees" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY employees_delete ON "identity"."employees" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "identity"."employee_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."employee_branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_branches_select ON "identity"."employee_branches" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY employee_branches_insert ON "identity"."employee_branches" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY employee_branches_update ON "identity"."employee_branches" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY employee_branches_delete ON "identity"."employee_branches" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
