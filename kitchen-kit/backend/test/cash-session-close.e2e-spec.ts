import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import {
  TransactionalDomainEventDispatcher,
  TransactionalDomainEventHandler,
} from './../src/common/domain-events/domain-event-dispatcher';
import { UnitOfWork } from './../src/common/domain-events/unit-of-work';
import type { DomainEventEnvelope } from './../src/common/domain-events/domain-event.types';
import type { CashVarianceDetectedPayload } from './../src/modules/treasury/contract';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import { CashClosePolicyService } from './../src/modules/treasury/cash-close-policy/cash-close-policy.service';
import { CashSessionsService } from './../src/modules/treasury/cash-sessions/cash-sessions.service';
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
import { TREASURY_PERMISSION_DEFS } from './../src/modules/treasury/treasury.permissions';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1G-1 migration 34 — CashSession Close (FR-POS-094/095/096/097,
 * FR-FIN-004/005/006/007, FR-SEC-016/030/032/033, R-6(a)).
 *
 * Authority (CONTROLLING, in order): the four accepted P1G-1 CashSession
 * Close design/closure reports + the R-6(a) ratification register entry.
 * This file proves the business logic and the DB-level invariants. The
 * cross-module CONCURRENCY proofs (Payment/Movement vs a real declared
 * close) live in `cash-movements-close-and-payment-concurrency.e2e-spec.ts`
 * §D/E/F, which already owns the heavy order/payment fixture machinery.
 *
 * Fixture policy: `branchA` (blind, tolerance 1000 minor units), `branchOpen`
 * (open-count mode, same tolerance) — both configured "effective
 * immediately", so every fixture session's `openedAt` (`new Date()`, taken
 * AFTER policy creation) resolves it (R-3(a)).
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const PIN_CASHIER = '1111';
const PIN_OTHER = '2222';
const PIN_MANAGER = '3333';
const PIN_NOCLOSE = '4444';
const PIN_OPENMODE = '5555';
const TOLERANCE = 1_000n;

interface DeclareBody {
  cashSessionId: string;
  closeAttemptId: string;
  status: 'closing' | 'closed';
  approvalRequired: boolean;
  currency: string;
  countMode: 'blind' | 'open';
  toleranceMinorUnits: string;
  expectedCashMinorUnits: string;
  countedCashMinorUnits: string;
  varianceMinorUnits: string;
  created: boolean;
}
interface FinalizeBody {
  cashSessionId: string;
  status: 'closing' | 'closed';
  outcome: 'closed' | 'rejected';
}
interface ContextBody {
  cashSessionId: string;
  status: 'open' | 'closing' | 'closed';
  countMode: 'blind' | 'open';
  toleranceMinorUnits?: string;
  expectedCashMinorUnits?: string;
  countedCashMinorUnits?: string;
  varianceMinorUnits?: string;
  approvalRequired?: boolean;
}

describe('CashSession Close (e2e) — P1G-1 migration 34', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let prisma: PrismaService;
  let cashSessions: CashSessionsService;
  let drawers: DrawersService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let branchOpen: string;
  let terminalA: string;
  let terminalOpen: string;

  let userCashier: string;
  let employeeCashier: string;
  let userOther: string;
  let employeeOther: string;
  let userManager: string;
  let employeeManager: string;
  let userNoClose: string;
  let employeeNoClose: string;
  let employeeUnlinked: string; // no userId
  let userOpenMode: string;
  let employeeOpenMode: string;

  let cashierToken: string;
  let otherToken: string;
  let noCloseToken: string;
  let openModeToken: string;

  // Tenant B — cross-tenant proofs.
  let branchB: string;
  let terminalB: string;
  let userB: string;
  let employeeB: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // ── SRS §5.5.4 `cash.variance.detected` capture (acceptance closure) ──────
  // No production handler is registered for this event yet (mirrors
  // `order.line.fired`'s own pre-Fire state) — a test-only handler is
  // registered via the SAME manual `.withHandlers(...)` technique
  // `domain-events.e2e-spec.ts` already establishes as this repository's
  // proof pattern, by overriding the (otherwise DI-global) `UnitOfWork`
  // provider for this file only. `CashSessionCloseService` still goes
  // through the ONE trusted `ctx.publishEvent(...)` surface — nothing here
  // bypasses it.
  const capturedVarianceEvents: DomainEventEnvelope<
    'cash.variance.detected',
    CashVarianceDetectedPayload
  >[] = [];
  let throwOnNextVarianceEvent = false;
  const varianceCaptureHandler: TransactionalDomainEventHandler = {
    eventType: 'cash.variance.detected',
    handle: async (event) => {
      capturedVarianceEvents.push(
        event as DomainEventEnvelope<
          'cash.variance.detected',
          CashVarianceDetectedPayload
        >,
      );
      if (throwOnNextVarianceEvent) {
        throwOnNextVarianceEvent = false;
        throw new Error('test-injected subscriber failure (§5.5.2 rollback proof)');
      }
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(UnitOfWork)
      .useFactory({
        factory: (prismaService: PrismaService) =>
          new UnitOfWork(
            prismaService,
            TransactionalDomainEventDispatcher.withHandlers([
              varianceCaptureHandler,
            ]),
          ),
        inject: [PrismaService],
      })
      .compile();
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
    prisma = app.get(PrismaService);
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

    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantA = await mkTenant(`csc-a-${stamp}`);
    tenantB = await mkTenant(`csc-b-${stamp}`);

    const mkBranch = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `CSC Brand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `CSC Branch ${code}`,
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

    branchA = await mkBranch(tenantA, `CSCA${stamp % 10000}`);
    branchOpen = await mkBranch(tenantA, `CSCO${stamp % 10000}`);
    branchB = await mkBranch(tenantB, `CSCB${stamp % 10000}`);
    terminalA = await mkTerminal(tenantA, branchA, 'CSC-POS-A');
    terminalOpen = await mkTerminal(tenantA, branchOpen, 'CSC-POS-OPEN');
    terminalB = await mkTerminal(tenantB, branchB, 'CSC-POS-B');

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({ email, password, displayName: 'CSC' });
      await memberships.grant(u.id, tenantId, 'active');
      return u.id;
    };
    userCashier = await mkUser(`csc.cashier.${stamp}@example.com`, tenantA);
    userOther = await mkUser(`csc.other.${stamp}@example.com`, tenantA);
    userManager = await mkUser(`csc.manager.${stamp}@example.com`, tenantA);
    userNoClose = await mkUser(`csc.noclose.${stamp}@example.com`, tenantA);
    userOpenMode = await mkUser(`csc.openmode.${stamp}@example.com`, tenantA);
    userB = await mkUser(`csc.b.${stamp}@example.com`, tenantB);

    const codeCashier = `CCA${stamp % 1000}`;
    const codeOther = `CCB${stamp % 1000}`;
    const codeManager = `CCM${stamp % 1000}`;
    const codeNoClose = `CCN${stamp % 1000}`;
    const codeUnlinked = `CCU${stamp % 1000}`;
    const codeOpenMode = `CCO${stamp % 1000}`;
    const codeB = `CCX${stamp % 1000}`;

    employeeCashier = (
      await employees.create(tenantA, userCashier, {
        code: codeCashier,
        displayName: 'Cashier',
        homeBranchId: branchA,
        userId: userCashier,
      })
    ).id;
    employeeOther = (
      await employees.create(tenantA, userCashier, {
        code: codeOther,
        displayName: 'Other Closer',
        homeBranchId: branchA,
        userId: userOther,
      })
    ).id;
    employeeManager = (
      await employees.create(tenantA, userCashier, {
        code: codeManager,
        displayName: 'Manager',
        homeBranchId: branchA,
        userId: userManager,
      })
    ).id;
    employeeNoClose = (
      await employees.create(tenantA, userCashier, {
        code: codeNoClose,
        displayName: 'No Close Permission',
        homeBranchId: branchA,
        userId: userNoClose,
      })
    ).id;
    // Deliberately NO userId — FR-SEC-016 fail-closed fixture (item 9).
    employeeUnlinked = (
      await employees.create(tenantA, userCashier, {
        code: codeUnlinked,
        displayName: 'Unlinked Owner',
        homeBranchId: branchA,
      })
    ).id;
    employeeOpenMode = (
      await employees.create(tenantA, userCashier, {
        code: codeOpenMode,
        displayName: 'Open Mode Cashier',
        homeBranchId: branchOpen,
        userId: userOpenMode,
      })
    ).id;
    employeeB = (
      await employees.create(tenantB, userB, {
        code: codeB,
        displayName: 'Tenant B',
        homeBranchId: branchB,
        userId: userB,
      })
    ).id;

    await pins.setPin(tenantA, userCashier, employeeCashier, PIN_CASHIER);
    await pins.setPin(tenantA, userCashier, employeeOther, PIN_OTHER);
    await pins.setPin(tenantA, userCashier, employeeManager, PIN_MANAGER);
    await pins.setPin(tenantA, userCashier, employeeNoClose, PIN_NOCLOSE);
    await pins.setPin(tenantA, userCashier, employeeOpenMode, PIN_OPENMODE);

    // ── Roles ──────────────────────────────────────────────────────────
    const cashierRole = await roles.createTenantRole(tenantA, {
      name: `csc_cashier_${stamp}`,
    });
    await roles.addPermissions(tenantA, cashierRole.id, [
      'cash.session.open',
      'cash.session.close',
    ]);
    const otherRole = await roles.createTenantRole(tenantA, {
      name: `csc_other_${stamp}`,
    });
    await roles.addPermissions(tenantA, otherRole.id, [
      'cash.session.open',
      'cash.session.close_other',
    ]);
    const managerRole = await roles.createTenantRole(tenantA, {
      name: `csc_manager_${stamp}`,
    });
    await roles.addPermissions(tenantA, managerRole.id, ['cash.variance.approve']);
    const noCloseRole = await roles.createTenantRole(tenantA, {
      name: `csc_noclose_${stamp}`,
    });
    await roles.addPermissions(tenantA, noCloseRole.id, ['cash.session.open']);
    const openModeRole = await roles.createTenantRole(tenantA, {
      name: `csc_openmode_${stamp}`,
    });
    await roles.addPermissions(tenantA, openModeRole.id, [
      'cash.session.open',
      'cash.session.close',
    ]);
    const dashboardRole = await roles.createTenantRole(tenantA, {
      name: `csc_dashboard_${stamp}`,
    });
    await roles.addPermissions(tenantA, dashboardRole.id, [
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    ]);

    const assign = async (userId: string, roleId: string) => {
      const m = await admin.membership.findFirstOrThrow({
        where: { userId, tenantId: tenantA },
      });
      await membershipRoles.create(tenantA, null, {
        membershipId: m.id,
        roleId: roleId,
        scope: { type: 'tenant' },
      });
    };
    await assign(userCashier, cashierRole.id);
    await assign(userOther, otherRole.id);
    await assign(userManager, managerRole.id);
    await assign(userNoClose, noCloseRole.id);
    await assign(userOpenMode, openModeRole.id);
    await assign(userCashier, dashboardRole.id); // reused as the dashboard actor

    const pinLogin = async (
      terminalId: string,
      employeeCode: string,
      pin: string,
    ) => {
      const res = await request(http)
        .post('/auth/pin')
        .send({ tenantId: tenantA, terminalId, employeeCode, pin })
        .expect(200);
      return (res.body as { accessToken: string }).accessToken;
    };
    cashierToken = await pinLogin(terminalA, codeCashier, PIN_CASHIER);
    otherToken = await pinLogin(terminalA, codeOther, PIN_OTHER);
    noCloseToken = await pinLogin(terminalA, codeNoClose, PIN_NOCLOSE);
    openModeToken = await pinLogin(terminalOpen, codeOpenMode, PIN_OPENMODE);

    // Manager PIN is verified INSIDE the finalize route via
    // `TERMINAL_PIN_VERIFIER` — `employeeManager`/`PIN_MANAGER` are used
    // directly in `finalizeBody`, no login token needed for the manager.

    // ── Cash-close policies — "effective immediately", small tolerance. ──
    await policies.create(tenantA, userCashier, {
      branchId: branchA,
      varianceToleranceMinorUnits: TOLERANCE.toString(),
      varianceApprovalExpirySeconds: 300,
    });
    await policies.create(tenantA, userCashier, {
      branchId: branchOpen,
      varianceToleranceMinorUnits: TOLERANCE.toString(),
      varianceApprovalExpirySeconds: 300,
      countMode: 'open',
    });
  }, 90_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  let drawerSeq = 0;
  const openSession = async (
    employeeId: string,
    terminalId: string,
    actorUserId = userCashier,
    openingFloat = '50000',
  ): Promise<string> => {
    drawerSeq += 1;
    const drawer = await drawers.create(tenantA, actorUserId, {
      branchId: terminalId === terminalOpen ? branchOpen : branchA,
      name: `CSC Till ${drawerSeq}`,
    });
    const { session } = await cashSessions.open(tenantA, actorUserId, {
      shiftId: newId(),
      cashSessionId: newId(),
      drawerId: drawer.id,
      openingFloat,
      terminalId,
      employeeId,
    });
    return session.id;
  };

  const declare = (
    token: string,
    sessionId: string,
    body: Record<string, unknown>,
    idemKey = `csc-declare-${newId()}`,
  ) =>
    request(http)
      .post(`/cash-sessions/${sessionId}/close`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey)
      .send(body);

  const finalize = (
    token: string,
    sessionId: string,
    body: Record<string, unknown>,
    idemKey = `csc-finalize-${newId()}`,
  ) =>
    request(http)
      .post(`/cash-sessions/${sessionId}/close/finalize`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey)
      .send(body);

  const context = (token: string, sessionId: string) =>
    request(http)
      .get(`/cash-sessions/${sessionId}/close-context`)
      .set(auth(token));

  const finalizeBody = (
    over: Partial<{
      approvalRequestId: string;
      approvalDecisionId: string;
      decision: 'approved' | 'rejected';
      reason: string;
      managerEmployeeCode: string;
      managerPin: string;
      comment: string;
    }> = {},
  ) => ({
    approvalRequestId: newId(),
    approvalDecisionId: newId(),
    decision: 'approved' as const,
    reason: 'Manager verified the drawer recount.',
    managerEmployeeCode: `CCM${stamp % 1000}`,
    managerPin: PIN_MANAGER,
    ...over,
  });

  // =========================================================== HAPPY PATH

  describe('within tolerance — one-request close', () => {
    it('exact match: variance 0, closes immediately, full disclosure, audit entry', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      });
      expect(res.status).toBe(201);
      const body = res.body as DeclareBody;
      expect(body.status).toBe('closed');
      expect(body.approvalRequired).toBe(false);
      expect(body.expectedCashMinorUnits).toBe('50000');
      expect(body.countedCashMinorUnits).toBe('50000');
      expect(body.varianceMinorUnits).toBe('0');
      expect(body.currency).toBe('EGP');
      expect(body.countMode).toBe('blind');

      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('closed');
      expect(session.closeAttemptId).toBe(body.closeAttemptId);
      expect(session.expectedCash).toBe(50_000n);
      expect(session.countedCash).toBe(50_000n);
      expect(session.variance).toBe(0n);
      expect(session.closedByUserId).toBe(userCashier);
      expect(session.closedByEmployeeId).toBe(employeeCashier);
      expect(session.closedAt).not.toBeNull();

      const audit = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: sid,
          action: 'CASH_SESSION_CLOSED',
        },
      });
      expect(audit).not.toBeNull();
      expect(audit!.approverId).toBeNull();
      expect(audit!.approvalId).toBeNull();
    });

    it('boundary: variance exactly == tolerance is WITHIN (not approval-required)', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: (50_000n + TOLERANCE).toString(),
      });
      expect(res.status).toBe(201);
      const body = res.body as DeclareBody;
      expect(body.status).toBe('closed');
      expect(body.approvalRequired).toBe(false);
      expect(body.varianceMinorUnits).toBe(TOLERANCE.toString());
    });

    it('boundary: variance tolerance+1 REQUIRES approval', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: (50_000n + TOLERANCE + 1n).toString(),
      });
      expect(res.status).toBe(201);
      const body = res.body as DeclareBody;
      expect(body.status).toBe('closing');
      expect(body.approvalRequired).toBe(true);

      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('closing');
      // Core facts are NOT copied onto cash_sessions until finalize commits.
      expect(session.expectedCash).toBeNull();
      expect(session.countedCash).toBeNull();
      expect(session.variance).toBeNull();
    });

    it('denominations only (no explicit total) sum to the counted total', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        denominations: [
          { denominationMinorUnits: '10000', quantity: 5 },
        ],
      });
      expect(res.status).toBe(201);
      expect((res.body as DeclareBody).countedCashMinorUnits).toBe('50000');
    });

    it('total + matching denominations succeed; mismatched sum -> 400; duplicate denomination -> 400', async () => {
      const sidOk = await openSession(employeeCashier, terminalA);
      const ok = await declare(cashierToken, sidOk, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
        denominations: [{ denominationMinorUnits: '10000', quantity: 5 }],
      });
      expect(ok.status).toBe(201);

      const sidMismatch = await openSession(employeeCashier, terminalA);
      const mismatch = await declare(cashierToken, sidMismatch, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
        denominations: [{ denominationMinorUnits: '10000', quantity: 4 }],
      });
      expect(mismatch.status).toBe(400);

      const sidDup = await openSession(employeeCashier, terminalA);
      const dup = await declare(cashierToken, sidDup, {
        closeAttemptId: newId(),
        denominations: [
          { denominationMinorUnits: '10000', quantity: 2 },
          { denominationMinorUnits: '10000', quantity: 3 },
        ],
      });
      expect(dup.status).toBe(400);
    });

    it('neither countedTotalMinorUnits nor denominations -> 400', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, { closeAttemptId: newId() });
      expect(res.status).toBe(400);
    });

    it('no manager-PIN/decision/reason path exists in the declare schema — extraneous fields -> 400', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
        managerPin: PIN_MANAGER,
        decision: 'approved',
        reason: 'should not be accepted here',
      });
      expect(res.status).toBe(400);
    });
  });

  // ==================================================== ABOVE TOLERANCE

  describe('above tolerance — freeze, disclose once committed, then finalize', () => {
    it('freezes to closing; finalize approved closes the session with core facts from the attempt', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const declared = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '55000',
      });
      expect(declared.status).toBe(201);
      const dBody = declared.body as DeclareBody;
      expect(dBody.status).toBe('closing');
      expect(dBody.varianceMinorUnits).toBe('5000');

      const fBody0 = finalizeBody({ reason: 'Verified drawer recount: +50 EGP.' });
      const finalized = await finalize(cashierToken, sid, fBody0);
      expect(finalized.status).toBe(200);
      const fBody = finalized.body as FinalizeBody;
      expect(fBody.outcome).toBe('closed');
      expect(fBody.status).toBe('closed');

      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('closed');
      expect(session.expectedCash).toBe(50_000n);
      expect(session.countedCash).toBe(55_000n);
      expect(session.variance).toBe(5_000n);
      expect(session.varianceReason).toBe('Verified drawer recount: +50 EGP.');
      expect(session.approvalRequestId).toBe(fBody0.approvalRequestId);

      const request_ = await admin.approvalRequest.findUniqueOrThrow({
        where: { id: fBody0.approvalRequestId },
      });
      expect(request_.status).toBe('approved');
      expect(request_.requiredPermission).toBe('cash.variance.approve');
      expect(request_.excludedApproverUserId).toBe(userCashier);
      const decision = await admin.approvalDecision.findUniqueOrThrow({
        where: { id: fBody0.approvalDecisionId },
      });
      expect(decision.approverId).toBe(userManager);
      expect(decision.decision).toBe('approved');

      const audit = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: sid,
          action: 'CASH_SESSION_CLOSED',
        },
      });
      expect(audit!.approverId).toBe(userManager);
      expect(audit!.approvalId).toBe(fBody0.approvalRequestId);
    });

    it('R-6(a): an explicit REJECTION commits (200, outcome rejected), session stays closing, then a retry with fresh ids approves', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '55000',
      }).expect(201);

      const rejectBody = finalizeBody({
        decision: 'rejected',
        reason: 'Recount looks wrong, please redo it.',
      });
      const rejected = await finalize(cashierToken, sid, rejectBody);
      expect(rejected.status).toBe(200);
      expect((rejected.body as FinalizeBody).outcome).toBe('rejected');
      expect((rejected.body as FinalizeBody).status).toBe('closing');

      const sessionAfterReject = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(sessionAfterReject.status).toBe('closing');
      expect(sessionAfterReject.closedAt).toBeNull();

      const decision = await admin.approvalDecision.findUniqueOrThrow({
        where: { id: rejectBody.approvalDecisionId },
      });
      expect(decision.decision).toBe('rejected');

      // Retry: FRESH ids, approved this time.
      const retryBody = finalizeBody({ reason: 'Recount redone, verified.' });
      const approved = await finalize(cashierToken, sid, retryBody);
      expect(approved.status).toBe(200);
      expect((approved.body as FinalizeBody).outcome).toBe('closed');

      const sessionFinal = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(sessionFinal.status).toBe('closed');
      expect(sessionFinal.approvalRequestId).toBe(retryBody.approvalRequestId);
    });

    it('self-approval is blocked: the session owner cannot approve their own variance', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '55000',
      }).expect(201);

      const res = await finalize(
        cashierToken,
        sid,
        finalizeBody({
          managerEmployeeCode: `CCA${stamp % 1000}`, // the OWNER's own code
          managerPin: PIN_CASHIER,
        }),
      );
      expect(res.status).toBe(403);

      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('closing'); // unchanged
    });

    it("owner's Employee has no linked Identity User -> finalize fails closed (FR-SEC-016)", async () => {
      const sid = await openSession(employeeUnlinked, terminalA, userCashier);
      await declare(otherToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '55000',
      }).expect(201);

      const res = await finalize(otherToken, sid, finalizeBody());
      expect(res.status).toBe(409);

      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('closing');
    });
  });

  // ============================================================ DISCLOSURE

  describe('blind vs open-mode disclosure (FR-POS-095)', () => {
    it('open + blind: expectedCash/formula-breakdown are ABSENT (not null); toleranceMinorUnits (a POLICY fact, not a variance fact) IS present', async () => {
      // Acceptance closure correction: the accepted design table (final
      // design gate §11) lists `toleranceMinorUnits` as present in BOTH
      // blind and open mode — only `expectedCash` and the formula
      // breakdown are blind-mode-omitted (FR-POS-095 protects the COUNT,
      // not the configured threshold).
      const sid = await openSession(employeeCashier, terminalA);
      const res = await context(cashierToken, sid);
      expect(res.status).toBe(200);
      const body = res.body as ContextBody;
      expect(body.status).toBe('open');
      expect(body.countMode).toBe('blind');
      expect(body.toleranceMinorUnits).toBe(TOLERANCE.toString());
      expect('expectedCashMinorUnits' in body).toBe(false);
    });

    it('open + open-mode: expected-cash/tolerance PREVIEW fields are present', async () => {
      const sid = await openSession(employeeOpenMode, terminalOpen, userOpenMode);
      const res = await context(openModeToken, sid);
      expect(res.status).toBe(200);
      const body = res.body as ContextBody;
      expect(body.status).toBe('open');
      expect(body.countMode).toBe('open');
      expect(body.toleranceMinorUnits).toBe(TOLERANCE.toString());
      expect(body.expectedCashMinorUnits).toBe('50000');
    });

    it('closing/closed: full figures are visible (already legitimately disclosed at declare time)', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      }).expect(201);
      const res = await context(cashierToken, sid);
      expect(res.status).toBe(200);
      const body = res.body as ContextBody;
      expect(body.status).toBe('closed');
      expect(body.expectedCashMinorUnits).toBe('50000');
      expect(body.countedCashMinorUnits).toBe('50000');
      expect(body.varianceMinorUnits).toBe('0');
      expect(body.approvalRequired).toBe(false);
    });
  });

  // ========================================================= PERMISSIONS

  describe('own/other authority (§15.2 cash.session.close vs .close_other)', () => {
    it('owner with cash.session.close closes their own session', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      }).expect(201);
    });

    it("a non-owner holding NEITHER close code cannot close another employee's session -> 403", async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(noCloseToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      });
      expect(res.status).toBe(403);

      const session = await admin.cashSession.findUniqueOrThrow({
        where: { id: sid },
      });
      expect(session.status).toBe('open'); // unchanged
    });

    it("a non-owner WITH close_other closes another employee's session", async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(otherToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      });
      expect(res.status).toBe(201);
    });
  });

  // ========================================================== REPLAY/IDEMP

  describe('replay and idempotency (FR-OFF-015, FR-API-020..023)', () => {
    it('HTTP Idempotency-Key replay on POST /close returns the identical stored response', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const key = `csc-replay-${newId()}`;
      const body = { closeAttemptId: newId(), countedTotalMinorUnits: '50000' };
      const first = await declare(cashierToken, sid, body, key);
      const second = await declare(cashierToken, sid, body, key);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);
    });

    it('a replayed closeAttemptId with SAME content (fresh Idempotency-Key) returns created:false, no duplicate row', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const closeAttemptId = newId();
      const first = await declare(cashierToken, sid, {
        closeAttemptId,
        countedTotalMinorUnits: '50000',
      });
      expect((first.body as DeclareBody).created).toBe(true);

      const replay = await declare(
        cashierToken,
        sid,
        { closeAttemptId, countedTotalMinorUnits: '50000' },
        `csc-replay2-${newId()}`,
      );
      expect(replay.status).toBe(201);
      expect((replay.body as DeclareBody).created).toBe(false);

      const attempts = await admin.cashSessionCloseAttempt.findMany({
        where: { id: closeAttemptId },
      });
      expect(attempts).toHaveLength(1);
    });

    it('a replayed closeAttemptId with DIFFERENT content -> 409 (FR-OFF-015 permanence)', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const closeAttemptId = newId();
      await declare(
        cashierToken,
        sid,
        { closeAttemptId, countedTotalMinorUnits: '50000' },
        `csc-diff1-${newId()}`,
      ).expect(201);

      const sid2 = await openSession(employeeCashier, terminalA);
      const res = await declare(
        cashierToken,
        sid2,
        { closeAttemptId, countedTotalMinorUnits: '50000' },
        `csc-diff2-${newId()}`,
      );
      expect(res.status).toBe(409);
    });

    it('finalize replay: the SAME approvalRequestId after approval returns the stored closed outcome; a DIFFERENT one conflicts', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '55000',
      }).expect(201);
      const body = finalizeBody();
      await finalize(cashierToken, sid, body, `csc-fin1-${newId()}`).expect(200);

      const replay = await finalize(
        cashierToken,
        sid,
        body,
        `csc-fin2-${newId()}`,
      );
      expect(replay.status).toBe(200);
      expect((replay.body as FinalizeBody).outcome).toBe('closed');

      const conflict = await finalize(
        cashierToken,
        sid,
        finalizeBody({ approvalRequestId: newId() }),
        `csc-fin3-${newId()}`,
      );
      expect(conflict.status).toBe(409);
    });
  });

  // ========================================================= DB IMMUTABILITY

  describe('DB-level immutability and grants (ros_app)', () => {
    it('ros_app has no UPDATE/DELETE on cash_session_close_attempts or cash_count_denominations', async () => {
      for (const table of [
        'cash_session_close_attempts',
        'cash_count_denominations',
      ]) {
        const grants = await admin.$queryRawUnsafe<
          { privilege_type: string }[]
        >(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE table_schema='treasury' AND table_name='${table}' AND grantee='ros_app'`,
        );
        const privileges = grants.map((g) => g.privilege_type);
        expect(privileges).not.toContain('UPDATE');
        expect(privileges).not.toContain('DELETE');
        expect(privileges).not.toContain('TRUNCATE');
      }
    });

    it('a raw ros_app UPDATE/DELETE on cash_session_close_attempts genuinely fails', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      });
      const attemptId = (res.body as DeclareBody).closeAttemptId;

      await expect(
        prisma.withAuthContext({ userId: newId(), tenantId: tenantA }, (tx) =>
          tx.$executeRaw`
            UPDATE "treasury"."cash_session_close_attempts"
            SET "counted_cash" = 0 WHERE "id" = ${attemptId}::uuid
          `,
        ),
      ).rejects.toThrow();

      await expect(
        prisma.withAuthContext({ userId: newId(), tenantId: tenantA }, (tx) =>
          tx.$executeRaw`
            DELETE FROM "treasury"."cash_session_close_attempts"
            WHERE "id" = ${attemptId}::uuid
          `,
        ),
      ).rejects.toThrow();

      const stillThere = await admin.cashSessionCloseAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      expect(stillThere.countedCash).toBe(50_000n);
    });

    it('ros_app cannot UPDATE a cash_sessions column outside the 10 close-related columns (e.g. opening_float)', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await expect(
        prisma.withAuthContext({ userId: newId(), tenantId: tenantA }, (tx) =>
          tx.$executeRaw`
            UPDATE "treasury"."cash_sessions"
            SET "opening_float" = 999999 WHERE "id" = ${sid}::uuid
          `,
        ),
      ).rejects.toThrow();
    });

    it('ros_app cannot jump cash_sessions straight from open to closed without an anchor (RLS WITH CHECK)', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await expect(
        prisma.withAuthContext({ userId: newId(), tenantId: tenantA }, (tx) =>
          tx.$executeRaw`
            UPDATE "treasury"."cash_sessions"
            SET "status" = 'closed'::"treasury"."CashSessionStatus"
            WHERE "id" = ${sid}::uuid
          `,
        ),
      ).rejects.toThrow();
    });
  });

  // ===================================================== RELATIONAL OWNERSHIP

  describe('relational ownership FKs', () => {
    it("an attempt cannot reference a DIFFERENT branch's session (three-column ownership FK)", async () => {
      const sid = await openSession(employeeCashier, terminalA);
      await expect(
        admin.$executeRaw`
          INSERT INTO "treasury"."cash_session_close_attempts" (
            "id", "tenant_id", "branch_id", "cash_session_id",
            "policy_version_id", "tolerance_minor_units", "count_mode",
            "opening_float", "cash_sales_total", "cash_tips_total", "pay_in_total",
            "cash_refunds_total", "pay_out_total", "safe_drop_total", "cash_rounding_adjustments",
            "expected_cash", "counted_cash", "variance", "currency", "approval_required",
            "declared_by_employee_id", "declared_by_user_id", "terminal_id", "declared_at"
          ) VALUES (
            ${newId()}::uuid, ${tenantA}::uuid, ${branchOpen}::uuid, ${sid}::uuid,
            (SELECT id FROM "treasury"."cash_close_policies" WHERE branch_id = ${branchOpen}::uuid LIMIT 1),
            1000, 'blind'::"treasury"."CashCountMode",
            50000, 0, 0, 0, 0, 0, 0, 0,
            50000, 50000, 0, 'EGP', false,
            ${employeeCashier}::uuid, ${userCashier}::uuid, ${terminalA}::uuid, statement_timestamp()
          )
        `,
      ).rejects.toThrow();
    });

    it("a cash_session cannot anchor to another session's close_attempt_id (three-column FK)", async () => {
      const sidA = await openSession(employeeCashier, terminalA);
      const sidB = await openSession(employeeCashier, terminalA);
      const declA = await declare(cashierToken, sidA, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      });
      const attemptA = (declA.body as DeclareBody).closeAttemptId;

      await expect(
        admin.$executeRaw`
          UPDATE "treasury"."cash_sessions"
          SET "close_attempt_id" = ${attemptA}::uuid,
              "status" = 'closed'::"treasury"."CashSessionStatus",
              "expected_cash" = 0, "counted_cash" = 0, "variance" = 0,
              "closed_at" = now()
          WHERE "id" = ${sidB}::uuid
        `,
      ).rejects.toThrow();
    });

    it('tenant B cannot read or reference a tenant A close attempt', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      });
      const attemptId = (res.body as DeclareBody).closeAttemptId;

      const seenCross = await prisma.withAuthContext(
        { tenantId: tenantB },
        (tx) => tx.cashSessionCloseAttempt.findUnique({ where: { id: attemptId } }),
      );
      expect(seenCross).toBeNull();

      const seenOwn = await prisma.withAuthContext(
        { tenantId: tenantA },
        (tx) => tx.cashSessionCloseAttempt.findUnique({ where: { id: attemptId } }),
      );
      expect(seenOwn).not.toBeNull();

      void employeeB;
      void terminalB;
      void branchB;
    });
  });

  // ============================================ FR-AUD-006 / §5.5.4 (ACCEPTANCE CLOSURE)

  describe('FR-AUD-001/006 cash-variance audit + SRS §5.5.4 cash.variance.detected event', () => {
    const varianceAuditEntries = async (sessionId: string, closeAttemptId?: string) => {
      const rows = await admin.auditEntry.findMany({
        where: { tenantId: tenantA, entityId: sessionId, action: 'CASH_VARIANCE_DECLARED' },
      });
      if (!closeAttemptId) return rows;
      return rows.filter(
        (r) => (r.afterState as Record<string, unknown> | null)?.closeAttemptId === closeAttemptId,
      );
    };

    it('above-tolerance declaration durably audits the variance AND publishes cash.variance.detected before any finalisation exists', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const closeAttemptId = newId();
      const before = capturedVarianceEvents.length;

      const declared = await declare(cashierToken, sid, {
        closeAttemptId,
        countedTotalMinorUnits: '55000',
      });
      expect(declared.status).toBe(201);

      // FR-AUD-006: the audit entry exists NOW — while the session is still
      // `closing`, unresolved, with no ApprovalRequest/decision and no
      // CASH_SESSION_CLOSED entry anywhere.
      const entries = await varianceAuditEntries(sid);
      expect(entries).toHaveLength(1);
      const metadata = entries[0].afterState as Record<string, unknown>;
      expect(metadata.closeAttemptId).toBe(closeAttemptId);
      expect(metadata.expectedCashMinorUnits).toBe('50000');
      expect(metadata.countedCashMinorUnits).toBe('55000');
      expect(metadata.varianceMinorUnits).toBe('5000');
      expect(metadata.toleranceMinorUnits).toBe(TOLERANCE.toString());
      expect(metadata.approvalRequired).toBe(true);
      expect(metadata.declaredByEmployeeId).toBe(employeeCashier);
      // Full formula breakdown present, not merely the resulting figures.
      expect(metadata.openingFloatMinorUnits).toBe('50000');
      expect(metadata.cashSalesTotalMinorUnits).toBe('0');
      expect(metadata.cashTipsTotalMinorUnits).toBe('0');
      expect(metadata.payInTotalMinorUnits).toBe('0');
      expect(metadata.cashRefundsTotalMinorUnits).toBe('0');
      expect(metadata.payOutTotalMinorUnits).toBe('0');
      expect(metadata.safeDropTotalMinorUnits).toBe('0');

      const closedEntries = await admin.auditEntry.findMany({
        where: { tenantId: tenantA, entityId: sid, action: 'CASH_SESSION_CLOSED' },
      });
      expect(closedEntries).toHaveLength(0); // not yet — still `closing`

      // SRS §5.5.4: published in the SAME transaction, before finalisation.
      expect(capturedVarianceEvents.length).toBe(before + 1);
      const event = capturedVarianceEvents[capturedVarianceEvents.length - 1];
      expect(event.eventType).toBe('cash.variance.detected');
      expect(event.tenantId).toBe(tenantA);
      expect(event.payload.cashSessionId).toBe(sid);
      expect(event.payload.closeAttemptId).toBe(closeAttemptId);
      expect(event.payload.varianceMinorUnits).toBe('5000');
      expect(event.payload.approvalRequired).toBe(true);
      expect(event.idempotencyKey).toBe(`cash.variance.detected:${closeAttemptId}`);
    });

    it('within-tolerance fast close ALSO audits the variance (distinct fact from CASH_SESSION_CLOSED, not duplicate noise)', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const before = capturedVarianceEvents.length;

      const res = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '50000',
      });
      expect(res.status).toBe(201);

      const varianceEntries = await varianceAuditEntries(sid);
      const closedEntries = await admin.auditEntry.findMany({
        where: { tenantId: tenantA, entityId: sid, action: 'CASH_SESSION_CLOSED' },
      });
      expect(varianceEntries).toHaveLength(1); // the variance was declared...
      expect(closedEntries).toHaveLength(1); // ...AND the session closed — two distinct facts.
      expect(capturedVarianceEvents.length).toBe(before + 1);
    });

    it("R-6(a) explicit rejection does not remove or alter the declaration-time variance audit entry", async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const declared = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '55000',
      });
      const closeAttemptId = (declared.body as DeclareBody).closeAttemptId;
      const beforeReject = await varianceAuditEntries(sid, closeAttemptId);
      expect(beforeReject).toHaveLength(1);

      await finalize(
        cashierToken,
        sid,
        finalizeBody({ decision: 'rejected', reason: 'Recount needed.' }),
      ).expect(200);

      const afterReject = await varianceAuditEntries(sid, closeAttemptId);
      expect(afterReject).toHaveLength(1);
      expect(afterReject[0].id).toBe(beforeReject[0].id); // the SAME row, untouched
      expect(afterReject[0].afterState).toEqual(beforeReject[0].afterState);
    });

    it('approved finalisation adds only CASH_SESSION_CLOSED — no second CASH_VARIANCE_DECLARED entry and no second event', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const declared = await declare(cashierToken, sid, {
        closeAttemptId: newId(),
        countedTotalMinorUnits: '55000',
      });
      const closeAttemptId = (declared.body as DeclareBody).closeAttemptId;
      const eventCountAfterDeclare = capturedVarianceEvents.length;

      await finalize(cashierToken, sid, finalizeBody()).expect(200);

      const varianceEntries = await varianceAuditEntries(sid, closeAttemptId);
      const closedEntries = await admin.auditEntry.findMany({
        where: { tenantId: tenantA, entityId: sid, action: 'CASH_SESSION_CLOSED' },
      });
      expect(varianceEntries).toHaveLength(1); // still exactly one — from declare, not finalize
      expect(closedEntries).toHaveLength(1);
      // finalize does not call declareClose's UnitOfWork/publishEvent path at all.
      expect(capturedVarianceEvents.length).toBe(eventCountAfterDeclare);
    });

    it('idempotent declaration replay (same closeAttemptId, same content) does not duplicate the audit entry or publish a second logical event', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const closeAttemptId = newId();
      const body = { closeAttemptId, countedTotalMinorUnits: '50000' };

      await declare(cashierToken, sid, body, `csc-aud-replay-1-${newId()}`).expect(201);
      const eventCountAfterFirst = capturedVarianceEvents.length;

      const replay = await declare(
        cashierToken,
        sid,
        body,
        `csc-aud-replay-2-${newId()}`,
      );
      expect(replay.status).toBe(201);
      expect((replay.body as DeclareBody).created).toBe(false);

      const entries = await varianceAuditEntries(sid, closeAttemptId);
      expect(entries).toHaveLength(1);
      expect(capturedVarianceEvents.length).toBe(eventCountAfterFirst); // no second event
    });

    it('a subscriber failure rolls back the ENTIRE declaration — no attempt row, no audit entry, no session mutation survive', async () => {
      const sid = await openSession(employeeCashier, terminalA);
      const closeAttemptId = newId();
      throwOnNextVarianceEvent = true;

      const res = await declare(cashierToken, sid, {
        closeAttemptId,
        countedTotalMinorUnits: '50000',
      });
      // The interceptor/exception filter turns the thrown handler error into
      // a 5xx; the exact status is not the point — the DB state is.
      expect(res.status).toBeGreaterThanOrEqual(500);

      const attempt = await admin.cashSessionCloseAttempt.findUnique({
        where: { id: closeAttemptId },
      });
      expect(attempt).toBeNull();
      const entries = await varianceAuditEntries(sid, closeAttemptId);
      expect(entries).toHaveLength(0);
      const session = await admin.cashSession.findUniqueOrThrow({ where: { id: sid } });
      expect(session.status).toBe('open'); // never touched
    });
  });

  // ================================================================ SCOPE

  describe('slice boundary', () => {
    it('BIGINT_MIN boundary is CHECK-enforced overflow-safely at the DB (empirically proven in the final acceptance closure phase); client input can never reach it (regex-bounded non-negative strings)', async () => {
      // The DDL's `ck_csca_approval_required_matches` uses
      // `variance > tolerance OR variance < -tolerance` — never `abs()` —
      // specifically because `abs(BIGINT_MIN)` raises "bigint out of
      // range". Re-confirm the CHECK's exact overflow-safe form is still
      // present in this scratch DB's actual catalogue (not just the
      // migration source file).
      const rows = await admin.$queryRawUnsafe<{ definition: string }[]>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'ck_csca_approval_required_matches'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].definition).not.toMatch(/abs\(/i);
      expect(rows[0].definition).toMatch(/>/);
      expect(rows[0].definition).toMatch(/</);
    });
  });
});
