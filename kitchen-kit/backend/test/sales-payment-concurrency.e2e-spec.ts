import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { CASH_SESSION_FACTS_QUERY } from './../src/modules/treasury/contract';
import type {
  CashSessionFacts,
  CashSessionFactsQuery,
  CashSessionFactsQueryInput,
} from './../src/modules/treasury/contract';
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
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1F-1 §19 — a deterministic, real two-independent-transaction proof that
 * Payment's optimistic-concurrency CAS
 * (`sales-payment.service.ts`'s `order.updateMany({..., version:
 * expectedVersion})`) is genuinely safe under concurrency — the exact same
 * pattern `sales-fire-concurrency.e2e-spec.ts` already established for
 * Fire (P1E-6A §5), applied to Payment.
 *
 * Mirrors `kitchen-ticket-concurrency.e2e-spec.ts` (P1E-5A): call the real
 * application service directly (no HTTP), open two genuinely independent
 * transactions, and synchronize them with an explicit barrier so BOTH are
 * guaranteed to have completed their own read (and derived their own
 * `nextVersion`, and independently passed their own §14 full-payment
 * safety-gate check against the SAME starting `paid_total`) before either
 * is allowed to proceed to its write — a real database-level race, not two
 * calls sharing one transaction, and not timing-dependent (no sleeps).
 *
 * ── THE SEAM ─────────────────────────────────────────────────────────────
 * `SalesPaymentService.capture()` has no test hook and none is added.
 * Instead this suite overrides `CASH_SESSION_FACTS_QUERY` — the Treasury
 * public-contract token this service already injects — with a stub that
 * awaits a test-supplied barrier before resolving. The service calls this
 * dependency strictly AFTER loading the order and computing `nextVersion`
 * from its own read, and strictly BEFORE the §14 settlement gate and the
 * CAS `updateMany` (see `sales-payment.service.ts`'s own statement order),
 * so pausing there is pausing exactly "after the read, before the write" —
 * with zero production code changes.
 *
 * ── WHY THIS ALSO PROVES THE SETTLEMENT-GATE RACE, NOT JUST LOST-UPDATE ──
 * Both participants request an amount that is individually partial against
 * the pre-race `paid_total` (0) but would together exceed `grand_total`.
 * Because neither has written before the barrier releases both, BOTH
 * independently pass their own §14 gate check (each reads `paid_total: 0`)
 * — the race is decided entirely by the CAS, not by the gate. This is
 * exactly the scenario that would silently overpay the order if the CAS
 * were not atomic.
 */
describe('Sales Payment — real Postgres concurrency (P1F-1 §19)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;

  const stamp = Date.now();
  const AT = new Date('2026-08-24T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-payment-race-release-key');
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
            { code: 'standard', rate: '14.0', label: { en: 'Standard' } },
          ],
          serviceChargeTaxable: true,
          orderTypeOverrides: [],
        },
      },
      RELEASE_KEY,
    );

  /** Releases both parties only once BOTH have arrived — a real barrier. */
  function makeBarrier(parties: number): () => Promise<void> {
    let arrived = 0;
    let release: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived === parties) release();
      await ready;
    };
  }

  /** Test-only DI seam: an existing public-contract token, made barrier-aware. */
  class BarrierAwareCashSessionFacts implements CashSessionFactsQuery {
    barrier: (() => Promise<void>) | null = null;
    async find(
      tx: Prisma.TransactionClient,
      input: CashSessionFactsQueryInput,
    ): Promise<CashSessionFacts | null> {
      if (this.barrier) await this.barrier();
      const session = await tx.cashSession.findUnique({
        where: { id: input.cashSessionId },
        select: {
          id: true,
          tenantId: true,
          branchId: true,
          employeeId: true,
          shiftId: true,
          drawerId: true,
          currency: true,
          status: true,
          drawer: { select: { terminalId: true } },
        },
      });
      if (!session) return null;
      return {
        cashSessionId: session.id,
        tenantId: session.tenantId,
        branchId: session.branchId,
        employeeId: session.employeeId,
        shiftId: session.shiftId,
        drawerId: session.drawerId,
        terminalId: session.drawer.terminalId,
        currency: session.currency,
        status: session.status,
      };
    }
  }
  const cashSessionStub = new BarrierAwareCashSessionFacts();

  let tenantA: string;
  let branchA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let priceListA: string;
  let taxClassStandard: string;
  let cashSessionA: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
      .overrideProvider(CASH_SESSION_FACTS_QUERY)
      .useValue(cashSessionStub)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    paymentService = app.get(SalesPaymentService);
    packs = app.get(CountryPackService);

    await packs.activate(testPackDocument());

    const tenants = app.get(TenantsService);
    const tenant = await tenants.create({
      slug: `payrace-${stamp}`,
      legalName: 'PayRace',
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    tenantA = tenant.id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `RaceBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `PR${stamp % 10000}`,
        name: 'Pay Race Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchA = branch.id;
    await admin.location.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        locationType: 'branch',
        refId: branchA,
        branchId: branchA,
      },
    });

    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'PayRace-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `pay.race.${stamp}@example.com`,
        displayName: 'Race',
      },
    });
    userA = user.id;
    await admin.membership.create({
      data: { id: newId(), userId: userA, tenantId: tenantA, status: 'active' },
    });

    const employee = await admin.employee.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        code: `PRE${stamp % 1000}`,
        displayName: 'Race Employee',
        homeBranchId: branchA,
        userId: userA,
      },
    });
    employeeA = employee.id;
    await admin.employeeBranch.create({
      data: { tenantId: tenantA, employeeId: employeeA, branchId: branchA },
    });

    taxClassStandard = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;

    const priceList = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: 'Race pricing',
        scopeType: 'branch',
        scopeId: branchA,
        status: 'active',
      },
    });
    priceListA = priceList.id;

    const drawer = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'Race Drawer',
        terminalId: null,
      },
    });
    const shift = await admin.shift.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        employeeId: employeeA,
        status: 'open',
        openedAt: AT,
      },
    });
    cashSessionA = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          drawerId: drawer.id,
          shiftId: shift.id,
          employeeId: employeeA,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  const mkSellable = async (name: string) => {
    const item = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: name },
        taxClassId: taxClassStandard,
      },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: item.id,
        name: { en: 'V' },
      },
    });
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        priceListId: priceListA,
        menuItemVariantId: variant.id,
        price: 2_000n, // 20.00 EGP -> ~22.80 grand total after 14% tax
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  };

  const currentVersion = async (orderId: string): Promise<number> =>
    (
      await admin.order.findFirstOrThrow({
        where: { id: orderId },
        select: { version: true },
      })
    ).version;

  it('two independent transactions racing to pay the SAME order (both individually partial, together over-settling) converge on exactly one winner', async () => {
    const item = await mkSellable(`Race-${newId()}`);
    const order = await orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    const startingVersion = await currentVersion(order.id);
    await lines.addLine(tenantA, userA, order.id, order.businessDay, {
      menuItemId: item.itemId,
      variantId: item.variantId,
      quantity: '1',
      expectedVersion: startingVersion,
    });
    const openOrder = await orders.transition(
      tenantA,
      userA,
      order.id,
      order.businessDay,
      'open',
      startingVersion + 1,
    );
    const grandTotal = openOrder.grandTotal;

    // Individually partial (< grandTotal), together they'd exceed it.
    const amountEach = (grandTotal * 6n) / 10n; // 60% each, 120% together
    const raceVersion = await currentVersion(order.id);

    const arrive = makeBarrier(2);
    cashSessionStub.barrier = arrive;
    try {
      const results = await Promise.allSettled([
        paymentService.capture(tenantA, userA, {
          orderId: order.id,
          businessDay: order.businessDay,
          expectedVersion: raceVersion,
          tender: 'cash',
          amountMinor: amountEach,
          cashSessionId: cashSessionA,
          employeeId: employeeA,
          terminalId: terminalA,
          tenderedAmountMinor: amountEach,
        }),
        paymentService.capture(tenantA, userA, {
          orderId: order.id,
          businessDay: order.businessDay,
          expectedVersion: raceVersion,
          tender: 'cash',
          amountMinor: amountEach,
          cashSessionId: cashSessionA,
          employeeId: employeeA,
          terminalId: terminalA,
          tenderedAmountMinor: amountEach,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1); // exactly one CAS winner
      expect(rejected).toHaveLength(1);
      const reason: unknown = rejected[0].reason;
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).name).toBe('OrderVersionConflictError');

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.version).toBe(raceVersion + 1); // bumped exactly once
      expect(afterOrder.paidTotal).toBe(amountEach); // incremented exactly once
      expect(afterOrder.state).toBe('partially_paid');
      // No overpayment/full-payment invalid state: the winner's own amount
      // alone must remain strictly below grandTotal.
      expect(afterOrder.paidTotal < afterOrder.grandTotal).toBe(true);

      const payments = await admin.orderPayment.findMany({
        where: { orderId: order.id },
      });
      expect(payments).toHaveLength(1); // exactly one Payment, not two

      const auditEntries = await admin.auditEntry.count({
        where: {
          tenantId: tenantA,
          entityId: payments[0].id,
          action: 'PAYMENT_CAPTURED',
        },
      });
      expect(auditEntries).toBe(1); // exactly one audit entry, not two
    } finally {
      cashSessionStub.barrier = null;
    }
  });
});
