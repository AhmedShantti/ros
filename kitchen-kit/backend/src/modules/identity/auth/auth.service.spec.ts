import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContextService } from '../context/tenant-context.service';
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

describe('AuthService.login', () => {
  let service: AuthService;
  let repo: { findByEmail: jest.Mock; findById: jest.Mock };
  let credentials: { verifyPasswordSafe: jest.Mock };
  let sessions: { issue: jest.Mock };
  let tokens: { sign: jest.Mock };
  let prisma: {
    credential: { findUnique: jest.Mock };
    user: { update: jest.Mock };
  };

  beforeEach(() => {
    repo = { findByEmail: jest.fn(), findById: jest.fn() };
    credentials = { verifyPasswordSafe: jest.fn() };
    sessions = {
      issue: jest
        .fn()
        .mockResolvedValue({ session: { id: 'sid-1' }, refreshToken: 'rt-1' }),
    };
    tokens = { sign: jest.fn().mockResolvedValue('access-jwt') };
    prisma = {
      credential: { findUnique: jest.fn() },
      user: { update: jest.fn().mockResolvedValue(undefined) },
    };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'POS_IDLE_TIMEOUT_MINUTES') return 15;
        if (key === 'KDS_IDLE_TIMEOUT_HOURS') return 8;
        return '15m';
      }),
    } as unknown as ConfigService;

    const memberships = {
      resolveActiveContext: jest.fn().mockResolvedValue(null),
    } as unknown as MembershipsService;
    // Sync/offline device channel only (trm-claim preservation on refresh).
    // These specs never resolve a tenant context, so this is never invoked;
    // it exists only to satisfy the constructor's dependency.
    const terminals = {
      findInTenant: jest.fn().mockResolvedValue(null),
    } as unknown as TerminalsService;
    const audit = { emit: jest.fn() } as unknown as AuditService;
    // PIN authentication has its own suites; these password/refresh specs only
    // need the dependency to exist.
    const pins = { authenticate: jest.fn() } as unknown as PinService;
    // B1-2: the T-4-LIVE snapshot builder. These specs assert token SHAPE and
    // session mechanics, not scope resolution, so an empty snapshot suffices —
    // and an empty snapshot is a real state (zero authority), never a wildcard.
    const snapshots = {
      build: jest.fn().mockResolvedValue({
        scp: [],
        pbr: { v: 1, all: false, brands: [], branches: [] },
        epo: 0,
      }),
    } as unknown as AuthorizationSnapshotService;
    // POS-KDS-SESSION-CONTINUITY-P0: these password/login/refresh specs never
    // exercise a pos/kds-typed session, so resolveEmployeeBranch is never
    // invoked; it exists only to satisfy the constructor's dependency.
    const tenantContext = {
      resolveEmployeeBranch: jest.fn(),
    } as unknown as TenantContextService;

    service = new AuthService(
      prisma as unknown as PrismaService,
      repo as unknown as UsersRepository,
      credentials as unknown as CredentialsService,
      sessions as unknown as SessionsService,
      tokens as unknown as AccessTokenService,
      memberships,
      terminals,
      audit,
      pins,
      snapshots,
      tenantContext,
      config,
    );
  });

  const creds = { email: 'User@Example.com', password: 'right-password' };

  it('issues tokens for valid credentials', async () => {
    repo.findByEmail.mockResolvedValue(activeUser());
    prisma.credential.findUnique.mockResolvedValue({ secretHash: 'hash' });
    credentials.verifyPasswordSafe.mockResolvedValue(true);

    const result = await service.login(creds, {});

    expect(result).toMatchObject({
      tokenType: 'Bearer',
      accessToken: 'access-jwt',
      refreshToken: 'rt-1',
      expiresIn: 900,
    });
    expect(result.user).not.toHaveProperty('secretHash');
    expect(tokens.sign).toHaveBeenCalledWith({ sub: 'user-1', sid: 'sid-1' });
  });

  it('rejects an unknown account with a generic 401 (still runs a verify)', async () => {
    repo.findByEmail.mockResolvedValue(null);
    credentials.verifyPasswordSafe.mockResolvedValue(false);

    await expect(service.login(creds, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Timing guard: a verification runs even when the account is unknown.
    expect(credentials.verifyPasswordSafe).toHaveBeenCalledWith(
      null,
      'right-password',
    );
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('rejects a wrong password with 401', async () => {
    repo.findByEmail.mockResolvedValue(activeUser());
    prisma.credential.findUnique.mockResolvedValue({ secretHash: 'hash' });
    credentials.verifyPasswordSafe.mockResolvedValue(false);

    await expect(service.login(creds, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an inactive account even with the correct password', async () => {
    repo.findByEmail.mockResolvedValue(activeUser({ status: 'disabled' }));
    prisma.credential.findUnique.mockResolvedValue({ secretHash: 'hash' });
    credentials.verifyPasswordSafe.mockResolvedValue(true);

    await expect(service.login(creds, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.issue).not.toHaveBeenCalled();
  });
});
