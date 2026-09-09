-- ---------------------------------------------------------------------------
-- FULL-SRS-PLT-SETTINGS-RESOLVER-P1 — FR-PLT-025/026/027 settings-resolver
-- substrate (`platform` schema).
--
-- Authority: SRS §6.4 Configuration Hierarchy and Resolution (Platform
-- Default -> Country Pack -> Tenant -> Brand -> Branch -> Terminal);
-- `docs/adr/0008-organisation-foundation.md` D-11 (the DEFERRED `org.settings`
-- design this corrects); `docs/reports/claude/
-- 2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md`.
--
-- TWO tables, not one, because Platform Default cannot share a per-tenant RLS
-- posture with the other four storable levels (tenant/brand/branch/terminal):
--
--   platform_default_settings — genuinely GLOBAL. No `tenant_id`, no RLS.
--     Exactly the posture `identity.tenants`/`identity.permissions` already
--     carry for the same reason (a cross-tenant registry every tenant must be
--     able to READ before/independent of its own RLS context). Written only
--     by a trusted operator/seed path this slice (no HTTP route) — see the
--     report's BLOCKERS_OR_UNCERTAINTIES for why a write route is deferred.
--
--   setting_values — tenant/brand/branch/terminal levels. Carries a REAL
--     `tenant_id` FK to `identity.tenants` from its first migration (ADR 0008
--     D-11's binding instruction) and standard ENABLE + FORCE RLS, four
--     policies, identical shape to every other tenant-scoped table in this
--     repository (e.g. `treasury.cash_close_policies`,
--     `platform.job_schedules`). `target_id` is POLYMORPHIC by `level` (the
--     tenant's own id for `level = tenant`, else a brand/branch/terminal id)
--     and therefore carries no direct FK of its own — Postgres cannot FK one
--     column to four different parent tables selected by a discriminator.
--     Every write validates the target's existence AND tenant ownership
--     through the owning module's published contract
--     (`BRANCH_BRAND_QUERY`/`TERMINAL_FACTS_QUERY`) before the row lands;
--     this is an application-level invariant, not a DB one — the same
--     limitation D-11 flagged for the original `org.settings` design, now
--     narrowed to exactly the one column (`target_id`) a cross-schema FK
--     genuinely cannot express, rather than left on `tenant_id` too.
--
-- Country Pack (SRS §6.4's second tier) is intentionally NOT a row in either
-- table — it is resolved dynamically through Localisation's published
-- `COUNTRY_PACK_SETTING_FACT_QUERY` contract, never duplicated here.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "platform"."SettingLevel" AS ENUM ('tenant', 'brand', 'branch', 'terminal');

-- CreateTable
CREATE TABLE "platform"."platform_default_settings" (
    "id" UUID NOT NULL,
    "setting_key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_default_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."setting_values" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "level" "platform"."SettingLevel" NOT NULL,
    "target_id" UUID NOT NULL,
    "setting_key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "setting_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_default_settings_setting_key_key" ON "platform"."platform_default_settings"("setting_key");

-- CreateIndex
CREATE INDEX "setting_values_tenant_id_setting_key_idx" ON "platform"."setting_values"("tenant_id", "setting_key");

-- CreateIndex — the composite-FK anchor AND the app-level uniqueness rule:
-- at most one configured row per (tenant, level, target, key). NULLs never
-- appear in any of these four columns (unlike the deferred org.settings
-- design), so ordinary btree uniqueness is sufficient — no partial index is
-- needed here the way one is for `platform_default_settings` (which has no
-- polymorphic column to disambiguate; its single global UNIQUE above already
-- covers it).
CREATE UNIQUE INDEX "uq_setting_value_scope_key" ON "platform"."setting_values"("tenant_id", "level", "target_id", "setting_key");

-- AddForeignKey
ALTER TABLE "platform"."platform_default_settings" ADD CONSTRAINT "platform_default_settings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — ADR 0008 D-11's binding instruction: "must carry tenant_id
-- ... from the first migration".
ALTER TABLE "platform"."setting_values" ADD CONSTRAINT "setting_values_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."setting_values" ADD CONSTRAINT "setting_values_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- `platform_default_settings` deliberately carries NO grant restriction
-- beyond the ordinary SELECT/INSERT/UPDATE — identical posture to
-- `identity.permissions` (also un-RLS'd, also written by a trusted
-- administrative path rather than an ordinary tenant-scoped request). No
-- HTTP route in this slice writes it (see this migration's header comment),
-- so in practice only a migration/seed/ops path uses the INSERT/UPDATE
-- grant; the grant itself does not encode that restriction, matching how
-- `identity.permissions` also grants INSERT/UPDATE to `ros_app` without a
-- narrower administrative role existing to hold it.
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform"."platform_default_settings" TO ros_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform"."setting_values" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
-- `platform_default_settings` — NO RLS. It has no `tenant_id` column to
-- anchor a predicate to, and a per-tenant predicate would be wrong anyway: a
-- Platform Default row must be readable by EVERY tenant resolving the
-- settings cascade, not scoped to one.
--
-- `setting_values` — identical shape to every other tenant-scoped table in
-- this repository: ENABLE + FORCE, and four policies whose predicate is the
-- transaction-local `app.tenant_id` `PrismaService.withAuthContext`
-- establishes. A missing context yields NULL and every policy fails closed.
ALTER TABLE "platform"."setting_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform"."setting_values" FORCE ROW LEVEL SECURITY;

CREATE POLICY setting_values_select ON "platform"."setting_values" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY setting_values_insert ON "platform"."setting_values" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY setting_values_update ON "platform"."setting_values" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY setting_values_delete ON "platform"."setting_values" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE "platform"."setting_values" IS
  'FR-PLT-025/026 tenant/brand/branch/terminal cascade levels. Country Pack and Platform Default are NOT rows here — see platform_default_settings and the Localisation COUNTRY_PACK_SETTING_FACT_QUERY contract. FR-PLT-028 effective-dated financial-setting semantics remain NOT IMPLEMENTED by this table (no effective-dating column) — see docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md §8.';

COMMENT ON TABLE "platform"."platform_default_settings" IS
  'FR-PLT-025/026 Platform-Default (highest) level. Genuinely global — no tenant_id, no RLS, same posture as identity.permissions. No HTTP write route this slice; see the design report BLOCKERS_OR_UNCERTAINTIES.';
