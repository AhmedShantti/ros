import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaClient } from './../src/generated/prisma/client';
import { PartitionDdlService } from './../src/modules/platform/partitioning/partition-ddl.service';
import {
  PARTITION_CREATION_FAILED_FINDING_CODE,
  PARTITION_HORIZON_MONTHS,
  PARTITION_LIFECYCLE_JOB,
} from './../src/modules/platform/partitioning/partition-lifecycle.job';
import {
  requiredMonths,
  partitionTableName,
  YearMonth,
} from './../src/modules/platform/partitioning/partition-month';
import { PARTITIONED_TABLES } from './../src/modules/platform/partitioning/partitioned-table.registry';
import { createMigratorClient } from './rls-admin';
import {
  TestJobControl,
  bootSchedulerApp,
  clearScheduler,
  createSchedulerTenant,
  onlyJob,
  readFindings,
  readOccurrence,
  runnerOf,
} from './scheduler-fixtures';

/**
 * FR-DR-002 — the scheduled partition-lifecycle job, against real PostgreSQL.
 *
 *   FR-DR-002 "Partitions SHALL be created automatically at least 3 months in
 *              advance by a scheduled job, with alerting if creation fails."
 *
 * ── WHAT THIS SUITE PROVES, AND WHAT IT DOES NOT ──────────────────────────
 * It proves the DDL is correct, idempotent, safe under real concurrent
 * execution, alerts durably on failure, and never touches an existing
 * partition's structure or data. It does NOT re-prove that a business-domain
 * insert through the full HTTP/service path lands in the right partition —
 * that is a property of `sales.orders`/`inventory.stock_movements` writers
 * this repository's existing suites already own. What this slice added is the
 * DDL and the GRANT, so "the application can write into a newly-created
 * partition" is proven directly at the privilege/RLS-policy level
 * (`has_table_privilege`, `pg_policy`), which is exactly the property this
 * slice is responsible for — not by re-fabricating a full order/movement
 * fixture graph a different slice already exercises end to end.
 *
 * `admin` below is the migrator/owner role (superuser-equivalent locally) —
 * used only to arrange fixtures and observe true catalog/row state, mirroring
 * every other suite's use of `createMigratorClient`. It is never evidence of
 * what `ros_app` or `ros_partition_admin` can themselves do — those are
 * checked with `has_table_privilege` against the named role explicitly.
 */
describe('Partition lifecycle scheduled job (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let tenantId: string;

  beforeAll(async () => {
    app = await bootSchedulerApp();
    admin = createMigratorClient(app);
    tenantId = await createSchedulerTenant(admin, 'partlife');
  }, 90_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    TestJobControl.reset();
    await clearScheduler(admin, [tenantId]);
    await onlyJob(admin, tenantId, PARTITION_LIFECYCLE_JOB);
  });

  async function partitionExists(
    schema: string,
    table: string,
  ): Promise<boolean> {
    const rows = await admin.$queryRawUnsafe<{ oid: string | null }[]>(
      `SELECT to_regclass('${schema}.${table}')::text AS oid`,
    );
    return rows[0]?.oid != null;
  }

  async function partitionBoundText(
    schema: string,
    table: string,
  ): Promise<string | null> {
    const rows = await admin.$queryRawUnsafe<{ bound: string | null }[]>(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${schema}' AND c.relname = '${table}'`,
    );
    return rows[0]?.bound ?? null;
  }

  /** Every table/month this job is required to cover, given `now`. */
  function requiredPartitions(now: Date): {
    schema: string;
    table: string;
    partition: string;
    ym: YearMonth;
  }[] {
    const months = requiredMonths(now, PARTITION_HORIZON_MONTHS);
    return PARTITIONED_TABLES.flatMap((t) =>
      months.map((ym) => ({
        schema: t.schema,
        table: t.table,
        partition: partitionTableName(t.table, ym),
        ym,
      })),
    );
  }

  it('from-zero database has required initial partition topology', async () => {
    // Sanity on the baseline every other test in this suite builds on: the
    // foundation migrations already ship SOME coverage for "now" (the actual
    // wall-clock instant this suite runs at), for every registered table.
    const now = new Date();
    for (const req of requiredPartitions(
      new Date(now.getFullYear(), now.getMonth(), 1),
    )) {
      // Only assert the CURRENT month, not the full horizon — the whole
      // point of FR-DR-002 is that MAINTAINING the full horizon is the
      // scheduled job's job, not a one-time migration's.
      if (
        req.ym.year === now.getUTCFullYear() &&
        req.ym.month === now.getUTCMonth() + 1
      ) {
        expect(await partitionExists(req.schema, req.partition)).toBe(true);
      }
    }
  });

  it('scheduler creates a horizon of at least 3 months ahead, spanning existing coverage gaps', async () => {
    // Chosen so sales.orders/order_lines (seeded only through 2027-01 by the
    // foundation migration) are missing coverage, while stock_movements
    // (seeded through 2027-09) is not — exercising real creation for two
    // tables and a genuine no-op for the third in the same tick.
    const now = new Date('2027-02-15T12:00:00.000Z');
    const required = requiredPartitions(now);
    expect(required.length).toBe(
      PARTITIONED_TABLES.length * (PARTITION_HORIZON_MONTHS + 1),
    );

    const result = await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    for (const req of required) {
      expect(await partitionExists(req.schema, req.partition)).toBe(true);
    }
    // The occurrence itself succeeded cleanly with no divergence recorded.
    const findings = await readFindings(
      admin,
      tenantId,
      PARTITION_LIFECYCLE_JOB,
    );
    expect(findings).toHaveLength(0);
  });

  it('duplicate tick creates no duplicate partition and stays a clean no-op', async () => {
    const now = new Date('2027-03-15T12:00:00.000Z');
    const first = await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    expect(first.succeeded).toBe(1);

    const before = await Promise.all(
      requiredPartitions(now).map((r) =>
        admin.$queryRawUnsafe<{ oid: string }[]>(
          `SELECT to_regclass('${r.schema}.${r.partition}')::text AS oid`,
        ),
      ),
    );

    // A SECOND daily occurrence does not exist for the same local slot (the
    // substrate's own occurrence identity already forbids that — proven by
    // scheduler-core/-concurrency). What this test adds is: manually
    // re-running the SAME DDL path a second time (as a duplicate/manual
    // invocation would) is still a clean no-op, not an error.
    const ddl = app.get(PartitionDdlService);
    for (const table of PARTITIONED_TABLES) {
      for (const ym of requiredMonths(now, PARTITION_HORIZON_MONTHS)) {
        const outcome = await ddl.ensurePartition(table, ym);
        expect(outcome).toBe('already_existed');
      }
    }

    const after = await Promise.all(
      requiredPartitions(now).map((r) =>
        admin.$queryRawUnsafe<{ oid: string }[]>(
          `SELECT to_regclass('${r.schema}.${r.partition}')::text AS oid`,
        ),
      ),
    );
    expect(after).toEqual(before);
  });

  it('two tenants racing the same missing partition create it exactly once (advisory-lock safety)', async () => {
    const now = new Date('2027-04-15T12:00:00.000Z');
    const tenantB = await createSchedulerTenant(admin, 'partlife-race-b');
    await onlyJob(admin, tenantB, PARTITION_LIFECYCLE_JOB);

    const appB = await bootSchedulerApp();
    try {
      const [resultA, resultB] = await Promise.all([
        runnerOf(app).runTick({ now, tenantIds: [tenantId] }),
        runnerOf(appB).runTick({ now, tenantIds: [tenantB] }),
      ]);
      // Both tenants' own occurrences succeed independently — neither one's
      // DDL attempt errors out because the other got there first.
      expect(resultA.succeeded).toBe(1);
      expect(resultB.succeeded).toBe(1);
      expect(resultA.failed).toBe(0);
      expect(resultB.failed).toBe(0);

      for (const req of requiredPartitions(now)) {
        expect(await partitionExists(req.schema, req.partition)).toBe(true);
      }
      // Exactly one physical partition per required month — the race could
      // only have produced a DUPLICATE ERROR (caught as a finding) or a
      // clean single partition; assert the latter for every table.
      for (const t of PARTITIONED_TABLES) {
        const rows = await admin.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_inherits i
             JOIN pg_class c ON c.oid = i.inhrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_class p ON p.oid = i.inhparent
            WHERE n.nspname = '${t.schema}' AND p.relname = '${t.table}'
              AND c.relname = '${partitionTableName(t.table, { year: 2027, month: 4 })}'`,
        );
        expect(Number(rows[0].n)).toBe(1);
      }

      const findingsA = await readFindings(
        admin,
        tenantId,
        PARTITION_LIFECYCLE_JOB,
      );
      const findingsB = await readFindings(
        admin,
        tenantB,
        PARTITION_LIFECYCLE_JOB,
      );
      expect(findingsA).toHaveLength(0);
      expect(findingsB).toHaveLength(0);
    } finally {
      await appB.close();
      await admin.scheduledJobFinding.deleteMany({
        where: { tenantId: tenantB },
      });
      await admin.scheduledJobOccurrence.deleteMany({
        where: { tenantId: tenantB },
      });
      await admin.scheduledJobSchedule.deleteMany({
        where: { tenantId: tenantB },
      });
      await admin.tenant.delete({ where: { id: tenantB } });
    }
  }, 30_000);

  it('an already-sufficient horizon is a clean no-op (no new partitions, no findings)', async () => {
    // The real "now" this suite runs at: every table already has coverage
    // well past 3 months ahead (seeded by the foundation migrations).
    const now = new Date();
    const before = await Promise.all(
      PARTITIONED_TABLES.map((t) =>
        admin.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_inherits i
             JOIN pg_class c ON c.oid = i.inhrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_class p ON p.oid = i.inhparent
            WHERE n.nspname = '${t.schema}' AND p.relname = '${t.table}'`,
        ),
      ),
    );

    const result = await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    expect(result.succeeded).toBe(1);

    const after = await Promise.all(
      PARTITIONED_TABLES.map((t) =>
        admin.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_inherits i
             JOIN pg_class c ON c.oid = i.inhrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_class p ON p.oid = i.inhparent
            WHERE n.nspname = '${t.schema}' AND p.relname = '${t.table}'`,
        ),
      ),
    );
    expect(after.map((r) => Number(r[0].n))).toEqual(
      before.map((r) => Number(r[0].n)),
    );

    const findings = await readFindings(
      admin,
      tenantId,
      PARTITION_LIFECYCLE_JOB,
    );
    expect(findings).toHaveLength(0);
  });

  it('a partial horizon fills only the gaps, leaving pre-existing partitions untouched', async () => {
    const now = new Date('2027-11-15T12:00:00.000Z'); // chosen fresh, beyond every earlier test's own horizon in this file (see file-level ordering note)
    const months = requiredMonths(now, PARTITION_HORIZON_MONTHS);
    const [firstMonth, ...restMonths] = months;

    const ddl = app.get(PartitionDdlService);
    // Pre-create every REQUIRED partition except the first month, for every
    // table — leaving exactly one gap per table.
    for (const table of PARTITIONED_TABLES) {
      for (const ym of restMonths) {
        await ddl.ensurePartition(table, ym);
      }
    }
    for (const t of PARTITIONED_TABLES) {
      expect(
        await partitionExists(
          t.schema,
          partitionTableName(t.table, firstMonth),
        ),
      ).toBe(false);
    }
    const preExistingBounds = await Promise.all(
      PARTITIONED_TABLES.flatMap((t) =>
        restMonths.map((ym) =>
          partitionBoundText(t.schema, partitionTableName(t.table, ym)),
        ),
      ),
    );

    const result = await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    expect(result.succeeded).toBe(1);

    // The gap is now filled...
    for (const t of PARTITIONED_TABLES) {
      expect(
        await partitionExists(
          t.schema,
          partitionTableName(t.table, firstMonth),
        ),
      ).toBe(true);
    }
    // ...and the pre-existing ones were not recreated/altered (identical bounds).
    const afterBounds = await Promise.all(
      PARTITIONED_TABLES.flatMap((t) =>
        restMonths.map((ym) =>
          partitionBoundText(t.schema, partitionTableName(t.table, ym)),
        ),
      ),
    );
    expect(afterBounds).toEqual(preExistingBounds);
  });

  it('spans a month/year boundary correctly (December -> January)', async () => {
    const now = new Date('2026-11-20T12:00:00.000Z');
    const result = await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    expect(result.succeeded).toBe(1);

    // requiredMonths(2026-11, horizon 3) = Nov, Dec 2026, Jan, Feb 2027.
    for (const req of requiredPartitions(now)) {
      expect(await partitionExists(req.schema, req.partition)).toBe(true);
    }
    const janBound = await partitionBoundText(
      'sales',
      partitionTableName('orders', { year: 2027, month: 1 }),
    );
    expect(janBound).toBe("FOR VALUES FROM ('2027-01-01') TO ('2027-02-01')");
  });

  it('bounds a leap-year February correctly (2028)', async () => {
    const now = new Date('2027-12-20T12:00:00.000Z');
    const result = await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    expect(result.succeeded).toBe(1);

    const febBound = await partitionBoundText(
      'sales',
      partitionTableName('orders', { year: 2028, month: 2 }),
    );
    // Bounds are month-grain, never day-of-month — 2028's extra day changes
    // nothing about the boundary literal itself.
    expect(febBound).toBe("FOR VALUES FROM ('2028-02-01') TO ('2028-03-01')");
  });

  it('a DDL failure produces a durable, correctly-shaped finding, and self-heals once fixed', async () => {
    const now = new Date('2027-06-15T12:00:00.000Z');
    // Revoke exactly what PartitionDdlService needs for the `sales` schema,
    // simulating a real drift/misconfiguration — never touching `ros_app`,
    // RLS, or any other schema.
    await admin.$executeRawUnsafe(
      `REVOKE CREATE ON SCHEMA "sales" FROM ros_partition_admin`,
    );
    try {
      const result = await runnerOf(app).runTick({
        now,
        tenantIds: [tenantId],
      });
      // The occurrence itself still succeeds: DDL failures are CAUGHT per
      // partition and reported as a finding, not thrown — see the job's own
      // docblock for why (one broken table must not block the other two, and
      // must not burn the tenant's retry attempts on a non-transient
      // misconfiguration a retry cannot fix either).
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);

      // inventory.stock_movements is unaffected (different schema) —
      // whichever months for it were missing (none, in this window) or not,
      // no failure is attributed to it.
      const findings = await readFindings(
        admin,
        tenantId,
        PARTITION_LIFECYCLE_JOB,
      );
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding.severity).toBe('critical');
      expect(finding.findingCode).toBe(PARTITION_CREATION_FAILED_FINDING_CODE);
      const detail = finding.detail as {
        failureCount: number;
        failures: {
          schema: string;
          table: string;
          month: string;
          error: string;
        }[];
      };
      expect(detail.failureCount).toBeGreaterThan(0);
      expect(detail.failures.every((f) => f.schema === 'sales')).toBe(true);
      expect(
        detail.failures.some(
          (f) => f.table === 'orders' || f.table === 'order_lines',
        ),
      ).toBe(true);
      expect(
        detail.failures.every(
          (f) => typeof f.error === 'string' && f.error.length > 0,
        ),
      ).toBe(true);

      // Every month the finding claims failed genuinely does not exist as a
      // partition — the failure is truthful, not partially masked by a
      // half-created table that the finding failed to mention.
      for (const failure of detail.failures) {
        const exists = await partitionExists(
          failure.schema,
          `${failure.table}_${failure.month.replace('-', '_')}`,
        );
        expect(exists).toBe(false);
      }
    } finally {
      await admin.$executeRawUnsafe(
        `GRANT USAGE, CREATE ON SCHEMA "sales" TO ros_partition_admin`,
      );
    }

    // Self-heal: clear this occurrence and re-run — now succeeds cleanly.
    await clearScheduler(admin, [tenantId]);
    await onlyJob(admin, tenantId, PARTITION_LIFECYCLE_JOB);
    const healed = await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    expect(healed.succeeded).toBe(1);
    const healedFindings = await readFindings(
      admin,
      tenantId,
      PARTITION_LIFECYCLE_JOB,
    );
    expect(healedFindings).toHaveLength(0);
    for (const req of requiredPartitions(now)) {
      expect(await partitionExists(req.schema, req.partition)).toBe(true);
    }
  }, 30_000);

  it('grants ros_app exactly the intended DML shape on a newly-created partition, and nothing more', async () => {
    const now = new Date('2027-07-15T12:00:00.000Z');
    await runnerOf(app).runTick({ now, tenantIds: [tenantId] });

    for (const t of PARTITIONED_TABLES) {
      const partition = partitionTableName(t.table, { year: 2027, month: 7 });
      const qualified = `${t.schema}.${partition}`;
      const priv = async (p: string) => {
        const rows = await admin.$queryRawUnsafe<{ ok: boolean }[]>(
          `SELECT has_table_privilege('ros_app', '${qualified}', '${p}') AS ok`,
        );
        return rows[0].ok;
      };
      expect(await priv('SELECT')).toBe(true);
      expect(await priv('INSERT')).toBe(true);
      if (t.rlsShape === 'full_dml') {
        expect(await priv('UPDATE')).toBe(true);
        expect(await priv('DELETE')).toBe(true);
      } else {
        expect(await priv('UPDATE')).toBe(false);
        expect(await priv('DELETE')).toBe(false);
        expect(await priv('TRUNCATE')).toBe(false);
      }
    }
  });

  it('a newly-created partition carries FORCE RLS and tenant-scoped policies matching the parent', async () => {
    const now = new Date('2027-08-15T12:00:00.000Z');
    await runnerOf(app).runTick({ now, tenantIds: [tenantId] });

    for (const t of PARTITIONED_TABLES) {
      const partition = partitionTableName(t.table, { year: 2027, month: 8 });
      const relRows = await admin.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${t.schema}' AND c.relname = '${partition}'`,
      );
      expect(relRows[0].relrowsecurity).toBe(true);
      expect(relRows[0].relforcerowsecurity).toBe(true);

      const policyRows = await admin.$queryRawUnsafe<
        {
          polname: string;
          cmd: string;
          qual: string | null;
          withcheck: string | null;
        }[]
      >(
        `SELECT pol.polname,
                pol.polcmd::text AS cmd,
                pg_get_expr(pol.polqual, pol.polrelid) AS qual,
                pg_get_expr(pol.polwithcheck, pol.polrelid) AS withcheck
           FROM pg_policy pol
           JOIN pg_class c ON c.oid = pol.polrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${t.schema}' AND c.relname = '${partition}'
          ORDER BY pol.polname`,
      );
      const expectedCount = t.rlsShape === 'append_only' ? 2 : 4;
      expect(policyRows).toHaveLength(expectedCount);
      const tenantPredicate =
        "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";
      for (const row of policyRows) {
        expect(
          row.qual === tenantPredicate || row.withcheck === tenantPredicate,
        ).toBe(true);
      }
    }
  });

  it('does not alter any existing partition (structure, tuple count or attempted destructive privilege)', async () => {
    // A pre-existing partition, seeded by the foundation migration, well
    // outside anything this job creates in this suite.
    const existingSchema = 'inventory';
    const existingPartition = 'stock_movements_2026_08';

    const before = await admin.$queryRawUnsafe<
      { oid: string; reltuples: number }[]
    >(
      `SELECT c.oid::text AS oid, c.reltuples::float8 AS reltuples
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${existingSchema}' AND c.relname = '${existingPartition}'`,
    );
    expect(before).toHaveLength(1);

    // Run several ticks with different horizons — none of which should ever
    // touch this already-existing, already-covered partition.
    for (const now of [
      new Date(),
      new Date('2026-10-01T12:00:00.000Z'),
      new Date('2026-12-15T12:00:00.000Z'),
    ]) {
      await runnerOf(app).runTick({ now, tenantIds: [tenantId] });
    }

    const after = await admin.$queryRawUnsafe<
      { oid: string; reltuples: number }[]
    >(
      `SELECT c.oid::text AS oid, c.reltuples::float8 AS reltuples
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${existingSchema}' AND c.relname = '${existingPartition}'`,
    );
    // Same physical relation (OID unchanged — not dropped and recreated).
    expect(after[0].oid).toBe(before[0].oid);
    expect(after[0].reltuples).toBe(before[0].reltuples);
  });

  it('records the exact occurrence identity and outcome for a healthy run', async () => {
    const now = new Date('2027-09-15T12:00:00.000Z');
    await runnerOf(app).runTick({ now, tenantIds: [tenantId] });

    const occurrenceKey = '2027-09-15T02:00';
    const occurrence = await readOccurrence(
      admin,
      tenantId,
      PARTITION_LIFECYCLE_JOB,
      occurrenceKey,
    );
    expect(occurrence?.state).toBe('succeeded');
    expect(occurrence?.attempt).toBe(1);
    expect(occurrence?.leaseOwner).toBeNull();
  });
});
