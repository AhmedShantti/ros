import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { SYNC_DEDUP_RETENTION_DAYS } from './../src/modules/sync/protocol/protocol.constants';
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
 * FR-OFF-021 / FR-OFF-025 / FR-API-021..023 / NFR-REL-011 — at-most-once
 * financial effect, and the identity architecture that guarantees it.
 */
describe('Sync idempotency (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let fx: SyncFixture;
  let fx2: SyncFixture;
  let token: string;
  let token2: string;

  const seed = `i${Date.now()}`;

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    fx = await createSyncFixture(app, admin, seed);
    fx2 = await createSyncFixture(app, admin, `${seed}b`);
    token = await terminalToken(http, fx, fx.terminalId);
    token2 = await terminalToken(http, fx2, fx2.terminalId);
  }, 90_000);

  afterAll(async () => {
    await destroySyncFixture(admin, fx);
    await destroySyncFixture(admin, fx2);
    await admin.$disconnect();
    await app.close();
  });

  const post = (body: unknown, bearer = token) =>
    request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .send(body as object);

  const auditCount = (tenantId: string, entityId: string) =>
    prisma.withAuthContext({ tenantId }, (tx) =>
      tx.auditEntry.count({ where: { tenantId, entityId } }),
    );

  it('structurally enforces global (tenant_id, op_id) uniqueness — Correction 1', async () => {
    // The whole point of separating identity from history: the dedup primary
    // key must contain NO partition-key column, or the same opId could be
    // applied again in a different time partition.
    const rows = await admin.$queryRawUnsafe<{ definition: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'sync.operation_dedup'::regclass AND contype = 'p'`,
    );
    expect(rows[0].definition).toBe('PRIMARY KEY (tenant_id, op_id)');
  });

  it('applies an operation exactly once across repeated batches', async () => {
    const op = buildOperation(fx.node, {
      payload: { mode: 'audit', note: 'once' },
    });
    const first = await post(buildBatch(fx.terminalId, [op])).expect(200);
    expect(byOpId(first.body as BatchResultView).get(op.opId)?.status).toBe(
      'accepted',
    );
    expect(await auditCount(fx.tenantId, op.entityId)).toBe(1);

    // Same opId, brand-new batchId: the batch is new, the operation is not.
    const second = await post(buildBatch(fx.terminalId, [op])).expect(200);
    const r = byOpId(second.body as BatchResultView).get(op.opId);
    expect(r?.status).toBe('duplicate');
    expect(r?.definitive).toBe(true);
    // NFR-REL-011 — at-most-once FINANCIAL EFFECT, not merely at-most-once row.
    expect(await auditCount(fx.tenantId, op.entityId)).toBe(1);
  });

  it('returns the ORIGINAL result for a repeated opId, not a recomputed one', async () => {
    const op = buildOperation(fx.node, { type: 'nosuch.thing' });
    const first = await post(buildBatch(fx.terminalId, [op])).expect(200);
    expect(byOpId(first.body as BatchResultView).get(op.opId)?.reasonCode).toBe(
      'unknown_operation_type',
    );
    const second = await post(buildBatch(fx.terminalId, [op])).expect(200);
    // Settled definitively as `rejected` the first time; the repeat is answered
    // `duplicate` rather than being reprocessed (FR-OFF-021).
    expect(byOpId(second.body as BatchResultView).get(op.opId)?.status).toBe(
      'duplicate',
    );
  });

  it('fails closed on the same opId with a different body', async () => {
    const op = buildOperation(fx.node, { payload: { mode: 'noop' } });
    await post(buildBatch(fx.terminalId, [op])).expect(200);

    const tampered = { ...op, payload: { mode: 'audit', note: 'different' } };
    const res = await post(buildBatch(fx.terminalId, [tampered])).expect(200);
    const r = byOpId(res.body as BatchResultView).get(op.opId);
    expect(r?.status).toBe('rejected');
    expect(r?.reasonCode).toBe('duplicate_op_id_different_fingerprint');
    // The original effect must not have been re-applied or overwritten.
    expect(await auditCount(fx.tenantId, op.entityId)).toBe(0);
  });

  it('answers a repeated opId INSIDE one batch from the first occurrence', async () => {
    const op = buildOperation(fx.node, {
      payload: { mode: 'audit', note: 'inbatch' },
    });
    const res = await post(buildBatch(fx.terminalId, [op, op])).expect(200);
    const statuses = (res.body as BatchResultView).results.map((r) => r.status);
    expect(statuses).toEqual(['accepted', 'duplicate']);
    expect(await auditCount(fx.tenantId, op.entityId)).toBe(1);
  });

  it('replays a completed batch verbatim and re-applies nothing (FR-OFF-025)', async () => {
    const op = buildOperation(fx.node, {
      payload: { mode: 'audit', note: 'replay' },
    });
    const batch = buildBatch(fx.terminalId, [op]);
    const first = await post(batch).expect(200);
    const second = await post(batch).expect(200);

    const a = first.body as BatchResultView;
    const b = second.body as BatchResultView;
    expect(b.replayed).toBe(true);
    expect(b.results).toEqual(a.results);
    expect(b.counts).toEqual(a.counts);
    expect(await auditCount(fx.tenantId, op.entityId)).toBe(1);
  });

  it('409s the same batchId with a different body (FR-API-023)', async () => {
    const batchId = newId();
    await post(
      buildBatch(fx.terminalId, [buildOperation(fx.node)], batchId),
    ).expect(200);
    await post(
      buildBatch(fx.terminalId, [buildOperation(fx.node)], batchId),
    ).expect(409);
  });

  it('never replays an opId across a tenant boundary (CT-05)', async () => {
    const opId = newId();
    const entityId = newId();
    const a = buildOperation(fx.node, {
      opId,
      entityId,
      payload: { mode: 'audit' },
    });
    const b = buildOperation(fx2.node, {
      opId,
      entityId,
      payload: { mode: 'audit' },
    });

    expect(
      byOpId(
        (await post(buildBatch(fx.terminalId, [a])).expect(200))
          .body as BatchResultView,
      ).get(opId)?.status,
    ).toBe('accepted');
    // The SAME opId in another tenant is a first sighting there, not a replay.
    const other = await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token2}`)
      .send(buildBatch(fx2.terminalId, [b]))
      .expect(200);
    expect(byOpId(other.body as BatchResultView).get(opId)?.status).toBe(
      'accepted',
    );

    expect(await auditCount(fx.tenantId, entityId)).toBe(1);
    expect(await auditCount(fx2.tenantId, entityId)).toBe(1);
  });

  it('stamps at least the FR-OFF-021 retention window on every settlement', async () => {
    // 30 days is both the FR-API-021 floor and the ratified rule that server
    // retention must never be shorter than the client outbox horizon
    // (FR-OFF-013's own default is 30 days). Asserted on the stored value
    // rather than by waiting.
    const op = buildOperation(fx.node);
    await post(buildBatch(fx.terminalId, [op])).expect(200);
    const row = await prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
      tx.syncOperationDedup.findUnique({
        where: { tenantId_opId: { tenantId: fx.tenantId, opId: op.opId } },
      }),
    );
    const windowMs = row!.expiresAt.getTime() - row!.settledAt.getTime();
    expect(windowMs).toBeGreaterThanOrEqual(
      SYNC_DEDUP_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it('writes history for processed operations, not for duplicates', async () => {
    const op = buildOperation(fx.node, {
      payload: { mode: 'audit', note: 'history' },
    });
    await post(buildBatch(fx.terminalId, [op])).expect(200);
    await post(buildBatch(fx.terminalId, [op])).expect(200);
    const history = await prisma.withAuthContext(
      { tenantId: fx.tenantId },
      (tx) =>
        tx.syncOperation.findMany({
          where: { tenantId: fx.tenantId, opId: op.opId },
        }),
    );
    // A duplicate adds no new fact, so history holds exactly one row.
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('accepted');
    // Server-derived attribution, never client-supplied.
    expect(history[0].terminalId).toBe(fx.terminalId);
    expect(history[0].branchId).toBe(fx.branchId);
  });
});
