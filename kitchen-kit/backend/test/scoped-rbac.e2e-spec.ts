import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { AccessTokenService } from './../src/modules/identity/auth/access-token.service';
import type { AccessTokenPayload } from './../src/modules/identity/auth/auth.types';
import { AuthorizationSnapshotService } from './../src/modules/identity/authz/authorization-snapshot.service';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import {
  IDENTITY_PERMISSIONS,
  IDENTITY_PERMISSION_DEFS,
} from './../src/modules/identity/authz/permissions.constants';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { ScopeAuthorizationService } from './../src/modules/identity/authz/scope-authorization.service';
import type { TargetScope } from './../src/modules/identity/authz/scope';
import { TenantContextService } from './../src/modules/identity/context/tenant-context.service';
import type { RequestAuthorization } from './../src/modules/identity/context/tenant-context';
import { EmployeesService } from './../src/modules/identity/employees/employees.service';
import { PinService } from './../src/modules/identity/employees/pin.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { TerminalsService } from './../src/modules/identity/terminals/terminals.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { BranchesService } from './../src/modules/organisation/branches/branches.service';
import { BrandsService } from './../src/modules/organisation/brands/brands.service';
import { createMigratorClient } from './rls-admin';

/**
 * B1-2 — SCOPED RBAC FOUNDATION (FR-SEC-002/003/004/005, FR-API-012).
 *
 * Authority: "AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC"
 * (RATIFIED 2026-09-02) and `docs/adr/0009-scoped-rbac.md`.
 *
 * Everything here runs against a REAL PostgreSQL through the RLS-constrained
 * `ros_app` role, exactly as production does. Where a test needs to construct a
 * state the API deliberately refuses to create (a stale token, a pathological
 * assignment set), it arranges through the migrator client and then exercises
 * the behaviour through the ordinary runtime path.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();
const BIZ = 'sales.order.read';

interface Tokens {
  accessToken: string;
}
interface EffectiveScope {
  permissions: string[];
  scopes: {
    assignmentId: string;
    scopeType: string;
    brandId: string | null;
    branchId: string | null;
    permissions: string[];
  }[];
  permittedBranches: {
    v: number;
    all: boolean;
    brands: string[];
    branches: string[];
  };
  authorizationEpoch: number;
  scopeReviewRequired: boolean;
}

describe('Scoped RBAC — B1-2 (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let tokens: AccessTokenService;
  let tenantContext: TenantContextService;
  let scopeAuthz: ScopeAuthorizationService;
  let snapshots: AuthorizationSnapshotService;
  let assignments: MembershipRolesService;

  // Tenant A: brand X owns branches X1 and X2; brand Y owns branch Y1.
  let tenantA: string;
  let tenantB: string;
  let brandX: string;
  let brandY: string;
  let branchX1: string;
  let branchX2: string;
  let branchY1: string;
  let branchB: string;

  let adminUserId: string;
  let mAdmin: string;
  let roleAdmin: string;
  let roleBiz: string;

  // One user per scope shape, so a leak shows up as a specific test failing.
  let uTenantId: string;
  let mTenant: string;
  let uBrandId: string;
  let mBrand: string;
  let uBranchId: string;
  let mBranch: string;

  const login = async (email: string): Promise<string> => {
    const res = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as Tokens).accessToken;
  };

  const selectTenant = async (
    email: string,
    tenantId: string,
  ): Promise<string> => {
    const bearer = await login(email);
    const res = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ tenantId })
      .expect(200);
    return (res.body as Tokens).accessToken;
  };

  /** Resolve the REAL server-side authorization for a live token. */
  const authorizationOf = async (
    token: string,
  ): Promise<RequestAuthorization> => {
    const payload = await tokens.verify(token);
    return tenantContext.resolve({
      userId: payload.sub,
      sessionId: payload.sid,
      ...(payload.tid ? { tenantId: payload.tid } : {}),
      ...(payload.mid ? { membershipId: payload.mid } : {}),
      ...(payload.epo !== undefined ? { authzEpoch: payload.epo } : {}),
    });
  };

  const may = async (
    token: string,
    target: TargetScope,
    code = BIZ,
  ): Promise<boolean> => {
    const auth = await authorizationOf(token);
    return scopeAuthz.isAuthorized(auth, { codes: [code], mode: 'all' }, target);
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer() as App;
    admin = createMigratorClient(app);

    tokens = app.get(AccessTokenService);
    tenantContext = app.get(TenantContextService);
    scopeAuthz = app.get(ScopeAuthorizationService);
    snapshots = app.get(AuthorizationSnapshotService);
    assignments = app.get(MembershipRolesService);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const permissions = app.get(PermissionsService);
    const brands = app.get(BrandsService);
    const branches = app.get(BranchesService);

    // Register the modules' OWN declared codes on a from-zero database. No code
    // is invented here — Appendix C is absent, and the catalogue is never
    // extended by a test (amendment clause 20).
    await permissions.upsertMany(IDENTITY_PERMISSION_DEFS);
    await permissions.upsertMany([
      { code: BIZ, description: 'read orders', module: 'sales' },
    ]);

    tenantA = (
      await tenants.create({
        slug: `srbac-a-${stamp}`,
        legalName: 'Scoped A',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `srbac-b-${stamp}`,
        legalName: 'Scoped B',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const mk = async (label: string) =>
      (
        await users.createUser({
          email: `srbac.${label}.${stamp}@example.com`,
          displayName: label,
          password,
        })
      ).id;

    adminUserId = await mk('admin');
    uTenantId = await mk('tenantscope');
    uBrandId = await mk('brandscope');
    uBranchId = await mk('branchscope');

    mAdmin = (await memberships.grant(adminUserId, tenantA)).id;
    mTenant = (await memberships.grant(uTenantId, tenantA)).id;
    mBrand = (await memberships.grant(uBrandId, tenantA)).id;
    mBranch = (await memberships.grant(uBranchId, tenantA)).id;

    roleAdmin = (await roles.createTenantRole(tenantA, { name: 'srbac_admin' }))
      .id;
    // Only the codes this suite actually exercises over HTTP. Brands and
    // branches are arranged through their services directly, so no Organisation
    // permission is needed and none is invented here (Appendix C is absent —
    // the catalogue is never extended by a test).
    await roles.addPermissions(tenantA, roleAdmin, [
      IDENTITY_PERMISSIONS.ROLE_ASSIGN,
      IDENTITY_PERMISSIONS.ROLE_READ,
      BIZ,
    ]);
    roleBiz = (await roles.createTenantRole(tenantA, { name: 'srbac_biz' })).id;
    await roles.addPermissions(tenantA, roleBiz, [
      BIZ,
      IDENTITY_PERMISSIONS.ROLE_READ,
    ]);

    // The admin is tenant-scoped, which is what lets it use the (still
    // target-less) RBAC administration routes under the transitional rule.
    await assignments.create(tenantA, adminUserId, {
      membershipId: mAdmin,
      roleId: roleAdmin,
      scope: { type: 'tenant' },
    });

    brandX = (await brands.create(tenantA, adminUserId, { name: 'Brand X' })).id;
    brandY = (await brands.create(tenantA, adminUserId, { name: 'Brand Y' })).id;
    const mkBranch = async (brandId: string, code: string) =>
      (
        await branches.create(tenantA, adminUserId, {
          brandId,
          code,
          name: code,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        })
      ).id;
    branchX1 = await mkBranch(brandX, `X1${stamp % 1000}`);
    branchX2 = await mkBranch(brandX, `X2${stamp % 1000}`);
    branchY1 = await mkBranch(brandY, `Y1${stamp % 1000}`);

    const brandBId = (
      await brands.create(tenantB, adminUserId, { name: 'Brand B' })
    ).id;
    branchB = (
      await branches.create(tenantB, adminUserId, {
        brandId: brandBId,
        code: `B1${stamp % 1000}`,
        name: 'B1',
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      })
    ).id;

    await assignments.create(tenantA, adminUserId, {
      membershipId: mTenant,
      roleId: roleBiz,
      scope: { type: 'tenant' },
    });
    await assignments.create(tenantA, adminUserId, {
      membershipId: mBrand,
      roleId: roleBiz,
      scope: { type: 'brand', brandId: brandX },
    });
    await assignments.create(tenantA, adminUserId, {
      membershipId: mBranch,
      roleId: roleBiz,
      scope: { type: 'branch', branchId: branchX1 },
    });
  });

  afterAll(async () => {
    await admin.$disconnect().catch(() => undefined);
    await app.close();
  });

  // ══════════════════════════ A. SCOPE MODEL ═══════════════════════════════
  describe('A. the target-scope lattice, end to end against PostgreSQL', () => {
    it('TENANT assignment covers tenant, brand and branch targets', async () => {
      const t = await selectTenant(
        `srbac.tenantscope.${stamp}@example.com`,
        tenantA,
      );
      expect(await may(t, { type: 'tenant' })).toBe(true);
      expect(await may(t, { type: 'brand', brandId: brandX })).toBe(true);
      expect(await may(t, { type: 'brand', brandId: brandY })).toBe(true);
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(true);
      expect(await may(t, { type: 'branch', branchId: branchY1 })).toBe(true);
    });

    it('BRAND X covers brand X and its child branches, and nothing above or beside', async () => {
      const t = await selectTenant(
        `srbac.brandscope.${stamp}@example.com`,
        tenantA,
      );
      expect(await may(t, { type: 'brand', brandId: brandX })).toBe(true);
      // Parent brand resolved live from Organisation's published contract.
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(true);
      expect(await may(t, { type: 'branch', branchId: branchX2 })).toBe(true);

      expect(await may(t, { type: 'tenant' })).toBe(false);
      expect(await may(t, { type: 'brand', brandId: brandY })).toBe(false);
      expect(await may(t, { type: 'branch', branchId: branchY1 })).toBe(false);
    });

    it('BRANCH X1 covers X1 only — not the tenant, not its own brand, not a sibling branch', async () => {
      const t = await selectTenant(
        `srbac.branchscope.${stamp}@example.com`,
        tenantA,
      );
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(true);

      expect(await may(t, { type: 'tenant' })).toBe(false);
      expect(await may(t, { type: 'brand', brandId: brandX })).toBe(false);
      expect(await may(t, { type: 'branch', branchId: branchX2 })).toBe(false);
      expect(await may(t, { type: 'branch', branchId: branchY1 })).toBe(false);
    });
  });

  // ═════════════════════ B. FR-SEC-003 WORKED EXAMPLE ══════════════════════
  describe('B. FR-SEC-003 — several assignments at different scopes', () => {
    it('represents the same role at two different branches simultaneously', async () => {
      const uId = (
        await app.get(UsersService).createUser({
          email: `srbac.multi.${stamp}@example.com`,
          displayName: 'multi',
          password,
        })
      ).id;
      const m = (await app.get(MembershipsService).grant(uId, tenantA)).id;

      // The exact shape the pre-B1-2 primary key made unrepresentable.
      await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX1 },
      });
      await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchY1 },
      });

      const t = await selectTenant(`srbac.multi.${stamp}@example.com`, tenantA);
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(true);
      expect(await may(t, { type: 'branch', branchId: branchY1 })).toBe(true);
      expect(await may(t, { type: 'branch', branchId: branchX2 })).toBe(false);
      expect(await may(t, { type: 'tenant' })).toBe(false);
    });

    it('does NOT leak permissions across scopes (FR-SEC-004)', async () => {
      // "Branch Manager at Branch 1 and Cashier at Branch 2": each role's
      // permissions apply ONLY where that assignment's scope reaches.
      const roles = app.get(RolesService);
      const permissions = app.get(PermissionsService);
      await permissions.upsertMany([
        { code: 'sales.order.void', description: 'void', module: 'sales' },
        { code: 'sales.order.create', description: 'create', module: 'sales' },
      ]);
      const managerRole = (
        await roles.createTenantRole(tenantA, { name: `mgr_${stamp}` })
      ).id;
      await roles.addPermissions(tenantA, managerRole, ['sales.order.void']);
      const cashierRole = (
        await roles.createTenantRole(tenantA, { name: `csh_${stamp}` })
      ).id;
      await roles.addPermissions(tenantA, cashierRole, ['sales.order.create']);

      const uId = (
        await app.get(UsersService).createUser({
          email: `srbac.leak.${stamp}@example.com`,
          displayName: 'leak',
          password,
        })
      ).id;
      const m = (await app.get(MembershipsService).grant(uId, tenantA)).id;
      await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: managerRole,
        scope: { type: 'branch', branchId: branchX1 },
      });
      await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: cashierRole,
        scope: { type: 'branch', branchId: branchX2 },
      });

      const t = await selectTenant(`srbac.leak.${stamp}@example.com`, tenantA);
      const at = (target: TargetScope, code: string) => may(t, target, code);

      expect(await at({ type: 'branch', branchId: branchX1 }, 'sales.order.void')).toBe(true);
      expect(await at({ type: 'branch', branchId: branchX2 }, 'sales.order.void')).toBe(false);
      expect(await at({ type: 'branch', branchId: branchX2 }, 'sales.order.create')).toBe(true);
      expect(await at({ type: 'branch', branchId: branchX1 }, 'sales.order.create')).toBe(false);
    });
  });

  // ═══════════════════════ C. TRANSITION SAFETY ════════════════════════════
  describe('C. the B1-2 -> B1-3 transition is fail-closed', () => {
    // `GET /auth/roles` carries @RequirePermission and NO target scope, so it is
    // a TENANT-target operation under the ratified transitional rule.
    const rolesRoute = (token: string) =>
      request(http).get('/auth/roles').set('Authorization', `Bearer ${token}`);

    it('a TENANT assignment preserves legacy permission-only behaviour', async () => {
      const t = await selectTenant(
        `srbac.tenantscope.${stamp}@example.com`,
        tenantA,
      );
      await rolesRoute(t).expect(200);
    });

    it('a BRANCH-only assignment cannot satisfy the old permission-only guard', async () => {
      const t = await selectTenant(
        `srbac.branchscope.${stamp}@example.com`,
        tenantA,
      );
      await rolesRoute(t).expect(403);
    });

    it('a BRAND-only assignment cannot satisfy the old permission-only guard', async () => {
      const t = await selectTenant(
        `srbac.brandscope.${stamp}@example.com`,
        tenantA,
      );
      await rolesRoute(t).expect(403);
    });

    it('narrow grants are absent from the flat permission set but present, scope-qualified, in `scopes`', async () => {
      const t = await selectTenant(
        `srbac.branchscope.${stamp}@example.com`,
        tenantA,
      );
      const body = (
        await request(http)
          .get('/auth/permissions')
          .set('Authorization', `Bearer ${t}`)
          .expect(200)
      ).body as EffectiveScope;

      expect(body.permissions).not.toContain(BIZ);
      expect(body.scopes).toHaveLength(1);
      expect(body.scopes[0]).toMatchObject({
        scopeType: 'branch',
        branchId: branchX1,
      });
      expect(body.scopes[0].permissions).toContain(BIZ);
    });
  });

  // ═════════════════════════ D. EFFECTIVE DATES ════════════════════════════
  describe('D. FR-SEC-005 effective dating, on the database clock', () => {
    let email: string;
    let membershipId: string;

    beforeAll(async () => {
      email = `srbac.dated.${stamp}@example.com`;
      const uId = (
        await app.get(UsersService).createUser({
          email,
          displayName: 'dated',
          password,
        })
      ).id;
      membershipId = (
        await app.get(MembershipsService).grant(uId, tenantA)
      ).id;
    });

    it('a future validFrom grants nothing yet', async () => {
      const created = await assignments.create(tenantA, adminUserId, {
        membershipId,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX1 },
        validFrom: new Date(Date.now() + 60 * 60 * 1000),
      });
      const t = await selectTenant(email, tenantA);
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(false);
      await assignments.remove(tenantA, adminUserId, created.id);
    });

    it('a current assignment grants, and an expired one stops granting with no sweep job', async () => {
      // Backdated so the window can later be CLOSED in the past without
      // violating `ck_membership_role_validity_window` (valid_to > valid_from).
      const created = await assignments.create(tenantA, adminUserId, {
        membershipId,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX1 },
        validFrom: new Date(Date.now() - 60 * 60 * 1000),
      });
      let t = await selectTenant(email, tenantA);
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(true);

      // Expire it using the DATABASE's own clock, so the assertion cannot pass
      // merely because the Node process clock happens to agree.
      await admin.$executeRaw`
        UPDATE identity.membership_roles
           SET valid_to = now() - interval '1 second'
         WHERE id = ${created.id}::uuid`;

      // No sweep, no cache invalidation, no re-login beyond the epoch refresh:
      // the very next resolution simply does not see the assignment.
      t = await selectTenant(email, tenantA);
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(false);
    });

    it('rejects a validity window that ends before it begins', async () => {
      const now = new Date();
      await expect(
        assignments.create(tenantA, adminUserId, {
          membershipId,
          roleId: roleBiz,
          scope: { type: 'branch', branchId: branchX2 },
          validFrom: now,
          validTo: new Date(now.getTime() - 1000),
        }),
      ).rejects.toThrow();
    });
  });

  // ══════════════════════════ E. T-4-LIVE ══════════════════════════════════
  describe('E. T-4-LIVE — the token carries a snapshot, the database decides', () => {
    it('mints subject, tenant, scope set, permitted branch set and epoch', async () => {
      const t = await selectTenant(
        `srbac.brandscope.${stamp}@example.com`,
        tenantA,
      );
      const p: AccessTokenPayload = await tokens.verify(t);
      expect(p.sub).toBe(uBrandId);
      expect(p.tid).toBe(tenantA);
      expect(p.scp).toEqual([`brand:${brandX}`]);
      expect(p.pbr).toEqual({
        v: 1,
        all: false,
        brands: [brandX],
        branches: [],
      });
      expect(typeof p.epo).toBe('number');
    });

    it('represents a tenant-wide actor SYMBOLICALLY — branch count never drives token size', async () => {
      const t = await selectTenant(
        `srbac.tenantscope.${stamp}@example.com`,
        tenantA,
      );
      const p: AccessTokenPayload = await tokens.verify(t);
      // Tenant A has three branches; the snapshot is still one symbol.
      expect(p.pbr).toEqual({ v: 1, all: true, brands: [], branches: [] });
      expect(p.scp).toEqual(['tenant']);
    });

    it('claims alone never authorize: a validly signed token whose grant was removed is denied', async () => {
      const email = `srbac.revoked.${stamp}@example.com`;
      const uId = (
        await app
          .get(UsersService)
          .createUser({ email, displayName: 'revoked', password })
      ).id;
      const m = (await app.get(MembershipsService).grant(uId, tenantA)).id;
      const created = await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX1 },
      });

      const token = await selectTenant(email, tenantA);
      const minted: AccessTokenPayload = await tokens.verify(token);
      expect(minted.pbr?.branches).toEqual([branchX1]);
      expect(await may(token, { type: 'branch', branchId: branchX1 })).toBe(
        true,
      );

      // Revoke the live grant. The token is untouched and still validly signed,
      // and its snapshot still claims Branch X1.
      await assignments.remove(tenantA, adminUserId, created.id);

      const stillClaims: AccessTokenPayload = await tokens.verify(token);
      expect(stillClaims.pbr?.branches).toEqual([branchX1]);

      // The next protected request fails closed on the stale epoch.
      await request(http)
        .get('/auth/permissions')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('an overbroad but validly signed stale snapshot cannot override the database', async () => {
      const email = `srbac.forged.${stamp}@example.com`;
      const uId = (
        await app
          .get(UsersService)
          .createUser({ email, displayName: 'forged', password })
      ).id;
      const m = (await app.get(MembershipsService).grant(uId, tenantA)).id;
      const created = await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX1 },
      });
      const live = await admin.membership.findUniqueOrThrow({
        where: { id: m },
        select: { authzEpoch: true },
      });

      // A token the SERVER ITSELF signs, carrying a tenant-wide snapshot the
      // holder does not have. Signature valid; claims a lie.
      const forged = await tokens.sign({
        sub: uId,
        sid: newId(),
        tid: tenantA,
        mid: m,
        scp: ['tenant'],
        pbr: { v: 1, all: true, brands: [], branches: [] },
        epo: live.authzEpoch,
      });

      const auth = await authorizationOf(forged);
      // Live resolution ignored the claim entirely: one branch grant, no more.
      expect(auth.grants).toHaveLength(1);
      expect(auth.grants[0].scope).toEqual({
        type: 'branch',
        branchId: branchX1,
      });
      expect(
        await scopeAuthz.isAuthorized(
          auth,
          { codes: [BIZ], mode: 'all' },
          { type: 'tenant' },
        ),
      ).toBe(false);
      expect(
        await scopeAuthz.isAuthorized(
          auth,
          { codes: [BIZ], mode: 'all' },
          { type: 'branch', branchId: branchX2 },
        ),
      ).toBe(false);

      await assignments.remove(tenantA, adminUserId, created.id);
    });

    it('a tenant-bound token with NO epoch (pre-B1-2 shape) is refused as stale', async () => {
      const noEpoch = await tokens.sign({
        sub: uTenantId,
        sid: newId(),
        tid: tenantA,
        mid: mTenant,
      });
      await request(http)
        .get('/auth/permissions')
        .set('Authorization', `Bearer ${noEpoch}`)
        .expect(403);
    });

    it('overflow fails closed deterministically — no silent truncation', async () => {
      // A pathological actor: more explicit branch scopes than the token budget
      // can carry. Arranged through the migrator client because the point is
      // the SNAPSHOT's behaviour, not how the rows got there.
      const email = `srbac.overflow.${stamp}@example.com`;
      const uId = (
        await app
          .get(UsersService)
          .createUser({ email, displayName: 'overflow', password })
      ).id;
      const m = (await app.get(MembershipsService).grant(uId, tenantB)).id;
      const role = await admin.role.create({
        data: {
          id: newId(),
          tenantId: tenantB,
          name: `overflow_${stamp}`,
          isSystem: false,
        },
      });
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId: tenantB, name: `OF ${stamp}` },
      });
      const count = 130; // > MAX_SNAPSHOT_UNITS (128)
      const branchRows = Array.from({ length: count }, (_, i) => ({
        id: newId(),
        tenantId: tenantB,
        brandId: brand.id,
        code: `OF${i}${stamp % 100}`,
        name: `OF ${i}`,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
      }));
      await admin.branch.createMany({ data: branchRows });
      // These branches are created through the migrator client rather than
      // BranchesService (the point of the test is the SNAPSHOT, not branch
      // administration), so the `org.locations` registry rows that
      // `BranchesService.create` would have written must be created too —
      // otherwise this arrange would break the repository-wide invariant that
      // no org location entity exists without a registry row.
      await admin.location.createMany({
        data: branchRows.map((b) => ({
          id: newId(),
          tenantId: tenantB,
          locationType: 'branch' as const,
          refId: b.id,
          branchId: b.id,
        })),
        skipDuplicates: true,
      });
      await admin.membershipRole.createMany({
        data: branchRows.map((b) => ({
          id: newId(),
          tenantId: tenantB,
          membershipId: m,
          roleId: role.id,
          scopeType: 'branch' as const,
          scopeBranchId: b.id,
        })),
      });

      // Fail closed: no token, no partial scope set, an actionable message.
      await expect(snapshots.build(uId, tenantB, m)).rejects.toThrow(
        /too large to represent|No partial scope set/i,
      );
      // And the failure is reached through the ordinary runtime path too.
      const bearer = await login(email);
      await request(http)
        .post('/auth/tenant')
        .set('Authorization', `Bearer ${bearer}`)
        .send({ tenantId: tenantB })
        .expect(403);
    });
  });

  // ═══════════════════════════ F. POS SESSIONS ═════════════════════════════
  describe('F. POS narrowing — EmployeeBranch is AND-only, never a grant', () => {
    const pin = '4417';
    let posEmail: string;
    let employeeCode: string;
    let terminalX1: string;
    let terminalX2: string;
    let employeeId: string;
    let posMembership: string;

    const posLogin = (terminalId: string) =>
      request(http)
        .post('/auth/pin')
        .send({ tenantId: tenantA, terminalId, employeeCode, pin });

    beforeAll(async () => {
      posEmail = `srbac.pos.${stamp}@example.com`;
      employeeCode = `POS${stamp % 100000}`;
      const uId = (
        await app
          .get(UsersService)
          .createUser({ email: posEmail, displayName: 'pos', password })
      ).id;
      posMembership = (await app.get(MembershipsService).grant(uId, tenantA)).id;

      // A TENANT-scoped role. The point of the suite: tenant-wide authority
      // still cannot cross the terminal's branch on a POS session.
      await assignments.create(tenantA, adminUserId, {
        membershipId: posMembership,
        roleId: roleBiz,
        scope: { type: 'tenant' },
      });

      const terminals = app.get(TerminalsService);
      terminalX1 = (
        await terminals.register(tenantA, {
          branchId: branchX1,
          name: `T-X1-${stamp % 1000}`,
          terminalType: 'pos',
        })
      ).id;
      terminalX2 = (
        await terminals.register(tenantA, {
          branchId: branchX2,
          name: `T-X2-${stamp % 1000}`,
          terminalType: 'pos',
        })
      ).id;

      employeeId = (
        await app.get(EmployeesService).create(tenantA, adminUserId, {
          code: employeeCode,
          displayName: 'POS Person',
          homeBranchId: branchX1,
          userId: uId,
          permittedBranchIds: [branchX1, branchX2],
        })
      ).id;
      await app.get(PinService).setPin(tenantA, adminUserId, employeeId, pin);
    });

    it('a TENANT-scoped role still cannot act on another terminal’s branch', async () => {
      const res = await posLogin(terminalX1).expect(200);
      const token = (res.body as Tokens).accessToken;
      const auth = await (async () => {
        const p = await tokens.verify(token);
        return tenantContext.resolve({
          userId: p.sub,
          sessionId: p.sid,
          tenantId: p.tid,
          membershipId: p.mid,
          terminalId: p.trm,
          employeeId: p.emp,
          sessionType: 'pos',
          authzEpoch: p.epo,
        });
      })();

      expect(auth.context.branchId).toBe(branchX1);
      const ask = (target: TargetScope) =>
        scopeAuthz.isAuthorized(auth, { codes: [BIZ], mode: 'all' }, target);

      expect(await ask({ type: 'branch', branchId: branchX1 })).toBe(true);
      // Permitted by EmployeeBranch AND covered by the tenant-scoped role —
      // and STILL denied, because the terminal binds the session to X1.
      expect(await ask({ type: 'branch', branchId: branchX2 })).toBe(false);
      expect(await ask({ type: 'branch', branchId: branchY1 })).toBe(false);
    });

    it('removing the employee from the terminal’s branch denies the NEXT request on a live token', async () => {
      const res = await posLogin(terminalX2).expect(200);
      const token = (res.body as Tokens).accessToken;
      const p = await tokens.verify(token);
      const principal = {
        userId: p.sub,
        sessionId: p.sid,
        tenantId: p.tid,
        membershipId: p.mid,
        terminalId: p.trm,
        employeeId: p.emp,
        sessionType: 'pos' as const,
        authzEpoch: p.epo,
      };
      await expect(tenantContext.resolve(principal)).resolves.toBeDefined();

      await admin.employeeBranch.delete({
        where: {
          employeeId_branchId: { employeeId, branchId: branchX2 },
        },
      });
      // The token is untouched; the live fact changed; the next request fails.
      await expect(tenantContext.resolve(principal)).rejects.toThrow();
    });

    it('a revoked terminal denies the NEXT request on a live token (FR-SEC-028)', async () => {
      const res = await posLogin(terminalX1).expect(200);
      const token = (res.body as Tokens).accessToken;
      const p = await tokens.verify(token);
      const principal = {
        userId: p.sub,
        sessionId: p.sid,
        tenantId: p.tid,
        membershipId: p.mid,
        terminalId: p.trm,
        employeeId: p.emp,
        sessionType: 'pos' as const,
        authzEpoch: p.epo,
      };
      await expect(tenantContext.resolve(principal)).resolves.toBeDefined();

      await app.get(TerminalsService).setStatus(tenantA, terminalX1, 'revoked');
      await expect(tenantContext.resolve(principal)).rejects.toThrow();
      await app.get(TerminalsService).setStatus(tenantA, terminalX1, 'active');
    });

    it('a POS token still cannot reach a dashboard route (FR-SEC-021 regression)', async () => {
      const res = await posLogin(terminalX1).expect(200);
      const token = (res.body as Tokens).accessToken;
      await request(http)
        .get('/auth/roles')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  // ═══════════════════════ G. USER / EMPLOYEE SPLIT ════════════════════════
  describe('G. User and Employee stay distinct', () => {
    it('a User with NO Employee row still authorises normally', async () => {
      const email = `srbac.nouser.${stamp}@example.com`;
      const uId = (
        await app
          .get(UsersService)
          .createUser({ email, displayName: 'no-employee', password })
      ).id;
      const m = (await app.get(MembershipsService).grant(uId, tenantA)).id;
      await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX2 },
      });

      const employee = await admin.employee.findFirst({
        where: { userId: uId },
      });
      expect(employee).toBeNull();

      const t = await selectTenant(email, tenantA);
      expect(await may(t, { type: 'branch', branchId: branchX2 })).toBe(true);
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(false);
    });

    it('an Employee with NO User remains representable and gains nothing', async () => {
      const code = `NOUSR${stamp % 100000}`;
      const e = await app.get(EmployeesService).create(tenantA, adminUserId, {
        code,
        displayName: 'Employee without login',
        homeBranchId: branchX1,
      });
      const row = await admin.employee.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(row.userId).toBeNull();
      // No login, so no session and no permissions — being in a branch grants
      // nothing at all (the C-1 invariant).
      const assignmentsForEmployee = await admin.membershipRole.findMany({
        where: { tenantId: tenantA, scopeBranchId: branchX1 },
      });
      expect(
        assignmentsForEmployee.every((a) => a.membershipId !== row.id),
      ).toBe(true);
    });
  });

  // ═════════════════════════ H. CROSS-TENANT ═══════════════════════════════
  describe('H. cross-tenant scope references are impossible', () => {
    it('rejects a foreign-tenant BRANCH scope in the application layer, tenant-safely', async () => {
      await expect(
        assignments.create(tenantA, adminUserId, {
          membershipId: mBranch,
          roleId: roleBiz,
          scope: { type: 'branch', branchId: branchB },
        }),
      ).rejects.toThrow(/Branch not found/);
    });

    it('rejects a foreign-tenant BRAND scope in the application layer, tenant-safely', async () => {
      const foreignBrand = await admin.brand.findFirstOrThrow({
        where: { tenantId: tenantB },
      });
      await expect(
        assignments.create(tenantA, adminUserId, {
          membershipId: mBranch,
          roleId: roleBiz,
          scope: { type: 'brand', brandId: foreignBrand.id },
        }),
      ).rejects.toThrow(/Brand not found/);
    });

    it('the composite FK rejects it INDEPENDENTLY, even as the migrator role', async () => {
      // RLS is not the FK mechanism. Proven by bypassing RLS entirely: the
      // database still refuses, because `(tenant_id, scope_branch_id)` has
      // nowhere to point.
      await expect(
        admin.membershipRole.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            membershipId: mBranch,
            roleId: roleBiz,
            scopeType: 'branch',
            scopeBranchId: branchB,
          },
        }),
      ).rejects.toThrow();
    });

    it('a TENANT-wide actor is still denied a FOREIGN branch, and cannot tell it apart from a missing one', async () => {
      const t = await selectTenant(
        `srbac.tenantscope.${stamp}@example.com`,
        tenantA,
      );
      // Tenant-wide authority covers "every branch in MY tenant". The primitive
      // resolves the target against Organisation under the caller's own RLS
      // context first, so another tenant's branch is INVISIBLE and denied — it
      // does not depend on the calling route remembering to resolve the
      // resource tenant-safely first.
      expect(await may(t, { type: 'branch', branchId: branchB })).toBe(false);
      // ...and a branch that exists nowhere gives exactly the same answer, so
      // the target is never an existence oracle (R-4).
      expect(await may(t, { type: 'branch', branchId: newId() })).toBe(false);
      // A real branch of the caller's own tenant is still allowed.
      expect(await may(t, { type: 'branch', branchId: branchX1 })).toBe(true);
    });

    it('denies a FOREIGN brand target the same way', async () => {
      const t = await selectTenant(
        `srbac.tenantscope.${stamp}@example.com`,
        tenantA,
      );
      const foreignBrand = await admin.brand.findFirstOrThrow({
        where: { tenantId: tenantB },
      });
      expect(await may(t, { type: 'brand', brandId: foreignBrand.id })).toBe(
        false,
      );
      expect(await may(t, { type: 'brand', brandId: newId() })).toBe(false);
      expect(await may(t, { type: 'brand', brandId: brandX })).toBe(true);
    });

    it('a BRAND-scoped actor gets the same answer for a foreign branch as a missing one', async () => {
      const tb = await selectTenant(
        `srbac.brandscope.${stamp}@example.com`,
        tenantA,
      );
      expect(await may(tb, { type: 'branch', branchId: branchB })).toBe(false);
      expect(await may(tb, { type: 'branch', branchId: newId() })).toBe(false);
    });
  });

  // ═══════════════════════ K. AMBIGUOUS LEGACY API ═════════════════════════
  describe('K. the deprecated remove-by-role route fails closed when ambiguous', () => {
    it('removes a single assignment, but refuses to remove several at once', async () => {
      const email = `srbac.ambig.${stamp}@example.com`;
      const uId = (
        await app
          .get(UsersService)
          .createUser({ email, displayName: 'ambig', password })
      ).id;
      const m = (await app.get(MembershipsService).grant(uId, tenantA)).id;
      const adminToken = await selectTenant(
        `srbac.admin.${stamp}@example.com`,
        tenantA,
      );

      // One assignment: the legacy route is unambiguous and still works.
      await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX1 },
      });
      await request(http)
        .delete(`/auth/memberships/${m}/roles/${roleBiz}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      // Two assignments of the same role at different scopes: 409, and NEITHER
      // is removed. Silently revoking both would be an unlogged, unintended
      // loss of authority.
      const a1 = await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX1 },
      });
      const a2 = await assignments.create(tenantA, adminUserId, {
        membershipId: m,
        roleId: roleBiz,
        scope: { type: 'branch', branchId: branchX2 },
      });
      await request(http)
        .delete(`/auth/memberships/${m}/roles/${roleBiz}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);

      const survivors = await admin.membershipRole.findMany({
        where: { membershipId: m, roleId: roleBiz },
        select: { id: true },
      });
      expect(survivors.map((s) => s.id).sort()).toEqual([a1.id, a2.id].sort());

      // The assignment-id route removes exactly one.
      await request(http)
        .delete(`/auth/role-assignments/${a1.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);
      const left = await admin.membershipRole.findMany({
        where: { membershipId: m, roleId: roleBiz },
        select: { id: true },
      });
      expect(left.map((s) => s.id)).toEqual([a2.id]);
    });
  });
});
