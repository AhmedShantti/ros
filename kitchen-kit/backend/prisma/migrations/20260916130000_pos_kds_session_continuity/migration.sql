-- ============================================================================
-- POS-KDS-SESSION-CONTINUITY-P0 — trusted POS/KDS session context anchors.
--
-- Additive only. Every existing `identity.sessions` row (console and any
-- pre-existing POS/KDS row alike) gets NULL for all three new columns —
-- there is no fact to backfill (POS/KDS identity previously lived only in
-- the access JWT, never server-side; see the design report,
-- docs/reports/claude/2026-09-16_POS-KDS-SESSION-CONTINUITY-P0_investigation.md,
-- Phase 2). No destructive change, no backfill, no NOT NULL constraint.
--
-- `session_type` mirrors the JWT `typ` claim: NULL = ordinary dashboard
-- session (unchanged). `employee_id`/`branch_id` are CANDIDATE anchors for a
-- POS/KDS session only — never trusted as current truth on their own;
-- `AuthService.refresh()` live-revalidates them against `identity.employees`/
-- `identity.employee_branches`/`org.branches` on every refresh, the same way
-- `TenantContextService.resolveSessionBranch()` already does for every
-- ordinary live POS/KDS request.
--
-- Plain (non-composite) FKs to `identity.employees(id)` / `org.branches(id)`
-- — both globally unique — not the tenant-safe composite FK pattern
-- `identity.terminals.branch` uses, because `identity.sessions` carries no
-- `tenant_id` column of its own (unchanged by this migration; tenant scope
-- for a POS/KDS session is resolved live, at refresh time, via the
-- session's own `membership_id`, exactly as a console session's tenant
-- context already is). Tenant isolation is enforced by RLS on
-- `identity.employees` / `identity.employee_branches` / `org.branches`
-- themselves at query time, not by this FK.
-- ============================================================================

-- CreateEnum
CREATE TYPE "identity"."SessionType" AS ENUM ('pos', 'kds');

-- AlterTable
ALTER TABLE "identity"."sessions"
  ADD COLUMN "session_type" "identity"."SessionType",
  ADD COLUMN "employee_id" UUID,
  ADD COLUMN "branch_id" UUID;

-- CreateIndex
CREATE INDEX "sessions_employee_id_idx" ON "identity"."sessions"("employee_id");

-- CreateIndex
CREATE INDEX "sessions_branch_id_idx" ON "identity"."sessions"("branch_id");

-- AddForeignKey
ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "identity"."employees"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "org"."branches"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
