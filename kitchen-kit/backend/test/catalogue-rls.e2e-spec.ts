import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * Proves the PostgreSQL RLS boundary for the Catalogue tables DIRECTLY, exercised
 * only through the RLS-constrained runtime role (ros_app) via PrismaService.
 * The migrator client is used solely to arrange fixtures and to observe true row
 * state — never as evidence of application isolation.
 *
 * Covers the direct tenant_id anchor used by every Catalogue table, including
 * `modifiers` — migrated from PARENT (EXISTS via modifier_groups) to DIRECT
 * anchor by P1E-3 (`20260821010000_catalogue_modifier_tenancy`), the
 * prerequisite for a tenant-safe composite FK to a modifier (ADR 0008 D-09).
 */
describe('Catalogue RLS enforcement as ros_app (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService; // ros_app (NOBYPASSRLS)
  let admin: PrismaClient; // ros_migrator (arrange/observe only)

  const ts = Date.now();
  const A = newId();
  const B = newId();
  const menuA = newId();
  const menuB = newId();
  const itemA = newId();
  const groupA = newId();
  const modifierA = newId();

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
        slug: `catrls-${i}-${ts}`,
        legalName: 'CatRLS',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
    });
    await admin.menu.createMany({
      data: [
        { id: menuA, tenantId: A, name: { en: 'A' } },
        { id: menuB, tenantId: B, name: { en: 'B' } },
      ],
    });
    await admin.menuItem.create({
      data: { id: itemA, tenantId: A, names: { en: 'Item A' } },
    });
    await admin.modifierGroup.create({
      data: { id: groupA, tenantId: A, name: { en: 'Group A' } },
    });
    await admin.modifier.create({
      data: {
        id: modifierA,
        tenantId: A,
        modifierGroupId: groupA,
        name: { en: 'Mod A' },
      },
    });
  });

  afterAll(async () => {
    await admin.modifier.deleteMany({ where: { modifierGroupId: groupA } });
    await admin.modifierGroup.deleteMany({ where: { tenantId: A } });
    await admin.menuItem.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await admin.menu.deleteMany({ where: { tenantId: { in: [A, B] } } });
    await admin.tenant.deleteMany({ where: { id: { in: [A, B] } } });
    await admin.$disconnect();
    await app.close();
  });

  describe('missing tenant context → fail closed', () => {
    it('returns no rows for every catalogue table', async () => {
      const counts = await prisma.withAuthContext({}, async (tx) => ({
        menus: await tx.menu.count(),
        items: await tx.menuItem.count(),
        groups: await tx.modifierGroup.count(),
        modifiers: await tx.modifier.count(),
        priceLists: await tx.priceList.count(),
      }));
      expect(counts).toEqual({
        menus: 0,
        items: 0,
        groups: 0,
        modifiers: 0,
        priceLists: 0,
      });
    });

    it('rejects an INSERT with no tenant context', async () => {
      await expect(
        prisma.withAuthContext({}, (tx) =>
          tx.menu.create({
            data: { id: newId(), tenantId: A, name: { en: 'nope' } },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('same tenant → allowed', () => {
    it('sees only its own rows', async () => {
      const menus = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.menu.findMany({ select: { id: true } }),
      );
      const ids = menus.map((m) => m.id);
      expect(ids).toContain(menuA);
      expect(ids).not.toContain(menuB);
    });

    it('sees its own modifier rows (direct tenant_id anchor)', async () => {
      const mods = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.modifier.findMany({ select: { id: true } }),
      );
      expect(mods.map((m) => m.id)).toContain(modifierA);
    });
  });

  describe('cross-tenant', () => {
    it('SELECT returns nothing', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.menu.findMany({ where: { id: menuA }, select: { id: true } }),
      );
      expect(rows).toHaveLength(0);
    });

    it('modifier SELECT returns nothing (direct anchor)', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.modifier.findMany({
          where: { id: modifierA },
          select: { id: true },
        }),
      );
      expect(rows).toHaveLength(0);
    });

    it('INSERT spoofing another tenant_id is rejected', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.menu.create({
            data: { id: newId(), tenantId: A, name: { en: 'spoof' } },
          }),
        ),
      ).rejects.toThrow();
    });

    it('modifier INSERT spoofing another tenant_id is rejected', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.modifier.create({
            data: {
              id: newId(),
              tenantId: A, // spoof — context is B
              modifierGroupId: groupA,
              name: { en: 'spoof' },
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('modifier INSERT under another tenant parent group is rejected (ADR 0008 D-09 composite FK)', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.modifier.create({
            data: {
              id: newId(),
              tenantId: B, // matches context — passes RLS
              modifierGroupId: groupA, // belongs to tenant A — fails the composite FK
              name: { en: 'spoof' },
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('UPDATE affects zero rows and leaves the real row untouched', async () => {
      const res = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.menu.updateMany({
          where: { id: menuA },
          data: { priority: 99 },
        }),
      );
      expect(res.count).toBe(0);
      const truth = await admin.menu.findUnique({ where: { id: menuA } });
      expect(truth?.priority).toBe(0);
    });

    it('DELETE affects zero rows and the real row survives', async () => {
      const res = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.menuItem.deleteMany({ where: { id: itemA } }),
      );
      expect(res.count).toBe(0);
      expect(
        await admin.menuItem.findUnique({ where: { id: itemA } }),
      ).not.toBeNull();
    });
  });
});
