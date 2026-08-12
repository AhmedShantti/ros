import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

function buildUserRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: '019ff5fe-ae26-c3ad-e755-8065055a6c10',
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

describe('UsersService.createUser', () => {
  let service: UsersService;
  let repo: { findByEmail: jest.Mock };
  let credentials: { createPasswordCredential: jest.Mock };
  let txUserCreate: jest.Mock;
  let prisma: { $transaction: jest.Mock };

  const dto: CreateUserDto = {
    email: '  User@Example.COM ',
    password: 's3cure-passphrase',
    displayName: 'User',
  };

  beforeEach(() => {
    repo = { findByEmail: jest.fn().mockResolvedValue(null) };
    credentials = {
      createPasswordCredential: jest.fn().mockResolvedValue(undefined),
    };
    txUserCreate = jest.fn().mockResolvedValue(buildUserRow());
    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
        cb({ user: { create: txUserCreate } }),
      ),
    };
    service = new UsersService(
      prisma as unknown as PrismaService,
      repo as unknown as UsersRepository,
      credentials as unknown as CredentialsService,
    );
  });

  it('normalizes email, creates user + credential atomically, returns a safe view', async () => {
    const result = await service.createUser(dto);

    // Email normalized before the existence check and the insert.
    expect(repo.findByEmail).toHaveBeenCalledWith('user@example.com');
    const calls = txUserCreate.mock.calls as Array<
      [{ data: { email: string } }]
    >;
    expect(calls[0][0].data.email).toBe('user@example.com');
    // Credential created inside the same transaction with the raw password.
    expect(credentials.createPasswordCredential).toHaveBeenCalledWith(
      expect.anything(),
      result.id,
      's3cure-passphrase',
    );
    // Safe view never leaks credential material.
    expect(result).not.toHaveProperty('secretHash');
    expect(result).not.toHaveProperty('credentials');
    expect(result.email).toBe('user@example.com');
  });

  it('rejects a duplicate email with 409 before hashing', async () => {
    repo.findByEmail.mockResolvedValue(buildUserRow());
    await expect(service.createUser(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
