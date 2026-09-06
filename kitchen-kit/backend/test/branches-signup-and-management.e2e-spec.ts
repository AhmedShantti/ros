import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * DEMO-BRANCH-SETUP-HOTFIX — proves the exact contract the Branches page
 * (and the Operations -> Stations page's branch selector) relies on:
 * signup's real "Main" branch is visible via both `GET /org/branches`
 * (tenant-owner-only) and `GET /org/access` (the live scoped-access read
 * every session-context consumer, including the branch/brand switcher,
 * actually uses), a second branch can be created through the real API using
 * only the tenant's existing brand (no invented ids), and cross-tenant
 * branch access is rejected.
 */

describe('Branches — signup visibility + real management (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;

  const createdTenantIds: string[] = [];

  async function signUpOwner() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(http)
      .post('/auth/registrations')
      .send({
        fullName: 'Branch Hotfix Owner',
        email: `branch.hotfix.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: `Branch Hotfix Restaurant ${stamp}`,
        password: 's3cure-passphrase-10+',
      })
      .expect(201);
    const out = res.body as {
      auth: { accessToken: string };
      tenant: { id: string };
    };
    createdTenantIds.push(out.tenant.id);
    return { tenantId: out.tenant.id, accessToken: out.auth.accessToken };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('signup owner immediately sees the real "Main" branch via GET /org/branches', async () => {
    const { accessToken } = await signUpOwner();

    const branches = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const rows = branches.body as { id: string; name: string; brandId: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Main');
  });

  it('the same branch is visible via GET /org/access (what the session/branch-switcher actually reads)', async () => {
    const { accessToken } = await signUpOwner();

    const access = await request(http)
      .get('/org/access')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const body = access.body as {
      brands: { id: string }[];
      branches: { id: string; name: string }[];
    };
    expect(body.brands).toHaveLength(1);
    expect(body.branches).toHaveLength(1);
    expect(body.branches[0].name).toBe('Main');
  });

  it('owner can create a second branch using only the tenant\'s existing brand, and it appears in both org/branches and org/access', async () => {
    const { accessToken } = await signUpOwner();

    const brands = await request(http)
      .get('/org/brands')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const brandId = (brands.body as { id: string }[])[0].id;

    const created = await request(http)
      .post('/org/branches')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        brandId,
        code: `B2-${Date.now()}`.slice(0, 16),
        name: 'Downtown',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      })
      .expect(201);
    const secondBranchId = (created.body as { id: string }).id;

    const branches = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect((branches.body as { id: string }[]).map((b) => b.id)).toEqual(
      expect.arrayContaining([secondBranchId]),
    );

    const access = await request(http)
      .get('/org/access')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(
      (access.body as { branches: { id: string }[] }).branches.map((b) => b.id),
    ).toEqual(expect.arrayContaining([secondBranchId]));
  });

  it('cross-tenant branch access is rejected (404, RLS-invisible)', async () => {
    const ownerA = await signUpOwner();
    const ownerB = await signUpOwner();

    const branchesA = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .expect(200);
    const branchIdA = (branchesA.body as { id: string }[])[0].id;

    await request(http)
      .get(`/org/branches/${branchIdA}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);
  });
});
