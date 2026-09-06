import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { AuditService } from './../src/modules/governance/audit/audit.service';

/**
 * SIGNUP-1 (FR-PLT-020) — public tenant self-service signup.
 *
 * Exercises ONLY the real HTTP route + service layer — no `seed-dev-data.ts`
 * import anywhere in this file, matching the mission's requirement that
 * production signup must not depend on the dev/demo seed script.
 */
describe('Registrations / tenant self-service signup (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: App;

  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  const password = 's3cure-passphrase-10+';

  function signupBody(overrides: Record<string, unknown> = {}) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      fullName: 'Signup E2E Owner',
      email: `signup.e2e.${stamp}@example.com`,
      roleKey: 'owner',
      organisation: `Signup E2E Restaurant ${stamp}`,
      password,
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

  it('happy path: creates user + tenant + branch + owner role, and returns a usable scoped token', async () => {
    const body = signupBody();
    const res = await request(http)
      .post('/auth/registrations')
      .send(body)
      .expect(201);

    const out = res.body as {
      status: string;
      email: string;
      auth: {
        tokenType: string;
        accessToken: string;
        refreshToken: string;
        user: Record<string, unknown>;
      };
      tenant: { id: string; slug: string; legalName: string };
      membership: { membershipId: string; status: string };
    };
    expect(out.status).toBe('created');
    expect(out.email).toBe(body.email.toLowerCase());
    expect(out.auth.tokenType).toBe('Bearer');
    expect(typeof out.auth.accessToken).toBe('string');
    expect(out.auth.user).not.toHaveProperty('secretHash');
    expect(out.tenant.legalName).toBe(body.organisation);
    expect(out.membership.status).toBe('active');

    createdTenantIds.push(out.tenant.id);
    createdUserIds.push(out.auth.user.id as string);

    // Password usable via normal login (proves it was hashed AND stored, not
    // just accepted).
    const login = await request(http)
      .post('/auth/login')
      .send({ email: body.email, password })
      .expect(200);
    expect(login.body).toMatchObject({ tokenType: 'Bearer' });

    // Password never stored plaintext — the stored credential is an Argon2id
    // hash, never a match against the plaintext password itself.
    const credential = await prisma.credential.findUnique({
      where: {
        userId_credentialType: {
          userId: out.auth.user.id as string,
          credentialType: 'password',
        },
      },
    });
    expect(credential?.secretHash).toBeDefined();
    expect(credential?.secretHash).not.toBe(password);
    expect(credential?.secretHash?.startsWith('$argon2id$')).toBe(true);

    // Tenant created with the expected defaults.
    const tenantRow = await prisma.tenant.findUnique({
      where: { id: out.tenant.id },
    });
    expect(tenantRow?.legalName).toBe(body.organisation);
    expect(tenantRow?.countryPackCode).toBe('EG');

    // First branch created and usable.
    const branches = await request(http)
      .get('/org/branches')
      .set('Authorization', `Bearer ${out.auth.accessToken}`)
      .expect(200);
    expect((branches.body as unknown[]).length).toBe(1);
    expect((branches.body as { name: string }[])[0].name).toBe('Main');

    // Owner effective permissions include the full catalog (non-empty and
    // sizeable — proves the production-safe permission bootstrap ran).
    const perms = await request(http)
      .get('/auth/permissions')
      .set('Authorization', `Bearer ${out.auth.accessToken}`)
      .expect(200);
    const permsBody = perms.body as { permissions: string[] };
    expect(permsBody.permissions.length).toBeGreaterThan(20);
    expect(permsBody.permissions).toContain('identity.role.assign');

    // GET /org/access works using the resulting scoped auth.
    await request(http)
      .get('/org/access')
      .set('Authorization', `Bearer ${out.auth.accessToken}`)
      .expect(200);
  });

  it('rejects a non-owner roleKey with 400, without creating any tenant/user', async () => {
    const body = signupBody({ roleKey: 'cashier' });
    const before = await prisma.tenant.count();
    await request(http).post('/auth/registrations').send(body).expect(400);
    const existing = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
    });
    expect(existing).toBeNull();
    expect(await prisma.tenant.count()).toBe(before);
  });

  it('duplicate email is rejected with 409 and creates no partial tenant', async () => {
    const body = signupBody();
    const first = await request(http)
      .post('/auth/registrations')
      .send(body)
      .expect(201);
    createdTenantIds.push((first.body as { tenant: { id: string } }).tenant.id);
    createdUserIds.push(
      (first.body as { auth: { user: { id: string } } }).auth.user.id,
    );

    const tenantCountBefore = await prisma.tenant.count();
    await request(http)
      .post('/auth/registrations')
      .send(signupBody({ email: body.email, organisation: 'Different Org Name' }))
      .expect(409);
    expect(await prisma.tenant.count()).toBe(tenantCountBefore);
  });

  it('validation rejects unknown/malformed fields', async () => {
    await request(http)
      .post('/auth/registrations')
      .send(signupBody({ notAField: 'nope' }))
      .expect(400);
    await request(http)
      .post('/auth/registrations')
      .send(signupBody({ password: 'short' }))
      .expect(400);
    await request(http)
      .post('/auth/registrations')
      .send(signupBody({ email: 'not-an-email' }))
      .expect(400);
  });

  it('a mid-flow failure rolls back every row created so far (no partial tenant)', async () => {
    const audit = app.get(AuditService);
    const spy = jest
      .spyOn(audit, 'record')
      .mockImplementationOnce(async () => {
        throw new Error('forced mid-flow failure for rollback proof');
      });

    const body = signupBody();
    await request(http).post('/auth/registrations').send(body).expect(500);
    spy.mockRestore();

    const user = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
    });
    expect(user).toBeNull();
    const tenant = await prisma.tenant.findFirst({
      where: { legalName: body.organisation },
    });
    expect(tenant).toBeNull();
  });

  it('two independent signups produce two fully isolated tenants', async () => {
    const bodyA = signupBody();
    const bodyB = signupBody();
    const resA = await request(http)
      .post('/auth/registrations')
      .send(bodyA)
      .expect(201);
    const resB = await request(http)
      .post('/auth/registrations')
      .send(bodyB)
      .expect(201);

    const outA = resA.body as {
      tenant: { id: string };
      auth: { accessToken: string; user: { id: string } };
    };
    const outB = resB.body as {
      tenant: { id: string };
      auth: { accessToken: string; user: { id: string } };
    };
    createdTenantIds.push(outA.tenant.id, outB.tenant.id);
    createdUserIds.push(outA.auth.user.id, outB.auth.user.id);

    expect(outA.tenant.id).not.toBe(outB.tenant.id);

    // Cross-tenant isolation: A's scoped token cannot select/see B's tenant.
    const listA = await request(http)
      .get('/auth/tenants')
      .set('Authorization', `Bearer ${outA.auth.accessToken}`)
      .expect(200);
    const tenantIdsForA = (listA.body as { tenant: { id: string } }[]).map(
      (m) => m.tenant.id,
    );
    expect(tenantIdsForA).toContain(outA.tenant.id);
    expect(tenantIdsForA).not.toContain(outB.tenant.id);
  });

  it('auth throttling applies to the signup endpoint', async () => {
    // Matches the e2e run's configured AUTH_THROTTLE_LIMIT (test/setup-e2e.ts
    // sets 50; the production-safe code default of 10 is stricter) — see
    // `test/throttle.e2e-spec.ts`'s own IP-keyed refresh case for the pattern.
    const LIMIT = 50;
    for (let i = 0; i < LIMIT; i++) {
      await request(http)
        .post('/auth/registrations')
        .send(signupBody({ password: 'short' })); // fails validation fast, still counted by IP
    }
    await request(http)
      .post('/auth/registrations')
      .send(signupBody({ password: 'short' }))
      .expect(429);
  });
});
