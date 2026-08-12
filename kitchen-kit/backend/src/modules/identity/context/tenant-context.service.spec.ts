import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedPrincipal } from '../auth/auth.types';
import { AuthorizedRequest } from './tenant-context.service';
import { TenantContextService } from './tenant-context.service';

const principal: AuthenticatedPrincipal = {
  userId: 'u-1',
  sessionId: 's-1',
  tenantId: 't-1',
  membershipId: 'm-1',
};

function membershipRow(...codeGroups: string[][]) {
  return {
    id: 'm-1',
    membershipRoles: codeGroups.map((codes) => ({
      role: {
        rolePermissions: codes.map((code) => ({ permission: { code } })),
      },
    })),
  };
}

describe('TenantContextService', () => {
  let findFirst: jest.Mock;
  let service: TenantContextService;

  beforeEach(() => {
    findFirst = jest.fn();
    const prisma = {
      membership: { findFirst },
    } as unknown as PrismaService;
    service = new TenantContextService(prisma);
  });

  it('resolves context and effective permissions from an active membership', async () => {
    findFirst.mockResolvedValue(membershipRow(['a', 'b'], ['b', 'c']));
    const resolved = await service.resolve(principal);
    expect(resolved.context).toEqual({
      userId: 'u-1',
      sessionId: 's-1',
      tenantId: 't-1',
      membershipId: 'm-1',
    });
    expect([...resolved.permissions].sort()).toEqual(['a', 'b', 'c']);
  });

  it('validates membership by id, user, tenant, active status, and active tenant', async () => {
    findFirst.mockResolvedValue(membershipRow([]));
    await service.resolve(principal);
    const calls = findFirst.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0][0].where).toMatchObject({
      id: 'm-1',
      userId: 'u-1',
      tenantId: 't-1',
      status: 'active',
      tenant: { status: 'active' },
    });
  });

  it('rejects (403) when there is no active tenant selection', async () => {
    await expect(
      service.resolve({ userId: 'u-1', sessionId: 's-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects (403) when the membership is invalid (inactive/mismatch/inactive tenant)', async () => {
    findFirst.mockResolvedValue(null);
    await expect(service.resolve(principal)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('memoizes on the request (single query for multiple guards)', async () => {
    findFirst.mockResolvedValue(membershipRow(['a']));
    const request = { principal } as AuthorizedRequest;
    const first = await service.require(request);
    const second = await service.require(request);
    expect(first).toBe(second);
    expect(request.authorization).toBe(first);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('require() 401s when there is no principal', async () => {
    await expect(
      service.require({} as AuthorizedRequest),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
