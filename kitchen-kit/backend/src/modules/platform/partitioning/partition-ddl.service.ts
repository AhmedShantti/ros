import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PartitionAdminConnectionService } from './partition-admin-connection.service';
import { PartitionedTableConfig } from './partitioned-table.registry';
import {
  YearMonth,
  partitionBounds,
  partitionTableName,
} from './partition-month';

/**
 * A single, fixed advisory-lock key for ALL partition DDL in this repository,
 * shared across every table this job maintains and every tenant's occurrence
 * of it. `hashtext` is a plain PostgreSQL builtin (no extension), and the key
 * is a literal string, never data — there is exactly one lock in the whole
 * system, and it is only ever held for the few milliseconds a single
 * partition's DDL takes.
 *
 * ── WHY A LOCK IS REQUIRED, NOT JUST `CREATE TABLE IF NOT EXISTS` ───────────
 * Verified empirically against a real PostgreSQL 16 before this was written:
 * two concurrent sessions both running `CREATE TABLE IF NOT EXISTS x
 * PARTITION OF parent FOR VALUES ...` for the SAME missing partition are NOT
 * both silently no-op'd. The loser fails with `ERROR: relation "x" already
 * exists` — `IF NOT EXISTS` only protects a session that starts AFTER the
 * other has committed, not a session racing it. This job's occurrence runs
 * once per TENANT per tick (§ the job's own docblock), so without
 * serialisation, N tenants whose occurrences are claimed in the same tick
 * would race exactly this way in production. The fix, also verified: acquire
 * `pg_advisory_xact_lock` FIRST, THEN re-check existence, THEN create — two
 * concurrent transactions doing this in that order both succeed, and exactly
 * one partition results.
 */
const PARTITION_LOCK_KEY = `SELECT pg_advisory_xact_lock(hashtext('platform.partition_lifecycle'))`;

export type PartitionCreationOutcome = 'created' | 'already_existed';

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function qualifiedName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * PostgreSQL's `PREPARE`/extended-query parameter binding does not accept a
 * DDL utility statement as its target at all (`CREATE TABLE ... PARTITION OF
 * ... FOR VALUES FROM ($1) TO ($2)` fails with a plain syntax error under
 * `PREPARE`, verified against a real PostgreSQL 16) — a partition bound must
 * be a literal the parser can evaluate, not a runtime parameter. Bounds are
 * therefore built as quoted SQL string literals instead of `$n` placeholders.
 * This is safe against injection specifically because a bound's only origin
 * is `partitionBounds()`, which derives it from integer year/month arithmetic
 * (see `partition-month.ts`) — it is never tenant input, request input, or
 * anything else this job reads from outside its own code.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Executes the exact, deterministic DDL sequence for one partition, against
 * the elevated `ros_partition_admin` connection ONLY. Every statement here is
 * idempotent by construction (re-running it against an already-fully-formed
 * partition is a documented no-op), and the whole sequence for one partition
 * runs inside ONE transaction so a partition is never left half-configured —
 * present but missing RLS, or missing a grant `ros_app` needs to write into
 * it.
 */
@Injectable()
export class PartitionDdlService {
  private readonly logger = new Logger(PartitionDdlService.name);

  constructor(private readonly admin: PartitionAdminConnectionService) {}

  /** `to_regclass` is the standard, catalog-only existence check: it costs a
   * syscache lookup, never a scan of the table's own rows. Used both for the
   * cheap "is anything even missing" pre-check (no lock needed to just read)
   * and, inside `ensurePartition`, for the lock-guarded re-check. */
  async partitionExists(
    client: PoolClient,
    schema: string,
    partitionTable: string,
  ): Promise<boolean> {
    const result = await client.query<{ exists: string | null }>(
      'SELECT to_regclass($1)::text AS exists',
      [`${schema}.${partitionTable}`],
    );
    return result.rows[0]?.exists != null;
  }

  /**
   * Ensure exactly one partition exists for `table` covering `ym`, complete
   * with RLS and the `ros_app` grants — or determine that it already did.
   *
   * Throws on any unexpected DDL failure (permission error, disk full, a
   * malformed bound) rather than swallowing it: the caller (the job's
   * `detect`) is responsible for turning that into a durable finding, and a
   * throw here must never look like success.
   */
  async ensurePartition(
    table: PartitionedTableConfig,
    ym: YearMonth,
  ): Promise<PartitionCreationOutcome> {
    const partitionName = partitionTableName(table.table, ym);
    const bounds = partitionBounds(ym);

    return this.admin.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        // Locked FIRST: nothing below observes or mutates catalog state for
        // this key until this session holds it. Released automatically at
        // COMMIT/ROLLBACK (xact-scoped), so a crash mid-transaction can never
        // leave the lock held.
        await client.query(PARTITION_LOCK_KEY);

        if (await this.partitionExists(client, table.schema, partitionName)) {
          await client.query('COMMIT');
          return 'already_existed';
        }

        const qualifiedPartition = qualifiedName(table.schema, partitionName);
        const qualifiedParent = qualifiedName(table.schema, table.table);

        await client.query(
          `CREATE TABLE IF NOT EXISTS ${qualifiedPartition} PARTITION OF ${qualifiedParent} ` +
            `FOR VALUES FROM (${quoteLiteral(bounds.from)}) TO (${quoteLiteral(bounds.to)})`,
        );

        await client.query(
          `ALTER TABLE ${qualifiedPartition} ENABLE ROW LEVEL SECURITY`,
        );
        await client.query(
          `ALTER TABLE ${qualifiedPartition} FORCE ROW LEVEL SECURITY`,
        );

        await this.applyPolicies(client, table, qualifiedPartition);
        await this.applyGrants(client, table, qualifiedPartition);

        await client.query('COMMIT');
        this.logger.log(
          `Created partition ${table.schema}.${partitionName} for ${table.schema}.${table.table}.`,
        );
        return 'created';
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  private async applyPolicies(
    client: PoolClient,
    table: PartitionedTableConfig,
    qualifiedPartition: string,
  ): Promise<void> {
    const prefix = table.policyNamePrefix;
    const tenantPredicate =
      "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid";

    const dropCreate = async (name: string, command: string): Promise<void> => {
      await client.query(
        `DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${qualifiedPartition}`,
      );
      await client.query(command);
    };

    await dropCreate(
      `${prefix}_select`,
      `CREATE POLICY ${quoteIdent(`${prefix}_select`)} ON ${qualifiedPartition} FOR SELECT ` +
        `USING (${tenantPredicate})`,
    );
    await dropCreate(
      `${prefix}_insert`,
      `CREATE POLICY ${quoteIdent(`${prefix}_insert`)} ON ${qualifiedPartition} FOR INSERT ` +
        `WITH CHECK (${tenantPredicate})`,
    );

    if (table.rlsShape === 'full_dml') {
      await dropCreate(
        `${prefix}_update`,
        `CREATE POLICY ${quoteIdent(`${prefix}_update`)} ON ${qualifiedPartition} FOR UPDATE ` +
          `USING (${tenantPredicate}) WITH CHECK (${tenantPredicate})`,
      );
      await dropCreate(
        `${prefix}_delete`,
        `CREATE POLICY ${quoteIdent(`${prefix}_delete`)} ON ${qualifiedPartition} FOR DELETE ` +
          `USING (${tenantPredicate})`,
      );
    }
  }

  private async applyGrants(
    client: PoolClient,
    table: PartitionedTableConfig,
    qualifiedPartition: string,
  ): Promise<void> {
    if (table.rlsShape === 'append_only') {
      // Mirrors `inventory.stock_movements`'s own parent-table grant exactly:
      // an append-only ledger partition may be read and inserted into, never
      // updated, deleted, or truncated, by the runtime role.
      await client.query(
        `GRANT SELECT, INSERT ON ${qualifiedPartition} TO ros_app`,
      );
      await client.query(
        `REVOKE UPDATE, DELETE, TRUNCATE ON ${qualifiedPartition} FROM ros_app`,
      );
    } else {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${qualifiedPartition} TO ros_app`,
      );
    }
  }
}
