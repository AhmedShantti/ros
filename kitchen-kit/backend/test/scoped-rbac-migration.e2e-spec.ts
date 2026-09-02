import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { BranchesService } from './../src/modules/organisation/branches/branches.service';
import { BrandsService } from './../src/modules/organisation/brands/brands.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { createMigratorClient } from './rls-admin';

/**
 * B1-2 — M-4+ MIGRATION POSTURE and the membership_roles RLS surface.
 *
 * Authority: "AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC"
 * clauses 12, 13 and 14.
 *
 * The migration itself is proven against real databases outside Jest (see the
 * B1-2 report: from-zero and legacy-upgrade runs). What is proven HERE is the
 * RUNTIME behaviour the migration's output must have: an inherited grant is
 * distinguishable, it blocks the 1 -> 2 branch transition, review or re-scoping
 * clears the block, an already-multi-branch tenant is reported rather than
 * broken, and the new UPDATE policy is tenant-safe under FORCE RLS.
 */

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('Scoped RBAC — M-4+ migration posture and RLS (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let prisma: PrismaService;

  let assignments: MembershipRolesService;
  let branches: BranchesService;
  let brands: BrandsService;
  let users: UsersService;
  let tenants: TenantsService;
  let memberships: MembershipsService;
  let roles: RolesService;

  /** A tenant whose only role assignment is INHERITED (as the backfill leaves it). */
  const makeInheritedTenant = async (label: string) => {
    const tenantId = (
      await tenants.create({
        slug: `m4-${label}-${stamp}`,
        legalName: `M4 ${label}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    const userId = (
      await users.createUser({
        email: `m4.${label}.${stamp}@example.com`,
        displayName: label,
        password,
      })
    ).id;
    const membershipId = (await memberships.grant(userId, tenantId)).id;
    const roleId = (
      await roles.createTenantRole(tenantId, { name: `m4_${label}` })
    ).id;

    // Exactly what migration 36's backfill produces: tenant scope, migration
    // origin, never reviewed. Written through the migrator client because the
    // API deliberately cannot create an inherited grant — only the migration can.
    const assignmentId = newId();
    await admin.membershipRole.create({
      data: {
        id: assignmentId,
        tenantId,
        membershipId,
        roleId,
        scopeType: 'tenant',
        origin: 'migration',
      },
    });

    const brandId = (
      await brands.create(tenantId, userId, { name: `M4 ${label}` })
    ).id;
    return { tenantId, userId, membershipId, roleId, assignmentId, brandId };
  };

  /**
   * A branch created through the migrator client, WITH the `org.locations`
   * registry row `BranchesService.create` would have written. These arranges
   * deliberately bypass the service (they need a branch in a state the service
   * refuses to create, e.g. `inactive`, or a tenant that is ALREADY
   * multi-branch), so the registry row must be written explicitly or the
   * repository-wide "no org location entity without a registry row" invariant
   * would break.
   */
  const rawBranch = async (
    tenantId: string,
    brandId: string,
    code: string,
    status: 'active' | 'inactive',
  ) => {
    const branch = await admin.branch.create({
      data: {
        id: newId(),
        tenantId,
        brandId,
        code,
        name: code,
        timezone: 'Africa/Cairo',
        baseCurrency: 'EGP',
        countryCode: 'EG',
        status,
      },
    });
    await admin.location.createMany({
      data: [
        {
          id: newId(),
          tenantId,
          locationType: 'branch' as const,
          refId: branch.id,
          branchId: branch.id,
        },
      ],
      skipDuplicates: true,
    });
    return branch;
  };

  const addBranch = (
    tenantId: string,
    userId: string,
    brandId: string,
    code: string,
  ) =>
    branches.create(tenantId, userId, {
      brandId,
      code,
      name: code,
      timezone: 'Africa/Cairo',
      baseCurrency: 'EGP',
      countryCode: 'EG',
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    assignments = app.get(MembershipRolesService);
    branches = app.get(BranchesService);
    brands = app.get(BrandsService);
    users = app.get(UsersService);
    tenants = app.get(TenantsService);
    memberships = app.get(MembershipsService);
    roles = app.get(RolesService);
  });

  afterAll(async () => {
    await admin.$disconnect().catch(() => undefined);
    await app.close();
  });

  describe('inherited grants are distinguishable and legacy behaviour is preserved', () => {
    it('a migration-originated assignment carries provenance and is unreviewed', async () => {
      const f = await makeInheritedTenant('prov');
      const row = await admin.membershipRole.findUniqueOrThrow({
        where: { id: f.assignmentId },
      });
      expect(row.origin).toBe('migration');
      expect(row.reviewedAt).toBeNull();
      expect(row.scopeType).toBe('tenant');
      // Whereas anything created through the API is explicit, never inherited.
      const explicit = await assignments.create(f.tenantId, f.userId, {
        membershipId: f.membershipId,
        roleId: (
          await roles.createTenantRole(f.tenantId, { name: `x_${stamp}` })
        ).id,
        scope: { type: 'tenant' },
      });
      expect(explicit.origin).toBe('explicit');
      expect(explicit.reviewedAt).toBeNull();
    });

    it('the FIRST active branch is never gated — single-branch behaviour is untouched', async () => {
      const f = await makeInheritedTenant('single');
      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `S1${stamp % 1000}`),
      ).resolves.toBeDefined();
    });
  });

  describe('the second-active-branch gate (clause 13.C)', () => {
    it('DENIES the second active branch while inherited grants are unreviewed', async () => {
      const f = await makeInheritedTenant('gate');
      await addBranch(f.tenantId, f.userId, f.brandId, `G1${stamp % 1000}`);
      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `G2${stamp % 1000}`),
      ).rejects.toThrow(/cannot activate a second branch/i);
    });

    it('also gates ACTIVATING an existing inactive branch, not just creating one', async () => {
      const f = await makeInheritedTenant('activate');
      await addBranch(f.tenantId, f.userId, f.brandId, `A1${stamp % 1000}`);
      // Park a second branch out of the way of the gate, then try to activate.
      const second = await rawBranch(
        f.tenantId,
        f.brandId,
        `A2${stamp % 1000}`,
        'inactive',
      );
      await expect(
        branches.setStatus(f.tenantId, f.userId, second.id, 'active'),
      ).rejects.toThrow(/cannot activate a second branch/i);
    });

    it('EXPLICIT REVIEW clears the block without forcing a scope change (outcome A)', async () => {
      const f = await makeInheritedTenant('review');
      await addBranch(f.tenantId, f.userId, f.brandId, `R1${stamp % 1000}`);
      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `R2${stamp % 1000}`),
      ).rejects.toThrow(/cannot activate a second branch/i);

      const reviewed = await assignments.review(
        f.tenantId,
        f.userId,
        f.assignmentId,
      );
      expect(reviewed.reviewedAt).not.toBeNull();
      // The scope is UNCHANGED: an administrator who judges tenant-wide to be
      // correct is not forced to narrow it merely to record that judgement.
      expect(reviewed.scopeType).toBe('tenant');
      expect(reviewed.origin).toBe('migration');

      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `R3${stamp % 1000}`),
      ).resolves.toBeDefined();
    });

    it('RE-SCOPING to a narrow grant also clears the block (outcome B)', async () => {
      const f = await makeInheritedTenant('rescope');
      const b1 = await addBranch(
        f.tenantId,
        f.userId,
        f.brandId,
        `P1${stamp % 1000}`,
      );
      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `P2${stamp % 1000}`),
      ).rejects.toThrow(/cannot activate a second branch/i);

      // Replacing the inherited grant with an explicit narrow one removes the
      // inherited row entirely, which is what clears the condition.
      await assignments.remove(f.tenantId, f.userId, f.assignmentId);
      await assignments.create(f.tenantId, f.userId, {
        membershipId: f.membershipId,
        roleId: f.roleId,
        scope: { type: 'branch', branchId: b1.id },
      });

      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `P3${stamp % 1000}`),
      ).resolves.toBeDefined();
    });

    it('a REVIEWED inherited grant no longer counts, but an unreviewed sibling still does', async () => {
      const f = await makeInheritedTenant('mixed');
      const secondInherited = newId();
      const otherUser = (
        await users.createUser({
          email: `m4.mixed2.${stamp}@example.com`,
          displayName: 'mixed2',
          password,
        })
      ).id;
      const otherMembership = (await memberships.grant(otherUser, f.tenantId))
        .id;
      await admin.membershipRole.create({
        data: {
          id: secondInherited,
          tenantId: f.tenantId,
          membershipId: otherMembership,
          roleId: f.roleId,
          scopeType: 'tenant',
          origin: 'migration',
        },
      });
      await addBranch(f.tenantId, f.userId, f.brandId, `M1${stamp % 1000}`);

      await assignments.review(f.tenantId, f.userId, f.assignmentId);
      // One inherited grant reviewed, one still outstanding -> still blocked.
      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `M2${stamp % 1000}`),
      ).rejects.toThrow(/cannot activate a second branch/i);

      await assignments.review(f.tenantId, f.userId, secondInherited);
      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `M3${stamp % 1000}`),
      ).resolves.toBeDefined();
    });
  });

  describe('already-multi-branch tenants (clause 13.D)', () => {
    it('are NOT broken, are NOT declared ready, and report review-required', async () => {
      const f = await makeInheritedTenant('multi');
      // Two active branches ALREADY exist when the inherited grant is present —
      // the state a real already-multi-branch tenant is in after migration.
      const b1 = await rawBranch(
        f.tenantId,
        f.brandId,
        `U1${stamp % 1000}`,
        'active',
      );
      await rawBranch(f.tenantId, f.brandId, `U2${stamp % 1000}`, 'active');

      // Not failed, not retroactively blocked: ordinary operations continue.
      await expect(branches.findOne(f.tenantId, b1.id)).resolves.toBeDefined();
      // And a further branch is NOT gated — the gate is the 1 -> 2 transition
      // only; this tenant is past it and is handled by review state, not by a
      // block that would break a running business.
      await expect(
        addBranch(f.tenantId, f.userId, f.brandId, `U3${stamp % 1000}`),
      ).resolves.toBeDefined();

      // But it is reported as requiring review, and therefore NOT
      // multi-branch-authorization-ready.
      const reviewRequired = await prisma.withAuthContext(
        { tenantId: f.tenantId },
        (tx) =>
          tx.membershipRole.findFirst({
            where: { origin: 'migration', reviewedAt: null },
            select: { id: true },
          }),
      );
      expect(reviewRequired).not.toBeNull();
    });
  });

  describe('membership_roles RLS under FORCE', () => {
    it('keeps ENABLE + FORCE row level security', async () => {
      const [row] = await admin.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`SELECT relrowsecurity, relforcerowsecurity
          FROM pg_class WHERE oid = 'identity.membership_roles'::regclass`;
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    });

    it('has the UPDATE policy B1-2 added, with both USING and WITH CHECK', async () => {
      const policies = await admin.$queryRaw<
        {
          policyname: string;
          cmd: string;
          qual: string | null;
          with_check: string | null;
        }[]
      >`SELECT policyname, cmd, qual, with_check
          FROM pg_policies
         WHERE schemaname = 'identity' AND tablename = 'membership_roles'`;
      const update = policies.find((p) => p.cmd === 'UPDATE');
      expect(update).toBeDefined();
      expect(update?.qual).toBeTruthy();
      expect(update?.with_check).toBeTruthy();
      expect(policies.map((p) => p.cmd).sort()).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    });

    it('introduces NO branch predicate and NO app.branch_id GUC', async () => {
      const policies = await admin.$queryRaw<
        { qual: string | null; with_check: string | null }[]
      >`SELECT qual, with_check
          FROM pg_policies
         WHERE schemaname = 'identity' AND tablename = 'membership_roles'`;
      for (const p of policies) {
        const text = `${p.qual ?? ''} ${p.with_check ?? ''}`;
        expect(text).not.toMatch(/app\.branch_id/);
        expect(text).not.toMatch(/scope_branch_id/);
      }
    });

    it('permits UPDATE only inside the owning tenant, as the runtime role', async () => {
      const f = await makeInheritedTenant('rls');
      const other = await makeInheritedTenant('rlsother');

      // Same tenant: allowed.
      const own = await prisma.withAuthContext({ tenantId: f.tenantId }, (tx) =>
        tx.membershipRole.updateMany({
          where: { id: f.assignmentId },
          data: { validTo: new Date(Date.now() + 3_600_000) },
        }),
      );
      expect(own.count).toBe(1);

      // Acting as tenant A, targeting tenant B's assignment: the row is
      // invisible AND the policy refuses it — zero rows touched, no error that
      // would confirm it exists.
      const cross = await prisma.withAuthContext(
        { tenantId: f.tenantId },
        (tx) =>
          tx.membershipRole.updateMany({
            where: { id: other.assignmentId },
            data: { validTo: new Date(Date.now() + 3_600_000) },
          }),
      );
      expect(cross.count).toBe(0);

      const untouched = await admin.membershipRole.findUniqueOrThrow({
        where: { id: other.assignmentId },
      });
      expect(untouched.validTo).toBeNull();
    });

    it('refuses to move an assignment into another tenant (WITH CHECK)', async () => {
      const f = await makeInheritedTenant('retenant');
      const other = await makeInheritedTenant('retenant2');
      await expect(
        prisma.withAuthContext({ tenantId: f.tenantId }, (tx) =>
          tx.membershipRole.update({
            where: { id: f.assignmentId },
            data: { tenantId: other.tenantId },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('temporal duplication is impossible', () => {
    it('refuses a second effective assignment of the same role at the same scope', async () => {
      const f = await makeInheritedTenant('dup');
      const b = await addBranch(
        f.tenantId,
        f.userId,
        f.brandId,
        `D1${stamp % 1000}`,
      );
      await assignments.create(f.tenantId, f.userId, {
        membershipId: f.membershipId,
        roleId: f.roleId,
        scope: { type: 'branch', branchId: b.id },
      });
      await expect(
        assignments.create(f.tenantId, f.userId, {
          membershipId: f.membershipId,
          roleId: f.roleId,
          scope: { type: 'branch', branchId: b.id },
        }),
      ).rejects.toThrow(/already assigned at this exact scope/i);
    });

    it('still allows a re-grant AFTER an earlier one has expired', async () => {
      const f = await makeInheritedTenant('regrant');
      const b = await addBranch(
        f.tenantId,
        f.userId,
        f.brandId,
        `E1${stamp % 1000}`,
      );
      const past = new Date(Date.now() - 7_200_000);
      const stopped = new Date(Date.now() - 3_600_000);
      await assignments.create(f.tenantId, f.userId, {
        membershipId: f.membershipId,
        roleId: f.roleId,
        scope: { type: 'branch', branchId: b.id },
        validFrom: past,
        validTo: stopped,
      });
      // History is preserved AND a new grant is possible — the constraint
      // forbids overlap, not succession.
      await expect(
        assignments.create(f.tenantId, f.userId, {
          membershipId: f.membershipId,
          roleId: f.roleId,
          scope: { type: 'branch', branchId: b.id },
        }),
      ).resolves.toBeDefined();
    });
  });
});
