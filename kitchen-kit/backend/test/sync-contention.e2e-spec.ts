import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { hlcNodeFromTerminalId } from './../src/modules/sync/hlc/hlc';
import { createMigratorClient } from './rls-admin';
import { createKdsFixture, fireTicketLine, KdsFixture } from './kds-fixtures';
import {
  BatchResultView,
  SYNC_BATCH_PATH,
  SyncFixture,
  bootstrapSyncApp,
  buildBatch,
  buildOperation,
  createSyncFixture,
  destroySyncFixture,
  terminalToken,
} from './sync-fixtures';

/**
 * P-D4-02 production-scale contention — the three cases
 * `sync-audit-contention.e2e-spec.ts` (D4-1A) does not cover: duplicate
 * op-id racing across two concurrent batches, concurrent batches on
 * DISTINCT branches, and a resource-level domain conflict (two batches
 * racing to mutate the SAME ticket) exercised through a real production
 * handler's own CAS, not the kernel's dedup CAS alone.
 *
 * Asserted throughout: no duplicate effect, no deadlock, bounded outcome,
 * `operation_dedup`/finality left uncorrupted.
 */
describe('P-D4-02 production-scale contention (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
  }, 90_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('duplicate op-id racing in two concurrent batches', () => {
    let fx: SyncFixture;
    let token1: string;
    let token2: string;

    beforeAll(async () => {
      fx = await createSyncFixture(app, admin, `race${Date.now()}`);
      token1 = await terminalToken(http, fx, fx.terminalId);
      token2 = await terminalToken(http, fx, fx.terminal2Id);
    }, 60_000);

    afterAll(async () => {
      await destroySyncFixture(admin, fx);
    });

    it('exactly one settlement wins for the SAME opId submitted concurrently from two terminals', async () => {
      const opId = newId();
      const entityId = newId();
      // ONE operation object, IDENTICAL content (including hlc) — a genuine
      // duplicate submission race (e.g. a flaky-network resend), not two
      // devices independently generating the same opId with different
      // content, which the kernel is separately and correctly required to
      // fail closed as `duplicate_op_id_different_fingerprint`.
      const op = buildOperation(fx.node, {
        opId,
        entityId,
        payload: { mode: 'audit', note: 'racer-1' },
      });

      const [r1, r2] = await Promise.all([
        request(http)
          .post(SYNC_BATCH_PATH)
          .set('Authorization', `Bearer ${token1}`)
          .send(buildBatch(fx.terminalId, [op], newId())),
        request(http)
          .post(SYNC_BATCH_PATH)
          .set('Authorization', `Bearer ${token2}`)
          .send(buildBatch(fx.terminal2Id, [op], newId())),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const status1 = (r1.body as BatchResultView).results[0]?.status;
      const status2 = (r2.body as BatchResultView).results[0]?.status;
      // One accepted, the other sees it as a duplicate (or, on a genuine
      // simultaneous first-write race, both may observe `accepted` if the
      // kernel's own upsert-on-conflict resolves to the identical stored
      // result — either way, GLOBAL dedup below is the real assertion).
      expect(['accepted', 'duplicate']).toContain(status1);
      expect(['accepted', 'duplicate']).toContain(status2);

      const dedupRows = await prisma.withAuthContext(
        { tenantId: fx.tenantId },
        (tx) =>
          tx.syncOperationDedup.findMany({
            where: { tenantId: fx.tenantId, opId },
          }),
      );
      // GLOBAL (tenant_id, op_id) dedup: exactly ONE settled row, ever.
      expect(dedupRows).toHaveLength(1);
      expect(dedupRows[0].status).toBe('accepted');

      const audits = await admin.auditEntry.count({
        where: {
          tenantId: fx.tenantId,
          action: 'SYNC_CLOCK_SKEW_DETECTED',
          entityId,
        },
      });
      // Exactly one business effect, never two.
      expect(audits).toBe(1);
    });
  });

  describe('concurrent batches on DISTINCT branches of the same tenant', () => {
    let tenantId: string;
    let branchAId: string;
    let branchBId: string;
    let terminalAId: string;
    let terminalBId: string;
    let tokenA: string;
    let tokenB: string;

    beforeAll(async () => {
      const seed = `distbr${Date.now()}`;
      const fxA = await createSyncFixture(app, admin, seed);
      tenantId = fxA.tenantId;
      branchAId = fxA.branchId;
      terminalAId = fxA.terminalId;
      tokenA = await terminalToken(http, fxA, terminalAId);

      const brandB = await admin.brand.create({
        data: { id: newId(), tenantId, name: `Second Brand ${seed}` },
      });
      const branchB = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brandB.id,
          code: `B2${seed.slice(-6)}`,
          name: `Second Branch ${seed}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      branchBId = branchB.id;
      await admin.location.create({
        data: {
          id: newId(),
          tenantId,
          locationType: 'branch',
          refId: branchBId,
          branchId: branchBId,
        },
      });
      terminalBId = await admin.terminal
        .create({
          data: {
            id: newId(),
            tenantId,
            branchId: branchBId,
            name: `POS-B-${seed}`,
            terminalType: 'pos',
            status: 'active',
          },
        })
        .then((t) => t.id);
      // PIN login itself (not just SYNC_AUTHORIZATION_PORT) requires the
      // employee to be permitted at the TERMINAL's branch — AND-only
      // narrowing, checked live on every PIN sign-in.
      await admin.employeeBranch.create({
        data: { tenantId, employeeId: fxA.employeeId, branchId: branchBId },
      });
      tokenB = await terminalToken(
        http,
        { tenantId, employeeCode: fxA.employeeCode, pin: fxA.pin },
        terminalBId,
      );

      // stash for teardown
      teardownTenantId = tenantId;
    }, 60_000);

    let teardownTenantId: string;
    afterAll(async () => {
      await admin.syncOperation.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.syncOperationDedup.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.syncBatch.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.syncDeviceState.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.auditEntry.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.session.deleteMany({
        where: { terminal: { tenantId: teardownTenantId } },
      });
      await admin.terminal.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.location.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.employeeBranch.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.employee.deleteMany({
        where: { tenantId: teardownTenantId },
      });
      await admin.branch.deleteMany({ where: { tenantId: teardownTenantId } });
      await admin.brand.deleteMany({ where: { tenantId: teardownTenantId } });
      await admin.tenant.deleteMany({ where: { id: teardownTenantId } });
    });

    it('both branches’ batches complete concurrently with no deadlock and no cross-branch bleed', async () => {
      const opsA = Array.from({ length: 25 }, (_, i) =>
        buildOperation(hlcNodeFromTerminalId(terminalAId), {
          logical: i,
          payload: { mode: 'audit', note: `A-${i}` },
        }),
      );
      const opsB = Array.from({ length: 25 }, (_, i) =>
        buildOperation(hlcNodeFromTerminalId(terminalBId), {
          logical: i,
          payload: { mode: 'audit', note: `B-${i}` },
        }),
      );
      const [resA, resB] = await Promise.all([
        request(http)
          .post(SYNC_BATCH_PATH)
          .set('Authorization', `Bearer ${tokenA}`)
          .send(buildBatch(terminalAId, opsA, newId())),
        request(http)
          .post(SYNC_BATCH_PATH)
          .set('Authorization', `Bearer ${tokenB}`)
          .send(buildBatch(terminalBId, opsB, newId())),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect((resA.body as BatchResultView).counts.accepted).toBe(25);
      expect((resB.body as BatchResultView).counts.accepted).toBe(25);

      const opsSaved = await prisma.withAuthContext({ tenantId }, (tx) =>
        tx.syncOperation.findMany({
          where: { tenantId },
          select: { branchId: true },
        }),
      );
      const branchATotal = opsSaved.filter(
        (o) => o.branchId === branchAId,
      ).length;
      const branchBTotal = opsSaved.filter(
        (o) => o.branchId === branchBId,
      ).length;
      expect(branchATotal).toBe(25);
      expect(branchBTotal).toBe(25);
    }, 60_000);
  });

  describe('resource-level domain conflict — two batches racing to bump the SAME ticket line', () => {
    let fixture: KdsFixture;
    let token: string;
    let node: string;

    beforeAll(async () => {
      fixture = await createKdsFixture(app, admin, `racebump${Date.now()}`);
      token = await terminalToken(http, fixture, fixture.posTerminalId);
      node = hlcNodeFromTerminalId(fixture.posTerminalId);
    }, 60_000);

    it('exactly one bump lands; the other observes it already bumped — no duplicate effect, no corruption', async () => {
      const { ticketId, ticketLineId } = await fireTicketLine(admin, {
        tenantId: fixture.tenantId,
        branchId: fixture.branchId,
        stationId: fixture.stationGrillId,
        businessDay: new Date('2026-08-30T00:00:00.000Z'),
        orderNumber: `RACE-${Date.now().toString(36).slice(-8)}`,
        terminalId: fixture.posTerminalId,
        openedBy: fixture.employeeId,
      });

      const opA = buildOperation(node, {
        type: 'kds.ticket.bump_line',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: ticketLineId },
      });
      const opB = buildOperation(node, {
        logical: 1,
        type: 'kds.ticket.bump_line',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: ticketLineId },
      });

      const [resA, resB] = await Promise.all([
        request(http)
          .post(SYNC_BATCH_PATH)
          .set('Authorization', `Bearer ${token}`)
          .send(buildBatch(fixture.posTerminalId, [opA], newId())),
        request(http)
          .post(SYNC_BATCH_PATH)
          .set('Authorization', `Bearer ${token}`)
          .send(buildBatch(fixture.posTerminalId, [opB], newId())),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      // Both are `accepted` — the SECOND to physically apply lost the CAS on
      // `status IN BUMP_ELIGIBLE_STATUSES` and took the handler's documented
      // no-op branch ("lost a race... not an error — the line is bumped
      // either way"), which is itself an `accepted` outcome, never a
      // duplicated mutation.
      const statusA = (resA.body as BatchResultView).results[0]?.status;
      const statusB = (resB.body as BatchResultView).results[0]?.status;
      expect(statusA).toBe('accepted');
      expect(statusB).toBe('accepted');

      const line = await admin.ticketLine.findUnique({
        where: { id: ticketLineId },
      });
      expect(line?.status).toBe('bumped');

      const audits = await admin.auditEntry.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'TICKET_LINE_BUMPED',
          entityId: ticketLineId,
        },
      });
      // Exactly ONE audit entry — the CAS loser never reached the audit write.
      expect(audits).toBe(1);
    }, 30_000);
  });
});
