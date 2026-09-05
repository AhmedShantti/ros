import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import {
  discoverAllTenantTables,
  rootTenantTables,
  type TenantTable,
} from './introspect';
import {
  synthesizeRow,
  buildRowValues,
  resetSynthesisMemo,
  seedSynthesisMemo,
  primaryKeyOf,
  pkWhereClause,
  getInsertLog,
  clearInsertLog,
  type RowOverride,
} from './synthesize';
import { FIXTURE_OVERRIDES, DML_IMPOSSIBLE } from './fixture-overrides';

/**
 * FR-PLT-013 — "The CI pipeline SHALL execute a cross-tenant isolation test
 * suite that, for every table containing tenant_id, attempts to read and
 * write records belonging to Tenant B while the session context is Tenant A,
 * and fails the build on any success. This suite is generated, not
 * hand-written — it enumerates tables from the information schema so that a
 * newly added table without a policy fails the build automatically."
 *
 * Architecture (see introspect.ts / synthesize.ts / fixture-overrides.ts):
 *  1. discoverAllTenantTables/rootTenantTables — information_schema/pg_catalog
 *     driven table discovery, no hardcoded list.
 *  2. synthesizeRow — generic FK-graph + type-driven fixture synthesis,
 *     works unmodified for the majority of tables (50/83 at authoring time).
 *  3. fixture-overrides.ts — an explicit, reasoned registry entry for every
 *     table the generic pass cannot satisfy (CHECK/EXCLUDE constraints);
 *     `coverage is exhaustive` below fails loudly if a discovered table has
 *     neither a working generic shape nor a registry entry, so a new
 *     structurally-hard table cannot silently skip isolation proof.
 *  4. This file: seeds a Tenant A and Tenant B row for every table (via the
 *     migrator connection, which bypasses RLS as table owner — arrangement
 *     only, never evidence), then proves SELECT/UPDATE/DELETE/INSERT
 *     isolation exclusively through the RLS-constrained ros_app connection.
 */

jest.setTimeout(180_000); // seeds + asserts against ~85 tables; default 30s is too tight on a loaded CI runner

async function withAppTenantContext<T>(
  appPool: Pool,
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`,
      [randomUUID(), tenantId],
    );
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

function isPermissionDenied(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === '42501';
}

/**
 * Proves all four FR-PLT-013 assertions for a single table and returns a
 * human-readable violation for each one that fails. The main sweep and the
 * sabotage tests below both call this exact function — a sabotage test that
 * reimplemented the assertions would only prove the reimplementation is
 * sensitive, not the gate.
 */
export async function checkTableIsolation(
  migratorPool: Pool,
  migrator: PoolClient,
  appPool: Pool,
  table: TenantTable,
  tenantA: string,
  tenantB: string,
  overrides: Map<string, RowOverride>,
): Promise<string[]> {
  const violations: string[] = [];
  const { schema, table: tbl, key } = table;

  const rowA = await synthesizeRow(
    migratorPool,
    migrator,
    schema,
    tbl,
    tenantA,
    overrides,
  );
  const rowB = await synthesizeRow(
    migratorPool,
    migrator,
    schema,
    tbl,
    tenantB,
    overrides,
  );
  const pkA = await primaryKeyOf(migratorPool, schema, tbl, rowA);
  const pkB = await primaryKeyOf(migratorPool, schema, tbl, rowB);
  const { sql: whereA, params: paramsA } = pkWhereClause(pkA);
  const { sql: whereB, params: paramsB } = pkWhereClause(pkB);

  // SELECT — Tenant A must not see Tenant B's row.
  const selB: QueryResult = await withAppTenantContext(appPool, tenantA, (c) =>
    c.query(`SELECT 1 FROM "${schema}"."${tbl}" WHERE ${whereB}`, paramsB),
  );
  if (selB.rowCount !== 0) {
    violations.push(
      `${key}: SELECT returned Tenant B's row under Tenant A context`,
    );
  }

  // Positive control — Tenant A must see its OWN row. Without this, a
  // suite-wide RLS misconfiguration that hides every row (e.g. a session
  // context that never gets set) would make every SELECT assertion above
  // pass vacuously.
  const selA: QueryResult = await withAppTenantContext(appPool, tenantA, (c) =>
    c.query(`SELECT 1 FROM "${schema}"."${tbl}" WHERE ${whereA}`, paramsA),
  );
  if (selA.rowCount !== 1) {
    violations.push(
      `${key}: POSITIVE CONTROL FAILED — Tenant A cannot see its own row (${selA.rowCount} rows; suite would pass vacuously)`,
    );
  }

  // UPDATE — Tenant A must not be able to modify Tenant B's row. A no-op
  // self-assignment of the first PK column is enough: it would succeed with
  // rowCount > 0 if RLS failed to filter the row, and is a valid statement
  // against every table regardless of its other columns. Any error (RLS's
  // WHERE-clause filtering isn't an error — a zero-row UPDATE succeeds with
  // rowCount 0; an *error* here means a GRANT-level REVOKE UPDATE, an
  // FK-RESTRICT, etc. — all equally valid "not modified" outcomes) is
  // accepted; only a clean, non-zero-rowcount success is a violation.
  const firstPkCol = Object.keys(pkB)[0];
  try {
    const upd: QueryResult = await withAppTenantContext(appPool, tenantA, (c) =>
      c.query(
        `UPDATE "${schema}"."${tbl}" SET "${firstPkCol}" = "${firstPkCol}" WHERE ${whereB}`,
        paramsB,
      ),
    );
    if (upd.rowCount !== 0) {
      violations.push(
        `${key}: UPDATE modified Tenant B's row under Tenant A context`,
      );
    }
  } catch (e) {
    if (!isPermissionDenied(e)) throw e; // an unexpected error class is still worth surfacing
  }

  // DELETE — Tenant A must not be able to delete Tenant B's row. Reuses the
  // same rowB (not a second synthesized row): a second row sharing rowB's
  // memoized parents can collide with a tenant-scoped UNIQUE constraint on
  // those same parents (e.g. catalogue.menu_branches' (tenant_id, menu_id,
  // branch_id)) for a reason that has nothing to do with RLS.
  try {
    const del: QueryResult = await withAppTenantContext(appPool, tenantA, (c) =>
      c.query(`DELETE FROM "${schema}"."${tbl}" WHERE ${whereB}`, paramsB),
    );
    if (del.rowCount !== 0) {
      violations.push(
        `${key}: DELETE removed Tenant B's row under Tenant A context`,
      );
    }
  } catch (e) {
    if (!isPermissionDenied(e)) throw e;
  }

  // INSERT — Tenant A must not be able to create a NEW row claiming Tenant B
  // ownership. The payload is a fresh, fully valid Tenant-B-shaped row (same
  // synthesis logic, unique PK, real FKs into Tenant B's own parents) so a
  // rejection is attributable to the tenant claim alone, not to some other
  // constraint the payload happens to violate.
  const { values: spoofValues } = await buildRowValues(
    migratorPool,
    migrator,
    schema,
    tbl,
    tenantB,
    overrides,
  );
  const cols = Object.keys(spoofValues);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const quotedCols = cols.map((c) => `"${c}"`).join(', ');
  let insertSucceeded = false;
  try {
    const ins: QueryResult = await withAppTenantContext(appPool, tenantA, (c) =>
      c.query(
        `INSERT INTO "${schema}"."${tbl}" (${quotedCols}) VALUES (${placeholders})`,
        Object.values(spoofValues),
      ),
    );
    insertSucceeded = (ins.rowCount ?? 0) > 0;
  } catch {
    insertSucceeded = false; // rejection (RLS WITH CHECK, or a GRANT denial) is the correct outcome
  }
  if (insertSucceeded) {
    violations.push(
      `${key}: INSERT created a row claiming Tenant B ownership under Tenant A context`,
    );
  }

  return violations;
}

describe('FR-PLT-013 — generated cross-tenant isolation suite (e2e)', () => {
  let migratorPool: Pool;
  let appPool: Pool;
  let migrator: PoolClient;
  let tenantA: string;
  let tenantB: string;
  let roots: TenantTable[];

  async function seedTenantRow(
    id: string,
    tag: string,
  ): Promise<Record<string, unknown>> {
    const r = await migrator.query<Record<string, unknown>>(
      `INSERT INTO identity.tenants
         (id, slug, legal_name, default_currency, country_pack_code, default_locale, created_at, updated_at)
       VALUES ($1, $2, 'FR-PLT-013 fixture tenant', 'EGP', 'EG', 'en', now(), now())
       RETURNING *`,
      [id, `fx-plt013-${tag}-${id.slice(0, 8)}`],
    );
    return r.rows[0];
  }

  beforeAll(async () => {
    migratorPool = new Pool({ connectionString: process.env.DATABASE_URL });
    appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
    migrator = await migratorPool.connect();

    const all = await discoverAllTenantTables(migratorPool);
    roots = rootTenantTables(all);

    tenantA = randomUUID();
    tenantB = randomUUID();
    resetSynthesisMemo();
    clearInsertLog();
    seedSynthesisMemo(
      'identity',
      'tenants',
      tenantA,
      await seedTenantRow(tenantA, 'a'),
    );
    seedSynthesisMemo(
      'identity',
      'tenants',
      tenantB,
      await seedTenantRow(tenantB, 'b'),
    );
  });

  afterAll(async () => {
    // Reverse of insertion order is always safe regardless of each FK's own
    // ON DELETE policy (identity.tenants' own FKs are a RESTRICT/CASCADE mix
    // — see docs/adr/0003-rls.md and the treasury.day_close* append-only
    // GRANT pattern) since every child was inserted strictly after the
    // parent(s) it depends on.
    for (const entry of [...getInsertLog()].reverse()) {
      const { sql, params } = pkWhereClause(entry.primaryKey);
      await migrator
        .query(
          `DELETE FROM "${entry.schema}"."${entry.table}" WHERE ${sql}`,
          params,
        )
        .catch(() => undefined); // already gone (e.g. a sabotage DELETE actually succeeded) is fine
    }
    await migrator.query(`DELETE FROM identity.tenants WHERE id = ANY($1)`, [
      [tenantA, tenantB],
    ]);

    migrator.release();
    await migratorPool.end();
    await appPool.end();
  });

  it('discovery actually finds root tenant tables (sanity: the suite is not vacuously passing)', () => {
    expect(roots.length).toBeGreaterThan(0);
  });

  it('coverage is exhaustive: every discovered root tenant table has a working generic shape, a registry override, or a documented DML_IMPOSSIBLE entry', async () => {
    const uncovered: string[] = [];
    for (const t of roots) {
      if (DML_IMPOSSIBLE.has(t.key)) continue;
      try {
        await synthesizeRow(
          migratorPool,
          migrator,
          t.schema,
          t.table,
          tenantA,
          FIXTURE_OVERRIDES,
        );
        await synthesizeRow(
          migratorPool,
          migrator,
          t.schema,
          t.table,
          tenantB,
          FIXTURE_OVERRIDES,
        );
      } catch (err) {
        uncovered.push(`${t.key}: ${(err as Error).message}`);
      }
    }
    // A table landing here means: no working generic shape, AND no
    // fixture-overrides.ts entry, AND no DML_IMPOSSIBLE entry. That is
    // exactly the "newly discovered tenant table has no fixture strategy"
    // case FR-PLT-013 requires to fail the build rather than silently skip.
    expect(uncovered).toEqual([]);
  });

  it('Tenant A cannot SELECT, UPDATE, DELETE, or INSERT Tenant B rows — for every discovered table', async () => {
    const violations: string[] = [];
    for (const t of roots) {
      if (DML_IMPOSSIBLE.has(t.key)) continue;
      violations.push(
        ...(await checkTableIsolation(
          migratorPool,
          migrator,
          appPool,
          t,
          tenantA,
          tenantB,
          FIXTURE_OVERRIDES,
        )),
      );
    }
    expect(violations).toEqual([]);
  });

  it('every DML_IMPOSSIBLE entry documents why (non-empty reason) — no table is silently skipped without explanation', () => {
    for (const [key, entry] of DML_IMPOSSIBLE) {
      expect([key, entry.reason.trim().length > 10]).toEqual([key, true]);
    }
  });

  describe('sabotage proof (disposable schema/table/policy, dropped after)', () => {
    const schema = `plt013_sabotage_${randomUUID().replace(/-/g, '_')}`;
    const table = 'broken_policy';
    const key = `${schema}.${table}`;

    beforeAll(async () => {
      // A tenant_id table whose policy is defective by construction — it
      // permits ANY row regardless of tenant_id, the exact class of bug
      // FR-PLT-013 exists to catch.
      await migrator.query(`CREATE SCHEMA "${schema}"`);
      await migrator.query(`GRANT USAGE ON SCHEMA "${schema}" TO ros_app`);
      await migrator.query(
        `CREATE TABLE "${schema}"."${table}" (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`,
      );
      await migrator.query(
        `ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`,
      );
      await migrator.query(
        `ALTER TABLE "${schema}"."${table}" FORCE ROW LEVEL SECURITY`,
      );
      await migrator.query(
        `CREATE POLICY broken_allow_all ON "${schema}"."${table}" USING (true) WITH CHECK (true)`,
      );
      await migrator.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${table}" TO ros_app`,
      );
    });

    afterAll(async () => {
      await migrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const leftover = await migrator.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
        [schema],
      );
      expect(leftover.rowCount).toBe(0); // 0 orphan scratch schemas/tables
    });

    it('the generated suite catches the defect: Tenant A CAN see Tenant B rows through the broken policy', async () => {
      const all = await discoverAllTenantTables(migratorPool);
      const sabotageTable = all.find((t) => t.key === key);
      expect(sabotageTable).toBeDefined();

      const violations = await checkTableIsolation(
        migratorPool,
        migrator,
        appPool,
        sabotageTable as TenantTable,
        tenantA,
        tenantB,
        new Map(), // no override needed — id/tenant_id only, generic synthesis suffices
      );
      // The broken "USING (true)" policy must produce at least the SELECT
      // leak; this assertion is inverted from every other test in this file
      // on purpose — proving the gate fails is the point of this block.
      expect(violations.length).toBeGreaterThan(0);
      expect(
        violations.some((v) => v.includes('SELECT returned Tenant B')),
      ).toBe(true);
    });
  });

  describe('sabotage proof: a table with no fixture strategy fails loudly rather than being silently skipped', () => {
    const schema = `plt013_sabotage_${randomUUID().replace(/-/g, '_')}`;
    const table = 'uncoverable';

    beforeAll(async () => {
      // A tenant_id table whose only non-default NOT NULL column is pinned
      // by a CHECK to a value the generic synthesizer cannot know to produce
      // — exactly the "structurally requires a fixture-builder registry
      // entry" case FR-PLT-013 requires the suite to fail on rather than
      // silently skip. No entry for this table exists in fixture-overrides.ts.
      await migrator.query(`CREATE SCHEMA "${schema}"`);
      await migrator.query(`GRANT USAGE ON SCHEMA "${schema}" TO ros_app`);
      await migrator.query(
        `CREATE TABLE "${schema}"."${table}" (
           id uuid PRIMARY KEY,
           tenant_id uuid NOT NULL,
           magic_code text NOT NULL,
           CONSTRAINT ck_magic_code CHECK (magic_code = 'the-only-legal-value')
         )`,
      );
      await migrator.query(
        `ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`,
      );
      await migrator.query(
        `ALTER TABLE "${schema}"."${table}" FORCE ROW LEVEL SECURITY`,
      );
      await migrator.query(
        `CREATE POLICY p ON "${schema}"."${table}" USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
      );
    });

    afterAll(async () => {
      await migrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const leftover = await migrator.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
        [schema],
      );
      expect(leftover.rowCount).toBe(0); // 0 orphan scratch schemas/tables
    });

    it('generic synthesis (no registry entry) throws instead of producing an invalid or silently-skipped fixture', async () => {
      await expect(
        synthesizeRow(
          migratorPool,
          migrator,
          schema,
          table,
          tenantA,
          FIXTURE_OVERRIDES,
        ),
      ).rejects.toThrow(/generic INSERT failed/);
      // This is exactly what the real "coverage is exhaustive" test above
      // would surface as a listed failure for this table, had it been
      // discovered without a fixture-overrides.ts entry — proven here in
      // isolation so it cannot fail the real suite it is a sabotage proof for.
    });
  });
});
