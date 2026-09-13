import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
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
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import {
  SALES_PERMISSION_DEFS,
  SALES_PERMISSIONS,
} from './../src/modules/sales/sales.permissions';
import {
  KDS_PERMISSION_DEFS,
  KDS_PERMISSIONS,
} from './../src/modules/kitchen/kitchen.permissions';
import { createMigratorClient } from './rls-admin';
import { DEV_PASSWORD } from './reporting-fixtures';

/**
 * FULL-SRS-POS-ORDER-CANCELLATION-P3 — Order cancellation (FR-POS-070/075,
 * BR-POS-003) end to end through the real HTTP route, real PostgreSQL, real
 * authorization, real approval runtime, real Fire/Kitchen bump pipeline.
 * Setup mirrors `pos-financial-corrections.e2e-spec.ts` (signed test country
 * pack, tenant/branch/terminal/employee/PIN bootstrap), extended with a real
 * KDS terminal bound to the same Fire-destination station so a line can be
 * genuinely BUMPED (not merely fired) through the real `POST
 * /kds/tickets/:ticketId/lines/:lineId/bump` route — the only way BR-POS-003's
 * "fired AND bumped" distinction can be proven honestly.
 */

const stamp = Date.now();
const AT = new Date('2026-09-05T09:00:00.000Z');
const PACK_VERSION = '2026.1';
const PIN_CASHIER = '1111';
const PIN_NOCANCEL = '2222';
const PIN_MANAGER = '3333';
const PIN_WRONGAPPROVER = '4444';
const PIN_COOK = '5555';

const RELEASE_KEY = generateReleaseKey('e2e-poc-release-key');
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

describe('FULL-SRS-POS-ORDER-CANCELLATION-P3 (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let terminalA: string;
  let kdsTerminalId: string;
  let stationId: string;

  let employeeCashierCode: string;
  let employeeNoCancelCode: string;
  let employeeManagerCode: string;
  let userManager: string;
  let employeeWrongApproverCode: string;
  let employeeCookCode: string;
  let userCashier: string;

  let taxClassStandard: string;
  let priceListA: string;
  let cashSessionA: string;

  let reasonCancel: string;
  let reasonWaste: string;
  let reasonOtherTenant: string;

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
        slug: `poc-${stamp}`,
        legalName: 'PosOrderCancelA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `pocb-${stamp}`,
        legalName: 'PosOrderCancelB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `POC Brand ${stamp}` },
    });
    branchA = (
      await admin.branch.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          brandId: brand.id,
          code: `POC${stamp % 10000}`,
          name: `POC Branch ${stamp}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      })
    ).id;
    await admin.location.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        locationType: 'branch',
        refId: branchA,
        branchId: branchA,
      },
    });

    const mkTerminal = (
      tenantId: string,
      branchId: string,
      name: string,
      terminalType: 'pos' | 'kds' = 'pos',
    ) =>
      admin.terminal
        .create({
          data: {
            id: newId(),
            tenantId,
            branchId,
            name,
            terminalType,
            status: 'active',
          },
        })
        .then((t) => t.id);
    terminalA = await mkTerminal(tenantA, branchA, 'POC-POS-1');
    kdsTerminalId = await mkTerminal(tenantA, branchA, 'POC-KDS-1', 'kds');

    // ── real Kitchen routing + a REAL KDS terminal bound to the SAME
    // station — a line fired to this station can be genuinely BUMPED
    // through the real `POST /kds/.../bump` route (BR-POS-003's "fired AND
    // bumped" distinction cannot be proven any other way). ────────────────
    stationId = (
      await admin.station.create({
        data: {
          id: newId(),
          branchId: branchA,
          name: `POC-Station-${stamp}`,
          displayTerminalId: kdsTerminalId,
        },
      })
    ).id;
    await admin.branchKdsConfig.create({
      data: {
        branchId: branchA,
        tenantId: tenantA,
        fallbackStationId: stationId,
      },
    });

    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of KDS_PERMISSION_DEFS) await permissions.upsert(def);

    const cashierRole = await roles.createTenantRole(tenantA, {
      name: `poc_cashier_${stamp}`,
    });
    await roles.addPermissions(tenantA, cashierRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.ORDER_FIRE,
      SALES_PERMISSIONS.ORDER_CANCEL,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
    ]);
    const noCancelRole = await roles.createTenantRole(tenantA, {
      name: `poc_nocancel_${stamp}`,
    });
    await roles.addPermissions(tenantA, noCancelRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.ORDER_FIRE,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
    ]);
    const managerRole = await roles.createTenantRole(tenantA, {
      name: `poc_manager_${stamp}`,
    });
    await roles.addPermissions(tenantA, managerRole.id, [
      SALES_PERMISSIONS.ORDER_CANCEL_AFTER_PRODUCTION,
    ]);
    const wrongApproverRole = await roles.createTenantRole(tenantA, {
      name: `poc_wrongapprover_${stamp}`,
    });
    // Holds SOME manager-tier permission, but NOT the one BR-POS-003 names.
    await roles.addPermissions(tenantA, wrongApproverRole.id, [
      SALES_PERMISSIONS.DISCOUNT_APPROVE,
    ]);
    const kdsRole = await roles.createTenantRole(tenantA, {
      name: `poc_kds_${stamp}`,
    });
    await roles.addPermissions(tenantA, kdsRole.id, [KDS_PERMISSIONS.OPERATE]);

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({
        email,
        password: DEV_PASSWORD,
        displayName: 'P',
      });
      const m = await memberships.grant(u.id, tenantId, 'active');
      return { userId: u.id, membershipId: m.id };
    };

    const cashier = await mkUser(`poc.cashier.${stamp}@example.com`, tenantA);
    userCashier = cashier.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: cashier.membershipId,
      roleId: cashierRole.id,
      scope: { type: 'tenant' },
    });
    const noCancel = await mkUser(`poc.nocancel.${stamp}@example.com`, tenantA);
    await membershipRoles.create(tenantA, null, {
      membershipId: noCancel.membershipId,
      roleId: noCancelRole.id,
      scope: { type: 'tenant' },
    });
    const manager = await mkUser(`poc.manager.${stamp}@example.com`, tenantA);
    userManager = manager.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: manager.membershipId,
      roleId: managerRole.id,
      scope: { type: 'tenant' },
    });
    const wrongApprover = await mkUser(
      `poc.wrongapprover.${stamp}@example.com`,
      tenantA,
    );
    await membershipRoles.create(tenantA, null, {
      membershipId: wrongApprover.membershipId,
      roleId: wrongApproverRole.id,
      scope: { type: 'tenant' },
    });
    const cook = await mkUser(`poc.cook.${stamp}@example.com`, tenantA);
    await membershipRoles.create(tenantA, null, {
      membershipId: cook.membershipId,
      roleId: kdsRole.id,
      scope: { type: 'tenant' },
    });

    employeeCashierCode = `POC${stamp % 1000}`;
    await employees.create(tenantA, userCashier, {
      code: employeeCashierCode,
      displayName: 'POC Cashier',
      homeBranchId: branchA,
      userId: userCashier,
    });
    employeeNoCancelCode = `PON${stamp % 1000}`;
    const employeeNoCancel = await employees.create(tenantA, userCashier, {
      code: employeeNoCancelCode,
      displayName: 'POC NoCancel',
      homeBranchId: branchA,
      userId: noCancel.userId,
    });
    employeeManagerCode = `POM${stamp % 1000}`;
    const employeeManager = await employees.create(tenantA, userCashier, {
      code: employeeManagerCode,
      displayName: 'POC Manager',
      homeBranchId: branchA,
      userId: userManager,
    });
    employeeWrongApproverCode = `POW${stamp % 1000}`;
    const employeeWrongApprover = await employees.create(tenantA, userCashier, {
      code: employeeWrongApproverCode,
      displayName: 'POC WrongApprover',
      homeBranchId: branchA,
      userId: wrongApprover.userId,
    });
    employeeCookCode = `POK${stamp % 1000}`;
    const employeeCook = await employees.create(tenantA, userCashier, {
      code: employeeCookCode,
      displayName: 'POC Cook',
      homeBranchId: branchA,
      userId: cook.userId,
    });

    const employeeCashierRow = await admin.employee.findFirstOrThrow({
      where: { tenantId: tenantA, code: employeeCashierCode },
    });

    await pins.setPin(tenantA, userCashier, employeeCashierRow.id, PIN_CASHIER);
    await pins.setPin(
      tenantA,
      noCancel.userId,
      employeeNoCancel.id,
      PIN_NOCANCEL,
    );
    await pins.setPin(tenantA, userManager, employeeManager.id, PIN_MANAGER);
    await pins.setPin(
      tenantA,
      wrongApprover.userId,
      employeeWrongApprover.id,
      PIN_WRONGAPPROVER,
    );
    await pins.setPin(tenantA, cook.userId, employeeCook.id, PIN_COOK);

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
          name: `POC pricing ${stamp}`,
          scopeType: 'branch',
          scopeId: branchA,
          status: 'active',
        },
      })
    ).id;

    const drawerA = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'POC-Drawer',
        terminalId: terminalA,
      },
    });
    const shiftA = await admin.shift.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        employeeId: employeeCashierRow.id,
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
          drawerId: drawerA.id,
          shiftId: shiftA.id,
          employeeId: employeeCashierRow.id,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;

    reasonCancel = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'adjustment',
          code: `POC_CANCEL_${stamp}`,
          label: { en: 'Cancellation' },
        },
      })
    ).id;
    reasonWaste = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'waste',
          code: `POC_WASTE_${stamp}`,
          label: { en: 'Spoiled / discarded' },
        },
      })
    ).id;
    reasonOtherTenant = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          category: 'adjustment',
          code: `POC_OTHER_${stamp}`,
          label: { en: 'Other tenant reason' },
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  const pinLogin = async (
    tid: string,
    branchId: string,
    employeeCode: string,
    pin: string,
    sessionType: 'pos' | 'kds' = 'pos',
  ) =>
    request(http)
      .post('/auth/pin')
      .send({ tenantId: tid, branchId, employeeCode, pin, sessionType });

  const pinLoginOk = async (
    tid: string,
    branchId: string,
    employeeCode: string,
    pin: string,
    sessionType: 'pos' | 'kds' = 'pos',
  ) => {
    const res = await pinLogin(tid, branchId, employeeCode, pin, sessionType);
    expect(res.status).toBe(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const currentVersion = async (orderId: string): Promise<number> =>
    (
      await admin.order.findFirstOrThrow({
        where: { id: orderId },
        select: { version: true },
      })
    ).version;

  const mkOpenOrder = async () => {
    const order = await orders.create(tenantA, userCashier, {
      branchId: branchA,
      openedByEmployeeId: (
        await admin.employee.findFirstOrThrow({
          where: { tenantId: tenantA, code: employeeCashierCode },
        })
      ).id,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    return orders.transition(
      tenantA,
      userCashier,
      order.id,
      order.businessDay,
      'open',
      order.version,
    );
  };

  const mkLine = async (
    order: { id: string; businessDay: Date },
    itemId: string,
    variantId: string,
  ) => {
    const expectedVersion = await currentVersion(order.id);
    return lines.addLine(tenantA, userCashier, order.id, order.businessDay, {
      menuItemId: itemId,
      variantId,
      quantity: '1',
      expectedVersion,
    });
  };

  const etagOf = (id: string, version: number) => `W/"${id}.${version}"`;

  const path = (order: { id: string; businessDay: Date }, suffix: string) =>
    `/orders/${order.businessDay.toISOString().slice(0, 10)}/${order.id}${suffix}`;

  const postNow = (
    token: string,
    order: { id: string; businessDay: Date },
    suffix: string,
    ifMatchVersion: number,
    body: Record<string, unknown>,
    idempotencyKey = `poc-${newId()}`,
  ) =>
    request(http)
      .post(path(order, suffix))
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', etagOf(order.id, ifMatchVersion))
      .send(body);

  const postFresh = async (
    token: string,
    order: { id: string; businessDay: Date },
    suffix: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) => {
    const v = await currentVersion(order.id);
    return postNow(token, order, suffix, v, body, idempotencyKey);
  };

  let cashierToken: string;
  let noCancelToken: string;
  let kdsToken: string;

  beforeAll(async () => {
    cashierToken = await pinLoginOk(
      tenantA,
      branchA,
      employeeCashierCode,
      PIN_CASHIER,
    );
    noCancelToken = await pinLoginOk(
      tenantA,
      branchA,
      employeeNoCancelCode,
      PIN_NOCANCEL,
    );
    kdsToken = await pinLoginOk(
      tenantA,
      branchA,
      employeeCookCode,
      PIN_COOK,
      'kds',
    );
  });

  /** Fire every pending line on `order` through the REAL Fire route. */
  const fireOrder = async (order: {
    id: string;
    businessDay: Date;
  }): Promise<void> => {
    const res = await postFresh(cashierToken, order, '/fire', {});
    expect(res.status).toBe(200);
  };

  /**
   * Bump a fired line through the REAL `POST /kds/.../bump` route — the
   * only honest way to reach BR-POS-003's "fired AND bumped" line state
   * (`TicketBumpedHandler` is what actually writes `sales.order_lines.state
   * = 'ready'`, exactly as it would from a real cook's terminal).
   */
  const bumpLine = async (orderLineId: string) => {
    const ticketLine = await admin.ticketLine.findFirstOrThrow({
      where: { orderLineId },
    });
    const res = await request(http)
      .post(
        `/kds/tickets/${ticketLine.ticketId}/lines/${ticketLine.id}/bump?stationId=${stationId}`,
      )
      .set('Authorization', `Bearer ${kdsToken}`)
      .send({});
    expect(res.status).toBe(200);
    const line = await admin.orderLine.findFirstOrThrow({
      where: { id: orderLineId },
    });
    expect(line.state).toBe('ready');
  };

  const auditFor = (orderId: string) =>
    admin.auditEntry.findMany({
      where: {
        tenantId: tenantA,
        entityType: 'order',
        entityId: orderId,
        action: 'ORDER_CANCELLED',
      },
    });

  // ============================================================ tests
  describe('eligible states', () => {
    it('1. cancels a draft/no-line order', async () => {
      const order = await mkOpenOrder();
      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(res.status).toBe(200);
      const body = res.body as { order: { state: string; grandTotal: string } };
      expect(body.order.state).toBe('cancelled');
      expect(body.order.grandTotal).toBe('0');

      const audits = await auditFor(order.id);
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe(userCashier);
      expect(audits[0].reasonCode).toBe(reasonCancel);
      expect(audits[0].approverId).toBeNull();
      expect((audits[0].beforeState as Record<string, unknown>).state).toBe(
        'open',
      );
      const after = (audits[0].afterState as { after?: { state?: string } })
        .after;
      expect(after?.state).toBe('cancelled');
    });

    it('2. cancels an order with unfired (pending) lines — voided, no inventory effect, order cancelled', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P2-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);

      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(res.status).toBe(200);
      const body = res.body as {
        order: { state: string; grandTotal: string };
      };
      expect(body.order.state).toBe('cancelled');
      expect(body.order.grandTotal).toBe('0');

      const voidedLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(voidedLine.state).toBe('voided');
      expect(voidedLine.voidReasonId).toBe(reasonCancel);

      // no PostFireVoidRecord for a pre-fire line — it never reached production.
      const records = await admin.postFireVoidRecord.findMany({
        where: { orderLineId: line.line.id },
      });
      expect(records).toHaveLength(0);
    });

    it('3. a cancelled order cannot accept a payment afterward', async () => {
      const order = await mkOpenOrder();
      const cancelRes = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(cancelRes.status).toBe(200);

      const payRes = await postFresh(cashierToken, order, '/payments', {
        tender: 'cash',
        amountMinor: '100',
        tenderedAmountMinor: '100',
        cashSessionId: cashSessionA,
      });
      expect(payRes.status).toBe(422);
    });

    it('4. reason is required — missing reasonCodeId is a 400', async () => {
      const order = await mkOpenOrder();
      const res = await postFresh(cashierToken, order, '/cancel', {});
      expect(res.status).toBe(400);
    });

    it('5. a nonexistent / foreign-tenant reason is rejected', async () => {
      const order1 = await mkOpenOrder();
      const res1 = await postFresh(cashierToken, order1, '/cancel', {
        reasonCodeId: newId(),
      });
      expect(res1.status).toBe(422);

      const order2 = await mkOpenOrder();
      const res2 = await postFresh(cashierToken, order2, '/cancel', {
        reasonCodeId: reasonOtherTenant,
      });
      expect(res2.status).toBe(422);
    });

    it('6. a waste-only reason cannot be used to cancel an order', async () => {
      const order = await mkOpenOrder();
      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonWaste,
      });
      expect(res.status).toBe(422);
    });
  });

  describe('payment guard (BR-POS-001/FR-POS-070)', () => {
    it('7. a partially/fully paid order cannot be cancelled — use Refund instead', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P7-${newId()}`, 10_000n);
      await mkLine(order, item.itemId, item.variantId);
      await fireOrder(order);

      const partialPay = await postFresh(cashierToken, order, '/payments', {
        tender: 'cash',
        amountMinor: '1000',
        tenderedAmountMinor: '1000',
        cashSessionId: cashSessionA,
      });
      expect(partialPay.status).toBe(201);

      const cancelRes = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(cancelRes.status).toBe(422);
    });

    it('8. a completed order cannot be cancelled', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P8-${newId()}`, 10_000n);
      await mkLine(order, item.itemId, item.variantId);
      await fireOrder(order);

      const fresh = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const settleRes = await postFresh(cashierToken, order, '/payments', {
        tender: 'cash',
        amountMinor: fresh.grandTotal.toString(),
        tenderedAmountMinor: fresh.grandTotal.toString(),
        cashSessionId: cashSessionA,
      });
      expect(settleRes.status).toBe(201);
      expect((settleRes.body as { order: { state: string } }).order.state).toBe(
        'completed',
      );

      const cancelRes = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(cancelRes.status).toBe(422);
    });
  });

  describe('idempotency (§12)', () => {
    it('9. a retry against an already-cancelled order is a safe no-op — no duplicate audit', async () => {
      const order = await mkOpenOrder();
      const first = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(first.status).toBe(200);

      // A genuine second attempt (a fresh Idempotency-Key, a possibly-stale
      // If-Match — the exact "client never saw the first response" case).
      const retry = await postNow(cashierToken, order, '/cancel', 1, {
        reasonCodeId: reasonCancel,
      });
      expect(retry.status).toBe(200);
      expect((retry.body as { order: { state: string } }).order.state).toBe(
        'cancelled',
      );

      const audits = await auditFor(order.id);
      expect(audits).toHaveLength(1);
    });
  });

  describe('production-state line semantics (§3/§4, BR-POS-003)', () => {
    it('10. fired-but-not-bumped line cancels with ONLY the ordinary permission, given a disposition', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P10-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireOrder(order);

      const cancelled = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(cancelled.state).toBe('fired'); // not yet bumped

      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
        lineDispositions: [
          { orderLineId: line.line.id, disposition: 'wasted' },
        ],
      });
      expect(res.status).toBe(200);
      expect((res.body as { order: { state: string } }).order.state).toBe(
        'cancelled',
      );

      const voided = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(voided.state).toBe('voided');

      const records = await admin.postFireVoidRecord.findMany({
        where: { orderLineId: line.line.id },
      });
      expect(records).toHaveLength(1);
      expect(records[0].disposition).toBe('wasted');
    });

    it('11. a produced/fired line missing its disposition is rejected', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P11-${newId()}`, 10_000n);
      await mkLine(order, item.itemId, item.variantId);
      await fireOrder(order);

      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(res.status).toBe(422);
    });

    it('12. a bumped/produced line + ONLY the ordinary cancel permission is rejected (BR-POS-003)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P12-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireOrder(order);
      await bumpLine(line.line.id);

      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
        lineDispositions: [
          { orderLineId: line.line.id, disposition: 'wasted' },
        ],
      });
      expect(res.status).toBe(403);
    });

    it('13. a bumped/produced line + valid elevated approval succeeds', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P13-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireOrder(order);
      await bumpLine(line.line.id);

      const approvalRequestId = newId();
      const approvalDecisionId = newId();
      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
        lineDispositions: [
          { orderLineId: line.line.id, disposition: 'given_to_staff' },
        ],
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId,
        approvalDecisionId,
      });
      expect(res.status).toBe(200);
      expect((res.body as { order: { state: string } }).order.state).toBe(
        'cancelled',
      );

      const records = await admin.postFireVoidRecord.findMany({
        where: { orderLineId: line.line.id },
      });
      expect(records).toHaveLength(1);
      expect(records[0].disposition).toBe('given_to_staff');

      const audits = await auditFor(order.id);
      expect(audits).toHaveLength(1);
      expect(audits[0].approverId).toBe(userManager);
      expect(audits[0].approvalId).toBe(approvalRequestId);

      const decision = await admin.approvalDecision.findUniqueOrThrow({
        where: { id: approvalDecisionId },
      });
      expect(decision.decision).toBe('approved');
    });

    it('14. an approver without pos.order.cancel_after_production is rejected', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`P14-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireOrder(order);
      await bumpLine(line.line.id);

      const res = await postFresh(cashierToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
        lineDispositions: [
          { orderLineId: line.line.id, disposition: 'wasted' },
        ],
        managerEmployeeCode: employeeWrongApproverCode,
        managerPin: PIN_WRONGAPPROVER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      });
      expect(res.status).toBe(403);

      const stillFired = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(stillFired.state).toBe('ready'); // untouched
    });
  });

  describe('authorization', () => {
    it('15. an actor without pos.order.cancel gets 403', async () => {
      const order = await mkOpenOrder();
      const res = await postFresh(noCancelToken, order, '/cancel', {
        reasonCodeId: reasonCancel,
      });
      expect(res.status).toBe(403);
    });
  });
});
