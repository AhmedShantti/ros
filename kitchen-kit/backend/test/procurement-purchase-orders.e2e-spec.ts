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
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { SettingsAdminService } from './../src/modules/platform-settings/settings-admin.service';
import {
  PROCUREMENT_PERMISSIONS,
  PROCUREMENT_PERMISSION_DEFS,
} from './../src/modules/procurement/procurement.permissions';
import { PO_APPROVAL_THRESHOLDS_SETTING_KEY } from './../src/modules/procurement/purchase-orders/po-thresholds';
import { createMigratorClient } from './rls-admin';
import {
  DEV_PASSWORD,
  createActiveBranch,
  dashboardToken,
} from './reporting-fixtures';
import { pinLogin } from './kds-fixtures';

interface SupplierBody {
  id: string;
  status: string;
}
interface LinkBody {
  id: string;
}
interface PriceEntryBody {
  id: string;
  unitPrice: string;
}
interface RequisitionLineBody {
  id: string;
  requisitionId: string;
  stockItemId: string;
  purchaseUnitId: string;
}
interface RequisitionBody {
  id: string;
  status: string;
  requestingBranchId: string;
  lines: RequisitionLineBody[];
}
interface PoLineBody {
  id: string;
  stockItemId: string;
  purchaseUnitId: string;
  quantity: string;
  unitPrice: string;
  netAmount: string;
  taxAmount: string;
  lineTotal: string;
  supplierPriceEntryId: string | null;
  sourceRequisitionLineId: string | null;
  attributionBranchId: string;
}
interface PoBody {
  id: string;
  status: string;
  requestedBy: string;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  approvalBand: string | null;
  approvalRequiredPermission: string | null;
  approvalRequestId: string | null;
  approvedBand: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  version: number;
  lines: PoLineBody[];
}
interface AmendmentBody {
  id: string;
  amendmentNumber: number;
  oldTotal: string;
  newTotal: string;
  oldApprovalBand: string | null;
  newApprovalBand: string | null;
}

function bodyOf<T>(res: request.Response): T {
  return res.body as T;
}

/**
 * FULL-SRS-PRC-PURCHASE-ORDERS-P2 §19 — functional, permission, approval,
 * amendment, and audit coverage over real HTTP + a real Postgres database.
 */
describe('Procurement Purchase Orders (e2e)', () => {
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

  // ── Fixtures ──────────────────────────────────────────────────────────

  interface Fixture {
    tenantId: string;
    userId: string;
    dashboardEmail: string;
    token: string;
  }

  async function createFixture(
    seed: string,
    permissionCodes: readonly string[] = [
      PROCUREMENT_PERMISSIONS.REQUISITION_CREATE,
      PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE,
      // Fixtures also set up Supplier/SupplierItemLink/SupplierPriceEntry
      // data through the real HTTP routes (Supplier Foundation P1's own
      // controller), which requires `supplier.manage`.
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
      slug: `po-${seed}`,
      legalName: `PO ${seed}`,
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    const tenantId = tenant.id;

    await permissions.upsertMany(PROCUREMENT_PERMISSION_DEFS);
    const role = await roles.createTenantRole(tenantId, { name: `po_${seed}` });
    if (permissionCodes.length > 0) {
      await roles.addPermissions(tenantId, role.id, [...permissionCodes]);
    }

    const dashboardEmail = `po.dash.${seed}@example.com`;
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
    return { tenantId, userId: user.id, dashboardEmail, token };
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

  async function createBranchWithLocation(tenantId: string, seed: string) {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `Brand ${seed}` },
    });
    const branchId = await createActiveBranch(admin, tenantId, brand.id, seed);
    const location = await admin.location.findFirstOrThrow({
      where: { tenantId, branchId, locationType: 'branch' },
    });
    return { branchId, locationId: location.id };
  }

  async function createStockItem(tenantId: string, seed: string) {
    const uomId = newId();
    await admin.uom.create({
      data: {
        id: uomId,
        dimension: 'mass',
        code: `kg-${seed.slice(-8)}`,
        name: 'kg',
      },
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
    return { stockItemId, baseUnitId: uomId };
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

  async function createSourcingLink(
    fx: Fixture,
    supplierId: string,
    stockItemId: string,
  ): Promise<LinkBody> {
    const res = await authed(fx)
      .post('/procurement/supplier-item-links')
      .send({ supplierId, stockItemId })
      .expect(201);
    return bodyOf<LinkBody>(res);
  }

  async function createPriceEntry(
    fx: Fixture,
    supplierItemLinkId: string,
    purchaseUnitId: string,
    unitPrice: string,
    validFrom = '2020-01-01T00:00:00.000Z',
  ): Promise<PriceEntryBody> {
    const res = await authed(fx)
      .post('/procurement/supplier-price-entries')
      .send({
        supplierItemLinkId,
        purchaseUnitId,
        packSize: '1',
        unitPrice,
        currency: 'EGP',
        validFrom,
      })
      .expect(201);
    return bodyOf<PriceEntryBody>(res);
  }

  /** Fully wired supplier that actively sources one stock item at a known
   *  effective price, ready for auto-resolved PO lines. */
  async function setupSupplierWithPrice(
    fx: Fixture,
    seed: string,
    unitPrice: string,
  ) {
    const { stockItemId, baseUnitId } = await createStockItem(
      fx.tenantId,
      seed,
    );
    const supplier = await createSupplier(fx, `S-${seed}`);
    const link = await createSourcingLink(fx, supplier.id, stockItemId);
    const priceEntry = await createPriceEntry(
      fx,
      link.id,
      baseUnitId,
      unitPrice,
    );
    return {
      stockItemId,
      baseUnitId,
      supplierId: supplier.id,
      linkId: link.id,
      priceEntry,
    };
  }

  async function setThresholds(
    tenantId: string,
    actorUserId: string,
    t1: string,
    t2: string,
    t3: string,
  ) {
    const settingsAdmin = app.get(SettingsAdminService);
    await settingsAdmin.upsert(
      tenantId,
      actorUserId,
      'tenant',
      tenantId,
      PO_APPROVAL_THRESHOLDS_SETTING_KEY,
      { threshold1Minor: t1, threshold2Minor: t2, threshold3Minor: t3 },
      undefined,
    );
  }

  /** A PIN-verified approver holding exactly ONE tier permission, on a real
   *  registered terminal — the only manual decision channel this Governance
   *  runtime supports (see `purchase-order-approval.service.ts`'s own
   *  docblock). Deliberately a DIFFERENT user than the PO's requester, so
   *  self-approval tests have a genuine positive control available too. */
  async function createApprover(
    fx: Fixture,
    branchId: string,
    seed: string,
    tierPermission: string,
  ) {
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const employees = app.get(EmployeesService);
    const pins = app.get(PinService);

    const role = await roles.createTenantRole(fx.tenantId, {
      name: `approver_${seed}`,
    });
    await roles.addPermissions(fx.tenantId, role.id, [tierPermission]);

    const user = await users.createUser({
      email: `approver.${seed}@example.com`,
      password: DEV_PASSWORD,
      displayName: 'Approver',
    });
    const membership = await memberships.grant(user.id, fx.tenantId, 'active');
    await membershipRoles.create(fx.tenantId, null, {
      membershipId: membership.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });

    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: fx.tenantId,
        branchId,
        name: `APT-${seed}`,
        terminalType: 'kiosk',
        status: 'active',
      },
    });
    const employeeCode = `AP${seed.slice(-6)}`;
    const employee = await employees.create(fx.tenantId, user.id, {
      code: employeeCode,
      displayName: 'Approver',
      homeBranchId: branchId,
      userId: user.id,
    });
    // FR-SEC-022: PINs must be unique WITHIN A BRANCH — a fixed literal PIN
    // collides when two approvers are registered against the same branch
    // (e.g. the wrong-tier + correct-tier approver pair in one test). Derive
    // a per-approver 4-digit PIN deterministically from `seed`.
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash * 31 + seed.charCodeAt(i)) % 10000;
    }
    const pin = String(1000 + (hash % 9000));
    await pins.setPin(fx.tenantId, user.id, employee.id, pin);

    return { userId: user.id, terminalId: terminal.id, employeeCode, pin };
  }

  interface Approver {
    userId: string;
    terminalId: string;
    employeeCode: string;
    pin: string;
  }

  async function decide(
    fx: Fixture,
    poId: string,
    action: 'approve' | 'reject',
    expectedVersion: number,
    approver: Approver,
    expectStatus: number,
  ) {
    const res = await authed(fx)
      .post(`/procurement/purchase-orders/${poId}/${action}`)
      .send({
        expectedVersion,
        approvalDecisionId: newId(),
        terminalId: approver.terminalId,
        employeeCode: approver.employeeCode,
        pin: approver.pin,
      });
    expect(res.status).toBe(expectStatus);
    return res;
  }

  // ── Requisitions — FR-PRC-015 ────────────────────────────────────────────

  describe('Requisitions', () => {
    it('a branch creates a draft requisition', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const { stockItemId, baseUnitId } = await createStockItem(
        fx.tenantId,
        nextSeed(),
      );
      const res = await authed(fx)
        .post('/procurement/requisitions')
        .send({
          requestingBranchId: branchId,
          lines: [{ stockItemId, purchaseUnitId: baseUnitId, quantity: '10' }],
        })
        .expect(201);
      const created = bodyOf<RequisitionBody>(res);
      expect(created.status).toBe('draft');
      expect(created.lines).toHaveLength(1);
    });

    it('submit requires at least one line (422)', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const res = await authed(fx)
        .post('/procurement/requisitions')
        .send({ requestingBranchId: branchId })
        .expect(201);
      const created = bodyOf<RequisitionBody>(res);
      expect(created.lines).toHaveLength(0);
      await authed(fx)
        .post(`/procurement/requisitions/${created.id}/submit`)
        .expect(422);
    });

    it('rejects a foreign branch, unknown stock item, and invalid purchase unit', async () => {
      const fx = await createFixture(nextSeed());
      const otherFx = await createFixture(nextSeed());
      const { branchId: foreignBranchId } = await createBranchWithLocation(
        otherFx.tenantId,
        nextSeed(),
      );
      await authed(fx)
        .post('/procurement/requisitions')
        .send({ requestingBranchId: foreignBranchId })
        .expect(404);

      const { branchId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await authed(fx)
        .post('/procurement/requisitions')
        .send({
          requestingBranchId: branchId,
          lines: [
            { stockItemId: newId(), purchaseUnitId: newId(), quantity: '1' },
          ],
        })
        .expect(404);

      const { stockItemId } = await createStockItem(fx.tenantId, nextSeed());
      await authed(fx)
        .post('/procurement/requisitions')
        .send({
          requestingBranchId: branchId,
          lines: [{ stockItemId, purchaseUnitId: newId(), quantity: '1' }],
        })
        .expect(400);
    });

    it('multiple submitted requisitions from different branches feed one PO, retaining branch attribution', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId: branch1 } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const { branchId: branch2, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const { stockItemId, baseUnitId, supplierId } =
        await setupSupplierWithPrice(fx, nextSeed(), '1000');

      const req1 = await authed(fx)
        .post('/procurement/requisitions')
        .send({
          requestingBranchId: branch1,
          lines: [{ stockItemId, purchaseUnitId: baseUnitId, quantity: '5' }],
        })
        .expect(201)
        .then((r) => bodyOf<RequisitionBody>(r));
      await authed(fx)
        .post(`/procurement/requisitions/${req1.id}/submit`)
        .expect(200);

      const req2 = await authed(fx)
        .post('/procurement/requisitions')
        .send({
          requestingBranchId: branch2,
          lines: [{ stockItemId, purchaseUnitId: baseUnitId, quantity: '7' }],
        })
        .expect(201)
        .then((r) => bodyOf<RequisitionBody>(r));
      await authed(fx)
        .post(`/procurement/requisitions/${req2.id}/submit`)
        .expect(200);

      const poRes = await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
          lines: [
            { sourceRequisitionLineId: req1.lines[0].id },
            { sourceRequisitionLineId: req2.lines[0].id },
          ],
        })
        .expect(201);
      const po = bodyOf<PoBody>(poRes);
      expect(po.lines).toHaveLength(2);
      const attributions = po.lines.map((l) => l.attributionBranchId).sort();
      expect(attributions).toEqual([branch1, branch2].sort());

      // Both fully-consumed requisitions become `converted`.
      const req1After = await authed(fx)
        .get(`/procurement/requisitions/${req1.id}`)
        .expect(200);
      expect(bodyOf<RequisitionBody>(req1After).status).toBe('converted');
      const req2After = await authed(fx)
        .get(`/procurement/requisitions/${req2.id}`)
        .expect(200);
      expect(bodyOf<RequisitionBody>(req2After).status).toBe('converted');
    });
  });

  // ── Purchase Order creation — FR-PRC-016/017 ─────────────────────────────

  describe('Purchase order creation', () => {
    it('creates a manual PO with correct branch attribution and exact server-computed totals', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '1000');
      const item2 = await createStockItem(fx.tenantId, nextSeed());
      await createSourcingLink(fx, s1.supplierId, item2.stockItemId);

      const res = await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: s1.supplierId,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
          lines: [
            {
              stockItemId: s1.stockItemId,
              purchaseUnitId: s1.baseUnitId,
              quantity: '3',
              attributionBranchId: branchId,
              unitPrice: '2000',
              taxAmount: '150',
            },
            {
              stockItemId: item2.stockItemId,
              purchaseUnitId: item2.baseUnitId,
              quantity: '2',
              attributionBranchId: branchId,
              unitPrice: '500',
            },
          ],
        })
        .expect(201);
      const po = bodyOf<PoBody>(res);
      // line 1: net = 2000*3 = 6000, tax=150, total=6150
      // line 2: net = 500*2 = 1000, tax=0, total=1000
      expect(po.lines[0].netAmount).toBe('6000');
      expect(po.lines[0].taxAmount).toBe('150');
      expect(po.lines[0].lineTotal).toBe('6150');
      expect(po.lines[1].netAmount).toBe('1000');
      expect(po.lines[1].lineTotal).toBe('1000');
      expect(po.subtotal).toBe('7000');
      expect(po.taxTotal).toBe('150');
      expect(po.grandTotal).toBe('7150');
    });

    it('rejects an inactive supplier', async () => {
      const fx = await createFixture(nextSeed());
      const { locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const supplier = await createSupplier(fx, `INACT-${nextSeed()}`);
      await authed(fx)
        .patch(`/procurement/suppliers/${supplier.id}/status`)
        .send({ status: 'inactive' })
        .expect(200);
      await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: supplier.id,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
        })
        .expect(422);
    });

    it('rejects a supplier that does not source the item', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const supplier = await createSupplier(fx, `NOSRC-${nextSeed()}`);
      const { stockItemId, baseUnitId } = await createStockItem(
        fx.tenantId,
        nextSeed(),
      );
      await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: supplier.id,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
          lines: [
            {
              stockItemId,
              purchaseUnitId: baseUnitId,
              quantity: '1',
              attributionBranchId: branchId,
              unitPrice: '100',
            },
          ],
        })
        .expect(400);
    });

    it('resolves the effective supplier price when none is explicitly supplied, and a different price entry produces a different snapshot on a separate PO', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '4242');

      const res = await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: s1.supplierId,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
          lines: [
            {
              stockItemId: s1.stockItemId,
              purchaseUnitId: s1.baseUnitId,
              quantity: '1',
              attributionBranchId: branchId,
            },
          ],
        })
        .expect(201);
      const po = bodyOf<PoBody>(res);
      expect(po.lines[0].unitPrice).toBe('4242');
      expect(po.lines[0].supplierPriceEntryId).toBe(s1.priceEntry.id);

      // An explicit unitPrice is honored exactly and carries no
      // supplierPriceEntryId snapshot (mission brief §3 — "when the caller
      // does not explicitly provide an authorised negotiated price").
      const explicitRes = await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: s1.supplierId,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
          lines: [
            {
              stockItemId: s1.stockItemId,
              purchaseUnitId: s1.baseUnitId,
              quantity: '1',
              attributionBranchId: branchId,
              unitPrice: '9999',
            },
          ],
        })
        .expect(201);
      const explicitPo = bodyOf<PoBody>(explicitRes);
      expect(explicitPo.lines[0].unitPrice).toBe('9999');
      expect(explicitPo.lines[0].supplierPriceEntryId).toBeNull();

      // The FIRST PO's snapshot is untouched by the second PO's explicit price
      // (immutable per-PO snapshot — mission brief §13).
      const reread = await authed(fx)
        .get(`/procurement/purchase-orders/${po.id}`)
        .expect(200);
      expect(bodyOf<PoBody>(reread).lines[0].unitPrice).toBe('4242');
    });

    it('rejects a cross-tenant delivery location and a locationType/id mismatch', async () => {
      const fx = await createFixture(nextSeed());
      const otherFx = await createFixture(nextSeed());
      const { locationId: foreignLocationId } = await createBranchWithLocation(
        otherFx.tenantId,
        nextSeed(),
      );
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '100');

      await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: s1.supplierId,
          deliveryLocationType: 'branch',
          deliveryLocationId: foreignLocationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
        })
        .expect(404);

      const { locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: s1.supplierId,
          deliveryLocationType: 'warehouse', // real location is a 'branch'
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
        })
        .expect(400);
    });
  });

  // ── Approval — FR-PRC-018/019 ─────────────────────────────────────────

  describe('Approval', () => {
    async function submittablePo(
      fx: Fixture,
      branchId: string,
      locationId: string,
      unitPrice: string,
    ) {
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), unitPrice);
      const res = await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: s1.supplierId,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
          lines: [
            {
              stockItemId: s1.stockItemId,
              purchaseUnitId: s1.baseUnitId,
              quantity: '1',
              attributionBranchId: branchId,
            },
          ],
        })
        .expect(201);
      return bodyOf<PoBody>(res);
    }

    it('below threshold 1 auto-approves on submit, with no ApprovalRequest and no human approver', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const po = await submittablePo(fx, branchId, locationId, '500');

      const submitRes = await authed(fx)
        .post(`/procurement/purchase-orders/${po.id}/submit`)
        .send({ expectedVersion: po.version })
        .expect(200);
      const submitted = bodyOf<PoBody>(submitRes);
      expect(submitted.status).toBe('approved');
      expect(submitted.approvedBand).toBe('auto');
      expect(submitted.approvedBy).toBeNull();
      expect(submitted.approvalRequestId).toBeNull();

      const requestCount = await admin.approvalRequest.count({
        where: { tenantId: fx.tenantId, entityId: po.id },
      });
      expect(requestCount).toBe(0);
    });

    it('tier_1 band goes to pending_approval, then a valid tier_1 approver approves it via PIN', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const po = await submittablePo(fx, branchId, locationId, '50000');

      const submitRes = await authed(fx)
        .post(`/procurement/purchase-orders/${po.id}/submit`)
        .send({ expectedVersion: po.version })
        .expect(200);
      const submitted = bodyOf<PoBody>(submitRes);
      expect(submitted.status).toBe('pending_approval');
      expect(submitted.approvalBand).toBe('tier_1');
      expect(submitted.approvalRequiredPermission).toBe(
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
      );
      expect(submitted.approvalRequestId).not.toBeNull();

      const approver = await createApprover(
        fx,
        branchId,
        nextSeed(),
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
      );
      const approveRes = await decide(
        fx,
        po.id,
        'approve',
        submitted.version,
        approver,
        200,
      );
      const approved = bodyOf<PoBody>(approveRes);
      expect(approved.status).toBe('approved');
      expect(approved.approvedBand).toBe('tier_1');
      expect(approved.approvedBy).toBe(approver.userId);

      const decisionCount = await admin.approvalDecision.count({
        where: {
          tenantId: fx.tenantId,
          approvalRequestId: submitted.approvalRequestId!,
        },
      });
      expect(decisionCount).toBe(1);
    });

    it('tier_2 and tier_3 amounts map to the correct required permission, and a wrong-tier approver is rejected (403)', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');

      const poTier2 = await submittablePo(fx, branchId, locationId, '500000');
      const submitTier2 = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${poTier2.id}/submit`)
          .send({ expectedVersion: poTier2.version })
          .expect(200),
      );
      expect(submitTier2.approvalBand).toBe('tier_2');
      expect(submitTier2.approvalRequiredPermission).toBe(
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_2,
      );

      const poTier3 = await submittablePo(fx, branchId, locationId, '2000000');
      const submitTier3 = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${poTier3.id}/submit`)
          .send({ expectedVersion: poTier3.version })
          .expect(200),
      );
      expect(submitTier3.approvalBand).toBe('tier_3');
      expect(submitTier3.approvalRequiredPermission).toBe(
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_3,
      );

      // A tier_1-only approver is rejected for the tier_2 PO.
      const tier1Approver = await createApprover(
        fx,
        branchId,
        nextSeed(),
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
      );
      await decide(
        fx,
        poTier2.id,
        'approve',
        submitTier2.version,
        tier1Approver,
        403,
      );

      // The correct tier_2 approver succeeds.
      const tier2Approver = await createApprover(
        fx,
        branchId,
        nextSeed(),
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_2,
      );
      await decide(
        fx,
        poTier2.id,
        'approve',
        submitTier2.version,
        tier2Approver,
        200,
      );
    });

    it('rejects self-approval: the PO requester cannot approve their own PO', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const po = await submittablePo(fx, branchId, locationId, '50000');
      const submitted = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/submit`)
          .send({ expectedVersion: po.version })
          .expect(200),
      );
      expect(submitted.requestedBy).toBe(fx.userId);

      // Register the requester's OWN user as a terminal-PIN identity holding
      // the tier permission, then attempt to approve their own request.
      const roles = app.get(RolesService);
      const membershipRoles = app.get(MembershipRolesService);
      const employees = app.get(EmployeesService);
      const pins = app.get(PinService);
      const selfRole = await roles.createTenantRole(fx.tenantId, {
        name: `self_${nextSeed()}`,
      });
      await roles.addPermissions(fx.tenantId, selfRole.id, [
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
      ]);
      // `createFixture` already granted `fx.userId` an active membership —
      // reuse it (a second `grant` for the same user+tenant violates the
      // `memberships_user_id_tenant_id_key` uniqueness).
      const selfMembership = await admin.membership.findFirstOrThrow({
        where: { userId: fx.userId, tenantId: fx.tenantId },
      });
      await membershipRoles.create(fx.tenantId, null, {
        membershipId: selfMembership.id,
        roleId: selfRole.id,
        scope: { type: 'tenant' },
      });
      const seed = nextSeed();
      const terminal = await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: fx.tenantId,
          branchId,
          name: `SELF-${seed}`,
          terminalType: 'kiosk',
          status: 'active',
        },
      });
      const employeeCode = `SE${seed.slice(-6)}`;
      const employee = await employees.create(fx.tenantId, fx.userId, {
        code: employeeCode,
        displayName: 'Self',
        homeBranchId: branchId,
        userId: fx.userId,
      });
      const pin = '1111';
      await pins.setPin(fx.tenantId, fx.userId, employee.id, pin);

      await decide(
        fx,
        po.id,
        'approve',
        submitted.version,
        { userId: fx.userId, terminalId: terminal.id, employeeCode, pin },
        403,
      );
    });

    it('a retried approval with the SAME decision id is a safe idempotent replay (no duplicate decision row, no double mutation)', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const po = await submittablePo(fx, branchId, locationId, '50000');
      const submitted = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/submit`)
          .send({ expectedVersion: po.version })
          .expect(200),
      );
      const approver = await createApprover(
        fx,
        branchId,
        nextSeed(),
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
      );
      const decisionId = newId();
      const send = () =>
        authed(fx).post(`/procurement/purchase-orders/${po.id}/approve`).send({
          expectedVersion: submitted.version,
          approvalDecisionId: decisionId,
          terminalId: approver.terminalId,
          employeeCode: approver.employeeCode,
          pin: approver.pin,
        });

      const first = await send().expect(200);
      const firstBody = bodyOf<PoBody>(first);
      expect(firstBody.status).toBe('approved');

      const second = await send();
      expect(second.status).toBe(200);
      const secondBody = bodyOf<PoBody>(second);
      expect(secondBody.status).toBe('approved');
      expect(secondBody.approvedAt).toBe(firstBody.approvedAt);

      const decisionCount = await admin.approvalDecision.count({
        where: { id: decisionId },
      });
      expect(decisionCount).toBe(1);
      const approvedAuditCount = await admin.auditEntry.count({
        where: {
          tenantId: fx.tenantId,
          entityId: po.id,
          action: 'PURCHASE_ORDER_APPROVED',
        },
      });
      expect(approvedAuditCount).toBe(1);
    });

    it('a concurrent double-submit race lets only one submission win; the loser gets a version conflict, never two auto-approvals', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const po = await submittablePo(fx, branchId, locationId, '500');

      const [r1, r2] = await Promise.all([
        authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/submit`)
          .send({ expectedVersion: po.version }),
        authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/submit`)
          .send({ expectedVersion: po.version }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const auditApprovedCount = await admin.auditEntry.count({
        where: {
          tenantId: fx.tenantId,
          entityId: po.id,
          action: 'PURCHASE_ORDER_APPROVED',
        },
      });
      expect(auditApprovedCount).toBe(1);

      const final = await authed(fx)
        .get(`/procurement/purchase-orders/${po.id}`)
        .expect(200);
      expect(bodyOf<PoBody>(final).status).toBe('approved');
      expect(bodyOf<PoBody>(final).version).toBe(2);
    });
  });

  // ── Amendment — FR-PRC-023 ───────────────────────────────────────────────

  describe('Amendment', () => {
    async function approvedPo(
      fx: Fixture,
      branchId: string,
      locationId: string,
      unitPrice: string,
      stockItemId: string,
      baseUnitId: string,
      supplierId: string,
    ) {
      const res = await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId,
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
          lines: [
            {
              stockItemId,
              purchaseUnitId: baseUnitId,
              quantity: '1',
              attributionBranchId: branchId,
              unitPrice,
            },
          ],
        })
        .expect(201);
      const po = bodyOf<PoBody>(res);
      const submitted = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/submit`)
          .send({ expectedVersion: po.version })
          .expect(200),
      );
      if (submitted.status === 'approved') return submitted;

      const approver = await createApprover(
        fx,
        branchId,
        nextSeed(),
        submitted.approvalRequiredPermission!,
      );
      return bodyOf<PoBody>(
        await decide(fx, po.id, 'approve', submitted.version, approver, 200),
      );
    }

    it('amends an approved PO (quantity change), records immutable amendment history in order', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '100');
      const po = await approvedPo(
        fx,
        branchId,
        locationId,
        '500',
        s1.stockItemId,
        s1.baseUnitId,
        s1.supplierId,
      );
      expect(po.status).toBe('approved');

      const amend1 = await authed(fx)
        .post(`/procurement/purchase-orders/${po.id}/amend`)
        .send({
          expectedVersion: po.version,
          reason: 'quantity correction',
          lines: [
            {
              stockItemId: s1.stockItemId,
              purchaseUnitId: s1.baseUnitId,
              quantity: '2',
              attributionBranchId: branchId,
              unitPrice: '500',
            },
          ],
        })
        .expect(200);
      const amended = bodyOf<PoBody>(amend1);
      expect(amended.grandTotal).toBe('1000');

      const listRes = await authed(fx)
        .get(`/procurement/purchase-orders/${po.id}/amendments`)
        .expect(200);
      const list = bodyOf<AmendmentBody[]>(listRes);
      expect(list).toHaveLength(1);
      expect(list[0].amendmentNumber).toBe(1);
      expect(list[0].oldTotal).toBe('500');
      expect(list[0].newTotal).toBe('1000');
    });

    it('an amendment staying within the already-approved band leaves status approved, with no new ApprovalRequest', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '100');
      // Tier_3-band PO (above 1,000,000) has the widest "same-or-lower" room.
      const po = await approvedPo(
        fx,
        branchId,
        locationId,
        '2000000',
        s1.stockItemId,
        s1.baseUnitId,
        s1.supplierId,
      );
      expect(po.status).toBe('approved');
      expect(po.approvedBand).toBe('tier_3');
      const priorRequestCount = await admin.approvalRequest.count({
        where: { tenantId: fx.tenantId },
      });

      const amended = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/amend`)
          .send({
            expectedVersion: po.version,
            reason: 'minor tweak, still tier_3',
            lines: [
              {
                stockItemId: s1.stockItemId,
                purchaseUnitId: s1.baseUnitId,
                quantity: '1',
                attributionBranchId: branchId,
                unitPrice: '2100000',
              },
            ],
          })
          .expect(200),
      );
      expect(amended.status).toBe('approved');
      expect(amended.approvedBand).toBe('tier_3');
      expect(amended.approvedAt).toBe(po.approvedAt);
      expect(amended.approvedBy).toBe(po.approvedBy);

      const afterRequestCount = await admin.approvalRequest.count({
        where: { tenantId: fx.tenantId },
      });
      expect(afterRequestCount).toBe(priorRequestCount);
    });

    it('an amendment crossing into a HIGHER band requires a genuinely NEW approval', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '100');
      const po = await approvedPo(
        fx,
        branchId,
        locationId,
        '50000', // tier_1
        s1.stockItemId,
        s1.baseUnitId,
        s1.supplierId,
      );
      expect(po.approvedBand).toBe('tier_1');

      const amended = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/amend`)
          .send({
            expectedVersion: po.version,
            reason: 'scope increase into tier_2',
            lines: [
              {
                stockItemId: s1.stockItemId,
                purchaseUnitId: s1.baseUnitId,
                quantity: '1',
                attributionBranchId: branchId,
                unitPrice: '500000',
              },
            ],
          })
          .expect(200),
      );
      expect(amended.status).toBe('pending_approval');
      expect(amended.approvalBand).toBe('tier_2');
      expect(amended.approvedBand).toBeNull();
      expect(amended.approvalRequestId).not.toBe(po.approvalRequestId);

      // The OLD tier_1 approver cannot silently re-approve the new request.
      const tier1Approver = await createApprover(
        fx,
        branchId,
        nextSeed(),
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
      );
      await decide(fx, po.id, 'approve', amended.version, tier1Approver, 403);

      // A genuine tier_2 approver is required.
      const tier2Approver = await createApprover(
        fx,
        branchId,
        nextSeed(),
        PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_2,
      );
      const reapproved = bodyOf<PoBody>(
        await decide(fx, po.id, 'approve', amended.version, tier2Approver, 200),
      );
      expect(reapproved.status).toBe('approved');
      expect(reapproved.approvedBand).toBe('tier_2');
    });

    it('an amendment that decreases total does not force reapproval', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '100');
      const po = await approvedPo(
        fx,
        branchId,
        locationId,
        '50000', // tier_1
        s1.stockItemId,
        s1.baseUnitId,
        s1.supplierId,
      );
      expect(po.approvedBand).toBe('tier_1');

      const amended = bodyOf<PoBody>(
        await authed(fx)
          .post(`/procurement/purchase-orders/${po.id}/amend`)
          .send({
            expectedVersion: po.version,
            reason: 'reduce quantity',
            lines: [
              {
                stockItemId: s1.stockItemId,
                purchaseUnitId: s1.baseUnitId,
                quantity: '1',
                attributionBranchId: branchId,
                unitPrice: '100', // now `auto` band, well below threshold1
              },
            ],
          })
          .expect(200),
      );
      expect(amended.status).toBe('approved');
      expect(amended.approvalBand).toBe('auto');
      expect(amended.approvedBand).toBe('tier_1');
      expect(amended.approvedBy).toBe(po.approvedBy);
    });

    it('rejects a stale expectedVersion (409), and rejects amending once receiving has started', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await setThresholds(fx.tenantId, fx.userId, '10000', '100000', '1000000');
      const s1 = await setupSupplierWithPrice(fx, nextSeed(), '100');
      const po = await approvedPo(
        fx,
        branchId,
        locationId,
        '500',
        s1.stockItemId,
        s1.baseUnitId,
        s1.supplierId,
      );

      await authed(fx)
        .post(`/procurement/purchase-orders/${po.id}/amend`)
        .send({
          expectedVersion: po.version + 99,
          reason: 'stale',
          lines: [
            {
              stockItemId: s1.stockItemId,
              purchaseUnitId: s1.baseUnitId,
              quantity: '1',
              attributionBranchId: branchId,
              unitPrice: '600',
            },
          ],
        })
        .expect(409);

      await admin.purchaseOrder.update({
        where: { id: po.id },
        data: { receivingStartedAt: new Date() },
      });
      await authed(fx)
        .post(`/procurement/purchase-orders/${po.id}/amend`)
        .send({
          expectedVersion: po.version,
          reason: 'too late',
          lines: [
            {
              stockItemId: s1.stockItemId,
              purchaseUnitId: s1.baseUnitId,
              quantity: '1',
              attributionBranchId: branchId,
              unitPrice: '600',
            },
          ],
        })
        .expect(422);
    });
  });

  // ── Security / permissions ───────────────────────────────────────────────

  describe('Security', () => {
    it('rejects creating a requisition/PO without the required permission (403)', async () => {
      const fx = await createFixture(nextSeed(), []);
      const { branchId, locationId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      await authed(fx)
        .post('/procurement/requisitions')
        .send({ requestingBranchId: branchId })
        .expect(403);
      await authed(fx)
        .post('/procurement/purchase-orders')
        .send({
          supplierId: newId(),
          deliveryLocationType: 'branch',
          deliveryLocationId: locationId,
          expectedDeliveryDate: '2026-06-01',
          currency: 'EGP',
        })
        .expect(403);
    });

    it('rejects a POS-session token on every new route (back-office/console only)', async () => {
      const fx = await createFixture(nextSeed());
      const { branchId } = await createBranchWithLocation(
        fx.tenantId,
        nextSeed(),
      );
      const users = app.get(UsersService);
      const memberships = app.get(MembershipsService);
      const employees = app.get(EmployeesService);
      const pins = app.get(PinService);
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
      const seed = nextSeed();
      const empUser = await users.createUser({
        email: `pos.emp.${seed}@example.com`,
        password: DEV_PASSWORD,
        displayName: 'Employee',
      });
      await memberships.grant(empUser.id, fx.tenantId, 'active');
      const employeeCode = `PE${seed.slice(-6)}`;
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

      await request(http)
        .get('/procurement/requisitions')
        .set('Authorization', `Bearer ${posToken}`)
        .expect(403);
      await request(http)
        .get('/procurement/purchase-orders')
        .set('Authorization', `Bearer ${posToken}`)
        .expect(403);
    });
  });
});
