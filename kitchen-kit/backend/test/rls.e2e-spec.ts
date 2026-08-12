import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

// This suite proves the PostgreSQL RLS boundary directly, exercising it ONLY
// through the RLS-constrained runtime role (ros_app) via PrismaService. The
// migrator/superuser client is used solely to arrange fixtures and to observe
// true row state — never as evidence of application isolation.
describe('RLS enforcement as ros_app (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService; // ros_app (NOBYPASSRLS)
  let admin: PrismaClient; // ros_migrator (arrange/observe only)

  const ts = Date.now();
  const A = newId();
  const B = newId();
  const U = newId();
  const V = newId();
  const W = newId();
  const mUA = newId();
  const mWA = newId();
  const mUB = newId();
  const mVB = newId();

  type Row = { id: string; tenantId: string; userId: string };
  const find = (scope: {
    userId?: string;
    tenantId?: string;
  }): Promise<Row[]> =>
    prisma.withAuthContext(scope, (tx) =>
      tx.membership.findMany({
        select: { id: true, tenantId: true, userId: true },
      }),
    );

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
        slug: `rls-${i}-${ts}`,
        legalName: 'RLS',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
    });
    await admin.user.createMany({
      data: [U, V, W].map((id, i) => ({
        id,
        email: `rls.${i}.${ts}@example.com`,
        displayName: 'RLS',
      })),
    });
    await admin.membership.createMany({
      data: [
        { id: mUA, userId: U, tenantId: A },
        { id: mWA, userId: W, tenantId: A },
        { id: mUB, userId: U, tenantId: B },
        { id: mVB, userId: V, tenantId: B },
      ],
    });
  });

  afterAll(async () => {
    await admin.tenant
      .deleteMany({ where: { id: { in: [A, B] } } })
      .catch(() => undefined);
    await admin.user
      .deleteMany({ where: { id: { in: [U, V, W] } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  it('1/2/11. tenant A context sees only tenant A memberships', async () => {
    const rows = await find({ tenantId: A });
    expect(rows.every((r) => r.tenantId === A)).toBe(true);
    expect(rows.map((r) => r.id).sort()).toEqual([mUA, mWA].sort());
  });

  it('9/18. no context → zero rows (ros_app cannot bypass RLS)', async () => {
    expect(await find({})).toHaveLength(0);
  });

  it('memberships SELECT: user-scoped read sees own across tenants (pre-selection)', async () => {
    const rows = await find({ userId: U });
    expect(rows.map((r) => r.id).sort()).toEqual([mUA, mUB].sort());
  });

  it('memberships SELECT: tenant A + user U sees A rows plus own rows', async () => {
    const ids = (await find({ userId: U, tenantId: A }))
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([mUA, mWA, mUB].sort());
  });

  it('3/17. INSERT in current tenant allowed; INSERT spoofing another tenant denied', async () => {
    const okId = newId();
    await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.membership.create({ data: { id: okId, userId: V, tenantId: A } }),
    );
    expect(
      await admin.membership.findUnique({ where: { id: okId } }),
    ).not.toBeNull();
    await admin.membership.delete({ where: { id: okId } });

    await expect(
      prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.membership.create({
          data: { id: newId(), userId: V, tenantId: B },
        }),
      ),
    ).rejects.toThrow();
  });

  it('7. UPDATE own-tenant row allowed', async () => {
    const res = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.membership.updateMany({
        where: { id: mWA },
        data: { status: 'inactive' },
      }),
    );
    expect(res.count).toBe(1);
    await admin.membership.update({
      where: { id: mWA },
      data: { status: 'active' },
    });
  });

  it('6/9. UPDATE another tenant row (incl. own membership in B) → zero rows', async () => {
    const other = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.membership.updateMany({
        where: { id: mVB },
        data: { status: 'inactive' },
      }),
    );
    expect(other.count).toBe(0);
    // Even with user context, the WRITE policy is tenant-only: U cannot touch
    // its own membership in tenant B while operating in tenant A.
    const ownInB = await prisma.withAuthContext(
      { userId: U, tenantId: A },
      (tx) =>
        tx.membership.updateMany({
          where: { id: mUB },
          data: { status: 'inactive' },
        }),
    );
    expect(ownInB.count).toBe(0);
  });

  it('8. DELETE another tenant row → zero rows; DELETE own-tenant row allowed', async () => {
    const cross = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.membership.deleteMany({ where: { id: mVB } }),
    );
    expect(cross.count).toBe(0);

    const throwaway = newId();
    await admin.membership.create({
      data: { id: throwaway, userId: V, tenantId: A },
    });
    const own = await prisma.withAuthContext({ tenantId: A }, (tx) =>
      tx.membership.deleteMany({ where: { id: throwaway } }),
    );
    expect(own.count).toBe(1);
  });

  it('10/12/13. context switches: B sees B, back to A sees A', async () => {
    expect((await find({ tenantId: B })).every((r) => r.tenantId === B)).toBe(
      true,
    );
    expect((await find({ tenantId: A })).every((r) => r.tenantId === A)).toBe(
      true,
    );
  });

  it('7b/8b/12b. writes with no tenant context are denied', async () => {
    await expect(
      prisma.withAuthContext({ userId: U }, (tx) =>
        tx.membership.create({ data: { id: newId(), userId: U, tenantId: A } }),
      ),
    ).rejects.toThrow();
    const upd = await prisma.withAuthContext({ userId: U }, (tx) =>
      tx.membership.updateMany({
        where: { id: mUA },
        data: { status: 'inactive' },
      }),
    );
    expect(upd.count).toBe(0);
  });

  it('14. tenant context does not leak to a later query on the pool', async () => {
    await find({ tenantId: A }); // sets app.tenant_id transaction-locally
    // A bare query (no withAuthContext) must observe no context → zero rows.
    const leaked = await prisma.membership.findMany({ select: { id: true } });
    expect(leaked).toHaveLength(0);
  });

  it('15/16. concurrent A/B contexts never cross-contaminate (pooled)', async () => {
    const runs = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const t = i % 2 === 0 ? A : B;
        return find({ tenantId: t }).then((rows) => ({ t, rows }));
      }),
    );
    for (const { t, rows } of runs) {
      expect(rows.every((r) => r.tenantId === t)).toBe(true);
      expect(rows).toHaveLength(2);
    }
  });
});
