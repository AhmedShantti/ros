import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import { TREASURY_PERMISSION_DEFS } from './../src/modules/treasury/treasury.permissions';
import { createAppClient, createMigratorClient } from './rls-admin';

/**
 * CASH-VARIANCE-BRANCH-MANAGER-P0.
 *
 * Proves the RLS-AWARE migration
 * (`20260919140000_backfill_branch_manager_cash_variance_approve_permission`)
 * actually backfills `cash.variance.approve` when executed through the SAME
 * CLASS OF CONNECTION production's `prisma migrate deploy` uses —
 * RLS-constrained `ros_app` (`APP_DATABASE_URL`), starting from a FRESH
 * connection with no `app.tenant_id` pre-set — mirroring
 * `branch-manager-cash-close-rls-aware-migration.e2e-spec.ts` exactly, per
 * the empirical mechanism proven in
 * `docs/reports/claude/2026-09-19_CASH-CLOSE-MIGRATION-RLS-ZERO-EFFECT-P0_investigation.md`.
 *
 * This proof is deliberately DB-level (`RolePermission` rows), not a live
 * HTTP round trip: `cash.variance.approve` is checked by the Approval
 * Runtime during `finalizeClose`, not by any route guard reachable without a
 * full declare-above-tolerance-then-finalize fixture — that live behavioural
 * proof already exists, against the real canonical template directly (no
 * migration involved, since a freshly-provisioned tenant gets the template's
 * current permission set immediately), in
 * `cash-session-close.e2e-spec.ts`'s "Branch Manager canonical role —
 * cash.variance.approve" block. This file's only job is proving the
 * MIGRATION's SQL mechanism survives RLS for already-provisioned tenants.
 *
 * The migration's own SQL file is read from disk and executed verbatim —
 * never duplicated inline — so this test can only pass if the actual
 * shipped file is RLS-aware and correctly scoped.
 */

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20260919140000_backfill_branch_manager_cash_variance_approve_permission/migration.sql',
  ),
  'utf8',
);

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('Branch Manager cash-variance-approve RLS-AWARE migration (e2e) — CASH-VARIANCE-BRANCH-MANAGER-P0', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  /**
   * A tenant with a stale "Branch Manager" role (already holding the two
   * close codes — simulating a tenant already fixed by the PRIOR migration
   * — but NOT `cash.variance.approve`), a Shift Supervisor role, a Cashier
   * role, and a differently-named custom role sharing an identical starting
   * gap. One membership/assignment on the Branch Manager role, to prove
   * `MembershipRole` is untouched.
   */
  async function seedTenant(label: string) {
    const tenants = app.get(TenantsService);
    const users = app.get(UsersService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const tenantId = (
      await tenants.create({
        slug: `bmva-${label}-${stamp}`,
        legalName: `BMVA ${label} ${stamp}`,
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    const userId = (
      await users.createUser({
        email: `bmva.manager.${label}.${stamp}@example.com`,
        password,
        displayName: 'BMVA',
      })
    ).id;
    await memberships.grant(userId, tenantId, 'active');

    // A. Stale "Branch Manager" — exact name, isSystem=false — already
    // holds the close codes (a prior migration's result) but not the
    // variance-approve code this migration must add.
    const managerRole = await roles.createTenantRole(tenantId, { name: 'Branch Manager' });
    await roles.addPermissions(tenantId, managerRole.id, [
      'cash.session.open',
      'cash.session.close',
      'cash.session.close_other',
    ]);
    const membership = await admin.membership.findFirstOrThrow({ where: { userId, tenantId } });
    const assignment = await membershipRoles.create(tenantId, null, {
      membershipId: membership.id,
      roleId: managerRole.id,
      scope: { type: 'tenant' },
    });

    // Shift Supervisor — same starting codes, MUST remain untouched: this
    // migration's `WHERE r.name = 'Branch Manager'` filter must not match it
    // even though it shares an identical permission gap.
    const supervisorRole = await roles.createTenantRole(tenantId, { name: 'Shift Supervisor' });
    await roles.addPermissions(tenantId, supervisorRole.id, [
      'cash.session.open',
      'cash.session.close',
      'cash.session.close_other',
    ]);

    // Cashier — MUST remain untouched.
    const cashierRole = await roles.createTenantRole(tenantId, { name: 'Cashier' });
    await roles.addPermissions(tenantId, cashierRole.id, ['cash.session.open', 'cash.session.close']);

    // A differently-named custom role with the identical gap — must never
    // be touched.
    const customRole = await roles.createTenantRole(tenantId, { name: `bmva_custom_${label}_${stamp}` });
    await roles.addPermissions(tenantId, customRole.id, [
      'cash.session.open',
      'cash.session.close',
      'cash.session.close_other',
    ]);

    return { tenantId, managerRole, supervisorRole, cashierRole, customRole, assignment };
  }

  const codesOf = async (roleId: string) =>
    (
      await admin.rolePermission.findMany({ where: { roleId }, include: { permission: true } })
    ).map((rp) => rp.permission.code).sort();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    admin = createMigratorClient(app);

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    for (const def of TREASURY_PERMISSION_DEFS) await permissions.upsert(def);
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  it('backfills cash.variance.approve, ONLY onto Branch Manager, when the actual migration.sql is executed through a fresh, RLS-constrained ros_app connection with no pre-set tenant context — across multiple tenants, idempotently, leaving Shift Supervisor/Cashier/custom roles and MembershipRole rows untouched', async () => {
    // Two independent tenants, proving the migration's tenant LOOP really
    // processes more than one, not one accidental match.
    const one = await seedTenant('one');
    const two = await seedTenant('two');

    // Before: stale Branch Manager role in both tenants lacks the code.
    expect(await codesOf(one.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );
    expect(await codesOf(two.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open'].sort(),
    );

    // Snapshot both assignments and the sibling roles before the migration
    // runs.
    const assignmentOneBefore = await admin.membershipRole.findUniqueOrThrow({ where: { id: one.assignment.id } });
    const assignmentTwoBefore = await admin.membershipRole.findUniqueOrThrow({ where: { id: two.assignment.id } });
    const supervisorOneBefore = await codesOf(one.supervisorRole.id);
    const supervisorTwoBefore = await codesOf(two.supervisorRole.id);
    const cashierOneBefore = await codesOf(one.cashierRole.id);
    const cashierTwoBefore = await codesOf(two.cashierRole.id);
    const customOneBefore = await codesOf(one.customRole.id);
    const customTwoBefore = await codesOf(two.customRole.id);

    // A BRAND-NEW ros_app client — never touched by anything above —
    // confirmed to start with NO tenant context, then used to execute the
    // real migration.sql file content verbatim.
    const freshAppClient = createAppClient(app);
    try {
      const [{ current_setting: contextBefore }] = await freshAppClient.$queryRawUnsafe<
        { current_setting: string | null }[]
      >("SELECT current_setting('app.tenant_id', true) AS current_setting");
      expect(contextBefore === null || contextBefore === '').toBe(true);

      await freshAppClient.$executeRawUnsafe(MIGRATION_SQL);
    } finally {
      await freshAppClient.$disconnect();
    }

    // Both tenants' Branch Manager roles gained exactly the one new code.
    expect(await codesOf(one.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open', 'cash.variance.approve'].sort(),
    );
    expect(await codesOf(two.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open', 'cash.variance.approve'].sort(),
    );

    // Shift Supervisor, Cashier, and the custom role: byte-identical to
    // before, in both tenants.
    expect(await codesOf(one.supervisorRole.id)).toEqual(supervisorOneBefore);
    expect(await codesOf(two.supervisorRole.id)).toEqual(supervisorTwoBefore);
    expect(await codesOf(one.cashierRole.id)).toEqual(cashierOneBefore);
    expect(await codesOf(two.cashierRole.id)).toEqual(cashierTwoBefore);
    expect(await codesOf(one.customRole.id)).toEqual(customOneBefore);
    expect(await codesOf(two.customRole.id)).toEqual(customTwoBefore);

    // Role assignments (MembershipRole) — id, membership, role, scope,
    // validity — byte-identical to before the migration ran.
    expect(await admin.membershipRole.findUniqueOrThrow({ where: { id: one.assignment.id } })).toEqual(
      assignmentOneBefore,
    );
    expect(await admin.membershipRole.findUniqueOrThrow({ where: { id: two.assignment.id } })).toEqual(
      assignmentTwoBefore,
    );

    // Run it again — a second FRESH ros_app connection, no context — no
    // duplicates, no additional changes.
    const secondAppClient = createAppClient(app);
    try {
      await expect(secondAppClient.$executeRawUnsafe(MIGRATION_SQL)).resolves.toBeDefined();
    } finally {
      await secondAppClient.$disconnect();
    }
    expect(await codesOf(one.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open', 'cash.variance.approve'].sort(),
    );
    expect(await codesOf(two.managerRole.id)).toEqual(
      ['cash.session.close', 'cash.session.close_other', 'cash.session.open', 'cash.variance.approve'].sort(),
    );
    expect(await codesOf(one.supervisorRole.id)).toEqual(supervisorOneBefore);
    expect(await codesOf(two.supervisorRole.id)).toEqual(supervisorTwoBefore);
  }, 60_000);
});
