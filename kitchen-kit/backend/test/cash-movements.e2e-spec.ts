import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { AuditService } from './../src/modules/governance/audit/audit.service';
import { CashSessionsService } from './../src/modules/treasury/cash-sessions/cash-sessions.service';
import { CashMovementTotalsQueryService } from './../src/modules/treasury/cash-movements/cash-movement-totals.query.service';
import { CashMovementsService } from './../src/modules/treasury/cash-movements/cash-movements.service';
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
import { TREASURY_PERMISSION_DEFS } from './../src/modules/treasury/treasury.permissions';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1G-0 — Mid-shift Treasury cash movements (PAY_IN / PAY_OUT / SAFE_DROP).
 *
 * Authority: docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md
 * (CONTROLLING), corrected by the 2026-08-28 implementation-correction prompt.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_OWNER = '1357';
const PIN_OTHER_EMPLOYEE = '2468';
const PIN_PAYIN_ONLY = '3579';
const PIN_NO_PERM = '4680';
const PIN_WRONG_BRANCH = '5791';
const PIN_TENANT_B = '6802';

describe('Cash movements (e2e) — P1G-0', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let appPrisma: PrismaService;
  let drawers: DrawersService;
  let cashSessions: CashSessionsService;
  let movementsService: CashMovementsService;
  let gatedAudit: GatedAuditService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let branchA2: string;
  let branchB: string;
  let terminalA: string;
  let terminalA2: string;
  let terminalB: string;
  let drawerA: string;
  let drawerB: string;

  let ownerToken: string;
  let otherEmployeeToken: string;
  let payInOnlyToken: string;
  let noPermToken: string;
  let wrongBranchToken: string;
  let tenantBToken: string;

  let sessionA: string; // open, owned by the PIN_OWNER employee, branch A
  let sessionB: string; // open, tenant B
  let closedSession: string; // status='closed', branch A
  let ownerUserIdForFixtures: string;
  let payInOnlyEmployeeId: string;

  /** Gate on `AuditService.record` — the LAST statement in
   *  `CashMovementsService.record`'s successful-create path, still inside
   *  the same transaction that holds the `cash_sessions` advisory lock
   *  (`pg_advisory_xact_lock`). Pausing here holds that lock open for a
   *  genuine cross-connection race, mirroring the P1F-2 acceptance-closure
   *  `RECIPE_COST_RECOMPUTER` gate. */
  class GatedAuditService extends AuditService {
    private armed = false;
    private acquiredResolve: (() => void) | null = null;
    private gate: Promise<void> | null = null;
    private releaseGateFn: (() => void) | null = null;

    arm(): Promise<void> {
      this.armed = true;
      const acquired = new Promise<void>((res) => {
        this.acquiredResolve = res;
      });
      this.gate = new Promise<void>((res) => {
        this.releaseGateFn = res;
      });
      return acquired;
    }
    release(): void {
      this.releaseGateFn?.();
    }
    override async record(
      tx: Prisma.TransactionClient,
      event: Parameters<AuditService['record']>[1],
    ) {
      if (this.armed) {
        this.armed = false;
        this.acquiredResolve?.();
        await this.gate;
      }
      return super.record(tx, event);
    }
  }

  /** Poll until a real, distinct backend is genuinely BLOCKED waiting on the
   *  `cash_sessions` advisory lock — via
   *  `pg_stat_activity.wait_event_type='Lock'` on a backend whose own query
   *  names `pg_advisory_xact_lock`. Never a fixed sleep used as the proof
   *  itself, only as poll cadence. */
  async function waitForRealLockContention(
    client: PrismaClient,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await client.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%pg_advisory_xact_lock%'
      `;
      if (Number(rows[0].c) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          'Timed out waiting for genuine Postgres advisory-lock contention on the cash session.',
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  const mkBranch = async (tenantId: string, code: string) => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `CMBrand ${code}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code,
        name: `CMBranch ${code}`,
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
    })
      .overrideProvider(AuditService)
      .useFactory({
        factory: (prisma: PrismaService) => {
          gatedAudit = new GatedAuditService(prisma);
          return gatedAudit;
        },
        inject: [PrismaService],
      })
      .compile();
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
    appPrisma = app.get(PrismaService);
    movementsService = app.get(CashMovementsService);
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
    tenantA = await mkTenant(`cma-${stamp}`);
    tenantB = await mkTenant(`cmb-${stamp}`);

    branchA = await mkBranch(tenantA, `MA${stamp % 10000}`);
    branchA2 = await mkBranch(tenantA, `MX${stamp % 10000}`);
    branchB = await mkBranch(tenantB, `MB${stamp % 10000}`);
    terminalA = await mkTerminal(tenantA, branchA, 'CM-POS-1');
    terminalA2 = await mkTerminal(tenantA, branchA2, 'CM-POS-2');
    terminalB = await mkTerminal(tenantB, branchB, 'CM-POS-B');

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({ email, password, displayName: 'CM' });
      await memberships.grant(u.id, tenantId, 'active');
      return u.id;
    };
    const userOwner = await mkUser(`cm.owner.${stamp}@example.com`, tenantA);
    ownerUserIdForFixtures = userOwner;
    const userOther = await mkUser(`cm.other.${stamp}@example.com`, tenantA);
    const userPayInOnly = await mkUser(
      `cm.payin.${stamp}@example.com`,
      tenantA,
    );
    const userNoPerm = await mkUser(`cm.noperm.${stamp}@example.com`, tenantA);
    const userWrongBranch = await mkUser(
      `cm.wrongbranch.${stamp}@example.com`,
      tenantA,
    );
    const userB = await mkUser(`cm.b.${stamp}@example.com`, tenantB);

    const codeOwner = `CMO${stamp % 1000}`;
    const codeOther = `CMT${stamp % 1000}`;
    const codePayInOnly = `CMP${stamp % 1000}`;
    const codeNoPerm = `CMN${stamp % 1000}`;
    const codeWrongBranch = `CMW${stamp % 1000}`;
    const codeB = `CMB${stamp % 1000}`;

    const employeeOwner = (
      await employees.create(tenantA, userOwner, {
        code: codeOwner,
        displayName: 'Owner',
        homeBranchId: branchA,
        userId: userOwner,
      })
    ).id;
    const employeeOther = (
      await employees.create(tenantA, userOwner, {
        code: codeOther,
        displayName: 'Other',
        homeBranchId: branchA,
        userId: userOther,
      })
    ).id;
    const employeePayInOnly = (
      await employees.create(tenantA, userOwner, {
        code: codePayInOnly,
        displayName: 'PayInOnly',
        homeBranchId: branchA,
        userId: userPayInOnly,
      })
    ).id;
    payInOnlyEmployeeId = employeePayInOnly;
    const employeeNoPerm = (
      await employees.create(tenantA, userOwner, {
        code: codeNoPerm,
        displayName: 'NoPerm',
        homeBranchId: branchA,
        userId: userNoPerm,
      })
    ).id;
    const employeeWrongBranch = (
      await employees.create(tenantA, userOwner, {
        code: codeWrongBranch,
        displayName: 'WrongBranch',
        homeBranchId: branchA2,
        userId: userWrongBranch,
      })
    ).id;
    const employeeB = (
      await employees.create(tenantB, userB, {
        code: codeB,
        displayName: 'TenantB',
        homeBranchId: branchB,
        userId: userB,
      })
    ).id;

    const permissions = app.get(PermissionsService);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const fullCash = await roles.createTenantRole(tenantA, {
      name: `cm_full_${stamp}`,
    });
    await roles.addPermissions(
      tenantA,
      fullCash.id,
      TREASURY_PERMISSION_DEFS.map((d) => d.code),
    );
    const payInOnlyRole = await roles.createTenantRole(tenantA, {
      name: `cm_payin_only_${stamp}`,
    });
    await roles.addPermissions(tenantA, payInOnlyRole.id, ['cash.payin']);
    const noPermRole = await roles.createTenantRole(tenantA, {
      name: `cm_noperm_${stamp}`,
    });
    const fullCashB = await roles.createTenantRole(tenantB, {
      name: `cm_full_b_${stamp}`,
    });
    await roles.addPermissions(
      tenantB,
      fullCashB.id,
      TREASURY_PERMISSION_DEFS.map((d) => d.code),
    );

    const assign = async (tenantId: string, userId: string, roleId: string) => {
      const m = await admin.membership.findFirstOrThrow({
        where: { userId, tenantId },
      });
      await membershipRoles.create(tenantId, null, {
      membershipId: m.id,
      roleId: roleId,
      scope: { type: 'tenant' },
    });
    };
    await assign(tenantA, userOwner, fullCash.id);
    await assign(tenantA, userOther, fullCash.id);
    await assign(tenantA, userPayInOnly, payInOnlyRole.id);
    await assign(tenantA, userNoPerm, noPermRole.id);
    await assign(tenantA, userWrongBranch, fullCash.id);
    await assign(tenantB, userB, fullCashB.id);

    const pins = app.get(PinService);
    await pins.setPin(tenantA, userOwner, employeeOwner, PIN_OWNER);
    await pins.setPin(tenantA, userOther, employeeOther, PIN_OTHER_EMPLOYEE);
    await pins.setPin(
      tenantA,
      userPayInOnly,
      employeePayInOnly,
      PIN_PAYIN_ONLY,
    );
    await pins.setPin(tenantA, userNoPerm, employeeNoPerm, PIN_NO_PERM);
    await pins.setPin(
      tenantA,
      userWrongBranch,
      employeeWrongBranch,
      PIN_WRONG_BRANCH,
    );
    await pins.setPin(tenantB, userB, employeeB, PIN_TENANT_B);

    ownerToken = await pinLogin(tenantA, terminalA, codeOwner, PIN_OWNER);
    otherEmployeeToken = await pinLogin(
      tenantA,
      terminalA,
      codeOther,
      PIN_OTHER_EMPLOYEE,
    );
    payInOnlyToken = await pinLogin(
      tenantA,
      terminalA,
      codePayInOnly,
      PIN_PAYIN_ONLY,
    );
    noPermToken = await pinLogin(tenantA, terminalA, codeNoPerm, PIN_NO_PERM);
    wrongBranchToken = await pinLogin(
      tenantA,
      terminalA2,
      codeWrongBranch,
      PIN_WRONG_BRANCH,
    );
    tenantBToken = await pinLogin(tenantB, terminalB, codeB, PIN_TENANT_B);

    drawerA = (
      await drawers.create(tenantA, userOwner, {
        branchId: branchA,
        name: 'CM Till A',
      })
    ).id;
    drawerB = (
      await drawers.create(tenantB, userB, {
        branchId: branchB,
        name: 'CM Till B',
      })
    ).id;

    const openedA = await cashSessions.open(tenantA, userOwner, {
      shiftId: newId(),
      cashSessionId: newId(),
      drawerId: drawerA,
      openingFloat: '50000',
      terminalId: terminalA,
      employeeId: employeeOwner,
    });
    sessionA = openedA.session.id;

    const openedB = await cashSessions.open(tenantB, userB, {
      shiftId: newId(),
      cashSessionId: newId(),
      drawerId: drawerB,
      openingFloat: '20000',
      terminalId: terminalB,
      employeeId: employeeB,
    });
    sessionB = openedB.session.id;

    // A CLOSED session fixture — no close route exists yet (P1G-1), so this
    // is constructed directly via the migrator (a legitimate positive
    // control, matching the pattern other suites use for "already closed").
    const closedDrawer = (
      await drawers.create(tenantA, userOwner, {
        branchId: branchA,
        name: 'CM Closed Till',
      })
    ).id;
    const closedShift = await cashSessions.open(tenantA, userOwner, {
      shiftId: newId(),
      cashSessionId: newId(),
      drawerId: closedDrawer,
      openingFloat: '10000',
      terminalId: terminalA,
      employeeId: employeeOwner,
    });
    closedSession = closedShift.session.id;
    await admin.cashSession.update({
      where: { id: closedSession },
      data: { status: 'closed', closedAt: new Date() },
    });
  }, 90_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  const body = (over: Record<string, unknown> = {}) => ({
    id: newId(),
    amountMinor: '5000',
    reason: 'test movement',
    ...over,
  });

  const post = (
    route: 'pay-in' | 'pay-out' | 'safe-drop',
    sessionId: string,
    reqBody: Record<string, unknown>,
    opts: { key?: string; token?: string } = {},
  ) =>
    request(http)
      .post(`/cash-sessions/${sessionId}/${route}`)
      .set('Authorization', `Bearer ${opts.token ?? ownerToken}`)
      .set('Idempotency-Key', opts.key ?? `cm-${newId()}`)
      .send(reqBody);

  // ==================================================================== A
  describe('FR-POS-091 — domain rules', () => {
    it('creates a pay-in movement', async () => {
      const res = await post('pay-in', sessionA, body({ amountMinor: '1234' }));
      expect(res.status).toBe(201);
      const out = res.body as {
        id: string;
        movementType: string;
        amountMinor: string;
      };
      expect(out.movementType).toBe('pay_in');
      expect(out.amountMinor).toBe('1234');
    });

    it('rejects a zero amount', async () => {
      const res = await post('pay-in', sessionA, body({ amountMinor: '0' }));
      expect(res.status).toBe(400);
    });

    it('rejects a negative amount (fails the digit-only pattern)', async () => {
      const res = await post('pay-in', sessionA, body({ amountMinor: '-500' }));
      expect(res.status).toBe(400);
    });

    it('rejects a blank reason', async () => {
      const res = await post('pay-in', sessionA, body({ reason: '   ' }));
      expect(res.status).toBe(400);
    });

    it('rejects a missing id (CORRECTION 1 — id is required, no server fallback)', async () => {
      const withoutId = body();
      delete (withoutId as { id?: string }).id;
      const res = await post('pay-in', sessionA, withoutId);
      expect(res.status).toBe(400);
    });

    it('rejects a malformed id', async () => {
      const res = await post('pay-in', sessionA, body({ id: 'not-a-uuid' }));
      expect(res.status).toBe(400);
    });

    it('preserves the client id exactly as the permanent PK — the server never reassigns it', async () => {
      const id = newId();
      const res = await post('pay-in', sessionA, body({ id }));
      expect(res.status).toBe(201);
      expect((res.body as { id: string }).id).toBe(id);
      const row = await admin.cashMovement.findUniqueOrThrow({ where: { id } });
      expect(row.id).toBe(id);
    });

    it('the record is immutable via the real ros_app connection', async () => {
      const res = await post('pay-in', sessionA, body());
      const id = (res.body as { id: string }).id;
      await expect(
        appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`UPDATE "treasury"."cash_movements" SET "amount" = 999 WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow();
      const still = await admin.cashMovement.findUniqueOrThrow({
        where: { id },
      });
      expect(still.amount).not.toBe(999n);
    });
  });

  // ==================================================================== B
  describe('exact sign semantics — the totals contract', () => {
    it('payIn - payOut - safeDrop matches the immutable ledger exactly', async () => {
      const totals = app.get(CashMovementTotalsQueryService);
      // A dedicated session so this test owns a clean slate.
      const drawer = await drawers.create(tenantA, ownerUserIdForFixtures, {
        branchId: branchA,
        name: `CM Totals Till ${newId()}`,
      });
      const opened = await cashSessions.open(tenantA, ownerUserIdForFixtures, {
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: drawer.id,
        openingFloat: '0',
        terminalId: terminalA,
        employeeId: (
          await admin.cashSession.findUniqueOrThrow({ where: { id: sessionA } })
        ).employeeId,
      });
      const sid = opened.session.id;

      const r1 = await post('pay-in', sid, body({ amountMinor: '10000' }));
      const r2 = await post('pay-in', sid, body({ amountMinor: '2500' }));
      const r3 = await post('pay-out', sid, body({ amountMinor: '3000' }));
      const r4 = await post('safe-drop', sid, body({ amountMinor: '4000' }));
      expect([r1, r2, r3, r4].map((r) => r.status)).toEqual([
        201, 201, 201, 201,
      ]);

      const result = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) => totals.totalsForSession(tx, tenantA, sid),
      );
      expect(result.payInTotal).toBe(12500n);
      expect(result.payOutTotal).toBe(3000n);
      expect(result.safeDropTotal).toBe(4000n);
      expect(result.netCashMovementEffect).toBe(12500n - 3000n - 4000n);
    });
  });

  // ==================================================================== C
  describe('AUTH', () => {
    it('each permission authorises only its own route', async () => {
      // A session OWNED by the pay-in-only employee — own-session-only
      // (design gate §4) must not be conflated with the permission check
      // this test targets.
      const drawer = await drawers.create(tenantA, ownerUserIdForFixtures, {
        branchId: branchA,
        name: `CM PayInOnly Till ${newId()}`,
      });
      const opened = await cashSessions.open(tenantA, ownerUserIdForFixtures, {
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: drawer.id,
        openingFloat: '0',
        terminalId: terminalA,
        employeeId: payInOnlyEmployeeId,
      });
      const sid = opened.session.id;

      const payInRes = await post('pay-in', sid, body(), {
        token: payInOnlyToken,
      });
      expect(payInRes.status).toBe(201);
      const payOutRes = await post('pay-out', sid, body(), {
        token: payInOnlyToken,
      });
      expect(payOutRes.status).toBe(403);
      const safeDropRes = await post('safe-drop', sid, body(), {
        token: payInOnlyToken,
      });
      expect(safeDropRes.status).toBe(403);
    });

    it('missing permission -> 403', async () => {
      const res = await post('pay-in', sessionA, body(), {
        token: noPermToken,
      });
      expect(res.status).toBe(403);
    });

    it('own-session only: a different employee cannot post to this session -> 403', async () => {
      const res = await post('pay-in', sessionA, body(), {
        token: otherEmployeeToken,
      });
      expect(res.status).toBe(403);
    });

    it('wrong branch -> 403', async () => {
      const res = await post('pay-in', sessionA, body(), {
        token: wrongBranchToken,
      });
      expect(res.status).toBe(403);
    });

    it('cross-tenant session -> 404 (RLS-invisible, never 403)', async () => {
      const res = await post('pay-in', sessionB, body(), { token: ownerToken });
      expect(res.status).toBe(404);
    });

    it('closed session -> 409', async () => {
      const res = await post('pay-in', closedSession, body(), {
        token: ownerToken,
      });
      expect(res.status).toBe(409);
    });
  });

  // ==================================================================== D
  describe('IDEMPOTENCY', () => {
    it('same Idempotency-Key + same body -> replay, exactly one row', async () => {
      const reqBody = body();
      const key = `cm-idem-${newId()}`;
      const first = await post('pay-in', sessionA, reqBody, { key });
      expect(first.status).toBe(201);
      const second = await post('pay-in', sessionA, reqBody, { key });
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replay']).toBe('true');
      const count = await admin.cashMovement.count({
        where: { id: reqBody.id },
      });
      expect(count).toBe(1);
    });

    it('same Idempotency-Key + different body -> 409', async () => {
      const key = `cm-idem-${newId()}`;
      const first = await post('pay-in', sessionA, body(), { key });
      expect(first.status).toBe(201);
      const second = await post('pay-in', sessionA, body(), { key });
      expect(second.status).toBe(409);
    });

    it('duplicate business id (different Idempotency-Key), identical facts -> replay, exactly one row AND one audit entry', async () => {
      const reqBody = body();
      const first = await post('pay-in', sessionA, reqBody, {
        key: `cm-a-${newId()}`,
      });
      expect(first.status).toBe(201);
      const second = await post('pay-in', sessionA, reqBody, {
        key: `cm-b-${newId()}`,
      });
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);

      const rows = await admin.cashMovement.count({
        where: { id: reqBody.id },
      });
      expect(rows).toBe(1);
      const auditCount = await admin.auditEntry.count({
        where: {
          tenantId: tenantA,
          action: 'CASH_MOVEMENT_RECORDED',
          entityId: reqBody.id,
        },
      });
      expect(auditCount).toBe(1);
    });

    it('duplicate business id, differing facts -> 409', async () => {
      const id = newId();
      const first = await post('pay-in', sessionA, body({ id }), {
        key: `cm-a-${newId()}`,
      });
      expect(first.status).toBe(201);
      const second = await post(
        'pay-in',
        sessionA,
        body({ id, amountMinor: '9999' }),
        {
          key: `cm-b-${newId()}`,
        },
      );
      expect(second.status).toBe(409);
    });
  });

  // ==================================================================== E
  describe('RLS', () => {
    it('own-tenant SELECT succeeds; cross-tenant SELECT returns zero rows (own real row exists)', async () => {
      const res = await post('pay-in', sessionA, body());
      const id = (res.body as { id: string }).id;
      // Positive control for tenant B: it has its own real row too.
      await post('pay-in', sessionB, body(), { token: tenantBToken });

      const ownCount = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) => tx.cashMovement.count({ where: { id } }),
      );
      expect(ownCount).toBe(1);
      const crossCount = await appPrisma.withAuthContext(
        { tenantId: tenantB },
        (tx) => tx.cashMovement.count({ where: { id } }),
      );
      expect(crossCount).toBe(0);
    });

    it('UPDATE rejected; the row survives unmodified', async () => {
      const res = await post('pay-in', sessionA, body());
      const id = (res.body as { id: string }).id;
      await expect(
        appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`UPDATE "treasury"."cash_movements" SET "reason" = 'tampered' WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow();
      const still = await admin.cashMovement.findUniqueOrThrow({
        where: { id },
      });
      expect(still.reason).not.toBe('tampered');
    });

    it('DELETE rejected; the row survives', async () => {
      const res = await post('pay-in', sessionA, body());
      const id = (res.body as { id: string }).id;
      await expect(
        appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`DELETE FROM "treasury"."cash_movements" WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow();
      expect(
        await admin.cashMovement.findUnique({ where: { id } }),
      ).not.toBeNull();
    });

    it('information_schema.role_table_grants: ros_app has SELECT+INSERT and NOT UPDATE/DELETE/TRUNCATE', async () => {
      const grants = await admin.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'ros_app' AND table_schema = 'treasury' AND table_name = 'cash_movements'
      `;
      const privileges = new Set(grants.map((g) => g.privilege_type));
      expect(privileges.has('SELECT')).toBe(true);
      expect(privileges.has('INSERT')).toBe(true);
      expect(privileges.has('UPDATE')).toBe(false);
      expect(privileges.has('DELETE')).toBe(false);
      expect(privileges.has('TRUNCATE')).toBe(false);
    });
  });

  // ==================================================================== F
  describe('CONCURRENCY (real Postgres, real barriers, no sleeps as proof)', () => {
    // Direct SERVICE-layer calls, not HTTP. The guard/permission/idempotency
    // HTTP layers are already covered by the AUTH and IDEMPOTENCY groups
    // above; the concurrency proof targets the SERVICE's own advisory-lock
    // discipline and the real Postgres contention it produces, which is
    // identical whether entered via HTTP or directly. (Diagnosed mid-session:
    // firing two concurrent `supertest` requests against one in-process Nest
    // HTTP server while the first request's own transaction is held open by
    // the gate caused the second request to never reach the controller at
    // all — a `supertest`/single-server dispatch artifact, not a production
    // deadlock; confirmed via `pg_stat_activity` showing only ONE `ros_app`
    // backend during the stall. Direct calls sidestep that HTTP layer while
    // still proving the real Postgres advisory-lock contention.)
    const mkRaceSession = async (label: string) => {
      const drawer = await drawers.create(tenantA, ownerUserIdForFixtures, {
        branchId: branchA,
        name: `CM ${label} Till ${newId()}`,
      });
      const owner = await admin.cashSession.findUniqueOrThrow({
        where: { id: sessionA },
      });
      const opened = await cashSessions.open(tenantA, ownerUserIdForFixtures, {
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: drawer.id,
        openingFloat: '0',
        terminalId: terminalA,
        employeeId: owner.employeeId,
      });
      return { sid: opened.session.id, employeeId: owner.employeeId };
    };

    const directInput = (
      sid: string,
      employeeId: string,
      over: Partial<{ id: string; amountMinor: string; reason: string }> = {},
    ) => ({
      id: over.id ?? newId(),
      cashSessionId: sid,
      amountMinor: over.amountMinor ?? '1000',
      reason: over.reason ?? 'race test',
      employeeId,
      terminalId: terminalA,
    });

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: two simultaneous PAY_INs on the same session both succeed, totals sum exactly`, async () => {
        const { sid, employeeId } = await mkRaceSession(`Race-${run}`);

        const lockAcquired = gatedAudit.arm();
        const first = movementsService.payIn(
          tenantA,
          ownerUserIdForFixtures,
          directInput(sid, employeeId, { amountMinor: '1000' }),
        );
        await lockAcquired;

        const second = movementsService.payIn(
          tenantA,
          ownerUserIdForFixtures,
          directInput(sid, employeeId, { amountMinor: '2000' }),
        );
        await waitForRealLockContention(admin);
        gatedAudit.release();

        const [r1, r2] = await Promise.all([first, second]);
        expect(r1.created).toBe(true);
        expect(r2.created).toBe(true);

        const rows = await admin.cashMovement.findMany({
          where: { cashSessionId: sid },
        });
        expect(rows).toHaveLength(2);
        const sum = rows.reduce((s, m) => s + Number(m.amount), 0);
        expect(sum).toBe(3000);
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: PAY_IN vs PAY_OUT on the same session both succeed, net effect exact`, async () => {
        const { sid, employeeId } = await mkRaceSession(`RaceIO-${run}`);

        const lockAcquired = gatedAudit.arm();
        const payIn = movementsService.payIn(
          tenantA,
          ownerUserIdForFixtures,
          directInput(sid, employeeId, { amountMinor: '5000' }),
        );
        await lockAcquired;

        const payOut = movementsService.payOut(
          tenantA,
          ownerUserIdForFixtures,
          directInput(sid, employeeId, { amountMinor: '1500' }),
        );
        await waitForRealLockContention(admin);
        gatedAudit.release();

        const [rIn, rOut] = await Promise.all([payIn, payOut]);
        expect(rIn.created).toBe(true);
        expect(rOut.created).toBe(true);

        const totals = app.get(CashMovementTotalsQueryService);
        const result = await appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) => totals.totalsForSession(tx, tenantA, sid),
        );
        expect(result.netCashMovementEffect).toBe(5000n - 1500n);
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: two movements racing the same session both succeed under the shared advisory lock`, async () => {
        const { sid, employeeId } = await mkRaceSession(`RaceLock-${run}`);

        // Proves the serialization discipline P1G-1's future close MUST
        // also participate in (design gate §10): only ONE writer holds the
        // session's advisory lock at a time.
        const lockAcquired = gatedAudit.arm();
        const firstMovement = movementsService.payIn(
          tenantA,
          ownerUserIdForFixtures,
          directInput(sid, employeeId, { amountMinor: '1000' }),
        );
        await lockAcquired;

        const secondMovement = movementsService.payIn(
          tenantA,
          ownerUserIdForFixtures,
          directInput(sid, employeeId, { amountMinor: '2000' }),
        );
        await waitForRealLockContention(admin);
        gatedAudit.release();

        const [r1, r2] = await Promise.all([firstMovement, secondMovement]);
        expect(r1.created).toBe(true);
        expect(r2.created).toBe(true);
        const rows = await admin.cashMovement.count({
          where: { cashSessionId: sid },
        });
        expect(rows).toBe(2);
      }, 20_000);
    }

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: duplicate business id raced -> exactly one row`, async () => {
        const { sid, employeeId } = await mkRaceSession(`RaceDup-${run}`);
        const id = newId();
        const input = directInput(sid, employeeId, { id });
        const [r1, r2] = await Promise.all([
          movementsService.payIn(tenantA, ownerUserIdForFixtures, input),
          movementsService.payIn(tenantA, ownerUserIdForFixtures, input),
        ]);
        // Exactly one of the two racing calls created the row; the other
        // replayed it — never both `created`, never neither.
        expect([r1.created, r2.created].filter(Boolean)).toHaveLength(1);
        expect(r1.movement.id).toBe(r2.movement.id);
        const rows = await admin.cashMovement.count({ where: { id } });
        expect(rows).toBe(1);
      });
    }
  });
});
