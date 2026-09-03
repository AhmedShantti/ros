import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { hlcNodeFromTerminalId } from './../src/modules/sync/hlc/hlc';
import { createMigratorClient } from './rls-admin';
import { createKdsFixture, fireTicketLine, KdsFixture } from './kds-fixtures';
import {
  BatchResultView,
  SYNC_BATCH_PATH,
  bootstrapSyncApp,
  buildBatch,
  buildOperation,
  byOpId,
  terminalToken,
} from './sync-fixtures';

/**
 * D4-1B production offline domain handlers — `kds.ticket.bump_line` and
 * `kds.ticket.recall` — exercised through the REAL `POST /v1/sync/batch`
 * pipeline against real PostgreSQL: live authorization, revalidation against
 * CURRENT server state, replay safety, and audit.
 */
describe('Sync production handlers — KDS tickets (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let fixture: KdsFixture;
  let token: string;
  let node: string;

  const stamp = Date.now().toString(36);
  const businessDay = new Date('2026-08-30T00:00:00.000Z');
  let orderCounter = 0;

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    fixture = await createKdsFixture(app, admin, stamp);
    token = await terminalToken(http, fixture, fixture.posTerminalId);
    node = hlcNodeFromTerminalId(fixture.posTerminalId);
  }, 90_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function makeTicket() {
    orderCounter += 1;
    return fireTicketLine(admin, {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      stationId: fixture.stationGrillId,
      businessDay,
      orderNumber: `SYNC-${stamp}-${orderCounter}`,
      terminalId: fixture.posTerminalId,
      openedBy: fixture.employeeId,
    });
  }

  const post = (body: unknown) =>
    request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  describe('kds.ticket.bump_line', () => {
    it('bumps a queued line, and is authorized against the LIVE actorEmployeeId, not the offline capture-time assumption', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      const op = buildOperation(node, {
        type: 'kds.ticket.bump_line',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: ticketLineId },
      });
      const res = await post(buildBatch(fixture.posTerminalId, [op])).expect(
        200,
      );
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('accepted');
      expect(r?.detail?.lineStatus).toBe('bumped');

      const line = await admin.ticketLine.findUnique({
        where: { id: ticketLineId },
      });
      expect(line?.status).toBe('bumped');
      expect(line?.bumpedBy).toBe(fixture.employeeId);

      const audits = await admin.auditEntry.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_LINE_BUMPED',
          entityId: ticketLineId,
        },
      });
      expect(audits).toBe(1);
    });

    it('rejects with authorization_denied when no actorEmployeeId is asserted', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      const op = buildOperation(node, {
        type: 'kds.ticket.bump_line',
        entityId: ticketId,
        actorEmployeeId: null,
        payload: { lineId: ticketLineId },
      });
      const res = await post(buildBatch(fixture.posTerminalId, [op])).expect(
        200,
      );
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('rejected');
      expect(r?.reasonCode).toBe('authorization_denied');

      const line = await admin.ticketLine.findUnique({
        where: { id: ticketLineId },
      });
      // Revalidation-denied: no effect applied.
      expect(line?.status).toBe('queued');
    });

    it('resource_not_found for a ticket that does not exist — no tenant-existence leak', async () => {
      const op = buildOperation(node, {
        type: 'kds.ticket.bump_line',
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: '00000000-0000-4000-8000-000000000000' },
      });
      const res = await post(buildBatch(fixture.posTerminalId, [op])).expect(
        200,
      );
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('rejected');
      expect(r?.reasonCode).toBe('resource_not_found');
    });

    it('illegal_transition — a cancelled line cannot be bumped', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      await admin.ticketLine.update({
        where: { id: ticketLineId },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      const op = buildOperation(node, {
        type: 'kds.ticket.bump_line',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: ticketLineId },
      });
      const res = await post(buildBatch(fixture.posTerminalId, [op])).expect(
        200,
      );
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('rejected');
      expect(r?.reasonCode).toBe('illegal_transition');
    });

    it('replay safety: the SAME opId resubmitted does not double-bump or double-audit', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      const op = buildOperation(node, {
        type: 'kds.ticket.bump_line',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: ticketLineId },
      });
      await post(buildBatch(fixture.posTerminalId, [op])).expect(200);
      const replay = await post(
        buildBatch(fixture.posTerminalId, [op], newId()),
      ).expect(200);
      const r = byOpId(replay.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('duplicate');

      const audits = await admin.auditEntry.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_LINE_BUMPED',
          entityId: ticketLineId,
        },
      });
      expect(audits).toBe(1);
    });
  });

  describe('kds.ticket.recall', () => {
    it('recalls a bumped ticket back to started (line has startedAt)', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      await admin.ticketLine.update({
        where: { id: ticketLineId },
        data: { status: 'bumped', startedAt: new Date(), bumpedAt: new Date() },
      });
      await admin.ticket.update({
        where: { id: ticketId },
        data: { status: 'bumped', bumpedAt: new Date() },
      });

      const op = buildOperation(node, {
        type: 'kds.ticket.recall',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: {},
      });
      const res = await post(buildBatch(fixture.posTerminalId, [op])).expect(
        200,
      );
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('accepted');

      const line = await admin.ticketLine.findUnique({
        where: { id: ticketLineId },
      });
      expect(line?.status).toBe('started');
    });

    it('D4-1B revalidation: conflict (not rejected) when the ticket is no longer bumped — server’s CURRENT state wins over the offline capture-time assumption', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      // Ticket is `queued`, never bumped — the offline device's assumption
      // ("this ticket was bumped when I captured the recall") is stale.
      const op = buildOperation(node, {
        type: 'kds.ticket.recall',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: {},
      });
      const res = await post(buildBatch(fixture.posTerminalId, [op])).expect(
        200,
      );
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('conflict');
      expect(r?.reasonCode).toBe('illegal_transition');
      expect(r?.definitive).toBe(true);
      expect(r?.conflictId).toBeTruthy();

      // FR-OFF-043: a manager can review BOTH the local (offline-assumed)
      // and server (actual) states of this conflict.
      const record = await admin.syncConflictRecord.findUnique({
        where: { id: r!.conflictId! },
      });
      expect(record?.tenantId).toBe(fixture.tenantId);
      expect(record?.entityId).toBe(ticketId);
      expect(record?.localState).toMatchObject({ assumedStatus: 'bumped' });
      expect(record?.serverState).toMatchObject({ status: 'queued' });

      const line = await admin.ticketLine.findUnique({
        where: { id: ticketLineId },
      });
      expect(line?.status).toBe('queued');
    });
  });

  describe('fast-path rollback + fallback replay does not duplicate a production handler’s effect', () => {
    it('a chunk containing a throwing sibling replays through the safe path with no duplicate bump/audit', async () => {
      const { ticketId, ticketLineId } = await makeTicket();
      const bump = buildOperation(node, {
        logical: 1,
        type: 'kds.ticket.bump_line',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: ticketLineId },
      });
      const boom = buildOperation(node, {
        logical: 2,
        type: 'protocol.probe',
        payload: { mode: 'throw' },
      });
      const res = await post(
        buildBatch(fixture.posTerminalId, [bump, boom]),
      ).expect(200);
      const results = byOpId(res.body as BatchResultView);
      expect(results.get(bump.opId)?.status).toBe('accepted');
      expect(results.get(boom.opId)?.status).toBe('rejected');

      const audits = await admin.auditEntry.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_LINE_BUMPED',
          entityId: ticketLineId,
        },
      });
      expect(audits).toBe(1);
      const line = await admin.ticketLine.findUnique({
        where: { id: ticketLineId },
      });
      expect(line?.status).toBe('bumped');
    });
  });
});
