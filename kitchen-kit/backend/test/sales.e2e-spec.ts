import {
  ConflictException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { IdempotencyService } from './../src/common/idempotency/idempotency.service';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
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
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SALES_PERMISSION_DEFS } from './../src/modules/sales/sales.permissions';
import { createMigratorClient } from './rls-admin';

const password = 's3cure-passphrase';
const stamp = Date.now();
/** Inside the 2026-08 partition created by the Sales migration. */
const BUSINESS_DAY = new Date('2026-08-20T00:00:00.000Z');
/** 12:00 in Africa/Cairo on the business day above. */
const AT = new Date('2026-08-20T09:00:00.000Z');
/** The version the activated test pack declares. Never supplied by a caller. */
const PACK = '2026.1';
const PIN = '2468';

/**
 * The PRODUCTION verifier, trusting one ephemeral release key.
 *
 * This is not a test double: `Ed25519CountryPackSignatureVerifier` is the same
 * class the application binds. Only the TRUST STORE differs — it holds a key
 * pair generated in memory for this run, because committing a release private
 * key to sign a fixture is exactly what the trust model forbids.
 */
const E2E_RELEASE_KEY = generateReleaseKey('e2e-release-key');
const e2eTrustStore = trustStoreFor(E2E_RELEASE_KEY.trusted());
const e2eVerifier = new Ed25519CountryPackSignatureVerifier(e2eTrustStore);

/** SRS 22.2 shape, used strictly as DATA, then genuinely signed. */
const packPayload = (
  code: string,
  currency: string,
  overrides: Record<string, unknown> = {},
) => ({
  code,
  version: PACK,
  effectiveFrom: '2026-01-01',
  currency: { code: currency, exponent: 2, cashRounding: { enabled: false } },
  tax: {
    engine: 'vat_standard',
    pricingMode: 'tax_inclusive',
    computationLevel: 'line',
    roundingMode: 'HALF_UP',
    roundingPrecision: 2,
    classes: [
      { code: 'standard', rate: '14.0' },
      { code: 'zero', rate: '0.0' },
      { code: 'exempt', rate: null },
    ],
    serviceChargeTaxable: true,
    orderTypeOverrides: [],
  },
  ...overrides,
});

const testPackDocument = (
  code: string,
  currency: string,
  overrides: Record<string, unknown> = {},
) => signPackDocument(packPayload(code, currency, overrides), E2E_RELEASE_KEY);

/**
 * Every route path Express has registered.
 *
 * Express 5 (NestJS 11) exposes the router as `app.router`; Express 4 kept it on
 * the private `_router`. Both are read so the assertion cannot pass vacuously
 * because an internal moved.
 */
function registeredRoutePaths(app: INestApplication<App>): string[] {
  interface Layer {
    route?: { path?: string | string[] };
  }
  interface ExpressApp {
    router?: { stack?: Layer[] };
    _router?: { stack?: Layer[] };
  }
  const instance = app.getHttpAdapter().getInstance() as unknown as ExpressApp;
  const stack = instance.router?.stack ?? instance._router?.stack ?? [];
  return stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path === 'string') return [path];
    if (Array.isArray(path)) return path;
    return [];
  });
}

describe('Sales P1A (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let orders: OrdersService;
  let idem: IdempotencyService;
  let packs: CountryPackService;
  let posToken: string;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let branchB: string;
  let terminalA: string;
  let terminalA2: string;
  let terminalB: string;
  let employeeA: string;
  let employeeB: string;
  let userA: string;
  let userB: string;
  let branchACode: string;
  let employeeACode: string;

  const mkBranch = async (
    tenantId: string,
    code: string,
    countryCode = 'EG',
  ) => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId, name: `SBrand ${code}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId: brand.id,
        code,
        name: `SBranch ${code}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(e2eTrustStore)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(e2eVerifier)
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
    idem = app.get(IdempotencyService);
    packs = app.get(CountryPackService);

    // FR-LOC-021/022: a signed pack, effective before the transaction instant.
    await packs.activate(testPackDocument('EG', 'EGP'));

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
    tenantA = await mkTenant(`sla-${stamp}`);
    tenantB = await mkTenant(`slb-${stamp}`);

    branchACode = `SA${stamp % 10000}`;
    branchA = await mkBranch(tenantA, branchACode);
    branchB = await mkBranch(tenantB, `SB${stamp % 10000}`);
    terminalA = await mkTerminal(tenantA, branchA, 'SA-POS-1');
    terminalA2 = await mkTerminal(tenantA, branchA, 'SA-POS-2');
    terminalB = await mkTerminal(tenantB, branchB, 'SB-POS');

    const mkUser = async (email: string, tenantId: string) => {
      const u = await users.createUser({ email, password, displayName: 'S' });
      await memberships.grant(u.id, tenantId, 'active');
      return u.id;
    };
    userA = await mkUser(`sales.a.${stamp}@example.com`, tenantA);
    userB = await mkUser(`sales.b.${stamp}@example.com`, tenantB);

    employeeA = (
      await employees.create(tenantA, userA, {
        code: `SEA${stamp % 1000}`,
        displayName: 'Sales A',
        homeBranchId: branchA,
        userId: userA,
      })
    ).id;
    employeeB = (
      await employees.create(tenantB, userB, {
        code: `SEB${stamp % 1000}`,
        displayName: 'Sales B',
        homeBranchId: branchB,
        userId: userB,
      })
    ).id;
    employeeACode = `SEA${stamp % 1000}`;

    // A PIN session is the only session type that carries tenant + membership +
    // terminal + employee together, which is what a POS route needs.
    const permissions = app.get(PermissionsService);
    for (const def of SALES_PERMISSION_DEFS) await permissions.upsert(def);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const cashier = await roles.createTenantRole(tenantA, {
      name: `cashier_${stamp}`,
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
      employeeCode: employeeACode,
      pin: PIN,
    });
    posToken = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

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

  // ------------------------------------------------------- idempotency ---
  describe('FR-API-020…023 idempotency foundation', () => {
    const fp = (body: unknown) => idem.fingerprint('POST', '/v1/orders', body);

    it('produces a deterministic fingerprint regardless of key order', () => {
      expect(fp({ a: 1, b: 2 })).toBe(fp({ b: 2, a: 1 }));
      expect(fp({ a: 1 })).not.toBe(fp({ a: 2 }));
      expect(fp({ a: 1 })).toHaveLength(64);
    });

    it('first use reserves; the same key + same fingerprint replays (FR-API-022)', async () => {
      const key = `idem-${newId()}`;
      const f = fp({ x: 1 });
      expect(await idem.reserve(tenantA, key, 'POST /v1/orders', f)).toEqual({
        kind: 'proceed',
      });
      await idem.complete(tenantA, key, { status: 201, body: { id: 'o1' } });

      const replay = await idem.reserve(tenantA, key, 'POST /v1/orders', f);
      expect(replay.kind).toBe('replay');
      if (replay.kind === 'replay') {
        expect(replay.response.status).toBe(201);
        expect(replay.response.body).toEqual({ id: 'o1' });
      }
    });

    it('the same key with a DIFFERENT fingerprint is 409 (FR-API-023)', async () => {
      const key = `idem-${newId()}`;
      await idem.reserve(tenantA, key, 'POST /v1/orders', fp({ x: 1 }));
      await idem.complete(tenantA, key, { status: 201, body: {} });
      await expect(
        idem.reserve(tenantA, key, 'POST /v1/orders', fp({ x: 999 })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('the same key reused on a DIFFERENT endpoint is 409, not a cross-op replay', async () => {
      const key = `idem-${newId()}`;
      const f = fp({ x: 1 });
      await idem.reserve(tenantA, key, 'POST /v1/orders', f);
      await idem.complete(tenantA, key, { status: 201, body: {} });
      await expect(
        idem.reserve(tenantA, key, 'POST /v1/orders/x/lines', f),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('an in-flight key refuses a concurrent duplicate rather than doing the work twice', async () => {
      const key = `idem-${newId()}`;
      await idem.reserve(tenantA, key, 'POST /v1/orders', fp({ x: 1 }));
      // Not completed yet — a second caller must not proceed.
      await expect(
        idem.reserve(tenantA, key, 'POST /v1/orders', fp({ x: 1 })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('CONCURRENCY: two simultaneous identical reserves yield exactly one proceed', async () => {
      const key = `idem-${newId()}`;
      const f = fp({ x: 7 });
      const results = await Promise.allSettled([
        idem.reserve(tenantA, key, 'POST /v1/orders', f),
        idem.reserve(tenantA, key, 'POST /v1/orders', f),
      ]);
      const proceeded = results.filter(
        (r) => r.status === 'fulfilled' && r.value.kind === 'proceed',
      );
      expect(proceeded).toHaveLength(1);
    });

    it('a failed handler releases the key — no false successful replay', async () => {
      const key = `idem-${newId()}`;
      const f = fp({ x: 1 });
      await idem.reserve(tenantA, key, 'POST /v1/orders', f);
      await idem.release(tenantA, key); // handler threw
      // The retry proceeds rather than replaying a success that never happened.
      expect(await idem.reserve(tenantA, key, 'POST /v1/orders', f)).toEqual({
        kind: 'proceed',
      });
    });

    it('keys do NOT collide across tenants, and a response cannot replay across one', async () => {
      const key = `shared-${newId()}`;
      const f = fp({ x: 1 });
      await idem.reserve(tenantA, key, 'POST /v1/orders', f);
      await idem.complete(tenantA, key, { status: 201, body: { owner: 'A' } });

      // Tenant B may claim the identical key and gets its OWN reservation.
      expect(await idem.reserve(tenantB, key, 'POST /v1/orders', f)).toEqual({
        kind: 'proceed',
      });
      const rowB = await admin.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId: tenantB, key } },
      });
      expect(rowB?.responseBody).toBeNull();
    });

    it('retains records for at least 30 days (FR-API-021)', async () => {
      const key = `ret-${newId()}`;
      await idem.reserve(tenantA, key, 'POST /v1/orders', fp({ x: 1 }));
      const row = await admin.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId: tenantA, key } },
      });
      const days =
        (row!.expiresAt.getTime() - row!.firstSeenAt.getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(30);
    });

    it('stores the fingerprint, never raw request material', async () => {
      const key = `fpr-${newId()}`;
      await idem.reserve(
        tenantA,
        key,
        'POST /v1/orders',
        fp({ secret: 'hunter2' }),
      );
      const row = await admin.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId: tenantA, key } },
      });
      expect(row!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain('hunter2');
    });
  });

  // ------------------------------------------------ identity / numbering ---
  describe('FR-OFF-015 identity and FR-POS-002 numbering', () => {
    it('persists a client-generated ULID EXACTLY — no remapping', async () => {
      const clientId = newId();
      const order = await mkOrder({ id: clientId });
      expect(order.id).toBe(clientId);
      const stored = await admin.order.findFirst({ where: { id: clientId } });
      expect(stored?.id).toBe(clientId);
    });

    it('rejects a malformed identifier', async () => {
      await expect(mkOrder({ id: 'not-a-ulid' })).rejects.toThrow(/ULID/);
    });

    it('formats <branch_code>-<seq> and starts at 1 for the day', async () => {
      const order = await mkOrder();
      expect(order.orderNumber).toMatch(
        new RegExp(`^${branchACode.toUpperCase()}-\\d+$`),
      );
    });

    it('numbers are unique within branch + business day', async () => {
      const made = await Promise.all([mkOrder(), mkOrder(), mkOrder()]);
      const numbers = made.map((o) => o.orderNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('CONCURRENCY: parallel allocation never repeats a number', async () => {
      const made = await Promise.all(
        Array.from({ length: 8 }, () => mkOrder()),
      );
      const numbers = made.map((o) => o.orderNumber);
      expect(new Set(numbers).size).toBe(8);
    });

    it('a second terminal draws from its OWN block — ranges never overlap', async () => {
      const t2 = await mkOrder({ terminalId: terminalA2 });
      const blocks = await admin.orderNumberBlock.findMany({
        where: { branchId: branchA, businessDay: BUSINESS_DAY },
        orderBy: { blockStart: 'asc' },
      });
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i].blockStart).toBeGreaterThan(blocks[i - 1].blockEnd);
      }
      expect(t2.orderNumber).toBeTruthy();
    });

    it('a different branch numbers independently', async () => {
      const blocksA = await admin.orderNumberBlock.count({
        where: { branchId: branchA },
      });
      const blocksB = await admin.orderNumberBlock.count({
        where: { branchId: branchB },
      });
      expect(blocksA).toBeGreaterThan(0);
      expect(blocksB).toBe(0); // branch B has issued none
    });
  });

  // ------------------------------------------------------- partitioning ---
  describe('FR-DR-001 partitioning', () => {
    it('routes an order into the business-day partition', async () => {
      const id = newId();
      await mkOrder({ id });
      const rows = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM sales.orders_2026_08 WHERE id = $1::uuid`,
        id,
      );
      expect(Number(rows[0].n)).toBe(1);
    });

    it('the parent sees the row too', async () => {
      const id = newId();
      await mkOrder({ id });
      const found = await admin.order.findFirst({ where: { id } });
      expect(found?.id).toBe(id);
    });

    it('both parents are RANGE-partitioned on business_day', async () => {
      const rows = await admin.$queryRawUnsafe<
        { relname: string; def: string }[]
      >(
        `SELECT c.relname, pg_get_partkeydef(c.oid) AS def
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'sales' AND c.relkind = 'p'`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.relname, r.def]));
      expect(byName['orders']).toBe('RANGE (business_day)');
      expect(byName['order_lines']).toBe('RANGE (business_day)');
    });

    it('future partitions exist beyond the current month', async () => {
      const rows = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM pg_class c
           JOIN pg_namespace n2 ON n2.oid = c.relnamespace
          WHERE n2.nspname='sales' AND c.relname LIKE 'orders_20%'`,
      );
      expect(Number(rows[0].n)).toBeGreaterThanOrEqual(6);
    });
  });

  // ------------------------------------------------------------- tenancy ---
  describe('tenant isolation and tenant-safe FKs', () => {
    it('another tenant cannot read the order', async () => {
      const id = newId();
      await mkOrder({ id });
      expect(await orders.findOne(tenantB, id, BUSINESS_DAY)).toBeNull();
      expect(await orders.findOne(tenantA, id, BUSINESS_DAY)).not.toBeNull();
    });

    it('rejects a cross-tenant terminal (invisible under RLS -> 404)', async () => {
      // The branch is DERIVED from the terminal, so a cross-tenant branch is
      // not reachable at all: there is no branch input to poison.
      await expect(mkOrder({ terminalId: terminalB })).rejects.toThrow(
        /Terminal not found/,
      );
    });

    it('books the order to the branch the terminal is registered to', async () => {
      const order = await mkOrder();
      expect(order.branchId).toBe(branchA);
    });

    it('rejects an employee not permitted at the branch', async () => {
      await expect(mkOrder({ openedByEmployeeId: employeeB })).rejects.toThrow(
        /Employee not found/,
      );
    });

    it('the DATABASE rejects a cross-tenant branch even if the service is bypassed', async () => {
      await expect(
        admin.order.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchB, // tenant B's branch
            terminalId: terminalA,
            orderNumber: `X-${Date.now() % 100000}`,
            businessDay: BUSINESS_DAY,
            orderType: 'takeaway',
            channel: 'pos',
            openedBy: employeeA,
            currency: 'EGP',
            openedAt: new Date(),
            originDeviceTime: new Date(),
            idempotencyKey: `x-${newId()}`,
            countryPackVersion: PACK,
          },
        }),
      ).rejects.toThrow();
    });

    it('the DATABASE rejects a cross-tenant opened_by employee', async () => {
      await expect(
        admin.order.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            branchId: branchA,
            terminalId: terminalA,
            orderNumber: `Y-${Date.now() % 100000}`,
            businessDay: BUSINESS_DAY,
            orderType: 'takeaway',
            channel: 'pos',
            openedBy: employeeB, // tenant B's employee
            currency: 'EGP',
            openedAt: new Date(),
            originDeviceTime: new Date(),
            idempotencyKey: `y-${newId()}`,
            countryPackVersion: PACK,
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------------- concurrency ---
  describe('§24.6.4 optimistic concurrency', () => {
    it('a correct expected version succeeds and bumps the version', async () => {
      const order = await mkOrder();
      const updated = await orders.transition(
        tenantA,
        userA,
        order.id,
        BUSINESS_DAY,
        'open',
        order.version,
      );
      expect(updated.state).toBe('open');
      expect(updated.version).toBe(order.version + 1);
    });

    it('a stale expected version is refused and changes nothing', async () => {
      const order = await mkOrder();
      await orders.transition(
        tenantA,
        userA,
        order.id,
        BUSINESS_DAY,
        'open',
        1,
      );
      const auditBefore = await admin.auditEntry.count({
        where: { tenantId: tenantA, entityId: order.id },
      });

      await expect(
        orders.transition(tenantA, userA, order.id, BUSINESS_DAY, 'held', 1),
      ).rejects.toThrow(/Version mismatch/);

      const after = await admin.order.findFirst({ where: { id: order.id } });
      expect(after?.state).toBe('open'); // unchanged
      const auditAfter = await admin.auditEntry.count({
        where: { tenantId: tenantA, entityId: order.id },
      });
      expect(auditAfter).toBe(auditBefore); // no audit for the refused attempt
    });
  });

  // ------------------------------------------------- immutability / audit ---
  describe('BR-POS-001 immutability and audit', () => {
    it('a completed order refuses further mutation, for any caller', async () => {
      const order = await mkOrder();
      // Completion is not exposed; drive the row directly to prove the domain
      // guard, not to endorse a completion path.
      await admin.order.update({
        where: { id_businessDay: { id: order.id, businessDay: BUSINESS_DAY } },
        data: { state: 'completed', completedAt: new Date() },
      });
      await expect(
        orders.transition(
          tenantA,
          userA,
          order.id,
          BUSINESS_DAY,
          'open',
          order.version,
        ),
      ).rejects.toThrow(/no longer be modified/);
    });

    it('order creation emits an audit entry with actor, terminal and branch', async () => {
      const order = await mkOrder();
      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: order.id,
          action: 'ORDER_CREATED',
        },
      });
      expect(entry).not.toBeNull();
      expect(entry!.actorId).toBe(userA);
      expect(entry!.terminalId).toBe(terminalA);
      expect(entry!.afterState).toMatchObject({ branchId: branchA });
    });

    it('a state change records before and after', async () => {
      const order = await mkOrder();
      await orders.transition(
        tenantA,
        userA,
        order.id,
        BUSINESS_DAY,
        'open',
        order.version,
      );
      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: order.id,
          action: 'ORDER_STATE_CHANGED',
        },
      });
      expect(entry!.beforeState).toMatchObject({ state: 'draft' });
      expect(entry!.afterState).toMatchObject({ state: 'open' });
    });
  });

  // ---------------------------------------------------------- country pack ---
  describe('country pack resolution (FR-LOC-021, FR-BRN-002/003)', () => {
    it('pins the version in force for the branch jurisdiction', async () => {
      const order = await mkOrder();
      expect(order.countryPackVersion).toBe(PACK);
    });

    it('refuses to open an order before any pack is effective', async () => {
      // The pack is effective 2026-01-01; 2025 has none in force. The column is
      // NOT NULL and is never filled with 'default' or 'unknown'.
      await expect(
        mkOrder({ at: new Date('2025-06-01T09:00:00.000Z') }),
      ).rejects.toThrow(/No activated country pack is in force/);
    });

    it('refuses to open an order for a jurisdiction with no activated pack', async () => {
      const branch = await mkBranch(tenantA, `NP${stamp % 10000}`, 'ZZ');
      const terminal = await mkTerminal(tenantA, branch, 'NP-POS');
      await admin.employeeBranch.create({
        data: { tenantId: tenantA, employeeId: employeeA, branchId: branch },
      });

      await expect(mkOrder({ terminalId: terminal })).rejects.toThrow(
        /No activated country pack is in force for ZZ/,
      );
    });

    it('keeps a historical order interpretable under its pinned version', async () => {
      const order = await mkOrder();

      // A NEWER pack is published and activated. It is effective from 2027, so
      // it does not touch anything already sold, and the order stays readable
      // under the exact version it was priced with.
      await packs.activate(
        signPackDocument(
          {
            ...packPayload('EG', 'EGP'),
            version: '2027.1',
            effectiveFrom: '2027-01-01',
          },
          E2E_RELEASE_KEY,
        ),
      );

      const reread = await orders.findOne(tenantA, order.id, order.businessDay);
      expect(reread!.countryPackVersion).toBe(PACK);
      expect(
        packs.requirePinned('EG', reread!.countryPackVersion).version,
      ).toBe(PACK);
      // The newer pack governs sales made after its effective date, and only
      // those: resolution at the original instant is unchanged.
      expect(packs.registry.resolveEffective('EG', AT)?.version).toBe(PACK);
      expect(
        packs.registry.resolveEffective('EG', new Date('2027-06-01T00:00:00Z'))
          ?.version,
      ).toBe('2027.1');
    });
  });

  // ----------------------------------------------------------- HTTP surface ---
  describe('POST /orders (FR-POS-001, FR-API-020…023)', () => {
    const open = (
      body: Record<string, unknown>,
      key: string,
      token = posToken,
    ) =>
      request(http)
        .post('/orders')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({
          orderType: 'takeaway',
          channel: 'pos',
          originDeviceTime: '2026-08-20T09:00:00.000Z',
          ...body,
        });

    it('opens an order and returns the persisted snapshot with an ETag', async () => {
      const res = await open({}, `http-${newId()}`);
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body.branchId).toBe(branchA);
      expect(body.terminalId).toBe(terminalA);
      expect(body.openedBy).toBe(employeeA);
      expect(body.currency).toBe('EGP');
      expect(body.state).toBe('draft');
      expect(body.subtotal).toBe('0');
      expect(body.grandTotal).toBe('0');
      expect(res.headers.etag).toBe(`W/"${String(body.id)}.1"`);
    });

    it('determines the country pack version server-side', async () => {
      const res = await open({}, `http-${newId()}`);
      expect(
        (res.body as { countryPackVersion: string }).countryPackVersion,
      ).toBe(PACK);
    });

    it('preserves a client-generated ULID (FR-OFF-015)', async () => {
      const id = newId();
      const res = await open({ id }, `http-${newId()}`);
      expect((res.body as { id: string }).id).toBe(id);
    });

    it('derives the business day rather than accepting one', async () => {
      const res = await open({}, `http-${newId()}`);
      expect((res.body as { businessDay: string }).businessDay).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    it('rejects a body that tries to set money, tenancy or the pack version', async () => {
      for (const forbidden of [
        { tenantId: tenantB },
        { branchId: branchB },
        { countryPackVersion: 'FORGED' },
        { businessDay: '2026-08-01' },
        { grandTotal: '999999' },
        { currency: 'USD' },
      ]) {
        const res = await open(forbidden, `http-${newId()}`);
        expect(res.status).toBe(400);
      }
    });

    it('requires an Idempotency-Key (FR-API-020)', async () => {
      const res = await request(http)
        .post('/orders')
        .set('Authorization', `Bearer ${posToken}`)
        .send({
          orderType: 'takeaway',
          channel: 'pos',
          originDeviceTime: '2026-08-20T09:00:00.000Z',
        });
      expect(res.status).toBe(400);
    });

    it('replays an identical request instead of opening a second order', async () => {
      const key = `http-${newId()}`;
      const first = await open({}, key);
      const second = await open({}, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((second.body as { id: string }).id).toBe(
        (first.body as { id: string }).id,
      );
      expect(second.headers['idempotent-replay']).toBe('true');

      const rows = await admin.order.findMany({
        where: { tenantId: tenantA, idempotencyKey: key },
      });
      expect(rows).toHaveLength(1);
    });

    it('rejects the same key with a different fingerprint (FR-API-023)', async () => {
      const key = `http-${newId()}`;
      await open({}, key);
      const res = await open({ guestCount: 4 }, key);
      expect(res.status).toBe(409);
    });

    it('refuses a terminal other than the one the session is bound to', async () => {
      const res = await open({ terminalId: terminalA2 }, `http-${newId()}`);
      expect(res.status).toBe(403);
    });

    it('refuses an employee other than the one who entered the PIN', async () => {
      const res = await open(
        { openedByEmployeeId: employeeB },
        `http-${newId()}`,
      );
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(http)
        .post('/orders')
        .set('Idempotency-Key', `http-${newId()}`)
        .send({
          orderType: 'takeaway',
          channel: 'pos',
          originDeviceTime: '2026-08-20T09:00:00.000Z',
        });
      expect(res.status).toBe(401);
    });

    it('emits an audit entry naming the actor, terminal and pack', async () => {
      const res = await open({}, `http-${newId()}`);
      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantA,
          entityId: (res.body as { id: string }).id,
          action: 'ORDER_CREATED',
        },
      });
      expect(entry).not.toBeNull();
      expect(entry!.terminalId).toBe(terminalA);
      expect(entry!.afterState).toMatchObject({ countryPack: `EG-${PACK}` });
    });
  });

  describe('GET /orders (reads)', () => {
    it('returns one order with its ETag', async () => {
      const created = await mkOrder();
      const res = await request(http)
        .get(
          `/orders/${created.businessDay.toISOString().slice(0, 10)}/${created.id}`,
        )
        .set('Authorization', `Bearer ${posToken}`);

      expect(res.status).toBe(200);
      expect((res.body as { id: string }).id).toBe(created.id);
      expect(res.headers.etag).toBe(`W/"${created.id}.${created.version}"`);
    });

    it('hides another tenant order as 404, never 403', async () => {
      const other = await orders.create(tenantB, userB, {
        terminalId: terminalB,
        openedByEmployeeId: employeeB,
        orderType: 'takeaway',
        channel: 'pos',
        originDeviceTime: new Date(),
        idempotencyKey: `k-${newId()}`,
        at: AT,
      });
      const res = await request(http)
        .get(
          `/orders/${other.businessDay.toISOString().slice(0, 10)}/${other.id}`,
        )
        .set('Authorization', `Bearer ${posToken}`);
      expect(res.status).toBe(404);
    });

    it('lists orders with a cursor', async () => {
      const res = await request(http)
        .get('/orders?limit=2')
        .set('Authorization', `Bearer ${posToken}`);
      expect(res.status).toBe(200);
      const body = res.body as { orders: unknown[]; nextCursor: unknown };
      expect(body.orders.length).toBeLessThanOrEqual(2);
      if (body.nextCursor) {
        const cursor = body.nextCursor as { businessDay: string; id: string };
        expect(typeof cursor.businessDay).toBe('string');
        expect(typeof cursor.id).toBe('string');
      }
    });

    it('rejects a half-specified cursor', async () => {
      const res = await request(http)
        .get(`/orders?cursorId=${newId()}`)
        .set('Authorization', `Bearer ${posToken}`);
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------------------ exposed surface ---
  describe('the public surface matches what can be produced truthfully', () => {
    it('exposes order capture + explicit Fire (P1E-6), and NOTHING with an unmet prerequisite', () => {
      const paths = registeredRoutePaths(app);
      // Guard the guard: an introspection that silently returned nothing would
      // make every "route absent" assertion below pass vacuously.
      expect(paths.length).toBeGreaterThan(0);

      const sales = [
        ...new Set(paths.filter((p) => p.startsWith('/orders'))),
      ].sort();
      expect(sales).toEqual([
        '/orders',
        '/orders/:businessDay/:id',
        '/orders/:businessDay/:id/fire',
        '/orders/:businessDay/:id/lines',
        '/orders/:businessDay/:id/lines/:lineId',
      ]);

      // P1E-6: explicit Fire is now real (ratified "Fire Authorization
      // Ratification — 2026-08-24"). Automatic/configurable Fire (the other
      // half of FR-POS-035) and complete still have unmet prerequisites; a
      // state flip for either would misrepresent them.
      expect(paths.filter((p) => p.includes('fire'))).toHaveLength(1);
      // `/catalogue/completeness` is a Catalogue reporting route and is not an
      // order-completion route; scope the check to Sales.
      expect(sales.filter((p) => p.includes('complete'))).toHaveLength(0);
      expect(paths.filter((p) => p.includes('payment'))).toHaveLength(0);
      expect(paths.filter((p) => p.includes('refund'))).toHaveLength(0);
      // Country packs and tax stay internal: no administrative surface exists.
      expect(paths.filter((p) => p.includes('country-pack'))).toHaveLength(0);
      expect(paths.filter((p) => p.includes('/tax'))).toHaveLength(0);
    });

    it('still refuses to open an order without a verified pack', async () => {
      await expect(
        mkOrder({ at: new Date('2025-06-01T09:00:00.000Z') }),
      ).rejects.toThrow(/No activated country pack is in force/);
    });

    it('refuses a pack whose signature does not verify', async () => {
      // Genuinely signed, then modified. The canonical bytes no longer match.
      const forged = testPackDocument('ZW', 'EGP');
      const tax = { ...(forged.tax as Record<string, unknown>) };
      tax.classes = [{ code: 'standard', rate: '0.0' }];

      await expect(packs.activate({ ...forged, tax })).rejects.toThrow(
        /was not activated/,
      );
      expect(packs.registry.resolveEffective('ZW', AT)).toBeNull();
    });

    it('refuses an unsigned pack', async () => {
      await expect(packs.activate(packPayload('ZX', 'EGP'))).rejects.toThrow(
        /was not activated/,
      );
      expect(packs.registry.resolveEffective('ZX', AT)).toBeNull();
    });
  });
});
