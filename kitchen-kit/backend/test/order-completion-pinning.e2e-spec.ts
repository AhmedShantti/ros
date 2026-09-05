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
import { StockItemsService } from './../src/modules/inventory/stock-items/stock-items.service';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesPaymentService } from './../src/modules/sales/orders/sales-payment.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1F-2 acceptance closure §4 — historical pinning / gap semantics /
 * modifier-composition tests named by
 * `2026-08-25_P1F2E-A_inventory-acceptance-correction.md` (CONTROLLING)
 * §L "H. REQUIRED TESTS" / INVENTORY-MODIFIERS-PINNING-GAPS, plus the §5
 * modifier sub-recipe gap finding.
 */
describe('Order Completion — historical pinning, gap semantics, modifier composition (P1F-2 acceptance closure §4/§5)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let movements: MovementsService;
  let paymentService: SalesPaymentService;
  let packs: CountryPackService;
  let modifierEffects: ModifierRecipeEffectsService;
  let stockItems: StockItemsService;

  const stamp = Date.now();
  const AT = new Date('2026-08-28T11:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-pinning-release-key');
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
  let branchA: string;
  let locationA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let priceListA: string;
  let taxClassStandard: string;
  let cashSessionA: string;
  let unitKg: string;
  let unitAlt: string;

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
    modifierEffects = app.get(ModifierRecipeEffectsService);
    stockItems = app.get(StockItemsService);

    await packs.activate(testPackDocument());

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `pin-${stamp}`,
        legalName: 'PinTenant',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `PinBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `PN${stamp % 10000}`,
        name: 'Pinning Branch',
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
        name: 'Pin-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `pin.race.${stamp}@example.com`,
        displayName: 'Pin',
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
        code: `PNE${stamp % 1000}`,
        displayName: 'Pin Employee',
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
          name: 'Pinning pricing',
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
        name: 'Pin Drawer',
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
          code: `PKG${stamp % 100000}`,
          name: 'Pinning Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;
    unitAlt = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `PBX${stamp % 100000}`,
          name: 'Pinning Box',
          baseUnitOfDimension: false,
        },
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

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
        priceListId: priceListA,
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
      baseUnitId?: string;
      costingMethod?: 'weighted_average' | 'standard';
      standardCost?: bigint;
    } = {},
  ) =>
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
          baseUnitId: opts.baseUnitId ?? unitKg,
          costingMethod: opts.costingMethod ?? 'weighted_average',
          standardCost: opts.standardCost,
          batchStrategy: 'fifo',
          isBatchTracked: false,
        },
      })
    ).id;

  const seedStock = async (stockItemId: string, qty: string, unitCost = 10n) =>
    movements.postStandalone(tenantA, userA, {
      stockItemId,
      locationId: locationA,
      movementType: 'opening_balance',
      quantity: qty,
      unitCost,
      referenceType: 'opening_balance',
      referenceId: newId(),
      occurredAt: new Date('2026-08-01T08:00:00Z'),
    });

  const mkRecipeVersion = async (opts: {
    recipeType?: 'menu_item' | 'sub_recipe';
    variantId?: string;
    /** sub_recipe only — `ck_recipe_target` requires a non-null target
     *  stock item ("what this recipe produces"), unrelated to any
     *  component line. Auto-created if omitted. */
    outputStockItemId?: string;
    yieldQuantity?: string;
    yieldUnitId?: string;
    lines: {
      componentType: 'stock_item' | 'sub_recipe';
      stockItemId?: string;
      subRecipeId?: string;
      quantity: string;
      unitId?: string;
    }[];
  }) => {
    const isSubRecipe = opts.recipeType === 'sub_recipe';
    const outputStockItemId = isSubRecipe
      ? (opts.outputStockItemId ?? (await mkStockItem('PinSubRecipeOutput')))
      : undefined;
    const recipe = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        scope: 'tenant',
        recipeType: opts.recipeType ?? 'menu_item',
        menuItemVariantId: isSubRecipe ? undefined : opts.variantId,
        stockItemId: isSubRecipe ? outputStockItemId : undefined,
      },
    });
    const version = await admin.recipeVersion.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        recipeId: recipe.id,
        version: 1,
        status: 'published',
        yieldQuantity: opts.yieldQuantity ?? '1',
        yieldUnitId: opts.yieldUnitId ?? unitKg,
        yieldPercentage: '100.00',
      },
    });
    for (const [i, l] of opts.lines.entries()) {
      await admin.recipeLine.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          recipeVersionId: version.id,
          sequence: i + 1,
          componentType: l.componentType,
          stockItemId: l.stockItemId ?? null,
          subRecipeId: l.subRecipeId ?? null,
          quantity: l.quantity,
          unitId: l.unitId ?? unitKg,
          wastagePercentage: '0.00',
        },
      });
    }
    return { recipeId: recipe.id, versionId: version.id };
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

  const mkModifier = async (
    menuItemId: string,
    kind: 'addition' | 'removal' | 'substitution',
    effects: {
      sequence: number;
      operation: 'add' | 'remove_all';
      stockItemId?: string;
      subRecipeId?: string;
      quantity?: string;
      unitId?: string;
    }[],
    opts: { allowRepeat?: boolean } = {},
  ) => {
    const group = await admin.modifierGroup.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: { en: `Group ${newId()}` },
        minSelections: 0,
        maxSelections: 5,
        isRequired: false,
        allowRepeat: opts.allowRepeat ?? false,
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
    await modifierEffects.replace(
      tenantA,
      userA,
      modifier.id,
      effects.map((e) => ({
        sequence: e.sequence,
        operation: e.operation,
        componentType: e.subRecipeId ? 'sub_recipe' : 'stock_item',
        stockItemId: e.stockItemId,
        subRecipeId: e.subRecipeId,
        quantity: e.quantity,
        unitId: e.unitId,
      })),
    );
    return modifier.id;
  };

  const freshOrder = (orderId: string) =>
    admin.order.findFirstOrThrow({ where: { id: orderId } });

  /** Always re-reads grandTotal/version fresh — the order passed in is
   *  typically the STALE value from before lines were added. */
  const capture = async (order: { id: string; businessDay: Date }) => {
    const fresh = await freshOrder(order.id);
    return paymentService.capture(tenantA, userA, {
      orderId: order.id,
      businessDay: order.businessDay,
      expectedVersion: fresh.version,
      tender: 'cash',
      amountMinor: fresh.grandTotal,
      cashSessionId: cashSessionA,
      employeeId: employeeA,
      terminalId: terminalA,
      tenderedAmountMinor: fresh.grandTotal,
    });
  };

  // ============================================================== A
  it('A. a later production.modifier_recipe_effects edit does NOT change an already-captured line', async () => {
    const bacon = await mkStockItem('PinBaconA');
    await seedStock(bacon, '100');
    const { itemId, variantId } = await mkSellable(`PinAddA-${newId()}`);
    const modifierId = await mkModifier(itemId, 'addition', [
      {
        sequence: 1,
        operation: 'add',
        stockItemId: bacon,
        quantity: '0.10',
        unitId: unitKg,
      },
    ]);

    const order = await mkOpenOrder();
    const line = await mkLine(order, itemId, variantId, '1', [modifierId]);

    // Master data edit AFTER capture — doubles the ADD quantity.
    await modifierEffects.replace(tenantA, userA, modifierId, [
      {
        sequence: 1,
        operation: 'add',
        componentType: 'stock_item',
        stockItemId: bacon,
        quantity: '0.20',
        unitId: unitKg,
      },
    ]);

    const res = await capture(order);
    expect(res.order.state).toBe('completed');
    const effect = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: line.line.id, stockItemId: bacon },
    });
    // The CAPTURED 0.10, never the edited 0.20.
    expect(effect.quantityInBaseUnit.toFixed(6)).toBe('0.100000');
  });

  // ============================================================== B
  it('B. a later base_unit_id change does NOT change an already-captured line’s completed depletion', async () => {
    // `standard` costing so the line-capture cost check needs no
    // `stock_levels.average_cost` (which would itself require a movement,
    // and FR-INV-002 forbids changing base_unit_id once a movement exists).
    const item = await mkStockItem('PinBaseUnitB', {
      baseUnitId: unitKg,
      costingMethod: 'standard',
      standardCost: 10n,
    });
    // Conversion pinned at capture: unitAlt -> unitKg, factor 1000.
    await admin.uomConversion.create({
      data: {
        id: newId(),
        fromUnitId: unitAlt,
        toUnitId: unitKg,
        factor: '1000',
        stockItemId: null,
      },
    });
    const { itemId, variantId } = await mkSellable(
      `PinBaseUnitItem-${newId()}`,
    );
    await mkRecipeVersion({
      variantId,
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: item,
          quantity: '1',
          unitId: unitAlt,
        },
      ],
    });

    const order = await mkOpenOrder();
    const line = await mkLine(order, itemId, variantId, '1');

    // NO stock movement exists yet for `item` -> base unit is still mutable
    // (FR-INV-002). Change it AFTER capture, BEFORE any receipt.
    const unitOther = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `POT${stamp % 100000}`,
          name: 'Pinning Other',
          baseUnitOfDimension: false,
        },
      })
    ).id;
    await stockItems.changeBaseUnit(tenantA, userA, item, unitOther);
    const freshItem = await admin.stockItem.findUniqueOrThrow({
      where: { id: item },
    });
    expect(freshItem.baseUnitId).toBe(unitOther); // the rename really took effect

    await seedStock(item, '10000');
    const res = await capture(order);
    expect(res.order.state).toBe('completed');
    const effect = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: line.line.id, stockItemId: item },
    });
    // Still 1000 (the PINNED factor's interpretation), unaffected by the rename.
    expect(effect.quantityInBaseUnit.toFixed(6)).toBe('1000.000000');
  });

  // ============================================================== C
  it('C. a later uom_conversions factor change does NOT change an already-captured line’s completed depletion', async () => {
    const item = await mkStockItem('PinConvC');
    await seedStock(item, '10000');
    const conversion = await admin.uomConversion.create({
      data: {
        id: newId(),
        fromUnitId: unitAlt,
        toUnitId: unitKg,
        factor: '1000',
        stockItemId: item,
      },
    });
    const { itemId, variantId } = await mkSellable(`PinConvItem-${newId()}`);
    await mkRecipeVersion({
      variantId,
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: item,
          quantity: '1',
          unitId: unitAlt,
        },
      ],
    });

    const order = await mkOpenOrder();
    const line = await mkLine(order, itemId, variantId, '1');

    // Mutate the LIVE conversion factor after capture.
    await admin.uomConversion.update({
      where: { id: conversion.id },
      data: { factor: '5' },
    });

    const res = await capture(order);
    expect(res.order.state).toBe('completed');
    const effect = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: line.line.id, stockItemId: item },
    });
    // Still 1000 (the PINNED factor), never the mutated 5.
    expect(effect.quantityInBaseUnit.toFixed(6)).toBe('1000.000000');
  });

  // ============================================================== D
  it('D. VALUATION gap (no pinned conversion) -> Completion refuses, Payment rolls back, nothing survives', async () => {
    // A BASE-recipe conversion gap is already refused at LINE-CAPTURE time
    // (OrderLinesService.resolveUnitCost's pre-existing BR-MNU-012-adjacent
    // cost check, via RecipeCostService.cost()) — that path never reaches
    // Completion at all. `resolveUnitCost` prices ONLY the base recipe, not
    // modifier ADD effects, so the genuine Completion-time VALUATION gap
    // (`ConsumptionConversionGapError`, thrown by `planConsumption`) is
    // reachable through a MODIFIER ADD effect referencing a unit with no
    // conversion anywhere — invisible to the capture-time cost check, which
    // never examines modifier effects.
    const baseItem = await mkStockItem('PinValGapBase');
    await seedStock(baseItem, '100');
    const gapItem = await mkStockItem('PinValGapAdd');
    const unitOrphan = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `PORPH${stamp % 100000}`,
          name: 'Pinning Orphan',
          baseUnitOfDimension: false,
        },
      })
    ).id;
    const { itemId, variantId } = await mkSellable(`PinValGapItem-${newId()}`);
    await mkRecipeVersion({
      variantId,
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: baseItem,
          quantity: '1',
          unitId: unitKg,
        },
      ],
    });
    const gapModifierId = await mkModifier(itemId, 'addition', [
      {
        sequence: 1,
        operation: 'add',
        stockItemId: gapItem,
        quantity: '1',
        unitId: unitOrphan,
      },
    ]);

    const order = await mkOpenOrder();
    // Line capture SUCCEEDS — the gap is invisible to resolveUnitCost.
    const captured = await mkLine(order, itemId, variantId, '1', [
      gapModifierId,
    ]);
    expect(captured.line).toBeDefined();
    const before = await freshOrder(order.id);

    await expect(capture(order)).rejects.toThrow();

    const after = await freshOrder(order.id);
    expect(after.state).toBe(before.state); // NOT completed
    expect(after.version).toBe(before.version); // CAS never applied
    expect(after.paidTotal).toBe(0n);

    const payments = await admin.orderPayment.count({
      where: { orderId: order.id },
    });
    expect(payments).toBe(0); // Payment insert rolled back too — same tx
    const effects = await admin.saleDepletionEffect.count({
      where: { orderId: order.id },
    });
    expect(effects).toBe(0); // no sale depletion survives
    const completedAudits = await admin.auditEntry.count({
      where: {
        tenantId: tenantA,
        action: 'ORDER_COMPLETED',
        entityId: order.id,
      },
    });
    expect(completedAudits).toBe(0); // no completion audit effect survives
  });

  // ============================================================== E
  it('E. STRUCTURAL gap (no_components) -> sale completes with partial depletion, gap retained in the ORDER_COMPLETED audit', async () => {
    const present = await mkStockItem('PinStructPresent');
    await seedStock(present, '100');
    const { itemId, variantId } = await mkSellable(`PinStructItem-${newId()}`);
    // A published version with ZERO recipe lines -> `no_components`,
    // tolerated (STRUCTURAL), not thrown.
    const emptyRecipe = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        scope: 'tenant',
        recipeType: 'menu_item',
        menuItemVariantId: variantId,
      },
    });
    await admin.recipeVersion.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        recipeId: emptyRecipe.id,
        version: 1,
        status: 'published',
        yieldQuantity: '1',
        yieldUnitId: unitKg,
        yieldPercentage: '100.00',
      },
    });

    const order = await mkOpenOrder();
    const line = await mkLine(order, itemId, variantId, '1');
    const res = await capture(order);
    expect(res.order.state).toBe('completed'); // sale completes despite the gap

    const orderLine = await admin.orderLine.findFirstOrThrow({
      where: { id: line.line.id },
    });
    expect(orderLine.postedCogsTotal).toBe(0n); // zero depletion is correct, not an error

    const effects = await admin.saleDepletionEffect.count({
      where: { orderLineId: line.line.id },
    });
    expect(effects).toBe(0);

    const audit = await admin.auditEntry.findFirstOrThrow({
      where: {
        tenantId: tenantA,
        action: 'ORDER_COMPLETED',
        entityId: order.id,
      },
    });
    const metadata = audit.afterState as {
      gaps: { orderLineId: string; reason: string }[];
    };
    const lineGaps = metadata.gaps.filter(
      (g) => g.orderLineId === line.line.id,
    );
    // The structural gap is RETAINED in the audit, not silently dropped.
    expect(lineGaps.some((g) => g.reason === 'no_components')).toBe(true);
    void present; // seeded for symmetry with other tests; not consumed here
  });

  // ============================================================== F
  it('F. same StockItem reached through multiple recursive recipe paths aggregates ONLY within the same OrderLine', async () => {
    const shared = await mkStockItem('PinNestedShared');
    await seedStock(shared, '1000');
    // sub-recipe A: 2 units of `shared` per yield unit.
    const subA = await mkRecipeVersion({
      recipeType: 'sub_recipe',
      yieldQuantity: '1',
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: shared,
          quantity: '2',
          unitId: unitKg,
        },
      ],
    });
    // base recipe: 1 unit of `shared` DIRECTLY, plus 1 yield-unit of subA
    // (another 2 units of `shared`, via a different path) -> 3 total, once.
    const { itemId, variantId } = await mkSellable(`PinNestedItem-${newId()}`);
    await mkRecipeVersion({
      variantId,
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: shared,
          quantity: '1',
          unitId: unitKg,
        },
        {
          componentType: 'sub_recipe',
          subRecipeId: subA.recipeId,
          quantity: '1',
          unitId: unitKg,
        },
      ],
    });

    const order = await mkOpenOrder();
    const line = await mkLine(order, itemId, variantId, '1');
    const res = await capture(order);
    expect(res.order.state).toBe('completed');

    // Exactly ONE effect for (line, shared) — aggregated, not duplicated.
    const effects = await admin.saleDepletionEffect.findMany({
      where: { orderLineId: line.line.id, stockItemId: shared },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0].quantityInBaseUnit.toFixed(6)).toBe('3.000000');
  });

  // ============================================================== G
  it('G. the same StockItem on TWO order lines stays independently attributable via distinct sale depletion effects', async () => {
    const shared = await mkStockItem('PinTwoLinesShared');
    await seedStock(shared, '1000');
    const { itemId, variantId } = await mkSellable(
      `PinTwoLinesItem-${newId()}`,
    );
    await mkRecipeVersion({
      variantId,
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: shared,
          quantity: '5',
          unitId: unitKg,
        },
      ],
    });

    const order = await mkOpenOrder();
    const lineA = await mkLine(order, itemId, variantId, '1');
    const lineB = await mkLine(order, itemId, variantId, '1');
    const res = await capture(order);
    expect(res.order.state).toBe('completed');

    const effectA = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: lineA.line.id, stockItemId: shared },
    });
    const effectB = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: lineB.line.id, stockItemId: shared },
    });
    expect(effectA.id).not.toBe(effectB.id);
    expect(effectA.quantityInBaseUnit.toFixed(6)).toBe('5.000000');
    expect(effectB.quantityInBaseUnit.toFixed(6)).toBe('5.000000');
  });

  // ============================================================== H
  it('H. SUBSTITUTION: REMOVE_ALL the base component + ADD the substitute', async () => {
    const beef = await mkStockItem('PinSubBeef');
    const chicken = await mkStockItem('PinSubChicken');
    await seedStock(beef, '100');
    await seedStock(chicken, '100');
    const { itemId, variantId } = await mkSellable(`PinSubItem-${newId()}`);
    await mkRecipeVersion({
      variantId,
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: beef,
          quantity: '1',
          unitId: unitKg,
        },
      ],
    });
    const substituteModifierId = await mkModifier(itemId, 'substitution', [
      { sequence: 1, operation: 'remove_all', stockItemId: beef },
      {
        sequence: 2,
        operation: 'add',
        stockItemId: chicken,
        quantity: '1',
        unitId: unitKg,
      },
    ]);

    const order = await mkOpenOrder();
    const line = await mkLine(order, itemId, variantId, '1', [
      substituteModifierId,
    ]);
    const res = await capture(order);
    expect(res.order.state).toBe('completed');

    const beefEffect = await admin.saleDepletionEffect.findFirst({
      where: { orderLineId: line.line.id, stockItemId: beef },
    });
    expect(beefEffect).toBeNull(); // fully removed
    const chickenEffect = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: line.line.id, stockItemId: chicken },
    });
    expect(chickenEffect.quantityInBaseUnit.toFixed(6)).toBe('1.000000');
  });

  // ============================================================== I
  it('I. DOUBLE MODIFIER SCALING: effect.quantity x order_line_modifier.quantity x order_line.quantity', async () => {
    const topping = await mkStockItem('PinScaleTopping');
    await seedStock(topping, '1000');
    const { itemId, variantId } = await mkSellable(`PinScaleItem-${newId()}`);
    // Base recipe carries nothing of `topping` — only the modifier adds it.
    // A distinct filler item gives the base recipe a real, non-topping line.
    const filler = await mkStockItem('PinScaleFiller');
    await seedStock(filler, '1000');
    await mkRecipeVersion({
      variantId,
      lines: [
        {
          componentType: 'stock_item',
          stockItemId: filler,
          quantity: '1',
          unitId: unitKg,
        },
      ],
    });
    // effect.quantity = 0.10 per modifier selection unit.
    const extraToppingId = await mkModifier(
      itemId,
      'addition',
      [
        {
          sequence: 1,
          operation: 'add',
          stockItemId: topping,
          quantity: '0.10',
          unitId: unitKg,
        },
      ],
      { allowRepeat: true },
    );

    const order = await mkOpenOrder();
    // order_line.quantity = 3; modifier SELECTED with quantity = 2 (double
    // topping x3 servings) -> 0.10 x 2 x 3 = 0.60.
    const expectedVersion = await currentVersion(order.id);
    const { line } = await lines.addLine(
      tenantA,
      userA,
      order.id,
      order.businessDay,
      {
        menuItemId: itemId,
        variantId,
        quantity: '3',
        modifiers: [{ modifierId: extraToppingId, quantity: 2 }],
        expectedVersion,
      },
    );

    const res = await capture(order);
    expect(res.order.state).toBe('completed');
    const effect = await admin.saleDepletionEffect.findFirstOrThrow({
      where: { orderLineId: line.id, stockItemId: topping },
    });
    expect(effect.quantityInBaseUnit.toFixed(6)).toBe('0.600000');
  });

  // ======================================================= §5 FINDING
  it('§5 finding: a modifier ADD effect targeting a sub-recipe with NO published version is dropped from the snapshot but RECORDED in the line-capture audit', async () => {
    const subRecipeOutput = await mkStockItem('PinGapSubOutput');
    const unpublishedSubRecipe = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        scope: 'tenant',
        recipeType: 'sub_recipe',
        stockItemId: subRecipeOutput,
      },
    });
    // Deliberately create ONLY a draft version -> no published version exists.
    await admin.recipeVersion.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        recipeId: unpublishedSubRecipe.id,
        version: 1,
        status: 'draft',
        yieldQuantity: '1',
        yieldUnitId: unitKg,
        yieldPercentage: '100.00',
      },
    });
    const { itemId, variantId } = await mkSellable(`PinGapItem-${newId()}`);
    const modifierId = await mkModifier(itemId, 'addition', [
      {
        sequence: 1,
        operation: 'add',
        subRecipeId: unpublishedSubRecipe.id,
        quantity: '1',
        unitId: unitKg,
      },
    ]);

    const order = await mkOpenOrder();
    const { line } = await mkLine(order, itemId, variantId, '1', [modifierId]);

    // Dropped from the persisted snapshot entirely (XOR CHECK forbids a
    // NULL sub_recipe_version_id for a sub_recipe row).
    const snapshotRows = await admin.orderLineModifierEffect.findMany({
      where: { orderLineId: line.id },
    });
    expect(snapshotRows).toHaveLength(0);

    // But RECORDED in the ORDER_LINE_ADDED audit metadata — not silently lost.
    const captureAudit = await admin.auditEntry.findFirstOrThrow({
      where: {
        tenantId: tenantA,
        action: 'ORDER_LINE_ADDED',
        entityId: line.id,
      },
    });
    const metadata = captureAudit.afterState as {
      droppedModifierEffects: {
        modifierId: string;
        sequence: number;
        reason: string;
      }[];
    };
    expect(metadata.droppedModifierEffects).toHaveLength(1);
    expect(metadata.droppedModifierEffects[0]).toMatchObject({
      modifierId,
      sequence: 1,
      reason: 'no_published_version',
    });

    // The sale still proceeds and completes; the dropped effect simply
    // contributes nothing to depletion.
    const res = await capture(order);
    expect(res.order.state).toBe('completed');
  });
});
