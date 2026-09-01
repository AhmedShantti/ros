import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  COUNTRY_PACK_SIGNATURE_VERIFIER,
  COUNTRY_PACK_TRUST_STORE,
  Ed25519CountryPackSignatureVerifier,
} from './../src/modules/localisation/country-pack/country-pack.signature';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './../src/modules/localisation/country-pack/country-pack.signing.fixture';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { createMigratorClient } from './rls-admin';
import {
  branchBusinessDay,
  createCashSession,
  createReportingFixture,
  dashboardToken,
  dateStr,
  ReportingFixture,
} from './reporting-fixtures';

interface ReportBody {
  salesSummary: { grossSales: string; unsettledCapturedTotal: string };
  tenderTotals: {
    tenderGrandTotal: string;
    completedExcessCapturedTotal: string;
    cash: { roundingAdjustmentTotal: string };
    manualExternalCard: { roundingAdjustmentTotal: string };
  };
}

/**
 * Acceptance correction, 2026-08-31 — completed-overpayment reconciliation.
 *
 * P1F-2 settled the completion threshold as `paidTotal >= grandTotal`, not
 * equality (`sales-payment.service.ts`, "8. Settlement decision"), and
 * places no upper bound on a single Payment's `amountMinor` (only
 * `amountMinor > 0` is validated), tender-agnostically. A completed order's
 * `paidTotal` can therefore legitimately exceed its `grandTotal`. This file
 * reproduces that through the REAL `OrdersService`/`OrderLinesService`/
 * `SalesPaymentService` path (never a direct DB insert) and proves the
 * corrected reconciliation identity:
 *
 *   tenderGrandTotal === grossSales + unsettledCapturedTotal
 *                        + completedExcessCapturedTotal
 *
 * `completedExcessCapturedTotal` is reconciliation-only — no revenue, tax,
 * tip, discount, refund, cash-rounding, or variance disposition is
 * inferred anywhere in this file's assertions.
 */
describe('Reporting — Completed overpayment reconciliation (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const AT = new Date();
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-reporting-overpayment-key');
  const TRUST = trustStoreFor(RELEASE_KEY.trusted());
  const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);
  const testPackDocument = () =>
    signPackDocument(
      {
        code: 'EG',
        version: PACK,
        effectiveFrom: '2026-01-01',
        currency: {
          code: 'EGP',
          exponent: 2,
          cashRounding: { enabled: false },
        },
        tax: {
          engine: 'vat_standard',
          pricingMode: 'tax_exclusive',
          computationLevel: 'line',
          roundingMode: 'HALF_UP',
          roundingPrecision: 2,
          classes: [
            { code: 'standard', rate: '0.0', label: { en: 'Standard' } },
          ],
          serviceChargeTaxable: true,
          orderTypeOverrides: [],
        },
      },
      RELEASE_KEY,
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    paymentService = app.get(SalesPaymentService);
    packs = app.get(CountryPackService);

    // Activated BEFORE any tenant is created so each fixture tenant's tax
    // classes are auto-provisioned for 'EG' (the `cash-movements-close-and-
    // payment-concurrency.e2e-spec.ts` precedent).
    await packs.activate(testPackDocument());
  }, 30_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // Cached per fixture (keyed by tenantId): `ex_price_list_no_overlap`
  // rejects a second branch-scoped active price list for the same branch,
  // so every `mkSellable` call for one fixture reuses the same list.
  const priceListByTenant = new Map<string, string>();

  async function priceListFor(fx: ReportingFixture): Promise<string> {
    const existing = priceListByTenant.get(fx.tenantId);
    if (existing) return existing;
    const priceList = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId: fx.tenantId,
        name: `Overpayment pricing ${fx.tenantId}`,
        scopeType: 'branch',
        scopeId: fx.branchId,
        status: 'active',
      },
    });
    priceListByTenant.set(fx.tenantId, priceList.id);
    return priceList.id;
  }

  async function mkSellable(
    fx: ReportingFixture,
    name: string,
    price: bigint,
  ): Promise<{ itemId: string; variantId: string }> {
    const taxClass = await admin.taxClass.findFirstOrThrow({
      where: { tenantId: fx.tenantId, countryPackCode: 'EG', code: 'standard' },
    });
    const priceListId = await priceListFor(fx);
    const item = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: fx.tenantId,
        names: { en: name },
        taxClassId: taxClass.id,
      },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: fx.tenantId,
        menuItemId: item.id,
        name: { en: 'V' },
      },
    });
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: fx.tenantId,
        priceListId,
        menuItemVariantId: variant.id,
        price,
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  }

  /** No recipe attached -> zero depletion, no inventory fixture needed. */
  async function mkOpenOrder(
    fx: ReportingFixture,
    itemId: string,
    variantId: string,
  ): Promise<{
    id: string;
    businessDay: Date;
    grandTotal: bigint;
    version: number;
  }> {
    const order = await orders.create(fx.tenantId, fx.employeeUserId, {
      terminalId: fx.terminalId,
      openedByEmployeeId: fx.employeeId,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `overpay-${newId()}`,
      at: AT,
    });
    await lines.addLine(
      fx.tenantId,
      fx.employeeUserId,
      order.id,
      order.businessDay,
      {
        menuItemId: itemId,
        variantId,
        quantity: '1',
        expectedVersion: order.version,
      },
    );
    const opened = await orders.transition(
      fx.tenantId,
      fx.employeeUserId,
      order.id,
      order.businessDay,
      'open',
      order.version + 1,
    );
    return {
      id: opened.id,
      businessDay: opened.businessDay,
      grandTotal: opened.grandTotal,
      version: opened.version,
    };
  }

  async function getReport(
    fx: ReportingFixture,
    businessDay: Date,
  ): Promise<ReportBody> {
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(
        `/reports/branches/${fx.branchId}/daily-trading/${dateStr(businessDay)}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body as ReportBody;
  }

  it('CASE A (control): cash over-tender with change given is NOT an overpayment — completedExcessCapturedTotal is 0', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}a`);
    const businessDay = branchBusinessDay(AT);
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const { itemId, variantId } = await mkSellable(fx, `A-${newId()}`, 90n);
    const order = await mkOpenOrder(fx, itemId, variantId);
    expect(order.grandTotal).toBe(90n);

    await paymentService.capture(fx.tenantId, fx.employeeUserId, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: order.version,
      tender: 'cash',
      amountMinor: 90n,
      cashSessionId,
      employeeId: fx.employeeId,
      terminalId: fx.terminalId,
      tenderedAmountMinor: 100n, // customer hands over 100 for a 90 bill
    });

    const body = await getReport(fx, businessDay);
    expect(body.salesSummary.grossSales).toBe('90');
    expect(body.tenderTotals.completedExcessCapturedTotal).toBe('0');
  });

  it('CASE B: a completed CASH order with paidTotal > grandTotal reports the excess, reconciliation-only', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}b`);
    const businessDay = branchBusinessDay(AT);
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const { itemId, variantId } = await mkSellable(fx, `B-${newId()}`, 100n);
    const order = await mkOpenOrder(fx, itemId, variantId);
    expect(order.grandTotal).toBe(100n);

    const result = await paymentService.capture(
      fx.tenantId,
      fx.employeeUserId,
      {
        orderId: order.id,
        businessDay: order.businessDay,
        expectedVersion: order.version,
        tender: 'cash',
        amountMinor: 120n, // genuine overpayment: settles 100, captures 20 more
        cashSessionId,
        employeeId: fx.employeeId,
        terminalId: fx.terminalId,
        tenderedAmountMinor: 120n, // no over-tender confusion: no change given
      },
    );
    expect(result.order.state).toBe('completed');
    expect(result.order.paidTotal).toBe(120n);

    const body = await getReport(fx, businessDay);
    expect(body.salesSummary.grossSales).toBe('100');
    expect(body.tenderTotals.tenderGrandTotal).toBe('120');
    expect(body.tenderTotals.completedExcessCapturedTotal).toBe('20');
    expect(body.salesSummary.unsettledCapturedTotal).toBe('0');
    expect(
      BigInt(body.tenderTotals.tenderGrandTotal) ===
        BigInt(body.salesSummary.grossSales) +
          BigInt(body.salesSummary.unsettledCapturedTotal) +
          BigInt(body.tenderTotals.completedExcessCapturedTotal),
    ).toBe(true);
  });

  it('CASE C: a completed MANUAL_EXTERNAL_CARD order with paidTotal > grandTotal reports the excess identically (tender-agnostic)', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}c`);
    const businessDay = branchBusinessDay(AT);
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const { itemId, variantId } = await mkSellable(fx, `C-${newId()}`, 100n);
    const order = await mkOpenOrder(fx, itemId, variantId);

    const result = await paymentService.capture(
      fx.tenantId,
      fx.employeeUserId,
      {
        orderId: order.id,
        businessDay: order.businessDay,
        expectedVersion: order.version,
        tender: 'manual_external_card',
        amountMinor: 130n,
        cashSessionId,
        employeeId: fx.employeeId,
        terminalId: fx.terminalId,
        terminalReference: `manual-ref-${newId()}`,
      },
    );
    expect(result.order.state).toBe('completed');

    const body = await getReport(fx, businessDay);
    expect(body.tenderTotals.completedExcessCapturedTotal).toBe('30');
    // Card rounding remains zero regardless of the overpayment.
    expect(body.tenderTotals.manualExternalCard.roundingAdjustmentTotal).toBe(
      '0',
    );
  });

  it('CASE D: partial payment then a final overpaying settlement -> excess is the sum beyond grandTotal', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}d`);
    const businessDay = branchBusinessDay(AT);
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });
    const { itemId, variantId } = await mkSellable(fx, `D-${newId()}`, 100n);
    const order = await mkOpenOrder(fx, itemId, variantId);

    const first = await paymentService.capture(fx.tenantId, fx.employeeUserId, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: order.version,
      tender: 'cash',
      amountMinor: 40n,
      cashSessionId,
      employeeId: fx.employeeId,
      terminalId: fx.terminalId,
      tenderedAmountMinor: 40n,
    });
    expect(first.order.state).toBe('partially_paid');

    const final = await paymentService.capture(fx.tenantId, fx.employeeUserId, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: first.order.version,
      tender: 'cash',
      amountMinor: 70n,
      cashSessionId,
      employeeId: fx.employeeId,
      terminalId: fx.terminalId,
      tenderedAmountMinor: 70n,
    });
    expect(final.order.state).toBe('completed');
    expect(final.order.paidTotal).toBe(110n);

    const body = await getReport(fx, businessDay);
    expect(body.tenderTotals.completedExcessCapturedTotal).toBe('10');
    expect(body.salesSummary.unsettledCapturedTotal).toBe('0');
  });

  it('CASE E: a mixed day (exact-settlement + overpaid completed + partially_paid) satisfies the full corrected identity', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}e`);
    const businessDay = branchBusinessDay(AT);
    const cashSessionId = await createCashSession(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      employeeId: fx.employeeId,
    });

    // Exact settlement.
    const exactItem = await mkSellable(fx, `E-exact-${newId()}`, 50n);
    const exactOrder = await mkOpenOrder(
      fx,
      exactItem.itemId,
      exactItem.variantId,
    );
    await paymentService.capture(fx.tenantId, fx.employeeUserId, {
      orderId: exactOrder.id,
      businessDay: exactOrder.businessDay,
      expectedVersion: exactOrder.version,
      tender: 'cash',
      amountMinor: 50n,
      cashSessionId,
      employeeId: fx.employeeId,
      terminalId: fx.terminalId,
      tenderedAmountMinor: 50n,
    });

    // Overpaid completed order.
    const overItem = await mkSellable(fx, `E-over-${newId()}`, 80n);
    const overOrder = await mkOpenOrder(
      fx,
      overItem.itemId,
      overItem.variantId,
    );
    await paymentService.capture(fx.tenantId, fx.employeeUserId, {
      orderId: overOrder.id,
      businessDay: overOrder.businessDay,
      expectedVersion: overOrder.version,
      tender: 'manual_external_card',
      amountMinor: 95n, // 15 excess
      cashSessionId,
      employeeId: fx.employeeId,
      terminalId: fx.terminalId,
      terminalReference: `manual-ref-${newId()}`,
    });

    // Partially paid order — excluded from grossSales, captured in
    // unsettledCapturedTotal, not in completedExcessCapturedTotal.
    const partialItem = await mkSellable(fx, `E-partial-${newId()}`, 60n);
    const partialOrder = await mkOpenOrder(
      fx,
      partialItem.itemId,
      partialItem.variantId,
    );
    const partial = await paymentService.capture(
      fx.tenantId,
      fx.employeeUserId,
      {
        orderId: partialOrder.id,
        businessDay: partialOrder.businessDay,
        expectedVersion: partialOrder.version,
        tender: 'cash',
        amountMinor: 25n,
        cashSessionId,
        employeeId: fx.employeeId,
        terminalId: fx.terminalId,
        tenderedAmountMinor: 25n,
      },
    );
    expect(partial.order.state).toBe('partially_paid');

    const body = await getReport(fx, businessDay);
    expect(body.salesSummary.grossSales).toBe('130'); // 50 + 80
    expect(body.salesSummary.unsettledCapturedTotal).toBe('25');
    expect(body.tenderTotals.completedExcessCapturedTotal).toBe('15');
    expect(body.tenderTotals.tenderGrandTotal).toBe('170'); // 50 + 95 + 25
    expect(
      BigInt(body.tenderTotals.tenderGrandTotal) ===
        BigInt(body.salesSummary.grossSales) +
          BigInt(body.salesSummary.unsettledCapturedTotal) +
          BigInt(body.tenderTotals.completedExcessCapturedTotal),
    ).toBe(true);
  });
});
