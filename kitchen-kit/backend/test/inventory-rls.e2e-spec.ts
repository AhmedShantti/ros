import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * Proves the PostgreSQL RLS boundary for Inventory DIRECTLY, exercised only
 * through the RLS-constrained runtime role (ros_app) via PrismaService. The
 * migrator client is used solely to arrange fixtures and observe true row state
 * — never as evidence of application isolation.
 *
 * Covers all three anchoring styles introduced by this phase:
 *   - direct tenant_id            (stock_items, stock_levels, reason_codes, …)
 *   - parent inheritance          (waste_lines -> waste_records)
 *   - append-only ledger          (stock_movements: SELECT/INSERT only)
 */
describe('Inventory RLS enforcement as ros_app (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService; // ros_app (NOBYPASSRLS)
  let admin: PrismaClient; // ros_migrator (arrange/observe only)

  const ts = Date.now();
  const A = newId();
  const B = newId();
  const uomId = newId();
  const locA = newId();
  const locB = newId();
  const itemA = newId();
  const reasonA = newId();
  const wasteA = newId();
  let actorId: string;

  const mkLocation = async (tenantId: string, locId: string, code: string) => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `B${code}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code,
        name: `Br${code}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.location.create({
      data: {
        id: locId,
        tenantId,
        locationType: 'branch',
        refId: branch.id,
        branchId: branch.id,
      },
    });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);

    await admin.tenant.createMany({
      data: [A, B].map((id, i) => ({
        id,
        slug: `invrls-${i}-${ts}`,
        legalName: 'InvRLS',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
    });
    await admin.uom.create({
      data: { id: uomId, dimension: 'mass', code: `kg-${ts}`, name: 'kg' },
    });
    await mkLocation(A, locA, `RA${ts % 1000}`);
    await mkLocation(B, locB, `RB${ts % 1000}`);

    actorId = (
      await admin.user.create({
        data: {
          id: newId(),
          email: `invrls.${ts}@example.com`,
          displayName: 'r',
        },
      })
    ).id;

    await admin.stockItem.create({
      data: {
        id: itemA,
        tenantId: A,
        sku: `RLS-${ts}`,
        names: { en: 'x' },
        baseUnitId: uomId,
      },
    });
    await admin.reasonCode.create({
      data: {
        id: reasonA,
        tenantId: A,
        category: 'waste',
        code: `c-${ts}`,
        label: { en: 'c' },
      },
    });
    await admin.wasteRecord.create({
      data: {
        id: wasteA,
        tenantId: A,
        locationId: locA,
        reasonCodeId: reasonA,
        totalValue: 0n,
        recordedBy: actorId,
      },
    });
    await admin.wasteLine.create({
      data: {
        id: newId(),
        wasteRecordId: wasteA,
        stockItemId: itemA,
        quantity: 1,
        unitCost: 100n,
      },
    });
    await admin.stockMovement.create({
      data: {
        id: newId(),
        occurredAt: new Date(),
        tenantId: A,
        locationId: locA,
        stockItemId: itemA,
        movementType: 'opening_balance',
        quantity: 10,
        unitId: uomId,
        unitCost: 100n,
        totalCost: 1000n,
        balanceAfter: 10,
        referenceType: 'opening',
        referenceId: newId(),
        performedBy: actorId,
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('missing tenant context → fail closed', () => {
    it('returns no rows for every tenant-scoped inventory table', async () => {
      const counts = await prisma.withAuthContext({}, async (tx) => ({
        items: await tx.stockItem.count(),
        movements: await tx.stockMovement.count(),
        levels: await tx.stockLevel.count(),
        reasons: await tx.reasonCode.count(),
        waste: await tx.wasteRecord.count(),
        wasteLines: await tx.wasteLine.count(),
      }));
      expect(counts).toEqual({
        items: 0,
        movements: 0,
        levels: 0,
        reasons: 0,
        waste: 0,
        wasteLines: 0,
      });
    });

    it('rejects an INSERT with no tenant context', async () => {
      await expect(
        prisma.withAuthContext({}, (tx) =>
          tx.stockItem.create({
            data: {
              id: newId(),
              tenantId: A,
              sku: `nope-${ts}`,
              names: {},
              baseUnitId: uomId,
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('same tenant → allowed', () => {
    it('sees its own rows', async () => {
      const items = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.stockItem.findMany({ select: { id: true } }),
      );
      expect(items.map((i) => i.id)).toContain(itemA);
    });

    it('sees an inherited child through its parent (waste_lines → waste_records)', async () => {
      const lines = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.wasteLine.findMany({ select: { id: true } }),
      );
      expect(lines.length).toBeGreaterThan(0);
    });

    it('global uom reference data is readable without a tenant anchor', async () => {
      const uoms = await prisma.withAuthContext({}, (tx) => tx.uom.count());
      expect(uoms).toBeGreaterThan(0);
    });
  });

  describe('cross-tenant', () => {
    it('SELECT returns nothing', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.stockItem.findMany({ where: { id: itemA }, select: { id: true } }),
      );
      expect(rows).toHaveLength(0);
    });

    it('ledger SELECT returns nothing', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.stockMovement.findMany({ where: { tenantId: A } }),
      );
      expect(rows).toHaveLength(0);
    });

    it('inherited child SELECT returns nothing', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.wasteLine.findMany({ select: { id: true } }),
      );
      expect(rows).toHaveLength(0);
    });

    it('INSERT spoofing another tenant_id is rejected', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.stockItem.create({
            data: {
              id: newId(),
              tenantId: A,
              sku: `spoof-${ts}`,
              names: {},
              baseUnitId: uomId,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('ledger INSERT spoofing another tenant_id is rejected', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.stockMovement.create({
            data: {
              id: newId(),
              occurredAt: new Date(),
              tenantId: A,
              locationId: locA,
              stockItemId: itemA,
              movementType: 'manual_adjustment',
              quantity: 1,
              unitId: uomId,
              unitCost: 1n,
              totalCost: 1n,
              balanceAfter: 1,
              referenceType: 'x',
              referenceId: newId(),
              performedBy: actorId,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('UPDATE affects zero rows and leaves the real row untouched', async () => {
      const res = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.stockItem.updateMany({
          where: { id: itemA },
          data: { sku: 'hijacked' },
        }),
      );
      expect(res.count).toBe(0);
      const truth = await admin.stockItem.findUnique({ where: { id: itemA } });
      expect(truth?.sku).not.toBe('hijacked');
    });

    it('DELETE affects zero rows and the real row survives', async () => {
      const res = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.reasonCode.deleteMany({ where: { id: reasonA } }),
      );
      expect(res.count).toBe(0);
      expect(
        await admin.reasonCode.findUnique({ where: { id: reasonA } }),
      ).not.toBeNull();
    });
  });

  describe('append-only ledger (BR-INV-001)', () => {
    it('the runtime role cannot UPDATE the ledger even within its own tenant', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.stockMovement.updateMany({
            where: { tenantId: A },
            data: { notes: 'tampered' },
          }),
        ),
      ).rejects.toThrow();
    });

    it('the runtime role cannot DELETE from the ledger', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.stockMovement.deleteMany({ where: { tenantId: A } }),
        ),
      ).rejects.toThrow();
    });
  });

  /**
   * Regression guard for a real bypass found by live probe, not by these tests.
   *
   * ENABLE/FORCE ROW LEVEL SECURITY and CREATE POLICY on a PARTITIONED PARENT
   * apply to access made THROUGH the parent. When a PARTITION is named DIRECTLY,
   * PostgreSQL applies that PARTITION's OWN policies -- which were absent, while
   * ros_app held SELECT, INSERT on every partition. Any raw SQL naming a
   * partition could therefore read every tenant's ledger with no tenant context.
   *
   * Prisma always addresses the parent, so the application path was never
   * affected; the database boundary was. These tests assert the boundary itself.
   */
  describe('partitioned ledger — direct partition access (RLS bypass guard)', () => {
    const partitions = async (): Promise<string[]> => {
      const rows = await admin.$queryRawUnsafe<{ relname: string }[]>(
        `SELECT c.relname FROM pg_class c
           JOIN pg_inherits i ON i.inhrelid = c.oid
           JOIN pg_class p ON p.oid = i.inhparent
           JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'inventory' AND p.relname = 'stock_movements'`,
      );
      return rows.map((r) => r.relname);
    };

    it('every ledger partition has RLS enabled, forced, and both policies', async () => {
      const names = await partitions();
      expect(names.length).toBeGreaterThan(0);
      const bad = await admin.$queryRawUnsafe<{ relname: string }[]>(
        `SELECT c.relname FROM pg_class c
           JOIN pg_inherits i ON i.inhrelid = c.oid
           JOIN pg_class p ON p.oid = i.inhparent
           JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'inventory' AND p.relname = 'stock_movements'
           AND NOT (
             c.relrowsecurity AND c.relforcerowsecurity
             AND (SELECT count(*) FROM pg_policies pol
                  WHERE pol.schemaname = 'inventory'
                    AND pol.tablename = c.relname) = 2
           )`,
      );
      expect(bad.map((b) => b.relname)).toEqual([]);
    });

    it('no partition grants ros_app UPDATE, DELETE or TRUNCATE', async () => {
      const granted = await admin.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT DISTINCT table_name FROM information_schema.role_table_grants
         WHERE grantee = 'ros_app' AND table_schema = 'inventory'
           AND table_name LIKE 'stock_movements_%'
           AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')`,
      );
      expect(granted.map((g) => g.table_name)).toEqual([]);
    });

    it('a partition named directly leaks nothing without tenant context', async () => {
      for (const part of await partitions()) {
        const rows = await prisma.withAuthContext({}, (tx) =>
          tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM inventory.${part}`,
          ),
        );
        expect(Number(rows[0].n)).toBe(0);
      }
    });

    it('a partition named directly leaks nothing across tenants', async () => {
      // Positive control first: tenant A can see its own ledger row this way,
      // so a zero below means RLS filtered it -- not that the row is missing.
      const own = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1::uuid`,
          A,
        ),
      );
      expect(Number(own[0].n)).toBeGreaterThan(0);

      for (const part of await partitions()) {
        const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM inventory.${part} WHERE tenant_id = $1::uuid`,
            A,
          ),
        );
        expect(Number(rows[0].n)).toBe(0);
      }
    });
  });
});
