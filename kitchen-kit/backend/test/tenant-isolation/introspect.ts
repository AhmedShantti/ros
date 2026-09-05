import type { Pool } from 'pg';

/**
 * FR-PLT-013/014 — all discovery in this module is information_schema /
 * pg_catalog driven. Nothing here enumerates a hardcoded table list: a table
 * with a `tenant_id` column becomes visible to the generated suites purely by
 * existing in the catalog at the time CI runs.
 */

export interface TenantTable {
  schema: string;
  table: string;
  key: string; // "schema.table"
  relkind: 'r' | 'p';
  isPartition: boolean;
  rowSecurityEnabled: boolean;
  rowSecurityForced: boolean;
  policyCount: number;
}

interface TenantTableRow {
  schema: string;
  table: string;
  relkind: 'r' | 'p';
  is_partition: boolean;
  row_security_enabled: boolean;
  row_security_forced: boolean;
  policy_count: number;
}

const SYSTEM_SCHEMA_FILTER = `
  AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
  AND c.table_schema NOT LIKE 'pg\\_%'
`;

/** Every table (root tables and partitions) with a tenant_id column, plus its
 * live RLS flags/policy count — the full FR-PLT-014 input set. */
export async function discoverAllTenantTables(
  pool: Pool,
): Promise<TenantTable[]> {
  const { rows } = await pool.query<TenantTableRow>(`
    SELECT
      c.table_schema AS schema,
      c.table_name AS "table",
      cl.relkind AS relkind,
      cl.relispartition AS is_partition,
      cl.relrowsecurity AS row_security_enabled,
      cl.relforcerowsecurity AS row_security_forced,
      (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = cl.oid) AS policy_count
    FROM information_schema.columns c
    JOIN pg_catalog.pg_class cl
      ON cl.relname = c.table_name
    JOIN pg_catalog.pg_namespace n
      ON n.oid = cl.relnamespace AND n.nspname = c.table_schema
    WHERE c.column_name = 'tenant_id'
      AND cl.relkind IN ('r', 'p')
      ${SYSTEM_SCHEMA_FILTER}
    ORDER BY 1, 2;
  `);
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    key: `${r.schema}.${r.table}`,
    relkind: r.relkind,
    isPartition: r.is_partition,
    rowSecurityEnabled: r.row_security_enabled,
    rowSecurityForced: r.row_security_forced,
    policyCount: r.policy_count,
  }));
}

/** Root (non-partition) tenant tables only — the logical DML surface FR-PLT-013
 * proves isolation for. Partition children mirror their parent's RLS/policies
 * automatically (verified: ALTER ... ENABLE/FORCE ROW LEVEL SECURITY on a
 * partitioned parent cascades to every partition) and are never queried
 * directly by the application, so per-partition DML proof would be redundant
 * with the parent while adding nothing — the parent is the entire logical
 * surface. FR-PLT-014's flag/policy gate still checks every partition
 * individually (see discoverAllTenantTables), since that is pure metadata and
 * catches a misconfigured partition the cascade didn't reach.
 */
export function rootTenantTables(all: TenantTable[]): TenantTable[] {
  return all.filter((t) => !t.isPartition);
}

export interface ColumnInfo {
  name: string;
  isNullable: boolean;
  hasDefault: boolean;
  dataType: string; // information_schema.columns.data_type
  udtName: string; // e.g. 'uuid', 'varchar', 'numeric', or the enum type name
  charMaxLength: number | null;
  isIdentity: boolean;
}

interface ColumnInfoRow {
  column_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  is_identity: 'YES' | 'NO';
}

export async function getColumns(
  pool: Pool,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const { rows } = await pool.query<ColumnInfoRow>(
    `
    SELECT column_name, is_nullable, column_default, data_type, udt_name,
           character_maximum_length, is_identity
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position;
  `,
    [schema, table],
  );
  return rows.map((r) => ({
    name: r.column_name,
    isNullable: r.is_nullable === 'YES',
    hasDefault: r.column_default !== null || r.is_identity === 'YES',
    dataType: r.data_type,
    udtName: r.udt_name,
    charMaxLength: r.character_maximum_length,
    isIdentity: r.is_identity === 'YES',
  }));
}

export interface ForeignKey {
  constraintName: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

interface ForeignKeyRow {
  constraint_name: string;
  cols: string[];
  ref_schema: string;
  ref_table: string;
  ref_cols: string[];
}

/** FKs whose *source* table is the given (schema, table). Partition-local
 * duplicate constraint rows are deduplicated by (columns, ref) shape, and a
 * ref table that is itself a partition is resolved to its partitioned root
 * (Postgres sometimes reports the partition's own oid as confrelid for
 * per-partition copies of an inherited FK). */
export async function getForeignKeys(
  pool: Pool,
  schema: string,
  table: string,
): Promise<ForeignKey[]> {
  const { rows } = await pool.query<ForeignKeyRow>(
    `
    SELECT
      con.conname AS constraint_name,
      array_agg(a.attname::text ORDER BY u.ord) AS cols,
      fn.nspname AS ref_schema,
      COALESCE(root.relname, fc.relname) AS ref_table,
      array_agg(fa.attname::text ORDER BY u.ord) AS ref_cols
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_class fc ON fc.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    LEFT JOIN pg_inherits inh ON inh.inhrelid = fc.oid
    LEFT JOIN pg_class root ON root.oid = inh.inhparent
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fu(attnum, ord) ON fu.ord = u.ord
    JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = fu.attnum
    WHERE con.contype = 'f' AND cn.nspname = $1 AND c.relname = $2
    GROUP BY con.conname, fn.nspname, COALESCE(root.relname, fc.relname)
    ORDER BY 1;
  `,
    [schema, table],
  );
  const seen = new Set<string>();
  const out: ForeignKey[] = [];
  for (const r of rows) {
    const shape = `${r.cols.join(',')}=>${r.ref_schema}.${r.ref_table}(${r.ref_cols.join(',')})`;
    if (seen.has(shape)) continue;
    seen.add(shape);
    out.push({
      constraintName: r.constraint_name,
      columns: r.cols,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumns: r.ref_cols,
    });
  }
  return out;
}

export async function getPrimaryKeyColumns(
  pool: Pool,
  schema: string,
  table: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ col: string }>(
    `
    SELECT a.attname::text AS col
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
    WHERE con.contype = 'p' AND cn.nspname = $1 AND c.relname = $2
    ORDER BY u.ord;
  `,
    [schema, table],
  );
  return rows.map((r) => r.col);
}

const enumCache = new Map<string, string[]>();

export async function getEnumValues(
  pool: Pool,
  udtName: string,
): Promise<string[]> {
  if (enumCache.has(udtName)) return enumCache.get(udtName) as string[];
  const { rows } = await pool.query<{ label: string }>(
    `
    SELECT e.enumlabel AS label
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = $1
    ORDER BY e.enumsortorder;
  `,
    [udtName],
  );
  const values = rows.map((r) => r.label);
  enumCache.set(udtName, values);
  return values;
}
