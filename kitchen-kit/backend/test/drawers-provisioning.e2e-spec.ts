import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * DEMO-OPS-HOTFIX-3 (Part B) — a real, HTTP-reachable Drawer administration
 * surface (`branches/:branchId/drawers`), and the Cashier-facing counterpart
 * (`GET /cash-sessions/drawers`) that resolves the branch from the caller's
 * OWN terminal. Proves the actual reported blocker end to end: an Owner
 * provisions a real drawer, and a Cashier's `POST /cash-sessions` succeeds
 * against it (no more "404 Drawer not found").
 */

function idemKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Drawer provisioning + cashier shift-open (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;

  const createdTenantIds: string[] = [];

  async function signUpOwner() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(http)
      .post('/auth/registrations')
      .send({
        fullName: 'Drawer Hotfix Owner',
        email: `drawer.hotfix.${stamp}@example.com`,
        roleKey: 'owner',
        organisation: `Drawer Hotfix Restaurant ${stamp}`,
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
      displayName: 'Drawer Hotfix Cashier',
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
  });

  afterAll(async () => {
    await prisma.tenant
      .deleteMany({ where: { id: { in: createdTenantIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('owner creates a real drawer; it persists through GET and a simulated reload', async () => {
    const { accessToken, branchId } = await signUpOwner();

    const created = await request(http)
      .post(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ name: 'Main Drawer' })
      .expect(201);
    const drawer = created.body as { id: string; name: string; isActive: boolean };
    expect(drawer.name).toBe('Main Drawer');
    expect(drawer.isActive).toBe(true);

    const list1 = await request(http)
      .get(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect((list1.body as { id: string }[]).map((d) => d.id)).toEqual(
      expect.arrayContaining([drawer.id]),
    );

    // Simulated reload: a fresh, independent GET.
    const list2 = await request(http)
      .get(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect((list2.body as { id: string }[]).map((d) => d.id)).toEqual(
      expect.arrayContaining([drawer.id]),
    );
  });

  it('a Cashier can list their own branch drawers and open a shift over one (201, no more 404)', async () => {
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

    const sessionDrawers = await request(http)
      .get('/cash-sessions/drawers')
      .set('Authorization', `Bearer ${posToken}`)
      .expect(200);
    const rows = sessionDrawers.body as { id: string; name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Main Drawer');

    const opened = await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: rows[0].id,
        openingFloat: '50000',
      });
    if (opened.status !== 201) {
      throw new Error(
        `expected open to succeed with a real drawer, got ${opened.status}: ${JSON.stringify(opened.body)}`,
      );
    }
  });

  it('a wrong-branch drawer is rejected (404) when opening a shift', async () => {
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

    const otherDrawer = (
      await request(http)
        .post(`/branches/${otherBranchId}/drawers`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', idemKey())
        .send({ name: 'Other Branch Drawer' })
        .expect(201)
    ).body as { id: string };

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

    await request(http)
      .post('/cash-sessions')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({
        shiftId: newId(),
        cashSessionId: newId(),
        drawerId: otherDrawer.id,
        openingFloat: '50000',
      })
      .expect(404);
  });

  it('a Cashier (POS session) cannot administer drawers', async () => {
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
    const posToken = (login.body as { accessToken: string }).accessToken;

    await request(http)
      .post(`/branches/${branchId}/drawers`)
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', idemKey())
      .send({ name: 'Cashier Drawer Attempt' })
      .expect((res) => {
        if (![401, 403].includes(res.status)) {
          throw new Error(`expected 401 or 403, got ${res.status}`);
        }
      });
  });

  it('cross-tenant drawer access is rejected (404)', async () => {
    const ownerA = await signUpOwner();
    const ownerB = await signUpOwner();

    const drawerA = (
      await request(http)
        .post(`/branches/${ownerA.branchId}/drawers`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .set('Idempotency-Key', idemKey())
        .send({ name: 'Tenant A Drawer' })
        .expect(201)
    ).body as { id: string };

    await request(http)
      .get(`/branches/${ownerA.branchId}/drawers`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);

    void drawerA;
  });
});
