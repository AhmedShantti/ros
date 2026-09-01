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
  setTerminalStatus,
} from './kds-fixtures';

/**
 * KDS operator-lifecycle authorization matrix — design gate §26/§30,
 * acceptance correction §3.3/§4. Every check is INDEPENDENT and fail-closed:
 * permission (`kds.operate`), terminal surface (active + `kds` type),
 * exactly-one-station binding, path-station equality, employee identity for
 * attributed mutations, and tenant isolation.
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

  it('POSITIVE: PIN session on an active KDS terminal, one bound station, kds.operate -> queue read succeeds', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    const res = await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toHaveProperty('tickets');
    expect(res.body).toHaveProperty('recallWindowSeconds', 1800);
  });

  it('POSITIVE: the same session can view/start/bump a ticket at its own station', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    const { ticketId, ticketLineId } = await makeTicket();

    await request(http)
      .post(`/kds/stations/${fixtureA.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketIds: [ticketId] })
      .expect(200);

    await request(http)
      .post(`/kds/tickets/${ticketId}/lines/${ticketLineId}/bump`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
  });

  it('NEGATIVE: no kds.operate permission -> 403', async () => {
    // A brand-new tenant user with a membership but no role at all.
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

  it('NEGATIVE: dashboard session with no terminal binding at all -> 403', async () => {
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

  it('NEGATIVE: PIN session on a POS terminal -> 403 (terminal surface must be kds, not the session label)', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.posTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: PIN session on a kiosk terminal -> 403', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kioskTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: a disabled KDS terminal -> 403 (checked per-request, not only at login)', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    await setTerminalStatus(admin, fixtureA.kdsTerminalId, 'disabled');
    try {
      await request(http)
        .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      await setTerminalStatus(admin, fixtureA.kdsTerminalId, 'active');
    }
  });

  it('NEGATIVE: a revoked KDS terminal -> 403', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    await setTerminalStatus(admin, fixtureA.kdsTerminalId, 'revoked');
    try {
      await request(http)
        .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    } finally {
      await setTerminalStatus(admin, fixtureA.kdsTerminalId, 'active');
    }
  });

  it('NEGATIVE: a KDS terminal bound to NO station -> 403', async () => {
    const unboundTerminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: fixtureA.tenantId,
        branchId: fixtureA.branchId,
        name: `Unbound-${stamp}`,
        terminalType: 'kds',
        status: 'active',
      },
    });
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      unboundTerminal.id,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: a KDS terminal bound to TWO stations -> 403 (fail-closed, never an arbitrary pick)', async () => {
    const dualTerminal = await admin.terminal.create({
      data: {
        id: newId(),
        tenantId: fixtureA.tenantId,
        branchId: fixtureA.branchId,
        name: `Dual-${stamp}`,
        terminalType: 'kds',
        status: 'active',
      },
    });
    await admin.station.create({
      data: {
        id: newId(),
        branchId: fixtureA.branchId,
        name: `Dual-Station-1-${stamp}`,
        displayTerminalId: dualTerminal.id,
      },
    });
    await admin.station.create({
      data: {
        id: newId(),
        branchId: fixtureA.branchId,
        name: `Dual-Station-2-${stamp}`,
        displayTerminalId: dualTerminal.id,
      },
    });
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      dualTerminal.id,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: supplied stationId does not match the terminal-derived station -> 403', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
    await request(http)
      .get(`/kds/stations/${fixtureA.stationPackagingId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('NEGATIVE: missing employee identity on an otherwise-valid KDS session -> 403 for a mutation, but GET queue still succeeds', async () => {
    const token = await dashboardTerminalToken(
      http,
      fixtureA.dashboardEmail,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
    );

    await request(http)
      .get(`/kds/stations/${fixtureA.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const { ticketId } = await makeTicket();
    await request(http)
      .post(`/kds/stations/${fixtureA.stationGrillId}/tickets/view`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketIds: [ticketId] })
      .expect(403);
  });

  it('NEGATIVE: cross-tenant ticket -> tenant-safe 404, not 403 (never discloses existence)', async () => {
    const tokenA = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
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
        `/kds/tickets/${ticketB.ticketId}/lines/${ticketB.ticketLineId}/bump`,
      )
      .set('Authorization', `Bearer ${tokenA}`)
      .send({})
      .expect(404);
  });

  it('tenant isolation and station authorization are independent layers: same-tenant WRONG station is 403, not 404', async () => {
    const token = await pinLogin(
      http,
      fixtureA.tenantId,
      fixtureA.kdsTerminalId,
      fixtureA.employeeCode,
      fixtureA.pin,
    );
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
        `/kds/tickets/${ticketOnPackaging.ticketId}/lines/${ticketOnPackaging.ticketLineId}/bump`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(403);
  });
});
