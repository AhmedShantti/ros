import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

/**
 * The ONE connection in this codebase authenticated as anything other than
 * `ros_app` at runtime. Exists for exactly one reason, stated precisely:
 *
 * ── WHY A SECOND CONNECTION EXISTS AT ALL ───────────────────────────────────
 * Creating a partition (`CREATE TABLE ... PARTITION OF ...`) is schema DDL,
 * and PostgreSQL requires the executing role to OWN the parent table — CREATE
 * privilege on the schema alone is not sufficient (verified empirically
 * against a real PostgreSQL 16 before this was written: a role with schema
 * CREATE but not parent ownership is refused with `must be owner of table`).
 * `ros_app`, the ONLY role the running application authenticates as
 * everywhere else, is deliberately `NOSUPERUSER`/`NOBYPASSRLS` and holds DML
 * privileges ONLY (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) — every migration in
 * this repository grants it exactly that and never `CREATE`. Widening
 * `ros_app` itself to own domain tables would hand DDL power (add/drop a
 * column, drop a constraint, `TRUNCATE` via ownership) to the same role every
 * tenant-scoped HTTP request already authenticates as — a real increase in
 * blast radius for any request-path defect, and the opposite of this
 * repository's existing least-privilege posture.
 *
 * Instead: a NEW role, `ros_partition_admin`, owns exactly the three
 * partitioned parent tables this job maintains (see the accompanying
 * migration) and nothing else — no other table, no DML grant of its own (it
 * does not need to read or write a row; it only creates partitions and then
 * GRANTs the ordinary DML privileges to `ros_app` on each one, which
 * PostgreSQL allows any owner to do without holding those privileges itself).
 * It is `NOSUPERUSER`/`NOCREATEDB`/`NOCREATEROLE`/`NOBYPASSRLS` — the same
 * posture as `ros_app` — and is never given a route, a controller, or any
 * reachable path outside this one job.
 *
 * ── WHY DDL CANNOT USE THE SUBSTRATE'S OWN TRANSACTION ──────────────────────
 * `ScheduledJobHandler.commit(tx, ...)` hands a handler the SAME connection
 * `PrismaService` uses everywhere else — i.e. `ros_app`, under
 * `withAuthContext`. That connection cannot run this job's DDL regardless of
 * design choice, which is why `PartitionLifecycleJob` performs its real work
 * in `detect()` against THIS service instead of in `commit()` — see that
 * job's own docblock for the full accounting of what that costs.
 *
 * ── WHAT THIS CONNECTION IS NOT ─────────────────────────────────────────────
 * It never runs a tenant-scoped query, never sets `app.tenant_id`, and is
 * never handed to any code outside `PartitionDdlService`. RLS is irrelevant to
 * it either way (DDL is not subject to row security), and it is not a
 * shortcut around RLS for anything else — it cannot even SELECT a domain row,
 * because it holds no DML grant on any table.
 */
@Injectable()
export class PartitionAdminConnectionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PartitionAdminConnectionService.name);
  private pool: Pool | undefined;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.pool = new Pool({
      connectionString: this.config.getOrThrow<string>(
        'PARTITION_ADMIN_DATABASE_URL',
      ),
      // Small and bounded: this connection serves one low-frequency
      // maintenance job, never a request path. A handful of connections is
      // enough to let two ticks overlap without one blocking the other on
      // pool exhaustion.
      max: 3,
    });
    this.logger.log(
      'Partition admin connection pool ready (ros_partition_admin / DDL-only, no DML grant).',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /** Run `fn` with a single checked-out client, always released. Callers that
   * need a transaction call `client.query('BEGIN'/'COMMIT'/'ROLLBACK')`
   * themselves — kept explicit here rather than wrapped, because
   * `PartitionDdlService` needs the advisory lock and the transaction to
   * share exactly one session, and a thin passthrough is easier to audit than
   * a second transaction helper duplicating `PrismaService.withAuthContext`. */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error(
        'PartitionAdminConnectionService used before onModuleInit.',
      );
    }
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
}
