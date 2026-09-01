import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  DAY_CLOSE_SALES_FACTS_QUERY,
  type DayCloseSalesFacts,
  type DayCloseSalesFactsQuery,
  type DayCloseSalesFactsQueryInput,
} from './../src/modules/sales/contract';
import { DayCloseSalesFactsQueryService } from './../src/modules/sales/orders/day-close-sales-facts.query.service';
import { DayCloseService } from './../src/modules/treasury/day-close/day-close.service';
import { TREASURY_PERMISSIONS } from './../src/modules/treasury/treasury.permissions';
import { Prisma } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';
import {
  activatePastEpoch,
  branchBusinessDay,
  createDayCloseFixture,
  daysBefore,
  DayCloseFixture,
} from './day-close-fixtures';

/**
 * DayClose — Z-NUMBER CONCURRENCY (acceptance-completion task §6).
 *
 * `day-close.service.ts`'s own docblock (§13 final design gate, §11
 * acceptance correction) is explicit that Z numbering is DELIBERATELY
 * `MAX(z_number)+1` computed inside the closing transaction, with NO
 * SEQUENCE object and NO advisory lock added for numbering — the
 * `UNIQUE(tenant_id, branch_id, z_number)` constraint plus a bounded local
 * retry (`post()`, `MAX_ATTEMPTS = 5`) is the ratified mechanism. This suite
 * does not reopen that design; it proves the retry mechanism actually
 * works.
 *
 * TWO DIFFERENT eligible past business days on the SAME branch use
 * DIFFERENT `ros_order_number(branchId, businessDay)` fence keys, so they
 * do NOT serialise against each other the way same-day close attempts do
 * (proven separately by `day-close-cutover-race.e2e-spec.ts`) — they CAN
 * run genuinely concurrently up to the `z_number` read/insert. To force a
 * real, deterministic head-to-head collision on that specific window
 * (rather than leaving it to incidental Node/Postgres scheduling), a
 * barrier is installed at the EXISTING `DAY_CLOSE_SALES_FACTS_QUERY`
 * injection seam — the same "override a real DI-bound query with a
 * barrier-aware wrapper" technique `order-completion-concurrency.e2e-spec.ts`
 * already establishes for `CASH_SESSION_FACTS_QUERY`. This adds NO lock,
 * NO sequence, and NO change to `day-close.service.ts` itself — it only
 * widens, for the test, the real window between the fence release and the
 * `z_number` read that already exists in production. No sleeps.
 */
describe('DayClose — Z-number concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let dayClose: DayCloseService;

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

  class BarrierAwareSalesFacts implements DayCloseSalesFactsQuery {
    barrier: (() => Promise<void>) | null = null;
    real!: DayCloseSalesFactsQueryService;
    async facts(
      tx: Prisma.TransactionClient,
      input: DayCloseSalesFactsQueryInput,
    ): Promise<DayCloseSalesFacts> {
      if (this.barrier) await this.barrier();
      return this.real.facts(tx, input);
    }
  }
  const salesFactsStub = new BarrierAwareSalesFacts();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DAY_CLOSE_SALES_FACTS_QUERY)
      .useValue(salesFactsStub)
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    dayClose = app.get(DayCloseService);
    // Wrap the REAL registered service instance (never a
    // re-implementation of the sales-facts algorithm — only a
    // pass-through barrier). `DayCloseSalesFactsQueryService` is still
    // registered directly in `SalesModule`'s providers array (the
    // override above only replaces the `DAY_CLOSE_SALES_FACTS_QUERY`
    // token binding), so it resolves from this SAME container.
    salesFactsStub.real = app.get(DayCloseSalesFactsQueryService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let seedN = 0;
  const seed = () => `${stamp}${(seedN++).toString(36)}`;

  const DAY_CLOSE_PERMISSIONS = new Set([TREASURY_PERMISSIONS.CASH_DAY_CLOSE]);

  async function mkFx(): Promise<{
    fx: DayCloseFixture;
    dayD: Date;
    dayD1: Date;
  }> {
    const fx = await createDayCloseFixture(app, admin, seed());
    const activationBusinessDay = daysBefore(branchBusinessDay(new Date()), 8);
    await activatePastEpoch(admin, {
      tenantId: fx.tenantId,
      branchId: fx.branchId,
      activatedByUserId: fx.employeeUserId,
      activationBusinessDay,
    });
    const dayD = daysBefore(activationBusinessDay, -1); // A+1
    const dayD1 = daysBefore(dayD, -1); // A+2, both eligible, both < today
    return { fx, dayD, dayD1 };
  }

  function close(fx: DayCloseFixture, businessDay: Date) {
    return dayClose.post(
      fx.tenantId,
      fx.employeeUserId,
      { employeeId: fx.employeeId, terminalId: fx.terminalId },
      DAY_CLOSE_PERMISSIONS,
      { branchId: fx.branchId, businessDay },
    );
  }

  for (let run = 1; run <= 3; run++) {
    it(`run ${run}/3: two different eligible days closing concurrently — distinct sequential Z numbers, exactly one root each, no duplicate audit/event`, async () => {
      const { fx, dayD, dayD1 } = await mkFx();
      const arrive = makeBarrier(2);
      salesFactsStub.barrier = arrive;
      try {
        const [resD, resD1] = await Promise.all([
          close(fx, dayD),
          close(fx, dayD1),
        ]);
        expect(resD.outcome).toBe('CLOSED');
        expect(resD1.outcome).toBe('CLOSED');
        if (resD.outcome !== 'CLOSED' || resD1.outcome !== 'CLOSED') return;

        // Distinct AND sequential {1,2} in some order — never a collision,
        // never a gap.
        const zNumbers = [resD.dayClose.zNumber, resD1.dayClose.zNumber]
          .map(Number)
          .sort((a, b) => a - b);
        expect(zNumbers).toEqual([1, 2]);

        // Exactly one DayClose row per day — the retry never doubled a
        // write.
        const rowsD = await admin.dayClose.count({
          where: {
            tenantId: fx.tenantId,
            branchId: fx.branchId,
            businessDay: dayD,
          },
        });
        const rowsD1 = await admin.dayClose.count({
          where: {
            tenantId: fx.tenantId,
            branchId: fx.branchId,
            businessDay: dayD1,
          },
        });
        expect(rowsD).toBe(1);
        expect(rowsD1).toBe(1);

        // Exactly one DAY_CLOSED audit entry PER day (never a duplicate
        // from a retried-then-succeeded attempt double-recording).
        const auditD = await admin.auditEntry.count({
          where: {
            tenantId: fx.tenantId,
            action: 'DAY_CLOSED',
            entityId: resD.dayClose.id,
          },
        });
        const auditD1 = await admin.auditEntry.count({
          where: {
            tenantId: fx.tenantId,
            action: 'DAY_CLOSED',
            entityId: resD1.dayClose.id,
          },
        });
        expect(auditD).toBe(1);
        expect(auditD1).toBe(1);
      } finally {
        salesFactsStub.barrier = null;
      }
    });
  }

  it('same branch + same business day, concurrent close attempts: exactly one root may exist', async () => {
    const { fx, dayD } = await mkFx();
    // Deliberately NO barrier here: the SAME target day means both
    // requests take the IDENTICAL `ros_order_number(branchId, dayD)`
    // advisory-lock key, so the second literally cannot even reach the
    // `DAY_CLOSE_SALES_FACTS_QUERY` seam until the first's transaction
    // ends — a barrier expecting both to arrive there would deadlock the
    // FIRST against the SECOND's (unreachable) arrival. This is itself
    // evidence the fence serialises same-day attempts completely, the
    // opposite case from the different-day races above.
    try {
      const results = await Promise.allSettled([
        close(fx, dayD),
        close(fx, dayD),
      ]);
      const closedOutcomes = results.filter(
        (r) => r.status === 'fulfilled' && r.value.outcome === 'CLOSED',
      );
      // The SAME fence key serialises these two — the second one's fresh
      // re-read after the lock sees the first's commit and takes the
      // TERMINAL "already closed" 409, never a second root. Exactly one
      // CLOSED outcome; the loser is a coherent rejection, never a crash
      // or a duplicate row.
      expect(closedOutcomes).toHaveLength(1);
      const rows = await admin.dayClose.count({
        where: {
          tenantId: fx.tenantId,
          branchId: fx.branchId,
          businessDay: dayD,
        },
      });
      expect(rows).toBe(1);
    } finally {
      salesFactsStub.barrier = null;
    }
  });
});
