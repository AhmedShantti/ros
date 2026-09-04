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
import { INVENTORY_PERMISSION_DEFS } from './../src/modules/inventory/inventory.permissions';
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
import { MovementsService } from './../src/modules/inventory/movements/movements.service';
import {
  SALES_PERMISSION_DEFS,
  SALES_PERMISSIONS,
} from './../src/modules/sales/sales.permissions';
import {
  TREASURY_PERMISSION_DEFS,
  TREASURY_PERMISSIONS,
} from './../src/modules/treasury/treasury.permissions';
import {
  REPORTING_PERMISSIONS,
  REPORTING_PERMISSION_DEFS,
} from './../src/modules/reporting/reporting.permissions';
import { createMigratorClient } from './rls-admin';
import { DEV_PASSWORD, dashboardToken } from './reporting-fixtures';

/**
 * POS-FIN-1 — discounts/comps, post-fire void, refunds: end to end through
 * the real HTTP routes, real PostgreSQL, real authorization, real approval
 * runtime. Setup mirrors `sales-payment.e2e-spec.ts`/`order-completion.
 * e2e-spec.ts` exactly (signed test country pack, tenant/branch/terminal/
 * employee/PIN bootstrap, raw-Prisma catalogue fixtures).
 */

const stamp = Date.now();
const AT = new Date('2026-09-01T09:00:00.000Z');
const PACK_VERSION = '2026.1';
const PIN_CASHIER = '1111';
const PIN_MANAGER = '2222';
const PIN_NOAPPROVE = '3333';
const PIN_UNLIMITED = '5555';
const PIN_WRONGBRANCH_MANAGER = '6666';

const RELEASE_KEY = generateReleaseKey('e2e-posfin-release-key');
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

describe('POS-FIN-1 (e2e)', () => {
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
  let branchOther: string; // a second branch under tenantA — the "wrong branch" for manager approval
  let terminalA: string;
  let terminalB: string;
  let employeeCashier: string; // pos.discount.apply, pos.comp.apply, pos.order.void_line_postfire, pos.refund.issue
  let employeeCashierCode: string;
  let userCashier: string;
  let employeeManager: string; // pos.discount.approve, home branch A
  let employeeManagerCode: string;
  let userManager: string;
  let employeeUnlimited: string; // pos.discount.unlimited
  let employeeUnlimitedCode: string;
  let userUnlimited: string;
  let employeeNoApprove: string; // no pos.discount.approve — for "unauthorized manager" test
  let employeeNoApproveCode: string;
  let userNoApprove: string;
  let employeeWrongBranchManager: string; // pos.discount.approve, but home branch is branchOther
  let employeeWrongBranchManagerCode: string;
  let userWrongBranchManager: string;
  let employeeB: string;
  let employeeBCode: string;
  let userB: string;

  let taxClassStandard: string;
  let priceListA: string;

  let cashSessionA: string;
  let reasonDiscount: string;
  let reasonDiscountOtherTenant: string;

  let dashboardEmail: string;

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
    movements = app.get(MovementsService);
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
        slug: `pfa-${stamp}`,
        legalName: 'PosFinA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `pfb-${stamp}`,
        legalName: 'PosFinB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mkBranch = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `PFBrand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `PFBranch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      await admin.location.create({
        data: {
          id: newId(),
          tenantId,
          locationType: 'branch',
          refId: branch.id,
          branchId: branch.id,
        },
      });
      return branch.id;
    };
    branchA = await mkBranch(tenantA, `PFA${stamp % 10000}`);
    branchOther = await mkBranch(tenantA, `PFO${stamp % 10000}`);
    const branchB = await mkBranch(tenantB, `PFB${stamp % 10000}`);

    const mkTerminal = (tenantId: string, branchId: string, name: string) =>
      admin.terminal
        .create({
          data: {
            id: newId(),
            tenantId,
            branchId,
            name,
            terminalType: 'pos',
            status: 'active',
          },
        })
        .then((t) => t.id);
    terminalA = await mkTerminal(tenantA, branchA, 'PF-POS-1');
    terminalB = await mkTerminal(tenantB, branchB, 'PF-POS-B');

    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of INVENTORY_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of REPORTING_PERMISSION_DEFS) await permissions.upsert(def);

    const cashierRole = await roles.createTenantRole(tenantA, {
      name: `pf_cashier_${stamp}`,
    });
    await roles.addPermissions(tenantA, cashierRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.ORDER_FIRE,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
      SALES_PERMISSIONS.DISCOUNT_APPLY,
      SALES_PERMISSIONS.COMP_APPLY,
      SALES_PERMISSIONS.ORDER_VOID_LINE_POSTFIRE,
      SALES_PERMISSIONS.REFUND_ISSUE,
      SALES_PERMISSIONS.REFUND_DIFFERENT_TENDER,
      TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    ]);
    const managerRole = await roles.createTenantRole(tenantA, {
      name: `pf_manager_${stamp}`,
    });
    await roles.addPermissions(tenantA, managerRole.id, [
      SALES_PERMISSIONS.DISCOUNT_APPROVE,
    ]);
    const unlimitedRole = await roles.createTenantRole(tenantA, {
      name: `pf_unlimited_${stamp}`,
    });
    await roles.addPermissions(tenantA, unlimitedRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.DISCOUNT_APPLY,
      SALES_PERMISSIONS.DISCOUNT_UNLIMITED,
    ]);
    const noApproveRole = await roles.createTenantRole(tenantA, {
      name: `pf_noapprove_${stamp}`,
    });
    await roles.addPermissions(tenantA, noApproveRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
    ]);
    const reportingRole = await roles.createTenantRole(tenantA, {
      name: `pf_reporting_${stamp}`,
    });
    await roles.addPermissions(tenantA, reportingRole.id, [
      REPORTING_PERMISSIONS.VIEW_SALES,
      REPORTING_PERMISSIONS.VIEW_FINANCIAL,
    ]);
    const cashierBRole = await roles.createTenantRole(tenantB, {
      name: `pf_cashier_b_${stamp}`,
    });
    await roles.addPermissions(tenantB, cashierBRole.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.DISCOUNT_APPLY,
      SALES_PERMISSIONS.REFUND_ISSUE,
    ]);

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({
        email,
        password: DEV_PASSWORD,
        displayName: 'P',
      });
      const m = await memberships.grant(u.id, tenantId, 'active');
      return { userId: u.id, membershipId: m.id };
    };

    const cashier = await mkUser(`pf.cashier.${stamp}@example.com`, tenantA);
    userCashier = cashier.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: cashier.membershipId,
      roleId: cashierRole.id,
      scope: { type: 'tenant' },
    });

    const manager = await mkUser(`pf.manager.${stamp}@example.com`, tenantA);
    userManager = manager.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: manager.membershipId,
      roleId: managerRole.id,
      scope: { type: 'tenant' },
    });

    const unlimited = await mkUser(
      `pf.unlimited.${stamp}@example.com`,
      tenantA,
    );
    userUnlimited = unlimited.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: unlimited.membershipId,
      roleId: unlimitedRole.id,
      scope: { type: 'tenant' },
    });

    const noApprove = await mkUser(
      `pf.noapprove.${stamp}@example.com`,
      tenantA,
    );
    userNoApprove = noApprove.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: noApprove.membershipId,
      roleId: noApproveRole.id,
      scope: { type: 'tenant' },
    });

    const wrongBranchManager = await mkUser(
      `pf.wbmanager.${stamp}@example.com`,
      tenantA,
    );
    userWrongBranchManager = wrongBranchManager.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: wrongBranchManager.membershipId,
      roleId: managerRole.id,
      scope: { type: 'tenant' },
    });

    dashboardEmail = `pf.dashboard.${stamp}@example.com`;
    const dashboardUser = await mkUser(dashboardEmail, tenantA);
    await membershipRoles.create(tenantA, null, {
      membershipId: dashboardUser.membershipId,
      roleId: reportingRole.id,
      scope: { type: 'tenant' },
    });

    const b = await mkUser(`pf.b.${stamp}@example.com`, tenantB);
    userB = b.userId;
    await membershipRoles.create(tenantB, null, {
      membershipId: b.membershipId,
      roleId: cashierBRole.id,
      scope: { type: 'tenant' },
    });

    employeeCashierCode = `PFC${stamp % 1000}`;
    employeeCashier = (
      await employees.create(tenantA, userCashier, {
        code: employeeCashierCode,
        displayName: 'PF Cashier',
        homeBranchId: branchA,
        userId: userCashier,
      })
    ).id;
    employeeManagerCode = `PFM${stamp % 1000}`;
    employeeManager = (
      await employees.create(tenantA, userCashier, {
        code: employeeManagerCode,
        displayName: 'PF Manager',
        homeBranchId: branchA,
        userId: userManager,
      })
    ).id;
    employeeUnlimitedCode = `PFU${stamp % 1000}`;
    employeeUnlimited = (
      await employees.create(tenantA, userCashier, {
        code: employeeUnlimitedCode,
        displayName: 'PF Unlimited',
        homeBranchId: branchA,
        userId: userUnlimited,
      })
    ).id;
    employeeNoApproveCode = `PFN${stamp % 1000}`;
    employeeNoApprove = (
      await employees.create(tenantA, userCashier, {
        code: employeeNoApproveCode,
        displayName: 'PF NoApprove',
        homeBranchId: branchA,
        userId: userNoApprove,
      })
    ).id;
    employeeWrongBranchManagerCode = `PFW${stamp % 1000}`;
    employeeWrongBranchManager = (
      await employees.create(tenantA, userCashier, {
        code: employeeWrongBranchManagerCode,
        displayName: 'PF WrongBranch Manager',
        homeBranchId: branchOther, // NOT branchA, and not permitted there either
        userId: userWrongBranchManager,
      })
    ).id;
    employeeBCode = `PFB${stamp % 1000}`;
    employeeB = (
      await employees.create(tenantB, userB, {
        code: employeeBCode,
        displayName: 'PF B',
        homeBranchId: branchB,
        userId: userB,
      })
    ).id;

    await pins.setPin(tenantA, userCashier, employeeCashier, PIN_CASHIER);
    await pins.setPin(tenantA, userManager, employeeManager, PIN_MANAGER);
    await pins.setPin(tenantA, userNoApprove, employeeNoApprove, PIN_NOAPPROVE);
    await pins.setPin(tenantA, userUnlimited, employeeUnlimited, PIN_UNLIMITED);
    await pins.setPin(
      tenantA,
      userWrongBranchManager,
      employeeWrongBranchManager,
      PIN_WRONGBRANCH_MANAGER,
    );
    await pins.setPin(tenantB, userB, employeeB, '9999');

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
          name: `PF pricing ${stamp}`,
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
        name: 'PF-Drawer',
        terminalId: terminalA,
      },
    });
    const shiftA = await admin.shift.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        employeeId: employeeCashier,
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
          employeeId: employeeCashier,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;

    reasonDiscount = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'adjustment',
          code: `MGR_DISC_${stamp}`,
          label: { en: 'Manager discount' },
        },
      })
    ).id;
    reasonDiscountOtherTenant = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          category: 'adjustment',
          code: `OTHER_${stamp}`,
          label: { en: 'Other tenant reason' },
        },
      })
    ).id;

    // Discount/refund approval policy for branchA: 10% / 500 minor units
    // without approval, above that requires manager approval.
    await admin.discountApprovalPolicyVersion.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        maxPercentWithoutApprovalBp: 1000n, // 10.00%
        maxAmountWithoutApprovalMinor: 500n,
        maxDiscountsPerShiftPerEmployee: null,
        discountAfterPaymentStartedAllowed: false,
        createdBy: userManager,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  const pinLogin = async (
    tid: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ) => {
    const res = await request(http)
      .post('/auth/pin')
      .send({ tenantId: tid, terminalId, employeeCode, pin });
    return res;
  };

  const pinLoginOk = async (
    tid: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ) => {
    const res = await pinLogin(tid, terminalId, employeeCode, pin);
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

  const mkOpenOrder = async (
    opts: {
      tenantId?: string;
      terminalId?: string;
      employeeId?: string;
      userId?: string;
    } = {},
  ) => {
    const tenantId = opts.tenantId ?? tenantA;
    const userId = opts.userId ?? userCashier;
    const order = await orders.create(tenantId, userId, {
      terminalId: opts.terminalId ?? terminalA,
      openedByEmployeeId: opts.employeeId ?? employeeCashier,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    return orders.transition(
      tenantId,
      userId,
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
    tenantId = tenantA,
  ) => {
    const expectedVersion = await currentVersion(order.id);
    return lines.addLine(tenantId, userCashier, order.id, order.businessDay, {
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
    idempotencyKey = `pf-${newId()}`,
  ) =>
    request(http)
      .post(path(order, suffix))
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', etagOf(order.id, ifMatchVersion))
      .send(body);

  /** Convenience: reads the CURRENT version fresh, then posts. */
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

  const settleFull = async (
    order: { id: string; businessDay: Date },
    token: string,
    tenderMinor?: bigint,
  ) => {
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    const amount = tenderMinor ?? fresh.grandTotal;
    const res = await postFresh(token, order, '/payments', {
      tender: 'cash',
      amountMinor: amount.toString(),
      tenderedAmountMinor: amount.toString(),
      cashSessionId: cashSessionA,
    });
    expect(res.status).toBe(201);
    return res.body as {
      order: { grandTotal: string; paidTotal: string; version: number };
    };
  };

  // ============================================================ A. DISCOUNTS
  describe('A. Discounts', () => {
    let cashierToken: string;
    beforeAll(async () => {
      cashierToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeCashierCode,
        PIN_CASHIER,
      );
    });

    it('A1. line percentage discount computes exact HALF_UP amount and stays below threshold (no approval)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A1-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      // lineSubtotal = 10000 (100.00 EGP). 5% -> 500 exactly.
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '5.00',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        line: { lineDiscount: string; lineSubtotal: string };
        discount: {
          amountMinor: string;
          approvalRequired: boolean;
          kind: string;
          valueType: string;
        };
      };
      expect(body.discount.amountMinor).toBe('500');
      expect(body.discount.approvalRequired).toBe(false);
      expect(body.discount.kind).toBe('discount');
      expect(body.discount.valueType).toBe('percentage');
      expect(body.line.lineDiscount).toBe('500');
    });

    it('A2. line fixed discount reduces exactly that amount', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A2-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'fixed',
          value: '300',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        discount: { amountMinor: string; valueType: string };
      };
      expect(body.discount.amountMinor).toBe('300');
      expect(body.discount.valueType).toBe('fixed');
    });

    it('A3. order-level percentage discount reduces grandTotal by exactly the computed amount, tax untouched', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A3-${newId()}`, 10_000n);
      await mkLine(order, item.itemId, item.variantId);
      const before = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const res = await postFresh(cashierToken, order, '/discount', {
        type: 'percentage',
        value: '5.00',
        reasonCodeId: reasonDiscount,
      });
      expect(res.status).toBe(200);
      const body = res.body as {
        order: { grandTotal: string; discountTotal: string; taxTotal: string };
        discount: { amountMinor: string };
      };
      const expectedAmount = (before.grandTotal * 500n) / 10000n;
      expect(body.discount.amountMinor).toBe(expectedAmount.toString());
      expect(BigInt(body.order.grandTotal)).toBe(
        before.grandTotal - expectedAmount,
      );
      expect(body.order.taxTotal).toBe(before.taxTotal.toString());
      expect(body.order.discountTotal).toBe(expectedAmount.toString());
    });

    it('A4. order-level fixed discount reduces grandTotal by exactly that amount', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A4-${newId()}`, 10_000n);
      await mkLine(order, item.itemId, item.variantId);
      const before = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const res = await postFresh(cashierToken, order, '/discount', {
        type: 'fixed',
        value: '400',
        reasonCodeId: reasonDiscount,
      });
      expect(res.status).toBe(200);
      const body = res.body as { order: { grandTotal: string } };
      expect(BigInt(body.order.grandTotal)).toBe(before.grandTotal - 400n);
    });

    it('A5. reason code is mandatory (rejected without one)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A5-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '5.00',
        },
      );
      expect(res.status).toBe(400);
    });

    it('A6. unknown/cross-tenant reason code is rejected (422)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A6-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const unknown = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '5.00',
          reasonCodeId: newId(),
        },
      );
      expect(unknown.status).toBe(422);

      const order2 = await mkOpenOrder();
      const item2 = await mkSellable(`A6b-${newId()}`);
      const line2 = await mkLine(order2, item2.itemId, item2.variantId);
      const crossTenant = await postFresh(
        cashierToken,
        order2,
        `/lines/${line2.line.id}/discount`,
        {
          type: 'percentage',
          value: '5.00',
          reasonCodeId: reasonDiscountOtherTenant,
        },
      );
      expect(crossTenant.status).toBe(422);
    });

    it('A7. a fixed discount exceeding the line eligible base is rejected (422)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A7-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'fixed',
          value: '999999',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(422);
      expect((res.body as { message: string }).message).toMatch(
        /eligible base/,
      );
    });

    it('A8. cannot stack a second discount on an already-discounted line', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A8-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      await postFresh(cashierToken, order, `/lines/${line.line.id}/discount`, {
        type: 'fixed',
        value: '100',
        reasonCodeId: reasonDiscount,
      }).then((r) => expect(r.status).toBe(200));
      const second = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'fixed',
          value: '100',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(second.status).toBe(409);
    });

    it('A9. FR-POS-050 comp: revenue zero, isComp true, cost/inventory path untouched (state unchanged)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A9-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/comp`,
        {
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        line: { isComp: boolean; lineTotal: string; state: string };
        order: { grandTotal: string };
        discount: { kind: string; amountMinor: string };
      };
      expect(body.line.isComp).toBe(true);
      expect(body.line.lineTotal).toBe('0');
      expect(body.line.state).toBe('pending'); // unchanged — not voided/comped-state
      expect(body.order.grandTotal).toBe('0');
      expect(body.discount.kind).toBe('comp');
      expect(body.discount.amountMinor).toBe('10000');
    });

    it('A10. idempotent replay (same Idempotency-Key + same body id) creates exactly one Discount row', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A10-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const discountId = newId();
      const idemKey = `pf-idem-${newId()}`;
      const body = {
        id: discountId,
        type: 'percentage',
        value: '5.00',
        reasonCodeId: reasonDiscount,
      };
      const first = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        body,
        idemKey,
      );
      expect(first.status).toBe(200);
      const second = await postNow(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        await currentVersion(order.id), // replay must still succeed even though version "moved" per the first call — the interceptor short-circuits before the handler
        body,
        idemKey,
      );
      expect(second.status).toBe(200);
      const count = await admin.discount.count({ where: { id: discountId } });
      expect(count).toBe(1);
    });

    it('A11. two concurrent discount attempts on the same line at the same version: exactly one succeeds, the other 409s', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A11-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const v = await currentVersion(order.id);
      const [r1, r2] = await Promise.all([
        postNow(
          cashierToken,
          order,
          `/lines/${line.line.id}/discount`,
          v,
          {
            type: 'fixed',
            value: '100',
            reasonCodeId: reasonDiscount,
          },
          `pf-race-1-${newId()}`,
        ),
        postNow(
          cashierToken,
          order,
          `/lines/${line.line.id}/discount`,
          v,
          {
            type: 'fixed',
            value: '100',
            reasonCodeId: reasonDiscount,
          },
          `pf-race-2-${newId()}`,
        ),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);
      const discountCount = await admin.discount.count({
        where: { orderId: order.id },
      });
      expect(discountCount).toBe(1);
    });

    it('A12. audit entry DISCOUNT_APPLIED carries actor/reason/amount', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`A12-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'fixed',
          value: '250',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(200);
      const discountId = (res.body as { discount: { id: string } }).discount.id;
      const audit = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          action: 'DISCOUNT_APPLIED',
          entityId: discountId,
        },
      });
      expect(audit).not.toBeNull();
      expect(audit!.actorId).toBe(userCashier);
      expect(audit!.reasonCode).toBe(reasonDiscount);
      expect((audit!.afterState as { amountMinor?: string }).amountMinor).toBe(
        '250',
      );
    });

    it('A13. cannot apply a discount that has not been through /discount for a nonexistent line -> 404', async () => {
      const order = await mkOpenOrder();
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${newId()}/discount`,
        {
          type: 'fixed',
          value: '100',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // ============================================================ B. APPROVAL
  describe('B. Approval', () => {
    let cashierToken: string;
    beforeAll(async () => {
      cashierToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeCashierCode,
        PIN_CASHIER,
      );
    });

    it('B1. above-threshold discount without manager fields is 403', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`B1-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      // 20% of 10000 = 2000, well above the 500-minor / 10% thresholds.
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '20.00',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(403);
    });

    it('B2. above-threshold discount WITH a valid manager approval succeeds and records the approver', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`B2-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      const approvalRequestId = newId();
      const approvalDecisionId = newId();
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '20.00',
          reasonCodeId: reasonDiscount,
          managerEmployeeCode: employeeManagerCode,
          managerPin: PIN_MANAGER,
          approvalRequestId,
          approvalDecisionId,
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        discount: {
          approvalRequired: boolean;
          approvedByUserId: string | null;
          approvalRequestId: string | null;
        };
      };
      expect(body.discount.approvalRequired).toBe(true);
      expect(body.discount.approvedByUserId).toBe(userManager);
      expect(body.discount.approvalRequestId).toBe(approvalRequestId);

      const decision = await admin.approvalDecision.findUniqueOrThrow({
        where: { id: approvalDecisionId },
      });
      expect(decision.approverId).toBe(userManager);
      expect(decision.decision).toBe('approved');

      const audit = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          action: 'DISCOUNT_APPLIED',
          approvalId: approvalRequestId,
        },
      });
      expect(audit).not.toBeNull();
      expect(audit!.approverId).toBe(userManager);
    });

    it('B3. self-approval is blocked: the applying cashier cannot approve their own discount', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`B3-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      // Cashier applies AND attempts to approve with their own PIN — but the
      // approving employee code must differ; here we deliberately pass the
      // cashier's own code as "manager".
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '20.00',
          reasonCodeId: reasonDiscount,
          managerEmployeeCode: employeeCashierCode,
          managerPin: PIN_CASHIER,
          approvalRequestId: newId(),
          approvalDecisionId: newId(),
        },
      );
      expect(res.status).toBe(403);
      const line2 = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(line2.lineDiscount).toBe(0n); // nothing applied
    });

    it('B4. unauthorized "manager" (no pos.discount.approve) is rejected', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`B4-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '20.00',
          reasonCodeId: reasonDiscount,
          managerEmployeeCode: employeeNoApproveCode,
          managerPin: PIN_NOAPPROVE,
          approvalRequestId: newId(),
          approvalDecisionId: newId(),
        },
      );
      expect(res.status).toBe(403);
    });

    it('B5. a manager not permitted at this branch cannot even authenticate on this terminal (PIN login itself fails)', async () => {
      const res = await pinLogin(
        tenantA,
        terminalA,
        employeeWrongBranchManagerCode,
        PIN_WRONGBRANCH_MANAGER,
      );
      expect(res.status).not.toBe(200);
    });

    it('B6. holder of pos.discount.unlimited bypasses approval entirely, even far above threshold', async () => {
      const unlimitedToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeUnlimitedCode,
        PIN_UNLIMITED,
      );
      const order = await mkOpenOrder({
        employeeId: employeeUnlimited,
        userId: userUnlimited,
      });
      const item = await mkSellable(`B6-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        unlimitedToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '90.00',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(200);
      expect(
        (res.body as { discount: { approvalRequired: boolean } }).discount
          .approvalRequired,
      ).toBe(false);
    });

    it('B7. below-threshold discount requires no manager fields at all (already proven by A1, re-asserted for clarity)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`B7-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'percentage',
          value: '5.00',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(200);
    });
  });

  // ============================================================= C. REFUNDS
  describe('C. Refunds', () => {
    let cashierToken: string;
    let managerToken: string;
    beforeAll(async () => {
      cashierToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeCashierCode,
        PIN_CASHIER,
      );
      managerToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeManagerCode,
        PIN_MANAGER,
      );
      void managerToken;
    });

    const mkCompletedOrder = async (price = 10_000n) => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`C-${newId()}`, price);
      await mkLine(order, item.itemId, item.variantId);
      const settled = await settleFull(order, cashierToken);
      const paymentRow = await admin.orderPayment.findFirstOrThrow({
        where: { orderId: order.id },
      });
      return { order, settled, paymentId: paymentRow.id };
    };

    it('C1. a valid partial refund succeeds and creates a negative-effect record', async () => {
      const { order, paymentId } = await mkCompletedOrder(10_000n);
      // 4000 exceeds the branch policy's 500-minor no-approval threshold
      // (see beforeAll) — a genuine, realistic refund of this size requires
      // manager approval, exactly like C5 below proves explicitly.
      const res = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '4000',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      });
      expect(res.status).toBe(201);
      const body = res.body as {
        refund: { amountMinor: string };
        order: { state: string };
      };
      expect(body.refund.amountMinor).toBe('4000');
      expect(body.order.state).toBe('partially_refunded');
    });

    it('C2. a second refund up to the exact remaining cap succeeds, then reaches "refunded"', async () => {
      const { order, paymentId, settled } = await mkCompletedOrder(10_000n);
      // `paidTotal` includes the 14% tax fixture applies — derive the split
      // from the REAL settled total, never assume it equals the nominal
      // pre-tax `price` argument.
      const paidTotal = BigInt(settled.order.paidTotal);
      const firstAmount = paidTotal - 4000n;
      await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: firstAmount.toString(),
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      }).then((r) => expect(r.status).toBe(201));
      const second = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '4000', // exact remainder of the real paidTotal
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      });
      expect(second.status).toBe(201);
      expect((second.body as { order: { state: string } }).order.state).toBe(
        'refunded',
      );
    });

    it('C3. a refund exceeding the aggregate cap is rejected (422)', async () => {
      const { order, paymentId, settled } = await mkCompletedOrder(10_000n);
      const over = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: (BigInt(settled.order.paidTotal) + 1n).toString(),
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      });
      expect(over.status).toBe(422);
    });

    it('C4. missing reason code is rejected', async () => {
      const { order, paymentId } = await mkCompletedOrder(10_000n);
      const res = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '1000',
        cashSessionId: cashSessionA,
      });
      expect(res.status).toBe(400);
    });

    it('C5. above-threshold refund requires manager approval; without it is 403, with it succeeds', async () => {
      const { order, paymentId } = await mkCompletedOrder(10_000n);
      const noApproval = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '2000', // above the 500-minor threshold
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
      });
      expect(noApproval.status).toBe(403);

      const withApproval = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '2000',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      });
      expect(withApproval.status).toBe(201);
      expect(
        (withApproval.body as { refund: { approvalRequired: boolean } }).refund
          .approvalRequired,
      ).toBe(true);
    });

    it('C6. the original Order posted totals and the original Payment row are byte-identical before/after the refund', async () => {
      const { order, paymentId } = await mkCompletedOrder(10_000n);
      const orderBefore = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const paymentBefore = await admin.orderPayment.findFirstOrThrow({
        where: { id: paymentId },
      });

      await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '1000',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      }).then((r) => expect(r.status).toBe(201));

      const orderAfter = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const paymentAfter = await admin.orderPayment.findFirstOrThrow({
        where: { id: paymentId },
      });

      expect(orderAfter.grandTotal).toBe(orderBefore.grandTotal);
      expect(orderAfter.paidTotal).toBe(orderBefore.paidTotal);
      expect(orderAfter.subtotal).toBe(orderBefore.subtotal);
      expect(orderAfter.taxTotal).toBe(orderBefore.taxTotal);
      expect(orderAfter.discountTotal).toBe(orderBefore.discountTotal);
      expect(paymentAfter).toEqual(paymentBefore); // genuinely untouched
      // Only `state`/`version`/`updatedAt` on Order are allowed to differ.
      expect(orderAfter.state).not.toBe(orderBefore.state);
      expect(orderAfter.version).toBeGreaterThan(orderBefore.version);
    });

    it('C7. the Refund row is a genuine new append-only row (never an UPDATE)', async () => {
      const { order, paymentId } = await mkCompletedOrder(10_000n);
      const countBefore = await admin.refund.count({
        where: { orderId: order.id },
      });
      expect(countBefore).toBe(0);
      const res = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '1000',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      });
      expect(res.status).toBe(201);
      const countAfter = await admin.refund.count({
        where: { orderId: order.id },
      });
      expect(countAfter).toBe(1);
    });

    it('C8. audit entry REFUND_ISSUED has actor/reason/amount and before/after state', async () => {
      const { order, paymentId } = await mkCompletedOrder(10_000n);
      const res = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '1000',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      });
      expect(res.status).toBe(201);
      const refundId = (res.body as { refund: { id: string } }).refund.id;
      const audit = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          action: 'REFUND_ISSUED',
          entityId: refundId,
        },
      });
      expect(audit).not.toBeNull();
      expect(audit!.actorId).toBe(userCashier);
      expect(audit!.reasonCode).toBe(reasonDiscount);
      expect((audit!.afterState as { amountMinor?: string }).amountMinor).toBe(
        '1000',
      );
      expect((audit!.beforeState as { state?: string }).state).toBe(
        'completed',
      );
    });

    it('C9. idempotent retry (same Idempotency-Key + same body id) produces exactly one Refund row', async () => {
      const { order, paymentId } = await mkCompletedOrder(10_000n);
      const refundId = newId();
      const idemKey = `pf-refund-idem-${newId()}`;
      const body = {
        id: refundId,
        originalPaymentId: paymentId,
        tender: 'cash',
        amountMinor: '1000',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      };
      const first = await postFresh(
        cashierToken,
        order,
        '/refunds',
        body,
        idemKey,
      );
      expect(first.status).toBe(201);
      const second = await postNow(
        cashierToken,
        order,
        '/refunds',
        await currentVersion(order.id),
        body,
        idemKey,
      );
      expect(second.status).toBe(201);
      const count = await admin.refund.count({ where: { id: refundId } });
      expect(count).toBe(1);
    });

    it('C10. refunding to a different tender without pos.refund.different_tender is 403; with it, succeeds', async () => {
      const noDiffRole = await app.get(RolesService).createTenantRole(tenantA, {
        name: `pf_nodiff_${stamp}_${newId().slice(0, 8)}`,
      });
      await app
        .get(RolesService)
        .addPermissions(tenantA, noDiffRole.id, [
          SALES_PERMISSIONS.ORDER_CREATE,
          SALES_PERMISSIONS.REFUND_ISSUE,
        ]);
      const u = await app.get(UsersService).createUser({
        email: `pf.nodiff.${newId()}@example.com`,
        password: DEV_PASSWORD,
        displayName: 'NoDiff',
      });
      const m = await app
        .get(MembershipsService)
        .grant(u.id, tenantA, 'active');
      await app.get(MembershipRolesService).create(tenantA, null, {
        membershipId: m.id,
        roleId: noDiffRole.id,
        scope: { type: 'tenant' },
      });
      const code = `PFD${newId().slice(0, 5)}`;
      const emp = await app.get(EmployeesService).create(tenantA, userCashier, {
        code,
        displayName: 'NoDiff Emp',
        homeBranchId: branchA,
        userId: u.id,
      });
      await app.get(PinService).setPin(tenantA, u.id, emp.id, '7777');
      const noDiffToken = await pinLoginOk(tenantA, terminalA, code, '7777');

      const { order, paymentId } = await mkCompletedOrder(10_000n);
      const rejected = await postFresh(noDiffToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'manual_external_card', // original was cash
        amountMinor: '400',
        reasonCodeId: reasonDiscount,
      });
      expect(rejected.status).toBe(403);

      const allowed = await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentId,
        tender: 'manual_external_card',
        amountMinor: '400',
        reasonCodeId: reasonDiscount,
      });
      expect(allowed.status).toBe(201);
    });
  });

  // =================================================== D. REFUND CONCURRENCY
  describe('D. Refund concurrency', () => {
    let cashierToken: string;
    beforeAll(async () => {
      cashierToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeCashierCode,
        PIN_CASHIER,
      );
    });

    it('D1. two concurrent refunds that TOGETHER exceed the cap: at most one succeeds, aggregate never exceeds paidTotal', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`D1-${newId()}`, 10_000n);
      await mkLine(order, item.itemId, item.variantId);
      await settleFull(order, cashierToken);
      const paymentRow = await admin.orderPayment.findFirstOrThrow({
        where: { orderId: order.id },
      });
      const v = await currentVersion(order.id);

      const [r1, r2] = await Promise.all([
        postNow(
          cashierToken,
          order,
          '/refunds',
          v,
          {
            originalPaymentId: paymentRow.id,
            tender: 'cash',
            amountMinor: '6000',
            reasonCodeId: reasonDiscount,
            cashSessionId: cashSessionA,
            managerEmployeeCode: employeeManagerCode,
            managerPin: PIN_MANAGER,
            approvalRequestId: newId(),
            approvalDecisionId: newId(),
          },
          `pf-refund-race-1-${newId()}`,
        ),
        postNow(
          cashierToken,
          order,
          '/refunds',
          v,
          {
            originalPaymentId: paymentRow.id,
            tender: 'cash',
            amountMinor: '6000',
            reasonCodeId: reasonDiscount,
            cashSessionId: cashSessionA,
            managerEmployeeCode: employeeManagerCode,
            managerPin: PIN_MANAGER,
            approvalRequestId: newId(),
            approvalDecisionId: newId(),
          },
          `pf-refund-race-2-${newId()}`,
        ),
      ]);

      const succeeded = [r1, r2].filter((r) => r.status === 201).length;
      const failed = [r1, r2].filter((r) => r.status !== 201).length;
      expect(succeeded).toBe(1);
      expect(failed).toBe(1);

      const sum = await admin.refund.aggregate({
        where: { orderId: order.id },
        _sum: { amountMinor: true },
      });
      const orderRow = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(sum._sum.amountMinor ?? 0n).toBeLessThanOrEqual(
        orderRow.paidTotal,
      );
      expect(sum._sum.amountMinor).toBe(6000n);
    });
  });

  // ===================================================== E. POST-FIRE VOID
  describe('E. Post-fire void', () => {
    let cashierToken: string;
    beforeAll(async () => {
      cashierToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeCashierCode,
        PIN_CASHIER,
      );
    });

    const fireDirectly = async (lineId: string, businessDay: Date) => {
      // Reaching a genuinely fired line through the real Kitchen routing
      // pipeline requires station/routing fixtures orthogonal to POS-FIN-1
      // (already covered by sales-fire.e2e-spec.ts / kds-*.e2e-spec.ts).
      // This raw state transition exercises exactly what
      // `PostFireVoidService.voidPostFire` actually reads
      // (`OrderLine.state`) — the same "state, not provenance" contract
      // `assertMayVoidPostFire` checks.
      await admin.orderLine.update({
        where: { id_businessDay: { id: lineId, businessDay } },
        data: { state: 'fired', firedAt: AT },
      });
    };

    it('E1. a PRE-fire line is rejected by the post-fire route (422) — use the pre-fire DELETE route instead', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`E1-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
          disposition: 'wasted',
        },
      );
      expect(res.status).toBe(422);
      expect((res.body as { message: string }).message).toMatch(
        /not been sent to production/,
      );
    });

    it('E2. disposition is a required field: missing -> 400, invalid value -> 400', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`E2-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireDirectly(line.line.id, order.businessDay);

      const missing = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
        },
      );
      expect(missing.status).toBe(400);

      const invalid = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
          disposition: 'thrown_away', // not a valid enum value
        },
      );
      expect(invalid.status).toBe(400);
    });

    it('E3. returned_to_stock creates NO inventory movement, and removes the line from order totals', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`E3-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireDirectly(line.line.id, order.businessDay);
      const before = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });

      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
          disposition: 'returned_to_stock',
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        order: { grandTotal: string; subtotal: string; taxTotal: string };
        postFireVoidRecord: {
          inventoryMovementIds: unknown[];
          disposition: string;
        };
      };
      expect(body.postFireVoidRecord.disposition).toBe('returned_to_stock');
      expect(body.postFireVoidRecord.inventoryMovementIds).toEqual([]);
      expect(BigInt(body.order.grandTotal)).toBe(
        before.grandTotal - before.grandTotal,
      ); // line was the only content -> 0
      expect(body.order.grandTotal).toBe('0');

      const movements = await admin.stockMovement.count({
        where: { referenceType: 'post_fire_void', referenceId: line.line.id },
      });
      expect(movements).toBe(0);
    });

    it('E4. wasted disposition on an item with NO recipe: legitimately empty inventoryMovementIds (no consumption to record)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`E4-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireDirectly(line.line.id, order.businessDay);

      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
          disposition: 'wasted',
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        postFireVoidRecord: { inventoryMovementIds: unknown[] };
      };
      expect(body.postFireVoidRecord.inventoryMovementIds).toEqual([]);
    });

    it('E5. wasted disposition on an item WITH a real recipe creates a real waste movement, linked by reference', async () => {
      const unitEach = await admin.uom.findFirst({ where: { code: 'EA' } });
      const unitId =
        unitEach?.id ??
        (
          await admin.uom.create({
            data: {
              id: newId(),
              dimension: 'count',
              code: `PFE${stamp % 100000}`,
              name: 'PF Each',
              baseUnitOfDimension: true,
            },
          })
        ).id;
      const stockItem = await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `PFSTK${stamp}${Math.floor(Math.random() * 100000)}`,
          names: { en: 'PF Patty' },
          baseUnitId: unitId,
          costingMethod: 'weighted_average',
          batchStrategy: 'fifo',
          isBatchTracked: true,
        },
      });
      const locationA = (
        await admin.location.findFirstOrThrow({
          where: { branchId: branchA, locationType: 'branch' },
        })
      ).id;
      const batch = await admin.stockBatch.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          stockItemId: stockItem.id,
          locationId: locationA,
          quantityReceived: '100',
          quantityRemaining: '100',
          unitCost: 500n,
          createdAt: AT,
        },
      });
      // Real inbound movement (not a raw insert) so `stock_levels` is
      // correctly projected — the same two-step pattern
      // `order-completion.e2e-spec.ts`'s `mkBatch` helper uses.
      await movements.postStandalone(tenantA, userCashier, {
        stockItemId: stockItem.id,
        locationId: locationA,
        movementType: 'purchase_receipt',
        quantity: '100',
        unitCost: 500n,
        batchId: batch.id,
        referenceType: 'goods_receipt',
        referenceId: newId(),
        occurredAt: AT,
      });

      const item = await mkSellable(`E5-${newId()}`, 10_000n);
      const recipe = await admin.recipe.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          scope: 'tenant',
          recipeType: 'menu_item',
          menuItemVariantId: item.variantId,
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
          yieldUnitId: unitId,
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
          stockItemId: stockItem.id,
          quantity: '2',
          unitId,
          wastagePercentage: '0.00',
        },
      });

      const order = await mkOpenOrder();
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireDirectly(line.line.id, order.businessDay);

      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
          disposition: 'wasted',
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        postFireVoidRecord: { inventoryMovementIds: string[] };
      };
      expect(
        body.postFireVoidRecord.inventoryMovementIds.length,
      ).toBeGreaterThan(0);

      const movement = await admin.stockMovement.findFirstOrThrow({
        where: { referenceType: 'post_fire_void', referenceId: line.line.id },
      });
      expect(movement.movementType).toBe('waste');
      expect(movement.stockItemId).toBe(stockItem.id);
      expect(Number(movement.quantity)).toBeLessThan(0); // outbound
      expect(Math.abs(Number(movement.quantity))).toBeCloseTo(2, 6);
    });

    it('E6. given_to_staff disposition also produces a waste-type movement, distinguishable via the PostFireVoidRecord', async () => {
      const item = await mkSellable(`E6-${newId()}`, 10_000n);
      const order = await mkOpenOrder();
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireDirectly(line.line.id, order.businessDay);

      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
          disposition: 'given_to_staff',
        },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        postFireVoidRecord: {
          disposition: string;
          inventoryMovementIds: string[];
        };
      };
      expect(body.postFireVoidRecord.disposition).toBe('given_to_staff');
      // No recipe on this item -> legitimately empty, mirrors E4's reasoning.
      expect(body.postFireVoidRecord.inventoryMovementIds).toEqual([]);
    });

    it('E7. financialAmountRemoved + audit ORDER_LINE_VOIDED_POSTFIRE recorded with before/after', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`E7-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await fireDirectly(line.line.id, order.businessDay);
      const lineBefore = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });

      const res = await postFresh(
        cashierToken,
        order,
        `/lines/${line.line.id}/void-postfire`,
        {
          reasonCodeId: reasonDiscount,
          disposition: 'wasted',
        },
      );
      const recordId = (res.body as { postFireVoidRecord: { id: string } })
        .postFireVoidRecord.id;
      const record = await admin.postFireVoidRecord.findUniqueOrThrow({
        where: { id: recordId },
      });
      expect(record.financialAmountRemoved).toBe(lineBefore.lineTotal);

      const audit = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          action: 'ORDER_LINE_VOIDED_POSTFIRE',
          entityId: line.line.id,
        },
      });
      expect(audit).not.toBeNull();
      expect((audit!.beforeState as { state?: string }).state).toBe('fired');
    });

    // NOTE: verifying that the matching `kitchen.ticket_lines` row also
    // transitions to `status='cancelled'` requires a fired line that
    // actually went through Kitchen's routing pipeline (station/routing
    // config fixtures) — genuinely fired via the real Fire route, not the
    // raw `fireDirectly` shortcut used above (which never creates a
    // Ticket/TicketLine row at all). That is Kitchen-side wiring already
    // exercised by `sales-fire.e2e-spec.ts`/`kds-amendment.e2e-spec.ts`;
    // out of scope here to avoid duplicating a full routing fixture set for
    // a single additional assertion.
  });

  // ================================================ F. CROSS-DOMAIN REPORTING
  describe('F. Cross-domain reporting', () => {
    let cashierToken: string;
    beforeAll(async () => {
      cashierToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeCashierCode,
        PIN_CASHIER,
      );
    });

    it('F1. discounts and refunds issued today are reflected truthfully in the daily-trading report, netSales holds exactly', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`F1-${newId()}`, 10_000n);
      const line = await mkLine(order, item.itemId, item.variantId);
      await postFresh(cashierToken, order, `/lines/${line.line.id}/discount`, {
        type: 'fixed',
        value: '400',
        reasonCodeId: reasonDiscount,
      }).then((r) => expect(r.status).toBe(200));
      const settled = await settleFull(order, cashierToken);
      const paymentRow = await admin.orderPayment.findFirstOrThrow({
        where: { orderId: order.id },
      });
      await postFresh(cashierToken, order, '/refunds', {
        originalPaymentId: paymentRow.id,
        tender: 'cash',
        amountMinor: '1000',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
        managerEmployeeCode: employeeManagerCode,
        managerPin: PIN_MANAGER,
        approvalRequestId: newId(),
        approvalDecisionId: newId(),
      }).then((r) => expect(r.status).toBe(201));

      const finalOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const businessDayStr = order.businessDay.toISOString().slice(0, 10);
      const token = await dashboardToken(http, dashboardEmail, tenantA);
      const res = await request(http)
        .get(`/reports/branches/${branchA}/daily-trading/${businessDayStr}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const body = res.body as {
        salesSummary: {
          grossSales: string;
          discounts: string;
          refunds: string;
          taxTotal: string;
          netSales: string;
        };
      };
      // discounts/refunds are TENANT+BRANCH+DAY aggregates, not just this
      // one order — assert they are at least this order's contribution.
      expect(BigInt(body.salesSummary.discounts)).toBeGreaterThanOrEqual(400n);
      expect(BigInt(body.salesSummary.refunds)).toBeGreaterThanOrEqual(1000n);
      const gross = BigInt(body.salesSummary.grossSales);
      const disc = BigInt(body.salesSummary.discounts);
      const ref = BigInt(body.salesSummary.refunds);
      const tax = BigInt(body.salesSummary.taxTotal);
      expect(BigInt(body.salesSummary.netSales)).toBe(gross - disc - ref - tax);
      void finalOrder;
      void settled;
    });
  });

  // ================================================ G. CROSS-TENANT ISOLATION
  describe('G. Cross-tenant isolation', () => {
    let cashierToken: string;
    let tokenB: string;
    beforeAll(async () => {
      cashierToken = await pinLoginOk(
        tenantA,
        terminalA,
        employeeCashierCode,
        PIN_CASHIER,
      );
      tokenB = await pinLoginOk(tenantB, terminalB, employeeBCode, '9999');
    });

    it('G1. tenant B cannot discount tenant A order (404, never 403)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`G1-${newId()}`);
      const line = await mkLine(order, item.itemId, item.variantId);
      const res = await postFresh(
        tokenB,
        order,
        `/lines/${line.line.id}/discount`,
        {
          type: 'fixed',
          value: '100',
          reasonCodeId: reasonDiscount,
        },
      );
      expect(res.status).toBe(404);
    });

    it('G2. tenant B cannot refund tenant A order (404, never 403)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(`G2-${newId()}`, 10_000n);
      await mkLine(order, item.itemId, item.variantId);
      await settleFull(order, cashierToken);
      const paymentRow = await admin.orderPayment.findFirstOrThrow({
        where: { orderId: order.id },
      });
      const res = await postFresh(tokenB, order, '/refunds', {
        originalPaymentId: paymentRow.id,
        tender: 'cash',
        amountMinor: '100',
        reasonCodeId: reasonDiscount,
        cashSessionId: cashSessionA,
      });
      expect(res.status).toBe(404);
    });
  });
});
