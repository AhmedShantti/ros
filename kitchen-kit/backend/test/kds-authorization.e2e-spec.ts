import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { createMigratorClient } from './rls-admin';
import {
  createKdsFixture,
  dashboardTerminalToken,
  fireTicketLine,
  KdsFixture,
  pinLogin,
} from './kds-fixtures';

/**
 * KDS operator-lifecycle authorization matrix — design gate §26/§30,
 * acceptance correction §3.3/§4.
 *
 * ── CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13) ────────────────────
 * Rewritten for the new model: KDS is a branch/employee-scoped application
 * SESSION (PIN login, `sessionType: 'kds'`), not a registered device
 * identity. There is no terminal surface to check (active/kds-type), no
 * terminal->station binding to derive a station from, and no "exactly one
 * station" cardinality rule — `KdsStationGuard` instead requires the caller
 * to name its station explicitly (path or `?stationId=` query) and merely
 * proves that station belongs to the session's own LIVE-verified branch.
 * Several original test cases had no remaining referent (terminal status,
 * terminal->station cardinality) and are replaced below with tests of the
 * genuinely new invariants (explicit stationId requirement, branch-match
 * check, disjoint pos/kds audiences, multi-session station sharing) rather
 * than being silently dropped — see the per-test comments for the mapping.
 */
describe('KDS authorization (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const stamp = Date.now().toString(36);
  let fixtureA: KdsFixture;
  let fixtureB: KdsFixture;
  const businessDay = new Date('2026-08-30T00:00:00.000Z');

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

    fixtureA = await createKdsFixture(app, admin, `${stamp}a`);
    fixtureB = await createKdsFixture(app, admin, `${stamp}b`);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function kdsLogin(fixture: KdsFixture): Promise<string> {
    return pinLogin(
      http,
      fixture.tenantId,
      fixture.branchId,
      fixture.employeeCode,
      fixture.pin,
      'kds',
    );
  }

  let orderCounter = 0;
  async function makeTicket() {
    orderCounter += 1;
    return fireTicketLine(admin, {
      tenantId: fixtureA.tenantId,
      branchId: fixtureA.branchId,
      stationId: fixtureA.stationGrillId,
      businessDay,
      orderNumber: `AUTH-${stamp}-${orderCounter}`,
      terminalId: fixtureA.posTerminalId,
      openedBy: fixtureA.employeeId,
    });
  }

  it('POSITIVE: KDS PIN session, kds.operate, station in own branch -> queue read succeeds', async () => {
    const token = await kdsLogin(fixtureA);
    const res = await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toHaveProperty('tickets');
    expect(res.body).toHaveProperty('recallWindowSeconds', 1800);
  });

  it('POSITIVE: the same session can view/bump a ticket at its own station (ticket-scoped routes require ?stationId=)', async () => {
    const token = await kdsLogin(fixtureA);
    const { ticketId, ticketLineId } = await makeTicket();

    await request(http)
      .post(`/kds/stations/${fixtureA.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketIds: [ticketId] })
      .expect(200);

    await request(http)
      .post(
        `/kds/tickets/${ticketId}/lines/${ticketLineId}/bump?stationId=${fixtureA.stationGrillId}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
  });

  it('POSITIVE: two independent KDS sessions may target the SAME station (device/session exclusivity is gone — replaces the old "terminal bound to exactly one station" cardinality tests)', async () => {
    const tokenX = await kdsLogin(fixtureA);
    const tokenY = await kdsLogin(fixtureA);

    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${tokenX}`)
      .expect(200);
    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${tokenY}`)
      .expect(200);
  });

  it('NEGATIVE: no kds.operate permission -> 403 (PermissionGuard runs before KdsStationGuard, so a plain dashboard-bound-terminal token still exercises it)', async () => {
    // A brand-new tenant user with a membership but no role at all. This
    // probe deliberately still goes through /auth/login -> /auth/tenant ->
    // /auth/terminal (unchanged endpoints, still valid for the Sync/offline
    // channel) rather than PIN login, because this user has no Employee
    // record to PIN-authenticate with; the resulting token carries no
    // sessionType, but PermissionGuard rejects it for missing kds.operate
    // before KdsStationGuard would ever get a chance to reject it for
    // sessionType too.
    const email = `no-kds.${stamp}@example.com`;
    const usersService = app.get(UsersService);
    const membershipsService = app.get(MembershipsService);
    const u = await usersService.createUser({
      email,
      password: 's3cure-passphrase',
      displayName: 'NoKds',
    });
    await membershipsService.grant(u.id, fixtureA.tenantId, 'active');
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password: 's3cure-passphrase' })
      .expect(200);
    const scoped = await request(http)
      .post('/auth/tenant')
      .set(
        'Authorization',
        `Bearer ${(login.body as { accessToken: string }).accessToken}`,
      )
      .send({ tenantId: fixtureA.tenantId })
      .expect(200);
    const bind = await request(http)
      .post('/auth/terminal')
      .set(
        'Authorization',
        `Bearer ${(scoped.body as { accessToken: string }).accessToken}`,
      )
      .send({ terminalId: fixtureA.kdsTerminalId })
      .expect(200);
    const token = (bind.body as { accessToken: string }).accessToken;

    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: dashboard session (kds.operate granted, but no KDS session type) -> 403', async () => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email: fixtureA.dashboardEmail, password: 's3cure-passphrase' })
      .expect(200);
    const scoped = await request(http)
      .post('/auth/tenant')
      .set(
        'Authorization',
        `Bearer ${(login.body as { accessToken: string }).accessToken}`,
      )
      .send({ tenantId: fixtureA.tenantId })
      .expect(200);
    const token = (scoped.body as { accessToken: string }).accessToken;

    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: a PIN session with sessionType "pos" -> 403 at a KDS route (pos/kds are disjoint audiences — replaces the old "PIN session on a POS terminal" case, since terminal type no longer plays any role)', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.branchId,
      fixtureA.employeeCode,
      fixtureA.pin,
      'pos',
    );
    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: PIN login with an unsupported sessionType -> 400 (replaces the old "PIN session on a kiosk terminal" case — there is no third session audience any more, only pos/kds, enforced by DTO validation at login itself)', async () => {
    await request(http)
      .post('/auth/pin')
      .send({
        tenantId: fixtureA.tenantId,
        branchId: fixtureA.branchId,
        employeeCode: fixtureA.employeeCode,
        pin: fixtureA.pin,
        sessionType: 'kiosk',
      })
      .expect(400);
  });

  it('NEGATIVE: a station in a DIFFERENT branch of the SAME tenant -> 403 (KdsStationGuard branch-match check — replaces the old terminal->station-cardinality tests, which no longer have a referent)', async () => {
    const brand = await admin.brand.create({
      data: { id: newId(), tenantId: fixtureA.tenantId, name: `Other Brand ${stamp}` },
    });
    const otherBranch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId: fixtureA.tenantId,
        brandId: brand.id,
        code: `X${stamp.slice(-6)}`,
        name: `Other Branch ${stamp}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    const otherStation = await admin.station.create({
      data: { id: newId(), branchId: otherBranch.id, name: `Other-${stamp}` },
    });

    const token = await kdsLogin(fixtureA);
    await request(http)
      .get(`/kds/stations/${otherStation.id}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: ticket-scoped mutation with no ?stationId= query param -> 403 (new explicit requirement — no device binding derives it any more)', async () => {
    const token = await kdsLogin(fixtureA);
    const { ticketId, ticketLineId } = await makeTicket();
    await request(http)
      .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(403);
  });

  it('POSITIVE: a DIFFERENT station in the session\'s own branch also succeeds (replaces the old "supplied stationId does not match the terminal-derived station -> 403" case: there is no single terminal-derived station any more, only a branch-match check — see the separate cross-branch 403 case above for what the guard actually still rejects)', async () => {
    const token = await kdsLogin(fixtureA);
    await request(http)
      .get(`/kds/stations/${fixtureA.stationPackagingId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('NEGATIVE: a session whose employee has since lost the branch permission -> 403 (re-checked live, per request, not only at login — replaces the old "disabled/revoked terminal" cases, since terminal status is no longer part of the KDS runtime path)', async () => {
    const token = await kdsLogin(fixtureA);
    await admin.employeeBranch.deleteMany({
      where: { employeeId: fixtureA.employeeId, branchId: fixtureA.branchId },
    });
    try {
      await request(http)
        .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      await admin.employeeBranch.create({
        data: {
          tenantId: fixtureA.tenantId,
          employeeId: fixtureA.employeeId,
          branchId: fixtureA.branchId,
        },
      });
    }
  });

  it('NEGATIVE: a dashboard-bound-terminal session (no employee identity, no KDS session type) -> 403 on BOTH read and mutation (CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0: a KDS session can now ONLY be PIN-issued, which always carries an employee identity — the old "terminal-bound dashboard session reaches KDS, but mutations need an employee" scenario is impossible to construct any more; this token is refused outright, including for the read)', async () => {
    const token = await dashboardTerminalToken(
      http,
      fixtureA.dashboardEmail,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
    );

    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    const { ticketId } = await makeTicket();
    await request(http)
      .post(`/kds/stations/${fixtureA.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketIds: [ticketId] })
      .expect(403);
  });

  it('NEGATIVE: cross-tenant ticket -> tenant-safe 404, not 403 (never discloses existence)', async () => {
    const tokenA = await kdsLogin(fixtureA);
    const ticketB = await fireTicketLine(admin, {
      tenantId: fixtureB.tenantId,
      branchId: fixtureB.branchId,
      stationId: fixtureB.stationGrillId,
      businessDay,
      orderNumber: `AUTHB-${newId().slice(0, 8)}`,
      terminalId: fixtureB.posTerminalId,
      openedBy: fixtureB.employeeId,
    });

    await request(http)
      .post(
        `/kds/tickets/${ticketB.ticketId}/lines/${ticketB.ticketLineId}/bump?stationId=${fixtureA.stationGrillId}`,
      )
      .set('Authorization', `Bearer ${tokenA}`)
      .send({})
      .expect(404);
  });

  it('tenant isolation and station authorization are independent layers: same-tenant WRONG station is 403, not 404', async () => {
    const token = await kdsLogin(fixtureA);
    const ticketOnPackaging = await fireTicketLine(admin, {
      tenantId: fixtureA.tenantId,
      branchId: fixtureA.branchId,
      stationId: fixtureA.stationPackagingId,
      businessDay,
      orderNumber: `AUTHP-${newId().slice(0, 8)}`,
      terminalId: fixtureA.posTerminalId,
      openedBy: fixtureA.employeeId,
    });

    await request(http)
      .post(
        `/kds/tickets/${ticketOnPackaging.ticketId}/lines/${ticketOnPackaging.ticketLineId}/bump?stationId=${fixtureA.stationGrillId}`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(403);
  });
});
