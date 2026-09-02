import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import * as fifoCostLedger from './../src/modules/inventory/costing/fifo-cost-ledger';
import { SALE_DEPLETION_COMMAND } from './../src/modules/inventory/contract';
import type {
  DepleteForCompletedSaleResult,
  SaleDepletionCommand,
} from './../src/modules/inventory/contract';
import { SaleDepletionEffectConflictError } from './../src/modules/inventory/contract/sale-depletion.errors';
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
import { createMigratorClient } from './rls-admin';

/**
 * A1-3A — set-oriented effect reservation + weighted-average cost hoist.
 *
 * Authority: docs/reports/claude/full-srs-4day/
 * 2026-09-02_A1-3_set-oriented-depletion-design-gate.md (non-authoritative
 * evidence; the SRS and ratified governance decisions remain authoritative).
 *
 * This suite proves, against the real Lane-A disposable database and the
 * REAL `Prisma.TransactionClient` / `$queryRaw` path (never a mock/stub):
 *
 *   1. `JSON.stringify(payload)` binds safely as a `::jsonb` parameter
 *      through `jsonb_to_recordset`, for a multi-row batch reservation.
 *   2. Identity-based (not cardinality-based) conflict detection — first /
 *      middle / last / multiple conflicts, each naming every missing
 *      identity.
 *   3. A duplicate business identity WITHIN one request is rejected
 *      fail-closed, before any SQL — cannot masquerade as success.
 *   4. A partially-reservable batch (some rows insertable, one pre-existing
 *      conflict) still rolls back EVERY newly-reserved effect and leaves
 *      Inventory state (`stock_batches`, `stock_levels`, `stock_movements`,
 *      `sale_depletion_allocations`) byte-for-byte untouched.
 *   5. Zero `stock_batches ... FOR UPDATE` lock acquisition occurs before
 *      the reservation result is validated.
 *   6. The weighted-average `current_cost` lookup is ONE statement for the
 *      whole call, not one per effect — proven by real query-log counting,
 *      not by call-count estimation.
 *   7. Missing `stock_levels` row -> average cost `0`, same as pre-A1-3A.
 *
 * §16 proof technique (borrowed from `sale-depletion-lock-grouping.e2e-
 * spec.ts`): `lockLayers` is spied via `jest.spyOn` on the fifo-cost-ledger
 * module namespace export, calling through to the real implementation.
 *
 * Statement counting uses a SEPARATE `PrismaClient`, connected to the SAME
 * database as the app-under-test via `APP_DATABASE_URL`, configured with
 * `log: [{ emit: 'event', level: 'query' }]`. `depleteForCompletedSale`
 * only needs a `Prisma.TransactionClient` — it is connection-instance
 * agnostic — so this logging client's transaction can drive the REAL
 * service directly, while all fixture arrangement still goes through the
 * app's own DI-managed services/connection.
 */
describe('SaleDepletionService — A1-3A set-oriented effect reservation', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let logging: PrismaClient;
  let loggedQueries: string[];
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;
  let saleDepletion: SaleDepletionCommand;

  const stamp = Date.now();
  const AT = new Date('2026-09-03T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-a13a-release-key');
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
    saleDepletion = app.get(SALE_DEPLETION_COMMAND);

    const appUrl = app
      .get(ConfigService)
      .getOrThrow<string>('APP_DATABASE_URL');
    logging = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
      log: [{ emit: 'event', level: 'query' }],
    });
    loggedQueries = [];
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
        slug: `a13a-${stamp}`,
        legalName: 'A13A',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `A13ABrand-${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `A13${stamp % 10000}`,
        name: 'A13A Branch',
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
          name: 'A13A-POS',
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `a13a.${stamp}@example.com`,
        displayName: 'A13A',
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
          code: `A13E${stamp % 1000}`,
          displayName: 'A13A Employee',
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
          name: 'A13A pricing',
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
          code: `A13KG${stamp % 100000}`,
          name: 'A13A Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;

    const menuItem = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: `A13A Dish ${stamp}` },
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
    loggedQueries.length = 0;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await logging.$disconnect();
    await app.close();
  });

  interface BatchSpec {
    qty: string;
    unitCost: bigint;
    createdAt: Date;
  }

  const mkFifoItem = async (batches: BatchSpec[]): Promise<string> => {
    itemCounter += 1;
    const item = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        sku: `A13-${stamp}-${itemCounter}`,
        names: { en: `A13-${stamp}-${itemCounter}` },
        baseUnitId: unitKg,
        costingMethod: 'fifo',
        batchStrategy: 'fifo',
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
        },
      });
    }
    return item.id;
  };

  const mkWeightedAverageItem = async (
    averageCost?: bigint,
  ): Promise<string> => {
    itemCounter += 1;
    const item = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        sku: `A13WA-${stamp}-${itemCounter}`,
        names: { en: `A13WA-${stamp}-${itemCounter}` },
        baseUnitId: unitKg,
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      },
    });
    if (averageCost !== undefined) {
      await admin.stockLevel.create({
        data: {
          tenantId: tenantA,
          stockItemId: item.id,
          locationId: locationA,
          averageCost,
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

  /** Drives `depleteForCompletedSale` through the LOGGING client's own
   * transaction, so every statement it issues lands in `loggedQueries`. The
   * service is connection-instance agnostic (only needs a
   * `Prisma.TransactionClient`), so this is the SAME real code path as the
   * app's own `PrismaService.withAuthContext`. */
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
      const result = await saleDepletion.depleteForCompletedSale(tx, {
        tenantId: tenantA,
        actorId: userA,
        branchId: branchA,
        orderId,
        businessDay,
        occurredAt: new Date(),
        lines: components.reduce<
          {
            orderLineId: string;
            components: {
              stockItemId: string;
              quantityInBaseUnit: string;
              unitId: string;
            }[];
          }[]
        >((acc, c) => {
          let line = acc.find((l) => l.orderLineId === c.orderLineId);
          if (!line) {
            line = { orderLineId: c.orderLineId, components: [] };
            acc.push(line);
          }
          line.components.push({
            stockItemId: c.stockItemId,
            quantityInBaseUnit: c.qty,
            unitId: unitKg,
          });
          return acc;
        }, []),
      });
      throw new RollbackSentinel(result);
    });

  class RollbackSentinel extends Error {
    constructor(readonly result: DepleteForCompletedSaleResult) {
      super('__A13A_PROBE_ROLLBACK__');
    }
  }

  const snapshotEffects = () =>
    admin.saleDepletionEffect.findMany({ where: { tenantId: tenantA } });
  const snapshotMovements = () =>
    admin.stockMovement.findMany({ where: { tenantId: tenantA } });
  const snapshotAllocations = () =>
    admin.saleDepletionAllocation.findMany({ where: { tenantId: tenantA } });
  const snapshotBatch = (id: string) =>
    admin.stockBatch.findUniqueOrThrow({ where: { id } });

  /** Directly insert a `sale_depletion_effects` row that will conflict with
   * a later real reservation for the same identity (order line, stock item,
   * this suite's fixed `locationA`) — the disposable-DB equivalent of "a
   * prior Completion already reserved this effect". */
  const preExistingEffect = async (orderLineId: string, stockItemId: string) =>
    admin.saleDepletionEffect.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        orderId: (
          await admin.orderLine.findFirstOrThrow({
            where: { id: orderLineId },
            select: { orderId: true },
          })
        ).orderId,
        businessDay: new Date('2026-09-03'),
        orderLineId,
        stockItemId,
        locationId: locationA,
        quantityInBaseUnit: '1',
        unitId: unitKg,
      },
    });

  // ============================================================ §1/§2 --
  describe('real Prisma jsonb binding + all-success batch reservation', () => {
    it('binds a multi-row payload through jsonb_to_recordset in ONE reservation statement, real Prisma TransactionClient path', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const itemB = await mkFifoItem([
        { qty: '10', unitCost: 200n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);

      const result = await depleteLogged(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemA, qty: '1' },
        { orderLineId: lineIds[1], stockItemId: itemA, qty: '2' },
        { orderLineId: lineIds[2], stockItemId: itemB, qty: '3' },
      ]).catch((e: unknown) => {
        if (e instanceof RollbackSentinel) return e.result;
        throw e;
      });

      const allAllocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      expect(allAllocations).toHaveLength(3);

      const reservationInserts = loggedQueries.filter(
        (q) =>
          q.includes('INSERT INTO "inventory"."sale_depletion_effects"') &&
          q.includes('jsonb_to_recordset'),
      );
      expect(reservationInserts).toHaveLength(1);
    });
  });

  // ============================================================== §2 --
  describe('identity-based conflict detection — first / middle / last / multiple', () => {
    it('FIRST triple conflicts -> conflict reported, ZERO Inventory mutation, ZERO lockLayers call', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const itemB = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const [lo, hi] = itemA < itemB ? [itemA, itemB] : [itemB, itemA];
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);
      await preExistingEffect(lineIds[0], lo);

      const batchBefore = await snapshotBatch(
        (
          await admin.stockBatch.findFirstOrThrow({
            where: { stockItemId: lo },
          })
        ).id,
      );
      const spy = jest.spyOn(fifoCostLedger, 'lockLayers');
      const effectsBefore = await snapshotEffects();

      await expect(
        depleteLogged(orderId, businessDay, [
          { orderLineId: lineIds[0], stockItemId: lo, qty: '1' },
          { orderLineId: lineIds[1], stockItemId: hi, qty: '1' },
        ]),
      ).rejects.toBeInstanceOf(SaleDepletionEffectConflictError);

      expect(spy).not.toHaveBeenCalled();
      const batchAfter = await snapshotBatch(batchBefore.id);
      expect(
        batchAfter.quantityRemaining.equals(batchBefore.quantityRemaining),
      ).toBe(true);
      expect(await snapshotMovements()).toHaveLength(0);
      expect(await snapshotAllocations()).toHaveLength(0);
      const effectsAfter = await snapshotEffects();
      expect(effectsAfter).toEqual(effectsBefore); // no NEW effect persisted; only the pre-existing one (committed above) is present
    });

    it('MIDDLE triple (of three) conflicts -> conflict reported, ZERO Inventory mutation', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);
      const sortedLineIds = [...lineIds].sort();
      await preExistingEffect(sortedLineIds[1], itemA);

      await expect(
        depleteLogged(orderId, businessDay, [
          { orderLineId: sortedLineIds[0], stockItemId: itemA, qty: '1' },
          { orderLineId: sortedLineIds[1], stockItemId: itemA, qty: '1' },
          { orderLineId: sortedLineIds[2], stockItemId: itemA, qty: '1' },
        ]),
      ).rejects.toBeInstanceOf(SaleDepletionEffectConflictError);

      expect(await snapshotMovements()).toHaveLength(0);
      expect(await snapshotAllocations()).toHaveLength(0);
    });

    it('LAST triple (of three) conflicts -> conflict reported, ZERO Inventory mutation', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);
      const sortedLineIds = [...lineIds].sort();
      await preExistingEffect(sortedLineIds[2], itemA);

      await expect(
        depleteLogged(orderId, businessDay, [
          { orderLineId: sortedLineIds[0], stockItemId: itemA, qty: '1' },
          { orderLineId: sortedLineIds[1], stockItemId: itemA, qty: '1' },
          { orderLineId: sortedLineIds[2], stockItemId: itemA, qty: '1' },
        ]),
      ).rejects.toBeInstanceOf(SaleDepletionEffectConflictError);

      expect(await snapshotMovements()).toHaveLength(0);
      expect(await snapshotAllocations()).toHaveLength(0);
    });

    it('MULTIPLE conflicts -> the thrown error names EVERY missing identity, not only the first', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);
      const sortedLineIds = [...lineIds].sort();
      await preExistingEffect(sortedLineIds[0], itemA);
      await preExistingEffect(sortedLineIds[2], itemA);

      let caught: SaleDepletionEffectConflictError | undefined;
      try {
        await depleteLogged(orderId, businessDay, [
          { orderLineId: sortedLineIds[0], stockItemId: itemA, qty: '1' },
          { orderLineId: sortedLineIds[1], stockItemId: itemA, qty: '1' },
          { orderLineId: sortedLineIds[2], stockItemId: itemA, qty: '1' },
        ]);
      } catch (e) {
        caught = e as SaleDepletionEffectConflictError;
      }
      expect(caught).toBeInstanceOf(SaleDepletionEffectConflictError);
      expect(caught!.message).toContain(sortedLineIds[0]);
      expect(caught!.message).toContain(sortedLineIds[2]);
      expect(caught!.message).toContain('2 of 3');
    });
  });

  // ============================================================== §6/§7 --
  describe('rollback proof — partial reservation success, then a conflict', () => {
    it('2 new effects would-be-inserted + 1 pre-existing conflict -> the WHOLE transaction rolls back, zero new effects persist', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const itemB = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const [lo, hi] = itemA < itemB ? [itemA, itemB] : [itemB, itemA];
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);
      const sortedLineIds = [...lineIds].sort();
      // Conflict on the MIDDLE stock key (hi) only.
      await preExistingEffect(sortedLineIds[0], hi);

      const effectsBefore = await snapshotEffects();
      const movementsBefore = await snapshotMovements();
      const allocationsBefore = await snapshotAllocations();
      const batchLoBefore = await snapshotBatch(
        (
          await admin.stockBatch.findFirstOrThrow({
            where: { stockItemId: lo },
          })
        ).id,
      );
      const batchHiBefore = await snapshotBatch(
        (
          await admin.stockBatch.findFirstOrThrow({
            where: { stockItemId: hi },
          })
        ).id,
      );

      await expect(
        depleteLogged(orderId, businessDay, [
          // lo has NO pre-existing conflict -> the single reservation
          // statement WOULD insert these two rows...
          { orderLineId: sortedLineIds[1], stockItemId: lo, qty: '1' },
          { orderLineId: sortedLineIds[2], stockItemId: lo, qty: '1' },
          // ...while skipping this one (pre-existing conflict on hi).
          { orderLineId: sortedLineIds[0], stockItemId: hi, qty: '1' },
        ]),
      ).rejects.toBeInstanceOf(SaleDepletionEffectConflictError);

      // The containing transaction rolled back EVERY newly-reserved
      // effect, not just the conflicting one.
      expect(await snapshotEffects()).toEqual(effectsBefore);
      expect(await snapshotMovements()).toEqual(movementsBefore);
      expect(await snapshotAllocations()).toEqual(allocationsBefore);
      const batchLoAfter = await snapshotBatch(batchLoBefore.id);
      const batchHiAfter = await snapshotBatch(batchHiBefore.id);
      expect(
        batchLoAfter.quantityRemaining.equals(batchLoBefore.quantityRemaining),
      ).toBe(true);
      expect(
        batchHiAfter.quantityRemaining.equals(batchHiBefore.quantityRemaining),
      ).toBe(true);
    });
  });

  // ============================================================== §D --
  describe('duplicate request identity — sabotage', () => {
    it('two components of the SAME line targeting the SAME stock item -> rejected fail-closed, before any SQL', async () => {
      const itemA = await mkFifoItem([
        { qty: '10', unitCost: 100n, createdAt: new Date('2026-01-01') },
      ]);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(1);

      const effectsBefore = await snapshotEffects();

      let caught: SaleDepletionEffectConflictError | undefined;
      try {
        await depleteLogged(orderId, businessDay, [
          { orderLineId: lineIds[0], stockItemId: itemA, qty: '1' },
          { orderLineId: lineIds[0], stockItemId: itemA, qty: '2' },
        ]);
      } catch (e) {
        caught = e as SaleDepletionEffectConflictError;
      }
      expect(caught).toBeInstanceOf(SaleDepletionEffectConflictError);
      expect(caught!.message).toContain('Duplicate depletion effect identity');

      // Fail-closed BEFORE any SQL: no reservation statement was even
      // issued (the only statements are set_config + ROLLBACK).
      const reservationInserts = loggedQueries.filter((q) =>
        q.includes('INSERT INTO "inventory"."sale_depletion_effects"'),
      );
      expect(reservationInserts).toHaveLength(0);
      expect(await snapshotEffects()).toEqual(effectsBefore);
    });
  });

  // ============================================================== §9.3 --
  describe('weighted-average cost hoist', () => {
    it('THREE effects on the SAME weighted-average item -> ONE stock_levels average_cost lookup, not three', async () => {
      const itemWA = await mkWeightedAverageItem(1_500n);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(3);

      const result = await depleteLogged(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemWA, qty: '1' },
        { orderLineId: lineIds[1], stockItemId: itemWA, qty: '2' },
        { orderLineId: lineIds[2], stockItemId: itemWA, qty: '3' },
      ]).catch((e: unknown) => {
        if (e instanceof RollbackSentinel) return e.result;
        throw e;
      });

      const allAllocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      expect(allAllocations).toHaveLength(3);
      for (const a of allAllocations) {
        expect(a.unitCost).toBe(1_500n);
      }

      const averageCostReads = loggedQueries.filter(
        (q) =>
          q.includes('"inventory"."stock_levels"') &&
          q.includes('average_cost') &&
          q.toUpperCase().startsWith('SELECT'),
      );
      expect(averageCostReads).toHaveLength(1);
    });

    it('weighted-average item with NO stock_levels row yet -> unit cost 0, same as pre-A1-3A default semantics', async () => {
      const itemWA = await mkWeightedAverageItem(); // no stock_levels row created
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(1);

      const result = await depleteLogged(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemWA, qty: '1' },
      ]).catch((e: unknown) => {
        if (e instanceof RollbackSentinel) return e.result;
        throw e;
      });

      const allAllocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      expect(allAllocations).toHaveLength(1);
      expect(allAllocations[0].unitCost).toBe(0n);
    });

    it('FIFO item alongside a weighted-average item -> FIFO allocation cost comes from the batch, NEVER the average-cost map', async () => {
      const itemFifo = await mkFifoItem([
        { qty: '10', unitCost: 777n, createdAt: new Date('2026-01-01') },
      ]);
      const itemWA = await mkWeightedAverageItem(1_500n);
      const { orderId, businessDay, lineIds } = await mkOrderWithLines(2);

      const result = await depleteLogged(orderId, businessDay, [
        { orderLineId: lineIds[0], stockItemId: itemFifo, qty: '1' },
        { orderLineId: lineIds[1], stockItemId: itemWA, qty: '1' },
      ]).catch((e: unknown) => {
        if (e instanceof RollbackSentinel) return e.result;
        throw e;
      });

      const allAllocations = result.perLine.flatMap((pl) =>
        pl.effects.flatMap((e) => e.allocations),
      );
      const fifoAlloc = allAllocations.find((a) => a.costBasisBatchId !== null);
      const waAlloc = allAllocations.find((a) => a.costBasisBatchId === null);
      expect(fifoAlloc!.unitCost).toBe(777n);
      expect(waAlloc!.unitCost).toBe(1_500n);
    });
  });
});
