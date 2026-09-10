import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * FULL-SRS-PRC-PURCHASE-ORDERS-P2 §16 — proves the PostgreSQL RLS boundary
 * for the five new Procurement tables DIRECTLY, exercised only through the
 * RLS-constrained runtime role (ros_app) via PrismaService. The migrator
 * client arranges fixtures / observes true row state — never evidence of
 * application isolation. Mirrors `procurement-rls.e2e-spec.ts`'s own
 * pattern exactly.
 *
 * `requestingBranchId`/`requestedBy`/`stockItemId`/`purchaseUnitId`/
 * `attributionBranchId`/`deliveryLocationId` carry no DB FK (module
 * boundary — see the migration's own header comment), so this suite uses
 * arbitrary ids for them; RLS isolation of `procurement.*` does not depend
 * on Organisation/Inventory data existing.
 */
describe('Procurement Purchase Orders RLS enforcement as ros_app (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService; // ros_app (NOBYPASSRLS)
  let admin: PrismaClient; // ros_migrator (arrange/observe only)

  const ts = Date.now();
  const A = newId();
  const B = newId();
  const supplierA = newId();
  const supplierB = newId();

  const requisitionA = newId();
  const requisitionLineA = newId();
  const poA = newId();
  const poLineA = newId();
  const amendmentA = newId();

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
        slug: `pcporls-${i}-${ts}`,
        legalName: 'PoRLS',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })),
    });

    for (const [tenantId, supplierId] of [
      [A, supplierA],
      [B, supplierB],
    ] as const) {
      await admin.supplier.create({
        data: {
          id: supplierId,
          tenantId,
          code: `SUP-${tenantId === A ? 'A' : 'B'}-${ts}`,
          legalName: 'Supplier',
          paymentTermsNetDays: 30,
          currency: 'EGP',
          deliveryLeadTimeDays: 3,
          minimumOrderValue: 0n,
          deliveryDays: [],
        },
      });
    }

    await admin.purchaseRequisition.create({
      data: {
        id: requisitionA,
        tenantId: A,
        requestingBranchId: newId(),
        requestedBy: newId(),
        status: 'draft',
      },
    });
    await admin.purchaseRequisitionLine.create({
      data: {
        id: requisitionLineA,
        tenantId: A,
        requisitionId: requisitionA,
        stockItemId: newId(),
        quantity: '1',
        purchaseUnitId: newId(),
      },
    });

    await admin.purchaseOrder.create({
      data: {
        id: poA,
        tenantId: A,
        supplierId: supplierA,
        deliveryLocationType: 'branch',
        deliveryLocationId: newId(),
        expectedDeliveryDate: new Date('2026-06-01'),
        currency: 'EGP',
        status: 'draft',
        requestedBy: newId(),
        subtotal: 0n,
        taxTotal: 0n,
        grandTotal: 0n,
        version: 1,
      },
    });
    await admin.purchaseOrderLine.create({
      data: {
        id: poLineA,
        tenantId: A,
        purchaseOrderId: poA,
        stockItemId: newId(),
        purchaseUnitId: newId(),
        quantity: '1',
        unitPrice: 1000n,
        netAmount: 1000n,
        taxAmount: 0n,
        lineTotal: 1000n,
        attributionBranchId: newId(),
      },
    });
    await admin.purchaseOrderAmendment.create({
      data: {
        id: amendmentA,
        tenantId: A,
        purchaseOrderId: poA,
        amendmentNumber: 1,
        changedBy: newId(),
        reason: 'test amendment',
        beforeSnapshot: {},
        afterSnapshot: {},
        oldTotal: 0n,
        newTotal: 1000n,
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('cross-tenant → invisible / fails closed', () => {
    it('Tenant B cannot read Tenant A PurchaseRequisition', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.purchaseRequisition.findMany({ where: { id: requisitionA } }),
      );
      expect(rows).toEqual([]);
      expect(
        await admin.purchaseRequisition.findUnique({
          where: { id: requisitionA },
        }),
      ).not.toBeNull();
    });

    it('Tenant B cannot read Tenant A PurchaseRequisitionLine', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.purchaseRequisitionLine.findMany({
          where: { id: requisitionLineA },
        }),
      );
      expect(rows).toEqual([]);
    });

    it('Tenant B cannot read Tenant A PurchaseOrder', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.purchaseOrder.findMany({ where: { id: poA } }),
      );
      expect(rows).toEqual([]);
      expect(
        await admin.purchaseOrder.findUnique({ where: { id: poA } }),
      ).not.toBeNull();
    });

    it('Tenant B cannot read Tenant A PurchaseOrderLine', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.purchaseOrderLine.findMany({ where: { id: poLineA } }),
      );
      expect(rows).toEqual([]);
    });

    it('Tenant B cannot read Tenant A PurchaseOrderAmendment', async () => {
      const rows = await prisma.withAuthContext({ tenantId: B }, (tx) =>
        tx.purchaseOrderAmendment.findMany({ where: { id: amendmentA } }),
      );
      expect(rows).toEqual([]);
    });

    it('cross-tenant PurchaseRequisition INSERT (tenant_id spoofing) fails closed', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.purchaseRequisition.create({
            data: {
              id: newId(),
              tenantId: A,
              requestingBranchId: newId(),
              requestedBy: newId(),
              status: 'draft',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('cross-tenant PurchaseOrder INSERT (tenant_id spoofing) fails closed', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.purchaseOrder.create({
            data: {
              id: newId(),
              tenantId: A,
              supplierId: supplierA,
              deliveryLocationType: 'branch',
              deliveryLocationId: newId(),
              expectedDeliveryDate: new Date('2026-06-01'),
              currency: 'EGP',
              status: 'draft',
              requestedBy: newId(),
              subtotal: 0n,
              taxTotal: 0n,
              grandTotal: 0n,
              version: 1,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('cross-tenant PurchaseOrderAmendment INSERT (tenant_id spoofing) fails closed', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: B }, (tx) =>
          tx.purchaseOrderAmendment.create({
            data: {
              id: newId(),
              tenantId: A,
              purchaseOrderId: poA,
              amendmentNumber: 99,
              changedBy: newId(),
              reason: 'spoof',
              beforeSnapshot: {},
              afterSnapshot: {},
              oldTotal: 0n,
              newTotal: 0n,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('PurchaseOrderAmendment is append-only: even an own-tenant UPDATE is rejected (no UPDATE grant, §10)', async () => {
      // Prisma Client's generated typings are schema-based, not grant-based
      // — `.update()` type-checks fine; the DB `REVOKE UPDATE` is what must
      // reject it at runtime, regardless of tenant match.
      await expect(
        prisma.withAuthContext({ tenantId: A }, (tx) =>
          tx.purchaseOrderAmendment.update({
            where: { id: amendmentA },
            data: { reason: 'tampered' },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('same tenant → allowed', () => {
    it('Tenant A sees its own Requisition/PO/Line/Amendment rows', async () => {
      const [requisitions, lines, pos, poLines, amendments] =
        await prisma.withAuthContext({ tenantId: A }, (tx) =>
          Promise.all([
            tx.purchaseRequisition.findMany({ where: { id: requisitionA } }),
            tx.purchaseRequisitionLine.findMany({
              where: { id: requisitionLineA },
            }),
            tx.purchaseOrder.findMany({ where: { id: poA } }),
            tx.purchaseOrderLine.findMany({ where: { id: poLineA } }),
            tx.purchaseOrderAmendment.findMany({ where: { id: amendmentA } }),
          ]),
        );
      expect(requisitions).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(pos).toHaveLength(1);
      expect(poLines).toHaveLength(1);
      expect(amendments).toHaveLength(1);
    });

    it('Tenant A can update its own PurchaseOrder (mutable, unlike the append-only amendment)', async () => {
      const updated = await prisma.withAuthContext({ tenantId: A }, (tx) =>
        tx.purchaseOrder.update({
          where: { id: poA },
          data: { status: 'pending_approval' },
        }),
      );
      expect(updated.status).toBe('pending_approval');
      // restore for any later test ordering assumptions
      await admin.purchaseOrder.update({
        where: { id: poA },
        data: { status: 'draft' },
      });
    });
  });
});
