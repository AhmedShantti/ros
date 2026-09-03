import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { discoverAllTenantTables, type TenantTable } from './introspect';

/**
 * FR-PLT-014 — "The CI pipeline SHALL fail if any table with a tenant_id
 * column lacks an enabled and forced RLS policy."
 *
 * Fully catalog-driven (see introspect.ts's discoverAllTenantTables): no
 * hardcoded table list, so a newly added tenant_id table is covered the
 * moment it exists in the schema CI migrates against — the opposite of an
 * allowlist. Every table AND partition returned by discovery is checked
 * (unlike the DML suite in generated-cross-tenant.e2e-spec.ts, which only
 * exercises root/logical tables — this gate is pure metadata, so checking
 * partitions too is free and catches a partition RLS didn't cascade to).
 */

const FORCE_EXEMPTIONS: Record<string, string> = {
  // ADR-0003 (docs/adr/0003-rls.md, Accepted 2026-08-12): identity.roles has
  // a NULLABLE tenant_id (NULL = platform/system role, shared across
  // tenants). ENABLE alone already fully protects ros_app: ros_app is not
  // the table owner, and RLS applies to every non-owner role regardless of
  // FORCE — FORCE only changes enforcement against the *owner* (ros_migrator),
  // which deliberately keeps bypass so migrations can seed system roles
  // (tenant_id IS NULL) without an app.tenant_id session context. This is
  // the ONLY literal deviation from FR-PLT-014 in this suite, it is scoped to
  // exactly one named table, and it is traceable to a dated, Accepted ADR —
  // not a suite-local waiver. A new tenant_id table gets no exemption by
  // default; this map only ever grows by another explicit, ADR-backed entry.
  'identity.roles':
    'ADR-0003 — nullable tenant_id (NULL = shared system role); ros_migrator ' +
    '(table owner) must seed is_system rows with no app.tenant_id context; ' +
    'ENABLE alone fully protects the non-owner ros_app runtime role.',
};

export interface RlsInventoryViolation {
  table: string;
  problem: string;
}

/** The gate's actual pass/fail logic, factored out so both the real
 * discovered-schema assertion and the sabotage tests below call the exact
 * same code path — a sabotage test that reimplemented this would only prove
 * the reimplementation is sensitive, not the gate. */
export function evaluateRlsInventory(
  tables: TenantTable[],
  exemptions: Record<string, string> = FORCE_EXEMPTIONS,
): RlsInventoryViolation[] {
  const violations: RlsInventoryViolation[] = [];
  for (const t of tables) {
    if (!t.rowSecurityEnabled) {
      violations.push({
        table: t.key,
        problem: 'ROW LEVEL SECURITY not enabled',
      });
    }
    if (t.policyCount === 0) {
      violations.push({ table: t.key, problem: 'no RLS policy defined' });
    }
    if (!t.rowSecurityForced && !exemptions[t.key]) {
      violations.push({
        table: t.key,
        problem: 'FORCE ROW LEVEL SECURITY not set (no ADR-backed exemption)',
      });
    }
  }
  return violations;
}

describe('FR-PLT-014 — generated RLS enable+force+policy inventory (e2e)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('discovery actually finds tenant_id tables (sanity: the gate is not vacuously passing)', async () => {
    const tables = await discoverAllTenantTables(pool);
    expect(tables.length).toBeGreaterThan(0);
  });

  it('every table with a tenant_id column has RLS enabled, forced (or ADR-exempted), and at least one policy', async () => {
    const tables = await discoverAllTenantTables(pool);
    const violations = evaluateRlsInventory(tables);
    expect(violations).toEqual([]);
  });

  describe('sabotage proofs (disposable schema, dropped after each case)', () => {
    const schema = `rls_sabotage_${randomUUID().replace(/-/g, '_')}`;

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA "${schema}"`);
    });

    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const leftover = await pool.query(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
        [schema],
      );
      expect(leftover.rowCount).toBe(0); // 0 orphan scratch schemas/tables
    });

    async function makeTable(name: string, ddlTail: string): Promise<void> {
      await pool.query(
        `CREATE TABLE "${schema}"."${name}" (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`,
      );
      if (ddlTail)
        await pool.query(ddlTail.replaceAll('__T__', `"${schema}"."${name}"`));
    }

    it('a tenant_id table with no RLS at all fails the gate', async () => {
      const table = 'no_rls_at_all';
      await makeTable(table, '');
      const tables = await discoverAllTenantTables(pool);
      const t = tables.find((x) => x.key === `${schema}.${table}`);
      expect(t).toBeDefined();
      const violations = evaluateRlsInventory([t as TenantTable]);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.problem.includes('not enabled'))).toBe(
        true,
      );
    });

    it('a tenant_id table with ENABLE but no FORCE and no ADR exemption fails the gate', async () => {
      const table = 'enable_no_force';
      await makeTable(
        table,
        `ALTER TABLE __T__ ENABLE ROW LEVEL SECURITY; ` +
          `CREATE POLICY p ON __T__ USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
      );
      const tables = await discoverAllTenantTables(pool);
      const t = tables.find((x) => x.key === `${schema}.${table}`);
      const violations = evaluateRlsInventory([t as TenantTable]);
      expect(violations).toEqual([
        {
          table: `${schema}.${table}`,
          problem: 'FORCE ROW LEVEL SECURITY not set (no ADR-backed exemption)',
        },
      ]);
    });

    it('a tenant_id table with ENABLE+FORCE but no policy fails the gate', async () => {
      const table = 'force_no_policy';
      await makeTable(
        table,
        `ALTER TABLE __T__ ENABLE ROW LEVEL SECURITY; ALTER TABLE __T__ FORCE ROW LEVEL SECURITY;`,
      );
      const tables = await discoverAllTenantTables(pool);
      const t = tables.find((x) => x.key === `${schema}.${table}`);
      const violations = evaluateRlsInventory([t as TenantTable]);
      expect(violations).toEqual([
        { table: `${schema}.${table}`, problem: 'no RLS policy defined' },
      ]);
    });

    it('a fully correct tenant_id table (ENABLE + FORCE + policy) passes the gate — positive control', async () => {
      const table = 'fully_correct';
      await makeTable(
        table,
        `ALTER TABLE __T__ ENABLE ROW LEVEL SECURITY; ALTER TABLE __T__ FORCE ROW LEVEL SECURITY; ` +
          `CREATE POLICY p ON __T__ USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
      );
      const tables = await discoverAllTenantTables(pool);
      const t = tables.find((x) => x.key === `${schema}.${table}`);
      expect(evaluateRlsInventory([t as TenantTable])).toEqual([]);
    });
  });
});
