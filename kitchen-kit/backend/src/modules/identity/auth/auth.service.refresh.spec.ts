import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { MembershipsService } from '../memberships/memberships.service';
import { SessionsService } from '../sessions/sessions.service';
import { TerminalsService } from '../terminals/terminals.service';
import { UsersRepository } from '../users/users.repository';
import { AccessTokenService } from './access-token.service';
import { AuditService } from '../../governance/audit/audit.service';
import { PinService } from '../employees/pin.service';
import { AuthorizationSnapshotService } from '../authz/authorization-snapshot.service';
import { AuthService } from './auth.service';

function activeUser(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'user-1',
    email: 'user@example.com',
    displayName: 'User',
    phone: null,
    preferredLocale: 'ar',
    status: 'active',
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('AuthService refresh/logout', () => {
  let service: AuthService;
  let repo: { findById: jest.Mock };
  let sessions: { rotate: jest.Mock; revoke: jest.Mock };
  let tokens: { sign: jest.Mock };

  beforeEach(() => {
    repo = { findById: jest.fn() };
    sessions = {
      rotate: jest.fn().mockResolvedValue({
        session: { id: 'sid-2', userId: 'user-1' },
        refreshToken: 'rt-2',
      }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    tokens = { sign: jest.fn().mockResolvedValue('access-2') };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('15m'),
    } as unknown as ConfigService;

    const memberships = {
      resolveActiveContext: jest.fn().mockResolvedValue(null),
    } as unknown as MembershipsService;
    const terminals = {
      findInTenant: jest.fn().mockResolvedValue(null),
    } as unknown as TerminalsService;
    const audit = { emit: jest.fn() } as unknown as AuditService;
    // PIN authentication has its own suites; these password/refresh specs only
    // need the dependency to exist.
    const pins = { authenticate: jest.fn() } as unknown as PinService;
    // B1-2: the T-4-LIVE snapshot builder. A refreshed tenant-bound token
    // re-mints the snapshot; this spec asserts refresh mechanics, so an empty
    // snapshot (zero authority — a real state, never a wildcard) suffices.
    const snapshots = {
      build: jest.fn().mockResolvedValue({
        scp: [],
        pbr: { v: 1, all: false, brands: [], branches: [] },
        epo: 0,
      }),
    } as unknown as AuthorizationSnapshotService;

    service = new AuthService(
      {} as unknown as PrismaService,
      repo as unknown as UsersRepository,
      {} as unknown as CredentialsService,
      sessions as unknown as SessionsService,
      tokens as unknown as AccessTokenService,
      memberships,
      terminals,
      audit,
      pins,
      snapshots,
      config,
    );
  });

  it('rotates and returns a fresh token pair for an active user', async () => {
    repo.findById.mockResolvedValue(activeUser());

    const result = await service.refresh('rt-1', {});

    expect(sessions.rotate).toHaveBeenCalledWith('rt-1', {});
    expect(result).toMatchObject({
      tokenType: 'Bearer',
      accessToken: 'access-2',
      refreshToken: 'rt-2',
    });
    expect(tokens.sign).toHaveBeenCalledWith({ sub: 'user-1', sid: 'sid-2' });
  });

  it('revokes the new session and 401s when the account is no longer active', async () => {
    repo.findById.mockResolvedValue(activeUser({ status: 'disabled' }));

    await expect(service.refresh('rt-1', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.revoke).toHaveBeenCalledWith('sid-2');
  });

  it('logout revokes the current session', async () => {
    await service.logout('user-9', 'sid-9');
    expect(sessions.revoke).toHaveBeenCalledWith('sid-9');
  });
});
