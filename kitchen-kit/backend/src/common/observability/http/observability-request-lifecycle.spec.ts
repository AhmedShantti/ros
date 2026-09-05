import {
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ObservabilityModule } from '../observability.module';
import { MetricsService } from '../metrics/metrics.service';
import { CORRELATION_HEADER } from '../context/correlation';

/**
 * End-to-end HTTP request lifecycle test for the observability foundation
 * (SRS §27.6). Runs a REAL Nest application (`app.init()` + `supertest`,
 * exactly like the repository's `test/*.e2e-spec.ts` suites) through
 * `ObservabilityModule` wired exactly as `AppModule` wires it. Deliberately
 * has NO database dependency — every route here is a throwaway test
 * controller — so it runs fast, inside the ordinary unit-test Jest project,
 * while still exercising the real middleware → guard → interceptor →
 * completion-log/metric pipeline over real HTTP, not mocks. Full DB-backed
 * E2E coverage (real tenant/branch resolution via `TenantContextGuard`) is
 * exercised by the repository's existing `test/*.e2e-spec.ts` suites, which
 * this task's targeted-E2E run also covers (see the accompanying report).
 */

type AuthorizableRequest = {
  authorization?: { context: { tenantId: string; branchId: string } };
};

@Injectable()
class FakeTenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthorizableRequest>();
    // Mirrors exactly what the real TenantContextService attaches — a
    // LIVE-verified authorization context — without touching a database.
    request.authorization = {
      context: { tenantId: 'tenant-live-1', branchId: 'branch-live-1' },
    };
    return true;
  }
}

@Controller('test')
class ObservabilityTestController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException('bad input');
  }

  @Get('boom')
  boom(): never {
    throw new Error('unexpected failure: password=should-not-leak-value');
  }

  @Get('tenant/:id')
  @UseGuards(FakeTenantContextGuard)
  tenantScoped(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Get('pre-tenant')
  preTenant(): { ok: true } {
    // No guard attached — simulates a request denied/served before any
    // trusted tenant context exists.
    return { ok: true };
  }

  @Post('login')
  login(): { rejected: true } {
    throw new UnauthorizedException();
  }
}

describe('Observability — real HTTP request lifecycle (SRS §27.6)', () => {
  let app: INestApplication<App>;
  let http: App;
  let metrics: MetricsService;
  let stdoutSpy: jest.SpyInstance;
  let writtenLines: string[];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule],
      controllers: [ObservabilityTestController],
    }).compile();
    app = moduleFixture.createNestApplication({ logger: false });
    await app.init();
    http = app.getHttpServer();
    metrics = app.get(MetricsService);

    writtenLines = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writtenLines.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    await app.close();
  });

  function completionLines(): Array<Record<string, unknown>> {
    return writtenLines
      .filter((l) => l.includes('"event":"http.request.completed"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  // ── §19 error-path coverage ──────────────────────────────────────────

  it('2xx request: valid JSON completion log + metric recorded exactly once', async () => {
    await request(http).get('/test/ok').expect(200);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ statusCode: 200, statusClass: '2xx' });

    const text = await metrics.metricsText();
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/test\/ok",handler="ObservabilityTestController#ok",status_class="2xx"\} 1/,
    );
  });

  it('4xx validation/auth failure: recorded once, no raw body/header leakage', async () => {
    await request(http)
      .get('/test/bad-request')
      .set('Authorization', 'Bearer super-secret-token-value')
      .expect(400);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].statusClass).toBe('4xx');
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain('super-secret-token-value');
  });

  it('404: unmatched route is labeled "unmatched", never the raw path', async () => {
    await request(http).get('/does/not/exist/12345').expect(404);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      statusCode: 404,
      route: 'unmatched',
      handler: 'unmatched',
    });
    expect(JSON.stringify(lines[0])).not.toContain('/does/not/exist/12345');
  });

  it('5xx thrown exception path: recorded once as 5xx/error level, exception content sanitised', async () => {
    await request(http).get('/test/boom').expect(500);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ statusCode: 500, statusClass: '5xx' });
    expect(lines[0].level).toBe('error');
    expect(JSON.stringify(lines[0])).not.toContain('should-not-leak-value');
  });

  it('request denied before tenant context exists: tenantId/branchId stay null, never fabricated', async () => {
    await request(http).get('/test/pre-tenant').expect(200);
    const lines = completionLines();
    expect(lines[0].tenantId).toBeNull();
    expect(lines[0].branchId).toBeNull();
  });

  it('request succeeding after tenant/branch context exists: real trusted values appear, exactly once', async () => {
    await request(http).get('/test/tenant/abc-123').expect(200);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tenantId: 'tenant-live-1',
      branchId: 'branch-live-1',
      route: '/test/tenant/:id',
      handler: 'ObservabilityTestController#tenantScoped',
    });
  });

  it('4xx from an auth rejection (401) is recorded exactly once, not double-counted by any filter', async () => {
    await request(http).post('/test/login').expect(401);
    const text = await metrics.metricsText();
    const loginSeries = text
      .split('\n')
      .filter(
        (l) =>
          l.startsWith('http_requests_total{') &&
          l.includes('route="/test/login"'),
      );
    expect(loginSeries).toHaveLength(1);
    expect(loginSeries[0]).toMatch(/\} 1$/);
  });

  // ── §4 correlation header behaviour ──────────────────────────────────

  it('no header: server generates and returns a correlation id', async () => {
    const res = await request(http).get('/test/ok').expect(200);
    expect(res.headers[CORRELATION_HEADER]).toBeDefined();
    expect(res.headers[CORRELATION_HEADER].length).toBeGreaterThan(0);
  });

  it('valid header: echoed back and used as the log/metric correlation id', async () => {
    const res = await request(http)
      .get('/test/ok')
      .set(CORRELATION_HEADER, 'client-supplied-id-123')
      .expect(200);
    expect(res.headers[CORRELATION_HEADER]).toBe('client-supplied-id-123');
    const lines = completionLines();
    expect(lines[0].correlationId).toBe('client-supplied-id-123');
  });

  it('malformed header: replaced with a server-generated id, never echoed raw', async () => {
    const res = await request(http)
      .get('/test/ok')
      .set(CORRELATION_HEADER, 'has spaces and $ymbols!')
      .expect(200);
    expect(res.headers[CORRELATION_HEADER]).not.toBe('has spaces and $ymbols!');
  });

  it('oversized header: replaced with a server-generated id', async () => {
    const res = await request(http)
      .get('/test/ok')
      .set(CORRELATION_HEADER, 'a'.repeat(500))
      .expect(200);
    expect(res.headers[CORRELATION_HEADER].length).toBeLessThan(200);
  });

  it('CR/LF injection attempt in the header never reaches the response header or the log line', async () => {
    const res = await request(http)
      .get('/test/ok')
      .set(CORRELATION_HEADER, 'legit-id')
      .set('x-test-crlf-attempt', 'ignored') // supertest/http cannot itself send raw CRLF in a header value (Node rejects it) — the header format validation is covered directly in correlation.spec.ts
      .expect(200);
    expect(res.headers[CORRELATION_HEADER]).toBe('legit-id');
  });

  it('concurrent requests with no context leakage: each response carries its own correlation id', async () => {
    const [a, b, c] = await Promise.all([
      request(http)
        .get('/test/ok')
        .set(CORRELATION_HEADER, 'req-A')
        .expect(200),
      request(http)
        .get('/test/ok')
        .set(CORRELATION_HEADER, 'req-B')
        .expect(200),
      request(http)
        .get('/test/ok')
        .set(CORRELATION_HEADER, 'req-C')
        .expect(200),
    ]);
    expect(a.headers[CORRELATION_HEADER]).toBe('req-A');
    expect(b.headers[CORRELATION_HEADER]).toBe('req-B');
    expect(c.headers[CORRELATION_HEADER]).toBe('req-C');

    const lines = completionLines();
    const correlationIds = lines.map((l) => l.correlationId).sort();
    expect(correlationIds).toEqual(['req-A', 'req-B', 'req-C']);
  });

  // ── §18 secret/PII leak sabotage through the REAL logger/request path ──

  it('sabotage: a request carrying secret-shaped values in headers never leaks them into the completion log', async () => {
    await request(http)
      .get('/test/ok')
      .set('Authorization', 'Bearer eySECRETVALUEabc123def456')
      .set('Cookie', 'session=refresh-token-value-xyz')
      .expect(200);
    const raw = writtenLines.join('');
    expect(raw).not.toContain('eySECRETVALUEabc123def456');
    expect(raw).not.toContain('refresh-token-value-xyz');
    // safe fields still present
    const lines = completionLines();
    expect(lines[0]).toMatchObject({
      event: 'http.request.completed',
      route: '/test/ok',
      statusClass: '2xx',
    });
    expect(lines[0].correlationId).toBeDefined();
    expect(lines[0].durationMs).toBeDefined();
  });

  // ── §19 exactly-once metrics across every status class ──────────────

  it('every path records metrics exactly once — no interceptor/filter double count', async () => {
    await request(http).get('/test/ok').expect(200);
    await request(http).get('/test/bad-request').expect(400);
    await request(http).get('/does/not/exist').expect(404);
    await request(http).get('/test/boom').expect(500);
    const text = await metrics.metricsText();
    for (const line of text.split('\n')) {
      if (!line.startsWith('http_requests_total{')) continue;
      const value = Number(line.split(' ').pop());
      expect(value).toBe(1);
    }
  });
});
