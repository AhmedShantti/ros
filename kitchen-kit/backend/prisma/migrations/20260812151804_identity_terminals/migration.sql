-- CreateEnum
CREATE TYPE "identity"."TerminalStatus" AS ENUM ('active', 'disabled', 'revoked');

-- CreateEnum
CREATE TYPE "identity"."TerminalType" AS ENUM ('pos', 'kds', 'kiosk', 'handheld');

-- CreateTable
CREATE TABLE "identity"."terminals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "terminal_type" "identity"."TerminalType" NOT NULL,
    "status" "identity"."TerminalStatus" NOT NULL DEFAULT 'active',
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."device_fingerprints" (
    "id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "fingerprint_hash" TEXT NOT NULL,
    "os" VARCHAR(32),
    "app_version" VARCHAR(32),
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "terminals_tenant_id_idx" ON "identity"."terminals"("tenant_id");

-- CreateIndex
CREATE INDEX "terminals_branch_id_idx" ON "identity"."terminals"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "terminals_tenant_id_branch_id_name_key" ON "identity"."terminals"("tenant_id", "branch_id", "name");

-- CreateIndex
CREATE INDEX "device_fingerprints_terminal_id_idx" ON "identity"."device_fingerprints"("terminal_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_fingerprints_terminal_id_fingerprint_hash_key" ON "identity"."device_fingerprints"("terminal_id", "fingerprint_hash");

-- CreateIndex
CREATE INDEX "sessions_terminal_id_idx" ON "identity"."sessions"("terminal_id");

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "identity"."terminals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."terminals" ADD CONSTRAINT "terminals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."device_fingerprints" ADD CONSTRAINT "device_fingerprints_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "identity"."terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Phase 9 RLS — terminals (direct tenant_id) and device_fingerprints (inherited
-- via terminal). Same model as Phase 8: transaction-local app.tenant_id, read
-- via NULLIF(current_setting(...,true),'')::uuid → fail-closed. Runtime = ros_app.
-- ============================================================================

-- ros_app already gains DML via the Phase 8 ALTER DEFAULT PRIVILEGES, but grant
-- explicitly too so this migration is self-contained on a clean database.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "identity"."terminals", "identity"."device_fingerprints" TO ros_app;

-- terminals — tenant-scoped, all operations gated by app.tenant_id.
ALTER TABLE "identity"."terminals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."terminals" FORCE ROW LEVEL SECURITY;

CREATE POLICY terminals_select ON "identity"."terminals" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY terminals_insert ON "identity"."terminals" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY terminals_update ON "identity"."terminals" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY terminals_delete ON "identity"."terminals" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- device_fingerprints — inherited through the parent terminal.
ALTER TABLE "identity"."device_fingerprints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."device_fingerprints" FORCE ROW LEVEL SECURITY;

CREATE POLICY device_fingerprints_select ON "identity"."device_fingerprints" FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM "identity"."terminals" t
    WHERE t.id = terminal_id
      AND t.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
CREATE POLICY device_fingerprints_insert ON "identity"."device_fingerprints" FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "identity"."terminals" t
    WHERE t.id = terminal_id
      AND t.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
CREATE POLICY device_fingerprints_delete ON "identity"."device_fingerprints" FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "identity"."terminals" t
    WHERE t.id = terminal_id
      AND t.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
