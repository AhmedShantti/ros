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
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
import { TREASURY_PERMISSION_DEFS } from './../src/modules/treasury/treasury.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * DEMO-CASH-SESSION-RECOVERY-P0 — `GET /cash-sessions/current`.
 *
 * Reproduces and closes the production recovery failure: a cashier who loses
 * their locally-remembered `cashSessionId` (frontend reload/deploy/browser
 * reset) and re-authenticates by PIN could not recover the open session they
 * already held, and the client's only path forward was `POST
 * /cash-sessions`, which correctly refuses a second open on the same drawer
 * (FR-FIN-001) — an unrecoverable dead end without this route.
 *
 * §15.2 `cash.session.close_other` (manager close-other) already has an
 * executable consumer through the existing own/other split on `POST
 * /cash-sessions/{id}/close` and `.../close/finalize` — proven by
 * `cash-session-close.e2e-spec.ts`'s "own/other authority" suite. Nothing
 * here duplicates that coverage; this file is scoped to the NEW recovery
 * read.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_A = '7391';
const PIN_B = '8642';

interface CurrentBody {
  cashSession: { id: string; employeeId: string; branchId: string } | null;
}

describe('Cash session recovery (e2e) — GET /cash-sessions/current', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let drawers: DrawersService;

  let tenantA: string;
  let branchA: string;
  let branchA2: string;
  let terminalA: string;
  let terminalA2: string;
  let employeeA: string;
  let employeeB: string;
  let userA: string;
  let userB: string;

  let drawerA: string;
  let drawerA2: string;

  const codeA = `RCA${stamp % 1000}`;
  const codeB = `RCB${stamp % 1000}`;

  const mkBranch = async (tenantId: string, code: string) => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `RCBrand ${code}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code,
        name: `RCBranch ${code}`,
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

  const mkTerminal = (tenantId: string, branchId: string, name: string) =>
    admin.terminal
      .create({
        data: {
          id: newId(),
          tenantId,
          branchId,
          name,
          terminalType: 'pos',
          status: 'active',
        },
      })
      .then((t) => t.id);

  const pinLogin = async (
    tenantId: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ) => {
    const res = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode, pin })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const current = (token: string) =>
    request(http).get('/cash-sessions/current').set('Authorization', `Bearer ${token}`);

  const open = (
    token: string,
    body: Record<string, unknown>,
    key = `csr-${newId()}`,
  ) =>
    request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);

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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    drawers = app.get(DrawersService);

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);

    tenantA = (
      await tenants.create({
        slug: `rc-${stamp}`,
        legalName: `rc-${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    branchA = await mkBranch(tenantA, `RA${stamp % 10000}`);
    branchA2 = await mkBranch(tenantA, `RX${stamp % 10000}`);
    terminalA = await mkTerminal(tenantA, branchA, 'RC-POS-1');
    terminalA2 = await mkTerminal(tenantA, branchA2, 'RC-POS-2');

    const mkUser = async (email: string) => {
      const u = await users.createUser({ email, password, displayName: 'RC' });
      await memberships.grant(u.id, tenantA, 'active');
      return u.id;
    };
    userA = await mkUser(`rc.a.${stamp}@example.com`);
    userB = await mkUser(`rc.b.${stamp}@example.com`);

    // Permitted at BOTH branches — proves the branch-scoping test isn't
    // confounded with the (already-covered) permitted-branch guard.
    employeeA = (
      await employees.create(tenantA, userA, {
        code: codeA,
        displayName: 'Recovery Cashier',
        homeBranchId: branchA,
        userId: userA,
        permittedBranchIds: [branchA2],
      })
    ).id;
    employeeB = (
      await employees.create(tenantA, userB, {
        code: codeB,
        displayName: 'Other Cashier',
        homeBranchId: branchA,
        userId: userB,
      })
    ).id;

    const permissions = app.get(PermissionsService);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const cashier = await roles.createTenantRole(tenantA, {
      name: `rc_cashier_${stamp}`,
    });
    await roles.addPermissions(
      tenantA,
      cashier.id,
      TREASURY_PERMISSION_DEFS.map((d) => d.code),
    );
    for (const userId of [userA, userB]) {
      const membership = await admin.membership.findFirstOrThrow({
        where: { userId, tenantId: tenantA },
      });
      await membershipRoles.create(tenantA, null, {
        membershipId: membership.id,
        roleId: cashier.id,
        scope: { type: 'tenant' },
      });
    }

    const pins = app.get(PinService);
    await pins.setPin(tenantA, userA, employeeA, PIN_A);
    await pins.setPin(tenantA, userB, employeeB, PIN_B);

    drawerA = (
      await drawers.create(tenantA, userA, { branchId: branchA, name: 'RC Till 1' })
    ).id;
    drawerA2 = (
      await drawers.create(tenantA, userA, { branchId: branchA2, name: 'RC Till X' })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------ (A)/(D)

  describe('same employee, terminal-branch scoped recovery', () => {
    it('returns null before any session is opened — normal Open Shift path', async () => {
      const token = await pinLogin(tenantA, terminalA, codeA, PIN_A);
      const res = await current(token).expect(200);
      expect((res.body as CurrentBody).cashSession).toBeNull();
    });

    it('A: a SECOND PIN session for the same employee resolves the SAME cash session id', async () => {
      const firstToken = await pinLogin(tenantA, terminalA, codeA, PIN_A);
      const cashSessionId = newId();
      const openRes = await open(firstToken, {
        shiftId: newId(),
        cashSessionId,
        drawerId: drawerA,
        openingFloat: '10000',
      });
      expect(openRes.status).toBe(201);

      // Simulates the frontend losing `cashSessionId` (reload/deploy) and
      // re-authenticating from scratch — a BRAND NEW PIN session/token.
      const secondToken = await pinLogin(tenantA, terminalA, codeA, PIN_A);
      expect(secondToken).not.toBe(firstToken);

      const res = await current(secondToken).expect(200);
      const body = res.body as CurrentBody;
      expect(body.cashSession).not.toBeNull();
      expect(body.cashSession!.id).toBe(cashSessionId);
      expect(body.cashSession!.employeeId).toBe(employeeA);
    });

    it('D: the second open remains correctly blocked while the recoverable session stays open (FR-FIN-001)', async () => {
      const token = await pinLogin(tenantA, terminalA, codeA, PIN_A);
      // employeeA already has an open session on drawerA from the prior test.
      const res = await open(token, {
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: drawerA,
        openingFloat: '5000',
      });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/FR-FIN-001|already has an open/i);

      // And recovery still resolves the ORIGINAL session, not the rejected one.
      const cur = await current(token).expect(200);
      expect((cur.body as CurrentBody).cashSession!.employeeId).toBe(employeeA);
    });
  });

  // --------------------------------------------------------------- (B)

  describe('different employee', () => {
    it('B: cannot recover another employee’s open session', async () => {
      // employeeA holds an open session on drawerA (opened above). employeeB
      // logs in on the SAME terminal/branch and must see nothing.
      const tokenB = await pinLogin(tenantA, terminalA, codeB, PIN_B);
      const res = await current(tokenB).expect(200);
      expect((res.body as CurrentBody).cashSession).toBeNull();
    });
  });

  // --------------------------------------------------------------- (C)

  describe('wrong branch', () => {
    it('C: cannot recover a session open at a DIFFERENT branch, even for the same (permitted) employee', async () => {
      // employeeA is permitted at branchA2 too, but their open session lives
      // at branchA. Logging in via the branchA2 terminal must not see it.
      const token = await pinLogin(tenantA, terminalA2, codeA, PIN_A);
      const res = await current(token).expect(200);
      expect((res.body as CurrentBody).cashSession).toBeNull();

      // Positive control: a genuinely open session AT branchA2 IS returned.
      const openRes = await open(token, {
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: drawerA2,
        openingFloat: '0',
      });
      expect(openRes.status).toBe(201);
      const cur = await current(token).expect(200);
      expect((cur.body as CurrentBody).cashSession!.branchId).toBe(branchA2);
    });
  });

  // ----------------------------------------------------------- authz

  describe('authorization', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(http).get('/cash-sessions/current');
      expect(res.status).toBe(401);
    });
  });
});
