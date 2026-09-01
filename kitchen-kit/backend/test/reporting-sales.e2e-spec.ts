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
  ReportingFixture,
} from './reporting-fixtures';

/**
 * Sales Summary — design gate §11/§12/§40, acceptance correction §11
 * (gross/net future-compatibility, `orders.subtotal` present-tense rule).
 */
describe('Reporting — Sales Summary (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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

  async function getReport(fx: ReportingFixture, businessDay: Date) {
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as {
      salesSummary: {
        grossSales: string;
        discounts: string;
        refunds: string;
        taxTotal: string;
        netSales: string;
        completedOrderCount: number;
        averageOrderValue: string | null;
        unsettledCapturedTotal: string;
      };
      openOrderCount: number;
    };
  }

  let n = 0;
  function orderNumber(): string {
    n += 1;
    return `O-${n}`;
  }

  it('completed orders are counted and summed; open/held/parked/partially_paid/cancelled are excluded from revenue', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });

    // Two completed orders.
    const c1 = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 1_000n,
      taxTotal: 100n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: c1,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 1_000n,
    });
    const c2 = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 500n,
      taxTotal: 50n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: c2,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 500n,
    });

    // One of each non-revenue state.
    for (const state of ['open', 'held', 'parked', 'cancelled'] as const) {
      await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay,
        orderNumber: orderNumber(),
        state,
        grandTotal: 9_999n,
        taxTotal: 999n,
      });
    }
    // A partially-paid order WITH a payment — must be excluded from revenue
    // but its payment must appear in tender/unsettledCapturedTotal.
    const pp = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'partially_paid',
      grandTotal: 2_000n,
      taxTotal: 200n,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: pp,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 300n,
    });

    const body = await getReport(fx, businessDay);
    expect(body.salesSummary.completedOrderCount).toBe(2);
    expect(body.salesSummary.grossSales).toBe('1500');
    expect(body.salesSummary.taxTotal).toBe('150');
    expect(body.salesSummary.discounts).toBe('0');
    expect(body.salesSummary.refunds).toBe('0');
    expect(body.salesSummary.netSales).toBe('1350');
    expect(body.salesSummary.unsettledCapturedTotal).toBe('300');
    // open, held, parked, partially_paid — one each; cancelled and the two
    // completed orders are excluded.
    expect(body.openOrderCount).toBe(4);
  });

  it('multiple completed orders sum correctly; AOV is NET-basis and null at zero count', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const businessDay = branchBusinessDay(new Date());
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    for (const [gross, tax] of [
      [1_000n, 100n],
      [2_000n, 200n],
      [3_000n, 300n],
    ] as const) {
      const id = await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay,
        orderNumber: orderNumber(),
        state: 'completed',
        grandTotal: gross,
        taxTotal: tax,
      });
      await insertOrderPayment(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        orderId: id,
        businessDay,
        terminalId: fx.terminalId,
        employeeId: fx.employeeId,
        cashSessionId,
        tender: 'cash',
        amount: gross,
      });
    }
    const body = await getReport(fx, businessDay);
    // gross = 6000, tax = 600, net = 5400, count = 3 -> AOV = 1800
    expect(body.salesSummary.grossSales).toBe('6000');
    expect(body.salesSummary.netSales).toBe('5400');
    expect(body.salesSummary.completedOrderCount).toBe(3);
    expect(body.salesSummary.averageOrderValue).toBe('1800');
  });

  it('AOV is null when completedOrderCount is zero', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const businessDay = branchBusinessDay(new Date());
    const body = await getReport(fx, businessDay);
    expect(body.salesSummary.completedOrderCount).toBe(0);
    expect(body.salesSummary.averageOrderValue).toBeNull();
    expect(body.salesSummary.grossSales).toBe('0');
    expect(body.salesSummary.netSales).toBe('0');
  });

  it('money beyond 2^53 serializes exactly as a decimal string', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}d`);
    const businessDay = branchBusinessDay(new Date());
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const id = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: huge,
      taxTotal: 0n,
    });
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: id,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: huge,
    });
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // Assert against the raw response TEXT, before JSON.parse can round the
    // number — proving no IEEE-754 float ever touched this value.
    expect(res.text).toContain('"grossSales":"9007199254740993"');
  });

  it('orders.subtotal never drives any formula (deliberately wrong subtotal on every fixture order)', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}e`);
    const businessDay = branchBusinessDay(new Date());
    const id = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 700n,
      taxTotal: 70n,
      subtotal: 1n, // absurdly wrong on purpose
    });
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: id,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 700n,
    });
    const body = await getReport(fx, businessDay);
    expect(body.salesSummary.grossSales).toBe('700');
    expect(body.salesSummary.netSales).toBe('630');
  });

  it('net = gross - discounts - refunds - tax; discounts/refunds are truthfully zero at this HEAD', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}f`);
    const businessDay = branchBusinessDay(new Date());
    const id = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 1_100n,
      taxTotal: 100n,
      discountTotal: 0n,
    });
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    await insertOrderPayment(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      orderId: id,
      businessDay,
      terminalId: fx.terminalId,
      employeeId: fx.employeeId,
      cashSessionId,
      tender: 'cash',
      amount: 1_100n,
    });
    const body = await getReport(fx, businessDay);
    expect(body.salesSummary.discounts).toBe('0');
    expect(body.salesSummary.refunds).toBe('0');
    expect(body.salesSummary.netSales).toBe('1000');
  });

  it('open/held/parked/partially_paid orders are counted in openOrderCount; completed/cancelled are not', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}g`);
    const businessDay = branchBusinessDay(new Date());
    for (const state of [
      'open',
      'held',
      'parked',
      'partially_paid',
      'completed',
      'cancelled',
    ] as const) {
      await insertOrder(admin, {
        tenantId: fx.tenantId,
        branchId: fx.branchId,
        terminalId: fx.terminalId,
        openedBy: fx.employeeId,
        businessDay,
        orderNumber: orderNumber(),
        state,
        grandTotal: 100n,
        taxTotal: 10n,
      });
    }
    const body = await getReport(fx, businessDay);
    expect(body.openOrderCount).toBe(4);
    expect(body.salesSummary.completedOrderCount).toBe(1);
  });
});
