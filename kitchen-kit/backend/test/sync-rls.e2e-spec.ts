import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * CT-05 / FR-PLT-010..012 for the six new `sync` tables.
 *
 * Every assertion runs through `PrismaService` as the RLS-constrained runtime
 * role (`ros_app`, NOBYPASSRLS). The migrator client only arranges fixtures and
 * observes true row state — it is never evidence of application isolation.
 *
 * NO BRANCH PREDICATE is tested, because none exists: branch-scoped RLS is not
 * introduced by this lane. `branch_id` on these tables is server-derived
 * attribution, not an authorization boundary.
 */
describe('Sync RLS enforcement as ros_app (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: PrismaClient;

  const ts = Date.now();
  const A = newId();
  const B = newId();
  const terminalA = newId();
  const terminalB = newId();

  const SYNC_TABLES = [
    'operation_dedup',
    'sync_operations',
    'sync_batches',
    'device_state',
    'conflict_records',
    'revalidation_exceptions',
  ] as const;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);

    for (const [i, id] of [A, B].entries()) {
      await admin.tenant.create({
        data: {
          id,
          slug: `sync-rls-${i}-${ts}`,
          legalName: 'Sync RLS',
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        },
      });
    }

    // One dedup row per tenant, arranged privileged so the test can prove the
    // RUNTIME role cannot see across the boundary.
    for (const [tenantId, terminalId] of [
      [A, terminalA],
      [B, terminalB],
    ] as const) {
      await admin.syncOperationDedup.create({
        data: {
          tenantId,
          opId: newId(),
          fingerprint: 'a'.repeat(64),
          status: 'accepted',
          result: { status: 'accepted' },
          batchId: newId(),
          terminalId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await admin.syncDeviceState.create({
        data: { tenantId, terminalId, protocolVersion: 1 },
      });
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of [A, B]) {
      await admin.tenant.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await admin.$disconnect();
    await app.close();
  });

  it('has RLS ENABLED and FORCED on every sync table', async () => {
    const rows = await admin.$queryRawUnsafe<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relnamespace = 'sync'::regnamespace AND relkind = 'r'`,
    );
    for (const table of SYNC_TABLES) {
      const row = rows.find((r) => r.relname === table);
      expect(row).toBeDefined();
      // FORCE matters: without it the table owner would bypass its own policies.
      expect([table, row!.relrowsecurity, row!.relforcerowsecurity]).toEqual([
        table,
        true,
        true,
      ]);
    }
  });

  it('has a policy for each of SELECT/INSERT/UPDATE/DELETE on every sync table', async () => {
    const rows = await admin.$queryRawUnsafe<
      { tablename: string; cmd: string }[]
    >(`SELECT tablename, cmd FROM pg_policies WHERE schemaname = 'sync'`);
    for (const table of SYNC_TABLES) {
      const cmds = rows
        .filter((r) => r.tablename === table)
        .map((r) => r.cmd)
        .sort();
      expect([table, cmds]).toEqual([
        table,
        ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      ]);
    }
  });

  it('reads only its own tenant’s rows', async () => {
    const own = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.syncOperationDedup.findMany(),
    );
    expect(own).toHaveLength(1);
    expect(own[0].tenantId).toBe(A);

    const other = await prisma.withAuthContext({ tenantId: B }, (tx) =>
      tx.syncOperationDedup.findMany(),
    );
    expect(other).toHaveLength(1);
    expect(other[0].tenantId).toBe(B);
  });

  it('returns ZERO rows for another tenant’s row, even by primary key', async () => {
    const bRow = await admin.syncOperationDedup.findFirst({
      where: { tenantId: B },
    });
    const seen = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.syncOperationDedup.findUnique({
        where: { tenantId_opId: { tenantId: B, opId: bRow!.opId } },
      }),
    );
    expect(seen).toBeNull();
  });

  it('cannot UPDATE or DELETE another tenant’s row', async () => {
    const bRow = await admin.syncOperationDedup.findFirst({
      where: { tenantId: B },
    });

    const updated = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.syncOperationDedup.updateMany({
        where: { tenantId: B, opId: bRow!.opId },
        data: { status: 'rejected' },
      }),
    );
    expect(updated.count).toBe(0);

    const deleted = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.syncOperationDedup.deleteMany({
        where: { tenantId: B, opId: bRow!.opId },
      }),
    );
    expect(deleted.count).toBe(0);

    // Still there, observed privileged.
    const stillThere = await admin.syncOperationDedup.findUnique({
      where: { tenantId_opId: { tenantId: B, opId: bRow!.opId } },
    });
    expect(stillThere?.status).toBe('accepted');
  });

  it('cannot INSERT a row attributed to another tenant', async () => {
    await expect(
      prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.syncOperationDedup.create({
          data: {
            tenantId: B,
            opId: newId(),
            fingerprint: 'b'.repeat(64),
            status: 'accepted',
            result: {},
            batchId: newId(),
            terminalId: terminalB,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('fails CLOSED with no auth context at all', async () => {
    // A missing context yields NULL in every policy predicate, so nothing is
    // visible and nothing can be written.
    const rows = await prisma.withAuthContext({}, (tx) =>
      tx.syncOperationDedup.findMany(),
    );
    expect(rows).toHaveLength(0);

    const states = await prisma.withAuthContext({}, (tx) =>
      tx.syncDeviceState.findMany(),
    );
    expect(states).toHaveLength(0);

    await expect(
      prisma.withAuthContext({}, (tx) =>
        tx.syncDeviceState.create({
          data: { tenantId: A, terminalId: newId(), protocolVersion: 1 },
        }),
      ),
    ).rejects.toThrow();
  });
});
