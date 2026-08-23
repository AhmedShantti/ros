-- P1E-5 — Kitchen Ops: Ticket/TicketLine persistence (SRS §7.3 #23, §25.1).
-- Design closed by docs/reports/claude/2026-08-22_P1E4_ticket-ticketline-
-- design-closure.md; corrected by the P1E-5 prompt's four acceptance
-- corrections:
--   A. no semantic backfill of Modifier.kind (prior migration).
--   B. TicketFireBatch has NO sequence_no allocator — fire_batch_id (Sales-
--      minted) is the sole idempotency/ordering key; ORDER BY fired_at, id
--      for display.
--   C. tickets.order_type_snapshot is a Kitchen-owned VARCHAR(32), not
--      sales."OrderType" — a domain-event-boundary snapshot must not create
--      a hard Kitchen -> Sales database-type dependency.
--   D. branch_kds_config.recall_window_seconds DEFAULT 1800 is
--      source-supported (FR-KDS-025's stated default); cancelled_line_
--      visibility_seconds has NO default — FR-KDS-029 requires
--      configurability but names none.
--
-- Ticket is a Kitchen-owned aggregate (logical AND physical), unlike
-- station_routing_rules/branch_kds_config (Organisation-owned config stored
-- in this same physical schema per ADR 0008 D-06/D-07).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. branch_kds_config additive fields (acceptance correction D).
-- ----------------------------------------------------------------------------
ALTER TABLE "kitchen"."branch_kds_config"
  ADD COLUMN "recall_window_seconds" INTEGER NOT NULL DEFAULT 1800;
ALTER TABLE "kitchen"."branch_kds_config"
  ADD COLUMN "cancelled_line_visibility_seconds" INTEGER;

-- ----------------------------------------------------------------------------
-- 1. Enums.
-- ----------------------------------------------------------------------------
CREATE TYPE "kitchen"."TicketStatus" AS ENUM ('queued', 'in_progress', 'ready', 'bumped', 'served', 'recalled');
CREATE TYPE "kitchen"."TicketLineStatus" AS ENUM ('queued', 'started', 'ready', 'bumped', 'served', 'cancelled');
-- Kitchen's OWN copy of the three FR-POS-021 kinds — deliberately NOT
-- catalogue."ModifierKind" (acceptance correction re: order_type_snapshot,
-- applied identically here: a domain-event-boundary snapshot must not create
-- a hard Kitchen -> Catalogue database-type dependency).
CREATE TYPE "kitchen"."ModifierKindSnapshot" AS ENUM ('addition', 'removal', 'substitution');

-- ----------------------------------------------------------------------------
-- 2. kitchen.tickets — ONE row per (tenant, order, business_day, station).
-- ----------------------------------------------------------------------------
CREATE TABLE "kitchen"."tickets" (
    "id"                          UUID NOT NULL,
    "tenant_id"                   UUID NOT NULL,
    "branch_id"                   UUID NOT NULL,
    "business_day"                DATE NOT NULL,
    "order_id"                    UUID NOT NULL,
    "station_id"                  UUID NOT NULL,

    "order_number_snapshot"       VARCHAR(24) NOT NULL,
    "order_type_snapshot"         VARCHAR(32) NOT NULL,
    "service_reference_snapshot"  VARCHAR(64),

    "status"                      "kitchen"."TicketStatus" NOT NULL DEFAULT 'queued',
    "version"                     INTEGER NOT NULL DEFAULT 1,

    "created_at"                  TIMESTAMPTZ(6) NOT NULL,
    "routed_at"                   TIMESTAMPTZ(6) NOT NULL,
    "first_viewed_at"             TIMESTAMPTZ(6),
    "started_at"                  TIMESTAMPTZ(6),
    "ready_at"                    TIMESTAMPTZ(6),
    "bumped_at"                   TIMESTAMPTZ(6),
    "served_at"                   TIMESTAMPTZ(6),

    "target_ready_at"             TIMESTAMPTZ(6),

    "recalled_at"                 TIMESTAMPTZ(6),
    "recall_count"                SMALLINT NOT NULL DEFAULT 0,

    "started_by"                  UUID,
    "bumped_by"                   UUID,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tickets_tenant_id_id_key" ON "kitchen"."tickets"("tenant_id", "id");
-- CARDINALITY INVARIANT — one Ticket per order+station.
CREATE UNIQUE INDEX "uq_tickets_order_station"
  ON "kitchen"."tickets"("tenant_id", "order_id", "business_day", "station_id");
-- Additive FK target for ticket_lines — proves same-order membership.
CREATE UNIQUE INDEX "uq_tickets_id_order_business_day"
  ON "kitchen"."tickets"("tenant_id", "id", "order_id", "business_day");

ALTER TABLE "kitchen"."tickets"
  ADD CONSTRAINT "tickets_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partition-safe (includes business_day), and proves branch_id IS the
-- order's own branch — targets the P1E-3 K-1 additive unique; no new Sales
-- index required by this slice.
ALTER TABLE "kitchen"."tickets"
  ADD CONSTRAINT "tickets_order_fkey"
    FOREIGN KEY ("tenant_id", "order_id", "business_day", "branch_id")
    REFERENCES "sales"."orders"("tenant_id", "id", "business_day", "branch_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Chained with the FK above: a Station outside the order's own branch is
-- structurally unrepresentable.
ALTER TABLE "kitchen"."tickets"
  ADD CONSTRAINT "tickets_branch_id_station_id_fkey"
    FOREIGN KEY ("branch_id", "station_id")
    REFERENCES "org"."stations"("branch_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Actor FKs (FR-KDS-041 "by employee"). Same convention as
-- sales.orders.opened_by/served_by/closed_by: a real DB FK with no Prisma
-- relation object (no back-relation clutter on Employee).
ALTER TABLE "kitchen"."tickets"
  ADD CONSTRAINT "tickets_tenant_id_started_by_fkey"
    FOREIGN KEY ("tenant_id", "started_by")
    REFERENCES "identity"."employees"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kitchen"."tickets"
  ADD CONSTRAINT "tickets_tenant_id_bumped_by_fkey"
    FOREIGN KEY ("tenant_id", "bumped_by")
    REFERENCES "identity"."employees"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Resolver-shaped indexes: the station queue read (FIFO), the order -> its
-- tickets read (Expediter), and the target-time sort.
CREATE INDEX "tickets_tenant_id_branch_id_station_id_status_routed_at_idx"
  ON "kitchen"."tickets"("tenant_id", "branch_id", "station_id", "status", "routed_at");
CREATE INDEX "tickets_tenant_id_order_id_business_day_idx"
  ON "kitchen"."tickets"("tenant_id", "order_id", "business_day");
CREATE INDEX "tickets_tenant_id_branch_id_station_id_target_ready_at_idx"
  ON "kitchen"."tickets"("tenant_id", "branch_id", "station_id", "target_ready_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen"."tickets" TO ros_app;

ALTER TABLE "kitchen"."tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kitchen"."tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tickets_select ON "kitchen"."tickets" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tickets_insert ON "kitchen"."tickets" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tickets_update ON "kitchen"."tickets" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tickets_delete ON "kitchen"."tickets" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- 3. kitchen.ticket_fire_batches — FR-POS-038/FR-KDS-028 amendment identity.
-- Acceptance correction B: NO sequence_no allocator. fire_batch_id (minted by
-- Sales, one per Fire command) is the sole idempotency key; display ordering
-- is ORDER BY fired_at, id (id is a ULID — ties break in creation order).
-- ----------------------------------------------------------------------------
CREATE TABLE "kitchen"."ticket_fire_batches" (
    "id"            UUID NOT NULL,
    "tenant_id"     UUID NOT NULL,
    "ticket_id"     UUID NOT NULL,
    "fire_batch_id" UUID NOT NULL,
    "fired_at"      TIMESTAMPTZ(6) NOT NULL,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_fire_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_fire_batches_tenant_id_id_key"
  ON "kitchen"."ticket_fire_batches"("tenant_id", "id");
-- IDEMPOTENCY — one Fire command touches a given ticket at most once. No
-- unique-violation-then-retry allocator anywhere in this design.
CREATE UNIQUE INDEX "uq_ticket_fire_batches_ticket_fire_batch"
  ON "kitchen"."ticket_fire_batches"("tenant_id", "ticket_id", "fire_batch_id");
-- FK target for ticket_lines — proves a batch belongs to the line's own ticket.
CREATE UNIQUE INDEX "uq_ticket_fire_batches_ticket_id"
  ON "kitchen"."ticket_fire_batches"("tenant_id", "ticket_id", "id");

ALTER TABLE "kitchen"."ticket_fire_batches"
  ADD CONSTRAINT "ticket_fire_batches_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kitchen"."ticket_fire_batches"
  ADD CONSTRAINT "ticket_fire_batches_tenant_id_ticket_id_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id")
    REFERENCES "kitchen"."tickets"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ticket_fire_batches_tenant_id_ticket_id_fired_at_idx"
  ON "kitchen"."ticket_fire_batches"("tenant_id", "ticket_id", "fired_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen"."ticket_fire_batches" TO ros_app;

ALTER TABLE "kitchen"."ticket_fire_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kitchen"."ticket_fire_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_fire_batches_select ON "kitchen"."ticket_fire_batches" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_fire_batches_insert ON "kitchen"."ticket_fire_batches" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_fire_batches_update ON "kitchen"."ticket_fire_batches" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_fire_batches_delete ON "kitchen"."ticket_fire_batches" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- 4. kitchen.ticket_lines. No station_id/branch_id (both are the owning
-- Ticket's); FR-KDS-011's multi-station case is two TicketLine rows under
-- two Tickets, not a column here.
-- ----------------------------------------------------------------------------
CREATE TABLE "kitchen"."ticket_lines" (
    "id"                 UUID NOT NULL,
    "tenant_id"          UUID NOT NULL,
    "ticket_id"          UUID NOT NULL,
    "fire_batch_row_id"  UUID NOT NULL,
    "order_id"           UUID NOT NULL,
    "order_line_id"      UUID NOT NULL,
    "business_day"       DATE NOT NULL,

    "item_name_snapshot" JSONB NOT NULL,
    "quantity"           DECIMAL(12,3) NOT NULL,
    "course"             SMALLINT,
    "sequence"           SMALLINT NOT NULL,
    "preparation_notes"  TEXT,

    "status"             "kitchen"."TicketLineStatus" NOT NULL DEFAULT 'queued',

    "created_at"         TIMESTAMPTZ(6) NOT NULL,
    "routed_at"          TIMESTAMPTZ(6) NOT NULL,
    "first_viewed_at"    TIMESTAMPTZ(6),
    "started_at"         TIMESTAMPTZ(6),
    "ready_at"           TIMESTAMPTZ(6),
    "bumped_at"          TIMESTAMPTZ(6),
    "served_at"          TIMESTAMPTZ(6),

    "cancelled_at"       TIMESTAMPTZ(6),
    "recalled_at"        TIMESTAMPTZ(6),

    "started_by"         UUID,
    "bumped_by"           UUID,

    CONSTRAINT "ticket_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_lines_tenant_id_id_key" ON "kitchen"."ticket_lines"("tenant_id", "id");
-- IDEMPOTENCY + "one line per ticket". The SAME OrderLine MAY appear on a
-- DIFFERENT Ticket (different ticket_id) — FR-KDS-011's multi-station case.
CREATE UNIQUE INDEX "uq_ticket_lines_ticket_order_line"
  ON "kitchen"."ticket_lines"("tenant_id", "ticket_id", "order_line_id");

ALTER TABLE "kitchen"."ticket_lines"
  ADD CONSTRAINT "ticket_lines_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Proves this line's order matches its OWN ticket's order — the integrity
-- proof that makes "Order X's Ticket + Order Y's OrderLine" unrepresentable
-- (combined with the FK below).
ALTER TABLE "kitchen"."ticket_lines"
  ADD CONSTRAINT "ticket_lines_ticket_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id", "order_id", "business_day")
    REFERENCES "kitchen"."tickets"("tenant_id", "id", "order_id", "business_day")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Partition-safe: proves the OrderLine belongs to the SAME order named
-- above — targets the P1E-3 K-1 additive unique, no new Sales index required.
ALTER TABLE "kitchen"."ticket_lines"
  ADD CONSTRAINT "ticket_lines_order_line_fkey"
    FOREIGN KEY ("tenant_id", "order_id", "order_line_id", "business_day")
    REFERENCES "sales"."order_lines"("tenant_id", "order_id", "id", "business_day")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The batch must belong to THIS line's own ticket.
ALTER TABLE "kitchen"."ticket_lines"
  ADD CONSTRAINT "ticket_lines_fire_batch_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id", "fire_batch_row_id")
    REFERENCES "kitchen"."ticket_fire_batches"("tenant_id", "ticket_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kitchen"."ticket_lines"
  ADD CONSTRAINT "ticket_lines_tenant_id_started_by_fkey"
    FOREIGN KEY ("tenant_id", "started_by")
    REFERENCES "identity"."employees"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kitchen"."ticket_lines"
  ADD CONSTRAINT "ticket_lines_tenant_id_bumped_by_fkey"
    FOREIGN KEY ("tenant_id", "bumped_by")
    REFERENCES "identity"."employees"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ticket_lines_tenant_id_ticket_id_status_idx"
  ON "kitchen"."ticket_lines"("tenant_id", "ticket_id", "status");
CREATE INDEX "ticket_lines_tenant_id_ticket_id_fire_batch_row_id_idx"
  ON "kitchen"."ticket_lines"("tenant_id", "ticket_id", "fire_batch_row_id");
CREATE INDEX "ticket_lines_tenant_id_order_line_id_business_day_idx"
  ON "kitchen"."ticket_lines"("tenant_id", "order_line_id", "business_day");

GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen"."ticket_lines" TO ros_app;

ALTER TABLE "kitchen"."ticket_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kitchen"."ticket_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_lines_select ON "kitchen"."ticket_lines" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_lines_insert ON "kitchen"."ticket_lines" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_lines_update ON "kitchen"."ticket_lines" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_lines_delete ON "kitchen"."ticket_lines" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- 5. kitchen.ticket_line_modifiers. Idempotency key is the SOURCE SALES ROW
-- (source_order_line_modifier_id), not source_modifier_id alone —
-- FR-MNU-011's allow-repeat / free-quantity threshold make a repeated
-- selection of the SAME Catalogue modifier legal.
-- ----------------------------------------------------------------------------
CREATE TABLE "kitchen"."ticket_line_modifiers" (
    "id"                             UUID NOT NULL,
    "tenant_id"                      UUID NOT NULL,
    "ticket_line_id"                 UUID NOT NULL,
    "source_order_line_modifier_id"  UUID NOT NULL,
    "source_modifier_id"             UUID NOT NULL,
    "name_snapshot"                  JSONB NOT NULL,
    "kind"                           "kitchen"."ModifierKindSnapshot" NOT NULL,
    "quantity"                       SMALLINT NOT NULL DEFAULT 1,
    "created_at"                     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_line_modifiers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_line_modifiers_tenant_id_id_key"
  ON "kitchen"."ticket_line_modifiers"("tenant_id", "id");
-- IDEMPOTENCY: replaying the same Sales modifier snapshot is a no-op. Two
-- DISTINCT Sales rows selecting the same Catalogue modifier (legal under
-- allow_repeat) remain independently representable.
CREATE UNIQUE INDEX "uq_ticket_line_modifiers_line_source"
  ON "kitchen"."ticket_line_modifiers"("tenant_id", "ticket_line_id", "source_order_line_modifier_id");

ALTER TABLE "kitchen"."ticket_line_modifiers"
  ADD CONSTRAINT "ticket_line_modifiers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "identity"."tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kitchen"."ticket_line_modifiers"
  ADD CONSTRAINT "ticket_line_modifiers_ticket_line_fkey"
    FOREIGN KEY ("tenant_id", "ticket_line_id")
    REFERENCES "kitchen"."ticket_lines"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
-- Traceability/integrity only — never a live read path.
ALTER TABLE "kitchen"."ticket_line_modifiers"
  ADD CONSTRAINT "ticket_line_modifiers_source_modifier_fkey"
    FOREIGN KEY ("tenant_id", "source_modifier_id")
    REFERENCES "catalogue"."modifiers"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kitchen"."ticket_line_modifiers"
  ADD CONSTRAINT "ticket_line_modifiers_source_order_line_modifier_fkey"
    FOREIGN KEY ("tenant_id", "source_order_line_modifier_id")
    REFERENCES "sales"."order_line_modifiers"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ticket_line_modifiers_tenant_id_ticket_line_id_idx"
  ON "kitchen"."ticket_line_modifiers"("tenant_id", "ticket_line_id");

GRANT SELECT, INSERT, UPDATE, DELETE ON "kitchen"."ticket_line_modifiers" TO ros_app;

ALTER TABLE "kitchen"."ticket_line_modifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kitchen"."ticket_line_modifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_line_modifiers_select ON "kitchen"."ticket_line_modifiers" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_line_modifiers_insert ON "kitchen"."ticket_line_modifiers" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_line_modifiers_update ON "kitchen"."ticket_line_modifiers" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY ticket_line_modifiers_delete ON "kitchen"."ticket_line_modifiers" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
