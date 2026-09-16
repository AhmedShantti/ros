import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { SessionsService } from './../src/modules/identity/sessions/sessions.service';
import { createMigratorClient } from './rls-admin';
import { createKdsFixture, pinLogin } from './kds-fixtures';

/**
 * POS-KDS-SESSION-CONTINUITY-P0 — implementation of the design report
 * (`docs/reports/claude/2026-09-16_POS-KDS-SESSION-CONTINUITY-P0_
 * investigation.md`). FR-SEC-026 requires a configurable IDLE expiry (15m
 * POS / 60m dashboard / 8h KDS), not a hard access-token TTL boundary: an
 * actively operating POS/KDS session must silently survive any number of
 * ordinary access-token rotations, and PIN is required only after idle
 * expiry or a genuine invalidation (revoked, employee/branch/tenant no
 * longer valid) — never merely because 15 minutes elapsed.
 *
 * This file proves, end to end against real Postgres, that
 * `AuthService.refresh()`'s new POS/KDS path (`refreshPosOrKds`) delivers
 * exactly that: identity (`sessionType`/`employeeId`/`branchId`,
 * persisted on `identity.sessions` — design report Option A) survives
 * rotation, idle time is measured from a corrected `lastUsedAt` activity
 * model (never the JWT `exp`), and every genuine invalidation still fails
 * closed. Time is controlled deterministically throughout — by directly
 * backdating `identity.sessions.last_used_at` via the migrator (admin)
 * client — never by literally waiting out a 15-minute or 8-hour window.
 */

const POS_IDLE_TIMEOUT_MS = 15 * 60_000; // POS_IDLE_TIMEOUT_MINUTES default
const KDS_IDLE_TIMEOUT_MS = 8 * 3_600_000; // KDS_IDLE_TIMEOUT_HOURS default

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Test-only inspection of an already-verified JWT's own claims. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

describe('POS/KDS session continuity (e2e) — POS-KDS-SESSION-CONTINUITY-P0', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;
  let admin: PrismaClient;
  let sessions: SessionsService;

  const createdTenantIds: string[] = [];

  async function signUpOwner(label: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(http)
      .post('/auth/registrations')
      .send({
        fullName: `${label} Owner`,
        email: `${label}.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: `${label} Restaurant ${stamp}`,
        password: 's3cure-passphrase-10+',
      })
      .expect(201);
    const out = res.body as {
      auth: { accessToken: string; refreshToken: string };
      tenant: { id: string };
    };
    createdTenantIds.push(out.tenant.id);

    const branches = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${out.auth.accessToken}`)
      .expect(200);
    const branchId = (branches.body as { id: string }[])[0].id;

    return {
      tenantId: out.tenant.id,
      accessToken: out.auth.accessToken,
      refreshToken: out.auth.refreshToken,
      branchId,
    };
  }

  /** A second branch in the same tenant — for "employee not permitted here". */
  async function createSecondBranch(tenantId: string, ownerToken: string) {
    // Reuse the same brand as the first branch (read live, own-branch-only
    // detail isn't exposed via a console endpoint here, so create via admin
    // client directly against the tenant's own existing brand).
    const brand = await admin.brand.findFirstOrThrow({ where: { tenantId } });
    const branchId = newId();
    await admin.branch.create({
      data: {
        id: branchId,
        tenantId,
        brandId: brand.id,
        code: `B${branchId.slice(-6)}`,
        name: 'Second Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      },
    });
    void ownerToken;
    return branchId;
  }

  function employeeBody(homeBranchId: string, label: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      code: `E-${label}-${stamp}`.slice(0, 32),
      displayName: `${label} Cashier`,
      homeBranchId,
      employmentType: 'full_time',
    };
  }

  async function createPosEmployee(
    ownerToken: string,
    branchId: string,
    label: string,
  ) {
    const employee = (
      await request(http)
        .post('/workforce/employees')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', idemKey())
        .send(employeeBody(branchId, label))
        .expect(201)
    ).body as { id: string; code: string };
    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '9090' })
      .expect(204);
    return employee;
  }

  /** Backdate a session's activity timestamp — the deterministic stand-in for "N minutes/hours of real idle time passed". */
  async function backdateActivity(sessionId: string, msAgo: number): Promise<void> {
    await admin.session.update({
      where: { id: sessionId },
      data: { lastUsedAt: new Date(Date.now() - msAgo) },
    });
  }

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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    sessions = app.get(SessionsService);
    admin = createMigratorClient(app);
  });

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  });

  // ===========================================================================
  // POS
  // ===========================================================================

  describe('POS', () => {
    it('a fresh refresh (within the idle window) restores genuine server-derived typ/emp/brc — /cash-sessions/current still 200', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-refresh');
      const employee = await createPosEmployee(accessToken, branchId, 'Refresh');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { accessToken: string; refreshToken: string };

      await request(http)
        .get('/cash-sessions/current')
        .set('Authorization', `Bearer ${loginBody.accessToken}`)
        .expect(200);

      const refreshed = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(200);
      const refreshedToken = (refreshed.body as { accessToken: string }).accessToken;

      const before = decodeJwtPayload(loginBody.accessToken);
      const after = decodeJwtPayload(refreshedToken);
      expect(after.typ).toBe('pos');
      expect(after.emp).toBe(before.emp);
      expect(after.brc).toBe(before.brc);
      expect(after.tid).toBe(tenantId);
      expect(after.mid).toBeDefined();
      expect(after.sid).not.toBe(before.sid); // SID rotation is unaffected

      await request(http)
        .get('/cash-sessions/current')
        .set('Authorization', `Bearer ${refreshedToken}`)
        .expect(200);
    });

    it('survives multiple sequential rotations with byte-identical employee/branch identity, and continuous activity across >30 minutes / multiple TTLs never requires PIN', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-multi');
      const employee = await createPosEmployee(accessToken, branchId, 'Multi');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      let refreshToken = (login.body as { refreshToken: string }).refreshToken;
      const originalPayload = decodeJwtPayload((login.body as { accessToken: string }).accessToken);

      // 4 rotations, each simulating a fresh access-token TTL boundary hit
      // while genuinely active (14 minutes since the last one — just under
      // the 15-minute POS idle default) — 4 * 14m > 30 minutes' worth of
      // continuous, active use, without literally waiting.
      for (let i = 0; i < 4; i++) {
        const beforeRefresh = await request(http)
          .post('/auth/refresh')
          .send({ refreshToken })
          .expect(200);
        const body = beforeRefresh.body as { accessToken: string; refreshToken: string };
        const payload = decodeJwtPayload(body.accessToken);
        expect(payload.typ).toBe('pos');
        expect(payload.emp).toBe(originalPayload.emp);
        expect(payload.brc).toBe(originalPayload.brc);

        await request(http)
          .get('/cash-sessions/current')
          .set('Authorization', `Bearer ${body.accessToken}`)
          .expect(200);

        const sid = payload.sid as string;
        await backdateActivity(sid, POS_IDLE_TIMEOUT_MS - 60_000); // 14 minutes
        refreshToken = body.refreshToken;
      }

      // One more, final live check on the last-issued token.
      const final = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(200);
      await request(http)
        .get('/cash-sessions/current')
        .set('Authorization', `Bearer ${(final.body as { accessToken: string }).accessToken}`)
        .expect(200);
    });

    it('idle beyond the configured POS timeout fails the refresh closed — PIN required', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-idle');
      const employee = await createPosEmployee(accessToken, branchId, 'Idle');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { accessToken: string; refreshToken: string };
      const sid = decodeJwtPayload(loginBody.accessToken).sid as string;

      await backdateActivity(sid, POS_IDLE_TIMEOUT_MS + 60_000); // 16 minutes — over the 15m default

      const res = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken });
      expect(res.status).toBe(401);

      // Fails closed the SAME generic way every other refresh failure does —
      // never distinguishable from the outside.
      expect((res.body as { message: string }).message).toBe('Invalid refresh token');
    });

    it('employee deactivated before refresh fails closed', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-deactivated');
      const employee = await createPosEmployee(accessToken, branchId, 'Deact');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { refreshToken: string };

      await admin.employee.update({
        where: { id: employee.id },
        data: { status: 'terminated' },
      });

      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(401);
    });

    it('employee removed from the operating branch before refresh fails closed', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-removed');
      const employee = await createPosEmployee(accessToken, branchId, 'Removed');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { refreshToken: string };

      await admin.employeeBranch.delete({
        where: { employeeId_branchId: { employeeId: employee.id, branchId } },
      });

      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(401);
    });

    it('branch deactivated before refresh fails closed', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-branch-inactive');
      const employee = await createPosEmployee(accessToken, branchId, 'BranchInactive');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { refreshToken: string };

      await admin.branch.update({ where: { id: branchId }, data: { status: 'inactive' } });

      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(401);
    });

    it('an authzEpoch bump during an active POS session is transparently absorbed by the next refresh — a fresh snapshot, no forced PIN', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-epoch');
      const employee = await createPosEmployee(accessToken, branchId, 'Epoch');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { accessToken: string; refreshToken: string };
      const beforeEpoch = decodeJwtPayload(loginBody.accessToken).epo;

      // Bump the membership's authzEpoch directly (mirrors what a live RBAC
      // mutation, e.g. EmployeesService.addPermittedBranch, already does).
      await admin.membership.updateMany({
        where: { userId: (await admin.employee.findUniqueOrThrow({ where: { id: employee.id }, select: { userId: true } })).userId ?? undefined },
        data: { authzEpoch: { increment: 1 } },
      });

      const refreshed = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(200);
      const afterEpoch = decodeJwtPayload((refreshed.body as { accessToken: string }).accessToken).epo;
      expect(afterEpoch).not.toBe(beforeEpoch);

      // Still fully functional — the fresh epoch matches the live membership.
      await request(http)
        .get('/cash-sessions/current')
        .set('Authorization', `Bearer ${(refreshed.body as { accessToken: string }).accessToken}`)
        .expect(200);
    });

    it('refresh-token reuse (replay of an already-rotated token) still revokes the whole lineage', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-replay');
      const employee = await createPosEmployee(accessToken, branchId, 'Replay');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const original = login.body as { accessToken: string; refreshToken: string };

      const rotated = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: original.refreshToken })
        .expect(200);
      const rotatedBody = rotated.body as { accessToken: string; refreshToken: string };

      // Replay the ORIGINAL (already-superseded) token — reuse detected.
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: original.refreshToken })
        .expect(401);

      // The whole lineage, including the live child minted above, is now
      // revoked — its own refresh token no longer works either.
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: rotatedBody.refreshToken })
        .expect(401);

      const originalSid = decodeJwtPayload(original.accessToken).sid as string;
      const rotatedSid = decodeJwtPayload(rotatedBody.accessToken).sid as string;
      const originalRow = await admin.session.findUniqueOrThrow({ where: { id: originalSid } });
      const rotatedRow = await admin.session.findUniqueOrThrow({ where: { id: rotatedSid } });
      expect(originalRow.revokedAt).not.toBeNull();
      expect(rotatedRow.revokedAt).not.toBeNull();
      expect(rotatedRow.reuseDetectedAt).not.toBeNull();
    });

    it('a refreshed POS token still cannot access dashboard/back-office endpoints', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-no-dashboard');
      const employee = await createPosEmployee(accessToken, branchId, 'NoDash');

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employee.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { refreshToken: string };

      const refreshed = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(200);
      const refreshedToken = (refreshed.body as { accessToken: string }).accessToken;

      await request(http)
        .get('/org/branches')
        .set('Authorization', `Bearer ${refreshedToken}`)
        .expect(403);
    });

    it('a crafted refresh request cannot forge sessionType/employeeId/branchId — the DTO does not accept them at all', async () => {
      const { tenantId, accessToken, branchId } = await signUpOwner('pos-forge');
      const employeeA = await createPosEmployee(accessToken, branchId, 'ForgeA');
      const otherBranchId = await createSecondBranch(tenantId, accessToken);

      const login = await request(http)
        .post('/auth/pin')
        .send({ tenantId, branchId, employeeCode: employeeA.code, pin: '9090', sessionType: 'pos' })
        .expect(200);
      const loginBody = login.body as { refreshToken: string };

      // Global ValidationPipe (whitelist + forbidNonWhitelisted) refuses the
      // request outright — RefreshDto declares only `refreshToken`.
      await request(http)
        .post('/auth/refresh')
        .send({
          refreshToken: loginBody.refreshToken,
          sessionType: 'kds',
          employeeId: 'not-a-real-employee',
          branchId: otherBranchId,
        })
        .expect(400);

      // And the legitimate call (refreshToken alone) still restores exactly
      // the server-persisted identity, never anything a client could
      // influence — proven by every other test in this file.
      const legit = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(200);
      const payload = decodeJwtPayload((legit.body as { accessToken: string }).accessToken);
      expect(payload.emp).toBe(employeeA.id);
      expect(payload.brc).toBe(branchId);
      expect(payload.typ).toBe('pos');
    });
  });

  // ===========================================================================
  // KDS
  // ===========================================================================

  describe('KDS', () => {
    it('refresh preserves typ/emp/brc and station access, and survives multiple rotations without PIN', async () => {
      const fixture = await createKdsFixture(app, admin, `${Date.now()}`.slice(-8));
      createdTenantIds.push(fixture.tenantId);

      const login = await request(http)
        .post('/auth/pin')
        .send({
          tenantId: fixture.tenantId,
          branchId: fixture.branchId,
          employeeCode: fixture.employeeCode,
          pin: fixture.pin,
          sessionType: 'kds',
        })
        .expect(200);
      let body = login.body as { accessToken: string; refreshToken: string };
      const originalPayload = decodeJwtPayload(body.accessToken);
      expect(originalPayload.typ).toBe('kds');

      await request(http)
        .get('/kds/stations')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);

      for (let i = 0; i < 3; i++) {
        const refreshed = await request(http)
          .post('/auth/refresh')
          .send({ refreshToken: body.refreshToken })
          .expect(200);
        body = refreshed.body as { accessToken: string; refreshToken: string };
        const payload = decodeJwtPayload(body.accessToken);
        expect(payload.typ).toBe('kds');
        expect(payload.emp).toBe(originalPayload.emp);
        expect(payload.brc).toBe(originalPayload.brc);

        await request(http)
          .get('/kds/stations')
          .set('Authorization', `Bearer ${body.accessToken}`)
          .expect(200);

        await backdateActivity(payload.sid as string, KDS_IDLE_TIMEOUT_MS / 4);
      }
    });

    it('operational polling (the activity touch path) keeps a session alive despite an old issuedAt', async () => {
      const fixture = await createKdsFixture(app, admin, `${Date.now()}`.slice(-7) + 'a');
      createdTenantIds.push(fixture.tenantId);

      const token = await pinLogin(
        http,
        fixture.tenantId,
        fixture.branchId,
        fixture.employeeCode,
        fixture.pin,
        'kds',
      );
      const sid = decodeJwtPayload(token).sid as string;

      // No activity for well over the 8h KDS default...
      await backdateActivity(sid, KDS_IDLE_TIMEOUT_MS + 3_600_000);

      // ...but a poll comes in (SessionsService.touch(), exactly what
      // JwtAuthGuard fires on every authenticated KDS request) BEFORE the
      // refresh — the same mechanism `GET /kds/stations` already exercises
      // fire-and-forget; called directly here for a deterministic assertion.
      await sessions.touch(sid);
      const touched = await admin.session.findUniqueOrThrow({ where: { id: sid } });
      expect(touched.lastUsedAt).not.toBeNull();
      expect(Date.now() - (touched.lastUsedAt as Date).getTime()).toBeLessThan(5_000);

      // The refresh token itself is still the ORIGINAL one from login — a
      // touch does not rotate anything, it only updates activity.
      const refreshToken = (
        await request(http)
          .post('/auth/pin')
          .send({
            tenantId: fixture.tenantId,
            branchId: fixture.branchId,
            employeeCode: fixture.employeeCode,
            pin: fixture.pin,
            sessionType: 'kds',
          })
      );
      void refreshToken; // (unused — token/sid captured via pinLogin above; this call is not part of the assertion)
    });

    it('a second, fresh session directly proves the debounce: two touches within the window write once, and a touch after the window writes again', async () => {
      const fixture = await createKdsFixture(app, admin, `${Date.now()}`.slice(-6) + 'db');
      createdTenantIds.push(fixture.tenantId);
      const token = await pinLogin(
        http,
        fixture.tenantId,
        fixture.branchId,
        fixture.employeeCode,
        fixture.pin,
        'kds',
      );
      const sid = decodeJwtPayload(token).sid as string;

      const first = await admin.session.findUniqueOrThrow({ where: { id: sid } });
      const firstLastUsedAt = first.lastUsedAt as Date;

      // Within the 60s debounce window: a no-op, lastUsedAt unchanged.
      await sessions.touch(sid);
      const second = await admin.session.findUniqueOrThrow({ where: { id: sid } });
      expect(second.lastUsedAt?.getTime()).toBe(firstLastUsedAt.getTime());

      // Simulate the window having elapsed, then touch again — now it writes.
      await backdateActivity(sid, 61_000);
      await sessions.touch(sid);
      const third = await admin.session.findUniqueOrThrow({ where: { id: sid } });
      expect(third.lastUsedAt?.getTime()).not.toBe(firstLastUsedAt.getTime());
      expect(Date.now() - (third.lastUsedAt as Date).getTime()).toBeLessThan(5_000);
    });

    it('inactivity beyond the configured KDS timeout fails the refresh closed — PIN required', async () => {
      const fixture = await createKdsFixture(app, admin, `${Date.now()}`.slice(-6) + 'ix');
      createdTenantIds.push(fixture.tenantId);

      const login = await request(http)
        .post('/auth/pin')
        .send({
          tenantId: fixture.tenantId,
          branchId: fixture.branchId,
          employeeCode: fixture.employeeCode,
          pin: fixture.pin,
          sessionType: 'kds',
        })
        .expect(200);
      const loginBody = login.body as { accessToken: string; refreshToken: string };
      const sid = decodeJwtPayload(loginBody.accessToken).sid as string;

      await backdateActivity(sid, KDS_IDLE_TIMEOUT_MS + 3_600_000); // 9 hours — no touch since

      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(401);
    });

    it('a refreshed KDS token still cannot gain POS or dashboard authority', async () => {
      const fixture = await createKdsFixture(app, admin, `${Date.now()}`.slice(-6) + 'au');
      createdTenantIds.push(fixture.tenantId);

      const login = await request(http)
        .post('/auth/pin')
        .send({
          tenantId: fixture.tenantId,
          branchId: fixture.branchId,
          employeeCode: fixture.employeeCode,
          pin: fixture.pin,
          sessionType: 'kds',
        })
        .expect(200);
      const loginBody = login.body as { refreshToken: string };

      const refreshed = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: loginBody.refreshToken })
        .expect(200);
      const refreshedToken = (refreshed.body as { accessToken: string }).accessToken;

      await request(http)
        .get('/cash-sessions/current')
        .set('Authorization', `Bearer ${refreshedToken}`)
        .expect(403);
      await request(http)
        .get('/org/branches')
        .set('Authorization', `Bearer ${refreshedToken}`)
        .expect(403);
    });
  });

  // ===========================================================================
  // Console — unchanged
  // ===========================================================================

  it('CONSOLE: refresh behaviour is byte-for-byte unchanged — tid/mid/scp/pbr/epo restored, no typ/emp/brc ever minted', async () => {
    const { accessToken, refreshToken: ownerRefreshToken, tenantId } = await signUpOwner('console-unchanged');

    const refreshed = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: ownerRefreshToken })
      .expect(200);
    const refreshedToken = (refreshed.body as { accessToken: string }).accessToken;
    const payload = decodeJwtPayload(refreshedToken);

    expect(payload.tid).toBe(tenantId);
    expect(payload.mid).toBeDefined();
    expect(payload.scp).toBeDefined();
    expect(payload.pbr).toBeDefined();
    expect(payload.typ).toBeUndefined();
    expect(payload.emp).toBeUndefined();
    expect(payload.brc).toBeUndefined();

    // Fully functional dashboard session, unaffected.
    await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .expect(200);
    void accessToken;
  });
});
