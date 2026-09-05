-- ---------------------------------------------------------------------------
-- POS-FIN-1 ACCEPTANCE CORRECTION (2026-09-04) — FR-POS-071's literal "each
-- post-fire disposition classification SHALL create the corresponding
-- inventory record", for ALL THREE classifications (returned_to_stock,
-- wasted, given_to_staff), not only the two that post a stock movement.
--
-- The prior POS-FIN-1 pass (migration 20260903185024) created only a
-- Sales-owned `sales.post_fire_void_records` row per void — FR-POS-071 is an
-- INVENTORY requirement, and a Sales-owned row does not satisfy it. This
-- migration adds the Inventory-OWNED, append-only record.
--
-- NOTE ON SCOPE: `prisma migrate dev --create-only` against this branch's
-- schema diff also reported the same large amount of PRE-EXISTING,
-- unrelated drift already documented in migration
-- 20260903185024_pos_financial_corrections's own header (cosmetic
-- constraint/index naming differences predating this session). None of
-- that is reproduced here: this migration contains ONLY the new
-- `inventory.post_fire_void_disposition_records` table and its enum.
--
-- `returned_to_stock` gets a row with `movement_ids = '[]'` and
-- `total_value = 0` — no stock movement is fabricated to manufacture a
-- ledger row (the physical effect is genuinely zero: this system depletes
-- stock at Order Completion, not at Fire, so a post-fire-voided line never
-- reached the sale-depletion ledger in the first place) — but the
-- disposition classification itself is still durably, append-only evidenced,
-- with the components considered recorded for later inspection.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "inventory"."PostFireDispositionKind" AS ENUM ('returned_to_stock', 'wasted', 'given_to_staff');

-- CreateTable
CREATE TABLE "inventory"."post_fire_void_disposition_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "disposition" "inventory"."PostFireDispositionKind" NOT NULL,
    "reason_code_id" UUID NOT NULL,
    "components" JSONB NOT NULL,
    "movement_ids" JSONB NOT NULL DEFAULT '[]',
    "total_value" BIGINT NOT NULL DEFAULT 0,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_fire_void_disposition_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_pfvdr_total_value_nonneg" CHECK ("total_value" >= 0),
    -- Structural honesty: a disposition that posted no movement must show
    -- zero value; a disposition that posted movements must show it via a
    -- non-empty ids array (checked at the JSON-array-length level, since a
    -- CHECK cannot compare a JSONB array's cardinality directly to the
    -- disposition enum without a function — this uses jsonb_array_length).
    CONSTRAINT "ck_pfvdr_returned_to_stock_is_inert" CHECK (
      "disposition" <> 'returned_to_stock'
      OR (jsonb_array_length("movement_ids") = 0 AND "total_value" = 0)
    )
);

-- CreateIndex
CREATE INDEX "post_fire_void_disposition_records_tenant_id_order_line_id_idx" ON "inventory"."post_fire_void_disposition_records"("tenant_id", "order_line_id");

-- CreateIndex
CREATE INDEX "post_fire_void_disposition_records_tenant_id_location_id_cr_idx" ON "inventory"."post_fire_void_disposition_records"("tenant_id", "location_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "post_fire_void_disposition_records_tenant_id_id_key" ON "inventory"."post_fire_void_disposition_records"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "inventory"."post_fire_void_disposition_records" ADD CONSTRAINT "post_fire_void_disposition_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — the same tenant-safe composite FK target `org.locations`
-- already exposes (`sales.order_payments`/`inventory.stock_movements`'s own
-- precedent for reaching Location).
ALTER TABLE "inventory"."post_fire_void_disposition_records" ADD CONSTRAINT "post_fire_void_disposition_records_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "org"."locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory"."post_fire_void_disposition_records" ADD CONSTRAINT "post_fire_void_disposition_records_tenant_id_reason_code_i_fkey" FOREIGN KEY ("tenant_id", "reason_code_id") REFERENCES "inventory"."reason_codes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — User is global (no tenant_id column); tenant safety comes
-- from this table's own RLS, the same posture `waste_records.recorded_by`
-- already uses.
ALTER TABLE "inventory"."post_fire_void_disposition_records" ADD CONSTRAINT "post_fire_void_disposition_records_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- GRANTS ---
-- Append-only (CR-04 posture, same as every other new POS-FIN-1 table):
-- this is a durable disposition record, never edited or deleted.
GRANT SELECT, INSERT ON "inventory"."post_fire_void_disposition_records" TO ros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "inventory"."post_fire_void_disposition_records" FROM ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "inventory"."post_fire_void_disposition_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."post_fire_void_disposition_records" FORCE ROW LEVEL SECURITY;

CREATE POLICY post_fire_void_disposition_records_select ON "inventory"."post_fire_void_disposition_records" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY post_fire_void_disposition_records_insert ON "inventory"."post_fire_void_disposition_records" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No UPDATE/DELETE policy — fully append-only, and UPDATE/DELETE/TRUNCATE
-- are already revoked above (defence in depth).
