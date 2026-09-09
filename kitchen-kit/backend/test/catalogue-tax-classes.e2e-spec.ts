import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import {
  CATALOGUE_PERMISSIONS,
  CATALOGUE_PERMISSION_DEFS,
} from './../src/modules/catalogue/catalogue.permissions';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
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
import { createMigratorClient } from './rls-admin';

/**
 * DEMO-TAX-CLASS-BACKEND-P0 — the `GET /catalogue/branches/:branchId/tax-classes`
 * discovery contract and the write-time `taxClassId` validation on
 * `POST/PATCH /catalogue/items`.
 *
 * Sales-side integration (item with a valid class sells, an item with no
 * class refuses, zero/exempt does not receive standard tax, the rate comes
 * from the active pack) is proven end to end by `sales-lines.e2e-spec.ts`
 * (tests E-H of this slice's mission); this suite covers what is NEW here —
 * discovery (A/B) and write validation (C/D) — without duplicating that
 * coverage.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();

const RELEASE_KEY = generateReleaseKey('ctc-release-key');
const TRUST = trustStoreFor(RELEASE_KEY.trusted());
const VERIFIER = new Ed25519CountryPackSignatureVerifier(TRUST);

const packDoc = (code: string) =>
  signPackDocument(
    {
      code,
      version: '2026.1',
      effectiveFrom: '2026-01-01',
      currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
      tax: {
        engine: 'vat_standard',
        pricingMode: 'tax_exclusive',
        computationLevel: 'line',
        roundingMode: 'HALF_UP',
        roundingPrecision: 2,
        classes: [
          { code: 'standard', rate: '14.0', label: { en: 'Standard' } },
          { code: 'zero', rate: '0.0', label: { en: 'Zero rated' } },
          { code: 'exempt', rate: null, label: { en: 'Exempt' } },
        ],
        serviceChargeTaxable: true,
        orderTypeOverrides: [],
      },
    },
    RELEASE_KEY,
  );

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}
interface TaxClassRow {
  id: string;
  code: string;
  names: Record<string, string>;
}

describe('Catalogue tax classes (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let tenantAId: string;
  let tenantBId: string;
  let tokenA: string;
  let tokenNoneA: string;
  let tokenB: string;

  let branchA: string;
  let branchB: string;
  let taxClassStandardA: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(VERIFIER)
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
    admin = createMigratorClient(app);
    http = app.getHttpServer();

    await app.get(CountryPackService).activate(packDoc('EG'));

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(CATALOGUE_PERMISSION_DEFS);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantAId = await mkTenant(`ctca-${stamp}`);
    tenantBId = await mkTenant(`ctcb-${stamp}`);

    const mkUser = async (
      email: string,
      tenantId: string,
      codes: string[],
    ): Promise<void> => {
      const u = await users.createUser({ email, password, displayName: 'C' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length > 0) {
        const role = await roles.createTenantRole(tenantId, {
          name: `ctc-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.create(tenantId, null, {
          membershipId: m.id,
          roleId: role.id,
          scope: { type: 'tenant' },
        });
      }
    };

    const all = Object.values(CATALOGUE_PERMISSIONS);
    const emailA = `ctc.a.${stamp}@example.com`;
    const emailNoneA = `ctc.n.${stamp}@example.com`;
    const emailB = `ctc.b.${stamp}@example.com`;
    await mkUser(emailA, tenantAId, all);
    await mkUser(emailNoneA, tenantAId, []);
    await mkUser(emailB, tenantBId, all);

    tokenA = await scoped(emailA, tenantAId);
    tokenNoneA = await scoped(emailNoneA, tenantAId);
    tokenB = await scoped(emailB, tenantBId);

    const mkBranch = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `Brand ${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `Branch ${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      return branch.id;
    };
    branchA = await mkBranch(tenantAId, `CTCA${stamp % 10000}`);
    branchB = await mkBranch(tenantBId, `CTCB${stamp % 10000}`);

    taxClassStandardA = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantAId, countryPackCode: 'EG', code: 'standard' },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // ---------------------------------------------------------- A/B: read ---
  describe('GET /catalogue/branches/:branchId/tax-classes', () => {
    it('A. an authorized actor reads every active tax class for the branch jurisdiction', async () => {
      const res = await request(http)
        .get(`/catalogue/branches/${branchA}/tax-classes`)
        .set(auth(tokenA))
        .expect(200);
      const rows = res.body as TaxClassRow[];
      expect(rows.map((r) => r.code).sort()).toEqual([
        'exempt',
        'standard',
        'zero',
      ]);
      const standard = rows.find((r) => r.code === 'standard')!;
      expect(standard.id).toBe(taxClassStandardA);
      expect(standard.names).toEqual({ en: 'Standard' });
      // No rate, component or engine configuration is ever exposed.
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['code', 'id', 'names']);
      }
    });

    it('B1. no permission at all is denied', async () => {
      await request(http)
        .get(`/catalogue/branches/${branchA}/tax-classes`)
        .set(auth(tokenNoneA))
        .expect(403);
    });

    it("B2. another tenant's branch is not found (cross-tenant denied)", async () => {
      await request(http)
        .get(`/catalogue/branches/${branchA}/tax-classes`)
        .set(auth(tokenB))
        .expect(404);
    });

    it('B3. an unknown branch id is not found', async () => {
      await request(http)
        .get(`/catalogue/branches/${newId()}/tax-classes`)
        .set(auth(tokenA))
        .expect(404);
    });

    it("B4. tenant A cannot read tenant B's own branch either (no cross-tenant leak both ways)", async () => {
      await request(http)
        .get(`/catalogue/branches/${branchB}/tax-classes`)
        .set(auth(tokenA))
        .expect(404);
    });
  });

  // ------------------------------------------------------- C/D: write ---
  describe('POST/PATCH /catalogue/items — taxClassId validation', () => {
    it('C. a valid, returned tax-class identifier can be persisted on create', async () => {
      const res = await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'Valid item' }, taxClassId: taxClassStandardA })
        .expect(201);
      const body = res.body as WithId & { taxClassId: string };
      expect(body.taxClassId).toBe(taxClassStandardA);

      const row = await admin.menuItem.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row.taxClassId).toBe(taxClassStandardA);
    });

    it('C2. a valid identifier can also be set later via update', async () => {
      const created = await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'Item set later' } })
        .expect(201);
      const itemId = (created.body as WithId).id;

      const updated = await request(http)
        .patch(`/catalogue/items/${itemId}`)
        .set(auth(tokenA))
        .send({ taxClassId: taxClassStandardA })
        .expect(200);
      expect((updated.body as { taxClassId: string }).taxClassId).toBe(
        taxClassStandardA,
      );
    });

    it('D1. an arbitrary/unknown UUID is rejected on create', async () => {
      const res = await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'Bad item' }, taxClassId: newId() })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/tax class/i);

      // Positive control: the same body minus taxClassId succeeds.
      await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'Bad item, retried without taxClassId' } })
        .expect(201);
    });

    it("D2. another tenant's real tax class id is rejected (not just a random UUID)", async () => {
      const foreignClass = await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantBId, countryPackCode: 'EG', code: 'standard' },
      });
      const res = await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'Cross-tenant probe' }, taxClassId: foreignClass.id })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/tax class/i);
    });

    it('D3. an inactive tax class id is rejected', async () => {
      const zero = await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantAId, countryPackCode: 'EG', code: 'zero' },
      });
      await admin.taxClass.update({
        where: { id: zero.id },
        data: { isActive: false },
      });
      try {
        await request(http)
          .post('/catalogue/items')
          .set(auth(tokenA))
          .send({ names: { en: 'Inactive class probe' }, taxClassId: zero.id })
          .expect(400);
      } finally {
        await admin.taxClass.update({
          where: { id: zero.id },
          data: { isActive: true },
        });
      }
    });

    it('D4. an arbitrary UUID is rejected on update too', async () => {
      const created = await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'Update probe' } })
        .expect(201);
      const itemId = (created.body as WithId).id;

      await request(http)
        .patch(`/catalogue/items/${itemId}`)
        .set(auth(tokenA))
        .send({ taxClassId: newId() })
        .expect(400);
    });

    it('omitting taxClassId still creates the item (unchanged behaviour)', async () => {
      await request(http)
        .post('/catalogue/items')
        .set(auth(tokenA))
        .send({ names: { en: 'No tax class yet' } })
        .expect(201);
    });
  });
});
