import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
  Injectable,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ObservabilityModule } from '../observability.module';

/**
 * MW1D cross-lane integration finding (task §3): G1-3 enriches the
 * observability context with tenant/branch from an `APP_INTERCEPTOR`
 * (`TenantEnrichmentInterceptor`), and Nest never runs interceptors for a
 * request a guard denies. B1-3's real guard order on every protected route is
 * `JwtAuthGuard → TenantContextGuard → PermissionGuard`
 * (`modules/organisation/organisation.controller.ts` and siblings), all
 * plain Nest guards — so a `PermissionGuard` 403 previously left the
 * completion log's `tenantId`/`branchId` `null` even though
 * `TenantContextGuard` had already resolved and cached the trusted context at
 * `request.authorization` (`TenantContextService.require`, memoized — read
 * again, never re-derived, by `PermissionGuard` itself before it denies).
 *
 * `CorrelationMiddleware` now reads that same trusted, already-live-verified
 * `request.authorization` object at the single completion point, so it no
 * longer depends on the interceptor having run. This suite proves the fix
 * over a REAL Nest app + real HTTP (`supertest`), using fake guards that
 * mirror exactly what `TenantContextGuard`/`PermissionGuard` do to
 * `request.authorization` — no database dependency, matching the sibling
 * `observability-request-lifecycle.spec.ts` pattern.
 */

type AuthorizableRequest = {
  authorization?: { context: { tenantId: string; branchId?: string } };
};

@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  // Mirrors JwtAuthGuard denying BEFORE any tenant context exists at all.
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

@Injectable()
class FakeTenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthorizableRequest>();
    // Mirrors TenantContextService.require: resolved live, cached once at
    // request.authorization, for every downstream guard/handler to reuse.
    request.authorization = {
      context: {
        tenantId: 'tenant-trusted-live',
        branchId: 'branch-trusted-live',
      },
    };
    return true;
  }
}

@Injectable()
class FakeTenantContextGuardDashboard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthorizableRequest>();
    // Mirrors a dashboard actor: tenantId resolved, branchId genuinely absent
    // (TenantContext.branchId is undefined for non-POS sessions) — must never
    // be forced to a fabricated value.
    request.authorization = { context: { tenantId: 'tenant-trusted-live' } };
    return true;
  }
}

@Injectable()
class FakeDenyingPermissionGuard implements CanActivate {
  // Mirrors PermissionGuard: runs strictly AFTER TenantContextGuard in the
  // chain and denies with 403 — request.authorization is already populated
  // by the time this throws, exactly as in the real guard.
  canActivate(): boolean {
    throw new ForbiddenException('Insufficient permission for this scope.');
  }
}

@Controller('denied')
class DeniedRequestTestController {
  @Get('before-tenant')
  @UseGuards(FakeJwtAuthGuard)
  beforeTenant(): never {
    throw new Error('unreachable — FakeJwtAuthGuard always denies');
  }

  @Get('tenant/:tenantId')
  @UseGuards(FakeTenantContextGuard, FakeDenyingPermissionGuard)
  tenantThenDenied(): never {
    throw new Error('unreachable — FakeDenyingPermissionGuard always denies');
  }

  @Get('pos/:branchId')
  @UseGuards(FakeTenantContextGuard, FakeDenyingPermissionGuard)
  posThenDenied(): never {
    throw new Error('unreachable — FakeDenyingPermissionGuard always denies');
  }

  @Get('dashboard-no-branch')
  @UseGuards(FakeTenantContextGuardDashboard, FakeDenyingPermissionGuard)
  dashboardThenDenied(): never {
    throw new Error('unreachable — FakeDenyingPermissionGuard always denies');
  }
}

describe('Observability — B1-3 denied-request tenant/branch context (MW1D cross-lane fix)', () => {
  let app: INestApplication<App>;
  let http: App;
  let stdoutSpy: jest.SpyInstance;
  let writtenLines: string[];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), ObservabilityModule],
      controllers: [DeniedRequestTestController],
    }).compile();
    app = moduleFixture.createNestApplication({ logger: false });
    await app.init();
    http = app.getHttpServer();

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

  // ── A: denied before tenant resolution ──────────────────────────────
  it('A. request denied before tenant resolution (401): tenantId/branchId stay null', async () => {
    await request(http).get('/denied/before-tenant').expect(401);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      statusCode: 401,
      tenantId: null,
      branchId: null,
    });
  });

  // ── B: TenantContextGuard succeeds, PermissionGuard denies ──────────
  it('B. TenantContextGuard succeeds then PermissionGuard denies (403): tenantId is the trusted tenant id', async () => {
    await request(http).get('/denied/tenant/attacker-tenant-id').expect(403);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      statusCode: 403,
      tenantId: 'tenant-trusted-live',
    });
  });

  // ── C: POS live terminal branch resolved, then denied ───────────────
  it('C. POS request resolves live terminal branch then authorization denies: branchId is the trusted live branch id', async () => {
    await request(http).get('/denied/pos/attacker-branch-id').expect(403);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      statusCode: 403,
      tenantId: 'tenant-trusted-live',
      branchId: 'branch-trusted-live',
    });
  });

  it('a dashboard actor genuinely without an operating branch is never forced to a fabricated branchId, even on denial', async () => {
    await request(http).get('/denied/dashboard-no-branch').expect(403);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      statusCode: 403,
      tenantId: 'tenant-trusted-live',
      branchId: null,
    });
  });

  // ── D: attacker-supplied headers/body/query cannot affect either value ──
  it('D. attacker-supplied x-tenant-id/x-branch-id headers, body and query never reach the completion log', async () => {
    await request(http)
      .get('/denied/tenant/attacker-tenant-id')
      .query({
        tenantId: 'attacker-query-tenant',
        branchId: 'attacker-query-branch',
      })
      .set('x-tenant-id', 'attacker-header-tenant')
      .set('x-branch-id', 'attacker-header-branch')
      .send({
        tenantId: 'attacker-body-tenant',
        branchId: 'attacker-body-branch',
      })
      .expect(403);
    const lines = completionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].tenantId).toBe('tenant-trusted-live');
    expect(lines[0].branchId).toBe('branch-trusted-live');
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain('attacker-tenant-id');
    expect(raw).not.toContain('attacker-query-tenant');
    expect(raw).not.toContain('attacker-query-branch');
    expect(raw).not.toContain('attacker-header-tenant');
    expect(raw).not.toContain('attacker-header-branch');
    expect(raw).not.toContain('attacker-body-tenant');
    expect(raw).not.toContain('attacker-body-branch');
  });

  it('D2. attacker-supplied path segment (the route param itself) never overrides the trusted branchId', async () => {
    await request(http).get('/denied/pos/attacker-branch-id').expect(403);
    const lines = completionLines();
    expect(lines[0].branchId).toBe('branch-trusted-live');
    expect(JSON.stringify(lines[0])).not.toContain('attacker-branch-id');
  });

  it('exactly one completion log and no double-count on the denied path', async () => {
    await request(http).get('/denied/tenant/x').expect(403);
    expect(completionLines()).toHaveLength(1);
  });
});
