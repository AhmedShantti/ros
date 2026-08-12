import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { PrismaService } from './../src/prisma/prisma.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
interface TenantContextBody {
  tenantId: string | null;
  membershipId: string | null;
}
interface SelectBody {
  accessToken: string;
  tenant: { id: string };
  membership: { membershipId: string };
}
interface MembershipListItem {
  membershipId: string;
  tenant: { id: string };
}

describe('Tenants & memberships (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let memberships: MembershipsService;
  let http: App;

  let userId: string;
  let tenantAId: string;
  let tenantBId: string;
  let membershipAId: string;

  const email = `tenant.e2e.${Date.now()}@example.com`;
  const password = 's3cure-passphrase';

  const login = async (): Promise<TokenPair> => {
    const res = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return res.body as TokenPair;
  };

  const context = async (accessToken: string): Promise<TenantContextBody> => {
    const res = await request(http)
      .get('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return res.body as TenantContextBody;
  };

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
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    memberships = app.get(MembershipsService);
    http = app.getHttpServer();

    const user = await app
      .get(UsersService)
      .createUser({ email, password, displayName: 'Tenant E2E' });
    userId = user.id;

    const tenants = app.get(TenantsService);
    const a = await tenants.create({
      slug: `a-${Date.now()}`,
      legalName: 'Tenant A',
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    const b = await tenants.create({
      slug: `b-${Date.now()}`,
      legalName: 'Tenant B',
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    tenantAId = a.id;
    tenantBId = b.id;

    const membershipA = await memberships.grant(userId, tenantAId, 'active');
    membershipAId = membershipA.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.tenant
      .deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } })
      .catch(() => undefined);
    await app.close();
  });

  it('lists only the tenants the user is an active member of', async () => {
    const { accessToken } = await login();
    const res = await request(http)
      .get('/auth/tenants')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const list = res.body as MembershipListItem[];
    const tenantIds = list.map((m) => m.tenant.id);
    expect(tenantIds).toContain(tenantAId);
    expect(tenantIds).not.toContain(tenantBId);
  });

  it('exposes no tenant context before selection', async () => {
    const { accessToken } = await login();
    expect(await context(accessToken)).toEqual({
      tenantId: null,
      membershipId: null,
    });
  });

  it('selects the single authorized tenant and propagates context', async () => {
    const { accessToken } = await login();
    const res = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tenantId: tenantAId })
      .expect(200);
    const body = res.body as SelectBody;
    expect(body.tenant.id).toBe(tenantAId);

    // The tenant-scoped token carries the context through the guard.
    expect(await context(body.accessToken)).toEqual({
      tenantId: tenantAId,
      membershipId: membershipAId,
    });
  });

  it('rejects selecting an unrelated tenant (no membership) with 403', async () => {
    const { accessToken } = await login();
    await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tenantId: tenantBId })
      .expect(403);
  });

  it('returns a generic 403 for a non-existent tenant', async () => {
    const { accessToken } = await login();
    await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tenantId: newId() })
      .expect(403);
  });

  it('rejects selection when the membership is inactive', async () => {
    await memberships.setStatus(tenantAId, membershipAId, 'inactive');
    const { accessToken } = await login();
    await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tenantId: tenantAId })
      .expect(403);
    await memberships.setStatus(tenantAId, membershipAId, 'active'); // restore
  });

  it('lets a user with multiple memberships select each authorized tenant', async () => {
    await memberships.grant(userId, tenantBId, 'active');
    const { accessToken } = await login();

    await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tenantId: tenantAId })
      .expect(200);
    await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ tenantId: tenantBId })
      .expect(200);

    const res = await request(http)
      .get('/auth/tenants')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const tenantIds = (res.body as MembershipListItem[]).map(
      (m) => m.tenant.id,
    );
    expect(tenantIds).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
  });

  it('preserves tenant context across a refresh', async () => {
    // Fresh session, select tenant A (binds the session's membership)...
    const pair = await login();
    await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${pair.accessToken}`)
      .send({ tenantId: tenantAId })
      .expect(200);

    // ...then rotate that session's refresh token and confirm context survives.
    const refreshed = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: pair.refreshToken })
      .expect(200);
    const refreshedPair = refreshed.body as TokenPair;

    expect(await context(refreshedPair.accessToken)).toMatchObject({
      tenantId: tenantAId,
    });
  });
});
