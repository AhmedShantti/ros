import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';
import {
  branchBusinessDay,
  closeCashSessionWithFacts,
  createCashSession,
  createReportingFixture,
  daysBefore,
  dashboardToken,
  dateStr,
  declareClosingSession,
  insertCashMovement,
  insertOrder,
  insertOrderPayment,
  ReportingFixture,
} from './reporting-fixtures';

type CashReconciliationBody = {
  cashReconciliation: {
    scope: string;
    sessions: Array<{
      cashSessionId: string;
      status: string;
      expectedCash: string | null;
      countedCash: string | null;
      variance: string | null;
      isFinalised: boolean;
      businessDayCount: number;
      spansMultipleBusinessDays: boolean;
      tenderTotalsForThisBusinessDay: {
        cashSalesTotal: string;
        manualExternalCardTotal: string;
        paymentCount: number;
      };
    }>;
    contributingSessionCount: number;
    closedSessionCount: number;
    unclosedSessionCount: number;
    spanningSessionCount: number;
  };
};

/**
 * Cash Reconciliation — design gate §24-§27/§43. WHOLE_SESSION scope only;
 * payment-contributing sessions only; no day-level variance/expected/
 * counted/movement total anywhere in the response.
 */
describe('Reporting — Cash Reconciliation (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let n = 0;
  function orderNumber(): string {
    n += 1;
    return `O-${n}`;
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function getReport(
    fx: ReportingFixture,
    businessDay: Date,
  ): Promise<CashReconciliationBody> {
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as CashReconciliationBody;
  }

  async function payOnSession(
    fx: ReportingFixture,
    cashSessionId: string,
    businessDay: Date,
    amount: bigint,
  ): Promise<void> {
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: amount,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount,
    });
  }

  it('several contributing sessions each appear exactly once, scope literal present, counts are exact', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const businessDay = branchBusinessDay(new Date());
    const sessionA = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const sessionB = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await payOnSession(fx, sessionA, businessDay, 100n);
    await payOnSession(fx, sessionB, businessDay, 200n);

    const body = await getReport(fx, businessDay);
    expect(body.cashReconciliation.scope).toBe('WHOLE_SESSION');
    expect(body.cashReconciliation.sessions).toHaveLength(2);
    const ids = body.cashReconciliation.sessions.map((s) => s.cashSessionId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort()).toEqual([sessionA, sessionB].sort());
    expect(body.cashReconciliation.contributingSessionCount).toBe(2);
  });

  it('a closed session shows its whole-session close facts; open close facts are nullable', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const businessDay = branchBusinessDay(new Date());
    const openSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      openingFloat: 1_000n,
    });
    await payOnSession(fx, openSession, businessDay, 50n);

    const closedSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      openingFloat: 1_000n,
    });
    await payOnSession(fx, closedSession, businessDay, 300n);
    await closeCashSessionWithFacts(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId: closedSession,
      employeeId: fx.employeeId,
      employeeUserId: fx.employeeUserId,
      terminalId: fx.terminalId,
      openingFloat: 1_000n,
      cashSalesTotal: 300n,
      countedCash: 1_300n, // exact: opening + sales, zero variance
    });

    const body = await getReport(fx, businessDay);
    const open = body.cashReconciliation.sessions.find(
      (s) => s.cashSessionId === openSession,
    )!;
    const closed = body.cashReconciliation.sessions.find(
      (s) => s.cashSessionId === closedSession,
    )!;
    expect(open.status).toBe('open');
    expect(open.expectedCash).toBeNull();
    expect(open.countedCash).toBeNull();
    expect(open.variance).toBeNull();
    expect(open.isFinalised).toBe(false);

    expect(closed.status).toBe('closed');
    expect(closed.expectedCash).toBe('1300');
    expect(closed.countedCash).toBe('1300');
    expect(closed.variance).toBe('0');
    expect(closed.isFinalised).toBe(true);

    expect(body.cashReconciliation.closedSessionCount).toBe(1);
    expect(body.cashReconciliation.unclosedSessionCount).toBe(1);
    expect(body.cashReconciliation.contributingSessionCount).toBe(2);
  });

  it('a "closing" (declared, not finalised) session is unclosed and its close facts are still null', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const businessDay = branchBusinessDay(new Date());
    const sessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      openingFloat: 500n,
    });
    await payOnSession(fx, sessionId, businessDay, 40n);
    await declareClosingSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId: sessionId,
      employeeId: fx.employeeId,
      employeeUserId: fx.employeeUserId,
      terminalId: fx.terminalId,
      openingFloat: 500n,
      cashSalesTotal: 40n,
      countedCash: 540n,
    });

    const body = await getReport(fx, businessDay);
    const session = body.cashReconciliation.sessions.find(
      (s) => s.cashSessionId === sessionId,
    )!;
    expect(session.status).toBe('closing');
    expect(session.expectedCash).toBeNull();
    expect(session.isFinalised).toBe(false);
    expect(body.cashReconciliation.unclosedSessionCount).toBe(1);
  });

  it('a session spanning two business days appears in BOTH days with businessDayCount=2, and day-scoped tender values differ correctly per day', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}d`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    const sessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await payOnSession(fx, sessionId, yesterday, 70n);
    await payOnSession(fx, sessionId, today, 30n);

    const bodyYesterday = await getReport(fx, yesterday);
    const bodyToday = await getReport(fx, today);
    const sessionYesterday = bodyYesterday.cashReconciliation.sessions.find(
      (s) => s.cashSessionId === sessionId,
    )!;
    const sessionToday = bodyToday.cashReconciliation.sessions.find(
      (s) => s.cashSessionId === sessionId,
    )!;
    expect(sessionYesterday.businessDayCount).toBe(2);
    expect(sessionToday.businessDayCount).toBe(2);
    expect(sessionYesterday.spansMultipleBusinessDays).toBe(true);
    expect(sessionToday.spansMultipleBusinessDays).toBe(true);
    expect(sessionYesterday.tenderTotalsForThisBusinessDay.cashSalesTotal).toBe(
      '70',
    );
    expect(sessionToday.tenderTotalsForThisBusinessDay.cashSalesTotal).toBe(
      '30',
    );
    expect(bodyYesterday.cashReconciliation.spanningSessionCount).toBe(1);
    expect(bodyToday.cashReconciliation.spanningSessionCount).toBe(1);
  });

  it('a zero-payment session is absent from the report and not counted', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}e`);
    const businessDay = branchBusinessDay(new Date());
    const paidSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await payOnSession(fx, paidSession, businessDay, 10n);
    // A second session, opened, but never receives a payment.
    const zeroPaymentSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });

    const body = await getReport(fx, businessDay);
    expect(body.cashReconciliation.sessions).toHaveLength(1);
    expect(body.cashReconciliation.sessions[0].cashSessionId).toBe(paidSession);
    expect(
      body.cashReconciliation.sessions.some(
        (s) => s.cashSessionId === zeroPaymentSession,
      ),
    ).toBe(false);
    expect(body.cashReconciliation.contributingSessionCount).toBe(1);
  });

  it('a movement-only session (pay-in/out/safe-drop, no payment) is absent', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}f`);
    const businessDay = branchBusinessDay(new Date());
    const movementOnlySession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await insertCashMovement(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId: movementOnlySession,
      employeeId: fx.employeeId,
      performedByUserId: fx.employeeUserId,
      movementType: 'pay_in',
      amount: 500n,
    });

    const body = await getReport(fx, businessDay);
    expect(body.cashReconciliation.sessions).toHaveLength(0);
    expect(body.cashReconciliation.contributingSessionCount).toBe(0);
  });

  it('no day-level varianceTotal/expected/counted/movement-total key exists anywhere in the response', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}g`);
    const businessDay = branchBusinessDay(new Date());
    const sessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      openingFloat: 100n,
    });
    await payOnSession(fx, sessionId, businessDay, 10n);
    await closeCashSessionWithFacts(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId: sessionId,
      employeeId: fx.employeeId,
      employeeUserId: fx.employeeUserId,
      terminalId: fx.terminalId,
      openingFloat: 100n,
      cashSalesTotal: 10n,
      countedCash: 105n, // deliberate +5 variance
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as CashReconciliationBody;
    const reconciliationKeys = Object.keys(body.cashReconciliation);
    for (const forbidden of [
      'varianceTotal',
      'payInTotal',
      'payOutTotal',
      'safeDropTotal',
      'expectedCashTotal',
      'countedCashTotal',
    ]) {
      expect(reconciliationKeys).not.toContain(forbidden);
    }
    // The per-session variance IS present (whole-session scope), just never
    // aggregated at the day level.
    expect(body.cashReconciliation.sessions[0].variance).toBe('-5');
  });

  it('closedSessionCount + unclosedSessionCount === contributingSessionCount', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}h`);
    const businessDay = branchBusinessDay(new Date());
    const openSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await payOnSession(fx, openSession, businessDay, 5n);
    const closedSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      openingFloat: 0n,
    });
    await payOnSession(fx, closedSession, businessDay, 15n);
    await closeCashSessionWithFacts(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId: closedSession,
      employeeId: fx.employeeId,
      employeeUserId: fx.employeeUserId,
      terminalId: fx.terminalId,
      openingFloat: 0n,
      cashSalesTotal: 15n,
      countedCash: 15n,
    });

    const body = await getReport(fx, businessDay);
    expect(
      body.cashReconciliation.closedSessionCount +
        body.cashReconciliation.unclosedSessionCount,
    ).toBe(body.cashReconciliation.contributingSessionCount);
  });
});
