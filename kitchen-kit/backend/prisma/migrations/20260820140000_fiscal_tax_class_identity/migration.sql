-- ---------------------------------------------------------------------------
-- P1C — fiscal.tax_classes: the stable semantic TaxClass identity.
--
-- Authorised by the C-04 AMENDMENT (2026-08-20), recorded verbatim in
-- docs/catalogue/README.md and indexed as carried item P1C-1 in the governance
-- register. The reopen is NARROW: it settles TaxClass identity and referential
-- integrity only. Fiscal is otherwise still out of scope — no tax documents, no
-- invoice templates, no fiscal submissions, and NO `fiscal.tax_rules`.
--
-- ── WHY THIS TABLE EXISTS AT ALL ────────────────────────────────────────────
-- BR-POS-004 makes `sales.order_lines.tax_class_id UUID NOT NULL` a mandatory
-- sale-time snapshot. A Country Pack names its tax classes by semantic CODE
-- (`standard`, `zero`, …), so without a stable UUID identity the Sales writer
-- could only fabricate one. This table is that identity and nothing else.
--
-- ── WHY IT CARRIES NO RATE ──────────────────────────────────────────────────
-- CR-03 and ADR-005 put jurisdiction rules in pack DATA. A rate column here
-- would mean a rate change rewrote the meaning of every historical order line
-- pointing at the row. Instead the line stores the IDENTITY and the order stores
-- the pack VERSION, so `standard` can move from 14% to 16% without touching one
-- past sale. Adding rate/rounding/override columns to this table is forbidden by
-- the amendment.
--
-- ── WHY `code` IS A SEPARATE COLUMN FROM `names` ────────────────────────────
-- The approved SQL gives `fiscal.tax_classes(id, tenant_id, name,
-- country_pack_code)`. `name` is a localisable display label — it is renamed,
-- translated, and corrected. Using it as the lookup key into a pack's class list
-- would mean a typo fix silently re-taxed a menu. `code` is added as the
-- immutable machine key; `names` keeps the display role, widened to JSONB to
-- match how every other Catalogue label is stored (FR-LOC-006).
--
-- ── WHY THE CODE SET IS OPEN ────────────────────────────────────────────────
-- VARCHAR, not an enum. FR-LOC-020 requires jurisdiction behaviour to be
-- data-driven: a pack for a jurisdiction with a `tourism` or `municipality`
-- class must work without a schema migration. `standard | reduced | zero |
-- exempt` are the SRS §22.2 examples, not an exhaustive list.
--
-- ── EXISTING-DATA PROBE (required before adding the FK) ─────────────────────
-- `catalogue.menu_items` on the development database: 63 rows, of which 0 carry
-- a non-null `tax_class_id`. C-04 made the column nullable and FK-less, and no
-- code path has ever written it, so the new FK cannot orphan an existing row.
-- Nothing is rewritten, deleted or back-filled by this migration.
-- ---------------------------------------------------------------------------

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "fiscal";

-- CreateTable
CREATE TABLE "fiscal"."tax_classes" (
    "id"                UUID         NOT NULL,
    "tenant_id"         UUID         NOT NULL,
    "country_pack_code" VARCHAR(8)   NOT NULL,
    "code"              VARCHAR(32)  NOT NULL,
    "names"             JSONB        NOT NULL,
    "is_active"         BOOLEAN      NOT NULL DEFAULT true,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tax_classes_pkey" PRIMARY KEY ("id")
);

-- The semantic key is normalised at write time by the application, and the
-- shape is enforced here so a hand-written row cannot introduce a code that no
-- pack lookup could ever match.
ALTER TABLE "fiscal"."tax_classes"
  ADD CONSTRAINT "ck_tax_class_code_shape" CHECK ("code" ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE "fiscal"."tax_classes"
  ADD CONSTRAINT "ck_tax_class_pack_code_shape" CHECK ("country_pack_code" ~ '^[A-Z]{2,8}$');

-- Tenant-leading composite target. `catalogue.menu_items` references THIS, not
-- the bare id: an FK check runs as the table owner and bypasses RLS, so a
-- single-column reference could be satisfied by another tenant's row
-- (ADR 0008 D-09). The tenant column is part of the reference, so it cannot.
CREATE UNIQUE INDEX "tax_classes_tenant_id_id_key"
  ON "fiscal"."tax_classes"("tenant_id", "id");

-- One semantic code per jurisdiction per tenant. Two tenants may both define
-- `standard` for EG; one tenant may not define it twice.
CREATE UNIQUE INDEX "uq_tax_class_code"
  ON "fiscal"."tax_classes"("tenant_id", "country_pack_code", "code");

CREATE INDEX "tax_classes_tenant_id_country_pack_code_idx"
  ON "fiscal"."tax_classes"("tenant_id", "country_pack_code");

ALTER TABLE "fiscal"."tax_classes"
  ADD CONSTRAINT "tax_classes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------- CATALOGUE LINKAGE ---
-- C-04 AMENDMENT: the column stays NULLABLE (onboarding master data legitimately
-- arrives incomplete, which the original ratification already settled) but every
-- non-null value becomes a real tenant-safe reference enforced by the DATABASE.
-- Application validation alone was explicitly judged insufficient.
--
-- ON DELETE RESTRICT: a tax class in use by a menu item may not vanish, because
-- historical order lines snapshot its id and must stay resolvable.
ALTER TABLE "catalogue"."menu_items"
  ADD CONSTRAINT "menu_items_tax_class_fkey"
  FOREIGN KEY ("tenant_id", "tax_class_id")
  REFERENCES "fiscal"."tax_classes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
GRANT USAGE ON SCHEMA "fiscal" TO ros_app;

-- COLUMN-LEVEL UPDATE, following the GAP-2 precedent ("column-level UPDATE grant
-- ... no triggers"). `code` and `country_pack_code` are the semantic identity and
-- `tenant_id` is the isolation boundary; none of the three is in the grant, so
-- PostgreSQL refuses an attempt by the runtime role to mutate them — a semantic
-- identity cannot be turned into a different meaning under the order lines that
-- already point at it. Display metadata and the active flag remain editable.
GRANT SELECT, INSERT, DELETE ON "fiscal"."tax_classes" TO ros_app;
GRANT UPDATE ("names", "is_active") ON "fiscal"."tax_classes" TO ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "fiscal"."tax_classes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal"."tax_classes" FORCE ROW LEVEL SECURITY;

CREATE POLICY tax_classes_select ON "fiscal"."tax_classes" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tax_classes_insert ON "fiscal"."tax_classes" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tax_classes_update ON "fiscal"."tax_classes" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tax_classes_delete ON "fiscal"."tax_classes" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ------------------------------------------------ RECIPE COST WRITE GRANT ---
-- FR-MNU-046, authorised by the D-17-05 NARROW AMENDMENT (design gate §4.1).
--
-- GAP-2 granted `ros_app` column-level `UPDATE (status)` on
-- `production.recipe_versions` and nothing else, which is how D-17-04's
-- "published versions immutable at database level" is enforced without triggers.
-- That grant made `computed_cost` unwritable — correct while costing was
-- deferred, and the reason the column was provably always null.
--
-- The amendment lifts the defer for recipe-cost recomputation, so the grant
-- widens by exactly two columns. D-17-04's substance is untouched: recipe
-- CONTENT — yield, units, prep time, instructions, lines — remains unwritable by
-- the runtime role, and `computed_cost` / `cost_computed_at` are a CACHED
-- derived value the SRS explicitly requires to be recomputed, not recipe content.
--
-- Nothing else is granted. In particular `ros_app` still cannot rewrite
-- `yield_quantity`, `yield_percentage`, `recipe_id` or `version`.
GRANT UPDATE ("computed_cost", "cost_computed_at")
  ON "production"."recipe_versions" TO ros_app;
