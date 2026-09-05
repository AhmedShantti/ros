-- ---------------------------------------------------------------------------
-- Migration 38 — D4-1B LOSSLESS REVOKED-TERMINAL RECOVERY
--
-- Authority: docs/governance/GOVERNANCE_DECISION_REGISTER.md, "D1-1 — Offline
-- / Sync Protocol Foundation Ratification — 2026-09-02", §21.3 (GD-D1-07
-- REJECTED: a revoked terminal's committed backlog SHALL NOT be silently
-- discarded). D1-1 named candidate mechanisms and ratified nine binding
-- invariants but did NOT ratify one concrete mechanism — this migration is
-- D4-1B's engineering choice within those invariants, recorded in the D4-1B
-- report (kitchen-kit/backend/docs/reports/claude/full-srs-4day/
-- 2026-09-03_D4-1B_offline-domain-handlers.md).
--
-- ── WHY A NEW TABLE, NOT ONE OF D4-1A'S SIX ────────────────────────────────
-- `sync.operation_dedup` / `sync.sync_operations` / `sync.sync_batches` /
-- `sync.device_state` / `sync.conflict_records` / `sync.revalidation_
-- exceptions` each model a fact about an OPERATION or a BATCH already
-- admitted to the pipeline. None of them can represent "an admin explicitly,
-- auditably, and revocably authorized ONE bounded upload window for a
-- terminal the ordinary gate (`SyncTerminalGuard`) currently refuses" — that
-- is an AUTHORIZATION grant, prior to and independent of any batch existing
-- yet. Modelling it as a magic value on an existing table would conflate two
-- different authorities (ordinary terminal-active sync vs. admin-granted
-- recovery) on one column, which is exactly the kind of second silent
-- definition of "may this terminal sync" this slice's brief instructs against.
--
-- ── WHAT THIS MIGRATION DOES NOT TOUCH ─────────────────────────────────────
-- No column is added to `identity.terminals` — a terminal's own `status`
-- remains the single, unambiguous statement of its ordinary operating
-- authority, and recovery consuming a grant never writes it. No D4-1A
-- migration is modified in place. No new permission code: grant issuance is
-- gated by `identity.terminal.manage`, the SAME permission that already
-- revokes a terminal (`POST /auth/terminals/:terminalId/status`).
-- ---------------------------------------------------------------------------

CREATE TABLE "sync"."recovery_grants" (
    "id"        UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    "terminal_id" UUID NOT NULL,
    -- The terminal's branch AT GRANT TIME, server-derived — never client-supplied.
    "branch_id"   UUID NOT NULL,

    -- The admin membership that authorized this grant. Recorded, not
    -- FK-enforced, mirroring `conflict_records.resolved_by` above it.
    "authorized_by_membership_id" UUID NOT NULL,
    -- Required — an unaccountable recovery grant is not auditable.
    "reason"                      TEXT NOT NULL,

    -- `pending` | `consumed` | `revoked`. No `expired` value: expiry is derived
    -- from `expires_at` at read time, never written back.
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',

    "issued_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    "consumed_at"       TIMESTAMPTZ(6),
    -- The ONE batch this grant was consumed for. A retry of this exact
    -- batchId (crash/timeout resubmission, honouring D4-1A's own
    -- crash-recovery lease replay) is still accepted; any OTHER batchId
    -- against an already-consumed grant is refused.
    "consumed_batch_id" UUID,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_recovery_grants_status" CHECK ("status" IN ('pending', 'consumed', 'revoked')),
    CONSTRAINT "ck_recovery_grants_consumed" CHECK (
      "status" <> 'consumed' OR ("consumed_at" IS NOT NULL AND "consumed_batch_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "recovery_grants_tenant_id_id_key" ON "sync"."recovery_grants"("tenant_id", "id");
-- The consumption CAS and the guard's lookup both filter on exactly this shape.
CREATE INDEX "recovery_grants_tenant_terminal_status_idx"
  ON "sync"."recovery_grants"("tenant_id", "terminal_id", "status");

ALTER TABLE "sync"."recovery_grants" ADD CONSTRAINT "recovery_grants_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."recovery_grants" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
-- FR-PLT-010/011/012, CT-05. Identical shape to every other tenant-scoped
-- table in the `sync` schema (migration 37): ENABLE + FORCE, four policies
-- keyed on the transaction-local `app.tenant_id` from `PrismaService
-- .withAuthContext`. A missing context yields NULL and every policy fails
-- closed.
ALTER TABLE "sync"."recovery_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."recovery_grants" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "recovery_grants_select" ON "sync"."recovery_grants"
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "recovery_grants_insert" ON "sync"."recovery_grants"
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "recovery_grants_update" ON "sync"."recovery_grants"
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "recovery_grants_delete" ON "sync"."recovery_grants"
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
