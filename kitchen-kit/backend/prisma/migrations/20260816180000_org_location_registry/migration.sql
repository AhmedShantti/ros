-- CreateEnum
CREATE TYPE "org"."LocationType" AS ENUM ('branch', 'warehouse', 'central_kitchen');

-- CreateTable
CREATE TABLE "org"."locations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "location_type" "org"."LocationType" NOT NULL,
    "ref_id" UUID NOT NULL,
    "branch_id" UUID,
    "warehouse_id" UUID,
    "central_kitchen_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "locations_tenant_id_idx" ON "org"."locations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_tenant_id_id_key" ON "org"."locations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_tenant_id_location_type_ref_id_key" ON "org"."locations"("tenant_id", "location_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "central_kitchens_tenant_id_id_key" ON "org"."central_kitchens"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_tenant_id_warehouse_id_fkey" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "org"."warehouses"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_tenant_id_central_kitchen_id_fkey" FOREIGN KEY ("tenant_id", "central_kitchen_id") REFERENCES "org"."central_kitchens"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- P15-2 / P15-4 — org.locations: structural integrity, privileges, RLS, backfill.
-- Prerequisite for the frozen Inventory design (blocker C-02, Decision A).
-- Hand-written because Prisma cannot express CHECK constraints, grants, RLS or
-- data backfill.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Structural invariant: EXACTLY ONE typed column is populated, it AGREES with
-- location_type, and ref_id equals it. This is what makes the denormalised
-- ref_id incapable of disagreeing with the typed FK columns.
-- ----------------------------------------------------------------------------
ALTER TABLE "org"."locations"
  ADD CONSTRAINT "ck_location_target" CHECK (
       ("location_type" = 'branch'
        AND "branch_id" IS NOT NULL AND "warehouse_id" IS NULL AND "central_kitchen_id" IS NULL
        AND "ref_id" = "branch_id")
    OR ("location_type" = 'warehouse'
        AND "warehouse_id" IS NOT NULL AND "branch_id" IS NULL AND "central_kitchen_id" IS NULL
        AND "ref_id" = "warehouse_id")
    OR ("location_type" = 'central_kitchen'
        AND "central_kitchen_id" IS NOT NULL AND "branch_id" IS NULL AND "warehouse_id" IS NULL
        AND "ref_id" = "central_kitchen_id")
  );

-- ----------------------------------------------------------------------------
-- Runtime role privileges. The Phase 15 ALTER DEFAULT PRIVILEGES already covers
-- migrator-created org tables, but grant explicitly so this migration is
-- self-contained on a clean database (same approach as Phase 9).
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "org"."locations" TO ros_app;

-- ----------------------------------------------------------------------------
-- RLS — direct tenant_id anchor, identical to the Phase 15 org tables.
-- Missing context -> NULL -> predicate false -> FAIL CLOSED.
-- ----------------------------------------------------------------------------
ALTER TABLE "org"."locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org"."locations" FORCE ROW LEVEL SECURITY;

CREATE POLICY locations_select ON "org"."locations" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY locations_insert ON "org"."locations" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY locations_update ON "org"."locations" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY locations_delete ON "org"."locations" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- P15-4 BACKFILL — one registry row for every EXISTING branch, warehouse and
-- central kitchen, so the invariant "every org location entity has a locations
-- row" holds from the moment this migration completes.
--
-- Ids use gen_random_uuid() rather than the application's ULID-as-UUID
-- (`newId()`): migrations are pure SQL and cannot generate ULIDs. Registry ids
-- are opaque and carry no ordering semantics, so only backfilled rows lack the
-- time-ordering property. Rows created by the application afterwards use ULIDs.
--
-- ON CONFLICT DO NOTHING makes the backfill idempotent against the
-- (tenant_id, location_type, ref_id) key.
-- ----------------------------------------------------------------------------
INSERT INTO "org"."locations"
  (id, tenant_id, location_type, ref_id, branch_id, warehouse_id, central_kitchen_id, created_at)
SELECT gen_random_uuid(), b.tenant_id, 'branch', b.id, b.id, NULL, NULL, now()
FROM "org"."branches" b
ON CONFLICT (tenant_id, location_type, ref_id) DO NOTHING;

INSERT INTO "org"."locations"
  (id, tenant_id, location_type, ref_id, branch_id, warehouse_id, central_kitchen_id, created_at)
SELECT gen_random_uuid(), w.tenant_id, 'warehouse', w.id, NULL, w.id, NULL, now()
FROM "org"."warehouses" w
ON CONFLICT (tenant_id, location_type, ref_id) DO NOTHING;

INSERT INTO "org"."locations"
  (id, tenant_id, location_type, ref_id, branch_id, warehouse_id, central_kitchen_id, created_at)
SELECT gen_random_uuid(), ck.tenant_id, 'central_kitchen', ck.id, NULL, NULL, ck.id, now()
FROM "org"."central_kitchens" ck
ON CONFLICT (tenant_id, location_type, ref_id) DO NOTHING;
