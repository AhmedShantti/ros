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
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
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
  TREASURY_PERMISSION_DEFS,
  TREASURY_PERMISSIONS,
} from './../src/modules/treasury/treasury.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * P2E — real service-charge computation, end to end: pinned-policy-only
 * resolution, deterministic rule matching, exact-decimal/pinned-pack
 * rounding, order-totals integration, payment-balance integration, and the
 * historical-pin proof required to close `FR-PLT-028`.
 *
 * Every order in this file uses REAL wall-clock time (`at` omitted, or
 * captured directly via `new Date()` in the TEST PROCESS) — never a fixed
 * historical constant — precisely to avoid the class of bug the P2D e2e
 * suite had to debug at length: a fictional past `at` conflicting with a
 * ServiceChargePolicy row's real `statement_timestamp()`-defaulted
 * `effectiveFrom`. Each rule-matching scenario gets its own fresh
 * brand/branch/terminal/employee (`mkScope`) so ServiceChargePolicy rows
 * created for one scenario never leak into another — the same isolation
 * discipline `service-charge-policy.e2e-spec.ts` already established.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const shortStamp = stamp.toString().slice(-6);
const PACK_VERSION = '2026.1';

const RELEASE_KEY = generateReleaseKey(`e2e-scp-compute-release-${stamp}`);
const TRUST = trustStoreFor(RELEASE_KEY.trusted());
const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);

/** `serviceChargeTaxable: true` DELIBERATELY — proves P2E never taxes the
 * service charge even when the pack says it should be taxable (the
 * documented FR-POS-058 blocker: no Country Pack field names which tax
 * class/rate would apply). */
const packPayload = (roundingMode: string) => ({
  code: 'EG',
  version: PACK_VERSION,
  effectiveFrom: '2026-01-01',
  currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
  tax: {
    engine: 'vat_standard',
    pricingMode: 'tax_exclusive',
    computationLevel: 'line',
    roundingMode,
    roundingPrecision: 2,
    classes: [{ code: 'standard', rate: '14.0', label: { en: 'Standard' } }],
    serviceChargeTaxable: true,
    orderTypeOverrides: [],
  },
});

// A second, synthetic jurisdiction whose ONLY purpose is proving
// "rounding follows the PINNED Country Pack" at the integration level with
// a rounding mode genuinely different from EG's HALF_UP — never touching
// the main EG fixture used by every other test in this file. Signed with
// the SAME release key the app's trust store is overridden to accept
// (there is only one trust store per running app).
const halfDownPackPayload = () => ({
  code: 'ZZ',
  version: PACK_VERSION,
  effectiveFrom: '2026-01-01',
  currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
  tax: {
    engine: 'vat_standard',
    pricingMode: 'tax_exclusive',
    computationLevel: 'line',
    roundingMode: 'HALF_DOWN',
    roundingPrecision: 2,
    classes: [{ code: 'standard', rate: '14.0', label: { en: 'Standard' } }],
    serviceChargeTaxable: false,
    orderTypeOverrides: [],
  },
});

describe('ServiceChargePolicy computation (e2e) — P2E', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;

  let tenantA: string;
  let ownerUserId: string;
  /** A SEPARATE login user, reserved for the one scenario that needs a
   * real PIN-authenticated HTTP session — `ownerUserId` cannot double as
   * an employee's linked user across more than one `mkScope()` call. */
  let cashierUserId: string;
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

    await packs.activate(signPackDocument(packPayload('HALF_UP'), RELEASE_KEY));

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const permissions = app.get(PermissionsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    tenantA = (
      await tenants.create({
        slug: `scpe-${stamp}`,
        legalName: 'SCPE',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);

    const role = await roles.createTenantRole(tenantA, {
      name: `scpe_role_${stamp}`,
    });
    await roles.addPermissions(tenantA, role.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.PAYMENT_CAPTURE,
      TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    ]);

    const u = await users.createUser({
      email: `scpe.owner.${stamp}@example.com`,
      password,
      displayName: 'SCPE Owner',
    });
    ownerUserId = u.id;
    const m = await memberships.grant(u.id, tenantA, 'active');
    await membershipRoles.create(tenantA, null, {
      membershipId: m.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });

    const cashierUser = await users.createUser({
      email: `scpe.cashier.${stamp}@example.com`,
      password,
      displayName: 'SCPE Cashier',
    });
    cashierUserId = cashierUser.id;
    const cm = await memberships.grant(cashierUserId, tenantA, 'active');
    await membershipRoles.create(tenantA, null, {
      membershipId: cm.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });

    taxClassStandard = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;

    const priceList = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: `SCPE Base ${stamp}`,
        scopeType: 'tenant',
        scopeId: tenantA,
        status: 'active',
        priority: 0,
      },
    });
    priceListId = priceList.id;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  // ------------------------------------------------------------- helpers

  /**
   * A fresh brand/branch/terminal/employee, isolated for one scenario.
   * `linkedUserId`, when given, links the employee to a real login user —
   * required ONLY for a scenario that needs a real PIN-authenticated HTTP
   * session (a `userId` can link to at most one employee, so this is never
   * passed for the many scenarios that only need `OrdersService`/
   * `OrderLinesService` called directly).
   */
  let scopeCounter = 0;
  async function mkScope(linkedUserId?: string): Promise<{
    branchId: string;
    terminalId: string;
    employeeId: string;
    employeeCode: string;
  }> {
    scopeCounter += 1;
    const tag = `${shortStamp}${scopeCounter}`;
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `SCPE Brand ${tag}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `SCE${tag}`,
        name: `SCPE Branch ${tag}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.location.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        locationType: 'branch',
        refId: branch.id,
        branchId: branch.id,
      },
    });
    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branch.id,
        name: `SCE-T-${tag}`,
        terminalType: 'pos',
        status: 'active',
      },
    });
    const employees = app.get(EmployeesService);
    const employeeCode = `SCEE${tag}`;
    const employee = await employees.create(tenantA, ownerUserId, {
      code: employeeCode,
      displayName: `SCPE Employee ${tag}`,
      homeBranchId: branch.id,
      ...(linkedUserId ? { userId: linkedUserId } : {}),
    });
    return {
      branchId: branch.id,
      terminalId: terminal.id,
      employeeId: employee.id,
      employeeCode,
    };
  }

  /** One sellable item, priced at `price` minor units, on the shared price list. */
  async function mkSellable(name: string, price: bigint) {
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
        priceListId,
        menuItemVariantId: variant.id,
        price,
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  }

  /** A branch-level ServiceChargePolicy version, created NOW (real time). */
  async function mkBranchPolicy(
    branchId: string,
    rules: readonly Record<string, unknown>[],
    locked = false,
  ) {
    return admin.serviceChargePolicy.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        level: 'branch',
        targetId: branchId,
        rules: rules as object[],
        locked,
        createdBy: ownerUserId,
      },
    });
  }

  async function mkOrder(
    scope: { branchId: string; terminalId: string; employeeId: string },
    opts: { orderType?: string; guestCount?: number | null; at?: Date } = {},
  ) {
    return orders.create(tenantA, ownerUserId, {
      terminalId: scope.terminalId,
      openedByEmployeeId: scope.employeeId,
      orderType: opts.orderType ?? 'dine_in',
      channel: 'pos',
      guestCount: opts.guestCount ?? null,
      originDeviceTime: opts.at ?? new Date(),
      idempotencyKey: `scpe-order-${newId()}`,
      ...(opts.at ? { at: opts.at } : {}),
    });
  }

  async function addLine(
    order: { id: string; businessDay: Date; version: number },
    item: { itemId: string; variantId: string },
    quantity = '1',
  ) {
    return lines.addLine(tenantA, ownerUserId, order.id, order.businessDay, {
      menuItemId: item.itemId,
      variantId: item.variantId,
      quantity,
      expectedVersion: order.version,
    });
  }

  // ======================================================== 1: no pin => 0
  it('1. no pinned policy anywhere => serviceChargeTotal 0', async () => {
    const scope = await mkScope();
    const item = await mkSellable(`Item1-${newId()}`, 10_000n);
    const order = await mkOrder(scope);
    expect(order.serviceChargePolicyVersionId).toBeNull();
    const { order: after } = await addLine(order, item);
    expect(after.serviceChargeTotal).toBe(0n);
  });

  // =========================================================== 2: rules []
  it('2. rules: [] => serviceChargeTotal 0, even though a version IS pinned', async () => {
    const scope = await mkScope();
    const policy = await mkBranchPolicy(scope.branchId, []);
    const item = await mkSellable(`Item2-${newId()}`, 10_000n);
    const order = await mkOrder(scope);
    expect(order.serviceChargePolicyVersionId).toBe(policy.id);
    const { order: after } = await addLine(order, item);
    expect(after.serviceChargeTotal).toBe(0n);
  });

  // ============================================ 3/4: orderType match/no-match
  it('3. a matching orderType rule => a non-zero charge', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: 'dine_in', minGuestCount: null, ratePercent: '10' },
    ]);
    const item = await mkSellable(`Item3-${newId()}`, 10_000n);
    const order = await mkOrder(scope, { orderType: 'dine_in' });
    const { order: after } = await addLine(order, item);
    // 10% of 10000 = 1000.
    expect(after.serviceChargeTotal).toBe(1_000n);
  });

  it('4. a non-matching orderType => 0', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: 'dine_in', minGuestCount: null, ratePercent: '10' },
    ]);
    const item = await mkSellable(`Item4-${newId()}`, 10_000n);
    const order = await mkOrder(scope, { orderType: 'takeaway' });
    const { order: after } = await addLine(order, item);
    expect(after.serviceChargeTotal).toBe(0n);
  });

  // ======================================== 5/6/7: minGuestCount threshold
  it('5. minGuestCount satisfied => a charge', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: 6, ratePercent: '12' },
    ]);
    const item = await mkSellable(`Item5-${newId()}`, 10_000n);
    const order = await mkOrder(scope, { guestCount: 6 });
    const { order: after } = await addLine(order, item);
    expect(after.serviceChargeTotal).toBe(1_200n);
  });

  it('6. minGuestCount not satisfied => 0', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: 6, ratePercent: '12' },
    ]);
    const item = await mkSellable(`Item6-${newId()}`, 10_000n);
    const order = await mkOrder(scope, { guestCount: 5 });
    const { order: after } = await addLine(order, item);
    expect(after.serviceChargeTotal).toBe(0n);
  });

  it('7. guestCount null does not satisfy a positive minimum => 0', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: 6, ratePercent: '12' },
    ]);
    const item = await mkSellable(`Item7-${newId()}`, 10_000n);
    const order = await mkOrder(scope, { guestCount: null });
    const { order: after } = await addLine(order, item);
    expect(after.serviceChargeTotal).toBe(0n);
  });

  // ================================================== 8: wildcard behavior
  it('8. a wildcard rule (orderType: null, minGuestCount: null) applies to any order', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: null, ratePercent: '7' },
    ]);
    const item = await mkSellable(`Item8-${newId()}`, 10_000n);
    const order = await mkOrder(scope, {
      orderType: 'aggregator',
      guestCount: null,
    });
    const { order: after } = await addLine(order, item);
    expect(after.serviceChargeTotal).toBe(700n);
  });

  // =================================================== 9: exact decimal
  it('9. an exact-decimal rate computes an exact, non-trivial result', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: null, ratePercent: '12.5' },
    ]);
    const item = await mkSellable(`Item9-${newId()}`, 9_999n); // 99.99 EGP
    const order = await mkOrder(scope);
    const { order: after } = await addLine(order, item);
    // 9999 * 12.5% = 1249.875 -> HALF_UP -> 1250.
    expect(after.serviceChargeTotal).toBe(1_250n);
  });

  // ========================================= 10: pinned-pack rounding mode
  it('10. rounding follows the PINNED Country Pack, not a hardcoded default', async () => {
    await packs.activate(signPackDocument(halfDownPackPayload(), RELEASE_KEY));

    // A dedicated tenant/branch under the synthetic ZZ (HALF_DOWN) pack —
    // entirely isolated from every other test in this file.
    const zzTenant = (
      await app.get(TenantsService).create({
        slug: `scpe-zz-${stamp}`,
        legalName: 'SCPE-ZZ',
        defaultCurrency: 'EGP',
        countryPackCode: 'ZZ',
      })
    ).id;
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: zzTenant, name: 'SCPE ZZ Brand' },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        brandId: brand.id,
        code: `ZZ${shortStamp}`,
        name: 'SCPE ZZ Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'ZZ',
      },
    });
    await admin.location.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        locationType: 'branch',
        refId: branch.id,
        branchId: branch.id,
      },
    });
    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        branchId: branch.id,
        name: 'ZZ-T',
        terminalType: 'pos',
        status: 'active',
      },
    });
    const employee = await app
      .get(EmployeesService)
      .create(zzTenant, ownerUserId, {
        code: 'ZZE',
        displayName: 'ZZ Employee',
        homeBranchId: branch.id,
      });
    const zzTaxClass = await admin.taxClass.findFirstOrThrow({
      where: { tenantId: zzTenant, countryPackCode: 'ZZ', code: 'standard' },
    });
    const zzPriceList = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        name: 'ZZ price list',
        scopeType: 'tenant',
        scopeId: zzTenant,
        status: 'active',
        priority: 0,
      },
    });
    const item = await admin.menuItem.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        names: { en: 'ZZ item' },
        taxClassId: zzTaxClass.id,
      },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        menuItemId: item.id,
        name: { en: 'V' },
      },
    });
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        priceListId: zzPriceList.id,
        menuItemVariantId: variant.id,
        price: 1n, // EGP 0.01
        currency: 'EGP',
      },
    });
    await admin.serviceChargePolicy.create({
      data: {
        id: newId(),
        tenantId: zzTenant,
        level: 'branch',
        targetId: branch.id,
        rules: [{ orderType: null, minGuestCount: null, ratePercent: '50' }],
        locked: false,
        createdBy: ownerUserId,
      },
    });

    const order = await orders.create(zzTenant, ownerUserId, {
      terminalId: terminal.id,
      openedByEmployeeId: employee.id,
      orderType: 'dine_in',
      channel: 'pos',
      originDeviceTime: new Date(),
      idempotencyKey: `scpe-order-zz-${newId()}`,
    });
    const { order: after } = await lines.addLine(
      zzTenant,
      ownerUserId,
      order.id,
      order.businessDay,
      {
        menuItemId: item.id,
        variantId: variant.id,
        quantity: '1',
        expectedVersion: order.version,
      },
    );
    // 1 minor unit * 50% = 0.5 -> HALF_DOWN (toward zero) -> 0.
    expect(after.serviceChargeTotal).toBe(0n);
  });

  // ==================================================== 11: recalculation
  it('11. recalculation after a line mutation updates the charge correctly', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: null, ratePercent: '10' },
    ]);
    const item = await mkSellable(`Item11-${newId()}`, 10_000n);
    const order = await mkOrder(scope);
    let result = await addLine(order, item);
    expect(result.order.serviceChargeTotal).toBe(1_000n); // 10% of 10000

    result = await addLine({ ...order, version: result.order.version }, item);
    // subtotal now 20000 -> 10% = 2000.
    expect(result.order.serviceChargeTotal).toBe(2_000n);
    void order;
  });

  // ============================================= 12: discount interaction
  it('12. an order-level discount does NOT reduce the service-charge base (independent terms, per the discount precedent)', async () => {
    const scope = await mkScope();
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: null, ratePercent: '10' },
    ]);
    const item = await mkSellable(`Item12-${newId()}`, 10_000n);
    const order = await mkOrder(scope);
    const first = await addLine(order, item);
    expect(first.order.serviceChargeTotal).toBe(1_000n);
    expect(first.order.grandTotal).toBe(
      first.order.subtotal +
        first.order.taxTotal +
        first.order.serviceChargeTotal,
    );

    // A 2000-minor-unit order-level discount, inserted directly (bypassing
    // DiscountsService's own approval-workflow machinery, which is out of
    // this task's scope — `order-totals.ts`'s independent-term behavior is
    // what is under test here, not discount authorization).
    const reasonCode = await admin.reasonCode.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        category: 'adjustment',
        code: `SCED${newId().slice(0, 8)}`,
        label: { en: 'Test discount' },
      },
    });
    await admin.discount.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: scope.branchId,
        orderId: order.id,
        businessDay: order.businessDay,
        orderLineId: null,
        kind: 'discount',
        valueType: 'fixed',
        fixedValueMinor: 2_000n,
        amountMinor: 2_000n,
        reasonCodeId: reasonCode.id,
        appliedByEmployeeId: scope.employeeId,
        appliedByUserId: ownerUserId,
        approvalRequired: false,
        orderVersionAfter: first.order.version,
      },
    });

    // Any recompute-triggering mutation picks the discount up fresh.
    const second = await addLine(
      { ...order, version: first.order.version },
      item,
    );
    // subtotal now 20000 -> service charge 10% = 2000, UNCHANGED shape —
    // still purely a function of subtotal, never of discountTotal.
    expect(second.order.serviceChargeTotal).toBe(2_000n);
    expect(second.order.discountTotal).toBe(2_000n);
    // grandTotal reflects BOTH independent terms together, exactly once.
    expect(second.order.grandTotal).toBe(
      second.order.subtotal +
        second.order.taxTotal +
        second.order.serviceChargeTotal -
        second.order.discountTotal,
    );
  });

  // ======================================== 13/14: grandTotal + payment
  it('13/14. grandTotal includes the service charge exactly once, and payment settles against the true grandTotal', async () => {
    const scope = await mkScope(cashierUserId);
    await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: null, ratePercent: '10' },
    ]);
    const item = await mkSellable(`Item1314-${newId()}`, 10_000n);
    let order = await mkOrder(scope);
    order = await orders.transition(
      tenantA,
      ownerUserId,
      order.id,
      order.businessDay,
      'open',
      order.version,
    );
    const added = await addLine(
      { id: order.id, businessDay: order.businessDay, version: order.version },
      item,
    );
    const fresh = added.order;
    // subtotal 10000, tax 14% = 1400, service charge 10% = 1000.
    expect(fresh.subtotal).toBe(10_000n);
    expect(fresh.taxTotal).toBe(1_400n);
    expect(fresh.serviceChargeTotal).toBe(1_000n);
    expect(fresh.grandTotal).toBe(12_400n);
    expect(fresh.grandTotal).toBe(
      fresh.subtotal +
        fresh.taxTotal +
        fresh.serviceChargeTotal -
        fresh.discountTotal,
    );

    // Treasury fixtures for a real HTTP payment capture.
    const drawer = await admin.drawer.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: scope.branchId,
        name: 'D',
        terminalId: scope.terminalId,
      },
    });
    const shift = await admin.shift.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: scope.branchId,
        employeeId: scope.employeeId,
        status: 'open',
        openedAt: new Date(),
      },
    });
    const cashSession = await admin.cashSession.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: scope.branchId,
        drawerId: drawer.id,
        shiftId: shift.id,
        employeeId: scope.employeeId,
        openingFloat: 50_000n,
        currency: 'EGP',
        status: 'open',
        openedAt: new Date(),
      },
    });

    // Payment capture requires a terminal-bound POS session
    // (`OrdersController.requirePosIdentity`) — a plain email/password
    // session carries no `terminalId`/`employeeId`, so this MUST be a PIN
    // login, not `/auth/login` + `/auth/tenant`.
    const pin = '5150';
    await app
      .get(PinService)
      .setPin(tenantA, ownerUserId, scope.employeeId, pin);
    const pinLogin = await request(http)
      .post('/auth/pin')
      .send({
        tenantId: tenantA,
        terminalId: scope.terminalId,
        employeeCode: scope.employeeCode,
        pin,
      })
      .expect(200);
    const token = (pinLogin.body as { accessToken: string }).accessToken;

    // Paying LESS than the true grandTotal (i.e. what it would have been
    // WITHOUT the service charge) must NOT settle the order.
    const short = await request(http)
      .post(
        `/orders/${order.businessDay.toISOString().slice(0, 10)}/${order.id}/payments`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `scpe-pay-short-${newId()}`)
      .set('If-Match', `W/"${order.id}.${fresh.version}"`)
      .send({
        tender: 'cash',
        amountMinor: '11400', // subtotal + tax, service charge omitted
        tenderedAmountMinor: '11400',
        cashSessionId: cashSession.id,
      });
    expect(short.status).toBe(201);
    expect((short.body as { order: { state: string } }).order.state).toBe(
      'partially_paid',
    );

    const versionAfterShort = (short.body as { order: { version: number } })
      .order.version;
    const full = await request(http)
      .post(
        `/orders/${order.businessDay.toISOString().slice(0, 10)}/${order.id}/payments`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `scpe-pay-full-${newId()}`)
      .set('If-Match', `W/"${order.id}.${versionAfterShort}"`)
      .send({
        tender: 'cash',
        amountMinor: '1000', // the remaining service-charge amount
        tenderedAmountMinor: '1000',
        cashSessionId: cashSession.id,
      });
    expect(full.status).toBe(201);
    expect((full.body as { order: { state: string } }).order.state).toBe(
      'completed',
    );
  });

  // ========================================== 15/16: historical V1 proof
  it('15/16. a historical order keeps its V1-derived amount and pin after a newer V2 is created (FR-PLT-028)', async () => {
    const scope = await mkScope();
    const v1 = await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: null, ratePercent: '10' },
    ]);
    // Captured by the TEST PROCESS, strictly after v1's INSERT committed —
    // never reconstructed from v1's own JSON-round-tripped `effectiveFrom`.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const t1 = new Date();

    const item = await mkSellable(`Item1516-${newId()}`, 10_000n);
    const order = await mkOrder(scope, { at: t1 });
    expect(order.serviceChargePolicyVersionId).toBe(v1.id);
    const first = await addLine(order, item);
    expect(first.order.serviceChargeTotal).toBe(1_000n); // 10% of 10000
    const pinnedId = first.order.serviceChargePolicyVersionId;
    expect(pinnedId).toBe(v1.id);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const v2 = await mkBranchPolicy(scope.branchId, [
      { orderType: null, minGuestCount: null, ratePercent: '99' },
    ]);
    void v2;

    // A SECOND line mutation on the SAME (historical) order — the pin and
    // the computed amount must be UNCHANGED: no current ServiceChargePolicy
    // lookup may affect an already-open order pinned in the past.
    const second = await addLine(
      { ...order, version: first.order.version },
      item,
    );
    expect(second.order.serviceChargePolicyVersionId).toBe(pinnedId);
    expect(second.order.serviceChargePolicyVersionId).not.toBe(v2.id);
    // subtotal now 20000 -> STILL v1's 10%, never v2's 99%.
    expect(second.order.serviceChargeTotal).toBe(2_000n);

    // `serviceChargePolicyVersionId` itself never changes across recomputes.
    expect(second.order.serviceChargePolicyVersionId).toBe(
      first.order.serviceChargePolicyVersionId,
    );

    // A brand-new order opened NOW (after v2) at the SAME scope picks up v2.
    const newOrder = await mkOrder(scope);
    expect(newOrder.serviceChargePolicyVersionId).toBe(v2.id);
  });
});
