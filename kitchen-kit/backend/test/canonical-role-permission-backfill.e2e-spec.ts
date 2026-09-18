import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  reconcileExistingCanonicalRoles,
  type CanonicalRoleReconciliationResult,
} from './../src/modules/identity/authz/canonical-role-templates';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { SALES_PERMISSIONS, SALES_PERMISSION_DEFS } from './../src/modules/sales/contract';
import { CashSessionsService } from './../src/modules/treasury/cash-sessions/cash-sessions.service';
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
import {
  TREASURY_PERMISSIONS,
  TREASURY_PERMISSION_DEFS,
} from './../src/modules/treasury/treasury.permissions';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * CANONICAL-ROLE-PERMISSION-BACKFILL-P0.
 *
 * Proves the GENERAL, template-driven reconciliation mechanism
 * (`reconcileExistingCanonicalRoles`, in `canonical-role-templates.ts`) —
 * not the narrow, hand-written, one-off SQL migration
 * (`20260914120000_backfill_branch_manager_cash_close_permissions`, already
 * proven separately by `branch-manager-cash-close-backfill.e2e-spec.ts`).
 *
 * The acceptance scenario is deliberately the same live P0 (a real Branch
 * Manager role, materialised pre-DEMO-AUTH-CASH-HOTFIX-P0 with only
 * `cash.session.open`, refused closing a cashier's session) so this test is
 * directly comparable to that one — but everything here goes through the
 * reusable function a future hotfix can call again for ANY canonical role
 * and ANY missing code, never a second hand-written SQL statement.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_MANAGER = '7777';
const PIN_CASHIER = '8888';

describe('reconcileExistingCanonicalRoles (e2e) — CANONICAL-ROLE-PERMISSION-BACKFILL-P0', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let http: App;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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
    prisma = app.get(PrismaService);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  it('reconciles an already-materialised, pre-hotfix Branch Manager role: idempotent, additive-only, custom-role-safe, assignment/scope-preserving, and the reconciled manager can then close another employee\'s cash session', async () => {
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
        slug: `crpb-${stamp}`,
        legalName: `CRPB ${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `CRPB Brand` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `CRPB${stamp % 10000}`,
        name: `CRPB Branch`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.location.create({
      data: { id: newId(), tenantId, locationType: 'branch', refId: branch.id, branchId: branch.id },
    });

    const managerUserId = (
      await users.createUser({ email: `crpb.manager.${stamp}@example.com`, password, displayName: 'CRPB' })
    ).id;
    await memberships.grant(managerUserId, tenantId, 'active');
    const cashierUserId = (
      await users.createUser({ email: `crpb.cashier.${stamp}@example.com`, password, displayName: 'CRPB' })
    ).id;
    await memberships.grant(cashierUserId, tenantId, 'active');

    const codeManager = `CPM${stamp % 1000}`;
    const codeCashier = `CPC${stamp % 1000}`;
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

    // 1. Old Branch Manager fixture, missing both cash-close permissions —
    // materialised exactly the way `ensureCanonicalRole` would have under
    // the pre-DEMO-AUTH-CASH-HOTFIX-P0 template (open only).
    const managerRole = await roles.createTenantRole(tenantId, { name: 'Branch Manager' });
    await roles.addPermissions(tenantId, managerRole.id, [
      'cash.session.open',
      // An extra permission NOT in the Branch Manager template at all,
      // granted by this tenant's admin by hand — must survive the
      // reconciliation untouched (requirement 4).
      TREASURY_PERMISSIONS.CASH_PAYIN,
    ]);
    const membership = await admin.membership.findFirstOrThrow({
      where: { userId: managerUserId, tenantId },
    });
    const assignment = await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: managerRole.id,
      scope: { type: 'branch', branchId: branch.id },
    });

    // A custom, differently-named role with the identical gap — must never
    // be touched (requirement 5); name match is the only signal used.
    const customRole = await roles.createTenantRole(tenantId, { name: `crpb_custom_${stamp}` });
    await roles.addPermissions(tenantId, customRole.id, ['cash.session.open']);

    const cashierRole = await roles.createTenantRole(tenantId, { name: `crpb_cashier_${stamp}` });
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

    const drawer = await drawers.create(tenantId, managerUserId, { branchId: branch.id, name: 'CRPB Till' });
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

    // BEFORE reconciliation: reproduces the live P0 exactly.
    const before = await closeContext(managerToken);
    expect(before.status).toBe(403);

    // A snapshot of the role assignment, to prove requirement 6 —
    // reconciliation must never touch MembershipRole (assignment/scope).
    const assignmentBefore = await admin.membershipRole.findUniqueOrThrow({
      where: { id: assignment.id },
    });

    const runReconciliation = (): Promise<CanonicalRoleReconciliationResult[]> =>
      prisma.withAuthContext({ tenantId }, (tx) =>
        reconcileExistingCanonicalRoles(tx, tenantId),
      );

    // 2. Run the backfill — both cash-close permissions must be added.
    // (The reconciliation is a full-template reconcile, so it may also add
    // other Branch-Manager-template codes whose permission rows happen to
    // exist in this test's catalog — the acceptance requirement is that the
    // two cash-close codes are AMONG what gets added, not that they are the
    // only thing added.)
    const firstRun = await runReconciliation();
    const managerResult = firstRun.find((r) => r.roleId === managerRole.id);
    expect(managerResult?.templateKey).toBe('branch_manager');
    expect(managerResult!.addedPermissionCodes).toEqual(
      expect.arrayContaining(['cash.session.close', 'cash.session.close_other']),
    );

    // AFTER: the SAME role (never reassigned, never re-provisioned) now
    // authorises the same manager to close a DIFFERENT employee's session —
    // requirement 7.
    const after = await closeContext(managerToken);
    expect(after.status).toBe(200);

    const codesOf = async (roleId: string) =>
      (
        await admin.rolePermission.findMany({
          where: { roleId },
          include: { permission: true },
        })
      ).map((rp) => rp.permission.code).sort();

    // Requirement 4 — the pre-existing extra permission (not even part of
    // the Branch Manager template) survives; this was additive, not a
    // reset. And the two originally-missing codes are now present.
    const managerCodesAfterFirstRun = await codesOf(managerRole.id);
    expect(managerCodesAfterFirstRun).toEqual(
      expect.arrayContaining([
        'cash.session.close',
        'cash.session.close_other',
        'cash.session.open',
        TREASURY_PERMISSIONS.CASH_PAYIN,
      ]),
    );

    // 3. Run the backfill again — idempotent: no duplicates, no additional
    // changes, and the second run reports nothing left to add.
    const secondRun = await runReconciliation();
    const managerResultSecondRun = secondRun.find((r) => r.roleId === managerRole.id);
    expect(managerResultSecondRun?.addedPermissionCodes).toEqual([]);
    expect(await codesOf(managerRole.id)).toEqual(managerCodesAfterFirstRun);

    // 5. A differently-named role with the identical gap is NEVER touched,
    // across both runs.
    expect(await codesOf(customRole.id)).toEqual(['cash.session.open']);
    expect(await codesOf(cashierRole.id)).toEqual(['cash.session.open']);
    const cashierAttempt = await closeContext(cashierToken);
    expect(cashierAttempt.status).toBe(403);

    // 6. The role ASSIGNMENT (MembershipRole) — id, membership, role,
    // scope, validity — is byte-identical to before any reconciliation ran.
    const assignmentAfter = await admin.membershipRole.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(assignmentAfter).toEqual(assignmentBefore);
  }, 60_000);

  it('reconciles ANY canonical role generically, not only Branch Manager (proves the template, not a hardcoded name, drives the grant)', async () => {
    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);

    const tenantId = (
      await tenants.create({
        slug: `crpb-generic-${stamp}`,
        legalName: `CRPB Generic ${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const userId = (
      await users.createUser({
        email: `crpb.generic.${stamp}@example.com`,
        password,
        displayName: 'CRPB Generic',
      })
    ).id;
    await memberships.grant(userId, tenantId, 'active');

    // A stale "Cashier" role — every current CASHIER template code except
    // one, simulating a tenant provisioned before a later addition to that
    // template (the same shape of gap as the Branch Manager case, on a
    // different canonical role, with no code referring to "Branch Manager"
    // anywhere in the function under test).
    const cashierRole = await roles.createTenantRole(tenantId, { name: 'Cashier' });
    await roles.addPermissions(tenantId, cashierRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.ORDER_FIRE,
    ]);

    const before = await admin.rolePermission.findMany({
      where: { roleId: cashierRole.id },
      include: { permission: true },
    });
    expect(before.map((rp) => rp.permission.code).sort()).toEqual(
      [SALES_PERMISSIONS.ORDER_CREATE, SALES_PERMISSIONS.ORDER_FIRE].sort(),
    );

    const results = await prisma.withAuthContext({ tenantId }, (tx) =>
      reconcileExistingCanonicalRoles(tx, tenantId),
    );

    const cashierResult = results.find((r) => r.roleId === cashierRole.id);
    expect(cashierResult?.templateKey).toBe('cashier');
    // Every remaining Cashier-template code not already granted was added —
    // proves the function reads `CANONICAL_ROLE_TEMPLATES` at call time
    // rather than special-casing Branch Manager.
    expect(cashierResult!.addedPermissionCodes.length).toBeGreaterThan(0);
    expect(cashierResult!.addedPermissionCodes).not.toContain(SALES_PERMISSIONS.ORDER_CREATE);
    expect(cashierResult!.addedPermissionCodes).not.toContain(SALES_PERMISSIONS.ORDER_FIRE);

    const after = await admin.rolePermission.findMany({
      where: { roleId: cashierRole.id },
      include: { permission: true },
    });
    const afterCodes = after.map((rp) => rp.permission.code);
    expect(afterCodes).toEqual(expect.arrayContaining([SALES_PERMISSIONS.ORDER_CREATE, SALES_PERMISSIONS.ORDER_FIRE]));
    for (const code of cashierResult!.addedPermissionCodes) {
      expect(afterCodes).toContain(code);
    }
  }, 60_000);
});
