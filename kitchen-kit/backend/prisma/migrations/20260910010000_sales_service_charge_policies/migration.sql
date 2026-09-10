-- ---------------------------------------------------------------------------
-- P2D (Sales) — ServiceChargePolicy: Sales-owned, tenant/brand/branch-scoped,
-- effective-dated, IMMUTABLE service-charge CONFIGURATION substrate.
--
-- Authority (CONTROLLING order):
--   1. docs/governance/GOVERNANCE_DECISION_REGISTER.md, "P2A-R1" (clauses
--      3, 7-16) and "P2D-R1" (RATIFIED 2026-09-10).
--   2. docs/reports/claude/2026-09-10_FULL-SRS-PLT-SERVICE-CHARGE-CONFIG-SHAPE-AND-LOCK-COHERENCE-P2C2.md
--   3. docs/reports/claude/2026-09-10_FULL-SRS-PLT-P2C1-P2D-GOVERNANCE-RATIFICATION.md
--
-- SCOPE FENCE — this migration does NOT implement rule matching/evaluation,
-- serviceChargeTotal computation, CountryPack.serviceChargeTaxable
-- application, tips, tip pooling, or discount/service-charge interaction
-- (P2E). It does NOT touch `sales.orders.service_charge_total` (stays
-- default-zero). It is NOT the generic FR-PLT-025 six-level settings
-- hierarchy and does NOT use `platform.setting_values` — P2A-R1 clause 3.
--
-- ── HIERARCHY (P2A-R1 clause 7 / P2D-R1 clause 2) ───────────────────────────
-- tenant -> brand -> branch ONLY. No platform, country_pack, or terminal
-- level exists for this table — `ServiceChargePolicyLevel` is a CLOSED,
-- three-value enum, never the broader generic `platform."SettingLevel"`.
--
-- ── RULE-SET (P2D-R1 clause 3/4) ─────────────────────────────────────────────
-- One row = one COMPLETE, atomic rule-set (`rules JSONB NOT NULL`), never a
-- child table — a rule can never be altered independently of the immutable
-- version it belongs to. Application-validated structurally (exact-decimal
-- `ratePercent`, existing `OrderType` vocabulary, non-negative
-- `minGuestCount`); the `ck_scp_rules_is_array` CHECK below is a coarse
-- backstop only, never a substitute for that validation.
--
-- ── EFFECTIVE VERSIONING, NO BACKDATING (P2A-R1 clauses 13-14) ──────────────
-- `effective_from >= created_at` is the anti-backdating enforcement, both
-- columns DEFAULT `statement_timestamp()` (evaluated ONCE per statement, so
-- an "effective immediately" INSERT that omits `effective_from` satisfies
-- the CHECK by equality, using DATABASE time only). `created_at` is excluded
-- from `ros_app`'s column-level INSERT grant so a caller cannot forge
-- history — the `cash_close_policies`/`ck_ccp_no_backdating` precedent
-- verbatim.
--
-- ── IMMUTABILITY / FUTURE-ONLY CANCELLATION (P2A-R1 clauses 11-12) ──────────
-- NO UPDATE grant, ever — a correction is always a NEW version, never an
-- edit. DELETE is granted, but the RLS DELETE policy additionally requires
-- `effective_from > statement_timestamp()`: only a still-future version may
-- be cancelled, enforced at the DATABASE boundary, never merely by
-- application logic (the `recipe_versions_delete`/`status = 'draft'`
-- status-predicated DELETE precedent, extended here to an instant
-- predicate).
--
-- ── TENANCY / RLS (D-09) ─────────────────────────────────────────────────────
-- `tenant_id` is a real column with a direct FK to `identity.tenants(id)`
-- (the `platform.setting_values` precedent — `target_id` carries NO FK of
-- its own, since its meaning depends on `level`; validating it against the
-- correct Organisation-owned table is an APPLICATION-level check via
-- `organisation/contract`, never a raw cross-schema FK substitute).
-- `ENABLE`+`FORCE` RLS, fail-closed `NULLIF` predicate throughout.
--
-- ── ORDER PINNING (P2D-R1 clause 8) ──────────────────────────────────────────
-- `sales.orders` gains a NULLABLE `service_charge_policy_version_id` with a
-- tenant-leading composite FK to this table. NULL means no configured
-- version governed the order's scope at `opened_at` — never a fabricated
-- default. `sales.orders` already carries a table-wide (not column-scoped)
-- GRANT, so no grant change is needed there.
-- ---------------------------------------------------------------------------

CREATE TYPE "sales"."ServiceChargePolicyLevel" AS ENUM ('tenant', 'brand', 'branch');

CREATE TABLE "sales"."service_charge_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "level" "sales"."ServiceChargePolicyLevel" NOT NULL,
    "target_id" UUID NOT NULL,
    "rules" JSONB NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),

    CONSTRAINT "service_charge_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_scp_rules_is_array" CHECK (jsonb_typeof("rules") = 'array'),
    -- P2A-R1 clause 13/14. See header comment for why an "effective
    -- immediately" INSERT still satisfies this (equality).
    CONSTRAINT "ck_scp_no_backdating" CHECK ("effective_from" >= "created_at")
);

-- Composite-FK target for `sales.orders`' pin (P2D-R1 clause 8).
CREATE UNIQUE INDEX "service_charge_policies_tenant_id_id_key"
  ON "sales"."service_charge_policies"("tenant_id", "id");

-- One version per (level, target) per instant — the deterministic conflict
-- for a concurrent same-scope, same-effective_from race (no advisory lock
-- needed, the `uq_ccp_branch_effective_from` precedent).
CREATE UNIQUE INDEX "uq_scp_scope_effective_from"
  ON "sales"."service_charge_policies"("tenant_id", "level", "target_id", "effective_from");

-- The resolver's only access path: latest version effective at or before
-- some `at` instant, for one (level, target).
CREATE INDEX "service_charge_policies_resolve_idx"
  ON "sales"."service_charge_policies"("tenant_id", "level", "target_id", "effective_from" DESC);

ALTER TABLE "sales"."service_charge_policies" ADD CONSTRAINT "service_charge_policies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Untenanted global FK, mirroring `cash_close_policies.created_by` /
-- `setting_values.created_by` exactly.
ALTER TABLE "sales"."service_charge_policies" ADD CONSTRAINT "service_charge_policies_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- Immutable, append-only facts, EXCEPT a version may still be cancelled
-- while genuinely future (P2A-R1 clause 11 — new territory beyond the
-- cash_close_policies precedent, which grants no DELETE at all). SELECT is
-- table-level; INSERT is COLUMN-level and deliberately excludes
-- `created_at` so `ros_app` cannot forge the creation instant and defeat
-- the anti-backdating CHECK.
GRANT SELECT ON "sales"."service_charge_policies" TO ros_app;
GRANT INSERT (
  "id", "tenant_id", "level", "target_id", "rules", "locked",
  "effective_from", "created_by"
) ON "sales"."service_charge_policies" TO ros_app;
GRANT DELETE ON "sales"."service_charge_policies" TO ros_app;
REVOKE UPDATE, TRUNCATE ON "sales"."service_charge_policies" FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "sales"."service_charge_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."service_charge_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_charge_policies_select ON "sales"."service_charge_policies" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY service_charge_policies_insert ON "sales"."service_charge_policies" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- P2A-R1 clause 11 — future-only cancellation, enforced HERE, not merely by
-- application logic: `statement_timestamp()` is evaluated fresh at DELETE
-- execution time, so a version that has become effective since it was
-- created can never be deleted, race or no race.
CREATE POLICY service_charge_policies_delete ON "sales"."service_charge_policies" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND effective_from > statement_timestamp());
-- No UPDATE policy. Versions are immutable facts once effective; a
-- not-yet-effective version is cancelled (deleted), never edited.

COMMENT ON TABLE "sales"."service_charge_policies" IS
  'P2D (ratified P2D-R1) — Sales-owned, immutable, effective-dated tenant/brand/branch service-charge CONFIGURATION substrate. Does NOT compute or apply a service charge to any Order (P2E remains required for that). Not the generic FR-PLT-025 six-level settings hierarchy.';

-- --------------------------------------------------------- ORDER PINNING ---
ALTER TABLE "sales"."orders" ADD COLUMN "service_charge_policy_version_id" UUID;

ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_tenant_id_service_charge_policy_version_id_fkey"
  FOREIGN KEY ("tenant_id", "service_charge_policy_version_id")
  REFERENCES "sales"."service_charge_policies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "sales"."orders"."service_charge_policy_version_id" IS
  'P2D (ratified P2D-R1) — the ServiceChargePolicy version resolved and pinned at Order.opened_at. NULL means no configured version governed this order''s scope at that instant. Never implies a non-zero service charge was computed (P2E remains required for that).';
