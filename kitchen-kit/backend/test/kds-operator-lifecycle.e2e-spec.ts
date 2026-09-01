import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { createMigratorClient } from './rls-admin';
import {
  createKdsFixture,
  fireTicketLine,
  KdsFixture,
  pinLogin,
} from './kds-fixtures';

interface TicketCardLineBody {
  id: string;
  status: string;
  startedAt: string | null;
  readyAt: string | null;
  bumpedAt: string | null;
}
interface TicketCardBody {
  status: string;
  startedAt: string | null;
  recalledAt: string | null;
  recallCount: number;
}
interface TicketAndLineResponse {
  ticket: TicketCardBody;
  line: TicketCardLineBody;
}
interface BumpAllResponse {
  ticket: TicketCardBody;
  bumpedLineIds: string[];
}

function asTicketAndLine(res: { body: unknown }): TicketAndLineResponse {
  return res.body as TicketAndLineResponse;
}
function asBumpAll(res: { body: unknown }): BumpAllResponse {
  return res.body as BumpAllResponse;
}

/**
 * KDS operator lifecycle — functional flows over the real HTTP route, real
 * PostgreSQL: start, bump item, bump all, Sales readiness, recall, Sales
 * reversion, idempotency, and audit (design gate §10/§11/§13/§14/§22/§23,
 * acceptance correction throughout).
 */
describe('KDS operator lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = Date.now().toString(36);
  let fixture: KdsFixture;
  const businessDay = new Date('2026-08-30T00:00:00.000Z');
  let orderCounter = 0;
  let cookToken: string;

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
    cookToken = await pinLogin(
      http,
      fixture.tenantId,
      fixture.kdsTerminalId,
      fixture.employeeCode,
      fixture.pin,
    );
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
      orderNumber: `OPS-${stamp}-${orderCounter}`,
      terminalId: fixture.posTerminalId,
      openedBy: fixture.employeeId,
    });
  }

  function auditCount(action: string, entityId: string): Promise<number> {
    return admin.auditEntry.count({
      where: { tenantId: fixture.tenantId, action, entityId },
    });
  }

  describe('start', () => {
    it('queued -> started; ticket -> in_progress; TICKET_LINE_STARTED audited once', async () => {
      const { ticketId, ticketLineId } = await makeTicket();

      const res = await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/start`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      expect(asTicketAndLine(res).line.status).toBe('started');
      expect(asTicketAndLine(res).line.startedAt).not.toBeNull();
      expect(asTicketAndLine(res).ticket.status).toBe('in_progress');
      expect(asTicketAndLine(res).ticket.startedAt).not.toBeNull();
      expect(await auditCount('TICKET_LINE_STARTED', ticketLineId)).toBe(1);

      // Replay does not overwrite the original actor/time.
      const firstStartedAt = asTicketAndLine(res).line.startedAt;
      const replay = await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/start`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);
      expect(asTicketAndLine(replay).line.startedAt).toBe(firstStartedAt);
      expect(await auditCount('TICKET_LINE_STARTED', ticketLineId)).toBe(1);
    });

    it('a cancelled line cannot be started -> 422', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      await admin.ticketLine.update({
        where: { id: ticketLineId },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });

      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/start`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(422);
    });
  });

  describe('bump item', () => {
    it('bumps directly from queued (start is optional) and sets ready_at = bumped_at', async () => {
      const { ticketId, ticketLineId } = await makeTicket();

      const res = await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      expect(asTicketAndLine(res).line.status).toBe('bumped');
      expect(asTicketAndLine(res).line.bumpedAt).not.toBeNull();
      expect(asTicketAndLine(res).line.readyAt).toBe(
        asTicketAndLine(res).line.bumpedAt,
      );
      expect(asTicketAndLine(res).ticket.status).toBe('bumped');
      expect(await auditCount('TICKET_LINE_BUMPED', ticketLineId)).toBe(1);
    });

    it('a cancelled line cannot be bumped -> 422', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      await admin.ticketLine.update({
        where: { id: ticketLineId },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });

      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(422);
    });

    it('replaying a bump on an already-bumped line preserves the original actor/time (no error, no new audit entry)', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      const first = await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      const replay = await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      expect(asTicketAndLine(replay).line.bumpedAt).toBe(
        asTicketAndLine(first).line.bumpedAt,
      );
      expect(await auditCount('TICKET_LINE_BUMPED', ticketLineId)).toBe(1);
    });
  });

  describe('bump-all', () => {
    it('bumps every eligible line in ONE action; ONE TICKET_BUMPED entry; preserves an already-bumped line', async () => {
      const businessDayForOrder = businessDay;
      // Build a two-line ticket directly (bump-all needs >1 line to prove
      // "preserve already-bumped" — fireTicketLine only makes one line).
      const first = await makeTicket();
      const secondLineId = newId();
      await admin.orderLine.create({
        data: {
          id: secondLineId,
          tenantId: fixture.tenantId,
          orderId: first.orderId,
          businessDay: businessDayForOrder,
          sequence: 2,
          menuItemId: (
            await admin.ticketLine.findUniqueOrThrow({
              where: { id: first.ticketLineId },
              select: { orderLine: { select: { menuItemId: true } } },
            })
          ).orderLine.menuItemId,
          variantId: (
            await admin.ticketLine.findUniqueOrThrow({
              where: { id: first.ticketLineId },
              select: { orderLine: { select: { variantId: true } } },
            })
          ).orderLine.variantId,
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
        where: { tenantId: fixture.tenantId, ticketId: first.ticketId },
      });
      const secondTicketLineId = newId();
      await admin.ticketLine.create({
        data: {
          id: secondTicketLineId,
          tenantId: fixture.tenantId,
          ticketId: first.ticketId,
          fireBatchRowId: fireBatch.id,
          orderId: first.orderId,
          orderLineId: secondLineId,
          businessDay: businessDayForOrder,
          itemNameSnapshot: { en: 'Fries' },
          quantity: '1',
          sequence: 2,
          createdAt: new Date(),
          routedAt: new Date(),
        },
      });

      // Bump the FIRST line individually first (proves bump-all preserves it).
      const individualBump = await request(http)
        .post(`/kds/tickets/${first.ticketId}/lines/${first.ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);
      const preservedBumpedAt = asTicketAndLine(individualBump).line.bumpedAt;

      const res = await request(http)
        .post(`/kds/tickets/${first.ticketId}/bump-all`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      expect(asBumpAll(res).bumpedLineIds).toEqual([secondTicketLineId]);
      expect(asBumpAll(res).ticket.status).toBe('bumped');
      expect(await auditCount('TICKET_BUMPED', first.ticketId)).toBe(1);

      const firstLineRow = await admin.ticketLine.findUniqueOrThrow({
        where: { id: first.ticketLineId },
      });
      expect(firstLineRow.bumpedAt?.toISOString()).toBe(preservedBumpedAt);

      // Replay of bump-all: nothing left eligible -> bumpedLineIds: [], no new audit entry.
      const replay = await request(http)
        .post(`/kds/tickets/${first.ticketId}/bump-all`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);
      expect(asBumpAll(replay).bumpedLineIds).toEqual([]);
      expect(await auditCount('TICKET_BUMPED', first.ticketId)).toBe(1);
    });
  });

  describe('Sales readiness (single-station immediate case)', () => {
    it('bumping the only station handling an order line marks the Sales order line ready', async () => {
      const { ticketId, ticketLineId, orderLineId } = await makeTicket();

      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      const orderLine = await admin.orderLine.findFirstOrThrow({
        where: { id: orderLineId, businessDay },
      });
      expect(orderLine.state).toBe('ready');
      expect(orderLine.readyAt).not.toBeNull();
    });
  });

  describe('recall', () => {
    it('requires Idempotency-Key -> 400 without it', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      await request(http)
        .post(`/kds/tickets/${ticketId}/recall`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(400);
    });

    it('only a bumped ticket may be recalled -> 422 otherwise', async () => {
      const { ticketId } = await makeTicket();
      await request(http)
        .post(`/kds/tickets/${ticketId}/recall`)
        .set('Authorization', `Bearer ${cookToken}`)
        .set('Idempotency-Key', newId())
        .send({})
        .expect(422);
    });

    it('recall restores the line (started if it had startedAt, else queued), reverts Sales ready -> fired, clears ready_at, and re-bump is legal', async () => {
      const { ticketId, ticketLineId, orderLineId } = await makeTicket();

      // Start then bump, so recall must restore to `started` (not `queued`).
      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/start`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);
      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      const readyOrderLine = await admin.orderLine.findFirstOrThrow({
        where: { id: orderLineId, businessDay },
      });
      expect(readyOrderLine.state).toBe('ready');

      const recallRes = await request(http)
        .post(`/kds/tickets/${ticketId}/recall`)
        .set('Authorization', `Bearer ${cookToken}`)
        .set('Idempotency-Key', newId())
        .send({})
        .expect(200);

      expect(asTicketAndLine(recallRes).ticket.status).toBe('in_progress');
      expect(asTicketAndLine(recallRes).ticket.recallCount).toBe(1);
      expect(asTicketAndLine(recallRes).ticket.recalledAt).not.toBeNull();

      const line = await admin.ticketLine.findUniqueOrThrow({
        where: { id: ticketLineId },
      });
      expect(line.status).toBe('started');
      expect(line.recalledAt).not.toBeNull();
      // bumped_at is preserved through recall (FR-KDS-042 ticket-time input).
      expect(line.bumpedAt).not.toBeNull();

      const revertedOrderLine = await admin.orderLine.findFirstOrThrow({
        where: { id: orderLineId, businessDay },
      });
      expect(revertedOrderLine.state).toBe('fired');
      expect(revertedOrderLine.readyAt).toBeNull();

      expect(await auditCount('TICKET_RECALLED', ticketId)).toBe(1);

      // Re-bump after recall is legal; recall_count stays cumulative on a SECOND recall.
      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);
      const rebumped = await admin.orderLine.findFirstOrThrow({
        where: { id: orderLineId, businessDay },
      });
      expect(rebumped.state).toBe('ready');

      const secondRecall = await request(http)
        .post(`/kds/tickets/${ticketId}/recall`)
        .set('Authorization', `Bearer ${cookToken}`)
        .set('Idempotency-Key', newId())
        .send({})
        .expect(200);
      expect(asTicketAndLine(secondRecall).ticket.recallCount).toBe(2);
    });

    it('recall respects the branch recall_window_seconds -> 422 once expired', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      await admin.ticket.update({
        where: { id: ticketId },
        data: { bumpedAt: new Date(Date.now() - 1800_000 - 60_000) },
      });

      await request(http)
        .post(`/kds/tickets/${ticketId}/recall`)
        .set('Authorization', `Bearer ${cookToken}`)
        .set('Idempotency-Key', newId())
        .send({})
        .expect(422);
    });

    it('an identical retry with the SAME Idempotency-Key replays the stored response (Idempotent-Replay: true)', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      await request(http)
        .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
        .set('Authorization', `Bearer ${cookToken}`)
        .send({})
        .expect(200);

      const key = newId();
      const first = await request(http)
        .post(`/kds/tickets/${ticketId}/recall`)
        .set('Authorization', `Bearer ${cookToken}`)
        .set('Idempotency-Key', key)
        .send({})
        .expect(200);

      const replay = await request(http)
        .post(`/kds/tickets/${ticketId}/recall`)
        .set('Authorization', `Bearer ${cookToken}`)
        .set('Idempotency-Key', key)
        .send({})
        .expect(200);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body).toEqual(first.body);

      const ticket = await admin.ticket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      expect(ticket.recallCount).toBe(1);
    });
  });
});
