import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';
import {
  branchBusinessDay,
  createCashSession,
  createMenuItemRef,
  createReportingFixture,
  createTaxClass,
  dashboardToken,
  dateStr,
  insertOrder,
  insertOrderLine,
  insertOrderPayment,
} from './reporting-fixtures';

/**
 * Tax Summary — design gate §21/§42. By class only, no by-rate; completed-
 * order population only; voided/comped lines excluded; internal identities.
 */
describe('Reporting — Tax Summary (e2e)', () => {
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
      taxSummary: {
        taxTotal: string;
        byClass: Array<{
          taxClassId: string;
          taxClassCode: string | null;
          countryPackCode: string | null;
          taxAmount: string;
          netAmount: string;
          grossAmount: string;
          lineCount: number;
        }>;
      };
      salesSummary: { taxTotal: string };
    };
  }

  it('two tax classes aggregate separately; the sum equals sales.taxTotal; net+tax=gross per class; no byRate key', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const businessDay = branchBusinessDay(new Date());
    const { menuItemId, variantId } = await createMenuItemRef(
      admin,
      fx.tenantId,
    );
    const standardTaxClassId = await createTaxClass(admin, {
      tenantId: fx.tenantId,
      code: 'standard',
    });
    const zeroTaxClassId = await createTaxClass(admin, {
      tenantId: fx.tenantId,
      code: 'zero_rated',
    });

    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 1_150n,
      taxTotal: 150n,
    });
    await insertOrderLine(admin, {
      tenantId: fx.tenantId,
      orderId,
      businessDay,
      sequence: 1,
      menuItemId,
      variantId,
      taxClassId: standardTaxClassId,
      taxAmount: 150n,
      lineTotal: 1_150n,
    });
    await insertOrderLine(admin, {
      tenantId: fx.tenantId,
      orderId,
      businessDay,
      sequence: 2,
      menuItemId,
      variantId,
      taxClassId: zeroTaxClassId,
      taxAmount: 0n,
      lineTotal: 500n,
    });
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
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
      amount: 1_150n,
    });

    const body = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    expect(body.taxSummary.byClass).toHaveLength(2);
    const standard = body.taxSummary.byClass.find(
      (c) => c.taxClassId === standardTaxClassId,
    )!;
    const zero = body.taxSummary.byClass.find(
      (c) => c.taxClassId === zeroTaxClassId,
    )!;
    expect(standard.taxClassCode).toBe('standard');
    expect(standard.taxAmount).toBe('150');
    expect(standard.netAmount).toBe('1000');
    expect(standard.grossAmount).toBe('1150');
    expect(zero.taxAmount).toBe('0');
    expect(zero.netAmount).toBe('500');
    expect(zero.grossAmount).toBe('500');

    for (const c of body.taxSummary.byClass) {
      expect(BigInt(c.netAmount) + BigInt(c.taxAmount)).toBe(
        BigInt(c.grossAmount),
      );
    }
    const sumByClass = body.taxSummary.byClass.reduce(
      (acc, c) => acc + BigInt(c.taxAmount),
      0n,
    );
    expect(sumByClass).toBe(BigInt(body.taxSummary.taxTotal));
    expect(body.taxSummary.taxTotal).toBe(body.salesSummary.taxTotal);
    expect(body.taxSummary.taxTotal).toBe('150');

    expect(JSON.stringify(body.taxSummary)).not.toContain('byRate');
  });

  it('only the completed-order population is included in tax-by-class', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const businessDay = branchBusinessDay(new Date());
    const { menuItemId, variantId } = await createMenuItemRef(
      admin,
      fx.tenantId,
    );
    const taxClassId = await createTaxClass(admin, {
      tenantId: fx.tenantId,
      code: 'std',
    });

    const openOrder = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'open',
      grandTotal: 500n,
      taxTotal: 50n,
    });
    await insertOrderLine(admin, {
      tenantId: fx.tenantId,
      orderId: openOrder,
      businessDay,
      menuItemId,
      variantId,
      taxClassId,
      taxAmount: 50n,
      lineTotal: 500n,
    });

    const body = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    expect(body.taxSummary.byClass).toHaveLength(0);
    expect(body.taxSummary.taxTotal).toBe('0');
  });

  it('voided and comped lines are excluded even on a completed order', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const businessDay = branchBusinessDay(new Date());
    const { menuItemId, variantId } = await createMenuItemRef(
      admin,
      fx.tenantId,
    );
    const taxClassId = await createTaxClass(admin, {
      tenantId: fx.tenantId,
      code: 'std',
    });

    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 600n,
      taxTotal: 60n,
    });
    await insertOrderLine(admin, {
      tenantId: fx.tenantId,
      orderId,
      businessDay,
      sequence: 1,
      menuItemId,
      variantId,
      taxClassId,
      taxAmount: 60n,
      lineTotal: 600n,
      state: 'served',
    });
    await insertOrderLine(admin, {
      tenantId: fx.tenantId,
      orderId,
      businessDay,
      sequence: 2,
      menuItemId,
      variantId,
      taxClassId,
      taxAmount: 999n,
      lineTotal: 9_999n,
      state: 'voided',
    });
    await insertOrderLine(admin, {
      tenantId: fx.tenantId,
      orderId,
      businessDay,
      sequence: 3,
      menuItemId,
      variantId,
      taxClassId,
      taxAmount: 888n,
      lineTotal: 8_888n,
      state: 'comped',
    });
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
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
      amount: 600n,
    });

    const body = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    expect(body.taxSummary.byClass).toHaveLength(1);
    expect(body.taxSummary.byClass[0].taxAmount).toBe('60');
    expect(body.taxSummary.byClass[0].lineCount).toBe(1);
  });

  it('an unresolved tax class id still succeeds, with a null label', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}d`);
    const businessDay = branchBusinessDay(new Date());
    const { menuItemId, variantId } = await createMenuItemRef(
      admin,
      fx.tenantId,
    );
    const unresolvedTaxClassId = newId(); // never persisted as a TaxClass row

    const orderId = await insertOrder(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      terminalId: fx.terminalId,
      openedBy: fx.employeeId,
      businessDay,
      orderNumber: orderNumber(),
      state: 'completed',
      grandTotal: 220n,
      taxTotal: 20n,
    });
    await insertOrderLine(admin, {
      tenantId: fx.tenantId,
      orderId,
      businessDay,
      menuItemId,
      variantId,
      taxClassId: unresolvedTaxClassId,
      taxAmount: 20n,
      lineTotal: 220n,
    });
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
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
      amount: 220n,
    });

    const body = await getReport(
      fx.tenantId,
      fx.branchId,
      businessDay,
      fx.dashboardEmail,
    );
    expect(body.taxSummary.byClass).toHaveLength(1);
    expect(body.taxSummary.byClass[0].taxClassCode).toBeNull();
    expect(body.taxSummary.byClass[0].countryPackCode).toBeNull();
    expect(body.taxSummary.byClass[0].taxAmount).toBe('20');
  });
});
