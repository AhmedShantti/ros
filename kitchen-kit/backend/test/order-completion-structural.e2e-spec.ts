import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
import { MovementsService } from './../src/modules/inventory/movements/movements.service';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1F-2 acceptance closure §3 — structural FK negative proofs for C-20
 * (`2026-08-25_P1F2E-A_inventory-acceptance-correction.md` (CONTROLLING)
 * §G / §L "H. REQUIRED TESTS" / STRUCTURAL).
 *
 * These prove real PostgreSQL FK REJECTION, not service behaviour:
 *   1. allocation.physicalBatchId -> a batch of a DIFFERENT stock item
 *   2. allocation.physicalBatchId -> a batch at a DIFFERENT location
 *   3. allocation.costBasisBatchId -> a batch of a DIFFERENT stock item
 *   4. allocation.costBasisBatchId -> a batch at a DIFFERENT location
 *   5. cross-tenant: an allocation cannot bind to another tenant's effect
 *      (the tenant_id column is embedded in every composite FK)
 *
 * The allocation<->movement item/location binding is explicitly NOT
 * structural (P1F2E-A §G: a 4th unique index on the RANGE-partitioned,
 * highest-volume `stock_movements` table was deliberately rejected as a
 * permanent tax on the hottest write path) — it is SERVICE-ENFORCED, and
 * the final test here proves that as service behaviour, not as an encoded
 * DB invariant. Reporting must not claim otherwise.
 */
describe('Structural FK negative proofs — C-20 (P1F-2 acceptance closure §3)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let movements: MovementsService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;

  const stamp = Date.now();
  const AT = new Date('2026-08-28T10:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-structural-release-key');
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

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let locationA: string;
  let locationA2: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let priceListA: string;
  let taxClassStandard: string;
  let cashSessionA: string;
  let unitKg: string;

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
    movements = app.get(MovementsService);
    paymentService = app.get(SalesPaymentService);
    packs = app.get(CountryPackService);

    await packs.activate(testPackDocument());

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `struct-a-${stamp}`,
        legalName: 'StructA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `struct-b-${stamp}`,
        legalName: 'StructB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `StructBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `ST${stamp % 10000}`,
        name: 'Structural Branch',
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
    // A second, DISTINCT location under the SAME tenant, for the
    // location-mismatch cases — `ck_location_target` requires a real
    // warehouse row, so a second branch is the simplest legal second target.
    const warehouse = await admin.warehouse.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: 'Structural Warehouse',
      },
    });
    locationA2 = (
      await admin.location.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          locationType: 'warehouse',
          refId: warehouse.id,
          warehouseId: warehouse.id,
        },
      })
    ).id;

    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'Struct-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `struct.race.${stamp}@example.com`,
        displayName: 'Struct',
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
        code: `STE${stamp % 1000}`,
        displayName: 'Struct Employee',
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
          name: 'Structural pricing',
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
        name: 'Struct Drawer',
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
          code: `STKG${stamp % 100000}`,
          name: 'Structural Kilogram',
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

  const mkStockItem = async (name: string) =>
    (
      await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `${name}${stamp % 1000}${Math.floor(Math.random() * 1000)}`.slice(
            0,
            32,
          ),
          names: { en: name },
          baseUnitId: unitKg,
          costingMethod: 'fifo',
          batchStrategy: 'fifo',
          isBatchTracked: true,
        },
      })
    ).id;

  const mkBatch = async (
    stockItemId: string,
    locationId: string,
    qty: string,
    unitCost: bigint,
  ) => {
    const batch = await admin.stockBatch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        stockItemId,
        locationId,
        quantityReceived: qty,
        quantityRemaining: qty,
        unitCost,
        createdAt: new Date('2026-08-01T08:00:00Z'),
      },
    });
    await movements.postStandalone(tenantA, userA, {
      stockItemId,
      locationId,
      movementType: 'purchase_receipt',
      quantity: Number(qty),
      unitCost,
      batchId: batch.id,
      referenceType: 'goods_receipt',
      referenceId: newId(),
      occurredAt: new Date('2026-08-01T08:00:00Z'),
    });
    return batch;
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

  /** Produces one real, committed `sale_depletion_effects` +
   *  `sale_depletion_allocations` row for (stockItemId, locationA) via a
   *  genuine Completion — the fixture every negative test attaches its
   *  illegal row to. */
  const mkRealEffect = async (stockItemId: string) => {
    const { itemId, variantId } = await mkSellable(`Struct-${newId()}`);
    await mkPublishedRecipe(variantId, stockItemId, '2');
    const order = await orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    const { line } = await lines.addLine(
      tenantA,
      userA,
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
      tenantA,
      userA,
      order.id,
      order.businessDay,
      'open',
      order.version + 1,
    );
    await paymentService.capture(tenantA, userA, {
      orderId: opened.id,
      businessDay: opened.businessDay,
      expectedVersion: opened.version,
      tender: 'cash',
      amountMinor: opened.grandTotal,
      cashSessionId: cashSessionA,
      employeeId: employeeA,
      terminalId: terminalA,
      tenderedAmountMinor: opened.grandTotal,
    });
    const effect = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: line.id, stockItemId },
    });
    return effect;
  };

  it('1. allocation.physical_batch_id cannot reference a batch of a DIFFERENT stock item', async () => {
    const itemA = await mkStockItem('StructItemA1');
    const itemB = await mkStockItem('StructItemB1');
    await mkBatch(itemA, locationA, '10', 50n);
    const batchB = await mkBatch(itemB, locationA, '10', 60n);
    const effect = await mkRealEffect(itemA);

    await expect(
      admin.$executeRaw`
        INSERT INTO "inventory"."sale_depletion_allocations"
          ("id", "tenant_id", "effect_id", "sequence", "stock_item_id", "location_id",
           "physical_batch_id", "cost_basis_batch_id", "quantity_in_base_unit", "unit_id",
           "unit_cost", "total_cost", "movement_id", "movement_occurred_at", "created_at")
        VALUES (${newId()}::uuid, ${tenantA}::uuid, ${effect.id}::uuid, 99,
                ${itemA}::uuid, ${locationA}::uuid,
                ${batchB.id}::uuid, NULL,
                1, ${unitKg}::uuid, 50, 50,
                (SELECT id FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1)::uuid,
                (SELECT "occurred_at" FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1),
                now())
      `,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('2. allocation.physical_batch_id cannot reference a batch at a DIFFERENT location', async () => {
    const item = await mkStockItem('StructItemLoc1');
    await mkBatch(item, locationA, '10', 50n);
    const batchElsewhere = await mkBatch(item, locationA2, '10', 55n);
    const effect = await mkRealEffect(item);

    await expect(
      admin.$executeRaw`
        INSERT INTO "inventory"."sale_depletion_allocations"
          ("id", "tenant_id", "effect_id", "sequence", "stock_item_id", "location_id",
           "physical_batch_id", "cost_basis_batch_id", "quantity_in_base_unit", "unit_id",
           "unit_cost", "total_cost", "movement_id", "movement_occurred_at", "created_at")
        VALUES (${newId()}::uuid, ${tenantA}::uuid, ${effect.id}::uuid, 99,
                ${item}::uuid, ${locationA}::uuid,
                ${batchElsewhere.id}::uuid, NULL,
                1, ${unitKg}::uuid, 50, 50,
                (SELECT id FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1)::uuid,
                (SELECT "occurred_at" FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1),
                now())
      `,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('3. allocation.cost_basis_batch_id cannot reference a batch of a DIFFERENT stock item', async () => {
    const itemA = await mkStockItem('StructItemA3');
    const itemB = await mkStockItem('StructItemB3');
    await mkBatch(itemA, locationA, '10', 50n);
    const batchB = await mkBatch(itemB, locationA, '10', 60n);
    const effect = await mkRealEffect(itemA);

    await expect(
      admin.$executeRaw`
        INSERT INTO "inventory"."sale_depletion_allocations"
          ("id", "tenant_id", "effect_id", "sequence", "stock_item_id", "location_id",
           "physical_batch_id", "cost_basis_batch_id", "quantity_in_base_unit", "unit_id",
           "unit_cost", "total_cost", "movement_id", "movement_occurred_at", "created_at")
        VALUES (${newId()}::uuid, ${tenantA}::uuid, ${effect.id}::uuid, 99,
                ${itemA}::uuid, ${locationA}::uuid,
                NULL, ${batchB.id}::uuid,
                1, ${unitKg}::uuid, 50, 50,
                (SELECT id FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1)::uuid,
                (SELECT "occurred_at" FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1),
                now())
      `,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('4. allocation.cost_basis_batch_id cannot reference a batch at a DIFFERENT location', async () => {
    const item = await mkStockItem('StructItemLoc4');
    await mkBatch(item, locationA, '10', 50n);
    const batchElsewhere = await mkBatch(item, locationA2, '10', 55n);
    const effect = await mkRealEffect(item);

    await expect(
      admin.$executeRaw`
        INSERT INTO "inventory"."sale_depletion_allocations"
          ("id", "tenant_id", "effect_id", "sequence", "stock_item_id", "location_id",
           "physical_batch_id", "cost_basis_batch_id", "quantity_in_base_unit", "unit_id",
           "unit_cost", "total_cost", "movement_id", "movement_occurred_at", "created_at")
        VALUES (${newId()}::uuid, ${tenantA}::uuid, ${effect.id}::uuid, 99,
                ${item}::uuid, ${locationA}::uuid,
                NULL, ${batchElsewhere.id}::uuid,
                1, ${unitKg}::uuid, 50, 50,
                (SELECT id FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1)::uuid,
                (SELECT "occurred_at" FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1),
                now())
      `,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("5. cross-tenant: an allocation cannot bind to another tenant's effect (tenant_id is embedded in every composite FK)", async () => {
    const item = await mkStockItem('StructItemTenant5');
    await mkBatch(item, locationA, '10', 50n);
    const effect = await mkRealEffect(item);

    // A row claiming tenantB, but pointing at tenantA's REAL effect id — no
    // `(tenant_id=tenantB, id=effect.id, ...)` row exists in
    // sale_depletion_effects, so the composite FK rejects it even though the
    // referenced id is perfectly real under the correct tenant.
    await expect(
      admin.$executeRaw`
        INSERT INTO "inventory"."sale_depletion_allocations"
          ("id", "tenant_id", "effect_id", "sequence", "stock_item_id", "location_id",
           "physical_batch_id", "cost_basis_batch_id", "quantity_in_base_unit", "unit_id",
           "unit_cost", "total_cost", "movement_id", "movement_occurred_at", "created_at")
        VALUES (${newId()}::uuid, ${tenantB}::uuid, ${effect.id}::uuid, 99,
                ${item}::uuid, ${locationA}::uuid,
                NULL, NULL,
                1, ${unitKg}::uuid, 50, 50,
                (SELECT id FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1)::uuid,
                (SELECT "occurred_at" FROM "inventory"."stock_movements" WHERE "tenant_id" = ${tenantA}::uuid LIMIT 1),
                now())
      `,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // ===================================================== SERVICE-ENFORCED
  it("6. SERVICE-ENFORCED (NOT a DB-structural proof): every real allocation's item/location matches its own movement's item/location", async () => {
    const item = await mkStockItem('StructMoveCon');
    await mkBatch(item, locationA, '10', 50n);
    const effect = await mkRealEffect(item);
    const allocations = await admin.saleDepletionAllocation.findMany({
      where: { effectId: effect.id },
    });
    expect(allocations.length).toBeGreaterThan(0);
    for (const alloc of allocations) {
      const movement = await admin.stockMovement.findFirstOrThrow({
        where: { id: alloc.movementId, tenantId: tenantA },
      });
      // This equality is NOT DB-encoded — P1F2E-A §G deliberately rejected a
      // 4th unique index on the RANGE-partitioned stock_movements table.
      // It holds ONLY because SaleDepletionService writes both from the
      // SAME in-memory values in the SAME statement sequence.
      expect(movement.stockItemId).toBe(alloc.stockItemId);
      expect(movement.locationId).toBe(alloc.locationId);
    }
  });
});
