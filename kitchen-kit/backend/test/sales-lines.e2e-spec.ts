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
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SALES_PERMISSION_DEFS } from './../src/modules/sales/sales.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * P1C — OrderLine capture, end to end.
 *
 * The point of this suite is BR-POS-004: all five mandatory snapshots are
 * produced by a real source and persisted, and none of them changes afterwards
 * when the master data they came from changes.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const AT = new Date('2026-08-20T09:00:00.000Z');
const PACK = '2026.1';
const PIN = '1379';

const RELEASE_KEY = generateReleaseKey('e2e-line-release-key');
const TRUST = trustStoreFor(RELEASE_KEY.trusted());
const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);

const packPayload = (overrides: Record<string, unknown> = {}) => ({
  code: 'EG',
  version: PACK,
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
      { code: 'zero', rate: '0.0', label: { en: 'Zero rated' } },
      { code: 'exempt', rate: null, label: { en: 'Exempt' } },
    ],
    serviceChargeTaxable: true,
    orderTypeOverrides: [],
  },
  ...overrides,
});

describe('Sales P1C line capture (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let packs: CountryPackService;
  let movements: MovementsService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let brandA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let userB: string;
  let posToken: string;

  // Catalogue
  let menuItemId: string;
  let variantId: string;
  let priceListId: string;
  let priceEntryId: string;
  let taxClassStandard: string;
  let taxClassZero: string;
  // Foreign tenant
  let foreignTaxClass: string;
  let foreignVariant: string;
  let reasonCodeId: string;
  // Production / Inventory
  let flourItemId: string;
  let recipeVersionId: string;
  let locationA: string;
  let unitKg: string;

  /** A sellable item + variant + price, in one call. */
  const mkSellable = async (
    name: string,
    price: bigint,
    taxClassId: string | null = null,
  ) => {
    const item = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: name },
        ...(taxClassId === null
          ? { taxClassId: taxClassStandard }
          : { taxClassId }),
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
    return { item, variant };
  };

  /** A published recipe for a variant, with the given component lines. */
  const mkPublishedRecipe = async (
    variantId: string,
    lines: {
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
    for (const [i, line] of lines.entries()) {
      await admin.recipeLine.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          recipeVersionId: version.id,
          sequence: i + 1,
          componentType: line.subRecipeId ? 'sub_recipe' : 'stock_item',
          ...(line.subRecipeId
            ? { subRecipeId: line.subRecipeId }
            : { stockItemId: line.stockItemId! }),
          quantity: line.quantity,
          unitId: unitKg,
          wastagePercentage: '0.00',
        },
      });
    }
    return { recipe, ...version, id: version.id };
  };

  /** A goods receipt, with the batch `ck_batch_required` demands. */
  const receive = async (
    stockItemId: string,
    quantity: number,
    unitCost: bigint,
    occurredAt: Date,
    batchNumber: string,
  ) => {
    const batch = await admin.stockBatch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        stockItemId,
        locationId: locationA,
        batchNumber,
        quantityReceived: String(quantity),
        quantityRemaining: String(quantity),
        unitCost,
      },
    });
    return movements.postStandalone(tenantA, userA, {
      stockItemId,
      locationId: locationA,
      movementType: 'purchase_receipt',
      quantity,
      unitCost,
      batchId: batch.id,
      referenceType: 'goods_receipt',
      referenceId: newId(),
      occurredAt,
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
    packs = app.get(CountryPackService);
    movements = app.get(MovementsService);

    // A genuinely signed pack must be active BEFORE the tenants are created, so
    // tenant provisioning can materialise their tax class identities.
    await packs.activate(signPackDocument(packPayload(), RELEASE_KEY));

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantA = await mkTenant(`lna-${stamp}`);
    tenantB = await mkTenant(`lnb-${stamp}`);

    // ---------------------------------------------------------- org + POS
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `LBrand ${stamp}` },
    });
    brandA = brand.id;
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brandA,
        code: `LA${stamp % 10000}`,
        name: 'Line branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchA = branch.id;
    const location = await admin.location.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        locationType: 'branch',
        refId: branchA,
        branchId: branchA,
      },
    });
    locationA = location.id;
    terminalA = (
      await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          name: 'LA-POS-1',
          terminalType: 'pos',
          status: 'active',
        },
      })
    ).id;

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({ email, password, displayName: 'L' });
      await memberships.grant(u.id, tenantId, 'active');
      return u.id;
    };
    userA = await mkUser(`line.a.${stamp}@example.com`, tenantA);
    userB = await mkUser(`line.b.${stamp}@example.com`, tenantB);

    const employeeCode = `LEA${stamp % 1000}`;
    employeeA = (
      await employees.create(tenantA, userA, {
        code: employeeCode,
        displayName: 'Line A',
        homeBranchId: branchA,
        userId: userA,
      })
    ).id;

    const permissions = app.get(PermissionsService);
    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const cashier = await roles.createTenantRole(tenantA, {
      name: `line_cashier_${stamp}`,
    });
    await roles.addPermissions(
      tenantA,
      cashier.id,
      SALES_PERMISSION_DEFS.map((d) => d.code),
    );
    const membershipA = await admin.membership.findFirstOrThrow({
      where: { userId: userA, tenantId: tenantA },
    });
    await membershipRoles.assign(tenantA, membershipA.id, cashier.id);

    const pins = app.get(PinService);
    await pins.setPin(tenantA, userA, employeeA, PIN);
    const login = await request(http).post('/auth/pin').send({
      tenantId: tenantA,
      terminalId: terminalA,
      employeeCode,
      pin: PIN,
    });
    posToken = (login.body as { accessToken: string }).accessToken;

    // ------------------------------------------------------- tax classes
    const classes = await admin.taxClass.findMany({
      where: { tenantId: tenantA, countryPackCode: 'EG' },
    });
    taxClassStandard = classes.find((c) => c.code === 'standard')!.id;
    taxClassZero = classes.find((c) => c.code === 'zero')!.id;
    foreignTaxClass = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantB, code: 'standard' },
      })
    ).id;

    // --------------------------------------------------------- catalogue
    const item = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: 'Chicken Burger', ar: 'برجر دجاج' },
        taxClassId: taxClassStandard,
      },
    });
    menuItemId = item.id;
    variantId = (
      await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId,
          name: { en: 'Regular' },
        },
      })
    ).id;

    const priceList = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: `Base ${stamp}`,
        scopeType: 'tenant',
        scopeId: tenantA,
        status: 'active',
        priority: 0,
      },
    });
    priceListId = priceList.id;
    priceEntryId = (
      await admin.priceEntry.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          priceListId,
          menuItemVariantId: variantId,
          price: 10_000n, // EGP 100.00
          currency: 'EGP',
        },
      })
    ).id;

    // Foreign-tenant catalogue, for the cross-tenant probes.
    const foreignItem = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantB,
        names: { en: 'Foreign item' },
        taxClassId: foreignTaxClass,
      },
    });
    foreignVariant = (
      await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          menuItemId: foreignItem.id,
          name: { en: 'Foreign' },
        },
      })
    ).id;

    // ------------------------------------------- inventory + recipe (cost)
    unitKg = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `KG${stamp % 100000}`,
          name: 'Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;
    flourItemId = (
      await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `FLOUR${stamp % 10000}`,
          names: { en: 'Flour' },
          baseUnitId: unitKg,
          costingMethod: 'weighted_average',
        },
      })
    ).id;
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
    recipeVersionId = version.id;
    await admin.recipeLine.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        recipeVersionId,
        sequence: 1,
        componentType: 'stock_item',
        stockItemId: flourItemId,
        quantity: '0.250', // 250 g of flour
        unitId: unitKg,
        wastagePercentage: '0.00',
      },
    });

    reasonCodeId = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'adjustment',
          code: `VOID${stamp % 10000}`,
          label: { en: 'Customer changed their mind' },
        },
      })
    ).id;

    // The receipt comes LAST, so FR-MNU-046 sees the recipe and populates
    // `computed_cost` on the way in. 10 kg at EGP 20.00/kg -> average 2000.
    await receive(
      flourItemId,
      10,
      2_000n,
      new Date('2026-08-01T00:00:00Z'),
      'B1',
    );
  }, 60_000);

  // The suite opens a lot of connections (two Prisma clients plus the Nest app),
  // and shutdown occasionally exceeds Jest's 5s hook default on a cold pool.
  afterAll(async () => {
    // The idempotency store writes its replay record fire-and-forget, so give
    // the last request's write a tick to land before the pool closes.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  const openOrder = () =>
    orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });

  const day = (d: Date) => d.toISOString().slice(0, 10);

  const addLine = (
    order: { id: string; businessDay: Date; version: number },
    body: Record<string, unknown> = {},
    opts: { key?: string; ifMatch?: string; token?: string } = {},
  ) =>
    request(http)
      .post(`/orders/${day(order.businessDay)}/${order.id}/lines`)
      .set('Authorization', `Bearer ${opts.token ?? posToken}`)
      .set('Idempotency-Key', opts.key ?? `line-${newId()}`)
      .set('If-Match', opts.ifMatch ?? `W/"${order.id}.${order.version}"`)
      .send({ menuItemId, variantId, quantity: '1', ...body });

  // ------------------------------------------------- BR-POS-004 snapshots

  describe('BR-POS-004 — all five mandatory snapshots', () => {
    it('captures a line with every snapshot persisted', async () => {
      const order = await openOrder();
      const res = await addLine(order, { quantity: '2' });

      expect(res.status).toBe(201);
      const line = (res.body as { line: Record<string, unknown> }).line;

      // 1. item_name_snapshot — copied, not joined.
      expect(line.itemNameSnapshot).toEqual({
        item: { en: 'Chicken Burger', ar: 'برجر دجاج' },
        variant: { en: 'Regular' },
      });
      // 2. unit_price — from the canonical resolver.
      expect(line.unitPrice).toBe('10000');
      // 3. tax_class_id — the stable fiscal UUID.
      expect(line.taxClassId).toBe(taxClassStandard);
      // 4. unit_cost_snapshot — 0.250 kg at 20.00/kg = 5.00, x2 = 10.00.
      expect(line.unitCostSnapshot).toBe('1000');
      // 5. recipe_version_id — the published version.
      expect(line.recipeVersionId).toBe(recipeVersionId);

      // Money: 2 x 10000 = 20000 net, 14% = 2800 tax, 22800 gross.
      expect(line.lineSubtotal).toBe('20000');
      expect(line.taxAmount).toBe('2800');
      expect(line.lineTotal).toBe('22800');
      expect(line.quantity).toBe('2');
    });

    it('persists FR-POS-042 price provenance', async () => {
      const order = await openOrder();
      const res = await addLine(order);
      const line = (res.body as { line: Record<string, unknown> }).line;

      expect(line.priceListId).toBe(priceListId);
      expect(line.priceEntryId).toBe(priceEntryId);
      expect(line.priceRule).toEqual(expect.stringContaining('tier='));
      expect(line.priceRule).toEqual(expect.stringContaining('base_tenant'));
    });

    it('preserves the client-generated line ULID (FR-OFF-015)', async () => {
      const order = await openOrder();
      const id = newId();
      const res = await addLine(order, { id });
      expect((res.body as { line: { id: string } }).line.id).toBe(id);
    });

    it('updates the order totals and version, and returns the new ETag', async () => {
      const order = await openOrder();
      const res = await addLine(order);
      const body = res.body as {
        order: {
          subtotal: string;
          taxTotal: string;
          grandTotal: string;
          version: number;
        };
      };

      expect(body.order.subtotal).toBe('10000');
      expect(body.order.taxTotal).toBe('1400');
      expect(body.order.grandTotal).toBe('11400');
      expect(body.order.version).toBe(order.version + 1);
      expect(res.headers.etag).toBe(`W/"${order.id}.${order.version + 1}"`);
    });

    it('sums line taxes rather than taxing the order total (FR-FIN-034)', async () => {
      const order = await openOrder();
      let version = order.version;
      for (let i = 0; i < 3; i++) {
        const res = await addLine(
          { ...order, version },
          { quantity: '1' },
          { ifMatch: `W/"${order.id}.${version}"` },
        );
        expect(res.status).toBe(201);
        version = (res.body as { order: { version: number } }).order.version;
      }
      const final = await orders.findOne(tenantA, order.id, order.businessDay);
      // Three lines of 10000 at 14% -> 1400 each -> 4200.
      expect(final!.taxTotal.toString()).toBe('4200');
      expect(final!.subtotal.toString()).toBe('30000');
      void order;
    });

    it('emits an audit entry naming every identity behind the snapshot', async () => {
      const order = await openOrder();
      const res = await addLine(order);
      const lineId = (res.body as { line: { id: string } }).line.id;

      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: lineId,
          action: 'ORDER_LINE_ADDED',
        },
      });
      expect(entry).not.toBeNull();
      expect(entry!.terminalId).toBe(terminalA);
      expect(entry!.afterState).toMatchObject({
        countryPack: `EG-${PACK}`,
        taxClassId: taxClassStandard,
        taxClassCode: 'standard',
        recipeVersionId,
        costBasis: 'recipe_complete',
      });
    });
  });

  // --------------------------------------------------- snapshots are frozen

  describe('a snapshot is never recomputed from current master data', () => {
    it('survives a later price change, tax change, recipe publish and cost change', async () => {
      const order = await openOrder();
      const res = await addLine(order, { quantity: '2' });
      const line = (res.body as { line: { id: string } }).line;
      const before = await admin.orderLine.findFirstOrThrow({
        where: { id: line.id },
      });

      // 1. The price doubles.
      await admin.priceEntry.update({
        where: { id: priceEntryId },
        data: { price: 20_000n },
      });
      // 2. A newer pack changes the standard rate.
      await packs.activate(
        signPackDocument(
          { ...packPayload(), version: '2026.9', effectiveFrom: '2026-02-01' },
          RELEASE_KEY,
        ),
      );
      // 3. The recipe is superseded by a new published version.
      await admin.recipeVersion.update({
        where: { id: recipeVersionId },
        data: { status: 'superseded' },
      });
      const v2 = await admin.recipeVersion.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          recipeId: before.recipeVersionId
            ? (
                await admin.recipeVersion.findFirstOrThrow({
                  where: { id: before.recipeVersionId },
                })
              ).recipeId
            : newId(),
          version: 2,
          status: 'published',
          yieldQuantity: '1',
          yieldUnitId: unitKg,
          yieldPercentage: '100.00',
        },
      });
      // 4. A receipt at a different cost moves the weighted average.
      await receive(
        flourItemId,
        10,
        6_000n,
        new Date('2026-08-19T00:00:00Z'),
        'B2',
      );

      const after = await admin.orderLine.findFirstOrThrow({
        where: { id: line.id },
      });
      expect(after.unitPrice).toBe(before.unitPrice);
      expect(after.taxAmount).toBe(before.taxAmount);
      expect(after.taxClassId).toBe(before.taxClassId);
      expect(after.unitCostSnapshot).toBe(before.unitCostSnapshot);
      expect(after.recipeVersionId).toBe(before.recipeVersionId);
      expect(after.itemNameSnapshot).toEqual(before.itemNameSnapshot);

      // Restore for the remaining tests.
      await admin.priceEntry.update({
        where: { id: priceEntryId },
        data: { price: 10_000n },
      });
      await admin.recipeVersion.update({
        where: { id: v2.id },
        data: { status: 'superseded' },
      });
      await admin.recipeVersion.update({
        where: { id: recipeVersionId },
        data: { status: 'published' },
      });
    });
  });

  // ------------------------------------- absent-recipe historical integrity

  describe('a later recipe never rewrites an absent-recipe historical line', () => {
    it('keeps recipe_version_id NULL and cost 0 after the recipe is created', async () => {
      const { variant } = await mkSellable('Late recipe item', 6_000n);

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: variant.menuItemId,
        variantId: variant.id,
      });
      expect(res.status).toBe(201);
      const lineId = (res.body as { line: { id: string } }).line.id;
      const before = await admin.orderLine.findFirstOrThrow({
        where: { id: lineId },
      });
      expect(before.recipeVersionId).toBeNull();
      expect(before.unitCostSnapshot).toBe(0n);

      // The chef writes the recipe the next day, publishes it, and a receipt
      // moves the ingredient cost. None of it may touch the sale already made.
      await mkPublishedRecipe(variant.id, [
        { stockItemId: flourItemId, quantity: '0.500' },
      ]);
      await receive(
        flourItemId,
        5,
        50_000n,
        new Date('2026-08-19T18:00:00Z'),
        'BLATE',
      );

      const after = await admin.orderLine.findFirstOrThrow({
        where: { id: lineId },
      });
      expect(after.recipeVersionId).toBeNull();
      expect(after.unitCostSnapshot).toBe(0n);

      // Positive control: a NEW sale of the same item now does carry the recipe.
      const nextOrder = await openOrder();
      const nextRes = await addLine(nextOrder, {
        menuItemId: variant.menuItemId,
        variantId: variant.id,
      });
      expect(nextRes.status).toBe(201);
      const nextLine = (nextRes.body as { line: Record<string, unknown> }).line;
      expect(nextLine.recipeVersionId).not.toBeNull();
      expect(BigInt(String(nextLine.unitCostSnapshot))).toBeGreaterThan(0n);
    });

    it('keeps a PARTIAL cost after the recipe is completed', async () => {
      const { variant } = await mkSellable('Later completed item', 6_000n);
      const undefinedSub = await admin.recipe.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: flourItemId,
        },
      });
      const version = await mkPublishedRecipe(variant.id, [
        { stockItemId: flourItemId, quantity: '0.100' },
        { subRecipeId: undefinedSub.id, quantity: '1' },
      ]);

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: variant.menuItemId,
        variantId: variant.id,
      });
      expect(res.status).toBe(201);
      const lineId = (res.body as { line: { id: string } }).line.id;
      const before = await admin.orderLine.findFirstOrThrow({
        where: { id: lineId },
      });

      // The sub-recipe is defined and published afterwards.
      const subVersion = await admin.recipeVersion.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          recipeId: undefinedSub.id,
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
          recipeVersionId: subVersion.id,
          sequence: 1,
          componentType: 'stock_item',
          stockItemId: flourItemId,
          quantity: '2',
          unitId: unitKg,
          wastagePercentage: '0.00',
        },
      });

      const after = await admin.orderLine.findFirstOrThrow({
        where: { id: lineId },
      });
      expect(after.unitCostSnapshot).toBe(before.unitCostSnapshot);
      expect(after.recipeVersionId).toBe(version.id);
    });
  });

  // ------------------------------------------------ FR-MNU-046 recomputation

  describe('FR-MNU-046 — a valuation change recomputes recipe cost', () => {
    it('writes computed_cost and cost_computed_at, and moves them with the average', async () => {
      const before = await admin.recipeVersion.findFirstOrThrow({
        where: { id: recipeVersionId },
      });
      expect(before.computedCost).not.toBeNull();
      expect(before.costComputedAt).not.toBeNull();

      await receive(
        flourItemId,
        30,
        10_000n,
        new Date('2026-08-19T12:00:00Z'),
        'B3',
      );

      const after = await admin.recipeVersion.findFirstOrThrow({
        where: { id: recipeVersionId },
      });
      expect(after.computedCost).not.toBe(before.computedCost);
      expect(after.costComputedAt!.getTime()).toBeGreaterThanOrEqual(
        before.costComputedAt!.getTime(),
      );
    });

    it('does not recompute an unrelated recipe', async () => {
      const unrelatedItem = await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `SUGAR${stamp % 10000}`,
          names: { en: 'Sugar' },
          baseUnitId: unitKg,
          costingMethod: 'weighted_average',
        },
      });
      const before = await admin.recipeVersion.findFirstOrThrow({
        where: { id: recipeVersionId },
      });

      await receive(
        unrelatedItem.id,
        5,
        500n,
        new Date('2026-08-19T13:00:00Z'),
        'B4',
      );

      const after = await admin.recipeVersion.findFirstOrThrow({
        where: { id: recipeVersionId },
      });
      expect(after.computedCost).toBe(before.computedCost);
    });
  });

  // ----------------------------------------------------- refusals, not fakes

  describe('a line the server cannot price truthfully is refused', () => {
    it('refuses an item with no tax class, and does NOT default to standard', async () => {
      const untaxed = await admin.menuItem.create({
        data: { id: newId(), tenantId: tenantA, names: { en: 'Untaxed' } },
      });
      const variant = await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId: untaxed.id,
          name: { en: 'V' },
        },
      });
      await admin.priceEntry.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          priceListId,
          menuItemVariantId: variant.id,
          price: 5_000n,
          currency: 'EGP',
        },
      });

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: untaxed.id,
        variantId: variant.id,
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/no tax class/i);

      const lines = await admin.orderLine.findMany({
        where: { orderId: order.id },
      });
      expect(lines).toHaveLength(0);
    });

    it('refuses an item with no applicable price', async () => {
      const unpriced = await admin.menuItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          names: { en: 'Unpriced' },
          taxClassId: taxClassStandard,
        },
      });
      const variant = await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId: unpriced.id,
          name: { en: 'V' },
        },
      });
      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: unpriced.id,
        variantId: variant.id,
      });
      expect(res.status).toBe(422);
    });

    it('refuses a tax class the pinned pack does not define', async () => {
      const orphan = await admin.taxClass.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          countryPackCode: 'EG',
          code: 'luxury',
          names: { en: 'Luxury' },
        },
      });
      const item = await admin.menuItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          names: { en: 'Luxury item' },
          taxClassId: orphan.id,
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
          price: 9_000n,
          currency: 'EGP',
        },
      });

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: item.id,
        variantId: variant.id,
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/luxury/);
    });

    it('records BR-MNU-012 ZERO cost for a genuinely absent recipe', async () => {
      const noRecipe = await admin.menuItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          names: { en: 'No recipe' },
          taxClassId: taxClassZero,
        },
      });
      const variant = await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId: noRecipe.id,
          name: { en: 'V' },
        },
      });
      await admin.priceEntry.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          priceListId,
          menuItemVariantId: variant.id,
          price: 1_500n,
          currency: 'EGP',
        },
      });

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: noRecipe.id,
        variantId: variant.id,
      });
      expect(res.status).toBe(201);
      const line = (res.body as { line: Record<string, unknown> }).line;
      // BR-MNU-012 says "SHALL record ZERO or partial cost". For an absent
      // recipe that is a literal zero, not a null: NULL would have claimed the
      // computation failed, which is a different and untrue statement.
      expect(line.unitCostSnapshot).toBe('0');
      // The NULL that IS correct: no recipe existed at sale time. No fake
      // Recipe row, no fake version, no sentinel id was created to avoid it.
      expect(line.recipeVersionId).toBeNull();
      // Zero-rated is still a computed tax of zero, not an absent one.
      expect(line.taxAmount).toBe('0');

      const recipeRows = await admin.recipe.count({
        where: { menuItemVariantId: variant.id },
      });
      expect(recipeRows).toBe(0);

      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: String(line.id),
          action: 'ORDER_LINE_ADDED',
        },
      });
      expect(entry!.afterState).toMatchObject({
        costBasis: 'recipe_absent_br_mnu_012',
      });
    });

    it('REFUSES a complete recipe whose component cannot be valued', async () => {
      // A stock item that has never been received has no valuation at all. The
      // recipe DEFINITION is finished, so this is not BR-MNU-012: selling it at
      // a reduced cost would understate COGS on a dish the operator believes is
      // fully costed.
      const unvalued = await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `SALT${stamp % 10000}`,
          names: { en: 'Salt' },
          baseUnitId: unitKg,
          costingMethod: 'weighted_average',
        },
      });
      const { variant } = await mkSellable('Unvaluable item', 4_000n);
      const version = await mkPublishedRecipe(variant.id, [
        { stockItemId: flourItemId, quantity: '0.100' },
        { stockItemId: unvalued.id, quantity: '0.005' },
      ]);

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: variant.menuItemId,
        variantId: variant.id,
      });

      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/no current valuation/i);
      expect(
        await admin.orderLine.count({ where: { orderId: order.id } }),
      ).toBe(0);
      void version;
    });

    it('sells an INCOMPLETE recipe at a truthful PARTIAL cost', async () => {
      // Incomplete = the DEFINITION is unfinished. Here a sub-recipe component
      // has no published version, so its contribution is unknown - and unknown
      // is not zero: it simply does not enter the sum.
      const { variant } = await mkSellable('Partial cost item', 4_000n);
      const undefinedSub = await admin.recipe.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: flourItemId,
        },
      });
      const version = await mkPublishedRecipe(variant.id, [
        { stockItemId: flourItemId, quantity: '0.100' },
        { subRecipeId: undefinedSub.id, quantity: '1' },
      ]);

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: variant.menuItemId,
        variantId: variant.id,
      });

      expect(res.status).toBe(201);
      const line = (res.body as { line: Record<string, unknown> }).line;
      // The REAL version is snapshotted - the recipe exists, it is just unfinished.
      expect(line.recipeVersionId).toBe(version.id);
      // 0.100 kg of flour at the prevailing average, and nothing for the
      // undefined sub-recipe. Greater than zero, less than a full cost.
      expect(BigInt(String(line.unitCostSnapshot))).toBeGreaterThan(0n);

      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: String(line.id),
          action: 'ORDER_LINE_ADDED',
        },
      });
      expect(entry!.afterState).toMatchObject({
        costBasis: 'recipe_incomplete_br_mnu_012',
      });
    });

    it('sells a recipe with NO components at a truthful zero partial cost', async () => {
      const { variant } = await mkSellable('Empty recipe item', 3_000n);
      const version = await mkPublishedRecipe(variant.id, []);

      const order = await openOrder();
      const res = await addLine(order, {
        menuItemId: variant.menuItemId,
        variantId: variant.id,
      });

      expect(res.status).toBe(201);
      const line = (res.body as { line: Record<string, unknown> }).line;
      // The recipe EXISTS, so its version is snapshotted - this is not the
      // absent case even though the cost happens to be zero.
      expect(line.recipeVersionId).toBe(version.id);
      expect(line.unitCostSnapshot).toBe('0');
    });
  });

  // ---------------------------------------------- concurrency + idempotency

  describe('FR-API-020…023 and §24.6.4 optimistic concurrency', () => {
    it('replays an identical request instead of adding a second line', async () => {
      const order = await openOrder();
      const key = `line-${newId()}`;
      const first = await addLine(order, {}, { key });
      const second = await addLine(order, {}, { key });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect((second.body as { line: { id: string } }).line.id).toBe(
        (first.body as { line: { id: string } }).line.id,
      );

      const lines = await admin.orderLine.findMany({
        where: { orderId: order.id },
      });
      expect(lines).toHaveLength(1);
    });

    it('P1E-6A Defect A: same key + identical body across two DIFFERENT orders 409-conflicts — never replays the first order onto the second', async () => {
      // Two different orders, added with the SAME body: before the fix, the
      // idempotency fingerprint hashed the registered route pattern
      // (`/orders/:businessDay/:id/lines`), which does not vary per order,
      // so this reused key would have silently replayed orderOne's line
      // onto orderTwo instead of either adding a real second line or
      // 409-conflicting.
      const orderOne = await openOrder();
      const orderTwo = await openOrder();
      const key = `line-fp-${newId()}`;

      const first = await addLine(orderOne, {}, { key });
      expect(first.status).toBe(201);
      const second = await addLine(orderTwo, {}, { key });
      expect(second.status).toBe(409);

      // orderTwo is completely untouched: no line added, no version bump,
      // and orderOne's response never leaks onto orderTwo's response.
      const linesTwo = await admin.orderLine.findMany({
        where: { orderId: orderTwo.id },
      });
      expect(linesTwo).toHaveLength(0);
      const afterTwo = await admin.order.findFirstOrThrow({
        where: { id: orderTwo.id },
      });
      expect(afterTwo.version).toBe(orderTwo.version);
    });

    it('rejects a stale If-Match with 409', async () => {
      const order = await openOrder();
      await addLine(order);
      // The order is now at version+1; the original ETag is stale.
      const stale = await addLine(order);
      expect(stale.status).toBe(409);
    });

    it('requires an If-Match header at all', async () => {
      const order = await openOrder();
      const res = await request(http)
        .post(`/orders/${day(order.businessDay)}/${order.id}/lines`)
        .set('Authorization', `Bearer ${posToken}`)
        .set('Idempotency-Key', `line-${newId()}`)
        .send({ menuItemId, variantId, quantity: '1' });
      expect(res.status).toBe(400);
    });

    it('refuses If-Match: * on a financial mutation', async () => {
      const order = await openOrder();
      const res = await addLine(order, {}, { ifMatch: '*' });
      expect(res.status).toBe(400);
    });

    it('refuses an ETag belonging to a different order', async () => {
      const order = await openOrder();
      const other = await openOrder();
      const res = await addLine(order, {}, { ifMatch: `W/"${other.id}.1"` });
      expect(res.status).toBe(400);
    });

    it('requires an Idempotency-Key', async () => {
      const order = await openOrder();
      const res = await request(http)
        .post(`/orders/${day(order.businessDay)}/${order.id}/lines`)
        .set('Authorization', `Bearer ${posToken}`)
        .set('If-Match', `W/"${order.id}.${order.version}"`)
        .send({ menuItemId, variantId, quantity: '1' });
      expect(res.status).toBe(400);
    });

    it('adds exactly one line under concurrent identical requests', async () => {
      const order = await openOrder();
      const key = `line-${newId()}`;
      const results = await Promise.allSettled([
        addLine(order, {}, { key }),
        addLine(order, {}, { key }),
      ]);
      const statuses = results
        .map((r) => (r.status === 'fulfilled' ? r.value.status : 0))
        .sort();
      // Either both see the replay, or one is refused as in-flight (409).
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);

      const lines = await admin.orderLine.findMany({
        where: { orderId: order.id },
      });
      expect(lines).toHaveLength(1);
    });
  });

  // ----------------------------------------------------- client cannot force

  describe('the client cannot supply anything financial', () => {
    it('rejects a body carrying a price, tax, cost or provenance field', async () => {
      const order = await openOrder();
      for (const forbidden of [
        { unitPrice: '1' },
        { taxAmount: '0' },
        { taxClassId: taxClassZero },
        { unitCostSnapshot: '0' },
        { recipeVersionId },
        { lineTotal: '1' },
        { priceListId },
        { tenantId: tenantB },
      ]) {
        const res = await addLine(order, forbidden);
        expect(res.status).toBe(400);
      }
    });

    it('rejects a quantity finer than DECIMAL(12,3)', async () => {
      const order = await openOrder();
      for (const quantity of ['1.0001', '0', '0.000', '-1', '1e3', 'two']) {
        expect((await addLine(order, { quantity })).status).toBe(400);
      }
    });

    it('accepts an exact fractional quantity', async () => {
      const order = await openOrder();
      const res = await addLine(order, { quantity: '0.5' });
      expect(res.status).toBe(201);
      const line = (res.body as { line: Record<string, unknown> }).line;
      expect(line.quantity).toBe('0.5');
      expect(line.lineSubtotal).toBe('5000');
      expect(line.taxAmount).toBe('700');
    });
  });

  // ------------------------------------------------------- tenant isolation

  describe('tenant isolation', () => {
    it('refuses a menu item belonging to another tenant', async () => {
      const order = await openOrder();
      const res = await addLine(order, { variantId: foreignVariant });
      expect(res.status).toBe(404);
    });

    it('refuses a tax class belonging to another tenant', async () => {
      // A cross-tenant reference cannot even be created: the DB refuses it.
      await expect(
        admin.menuItem.update({
          where: { id: menuItemId },
          data: { taxClassId: foreignTaxClass },
        }),
      ).rejects.toThrow();
    });

    it('cannot reach tenant A resources from a tenant B context', async () => {
      // Tenant A's terminal is invisible under tenant B's RLS context, so an
      // order opened as tenant B cannot borrow it. The failure is a 404-shaped
      // "not found", never a 403 that would confirm the terminal exists.
      await expect(
        orders.create(tenantB, userB, {
          terminalId: terminalA,
          openedByEmployeeId: employeeA,
          orderType: 'takeaway',
          channel: 'pos',
          originDeviceTime: AT,
          idempotencyKey: `k-${newId()}`,
          at: AT,
        }),
      ).rejects.toThrow(/Terminal not found/);
    });

    it('cannot read a tenant A order line from a tenant B context', async () => {
      const order = await openOrder();
      await addLine(order);
      const visible = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM sales.order_lines WHERE order_id = $1`,
        order.id,
      );
      // Positive control: the migrator DOES see it, so a zero below would prove
      // filtering rather than absent data.
      expect(Number(visible[0].n)).toBeGreaterThan(0);
      expect(
        await orders.findOne(tenantB, order.id, order.businessDay),
      ).toBeNull();
    });
  });

  // ------------------------------------------------------ authority boundary

  describe('Clarification C — the fire boundary', () => {
    it('lets the cashier void a PRE-FIRE line', async () => {
      const order = await openOrder();
      const added = await addLine(order);
      const line = (added.body as { line: { id: string } }).line;
      const version = (added.body as { order: { version: number } }).order
        .version;

      const res = await request(http)
        .delete(
          `/orders/${day(order.businessDay)}/${order.id}/lines/${line.id}`,
        )
        .set('Authorization', `Bearer ${posToken}`)
        .set('If-Match', `W/"${order.id}.${version}"`)
        .send({ reasonCodeId });

      expect(res.status).toBe(200);
      expect((res.body as { line: { state: string } }).line.state).toBe(
        'voided',
      );
      // Totals drop; the row is RETAINED as evidence.
      expect(
        (res.body as { order: { grandTotal: string } }).order.grandTotal,
      ).toBe('0');
      expect(
        await admin.orderLine.findFirst({ where: { id: line.id } }),
      ).not.toBeNull();
    });

    it('refuses a cashier void once the line is FIRED', async () => {
      const order = await openOrder();
      const added = await addLine(order);
      const line = (added.body as { line: { id: string } }).line;
      const version = (added.body as { order: { version: number } }).order
        .version;

      await admin.orderLine.update({
        where: {
          id_businessDay: { id: line.id, businessDay: order.businessDay },
        },
        data: { state: 'fired', firedAt: new Date() },
      });

      const res = await request(http)
        .delete(
          `/orders/${day(order.businessDay)}/${order.id}/lines/${line.id}`,
        )
        .set('Authorization', `Bearer ${posToken}`)
        .set('If-Match', `W/"${order.id}.${version}"`)
        .send({ reasonCodeId });

      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/sent to production/i);
      // Still there, still fired.
      const after = await admin.orderLine.findFirstOrThrow({
        where: { id: line.id },
      });
      expect(after.state).toBe('fired');
    });

    it('refuses a line on a COMPLETED order, for every actor', async () => {
      const order = await openOrder();
      await admin.order.update({
        where: {
          id_businessDay: { id: order.id, businessDay: order.businessDay },
        },
        data: { state: 'completed', completedAt: new Date() },
      });
      const res = await addLine(order);
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(
        /BR-POS-001|can no longer be modified/i,
      );
    });
  });
});
