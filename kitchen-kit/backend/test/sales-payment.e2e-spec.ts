import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
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
import { TAX_CLASS_PROVISIONER } from './../src/modules/localisation/tax/tax-class.port';
import type { TaxClassProvisioner } from './../src/modules/localisation/tax/tax-class.port';
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
 * P1F-1 — Payment MVP: partial CASH + manual/external card capture, end to
 * end through the real HTTP route, real PostgreSQL, real authorization.
 *
 * Setup mirrors `sales-fire.e2e-spec.ts` exactly (signed test country pack,
 * tenant/branch/terminal/employee/PIN bootstrap, raw-Prisma catalogue
 * fixtures) plus the Treasury Drawer/Shift/CashSession rows Payment needs —
 * built with raw admin inserts (not the real `POST /cash-sessions` route)
 * specifically so a CLOSED session and a session with mismatched
 * branch/employee/terminal/currency can exist for the negative-path tests;
 * the real route can never produce any of those.
 *
 * Orders reach OPEN directly via `OrdersService.transition()` — no Fire, no
 * Kitchen/routing fixtures are needed at all for Payment.
 */

const stamp = Date.now();
const AT = new Date('2026-08-24T09:00:00.000Z');
const PACK_VERSION = '2026.1';

const RELEASE_KEY = generateReleaseKey('e2e-payment-release-key');
const TRUST = trustStoreFor(RELEASE_KEY.trusted());
const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);

const packPayload = (code: string, cashRounding: Record<string, unknown>) => ({
  code,
  version: PACK_VERSION,
  effectiveFrom: '2026-01-01',
  currency: {
    code: code === 'EG' ? 'EGP' : 'AED',
    exponent: 2,
    cashRounding,
  },
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

describe('Sales Payment (P1F-1 e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let appPrisma: PrismaService; // ros_app (NOBYPASSRLS) — for direct RLS probes
  let http: App;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string; // EG, cash rounding ENABLED (step 25, HALF_UP)
  let branchU: string; // AE, cash rounding DISABLED
  let terminalA: string;
  let terminalA2: string; // a second, unrelated terminal at branchA
  let terminalU: string; // branchU's own terminal
  let terminalB: string;
  let employeeA: string; // has pos.payment.capture
  let employeeACode: string;
  let employeeNoAuth: string; // has pos.order.create only
  let employeeNoAuthCode: string;
  let employeeOther: string; // a second capture-authorised employee at branchA
  let employeeOtherCode: string;
  let employeeB: string;
  let employeeBCode: string;
  let userA: string;
  let userNoAuth: string;
  let userOther: string;
  let userB: string;

  let taxClassStandardA: string;
  let taxClassStandardU: string;
  let priceListA: string;
  let priceListU: string;

  let cashSessionA: string; // open, branchA, employeeA, drawer bound to terminalA
  let cashSessionOtherEmployee: string; // open, branchA, employeeOther
  let cashSessionClosed: string; // closed, branchA, employeeA
  let cashSessionWrongBranch: string; // open, branchU, some employee
  let cashSessionWrongCurrency: string; // open, branchA, employeeA, currency USD
  let cashSessionWrongTerminal: string; // open, branchA, employeeA, drawer bound to terminalA2

  const priceListFor = async (tenantId: string, branchId: string) => {
    const list = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId,
        name: `Payment pricing ${branchId}`,
        scopeType: 'branch',
        scopeId: branchId,
        status: 'active',
      },
    });
    return list.id;
  };

  /** A ~100.00-unit sellable item + variant + price (grandTotal well above any single test payment). */
  const mkSellable = async (
    tenantId: string,
    taxClassId: string,
    priceListId: string,
    name: string,
  ) => {
    const item = await admin.menuItem.create({
      data: { id: newId(), tenantId, names: { en: name }, taxClassId },
    });
    const variant = await admin.menuItemVariant.create({
      data: { id: newId(), tenantId, menuItemId: item.id, name: { en: 'V' } },
    });
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId,
        priceListId,
        menuItemVariantId: variant.id,
        price: 10_000n,
        currency: priceListId === priceListA ? 'EGP' : 'AED',
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
    appPrisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    packs = app.get(CountryPackService);

    await packs.activate(
      signPackDocument(
        packPayload('EG', { enabled: true, stepMinorUnits: 25 }),
        RELEASE_KEY,
      ),
    );
    await packs.activate(
      signPackDocument(packPayload('AE', { enabled: false }), RELEASE_KEY),
    );

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
        slug: `paya-${stamp}`,
        legalName: 'PayA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `payb-${stamp}`,
        legalName: 'PayB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    // FR-BRN-003 — "Branches in different countries SHALL operate under
    // different country packs within one tenant". `TenantsService.create`
    // only auto-provisions the tenant's OWN declared `countryPackCode`
    // (EG); `branchU` below is AE, so AE tax classes are provisioned for
    // tenantA explicitly, exactly as a real second-country branch rollout
    // would trigger.
    await app
      .get<TaxClassProvisioner>(TAX_CLASS_PROVISIONER)
      .provisionForTenant(tenantA, 'AE');

    const mkBranch = async (
      tenantId: string,
      code: string,
      countryCode: string,
      currency: string,
    ) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `PBrand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `PBranch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: currency,
          countryCode,
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
    branchA = await mkBranch(tenantA, `PA${stamp % 10000}`, 'EG', 'EGP');
    branchU = await mkBranch(tenantA, `PU${stamp % 10000}`, 'AE', 'AED');
    const branchB = await mkBranch(tenantB, `PB${stamp % 10000}`, 'EG', 'EGP');

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
    terminalA = await mkTerminal(tenantA, branchA, 'PA-POS-1');
    terminalA2 = await mkTerminal(tenantA, branchA, 'PA-POS-2');
    terminalU = await mkTerminal(tenantA, branchU, 'PU-POS-1');
    terminalB = await mkTerminal(tenantB, branchB, 'PB-POS');

    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of INVENTORY_PERMISSION_DEFS) await permissions.upsert(def);

    const cashierFull = await roles.createTenantRole(tenantA, {
      name: `pay_cashier_${stamp}`,
    });
    await roles.addPermissions(tenantA, cashierFull.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
      TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    ]);
    const createOnly = await roles.createTenantRole(tenantA, {
      name: `pay_noauth_${stamp}`,
    });
    await roles.addPermissions(tenantA, createOnly.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
    ]);
    const cashierB = await roles.createTenantRole(tenantB, {
      name: `pay_cashier_b_${stamp}`,
    });
    await roles.addPermissions(tenantB, cashierB.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
    ]);

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({
        email,
        password: 's3cure-passphrase',
        displayName: 'P',
      });
      const m = await memberships.grant(u.id, tenantId, 'active');
      return { userId: u.id, membershipId: m.id };
    };

    const a = await mkUser(`pay.a.${stamp}@example.com`, tenantA);
    userA = a.userId;
    await membershipRoles.assign(tenantA, a.membershipId, cashierFull.id);

    const other = await mkUser(`pay.other.${stamp}@example.com`, tenantA);
    userOther = other.userId;
    await membershipRoles.assign(tenantA, other.membershipId, cashierFull.id);

    const nf = await mkUser(`pay.noauth.${stamp}@example.com`, tenantA);
    userNoAuth = nf.userId;
    await membershipRoles.assign(tenantA, nf.membershipId, createOnly.id);

    const b = await mkUser(`pay.b.${stamp}@example.com`, tenantB);
    userB = b.userId;
    await membershipRoles.assign(tenantB, b.membershipId, cashierB.id);

    employeeACode = `PEA${stamp % 1000}`;
    employeeA = (
      await employees.create(tenantA, userA, {
        code: employeeACode,
        displayName: 'Pay A',
        homeBranchId: branchA,
        userId: userA,
        // Also permitted at branchU (FR-SEC-021), for the
        // rounding-DISABLED-pack test, which opens a real order there.
        permittedBranchIds: [branchU],
      })
    ).id;
    employeeOtherCode = `PEO${stamp % 1000}`;
    employeeOther = (
      await employees.create(tenantA, userA, {
        code: employeeOtherCode,
        displayName: 'Pay Other',
        homeBranchId: branchA,
        userId: userOther,
      })
    ).id;
    employeeNoAuthCode = `PEN${stamp % 1000}`;
    employeeNoAuth = (
      await employees.create(tenantA, userA, {
        code: employeeNoAuthCode,
        displayName: 'Pay NoAuth',
        homeBranchId: branchA,
        userId: userNoAuth,
      })
    ).id;
    employeeBCode = `PEB${stamp % 1000}`;
    employeeB = (
      await employees.create(tenantB, userB, {
        code: employeeBCode,
        displayName: 'Pay B',
        homeBranchId: branchB,
        userId: userB,
      })
    ).id;

    await pins.setPin(tenantA, userA, employeeA, '1111');
    await pins.setPin(tenantA, userA, employeeOther, '2222');
    await pins.setPin(tenantA, userA, employeeNoAuth, '3333');
    await pins.setPin(tenantB, userB, employeeB, '4444');

    taxClassStandardA = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;
    taxClassStandardU = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'AE', code: 'standard' },
      })
    ).id;
    priceListA = await priceListFor(tenantA, branchA);
    priceListU = await priceListFor(tenantA, branchU);

    // ── Treasury fixtures — raw admin inserts, deliberately NOT via the
    // real POST /cash-sessions route, so a CLOSED session and
    // wrong-branch/employee/terminal/currency sessions can exist. ────────
    const mkDrawer = (
      branchId: string,
      name: string,
      terminalId: string | null,
    ) =>
      admin.drawer
        .create({
          data: { id: newId(), tenantId: tenantA, branchId, name, terminalId },
        })
        .then((d) => d.id);
    const mkShift = (branchId: string, employeeId: string) =>
      admin.shift
        .create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId,
            employeeId,
            status: 'open',
            openedAt: AT,
          },
        })
        .then((s) => s.id);

    const drawerA = await mkDrawer(branchA, 'Drawer-A', terminalA);
    const shiftA = await mkShift(branchA, employeeA);
    cashSessionA = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          drawerId: drawerA,
          shiftId: shiftA,
          employeeId: employeeA,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;

    const drawerOther = await mkDrawer(branchA, 'Drawer-Other', null);
    const shiftOther = await mkShift(branchA, employeeOther);
    cashSessionOtherEmployee = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          drawerId: drawerOther,
          shiftId: shiftOther,
          employeeId: employeeOther,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;

    const drawerClosed = await mkDrawer(branchA, 'Drawer-Closed', null);
    const shiftClosed = await mkShift(branchA, employeeA);
    cashSessionClosed = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          drawerId: drawerClosed,
          shiftId: shiftClosed,
          employeeId: employeeA,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'closed',
          openedAt: AT,
          closedAt: AT,
        },
      })
    ).id;

    const drawerU = await mkDrawer(branchU, 'Drawer-U', null);
    const shiftU = await mkShift(branchU, employeeA);
    cashSessionWrongBranch = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchU,
          drawerId: drawerU,
          shiftId: shiftU,
          employeeId: employeeA,
          openingFloat: 50_000n,
          currency: 'AED',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;

    const drawerWrongCurrency = await mkDrawer(
      branchA,
      'Drawer-WrongCcy',
      null,
    );
    const shiftWrongCurrency = await mkShift(branchA, employeeA);
    cashSessionWrongCurrency = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          drawerId: drawerWrongCurrency,
          shiftId: shiftWrongCurrency,
          employeeId: employeeA,
          openingFloat: 50_000n,
          currency: 'USD',
          status: 'open',
          openedAt: AT,
        },
      })
    ).id;

    const drawerWrongTerminal = await mkDrawer(
      branchA,
      'Drawer-WrongTerm',
      terminalA2,
    );
    const shiftWrongTerminal = await mkShift(branchA, employeeA);
    cashSessionWrongTerminal = (
      await admin.cashSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          drawerId: drawerWrongTerminal,
          shiftId: shiftWrongTerminal,
          employeeId: employeeA,
          openingFloat: 50_000n,
          currency: 'EGP',
          status: 'open',
          openedAt: AT,
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
    terminalId: string,
    employeeCode: string,
    pin: string,
  ) => {
    const res = await request(http)
      .post('/auth/pin')
      .send({ tenantId: tid, terminalId, employeeCode, pin })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const currentVersion = async (orderId: string): Promise<number> =>
    (
      await admin.order.findFirstOrThrow({
        where: { id: orderId },
        select: { version: true },
      })
    ).version;

  /** Opens an order and moves it straight to OPEN (no Fire needed for Payment). */
  const mkOpenOrder = async (
    opts: {
      terminalId?: string;
      tenantId?: string;
    } = {},
  ) => {
    const order = await orders.create(opts.tenantId ?? tenantA, userA, {
      terminalId: opts.terminalId ?? terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    return orders.transition(
      opts.tenantId ?? tenantA,
      userA,
      order.id,
      order.businessDay,
      'open',
      order.version,
    );
  };

  const mkLine = async (
    orderId: string,
    businessDay: Date,
    itemId: string,
    variantId: string,
    tenantId = tenantA,
  ) => {
    const expectedVersion = await currentVersion(orderId);
    return lines.addLine(tenantId, userA, orderId, businessDay, {
      menuItemId: itemId,
      variantId,
      quantity: '1',
      expectedVersion,
    });
  };

  const etagOf = (id: string, version: number) => `W/"${id}.${version}"`;

  const httpPay = (
    token: string,
    businessDay: Date,
    orderId: string,
    ifMatch: string,
    body: Record<string, unknown>,
    idempotencyKey = `pay-${newId()}`,
  ) =>
    request(http)
      .post(
        `/orders/${businessDay.toISOString().slice(0, 10)}/${orderId}/payments`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', ifMatch)
      .send(body);

  /**
   * Awaiting a supertest `Test` here (rather than returning it directly) is
   * deliberate: an `async` function that RETURNS a thenable has its own
   * promise flattened to the thenable's resolved value (Promises/A+), so
   * `payAndExpect(...)` already yields a resolved `Response` — `.expect(...)` on
   * the un-awaited call is not callable. Use `payAndExpect` for a one-line
   * status assertion, or `await payNow(...)` directly for the full
   * `Response` without one.
   */
  const payNow = async (
    token: string,
    order: { id: string; businessDay: Date },
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) => {
    const version = await currentVersion(order.id);
    return httpPay(
      token,
      order.businessDay,
      order.id,
      etagOf(order.id, version),
      body,
      idempotencyKey,
    );
  };

  /** `payNow` + a one-line status assertion, returning the resolved `Response`. */
  const payAndExpect = async (
    token: string,
    order: { id: string; businessDay: Date },
    body: Record<string, unknown>,
    status: number,
    idempotencyKey?: string,
  ) => {
    const res = await payNow(token, order, body, idempotencyKey);
    expect(res.status).toBe(status);
    return res;
  };

  // ============================================================ SCHEMA / DB
  describe('Payment schema / DB (§25.A)', () => {
    /**
     * One Payment captured via the real HTTP route, shared read-only by
     * every RLS probe below — mirrors `production-rls.e2e-spec.ts`'s own
     * shape (fixtures built once through the real service, then probed
     * directly through `appPrisma`, the actual `ros_app` (NOBYPASSRLS)
     * connection the running application uses — never the `admin`
     * migrator/BYPASSRLS client, which would prove nothing about RLS).
     */
    let probeOrderId: string;
    let probePaymentId: string;
    beforeAll(async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `Row-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        201,
      );
      probeOrderId = order.id;
      probePaymentId = (res.body as { payment: { id: string } }).payment.id;
    });

    describe('missing tenant context -> fail closed', () => {
      it('SELECT returns no rows at all, even though the row exists', async () => {
        const count = await appPrisma.withAuthContext({}, (tx) =>
          tx.orderPayment.count({ where: { id: probePaymentId } }),
        );
        expect(count).toBe(0);
      });

      it('rejects an INSERT with no tenant context', async () => {
        await expect(
          appPrisma.withAuthContext(
            {},
            (tx) =>
              tx.$executeRaw`
              INSERT INTO "sales"."order_payments" (
                "id", "tenant_id", "branch_id", "order_id", "business_day",
                "tender", "currency", "amount", "cash_session_id",
                "employee_id", "terminal_id", "tendered_amount",
                "change_given", "processed_at"
              ) VALUES (
                ${newId()}::uuid, ${tenantA}::uuid, ${branchA}::uuid,
                ${probeOrderId}::uuid, ${AT}::date, 'cash'::"sales"."OrderPaymentTender",
                'EGP', 100, ${cashSessionA}::uuid, ${employeeA}::uuid,
                ${terminalA}::uuid, 100, 0, ${AT}::timestamptz
              )
            `,
          ),
        ).rejects.toThrow();
      });
    });

    describe('same tenant -> allowed (positive control)', () => {
      it('sees its own Payment row', async () => {
        const count = await appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) => tx.orderPayment.count({ where: { id: probePaymentId } }),
        );
        expect(count).toBe(1);
      });
    });

    describe('cross-tenant', () => {
      it('SELECT returns nothing when queried as tenant B', async () => {
        const rows = await appPrisma.withAuthContext(
          { tenantId: tenantB },
          (tx) => tx.orderPayment.findMany({ where: { id: probePaymentId } }),
        );
        expect(rows).toHaveLength(0);
      });

      it('the same query as tenant A DOES see the row (positive control — proves the empty result above is RLS, not a bad WHERE clause)', async () => {
        const rows = await appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) => tx.orderPayment.findMany({ where: { id: probePaymentId } }),
        );
        expect(rows).toHaveLength(1);
      });

      it('a tenant B token cannot read tenant A Payment via any HTTP route', async () => {
        // Tenant B cannot even see the order (404), the strongest available
        // proof that its Payment is unreachable via the API surface.
        const tokenB = await pinLogin(
          tenantB,
          terminalB,
          employeeBCode,
          '4444',
        );
        const order = await admin.order.findFirstOrThrow({
          where: { id: probeOrderId },
        });
        const res = await request(http)
          .get(
            `/orders/${order.businessDay.toISOString().slice(0, 10)}/${probeOrderId}`,
          )
          .set('Authorization', `Bearer ${tokenB}`)
          .expect(404);
        expect(res.status).toBe(404);
      });
    });

    describe('append-only enforcement', () => {
      it('ros_app cannot UPDATE a Payment row', async () => {
        await expect(
          appPrisma.withAuthContext({ tenantId: tenantA }, (tx) =>
            tx.orderPayment.updateMany({
              where: { id: probePaymentId },
              data: { amount: 999n },
            }),
          ),
        ).rejects.toThrow();
        // The row is genuinely untouched — not merely that the call threw.
        const row = await admin.orderPayment.findUniqueOrThrow({
          where: { id: probePaymentId },
        });
        expect(row.amount).toBe(2000n);
      });

      it('ros_app cannot DELETE a Payment row', async () => {
        await expect(
          appPrisma.withAuthContext({ tenantId: tenantA }, (tx) =>
            tx.orderPayment.deleteMany({ where: { id: probePaymentId } }),
          ),
        ).rejects.toThrow();
        const row = await admin.orderPayment.findUnique({
          where: { id: probePaymentId },
        });
        expect(row).not.toBeNull();
      });

      it('ros_app CAN still SELECT its own row (positive control — proves UPDATE/DELETE refusal is a real privilege gap, not a broken connection)', async () => {
        const row = await appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) => tx.orderPayment.findUnique({ where: { id: probePaymentId } }),
        );
        expect(row).not.toBeNull();
      });

      it('has no table-wide UPDATE/DELETE grant for ros_app', async () => {
        const rows = await admin.$queryRawUnsafe<{ privilege_type: string }[]>(`
          SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'ros_app' AND table_schema = 'sales' AND table_name = 'order_payments'
        `);
        const privileges = rows.map((r) => r.privilege_type).sort();
        expect(privileges).toEqual(['INSERT', 'SELECT']);
      });
    });

    it('RLS is ENABLED and FORCED on order_payments', async () => {
      const rows = await admin.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = 'order_payments' AND relnamespace = 'sales'::regnamespace
      `);
      expect(rows[0].relrowsecurity).toBe(true);
      expect(rows[0].relforcerowsecurity).toBe(true);
    });
  });

  /**
   * P1F-1A §9 — STRUCTURAL FK proofs, isolated from RLS and from the
   * service layer entirely: raw `admin` (migrator/BYPASSRLS) inserts,
   * proving PostgreSQL itself — not `SalesPaymentService`'s own
   * validation — refuses a cross-branch/cross-tenant Payment reference.
   * ADR 0008 D-09's own rationale is that referential-integrity checks run
   * with RLS DISABLED, so a test that only proves the RLS-scoped
   * application path is insufficient; these tests deliberately bypass it.
   */
  describe('structural FK integrity (P1F-1A §9)', () => {
    const validPayment = (
      overrides: Partial<Prisma.OrderPaymentUncheckedCreateInput> &
        Pick<
          Prisma.OrderPaymentUncheckedCreateInput,
          'orderId' | 'businessDay' | 'terminalId' | 'cashSessionId'
        >,
    ): Prisma.OrderPaymentUncheckedCreateInput => ({
      id: newId(),
      tenantId,
      branchId: branchA,
      tender: 'manual_external_card' as const,
      currency: 'EGP',
      amount: 1000n,
      roundingAdjustment: 0n,
      employeeId,
      paymentTerminalTxnRef: `FK-${newId()}`,
      processedAt: AT,
      ...overrides,
    });

    let tenantId: string;
    let employeeId: string;
    let order: { id: string; businessDay: Date };

    beforeAll(async () => {
      tenantId = tenantA;
      employeeId = employeeA;
      order = await mkOpenOrder();
    });

    it('A. a valid Order/branch/Terminal combination inserts (positive control)', async () => {
      const row = await admin.orderPayment.create({
        data: validPayment({
          orderId: order.id,
          businessDay: order.businessDay,
          terminalId: terminalA, // registered to branchA — matches branchId above
          cashSessionId: cashSessionA,
        }),
      });
      expect(row.id).toBeDefined();
    });

    it('B. a real Order but a DIFFERENT branch_id is rejected — the branch-inclusive Order FK does not match', async () => {
      await expect(
        admin.orderPayment.create({
          data: validPayment({
            orderId: order.id,
            businessDay: order.businessDay,
            branchId: branchU, // order.branchId is actually branchA
            terminalId: terminalU, // must also match branchU for the terminal FK to pass, isolating the Order FK as the cause
            cashSessionId: cashSessionWrongBranch, // an open session actually scoped to branchU
          }),
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('C. branch A with a Terminal registered to a different branch is rejected — (branch_id, terminal_id) cannot resolve', async () => {
      await expect(
        admin.orderPayment.create({
          data: validPayment({
            orderId: order.id,
            businessDay: order.businessDay,
            branchId: branchA,
            terminalId: terminalU, // registered to branchU, not branchA
            cashSessionId: cashSessionA,
          }),
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('D. a cross-TENANT Terminal is rejected the same way — the D-09 hazard is closed', async () => {
      await expect(
        admin.orderPayment.create({
          data: validPayment({
            orderId: order.id,
            businessDay: order.businessDay,
            branchId: branchA,
            terminalId: terminalB, // tenant B's own terminal, a different branch entirely
            cashSessionId: cashSessionA,
          }),
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('E. a real Order but a fabricated order_id is rejected — the Order FK requires a genuine row', async () => {
      await expect(
        admin.orderPayment.create({
          data: validPayment({
            orderId: newId(), // does not exist
            businessDay: order.businessDay,
            branchId: branchA,
            terminalId: terminalA,
            cashSessionId: cashSessionA,
          }),
        }),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  // =========================================================== AUTHORIZATION
  describe('authorization (§25.B)', () => {
    it('missing pos.payment.capture is rejected (403)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `Auth1-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const token = await pinLogin(
        tenantA,
        terminalA,
        employeeNoAuthCode,
        '3333',
      );
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        403,
      );
    });

    it('pos.order.create alone is insufficient', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `Auth2-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const token = await pinLogin(
        tenantA,
        terminalA,
        employeeNoAuthCode,
        '3333',
      );
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        403,
      );
    });

    it('an authorised capture succeeds (200/201)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `Auth3-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        201,
      );
    });
  });

  // =========================================================== ORDER STATE
  describe('order state (§25.C)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('OPEN + partial -> PARTIALLY_PAID', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `St1-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        201,
      );
      expect((res.body as { order: { state: string } }).order.state).toBe(
        'partially_paid',
      );
    });

    it('PARTIALLY_PAID + further partial stays PARTIALLY_PAID', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `St2-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        201,
      );
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '1000',
          tenderedAmountMinor: '1000',
          cashSessionId: cashSessionA,
        },
        201,
      );
      expect((res.body as { order: { state: string } }).order.state).toBe(
        'partially_paid',
      );
    });

    it('DRAFT is rejected', async () => {
      const order = await orders.create(tenantA, userA, {
        terminalId: terminalA,
        openedByEmployeeId: employeeA,
        orderType: 'takeaway',
        channel: 'pos',
        originDeviceTime: AT,
        idempotencyKey: `k-${newId()}`,
        at: AT,
      });
      await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, order.version),
        {
          tender: 'cash',
          amountMinor: '100',
          tenderedAmountMinor: '100',
          cashSessionId: cashSessionA,
        },
      ).expect(422);
    });

    it('HELD is rejected', async () => {
      const order = await mkOpenOrder();
      await orders.transition(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        'held',
        order.version,
      );
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '100',
          tenderedAmountMinor: '100',
          cashSessionId: cashSessionA,
        },
        422,
      );
    });

    it('PARKED is rejected', async () => {
      const order = await mkOpenOrder();
      await orders.transition(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        'parked',
        order.version,
      );
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '100',
          tenderedAmountMinor: '100',
          cashSessionId: cashSessionA,
        },
        422,
      );
    });

    it('a terminal state (cancelled) is rejected', async () => {
      const order = await mkOpenOrder();
      await orders.transition(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        'cancelled',
        order.version,
      );
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '100',
          tenderedAmountMinor: '100',
          cashSessionId: cashSessionA,
        },
        422,
      );
      expect((res.body as { message: string }).message).toMatch(
        /no longer be modified/,
      );
    });

    it('a full-settlement attempt is rejected atomically — no Payment, no projection change, no audit', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `Full-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const fresh = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const versionBefore = fresh.version;
      const grandTotal = fresh.grandTotal;

      const auditBefore = await admin.auditEntry.count({
        where: { tenantId: tenantA, action: 'PAYMENT_CAPTURED' },
      });

      const res = await payNow(token, order, {
        tender: 'cash',
        amountMinor: grandTotal.toString(),
        tenderedAmountMinor: grandTotal.toString(),
        cashSessionId: cashSessionA,
      });
      expect(res.status).toBe(422);
      expect((res.body as { error?: string; message: string }).message).toMatch(
        /full or over settlement|FULL_PAYMENT_REQUIRES_COMPLETION/i,
      );

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe('open');
      expect(afterOrder.version).toBe(versionBefore);
      expect(afterOrder.paidTotal).toBe(0n);
      const payments = await admin.orderPayment.findMany({
        where: { orderId: order.id },
      });
      expect(payments).toHaveLength(0);
      const auditAfter = await admin.auditEntry.count({
        where: { tenantId: tenantA, action: 'PAYMENT_CAPTURED' },
      });
      expect(auditAfter).toBe(auditBefore);
    });
  });

  // =================================================================== CASH
  describe('CASH capture (§25.D)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('requires an open, valid CashSession', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C1-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: newId(), // does not exist
        },
        404,
      );
    });

    it('rejects a session belonging to a different employee', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C2-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionOtherEmployee,
        },
        422,
      );
    });

    it('rejects a session in a different branch', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C3-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payNow(token, order, {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionWrongBranch,
      });
      expect(res.status).toBe(422);
    });

    it('rejects a session bound to a different terminal', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C4-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payNow(token, order, {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionWrongTerminal,
      });
      expect(res.status).toBe(422);
    });

    it('rejects a session in a different currency', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C5-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payNow(token, order, {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionWrongCurrency,
      });
      expect(res.status).toBe(422);
    });

    it('rejects a closed session', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C6-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payNow(token, order, {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionClosed,
      });
      expect(res.status).toBe(422);
    });

    it('validates the tendered amount — insufficient cash rejected', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C7-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payNow(token, order, {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '1000',
        cashSessionId: cashSessionA,
      });
      expect(res.status).toBe(422);
    });

    it('computes change due correctly with rounding ENABLED (step 25, HALF_UP)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C8-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      // 2137 -> nearest 25 is 2125 (2137/25=85.48 -> HALF_UP rounds 85) -> 85*25=2125
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2137',
          tenderedAmountMinor: '2200',
          cashSessionId: cashSessionA,
        },
        201,
      );
      const body = res.body as {
        payment: { roundingAdjustment: string; changeGiven: string };
      };
      expect(body.payment.roundingAdjustment).toBe((2125 - 2137).toString());
      expect(body.payment.changeGiven).toBe((2200 - 2125).toString());
    });

    it('rounding is persisted per Payment, and the Order rounding projection reflects it', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C9-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const before = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2137',
          tenderedAmountMinor: '2200',
          cashSessionId: cashSessionA,
        },
        201,
      );
      const paymentRow = await admin.orderPayment.findFirstOrThrow({
        where: { id: (res.body as { payment: { id: string } }).payment.id },
      });
      expect(paymentRow.roundingAdjustment).toBe(-12n);
      const after = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(after.roundingAdjustment).toBe(before.roundingAdjustment - 12n);
      // paid_total moves by the EXACT amount, not the rounded figure.
      expect(after.paidTotal).toBe(before.paidTotal + 2137n);
    });

    it('the rounding-DISABLED country pack applies zero rounding', async () => {
      // branchU is pinned to the AE pack (cashRounding.enabled: false).
      const openU = await mkOpenOrder({ terminalId: terminalU });
      const item = await mkSellable(
        tenantA,
        taxClassStandardU,
        priceListU,
        `C10-${newId()}`,
      );
      await mkLine(openU.id, openU.businessDay, item.itemId, item.variantId);
      // `cashSessionWrongBranch` is deliberately reused here: it was
      // fixtured as an open, branchU-scoped, employeeA session (see
      // beforeAll) precisely so a legitimate branchU capture is possible
      // without a second dedicated fixture.
      //
      // P1F-1A: the capturing session must be bound to a TERMINAL actually
      // registered to branchU — `token` (this block's own) is bound to
      // terminalA/branchA, and Payment's terminal composite FK is now
      // branch-safe, so a branchA-terminal capture on a branchU order is
      // correctly refused. Log in via `terminalU` for this one test.
      const tokenU = await pinLogin(tenantA, terminalU, employeeACode, '1111');
      const res = await payAndExpect(
        tokenU,
        openU,
        {
          tender: 'cash',
          amountMinor: '2137',
          tenderedAmountMinor: '2137',
          cashSessionId: cashSessionWrongBranch,
        },
        201,
      );
      const body = res.body as {
        payment: { roundingAdjustment: string; changeGiven: string };
      };
      expect(body.payment.roundingAdjustment).toBe('0');
      expect(body.payment.changeGiven).toBe('0');
    });

    it('cash affects the persisted data needed for expected-cash derivation (amount + roundingAdjustment on the row)', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `C11-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        201,
      );
      const row = await admin.orderPayment.findFirstOrThrow({
        where: { id: (res.body as { payment: { id: string } }).payment.id },
      });
      expect(row.tender).toBe('cash');
      expect(row.amount).toBe(2000n);
      expect(row.cashSessionId).toBe(cashSessionA);
    });
  });

  // ==================================================== MANUAL_EXTERNAL_CARD
  describe('MANUAL_EXTERNAL_CARD capture (§25.E)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('terminalReference is required', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `M1-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      await payAndExpect(
        token,
        order,
        {
          tender: 'manual_external_card',
          amountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        400,
      );
    });

    it('captures successfully with no PaymentAttempt row anywhere, rounding = 0, no cash fields', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `M2-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'manual_external_card',
          amountMinor: '2000',
          cashSessionId: cashSessionA,
          terminalReference: `EXT-${newId()}`,
          cardScheme: 'visa',
          last4: '4242',
          authorizationCode: 'AUTH123',
        },
        201,
      );
      const body = res.body as {
        payment: {
          roundingAdjustment: string;
          tenderedAmount: string | null;
          changeGiven: string | null;
          cardScheme: string | null;
          cardLast4: string | null;
          authorizationCode: string | null;
        };
      };
      expect(body.payment.roundingAdjustment).toBe('0');
      expect(body.payment.tenderedAmount).toBeNull();
      expect(body.payment.changeGiven).toBeNull();
      expect(body.payment.cardScheme).toBe('visa');
      expect(body.payment.cardLast4).toBe('4242');
      expect(body.payment.authorizationCode).toBe('AUTH123');
    });

    it('is associated with a CashSession under P1D-G but never affects physical cash', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `M3-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'manual_external_card',
          amountMinor: '2000',
          cashSessionId: cashSessionA,
          terminalReference: `EXT-${newId()}`,
        },
        201,
      );
      const row = await admin.orderPayment.findFirstOrThrow({
        where: { id: (res.body as { payment: { id: string } }).payment.id },
      });
      expect(row.cashSessionId).toBe(cashSessionA);
      expect(row.tenderedAmount).toBeNull(); // no cash semantics at all
    });

    it('rejects a PCI field the DTO does not define', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `M4-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      await payAndExpect(
        token,
        order,
        {
          tender: 'manual_external_card',
          amountMinor: '2000',
          cashSessionId: cashSessionA,
          terminalReference: `EXT-${newId()}`,
          pan: '4111111111111111',
        },
        400,
      );
    });
  });

  // =============================================================== IDEMPOTENCY
  describe('idempotency (§25.F)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('same key exact replay — one Payment, one projection change, one audit', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `I1-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const key = `pay-idem-${newId()}`;
      const body = {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionA,
      };
      const versionBefore = await currentVersion(order.id);
      const first = await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        body,
        key,
      ).expect(201);
      const second = await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        body,
        key,
      ).expect(201);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);

      const payments = await admin.orderPayment.findMany({
        where: { orderId: order.id },
      });
      expect(payments).toHaveLength(1);
      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.version).toBe(versionBefore + 1);
      const auditCount = await admin.auditEntry.count({
        where: {
          tenantId: tenantA,
          action: 'PAYMENT_CAPTURED',
          entityId: payments[0].id,
        },
      });
      expect(auditCount).toBe(1);
    });

    it('same key across two DIFFERENT orders 409-conflicts, never replays', async () => {
      const orderX = await mkOpenOrder();
      const orderY = await mkOpenOrder();
      const itemX = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `I2X-${newId()}`,
      );
      const itemY = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `I2Y-${newId()}`,
      );
      await mkLine(
        orderX.id,
        orderX.businessDay,
        itemX.itemId,
        itemX.variantId,
      );
      await mkLine(
        orderY.id,
        orderY.businessDay,
        itemY.itemId,
        itemY.variantId,
      );
      const key = `pay-fp-${newId()}`;
      const body = {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionA,
      };
      await httpPay(
        token,
        orderX.businessDay,
        orderX.id,
        etagOf(orderX.id, await currentVersion(orderX.id)),
        body,
        key,
      ).expect(201);
      const resY = await httpPay(
        token,
        orderY.businessDay,
        orderY.id,
        etagOf(orderY.id, await currentVersion(orderY.id)),
        body,
        key,
      );
      expect(resY.status).toBe(409);
      const afterY = await admin.order.findFirstOrThrow({
        where: { id: orderY.id },
      });
      expect(afterY.state).toBe('open');
    });

    it('same key + different body -> 409', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `I3-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const key = `pay-diffbody-${newId()}`;
      const versionBefore = await currentVersion(order.id);
      await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        key,
      ).expect(201);
      const res = await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        {
          tender: 'cash',
          amountMinor: '3000',
          tenderedAmountMinor: '3000',
          cashSessionId: cashSessionA,
        },
        key,
      );
      expect(res.status).toBe(409);
    });

    it('a repeated permanent Payment id under a genuinely DIFFERENT Idempotency-Key never creates a second financial effect', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `I4-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const paymentId = newId();
      const body = {
        id: paymentId,
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionA,
      };
      const versionBefore = await currentVersion(order.id);
      await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        body,
        `k1-${newId()}`,
      ).expect(201);
      const res = await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore + 1),
        body,
        `k2-${newId()}`,
      );
      // Second call replays (identical content, same permanent id) rather
      // than creating a second row — the version mismatch is moot because
      // the identity check short-circuits before the CAS is even attempted.
      expect(res.status).toBe(201);
      const payments = await admin.orderPayment.findMany({
        where: { id: paymentId },
      });
      expect(payments).toHaveLength(1);
    });
  });

  // =================================================================== IF-MATCH
  describe('If-Match (§25.G)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('missing If-Match is rejected', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `IM1-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await request(http)
        .post(
          `/orders/${order.businessDay.toISOString().slice(0, 10)}/${order.id}/payments`,
        )
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `im-${newId()}`)
        .send({
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        });
      expect(res.status).toBe(400);
    });

    it('malformed If-Match is rejected', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `IM2-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await httpPay(
        token,
        order.businessDay,
        order.id,
        'not-a-valid-etag',
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
      );
      expect(res.status).toBe(400);
    });

    it('a stale If-Match is rejected with 409', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `IM3-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const staleVersion = order.version; // pre-line-add version, now stale
      const res = await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, staleVersion),
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
      );
      expect(res.status).toBe(409);
    });

    it('a correct If-Match succeeds and returns the updated ETag/version', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `IM4-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const versionBefore = await currentVersion(order.id);
      const res = await httpPay(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
      ).expect(201);
      expect(res.headers.etag).toBe(etagOf(order.id, versionBefore + 1));
      expect((res.body as { order: { version: number } }).order.version).toBe(
        versionBefore + 1,
      );
    });
  });

  // =============================================================== AUDIT
  describe('audit (§25.I)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('exactly one PAYMENT_CAPTURED audit entry on success, identifying order/payment/tender/amount/session/employee', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `Aud1-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const res = await payAndExpect(
        token,
        order,
        {
          tender: 'cash',
          amountMinor: '2000',
          tenderedAmountMinor: '2000',
          cashSessionId: cashSessionA,
        },
        201,
      );
      const paymentId = (res.body as { payment: { id: string } }).payment.id;
      const entries = await admin.auditEntry.findMany({
        where: {
          tenantId: tenantA,
          action: 'PAYMENT_CAPTURED',
          entityId: paymentId,
        },
      });
      expect(entries).toHaveLength(1);
      // `AuditService.record()` persists the input's `metadata` field under
      // the `after_state` column (`afterState`) — there is no `metadata`
      // column on `AuditEntry` at all.
      const metadata = entries[0].afterState as Record<string, unknown>;
      expect(metadata.orderId).toBe(order.id);
      expect(metadata.tender).toBe('cash');
      expect(metadata.amount).toBe('2000');
      expect(metadata.cashSessionId).toBe(cashSessionA);
      expect(metadata.employeeId).toBe(employeeA);
      // `entries[0]` carries a raw BigInt (`sequenceNo`) that
      // `JSON.stringify` cannot serialize natively — a replacer that
      // stringifies bigints is enough for this text-search assertion.
      const serialized = JSON.stringify(entries[0], (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(serialized).not.toMatch(/pan|cvv|track/i);
    });

    it('no audit entry on a rolled-back attempt', async () => {
      const order = await mkOpenOrder();
      const item = await mkSellable(
        tenantA,
        taxClassStandardA,
        priceListA,
        `Aud2-${newId()}`,
      );
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const before = await admin.auditEntry.count({
        where: { tenantId: tenantA, action: 'PAYMENT_CAPTURED' },
      });
      await payNow(token, order, {
        tender: 'cash',
        amountMinor: '2000',
        tenderedAmountMinor: '2000',
        cashSessionId: cashSessionClosed,
      });
      const after = await admin.auditEntry.count({
        where: { tenantId: tenantA, action: 'PAYMENT_CAPTURED' },
      });
      expect(after).toBe(before);
    });
  });
});
