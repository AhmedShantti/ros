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
import { CashClosePolicyService } from './../src/modules/treasury/cash-close-policy/cash-close-policy.service';
import { CashSessionsService } from './../src/modules/treasury/cash-sessions/cash-sessions.service';
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
import { TREASURY_PERMISSION_DEFS } from './../src/modules/treasury/treasury.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * DEMO-MANAGER-CASH-SESSIONS-P0 — `GET /branches/{branchId}/cash-sessions/open`.
 *
 * Reproduces and closes the production discovery gap: a manager holding
 * `cash.session.close_other` already has a fully-implemented close-other
 * workflow (`GET .../close-context`, `POST .../close`,
 * `POST .../close/finalize` — proven exhaustively by
 * `cash-session-close.e2e-spec.ts`'s "own/other authority" suite, not
 * duplicated here) but had NO route to discover the `sessionId` of another
 * employee's stranded open session in the first place. This file is scoped
 * to the NEW discovery read and to proving a discovered id is a real,
 * unmodified admission ticket into that existing workflow (mission items
 * A-G) — it does not re-prove close-other's own business rules from
 * scratch.
 *
 * ── TWO TOKENS FOR THE SAME MANAGER ────────────────────────────────────────
 * Discovery is a DASHBOARD route (no `@AllowPosSession` — see
 * `OpenCashSessionsController`'s docblock), so the manager reaches it with a
 * DASHBOARD token (`/auth/login` + `/auth/tenant`). The existing close-other
 * routes on `TreasuryController` still require a terminal-bound identity
 * (`requirePosIdentity`), so completing the workflow on a discovered id uses
 * the SAME manager's PIN/POS token instead. Both tokens resolve to the same
 * underlying employee/permissions — this mirrors a real manager who checks
 * the back-office console, then acts at the terminal.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_MANAGER = '9001';
const PIN_CASHIER_A1 = '9002';
const PIN_CASHIER_A2 = '9003';
const PIN_CASHIER_B = '9004';
const PIN_APPROVER = '9006';
const TOLERANCE = 1_000n;

interface OpenSessionRow {
  sessionId: string;
  branchId: string;
  drawerId: string;
  drawerName: string;
  employeeId: string;
  employeeName: string;
  status: 'open' | 'closing';
  openedAt: string;
  openingFloat: string;
  currency: string;
}
interface Tokens {
  accessToken: string;
}

describe('Manager cash-session discovery (e2e) — GET /branches/:branchId/cash-sessions/open', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let cashSessions: CashSessionsService;
  let drawers: DrawersService;

  let tenantA: string;
  let branchA: string;
  let branchB: string;
  let terminalA: string;
  let terminalB: string;

  let userManager: string;
  let employeeManager: string;
  let userCashierA1: string;
  let employeeCashierA1: string;
  let userCashierA2: string;
  let employeeCashierA2: string;
  let userCashierB: string;
  let employeeCashierB: string;
  let userPlainCashier: string;
  let userApprover: string;
  let employeeApprover: string;

  const emailManager = `dm.manager.${stamp}@example.com`;
  const emailPlainCashier = `dm.plain.${stamp}@example.com`;

  const codeManager = `DMM${stamp % 1000}`;
  const codeCashierA1 = `DMA1${stamp % 1000}`;
  const codeCashierA2 = `DMA2${stamp % 1000}`;
  const codeCashierB = `DMB${stamp % 1000}`;
  const codePlainCashier = `DMP${stamp % 1000}`;
  const codeApprover = `DMV${stamp % 1000}`;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const mkBranch = async (tenantId: string, code: string) => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `DM Brand ${code}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code,
        name: `DM Branch ${code}`,
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

  /** Dashboard token — `/auth/login` (email+password) then `/auth/tenant`. */
  const dashboardLogin = async (email: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .send({ tenantId: tenantA })
      .expect(200);
    return (sel.body as Tokens).accessToken;
  };

  const listOpen = (token: string, branchId: string) =>
    request(http)
      .get(`/branches/${branchId}/cash-sessions/open`)
      .set(auth(token));

  const context = (token: string, sessionId: string) =>
    request(http)
      .get(`/cash-sessions/${sessionId}/close-context`)
      .set(auth(token));

  const declare = (
    token: string,
    sessionId: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .post(`/cash-sessions/${sessionId}/close`)
      .set(auth(token))
      .set('Idempotency-Key', `dm-declare-${newId()}`)
      .send(body);

  const finalize = (
    token: string,
    sessionId: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .post(`/cash-sessions/${sessionId}/close/finalize`)
      .set(auth(token))
      .set('Idempotency-Key', `dm-finalize-${newId()}`)
      .send(body);

  let drawerSeq = 0;
  const openSession = async (
    branchId: string,
    employeeId: string,
    terminalId: string,
    openingFloat = '50000',
  ): Promise<{ sessionId: string; drawerId: string; drawerName: string }> => {
    drawerSeq += 1;
    const drawerName = `DM Till ${drawerSeq}`;
    const drawer = await drawers.create(tenantA, userManager, {
      branchId,
      name: drawerName,
    });
    const { session } = await cashSessions.open(tenantA, userManager, {
      shiftId: newId(),
      cashSessionId: newId(),
      drawerId: drawer.id,
      openingFloat,
      terminalId,
      employeeId,
    });
    return { sessionId: session.id, drawerId: drawer.id, drawerName };
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
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    cashSessions = app.get(CashSessionsService);
    drawers = app.get(DrawersService);

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);
    const pins = app.get(PinService);
    const permissions = app.get(PermissionsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const policies = app.get(CashClosePolicyService);

    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);

    tenantA = (
      await tenants.create({
        slug: `dm-${stamp}`,
        legalName: `dm-${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    branchA = await mkBranch(tenantA, `DMA${stamp % 10000}`);
    branchB = await mkBranch(tenantA, `DMB${stamp % 10000}`);
    terminalA = await mkTerminal(tenantA, branchA, 'DM-POS-A');
    terminalB = await mkTerminal(tenantA, branchB, 'DM-POS-B');

    const mkUser = async (email: string) => {
      const u = await users.createUser({ email, password, displayName: 'DM' });
      await memberships.grant(u.id, tenantA, 'active');
      return u.id;
    };
    userManager = await mkUser(emailManager);
    userCashierA1 = await mkUser(`dm.a1.${stamp}@example.com`);
    userCashierA2 = await mkUser(`dm.a2.${stamp}@example.com`);
    userCashierB = await mkUser(`dm.b.${stamp}@example.com`);
    userPlainCashier = await mkUser(emailPlainCashier);
    userApprover = await mkUser(`dm.approver.${stamp}@example.com`);

    employeeManager = (
      await employees.create(tenantA, userManager, {
        code: codeManager,
        displayName: 'Discovery Manager',
        homeBranchId: branchA,
        userId: userManager,
        permittedBranchIds: [branchB],
      })
    ).id;
    employeeCashierA1 = (
      await employees.create(tenantA, userManager, {
        code: codeCashierA1,
        displayName: 'Stranded Cashier One',
        homeBranchId: branchA,
        userId: userCashierA1,
      })
    ).id;
    employeeCashierA2 = (
      await employees.create(tenantA, userManager, {
        code: codeCashierA2,
        displayName: 'Stranded Cashier Two',
        homeBranchId: branchA,
        userId: userCashierA2,
      })
    ).id;
    employeeCashierB = (
      await employees.create(tenantA, userManager, {
        code: codeCashierB,
        displayName: 'Branch B Cashier',
        homeBranchId: branchB,
        userId: userCashierB,
      })
    ).id;
    await employees.create(tenantA, userManager, {
      code: codePlainCashier,
      displayName: 'Plain Cashier',
      homeBranchId: branchA,
      userId: userPlainCashier,
    });
    // A SEPARATE identity for the variance-approval decision — distinct
    // from the manager who calls declare/finalize (the requester), so
    // finalize's self-approval-as-requester rule is not tripped. Mirrors
    // `cash-session-close.e2e-spec.ts`'s own three-actor shape (owner /
    // closer / approver).
    employeeApprover = (
      await employees.create(tenantA, userManager, {
        code: codeApprover,
        displayName: 'Variance Approver',
        homeBranchId: branchA,
        userId: userApprover,
      })
    ).id;

    await pins.setPin(tenantA, userManager, employeeManager, PIN_MANAGER);
    await pins.setPin(
      tenantA,
      userCashierA1,
      employeeCashierA1,
      PIN_CASHIER_A1,
    );
    await pins.setPin(
      tenantA,
      userCashierA2,
      employeeCashierA2,
      PIN_CASHIER_A2,
    );
    await pins.setPin(tenantA, userCashierB, employeeCashierB, PIN_CASHIER_B);
    await pins.setPin(tenantA, userApprover, employeeApprover, PIN_APPROVER);

    // ── Roles ──────────────────────────────────────────────────────────
    // Manager: `cash.session.close_other` scoped to branchA ONLY (item C —
    // proves branch scoping is enforced, not just tenant-wide).
    const managerRole = await roles.createTenantRole(tenantA, {
      name: `dm_manager_${stamp}`,
    });
    await roles.addPermissions(tenantA, managerRole.id, [
      'cash.session.close_other',
      'cash.session.open',
    ]);
    // Plain cashier: session-open/close-own only, deliberately WITHOUT
    // close_other (item D).
    const plainCashierRole = await roles.createTenantRole(tenantA, {
      name: `dm_plain_${stamp}`,
    });
    await roles.addPermissions(tenantA, plainCashierRole.id, [
      'cash.session.open',
      'cash.session.close',
    ]);
    // Approver: `cash.variance.approve` ONLY — the separate identity PIN
    // -verified inside finalize (never the discovery/close_other caller).
    const approverRole = await roles.createTenantRole(tenantA, {
      name: `dm_approver_${stamp}`,
    });
    await roles.addPermissions(tenantA, approverRole.id, [
      'cash.variance.approve',
    ]);

    const assign = async (
      userId: string,
      roleId: string,
      scope: { type: 'tenant' } | { type: 'branch'; branchId: string },
    ) => {
      const m = await admin.membership.findFirstOrThrow({
        where: { userId, tenantId: tenantA },
      });
      await membershipRoles.create(tenantA, null, {
        membershipId: m.id,
        roleId,
        scope,
      });
    };
    await assign(userManager, managerRole.id, {
      type: 'branch',
      branchId: branchA,
    });
    await assign(userCashierA1, plainCashierRole.id, { type: 'tenant' });
    await assign(userCashierA2, plainCashierRole.id, { type: 'tenant' });
    await assign(userCashierB, plainCashierRole.id, { type: 'tenant' });
    await assign(userPlainCashier, plainCashierRole.id, { type: 'tenant' });
    await assign(userApprover, approverRole.id, { type: 'tenant' });

    // ── Cash-close policy — blind mode, small tolerance, effective now. ──
    await policies.create(tenantA, userManager, {
      branchId: branchA,
      varianceToleranceMinorUnits: TOLERANCE.toString(),
      varianceApprovalExpirySeconds: 300,
    });
  }, 90_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // --------------------------------------------------------------- A/B

  describe('authorized manager discovery', () => {
    it('A/B: sees open sessions at their branch, with drawer + employee ownership fields', async () => {
      const s1 = await openSession(
        branchA,
        employeeCashierA1,
        terminalA,
        '50000',
      );
      const s2 = await openSession(
        branchA,
        employeeCashierA2,
        terminalA,
        '30000',
      );

      const managerDashboardToken = await dashboardLogin(emailManager);
      const res = await listOpen(managerDashboardToken, branchA).expect(200);
      const rows = res.body as OpenSessionRow[];

      const row1 = rows.find((r) => r.sessionId === s1.sessionId);
      const row2 = rows.find((r) => r.sessionId === s2.sessionId);
      expect(row1).toBeDefined();
      expect(row2).toBeDefined();

      expect(row1!.drawerId).toBe(s1.drawerId);
      expect(row1!.drawerName).toBe(s1.drawerName);
      expect(row1!.employeeId).toBe(employeeCashierA1);
      expect(row1!.employeeName).toBe('Stranded Cashier One');
      expect(row1!.branchId).toBe(branchA);
      expect(row1!.status).toBe('open');
      expect(row1!.currency).toBe('EGP');
      expect(row1!.openingFloat).toBe('50000');
      expect(typeof row1!.openedAt).toBe('string');

      expect(row2!.employeeName).toBe('Stranded Cashier Two');
      expect(row2!.openingFloat).toBe('30000');
    });
  });

  // ----------------------------------------------------------------- C

  describe('branch scoping', () => {
    it('C: cannot see sessions at an unauthorized branch', async () => {
      await openSession(branchB, employeeCashierB, terminalB, '10000');

      const managerDashboardToken = await dashboardLogin(emailManager);
      const res = await listOpen(managerDashboardToken, branchB);
      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------------- D

  describe('cashier without close_other', () => {
    it('D: cannot enumerate other sessions', async () => {
      const cashierDashboardToken = await dashboardLogin(emailPlainCashier);
      const res = await listOpen(cashierDashboardToken, branchA);
      expect(res.status).toBe(403);
    });
  });

  // ----------------------------------------------------------- E, F, G

  describe('close-other compatibility and lifecycle', () => {
    it('E/F/G: a discovered id completes the EXISTING close-other workflow, enforces count/variance/finalize rules, and disappears once closed', async () => {
      const managerDashboardToken = await dashboardLogin(emailManager);
      const managerPosToken = await pinLogin(
        tenantA,
        terminalA,
        codeManager,
        PIN_MANAGER,
      );

      // Two fresh stranded sessions, discovered together.
      const within = await openSession(
        branchA,
        employeeCashierA1,
        terminalA,
        '20000',
      );
      const above = await openSession(
        branchA,
        employeeCashierA2,
        terminalA,
        '40000',
      );

      const before = (
        await listOpen(managerDashboardToken, branchA).expect(200)
      ).body as OpenSessionRow[];
      expect(before.some((r) => r.sessionId === within.sessionId)).toBe(true);
      expect(before.some((r) => r.sessionId === above.sessionId)).toBe(true);

      // F: the discovered id is a real close-other admission ticket —
      // close-context works for a NON-owner manager (via their POS token,
      // since `TreasuryController` requires a terminal-bound identity).
      const ctxRes = await context(managerPosToken, within.sessionId).expect(
        200,
      );
      expect((ctxRes.body as { status: string }).status).toBe('open');

      // F: within-tolerance close-other — one request, closes immediately.
      const withinDeclare = await declare(managerPosToken, within.sessionId, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '20000',
      });
      expect(withinDeclare.status).toBe(201);
      expect((withinDeclare.body as { status: string }).status).toBe('closed');

      // G: above-tolerance close-other STILL freezes for a manager decision
      // — discovery does not bypass count/variance/finalize.
      const aboveDeclare = await declare(managerPosToken, above.sessionId, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: (40_000n + TOLERANCE + 1n).toString(),
      });
      expect(aboveDeclare.status).toBe(201);
      const aboveBody = aboveDeclare.body as {
        status: string;
        approvalRequired: boolean;
        varianceMinorUnits: string;
      };
      expect(aboveBody.status).toBe('closing');
      expect(aboveBody.approvalRequired).toBe(true);
      expect(aboveBody.varianceMinorUnits).toBe((TOLERANCE + 1n).toString());

      // 'closing' sessions still surface (they are just as "stranded" as
      // 'open' ones from a manager's point of view) — proven before finalize.
      const midList = (
        await listOpen(managerDashboardToken, branchA).expect(200)
      ).body as OpenSessionRow[];
      const aboveRow = midList.find((r) => r.sessionId === above.sessionId);
      expect(aboveRow).toBeDefined();
      expect(aboveRow!.status).toBe('closing');
      // The now-closed session is gone (E, proven early here too).
      expect(midList.some((r) => r.sessionId === within.sessionId)).toBe(false);

      const finalizeRes = await finalize(managerPosToken, above.sessionId, {
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
        decision: 'approved',
        reason: 'Manager verified the recount for the discovered session.',
        managerEmployeeCode: codeApprover,
        managerPin: PIN_APPROVER,
      });
      expect(finalizeRes.status).toBe(200);
      expect((finalizeRes.body as { outcome: string }).outcome).toBe('closed');

      // E: once finalized closed, it drops off the discovery list too.
      const after = (await listOpen(managerDashboardToken, branchA).expect(200))
        .body as OpenSessionRow[];
      expect(after.some((r) => r.sessionId === above.sessionId)).toBe(false);

      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: above.sessionId },
      });
      expect(session.status).toBe('closed');
    });
  });

  // ------------------------------------------------------------- authz

  describe('authentication and not-found', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(http).get(
        `/branches/${branchA}/cash-sessions/open`,
      );
      expect(res.status).toBe(401);
    });

    it('rejects a POS/PIN session — this is a dashboard-only route', async () => {
      const posToken = await pinLogin(
        tenantA,
        terminalA,
        codeManager,
        PIN_MANAGER,
      );
      const res = await listOpen(posToken, branchA);
      expect(res.status).toBe(403);
    });

    it('unknown branch id -> 404', async () => {
      const managerDashboardToken = await dashboardLogin(emailManager);
      const res = await listOpen(managerDashboardToken, newId());
      expect(res.status).toBe(404);
    });
  });
});
