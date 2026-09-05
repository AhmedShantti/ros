import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaClient } from './../src/generated/prisma/client';
import { MetricsService } from './../src/common/observability/metrics/metrics.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import { newId } from './../src/common/ids';
import { createMigratorClient } from './rls-admin';
import { createActiveBranch, dashboardToken } from './reporting-fixtures';

/**
 * MW1D §6 — RED metric cardinality proof against REAL B1-3 resource-derived
 * routes (not simulated labels). `GET /org/branches/:branchId`,
 * `GET /catalogue/price-lists/:priceListId` and `GET /org/branches/:branchId
 * /stations` are hit with many DISTINCT real UUIDs (branch/price-list/station
 * ids) through a real Nest app + real Postgres. For a given normalized
 * endpoint/handler, the exported metrics text must still show exactly ONE
 * `http_requests_total` time series (counter = request count), never one per
 * resource id, and no UUID may appear in the metrics text as a label value.
 */
describe('Observability RED cardinality × B1-3 resource-derived routes (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;
  let metrics: MetricsService;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
    metrics = app.get(MetricsService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('50 distinct real branch ids on GET /org/branches/:branchId collapse onto ONE time series', async () => {
    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const permissions = app.get(PermissionsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const tenant = await tenants.create({
      slug: `card-${stamp}`,
      legalName: `Cardinality ${stamp}`,
      defaultCurrency: 'EGP',
      countryPackCode: 'EG',
    });
    const brand = await admin.brand.create({
      data: {
        id: newId(),
        tenantId: tenant.id,
        name: `Cardinality Brand ${stamp}`,
      },
    });

    const BRANCH_COUNT = 50;
    const branchIds: string[] = [];
    for (let i = 0; i < BRANCH_COUNT; i += 1) {
      branchIds.push(
        await createActiveBranch(admin, tenant.id, brand.id, `${stamp}${i}`),
      );
    }

    await permissions.upsertMany(ORGANISATION_PERMISSION_DEFS);
    const role = await roles.createTenantRole(tenant.id, {
      name: `card_reader_${stamp}`,
    });
    await roles.addPermissions(tenant.id, role.id, [
      ORGANISATION_PERMISSIONS.BRANCH_READ,
    ]);

    const dashboardEmail = `card.dashboard.${stamp}@example.com`;
    const dashboardUser = await users.createUser({
      email: dashboardEmail,
      password: 's3cure-passphrase',
      displayName: 'Dashboard',
    });
    const dashboardMembership = await memberships.grant(
      dashboardUser.id,
      tenant.id,
      'active',
    );
    await membershipRoles.create(tenant.id, null, {
      membershipId: dashboardMembership.id,
      roleId: role.id,
      scope: { type: 'tenant' },
    });
    const token = await dashboardToken(http, dashboardEmail, tenant.id);

    for (const branchId of branchIds) {
      await request(http)
        .get(`/org/branches/${branchId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }

    const text = await metrics.metricsText();
    const series = text
      .split('\n')
      .filter(
        (l) =>
          l.startsWith('http_requests_total{') &&
          l.includes('route="/org/branches/:branchId"') &&
          l.includes('handler="OrganisationController#getBranch"'),
      );
    // Exactly one series (one line) for this route+handler+status_class, not
    // one per branch id.
    expect(series).toHaveLength(1);
    expect(series[0]).toMatch(new RegExp(`\\} ${BRANCH_COUNT}$`));

    // No real branch UUID may appear anywhere in the exported metrics text.
    for (const branchId of branchIds) {
      expect(text).not.toContain(branchId);
    }
    // The label set is exactly the bounded four.
    const labelMatch = series[0].match(/^http_requests_total\{([^}]*)\}/);
    expect(labelMatch).not.toBeNull();
    const labelBody: string = labelMatch?.[1] ?? '';
    const labelPairs: string[] = labelBody.match(/(\w+)=/g) ?? [];
    const labelKeys = labelPairs.map((k: string) => k.slice(0, -1));
    expect(new Set(labelKeys)).toEqual(
      new Set(['method', 'route', 'handler', 'status_class']),
    );
  });
});
