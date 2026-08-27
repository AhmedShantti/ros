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
import { RECIPE_COST_RECOMPUTER } from './../src/modules/production/contract';
import type { RecipeCostRecomputer } from './../src/modules/production/contract';
import { RecipeCostService } from './../src/modules/production/costing/recipe-cost.service';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1F-2 acceptance closure §2 — the THREE concurrency scenarios the P1F-2
 * implementation report (`2026-08-26_P1F2_order-completion.md` §B.4) named
 * as NOT built out of the mandatory 5-scenario matrix
 * (`2026-08-25_P1F2E-A_inventory-acceptance-correction.md` (CONTROLLING)
 * §L "H. REQUIRED TESTS" / CONCURRENCY):
 *
 *   A. two Orders, same WEIGHTED-AVERAGE item -> BR-INV-003 (no lost update
 *      on the atomic `stock_levels` delta-projection, no batch locking
 *      involved at all — the missing completion-path proof).
 *   B. Completion vs an existing `MovementsService` outbound (waste) on the
 *      SAME FIFO item/location -> the shared `fifo-cost-ledger` kernel
 *      serializes both writers with a genuine cross-connection Postgres
 *      `FOR UPDATE` wait, proven via `pg_locks`, not timing.
 *   C. lock-order inversion: two Orders whose OWN recipes reference the same
 *      two stock items in OPPOSITE sequence -> both succeed, no deadlock,
 *      because `SaleDepletionService` always re-sorts by
 *      `(stockItemId ASC, orderLineId ASC)` regardless of recipe-line order.
 *
 * Each scenario runs 3 times (fresh fixtures per run) — "no sleeps as
 * correctness proof, >=3 clean runs" (P1F2E-A §L §H CONCURRENCY).
 */
describe('Order Completion — the 3 missing concurrency scenarios (P1F-2 acceptance closure §2)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let movements: MovementsService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;

  const stamp = Date.now();
  const AT = new Date('2026-08-28T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-closure-race-release-key');
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

  /** Releases both parties only once BOTH have arrived — a real mutual barrier. */
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

  /**
   * One-shot gate on `RecipeCostRecomputer.recomputeForStockItem`. Since the
   * FOR UPDATE row lock `fifo-cost-ledger.lockLayers` takes is held for the
   * WHOLE enclosing transaction, pausing here — deliberately placed AFTER
   * `MovementsService.post`'s own batch/counter mutation but BEFORE COMMIT —
   * genuinely holds the lock open while the test starts the racing
   * Completion and waits for it to arrive as a real `pg_locks` waiter.
   */
  class GatedRecomputer implements RecipeCostRecomputer {
    constructor(private readonly real: RecipeCostRecomputer) {}
    private armed = false;
    private acquiredResolve: (() => void) | null = null;
    private gate: Promise<void> | null = null;
    private releaseGateFn: (() => void) | null = null;

    arm(): Promise<void> {
      this.armed = true;
      const acquired = new Promise<void>((res) => {
        this.acquiredResolve = res;
      });
      this.gate = new Promise<void>((res) => {
        this.releaseGateFn = res;
      });
      return acquired;
    }
    release(): void {
      this.releaseGateFn?.();
    }
    async recomputeForStockItem(
      tx: Prisma.TransactionClient,
      stockItemId: string,
    ): Promise<string[]> {
      if (this.armed) {
        this.armed = false;
        this.acquiredResolve?.();
        await this.gate;
      }
      return this.real.recomputeForStockItem(tx, stockItemId);
    }
    async recomputeForStockItems(
      tx: Prisma.TransactionClient,
      stockItemIds: readonly string[],
    ): Promise<string[]> {
      return this.real.recomputeForStockItems(tx, stockItemIds);
    }
  }
  let gated: GatedRecomputer;

  /**
   * Poll until a real, distinct backend is genuinely BLOCKED waiting for a
   * row lock on `inventory.stock_batches` — never a fixed sleep used as the
   * proof itself, only as poll cadence.
   *
   * A backend waiting on a `SELECT ... FOR UPDATE` row lock shows up in
   * `pg_locks` as a `transactionid` wait (waiting on the HOLDER's XID, not a
   * `tuple`/`relation` row scoped to the table) — `pg_locks.relation` is
   * NULL for that lock type, verified empirically against this exact schema
   * (two real concurrent `psql` sessions + a third inspecting `pg_locks`)
   * before writing this helper. The unambiguous, relation-free signal is
   * `pg_stat_activity.wait_event_type = 'Lock'` on a backend whose own query
   * text names the contended table.
   */
  async function waitForRealLockContention(
    client: PrismaClient,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await client.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query ILIKE '%stock_batches%'
      `;
      if (Number(rows[0].c) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          'Timed out waiting for genuine Postgres lock contention on inventory.stock_batches.',
        );
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  let tenantA: string;
  let branchA: string;
  let locationA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let priceListA: string;
  let taxClassStandard: string;
  let cashSessionA: string;
  let unitKg: string;
  let wasteReasonId: string;

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
      // Both `MovementsService` and `SalesPaymentService` inject
      // RECIPE_COST_RECOMPUTER directly (constructor injection at module
      // init) — a wrapper built AFTER `.compile()` would never be the
      // instance either service actually holds. The override must replace
      // the DI binding itself, wrapping the real `RecipeCostService`
      // (still registered, still injectable) so both call sites reach the
      // SAME gated instance this test controls.
      .overrideProvider(RECIPE_COST_RECOMPUTER)
      .useFactory({
        factory: (real: RecipeCostService) => {
          gated = new GatedRecomputer(real);
          return gated;
        },
        inject: [RecipeCostService],
      })
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
        slug: `closerace-${stamp}`,
        legalName: 'CloseRace',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `CloseBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `CL${stamp % 10000}`,
        name: 'Closure Race Branch',
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
        name: 'Closure-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `close.race.${stamp}@example.com`,
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
        code: `CLE${stamp % 1000}`,
        displayName: 'Closure Employee',
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
          name: 'Closure pricing',
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
        name: 'Closure Drawer',
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

    unitKg = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `CLKG${stamp % 100000}`,
          name: 'Closure Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;

    wasteReasonId = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'waste',
          code: `SPOILAGE${stamp % 100000}`,
          label: { en: 'Spoilage' },
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
    componentLines: { stockItemId: string; quantity: string }[],
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
    for (const [i, l] of componentLines.entries()) {
      await admin.recipeLine.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          recipeVersionId: version.id,
          sequence: i + 1,
          componentType: 'stock_item',
          stockItemId: l.stockItemId,
          quantity: l.quantity,
          unitId: unitKg,
          wastagePercentage: '0.00',
        },
      });
    }
    return version.id;
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

  const capture = (order: {
    id: string;
    businessDay: Date;
    grandTotal: bigint;
    version: number;
  }) =>
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
    });

  // ============================================================= SCENARIO A
  describe('A. two Orders, same WEIGHTED-AVERAGE item -> BR-INV-003', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: no lost update on the atomic stock_levels delta-projection`, async () => {
        const waItem = (
          await admin.stockItem.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              sku: `WARACE${stamp % 100000}${run}${Math.floor(Math.random() * 10000)}`,
              names: { en: 'Weighted-Average Race Item' },
              baseUnitId: unitKg,
              costingMethod: 'weighted_average',
              batchStrategy: 'fifo',
              isBatchTracked: false,
            },
          })
        ).id;
        // Seed stock_levels via a real `opening_balance` movement — no batch
        // row (unlike purchase_receipt/production_output, opening_balance
        // carries no `ck_batch_required` obligation), so
        // `fifo-cost-ledger.lockLayers` finds zero rows to lock for this item
        // and the sole race-safety mechanism under test is the atomic
        // `stock_levels` delta UPSERT.
        await movements.postStandalone(tenantA, userA, {
          stockItemId: waItem,
          locationId: locationA,
          movementType: 'opening_balance',
          quantity: 100,
          unitCost: 40n,
          referenceType: 'opening_balance',
          referenceId: newId(),
          occurredAt: new Date('2026-08-01T08:00:00Z'),
        });
        const before = await admin.stockLevel.findUniqueOrThrow({
          where: {
            stockItemId_locationId: {
              stockItemId: waItem,
              locationId: locationA,
            },
          },
        });
        expect(before.averageCost).toBe(40n);

        const itemA = await mkSellable(`WaRaceA-${newId()}`);
        await mkPublishedRecipe(itemA.variantId, [
          { stockItemId: waItem, quantity: '3' },
        ]);
        const itemB = await mkSellable(`WaRaceB-${newId()}`);
        await mkPublishedRecipe(itemB.variantId, [
          { stockItemId: waItem, quantity: '4' },
        ]);

        const orderA = await mkOpenOrderWithLine(itemA.itemId, itemA.variantId);
        const orderB = await mkOpenOrderWithLine(itemB.itemId, itemB.variantId);

        const arrive = makeBarrier(2);
        cashSessionStub.barrier = arrive;
        try {
          const results = await Promise.allSettled([
            capture(orderA),
            capture(orderB),
          ]);
          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          expect(fulfilled).toHaveLength(2); // independent orders/versions -> both settle

          const level = await admin.stockLevel.findUniqueOrThrow({
            where: {
              stockItemId_locationId: {
                stockItemId: waItem,
                locationId: locationA,
              },
            },
          });
          // Outbound NEVER changes average_cost.
          expect(level.averageCost).toBe(40n);

          const movementRows = await admin.stockMovement.findMany({
            where: {
              tenantId: tenantA,
              stockItemId: waItem,
              locationId: locationA,
            },
          });
          const movementSum = movementRows.reduce(
            (s, m) => s + Number(m.quantity),
            0,
          );
          // BR-INV-003: the ledger fold equals the projection exactly.
          expect(movementSum).toBe(Number(level.quantityOnHand));
          expect(Number(level.quantityOnHand)).toBe(100 - 3 - 4);

          const outbound = movementRows.filter(
            (m) => m.movementType === 'sale_depletion',
          );
          expect(outbound).toHaveLength(2); // exactly once each, never doubled

          const allocations = await admin.saleDepletionAllocation.findMany({
            where: { tenantId: tenantA, stockItemId: waItem },
          });
          expect(allocations).toHaveLength(2);
          for (const a of allocations) {
            // The intended, unchanged weighted-average value — never a
            // mid-race value from the other order's own delta.
            expect(a.unitCost).toBe(40n);
          }
          const totalCogs = allocations.reduce((s, a) => s + a.totalCost, 0n);
          expect(totalCogs).toBe(3n * 40n + 4n * 40n);
        } finally {
          cashSessionStub.barrier = null;
        }
      });
    }
  });

  // ============================================================= SCENARIO B
  describe('B. Completion vs an existing MovementsService outbound (waste), same FIFO item/location', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: final counter state equals the serial result exactly`, async () => {
        const fifoItem = (
          await admin.stockItem.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              sku: `WASTERACE${stamp % 100000}${run}${Math.floor(Math.random() * 10000)}`,
              names: { en: 'Waste-Race FIFO Item' },
              baseUnitId: unitKg,
              costingMethod: 'fifo',
              batchStrategy: 'fifo',
              isBatchTracked: true,
            },
          })
        ).id;
        const batch = await admin.stockBatch.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            stockItemId: fifoItem,
            locationId: locationA,
            quantityReceived: '20',
            quantityRemaining: '20',
            unitCost: 60n,
            createdAt: new Date('2026-08-01T08:00:00Z'),
          },
        });
        await movements.postStandalone(tenantA, userA, {
          stockItemId: fifoItem,
          locationId: locationA,
          movementType: 'purchase_receipt',
          quantity: 20,
          unitCost: 60n,
          batchId: batch.id,
          referenceType: 'goods_receipt',
          referenceId: newId(),
          occurredAt: new Date('2026-08-01T08:00:00Z'),
        });

        const item = await mkSellable(`WasteRaceItem-${newId()}`);
        await mkPublishedRecipe(item.variantId, [
          { stockItemId: fifoItem, quantity: '5' },
        ]);
        const order = await mkOpenOrderWithLine(item.itemId, item.variantId);

        // Arm the gate BEFORE starting the waste movement so its own
        // recompute call blocks on the real gate, holding the FOR UPDATE
        // lock it acquired inside `MovementsService.post` open.
        const lockAcquired = gated.arm();
        const movementPromise = movements.postStandalone(tenantA, userA, {
          stockItemId: fifoItem,
          locationId: locationA,
          movementType: 'waste',
          quantity: -3,
          referenceType: 'waste_log',
          referenceId: newId(),
          reasonCodeId: wasteReasonId,
          occurredAt: new Date('2026-08-02T08:00:00Z'),
        });
        await lockAcquired;

        // Start the racing Completion; it must genuinely BLOCK on the same
        // row lock — proven via pg_stat_activity, never a fixed sleep.
        const completionPromise = capture(order);
        await waitForRealLockContention(admin);
        gated.release();

        const [movementResult, completionResult] = await Promise.allSettled([
          movementPromise,
          completionPromise,
        ]);
        expect(movementResult.status).toBe('fulfilled');
        expect(completionResult.status).toBe('fulfilled');

        const freshBatch = await admin.stockBatch.findUniqueOrThrow({
          where: { id: batch.id },
        });
        // Serial-equivalent truth: 20 received, 3 wasted + 5 sold = 8
        // consumed on BOTH axes, deterministically, exactly once each.
        expect(freshBatch.quantityRemaining.toFixed(6)).toBe('12.000000');
        expect(freshBatch.fifoCostQuantityConsumed.toFixed(6)).toBe('8.000000');
        // Never exceeds quantity_received (also DB-guarded by
        // ck_batch_cost_qty_range) and physical quantities stay correct.
        expect(
          Number(freshBatch.fifoCostQuantityConsumed) <=
            Number(freshBatch.quantityReceived),
        ).toBe(true);

        const saleAllocations = await admin.saleDepletionAllocation.findMany({
          where: { tenantId: tenantA, physicalBatchId: batch.id },
        });
        const saleQty = saleAllocations.reduce(
          (s, a) => s + Number(a.quantityInBaseUnit),
          0,
        );
        expect(saleQty).toBe(5); // Completion's cost basis is correct, no double count
      }, 20_000);
    }
  });

  // ============================================================= SCENARIO C
  describe('C. lock-order inversion: two Orders reference the same two stock items in opposite sequence', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: both succeed, no deadlock, deterministic final counters`, async () => {
        const itemX = (
          await admin.stockItem.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              sku: `INVX${stamp % 100000}${run}${Math.floor(Math.random() * 10000)}`,
              names: { en: 'Inversion X' },
              baseUnitId: unitKg,
              costingMethod: 'fifo',
              batchStrategy: 'fifo',
              isBatchTracked: true,
            },
          })
        ).id;
        const itemY = (
          await admin.stockItem.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              sku: `INVY${stamp % 100000}${run}${Math.floor(Math.random() * 10000)}`,
              names: { en: 'Inversion Y' },
              baseUnitId: unitKg,
              costingMethod: 'fifo',
              batchStrategy: 'fifo',
              isBatchTracked: true,
            },
          })
        ).id;
        for (const [stockItemId, unitCost] of [
          [itemX, 70n],
          [itemY, 90n],
        ] as const) {
          const batch = await admin.stockBatch.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              stockItemId,
              locationId: locationA,
              quantityReceived: '10',
              quantityRemaining: '10',
              unitCost,
              createdAt: new Date('2026-08-01T08:00:00Z'),
            },
          });
          await movements.postStandalone(tenantA, userA, {
            stockItemId,
            locationId: locationA,
            movementType: 'purchase_receipt',
            quantity: 10,
            unitCost,
            batchId: batch.id,
            referenceType: 'goods_receipt',
            referenceId: newId(),
            occurredAt: new Date('2026-08-01T08:00:00Z'),
          });
        }

        // Order A's OWN recipe references X then Y; Order B's OWN recipe
        // references Y then X — the opposite input order named by P1F2E-A
        // §L §H "5 lock-order inversion".
        const itemA = await mkSellable(`InvA-${newId()}`);
        await mkPublishedRecipe(itemA.variantId, [
          { stockItemId: itemX, quantity: '1' },
          { stockItemId: itemY, quantity: '1' },
        ]);
        const itemB = await mkSellable(`InvB-${newId()}`);
        await mkPublishedRecipe(itemB.variantId, [
          { stockItemId: itemY, quantity: '1' },
          { stockItemId: itemX, quantity: '1' },
        ]);

        const orderA = await mkOpenOrderWithLine(itemA.itemId, itemA.variantId);
        const orderB = await mkOpenOrderWithLine(itemB.itemId, itemB.variantId);

        const arrive = makeBarrier(2);
        cashSessionStub.barrier = arrive;
        try {
          const results = await Promise.allSettled([
            capture(orderA),
            capture(orderB),
          ]);
          // No deadlock: both succeed. A Postgres deadlock would show up as
          // a rejection carrying error code 40P01 on whichever loser lost
          // the deadlock-detector's victim selection.
          const rejected = results.filter((r) => r.status === 'rejected');
          if (rejected.length) {
            const reasons = rejected.map((r) =>
              r.status === 'rejected' ? String(r.reason) : '',
            );
            throw new Error(
              `Expected both completions to succeed with no deadlock; got rejection(s): ${reasons.join(' | ')}`,
            );
          }
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
            2,
          );

          const freshX = await admin.stockItem.findUniqueOrThrow({
            where: { id: itemX },
            select: {
              batches: {
                select: {
                  quantityRemaining: true,
                  fifoCostQuantityConsumed: true,
                },
              },
            },
          });
          const freshY = await admin.stockItem.findUniqueOrThrow({
            where: { id: itemY },
            select: {
              batches: {
                select: {
                  quantityRemaining: true,
                  fifoCostQuantityConsumed: true,
                },
              },
            },
          });
          // 1 unit consumed by each order -> 2 total, on BOTH axes, for BOTH items.
          expect(freshX.batches[0].quantityRemaining.toFixed(6)).toBe(
            '8.000000',
          );
          expect(freshX.batches[0].fifoCostQuantityConsumed.toFixed(6)).toBe(
            '2.000000',
          );
          expect(freshY.batches[0].quantityRemaining.toFixed(6)).toBe(
            '8.000000',
          );
          expect(freshY.batches[0].fifoCostQuantityConsumed.toFixed(6)).toBe(
            '2.000000',
          );

          const levelX = await admin.stockLevel.findUniqueOrThrow({
            where: {
              stockItemId_locationId: {
                stockItemId: itemX,
                locationId: locationA,
              },
            },
          });
          const levelY = await admin.stockLevel.findUniqueOrThrow({
            where: {
              stockItemId_locationId: {
                stockItemId: itemY,
                locationId: locationA,
              },
            },
          });
          const movementsX = await admin.stockMovement.findMany({
            where: {
              tenantId: tenantA,
              stockItemId: itemX,
              locationId: locationA,
            },
          });
          const movementsY = await admin.stockMovement.findMany({
            where: {
              tenantId: tenantA,
              stockItemId: itemY,
              locationId: locationA,
            },
          });
          expect(movementsX.reduce((s, m) => s + Number(m.quantity), 0)).toBe(
            Number(levelX.quantityOnHand),
          );
          expect(movementsY.reduce((s, m) => s + Number(m.quantity), 0)).toBe(
            Number(levelY.quantityOnHand),
          );
        } finally {
          cashSessionStub.barrier = null;
        }
      }, 20_000);
    }
  });
});
