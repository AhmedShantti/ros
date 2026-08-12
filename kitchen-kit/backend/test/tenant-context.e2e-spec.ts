import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AccessTokenService } from './../src/modules/identity/auth/access-token.service';
import { IDENTITY_PERMISSIONS } from './../src/modules/identity/authz/permissions.constants';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
}
interface PermsBody {
  permissions: string[];
}
const password = 's3cure-passphrase';
const ROLE_READ = IDENTITY_PERMISSIONS.ROLE_READ;

function tamperClaim(token: string, key: string, value: string): string {
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  payload[key] = value;
  const p2 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p2}.${s}`;
}

describe('TenantContext (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient; // migrator/superuser client for RLS-table arrange
  let http: App;
  let tokens: AccessTokenService;

  const emailU = `ctx.u.${Date.now()}@example.com`;
  const emailV = `ctx.v.${Date.now()}@example.com`;

  let uId: string;
  let vId: string;
  let tenantAId: string;
  let tenantBId: string;
  let mUAId: string; // U in A (has role.read)
  let mUBId: string; // U in B (no roles)
  let mVAId: string; // V in A

  const scoped = async (email: string, tenantId: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .send({ tenantId })
      .expect(200);
    return (sel.body as Tokens).accessToken;
  };

  const perms = async (token: string, query = ''): Promise<number> => {
    const res = await request(http)
      .get(`/auth/permissions${query}`)
      .set('Authorization', `Bearer ${token}`);
    return res.status;
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();
    tokens = app.get(AccessTokenService);

    await app.get(PermissionsService).ensureIdentityPermissions();

    const users = app.get(UsersService);
    uId = (
      await users.createUser({ email: emailU, password, displayName: 'U' })
    ).id;
    vId = (
      await users.createUser({ email: emailV, password, displayName: 'V' })
    ).id;

    const tenants = app.get(TenantsService);
    tenantAId = (
      await tenants.create({
        slug: `a-${Date.now()}`,
        legalName: 'A',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantBId = (
      await tenants.create({
        slug: `b-${Date.now()}`,
        legalName: 'B',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const memberships = app.get(MembershipsService);
    mUAId = (await memberships.grant(uId, tenantAId, 'active')).id;
    mUBId = (await memberships.grant(uId, tenantBId, 'active')).id;
    mVAId = (await memberships.grant(vId, tenantAId, 'active')).id;

    const roles = app.get(RolesService);
    const readerA = await roles.createTenantRole(tenantAId, { name: 'reader' });
    await roles.addPermissions(tenantAId, readerA.id, [
      ROLE_READ,
      IDENTITY_PERMISSIONS.ROLE_CREATE,
    ]);
    await app.get(MembershipRolesService).assign(tenantAId, mUAId, readerA.id);
  });

  afterAll(async () => {
    await prisma.user
      .deleteMany({ where: { id: { in: [uId, vId] } } })
      .catch(() => undefined);
    await prisma.tenant
      .deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  it('1. valid tenant context succeeds', async () => {
    const token = await scoped(emailU, tenantAId);
    const res = await request(http)
      .get('/auth/permissions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((res.body as PermsBody).permissions).toContain(ROLE_READ);
  });

  it('2. no tenant context is rejected (403) on a tenant-scoped endpoint', async () => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email: emailU, password })
      .expect(200);
    expect(await perms((login.body as Tokens).accessToken)).toBe(403);
  });

  it('3. inactive membership is rejected', async () => {
    const token = await scoped(emailU, tenantAId);
    await admin.membership.update({
      where: { id: mUAId },
      data: { status: 'inactive' },
    });
    expect(await perms(token)).toBe(403);
    await admin.membership.update({
      where: { id: mUAId },
      data: { status: 'active' },
    });
  });

  it('4. inactive tenant is rejected', async () => {
    const token = await scoped(emailU, tenantAId);
    await prisma.tenant.update({
      where: { id: tenantAId },
      data: { status: 'suspended' },
    });
    expect(await perms(token)).toBe(403);
    await prisma.tenant.update({
      where: { id: tenantAId },
      data: { status: 'active' },
    });
  });

  it('5. a membership belonging to another user is rejected', async () => {
    // Forge a token claiming V's membership for user U.
    const token = await tokens.sign({
      sub: uId,
      sid: 'forged',
      tid: tenantAId,
      mid: mVAId,
    });
    expect(await perms(token)).toBe(403);
  });

  it('6. a membership belonging to another tenant is rejected', async () => {
    // Forge a token claiming U's tenant-A membership under tenant B.
    const token = await tokens.sign({
      sub: uId,
      sid: 'forged',
      tid: tenantBId,
      mid: mUAId,
    });
    expect(await perms(token)).toBe(403);
  });

  it('7. a tampered tenantId claim is rejected (401)', async () => {
    const token = await scoped(emailU, tenantAId);
    const tampered = tamperClaim(token, 'tid', tenantBId);
    expect(await perms(tampered)).toBe(401);
  });

  it('8. a tampered membershipId claim is rejected (401)', async () => {
    const token = await scoped(emailU, tenantAId);
    const tampered = tamperClaim(token, 'mid', mVAId);
    expect(await perms(tampered)).toBe(401);
  });

  it('9. x-tenant-id header cannot override the JWT context', async () => {
    const token = await scoped(emailU, tenantAId);
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', tenantBId)
      .expect(200); // still tenant A, where U has role.read
  });

  it('10. x-membership-id header cannot override the JWT context', async () => {
    const token = await scoped(emailU, tenantAId);
    const res = await request(http)
      .get('/auth/permissions')
      .set('Authorization', `Bearer ${token}`)
      .set('x-membership-id', mUBId)
      .expect(200);
    expect((res.body as PermsBody).permissions).toContain(ROLE_READ);
  });

  it('11. a client body tenantId cannot override the context', async () => {
    const token = await scoped(emailU, tenantAId);
    // A client-supplied tenantId is an unknown field → rejected by the whitelist.
    await request(http)
      .post('/auth/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `bad-${Date.now()}`, tenantId: tenantBId })
      .expect(400);

    // A valid create lands in the CONTEXT tenant (A), never a client-chosen one.
    const name = `ctx-${Date.now()}`;
    await request(http)
      .post('/auth/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);
    const created = await admin.role.findFirstOrThrow({ where: { name } });
    expect(created.tenantId).toBe(tenantAId);
  });

  it('12. a client query tenantId cannot override the context', async () => {
    const token = await scoped(emailU, tenantAId);
    const res = await request(http)
      .get('/auth/permissions?tenantId=' + tenantBId)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((res.body as PermsBody).permissions).toContain(ROLE_READ);
  });

  it('13. context follows the selected tenant (A grants, B does not)', async () => {
    const tokenA = await scoped(emailU, tenantAId);
    const tokenB = await scoped(emailU, tenantBId);
    const inA = (
      await request(http)
        .get('/auth/permissions')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200)
    ).body as PermsBody;
    const inB = (
      await request(http)
        .get('/auth/permissions')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200)
    ).body as PermsBody;
    expect(inA.permissions).toContain(ROLE_READ);
    expect(inB.permissions).not.toContain(ROLE_READ);
  });

  it('17. no cross-request context leakage under concurrency', async () => {
    const tokenA = await scoped(emailU, tenantAId);
    const tokenB = await scoped(emailU, tenantBId);
    const calls = Array.from({ length: 8 }, (_, i) =>
      request(http)
        .get('/auth/permissions')
        .set('Authorization', `Bearer ${i % 2 === 0 ? tokenA : tokenB}`)
        .then((r) => ({ i, perms: (r.body as PermsBody).permissions })),
    );
    const results = await Promise.all(calls);
    for (const { i, perms: p } of results) {
      if (i % 2 === 0) expect(p).toContain(ROLE_READ);
      else expect(p).not.toContain(ROLE_READ);
    }
  });
});
