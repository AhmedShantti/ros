import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import * as fifoCostLedger from './../src/modules/inventory/costing/fifo-cost-ledger';
import { SALE_DEPLETION_COMMAND } from './../src/modules/inventory/contract';
import type {
  DepleteForCompletedSaleResult,
  SaleDepletionCommand,
} from './../src/modules/inventory/contract';
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
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * A1-2 — FIFO layer lock grouping by distinct (stockItemId, locationId).
 *
 * Authority: docs/reports/claude/2026-09-02_FULL-SRS-current-head-
 * traceability-rebase.md §12.1/§29 and the A1-2 correction task itself.
 * Non-authoritative evidence — the SRS and ratified governance decisions
 * remain authoritative.
 *
 * §16 proof: `lockLayers` (the private inventory kernel's `FOR UPDATE`
 * acquisition) is spied via `jest.spyOn` on the module namespace export —
 * verified (scratch check, not committed) to intercept calls made from
 * `SaleDepletionService`, which imports the SAME named export; ts-jest's
 * CommonJS-style emit resolves named imports as live property lookups on
 * the required module object at call time, not a snapshot taken at import
 * time. The spy calls through to the real implementation (no
 * `mockImplementation`), so every assertion here runs against genuine
 * Postgres row locks, not a stub.
 *
 * §17/§10 proof: real batches, real `stock_batches` rows, real allocations —
 * the primary guard against stale one-time-loaded layer state.
 */
describe('SaleDepletionService — A1-2 lock grouping + group-state correctness', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;
  let prisma: PrismaService;
  let saleDepletion: SaleDepletionCommand;

  const stamp = Date.now();
  const AT = new Date('2026-08-29T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-lockgroup-release-key');
  const TRUST = trustStoreFor(RELEASE_KEY.trusted());
  const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);

  let tenantA: string;
  let branchA: string;
  let locationA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let unitKg: string;
  let taxClassStandard: string;
  let priceListId: string;
  let menuItemId: string;
  let variantId: string;
  let itemCounter = 0;

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
    await app.init();
    admin = createMigratorClient(app);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    packs = app.get(CountryPackService);
    prisma = app.get(PrismaService);
    saleDepletion = app.get(SALE_DEPLETION_COMMAND);

    await packs.activate(
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
      ),
    );

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `lockgrp-${stamp}`,
        legalName: 'LockGrp',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `LockGrpBrand-${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `LG${stamp % 10000}`,
        name: 'LockGrp Branch',
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
    terminalA = (
      await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          name: 'LockGrp-POS',
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `lockgrp.${stamp}@example.com`,
        displayName: 'LockGrp',
      },
    });
    userA = user.id;
    await admin.membership.create({
      data: { id: newId(), userId: userA, tenantId: tenantA, status: 'active' },
    });
    employeeA = (
      await admin.employee.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          code: `LGE${stamp % 1000}`,
          displayName: 'LockGrp Employee',
          homeBranchId: branchA,
          userId: userA,
        },
      })
    ).id;
    await admin.employeeBranch.create({
      data: { tenantId: tenantA, employeeId: employeeA, branchId: branchA },
    });

    taxClassStandard = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;
    priceListId = (
      await admin.priceList.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          name: 'LockGrp pricing',
          scopeType: 'branch',
          scopeId: branchA,
          status: 'active',
        },
      })
    ).id;
    unitKg = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `LKG${stamp % 100000}`,
          name: 'LockGrp Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;

    // A single menu item/variant is enough: these tests call
    // `depleteForCompletedSale` directly with hand-built components,
    // bypassing `planConsumption`/recipes entirely (out of scope here).
    const menuItem = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: `LockGrp Dish ${stamp}` },
        taxClassId: taxClassStandard,
      },
    });
    menuItemId = menuItem.id;
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: menuItem.id,
        name: { en: 'V' },
      },
    });
    variantId = variant.id;
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        priceListId,
        menuItemVariantId: variant.id,
        price: 10_000n,
        currency: 'EGP',
      },
    });
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  interface BatchSpec {
    qty: string;
    unitCost: bigint;
    createdAt: Date;
    expiryDate?: Date;
  }

  /** A fresh FIFO-costed, batch-tracked stock item with the given batches. */
  const mkFifoItem = async (
    batches: BatchSpec[],
    batchStrategy: 'fifo' | 'fefo' = 'fifo',
  ): Promise<string> => {
    itemCounter += 1;
    const item = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        sku: `LG-${stamp}-${itemCounter}`,
        names: { en: `LG-${stamp}-${itemCounter}` },
        baseUnitId: unitKg,
        costingMethod: 'fifo',
        batchStrategy,
        isBatchTracked: true,
      },
    });
    for (const b of batches) {
      await admin.stockBatch.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          stockItemId: item.id,
          locationId: locationA,
          quantityReceived: b.qty,
          quantityRemaining: b.qty,
          unitCost: b.unitCost,
          createdAt: b.createdAt,
          expiryDate: b.expiryDate ?? null,
        },
      });
    }
    return item.id;
  };

  /** One order with `n` empty (recipe-less) lines, for real orderLineId FKs. */
  const mkOrderWithLines = async (
    n: number,
  ): Promise<{ orderId: string; businessDay: Date; lineIds: string[] }> => {
    const order = await orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    let expectedVersion = order.version;
    const lineIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const added = await lines.addLine(tenantA, userA, order.id, order.businessDay, {
        menuItemId,
        variantId,
        quantity: '1',
        modifiers: [],
        expectedVersion,
      });
      expectedVersion = added.order.version;
      lineIds.push(added.line.id);
    }
    return { orderId: order.id, businessDay: order.businessDay, lineIds };
  };

  const deplete = (
    orderId: string,
    businessDay: Date,
    components: { orderLineId: string; stockItemId: string; qty: string }[],
  ): Promise<DepleteForCompletedSaleResult> =>
    prisma.withAuthContext({ userId: userA, tenantId: tenantA }, (tx) =>
      saleDepletion.depleteForCompletedSale(tx, {
        tenantId: tenantA,
        actorId: userA,
        branchId: branchA,
        orderId,
        businessDay,
        occurredAt: new Date(),
        lines: components.map((c) => ({
          orderLineId: c.orderLineId,
          components: [
            {
              stockItemId: c.stockItemId,
              quantityInBaseUnit: c.qty,
              unitId: unitKg,
            },
          ],
        })),
      }),
    );

  // -------------------------------------------------------------- §16 --
  describe('lock acquisition — once per distinct (stockItemId, locationId), canonical global order', () => {
    it('A: three logical effects on the SAME (stockItemId, locationId) → exactly one lockLayers acquisition', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);
      const spy = jest.spyOn(fifoCostLedger, 'lockLayers');

      await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemA, qty: '1' },
        { orderLineId: lineIds[1], stockItemId: itemA, qty: '1' },
        { orderLineId: lineIds[2], stockItemId: itemA, qty: '1' },
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2]).toBe(itemA);
    });

    it('B: effects on TWO distinct (stockItemId, locationId) pairs → exactly two acquisitions, ascending stockItemId order', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const itemB = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const [lo, hi] = itemA < itemB ? [itemA, itemB] : [itemB, itemA];
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(4);
      const spy = jest.spyOn(fifoCostLedger, 'lockLayers');

      // A/B/A/B interleaved in the INPUT — the service sorts internally.
      await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemA, qty: '1' },
        { orderLineId: lineIds[1], stockItemId: itemB, qty: '1' },
        { orderLineId: lineIds[2], stockItemId: itemA, qty: '1' },
        { orderLineId: lineIds[3], stockItemId: itemB, qty: '1' },
      ]);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.map((c) => c[2])).toEqual([lo, hi]);
    });

    it('C: input order reversed → lock acquisition order is STILL canonical ascending stockItemId', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const itemB = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const [lo, hi] = itemA < itemB ? [itemA, itemB] : [itemB, itemA];
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(4);
      const spy = jest.spyOn(fifoCostLedger, 'lockLayers');

      // B/A/B/A this time — the OPPOSITE interleaving of test B.
      await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemB, qty: '1' },
        { orderLineId: lineIds[1], stockItemId: itemA, qty: '1' },
        { orderLineId: lineIds[2], stockItemId: itemB, qty: '1' },
        { orderLineId: lineIds[3], stockItemId: itemA, qty: '1' },
      ]);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.map((c) => c[2])).toEqual([lo, hi]);
    });
  });

  // ------------------------------------------------------------- §17/§9 --
  describe('group-state correctness — physical and accounting axes evolve independently across effects in the same group', () => {
    it('FEFO physical order diverges from FIFO accounting receipt order; the second effect continues from the first effect\'s evolved state on BOTH axes', async () => {
      // Receipt order (accounting, FIFO): batch1 THEN batch2.
      // Expiry order (physical, FEFO): batch2 (expires sooner) THEN batch1.
      const batch1CreatedAt = new Date('2026-01-01T00:00:00Z');
      const batch2CreatedAt = new Date('2026-01-02T00:00:00Z');
      const itemX = await mkFifoItem(
        [
          {
            qty: '5',
            unitCost: 100n,
            createdAt: batch1CreatedAt,
            expiryDate: new Date('2026-02-10'), // later expiry
          },
          {
            qty: '5',
            unitCost: 200n,
            createdAt: batch2CreatedAt,
            expiryDate: new Date('2026-02-05'), // EARLIER expiry — FEFO picks this first
          },
        ],
        'fefo',
      );
      const [batch1, batch2] = await admin.stockBatch.findMany({
        where: { stockItemId: itemX },
        orderBy: { createdAt: 'asc' },
      });

      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      const result = await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemX, qty: '3' },
        { orderLineId: lineIds[1], stockItemId: itemX, qty: '4' },
      ]);

      const allAllocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      // Effect 1 (qty 3): physical takes 3 from batch2 (FEFO, nearest expiry);
      // accounting takes 3 from batch1 (FIFO, receipt order). One allocation.
      // Effect 2 (qty 4), CONTINUING the evolved state:
      //   physical: batch2 has 2 remaining (5-3) -> take 2, then 2 more from
      //     batch1 (untouched physically, 5 remaining) -> take 2.
      //   accounting: batch1 has 2 headroom (5 received - 3 consumed) -> take
      //     2, exhausting it; then 2 more from batch2 (untouched by
      //     accounting so far, 5 headroom) -> take 2.
      //   zip: {physical batch2 x2, cost batch1 x2}, {physical batch1 x2, cost batch2 x2}.
      expect(allAllocations).toHaveLength(3);

      const sig = (a: (typeof allAllocations)[number]) =>
        `${a.physicalBatchId}|${a.costBasisBatchId}|${a.quantityInBaseUnit}`;
      const got = new Set(allAllocations.map(sig));
      expect(got).toEqual(
        new Set([
          `${batch2.id}|${batch1.id}|3.000000`,
          `${batch2.id}|${batch1.id}|2.000000`,
          `${batch1.id}|${batch2.id}|2.000000`,
        ]),
      );
      // Exact unit costs / total costs, per cost-basis batch.
      for (const a of allAllocations) {
        if (a.costBasisBatchId === batch1.id) {
          expect(a.unitCost).toBe(100n);
        } else if (a.costBasisBatchId === batch2.id) {
          expect(a.unitCost).toBe(200n);
        }
        expect(a.totalCost).toBe(
          BigInt(Math.round(Number(a.quantityInBaseUnit) * Number(a.unitCost))),
        );
      }

      // Exact final PHYSICAL state: batch2 fully depleted by physical
      // consumption (3 + 2 = 5), batch1 physical remainder = 5 - 2 = 3.
      const finalBatch1 = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch1.id },
      });
      const finalBatch2 = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch2.id },
      });
      expect(finalBatch1.quantityRemaining.equals(new Prisma.Decimal('3'))).toBe(
        true,
      );
      expect(finalBatch2.quantityRemaining.equals(new Prisma.Decimal('0'))).toBe(
        true,
      );
      // Exact final ACCOUNTING state: batch1 accounting-exhausted (3 + 2 = 5),
      // batch2 accounting-consumed = 2 (never physically touched by
      // accounting until effect 2).
      expect(
        finalBatch1.fifoCostQuantityConsumed.equals(new Prisma.Decimal('5')),
      ).toBe(true);
      expect(
        finalBatch2.fifoCostQuantityConsumed.equals(new Prisma.Decimal('2')),
      ).toBe(true);

      // BR-INV-003: stock_levels equals the exact fold of stock_movements,
      // and every movement's balance_after is the true running fold.
      const movements = await admin.stockMovement.findMany({
        where: { stockItemId: itemX, locationId: locationA },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      let running = new Prisma.Decimal(0);
      for (const m of movements) {
        running = running.plus(m.quantity);
        expect(m.balanceAfter.equals(running)).toBe(true);
      }
      const level = await admin.stockLevel.findUniqueOrThrow({
        where: { stockItemId_locationId: { stockItemId: itemX, locationId: locationA } },
      });
      expect(level.quantityOnHand.equals(running)).toBe(true);
      expect(level.quantityOnHand.equals(new Prisma.Decimal('-7'))).toBe(true);
    });
  });

  // -------------------------------------------------------------- §10 --
  describe('carry-forward — reflects prior effects in the SAME locked group, not a stale snapshot', () => {
    it('a second effect in the same group exhausts the accounting layer and carry-forwards to it', async () => {
      const itemY = await mkFifoItem([
        { qty: '5', unitCost: 300n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      const result = await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemY, qty: '3' },
        { orderLineId: lineIds[1], stockItemId: itemY, qty: '4' },
      ]);

      const allAllocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      // Effect 1 (qty 3): physical + accounting both take 3 from the one
      // batch (5 -> 2 remaining, 0 -> 3 consumed). One allocation.
      // Effect 2 (qty 4), continuing the evolved state:
      //   physical: 2 remaining -> take 2, shortfall 2 (physicalBatchId null).
      //   accounting: headroom 5-3=2 -> take 2 (now EXHAUSTED, 5-5=0),
      //     shortfall 2 -> findCarryForwardBasis: the layer THIS call just
      //     exhausted is correctly eligible (real DB write already applied)
      //     -> carries forward to the SAME batch.
      //   zip of physical=[{batch,2},{null,2}] and
      //   cost=[{batch,2},{batch(carry-forward),2}] merges into
      //   [{physical:batch, cost:batch, qty:2}, {physical:null, cost:batch, qty:2}].
      const batch = (
        await admin.stockBatch.findFirstOrThrow({ where: { stockItemId: itemY } })
      ).id;
      expect(allAllocations).toHaveLength(3);
      const sig = (a: (typeof allAllocations)[number]) =>
        `${a.physicalBatchId}|${a.costBasisBatchId}|${a.quantityInBaseUnit}`;
      expect(new Set(allAllocations.map(sig))).toEqual(
        new Set([
          `${batch}|${batch}|3.000000`,
          `${batch}|${batch}|2.000000`,
          `null|${batch}|2.000000`,
        ]),
      );
      for (const a of allAllocations) {
        expect(a.unitCost).toBe(300n); // carry-forward preserves the true cost basis
      }

      const finalBatch = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch },
      });
      expect(finalBatch.quantityRemaining.equals(new Prisma.Decimal('0'))).toBe(
        true,
      );
      expect(
        finalBatch.fifoCostQuantityConsumed.equals(new Prisma.Decimal('5')),
      ).toBe(true);

      // FR-INV-014: negative stock recorded, not blocked. Exact fold holds.
      const movements = await admin.stockMovement.findMany({
        where: { stockItemId: itemY, locationId: locationA },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      let running = new Prisma.Decimal(0);
      for (const m of movements) {
        running = running.plus(m.quantity);
        expect(m.balanceAfter.equals(running)).toBe(true);
      }
      expect(running.equals(new Prisma.Decimal('-7'))).toBe(true);
    });
  });
});
