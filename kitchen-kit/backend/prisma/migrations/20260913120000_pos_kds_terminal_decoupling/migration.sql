-- ---------------------------------------------------------------------------
-- CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13)
--
-- PRODUCT DECISION: POS and KDS are APPLICATION SESSIONS (tenant + employee +
-- branch + permissions), not registered ROS Terminal device identities. This
-- migration removes the load-bearing NOT NULL dependency on
-- identity.terminals(id) from every table it constrained order/payment/
-- close-attempt creation with. No data is deleted or rewritten: existing
-- rows keep whatever terminal_id they already carried (legacy provenance
-- only, per the P0 report's impact inventory); only the column's NOT NULL
-- constraint is dropped, so new rows may omit it. The composite FKs to
-- identity.terminals(branch_id, id) are left in place unchanged — Postgres
-- (MATCH SIMPLE, the default) already treats a FK with any NULL column as
-- automatically satisfied, so no FK needs to be dropped or redefined.
-- ---------------------------------------------------------------------------

ALTER TABLE "sales"."orders" ALTER COLUMN "terminal_id" DROP NOT NULL;

ALTER TABLE "sales"."order_payments" ALTER COLUMN "terminal_id" DROP NOT NULL;

ALTER TABLE "sales"."order_number_blocks" ALTER COLUMN "terminal_id" DROP NOT NULL;

ALTER TABLE "treasury"."cash_session_close_attempts" ALTER COLUMN "terminal_id" DROP NOT NULL;

-- FR-HRM-020/021 `pos_pin` clock-in/out (attendance.service.ts) no longer
-- has a terminal to record either — the clock event is attributed by
-- employee + branch, exactly like every other POS/KDS write this migration
-- decouples. The former CHECK required terminal_id for method='pos_pin';
-- that literal requirement is superseded by the same product decision as
-- the rest of this migration (workforce.clock_events.terminal_id is
-- already nullable, unchanged here — only the CHECK is dropped).
ALTER TABLE "workforce"."clock_events"
  DROP CONSTRAINT "ck_clock_event_terminal_required_for_pos_pin";
