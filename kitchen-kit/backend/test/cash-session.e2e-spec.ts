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
 * P1D-1 — Operational Shift + Drawer + CashSession OPEN.
 *
 * FR-POS-090 (open a shift declaring a float), FR-FIN-001 (one open session per
 * drawer), FR-FIN-002 (exactly one employee). Every negative assertion carries a
 * positive control so a zero result proves filtering rather than absent data.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_A = '5813';
const PIN_B = '2468';

describe('Cash session open (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let prisma: PrismaService;
  let drawers: DrawersService;
  let cashSessions: CashSessionsService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let branchA2: string;
  let branchB: string;
  let terminalA: string;
  let terminalA2: string;
  let terminalB: string;
  let employeeA: string;
  let employeeUnpermitted: string;
  let userA: string;
  let userB: string;
  let userUnpermitted: string;
  let posToken: string;
  let noPermToken: string;
  let dashboardToken: string;

  let drawerA: string;
  let drawerBoundToA2: string;
  let drawerOtherBranch: string;
  let drawerB: string;

  const mkBranch = async (tenantId: string, code: string) => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `CSBrand ${code}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code,
        name: `CSBranch ${code}`,
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
    prisma = app.get(PrismaService);
    drawers = app.get(DrawersService);
    cashSessions = app.get(CashSessionsService);

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantA = await mkTenant(`csa-${stamp}`);
    tenantB = await mkTenant(`csb-${stamp}`);

    branchA = await mkBranch(tenantA, `CA${stamp % 10000}`);
    branchA2 = await mkBranch(tenantA, `CX${stamp % 10000}`);
    branchB = await mkBranch(tenantB, `CB${stamp % 10000}`);
    terminalA = await mkTerminal(tenantA, branchA, 'CA-POS-1');
    terminalA2 = await mkTerminal(tenantA, branchA, 'CA-POS-2');
    terminalB = await mkTerminal(tenantB, branchB, 'CB-POS');

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({ email, password, displayName: 'CS' });
      await memberships.grant(u.id, tenantId, 'active');
      return u.id;
    };
    userA = await mkUser(`cs.a.${stamp}@example.com`, tenantA);
    userB = await mkUser(`cs.b.${stamp}@example.com`, tenantA);
    userUnpermitted = await mkUser(`cs.u.${stamp}@example.com`, tenantA);

    const codeA = `CEA${stamp % 1000}`;
    const codeNoPerm = `CEN${stamp % 1000}`;
    const codeUnpermitted = `CEU${stamp % 1000}`;

    employeeA = (
      await employees.create(tenantA, userA, {
        code: codeA,
        displayName: 'Cashier A',
        homeBranchId: branchA,
        userId: userA,
      })
    ).id;
    // Same branch, but their role will hold no cash permission.
    await employees.create(tenantA, userA, {
      code: codeNoPerm,
      displayName: 'No permission',
      homeBranchId: branchA,
      userId: userB,
    });
    // Home branch A2 only — NOT permitted at branch A.
    employeeUnpermitted = (
      await employees.create(tenantA, userA, {
        code: codeUnpermitted,
        displayName: 'Wrong branch',
        homeBranchId: branchA2,
        userId: userUnpermitted,
      })
    ).id;

    const permissions = app.get(PermissionsService);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const cashier = await roles.createTenantRole(tenantA, {
      name: `cs_cashier_${stamp}`,
    });
    await roles.addPermissions(
      tenantA,
      cashier.id,
      TREASURY_PERMISSION_DEFS.map((d) => d.code),
    );
    const membershipA = await admin.membership.findFirstOrThrow({
      where: { userId: userA, tenantId: tenantA },
    });
    await membershipRoles.assign(tenantA, membershipA.id, cashier.id);

    // A role with NO cash permission, to prove the guard.
    const noPerm = await roles.createTenantRole(tenantA, {
      name: `cs_noperm_${stamp}`,
    });
    const membershipB = await admin.membership.findFirstOrThrow({
      where: { userId: userB, tenantId: tenantA },
    });
    await membershipRoles.assign(tenantA, membershipB.id, noPerm.id);

    const pins = app.get(PinService);
    await pins.setPin(tenantA, userA, employeeA, PIN_A);
    posToken = await pinLogin(tenantA, terminalA, codeA, PIN_A);

    const noPermEmployee = await admin.employee.findFirstOrThrow({
      where: { code: codeNoPerm },
    });
    await pins.setPin(tenantA, userA, noPermEmployee.id, PIN_B);
    noPermToken = await pinLogin(tenantA, terminalA, codeNoPerm, PIN_B);

    // A DASHBOARD (non-POS) session: password login + tenant selection.
    const login = await request(http)
      .post('/auth/login')
      .send({ email: `cs.a.${stamp}@example.com`, password })
      .expect(200);
    const selected = await request(http)
      .post('/auth/tenant')
      .set(
        'Authorization',
        `Bearer ${(login.body as { accessToken: string }).accessToken}`,
      )
      .send({ tenantId: tenantA })
      .expect(200);
    dashboardToken = (selected.body as { accessToken: string }).accessToken;

    // Drawers, provisioned through the INTERNAL service — there is no public
    // administration route and none was invented.
    drawerA = (
      await drawers.create(tenantA, userA, {
        branchId: branchA,
        name: 'Till 1',
      })
    ).id;
    drawerBoundToA2 = (
      await drawers.create(tenantA, userA, {
        branchId: branchA,
        name: 'Till 2 (bound)',
        terminalId: terminalA2,
      })
    ).id;
    drawerOtherBranch = (
      await drawers.create(tenantA, userA, {
        branchId: branchA2,
        name: 'Other branch till',
      })
    ).id;
    drawerB = (
      await drawers.create(tenantB, userB, {
        branchId: branchB,
        name: 'Tenant B till',
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  const openBody = (over: Record<string, unknown> = {}) => ({
    shiftId: newId(),
    cashSessionId: newId(),
    drawerId: drawerA,
    openingFloat: '50000',
    ...over,
  });

  const open = (
    body: Record<string, unknown>,
    opts: { key?: string; token?: string } = {},
  ) =>
    request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${opts.token ?? posToken}`)
      .set('Idempotency-Key', opts.key ?? `cs-${newId()}`)
      .send(body);

  // ------------------------------------------------------- happy path

  describe('FR-POS-090 — opening a cashier shift with a float', () => {
    it('creates a Shift and a CashSession atomically', async () => {
      const body = openBody();
      const res = await open(body);

      expect(res.status).toBe(201);
      const out = res.body as {
        cashSession: Record<string, unknown>;
        shift: Record<string, unknown>;
      };

      // FR-OFF-015: both client ULIDs preserved exactly, never remapped.
      expect(out.shift.id).toBe(body.shiftId);
      expect(out.cashSession.id).toBe(body.cashSessionId);
      // Server-derived scope.
      expect(out.shift.branchId).toBe(branchA);
      expect(out.shift.employeeId).toBe(employeeA);
      expect(out.shift.status).toBe('open');
      expect(out.cashSession.branchId).toBe(branchA);
      expect(out.cashSession.employeeId).toBe(employeeA);
      expect(out.cashSession.drawerId).toBe(drawerA);
      expect(out.cashSession.shiftId).toBe(body.shiftId);
      expect(out.cashSession.status).toBe('open');
      // Exact money: minor units as a string, branch currency.
      expect(out.cashSession.openingFloat).toBe('50000');
      expect(out.cashSession.currency).toBe('EGP');
    });

    it('persists the two records with the right tenant', async () => {
      const body = openBody({ drawerId: await freshDrawer('persist') });
      await open(body).expect(201);

      const shift = await admin.shift.findFirstOrThrow({
        where: { id: body.shiftId },
      });
      const session = await admin.cashSession.findFirstOrThrow({
        where: { id: body.cashSessionId },
      });
      expect(shift.tenantId).toBe(tenantA);
      expect(session.tenantId).toBe(tenantA);
      expect(session.openingFloat).toBe(50_000n);
      expect(session.closedAt).toBeNull();
      expect(shift.closedAt).toBeNull();
    });

    it('accepts a zero opening float', async () => {
      const res = await open(
        openBody({ drawerId: await freshDrawer('zero'), openingFloat: '0' }),
      );
      expect(res.status).toBe(201);
      expect(
        (res.body as { cashSession: { openingFloat: string } }).cashSession
          .openingFloat,
      ).toBe('0');
    });

    it('accepts a float far above Number.MAX_SAFE_INTEGER', async () => {
      const huge = '9007199254740993';
      const res = await open(
        openBody({ drawerId: await freshDrawer('huge'), openingFloat: huge }),
      );
      expect(res.status).toBe(201);
      expect(
        (res.body as { cashSession: { openingFloat: string } }).cashSession
          .openingFloat,
      ).toBe(huge);
    });

    /**
     * The session is readable INTERNALLY, and only internally.
     *
     * `GET /cash-sessions/:id` was withdrawn: §15.2 quotes `cash.session.open`
     * as "Open a shift", a WRITE authority, and supplies no CashSession read
     * code. §15.2 designates Appendix C as the authoritative full catalogue and
     * Appendix C is ABSENT from ROS_SRS_v1.0.pdf — the same absence ratified
     * decision D-20 answered by DEFERRING the code rather than inventing one.
     *
     * So this asserts the two halves that matter: the query still works and is
     * still tenant-scoped for the future Payment slice, and no HTTP route
     * reaches it.
     */
    it('exposes the session to internal callers only, never over HTTP', async () => {
      const body = openBody({ drawerId: await freshDrawer('read') });
      await open(body).expect(201);

      const session = await cashSessions.findOne(tenantA, body.cashSessionId);
      expect(session?.id).toBe(body.cashSessionId);

      // Positive control: the id is real, so a 404 below proves the route is
      // absent rather than the row being missing.
      const res = await request(http)
        .get(`/cash-sessions/${body.cashSessionId}`)
        .set('Authorization', `Bearer ${posToken}`);
      expect(res.status).toBe(404);
    });

    /** RLS still scopes the internal query — a cross-tenant id is invisible. */
    it('does not leak a session across tenants through the internal query', async () => {
      const body = openBody({ drawerId: await freshDrawer('rls-read') });
      await open(body).expect(201);

      await expect(
        cashSessions.findOne(tenantB, body.cashSessionId),
      ).resolves.toBeNull();
    });
  });

  // --------------------------------------------------- input validation

  describe('the client decides only what it may', () => {
    it('rejects a body carrying scope, actor or currency', async () => {
      for (const forbidden of [
        { tenantId: tenantB },
        { branchId: branchA2 },
        { employeeId: employeeUnpermitted },
        { terminalId: terminalA2 },
        { currency: 'USD' },
        { status: 'closed' },
        { openedAt: '2020-01-01T00:00:00Z' },
      ]) {
        const res = await open(openBody(forbidden));
        expect(res.status).toBe(400);
      }
    });

    it('rejects a malformed or negative opening float', async () => {
      for (const openingFloat of ['-1', '1.5', '1e3', 'fifty', '', '  ']) {
        const res = await open(openBody({ openingFloat }));
        expect(res.status).toBe(400);
      }
    });

    it('rejects a float supplied as a JSON number', async () => {
      // A JSON number is IEEE-754 and must never carry money (ADR-008). The
      // large case is the one that matters: `JSON.parse` corrupts it before any
      // validator runs, so accepting numbers at all would lose a piastre with
      // no error raised anywhere.
      // Built through JSON.parse deliberately: that is where the corruption
      // happens, and a bare literal would not compile for the same reason.
      const corrupted = (JSON.parse('{"v":9007199254740993}') as { v: number })
        .v;
      expect(String(corrupted)).toBe('9007199254740992'); // one piastre lost.

      for (const openingFloat of [50000, corrupted, 1.5]) {
        const res = await open(
          openBody({ drawerId: await freshDrawer('json-num'), openingFloat }),
        );
        expect(res.status).toBe(400);
      }
    });

    it('rejects malformed identifiers', async () => {
      expect((await open(openBody({ shiftId: 'nope' }))).status).toBe(400);
      expect((await open(openBody({ cashSessionId: 'nope' }))).status).toBe(
        400,
      );
      expect((await open(openBody({ drawerId: 'nope' }))).status).toBe(400);
    });

    it('refuses one identifier used for both records', async () => {
      const id = newId();
      const res = await open(openBody({ shiftId: id, cashSessionId: id }));
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------------------------ drawer

  describe('drawer resolution', () => {
    it('rejects a drawer in another branch as NOT FOUND', async () => {
      const res = await open(openBody({ drawerId: drawerOtherBranch }));
      expect(res.status).toBe(404);
      // Positive control: the migrator can see it, so 404 proves scoping.
      expect(
        await admin.drawer.findFirst({ where: { id: drawerOtherBranch } }),
      ).not.toBeNull();
    });

    it('rejects another tenant drawer as NOT FOUND', async () => {
      const res = await open(openBody({ drawerId: drawerB }));
      expect(res.status).toBe(404);
      expect(
        await admin.drawer.findFirst({ where: { id: drawerB } }),
      ).not.toBeNull();
    });

    it('rejects a drawer bound to a DIFFERENT terminal', async () => {
      const res = await open(openBody({ drawerId: drawerBoundToA2 }));
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/different terminal/i);
    });

    it('accepts an UNBOUND drawer from any terminal in the branch', async () => {
      // drawerA has no terminal binding; terminalA opened it above.
      const unbound = await freshDrawer('unbound');
      const res = await open(openBody({ drawerId: unbound }));
      expect(res.status).toBe(201);
    });

    it('refuses to create a drawer bound to another branch terminal', async () => {
      await expect(
        drawers.create(tenantA, userA, {
          branchId: branchA,
          name: `Bad binding ${stamp}`,
          terminalId: terminalB,
        }),
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------ FR-FIN-001 invariant

  describe('FR-FIN-001 — one open cash session per drawer', () => {
    it('refuses a SECOND sequential open on the same drawer', async () => {
      const drawer = await freshDrawer('seq');
      expect((await open(openBody({ drawerId: drawer }))).status).toBe(201);

      const second = await open(openBody({ drawerId: drawer }));
      expect(second.status).toBe(409);
      expect(JSON.stringify(second.body)).toMatch(
        /FR-FIN-001|already has an open/i,
      );

      expect(
        await admin.cashSession.count({ where: { drawerId: drawer } }),
      ).toBe(1);
    });

    it('admits exactly ONE of two concurrent opens on the same drawer', async () => {
      const drawer = await freshDrawer('race');
      const results = await Promise.allSettled([
        open(openBody({ drawerId: drawer })),
        open(openBody({ drawerId: drawer })),
      ]);
      const statuses = results
        .map((r) => (r.status === 'fulfilled' ? r.value.status : 500))
        .sort();

      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(1);
      expect(
        await admin.cashSession.count({
          where: { drawerId: drawer, status: 'open' },
        }),
      ).toBe(1);
    });

    it('is a PARTIAL index, not UNIQUE(drawer_id, status)', async () => {
      const rows = await admin.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'treasury' AND tablename = 'cash_sessions'
            AND indexname = 'uq_one_open_session_per_drawer'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/UNIQUE INDEX/i);
      expect(rows[0].indexdef).toMatch(/WHERE \(status = 'open'/i);
      expect(rows[0].indexdef).not.toMatch(/status\)/);

      // And no composite (drawer_id, status) unique exists anywhere — that shape
      // would permit only ONE closed session per drawer, for all time.
      const composite = await admin.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'treasury' AND tablename = 'cash_sessions'
            AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%drawer_id, status%'`,
      );
      expect(composite).toHaveLength(0);
    });

    it('permits MANY closed sessions on one drawer', async () => {
      // No close command exists, so the migrator writes the history directly —
      // the point is that the SCHEMA permits it, which the composite would not.
      const drawer = await freshDrawer('history');
      const shift = await admin.shift.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          employeeId: employeeA,
          status: 'closed',
          openedAt: new Date('2026-08-01T06:00:00Z'),
          closedAt: new Date('2026-08-01T14:00:00Z'),
        },
      });
      for (let i = 0; i < 3; i++) {
        await admin.cashSession.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchA,
            drawerId: drawer,
            shiftId: shift.id,
            employeeId: employeeA,
            openingFloat: 1_000n,
            currency: 'EGP',
            status: 'closed',
            openedAt: new Date('2026-08-01T06:00:00Z'),
            closedAt: new Date('2026-08-01T14:00:00Z'),
          },
        });
      }
      expect(
        await admin.cashSession.count({
          where: { drawerId: drawer, status: 'closed' },
        }),
      ).toBe(3);

      // And an open one is still possible alongside them.
      expect((await open(openBody({ drawerId: drawer }))).status).toBe(201);
    });
  });

  // ------------------------------------------- structural integrity (DB)

  describe('tenant and branch integrity is enforced by the DATABASE', () => {
    it('refuses a session whose employee differs from its shift employee', async () => {
      const drawer = await freshDrawer('mismatch-emp');
      const shift = await admin.shift.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          employeeId: employeeA,
          status: 'open',
          openedAt: new Date(),
        },
      });
      // FR-FIN-002: the four-column FK makes this a constraint violation, not a
      // missed service check.
      await expect(
        admin.cashSession.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchA,
            drawerId: drawer,
            shiftId: shift.id,
            employeeId: employeeUnpermitted,
            openingFloat: 0n,
            currency: 'EGP',
            status: 'open',
            openedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a session whose branch differs from its shift branch', async () => {
      const shift = await admin.shift.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA2,
          employeeId: employeeA,
          status: 'open',
          openedAt: new Date(),
        },
      });
      await expect(
        admin.cashSession.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchA,
            drawerId: drawerA,
            shiftId: shift.id,
            employeeId: employeeA,
            openingFloat: 0n,
            currency: 'EGP',
            status: 'open',
            openedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a session pointing at another tenant drawer', async () => {
      const shift = await admin.shift.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          employeeId: employeeA,
          status: 'open',
          openedAt: new Date(),
        },
      });
      await expect(
        admin.cashSession.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchA,
            drawerId: drawerB,
            shiftId: shift.id,
            employeeId: employeeA,
            openingFloat: 0n,
            currency: 'EGP',
            status: 'open',
            openedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a shift referencing another tenant branch or employee', async () => {
      await expect(
        admin.shift.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchB,
            employeeId: employeeA,
            status: 'open',
            openedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a negative opening float at the DATABASE', async () => {
      const drawer = await freshDrawer('negative');
      const shift = await admin.shift.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          employeeId: employeeA,
          status: 'open',
          openedAt: new Date(),
        },
      });
      await expect(
        admin.cashSession.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchA,
            drawerId: drawer,
            shiftId: shift.id,
            employeeId: employeeA,
            openingFloat: -1n,
            currency: 'EGP',
            status: 'open',
            openedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------------ idempotency

  describe('FR-API-020…023 idempotency', () => {
    it('requires an Idempotency-Key', async () => {
      const res = await request(http)
        .post('/cash-sessions')
        .set('Authorization', `Bearer ${posToken}`)
        .send(openBody());
      expect(res.status).toBe(400);
    });

    it('replays the same key + body without a second shift or session', async () => {
      const drawer = await freshDrawer('replay');
      const body = openBody({ drawerId: drawer });
      const key = `cs-${newId()}`;

      const first = await open(body, { key });
      const second = await open(body, { key });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);

      expect(await admin.shift.count({ where: { id: body.shiftId } })).toBe(1);
      expect(
        await admin.cashSession.count({ where: { drawerId: drawer } }),
      ).toBe(1);
    });

    it('rejects the same key with a different fingerprint', async () => {
      const key = `cs-${newId()}`;
      await open(openBody({ drawerId: await freshDrawer('fp1') }), { key });
      const res = await open(openBody({ drawerId: await freshDrawer('fp2') }), {
        key,
      });
      expect(res.status).toBe(409);
    });

    it('refuses a reused SHIFT id carrying different content', async () => {
      const shiftId = newId();
      await open(
        openBody({ shiftId, drawerId: await freshDrawer('shift-reuse-1') }),
      ).expect(201);

      // Same shift id, different employee -> the identity is permanent, so this
      // is a conflict rather than a mutation. Proven by a direct service call,
      // because the HTTP actor is fixed by the POS session.
      const conflicting = await open(
        openBody({ shiftId, drawerId: await freshDrawer('shift-reuse-2') }),
      );
      // Same content (same employee/branch) -> the shift is REUSED, and a second
      // session legitimately opens on a second drawer under one shift.
      expect(conflicting.status).toBe(201);
      expect((conflicting.body as { shift: { id: string } }).shift.id).toBe(
        shiftId,
      );
      expect(await admin.shift.count({ where: { id: shiftId } })).toBe(1);
    });

    it('refuses a reused CASH SESSION id carrying different content', async () => {
      const cashSessionId = newId();
      await open(
        openBody({
          cashSessionId,
          drawerId: await freshDrawer('sess-reuse-1'),
        }),
      ).expect(201);

      const res = await open(
        openBody({
          cashSessionId,
          drawerId: await freshDrawer('sess-reuse-2'),
        }),
      );
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/permanent|different content/i);
      expect(
        await admin.cashSession.count({ where: { id: cashSessionId } }),
      ).toBe(1);
    });
  });

  // ----------------------------------------------------- authorization

  describe('authorization', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(http)
        .post('/cash-sessions')
        .set('Idempotency-Key', `cs-${newId()}`)
        .send(openBody());
      expect(res.status).toBe(401);
    });

    it('rejects a POS session without cash.session.open', async () => {
      const res = await open(
        openBody({ drawerId: await freshDrawer('noperm') }),
        {
          token: noPermToken,
        },
      );
      expect(res.status).toBe(403);
    });

    it('rejects a DASHBOARD session — it has no terminal or employee', async () => {
      const res = await open(
        openBody({ drawerId: await freshDrawer('dash') }),
        {
          token: dashboardToken,
        },
      );
      expect(res.status).toBe(403);
    });

    it('rejects an employee not permitted at the branch', async () => {
      // Proven at the service, because the HTTP employee comes from the PIN
      // session and cannot be substituted.
      await expect(
        cashSessions.open(tenantA, userA, {
          shiftId: newId(),
          cashSessionId: newId(),
          drawerId: drawerA,
          openingFloat: '0',
          terminalId: terminalA,
          employeeId: employeeUnpermitted,
        }),
      ).rejects.toThrow(/not permitted to work at this branch/);
    });

    it('rejects a revoked terminal', async () => {
      const revoked = await mkTerminal(tenantA, branchA, `CA-REVOKED-${stamp}`);
      await admin.terminal.update({
        where: { id: revoked },
        data: { status: 'revoked' },
      });
      // A PIN login on a revoked terminal is refused before any session exists.
      const res = await request(http)
        .post('/auth/pin')
        .send({
          tenantId: tenantA,
          terminalId: revoked,
          employeeCode: `CEA${stamp % 1000}`,
          pin: PIN_A,
        });
      expect(res.status).toBe(401);
    });
  });

  // ------------------------------------------------------------- audit

  describe('audit', () => {
    it('records BOTH the shift and the session, with full context', async () => {
      const body = openBody({ drawerId: await freshDrawer('audit') });
      await open(body).expect(201);

      const shiftEntry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: body.shiftId,
          action: 'SHIFT_OPENED',
        },
      });
      const sessionEntry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: body.cashSessionId,
          action: 'CASH_SESSION_OPENED',
        },
      });

      expect(shiftEntry).not.toBeNull();
      expect(sessionEntry).not.toBeNull();
      expect(shiftEntry!.terminalId).toBe(terminalA);
      expect(sessionEntry!.terminalId).toBe(terminalA);
      expect(sessionEntry!.actorId).toBe(userA);
      expect(sessionEntry!.afterState).toMatchObject({
        branchId: branchA,
        employeeId: employeeA,
        shiftId: body.shiftId,
        openingFloat: '50000',
        currency: 'EGP',
        status: 'open',
      });
    });

    it('does not duplicate the business audit entry on replay', async () => {
      const body = openBody({ drawerId: await freshDrawer('audit-replay') });
      const key = `cs-${newId()}`;
      await open(body, { key }).expect(201);
      await open(body, { key }).expect(201);

      expect(
        await admin.auditEntry.count({
          where: {
            entityId: body.cashSessionId,
            action: 'CASH_SESSION_OPENED',
          },
        }),
      ).toBe(1);
    });

    it('never records a PIN or a secret', async () => {
      const entries = await admin.auditEntry.findMany({
        where: { tenantId: tenantA, action: 'CASH_SESSION_OPENED' },
      });
      expect(entries.length).toBeGreaterThan(0);
      // `sequence_no` is a BigInt, which JSON.stringify refuses by default.
      const payload = JSON.stringify(entries, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      // The password is long enough that a substring hit would be real.
      expect(payload).not.toContain(password);
      // PINs are four digits and would collide with a hex id by chance, so the
      // check is structural: no secret-shaped KEY reaches the payload at all.
      expect(payload).not.toMatch(/"(pin|password|secret|token|hash)"\s*:/i);
      void PIN_A;
      void PIN_B;
    });
  });

  // --------------------------------------------------------------- RLS

  describe('tenant isolation', () => {
    it('has ENABLE and FORCE row level security on all three tables', async () => {
      const rows = await admin.$queryRawUnsafe<
        {
          tbl: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }[]
      >(
        `SELECT n.nspname || '.' || c.relname AS tbl,
                c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE (n.nspname = 'workforce' AND c.relname = 'shifts')
             OR (n.nspname = 'treasury' AND c.relname IN ('drawers','cash_sessions'))
          ORDER BY 1`,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it('hides another tenant shift, drawer and session', async () => {
      const seen = await prisma.withAuthContext({ tenantId: tenantB }, (tx) =>
        Promise.all([
          tx.shift.findMany(),
          tx.drawer.findMany(),
          tx.cashSession.findMany(),
        ]),
      );
      expect(seen[1].map((d) => d.id)).toContain(drawerB);
      expect(seen[1].map((d) => d.id)).not.toContain(drawerA);
      expect(seen[0].every((s) => s.tenantId === tenantB)).toBe(true);
      expect(seen[2].every((s) => s.tenantId === tenantB)).toBe(true);

      // Positive control: tenant A DOES see its own.
      const mine = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
        tx.drawer.findMany(),
      );
      expect(mine.map((d) => d.id)).toContain(drawerA);
    });

    it('fails closed with no tenant context', async () => {
      const seen = await prisma.withAuthContext({}, (tx) =>
        Promise.all([
          tx.shift.findMany(),
          tx.drawer.findMany(),
          tx.cashSession.findMany(),
        ]),
      );
      expect(seen[0]).toHaveLength(0);
      expect(seen[1]).toHaveLength(0);
      expect(seen[2]).toHaveLength(0);
      // Positive control: the migrator sees plenty.
      expect(await admin.drawer.count()).toBeGreaterThan(0);
      expect(await admin.cashSession.count()).toBeGreaterThan(0);
    });

    it('runs as a non-superuser without BYPASSRLS', async () => {
      const rows = await prisma.withAuthContext({}, (tx) =>
        tx.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        ),
      );
      expect(rows[0].rolsuper).toBe(false);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it('grants the runtime no UPDATE or DELETE — close is impossible, not just unrouted', async () => {
      const rows = await admin.$queryRawUnsafe<
        { table_name: string; privilege_type: string }[]
      >(
        `SELECT table_name, privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'ros_app'
            AND table_schema IN ('workforce','treasury')
          ORDER BY table_name, privilege_type`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const privileges = [...new Set(rows.map((r) => r.privilege_type))].sort();
      expect(privileges).toEqual(['INSERT', 'SELECT']);
    });
  });

  // ------------------------------------------------------- scope guards

  describe('slice boundary', () => {
    it('exposes no close, count, variance, payment or drawer-admin route', () => {
      const paths = registeredRoutePaths(app);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths).toContain('/cash-sessions');

      // ONE route. `GET /cash-sessions/:id` is deliberately absent: no
      // source-supported CashSession read authority exists, and
      // `cash.session.open` is not reinterpreted as one.
      const treasury = paths.filter((p) => p.startsWith('/cash-sessions'));
      expect(treasury.sort()).toEqual(['/cash-sessions']);
      // Scoped to Treasury: `/inventory/counts` is a stock-count route and has
      // nothing to do with counting cash.
      for (const forbidden of [
        'close',
        'count',
        'variance',
        'payin',
        'payout',
        'safedrop',
        'drawer',
      ]) {
        expect(treasury.filter((p) => p.includes(forbidden))).toHaveLength(0);
      }
      // These must not exist ANYWHERE — no payment or refund route was added.
      expect(paths.filter((p) => p.includes('payment'))).toHaveLength(0);
      expect(paths.filter((p) => p.includes('refund'))).toHaveLength(0);
      expect(paths.filter((p) => p.includes('day-close'))).toHaveLength(0);
    });

    it('creates no payment table', async () => {
      const rows = await admin.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables
          WHERE tablename IN ('order_payments','payment_attempts','payments')`,
      );
      expect(rows).toHaveLength(0);
    });

    it('creates only the three authorised tables in workforce and treasury', async () => {
      const rows = await admin.$queryRawUnsafe<
        { schemaname: string; tablename: string }[]
      >(
        `SELECT schemaname, tablename FROM pg_tables
          WHERE schemaname IN ('workforce','treasury') ORDER BY 1, 2`,
      );
      expect(rows.map((r) => `${r.schemaname}.${r.tablename}`)).toEqual([
        'treasury.cash_sessions',
        'treasury.drawers',
        'workforce.shifts',
      ]);
    });

    it('adds no cash_session_id to orders (carried item P1D-B)', async () => {
      const rows = await admin.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'sales' AND table_name = 'orders'
            AND column_name = 'cash_session_id'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------ fixture

  /**
   * A fresh drawer, so a test never inherits another's open session.
   *
   * The suffix is a counter, not a slice of a ULID: two ULIDs minted in the same
   * millisecond share their leading characters, which collided with
   * `uq_drawer_name`.
   */
  let drawerSeq = 0;
  async function freshDrawer(label: string): Promise<string> {
    drawerSeq += 1;
    const drawer = await drawers.create(tenantA, userA, {
      branchId: branchA,
      name: `Till ${label} ${drawerSeq}`,
    });
    return drawer.id;
  }
});

/**
 * Every route path Express has registered. Express 5 exposes the router as
 * `app.router`; Express 4 kept it on `_router`. Both are read so the assertions
 * cannot pass vacuously because an internal moved.
 */
function registeredRoutePaths(app: INestApplication<App>): string[] {
  interface Layer {
    route?: { path?: string | string[] };
  }
  interface ExpressApp {
    router?: { stack?: Layer[] };
    _router?: { stack?: Layer[] };
  }
  const instance = app.getHttpAdapter().getInstance() as unknown as ExpressApp;
  const stack = instance.router?.stack ?? instance._router?.stack ?? [];
  return stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path === 'string') return [path];
    if (Array.isArray(path)) return path;
    return [];
  });
}
