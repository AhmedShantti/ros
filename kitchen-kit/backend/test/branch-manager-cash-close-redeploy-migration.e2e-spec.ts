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
 * BRANCH-MANAGER-CASH-CLOSE-DEPLOY-MIGRATION-P0.
 *
 * Proves the NEW migration
 * (`20260919120000_redeploy_backfill_branch_manager_cash_close_permissions`)
 * — not the original 2026-09-14 one, already separately proven by
 * `branch-manager-cash-close-backfill.e2e-spec.ts`, and not the general
 * `ded6dd6` mechanism, proven by
 * `canonical-role-permission-backfill.e2e-spec.ts`. This migration exists
 * ONLY because live proof (2026-09-19) showed the database still lacking
 * these two grants despite the first migration already being deployed —
 * see the migration file's own docblock for the full reasoning. The
 * statement is reproduced inline here (rather than read from the migration
 * file) to keep this a pure runtime-behaviour proof, matching this repo's
 * existing migration-test convention (`branch-manager-cash-close-backfill.e2e-spec.ts`'s
 * own docblock, and `scoped-rbac-migration.e2e-spec.ts`'s).
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_MANAGER = '7777';
const PIN_CASHIER = '8888';

describe('Branch Manager cash-close REDEPLOY migration (e2e) — BRANCH-MANAGER-CASH-CLOSE-DEPLOY-MIGRATION-P0', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const runRedeployMigration = () =>
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

  it("repairs a still-stale Branch Manager role exactly as the live case reproduces it, is idempotent, never touches a differently-named role, and never touches the role assignment's scope", async () => {
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
        slug: `bmrm-${stamp}`,
        legalName: `BMRM ${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `BMRM Brand` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `BMRM${stamp % 10000}`,
        name: `Main`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.location.create({
      data: { id: newId(), tenantId, locationType: 'branch', refId: branch.id, branchId: branch.id },
    });

    const managerUserId = (
      await users.createUser({ email: `bmrm.manager.${stamp}@example.com`, password, displayName: 'BMRM' })
    ).id;
    await memberships.grant(managerUserId, tenantId, 'active');
    const cashierUserId = (
      await users.createUser({ email: `bmrm.cashier.${stamp}@example.com`, password, displayName: 'BMRM' })
    ).id;
    await memberships.grant(cashierUserId, tenantId, 'active');

    const codeManager = `RDM${stamp % 1000}`;
    const codeCashier = `RDC${stamp % 1000}`;
    const managerEmployeeId = (
      await employees.create(tenantId, managerUserId, {
        code: codeManager,
        displayName: 'manager001',
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

    // 1. A "Branch Manager" role, exactly named, already granted
    // `cash.session.open` — reproducing the live case's exact starting
    // point: still missing both close codes despite the 2026-09-14
    // migration already having run once against this schema's history.
    const managerRole = await roles.createTenantRole(tenantId, { name: 'Branch Manager' });
    await roles.addPermissions(tenantId, managerRole.id, ['cash.session.open']);
    const membership = await admin.membership.findFirstOrThrow({
      where: { userId: managerUserId, tenantId },
    });
    const assignment = await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: managerRole.id,
      scope: { type: 'branch', branchId: branch.id },
    });

    // A differently-named role with the identical gap — must never be
    // touched (name match is the only signal used).
    const customRole = await roles.createTenantRole(tenantId, { name: `bmrm_custom_${stamp}` });
    await roles.addPermissions(tenantId, customRole.id, ['cash.session.open']);

    const cashierRole = await roles.createTenantRole(tenantId, { name: `bmrm_cashier_${stamp}` });
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

    const drawer = await drawers.create(tenantId, managerUserId, { branchId: branch.id, name: 'BMRM Till' });
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

    // Reproduces the live symptom exactly: a correctly-named, correctly-
    // scoped Branch Manager still 403s.
    const before = await closeContext(managerToken);
    expect(before.status).toBe(403);
    expect((before.body as { message?: string }).message).toBe(
      'Insufficient permission for this scope.',
    );

    // A snapshot of the role ASSIGNMENT, to prove the migration never
    // touches MembershipRole (requirement: "role assignment scope
    // unchanged").
    const assignmentBefore = await admin.membershipRole.findUniqueOrThrow({
      where: { id: assignment.id },
    });

    // 2. Run the new migration's statement — both permissions must be
    // added.
    await runRedeployMigration();

    const after = await closeContext(managerToken);
    expect(after.status).toBe(200);

    const codesOf = async (roleId: string) =>
      (
        await admin.rolePermission.findMany({
          where: { roleId },
          include: { permission: true },
        })
      ).map((rp) => rp.permission.code).sort();

    expect(await codesOf(managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );

    // 3. Idempotent: a second application changes nothing and errors on
    // nothing (the exact semantics `prisma migrate deploy` needs — a
    // migration this file's own history could in principle see replayed
    // must never fail or duplicate a row).
    await expect(runRedeployMigration()).resolves.toBeDefined();
    expect(await codesOf(managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );

    // 4. A differently-named role with the identical gap is NEVER touched.
    expect(await codesOf(customRole.id)).toEqual(['cash.session.open']);
    expect(await codesOf(cashierRole.id)).toEqual(['cash.session.open']);
    const cashierAttempt = await closeContext(cashierToken);
    expect(cashierAttempt.status).toBe(403);

    // 5. The role ASSIGNMENT (MembershipRole) — id, membership, role,
    // scope, validity — is byte-identical to before the migration ran.
    const assignmentAfter = await admin.membershipRole.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(assignmentAfter).toEqual(assignmentBefore);
  }, 60_000);
});
