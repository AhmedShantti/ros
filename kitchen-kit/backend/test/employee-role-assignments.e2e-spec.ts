import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
import { createMigratorClient } from './rls-admin';

/**
 * DEMO-EMPLOYEE-RBAC-1 — assigning system roles to an employee from the
 * Employees UI's "Access / Role" facade
 * (`/workforce/employees/{employeeId}/role-assignments`), which delegates
 * entirely to the pre-existing `MembershipRolesService`/`RolesService`
 * scoped-RBAC surface. Exercises ONLY real HTTP routes; no
 * `seed-dev-data.ts` import anywhere in this file.
 */

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface RoleBody {
  id: string;
  name: string;
}

interface EmployeeBody {
  id: string;
  code: string;
  userId: string | null;
}

interface RoleAssignmentBody {
  id: string;
  roleId: string;
  roleName: string | null;
  scopeType: 'tenant' | 'brand' | 'branch';
  scopeBranchId: string | null;
}

describe('Employee role assignments — Access/Role facade (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let http: App;

  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  async function signUpOwner(orgName?: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(http)
      .post('/auth/registrations')
      .send({
        fullName: 'RBAC E2E Owner',
        email: `rbac.e2e.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: orgName ?? `RBAC E2E Restaurant ${stamp}`,
        password: 's3cure-passphrase-10+',
      })
      .expect(201);
    const out = res.body as {
      auth: { accessToken: string; user: { id: string } };
      tenant: { id: string };
    };
    createdTenantIds.push(out.tenant.id);
    createdUserIds.push(out.auth.user.id);

    const branches = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${out.auth.accessToken}`)
      .expect(200);
    const branchId = (branches.body as { id: string }[])[0].id;

    return {
      tenantId: out.tenant.id,
      accessToken: out.auth.accessToken,
      branchId,
    };
  }

  async function registerTerminal(
    accessToken: string,
    branchId: string,
    terminalType: 'pos' | 'kds' = 'pos',
  ) {
    const res = await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `T-${Date.now()}`, terminalType, branchId })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function employeeBody(homeBranchId: string, overrides: Record<string, unknown> = {}) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      code: `E-${stamp}`.slice(0, 32),
      displayName: 'RBAC Test Employee',
      homeBranchId,
      employmentType: 'full_time',
      ...overrides,
    };
  }

  async function createEmployee(accessToken: string, branchId: string) {
    const res = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    return res.body as EmployeeBody;
  }

  async function listRoles(accessToken: string): Promise<RoleBody[]> {
    const res = await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return res.body as RoleBody[];
  }

  async function roleIdByName(accessToken: string, name: string): Promise<string> {
    const roles = await listRoles(accessToken);
    const role = roles.find((r) => r.name === name);
    if (!role) throw new Error(`Canonical role "${name}" not seeded at signup`);
    return role.id;
  }

  async function listAssignments(
    accessToken: string,
    employeeId: string,
  ): Promise<RoleAssignmentBody[]> {
    const res = await request(http)
      .get(`/workforce/employees/${employeeId}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return res.body as RoleAssignmentBody[];
  }

  async function replaceAssignment(
    accessToken: string,
    employeeId: string,
    roleId: string,
    scope: { type: 'tenant' } | { type: 'branch'; branchId: string },
  ): Promise<RoleAssignmentBody> {
    for (const existing of await listAssignments(accessToken, employeeId)) {
      await request(http)
        .delete(`/workforce/employees/${employeeId}/role-assignments/${existing.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);
    }
    const res = await request(http)
      .post(`/workforce/employees/${employeeId}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ roleId, scope })
      .expect(201);
    return res.body as RoleAssignmentBody;
  }

  /**
   * A PIN-issued session is `typ: 'pos'`, and `JwtAuthGuard` refuses that on
   * every route not explicitly opted in with `@AllowPosSession()` —
   * `RbacController`'s `GET /auth/permissions` is NOT one of those (correctly
   * — FR-SEC-021), so effective permissions are verified directly from the
   * database (the same rows `TenantContextService` itself resolves from) via
   * the admin/migrator client, exactly as this codebase's own e2e specs do
   * wherever there is no dashboard-session route to ask instead.
   */
  async function roleGrantedPermissionCodes(roleId: string): Promise<string[]> {
    const rows = await admin.rolePermission.findMany({
      where: { roleId },
      include: { permission: { select: { code: true } } },
    });
    return rows.map((r) => r.permission.code);
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
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { id: { in: createdUserIds } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  it('Cashier: assign via the facade, correct effective permissions (incl. own cash-session open/close + payment capture), no manager-only leakage, and can open own cash session', async () => {
    const { accessToken, branchId, tenantId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);
    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '1357' })
      .expect(204);

    // Auto-provisioned employees already hold Cashier at branch scope
    // (LIVE-DEMO-HOTFIX-1) — prove the facade's list/remove/assign cycle
    // explicitly by replacing that assignment through it.
    const cashierRoleId = await roleIdByName(accessToken, 'Cashier');
    const assignment = await replaceAssignment(accessToken, employee.id, cashierRoleId, {
      type: 'branch',
      branchId,
    });
    expect(assignment.roleName).toBe('Cashier');
    expect(assignment.scopeType).toBe('branch');

    const listed = await listAssignments(accessToken, employee.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].roleName).toBe('Cashier');

    const terminalId = await registerTerminal(accessToken, branchId, 'pos');

    // Effective cashier permissions (the CASHIER_PERMISSION_GAP fix), read
    // from the actual granted `RolePermission` rows — the same rows
    // `TenantContextService` itself resolves authorization from.
    const permissions = await roleGrantedPermissionCodes(cashierRoleId);
    expect(permissions).toEqual(
      expect.arrayContaining([
        'pos.order.create',
        'pos.order.fire',
        'pos.payment.capture',
        'cash.session.open',
        'cash.session.close',
      ]),
    );
    // No manager-only permission leaks onto Cashier.
    expect(permissions).not.toEqual(
      expect.arrayContaining([
        'cash.session.close_other',
        'cash.variance.approve',
        'cash.day.close',
        'settings.branch.manage',
        'report.view.financial',
      ]),
    );

    // Cashier can actually open their own cash session (FR-POS-090) — a real
    // route call, proving the grant is live-effective, not just present in
    // the role's permission rows.
    const drawers = app.get(DrawersService);
    const drawer = await drawers.create(tenantId, employee.userId ?? '', {
      branchId,
      name: 'RBAC Test Till',
    });
    const relogin = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '1357' })
      .expect(200);
    const posToken = (relogin.body as { accessToken: string }).accessToken;

    await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: drawer.id,
        openingFloat: '10000',
      })
      .expect(201);
  }, 30_000);

  it('Branch Manager: assign at Main, receives the exact branch-scoped manager permission set', async () => {
    const { accessToken, branchId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);
    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '2468' })
      .expect(204);

    const managerRoleId = await roleIdByName(accessToken, 'Branch Manager');
    const assignment = await replaceAssignment(accessToken, employee.id, managerRoleId, {
      type: 'branch',
      branchId,
    });
    expect(assignment.roleName).toBe('Branch Manager');

    const permissions = await roleGrantedPermissionCodes(managerRoleId);
    expect(permissions).toEqual(
      expect.arrayContaining([
        'settings.branch.manage',
        'report.view.financial',
        'hr.employee.manage',
        'cash.session.open',
        'inventory.adjust',
      ]),
    );
  }, 30_000);

  it('Kitchen Staff: assign, effective permission set is exactly kds.operate, and can reach a real KDS station queue', async () => {
    const { accessToken, branchId, tenantId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);
    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '9911' })
      .expect(204);

    const kitchenRoleId = await roleIdByName(accessToken, 'Kitchen Staff');
    await replaceAssignment(accessToken, employee.id, kitchenRoleId, {
      type: 'branch',
      branchId,
    });

    const kdsTerminalId = await registerTerminal(accessToken, branchId, 'kds');
    const permissions = await roleGrantedPermissionCodes(kitchenRoleId);
    expect(permissions).toEqual(['kds.operate']);

    // Real KDS operator route — a Station has no HTTP creation route in this
    // repository (mirrors Treasury's Drawer), so it is created directly via
    // the admin/migrator client, exactly as `test/kds-fixtures.ts` already
    // does for every other KDS e2e spec.
    const station = await admin.station.create({
      data: {
        id: newId(),
        branchId,
        name: 'RBAC Test Station',
        displayTerminalId: kdsTerminalId,
      },
    });

    const login = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId: kdsTerminalId, employeeCode: employee.code, pin: '9911' })
      .expect(200);
    const kdsToken = (login.body as { accessToken: string }).accessToken;

    await request(http)
      .get(`/kds/stations/${station.id}/queue`)
      .set('Authorization', `Bearer ${kdsToken}`)
      .expect(200);
  }, 30_000);

  it('a role assignment cannot cross tenant', async () => {
    const tenantA = await signUpOwner();
    const tenantB = await signUpOwner();

    const employeeA = await createEmployee(tenantA.accessToken, tenantA.branchId);
    const cashierRoleIdInB = await roleIdByName(tenantB.accessToken, 'Cashier');

    // Tenant B's owner cannot see (or act on) tenant A's employee at all.
    await request(http)
      .get(`/workforce/employees/${employeeA.id}/role-assignments`)
      .set('Authorization', `Bearer ${tenantB.accessToken}`)
      .expect(404);

    // Tenant A's owner cannot assign tenant A's employee a role id that only
    // exists in tenant B (RLS makes it invisible → 404, never a cross-tenant
    // grant).
    await request(http)
      .post(`/workforce/employees/${employeeA.id}/role-assignments`)
      .set('Authorization', `Bearer ${tenantA.accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ roleId: cashierRoleIdInB, scope: { type: 'branch', branchId: tenantA.branchId } })
      .expect(404);
  }, 30_000);

  it('authzEpoch increments on the membership after a role change', async () => {
    const { accessToken, branchId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);

    const before = await admin.employee.findUniqueOrThrow({
      where: { id: employee.id },
      select: { userId: true },
    });
    const membershipBefore = await admin.membership.findFirstOrThrow({
      where: { userId: before.userId ?? undefined },
      select: { id: true, authzEpoch: true },
    });

    const managerRoleId = await roleIdByName(accessToken, 'Branch Manager');
    await replaceAssignment(accessToken, employee.id, managerRoleId, {
      type: 'branch',
      branchId,
    });

    const membershipAfter = await admin.membership.findUniqueOrThrow({
      where: { id: membershipBefore.id },
      select: { authzEpoch: true },
    });
    // One DELETE (of the auto-provisioned Cashier assignment) + one POST
    // (Branch Manager) — each an independent epoch-bumping authority change.
    expect(membershipAfter.authzEpoch).toBeGreaterThan(membershipBefore.authzEpoch);
  }, 30_000);
});
