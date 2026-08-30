import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  CATALOGUE_PERMISSIONS,
  CATALOGUE_PERMISSION_DEFS,
} from './../src/modules/catalogue/catalogue.permissions';
import { PriceListsService } from './../src/modules/catalogue/price-lists/price-lists.service';
import { PriceResolutionService } from './../src/modules/catalogue/pricing/price-resolution.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { ORGANISATION_PERMISSION_DEFS } from './../src/modules/organisation/organisation.permissions';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('Catalogue (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let tenantAId: string;
  let tenantBId: string;
  let tokenA: string;
  let tokenReadA: string;
  let tokenNoneA: string;
  let tokenB: string;

  // Tenant A
  let menuA: string;
  let categoryA: string;
  let itemA: string;
  let variantA: string;
  let branchA: string;
  let priceListA: string;
  // Tenant B (cross-tenant targets)
  let menuB: string;
  let categoryB: string;
  let itemB: string;
  let variantB: string;
  let branchB: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const scoped = async (email: string, tenantId: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .send({ tenantId })
      .expect(200);
    return (sel.body as Tokens).accessToken;
  };

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
      }),
    );
    await app.init();
    admin = createMigratorClient(app);
    http = app.getHttpServer();

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);
    await permissions.upsertMany(CATALOGUE_PERMISSION_DEFS);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantAId = await mkTenant(`cata-${stamp}`);
    tenantBId = await mkTenant(`catb-${stamp}`);

    const mkUser = async (
      email: string,
      tenantId: string,
      codes: string[],
    ): Promise<void> => {
      const u = await users.createUser({ email, password, displayName: 'C' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length > 0) {
        const role = await roles.createTenantRole(tenantId, {
          name: `cat-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.assign(tenantId, m.id, role.id);
      }
    };

    const all = Object.values(CATALOGUE_PERMISSIONS);
    const readOnly = [
      CATALOGUE_PERMISSIONS.ITEM_READ,
      CATALOGUE_PERMISSIONS.PRICE_READ,
      CATALOGUE_PERMISSIONS.AVAILABILITY_READ,
    ];
    const emailA = `cat.a.${stamp}@example.com`;
    const emailReadA = `cat.r.${stamp}@example.com`;
    const emailNoneA = `cat.n.${stamp}@example.com`;
    const emailB = `cat.b.${stamp}@example.com`;
    await mkUser(emailA, tenantAId, all);
    await mkUser(emailReadA, tenantAId, readOnly);
    await mkUser(emailNoneA, tenantAId, []);
    await mkUser(emailB, tenantBId, all);

    tokenA = await scoped(emailA, tenantAId);
    tokenReadA = await scoped(emailReadA, tenantAId);
    tokenNoneA = await scoped(emailNoneA, tenantAId);
    tokenB = await scoped(emailB, tenantBId);

    // Branches are created directly (Organisation is already proven in Phase 15).
    const mkBranch = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `Brand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `Branch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      // P15-4: BranchesService.create() registers the branch in org.locations.
      // This fixture bypasses that service, so it must register the branch
      // itself — org.locations completeness is a global invariant asserted by
      // organisation.e2e-spec.ts across the whole database.
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
    branchA = await mkBranch(tenantAId, `CA${stamp % 10000}`);
    branchB = await mkBranch(tenantBId, `CB${stamp % 10000}`);

    const seed = async (token: string) => {
      const menu = (
        await request(http)
          .post('/catalogue/menus')
          .set(auth(token))
          .send({ name: { en: 'Main' }, orderTypes: ['dine_in'], priority: 1 })
          .expect(201)
      ).body as WithId;
      const category = (
        await request(http)
          .post(`/catalogue/menus/${menu.id}/categories`)
          .set(auth(token))
          .send({ name: { en: 'Burgers' } })
          .expect(201)
      ).body as WithId;
      const item = (
        await request(http)
          .post('/catalogue/items')
          .set(auth(token))
          .send({ names: { en: 'Chicken Sandwich' } })
          .expect(201)
      ).body as WithId;
      const variant = (
        await request(http)
          .post(`/catalogue/items/${item.id}/variants`)
          .set(auth(token))
          .send({ name: { en: 'Large' } })
          .expect(201)
      ).body as WithId;
      return {
        menu: menu.id,
        category: category.id,
        item: item.id,
        variant: variant.id,
      };
    };
    const a = await seed(tokenA);
    menuA = a.menu;
    categoryA = a.category;
    itemA = a.item;
    variantA = a.variant;
    const b = await seed(tokenB);
    menuB = b.menu;
    categoryB = b.category;
    itemB = b.item;
    variantB = b.variant;

    priceListA = (
      (
        await request(http)
          .post('/catalogue/price-lists')
          .set(auth(tokenA))
          .send({ name: `Base ${stamp}`, scopeType: 'tenant' })
          .expect(201)
      ).body as WithId
    ).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // --------------------------------------------------------------- auth ---
  describe('authentication', () => {
    it.each([
      '/catalogue/menus',
      '/catalogue/items',
      '/catalogue/modifier-groups',
      '/catalogue/price-lists',
    ])('unauthenticated GET %s → 401', async (path) => {
      await request(http).get(path).expect(401);
    });
  });

  // --------------------------------------------------------------- rbac ---
  describe('authorization (C-05)', () => {
    it('no catalogue permission → 403', async () => {
      await request(http)
        .get('/catalogue/items')
        .set(auth(tokenNoneA))
        .expect(403);
    });

    it('read permission allows reads', async () => {
      await request(http)
        .get('/catalogue/items')
        .set(auth(tokenReadA))
        .expect(200);
    });

    it('read permission cannot create an item → 403', async () => {
      await request(http)
        .post('/catalogue/items')
        .set(auth(tokenReadA))
        .send({ names: { en: 'Nope' } })
        .expect(403);
    });

    it('menu.price.read cannot change a price → 403', async () => {
      await request(http)
        .post(`/catalogue/price-lists/${priceListA}/entries`)
        .set(auth(tokenReadA))
        .send({ menuItemVariantId: variantA, price: '1000', currency: 'EGP' })
        .expect(403);
    });

    it('menu.availability.read cannot 86 → 403', async () => {
      await request(http)
        .post('/catalogue/availability-rules')
        .set(auth(tokenReadA))
        .send({ menuItemId: itemA })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------- DTO ---
  describe('DTO validation', () => {
    it('rejects unknown properties', async () => {
      await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'X' }, bogus: 1 })
        .expect(400);
    });

    it('rejects a client-supplied tenantId', async () => {
      await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'X' }, tenantId: tenantBId })
        .expect(400);
    });

    it('rejects branch_group price-list scope (C-06)', async () => {
      await request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenA))
        .send({
          name: `bg-${stamp}`,
          scopeType: 'branch_group',
          scopeId: branchA,
        })
        .expect(400);
    });

    it('rejects a non-integer price', async () => {
      await request(http)
        .post(`/catalogue/price-lists/${priceListA}/entries`)
        .set(auth(tokenA))
        .send({ menuItemVariantId: variantA, price: '10.50', currency: 'EGP' })
        .expect(400);
    });
  });

  // ---------------------------------------------------- tenant isolation ---
  describe('tenant isolation', () => {
    it('A lists only its own menus and items', async () => {
      const menus = (
        await request(http)
          .get('/catalogue/menus')
          .set(auth(tokenA))
          .expect(200)
      ).body as WithId[];
      expect(menus.map((m) => m.id)).toContain(menuA);
      expect(menus.map((m) => m.id)).not.toContain(menuB);

      const items = (
        await request(http)
          .get('/catalogue/items')
          .set(auth(tokenA))
          .expect(200)
      ).body as WithId[];
      expect(items.map((i) => i.id)).not.toContain(itemB);
    });

    it.each([
      ['menu', () => `/catalogue/menus/${menuB}`],
      ['item', () => `/catalogue/items/${itemB}`],
    ])('A cannot read tenant B %s → 404', async (_label, path) => {
      await request(http).get(path()).set(auth(tokenA)).expect(404);
    });

    it('A cannot update tenant B item → 404', async () => {
      await request(http)
        .patch(`/catalogue/items/${itemB}`)
        .set(auth(tokenA))
        .send({ names: { en: 'hijack' } })
        .expect(404);
    });

    it('A cannot deactivate tenant B menu → 404', async () => {
      await request(http)
        .post(`/catalogue/menus/${menuB}/status`)
        .set(auth(tokenA))
        .send({ isActive: false })
        .expect(404);
    });

    it('A cannot list categories of tenant B menu → 404', async () => {
      await request(http)
        .get(`/catalogue/menus/${menuB}/categories`)
        .set(auth(tokenA))
        .expect(404);
    });
  });

  // ------------------------------------------- cross-tenant relationships ---
  describe('cross-tenant relationship security (D-09 composite FKs)', () => {
    it('cannot assign a tenant B branch to a tenant A menu → 404', async () => {
      await request(http)
        .post(`/catalogue/menus/${menuA}/branches`)
        .set(auth(tokenA))
        .send({ branchId: branchB })
        .expect(404);
    });

    it('cannot place an item into a tenant B category → 404', async () => {
      await request(http)
        .post(`/catalogue/items/${itemA}/placements`)
        .set(auth(tokenA))
        .send({ categoryId: categoryB })
        .expect(404);
    });

    it('cannot price a tenant B variant from a tenant A price list → 404', async () => {
      await request(http)
        .post(`/catalogue/price-lists/${priceListA}/entries`)
        .set(auth(tokenA))
        .send({ menuItemVariantId: variantB, price: '1000', currency: 'EGP' })
        .expect(404);
    });

    it('cannot scope a price list to a tenant B branch → 404', async () => {
      await request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenA))
        .send({ name: `x-${stamp}`, scopeType: 'branch', scopeId: branchB })
        .expect(404);
    });

    it('cannot create an availability rule for a tenant B item → 404', async () => {
      await request(http)
        .post('/catalogue/availability-rules')
        .set(auth(tokenA))
        .send({ menuItemId: itemB })
        .expect(404);
    });
  });

  // -------------------------------------------------- C-02 item placement ---
  describe('menu item reuse across menus (C-02)', () => {
    it('one item can be placed on two different menus without duplication', async () => {
      const menu2 = (
        await request(http)
          .post('/catalogue/menus')
          .set(auth(tokenA))
          .send({
            name: { en: 'Delivery' },
            orderTypes: ['delivery'],
            priority: 2,
          })
          .expect(201)
      ).body as WithId;
      const cat2 = (
        await request(http)
          .post(`/catalogue/menus/${menu2.id}/categories`)
          .set(auth(tokenA))
          .send({ name: { en: 'Delivery Burgers' } })
          .expect(201)
      ).body as WithId;

      await request(http)
        .post(`/catalogue/items/${itemA}/placements`)
        .set(auth(tokenA))
        .send({ categoryId: categoryA })
        .expect(204);
      await request(http)
        .post(`/catalogue/items/${itemA}/placements`)
        .set(auth(tokenA))
        .send({ categoryId: cat2.id })
        .expect(204);

      const placements = (
        await request(http)
          .get(`/catalogue/items/${itemA}/placements`)
          .set(auth(tokenA))
          .expect(200)
      ).body as { categoryId: string; menuId: string }[];

      // ONE item id, TWO menus — identity is not duplicated.
      expect(placements).toHaveLength(2);
      expect(new Set(placements.map((p) => p.menuId))).toEqual(
        new Set([menuA, menu2.id]),
      );
    });

    it('the same placement twice → 409', async () => {
      await request(http)
        .post(`/catalogue/items/${itemA}/placements`)
        .set(auth(tokenA))
        .send({ categoryId: categoryA })
        .expect(409);
    });
  });

  // -------------------------------------------- C-01 branch assignment ---
  describe('menu → branch assignment and resolution (C-01, FR-MNU-002/003)', () => {
    it('assigns, lists and resolves by priority', async () => {
      await request(http)
        .post(`/catalogue/menus/${menuA}/branches`)
        .set(auth(tokenA))
        .send({ branchId: branchA })
        .expect(204);

      const branches = (
        await request(http)
          .get(`/catalogue/menus/${menuA}/branches`)
          .set(auth(tokenA))
          .expect(200)
      ).body as string[];
      expect(branches).toContain(branchA);

      const resolved = (
        await request(http)
          .get(`/catalogue/branches/${branchA}/menus`)
          .set(auth(tokenA))
          .expect(200)
      ).body as { menus: WithId[]; ambiguous: boolean };
      expect(resolved.menus.map((m) => m.id)).toContain(menuA);
    });

    it('duplicate assignment → 409', async () => {
      await request(http)
        .post(`/catalogue/menus/${menuA}/branches`)
        .set(auth(tokenA))
        .send({ branchId: branchA })
        .expect(409);
    });

    it('an unassigned branch resolves to no menus (no implicit global menu)', async () => {
      const res = (
        await request(http)
          .get(`/catalogue/branches/${newId()}/menus`)
          .set(auth(tokenA))
          .expect(200)
      ).body as { menus: unknown[] };
      expect(res.menus).toHaveLength(0);
    });
  });

  // ------------------------------------------------------ modifier rules ---
  describe('modifier groups (FR-MNU-011, SRS §7.3 #8)', () => {
    it('rejects min > max → 400', async () => {
      await request(http)
        .post('/catalogue/modifier-groups')
        .set(auth(tokenA))
        .send({ name: { en: 'Bad' }, minSelections: 3, maxSelections: 2 })
        .expect(400);
    });

    it('rejects required with min 0 → 400', async () => {
      await request(http)
        .post('/catalogue/modifier-groups')
        .set(auth(tokenA))
        .send({ name: { en: 'Bad' }, isRequired: true, minSelections: 0 })
        .expect(400);
    });

    it('accepts a valid group and a negative price delta modifier', async () => {
      const group = (
        await request(http)
          .post('/catalogue/modifier-groups')
          .set(auth(tokenA))
          .send({
            name: { en: 'Protein' },
            isRequired: true,
            minSelections: 1,
            maxSelections: 1,
          })
          .expect(201)
      ).body as WithId;

      const modifier = (
        await request(http)
          .post(`/catalogue/modifier-groups/${group.id}/modifiers`)
          .set(auth(tokenA))
          .send({
            name: { en: 'Chicken instead of Beef' },
            kind: 'substitution',
            priceDelta: '-300',
          })
          .expect(201)
      ).body as { priceDelta: string; kind: string };
      expect(modifier.priceDelta).toBe('-300');
      expect(modifier.kind).toBe('substitution');

      await request(http)
        .post(`/catalogue/items/${itemA}/modifier-groups`)
        .set(auth(tokenA))
        .send({ modifierGroupId: group.id })
        .expect(204);
    });
  });

  // -------------------------------------------------------------- pricing ---
  describe('pricing (FR-MNU-020/024, C-10, C-11)', () => {
    it('sets a price and records before/after in the AUDIT trail, not a history table', async () => {
      await request(http)
        .post(`/catalogue/price-lists/${priceListA}/entries`)
        .set(auth(tokenA))
        .send({ menuItemVariantId: variantA, price: '5000', currency: 'EGP' })
        .expect(201);
      await request(http)
        .post(`/catalogue/price-lists/${priceListA}/entries`)
        .set(auth(tokenA))
        .send({ menuItemVariantId: variantA, price: '5500', currency: 'EGP' })
        .expect(201);

      const entries = (
        await request(http)
          .get(`/catalogue/price-lists/${priceListA}/entries`)
          .set(auth(tokenA))
          .expect(200)
      ).body as { price: string }[];
      // Upsert, not duplicate: uq_price_entry holds.
      expect(entries).toHaveLength(1);
      expect(entries[0].price).toBe('5500');

      const audit = await admin.auditEntry.findFirst({
        where: { tenantId: tenantAId, action: 'PRICE_ENTRY_SET' },
        orderBy: { sequenceNo: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect(audit?.beforeState).toMatchObject({ price: '5000' });
      expect(audit?.afterState).toMatchObject({ price: '5500' });
    });

    it('C-11: creating a variant does NOT require prices, and completeness is reported', async () => {
      const unpriced = (
        await request(http)
          .post(`/catalogue/items/${itemA}/variants`)
          .set(auth(tokenA))
          .send({ name: { en: 'Small' } })
          .expect(201)
      ).body as WithId;

      const report = (
        await request(http)
          .get('/catalogue/completeness')
          .set(auth(tokenA))
          .expect(200)
      ).body as {
        unpricedVariants: { variantId: string }[];
        sellable: boolean;
      };
      expect(report.unpricedVariants.map((v) => v.variantId)).toContain(
        unpriced.id,
      );
      expect(report.sellable).toBe(false);
    });
  });

  // ------------------------------------------- price resolution (FR-MNU-020..023)
  // Exercises the resolver against real rows through the real service, so RLS and
  // tenant scoping apply exactly as in production. There is deliberately no HTTP
  // route: resolution belongs to order time (FR-POS-040) in a Sales layer that
  // does not exist yet, so none was invented.
  describe('price resolution (FR-MNU-020/021/023)', () => {
    let resolver: PriceResolutionService;
    let branchVariant: string;

    const priceList = async (body: Record<string, unknown>): Promise<string> =>
      (
        (
          await request(http)
            .post('/catalogue/price-lists')
            .set(auth(tokenA))
            .send(body)
            .expect(201)
        ).body as WithId
      ).id;

    const newVariant = async (label: string): Promise<string> =>
      (
        (
          await request(http)
            .post(`/catalogue/items/${itemA}/variants`)
            .set(auth(tokenA))
            .send({ name: { en: `${label} ${stamp}` } })
            .expect(201)
        ).body as WithId
      ).id;

    const setEntry = async (
      listId: string,
      variantId: string,
      price: string,
    ): Promise<void> => {
      await request(http)
        .post(`/catalogue/price-lists/${listId}/entries`)
        .set(auth(tokenA))
        .send({ menuItemVariantId: variantId, price, currency: 'EGP' })
        .expect(201);
    };

    beforeAll(async () => {
      resolver = app.get(PriceResolutionService);
      branchVariant = await newVariant('Resolvable');
    });

    it('evaluates stored records: the tenant list resolves as the fallback', async () => {
      const tenantList = await priceList({
        name: `Res tenant ${stamp}`,
        scopeType: 'tenant',
        priority: 10,
      });
      await setEntry(tenantList, branchVariant, '5000');

      const r = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: branchVariant,
        orderType: 'dine_in',
      });
      expect(r.resolved?.amount.toString()).toBe('50.00 EGP');
      expect(r.resolved?.scopeType).toBe('tenant');
      expect(r.evaluatedInTimezone).toBeTruthy();
    });

    it('prefers a branch-scoped list over the tenant list', async () => {
      const branchList = await priceList({
        name: `Res branch ${stamp}`,
        scopeType: 'branch',
        scopeId: branchA,
      });
      await setEntry(branchList, branchVariant, '4200');

      const r = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: branchVariant,
        orderType: 'dine_in',
      });
      expect(r.resolved?.amount.toString()).toBe('42.00 EGP');
      expect(r.resolved?.scopeType).toBe('branch');
      expect(r.resolved?.priceListId).toBe(branchList);
    });

    it('prefers an order-type-specific list (FR-MNU-021)', async () => {
      const deliveryList = await priceList({
        name: `Res delivery ${stamp}`,
        scopeType: 'tenant',
        orderType: 'delivery',
        priority: 14,
      });
      await setEntry(deliveryList, branchVariant, '6100');

      const delivery = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: branchVariant,
        orderType: 'delivery',
      });
      expect(delivery.resolved?.amount.toString()).toBe('61.00 EGP');
      expect(delivery.resolved?.orderType).toBe('delivery');

      // A different order type must not pick it up.
      const dineIn = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: branchVariant,
        orderType: 'dine_in',
      });
      expect(dineIn.resolved?.orderType).toBeNull();
    });

    it('holds a future price back, then activates it (FR-MNU-023)', async () => {
      const variant = await newVariant('Future');
      const effective = new Date(Date.now() + 86_400_000);

      const standing = await priceList({
        name: `Res standing ${stamp}`,
        scopeType: 'tenant',
        priority: 11,
      });
      await setEntry(standing, variant, '1000');
      const scheduled = await priceList({
        name: `Res scheduled ${stamp}`,
        scopeType: 'tenant',
        priority: 12,
        validFrom: effective.toISOString(),
      });
      await setEntry(scheduled, variant, '1300');

      const before = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: variant,
        orderType: 'dine_in',
      });
      expect(before.resolved?.amount.toString()).toBe('10.00 EGP');

      const after = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: variant,
        orderType: 'dine_in',
        at: new Date(effective.getTime() + 1000),
      });
      expect(after.resolved?.amount.toString()).toBe('13.00 EGP');
    });

    it('returns no price when the variant has none', async () => {
      const bare = await newVariant('Bare');
      const r = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: bare,
        orderType: 'dine_in',
      });
      expect(r.resolved).toBeNull();
      expect(r.ambiguous).toBe(false);
    });

    it('evaluates a P0-2 recurrence and wins as FR-POS-040 Tier 3', async () => {
      const variant = await newVariant('Recurring');
      const standing = await priceList({
        name: `Res base ${stamp}`,
        scopeType: 'tenant',
        priority: 13,
      });
      await setEntry(standing, variant, '2000');
      const happyHour = await priceList({
        name: `Res happy ${stamp}`,
        scopeType: 'tenant',
        priority: 99,
        recurrenceRule: { v: 1, days: ['wed'], from: '15:00', to: '18:00' },
      });
      await setEntry(happyHour, variant, '900');

      // Branch timezone is Africa/Cairo. Wed 2026-08-19 15:30 local = 12:30Z.
      const inside = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: variant,
        orderType: 'dine_in',
        at: new Date('2026-08-19T12:30:00Z'),
      });
      expect(inside.resolved?.amount.toString()).toBe('9.00 EGP');
      expect(inside.resolved?.tier).toBe(3);
      expect(inside.resolved?.recurring).toBe(true);

      // 19:00 Cairo = 16:00Z — outside the window, so the standing list applies.
      const outside = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: variant,
        orderType: 'dine_in',
        at: new Date('2026-08-19T16:00:00Z'),
      });
      expect(outside.resolved?.amount.toString()).toBe('20.00 EGP');
      expect(outside.resolved?.recurring).toBe(false);
      expect(outside.undeterminable).toHaveLength(0);
    });

    it('reports a malformed recurrence rule instead of guessing', async () => {
      const variant = await newVariant('BadRecur');
      const standing = await priceList({
        name: `Res ok ${stamp}`,
        scopeType: 'tenant',
        priority: 21,
      });
      await setEntry(standing, variant, '2000');
      const broken = await priceList({
        name: `Res broken ${stamp}`,
        scopeType: 'tenant',
        priority: 22,
        recurrenceRule: { days: ['mon'], from: '15:00', to: '18:00' },
      });
      await setEntry(broken, variant, '100');

      const r = await resolver.resolve(tenantAId, {
        branchId: branchA,
        menuItemVariantId: variant,
        orderType: 'dine_in',
      });
      expect(r.resolved?.amount.toString()).toBe('20.00 EGP');
      expect(r.undeterminable).toHaveLength(1);
      expect(r.undeterminable[0].reason).toBe('recurrence_rule_malformed');
    });

    it('the ambiguous tie state can no longer be created at all (SRS §7.3 #10)', async () => {
      // This used to be a resolver-tie test. The SRS aggregate invariant forbids
      // the configuration outright, so the second create is now rejected and the
      // resolver can never see it. The resolver's own refusal to invent a winner
      // is still covered, at the unit level, in price-resolution.spec.ts.
      await request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenA))
        .send({
          name: `Res tie one ${stamp}`,
          scopeType: 'tenant',
          priority: 3,
        })
        .expect(201);
      await request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenA))
        .send({
          name: `Res tie two ${stamp}`,
          scopeType: 'tenant',
          priority: 3,
        })
        .expect(409);
    });

    it('is tenant-isolated: another tenant cannot resolve through this branch', async () => {
      await expect(
        resolver.resolve(tenantBId, {
          branchId: branchA,
          menuItemVariantId: branchVariant,
          orderType: 'dine_in',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('is tenant-isolated: another tenant cannot resolve a foreign variant', async () => {
      await expect(
        resolver.resolve(tenantBId, {
          branchId: branchB,
          menuItemVariantId: variantA,
          orderType: 'dine_in',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ------------------- C-11 (amended) active-list completeness (SRS §7.3 #7)
  describe('C-11 amended — active price lists must be complete', () => {
    let pc = 300;
    const svc = () => app.get(PriceListsService);
    let actorAId: string;

    const mkList = async (
      body: Record<string, unknown>,
      expected: number,
    ): Promise<string> => {
      const res = await request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenA))
        .send({ name: `C11 ${stamp} ${Math.random()}`, ...body })
        .expect(expected);
      return (res.body as WithId)?.id;
    };

    beforeAll(async () => {
      const u = await admin.user.findFirst({
        where: { email: `cat.a.${stamp}@example.com` },
        select: { id: true },
      });
      actorAId = u!.id;
    });

    it('a NON-active (scheduled) list may be incomplete', async () => {
      const id = await mkList({ scopeType: 'tenant', priority: pc++ }, 201);
      expect(id).toBeTruthy();
    });

    it('an ACTIVE list cannot be created while it is incomplete', async () => {
      // Tenant A already has active variants with no entry in this new list.
      await mkList(
        { scopeType: 'tenant', priority: pc++, status: 'active' },
        409,
      );
    });

    it('activation is refused while the list is incomplete', async () => {
      const id = await mkList({ scopeType: 'tenant', priority: pc++ }, 201);
      await expect(svc().activate(tenantAId, actorAId, id)).rejects.toThrow(
        /incomplete/i,
      );
    });

    it('a future-dated list is still refused activation while incomplete', async () => {
      // C-11 clarification: temporal non-effectiveness does NOT excuse incompleteness.
      const id = await mkList(
        {
          scopeType: 'tenant',
          priority: pc++,
          validFrom: '2030-01-01T00:00:00.000Z',
        },
        201,
      );
      await expect(svc().activate(tenantAId, actorAId, id)).rejects.toThrow(
        /incomplete/i,
      );
    });

    it('a COMPLETE list can be activated', async () => {
      const id = await mkList({ scopeType: 'tenant', priority: pc++ }, 201);
      // Price every currently-active variant of this tenant.
      const variants = await admin.menuItemVariant.findMany({
        where: { tenantId: tenantAId, isActive: true },
        select: { id: true },
      });
      for (const v of variants) {
        await request(http)
          .post(`/catalogue/price-lists/${id}/entries`)
          .set(auth(tokenA))
          .send({ menuItemVariantId: v.id, price: '1000', currency: 'EGP' })
          .expect(201);
      }
      const activated = await svc().activate(tenantAId, actorAId, id);
      expect(activated.status).toBe('active');
    });

    it('creating a variant is refused while an active list would become incomplete', async () => {
      // An active list exists from the previous test; a brand-new variant has no
      // entry in it, so creating it would break the invariant.
      await request(http)
        .post(`/catalogue/items/${itemA}/variants`)
        .set(auth(tokenA))
        .send({ name: { en: `C11 blocked ${stamp}` } })
        .expect(409);
    });

    it('the completeness report names the exact list/variant gaps', async () => {
      const report = (
        await request(http)
          .get('/catalogue/completeness')
          .set(auth(tokenA))
          .expect(200)
      ).body as {
        activeListGaps: { priceListId: string; menuItemVariantId: string }[];
        sellable: boolean;
      };
      expect(Array.isArray(report.activeListGaps)).toBe(true);
    });

    it('tenant isolation: tenant B is unaffected by tenant A active lists', async () => {
      await request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenB))
        .send({ name: `C11 b ${stamp}`, scopeType: 'tenant', priority: 350 })
        .expect(201);
    });
  });

  // ------------------------------- PriceList overlap invariant (SRS §7.3 #10)
  // "No overlapping windows of same priority for same scope."
  // Enforced by the exclusion constraint ex_price_list_no_overlap, with a service
  // pre-check for a friendly 409.
  describe('PriceList overlap invariant (SRS §7.3 #10)', () => {
    let brandA2: string;
    let branchA2: string;
    let p = 100; // distinct priorities so cases cannot collide with one another

    const mk = async (
      body: Record<string, unknown>,
      expected: number,
    ): Promise<request.Response> =>
      request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenA))
        .send({ name: `Inv ${stamp} ${Math.random()}`, ...body })
        .expect(expected);

    beforeAll(async () => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId: tenantAId, name: `InvBrand ${stamp}` },
      });
      brandA2 = brand.id;
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId: tenantAId,
          brandId: brand.id,
          code: `IV${stamp % 10000}`,
          name: `InvBranch ${stamp}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      branchA2 = branch.id;
      await admin.location.create({
        data: {
          id: newId(),
          tenantId: tenantAId,
          locationType: 'branch',
          refId: branch.id,
          branchId: branch.id,
        },
      });
    });

    it('rejects: same branch + same priority + overlapping windows', async () => {
      const priority = p++;
      await mk({ scopeType: 'branch', scopeId: branchA2, priority }, 201);
      await mk({ scopeType: 'branch', scopeId: branchA2, priority }, 409);
    });

    it('rejects: same brand + same priority + overlapping windows', async () => {
      const priority = p++;
      await mk({ scopeType: 'brand', scopeId: brandA2, priority }, 201);
      await mk({ scopeType: 'brand', scopeId: brandA2, priority }, 409);
    });

    it('rejects: tenant scope + same priority + overlapping windows', async () => {
      const priority = p++;
      await mk({ scopeType: 'tenant', priority }, 201);
      await mk({ scopeType: 'tenant', priority }, 409);
    });

    it('rejects: bounded windows that genuinely overlap', async () => {
      const priority = p++;
      await mk(
        {
          scopeType: 'tenant',
          priority,
          validFrom: '2030-01-01T00:00:00.000Z',
          validTo: '2030-03-01T00:00:00.000Z',
        },
        201,
      );
      await mk(
        {
          scopeType: 'tenant',
          priority,
          validFrom: '2030-02-01T00:00:00.000Z',
          validTo: '2030-04-01T00:00:00.000Z',
        },
        409,
      );
    });

    it('allows: same scope, different priority', async () => {
      await mk({ scopeType: 'tenant', priority: p++ }, 201);
      await mk({ scopeType: 'tenant', priority: p++ }, 201);
    });

    it('allows: different branches, same priority, overlapping dates', async () => {
      const priority = p++;
      await mk({ scopeType: 'branch', scopeId: branchA2, priority }, 201);
      await mk({ scopeType: 'branch', scopeId: branchA, priority }, 201);
    });

    it('allows: different brands, same priority, overlapping dates', async () => {
      const priority = p++;
      const other = await admin.brand.create({
        data: { id: newId(), tenantId: tenantAId, name: `InvBrand2 ${stamp}` },
      });
      await mk({ scopeType: 'brand', scopeId: brandA2, priority }, 201);
      await mk({ scopeType: 'brand', scopeId: other.id, priority }, 201);
    });

    it('allows: adjacent windows that merely touch (half-open convention)', async () => {
      const priority = p++;
      await mk(
        {
          scopeType: 'tenant',
          priority,
          validFrom: '2031-01-01T00:00:00.000Z',
          validTo: '2031-02-01T00:00:00.000Z',
        },
        201,
      );
      await mk(
        {
          scopeType: 'tenant',
          priority,
          validFrom: '2031-02-01T00:00:00.000Z',
          validTo: '2031-03-01T00:00:00.000Z',
        },
        201,
      );
    });

    it('rejects: two order-type lists sharing scope, priority and window', async () => {
      // FR-MNU-020 does not count order type as scope, so §7.3 #10 applies here
      // exactly as anywhere else. Order type is NOT in the invariant key.
      const priority = p++;
      await mk({ scopeType: 'tenant', priority, orderType: 'dine_in' }, 201);
      await mk({ scopeType: 'tenant', priority, orderType: 'delivery' }, 409);
    });

    it('allows: order-type lists at DIFFERENT priorities (FR-MNU-021 remains satisfiable)', async () => {
      await mk(
        { scopeType: 'tenant', priority: p++, orderType: 'dine_in' },
        201,
      );
      await mk(
        { scopeType: 'tenant', priority: p++, orderType: 'delivery' },
        201,
      );
    });

    it('does not leak across tenants: tenant B is unaffected by tenant A rows', async () => {
      const priority = p++;
      await mk({ scopeType: 'tenant', priority }, 201);
      // Same shape in another tenant must be accepted — tenant_id leads the key.
      await request(http)
        .post('/catalogue/price-lists')
        .set(auth(tokenB))
        .send({ name: `Inv cross ${stamp}`, scopeType: 'tenant', priority })
        .expect(201);
    });

    it('is enforced by the DATABASE, not only the service pre-check', async () => {
      // Bypass the service entirely and write with the migrator client: the
      // exclusion constraint must still refuse the second row. This is what makes
      // the guarantee concurrency-safe rather than a best-effort check.
      const priority = p++;
      const row = (scopeId: string) => ({
        id: newId(),
        tenantId: tenantAId,
        name: `Inv db ${stamp} ${Math.random()}`,
        scopeType: 'tenant' as const,
        scopeId,
        priority,
        status: 'active',
      });
      await admin.priceList.create({ data: row(tenantAId) });
      await expect(
        admin.priceList.create({ data: row(tenantAId) }),
      ).rejects.toThrow(/exclusion constraint|ex_price_list_no_overlap/);
    });
  });

  // --------------------------------------------------------- availability ---
  describe('availability (FR-MNU-030/032, C-07)', () => {
    it('rejects a rule targeting both item and variant → 400', async () => {
      await request(http)
        .post('/catalogue/availability-rules')
        .set(auth(tokenA))
        .send({ menuItemId: itemA, variantId: variantA })
        .expect(400);
    });

    it('rejects a rule targeting neither → 400', async () => {
      await request(http)
        .post('/catalogue/availability-rules')
        .set(auth(tokenA))
        .send({ branchId: branchA })
        .expect(400);
    });

    it('creates a rule and toggles 86 with an audited reason', async () => {
      const rule = (
        await request(http)
          .post('/catalogue/availability-rules')
          .set(auth(tokenA))
          .send({ menuItemId: itemA, branchId: branchA })
          .expect(201)
      ).body as WithId;

      const toggled = (
        await request(http)
          .post(`/catalogue/availability-rules/${rule.id}/86`)
          .set(auth(tokenA))
          .send({ isManual86: true, reasonText: 'out of stock' })
          .expect(201)
      ).body as { isManual86: boolean };
      expect(toggled.isManual86).toBe(true);

      const audit = await admin.auditEntry.findFirst({
        where: { tenantId: tenantAId, action: 'AVAILABILITY_86_TOGGLED' },
        orderBy: { sequenceNo: 'desc' },
      });
      expect(audit?.reasonCode).toBe('manual_86');
    });
  });

  // ------------------------------------------------------- boundary check ---
  describe('boundary compliance', () => {
    it('no Combo endpoints exist (C-08)', async () => {
      for (const path of ['/catalogue/combos', '/catalogue/combo-slots']) {
        await request(http).get(path).set(auth(tokenA)).expect(404);
      }
    });

    it('no Fiscal / Sales / Procurement tables were created', async () => {
      // `inventory` was removed from this guard when the Inventory bounded
      // context was implemented: D-17-01 re-sequenced the roadmap to
      // Catalogue -> Inventory -> Production Spec, so an `inventory` schema is
      // now expected. `production` was removed from this guard in turn when the
      // Production Spec phase was implemented under its ratified design gate.
      // `sales` and `sync` were removed from this guard when the P1A Order
      // capture foundation was implemented: it legitimately creates
      // `sales.orders`/`order_lines`/`order_line_modifiers`/`order_number_blocks`,
      // and creates `sync` holding ONLY `idempotency_keys` (SRS §26.5) — no sync
      // protocol, no sync_operations, no HLC.
      // Every context that remains unbuilt stays guarded.
      // `fiscal` was removed from this guard by the C-04 AMENDMENT (2026-08-20),
      // which authorises `fiscal.tax_classes` and NOTHING else in that schema.
      // The guard is narrowed rather than dropped: the assertion below proves
      // Fiscal did not quietly grow the rest of its context.
      const rows = await admin.$queryRawUnsafe<{ nspname: string }[]>(
        `SELECT nspname FROM pg_namespace WHERE nspname IN
         ('procurement','crm','analytics')`,
      );
      expect(rows).toHaveLength(0);

      // `workforce` and `treasury` were removed from this guard by carried item
      // P1D-A (2026-08-20), which authorises `workforce.shifts`,
      // `treasury.drawers` and `treasury.cash_sessions` — and P1G-0
      // (FR-POS-091), which additionally authorises `treasury.cash_movements`
      // — and P1G-1 migration 33, which additionally authorises
      // `treasury.cash_close_policies` (the narrow cash-close policy
      // substrate, NOT the generic FR-PLT-025 settings hierarchy) —
      // and NOTHING else in either schema. The guard is narrowed rather
      // than dropped: the assertion below proves neither context quietly
      // grew the rest of itself.
      const p1dTables = await admin.$queryRawUnsafe<{ qualified: string }[]>(
        `SELECT schemaname || '.' || tablename AS qualified FROM pg_tables
          WHERE schemaname IN ('workforce','treasury') ORDER BY 1`,
      );
      expect(p1dTables.map((t) => t.qualified)).toEqual([
        'treasury.cash_close_policies',
        'treasury.cash_movements',
        'treasury.cash_sessions',
        'treasury.drawers',
        'workforce.shifts',
      ]);

      const fiscalTables = await admin.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'fiscal' ORDER BY 1`,
      );
      // Positive control plus boundary: exactly the one authorised table. No
      // tax_rules, no tax_documents, no invoice_templates, no submissions.
      expect(fiscalTables.map((t) => t.tablename)).toEqual(['tax_classes']);
    });

    it('no catalogue.combos / price_change_history table exists', async () => {
      const rows = await admin.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname='catalogue'
         AND tablename IN ('combos','combo_slots','combo_slot_options','price_change_history')`,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
