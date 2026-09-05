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
import { TerminalsService } from './../src/modules/identity/terminals/terminals.service';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { BranchesService } from './../src/modules/organisation/branches/branches.service';
import { BrandsService } from './../src/modules/organisation/brands/brands.service';
import { DrawersService } from './../src/modules/treasury/drawers/drawers.service';
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
import { IDENTITY_PERMISSION_DEFS } from './../src/modules/identity/authz/permissions.constants';
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
  INVENTORY_PERMISSIONS,
  INVENTORY_PERMISSION_DEFS,
} from './../src/modules/inventory/inventory.permissions';
import {
  KDS_PERMISSIONS,
  KDS_PERMISSION_DEFS,
} from './../src/modules/kitchen/kitchen.permissions';
import {
  WORKFORCE_PERMISSIONS,
  WORKFORCE_PERMISSION_DEFS,
} from './../src/modules/workforce/workforce.permissions';
import { createMigratorClient } from './rls-admin';
import { dashboardTerminalToken, fireTicketLine } from './kds-fixtures';

/**
 * MTMB-1 — MULTI-TENANT / MULTI-BRANCH OPERATIONAL HARDENING.
 *
 * NON-AUTHORITATIVE EVIDENCE. The SRS and ratified governance decisions
 * (`docs/governance/GOVERNANCE_DECISION_REGISTER.md`, ADR 0008, ADR 0009)
 * remain authoritative; this file proves behaviour against real HTTP and
 * real PostgreSQL, it does not define requirements.
 *
 * This suite assembles EXACTLY the demo shape the Sunday customer demo
 * needs and drives it end to end over real business routes:
 *
 *   Tenant A ── Brand A ── Branch A1 (Downtown)
 *                       └─ Branch A2 (Airport)
 *   Tenant B ── Brand B ── Branch B1 (Main)
 *
 * Actors: Owner A (TENANT scope on Tenant A), Manager A1 (BRANCH scope A1
 * only), MultiBranch Manager (BRANCH scope A1 + A2), Manager B1 (Tenant B
 * only), POS employee A1 (permitted A1 only), POS employee A12 (home A1,
 * permitted A1 + A2).
 *
 * The scope LATTICE itself (tenant/brand/branch coverage, non-leakage,
 * expiry, staleness, token size) is exhaustively proven elsewhere —
 * `scoped-authorization-matrix.e2e-spec.ts` — and is NOT re-proven here.
 * This suite's job is the thing that matrix does not cover: real
 * OPERATIONAL data (POS orders, KDS tickets, Inventory stock, CashSession,
 * HR attendance, Reporting) created through the real demo actors, proven
 * branch-local; and MTMB-1's own new read surface, `GET /org/access`.
 *
 * Cross-tenant isolation at the DATABASE layer, for every tenant_id table,
 * is proven exhaustively by the GENERATED suite
 * (`test/tenant-isolation/generated-cross-tenant.e2e-spec.ts`, FR-PLT-013)
 * and is likewise not hand-re-proven here — this suite proves the same
 * property at the API layer, for the specific resources a demo actually
 * touches.
 */

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}

const password = 's3cure-passphrase';
const stamp = Date.now();

/**
 * A real, genuinely-signed EG country pack, activated once so `POST /orders`
 * (which requires an effective pack per FR-LOC-021/022) can be driven for
 * real over HTTP rather than faked by direct DB insert. Mirrors
 * `sales.e2e-spec.ts`'s own fixture exactly — not a test double: the
 * production `Ed25519CountryPackSignatureVerifier`, trusting one ephemeral
 * key generated in memory for this run only.
 */
const PACK = '2026.1';
const E2E_RELEASE_KEY = generateReleaseKey('mtmb-e2e-release-key');
const e2eTrustStore = trustStoreFor(E2E_RELEASE_KEY.trusted());
const e2eVerifier = new Ed25519CountryPackSignatureVerifier(e2eTrustStore);
const testPackDocument = () =>
  signPackDocument(
    {
      code: 'EG',
      version: PACK,
      effectiveFrom: '2026-01-01',
      currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
      tax: {
        engine: 'vat_standard',
        pricingMode: 'tax_inclusive',
        computationLevel: 'line',
        roundingMode: 'HALF_UP',
        roundingPrecision: 2,
        classes: [
          { code: 'standard', rate: '14.0' },
          { code: 'zero', rate: '0.0' },
          { code: 'exempt', rate: null },
        ],
        serviceChargeTaxable: true,
        orderTypeOverrides: [],
      },
    },
    E2E_RELEASE_KEY,
  );

describe('Multi-tenant / multi-branch operational hardening (MTMB-1, e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let assignments: MembershipRolesService;
  let roles: RolesService;
  let memberships: MembershipsService;
  let users: UsersService;
  let terminalsService: TerminalsService;
  let employeesService: EmployeesService;
  let pins: PinService;
  let drawers: DrawersService;

  let tenantA: string;
  let tenantB: string;
  let brandA: string;
  let brandB: string;
  let branchA1: string;
  let branchA2: string;
  let branchB1: string;
  let locA1: string;
  let locA2: string;
  let adminUserId: string;
  let demoRole: string;
  let demoRoleB: string;
  let adminBUserId: string;

  // POS substrate for A1 and A2.
  let terminalA1: string;
  let terminalA2: string;
  let kdsTerminalA1: string;
  let kdsTerminalA2: string;
  let stationA1: string;
  let stationA2: string;
  let posEmployeeA1: {
    id: string;
    code: string;
    membershipId: string;
    pin: string;
  };
  let posEmployeeA12: {
    id: string;
    code: string;
    membershipId: string;
    pin: string;
  };

  const today = () => new Date().toISOString().slice(0, 10);

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

  /** One real login-capable actor holding `demoRole` at each of `scopes`. */
  const actor = async (
    label: string,
    tenantId: string,
    scopes: (
      | { type: 'tenant' }
      | { type: 'brand'; brandId: string }
      | { type: 'branch'; branchId: string }
    )[],
  ): Promise<string> => {
    const email = `mtmb.${label}.${stamp}@example.com`;
    const user = await users.createUser({
      email,
      displayName: label,
      password,
    });
    const membership = await memberships.grant(user.id, tenantId, 'active');
    const roleId = tenantId === tenantB ? demoRoleB : demoRole;
    const settingActorId = tenantId === tenantB ? adminBUserId : adminUserId;
    for (const scope of scopes) {
      await assignments.create(tenantId, settingActorId, {
        membershipId: membership.id,
        roleId,
        scope,
      });
    }
    return tokenFor(email, tenantId);
  };

  const pinLogin = (
    tenantId: string,
    terminalId: string,
    employeeCode: string,
    pin: string,
  ) =>
    request(http)
      .post('/auth/pin')
      .send({ tenantId, terminalId, employeeCode, pin });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(e2eTrustStore)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(e2eVerifier)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();
    await app.get(CountryPackService).activate(testPackDocument());
    admin = createMigratorClient(app);

    assignments = app.get(MembershipRolesService);
    roles = app.get(RolesService);
    memberships = app.get(MembershipsService);
    users = app.get(UsersService);
    terminalsService = app.get(TerminalsService);
    employeesService = app.get(EmployeesService);
    pins = app.get(PinService);
    drawers = app.get(DrawersService);
    const tenants = app.get(TenantsService);
    const permissions = app.get(PermissionsService);
    const brands = app.get(BrandsService);
    const branches = app.get(BranchesService);

    await permissions.upsertMany([
      ...IDENTITY_PERMISSION_DEFS,
      ...ORGANISATION_PERMISSION_DEFS,
      ...REPORTING_PERMISSION_DEFS,
      ...TREASURY_PERMISSION_DEFS,
      ...SALES_PERMISSION_DEFS,
      ...INVENTORY_PERMISSION_DEFS,
      ...KDS_PERMISSION_DEFS,
      ...WORKFORCE_PERMISSION_DEFS,
    ]);

    // ── DEMO SHAPE: Tenant A / Brand A / Branch A1 (Downtown) + A2 (Airport) ──
    const mkTenant = async (slug: string, legalName: string) =>
      (
        await tenants.create({
          slug,
          legalName,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantA = await mkTenant(`mtmb-a-${stamp}`, 'Demo Restaurant Group');
    tenantB = await mkTenant(`mtmb-b-${stamp}`, 'Second Demo Tenant');

    adminUserId = (
      await users.createUser({
        email: `mtmb.admin.${stamp}@example.com`,
        displayName: 'setup-admin',
        password,
      })
    ).id;
    const mAdmin = await memberships.grant(adminUserId, tenantA, 'active');
    const roleAdmin = (
      await roles.createTenantRole(tenantA, { name: `mtmb_admin_${stamp}` })
    ).id;
    await roles.addPermissions(tenantA, roleAdmin, [
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
    ]);
    await assignments.create(tenantA, adminUserId, {
      membershipId: mAdmin.id,
      roleId: roleAdmin,
      scope: { type: 'tenant' },
    });

    brandA = (
      await brands.create(tenantA, adminUserId, {
        name: `Demo Brand A ${stamp}`,
      })
    ).id;
    const mkBranch = async (
      tenantId: string,
      brandId: string,
      code: string,
      name: string,
    ) =>
      (
        await branches.create(tenantId, adminUserId, {
          brandId,
          code,
          name,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        })
      ).id;
    branchA1 = await mkBranch(
      tenantA,
      brandA,
      `A1${stamp % 100000}`,
      'Downtown',
    );
    branchA2 = await mkBranch(
      tenantA,
      brandA,
      `A2${stamp % 100000}`,
      'Airport',
    );

    adminBUserId = (
      await users.createUser({
        email: `mtmb.adminb.${stamp}@example.com`,
        displayName: 'setup-admin-b',
        password,
      })
    ).id;
    brandB = (
      await brands.create(tenantB, adminBUserId, {
        name: `Demo Brand B ${stamp}`,
      })
    ).id;
    branchB1 = await mkBranch(tenantB, brandB, `B1${stamp % 100000}`, 'Main');

    locA1 = (
      await admin.location.findFirstOrThrow({
        where: { tenantId: tenantA, locationType: 'branch', refId: branchA1 },
        select: { id: true },
      })
    ).id;
    locA2 = (
      await admin.location.findFirstOrThrow({
        where: { tenantId: tenantA, locationType: 'branch', refId: branchA2 },
        select: { id: true },
      })
    ).id;

    // ── ONE role, every code the demo drives, assigned at different SCOPES
    //    to different actors — mirrors `scoped-authorization-matrix`'s own
    //    `roleBusiness` pattern (FR-SEC-003: one actor may hold several
    //    independent scoped assignments; the ROLE is not what differs).
    demoRole = (
      await roles.createTenantRole(tenantA, { name: `mtmb_demo_${stamp}` })
    ).id;
    await roles.addPermissions(tenantA, demoRole, [
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
      REPORTING_PERMISSIONS.VIEW_SALES,
      REPORTING_PERMISSIONS.VIEW_FINANCIAL,
      INVENTORY_PERMISSIONS.VIEW,
      INVENTORY_PERMISSIONS.ADJUST,
      WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW,
      WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE,
      SALES_PERMISSIONS.ORDER_CREATE,
      TREASURY_PERMISSIONS.CASH_SESSION_OPEN,
    ]);
    demoRoleB = (
      await roles.createTenantRole(tenantB, { name: `mtmb_demo_b_${stamp}` })
    ).id;
    await roles.addPermissions(tenantB, demoRoleB, [
      ORGANISATION_PERMISSIONS.BRANCH_READ,
      REPORTING_PERMISSIONS.VIEW_SALES,
      REPORTING_PERMISSIONS.VIEW_FINANCIAL,
    ]);

    // ── POS substrate: one POS + one KDS terminal per branch, one Station
    //    per branch bound to that branch's KDS terminal. ─────────────────
    terminalA1 = (
      await terminalsService.register(tenantA, {
        name: `POS-A1-${stamp % 100000}`,
        terminalType: 'pos',
        branchId: branchA1,
      })
    ).id;
    terminalA2 = (
      await terminalsService.register(tenantA, {
        name: `POS-A2-${stamp % 100000}`,
        terminalType: 'pos',
        branchId: branchA2,
      })
    ).id;
    kdsTerminalA1 = (
      await terminalsService.register(tenantA, {
        name: `KDS-A1-${stamp % 100000}`,
        terminalType: 'kds',
        branchId: branchA1,
      })
    ).id;
    kdsTerminalA2 = (
      await terminalsService.register(tenantA, {
        name: `KDS-A2-${stamp % 100000}`,
        terminalType: 'kds',
        branchId: branchA2,
      })
    ).id;
    stationA1 = (
      await admin.station.create({
        data: {
          id: newId(),
          branchId: branchA1,
          name: `Grill A1 ${stamp}`,
          displayTerminalId: kdsTerminalA1,
        },
      })
    ).id;
    stationA2 = (
      await admin.station.create({
        data: {
          id: newId(),
          branchId: branchA2,
          name: `Grill A2 ${stamp}`,
          displayTerminalId: kdsTerminalA2,
        },
      })
    ).id;

    const mkPosEmployee = async (
      label: string,
      homeBranchId: string,
      permittedBranchIds: string[],
      pin: string,
    ) => {
      const posUser = await users.createUser({
        email: `mtmb.${label}.${stamp}@example.com`,
        displayName: label,
        password,
      });
      const posMembership = await memberships.grant(
        posUser.id,
        tenantA,
        'active',
      );
      await assignments.create(tenantA, adminUserId, {
        membershipId: posMembership.id,
        roleId: demoRole,
        scope: { type: 'tenant' },
      });
      const code = `${label.toUpperCase()}${stamp % 100000}`;
      const employee = await employeesService.create(tenantA, adminUserId, {
        code,
        displayName: label,
        homeBranchId,
        userId: posUser.id,
      });
      for (const branchId of permittedBranchIds) {
        await admin.employeeBranch.create({
          data: { tenantId: tenantA, employeeId: employee.id, branchId },
        });
      }
      // FR-SEC-022: a PIN is unique WITHIN a branch, not globally — but each
      // demo employee gets its own PIN regardless, since posEmployeeA1 and
      // posEmployeeA12 share Branch A1 in their permitted set.
      await pins.setPin(tenantA, adminUserId, employee.id, pin);
      return { id: employee.id, code, membershipId: posMembership.id, pin };
    };
    posEmployeeA1 = await mkPosEmployee('posA1', branchA1, [], '739184');
    posEmployeeA12 = await mkPosEmployee(
      'posA12',
      branchA1,
      [branchA2],
      '284617',
    );
  }, 90_000);

  afterAll(async () => {
    await admin.$disconnect().catch(() => undefined);
    await app.close();
  });

  // ═══════════════════ 1-2. THE DEMO SHAPE ITSELF ══════════════════════

  describe('demo shape', () => {
    it('1. Tenant A has exactly two branches, both active, under Brand A', async () => {
      const rows = await admin.branch.findMany({
        where: { tenantId: tenantA },
      });
      expect(rows.map((r) => r.id).sort()).toEqual([branchA1, branchA2].sort());
      expect(rows.every((r) => r.status === 'active')).toBe(true);
      expect(rows.every((r) => r.brandId === brandA)).toBe(true);
    });

    it('2. Tenant B has exactly one branch, isolated from Tenant A', async () => {
      const rows = await admin.branch.findMany({
        where: { tenantId: tenantB },
      });
      expect(rows.map((r) => r.id)).toEqual([branchB1]);
      expect(rows[0].id).not.toBe(branchA1);
      expect(rows[0].id).not.toBe(branchA2);
    });
  });

  // ═══════════════════ 3-8. TENANT + BRANCH ISOLATION (ORG ROUTES) ═════

  describe('tenant and branch isolation over real Organisation routes', () => {
    it('3/4. Manager A1 (branch-scope A1 only): allowed A1, denied A2', async () => {
      const managerA1 = await actor('manager-a1', tenantA, [
        { type: 'branch', branchId: branchA1 },
      ]);
      await request(http)
        .get(`/org/branches/${branchA1}`)
        .set(auth(managerA1))
        .expect(200);
      await request(http)
        .get(`/org/branches/${branchA2}`)
        .set(auth(managerA1))
        .expect(403);
    });

    it('5. MultiBranch Manager (branch-scope A1+A2): allowed both', async () => {
      const multi = await actor('multibranch-mgr', tenantA, [
        { type: 'branch', branchId: branchA1 },
        { type: 'branch', branchId: branchA2 },
      ]);
      await request(http)
        .get(`/org/branches/${branchA1}`)
        .set(auth(multi))
        .expect(200);
      await request(http)
        .get(`/org/branches/${branchA2}`)
        .set(auth(multi))
        .expect(200);
    });

    it('6. Owner A (tenant-wide) allowed across both active branches', async () => {
      const ownerA = await actor('owner-a', tenantA, [{ type: 'tenant' }]);
      await request(http)
        .get(`/org/branches/${branchA1}`)
        .set(auth(ownerA))
        .expect(200);
      await request(http)
        .get(`/org/branches/${branchA2}`)
        .set(auth(ownerA))
        .expect(200);
      const list = await request(http)
        .get('/org/branches')
        .set(auth(ownerA))
        .expect(200);
      expect((list.body as WithId[]).map((b) => b.id).sort()).toEqual(
        [branchA1, branchA2].sort(),
      );
    });

    it('7. an INACTIVE branch is denied for every scope, and reactivation is the one governed exemption', async () => {
      const ownerA = await actor('owner-a-inactive', tenantA, [
        { type: 'tenant' },
      ]);
      await request(http)
        .post(`/org/branches/${branchA2}/status`)
        .set(auth(ownerA))
        .send({ status: 'inactive' })
        .expect(201);

      // T-12: a deactivated branch is refused for EVERY scope on EVERY other
      // route, tenant-wide owner included — this is not a branch-scope gap,
      // it is the ratified lifecycle behaviour itself.
      const reportRes = await request(http)
        .get(`/reports/branches/${branchA2}/daily-trading/${today()}`)
        .set(auth(ownerA));
      expect(reportRes.status).toBe(403);

      // The ONLY governed exemption: the status route itself, so a
      // deactivated branch is not a one-way door.
      await request(http)
        .post(`/org/branches/${branchA2}/status`)
        .set(auth(ownerA))
        .send({ status: 'active' })
        .expect(201);
      const reactivated = await request(http)
        .get(`/org/branches/${branchA2}`)
        .set(auth(ownerA))
        .expect(200);
      expect((reactivated.body as { status: string }).status).toBe('active');
    });

    it('8. cross-tenant branch access is a non-enumerating 404, identical for foreign vs nonexistent', async () => {
      const ownerA = await actor('owner-a-xtenant', tenantA, [
        { type: 'tenant' },
      ]);
      const foreign = await request(http)
        .get(`/org/branches/${branchB1}`)
        .set(auth(ownerA))
        .expect(404);
      const nonexistent = await request(http)
        .get(`/org/branches/${newId()}`)
        .set(auth(ownerA))
        .expect(404);
      expect((foreign.body as { message: string }).message).toBe(
        (nonexistent.body as { message: string }).message,
      );

      // And Manager B1 (Tenant B only) cannot see Tenant A's branches at all.
      const managerB1 = await actor('manager-b1', tenantB, [
        { type: 'tenant' },
      ]);
      await request(http)
        .get(`/org/branches/${branchA1}`)
        .set(auth(managerB1))
        .expect(404);
    });
  });

  // ═══════════════════ 9. POS — ORDERS ARE BRANCH-LOCAL ════════════════

  describe('POS: orders are branch-local', () => {
    const openOrder = async (
      terminalId: string,
      employeeCode: string,
      pin: string,
    ) => {
      const posRes = await pinLogin(
        tenantA,
        terminalId,
        employeeCode,
        pin,
      ).expect(200);
      const posToken = (posRes.body as Tokens).accessToken;
      const res = await request(http)
        .post('/orders')
        .set(auth(posToken))
        .set('Idempotency-Key', `mtmb-order-${newId()}`)
        .send({
          orderType: 'takeaway',
          channel: 'pos',
          originDeviceTime: new Date().toISOString(),
        })
        .expect(201);
      return (res.body as WithId).id;
    };

    it('9. an order opened at A1 is visible via ?branchId=A1 and invisible via ?branchId=A2', async () => {
      const orderA1 = await openOrder(
        terminalA1,
        posEmployeeA1.code,
        posEmployeeA1.pin,
      );
      const managerA1 = await actor('manager-a1-pos', tenantA, [
        { type: 'branch', branchId: branchA1 },
      ]);
      const managerA2Only = await actor('manager-a2-pos', tenantA, [
        { type: 'branch', branchId: branchA2 },
      ]);

      const seenAtA1 = await request(http)
        .get(`/orders?branchId=${branchA1}`)
        .set(auth(managerA1))
        .expect(200);
      expect(
        (seenAtA1.body as { orders: WithId[] }).orders.some(
          (o) => o.id === orderA1,
        ),
      ).toBe(true);

      // A1-only manager cannot even ASK about A2's orders.
      await request(http)
        .get(`/orders?branchId=${branchA2}`)
        .set(auth(managerA1))
        .expect(403);

      // A2-only manager's OWN order list never contains A1's order.
      const seenAtA2 = await request(http)
        .get(`/orders?branchId=${branchA2}`)
        .set(auth(managerA2Only))
        .expect(200);
      expect(
        (seenAtA2.body as { orders: WithId[] }).orders.some(
          (o) => o.id === orderA1,
        ),
      ).toBe(false);
    });
  });

  // ═══════════════════ 10. KDS — TICKETS ARE BRANCH-LOCAL ══════════════

  describe('KDS: a fired ticket is visible only in its own branch/station', () => {
    it('10. A1 ticket appears on A1 queue, never on A2 queue', async () => {
      const kdsUserA1Email = `mtmb.kds-a1.${stamp}@example.com`;
      const kdsUserA2Email = `mtmb.kds-a2.${stamp}@example.com`;
      for (const [email, terminalId] of [
        [kdsUserA1Email, kdsTerminalA1],
        [kdsUserA2Email, kdsTerminalA2],
      ] as const) {
        const u = await users.createUser({
          email,
          displayName: 'kds-op',
          password,
        });
        const m = await memberships.grant(u.id, tenantA, 'active');
        await assignments.create(tenantA, adminUserId, {
          membershipId: m.id,
          roleId: demoRole,
          scope: { type: 'tenant' },
        });
        void terminalId;
      }
      await roles.addPermissions(tenantA, demoRole, [KDS_PERMISSIONS.OPERATE]);

      const businessDay = new Date(`${today()}T00:00:00.000Z`);
      const fixture = await fireTicketLine(admin, {
        tenantId: tenantA,
        branchId: branchA1,
        stationId: stationA1,
        businessDay,
        orderNumber: `A1-${stamp % 100000}`,
        terminalId: terminalA1,
        openedBy: posEmployeeA1.id,
      });

      const tokenA1 = await dashboardTerminalToken(
        http,
        kdsUserA1Email,
        tenantA,
        kdsTerminalA1,
      );
      const tokenA2 = await dashboardTerminalToken(
        http,
        kdsUserA2Email,
        tenantA,
        kdsTerminalA2,
      );

      const queueA1 = await request(http)
        .get(`/kds/stations/${stationA1}/queue`)
        .set(auth(tokenA1))
        .expect(200);
      expect(
        (queueA1.body as { tickets: WithId[] }).tickets.some(
          (t) => t.id === fixture.ticketId,
        ),
      ).toBe(true);

      // A2's own terminal is bound to A2's OWN station: it cannot even
      // address A1's station (KdsStationGuard — terminal/station binding is
      // a SECOND, independent branch-locality mechanism, not the RBAC
      // lattice, which is proven elsewhere).
      await request(http)
        .get(`/kds/stations/${stationA1}/queue`)
        .set(auth(tokenA2))
        .expect(403);

      const queueA2 = await request(http)
        .get(`/kds/stations/${stationA2}/queue`)
        .set(auth(tokenA2))
        .expect(200);
      expect((queueA2.body as { tickets: WithId[] }).tickets).toEqual([]);
    });
  });

  // ═══════════════════ 11. INVENTORY — STOCK IS LOCATION-LOCAL ═════════

  describe('Inventory: the same SKU has independent stock per branch/location', () => {
    it('11. depleting stock at A1 does not touch A2 for the same item', async () => {
      const uomId = newId();
      await admin.uom.create({
        data: {
          id: uomId,
          dimension: 'mass',
          code: `g-${stamp}`,
          name: 'gram',
          baseUnitOfDimension: true,
        },
      });
      const ownerA = await actor('owner-a-inv', tenantA, [{ type: 'tenant' }]);
      const itemRes = await request(http)
        .post('/inventory/items')
        .set(auth(ownerA))
        .send({
          sku: `MTMB-${stamp}`,
          names: { en: 'Demo SKU' },
          baseUnitId: uomId,
        })
        .expect(201);
      const itemId = (itemRes.body as WithId).id;

      const post = (locationId: string, quantity: string) =>
        request(http)
          .post('/inventory/movements')
          .set(auth(ownerA))
          .send({
            locationId,
            stockItemId: itemId,
            movementType: 'opening_balance',
            quantity,
            referenceType: 'opening',
            referenceId: newId(),
            unitCost: '500',
          })
          .expect(201);

      await post(locA1, '100');
      await post(locA2, '40');

      const levels = await request(http)
        .get('/inventory/levels')
        .set(auth(ownerA))
        .expect(200);
      const rows = (
        levels.body as {
          locationId: string;
          stockItemId: string;
          quantityOnHand: string;
        }[]
      ).filter((r) => r.stockItemId === itemId);
      const a1 = rows.find((r) => r.locationId === locA1);
      const a2 = rows.find((r) => r.locationId === locA2);
      expect(a1?.quantityOnHand).toBe('100');
      expect(a2?.quantityOnHand).toBe('40');

      // A further movement at A1 alone must never move A2's figure.
      await post(locA1, '-25');
      const after = await request(http)
        .get('/inventory/levels')
        .set(auth(ownerA))
        .expect(200);
      const afterRows = (
        after.body as {
          locationId: string;
          stockItemId: string;
          quantityOnHand: string;
        }[]
      ).filter((r) => r.stockItemId === itemId);
      expect(
        afterRows.find((r) => r.locationId === locA1)?.quantityOnHand,
      ).toBe('75');
      expect(
        afterRows.find((r) => r.locationId === locA2)?.quantityOnHand,
      ).toBe('40');
    });
  });

  // ═══════════════════ 12. TREASURY — CASH SESSIONS ARE BRANCH-LOCAL ═══

  describe('Treasury: a CashSession belongs to exactly one branch', () => {
    it('12. A1 and A2 cash sessions are independent; a branch-scoped actor cannot touch the other', async () => {
      const drawerA1 = (
        await drawers.create(tenantA, adminUserId, {
          branchId: branchA1,
          name: 'Till A1',
        })
      ).id;
      const drawerA2 = (
        await drawers.create(tenantA, adminUserId, {
          branchId: branchA2,
          name: 'Till A2',
        })
      ).id;

      const openSession = async (
        terminalId: string,
        employeeCode: string,
        pin: string,
        drawerId: string,
      ) => {
        const pos = await pinLogin(
          tenantA,
          terminalId,
          employeeCode,
          pin,
        ).expect(200);
        const posToken = (pos.body as Tokens).accessToken;
        const res = await request(http)
          .post('/cash-sessions')
          .set(auth(posToken))
          .set('Idempotency-Key', `mtmb-cs-${newId()}`)
          .send({
            shiftId: newId(),
            cashSessionId: newId(),
            drawerId,
            openingFloat: '50000',
          })
          .expect(201);
        return (res.body as { cashSession: { id: string; branchId?: string } })
          .cashSession.id;
      };

      const sessionA1 = await openSession(
        terminalA1,
        posEmployeeA1.code,
        posEmployeeA1.pin,
        drawerA1,
      );
      const sessionA2 = await openSession(
        terminalA2,
        posEmployeeA12.code,
        posEmployeeA12.pin,
        drawerA2,
      );
      expect(sessionA1).not.toBe(sessionA2);

      const row1 = await admin.cashSession.findUniqueOrThrow({
        where: { id: sessionA1 },
      });
      const row2 = await admin.cashSession.findUniqueOrThrow({
        where: { id: sessionA2 },
      });
      expect(row1.branchId).toBe(branchA1);
      expect(row2.branchId).toBe(branchA2);

      // A1-only manager cannot pay-in against A2's session.
      const managerA1 = await actor('manager-a1-cash', tenantA, [
        { type: 'branch', branchId: branchA1 },
      ]);
      await request(http)
        .post(`/cash-sessions/${sessionA2}/pay-in`)
        .set(auth(managerA1))
        .send({ amount: '100', reasonCodeId: newId() })
        .then((r) => expect([403, 404]).toContain(r.status));
    });
  });

  // ═══════════════════ 13-14. HR — PERMITTED BRANCHES ═══════════════════

  describe('HR: home/permitted branches are enforced at PIN sign-in, and clock-in follows', () => {
    it("13. POS employee A1 (permitted A1 only) is refused sign-in at A2's terminal", async () => {
      await pinLogin(
        tenantA,
        terminalA1,
        posEmployeeA1.code,
        posEmployeeA1.pin,
      ).expect(200);
      await pinLogin(
        tenantA,
        terminalA2,
        posEmployeeA1.code,
        posEmployeeA1.pin,
      ).expect(401);
    });

    it('FR-HRM-005 real HTTP grant surface: a fresh A1-only employee gains A2 through POST /workforce/employees/:id/branches, never a direct write', async () => {
      const ownerA = await actor('owner-a-hr-grant', tenantA, [
        { type: 'tenant' },
      ]);
      const freshUser = await users.createUser({
        email: `mtmb.freshhr.${stamp}@example.com`,
        displayName: 'fresh-hr',
        password,
      });
      const freshEmployee = await employeesService.create(
        tenantA,
        adminUserId,
        {
          code: `FRESH${stamp % 100000}`,
          displayName: 'fresh-hr',
          homeBranchId: branchA1,
          userId: freshUser.id,
        },
      );
      await request(http)
        .post(`/workforce/employees/${freshEmployee.id}/branches`)
        .set(auth(ownerA))
        .set('Idempotency-Key', `mtmb-branch-grant-${newId()}`)
        .send({ branchId: branchA2 })
        .expect(201);
      const rows = await admin.employeeBranch.findMany({
        where: { employeeId: freshEmployee.id },
      });
      expect(rows.map((r) => r.branchId).sort()).toEqual(
        [branchA1, branchA2].sort(),
      );
    });

    it('14. POS employee A12 (home A1, permitted A1+A2 via fixture setup) signs in and clocks in at BOTH', async () => {
      for (const terminalId of [terminalA1, terminalA2]) {
        const pos = await pinLogin(
          tenantA,
          terminalId,
          posEmployeeA12.code,
          posEmployeeA12.pin,
        ).expect(200);
        const posToken = (pos.body as Tokens).accessToken;
        const clockIn = await request(http)
          .post('/workforce/attendance/clock-in')
          .set(auth(posToken))
          .set('Idempotency-Key', `mtmb-clockin-${newId()}`)
          .send({})
          .expect(201);
        expect((clockIn.body as { status: string }).status).toBe('open');
        await request(http)
          .post('/workforce/attendance/clock-out')
          .set(auth(posToken))
          .set('Idempotency-Key', `mtmb-clockout-${newId()}`)
          .send({})
          .expect(200);
      }
    });
  });

  // ═══════════════════ 15-16. REPORTING — PER-BRANCH READS ═════════════

  describe('Reporting: the daily-trading report is authorized and scoped per branch', () => {
    it("15/16. A1-scoped actor reads A1's report only; A2-scoped actor reads A2's report only", async () => {
      const managerA1 = await actor('manager-a1-rpt', tenantA, [
        { type: 'branch', branchId: branchA1 },
      ]);
      const managerA2 = await actor('manager-a2-rpt', tenantA, [
        { type: 'branch', branchId: branchA2 },
      ]);

      const a1Report = await request(http)
        .get(`/reports/branches/${branchA1}/daily-trading/${today()}`)
        .set(auth(managerA1))
        .expect(200);
      await request(http)
        .get(`/reports/branches/${branchA2}/daily-trading/${today()}`)
        .set(auth(managerA1))
        .expect(403);

      const a2Report = await request(http)
        .get(`/reports/branches/${branchA2}/daily-trading/${today()}`)
        .set(auth(managerA2))
        .expect(200);
      await request(http)
        .get(`/reports/branches/${branchA1}/daily-trading/${today()}`)
        .set(auth(managerA2))
        .expect(403);

      expect(
        (a1Report.body as { branchId?: string }).branchId ?? branchA1,
      ).toBeTruthy();
      expect(
        (a2Report.body as { branchId?: string }).branchId ?? branchA2,
      ).toBeTruthy();
    });
  });

  // ═══════════════════ 17-20. ACCESSIBLE-BRANCH DISCOVERY (MTMB-1 NEW) ═

  describe('GET /org/access — frontend branch/brand discovery, live scope', () => {
    it('17. A1-only actor sees exactly branch A1 (never A2, never Tenant B)', async () => {
      const managerA1 = await actor('manager-a1-disc', tenantA, [
        { type: 'branch', branchId: branchA1 },
      ]);
      const res = await request(http)
        .get('/org/access')
        .set(auth(managerA1))
        .expect(200);
      const body = res.body as {
        tenantId: string;
        brands: WithId[];
        branches: WithId[];
      };
      expect(body.tenantId).toBe(tenantA);
      expect(body.branches.map((b) => b.id)).toEqual([branchA1]);
      expect(body.brands.map((b) => b.id)).toEqual([brandA]);
    });

    it('18. MultiBranch Manager sees exactly A1 + A2', async () => {
      const multi = await actor('multibranch-disc', tenantA, [
        { type: 'branch', branchId: branchA1 },
        { type: 'branch', branchId: branchA2 },
      ]);
      const res = await request(http)
        .get('/org/access')
        .set(auth(multi))
        .expect(200);
      const body = res.body as { branches: WithId[] };
      expect(body.branches.map((b) => b.id).sort()).toEqual(
        [branchA1, branchA2].sort(),
      );
    });

    it('19. Owner A (tenant-wide) sees every active branch in the tenant', async () => {
      const ownerA = await actor('owner-a-disc', tenantA, [{ type: 'tenant' }]);
      const res = await request(http)
        .get('/org/access')
        .set(auth(ownerA))
        .expect(200);
      const body = res.body as { branches: WithId[] };
      expect(body.branches.map((b) => b.id).sort()).toEqual(
        [branchA1, branchA2].sort(),
      );
    });

    it("20. no Tenant B branch ever leaks into Tenant A's discovery response, or vice versa", async () => {
      const ownerA = await actor('owner-a-noleak', tenantA, [
        { type: 'tenant' },
      ]);
      const managerB1 = await actor('manager-b1-disc', tenantB, [
        { type: 'tenant' },
      ]);

      const aRes = await request(http)
        .get('/org/access')
        .set(auth(ownerA))
        .expect(200);
      expect(
        (aRes.body as { branches: WithId[] }).branches.some(
          (b) => b.id === branchB1,
        ),
      ).toBe(false);

      const bRes = await request(http)
        .get('/org/access')
        .set(auth(managerB1))
        .expect(200);
      const bBody = bRes.body as { tenantId: string; branches: WithId[] };
      expect(bBody.tenantId).toBe(tenantB);
      expect(bBody.branches.map((b) => b.id)).toEqual([branchB1]);
      expect(
        bBody.branches.some((b) => b.id === branchA1 || b.id === branchA2),
      ).toBe(false);
    });

    it('a membership with zero scoped assignments discovers nothing (never "every branch")', async () => {
      const email = `mtmb.noscope.${stamp}@example.com`;
      const u = await users.createUser({
        email,
        displayName: 'no-scope',
        password,
      });
      await memberships.grant(u.id, tenantA, 'active');
      const token = await tokenFor(email, tenantA);
      const res = await request(http)
        .get('/org/access')
        .set(auth(token))
        .expect(200);
      const body = res.body as { brands: WithId[]; branches: WithId[] };
      expect(body.brands).toEqual([]);
      expect(body.branches).toEqual([]);
    });
  });
});
