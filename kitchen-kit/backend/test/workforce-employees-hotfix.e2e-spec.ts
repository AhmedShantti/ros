import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * LIVE-DEMO-HOTFIX-1 — a POS employee created through the real Workforce
 * Employees surface must be able to log in via `POST /auth/pin`, and the
 * Owner must be able to list employees. Exercises ONLY real HTTP routes; no
 * `seed-dev-data.ts` import anywhere in this file.
 */

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Workforce employees + PIN login hotfix (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;

  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  async function signUpOwner() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(http)
      .post('/auth/registrations')
      .send({
        fullName: 'Hotfix E2E Owner',
        email: `hotfix.e2e.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: `Hotfix E2E Restaurant ${stamp}`,
        password: 's3cure-passphrase-10+',
      })
      .expect(201);
    const out = res.body as {
      auth: { accessToken: string; user: { id: string } };
      tenant: { id: string };
    };
    createdTenantIds.push(out.tenant.id);
    createdUserIds.push(out.auth.user.id);

    const branches = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${out.auth.accessToken}`)
      .expect(200);
    const branchId = (branches.body as { id: string }[])[0].id;

    return {
      tenantId: out.tenant.id,
      accessToken: out.auth.accessToken,
      branchId,
    };
  }

  async function registerTerminal(accessToken: string, branchId: string) {
    const res = await request(http)
      .post('/auth/terminals')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `POS-${Date.now()}`, terminalType: 'pos', branchId })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function employeeBody(homeBranchId: string, overrides: Record<string, unknown> = {}) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      code: `E-${stamp}`.slice(0, 32),
      displayName: 'Hotfix Test Employee',
      homeBranchId,
      employmentType: 'full_time',
      ...overrides,
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
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { id: { in: createdUserIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('owner can list employees, including one just created without a userId', async () => {
    const { accessToken, branchId } = await signUpOwner();

    const created = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    const employee = created.body as {
      id: string;
      userId: string | null;
      permittedBranchIds: string[];
    };
    expect(employee.userId).toEqual(expect.any(String));
    expect(employee.permittedBranchIds).toContain(branchId);

    const list = await request(http)
      .get('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const ids = (list.body as { id: string }[]).map((e) => e.id);
    expect(ids).toContain(employee.id);
  });

  it('employee update path (no code/homeBranchId/status change) still works for an auto-provisioned employee', async () => {
    const { accessToken, branchId } = await signUpOwner();
    const created = await request(http)
      .post('/workforce/employees')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send(employeeBody(branchId))
      .expect(201);
    const employee = created.body as { id: string };

    const updated = await request(http)
      .patch(`/workforce/employees/${employee.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ position: 'Cashier' })
      .expect(200);
    expect((updated.body as { position: string }).position).toBe('Cashier');
  });

  it('full create -> set-PIN -> PIN-login round trip succeeds end to end', async () => {
    const { accessToken, branchId, tenantId } = await signUpOwner();
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

    const login = await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '4321' })
      .expect(200);
    expect((login.body as { tokenType: string }).tokenType).toBe('Bearer');
  });

  it('wrong PIN still returns 401', async () => {
    const { accessToken, branchId, tenantId } = await signUpOwner();
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

    await request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode: employee.code, pin: '9999' })
      .expect(401);
  });

  it('a terminal registered to a branch NOT in the employee permitted set is rejected', async () => {
    const { accessToken, branchId, tenantId } = await signUpOwner();

    // Second branch, so a terminal there is genuinely outside the employee's
    // permitted set.
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

    const wrongBranchTerminalId = await registerTerminal(accessToken, otherBranchId);

    await request(http)
      .post('/auth/pin')
      .send({
        tenantId,
        terminalId: wrongBranchTerminalId,
        employeeCode: employee.code,
        pin: '4321',
      })
      .expect(401);
  });
});
