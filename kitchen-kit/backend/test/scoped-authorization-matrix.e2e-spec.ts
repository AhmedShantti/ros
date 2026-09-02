import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { AccessTokenService } from './../src/modules/identity/auth/access-token.service';
import { MAX_SNAPSHOT_UNITS } from './../src/modules/identity/authz/authorization-snapshot.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import {
  IDENTITY_PERMISSIONS,
  IDENTITY_PERMISSION_DEFS,
} from './../src/modules/identity/authz/permissions.constants';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { TerminalsService } from './../src/modules/identity/terminals/terminals.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { BranchesService } from './../src/modules/organisation/branches/branches.service';
import { BrandsService } from './../src/modules/organisation/brands/brands.service';
import {
  ORGANISATION_PERMISSIONS,
  ORGANISATION_PERMISSION_DEFS,
} from './../src/modules/organisation/organisation.permissions';
import {
  REPORTING_PERMISSIONS,
  REPORTING_PERMISSION_DEFS,
} from './../src/modules/reporting/reporting.permissions';
import {
  TREASURY_PERMISSIONS,
  TREASURY_PERMISSION_DEFS,
} from './../src/modules/treasury/treasury.permissions';
import {
  SALES_PERMISSIONS,
  SALES_PERMISSION_DEFS,
} from './../src/modules/sales/sales.permissions';
import {
  CATALOGUE_PERMISSIONS,
  CATALOGUE_PERMISSION_DEFS,
} from './../src/modules/catalogue/catalogue.permissions';
import { createMigratorClient } from './rls-admin';

/**
 * B1-3 — ROUTE-WIDE SCOPED AUTHORIZATION: THE CROSS-BRANCH SECURITY MATRIX.
 *
 * Authority: "AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC"
 * (RATIFIED 2026-09-02) and `docs/adr/0009-scoped-rbac.md`.
 *
 * B1-2 proved the lattice and the primitive. This suite proves the thing that
 * actually matters to `FR-SEC-004` [M]: that REAL BUSINESS ROUTES, over real
 * HTTP, against real PostgreSQL through the RLS-constrained `ros_app` role,
 * refuse the wrong scope. Every case below drives a route a product would
 * actually call — Organisation, Reporting, Treasury/DayClose, Sales, Catalogue —
 * and NOT an Identity test controller, because a matrix that only exercises the
 * module that owns the primitive proves the primitive, not the enforcement.
 *
 * Fixture shape (one tenant, so that every refusal below is a genuine
 * SAME-TENANT scope refusal and not tenant isolation doing the work for us):
 *
 *   tenant A ── brand X ── branch X1
 *            │          └─ branch X2
 *            └─ brand Y ── branch Y1
 *   tenant B ── brand B ── branch B1
 */

const password = 's3cure-passphrase';
const stamp = Date.now();

interface Tokens {
  accessToken: string;
}

describe('Scoped authorization matrix — B1-3 (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let assignments: MembershipRolesService;
  let roles: RolesService;
  let memberships: MembershipsService;
  let users: UsersService;

  let tenantA: string;
  let tenantB: string;
  let brandX: string;
  let brandY: string;
  let branchX1: string;
  let branchX2: string;
  let branchY1: string;
  let branchB1: string;
  let adminUserId: string;

  /**
   * One POS terminal, one employee and one linked user per branch of tenant A.
   *
   * The employee is linked to a User because a PIN credential requires one
   * (SRS §14) — NOT because the employee record confers anything. C-1: authority
   * comes from the MEMBERSHIP's scoped assignments, and `membershipId` below is
   * what the POS tests grant against.
   */
  const terminals: Record<string, string> = {};
  const employees: Record<
    string,
    { id: string; code: string; membershipId: string }
  > = {};
  const POS_PIN = '481596';

  /** Every business code this suite drives, in ONE role, granted at a scope. */
  const BUSINESS_CODES = [
    ORGANISATION_PERMISSIONS.BRANCH_READ,
    ORGANISATION_PERMISSIONS.TENANT_READ,
    ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    REPORTING_PERMISSIONS.VIEW_SALES,
    REPORTING_PERMISSIONS.VIEW_FINANCIAL,
    TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE,
    SALES_PERMISSIONS.ORDER_CREATE,
    CATALOGUE_PERMISSIONS.ITEM_READ,
  ];

  let roleBusiness: string;
  /** Two SINGLE-CODE roles, for the FR-SEC-004 non-combination case. */
  let roleReadOnly: string;
  let roleManageOnly: string;

  const login = async (email: string): Promise<string> => {
    const res = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as Tokens).accessToken;
  };

  const tokenFor = async (email: string, tenantId: string): Promise<string> => {
    const bearer = await login(email);
    const res = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ tenantId })
      .expect(200);
    return (res.body as Tokens).accessToken;
  };

  /**
   * Create a user in `tenantId` holding `roleId` at `scope`, and return a live
   * tenant-bound token for it. One actor per scope shape, so a leak surfaces as
   * one named test failing rather than a diffuse "something is wrong".
   */
  const actor = async (
    label: string,
    tenantId: string,
    grants: {
      roleId: string;
      scope:
        | { type: 'tenant' }
        | { type: 'brand'; brandId: string }
        | { type: 'branch'; branchId: string };
    }[],
  ): Promise<string> => {
    const email = `b13.${label}.${stamp}@example.com`;
    const user = await users.createUser({
      email,
      displayName: label,
      password,
    });
    const membership = await memberships.grant(user.id, tenantId);
    for (const grant of grants) {
      await assignments.create(tenantId, adminUserId, {
        membershipId: membership.id,
        roleId: grant.roleId,
        scope: grant.scope,
      });
    }
    return tokenFor(email, tenantId);
  };

  const GET = (token: string, url: string) =>
    request(http).get(url).set('Authorization', `Bearer ${token}`);

  const branchUrl = (branchId: string) => `/org/branches/${branchId}`;
  const today = () => new Date().toISOString().slice(0, 10);
  const reportUrl = (branchId: string) =>
    `/reports/branches/${branchId}/daily-trading/${today()}`;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);

    assignments = app.get(MembershipRolesService);
    roles = app.get(RolesService);
    memberships = app.get(MembershipsService);
    users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const permissions = app.get(PermissionsService);
    const brands = app.get(BrandsService);
    const branches = app.get(BranchesService);

    // The modules' OWN declared codes. NOTHING is invented here — SRS
    // Appendix C is absent and clause 20 forbids extending the catalogue.
    await permissions.upsertMany([
      ...IDENTITY_PERMISSION_DEFS,
      ...ORGANISATION_PERMISSION_DEFS,
      ...REPORTING_PERMISSION_DEFS,
      ...TREASURY_PERMISSION_DEFS,
      ...SALES_PERMISSION_DEFS,
      ...CATALOGUE_PERMISSION_DEFS,
    ]);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantA = await mkTenant(`b13-a-${stamp}`);
    tenantB = await mkTenant(`b13-b-${stamp}`);

    adminUserId = (
      await users.createUser({
        email: `b13.admin.${stamp}@example.com`,
        displayName: 'admin',
        password,
      })
    ).id;
    const mAdmin = await memberships.grant(adminUserId, tenantA);
    const roleAdmin = (
      await roles.createTenantRole(tenantA, { name: `b13_admin_${stamp}` })
    ).id;
    await roles.addPermissions(tenantA, roleAdmin, [
      IDENTITY_PERMISSIONS.ROLE_ASSIGN,
      IDENTITY_PERMISSIONS.ROLE_READ,
      ...BUSINESS_CODES,
    ]);
    await assignments.create(tenantA, adminUserId, {
      membershipId: mAdmin.id,
      roleId: roleAdmin,
      scope: { type: 'tenant' },
    });

    brandX = (await brands.create(tenantA, adminUserId, { name: `X ${stamp}` }))
      .id;
    brandY = (await brands.create(tenantA, adminUserId, { name: `Y ${stamp}` }))
      .id;
    const mkBranch = async (
      tenantId: string,
      brandId: string,
      code: string,
    ): Promise<string> =>
      (
        await branches.create(tenantId, adminUserId, {
          brandId,
          code,
          name: code,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        })
      ).id;
    branchX1 = await mkBranch(tenantA, brandX, `X1${stamp % 100000}`);
    branchX2 = await mkBranch(tenantA, brandX, `X2${stamp % 100000}`);
    branchY1 = await mkBranch(tenantA, brandY, `Y1${stamp % 100000}`);

    const brandB = (
      await brands.create(tenantB, adminUserId, { name: `B ${stamp}` })
    ).id;
    branchB1 = await mkBranch(tenantB, brandB, `B1${stamp % 100000}`);

    roleBusiness = (
      await roles.createTenantRole(tenantA, { name: `b13_biz_${stamp}` })
    ).id;
    await roles.addPermissions(tenantA, roleBusiness, BUSINESS_CODES);

    roleReadOnly = (
      await roles.createTenantRole(tenantA, { name: `b13_read_${stamp}` })
    ).id;
    await roles.addPermissions(tenantA, roleReadOnly, [
      ORGANISATION_PERMISSIONS.BRANCH_READ,
    ]);
    roleManageOnly = (
      await roles.createTenantRole(tenantA, { name: `b13_manage_${stamp}` })
    ).id;
    await roles.addPermissions(tenantA, roleManageOnly, [
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    ]);

    // POS substrate: a terminal and an employee per branch. `EmployeeBranch` is
    // HR/authentication-integrity substrate (C-1) — it narrows, it never grants,
    // and the tests below rely on exactly that distinction.
    const terminalsService = app.get(TerminalsService);
    const employeesService = app.get(EmployeesService);
    const pins = app.get(PinService);
    let seq = 0;
    for (const branchId of [branchX1, branchX2, branchY1]) {
      seq += 1;
      terminals[branchId] = (
        await terminalsService.register(tenantA, {
          name: `T${seq}-${stamp % 100000}`,
          terminalType: 'pos',
          branchId,
        })
      ).id;
      const code = `E${seq}${stamp % 100000}`;
      const posUser = await users.createUser({
        email: `b13.pos${seq}.${stamp}@example.com`,
        displayName: `POS ${seq}`,
        password,
      });
      const posMembership = await memberships.grant(posUser.id, tenantA);
      const employee = await employeesService.create(tenantA, adminUserId, {
        code,
        displayName: `Employee ${seq}`,
        homeBranchId: branchId,
        userId: posUser.id,
      });
      await pins.setPin(tenantA, adminUserId, employee.id, POS_PIN);
      employees[branchId] = {
        id: employee.id,
        code,
        membershipId: posMembership.id,
      };
    }
  }, 60_000);

  /** A PIN-issued POS session on `branchId`'s terminal, for `userEmail`'s employee. */
  const posToken = async (branchId: string): Promise<string> => {
    const res = await request(http)
      .post('/auth/pin')
      .send({
        tenantId: tenantA,
        terminalId: terminals[branchId],
        employeeCode: employees[branchId].code,
        pin: POS_PIN,
      })
      .expect(200);
    return (res.body as Tokens).accessToken;
  };

  afterAll(async () => {
    await admin.$disconnect().catch(() => undefined);
    await app.close();
  });

  // ═══════════════════════ 1–7. THE LATTICE, OVER REAL ROUTES ═════════════

  describe('the lattice, enforced by real business routes', () => {
    it('1. TENANT assignment → Branch A AND Branch B both allowed', async () => {
      const token = await actor('m1-tenant', tenantA, [
        { roleId: roleBusiness, scope: { type: 'tenant' } },
      ]);
      await GET(token, branchUrl(branchX1)).expect(200);
      await GET(token, branchUrl(branchX2)).expect(200);
      await GET(token, branchUrl(branchY1)).expect(200);
      // …and on a different module, so this is enforcement, not one route.
      await GET(token, reportUrl(branchX1)).expect(200);
      await GET(token, reportUrl(branchY1)).expect(200);
    });

    it('2. BRAND X assignment → branches OF BRAND X allowed', async () => {
      const token = await actor('m2-brandx', tenantA, [
        { roleId: roleBusiness, scope: { type: 'brand', brandId: brandX } },
      ]);
      await GET(token, branchUrl(branchX1)).expect(200);
      await GET(token, branchUrl(branchX2)).expect(200);
      await GET(token, reportUrl(branchX2)).expect(200);
    });

    it('3. BRAND X → a branch of BRAND Y is DENIED', async () => {
      const token = await actor('m3-brandx', tenantA, [
        { roleId: roleBusiness, scope: { type: 'brand', brandId: brandX } },
      ]);
      await GET(token, branchUrl(branchY1)).expect(403);
      await GET(token, reportUrl(branchY1)).expect(403);
      // …and the BRAND target itself: X may read brand X, never brand Y.
      await GET(token, `/org/brands/${brandX}`).expect(200);
      await GET(token, `/org/brands/${brandY}`).expect(403);
    });

    it('4. BRANCH X1 assignment → Branch X1 allowed', async () => {
      const token = await actor('m4-branchx1', tenantA, [
        { roleId: roleBusiness, scope: { type: 'branch', branchId: branchX1 } },
      ]);
      await GET(token, branchUrl(branchX1)).expect(200);
      await GET(token, reportUrl(branchX1)).expect(200);
    });

    it('5. BRANCH X1 → SIBLING Branch X2 is DENIED (same brand, same tenant)', async () => {
      const token = await actor('m5-branchx1', tenantA, [
        { roleId: roleBusiness, scope: { type: 'branch', branchId: branchX1 } },
      ]);
      await GET(token, branchUrl(branchX2)).expect(403);
      await GET(token, reportUrl(branchX2)).expect(403);
    });

    it('6. BRANCH assignment → a TENANT-target operation is DENIED (no upward leak)', async () => {
      const token = await actor('m6-branchx1', tenantA, [
        { roleId: roleBusiness, scope: { type: 'branch', branchId: branchX1 } },
      ]);
      // `GET /org/brands` and `GET /org/warehouses` are TENANT-target: the
      // collection belongs to the tenant, and a single branch's authority must
      // not read it.
      await GET(token, '/org/brands').expect(403);
      await GET(token, '/org/warehouses').expect(403);
      await GET(token, '/org/branches').expect(403);
      // …while the branch it DOES hold still works, proving the refusal above
      // is about the target and not about the actor being broken.
      await GET(token, branchUrl(branchX1)).expect(200);
    });

    it('7. BRAND assignment → a TENANT-target operation is DENIED (no upward leak)', async () => {
      const token = await actor('m7-brandx', tenantA, [
        { roleId: roleBusiness, scope: { type: 'brand', brandId: brandX } },
      ]);
      await GET(token, '/org/brands').expect(403);
      await GET(token, '/org/branches').expect(403);
      await GET(token, `/org/brands/${brandX}`).expect(200);
    });
  });

  // ══════════════ 8. FR-SEC-004 NON-COMBINATION ACROSS SCOPES ═════════════

  it('8. permission P at Branch X1 + permission Q at Branch X2 never combine', async () => {
    // The SRS clause in its sharpest form: this actor holds settings.branch.read
    // ONLY at X1 and settings.branch.manage ONLY at X2. Neither branch has both.
    const token = await actor('m8-split', tenantA, [
      { roleId: roleReadOnly, scope: { type: 'branch', branchId: branchX1 } },
      { roleId: roleManageOnly, scope: { type: 'branch', branchId: branchX2 } },
    ]);

    // What it genuinely holds, it may do.
    await GET(token, branchUrl(branchX1)).expect(200);

    // Reading X2 needs `read` AT X2 — held only at X1. Refused.
    await GET(token, branchUrl(branchX2)).expect(403);

    // Managing X1 needs `manage` AT X1 — held only at X2. Refused. If the union
    // were computed across scopes, this actor would appear to hold read+manage
    // and both of these would succeed.
    await request(http)
      .patch(branchUrl(branchX1))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'renamed by a leak' })
      .expect(403);
    await request(http)
      .patch(branchUrl(branchX2))
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'renamed at the right scope' })
      .expect(200);
  });

  // ═════════════════════ 9–11. VALIDITY, STALENESS, IDENTITY ══════════════

  it('9. an EXPIRED scoped assignment denies (live DB clock, no sweep)', async () => {
    const email = `b13.m9.${stamp}@example.com`;
    const user = await users.createUser({
      email,
      displayName: 'm9',
      password,
    });
    const membership = await memberships.grant(user.id, tenantA);
    const assignment = await assignments.create(tenantA, adminUserId, {
      membershipId: membership.id,
      roleId: roleBusiness,
      scope: { type: 'branch', branchId: branchX1 },
    });
    const before = await tokenFor(email, tenantA);
    await GET(before, branchUrl(branchX1)).expect(200);

    // Expire it on the DATABASE clock, exactly as a temporary elevation lapsing
    // would. The window is moved wholesale into the past because
    // `ck_membership_role_validity_window` requires `valid_to > valid_from` —
    // an expired assignment is a HISTORICAL one, not a malformed one.
    await admin.$executeRaw`
      UPDATE identity.membership_roles
         SET valid_from = now() - interval '2 hours',
             valid_to   = now() - interval '1 hour'
       WHERE id = ${assignment.id}::uuid`;

    const after = await tokenFor(email, tenantA);
    await GET(after, branchUrl(branchX1)).expect(403);
  });

  it('10. a STALE token after re-scoping denies, on the very next request', async () => {
    const email = `b13.m10.${stamp}@example.com`;
    const user = await users.createUser({
      email,
      displayName: 'm10',
      password,
    });
    const membership = await memberships.grant(user.id, tenantA);
    const assignment = await assignments.create(tenantA, adminUserId, {
      membershipId: membership.id,
      roleId: roleBusiness,
      scope: { type: 'branch', branchId: branchX1 },
    });
    const token = await tokenFor(email, tenantA);
    await GET(token, branchUrl(branchX1)).expect(200);

    // Re-scope X1 -> X2 through the real admin API. The token in hand still
    // *claims* X1 in `pbr`; live resolution is what decides.
    const adminToken = await tokenFor(`b13.admin.${stamp}@example.com`, tenantA);
    await request(http)
      .patch(`/auth/role-assignments/${assignment.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scope: { type: 'branch', branchId: branchX2 } })
      .expect(200);

    // The SAME token, unchanged, is now refused — both because the epoch moved
    // (T-4-LIVE) and because the live authority no longer covers X1.
    await GET(token, branchUrl(branchX1)).expect(403);

    const fresh = await tokenFor(email, tenantA);
    await GET(fresh, branchUrl(branchX1)).expect(403);
    await GET(fresh, branchUrl(branchX2)).expect(200);
  });

  it('11. a user with NO Employee record follows scoped RBAC normally', async () => {
    // C-1: authority comes from the assignment, never from HR substrate. A
    // dashboard user has no Employee at all and must still be fully governed.
    const token = await actor('m11-noemployee', tenantA, [
      { roleId: roleBusiness, scope: { type: 'branch', branchId: branchY1 } },
    ]);
    await GET(token, branchUrl(branchY1)).expect(200);
    await GET(token, branchUrl(branchX1)).expect(403);
    await GET(token, '/org/brands').expect(403);
  });

  // ═══════════════════════════ 14. CROSS-TENANT ═══════════════════════════

  it('14. a cross-tenant target is refused with NO existence oracle', async () => {
    const token = await actor('m14-tenant', tenantA, [
      { roleId: roleBusiness, scope: { type: 'tenant' } },
    ]);

    // Tenant A holds TENANT-wide authority — the widest there is — and still
    // cannot reach tenant B's branch. The answer must be byte-identical to the
    // answer for a branch that has never existed, or the refusal itself becomes
    // the disclosure.
    const foreign = await GET(token, branchUrl(branchB1));
    const absent = await GET(token, branchUrl(newId()));
    expect(foreign.status).toBe(absent.status);
    expect(foreign.status).toBe(404);
    expect((foreign.body as { message: string }).message).toBe(
      (absent.body as { message: string }).message,
    );

    // The same, on a second module, so this is the repository's answer and not
    // one route's accident.
    const foreignReport = await GET(token, reportUrl(branchB1));
    const absentReport = await GET(token, reportUrl(newId()));
    expect(foreignReport.status).toBe(absentReport.status);
    expect(foreignReport.status).toBe(404);
    expect((foreignReport.body as { message: string }).message).toBe(
      (absentReport.body as { message: string }).message,
    );

    // And a BRAND target behaves identically.
    const brandBOfTenantB = await admin.brand.findFirst({
      where: { tenantId: tenantB },
      select: { id: true },
    });
    const foreignBrand = await GET(
      token,
      `/org/brands/${brandBOfTenantB!.id}`,
    );
    const absentBrand = await GET(token, `/org/brands/${newId()}`);
    expect(foreignBrand.status).toBe(absentBrand.status);
    expect(foreignBrand.status).toBe(404);
  });

  // ══════════ 9(§9). IMPLICIT / RESOURCE-DERIVED TARGETS ═══════════════════

  describe('resource-derived targets: the branch is NOT in the route', () => {
    it('an ORDER is authorized against the order row’s own branch', async () => {
      // Arrange two orders, one per branch, through the migrator client — the
      // point under test is the AUTHORIZATION path, not order creation.
      const mkOrder = async (branchId: string): Promise<string> => {
        const id = newId();
        const branch = await admin.branch.findUniqueOrThrow({
          where: { id: branchId },
          select: { code: true },
        });
        await admin.order.create({
          data: {
            id,
            tenantId: tenantA,
            branchId,
            terminalId: terminals[branchId],
            openedBy: employees[branchId].id,
            businessDay: new Date(`${today()}T00:00:00.000Z`),
            orderNumber: `${branch.code}-${String(Date.now() % 1000000)}`,
            orderType: 'dine_in',
            channel: 'pos',
            state: 'open',
            currency: 'EGP',
            countryPackVersion: 'v1',
            openedAt: new Date(),
            originDeviceTime: new Date(),
            idempotencyKey: newId(),
          },
        });
        return id;
      };
      const orderX1 = await mkOrder(branchX1);
      const orderX2 = await mkOrder(branchX2);

      const token = await actor('m9r-branchx1', tenantA, [
        { roleId: roleBusiness, scope: { type: 'branch', branchId: branchX1 } },
      ]);
      const url = (id: string) => `/orders/${today()}/${id}`;

      // Its own branch's order: allowed. The sibling branch's: refused — and
      // nothing in the request said "branch" at all.
      await GET(token, url(orderX1)).expect(200);
      await GET(token, url(orderX2)).expect(403);

      // The unfiltered collection read is a TENANT-target question, so a
      // single-branch actor is refused rather than silently narrowed.
      await GET(token, '/orders').expect(403);
      await GET(token, `/orders?branchId=${branchX1}`).expect(200);
      await GET(token, `/orders?branchId=${branchX2}`).expect(403);
    });

    it('an order in ANOTHER TENANT is a tenant-safe 404, not a scope refusal', async () => {
      const id = newId();
      const foreignTerminal = await admin.terminal.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          branchId: branchB1,
          name: `FT-${stamp % 100000}`,
          terminalType: 'pos',
        },
      });
      const foreignEmployee = await admin.employee.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          code: `FE${stamp % 100000}`,
          displayName: 'Foreign',
          homeBranchId: branchB1,
        },
      });
      await admin.order.create({
        data: {
          id,
          tenantId: tenantB,
          branchId: branchB1,
          terminalId: foreignTerminal.id,
          openedBy: foreignEmployee.id,
          businessDay: new Date(`${today()}T00:00:00.000Z`),
          orderNumber: `FGN-${String(Date.now() % 1000000)}`,
          orderType: 'dine_in',
          channel: 'pos',
          state: 'open',
          currency: 'EGP',
          countryPackVersion: 'v1',
          openedAt: new Date(),
          originDeviceTime: new Date(),
          idempotencyKey: newId(),
        },
      });
      const token = await actor('m9r-tenant', tenantA, [
        { roleId: roleBusiness, scope: { type: 'tenant' } },
      ]);
      const foreign = await GET(token, `/orders/${today()}/${id}`);
      const absent = await GET(token, `/orders/${today()}/${newId()}`);
      expect(foreign.status).toBe(404);
      expect(absent.status).toBe(404);
      expect((foreign.body as { message: string }).message).toBe(
        (absent.body as { message: string }).message,
      );
    });

    it('a STATION is authorized against the station row’s own branch', async () => {
      // Stations carry no tenant_id — their tenant boundary IS the parent
      // branch — so a station id alone says nothing about what is being touched
      // until the row is read.
      const mkStation = async (branchId: string): Promise<string> => {
        const id = newId();
        await admin.station.create({
          data: { id, branchId, name: `S-${id.slice(0, 8)}` },
        });
        return id;
      };
      const stationX1 = await mkStation(branchX1);
      const stationX2 = await mkStation(branchX2);

      const token = await actor('m9s-branchx1', tenantA, [
        { roleId: roleBusiness, scope: { type: 'branch', branchId: branchX1 } },
      ]);
      await GET(token, `/org/stations/${stationX1}`).expect(200);
      await GET(token, `/org/stations/${stationX2}`).expect(403);
    });

    it('a CASH-CLOSE POLICY write is authorized at the branch in its path', async () => {
      const token = await actor('m9t-branchx1', tenantA, [
        { roleId: roleBusiness, scope: { type: 'branch', branchId: branchX1 } },
      ]);
      const body = {
        effectiveFrom: new Date().toISOString(),
        countMode: 'blind',
        toleranceMinorUnits: '100',
        currency: 'EGP',
      };
      await request(http)
        .post(`/branches/${branchX2}/cash-close-policy`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(403);
    });
  });

  // ══════════════════════════ 12–13. POS NARROWING ════════════════════════

  describe('POS: three independent conditions, none substituting for another', () => {
    const orderAt = async (branchId: string): Promise<string> => {
      const id = newId();
      const branch = await admin.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { code: true },
      });
      await admin.order.create({
        data: {
          id,
          tenantId: tenantA,
          branchId,
          terminalId: terminals[branchId],
          openedBy: employees[branchId].id,
          businessDay: new Date(`${today()}T00:00:00.000Z`),
          orderNumber: `${branch.code}-P${String(Date.now() % 1000000)}`,
          orderType: 'dine_in',
          channel: 'pos',
          state: 'open',
          currency: 'EGP',
          countryPackVersion: 'v1',
          openedAt: new Date(),
          originDeviceTime: new Date(),
          idempotencyKey: newId(),
        },
      });
      return id;
    };

    it('13. a TENANT-wide role on a POS session cannot cross its terminal’s branch', async () => {
      // The employee behind this session is permitted at X1 and holds a
      // TENANT-scoped business role — the widest authority the lattice has. The
      // terminal it signed in on is bound to X1, and that is the ceiling.
      await assignments.create(tenantA, adminUserId, {
        membershipId: employees[branchX1].membershipId,
        roleId: roleBusiness,
        scope: { type: 'tenant' },
      });
      const orderX1 = await orderAt(branchX1);
      const orderX2 = await orderAt(branchX2);

      const token = await posToken(branchX1);
      await GET(token, `/orders/${today()}/${orderX1}`).expect(200);
      await GET(token, `/orders/${today()}/${orderX2}`).expect(403);
    });

    it('12. EmployeeBranch NARROWS and never GRANTS — removing it denies the next request', async () => {
      // Same session shape as above, on branch X2's terminal.
      await assignments.create(tenantA, adminUserId, {
        membershipId: employees[branchX2].membershipId,
        roleId: roleBusiness,
        scope: { type: 'tenant' },
      });
      const orderX2 = await orderAt(branchX2);
      const before = await posToken(branchX2);
      await GET(before, `/orders/${today()}/${orderX2}`).expect(200);

      // Revoke the HR permission at the terminal's branch. The role assignment
      // is untouched and still tenant-wide, so if EmployeeBranch were an OR
      // rather than an AND, nothing would change.
      await admin.employeeBranch.deleteMany({
        where: { employeeId: employees[branchX2].id, branchId: branchX2 },
      });
      await GET(before, `/orders/${today()}/${orderX2}`).expect(403);

      // Restore, so this suite leaves the fixture as it found it.
      await admin.employeeBranch.create({
        data: {
          tenantId: tenantA,
          employeeId: employees[branchX2].id,
          branchId: branchX2,
        },
      });
      const after = await posToken(branchX2);
      await GET(after, `/orders/${today()}/${orderX2}`).expect(200);
    });

    it('EmployeeBranch alone grants NOTHING: an employee with no role assignment is refused', async () => {
      // Branch Y1's POS employee is permitted at Y1 by EmployeeBranch and has no
      // scoped role at all. C-1: membership → assignment → role → permission is
      // the ONLY grant path, and this is the test that would fail first if the
      // permitted-branch relation ever drifted into being a second one.
      const orderY1 = await orderAt(branchY1);
      const token = await posToken(branchY1);
      await GET(token, `/orders/${today()}/${orderY1}`).expect(403);
    });
  });

  // ═════════════════ TOKEN SIZE AT THE 128-UNIT BOUNDARY ══════════════════

  describe('T-4-LIVE token size, MEASURED (not estimated)', () => {
    it('a worst-allowed 128-unit tenant-bound token, in real serialized bytes', async () => {
      // ── FINDING B1-3/F-1 — THE "~6 KB" ESTIMATE WAS WRONG ─────────────────
      //
      // B1-2 reasoned about token size as "roughly 45 bytes per rendered entry
      // ... caps the two claims near 6 KB — inside the ~8 KB header budget of
      // common reverse proxies". The brief forbids claiming safety from that
      // estimate, so this measures instead. The estimate is low by about 2.6x,
      // for two compounding reasons it did not account for:
      //
      //   1. an explicit branch id is carried TWICE — once as a `branch:<uuid>`
      //      scope-set entry and again as a raw uuid in `pbr.branches`;
      //   2. the JWT payload is base64url-encoded, which expands it by 4/3.
      //
      // The consequence is OPERATIONAL, not an authorization defect: overflow
      // still fails closed (next test), nothing is truncated, and no authority
      // is misdescribed. But a worst-allowed token does NOT fit the DEFAULT
      // per-header limit of nginx (`large_client_header_buffers` 8k) or Apache
      // (`LimitRequestFieldSize` 8190) — such a deployment would answer 431/400
      // and the holder would simply be unable to use the system.
      //
      // This test therefore asserts the MEASURED reality, including the part
      // that is uncomfortable. It is deliberately written so that changing
      // `MAX_SNAPSHOT_UNITS`, or the claim encoding, fails it and forces the
      // question back through review rather than letting it drift.
      const sign = async (units: number): Promise<string> => {
        const branchIds = Array.from({ length: units }, () => newId());
        return app.get(AccessTokenService).sign({
          sub: newId(),
          sid: newId(),
          tid: tenantA,
          mid: newId(),
          scp: branchIds.map((id) => `branch:${id}`).sort(),
          pbr: {
            v: 1 as const,
            all: false,
            brands: [] as string[],
            branches: [...branchIds].sort(),
          },
          epo: 2_147_483_647,
        });
      };

      // Worst-allowed = MAX_SNAPSHOT_UNITS units, all of the LONGEST kind. A
      // `branch:<uuid>` entry is one byte longer than `brand:<uuid>`, and a
      // branch id is carried in BOTH claims, so this is the largest snapshot
      // that can ever be issued.
      const worst = await sign(MAX_SNAPSHOT_UNITS);
      const baseline = await sign(0);

      const jwtBytes = Buffer.byteLength(worst, 'utf8');
      const headerBytes = Buffer.byteLength(
        `Authorization: Bearer ${worst}\r\n`,
        'utf8',
      );
      const baselineBytes = Buffer.byteLength(baseline, 'utf8');
      const bytesPerUnit = (jwtBytes - baselineBytes) / MAX_SNAPSHOT_UNITS;

      // eslint-disable-next-line no-console
      console.log('B1-3 MEASURED worst-allowed token size:', {
        units: MAX_SNAPSHOT_UNITS,
        serializedJwtBytes: jwtBytes,
        authorizationHeaderBytes: headerBytes,
        emptySnapshotJwtBytes: baselineBytes,
        bytesPerUnit: Number(bytesPerUnit.toFixed(1)),
        unitsThatFitAn8190ByteHeader: Math.floor(
          (8190 - (headerBytes - jwtBytes) - baselineBytes) / bytesPerUnit,
        ),
      });

      // The finding, asserted so it cannot quietly stop being true in either
      // direction. If a future change makes the worst token FIT 8190, this line
      // fails and the finding gets closed deliberately rather than by accident.
      expect(headerBytes).toBeGreaterThan(8190);

      // The actionable deployment requirement: a 16 KB header allowance is
      // sufficient with room to spare. This is what the report records as the
      // operating constraint until the budget itself is revisited.
      expect(headerBytes).toBeLessThan(16384);

      // And the token is genuinely well-formed at that size — a size test that
      // measured an unusable token would prove nothing.
      const decoded = await app.get(AccessTokenService).verify(worst);
      expect(decoded.scp).toHaveLength(MAX_SNAPSHOT_UNITS);
      expect(decoded.pbr?.branches).toHaveLength(MAX_SNAPSHOT_UNITS);
    });

    it('OVERFLOW STILL FAILS CLOSED: no token is issued, and nothing is truncated', async () => {
      // A real membership pushed one unit past the budget, exercised through the
      // real mint path. Brand scopes are used because they cost one unit each
      // exactly as branch scopes do, without needing 129 branches and their
      // location-registry rows.
      const email = `b13.overflow.${stamp}@example.com`;
      const user = await users.createUser({
        email,
        displayName: 'overflow',
        password,
      });
      const membership = await memberships.grant(user.id, tenantA);

      const mkBrandAssignment = async (index: number): Promise<void> => {
        const brandId = newId();
        await admin.brand.create({
          data: {
            id: brandId,
            tenantId: tenantA,
            name: `OF ${stamp} ${index}`,
          },
        });
        await admin.membershipRole.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            membershipId: membership.id,
            roleId: roleReadOnly,
            scopeType: 'brand',
            scopeBrandId: brandId,
          },
        });
      };

      for (let i = 0; i < MAX_SNAPSHOT_UNITS; i += 1) {
        await mkBrandAssignment(i);
      }
      // Exactly at the budget: a token is issued.
      await expect(tokenFor(email, tenantA)).resolves.toEqual(
        expect.any(String),
      );

      // One over: REFUSED. Not truncated to 128, not issued understating the
      // holder's authority — a token that silently described less authority than
      // its holder has would teach every reader to treat an incomplete set as
      // complete.
      await mkBrandAssignment(MAX_SNAPSHOT_UNITS);
      const bearer = await login(email);
      await request(http)
        .post('/auth/tenant')
        .set('Authorization', `Bearer ${bearer}`)
        .send({ tenantId: tenantA })
        .expect(403);
    }, 120_000);
  });

  // ═══════════════════════ M-4+ AND THE RETIRED MASK ══════════════════════

  it('DAY CLOSE: a branch-scoped closer is refused at a sibling branch', async () => {
    const token = await actor('m-dayclose', tenantA, [
      { roleId: roleBusiness, scope: { type: 'branch', branchId: branchX1 } },
    ]);
    await request(http)
      .post(`/branches/${branchX2}/day-closes/${today()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(403);
  });

  it('the tenant now has THREE active branches and reporting still works per branch', async () => {
    // The Internal-MVP single-active-branch mask would have refused every one of
    // these. Its retirement is what makes the rest of this matrix meaningful:
    // a multi-branch tenant is the only shape in which cross-branch leakage can
    // even be expressed.
    const active = await admin.branch.count({
      where: { tenantId: tenantA, status: 'active' },
    });
    expect(active).toBeGreaterThanOrEqual(3);

    const token = await actor('m-mask', tenantA, [
      { roleId: roleBusiness, scope: { type: 'tenant' } },
    ]);
    await GET(token, reportUrl(branchX1)).expect(200);
    await GET(token, reportUrl(branchX2)).expect(200);
    await GET(token, reportUrl(branchY1)).expect(200);
  });
});
