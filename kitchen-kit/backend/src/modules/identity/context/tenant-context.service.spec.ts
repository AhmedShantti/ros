import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticatedPrincipal } from '../auth/auth.types';
import { AuthorizedRequest } from './tenant-context.service';
import { TenantContextService } from './tenant-context.service';

/** A tenant-bound principal whose token snapshot matches the live epoch. */
const principal: AuthenticatedPrincipal = {
  userId: 'u-1',
  sessionId: 's-1',
  tenantId: 't-1',
  membershipId: 'm-1',
  authzEpoch: 7,
};

type Scope =
  | { scopeType: 'tenant' }
  | { scopeType: 'brand'; scopeBrandId: string }
  | { scopeType: 'branch'; scopeBranchId: string };

/**
 * One scoped assignment row, shaped exactly as the resolver's `select` returns
 * it. Declared with WIDE field types on purpose: the tests deliberately build
 * variants (a migration-originated row, a reviewed row, an inconsistent row),
 * and literal-narrowed types would make those unrepresentable.
 */
interface AssignmentRow {
  id: string;
  roleId: string;
  scopeType: 'tenant' | 'brand' | 'branch';
  scopeBrandId: string | null;
  scopeBranchId: string | null;
  origin: 'explicit' | 'migration';
  reviewedAt: Date | null;
  role: { rolePermissions: { permission: { code: string } }[] };
}

let assignmentSeq = 0;

function assignment(scope: Scope, codes: string[]): AssignmentRow {
  assignmentSeq += 1;
  return {
    id: `a-${assignmentSeq}`,
    roleId: `r-${assignmentSeq}`,
    scopeBrandId: null,
    scopeBranchId: null,
    origin: 'explicit',
    reviewedAt: null,
    ...scope,
    role: {
      rolePermissions: codes.map((code) => ({ permission: { code } })),
    },
  };
}

function membershipRow(rows: AssignmentRow[], authzEpoch = 7) {
  return { id: 'm-1', authzEpoch, membershipRoles: rows };
}

describe('TenantContextService', () => {
  let findFirst: jest.Mock;
  let service: TenantContextService;

  beforeEach(() => {
    assignmentSeq = 0;
    findFirst = jest.fn();
    const prisma = {
      withAuthContext: jest.fn(
        (_scope: unknown, fn: (tx: unknown) => unknown) =>
          fn({
            membership: { findFirst },
            // The resolver reads the DATABASE clock inside its own transaction.
            $queryRaw: jest.fn().mockResolvedValue([{ now: new Date() }]),
          }),
      ),
    } as unknown as PrismaService;
    service = new TenantContextService(prisma);
  });

  it('resolves context and TENANT-scoped permissions from an active membership', async () => {
    findFirst.mockResolvedValue(
      membershipRow([
        assignment({ scopeType: 'tenant' }, ['a', 'b']),
        assignment({ scopeType: 'tenant' }, ['b', 'c']),
      ]),
    );
    const resolved = await service.resolve(principal);
    expect(resolved.context).toEqual({
      userId: 'u-1',
      sessionId: 's-1',
      tenantId: 't-1',
      membershipId: 'm-1',
    });
    expect([...resolved.permissions].sort()).toEqual(['a', 'b', 'c']);
    expect(resolved.authzEpoch).toBe(7);
    expect(resolved.scopeReviewRequired).toBe(false);
  });

  it('keeps BRAND and BRANCH grants OUT of the flat tenant-target set (B1-2 transition)', async () => {
    findFirst.mockResolvedValue(
      membershipRow([
        assignment({ scopeType: 'tenant' }, ['tenant.only']),
        assignment({ scopeType: 'brand', scopeBrandId: 'brand-1' }, [
          'brand.only',
        ]),
        assignment({ scopeType: 'branch', scopeBranchId: 'branch-1' }, [
          'branch.only',
        ]),
      ]),
    );
    const resolved = await service.resolve(principal);

    // The legacy permission-only guard sees ONLY tenant-scoped authority.
    expect([...resolved.permissions]).toEqual(['tenant.only']);
    // But every grant is retained, scope-qualified, for the target-aware path.
    expect(resolved.grants).toHaveLength(3);
    expect(resolved.grants.map((g) => g.scope)).toEqual([
      { type: 'tenant' },
      { type: 'brand', brandId: 'brand-1' },
      { type: 'branch', branchId: 'branch-1' },
    ]);
  });

  it('reports M-4+ review state from unreviewed migration-originated grants', async () => {
    const inherited = assignment({ scopeType: 'tenant' }, ['a']);
    findFirst.mockResolvedValue(
      membershipRow([{ ...inherited, origin: 'migration', reviewedAt: null }]),
    );
    await expect(service.resolve(principal)).resolves.toMatchObject({
      scopeReviewRequired: true,
    });

    findFirst.mockResolvedValue(
      membershipRow([
        { ...inherited, origin: 'migration', reviewedAt: new Date() },
      ]),
    );
    await expect(service.resolve(principal)).resolves.toMatchObject({
      scopeReviewRequired: false,
    });
  });

  it('drops an inconsistent scope row rather than treating it as a wildcard', async () => {
    findFirst.mockResolvedValue(
      membershipRow([
        // `brand` scope with no brand id — impossible via the DB CHECK, and
        // still fail-closed here if it ever occurred.
        { ...assignment({ scopeType: 'tenant' }, ['x']), scopeType: 'brand' },
      ]),
    );
    const resolved = await service.resolve(principal);
    expect(resolved.grants).toHaveLength(0);
    expect([...resolved.permissions]).toEqual([]);
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

  describe('T-4-LIVE staleness fence', () => {
    it('rejects (403) a token whose epoch is behind the live membership', async () => {
      findFirst.mockResolvedValue(membershipRow([], 8));
      await expect(service.resolve(principal)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects (403) a tenant-bound token carrying NO epoch at all', async () => {
      findFirst.mockResolvedValue(membershipRow([], 0));
      const { authzEpoch: _omitted, ...noEpoch } = principal;
      await expect(service.resolve(noEpoch)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('memoizes on the request (single query for multiple guards)', async () => {
    findFirst.mockResolvedValue(
      membershipRow([assignment({ scopeType: 'tenant' }, ['a'])]),
    );
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
