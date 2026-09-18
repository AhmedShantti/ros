import { backfillCanonicalRolePermissions } from './backfill-canonical-role-permissions';
import { reconcileExistingCanonicalRoles } from '../modules/identity/authz/canonical-role-templates';

jest.mock('../modules/identity/authz/canonical-role-templates', () => ({
  reconcileExistingCanonicalRoles: jest.fn(),
}));

const mockReconcile = reconcileExistingCanonicalRoles as jest.MockedFunction<
  typeof reconcileExistingCanonicalRoles
>;

/**
 * CANONICAL-ROLE-PERMISSION-BACKFILL-P0 — unit coverage for the ITERATION
 * driver only (list every tenant, reconcile each inside its own tenant-
 * scoped transaction, aggregate results). `reconcileExistingCanonicalRoles`
 * itself is mocked here — its real DB-level behaviour (additive-only,
 * idempotent, custom-role-safe, assignments/scopes untouched, etc.) is
 * proven against a real database in
 * `test/canonical-role-permission-backfill.e2e-spec.ts`. This file never
 * touches a real database, so it stays fast and never risks interference
 * from other tenants created by other, shared e2e specs.
 */
describe('backfillCanonicalRolePermissions — per-tenant iteration', () => {
  beforeEach(() => {
    mockReconcile.mockReset();
  });

  it('reconciles every tenant returned by prisma.tenant.findMany, each inside its own withAuthContext, and aggregates the results', async () => {
    const tenantIds = ['tenant-a', 'tenant-b', 'tenant-c'];
    mockReconcile.mockImplementation(async (_tx, tenantId) => [
      {
        tenantId,
        roleId: `role-${tenantId}`,
        roleName: 'Branch Manager',
        templateKey: 'branch_manager',
        addedPermissionCodes: [],
      },
    ]);

    const withAuthContextCalls: Array<{ tenantId: string }> = [];
    const prisma = {
      tenant: {
        findMany: jest.fn().mockResolvedValue(tenantIds.map((id) => ({ id }))),
      },
      withAuthContext: jest.fn(
        async (scope: { tenantId: string }, fn: (tx: unknown) => unknown) => {
          withAuthContextCalls.push(scope);
          return fn({ __fakeTx: scope.tenantId });
        },
      ),
    };

    const results = await backfillCanonicalRolePermissions(prisma as never);

    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    expect(withAuthContextCalls).toEqual(
      tenantIds.map((tenantId) => ({ tenantId })),
    );
    expect(mockReconcile).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.tenantId)).toEqual(tenantIds);
  });

  it('is a no-op that still succeeds when there are zero tenants', async () => {
    const prisma = {
      tenant: { findMany: jest.fn().mockResolvedValue([]) },
      withAuthContext: jest.fn(),
    };

    const results = await backfillCanonicalRolePermissions(prisma as never);

    expect(results).toEqual([]);
    expect(prisma.withAuthContext).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
