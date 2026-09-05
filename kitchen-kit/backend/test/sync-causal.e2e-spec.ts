import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';
import {
  BatchResultView,
  SYNC_BATCH_PATH,
  SyncFixture,
  bootstrapSyncApp,
  buildBatch,
  buildOperation,
  byOpId,
  createSyncFixture,
  destroySyncFixture,
  terminalToken,
} from './sync-fixtures';

/**
 * FR-OFF-022 causal ordering and the ratified fifth status `deferred`
 * (GD-D1-04), against real PostgreSQL.
 */
describe('Sync causal ordering (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let fx: SyncFixture;
  let token: string;

  const seed = `c${Date.now()}`;

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    fx = await createSyncFixture(app, admin, seed);
    token = await terminalToken(http, fx, fx.terminalId);
  }, 90_000);

  afterAll(async () => {
    await destroySyncFixture(admin, fx);
    await admin.$disconnect();
    await app.close();
  });

  const post = (body: unknown) =>
    request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  it('applies a parent before its child even when submitted in reverse', async () => {
    const parent = buildOperation(fx.node, {
      logical: 9,
      payload: { mode: 'audit' },
    });
    const child = buildOperation(fx.node, {
      // Deliberately an EARLIER HLC than its parent, so ordering by time alone
      // would get this wrong; causality has to win.
      logical: 1,
      causedBy: parent.opId,
      payload: { mode: 'audit' },
    });
    const res = await post(buildBatch(fx.terminalId, [child, parent])).expect(
      200,
    );
    const results = byOpId(res.body as BatchResultView);
    expect(results.get(parent.opId)?.status).toBe('accepted');
    expect(results.get(child.opId)?.status).toBe('accepted');

    const rows = await prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
      tx.auditEntry.findMany({
        where: {
          tenantId: fx.tenantId,
          entityId: { in: [parent.entityId, child.entityId] },
        },
        orderBy: { sequenceNo: 'asc' },
      }),
    );
    // The audit chain is a durable witness of the ORDER the effects were
    // applied in, not merely of the results the client was told.
    expect(rows.map((r) => r.entityId)).toEqual([
      parent.entityId,
      child.entityId,
    ]);
  });

  it('defers — never rejects — an operation whose parent has not arrived', async () => {
    const orphan = buildOperation(fx.node, { causedBy: newId() });
    const res = await post(buildBatch(fx.terminalId, [orphan])).expect(200);
    const r = byOpId(res.body as BatchResultView).get(orphan.opId);
    expect(r?.status).toBe('deferred');
    expect(r?.definitive).toBe(false);
    expect(r?.reasonCode).toBe('causal_parent_missing');

    // Nothing at all was settled: the client keeps it and resends.
    const dedup = await prisma.withAuthContext(
      { tenantId: fx.tenantId },
      (tx) =>
        tx.syncOperationDedup.findUnique({
          where: {
            tenantId_opId: { tenantId: fx.tenantId, opId: orphan.opId },
          },
        }),
    );
    expect(dedup).toBeNull();
  });

  it('accepts the deferred child once its parent has been applied', async () => {
    const parent = buildOperation(fx.node, { payload: { mode: 'audit' } });
    const child = buildOperation(fx.node, {
      causedBy: parent.opId,
      payload: { mode: 'audit' },
    });

    const deferredRes = await post(buildBatch(fx.terminalId, [child])).expect(
      200,
    );
    expect(
      byOpId(deferredRes.body as BatchResultView).get(child.opId)?.status,
    ).toBe('deferred');

    await post(buildBatch(fx.terminalId, [parent])).expect(200);

    // The client resends the retained operation — the ordinary retry loop.
    const retry = await post(buildBatch(fx.terminalId, [child])).expect(200);
    expect(byOpId(retry.body as BatchResultView).get(child.opId)?.status).toBe(
      'accepted',
    );
  });

  it('cascades a deferral down a whole chain within one batch', async () => {
    const a = buildOperation(fx.node, { logical: 1, causedBy: newId() });
    const b = buildOperation(fx.node, { logical: 2, causedBy: a.opId });
    const c = buildOperation(fx.node, { logical: 3, causedBy: b.opId });
    const res = await post(buildBatch(fx.terminalId, [a, b, c])).expect(200);
    for (const r of (res.body as BatchResultView).results) {
      expect(r.status).toBe('deferred');
      expect(r.definitive).toBe(false);
    }
  });

  it('rejects a child whose parent was settled without being applied', async () => {
    // Deferring here would strand the child in the outbox forever, because the
    // parent can never become applied.
    const parent = buildOperation(fx.node, { type: 'nosuch.thing' });
    await post(buildBatch(fx.terminalId, [parent])).expect(200);

    const child = buildOperation(fx.node, { causedBy: parent.opId });
    const res = await post(buildBatch(fx.terminalId, [child])).expect(200);
    const r = byOpId(res.body as BatchResultView).get(child.opId);
    expect(r?.status).toBe('rejected');
    expect(r?.definitive).toBe(true);
    expect(r?.reasonCode).toBe('causal_parent_rejected');
  });

  it('rejects a child whose in-batch parent fails at apply time', async () => {
    const parent = buildOperation(fx.node, {
      logical: 1,
      payload: { mode: 'throw' },
    });
    const child = buildOperation(fx.node, {
      logical: 2,
      causedBy: parent.opId,
    });
    const res = await post(buildBatch(fx.terminalId, [parent, child])).expect(
      200,
    );
    const results = byOpId(res.body as BatchResultView);
    expect(results.get(parent.opId)?.status).toBe('rejected');
    expect(results.get(child.opId)?.status).toBe('rejected');
    expect(results.get(child.opId)?.reasonCode).toBe('causal_parent_rejected');
  });

  it('D4-1B: defers — does not reject — a child whose parent settled as a conflict (already settled, later batch)', async () => {
    // A `conflict` parent is NOT proven to be permanently unresolvable (it
    // may still be resolved manually, `sync.conflict_records.resolution ===
    // 'manual_pending'`) — unlike a `rejected` parent, which structurally
    // cannot ever apply. See operation-scheduler.ts's "WHY A CONFLICTED
    // PARENT DEFERS, NOT REJECTS".
    const parent = buildOperation(fx.node, { payload: { mode: 'conflict' } });
    const parentRes = await post(buildBatch(fx.terminalId, [parent])).expect(
      200,
    );
    expect(
      byOpId(parentRes.body as BatchResultView).get(parent.opId),
    ).toMatchObject({ status: 'conflict', definitive: true });

    const child = buildOperation(fx.node, { causedBy: parent.opId });
    const res = await post(buildBatch(fx.terminalId, [child])).expect(200);
    const r = byOpId(res.body as BatchResultView).get(child.opId);
    expect(r?.status).toBe('deferred');
    expect(r?.definitive).toBe(false);
    expect(r?.reasonCode).toBe('causal_parent_conflicted');
  });

  it('D4-1B: defers an in-batch child whose parent settles as a conflict in the same batch', async () => {
    const parent = buildOperation(fx.node, {
      logical: 1,
      payload: { mode: 'conflict' },
    });
    const child = buildOperation(fx.node, {
      logical: 2,
      causedBy: parent.opId,
    });
    const res = await post(buildBatch(fx.terminalId, [parent, child])).expect(
      200,
    );
    const results = byOpId(res.body as BatchResultView);
    expect(results.get(parent.opId)?.status).toBe('conflict');
    expect(results.get(child.opId)?.status).toBe('deferred');
    expect(results.get(child.opId)?.definitive).toBe(false);
    expect(results.get(child.opId)?.reasonCode).toBe(
      'causal_parent_conflicted',
    );
  });

  it('rejects a causedBy cycle rather than deferring it forever', async () => {
    const a = buildOperation(fx.node, { logical: 1 });
    const b = buildOperation(fx.node, { logical: 2, causedBy: a.opId });
    const cyclic = { ...a, causedBy: b.opId };
    const res = await post(buildBatch(fx.terminalId, [cyclic, b])).expect(200);
    for (const r of (res.body as BatchResultView).results) {
      expect(r.status).toBe('rejected');
      expect(r.reasonCode).toBe('causal_cycle');
    }
  });

  it('processes independent operations in deterministic HLC order', async () => {
    const ops = [3, 1, 2].map((logical) =>
      buildOperation(fx.node, { logical, payload: { mode: 'audit' } }),
    );
    await post(buildBatch(fx.terminalId, ops)).expect(200);
    const rows = await prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
      tx.auditEntry.findMany({
        where: {
          tenantId: fx.tenantId,
          entityId: { in: ops.map((o) => o.entityId) },
        },
        orderBy: { sequenceNo: 'asc' },
      }),
    );
    // Submission order was 3,1,2; application order must be 1,2,3.
    expect(rows.map((r) => r.entityId)).toEqual([
      ops[1].entityId,
      ops[2].entityId,
      ops[0].entityId,
    ]);
  });

  it('a deferred operation never becomes definitive by accident', async () => {
    const orphan = buildOperation(fx.node, { causedBy: newId() });
    for (let i = 0; i < 3; i += 1) {
      const res = await post(buildBatch(fx.terminalId, [orphan])).expect(200);
      const r = byOpId(res.body as BatchResultView).get(orphan.opId);
      expect(r?.status).toBe('deferred');
      expect(r?.definitive).toBe(false);
    }
    const count = await prisma.withAuthContext(
      { tenantId: fx.tenantId },
      (tx) =>
        tx.syncOperationDedup.count({
          where: { tenantId: fx.tenantId, opId: orphan.opId },
        }),
    );
    expect(count).toBe(0);
  });
});
