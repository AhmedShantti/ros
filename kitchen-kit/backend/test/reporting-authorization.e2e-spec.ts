import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { REPORTING_PERMISSIONS } from './../src/modules/reporting/reporting.permissions';
import { createMigratorClient } from './rls-admin';
import { pinLogin } from './kds-fixtures';
import {
  createActiveBranch,
  createReportingFixture,
  dashboardToken,
  dateStr,
  setBranchStatus,
  setEmployeePin,
  ReportingFixture,
} from './reporting-fixtures';

/**
 * Minimum Operational Reporting authorization matrix — design gate §26/§39,
 * acceptance correction §8/§14 (branch fail-closed, in-transaction, D-2
 * untouched). Every check is independent and fail-closed.
 */
describe('Reporting authorization (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    admin = createMigratorClient(app);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  function url(branchId: string, businessDay: Date): string {
    return `/reports/branches/${branchId}/daily-trading/${dateStr(businessDay)}`;
  }

  it('POSITIVE: both permissions -> 200, Cache-Control: no-store', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}pos`);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toHaveProperty('branchId', fx.branchId);
    expect(res.body).toHaveProperty('periodStatus', 'OPEN');
  });

  it('NEGATIVE: report.view.sales only -> 403', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}sonly`, [
      REPORTING_PERMISSIONS.VIEW_SALES,
    ]);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: report.view.financial only -> 403 (confirms AND semantics)', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}fonly`, [
      REPORTING_PERMISSIONS.VIEW_FINANCIAL,
    ]);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: neither permission -> 403', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}none`, []);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: a PIN (POS) session is refused on this dashboard-only route', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}posdev`);
    await setEmployeePin(app, fx, '1234');
    const token = await pinLogin(
      http,
      fx.tenantId,
      fx.terminalId,
      fx.employeeCode,
      '1234',
    );
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: unknown branchId -> 404', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}unk`);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    const res = await request(http)
      .get(url('00000000-0000-4000-8000-000000000000', new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect((res.body as { message: string }).message).toBe('Branch not found.');
  });

  it('NEGATIVE: foreign-tenant branchId -> byte-identical 404', async () => {
    const fxA = await createReportingFixture(app, admin, `${stamp}fa`);
    const fxB = await createReportingFixture(app, admin, `${stamp}fb`);
    const tokenA = await dashboardToken(http, fxA.dashboardEmail, fxA.tenantId);

    const resForeign = await request(http)
      .get(url(fxB.branchId, new Date()))
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
    const resUnknown = await request(http)
      .get(url('00000000-0000-4000-8000-000000000000', new Date()))
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
    expect((resForeign.body as { message: string }).message).toBe(
      (resUnknown.body as { message: string }).message,
    );
    expect(resForeign.status).toBe(resUnknown.status);
  });

  it('NEGATIVE: zero active branches -> 403', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}zero`);
    await setBranchStatus(admin, fx.branchId, 'inactive');
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  /**
   * B1-3 §11 — THE INTERNAL-MVP SINGLE-ACTIVE-BRANCH MASK IS RETIRED.
   *
   * This test previously asserted the opposite: two active branches meant 403
   * for BOTH branch ids. That mask existed only because branch authorization did
   * not, and the ratified conditions for retiring it (clause 13 / ADR 0009 D-11)
   * are now met — the scoped model exists, this route carries a BRANCH target,
   * and an unreviewed inherited-grant tenant still fails closed (proven in the
   * test immediately below).
   *
   * A tenant-wide reader may now report on EITHER branch, and the reason it may
   * is the lattice, not the branch count.
   */
  it('two active branches: a TENANT-scoped reader may report on BOTH (mask retired)', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}two`);
    const secondBranchId = await createActiveBranch(
      admin,
      fx.tenantId,
      fx.brandId,
      `${stamp}two2`,
    );
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(http)
      .get(url(secondBranchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  /**
   * Limb C of the ratified retirement: the mask does NOT come off for a tenant
   * whose migration-inherited grants are still unreviewed. Those grants are
   * TENANT-scoped by construction, so they cover every branch — retiring the
   * mask for such a tenant would hand it reach nobody reviewed.
   */
  it('M-4+ GATE: an unreviewed migration-inherited grant fails closed, with an actionable message', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}m4`);
    // Re-stamp this tenant's assignments as migration-originated and unreviewed
    // — exactly the state the B1-2 backfill leaves behind.
    await admin.$executeRaw`
      UPDATE identity.membership_roles
         SET origin = 'migration', reviewed_at = NULL, reviewed_by = NULL
       WHERE tenant_id = ${fx.tenantId}::uuid`;
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);

    const res = await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect((res.body as { message: string }).message).toContain(
      'scopeReviewRequired',
    );

    // Reviewing clears it — WITHOUT changing the scope, which is M-4+ outcome A.
    await admin.$executeRaw`
      UPDATE identity.membership_roles
         SET reviewed_at = now(), reviewed_by = ${fx.dashboardUserId}::uuid
       WHERE tenant_id = ${fx.tenantId}::uuid`;
    const after = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${after}`)
      .expect(200);
  });

  it('ONE active branch: positive control still succeeds after the two-branch fixture is torn back down', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}ctrl`);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('NEGATIVE: an arbitrary query parameter -> 400', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}qp`);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(`${url(fx.branchId, new Date())}?foo=bar`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('NEGATIVE: missing/invalid bearer token -> 401', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}unauth`);
    await request(http).get(url(fx.branchId, new Date())).expect(401);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('NEGATIVE: no active tenant context (never selected a tenant) -> 403', async () => {
    const fx: ReportingFixture = await createReportingFixture(
      app,
      admin,
      `${stamp}notenant`,
    );
    const login = await request(http)
      .post('/auth/login')
      .send({
        email: fx.dashboardEmail,
        password: 's3cure-passphrase',
      })
      .expect(200);
    await request(http)
      .get(url(fx.branchId, new Date()))
      .set(
        'Authorization',
        `Bearer ${(login.body as { accessToken: string }).accessToken}`,
      )
      .expect(403);
  });

  it('NEGATIVE: malformed businessDay -> 400', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}badday`);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(`/reports/branches/${fx.branchId}/daily-trading/2026-13-40`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('NEGATIVE: malformed branchId -> 400', async () => {
    const fx = await createReportingFixture(app, admin, `${stamp}badid`);
    const token = await dashboardToken(http, fx.dashboardEmail, fx.tenantId);
    await request(http)
      .get(`/reports/branches/not-a-uuid/daily-trading/${dateStr(new Date())}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });
});
