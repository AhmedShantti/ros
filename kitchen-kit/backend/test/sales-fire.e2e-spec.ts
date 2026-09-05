import {
  Injectable,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DomainEventHandler } from './../src/common/domain-events/domain-event-handler.decorator';
import { UnitOfWorkContext } from './../src/common/domain-events/unit-of-work-context';
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
import { TABLE_DISPLAY_QUERY } from './../src/modules/organisation/contract';
import type {
  TableDisplayQuery,
  TableDisplayQueryInput,
  TableDisplayResult,
} from './../src/modules/organisation/contract';
import { ORDER_OPENED_EVENT_TYPE } from './../src/modules/sales/contract';
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
 * P1E-6 — Sales Fire command, end to end through the real HTTP route, real
 * PostgreSQL, real authorization, real transactional Kitchen consequences.
 *
 * Setup mirrors `sales.e2e-spec.ts`/`sales-lines.e2e-spec.ts`/
 * `routing-config-contract.e2e-spec.ts` exactly (signed test country pack,
 * tenant/branch/terminal/employee/PIN bootstrap, raw-Prisma catalogue/routing
 * fixtures) — nothing new is invented here, only composed for Fire.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const AT = new Date('2026-08-20T09:00:00.000Z');
const PACK = '2026.1';

const RELEASE_KEY = generateReleaseKey('e2e-fire-release-key');
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
const testPackDocument = () => signPackDocument(packPayload(), RELEASE_KEY);

// ── test-only order.opened recorder — proves publication count/content ──
@Injectable()
class OpenedRecorder {
  readonly events: Array<{ payload: unknown; correlationId: string }> = [];
  record(payload: unknown, correlationId: string): void {
    this.events.push({ payload, correlationId });
  }
}
@Injectable()
@DomainEventHandler(ORDER_OPENED_EVENT_TYPE)
class OpenedRecorderHandler {
  constructor(private readonly recorder: OpenedRecorder) {}
  handle(
    event: { payload: unknown; correlationId: string },
    _ctx: UnitOfWorkContext,
  ): Promise<void> {
    void _ctx;
    this.recorder.record(event.payload, event.correlationId);
    return Promise.resolve();
  }
}
@Module({ providers: [OpenedRecorder, OpenedRecorderHandler] })
class OpenedRecorderModule {}

/**
 * P1E-6A Defect C test seam: `sales.orders.table_id` carries a real DB FK
 * (`orders_branch_id_table_id_fkey`, `ON DELETE RESTRICT`) to `org.tables`,
 * so a genuinely dangling or cross-branch `tableId` can never actually be
 * attached to an order through any path — the FK forbids it categorically,
 * for the order's entire lifetime. The fail-closed guard this defect adds is
 * therefore defense-in-depth (e.g. against a future RLS misconfiguration),
 * not something the current schema can produce naturally. This stub proves
 * the SERVICE's own handling of an "unresolvable" result deterministically:
 * it delegates to the real one-line lookup for every id EXCEPT ids a test
 * has opted into `simulateUnresolvedTableIds`, which it reports as
 * unresolved regardless of whether a real (FK-satisfying) row exists for
 * them. A fresh id per test (never a fixed constant) keeps repeated runs
 * against the same persistent database collision-free.
 */
const simulateUnresolvedTableIds = new Set<string>();
class SentinelAwareTableDisplayQuery implements TableDisplayQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: TableDisplayQueryInput,
  ): Promise<TableDisplayResult | null> {
    if (simulateUnresolvedTableIds.has(input.tableId)) return null;
    return tx.branchTable.findUnique({
      where: { id: input.tableId },
      select: { label: true },
    });
  }
}

describe('Sales Fire (P1E-6 e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let packs: CountryPackService;
  let opened: OpenedRecorder;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let branchC: string; // no fallback configured — for the no-destination proof
  let terminalA: string;
  let terminalC: string;
  let terminalB: string;
  let employeeA: string; // has pos.order.fire
  let employeeNoFire: string; // has pos.order.create only
  let userA: string;
  let userNoFire: string;
  let userB: string;
  let employeeACode: string;
  let employeeNoFireCode: string;
  let employeeBCode: string;
  let employeeB: string;
  let tableId: string;

  // Catalogue
  let taxClassStandard: string;
  let stationOverride: string;
  let stationModifier: string;
  let stationMenuItem: string;
  let stationCategory: string;
  let stationFallback: string;
  let stationMultiA: string;
  let stationMultiB: string;
  let modifierWithKind: string;
  let modifierGroupId: string;
  let categoryTier4: string;
  let categoryConflictA: string;
  let categoryConflictB: string;

  const priceListFor = async (branchId: string) => {
    const list = await admin.priceList.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        name: `Fire pricing ${branchId}`,
        scopeType: 'branch',
        scopeId: branchId,
        status: 'active',
      },
    });
    return list.id;
  };
  let priceListA: string;
  let priceListC: string;

  /** A minimal sellable item + variant + price, optionally placed in a category. */
  const mkSellable = async (
    name: string,
    opts: { categoryId?: string; priceListId?: string } = {},
  ) => {
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
        priceListId: opts.priceListId ?? priceListA,
        menuItemVariantId: variant.id,
        price: 1000n,
        currency: 'EGP',
      },
    });
    if (opts.categoryId) {
      await admin.menuItemPlacement.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId: item.id,
          categoryId: opts.categoryId,
        },
      });
    }
    return { itemId: item.id, variantId: variant.id };
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, OpenedRecorderModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
      .overrideProvider(TABLE_DISPLAY_QUERY)
      .useClass(SentinelAwareTableDisplayQuery)
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
    opened = app.get(OpenedRecorder);

    await packs.activate(testPackDocument());

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
        slug: `firea-${stamp}`,
        legalName: 'FireA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `fireb-${stamp}`,
        legalName: 'FireB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mkBranch = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `FBrand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `FBranch ${code}`,
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
    branchA = await mkBranch(tenantA, `FA${stamp % 10000}`);
    branchC = await mkBranch(tenantA, `FC${stamp % 10000}`);
    const branchB = await mkBranch(tenantB, `FB${stamp % 10000}`);

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
    terminalA = await mkTerminal(tenantA, branchA, 'FA-POS-1');
    terminalC = await mkTerminal(tenantA, branchC, 'FC-POS-1');
    terminalB = await mkTerminal(tenantB, branchB, 'FB-POS');

    tableId = (
      await admin.branchTable.create({
        data: { id: newId(), branchId: branchA, label: 'T1' },
      })
    ).id;

    // ── permissions / roles ──────────────────────────────────────────────
    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
    for (const def of INVENTORY_PERMISSION_DEFS) await permissions.upsert(def);

    const cashierFull = await roles.createTenantRole(tenantA, {
      name: `fire_cashier_${stamp}`,
    });
    await roles.addPermissions(
      tenantA,
      cashierFull.id,
      SALES_PERMISSION_DEFS.map((d) => d.code),
    );
    const waiterNoCash = await roles.createTenantRole(tenantA, {
      name: `fire_waiter_${stamp}`,
    });
    await roles.addPermissions(tenantA, waiterNoCash.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
      SALES_PERMISSIONS.ORDER_FIRE,
    ]);
    const createOnly = await roles.createTenantRole(tenantA, {
      name: `fire_noauth_${stamp}`,
    });
    await roles.addPermissions(tenantA, createOnly.id, [
      SALES_PERMISSIONS.ORDER_CREATE,
    ]);
    const cashierB = await roles.createTenantRole(tenantB, {
      name: `fire_cashier_b_${stamp}`,
    });
    await roles.addPermissions(
      tenantB,
      cashierB.id,
      SALES_PERMISSION_DEFS.map((d) => d.code),
    );

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({ email, password, displayName: 'F' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      return { userId: u.id, membershipId: m.id };
    };

    const a = await mkUser(`fire.a.${stamp}@example.com`, tenantA);
    userA = a.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: a.membershipId,
      roleId: cashierFull.id,
      scope: { type: 'tenant' },
    });
    // Also grant the Waiter role's permission set to the SAME actor is
    // unnecessary — userA's cashierFull role already carries ORDER_FIRE;
    // waiterNoCash exists to prove point 4 of §20 structurally (below).

    const nf = await mkUser(`fire.noauth.${stamp}@example.com`, tenantA);
    userNoFire = nf.userId;
    await membershipRoles.create(tenantA, null, {
      membershipId: nf.membershipId,
      roleId: createOnly.id,
      scope: { type: 'tenant' },
    });

    const b = await mkUser(`fire.b.${stamp}@example.com`, tenantB);
    userB = b.userId;
    await membershipRoles.create(tenantB, null, {
      membershipId: b.membershipId,
      roleId: cashierB.id,
      scope: { type: 'tenant' },
    });

    employeeACode = `FEA${stamp % 1000}`;
    employeeA = (
      await employees.create(tenantA, userA, {
        code: employeeACode,
        displayName: 'Fire A',
        homeBranchId: branchA,
        userId: userA,
        permittedBranchIds: [branchC],
      })
    ).id;
    employeeNoFireCode = `FEN${stamp % 1000}`;
    employeeNoFire = (
      await employees.create(tenantA, userA, {
        code: employeeNoFireCode,
        displayName: 'Fire NoAuth',
        homeBranchId: branchA,
        userId: userNoFire,
      })
    ).id;
    employeeBCode = `FEB${stamp % 1000}`;
    employeeB = (
      await employees.create(tenantB, userB, {
        code: employeeBCode,
        displayName: 'Fire B',
        homeBranchId: branchB,
        userId: userB,
      })
    ).id;

    await pins.setPin(tenantA, userA, employeeA, '1111');
    await pins.setPin(tenantA, userA, employeeNoFire, '2222');
    await pins.setPin(tenantB, userB, employeeB, '3333');

    // ── catalogue / tax ──────────────────────────────────────────────────
    taxClassStandard = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;
    priceListA = await priceListFor(branchA);
    priceListC = await priceListFor(branchC);

    // ── stations + routing config ───────────────────────────────────────
    const mkStation = (branchId: string, name: string) =>
      admin.station
        .create({ data: { id: newId(), branchId, name } })
        .then((s) => s.id);
    stationOverride = await mkStation(branchA, 'Tier1-Override');
    stationModifier = await mkStation(branchA, 'Tier2-Modifier');
    stationMenuItem = await mkStation(branchA, 'Tier3-MenuItem');
    stationCategory = await mkStation(branchA, 'Tier4-Category');
    stationFallback = await mkStation(branchA, 'Tier5-Fallback');
    stationMultiA = await mkStation(branchA, 'Multi-A');
    stationMultiB = await mkStation(branchA, 'Multi-B');

    await admin.branchKdsConfig.create({
      data: {
        branchId: branchA,
        tenantId: tenantA,
        fallbackStationId: stationFallback,
      },
    });
    // branchC deliberately gets NO BranchKdsConfig row -> no fallback -> no destination.

    modifierGroupId = (
      await admin.modifierGroup.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          name: { en: 'Add-ons' },
          maxSelections: 5,
          allowRepeat: true,
        },
      })
    ).id;
    modifierWithKind = (
      await admin.modifier.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          modifierGroupId,
          name: { en: 'Extra Cheese' },
          kind: 'addition',
        },
      })
    ).id;
    await admin.stationRoutingRule.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        stationId: stationModifier,
        modifierId: modifierWithKind,
      },
    });

    categoryTier4 = (
      await admin.category.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuId: (
            await admin.menu.create({
              data: {
                id: newId(),
                tenantId: tenantA,
                name: { en: 'Fire Menu' },
              },
            })
          ).id,
          name: { en: 'Tier4 Category' },
        },
      })
    ).id;
    await admin.stationRoutingRule.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        stationId: stationCategory,
        categoryId: categoryTier4,
      },
    });

    const conflictMenuId = (
      await admin.menu.create({
        data: { id: newId(), tenantId: tenantA, name: { en: 'Conflict Menu' } },
      })
    ).id;
    categoryConflictA = (
      await admin.category.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuId: conflictMenuId,
          name: { en: 'ConflictA' },
        },
      })
    ).id;
    categoryConflictB = (
      await admin.category.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuId: conflictMenuId,
          name: { en: 'ConflictB' },
        },
      })
    ).id;
    await admin.stationRoutingRule.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        stationId: stationMultiA,
        categoryId: categoryConflictA,
      },
    });
    await admin.stationRoutingRule.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        stationId: stationMultiB,
        categoryId: categoryConflictB,
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  }, 30000);

  // ── helpers ──────────────────────────────────────────────────────────
  const pinLogin = async (
    tenantId: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ) => {
    const res = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode, pin })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const mkOrder = (
    over: Partial<Parameters<OrdersService['create']>[2]> = {},
  ) =>
    orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: new Date(),
      idempotencyKey: `k-${newId()}`,
      at: AT,
      ...over,
    });

  /** Always reads the order's CURRENT version fresh — never hand-tracked. */
  const currentVersion = async (orderId: string): Promise<number> =>
    (
      await admin.order.findFirstOrThrow({
        where: { id: orderId },
        select: { version: true },
      })
    ).version;

  const mkLine = async (
    orderId: string,
    businessDay: Date,
    itemId: string,
    variantId: string,
    over: Record<string, unknown> = {},
  ) => {
    const expectedVersion = await currentVersion(orderId);
    return lines.addLine(tenantA, userA, orderId, businessDay, {
      menuItemId: itemId,
      variantId,
      quantity: '1',
      expectedVersion,
      ...over,
    });
  };

  const etagOf = (id: string, version: number) => `W/"${id}.${version}"`;

  /** Low-level: fire with an EXPLICIT If-Match (used where the test deliberately controls the version). */
  const httpFire = (
    token: string,
    businessDay: Date,
    orderId: string,
    ifMatch: string,
    idempotencyKey = `fire-${newId()}`,
  ) =>
    request(http)
      .post(`/orders/${businessDay.toISOString().slice(0, 10)}/${orderId}/fire`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', ifMatch);

  /** Convenience: fire with the order's CURRENT (freshly read) version. */
  const fireNow = async (
    token: string,
    orderId: string,
    businessDay: Date,
    idempotencyKey = `fire-${newId()}`,
  ) => {
    const version = await currentVersion(orderId);
    // Awaiting supertest's `Test` here (rather than returning it directly)
    // is deliberate: an `async` function that RETURNS a thenable has its
    // own promise flattened to the thenable's resolved value (Promises/A+),
    // so `fireNow(...)` already yields a resolved `Response` — callers use
    // `fireAndExpect` for a one-line status assertion, or `await fireNow(...)`
    // directly when they need the full `Response` (headers/body) without a
    // status assertion.
    return httpFire(
      token,
      businessDay,
      orderId,
      etagOf(orderId, version),
      idempotencyKey,
    );
  };

  /** `fireNow` + a one-line status assertion, returning the resolved `Response`. */
  const fireAndExpect = async (
    token: string,
    orderId: string,
    businessDay: Date,
    status: number,
    idempotencyKey?: string,
  ) => {
    const res = await fireNow(token, orderId, businessDay, idempotencyKey);
    expect(res.status).toBe(status);
    return res;
  };

  // ===================================================== §20 AUTHORIZATION
  describe('authorization / tenancy (§20)', () => {
    it('pos.order.fire exists and is separate from pos.order.create', () => {
      expect(SALES_PERMISSIONS.ORDER_FIRE).toBe('pos.order.fire');
      expect(SALES_PERMISSIONS.ORDER_FIRE).not.toBe(
        SALES_PERMISSIONS.ORDER_CREATE,
      );
    });

    it('an actor with pos.order.create but WITHOUT pos.order.fire gets 403 on Fire', async () => {
      const token = await pinLogin(
        tenantA,
        terminalA,
        employeeNoFireCode,
        '2222',
      );
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const { variantId, itemId } = await mkSellable(`NoAuth-${newId()}`);
      await mkLine(order.id, order.businessDay, itemId, variantId);

      await fireAndExpect(token, order.id, order.businessDay, 403);
    });

    it('an actor WITH pos.order.fire reaches Fire business logic (200, not 403)', async () => {
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const { variantId, itemId } = await mkSellable(`Auth-${newId()}`);
      await mkLine(order.id, order.businessDay, itemId, variantId);

      await fireAndExpect(token, order.id, order.businessDay, 200);
    });

    it('a Waiter role granted pos.order.fire does not thereby gain any cash-handling permission', async () => {
      const waiter = await admin.role.findFirstOrThrow({
        where: { tenantId: tenantA, name: `fire_waiter_${stamp}` },
      });
      const grants = await admin.rolePermission.findMany({
        where: { roleId: waiter.id },
        include: { permission: true },
      });
      const codes = grants.map((g) => g.permission.code);
      expect(codes).toContain(SALES_PERMISSIONS.ORDER_FIRE);
      expect(codes).not.toContain(TREASURY_PERMISSIONS.CASH_SESSION_OPEN);
    });

    it("a cross-tenant actor cannot fire another tenant's order (invisible under RLS -> 404)", async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const { variantId, itemId } = await mkSellable(`XTenant-${newId()}`);
      await mkLine(order.id, order.businessDay, itemId, variantId);

      const tokenB = await pinLogin(tenantB, terminalB, employeeBCode, '3333');
      await fireAndExpect(tokenB, order.id, order.businessDay, 404);
    });

    it('existing branch/terminal authorization remains enforced (no terminal-bound session -> 403)', async () => {
      const login = await request(http)
        .post('/auth/login')
        .send({ email: `fire.a.${stamp}@example.com`, password })
        .expect(200);
      const dashboardToken = (login.body as { accessToken: string })
        .accessToken;
      const scoped = await request(http)
        .post('/auth/tenant')
        .set('Authorization', `Bearer ${dashboardToken}`)
        .send({ tenantId: tenantA })
        .expect(200);
      const scopedToken = (scoped.body as { accessToken: string }).accessToken;

      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const { variantId, itemId } = await mkSellable(`NoTerminal-${newId()}`);
      await mkLine(order.id, order.businessDay, itemId, variantId);

      await fireAndExpect(scopedToken, order.id, order.businessDay, 403);
    });
  });

  // ================================================ §21 STATE / EVENTS
  describe('state transition + event production (§21)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('FIRST FIRE: draft+pending -> open, firstFiredAt set once, lines fired with one shared instant, version+1, ETag matches, order.opened once, one order.line.fired per line', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const a = await mkSellable(`First-A-${newId()}`);
      const b = await mkSellable(`First-B-${newId()}`);
      await mkLine(order.id, order.businessDay, a.itemId, a.variantId);
      await mkLine(order.id, order.businessDay, b.itemId, b.variantId);
      const versionBeforeFire = await currentVersion(order.id);

      const openedBefore = opened.events.length;
      const res = await fireAndExpect(token, order.id, order.businessDay, 200);

      const body = res.body as {
        state: string;
        version: number;
        firstFiredAt: string;
        lines: Array<{ state: string; firedAt: string | null }>;
      };
      expect(body.state).toBe('open');
      expect(body.version).toBe(versionBeforeFire + 1);
      expect(body.firstFiredAt).not.toBeNull();
      expect(res.headers.etag).toBe(etagOf(order.id, body.version));

      const firedLines = body.lines.filter((l) => l.state === 'fired');
      expect(firedLines).toHaveLength(2);
      const firedAts = new Set(firedLines.map((l) => l.firedAt));
      expect(firedAts.size).toBe(1); // exactly one shared instant

      expect(opened.events.length).toBe(openedBefore + 1);
      const openedPayload = opened.events[opened.events.length - 1].payload as {
        orderId: string;
        orderNumber: string;
      };
      expect(openedPayload.orderId).toBe(order.id);
      expect(openedPayload.orderNumber).toBe(order.orderNumber);
    });

    it('SUBSEQUENT FIRE: only the new pending line fires, old fired lines unchanged, order stays OPEN, firstFiredAt unchanged, version+1 once, no second order.opened', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const a = await mkSellable(`Sub-A-${newId()}`);
      await mkLine(order.id, order.businessDay, a.itemId, a.variantId);

      const first = await fireAndExpect(
        token,
        order.id,
        order.businessDay,
        200,
      );
      const firstBody = first.body as {
        version: number;
        firstFiredAt: string;
        lines: Array<{ id: string; state: string; firedAt: string | null }>;
      };
      const firstFiredLine = firstBody.lines.find((l) => l.state === 'fired')!;

      const b = await mkSellable(`Sub-B-${newId()}`);
      await mkLine(order.id, order.businessDay, b.itemId, b.variantId);
      const versionBeforeSecondFire = await currentVersion(order.id);

      const openedBefore = opened.events.length;
      const second = await fireAndExpect(
        token,
        order.id,
        order.businessDay,
        200,
      );
      const secondBody = second.body as {
        state: string;
        version: number;
        firstFiredAt: string;
        lines: Array<{ id: string; state: string; firedAt: string | null }>;
      };

      expect(secondBody.state).toBe('open');
      expect(secondBody.version).toBe(versionBeforeSecondFire + 1);
      expect(secondBody.firstFiredAt).toBe(firstBody.firstFiredAt); // unchanged
      expect(opened.events.length).toBe(openedBefore); // NOT published again

      const unchangedLine = secondBody.lines.find(
        (l) => l.id === firstFiredLine.id,
      )!;
      expect(unchangedLine.firedAt).toBe(firstFiredLine.firedAt); // untouched

      const newlyFired = secondBody.lines.filter(
        (l) => l.state === 'fired' && l.id !== firstFiredLine.id,
      );
      expect(newlyFired).toHaveLength(1);
    });

    it('zero eligible lines -> 422 (ENGINEERING-DECIDED)', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      await fireAndExpect(token, order.id, order.businessDay, 422);
    });

    it('a modifier with an unresolved (null) kind fails the WHOLE Fire closed with 422, and rolls back', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const item = await mkSellable(`NullKind-${newId()}`);
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );

      // Simulate a legacy row: a real OrderLineModifier with kindSnapshot = null,
      // written directly (no live capture path can produce this — P1E-5).
      await admin.orderLineModifier.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          orderLineId: line.line.id,
          businessDay: order.businessDay,
          modifierId: modifierWithKind,
          modifierGroupId,
          nameSnapshot: { en: 'Legacy' },
          kindSnapshot: null,
          quantity: 1,
        },
      });

      const beforeOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      await fireAndExpect(token, order.id, order.businessDay, 422);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe(beforeOrder.state);
      expect(afterOrder.version).toBe(beforeOrder.version);
      const afterLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(afterLine.state).toBe('pending');
      const tickets = await admin.ticket.findMany({
        where: { orderId: order.id },
      });
      expect(tickets).toHaveLength(0);
    });
  });

  // ========================================== P1E-6A DEFECT B: FIRE STATE
  describe('Fire legal source states (P1E-6A Defect B)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    const toHeld = async (order: { id: string; businessDay: Date }) => {
      const v1 = await currentVersion(order.id);
      await orders.transition(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        'open',
        v1,
      );
      const v2 = await currentVersion(order.id);
      await orders.transition(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        'held',
        v2,
      );
    };

    const toParked = async (order: { id: string; businessDay: Date }) => {
      const v1 = await currentVersion(order.id);
      await orders.transition(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        'open',
        v1,
      );
      const v2 = await currentVersion(order.id);
      await orders.transition(
        tenantA,
        userA,
        order.id,
        order.businessDay,
        'parked',
        v2,
      );
    };

    it('HELD -> 422, and the attempt makes zero changes', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const item = await mkSellable(`Held-${newId()}`);
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      await toHeld(order);

      const versionBefore = await currentVersion(order.id);
      const auditBefore = await admin.auditEntry.count({
        where: { tenantId: tenantA, entityId: order.id, action: 'ORDER_FIRED' },
      });
      const openedBefore = opened.events.length;

      await fireAndExpect(token, order.id, order.businessDay, 422);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe('held');
      expect(afterOrder.version).toBe(versionBefore); // no CAS attempted
      const afterLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(afterLine.state).toBe('pending'); // untouched
      expect(afterLine.firedAt).toBeNull();
      const auditAfter = await admin.auditEntry.count({
        where: { tenantId: tenantA, entityId: order.id, action: 'ORDER_FIRED' },
      });
      expect(auditAfter).toBe(auditBefore); // no audit for a refused attempt
      expect(opened.events.length).toBe(openedBefore); // no order.opened
      const tickets = await admin.ticket.findMany({
        where: { orderId: order.id },
      });
      expect(tickets).toHaveLength(0); // no Kitchen consequence
    });

    it('PARKED -> 422, and the attempt makes zero changes', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const item = await mkSellable(`Parked-${newId()}`);
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      await toParked(order);

      const versionBefore = await currentVersion(order.id);
      await fireAndExpect(token, order.id, order.businessDay, 422);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe('parked');
      expect(afterOrder.version).toBe(versionBefore);
      const afterLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(afterLine.state).toBe('pending');
      const tickets = await admin.ticket.findMany({
        where: { orderId: order.id },
      });
      expect(tickets).toHaveLength(0);
    });

    it('DRAFT still succeeds (first Fire unaffected by the new guard)', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const item = await mkSellable(`StillDraft-${newId()}`);
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      await fireAndExpect(token, order.id, order.businessDay, 200);
    });

    it('OPEN still succeeds (amendment Fire unaffected by the new guard)', async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const a = await mkSellable(`StillOpenA-${newId()}`);
      await mkLine(order.id, order.businessDay, a.itemId, a.variantId);
      await fireAndExpect(token, order.id, order.businessDay, 200); // draft -> open

      const b = await mkSellable(`StillOpenB-${newId()}`);
      await mkLine(order.id, order.businessDay, b.itemId, b.variantId);
      await fireAndExpect(token, order.id, order.businessDay, 200); // open -> open
    });

    it("a finalised (completed) order still gets the existing BR-POS-001 message, not the new guard's message", async () => {
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      await admin.order.update({
        where: {
          id_businessDay: { id: order.id, businessDay: order.businessDay },
        },
        data: { state: 'completed', completedAt: new Date() },
      });
      const res = await fireAndExpect(token, order.id, order.businessDay, 422);
      expect((res.body as { message: string }).message).toMatch(
        /no longer be modified/,
      );
    });
  });

  // ======================================== P1E-6A DEFECT C: DINE-IN TABLE
  describe('dine-in service reference resolution (P1E-6A Defect C)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('an unresolvable tableId (DI-simulated — see SentinelAwareTableDisplayQuery) fails CLOSED with 422 and a full rollback', async () => {
      // The order's own tableId must satisfy the real
      // `orders_branch_id_table_id_fkey` (ON DELETE RESTRICT) FK, so a
      // genuinely nonexistent id can never reach Fire in the first place —
      // create a REAL, FK-satisfying table row, and rely on the test-only
      // stub to report it as unresolved regardless.
      const sentinelTableId = newId();
      simulateUnresolvedTableIds.add(sentinelTableId);
      await admin.branchTable.create({
        data: { id: sentinelTableId, branchId: branchA, label: 'DEAD' },
      });
      const item = await mkSellable(`Dangling-${newId()}`);
      const order = await mkOrder({
        idempotencyKey: `k-${newId()}`,
        orderType: 'dine_in',
        tableId: sentinelTableId,
      });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      const versionBefore = await currentVersion(order.id);
      const openedBefore = opened.events.length;

      await fireAndExpect(token, order.id, order.businessDay, 422);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe('draft'); // no transition happened
      expect(afterOrder.version).toBe(versionBefore);
      const afterLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(afterLine.state).toBe('pending');
      expect(opened.events.length).toBe(openedBefore);
      const tickets = await admin.ticket.findMany({
        where: { orderId: order.id },
      });
      expect(tickets).toHaveLength(0);
    });

    it('a valid tableId still resolves and reaches Kitchen (unaffected by the new fail-closed guard)', async () => {
      const item = await mkSellable(`ValidTable-${newId()}`, {
        categoryId: categoryTier4,
      });
      const order = await mkOrder({
        idempotencyKey: `k-${newId()}`,
        orderType: 'dine_in',
        tableId,
      });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );

      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticket = await admin.ticket.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(ticket.serviceReferenceSnapshot).toBe('T1');
      const afterLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(afterLine.state).toBe('fired');
    });

    it('non-dine-in still succeeds with serviceReference = null (unaffected)', async () => {
      const item = await mkSellable(`NonDineOk-${newId()}`);
      const order = await mkOrder({
        idempotencyKey: `k-${newId()}`,
        orderType: 'takeaway',
      });
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      await fireAndExpect(token, order.id, order.businessDay, 200);
    });
  });

  // ==================================================== §21 SNAPSHOTS
  describe('snapshot assembly (§21 / §12 / §13 / §14)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('categoryIds/kitchen name come from the Catalogue public contract; quantity is a decimal string; dine-in serviceReference comes from the Organisation public contract', async () => {
      const item = await mkSellable(`Snap-${newId()}`, {
        categoryId: categoryTier4,
      });
      await admin.menuItem.update({
        where: { id: item.itemId },
        data: { kitchenNames: { en: 'KDS NAME' } },
      });

      const order = await mkOrder({
        idempotencyKey: `k-${newId()}`,
        orderType: 'dine_in',
        tableId,
      });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
        {
          quantity: '2.5',
        },
      );

      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticketLine = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line.line.id },
      });
      expect(ticketLine.quantity.toString()).toBe('2.5');
      const snapshot = ticketLine.itemNameSnapshot as Record<string, unknown>;
      expect(snapshot.kitchenName).toEqual({ en: 'KDS NAME' });

      const ticket = await admin.ticket.findFirstOrThrow({
        where: { id: ticketLine.ticketId },
      });
      expect(ticket.stationId).toBe(stationCategory); // tier 4, via the category placed above
      expect(ticket.serviceReferenceSnapshot).toBe('T1'); // BranchTable.label
    });

    it('non-dine-in orders get serviceReference = null (no source, no invented value)', async () => {
      const item = await mkSellable(`NoRef-${newId()}`, {
        categoryId: categoryTier4,
      });
      const order = await mkOrder({
        idempotencyKey: `k-${newId()}`,
        orderType: 'takeaway',
      });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );

      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticketLine = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line.line.id },
      });
      const ticket = await admin.ticket.findFirstOrThrow({
        where: { id: ticketLine.ticketId },
      });
      expect(ticket.serviceReferenceSnapshot).toBeNull();
    });

    it('lineStationOverrides come from Sales persistence (order_line_station_overrides), and win as tier 1', async () => {
      const item = await mkSellable(`Override-${newId()}`, {
        categoryId: categoryTier4,
      });
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );

      await admin.orderLineStationOverride.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          orderId: order.id,
          orderLineId: line.line.id,
          businessDay: order.businessDay,
          branchId: branchA,
          stationId: stationOverride,
        },
      });

      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticketLine = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line.line.id },
      });
      const ticket = await admin.ticket.findFirstOrThrow({
        where: { id: ticketLine.ticketId },
      });
      // Tier 1 wins even though the item is ALSO placed in a tier-4 category.
      expect(ticket.stationId).toBe(stationOverride);
    });

    it('modifier snapshots come from sales.order_line_modifiers (kind/quantity/name), and modifier-driven routing (tier 2) wins over category (tier 4)', async () => {
      const item = await mkSellable(`ModRoute-${newId()}`, {
        categoryId: categoryTier4,
      });
      // The modifier's group must be LINKED to the item before it can be
      // selected on a line of that item (CatalogueLine validation).
      await admin.modifierGroupLink.create({
        data: { tenantId: tenantA, menuItemId: item.itemId, modifierGroupId },
      });

      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
        {
          modifiers: [{ modifierId: modifierWithKind, quantity: 2 }],
        },
      );

      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticketLine = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line.line.id },
      });
      const ticketModifier = await admin.ticketLineModifier.findFirstOrThrow({
        where: { ticketLineId: ticketLine.id },
      });
      expect(ticketModifier.kind).toBe('addition');
      expect(ticketModifier.quantity).toBe(2);
      expect(ticketModifier.sourceModifierId).toBe(modifierWithKind);

      const ticket = await admin.ticket.findFirstOrThrow({
        where: { id: ticketLine.ticketId },
      });
      expect(ticket.stationId).toBe(stationModifier); // tier 2, not tier 4
    });
  });

  // ==================================================== §19 ROUTING E2E
  describe('routing tiers through the REAL Fire producer (§19)', () => {
    let token: string;
    beforeAll(async () => {
      token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
    });

    it('tier 3 — MenuItem branch station assignment', async () => {
      const item = await mkSellable(`Tier3-${newId()}`);
      await admin.stationRoutingRule.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          stationId: stationMenuItem,
          menuItemId: item.itemId,
        },
      });
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticketLine = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line.line.id },
      });
      const ticket = await admin.ticket.findFirstOrThrow({
        where: { id: ticketLine.ticketId },
      });
      expect(ticket.stationId).toBe(stationMenuItem);
    });

    it('tier 5 — branch fallback station (no override/modifier/menu-item/category rule applies)', async () => {
      const item = await mkSellable(`Tier5-${newId()}`);
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticketLine = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line.line.id },
      });
      const ticket = await admin.ticket.findFirstOrThrow({
        where: { id: ticketLine.ticketId },
      });
      expect(ticket.stationId).toBe(stationFallback);
    });

    it('multi-station routing creates a line representation at EACH resolved station (two rules on one winning category tier)', async () => {
      const extraStation = await admin.station.create({
        data: {
          id: newId(),
          branchId: branchA,
          name: `Tier4-Extra-${newId()}`,
        },
      });
      await admin.stationRoutingRule.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          branchId: branchA,
          stationId: extraStation.id,
          categoryId: categoryTier4,
        },
      });

      const item = await mkSellable(`Multi-${newId()}`, {
        categoryId: categoryTier4,
      });
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      await fireAndExpect(token, order.id, order.businessDay, 200);

      const ticketLines = await admin.ticketLine.findMany({
        where: { orderLineId: line.line.id },
      });
      const ticketIds = ticketLines.map((tl) => tl.ticketId);
      const tickets = await admin.ticket.findMany({
        where: { id: { in: ticketIds } },
      });
      const stationIds = new Set(tickets.map((t) => t.stationId));
      expect(stationIds.has(stationCategory)).toBe(true);
      expect(stationIds.has(extraStation.id)).toBe(true);
      expect(ticketLines).toHaveLength(2); // one TicketLine per resolved station
    });

    it('conflicting category routing sets -> ROUTING_CONFIGURATION_CONFLICT -> 422 + full rollback', async () => {
      const item = await mkSellable(`Conflict-${newId()}`, {
        categoryId: categoryConflictA,
      });
      await admin.menuItemPlacement.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId: item.itemId,
          categoryId: categoryConflictB,
        },
      });

      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );

      const beforeOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      await fireAndExpect(token, order.id, order.businessDay, 422);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe(beforeOrder.state);
      expect(afterOrder.version).toBe(beforeOrder.version);
      const afterLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(afterLine.state).toBe('pending');
      expect(afterLine.firedAt).toBeNull();
    });

    it('zero routing destinations -> ROUTING_NO_DESTINATION -> 422 + full rollback (no fallback configured on this branch)', async () => {
      const tokenC = await pinLogin(tenantA, terminalC, employeeACode, '1111');
      const item = await mkSellable(`NoDest-${newId()}`, {
        priceListId: priceListC,
      });
      const order = await mkOrder({
        idempotencyKey: `k-${newId()}`,
        terminalId: terminalC,
        openedByEmployeeId: employeeA,
      });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );

      const beforeOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      await fireAndExpect(tokenC, order.id, order.businessDay, 422);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe(beforeOrder.state);
      expect(afterOrder.version).toBe(beforeOrder.version);
      const afterLine = await admin.orderLine.findFirstOrThrow({
        where: { id: line.line.id },
      });
      expect(afterLine.state).toBe('pending');
      const tickets = await admin.ticket.findMany({
        where: { orderId: order.id },
      });
      expect(tickets).toHaveLength(0);
    });
  });

  // ============================================ §16 TRANSACTION / AUDIT
  describe('transaction / audit (§16)', () => {
    it('a successful Fire creates exactly one ORDER_FIRED audit entry with correct actor/branch/fireBatch attribution', async () => {
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const item = await mkSellable(`Audit-${newId()}`);
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);

      await fireAndExpect(token, order.id, order.businessDay, 200);

      const entries = await admin.auditEntry.findMany({
        where: { tenantId: tenantA, entityId: order.id, action: 'ORDER_FIRED' },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].actorId).toBe(userA);
      const metadata = entries[0].afterState as Record<string, unknown> | null;
      expect(metadata?.branchId).toBe(branchA);
      expect(metadata?.fireBatchId).toBeDefined();
      expect(metadata?.firstFire).toBe(true);
    });
  });

  // ============================================ §17 IDEMPOTENCY
  describe('idempotency (§17)', () => {
    it('same key + same request -> replays the stored response, no second mutation/consequence', async () => {
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const item = await mkSellable(`Idem-${newId()}`);
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      const key = `fire-idem-${newId()}`;
      const versionBefore = await currentVersion(order.id);

      const first = await httpFire(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        key,
      ).expect(200);
      const second = await httpFire(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, versionBefore),
        key,
      ).expect(200);

      expect(second.headers['idempotent-replay']).toBe('true');
      expect(second.body).toEqual(first.body);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.version).toBe(versionBefore + 1); // NOT incremented twice

      const tickets = await admin.ticketLine.findMany({
        where: { orderLineId: line.line.id },
      });
      expect(tickets).toHaveLength(1); // NOT duplicated
      const batches = await admin.ticketFireBatch.findMany({
        where: { ticketId: tickets[0].ticketId },
      });
      expect(batches).toHaveLength(1);
    });

    /**
     * P1E-6A Defect A fix: the idempotency fingerprint now hashes the
     * RESOLVED request path (real order id in the URL), not the registered
     * Express route pattern, so two different orders' Fire calls under the
     * same Idempotency-Key are no longer identical requests. Reusing a key
     * across two different orders now correctly 409s as an endpoint/resource
     * mismatch (FR-API-023) — orderX's own Fire still succeeds and orderY is
     * left completely untouched, never replayed with orderX's response.
     */
    it('same key across two DIFFERENT orders 409-conflicts — never replays the first order onto the second', async () => {
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const itemX = await mkSellable(`Fp1-${newId()}`);
      const itemY = await mkSellable(`Fp2-${newId()}`);
      const orderX = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const orderY = await mkOrder({ idempotencyKey: `k-${newId()}` });
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
      const key = `fire-fp-${newId()}`;
      const versionYBefore = await currentVersion(orderY.id);

      await httpFire(
        token,
        orderX.businessDay,
        orderX.id,
        etagOf(orderX.id, await currentVersion(orderX.id)),
        key,
      ).expect(200);
      const resY = await httpFire(
        token,
        orderY.businessDay,
        orderY.id,
        etagOf(orderY.id, versionYBefore),
        key,
      ).expect(409);

      // orderY is completely untouched: no state change, no version bump,
      // and orderX's response body never leaks onto orderY's response.
      expect(resY.body).not.toEqual(expect.objectContaining({ id: orderX.id }));
      const afterY = await admin.order.findFirstOrThrow({
        where: { id: orderY.id },
      });
      expect(afterY.state).toBe('draft');
      expect(afterY.version).toBe(versionYBefore);
    });
  });

  // ============================================ §10 / §22 CONCURRENCY
  describe('optimistic concurrency (§10 / §22)', () => {
    it('a stale If-Match is refused via the existing 409 conflict path, and changes nothing', async () => {
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const item = await mkSellable(`Stale-${newId()}`);
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      await mkLine(order.id, order.businessDay, item.itemId, item.variantId);
      const versionBefore = await currentVersion(order.id);

      // Deliberately stale: the version BEFORE the line was added.
      await httpFire(
        token,
        order.businessDay,
        order.id,
        etagOf(order.id, order.version),
      ).expect(409);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.state).toBe('draft');
      expect(afterOrder.version).toBe(versionBefore);
    });

    it('two REAL concurrent Fire requests with the same expected version: exactly one wins, the other 409s, no duplicate Kitchen state', async () => {
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const item = await mkSellable(`Race-${newId()}`);
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );
      const raceVersion = await currentVersion(order.id);
      const etag = etagOf(order.id, raceVersion);

      const [r1, r2] = await Promise.all([
        httpFire(token, order.businessDay, order.id, etag, `race1-${newId()}`),
        httpFire(token, order.businessDay, order.id, etag, `race2-${newId()}`),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.version).toBe(raceVersion + 1); // exactly one increment

      const ticketLines = await admin.ticketLine.findMany({
        where: { orderLineId: line.line.id },
      });
      expect(ticketLines).toHaveLength(1); // no duplicate TicketLine
      const batches = await admin.ticketFireBatch.findMany({
        where: { ticketId: ticketLines[0].ticketId },
      });
      expect(batches).toHaveLength(1); // no duplicate FireBatch
    });
  });

  // ============================================ §18 AMENDMENT FIRE
  describe('amendment Fire (§18, FR-POS-038 / FR-KDS-028 backend persistence)', () => {
    it('reuses the existing station Ticket, appends a new FireBatch + TicketLine, leaves existing TicketLines unchanged', async () => {
      const token = await pinLogin(tenantA, terminalA, employeeACode, '1111');
      const item = await mkSellable(`Amend-${newId()}`);
      const order = await mkOrder({ idempotencyKey: `k-${newId()}` });
      const line1 = await mkLine(
        order.id,
        order.businessDay,
        item.itemId,
        item.variantId,
      );

      const first = await fireAndExpect(
        token,
        order.id,
        order.businessDay,
        200,
      );
      const firstBody = first.body as { version: number; firstFiredAt: string };

      const ticketLine1Before = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line1.line.id },
      });
      const ticketId = ticketLine1Before.ticketId;
      const batchesBefore = await admin.ticketFireBatch.findMany({
        where: { ticketId },
      });
      expect(batchesBefore).toHaveLength(1);

      const item2 = await mkSellable(`Amend2-${newId()}`);
      const line2 = await mkLine(
        order.id,
        order.businessDay,
        item2.itemId,
        item2.variantId,
      );
      const versionBeforeSecond = await currentVersion(order.id);

      const second = await fireAndExpect(
        token,
        order.id,
        order.businessDay,
        200,
      );
      const secondBody = second.body as {
        state: string;
        version: number;
        firstFiredAt: string;
      };

      expect(secondBody.state).toBe('open');
      expect(secondBody.firstFiredAt).toBe(firstBody.firstFiredAt);
      expect(secondBody.version).toBe(versionBeforeSecond + 1);

      const ticketLine1After = await admin.ticketLine.findFirstOrThrow({
        where: { id: ticketLine1Before.id },
      });
      expect(ticketLine1After.status).toBe(ticketLine1Before.status);
      expect(ticketLine1After.routedAt.getTime()).toBe(
        ticketLine1Before.routedAt.getTime(),
      );

      const ticketLine2 = await admin.ticketLine.findFirstOrThrow({
        where: { orderLineId: line2.line.id },
      });
      expect(ticketLine2.ticketId).toBe(ticketId); // SAME Ticket, reused

      const batchesAfter = await admin.ticketFireBatch.findMany({
        where: { ticketId },
      });
      expect(batchesAfter).toHaveLength(2); // NEW FireBatch appended
      expect(ticketLine2.fireBatchRowId).not.toBe(
        ticketLine1Before.fireBatchRowId,
      );
    });
  });
});
