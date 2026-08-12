import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedPrincipal } from '../auth/auth.types';
import { AuthorizationService } from './authorization.service';

const withContext: AuthenticatedPrincipal = {
  userId: 'u-1',
  sessionId: 's-1',
  tenantId: 't-1',
  membershipId: 'm-1',
};

function rowsFor(...codeGroups: string[][]) {
  return codeGroups.map((codes) => ({
    role: {
      rolePermissions: codes.map((code) => ({ permission: { code } })),
    },
  }));
}

describe('AuthorizationService', () => {
  let findMany: jest.Mock;
  let service: AuthorizationService;

  beforeEach(() => {
    findMany = jest.fn();
    const prisma = {
      membershipRole: { findMany },
    } as unknown as PrismaService;
    service = new AuthorizationService(prisma);
  });

  it('unions permission codes across the membership roles', async () => {
    findMany.mockResolvedValue(rowsFor(['a', 'b'], ['b', 'c']));
    const codes = await service.getEffectivePermissions(withContext);
    expect([...codes].sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty set (and does not query) without tenant context', async () => {
    const codes = await service.getEffectivePermissions({
      userId: 'u-1',
      sessionId: 's-1',
    });
    expect(codes.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('scopes the query to the active membership, user, tenant, and valid roles', async () => {
    findMany.mockResolvedValue([]);
    await service.getEffectivePermissions(withContext);
    const calls = findMany.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0][0].where).toMatchObject({
      membershipId: 'm-1',
      membership: { userId: 'u-1', tenantId: 't-1', status: 'active' },
      role: { OR: [{ tenantId: 't-1' }, { isSystem: true }] },
    });
  });

  it('hasAll / hasAny evaluate against effective permissions', async () => {
    findMany.mockResolvedValue(rowsFor(['a']));
    await expect(service.hasAll(withContext, ['a'])).resolves.toBe(true);
    await expect(service.hasAll(withContext, ['a', 'b'])).resolves.toBe(false);
    await expect(service.hasAny(withContext, ['b', 'a'])).resolves.toBe(true);
    await expect(service.hasAny(withContext, ['x', 'y'])).resolves.toBe(false);
  });
});
