import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1 §13/§16 — proves the PostgreSQL RLS
 * boundary for Procurement DIRECTLY, exercised only through the
 * RLS-constrained runtime role (ros_app) via PrismaService. The migrator
 * client arranges fixtures / observes true row state — never evidence of
 * application isolation. Mirrors `inventory-rls.e2e-spec.ts`'s own pattern.
 *
 * `stockItemId`/`purchaseUnitId` carry no DB FK (module-boundary — see the
 * migration's own header comment), so this suite uses arbitrary ids for
 * them; RLS isolation of `procurement.*` itself does not depend on Inventory
 * data existing.
 */
describe('Procurement RLS enforcement as ros_app (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService; // ros_app (NOBYPASSRLS)
  let admin: PrismaClient; // ros_migrator (arrange/observe only)

  const ts = Date.now();
  const A = newId();
  const B = newId();
  const supplierA = newId();
  const supplierB = newId();
  const linkA = newId();
  const priceEntryA = newId();
  const stockItemIdA = newId();
  const purchaseUnitIdA = newId();

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
        slug: `prcrls-${i}-${ts}`,
        legalName: 'PrcRLS',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
    });

    await admin.supplier.create({
      data: {
        id: supplierA,
        tenantId: A,
        code: `SUP-A-${ts}`,
        legalName: 'Supplier A',
        paymentTermsNetDays: 30,
        currency: 'EGP',
        deliveryLeadTimeDays: 3,
        minimumOrderValue: 0n,
        deliveryDays: [1, 2, 3],
      },
    });
    await admin.supplier.create({
      data: {
        id: supplierB,
        tenantId: B,
        code: `SUP-B-${ts}`,
        legalName: 'Supplier B',
        paymentTermsNetDays: 30,
        currency: 'EGP',
        deliveryLeadTimeDays: 3,
        minimumOrderValue: 0n,
        deliveryDays: [1, 2, 3],
      },
    });
    await admin.supplierItemLink.create({
      data: {
        id: linkA,
        tenantId: A,
        supplierId: supplierA,
        stockItemId: stockItemIdA,
        preferenceRank: 0,
      },
    });
    await admin.supplierPriceEntry.create({
      data: {
        id: priceEntryA,
        tenantId: A,
        supplierId: supplierA,
        supplierItemLinkId: linkA,
        purchaseUnitId: purchaseUnitIdA,
        packSize: '1',
        unitPrice: 1000n,
        currency: 'EGP',
        validFrom: new Date('2026-01-01T00:00:00Z'),
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('cross-tenant → invisible / fails closed', () => {
    it('Tenant A cannot read Tenant B Supplier', async () => {
      const rows = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.supplier.findMany({ where: { id: supplierB } }),
      );
      expect(rows).toEqual([]);
    });

    it('Tenant A cannot read Tenant B SupplierItemLink (via cross-tenant lookup)', async () => {
      const linkB = newId();
      await admin.supplierItemLink.create({
        data: {
          id: linkB,
          tenantId: B,
          supplierId: supplierB,
          stockItemId: newId(),
        },
      });
      const rows = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.supplierItemLink.findMany({ where: { id: linkB } }),
      );
      expect(rows).toEqual([]);
      // Migrator (RLS-bypassing) confirms the row genuinely exists.
      expect(
        await admin.supplierItemLink.findUnique({ where: { id: linkB } }),
      ).not.toBeNull();
    });

    it('Tenant A cannot read Tenant B SupplierPriceEntry', async () => {
      const linkB2 = newId();
      const entryB = newId();
      await admin.supplierItemLink.create({
        data: {
          id: linkB2,
          tenantId: B,
          supplierId: supplierB,
          stockItemId: newId(),
        },
      });
      await admin.supplierPriceEntry.create({
        data: {
          id: entryB,
          tenantId: B,
          supplierId: supplierB,
          supplierItemLinkId: linkB2,
          purchaseUnitId: newId(),
          packSize: '1',
          unitPrice: 500n,
          currency: 'EGP',
          validFrom: new Date('2026-01-01T00:00:00Z'),
        },
      });
      const rows = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.supplierPriceEntry.findMany({ where: { id: entryB } }),
      );
      expect(rows).toEqual([]);
    });

    it('cross-tenant Supplier INSERT (tenant_id spoofing) fails closed', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.supplier.create({
            data: {
              id: newId(),
              tenantId: B,
              code: `spoof-${ts}`,
              legalName: 'Spoofed',
              paymentTermsNetDays: 0,
              currency: 'EGP',
              deliveryLeadTimeDays: 0,
              minimumOrderValue: 0n,
              deliveryDays: [],
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('cross-tenant SupplierPriceEntry INSERT (tenant_id spoofing) fails closed', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.supplierPriceEntry.create({
            data: {
              id: newId(),
              tenantId: B,
              supplierId: supplierA,
              supplierItemLinkId: linkA,
              purchaseUnitId: newId(),
              packSize: '1',
              unitPrice: 1n,
              currency: 'EGP',
              validFrom: new Date(),
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('SupplierPriceEntry is append-only: even an own-tenant UPDATE is rejected (no UPDATE grant, §7)', async () => {
      // Prisma Client's generated typings are schema-based, not grant-based
      // — `.update()` type-checks fine; the DB `REVOKE UPDATE` is what must
      // reject it at runtime, regardless of tenant match.
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.supplierPriceEntry.update({
            where: { id: priceEntryA },
            data: { unitPrice: 2n },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('same tenant → allowed', () => {
    it('Tenant A sees its own Supplier/SupplierItemLink/SupplierPriceEntry', async () => {
      const [suppliers, links, entries] = await prisma.withAuthContext(
        { tenantId: A },
        (tx) =>
          Promise.all([
            tx.supplier.findMany({ where: { id: supplierA } }),
            tx.supplierItemLink.findMany({ where: { id: linkA } }),
            tx.supplierPriceEntry.findMany({ where: { id: priceEntryA } }),
          ]),
      );
      expect(suppliers).toHaveLength(1);
      expect(links).toHaveLength(1);
      expect(entries).toHaveLength(1);
    });

    it('Tenant A can update its own Supplier (status change)', async () => {
      const updated = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.supplier.update({
          where: { id: supplierA },
          data: { status: 'inactive' },
        }),
      );
      expect(updated.status).toBe('inactive');
      // restore for any later test ordering assumptions
      await admin.supplier.update({
        where: { id: supplierA },
        data: { status: 'active' },
      });
    });
  });
});
