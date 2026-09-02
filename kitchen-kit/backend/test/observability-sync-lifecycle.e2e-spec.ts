import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyApiVersioning } from './../src/common/http/api-versioning';
import { applySyncBodyLimit } from './../src/modules/sync/sync.bootstrap';
import { PrismaClient } from './../src/generated/prisma/client';
import { MetricsService } from './../src/common/observability/metrics/metrics.service';
import { newId } from './../src/common/ids';
import { createMigratorClient } from './rls-admin';
import {
  SYNC_BATCH_PATH,
  SyncFixture,
  SyncProtocolProbeHandler,
  buildBatch,
  buildOperation,
  createSyncFixture,
  destroySyncFixture,
  terminalToken,
} from './sync-fixtures';

/**
 * MW1D §8 — D4-1A's `POST /v1/sync/batch` must automatically gain
 * correlation context, structured completion logging and RED metrics
 * PURELY from the central `ObservabilityModule` wiring (global middleware/
 * guard/interceptor in `app.module.ts`) — zero Sync-specific observability
 * code. Proves the completion log/metric fires exactly once per HTTP
 * request (never once per operation inside a batch) across accepted,
 * revoked-terminal-denied and malformed paths, and that no
 * op_id/terminal id/tenant id/branch id/correlation id/batch id ever enters
 * a metric label (§6's bounded 4-label rule applies here too).
 */
describe('Observability × Sync automatic instrumentation (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;
  let admin: PrismaClient;
  let metrics: MetricsService;
  let fx: SyncFixture;
  let token: string;
  let stdoutSpy: jest.SpyInstance;
  let writtenLines: string[];

  const seed = `obssync${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      providers: [SyncProtocolProbeHandler],
    }).compile();
    app = moduleFixture.createNestApplication({ logger: false });
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
    metrics = app.get(MetricsService);
    fx = await createSyncFixture(app, admin, seed);
    token = await terminalToken(http, fx, fx.terminalId);
  }, 60_000);

  afterAll(async () => {
    await destroySyncFixture(admin, fx);
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(() => {
    writtenLines = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writtenLines.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  function completionLines(): Array<Record<string, unknown>> {
    return writtenLines
      .filter((l) => l.includes('"event":"http.request.completed"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('accepted sync batch: exactly one completion log, structured JSON, trusted tenant/branch, RED metric recorded', async () => {
    const opId = newId();
    const batchId = newId();
    const batch = buildBatch(
      fx.terminalId,
      [buildOperation(fx.node, { opId })],
      batchId,
    );
    await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(batch)
      .expect(200);

    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'http.request.completed',
      route: SYNC_BATCH_PATH,
      handler: 'SyncController#uploadBatch',
      statusCode: 200,
      statusClass: '2xx',
      tenantId: fx.tenantId,
    });
    expect(lines[0].correlationId).toBeDefined();
    // Zero Sync-specific identifiers appear in the completion log at all —
    // this is generic request-lifecycle metadata, not a batch/op audit trail.
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain(opId);
    expect(raw).not.toContain(batchId);

    const text = await metrics.metricsText();
    expect(text).toMatch(
      /http_requests_total\{method="POST",route="\/v1\/sync\/batch",handler="SyncController#uploadBatch",status_class="2xx"\} \d+/,
    );
    expect(text).not.toContain(opId);
    expect(text).not.toContain(batchId);
    expect(text).not.toContain(fx.terminalId);
    expect(text).not.toContain(fx.tenantId);
  });

  it('revoked terminal (403): exactly one completion log, no batch/op/terminal id leaked into metric labels', async () => {
    const revokedToken = await terminalToken(http, fx, fx.terminalId);
    await admin.terminal.update({
      where: { id: fx.terminalId },
      data: { status: 'revoked' },
    });
    // The login/token exchange above is itself an observed HTTP request —
    // reset the capture so this assertion is scoped to the batch POST alone.
    writtenLines = [];
    try {
      const opId = newId();
      const batchId = newId();
      const batch = buildBatch(
        fx.terminalId,
        [buildOperation(fx.node, { opId })],
        batchId,
      );
      await request(http)
        .post(SYNC_BATCH_PATH)
        .set('Authorization', `Bearer ${revokedToken}`)
        .send(batch)
        .expect(403);

      const lines = completionLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        route: SYNC_BATCH_PATH,
        handler: 'SyncController#uploadBatch',
        statusCode: 403,
        statusClass: '4xx',
      });
      const raw = JSON.stringify(lines[0]);
      expect(raw).not.toContain(opId);
      expect(raw).not.toContain(batchId);
      expect(raw).not.toContain(fx.terminalId);

      const text = await metrics.metricsText();
      expect(text).not.toContain(opId);
      expect(text).not.toContain(batchId);
      expect(text).not.toContain(fx.terminalId);
    } finally {
      await admin.terminal.update({
        where: { id: fx.terminalId },
        data: { status: 'active' },
      });
    }
  });

  it('malformed sync request (400): exactly one completion log, no raw body leaked', async () => {
    await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({
        deviceId: fx.terminalId,
        notAValidEnvelope: true,
        secret: 'password=should-not-leak',
      })
      .expect(400);

    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      route: SYNC_BATCH_PATH,
      handler: 'SyncController#uploadBatch',
      statusCode: 400,
      statusClass: '4xx',
    });
    expect(JSON.stringify(lines[0])).not.toContain('should-not-leak');
  });

  it('duplicate/replay batch: completion log fires ONCE PER HTTP REQUEST, never once per operation in the batch', async () => {
    const ops = Array.from({ length: 5 }, () =>
      buildOperation(fx.node, { opId: newId() }),
    );
    const batch = buildBatch(fx.terminalId, ops, newId());

    await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(batch)
      .expect(200);
    expect(completionLines()).toHaveLength(1);

    writtenLines = [];
    // Verbatim replay of the same batch — still exactly one completion log
    // for this second HTTP request, not five (one per operation) and not
    // zero (silently swallowed).
    await request(http)
      .post(SYNC_BATCH_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(batch)
      .expect(200);
    expect(completionLines()).toHaveLength(1);
  });
});
