import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { createAppClient, createMigratorClient } from './rls-admin';

/**
 * BRANCH-MANAGER-CASH-CLOSE-RLS-AWARE-MIGRATION-P0.
 *
 * Proves the RLS-AWARE migration
 * (`20260919130000_rls_aware_redeploy_backfill_branch_manager_cash_close_permissions`)
 * actually backfills the two cash-close codes when executed through the
 * SAME CLASS OF CONNECTION production's `prisma migrate deploy` uses —
 * RLS-constrained `ros_app` (`APP_DATABASE_URL`), starting from a FRESH
 * connection with no `app.tenant_id` pre-set — never the privileged
 * `ros_migrator` connection every earlier migration test in this repo used
 * (`branch-manager-cash-close-backfill.e2e-spec.ts`,
 * `branch-manager-cash-close-redeploy-migration.e2e-spec.ts`), which is
 * exactly why those tests could not have caught the zero-row bug
 * `2026-09-19_CASH-CLOSE-MIGRATION-RLS-ZERO-EFFECT-P0_investigation.md`
 * proved empirically.
 *
 * The migration's own SQL file is read from disk and executed verbatim —
 * never duplicated inline — so this test can only pass if the actual
 * shipped file is RLS-aware, not a hand-maintained copy of what it's
 * supposed to say.
 */

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20260919130000_rls_aware_redeploy_backfill_branch_manager_cash_close_permissions/migration.sql',
  ),
  'utf8',
);

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_MANAGER = '7777';
const PIN_CASHIER = '8888';

describe('Branch Manager cash-close RLS-AWARE migration (e2e) — BRANCH-MANAGER-CASH-CLOSE-RLS-AWARE-MIGRATION-P0', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A tenant + one stale "Branch Manager" role (cash.session.open only), a manager and cashier signed on to it, and one custom role sharing the identical gap. */
  async function seedTenant(label: string) {
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
        slug: `bmrls-${label}-${stamp}`,
        legalName: `BMRLS ${label} ${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    const brand = await admin.brand.create({ data: { id: newId(), tenantId, name: `BMRLS ${label} Brand` } });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `RLS${label}${stamp % 10000}`,
        name: 'Main',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.location.create({
      data: { id: newId(), tenantId, locationType: 'branch', refId: branch.id, branchId: branch.id },
    });

    const managerUserId = (
      await users.createUser({ email: `bmrls.manager.${label}.${stamp}@example.com`, password, displayName: 'BMRLS' })
    ).id;
    await memberships.grant(managerUserId, tenantId, 'active');
    const cashierUserId = (
      await users.createUser({ email: `bmrls.cashier.${label}.${stamp}@example.com`, password, displayName: 'BMRLS' })
    ).id;
    await memberships.grant(cashierUserId, tenantId, 'active');

    const codeManager = `M${label}${stamp % 1000}`;
    const codeCashier = `C${label}${stamp % 1000}`;
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

    // A. Stale "Branch Manager" — exact name, isSystem=false, only
    // cash.session.open — plus a correctly branch-scoped assignment.
    const managerRole = await roles.createTenantRole(tenantId, { name: 'Branch Manager' });
    await roles.addPermissions(tenantId, managerRole.id, ['cash.session.open']);
    const membership = await admin.membership.findFirstOrThrow({ where: { userId: managerUserId, tenantId } });
    const assignment = await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: managerRole.id,
      scope: { type: 'branch', branchId: branch.id },
    });

    // A differently-named, custom role with the identical gap — must never
    // be touched.
    const customRole = await roles.createTenantRole(tenantId, { name: `bmrls_custom_${label}_${stamp}` });
    await roles.addPermissions(tenantId, customRole.id, ['cash.session.open']);

    const managerToken = await request(http)
      .post('/auth/pin')
      .send({ tenantId, branchId: branch.id, employeeCode: codeManager, pin: PIN_MANAGER, sessionType: 'pos' })
      .expect(200)
      .then((res) => (res.body as { accessToken: string }).accessToken);

    const drawer = await drawers.create(tenantId, managerUserId, { branchId: branch.id, name: `BMRLS ${label} Till` });
    const { session } = await cashSessions.open(tenantId, cashierUserId, {
      shiftId: newId(),
      cashSessionId: newId(),
      drawerId: drawer.id,
      openingFloat: '50000',
      branchId: branch.id,
      employeeId: cashierEmployeeId,
    });

    return { tenantId, managerRole, customRole, assignment, managerToken, sessionId: session.id };
  }

  const closeContext = (sessionId: string, token: string) =>
    request(http).get(`/cash-sessions/${sessionId}/close-context`).set(auth(token));

  const codesOf = async (roleId: string) =>
    (
      await admin.rolePermission.findMany({ where: { roleId }, include: { permission: true } })
    ).map((rp) => rp.permission.code).sort();

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

  it('backfills both codes when the actual migration.sql is executed through a fresh, RLS-constrained ros_app connection with no pre-set tenant context — across multiple tenants, idempotently, without touching custom roles or assignments', async () => {
    // A. Two independent tenants, proving the migration's tenant LOOP
    // really processes more than one (requirement F) — not one accidental
    // match.
    const one = await seedTenant('one');
    const two = await seedTenant('two');

    // B. Fresh connection, no context: both managers 403 on their OWN
    // session's close-context — reproduces the live symptom exactly.
    const beforeOne = await closeContext(one.sessionId, one.managerToken);
    const beforeTwo = await closeContext(two.sessionId, two.managerToken);
    expect(beforeOne.status).toBe(403);
    expect(beforeTwo.status).toBe(403);
    expect((beforeOne.body as { message?: string }).message).toBe(
      'Insufficient permission for this scope.',
    );

    // Snapshot both assignments before the migration runs.
    const assignmentOneBefore = await admin.membershipRole.findUniqueOrThrow({ where: { id: one.assignment.id } });
    const assignmentTwoBefore = await admin.membershipRole.findUniqueOrThrow({ where: { id: two.assignment.id } });

    // C. A BRAND-NEW ros_app client — never touched by anything above —
    // confirmed to start with NO tenant context, then used to execute the
    // real migration.sql file content verbatim.
    const freshAppClient = createAppClient(app);
    try {
      const [{ current_setting: contextBefore }] = await freshAppClient.$queryRawUnsafe<
        { current_setting: string | null }[]
      >("SELECT current_setting('app.tenant_id', true) AS current_setting");
      expect(contextBefore === null || contextBefore === '').toBe(true);

      await freshAppClient.$executeRawUnsafe(MIGRATION_SQL);
    } finally {
      await freshAppClient.$disconnect();
    }

    // D. Both tenants' Branch Manager roles gained exactly the two codes;
    // both managers now pass on their own session.
    expect(await codesOf(one.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );
    expect(await codesOf(two.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );
    const afterOne = await closeContext(one.sessionId, one.managerToken);
    const afterTwo = await closeContext(two.sessionId, two.managerToken);
    expect(afterOne.status).toBe(200);
    expect(afterTwo.status).toBe(200);

    // Custom, differently-named roles in both tenants: untouched.
    expect(await codesOf(one.customRole.id)).toEqual(['cash.session.open']);
    expect(await codesOf(two.customRole.id)).toEqual(['cash.session.open']);

    // Role assignments (MembershipRole) — id, membership, role, scope,
    // validity — byte-identical to before the migration ran.
    expect(await admin.membershipRole.findUniqueOrThrow({ where: { id: one.assignment.id } })).toEqual(
      assignmentOneBefore,
    );
    expect(await admin.membershipRole.findUniqueOrThrow({ where: { id: two.assignment.id } })).toEqual(
      assignmentTwoBefore,
    );

    // E. Run it again — a second FRESH ros_app connection, no context —
    // no duplicates, no additional changes, still 200.
    const secondAppClient = createAppClient(app);
    try {
      await expect(secondAppClient.$executeRawUnsafe(MIGRATION_SQL)).resolves.toBeDefined();
    } finally {
      await secondAppClient.$disconnect();
    }
    expect(await codesOf(one.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );
    expect(await codesOf(two.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );
    const stillOne = await closeContext(one.sessionId, one.managerToken);
    const stillTwo = await closeContext(two.sessionId, two.managerToken);
    expect(stillOne.status).toBe(200);
    expect(stillTwo.status).toBe(200);
  }, 60_000);
});
