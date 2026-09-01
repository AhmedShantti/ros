import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';
import {
  branchBusinessDay,
  createCashSession,
  createReportingFixture,
  daysBefore,
  dashboardToken,
  dateStr,
  insertOrder,
  insertOrderPayment,
  setBranchBaseCurrency,
} from './reporting-fixtures';

interface ReportBody {
  readonly currency: string;
  readonly currencySource: 'TRANSACTION' | 'BRANCH_FALLBACK';
  readonly salesSummary: { readonly grossSales: string };
}

/**
 * Historical currency — design gate/acceptance correction §6/§23/§45.
 * Observed transaction currency is authoritative; the branch's CURRENT
 * `baseCurrency` is only the empty-day fallback.
 */
describe('Reporting — Historical currency (e2e)', () => {
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

  it('REGRESSION: a day fully denominated in EGP still returns EGP/TRANSACTION after the branch base currency changes to USD', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      currency: 'EGP',
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay: yesterday,
      orderNumber: orderNumber(),
      state: 'completed',
      currency: 'EGP',
      grandTotal: 500n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId,
      businessDay: yesterday,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 500n,
      currency: 'EGP',
    });

    // The branch's CURRENT configured currency changes AFTER the fact.
    await setBranchBaseCurrency(admin, fx.branchId, 'USD');

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(yesterday)}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.currency).toBe('EGP');
    expect(body.currencySource).toBe('TRANSACTION');
    expect(body.salesSummary.grossSales).toBe('500');
  });

  it('an empty financial day uses the CURRENT branch currency, currencySource=BRANCH_FALLBACK', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const today = branchBusinessDay(new Date());
    const yesterday = daysBefore(today, 1);
    await setBranchBaseCurrency(admin, fx.branchId, 'USD');

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(yesterday)}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.currency).toBe('USD');
    expect(body.currencySource).toBe('BRANCH_FALLBACK');
    expect(body.salesSummary.grossSales).toBe('0');
  });

  it('two observed transaction currencies -> 409, no partial financial total', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const businessDay = branchBusinessDay(new Date());
    const sessionEgp = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      currency: 'EGP',
    });
    const sessionUsd = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      currency: 'USD',
    });
    const orderEgp = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      currency: 'EGP',
      grandTotal: 100n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: orderEgp,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId: sessionEgp,
      tender: 'cash',
      amount: 100n,
      currency: 'EGP',
    });
    const orderUsd = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      currency: 'USD',
      grandTotal: 20n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: orderUsd,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId: sessionUsd,
      tender: 'cash',
      amount: 20n,
      currency: 'USD',
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body).not.toHaveProperty('salesSummary');
    expect(res.body).not.toHaveProperty('currency');
  });

  it('a contributing session currency disagreeing with the report currency -> 409, no partial total (defense in depth over an otherwise-unreachable state)', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}d`);
    const businessDay = branchBusinessDay(new Date());
    // The session is opened in USD; every payment on it is EGP — a state the
    // real capture path (`sales-payment.service.ts`) refuses to create, but
    // this fixture proves the report itself still fails closed if it ever
    // occurred (an integrity defect surfaced honestly, never a silent merge).
    const mismatchedSession = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
      currency: 'USD',
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      currency: 'EGP',
      grandTotal: 100n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId: mismatchedSession,
      tender: 'cash',
      amount: 100n,
      currency: 'EGP',
    });

    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body).not.toHaveProperty('salesSummary');
  });
});
