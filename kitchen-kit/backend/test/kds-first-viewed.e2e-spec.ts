import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { AuditService } from './../src/modules/governance/contract';
import { createMigratorClient } from './rls-admin';
import {
  createKdsFixture,
  fireTicketLine,
  KdsFixture,
  pinLogin,
} from './kds-fixtures';

/**
 * First-viewed acknowledgement — design gate §9, acceptance correction §2.
 * §31 requirement matrix: GET never mutates; the acknowledgement is
 * write-once; exactly one `TICKET_VIEWED` audit entry per NEWLY-viewed
 * Ticket (never per request, never per replay); a foreign-station ticket
 * cannot be acknowledged; a rollback removes both the stamp and the audit
 * entry together.
 */
describe('KDS first-viewed acknowledgement (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = Date.now().toString(36);
  let fixture: KdsFixture;
  const businessDay = new Date('2026-08-30T00:00:00.000Z');
  let orderCounter = 0;

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
      }),
    );
    await app.init();
    admin = createMigratorClient(app);
    http = app.getHttpServer();
    fixture = await createKdsFixture(app, admin, stamp);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function makeTicket(stationId = fixture.stationGrillId) {
    orderCounter += 1;
    return fireTicketLine(admin, {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      stationId,
      businessDay,
      orderNumber: `FV-${stamp}-${orderCounter}`,
      terminalId: fixture.posTerminalId,
      openedBy: fixture.employeeId,
    });
  }

  async function token() {
    return pinLogin(
      http,
      fixture.tenantId,
      fixture.kdsTerminalId,
      fixture.employeeCode,
      fixture.pin,
    );
  }

  async function countTicketViewedEntries(ticketId: string): Promise<number> {
    return admin.auditEntry.count({
      where: {
        tenantId: fixture.tenantId,
        action: 'TICKET_VIEWED',
        entityId: ticketId,
      },
    });
  }

  it('GET queue does NOT mutate first_viewed_at', async () => {
    const { ticketId } = await makeTicket();
    const t = await token();
    await request(http)
      .get(`/kds/stations/${fixture.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);

    const row = await admin.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    expect(row.firstViewedAt).toBeNull();
  });

  it('POST view stamps the ticket AND its lines, write-once, with exactly ONE TICKET_VIEWED entry', async () => {
    const { ticketId, ticketLineId } = await makeTicket();
    const t = await token();

    const res = await request(http)
      .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${t}`)
      .send({ ticketIds: [ticketId] })
      .expect(200);
    expect(res.body).toEqual({ acknowledged: 1 });

    const ticket = await admin.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    const line = await admin.ticketLine.findUniqueOrThrow({
      where: { id: ticketLineId },
    });
    expect(ticket.firstViewedAt).not.toBeNull();
    expect(line.firstViewedAt).not.toBeNull();
    expect(await countTicketViewedEntries(ticketId)).toBe(1);

    const firstStamp = ticket.firstViewedAt;

    // Replay: identical batch, same (already-viewed) ticket -> 0 acknowledged, 0 new entries.
    const replay = await request(http)
      .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${t}`)
      .send({ ticketIds: [ticketId] })
      .expect(200);
    expect(replay.body).toEqual({ acknowledged: 0 });

    const ticketAfterReplay = await admin.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    expect(ticketAfterReplay.firstViewedAt).toEqual(firstStamp);
    expect(await countTicketViewedEntries(ticketId)).toBe(1);
  });

  it('a batch of 3 NEW tickets -> acknowledged: 3, and exactly 3 TICKET_VIEWED entries (one per ticket)', async () => {
    const tickets = await Promise.all([
      makeTicket(),
      makeTicket(),
      makeTicket(),
    ]);
    const t = await token();

    const res = await request(http)
      .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${t}`)
      .send({ ticketIds: tickets.map((tk) => tk.ticketId) })
      .expect(200);
    expect(res.body).toEqual({ acknowledged: 3 });

    for (const tk of tickets) {
      expect(await countTicketViewedEntries(tk.ticketId)).toBe(1);
    }
  });

  it('a MIXED batch (1 already-viewed + 2 new) -> acknowledged: 2, exactly 2 new entries', async () => {
    const already = await makeTicket();
    const t = await token();
    await request(http)
      .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${t}`)
      .send({ ticketIds: [already.ticketId] })
      .expect(200);
    expect(await countTicketViewedEntries(already.ticketId)).toBe(1);

    const newOne = await makeTicket();
    const newTwo = await makeTicket();
    const mixed = await request(http)
      .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${t}`)
      .send({
        ticketIds: [already.ticketId, newOne.ticketId, newTwo.ticketId],
      })
      .expect(200);
    expect(mixed.body).toEqual({ acknowledged: 2 });

    expect(await countTicketViewedEntries(already.ticketId)).toBe(1);
    expect(await countTicketViewedEntries(newOne.ticketId)).toBe(1);
    expect(await countTicketViewedEntries(newTwo.ticketId)).toBe(1);
  });

  it('a foreign-station ticket in the batch is silently excluded — not acknowledged, no entry', async () => {
    const foreign = await makeTicket(fixture.stationPackagingId);
    const t = await token();

    const res = await request(http)
      .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${t}`)
      .send({ ticketIds: [foreign.ticketId] })
      .expect(200);
    expect(res.body).toEqual({ acknowledged: 0 });

    const row = await admin.ticket.findUniqueOrThrow({
      where: { id: foreign.ticketId },
    });
    expect(row.firstViewedAt).toBeNull();
    expect(await countTicketViewedEntries(foreign.ticketId)).toBe(0);
  });

  it('a transaction rollback (audit write fails) removes BOTH the stamp and the audit entry', async () => {
    const { ticketId } = await makeTicket();
    const t = await token();

    const failingModule: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuditService)
      .useValue({
        record: () => {
          throw new Error('injected audit failure — proves rollback');
        },
      })
      .compile();
    const failingApp: INestApplication<App> =
      failingModule.createNestApplication();
    failingApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await failingApp.init();
    try {
      await request(failingApp.getHttpServer())
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(500);
    } finally {
      await failingApp.close();
    }

    const row = await admin.ticket.findUniqueOrThrow({
      where: { id: ticketId },
    });
    expect(row.firstViewedAt).toBeNull();
    expect(await countTicketViewedEntries(ticketId)).toBe(0);
  });

  /**
   * Acceptance correction (2026-08-31) Blocker D — first-viewed after an
   * amendment. Simulates exactly what `OrderLineFiredHandler` produces for
   * an amendment fire (a brand-new `TicketLine` on the SAME, already-fired
   * Ticket) via direct fixture insertion — the Fire-side reactivation
   * mechanics themselves are proven end to end in
   * `kds-amendment.e2e-spec.ts`; this file's job is only the first-viewed
   * semantics once such a line exists.
   */
  describe('after an amendment line is added to an already-viewed ticket (§9/§10/§11)', () => {
    async function addAmendmentLine(orderId: string, ticketId: string) {
      const menuItemId = (
        await admin.menuItem.create({
          data: {
            id: newId(),
            tenantId: fixture.tenantId,
            names: { en: 'Fries' },
          },
        })
      ).id;
      const variantId = (
        await admin.menuItemVariant.create({
          data: {
            id: newId(),
            tenantId: fixture.tenantId,
            menuItemId,
            name: { en: 'R' },
          },
        })
      ).id;
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
      return ticketLineId;
    }

    it('A. first view of the original ticket stamps the ticket + its original line, with truthful audit', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      const t = await token();

      const res = await request(http)
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(200);
      expect(res.body).toEqual({ acknowledged: 1 });

      const ticket = await admin.ticket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      const line = await admin.ticketLine.findUniqueOrThrow({
        where: { id: ticketLineId },
      });
      expect(ticket.firstViewedAt).not.toBeNull();
      expect(line.firstViewedAt).not.toBeNull();

      const entries = await admin.auditEntry.findMany({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_VIEWED',
          entityId: ticketId,
        },
      });
      expect(entries).toHaveLength(1);
      const metadata = entries[0].afterState as {
        ticketFirstViewed: boolean;
        newlyViewedLineIds: string[];
      };
      expect(metadata.ticketFirstViewed).toBe(true);
      expect(metadata.newlyViewedLineIds).toEqual([ticketLineId]);
    });

    it('B. an amendment line added after the initial view leaves the ticket timestamp and old lines untouched, and starts NULL itself', async () => {
      const { ticketId, ticketLineId, orderId } = await makeTicket();
      const t = await token();
      await request(http)
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(200);
      const ticketBefore = await admin.ticket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      const originalLineBefore = await admin.ticketLine.findUniqueOrThrow({
        where: { id: ticketLineId },
      });

      const amendmentLineId = await addAmendmentLine(orderId, ticketId);

      const ticketAfter = await admin.ticket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      const originalLineAfter = await admin.ticketLine.findUniqueOrThrow({
        where: { id: ticketLineId },
      });
      const amendmentLine = await admin.ticketLine.findUniqueOrThrow({
        where: { id: amendmentLineId },
      });
      expect(ticketAfter.firstViewedAt).toEqual(ticketBefore.firstViewedAt);
      expect(originalLineAfter.firstViewedAt).toEqual(
        originalLineBefore.firstViewedAt,
      );
      expect(amendmentLine.firstViewedAt).toBeNull();
    });

    it('C. acknowledging after the amendment stamps ONLY the new line, and writes exactly the truthful audit entry', async () => {
      const { ticketId, ticketLineId, orderId } = await makeTicket();
      const t = await token();
      await request(http)
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(200);
      const originalLineBefore = await admin.ticketLine.findUniqueOrThrow({
        where: { id: ticketLineId },
      });
      const ticketBefore = await admin.ticket.findUniqueOrThrow({
        where: { id: ticketId },
      });

      const amendmentLineId = await addAmendmentLine(orderId, ticketId);

      const res = await request(http)
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(200);
      expect(res.body).toEqual({ acknowledged: 1 });

      const ticketAfter = await admin.ticket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      const originalLineAfter = await admin.ticketLine.findUniqueOrThrow({
        where: { id: ticketLineId },
      });
      const amendmentLine = await admin.ticketLine.findUniqueOrThrow({
        where: { id: amendmentLineId },
      });
      // The TICKET-level timestamp is write-once — untouched by this
      // second acknowledgement, which only had NEW LINE work to do.
      expect(ticketAfter.firstViewedAt).toEqual(ticketBefore.firstViewedAt);
      expect(originalLineAfter.firstViewedAt).toEqual(
        originalLineBefore.firstViewedAt,
      );
      expect(amendmentLine.firstViewedAt).not.toBeNull();

      // Two entries total for this ticket's lifetime: one for the original
      // view (test A/B's `it` proves that shape), one for the amendment.
      const entries = await admin.auditEntry.findMany({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_VIEWED',
          entityId: ticketId,
        },
        orderBy: { sequenceNo: 'asc' },
      });
      expect(entries).toHaveLength(2);
      const amendmentEntry = entries[1].afterState as {
        ticketFirstViewed: boolean;
        newlyViewedLineIds: string[];
      };
      expect(amendmentEntry.ticketFirstViewed).toBe(false);
      expect(amendmentEntry.newlyViewedLineIds).toEqual([amendmentLineId]);
    });

    it('D. replaying the SAME acknowledgement after the amendment (zero newly-changed facts) writes zero new audit entries', async () => {
      const { ticketId, orderId } = await makeTicket();
      const t = await token();
      await request(http)
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(200);
      await addAmendmentLine(orderId, ticketId);
      await request(http)
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(200);
      expect(await countTicketViewedEntries(ticketId)).toBe(2);

      const replay = await request(http)
        .post(`/kds/stations/${fixture.stationGrillId}/tickets/view`)
        .set('Authorization', `Bearer ${t}`)
        .send({ ticketIds: [ticketId] })
        .expect(200);
      expect(replay.body).toEqual({ acknowledged: 0 });
      expect(await countTicketViewedEntries(ticketId)).toBe(2);
    });
  });
});
