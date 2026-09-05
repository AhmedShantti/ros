import { Injectable, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
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
import { CountsService } from './../src/modules/inventory/counts/counts.service';
import { MovementsService } from './../src/modules/inventory/movements/movements.service';
import { TransfersService } from './../src/modules/inventory/movements/transfers.service';
import { WasteService } from './../src/modules/inventory/waste/waste.service';
import { ReconciliationService } from './../src/modules/inventory/reconciliation/reconciliation.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { PrismaService, AuthScope } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * A1-4 — Inventory concurrency matrix closure.
 *
 * Authority: full-srs-4day A1-4 task order §0-§26; docs/reports/claude/
 * full-srs-4day/2026-09-03_A1-4_inventory-concurrency-closure.md is the
 * non-authoritative evidence report for this suite. The SRS and ratified
 * governance decisions remain authoritative; this file and that report are
 * evidence only.
 *
 * Barrier: `BarrierPrismaService` overrides `PrismaService.withAuthContext`
 * — the ONE choke point every write path in this suite passes through
 * exactly once (`MovementsService.postStandalone`, `TransfersService.
 * dispatch/receive`, `WasteService.record`, `CountsService.open/recordCount/
 * post`, and — via `UnitOfWork.execute`, which itself calls `prisma.
 * withAuthContext` — `SalesPaymentService.capture`). Pausing there and
 * releasing both parties together forces a genuine two-transaction
 * PostgreSQL race, never `Promise.all` timing luck or a `sleep()`. Pattern
 * copied verbatim from `movements-concurrency.e2e-spec.ts` / `order-
 * completion-concurrency.e2e-spec.ts`.
 *
 * ONE shared Nest app bootstrap for the whole matrix (§21) — no per-describe
 * duplicate bootstraps.
 */
@Injectable()
class BarrierPrismaService extends PrismaService {
  static barrier: (() => Promise<void>) | null = null;

  override async withAuthContext<T>(
    scope: AuthScope,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    const barrier = BarrierPrismaService.barrier;
    if (!barrier) {
      return super.withAuthContext(scope, fn, options);
    }
    return super.withAuthContext(
      scope,
      async (tx) => {
        await barrier();
        return fn(tx);
      },
      options,
    );
  }
}

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

const RELEASE_KEY = generateReleaseKey('e2e-inv-race-release-key');
const TRUST = trustStoreFor(RELEASE_KEY.trusted());
const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);
const testPackDocument = () =>
  signPackDocument(
    {
      code: 'EG',
      version: '2026.1',
      effectiveFrom: '2026-01-01',
      currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
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

describe('Inventory concurrency matrix (A1-4)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let movements: MovementsService;
  let transfers: TransfersService;
  let waste: WasteService;
  let counts: CountsService;
  let reconciliation: ReconciliationService;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;

  const stamp = Date.now().toString(36);
  const AT = new Date('2026-08-27T09:00:00.000Z');

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
  let reasonA: string;
  let itemCounter = 0;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useClass(BarrierPrismaService)
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    movements = app.get(MovementsService);
    transfers = app.get(TransfersService);
    waste = app.get(WasteService);
    counts = app.get(CountsService);
    reconciliation = app.get(ReconciliationService);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    paymentService = app.get(SalesPaymentService);
    packs = app.get(CountryPackService);

    await packs.activate(testPackDocument());

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `invrace-${stamp}`,
        legalName: 'InvRace',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `InvRaceBrand-${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `IR${stamp}`.slice(0, 16),
        name: 'InvRace Branch',
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
        name: 'InvRace-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `invrace.${stamp}@example.com`,
        displayName: 'InvRace',
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
        code: `IRE${stamp}`.slice(0, 16),
        displayName: 'InvRace Employee',
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
          name: 'InvRace pricing',
          scopeType: 'branch',
          scopeId: branchA,
          status: 'active',
        },
      })
    ).id;

    const drawerA = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'InvRace Drawer A',
        terminalId: null,
      },
    });
    const shiftA = await admin.shift.create({
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
          drawerId: drawerA.id,
          shiftId: shiftA.id,
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
          code: `RKG-${stamp}`,
          name: 'InvRace Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;

    reasonA = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'waste',
          code: `waste-${stamp}`,
          label: { en: 'Waste' },
        },
      })
    ).id;
  }, 30_000);

  afterEach(() => {
    BarrierPrismaService.barrier = null;
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------ fixtures --

  const mkStockItem = async (opts: {
    costingMethod: 'weighted_average' | 'fifo';
    isBatchTracked: boolean;
  }): Promise<string> => {
    itemCounter += 1;
    const item = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        sku: `INV-${stamp}-${itemCounter}`,
        names: { en: `InvRace item ${itemCounter}` },
        baseUnitId: unitKg,
        costingMethod: opts.costingMethod,
        batchStrategy: 'fifo',
        isBatchTracked: opts.isBatchTracked,
      },
    });
    return item.id;
  };

  // `ck_batch_required` (inventory_foundation migration) makes `batch_id`
  // mandatory for `purchase_receipt`/`production_output` UNCONDITIONALLY —
  // even on a non-batch-tracked item. `opening_balance` carries no such
  // obligation (same precedent as `order-completion-concurrency-2.e2e-
  // spec.ts` scenario A), so use it whenever no real batch is supplied.
  const receive = (
    stockItemId: string,
    quantity: string,
    unitCost: bigint,
    occurredAt: Date,
    batchId?: string,
  ) =>
    movements.postStandalone(tenantA, userA, {
      stockItemId,
      locationId: locationA,
      movementType: batchId ? 'purchase_receipt' : 'opening_balance',
      quantity,
      unitCost,
      batchId,
      referenceType: batchId ? 'goods_receipt' : 'opening_balance',
      referenceId: newId(),
      occurredAt,
    });

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

  const mkOpenOrderWithLine = async (itemId: string, variantId: string) => {
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

  /** Depletes `qty` of `stockItemId` via a REAL Completion (sale). */
  const sellOneUnitOf = async (
    stockItemId: string,
    qty: string,
    cashSessionId: string,
  ) => {
    const sellable = await mkSellable(`Race-${newId()}`);
    await mkPublishedRecipe(sellable.variantId, stockItemId, qty);
    const order = await mkOpenOrderWithLine(
      sellable.itemId,
      sellable.variantId,
    );
    return paymentService.capture(tenantA, userA, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: order.version,
      tender: 'cash',
      amountMinor: order.grandTotal,
      cashSessionId,
      employeeId: employeeA,
      terminalId: terminalA,
      tenderedAmountMinor: order.grandTotal,
    });
  };

  /**
   * BR-INV-003 exact fold — `Prisma.Decimal` only (never `Number()`/
   * `parseFloat()`), reused for every race's ledger==projection assertion.
   */
  const exactFold = async (stockItemId: string): Promise<Prisma.Decimal> => {
    const rows = await admin.stockMovement.findMany({
      where: { stockItemId, locationId: locationA },
      select: { quantity: true },
    });
    return rows.reduce((sum, r) => sum.plus(r.quantity), new Prisma.Decimal(0));
  };

  const levelRow = (stockItemId: string) =>
    admin.stockLevel.findUniqueOrThrow({
      where: { stockItemId_locationId: { stockItemId, locationId: locationA } },
    });

  /**
   * BR-INV-003, §12: fold == projection, AND every `balanceAfter` is
   * truthful — reflects a genuine running fold up to that point, under ONE
   * valid serial order — not merely the final quantity.
   *
   * Deliberately does NOT sort by `occurredAt`: a racing pair's own
   * `occurredAt` is either caller-assigned (the weighted-average race
   * fixtures use fixed historical timestamps to make the EXPECTED value
   * order-independent — see `raceReceipts`) or captured before either side
   * blocks on the real row lock (`MovementsService.post`) — neither is a
   * promise about which side's transaction actually committed first. The
   * true, commit-consistent application order is instead RECONSTRUCTED by
   * greedily matching each remaining movement's own recorded
   * `balance_after` against `running + quantity` — this is exactly what
   * "reflects one valid serial order" (§5/§8/§21F) means, and it is
   * insensitive to which side of any given race actually won.
   */
  const assertLedgerTruthful = async (stockItemId: string) => {
    const fold = await exactFold(stockItemId);
    const level = await levelRow(stockItemId);
    expect(fold.equals(level.quantityOnHand)).toBe(true);

    const remaining = await admin.stockMovement.findMany({
      where: { stockItemId, locationId: locationA },
      select: { quantity: true, balanceAfter: true },
    });
    let running = new Prisma.Decimal(0);
    const total = remaining.length;
    for (let step = 0; step < total; step++) {
      const idx = remaining.findIndex((r) =>
        r.balanceAfter.equals(running.plus(r.quantity)),
      );
      expect(idx).toBeGreaterThanOrEqual(0); // some movement must genuinely continue the fold
      running = running.plus(remaining[idx].quantity);
      remaining.splice(idx, 1);
    }
    expect(running.equals(level.quantityOnHand)).toBe(true);

    const reconciled = await reconciliation.reconcile(tenantA);
    expect(
      reconciled.divergences.find((d) => d.stockItemId === stockItemId),
    ).toBeUndefined();
  };

  // ===================================================== §5 TRANSFER vs SALE
  describe('transfer-out vs concurrent sale depletion (FIFO/batch-tracked)', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: no lost stock, no double batch consumption, no deadlock`, async () => {
        const itemId = await mkStockItem({
          costingMethod: 'fifo',
          isBatchTracked: true,
        });
        const batch = await admin.stockBatch.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            stockItemId: itemId,
            locationId: locationA,
            quantityReceived: '20',
            quantityRemaining: '20',
            unitCost: 100n,
            createdAt: new Date('2026-08-01T08:00:00Z'),
          },
        });
        await receive(
          itemId,
          '20',
          100n,
          new Date('2026-08-01T08:00:00Z'),
          batch.id,
        );

        // A second, DISTINCT location under the SAME tenant: `(tenant_id,
        // location_type, ref_id)` is unique, and locationA already owns
        // `('branch', branchA)`, so a real warehouse row is the simplest
        // legal second target (same precedent as `order-completion-
        // structural.e2e-spec.ts`).
        const warehouse = await admin.warehouse.create({
          data: { id: newId(), tenantId: tenantA, name: `XferWh-${newId()}` },
        });
        const otherLocation = await admin.location.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            locationType: 'warehouse',
            refId: warehouse.id,
            warehouseId: warehouse.id,
          },
        });

        const sellable = await mkSellable(`XferRace-${newId()}`);
        await mkPublishedRecipe(sellable.variantId, itemId, '3');
        const order = await mkOpenOrderWithLine(
          sellable.itemId,
          sellable.variantId,
        );

        const arrive = makeBarrier(2);
        BarrierPrismaService.barrier = arrive;
        const results = await Promise.allSettled([
          transfers.dispatch(tenantA, userA, {
            stockItemId: itemId,
            fromLocationId: locationA,
            toLocationId: otherLocation.id,
            quantity: '5',
          }),
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
        ]);
        BarrierPrismaService.barrier = null;

        // No deadlock: BOTH single-key writers on the same item succeed.
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

        const freshBatch = await admin.stockBatch.findUniqueOrThrow({
          where: { id: batch.id },
        });
        expect(freshBatch.quantityRemaining.toFixed(6)).toBe('12.000000');
        expect(freshBatch.fifoCostQuantityConsumed.toFixed(6)).toBe('8.000000');

        const level = await levelRow(itemId);
        expect(level.quantityOnHand.toFixed(6)).toBe('12.000000');
        await assertLedgerTruthful(itemId);

        // Transfer pairing/provenance unchanged.
        const dispatchMv = await admin.stockMovement.findFirstOrThrow({
          where: { stockItemId: itemId, movementType: 'transfer_out' },
        });
        expect(dispatchMv.referenceType).toBe('transfer');
        expect(dispatchMv.quantity.toFixed(6)).toBe('-5.000000');

        // Sale allocation provenance unchanged.
        const allocations = await admin.saleDepletionAllocation.findMany({
          where: { tenantId: tenantA, physicalBatchId: batch.id },
        });
        const sumAllocated = allocations.reduce(
          (s, a) => s.plus(a.quantityInBaseUnit),
          new Prisma.Decimal(0),
        );
        expect(sumAllocated.toFixed(6)).toBe('3.000000');
      });
    }
  });

  // ======================================================= §6 WASTE vs SALE
  describe('waste vs concurrent sale depletion (weighted-average, non-batch)', () => {
    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: exact serial-equivalent stock, no lost update, no deadlock`, async () => {
        const itemId = await mkStockItem({
          costingMethod: 'weighted_average',
          isBatchTracked: false,
        });
        await receive(itemId, '50', 200n, new Date('2026-08-01T08:00:00Z'));

        const sellable = await mkSellable(`WasteRace-${newId()}`);
        await mkPublishedRecipe(sellable.variantId, itemId, '4');
        const order = await mkOpenOrderWithLine(
          sellable.itemId,
          sellable.variantId,
        );

        const arrive = makeBarrier(2);
        BarrierPrismaService.barrier = arrive;
        const results = await Promise.allSettled([
          waste.record(tenantA, userA, {
            locationId: locationA,
            reasonCodeId: reasonA,
            lines: [{ stockItemId: itemId, quantity: '6' }],
          }),
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
        ]);
        BarrierPrismaService.barrier = null;

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

        const level = await levelRow(itemId);
        expect(level.quantityOnHand.toFixed(6)).toBe('40.000000'); // 50-6-4
        await assertLedgerTruthful(itemId);

        const wasteMv = await admin.stockMovement.count({
          where: { stockItemId: itemId, movementType: 'waste' },
        });
        expect(wasteMv).toBe(1); // retained exactly once
        const saleMv = await admin.stockMovement.count({
          where: { stockItemId: itemId, movementType: 'sale_depletion' },
        });
        expect(saleMv).toBe(1); // retained exactly once
      });
    }
  });

  // =============================================== §7 CT-08 COUNT vs SALE
  describe('CT-08 — stock count during active trading', () => {
    it('a concurrent sale during the count window is NOT reported as variance (genuine variance is zero)', async () => {
      const itemId = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      await receive(itemId, '100', 150n, new Date('2026-08-01T08:00:00Z'));

      // T1 — open: expected quantity frozen at 100. `isBlindCount: false` so
      // the frozen value is actually visible below — `open()` defaults to a
      // BLIND count (FR-INV-042), which `lines()` hides while in progress.
      const session = await counts.open(tenantA, userA, {
        locationId: locationA,
        scopeType: 'item_list',
        itemIds: [itemId],
        isBlindCount: false,
      });
      const openedLines = await counts.lines(tenantA, session.id);
      // `Prisma.Decimal#toString()` trims trailing zeros (pre-existing,
      // unrelated to A1-4) — compare numerically, not by exact string.
      expect(
        new Prisma.Decimal(openedLines[0].expectedQuantity!).equals(100),
      ).toBe(true);

      // T2 — a REAL concurrent sale commits during the count window,
      // depleting 10 units. Physical stock is now 90 — exactly what a
      // counter walking the shelf AFTER the sale would find.
      await sellOneUnitOf(itemId, '10', cashSessionA);

      // T3 — the counter finds 90 (the sale already happened; there is NO
      // genuine shrinkage) and posts.
      await counts.recordCount(tenantA, userA, openedLines[0].id, '90');
      const posted = await counts.post(tenantA, userA, session.id);

      // The genuine variance is ZERO — the sale must not appear as false
      // shrinkage (FR-INV-044 / CT-08 pass condition).
      expect(posted.adjustments).toHaveLength(0);
      const adjustmentMv = await admin.stockMovement.count({
        where: { stockItemId: itemId, movementType: 'count_adjustment' },
      });
      expect(adjustmentMv).toBe(0);

      const level = await levelRow(itemId);
      expect(level.quantityOnHand.toFixed(6)).toBe('90.000000');
      await assertLedgerTruthful(itemId);
    });

    it('genuine shrinkage during a count window is isolated from a concurrent sale', async () => {
      const itemId = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      await receive(itemId, '100', 150n, new Date('2026-08-01T08:00:00Z'));

      const session = await counts.open(tenantA, userA, {
        locationId: locationA,
        scopeType: 'item_list',
        itemIds: [itemId],
      });
      const openedLines = await counts.lines(tenantA, session.id);

      await sellOneUnitOf(itemId, '10', cashSessionA); // expected_at_post = 90

      // Counter finds 85 — 5 units of REAL shrinkage beyond the sale.
      await counts.recordCount(tenantA, userA, openedLines[0].id, '85');
      const posted = await counts.post(tenantA, userA, session.id);

      expect(posted.adjustments).toEqual([
        { stockItemId: itemId, variance: -5 },
      ]);
      const adjustmentMv = await admin.stockMovement.findFirstOrThrow({
        where: { stockItemId: itemId, movementType: 'count_adjustment' },
      });
      expect(adjustmentMv.quantity.toFixed(6)).toBe('-5.000000'); // not -15

      const level = await levelRow(itemId);
      expect(level.quantityOnHand.toFixed(6)).toBe('85.000000');
      await assertLedgerTruthful(itemId);
    });
  });

  // ============================================ §8-10 WEIGHTED-AVERAGE RACE
  describe('two concurrent weighted-average receipts', () => {
    /**
     * Runs two receipts through the SAME real-Postgres barrier and asserts
     * the final (quantity, average_cost) against the values BOTH valid
     * serial orders converge to (chosen so both orders round to the SAME
     * final average — see the report's arithmetic appendix — so the
     * assertion is unambiguous regardless of which order PostgreSQL's lock
     * actually grants).
     */
    const raceReceipts = async (
      itemId: string,
      r1: { qty: string; cost: bigint },
      r2: { qty: string; cost: bigint },
      expectedQty: string,
      expectedAvg: bigint,
    ) => {
      const arrive = makeBarrier(2);
      BarrierPrismaService.barrier = arrive;
      const results = await Promise.allSettled([
        receive(itemId, r1.qty, r1.cost, new Date('2026-08-01T09:00:00Z')),
        receive(itemId, r2.qty, r2.cost, new Date('2026-08-01T09:00:01Z')),
      ]);
      BarrierPrismaService.barrier = null;
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

      const level = await levelRow(itemId);
      expect(level.quantityOnHand.toFixed(6)).toBe(expectedQty);
      expect(level.averageCost).toBe(expectedAvg);
      await assertLedgerTruthful(itemId);
    };

    for (let run = 1; run <= 3; run++) {
      it(`run ${run}/3: existing non-zero quantity — no lost average-cost update`, async () => {
        const itemId = await mkStockItem({
          costingMethod: 'weighted_average',
          isBatchTracked: false,
        });
        await receive(itemId, '10', 100n, new Date('2026-08-01T08:00:00Z'));
        // total_value = 10*100 + 5*200 + 3*300 = 2900; final_qty = 18;
        // final_avg = round(2900/18) = 161 — identical for either serial
        // order (see report appendix).
        await raceReceipts(
          itemId,
          { qty: '5', cost: 200n },
          { qty: '3', cost: 300n },
          '18.000000',
          161n,
        );
      });
    }

    it('first receipt — concurrent creation of a never-before-seen (item, location) row', async () => {
      const itemId = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      // No prior movement at all — `stock_levels` row does not exist yet.
      // final_qty = 8; final_avg = round(1900/8) = 238 for either order.
      await raceReceipts(
        itemId,
        { qty: '5', cost: 200n },
        { qty: '3', cost: 300n },
        '8.000000',
        238n,
      );
    });

    it('existing row at zero quantity (stale non-zero average) — no divide-by-zero, correct blend', async () => {
      const itemId = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      await receive(itemId, '10', 500n, new Date('2026-08-01T08:00:00Z'));
      // Bring quantity back to exactly zero; outbound never rewrites
      // average_cost (pre-existing, unchanged), so the row now holds
      // qty=0, average_cost=500 (stale) — the exact edge case §10 requires.
      await movements.postStandalone(tenantA, userA, {
        stockItemId: itemId,
        locationId: locationA,
        movementType: 'manual_adjustment',
        quantity: '-10',
        referenceType: 'test',
        referenceId: newId(),
        reasonCodeId: reasonA,
        occurredAt: new Date('2026-08-01T08:30:00Z'),
      });
      const zeroed = await levelRow(itemId);
      expect(zeroed.quantityOnHand.toFixed(6)).toBe('0.000000');
      expect(zeroed.averageCost).toBe(500n);

      // final_qty = 10; final_avg = round(1600/10) = 160 for either order
      // (existing_value is 0 regardless of the stale average, since
      // existing_qty = 0 — see report appendix).
      await raceReceipts(
        itemId,
        { qty: '4', cost: 100n },
        { qty: '6', cost: 200n },
        '10.000000',
        160n,
      );
    });

    it('6dp receipt quantities — exact decimal, no drift', async () => {
      const itemId = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      // final_qty = 10; final_avg = round(7000/10) = 700 for either order.
      await raceReceipts(
        itemId,
        { qty: '2.500000', cost: 400n },
        { qty: '7.500000', cost: 800n },
        '10.000000',
        700n,
      );
    });
  });

  // ================================================= §11 DEADLOCK MATRIX
  describe('lock-order / deadlock matrix', () => {
    it('Completion vs receipt (transfer_in-shaped inbound) on the same item: no deadlock, both correct', async () => {
      const itemId = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      await receive(itemId, '30', 100n, new Date('2026-08-01T08:00:00Z'));

      const sellable = await mkSellable(`RcvRace-${newId()}`);
      await mkPublishedRecipe(sellable.variantId, itemId, '5');
      const order = await mkOpenOrderWithLine(
        sellable.itemId,
        sellable.variantId,
      );

      const arrive = makeBarrier(2);
      BarrierPrismaService.barrier = arrive;
      const results = await Promise.allSettled([
        receive(itemId, '12', 400n, new Date('2026-08-01T10:00:00Z')),
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
      ]);
      BarrierPrismaService.barrier = null;

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const level = await levelRow(itemId);
      expect(level.quantityOnHand.toFixed(6)).toBe('37.000000'); // 30+12-5
      await assertLedgerTruthful(itemId);
    });

    it('Completion vs count posting on the same item: no deadlock', async () => {
      const itemId = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      await receive(itemId, '40', 100n, new Date('2026-08-01T08:00:00Z'));

      const session = await counts.open(tenantA, userA, {
        locationId: locationA,
        scopeType: 'item_list',
        itemIds: [itemId],
      });
      const openedLines = await counts.lines(tenantA, session.id);
      await counts.recordCount(tenantA, userA, openedLines[0].id, '33');

      const sellable = await mkSellable(`CountRace-${newId()}`);
      await mkPublishedRecipe(sellable.variantId, itemId, '2');
      const order = await mkOpenOrderWithLine(
        sellable.itemId,
        sellable.variantId,
      );

      const arrive = makeBarrier(2);
      BarrierPrismaService.barrier = arrive;
      const results = await Promise.allSettled([
        counts.post(tenantA, userA, session.id),
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
      ]);
      BarrierPrismaService.barrier = null;

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      await assertLedgerTruthful(itemId);
    });

    it('multi-item inversion: waste([A,B]) vs count([B,A]) never deadlocks after the deterministic-order fix', async () => {
      const itemA = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      const itemB = await mkStockItem({
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      });
      await receive(itemA, '50', 100n, new Date('2026-08-01T08:00:00Z'));
      await receive(itemB, '50', 100n, new Date('2026-08-01T08:00:00Z'));

      const session = await counts.open(tenantA, userA, {
        locationId: locationA,
        scopeType: 'item_list',
        // Deliberately reversed relative to `itemA < itemB` id order: the
        // production code sorts internally, but the CALLER order here is
        // opposite the waste record's below.
        itemIds: [itemB, itemA],
      });
      const openedLines = await counts.lines(tenantA, session.id);
      const lineFor = (stockItemId: string) =>
        openedLines.find((l) => l.stockItemId === stockItemId)!;
      await counts.recordCount(tenantA, userA, lineFor(itemB).id, '45');
      await counts.recordCount(tenantA, userA, lineFor(itemA).id, '47');

      const arrive = makeBarrier(2);
      BarrierPrismaService.barrier = arrive;
      const results = await Promise.allSettled([
        // Waste submits [A, B]; the count session was opened [B, A] above —
        // opposite caller-supplied orders touching the SAME two keys.
        waste.record(tenantA, userA, {
          locationId: locationA,
          reasonCodeId: reasonA,
          lines: [
            { stockItemId: itemA, quantity: '3' },
            { stockItemId: itemB, quantity: '4' },
          ],
        }),
        counts.post(tenantA, userA, session.id),
      ]);
      BarrierPrismaService.barrier = null;

      // No deadlock: BOTH multi-key writers succeed (they now serialize on
      // the same stockItemId-ASC lock order instead of inverting).
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

      await assertLedgerTruthful(itemA);
      await assertLedgerTruthful(itemB);
      const levelA = await levelRow(itemA);
      const levelB = await levelRow(itemB);
      // The count's window-sum SELECT (§7/CT-08) is an unlocked read — it
      // races `waste.record`'s commit with no barrier ordering the two
      // relative to each other, only the (now-fixed) stockItemId-lock order
      // that prevents a DEADLOCK. So either genuinely valid outcome is
      // acceptable here: the window-sum missing the not-yet-committed waste
      // (raw, uncorrected variance posted: 50-3-3=44 / 50-4-5=41) or seeing
      // it (window-adjusted variance correctly nets to 0 / -1: 50-3-0=47 /
      // 50-4-1=45) — asserting a single hardcoded value would make this
      // test flake on real timing, which §4 forbids as a correctness proof.
      // Both outcomes are independently, deterministically proven correct
      // by the CT-08 tests above (§7), which do not race the window read
      // against a concurrent writer.
      expect(['44.000000', '47.000000']).toContain(
        levelA.quantityOnHand.toFixed(6),
      );
      expect(['41.000000', '45.000000']).toContain(
        levelB.quantityOnHand.toFixed(6),
      );
    });
  });
});
