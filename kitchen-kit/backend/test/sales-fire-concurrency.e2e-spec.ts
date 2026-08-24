import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { CATALOGUE_FIRE_FACTS_QUERY } from './../src/modules/catalogue/contract';
import type {
  CatalogueFireFacts,
  CatalogueFireFactsQuery,
  CatalogueFireFactsQueryInput,
} from './../src/modules/catalogue/contract';
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
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { OrderLinesService } from './../src/modules/sales/orders/order-lines.service';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { SalesFireService } from './../src/modules/sales/orders/sales-fire.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1E-6A §5 — a deterministic, real two-independent-transaction proof that
 * Fire's optimistic-concurrency CAS (`sales-fire.service.ts`'s
 * `order.updateMany({..., version: expectedVersion})`) is genuinely safe
 * under concurrency, not merely under the sequential `Promise.all`-over-HTTP
 * proof `sales-fire.e2e-spec.ts` already carries (which cannot show both
 * transactions read the SAME starting version before either wrote).
 *
 * Mirrors `kitchen-ticket-concurrency.e2e-spec.ts`'s established pattern
 * (P1E-5A): call the real application service directly (no HTTP), open two
 * genuinely independent transactions, and synchronize them with an explicit
 * barrier so BOTH are guaranteed to have completed their own read (and
 * derived their own `nextVersion`) BEFORE either is allowed to proceed to
 * its write — a real database-level race, not two calls sharing one
 * transaction, and not timing-dependent (no sleeps).
 *
 * ── THE SEAM ─────────────────────────────────────────────────────────────
 * `SalesFireService.fire()` has no test hook and none is added. Instead this
 * suite overrides `CATALOGUE_FIRE_FACTS_QUERY` — an EXISTING, already
 * test-swappable public-contract injection point (P1E-6) — with a stub that
 * awaits a test-supplied barrier before resolving. Fire calls this stub
 * strictly AFTER loading the order and computing `nextVersion` from its own
 * read, and strictly BEFORE the CAS `updateMany` (see
 * `sales-fire.service.ts`), so pausing there is pausing exactly "after the
 * read, before the write" — with zero production code changes.
 */
describe('Sales Fire — real Postgres concurrency (P1E-6A §5)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let orders: OrdersService;
  let lines: OrderLinesService;
  let fireService: SalesFireService;
  let packs: CountryPackService;

  const stamp = Date.now();
  const AT = new Date('2026-08-24T09:00:00.000Z');
  const PACK = '2026.1';

  const RELEASE_KEY = generateReleaseKey('e2e-fire-race-release-key');
  const TRUST = trustStoreFor(RELEASE_KEY.trusted());
  const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);
  const testPackDocument = () =>
    signPackDocument(
      {
        code: 'EG',
        version: PACK,
        effectiveFrom: '2026-01-01',
        currency: {
          code: 'EGP',
          exponent: 2,
          cashRounding: { enabled: false },
        },
        tax: {
          engine: 'vat_standard',
          pricingMode: 'tax_exclusive',
          computationLevel: 'line',
          roundingMode: 'HALF_UP',
          roundingPrecision: 2,
          classes: [
            { code: 'standard', rate: '14.0', label: { en: 'Standard' } },
          ],
          serviceChargeTaxable: true,
          orderTypeOverrides: [],
        },
      },
      RELEASE_KEY,
    );

  /** Releases both parties only once BOTH have arrived — a real barrier. */
  function makeBarrier(parties: number): () => Promise<void> {
    let arrived = 0;
    let release: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived === parties) release();
      await ready;
    };
  }

  /** Test-only DI seam: an existing public-contract token, made barrier-aware. */
  class BarrierAwareCatalogueFireFacts implements CatalogueFireFactsQuery {
    barrier: (() => Promise<void>) | null = null;
    async find(
      tx: Prisma.TransactionClient,
      input: CatalogueFireFactsQueryInput,
    ): Promise<ReadonlyMap<string, CatalogueFireFacts>> {
      void tx;
      void input;
      if (this.barrier) await this.barrier();
      return new Map();
    }
  }
  const catalogueStub = new BarrierAwareCatalogueFireFacts();

  let tenantA: string;
  let branchA: string;
  let terminalA: string;
  let employeeA: string;
  let userA: string;
  let priceListA: string;
  let taxClassStandard: string;
  let stationFallback: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
      .overrideProvider(CATALOGUE_FIRE_FACTS_QUERY)
      .useValue(catalogueStub)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    orders = app.get(OrdersService);
    lines = app.get(OrderLinesService);
    fireService = app.get(SalesFireService);
    packs = app.get(CountryPackService);

    await packs.activate(testPackDocument());

    const tenants = app.get(TenantsService);
    const tenant = await tenants.create({
      slug: `firerace-${stamp}`,
      legalName: 'FireRace',
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    tenantA = tenant.id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `RaceBrand ${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `FR${stamp % 10000}`,
        name: 'Race Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchA = branch.id;
    await admin.location.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        locationType: 'branch',
        refId: branchA,
        branchId: branchA,
      },
    });

    const terminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        branchId: branchA,
        name: 'Race-POS',
        terminalType: 'pos',
        status: 'active',
      },
    });
    terminalA = terminal.id;

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `fire.race.${stamp}@example.com`,
        displayName: 'Race',
      },
    });
    userA = user.id;
    await admin.membership.create({
      data: { id: newId(), userId: userA, tenantId: tenantA, status: 'active' },
    });

    const employee = await admin.employee.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        code: `FRE${stamp % 1000}`,
        displayName: 'Race Employee',
        homeBranchId: branchA,
        userId: userA,
      },
    });
    employeeA = employee.id;
    await admin.employeeBranch.create({
      data: { tenantId: tenantA, employeeId: employeeA, branchId: branchA },
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
        name: `Race pricing`,
        scopeType: 'branch',
        scopeId: branchA,
        status: 'active',
      },
    });
    priceListA = priceList.id;

    const station = await admin.station.create({
      data: { id: newId(), branchId: branchA, name: 'Race Station' },
    });
    stationFallback = station.id;
    await admin.branchKdsConfig.create({
      data: {
        branchId: branchA,
        tenantId: tenantA,
        fallbackStationId: stationFallback,
      },
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  const mkSellable = async (name: string) => {
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
        price: 1000n,
        currency: 'EGP',
      },
    });
    return { itemId: item.id, variantId: variant.id };
  };

  const currentVersion = async (orderId: string): Promise<number> =>
    (
      await admin.order.findFirstOrThrow({
        where: { id: orderId },
        select: { version: true },
      })
    ).version;

  it('two independent transactions racing to Fire the SAME order (both having read the SAME starting version) converge on exactly one winner', async () => {
    const item = await mkSellable(`Race-${newId()}`);
    const order = await orders.create(tenantA, userA, {
      terminalId: terminalA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: AT,
      idempotencyKey: `k-${newId()}`,
      at: AT,
    });
    const startingVersion = await currentVersion(order.id);
    await lines.addLine(tenantA, userA, order.id, order.businessDay, {
      menuItemId: item.itemId,
      variantId: item.variantId,
      quantity: '1',
      expectedVersion: startingVersion,
    });
    // Reading the version fresh AFTER addLine, but BEFORE either race
    // participant starts — both participants present this SAME value as
    // their `expectedVersion`, exactly modelling "both clients loaded the
    // order, then both tried to Fire it".
    const raceVersion = await currentVersion(order.id);

    const arrive = makeBarrier(2);
    catalogueStub.barrier = arrive;
    try {
      const results = await Promise.allSettled([
        fireService.fire(tenantA, {
          orderId: order.id,
          businessDay: order.businessDay,
          expectedVersion: raceVersion,
          actorUserId: userA,
          terminalId: terminalA,
        }),
        fireService.fire(tenantA, {
          orderId: order.id,
          businessDay: order.businessDay,
          expectedVersion: raceVersion,
          actorUserId: userA,
          terminalId: terminalA,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1); // exactly one CAS winner
      expect(rejected).toHaveLength(1);
      const reason: unknown = rejected[0].reason;
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).name).toBe('OrderVersionConflictError');

      const afterOrder = await admin.order.findFirstOrThrow({
        where: { id: order.id },
      });
      expect(afterOrder.version).toBe(raceVersion + 1); // bumped exactly once
      expect(afterOrder.state).toBe('open');

      const tickets = await admin.ticket.findMany({
        where: { orderId: order.id },
      });
      expect(tickets).toHaveLength(1); // one Kitchen consequence, not two

      const ticketLines = await admin.ticketLine.findMany({
        where: { ticketId: tickets[0].id },
      });
      expect(ticketLines).toHaveLength(1); // one line per expected station

      const batches = await admin.ticketFireBatch.findMany({
        where: { ticketId: tickets[0].id },
      });
      expect(batches).toHaveLength(1); // one fire batch, not two

      const auditEntries = await admin.auditEntry.count({
        where: { tenantId: tenantA, entityId: order.id, action: 'ORDER_FIRED' },
      });
      expect(auditEntries).toBe(1); // exactly one audit entry, not two
    } finally {
      catalogueStub.barrier = null;
    }
  });
});
