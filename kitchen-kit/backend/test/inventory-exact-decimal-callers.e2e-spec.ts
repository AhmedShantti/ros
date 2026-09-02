import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { CountsService } from './../src/modules/inventory/counts/counts.service';
import { TransfersService } from './../src/modules/inventory/movements/transfers.service';
import { WasteService } from './../src/modules/inventory/waste/waste.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { createMigratorClient } from './rls-admin';

/**
 * A1-1 ACCEPTANCE CORRECTION — exact persisted movement deltas for every
 * `MovementsService.post` caller (Transfers, Counts, Waste).
 *
 * Authority: docs/reports/claude/2026-09-02_FULL-SRS-current-head-
 * traceability-rebase.md §12.1 (CG-01) and the correction task itself.
 * Non-authoritative evidence — the SRS and ratified governance decisions
 * remain authoritative.
 *
 * The A1-1 slice made `MovementsService.post` itself atomic and exact, but
 * left each caller's OWN pre-existing arithmetic (`Number(dto.quantity)`,
 * `Math.abs`, `discrepancy = received - dispatched`, count `variance`)
 * untouched — those callers merely `.toFixed(6)`'d whatever float they had
 * already computed before handing it to the now-exact `post()`. This suite
 * proves the correction: nothing between the DTO's validated decimal string
 * and the persisted `stock_movements.quantity` goes through a JS `number`
 * anywhere the task named (Transfers dispatch/receive, Counts variance,
 * Waste), using magnitudes that make the pre-fix behaviour deterministically
 * wrong rather than a matter of luck — verified by literally reintroducing
 * it (see the accompanying report §6).
 */
describe('Exact persisted movement deltas — Transfers/Counts/Waste (A1-1 correction)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let transfers: TransfersService;
  let counts: CountsService;
  let waste: WasteService;

  const stamp = Date.now().toString(36);
  let tenantA: string;
  let userA: string;
  let locationA: string;
  let locationB: string;
  let uomId: string;
  let reasonAdjustment: string;
  let reasonWaste: string;
  let itemCounter = 0;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    transfers = app.get(TransfersService);
    counts = app.get(CountsService);
    waste = app.get(WasteService);

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `xdec-${stamp}`,
        legalName: 'ExactDecimal',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `XDecBrand-${stamp}` },
    });
    const mkLocation = async (code: string) => {
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          brandId: brand.id,
          code: `${code}${stamp}`.slice(0, 16),
          name: `XDec Branch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      return (
        await admin.location.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            locationType: 'branch',
            refId: branch.id,
            branchId: branch.id,
          },
        })
      ).id;
    };
    locationA = await mkLocation('A');
    locationB = await mkLocation('B');

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `xdec.${stamp}@example.com`,
        displayName: 'XDec',
      },
    });
    userA = user.id;
    await admin.membership.create({
      data: { id: newId(), userId: userA, tenantId: tenantA, status: 'active' },
    });

    uomId = newId();
    await admin.uom.create({
      data: {
        id: uomId,
        dimension: 'mass',
        code: `g-${stamp}`,
        name: 'gram',
        baseUnitOfDimension: true,
      },
    });

    reasonAdjustment = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'adjustment',
          code: `adj-${stamp}`,
          label: { en: 'Adjustment' },
        },
      })
    ).id;
    reasonWaste = (
      await admin.reasonCode.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          category: 'waste',
          code: `waste-${stamp}`,
          label: { en: 'Waste' },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  /** A fresh non-batch-tracked item per test, so state never carries over. */
  const mkItem = async (): Promise<string> => {
    itemCounter += 1;
    const item = await admin.stockItem.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        sku: `XD-${stamp}-${itemCounter}`,
        names: { en: `XD-${stamp}-${itemCounter}` },
        baseUnitId: uomId,
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      },
    });
    return item.id;
  };

  const movementQuantity = async (
    movementId: string,
  ): Promise<Prisma.Decimal> => {
    const mv = await admin.stockMovement.findFirstOrThrow({
      where: { id: movementId },
    });
    return mv.quantity;
  };

  // ---------------------------------------------------------------- TRANSFER --
  describe('TransfersService — exact dispatched/received/discrepancy', () => {
    it('the task-specified example: dispatched 0.300003, received 0.100001, discrepancy -0.200002', async () => {
      const stockItemId = await mkItem();
      const dispatchResult = await transfers.dispatch(tenantA, userA, {
        stockItemId,
        fromLocationId: locationA,
        toLocationId: locationB,
        quantity: '0.300003',
        reasonCodeId: reasonAdjustment,
      });
      const outQty = await movementQuantity(dispatchResult.dispatchMovementId);
      expect(outQty.equals(new Prisma.Decimal('-0.300003'))).toBe(true);

      const receiveResult = await transfers.receive(tenantA, userA, locationB, {
        transferReferenceId: dispatchResult.transferReferenceId,
        receivedQuantity: '0.100001',
        discrepancyReasonCodeId: reasonAdjustment,
      });
      const inQty = await movementQuantity(receiveResult.receiveMovementId);
      // transfer_in is ALWAYS posted at the dispatched quantity (BR-INV-002).
      expect(inQty.equals(new Prisma.Decimal('0.300003'))).toBe(true);

      expect(receiveResult.adjustmentMovementId).not.toBeNull();
      const adjQty = await movementQuantity(
        receiveResult.adjustmentMovementId!,
      );
      expect(adjQty.equals(new Prisma.Decimal('-0.200002'))).toBe(true);
    });

    it('adversarial magnitude at the NUMERIC(18,6) ceiling: single-step Number() conversion is mathematically guaranteed lossy here', async () => {
      // Verified before writing this test: Number('100000000000.123456')
      // .toFixed(6) === '100000000000.123459' — a real, deterministic,
      // single-operation precision loss at this magnitude (18 significant
      // decimal digits; a JS double reliably holds ~15-17).
      const stockItemId = await mkItem();
      const dispatchResult = await transfers.dispatch(tenantA, userA, {
        stockItemId,
        fromLocationId: locationA,
        toLocationId: locationB,
        quantity: '100000000000.123456',
        reasonCodeId: reasonAdjustment,
      });
      const outQty = await movementQuantity(dispatchResult.dispatchMovementId);
      expect(outQty.equals(new Prisma.Decimal('-100000000000.123456'))).toBe(
        true,
      );

      const receiveResult = await transfers.receive(tenantA, userA, locationB, {
        transferReferenceId: dispatchResult.transferReferenceId,
        receivedQuantity: '100000000000.523456',
        discrepancyReasonCodeId: reasonAdjustment,
      });
      const inQty = await movementQuantity(receiveResult.receiveMovementId);
      expect(inQty.equals(new Prisma.Decimal('100000000000.123456'))).toBe(
        true,
      );

      const adjQty = await movementQuantity(
        receiveResult.adjustmentMovementId!,
      );
      // 100000000000.523456 - 100000000000.123456 = 0.400000 exactly.
      expect(adjQty.equals(new Prisma.Decimal('0.400000'))).toBe(true);
    });

    it('zero discrepancy needs no reason code and writes no adjustment movement', async () => {
      const stockItemId = await mkItem();
      const dispatchResult = await transfers.dispatch(tenantA, userA, {
        stockItemId,
        fromLocationId: locationA,
        toLocationId: locationB,
        quantity: '0.700003',
        reasonCodeId: reasonAdjustment,
      });
      const receiveResult = await transfers.receive(tenantA, userA, locationB, {
        transferReferenceId: dispatchResult.transferReferenceId,
        receivedQuantity: '0.700003',
      });
      expect(receiveResult.adjustmentMovementId).toBeNull();
    });
  });

  // ------------------------------------------------------------------ COUNT --
  describe('CountsService — exact variance', () => {
    /** Opens a count session with one line at an explicit expectedQuantity, bypassing `open()` to isolate the exactness of recordCount/post. */
    const mkCountLine = async (
      stockItemId: string,
      expectedQuantity: string,
    ) => {
      const session = await admin.countSession.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          locationId: locationA,
          scopeType: 'full_location',
          isBlindCount: false,
          startedBy: userA,
        },
      });
      const line = await admin.countLine.create({
        data: {
          id: newId(),
          countSessionId: session.id,
          stockItemId,
          expectedQuantity: new Prisma.Decimal(expectedQuantity),
        },
      });
      return { sessionId: session.id, lineId: line.id };
    };

    it('adversarial magnitude: expectedQuantity/countedQuantity at the NUMERIC(18,6) ceiling', async () => {
      const stockItemId = await mkItem();
      const { sessionId, lineId } = await mkCountLine(
        stockItemId,
        '100000000000.100000',
      );

      const recorded = await counts.recordCount(
        tenantA,
        userA,
        lineId,
        '100000000000.500000',
      );
      expect(recorded.variance).toBe('0.4');

      const posted = await counts.post(tenantA, userA, sessionId);
      expect(posted.adjustments).toHaveLength(1);
      const movementId = (
        await admin.stockMovement.findFirstOrThrow({
          where: {
            stockItemId,
            locationId: locationA,
            movementType: 'count_adjustment',
            referenceId: sessionId,
          },
        })
      ).id;
      const qty = await movementQuantity(movementId);
      expect(qty.equals(new Prisma.Decimal('0.400000'))).toBe(true);
    });

    it('zero variance posts no movement', async () => {
      const stockItemId = await mkItem();
      const { sessionId, lineId } = await mkCountLine(stockItemId, '5.000000');
      await counts.recordCount(tenantA, userA, lineId, '5.000000');
      const posted = await counts.post(tenantA, userA, sessionId);
      expect(posted.adjustments).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ WASTE --
  describe('WasteService — exact negative movement + waste_lines quantity', () => {
    it('adversarial magnitude at the NUMERIC(18,6) ceiling', async () => {
      const stockItemId = await mkItem();
      const result = await waste.record(tenantA, userA, {
        locationId: locationA,
        reasonCodeId: reasonWaste,
        lines: [{ stockItemId, quantity: '100000000000.123456' }],
      });
      const movementId = result.lines[0].movementId;
      const qty = await movementQuantity(movementId);
      expect(qty.equals(new Prisma.Decimal('-100000000000.123456'))).toBe(true);

      const line = await admin.wasteLine.findFirstOrThrow({
        where: { wasteRecordId: result.id, stockItemId },
      });
      expect(
        line.quantity.equals(new Prisma.Decimal('100000000000.123456')),
      ).toBe(true);
    });

    it('a plain 6dp quantity persists exactly', async () => {
      const stockItemId = await mkItem();
      const result = await waste.record(tenantA, userA, {
        locationId: locationA,
        reasonCodeId: reasonWaste,
        lines: [{ stockItemId, quantity: '2.700003' }],
      });
      const qty = await movementQuantity(result.lines[0].movementId);
      expect(qty.equals(new Prisma.Decimal('-2.700003'))).toBe(true);
    });
  });
});
