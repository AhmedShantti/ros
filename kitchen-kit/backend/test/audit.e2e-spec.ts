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
import { SENTINEL_TENANT_ID } from './../src/modules/governance/audit/audit.constants';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}
type AuditRow = {
  tenantId: string;
  sequenceNo: bigint;
  action: string;
  actorId: string | null;
  actorType: string;
  entryHash: Uint8Array;
  previousHash: Uint8Array | null;
  beforeState: unknown;
  afterState: unknown;
  reasonText: string | null;
};

const password = 'orig-audit-pw-123';

describe('Audit trail (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let http: App;

  let tenantId: string; // this suite's tenant → its own audit chain
  let otherTenantId: string; // for RLS isolation
  const emailAdmin = `audit.admin.${Date.now()}@example.com`;
  const emailUser = `audit.user.${Date.now()}@example.com`;
  let adminUserId: string;
  let targetMembershipId: string;

  const login = (email: string) =>
    request(http).post('/auth/login').send({ email, password });
  const scoped = async (email: string, tId: string): Promise<Tokens> => {
    const l = (await login(email).expect(200)).body as Tokens;
    const s = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${l.accessToken}`)
      .send({ tenantId: tId })
      .expect(200);
    return { ...(s.body as Tokens), refreshToken: l.refreshToken };
  };
  const auditFor = (where: object): Promise<AuditRow[]> =>
    admin.auditEntry.findMany({
      where,
      orderBy: { sequenceNo: 'asc' },
    });

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

    await app.get(PermissionsService).ensureIdentityPermissions();
    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    tenantId = (
      await tenants.create({
        slug: `aud-${Date.now()}`,
        legalName: 'Audit',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    otherTenantId = (
      await tenants.create({
        slug: `aud2-${Date.now()}`,
        legalName: 'Audit2',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    adminUserId = (
      await users.createUser({ email: emailAdmin, password, displayName: 'A' })
    ).id;
    const adminMembership = await memberships.grant(
      adminUserId,
      tenantId,
      'active',
    );
    const role = await roles.createTenantRole(tenantId, { name: 'auditor' });
    await roles.addPermissions(tenantId, role.id, [
      IDENTITY_PERMISSIONS.ROLE_READ,
      IDENTITY_PERMISSIONS.ROLE_ASSIGN,
      IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
      IDENTITY_PERMISSIONS.TERMINAL_READ,
    ]);
    await membershipRoles.assign(tenantId, adminMembership.id, role.id);

    const targetUserId = (
      await users.createUser({ email: emailUser, password, displayName: 'U' })
    ).id;
    targetMembershipId = (
      await memberships.grant(targetUserId, tenantId, 'active')
    ).id;
  });

  afterAll(async () => {
    await admin.auditEntry
      .deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
      .catch(() => undefined);
    await admin.auditEntry
      .deleteMany({ where: { actorId: { in: [adminUserId] } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { email: { in: [emailAdmin, emailUser] } } })
      .catch(() => undefined);
    await admin.tenant
      .deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  it('records authentication events on the sentinel chain (success/failure/logout)', async () => {
    await login(emailAdmin).expect(200);
    await request(http)
      .post('/auth/login')
      .send({ email: emailAdmin, password: 'wrong' })
      .expect(401);
    const tok = (await login(emailAdmin).expect(200)).body as Tokens;
    await request(http)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .expect(204);

    const mine = await auditFor({
      tenantId: SENTINEL_TENANT_ID,
      actorId: adminUserId,
    });
    const actions = mine.map((r) => r.action);
    expect(actions).toContain('LOGIN_SUCCESS');
    expect(actions).toContain('LOGOUT');
    const failures = await auditFor({
      tenantId: SENTINEL_TENANT_ID,
      action: 'LOGIN_FAILURE',
      actorType: 'anonymous',
    });
    expect(failures.length).toBeGreaterThan(0);
  });

  it('records tenant selection, role assignment and terminal registration on the tenant chain', async () => {
    const tok = await scoped(emailAdmin, tenantId);
    await request(http)
      .post(`/auth/memberships/${targetMembershipId}/roles`)
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .send({
        roleId: (
          await admin.role.findFirstOrThrow({
            where: { tenantId, name: 'auditor' },
          })
        ).id,
      })
      .expect(204);
    // A real branch: `terminals` now carries a tenant-safe composite FK to
    // `org.branches` (D-2 amendment item 3), so a fabricated UUID is rejected.
    const auditBrand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `AuditBrand ${Date.now()}` },
    });
    const auditBranch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: auditBrand.id,
        code: `AU${Date.now() % 10000}`,
        name: 'Audit Branch',
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
        refId: auditBranch.id,
        branchId: auditBranch.id,
      },
    });

    await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .send({
        name: `POS-${Date.now()}`,
        terminalType: 'pos',
        branchId: auditBranch.id,
      })
      .expect(201);

    const rows = await auditFor({ tenantId });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('TENANT_SELECTED');
    expect(actions).toContain('ROLE_ASSIGNED');
    expect(actions).toContain('TERMINAL_REGISTERED');
  });

  it('records password lifecycle events', async () => {
    const tok = (await login(emailAdmin).expect(200)).body as Tokens;
    await request(http)
      .post('/auth/password/change')
      .set('Authorization', `Bearer ${tok.accessToken}`)
      .send({ currentPassword: password, newPassword: 'new-audit-pw-123' })
      .expect(204);
    await request(http)
      .post('/auth/password/forgot')
      .send({ email: emailAdmin })
      .expect(202);

    const mine = await auditFor({
      tenantId: SENTINEL_TENANT_ID,
      actorId: adminUserId,
    });
    const actions = mine.map((r) => r.action);
    expect(actions).toContain('PASSWORD_CHANGED');
    expect(actions).toContain('PASSWORD_RESET_REQUESTED');
    // restore password for any later re-runs is unnecessary (unique emails).
  });

  it('the tenant chain is consecutive and hash-linked (tamper-evident)', async () => {
    const rows = await auditFor({ tenantId });
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].sequenceNo).toBe(BigInt(i + 1)); // consecutive from 1
      expect(rows[i].entryHash).toHaveLength(32);
      if (i === 0) {
        expect(rows[i].previousHash).toBeNull();
      } else {
        expect(Buffer.from(rows[i].previousHash!)).toEqual(
          Buffer.from(rows[i - 1].entryHash),
        );
      }
    }
  });

  it('never stores secrets (password/token) in audit records', async () => {
    const rows = [
      ...(await auditFor({ tenantId })),
      ...(await auditFor({
        tenantId: SENTINEL_TENANT_ID,
        actorId: adminUserId,
      })),
    ];
    for (const r of rows) {
      const blob = JSON.stringify({
        before: r.beforeState,
        after: r.afterState,
        reason: r.reasonText,
      });
      expect(blob).not.toContain(password);
      expect(blob).not.toContain('new-audit-pw-123');
      expect(blob.toLowerCase()).not.toContain('bearer ');
    }
  });

  it('is append-only for the runtime role (ros_app cannot UPDATE or DELETE)', async () => {
    await expect(
      prisma.auditEntry.updateMany({
        where: { tenantId },
        data: { action: 'TAMPERED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.auditEntry.deleteMany({ where: { tenantId } }),
    ).rejects.toThrow();
  });

  it('RLS isolates audit entries per tenant for the runtime role', async () => {
    const seenUnderOther = await prisma.withAuthContext(
      { tenantId: otherTenantId },
      (tx) => tx.auditEntry.findMany({ select: { tenantId: true } }),
    );
    expect(seenUnderOther.every((r) => r.tenantId === otherTenantId)).toBe(
      true,
    );
    const seenUnderMine = await prisma.withAuthContext({ tenantId }, (tx) =>
      tx.auditEntry.findMany({ select: { tenantId: true } }),
    );
    expect(seenUnderMine.length).toBeGreaterThan(0);
    expect(seenUnderMine.every((r) => r.tenantId === tenantId)).toBe(true);
  });
});
