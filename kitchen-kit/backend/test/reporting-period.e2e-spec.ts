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
  insertOrder,
  insertOrderPayment,
  ReportingFixture,
} from './reporting-fixtures';

interface ReportBody {
  periodStatus: 'OPEN' | 'UNSEALED' | 'SETTLED';
  branchCurrentBusinessDay: string;
  openOrderCount: number;
  unclosedContributingSessionCount: number;
}
interface ErrorBody {
  message: string;
}

/**
 * Period status — design gate §16/§28/§44. Exactly OPEN/UNSEALED/SETTLED;
 * SEALED and FUTURE are never emitted; future days are 400, not OPEN.
 */
describe('Reporting — Period status (e2e)', () => {
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

  async function getResponse(fx: ReportingFixture, businessDay: Date) {
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    return request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`);
  }

  it('the current business day is OPEN', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const today = branchBusinessDay(new Date());
    const res = await getResponse(fx, today);
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.periodStatus).toBe('OPEN');
    expect(body.branchCurrentBusinessDay).toBe(dateStr(today));
  });

  it('a day after the current business day -> 400, never a report body, never OPEN', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const today = branchBusinessDay(new Date());
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const res = await getResponse(fx, tomorrow);
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).message).toBe(
      'Future business days are not supported.',
    );
    expect((res.body as Partial<ReportBody>).periodStatus).toBeUndefined();
  });

  it('a far-future day -> 400, not an all-zeros OPEN report', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    const res = await getResponse(fx, farFuture);
    expect(res.status).toBe(400);
  });

  it('a past day with an open order -> UNSEALED, openOrderCount > 0', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}d`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay: yesterday,
      orderNumber: orderNumber(),
      state: 'open',
      grandTotal: 100n,
      taxTotal: 0n,
    });
    const res = await getResponse(fx, yesterday);
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.periodStatus).toBe('UNSEALED');
    expect(body.openOrderCount).toBeGreaterThan(0);
  });

  it('a past day whose only issue is an unclosed CONTRIBUTING session -> UNSEALED', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}e`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    const sessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay: yesterday,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 50n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId,
      businessDay: yesterday,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId: sessionId,
      tender: 'cash',
      amount: 50n,
    });
    const res = await getResponse(fx, yesterday);
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.periodStatus).toBe('UNSEALED');
    expect(body.openOrderCount).toBe(0);
    expect(body.unclosedContributingSessionCount).toBe(1);
  });

  it('a past day with an unrelated open session that captured NO payment that day -> SETTLED (zero-payment session is not a blocker)', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}f`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    // Fully settled trading yesterday.
    const settledSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      openingFloat: 0n,
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay: yesterday,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 10n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId,
      businessDay: yesterday,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId: settledSession,
      tender: 'cash',
      amount: 10n,
    });
    await closeCashSessionWithFacts(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      cashSessionId: settledSession,
      employeeId: fx.employeeId,
      employeeUserId: fx.employeeUserId,
      terminalId: fx.terminalId,
      openingFloat: 0n,
      cashSalesTotal: 10n,
      countedCash: 10n,
    });
    // An UNRELATED session, still open, but with zero payments on yesterday
    // (or any day) — it must NOT be a blocker.
    await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });

    const res = await getResponse(fx, yesterday);
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.periodStatus).toBe('SETTLED');
    expect(body.openOrderCount).toBe(0);
    expect(body.unclosedContributingSessionCount).toBe(0);
  });

  it('a past, fully settled day -> SETTLED', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}g`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    const res = await getResponse(fx, yesterday);
    expect(res.status).toBe(200);
    expect((res.body as ReportBody).periodStatus).toBe('SETTLED');
  });

  it('SEALED and FUTURE are never emitted', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}h`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    for (const day of [today, yesterday]) {
      const res = await getResponse(fx, day);
      expect(res.status).toBe(200);
      expect(['OPEN', 'UNSEALED', 'SETTLED']).toContain(
        (res.body as ReportBody).periodStatus,
      );
    }
  });

  it('the field is named unclosedContributingSessionCount, never unclosedSessionCount, at the top level', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}i`);
    const today = branchBusinessDay(new Date());
    const res = await getResponse(fx, today);
    expect(res.status).toBe(200);
    expect(res.body as ReportBody).toHaveProperty(
      'unclosedContributingSessionCount',
    );
    expect(res.body as ReportBody).not.toHaveProperty('unclosedSessionCount');
  });

  it('the current-day comparison uses the branch calendar, not a UTC server date (a non-UTC-offset branch)', async () => {
    // A branch far ahead of UTC — its "current business day" can differ from
    // the server's own UTC calendar date depending on wall-clock time.
    const fx = await createReportingFixture(app, admin, `${stamp}j`);
    await admin.branch.update({
      where: { id: fx.branchId },
      data: { timezone: 'Pacific/Kiritimati' },
    });
    const branchToday = branchBusinessDay(new Date(), 'Pacific/Kiritimati');
    const res = await getResponse(fx, branchToday);
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.periodStatus).toBe('OPEN');
    expect(body.branchCurrentBusinessDay).toBe(dateStr(branchToday));
  });
});
