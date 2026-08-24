import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { UnitOfWork } from './../src/common/domain-events/unit-of-work';
import { newId } from './../src/common/ids';
import { PrismaClient, Prisma } from './../src/generated/prisma/client';
import {
  ORDER_LINE_FIRED_EVENT_TYPE,
  ORDER_LINE_FIRED_EVENT_VERSION,
} from './../src/modules/sales/contract';
import type { OrderLineFiredPayload } from './../src/modules/sales/contract';
import { TicketHeaderMismatchError } from './../src/modules/kitchen/tickets/ticket-persistence.errors';
import { TicketPersistenceService } from './../src/modules/kitchen/tickets/ticket-persistence.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1E-5A — real PostgreSQL two-transaction concurrency proof.
 *
 * Sequential "fire the same event twice" tests (P1E-5's own suite) cannot
 * exercise the race this correction fixes: each sequential call opens its
 * OWN transaction, so the second call's existence check always sees the
 * first call's already-COMMITTED row and returns early — the `INSERT ...
 * ON CONFLICT` path is never reached at all. Every test here instead runs
 * TWO independent `PrismaService.withAuthContext` transactions concurrently,
 * synchronized with an explicit barrier so both are guaranteed to attempt
 * their conflicting write at (as close to) the same instant — a genuine
 * database-level race, not two `Promise.all`'d calls sharing one
 * transaction.
 */
describe('Kitchen Ticket persistence — real Postgres concurrency (P1E-5A)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let unitOfWork: UnitOfWork;
  let ticketPersistence: TicketPersistenceService;

  const ts = Date.now();
  const tenantA = newId();
  const brandA = newId();
  const branchA = newId();
  const stationGrill = newId();
  const employeeA = newId();
  const terminalA = newId();
  const menuA = newId();
  const menuItemA = newId();
  const variantA = newId();
  const modifierGroupA = newId();
  const modifierA = newId();
  const ruleMenuItemGrill = newId();

  const businessDay = new Date('2026-08-23T00:00:00.000Z');
  const businessDayStr = businessDay.toISOString().slice(0, 10);

  let orderNumberCounter = 0;
  function nextOrderNumber(): string {
    orderNumberCounter += 1;
    return `C-${ts % 1_000_000}-${orderNumberCounter}`;
  }

  /** Releases both parties only once BOTH have arrived — a real barrier. */
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

  async function makeOrderWithLine(
    orderId: string,
    lineId: string,
  ): Promise<void> {
    await admin.order.create({
      data: {
        id: orderId,
        tenantId: tenantA,
        branchId: branchA,
        terminalId: terminalA,
        orderNumber: nextOrderNumber(),
        businessDay,
        orderType: 'dine_in',
        channel: 'pos',
        openedBy: employeeA,
        currency: 'SAR',
        openedAt: new Date(),
        originDeviceTime: new Date(),
        idempotencyKey: `idem-${orderId}`,
        countryPackVersion: 'v1',
      },
    });
    await admin.orderLine.create({
      data: {
        id: lineId,
        tenantId: tenantA,
        orderId,
        businessDay,
        sequence: 1,
        menuItemId: menuItemA,
        variantId: variantA,
        itemNameSnapshot: { item: { en: 'Burger' } },
        quantity: '1',
        unitPrice: 100n,
        lineSubtotal: 100n,
        taxClassId: newId(),
        lineTotal: 100n,
        state: 'pending',
      },
    });
  }

  function basePayload(
    overrides: Partial<OrderLineFiredPayload> = {},
  ): OrderLineFiredPayload {
    return {
      orderId: newId(),
      businessDay: businessDayStr,
      orderLineId: newId(),
      fireBatchId: newId(),
      firedAt: new Date().toISOString(),
      menuItemId: menuItemA,
      modifierIds: [],
      categoryIds: [],
      lineStationOverrides: [],
      orderNumber: 'C-0001',
      orderType: 'dine_in',
      serviceReference: 'Table 1',
      itemNameSnapshot: { en: 'Burger' },
      quantity: '1',
      course: null,
      sequence: 1,
      preparationNotes: null,
      modifiers: [],
      ...overrides,
    };
  }

  async function fireOnce(payload: OrderLineFiredPayload): Promise<void> {
    await unitOfWork.execute(
      { userId: employeeA, tenantId: tenantA },
      (ctx) => {
        ctx.publishEvent({
          eventType: ORDER_LINE_FIRED_EVENT_TYPE,
          eventVersion: ORDER_LINE_FIRED_EVENT_VERSION,
          occurredAt: new Date(),
          branchId: branchA,
          actorId: employeeA,
          actorType: 'user',
          idempotencyKey: newId(),
          payload,
        });
        return Promise.resolve();
      },
    );
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);
    unitOfWork = app.get(UnitOfWork);
    ticketPersistence = app.get(TicketPersistenceService);

    await admin.tenant.create({
      data: {
        id: tenantA,
        slug: `kitchen-race-${ts}`,
        legalName: 'KitchenRace',
        defaultCurrency: 'SAR',
        countryPackCode: 'SA',
      },
    });
    await admin.brand.create({
      data: { id: brandA, tenantId: tenantA, name: `Brand ${ts}` },
    });
    await admin.branch.create({
      data: {
        id: branchA,
        tenantId: tenantA,
        brandId: brandA,
        code: `KR${ts % 10000}`,
        name: 'Branch A',
        timezone: 'Africa/Cairo',
        baseCurrency: 'SAR',
        countryCode: 'SA',
      },
    });
    // P1E-6A Defect: a branch row with no matching `org.locations` registry
    // row previously polluted `organisation.e2e-spec.ts`'s "leaves no org
    // location entity without a registry row" invariant test when the full
    // suite ran (see the P1E-6/P1E-6A reports). Mirrors the pattern already
    // used by `sales-fire.e2e-spec.ts`'s `mkBranch` helper.
    await admin.location.create({
      data: {
        id: newId(),
        tenantId: tenantA,
        locationType: 'branch',
        refId: branchA,
        branchId: branchA,
      },
    });
    await admin.station.create({
      data: { id: stationGrill, branchId: branchA, name: 'Grill' },
    });
    await admin.employee.create({
      data: {
        id: employeeA,
        tenantId: tenantA,
        code: `E-${ts}`,
        displayName: 'Employee A',
        homeBranchId: branchA,
      },
    });
    await admin.terminal.create({
      data: {
        id: terminalA,
        tenantId: tenantA,
        branchId: branchA,
        name: `T-${ts}`,
        terminalType: 'pos',
      },
    });
    await admin.menu.create({
      data: { id: menuA, tenantId: tenantA, name: { en: 'Main' } },
    });
    await admin.menuItem.create({
      data: { id: menuItemA, tenantId: tenantA, names: { en: 'Burger' } },
    });
    await admin.menuItemVariant.create({
      data: {
        id: variantA,
        tenantId: tenantA,
        menuItemId: menuItemA,
        name: { en: 'Regular' },
      },
    });
    await admin.modifierGroup.create({
      data: { id: modifierGroupA, tenantId: tenantA, name: { en: 'Extras' } },
    });
    await admin.modifier.create({
      data: {
        id: modifierA,
        tenantId: tenantA,
        modifierGroupId: modifierGroupA,
        name: { en: 'Extra Cheese' },
        kind: 'addition',
      },
    });
    await admin.stationRoutingRule.create({
      data: {
        id: ruleMenuItemGrill,
        tenantId: tenantA,
        branchId: branchA,
        stationId: stationGrill,
        menuItemId: menuItemA,
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('1+5. two concurrent transactions racing to create the SAME Ticket converge on exactly one row, and the loser is NOT left with an aborted transaction', async () => {
    const orderId = newId();
    const lineId = newId();
    await makeOrderWithLine(orderId, lineId);

    const input = {
      tenantId: tenantA,
      branchId: branchA,
      businessDay,
      orderId,
      stationId: stationGrill,
      orderNumberSnapshot: 'C-RACE-1',
      orderTypeSnapshot: 'dine_in',
      serviceReferenceSnapshot: 'Table 1',
      createdAt: new Date(),
      routedAt: new Date(),
    };

    const arrive = makeBarrier(2);
    const results = await Promise.all(
      [0, 1].map(() =>
        prisma.withAuthContext({ tenantId: tenantA }, async (tx) => {
          await arrive();
          const ticket = await ticketPersistence.getOrCreateTicket(tx, input);
          // §8 test 5 — prove the transaction is NOT poisoned after the
          // conflict: issue a further, unrelated statement on the SAME tx.
          const stillUsable = await tx.tenant.count({
            where: { id: tenantA },
          });
          return { ticketId: ticket.id, stillUsable };
        }),
      ),
    );

    expect(results[0].stillUsable).toBe(1);
    expect(results[1].stillUsable).toBe(1);
    expect(results[0].ticketId).toBe(results[1].ticketId); // same winner

    const tickets = await admin.ticket.findMany({
      where: { tenantId: tenantA, orderId, businessDay },
    });
    expect(tickets).toHaveLength(1);
  });

  it('2. two concurrent transactions racing to create the SAME (ticket, fireBatchId) converge on exactly one batch row', async () => {
    const orderId = newId();
    const lineId = newId();
    await makeOrderWithLine(orderId, lineId);
    const ticket = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
      ticketPersistence.getOrCreateTicket(tx, {
        tenantId: tenantA,
        branchId: branchA,
        businessDay,
        orderId,
        stationId: stationGrill,
        orderNumberSnapshot: 'C-RACE-2',
        orderTypeSnapshot: 'dine_in',
        serviceReferenceSnapshot: null,
        createdAt: new Date(),
        routedAt: new Date(),
      }),
    );

    const fireBatchId = newId();
    const arrive = makeBarrier(2);
    const results = await Promise.all(
      [0, 1].map(() =>
        prisma.withAuthContext({ tenantId: tenantA }, async (tx) => {
          await arrive();
          const batch = await ticketPersistence.getOrCreateFireBatch(tx, {
            tenantId: tenantA,
            ticketId: ticket.id,
            fireBatchId,
            firedAt: new Date(),
          });
          const stillUsable = await tx.tenant.count({
            where: { id: tenantA },
          });
          return { batchId: batch.id, stillUsable };
        }),
      ),
    );

    expect(results[0].stillUsable).toBe(1);
    expect(results[1].stillUsable).toBe(1);
    expect(results[0].batchId).toBe(results[1].batchId);

    const batches = await admin.ticketFireBatch.findMany({
      where: { tenantId: tenantA, ticketId: ticket.id, fireBatchId },
    });
    expect(batches).toHaveLength(1);
  });

  it('3. two concurrent transactions racing to create the SAME (ticket, orderLineId) TicketLine converge on exactly one row', async () => {
    const orderId = newId();
    const lineId = newId();
    await makeOrderWithLine(orderId, lineId);
    const { ticketId, batchId } = await prisma.withAuthContext(
      { tenantId: tenantA },
      async (tx) => {
        const ticket = await ticketPersistence.getOrCreateTicket(tx, {
          tenantId: tenantA,
          branchId: branchA,
          businessDay,
          orderId,
          stationId: stationGrill,
          orderNumberSnapshot: 'C-RACE-3',
          orderTypeSnapshot: 'dine_in',
          serviceReferenceSnapshot: null,
          createdAt: new Date(),
          routedAt: new Date(),
        });
        const batch = await ticketPersistence.getOrCreateFireBatch(tx, {
          tenantId: tenantA,
          ticketId: ticket.id,
          fireBatchId: newId(),
          firedAt: new Date(),
        });
        return { ticketId: ticket.id, batchId: batch.id };
      },
    );

    const lineInput = {
      tenantId: tenantA,
      ticketId,
      fireBatchRowId: batchId,
      orderId,
      orderLineId: lineId,
      businessDay,
      itemNameSnapshot: { en: 'Burger' } as Prisma.InputJsonValue,
      quantity: '1',
      course: null,
      sequence: 1,
      preparationNotes: null,
      createdAt: new Date(),
      routedAt: new Date(),
    };

    const arrive = makeBarrier(2);
    const results = await Promise.all(
      [0, 1].map(() =>
        prisma.withAuthContext({ tenantId: tenantA }, async (tx) => {
          await arrive();
          const line = await ticketPersistence.getOrCreateTicketLine(
            tx,
            lineInput,
          );
          const stillUsable = await tx.tenant.count({
            where: { id: tenantA },
          });
          return { lineId2: line.id, stillUsable };
        }),
      ),
    );

    expect(results[0].stillUsable).toBe(1);
    expect(results[1].stillUsable).toBe(1);
    expect(results[0].lineId2).toBe(results[1].lineId2);

    const lines = await admin.ticketLine.findMany({
      where: { tenantId: tenantA, ticketId, orderLineId: lineId },
    });
    expect(lines).toHaveLength(1);
  });

  it('4. two concurrent transactions racing to create the SAME (ticketLine, sourceOrderLineModifierId) modifier snapshot converge on exactly one row', async () => {
    const orderId = newId();
    const lineId = newId();
    await makeOrderWithLine(orderId, lineId);
    const olmId = newId();
    await admin.orderLineModifier.create({
      data: {
        id: olmId,
        tenantId: tenantA,
        orderLineId: lineId,
        businessDay,
        modifierId: modifierA,
        modifierGroupId: modifierGroupA,
        nameSnapshot: { en: 'Extra Cheese' },
        kindSnapshot: 'addition',
      },
    });

    const { ticketLineId } = await prisma.withAuthContext(
      { tenantId: tenantA },
      async (tx) => {
        const ticket = await ticketPersistence.getOrCreateTicket(tx, {
          tenantId: tenantA,
          branchId: branchA,
          businessDay,
          orderId,
          stationId: stationGrill,
          orderNumberSnapshot: 'C-RACE-4',
          orderTypeSnapshot: 'dine_in',
          serviceReferenceSnapshot: null,
          createdAt: new Date(),
          routedAt: new Date(),
        });
        const batch = await ticketPersistence.getOrCreateFireBatch(tx, {
          tenantId: tenantA,
          ticketId: ticket.id,
          fireBatchId: newId(),
          firedAt: new Date(),
        });
        const line = await ticketPersistence.getOrCreateTicketLine(tx, {
          tenantId: tenantA,
          ticketId: ticket.id,
          fireBatchRowId: batch.id,
          orderId,
          orderLineId: lineId,
          businessDay,
          itemNameSnapshot: { en: 'Burger' },
          quantity: '1',
          course: null,
          sequence: 1,
          preparationNotes: null,
          createdAt: new Date(),
          routedAt: new Date(),
        });
        return { ticketLineId: line.id };
      },
    );

    const modifierInput = {
      sourceOrderLineModifierId: olmId,
      sourceModifierId: modifierA,
      nameSnapshot: { en: 'Extra Cheese' } as Prisma.InputJsonValue,
      kind: 'addition' as const,
      quantity: 1,
    };

    const arrive = makeBarrier(2);
    const stillUsableFlags = await Promise.all(
      [0, 1].map(() =>
        prisma.withAuthContext({ tenantId: tenantA }, async (tx) => {
          await arrive();
          await ticketPersistence.ensureTicketLineModifier(
            tx,
            tenantA,
            ticketLineId,
            modifierInput,
          );
          const stillUsable = await tx.tenant.count({
            where: { id: tenantA },
          });
          return stillUsable;
        }),
      ),
    );

    expect(stillUsableFlags).toEqual([1, 1]);

    const snapshots = await admin.ticketLineModifier.findMany({
      where: {
        tenantId: tenantA,
        ticketLineId,
        sourceOrderLineModifierId: olmId,
      },
    });
    expect(snapshots).toHaveLength(1);
  });

  it('6. competing Ticket creation with a DIFFERENT immutable header: one wins creation, the other fails closed with TicketHeaderMismatchError, no duplicate Ticket', async () => {
    const orderId = newId();
    const lineId = newId();
    await makeOrderWithLine(orderId, lineId);

    const inputA = {
      tenantId: tenantA,
      branchId: branchA,
      businessDay,
      orderId,
      stationId: stationGrill,
      orderNumberSnapshot: 'C-RACE-6-A',
      orderTypeSnapshot: 'dine_in',
      serviceReferenceSnapshot: 'Table 1',
      createdAt: new Date(),
      routedAt: new Date(),
    };
    const inputB = { ...inputA, orderNumberSnapshot: 'C-RACE-6-B' };

    const arrive = makeBarrier(2);
    const settled = await Promise.allSettled(
      [inputA, inputB].map((input) =>
        prisma.withAuthContext({ tenantId: tenantA }, async (tx) => {
          await arrive();
          const ticket = await ticketPersistence.getOrCreateTicket(tx, input);
          return ticket;
        }),
      ),
    );

    const fulfilled = settled.filter(
      (
        r,
      ): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof ticketPersistence.getOrCreateTicket>>
      > => r.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(TicketHeaderMismatchError);

    const tickets = await admin.ticket.findMany({
      where: { tenantId: tenantA, orderId, businessDay },
    });
    expect(tickets).toHaveLength(1);
    expect(['C-RACE-6-A', 'C-RACE-6-B']).toContain(
      tickets[0].orderNumberSnapshot,
    );
  });

  it('7. a genuine FK violation still aborts the transaction — never mistaken for an idempotent conflict', async () => {
    const orderId = newId();
    const lineId = newId();
    await makeOrderWithLine(orderId, lineId);

    await expect(
      prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
        ticketPersistence.getOrCreateTicket(tx, {
          tenantId: tenantA,
          branchId: branchA,
          businessDay,
          orderId,
          stationId: newId(), // no such Station — FK violation, not a natural-key conflict
          orderNumberSnapshot: 'C-RACE-7',
          orderTypeSnapshot: 'dine_in',
          serviceReferenceSnapshot: null,
          createdAt: new Date(),
          routedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();

    const tickets = await admin.ticket.findMany({
      where: { tenantId: tenantA, orderId, businessDay },
    });
    expect(tickets).toHaveLength(0);
  });

  it('end-to-end: two concurrent Fire commands for the same order+station converge on one Ticket through the real handler', async () => {
    const orderId = newId();
    const line1 = newId();
    const line2 = newId();
    await admin.order.create({
      data: {
        id: orderId,
        tenantId: tenantA,
        branchId: branchA,
        terminalId: terminalA,
        orderNumber: nextOrderNumber(),
        businessDay,
        orderType: 'dine_in',
        channel: 'pos',
        openedBy: employeeA,
        currency: 'SAR',
        openedAt: new Date(),
        originDeviceTime: new Date(),
        idempotencyKey: `idem-${orderId}`,
        countryPackVersion: 'v1',
      },
    });
    await admin.orderLine.createMany({
      data: [line1, line2].map((id, i) => ({
        id,
        tenantId: tenantA,
        orderId,
        businessDay,
        sequence: i + 1,
        menuItemId: menuItemA,
        variantId: variantA,
        itemNameSnapshot: { item: { en: 'Burger' } },
        quantity: '1',
        unitPrice: 100n,
        lineSubtotal: 100n,
        taxClassId: newId(),
        lineTotal: 100n,
        state: 'pending',
      })),
    });

    const arrive = makeBarrier(2);
    await Promise.all(
      [line1, line2].map((orderLineId) =>
        unitOfWork.execute(
          { userId: employeeA, tenantId: tenantA },
          async (ctx) => {
            await arrive();
            ctx.publishEvent({
              eventType: ORDER_LINE_FIRED_EVENT_TYPE,
              eventVersion: ORDER_LINE_FIRED_EVENT_VERSION,
              occurredAt: new Date(),
              branchId: branchA,
              actorId: employeeA,
              actorType: 'user',
              idempotencyKey: newId(),
              payload: basePayload({ orderId, orderLineId }),
            });
          },
        ),
      ),
    );

    const tickets = await admin.ticket.findMany({
      where: { tenantId: tenantA, orderId, businessDay },
    });
    expect(tickets).toHaveLength(1);
    const lines = await admin.ticketLine.findMany({
      where: { tenantId: tenantA, ticketId: tickets[0].id },
    });
    expect(lines).toHaveLength(2);
  });

  it('replaying the same fired line after a genuine race still results in exactly one Ticket/Line (fire() is safe post-race)', async () => {
    const orderId = newId();
    const lineId = newId();
    await makeOrderWithLine(orderId, lineId);

    await fireOnce(basePayload({ orderId, orderLineId: lineId }));
    await fireOnce(basePayload({ orderId, orderLineId: lineId }));

    const tickets = await admin.ticket.findMany({
      where: { tenantId: tenantA, orderId, businessDay },
    });
    expect(tickets).toHaveLength(1);
    const lines = await admin.ticketLine.findMany({
      where: { tenantId: tenantA, ticketId: tickets[0].id },
    });
    expect(lines).toHaveLength(1);
  });
});
