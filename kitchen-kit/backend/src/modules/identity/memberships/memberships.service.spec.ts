import { MembershipView } from './membership.view';
import { MembershipsRepository } from './memberships.repository';
import { MembershipsService } from './memberships.service';

function membership(
  overrides: {
    status?: string;
    tenantStatus?: string;
  } = {},
) {
  return {
    id: 'm-1',
    userId: 'u-1',
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

describe('MembershipsService.resolveActiveContext', () => {
  let repo: { findByIdWithTenant: jest.Mock };
  let service: MembershipsService;

  beforeEach(() => {
    repo = { findByIdWithTenant: jest.fn() };
    service = new MembershipsService(repo as unknown as MembershipsRepository);
  });

  it('returns context for an active membership on an active tenant', async () => {
    repo.findByIdWithTenant.mockResolvedValue(membership());
    await expect(service.resolveActiveContext('m-1')).resolves.toEqual({
      tenantId: 't-1',
      membershipId: 'm-1',
    });
  });

  it('returns null for an inactive membership', async () => {
    repo.findByIdWithTenant.mockResolvedValue(
      membership({ status: 'inactive' }),
    );
    await expect(service.resolveActiveContext('m-1')).resolves.toBeNull();
  });

  it('returns null when the tenant is not active', async () => {
    repo.findByIdWithTenant.mockResolvedValue(
      membership({ tenantStatus: 'suspended' }),
    );
    await expect(service.resolveActiveContext('m-1')).resolves.toBeNull();
  });

  it('returns null when the membership does not exist', async () => {
    repo.findByIdWithTenant.mockResolvedValue(null);
    await expect(service.resolveActiveContext('missing')).resolves.toBeNull();
  });

  it('lists only selectable memberships as views', async () => {
    const repoList = {
      listSelectableByUser: jest.fn().mockResolvedValue([membership()]),
    };
    const svc = new MembershipsService(
      repoList as unknown as MembershipsRepository,
    );
    const views: MembershipView[] = await svc.listForUser('u-1');
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
