import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  SYNC_DEFAULT_CHUNK_SIZE,
  SYNC_MAX_OPERATIONS_PER_BATCH,
} from './../src/modules/sync/protocol/protocol.constants';
import { createMigratorClient } from './rls-admin';
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
 * P-D4-01 — `NFR-PERF-032`: "The sync batch endpoint SHALL process 500
 * operations within 3 seconds at p95."
 *
 * Ratified as a MEASURED RELEASE GATE, not a future optimisation, and required
 * "during the earliest D4-1 implementation iteration" — the point being to
 * discover an unmeetable architecture before the protocol surface grows around
 * it, not after.
 *
 * TWO LAYERS ARE MEASURED SEPARATELY, because reporting only the cheaper one
 * would be a toy fast-path dressed up as a result:
 *
 *   A. KERNEL FLOOR — 500 valid operations through the whole kernel: envelope
 *      validation, HLC parse, causal scheduling, dedup writes, history writes,
 *      result persistence and the chunk commit strategy. The handler itself
 *      does no extra work.
 *
 *   B. REPRESENTATIVE — the same, plus a per-operation hash-chained audit
 *      append (the real per-tenant advisory-locked chain) and a conflict-lookup
 *      read against the history index.
 *
 * ── WHAT THIS DOES NOT PROVE ──────────────────────────────────────────────
 * Neither layer includes price resolution, tax computation, discount
 * distribution or loyalty accrual, because D4-1A has no domain handlers — those
 * arrive in D4-1B. `NFR-PERF-032` is therefore reported NOT YET FULLY VERIFIED,
 * and the D4-1A report says so rather than claiming the requirement.
 */
const ITERATIONS = Number(process.env.SYNC_BENCH_ITERATIONS ?? 20);

interface Stats {
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    p50: at(0.5),
    p95: at(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

describe('P-D4-01 — NFR-PERF-032 kernel benchmark (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let fx: SyncFixture;
  let token: string;

  const seed = `perf${Date.now()}`;
  const report: Record<string, Stats & { iterations: number }> = {};

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    fx = await createSyncFixture(app, admin, seed);
    token = await terminalToken(http, fx, fx.terminalId);
  }, 90_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log(
      '\nP-D4-01 NFR-PERF-032 — 500 operations per batch, milliseconds\n' +
        JSON.stringify(
          {
            batchSize: SYNC_MAX_OPERATIONS_PER_BATCH,
            chunkSize: SYNC_DEFAULT_CHUNK_SIZE,
            transactionStrategy:
              'chunk transaction, fast path (no savepoint, set-oriented settlement flush) ' +
              'falling back to SAVEPOINT-per-operation on any failure',
            dbTopology:
              'single local PostgreSQL 16 container, app role ros_app (RLS forced)',
            ...report,
          },
          null,
          2,
        ),
    );
    await destroySyncFixture(admin, fx);
    await admin.$disconnect();
    await app.close();
  });

  const runBatch = async (mode: 'noop' | 'audit'): Promise<number> => {
    const ops = Array.from({ length: SYNC_MAX_OPERATIONS_PER_BATCH }, (_, i) =>
      buildOperation(fx.node, {
        logical: i % 90_000,
        physicalMs: 1_722_765_753_000 + i,
        payload: { mode, note: `bench-${i}` },
      }),
    );
    const batch = buildBatch(fx.terminalId, ops, newId());
    const started = process.hrtime.bigint();
    const res = await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(batch);
    if (res.status !== 200) {
      // eslint-disable-next-line no-console
      console.log(
        'BENCH-FAILURE',
        res.status,
        JSON.stringify(res.body).slice(0, 600),
      );
    }
    expect(res.status).toBe(200);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    const body = res.body as BatchResultView;
    // A benchmark that silently measured 500 rejections would be worthless.
    expect(body.counts.accepted).toBe(SYNC_MAX_OPERATIONS_PER_BATCH);
    return elapsedMs;
  };

  it(`A. KERNEL FLOOR — ${SYNC_MAX_OPERATIONS_PER_BATCH} operations x ${ITERATIONS} iterations`, async () => {
    await runBatch('noop'); // warm the pool, the plan cache and the JIT
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1)
      samples.push(await runBatch('noop'));
    report.kernelFloor = { ...stats(samples), iterations: ITERATIONS };
    expect(samples).toHaveLength(ITERATIONS);
  }, 600_000);

  it(`B. REPRESENTATIVE — the same, plus audit chain and conflict lookup`, async () => {
    await runBatch('audit');
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1)
      samples.push(await runBatch('audit'));
    report.representative = { ...stats(samples), iterations: ITERATIONS };
    expect(samples).toHaveLength(ITERATIONS);
  }, 900_000);

  it('records the measured p95 against the 3 s budget', () => {
    // Deliberately NOT a hard failure: this run is a single local container,
    // not the reference environment NFR-PERF-032 is graded on, so failing the
    // build on it would be measuring the laptop. The numbers are recorded, and
    // the D4-1A report states them and what they do and do not establish.
    expect(report.kernelFloor).toBeDefined();
    expect(report.representative).toBeDefined();
    // eslint-disable-next-line no-console
    console.log(
      `kernel floor p95 = ${report.kernelFloor.p95.toFixed(0)} ms; ` +
        `representative p95 = ${report.representative.p95.toFixed(0)} ms; budget = 3000 ms`,
    );
  });
});
