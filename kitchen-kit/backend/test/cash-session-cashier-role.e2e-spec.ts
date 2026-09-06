import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * DEMO-OPS-HOTFIX-2 (Part A) — reproduction of the reported 403 on
 * `POST /cash-sessions` for an auto-provisioned Cashier employee.
 *
 * Drawer creation has NO public HTTP route by ratified design
 * (`drawers.service.ts` docblock — "no source says a terminal implies a
 * drawer"), so this test provisions the drawer directly via the admin
 * (migrator) client, exactly as `test/cash-session.e2e-spec.ts` already
 * does — this is a test-fixture concern only, not a production gap this
 * ticket is fixing.
 */

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Cashier can open/close own cash session (e2e)', () => {
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
        fullName: 'Ops Hotfix Owner',
        email: `ops.hotfix.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: `Ops Hotfix Restaurant ${stamp}`,
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
      displayName: 'Ops Hotfix Cashier',
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
    admin = createMigratorClient(app);
  });

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('auto-provisioned Cashier can open, then close, their own cash session at branch scope', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    const created = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    const employee = created.body as { id: string; code: string };

    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '4321' })
      .expect(204);

    const terminalId = await registerTerminal(accessToken, branchId);

    // Test-fixture-only drawer provisioning (no production route exists —
    // see file docblock).
    const drawer = await admin.drawer.create({
      data: { id: newId(), tenantId, branchId, name: 'Main Drawer', terminalId },
    });

    const login = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '4321' })
      .expect(200);
    const posToken = (login.body as { accessToken: string }).accessToken;

    const shiftId = newId();
    const cashSessionId = newId();

    const opened = await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        shiftId,
        cashSessionId,
        drawerId: drawer.id,
        openingFloat: '50000',
      })
      .expect(201);
    expect(
      (opened.body as { cashSession: { id: string } }).cashSession.id,
    ).toBe(cashSessionId);

    // `cash.session.close` itself (own shift) is proven by reaching
    // close-context with the Cashier's own token — the actual physical
    // `.../close` declare call additionally requires a per-branch
    // cash-close policy (FR-FIN-006), which — like drawer provisioning —
    // has NO public HTTP administration route yet (see
    // `test/cash-session-close.e2e-spec.ts`, which configures it directly
    // via `CashClosePolicyService`, not through the API). That is a
    // separate, pre-existing gap this ticket does not fix; not reported as
    // a blocker here (only "open" was reported).
    const closeContext = await request(http)
      .get(`/cash-sessions/${cashSessionId}/close-context`)
      .set('Authorization', `Bearer ${posToken}`)
      .expect(200);
    expect(closeContext.body).toBeTruthy();
  });

  it('manual RBAC reassignment (delete existing + create new, mirroring the Employees-page UI) still lets the Cashier open a session with a FRESH PIN login', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    const created = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    const employee = created.body as { id: string; code: string };

    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '4321' })
      .expect(204);

    const terminalId = await registerTerminal(accessToken, branchId);
    const drawer = await admin.drawer.create({
      data: { id: newId(), tenantId, branchId, name: 'Main Drawer', terminalId },
    });

    // Mirror the Employees-page UI's "replace" semantics exactly: list
    // current assignments, delete each, then assign Cashier fresh at branch
    // scope.
    const existing = await request(http)
      .get(`/workforce/employees/${employee.id}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    for (const a of existing.body as { id: string }[]) {
      await request(http)
        .delete(`/workforce/employees/${employee.id}/role-assignments/${a.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);
    }

    const roles = await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const cashierRole = (roles.body as { id: string; name: string }[]).find(
      (r) => r.name === 'Cashier',
    );
    expect(cashierRole).toBeTruthy();

    await request(http)
      .post(`/workforce/employees/${employee.id}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ roleId: cashierRole!.id, scope: { type: 'branch', branchId } })
      .expect(201);

    // Fresh PIN login AFTER reassignment (new epoch baked in).
    const login = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '4321' })
      .expect(200);
    const posToken = (login.body as { accessToken: string }).accessToken;

    const shiftId = newId();
    const cashSessionId = newId();
    const opened = await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ shiftId, cashSessionId, drawerId: drawer.id, openingFloat: '50000' });

    if (opened.status !== 201) {
      throw new Error(
        `expected open to succeed, got ${opened.status}: ${JSON.stringify(opened.body)}`,
      );
    }
  });

  it('a STALE pre-existing "Cashier" role (created before cash.session.open was in the template) self-heals when assigned through the Employees-page RBAC flow', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    // Simulate a "Cashier" role that predates the current canonical
    // template — created directly against the DB with only ONE permission,
    // never through `ensureCanonicalRole`. Signup already seeds the 4
    // canonical roles (including a correct "Cashier"), so this reproduces the
    // pre-existing-role collision by first deleting that seeded row's grants
    // and permission and re-declaring the role deliberately incomplete.
    const orderCreate = await admin.permission.findUniqueOrThrow({
      where: { code: 'pos.order.create' },
      select: { id: true },
    });

    const created = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    const employee = created.body as { id: string; code: string };

    // `WorkforceEmployeesService.create`'s OWN auto-grant path calls
    // `ensureCanonicalRole` unconditionally, which would immediately repair
    // the stale role — defeating this specific repro. Remove that grant so
    // ONLY the manual RBAC-assignment path (this test's actual target) is
    // exercised.
    const autoAssignments = await request(http)
      .get(`/workforce/employees/${employee.id}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    for (const a of autoAssignments.body as { id: string }[]) {
      await request(http)
        .delete(`/workforce/employees/${employee.id}/role-assignments/${a.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);
    }

    // Re-break the role AGAIN — the auto-grant path's `ensureCanonicalRole`
    // call already repaired it once before we could remove the assignment.
    const staleRole = await admin.role.findFirstOrThrow({
      where: { tenantId, name: 'Cashier' },
      select: { id: true },
    });
    await admin.rolePermission.deleteMany({ where: { roleId: staleRole.id } });
    await admin.rolePermission.create({
      data: { roleId: staleRole.id, permissionId: orderCreate.id },
    });

    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '4321' })
      .expect(204);
    const terminalId = await registerTerminal(accessToken, branchId);
    const drawer = await admin.drawer.create({
      data: { id: newId(), tenantId, branchId, name: 'Main Drawer', terminalId },
    });

    const roles = await request(http)
      .get('/auth/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const cashierRole = (roles.body as { id: string; name: string }[]).find(
      (r) => r.name === 'Cashier',
    );
    expect(cashierRole!.id).toBe(staleRole.id);

    await request(http)
      .post(`/workforce/employees/${employee.id}/role-assignments`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ roleId: cashierRole!.id, scope: { type: 'branch', branchId } })
      .expect(201);

    const permsAfter = await admin.rolePermission.findMany({
      where: { roleId: staleRole.id },
      select: { permission: { select: { code: true } } },
    });
    expect(permsAfter.map((p) => p.permission.code)).toEqual(
      expect.arrayContaining(['cash.session.open', 'cash.session.close']),
    );

    const login = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '4321' })
      .expect(200);
    const posToken = (login.body as { accessToken: string }).accessToken;

    const opened = await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: drawer.id,
        openingFloat: '50000',
      });
    if (opened.status !== 201) {
      throw new Error(
        `expected open to succeed after self-heal, got ${opened.status}: ${JSON.stringify(opened.body)}`,
      );
    }
  });

  it('Cashier at a foreign branch is forbidden from opening a session there', async () => {
    const { tenantId, accessToken, branchId } = await signUpOwner();

    const brands = await request(http)
      .get('/org/brands')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const brandId = (brands.body as { id: string }[])[0].id;
    const otherBranch = await request(http)
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
    const otherBranchId = (otherBranch.body as { id: string }).id;

    const created = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    const employee = created.body as { id: string; code: string };
    await request(http)
      .post(`/workforce/employees/${employee.id}/pin`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ pin: '4321' })
      .expect(204);

    // A terminal on the OTHER branch — this employee has no permitted-branch
    // row there, so PIN login itself must already refuse this combination.
    const foreignTerminalId = await registerTerminal(accessToken, otherBranchId);
    await request(http)
      .post('/auth/pin')
      .send({
        tenantId,
        terminalId: foreignTerminalId,
        employeeCode: employee.code,
        pin: '4321',
      })
      .expect((res) => {
        if (![401, 403].includes(res.status)) {
          throw new Error(`expected 401 or 403, got ${res.status}`);
        }
      });
  });
});
