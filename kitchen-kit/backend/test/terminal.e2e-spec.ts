import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { IDENTITY_PERMISSIONS } from './../src/modules/identity/authz/permissions.constants';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { hashDeviceFingerprint } from './../src/modules/identity/terminals/device-fingerprint';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
}
interface TerminalBody {
  id: string;
  tenantId: string;
  branchId: string;
  status: string;
}
const password = 's3cure-passphrase';
// Real branches: `terminals` now carries a tenant-safe composite FK to
// `org.branches` (D-2 amendment item 3), so a fabricated UUID is no longer a
// valid branch. The fixture creates genuine rows instead of inventing ids.
let branchA: string;
let branchB: string;

function tamper(token: string, key: string, value: string): string {
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  payload[key] = value;
  return `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
}

describe('Terminals (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const emailAdminA = `term.adminA.${Date.now()}@example.com`;
  const emailPlainA = `term.plainA.${Date.now()}@example.com`;
  const emailAdminB = `term.adminB.${Date.now()}@example.com`;

  let tenantAId: string;
  let tenantBId: string;
  const userIds: string[] = [];
  let bTerminalId: string;

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
    admin = createMigratorClient(app);
    http = app.getHttpServer();

    await app.get(PermissionsService).ensureIdentityPermissions();
    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    tenantAId = (
      await tenants.create({
        slug: `ta-${Date.now()}`,
        legalName: 'A',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantBId = (
      await tenants.create({
        slug: `tb-${Date.now()}`,
        legalName: 'B',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mk = async (
      email: string,
      tenantId: string,
      withTerminalPerms: boolean,
    ) => {
      const u = await users.createUser({ email, password, displayName: 'T' });
      userIds.push(u.id);
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (withTerminalPerms) {
        const role = await roles.createTenantRole(tenantId, {
          name: `term-admin-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, [
          IDENTITY_PERMISSIONS.TERMINAL_READ,
          IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
        ]);
        await membershipRoles.create(tenantId, null, {
          membershipId: m.id,
          roleId: role.id,
          scope: { type: 'tenant' },
        });
      }
      return u.id;
    };
    const mkBranch = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `Brand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `Branch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      await admin.location.create({
        data: {
          id: newId(),
          tenantId,
          locationType: 'branch',
          refId: branch.id,
          branchId: branch.id,
        },
      });
      return branch.id;
    };
    branchA = await mkBranch(tenantAId, `TA${Date.now() % 10000}`);
    branchB = await mkBranch(tenantBId, `TB${Date.now() % 10000}`);

    await mk(emailAdminA, tenantAId, true);
    await mk(emailPlainA, tenantAId, false);
    await mk(emailAdminB, tenantBId, true);

    // A terminal in tenant B (for cross-tenant tests).
    const tokenB = await scoped(emailAdminB, tenantBId);
    const res = await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B-POS', terminalType: 'pos', branchId: branchB })
      .expect(201);
    bTerminalId = (res.body as TerminalBody).id;
  });

  afterAll(async () => {
    await admin.tenant
      .deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } })
      .catch(() => undefined);
    await admin.user
      .deleteMany({ where: { id: { in: userIds } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  it('1. authorized admin registers a terminal in its tenant', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    const res = await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A-POS-1', terminalType: 'pos', branchId: branchA })
      .expect(201);
    expect((res.body as TerminalBody).tenantId).toBe(tenantAId);
  });

  it('2. a member without terminal permission is forbidden', async () => {
    const token = await scoped(emailPlainA, tenantAId);
    await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'nope', terminalType: 'pos', branchId: branchA })
      .expect(403);
  });

  it('3. no tenant context is rejected', async () => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email: emailAdminA, password })
      .expect(200);
    await request(http)
      .get('/auth/terminals')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .expect(403);
  });

  it('4/5. tenant A cannot see or modify a tenant B terminal', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    const list = await request(http)
      .get('/auth/terminals')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((list.body as TerminalBody[]).map((t) => t.id)).not.toContain(
      bTerminalId,
    );
    await request(http)
      .post(`/auth/terminals/${bTerminalId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'revoked' })
      .expect(404);
  });

  it('7/16. client-supplied tenantId cannot place a terminal in another tenant', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'spoof',
        terminalType: 'pos',
        branchId: branchA,
        tenantId: tenantBId,
      })
      .expect(400); // unknown field rejected by whitelist
  });

  it('8/18/25. cannot bind a session to another tenant terminal', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    await request(http)
      .post('/auth/terminal')
      .set('Authorization', `Bearer ${token}`)
      .send({ terminalId: bTerminalId })
      .expect(404);
  });

  it('10. invalid terminal id → 404', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    await request(http)
      .post('/auth/terminal')
      .set('Authorization', `Bearer ${token}`)
      .send({ terminalId: newId() })
      .expect(404);
  });

  it('11/12. disabled or revoked terminal cannot be bound', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    const created = (
      await request(http)
        .post('/auth/terminals')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'A-POS-off', terminalType: 'pos', branchId: branchA })
        .expect(201)
    ).body as TerminalBody;

    for (const status of ['disabled', 'revoked'] as const) {
      await request(http)
        .post(`/auth/terminals/${created.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status })
        .expect(201);
      await request(http)
        .post('/auth/terminal')
        .set('Authorization', `Bearer ${token}`)
        .send({ terminalId: created.id })
        .expect(403);
    }
  });

  it('13. duplicate terminal registration → 409', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    const body = { name: 'A-DUP', terminalType: 'pos', branchId: branchA };
    await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);
  });

  it('14. duplicate device fingerprint is idempotent', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    const created = (
      await request(http)
        .post('/auth/terminals')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'A-FP', terminalType: 'pos', branchId: branchA })
        .expect(201)
    ).body as TerminalBody;
    const fp = { deviceFingerprint: 'device-xyz', os: 'iOS' };
    await request(http)
      .post(`/auth/terminals/${created.id}/fingerprints`)
      .set('Authorization', `Bearer ${token}`)
      .send(fp)
      .expect(204);
    await request(http)
      .post(`/auth/terminals/${created.id}/fingerprints`)
      .set('Authorization', `Bearer ${token}`)
      .send(fp)
      .expect(204);
  });

  it('22. device fingerprints are stored only as hashes', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    const raw = 'super-secret-device-id';
    const created = (
      await request(http)
        .post('/auth/terminals')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'A-HASH',
          terminalType: 'pos',
          branchId: branchA,
          deviceFingerprint: raw,
        })
        .expect(201)
    ).body as TerminalBody;
    const rows = await admin.deviceFingerprint.findMany({
      where: { terminalId: created.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].fingerprintHash).toBe(hashDeviceFingerprint(raw));
    expect(rows[0].fingerprintHash).not.toContain(raw);
  });

  it('23/24. terminal-bound session carries the terminal; a tampered trm is rejected', async () => {
    const token = await scoped(emailAdminA, tenantAId);
    const created = (
      await request(http)
        .post('/auth/terminals')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'A-BIND', terminalType: 'pos', branchId: branchA })
        .expect(201)
    ).body as TerminalBody;

    const bound = (
      await request(http)
        .post('/auth/terminal')
        .set('Authorization', `Bearer ${token}`)
        .send({ terminalId: created.id })
        .expect(200)
    ).body as Tokens;

    const ctx = await request(http)
      .get('/auth/terminal')
      .set('Authorization', `Bearer ${bound.accessToken}`)
      .expect(200);
    expect((ctx.body as { terminalId: string }).terminalId).toBe(created.id);

    // Re-pointing trm to another terminal breaks the signature → 401.
    await request(http)
      .get('/auth/terminal')
      .set(
        'Authorization',
        `Bearer ${tamper(bound.accessToken, 'trm', bTerminalId)}`,
      )
      .expect(401);
  });
});
