import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { newId } from './../src/common/ids';
import { IDENTITY_PERMISSIONS } from './../src/modules/identity/authz/permissions.constants';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  COUNTRY_PACK_SIGNATURE_VERIFIER,
  COUNTRY_PACK_TRUST_STORE,
  Ed25519CountryPackSignatureVerifier,
} from './../src/modules/localisation/country-pack/country-pack.signature';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './../src/modules/localisation/country-pack/country-pack.signing.fixture';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import { OrdersService } from './../src/modules/sales/orders/orders.service';
import { ServiceChargePolicyResolver } from './../src/modules/sales/service-charge-policy/service-charge-policy.resolver';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

const password = 's3cure-passphrase';
const stamp = Date.now();
const shortStamp = stamp.toString().slice(-6);
const PACK = '2026.1';

const E2E_RELEASE_KEY = generateReleaseKey(`scp-e2e-release-${stamp}`);
const e2eTrustStore = trustStoreFor(E2E_RELEASE_KEY.trusted());
const e2eVerifier = new Ed25519CountryPackSignatureVerifier(e2eTrustStore);

const packPayload = (code: string, currency: string) => ({
  code,
  version: PACK,
  effectiveFrom: '2026-01-01',
  currency: { code: currency, exponent: 2, cashRounding: { enabled: false } },
  tax: {
    engine: 'vat_standard',
    pricingMode: 'tax_inclusive',
    computationLevel: 'line',
    roundingMode: 'HALF_UP',
    roundingPrecision: 2,
    classes: [
      { code: 'standard', rate: '14.0' },
      { code: 'exempt', rate: null },
    ],
    serviceChargeTaxable: true,
    orderTypeOverrides: [],
  },
});
const testPackDocument = (code: string, currency: string) =>
  signPackDocument(packPayload(code, currency), E2E_RELEASE_KEY);

interface PolicyView {
  id: string;
  level: string;
  targetId: string;
  rules: unknown[];
  locked: boolean;
  effectiveFrom: string;
}
interface ResolveBody {
  policy: PolicyView | null;
}
interface VersionsBody {
  versions: PolicyView[];
}
interface ErrorBody {
  message: string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
const idOf = (res: { body: unknown }): string =>
  (res.body as { id: string }).id;

/**
 * P2D (ratified P2D-R1) — ServiceChargePolicy configuration substrate e2e
 * coverage: DB boundary/RLS/privileges (A-F), resolver precedence via the
 * real admin surface (the DB-backed half of the resolver test list — the
 * pure precedence-WALK logic is proven, without a database, in
 * `src/modules/sales/service-charge-policy/service-charge-policy.resolver.spec.ts`),
 * admin create/cancel, and Order pinning at `openedAt` (A-G).
 */
describe('ServiceChargePolicy (e2e) — P2D / P2D-R1', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let appPrisma: PrismaService;
  let http: App;
  let orders: OrdersService;

  let tenantA: string;
  let tenantB: string;
  let brandA: string;
  let branchA: string;
  let branchA2: string;
  let employeeA: string;
  let ownerUserIdA: string;
  let ownerTokenA: string;
  let branchOnlyTokenA: string;
  let noPermTokenA: string;
  let ownerTokenB: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(e2eTrustStore)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(e2eVerifier)
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    http = app.getHttpServer();
    admin = createMigratorClient(app);
    appPrisma = app.get(PrismaService);
    orders = app.get(OrdersService);

    const packs = app.get(CountryPackService);
    await packs.activate(testPackDocument('EG', 'EGP'));

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);

    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);
    const employees = app.get(EmployeesService);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantA = await mkTenant(`scp-a-${stamp}`);
    tenantB = await mkTenant(`scp-b-${stamp}`);

    const mkUser = async (email: string, tenantId: string, codes: string[]) => {
      const u = await users.createUser({ email, password, displayName: 'SCP' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length > 0) {
        const role = await roles.createTenantRole(tenantId, {
          name: `scp-role-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.create(tenantId, null, {
          membershipId: m.id,
          roleId: role.id,
          scope: { type: 'tenant' },
        });
      }
      return u.id;
    };

    const emailOwnerA = `scp.ownerA.${stamp}@example.com`;
    const emailBranchOnlyA = `scp.branchOnlyA.${stamp}@example.com`;
    const emailNoPermA = `scp.noPermA.${stamp}@example.com`;
    const emailOwnerB = `scp.ownerB.${stamp}@example.com`;

    ownerUserIdA = await mkUser(emailOwnerA, tenantA, [
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.TENANT_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      IDENTITY_PERMISSIONS.TERMINAL_MANAGE,
    ]);
    await mkUser(emailBranchOnlyA, tenantA, [
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
    ]);
    await mkUser(emailNoPermA, tenantA, []);
    await mkUser(emailOwnerB, tenantB, [
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.TENANT_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
    ]);

    const scoped = async (email: string, tenantId: string): Promise<string> => {
      const login = await request(http)
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      const sel = await request(http)
        .post('/auth/tenant')
        .set(
          'Authorization',
          `Bearer ${(login.body as { accessToken: string }).accessToken}`,
        )
        .send({ tenantId })
        .expect(200);
      return (sel.body as { accessToken: string }).accessToken;
    };
    ownerTokenA = await scoped(emailOwnerA, tenantA);
    branchOnlyTokenA = await scoped(emailBranchOnlyA, tenantA);
    noPermTokenA = await scoped(emailNoPermA, tenantA);
    ownerTokenB = await scoped(emailOwnerB, tenantB);

    const mkBrand = async (token: string, name: string): Promise<string> =>
      idOf(
        await request(http)
          .post('/org/brands')
          .set(auth(token))
          .send({ name })
          .expect(201),
      );
    const mkBranch = async (
      token: string,
      brandId: string,
      code: string,
    ): Promise<string> =>
      idOf(
        await request(http)
          .post('/org/branches')
          .set(auth(token))
          .send({
            brandId,
            code,
            name: `Branch ${code}`,
            timezone: 'Africa/Cairo',
            baseCurrency: 'EGP',
            countryCode: 'EG',
          })
          .expect(201),
      );

    brandA = await mkBrand(ownerTokenA, `SCP Brand A ${shortStamp}`);
    branchA = await mkBranch(ownerTokenA, brandA, `SCPA${shortStamp}`);
    branchA2 = await mkBranch(ownerTokenA, brandA, `SCPA2${shortStamp}`);

    employeeA = (
      await employees.create(tenantA, ownerUserIdA, {
        code: `SCPE${shortStamp}`,
        displayName: 'SCP Employee',
        homeBranchId: branchA,
      })
    ).id;
  }, 60000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const create = (
    token: string,
    scope: 'tenant' | { brandId: string } | { branchId: string },
    body: Record<string, unknown>,
    idemKey = `scp-${newId()}`,
  ) => {
    const path =
      scope === 'tenant'
        ? '/service-charge-policy/tenant'
        : 'brandId' in scope
          ? `/service-charge-policy/brand/${scope.brandId}`
          : `/service-charge-policy/branch/${scope.branchId}`;
    return request(http)
      .post(path)
      .set(auth(token))
      .set('Idempotency-Key', idemKey)
      .send(body);
  };
  const resolve = (
    token: string,
    q: { brandId?: string; branchId?: string } = {},
  ) =>
    request(http)
      .get('/service-charge-policy/resolve')
      .query(q)
      .set(auth(token));
  const listVersions = (token: string, level: string, targetId: string) =>
    request(http)
      .get('/service-charge-policy/versions')
      .query({ level, targetId })
      .set(auth(token));
  const cancel = (token: string, versionId: string) =>
    request(http)
      .delete(`/service-charge-policy/versions/${versionId}`)
      .set(auth(token));

  const mkOrder = (
    over: Partial<Parameters<OrdersService['create']>[2]> = {},
  ) =>
    orders.create(tenantA, newId(), {
      branchId: branchA,
      openedByEmployeeId: employeeA,
      orderType: 'takeaway',
      channel: 'pos',
      originDeviceTime: new Date('2020-01-01T00:00:00.000Z'),
      idempotencyKey: `scp-order-${newId()}`,
      ...over,
    });

  /**
   * A brand-new brand/branch/employee, untouched by any other test's
   * ServiceChargePolicy writes — required for any test asserting a SPECIFIC
   * winning level (tenant/brand/branch), since `branchA`/`brandA` accumulate
   * configured (and, from the precedence test, even LOCKED) rows as the
   * file runs.
   */
  let scopeCounter = 0;
  async function mkOrderScope(): Promise<{
    brandId: string;
    branchId: string;
    employeeId: string;
  }> {
    scopeCounter += 1;
    const tag = `${shortStamp}${scopeCounter}`;
    const brandId = idOf(
      await request(http)
        .post('/org/brands')
        .set(auth(ownerTokenA))
        .send({ name: `SCP Scope Brand ${tag}` })
        .expect(201),
    );
    const branchId = idOf(
      await request(http)
        .post('/org/branches')
        .set(auth(ownerTokenA))
        .send({
          brandId,
          code: `SCPS${tag}`,
          name: `Scope branch ${tag}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        })
        .expect(201),
    );
    const employees = app.get(EmployeesService);
    const employeeId = (
      await employees.create(tenantA, ownerUserIdA, {
        code: `SCPSE${tag}`,
        displayName: `SCP Scope Employee ${tag}`,
        homeBranchId: branchId,
      })
    ).id;
    return { brandId, branchId, employeeId };
  }

  // ============================================== MUST RUN FIRST
  // These two assertions depend on tenantA carrying NO ServiceChargePolicy
  // row anywhere yet — true only before any later test in this file writes
  // one. Placed first in file-definition order (Jest runs describe/it
  // blocks top-to-bottom within one file) rather than given a dedicated
  // fresh tenant, since both branchA/employeeA are already fully
  // set up and permitted.
  describe('pristine tenant state (must run before any write in this file)', () => {
    it('1: no policy anywhere => resolve returns policy: null', async () => {
      const res = await resolve(ownerTokenA, { branchId: branchA2 }).expect(
        200,
      );
      expect(bodyOf<ResolveBody>(res).policy).toBeNull();
    });

    it('A: no policy configured anywhere => Order.serviceChargePolicyVersionId = null', async () => {
      const order = await mkOrder();
      expect(order.serviceChargePolicyVersionId).toBeNull();
    });
  });

  // ==================================================================== rules
  describe('rule validation via the real create route', () => {
    it('accepts rules: [] and creates a version', async () => {
      const res = await create(ownerTokenA, 'tenant', { rules: [] }).expect(
        201,
      );
      expect(bodyOf<PolicyView>(res).rules).toEqual([]);
    });

    it('accepts a valid rule set', async () => {
      const res = await create(ownerTokenA, 'tenant', {
        rules: [
          { orderType: 'dine_in', minGuestCount: 6, ratePercent: '12.5' },
        ],
      }).expect(201);
      expect(bodyOf<PolicyView>(res).rules).toEqual([
        { orderType: 'dine_in', minGuestCount: 6, ratePercent: '12.5' },
      ]);
    });

    it('rejects an invalid rule (400)', async () => {
      const res = await create(ownerTokenA, 'tenant', {
        rules: [{ orderType: 'brunch', minGuestCount: 6, ratePercent: '12.5' }],
      }).expect(400);
      expect(bodyOf<ErrorBody>(res).message).toMatch(/orderType/);
    });

    it('rejects a JSON-number ratePercent (400, ADR-008)', async () => {
      await create(ownerTokenA, 'tenant', {
        rules: [{ orderType: null, minGuestCount: null, ratePercent: 12.5 }],
      }).expect(400);
    });
  });

  // ============================================== anti-backdating (P2D-CORRECTION §3)
  // Three INDEPENDENT layers of evidence, kept distinct on purpose:
  //   SERVICE_BACKDATED_WRITE  — the friendly, service-layer 400 (below).
  //   DB_RAW_BACKDATED_INSERT  — the real database CHECK boundary, proven
  //     by bypassing the service entirely (test B, below, in "database
  //     boundary").
  //   CREATED_AT_FORGERY_BLOCKED — the granted-column-set boundary that
  //     makes DB_RAW_BACKDATED_INSERT's evidence meaningful in the first
  //     place: a caller cannot forge `created_at` to dodge the CHECK
  //     (test F, below, in "database boundary").
  describe('anti-backdating — service-layer rejection (SERVICE_BACKDATED_WRITE)', () => {
    it('rejects a past effectiveFrom with a friendly 400, before any DB write is attempted', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const res = await create(ownerTokenA, 'tenant', {
        rules: [],
        effectiveFrom: past,
      }).expect(400);
      expect(bodyOf<ErrorBody>(res).message).toMatch(
        /effectiveFrom must not be in the past/,
      );
    });
  });

  // ==================================================================== DB boundary
  describe('database boundary (RLS / privileges)', () => {
    it('A: tenant A row invisible under tenant B RLS context', async () => {
      const created = await create(ownerTokenA, 'tenant', { rules: [] }).expect(
        201,
      );
      const id = bodyOf<PolicyView>(created).id;

      const seenByOwn = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) => tx.serviceChargePolicy.findUnique({ where: { id } }),
      );
      expect(seenByOwn).not.toBeNull();

      const seenByOther = await appPrisma.withAuthContext(
        { tenantId: tenantB },
        (tx) => tx.serviceChargePolicy.findUnique({ where: { id } }),
      );
      expect(seenByOther).toBeNull();
    });

    it('B: a raw INSERT with a past effectiveFrom fails at the DB CHECK, even bypassing the service', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            INSERT INTO "sales"."service_charge_policies" (
              "id", "tenant_id", "level", "target_id", "rules", "locked",
              "effective_from", "created_by"
            ) VALUES (
              ${newId()}::uuid, ${tenantA}::uuid,
              'tenant'::"sales"."ServiceChargePolicyLevel",
              ${tenantA}::uuid, '[]'::jsonb, false,
              ${past}::timestamptz, ${newId()}::uuid
            )
          `,
        ),
      ).rejects.toThrow(/ck_scp_no_backdating/);
    });

    it('C: a direct UPDATE through the application role fails (no UPDATE grant)', async () => {
      const created = await create(ownerTokenA, 'tenant', { rules: [] }).expect(
        201,
      );
      const id = bodyOf<PolicyView>(created).id;
      await expect(
        appPrisma.withAuthContext(
          { tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            UPDATE "sales"."service_charge_policies" SET "locked" = true WHERE "id" = ${id}::uuid
          `,
        ),
      ).rejects.toThrow();
    });

    it('D: DELETE of a future version succeeds when the tenant context is correct', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const created = await create(ownerTokenA, 'tenant', {
        rules: [],
        effectiveFrom: future,
      }).expect(201);
      const id = bodyOf<PolicyView>(created).id;
      const deleted = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) =>
          tx.$executeRaw`DELETE FROM "sales"."service_charge_policies" WHERE "id" = ${id}::uuid`,
      );
      expect(deleted).toBe(1);
    });

    it('E: DELETE of an already-effective version cannot succeed at the DB level', async () => {
      const created = await create(ownerTokenA, 'tenant', { rules: [] }).expect(
        201,
      );
      const id = bodyOf<PolicyView>(created).id;
      // Effective immediately — effective_from <= statement_timestamp() now.
      const deleted = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) =>
          tx.$executeRaw`DELETE FROM "sales"."service_charge_policies" WHERE "id" = ${id}::uuid`,
      );
      // RLS predicate (effective_from > statement_timestamp()) excludes the
      // row -> zero rows affected, never an error, never a false success.
      expect(deleted).toBe(0);
      const stillThere = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) => tx.serviceChargePolicy.findUnique({ where: { id } }),
      );
      expect(stillThere).not.toBeNull();
    });

    it("F: created_at cannot be supplied through the application role's granted INSERT column set", async () => {
      await expect(
        appPrisma.withAuthContext(
          { userId: newId(), tenantId: tenantA },
          (tx) =>
            tx.$executeRaw`
            INSERT INTO "sales"."service_charge_policies" (
              "id", "tenant_id", "level", "target_id", "rules", "locked",
              "created_at", "created_by"
            ) VALUES (
              ${newId()}::uuid, ${tenantA}::uuid,
              'tenant'::"sales"."ServiceChargePolicyLevel",
              ${tenantA}::uuid, '[]'::jsonb, false,
              ${new Date(Date.now() - 86_400_000).toISOString()}::timestamptz,
              ${newId()}::uuid
            )
          `,
        ),
      ).rejects.toThrow(/permission denied|column "created_at"/i);
    });
  });

  // ==================================================================== resolver (DB-backed)
  describe('resolver precedence, via the real admin surface (DB-backed half)', () => {
    it('tenant -> brand -> branch precedence, and lock-stop, via HTTP', async () => {
      await create(ownerTokenA, 'tenant', {
        rules: [{ orderType: null, minGuestCount: null, ratePercent: '5' }],
      }).expect(201);
      let res = await resolve(ownerTokenA, { branchId: branchA }).expect(200);
      expect(bodyOf<ResolveBody>(res).policy?.level).toBe('tenant');

      await create(
        ownerTokenA,
        { brandId: brandA },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '8' }],
        },
      ).expect(201);
      res = await resolve(ownerTokenA, { branchId: branchA }).expect(200);
      expect(bodyOf<ResolveBody>(res).policy?.level).toBe('brand');

      const lockedBranch = await create(
        ownerTokenA,
        { branchId: branchA },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '10' }],
          locked: true,
        },
      ).expect(201);
      res = await resolve(ownerTokenA, { branchId: branchA }).expect(200);
      expect(bodyOf<ResolveBody>(res).policy?.level).toBe('branch');
      expect(bodyOf<ResolveBody>(res).policy?.locked).toBe(true);
      expect(bodyOf<ResolveBody>(res).policy?.id).toBe(
        bodyOf<PolicyView>(lockedBranch).id,
      );
    });

    it('9-10: a future version is invisible before effectiveFrom, and resolves once asOf passes it (deterministic via listVersions + resolver unit coverage; resolve itself always uses now())', async () => {
      const targetId = branchA2;
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const created = await create(
        ownerTokenA,
        { branchId: targetId },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '3' }],
          effectiveFrom: future,
        },
      ).expect(201);

      // Not yet effective: resolve (which always uses "now") never returns
      // THIS version — whatever it DOES return (possibly a higher-level
      // row from an earlier test in this scope's own brand/tenant chain)
      // is necessarily something else, never the future one.
      const before = await resolve(ownerTokenA, { branchId: targetId }).expect(
        200,
      );
      expect(bodyOf<ResolveBody>(before).policy?.id).not.toBe(
        bodyOf<PolicyView>(created).id,
      );

      // But it genuinely exists and is discoverable via listVersions — the
      // exact reason that route exists (see ServiceChargePolicyService.listVersions).
      const versions = await listVersions(
        ownerTokenA,
        'branch',
        targetId,
      ).expect(200);
      expect(
        bodyOf<VersionsBody>(versions).versions.map((v) => v.id),
      ).toContain(bodyOf<PolicyView>(created).id);
    });

    it('12: cross-tenant / mismatched hierarchy rejected (404)', async () => {
      // Cross-tenant target.
      await create(ownerTokenA, { branchId: branchA }, { rules: [] })
        .set(auth(ownerTokenB))
        .expect(404);
      // Branch that does not belong to the supplied (mismatched) brand — here
      // exercised via resolve's own brandId/branchId consistency check.
      const otherBrand = idOf(
        await request(http)
          .post('/org/brands')
          .set(auth(ownerTokenA))
          .send({ name: `SCP Other Brand ${shortStamp}` })
          .expect(201),
      );
      const mismatch = await resolve(ownerTokenA, {
        brandId: otherBrand,
        branchId: branchA,
      }).expect(404);
      expect(bodyOf<ErrorBody>(mismatch).message).toMatch(/does not belong/);
    });
  });

  // ==================================================================== 11: historical stability
  describe('11: historical resolve stability', () => {
    it('a fixed historical instant keeps resolving to the SAME version after a later version is added', async () => {
      const scope = { branchId: await orgBranch() };
      async function orgBranch(): Promise<string> {
        const brand = idOf(
          await request(http)
            .post('/org/brands')
            .set(auth(ownerTokenA))
            .send({ name: `SCP Hist Brand ${shortStamp}` })
            .expect(201),
        );
        return idOf(
          await request(http)
            .post('/org/branches')
            .set(auth(ownerTokenA))
            .send({
              brandId: brand,
              code: `SCPH${shortStamp}`,
              name: 'Hist branch',
              timezone: 'Africa/Cairo',
              baseCurrency: 'EGP',
              countryCode: 'EG',
            })
            .expect(201),
        );
      }

      const v1 = await create(ownerTokenA, scope, {
        rules: [{ orderType: null, minGuestCount: null, ratePercent: '4' }],
      }).expect(201);
      // Captured by the TEST PROCESS itself, strictly after v1's INSERT has
      // committed (the HTTP response only returns post-commit) — never
      // reconstructed from v1's own `effectiveFrom` JSON string, which
      // round-trips through `.toISOString()` and loses the database's
      // microsecond precision; comparing a millisecond-truncated instant
      // against the true (possibly later, at the microsecond level) stored
      // value could spuriously exclude v1 itself from `effective_from <=
      // at`. A generous 250ms gap before creating v2 keeps `t1` far clear
      // of both boundaries — comfortably after v1, comfortably before v2.
      const t1 = new Date();
      await new Promise((r) => setTimeout(r, 250));
      // A LATER version, effective immediately (after t1).
      const v2 = await create(ownerTokenA, scope, {
        rules: [{ orderType: null, minGuestCount: null, ratePercent: '9' }],
      }).expect(201);

      // Resolving AT t1 (a real historical instant, via a raw resolve using
      // the resolver directly with an explicit `at`) must still return v1 —
      // proven directly against the resolver, since the HTTP `resolve` route
      // itself always uses "now".
      const resolver = app.get(ServiceChargePolicyResolver);
      const branchFacts = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) =>
          tx.branch.findUniqueOrThrow({
            where: { id: scope.branchId },
            select: { brandId: true },
          }),
      );
      const breakdownAtT1 = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) =>
          resolver.resolve(tx, {
            tenantId: tenantA,
            brandId: branchFacts.brandId,
            branchId: scope.branchId,
            at: new Date(t1),
          }),
      );
      expect(breakdownAtT1.winner?.id).toBe(bodyOf<PolicyView>(v1).id);
      expect(breakdownAtT1.winner?.id).not.toBe(bodyOf<PolicyView>(v2).id);
    });
  });

  // ==================================================================== cancel
  describe('cancel (future-only, P2A-R1 clause 11)', () => {
    it('cancels a still-future tenant-level version', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const created = await create(ownerTokenA, 'tenant', {
        rules: [],
        effectiveFrom: future,
      }).expect(201);
      await cancel(ownerTokenA, bodyOf<PolicyView>(created).id).expect(204);
    });

    it('rejects cancelling an already-effective version (409)', async () => {
      const created = await create(ownerTokenA, 'tenant', { rules: [] }).expect(
        201,
      );
      const res = await cancel(
        ownerTokenA,
        bodyOf<PolicyView>(created).id,
      ).expect(409);
      expect(bodyOf<ErrorBody>(res).message).toMatch(/already effective/);
    });

    it('cross-tenant cancel fails closed (404)', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const created = await create(ownerTokenA, 'tenant', {
        rules: [],
        effectiveFrom: future,
      }).expect(201);
      await cancel(ownerTokenB, bodyOf<PolicyView>(created).id).expect(404);
    });

    it('a branch-scoped-only manager (no TENANT_MANAGE) can cancel a BRANCH-level future version', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const created = await create(
        ownerTokenA,
        { branchId: branchA2 },
        {
          rules: [],
          effectiveFrom: future,
        },
      ).expect(201);
      await cancel(branchOnlyTokenA, bodyOf<PolicyView>(created).id).expect(
        204,
      );
    });

    it('a branch-scoped-only manager CANNOT cancel a TENANT-level future version (403)', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const created = await create(ownerTokenA, 'tenant', {
        rules: [],
        effectiveFrom: future,
      }).expect(201);
      await cancel(branchOnlyTokenA, bodyOf<PolicyView>(created).id).expect(
        403,
      );
    });

    it('an actor with no manage permission at all is rejected before reaching the service (403)', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const created = await create(ownerTokenA, 'tenant', {
        rules: [],
        effectiveFrom: future,
      }).expect(201);
      await cancel(noPermTokenA, bodyOf<PolicyView>(created).id).expect(403);
    });
  });

  // ==================================================================== Order pinning
  // `mkOrder` (hoisted to file scope, above) omits `at`, so
  // `OrdersService.create` defaults it to the SERVER's real "now" — which is
  // what makes an "effective immediately" ServiceChargePolicy (itself
  // governed by genuine DB `statement_timestamp()`, never a fictional test
  // date) visible to an order created right after it. Tests needing an
  // explicit past/future relationship pass `at` deterministically instead
  // of sleeping past a real deadline.
  describe('Order pinning at Order.openedAt (P2D-R1 clause 7/8)', () => {
    it('B/C/D: pins tenant, then branch override, then a higher LOCKED version (never the lower one)', async () => {
      const scope = await mkOrderScope();
      const tenantV = await create(ownerTokenA, 'tenant', {
        rules: [{ orderType: null, minGuestCount: null, ratePercent: '5' }],
      }).expect(201);
      let order = await mkOrder({
        branchId: scope.branchId,
        openedByEmployeeId: scope.employeeId,
        idempotencyKey: `scp-order-b-${newId()}`,
      });
      expect(order.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(tenantV).id,
      );

      const branchV = await create(
        ownerTokenA,
        { branchId: scope.branchId },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '8' }],
        },
      ).expect(201);
      order = await mkOrder({
        branchId: scope.branchId,
        openedByEmployeeId: scope.employeeId,
        idempotencyKey: `scp-order-c-${newId()}`,
      });
      expect(order.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(branchV).id,
      );

      const lockedBrandV = await create(
        ownerTokenA,
        { brandId: scope.brandId },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '20' }],
          locked: true,
        },
      ).expect(201);
      order = await mkOrder({
        branchId: scope.branchId,
        openedByEmployeeId: scope.employeeId,
        idempotencyKey: `scp-order-d-${newId()}`,
      });
      expect(order.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(lockedBrandV).id,
      );
      expect(order.serviceChargePolicyVersionId).not.toBe(
        bodyOf<PolicyView>(branchV).id,
      );
      // No service-charge computation exists in P2D — the pinned id must
      // never imply a non-zero total.
      expect(order.serviceChargeTotal).toBe(0n);
    });

    it('E/F: an order pins the version effective AT openedAt, never a later-scheduled one; an older order keeps its own pin after a newer version is added', async () => {
      const scope = await mkOrderScope();
      const scopeBranch = scope.branchId;
      const scopeEmployee = scope.employeeId;

      const v1 = await create(
        ownerTokenA,
        { branchId: scopeBranch },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '4' }],
        },
      ).expect(201);

      // Captured AFTER v1 exists — the deterministic seam for "at open
      // time", never a sleep.
      const t0 = new Date();
      const orderAtOpen = await mkOrder({
        branchId: scopeBranch,
        openedByEmployeeId: scopeEmployee,
        idempotencyKey: `scp-order-e-${newId()}`,
        at: t0,
      });
      expect(orderAtOpen.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(v1).id,
      );

      // V2 scheduled for the FUTURE relative to t0 — must not affect an
      // order opened AT t0.
      const v2EffectiveFrom = new Date(Date.now() + 5_000);
      const v2 = await create(
        ownerTokenA,
        { branchId: scopeBranch },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '9' }],
          effectiveFrom: v2EffectiveFrom.toISOString(),
        },
      ).expect(201);

      const orderStillV1 = await mkOrder({
        branchId: scopeBranch,
        openedByEmployeeId: scopeEmployee,
        idempotencyKey: `scp-order-e2-${newId()}`,
        at: t0,
      });
      expect(orderStillV1.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(v1).id,
      );

      // A LATER create, deterministically AFTER v2's effectiveFrom, pins v2
      // — the earlier order (orderAtOpen) keeps its own v1 pin, immutable.
      const laterAt = new Date(v2EffectiveFrom.getTime() + 1_000);
      const orderAfterV2 = await mkOrder({
        branchId: scopeBranch,
        openedByEmployeeId: scopeEmployee,
        idempotencyKey: `scp-order-f-${newId()}`,
        at: laterAt,
      });
      expect(orderAfterV2.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(v2).id,
      );
      expect(orderAfterV2.serviceChargePolicyVersionId).not.toBe(
        bodyOf<PolicyView>(v1).id,
      );

      const reread = await appPrisma.withAuthContext(
        { tenantId: tenantA },
        (tx) =>
          tx.order.findUniqueOrThrow({
            where: {
              id_businessDay: {
                id: orderAtOpen.id,
                businessDay: orderAtOpen.businessDay,
              },
            },
            select: { serviceChargePolicyVersionId: true },
          }),
      );
      expect(reread.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(v1).id,
      );
    });

    it('G: originDeviceTime differing from the server-derived openedAt does not control policy selection', async () => {
      await create(ownerTokenA, 'tenant', {
        rules: [{ orderType: null, minGuestCount: null, ratePercent: '5' }],
      }).expect(201);
      const before = new Date();
      // originDeviceTime claims a date far in the past; the SERVER instant
      // (`at`, defaulting to now() since omitted here) is what governs —
      // never the client-claimed device clock.
      const order = await mkOrder({
        idempotencyKey: `scp-order-g-${newId()}`,
        originDeviceTime: new Date('2019-01-01T00:00:00.000Z'),
      });
      expect(order.serviceChargePolicyVersionId).not.toBeNull();
      expect(order.openedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(order.openedAt.getTime()).not.toBe(
        new Date('2019-01-01T00:00:00.000Z').getTime(),
      );
    });

    // P2D-CORRECTION — explicit proof of the exact pair the correction task
    // requires, isolated from every earlier test's tenant-level state via a
    // fresh `mkOrderScope()`. MUST run last in this file: a LOCKED
    // tenant-level version, once created, governs every subsequent order
    // for `tenantA` that has no branch/brand-level override of its own.
    it('H: a LOCKED tenant version wins over a configured (unlocked) branch version — the lock stops the walk at tenant, never reaching branch', async () => {
      const scope = await mkOrderScope();
      const branchV = await create(
        ownerTokenA,
        { branchId: scope.branchId },
        {
          rules: [{ orderType: null, minGuestCount: null, ratePercent: '55' }],
        },
      ).expect(201);
      const lockedTenantV = await create(ownerTokenA, 'tenant', {
        rules: [{ orderType: null, minGuestCount: null, ratePercent: '90' }],
        locked: true,
      }).expect(201);

      const order = await mkOrder({
        branchId: scope.branchId,
        openedByEmployeeId: scope.employeeId,
        idempotencyKey: `scp-order-h-${newId()}`,
      });
      expect(order.serviceChargePolicyVersionId).toBe(
        bodyOf<PolicyView>(lockedTenantV).id,
      );
      expect(order.serviceChargePolicyVersionId).not.toBe(
        bodyOf<PolicyView>(branchV).id,
      );
    });
  });
});
