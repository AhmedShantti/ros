import { PrismaService } from '../../../prisma/prisma.service';
import { MembershipView } from './membership.view';
import { MembershipsRepository } from './memberships.repository';
import { MembershipsService } from './memberships.service';

function membership(
  overrides: { status?: string; tenantStatus?: string; userId?: string } = {},
) {
  return {
    id: 'm-1',
    userId: overrides.userId ?? 'u-1',
    tenantId: 't-1',
    status: overrides.status ?? 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    tenant: {
      id: 't-1',
      slug: 'acme',
      legalName: 'Acme',
      status: overrides.tenantStatus ?? 'active',
      defaultCurrency: 'EGP',
      defaultLocale: 'ar',
    },
  };
}

describe('MembershipsService', () => {
  let repo: {
    findByIdWithTenant: jest.Mock;
    listSelectableByUser: jest.Mock;
  };
  let service: MembershipsService;

  beforeEach(() => {
    repo = {
      findByIdWithTenant: jest.fn(),
      listSelectableByUser: jest.fn(),
    };
    // withAuthContext simply runs the callback with a stub tx.
    const prisma = {
      withAuthContext: jest.fn(
        (_scope: unknown, fn: (tx: unknown) => unknown) => fn({}),
      ),
    } as unknown as PrismaService;
    service = new MembershipsService(
      prisma,
      repo as unknown as MembershipsRepository,
    );
  });

  it('resolves context for an active membership on an active tenant', async () => {
    repo.findByIdWithTenant.mockResolvedValue(membership());
    await expect(service.resolveActiveContext('u-1', 'm-1')).resolves.toEqual({
      tenantId: 't-1',
      membershipId: 'm-1',
    });
  });

  it('returns null for an inactive membership', async () => {
    repo.findByIdWithTenant.mockResolvedValue(
      membership({ status: 'inactive' }),
    );
    await expect(
      service.resolveActiveContext('u-1', 'm-1'),
    ).resolves.toBeNull();
  });

  it('returns null when the tenant is not active', async () => {
    repo.findByIdWithTenant.mockResolvedValue(
      membership({ tenantStatus: 'suspended' }),
    );
    await expect(
      service.resolveActiveContext('u-1', 'm-1'),
    ).resolves.toBeNull();
  });

  it('returns null when the membership belongs to another user', async () => {
    repo.findByIdWithTenant.mockResolvedValue(
      membership({ userId: 'someone' }),
    );
    await expect(
      service.resolveActiveContext('u-1', 'm-1'),
    ).resolves.toBeNull();
  });

  it('returns null when the membership does not exist', async () => {
    repo.findByIdWithTenant.mockResolvedValue(null);
    await expect(
      service.resolveActiveContext('u-1', 'missing'),
    ).resolves.toBeNull();
  });

  it('lists only selectable memberships as views', async () => {
    repo.listSelectableByUser.mockResolvedValue([membership()]);
    const views: MembershipView[] = await service.listForUser('u-1');
    expect(views).toEqual([
      {
        membershipId: 'm-1',
        status: 'active',
        tenant: {
          id: 't-1',
          slug: 'acme',
          legalName: 'Acme',
          status: 'active',
          defaultCurrency: 'EGP',
          defaultLocale: 'ar',
        },
      },
    ]);
  });
});
