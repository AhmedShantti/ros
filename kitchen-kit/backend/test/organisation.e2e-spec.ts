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
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('Organisation (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  const emailAdminA = `org.adminA.${stamp}@example.com`;
  const emailReadA = `org.readA.${stamp}@example.com`;
  const emailPlainA = `org.plainA.${stamp}@example.com`;
  const emailAdminB = `org.adminB.${stamp}@example.com`;

  let tenantAId: string;
  let tenantBId: string;

  let tokenAdminA: string;
  let tokenReadA: string;
  let tokenPlainA: string;
  let tokenAdminB: string;

  // Tenant A fixtures
  let brandA: string;
  let branchA: string;
  // Tenant B fixtures (cross-tenant targets)
  let brandB: string;
  let branchB: string;
  let stationB: string;

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

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    tenantAId = (
      await tenants.create({
        slug: `orga-${stamp}`,
        legalName: 'Org A',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantBId = (
      await tenants.create({
        slug: `orgb-${stamp}`,
        legalName: 'Org B',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mk = async (
      email: string,
      tenantId: string,
      codes: string[],
    ): Promise<void> => {
      const u = await users.createUser({ email, password, displayName: 'O' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length > 0) {
        const role = await roles.createTenantRole(tenantId, {
          name: `org-role-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.assign(tenantId, m.id, role.id);
      }
    };

    const manageAll = [
      ORGANISATION_PERMISSIONS.TENANT_READ,
      ORGANISATION_PERMISSIONS.TENANT_MANAGE,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    ];
    await mk(emailAdminA, tenantAId, manageAll);
    await mk(emailReadA, tenantAId, [
      ORGANISATION_PERMISSIONS.TENANT_READ,
      ORGANISATION_PERMISSIONS.BRANCH_READ,
    ]);
    await mk(emailPlainA, tenantAId, []);
    await mk(emailAdminB, tenantBId, manageAll);

    tokenAdminA = await scoped(emailAdminA, tenantAId);
    tokenReadA = await scoped(emailReadA, tenantAId);
    tokenPlainA = await scoped(emailPlainA, tenantAId);
    tokenAdminB = await scoped(emailAdminB, tenantBId);

    const seed = async (
      token: string,
      code: string,
    ): Promise<{ brand: string; branch: string; station: string }> => {
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
            baseCurrency: 'EGP',
            countryCode: 'EG',
          })
          .expect(201)
      ).body as WithId;
      const station = (
        await request(http)
          .post(`/org/branches/${branch.id}/stations`)
          .set(auth(token))
          .send({ name: 'Grill' })
          .expect(201)
      ).body as WithId;
      return { brand: brand.id, branch: branch.id, station: station.id };
    };

    const a = await seed(tokenAdminA, `A${stamp % 10000}`);
    brandA = a.brand;
    branchA = a.branch;
    const b = await seed(tokenAdminB, `B${stamp % 10000}`);
    brandB = b.brand;
    branchB = b.branch;
    stationB = b.station;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // ---------------------------------------------------------------- auth ---
  describe('authentication', () => {
    it.each([
      ['get', '/org/brands'],
      ['get', '/org/branches'],
      ['get', '/org/warehouses'],
      ['get', '/org/central-kitchens'],
    ])('unauthenticated %s %s → 401', async (method, path) => {
      await request(http)[method as 'get'](path).expect(401);
    });

    it('unauthenticated POST → 401', async () => {
      await request(http).post('/org/brands').send({ name: 'x' }).expect(401);
    });
  });

  // ----------------------------------------------------------------- rbac ---
  describe('authorization', () => {
    it('no organisation permission → 403 on read', async () => {
      await request(http).get('/org/brands').set(auth(tokenPlainA)).expect(403);
    });

    it('read-only permission cannot mutate → 403', async () => {
      await request(http)
        .post('/org/brands')
        .set(auth(tokenReadA))
        .send({ name: 'Should not be created' })
        .expect(403);
    });

    it('read-only permission can read → 200', async () => {
      await request(http).get('/org/brands').set(auth(tokenReadA)).expect(200);
    });

    it('branch-level permission does not grant tenant-level reassignment', async () => {
      // reassignBrand requires TENANT_MANAGE; the read-only token lacks it.
      await request(http)
        .post(`/org/branches/${branchA}/brand`)
        .set(auth(tokenReadA))
        .send({ brandId: brandA })
        .expect(403);
    });
  });

  // ------------------------------------------------------------ dto guard ---
  describe('input validation', () => {
    it('rejects an unknown property (forbidNonWhitelisted)', async () => {
      await request(http)
        .post('/org/brands')
        .set(auth(tokenAdminA))
        .send({ name: 'Bad', unexpected: 'x' })
        .expect(400);
    });

    it('rejects a client-supplied tenantId', async () => {
      await request(http)
        .post('/org/brands')
        .set(auth(tokenAdminA))
        .send({ name: 'Spoofed', tenantId: tenantBId })
        .expect(400);
    });

    it('rejects a client-supplied branch code change on update', async () => {
      // `code` is immutable (FR-POS-002) and absent from UpdateBranchDto.
      await request(http)
        .patch(`/org/branches/${branchA}`)
        .set(auth(tokenAdminA))
        .send({ code: 'HACKED' })
        .expect(400);
    });

    it('rejects an invalid day_of_week', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/operating-hours`)
        .set(auth(tokenAdminA))
        .send({ dayOfWeek: 7, opensAt: '09:00', closesAt: '17:00' })
        .expect(400);
    });
  });

  // ------------------------------------------------------ tenant isolation ---
  describe('tenant isolation', () => {
    it('tenant A sees only its own brands', async () => {
      const res = await request(http)
        .get('/org/brands')
        .set(auth(tokenAdminA))
        .expect(200);
      const ids = (res.body as WithId[]).map((b) => b.id);
      expect(ids).toContain(brandA);
      expect(ids).not.toContain(brandB);
    });

    it('tenant A cannot read tenant B brand → 404 (not 403)', async () => {
      await request(http)
        .get(`/org/brands/${brandB}`)
        .set(auth(tokenAdminA))
        .expect(404);
    });

    it('tenant A cannot read tenant B branch → 404', async () => {
      await request(http)
        .get(`/org/branches/${branchB}`)
        .set(auth(tokenAdminA))
        .expect(404);
    });

    it('tenant A cannot update tenant B brand → 404', async () => {
      await request(http)
        .patch(`/org/brands/${brandB}`)
        .set(auth(tokenAdminA))
        .send({ name: 'hijacked' })
        .expect(404);
    });

    it('tenant A cannot update tenant B branch → 404', async () => {
      await request(http)
        .patch(`/org/branches/${branchB}`)
        .set(auth(tokenAdminA))
        .send({ name: 'hijacked' })
        .expect(404);
    });

    it('tenant A cannot change tenant B branch status → 404', async () => {
      await request(http)
        .post(`/org/branches/${branchB}/status`)
        .set(auth(tokenAdminA))
        .send({ status: 'inactive' })
        .expect(404);
    });

    it('tenant A cannot read tenant B station → 404', async () => {
      await request(http)
        .get(`/org/stations/${stationB}`)
        .set(auth(tokenAdminA))
        .expect(404);
    });

    it('tenant A cannot list children of a tenant B branch → 404', async () => {
      await request(http)
        .get(`/org/branches/${branchB}/stations`)
        .set(auth(tokenAdminA))
        .expect(404);
      await request(http)
        .get(`/org/branches/${branchB}/tables`)
        .set(auth(tokenAdminA))
        .expect(404);
      await request(http)
        .get(`/org/branches/${branchB}/operating-hours`)
        .set(auth(tokenAdminA))
        .expect(404);
    });

    it('tenant B is unaffected by tenant A activity', async () => {
      const res = await request(http)
        .get('/org/brands')
        .set(auth(tokenAdminB))
        .expect(200);
      const ids = (res.body as WithId[]).map((b) => b.id);
      expect(ids).toContain(brandB);
      expect(ids).not.toContain(brandA);
    });
  });

  // ------------------------------------------- relationship / composite FK ---
  describe('cross-tenant relationship security (ADR 0008 D-09 / D-16)', () => {
    it('branch cannot reference another tenant brand → 404', async () => {
      await request(http)
        .post('/org/branches')
        .set(auth(tokenAdminA))
        .send({
          brandId: brandB,
          code: `X${stamp % 1000}`,
          name: 'Cross-tenant branch',
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        })
        .expect(404);
    });

    it('branch cannot be reassigned to another tenant brand → 404', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/brand`)
        .set(auth(tokenAdminA))
        .send({ brandId: brandB })
        .expect(404);
    });

    it('warehouse cannot reference another tenant branch → 404', async () => {
      await request(http)
        .post('/org/warehouses')
        .set(auth(tokenAdminA))
        .send({ name: `WH-x-${stamp}`, branchId: branchB })
        .expect(404);
    });

    it('central kitchen cannot reference another tenant warehouse → 404', async () => {
      const whB = (
        await request(http)
          .post('/org/warehouses')
          .set(auth(tokenAdminB))
          .send({ name: `WH-B-${stamp}`, warehouseType: 'central' })
          .expect(201)
      ).body as WithId;

      await request(http)
        .post('/org/central-kitchens')
        .set(auth(tokenAdminA))
        .send({ name: `CK-x-${stamp}`, warehouseId: whB.id })
        .expect(404);
    });

    it('station cannot be created under another tenant branch → 404', async () => {
      await request(http)
        .post(`/org/branches/${branchB}/stations`)
        .set(auth(tokenAdminA))
        .send({ name: 'Intruder' })
        .expect(404);
    });

    it('print routing cannot target a station in another branch → 404', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/print-routing`)
        .set(auth(tokenAdminA))
        .send({
          documentType: 'kitchen_ticket',
          printerTarget: 'printer-1',
          stationId: stationB,
        })
        .expect(404);
    });

    it('station routing rule cannot target a station in another branch → 404', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/station-routing-rules`)
        .set(auth(tokenAdminA))
        .send({ stationId: stationB })
        .expect(404);
    });

    it('station cannot use a terminal from another branch (D-16) → 404', async () => {
      // A terminal registered in tenant B's branch.
      const terminalB = await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: tenantBId,
          branchId: branchB,
          name: `t-${stamp}`,
          terminalType: 'kds',
        },
      });
      await request(http)
        .post(`/org/branches/${branchA}/stations`)
        .set(auth(tokenAdminA))
        .send({ name: 'Foreign display', displayTerminalId: terminalB.id })
        .expect(404);
    });
  });

  // ---------------------------------------------------------- uniqueness ---
  describe('uniqueness (ADR 0008 D-15)', () => {
    it('duplicate brand name within a tenant → 409', async () => {
      const name = `Dup Brand ${stamp}`;
      await request(http)
        .post('/org/brands')
        .set(auth(tokenAdminA))
        .send({ name })
        .expect(201);
      await request(http)
        .post('/org/brands')
        .set(auth(tokenAdminA))
        .send({ name })
        .expect(409);
    });

    it('the same brand name is allowed in a DIFFERENT tenant', async () => {
      const name = `Shared Name ${stamp}`;
      await request(http)
        .post('/org/brands')
        .set(auth(tokenAdminA))
        .send({ name })
        .expect(201);
      // Tenant-prefixed uniqueness: no 409 leak across tenants.
      await request(http)
        .post('/org/brands')
        .set(auth(tokenAdminB))
        .send({ name })
        .expect(201);
    });

    it('duplicate station name within a branch → 409', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/stations`)
        .set(auth(tokenAdminA))
        .send({ name: 'Grill' })
        .expect(409);
    });

    it('duplicate table label within a branch → 409', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/tables`)
        .set(auth(tokenAdminA))
        .send({ label: 'T1' })
        .expect(201);
      await request(http)
        .post(`/org/branches/${branchA}/tables`)
        .set(auth(tokenAdminA))
        .send({ label: 'T1' })
        .expect(409);
    });

    it('duplicate branch code within a tenant → 409', async () => {
      await request(http)
        .post('/org/branches')
        .set(auth(tokenAdminA))
        .send({
          brandId: brandA,
          code: `A${stamp % 10000}`,
          name: 'Duplicate code',
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        })
        .expect(409);
    });

    it('one central kitchen per warehouse → 409', async () => {
      const wh = (
        await request(http)
          .post('/org/warehouses')
          .set(auth(tokenAdminA))
          .send({ name: `WH-ck-${stamp}`, warehouseType: 'central' })
          .expect(201)
      ).body as WithId;
      await request(http)
        .post('/org/central-kitchens')
        .set(auth(tokenAdminA))
        .send({ name: `CK1-${stamp}`, warehouseId: wh.id })
        .expect(201);
      await request(http)
        .post('/org/central-kitchens')
        .set(auth(tokenAdminA))
        .send({ name: `CK2-${stamp}`, warehouseId: wh.id })
        .expect(409);
    });

    it('print routing: duplicate branch-level default (station_id NULL) → 409', async () => {
      // This is the case a plain UNIQUE would NOT catch, because PostgreSQL
      // treats NULLs as distinct. The migration applies NULLS NOT DISTINCT.
      await request(http)
        .post(`/org/branches/${branchA}/print-routing`)
        .set(auth(tokenAdminA))
        .send({ documentType: 'receipt', printerTarget: 'front-1' })
        .expect(201);
      await request(http)
        .post(`/org/branches/${branchA}/print-routing`)
        .set(auth(tokenAdminA))
        .send({ documentType: 'receipt', printerTarget: 'front-2' })
        .expect(409);
    });
  });

  // ------------------------------------------------------- operating hours ---
  describe('operating hours (ADR 0008 D-04)', () => {
    it('accepts split shifts on the same weekday', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/operating-hours`)
        .set(auth(tokenAdminA))
        .send({ dayOfWeek: 1, opensAt: '11:00', closesAt: '15:00' })
        .expect(201);
      await request(http)
        .post(`/org/branches/${branchA}/operating-hours`)
        .set(auth(tokenAdminA))
        .send({ dayOfWeek: 1, opensAt: '18:00', closesAt: '23:00' })
        .expect(201);
    });

    it('rejects an overlapping interval → 400', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/operating-hours`)
        .set(auth(tokenAdminA))
        .send({ dayOfWeek: 1, opensAt: '14:00', closesAt: '19:00' })
        .expect(400);
    });

    it('accepts an overnight interval and flags it', async () => {
      const res = await request(http)
        .post(`/org/branches/${branchA}/operating-hours`)
        .set(auth(tokenAdminA))
        .send({ dayOfWeek: 5, opensAt: '20:00', closesAt: '03:00' })
        .expect(201);
      expect((res.body as { overnight: boolean }).overnight).toBe(true);
    });
  });

  // ------------------------------------------------------------- lifecycle ---
  describe('branch status (ADR 0008 D-03)', () => {
    it('accepts active/inactive and rejects anything else', async () => {
      await request(http)
        .post(`/org/branches/${branchA}/status`)
        .set(auth(tokenAdminA))
        .send({ status: 'inactive' })
        .expect(201);
      await request(http)
        .post(`/org/branches/${branchA}/status`)
        .set(auth(tokenAdminA))
        .send({ status: 'suspended' })
        .expect(400);
      await request(http)
        .post(`/org/branches/${branchA}/status`)
        .set(auth(tokenAdminA))
        .send({ status: 'active' })
        .expect(201);
    });
  });

  // ------------------------------------------------------------ no deletes ---
  describe('no delete endpoints exist (ADR 0008 D-12)', () => {
    it.each([
      `/org/brands/`,
      `/org/branches/`,
      `/org/warehouses/`,
      `/org/central-kitchens/`,
      `/org/stations/`,
    ])('DELETE %s:id is not routed', async (base) => {
      const res = await request(http)
        .delete(`${base}${newId()}`)
        .set(auth(tokenAdminA));
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------ P15 location registry ---
  describe('location registry (P15-2/P15-4, Inventory prerequisite)', () => {
    it('registers a location for every branch, warehouse and central kitchen', async () => {
      const wh = (
        await request(http)
          .post('/org/warehouses')
          .set(auth(tokenAdminA))
          .send({ name: `WH-loc-${stamp}` })
          .expect(201)
      ).body as WithId;
      const ck = (
        await request(http)
          .post('/org/central-kitchens')
          .set(auth(tokenAdminA))
          .send({ name: `CK-loc-${stamp}`, warehouseId: wh.id })
          .expect(201)
      ).body as WithId;

      for (const [type, refId] of [
        ['branch', branchA],
        ['warehouse', wh.id],
        ['central_kitchen', ck.id],
      ] as const) {
        const loc = await admin.location.findFirst({
          where: { tenantId: tenantAId, locationType: type, refId },
        });
        expect(loc).not.toBeNull();
        expect(loc?.tenantId).toBe(tenantAId);
        // ck_location_target: exactly one typed column, agreeing with the type.
        const typed = [loc?.branchId, loc?.warehouseId, loc?.centralKitchenId];
        expect(typed.filter((v) => v !== null)).toHaveLength(1);
        expect(loc?.refId).toBe(refId);
      }
    });

    it('leaves no org location entity without a registry row', async () => {
      const missing = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT (
           (SELECT count(*) FROM org.branches b WHERE NOT EXISTS
              (SELECT 1 FROM org.locations l WHERE l.branch_id = b.id))
         + (SELECT count(*) FROM org.warehouses w WHERE NOT EXISTS
              (SELECT 1 FROM org.locations l WHERE l.warehouse_id = w.id))
         + (SELECT count(*) FROM org.central_kitchens c WHERE NOT EXISTS
              (SELECT 1 FROM org.locations l WHERE l.central_kitchen_id = c.id))
         ) AS n`,
      );
      expect(Number(missing[0].n)).toBe(0);
    });

    it('never lets a location tenant disagree with its entity tenant', async () => {
      const mismatched = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM org.locations l
           LEFT JOIN org.branches b ON b.id = l.branch_id
           LEFT JOIN org.warehouses w ON w.id = l.warehouse_id
           LEFT JOIN org.central_kitchens c ON c.id = l.central_kitchen_id
         WHERE l.tenant_id <> COALESCE(b.tenant_id, w.tenant_id, c.tenant_id)`,
      );
      expect(Number(mismatched[0].n)).toBe(0);
    });

    it('rejects a cross-tenant location row (composite FK)', async () => {
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO org.locations
             (id, tenant_id, location_type, ref_id, branch_id, created_at)
           VALUES (gen_random_uuid(), $1, 'branch', $2, $2, now())`,
          tenantBId,
          branchA, // branch belongs to tenant A
        ),
      ).rejects.toThrow();
    });

    it('rejects a row violating the XOR/type-agreement CHECK', async () => {
      await expect(
        admin.$executeRawUnsafe(
          `INSERT INTO org.locations
             (id, tenant_id, location_type, ref_id, branch_id, warehouse_id, created_at)
           VALUES (gen_random_uuid(), $1, 'branch', $2, $2, $2, now())`,
          tenantAId,
          branchA,
        ),
      ).rejects.toThrow();
    });

    it('isolates locations across tenants', async () => {
      const aCount = await admin.location.count({
        where: { tenantId: tenantAId, refId: branchA },
      });
      const bSees = await admin.location.count({
        where: { tenantId: tenantBId, refId: branchA },
      });
      expect(aCount).toBe(1);
      expect(bSees).toBe(0);
    });
  });

  // ----------------------------------------------------------------- audit ---
  describe('audit trail integration', () => {
    it('records an auditable action for a branch brand reassignment', async () => {
      const brand2 = (
        await request(http)
          .post('/org/brands')
          .set(auth(tokenAdminA))
          .send({ name: `Reassign target ${stamp}` })
          .expect(201)
      ).body as WithId;

      await request(http)
        .post(`/org/branches/${branchA}/brand`)
        .set(auth(tokenAdminA))
        .send({ brandId: brand2.id })
        .expect(201);

      const entry = await admin.auditEntry.findFirst({
        where: {
          tenantId: tenantAId,
          action: 'BRANCH_BRAND_REASSIGNED',
          entityId: branchA,
        },
        orderBy: { sequenceNo: 'desc' },
      });
      expect(entry).not.toBeNull();
      expect(entry?.actorType).toBe('user');
      expect(entry?.entryHash).toBeDefined();
    });

    it('does not audit reads', async () => {
      const before = await admin.auditEntry.count({
        where: { tenantId: tenantAId },
      });
      await request(http).get('/org/brands').set(auth(tokenAdminA)).expect(200);
      const after = await admin.auditEntry.count({
        where: { tenantId: tenantAId },
      });
      expect(after).toBe(before);
    });
  });
});
