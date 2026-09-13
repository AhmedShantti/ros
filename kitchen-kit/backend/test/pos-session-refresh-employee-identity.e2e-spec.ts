import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { CredentialsService } from './../src/modules/identity/credentials/credentials.service';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * DEMO-POS-EMPLOYEE-SESSION-HOTFIX — originally: a request that reaches
 * `TreasuryController` with a valid terminal+branch scope (passing
 * `PermissionGuard`) but no `employeeId` claim fails deep inside
 * `requirePosIdentity` with "Opening a cash session requires a session
 * that identifies the employee taking custody of the drawer."
 *
 * ── CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13) ────────────────────
 * REWRITTEN. Of the two original root causes this file proved fixed:
 *
 * 1. `TerminalSessionService.bind()` (`POST /auth/terminal`) minting a
 *    terminal-bound DASHBOARD session that reached POS routes with the
 *    caller's own employee identity attached — this ENTIRE CODE PATH IS
 *    GONE. `POST /auth/terminal` still exists, but exclusively for the
 *    Sync/offline device channel now; the token it mints carries no
 *    `sessionType` at all, so `TreasuryController`'s class-level
 *    `@AllowPosSession()` refuses it outright at `JwtAuthGuard`, before
 *    `requirePosIdentity` (or any employee-identity question) is ever
 *    reached. There is no longer a way to construct "a POS-capable session
 *    with no employee identity" at all: POS sessions are now issued ONLY by
 *    PIN login, which always resolves and signs a real `emp` claim. The old
 *    "dashboard session bound to a terminal carries the caller's own
 *    Employee identity" test below is rewritten to assert this NEW,
 *    stronger guarantee (403 refusal, not merely "no employeeId") instead
 *    of being deleted — see that test's own comment.
 * 2. `AuthService.refresh()` restoring `trm` (terminal) across rotation
 *    without re-deriving `emp` — also moot: refresh no longer restores any
 *    terminal/branch/employee custody at all (see `AuthService.refresh`'s
 *    own docblock), so there is nothing left to test on that path either;
 *    the refreshed-dashboard-session assertion below is rewritten to match.
 *
 * A PURE PIN-issued session's OWN refresh remains deliberately unaffected:
 * `AuthService.loginWithPin` never persists `membershipId` onto its
 * `Session` row (a documented, ratified anti-escalation decision — "a POS
 * session ends with its access token and the employee re-enters their
 * PIN"), so refreshing it restores no tenant context at all and fails at
 * the EARLIER "session is not terminal-bound" stage. That is unchanged,
 * intentional behaviour, still verified below.
 */

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('POS/terminal session employee identity (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let credentials: CredentialsService;
  let http: App;

  const createdTenantIds: string[] = [];

  async function signUpOwner() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(http)
      .post('/auth/registrations')
      .send({
        fullName: 'Session Identity Owner',
        email: `session.identity.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: `Session Identity Restaurant ${stamp}`,
        password: 's3cure-passphrase-10+',
      })
      .expect(201);
    const out = res.body as {
      auth: { accessToken: string };
      tenant: { id: string };
    };
    createdTenantIds.push(out.tenant.id);

    const branches = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${out.auth.accessToken}`)
      .expect(200);
    const branchId = (branches.body as { id: string }[])[0].id;

    return { tenantId: out.tenant.id, accessToken: out.auth.accessToken, branchId };
  }

  async function registerTerminal(accessToken: string, branchId: string) {
    const res = await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `POS-${Date.now()}`, terminalType: 'pos', branchId })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function employeeBody(homeBranchId: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      code: `E-${stamp}`.slice(0, 32),
      displayName: 'Session Identity Cashier',
      homeBranchId,
      employmentType: 'full_time',
    };
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
    credentials = app.get(CredentialsService);
  });

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('ACCEPTANCE: PIN login end to end — real drawer, employee-identified session, and CashSession.employeeId attribution', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    await request(http)
      .post(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ name: 'Main Drawer' })
      .expect(201);

    const employee = (
      await request(http)
        .post('/workforce/employees')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', idemKey())
        .send(employeeBody(branchId))
        .expect(201)
    ).body as { id: string; code: string };
    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '4321' })
      .expect(204);

    // CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0: no terminal is registered or
    // bound here at all — PIN login is branch/employee-scoped, never
    // terminal-scoped, and this is deliberately the file's proof that no
    // Terminal row is needed for a POS session to work end to end.
    const login = await request(http)
      .post('/auth/pin')
      .send({
        tenantId,
        branchId,
        employeeCode: employee.code,
        pin: '4321',
        sessionType: 'pos',
      })
      .expect(200);
    const posToken = (login.body as { accessToken: string }).accessToken;

    const drawers = await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(200);
    const rows = drawers.body as { id: string; name: string }[];
    expect(rows).toHaveLength(1);

    const cashSessionId = newId();
    await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        shiftId: newId(),
        cashSessionId,
        drawerId: rows[0].id,
        openingFloat: '50000',
      })
      .expect(201);

    // CASH_SESSION_EMPLOYEE_PROOF — read directly from the table (no API
    // response exposes employeeId). RLS-scoped, so read within the tenant.
    const row = await prisma.withAuthContext({ tenantId }, (tx) =>
      tx.cashSession.findUnique({
        where: { id: cashSessionId },
        select: { employeeId: true },
      }),
    );
    expect(row?.employeeId).toBe(employee.id);
  });

  it('CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (judgment call): a DASHBOARD session — even one bound to a terminal via POST /auth/terminal — is now refused OUTRIGHT at POS-only routes, both before and after a refresh (replaces the old "carries the caller\'s own Employee identity, fixing the exact reported 403" acceptance test: that code path — a dashboard-bound-terminal session reaching POS routes at all — no longer exists. /auth/terminal now serves ONLY the Sync/offline device channel; the token it mints carries no sessionType, so TreasuryController\'s class-level @AllowPosSession() refuses it at JwtAuthGuard, well before any employee-identity question is reached. This asserts the NEW, stronger guarantee instead of the old permissive one.)', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    await request(http)
      .post(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ name: 'Bind-Path Drawer' })
      .expect(201);

    // An employee who ALSO has a password credential (unlike the usual
    // auto-provisioned, PIN-only employee) — the only way to reach `bind()`
    // at all, since it requires an already-dashboard-authenticated session.
    const employee = (
      await request(http)
        .post('/workforce/employees')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', idemKey())
        .send(employeeBody(branchId))
        .expect(201)
    ).body as { id: string; userId: string; code: string };

    const employeeUser = await prisma.user.findUniqueOrThrow({
      where: { id: employee.userId },
      select: { email: true },
    });
    const password = 's3cure-passphrase-10+';
    await prisma.withAuthContext({ tenantId }, (tx) =>
      credentials.createPasswordCredential(tx, employee.userId, password),
    );

    const dashboardLogin = await request(http)
      .post('/auth/login')
      .send({ email: employeeUser.email, password })
      .expect(200);
    const rawToken = (dashboardLogin.body as { accessToken: string }).accessToken;

    const tenantSelected = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ tenantId })
      .expect(200);
    const tenantToken = (tenantSelected.body as { accessToken: string }).accessToken;

    const terminalId = await registerTerminal(accessToken, branchId);
    const bound = await request(http)
      .post('/auth/terminal')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ terminalId })
      .expect(200);
    const boundToken = (bound.body as { accessToken: string }).accessToken;

    // The bound token carries no sessionType at all — TreasuryController's
    // class-level @AllowPosSession() refuses it at JwtAuthGuard, before
    // PermissionGuard, TenantContextGuard, or any employee-identity check
    // ever runs.
    await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${boundToken}`)
      .expect(403);

    // Refresh — `/auth/tenant` and `/auth/terminal` both re-sign the access
    // token for the SAME session, so the ORIGINAL login's refresh token
    // still names this exact, now-terminal-bound session. Refresh restores
    // ONLY tenant context (tid/mid) now — no branch/terminal/employee
    // custody at all (AuthService.refresh's own docblock) — so the
    // refreshed token is a plain dashboard token, still refused the same
    // way.
    const refreshed = await request(http)
      .post('/auth/refresh')
      .send({
        refreshToken: (dashboardLogin.body as { refreshToken: string })
          .refreshToken,
      })
      .expect(200);
    const refreshedToken = (refreshed.body as { accessToken: string })
      .accessToken;

    await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .expect(403);
  });

  it('a refreshed PURE PIN session (never tenant-selected, membership never persisted) fails closed at the terminal-binding stage — unchanged, deliberate behaviour', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    const employee = (
      await request(http)
        .post('/workforce/employees')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', idemKey())
        .send(employeeBody(branchId))
        .expect(201)
    ).body as { id: string; code: string };
    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '4321' })
      .expect(204);
    const login = await request(http)
      .post('/auth/pin')
      .send({
        tenantId,
        branchId,
        employeeCode: employee.code,
        pin: '4321',
        sessionType: 'pos',
      })
      .expect(200);
    const original = login.body as { refreshToken: string };

    const refreshed = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(200);
    const refreshedToken = (refreshed.body as { accessToken: string }).accessToken;

    // Fails closed — no tenant context was ever persisted for a PIN
    // session, so nothing downstream can succeed until the employee
    // re-enters their PIN. This must NOT be the "requires ... employee"
    // message (that would mean a target was somehow resolved); it is the
    // earlier, "no scope at all" refusal.
    await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .expect(403);
  });

  it('another employee cannot inherit this identity: PIN login only ever names the authenticating employee', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    const employeeA = (
      await request(http)
        .post('/workforce/employees')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', idemKey())
        .send(employeeBody(branchId))
        .expect(201)
    ).body as { id: string; code: string };
    await request(http)
      .post(`/workforce/employees/${employeeA.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '1111' })
      .expect(204);

    const employeeB = (
      await request(http)
        .post('/workforce/employees')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', idemKey())
        .send(employeeBody(branchId))
        .expect(201)
    ).body as { id: string; code: string };
    await request(http)
      .post(`/workforce/employees/${employeeB.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '2222' })
      .expect(204);

    await request(http)
      .post(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ name: 'Shared Drawer' })
      .expect(201);

    const loginA = await request(http)
      .post('/auth/pin')
      .send({
        tenantId,
        branchId,
        employeeCode: employeeA.code,
        pin: '1111',
        sessionType: 'pos',
      })
      .expect(200);
    const tokenA = (loginA.body as { accessToken: string }).accessToken;

    const drawersA = await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const drawerId = (drawersA.body as { id: string }[])[0].id;

    const sessionIdA = newId();
    await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', idemKey())
      .send({ shiftId: newId(), cashSessionId: sessionIdA, drawerId, openingFloat: '10000' })
      .expect(201);

    const rowA = await prisma.withAuthContext({ tenantId }, (tx) =>
      tx.cashSession.findUnique({
        where: { id: sessionIdA },
        select: { employeeId: true },
      }),
    );
    expect(rowA?.employeeId).toBe(employeeA.id);
    expect(rowA?.employeeId).not.toBe(employeeB.id);
  });
});
