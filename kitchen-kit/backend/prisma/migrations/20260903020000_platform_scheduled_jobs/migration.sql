-- ---------------------------------------------------------------------------
-- Migration 39 — SCHED-1 DURABLE SCHEDULED JOB EXECUTION (`platform` schema)
--
-- Authority: SRS §25.1 "Schema Organisation", which names a `platform` schema
-- whose contents are "outbox, jobs, notifications, feature_flags, migrations".
-- This migration creates that schema and ONLY its `jobs` half — the durable
-- schedule, the durable occurrence (with its multi-instance claim lease), and
-- the durable finding a job records when it detects something. No outbox, no
-- notifications table, no feature flags: those are separate SRS surfaces and
-- inventing them here would pre-empt slices that have not been designed.
--
-- Requirements this substrate exists to serve (the P0-REBASE-2 census names 15
-- requirements blocked by the absence of scheduler infrastructure). This
-- migration closes NONE of them by itself; it makes them implementable:
--
--   BR-INV-003 / FR-INV-011 / FR-INV-051  daily ledger-vs-projection
--                                         reconciliation + alert on divergence
--   FR-AUD-005   scheduled audit-chain integrity verification
--   FR-DR-002    partition pre-creation at least 3 months ahead
--   FR-SEC-061   retention purge / anonymisation
--   FR-RPT-002 / 040 / 041, FR-HRM-013 / 022 / 023, FR-INV-067 / 069, IR-INT-030
--
-- ── WHY POSTGRESQL AND NOT A QUEUE ─────────────────────────────────────────
-- PostgreSQL is already an authoritative dependency and the repository already
-- proves the exact primitive this needs: `sync.sync_batches` carries a
-- (lease_owner, lease_expires_at, attempt) reservation whose reclaim is an
-- optimistic UPDATE on the OBSERVED pair, so two servers racing to reclaim an
-- abandoned unit of work cannot both win (D4-1A, migration 37). This migration
-- reuses that shape rather than adding Redis/BullMQ, which exist nowhere in
-- `package.json` and would be a new infrastructure dependency adopted for
-- convenience.
--
-- ── TENANCY: NO WORKER AUTHORITY MODEL IS INVENTED HERE ────────────────────
-- `FR-PLT-011` is ratified: the application role has no `BYPASSRLS`, and the
-- governance register records "No cross-tenant read is possible" for
-- tenant-scoped tables. This migration does NOT weaken that. All three tables
-- below are tenant-scoped with ENABLE + FORCE row level security and the same
-- four `app.tenant_id` policies every other tenant table in this repository
-- carries, so every scheduler read AND write happens inside
-- `PrismaService.withAuthContext({ tenantId })` under RLS, exactly like a
-- request-path write. The consequence is deliberate and stated rather than
-- engineered around: a worker cannot issue ONE set-oriented claim spanning
-- every tenant, because that would require a cross-tenant read this repository
-- has not ratified an authority model for. Tenant discovery uses
-- `identity.tenants`, which has carried no RLS since migration 5 (it is the
-- platform registry a login must resolve BEFORE any tenant context exists) —
-- a pre-existing property, not a new bypass.
--
-- ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
-- No `pg_cron`, no `pg_partman`, no database-side scheduling extension: the
-- schedule is evaluated in application code from the durable rows below, so it
-- behaves identically on a managed Postgres that forbids extensions. No
-- notification/delivery table — governance decision N-A ratified "no
-- notification implementation in Phase 1 (strict) ... no channel, no in-app
-- notification, no table, no endpoint, no permission, no event, no outbox, no
-- queue, no worker". `platform.job_findings` is the DETECTION record a job
-- writes, not a delivery channel, and this migration claims nothing more.
-- ---------------------------------------------------------------------------

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- ============================================================ job_schedules
-- The DURABLE schedule definition (design property A). A row here OVERRIDES
-- the job type's registered default; its absence means the registered default
-- applies, so a tenant onboarded while the scheduler is running is never
-- silently unscheduled. Both halves are durable: the row survives a restart,
-- and the default is a code constant, not process state.
--
-- CADENCE. Exactly one cadence is modelled — `daily` — because that is the only
-- cadence the SRS requirements above actually state ("daily", "at a
-- configurable time"). No cron expression is parsed anywhere in this slice: a
-- cron dialect the SRS never names would be invented semantics.
CREATE TABLE "platform"."job_schedules" (
    "tenant_id" UUID        NOT NULL,
    "job_type"  VARCHAR(64) NOT NULL,

    "enabled"   BOOLEAN     NOT NULL DEFAULT TRUE,
    "cadence"   VARCHAR(16) NOT NULL DEFAULT 'daily',

    -- IANA zone, e.g. 'Africa/Cairo'. Same domain as `org.branches.timezone`.
    -- NEVER the server's local zone: a deployment moved between regions must
    -- not silently move every tenant's business schedule with it.
    "timezone"  VARCHAR(48) NOT NULL,
    -- Minutes since LOCAL midnight in `timezone`. 0..1439.
    "local_time_of_day" SMALLINT NOT NULL,

    -- Bounded catch-up (design property J). How many past due occurrences a
    -- tick may materialise at once after downtime. Bounds the catch-up storm
    -- to an EXPLICIT, durable, per-tenant number instead of replaying an
    -- unbounded backlog — and, because it is configuration rather than a
    -- hidden constant, occurrences beyond the horizon are a stated operational
    -- limit rather than a silent skip.
    "catch_up_limit" SMALLINT NOT NULL DEFAULT 3,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_schedules_pkey" PRIMARY KEY ("tenant_id", "job_type"),
    CONSTRAINT "ck_job_schedules_cadence" CHECK ("cadence" IN ('daily')),
    CONSTRAINT "ck_job_schedules_local_time" CHECK ("local_time_of_day" BETWEEN 0 AND 1439),
    CONSTRAINT "ck_job_schedules_catch_up" CHECK ("catch_up_limit" BETWEEN 1 AND 30)
);

ALTER TABLE "platform"."job_schedules" ADD CONSTRAINT "job_schedules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ========================================================== job_occurrences
-- ONE ROW = ONE SCHEDULED OCCURRENCE. This table is the whole of the
-- exactly-once story.
--
-- OCCURRENCE IDENTITY (design property C) is the PRIMARY KEY
-- `(tenant_id, job_type, occurrence_key)` — enforced by PostgreSQL, never by
-- application luck. `occurrence_key` is the occurrence's LOCAL wall-clock slot
-- rendered `YYYY-MM-DDTHH:MM` in the schedule's own timezone, so it is
-- derivable by any instance, on any host, in any server timezone, without
-- coordination. A duplicate scheduler tick, a second instance, and a retry all
-- compute the SAME key and therefore collide on this key rather than creating
-- a second occurrence.
--
-- Why the LOCAL slot and not the UTC instant: under a DST fall-back the same
-- local slot maps to two UTC instants. Keying on the instant would create two
-- occurrences of a job the business expects once a day. Keying on the local
-- slot makes "once per local day" true by construction, and `scheduled_for`
-- records which of the two instants was chosen (deterministically, the
-- earlier). Under a spring-forward the local slot may map to NO instant; the
-- occurrence still exists, with `scheduled_for` set to the transition instant,
-- so a required business occurrence is never skipped.
CREATE TABLE "platform"."job_occurrences" (
    "tenant_id"      UUID        NOT NULL,
    "job_type"       VARCHAR(64) NOT NULL,
    "occurrence_key" VARCHAR(32) NOT NULL,

    -- The UTC instant this occurrence became due. Derived from
    -- (occurrence_key, timezone); recorded so lag is measurable and so the DST
    -- resolution above is auditable after the fact.
    "scheduled_for"  TIMESTAMPTZ(6) NOT NULL,

    "state"          VARCHAR(16) NOT NULL DEFAULT 'pending',

    -- Retry accounting (design property F).
    "attempt"        INTEGER     NOT NULL DEFAULT 0,
    "max_attempts"   INTEGER     NOT NULL,
    -- Backoff gate. A `pending` occurrence is invisible to the claim until now
    -- reaches this. Equals `scheduled_for` for a first attempt.
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL,

    -- The claim lease (design property B/I). Same shape as
    -- `sync.sync_batches`: a live lease means a peer really is working; an
    -- expired lease means its owner died and the occurrence is reclaimable.
    "lease_owner"      VARCHAR(80),
    "lease_expires_at" TIMESTAMPTZ(6),

    "started_at"   TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "duration_ms"  INTEGER,

    -- A BOUNDED vocabulary token (e.g. 'ok', 'handler_error', 'lease_expired'),
    -- never an exception message and never free text: this column is read by
    -- operators and must not become an unbounded string that leaks payloads.
    "outcome_code" VARCHAR(64),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_occurrences_pkey" PRIMARY KEY ("tenant_id", "job_type", "occurrence_key"),
    CONSTRAINT "ck_job_occurrences_state" CHECK (
      "state" IN ('pending', 'running', 'succeeded', 'failed')
    ),
    -- A terminal occurrence must actually record when it terminated.
    CONSTRAINT "ck_job_occurrences_terminal" CHECK (
      "state" NOT IN ('succeeded', 'failed') OR "completed_at" IS NOT NULL
    ),
    -- A running occurrence must hold a real lease. This is what makes an
    -- orphaned claim detectable rather than indistinguishable from a live one.
    CONSTRAINT "ck_job_occurrences_running_lease" CHECK (
      "state" <> 'running'
      OR ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    ),
    CONSTRAINT "ck_job_occurrences_attempt" CHECK ("attempt" >= 0 AND "attempt" <= "max_attempts")
);

-- The claim scan: `WHERE tenant_id = $1 AND state = 'pending' AND
-- next_attempt_at <= now ORDER BY next_attempt_at`. Leading tenant_id matches
-- the RLS predicate the planner also applies, so the index is usable under RLS.
CREATE INDEX "job_occurrences_claim_idx"
  ON "platform"."job_occurrences"("tenant_id", "state", "next_attempt_at");
-- The reclaim scan: expired leases on running occurrences. Mirrors
-- `sync_batches_state_lease_idx`.
CREATE INDEX "job_occurrences_reclaim_idx"
  ON "platform"."job_occurrences"("tenant_id", "state", "lease_expires_at");
-- Operator/report reads: "what happened to this job type lately".
CREATE INDEX "job_occurrences_tenant_job_scheduled_idx"
  ON "platform"."job_occurrences"("tenant_id", "job_type", "scheduled_for" DESC);

ALTER TABLE "platform"."job_occurrences" ADD CONSTRAINT "job_occurrences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================ job_findings
-- What a job DETECTED, recorded durably. This is the honest half of the
-- "SHALL raise an alert" clause in BR-INV-003 / FR-INV-051 / FR-AUD-005 /
-- FR-DR-002: the detection is persisted, attributable to an exact occurrence,
-- and acknowledgeable. It is NOT a delivery channel — no email, SMS, push or
-- chat integration exists in this repository and governance decision N-A
-- ratified that none is introduced in this phase. Any claim that the alert
-- limb of those requirements is COMPLETE would be false, and is not made.
--
-- UNIQUE `(tenant_id, job_type, occurrence_key, finding_code)` is what makes a
-- RETRY produce no duplicate domain effect (design property F): attempt 2 of
-- the same occurrence upserts the SAME row rather than inserting a second one.
CREATE TABLE "platform"."job_findings" (
    "id"             UUID        NOT NULL,
    "tenant_id"      UUID        NOT NULL,
    "job_type"       VARCHAR(64) NOT NULL,
    "occurrence_key" VARCHAR(32) NOT NULL,

    -- Bounded vocabularies, both. `finding_code` identifies WHAT was found so
    -- an operator can route it; `detail` carries the specifics.
    "severity"     VARCHAR(16) NOT NULL,
    "finding_code" VARCHAR(64) NOT NULL,
    "detail"       JSONB       NOT NULL DEFAULT '{}',

    "detected_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),
    -- The membership that acknowledged. Recorded, not FK-enforced — the same
    -- convention `sync.conflict_records.resolved_by` already uses.
    "acknowledged_by" UUID,

    CONSTRAINT "job_findings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_job_findings_severity" CHECK ("severity" IN ('info', 'warning', 'critical')),
    CONSTRAINT "ck_job_findings_acknowledged" CHECK (
      "acknowledged_at" IS NULL OR "acknowledged_by" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "job_findings_occurrence_code_key"
  ON "platform"."job_findings"("tenant_id", "job_type", "occurrence_key", "finding_code");
CREATE INDEX "job_findings_tenant_open_idx"
  ON "platform"."job_findings"("tenant_id", "acknowledged_at", "detected_at" DESC);

ALTER TABLE "platform"."job_findings" ADD CONSTRAINT "job_findings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A finding cannot outlive, or exist without, the occurrence that produced it.
ALTER TABLE "platform"."job_findings" ADD CONSTRAINT "job_findings_tenant_id_job_type_occurrence_key_fkey"
  FOREIGN KEY ("tenant_id", "job_type", "occurrence_key")
  REFERENCES "platform"."job_occurrences"("tenant_id", "job_type", "occurrence_key")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT USAGE ON SCHEMA "platform" TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform"."job_schedules"   TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform"."job_occurrences" TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform"."job_findings"    TO ros_app;

-- ------------------------------------------------------------------- RLS ---
-- FR-PLT-010/011/012, CT-05. Identical shape to every other tenant-scoped
-- table in this repository: ENABLE + FORCE, and four policies whose predicate
-- is the transaction-local `app.tenant_id` established by
-- `PrismaService.withAuthContext`. A missing context yields NULL and every
-- policy fails closed — which is precisely why a scheduler worker cannot
-- "accidentally" scan every tenant: with no tenant context it sees nothing at
-- all, rather than seeing everything.
ALTER TABLE "platform"."job_schedules"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform"."job_schedules"   FORCE  ROW LEVEL SECURITY;
ALTER TABLE "platform"."job_occurrences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform"."job_occurrences" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "platform"."job_findings"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform"."job_findings"    FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_schedules', 'job_occurrences', 'job_findings'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON "platform".%I FOR SELECT USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON "platform".%I FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON "platform".%I FOR UPDATE USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON "platform".%I FOR DELETE USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_delete', t);
  END LOOP;
END $$;
