-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "governance";

-- CreateTable
CREATE TABLE "governance"."audit_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "sequence_no" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_type" VARCHAR(16) NOT NULL,
    "impersonated_by" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(48) NOT NULL,
    "entity_id" UUID,
    "before_state" JSONB,
    "after_state" JSONB,
    "reason_code" VARCHAR(48),
    "reason_text" TEXT,
    "approver_id" UUID,
    "approval_id" UUID,
    "ip_address" INET,
    "user_agent" TEXT,
    "terminal_id" UUID,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID,
    "entry_hash" BYTEA NOT NULL,
    "previous_hash" BYTEA,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_entries_tenant_id_sequence_no_idx" ON "governance"."audit_entries"("tenant_id", "sequence_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_audit_sequence" ON "governance"."audit_entries"("tenant_id", "sequence_no");

-- ============================================================================
-- Phase 12 — append-only + tenant-scoped RLS for the audit trail.
-- Append-only per the approved design (SRS 25.2 "append-only via REVOKE +
-- protective rules"): ros_app may only SELECT + INSERT; UPDATE/DELETE are
-- revoked AND have no RLS policy. Tenant isolation via app.tenant_id (the
-- sentinel platform tenant 000...0 carries global/anonymous auth events).
-- ============================================================================

GRANT USAGE ON SCHEMA "governance" TO ros_app;
GRANT SELECT, INSERT ON "governance"."audit_entries" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "governance"."audit_entries" FROM ros_app;
-- NOTE: an `ALTER DEFAULT PRIVILEGES FOR ROLE ros_migrator ...` statement that
-- previously followed here was removed for Render deployment compatibility
-- (42501 permission denied — the connecting migration role there cannot SET
-- ROLE to ros_migrator). Future governance tables must grant ros_app explicitly,
-- as this migration already does above for audit_entries.

ALTER TABLE "governance"."audit_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "governance"."audit_entries" FORCE ROW LEVEL SECURITY;

-- Read + append are tenant-scoped; there is intentionally NO update/delete policy.
CREATE POLICY audit_entries_select ON "governance"."audit_entries" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY audit_entries_insert ON "governance"."audit_entries" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
