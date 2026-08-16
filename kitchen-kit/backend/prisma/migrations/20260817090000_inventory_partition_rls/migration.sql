-- Inventory: close the direct-partition RLS bypass on the stock movement ledger.
--
-- DEFECT (found by live probe as ros_app, not by the test suite):
--   ENABLE/FORCE ROW LEVEL SECURITY and CREATE POLICY on a PARTITIONED PARENT
--   govern access made THROUGH the parent. PostgreSQL applies a PARTITION's OWN
--   policies when that partition is named DIRECTLY. The Inventory foundation
--   migration enabled RLS only on "inventory"."stock_movements", while granting
--   SELECT, INSERT on every partition -- so ros_app could read any tenant's rows,
--   and read them with NO tenant context at all, via:
--
--       SELECT * FROM inventory.stock_movements_2026_08;
--
--   Observed before this migration: 43 rows readable with no tenant context, and
--   11 rows of tenant T readable while scoped to tenant O.
--
-- This is not a design change. It applies the ALREADY-RATIFIED ledger policy
-- (BR-INV-001 append-only + fail-closed tenant isolation) to the relations that
-- were missed. The predicate is byte-identical to the parent's.
--
-- FORWARD OBLIGATION: every future stock_movements partition MUST repeat this
-- block. Partition creation is currently manual (FR-DR-002 automation is
-- deferred), so the DO block below is written to cover ALL existing partitions
-- and is safe to re-run.

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT i.inhrelid::regclass
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'inventory' AND p.relname = 'stock_movements'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', part);

    -- Idempotent: drop-then-create keeps the predicate authoritative here.
    EXECUTE format('DROP POLICY IF EXISTS stock_movements_part_select ON %s', part);
    EXECUTE format(
      'CREATE POLICY stock_movements_part_select ON %s FOR SELECT
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      part);

    EXECUTE format('DROP POLICY IF EXISTS stock_movements_part_insert ON %s', part);
    EXECUTE format(
      'CREATE POLICY stock_movements_part_insert ON %s FOR INSERT
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      part);

    -- Append-only, mirroring the parent: no UPDATE/DELETE policy is created and
    -- the privileges are revoked outright.
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM ros_app', part);
  END LOOP;
END
$$;
