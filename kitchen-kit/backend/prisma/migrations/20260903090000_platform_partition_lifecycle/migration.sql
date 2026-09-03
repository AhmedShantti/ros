-- FR-DR-002 — grant the FR-DR-002 partition-lifecycle job the narrow DDL
-- authority it needs, and nothing more.
--
-- WHY A SECOND ROLE, NOT A WIDER GRANT TO ros_app:
--   Attaching a partition (`CREATE TABLE ... PARTITION OF parent ...`)
--   requires OWNERSHIP of the parent table — verified empirically against a
--   real PostgreSQL 16 before this migration was written: a role with only
--   `CREATE` on the schema is refused with `must be owner of table`. `ros_app`
--   is the ONLY role the running application authenticates as everywhere
--   else, and every migration in this repository grants it DML
--   (SELECT/INSERT/UPDATE/DELETE) only, never CREATE or ownership. Widening
--   it here would hand DDL power (ALTER/DROP/TRUNCATE-via-ownership) to the
--   same role every tenant-scoped HTTP request already authenticates as.
--
--   `ros_partition_admin` is created OUT-OF-BAND, the same way `ros_app`
--   itself is (see docker/postgres/init/02-init-partition-admin-role.sh for
--   local dev, test/e2e-db-isolation/provision.ts for the e2e harness): no
--   migration in this repository has ever created a LOGIN role with a
--   password, because a migration file cannot carry one. This migration only
--   grants privileges to a role that is assumed to already exist by the time
--   it runs — exactly the same assumption every prior migration's
--   `GRANT ... TO ros_app` already makes about `ros_app`.
--
--   It holds NO DML privilege of its own: it does not need to read or write a
--   row, only to create a partition and then GRANT the ordinary DML
--   privileges to `ros_app` on it — which PostgreSQL allows any table's owner
--   to do without holding those privileges itself.
--
-- Existing partitions (stock_movements_2026_08 etc.) are NOT re-owned: only
-- attaching a NEW partition needs the parent's ownership; nothing here reads,
-- writes, or alters an existing partition or its data.

GRANT USAGE, CREATE ON SCHEMA "inventory" TO ros_partition_admin;
GRANT USAGE, CREATE ON SCHEMA "sales" TO ros_partition_admin;

ALTER TABLE "inventory"."stock_movements" OWNER TO ros_partition_admin;
ALTER TABLE "sales"."orders" OWNER TO ros_partition_admin;
ALTER TABLE "sales"."order_lines" OWNER TO ros_partition_admin;
