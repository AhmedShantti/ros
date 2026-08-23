import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { KitchenModule } from './../src/modules/kitchen/kitchen.module';
import { RoutingResolverService } from './../src/modules/kitchen/routing/routing-resolver.service';
import { ROUTING_CONFIG_QUERY } from './../src/modules/organisation/contract';
import type { RoutingConfigQuery } from './../src/modules/organisation/contract';
import { RoutingConfigQueryService } from './../src/modules/organisation/routing-config/routing-config.query.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1E-3A — proves the split between the public `RoutingConfigQuery`
 * contract/token and its private Organisation implementation actually works
 * end to end through real Nest DI, a real PostgreSQL transaction, and real
 * RLS — not merely that the source files are shaped correctly (that part is
 * `module-boundaries.spec.ts`).
 *
 * `KitchenModule` is deliberately not part of `AppModule` (see the P1E-3
 * report §K); it is added directly here as a second import alongside
 * `AppModule` so Kitchen's real DI wiring — resolving `ROUTING_CONFIG_QUERY`
 * through `OrganisationModule` — is exercised exactly as a future Fire caller
 * would exercise it.
 */
describe('Organisation routing contract — DI + transaction + RLS (P1E-3A)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let routingConfigQuery: RoutingConfigQuery;
  let resolver: RoutingResolverService;

  const ts = Date.now();
  const tenantA = newId();
  const tenantB = newId();
  const brandA = newId();
  const branchA = newId();
  const stationA = newId();
  const menuItemA = newId();
  const ruleA = newId();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, KitchenModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);
    routingConfigQuery = app.get(ROUTING_CONFIG_QUERY);
    resolver = app.get(RoutingResolverService);

    await admin.tenant.createMany({
      data: [tenantA, tenantB].map((id, i) => ({
        id,
        slug: `routecontract-${i}-${ts}`,
        legalName: 'RouteContract',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
    });
    await admin.brand.create({
      data: { id: brandA, tenantId: tenantA, name: `Brand ${ts}` },
    });
    await admin.branch.create({
      data: {
        id: branchA,
        tenantId: tenantA,
        brandId: brandA,
        code: `RC${ts % 10000}`,
        name: 'Branch A',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    await admin.station.create({
      data: { id: stationA, branchId: branchA, name: 'Grill' },
    });
    await admin.menuItem.create({
      data: { id: menuItemA, tenantId: tenantA, names: { en: 'Item' } },
    });
    await admin.stationRoutingRule.create({
      data: {
        id: ruleA,
        tenantId: tenantA,
        branchId: branchA,
        stationId: stationA,
        menuItemId: menuItemA,
      },
    });
  });

  afterAll(async () => {
    await admin.stationRoutingRule.deleteMany({ where: { tenantId: tenantA } });
    await admin.menuItem.deleteMany({ where: { tenantId: tenantA } });
    await admin.station.deleteMany({ where: { branchId: branchA } });
    await admin.branch.deleteMany({ where: { tenantId: tenantA } });
    await admin.brand.deleteMany({ where: { tenantId: tenantA } });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await admin.$disconnect();
    await app.close();
  });

  it('resolves ROUTING_CONFIG_QUERY, through real Nest DI, to the private RoutingConfigQueryService', () => {
    expect(routingConfigQuery).toBeInstanceOf(RoutingConfigQueryService);
  });

  it("Kitchen's RoutingResolverService is wired to the same DI-resolved contract instance", () => {
    // Reaching into the resolver only to prove wiring identity, not as a
    // pattern any application code may rely on.
    const injected = (resolver as unknown as { routingConfig: unknown })
      .routingConfig;
    expect(injected).toBe(routingConfigQuery);
  });

  it('the resolver correctly resolves a real MenuItem-tier rule through the full DI + DB path', async () => {
    const result = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
      resolver.resolve(tx, {
        tenantId: tenantA,
        branchId: branchA,
        menuItemId: menuItemA,
        modifierIds: [],
        categoryIds: [],
        lineOverrides: [],
      }),
    );
    expect(result.tier).toBe('MENU_ITEM');
    expect(result.stationIds).toEqual([stationA]);
    expect(result.sourceIds).toEqual([ruleA]);
  });

  it('the private implementation uses the caller-supplied transaction — no second transaction is opened', async () => {
    const transactionSpy = jest.spyOn(prisma, '$transaction');
    await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
      routingConfigQuery.find(tx, {
        tenantId: tenantA,
        branchId: branchA,
        menuItemId: menuItemA,
        modifierIds: [],
        categoryIds: [],
      }),
    );
    // Exactly one transaction — the one withAuthContext itself opened. Prisma
    // does not support nested interactive transactions, so a second one here
    // would have thrown rather than silently run — this assertion is the
    // positive-path half of that guarantee.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    transactionSpy.mockRestore();
  });

  it('a tenant B session cannot read tenant A routing config, even when the query input itself asks for tenant A (RLS enforced independently of the WHERE clause)', async () => {
    const result = await prisma.withAuthContext({ tenantId: tenantB }, (tx) =>
      routingConfigQuery.find(tx, {
        tenantId: tenantA,
        branchId: branchA,
        menuItemId: menuItemA,
        modifierIds: [],
        categoryIds: [],
      }),
    );
    expect(result.menuItemRules).toEqual([]);
    expect(result.fallbackStationId).toBeNull();
  });

  it('missing tenant context fails closed (zero rows, no error)', async () => {
    const result = await prisma.withAuthContext({}, (tx) =>
      routingConfigQuery.find(tx, {
        tenantId: tenantA,
        branchId: branchA,
        menuItemId: menuItemA,
        modifierIds: [],
        categoryIds: [],
      }),
    );
    expect(result.menuItemRules).toEqual([]);
    expect(result.fallbackStationId).toBeNull();
  });

  it('the query result is unchanged from the pre-split shape (plain DTOs, no Prisma model leakage)', async () => {
    const result = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
      routingConfigQuery.find(tx, {
        tenantId: tenantA,
        branchId: branchA,
        menuItemId: menuItemA,
        modifierIds: [],
        categoryIds: [],
      }),
    );
    expect(Object.keys(result).sort()).toEqual(
      [
        'categoryRules',
        'fallbackStationId',
        'menuItemRules',
        'modifierRules',
      ].sort(),
    );
    expect(result.menuItemRules).toEqual([
      { ruleId: ruleA, stationId: stationA },
    ]);
  });
});
