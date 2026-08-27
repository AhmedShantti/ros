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
import { PRODUCTION_CONSUMPTION_QUERY } from './../src/modules/production/contract';
import type { ProductionConsumptionQuery } from './../src/modules/production/contract';
import { SALE_DEPLETION_COMMAND } from './../src/modules/inventory/contract';
import type { SaleDepletionCommand } from './../src/modules/inventory/contract';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * NFR-PERF-006 — benchmark `planConsumption` PLUS `depleteForCompletedSale`
 * INSIDE the Completion transaction: 30 lines, NESTED recipes (depth >= 2),
 * mixed costing methods, multi-batch FIFO items, modifiers present. >=20
 * iterations, p50 AND p95 reported. COMPLETE only if measured p95 <= 200ms.
 *
 * Each iteration runs inside a transaction that is deliberately ROLLED BACK
 * (a thrown sentinel) so batches/counters never actually deplete across
 * iterations — every iteration measures the SAME real work from the SAME
 * starting state, without needing to re-seed stock 20 times.
 */

class ForcedRollback extends Error {}

describe('NFR-PERF-006 — Order Completion performance (P1F-2 e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;
  let prisma: PrismaService;
  let consumption: ProductionConsumptionQuery;
  let saleDepletion: SaleDepletionCommand;

  const stamp = Date.now();
  const AT = new Date('2026-08-27T09:00:00.000Z');
  const PACK = '2026.1';
  const LINE_COUNT = 30;
  const ITERATIONS = 20;

  const RELEASE_KEY = generateReleaseKey('e2e-perf-release-key');
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
    consumption = app.get(PRODUCTION_CONSUMPTION_QUERY);
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
        slug: `perf-${stamp}`,
        legalName: 'Perf',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `PerfBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `PF${stamp % 10000}`,
        name: 'Perf Branch',
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
          name: 'Perf-POS',
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `perf.${stamp}@example.com`,
        displayName: 'Perf',
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
          code: `PFE${stamp % 1000}`,
          displayName: 'Perf Employee',
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
          name: 'Perf pricing',
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
          code: `PKG${stamp % 100000}`,
          name: 'Perf Kilogram',
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

  it(`measures p50/p95 of planConsumption + depleteForCompletedSale for ${LINE_COUNT} lines, nested recipes, mixed costing, multi-batch FIFO, modifiers (>=${ITERATIONS} iterations)`, async () => {
    // ---- mixed-costing leaf stock items -----------------------------
    const mkItem = async (
      name: string,
      costingMethod: 'weighted_average' | 'fifo' | 'standard',
    ) =>
      (
        await admin.stockItem.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            sku: `${name}${stamp % 100000}`,
            names: { en: name },
            baseUnitId: unitKg,
            costingMethod,
            batchStrategy: 'fifo',
            isBatchTracked: true,
            standardCost: costingMethod === 'standard' ? 500n : undefined,
          },
        })
      ).id;

    const itemWA = await mkItem('PerfWA', 'weighted_average');
    const itemStd = await mkItem('PerfStd', 'standard');
    const itemFifoTop = await mkItem('PerfFifoTop', 'fifo'); // multi-batch, used directly in the base recipe
    const itemFifoDeep = await mkItem('PerfFifoDeep', 'fifo'); // multi-batch, used inside the depth-2 sub-recipe
    const itemModAdd = await mkItem('PerfModAdd', 'weighted_average');

    const mkBatch = async (
      stockItemId: string,
      qty: string,
      unitCost: bigint,
      createdAt: Date,
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
        },
      });
      // Direct stock_levels seed (no MovementsService needed here — the
      // benchmark rolls every iteration back, so a fresh weighted_average
      // baseline per run is all that's needed, seeded once up front).
      await admin.stockLevel.upsert({
        where: {
          stockItemId_locationId: { stockItemId, locationId: locationA },
        },
        create: {
          tenantId: tenantA,
          stockItemId,
          locationId: locationA,
          quantityOnHand: qty,
          averageCost: unitCost,
        },
        update: {
          quantityOnHand: { increment: qty },
        },
      });
      return batch;
    };

    await mkBatch(itemWA, '10000', 40n, new Date('2026-08-01T08:00:00Z'));
    await mkBatch(itemModAdd, '10000', 15n, new Date('2026-08-01T08:00:00Z'));
    // Multi-batch FIFO (>=3 layers) for both FIFO items, generous headroom.
    for (let b = 0; b < 3; b++) {
      await mkBatch(
        itemFifoTop,
        '1000',
        BigInt(100 + b * 10),
        new Date(`2026-08-0${b + 1}T08:00:00Z`),
      );
      await mkBatch(
        itemFifoDeep,
        '1000',
        BigInt(60 + b * 5),
        new Date(`2026-08-0${b + 1}T08:00:00Z`),
      );
    }

    // ---- NESTED recipe, depth >= 2: base -> subRecipe1 -> subRecipe2 --
    const mkProductionRecipe = async (
      name: string,
      recipeLines: {
        stockItemId?: string;
        subRecipeId?: string;
        quantity: string;
      }[],
    ) => {
      const recipe = await admin.recipe.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: (
            await admin.stockItem.create({
              data: {
                id: newId(),
                tenantId: tenantA,
                sku: `${name}OUT${stamp % 100000}`,
                names: { en: `${name} output` },
                baseUnitId: unitKg,
                costingMethod: 'weighted_average',
                isBatchTracked: false,
              },
            })
          ).id,
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
            componentType: l.subRecipeId ? 'sub_recipe' : 'stock_item',
            stockItemId: l.stockItemId ?? null,
            subRecipeId: l.subRecipeId ?? null,
            quantity: l.quantity,
            unitId: unitKg,
            wastagePercentage: '0.00',
          },
        });
      }
      return recipe.id;
    };

    // depth 2: subRecipe2 (leaf stock items only)
    const subRecipe2Id = await mkProductionRecipe('Perf-Sub2', [
      { stockItemId: itemFifoDeep, quantity: '0.5' },
    ]);
    // depth 1: subRecipe1 references subRecipe2
    const subRecipe1Id = await mkProductionRecipe('Perf-Sub1', [
      { subRecipeId: subRecipe2Id, quantity: '1' },
    ]);
    // Publish subRecipe1's own version so its lines resolve at closure-walk time.
    await admin.recipeVersion.updateMany({
      where: { recipeId: subRecipe1Id },
      data: { status: 'published' },
    });

    const menuItem = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: `Perf Dish ${stamp}` },
        taxClassId: taxClassStandard,
      },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: menuItem.id,
        name: { en: 'V' },
      },
    });
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

    const baseRecipe = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        scope: 'tenant',
        recipeType: 'menu_item',
        menuItemVariantId: variant.id,
      },
    });
    const baseVersion = await admin.recipeVersion.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        recipeId: baseRecipe.id,
        version: 1,
        status: 'published',
        yieldQuantity: '1',
        yieldUnitId: unitKg,
        yieldPercentage: '100.00',
      },
    });
    const baseLines = [
      { stockItemId: itemWA, quantity: '0.2' },
      { stockItemId: itemStd, quantity: '0.1' },
      { stockItemId: itemFifoTop, quantity: '0.3' },
      { subRecipeId: subRecipe1Id, quantity: '1' },
    ];
    for (const [i, l] of baseLines.entries()) {
      await admin.recipeLine.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          recipeVersionId: baseVersion.id,
          sequence: i + 1,
          componentType: l.subRecipeId ? 'sub_recipe' : 'stock_item',
          stockItemId: l.stockItemId ?? null,
          subRecipeId: l.subRecipeId ?? null,
          quantity: l.quantity,
          unitId: unitKg,
          wastagePercentage: '0.00',
        },
      });
    }

    // ---- modifier (present on every other line) ----------------------
    const group = await admin.modifierGroup.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: { en: 'Perf group' },
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
        name: { en: 'Perf Add' },
        priceDelta: 0n,
        kind: 'addition',
      },
    });
    await admin.modifierGroupLink.create({
      data: {
        tenantId: tenantA,
        menuItemId: menuItem.id,
        modifierGroupId: group.id,
      },
    });
    await admin.modifierRecipeEffect.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        modifierId: modifier.id,
        sequence: 1,
        operation: 'add',
        componentType: 'stock_item',
        stockItemId: itemModAdd,
        quantity: '0.05',
        unitId: unitKg,
      },
    });

    // ---- the order: 30 lines, alternating modifier presence -----------
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
    for (let i = 0; i < LINE_COUNT; i++) {
      const added = await lines.addLine(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        {
          menuItemId: menuItem.id,
          variantId: variant.id,
          quantity: '1',
          modifiers: i % 2 === 0 ? [{ modifierId: modifier.id }] : [],
          expectedVersion,
        },
      );
      expectedVersion = added.order.version;
      lineIds.push(added.line.id);
    }

    const orderLines = await admin.orderLine.findMany({
      where: { orderId: order.id, businessDay: order.businessDay },
      include: {
        modifiers: true,
        recipeVersionPins: true,
        modifierEffectPins: true,
        componentConversions: true,
      },
    });
    expect(orderLines).toHaveLength(LINE_COUNT);

    const planLines = orderLines.map((line) => {
      const modifierQuantityById = new Map(
        line.modifiers.map((m) => [m.id, m.quantity]),
      );
      return {
        orderLineId: line.id,
        recipeVersionId: line.recipeVersionId,
        pinnedVersionIds: line.recipeVersionPins.map((p) => p.recipeVersionId),
        quantity: line.quantity.toFixed(3),
        modifierEffects: line.modifierEffectPins.map((e) => ({
          operation: e.operation,
          componentType: e.componentType,
          stockItemId: e.stockItemId,
          subRecipeVersionId: e.subRecipeVersionId,
          quantity: e.quantity ? e.quantity.toFixed(6) : null,
          unitId: e.unitId,
          modifierSelectionQuantity:
            modifierQuantityById.get(e.orderLineModifierId) ?? 1,
        })),
        conversions: line.componentConversions.map((c) => ({
          stockItemId: c.stockItemId,
          fromUnitId: c.fromUnitId,
          baseUnitId: c.baseUnitId,
          factor: c.factor.toFixed(10),
        })),
      };
    });

    // ---- the actual benchmark: planConsumption + depleteForCompletedSale,
    // >=20 iterations, each in its own ROLLED-BACK transaction. ----------
    const timingsMs: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const startedAt = process.hrtime.bigint();
      try {
        await prisma.withAuthContext(
          { userId: userA, tenantId: tenantA },
          async (tx) => {
            const planResult = await consumption.planConsumption(tx, {
              lines: planLines,
            });
            await saleDepletion.depleteForCompletedSale(tx, {
              tenantId: tenantA,
              actorId: userA,
              branchId: branchA,
              orderId: order.id,
              businessDay: order.businessDay,
              occurredAt: new Date(),
              lines: planResult.perLine.map((pl) => ({
                orderLineId: pl.orderLineId,
                components: pl.components,
              })),
            });
            throw new ForcedRollback();
          },
        );
      } catch (err) {
        if (!(err instanceof ForcedRollback)) throw err;
      }
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      timingsMs.push(elapsedMs);
    }

    const sorted = [...timingsMs].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted[
        Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
      ];
    const p50 = percentile(50);
    const p95 = percentile(95);

    console.log(
      `NFR-PERF-006: ${LINE_COUNT} lines, ${ITERATIONS} iterations — ` +
        `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
        `(min=${sorted[0].toFixed(2)}ms max=${sorted[sorted.length - 1].toFixed(2)}ms) ` +
        `all=[${timingsMs.map((t) => t.toFixed(1)).join(',')}]`,
    );

    expect(timingsMs).toHaveLength(ITERATIONS);
    // Report the number regardless of outcome — the report classifies
    // COMPLETE only if p95 <= 200ms, PARTIAL otherwise, with the real
    // number. This assertion does not gate the suite either way.
  }, 120_000);
});
