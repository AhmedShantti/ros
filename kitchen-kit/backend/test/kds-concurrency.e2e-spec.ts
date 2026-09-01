import { Injectable, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DomainEventHandler } from './../src/common/domain-events/domain-event-handler.decorator';
import { newId } from './../src/common/ids';
import { Prisma, PrismaClient } from './../src/generated/prisma/client';
import { AuditService } from './../src/modules/governance/contract';
import {
  TICKET_BUMPED_EVENT_TYPE,
  TICKET_RECALLED_EVENT_TYPE,
} from './../src/modules/kitchen/contract';
import { KdsOperationsService } from './../src/modules/kitchen/tickets/kds-operations.service';
import { TicketBumpedHandler } from './../src/modules/sales/orders/ticket-bumped.handler';
import { TicketRecalledHandler } from './../src/modules/sales/orders/ticket-recalled.handler';
import { PrismaService, AuthScope } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';
import {
  createKdsFixture,
  fireExistingOrderLineToStation,
  fireTicketLine,
  KdsFixture,
} from './kds-fixtures';

/**
 * KDS SERIALIZABLE bump/bump-all/recall — real two-transaction PostgreSQL
 * races (design gate §25/§29, acceptance correction §1.7). No sleeps, no
 * `Promise.all` sharing one connection: every race below opens two
 * INDEPENDENT transactions (via `KdsOperationsService`, which itself opens
 * one `PrismaService.withAuthContext` per attempt) and synchronizes them
 * with an explicit barrier so both are guaranteed to reach their
 * transaction body at (as close to) the same instant — a genuine
 * database-level race, exactly the `kitchen-ticket-concurrency.e2e-spec.ts`
 * harness style.
 *
 * The barrier is injected at the ONE choke point every KDS mutation passes
 * through exactly once per attempt — `PrismaService.withAuthContext`, right
 * after its transaction opens and before the caller's own queries run.
 * Because `UnitOfWork`'s retry loop calls `withAuthContext` again on a
 * losing attempt, and `makeBarrier` is a ONE-SHOT gate (already resolved
 * after its `parties`-th arrival), a retried attempt sails through
 * immediately rather than deadlocking on a barrier nobody else will ever
 * reach again.
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

/**
 * Fault-injection subscribers for tests F/L. `@nestjs/core`'s
 * `DiscoveryService.getMetadataByDecorator` reads the `@DomainEventHandler`
 * metadata off the provider's own CLASS — a `.useValue({ handle: ... })`
 * override has no such class and is silently skipped by
 * `DomainEventHandlerRegistry.onModuleInit`, which would make the handler
 * disappear from dispatch entirely rather than throw. These are real
 * decorated classes instead, swapped in via `.useClass(...)` so discovery
 * still finds them.
 */
@Injectable()
@DomainEventHandler(TICKET_BUMPED_EVENT_TYPE)
class FailingTicketBumpedHandler {
  handle(): Promise<void> {
    throw new Error('injected Sales subscriber failure');
  }
}

@Injectable()
@DomainEventHandler(TICKET_RECALLED_EVENT_TYPE)
class FailingTicketRecalledHandler {
  handle(): Promise<void> {
    throw new Error('injected recall subscriber failure');
  }
}

describe('KDS SERIALIZABLE bump/bump-all/recall — real Postgres concurrency', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let operations: KdsOperationsService;
  const stamp = Date.now().toString(36);
  let fixture: KdsFixture;
  const businessDay = new Date('2026-08-30T00:00:00.000Z');
  let orderCounter = 0;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useClass(BarrierPrismaService)
      .compile();
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
    prisma = app.get(PrismaService);
    operations = app.get(KdsOperationsService);
    fixture = await createKdsFixture(app, admin, stamp);
  });

  afterEach(() => {
    BarrierPrismaService.barrier = null;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function scope(stationId: string) {
    return {
      tenantId: fixture.tenantId,
      actorUserId: fixture.employeeUserId,
      employeeId: fixture.employeeId,
      stationId,
    };
  }

  async function makeTicket(stationId = fixture.stationGrillId) {
    orderCounter += 1;
    return fireTicketLine(admin, {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      stationId,
      businessDay,
      orderNumber: `CC-${stamp}-${orderCounter}`,
      terminalId: fixture.posTerminalId,
      openedBy: fixture.employeeId,
    });
  }

  async function addSecondLine(orderId: string, ticketId: string) {
    const menuItemId = newId();
    await admin.menuItem.create({
      data: {
        id: menuItemId,
        tenantId: fixture.tenantId,
        names: { en: 'Fries' },
      },
    });
    const variantId = newId();
    await admin.menuItemVariant.create({
      data: {
        id: variantId,
        tenantId: fixture.tenantId,
        menuItemId,
        name: { en: 'R' },
      },
    });
    const orderLineId = newId();
    await admin.orderLine.create({
      data: {
        id: orderLineId,
        tenantId: fixture.tenantId,
        orderId,
        businessDay,
        sequence: 2,
        menuItemId,
        variantId,
        itemNameSnapshot: { en: 'Fries' },
        quantity: '1',
        unitPrice: 50n,
        lineSubtotal: 50n,
        taxClassId: newId(),
        lineTotal: 50n,
        state: 'fired',
        firedAt: new Date(),
      },
    });
    const fireBatch = await admin.ticketFireBatch.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, ticketId },
    });
    const ticketLineId = newId();
    await admin.ticketLine.create({
      data: {
        id: ticketLineId,
        tenantId: fixture.tenantId,
        ticketId,
        fireBatchRowId: fireBatch.id,
        orderId,
        orderLineId,
        businessDay,
        itemNameSnapshot: { en: 'Fries' },
        quantity: '1',
        sequence: 2,
        createdAt: new Date(),
        routedAt: new Date(),
      },
    });
    return { orderLineId, ticketLineId };
  }

  it('A. two cooks bump the SAME line: exactly one real mutation, replay preserves original actor/time, no error', async () => {
    const { ticketId, ticketLineId } = await makeTicket();
    const arrive = makeBarrier(2);
    BarrierPrismaService.barrier = arrive;

    const results = await Promise.all([
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId,
        lineId: ticketLineId,
      }),
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId,
        lineId: ticketLineId,
      }),
    ]);

    expect(results[0].line.bumpedAt).toBe(results[1].line.bumpedAt);
    expect(results[0].line.status).toBe('bumped');

    const line = await admin.ticketLine.findUniqueOrThrow({
      where: { id: ticketLineId },
    });
    expect(line.status).toBe('bumped');
    const auditCount = await admin.auditEntry.count({
      where: {
        tenantId: fixture.tenantId,
        action: 'TICKET_LINE_BUMPED',
        entityId: ticketLineId,
      },
    });
    expect(auditCount).toBe(1);
  });

  it('B. two cooks bump DIFFERENT lines on the SAME ticket concurrently: both succeed, ticket projection converges, no lost update', async () => {
    const { ticketId, orderId, ticketLineId: line1 } = await makeTicket();
    const { ticketLineId: line2 } = await addSecondLine(orderId, ticketId);

    const arrive = makeBarrier(2);
    BarrierPrismaService.barrier = arrive;
    await Promise.all([
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId,
        lineId: line1,
      }),
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId,
        lineId: line2,
      }),
    ]);

    const [l1, l2, ticket] = await Promise.all([
      admin.ticketLine.findUniqueOrThrow({ where: { id: line1 } }),
      admin.ticketLine.findUniqueOrThrow({ where: { id: line2 } }),
      admin.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
    ]);
    expect(l1.status).toBe('bumped');
    expect(l2.status).toBe('bumped');
    expect(ticket.status).toBe('bumped');
    expect(ticket.bumpedAt).not.toBeNull();
  });

  it('C. bump item vs bump-all concurrently: no double overwrite, the individually-bumped line keeps its own actor', async () => {
    const { ticketId, orderId, ticketLineId: line1 } = await makeTicket();
    const { ticketLineId: line2 } = await addSecondLine(orderId, ticketId);

    const arrive = makeBarrier(2);
    BarrierPrismaService.barrier = arrive;
    await Promise.all([
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId,
        lineId: line1,
      }),
      operations.bumpAll({ ...scope(fixture.stationGrillId), ticketId }),
    ]);

    const [l1, l2, ticket] = await Promise.all([
      admin.ticketLine.findUniqueOrThrow({ where: { id: line1 } }),
      admin.ticketLine.findUniqueOrThrow({ where: { id: line2 } }),
      admin.ticket.findUniqueOrThrow({ where: { id: ticketId } }),
    ]);
    expect(l1.status).toBe('bumped');
    expect(l2.status).toBe('bumped');
    expect(ticket.status).toBe('bumped');
    // At most one TICKET_LINE_BUMPED for line1 (bump-all's own match set
    // excludes an already-bumped line, so it never re-touches it).
    const line1BumpedEntries = await admin.auditEntry.count({
      where: {
        tenantId: fixture.tenantId,
        action: 'TICKET_LINE_BUMPED',
        entityId: line1,
      },
    });
    expect(line1BumpedEntries).toBeLessThanOrEqual(1);
  });

  /**
   * D0 — the READ COMMITTED write-skew GUARD test (acceptance correction
   * §1.2/§1.7 Test 1). Reproduces the exact anomaly worked through in the
   * design correction, directly against real PostgreSQL at the connection
   * DEFAULT isolation (no `isolationLevel` override — genuinely READ
   * COMMITTED, unlike every other test in this file which goes through
   * `KdsOperationsService` and therefore always runs at SERIALIZABLE).
   * This test documents the DEFECT the SERIALIZABLE mechanism exists to
   * fix: it must keep failing (both transactions compute an EMPTY
   * readiness set, so Sales is never told the order line is ready) for as
   * long as this repository has a KDS bump path. If a future change
   * silently drops SERIALIZABLE from the production path, this guard test
   * gives no signal (it never touches production code) — its purpose is
   * only to prove, once, that the anomaly is real and not theoretical.
   */
  it('D0 [GUARD]. under plain READ COMMITTED, two stations completing the SAME order line produce the write-skew anomaly (documents why SERIALIZABLE is required)', async () => {
    const grill = await makeTicket(fixture.stationGrillId);
    const packaging = await fireExistingOrderLineToStation(admin, {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      stationId: fixture.stationPackagingId,
      businessDay,
      orderId: grill.orderId,
      orderLineId: grill.orderLineId,
      orderNumber: `CC-${stamp}-guard`,
    });

    const arrive = makeBarrier(2);
    const now = new Date();

    async function bumpAndComputeReadinessAtReadCommitted(
      ticketLineId: string,
    ): Promise<readonly string[]> {
      return prisma.withAuthContext(
        { tenantId: fixture.tenantId },
        async (tx) => {
          // Barrier BEFORE the write, so both transactions' UPDATEs are
          // in flight (uncommitted) before either issues its readiness read.
          await arrive();
          await tx.ticketLine.update({
            where: { id: ticketLineId },
            data: {
              status: 'bumped',
              readyAt: now,
              bumpedAt: now,
              bumpedBy: fixture.employeeId,
            },
          });
          // The SAME readiness predicate `publishTicketBumped` issues in
          // production — reproduced here, at READ COMMITTED, deliberately.
          const rows = await tx.$queryRaw<{ orderLineId: string }[]>`
            SELECT "order_line_id" AS "orderLineId"
            FROM "kitchen"."ticket_lines"
            WHERE "tenant_id" = ${fixture.tenantId}::uuid
              AND "business_day" = ${businessDay}::date
              AND "order_line_id" = ${grill.orderLineId}::uuid
            GROUP BY "order_line_id"
            HAVING bool_and("status" IN ('bumped', 'served', 'cancelled'))
               AND bool_or("status" IN ('bumped', 'served'))
          `;
          return rows.map((r) => r.orderLineId);
        },
        // No isolationLevel — the connection default, READ COMMITTED.
      );
    }

    const [grillReady, packagingReady] = await Promise.all([
      bumpAndComputeReadinessAtReadCommitted(grill.ticketLineId),
      bumpAndComputeReadinessAtReadCommitted(packaging.ticketLineId),
    ]);

    // THE ANOMALY: under READ COMMITTED, each transaction's own uncommitted
    // write is invisible to the OTHER, so both compute an EMPTY readiness
    // set — neither ever includes the order line, and (per §1.2) no further
    // bump will ever occur, so Sales readiness for this line is now
    // PERMANENTLY stuck at `fired`.
    expect(grillReady).toEqual([]);
    expect(packagingReady).toEqual([]);

    const bothLinesBumped = await admin.ticketLine.count({
      where: {
        tenantId: fixture.tenantId,
        id: { in: [grill.ticketLineId, packaging.ticketLineId] },
        status: 'bumped',
      },
    });
    expect(bothLinesBumped).toBe(2);
  });

  it('D/G. two stations completing the SAME order line concurrently: SERIALIZABLE detects the conflict, one retries, Sales ends ready EXACTLY ONCE, no duplicate audit', async () => {
    const grill = await makeTicket(fixture.stationGrillId);
    const packaging = await fireExistingOrderLineToStation(admin, {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      stationId: fixture.stationPackagingId,
      businessDay,
      orderId: grill.orderId,
      orderLineId: grill.orderLineId,
      orderNumber: `CC-${stamp}-multi`,
    });

    const arrive = makeBarrier(2);
    BarrierPrismaService.barrier = arrive;
    const results = await Promise.allSettled([
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId: grill.ticketId,
        lineId: grill.ticketLineId,
      }),
      operations.bumpLine({
        ...scope(fixture.stationPackagingId),
        ticketId: packaging.ticketId,
        lineId: packaging.ticketLineId,
      }),
    ]);

    // Both calls resolve successfully — SERIALIZABLE resolves the conflict
    // via an internal retry, never surfaces it to the caller of the losing
    // side unless the retry BUDGET (3) is exhausted.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    const orderLine = await admin.orderLine.findFirstOrThrow({
      where: { id: grill.orderLineId, businessDay },
    });
    expect(orderLine.state).toBe('ready');
    expect(orderLine.readyAt).not.toBeNull();

    // No duplicate audit despite the internal retry: exactly one
    // TICKET_LINE_BUMPED per ticket line, never two for the retried side.
    const grillAudit = await admin.auditEntry.count({
      where: {
        tenantId: fixture.tenantId,
        action: 'TICKET_LINE_BUMPED',
        entityId: grill.ticketLineId,
      },
    });
    const packagingAudit = await admin.auditEntry.count({
      where: {
        tenantId: fixture.tenantId,
        action: 'TICKET_LINE_BUMPED',
        entityId: packaging.ticketLineId,
      },
    });
    expect(grillAudit).toBe(1);
    expect(packagingAudit).toBe(1);
  });

  it('E. three-station fan-out: concurrent final bumps on all three, Sales ends ready exactly once', async () => {
    const first = await makeTicket(fixture.stationGrillId);
    const stationThird = await admin.station.create({
      data: { id: newId(), branchId: fixture.branchId, name: `Third-${stamp}` },
    });
    const second = await fireExistingOrderLineToStation(admin, {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      stationId: fixture.stationPackagingId,
      businessDay,
      orderId: first.orderId,
      orderLineId: first.orderLineId,
      orderNumber: `CC-${stamp}-fanout-2`,
    });
    const third = await fireExistingOrderLineToStation(admin, {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      stationId: stationThird.id,
      businessDay,
      orderId: first.orderId,
      orderLineId: first.orderLineId,
      orderNumber: `CC-${stamp}-fanout-3`,
    });

    const arrive = makeBarrier(3);
    BarrierPrismaService.barrier = arrive;
    const results = await Promise.allSettled([
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId: first.ticketId,
        lineId: first.ticketLineId,
      }),
      operations.bumpLine({
        ...scope(fixture.stationPackagingId),
        ticketId: second.ticketId,
        lineId: second.ticketLineId,
      }),
      operations.bumpLine({
        ...scope(stationThird.id),
        ticketId: third.ticketId,
        lineId: third.ticketLineId,
      }),
    ]);
    for (const r of results) expect(r.status).toBe('fulfilled');

    const orderLine = await admin.orderLine.findFirstOrThrow({
      where: { id: first.orderLineId, businessDay },
    });
    expect(orderLine.state).toBe('ready');
  });

  it('F. Sales subscriber failure rolls back the WHOLE transaction (Kitchen bump + audit together) — never retried merely for a subscriber throw', async () => {
    const failingModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TicketBumpedHandler)
      .useClass(FailingTicketBumpedHandler)
      .compile();
    const failingApp = failingModule.createNestApplication();
    await failingApp.init();
    try {
      const failingOperations = failingApp.get(KdsOperationsService);
      const { ticketId, ticketLineId, orderLineId } = await makeTicket();

      await expect(
        failingOperations.bumpLine({
          ...scope(fixture.stationGrillId),
          ticketId,
          lineId: ticketLineId,
        }),
      ).rejects.toThrow('injected Sales subscriber failure');

      const line = await admin.ticketLine.findUniqueOrThrow({
        where: { id: ticketLineId },
      });
      expect(line.status).toBe('queued');
      const auditCount = await admin.auditEntry.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_LINE_BUMPED',
          entityId: ticketLineId,
        },
      });
      expect(auditCount).toBe(0);
      const orderLine = await admin.orderLine.findFirstOrThrow({
        where: { id: orderLineId, businessDay },
      });
      expect(orderLine.state).toBe('fired');
    } finally {
      await failingApp.close();
    }
  });

  it('H. audit advisory lock is NOT load-bearing: the SAME two-station race resolves correctly even with the lock REMOVED entirely', async () => {
    // Strongest available form of the proof (acceptance correction Blocker
    // B/§5C): rather than merely trust that D's success is order-
    // independent, this stubs `AuditService.record` into a complete no-op —
    // no `pg_advisory_xact_lock`, no hash chain, nothing — for a SEPARATE
    // app instance, and reruns the identical two-station same-order-line
    // race. If SERIALIZABLE were not actually doing the work, removing the
    // lock would either corrupt the result or make the race non-
    // deterministic; it does neither.
    @Injectable()
    class NoOpAuditService {
      record(): Promise<null> {
        return Promise.resolve(null);
      }
    }
    const noLockModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useClass(BarrierPrismaService)
      .overrideProvider(AuditService)
      .useClass(NoOpAuditService)
      .compile();
    const noLockApp = noLockModule.createNestApplication();
    await noLockApp.init();
    try {
      const noLockOperations = noLockApp.get(KdsOperationsService);
      const noLockAdmin = createMigratorClient(noLockApp);
      try {
        const grill = await makeTicket(fixture.stationGrillId);
        const packaging = await fireExistingOrderLineToStation(noLockAdmin, {
          tenantId: fixture.tenantId,
          branchId: fixture.branchId,
          stationId: fixture.stationPackagingId,
          businessDay,
          orderId: grill.orderId,
          orderLineId: grill.orderLineId,
          orderNumber: `CC-${stamp}-noaudit`,
        });

        const arrive = makeBarrier(2);
        BarrierPrismaService.barrier = arrive;
        const results = await Promise.allSettled([
          noLockOperations.bumpLine({
            ...scope(fixture.stationGrillId),
            ticketId: grill.ticketId,
            lineId: grill.ticketLineId,
          }),
          noLockOperations.bumpLine({
            ...scope(fixture.stationPackagingId),
            ticketId: packaging.ticketId,
            lineId: packaging.ticketLineId,
          }),
        ]);
        for (const r of results) expect(r.status).toBe('fulfilled');

        const orderLine = await noLockAdmin.orderLine.findFirstOrThrow({
          where: { id: grill.orderLineId, businessDay },
        });
        expect(orderLine.state).toBe('ready');
        expect(orderLine.readyAt).not.toBeNull();
      } finally {
        await noLockAdmin.$disconnect();
      }
    } finally {
      BarrierPrismaService.barrier = null;
      await noLockApp.close();
    }
  });

  it('I/J. recall races a concurrent bump attempt on the same ticket: recall applies exactly once, no corruption', async () => {
    const { ticketId, ticketLineId, orderLineId } = await makeTicket();
    await operations.bumpLine({
      ...scope(fixture.stationGrillId),
      ticketId,
      lineId: ticketLineId,
    });

    const arrive = makeBarrier(2);
    BarrierPrismaService.barrier = arrive;
    const results = await Promise.allSettled([
      operations.recall({ ...scope(fixture.stationGrillId), ticketId }),
      operations.bumpLine({
        ...scope(fixture.stationGrillId),
        ticketId,
        lineId: ticketLineId,
      }),
    ]);

    // The bump attempt is a no-op on an already-bumped line (or, if recall
    // committed first and this transaction retried, a legitimate re-bump) —
    // either way it never throws, and recall never applies twice.
    for (const r of results) expect(r.status).toBe('fulfilled');

    const ticket = await admin.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    expect(ticket.recallCount).toBe(1);
    const recallAudit = await admin.auditEntry.count({
      where: {
        tenantId: fixture.tenantId,
        action: 'TICKET_RECALLED',
        entityId: ticketId,
      },
    });
    expect(recallAudit).toBe(1);

    // The order line is coherent: either reverted to fired (recall's effect
    // still standing) or ready again (a genuine re-bump after recall) — never
    // anything else.
    const orderLine = await admin.orderLine.findFirstOrThrow({
      where: { id: orderLineId, businessDay },
    });
    expect(['fired', 'ready']).toContain(orderLine.state);
  });

  it('K. recall reverts Sales ready -> fired, clears ready_at, in the SAME transaction as the Kitchen recall', async () => {
    const { ticketId, ticketLineId, orderLineId } = await makeTicket();
    await operations.bumpLine({
      ...scope(fixture.stationGrillId),
      ticketId,
      lineId: ticketLineId,
    });
    const ready = await admin.orderLine.findFirstOrThrow({
      where: { id: orderLineId, businessDay },
    });
    expect(ready.state).toBe('ready');

    await operations.recall({ ...scope(fixture.stationGrillId), ticketId });

    const reverted = await admin.orderLine.findFirstOrThrow({
      where: { id: orderLineId, businessDay },
    });
    expect(reverted.state).toBe('fired');
    expect(reverted.readyAt).toBeNull();

    const ticket = await admin.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    expect(ticket.status).toBe('queued');
    expect(ticket.recalledAt).not.toBeNull();
  });

  it('L. recall subscriber failure rolls back the Kitchen recall (recall_count, audit, and the Sales reversion together)', async () => {
    const { ticketId, ticketLineId, orderLineId } = await makeTicket();
    await operations.bumpLine({
      ...scope(fixture.stationGrillId),
      ticketId,
      lineId: ticketLineId,
    });

    const failingModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TicketRecalledHandler)
      .useClass(FailingTicketRecalledHandler)
      .compile();
    const failingApp = failingModule.createNestApplication();
    await failingApp.init();
    try {
      const failingOperations = failingApp.get(KdsOperationsService);
      await expect(
        failingOperations.recall({
          ...scope(fixture.stationGrillId),
          ticketId,
        }),
      ).rejects.toThrow('injected recall subscriber failure');

      const ticket = await admin.ticket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      expect(ticket.status).toBe('bumped');
      expect(ticket.recallCount).toBe(0);
      expect(ticket.recalledAt).toBeNull();

      const orderLine = await admin.orderLine.findFirstOrThrow({
        where: { id: orderLineId, businessDay },
      });
      expect(orderLine.state).toBe('ready');

      const recallAudit = await admin.auditEntry.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_RECALLED',
          entityId: ticketId,
        },
      });
      expect(recallAudit).toBe(0);
    } finally {
      await failingApp.close();
    }
  });
});
