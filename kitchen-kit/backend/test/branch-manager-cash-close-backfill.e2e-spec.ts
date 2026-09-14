import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { CashSessionsService } from './../src/modules/treasury/cash-sessions/cash-sessions.service';
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
import { TREASURY_PERMISSION_DEFS } from './../src/modules/treasury/treasury.permissions';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * DEMO-CASH-AUTH-FINAL-GAP-P0 — proves the
 * `20260914120000_backfill_branch_manager_cash_close_permissions` data
 * migration actually repairs a tenant whose "Branch Manager" role row was
 * already materialised (in `identity.roles`/`identity.role_permissions`)
 * BEFORE a47b582 added `cash.session.close`/`cash.session.close_other` to
 * `BRANCH_MANAGER_PERMISSION_CODES`.
 *
 * `canonical-role-templates.ts`'s `CANONICAL_ROLE_TEMPLATES` is a
 * PROVISIONING-time policy, not a live authorization lookup —
 * `ScopeAuthorizationService`/`PermissionGuard` (via `TenantContextService`)
 * authorize against whatever `RolePermission` rows already exist for a
 * `Role`, per request, and never read the template code. So a code-only fix
 * repairs only newly-provisioned tenants; an already-existing tenant's
 * "Branch Manager" role needs its `role_permissions` rows backfilled
 * directly, which is what this migration does and this file proves.
 *
 * The migration statement is reproduced inline (rather than read from the
 * migration file) to keep this a pure runtime-behaviour proof, matching this
 * repo's existing migration-test convention (see
 * `scoped-rbac-migration.e2e-spec.ts`'s own docblock) — the file itself is
 * the single source of truth for what actually ships; this asserts what its
 * output must do.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_MANAGER = '7777';
const PIN_CASHIER = '8888';

describe('Branch Manager cash-close backfill (e2e) — DEMO-CASH-AUTH-FINAL-GAP-P0', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const runBackfill = () =>
    admin.$executeRawUnsafe(`
      INSERT INTO identity.role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM identity.roles r
      CROSS JOIN identity.permissions p
      WHERE r.name = 'Branch Manager'
        AND r.is_system = false
        AND p.code IN ('cash.session.close', 'cash.session.close_other')
      ON CONFLICT (role_id, permission_id) DO NOTHING;
    `);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  it("repairs an already-materialised Branch Manager role, is idempotent, and never touches a differently-named role", async () => {
    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);
    const pins = app.get(PinService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const cashSessions = app.get(CashSessionsService);
    const drawers = app.get(DrawersService);

    const tenantId = (
      await tenants.create({
        slug: `bmb-${stamp}`,
        legalName: `BMB ${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `BMB Brand` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `BMB${stamp % 10000}`,
        name: `BMB Branch`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.location.create({
      data: { id: newId(), tenantId, locationType: 'branch', refId: branch.id, branchId: branch.id },
    });

    const managerUserId = (
      await users.createUser({ email: `bmb.manager.${stamp}@example.com`, password, displayName: 'BMB' })
    ).id;
    await memberships.grant(managerUserId, tenantId, 'active');
    const cashierUserId = (
      await users.createUser({ email: `bmb.cashier.${stamp}@example.com`, password, displayName: 'BMB' })
    ).id;
    await memberships.grant(cashierUserId, tenantId, 'active');

    const codeManager = `BMM${stamp % 1000}`;
    const codeCashier = `BMC${stamp % 1000}`;
    const managerEmployeeId = (
      await employees.create(tenantId, managerUserId, {
        code: codeManager,
        displayName: 'Manager',
        homeBranchId: branch.id,
        userId: managerUserId,
      })
    ).id;
    const cashierEmployeeId = (
      await employees.create(tenantId, cashierUserId, {
        code: codeCashier,
        displayName: 'Cashier',
        homeBranchId: branch.id,
        userId: cashierUserId,
      })
    ).id;
    await pins.setPin(tenantId, managerUserId, managerEmployeeId, PIN_MANAGER);
    await pins.setPin(tenantId, managerUserId, cashierEmployeeId, PIN_CASHIER);

    // Simulate the PRE-a47b582 state: a real canonical "Branch Manager" role,
    // materialised the way `ensureCanonicalRole` would have, but only ever
    // granted what the stale template defined (open, never close/close_other).
    const managerRole = await roles.createTenantRole(tenantId, { name: 'Branch Manager' });
    await roles.addPermissions(tenantId, managerRole.id, ['cash.session.open']);
    const membership = await admin.membership.findFirstOrThrow({
      where: { userId: managerUserId, tenantId },
    });
    await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: managerRole.id,
      scope: { type: 'branch', branchId: branch.id },
    });

    // A differently-named role, deliberately left with the exact same gap —
    // must stay untouched by the backfill (it does not match on name).
    const customRole = await roles.createTenantRole(tenantId, { name: `bmb_custom_${stamp}` });
    await roles.addPermissions(tenantId, customRole.id, ['cash.session.open']);

    const cashierRole = await roles.createTenantRole(tenantId, { name: `bmb_cashier_${stamp}` });
    await roles.addPermissions(tenantId, cashierRole.id, ['cash.session.open']);
    const cashierMembership = await admin.membership.findFirstOrThrow({
      where: { userId: cashierUserId, tenantId },
    });
    await membershipRoles.create(tenantId, null, {
      membershipId: cashierMembership.id,
      roleId: cashierRole.id,
      scope: { type: 'branch', branchId: branch.id },
    });

    const pinLogin = async (employeeCode: string, pin: string) => {
      const res = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId: branch.id, employeeCode, pin, sessionType: 'pos' })
        .expect(200);
      return (res.body as { accessToken: string }).accessToken;
    };
    const managerToken = await pinLogin(codeManager, PIN_MANAGER);
    const cashierToken = await pinLogin(codeCashier, PIN_CASHIER);

    const drawer = await drawers.create(tenantId, managerUserId, { branchId: branch.id, name: 'BMB Till' });
    const { session } = await cashSessions.open(tenantId, cashierUserId, {
      shiftId: newId(),
      cashSessionId: newId(),
      drawerId: drawer.id,
      openingFloat: '50000',
      branchId: branch.id,
      employeeId: cashierEmployeeId,
    });

    const closeContext = (token: string) =>
      request(http).get(`/cash-sessions/${session.id}/close-context`).set(auth(token));

    // BEFORE the backfill: reproduces the live P0 exactly — a real Branch
    // Manager, correctly scoped to the session's own branch, still 403s.
    const before = await closeContext(managerToken);
    expect(before.status).toBe(403);

    // Run the backfill.
    await runBackfill();

    // AFTER: the SAME role (never reassigned, never re-provisioned) now
    // authorises the same manager for the same session.
    const after = await closeContext(managerToken);
    expect(after.status).toBe(200);

    // The pre-existing permission survives — this was additive, not a reset.
    const managerCodes = (
      await admin.rolePermission.findMany({
        where: { roleId: managerRole.id },
        include: { permission: true },
      })
    ).map((rp) => rp.permission.code).sort();
    expect(managerCodes).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );

    // Idempotent: running it again changes nothing and errors on nothing.
    await expect(runBackfill()).resolves.toBeDefined();
    const managerCodesAfterRerun = (
      await admin.rolePermission.findMany({
        where: { roleId: managerRole.id },
        include: { permission: true },
      })
    ).map((rp) => rp.permission.code).sort();
    expect(managerCodesAfterRerun).toEqual(managerCodes);

    // A differently-named role with the identical gap is NEVER touched.
    const customCodes = (
      await admin.rolePermission.findMany({
        where: { roleId: customRole.id },
        include: { permission: true },
      })
    ).map((rp) => rp.permission.code);
    expect(customCodes).toEqual(['cash.session.open']);

    // Nor is an unrelated tenant role sharing the same pre-fix gap, even one
    // holding a real PIN-issued session of its own.
    const cashierCodes = (
      await admin.rolePermission.findMany({
        where: { roleId: cashierRole.id },
        include: { permission: true },
      })
    ).map((rp) => rp.permission.code);
    expect(cashierCodes).toEqual(['cash.session.open']);
    const cashierAttempt = await closeContext(cashierToken);
    expect(cashierAttempt.status).toBe(403);
  }, 60_000);
});
