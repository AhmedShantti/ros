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
import { PRODUCTION_PERMISSION_DEFS } from './../src/modules/production/production.permissions';
import { RecipeCompletenessService } from './../src/modules/production/costing/recipe-completeness.service';
import { createMigratorClient } from './rls-admin';

/**
 * BR-MNU-012's third clause — "SHALL list the item in a 'recipes requiring
 * completion' report".
 *
 * The report must agree with what a SALE would record: absent here means the
 * sale writes `recipe_version_id = NULL` and cost 0; incomplete here means the
 * sale writes the real version and a partial cost. If the two ever disagree the
 * report stops predicting anything.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('Recipes requiring completion (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let completeness: RecipeCompletenessService;

  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let branchA: string;
  let brandA: string;
  let token: string;
  let unitKg: string;
  let flourItemId: string;
  let locationA: string;

  // Variants under test
  let absentVariant: string;
  let emptyRecipeVariant: string;
  let undefinedSubVariant: string;
  let completeVariant: string;
  let foreignVariant: string;

  /** A tenant-scoped access token: login, then select the tenant. */
  const scoped = async (email: string, tenantId: string) => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const selected = await request(http)
      .post('/auth/tenant')
      .set(
        'Authorization',
        `Bearer ${(login.body as { accessToken: string }).accessToken}`,
      )
      .send({ tenantId })
      .expect(200);
    return (selected.body as { accessToken: string }).accessToken;
  };

  const mkVariant = async (tenantId: string, name: string) => {
    const item = await admin.menuItem.create({
      data: { id: newId(), tenantId, names: { en: name } },
    });
    const variant = await admin.menuItemVariant.create({
      data: {
        id: newId(),
        tenantId,
        menuItemId: item.id,
        name: { en: 'V' },
      },
    });
    return variant.id;
  };

  const mkPublished = async (
    tenantId: string,
    variantId: string,
    lines: { stockItemId?: string; subRecipeId?: string }[],
  ) => {
    const recipe = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId,
        scope: 'tenant',
        recipeType: 'menu_item',
        menuItemVariantId: variantId,
      },
    });
    const version = await admin.recipeVersion.create({
      data: {
        id: newId(),
        tenantId,
        recipeId: recipe.id,
        version: 1,
        status: 'published',
        yieldQuantity: '1',
        yieldUnitId: unitKg,
        yieldPercentage: '100.00',
      },
    });
    for (const [i, line] of lines.entries()) {
      await admin.recipeLine.create({
        data: {
          id: newId(),
          tenantId,
          recipeVersionId: version.id,
          sequence: i + 1,
          componentType: line.subRecipeId ? 'sub_recipe' : 'stock_item',
          ...(line.subRecipeId
            ? { subRecipeId: line.subRecipeId }
            : { stockItemId: line.stockItemId! }),
          quantity: '1',
          unitId: unitKg,
          wastagePercentage: '0.00',
        },
      });
    }
    return { recipe, version };
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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    completeness = app.get(RecipeCompletenessService);

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);

    tenantA = (
      await tenants.create({
        slug: `rca-${stamp}`,
        legalName: 'RCA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `rcb-${stamp}`,
        legalName: 'RCB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const emailA = `rc.a.${stamp}@example.com`;
    const u = await users.createUser({
      email: emailA,
      password,
      displayName: 'RC',
    });
    userA = u.id;
    await memberships.grant(userA, tenantA, 'active');

    const permissions = app.get(PermissionsService);
    for (const def of PRODUCTION_PERMISSION_DEFS) await permissions.upsert(def);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const role = await roles.createTenantRole(tenantA, {
      name: `chef_${stamp}`,
    });
    await roles.addPermissions(
      tenantA,
      role.id,
      PRODUCTION_PERMISSION_DEFS.map((d) => d.code),
    );
    const membershipA = await admin.membership.findFirstOrThrow({
      where: { userId: userA, tenantId: tenantA },
    });
    await membershipRoles.assign(tenantA, membershipA.id, role.id);

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `RCBrand ${stamp}` },
    });
    brandA = brand.id;
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brandA,
        code: `RC${stamp % 10000}`,
        name: 'RC branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    branchA = branch.id;
    locationA = (
      await admin.location.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          locationType: 'branch',
          refId: branchA,
          branchId: branchA,
        },
      })
    ).id;

    unitKg = (
      await admin.uom.create({
        data: {
          id: newId(),
          dimension: 'mass',
          code: `RCKG${stamp % 100000}`,
          name: 'Kilogram',
          baseUnitOfDimension: true,
        },
      })
    ).id;
    flourItemId = (
      await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `RCFLOUR${stamp % 10000}`,
          names: { en: 'Flour' },
          baseUnitId: unitKg,
          costingMethod: 'standard',
          standardCost: 2_000n,
        },
      })
    ).id;

    // 1. No recipe at all.
    absentVariant = await mkVariant(tenantA, 'Absent recipe');
    // 2. A published recipe with no components.
    emptyRecipeVariant = await mkVariant(tenantA, 'Empty recipe');
    await mkPublished(tenantA, emptyRecipeVariant, []);
    // 3. A published recipe naming a sub-recipe that has no published version.
    undefinedSubVariant = await mkVariant(tenantA, 'Undefined sub-recipe');
    const undefinedSub = await admin.recipe.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        scope: 'tenant',
        recipeType: 'sub_recipe',
        stockItemId: flourItemId,
      },
    });
    await mkPublished(tenantA, undefinedSubVariant, [
      { subRecipeId: undefinedSub.id },
    ]);
    // 4. A finished recipe.
    completeVariant = await mkVariant(tenantA, 'Complete recipe');
    await mkPublished(tenantA, completeVariant, [{ stockItemId: flourItemId }]);
    // 5. Another tenant's variant, with no recipe at all.
    foreignVariant = await mkVariant(tenantB, 'Foreign');

    token = await scoped(emailA, tenantA);
    void locationA;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  const reasonFor = (
    report: Awaited<ReturnType<RecipeCompletenessService['report']>>,
    variantId: string,
  ) => report.entries.find((e) => e.variantId === variantId)?.reason ?? null;

  describe('classification', () => {
    it('lists a variant with NO recipe as absent_recipe', async () => {
      const report = await completeness.report(tenantA);
      expect(reasonFor(report, absentVariant)).toBe('absent_recipe');
      const entry = report.entries.find((e) => e.variantId === absentVariant)!;
      expect(entry.recipeVersionId).toBeNull();
    });

    it('lists a published recipe with NO components as incomplete_recipe', async () => {
      const report = await completeness.report(tenantA);
      expect(reasonFor(report, emptyRecipeVariant)).toBe('incomplete_recipe');
      const entry = report.entries.find(
        (e) => e.variantId === emptyRecipeVariant,
      )!;
      // The recipe EXISTS — its version is named, which is what distinguishes
      // this from the absent case even though both may cost zero.
      expect(entry.recipeVersionId).not.toBeNull();
      expect(entry.detail).toContain('no_components');
    });

    it('lists an undefined SUB-RECIPE as incomplete_recipe', async () => {
      const report = await completeness.report(tenantA);
      expect(reasonFor(report, undefinedSubVariant)).toBe('incomplete_recipe');
      expect(
        report.entries.find((e) => e.variantId === undefinedSubVariant)!.detail,
      ).toContain('no_published_version');
    });

    it('does NOT list a finished recipe', async () => {
      const report = await completeness.report(tenantA);
      expect(reasonFor(report, completeVariant)).toBeNull();
      // Positive control: the report is not simply empty.
      expect(report.entries.length).toBeGreaterThan(0);
    });

    it('does NOT list a variant merely because a component lacks valuation', async () => {
      // A finished recipe whose ingredient has no cost is a VALUATION problem.
      // It refuses the sale; it does not belong in a report about recipes that
      // still need to be written.
      const unvalued = await admin.stockItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          sku: `RCSALT${stamp % 10000}`,
          names: { en: 'Salt' },
          baseUnitId: unitKg,
          costingMethod: 'weighted_average',
        },
      });
      const variant = await mkVariant(tenantA, 'Unvaluable but written');
      await mkPublished(tenantA, variant, [{ stockItemId: unvalued.id }]);

      const report = await completeness.report(tenantA);
      expect(reasonFor(report, variant)).toBeNull();
    });

    it('counts absent and incomplete separately', async () => {
      const report = await completeness.report(tenantA);
      expect(report.absentCount).toBeGreaterThan(0);
      expect(report.incompleteCount).toBeGreaterThan(0);
      expect(report.absentCount + report.incompleteCount).toBe(
        report.entries.length,
      );
      expect(report.sellableVariantCount).toBeGreaterThan(
        report.entries.length,
      );
    });

    it('ignores an INACTIVE variant — it cannot be sold, so it needs no recipe', async () => {
      const variant = await mkVariant(tenantA, 'Retired');
      await admin.menuItemVariant.update({
        where: { id: variant },
        data: { isActive: false },
      });
      const report = await completeness.report(tenantA);
      expect(reasonFor(report, variant)).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it('never reports another tenant variant', async () => {
      const report = await completeness.report(tenantA);
      expect(report.entries.map((e) => e.variantId)).not.toContain(
        foreignVariant,
      );
      // Positive control: tenant B DOES see it in its own report.
      const other = await completeness.report(tenantB);
      expect(other.entries.map((e) => e.variantId)).toContain(foreignVariant);
    });

    it('404s a branch belonging to another tenant rather than falling through', async () => {
      const foreignBrand = await admin.brand.create({
        data: { id: newId(), tenantId: tenantB, name: `FB ${stamp}` },
      });
      const foreignBranch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          brandId: foreignBrand.id,
          code: `FB${stamp % 10000}`,
          name: 'Foreign branch',
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      // Every org location entity needs a registry row (P15-2); the suite must
      // not leave one behind for the global invariant check to trip over.
      await admin.location.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          locationType: 'branch',
          refId: foreignBranch.id,
          branchId: foreignBranch.id,
        },
      });

      await expect(
        completeness.report(tenantA, foreignBranch.id),
      ).rejects.toThrow(/Branch not found/);
    });
  });

  describe('HTTP surface', () => {
    it('is exposed under Production and needs recipe.view', async () => {
      const res = await request(http)
        .get('/recipes/requiring-completion')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const body = res.body as {
        entries: { variantId: string; reason: string }[];
        absentCount: number;
        incompleteCount: number;
      };
      expect(
        body.entries.find((e) => e.variantId === absentVariant)?.reason,
      ).toBe('absent_recipe');
      expect(
        body.entries.find((e) => e.variantId === emptyRecipeVariant)?.reason,
      ).toBe('incomplete_recipe');
    });

    it('accepts a branch filter and resolves scope precedence for it', async () => {
      const res = await request(http)
        .get(`/recipes/requiring-completion?branchId=${branchA}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect((res.body as { branchId: string }).branchId).toBe(branchA);
    });

    it('rejects a malformed branch filter at the edge', async () => {
      const res = await request(http)
        .get('/recipes/requiring-completion?branchId=not-a-uuid')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(http).get('/recipes/requiring-completion');
      expect(res.status).toBe(401);
    });

    it('is NOT the Catalogue pricing completeness report', async () => {
      // Two different invariants, two different surfaces. BR-MNU-012 must never
      // be cited to weaken the C-11 pricing invariant.
      const res = await request(http)
        .get('/recipes/requiring-completion')
        .set('Authorization', `Bearer ${token}`);
      expect(Object.keys(res.body as object)).not.toContain('unpricedVariants');
      expect(Object.keys(res.body as object)).not.toContain('activeListGaps');
    });
  });
});
