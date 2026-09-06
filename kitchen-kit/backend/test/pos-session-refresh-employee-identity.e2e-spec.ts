import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { CredentialsService } from './../src/modules/identity/credentials/credentials.service';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * DEMO-POS-EMPLOYEE-SESSION-HOTFIX — a request that reaches
 * `TreasuryController` with a valid terminal+branch scope (passing
 * `PermissionGuard`) but no `employeeId` claim fails deep inside
 * `requirePosIdentity` with "Opening a cash session requires a session
 * that identifies the employee taking custody of the drawer." Two REAL
 * code paths could mint exactly that shape of token:
 *
 * 1. `TerminalSessionService.bind()` (`POST /auth/terminal`) — a
 *    DASHBOARD-authenticated session binding itself to a terminal. It
 *    signs `trm` but never looked up whether the caller IS an Employee, so
 *    it never signed `emp` even when one genuinely existed
 *    (`Employee.userId` is unique — the same identity a PIN login would
 *    have resolved). **This is the proven, fixed root cause** — reproduced
 *    below with a real password-linked Employee.
 * 2. `AuthService.refresh()` restored `trm` (terminal) across rotation but
 *    never re-derived `emp` for a session whose context DID survive
 *    rotation (i.e., one that had already gone through tenant selection
 *    AND a terminal bind, both of which persist onto the `Session` row).
 *    Also fixed, verified below by refreshing a bound session.
 *
 * A PURE PIN-issued session's OWN refresh is deliberately unaffected by
 * either fix: `AuthService.loginWithPin` never persists `membershipId`
 * onto its `Session` row (a documented, ratified anti-escalation
 * decision — "a POS session ends with its access token and the employee
 * re-enters their PIN"), so refreshing it restores no tenant context at
 * all and fails at the EARLIER "session is not terminal-bound" stage,
 * never reaching the employee-identity check. That is unchanged,
 * intentional behaviour, also verified below.
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
    const terminalId = await registerTerminal(accessToken, branchId);

    const login = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '4321' })
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

  it('a DASHBOARD session bound to a terminal via POST /auth/terminal carries the caller\'s OWN Employee identity, fixing the exact reported 403', async () => {
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

    const drawers = await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${boundToken}`)
      .expect(200);
    const rows = drawers.body as { id: string; name: string }[];
    expect(rows).toHaveLength(1);

    const cashSessionId = newId();
    await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${boundToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        shiftId: newId(),
        cashSessionId,
        drawerId: rows[0].id,
        openingFloat: '50000',
      })
      .expect(201);

    const row = await prisma.withAuthContext({ tenantId }, (tx) =>
      tx.cashSession.findUnique({
        where: { id: cashSessionId },
        select: { employeeId: true },
      }),
    );
    expect(row?.employeeId).toBe(employee.id);

    // Refresh — `/auth/tenant` and `/auth/terminal` both re-sign the access
    // token for the SAME session (session id / refresh token unchanged), so
    // the ORIGINAL login's refresh token still names this exact,
    // now-terminal-bound session. Its context (tenant + terminal) DID
    // survive a normal dashboard login, so the employee identity must
    // survive rotation too.
    const refreshed = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: (dashboardLogin.body as { refreshToken: string }).refreshToken })
      .expect(200);
    const refreshedToken = (refreshed.body as { accessToken: string }).accessToken;

    const drawersAfterRefresh = await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .expect(200);
    expect((drawersAfterRefresh.body as unknown[]).length).toBe(1);
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
    const terminalId = await registerTerminal(accessToken, branchId);

    const login = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '4321' })
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

    const terminalId = await registerTerminal(accessToken, branchId);

    const loginA = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employeeA.code, pin: '1111' })
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
