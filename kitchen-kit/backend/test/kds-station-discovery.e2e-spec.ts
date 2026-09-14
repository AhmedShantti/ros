import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import { createMigratorClient } from './rls-admin';
import { createKdsFixture, KdsFixture, pinLogin } from './kds-fixtures';

/**
 * KDS-STATION-DISCOVERY-AUTH-FIX-P0.
 *
 * Live symptom: the KDS station picker called `GET /org/branches/:branchId
 * /stations` (BRANCH_READ-gated, back-office/console-only) and 403'd for a
 * real KDS PIN session — proof the picker was calling the wrong contract,
 * not that authorization was broken. `GET /kds/stations` is the KDS-safe
 * replacement: branch-scoped to the CALLER'S OWN session, never a
 * client-supplied tenantId/branchId, never BRANCH_READ.
 */
describe('KDS station discovery (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const stamp = Date.now().toString(36);
  let fixtureA: KdsFixture;
  let fixtureB: KdsFixture;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    admin = createMigratorClient(app);
    http = app.getHttpServer();

    // `GET /org/branches/:branchId/stations` needs ORGANISATION_PERMISSION_DEFS
    // upserted to even resolve the dashboard-side regression check below.
    const permissions = app.get(PermissionsService);
    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);

    fixtureA = await createKdsFixture(app, admin, `${stamp}a`);
    fixtureB = await createKdsFixture(app, admin, `${stamp}b`);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function kdsLogin(fixture: KdsFixture): Promise<string> {
    return pinLogin(http, fixture.tenantId, fixture.branchId, fixture.employeeCode, fixture.pin, 'kds');
  }
  async function posLogin(fixture: KdsFixture): Promise<string> {
    return pinLogin(http, fixture.tenantId, fixture.branchId, fixture.employeeCode, fixture.pin, 'pos');
  }

  it('1. KDS PIN session: GET /kds/stations => 200', async () => {
    const token = await kdsLogin(fixtureA);
    const res = await request(http)
      .get('/kds/stations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('2. only stations from the KDS session\'s own branch are returned, in the minimal picker shape', async () => {
    const token = await kdsLogin(fixtureA);
    const res = await request(http)
      .get('/kds/stations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const ids = (res.body as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([fixtureA.stationGrillId, fixtureA.stationPackagingId]),
    );
    // Fixture B's stations belong to a different tenant AND branch — must
    // never leak into A's picker.
    expect(ids).not.toContain(fixtureB.stationGrillId);
    expect(ids).not.toContain(fixtureB.stationPackagingId);

    // Minimal shape only — no management/config fields.
    for (const station of res.body as Record<string, unknown>[]) {
      expect(Object.keys(station).sort()).toEqual(['displayColour', 'id', 'name'].sort());
    }
  });

  it("3. POS PIN session: GET /kds/stations => rejected", async () => {
    const token = await posLogin(fixtureA);
    await request(http)
      .get('/kds/stations')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('4. dashboard/console behavior is unchanged: a real admin session still reads GET /org/branches/:branchId/stations', async () => {
    // Grant BRANCH_READ BEFORE logging in, so the dashboard probe genuinely
    // exercises the unchanged endpoint's normal success path, not just its
    // own guard (matches organisation.e2e-spec.ts's own fixture ordering).
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const dashboardUser = await admin.user.findFirstOrThrow({
      where: { email: fixtureA.dashboardEmail },
    });
    const membership = await admin.membership.findFirstOrThrow({
      where: { tenantId: fixtureA.tenantId, userId: dashboardUser.id },
    });
    const role = await roles.createTenantRole(fixtureA.tenantId, {
      name: `kds-discovery-dashboard-${stamp}`,
    });
    await roles.addPermissions(fixtureA.tenantId, role.id, [ORGANISATION_PERMISSIONS.BRANCH_READ]);
    await membershipRoles.create(fixtureA.tenantId, null, {
      membershipId: membership.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });

    const login = await request(http)
      .post('/auth/login')
      .send({ email: fixtureA.dashboardEmail, password: 's3cure-passphrase' })
      .expect(200);
    const scoped = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as { accessToken: string }).accessToken}`)
      .send({ tenantId: fixtureA.tenantId })
      .expect(200);
    const dashboardToken = (scoped.body as { accessToken: string }).accessToken;

    const res = await request(http)
      .get(`/org/branches/${fixtureA.branchId}/stations`)
      .set('Authorization', `Bearer ${dashboardToken}`)
      .expect(200);
    const ids = (res.body as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([fixtureA.stationGrillId, fixtureA.stationPackagingId]),
    );
  });

  it('5. KDS session still cannot access the back-office /org/branches/:branchId/stations endpoint', async () => {
    const token = await kdsLogin(fixtureA);
    await request(http)
      .get(`/org/branches/${fixtureA.branchId}/stations`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('6. a station returned by discovery can then be used to read its queue (same-branch access still enforced)', async () => {
    const token = await kdsLogin(fixtureA);
    const discovered = await request(http)
      .get('/kds/stations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const stationId = (discovered.body as { id: string }[])[0]!.id;

    await request(http)
      .get(`/kds/stations/${stationId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // And the existing cross-tenant protection on the QUEUE route is
    // unchanged: fixture B's station belongs to a DIFFERENT TENANT, so it
    // is invisible under this session's own tenant-scoped RLS —
    // `PermissionGuard`'s own `AuthorizationTarget` resolution (which runs
    // before `KdsStationGuard`) finds no such station and fails closed with
    // the tenant-safe 404 `kds-authorization.e2e-spec.ts`'s own
    // cross-tenant-ticket case documents ("never discloses existence"). A
    // same-tenant-but-wrong-branch station (that spec's separate case) is
    // 403, not 404 — this one is genuinely cross-tenant.
    await request(http)
      .get(`/kds/stations/${fixtureB.stationGrillId}/queue`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('7. no terminalId/device binding: discovery works for a KDS session with no terminal-bound station at all', async () => {
    // `createKdsFixture` never sets `displayTerminalId` on either station,
    // and the new endpoint never reads a terminal at all — this is really
    // just re-asserting test 1/2 while calling it out explicitly for the
    // record. The response body itself is also asserted (test 2) to carry
    // no terminal-shaped field.
    const token = await kdsLogin(fixtureA);
    const res = await request(http)
      .get('/kds/stations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const bodyText = JSON.stringify(res.body).toLowerCase();
    expect(bodyText).not.toContain('terminal');
  });

  it('rejects a plain dashboard-bound-terminal session with no KDS session type', async () => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email: fixtureA.dashboardEmail, password: 's3cure-passphrase' })
      .expect(200);
    const scoped = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as { accessToken: string }).accessToken}`)
      .send({ tenantId: fixtureA.tenantId })
      .expect(200);
    await request(http)
      .get('/kds/stations')
      .set('Authorization', `Bearer ${(scoped.body as { accessToken: string }).accessToken}`)
      .expect(403);
  });
});
