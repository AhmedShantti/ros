import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * POS-SESSION-RESILIENCE-P1.
 *
 * Root cause traced in the companion diagnosis: a POS/KDS access token's
 * `brc` (branch) claim is minted once at PIN sign-on and never re-derived by
 * silent refresh. `TenantContextService.resolve`'s live grant recomputation
 * means the token's CLAIMS never grant anything — but until this fix, one
 * class of authorization-relevant mutation (`EmployeesService
 * .addPermittedBranch`, FR-HRM-005) changed what an already-open session's
 * live checks would decide without bumping `membership.authzEpoch`, so an
 * existing token silently kept failing with the SAME generic
 * "Insufficient permission for this scope." a real denial produces — with
 * no signal that re-authentication (not a permissions bug) was the fix.
 * `authzEpoch` mismatch now fires first and produces the distinct
 * `STALE_SNAPSHOT` message instead.
 *
 * This file proves that fix, end to end, against the real HTTP surface —
 * no service called directly, no RBAC data hand-edited.
 */

const STALE_SNAPSHOT_MESSAGE =
  'Authorization snapshot is stale; obtain a new access token.';
const GENERIC_DENIAL_MESSAGE = 'Insufficient permission for this scope.';

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('POS/KDS stale branch-context session recovery (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;
  let admin: ReturnType<typeof createMigratorClient>;

  const createdTenantIds: string[] = [];

  async function signUpOwner() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(http)
      .post('/auth/registrations')
      .send({
        fullName: 'Stale Session Owner',
        email: `stale.session.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: `Stale Session Restaurant ${stamp}`,
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

  async function createSecondBranch(accessToken: string): Promise<string> {
    const brands = await request(http)
      .get('/org/brands')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const brandId = (brands.body as { id: string }[])[0].id;
    const res = await request(http)
      .post('/org/branches')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        brandId,
        code: `B2-${Date.now()}`.slice(0, 16),
        name: 'Second Branch',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function employeeBody(homeBranchId: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      code: `E-${stamp}`.slice(0, 32),
      displayName: 'Stale Session Cashier',
      homeBranchId,
      employmentType: 'full_time',
    };
  }

  async function createEmployee(accessToken: string, branchId: string) {
    const res = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    return res.body as { id: string; code: string; userId: string | null };
  }

  async function setPin(accessToken: string, employeeId: string, pin: string) {
    await request(http)
      .post(`/workforce/employees/${employeeId}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin })
      .expect(204);
  }

  async function pinLogin(
    tenantId: string,
    branchId: string,
    employeeCode: string,
    pin: string,
  ): Promise<string> {
    const res = await request(http)
      .post('/auth/pin')
      .send({ tenantId, branchId, employeeCode, pin, sessionType: 'pos' })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function roleIdByName(accessToken: string, name: string): Promise<string> {
    const res = await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const role = (res.body as { id: string; name: string }[]).find((r) => r.name === name);
    if (!role) throw new Error(`Canonical role "${name}" not seeded at signup`);
    return role.id;
  }

  async function replaceAssignment(
    accessToken: string,
    employeeId: string,
    roleId: string,
    scope: { type: 'tenant' } | { type: 'branch'; branchId: string },
  ) {
    const existing = await request(http)
      .get(`/workforce/employees/${employeeId}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    for (const row of existing.body as { id: string }[]) {
      await request(http)
        .delete(`/workforce/employees/${employeeId}/role-assignments/${row.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);
    }
    await request(http)
      .post(`/workforce/employees/${employeeId}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ roleId, scope })
      .expect(201);
  }

  const getCurrentSession = (token: string) =>
    request(http).get('/cash-sessions/current').set('Authorization', `Bearer ${token}`);

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
    prisma = app.get(PrismaService);
    admin = createMigratorClient(app);
    http = app.getHttpServer();
  }, 30_000);

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  it('addPermittedBranch bumps the membership authzEpoch atomically with the write', async () => {
    const { accessToken, branchId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);
    const otherBranchId = await createSecondBranch(accessToken);

    const membershipBefore = await admin.membership.findFirstOrThrow({
      where: { userId: employee.userId ?? undefined },
      select: { id: true, authzEpoch: true },
    });

    await request(http)
      .post(`/workforce/employees/${employee.id}/branches`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ branchId: otherBranchId })
      .expect(201);

    const membershipAfter = await admin.membership.findUniqueOrThrow({
      where: { id: membershipBefore.id },
      select: { authzEpoch: true },
    });
    expect(membershipAfter.authzEpoch).toBeGreaterThan(membershipBefore.authzEpoch);

    // Audit behaviour is unchanged — still one EMPLOYEE_BRANCH_ASSIGNED entry.
    const audit = await admin.auditEntry.findFirst({
      where: {
        entityId: employee.id,
        action: 'EMPLOYEE_BRANCH_ASSIGNED',
      },
      orderBy: { recordedAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  }, 30_000);

  it('a POS token minted BEFORE addPermittedBranch is detected as stale on its next request, then a fresh PIN sign-on recovers it — no RBAC data change required', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);
    await setPin(accessToken, employee.id, '1357');

    // 1) A token minted before the mutation, proven valid right now.
    const staleToken = await pinLogin(tenantId, branchId, employee.code, '1357');
    await getCurrentSession(staleToken).expect(200);

    // 2) The branch-context mutation under test — no role/permission change,
    // just widening which branch this employee may additionally work at.
    const otherBranchId = await createSecondBranch(accessToken);
    await request(http)
      .post(`/workforce/employees/${employee.id}/branches`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ branchId: otherBranchId })
      .expect(201);

    // 3) The SAME, still-unexpired token now fails — but with the DISTINCT
    // stale-snapshot message, never the generic scope-denial one a real
    // permission problem would produce.
    const stale = await getCurrentSession(staleToken).expect(403);
    const staleBody = stale.body as { message: string; error: string };
    expect(staleBody.message).toBe(STALE_SNAPSHOT_MESSAGE);
    expect(staleBody.message).not.toBe(GENERIC_DENIAL_MESSAGE);
    // A distinct label, not the generic "Forbidden" a real denial carries —
    // this is what the frontend gates its scoped re-auth prompt on.
    expect(staleBody.error).toBe('StaleAuthorizationSnapshot');

    // 4) A fresh PIN sign-on — no RBAC/database write beyond what already
    // happened in step 2 — mints a token with the current epoch and succeeds.
    const freshToken = await pinLogin(tenantId, branchId, employee.code, '1357');
    await getCurrentSession(freshToken).expect(200);
  }, 30_000);

  it('a genuinely unauthorized session still receives the real, generic denial — never STALE_SNAPSHOT', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);
    await setPin(accessToken, employee.id, '2468');

    // Kitchen Staff holds kds.operate only — never cash.session.open.
    const kitchenRoleId = await roleIdByName(accessToken, 'Kitchen Staff');
    await replaceAssignment(accessToken, employee.id, kitchenRoleId, {
      type: 'branch',
      branchId,
    });

    const token = await pinLogin(tenantId, branchId, employee.code, '2468');
    const res = await getCurrentSession(token).expect(403);
    const body = res.body as { message: string; error: string };
    expect(body.message).toBe(GENERIC_DENIAL_MESSAGE);
    expect(body.message).not.toBe(STALE_SNAPSHOT_MESSAGE);
    expect(body.error).not.toBe('StaleAuthorizationSnapshot');
  }, 30_000);

  it('an unrelated employee profile edit does not invalidate an existing session', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();
    const employee = await createEmployee(accessToken, branchId);
    await setPin(accessToken, employee.id, '9999');

    const token = await pinLogin(tenantId, branchId, employee.code, '9999');
    await getCurrentSession(token).expect(200);

    // A plain FR-HRM-001 profile edit — never touches code/homeBranchId/status.
    await request(http)
      .patch(`/workforce/employees/${employee.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ position: 'Senior Cashier' })
      .expect(200);

    // The same, still-open token keeps working — no forced re-authentication
    // over a change with no authorization relevance.
    await getCurrentSession(token).expect(200);
  }, 30_000);
});
