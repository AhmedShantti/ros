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
import { ModifierRecipeEffectsService } from './../src/modules/production/costing/modifier-recipe-effects.service';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1F-2 acceptance closure §6 — full RLS / append-only / grants verification
 * for the two new Inventory tables AND the three new Sales snapshot tables,
 * via the REAL `ros_app` application connection (`app.get(PrismaService)`),
 * never the migrator client for the assertions themselves — per
 * `2026-08-25_P1F2E-A_inventory-acceptance-correction.md` (CONTROLLING)
 * §L "H. REQUIRED TESTS" / RLS-APPEND-ONLY.
 *
 * Tables covered:
 *   inventory.sale_depletion_effects
 *   inventory.sale_depletion_allocations
 *   sales.order_line_recipe_versions
 *   sales.order_line_modifier_effects
 *   sales.order_line_component_conversions
 */
describe('RLS / append-only / grants — P1F-2 tables (P1F-2 acceptance closure §6)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let appPrisma: PrismaService;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let movements: MovementsService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;
  let modifierEffects: ModifierRecipeEffectsService;

  const stamp = Date.now();
  const AT = new Date('2026-08-28T12:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-rls-release-key');
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

  interface TenantFixture {
    tenantId: string;
    branchId: string;
    locationId: string;
    terminalId: string;
    employeeId: string;
    userId: string;
    priceListId: string;
    taxClassStandardId: string;
    cashSessionId: string;
  }

  let unitKg: string;
  let unitBox: string;
  let A: TenantFixture;
  let B: TenantFixture;

  const mkTenantFixture = async (slug: string): Promise<TenantFixture> => {
    const tenants = app.get(TenantsService);
    const tenantId = (
      await tenants.create({
        slug,
        legalName: slug,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `Brand-${slug}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code: `${slug.slice(0, 6).toUpperCase()}`,
        name: `Branch-${slug}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    const location = await admin.location.create({
      data: {
        id: newId(),
        tenantId,
        locationType: 'branch',
        refId: branch.id,
        branchId: branch.id,
      },
    });
    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId,
        branchId: branch.id,
        name: `POS-${slug}`,
        terminalType: 'pos',
        status: 'active',
      },
    });
    const user = await admin.user.create({
      data: { id: newId(), email: `${slug}@example.com`, displayName: slug },
    });
    await admin.membership.create({
      data: { id: newId(), userId: user.id, tenantId, status: 'active' },
    });
    const employee = await admin.employee.create({
      data: {
        id: newId(),
        tenantId,
        code: `${slug.slice(0, 6).toUpperCase()}E`,
        displayName: `Employee-${slug}`,
        homeBranchId: branch.id,
        userId: user.id,
      },
    });
    await admin.employeeBranch.create({
      data: { tenantId, employeeId: employee.id, branchId: branch.id },
    });
    const taxClassStandard = await admin.taxClass.findFirstOrThrow({
      where: { tenantId, countryPackCode: 'EG', code: 'standard' },
    });
    const priceList = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId,
        name: `Pricing-${slug}`,
        scopeType: 'branch',
        scopeId: branch.id,
        status: 'active',
      },
    });
    const drawer = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId,
        branchId: branch.id,
        name: `Drawer-${slug}`,
        terminalId: null,
      },
    });
    const shift = await admin.shift.create({
      data: {
        id: newId(),
        tenantId,
        branchId: branch.id,
        employeeId: employee.id,
        status: 'open',
        openedAt: AT,
      },
    });
    const cashSession = await admin.cashSession.create({
      data: {
        id: newId(),
        tenantId,
        branchId: branch.id,
        drawerId: drawer.id,
        shiftId: shift.id,
        employeeId: employee.id,
        openingFloat: 50_000n,
        currency: 'EGP',
        status: 'open',
        openedAt: AT,
      },
    });
    return {
      tenantId,
      branchId: branch.id,
      locationId: location.id,
      terminalId: terminal.id,
      employeeId: employee.id,
      userId: user.id,
      priceListId: priceList.id,
      taxClassStandardId: taxClassStandard.id,
      cashSessionId: cashSession.id,
    };
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
    await app.init();
    admin = createMigratorClient(app);
    appPrisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    movements = app.get(MovementsService);
    paymentService = app.get(SalesPaymentService);
    packs = app.get(CountryPackService);
    modifierEffects = app.get(ModifierRecipeEffectsService);

    await packs.activate(testPackDocument());

    A = await mkTenantFixture(`rls-a-${stamp}`);
    B = await mkTenantFixture(`rls-b-${stamp}`);

    unitKg = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `RLKG${stamp % 100000}`,
          name: 'RLS Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;
    unitBox = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `RLBX${stamp % 100000}`,
          name: 'RLS Box',
          baseUnitOfDimension: false,
        },
      })
    ).id;
    await admin.uomConversion.create({
      data: {
        id: newId(),
        fromUnitId: unitBox,
        toUnitId: unitKg,
        factor: '10',
        stockItemId: null,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  /** Produces one committed row in EACH of the 5 tables under test, for tenant `t`. */
  const mkFixtureRows = async (t: TenantFixture) => {
    const item = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        sku: `RLSITEM${stamp % 1000}${Math.floor(Math.random() * 10000)}`.slice(
          0,
          32,
        ),
        names: { en: 'RLS Item' },
        baseUnitId: unitKg,
        costingMethod: 'weighted_average',
        batchStrategy: 'fifo',
        isBatchTracked: false,
      },
    });
    await movements.postStandalone(t.tenantId, t.userId, {
      stockItemId: item.id,
      locationId: t.locationId,
      movementType: 'opening_balance',
      quantity: '1000',
      unitCost: 10n,
      referenceType: 'opening_balance',
      referenceId: newId(),
      occurredAt: new Date('2026-08-01T08:00:00Z'),
    });

    const bonusItem = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        sku: `RLSBONUS${stamp % 1000}${Math.floor(Math.random() * 10000)}`.slice(
          0,
          32,
        ),
        names: { en: 'RLS Bonus Item' },
        baseUnitId: unitKg,
        costingMethod: 'weighted_average',
        batchStrategy: 'fifo',
        isBatchTracked: false,
      },
    });
    await movements.postStandalone(t.tenantId, t.userId, {
      stockItemId: bonusItem.id,
      locationId: t.locationId,
      movementType: 'opening_balance',
      quantity: '1000',
      unitCost: 5n,
      referenceType: 'opening_balance',
      referenceId: newId(),
      occurredAt: new Date('2026-08-01T08:00:00Z'),
    });

    const menuItem = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        names: { en: `RLS Sellable ${newId()}` },
        taxClassId: t.taxClassStandardId,
      },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        menuItemId: menuItem.id,
        name: { en: 'V' },
      },
    });
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        priceListId: t.priceListId,
        menuItemVariantId: variant.id,
        price: 10_000n,
        currency: 'EGP',
      },
    });

    const recipe = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        scope: 'tenant',
        recipeType: 'menu_item',
        menuItemVariantId: variant.id,
      },
    });
    const version = await admin.recipeVersion.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        recipeId: recipe.id,
        version: 1,
        status: 'published',
        yieldQuantity: '1',
        yieldUnitId: unitKg,
        yieldPercentage: '100.00',
      },
    });
    // A non-base-unit line -> populates order_line_component_conversions.
    await admin.recipeLine.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
        recipeVersionId: version.id,
        sequence: 1,
        componentType: 'stock_item',
        stockItemId: item.id,
        quantity: '1',
        unitId: unitBox,
        wastagePercentage: '0.00',
      },
    });

    // A modifier ADD effect -> populates order_line_modifier_effects.
    const group = await admin.modifierGroup.create({
      data: {
        id: newId(),
        tenantId: t.tenantId,
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
        tenantId: t.tenantId,
        modifierGroupId: group.id,
        name: { en: `Modifier ${newId()}` },
        priceDelta: 0n,
        kind: 'addition',
      },
    });
    await admin.modifierGroupLink.create({
      data: {
        tenantId: t.tenantId,
        menuItemId: menuItem.id,
        modifierGroupId: group.id,
      },
    });
    await modifierEffects.replace(t.tenantId, t.userId, modifier.id, [
      {
        sequence: 1,
        operation: 'add',
        componentType: 'stock_item',
        stockItemId: bonusItem.id,
        quantity: '1',
        unitId: unitKg,
      },
    ]);

    const order = await orders.create(t.tenantId, t.userId, {
      terminalId: t.terminalId,
      openedByEmployeeId: t.employeeId,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    const { line } = await lines.addLine(
      t.tenantId,
      t.userId,
      order.id,
      order.businessDay,
      {
        menuItemId: menuItem.id,
        variantId: variant.id,
        quantity: '1',
        modifiers: [{ modifierId: modifier.id }],
        expectedVersion: order.version,
      },
    );
    const opened = await orders.transition(
      t.tenantId,
      t.userId,
      order.id,
      order.businessDay,
      'open',
      order.version + 1,
    );
    await paymentService.capture(t.tenantId, t.userId, {
      orderId: opened.id,
      businessDay: opened.businessDay,
      expectedVersion: opened.version,
      tender: 'cash',
      amountMinor: opened.grandTotal,
      cashSessionId: t.cashSessionId,
      employeeId: t.employeeId,
      terminalId: t.terminalId,
      tenderedAmountMinor: opened.grandTotal,
    });

    const effect = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: line.id, stockItemId: item.id },
    });
    const allocation = await admin.saleDepletionAllocation.findFirstOrThrow({
      where: { effectId: effect.id },
    });
    const recipeVersionPin =
      await admin.orderLineRecipeVersion.findFirstOrThrow({
        where: { orderLineId: line.id },
      });
    const modifierEffectPin =
      await admin.orderLineModifierEffect.findFirstOrThrow({
        where: { orderLineId: line.id },
      });
    const conversionPin =
      await admin.orderLineComponentConversion.findFirstOrThrow({
        where: { orderLineId: line.id },
      });

    return {
      effect,
      allocation,
      recipeVersionPin,
      modifierEffectPin,
      conversionPin,
    };
  };

  let rowsA: Awaited<ReturnType<typeof mkFixtureRows>>;

  beforeAll(async () => {
    rowsA = await mkFixtureRows(A);
    // Tenant B gets its OWN real rows too — proves cross-tenant filtering
    // actually filters, not that B merely has no data to find.
    await mkFixtureRows(B);
  }, 30_000);

  interface TableCase {
    name: string;
    schema: 'inventory' | 'sales';
    idOf: (rows: Awaited<ReturnType<typeof mkFixtureRows>>) => string;
    countOwn: (tenantId: string, id: string) => Promise<number>;
    tamperUpdate: (id: string) => Promise<unknown>;
    tamperDelete: (id: string) => Promise<unknown>;
    stillIntact: (id: string) => Promise<boolean>;
  }

  const cases: TableCase[] = [
    {
      name: 'inventory.sale_depletion_effects',
      schema: 'inventory',
      idOf: (r) => r.effect.id,
      countOwn: (tenantId, id) =>
        appPrisma.withAuthContext({ tenantId }, (tx) =>
          tx.saleDepletionEffect.count({ where: { id } }),
        ),
      tamperUpdate: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`UPDATE "inventory"."sale_depletion_effects" SET "quantity_in_base_unit" = 999 WHERE "id" = ${id}::uuid`,
        ),
      tamperDelete: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`DELETE FROM "inventory"."sale_depletion_effects" WHERE "id" = ${id}::uuid`,
        ),
      stillIntact: async (id) =>
        (await admin.saleDepletionEffect.findUnique({ where: { id } })) !==
        null,
    },
    {
      name: 'inventory.sale_depletion_allocations',
      schema: 'inventory',
      idOf: (r) => r.allocation.id,
      countOwn: (tenantId, id) =>
        appPrisma.withAuthContext({ tenantId }, (tx) =>
          tx.saleDepletionAllocation.count({ where: { id } }),
        ),
      tamperUpdate: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`UPDATE "inventory"."sale_depletion_allocations" SET "unit_cost" = 999 WHERE "id" = ${id}::uuid`,
        ),
      tamperDelete: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`DELETE FROM "inventory"."sale_depletion_allocations" WHERE "id" = ${id}::uuid`,
        ),
      stillIntact: async (id) =>
        (await admin.saleDepletionAllocation.findUnique({ where: { id } })) !==
        null,
    },
    {
      name: 'sales.order_line_recipe_versions',
      schema: 'sales',
      idOf: (r) => r.recipeVersionPin.id,
      countOwn: (tenantId, id) =>
        appPrisma.withAuthContext({ tenantId }, (tx) =>
          tx.orderLineRecipeVersion.count({ where: { id } }),
        ),
      tamperUpdate: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`UPDATE "sales"."order_line_recipe_versions" SET "depth" = 99 WHERE "id" = ${id}::uuid`,
        ),
      tamperDelete: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`DELETE FROM "sales"."order_line_recipe_versions" WHERE "id" = ${id}::uuid`,
        ),
      stillIntact: async (id) =>
        (await admin.orderLineRecipeVersion.findUnique({ where: { id } })) !==
        null,
    },
    {
      name: 'sales.order_line_modifier_effects',
      schema: 'sales',
      idOf: (r) => r.modifierEffectPin.id,
      countOwn: (tenantId, id) =>
        appPrisma.withAuthContext({ tenantId }, (tx) =>
          tx.orderLineModifierEffect.count({ where: { id } }),
        ),
      tamperUpdate: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`UPDATE "sales"."order_line_modifier_effects" SET "sequence" = 99 WHERE "id" = ${id}::uuid`,
        ),
      tamperDelete: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`DELETE FROM "sales"."order_line_modifier_effects" WHERE "id" = ${id}::uuid`,
        ),
      stillIntact: async (id) =>
        (await admin.orderLineModifierEffect.findUnique({ where: { id } })) !==
        null,
    },
    {
      name: 'sales.order_line_component_conversions',
      schema: 'sales',
      idOf: (r) => r.conversionPin.id,
      countOwn: (tenantId, id) =>
        appPrisma.withAuthContext({ tenantId }, (tx) =>
          tx.orderLineComponentConversion.count({ where: { id } }),
        ),
      tamperUpdate: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`UPDATE "sales"."order_line_component_conversions" SET "factor" = 999 WHERE "id" = ${id}::uuid`,
        ),
      tamperDelete: (id) =>
        appPrisma.withAuthContext(
          { tenantId: A.tenantId },
          (tx) =>
            tx.$executeRaw`DELETE FROM "sales"."order_line_component_conversions" WHERE "id" = ${id}::uuid`,
        ),
      stillIntact: async (id) =>
        (await admin.orderLineComponentConversion.findUnique({
          where: { id },
        })) !== null,
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it('own-tenant SELECT succeeds; cross-tenant SELECT returns zero rows', async () => {
        const idA = c.idOf(rowsA);
        const ownCount = await c.countOwn(A.tenantId, idA);
        expect(ownCount).toBe(1);
        const crossCount = await c.countOwn(B.tenantId, idA);
        expect(crossCount).toBe(0);
      });

      it('own-tenant INSERT already succeeded via the real ros_app connection (the fixture itself is the positive control)', async () => {
        // `mkFixtureRows` ran the ENTIRE Completion through the real app
        // (OrderLinesService / SalesPaymentService), which use the SAME
        // ros_app-constrained PrismaService this suite injects as
        // `appPrisma` — so this row's very existence IS the own-tenant
        // INSERT proof, not an inference.
        const exists = await c.stillIntact(c.idOf(rowsA));
        expect(exists).toBe(true);
      });

      it('UPDATE is rejected via the real ros_app connection; the row survives unmodified', async () => {
        const id = c.idOf(rowsA);
        await expect(c.tamperUpdate(id)).rejects.toThrow();
        expect(await c.stillIntact(id)).toBe(true);
      });

      it('DELETE is rejected via the real ros_app connection; the row survives', async () => {
        const id = c.idOf(rowsA);
        await expect(c.tamperDelete(id)).rejects.toThrow();
        expect(await c.stillIntact(id)).toBe(true);
      });
    });
  }

  it('information_schema.role_table_grants: ros_app has SELECT+INSERT and NOT UPDATE/DELETE/TRUNCATE on all 5 tables', async () => {
    const tableNames = [
      'sale_depletion_effects',
      'sale_depletion_allocations',
      'order_line_recipe_versions',
      'order_line_modifier_effects',
      'order_line_component_conversions',
    ];
    const grants = await admin.$queryRaw<
      { table_schema: string; table_name: string; privilege_type: string }[]
    >`
      SELECT table_schema, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'ros_app'
        AND table_schema IN ('inventory', 'sales')
        AND table_name = ANY(${tableNames})
    `;
    for (const table of tableNames) {
      const forTable = grants.filter((g) => g.table_name === table);
      const privileges = new Set(forTable.map((g) => g.privilege_type));
      expect(privileges.has('SELECT')).toBe(true);
      expect(privileges.has('INSERT')).toBe(true);
      expect(privileges.has('UPDATE')).toBe(false);
      expect(privileges.has('DELETE')).toBe(false);
      expect(privileges.has('TRUNCATE')).toBe(false);
    }
  });
});
