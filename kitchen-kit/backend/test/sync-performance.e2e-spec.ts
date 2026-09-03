import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { hlcNodeFromTerminalId } from './../src/modules/sync/hlc/hlc';
import {
  SYNC_DEFAULT_CHUNK_SIZE,
  SYNC_MAX_OPERATIONS_PER_BATCH,
} from './../src/modules/sync/protocol/protocol.constants';
import { createMigratorClient } from './rls-admin';
import { createKdsFixture, KdsFixture } from './kds-fixtures';
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

    console.log(
      `kernel floor p95 = ${report.kernelFloor.p95.toFixed(0)} ms; ` +
        `representative p95 = ${report.representative.p95.toFixed(0)} ms; budget = 3000 ms`,
    );
  });
});

/**
 * P-D4-02 — the PRODUCTION-HANDLER representative benchmark the D4-1A report
 * explicitly left unmeasured ("Neither layer includes ... those arrive in
 * D4-1B"). `protocol.probe`'s `audit` mode above already prices a
 * hash-chained audit append, but skips the one cost every real production
 * handler pays that the probe does not: `SYNC_AUTHORIZATION_PORT` — a live
 * `POS_ACTOR_AUTHORIZATION` resolution (employee + employeeBranch +
 * membership + role-permission reads) followed by `ScopeAuthorizationService
 * .isAuthorized`, per operation. `kds.ticket.bump_line` additionally does a
 * tenant-scoped ticket lookup for P-D4-01 §11 revalidation (server state
 * wins) before authorizing against the ticket's OWN branch.
 *
 * Iteration count is deliberately lower than the kernel benchmark's default:
 * each iteration needs `SYNC_MAX_OPERATIONS_PER_BATCH` FRESH ticket lines
 * (bump_line is a one-way transition), bulk-inserted rather than looped
 * through `fireTicketLine` so fixture setup itself does not dominate the
 * measurement.
 */
describe('P-D4-02 — NFR-PERF-032 production-handler benchmark (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let fixture: KdsFixture;
  let token: string;
  let node: string;

  const stamp = `perfprod${Date.now()}`;
  // order_number/order_number_snapshot are VARCHAR(24) — short and globally
  // monotonic across every createTicketLines() call in this describe block,
  // not reset per call, so batches from different iterations never collide.
  const orderSeed = Date.now().toString(36).slice(-6);
  let orderCounter = 0;
  const businessDay = new Date('2026-08-30T00:00:00.000Z');
  const PROD_ITERATIONS = Number(process.env.SYNC_BENCH_PROD_ITERATIONS ?? 5);
  const report: Record<string, Stats & { iterations: number }> = {};

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    fixture = await createKdsFixture(app, admin, stamp);
    token = await terminalToken(http, fixture, fixture.posTerminalId);
    node = hlcNodeFromTerminalId(fixture.posTerminalId);
  }, 90_000);

  afterAll(async () => {
    console.log(
      '\nP-D4-02 NFR-PERF-032 — production handler mix, milliseconds\n' +
        JSON.stringify(
          {
            batchSize: SYNC_MAX_OPERATIONS_PER_BATCH,
            iterations: PROD_ITERATIONS,
            handlers: ['kds.ticket.bump_line', 'kds.ticket.recall'],
            ...report,
          },
          null,
          2,
        ),
    );
    await admin.$disconnect();
    await app.close();
  });

  /**
   * Bulk-inserts `count` fresh, never-bumped ticket/line pairs, sharing ONE
   * menu item/variant/order across all of them — bump_line's revalidation
   * never reads those, and this benchmark is timing the SYNC path, not
   * catalogue fixture creation.
   */
  async function createTicketLines(
    count: number,
  ): Promise<{ ticketId: string; ticketLineId: string }[]> {
    const menuItemId = newId();
    await admin.menuItem.create({
      data: {
        id: menuItemId,
        tenantId: fixture.tenantId,
        names: { en: 'Bench' },
      },
    });
    const variantId = newId();
    await admin.menuItemVariant.create({
      data: {
        id: variantId,
        tenantId: fixture.tenantId,
        menuItemId,
        name: { en: 'Bench' },
      },
    });
    const now = new Date();

    const rows = Array.from({ length: count }, (_, i) => {
      const orderId = newId();
      const orderLineId = newId();
      const ticketId = newId();
      const ticketLineId = newId();
      const fireBatchId = newId();
      orderCounter += 1;
      // "B" + 6-char seed + counter — well under the VARCHAR(24) column limit
      // regardless of how large `orderCounter` grows across iterations.
      const orderNumber = `B${orderSeed}${orderCounter}`;
      return {
        orderId,
        orderLineId,
        ticketId,
        ticketLineId,
        fireBatchId,
        orderNumber,
        i,
      };
    });

    await admin.order.createMany({
      data: rows.map((r) => ({
        id: r.orderId,
        tenantId: fixture.tenantId,
        branchId: fixture.branchId,
        terminalId: fixture.posTerminalId,
        orderNumber: r.orderNumber,
        businessDay,
        orderType: 'dine_in',
        channel: 'pos',
        openedBy: fixture.employeeId,
        currency: 'EGP',
        openedAt: now,
        originDeviceTime: now,
        idempotencyKey: `idem-${r.orderId}`,
        countryPackVersion: 'v1',
      })),
    });
    await admin.orderLine.createMany({
      data: rows.map((r) => ({
        id: r.orderLineId,
        tenantId: fixture.tenantId,
        orderId: r.orderId,
        businessDay,
        sequence: 1,
        menuItemId,
        variantId,
        itemNameSnapshot: { en: 'Bench' },
        quantity: '1',
        unitPrice: 100n,
        lineSubtotal: 100n,
        taxClassId: newId(),
        lineTotal: 100n,
        state: 'fired',
        firedAt: now,
      })),
    });
    await admin.ticket.createMany({
      data: rows.map((r) => ({
        id: r.ticketId,
        tenantId: fixture.tenantId,
        branchId: fixture.branchId,
        businessDay,
        orderId: r.orderId,
        stationId: fixture.stationGrillId,
        orderNumberSnapshot: r.orderNumber,
        orderTypeSnapshot: 'dine_in',
        serviceReferenceSnapshot: 'Bench',
        createdAt: now,
        routedAt: now,
      })),
    });
    await admin.ticketFireBatch.createMany({
      data: rows.map((r) => ({
        id: r.fireBatchId,
        tenantId: fixture.tenantId,
        ticketId: r.ticketId,
        fireBatchId: newId(),
        firedAt: now,
      })),
    });
    await admin.ticketLine.createMany({
      data: rows.map((r) => ({
        id: r.ticketLineId,
        tenantId: fixture.tenantId,
        ticketId: r.ticketId,
        fireBatchRowId: r.fireBatchId,
        orderId: r.orderId,
        orderLineId: r.orderLineId,
        businessDay,
        itemNameSnapshot: { en: 'Bench' },
        quantity: '1',
        sequence: 1,
        createdAt: now,
        routedAt: now,
      })),
    });

    return rows.map((r) => ({
      ticketId: r.ticketId,
      ticketLineId: r.ticketLineId,
    }));
  }

  const runBumpBatch = async (
    lines: { ticketId: string; ticketLineId: string }[],
  ): Promise<number> => {
    const ops = lines.map((l, i) =>
      buildOperation(node, {
        logical: i % 90_000,
        type: 'kds.ticket.bump_line',
        entityId: l.ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: l.ticketLineId },
      }),
    );
    const batch = buildBatch(fixture.posTerminalId, ops, newId());
    const started = process.hrtime.bigint();
    const res = await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(batch);
    expect(res.status).toBe(200);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const body = res.body as BatchResultView;
    expect(body.counts.accepted).toBe(lines.length);
    return elapsedMs;
  };

  const runRecallConflictBatch = async (
    ticketIds: string[],
  ): Promise<number> => {
    const ops = ticketIds.map((ticketId, i) =>
      buildOperation(node, {
        logical: i % 90_000,
        type: 'kds.ticket.recall',
        entityId: ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: {},
      }),
    );
    const batch = buildBatch(fixture.posTerminalId, ops, newId());
    const started = process.hrtime.bigint();
    const res = await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(batch);
    expect(res.status).toBe(200);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const body = res.body as BatchResultView;
    // Every recall here is against a NEVER-bumped ticket: guaranteed
    // `conflict` outcomes, exercising the revalidation/conflict path.
    expect(body.counts.conflict).toBe(ticketIds.length);
    return elapsedMs;
  };

  it(`A. ALL-SUCCESS FAST PATH — kds.ticket.bump_line x ${SYNC_MAX_OPERATIONS_PER_BATCH} x ${PROD_ITERATIONS} iterations`, async () => {
    const samples: number[] = [];
    for (let i = 0; i < PROD_ITERATIONS; i += 1) {
      const lines = await createTicketLines(SYNC_MAX_OPERATIONS_PER_BATCH);
      samples.push(await runBumpBatch(lines));
    }
    report.allSuccessBumpLine = {
      ...stats(samples),
      iterations: PROD_ITERATIONS,
    };
    expect(samples).toHaveLength(PROD_ITERATIONS);
  }, 900_000);

  it(`B. MIXED CONFLICT/REVALIDATION PATH — kds.ticket.recall x ${SYNC_MAX_OPERATIONS_PER_BATCH} x ${PROD_ITERATIONS} iterations (every op a conflict)`, async () => {
    const samples: number[] = [];
    for (let i = 0; i < PROD_ITERATIONS; i += 1) {
      const lines = await createTicketLines(SYNC_MAX_OPERATIONS_PER_BATCH);
      samples.push(await runRecallConflictBatch(lines.map((l) => l.ticketId)));
    }
    report.conflictRecall = { ...stats(samples), iterations: PROD_ITERATIONS };
    expect(samples).toHaveLength(PROD_ITERATIONS);
  }, 900_000);

  it('C. DUPLICATE-HEAVY REPLAY — resubmitting an already-accepted production batch', async () => {
    const lines = await createTicketLines(SYNC_MAX_OPERATIONS_PER_BATCH);
    const ops = lines.map((l, i) =>
      buildOperation(node, {
        logical: i % 90_000,
        type: 'kds.ticket.bump_line',
        entityId: l.ticketId,
        actorEmployeeId: fixture.employeeId,
        payload: { lineId: l.ticketLineId },
      }),
    );
    const batch = buildBatch(fixture.posTerminalId, ops, newId());
    await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(batch)
      .expect(200);

    const samples: number[] = [];
    for (let i = 0; i < PROD_ITERATIONS; i += 1) {
      const started = process.hrtime.bigint();
      const res = await request(http)
        .post(SYNC_BATCH_PATH)
        .set('Authorization', `Bearer ${token}`)
        .send(batch);
      expect(res.status).toBe(200);
      expect((res.body as BatchResultView).replayed).toBe(true);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    report.duplicateReplay = { ...stats(samples), iterations: PROD_ITERATIONS };
    expect(samples).toHaveLength(PROD_ITERATIONS);
  }, 900_000);

  it('records the measured production-mix p95 against the 3 s budget', () => {
    expect(report.allSuccessBumpLine).toBeDefined();
    expect(report.conflictRecall).toBeDefined();
    expect(report.duplicateReplay).toBeDefined();

    console.log(
      `production all-success p95 = ${report.allSuccessBumpLine.p95.toFixed(0)} ms; ` +
        `conflict p95 = ${report.conflictRecall.p95.toFixed(0)} ms; ` +
        `duplicate-replay p95 = ${report.duplicateReplay.p95.toFixed(0)} ms; budget = 3000 ms`,
    );
  });
});
