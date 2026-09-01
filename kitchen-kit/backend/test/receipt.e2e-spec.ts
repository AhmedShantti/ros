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
import { createMigratorClient } from './rls-admin';

/**
 * INTERNAL-MVP RECEIPT (RCPT-R1) — end to end through the real HTTP route,
 * real PostgreSQL, real authorization.
 *
 * Setup mirrors `sales-payment.e2e-spec.ts` (signed test country pack,
 * tenant/branch/terminal/employee/PIN bootstrap, raw-Prisma catalogue
 * fixtures, a raw-admin-inserted CashSession — the real route can complete an
 * order without one having ever been opened through `POST /cash-sessions`).
 * Orders reach `completed` the same way that file's own settling-payment test
 * does: `OrdersService.create` -> `orders.transition(..., 'open', ...)` ->
 * `OrderLinesService.addLine` (service calls, not HTTP — Receipt tests the
 * READ side) -> a real HTTP `POST .../payments` that settles the order.
 */

const stamp = Date.now();
const AT = new Date('2026-09-01T09:00:00.000Z');
const PACK_VERSION = '2026.1';

const RELEASE_KEY = generateReleaseKey('e2e-receipt-release-key');
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

describe('Receipt (RCPT-R1 e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let lines: OrderLinesService;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let terminalA: string;
  let terminalB: string;

  let userA: string;
  let employeeA: string; // pos.order.create + pos.payment.capture
  let employeeACode: string;
  let employeeNoPerm: string; // no Sales permission at all
  let employeeNoPermCode: string;
  let employeeB: string;
  let employeeBCode: string;

  let priceListA: string;
  let taxClassStandardA: string;
  let cashSessionA: string;

  let tokenA: string;
  let tokenNoPerm: string;
  let tokenB: string;

  const priceListFor = async (tenantId: string, branchId: string) => {
    const list = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId,
        name: `Receipt pricing ${branchId}`,
        scopeType: 'branch',
        scopeId: branchId,
        status: 'active',
      },
    });
    return list.id;
  };

  /** A 100.00-unit sellable item + variant + price. */
  const mkSellable = async (name: string) => {
    const item = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        names: { en: name },
        taxClassId: taxClassStandardA,
      },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: item.id,
        name: { en: 'Regular' },
      },
    });
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        priceListId: priceListA,
        menuItemVariantId: variant.id,
        price: 10_000n,
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  };

  /** One modifier group + one modifier, linked to `menuItemId`. */
  const mkModifier = async (
    menuItemId: string,
    name: string,
    priceDelta: bigint,
  ) => {
    const group = await admin.modifierGroup.create({
      data: {
        id: newId(),
        tenantId: tenantA,
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
        tenantId: tenantA,
        modifierGroupId: group.id,
        name: { en: name },
        priceDelta,
        kind: 'addition',
      },
    });
    await admin.modifierGroupLink.create({
      data: { tenantId: tenantA, menuItemId, modifierGroupId: group.id },
    });
    return modifier.id;
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
    const packs = app.get(CountryPackService);

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
        slug: `rcpta-${stamp}`,
        legalName: 'ReceiptA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `rcptb-${stamp}`,
        legalName: 'ReceiptB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mkBranch = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `RBrand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `RBranch ${code}`,
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
    branchA = await mkBranch(tenantA, `RA${stamp % 10000}`);
    const branchB = await mkBranch(tenantB, `RB${stamp % 10000}`);

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
    terminalA = await mkTerminal(tenantA, branchA, 'RA-POS-1');
    terminalB = await mkTerminal(tenantB, branchB, 'RB-POS-1');

    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);

    const cashierA = await roles.createTenantRole(tenantA, {
      name: `rcpt_cashier_${stamp}`,
    });
    await roles.addPermissions(tenantA, cashierA.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
    ]);
    const noPermRole = await roles.createTenantRole(tenantA, {
      name: `rcpt_noperm_${stamp}`,
    });
    const cashierB = await roles.createTenantRole(tenantB, {
      name: `rcpt_cashier_b_${stamp}`,
    });
    await roles.addPermissions(tenantB, cashierB.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
    ]);

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({
        email,
        password: 's3cure-passphrase',
        displayName: 'R',
      });
      const m = await memberships.grant(u.id, tenantId, 'active');
      return { userId: u.id, membershipId: m.id };
    };

    const a = await mkUser(`rcpt.a.${stamp}@example.com`, tenantA);
    userA = a.userId;
    await membershipRoles.assign(tenantA, a.membershipId, cashierA.id);

    const np = await mkUser(`rcpt.noperm.${stamp}@example.com`, tenantA);
    await membershipRoles.assign(tenantA, np.membershipId, noPermRole.id);

    const b = await mkUser(`rcpt.b.${stamp}@example.com`, tenantB);
    await membershipRoles.assign(tenantB, b.membershipId, cashierB.id);

    employeeACode = `REA${stamp % 1000}`;
    employeeA = (
      await employees.create(tenantA, a.userId, {
        code: employeeACode,
        displayName: 'Receipt A',
        homeBranchId: branchA,
        userId: a.userId,
      })
    ).id;
    employeeNoPermCode = `REN${stamp % 1000}`;
    employeeNoPerm = (
      await employees.create(tenantA, a.userId, {
        code: employeeNoPermCode,
        displayName: 'Receipt NoPerm',
        homeBranchId: branchA,
        userId: np.userId,
      })
    ).id;
    employeeBCode = `REB${stamp % 1000}`;
    employeeB = (
      await employees.create(tenantB, b.userId, {
        code: employeeBCode,
        displayName: 'Receipt B',
        homeBranchId: branchB,
        userId: b.userId,
      })
    ).id;

    await pins.setPin(tenantA, a.userId, employeeA, '1111');
    await pins.setPin(tenantA, np.userId, employeeNoPerm, '2222');
    await pins.setPin(tenantB, b.userId, employeeB, '3333');

    taxClassStandardA = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;
    priceListA = await priceListFor(tenantA, branchA);

    const drawerA = await admin.drawer
      .create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          name: 'Drawer-RA',
          terminalId: terminalA,
        },
      })
      .then((d) => d.id);
    const shiftA = await admin.shift
      .create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          employeeId: employeeA,
          status: 'open',
          openedAt: AT,
        },
      })
      .then((s) => s.id);
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

    tokenA = await pinLoginRaw(http, tenantA, terminalA, employeeACode, '1111');
    tokenNoPerm = await pinLoginRaw(
      http,
      tenantA,
      terminalA,
      employeeNoPermCode,
      '2222',
    );
    tokenB = await pinLoginRaw(http, tenantB, terminalB, employeeBCode, '3333');
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  async function pinLoginRaw(
    httpServer: App,
    tid: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/auth/pin')
      .send({ tenantId: tid, terminalId, employeeCode, pin })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  const currentVersion = async (orderId: string): Promise<number> =>
    (
      await admin.order.findFirstOrThrow({
        where: { id: orderId },
        select: { version: true },
      })
    ).version;

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

  const mkDraftOrder = () =>
    orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });

  const mkLine = async (
    orderId: string,
    businessDay: Date,
    itemId: string,
    variantId: string,
    modifierIds: string[] = [],
  ) => {
    const expectedVersion = await currentVersion(orderId);
    return lines.addLine(tenantA, userA, orderId, businessDay, {
      menuItemId: itemId,
      variantId,
      quantity: '1',
      expectedVersion,
      modifiers: modifierIds.map((modifierId) => ({ modifierId })),
    });
  };

  const etagOf = (id: string, version: number) => `W/"${id}.${version}"`;

  const payNow = async (
    order: { id: string; businessDay: Date },
    body: Record<string, unknown>,
  ) => {
    const version = await currentVersion(order.id);
    return request(http)
      .post(
        `/orders/${order.businessDay.toISOString().slice(0, 10)}/${order.id}/payments`,
      )
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', `pay-${newId()}`)
      .set('If-Match', etagOf(order.id, version))
      .send(body);
  };

  /** Fully settles an order (single cash tender) and returns the completed row. */
  const completeWithCash = async (
    orderId: string,
    businessDay: Date,
    grandTotal: bigint,
  ) => {
    const res = await payNow(
      { id: orderId, businessDay },
      {
        tender: 'cash',
        amountMinor: grandTotal.toString(),
        tenderedAmountMinor: grandTotal.toString(),
        cashSessionId: cashSessionA,
      },
    );
    expect(res.status).toBe(201);
    return admin.order.findFirstOrThrow({ where: { id: orderId } });
  };

  const httpReceipt = (
    token: string | null,
    businessDay: Date,
    orderId: string,
  ) => {
    const req = request(http).get(
      `/orders/${businessDay.toISOString().slice(0, 10)}/${orderId}/receipt`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  interface ReceiptBody {
    documentType: string;
    fiscal: boolean;
    disclosureKey: string;
    order: {
      id: string;
      orderNumber: string;
      businessDay: string;
      branchId: string;
      terminalId: string | null;
      orderType: string;
      channel: string;
      state: string;
      completedAt: string;
      currency: string;
      countryPackVersion: string;
    };
    lines: Array<{
      sequence: number;
      menuItemId: string;
      variantId: string;
      itemNameSnapshot: unknown;
      quantity: string;
      unitPrice: string;
      modifiers: Array<{
        modifierId: string;
        nameSnapshot: unknown;
        quantity: number;
        priceDelta: string;
      }>;
      modifierTotal: string;
      lineDiscount: string;
      lineSubtotal: string;
      taxClassId: string;
      taxAmount: string;
      lineTotal: string;
    }>;
    totals: {
      subtotal: string;
      discountTotal: string;
      serviceChargeTotal: string;
      taxTotal: string;
      grandTotal: string;
      paidTotal: string;
      tipTotal: string;
      cashRoundingAdjustment: string;
    };
    taxPresentation: string;
    payments: Array<{
      id: string;
      tender: string;
      currency: string;
      amount: string;
      roundingAdjustment: string;
      tenderedAmount: string | null;
      changeGiven: string | null;
      cardScheme: string | null;
      cardLast4: string | null;
      processedAt: string;
    }>;
  }

  // ==================================================================== A
  it('A. completed CASH order -> receipt', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`A-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    const completed = await completeWithCash(
      order.id,
      order.businessDay,
      fresh.grandTotal,
    );

    const res = await httpReceipt(tokenA, completed.businessDay, completed.id);
    expect(res.status).toBe(200);
    const body = res.body as ReceiptBody;

    expect(body.documentType).toBe('INTERNAL_NON_FISCAL_RECEIPT');
    expect(body.fiscal).toBe(false);
    expect(body.disclosureKey).toBe('receipt.internal.nonFiscal');
    expect(body.order.id).toBe(order.id);
    expect(body.order.state).toBe('completed');
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].tender).toBe('cash');
    expect(body.payments[0].tenderedAmount).not.toBeNull();
    expect(body.payments[0].changeGiven).not.toBeNull();
    expect(body.payments[0].cardScheme).toBeNull();
    expect(body.payments[0].cardLast4).toBeNull();
    // no application/json response should ever carry these merchant/internal fields
    expect(res.body).not.toHaveProperty('generatedAt');
    expect(
      (body.payments[0] as unknown as Record<string, unknown>)
        .authorizationCode,
    ).toBeUndefined();
    expect(
      (body.payments[0] as unknown as Record<string, unknown>)
        .paymentTerminalTxnRef,
    ).toBeUndefined();
    expect(
      (body.payments[0] as unknown as Record<string, unknown>).cashSessionId,
    ).toBeUndefined();
  });

  // ==================================================================== B
  it('B. completed MANUAL_EXTERNAL_CARD order -> receipt', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`B-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });

    const res1 = await payNow(order, {
      tender: 'manual_external_card',
      amountMinor: fresh.grandTotal.toString(),
      cashSessionId: cashSessionA,
      terminalReference: `EXT-${newId()}`,
      cardScheme: 'visa',
      last4: '4242',
      authorizationCode: 'AUTH123',
    });
    expect(res1.status).toBe(201);

    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(res.status).toBe(200);
    const body = res.body as ReceiptBody;
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].tender).toBe('manual_external_card');
    expect(body.payments[0].tenderedAmount).toBeNull();
    expect(body.payments[0].changeGiven).toBeNull();
    expect(body.payments[0].cardScheme).toBe('visa');
    expect(body.payments[0].cardLast4).toBe('4242');
    expect(
      (body.payments[0] as unknown as Record<string, unknown>)
        .authorizationCode,
    ).toBeUndefined();
    expect(
      (body.payments[0] as unknown as Record<string, unknown>)
        .paymentTerminalTxnRef,
    ).toBeUndefined();
  });

  // ==================================================================== C
  it('C. split tender (partial cash -> settling card) -> receipt lists both payments', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`C-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    const partial = fresh.grandTotal / 2n;
    const remainder = fresh.grandTotal - partial;

    const first = await payNow(order, {
      tender: 'cash',
      amountMinor: partial.toString(),
      tenderedAmountMinor: partial.toString(),
      cashSessionId: cashSessionA,
    });
    expect(first.status).toBe(201);
    expect((first.body as { order: { state: string } }).order.state).toBe(
      'partially_paid',
    );

    const second = await payNow(order, {
      tender: 'manual_external_card',
      amountMinor: remainder.toString(),
      cashSessionId: cashSessionA,
      terminalReference: `EXT-${newId()}`,
    });
    expect(second.status).toBe(201);
    expect((second.body as { order: { state: string } }).order.state).toBe(
      'completed',
    );

    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(res.status).toBe(200);
    const body = res.body as ReceiptBody;
    expect(body.payments).toHaveLength(2);
    const total = body.payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
    expect(total.toString()).toBe(body.totals.paidTotal);
    expect(body.totals.paidTotal).toBe(fresh.grandTotal.toString());
  });

  // ==================================================================== D
  it('D. modifiers represented correctly', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`D-${newId()}`);
    const modifierId = await mkModifier(
      item.itemId,
      'Extra Garlic Sauce',
      200n,
    );
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId, [
      modifierId,
    ]);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(res.status).toBe(200);
    const body = res.body as ReceiptBody;
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].modifiers).toHaveLength(1);
    expect(body.lines[0].modifiers[0].modifierId).toBe(modifierId);
    expect(body.lines[0].modifiers[0].priceDelta).toBe('200');
    expect(body.lines[0].modifiers[0].nameSnapshot).toEqual({
      en: 'Extra Garlic Sauce',
    });
    expect(body.lines[0].modifierTotal).toBe('200');
  });

  // ==================================================================== E
  it('E. exact totals/tax invariant: sum of lines equals order totals as exact BigInt', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`E-${newId()}`);
    const modifierId = await mkModifier(item.itemId, 'Add-on', 300n);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId, [
      modifierId,
    ]);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    const body = res.body as ReceiptBody;

    const sumSubtotal = body.lines.reduce(
      (s, l) => s + BigInt(l.lineSubtotal),
      0n,
    );
    const sumTax = body.lines.reduce((s, l) => s + BigInt(l.taxAmount), 0n);
    const sumTotal = body.lines.reduce((s, l) => s + BigInt(l.lineTotal), 0n);

    expect(sumSubtotal.toString()).toBe(body.totals.subtotal);
    expect(sumTax.toString()).toBe(body.totals.taxTotal);
    expect(sumTotal.toString()).toBe(body.totals.grandTotal);
    expect(['INCLUSIVE', 'EXCLUSIVE', 'NOT_APPLICABLE']).toContain(
      body.taxPresentation,
    );
    // pack is tax_exclusive with a non-zero rate -> EXCLUSIVE specifically
    expect(body.taxPresentation).toBe('EXCLUSIVE');
  });

  // ==================================================================== F
  it('F. reports a truthful zero discount, never invented', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`F-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    const body = res.body as ReceiptBody;
    expect(body.totals.discountTotal).toBe('0');
    expect(body.totals.serviceChargeTotal).toBe('0');
    expect(body.totals.tipTotal).toBe('0');
    for (const line of body.lines) {
      expect(line.lineDiscount).toBe('0');
    }
  });

  // ==================================================================== G
  it('G. historical stability: renaming item/variant/modifier after completion does not alter the receipt', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`G-Original-${newId()}`);
    const modifierId = await mkModifier(
      item.itemId,
      'Original Modifier Name',
      150n,
    );
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId, [
      modifierId,
    ]);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const before = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(before.status).toBe(200);
    const beforeBody = before.body as ReceiptBody;

    // Rename the MenuItem, the Variant, AND the Modifier.
    await admin.menuItem.update({
      where: { id: item.itemId },
      data: { names: { en: 'RENAMED ITEM' } },
    });
    await admin.menuItemVariant.update({
      where: { id: item.variantId },
      data: { name: { en: 'RENAMED VARIANT' } },
    });
    await admin.modifier.update({
      where: { id: modifierId },
      data: { name: { en: 'RENAMED MODIFIER' } },
    });

    const after = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(after.status).toBe(200);
    const afterBody = after.body as ReceiptBody;

    expect(afterBody.lines[0].itemNameSnapshot).toEqual(
      beforeBody.lines[0].itemNameSnapshot,
    );
    expect(afterBody.lines[0].modifiers[0].nameSnapshot).toEqual(
      beforeBody.lines[0].modifiers[0].nameSnapshot,
    );
    // Sanity: prove the rename actually happened in Catalogue, so a "no
    // change" result is truly stability, not a fixture that never renamed.
    const renamedItem = await admin.menuItem.findUniqueOrThrow({
      where: { id: item.itemId },
    });
    expect(renamedItem.names).toEqual({ en: 'RENAMED ITEM' });
  });

  // ==================================================================== H
  it('H. repeated GET on unchanged data returns a strictly deep-equal body', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`H-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const first = await httpReceipt(tokenA, order.businessDay, order.id);
    const second = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  // ==================================================================== I
  it('I. an open order is rejected with 422', async () => {
    const order = await mkOpenOrder();
    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toBe(
      'ReceiptNotAvailableError',
    );
  });

  // ==================================================================== J
  it('J. a partially_paid order is rejected with 422', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`J-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    const partial = fresh.grandTotal / 2n;
    const payRes = await payNow(order, {
      tender: 'cash',
      amountMinor: partial.toString(),
      tenderedAmountMinor: partial.toString(),
      cashSessionId: cashSessionA,
    });
    expect((payRes.body as { order: { state: string } }).order.state).toBe(
      'partially_paid',
    );

    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(res.status).toBe(422);
  });

  // ==================================================================== K
  it('K. a cancelled order is rejected with 422', async () => {
    const order = await mkDraftOrder();
    await orders.transition(
      tenantA,
      userA,
      order.id,
      order.businessDay,
      'cancelled',
      order.version,
    );
    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(res.status).toBe(422);
  });

  // ==================================================================== L
  it('L. a different tenant cannot read the receipt (404, never 403)', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`L-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const res = await httpReceipt(tokenB, order.businessDay, order.id);
    expect(res.status).toBe(404);
  });

  // ==================================================================== M
  it('M. unauthenticated is 401; authenticated without pos.order.create is 403', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`M-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const noToken = await httpReceipt(null, order.businessDay, order.id);
    expect(noToken.status).toBe(401);

    const noPerm = await httpReceipt(tokenNoPerm, order.businessDay, order.id);
    expect(noPerm.status).toBe(403);
  });

  // ==================================================================== N
  it('N. wrong businessDay/unknown id -> 404; malformed date -> 400', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`N-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const wrongDay = new Date(
      order.businessDay.getTime() + 24 * 60 * 60 * 1000,
    );
    const wrongDayRes = await httpReceipt(tokenA, wrongDay, order.id);
    expect(wrongDayRes.status).toBe(404);

    const unknownRes = await httpReceipt(tokenA, order.businessDay, newId());
    expect(unknownRes.status).toBe(404);

    const malformed = await request(http)
      .get(`/orders/2026-02-31/${order.id}/receipt`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(malformed.status).toBe(400);
  });

  // ==================================================================== O
  it('O. response is application/json and matches the OpenAPI-documented shape (fields present)', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`O-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const res = await httpReceipt(tokenA, order.businessDay, order.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.body as ReceiptBody;
    for (const key of [
      'documentType',
      'fiscal',
      'disclosureKey',
      'order',
      'lines',
      'totals',
      'taxPresentation',
      'payments',
    ]) {
      expect(body).toHaveProperty(key);
    }
    // The full contract-level schema check (concrete types, no schema:{},
    // route-surface exclusivity) is covered globally in
    // `openapi.e2e-spec.ts`, which automatically covers this route.
  });

  // ==================================================================== P
  it('P. no DB mutation occurs on GET (order row + audit_entries unchanged across 3 GETs)', async () => {
    const order = await mkOpenOrder();
    const item = await mkSellable(`P-${newId()}`);
    await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
    const fresh = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    await completeWithCash(order.id, order.businessDay, fresh.grandTotal);

    const before = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    const auditCountBefore = await admin.auditEntry.count({
      where: { tenantId: tenantA },
    });

    for (let i = 0; i < 3; i++) {
      const res = await httpReceipt(tokenA, order.businessDay, order.id);
      expect(res.status).toBe(200);
    }

    const after = await admin.order.findFirstOrThrow({
      where: { id: order.id },
    });
    const auditCountAfter = await admin.auditEntry.count({
      where: { tenantId: tenantA },
    });

    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(auditCountAfter).toBe(auditCountBefore);
  });
});
