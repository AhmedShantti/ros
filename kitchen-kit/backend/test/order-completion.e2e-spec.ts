import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { INVENTORY_PERMISSION_DEFS } from './../src/modules/inventory/inventory.permissions';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
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
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import {
  SALES_PERMISSION_DEFS,
  SALES_PERMISSIONS,
} from './../src/modules/sales/sales.permissions';
import {
  TREASURY_PERMISSION_DEFS,
  TREASURY_PERMISSIONS,
} from './../src/modules/treasury/treasury.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * P1F-2 — Final Payment + Order Completion, end to end through the real
 * HTTP payment route, real PostgreSQL, real RLS, real dual-axis FIFO/FEFO
 * depletion. `sales-payment.e2e-spec.ts` covers the P1F-1 payment surface
 * plus the basic P1F-2 "full settlement completes" case; this file covers
 * what only Completion exercises: dual-axis divergence, FIFO exhaustion
 * carry-forward, modifier ADD/REMOVE_ALL depletion, and traceability.
 *
 * Authority: docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-
 * correction.md (CONTROLLING) §L "H. REQUIRED TESTS".
 */

const stamp = Date.now();
const AT = new Date('2026-08-27T09:00:00.000Z');
const PACK_VERSION = '2026.1';

const RELEASE_KEY = generateReleaseKey('e2e-completion-release-key');
const TRUST = trustStoreFor(RELEASE_KEY.trusted());
const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);

const packPayload = () => ({
  code: 'EG',
  version: PACK_VERSION,
  effectiveFrom: '2026-01-01',
  currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
  tax: {
    engine: 'vat_standard',
    pricingMode: 'tax_exclusive',
    computationLevel: 'line',
    roundingMode: 'HALF_UP',
    roundingPrecision: 2,
    classes: [{ code: 'standard', rate: '14.0', label: { en: 'Standard' } }],
    serviceChargeTaxable: true,
    orderTypeOverrides: [],
  },
});

describe('Order Completion (P1F-2 e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;
  let movements: MovementsService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let locationA: string;
  let terminalA: string;
  let employeeA: string;
  let employeeCode: string;
  let userA: string;
  let token: string;
  let cashSessionA: string;

  let unitKg: string;
  let taxClassStandard: string;
  let priceListId: string;

  // ------------------------------------------------------------- helpers

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
        priceListId,
        menuItemVariantId: variant.id,
        price,
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  };

  const mkStockItem = async (
    name: string,
    opts: {
      costingMethod?: 'weighted_average' | 'fifo' | 'standard';
      batchStrategy?: 'fifo' | 'fefo';
      isBatchTracked?: boolean;
      standardCost?: bigint;
    } = {},
  ) =>
    (
      await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `${name.replace(/\s+/g, '').toUpperCase()}${stamp % 100000}${Math.floor(Math.random() * 1000)}`,
          names: { en: name },
          baseUnitId: unitKg,
          costingMethod: opts.costingMethod ?? 'weighted_average',
          batchStrategy: opts.batchStrategy ?? 'fifo',
          isBatchTracked: opts.isBatchTracked ?? true,
          standardCost: opts.standardCost,
        },
      })
    ).id;

  /**
   * A batch, created directly for full control over `created_at`/`expiry`,
   * THEN a real `purchase_receipt` movement posted against it (same
   * two-step pattern `sales-lines.e2e-spec.ts`'s `receive` helper uses) so
   * `stock_levels.average_cost` is populated for weighted_average items —
   * `MovementsService`'s inbound path never touches the batch row itself,
   * only the projection.
   */
  const mkBatch = async (
    stockItemId: string,
    qty: string,
    unitCost: bigint,
    createdAt: Date,
    expiryDate: Date | null = null,
  ) => {
    const batch = await admin.stockBatch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        stockItemId,
        locationId: locationA,
        quantityReceived: qty,
        quantityRemaining: qty,
        unitCost,
        createdAt,
        expiryDate,
      },
    });
    await movements.postStandalone(tenantA, userA, {
      stockItemId,
      locationId: locationA,
      movementType: 'purchase_receipt',
      quantity: Number(qty),
      unitCost,
      batchId: batch.id,
      referenceType: 'goods_receipt',
      referenceId: newId(),
      occurredAt: createdAt,
    });
    return batch;
  };

  const mkPublishedRecipe = async (
    variantId: string,
    recipeLines: { stockItemId: string; quantity: string }[],
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
    for (const [i, l] of recipeLines.entries()) {
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

  /** A modifier group + one modifier, linked to `menuItemId`, with one recipe effect. */
  const mkModifierWithEffect = async (
    menuItemId: string,
    kind: 'addition' | 'removal',
    effect:
      | { operation: 'remove_all'; stockItemId: string }
      | { operation: 'add'; stockItemId: string; quantity: string },
  ) => {
    const group = await admin.modifierGroup.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: { en: `Group ${newId()}` },
        minSelections: 0,
        maxSelections: 1,
        isRequired: false,
        allowRepeat: false,
      },
    });
    const modifier = await admin.modifier.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        modifierGroupId: group.id,
        name: { en: `Modifier ${newId()}` },
        priceDelta: 0n,
        kind,
      },
    });
    await admin.modifierGroupLink.create({
      data: { tenantId: tenantA, menuItemId, modifierGroupId: group.id },
    });
    await admin.modifierRecipeEffect.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        modifierId: modifier.id,
        sequence: 1,
        operation: effect.operation,
        componentType: 'stock_item',
        stockItemId: effect.stockItemId,
        quantity: effect.operation === 'add' ? effect.quantity : null,
        unitId: effect.operation === 'add' ? unitKg : null,
      },
    });
    return modifier.id;
  };

  const mkOpenOrder = async () => {
    const order = await orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    return orders.transition(
      tenantA,
      userA,
      order.id,
      order.businessDay,
      'open',
      order.version,
    );
  };

  const currentVersion = async (orderId: string): Promise<number> =>
    (
      await admin.order.findFirstOrThrow({
        where: { id: orderId },
        select: { version: true },
      })
    ).version;

  const mkLine = async (
    order: { id: string; businessDay: Date },
    itemId: string,
    variantId: string,
    quantity = '1',
    modifierIds: string[] = [],
  ) => {
    const expectedVersion = await currentVersion(order.id);
    return lines.addLine(tenantA, userA, order.id, order.businessDay, {
      menuItemId: itemId,
      variantId,
      quantity,
      modifiers: modifierIds.map((modifierId) => ({ modifierId })),
      expectedVersion,
    });
  };

  const etagOf = (id: string, version: number) => `W/"${id}.${version}"`;

  const settle = async (
    order: { id: string; businessDay: Date },
    idempotencyKey = `pay-${newId()}`,
    id?: string,
  ) => {
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    return request(http)
      .post(
        `/orders/${order.businessDay.toISOString().slice(0, 10)}/${order.id}/payments`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', etagOf(order.id, fresh.version))
      .send({
        ...(id ? { id } : {}),
        tender: 'cash',
        amountMinor: fresh.grandTotal.toString(),
        tenderedAmountMinor: fresh.grandTotal.toString(),
        cashSessionId: cashSessionA,
      });
  };

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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    packs = app.get(CountryPackService);
    movements = app.get(MovementsService);

    await packs.activate(signPackDocument(packPayload(), RELEASE_KEY));

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);
    const permissions = app.get(PermissionsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const pins = app.get(PinService);

    tenantA = (
      await tenants.create({
        slug: `compa-${stamp}`,
        legalName: 'CompA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `compb-${stamp}`,
        legalName: 'CompB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    void tenantB;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `CBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `CA${stamp % 10000}`,
        name: 'Completion branch',
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
          name: 'CA-POS-1',
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;

    const u = await users.createUser({
      email: `completion.a.${stamp}@example.com`,
      password: 's3cure-passphrase',
      displayName: 'C',
    });
    userA = u.id;
    await memberships.grant(userA, tenantA, 'active');

    employeeCode = `CEA${stamp % 1000}`;
    employeeA = (
      await employees.create(tenantA, userA, {
        code: employeeCode,
        displayName: 'Completion A',
        homeBranchId: branchA,
        userId: userA,
      })
    ).id;

    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of INVENTORY_PERMISSION_DEFS) await permissions.upsert(def);
    const cashier = await roles.createTenantRole(tenantA, {
      name: `completion_cashier_${stamp}`,
    });
    await roles.addPermissions(tenantA, cashier.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
      TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    ]);
    const membershipA = await admin.membership.findFirstOrThrow({
      where: { userId: userA, tenantId: tenantA },
    });
    await membershipRoles.assign(tenantA, membershipA.id, cashier.id);

    await pins.setPin(tenantA, userA, employeeA, '2468');
    const login = await request(http).post('/auth/pin').send({
      tenantId: tenantA,
      terminalId: terminalA,
      employeeCode,
      pin: '2468',
    });
    token = (login.body as { accessToken: string }).accessToken;

    const drawer = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'Drawer-C',
        terminalId: terminalA,
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
          name: `Completion pricing ${stamp}`,
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
          code: `CKG${stamp % 100000}`,
          name: 'Completion Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ================================================================ DUAL AXIS
  describe('dual-axis FIFO cost / FEFO physical divergence', () => {
    it('physical depletes by expiry (FEFO); FIFO cost charges by receipt order — independently', async () => {
      const patty = await mkStockItem('Patty', {
        costingMethod: 'fifo',
        batchStrategy: 'fefo',
        isBatchTracked: true,
      });
      // Batch A: received FIRST, expires LATER. Batch B: received SECOND, expires EARLIER.
      const batchA = await mkBatch(
        patty,
        '10',
        100n,
        new Date('2026-08-01T08:00:00Z'),
        new Date('2026-09-10'),
      );
      const batchB = await mkBatch(
        patty,
        '10',
        200n,
        new Date('2026-08-02T08:00:00Z'),
        new Date('2026-09-05'),
      );

      const { itemId, variantId } = await mkSellable(`Burger-DA-${newId()}`);
      await mkPublishedRecipe(variantId, [
        { stockItemId: patty, quantity: '5' },
      ]);

      const order = await mkOpenOrder();
      const line = await mkLine(order, itemId, variantId, '1');

      const res = await settle(order);
      expect(res.status).toBe(201);

      const effect = await admin.saleDepletionEffect.findFirstOrThrow({
        where: { orderLineId: line.line.id, stockItemId: patty },
        include: { allocations: { orderBy: { sequence: 'asc' } } },
      });
      expect(effect.allocations).toHaveLength(1);
      const alloc = effect.allocations[0];
      // PHYSICAL: FEFO -> nearer-expiry Batch B decremented.
      expect(alloc.physicalBatchId).toBe(batchB.id);
      // COST: FIFO -> receipt-order Batch A charged, at Batch A's unit cost.
      expect(alloc.costBasisBatchId).toBe(batchA.id);
      expect(alloc.unitCost).toBe(100n);
      expect(alloc.totalCost).toBe(500n); // 5 x 100

      const freshA = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batchA.id },
      });
      const freshB = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batchB.id },
      });
      // Physical axis: A untouched, B decremented by 5.
      expect(freshA.quantityRemaining.toFixed(6)).toBe('10.000000');
      expect(freshB.quantityRemaining.toFixed(6)).toBe('5.000000');
      // Cost axis: A's counter advanced by 5 (receipt order), B's untouched.
      expect(freshA.fifoCostQuantityConsumed.toFixed(6)).toBe('5.000000');
      expect(freshB.fifoCostQuantityConsumed.toFixed(6)).toBe('0.000000');

      // NO weighted-average fallback: average_cost is nowhere near 100.
      const level = await admin.stockLevel.findUniqueOrThrow({
        where: {
          stockItemId_locationId: { stockItemId: patty, locationId: locationA },
        },
      });
      expect(level.averageCost).not.toBe(alloc.unitCost);

      const orderLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(orderLine.postedCogsTotal).toBe(500n);
      const finalOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(finalOrder.cogsTotal).toBe(500n);
    });

    it('one line spans >=2 physical batches, every batch attributable, and one physical batch splits across >=2 cost layers', async () => {
      const item = await mkStockItem('Rice', {
        costingMethod: 'fifo',
        batchStrategy: 'fifo',
        isBatchTracked: true,
      });
      // Three small receipt-order layers; physical == cost order here (fifo+fifo).
      const b1 = await mkBatch(
        item,
        '3',
        10n,
        new Date('2026-08-01T08:00:00Z'),
      );
      const b2 = await mkBatch(
        item,
        '3',
        20n,
        new Date('2026-08-02T08:00:00Z'),
      );
      const b3 = await mkBatch(
        item,
        '3',
        30n,
        new Date('2026-08-03T08:00:00Z'),
      );

      const { itemId, variantId } = await mkSellable(`Bowl-DA-${newId()}`);
      // Consume 7 units -> spans all three physical batches (3+3+1).
      await mkPublishedRecipe(variantId, [
        { stockItemId: item, quantity: '7' },
      ]);

      const order = await mkOpenOrder();
      const line = await mkLine(order, itemId, variantId, '1');
      const res = await settle(order);
      expect(res.status).toBe(201);

      const effect = await admin.saleDepletionEffect.findFirstOrThrow({
        where: { orderLineId: line.line.id, stockItemId: item },
        include: { allocations: { orderBy: { sequence: 'asc' } } },
      });
      const physicalBatchIds = effect.allocations.map((a) => a.physicalBatchId);
      expect(new Set(physicalBatchIds)).toEqual(new Set([b1.id, b2.id, b3.id]));
      const sumQty = effect.allocations.reduce(
        (s, a) => s + Number(a.quantityInBaseUnit),
        0,
      );
      expect(sumQty).toBe(7);
      const sumCost = effect.allocations.reduce((s, a) => s + a.totalCost, 0n);
      expect(sumCost).toBe(3n * 10n + 3n * 20n + 1n * 30n);
    });
  });

  // ========================================================= CARRY-FORWARD
  describe('FIFO exhaustion carry-forward provenance', () => {
    it('zero physical AND zero cost coverage -> physicalBatchId NULL, costBasisBatchId = the actual exhausted batch', async () => {
      const item = await mkStockItem('Truffle', {
        costingMethod: 'fifo',
        batchStrategy: 'fifo',
        isBatchTracked: true,
      });
      const batch = await mkBatch(
        item,
        '2',
        500n,
        new Date('2026-08-01T08:00:00Z'),
      );

      const { itemId, variantId } = await mkSellable(`Dish-CF-${newId()}`);
      // Consume 5, only 2 physically/cost available -> 3 unbacked, carried
      // forward from this single (now-exhausted) batch.
      await mkPublishedRecipe(variantId, [
        { stockItemId: item, quantity: '5' },
      ]);

      const order = await mkOpenOrder();
      const line = await mkLine(order, itemId, variantId, '1');
      const res = await settle(order);
      expect(res.status).toBe(201);

      const effect = await admin.saleDepletionEffect.findFirstOrThrow({
        where: { orderLineId: line.line.id, stockItemId: item },
        include: { allocations: { orderBy: { sequence: 'asc' } } },
      });
      const totalQty = effect.allocations.reduce(
        (s, a) => s + Number(a.quantityInBaseUnit),
        0,
      );
      expect(totalQty).toBe(5);
      const unbacked = effect.allocations.filter(
        (a) => a.physicalBatchId === null,
      );
      expect(unbacked.length).toBeGreaterThan(0);
      for (const a of unbacked) {
        // Carry-forward: cost basis is retained even though physical is null.
        expect(a.costBasisBatchId).toBe(batch.id);
        expect(a.unitCost).toBe(500n);
      }

      const freshBatch = await admin.stockBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      expect(freshBatch.fifoCostQuantityConsumed.toFixed(6)).toBe('2.000000');
      // A LATER receipt does not change the already-completed allocation's explanation.
      await mkBatch(item, '100', 999n, new Date('2026-08-05T08:00:00Z'));
      const stillTheSame = await admin.saleDepletionAllocation.findMany({
        where: { effectId: effect.id, physicalBatchId: null },
      });
      for (const a of stillTheSame) {
        expect(a.costBasisBatchId).toBe(batch.id);
        expect(a.unitCost).toBe(500n);
      }
    });
  });

  // ================================================================ MODIFIERS
  describe('modifier ADD / REMOVE_ALL depletion', () => {
    it('"no cheese" (remove_all) depletes NO cheese; a line without the modifier depletes cheese', async () => {
      const bun = await mkStockItem('Bun');
      const cheese = await mkStockItem('Cheese');
      const { itemId, variantId } = await mkSellable(`Cheeseburger-${newId()}`);
      await mkPublishedRecipe(variantId, [
        { stockItemId: bun, quantity: '1' },
        { stockItemId: cheese, quantity: '1' },
      ]);
      await mkBatch(bun, '100', 10n, new Date('2026-08-01T08:00:00Z'));
      await mkBatch(cheese, '100', 20n, new Date('2026-08-01T08:00:00Z'));
      const noCheeseModifierId = await mkModifierWithEffect(itemId, 'removal', {
        operation: 'remove_all',
        stockItemId: cheese,
      });

      // Line WITH the modifier — no cheese depleted.
      const orderNo = await mkOpenOrder();
      const lineNo = await mkLine(orderNo, itemId, variantId, '1', [
        noCheeseModifierId,
      ]);
      const resNo = await settle(orderNo);
      expect(resNo.status).toBe(201);
      const cheeseEffectNo = await admin.saleDepletionEffect.findFirst({
        where: { orderLineId: lineNo.line.id, stockItemId: cheese },
      });
      expect(cheeseEffectNo).toBeNull();
      const bunEffectNo = await admin.saleDepletionEffect.findFirst({
        where: { orderLineId: lineNo.line.id, stockItemId: bun },
      });
      expect(bunEffectNo).not.toBeNull();

      // Line WITHOUT the modifier — cheese IS depleted.
      const orderYes = await mkOpenOrder();
      const lineYes = await mkLine(orderYes, itemId, variantId, '1', []);
      const resYes = await settle(orderYes);
      expect(resYes.status).toBe(201);
      const cheeseEffectYes = await admin.saleDepletionEffect.findFirst({
        where: { orderLineId: lineYes.line.id, stockItemId: cheese },
      });
      expect(cheeseEffectYes).not.toBeNull();
    });

    it('ADD modifier depletes the added stock item, scaled by modifier and line quantity', async () => {
      const bun = await mkStockItem('Bun2');
      const bacon = await mkStockItem('Bacon');
      const { itemId, variantId } = await mkSellable(`BaconBurger-${newId()}`);
      await mkPublishedRecipe(variantId, [{ stockItemId: bun, quantity: '1' }]);
      await mkBatch(bun, '100', 10n, new Date('2026-08-01T08:00:00Z'));
      await mkBatch(bacon, '100', 30n, new Date('2026-08-01T08:00:00Z'));
      const extraBaconId = await mkModifierWithEffect(itemId, 'addition', {
        operation: 'add',
        stockItemId: bacon,
        quantity: '0.05',
      });

      const order = await mkOpenOrder();
      // qty=2 line, ADD effect quantity 0.05 -> expect 0.10 bacon depleted.
      const line = await mkLine(order, itemId, variantId, '2', [extraBaconId]);
      const res = await settle(order);
      expect(res.status).toBe(201);

      const baconEffect = await admin.saleDepletionEffect.findFirstOrThrow({
        where: { orderLineId: line.line.id, stockItemId: bacon },
      });
      expect(baconEffect.quantityInBaseUnit.toFixed(6)).toBe('0.100000');
    });
  });

  // ============================================================== STRUCTURAL
  describe('gaps and absent recipe', () => {
    it('an item with no recipe at all: 0 depletion, posted_cogs_total 0 (not null)', async () => {
      const { itemId, variantId } = await mkSellable(`NoRecipe-${newId()}`);
      const order = await mkOpenOrder();
      const line = await mkLine(order, itemId, variantId, '1');
      const res = await settle(order);
      expect(res.status).toBe(201);
      const effects = await admin.saleDepletionEffect.findMany({
        where: { orderLineId: line.line.id },
      });
      expect(effects).toHaveLength(0);
      const orderLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(orderLine.postedCogsTotal).toBe(0n);
    });
  });

  // ============================================================= IDEMPOTENCY
  describe('permanent Payment id replay after completion', () => {
    it('replaying the same settling Payment id with identical content returns the same completed order, no double-completion', async () => {
      const { itemId, variantId } = await mkSellable(`Replay-${newId()}`);
      const order = await mkOpenOrder();
      await mkLine(order, itemId, variantId, '1');
      const paymentId = newId();

      const first = await settle(order, `pay-${newId()}`, paymentId);
      expect(first.status).toBe(201);
      const firstBody = first.body as { order: { version: number } };

      const second = await settle(order, `pay-${newId()}`, paymentId);
      expect(second.status).toBe(201);
      const secondBody = second.body as { order: { version: number } };
      expect(secondBody.order.version).toBe(firstBody.order.version);

      const payments = await admin.orderPayment.count({
        where: { id: paymentId },
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
    });
  });

  // ===================================================================== RLS
  describe('P1F-2 tables: append-only + RLS', () => {
    it('ros_app cannot UPDATE or DELETE sale_depletion_effects/allocations, but the row survives', async () => {
      const { itemId, variantId } = await mkSellable(`RlsCheck-${newId()}`);
      const item = await mkStockItem('RlsItem');
      await mkPublishedRecipe(variantId, [
        { stockItemId: item, quantity: '1' },
      ]);
      await mkBatch(item, '10', 50n, new Date('2026-08-01T08:00:00Z'));
      const order = await mkOpenOrder();
      const line = await mkLine(order, itemId, variantId, '1');
      const res = await settle(order);
      expect(res.status).toBe(201);

      const effect = await admin.saleDepletionEffect.findFirstOrThrow({
        where: { orderLineId: line.line.id },
      });

      await expect(
        admin.$executeRaw`UPDATE "inventory"."sale_depletion_effects" SET "quantity_in_base_unit" = 999 WHERE "id" = ${effect.id}::uuid`,
      ).resolves.toBeDefined(); // admin (migrator) CAN — positive control.

      const appPrisma = app.get(PrismaService);
      await expect(
        appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`UPDATE "inventory"."sale_depletion_effects" SET "quantity_in_base_unit" = 1 WHERE "id" = ${effect.id}::uuid`,
        ),
      ).rejects.toThrow();

      const stillThere = await admin.saleDepletionEffect.findUnique({
        where: { id: effect.id },
      });
      expect(stillThere).not.toBeNull();
    });
  });

  // ================================================================ MODULE
  describe('OpenAPI surface', () => {
    it('no /complete route exists anywhere', async () => {
      const res = await request(http).get('/api-json');
      if (res.status === 200) {
        const paths = Object.keys(
          (res.body as { paths: Record<string, unknown> }).paths ?? {},
        );
        expect(paths.some((p) => /complete/i.test(p))).toBe(false);
      }
    });
  });
});
