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
import { MovementsService } from './../src/modules/inventory/movements/movements.service';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1F-2 real-Postgres concurrency — the `sales-payment-concurrency.e2e-spec.ts`
 * barrier pattern (P1F-1 §19), extended to the two P1F-2-specific races
 * P1F2E-A §L "H. REQUIRED TESTS" names:
 *
 *   1. two SETTLING Payments, same Order, same version -> exactly one
 *      winner, and the winner genuinely completes the order (depletion +
 *      COGS), not just the CAS.
 *   2. two Orders, same FIFO item, overlapping physical AND cost layers ->
 *      deterministic consumption on BOTH axes, no double consumption — the
 *      `fifo-cost-ledger` kernel's `FOR UPDATE` lock, proven under a real
 *      barrier-released race rather than app-level serialization.
 *
 * Each runs 3 times (fresh fixtures per run) for the required "no sleeps,
 * >=3 clean runs" evidence. The injection seam is the SAME one P1F-1's
 * suite already established: `CASH_SESSION_FACTS_QUERY`, called early in
 * `SalesPaymentService.capture` (step 5), well before either
 * `depleteForCompletedSale`'s `lockLayers` `FOR UPDATE` (step 11b) — so
 * pausing there and releasing both together makes the SUBSEQUENT row lock
 * a genuine Postgres-level race, not an application-level one.
 */
describe('Order Completion — real Postgres concurrency (P1F-2 §H)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let movements: MovementsService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;

  const stamp = Date.now();
  const AT = new Date('2026-08-27T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-completion-race-release-key');
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
  let locationA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let priceListA: string;
  let taxClassStandard: string;
  let cashSessionA: string;
  /** Acceptance closure addition — see the race tests' own inline comments
   *  for why a SECOND, independent cash session is now required. */
  let cashSessionB: string;
  let unitKg: string;

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
    movements = app.get(MovementsService);
    paymentService = app.get(SalesPaymentService);
    packs = app.get(CountryPackService);

    await packs.activate(testPackDocument());

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `comprace-${stamp}`,
        legalName: 'CompRace',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `RaceBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `CR${stamp % 10000}`,
        name: 'Completion Race Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchA = branch.id;
    locationA = (
      await admin.location.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          locationType: 'branch',
          refId: branchA,
          branchId: branchA,
        },
      })
    ).id;

    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'CompRace-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `comp.race.${stamp}@example.com`,
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
        code: `CRE${stamp % 1000}`,
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

    priceListA = (
      await admin.priceList.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          name: 'Race pricing',
          scopeType: 'branch',
          scopeId: branchA,
          status: 'active',
        },
      })
    ).id;

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

    // Acceptance closure addition — a SECOND, fully independent drawer/shift/
    // session. See the race tests' own inline comments for why.
    const drawerB = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'Race Drawer B',
        terminalId: null,
      },
    });
    const shiftB = await admin.shift.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        employeeId: employeeA,
        status: 'open',
        openedAt: AT,
      },
    });
    cashSessionB = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          drawerId: drawerB.id,
          shiftId: shiftB.id,
          employeeId: employeeA,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;

    unitKg = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `RKG${stamp % 100000}`,
          name: 'Race Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  const mkSellable = async (name: string, price = 10_000n) => {
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
        price,
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  };

  const mkPublishedRecipe = async (
    variantId: string,
    stockItemId: string,
    quantity: string,
  ) => {
    const recipe = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        scope: 'tenant',
        recipeType: 'menu_item',
        menuItemVariantId: variantId,
      },
    });
    const version = await admin.recipeVersion.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        recipeId: recipe.id,
        version: 1,
        status: 'published',
        yieldQuantity: '1',
        yieldUnitId: unitKg,
        yieldPercentage: '100.00',
      },
    });
    await admin.recipeLine.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        recipeVersionId: version.id,
        sequence: 1,
        componentType: 'stock_item',
        stockItemId,
        quantity,
        unitId: unitKg,
        wastagePercentage: '0.00',
      },
    });
  };

  const mkOpenOrderWithLine = async (
    itemId: string,
    variantId: string,
  ): Promise<{
    id: string;
    businessDay: Date;
    grandTotal: bigint;
    version: number;
  }> => {
    const order = await orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    await lines.addLine(tenantA, userA, order.id, order.businessDay, {
      menuItemId: itemId,
      variantId,
      quantity: '1',
      expectedVersion: order.version,
    });
    const opened = await orders.transition(
      tenantA,
      userA,
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
  };

  // =========================================================== SCENARIO 1
  describe('two SETTLING Payments, same Order, same version', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: exactly one winner, and the winner genuinely completes the order`, async () => {
        const item = await mkSellable(`SettleRace-${newId()}`);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        const arrive = makeBarrier(2);
        cashSessionStub.barrier = arrive;
        try {
          const results = await Promise.allSettled([
            paymentService.capture(tenantA, userA, {
              orderId: order.id,
              businessDay: order.businessDay,
              expectedVersion: order.version,
              tender: 'cash',
              amountMinor: order.grandTotal,
              cashSessionId: cashSessionA,
              employeeId: employeeA,
              terminalId: terminalA,
              tenderedAmountMinor: order.grandTotal,
            }),
            paymentService.capture(tenantA, userA, {
              orderId: order.id,
              businessDay: order.businessDay,
              expectedVersion: order.version,
              tender: 'cash',
              amountMinor: order.grandTotal,
              // Acceptance closure correction: a SECOND, independent cash
              // session — see `sales-payment-concurrency.e2e-spec.ts`'s
              // matching comment for why racing both calls on the SAME
              // session would now deadlock against this file's own barrier
              // (P1G-1's advisory lock acquires before the barrier point).
              cashSessionId: cashSessionB,
              employeeId: employeeA,
              terminalId: terminalA,
              tenderedAmountMinor: order.grandTotal,
            }),
          ]);

          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          const rejected = results.filter((r) => r.status === 'rejected');
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);

          const afterOrder = await admin.order.findFirstOrThrow({
            where: { id: order.id },
          });
          expect(afterOrder.state).toBe('completed');
          expect(afterOrder.paidTotal).toBe(order.grandTotal); // exactly once, never doubled
          const payments = await admin.orderPayment.count({
            where: { orderId: order.id },
          });
          expect(payments).toBe(1);
          const completedAudits = await admin.auditEntry.count({
            where: {
              tenantId: tenantA,
              action: 'ORDER_COMPLETED',
              entityId: order.id,
            },
          });
          expect(completedAudits).toBe(1);
        } finally {
          cashSessionStub.barrier = null;
        }
      });
    }
  });

  // =========================================================== SCENARIO 2
  describe('two Orders, same FIFO item, overlapping physical AND cost layers', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: deterministic consumption on both axes, no double consumption`, async () => {
        const fifoItem = (
          await admin.stockItem.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              sku: `RACEFIFO${stamp % 100000}${run}${Math.floor(Math.random() * 10000)}`,
              names: { en: 'Race FIFO Item' },
              baseUnitId: unitKg,
              costingMethod: 'fifo',
              batchStrategy: 'fifo',
              isBatchTracked: true,
            },
          })
        ).id;
        // One shared layer both orders' depletions must contend for.
        const batch = await admin.stockBatch.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            stockItemId: fifoItem,
            locationId: locationA,
            quantityReceived: '10',
            quantityRemaining: '10',
            unitCost: 50n,
            createdAt: new Date('2026-08-01T08:00:00Z'),
          },
        });
        await movements.postStandalone(tenantA, userA, {
          stockItemId: fifoItem,
          locationId: locationA,
          movementType: 'purchase_receipt',
          quantity: 10,
          unitCost: 50n,
          batchId: batch.id,
          referenceType: 'goods_receipt',
          referenceId: newId(),
          occurredAt: new Date('2026-08-01T08:00:00Z'),
        });

        const itemA = await mkSellable(`RaceDualA-${newId()}`);
        await mkPublishedRecipe(itemA.variantId, fifoItem, '3');
        const itemB = await mkSellable(`RaceDualB-${newId()}`);
        await mkPublishedRecipe(itemB.variantId, fifoItem, '4');

        const orderA = await mkOpenOrderWithLine(itemA.itemId, itemA.variantId);
        const orderB = await mkOpenOrderWithLine(itemB.itemId, itemB.variantId);

        const arrive = makeBarrier(2);
        cashSessionStub.barrier = arrive;
        try {
          const results = await Promise.allSettled([
            paymentService.capture(tenantA, userA, {
              orderId: orderA.id,
              businessDay: orderA.businessDay,
              expectedVersion: orderA.version,
              tender: 'cash',
              amountMinor: orderA.grandTotal,
              cashSessionId: cashSessionA,
              employeeId: employeeA,
              terminalId: terminalA,
              tenderedAmountMinor: orderA.grandTotal,
            }),
            paymentService.capture(tenantA, userA, {
              orderId: orderB.id,
              businessDay: orderB.businessDay,
              expectedVersion: orderB.version,
              tender: 'cash',
              amountMinor: orderB.grandTotal,
              // Acceptance closure correction — see the first call's comment
              // above (same reasoning: an independent cash session avoids a
              // deadlock against this file's own barrier).
              cashSessionId: cashSessionB,
              employeeId: employeeA,
              terminalId: terminalA,
              tenderedAmountMinor: orderB.grandTotal,
            }),
          ]);

          // Both are independent orders/versions — BOTH should succeed
          // (no version collision), with the row lock only serializing
          // their access to the shared batch, never corrupting it.
          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          expect(fulfilled).toHaveLength(2);

          const freshBatch = await admin.stockBatch.findUniqueOrThrow({
            where: { id: batch.id },
          });
          // 3 + 4 = 7 consumed on BOTH axes, deterministically, exactly once each.
          expect(freshBatch.quantityRemaining.toFixed(6)).toBe('3.000000');
          expect(freshBatch.fifoCostQuantityConsumed.toFixed(6)).toBe(
            '7.000000',
          );

          const allocations = await admin.saleDepletionAllocation.findMany({
            where: { tenantId: tenantA, physicalBatchId: batch.id },
          });
          const sumAllocated = allocations.reduce(
            (s, a) => s + Number(a.quantityInBaseUnit),
            0,
          );
          expect(sumAllocated).toBe(7); // no double consumption, no loss
        } finally {
          cashSessionStub.barrier = null;
        }
      });
    }
  });
});
