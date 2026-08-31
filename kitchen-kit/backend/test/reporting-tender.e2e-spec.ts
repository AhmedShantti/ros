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
  dashboardToken,
  dateStr,
  insertOrder,
  insertOrderPayment,
} from './reporting-fixtures';

/**
 * Sales by Tender — design gate §17/§18/§41. `payment.amount` only, never
 * `tendered_amount`/`change_given`; cash rounding kept out of revenue; no
 * card-scheme grouping; the tender/gross identity.
 */
describe('Reporting — Tender totals (e2e)', () => {
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
    tenantId: string,
    branchId: string,
    businessDay: Date,
    email: string,
  ) {
    const token = await dashboardToken(http, email, tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as {
      tenderTotals: {
        cash: {
          amountTotal: string;
          roundingAdjustmentTotal: string;
          paymentCount: number;
        };
        manualExternalCard: {
          amountTotal: string;
          roundingAdjustmentTotal: string;
          paymentCount: number;
        };
        tenderGrandTotal: string;
        cashDrawerContribution: string;
        paymentCount: number;
        completedExcessCapturedTotal: string;
      };
      salesSummary: { grossSales: string; unsettledCapturedTotal: string };
    };
  }

  it('90 due / 100 tendered / 10 change -> cash sales counted as 90, never tenderedAmount, never changeGiven', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 90n,
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
      amount: 90n,
      tenderedAmount: 100n,
      changeGiven: 10n,
    });
    const body = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    expect(body.tenderTotals.cash.amountTotal).toBe('90');
    expect(body.salesSummary.grossSales).toBe('90');
    // CASE A (over-tender, not overpayment): amount === grandTotal, so
    // there is no captured excess — distinct from a genuine overpayment
    // (see test/reporting-overpayment.e2e-spec.ts).
    expect(body.tenderTotals.completedExcessCapturedTotal).toBe('0');
  });

  it('cash rounding is separate from sales; cashDrawerContribution includes it, grossSales never does', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
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
      cashSessionId,
      tender: 'cash',
      amount: 100n,
      roundingAdjustment: -2n,
    });
    const body = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    expect(body.tenderTotals.cash.amountTotal).toBe('100');
    expect(body.tenderTotals.cash.roundingAdjustmentTotal).toBe('-2');
    expect(body.tenderTotals.cashDrawerContribution).toBe('98');
    expect(body.salesSummary.grossSales).toBe('100');
  });

  it('manual_external_card total is correct and its rounding is always zero; no card-scheme grouping is exposed', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 250n,
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
      tender: 'manual_external_card',
      amount: 250n,
    });
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as {
      tenderTotals: {
        manualExternalCard: {
          amountTotal: string;
          roundingAdjustmentTotal: string;
        };
      };
    };
    expect(body.tenderTotals.manualExternalCard.amountTotal).toBe('250');
    expect(body.tenderTotals.manualExternalCard.roundingAdjustmentTotal).toBe(
      '0',
    );
    expect(res.text).not.toContain('cardScheme');
    expect(res.text).not.toContain('byCardScheme');
  });

  it('tender identity: tenderGrandTotal === grossSales + unsettledCapturedTotal', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}d`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const completed = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 800n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: completed,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 500n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: completed,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'manual_external_card',
      amount: 300n,
    });
    const partiallyPaid = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'partially_paid',
      grandTotal: 400n,
      taxTotal: 0n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: partiallyPaid,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 150n,
    });
    const body = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    expect(body.salesSummary.grossSales).toBe('800');
    expect(body.salesSummary.unsettledCapturedTotal).toBe('150');
    expect(body.tenderTotals.tenderGrandTotal).toBe('950'); // 500 + 300 + 150
    // No overpayment in this fixture (paidTotal === grandTotal on the
    // completed order), so the corrected identity's third term is zero.
    expect(body.tenderTotals.completedExcessCapturedTotal).toBe('0');
    expect(
      BigInt(body.tenderTotals.tenderGrandTotal) ===
        BigInt(body.salesSummary.grossSales) +
          BigInt(body.salesSummary.unsettledCapturedTotal) +
          BigInt(body.tenderTotals.completedExcessCapturedTotal),
    ).toBe(true);
  });

  it('one payment row is counted exactly once — no hidden double-counting across the cash/card/session aggregation passes', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}e`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 120n,
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
      amount: 120n,
    });
    // Reading the same, unchanged report twice must be perfectly stable —
    // the read path itself performs no write, projection refresh, or
    // replay-sensitive accumulation of its own.
    const body1 = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    const body2 = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    for (const body of [body1, body2]) {
      expect(body.tenderTotals.cash.amountTotal).toBe('120');
      expect(body.tenderTotals.cash.paymentCount).toBe(1);
      expect(body.tenderTotals.paymentCount).toBe(1);
    }
  });
});
