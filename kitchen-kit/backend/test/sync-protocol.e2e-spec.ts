import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { applyApiVersioning } from './../src/common/http/api-versioning';
import { applySyncBodyLimit } from './../src/modules/sync/sync.bootstrap';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { SYNC_MAX_OPERATION_BYTES } from './../src/modules/sync/protocol/protocol.constants';
import { createMigratorClient } from './rls-admin';
import {
  BatchResultView,
  SYNC_BATCH_PATH,
  SyncFixture,
  SyncProtocolProbeHandler,
  buildBatch,
  buildOperation,
  byOpId,
  createSyncFixture,
  destroySyncFixture,
  hlcOf,
  terminalToken,
} from './sync-fixtures';

/**
 * D4-1A protocol kernel — envelope, authentication, limits, HLC/skew and the
 * FR-OFF-015 "the server never remaps an identifier" guarantee.
 */
describe('Sync protocol kernel (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let fx: SyncFixture;
  let token: string;

  const seed = `p${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      providers: [SyncProtocolProbeHandler],
    }).compile();
    app = moduleFixture.createNestApplication();
    applyApiVersioning(app);
    applySyncBodyLimit(app);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    fx = await createSyncFixture(app, admin, seed);
    token = await terminalToken(http, fx, fx.terminalId);
  }, 60_000);

  afterAll(async () => {
    await destroySyncFixture(admin, fx);
    await admin.$disconnect();
    await app.close();
  });

  const post = (body: unknown, bearer = token) =>
    request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .send(body as object);

  // ───────────────────────────────────────────────────── canonical versioning
  describe('canonical versioned route (Correction 5)', () => {
    it('serves the batch endpoint at /v1/sync/batch', async () => {
      const batch = buildBatch(fx.terminalId, [buildOperation(fx.node)]);
      await post(batch).expect(200);
    });

    it('does NOT serve it at the unversioned path — no silent fallback', async () => {
      const batch = buildBatch(fx.terminalId, [buildOperation(fx.node)]);
      await request(http)
        .post('/sync/batch')
        .set('Authorization', `Bearer ${token}`)
        .send(batch)
        .expect(404);
    });

    it('leaves pre-existing unversioned routes exactly where they were', async () => {
      // The narrow VERSION_NEUTRAL mechanism must not have moved anything else.
      await request(http).get('/health').expect(200);
      await request(http).post('/auth/login').send({}).expect(400);
    });
  });

  // ───────────────────────────────────────────────────────── authentication
  describe('authentication and terminal binding', () => {
    it('401s without a token', async () => {
      await request(http)
        .post(SYNC_BATCH_PATH)
        .send(buildBatch(fx.terminalId, [buildOperation(fx.node)]))
        .expect(401);
    });

    it('403s when deviceId is not the authenticated terminal', async () => {
      const batch = buildBatch(fx.terminal2Id, [buildOperation(fx.node)]);
      const res = await post(batch).expect(403);
      expect(JSON.stringify(res.body)).toMatch(/deviceId/i);
    });

    it('403s a revoked terminal, and does not touch its unsynced backlog', async () => {
      // GD-D1-07 was REJECTED: refusing ordinary sync is a security outcome,
      // NOT a licence to lose committed sales. `SyncTerminalGuard` (D4-1A)
      // carries that guarantee in its own message ("NOT discarded ... the
      // separately authorised lossless recovery path"), but MW1B integration
      // (§8) found that B1-2's `TenantContextGuard` — which every POS-bound
      // request now passes through FIRST to resolve tenant/branch context —
      // already denies a revoked terminal itself, with its own deliberately
      // GENERIC message (`TenantContextService.resolvePosBranch`'s anti-
      // enumeration design: a POS session must not be able to probe which of
      // several live conditions it failed). `SyncTerminalGuard`'s specific
      // wording is consequently unreachable via this exact request shape.
      // Neither guard is weakened by this — both are individually correct —
      // and the ratified GD-D1-07 DATA guarantee (no committed-sale loss) is
      // unaffected: a 403 here writes nothing and deletes nothing, proven
      // below by an unchanged row count. Reconciling the wording is left to
      // B1-3 (route-wide scope conversion) or a dedicated governance
      // decision — recorded as an open item in the MW1B integration report,
      // not resolved unilaterally by this test.
      const revokedToken = await terminalToken(http, fx, fx.terminalId);
      const dedupCountBefore = await admin.syncOperationDedup.count({
        where: { tenantId: fx.tenantId },
      });
      await admin.terminal.update({
        where: { id: fx.terminalId },
        data: { status: 'revoked' },
      });
      try {
        await post(
          buildBatch(fx.terminalId, [buildOperation(fx.node)]),
          revokedToken,
        ).expect(403);
        const dedupCountAfter = await admin.syncOperationDedup.count({
          where: { tenantId: fx.tenantId },
        });
        expect(dedupCountAfter).toBe(dedupCountBefore);
      } finally {
        await admin.terminal.update({
          where: { id: fx.terminalId },
          data: { status: 'active' },
        });
      }
    });
  });

  // ──────────────────────────────────────────────────────── strict envelope
  describe('strict envelope (no silent field discard)', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['tenantId in the body', { tenantId: newId() }],
      ['branchId in the body', { branchId: newId() }],
      ['a client-supplied fingerprint', { fingerprint: 'a'.repeat(64) }],
      ['an unknown envelope field', { somethingNew: true }],
    ];
    for (const [label, extra] of cases) {
      it(`rejects ${label} with 400 rather than stripping it`, async () => {
        const batch = {
          ...buildBatch(fx.terminalId, [buildOperation(fx.node)]),
          ...extra,
        };
        await post(batch).expect(400);
      });
    }

    it('rejects an unknown field inside an operation', async () => {
      const op = { ...buildOperation(fx.node), clientSeq: 7 };
      await post(buildBatch(fx.terminalId, [op])).expect(400);
    });

    it('rejects a malformed HLC', async () => {
      const op = { ...buildOperation(fx.node), hlc: '1722765753000.00000' };
      await post(buildBatch(fx.terminalId, [op])).expect(400);
    });

    it('rejects an uppercase HLC node — the canonical form is lowercase hex', async () => {
      const op = {
        ...buildOperation(fx.node),
        hlc: hlcOf(1_722_765_753_000, 0, fx.node.toUpperCase()),
      };
      await post(buildBatch(fx.terminalId, [op])).expect(400);
    });

    it('rejects a base32 ULID where a UUID-rendered id is required (GD-D1-01)', async () => {
      const op = {
        ...buildOperation(fx.node),
        opId: '01J8ZQK9V0000000000000000A',
      };
      await post(buildBatch(fx.terminalId, [op])).expect(400);
    });

    it('rejects an unsupported protocolVersion', async () => {
      const batch = {
        ...buildBatch(fx.terminalId, [buildOperation(fx.node)]),
        protocolVersion: 2,
      };
      await post(batch).expect(400);
    });

    it('rejects an empty batch', async () => {
      await post(buildBatch(fx.terminalId, [])).expect(400);
    });

    it('rejects more than 500 operations at the envelope level', async () => {
      const ops = Array.from({ length: 501 }, () => buildOperation(fx.node));
      await post(buildBatch(fx.terminalId, ops)).expect(400);
    });
  });

  // ──────────────────────────────────────────────────── per-operation limits
  describe('per-operation limits', () => {
    it('rejects ONE oversized operation without failing its batch', async () => {
      const fat = buildOperation(fx.node, {
        payload: { mode: 'noop', filler: 'x'.repeat(SYNC_MAX_OPERATION_BYTES) },
      });
      const slim = buildOperation(fx.node);
      const res = await post(buildBatch(fx.terminalId, [fat, slim])).expect(
        200,
      );
      const results = byOpId(res.body as BatchResultView);
      expect(results.get(fat.opId)?.status).toBe('rejected');
      expect(results.get(fat.opId)?.reasonCode).toBe('payload_too_large');
      // FR-OFF-023: one failing operation must not fail the batch.
      expect(results.get(slim.opId)?.status).toBe('accepted');
    });
  });

  // ────────────────────────────────────────────── results and definitiveness
  describe('per-operation results (FR-OFF-023 / FR-OFF-024)', () => {
    it('answers an unknown operation type deterministically', async () => {
      const op = buildOperation(fx.node, { type: 'nosuch.thing' });
      const res = await post(buildBatch(fx.terminalId, [op])).expect(200);
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('rejected');
      expect(r?.reasonCode).toBe('unknown_operation_type');
      expect(r?.definitive).toBe(true);
    });

    it('rejects an unsupported newer schemaVersion rather than coercing it', async () => {
      const op = buildOperation(fx.node, { schemaVersion: 99 });
      const res = await post(buildBatch(fx.terminalId, [op])).expect(200);
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.status).toBe('rejected');
      expect(r?.reasonCode).toBe('schema_version_unsupported');
    });

    it('marks exactly the four ratified statuses definitive', async () => {
      const ok = buildOperation(fx.node);
      const bad = buildOperation(fx.node, { type: 'nosuch.thing' });
      const orphan = buildOperation(fx.node, { causedBy: newId() });
      const res = await post(
        buildBatch(fx.terminalId, [ok, bad, orphan]),
      ).expect(200);
      const results = byOpId(res.body as BatchResultView);
      expect(results.get(ok.opId)).toMatchObject({
        status: 'accepted',
        definitive: true,
      });
      expect(results.get(bad.opId)).toMatchObject({
        status: 'rejected',
        definitive: true,
      });
      // deferred is the ratified FIFTH status and is NOT definitive: the client
      // must keep it in the outbox.
      expect(results.get(orphan.opId)).toMatchObject({
        status: 'deferred',
        definitive: false,
      });
    });

    it('isolates a throwing operation from its siblings in the same chunk', async () => {
      const before = buildOperation(fx.node, { logical: 1 });
      const boom = buildOperation(fx.node, {
        logical: 2,
        payload: { mode: 'throw' },
      });
      const after = buildOperation(fx.node, { logical: 3 });
      const res = await post(
        buildBatch(fx.terminalId, [before, boom, after]),
      ).expect(200);
      const results = byOpId(res.body as BatchResultView);
      expect(results.get(before.opId)?.status).toBe('accepted');
      expect(results.get(boom.opId)?.status).toBe('rejected');
      expect(results.get(boom.opId)?.reasonCode).toBe('handler_error');
      expect(results.get(after.opId)?.status).toBe('accepted');
    });

    it('rolls back the failing operation’s business effect but keeps its siblings’', async () => {
      const good = buildOperation(fx.node, {
        logical: 11,
        payload: { mode: 'audit', note: 'keep' },
      });
      const bad = buildOperation(fx.node, {
        logical: 12,
        payload: { mode: 'throw' },
      });
      await post(buildBatch(fx.terminalId, [good, bad])).expect(200);

      const audits = await prisma.withAuthContext(
        { tenantId: fx.tenantId },
        (tx) =>
          tx.auditEntry.findMany({
            where: { tenantId: fx.tenantId, entityId: good.entityId },
          }),
      );
      expect(audits).toHaveLength(1);
      const badAudits = await prisma.withAuthContext(
        { tenantId: fx.tenantId },
        (tx) =>
          tx.auditEntry.findMany({
            where: { tenantId: fx.tenantId, entityId: bad.entityId },
          }),
      );
      expect(badAudits).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────── FR-OFF-015 no remapping ever
  describe('FR-OFF-015 — the server never reassigns an identifier', () => {
    it('echoes back the exact opId and entityId the client chose', async () => {
      const op = buildOperation(fx.node, { payload: { mode: 'noop' } });
      const res = await post(buildBatch(fx.terminalId, [op])).expect(200);
      const r = byOpId(res.body as BatchResultView).get(op.opId);
      expect(r?.opId).toBe(op.opId);
      expect(r?.detail?.echoedEntityId).toBe(op.entityId);

      const stored = await prisma.withAuthContext(
        { tenantId: fx.tenantId },
        (tx) =>
          tx.syncOperation.findFirst({
            where: { tenantId: fx.tenantId, opId: op.opId },
          }),
      );
      expect(stored?.entityId).toBe(op.entityId);
      expect(stored?.opId).toBe(op.opId);
    });
  });

  // ──────────────────────────────────────────────── FR-OFF-042 clock skew
  describe('FR-OFF-042 clock skew', () => {
    it('records a healthy clock without raising an alert', async () => {
      const now = Date.now();
      const op = buildOperation(fx.node, { physicalMs: now });
      const res = await post(buildBatch(fx.terminalId, [op])).expect(200);
      const body = res.body as BatchResultView;
      expect(Math.abs(body.clockSkewMs)).toBeLessThan(5 * 60 * 1000);
      expect(body.clockSkewExceededThreshold).toBe(false);
    });

    it('CT-10 — detects a device three hours ahead, alerts, and keeps both timestamps', async () => {
      const t2 = await terminalToken(http, fx, fx.terminal2Id);
      const node2 = fx.node; // any valid node; the skew is in the physical field
      const deviceMs = Date.now() + 3 * 60 * 60 * 1000;
      const op = buildOperation(node2, { physicalMs: deviceMs });
      const res = await request(http)
        .post(SYNC_BATCH_PATH)
        .set('Authorization', `Bearer ${t2}`)
        .send(buildBatch(fx.terminal2Id, [op]))
        .expect(200);

      const body = res.body as BatchResultView;
      expect(body.clockSkewExceededThreshold).toBe(true);
      expect(body.clockSkewMs).toBeGreaterThan(3 * 60 * 60 * 1000 - 60_000);

      const state = await prisma.withAuthContext(
        { tenantId: fx.tenantId },
        (tx) =>
          tx.syncDeviceState.findUnique({
            where: {
              tenantId_terminalId: {
                tenantId: fx.tenantId,
                terminalId: fx.terminal2Id,
              },
            },
          }),
      );
      expect(state?.skewDetectedAt).not.toBeNull();
      // "alert" is an audit entry — there is no notification substrate, which
      // is exactly why FR-OFF-042 is reported PARTIAL rather than met.
      expect(state?.skewAlertedAt).not.toBeNull();

      // BOTH timestamps are preserved, and the received HLC is verbatim.
      const stored = await prisma.withAuthContext(
        { tenantId: fx.tenantId },
        (tx) =>
          tx.syncOperation.findFirst({
            where: { tenantId: fx.tenantId, opId: op.opId },
          }),
      );
      expect(stored?.hlc).toBe(op.hlc);
      expect(stored?.originDeviceTime.toISOString()).toBe(
        new Date(op.occurredAt).toISOString(),
      );
      expect(stored!.receivedAt.getTime()).toBeLessThan(
        stored!.originDeviceTime.getTime(),
      );

      const skewAudit = await prisma.withAuthContext(
        { tenantId: fx.tenantId },
        (tx) =>
          tx.auditEntry.findMany({
            where: {
              tenantId: fx.tenantId,
              action: 'SYNC_CLOCK_SKEW_DETECTED',
            },
          }),
      );
      expect(skewAudit.length).toBeGreaterThanOrEqual(1);
    });
  });
});
