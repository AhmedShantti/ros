import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * Proves the PostgreSQL boundary for Production Spec DIRECTLY, exercised only
 * through the RLS-constrained runtime role (ros_app) via PrismaService. The
 * migrator client arranges fixtures and observes true row state — never as
 * evidence of application isolation.
 *
 * Covers the two mechanisms this phase introduces:
 *   - direct tenant_id anchoring on all five tables;
 *   - GAP-2 published-version immutability: column-level UPDATE(status) grant
 *     plus status-predicated RLS on recipe_lines and recipe_versions DELETE.
 */
describe('Production Spec RLS enforcement as ros_app (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService; // ros_app (NOBYPASSRLS)
  let admin: PrismaClient; // ros_migrator (arrange/observe only)

  const ts = Date.now();
  const A = newId();
  const B = newId();
  const uomId = newId();
  const stockA = newId();
  const stockB = newId();
  const recipeA = newId();
  const draftA = newId();
  const publishedA = newId();
  const groupA = newId();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);

    await admin.tenant.createMany({
      data: [A, B].map((id, i) => ({
        id,
        slug: `prdrls-${i}-${ts}`,
        legalName: 'PrdRLS',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
    });
    await admin.uom.create({
      data: {
        id: uomId,
        dimension: 'mass',
        code: `p${ts % 100000}`,
        name: 'kg',
      },
    });
    await admin.stockItem.createMany({
      data: [
        {
          id: stockA,
          tenantId: A,
          sku: `PR-A-${ts}`,
          names: {},
          baseUnitId: uomId,
        },
        {
          id: stockB,
          tenantId: B,
          sku: `PR-B-${ts}`,
          names: {},
          baseUnitId: uomId,
        },
      ],
    });

    await admin.recipe.create({
      data: {
        id: recipeA,
        tenantId: A,
        scope: 'tenant',
        recipeType: 'sub_recipe',
        stockItemId: stockA,
      },
    });
    await admin.recipeVersion.createMany({
      data: [
        {
          id: draftA,
          tenantId: A,
          recipeId: recipeA,
          version: 1,
          status: 'draft',
          yieldQuantity: 5,
          yieldUnitId: uomId,
        },
        {
          id: publishedA,
          tenantId: A,
          recipeId: recipeA,
          version: 2,
          status: 'published',
          yieldQuantity: 5,
          yieldUnitId: uomId,
        },
      ],
    });
    await admin.recipeLine.createMany({
      data: [
        {
          id: newId(),
          tenantId: A,
          recipeVersionId: draftA,
          sequence: 1,
          componentType: 'stock_item',
          stockItemId: stockA,
          quantity: 1,
          unitId: uomId,
        },
        {
          id: newId(),
          tenantId: A,
          recipeVersionId: publishedA,
          sequence: 1,
          componentType: 'stock_item',
          stockItemId: stockA,
          quantity: 1,
          unitId: uomId,
        },
      ],
    });
    await admin.substituteGroup.create({
      data: { id: groupA, tenantId: A, name: `g-${ts}` },
    });
    await admin.substituteGroupMember.create({
      data: { tenantId: A, substituteGroupId: groupA, stockItemId: stockA },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('missing tenant context -> fail closed', () => {
    it('returns no rows for every Production Spec table', async () => {
      const counts = await prisma.withAuthContext({}, async (tx) => ({
        recipes: await tx.recipe.count(),
        versions: await tx.recipeVersion.count(),
        lines: await tx.recipeLine.count(),
        groups: await tx.substituteGroup.count(),
        members: await tx.substituteGroupMember.count(),
      }));
      expect(counts).toEqual({
        recipes: 0,
        versions: 0,
        lines: 0,
        groups: 0,
        members: 0,
      });
    });

    it('rejects an INSERT with no tenant context', async () => {
      await expect(
        prisma.withAuthContext({}, (tx) =>
          tx.recipe.create({
            data: {
              id: newId(),
              tenantId: A,
              scope: 'tenant',
              recipeType: 'sub_recipe',
              stockItemId: stockA,
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('same tenant -> allowed (positive controls)', () => {
    it('sees its own recipes, versions, lines, groups and members', async () => {
      const seen = await prisma.withAuthContext(
        { tenantId: A },
        async (tx) => ({
          recipes: await tx.recipe.count(),
          versions: await tx.recipeVersion.count(),
          lines: await tx.recipeLine.count(),
          groups: await tx.substituteGroup.count(),
          members: await tx.substituteGroupMember.count(),
        }),
      );
      expect(seen.recipes).toBeGreaterThan(0);
      expect(seen.versions).toBeGreaterThan(0);
      expect(seen.lines).toBeGreaterThan(0);
      expect(seen.groups).toBeGreaterThan(0);
      expect(seen.members).toBeGreaterThan(0);
    });
  });

  describe('cross-tenant', () => {
    it('SELECT returns nothing on every table', async () => {
      const rows = await prisma.withAuthContext(
        { tenantId: B },
        async (tx) => ({
          recipes: await tx.recipe.findMany({ where: { tenantId: A } }),
          versions: await tx.recipeVersion.findMany({ where: { tenantId: A } }),
          lines: await tx.recipeLine.findMany({ where: { tenantId: A } }),
          groups: await tx.substituteGroup.findMany({ where: { tenantId: A } }),
          members: await tx.substituteGroupMember.findMany({
            where: { tenantId: A },
          }),
        }),
      );
      expect(rows.recipes).toHaveLength(0);
      expect(rows.versions).toHaveLength(0);
      expect(rows.lines).toHaveLength(0);
      expect(rows.groups).toHaveLength(0);
      expect(rows.members).toHaveLength(0);
    });

    it('INSERT spoofing another tenant_id is rejected', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.recipe.create({
            data: {
              id: newId(),
              tenantId: A,
              scope: 'tenant',
              recipeType: 'sub_recipe',
              stockItemId: stockA,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('the same INSERT with its OWN tenant succeeds (positive control)', async () => {
      const id = newId();
      await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.recipe.create({
          data: {
            id,
            tenantId: B,
            scope: 'tenant',
            recipeType: 'sub_recipe',
            stockItemId: stockB,
          },
        }),
      );
      expect(await admin.recipe.findUnique({ where: { id } })).not.toBeNull();
    });

    it('UPDATE affects zero rows and leaves the real row untouched', async () => {
      const res = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.recipe.updateMany({
          where: { id: recipeA },
          data: { scope: 'brand' },
        }),
      );
      expect(res.count).toBe(0);
      const truth = await admin.recipe.findUnique({ where: { id: recipeA } });
      expect(truth?.scope).toBe('tenant');
    });

    it('DELETE affects zero rows and the real row survives', async () => {
      const res = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.substituteGroup.deleteMany({ where: { id: groupA } }),
      );
      expect(res.count).toBe(0);
      expect(
        await admin.substituteGroup.findUnique({ where: { id: groupA } }),
      ).not.toBeNull();
    });

    it('a cross-tenant target reference is unrepresentable (composite FK)', async () => {
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO production.recipes
             (id, tenant_id, scope, recipe_type, stock_item_id, created_at)
           VALUES ($1, $2, 'tenant', 'sub_recipe', $3, now())`,
          newId(),
          B,
          stockA, // stock item belongs to tenant A
        ),
      ).rejects.toThrow();
    });

    it('a cross-tenant substitute member is unrepresentable', async () => {
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO production.substitute_group_members
             (tenant_id, substitute_group_id, stock_item_id)
           VALUES ($1, $2, $3)`,
          A,
          groupA,
          stockB, // stock item belongs to tenant B
        ),
      ).rejects.toThrow();
    });

    it('a cross-tenant sub-recipe component is unrepresentable', async () => {
      const foreignRecipe = newId();
      await admin.recipe.create({
        data: {
          id: foreignRecipe,
          tenantId: B,
          scope: 'tenant',
          recipeType: 'sub_recipe',
          stockItemId: stockB,
        },
      });
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO production.recipe_lines
             (id, tenant_id, recipe_version_id, sequence, component_type,
              sub_recipe_id, quantity, unit_id, wastage_percentage, is_optional)
           VALUES ($1, $2, $3, 9, 'sub_recipe', $4, 1, $5, 0, false)`,
          newId(),
          A,
          draftA,
          foreignRecipe, // recipe belongs to tenant B
          uomId,
        ),
      ).rejects.toThrow();
    });
  });

  describe('GAP-2 — published-version immutability', () => {
    it('ros_app cannot UPDATE a non-status column on ANY version', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.recipeVersion.updateMany({
            where: { id: publishedA },
            data: { yieldQuantity: 999 },
          }),
        ),
      ).rejects.toThrow();
    });

    it('the column grant is table-wide: even a DRAFT resists non-status edits', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.recipeVersion.updateMany({
            where: { id: draftA },
            data: { prepTimeSeconds: 42 },
          }),
        ),
      ).rejects.toThrow();
    });

    it('ros_app CAN update status — the one permitted transition (positive control)', async () => {
      const res = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.recipeVersion.updateMany({
          where: { id: draftA },
          data: { status: 'draft' },
        }),
      );
      expect(res.count).toBe(1);
    });

    it('lines of a PUBLISHED version cannot be updated or deleted', async () => {
      const upd = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.recipeLine.updateMany({
          where: { recipeVersionId: publishedA },
          data: { quantity: 99 },
        }),
      );
      expect(upd.count).toBe(0);

      const del = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.recipeLine.deleteMany({ where: { recipeVersionId: publishedA } }),
      );
      expect(del.count).toBe(0);

      expect(
        await admin.recipeLine.count({
          where: { recipeVersionId: publishedA },
        }),
      ).toBe(1);
    });

    it('a line cannot be INSERTed into a published version', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.recipeLine.create({
            data: {
              id: newId(),
              tenantId: A,
              recipeVersionId: publishedA,
              sequence: 2,
              componentType: 'stock_item',
              stockItemId: stockA,
              quantity: 1,
              unitId: uomId,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('lines of a DRAFT version remain editable (positive control)', async () => {
      const upd = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.recipeLine.updateMany({
          where: { recipeVersionId: draftA },
          data: { quantity: 7 },
        }),
      );
      expect(upd.count).toBe(1);
    });

    it('a PUBLISHED version cannot be deleted', async () => {
      const res = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.recipeVersion.deleteMany({ where: { id: publishedA } }),
      );
      expect(res.count).toBe(0);
      expect(
        await admin.recipeVersion.findUnique({ where: { id: publishedA } }),
      ).not.toBeNull();
    });
  });

  describe('D-17-08 Q1 — exactly one published version', () => {
    it('a second published row for the same recipe is rejected by the index', async () => {
      await expect(
        admin.recipeVersion.create({
          data: {
            id: newId(),
            tenantId: A,
            recipeId: recipeA,
            version: 99,
            status: 'published',
            yieldQuantity: 1,
            yieldUnitId: uomId,
          },
        }),
      ).rejects.toThrow();
    });

    it('a second DRAFT for the same recipe is permitted (positive control)', async () => {
      const id = newId();
      await admin.recipeVersion.create({
        data: {
          id,
          tenantId: A,
          recipeId: recipeA,
          version: 98,
          status: 'draft',
          yieldQuantity: 1,
          yieldUnitId: uomId,
        },
      });
      expect(
        await admin.recipeVersion.findUnique({ where: { id } }),
      ).not.toBeNull();
    });
  });

  describe('structural guarantees', () => {
    it('all five tables have RLS enabled, forced, and 4 policies', async () => {
      const bad = await admin.$queryRawUnsafe<{ relname: string }[]>(
        `SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'production' AND c.relkind = 'r'
           AND NOT (
             c.relrowsecurity AND c.relforcerowsecurity
             AND (SELECT count(*) FROM pg_policies p
                  WHERE p.schemaname = 'production'
                    AND p.tablename = c.relname) = 4
           )`,
      );
      expect(bad.map((b) => b.relname)).toEqual([]);
    });

    it('ros_app holds no table-wide UPDATE on recipe_versions', async () => {
      const rows = await admin.$queryRawUnsafe<{ privilege_type: string }[]>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'ros_app' AND table_schema = 'production'
           AND table_name = 'recipe_versions' AND privilege_type = 'UPDATE'`,
      );
      expect(rows).toHaveLength(0);

      const cols = await admin.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.role_column_grants
         WHERE grantee = 'ros_app' AND table_schema = 'production'
           AND table_name = 'recipe_versions' AND privilege_type = 'UPDATE'`,
      );
      expect(cols.map((c) => c.column_name)).toEqual(['status']);
    });

    it('the partial unique published index exists', async () => {
      const rows = await admin.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'production'
           AND indexname = 'uq_recipe_single_published'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toContain('WHERE');
      expect(rows[0].indexdef).toContain('published');
    });

    it('no trigger exists in the production schema', async () => {
      const rows = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'production' AND NOT t.tgisinternal`,
      );
      expect(Number(rows[0].n)).toBe(0);
    });

    it('no index references effective_from (D-17-08 Q2)', async () => {
      const rows = await admin.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'production' AND indexdef LIKE '%effective_from%'`,
      );
      expect(rows.map((r) => r.indexname)).toEqual([]);
    });

    it('the archived status is unrepresentable in the enum (D-17-04)', async () => {
      const rows = await admin.$queryRawUnsafe<{ label: string }[]>(
        `SELECT e.enumlabel AS label FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
           JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'production' AND t.typname = 'RecipeVersionStatus'
         ORDER BY e.enumsortorder`,
      );
      expect(rows.map((r) => r.label)).toEqual([
        'draft',
        'published',
        'superseded',
      ]);
    });
  });
});
