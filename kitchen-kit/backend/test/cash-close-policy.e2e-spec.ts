import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import { CashClosePolicyResolver } from './../src/modules/treasury/cash-close-policy/cash-close-policy.resolver';
import { TREASURY_PERMISSIONS } from './../src/modules/treasury/treasury.permissions';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * P1G-1 migration 33 — Treasury cash-close policy substrate.
 *
 * Authority: `docs/reports/claude/2026-08-30_P1G1_variance-settings-final-design-gate.md`,
 * ratified by the "P1G-1 Cash-Close Policy Ratification — 2026-08-30" register
 * entry (R-1(a)..R-5, C-1, C-2).
 *
 * This is a DASHBOARD/back-office route — no POS/PIN session, no terminal,
 * no employee. A tenant-scoped JWT with `settings.branch.manage` is
 * sufficient, exactly like Organisation's own branch-admin routes.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const shortStamp = stamp.toString().slice(-6);

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}
interface CcpBody {
  id: string;
  branchId: string;
  effectiveFrom: string;
  countMode: 'blind' | 'open';
  varianceToleranceMinorUnits: string;
  currency: string;
  varianceApprovalExpirySeconds: number;
  createdBy: string;
  createdAt: string;
}
const bodyOf = (res: { body: unknown }): CcpBody => res.body as CcpBody;

describe('Cash-close policy (e2e) — P1G-1 migration 33', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let appPrisma: PrismaService;
  let resolver: CashClosePolicyResolver;

  let tenantA: string;
  let tenantB: string;
  let branchA: string;
  let branchA2: string;
  let branchB: string;

  let managerTokenA: string;
  let noPermTokenA: string;
  let managerTokenB: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const scoped = async (email: string, tenantId: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .send({ tenantId })
      .expect(200);
    return (sel.body as Tokens).accessToken;
  };

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
    admin = createMigratorClient(app);
    http = app.getHttpServer();
    appPrisma = app.get(PrismaService);
    resolver = app.get(CashClosePolicyResolver);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    tenantA = (
      await tenants.create({
        slug: `ccp-a-${stamp}`,
        legalName: 'CCP Tenant A',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `ccp-b-${stamp}`,
        legalName: 'CCP Tenant B',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mk = async (
      email: string,
      tenantId: string,
      codes: string[],
    ): Promise<void> => {
      const u = await users.createUser({ email, password, displayName: 'C' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length > 0) {
        const role = await roles.createTenantRole(tenantId, {
          name: `ccp-role-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.create(tenantId, null, {
      membershipId: m.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });
      }
    };

    const emailManagerA = `ccp.managerA.${stamp}@example.com`;
    const emailNoPermA = `ccp.noPermA.${stamp}@example.com`;
    const emailManagerB = `ccp.managerB.${stamp}@example.com`;

    // The manager role needs BRANCH_MANAGE (to create the branch fixture via
    // /org) as well as the SETTINGS_BRANCH_MANAGE literal this route guards
    // on — both resolve to the SAME already-seeded code
    // ('settings.branch.manage'), proven identical below.
    expect(TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE).toBe(
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    );

    await mk(emailManagerA, tenantA, [
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    ]);
    await mk(emailNoPermA, tenantA, []);
    await mk(emailManagerB, tenantB, [
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    ]);

    managerTokenA = await scoped(emailManagerA, tenantA);
    noPermTokenA = await scoped(emailNoPermA, tenantA);
    managerTokenB = await scoped(emailManagerB, tenantB);

    const seedBranch = async (
      token: string,
      code: string,
      baseCurrency = 'EGP',
    ): Promise<string> => {
      const brand = (
        await request(http)
          .post('/org/brands')
          .set(auth(token))
          .send({ name: `Brand ${code}` })
          .expect(201)
      ).body as WithId;
      const branch = (
        await request(http)
          .post('/org/branches')
          .set(auth(token))
          .send({
            brandId: brand.id,
            code,
            name: `Branch ${code}`,
            timezone: 'Africa/Cairo',
            baseCurrency,
            countryCode: 'EG',
          })
          .expect(201)
      ).body as WithId;
      return branch.id;
    };

    branchA = await seedBranch(managerTokenA, `CCPA${shortStamp}`);
    branchA2 = await seedBranch(managerTokenA, `CCPA2${shortStamp}`, 'USD');
    branchB = await seedBranch(managerTokenB, `CCPB${shortStamp}`);
  }, 60000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  let idemCounter = 0;
  const idemKey = () => `ccp-${stamp}-${++idemCounter}`;

  const createPolicy = (
    token: string,
    branchId: string,
    body: Record<string, unknown>,
    idempotencyKey = idemKey(),
  ) =>
    request(http)
      .post(`/branches/${branchId}/cash-close-policy`)
      .set(auth(token))
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

  // ============================================================ AUTHZ
  describe('authorization', () => {
    it('23: route without settings.branch.manage -> 403', async () => {
      await createPolicy(noPermTokenA, branchA, {
        varianceToleranceMinorUnits: '1000',
        varianceApprovalExpirySeconds: 300,
      }).expect(403);
    });

    it('24: route with settings.branch.manage -> success + exactly one audit entry', async () => {
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '1500',
        varianceApprovalExpirySeconds: 300,
      }).expect(201);
      expect(bodyOf(res).id).toBeDefined();
      expect(bodyOf(res).branchId).toBe(branchA);

      const entries = await admin.auditEntry.findMany({
        where: {
          tenantId: tenantA,
          entityType: 'cash_close_policy',
          entityId: bodyOf(res).id,
        },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('CASH_CLOSE_POLICY_VERSION_CREATED');
    });
  });

  // ============================================================ IDEMPOTENCY
  describe('idempotency (FR-API-020)', () => {
    it('25: same Idempotency-Key replay -> exactly one row + one audit + stored response replay', async () => {
      const key = idemKey();
      const body = {
        varianceToleranceMinorUnits: '2000',
        varianceApprovalExpirySeconds: 600,
      };
      const first = await createPolicy(
        managerTokenA,
        branchA,
        body,
        key,
      ).expect(201);
      const replay = await createPolicy(
        managerTokenA,
        branchA,
        body,
        key,
      ).expect(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body).toEqual(first.body);

      const rows = await admin.cashClosePolicy.findMany({
        where: { id: bodyOf(first).id },
      });
      expect(rows).toHaveLength(1);
      const auditRows = await admin.auditEntry.findMany({
        where: {
          tenantId: tenantA,
          entityType: 'cash_close_policy',
          entityId: bodyOf(first).id,
        },
      });
      expect(auditRows).toHaveLength(1);
    });

    it('26: Idempotency-Key fingerprint mismatch -> repository-standard 409', async () => {
      const key = idemKey();
      await createPolicy(
        managerTokenA,
        branchA,
        {
          varianceToleranceMinorUnits: '100',
          varianceApprovalExpirySeconds: 60,
        },
        key,
      ).expect(201);
      await createPolicy(
        managerTokenA,
        branchA,
        {
          varianceToleranceMinorUnits: '999',
          varianceApprovalExpirySeconds: 60,
        },
        key,
      ).expect(409);
    });

    it('missing Idempotency-Key -> 400', async () => {
      await request(http)
        .post(`/branches/${branchA}/cash-close-policy`)
        .set(auth(managerTokenA))
        .send({
          varianceToleranceMinorUnits: '100',
          varianceApprovalExpirySeconds: 60,
        })
        .expect(400);
    });
  });

  // ============================================================ VALIDATION
  describe('input validation', () => {
    it('12: tolerance zero is valid', async () => {
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '0',
        varianceApprovalExpirySeconds: 60,
      }).expect(201);
      expect(bodyOf(res).varianceToleranceMinorUnits).toBe('0');
    });

    it('13: positive tolerance persists exactly as an integer string (large value, no float drift)', async () => {
      const big = '9007199254740995'; // > Number.MAX_SAFE_INTEGER
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: big,
        varianceApprovalExpirySeconds: 60,
      }).expect(201);
      expect(bodyOf(res).varianceToleranceMinorUnits).toBe(big);
    });

    it('14: expiry seconds <= 0 rejected', async () => {
      await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 0,
      }).expect(400);
      await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: -5,
      }).expect(400);
    });

    it('15: negative tolerance rejected', async () => {
      await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '-100',
        varianceApprovalExpirySeconds: 60,
      }).expect(400);
    });

    it('16: currency cannot be client-supplied (whitelist); the branch base currency is used', async () => {
      await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
        currency: 'USD',
      }).expect(400);

      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
      }).expect(201);
      expect(bodyOf(res).currency).toBe('EGP'); // branchA's base currency

      const resUsd = await createPolicy(managerTokenA, branchA2, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
      }).expect(201);
      expect(bodyOf(resUsd).currency).toBe('USD'); // branchA2's own base currency
    });

    it('20: backdated effectiveFrom rejected (app-level 400 AND DB CHECK)', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
        effectiveFrom: past,
      }).expect(400);

      // Prove the DB CHECK is the actual boundary, not merely the app
      // validator: attempt the identical backdated INSERT directly as
      // ros_app, bypassing the service entirely.
      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            INSERT INTO "treasury"."cash_close_policies" (
              "id", "tenant_id", "branch_id", "effective_from", "count_mode",
              "variance_tolerance_minor_units", "currency",
              "variance_approval_expiry_seconds", "created_by"
            ) VALUES (
              ${newId()}::uuid, ${tenantA}::uuid, ${branchA}::uuid,
              ${past}::timestamptz, 'blind'::"treasury"."CashCountMode",
              100, 'EGP', 60, ${newId()}::uuid
            )
          `,
        ),
      ).rejects.toThrow();
    });

    it('"effective immediately" — omitted effectiveFrom satisfies effective_from >= created_at using DB time only', async () => {
      const before = new Date();
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
      }).expect(201);
      const after = new Date();
      const row = await admin.cashClosePolicy.findUniqueOrThrow({
        where: { id: bodyOf(res).id },
      });
      expect(row.effectiveFrom.getTime()).toBe(row.createdAt.getTime());
      expect(row.effectiveFrom.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 2000,
      );
      expect(row.effectiveFrom.getTime()).toBeLessThanOrEqual(
        after.getTime() + 2000,
      );
    });

    it('future effectiveFrom is accepted (explicit future activation)', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
        effectiveFrom: future,
      }).expect(201);
      expect(new Date(bodyOf(res).effectiveFrom).toISOString()).toBe(future);
    });
  });

  // ============================================================ COUNT MODE
  describe('count mode (FR-POS-094/095)', () => {
    it('10: no policy for a branch -> resolver returns blind default', async () => {
      const freshBrand = (
        await request(http)
          .post('/org/brands')
          .set(auth(managerTokenA))
          .send({ name: `Brand fresh ${stamp}` })
          .expect(201)
      ).body as WithId;
      const freshBranch = (
        await request(http)
          .post('/org/branches')
          .set(auth(managerTokenA))
          .send({
            brandId: freshBrand.id,
            code: `CCPFR${shortStamp}`,
            name: 'Fresh branch',
            timezone: 'Africa/Cairo',
            baseCurrency: 'EGP',
            countryCode: 'EG',
          })
          .expect(201)
      ).body as WithId;

      const mode = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolveCountMode(tx, {
            tenantId: tenantA,
            branchId: freshBranch.id,
            asOf: new Date(),
          }),
      );
      expect(mode).toBe('blind');

      const policy = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolve(tx, {
            tenantId: tenantA,
            branchId: freshBranch.id,
            asOf: new Date(),
          }),
      );
      expect(policy).toBeNull();
    });

    it('default countMode omitted -> policy resolves to blind', async () => {
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
      }).expect(201);
      expect(bodyOf(res).countMode).toBe('blind');
    });

    it('11: explicit open policy resolves to open', async () => {
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '100',
        varianceApprovalExpirySeconds: 60,
        countMode: 'open',
      }).expect(201);
      expect(bodyOf(res).countMode).toBe('open');

      // `asOf` is intentionally a few ms AFTER the returned `effectiveFrom`,
      // not equal to it: `effectiveFrom` round-trips through a JSON ISO
      // string (millisecond precision) while the DB stores
      // `TIMESTAMPTZ(6)` (microsecond precision), so an "immediate"
      // creation's true `effective_from` can carry sub-millisecond digits
      // the JS `Date` truncated away. A small forward margin avoids
      // asserting on that exact boundary while still proving the resolved
      // policy is the one just created (test 9/22 below covers the
      // boundary/history semantics precisely, using DB-authoritative values
      // throughout).
      const asOf = new Date(Date.parse(bodyOf(res).effectiveFrom) + 50);
      const mode = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolveCountMode(tx, {
            tenantId: tenantA,
            branchId: branchA,
            asOf,
          }),
      );
      expect(mode).toBe('open');
    });
  });

  // ============================================================ RESOLVER
  describe('resolver — effective versioning (R-3(a))', () => {
    it('3/4: one applicable branch policy resolves; two branches resolve independently', async () => {
      const t = new Date(Date.now() + 10_000).toISOString();
      const resA = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '111',
        varianceApprovalExpirySeconds: 61,
        effectiveFrom: t,
      }).expect(201);
      const resA2 = await createPolicy(managerTokenA, branchA2, {
        varianceToleranceMinorUnits: '222',
        varianceApprovalExpirySeconds: 62,
        effectiveFrom: t,
      }).expect(201);

      const asOf = new Date(Date.parse(t) + 1000);
      const policyA = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolve(tx, { tenantId: tenantA, branchId: branchA, asOf }),
      );
      const policyA2 = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolve(tx, { tenantId: tenantA, branchId: branchA2, asOf }),
      );
      expect(policyA?.policyVersionId).toBe(bodyOf(resA).id);
      expect(policyA?.varianceToleranceMinorUnits).toBe(111n);
      expect(policyA2?.policyVersionId).toBe(bodyOf(resA2).id);
      expect(policyA2?.varianceToleranceMinorUnits).toBe(222n);
    });

    it('7/8: future version does not resolve before effective_from, resolves after', async () => {
      const future = new Date(Date.now() + 3600_000);
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '333',
        varianceApprovalExpirySeconds: 63,
        effectiveFrom: future.toISOString(),
      }).expect(201);

      const before = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolve(tx, {
            tenantId: tenantA,
            branchId: branchA,
            asOf: new Date(future.getTime() - 1000),
          }),
      );
      expect(before?.policyVersionId).not.toBe(bodyOf(res).id);

      const after = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolve(tx, {
            tenantId: tenantA,
            branchId: branchA,
            asOf: new Date(future.getTime() + 1000),
          }),
      );
      expect(after?.policyVersionId).toBe(bodyOf(res).id);
    });

    it('9/22: historical resolution stays stable after a later version is inserted; deterministic snapshot', async () => {
      const t0 = new Date(Date.now() + 100_000);
      const t1 = new Date(Date.now() + 200_000);

      const v1 = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '400',
        varianceApprovalExpirySeconds: 64,
        effectiveFrom: t0.toISOString(),
      }).expect(201);

      const asOf = new Date(t0.getTime() + 1000);
      const resolveAt = () =>
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            resolver.resolve(tx, {
              tenantId: tenantA,
              branchId: branchA,
              asOf,
            }),
        );

      const before = await resolveAt();
      expect(before?.policyVersionId).toBe(bodyOf(v1).id);
      expect(before?.varianceToleranceMinorUnits).toBe(400n);

      // Insert a LATER version.
      await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '500',
        varianceApprovalExpirySeconds: 65,
        effectiveFrom: t1.toISOString(),
      }).expect(201);

      const after = await resolveAt();
      expect(after?.policyVersionId).toBe(before?.policyVersionId);
      expect(after?.varianceToleranceMinorUnits).toBe(
        before?.varianceToleranceMinorUnits,
      );
      expect(after).toEqual(before); // full deterministic snapshot, byte-identical
    });

    it('5: DOCUMENTED GAP — no inherited hierarchy exists; a branch with no policy resolves null (NOT FR-PLT-025 coverage)', async () => {
      const isolatedBrand = (
        await request(http)
          .post('/org/brands')
          .set(auth(managerTokenA))
          .send({ name: `Brand isolated ${stamp}` })
          .expect(201)
      ).body as WithId;
      const isolatedBranch = (
        await request(http)
          .post('/org/branches')
          .set(auth(managerTokenA))
          .send({
            brandId: isolatedBrand.id,
            code: `CCPIS${shortStamp}`,
            name: 'Isolated branch',
            timezone: 'Africa/Cairo',
            baseCurrency: 'EGP',
            countryCode: 'EG',
          })
          .expect(201)
      ).body as WithId;

      // No tenant/brand-level fallback exists in this narrow slice — this
      // test PROVES the gap, it does not claim FR-PLT-025 coverage.
      const policy = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          resolver.resolve(tx, {
            tenantId: tenantA,
            branchId: isolatedBranch.id,
            asOf: new Date(),
          }),
      );
      expect(policy).toBeNull();
    });

    it('6: DOCUMENTED GAP — no lock mechanism exists; a second version simply overrides at the branch level (NOT FR-PLT-026 coverage)', async () => {
      // There is no "locked" column and no mechanism to prevent a second
      // configuration write at the same (only) level this slice implements.
      // Proving that is the point of this test — it does not claim
      // FR-PLT-026 coverage.
      const cols = await admin.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='treasury' AND table_name='cash_close_policies'
      `;
      expect(cols.map((c) => c.column_name)).not.toContain('is_locked');
      expect(cols.map((c) => c.column_name)).not.toContain('locked');
    });
  });

  // ============================================================ CONCURRENCY
  describe('concurrency (test 21)', () => {
    const runConcurrentRace = async (): Promise<void> => {
      const t = new Date(
        Date.now() + 7_200_000 + Math.random() * 10_000,
      ).toISOString();
      const [r1, r2] = await Promise.all([
        createPolicy(managerTokenA, branchA, {
          varianceToleranceMinorUnits: '700',
          varianceApprovalExpirySeconds: 70,
          effectiveFrom: t,
        }),
        createPolicy(managerTokenA, branchA, {
          varianceToleranceMinorUnits: '701',
          varianceApprovalExpirySeconds: 71,
          effectiveFrom: t,
        }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const rows = await admin.cashClosePolicy.findMany({
        where: {
          tenantId: tenantA,
          branchId: branchA,
          effectiveFrom: new Date(t),
        },
      });
      expect(rows).toHaveLength(1);
    };

    it('runs the genuine same-branch/same-effective_from race >=3 clean times', async () => {
      await runConcurrentRace();
      await runConcurrentRace();
      await runConcurrentRace();
    }, 30000);
  });

  // ============================================================ RLS/GRANTS
  describe('RLS / GRANTS matrix', () => {
    it('1/17: tenant A cannot read tenant B policy; cross-tenant branch reference blocked by composite FK', async () => {
      const res = await createPolicy(managerTokenB, branchB, {
        varianceToleranceMinorUnits: '999',
        varianceApprovalExpirySeconds: 90,
      }).expect(201);

      const seenOwn = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantB },
        (tx) =>
          tx.cashClosePolicy.findUnique({
            where: { id: bodyOf(res).id },
          }),
      );
      expect(seenOwn).not.toBeNull();

      const seenCross = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: tenantA },
        (tx) =>
          tx.cashClosePolicy.findUnique({
            where: { id: bodyOf(res).id },
          }),
      );
      expect(seenCross).toBeNull();

      // Cross-tenant branch reference: tenant A trying to create a policy
      // for tenant B's branch is invisible under RLS -> 404, and the
      // composite FK makes a direct cross-tenant write structurally
      // impossible even bypassing the service's own branch lookup.
      await createPolicy(managerTokenA, branchB, {
        varianceToleranceMinorUnits: '1',
        varianceApprovalExpirySeconds: 60,
      }).expect(404);

      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            INSERT INTO "treasury"."cash_close_policies" (
              "id", "tenant_id", "branch_id", "effective_from", "count_mode",
              "variance_tolerance_minor_units", "currency",
              "variance_approval_expiry_seconds", "created_by"
            ) VALUES (
              ${newId()}::uuid, ${tenantA}::uuid, ${branchB}::uuid,
              statement_timestamp(), 'blind'::"treasury"."CashCountMode",
              1, 'EGP', 60, ${newId()}::uuid
            )
          `,
        ),
      ).rejects.toThrow();
    });

    it('2: missing tenant context fails closed (SELECT and INSERT)', async () => {
      // Sanity: rows genuinely exist for SOME tenant.
      const rows = await admin.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "treasury"."cash_close_policies" LIMIT 1
      `;
      expect(rows.length).toBeGreaterThan(0);

      // `tenantId: ''` -> withAuthContext sets app.tenant_id to '' ->
      // NULLIF(...,'') -> NULL -> no row ever matches the SELECT policy.
      const seen = await appPrisma.withAuthContext(
        { userId: newId(), tenantId: '' },
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "treasury"."cash_close_policies" LIMIT 1
          `,
      );
      expect(seen).toEqual([]);

      // Same fail-closed predicate on the INSERT `WITH CHECK`.
      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: '' },
          (tx) =>
            tx.$executeRaw`
              INSERT INTO "treasury"."cash_close_policies" (
                "id", "tenant_id", "branch_id", "effective_from", "count_mode",
                "variance_tolerance_minor_units", "currency",
                "variance_approval_expiry_seconds", "created_by"
              ) VALUES (
                ${newId()}::uuid, ${tenantA}::uuid, ${branchA}::uuid,
                statement_timestamp(), 'blind'::"treasury"."CashCountMode",
                1, 'EGP', 60, ${newId()}::uuid
              )
            `,
        ),
      ).rejects.toThrow();
    });

    it('table-level SELECT, column-level INSERT excluding created_at, no UPDATE/DELETE/TRUNCATE', async () => {
      const tableGrants = await admin.$queryRaw<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='treasury' AND table_name='cash_close_policies' AND grantee='ros_app'
      `;
      const privileges = tableGrants.map((g) => g.privilege_type);
      expect(privileges).toEqual(['SELECT']);
      expect(privileges).not.toContain('UPDATE');
      expect(privileges).not.toContain('DELETE');
      expect(privileges).not.toContain('TRUNCATE');

      const insertCols = await admin.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.role_column_grants
        WHERE table_schema='treasury' AND table_name='cash_close_policies'
          AND grantee='ros_app' AND privilege_type='INSERT'
      `;
      const insertable = new Set(insertCols.map((c) => c.column_name));
      expect(insertable.has('created_at')).toBe(false);
      expect(insertable.has('effective_from')).toBe(true);
      expect(insertable.has('variance_tolerance_minor_units')).toBe(true);
    });

    it('18: UPDATE and DELETE genuinely fail as ros_app', async () => {
      const res = await createPolicy(managerTokenA, branchA, {
        varianceToleranceMinorUnits: '42',
        varianceApprovalExpirySeconds: 60,
      }).expect(201);

      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            UPDATE "treasury"."cash_close_policies"
            SET "variance_tolerance_minor_units" = 0
            WHERE "id" = ${bodyOf(res).id}::uuid
          `,
        ),
      ).rejects.toThrow();

      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            DELETE FROM "treasury"."cash_close_policies"
            WHERE "id" = ${bodyOf(res).id}::uuid
          `,
        ),
      ).rejects.toThrow();

      const stillThere = await admin.cashClosePolicy.findUniqueOrThrow({
        where: { id: bodyOf(res).id },
      });
      expect(stillThere.varianceToleranceMinorUnits).toBe(42n);
    });

    it('19: ros_app cannot forge created_at even if it tries', async () => {
      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            INSERT INTO "treasury"."cash_close_policies" (
              "id", "tenant_id", "branch_id", "effective_from", "count_mode",
              "variance_tolerance_minor_units", "currency",
              "variance_approval_expiry_seconds", "created_by", "created_at"
            ) VALUES (
              ${newId()}::uuid, ${tenantA}::uuid, ${branchA}::uuid,
              now() + interval '1 hour', 'blind'::"treasury"."CashCountMode",
              1, 'EGP', 60, ${newId()}::uuid, now() - interval '10 years'
            )
          `,
        ),
      ).rejects.toThrow();
    });
  });
});
