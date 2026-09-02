import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessTokenService } from '../auth/access-token.service';
import { TenantContext } from '../context/tenant-context';
import { AuthorizationSnapshotService } from '../authz/authorization-snapshot.service';
import { TerminalSessionService } from './terminal-session.service';
import { TerminalsService } from './terminals.service';

const context: TenantContext = {
  userId: 'u-1',
  sessionId: 's-1',
  tenantId: 't-1',
  membershipId: 'm-1',
};

function terminal(status = 'active') {
  return {
    id: 'term-1',
    tenantId: 't-1',
    branchId: 'b-1',
    name: 'POS-1',
    terminalType: 'pos',
    status,
    lastSeenAt: null,
    createdAt: new Date(),
  };
}

describe('TerminalSessionService.bind', () => {
  let findInTenant: jest.Mock;
  let sessionUpdate: jest.Mock;
  let sign: jest.Mock;
  let service: TerminalSessionService;

  beforeEach(() => {
    findInTenant = jest.fn();
    sessionUpdate = jest.fn().mockResolvedValue(undefined);
    sign = jest.fn().mockResolvedValue('terminal-scoped-token');
    const prisma = {
      session: { update: sessionUpdate },
    } as unknown as PrismaService;
    const terminals = { findInTenant } as unknown as TerminalsService;
    const tokens = { sign } as unknown as AccessTokenService;
    const config = {
      getOrThrow: jest.fn().mockReturnValue('15m'),
    } as unknown as ConfigService;
    // B1-2: the T-4-LIVE snapshot builder. These specs assert token SHAPE and
    // session mechanics, not scope resolution, so an empty snapshot suffices —
    // and an empty snapshot is a real state (zero authority), never a wildcard.
    const snapshots = {
      build: jest
        .fn()
        .mockResolvedValue({ scp: [], pbr: { v: 1, all: false, brands: [], branches: [] }, epo: 0 }),
    } as unknown as AuthorizationSnapshotService;
    service = new TerminalSessionService(
      prisma,
      terminals,
      tokens,
      snapshots,
      config,
    );
  });

  it('binds the session and mints a terminal-scoped token for an active terminal', async () => {
    findInTenant.mockResolvedValue(terminal('active'));
    const result = await service.bind(context, 'term-1');

    expect(findInTenant).toHaveBeenCalledWith('t-1', 'term-1');
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: { terminalId: 'term-1' },
    });
    expect(sign).toHaveBeenCalledWith({
      sub: 'u-1',
      sid: 's-1',
      tid: 't-1',
      mid: 'm-1',
      trm: 'term-1',
      // B1-2 T-4-LIVE: a tenant-bound token also carries the SRS-required
      // snapshot (scope set + permitted branch set) and its epoch.
      scp: [],
      pbr: { v: 1, all: false, brands: [], branches: [] },
      epo: 0,
    });
    expect(result).toMatchObject({
      accessToken: 'terminal-scoped-token',
      tokenType: 'Bearer',
      terminal: { id: 'term-1' },
    });
  });

  it('404s for a terminal not in the tenant (cross-tenant invisible)', async () => {
    findInTenant.mockResolvedValue(null);
    await expect(service.bind(context, 'term-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('403s when the terminal is disabled', async () => {
    findInTenant.mockResolvedValue(terminal('disabled'));
    await expect(service.bind(context, 'term-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('403s when the terminal is revoked', async () => {
    findInTenant.mockResolvedValue(terminal('revoked'));
    await expect(service.bind(context, 'term-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
