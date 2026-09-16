import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

describe('AuthService refresh/logout', () => {
  let service: AuthService;
  let repo: { findById: jest.Mock };
  let sessions: { rotate: jest.Mock; revoke: jest.Mock };
  let tokens: { sign: jest.Mock };
  let memberships: { resolveActiveContext: jest.Mock };
  let tenantContextMock: { resolveEmployeeBranch: jest.Mock };
  let prisma: { withAuthContext: jest.Mock };

  beforeEach(() => {
    repo = { findById: jest.fn() };
    sessions = {
      rotate: jest.fn().mockResolvedValue({
        session: { id: 'sid-2', userId: 'user-1' },
        refreshToken: 'rt-2',
        priorActivityAt: new Date(),
      }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    tokens = { sign: jest.fn().mockResolvedValue('access-2') };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'POS_IDLE_TIMEOUT_MINUTES') return 15;
        if (key === 'KDS_IDLE_TIMEOUT_HOURS') return 8;
        return '15m';
      }),
    } as unknown as ConfigService;

    memberships = {
      resolveActiveContext: jest.fn().mockResolvedValue(null),
    };
    // Sync/offline device channel only (trm-claim preservation on refresh).
    // `context` is null in every spec below (`resolveActiveContext`
    // resolves `null`), so this is never actually invoked; it exists only
    // to satisfy the constructor's dependency.
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
    tenantContextMock = { resolveEmployeeBranch: jest.fn() };
    prisma = {
      withAuthContext: jest.fn((_scope: unknown, fn: (tx: unknown) => unknown) =>
        fn({}),
      ),
    };

    service = new AuthService(
      prisma as unknown as PrismaService,
      repo as unknown as UsersRepository,
      {} as unknown as CredentialsService,
      sessions as unknown as SessionsService,
      tokens as unknown as AccessTokenService,
      memberships as unknown as MembershipsService,
      terminals,
      audit,
      pins,
      snapshots,
      tenantContextMock as unknown as TenantContextService,
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

  describe('POS-KDS-SESSION-CONTINUITY-P0 — pos/kds refresh', () => {
    const posSession = {
      id: 'sid-pos',
      userId: 'user-1',
      sessionType: 'pos' as const,
      employeeId: 'emp-1',
      branchId: 'branch-1',
      membershipId: 'mem-1',
    };

    it('mints a fresh typ/emp/brc/tid/mid token when active and within the idle window', async () => {
      repo.findById.mockResolvedValue(activeUser());
      sessions.rotate.mockResolvedValue({
        session: posSession,
        refreshToken: 'rt-pos-2',
        priorActivityAt: new Date(Date.now() - 60_000), // 1 minute ago, well under 15m
      });
      memberships.resolveActiveContext.mockResolvedValue({
        tenantId: 'tenant-1',
        membershipId: 'mem-1',
      });
      tenantContextMock.resolveEmployeeBranch.mockResolvedValue('branch-1');

      const result = await service.refresh('rt-1', {});

      expect(tenantContextMock.resolveEmployeeBranch).toHaveBeenCalledWith(
        {},
        'emp-1',
        'branch-1',
      );
      expect(tokens.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          sid: 'sid-pos',
          tid: 'tenant-1',
          mid: 'mem-1',
          brc: 'branch-1',
          emp: 'emp-1',
          typ: 'pos',
        }),
      );
      expect(result.accessToken).toBe('access-2');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('fails closed when idle timeout has elapsed', async () => {
      repo.findById.mockResolvedValue(activeUser());
      sessions.rotate.mockResolvedValue({
        session: posSession,
        refreshToken: 'rt-pos-2',
        priorActivityAt: new Date(Date.now() - 16 * 60_000), // 16 minutes ago, over the 15m default
      });

      await expect(service.refresh('rt-1', {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(sessions.revoke).toHaveBeenCalledWith('sid-pos');
      expect(memberships.resolveActiveContext).not.toHaveBeenCalled();
      expect(tokens.sign).not.toHaveBeenCalled();
    });

    it('fails closed when the employee/branch is no longer valid', async () => {
      repo.findById.mockResolvedValue(activeUser());
      sessions.rotate.mockResolvedValue({
        session: posSession,
        refreshToken: 'rt-pos-2',
        priorActivityAt: new Date(Date.now() - 60_000),
      });
      memberships.resolveActiveContext.mockResolvedValue({
        tenantId: 'tenant-1',
        membershipId: 'mem-1',
      });
      tenantContextMock.resolveEmployeeBranch.mockRejectedValue(
        new Error('POS/KDS session is not permitted here.'),
      );

      await expect(service.refresh('rt-1', {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(sessions.revoke).toHaveBeenCalledWith('sid-pos');
      expect(tokens.sign).not.toHaveBeenCalled();
    });

    it('fails closed when the membership/tenant is no longer active', async () => {
      repo.findById.mockResolvedValue(activeUser());
      sessions.rotate.mockResolvedValue({
        session: posSession,
        refreshToken: 'rt-pos-2',
        priorActivityAt: new Date(Date.now() - 60_000),
      });
      memberships.resolveActiveContext.mockResolvedValue(null);

      await expect(service.refresh('rt-1', {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(sessions.revoke).toHaveBeenCalledWith('sid-pos');
      expect(tenantContextMock.resolveEmployeeBranch).not.toHaveBeenCalled();
    });

    it('never falls through to the console token shape for a pos/kds row', async () => {
      // Even though `posSession.membershipId` is set (now legitimately
      // persisted — see SessionsService.issue()'s own docblock), a
      // pos/kds-typed row must NEVER take the console branch, which would
      // mint tid/mid without typ/emp/brc. Assert the signed payload always
      // carries all five together, never a subset.
      repo.findById.mockResolvedValue(activeUser());
      sessions.rotate.mockResolvedValue({
        session: posSession,
        refreshToken: 'rt-pos-2',
        priorActivityAt: new Date(Date.now() - 60_000),
      });
      memberships.resolveActiveContext.mockResolvedValue({
        tenantId: 'tenant-1',
        membershipId: 'mem-1',
      });
      tenantContextMock.resolveEmployeeBranch.mockResolvedValue('branch-1');

      await service.refresh('rt-1', {});

      const signedPayload = tokens.sign.mock.calls[0][0];
      expect(signedPayload.typ).toBeDefined();
      expect(signedPayload.emp).toBeDefined();
      expect(signedPayload.brc).toBeDefined();
      expect(signedPayload.tid).toBeDefined();
      expect(signedPayload.mid).toBeDefined();
    });
  });
});
