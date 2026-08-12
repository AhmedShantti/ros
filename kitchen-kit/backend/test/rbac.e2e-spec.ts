import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { IDENTITY_PERMISSIONS } from './../src/modules/identity/authz/permissions.constants';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { newId } from './../src/common/ids';
import { PrismaService } from './../src/prisma/prisma.service';

interface Tokens {
  accessToken: string;
}
interface PermsBody {
  permissions: string[];
}
const BIZ_PERM = 'sales.order.read';
const password = 's3cure-passphrase';

describe('RBAC (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;
  let roles: RolesService;
  let memberships: MembershipsService;
  let membershipRoles: MembershipRolesService;

  const emailAdmin = `rbac.admin.${Date.now()}@example.com`;
  const emailUser = `rbac.user.${Date.now()}@example.com`;

  let userAdminId: string;
  let userOtherId: string;
  let tenantAId: string;
  let tenantBId: string;
  let mAId: string; // admin user in tenant A
  let mBId: string; // admin user in tenant B (viewer)
  let mA2Id: string; // other user in tenant A
  let roleAdminAId: string;
  let roleReaderAId: string;
  let roleNoopAId: string;
  let roleViewerBId: string;
  let systemRoleId: string;

  const scoped = async (email: string, tenantId: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const { accessToken } = login.body as Tokens;
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${accessToken}`)
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

    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    roles = app.get(RolesService);
    memberships = app.get(MembershipsService);
    membershipRoles = app.get(MembershipRolesService);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsert({
      code: BIZ_PERM,
      module: 'sales',
      description: 'Read sales orders (test permission)',
    });

    const users = app.get(UsersService);
    userAdminId = (
      await users.createUser({
        email: emailAdmin,
        password,
        displayName: 'Admin',
      })
    ).id;
    userOtherId = (
      await users.createUser({
        email: emailUser,
        password,
        displayName: 'Other',
      })
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

    mAId = (await memberships.grant(userAdminId, tenantAId, 'active')).id;
    mBId = (await memberships.grant(userAdminId, tenantBId, 'active')).id;
    mA2Id = (await memberships.grant(userOtherId, tenantAId, 'active')).id;

    // Tenant A roles.
    roleAdminAId = (
      await roles.createTenantRole(tenantAId, { name: 'admin_A' })
    ).id;
    await roles.addPermissions(tenantAId, roleAdminAId, [
      IDENTITY_PERMISSIONS.ROLE_READ,
      IDENTITY_PERMISSIONS.ROLE_CREATE,
      IDENTITY_PERMISSIONS.ROLE_UPDATE,
      IDENTITY_PERMISSIONS.ROLE_ASSIGN,
    ]);
    await membershipRoles.assign(tenantAId, mAId, roleAdminAId);

    roleReaderAId = (
      await roles.createTenantRole(tenantAId, { name: 'reader_A' })
    ).id;
    await roles.addPermissions(tenantAId, roleReaderAId, [
      IDENTITY_PERMISSIONS.ROLE_READ,
    ]);
    roleNoopAId = (await roles.createTenantRole(tenantAId, { name: 'noop_A' }))
      .id;
    await roles.addPermissions(tenantAId, roleNoopAId, [BIZ_PERM]);

    // Tenant B role: no identity permissions, only a business permission.
    roleViewerBId = (
      await roles.createTenantRole(tenantBId, { name: 'viewer_B' })
    ).id;
    await roles.addPermissions(tenantBId, roleViewerBId, [BIZ_PERM]);
    await membershipRoles.assign(tenantBId, mBId, roleViewerBId);

    // A protected system role (seeded out-of-band).
    systemRoleId = (
      await prisma.role.create({
        data: {
          id: newId(),
          tenantId: null,
          name: 'platform_admin',
          isSystem: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.user
      .deleteMany({ where: { id: { in: [userAdminId, userOtherId] } } })
      .catch(() => undefined);
    await prisma.tenant
      .deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } })
      .catch(() => undefined);
    await prisma.role
      .delete({ where: { id: systemRoleId } })
      .catch(() => undefined);
    await app.close();
  });

  it('1. grants access with the required permission (200)', async () => {
    const token = await scoped(emailAdmin, tenantAId);
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('2. denies an authenticated user without the permission (403)', async () => {
    const token = await scoped(emailAdmin, tenantBId);
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('3. rejects an unauthenticated request (401)', () =>
    request(http).get('/auth/roles').expect(401));

  it('10/11. authorization context follows the selected tenant', async () => {
    const inA = await scoped(emailAdmin, tenantAId);
    const inB = await scoped(emailAdmin, tenantBId);

    const permsA = (
      await request(http)
        .get('/auth/permissions')
        .set('Authorization', `Bearer ${inA}`)
        .expect(200)
    ).body as PermsBody;
    const permsB = (
      await request(http)
        .get('/auth/permissions')
        .set('Authorization', `Bearer ${inB}`)
        .expect(200)
    ).body as PermsBody;

    expect(permsA.permissions).toContain(IDENTITY_PERMISSIONS.ROLE_READ);
    expect(permsB.permissions).not.toContain(IDENTITY_PERMISSIONS.ROLE_READ);
    expect(permsB.permissions).toContain(BIZ_PERM);
  });

  it('4/6. permission via one of multiple roles, revoked when the role is removed', async () => {
    const adminTok = await scoped(emailAdmin, tenantAId);
    const otherTok = await scoped(emailUser, tenantAId);

    // No roles yet -> 403.
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${otherTok}`)
      .expect(403);

    // Assign two roles; only reader_A grants identity.role.read.
    await request(http)
      .post(`/auth/memberships/${mA2Id}/roles`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ roleId: roleNoopAId })
      .expect(204);
    await request(http)
      .post(`/auth/memberships/${mA2Id}/roles`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ roleId: roleReaderAId })
      .expect(204);

    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${otherTok}`)
      .expect(200);

    // Remove reader_A from the membership -> access revoked (live).
    await request(http)
      .delete(`/auth/memberships/${mA2Id}/roles/${roleReaderAId}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .expect(204);
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${otherTok}`)
      .expect(403);
  });

  it('5. revokes access when a permission is removed from a role', async () => {
    const adminTok = await scoped(emailAdmin, tenantAId);
    const otherTok = await scoped(emailUser, tenantAId);

    await request(http)
      .post(`/auth/memberships/${mA2Id}/roles`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ roleId: roleReaderAId })
      .expect(204);
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${otherTok}`)
      .expect(200);

    // Strip the permission from the role at the DB level.
    const perm = await prisma.permission.findUniqueOrThrow({
      where: { code: IDENTITY_PERMISSIONS.ROLE_READ },
    });
    await prisma.rolePermission.delete({
      where: {
        roleId_permissionId: { roleId: roleReaderAId, permissionId: perm.id },
      },
    });

    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${otherTok}`)
      .expect(403);

    // Restore for isolation.
    await roles.addPermissions(tenantAId, roleReaderAId, [
      IDENTITY_PERMISSIONS.ROLE_READ,
    ]);
  });

  it('7. cannot assign a role from another tenant or target a foreign membership', async () => {
    const adminTok = await scoped(emailAdmin, tenantAId);
    // Tenant B role onto a tenant A membership.
    await request(http)
      .post(`/auth/memberships/${mA2Id}/roles`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ roleId: roleViewerBId })
      .expect(404);
    // Tenant A role onto a tenant B membership.
    await request(http)
      .post(`/auth/memberships/${mBId}/roles`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ roleId: roleReaderAId })
      .expect(404);
  });

  it('8. a cross-tenant role grants nothing even if wrongly attached', async () => {
    // Simulate a bad row: tenant B role attached to a tenant A membership.
    await prisma.membershipRole.create({
      data: { membershipId: mAId, roleId: roleViewerBId },
    });
    try {
      const token = await scoped(emailAdmin, tenantAId);
      const perms = (
        await request(http)
          .get('/auth/permissions')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as PermsBody;
      expect(perms.permissions).not.toContain(BIZ_PERM);
    } finally {
      await prisma.membershipRole.delete({
        where: {
          membershipId_roleId: { membershipId: mAId, roleId: roleViewerBId },
        },
      });
    }
  });

  it('9. a tenant admin cannot modify or assign a protected system role', async () => {
    const adminTok = await scoped(emailAdmin, tenantAId);
    await request(http)
      .post(`/auth/roles/${systemRoleId}/permissions`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ permissionCodes: [IDENTITY_PERMISSIONS.ROLE_READ] })
      .expect(403);
    await request(http)
      .post(`/auth/memberships/${mA2Id}/roles`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ roleId: systemRoleId })
      .expect(403);
  });

  it('12. rejects a tampered JWT with 401', async () => {
    const token = await scoped(emailAdmin, tenantAId);
    const last = token.at(-1);
    const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${tampered}`)
      .expect(401);
  });

  it('13. client-supplied role/permission data cannot elevate privileges', async () => {
    const token = await scoped(emailAdmin, tenantBId); // viewer, no role.read
    await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${token}`)
      .set('x-permissions', IDENTITY_PERMISSIONS.ROLE_READ)
      .set('x-tenant-id', tenantAId)
      .expect(403);
  });
});
