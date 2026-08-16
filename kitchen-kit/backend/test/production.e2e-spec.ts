import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  PRODUCTION_PERMISSIONS,
  PRODUCTION_PERMISSION_DEFS,
} from './../src/modules/production/production.permissions';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}
interface VersionBody {
  id: string;
  version: number;
  status: string;
  effectiveFrom: string | null;
  computedCost: string | null;
  supersededVersionId?: string | null;
}

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('Production Spec (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let tenantAId: string;
  let tenantBId: string;
  let tokenAll: string;
  let tokenView: string;
  let tokenEdit: string;
  let tokenPublish: string;
  let tokenNone: string;
  let tokenB: string;

  let uomId: string;
  let brandA: string;
  let branchA: string;
  let brandB: string;
  let variantA: string;
  let variantB: string;
  let stockItemA: string;
  let stockItemB: string;

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

  /** Creates a sub_recipe-typed recipe (target = stock item) for tenant A. */
  const mkRecipe = async (
    token: string,
    body: Record<string, unknown>,
    expected = 201,
  ) =>
    (
      await request(http)
        .post('/recipes')
        .set(auth(token))
        .send(body)
        .expect(expected)
    ).body as WithId;

  const mkDraft = async (
    token: string,
    recipeId: string,
    extra: Record<string, unknown> = {},
    expected = 201,
  ) =>
    (
      await request(http)
        .post(`/recipes/${recipeId}/versions`)
        .set(auth(token))
        .send({ yieldQuantity: '10', yieldUnitId: uomId, ...extra })
        .expect(expected)
    ).body as VersionBody;

  const mkScopeVariant = async (): Promise<string> => {
    const item = await admin.menuItem.create({
      data: { id: newId(), tenantId: tenantAId, names: { en: 'scope-item' } },
    });
    return (
      await admin.menuItemVariant.create({
        data: {
          id: newId(),
          tenantId: tenantAId,
          menuItemId: item.id,
          name: 'sv',
        },
      })
    ).id;
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
    await permissions.upsertMany(PRODUCTION_PERMISSION_DEFS);

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
    tenantAId = await mkTenant(`prda-${stamp}`);
    tenantBId = await mkTenant(`prdb-${stamp}`);

    const mkUser = async (email: string, tenantId: string, codes: string[]) => {
      const u = await users.createUser({ email, password, displayName: 'P' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length) {
        const role = await roles.createTenantRole(tenantId, {
          name: `prd-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.assign(tenantId, m.id, role.id);
      }
    };
    const all = Object.values(PRODUCTION_PERMISSIONS);
    const eAll = `prd.all.${stamp}@example.com`;
    const eView = `prd.view.${stamp}@example.com`;
    const eEdit = `prd.edit.${stamp}@example.com`;
    const ePub = `prd.pub.${stamp}@example.com`;
    const eNone = `prd.none.${stamp}@example.com`;
    const eB = `prd.b.${stamp}@example.com`;
    await mkUser(eAll, tenantAId, all);
    await mkUser(eView, tenantAId, [PRODUCTION_PERMISSIONS.VIEW]);
    await mkUser(eEdit, tenantAId, [PRODUCTION_PERMISSIONS.EDIT]);
    await mkUser(ePub, tenantAId, [PRODUCTION_PERMISSIONS.PUBLISH]);
    await mkUser(eNone, tenantAId, []);
    await mkUser(eB, tenantBId, all);

    tokenAll = await scoped(eAll, tenantAId);
    tokenView = await scoped(eView, tenantAId);
    tokenEdit = await scoped(eEdit, tenantAId);
    tokenPublish = await scoped(ePub, tenantAId);
    tokenNone = await scoped(eNone, tenantAId);
    tokenB = await scoped(eB, tenantBId);

    // Global UOM reference data — Production Spec never creates a UOM.
    uomId = newId();
    await admin.uom.create({
      data: {
        id: uomId,
        dimension: 'mass',
        code: `pg-${stamp}`,
        name: 'gram',
        baseUnitOfDimension: true,
      },
    });

    const mkOrg = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `PB-${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `PBr-${code}`,
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
      return { brandId: brand.id, branchId: branch.id };
    };
    const orgA = await mkOrg(tenantAId, `PA${stamp % 1000}`);
    const orgB = await mkOrg(tenantBId, `PB${stamp % 1000}`);
    brandA = orgA.brandId;
    branchA = orgA.branchId;
    brandB = orgB.brandId;

    // Catalogue variant + Inventory stock item targets (read-only references).
    // Catalogue placement is a separate table; a variant needs only its item.
    const mkVariant = async (tenantId: string, n: string) => {
      const item = await admin.menuItem.create({
        data: { id: newId(), tenantId, names: { en: `I-${n}` } },
      });
      const v = await admin.menuItemVariant.create({
        data: { id: newId(), tenantId, menuItemId: item.id, name: `V-${n}` },
      });
      return v.id;
    };
    variantA = await mkVariant(tenantAId, `A${stamp}`);
    variantB = await mkVariant(tenantBId, `B${stamp}`);

    const mkStockItem = async (tenantId: string, sku: string) =>
      (
        await admin.stockItem.create({
          data: {
            id: newId(),
            tenantId,
            sku,
            names: { en: sku },
            baseUnitId: uomId,
          },
        })
      ).id;
    stockItemA = await mkStockItem(tenantAId, `PRD-A-${stamp}`);
    stockItemB = await mkStockItem(tenantBId, `PRD-B-${stamp}`);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // ------------------------------------------------------------------ auth --
  describe('authentication & authorization', () => {
    it.each(['/recipes', '/substitute-groups'])(
      'unauthenticated GET %s -> 401',
      async (p) => {
        await request(http).get(p).expect(401);
      },
    );

    it('no recipe permission -> 403', async () => {
      await request(http).get('/recipes').set(auth(tokenNone)).expect(403);
    });

    it('recipe.view allows reads but not creation', async () => {
      await request(http).get('/recipes').set(auth(tokenView)).expect(200);
      await request(http)
        .post('/recipes')
        .set(auth(tokenView))
        .send({
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
        .expect(403);
    });

    it('recipe.edit allows creation but not publishing', async () => {
      const r = await mkRecipe(tokenEdit, {
        scope: 'tenant',
        recipeType: 'sub_recipe',
        stockItemId: stockItemA,
      });
      const v = await mkDraft(tokenEdit, r.id);
      await request(http)
        .post(`/recipes/${r.id}/versions/${v.version}/publish`)
        .set(auth(tokenEdit))
        .expect(403);
    });

    it('recipe.publish allows publishing but not draft creation', async () => {
      const r = await mkRecipe(tokenAll, {
        scope: 'tenant',
        recipeType: 'sub_recipe',
        stockItemId: stockItemA,
      });
      await request(http)
        .post(`/recipes/${r.id}/versions`)
        .set(auth(tokenPublish))
        .send({ yieldQuantity: '1', yieldUnitId: uomId })
        .expect(403);
      const v = await mkDraft(tokenAll, r.id);
      await request(http)
        .post(`/recipes/${r.id}/versions/${v.version}/publish`)
        .set(auth(tokenPublish))
        .expect(201);
    });
  });

  // -------------------------------------------------------- recipe create --
  describe('recipe creation (GAP-1)', () => {
    it('creates a tenant-scoped sub_recipe targeting a stock item', async () => {
      const r = await mkRecipe(tokenAll, {
        scope: 'tenant',
        recipeType: 'sub_recipe',
        stockItemId: stockItemA,
      });
      expect(r.id).toBeDefined();
    });

    it('creates a brand-scoped menu_item recipe targeting a variant', async () => {
      const body = await mkRecipe(tokenAll, {
        scope: 'brand',
        brandId: brandA,
        recipeType: 'menu_item',
        menuItemVariantId: variantA,
      });
      expect(body.id).toBeDefined();
    });

    it('creates a branch-scoped recipe', async () => {
      const body = await mkRecipe(tokenAll, {
        scope: 'branch',
        branchId: branchA,
        recipeType: 'menu_item',
        menuItemVariantId: variantA,
      });
      expect(body.id).toBeDefined();
    });

    it('rejects tenant scope carrying a brandId', async () => {
      await mkRecipe(
        tokenAll,
        {
          scope: 'tenant',
          brandId: brandA,
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        },
        400,
      );
    });

    it('rejects brand scope without a brandId', async () => {
      await mkRecipe(
        tokenAll,
        { scope: 'brand', recipeType: 'sub_recipe', stockItemId: stockItemA },
        400,
      );
    });

    it('rejects branch scope carrying a brandId as well', async () => {
      await mkRecipe(
        tokenAll,
        {
          scope: 'branch',
          branchId: branchA,
          brandId: brandA,
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        },
        400,
      );
    });

    it('rejects menu_item type targeting a stock item', async () => {
      await mkRecipe(
        tokenAll,
        { scope: 'tenant', recipeType: 'menu_item', stockItemId: stockItemA },
        400,
      );
    });

    it('rejects sub_recipe type targeting a variant', async () => {
      await mkRecipe(
        tokenAll,
        {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          menuItemVariantId: variantA,
        },
        400,
      );
    });

    it('rejects both targets supplied at once', async () => {
      await mkRecipe(
        tokenAll,
        {
          scope: 'tenant',
          recipeType: 'menu_item',
          menuItemVariantId: variantA,
          stockItemId: stockItemA,
        },
        400,
      );
    });

    it('cross-tenant variant target -> 404, not 403 (no existence leak)', async () => {
      await mkRecipe(
        tokenAll,
        {
          scope: 'tenant',
          recipeType: 'menu_item',
          menuItemVariantId: variantB,
        },
        404,
      );
    });

    it('cross-tenant stock-item target -> 404', async () => {
      await mkRecipe(
        tokenAll,
        { scope: 'tenant', recipeType: 'sub_recipe', stockItemId: stockItemB },
        404,
      );
    });

    it('cross-tenant brand scope -> 404', async () => {
      await mkRecipe(
        tokenAll,
        {
          scope: 'brand',
          brandId: brandB,
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        },
        404,
      );
    });

    it('rejects unknown fields (forbidNonWhitelisted)', async () => {
      await mkRecipe(
        tokenAll,
        {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
          effectiveTo: '2027-01-01',
        },
        400,
      );
    });
  });

  // ------------------------------------------------------------- versions --
  describe('version lifecycle (D-17-04, D-17-08 Q1)', () => {
    let recipeId: string;
    beforeAll(async () => {
      recipeId = (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;
    });

    it('POST versions against an unknown recipe -> 404 (never auto-creates)', async () => {
      await request(http)
        .post(`/recipes/${newId()}/versions`)
        .set(auth(tokenAll))
        .send({ yieldQuantity: '1', yieldUnitId: uomId })
        .expect(404);
    });

    it('numbers drafts from 1 upwards', async () => {
      const v1 = await mkDraft(tokenAll, recipeId);
      const v2 = await mkDraft(tokenAll, recipeId);
      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v1.status).toBe('draft');
    });

    it('publishes a draft and supersedes the incumbent in one transaction', async () => {
      const r = (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;
      const v1 = await mkDraft(tokenAll, r);
      const v2 = await mkDraft(tokenAll, r);

      const p1 = (
        await request(http)
          .post(`/recipes/${r}/versions/${v1.version}/publish`)
          .set(auth(tokenAll))
          .expect(201)
      ).body as VersionBody;
      expect(p1.status).toBe('published');
      expect(p1.supersededVersionId).toBeNull();

      const p2 = (
        await request(http)
          .post(`/recipes/${r}/versions/${v2.version}/publish`)
          .set(auth(tokenAll))
          .expect(201)
      ).body as VersionBody;
      expect(p2.status).toBe('published');
      expect(p2.supersededVersionId).toBe(v1.id);

      // FR-MNU-045: supersede but NOT delete; exactly one published remains.
      const rows = (
        await request(http)
          .get(`/recipes/${r}/versions`)
          .set(auth(tokenAll))
          .expect(200)
      ).body as VersionBody[];
      expect(rows).toHaveLength(2);
      expect(rows.filter((x) => x.status === 'published')).toHaveLength(1);
      expect(rows.find((x) => x.id === v1.id)?.status).toBe('superseded');
    });

    it('refuses to publish an already-published version (409)', async () => {
      const r = (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;
      const v = await mkDraft(tokenAll, r);
      await request(http)
        .post(`/recipes/${r}/versions/${v.version}/publish`)
        .set(auth(tokenAll))
        .expect(201);
      await request(http)
        .post(`/recipes/${r}/versions/${v.version}/publish`)
        .set(auth(tokenAll))
        .expect(409);
    });

    it('refuses to publish a superseded version (409)', async () => {
      const r = (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;
      const v1 = await mkDraft(tokenAll, r);
      const v2 = await mkDraft(tokenAll, r);
      await request(http)
        .post(`/recipes/${r}/versions/${v1.version}/publish`)
        .set(auth(tokenAll))
        .expect(201);
      await request(http)
        .post(`/recipes/${r}/versions/${v2.version}/publish`)
        .set(auth(tokenAll))
        .expect(201);
      await request(http)
        .post(`/recipes/${r}/versions/${v1.version}/publish`)
        .set(auth(tokenAll))
        .expect(409);
    });

    it('unknown version number -> 404', async () => {
      await request(http)
        .post(`/recipes/${recipeId}/versions/9999/publish`)
        .set(auth(tokenAll))
        .expect(404);
    });

    it('cross-tenant recipe id -> 404 on every version route', async () => {
      const foreign = (
        await mkRecipe(tokenB, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemB,
        })
      ).id;
      await request(http)
        .get(`/recipes/${foreign}/versions`)
        .set(auth(tokenAll))
        .expect(404);
      await request(http)
        .post(`/recipes/${foreign}/versions`)
        .set(auth(tokenAll))
        .send({ yieldQuantity: '1', yieldUnitId: uomId })
        .expect(404);
    });

    it('D-17-05: computed_cost is never populated', async () => {
      const v = await mkDraft(tokenAll, recipeId);
      expect(v.computedCost).toBeNull();
    });
  });

  // ----------------------------------------------------- D-17-08 guardrail --
  describe('D-17-08 — effective_from is informational only', () => {
    it('a far-future effective_from selects identically to a far-past one', async () => {
      const build = async (effectiveFrom: string) => {
        const r = (
          await mkRecipe(tokenAll, {
            scope: 'tenant',
            recipeType: 'sub_recipe',
            stockItemId: stockItemA,
          })
        ).id;
        const v = await mkDraft(tokenAll, r, { effectiveFrom });
        await request(http)
          .post(`/recipes/${r}/versions/${v.version}/publish`)
          .set(auth(tokenAll))
          .expect(201);
        const rows = (
          await request(http)
            .get(`/recipes/${r}/versions`)
            .set(auth(tokenAll))
            .expect(200)
        ).body as VersionBody[];
        return rows.filter((x) => x.status === 'published');
      };

      const past = await build('2000-01-01T00:00:00.000Z');
      const future = await build('2099-01-01T00:00:00.000Z');

      // Both resolve to exactly one published version. If effective dating were
      // operational, the future-dated one would not be in force.
      expect(past).toHaveLength(1);
      expect(future).toHaveLength(1);
      expect(future[0].effectiveFrom).toBe('2099-01-01T00:00:00.000Z');
    });

    it('a future-dated version still supersedes the incumbent immediately', async () => {
      const r = (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;
      const v1 = await mkDraft(tokenAll, r, {
        effectiveFrom: '2000-01-01T00:00:00.000Z',
      });
      const v2 = await mkDraft(tokenAll, r, {
        effectiveFrom: '2099-01-01T00:00:00.000Z',
      });
      await request(http)
        .post(`/recipes/${r}/versions/${v1.version}/publish`)
        .set(auth(tokenAll))
        .expect(201);
      const p2 = (
        await request(http)
          .post(`/recipes/${r}/versions/${v2.version}/publish`)
          .set(auth(tokenAll))
          .expect(201)
      ).body as VersionBody;
      // Supersession follows the PUBLISH ACT, never the date (FR-MNU-045).
      expect(p2.supersededVersionId).toBe(v1.id);
    });

    it('no effective-recipe endpoint exists', async () => {
      for (const p of [
        '/recipes/effective',
        '/recipes/resolve',
        '/effective-recipe',
      ]) {
        await request(http).get(p).set(auth(tokenAll)).expect(404);
      }
    });
  });

  // ----------------------------------------------------------- sub-recipes --
  describe('sub-recipes and BR-MNU-001 cycle detection', () => {
    const mkSub = async () =>
      (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;

    it('accepts a valid sub-recipe reference', async () => {
      const parent = await mkSub();
      const child = await mkSub();
      await mkDraft(tokenAll, parent, {
        lines: [
          {
            sequence: 1,
            componentType: 'sub_recipe',
            subRecipeId: child,
            quantity: '2',
            unitId: uomId,
          },
        ],
      });
    });

    it('rejects a direct self-reference with the full cycle path', async () => {
      const r = await mkSub();
      const res = await request(http)
        .post(`/recipes/${r}/versions`)
        .set(auth(tokenAll))
        .send({
          yieldQuantity: '1',
          yieldUnitId: uomId,
          lines: [
            {
              sequence: 1,
              componentType: 'sub_recipe',
              subRecipeId: r,
              quantity: '1',
              unitId: uomId,
            },
          ],
        })
        .expect(400);
      const body = res.body as { message: string; cyclePath: string[] };
      expect(body.cyclePath).toEqual([r, r]);
      expect(body.message).toContain('Cycle path:');
    });

    it('rejects an indirect cycle with the full cycle path', async () => {
      const a = await mkSub();
      const b = await mkSub();
      // b uses a
      const vb = await mkDraft(tokenAll, b, {
        lines: [
          {
            sequence: 1,
            componentType: 'sub_recipe',
            subRecipeId: a,
            quantity: '1',
            unitId: uomId,
          },
        ],
      });
      expect(vb.version).toBe(1);
      // a using b would close the loop a -> b -> a
      const res = await request(http)
        .post(`/recipes/${a}/versions`)
        .set(auth(tokenAll))
        .send({
          yieldQuantity: '1',
          yieldUnitId: uomId,
          lines: [
            {
              sequence: 1,
              componentType: 'sub_recipe',
              subRecipeId: b,
              quantity: '1',
              unitId: uomId,
            },
          ],
        })
        .expect(400);
      const body = res.body as { cyclePath: string[] };
      expect(body.cyclePath).toEqual([a, b, a]);
    });

    it('rejects a cross-tenant sub-recipe reference with 404', async () => {
      const mine = await mkSub();
      const foreign = (
        await mkRecipe(tokenB, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemB,
        })
      ).id;
      await request(http)
        .post(`/recipes/${mine}/versions`)
        .set(auth(tokenAll))
        .send({
          yieldQuantity: '1',
          yieldUnitId: uomId,
          lines: [
            {
              sequence: 1,
              componentType: 'sub_recipe',
              subRecipeId: foreign,
              quantity: '1',
              unitId: uomId,
            },
          ],
        })
        .expect(404);
    });

    it('rejects a line whose component type and target disagree', async () => {
      const r = await mkSub();
      await request(http)
        .post(`/recipes/${r}/versions`)
        .set(auth(tokenAll))
        .send({
          yieldQuantity: '1',
          yieldUnitId: uomId,
          lines: [
            {
              sequence: 1,
              componentType: 'stock_item',
              subRecipeId: r,
              quantity: '1',
              unitId: uomId,
            },
          ],
        })
        .expect(400);
    });

    it('rejects a cross-tenant stock item on a line with 404', async () => {
      const r = await mkSub();
      await request(http)
        .post(`/recipes/${r}/versions`)
        .set(auth(tokenAll))
        .send({
          yieldQuantity: '1',
          yieldUnitId: uomId,
          lines: [
            {
              sequence: 1,
              componentType: 'stock_item',
              stockItemId: stockItemB,
              quantity: '1',
              unitId: uomId,
            },
          ],
        })
        .expect(404);
    });

    it('rejects an unknown UOM with 404 (never fabricates a unit)', async () => {
      const r = await mkSub();
      await request(http)
        .post(`/recipes/${r}/versions`)
        .set(auth(tokenAll))
        .send({ yieldQuantity: '1', yieldUnitId: newId() })
        .expect(404);
    });
  });

  // ------------------------------------------------------- draft editing --
  describe('draft editing vs published immutability (D-17-04 / GAP-2)', () => {
    it('a draft version accepts line replacement', async () => {
      const r = (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;
      const v = await mkDraft(tokenAll, r);
      await request(http)
        .put(`/recipes/${r}/versions/${v.version}/lines`)
        .set(auth(tokenAll))
        .send({
          lines: [
            {
              sequence: 1,
              componentType: 'stock_item',
              stockItemId: stockItemA,
              quantity: '3.5',
              unitId: uomId,
              wastagePercentage: '18',
              isOptional: true,
            },
          ],
        })
        .expect(200);

      const rows = (
        await request(http)
          .get(`/recipes/${r}/versions`)
          .set(auth(tokenAll))
          .expect(200)
      ).body as (VersionBody & {
        lines: { quantity: string; wastagePercentage: string }[];
      })[];
      expect(rows[0].lines[0].quantity).toBe('3.5');
      expect(rows[0].lines[0].wastagePercentage).toBe('18');
    });

    it('a published version refuses line replacement (409)', async () => {
      const r = (
        await mkRecipe(tokenAll, {
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockItemA,
        })
      ).id;
      const v = await mkDraft(tokenAll, r);
      await request(http)
        .post(`/recipes/${r}/versions/${v.version}/publish`)
        .set(auth(tokenAll))
        .expect(201);
      await request(http)
        .put(`/recipes/${r}/versions/${v.version}/lines`)
        .set(auth(tokenAll))
        .send({ lines: [] })
        .expect(409);
    });
  });

  // ------------------------------------------------- substitute groups --
  describe('substitute groups', () => {
    it('creates a group with members under recipe.edit', async () => {
      const g = (
        await request(http)
          .post('/substitute-groups')
          .set(auth(tokenAll))
          .send({ name: `grp-${stamp}`, stockItemIds: [stockItemA] })
          .expect(201)
      ).body as WithId;
      expect(g.id).toBeDefined();
    });

    it('rejects a cross-tenant member with 404', async () => {
      const g = (
        await request(http)
          .post('/substitute-groups')
          .set(auth(tokenAll))
          .send({ name: `grp2-${stamp}` })
          .expect(201)
      ).body as WithId;
      await request(http)
        .post(`/substitute-groups/${g.id}/members`)
        .set(auth(tokenAll))
        .send({ stockItemId: stockItemB })
        .expect(404);
    });

    it('adding a member to a cross-tenant group -> 404', async () => {
      const foreign = (
        await request(http)
          .post('/substitute-groups')
          .set(auth(tokenB))
          .send({ name: `grpB-${stamp}` })
          .expect(201)
      ).body as WithId;
      await request(http)
        .post(`/substitute-groups/${foreign.id}/members`)
        .set(auth(tokenAll))
        .send({ stockItemId: stockItemA })
        .expect(404);
    });

    it('a group list never shows another tenant a foreign group', async () => {
      const mine = (
        (
          await request(http)
            .get('/substitute-groups')
            .set(auth(tokenAll))
            .expect(200)
        ).body as WithId[]
      ).map((x) => x.id);
      const theirs = (
        (
          await request(http)
            .get('/substitute-groups')
            .set(auth(tokenB))
            .expect(200)
        ).body as WithId[]
      ).map((x) => x.id);
      expect(mine.some((id) => theirs.includes(id))).toBe(false);
      expect(mine.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------- scope --
  describe('D-17-03 scope precedence (branch > brand > tenant)', () => {
    it('all three scope levels can coexist for the same target', async () => {
      const v = await mkScopeVariant();

      const t = await mkRecipe(tokenAll, {
        scope: 'tenant',
        recipeType: 'menu_item',
        menuItemVariantId: v,
      });
      const b = await mkRecipe(tokenAll, {
        scope: 'brand',
        brandId: brandA,
        recipeType: 'menu_item',
        menuItemVariantId: v,
      });
      const br = await mkRecipe(tokenAll, {
        scope: 'branch',
        branchId: branchA,
        recipeType: 'menu_item',
        menuItemVariantId: v,
      });
      expect(new Set([t.id, b.id, br.id]).size).toBe(3);
    });
  });
});
