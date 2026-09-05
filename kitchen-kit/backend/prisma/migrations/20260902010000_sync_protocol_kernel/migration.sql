-- ---------------------------------------------------------------------------
-- Migration 37 — D4-1A OFFLINE/SYNC PROTOCOL KERNEL
--
-- Authority: docs/governance/GOVERNANCE_DECISION_REGISTER.md,
-- "D1-1 — Offline / Sync Protocol Foundation Ratification — 2026-09-02".
-- SRS §21.5 (synchronisation protocol), §25.1 (the `sync` schema's own table
-- list: sync_batches, sync_operations, idempotency_keys, conflict_records,
-- device_state).
--
--   FR-OFF-021  every operation carries an idempotency key; processed keys are
--               persisted for at least 30 days; a repeated key returns the
--               ORIGINAL result rather than reprocessing
--   FR-OFF-022  causal order; a parentless operation is DEFERRED, not rejected
--   FR-OFF-023  per-operation accepted/duplicate/conflict/rejected (+ the
--               ratified fifth, non-definitive `deferred`); one failing
--               operation never fails the batch
--   FR-OFF-025  a connection lost mid-batch resumes without duplication
--   FR-OFF-042  device clock skew detected, recorded, alerted; the device's
--               original timestamp preserved alongside the server's
--   FR-OFF-043  conflict register with BOTH versions
--   FR-OFF-046  reconciliation exceptions — SYNC-owned (GD-D1-05)
--   NFR-REL-011 at-most-once financial effect
--
-- ── WHY TWO TABLES AND NOT ONE ─────────────────────────────────────────────
-- `sync.operation_dedup` and `sync.sync_operations` deliberately hold
-- overlapping facts. Correction 1 of the ratification requires it:
-- PostgreSQL demands that a unique constraint on a partitioned table contain
-- every partition-key column — the same rule already documented on
-- `sales.orders` ("PostgreSQL requires the partition key inside every unique
-- constraint"). A single table partitioned by `received_at` could therefore
-- only offer `UNIQUE (tenant_id, op_id, received_at)`, under which the SAME
-- op_id re-submitted after a partition boundary inserts cleanly and the
-- financial effect is applied twice. That is precisely the failure
-- NFR-REL-011 exists to prevent, and it would have appeared only for devices
-- offline across a month boundary — i.e. exactly the CR-01 72-hour case.
--
-- So: identity lives on a small NON-partitioned table whose primary key is
-- genuinely global, and history lives on a table that MAY later be
-- RANGE-partitioned on `received_at` with no correctness consequence at all.
-- `sync_operations` already carries `received_at` in its primary key so that
-- future change is purely physical. It is NOT created partitioned here (see
-- the D4-1A report, "Operation history"): partitioning needs a partition
-- lifecycle job that does not exist in this repository yet, and creating
-- monthly partitions with no process to create the NEXT one would fail writes
-- on the first day of the following month.
--
-- ── WHAT THIS MIGRATION DOES NOT TOUCH ─────────────────────────────────────
-- No identity table (Lane B owns identity schema this wave). No inventory
-- table (Lane A). No domain aggregate gains `hlc`/`sync_state` — the design
-- gate proposed that and D4-1A declines it, because the oplog is the protocol
-- truth and a query-time materialisation must be justified by a concrete
-- D4-1B conflict handler. `sync.idempotency_keys` is UNCHANGED: Sync owns its
-- own reservation record rather than altering shared idempotency semantics
-- for every other endpoint in the application.
-- ---------------------------------------------------------------------------

-- ============================================================ operation_dedup
-- THE authoritative, globally unique operation identity. Never partitioned.
CREATE TABLE "sync"."operation_dedup" (
    "tenant_id"   UUID         NOT NULL,
    "op_id"       UUID         NOT NULL,
    "fingerprint" CHAR(64)     NOT NULL,
    "status"      VARCHAR(16)  NOT NULL,
    "reason_code" VARCHAR(64),
    "result"      JSONB        NOT NULL,
    "batch_id"    UUID         NOT NULL,
    "terminal_id" UUID         NOT NULL,
    "settled_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"  TIMESTAMPTZ(6) NOT NULL,

    -- The single most important constraint in the sync kernel. Global within a
    -- tenant, with no partition-key column diluting it.
    CONSTRAINT "operation_dedup_pkey" PRIMARY KEY ("tenant_id", "op_id"),
    -- A settled row records what happened the FIRST time. `deferred` settles
    -- nothing (non-definitive) and `duplicate` is what a LATER submission is
    -- told, so neither can ever be the stored status.
    CONSTRAINT "ck_operation_dedup_status" CHECK ("status" IN ('accepted', 'conflict', 'rejected'))
);

CREATE INDEX "operation_dedup_expires_at_idx" ON "sync"."operation_dedup"("expires_at");
CREATE INDEX "operation_dedup_tenant_id_batch_id_idx" ON "sync"."operation_dedup"("tenant_id", "batch_id");

ALTER TABLE "sync"."operation_dedup" ADD CONSTRAINT "operation_dedup_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================ sync_operations
-- History. Designed for later RANGE partitioning on received_at.
CREATE TABLE "sync"."sync_operations" (
    "tenant_id"           UUID           NOT NULL,
    "op_id"               UUID           NOT NULL,
    "received_at"         TIMESTAMPTZ(6) NOT NULL,
    "batch_id"            UUID           NOT NULL,
    "terminal_id"         UUID           NOT NULL,
    "branch_id"           UUID           NOT NULL,
    "actor_employee_id"   UUID,
    "type"                VARCHAR(64)    NOT NULL,
    "entity_type"         VARCHAR(48)    NOT NULL,
    "entity_id"           UUID           NOT NULL,
    "caused_by"           UUID,
    -- 52 = 13 physical + 1 + 5 logical + 1 + 32 node (GD-D1-02). Stored
    -- verbatim; the server never rewrites a received HLC.
    "hlc"                 VARCHAR(52)    NOT NULL,
    "origin_device_time"  TIMESTAMPTZ(6) NOT NULL,
    "schema_version"      INTEGER        NOT NULL,
    "payload"             JSONB          NOT NULL,
    "fingerprint"         CHAR(64)       NOT NULL,
    "status"              VARCHAR(16)    NOT NULL,
    "reason_code"         VARCHAR(64),

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("tenant_id", "op_id", "received_at"),
    CONSTRAINT "ck_sync_operations_status" CHECK (
      "status" IN ('accepted', 'duplicate', 'conflict', 'rejected', 'deferred')
    )
);

CREATE INDEX "sync_operations_tenant_entity_hlc_idx"
  ON "sync"."sync_operations"("tenant_id", "entity_type", "entity_id", "hlc");
CREATE INDEX "sync_operations_tenant_terminal_received_idx"
  ON "sync"."sync_operations"("tenant_id", "terminal_id", "received_at" DESC);
CREATE INDEX "sync_operations_tenant_batch_idx"
  ON "sync"."sync_operations"("tenant_id", "batch_id");

ALTER TABLE "sync"."sync_operations" ADD CONSTRAINT "sync_operations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================== sync_batches
CREATE TABLE "sync"."sync_batches" (
    "tenant_id"        UUID           NOT NULL,
    "batch_id"         UUID           NOT NULL,
    "terminal_id"      UUID           NOT NULL,
    "fingerprint"      CHAR(64)       NOT NULL,
    "protocol_version" INTEGER        NOT NULL,
    "operation_count"  INTEGER        NOT NULL,
    "byte_size"        INTEGER        NOT NULL,
    "state"            VARCHAR(16)    NOT NULL,
    -- Crash-recovery lease. An EXPIRED lease means the owner died; the batch is
    -- then reclaimable. Reclaim is optimistic on (lease_owner, attempt), so two
    -- servers racing to reclaim cannot both win.
    "lease_owner"      VARCHAR(80),
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempt"          INTEGER        NOT NULL DEFAULT 0,
    "received_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"     TIMESTAMPTZ(6),
    "duration_ms"      INTEGER,
    "accepted_count"   INTEGER        NOT NULL DEFAULT 0,
    "duplicate_count"  INTEGER        NOT NULL DEFAULT 0,
    "conflict_count"   INTEGER        NOT NULL DEFAULT 0,
    "rejected_count"   INTEGER        NOT NULL DEFAULT 0,
    "deferred_count"   INTEGER        NOT NULL DEFAULT 0,
    "max_clock_skew_ms" BIGINT,
    -- Persisted BEFORE the HTTP response is written. A crash in that window
    -- leaves the client holding a transport failure (non-definitive) rather
    -- than an acknowledgement the server cannot honour — NFR-REL-010.
    "response"         JSONB,

    CONSTRAINT "sync_batches_pkey" PRIMARY KEY ("tenant_id", "batch_id"),
    CONSTRAINT "ck_sync_batches_state" CHECK ("state" IN ('in_flight', 'completed')),
    CONSTRAINT "ck_sync_batches_completed" CHECK (
      "state" <> 'completed' OR ("completed_at" IS NOT NULL AND "response" IS NOT NULL)
    )
);

CREATE INDEX "sync_batches_tenant_terminal_received_idx"
  ON "sync"."sync_batches"("tenant_id", "terminal_id", "received_at" DESC);
-- Supports a future reaper looking for abandoned leases.
CREATE INDEX "sync_batches_state_lease_idx"
  ON "sync"."sync_batches"("state", "lease_expires_at");

ALTER TABLE "sync"."sync_batches" ADD CONSTRAINT "sync_batches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================== device_state
CREATE TABLE "sync"."device_state" (
    "tenant_id"        UUID           NOT NULL,
    "terminal_id"      UUID           NOT NULL,
    "last_batch_id"    UUID,
    "last_seen_at"     TIMESTAMPTZ(6),
    "last_cursor"      VARCHAR(80),
    "protocol_version" INTEGER,
    -- Signed: positive means the device's clock runs AHEAD of the server.
    "clock_skew_ms"    BIGINT,
    "skew_detected_at" TIMESTAMPTZ(6),
    "skew_alerted_at"  TIMESTAMPTZ(6),
    "revalidation_mismatch_count" INTEGER NOT NULL DEFAULT 0,
    "mismatch_window_start"       TIMESTAMPTZ(6),
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_state_pkey" PRIMARY KEY ("tenant_id", "terminal_id")
);

ALTER TABLE "sync"."device_state" ADD CONSTRAINT "device_state_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================== conflict_records
CREATE TABLE "sync"."conflict_records" (
    "id"              UUID           NOT NULL,
    "tenant_id"       UUID           NOT NULL,
    "branch_id"       UUID           NOT NULL,
    "entity_type"     VARCHAR(48)    NOT NULL,
    "entity_id"       UUID           NOT NULL,
    "conflict_class"  VARCHAR(48)    NOT NULL,
    "op_id"           UUID           NOT NULL,
    "competing_op_id" UUID,
    "applied_rule"    VARCHAR(64),
    "resolution"      VARCHAR(24)    NOT NULL,
    -- FR-OFF-043: a manager is shown BOTH versions, so both are stored.
    "local_state"     JSONB,
    "server_state"    JSONB,
    "detected_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by"     UUID,
    "resolved_at"     TIMESTAMPTZ(6),
    "audit_entry_id"  UUID,

    CONSTRAINT "conflict_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_conflict_records_resolution" CHECK (
      "resolution" IN ('auto', 'manual_pending', 'manual_resolved')
    )
);

CREATE UNIQUE INDEX "conflict_records_tenant_id_id_key" ON "sync"."conflict_records"("tenant_id", "id");
CREATE INDEX "conflict_records_tenant_entity_idx"
  ON "sync"."conflict_records"("tenant_id", "entity_type", "entity_id");
CREATE INDEX "conflict_records_tenant_resolution_idx"
  ON "sync"."conflict_records"("tenant_id", "resolution", "detected_at" DESC);

ALTER TABLE "sync"."conflict_records" ADD CONSTRAINT "conflict_records_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==================================================== revalidation_exceptions
-- GD-D1-05 (ratified): FR-OFF-046 reconciliation exceptions are SYNC-owned.
CREATE TABLE "sync"."revalidation_exceptions" (
    "id"            UUID           NOT NULL,
    "tenant_id"     UUID           NOT NULL,
    "branch_id"     UUID           NOT NULL,
    "terminal_id"   UUID           NOT NULL,
    "op_id"         UUID           NOT NULL,
    "entity_type"   VARCHAR(48)    NOT NULL,
    "entity_id"     UUID           NOT NULL,
    -- FR-OFF-046: the transaction is ACCEPTED and BOTH values recorded. The
    -- sale physically occurred; the server does not reject it for disagreeing.
    "client_values" JSONB          NOT NULL,
    "server_values" JSONB          NOT NULL,
    "detected_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_state"  VARCHAR(24)    NOT NULL DEFAULT 'open',
    "reviewed_by"   UUID,
    "reviewed_at"   TIMESTAMPTZ(6),
    "review_note"   TEXT,

    CONSTRAINT "revalidation_exceptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_revalidation_exceptions_review_state" CHECK (
      "review_state" IN ('open', 'reviewed', 'dismissed')
    )
);

CREATE UNIQUE INDEX "revalidation_exceptions_tenant_id_id_key"
  ON "sync"."revalidation_exceptions"("tenant_id", "id");
CREATE INDEX "revalidation_exceptions_tenant_review_idx"
  ON "sync"."revalidation_exceptions"("tenant_id", "review_state", "detected_at" DESC);
CREATE INDEX "revalidation_exceptions_tenant_terminal_idx"
  ON "sync"."revalidation_exceptions"("tenant_id", "terminal_id", "detected_at" DESC);

ALTER TABLE "sync"."revalidation_exceptions" ADD CONSTRAINT "revalidation_exceptions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."operation_dedup"          TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."sync_operations"          TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."sync_batches"             TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."device_state"             TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."conflict_records"         TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."revalidation_exceptions"  TO ros_app;

-- ------------------------------------------------------------------- RLS ---
-- FR-PLT-010/011/012, CT-05. Identical shape to every other tenant-scoped
-- table in this repository: ENABLE + FORCE, and four policies whose predicate
-- is the transaction-local `app.tenant_id` established by
-- `PrismaService.withAuthContext`. A missing context yields NULL and every
-- policy fails closed.
--
-- NO branch predicate anywhere: branch-scoped RLS is not introduced by this
-- lane (D-2 remains in force, branch RBAC is Lane B's). `branch_id` here is a
-- recorded, server-derived attribution column, never an authorization boundary.
ALTER TABLE "sync"."operation_dedup"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."operation_dedup"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sync"."sync_operations"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."sync_operations"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sync"."sync_batches"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."sync_batches"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sync"."device_state"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."device_state"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sync"."conflict_records"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."conflict_records"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sync"."revalidation_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."revalidation_exceptions" FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'operation_dedup', 'sync_operations', 'sync_batches',
    'device_state', 'conflict_records', 'revalidation_exceptions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON "sync".%I FOR SELECT USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON "sync".%I FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON "sync".%I FOR UPDATE USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON "sync".%I FOR DELETE USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_delete', t);
  END LOOP;
END $$;
