import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { AUDIT_ACTION } from './../src/modules/governance/audit/audit.constants';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import {
  PROCUREMENT_PERMISSIONS,
  PROCUREMENT_PERMISSION_DEFS,
  PURCHASE_ORDER_CREATE_PERMISSION,
} from './../src/modules/procurement/procurement.permissions';
import { createMigratorClient } from './rls-admin';
import {
  DEV_PASSWORD,
  createActiveBranch,
  dashboardToken,
} from './reporting-fixtures';
import { pinLogin } from './kds-fixtures';

interface SupplierBody {
  id: string;
  code: string;
  legalName: string;
  currency: string;
  minimumOrderValue: string;
  status: string;
  supplierItemCode?: string | null;
}

interface LinkBody {
  id: string;
  supplierItemCode: string | null;
  supplierBarcodes: string[];
  preferenceRank: number;
}

interface PriceEntryBody {
  id: string;
  unitPrice: string;
  packSize: string;
  volumeTiers: unknown[] | null;
}

interface ComparativeRowBody {
  supplierId: string;
}

/** Every supertest response body is `any` — this is the one, explicit cast
 *  point per shape, matching `reporting-fixtures.ts`'s own
 *  `(login.body as { accessToken: string })` convention. */
function bodyOf<T>(res: request.Response): T {
  return res.body as T;
}

/**
 * FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1 §16 — functional, permission, and
 * audit coverage over real HTTP + a real Postgres database.
 */
describe('Procurement Supplier Foundation (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let seq = 0;
  const nextSeed = () => `${stamp}${(seq++).toString(36)}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  interface Fixture {
    tenantId: string;
    dashboardEmail: string;
    token: string;
  }

  async function createFixture(
    seed: string,
    permissionCodes: readonly string[] = [
      PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    ],
  ): Promise<Fixture> {
    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const permissions = app.get(PermissionsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const tenant = await tenants.create({
      slug: `prc-${seed}`,
      legalName: `Procurement ${seed}`,
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    const tenantId = tenant.id;

    await permissions.upsertMany(PROCUREMENT_PERMISSION_DEFS);
    const role = await roles.createTenantRole(tenantId, {
      name: `prc_${seed}`,
    });
    if (permissionCodes.length > 0) {
      await roles.addPermissions(tenantId, role.id, [...permissionCodes]);
    }

    const dashboardEmail = `prc.dash.${seed}@example.com`;
    const user = await users.createUser({
      email: dashboardEmail,
      password: DEV_PASSWORD,
      displayName: 'Dashboard',
    });
    const membership = await memberships.grant(user.id, tenantId, 'active');
    await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });

    const token = await dashboardToken(http, dashboardEmail, tenantId);
    return { tenantId, dashboardEmail, token };
  }

  /** A real Inventory StockItem (+ base Uom), created directly (no Procurement
   *  HTTP route creates Inventory data — mirrors `inventory-rls.e2e-spec.ts`). */
  async function createStockItem(tenantId: string, seed: string) {
    const uomId = newId();
    await admin.uom.create({
      data: { id: uomId, dimension: 'mass', code: `kg-${seed}`, name: 'kg' },
    });
    const stockItemId = newId();
    await admin.stockItem.create({
      data: {
        id: stockItemId,
        tenantId,
        sku: `SKU-${seed}`,
        names: { en: `Item ${seed}` },
        baseUnitId: uomId,
      },
    });
    const packagingUnitId = newId();
    await admin.packagingUnit.create({
      data: {
        id: packagingUnitId,
        stockItemId,
        name: `Case-${seed}`,
        conversionFactorToBase: '12',
      },
    });
    return { stockItemId, baseUnitId: uomId, packagingUnitId };
  }

  function authed(fx: Fixture) {
    return {
      post: (url: string) =>
        request(http).post(url).set('Authorization', `Bearer ${fx.token}`),
      get: (url: string) =>
        request(http).get(url).set('Authorization', `Bearer ${fx.token}`),
      patch: (url: string) =>
        request(http).patch(url).set('Authorization', `Bearer ${fx.token}`),
    };
  }

  async function createSupplier(
    fx: Fixture,
    code: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SupplierBody> {
    const res = await authed(fx)
      .post('/procurement/suppliers')
      .send({
        code,
        legalName: `Legal ${code}`,
        paymentTermsNetDays: 0,
        currency: 'EGP',
        deliveryLeadTimeDays: 0,
        minimumOrderValue: '0',
        ...overrides,
      })
      .expect(201);
    return bodyOf<SupplierBody>(res);
  }

  // ── Supplier master — FR-PRC-005 ─────────────────────────────────────────

  describe('Supplier master', () => {
    it('creates a full valid supplier', async () => {
      const fx = await createFixture(nextSeed());
      const res = await authed(fx)
        .post('/procurement/suppliers')
        .send({
          code: 'SUP-001',
          legalName: 'Acme Foods LLC',
          tradingName: 'Acme',
          taxRegistrationNumber: 'TRN-123',
          addresses: [
            {
              line1: '1 Market St',
              city: 'Cairo',
              countryCode: 'EG',
              isPrimary: true,
            },
          ],
          contacts: [
            { name: 'Jane Doe', role: 'sales', email: 'jane@acme.example' },
          ],
          paymentTermsNetDays: 30,
          currency: 'EGP',
          deliveryLeadTimeDays: 2,
          minimumOrderValue: '50000',
          deliveryDays: [0, 2, 4],
        })
        .expect(201);
      const created = bodyOf<SupplierBody>(res);
      expect(created).toMatchObject({
        code: 'SUP-001',
        legalName: 'Acme Foods LLC',
        currency: 'EGP',
        minimumOrderValue: '50000',
        status: 'active',
      });

      const auditCount = await admin.auditEntry.count({
        where: { action: AUDIT_ACTION.SUPPLIER_CREATED, entityId: created.id },
      });
      expect(auditCount).toBe(1);
    });

    it('rejects a duplicate code in the same tenant (409), allows the same code in another tenant', async () => {
      const fx1 = await createFixture(nextSeed());
      const fx2 = await createFixture(nextSeed());
      const body = {
        code: 'DUP-CODE',
        legalName: 'Dup Co',
        paymentTermsNetDays: 0,
        currency: 'EGP',
        deliveryLeadTimeDays: 0,
        minimumOrderValue: '0',
      };
      await authed(fx1).post('/procurement/suppliers').send(body).expect(201);
      await authed(fx1).post('/procurement/suppliers').send(body).expect(409);
      // Same code, different tenant — allowed.
      await authed(fx2).post('/procurement/suppliers').send(body).expect(201);
    });

    it('rejects an invalid currency (400)', async () => {
      const fx = await createFixture(nextSeed());
      await authed(fx)
        .post('/procurement/suppliers')
        .send({
          code: 'BAD-CCY',
          legalName: 'Bad Currency Co',
          paymentTermsNetDays: 0,
          currency: 'egp',
          deliveryLeadTimeDays: 0,
          minimumOrderValue: '0',
        })
        .expect(400);
    });

    it('rejects negative lead time / min order / payment terms (400)', async () => {
      const fx = await createFixture(nextSeed());
      await authed(fx)
        .post('/procurement/suppliers')
        .send({
          code: 'NEG-1',
          legalName: 'Negative Co',
          paymentTermsNetDays: -1,
          currency: 'EGP',
          deliveryLeadTimeDays: 0,
          minimumOrderValue: '0',
        })
        .expect(400);
      await authed(fx)
        .post('/procurement/suppliers')
        .send({
          code: 'NEG-2',
          legalName: 'Negative Co',
          paymentTermsNetDays: 0,
          currency: 'EGP',
          deliveryLeadTimeDays: -5,
          minimumOrderValue: '0',
        })
        .expect(400);
    });

    it('preserves and reads an inactive supplier', async () => {
      const fx = await createFixture(nextSeed());
      const created = await createSupplier(fx, 'INACT-1');

      await authed(fx)
        .patch(`/procurement/suppliers/${created.id}/status`)
        .send({ status: 'inactive' })
        .expect(200);

      const fetched = await authed(fx)
        .get(`/procurement/suppliers/${created.id}`)
        .expect(200);
      expect(bodyOf<SupplierBody>(fetched).status).toBe('inactive');

      const auditCount = await admin.auditEntry.count({
        where: {
          action: AUDIT_ACTION.SUPPLIER_STATUS_CHANGED,
          entityId: created.id,
        },
      });
      expect(auditCount).toBe(1);
    });
  });

  // ── Supplier <-> StockItem sourcing — FR-PRC-007 / FR-INV-005 ───────────

  describe('Supplier sourcing', () => {
    it('lets multiple suppliers source the same item, and one supplier source multiple items', async () => {
      const fx = await createFixture(nextSeed());
      const { stockItemId: item1 } = await createStockItem(
        fx.tenantId,
        nextSeed(),
      );
      const { stockItemId: item2 } = await createStockItem(
        fx.tenantId,
        nextSeed(),
      );
      const s1 = await createSupplier(fx, 'S1');
      const s2 = await createSupplier(fx, 'S2');

      await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: s1.id, stockItemId: item1, preferenceRank: 0 })
        .expect(201);
      await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: s2.id, stockItemId: item1, preferenceRank: 1 })
        .expect(201);
      await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: s1.id, stockItemId: item2, preferenceRank: 0 })
        .expect(201);

      const forItem1 = await authed(fx)
        .get(`/procurement/supplier-item-links?stockItemId=${item1}`)
        .expect(200);
      expect(bodyOf<LinkBody[]>(forItem1)).toHaveLength(2);

      const forSupplier1 = await authed(fx)
        .get(`/procurement/supplier-item-links?supplierId=${s1.id}`)
        .expect(200);
      expect(bodyOf<LinkBody[]>(forSupplier1)).toHaveLength(2);
    });

    it('rejects a cross-tenant stock item (404)', async () => {
      const fxA = await createFixture(nextSeed());
      const fxB = await createFixture(nextSeed());
      const { stockItemId } = await createStockItem(fxB.tenantId, nextSeed());
      const supplier = await createSupplier(fxA, 'XT-1');
      await authed(fxA)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: supplier.id, stockItemId })
        .expect(404);
    });

    it('persists supplier-specific item code/barcodes, and returns deterministic preference ranking', async () => {
      const fx = await createFixture(nextSeed());
      const { stockItemId } = await createStockItem(fx.tenantId, nextSeed());
      const sLow = await createSupplier(fx, 'RANK-LOW');
      const sHigh = await createSupplier(fx, 'RANK-HIGH');

      const linkHighRes = await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({
          supplierId: sHigh.id,
          stockItemId,
          preferenceRank: 5,
          supplierItemCode: 'SUP-CODE-9',
          supplierBarcodes: ['0123456789012'],
        })
        .expect(201);
      const linkHigh = bodyOf<LinkBody>(linkHighRes);
      const linkLowRes = await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: sLow.id, stockItemId, preferenceRank: 1 })
        .expect(201);
      const linkLow = bodyOf<LinkBody>(linkLowRes);

      expect(linkHigh.supplierItemCode).toBe('SUP-CODE-9');
      expect(linkHigh.supplierBarcodes).toEqual(['0123456789012']);

      const list = await authed(fx)
        .get(`/procurement/supplier-item-links?stockItemId=${stockItemId}`)
        .expect(200);
      expect(bodyOf<LinkBody[]>(list).map((l) => l.id)).toEqual([
        linkLow.id,
        linkHigh.id,
      ]);
    });
  });

  // ── Supplier price list and comparative pricing ─────────────────────────

  describe('Supplier price list and comparative pricing', () => {
    async function setup(seed: string) {
      const fx = await createFixture(seed);
      const { stockItemId, baseUnitId, packagingUnitId } =
        await createStockItem(fx.tenantId, seed);
      const supplier = await createSupplier(fx, `PRICE-${seed}`);
      const linkRes = await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: supplier.id, stockItemId })
        .expect(201);
      const link = bodyOf<LinkBody>(linkRes);
      return {
        fx,
        stockItemId,
        baseUnitId,
        packagingUnitId,
        supplierId: supplier.id,
        linkId: link.id,
      };
    }

    it('creates a base price entry with exact minor units and 6dp pack size', async () => {
      const { fx, baseUnitId, linkId } = await setup(nextSeed());
      const res = await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1.123456',
          unitPrice: '12345',
          currency: 'EGP',
          validFrom: '2026-01-01T00:00:00.000Z',
        })
        .expect(201);
      const created = bodyOf<PriceEntryBody>(res);
      expect(created.unitPrice).toBe('12345');
      expect(created.packSize).toBe('1.123456');

      const auditCount = await admin.auditEntry.count({
        where: {
          action: AUDIT_ACTION.SUPPLIER_PRICE_ENTRY_CREATED,
          entityId: created.id,
        },
      });
      expect(auditCount).toBe(1);
    });

    it('requires a valid purchase unit for the stock item (400)', async () => {
      const { fx, linkId } = await setup(nextSeed());
      await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: newId(),
          packSize: '1',
          unitPrice: '100',
          currency: 'EGP',
          validFrom: '2026-01-01T00:00:00.000Z',
        })
        .expect(400);
    });

    it('rejects a price entry whose currency does not match the supplier currency (400)', async () => {
      const { fx, baseUnitId, linkId } = await setup(nextSeed());
      await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1',
          unitPrice: '100',
          currency: 'USD',
          validFrom: '2026-01-01T00:00:00.000Z',
        })
        .expect(400);
    });

    it('validates and persists volume tiers', async () => {
      const { fx, baseUnitId, linkId } = await setup(nextSeed());
      const okRes = await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1',
          unitPrice: '100',
          currency: 'EGP',
          validFrom: '2026-01-01T00:00:00.000Z',
          volumeTiers: [
            { minimumQuantity: '10', unitPriceMinor: '90' },
            { minimumQuantity: '50', unitPriceMinor: '80' },
          ],
        })
        .expect(201);
      expect(bodyOf<PriceEntryBody>(okRes).volumeTiers).toHaveLength(2);

      await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1',
          unitPrice: '100',
          currency: 'EGP',
          validFrom: '2027-01-01T00:00:00.000Z',
          volumeTiers: [
            { minimumQuantity: '50', unitPriceMinor: '80' },
            { minimumQuantity: '10', unitPriceMinor: '90' },
          ],
        })
        .expect(400);
    });

    it('validFrom/validUntil: future price not effective early; historical price stays readable after a newer price', async () => {
      const { fx, baseUnitId, linkId } = await setup(nextSeed());
      await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1',
          unitPrice: '100',
          currency: 'EGP',
          validFrom: '2020-01-01T00:00:00.000Z',
          validUntil: '2021-01-01T00:00:00.000Z',
        })
        .expect(201);
      await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1',
          unitPrice: '200',
          currency: 'EGP',
          validFrom: '2099-01-01T00:00:00.000Z',
        })
        .expect(201);

      // "now" (2026) is after the first window and before the far-future one.
      const effectiveNow = await authed(fx)
        .get(
          `/procurement/supplier-price-entries/effective?supplierItemLinkId=${linkId}`,
        )
        .expect(200);
      expect(bodyOf<PriceEntryBody[]>(effectiveNow)).toEqual([]);

      const effectiveHistorical = await authed(fx)
        .get(
          `/procurement/supplier-price-entries/effective?supplierItemLinkId=${linkId}&at=2020-06-01T00:00:00.000Z`,
        )
        .expect(200);
      const historicalRows = bodyOf<PriceEntryBody[]>(effectiveHistorical);
      expect(historicalRows).toHaveLength(1);
      expect(historicalRows[0].unitPrice).toBe('100');

      const history = await authed(fx)
        .get(`/procurement/supplier-price-entries?supplierItemLinkId=${linkId}`)
        .expect(200);
      expect(bodyOf<PriceEntryBody[]>(history)).toHaveLength(2);
    });

    it('rejects an ambiguous overlapping validity window for the same scope (409)', async () => {
      const { fx, baseUnitId, linkId } = await setup(nextSeed());
      await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1',
          unitPrice: '100',
          currency: 'EGP',
          validFrom: '2026-01-01T00:00:00.000Z',
          validUntil: '2026-06-01T00:00:00.000Z',
        })
        .expect(201);
      await authed(fx)
        .post('/procurement/supplier-price-entries')
        .send({
          supplierItemLinkId: linkId,
          purchaseUnitId: baseUnitId,
          packSize: '1',
          unitPrice: '150',
          currency: 'EGP',
          validFrom: '2026-03-01T00:00:00.000Z',
        })
        .expect(409);
    });

    it('comparative pricing: multiple suppliers, ordered by preference, inactive supplier excluded, historical `at` honored', async () => {
      const fx = await createFixture(nextSeed());
      const seed = nextSeed();
      const { stockItemId, baseUnitId } = await createStockItem(
        fx.tenantId,
        seed,
      );

      const sPreferred = await createSupplier(fx, `CMP-PREF-${seed}`);
      const sOther = await createSupplier(fx, `CMP-OTHER-${seed}`);
      const sInactive = await createSupplier(fx, `CMP-INACT-${seed}`);
      await authed(fx)
        .patch(`/procurement/suppliers/${sInactive.id}/status`)
        .send({ status: 'inactive' })
        .expect(200);

      const linkPreferredRes = await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: sPreferred.id, stockItemId, preferenceRank: 0 })
        .expect(201);
      const linkPreferred = bodyOf<LinkBody>(linkPreferredRes);
      const linkOtherRes = await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: sOther.id, stockItemId, preferenceRank: 5 })
        .expect(201);
      const linkOther = bodyOf<LinkBody>(linkOtherRes);
      const linkInactiveRes = await authed(fx)
        .post('/procurement/supplier-item-links')
        .send({ supplierId: sInactive.id, stockItemId, preferenceRank: 1 })
        .expect(201);
      const linkInactive = bodyOf<LinkBody>(linkInactiveRes);

      for (const [linkId, price] of [
        [linkPreferred.id, '100'],
        [linkOther.id, '90'],
        [linkInactive.id, '80'],
      ] as const) {
        await authed(fx)
          .post('/procurement/supplier-price-entries')
          .send({
            supplierItemLinkId: linkId,
            purchaseUnitId: baseUnitId,
            packSize: '1',
            unitPrice: price,
            currency: 'EGP',
            validFrom: '2026-01-01T00:00:00.000Z',
          })
          .expect(201);
      }

      const comparative = await authed(fx)
        .get(`/procurement/comparative-pricing?stockItemId=${stockItemId}`)
        .expect(200);
      const comparativeRows = bodyOf<ComparativeRowBody[]>(comparative);

      expect(comparativeRows).toHaveLength(2);
      expect(comparativeRows.map((r) => r.supplierId)).toEqual([
        sPreferred.id,
        sOther.id,
      ]);

      // Historical `at` before any price was effective returns nothing.
      const historical = await authed(fx)
        .get(
          `/procurement/comparative-pricing?stockItemId=${stockItemId}&at=2020-01-01T00:00:00.000Z`,
        )
        .expect(200);
      expect(bodyOf<ComparativeRowBody[]>(historical)).toEqual([]);
    });
  });

  // ── Permissions ──────────────────────────────────────────────────────────

  describe('Permissions', () => {
    it('supplier.manage holder can mutate; an actor with no permission is rejected (403)', async () => {
      const fxManage = await createFixture(nextSeed());
      const fxNone = await createFixture(nextSeed(), []);
      await authed(fxManage)
        .post('/procurement/suppliers')
        .send({
          code: 'PERM-OK',
          legalName: 'Perm Co',
          paymentTermsNetDays: 0,
          currency: 'EGP',
          deliveryLeadTimeDays: 0,
          minimumOrderValue: '0',
        })
        .expect(201);
      await authed(fxNone)
        .post('/procurement/suppliers')
        .send({
          code: 'PERM-NO',
          legalName: 'Perm Co',
          paymentTermsNetDays: 0,
          currency: 'EGP',
          deliveryLeadTimeDays: 0,
          minimumOrderValue: '0',
        })
        .expect(403);
    });

    it('a read route accepts purchase.order.create alone (any-permission guard)', async () => {
      // Simulates the future PO slice having seeded this SRS §15.2 code —
      // Procurement itself seeds only `supplier.manage` (see
      // `procurement.permissions.ts`).
      const permissions = app.get(PermissionsService);
      await permissions.upsertMany([
        {
          code: PURCHASE_ORDER_CREATE_PERMISSION,
          module: 'purchase',
          description: 'test-only: future PO slice permission',
        },
      ]);
      const fx = await createFixture(nextSeed(), [
        PURCHASE_ORDER_CREATE_PERMISSION,
      ]);
      await authed(fx).get('/procurement/suppliers').expect(200);
      // But this actor cannot mutate — supplier.manage is required for writes.
      await authed(fx)
        .post('/procurement/suppliers')
        .send({
          code: 'PO-ONLY',
          legalName: 'PO Only Co',
          paymentTermsNetDays: 0,
          currency: 'EGP',
          deliveryLeadTimeDays: 0,
          minimumOrderValue: '0',
        })
        .expect(403);
    });

    it('rejects a POS token (back-office/console only, §12)', async () => {
      const fx = await createFixture(nextSeed());
      const brand = await admin.brand.create({
        data: {
          id: newId(),
          tenantId: fx.tenantId,
          name: `Brand ${nextSeed()}`,
        },
      });
      const branchId = await createActiveBranch(
        admin,
        fx.tenantId,
        brand.id,
        nextSeed(),
      );
      const terminal = await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: fx.tenantId,
          branchId,
          name: 'POS-1',
          terminalType: 'pos',
          status: 'active',
        },
      });
      const employees = app.get(EmployeesService);
      const pins = app.get(PinService);
      const users = app.get(UsersService);
      const memberships = app.get(MembershipsService);
      const empUser = await users.createUser({
        email: `prc.emp.${nextSeed()}@example.com`,
        password: DEV_PASSWORD,
        displayName: 'Employee',
      });
      await memberships.grant(empUser.id, fx.tenantId, 'active');
      const employeeCode = `E${nextSeed().slice(-6)}`;
      const employee = await employees.create(fx.tenantId, empUser.id, {
        code: employeeCode,
        displayName: 'Employee',
        homeBranchId: branchId,
        userId: empUser.id,
      });
      await pins.setPin(fx.tenantId, empUser.id, employee.id, '1234');
      const posToken = await pinLogin(
        http,
        fx.tenantId,
        terminal.id,
        employeeCode,
        '1234',
      );

      // JwtAuthGuard refuses a `pos`-typed token on a non-POS-opted-in route
      // with 403 (FR-SEC-021: PIN auth must not reach the dashboard) — an
      // authorization refusal, not an authentication failure.
      await request(http)
        .get('/procurement/suppliers')
        .set('Authorization', `Bearer ${posToken}`)
        .expect(403);
    });
  });
});
