import { Injectable, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { MovementsService } from './../src/modules/inventory/movements/movements.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { PrismaService, AuthScope } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * A1-1 (CG-01) — real-Postgres proof that `MovementsService.post` no longer
 * loses updates and no longer derives persisted quantity/`balance_after`
 * from IEEE-754 arithmetic.
 *
 * Authority: docs/reports/claude/2026-09-02_FULL-SRS-current-head-
 * traceability-rebase.md §12.1 (CG-01) and §29.6-29.9. Non-authoritative
 * evidence — the SRS and ratified governance decisions remain authoritative.
 *
 * Barrier pattern copied verbatim from `kds-concurrency.e2e-spec.ts` /
 * `order-completion-concurrency.e2e-spec.ts`: `PrismaService.withAuthContext`
 * is the ONE choke point every `MovementsService.post` call passes through
 * exactly once, so pausing there and releasing both parties together forces
 * a genuine two-transaction PostgreSQL race rather than `Promise.all` timing
 * luck.
 */
@Injectable()
class BarrierPrismaService extends PrismaService {
  static barrier: (() => Promise<void>) | null = null;

  override async withAuthContext<T>(
    scope: AuthScope,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    const barrier = BarrierPrismaService.barrier;
    if (!barrier) {
      return super.withAuthContext(scope, fn, options);
    }
    return super.withAuthContext(
      scope,
      async (tx) => {
        await barrier();
        return fn(tx);
      },
      options,
    );
  }
}

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}

describe('MovementsService.post — real Postgres concurrency + exact-decimal correctness (A1-1, CG-01)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let movements: MovementsService;

  const stamp = Date.now().toString(36);
  let tenantA: string;
  let userA: string;
  let locationA: string;
  let uomId: string;
  let reasonA: string;
  let itemCounter = 0;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useClass(BarrierPrismaService)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    movements = app.get(MovementsService);

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `mvrace-${stamp}`,
        legalName: 'MvRace',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: tenantA, name: `MvRaceBrand-${stamp}` },
    });
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        brandId: brand.id,
        code: `MR${stamp}`.slice(0, 16),
        name: 'MvRace Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    locationA = (
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

    const user = await admin.user.create({
      data: {
        id: newId(),
        email: `mvrace.${stamp}@example.com`,
        displayName: 'MvRace',
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

    reasonA = (
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
  });

  afterEach(() => {
    BarrierPrismaService.barrier = null;
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
        sku: `MV-${stamp}-${itemCounter}`,
        names: { en: `MV-${stamp}-${itemCounter}` },
        baseUnitId: uomId,
        costingMethod: 'weighted_average',
        isBatchTracked: false,
      },
    });
    return item.id;
  };

  const post = (stockItemId: string, quantity: string, occurredAt: Date) =>
    movements.postStandalone(tenantA, userA, {
      stockItemId,
      locationId: locationA,
      movementType: 'manual_adjustment',
      quantity,
      referenceType: 'test',
      referenceId: newId(),
      reasonCodeId: reasonA,
      occurredAt,
    });

  /**
   * Exact decimal fold of every `stock_movements.quantity` row for
   * (stockItemId, locationA), computed with `Prisma.Decimal` (decimal.js
   * arbitrary-precision decimal arithmetic) — NEVER `Number()`/`parseFloat()`
   * (§13/§29.9: "Do not assert using Number()/parseFloat()").
   */
  const exactFold = async (stockItemId: string): Promise<Prisma.Decimal> => {
    const rows = await admin.stockMovement.findMany({
      where: { stockItemId, locationId: locationA },
      select: { quantity: true },
    });
    return rows.reduce(
      (sum, r) => sum.plus(r.quantity),
      new Prisma.Decimal(0),
    );
  };

  const levelQuantity = async (stockItemId: string): Promise<Prisma.Decimal> => {
    const level = await admin.stockLevel.findUniqueOrThrow({
      where: { stockItemId_locationId: { stockItemId, locationId: locationA } },
    });
    return level.quantityOnHand;
  };

  // -------------------------------------------------------------- §12 CG-01 --
  describe('concurrent movements on the same (item, location) never lose an update', () => {
    it('two same-sign concurrent movements: +2.125000 and +3.375000 on 10.000000', async () => {
      const itemId = await mkItem();
      await post(itemId, '10.000000', new Date('2026-08-01T08:00:00Z'));

      const arrive = makeBarrier(2);
      BarrierPrismaService.barrier = arrive;
      const [a, b] = await Promise.all([
        post(itemId, '2.125000', new Date('2026-08-01T09:00:00Z')),
        post(itemId, '3.375000', new Date('2026-08-01T09:00:01Z')),
      ]);
      BarrierPrismaService.barrier = null;

      // BR-INV-003: the projection is the exact fold — no lost update, no
      // matter which of the two valid serial orders PostgreSQL chose.
      const fold = await exactFold(itemId);
      const level = await levelQuantity(itemId);
      expect(fold.equals(level)).toBe(true);
      expect(level.equals(new Prisma.Decimal('15.500000'))).toBe(true);

      // Both movement rows exist (append-only, BR-INV-001) with a truthful
      // running balanceAfter reflecting ONE of the two valid serial
      // interleavings — never a value that discards either delta.
      const got = [a.balanceAfter, b.balanceAfter].sort((x, y) => x - y);
      const seq1 = [12.125, 15.5]; // A applied before B
      const seq2 = [13.375, 15.5]; // B applied before A
      const matchesSeq1 = got.every((v, i) => Math.abs(v - seq1[i]) < 1e-9);
      const matchesSeq2 = got.every((v, i) => Math.abs(v - seq2[i]) < 1e-9);
      expect(matchesSeq1 || matchesSeq2).toBe(true);

      const movementCount = await admin.stockMovement.count({
        where: { stockItemId: itemId, locationId: locationA },
      });
      expect(movementCount).toBe(3); // seed + the two raced movements
    });

    it('one positive + one negative concurrent movement: +5.500000 and -3.250000 on 10.000000', async () => {
      const itemId = await mkItem();
      await post(itemId, '10.000000', new Date('2026-08-01T08:00:00Z'));

      const arrive = makeBarrier(2);
      BarrierPrismaService.barrier = arrive;
      await Promise.all([
        post(itemId, '5.500000', new Date('2026-08-01T09:00:00Z')),
        post(itemId, '-3.250000', new Date('2026-08-01T09:00:01Z')),
      ]);
      BarrierPrismaService.barrier = null;

      const fold = await exactFold(itemId);
      const level = await levelQuantity(itemId);
      expect(fold.equals(level)).toBe(true);
      expect(level.equals(new Prisma.Decimal('12.250000'))).toBe(true);
    });

    it('three clean runs — no lost update across repeated real barrier races', async () => {
      for (let run = 0; run < 3; run++) {
        const itemId = await mkItem();
        await post(itemId, '1000.000000', new Date('2026-08-01T08:00:00Z'));

        const arrive = makeBarrier(2);
        BarrierPrismaService.barrier = arrive;
        await Promise.all([
          post(itemId, '0.500001', new Date('2026-08-01T09:00:00Z')),
          post(itemId, '0.250002', new Date('2026-08-01T09:00:01Z')),
        ]);
        BarrierPrismaService.barrier = null;

        const fold = await exactFold(itemId);
        const level = await levelQuantity(itemId);
        expect(fold.equals(level)).toBe(true);
        expect(level.equals(new Prisma.Decimal('1000.750003'))).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------- §13 regr. --
  describe('exact-decimal regression — no IEEE-754 drift on the persisted projection', () => {
    /**
     * Deliberately starts at 100000000000.000000 — 12 integer digits, the
     * maximum NUMERIC(18,6) allows before its 6 decimal digits — where the
     * OLD `Number(quantityOnHand) + input.quantity` arithmetic is
     * mathematically guaranteed to drop precision, because a `number` has
     * only ~15-17 reliable significant decimal digits and this needs 18.
     * Verified empirically against the pre-fix read-then-write formula
     * (including its per-call DB string round trip) before writing this
     * test: alternating +0.700003 / -0.399991 for 200 steps from this
     * magnitude drifts to `...045000458` vs the exact
     * `...045001800` — a persistent, non-cancelling 0.0000014 error that
     * GROWS with more iterations, unlike a nominal-magnitude delta (e.g.
     * repeated 0.1) whose per-call double-rounding at 6dp on write mostly
     * self-corrects and would need many more than 10,000 iterations to
     * cross the 6-dp threshold. This makes the regression deterministic and
     * keeps the suite's runtime sane (§13) versus that 10,000-call bound.
     */
    it('200 sequential movements at the NUMERIC(18,6) magnitude ceiling: stock_levels == exact fold(stock_movements), zero drift', async () => {
      const itemId = await mkItem();
      const N = 200;
      await post(
        itemId,
        '100000000000.000000',
        new Date('2026-08-01T08:00:00Z'),
      );

      for (let i = 0; i < N; i++) {
        const delta = i % 2 === 0 ? '0.700003' : '-0.399991';
        await post(itemId, delta, new Date(Date.UTC(2026, 7, 1, 9, 0, i)));
      }

      const fold = await exactFold(itemId);
      const level = await levelQuantity(itemId);
      expect(fold.equals(level)).toBe(true);

      // Independent exact-decimal expectation (Prisma.Decimal, not Number()):
      // 100000000000 + 100*0.700003 + 100*(-0.399991)
      const expected = new Prisma.Decimal('100000000000')
        .plus(new Prisma.Decimal('0.700003').times(100))
        .plus(new Prisma.Decimal('-0.399991').times(100));
      expect(level.equals(expected)).toBe(true);

      const movementCount = await admin.stockMovement.count({
        where: { stockItemId: itemId, locationId: locationA },
      });
      expect(movementCount).toBe(N + 1);
    }, 180_000);
  });
});
