import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessTokenService } from '../auth/access-token.service';
import { TenantSelectionService } from './tenant-selection.service';

function membership(
  overrides: { status?: string; tenantStatus?: string } = {},
) {
  return {
    id: 'm-1',
    userId: 'u-1',
    tenantId: 't-1',
    status: overrides.status ?? 'active',
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

describe('TenantSelectionService.select', () => {
  let findUnique: jest.Mock;
  let sessionUpdate: jest.Mock;
  let tokens: { sign: jest.Mock };
  let service: TenantSelectionService;

  beforeEach(() => {
    findUnique = jest.fn();
    sessionUpdate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      withAuthContext: jest.fn(
        (_scope: unknown, fn: (tx: unknown) => unknown) =>
          fn({
            membership: { findUnique },
            session: { update: sessionUpdate },
          }),
      ),
    } as unknown as PrismaService;
    tokens = { sign: jest.fn().mockResolvedValue('scoped-token') };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('15m'),
    } as unknown as ConfigService;

    service = new TenantSelectionService(
      prisma,
      tokens as unknown as AccessTokenService,
      config,
    );
  });

  it('binds the session and mints a tenant-scoped token for an active membership', async () => {
    findUnique.mockResolvedValue(membership());

    const result = await service.select('u-1', 'sid-1', 't-1');

    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: 'sid-1' },
      data: { membershipId: 'm-1' },
    });
    expect(tokens.sign).toHaveBeenCalledWith({
      sub: 'u-1',
      sid: 'sid-1',
      tid: 't-1',
      mid: 'm-1',
    });
    expect(result).toMatchObject({
      accessToken: 'scoped-token',
      tokenType: 'Bearer',
      tenant: { id: 't-1' },
      membership: { membershipId: 'm-1', status: 'active' },
    });
  });

  it('rejects when there is no membership (unknown/unrelated tenant) with a generic 403', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.select('u-1', 'sid-1', 't-x')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tokens.sign).not.toHaveBeenCalled();
  });

  it('rejects an inactive membership with 403', async () => {
    findUnique.mockResolvedValue(membership({ status: 'inactive' }));
    await expect(service.select('u-1', 'sid-1', 't-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects selection of an inactive tenant with 403', async () => {
    findUnique.mockResolvedValue(membership({ tenantStatus: 'suspended' }));
    await expect(service.select('u-1', 'sid-1', 't-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
