import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { verifyAuditChain } from './../src/modules/governance/audit/audit-verify';
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
 * P-D4-02 — per-tenant audit hash-chain contention during CONCURRENT
 * multi-terminal backlog drains, ratified as a measured release gate.
 *
 * `governance.audit_entries` is hash-chained per tenant, with a per-tenant
 * transaction advisory lock serialising sequence allocation. When three
 * terminals of one tenant drain an outage simultaneously — `UC-OFF-01` produces
 * 1,204 audit events from a single branch's six hours — every audit append for
 * that tenant queues behind the same lock. This is the likeliest place
 * `NFR-PERF-032` fails under realistic recovery load, and it is a pre-existing
 * property of the audit design that the sync protocol merely exposes.
 *
 * What is asserted: no deadlock, no duplicate sequence number, an intact hash
 * chain, and a recorded throughput cost. The chain is NEVER weakened to make
 * the numbers look better.
 */
const OPS_PER_TERMINAL = Number(process.env.SYNC_CONTENTION_OPS ?? 100);

describe('P-D4-02 — audit chain contention under concurrent drain (e2e)', () => {
  let app: INestApplication;
  let http: App;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let fx: SyncFixture;
  const tokens: string[] = [];

  const seed = `cont${Date.now()}`;
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    app = await bootstrapSyncApp();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    fx = await createSyncFixture(app, admin, seed);
    for (const terminalId of [fx.terminalId, fx.terminal2Id, fx.terminal3Id]) {
      tokens.push(await terminalToken(http, fx, terminalId));
    }
  }, 90_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log(
      '\nP-D4-02 audit contention\n' + JSON.stringify(report, null, 2),
    );
    await destroySyncFixture(admin, fx);
    await admin.$disconnect();
    await app.close();
  });

  const drain = async (terminalId: string, token: string): Promise<number> => {
    const ops = Array.from({ length: OPS_PER_TERMINAL }, (_, i) =>
      buildOperation(fx.node, {
        logical: i,
        physicalMs: Date.now(),
        payload: { mode: 'audit', note: `${terminalId}-${i}` },
      }),
    );
    const started = process.hrtime.bigint();
    const res = await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(buildBatch(terminalId, ops, newId()))
      .expect(200);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    expect((res.body as BatchResultView).counts.accepted).toBe(
      OPS_PER_TERMINAL,
    );
    return elapsed;
  };

  it('one terminal draining alone — the baseline', async () => {
    const ms = await drain(fx.terminalId, tokens[0]);
    report.singleTerminalMs = Math.round(ms);
    report.opsPerTerminal = OPS_PER_TERMINAL;
  }, 300_000);

  it('three terminals of ONE tenant draining concurrently', async () => {
    const started = process.hrtime.bigint();
    const results = await Promise.all([
      drain(fx.terminalId, tokens[0]),
      drain(fx.terminal2Id, tokens[1]),
      drain(fx.terminal3Id, tokens[2]),
    ]);
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

    report.concurrentTerminals = 3;
    report.concurrentPerTerminalMs = results.map((r) => Math.round(r));
    report.concurrentWallMs = Math.round(wallMs);
    // Perfect serialisation would make wall time ~3x the single-terminal
    // baseline; perfect parallelism would make it ~1x. The ratio is the
    // measurement that matters, and it is REPORTED rather than asserted,
    // because a threshold tuned on a laptop would be measuring the laptop.
    report.serialisationRatio =
      Math.round((wallMs / (report.singleTerminalMs as number)) * 100) / 100;
  }, 600_000);

  it('allocated no duplicate audit sequence number', async () => {
    const rows = await prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: fx.tenantId },
        select: { sequenceNo: true },
        orderBy: { sequenceNo: 'asc' },
      }),
    );
    const seen = new Set(rows.map((r) => r.sequenceNo.toString()));
    expect(seen.size).toBe(rows.length);
    // Contiguous from 1: a gap would mean an allocation was lost, which the
    // chain could not detect on its own.
    expect(rows.map((r) => Number(r.sequenceNo))).toEqual(
      Array.from({ length: rows.length }, (_, i) => i + 1),
    );
    report.auditEntries = rows.length;
  }, 120_000);

  it('left the hash chain intact', async () => {
    const rows = await prisma.withAuthContext({ tenantId: fx.tenantId }, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: fx.tenantId },
        orderBy: { sequenceNo: 'asc' },
      }),
    );
    // The repository's own verifier, unmodified. Weakening the chain to make a
    // benchmark pass is explicitly forbidden by the ratification.
    const verdict = verifyAuditChain(
      rows as unknown as Parameters<typeof verifyAuditChain>[0],
    );
    expect(verdict).toEqual({ valid: true });
    report.chainVerified = verdict.valid;
    report.chainLength = rows.length;
  }, 120_000);

  it('did not deadlock or exhaust retries', async () => {
    // Every drain above ran to completion with a 200 and a full accepted
    // count; a deadlock or an exhausted retry loop would have surfaced as a
    // 500 there. Recorded explicitly so the gate has an assertion of its own.
    expect(report.concurrentPerTerminalMs).toHaveLength(3);
    expect(report.chainVerified).toBe(true);
  });
});
