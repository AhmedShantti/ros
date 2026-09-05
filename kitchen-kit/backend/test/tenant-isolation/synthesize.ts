import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  getColumns,
  getEnumValues,
  getForeignKeys,
  getPrimaryKeyColumns,
  type ColumnInfo,
} from './introspect';

/**
 * Generic, schema-driven fixture synthesis for FR-PLT-013.
 *
 * For a table with no domain-specific CHECK/EXCLUDE constraints, a minimal
 * valid row can be built purely from catalog metadata: resolve every
 * NOT-NULL foreign key to a (recursively synthesized) parent row, and fill
 * every other NOT-NULL, no-default column with a type-appropriate synthetic
 * value. This covers the majority of tenant tables automatically (verified:
 * 50/83 at the time fixture-overrides.ts was written).
 *
 * Tables whose CHECK/EXCLUDE constraints reject that generic shape (XOR
 * selectors, state-consistency invariants, regex-constrained codes,
 * arithmetic identities, non-overlap ranges, ...) are NOT silently skipped:
 * `fixture-overrides.ts` supplies an explicit column-value override for
 * exactly the columns the generic pass gets wrong, and the harness fails
 * loudly (see generated-cross-tenant.e2e-spec.ts) if a discovered table has
 * neither a working generic shape nor a registry entry.
 */

export interface RowContext {
  tenantId: string;
  seq: number;
  client: PoolClient;
  /** Resolve (recursively synthesizing if necessary) a fixture row this
   * override depends on, e.g. a parent the generic pass would only reach via
   * a nullable FK it correctly declines to auto-resolve. */
  resolve: (schema: string, table: string) => Promise<Record<string, unknown>>;
}

export interface RowOverride {
  /** schema.table this override applies to. */
  key: string;
  /** Human-readable justification: which CHECK/EXCLUDE constraint(s) the
   * generic pass cannot satisfy and why. Checked for non-emptiness by the
   * suite itself (generated-cross-tenant.e2e-spec.ts) so an override can
   * never be silently blank. */
  reason: string;
  /** Explicit values for specific columns, overriding the generic synthesis
   * for exactly those columns. Other columns (FKs, everything else) are
   * still resolved generically. */
  columns: (
    ctx: RowContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** A table this suite structurally cannot exercise with direct DML — the
 * registry entry function is never called; `reason` must explain why no
 * direct-insert fixture is possible for the table at all (not just "the
 * generic pass fails", which is what RowOverride.columns is for). */
export interface DmlImpossible {
  key: string;
  reason: string;
}

const memoCache = new Map<string, Record<string, unknown>>();

export function resetSynthesisMemo(): void {
  memoCache.clear();
}

/** Prime the memo cache with an already-created row (e.g. the tenant fixture
 * itself, created explicitly in beforeAll with id === tenantId) so recursive
 * FK resolution returns it instead of trying to synthesize a fresh one. */
export function seedSynthesisMemo(
  schema: string,
  table: string,
  tenantId: string,
  row: Record<string, unknown>,
): void {
  memoCache.set(`${schema}.${table}::${tenantId}`, row);
}

/** Evict exactly one memoized (table, tenant) row so the next synthesizeRow
 * call for it creates a genuinely fresh row instead of returning the cached
 * one — used to get a second, independent tenant-B fixture for the DELETE
 * assertion (see generated-cross-tenant.e2e-spec.ts) without invalidating
 * any other table's already-memoized parents. */
export function forgetSynthesisMemo(
  schema: string,
  table: string,
  tenantId: string,
): void {
  memoCache.delete(`${schema}.${table}::${tenantId}`);
}

/** Diagnostics/test-harness only: snapshot and selectively evict memo keys so
 * a driver that retries around a savepoint rollback doesn't keep serving a
 * row that the database rollback just discarded. */
export function memoCacheKeySnapshot(): Set<string> {
  return new Set(memoCache.keys());
}
export function evictMemoCacheKeysNotIn(keep: Set<string>): void {
  for (const k of [...memoCache.keys()]) {
    if (!keep.has(k)) memoCache.delete(k);
  }
}

export interface LoggedInsert {
  schema: string;
  table: string;
  primaryKey: Record<string, unknown>;
}

let insertLog: LoggedInsert[] = [];

/** Every row synthesizeRow has INSERTed, in insertion (= dependency) order —
 * parents always precede the children whose FKs point at them. Consumers
 * that need to tear a run's fixtures back down should DELETE in reverse of
 * this order, which is then correct regardless of each FK's ON DELETE policy
 * (identity.tenants' own FKs are a RESTRICT/CASCADE mix — see
 * generated-cross-tenant.e2e-spec.ts's afterAll). */
export function getInsertLog(): readonly LoggedInsert[] {
  return insertLog;
}
export function clearInsertLog(): void {
  insertLog = [];
}

let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function syntheticScalar(
  col: ColumnInfo,
  seq: number,
  enumValues: Map<string, string[]>,
): unknown {
  if (col.dataType === 'USER-DEFINED') {
    const values = enumValues.get(col.udtName);
    if (values && values.length > 0) return values[0];
    throw new Error(
      `syntheticScalar: enum type "${col.udtName}" has no known values ` +
        `(introspection gap, not a domain gap) — add a fixture-overrides.ts entry.`,
    );
  }
  switch (col.udtName) {
    case 'uuid':
      return randomUUID();
    case 'bool':
      return false;
    case 'int2':
    case 'int4':
    case 'int8':
      return 1;
    case 'numeric':
    case 'float4':
    case 'float8':
      return 1;
    case 'text':
    case 'varchar':
    case 'bpchar': {
      const raw = `fx${seq}`;
      return col.charMaxLength ? raw.slice(0, col.charMaxLength) : raw;
    }
    case 'timestamptz':
    case 'timestamp':
      return new Date();
    case 'date':
      return new Date();
    case 'jsonb':
    case 'json':
      return {};
    case 'bytea':
      return Buffer.from('fx');
    default:
      throw new Error(
        `syntheticScalar: no generic strategy for udt_name="${col.udtName}" ` +
          `(data_type="${col.dataType}"). Add a fixture-overrides.ts entry.`,
      );
  }
}

/**
 * Build (and INSERT, via the migrator connection which bypasses RLS as
 * table owner) a minimal valid row for `schema.table` owned by `tenantId`.
 * Recursively resolves every required foreign key first. Rows are memoized
 * per (table, tenantId) so a shared parent is created once, not once per
 * child that references it.
 */
export async function synthesizeRow(
  pool: Pool,
  client: PoolClient,
  schema: string,
  table: string,
  tenantId: string,
  overrides: Map<string, RowOverride>,
  inProgress: Set<string> = new Set(),
): Promise<Record<string, unknown>> {
  const key = `${schema}.${table}`;
  const memoKey = `${key}::${tenantId}`;
  const cached = memoCache.get(memoKey);
  if (cached) return cached;
  if (inProgress.has(memoKey)) {
    throw new Error(
      `synthesizeRow: required-FK cycle detected reaching ${key} again via ` +
        `[${[...inProgress].join(' -> ')}] -> ${key}. Add a fixture-overrides.ts ` +
        `entry that breaks the cycle (e.g. by supplying the column directly ` +
        `instead of relying on generic FK resolution).`,
    );
  }
  inProgress.add(memoKey);
  try {
    return await synthesizeRowUncached(
      pool,
      client,
      schema,
      table,
      tenantId,
      overrides,
      inProgress,
      key,
      memoKey,
    );
  } finally {
    inProgress.delete(memoKey);
  }
}

export interface BuiltRowValues {
  values: Record<string, unknown>;
  pkCols: string[];
}

/**
 * Compute (without inserting) a valid column-value map for a fresh
 * `schema.table` row owned by `tenantId` — the same generic-FK + override
 * logic `synthesizeRow` uses, minus the final INSERT. Required FK *parents*
 * are still recursively synthesized-and-inserted for real (via `client`,
 * bypassing RLS as migrator) since they must genuinely exist; only the
 * top-level table's own row is left uninserted, so a caller can INSERT it
 * itself through a different (e.g. RLS-constrained ros_app) connection —
 * used by generated-cross-tenant.e2e-spec.ts's INSERT-spoof assertion, which
 * needs a fully valid, uniquely-keyed tenant-B-owned row to attempt inserting
 * while running as tenant A, so any rejection is attributable to RLS alone.
 */
export async function buildRowValues(
  pool: Pool,
  client: PoolClient,
  schema: string,
  table: string,
  tenantId: string,
  overrides: Map<string, RowOverride>,
  inProgress: Set<string> = new Set(),
): Promise<BuiltRowValues> {
  const key = `${schema}.${table}`;
  const [columns, fks, pkCols] = await Promise.all([
    getColumns(pool, schema, table),
    getForeignKeys(pool, schema, table),
    getPrimaryKeyColumns(pool, schema, table),
  ]);

  const seq = nextSeq();
  const values: Record<string, unknown> = {};
  const enumValues = new Map<string, string[]>();
  for (const col of columns) {
    if (col.dataType === 'USER-DEFINED' && !enumValues.has(col.udtName)) {
      enumValues.set(col.udtName, await getEnumValues(pool, col.udtName));
    }
  }

  // Resolve required FKs first, recursively. A multi-column FK under
  // Postgres's default MATCH SIMPLE is only enforced when EVERY one of its
  // columns is non-NULL — so it is only "required" (must resolve a parent)
  // when every column in it is itself NOT NULL with no default; if even one
  // column (typically the business FK, not tenant_id) is nullable, leaving
  // it NULL validly skips the whole constraint and this table needs no
  // parent row for it (this is also what breaks a self-referential
  // "parent_x_id" hierarchy column out of looking like a required cycle).
  for (const fk of fks) {
    const allRequired = fk.columns.every((c) => {
      const col = columns.find((cc) => cc.name === c);
      return col && !col.isNullable && !col.hasDefault;
    });
    if (!allRequired) continue; // at least one column can be left NULL — skip
    const parentRow = await synthesizeRow(
      pool,
      client,
      fk.refSchema,
      fk.refTable,
      tenantId,
      overrides,
      inProgress,
    );
    fk.columns.forEach((localCol, i) => {
      const refCol = fk.refColumns[i];
      values[localCol] = parentRow[refCol];
    });
  }

  // Explicit override for this table, if any: computed after FK resolution
  // above so an override can still rely on plain generic FK plumbing and
  // only patch the columns that actually need it.
  const override = overrides.get(key);
  let overrideValues: Record<string, unknown> = {};
  if (override) {
    const resolve = (rSchema: string, rTable: string) =>
      synthesizeRow(
        pool,
        client,
        rSchema,
        rTable,
        tenantId,
        overrides,
        inProgress,
      );
    overrideValues = await override.columns({ tenantId, seq, client, resolve });
  }

  for (const col of columns) {
    if (col.name in overrideValues) {
      values[col.name] = overrideValues[col.name];
      continue;
    }
    if (col.name in values) continue; // already set by FK resolution
    if (col.name === 'tenant_id') {
      values[col.name] = tenantId;
      continue;
    }
    if (col.hasDefault) continue; // let the DB default apply
    if (col.isNullable) continue; // omit — NULL is valid and avoids unnecessary constraints
    if (col.name === 'id' && pkCols.length === 1 && pkCols[0] === 'id') {
      values[col.name] = randomUUID();
      continue;
    }
    values[col.name] = syntheticScalar(col, seq, enumValues);
  }

  return { values, pkCols };
}

async function synthesizeRowUncached(
  pool: Pool,
  client: PoolClient,
  schema: string,
  table: string,
  tenantId: string,
  overrides: Map<string, RowOverride>,
  inProgress: Set<string>,
  key: string,
  memoKey: string,
): Promise<Record<string, unknown>> {
  const { values, pkCols } = await buildRowValues(
    pool,
    client,
    schema,
    table,
    tenantId,
    overrides,
    inProgress,
  );

  const colNames = Object.keys(values);
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
  const quotedCols = colNames.map((c) => `"${c}"`).join(', ');
  const sql = `INSERT INTO "${schema}"."${table}" (${quotedCols}) VALUES (${placeholders}) RETURNING *`;
  let result: { rows: Record<string, unknown>[] };
  try {
    result = await client.query<Record<string, unknown>>(
      sql,
      Object.values(values),
    );
  } catch (err) {
    throw new Error(
      `synthesizeRow: generic INSERT failed for ${key}: ` +
        `${(err as Error).message}\nSQL: ${sql}\nVALUES: ${JSON.stringify(values)}`,
    );
  }
  const row = result.rows[0];
  memoCache.set(memoKey, row);
  const primaryKey: Record<string, unknown> = {};
  for (const c of pkCols) primaryKey[c] = row[c];
  insertLog.push({ schema, table, primaryKey });
  return row;
}

/** `WHERE "a" = $1 AND "b" = $2` (+ matching param array) for a primary-key
 * object, in a stable column order. Used identically by the isolation
 * assertions and by fixture teardown. */
export function pkWhereClause(pk: Record<string, unknown>): {
  sql: string;
  params: unknown[];
} {
  const cols = Object.keys(pk);
  if (cols.length === 0) throw new Error('pkWhereClause: empty primary key');
  const sql = cols.map((c, i) => `"${c}" = $${i + 1}`).join(' AND ');
  const params = cols.map((c) => pk[c]);
  return { sql, params };
}

export async function primaryKeyOf(
  pool: Pool,
  schema: string,
  table: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pkCols = await getPrimaryKeyColumns(pool, schema, table);
  const pk: Record<string, unknown> = {};
  for (const c of pkCols) pk[c] = row[c];
  return pk;
}

export { getEnumValues };
