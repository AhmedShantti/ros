-- ---------------------------------------------------------------------------
-- P1A — Sales Order capture foundation.
--
-- Implements the SRS §7.3 #22 Order aggregate, FR-POS-001/002/005/013/014,
-- FR-OFF-015/016, FR-DR-001 partitioning and FR-PLT-003/010/011/012 tenancy.
--
-- ── DOCUMENTED DEVIATIONS FROM THE APPROVED SQL, AND WHY ────────────────────
-- The approved `sales.orders` references four bounded contexts that do not
-- exist in this repository. Each is handled explicitly rather than faked:
--
--   opened_by/served_by/closed_by -> approved SQL says `workforce.employees`.
--       The D-2 amendment built the employee substrate in `identity.employees`,
--       so these reference THAT table. Same entity, repository location.
--   customer_id  -> `crm.customers` absent. The column is NULLABLE in the
--       approved SQL, so omitting it loses no invariant. CRM is a non-goal.
--   cash_session_id -> `treasury.cash_sessions` absent. Also nullable. Omitted.
--   hlc, sync_state -> the hybrid logical clock and `sync.state_enum` belong to
--       the Offline/Sync protocol, an explicit non-goal. Omitted rather than
--       invented; they are additive columns for the Sync slice.
--
--   country_pack_version -> KEPT, and kept NOT NULL with NO DEFAULT.
--       There is no authoritative CountryPack source in the repository: the only
--       related datum is `identity.tenants.country_pack_code` (e.g. 'EG'), which
--       is a CODE, not a signed pack VERSION (FR-LOC-022 requires packs to be
--       signed and validated). Writing 'default'/'unknown'/'' or relaxing the
--       NOT NULL would each be a fabrication, so none is done. The column stands
--       correct and the PUBLIC create path stays unexposed until the CountryPack
--       slice supplies a real version.
--
--   order_lines.tax_class_id -> KEPT NOT NULL, for the same reason. Catalogue's
--       `menu_items.tax_class_id` is nullable and FK-less (recorded as knowingly
--       unmet by C-04), so there is no trustworthy snapshot source. Writing a
--       zero/placeholder tax class would be a fabrication. Public line capture
--       stays unexposed until the Tax/CountryPack slice lands.
--
--   unit_cost_snapshot / recipe_version_id are NULLABLE in the approved SQL, so
--       the absent costing source (D-17-05 deferred) forces no fabrication.
--
-- ── PARTITIONING (FR-DR-001) ────────────────────────────────────────────────
-- `orders` and `order_lines` are monthly RANGE-partitioned on `business_day`
-- from creation, never "unpartitioned for now". PostgreSQL requires the
-- partition key inside every unique constraint, so the primary keys are
-- (id, business_day). `id` remains the permanent client-generated ULID
-- (FR-OFF-015) — the composite is a storage requirement, not a second identity,
-- and nothing reassigns or remaps it.
--
-- Every partition receives its OWN RLS. This is not belt-and-braces: RLS on a
-- partitioned PARENT does not govern a direct query against a CHILD, a defect
-- previously found on `inventory.stock_movements` by live probe. The same
-- mistake is not repeated here.
--
-- FR-DR-002 automatic future partition creation is NOT implemented; partitions
-- below are created explicitly, following the repository's current+future
-- convention.
-- ---------------------------------------------------------------------------

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "sales";

-- CreateEnum — verbatim from the approved SQL. FR-POS-001 requires every order
-- type; none is dropped for "MVP" convenience.
CREATE TYPE "sales"."OrderType" AS ENUM ('dine_in', 'takeaway', 'delivery', 'drive_thru', 'pickup', 'aggregator');
CREATE TYPE "sales"."OrderChannel" AS ENUM ('pos', 'kiosk', 'qr', 'aggregator', 'phone', 'api');
CREATE TYPE "sales"."OrderState" AS ENUM ('draft', 'open', 'held', 'parked', 'partially_paid', 'completed', 'cancelled', 'partially_refunded', 'refunded');
CREATE TYPE "sales"."OrderLineState" AS ENUM ('pending', 'fired', 'preparing', 'ready', 'served', 'voided', 'comped');

-- CreateTable
CREATE TABLE "sales"."orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "order_number" VARCHAR(24) NOT NULL,
    "business_day" DATE NOT NULL,
    "order_type" "sales"."OrderType" NOT NULL,
    "channel" "sales"."OrderChannel" NOT NULL,
    "state" "sales"."OrderState" NOT NULL DEFAULT 'draft',
    "table_id" UUID,
    "guest_count" SMALLINT,
    "opened_by" UUID NOT NULL,
    "served_by" UUID,
    "closed_by" UUID,
    "currency" CHAR(3) NOT NULL,
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "discount_total" BIGINT NOT NULL DEFAULT 0,
    "service_charge_total" BIGINT NOT NULL DEFAULT 0,
    "tax_total" BIGINT NOT NULL DEFAULT 0,
    "rounding_adjustment" BIGINT NOT NULL DEFAULT 0,
    "grand_total" BIGINT NOT NULL DEFAULT 0,
    "paid_total" BIGINT NOT NULL DEFAULT 0,
    "tip_total" BIGINT NOT NULL DEFAULT 0,
    "cogs_total" BIGINT,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "first_fired_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "origin_device_time" TIMESTAMPTZ(6) NOT NULL,
    "idempotency_key" VARCHAR(80) NOT NULL,
    "aggregator_ref" VARCHAR(80),
    "country_pack_version" VARCHAR(24) NOT NULL,
    "notes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- §24.6.4 optimistic concurrency: every mutation asserts the expected value.
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id", "business_day"),
    CONSTRAINT "ck_orders_guest_count" CHECK ("guest_count" IS NULL OR "guest_count" > 0),
    CONSTRAINT "ck_orders_discount_total" CHECK ("discount_total" >= 0),
    CONSTRAINT "ck_orders_service_charge_total" CHECK ("service_charge_total" >= 0),
    CONSTRAINT "ck_orders_tax_total" CHECK ("tax_total" >= 0),
    CONSTRAINT "ck_orders_paid_total" CHECK ("paid_total" >= 0),
    CONSTRAINT "ck_orders_tip_total" CHECK ("tip_total" >= 0),
    -- Approved SQL invariant, preserved.
    CONSTRAINT "ck_orders_completed" CHECK ("state" <> 'completed' OR "completed_at" IS NOT NULL),
    CONSTRAINT "ck_orders_version" CHECK ("version" >= 1)
) PARTITION BY RANGE ("business_day");

-- FR-POS-002: the human-readable number is unique within branch + business day.
CREATE UNIQUE INDEX "uq_order_number" ON "sales"."orders"("branch_id", "business_day", "order_number");
-- Tenant-leading (Chapter 25) and the referencable target for order_lines.
CREATE UNIQUE INDEX "orders_tenant_id_id_business_day_key" ON "sales"."orders"("tenant_id", "id", "business_day");
CREATE UNIQUE INDEX "uq_orders_idempotency" ON "sales"."orders"("tenant_id", "idempotency_key", "business_day");
CREATE INDEX "orders_tenant_branch_day_idx" ON "sales"."orders"("tenant_id", "branch_id", "business_day");
CREATE INDEX "orders_tenant_state_idx" ON "sales"."orders"("tenant_id", "state");

-- CreateTable
CREATE TABLE "sales"."order_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    -- Copied from the parent so the child can share the partition key and carry
    -- a tenant-safe composite FK to a partitioned parent.
    "business_day" DATE NOT NULL,
    "sequence" SMALLINT NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    -- BR-POS-004 sale-time snapshots. Never recomputed from current master data.
    "item_name_snapshot" JSONB NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "modifier_total" BIGINT NOT NULL DEFAULT 0,
    "line_discount" BIGINT NOT NULL DEFAULT 0,
    "line_subtotal" BIGINT NOT NULL,
    "tax_class_id" UUID NOT NULL,
    "tax_amount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "unit_cost_snapshot" BIGINT,
    "recipe_version_id" UUID,
    -- FR-POS-042: which price list and which rule produced the price.
    "price_list_id" UUID,
    "price_entry_id" UUID,
    "price_rule" VARCHAR(160),
    "course" SMALLINT,
    "seat_number" SMALLINT,
    "state" "sales"."OrderLineState" NOT NULL DEFAULT 'pending',
    "fired_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "void_reason_id" UUID,
    "voided_by" UUID,
    "is_comp" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id", "business_day"),
    CONSTRAINT "ck_order_line_void_reason" CHECK ("state" <> 'voided' OR "void_reason_id" IS NOT NULL),
    CONSTRAINT "ck_order_line_quantity" CHECK ("quantity" > 0),
    -- A fired line must carry the instant it was fired; the post-fire authority
    -- boundary (Clarification C) keys off exactly this.
    CONSTRAINT "ck_order_line_fired_at" CHECK ("state" = 'pending' OR "state" = 'voided' OR "fired_at" IS NOT NULL)
) PARTITION BY RANGE ("business_day");

CREATE UNIQUE INDEX "order_lines_tenant_id_id_business_day_key" ON "sales"."order_lines"("tenant_id", "id", "business_day");
CREATE UNIQUE INDEX "uq_order_line_sequence" ON "sales"."order_lines"("tenant_id", "order_id", "business_day", "sequence");
CREATE INDEX "order_lines_tenant_order_idx" ON "sales"."order_lines"("tenant_id", "order_id", "business_day");

-- CreateTable — modifier selections captured at sale time (FR-POS-020…024).
-- Not partitioned: it is a leaf of an order line and is always reached through
-- one, so it inherits its access pattern rather than its volume profile.
CREATE TABLE "sales"."order_line_modifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "modifier_id" UUID NOT NULL,
    "modifier_group_id" UUID NOT NULL,
    -- Snapshots: a later rename or reprice must not rewrite history.
    "name_snapshot" JSONB NOT NULL,
    "price_delta" BIGINT NOT NULL DEFAULT 0,
    "quantity" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_modifiers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_order_line_modifier_quantity" CHECK ("quantity" > 0)
);

CREATE UNIQUE INDEX "order_line_modifiers_tenant_id_id_key" ON "sales"."order_line_modifiers"("tenant_id", "id");
CREATE INDEX "order_line_modifiers_tenant_line_idx" ON "sales"."order_line_modifiers"("tenant_id", "order_line_id");

-- CreateTable — FR-POS-002 / FR-OFF-016 order-number blocks.
--
-- "Each terminal is issued a block of numbers on sync (default 500) and requests
-- a new block when 80% consumed." Numbers are therefore drawn from a
-- terminal-held block, NEVER from MAX()+1 and never from a global sequence:
-- either would require connectivity and would break offline operation.
CREATE TABLE "sales"."order_number_blocks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "block_start" INTEGER NOT NULL,
    "block_end" INTEGER NOT NULL,
    -- Highest sequence the terminal reports as consumed. Advisory for refill
    -- (the 80% rule); the authority on uniqueness is `uq_order_number`.
    "next_seq" INTEGER NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exhausted_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_number_blocks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_block_range" CHECK ("block_end" >= "block_start"),
    CONSTRAINT "ck_block_next" CHECK ("next_seq" >= "block_start" AND "next_seq" <= "block_end" + 1)
);

CREATE UNIQUE INDEX "order_number_blocks_tenant_id_id_key" ON "sales"."order_number_blocks"("tenant_id", "id");
CREATE UNIQUE INDEX "uq_block_start" ON "sales"."order_number_blocks"("branch_id", "business_day", "block_start");
CREATE INDEX "order_number_blocks_lookup_idx" ON "sales"."order_number_blocks"("tenant_id", "branch_id", "terminal_id", "business_day");

-- `org.tables` carries only (branch_id, label) unique, so a branch-safe FK to it
-- is not yet expressible. Add the (branch_id, id) composite the repository
-- already uses on its sibling org entities (e.g. stations). Additive index only:
-- no column, constraint or row is changed.
CREATE UNIQUE INDEX IF NOT EXISTS "tables_branch_id_id_key" ON "org"."tables"("branch_id", "id");

-- --------------------------------------------------------- FOREIGN KEYS ---
-- Composite tenant-safe FKs throughout (ADR 0008 D-09): referential integrity is
-- evaluated with row security DISABLED, so these are structural guarantees that
-- hold even if an application check is bypassed.
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_tenant_id_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_tenant_id_served_by_fkey"
  FOREIGN KEY ("tenant_id", "served_by") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by") REFERENCES "identity"."employees"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- `identity.terminals` has no (tenant_id, id) composite unique, so the tenant
-- guard for the terminal is the service check plus the terminal's own
-- tenant-safe branch FK added in the P0 substrate.
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_terminal_id_fkey"
  FOREIGN KEY ("terminal_id") REFERENCES "identity"."terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."orders" ADD CONSTRAINT "orders_branch_id_table_id_fkey"
  FOREIGN KEY ("branch_id", "table_id") REFERENCES "org"."tables"("branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_order_fkey"
  FOREIGN KEY ("tenant_id", "order_id", "business_day")
  REFERENCES "sales"."orders"("tenant_id", "id", "business_day") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_tenant_id_variant_id_fkey"
  FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "catalogue"."menu_item_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_tenant_id_menu_item_id_fkey"
  FOREIGN KEY ("tenant_id", "menu_item_id") REFERENCES "catalogue"."menu_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales"."order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales"."order_line_modifiers" ADD CONSTRAINT "order_line_modifiers_line_fkey"
  FOREIGN KEY ("tenant_id", "order_line_id", "business_day")
  REFERENCES "sales"."order_lines"("tenant_id", "id", "business_day") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sales"."order_number_blocks" ADD CONSTRAINT "order_number_blocks_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales"."order_number_blocks" ADD CONSTRAINT "order_number_blocks_tenant_id_branch_id_fkey"
  FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "org"."branches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales"."order_number_blocks" ADD CONSTRAINT "order_number_blocks_terminal_id_fkey"
  FOREIGN KEY ("terminal_id") REFERENCES "identity"."terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------ PARTITIONS ---
CREATE TABLE "sales"."orders_2026_08" PARTITION OF "sales"."orders" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "sales"."orders_2026_09" PARTITION OF "sales"."orders" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "sales"."orders_2026_10" PARTITION OF "sales"."orders" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "sales"."orders_2026_11" PARTITION OF "sales"."orders" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "sales"."orders_2026_12" PARTITION OF "sales"."orders" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "sales"."orders_2027_01" PARTITION OF "sales"."orders" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

CREATE TABLE "sales"."order_lines_2026_08" PARTITION OF "sales"."order_lines" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "sales"."order_lines_2026_09" PARTITION OF "sales"."order_lines" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "sales"."order_lines_2026_10" PARTITION OF "sales"."order_lines" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "sales"."order_lines_2026_11" PARTITION OF "sales"."order_lines" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "sales"."order_lines_2026_12" PARTITION OF "sales"."order_lines" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "sales"."order_lines_2027_01" PARTITION OF "sales"."order_lines" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

-- ---------------------------------------------------------------- GRANTS ---
GRANT USAGE ON SCHEMA "sales" TO ros_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "sales"."orders",
  "sales"."order_lines",
  "sales"."order_line_modifiers",
  "sales"."order_number_blocks"
  TO ros_app;

-- ------------------------------------------------------------------- RLS ---
ALTER TABLE "sales"."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_select ON "sales"."orders" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY orders_insert ON "sales"."orders" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY orders_update ON "sales"."orders" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY orders_delete ON "sales"."orders" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_lines_select ON "sales"."order_lines" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_lines_insert ON "sales"."order_lines" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_lines_update ON "sales"."order_lines" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_lines_delete ON "sales"."order_lines" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."order_line_modifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_line_modifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_modifiers_select ON "sales"."order_line_modifiers" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_modifiers_insert ON "sales"."order_line_modifiers" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_modifiers_update ON "sales"."order_line_modifiers" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_line_modifiers_delete ON "sales"."order_line_modifiers" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "sales"."order_number_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."order_number_blocks" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_number_blocks_select ON "sales"."order_number_blocks" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_number_blocks_insert ON "sales"."order_number_blocks" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_number_blocks_update ON "sales"."order_number_blocks" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY order_number_blocks_delete ON "sales"."order_number_blocks" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Every partition gets its OWN policies. RLS on a partitioned parent does NOT
-- govern a direct query against a child — the defect previously found on
-- `inventory.stock_movements` by live probe. Written as a loop so it covers all
-- partitions created above and is safe to re-run.
DO $$
DECLARE
  part regclass;
  parent text;
BEGIN
  FOREACH parent IN ARRAY ARRAY['orders', 'order_lines'] LOOP
    FOR part IN
      SELECT i.inhrelid::regclass
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'sales' AND p.relname = parent
    LOOP
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', part);
      EXECUTE format('DROP POLICY IF EXISTS sales_part_select ON %s', part);
      EXECUTE format(
        'CREATE POLICY sales_part_select ON %s FOR SELECT
           USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', part);
      EXECUTE format('DROP POLICY IF EXISTS sales_part_insert ON %s', part);
      EXECUTE format(
        'CREATE POLICY sales_part_insert ON %s FOR INSERT
           WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', part);
      EXECUTE format('DROP POLICY IF EXISTS sales_part_update ON %s', part);
      EXECUTE format(
        'CREATE POLICY sales_part_update ON %s FOR UPDATE
           USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
           WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', part);
      EXECUTE format('DROP POLICY IF EXISTS sales_part_delete ON %s', part);
      EXECUTE format(
        'CREATE POLICY sales_part_delete ON %s FOR DELETE
           USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', part);
    END LOOP;
  END LOOP;
END $$;
