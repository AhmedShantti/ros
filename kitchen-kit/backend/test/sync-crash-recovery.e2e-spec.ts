import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { SYNC_DEFAULT_CHUNK_SIZE } from './../src/modules/sync/protocol/protocol.constants';
import { SyncFailpoint } from './../src/modules/sync/sync.failpoint';
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
 * Correction 2 of the D1-1 ratification and the `FR-OFF-025` invariant:
 *
 *   "A server crash or connection loss during a batch SHALL NOT duplicate an
 *    already-applied operation, permanently strand a valid batch, require loss
 *    of acknowledged sales, require changing opIds, or make the outbox
 *    unrecoverable."
 *
 * Crashes are simulated through a DETERMINISTIC failpoint, never by killing the
 * runner — a killed worker proves nothing and can assert nothing afterwards.
 */
describe('Sync crash recovery (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let fx: SyncFixture;
  let token: string;
  let failpoint: SyncFailpoint;
  /** Arm a one-shot simulated process death after the given chunk commits. */
  const crashAfterChunk = (target: number): void => {
    failpoint.afterChunk = async (chunkIndex) => {
      if (chunkIndex !== target) return;
      failpoint.afterChunk = null;
      throw new Error('simulated process death after chunk commit');
    };
  };

  const seed = `x${Date.now()}`;

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    failpoint = app.get(SyncFailpoint);
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

  const auditCount = (entityId: string) =>
    prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
      tx.auditEntry.count({ where: { tenantId: fx.tenantId, entityId } }),
    );

  // ── A ─────────────────────────────────────────────────────────────────────
  it('A. reclaims a batch whose owner died before applying anything', async () => {
    const batchId = newId();
    const op = buildOperation(fx.node, { payload: { mode: 'audit' } });
    const batch = buildBatch(fx.terminalId, [op], batchId);

    // A reservation left behind by a process that died: `in_flight`, with a
    // lease that expired long ago and a response that was never written. Under
    // the shared IdempotencyService this shape is a permanent 409 — nothing
    // ever calls release() after a crash.
    const fingerprint = 'f'.repeat(64);
    await admin.syncBatch.create({
      data: {
        tenantId: fx.tenantId,
        batchId,
        terminalId: fx.terminalId,
        fingerprint,
        protocolVersion: 1,
        operationCount: 1,
        byteSize: 1,
        state: 'in_flight',
        leaseOwner: 'dead-worker:1',
        leaseExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
        attempt: 1,
      },
    });

    // The client retries the identical batch. A different fingerprint from the
    // stale row is a client defect (409) — so first correct the stale row's
    // fingerprint to the one this body really hashes to, then retry.
    await post(batch).expect(409);
    const real = await computeFingerprintOf(batch);
    await admin.syncBatch.update({
      where: { tenantId_batchId: { tenantId: fx.tenantId, batchId } },
      data: { fingerprint: real },
    });

    const res = await post(batch).expect(200);
    expect(byOpId(res.body as BatchResultView).get(op.opId)?.status).toBe(
      'accepted',
    );
    expect(await auditCount(op.entityId)).toBe(1);

    const row = await admin.syncBatch.findUnique({
      where: { tenantId_batchId: { tenantId: fx.tenantId, batchId } },
    });
    expect(row?.state).toBe('completed');
    // The reclaim is visible and counted, not silent.
    expect(row?.attempt).toBe(2);
    expect(row?.leaseOwner).toBeNull();
  });

  // ── B ─────────────────────────────────────────────────────────────────────
  it('B. resumes a batch that died after some operations had committed', async () => {
    // Two chunks' worth, so the failpoint can kill the process between them.
    const total = SYNC_DEFAULT_CHUNK_SIZE + 5;
    const ops = Array.from({ length: total }, (_, i) =>
      buildOperation(fx.node, {
        logical: i,
        payload: { mode: 'audit', note: `b-${i}` },
      }),
    );
    const batch = buildBatch(fx.terminalId, ops, newId());

    crashAfterChunk(0);
    await post(batch).expect(500);

    // The first chunk really did commit: its effects are on disk.
    const committed = await Promise.all(
      ops.slice(0, SYNC_DEFAULT_CHUNK_SIZE).map((o) => auditCount(o.entityId)),
    );
    expect(committed.every((c) => c === 1)).toBe(true);
    // The rest never ran.
    const untouched = await Promise.all(
      ops.slice(SYNC_DEFAULT_CHUNK_SIZE).map((o) => auditCount(o.entityId)),
    );
    expect(untouched.every((c) => c === 0)).toBe(true);

    // The lease was given up on a handled failure, so the retry reclaims at
    // once rather than waiting the lease out.
    const midway = await admin.syncBatch.findUnique({
      where: {
        tenantId_batchId: { tenantId: fx.tenantId, batchId: batch.batchId },
      },
    });
    expect(midway?.state).toBe('in_flight');
    expect(midway!.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());

    // THE CLIENT RETRIES THE IDENTICAL BATCH — same batchId, same opIds. No
    // new operation ids are invented merely because the server crashed.
    const res = await post(batch).expect(200);
    const results = byOpId(res.body as BatchResultView);

    for (const [i, op] of ops.entries()) {
      const r = results.get(op.opId);
      // Already-applied operations answer `duplicate`; the remainder process
      // normally. Both are DEFINITIVE, so the client can clear its outbox.
      expect(r?.status).toBe(
        i < SYNC_DEFAULT_CHUNK_SIZE ? 'duplicate' : 'accepted',
      );
      expect(r?.definitive).toBe(true);
    }

    // NO DUPLICATE BUSINESS EFFECT — the invariant this whole suite exists for.
    const finalCounts = await Promise.all(
      ops.map((o) => auditCount(o.entityId)),
    );
    expect(finalCounts).toEqual(ops.map(() => 1));
  }, 60_000);

  // ── C ─────────────────────────────────────────────────────────────────────
  it('C. 409s the same batchId submitted with a different body', async () => {
    const batchId = newId();
    await post(
      buildBatch(fx.terminalId, [buildOperation(fx.node)], batchId),
    ).expect(200);
    await post(
      buildBatch(fx.terminalId, [buildOperation(fx.node)], batchId),
    ).expect(409);
  });

  // ── D ─────────────────────────────────────────────────────────────────────
  it('D. a live owner is not stolen from by a concurrent duplicate', async () => {
    const batchId = newId();
    const op = buildOperation(fx.node, { payload: { mode: 'audit' } });
    const batch = buildBatch(fx.terminalId, [op], batchId);

    const [a, b] = await Promise.all([post(batch), post(batch)]);
    const codes = [a.status, b.status].sort();
    // Exactly one processes; the other is refused rather than racing it.
    expect(codes).toEqual([200, 409]);
    expect(await auditCount(op.entityId)).toBe(1);
  });

  it('never leaves a valid batch permanently trapped at 409', async () => {
    // The precise failure Correction 2 names. After a simulated death the very
    // next retry must succeed — no manual intervention, no new batchId.
    const op = buildOperation(fx.node, { payload: { mode: 'audit' } });
    const batch = buildBatch(fx.terminalId, [op], newId());
    crashAfterChunk(0);
    await post(batch).expect(500);
    await post(batch).expect(200);
    expect(await auditCount(op.entityId)).toBe(1);
  });

  /** Recompute the server's batch fingerprint the same way the service does. */
  async function computeFingerprintOf(batch: unknown): Promise<string> {
    const { createHash } = await import('node:crypto');
    const canonical = (value: unknown): string => {
      if (value === null || value === undefined) return 'null';
      if (typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      const obj = value as Record<string, unknown>;
      return `{${Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
        .join(',')}}`;
    };
    const b = batch as {
      deviceId: string;
      batchId: string;
      protocolVersion: number;
      lastServerCursor: string | null;
      operations: unknown[];
    };
    return createHash('sha256')
      .update(
        canonical({
          deviceId: b.deviceId,
          batchId: b.batchId,
          protocolVersion: b.protocolVersion,
          lastServerCursor: b.lastServerCursor ?? null,
          operations: b.operations,
        }),
      )
      .digest('hex');
  }
});
