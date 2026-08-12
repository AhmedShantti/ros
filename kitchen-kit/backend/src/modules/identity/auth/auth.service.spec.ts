import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { SessionsService } from '../sessions/sessions.service';
import { UsersRepository } from '../users/users.repository';
import { AccessTokenService } from './access-token.service';
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
      getOrThrow: jest.fn().mockReturnValue('15m'),
    } as unknown as ConfigService;

    service = new AuthService(
      prisma as unknown as PrismaService,
      repo as unknown as UsersRepository,
      credentials as unknown as CredentialsService,
      sessions as unknown as SessionsService,
      tokens as unknown as AccessTokenService,
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
