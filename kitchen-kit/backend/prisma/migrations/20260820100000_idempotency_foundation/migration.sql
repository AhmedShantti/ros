-- ---------------------------------------------------------------------------
-- Reusable API idempotency foundation — SRS §26.5, FR-API-020…023.
--
--   FR-API-020  every POST/PATCH accepts Idempotency-Key; mandatory on
--               financially significant endpoints
--   FR-API-021  store the key, the request FINGERPRINT and the response for
--               at least 30 days
--   FR-API-022  same key + identical fingerprint -> stored response, with
--               `Idempotent-Replay: true`
--   FR-API-023  same key + different fingerprint -> 409 Conflict
--
-- SCHEMA LOCATION. The approved SQL files this table under `sync`, so that
-- location is kept rather than inventing a new one. This migration creates the
-- `sync` schema containing ONLY this table: no sync protocol, no
-- sync_operations, no conflict_records, no HLC. Those belong to the Offline/Sync
-- slice and are explicitly out of scope here.
--
-- TWO DOCUMENTED DEVIATIONS from the approved SQL, both required by FR-API-021/023:
--
--   1. The approved shape is `key VARCHAR(80) PRIMARY KEY` — a GLOBAL key space.
--      That is a cross-tenant collision: tenant A claiming "abc" would block
--      tenant B, and worse, a stored response could be replayed across the
--      tenant boundary. The primary key is therefore `(tenant_id, key)`, which
--      also makes RLS the natural boundary.
--   2. The approved shape has no fingerprint column, so FR-API-022/023 could not
--      be satisfied at all. `fingerprint` is added as a SHA-256 hex digest over a
--      canonical rendering of the request.
--
-- `endpoint` is part of the stored identity so the same client key reused
-- against a different operation is a fingerprint conflict rather than a silent
-- cross-operation replay.
--
-- CONCURRENCY. A request first RESERVES its key by inserting an `in_flight` row
-- in its own transaction. The primary key makes that reservation atomic: a
-- second concurrent request with the same (tenant, key) loses the insert and is
-- refused rather than performing the work twice. The handler's own transaction
-- then completes the row. A handler failure releases the reservation, so a retry
-- is possible and no false "successful replay" is ever recorded.
-- ---------------------------------------------------------------------------

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "sync";

-- CreateTable
CREATE TABLE "sync"."idempotency_keys" (
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "endpoint" VARCHAR(120) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'in_flight',
    "response_status" INTEGER,
    "response_body" JSONB,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    -- FR-API-021: "at least 30 days". Retained beyond that; a sweeper belongs to
    -- the scheduler slice, so nothing deletes these rows yet.
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id", "key"),
    CONSTRAINT "ck_idempotency_state" CHECK ("state" IN ('in_flight', 'completed')),
    CONSTRAINT "ck_idempotency_completed" CHECK (
      "state" <> 'completed'
      OR ("response_status" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
);

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "sync"."idempotency_keys"("expires_at");

-- AddForeignKey
ALTER TABLE "sync"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT USAGE ON SCHEMA "sync" TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync"."idempotency_keys" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
-- FR-PLT-010/011/012. With `tenant_id` leading the primary key AND the policy
-- predicate, a stored response can never be read — let alone replayed — under
-- another tenant's context.
ALTER TABLE "sync"."idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_select ON "sync"."idempotency_keys" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY idempotency_keys_insert ON "sync"."idempotency_keys" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY idempotency_keys_update ON "sync"."idempotency_keys" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY idempotency_keys_delete ON "sync"."idempotency_keys" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
