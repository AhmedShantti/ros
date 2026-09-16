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
 * ── POS-KDS-SESSION-CONTINUITY-P0 (2026-09-16) — SUPERSEDES the paragraph
 * this replaces ────────────────────────────────────────────────────────────
 * A PURE PIN-issued session's OWN refresh is NO LONGER treated as "the
 * session simply ends" — that was never a ratified decision (see the
 * design report's Phase 8: the code comment that used to justify it
 * mischaracterized `CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0` and
 * `FR-SEC-021`, neither of which says anything about refresh-boundary
 * session lifetime), and it directly conflicted with FR-SEC-026's
 * configurable IDLE-expiry requirement (15m POS / 60m dashboard / 8h KDS)
 * — an access-token TTL boundary is not a human-session boundary.
 * `AuthService.loginWithPin` now persists `sessionType`/`employeeId`/
 * `branchId` (new, additive `identity.sessions` columns) AND
 * `membershipId` (the SAME real membership `PinService.authenticate`
 * already resolves — `Membership` is unique per `[userId, tenantId]`) onto
 * the session row; `AuthService.refresh()` branches on `session.sessionType`
 * FIRST and, for `pos`/`kds`, live-revalidates employee/branch/tenant state
 * and mints `typ`/`emp`/`brc` together with `tid`/`mid` — never separately
 * — before an idle timeout is exceeded. The tests below that used to prove
 * "refresh fails closed, full stop" now prove "refresh preserves identity
 * while active, and still fails closed on idle-expiry or genuine
 * invalidation" instead. Full idle-timeout/rotation/revocation coverage
 * lives in the dedicated `test/pos-kds-session-continuity.e2e-spec.ts`;
 * this file keeps only the identity-specific and historical-regression
 * cases it already owned.
 */

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Test-only inspection of an already-verified JWT's own claims — never used
 * for anything authorization-bearing. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
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

  it('POS-KDS-SESSION-CONTINUITY-P0 (SUPERSEDES the old "fails closed at the terminal-binding stage" behaviour): a refreshed PURE PIN session now correctly PRESERVES its POS identity and access — FR-SEC-026 idle semantics, not a refresh-boundary session end', async () => {
    // Historical note, kept for anyone diffing this file against an older
    // version: before POS-KDS-SESSION-CONTINUITY-P0, `AuthService.refresh()`
    // deliberately never persisted `session.membershipId` for a PIN session
    // and restored no `typ`/`emp`/`brc` either, so a bare refresh always
    // fell all the way back to "no scope at all" (403 here). That was
    // ITSELF the defect this task fixes: FR-SEC-026 requires an IDLE
    // timeout, not "the session ends at the very next access-token
    // rotation" — see the design report's Phase 8, which also traces that
    // the removed behaviour was never actually a ratified governance
    // decision, only an unratified assumption in a code comment. The
    // identity/employee/branch now persist on the `Session` row itself
    // (`sessionType`/`employeeId`/`branchId`, plus `membershipId` — see
    // `SessionsService.issue()`'s own docblock for why persisting it no
    // longer risks the escalation the old comment warned about) and are
    // live-revalidated, not merely replayed, on every refresh.
    const { tenantId, accessToken, branchId } = await signUpOwner();

    await request(http)
      .post(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ name: 'Continuity Drawer' })
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
    const original = login.body as { accessToken: string; refreshToken: string };

    const refreshed = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(200);
    const refreshedToken = (refreshed.body as { accessToken: string }).accessToken;

    // Still a real, fully-functional POS session — genuinely preserved,
    // not merely "not yet noticed as broken".
    const drawers = await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .expect(200);
    expect((drawers.body as { id: string }[])).toHaveLength(1);

    const before = decodeJwtPayload(original.accessToken);
    const after = decodeJwtPayload(refreshedToken);
    expect(after.typ).toBe('pos');
    expect(after.emp).toBe(before.emp);
    expect(after.brc).toBe(before.brc);

    // The historical exploit path is now impossible, not merely unused:
    // the refreshed token already carries `typ: 'pos'`, and `POST
    // /auth/tenant` is not POS-opted-in — `JwtAuthGuard` refuses it
    // outright, before `TenantSelectionService` (the thing that used to
    // silently strip the POS identity) is ever reached.
    await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${refreshedToken}`)
      .send({ tenantId })
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

  /**
   * POS-SESSION-REFRESH-CONTEXT-P0 (historical defect) /
   * POS-KDS-SESSION-CONTINUITY-P0 (the fix) — REGRESSION test.
   *
   * What this file's PHASE 5 reproduction originally proved, live: a bare
   * `POST /auth/refresh` dropped `typ`/`emp`/`brc`, and the frontend's own
   * `lib/api/client.ts#refreshSession()` then unconditionally followed it
   * with `POST /auth/tenant` (a step written for console, with no
   * awareness a POS/KDS session's context must never be re-established by
   * tenant re-selection) — which SUCCEEDED, silently producing a token
   * indistinguishable from an ordinary dashboard session's and turning
   * `GET /cash-sessions/current` from `200` into the exact generic
   * `"Insufficient permission for this scope."` 403 production showed.
   *
   * Both halves of that defect are now fixed, at their respective layers:
   * `AuthService.refresh()` itself now restores `typ`/`emp`/`brc` (this
   * file's preceding test), and the frontend no longer calls `/auth/tenant`
   * for POS/KDS at all (`lib/api/client.ts#refreshSession()`,
   * POS-KDS-SESSION-CONTINUITY-P0 Phase 7). This test proves the exact
   * historical repro sequence NO LONGER reproduces the symptom: refresh
   * alone keeps `GET /cash-sessions/current` at `200` throughout, with no
   * `/auth/tenant` replay step needed or attempted.
   */
  it('REGRESSION: the historical refresh -> silent-dashboard-conversion -> 403 sequence no longer reproduces — GET /cash-sessions/current stays 200 across refresh, with no /auth/tenant replay', async () => {
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
      .send({ pin: '7777' })
      .expect(204);

    const login = await request(http)
      .post('/auth/pin')
      .send({
        tenantId,
        branchId,
        employeeCode: employee.code,
        pin: '7777',
        sessionType: 'pos',
      })
      .expect(200);
    const loginBody = login.body as { accessToken: string; refreshToken: string };
    const posToken = loginBody.accessToken;

    // 1. Fresh PIN principal: GET /cash-sessions/current succeeds (200).
    await request(http)
      .get('/cash-sessions/current')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(200);

    const before = decodeJwtPayload(posToken);
    expect(before.typ).toBe('pos');
    expect(before.brc).toBe(branchId);
    expect(before.emp).toBe(employee.id);
    expect(before.tid).toBe(tenantId);
    expect(before.mid).toBeDefined();

    // 2. The exact production rotation: POST /auth/refresh. NO further
    // replay step follows — the frontend no longer makes one, and this
    // test proves none is needed.
    const refreshed = await request(http)
      .post('/auth/refresh')
      .send({ refreshToken: loginBody.refreshToken })
      .expect(200);
    const finalToken = (refreshed.body as { accessToken: string }).accessToken;

    const after = decodeJwtPayload(finalToken);
    // Tenant context is back...
    expect(after.tid).toBe(tenantId);
    expect(after.mid).toBeDefined();
    expect(after.scp).toBeDefined();
    expect(after.pbr).toBeDefined();
    // ...and, unlike the historical defect, so is the POS identity —
    // restored together, server-derived, never separately.
    expect(after.typ).toBe('pos');
    expect(after.brc).toBe(branchId);
    expect(after.emp).toBe(employee.id);
    expect(after.sid).not.toBe(before.sid); // SID rotation is unaffected

    // 3. The historical symptom does NOT reproduce: same endpoint, same
    // employee, same branch, same live permission grant — still 200.
    await request(http)
      .get('/cash-sessions/current')
      .set('Authorization', `Bearer ${finalToken}`)
      .expect(200);

    // The rotated session row itself carries the SAME persisted POS
    // identity forward (SessionsService.rotate()), never converted into a
    // console-shaped row the way the historical /auth/tenant replay used
    // to convert it.
    const sessionRow = await prisma.session.findUnique({
      where: { id: after.sid as string },
      select: { sessionType: true, employeeId: true, branchId: true, membershipId: true },
    });
    expect(sessionRow?.sessionType).toBe('pos');
    expect(sessionRow?.employeeId).toBe(employee.id);
    expect(sessionRow?.branchId).toBe(branchId);
    expect(sessionRow?.membershipId).toBe(after.mid);
  });
});
