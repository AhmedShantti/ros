import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
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
 * A1-3B — set-oriented group write path (P1-PERF, Lane A).
 *
 * Authority: docs/reports/claude/full-srs-4day/2026-09-02_A1-3_set-oriented-
 * depletion-design-gate.md (design), 2026-09-03_A1-3A_set-oriented-effect-
 * reservation.md (accepted prior slice). Non-authoritative evidence — the
 * SRS and ratified governance decisions remain authoritative.
 *
 * Covers task §23 items 1-8 and 11 directly. Item 9 (concurrency serial
 * equivalence) is covered by the unmodified `order-completion-concurrency`,
 * `order-completion-concurrency-2` and `movements-concurrency` suites, which
 * now exercise this group-write path end to end and pass unmodified — see
 * the A1-3B report. Item 10 (high-precision exact decimal) is folded into
 * the balance_after fold test below.
 */
describe('SaleDepletionService — A1-3B set-oriented group writes', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let logging: PrismaClient;
  let loggedQueries: string[];
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;
  let prisma: PrismaService;
  let saleDepletion: SaleDepletionCommand;

  const stamp = Date.now();
  const AT = new Date('2026-09-03T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-a13b-release-key');
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

    const appUrl = app
      .get(ConfigService)
      .getOrThrow<string>('APP_DATABASE_URL');
    logging = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
      log: [{ emit: 'event', level: 'query' }],
    });
    logging.$on('query' as never, (e: { query: string }) => {
      loggedQueries.push(e.query);
    });

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
        slug: `a13b-${stamp}`,
        legalName: 'A13B',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `A13BBrand-${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `A13B${stamp % 10000}`,
        name: 'A13B Branch',
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
          name: 'A13B-POS',
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `a13b.${stamp}@example.com`,
        displayName: 'A13B',
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
          code: `A13BE${stamp % 1000}`,
          displayName: 'A13B Employee',
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
          name: 'A13B pricing',
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
          code: `A13BKG${stamp % 100000}`,
          name: 'A13B Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;

    const menuItem = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: `A13B Dish ${stamp}` },
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

  afterAll(async () => {
    await logging.$disconnect();
    await admin.$disconnect();
    await app.close();
  });

  interface BatchSpec {
    qty: string;
    unitCost: bigint;
    createdAt: Date;
    expiryDate?: Date;
  }

  const mkFifoItem = async (
    batches: BatchSpec[],
    batchStrategy: 'fifo' | 'fefo' = 'fifo',
  ): Promise<string> => {
    itemCounter += 1;
    const item = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        sku: `A13B-${stamp}-${itemCounter}`,
        names: { en: `A13B-${stamp}-${itemCounter}` },
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
      const added = await lines.addLine(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        {
          menuItemId,
          variantId,
          quantity: '1',
          modifiers: [],
          expectedVersion,
        },
      );
      expectedVersion = added.order.version;
      lineIds.push(added.line.id);
    }
    return { orderId: order.id, businessDay: order.businessDay, lineIds };
  };

  interface Component {
    orderLineId: string;
    stockItemId: string;
    qty: string;
  }

  const deplete = (
    orderId: string,
    businessDay: Date,
    components: Component[],
  ): Promise<DepleteForCompletedSaleResult> =>
    prisma.withAuthContext({ userId: userA, tenantId: tenantA }, (tx) =>
      saleDepletion.depleteForCompletedSale(tx, {
        tenantId: tenantA,
        actorId: userA,
        branchId: branchA,
        orderId,
        businessDay,
        occurredAt: AT,
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

  /** Same as `deplete`, but through the query-logging client — statement-count proofs. */
  const depleteLogged = (
    orderId: string,
    businessDay: Date,
    components: Component[],
  ): Promise<DepleteForCompletedSaleResult> =>
    logging.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)",
        userA,
        tenantA,
      );
      return saleDepletion.depleteForCompletedSale(tx, {
        tenantId: tenantA,
        actorId: userA,
        branchId: branchA,
        orderId,
        businessDay,
        occurredAt: AT,
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
      });
    });

  // ---------------------------------------------------------------- §15 --
  describe('same-batch aggregation (design gate §15 — the UPDATE...FROM hazard)', () => {
    it('several effects in one group hit the SAME physical AND accounting batch — every delta is applied, none lost', async () => {
      const item = await mkFifoItem([
        { qty: '20', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const [batch] = await admin.stockBatch.findMany({
        where: { stockItemId: item },
      });
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(4);

      await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '3' },
        { orderLineId: lineIds[1], stockItemId: item, qty: '4' },
        { orderLineId: lineIds[2], stockItemId: item, qty: '2.5' },
        { orderLineId: lineIds[3], stockItemId: item, qty: '1.5' },
      ]);

      const final = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      // 20 - (3 + 4 + 2.5 + 1.5) = 9, exactly — not the last-delta-wins 20-1.5=18.5.
      expect(final.quantityRemaining.equals(new Prisma.Decimal('9'))).toBe(
        true,
      );
      expect(
        final.fifoCostQuantityConsumed.equals(new Prisma.Decimal('11')),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------- §14 --
  describe('physical / accounting axis independence (design gate §14)', () => {
    it('FEFO physical batch differs from FIFO accounting batch — each axis mutates only its own batch/field', async () => {
      const item = await mkFifoItem(
        [
          {
            qty: '5',
            unitCost: 100n,
            createdAt: new Date('2026-01-01'),
            expiryDate: new Date('2026-02-10'),
          },
          {
            qty: '5',
            unitCost: 200n,
            createdAt: new Date('2026-01-02'),
            expiryDate: new Date('2026-02-05'),
          },
        ],
        'fefo',
      );
      const [batch1, batch2] = await admin.stockBatch.findMany({
        where: { stockItemId: item },
        orderBy: { createdAt: 'asc' },
      });
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(1);

      const result = await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '3' },
      ]);

      const allocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      expect(allocations).toHaveLength(1);
      const [alloc] = allocations;
      // Physical: FEFO picks batch2 (earlier expiry). Accounting: FIFO picks batch1 (receipt order).
      expect(alloc.physicalBatchId).toBe(batch2.id);
      expect(alloc.costBasisBatchId).toBe(batch1.id);
      expect(alloc.physicalBatchId).not.toBe(alloc.costBasisBatchId);

      const finalBatch1 = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch1.id },
      });
      const finalBatch2 = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch2.id },
      });

      // P (batch2): quantity_remaining changes, fifo_cost_quantity_consumed does NOT.
      expect(
        finalBatch2.quantityRemaining.equals(new Prisma.Decimal('2')),
      ).toBe(true);
      expect(
        finalBatch2.fifoCostQuantityConsumed.equals(new Prisma.Decimal('0')),
      ).toBe(true);
      // C (batch1): fifo_cost_quantity_consumed changes, quantity_remaining does NOT.
      expect(
        finalBatch1.fifoCostQuantityConsumed.equals(new Prisma.Decimal('3')),
      ).toBe(true);
      expect(
        finalBatch1.quantityRemaining.equals(new Prisma.Decimal('5')),
      ).toBe(true);

      // Movement provenance: batch_id follows the PHYSICAL batch (unchanged from A1-2).
      const movement = await admin.stockMovement.findFirstOrThrow({
        where: { id: alloc.movementId },
      });
      expect(movement.batchId).toBe(batch2.id);
    });
  });

  // ---------------------------------------------------------------- §9.2 --
  describe('carry-forward flush (design gate §9.2 — the mandatory rule)', () => {
    it('a shortfall mid-group carry-forwards to the batch THIS SAME GROUP just exhausted, not a stale snapshot', async () => {
      // batch1 (5, cheap) will be exactly exhausted by effect 1's accounting
      // consumption; effect 2's shortfall must carry-forward to batch1 (the
      // freshly-exhausted layer), which requires the flush rule to have
      // written effect 1's accounting delta BEFORE `findCarryForwardBasis`
      // runs for effect 2. Without the flush, the query would not see
      // batch1 as exhausted yet.
      const item = await mkFifoItem([
        { qty: '5', unitCost: 50n, createdAt: new Date('2026-01-01') },
      ]);
      const [batch1] = await admin.stockBatch.findMany({
        where: { stockItemId: item },
      });
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      const result = await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '5' }, // exhausts batch1 exactly
        { orderLineId: lineIds[1], stockItemId: item, qty: '2' }, // shortfall — carries forward
      ]);

      const allAllocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      expect(allAllocations).toHaveLength(2);
      const [a1, a2] = allAllocations;
      expect(a1.costBasisBatchId).toBe(batch1.id);
      expect(a1.unitCost).toBe(50n);
      // The carry-forward slice: same basis batch, same unit cost — proving
      // the flush made batch1 visible to `findCarryForwardBasis` as
      // exhausted-by-THIS-group, not stale pre-call state (there is no
      // other batch it could have found).
      expect(a2.costBasisBatchId).toBe(batch1.id);
      expect(a2.unitCost).toBe(50n);
      expect(a2.physicalBatchId).toBeNull(); // physical shortfall too — no second batch exists.

      const finalBatch1 = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch1.id },
      });
      // Accounting counter reflects ONLY the real consumption (5), NEVER the
      // carry-forward slice's quantity (2) — carry-forward is excluded from
      // the persisted aggregate (design gate §9.1).
      expect(
        finalBatch1.fifoCostQuantityConsumed.equals(new Prisma.Decimal('5')),
      ).toBe(true);
      expect(
        finalBatch1.quantityRemaining.equals(new Prisma.Decimal('0')),
      ).toBe(true);
    });

    it('statement-count proof: the flush issues an EXTRA accounting UPDATE only on the shortfall path', async () => {
      loggedQueries = [];
      const item = await mkFifoItem([
        { qty: '5', unitCost: 50n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      await depleteLogged(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '5' },
        { orderLineId: lineIds[1], stockItemId: item, qty: '2' },
      ]);

      const accountingUpdates = loggedQueries.filter(
        (q) =>
          /UPDATE "inventory"\."stock_batches"/.test(q) &&
          q.includes('fifo_cost_quantity_consumed'),
      );
      // ONE for the mandatory pre-carry-forward flush (effect 1's own
      // consumption), ONE more would only occur if MORE accounting deltas
      // accumulated after the flush and before group end — here there are
      // none (effect 2 is 100% carry-forward), so exactly one.
      expect(accountingUpdates).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------- §6/§10 --
  describe('sequential balance_after fold, high-precision decimals (design gate §6, §19)', () => {
    it('three effects in one group, decimals at the 6dp precision edge, fold exactly and match the persisted stock_levels balance', async () => {
      const item = await mkFifoItem([
        { qty: '100', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);

      await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '0.333333' },
        { orderLineId: lineIds[1], stockItemId: item, qty: '1.666667' },
        { orderLineId: lineIds[2], stockItemId: item, qty: '0.000001' },
      ]);

      const movements = await admin.stockMovement.findMany({
        where: { stockItemId: item, locationId: locationA },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      expect(movements).toHaveLength(3);

      let running = new Prisma.Decimal(0);
      const expectedRunning = ['-0.333333', '-2.000000', '-2.000001'];
      movements.forEach((m, i) => {
        running = running.plus(m.quantity);
        expect(running.equals(new Prisma.Decimal(expectedRunning[i]))).toBe(
          true,
        );
        expect(m.balanceAfter.equals(running)).toBe(true);
      });

      const level = await admin.stockLevel.findUniqueOrThrow({
        where: {
          stockItemId_locationId: { stockItemId: item, locationId: locationA },
        },
      });
      expect(level.quantityOnHand.equals(running)).toBe(true);
      // §6 pointer: last_movement_id is the LAST movement in `ord` order.
      expect(level.lastMovementId).toBe(movements[2].id);
    });
  });

  // ------------------------------------------------------------------ §9 --
  describe('final last_movement_id derivation (design gate §9, not max(UUID))', () => {
    it('two order lines on one stock key: pointer = the last zipped slice in `ord` order, matching the returned allocation', async () => {
      const item = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      const result = await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '4' },
        { orderLineId: lineIds[1], stockItemId: item, qty: '3' },
      ]);

      // orderLineId ASC is the within-group `ord` basis (design gate §6.2);
      // lineIds[1] > lineIds[0] is NOT guaranteed, so resolve the true last
      // ord by re-deriving the same sort the service uses.
      type Alloc =
        DepleteForCompletedSaleResult['perLine'][number]['effects'][number]['allocations'][number];
      const byOrderLine = result.perLine
        .map((pl) => ({
          orderLineId: pl.orderLineId,
          alloc: pl.effects[0]?.allocations[0],
        }))
        .filter((x): x is { orderLineId: string; alloc: Alloc } => !!x.alloc)
        .sort((a, b) =>
          a.orderLineId < b.orderLineId
            ? -1
            : a.orderLineId > b.orderLineId
              ? 1
              : 0,
        );
      const lastAlloc = byOrderLine[byOrderLine.length - 1].alloc;

      const level = await admin.stockLevel.findUniqueOrThrow({
        where: {
          stockItemId_locationId: { stockItemId: item, locationId: locationA },
        },
      });
      expect(level.lastMovementId).toBe(lastAlloc.movementId);
    });
  });

  // -------------------------------------------------------------- §5.6 --
  describe('multi-row allocation insert — sequence and provenance (design gate §5.6)', () => {
    it('sequence resets per effect; every allocation column matches its zipped slice', async () => {
      const item = await mkFifoItem(
        [
          { qty: '3', unitCost: 100n, createdAt: new Date('2026-01-01') },
          { qty: '3', unitCost: 200n, createdAt: new Date('2026-01-02') },
        ],
        'fifo',
      );
      const [batch1, batch2] = await admin.stockBatch.findMany({
        where: { stockItemId: item },
        orderBy: { createdAt: 'asc' },
      });
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      // Effect 1 spans both batches (3 from batch1, 1 from batch2) — two
      // allocation rows, sequence 0 and 1. Effect 2 takes 2 from batch2 —
      // one allocation row, sequence 0 again (reset per effect).
      const result = await deplete(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '4' },
        { orderLineId: lineIds[1], stockItemId: item, qty: '2' },
      ]);

      const effect1 = result.perLine.find(
        (pl) => pl.orderLineId === lineIds[0],
      )!.effects[0];
      const effect2 = result.perLine.find(
        (pl) => pl.orderLineId === lineIds[1],
      )!.effects[0];
      expect(effect1.allocations.map((a) => a.sequence)).toEqual([0, 1]);
      expect(effect2.allocations.map((a) => a.sequence)).toEqual([0]);
      expect(effect1.allocations[0].physicalBatchId).toBe(batch1.id);
      expect(effect1.allocations[1].physicalBatchId).toBe(batch2.id);
      expect(effect2.allocations[0].physicalBatchId).toBe(batch2.id);

      const persisted = await admin.saleDepletionAllocation.findMany({
        where: { effectId: { in: [effect1.effectId, effect2.effectId] } },
        orderBy: [{ effectId: 'asc' }, { sequence: 'asc' }],
      });
      expect(persisted).toHaveLength(3);
      for (const p of persisted) {
        const src =
          p.effectId === effect1.effectId
            ? effect1.allocations[p.sequence]
            : effect2.allocations[p.sequence];
        expect(p.physicalBatchId).toBe(src.physicalBatchId);
        expect(p.costBasisBatchId).toBe(src.costBasisBatchId);
        expect(
          p.quantityInBaseUnit.equals(
            new Prisma.Decimal(src.quantityInBaseUnit),
          ),
        ).toBe(true);
        expect(p.unitCost).toBe(src.unitCost);
        expect(p.totalCost).toBe(src.totalCost);
        expect(p.movementId).toBe(src.movementId);
      }
    });
  });

  // -------------------------------------------------------------- §6.1 --
  describe('atomic stock-level starting-balance derivation (design gate §6.1)', () => {
    it('no plain SELECT of stock_levels.quantity_on_hand is ever issued — the start balance is derived from the write itself', async () => {
      loggedQueries = [];
      const item = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      await depleteLogged(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '2' },
        { orderLineId: lineIds[1], stockItemId: item, qty: '3' },
      ]);

      const plainStockLevelSelects = loggedQueries.filter(
        (q) =>
          /SELECT/i.test(q) &&
          /stock_levels/i.test(q) &&
          /quantity_on_hand/i.test(q) &&
          !/INSERT/i.test(q),
      );
      expect(plainStockLevelSelects).toHaveLength(0);

      // Exactly one INSERT ... ON CONFLICT DO UPDATE for the group (the
      // atomic read-modify-write that both applies the delta and reports
      // the post-update value used to derive the start balance).
      const atomicUpserts = loggedQueries.filter(
        (q) =>
          /INSERT INTO "inventory"\."stock_levels"/.test(q) &&
          /ON CONFLICT/i.test(q),
      );
      expect(atomicUpserts).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------- §11/20 --
  describe('statement-count instrumentation (task §20/§23.11)', () => {
    it('one stock key, two effects: exactly 5 group statements (lock, physical, accounting, levels+movements, pointer+allocations)', async () => {
      loggedQueries = [];
      const item = await mkFifoItem(
        [
          { qty: '3', unitCost: 100n, createdAt: new Date('2026-01-01') },
          { qty: '3', unitCost: 200n, createdAt: new Date('2026-01-02') },
        ],
        'fifo',
      );
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      await depleteLogged(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: item, qty: '4' },
        { orderLineId: lineIds[1], stockItemId: item, qty: '2' },
      ]);

      // Isolate the group-write statements from the per-call fixed cost
      // (set_config, stock_item lookup, reservation, average-cost hoist).
      const lockSelect = loggedQueries.filter(
        (q) => /FOR UPDATE/i.test(q) && /stock_batches/i.test(q),
      );
      const physicalUpdate = loggedQueries.filter(
        (q) =>
          /UPDATE "inventory"\."stock_batches"/.test(q) &&
          /quantity_remaining/.test(q),
      );
      const accountingUpdate = loggedQueries.filter(
        (q) =>
          /UPDATE "inventory"\."stock_batches"/.test(q) &&
          /fifo_cost_quantity_consumed/.test(q),
      );
      const levelsAndMovements = loggedQueries.filter((q) =>
        /INSERT INTO "inventory"\."stock_movements"/.test(q),
      );
      const pointerAndAllocations = loggedQueries.filter((q) =>
        /INSERT INTO "inventory"\."sale_depletion_allocations"/.test(q),
      );

      expect(lockSelect).toHaveLength(1);
      expect(physicalUpdate).toHaveLength(1);
      expect(accountingUpdate).toHaveLength(1);
      expect(levelsAndMovements).toHaveLength(1);
      expect(pointerAndAllocations).toHaveLength(1);

      // Confirm the OLD per-slice quartet (`writeAllocation`) no longer
      // executes: 3 zipped slices in this fixture, but only ONE movements
      // statement and ONE allocations statement, not three of each.
      const allMovementRows = await admin.stockMovement.findMany({
        where: { stockItemId: item, locationId: locationA },
      });
      expect(allMovementRows.length).toBeGreaterThan(1); // multiple ROWS...
      expect(levelsAndMovements).toHaveLength(1); // ...from ONE statement.
    });
  });
});
