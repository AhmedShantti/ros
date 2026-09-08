import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { CATALOGUE_PERMISSION_DEFS } from './../src/modules/catalogue/catalogue.permissions';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { createMigratorClient } from './rls-admin';

/**
 * DEMO-POS-MENU-BACKEND-P0 (e2e).
 *
 * Proves the REAL backend contract a Cashier POS session needs to read its
 * own branch's sellable menu: `GET /catalogue/pos-menu`. See
 * `src/modules/catalogue/pos-menu/pos-menu.service.ts` and
 * `CatalogueController#getPosMenu` for the implementation this exercises.
 */
describe('POS menu (e2e) — DEMO-POS-MENU-BACKEND-P0', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const password = 's3cure-passphrase';
  const stamp = Date.now();

  let tenantA: string;
  let brandA: string;
  let branchA1: string;
  let branchA2: string;
  let terminalA1: string;
  let employeeA: string;
  let employeeACode: string;
  let userA: string;
  let posToken: string;
  let dashboardToken: string;

  // Branch-1 fixtures.
  let menu1: string;
  let category1: string;
  let itemAvailable: string;
  let variantAvailable: string;
  let item86: string;
  let variant86: string;
  let modifierGroupId: string;
  let modifierId: string;

  // Branch-2 fixture — must NEVER appear in branch-1's pos-menu response.
  let itemOnBranch2: string;

  const PIN = '7391';

  const mkBrand = (tenantId: string) =>
    admin.brand
      .create({ data: { id: newId(), tenantId, name: `Brand ${stamp}` } })
      .then((b) => b.id);

  const mkBranch = async (tenantId: string, brandId: string, code: string) => {
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId,
        code,
        name: `Branch ${code}`,
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
    }).compile();
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

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const employees = app.get(EmployeesService);

    tenantA = (
      await tenants.create({
        slug: `pm-${stamp}`,
        legalName: `PM ${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    brandA = await mkBrand(tenantA);
    branchA1 = await mkBranch(tenantA, brandA, `PM1${stamp % 10000}`);
    branchA2 = await mkBranch(tenantA, brandA, `PM2${stamp % 10000}`);
    terminalA1 = await mkTerminal(tenantA, branchA1, 'PM-POS-1');

    userA = await users
      .createUser({
        email: `pm.a.${stamp}@example.com`,
        password,
        displayName: 'PM A',
      })
      .then((u) => u.id);
    await memberships.grant(userA, tenantA, 'active');

    employeeACode = `PMA${stamp % 1000}`;
    employeeA = (
      await employees.create(tenantA, userA, {
        code: employeeACode,
        displayName: 'PM Cashier',
        homeBranchId: branchA1,
        userId: userA,
      })
    ).id;

    // The exact three read permissions the Cashier canonical template grants
    // for menu (canonical-role-templates.ts CASHIER_PERMISSION_CODES) — used
    // directly rather than the full template so this suite does not also
    // need to bootstrap Sales/Treasury permissions it never exercises.
    const permissions = app.get(PermissionsService);
    for (const def of CATALOGUE_PERMISSION_DEFS) await permissions.upsert(def);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const cashier = await roles.createTenantRole(tenantA, {
      name: `pm-cashier-${stamp}`,
    });
    await roles.addPermissions(tenantA, cashier.id, [
      'menu.item.read',
      'menu.price.read',
      'menu.availability.read',
    ]);
    const membershipA = await admin.membership.findFirstOrThrow({
      where: { userId: userA, tenantId: tenantA },
    });
    await membershipRoles.create(tenantA, null, {
      membershipId: membershipA.id,
      roleId: cashier.id,
      scope: { type: 'tenant' },
    });

    const pins = app.get(PinService);
    await pins.setPin(tenantA, userA, employeeA, PIN);
    const login = await request(http).post('/auth/pin').send({
      tenantId: tenantA,
      terminalId: terminalA1,
      employeeCode: employeeACode,
      pin: PIN,
    });
    posToken = (login.body as { accessToken: string }).accessToken;

    // A dashboard (non-POS) session with the SAME permissions, to prove the
    // route is POS-only regardless of what a dashboard actor's own grants
    // cover — `posTerminalBranchTarget()` denies it outright.
    const dashLogin = await request(http)
      .post('/auth/login')
      .send({ email: `pm.a.${stamp}@example.com`, password });
    const bearer = (dashLogin.body as { accessToken: string }).accessToken;
    const tenantSelect = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ tenantId: tenantA });
    dashboardToken = (tenantSelect.body as { accessToken: string }).accessToken;

    // ---------------------------------------------------------- catalogue --
    menu1 = (
      await admin.menu.create({
        data: { id: newId(), tenantId: tenantA, name: { en: 'Main Menu' } },
      })
    ).id;
    await admin.menuBranch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuId: menu1,
        branchId: branchA1,
      },
    });
    category1 = (
      await admin.category.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuId: menu1,
          name: { en: 'Mains' },
        },
      })
    ).id;

    // A real, sellable item: active item + active variant + a branch-scoped
    // price entry + a linked modifier group.
    itemAvailable = (
      await admin.menuItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          names: { en: 'Grilled Chicken' },
        },
      })
    ).id;
    await admin.menuItemPlacement.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: itemAvailable,
        categoryId: category1,
      },
    });
    variantAvailable = (
      await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId: itemAvailable,
          name: { en: 'Regular' },
        },
      })
    ).id;
    const priceList1 = (
      await admin.priceList.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          name: `PM branch price ${stamp}`,
          scopeType: 'branch',
          scopeId: branchA1,
          priority: 0,
          status: 'active',
        },
      })
    ).id;
    await admin.priceEntry.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        priceListId: priceList1,
        menuItemVariantId: variantAvailable,
        price: 4500n,
        currency: 'EGP',
      },
    });
    modifierGroupId = (
      await admin.modifierGroup.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          name: { en: 'Spice level' },
          minSelections: 1,
          maxSelections: 1,
          isRequired: true,
        },
      })
    ).id;
    modifierId = (
      await admin.modifier.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          modifierGroupId,
          name: { en: 'Extra spicy' },
          kind: 'addition',
          priceDelta: 0n,
          isDefault: true,
        },
      })
    ).id;
    await admin.modifierGroupLink.create({
      data: { tenantId: tenantA, menuItemId: itemAvailable, modifierGroupId },
    });

    // A second item, manually 86'd at branch-1 — must still appear, but with
    // isAvailable: false (FR-MNU-030/031).
    item86 = (
      await admin.menuItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          names: { en: 'Sold Out Soup' },
        },
      })
    ).id;
    await admin.menuItemPlacement.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: item86,
        categoryId: category1,
      },
    });
    variant86 = (
      await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuItemId: item86,
          name: { en: 'Bowl' },
        },
      })
    ).id;
    await admin.availabilityRule.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: item86,
        branchId: branchA1,
        isManual86: true,
      },
    });

    // Branch-2's own menu/item — assigned ONLY to branch-2.
    const menu2 = (
      await admin.menu.create({
        data: { id: newId(), tenantId: tenantA, name: { en: 'Branch 2 Menu' } },
      })
    ).id;
    await admin.menuBranch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuId: menu2,
        branchId: branchA2,
      },
    });
    const category2 = (
      await admin.category.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          menuId: menu2,
          name: { en: 'Branch 2 Mains' },
        },
      })
    ).id;
    itemOnBranch2 = (
      await admin.menuItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          names: { en: 'Branch 2 Only' },
        },
      })
    ).id;
    await admin.menuItemPlacement.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: itemOnBranch2,
        categoryId: category2,
      },
    });
    await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        menuItemId: itemOnBranch2,
        name: { en: 'Regular' },
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('a Cashier POS session reads its own branch menu -> 200 with real configured data', async () => {
    const res = await request(http)
      .get('/catalogue/pos-menu')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(200);

    const body = res.body as {
      branchId: string;
      items: Array<{
        id: string;
        names: Record<string, string>;
        isAvailable: boolean;
        variants: Array<{
          id: string;
          isAvailable: boolean;
          price: { amountMinorUnits: string; currency: string } | null;
        }>;
        modifierGroups: Array<{ id: string; modifiers: Array<{ id: string }> }>;
      }>;
      categories: Array<{ id: string; itemIds: string[] }>;
    };

    expect(body.branchId).toBe(branchA1);

    const item = body.items.find((i) => i.id === itemAvailable);
    expect(item).toBeDefined();
    expect(item!.isAvailable).toBe(true);
    expect(item!.names).toEqual({ en: 'Grilled Chicken' });

    const variant = item!.variants.find((v) => v.id === variantAvailable);
    expect(variant).toBeDefined();
    expect(variant!.isAvailable).toBe(true);
    // The REAL configured price (4500 minor units == 45.00 EGP), resolved
    // through the SAME PriceResolutionService Sales uses at line capture.
    expect(variant!.price).toEqual({
      amountMinorUnits: '4500',
      currency: 'EGP',
    });

    expect(item!.modifierGroups).toHaveLength(1);
    expect(item!.modifierGroups[0].id).toBe(modifierGroupId);
    expect(item!.modifierGroups[0].modifiers.map((m) => m.id)).toEqual([
      modifierId,
    ]);

    const category = body.categories.find((c) => c.id === category1);
    expect(category?.itemIds).toEqual(
      expect.arrayContaining([itemAvailable, item86]),
    );
  });

  it("a manually 86'd item is still returned, but isAvailable: false", async () => {
    const res = await request(http)
      .get('/catalogue/pos-menu')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(200);

    const body = res.body as {
      items: Array<{
        id: string;
        isAvailable: boolean;
        variants: Array<{ id: string; isAvailable: boolean }>;
      }>;
    };
    const item = body.items.find((i) => i.id === item86);
    expect(item).toBeDefined();
    expect(item!.isAvailable).toBe(false);
    // The 86 rule targets the ITEM, not the variant directly — the variant
    // still reports unavailable too, because it inherits its item's 86.
    const variant = item!.variants.find((v) => v.id === variant86);
    expect(variant).toBeDefined();
    expect(variant!.isAvailable).toBe(false);
  });

  it("never returns another branch's items, even within the same tenant", async () => {
    const res = await request(http)
      .get('/catalogue/pos-menu')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(200);

    const body = res.body as { items: Array<{ id: string }> };
    expect(body.items.some((i) => i.id === itemOnBranch2)).toBe(false);
  });

  it('a dashboard (non-POS) session with the SAME permissions is refused -> 403', async () => {
    await request(http)
      .get('/catalogue/pos-menu')
      .set('Authorization', `Bearer ${dashboardToken}`)
      .expect(403);
  });

  it('the POS session still cannot reach the tenant-wide admin catalogue reads -> 403', async () => {
    await request(http)
      .get('/catalogue/items')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(403);
    await request(http)
      .get('/catalogue/availability-rules')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(403);
  });

  it('the POS session cannot mutate the catalogue -> 403', async () => {
    await request(http)
      .post('/catalogue/items')
      .set('Authorization', `Bearer ${posToken}`)
      .send({ names: { en: 'Hack' } })
      .expect(403);
    await request(http)
      .post('/catalogue/availability-rules')
      .set('Authorization', `Bearer ${posToken}`)
      .send({ menuItemId: itemAvailable })
      .expect(403);
  });

  it('an unauthenticated caller is refused -> 401', async () => {
    await request(http).get('/catalogue/pos-menu').expect(401);
  });
});
